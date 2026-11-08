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

async function getSeed(mediaId) {
  const hit = seedCache.get(mediaId);
  if (hit) return hit;
  const res = await timeout(
    fetch(API + "/seed?mediaId=" + encodeURIComponent(mediaId), {
      headers: API_HEADERS,
    }),
    3500
  );
  if (!res.ok) throw new Error("seed HTTP " + res.status);
  const data = await res.json();
  // Refresh 5 s before the server-side expiry, as before.
  seedCache.set(mediaId, data.seed, Math.max(1000, (data.ttlMs || 30000) - 5000));
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
    const cacheKey = type + ":" + cleanId + ":" + s + ":" + ep;

    // Fast-path: O(1) cache hit (an empty array is a remembered miss)
    const cached = streamCache.get(cacheKey);
    if (cached) return cached;

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

    let sawTimeout = primaryResults.some(isTimeout);
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
      sawTimeout = sawTimeout || secondaryResults.some(isTimeout);
      for (let i = 0; i < SECONDARY_SERVERS.length; i++) {
        const res = secondaryResults[i];
        if (res.status === "fulfilled" && res.value) {
          collectSources(res.value, SECONDARY_SERVERS[i]);
        }
      }
    }

    if (!streams.length) {
      streamCache.set(cacheKey, [], sawTimeout ? UNCERTAIN_EMPTY_TTL_MS : EMPTY_TTL_MS);
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
