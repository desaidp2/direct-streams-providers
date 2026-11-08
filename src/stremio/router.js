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

const MANIFEST = {
  id: "community.directstreamsproviders",
  version: "1.0.7",
  name: "Direct Streams Providers",
  description: "Fast direct streams from 7Movies & Movy up to 4K with multilingual subtitles (No Debrid Needed)",
  resources: ["stream", "subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb:"],
  catalogs: [],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const SUBTITLE_CACHE = new Map();
const MAX_SUB_CACHE = 100;

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

/**
 * Transforms internal provider streams to Stremio Stream objects
 */
function toStremioStream(s, providerTag, baseUrl) {
  const subtitles = Array.isArray(s.subtitles)
    ? s.subtitles.map((sub, idx) => {
        const langCode = toIso6392(sub.language || sub.lang || sub.name);
        return {
          id: `${langCode}_${idx}`,
          url: formatSubtitleUrl(sub.url, baseUrl),
          lang: langCode,
          name: sub.name || sub.display || langCode,
        };
      })
    : [];

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
async function handleStreams(type, rawId, baseUrl) {
  try {
    const normType = type === "series" || type === "tv" ? "tv" : "movie";
    const { season, episode } = parseIdParams(rawId);
    const tmdbId = await resolveTmdbId(rawId, normType);

    if (!tmdbId) {
      return { streams: [] };
    }

    // Query both providers in parallel
    const [sevenMoviesResult, movyResult] = await Promise.allSettled([
      get7MoviesStreams(tmdbId, normType, season, episode),
      getMovyStreams(tmdbId, normType, season, episode),
    ]);

    const streams = [];

    // 1. Movy streams (often higher resolution up to 4K)
    if (movyResult.status === "fulfilled" && Array.isArray(movyResult.value)) {
      for (const s of movyResult.value) {
        streams.push(toStremioStream(s, "Movy", baseUrl));
      }
    }

    // 2. 7Movies streams (direct MP4s)
    if (sevenMoviesResult.status === "fulfilled" && Array.isArray(sevenMoviesResult.value)) {
      for (const s of sevenMoviesResult.value) {
        streams.push(toStremioStream(s, "7Movies", baseUrl));
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

    const subtitles = (Array.isArray(rawSubs) ? rawSubs : []).map((sub, idx) => {
      const langCode = toIso6392(sub.language || sub.lang || sub.name);
      return {
        id: `${langCode}_${idx}`,
        url: formatSubtitleUrl(sub.url, baseUrl),
        lang: langCode,
        name: sub.name || sub.display || langCode,
      };
    });

    return { subtitles };
  } catch (err) {
    console.error("[StremioRouter] Error resolving subtitles:", err);
    return { subtitles: [] };
  }
}

/**
 * Proxies subtitle files with proper application/x-subrip content-type
 */
async function handleSubtitleProxy(targetUrl) {
  if (!targetUrl) {
    return {
      status: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Missing url parameter" }),
    };
  }

  // Check cache
  if (SUBTITLE_CACHE.has(targetUrl)) {
    return {
      status: 200,
      headers: {
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Content-Disposition": 'inline; filename="subtitle.srt"',
        "Access-Control-Allow-Origin": "*",
      },
      body: SUBTITLE_CACHE.get(targetUrl),
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "okhttp/4.12.0",
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return {
        status: res.status,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Subtitle fetch failed (${res.status})` }),
      };
    }

    const text = await res.text();

    if (SUBTITLE_CACHE.size >= MAX_SUB_CACHE) {
      const firstKey = SUBTITLE_CACHE.keys().next().value;
      SUBTITLE_CACHE.delete(firstKey);
    }
    SUBTITLE_CACHE.set(targetUrl, text);

    return {
      status: 200,
      headers: {
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Content-Disposition": 'inline; filename="subtitle.srt"',
        "Access-Control-Allow-Origin": "*",
      },
      body: text,
    };
  } catch (e) {
    return {
      status: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Subtitle proxy upstream error" }),
    };
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
  // Strip trailing slashes and decode
  const cleanPath = decodeURIComponent(path.replace(/\/+$/, "") || "/");

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
