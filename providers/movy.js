/**
 * movy - Built from src/movy/
 * Generated: 2026-11-08T04:38:51.582Z
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

// src/movy/index.js
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var MEDIA_UA = "okhttp/4.12.0";
var SITE = "https://www.movy.sx";
var API = "https://api.wecollege.net";
var SUBS_API = "https://subtitles.vidy.st/search";
var API_HEADERS = {
  "User-Agent": BROWSER_UA,
  Origin: SITE,
  Referer: SITE + "/"
};
var STREAM_HEADERS = {
  "User-Agent": MEDIA_UA,
  Referer: SITE + "/",
  Origin: SITE
};
var PRIMARY_SERVERS = ["miami", "boise"];
var SECONDARY_SERVERS = ["atlanta", "phoenix", "dallas"];
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
var MAGIC = [109, 118, 109, 49];
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function mix(e) {
  e = e >>> 0;
  e ^= e >>> 16;
  e = Math.imul(e, 2246822507) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 3266489909) >>> 0;
  return (e ^ e >>> 16) >>> 0;
}
function rotl(e, a) {
  e = e >>> 0;
  a &= 31;
  return a === 0 ? e : (e << a | e >>> 32 - a) >>> 0;
}
function b64decode(str) {
  str = String(str || "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    buf = buf << 6 | B64_CHARS.indexOf(str.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(buf >> bits & 255);
      buf &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(out);
}
function utf8decode(bytes) {
  let s = "";
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    let cp;
    if (c < 128) {
      cp = c;
    } else if (c < 224) {
      cp = (c & 31) << 6 | bytes[i++] & 63;
    } else if (c < 240) {
      cp = (c & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
    } else {
      cp = (c & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
    }
    if (cp > 65535) {
      cp -= 65536;
      s += String.fromCharCode(55296 + (cp >> 10), 56320 + (cp & 1023));
    } else {
      s += String.fromCharCode(cp);
    }
  }
  return s;
}
function initState(seed, mediaId) {
  let fnv = 2166136261;
  for (let t = 0; t < seed.length; t++) {
    fnv = Math.imul(fnv ^ seed.charCodeAt(t), 16777619) >>> 0;
  }
  const S = new Uint32Array(61);
  const used = new Uint8Array(61);
  let n = mix((mix(fnv) ^ mix((Number(mediaId) >>> 0 ^ 2654435769) >>> 0)) >>> 0) >>> 0;
  for (let e = 0; e < 8; e++) {
    const a = n % 61;
    n = rotl(n + 2654435769 >>> 0, 7 + (7 & e));
    S[a] = (n ^ mix(n)) >>> 0;
    used[a] = 1;
    n = mix(n + a >>> 0);
  }
  return { S, used, acc: mix(2779096485 ^ n) >>> 0 };
}
function keystream(seed, mediaId, len) {
  const st = initState(seed, mediaId);
  const S = st.S;
  const used = st.used;
  let acc = st.acc;
  const out = new Uint8Array(len);
  let counter = 0;
  for (let e = 0; e < len; ) {
    const dd = acc % 61;
    const negIn = used[dd] ? -1 : 0;
    const r = S[dd] >>> 0;
    const cc = Math.imul(2654435769, counter + 1) >>> 0;
    const nn = (r ^ cc) >>> 0;
    let b = ((acc ^ nn) >>> 0 | (acc & nn & negIn) >>> 0) >>> 0;
    b = (rotl(b + acc >>> 0, 31 & dd) ^ rotl(acc, 31 & Math.imul(dd, 7))) >>> 0;
    acc = mix(b + 2654435769 >>> 0);
    S[dd] = acc >>> 0;
    used[dd] = 1;
    const word = acc >>> 0;
    counter++;
    out[e++] = 255 & word;
    if (e < len)
      out[e++] = word >>> 8 & 255;
    if (e < len)
      out[e++] = word >>> 16 & 255;
    if (e < len)
      out[e++] = word >>> 24 & 255;
  }
  return out;
}
function decryptSources(payloadText, seed, mediaId) {
  const cleanText = String(payloadText || "").replace(/^\s*"|"\s*$/g, "").trim();
  const data = b64decode(cleanText);
  const ks = keystream(seed, Number(mediaId), data.length);
  for (let j = 0; j < data.length; j++)
    data[j] ^= ks[j];
  for (let j = 0; j < MAGIC.length; j++) {
    if (data[j] !== MAGIC[j])
      throw new Error("mvm1 magic mismatch");
  }
  return utf8decode(data.subarray(MAGIC.length));
}
function timeout(promise, ms = 3500) {
  if (typeof setTimeout !== "function")
    return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timeout " + ms + "ms")), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (typeof clearTimeout === "function")
        clearTimeout(timer);
    }),
    timeoutPromise
  ]);
}
function buildQuery(params) {
  const parts = [];
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v !== void 0 && v !== null && v !== "") {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    }
  }
  return parts.join("&");
}
var seedCache = /* @__PURE__ */ new Map();
function getSeed(mediaId) {
  return __async(this, null, function* () {
    const hit = seedCache.get(mediaId);
    if (hit && hit.expiresAt - 5e3 > Date.now())
      return hit.seed;
    const res = yield timeout(
      fetch(API + "/seed?mediaId=" + encodeURIComponent(mediaId), {
        headers: API_HEADERS
      }),
      3500
    );
    if (!res.ok)
      throw new Error("seed HTTP " + res.status);
    const data = yield res.json();
    seedCache.set(mediaId, {
      seed: data.seed,
      expiresAt: Date.now() + (data.ttlMs || 3e4)
    });
    return data.seed;
  });
}
function fetchServerSources(server, params, mediaId) {
  return __async(this, null, function* () {
    const attempt = () => __async(this, null, function* () {
      const seed = yield getSeed(mediaId);
      const queryParams = Object.assign({}, params, {
        enc: "2",
        seed
      });
      const url = API + "/" + server + "/sources?" + buildQuery(queryParams);
      const res = yield timeout(
        fetch(url, {
          headers: API_HEADERS
        }),
        3500
      );
      if (!res.ok)
        throw new Error("sources HTTP " + res.status);
      const text = yield res.text();
      const decrypted = decryptSources(text, seed, mediaId);
      return JSON.parse(decrypted);
    });
    try {
      return yield attempt();
    } catch (e) {
      if (String(e.message || "").includes("401")) {
        seedCache.delete(mediaId);
        return yield attempt();
      }
      throw e;
    }
  });
}
function fetchDetailParams(tmdbId, mediaType) {
  return __async(this, null, function* () {
    try {
      const res = yield timeout(
        fetch(SITE + "/" + mediaType + "/" + tmdbId, {
          headers: { "User-Agent": BROWSER_UA }
        }),
        3e3
      );
      if (!res.ok)
        return {};
      const html = yield res.text();
      const m = html.match(new RegExp("__NEXT_DATA__[^>]*>(.*?)<\\/script>", "s"));
      if (!m)
        return {};
      const details = JSON.parse(m[1]).props.pageProps.details || {};
      return {
        title: details.title ? encodeURIComponent(details.title) : void 0,
        year: details.year,
        imdbId: details.imdbId,
        totalSeasons: Array.isArray(details.seasons) ? details.seasons.length : void 0
      };
    } catch (e) {
      return {};
    }
  });
}
function fetchSubtitles(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      let url = SUBS_API + "?id=" + encodeURIComponent(tmdbId);
      if (mediaType === "tv") {
        url += "&season=" + (season || 1) + "&episode=" + (episode || 1);
      }
      const res = yield timeout(
        fetch(url, { headers: { "User-Agent": BROWSER_UA } }),
        3e3
      );
      if (!res.ok)
        return [];
      const list = yield res.json();
      if (!Array.isArray(list))
        return [];
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const item of list) {
        if (!item || !item.url)
          continue;
        const lang = item.language || "und";
        if (seen.has(lang))
          continue;
        seen.add(lang);
        out.push({
          url: item.url,
          language: lang,
          name: item.display || lang,
          headers: STREAM_HEADERS
        });
        if (out.length >= 20)
          break;
      }
      out.sort((a, b) => a.language === "en" ? -1 : b.language === "en" ? 1 : 0);
      return out;
    } catch (e) {
      return [];
    }
  });
}
function qualityLabel(raw) {
  const s = String(raw || "");
  const m = s.match(/(\d{3,4})/);
  if (m) {
    const n = parseInt(m[1], 10);
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
  if (/4k|uhd/i.test(s))
    return "4K";
  return "Unknown";
}
function serverTitle(server) {
  return server.charAt(0).toUpperCase() + server.slice(1);
}
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      let collectSources2 = function(data, server) {
        if (!data)
          return;
        if (Array.isArray(data.subtitles) && data.subtitles.length && !payloadSubs.length) {
          payloadSubs = data.subtitles.filter((sub) => sub && (sub.url || sub.file)).map((sub) => ({
            url: sub.url || sub.file,
            language: sub.language || sub.lang || "und",
            name: sub.display || sub.label || sub.language || "Subtitle",
            headers: STREAM_HEADERS
          }));
        }
        if (data.playlist && !seenUrls.has(data.playlist)) {
          seenUrls.add(data.playlist);
          streams.push({
            name: "Movy " + serverTitle(server) + " - Auto (Master)",
            title: (type === "tv" ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0") : "Movie") + " - Auto (up to 4K) HLS",
            url: data.playlist,
            quality: "Auto",
            headers: STREAM_HEADERS,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: {
                request: STREAM_HEADERS
              }
            },
            subtitles: []
          });
        }
        const sources = Array.isArray(data.sources) ? data.sources : [];
        for (const src of sources) {
          if (!src || !src.url || seenUrls.has(src.url))
            continue;
          const isLangLabel = !/\d/.test(String(src.quality || ""));
          const q = isLangLabel ? "Unknown" : qualityLabel(src.quality);
          seenUrls.add(src.url);
          streams.push({
            name: "Movy " + serverTitle(server) + " - " + q,
            title: (type === "tv" ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0") : "Movie") + " - " + q + (isLangLabel ? " (" + String(src.quality) + ")" : "") + " HLS",
            url: src.url,
            quality: q,
            headers: STREAM_HEADERS,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: {
                request: STREAM_HEADERS
              }
            },
            subtitles: []
          });
        }
      };
      var collectSources = collectSources2;
      if (!tmdbId)
        return [];
      const cleanId = String(tmdbId).trim();
      if (!cleanId)
        return [];
      const type = mediaType === "tv" ? "tv" : "movie";
      const s = type === "tv" ? Math.max(1, parseInt(season, 10) || 1) : null;
      const ep = type === "tv" ? Math.max(1, parseInt(episode, 10) || 1) : null;
      const seedPromise = getSeed(cleanId);
      const detailPromise = fetchDetailParams(cleanId, type);
      let seed;
      try {
        seed = yield timeout(seedPromise, 3500);
      } catch (e) {
        return [];
      }
      if (!seed)
        return [];
      const baseParams = {
        mediaType: type,
        tmdbId: Number(cleanId),
        seasonId: type === "tv" ? s : void 0,
        episodeId: type === "tv" ? ep : void 0
      };
      const primaryResults = yield Promise.allSettled(
        PRIMARY_SERVERS.map((srv) => fetchServerSources(srv, baseParams, cleanId))
      );
      const streams = [];
      const seenUrls = /* @__PURE__ */ new Set();
      let payloadSubs = [];
      for (let i = 0; i < PRIMARY_SERVERS.length; i++) {
        const res = primaryResults[i];
        if (res.status === "fulfilled" && res.value) {
          collectSources2(res.value, PRIMARY_SERVERS[i]);
        }
      }
      if (!streams.length) {
        const detail = (yield timeout(detailPromise, 2500).catch(() => ({}))) || {};
        const detailParams = Object.assign({}, baseParams, {
          title: detail.title,
          year: detail.year,
          imdbId: detail.imdbId,
          totalSeasons: detail.totalSeasons
        });
        const secondaryResults = yield Promise.allSettled(
          SECONDARY_SERVERS.map((srv) => fetchServerSources(srv, detailParams, cleanId))
        );
        for (let i = 0; i < SECONDARY_SERVERS.length; i++) {
          const res = secondaryResults[i];
          if (res.status === "fulfilled" && res.value) {
            collectSources2(res.value, SECONDARY_SERVERS[i]);
          }
        }
      }
      if (!streams.length)
        return [];
      let subs = payloadSubs;
      if (!subs.length) {
        subs = yield timeout(fetchSubtitles(cleanId, type, s, ep), 2500).catch(() => []);
      }
      for (const st of streams)
        st.subtitles = subs || [];
      streams.sort(
        (a, b) => (QUALITY_ORDER[b.quality] || -2) - (QUALITY_ORDER[a.quality] || -2)
      );
      return streams;
    } catch (e) {
      console.error("[Movy] " + (e && e.message ? e.message : e));
      return [];
    }
  });
}
module.exports = { getStreams, fetchSubtitles };
