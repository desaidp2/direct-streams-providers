/**
 * Movy provider for Nuvio.
 *
 * movy.sx is a TMDB-keyed front end (/movie/{tmdbId}, /tv/{tmdbId})
 * over the wecollege stream API (api.wecollege.net). Its server
 * list (Miami, Boise, Atlanta, ...) is a set of endpoints
 *   GET /{server}/sources?{title,mediaType,year,seasonId,episodeId,
 *                          tmdbId,imdbId, enc:"2", seed}
 * whose responses are encrypted with a custom scheme:
 *   1. GET /seed?mediaId={tmdbId}            -> {seed, ttlMs}
 *   2. The sources response is base64url text; the plaintext is
 *      "mvm1" || JSON, XORed with a keystream derived from the
 *      seed + mediaId by a small custom PRNG (SHA-256 K-table
 *      constants, murmur-style finalizer, FNV-1a seed hash).
 *
 * Performance on QuickJS (Android TV):
 *   - Fast parallel quorum: Miami & Boise are queried concurrently
 *     as soon as seed is ready (< 1s resolution).
 *   - Tight per-request timeouts (3500ms) prevent hanging on dead upstreams.
 *   - behaviorHints.proxyHeaders.request passes Referer + Origin headers
 *     to prevent HTTP 403 Forbidden from media CDNs.
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

// Fast servers: Miami & Boise answer directly from tmdbId without title search.
// Atlanta, Phoenix, Dallas serve as secondary fallback.
// Omitted: Seattle (Cloudflare challenge), Vegas (11s+ hang), Portland/Chicago/Reno/Oakland (persistent 500s).
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

/* ---------- mvm1 decryption ---------- */

const MAGIC = [109, 118, 109, 49]; // "mvm1"

function fin(e) {
  e >>>= 0;
  e ^= e >>> 16;
  e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 0xc2b2ae35) >>> 0;
  e ^= e >>> 16;
  return e >>> 0;
}

function rot(e, a) {
  e >>>= 0;
  a &= 31;
  if (a === 0) return e >>> 0;
  return ((e << a) | (e >>> (32 - a))) >>> 0;
}

function fnv(str) {
  let a = 0x811c9dc5;
  for (let t = 0; t < str.length; t++)
    a = Math.imul(a ^ str.charCodeAt(t), 0x1000193) >>> 0;
  return fin(a);
}

function makeState(seed, mediaId) {
  const S = Array(61);
  let s = fin(fnv(seed) ^ fin((mediaId >>> 0) ^ 0x9e3779b9)) >>> 0;
  for (let e = 0; e < 8; e++) {
    const a = s % 61;
    s = rot((s + 0x9e3779b9) >>> 0, 7 + (7 & e));
    S[a] = (s ^ fin(s)) >>> 0;
    s = fin((s + a) >>> 0);
  }
  return { S: S, acc: fin(0xa5a5a5a5 ^ s) >>> 0 };
}

function keystream(seed, mediaId, len) {
  const state = makeState(seed, mediaId);
  const S = state.S;
  let acc = state.acc;
  const out = new Uint8Array(len);
  let counter = 0;
  for (let e = 0; e < len; ) {
    const dd = acc % 61;
    const negIn = 0 - Number(dd in S);
    const r = S[dd] >>> 0;
    const cc = Math.imul(0x9e3779b9, counter + 1) >>> 0;
    const nn = (r ^ cc) >>> 0;
    let b = ((acc ^ nn) >>> 0) | ((acc & nn & negIn) >>> 0);
    b = (rot((b + acc) >>> 0, 31 & dd) ^ rot(acc, 31 & Math.imul(dd, 7))) >>> 0;
    acc = fin((b + 0x9e3779b9) >>> 0);
    S[dd] = acc >>> 0;
    const word = acc >>> 0;
    counter++;
    out[e++] = 255 & word;
    if (e < len) out[e++] = (word >>> 8) & 255;
    if (e < len) out[e++] = (word >>> 16) & 255;
    if (e < len) out[e++] = (word >>> 24) & 255;
  }
  return out;
}

function b64urlDecode(text) {
  const a = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(4 * Math.ceil(text.length / 4), "=");
  if (typeof atob === "function") {
    const bin = atob(a);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(a, "base64"));
}

function decryptSources(payloadText, seed, mediaId) {
  const payload = b64urlDecode(payloadText.trim());
  const ks = keystream(seed, Number(mediaId), payload.length);
  const out = new Uint8Array(payload.length);
  for (let e = 0; e < payload.length; e++) out[e] = payload[e] ^ ks[e];
  for (let e = 0; e < MAGIC.length; e++) {
    if (out[e] !== MAGIC[e]) throw new Error("mvm1 decrypt failed");
  }
  const body = out.subarray(MAGIC.length);
  if (typeof TextDecoder !== "undefined")
    return new TextDecoder("utf-8").decode(body);
  return Buffer.from(body).toString("utf8");
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

const seedCache = new Map();

async function getSeed(mediaId) {
  const hit = seedCache.get(mediaId);
  if (hit && hit.expiresAt - 5000 > Date.now()) return hit.seed;
  const res = await timeout(
    fetch(API + "/seed?mediaId=" + mediaId, {
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
    const qs = new URLSearchParams();
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    qs.set("enc", "2");
    qs.set("seed", seed);
    const res = await timeout(
      fetch(API + "/" + server + "/sources?" + qs.toString(), {
        headers: API_HEADERS,
      }),
      3500
    );
    if (!res.ok) throw new Error("sources HTTP " + res.status);
    const text = await res.text();
    return JSON.parse(decryptSources(text, seed, mediaId));
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
    let url = SUBS_API + "?id=" + tmdbId;
    if (mediaType === "tv")
      url += "&season=" + (season || 1) + "&episode=" + (episode || 1);
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
        headers: { "User-Agent": MEDIA_UA },
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
    const subsPromise = fetchSubtitles(cleanId, type, s, ep);
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

    const streamHeaders = {
      "User-Agent": MEDIA_UA,
      Referer: SITE + "/",
      Origin: SITE,
    };

    function collectSources(data, server) {
      if (!data) return;
      if (Array.isArray(data.subtitles) && data.subtitles.length && !payloadSubs.length) {
        payloadSubs = data.subtitles
          .filter((sub) => sub && (sub.url || sub.file))
          .map((sub) => ({
            url: sub.url || sub.file,
            language: sub.language || sub.lang || "und",
            name: sub.display || sub.label || sub.language || "Subtitle",
            headers: streamHeaders,
          }));
      }
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
          headers: streamHeaders,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: streamHeaders,
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

    const subs = payloadSubs.length
      ? payloadSubs
      : await timeout(subsPromise, 2000).catch(() => []);
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
