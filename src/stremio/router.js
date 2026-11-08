/**
 * Stremio / WuPlay Add-on Router.
 *
 * Implements the official Stremio Addon Protocol specification:
 *   - GET /manifest.json
 *   - GET /stream/:type/:id.json
 *   - GET /subtitles/:type/:id.json
 *   - GET /subtitles/file.srt?url=... (ExoPlayer MIME & extension bridge)
 *
 * Compatible with Stremio and WuPlay (Android TV, Desktop, Web).
 */

const { resolveTmdbId } = require("./id-resolver");
const { toIso6392 } = require("./languages");
const { getStreams: get7MoviesStreams } = require("../7movies/index");
const { getStreams: getMovyStreams, fetchSubtitles: fetchMovySubtitles } = require("../movy/index");
const { getStreams: getFlyStreamStreams } = require("../flystream/index");
const { CORS_HEADERS } = require("./http-constants");
const { handleSubtitleProxy } = require("./subtitle-proxy");

const MANIFEST = {
  id: "community.directstreamsproviders",
  version: "1.0.8",
  name: "Direct Streams Providers",
  description: "Fast direct streams from 7Movies, Movy & FlyStream up to 4K with multilingual subtitles (No Debrid Needed)",
  resources: ["stream", "subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb:"],
  catalogs: [],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

// Output order: Movy first (often up to 4K), then 7Movies MP4s, then FlyStream.
const PROVIDERS = [
  { tag: "Movy", getStreams: getMovyStreams },
  { tag: "7Movies", getStreams: get7MoviesStreams },
  { tag: "FlyStream", getStreams: getFlyStreamStreams },
];

// Each provider gets this long; a late provider is dropped from the response instead of
// holding it open. Response time is bounded by max(deadline), not by the slowest upstream.
const envDeadline =
  typeof process !== "undefined" && process.env ? parseInt(process.env.PROVIDER_DEADLINE_MS || "", 10) : NaN;
const PROVIDER_DEADLINE_MS = envDeadline > 0 ? envDeadline : 9000;

// Identical concurrent stream requests (players often fire the same one 2-3 times while the
// sheet opens) share one resolution: k duplicates cost 1 x P provider calls, not k x P.
const inflightStreams = new Map();

function withDeadline(promise, ms, tag) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[StremioRouter] ${tag} missed the ${ms}ms deadline, skipped`);
      resolve([]);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise).catch(() => []), deadline]).then((value) => {
    clearTimeout(timer);
    return value;
  });
}

/**
 * Parses raw Stremio id (e.g. "tt0468569", "tt0903747:1:1", "tmdb:1396:2:3")
 */
function parseIdParams(rawId) {
  const parts = String(rawId || "").split(":");
  let season = null;
  let episode = null;

  if (rawId.startsWith("tmdb:")) {
    // tmdb:1396 or tmdb:1396:1:1
    if (parts.length >= 4) {
      season = parseInt(parts[2], 10);
      episode = parseInt(parts[3], 10);
    }
  } else if (parts.length >= 3) {
    // tt0903747:1:1
    season = parseInt(parts[1], 10);
    episode = parseInt(parts[2], 10);
  }

  return { season, episode };
}

/**
 * Wraps subtitle URL into an ExoPlayer-compatible .srt route if needed
 */
function formatSubtitleUrl(url, baseUrl) {
  if (!url) return "";
  if (!baseUrl) return url;
  if (url.includes(".srt") || url.includes(".vtt")) return url;
  return `${baseUrl}/subtitles/file.srt?url=${encodeURIComponent(url)}`;
}

// Maps provider subtitle tracks to Stremio subtitle objects (ISO 639-2 + .srt bridge)
function mapSubtitles(rawSubs, baseUrl) {
  return rawSubs.map((sub, idx) => {
    const langCode = toIso6392(sub.language || sub.lang || sub.name);
    return {
      id: `${langCode}_${idx}`,
      url: formatSubtitleUrl(sub.url, baseUrl),
      lang: langCode,
      name: sub.name || sub.display || langCode,
    };
  });
}

/**
 * Transforms internal provider streams to Stremio Stream objects.
 * Providers attach one shared subtitle array to all their streams; `subMemo` (one per
 * response) maps each distinct array once, so S streams x T subtitles cost O(S + T)
 * instead of O(S x T) mapping work and allocations.
 */
function toStremioStream(s, providerTag, baseUrl, subMemo) {
  let subtitles = [];
  if (Array.isArray(s.subtitles)) {
    subtitles = subMemo ? subMemo.get(s.subtitles) : undefined;
    if (!subtitles) {
      subtitles = mapSubtitles(s.subtitles, baseUrl);
      if (subMemo) subMemo.set(s.subtitles, subtitles);
    }
  }

  const subCount = subtitles.length ? ` | 💬 ${subtitles.length} subs` : "";
  const directTag = "⚡ Direct CDN (No Debrid)";

  return {
    name: `[DirectStreams]\n${s.name || providerTag}`,
    title: `${s.title || s.quality || "Stream"}\n${directTag}${subCount}`,
    url: s.url,
    behaviorHints: s.behaviorHints || {
      notWebReady: true,
      proxyHeaders: {
        request: s.headers || {},
      },
    },
    subtitles: subtitles,
  };
}

/**
 * Handles stream requests for /stream/:type/:id.json
 */
function handleStreams(type, rawId, baseUrl) {
  const key = `${type}|${rawId}|${baseUrl}`;
  const pending = inflightStreams.get(key);
  if (pending) return pending;
  const work = resolveStreams(type, rawId, baseUrl).finally(() => inflightStreams.delete(key));
  inflightStreams.set(key, work);
  return work;
}

async function resolveStreams(type, rawId, baseUrl) {
  try {
    const normType = type === "series" || type === "tv" ? "tv" : "movie";
    const { season, episode } = parseIdParams(rawId);
    const tmdbId = await resolveTmdbId(rawId, normType);

    if (!tmdbId) {
      return { streams: [] };
    }

    // Query all providers in parallel, each bounded by its deadline
    const results = await Promise.all(
      PROVIDERS.map((p) =>
        withDeadline(p.getStreams(tmdbId, normType, season, episode), PROVIDER_DEADLINE_MS, p.tag)
      )
    );

    const streams = [];
    const subMemo = new Map();
    for (let i = 0; i < PROVIDERS.length; i++) {
      const list = results[i];
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        streams.push(toStremioStream(s, PROVIDERS[i].tag, baseUrl, subMemo));
      }
    }

    return { streams };
  } catch (err) {
    console.error("[StremioRouter] Error resolving streams:", err);
    return { streams: [] };
  }
}

/**
 * Handles subtitle requests for /subtitles/:type/:id.json and /subtitles/:type/:id/:extra.json
 */
async function handleSubtitles(type, rawId, baseUrl) {
  try {
    const normType = type === "series" || type === "tv" ? "tv" : "movie";
    const { season, episode } = parseIdParams(rawId);
    const tmdbId = await resolveTmdbId(rawId, normType);

    if (!tmdbId) {
      return { subtitles: [] };
    }

    let rawSubs = [];
    try {
      rawSubs = await fetchMovySubtitles(tmdbId, normType, season, episode);
    } catch (e) {
      rawSubs = [];
    }

    const subtitles = mapSubtitles(Array.isArray(rawSubs) ? rawSubs : [], baseUrl);

    return { subtitles };
  } catch (err) {
    console.error("[StremioRouter] Error resolving subtitles:", err);
    return { subtitles: [] };
  }
}

/**
 * Central request router
 * @param {string} path - Request URL pathname
 * @param {object} [query={}] - Parsed query parameters
 * @param {string} [baseUrl=""] - Base URL of the current server (for generating absolute URLs)
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
async function route(path, query = {}, baseUrl = "") {
  // Strip trailing slashes and decode (a malformed %-escape is a client error, not a 500)
  let cleanPath;
  try {
    cleanPath = decodeURIComponent(path.replace(/\/+$/, "") || "/");
  } catch (e) {
    return { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Malformed path" }) };
  }

  // Route 1: Root or manifest
  if (cleanPath === "" || cleanPath === "/" || cleanPath === "/manifest.json") {
    return {
      status: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(MANIFEST, null, 2),
    };
  }

  // Route 2: Subtitle proxy endpoint /subtitles/file.srt?url=...
  if (cleanPath === "/subtitles/file.srt" || cleanPath === "/subtitles/file.vtt") {
    return handleSubtitleProxy(query.url);
  }

  // Route 3: Subtitles endpoint /subtitles/:type/:id.json and /subtitles/:type/:id/:extra.json
  const subMatch = cleanPath.match(/^\/subtitles\/([^/]+)\/([^/]+?)(?:\/.*)?\.json$/);
  if (subMatch) {
    const type = subMatch[1];
    const id = subMatch[2];
    const result = await handleSubtitles(type, id, baseUrl);
    return {
      status: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result),
    };
  }

  // Route 4: Stream endpoint /stream/:type/:id.json
  const streamMatch = cleanPath.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
  if (streamMatch) {
    const type = streamMatch[1];
    const id = streamMatch[2];
    const result = await handleStreams(type, id, baseUrl);
    return {
      status: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result),
    };
  }

  // 404 Not Found
  return {
    status: 404,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: "Not found" }),
  };
}

module.exports = {
  MANIFEST,
  CORS_HEADERS,
  route,
  handleStreams,
  handleSubtitles,
};
