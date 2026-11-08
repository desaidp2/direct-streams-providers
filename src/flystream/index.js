/**
 * FlyStream provider for Nuvio, WuPlay, and Stremio.
 *
 * Implements the SkyStream-compatible challenge-rendering and DOM extraction
 * architecture described in flystream-skystream-addon-analysis-2026-11-08.md.
 *
 * Capabilities:
 *   - Automatic challenge browser delegation when running in host environments
 *     providing `challengeBrowser.execute()` (SkyStream, electron, or webview).
 *   - Direct resilient HTTP fetching fallback with browser impersonation headers.
 *   - Hydration state extraction (__STREAM_CONFIG__, __FLYCAST_DATA__).
 *   - DOM mirror extraction (iframes, direct media tags, and HLS variant streams).
 *   - ExoPlayer native header forwarding (`behaviorHints.proxyHeaders.request`).
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MEDIA_UA = "okhttp/4.12.0";

const BASE_URL = "https://flystream.net";

const HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: BASE_URL + "/",
  Origin: BASE_URL,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
};

const STREAM_HEADERS = {
  "User-Agent": MEDIA_UA,
  Referer: BASE_URL + "/",
  Origin: BASE_URL,
};

const { sortByQuality, withTimeout, TtlCache } = require("../shared/provider-utils");

// Bounded LRU cache. Misses are cached too (shorter), so a client retrying the same title
// does not send the site another request each time.
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 10 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
// Hard cap on one page load: the old fetch had no timeout, so a stalled site held every
// Stremio/WuPlay stream response open (the router waits for all providers).
const PAGE_TIMEOUT_MS = 5000;
const streamCache = new TtlCache(MAX_CACHE_SIZE, CACHE_TTL_MS);

function buildStream(name, title, url, quality) {
  return {
    name: name,
    title: title,
    url: url,
    quality: quality,
    headers: STREAM_HEADERS,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: STREAM_HEADERS,
      },
    },
    subtitles: [],
  };
}

/**
 * Executes request through host challenge_browser context if present,
 * or falls back to direct HTTP fetch with browser headers.
 */
async function fetchPageDOM(url) {
  try {
    return await withTimeout(loadPage(url), PAGE_TIMEOUT_MS, "FlyStream page");
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
      } catch (e) {}
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
 * Resolves streams for Nuvio, WuPlay, and Stremio.
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
  const cacheKey = `${normType}:${tmdbId}:${season}:${episode}`;

  const cached = streamCache.get(cacheKey);
  if (cached) return cached;

  try {
    const targetUrl =
      normType === "tv"
        ? `${BASE_URL}/tv/${tmdbId}?season=${season}&episode=${episode}`
        : `${BASE_URL}/movie/${tmdbId}`;

    const htmlContent = await fetchPageDOM(targetUrl);
    if (!htmlContent) {
      streamCache.set(cacheKey, [], EMPTY_TTL_MS);
      return [];
    }

    const streams = [];
    const seenUrls = new Set();
    const title = normType === "tv" ? `TV ${tmdbId} S${season}E${episode}` : `Movie ${tmdbId}`;

    // 1. Look for client-side state definitions (__STREAM_CONFIG__)
    const playerState = htmlContent.match(/__STREAM_CONFIG__\s*=\s*(\{.*?\});/);
    if (playerState) {
      try {
        const config = JSON.parse(playerState[1]);
        if (config && Array.isArray(config.sources)) {
          for (const source of config.sources) {
            const streamUrl = source.file || source.url;
            if (!streamUrl || seenUrls.has(streamUrl)) continue;
            seenUrls.add(streamUrl);

            const q = source.quality || "Auto";
            streams.push(
              buildStream(`FlyStream - ${source.label || q}`, `${title} - ${source.label || "HighSpeed"} (${q})`, streamUrl, q)
            );
          }
        }
      } catch (e) {
        console.warn("[FlyStream] Failed to parse __STREAM_CONFIG__:", e.message || e);
      }
    }

    // 2. Extract iframe and embedded player mirrors
    const iframeRegex = /<iframe[^>]+src="([^"]+)"/gi;
    let match;
    let mirrorIndex = 1;
    while ((match = iframeRegex.exec(htmlContent)) !== null) {
      let streamUrl = match[1];
      if (streamUrl.startsWith("//")) streamUrl = "https:" + streamUrl;
      if (seenUrls.has(streamUrl)) continue;
      seenUrls.add(streamUrl);

      streams.push(buildStream(`FlyStream - Mirror #${mirrorIndex}`, `${title} - Mirror #${mirrorIndex}`, streamUrl, "Auto"));
      mirrorIndex++;
    }

    // 3. Extract direct HLS (.m3u8) or MP4 video streams if exposed in DOM
    const mediaRegex = /https?:\/\/[^"'\s<>]+\.(m3u8|mp4)[^"'\s<>]*/gi;
    while ((match = mediaRegex.exec(htmlContent)) !== null) {
      const streamUrl = match[0];
      if (seenUrls.has(streamUrl)) continue;
      seenUrls.add(streamUrl);

      const is4k = /2160p|4k/i.test(streamUrl);
      const is1080 = /1080p/i.test(streamUrl);
      const is720 = /720p/i.test(streamUrl);
      const q = is4k ? "4K" : is1080 ? "1080p" : is720 ? "720p" : "Auto";

      streams.push(buildStream(`FlyStream - ${q}`, `${title} - Direct (${q})`, streamUrl, q));
    }

    // Sort streams by quality descending
    sortByQuality(streams);
    streamCache.set(cacheKey, streams, streams.length ? CACHE_TTL_MS : EMPTY_TTL_MS);

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
