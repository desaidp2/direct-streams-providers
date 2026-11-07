/**
 * Stremio / WuPlay Add-on Router.
 *
 * Implements the official Stremio Addon Protocol specification:
 *   - GET /manifest.json
 *   - GET /stream/:type/:id.json
 *
 * Compatible with Stremio and WuPlay (Android TV, Desktop, Web).
 */

const { resolveTmdbId } = require("./id-resolver");
const { getStreams: get7MoviesStreams } = require("../7movies/index");
const { getStreams: getMovyStreams } = require("../movy/index");

const MANIFEST = {
  id: "community.directstreamsproviders",
  version: "1.0.6",
  name: "Direct Streams Providers",
  description: "Fast direct streams from 7Movies & Movy up to 4K (No Debrid Needed)",
  resources: ["stream"],
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
 * Transforms internal provider streams to Stremio Stream objects
 */
function toStremioStream(s, providerTag) {
  const subtitles = Array.isArray(s.subtitles)
    ? s.subtitles.map((sub, idx) => ({
        id: (sub.language || "und") + "_" + idx,
        url: sub.url,
        lang: sub.name || sub.language || "English",
      }))
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
async function handleStreams(type, rawId) {
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
        streams.push(toStremioStream(s, "Movy"));
      }
    }

    // 2. 7Movies streams (direct MP4s)
    if (sevenMoviesResult.status === "fulfilled" && Array.isArray(sevenMoviesResult.value)) {
      for (const s of sevenMoviesResult.value) {
        streams.push(toStremioStream(s, "7Movies"));
      }
    }

    return { streams };
  } catch (err) {
    console.error("[StremioRouter] Error resolving streams:", err);
    return { streams: [] };
  }
}

/**
 * Central request router
 * @param {string} path - Request URL pathname
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
async function route(path) {
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

  // Route 2: Stream endpoint /stream/:type/:id.json
  const streamMatch = cleanPath.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
  if (streamMatch) {
    const type = streamMatch[1];
    const id = streamMatch[2];
    const result = await handleStreams(type, id);
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
};
