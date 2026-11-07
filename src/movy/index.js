/**
 * Movy provider for Nuvio.
 *
 * movy.sx is a TMDB-keyed front end (/movie/{tmdbId}, /tv/{tmdbId})
 * over the wecollege stream API (api.wecollege.net). Its server
 * endpoints (/{server}/sources) return encrypted payloads:
 *   1. GET /seed?mediaId={tmdbId} -> {seed, ttlMs}
 *   2. Base64url text containing "mvm1" || JSON, XORed with a keystream
 *      derived from seed + mediaId by a custom PRNG.
 *
 * QuickJS / Hermes Embedded Compatibility:
 *   - 100% Pure ECMAScript: No Node.js Buffer, no DOM atob, no TextDecoder.
 *   - Bounded queries & tight timeouts (< 2s total resolution).
 *   - behaviorHints.proxyHeaders.request passes Referer + Origin to bypass
 *     media CDN (goldenkite / vividstone) 403 Forbidden blocks.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MEDIA_UA = "okhttp/4.12.0";

const SITE = "https://www.movy.sx";
const API = "https://api.wecollege.net";
const SUBS_API = "https://subtitles.vidy.st/search";

const API_HEADERS = {
  "User-Agent": BROWSER_UA,
  Origin: SITE,
  Referer: SITE + "/",
};

const STREAM_HEADERS = {
  "User-Agent": MEDIA_UA,
  Referer: SITE + "/",
  Origin: SITE,
};

const PRIMARY_SERVERS = ["miami", "boise"];
const SECONDARY_SERVERS = ["atlanta", "phoenix", "dallas"];

const QUALITY_ORDER = {
  "4K": 6,
  "1440p": 5,
  "1080p": 4,
  "720p": 3,
  "480p": 2,
  "360p": 1,
  Auto: 0,
  Unknown: -1,
};

/* ---------- Pure ECMAScript mvm1 Decryption (QuickJS / Hermes Safe) ---------- */

const MAGIC = [109, 118, 109, 49]; // "mvm1"
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function mix(e) {
  e = e >>> 0;
  e ^= e >>> 16;
  e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 0xc2b2ae35) >>> 0;
  return (e ^ (e >>> 16)) >>> 0;
}

function rotl(e, a) {
  e = e >>> 0;
  a &= 31;
  return a === 0 ? e : ((e << a) | (e >>> (32 - a))) >>> 0;
}

function b64decode(str) {
  str = String(str || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    buf = (buf << 6) | B64_CHARS.indexOf(str.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
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
    if (c < 0x80) {
      cp = c;
    } else if (c < 0xe0) {
      cp = ((c & 31) << 6) | (bytes[i++] & 63);
    } else if (c < 0xf0) {
      cp = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    } else {
      cp =
        ((c & 7) << 18) |
        ((bytes[i++] & 63) << 12) |
        ((bytes[i++] & 63) << 6) |
        (bytes[i++] & 63);
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else {
      s += String.fromCharCode(cp);
    }
  }
  return s;
}

function initState(seed, mediaId) {
  let fnv = 0x811c9dc5;
  for (let t = 0; t < seed.length; t++) {
    fnv = Math.imul(fnv ^ seed.charCodeAt(t), 0x1000193) >>> 0;
  }
  const S = new Uint32Array(61);
  const used = new Uint8Array(61);
  let n = mix((mix(fnv) ^ mix(((Number(mediaId) >>> 0) ^ 0x9e3779b9) >>> 0)) >>> 0) >>> 0;
  for (let e = 0; e < 8; e++) {
    const a = n % 61;
    n = rotl((n + 0x9e3779b9) >>> 0, 7 + (7 & e));
    S[a] = (n ^ mix(n)) >>> 0;
    used[a] = 1;
    n = mix((n + a) >>> 0);
  }
  return { S: S, used: used, acc: mix(0xa5a5a5a5 ^ n) >>> 0 };
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
    const cc = Math.imul(0x9e3779b9, counter + 1) >>> 0;
    const nn = (r ^ cc) >>> 0;
    let b = (((acc ^ nn) >>> 0) | ((acc & nn & negIn) >>> 0)) >>> 0;
    b = (rotl((b + acc) >>> 0, 31 & dd) ^ rotl(acc, 31 & Math.imul(dd, 7))) >>> 0;
    acc = mix((b + 0x9e3779b9) >>> 0);
    S[dd] = acc >>> 0;
    used[dd] = 1;
    const word = acc >>> 0;
    counter++;
    out[e++] = 255 & word;
    if (e < len) out[e++] = (word >>> 8) & 255;
    if (e < len) out[e++] = (word >>> 16) & 255;
    if (e < len) out[e++] = (word >>> 24) & 255;
  }
  return out;
}

function decryptSources(payloadText, seed, mediaId) {
  const cleanText = String(payloadText || "").replace(/^\s*"|"\s*$/g, "").trim();
  const data = b64decode(cleanText);
  const ks = keystream(seed, Number(mediaId), data.length);
  for (let j = 0; j < data.length; j++) data[j] ^= ks[j];
  for (let j = 0; j < MAGIC.length; j++) {
    if (data[j] !== MAGIC[j]) throw new Error("mvm1 magic mismatch");
  }
  return utf8decode(data.subarray(MAGIC.length));
}

/* ---------- Network helpers ---------- */

function timeout(promise, ms = 3500) {
  if (typeof setTimeout !== "function") return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timeout " + ms + "ms")), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (typeof clearTimeout === "function") clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

function buildQuery(params) {
  const parts = [];
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== "") {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    }
  }
  return parts.join("&");
}

