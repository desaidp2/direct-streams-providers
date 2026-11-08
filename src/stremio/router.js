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

const fs = require("fs");
const pathModule = require("path");
const { resolveTmdbId } = require("./id-resolver");
const { toIso6392 } = require("./languages");
const { getStreams: get7MoviesStreams } = require("../7movies/index");
const { getStreams: getMovyStreams, fetchSubtitles: fetchMovySubtitles } = require("../movy/index");
const { getStreams: getFlyStreamStreams } = require("../flystream/index");
const { CORS_HEADERS } = require("./http-constants");
const { handleSubtitleProxy } = require("./subtitle-proxy");
const { companionAllowed } = require("./client-address-private-network-check");
const { VARIANT_PATH, resolveVariantUrl, renderVariantPlaylist } = require("../shared/hls-variant-playlist");

// Companion responses carry live session cookies: no CORS headers (Nuvio's native fetch does not
// need them, and `Access-Control-Allow-Origin: *` would let any web page a LAN browser opens read
// them), and never cached by intermediaries.
const COMPANION_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
// Title metadata the client already resolved (the provider sends title / imdb / year in the
// companion query). Validated strictly; anything off is dropped and the server looks it up itself.
function companionMeta(query) {
  const title = typeof query.title === "string" ? query.title.trim() : "";
  if (!title || title.length > 200) return undefined;
  const imdbId = /^tt\d{1,10}$/.test(query.imdb || "") ? query.imdb : undefined;
  const year = /^\d{4}$/.test(query.year || "") ? parseInt(query.year, 10) : undefined;
  return { title, imdbId, year };
}

const COMPANION_PATHS = new Set(["/companion/flystream", "/api/flystream/streams", "/companion/flystream/cookies"]);

// Read-through file cache keyed by path, invalidated by mtime: one stat() per request instead of
// a full read + parse (+ regex rewrite for providers). A rebuild (new mtime) is picked up live.
// Bounded by the number of distinct files under providers/ plus the manifest.
const fileCache = new Map();
function readCached(filepath, transform) {
  try {
    const mtime = fs.statSync(filepath).mtimeMs;
    const hit = fileCache.get(filepath);
    if (hit && hit.mtime === mtime) return hit.value;
    const value = transform(fs.readFileSync(filepath, "utf8"));
    fileCache.set(filepath, { mtime, value });
    return value;
  } catch (err) {
    // Missing file / no fs on edge runtimes is a plain 404; anything else is worth a log line.
    if (err && err.code !== "ENOENT") console.warn(`[StremioRouter] ${filepath}: ${err.message || err}`);
    return null;
  }
}

const ROOT_MANIFEST_PATH = pathModule.join(__dirname, "../../manifest.json");
// The combined manifest body is built once per manifest.json mtime, not per request.
function getManifestBody() {
  const body = readCached(ROOT_MANIFEST_PATH, (text) => {
    const combined = Object.assign({}, MANIFEST);
    const root = JSON.parse(text);
    if (root && Array.isArray(root.scrapers)) combined.scrapers = root.scrapers;
    return JSON.stringify(combined, null, 2);
  });
  return body || JSON.stringify(MANIFEST, null, 2);
}

// Serve-time companion URL injection; tracked provider files never carry LAN addresses.
// Throws if the build output no longer has the marker, so a bundler change cannot silently
// ship a provider without its companion URL.
const COMPANION_MARKER = /var BUILD_COMPANION_URL\s*=[^;]+;/;
function injectCompanionUrl(code, url) {
  if (!COMPANION_MARKER.test(code)) throw new Error("BUILD_COMPANION_URL marker missing in providers/flystream.js");
  return code.replace(COMPANION_MARKER, () => `var BUILD_COMPANION_URL = ${JSON.stringify(url)};`);
}

