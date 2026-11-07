/**
 * 7movies - Built from src/7movies/
 * Generated: 2026-11-07T23:30:04.833Z
 */
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

// src/7movies/index.js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var MEDIA_UA = "okhttp/4.12.0";
var VIDLINK_API = "https://vidlink.pro/api/b";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_HEADERS = {
  "User-Agent": UA,
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro"
};
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
var encCache = /* @__PURE__ */ new Map();
var streamCache = /* @__PURE__ */ new Map();
var CACHE_TTL_MS = 10 * 60 * 1e3;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function setBoundedCache(map, key, value, limit = MAX_CACHE_SIZE) {
  if (map.size >= limit) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, value);
}
function fetchWithRetry(url, headers, retries = 2, baseDelay = 600) {
  return __async(this, null, function* () {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = yield fetch(url, { headers: headers || {} });
        if (res.ok)
          return res;
        if ((res.status === 429 || res.status === 492 || res.status === 503) && attempt < retries) {
          const retryAfter = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
          const delayMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1e3 || baseDelay, 4e3) : baseDelay * Math.pow(2, attempt) + Math.random() * 200;
          yield sleep(delayMs);
          continue;
        }
        throw new Error("HTTP " + res.status + " for " + url);
      } catch (err) {
        if (attempt >= retries)
          throw err;
        yield sleep(baseDelay * Math.pow(2, attempt) + Math.random() * 200);
      }
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
function resolveAgainst(url, base) {
  if (!url || url.startsWith("http"))
    return url;
  try {
    return new URL(url, base).toString();
  } catch (e) {
    return url;
  }
}
function expandPlaylist(playlistUrl, headers, subtitles, title) {
  return __async(this, null, function* () {
    try {
      const text = yield fetchText(playlistUrl, headers);
      const variants = [];
      const streamInfRegex = /#EXT-X-STREAM-INF:[^\n]*?(?:RESOLUTION=(\d+)x(\d+))?[^\n]*\n([^\s#]+)/g;
      let match;
      while ((match = streamInfRegex.exec(text)) !== null) {
        const height = match[2] ? parseInt(match[2], 10) : null;
        const lineUrl = match[3].trim();
        const resolvedUrl = resolveAgainst(lineUrl, playlistUrl);
        const q = height ? qualityLabel(String(height)) : "Auto";
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
      if (cached && cached.expiresAt > Date.now()) {
        return cached.streams;
      }
      let encHash = encCache.get(cleanId);
      if (!encHash) {
        const enc = yield fetchJson(ENC_API + "?text=" + encodeURIComponent(cleanId), {
          "User-Agent": UA
        });
        if (!enc || !enc.result)
          return [];
        encHash = enc.result;
        setBoundedCache(encCache, cleanId, encHash);
      }
      const apiUrl = normType === "tv" ? `${VIDLINK_API}/tv/${encHash}/${s}/${ep}` : `${VIDLINK_API}/movie/${encHash}`;
      const data = yield fetchJson(apiUrl, VIDLINK_HEADERS);
      if (!data || !data.stream)
        return [];
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
      streams.sort(
        (a, b) => (QUALITY_ORDER[b.quality] || -2) - (QUALITY_ORDER[a.quality] || -2)
      );
      if (streams.length > 0) {
        setBoundedCache(streamCache, cacheKey, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          streams
        });
      }
      return streams;
    } catch (e) {
      console.error("[7Movies] " + (e && e.message ? e.message : e));
      return [];
    }
  });
}
module.exports = { getStreams };