const seedCache = new Map();

async function getSeed(mediaId) {
  const hit = seedCache.get(mediaId);
  if (hit && hit.expiresAt - 5000 > Date.now()) return hit.seed;
  const res = await timeout(
    fetch(API + "/seed?mediaId=" + encodeURIComponent(mediaId), {
      headers: API_HEADERS,
    }),
    3500
  );
  if (!res.ok) throw new Error("seed HTTP " + res.status);
  const data = await res.json();
  seedCache.set(mediaId, {
    seed: data.seed,
    expiresAt: Date.now() + (data.ttlMs || 30000),
  });
  return data.seed;
}

async function fetchServerSources(server, params, mediaId) {
  const attempt = async () => {
    const seed = await getSeed(mediaId);
    const queryParams = Object.assign({}, params, {
      enc: "2",
      seed: seed,
    });
    const url = API + "/" + server + "/sources?" + buildQuery(queryParams);
    const res = await timeout(
      fetch(url, {
        headers: API_HEADERS,
      }),
      3500
    );
    if (!res.ok) throw new Error("sources HTTP " + res.status);
    const text = await res.text();
    const decrypted = decryptSources(text, seed, mediaId);
    return JSON.parse(decrypted);
  };
  try {
    return await attempt();
  } catch (e) {
    if (String(e.message || "").includes("401")) {
      seedCache.delete(mediaId);
      return await attempt();
    }
    throw e;
  }
}

async function fetchDetailParams(tmdbId, mediaType) {
  try {
    const res = await timeout(
      fetch(SITE + "/" + mediaType + "/" + tmdbId, {
        headers: { "User-Agent": BROWSER_UA },
      }),
      3000
    );
    if (!res.ok) return {};
    const html = await res.text();
    const m = html.match(/__NEXT_DATA__[^>]*>(.*?)<\/script>/s);
    if (!m) return {};
    const details = JSON.parse(m[1]).props.pageProps.details || {};
    return {
      title: details.title ? encodeURIComponent(details.title) : undefined,
      year: details.year,
      imdbId: details.imdbId,
      totalSeasons: Array.isArray(details.seasons)
        ? details.seasons.length
        : undefined,
    };
  } catch (e) {
    return {};
  }
}

async function fetchSubtitles(tmdbId, mediaType, season, episode) {
  try {
    let url = SUBS_API + "?id=" + encodeURIComponent(tmdbId);
    if (mediaType === "tv") {
      url += "&season=" + (season || 1) + "&episode=" + (episode || 1);
    }
    const res = await timeout(
      fetch(url, { headers: { "User-Agent": BROWSER_UA } }),
      3000
    );
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || !item.url) continue;
      const lang = item.language || "und";
      if (seen.has(lang)) continue;
      seen.add(lang);
      out.push({
        url: item.url,
        language: lang,
        name: item.display || lang,
        headers: STREAM_HEADERS,
      });
      if (out.length >= 20) break;
    }
    out.sort((a, b) => (a.language === "en" ? -1 : b.language === "en" ? 1 : 0));
    return out;
  } catch (e) {
    return [];
  }
}

function qualityLabel(raw) {
  const s = String(raw || "");
  const m = s.match(/(\d{3,4})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 2160) return "4K";
    if (n >= 1440) return "1440p";
    if (n >= 1080) return "1080p";
    if (n >= 720) return "720p";
    if (n >= 480) return "480p";
    if (n >= 360) return "360p";
    return n + "p";
  }
  if (/4k|uhd/i.test(s)) return "4K";
  return "Unknown";
}

