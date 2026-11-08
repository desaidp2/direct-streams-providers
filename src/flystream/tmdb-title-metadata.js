/**
 * Title / year / IMDb lookup for a TMDB id, used to fill the FlyStream API query.
 *
 * Nuvio and the Stremio router hand providers only a TMDB id, but the upstream Dart scraper
 * (sakinator/hostreamio flystream.dart) always sends `title`, and `imdb` / `year` when known.
 * This reads them from the same keyless TMDB proxy the id-resolver already uses
 * (db.wecollege.net/3). Best effort: any failure returns {} and the API call goes out with
 * `tmdbId` alone. Results (including misses) are cached so a replay costs no request.
 */

const { fetchWithTimeout, TtlCache } = require("../shared/provider-utils");

const TMDB_PROXY = "https://db.wecollege.net/3";
const META_TIMEOUT_MS = 2000;
const META_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const metaCache = new TtlCache(200, META_TTL_MS);

// Pure: picks the fields FlyStream wants out of a TMDB movie/tv details payload.
function pickTitleMetadata(data, mediaType) {
  if (!data || typeof data !== "object") return {};
  const isTv = mediaType === "tv";
  const title = (isTv ? data.name || data.original_name : data.title || data.original_title) || undefined;
  const date = (isTv ? data.first_air_date : data.release_date) || "";
  const yearMatch = /^(\d{4})/.exec(String(date));
  const imdb = (data.external_ids && data.external_ids.imdb_id) || data.imdb_id || undefined;
  return {
    title: title ? String(title) : undefined,
    year: yearMatch ? parseInt(yearMatch[1], 10) : undefined,
    imdbId: imdb && /^tt\d+$/.test(imdb) ? imdb : undefined,
  };
}

async function fetchTitleMetadata(tmdbId, mediaType) {
  const key = `${mediaType}:${tmdbId}`;
  const cached = metaCache.get(key);
  if (cached) return cached;

  let meta = {};
  try {
    const url = `${TMDB_PROXY}/${mediaType}/${encodeURIComponent(tmdbId)}?append_to_response=external_ids`;
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } },
      META_TIMEOUT_MS,
      "FlyStream TMDB meta"
    );
    if (res.ok) meta = pickTitleMetadata(await res.json(), mediaType);
  } catch (err) {
    console.warn("[FlyStream] title metadata lookup failed:", err.message || err);
  }
  metaCache.set(key, meta, meta.title ? META_TTL_MS : MISS_TTL_MS);
  return meta;
}

module.exports = { fetchTitleMetadata, pickTitleMetadata };
