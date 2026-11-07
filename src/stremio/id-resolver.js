/**
 * ID Resolver for Stremio / WuPlay.
 *
 * Resolves IMDB IDs (tt...) to TMDB IDs using fast caching and dual fallback:
 *   1. Bounded in-memory LRU cache O(1)
 *   2. Cinemeta (v3-cinemeta.strem.io)
 *   3. TMDB Proxy (db.wecollege.net/3/find)
 */

const CINEMETA_URL = "https://v3-cinemeta.strem.io/meta";
const WECOLLEGE_FIND = "https://db.wecollege.net/3/find";

const imdbToTmdbCache = new Map();
const MAX_CACHE_SIZE = 500;

function setCache(imdbId, tmdbId) {
  if (imdbToTmdbCache.size >= MAX_CACHE_SIZE) {
    const oldest = imdbToTmdbCache.keys().next().value;
    imdbToTmdbCache.delete(oldest);
  }
  imdbToTmdbCache.set(imdbId, tmdbId);
}

/**
 * Resolves an ID string (e.g., "tt0468569", "tmdb:155", "155") to a numeric TMDB ID.
 * @param {string} rawId - The raw ID from Stremio request
 * @param {string} mediaType - "movie" or "series"
 * @returns {Promise<string|null>} - The resolved TMDB ID string, or null
 */
async function resolveTmdbId(rawId, mediaType) {
  if (!rawId) return null;
  const idStr = String(rawId).trim();

  // 1. Direct TMDB ID
  if (idStr.startsWith("tmdb:")) {
    const clean = idStr.replace(/^tmdb:/, "").split(":")[0];
    return clean || null;
  }
  if (/^\d+$/.test(idStr)) {
    return idStr;
  }

  // 2. IMDB ID (e.g. tt0468569 or tt0903747:1:1)
  const imdbId = idStr.split(":")[0];
  if (!/^tt\d+$/.test(imdbId)) {
    return null;
  }

  // Check cache O(1)
  const cached = imdbToTmdbCache.get(imdbId);
  if (cached) return cached;

  const stremioType = mediaType === "series" || mediaType === "tv" ? "series" : "movie";

  // Attempt 1: Cinemeta
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${CINEMETA_URL}/${stremioType}/${imdbId}.json`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const tmdbId = data && data.meta && (data.meta.moviedb_id || data.meta.tmdb_id);
      if (tmdbId) {
        const result = String(tmdbId);
        setCache(imdbId, result);
        return result;
      }
    }
  } catch (e) {
    // Cinemeta failed, try fallback
  }

  // Attempt 2: wecollege TMDB find proxy
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${WECOLLEGE_FIND}/${imdbId}?external_source=imdb_id`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const results =
        stremioType === "series"
          ? (data.tv_results && data.tv_results[0]) || (data.movie_results && data.movie_results[0])
          : (data.movie_results && data.movie_results[0]) || (data.tv_results && data.tv_results[0]);
      if (results && results.id) {
        const result = String(results.id);
        setCache(imdbId, result);
        return result;
      }
    }
  } catch (e) {
    // Fallback failed
  }

  return null;
}

module.exports = { resolveTmdbId };
