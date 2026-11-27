/**
 * Movy provider adapted from the current EasyProxy extractors/movy.py flow.
 * Resolves the Movy TMDB API's Miami source payload and decrypts its mvm1 envelope.
 */
"use strict";

const { decryptSources } = require("./mvm1-byte-codecs");

const API = "https://api.wecollege.net";
const SITE = "https://www.movy.sx";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const API_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
  "Origin": SITE,
  "Referer": SITE + "/",
};
const STREAM_HEADERS = {
  "User-Agent": UA,
  "Referer": SITE + "/",
  "Origin": SITE,
};
const REQUEST_TIMEOUT_MS = Number(process.env.MOVY_TIMEOUT_MS || 12000);

async function fetchText(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetch(url, {
    headers: API_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("Movy upstream HTTP " + response.status);
  return response.text();
}

function cleanSubtitles(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const url = String(item.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const language = String(item.language || item.lang || "und").slice(0, 16);
    out.push({
      url,
      language,
      name: String(item.display || item.name || language).slice(0, 80),
      headers: STREAM_HEADERS,
    });
    if (out.length >= 80) break;
  }
  return out;
}

async function fetchDetailParams(tmdbId, mediaType) {
  try {
    const response = await fetch(SITE + "/" + mediaType + "/" + tmdbId, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) return {};
    const html = await response.text();
    const match = html.match(/__NEXT_DATA__[^>]*>(.*?)<\\/script>/s);
    if (!match) return {};
    const details = JSON.parse(match[1]).props?.pageProps?.details || {};
    return {
      title: details.title ? encodeURIComponent(details.title) : undefined,
      year: details.year,
      imdbId: details.imdbId,
      totalSeasons: Array.isArray(details.seasons) ? details.seasons.length : undefined,
    };
  } catch (_) {
    return {};
  }
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  return query.toString();
}

const ORIGINAL_AUDIO_SERVERS = [
  "miami", "boise", "nashville", "chicago", "vegas", "reno", "oakland",
  "seattle", "phoenix", "atlanta", "portland", "austin", "dallas",
];

async function fetchServerSources(server, params, id, seed) {
  const url = API + "/" + server + "/sources?" + buildQuery({ ...params, enc: "2", seed });
  const response = await fetch(url, {
    headers: API_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error("Movy " + server + " sources HTTP " + response.status);
    error.status = response.status;
    throw error;
  }
  return JSON.parse(decryptSources(await response.text(), seed, id));
}

async function getStreams(tmdbId, mediaType, season, episode) {
  const id = String(tmdbId || "").trim();
  if (!/^\\d+$/.test(id)) return [];
  const type = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
  const s = Math.max(1, parseInt(season, 10) || 1);
  const ep = Math.max(1, parseInt(episode, 10) || 1);

  try {
    const [seedResponse, detail] = await Promise.all([
      fetch(API + "/seed?mediaId=" + encodeURIComponent(id), {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      fetchDetailParams(id, type),
    ]);
    if (!seedResponse.ok) throw new Error("Movy seed HTTP " + seedResponse.status);
    const seedData = await seedResponse.json();
    const seed = String(seedData.seed || "");
    if (!seed) throw new Error("Movy seed missing");

    // Match EasyProxy's player request fields and original-audio server ordering.
    const params = {
      title: detail.title,
      mediaType: type,
      year: detail.year,
      totalSeasons: type === "tv" ? detail.totalSeasons : 0,
      episodeId: type === "tv" ? ep : 1,
      seasonId: type === "tv" ? s : 1,
      tmdbId: Number(id),
      imdbId: detail.imdbId,
    };

    const primary = await Promise.allSettled(
      ORIGINAL_AUDIO_SERVERS.slice(0, 2).map(server => fetchServerSources(server, params, id, seed))
    );
    const collected = [];
    const seen = new Set();
    function collect(result, server) {
      if (result.status !== "fulfilled" || !result.value) return;
      const playlist = String(result.value.playlist || "").trim();
      if (!/^https:\\/\\//i.test(playlist) || seen.has(playlist)) return;
      seen.add(playlist);
      collected.push({
        name: "Movy - " + server.charAt(0).toUpperCase() + server.slice(1),
        title: (type === "tv" ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0") : "Movie") + " - Auto HLS",
        quality: "Auto",
        url: playlist,
        headers: STREAM_HEADERS,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: STREAM_HEADERS } },
        subtitles: cleanSubtitles(result.value.subtitles),
      });
    }
    primary.forEach((result, index) => collect(result, ORIGINAL_AUDIO_SERVERS[index]));

    // Ask the remaining original-audio hosts if Miami/Boise did not yield a playlist.
    if (!collected.length) {
      for (const server of ORIGINAL_AUDIO_SERVERS.slice(2)) {
        try {
          const data = await fetchServerSources(server, params, id, seed);
          collect({ status: "fulfilled", value: data }, server);
          if (collected.length) break;
        } catch (err) {
          if (err && err.status === 401) {
            // Seed expired: obtain a fresh one once and retry this host.
            const refresh = await fetch(API + "/seed?mediaId=" + encodeURIComponent(id), {
              headers: API_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (refresh.ok) {
              const freshSeed = String((await refresh.json()).seed || "");
              if (freshSeed) {
                try {
                  const data = await fetchServerSources(server, params, id, freshSeed);
                  collect({ status: "fulfilled", value: data }, server);
                  if (collected.length) break;
                } catch (_) {}
              }
            }
          }
        }
      }
    }
    if (!collected.length) throw new Error("No original-audio Movy server returned a playlist");
    console.info("[Movy] Resolved " + type + ":" + id + " using current EasyProxy source flow");
    return collected;
  } catch (err) {
    console.warn("[Movy] No stream for " + type + ":" + id + ": " + (err && err.message ? err.message : err));
    return [];
  }
}
async function fetchSubtitles(tmdbId, mediaType, season, episode) {
  const streams = await getStreams(tmdbId, mediaType, season, episode);
  return streams.flatMap(stream => stream.subtitles || []);
}

module.exports = { getStreams, fetchSubtitles };
