/**
 * Movy provider for Nuvio.
 *
 * movy.sx is a TMDB-keyed front end (/movie/{tmdbId}, /tv/{tmdbId})
 * over the wecollege stream API (api.wecollege.net). Its server
 * list (Miami, Boise, Seattle, ...) is a set of endpoints
 *   GET /{server}/sources?{title,mediaType,year,seasonId,episodeId,
 *                          tmdbId,imdbId, enc:"2", seed}
 * whose responses are encrypted with a custom scheme:
 *   1. GET /seed?mediaId={tmdbId}            -> {seed, ttlMs}
 *   2. The sources response is base64url text; the plaintext is
 *      "mvm1" || JSON, XORed with a keystream derived from the
 *      seed + mediaId by a small custom PRNG (SHA-256 K-table
 *      constants, murmur-style finalizer, FNV-1a seed hash).
 * This provider reimplements that scheme (recovered from the
 * site's own JS bundle) and returns the direct HLS sources,
 * which run up to 2160p/4K — above the 7Movies provider's 1080p
 * MP4 ceiling. Subtitles come from the sources payloads plus the
 * subtitles.vidy.st search the site itself uses.
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

// Servers tried in order. Miami/Boise answer from the TMDB id
// alone; the rest search by title and need the detail-page params.
const SERVERS = [
  "miami",
  "boise",
  "seattle",
  "atlanta",
  "phoenix",
  "portland",
  "chicago",
  "nashville",
  "vegas",
  "reno",
  "oakland",
  "dallas",
  "paris",
  "cancun",
];

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

/* ---------- mvm1 decryption (ported from the site's bundle) ---------- */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
];
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

/* ---------- API plumbing ---------- */

const seedCache = new Map(); // mediaId -> {seed, expiresAt}

async function getSeed(mediaId) {
  const hit = seedCache.get(mediaId);
  if (hit && hit.expiresAt - 5000 > Date.now()) return hit.seed;
  const res = await fetch(API + "/seed?mediaId=" + mediaId, {
    headers: API_HEADERS,
  });
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
    const res = await fetch(API + "/" + server + "/sources?" + qs.toString(), {
      headers: API_HEADERS,
    });
    if (!res.ok) throw new Error("sources HTTP " + res.status);
    const text = await res.text();
    return JSON.parse(decryptSources(text, seed, mediaId));
  };
  try {
    return await attempt();
  } catch (e) {
    // The app drops the cached seed and retries once on a 401.
    if (String(e.message || "").includes("401")) {
      seedCache.delete(mediaId);
      return await attempt();
    }
    throw e;
  }
}

// Title/year/imdb come from the site's own detail page (SSR JSON),
// exactly the params the web app passes to the sources API.
async function fetchDetailParams(tmdbId, mediaType) {
  try {
    const res = await fetch(SITE + "/" + mediaType + "/" + tmdbId, {
      headers: { "User-Agent": BROWSER_UA },
    });
    if (!res.ok) return {};
    const html = await res.text();
    const m = html.match(/__NEXT_DATA__[^>]*>(.*?)<\/script>/s);
    if (!m) return {};
    const details =
      JSON.parse(m[1]).props.pageProps.details || {};
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
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
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
        headers: { "User-Agent": BROWSER_UA },
      });
      if (out.length >= 20) break;
    }
    // English first, the rest as returned.
    out.sort((a, b) =>
      a.language === "en" ? -1 : b.language === "en" ? 1 : 0
    );
    return out;
  } catch (e) {
    return [];
  }
}

/* ---------- stream shaping ---------- */

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
    const type = mediaType === "tv" ? "tv" : "movie";
    const detail = await fetchDetailParams(tmdbId, type);
    const detailOk = Boolean(detail.title);
    const params = {
      title: detail.title,
      mediaType: type,
      year: detail.year,
      totalSeasons: detail.totalSeasons,
      seasonId: type === "tv" ? season || 1 : undefined,
      episodeId: type === "tv" ? episode || 1 : undefined,
      tmdbId: Number(tmdbId),
      imdbId: detail.imdbId,
    };

    const subsPromise = fetchSubtitles(tmdbId, type, season, episode);

    const streams = [];
    const seenUrls = new Set();
    let payloadSubs = [];

    for (const server of SERVERS) {
      let data;
      try {
        data = await fetchServerSources(server, params, tmdbId);
      } catch (e) {
        continue;
      }
      if (!data) continue;
      if (Array.isArray(data.subtitles) && data.subtitles.length && !payloadSubs.length) {
        payloadSubs = data.subtitles
          .filter((s) => s && (s.url || s.file))
          .map((s) => ({
            url: s.url || s.file,
            language: s.language || s.lang || "und",
            name: s.display || s.label || s.language || "Subtitle",
            headers: { "User-Agent": BROWSER_UA },
          }));
      }
      const sources = Array.isArray(data.sources) ? data.sources : [];
      for (const src of sources) {
        if (!src || !src.url || seenUrls.has(src.url)) continue;
        // Some servers label the quality slot with a language name
        // ("English", "Hindi"); those entries are dubs — keep them
        // but label honestly instead of faking a resolution.
        const isLangLabel = !/\d/.test(String(src.quality || ""));
        const q = isLangLabel ? "Unknown" : qualityLabel(src.quality);
        seenUrls.add(src.url);
        streams.push({
          name: "Movy " + serverTitle(server) + " - " + q,
          title:
            (type === "tv"
              ? "S" +
                String(season || 1).padStart(2, "0") +
                "E" +
                String(episode || 1).padStart(2, "0")
              : "Movie") +
            " - " +
            q +
            (isLangLabel ? " (" + String(src.quality) + ")" : "") +
            " HLS",
          url: src.url,
          quality: q,
          headers: { "User-Agent": MEDIA_UA },
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: { "User-Agent": MEDIA_UA },
            },
          },
          subtitles: [],
        });
      }
      // Two productive servers is plenty of choice; stop early.
      if (streams.length >= 8) break;
      // Miami/Boise answer from the TMDB id alone. If both are dry
      // and the detail page didn't resolve either, the title almost
      // certainly doesn't exist — don't sweep the title-search
      // servers for the full timeout.
      if (!detailOk && !streams.length && server === "boise") break;
    }

    if (!streams.length) return [];

    const subs = payloadSubs.length ? payloadSubs : await subsPromise;
    for (const s of streams) s.subtitles = subs;

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
