/**
 * flystream - Built from src/flystream/
 * Generated: 2026-11-08T06:42:26.801Z
 */
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/shared/provider-utils.js
var require_provider_utils = __commonJS({
  "src/shared/provider-utils.js"(exports2, module2) {
    var QUALITY_ORDER = {
      "4K": 6,
      "1440p": 5,
      "1080p": 4,
      "720p": 3,
      "480p": 2,
      "360p": 1,
      Auto: 0,
      Unknown: -1
    };
    function qualityRank(quality) {
      return Object.prototype.hasOwnProperty.call(QUALITY_ORDER, quality) ? QUALITY_ORDER[quality] : -2;
    }
    function sortByQuality2(streams) {
      return streams.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    }
    function withTimeout2(promise, ms, label) {
      if (typeof setTimeout !== "function")
        return promise;
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error((label || "Timeout") + " " + ms + "ms")), ms);
      });
      return Promise.race([promise, timeoutPromise]).then(
        (value) => {
          if (typeof clearTimeout === "function")
            clearTimeout(timer);
          return value;
        },
        (err) => {
          if (typeof clearTimeout === "function")
            clearTimeout(timer);
          throw err;
        }
      );
    }
    var TtlCache2 = class {
      constructor(limit, defaultTtlMs) {
        this.limit = limit;
        this.defaultTtlMs = defaultTtlMs;
        this.map = /* @__PURE__ */ new Map();
      }
      get(key) {
        const entry = this.map.get(key);
        if (!entry)
          return void 0;
        if (entry.expiresAt <= Date.now()) {
          this.map.delete(key);
          return void 0;
        }
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
      }
      has(key) {
        return this.get(key) !== void 0;
      }
      set(key, value, ttlMs) {
        if (this.map.has(key))
          this.map.delete(key);
        else if (this.map.size >= this.limit)
          this.map.delete(this.map.keys().next().value);
        this.map.set(key, { value, expiresAt: Date.now() + (ttlMs || this.defaultTtlMs) });
      }
      delete(key) {
        this.map.delete(key);
      }
      get size() {
        return this.map.size;
      }
    };
    module2.exports = { QUALITY_ORDER, qualityRank, sortByQuality: sortByQuality2, withTimeout: withTimeout2, TtlCache: TtlCache2 };
  }
});

