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

async function getStreams(tmdbId, mediaType, season, episode) {
  const id = String(tmdbId || "").trim();
  if (!/^\d+$/.test(id)) return [];
  const type = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
  const s = Math.max(1, parseInt(season, 10) || 1);
  const ep = Math.max(1, parseInt(episode, 10) || 1);

  try {
    // Current EasyProxy extractor flow: fetch a short-lived per-title seed,
    // then request the encrypted Miami source payload using that seed.
    const seedText = await fetchText(API + "/seed?mediaId=" + encodeURIComponent(id));
    const seedData = JSON.parse(seedText);
    const seed = String(seedData.seed || "");
    if (!seed) throw new Error("Movy seed missing");

    const params = new URLSearchParams({
      mediaType: type,
      tmdbId: id,
    });
    if (type === "tv") {
      params.set("seasonId", String(s));
      params.set("episodeId", String(ep));
    }
    params.set("enc", "2");
    params.set("seed", seed);

    const encrypted = await fetchText(API + "/miami/sources?" + params.toString());
    const payload = JSON.parse(decryptSources(encrypted, seed, id));
    const playlist = String(payload.playlist || "").trim();
    if (!/^https:\/\//i.test(playlist)) throw new Error("Movy returned no playable HLS playlist");

    const subtitles = cleanSubtitles(payload.subtitles);
    console.info("[Movy] Resolved " + type + ":" + id + " via current EasyProxy API flow");
    return [{
      name: "Movy - Miami",
      title: (type === "tv" ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0") : "Movie") + " - Auto HLS",
      quality: "Auto",
      url: playlist,
      headers: STREAM_HEADERS,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: STREAM_HEADERS } },
      subtitles,
    }];
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
