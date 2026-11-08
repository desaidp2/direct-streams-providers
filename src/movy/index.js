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

// movy.sx's original-audio servers in the site's own order (player script, 2026-11-08). The site
// also lists dubbed servers (munich, berlin: German; paris: French; delhi: Hindi; cancun: Spanish)
// and anikoto (anime); those are deliberately not asked.
const ORIGINAL_AUDIO_SERVERS = [
  "miami", "boise", "nashville", "chicago", "vegas", "reno", "oakland",
  "seattle", "phoenix", "atlanta", "portland", "austin", "dallas",
];
// Miami + Boise first (the site marks them "May have 4K"), then the rest in batches of 3, stopping
// after the first batch that has sources. Worst case 13 requests, one attempt each (site: retry 0).
const FALLBACK_BATCH = 3;
const SERVER_BATCHES = [ORIGINAL_AUDIO_SERVERS.slice(0, 2)];
for (let i = 2; i < ORIGINAL_AUDIO_SERVERS.length; i += FALLBACK_BATCH) {
  SERVER_BATCHES.push(ORIGINAL_AUDIO_SERVERS.slice(i, i + FALLBACK_BATCH));
}
// Whole-lookup budget, under the router's 9 s per-provider deadline.
const LOOKUP_BUDGET_MS = 8000;
const REQUEST_TIMEOUT_MS = 3500;
const MIN_BATCH_MS = 300;
const DETAIL_WAIT_MS = 1500;

const { decryptSources } = require("./mvm1-byte-codecs");
const { sortByQuality, withTimeout, TtlCache } = require("../shared/provider-utils");

/* ---------- Network helpers ---------- */