function serverTitle(server) {
  return server.charAt(0).toUpperCase() + server.slice(1);
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (!tmdbId) return [];
    const cleanId = String(tmdbId).trim();
    if (!cleanId) return [];

    const type = mediaType === "tv" ? "tv" : "movie";
    const s = type === "tv" ? Math.max(1, parseInt(season, 10) || 1) : null;
    const ep = type === "tv" ? Math.max(1, parseInt(episode, 10) || 1) : null;

    // 1. Kick off seed, subtitle search, and detail page in parallel
    const seedPromise = getSeed(cleanId);
    const detailPromise = fetchDetailParams(cleanId, type);

    // 2. Query primary servers (Miami & Boise) as soon as seed is ready
    let seed;
    try {
      seed = await timeout(seedPromise, 3500);
    } catch (e) {
      return [];
    }
    if (!seed) return [];

    const baseParams = {
      mediaType: type,
      tmdbId: Number(cleanId),
      seasonId: type === "tv" ? s : undefined,
      episodeId: type === "tv" ? ep : undefined,
    };

    const primaryResults = await Promise.allSettled(
      PRIMARY_SERVERS.map((srv) => fetchServerSources(srv, baseParams, cleanId))
    );

    const streams = [];
    const seenUrls = new Set();
    let payloadSubs = [];

    function collectSources(data, server) {
      if (!data) return;
      if (Array.isArray(data.subtitles) && data.subtitles.length && !payloadSubs.length) {
        payloadSubs = data.subtitles
          .filter((sub) => sub && (sub.url || sub.file))
          .map((sub) => ({
            url: sub.url || sub.file,
            language: sub.language || sub.lang || "und",
            name: sub.display || sub.label || sub.language || "Subtitle",
            headers: STREAM_HEADERS,
          }));
      }

      // Add adaptive master playlist if available
      if (data.playlist && !seenUrls.has(data.playlist)) {
        seenUrls.add(data.playlist);
        streams.push({
          name: "Movy " + serverTitle(server) + " - Auto (Master)",
          title:
            (type === "tv"
              ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0")
              : "Movie") + " - Auto (up to 4K) HLS",
          url: data.playlist,
          quality: "Auto",
          headers: STREAM_HEADERS,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: STREAM_HEADERS,
            },
          },
          subtitles: [],
        });
      }

      // Add individual qualities
      const sources = Array.isArray(data.sources) ? data.sources : [];
      for (const src of sources) {
        if (!src || !src.url || seenUrls.has(src.url)) continue;
        const isLangLabel = !/\d/.test(String(src.quality || ""));
        const q = isLangLabel ? "Unknown" : qualityLabel(src.quality);
        seenUrls.add(src.url);
        streams.push({
          name: "Movy " + serverTitle(server) + " - " + q,
          title:
            (type === "tv"
              ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0")
              : "Movie") +
            " - " +
            q +
            (isLangLabel ? " (" + String(src.quality) + ")" : "") +
            " HLS",
          url: src.url,
          quality: q,
          headers: STREAM_HEADERS,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: STREAM_HEADERS,
            },
          },
          subtitles: [],
        });
      }
    }

    for (let i = 0; i < PRIMARY_SERVERS.length; i++) {
      const res = primaryResults[i];
      if (res.status === "fulfilled" && res.value) {
        collectSources(res.value, PRIMARY_SERVERS[i]);
      }
    }

    // 3. Fallback to secondary servers if primary returned nothing
    if (!streams.length) {
      const detail = (await timeout(detailPromise, 2500).catch(() => ({}))) || {};
      const detailParams = Object.assign({}, baseParams, {
        title: detail.title,
        year: detail.year,
        imdbId: detail.imdbId,
        totalSeasons: detail.totalSeasons,
      });

      const secondaryResults = await Promise.allSettled(
        SECONDARY_SERVERS.map((srv) => fetchServerSources(srv, detailParams, cleanId))
      );
      for (let i = 0; i < SECONDARY_SERVERS.length; i++) {
        const res = secondaryResults[i];
        if (res.status === "fulfilled" && res.value) {
          collectSources(res.value, SECONDARY_SERVERS[i]);
        }
      }
    }

    if (!streams.length) return [];

    // 4. Attach subtitles: prioritize embedded payload subtitles
    let subs = payloadSubs;
    if (!subs.length) {
      subs = await timeout(fetchSubtitles(cleanId, type, s, ep), 2500).catch(() => []);
    }
    for (const st of streams) st.subtitles = subs || [];

    streams.sort(
      (a, b) => (QUALITY_ORDER[b.quality] || -2) - (QUALITY_ORDER[a.quality] || -2)
    );
    return streams;
  } catch (e) {
    console.error("[Movy] " + (e && e.message ? e.message : e));
    return [];
  }
}

module.exports = { getStreams };