// src/flystream/index.js
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var MEDIA_UA = "okhttp/4.12.0";
var BASE_URL = "https://flystream.net";
var HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: BASE_URL + "/",
  Origin: BASE_URL,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
};
var STREAM_HEADERS = {
  "User-Agent": MEDIA_UA,
  Referer: BASE_URL + "/",
  Origin: BASE_URL
};
var { sortByQuality, withTimeout, TtlCache } = require_provider_utils();
var MAX_CACHE_SIZE = 100;
var CACHE_TTL_MS = 10 * 60 * 1e3;
var EMPTY_TTL_MS = 5 * 60 * 1e3;
var PAGE_TIMEOUT_MS = 5e3;
var EMBED_TIMEOUT_MS = 3500;
var MAX_EMBEDS = 4;
var streamCache = new TtlCache(MAX_CACHE_SIZE, CACHE_TTL_MS);
var MEDIA_REGEX = /https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)(?:[?#][^"'\s<>\\]*)?/gi;
var NAMED_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
function decodeHtmlEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ent) => {
    const e = ent.toLowerCase();
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 1114111 ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : whole;
  });
}
function extractMediaUrls(html) {
  const text = html.replace(/\\\//g, "/");
  const urls = [];
  let match;
  MEDIA_REGEX.lastIndex = 0;
  while ((match = MEDIA_REGEX.exec(text)) !== null)
    urls.push(decodeHtmlEntities(match[0]));
  return urls;
}
function qualityFromUrl(url) {
  if (/2160p|4k/i.test(url))
    return "4K";
  if (/1080p/i.test(url))
    return "1080p";
  if (/720p/i.test(url))
    return "720p";
  return "Auto";
}
function originOf(url) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1] : null;
}
function buildStream(name, title, url, quality, headers) {
  const h = headers || STREAM_HEADERS;
  return {
    name,
    title,
    url,
    quality,
    headers: h,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: h
      }
    },
    subtitles: []
  };
}
function fetchPageDOM(url, timeoutMs) {
  return __async(this, null, function* () {
    try {
      return yield withTimeout(loadPage(url), timeoutMs || PAGE_TIMEOUT_MS, "FlyStream page");
    } catch (err) {
      console.error("[FlyStream] fetchPageDOM failed:", err.message || err);
      return null;
    }
  });
}
function resolveEmbed(embedUrl) {
  return __async(this, null, function* () {
    const html = yield fetchPageDOM(embedUrl, EMBED_TIMEOUT_MS);
    if (!html)
      return [];
    const urls = extractMediaUrls(html);
    if (!urls.length)
      console.warn(`[FlyStream] embed has no media link, dropped: ${embedUrl}`);
    return urls;
  });
}
function loadPage(url) {
  return __async(this, null, function* () {
    if (typeof challengeBrowser !== "undefined" && challengeBrowser && typeof challengeBrowser.execute === "function") {
      try {
        const response = yield challengeBrowser.execute(url, {
          method: "GET",
          headers: { "User-Agent": BROWSER_UA },
          evaluateJs: "document.documentElement.outerHTML",
          waitForSelector: "body"
        });
        if (response && response.result) {
          return response.result;
        }
      } catch (cbErr) {
        console.warn("[FlyStream] challengeBrowser error, falling back to fetch:", cbErr.message || cbErr);
      }
    }
    const res = yield fetch(url, {
      method: "GET",
      headers: HEADERS,
      cache: "no-store"
    });
    if (res.status === 403 || res.status === 401) {
      console.warn(`[FlyStream] Endpoint gated (${res.status}) on ${url}`);
      return null;
    }
    if (!res.ok) {
      return null;
    }
    return yield res.text();
  });
}
function search(query) {
  return __async(this, null, function* () {
    try {
      const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
      const htmlContent = yield fetchPageDOM(searchUrl);
      if (!htmlContent)
        return [];
      const results = [];
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
              id: item.id
            }));
          }
        } catch (e) {
        }
      }
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
            type: isTv ? "tv" : "movie"
          });
        }
      }
      return results;
    } catch (err) {
      console.error("[FlyStream] Search error:", err.message || err);
      return [];
    }
  });
}
function getStreams(tmdbId, mediaType = "movie", season = 1, episode = 1) {
  return __async(this, null, function* () {
    if (!tmdbId)
      return [];
    const normType = mediaType === "series" || mediaType === "tv" ? "tv" : "movie";
    const cacheKey = `${normType}:${tmdbId}:${season}:${episode}`;
    const cached = streamCache.get(cacheKey);
    if (cached)
      return cached;
    try {
      const targetUrl = normType === "tv" ? `${BASE_URL}/tv/${tmdbId}?season=${season}&episode=${episode}` : `${BASE_URL}/movie/${tmdbId}`;
      const htmlContent = yield fetchPageDOM(targetUrl);
      if (!htmlContent) {
        streamCache.set(cacheKey, [], EMPTY_TTL_MS);
        return [];
      }
      const streams = [];
      const seenUrls = /* @__PURE__ */ new Set();
      const title = normType === "tv" ? `TV ${tmdbId} S${season}E${episode}` : `Movie ${tmdbId}`;
      const playerState = htmlContent.match(/__STREAM_CONFIG__\s*=\s*(\{.*?\});/);
      if (playerState) {
        try {
          const config = JSON.parse(playerState[1]);
          if (config && Array.isArray(config.sources)) {
            for (const source of config.sources) {
              const streamUrl = source.file || source.url;
              if (!streamUrl || seenUrls.has(streamUrl))
                continue;
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
      const iframeRegex = /<iframe[^>]+src="([^"]+)"/gi;
      const embedUrls = [];
      let match;
      while ((match = iframeRegex.exec(htmlContent)) !== null) {
        let embedUrl = decodeHtmlEntities(match[1]);
        if (embedUrl.startsWith("//"))
          embedUrl = "https:" + embedUrl;
        if (!/^https?:\/\//i.test(embedUrl) || embedUrls.includes(embedUrl))
          continue;
        embedUrls.push(embedUrl);
      }
      const embedResults = yield Promise.all(embedUrls.slice(0, MAX_EMBEDS).map(resolveEmbed));
      let mirrorIndex = 1;
      embedUrls.slice(0, MAX_EMBEDS).forEach((embedUrl, i) => {
        const origin = originOf(embedUrl);
        const headers = origin ? { "User-Agent": MEDIA_UA, Referer: origin + "/", Origin: origin } : STREAM_HEADERS;
        for (const streamUrl of embedResults[i]) {
          if (seenUrls.has(streamUrl))
            continue;
          seenUrls.add(streamUrl);
          const q = qualityFromUrl(streamUrl);
          streams.push(
            buildStream(`FlyStream - Mirror #${mirrorIndex} (${q})`, `${title} - Mirror #${mirrorIndex} (${q})`, streamUrl, q, headers)
          );
          mirrorIndex++;
        }
      });
      for (const streamUrl of extractMediaUrls(htmlContent)) {
        if (seenUrls.has(streamUrl))
          continue;
        seenUrls.add(streamUrl);
        const q = qualityFromUrl(streamUrl);
        streams.push(buildStream(`FlyStream - ${q}`, `${title} - Direct (${q})`, streamUrl, q));
      }
      sortByQuality(streams);
      streamCache.set(cacheKey, streams, streams.length ? CACHE_TTL_MS : EMPTY_TTL_MS);
      return streams;
    } catch (err) {
      console.error("[FlyStream] getStreams error:", err.message || err);
      return [];
    }
  });
}
module.exports = {
  getStreams,
  search,
  fetchPageDOM
};