function timeout(promise, ms = 3500) {
  return withTimeout(promise, ms, "Movy timeout");
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

// Bounded LRU caches (the old seed Map grew by one entry per title, forever).
const MAX_CACHE_SIZE = 100;
const seedCache = new TtlCache(MAX_CACHE_SIZE, 30000);
// Stream URLs are signed for hours (s=s1.<expiry>), so 10 minutes is well inside the window.
const STREAM_TTL_MS = 10 * 60 * 1000;
// A title with no sources on any server is remembered briefly (it costs ~4 s to re-check).
// If a server timed out (phoenix often answers in >5 s) the miss is less certain: keep it
// only long enough to absorb a player's immediate retries.
const EMPTY_TTL_MS = 2 * 60 * 1000;
const UNCERTAIN_EMPTY_TTL_MS = 30 * 1000;
const streamCache = new TtlCache(MAX_CACHE_SIZE, STREAM_TTL_MS);

function isTimeout(result) {
  return result.status === "rejected" && /timeout/i.test(String((result.reason && result.reason.message) || ""));
}

function httpError(what, status) {
  const err = new Error(what + " HTTP " + status);
  err.status = status;
  return err;
}

// One seed per title, shared by every server request. Concurrent callers share one in-flight
// fetch, so a batch of servers costs a single /seed request.
const seedInflight = new Map();
function getSeed(mediaId, timeoutMs) {
  const hit = seedCache.get(mediaId);
  if (hit) return Promise.resolve(hit);
  let pending = seedInflight.get(mediaId);
  if (!pending) {
    pending = (async () => {
      const res = await timeout(
        fetch(API + "/seed?mediaId=" + encodeURIComponent(mediaId), { headers: API_HEADERS }),
        timeoutMs || REQUEST_TIMEOUT_MS
      );
      if (!res.ok) throw httpError("seed", res.status);
      const data = await res.json();
      // Refresh 5 s before the server-side expiry, as before.
      seedCache.set(mediaId, data.seed, Math.max(1000, (data.ttlMs || 30000) - 5000));
      return data.seed;
    })().finally(() => seedInflight.delete(mediaId));
    seedInflight.set(mediaId, pending);
  }
  return pending;
}

// After a 401: drop the seed only if it is still the stale one, so concurrent 401s from one batch
// trigger a single re-seed (the rest pick up the new seed or join the in-flight fetch).
function reseed(mediaId, staleSeed, timeoutMs) {
  if (seedCache.get(mediaId) === staleSeed) seedCache.delete(mediaId);
  return getSeed(mediaId, timeoutMs);
}

// One attempt per server, like the site (retry 0); a 401 gets one retry with a fresh seed.
async function fetchServerSources(server, params, mediaId, timeoutMs) {
  const attempt = async (seed) => {
    const url = API + "/" + server + "/sources?" + buildQuery(Object.assign({}, params, { enc: "2", seed: seed }));
    const res = await timeout(fetch(url, { headers: API_HEADERS }), timeoutMs);
    if (!res.ok) throw httpError("sources", res.status);
    return JSON.parse(decryptSources(await res.text(), seed, mediaId));
  };
  const seed = await getSeed(mediaId, timeoutMs);
  try {
    return await attempt(seed);
  } catch (e) {
    if (e && e.status === 401) return attempt(await reseed(mediaId, seed, timeoutMs));
    throw e;
  }
}

// The request fields movy.sx sends to every server (player script): title (already
// encodeURIComponent-ed, so it is double-encoded on the wire), mediaType, year, totalSeasons,
// episodeId, seasonId, tmdbId, imdbId. For a movie the site sends season/episode 1 and 0 seasons.
function siteParams(type, tmdbId, detail, season, episode) {
  const isTv = type === "tv";
  return {
    title: detail.title,
    mediaType: type,
    year: detail.year,
    totalSeasons: isTv ? detail.totalSeasons : 0,
    episodeId: isTv ? episode : 1,
    seasonId: isTv ? season : 1,
    tmdbId: Number(tmdbId),
    imdbId: detail.imdbId,
  };
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

// Standard heights keep their label; anything else keeps its own number (Reno serves "900p",
// which used to be rounded down to 720p). The shared ranker places such labels between neighbours.
function qualityLabel(raw) {
  const s = String(raw || "");
  const m = s.match(/(\d{3,4})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 2160) return "4K";
    return n + "p";
  }
  if (/4k|uhd/i.test(s)) return "4K";
  return "Unknown";
}

function serverTitle(server) {
  return server.charAt(0).toUpperCase() + server.slice(1);
}

async function getStreams(tmdbId, mediaType, season, episode, opts) {
  try {
    if (!tmdbId) return [];
    const cleanId = String(tmdbId).trim();
    if (!cleanId) return [];

    const budgetMs = (opts && opts.budgetMs) || LOOKUP_BUDGET_MS;
    const requestTimeoutMs = (opts && opts.requestTimeoutMs) || REQUEST_TIMEOUT_MS;
    const startedAt = Date.now();
    const left = () => budgetMs - (Date.now() - startedAt);

    const type = mediaType === "tv" ? "tv" : "movie";
    const s = type === "tv" ? Math.max(1, parseInt(season, 10) || 1) : null;
    const ep = type === "tv" ? Math.max(1, parseInt(episode, 10) || 1) : null;
    const cacheKey = type + ":" + cleanId + ":" + s + ":" + ep;

    // Fast-path: O(1) cache hit (an empty array is a remembered miss)
    const cached = streamCache.get(cacheKey);
    if (cached) return cached;

    // 1. Seed and detail page in parallel. No seed (e.g. 429 rate limit) -> ask no server at all.
    const detailPromise = fetchDetailParams(cleanId, type);
    try {
      await getSeed(cleanId, Math.min(requestTimeoutMs, left()));
    } catch (e) {
      streamCache.set(cacheKey, [], UNCERTAIN_EMPTY_TTL_MS);
      return [];
    }
    const detail = (await timeout(detailPromise, Math.max(1, Math.min(DETAIL_WAIT_MS, left()))).catch(() => ({}))) || {};
    const params = siteParams(type, cleanId, detail, s, ep);

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

    // 2. Walk the site's servers: Miami + Boise, then batches of 3, until a batch has sources,
    //    the budget runs out, or the API rate-limits us (429 -> stop, do not walk further).
    let sawTimeout = false;
    let rateLimited = false;
    for (const batch of SERVER_BATCHES) {
      const remaining = left();
      if (remaining < MIN_BATCH_MS) {
        sawTimeout = true;
        break;
      }
      const perRequest = Math.min(requestTimeoutMs, remaining);
      const results = await Promise.allSettled(batch.map((srv) => fetchServerSources(srv, params, cleanId, perRequest)));
      for (let i = 0; i < batch.length; i++) {
        const res = results[i];
        if (res.status === "fulfilled" && res.value) collectSources(res.value, batch[i]);
        else if (res.reason && res.reason.status === 429) rateLimited = true;
      }
      if (results.some(isTimeout)) sawTimeout = true;
      if (streams.length || rateLimited) break;
    }

    if (!streams.length) {
      streamCache.set(cacheKey, [], sawTimeout || rateLimited ? UNCERTAIN_EMPTY_TTL_MS : EMPTY_TTL_MS);
      return [];
    }

    // 4. Attach subtitles: prioritize embedded payload subtitles
    let subs = payloadSubs;
    if (!subs.length) {
      subs = await timeout(fetchSubtitles(cleanId, type, s, ep), 2500).catch(() => []);
    }
    for (const st of streams) st.subtitles = subs || [];

    sortByQuality(streams);
    streamCache.set(cacheKey, streams);
    return streams;
  } catch (e) {
    console.error("[Movy] " + (e && e.message ? e.message : e));
    return [];
  }
}

module.exports = { getStreams, fetchSubtitles };
