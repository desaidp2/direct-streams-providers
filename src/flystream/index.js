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
// Iframe mirrors are HTML player pages, not media, so each one is loaded to find the media link
// inside it. They load in parallel, bounded per embed, so page (5 s) + embeds (3.5 s) stays under
// the router's 9 s provider deadline. At most MAX_EMBEDS are tried per title.
const EMBED_TIMEOUT_MS = 3500;
const MAX_EMBEDS = 4;
const streamCache = new TtlCache(MAX_CACHE_SIZE, CACHE_TTL_MS);

const MEDIA_REGEX = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)(?:[?#][^"'\s<>\\]*)?/gi;

// Single pass, so "&amp;lt;" decodes to "&lt;" once and is never decoded twice.
const NAMED_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
function decodeHtmlEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ent) => {
    const e = ent.toLowerCase();
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : whole;
  });
}

// Direct .m3u8/.mp4 links in a page, including JSON-escaped ones ("https:\/\/..."), entity-decoded.
function extractMediaUrls(html) {
  const text = html.replace(/\\\//g, "/");
  const urls = [];
  let match;
  MEDIA_REGEX.lastIndex = 0;
  while ((match = MEDIA_REGEX.exec(text)) !== null) urls.push(decodeHtmlEntities(match[0]));
  return urls;
}

function qualityFromUrl(url) {
  if (/2160p|4k/i.test(url)) return "4K";
  if (/1080p/i.test(url)) return "1080p";
  if (/720p/i.test(url)) return "720p";
  return "Auto";
}

// "https://host:port/path" -> "https://host:port" (no URL global in QuickJS/Hermes hosts).
function originOf(url) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1] : null;
}

function buildStream(name, title, url, quality, headers) {
  const h = headers || STREAM_HEADERS;
  return {
    name: name,
    title: title,
    url: url,
    quality: quality,
    headers: h,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: h,
      },
    },
    subtitles: [],
  };
}

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

// Loads one iframe player page and returns the media links inside it ([] when none or on error).
async function resolveEmbed(embedUrl) {
  const html = await fetchPageDOM(embedUrl, EMBED_TIMEOUT_MS);
  if (!html) return [];
  const urls = extractMediaUrls(html);
  if (!urls.length) console.warn(`[FlyStream] embed has no media link, dropped: ${embedUrl}`);
  return urls;
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

    // 2. Iframe mirrors: an iframe src is an HTML player page, so it is never returned as a
    //    stream itself. Each embed is loaded (bounded, in parallel) and the media links inside it
    //    become streams sent with the embed's own Referer/Origin. An embed without one is dropped.
    const iframeRegex = /<iframe[^>]+src="([^"]+)"/gi;
    const embedUrls = [];
    let match;
    while ((match = iframeRegex.exec(htmlContent)) !== null) {
      let embedUrl = decodeHtmlEntities(match[1]);
      if (embedUrl.startsWith("//")) embedUrl = "https:" + embedUrl;
      if (!/^https?:\/\//i.test(embedUrl) || embedUrls.includes(embedUrl)) continue;
      embedUrls.push(embedUrl);
    }
    const embedResults = await Promise.all(embedUrls.slice(0, MAX_EMBEDS).map(resolveEmbed));
    let mirrorIndex = 1;
    embedUrls.slice(0, MAX_EMBEDS).forEach((embedUrl, i) => {
      const origin = originOf(embedUrl);
      const headers = origin ? { "User-Agent": MEDIA_UA, Referer: origin + "/", Origin: origin } : STREAM_HEADERS;
      for (const streamUrl of embedResults[i]) {
        if (seenUrls.has(streamUrl)) continue;
        seenUrls.add(streamUrl);
        const q = qualityFromUrl(streamUrl);
        streams.push(
          buildStream(`FlyStream - Mirror #${mirrorIndex} (${q})`, `${title} - Mirror #${mirrorIndex} (${q})`, streamUrl, q, headers)
        );
        mirrorIndex++;
      }
    });

    // 3. Direct HLS (.m3u8) or MP4 links exposed in the page itself
    for (const streamUrl of extractMediaUrls(htmlContent)) {
      if (seenUrls.has(streamUrl)) continue;
      seenUrls.add(streamUrl);
      const q = qualityFromUrl(streamUrl);
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
