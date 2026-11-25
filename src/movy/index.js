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
// Miami + Boise first (the site marks them "May have 4K"), then the rest through a sliding window of
// 3: a server that fails frees its slot for the next one at once, so a slow failure (Vegas took
// 4.8 s live) no longer holds back a working server (Reno). Launching stops at the first server with
// sources; servers already running get a short grace to add theirs. Worst case 13 requests, one
// attempt each (site: retry 0).
const PRIMARY_SERVERS = ORIGINAL_AUDIO_SERVERS.slice(0, 2);
const FALLBACK_SERVERS = ORIGINAL_AUDIO_SERVERS.slice(2);
const FALLBACK_CONCURRENCY = 3;
const FOUND_GRACE_MS = 300;
const MASTER_PEEK_MS = 1500;
// Whole-lookup budget, under the router's 9 s per-provider deadline.
const LOOKUP_BUDGET_MS = 8000;
const REQUEST_TIMEOUT_MS = 3500;
const MIN_BATCH_MS = 300;
const DETAIL_WAIT_MS = 1500;

const { decryptSources } = require("./mvm1-byte-codecs");
const { sortByQuality, withTimeout, TtlCache } = require("../shared/provider-utils");
const { parseMasterPlaylist } = require("../shared/hls-master-playlist-parser");

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

// Sliding window of FALLBACK_CONCURRENCY over `servers` in order (see FALLBACK_* above).
// Results that arrive after the walk finished are ignored.
function walkFallback(servers, ask, o) {
  return new Promise((resolve) => {
    let next = 0;
    let active = 0;
    let done = false;
    let grace = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (grace) clearTimeout(grace);
      resolve();
    };
    const stopLaunching = () => o.hasStreams() || o.state.rateLimited;
    const launch = () => {
      while (!done && !stopLaunching() && active < FALLBACK_CONCURRENCY && next < servers.length) {
        const remaining = o.left();
        if (remaining < MIN_BATCH_MS) {
          o.state.sawTimeout = true;
          break;
        }
        const srv = servers[next++];
        active++;
        ask(srv, Math.min(o.requestTimeoutMs, remaining))
          .then(
            (data) => {
              if (done || !data) return;
              const had = o.hasStreams();
              o.collect(data, srv);
              if (!had && o.hasStreams()) grace = setTimeout(finish, FOUND_GRACE_MS);
            },
            (err) => {
              if (!done) o.noteFailure(err);
            }
          )
          .then(() => {
            active--;
            if (done) return;
            if (o.state.rateLimited) return finish();
            if (!o.hasStreams()) launch();
            if (active === 0) finish();
          });
      }
      if (active === 0) finish();
    };
    launch();
  });
}

// Relabels an "Auto" row from its master playlist (one bounded request to the media CDN).
async function labelAutoRow(row, timeoutMs) {
  try {
    const res = await timeout(fetch(row.url, { headers: STREAM_HEADERS }), timeoutMs);
    if (!res.ok) return;
    const variants = parseMasterPlaylist(await res.text(), row.url).filter((v) => v.height);
    if (!variants.length) return;
    const top = qualityLabel(String(Math.max.apply(null, variants.map((v) => v.height))));
    const prefix = row.title.replace(/ - Auto( \(.*\))? HLS$/, "");
    if (variants.length === 1) {
      row.quality = top;
      row.name = row.name.replace(/ - Auto$/, " - " + top);
      row.title = prefix + " - " + top + " HLS";
    } else {
      row.title = prefix + " - Auto (up to " + top + ") HLS";
    }
  } catch (_) {
    // unreadable master: keep "Auto"
  }
}

async function getStreams(tmdbId, mediaType, season, episode, opts) {
  try {
    if (!tmdbId) return [];
    const cleanId = String(tmdbId).trim();
    if (!/^\\d+$/.test(cleanId)) return [];

    const type = mediaType === "tv" ? "tv" : "movie";
    const s = type === "tv" ? Math.max(1, parseInt(season, 10) || 1) : null;
    const ep = type === "tv" ? Math.max(1, parseInt(episode, 10) || 1) : null;
    const requestTimeoutMs = (opts && opts.requestTimeoutMs) || REQUEST_TIMEOUT_MS;

    // Match EasyProxy's Movy extractor: request the per-title seed, then
    // decrypt the Miami /sources response and use its ready-to-play playlist.
    const seedRes = await timeout(
      fetch(API + "/seed?mediaId=" + encodeURIComponent(cleanId), { headers: API_HEADERS }),
      requestTimeoutMs
    );
    if (!seedRes.ok) throw httpError("seed", seedRes.status);
    const seedData = await seedRes.json();
    if (!seedData || !seedData.seed) return [];

    const params = {
      mediaType: type,
      tmdbId: Number(cleanId),
      enc: 2,
      seed: seedData.seed,
    };
    if (type === "tv") {
      params.seasonId = s;
      params.episodeId = ep;
    }
    const sourcesRes = await timeout(
      fetch(API + "/miami/sources?" + buildQuery(params), { headers: API_HEADERS }),
      requestTimeoutMs
    );
    if (!sourcesRes.ok) throw httpError("sources", sourcesRes.status);
    const payload = JSON.parse(decryptSources(await sourcesRes.text(), seedData.seed, cleanId));
    const playlist = String(payload && payload.playlist || "").trim();
    if (!/^https:\\/\\//i.test(playlist)) return [];

    const subtitles = Array.isArray(payload.subtitles)
      ? payload.subtitles.filter((sub) => sub && (sub.url || sub.file)).slice(0, 80).map((sub) => ({
          url: sub.url || sub.file,
          language: sub.language || sub.lang || "und",
          name: sub.display || sub.label || sub.language || "Subtitle",
          headers: STREAM_HEADERS,
        }))
      : [];

    return [{
      name: "Movy - HLS",
      title: type === "tv"
        ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0") + " - HLS"
        : "Movie - HLS",
      url: playlist,
      quality: "Auto",
      headers: STREAM_HEADERS,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: STREAM_HEADERS },
      },
      subtitles,
    }];
  } catch (e) {
    console.error("[Movy] " + (e && e.message ? e.message : e));
    return [];
  }
}

module.exports = { getStreams, fetchSubtitles };