const MANIFEST = {
  id: "community.directstreamsproviders",
  version: "1.0.13",
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
  // splitVariants: one row per HLS quality + Auto (variant URLs resolved against baseUrl below)
  { tag: "FlyStream", getStreams: (id, type, s, e) => getFlyStreamStreams(id, type, s, e, { splitVariants: true }) },
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
    url: resolveVariantUrl(s.url, baseUrl),
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
async function route(path, query = {}, baseUrl = "", requestInfo = {}) {
  // Strip trailing slashes and decode (a malformed %-escape is a client error, not a 500)
  let cleanPath;
  try {
    cleanPath = decodeURIComponent(path.replace(/\/+$/, "") || "/");
  } catch (e) {
    return { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Malformed path" }) };
  }

  // Route 1: Root or manifest (dual compatibility for Stremio and Nuvio plugin manifest)
  if (cleanPath === "" || cleanPath === "/" || cleanPath === "/manifest.json") {
    return { status: 200, headers: CORS_HEADERS, body: getManifestBody() };
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

  // Companion routes: private-network clients only (see client-address-private-network-check.js).
  if (COMPANION_PATHS.has(cleanPath) && !companionAllowed(requestInfo.clientAddress)) {
    return { status: 403, headers: COMPANION_HEADERS, body: JSON.stringify({ error: "Companion is LAN-only" }) };
  }

  // Route 5: Companion endpoint for FlyStream (used by client-side QuickJS / Nuvio)
  if (cleanPath === "/companion/flystream" || cleanPath === "/api/flystream/streams") {
    const tmdbId = query.tmdbId || query.id;
    const mediaType = query.type || query.mediaType || "movie";
    const season = query.season ? parseInt(query.season, 10) : 1;
    const episode = query.episode ? parseInt(query.episode, 10) : 1;
    const streams = tmdbId
      ? await getFlyStreamStreams(tmdbId, mediaType, season, episode, {
          skipCompanion: true,
          splitVariants: true,
          meta: companionMeta(query),
        })
      : [];
    // Fresh objects with resolved variant URLs; the cached originals keep the placeholder.
    const out = streams.map((s) => {
      const url = resolveVariantUrl(s.url, baseUrl);
      return url === s.url ? s : Object.assign({}, s, { url });
    });
    return {
      status: 200,
      headers: COMPANION_HEADERS,
      body: JSON.stringify({ ok: out.length > 0, streams: out }),
    };
  }

  // Route 5b: single-variant HLS master for FlyStream's ".ts"-named variant playlists. Echoes an
  // allowlisted URL only; no upstream request (see shared/hls-variant-playlist.js).
  if (cleanPath === VARIANT_PATH) {
    const r = renderVariantPlaylist(query);
    return {
      status: r.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
      body: r.body,
    };
  }

  // Route 6: Companion session cookies endpoint
  if (cleanPath === "/companion/flystream/cookies") {
    const cb = typeof challengeBrowser !== "undefined" ? challengeBrowser : null;
    const cookies = cb && typeof cb.getCookies === "function" ? await cb.getCookies() : "";
    const userAgent = cb && typeof cb.getUserAgent === "function" ? await cb.getUserAgent() : "";
    return {
      status: 200,
      headers: COMPANION_HEADERS,
      body: JSON.stringify({ ok: !!cookies, cookies: cookies, userAgent: userAgent }),
    };
  }

  // Route 7: Static provider files for Nuvio plugin installations (/providers/:file.js)
  const providerMatch = cleanPath.match(/^\/providers\/([a-zA-Z0-9_.-]+\.js)$/);
  if (providerMatch) {
    const filename = providerMatch[1];
    const filepath = pathModule.join(__dirname, "../../providers", filename);
    // The env is fixed for the process lifetime, so caching the injected text per mtime is safe.
    const envCompanionUrl = typeof process !== "undefined" && process.env ? process.env.FLYSTREAM_COMPANION_URL : "";
    const code = readCached(filepath, (text) =>
      filename === "flystream.js" && envCompanionUrl ? injectCompanionUrl(text, envCompanionUrl) : text
    );
    if (code !== null) {
      return {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/javascript; charset=utf-8" },
        body: code,
      };
    }
  }

  // 404 Not Found
  return {
    status: 404,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: "Not found" }),
  };
}

module.exports = {
  injectCompanionUrl,
  MANIFEST,
  CORS_HEADERS,
  route,
  handleStreams,
  handleSubtitles,
};
