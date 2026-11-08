/**
 * FlyStream provider for Nuvio, WuPlay, and Stremio.
 *
 * Streams come from flystream.net's JSON API (`/api/streams`), ported from the Dart
 * FlyStreamScraper in sakinator/hostreamio; see flystream-api-streams.js for the request
 * and response contract and tmdb-title-metadata.js for the title/year/IMDb lookup.
 *
 * Also exported: `search` and `fetchPageDOM`, page loaders that use a host
 * `challengeBrowser.execute()` when present (SkyStream / webview) and a plain fetch otherwise.
 * Every stream carries ExoPlayer headers in `behaviorHints.proxyHeaders.request`.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BASE_URL = "https://flystream.net";

const HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: BASE_URL + "/",
  Origin: BASE_URL,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
};

const { sortByQuality, withTimeout, TtlCache } = require("../shared/provider-utils");
const { fetchApiStreams } = require("./flystream-api-streams");
const { fetchTitleMetadata } = require("./tmdb-title-metadata");

// Bounded LRU cache. Misses are cached too (shorter), so a client retrying the same title
// does not send the site another request each time.
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 10 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
// Hard cap on one page load: the old fetch had no timeout, so a stalled site held every
// Stremio/WuPlay stream response open (the router waits for all providers).
const PAGE_TIMEOUT_MS = 5000;
const streamCache = new TtlCache(MAX_CACHE_SIZE, CACHE_TTL_MS);

/**
 * Executes request through host challenge_browser context if present,
 * or falls back to direct HTTP fetch with browser headers.
 */
async function fetchPageDOM(url, timeoutMs) {
  try {
    return await withTimeout(loadPage(url), timeoutMs || PAGE_TIMEOUT_MS, "FlyStream page");
  } catch (err) {
    console.error("[FlyStream] fetchPageDOM failed:", err.message || err);
    return null;
  }
}

// Loads one page: host challengeBrowser first when present, else a plain fetch.
async function loadPage(url) {
  // 1. Host challengeBrowser context (SkyStream / Webview bridge)
  if (
    typeof challengeBrowser !== "undefined" &&
    challengeBrowser &&
    typeof challengeBrowser.execute === "function"
  ) {
    try {
      const response = await challengeBrowser.execute(url, {
        method: "GET",
        headers: { "User-Agent": BROWSER_UA },
        evaluateJs: "document.documentElement.outerHTML",
        waitForSelector: "body",
      });
      if (response && response.result) {
        return response.result;
      }
    } catch (cbErr) {
      console.warn("[FlyStream] challengeBrowser error, falling back to fetch:", cbErr.message || cbErr);
    }
  }

  // 2. Direct HTTP fetch fallback
  const res = await fetch(url, {
    method: "GET",
    headers: HEADERS,
    cache: "no-store",
  });

  if (res.status === 403 || res.status === 401) {
    console.warn(`[FlyStream] Endpoint gated (${res.status}) on ${url}`);
    return null;
  }

  if (!res.ok) {
    return null;
  }

  return await res.text();
}

/**
 * Search movies/shows on FlyStream
 */
async function search(query) {
  try {
    const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
    const htmlContent = await fetchPageDOM(searchUrl);
    if (!htmlContent) return [];

    const results = [];

    // Check __FLYCAST_DATA__ state
    const stateMatch = htmlContent.match(/__FLYCAST_DATA__\s*=\s*(\{.*?\});/);
    if (stateMatch) {
      try {
        const pageData = JSON.parse(stateMatch[1]);
        if (pageData && Array.isArray(pageData.results)) {
          return pageData.results.map((item) => ({
            title: item.title || item.name,
            url: `${BASE_URL}/${item.media_type || "movie"}/${item.id}`,
            poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "",
            type: item.media_type === "tv" ? "tv" : "movie",
            id: item.id,
          }));
        }
      } catch (e) {
        // Ignore JSON parsing errors from the upstream payload
      }
    }

    // Fallback: parse card links from HTML DOM
    const cardRegex = /<a\s+href="\/([^"]+)"[^>]*class="[^"]*card[^"]*"[^>]*([\s\S]*?)<\/a>/g;
    let match;
    while ((match = cardRegex.exec(htmlContent)) !== null) {
      const path = match[1];
      const innerHtml = match[2];
      const titleMatch = innerHtml.match(/class="title"[^>]*>([^<]+)/);
      const imgMatch = innerHtml.match(/src="([^"]+)"/);

      if (path && titleMatch) {
        const isTv = path.startsWith("tv/");
        results.push({
          title: titleMatch[1].trim(),
          url: `${BASE_URL}/${path}`,
          poster: imgMatch ? imgMatch[1] : "",
          type: isTv ? "tv" : "movie",
        });
      }
    }

    return results;
  } catch (err) {
    console.error("[FlyStream] Search error:", err.message || err);
    return [];
  }
}

/**
 * Resolves streams for Nuvio, WuPlay, and Stremio through FlyStream's JSON API
 * (port of the hostreamio Dart FlyStreamScraper, see flystream-api-streams.js).
 *
 * The earlier HTML page / iframe-mirror scrape is no longer used for streams; `search`
 * and `fetchPageDOM` above stay exported for callers that load pages directly.
 *
 * Time bound: title lookup (2 s) + API call (5 s) = 7 s, under the router's 9 s deadline.
 *
 * @param {string|number} tmdbId TMDB ID of the title
 * @param {string} mediaType "movie" or "tv"
 * @param {number} season Season number (for TV)
 * @param {number} episode Episode number (for TV)
 * @returns {Promise<Array>} Array of stream objects
 */
async function getStreams(tmdbId, mediaType = "movie", season = 1, episode = 1) {
  if (!tmdbId) return [];

  const normType = mediaType === "series" || mediaType === "tv" ? "tv" : "movie";
  const s = normType === "tv" ? season || 1 : null;
  const e = normType === "tv" ? episode || 1 : null;
  const cacheKey = `${normType}:${tmdbId}:${s}:${e}`;

  const cached = streamCache.get(cacheKey);
  if (cached) return cached;

  try {
    const meta = await fetchTitleMetadata(String(tmdbId), normType);
    const result = await fetchApiStreams({
      mediaType: normType,
      title: meta.title,
      tmdbId: tmdbId,
      imdbId: meta.imdbId,
      year: meta.year,
      season: s,
      episode: e,
    });
    if (!result.ok) console.warn(`[FlyStream] API call failed (${result.reason}) for ${cacheKey}`);

    const streams = result.ok ? sortByQuality(result.streams) : [];
    streamCache.set(cacheKey, streams, streams.length ? CACHE_TTL_MS : EMPTY_TTL_MS);
    console.log(`[FlyStream] ${streams.length} stream(s) for ${cacheKey}`);
    return streams;
  } catch (err) {
    console.error("[FlyStream] getStreams error:", err.message || err);
    return [];
  }
}

module.exports = {
  getStreams,
  search,
  fetchPageDOM,
};
