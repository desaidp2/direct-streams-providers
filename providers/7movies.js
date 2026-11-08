/**
 * 7movies - Built from src/7movies/
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
    function withTimeout(promise, ms, label) {
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
    function fetchWithTimeout2(url, init, ms, label) {
      if (typeof AbortController !== "function" || typeof setTimeout !== "function") {
        return withTimeout(fetch(url, init), ms, label);
      }
      const controller = new AbortController();
      const opts = Object.assign({}, init || {}, { signal: controller.signal });
      return withTimeout(fetch(url, opts), ms, label).catch((err) => {
        controller.abort();
        throw err;
      });
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
    module2.exports = { QUALITY_ORDER, qualityRank, sortByQuality: sortByQuality2, withTimeout, fetchWithTimeout: fetchWithTimeout2, TtlCache: TtlCache2 };
  }
});

// src/7movies/hls-master-playlist-parser.js
var require_hls_master_playlist_parser = __commonJS({
  "src/7movies/hls-master-playlist-parser.js"(exports2, module2) {
    var STREAM_INF_RE = /#EXT-X-STREAM-INF:([^\r\n]*)\r?\n\s*([^\s#][^\r\n]*)/g;
    var RESOLUTION_RE = /(?:^|,)RESOLUTION=(\d+)x(\d+)/;
    function resolveAgainst(url, base) {
      if (!url || url.startsWith("http"))
        return url;
      try {
        return new URL(url, base).toString();
      } catch (e) {
        return url;
      }
    }
    function parseMasterPlaylist2(text, playlistUrl) {
      const variants = [];
      STREAM_INF_RE.lastIndex = 0;
      let match;
      while ((match = STREAM_INF_RE.exec(text)) !== null) {
        const res = RESOLUTION_RE.exec(match[1]);
        variants.push({
          url: resolveAgainst(match[2].trim(), playlistUrl),
          height: res ? parseInt(res[2], 10) : null
        });
      }
      return variants;
    }
    module2.exports = { parseMasterPlaylist: parseMasterPlaylist2, resolveAgainst };
  }
});

// src/7movies/index.js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var MEDIA_UA = "okhttp/4.12.0";
var { sortByQuality, fetchWithTimeout, TtlCache } = require_provider_utils();
var { parseMasterPlaylist } = require_hls_master_playlist_parser();
var VIDLINK_API = "https://vidlink.pro/api/b";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_HEADERS = {
  "User-Agent": UA,
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro"
};
var LANG_CODES = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  russian: "ru",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  hindi: "hi",
  arabic: "ar",
  vietnamese: "vi",
  indonesian: "id",
  filipino: "tl",
  turkish: "tr",
  polish: "pl",
  dutch: "nl",
  swedish: "sv",
  thai: "th"
};
var MAX_CACHE_SIZE = 100;
var CACHE_TTL_MS = 10 * 60 * 1e3;
var EMPTY_TTL_MS = 2 * 60 * 1e3;
var REQUEST_TIMEOUT_MS = 4e3;
var encCache = new TtlCache(MAX_CACHE_SIZE, 6 * 60 * 60 * 1e3);
var streamCache = new TtlCache(MAX_CACHE_SIZE, CACHE_TTL_MS);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var RETRYABLE_STATUS = { 429: true, 492: true, 503: true };
function fetchWithRetry(url, headers, retries = 2, baseDelay = 600) {
  return __async(this, null, function* () {
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = yield fetchWithTimeout(url, { headers: headers || {} }, REQUEST_TIMEOUT_MS, "7Movies fetch");
      } catch (err) {
        if (attempt >= retries)
          throw err;
        yield sleep(baseDelay * Math.pow(2, attempt) + Math.random() * 200);
        continue;
      }
      if (res.ok)
        return res;
      if (RETRYABLE_STATUS[res.status] && attempt < retries) {
        const retryAfter = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
        const delayMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1e3 || baseDelay, 4e3) : baseDelay * Math.pow(2, attempt) + Math.random() * 200;
        yield sleep(delayMs);
        continue;
      }
      throw new Error("HTTP " + res.status + " for " + url);
    }
  });
}
function fetchJson(url, headers) {
  return __async(this, null, function* () {
    const res = yield fetchWithRetry(url, headers);
    return yield res.json();
  });
}
function fetchText(url, headers) {
  return __async(this, null, function* () {
    const res = yield fetchWithRetry(url, headers);
    return yield res.text();
  });
}
function qualityLabel(key) {
  const n = parseInt(key, 10);
  if (!isNaN(n)) {
    if (n >= 2160)
      return "4K";
    if (n >= 1440)
      return "1440p";
    if (n >= 1080)
      return "1080p";
    if (n >= 720)
      return "720p";
    if (n >= 480)
      return "480p";
    if (n >= 360)
      return "360p";
    return n + "p";
  }
  const s = String(key || "").toLowerCase();
  if (s.includes("2160") || s.includes("4k"))
    return "4K";
  if (s.includes("1080"))
    return "1080p";
  if (s.includes("720"))
    return "720p";
  if (s.includes("480"))
    return "480p";
  if (s.includes("360"))
    return "360p";
  return "Unknown";
}
function mapSubtitles(captions) {
  if (!Array.isArray(captions))
    return [];
  const out = [];
  const seenUrls = /* @__PURE__ */ new Set();
  for (const c of captions) {
    if (!c || !c.url || seenUrls.has(c.url))
      continue;
    seenUrls.add(c.url);
    const name = c.language || c.label || c.name || "Unknown";
    const code = LANG_CODES[String(name).trim().toLowerCase()] || (String(name).length === 2 ? String(name).toLowerCase() : "und");
    out.push({
      url: c.url,
      language: code,
      name: String(name),
      headers: { "User-Agent": MEDIA_UA }
    });
  }
  return out;
}
function playbackHeaders(qualityData, streamData) {
  const src = Object.assign(
    {},
    streamData && streamData.headers || {},
    qualityData && qualityData.headers || {}
  );
  const h = {
    "User-Agent": MEDIA_UA
  };
  for (const k of Object.keys(src)) {
    const val = src[k];
    if (val) {
      if (k.toLowerCase() === "referer")
        h["Referer"] = val;
      else if (k.toLowerCase() === "origin")
        h["Origin"] = val;
      else if (k.toLowerCase() === "user-agent") {
        h["User-Agent"] = val.includes("Mozilla") ? MEDIA_UA : val;
      } else
        h[k] = val;
    }
  }
  return h;
}
function expandPlaylist(playlistUrl, headers, subtitles, title) {
  return __async(this, null, function* () {
    try {
      const text = yield fetchText(playlistUrl, headers);
      const parsed = parseMasterPlaylist(text, playlistUrl);
      const variants = [];
      for (let i = 0; i < parsed.length; i++) {
        const resolvedUrl = parsed[i].url;
        const q = parsed[i].height ? qualityLabel(String(parsed[i].height)) : "Auto";
        variants.push({
          name: "7Movies - " + q,
          title,
          url: resolvedUrl,
          quality: q,
          headers,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: headers
            }
          },
          subtitles
        });
      }
      if (!variants.length)
        throw new Error("no variants");
      return variants;
    } catch (e) {
      return [
        {
          name: "7Movies - Auto",
          title,
          url: playlistUrl,
          quality: "Auto",
          headers,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: headers
            }
          },
          subtitles
        }
      ];
    }
  });
}
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      if (!tmdbId)
        return [];
      const cleanId = String(tmdbId).trim();
      if (!cleanId)
        return [];
      const normType = mediaType === "tv" ? "tv" : "movie";
      const s = normType === "tv" ? Math.max(1, parseInt(season, 10) || 1) : null;
      const ep = normType === "tv" ? Math.max(1, parseInt(episode, 10) || 1) : null;
      const cacheKey = normType === "tv" ? `${cleanId}:${s}:${ep}` : cleanId;
      const cached = streamCache.get(cacheKey);
      if (cached)
        return cached;
      let encHash = encCache.get(cleanId);
      if (!encHash) {
        const enc = yield fetchJson(ENC_API + "?text=" + encodeURIComponent(cleanId), {
          "User-Agent": UA
        });
        if (!enc || !enc.result)
          return [];
        encHash = enc.result;
        encCache.set(cleanId, encHash);
      }
      const apiUrl = normType === "tv" ? `${VIDLINK_API}/tv/${encHash}/${s}/${ep}` : `${VIDLINK_API}/movie/${encHash}`;
      let data;
      try {
        data = yield fetchJson(apiUrl, VIDLINK_HEADERS);
      } catch (e) {
        if (/^HTTP \d+/.test(e.message || ""))
          streamCache.set(cacheKey, [], EMPTY_TTL_MS);
        throw e;
      }
      if (!data || !data.stream) {
        streamCache.set(cacheKey, [], EMPTY_TTL_MS);
        return [];
      }
      const stream = data.stream;
      const subtitles = mapSubtitles(stream.captions || data.captions);
      const title = normType === "tv" ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0") : "Movie";
      const streams = [];
      if (stream.qualities) {
        const keys = Object.keys(stream.qualities);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const qd = stream.qualities[key];
          if (!qd || !qd.url)
            continue;
          const q = qualityLabel(key);
          const headers = playbackHeaders(qd, stream);
          streams.push({
            name: "7Movies - " + q,
            title: title + " - " + q + (qd.type ? " " + String(qd.type).toUpperCase() : ""),
            url: qd.url,
            quality: q,
            headers,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: {
                request: headers
              }
            },
            subtitles
          });
        }
      }
      if (stream.playlist) {
        const plHeaders = playbackHeaders(null, stream);
        const expanded = yield expandPlaylist(
          stream.playlist,
          plHeaders || VIDLINK_HEADERS,
          subtitles,
          title
        );
        for (let i = 0; i < expanded.length; i++) {
          streams.push(expanded[i]);
        }
      }
      sortByQuality(streams);
      streamCache.set(cacheKey, streams, streams.length ? CACHE_TTL_MS : EMPTY_TTL_MS);
      return streams;
    } catch (e) {
      console.error("[7Movies] " + (e && e.message ? e.message : e));
      return [];
    }
  });
}
module.exports = { getStreams };
