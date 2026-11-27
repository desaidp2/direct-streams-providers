/**
 * Vidy.st direct-stream provider.
 * Uses Vidy's seed + encrypted sources API, sharing the mvm1 decoder with Movy.
 * Kept isolated from the existing Cinejoy and Movy providers.
 */
"use strict";

const { decryptSources } = require("../movy/mvm1-byte-codecs");

const API = "https://api.wecollege.net";
const SITE = "https://www.vidy.st";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const SERVERS = ["miami", "atlanta", "seattle", "denver", "dallas", "tampa"];
const TIMEOUT_MS = Number(process.env.VIDY_TIMEOUT_MS || 7000);
const HEADERS = {
  "User-Agent": UA,
  "Accept": "*/*",
  "Origin": SITE,
  "Referer": SITE + "/",
};

function validUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

function cleanSubtitles(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((sub) => {
    if (!sub || typeof sub !== "object") return [];
    const url = validUrl(sub.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const language = String(sub.language || sub.lang || "und").slice(0, 16);
    return [{ url, language, name: String(sub.name || sub.display || language).slice(0, 80), headers: HEADERS }];
  }).slice(0, 80);
}

async function fetchJson(url) {
  return fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function getStreams(tmdbId, mediaType, season, episode) {
  const id = String(tmdbId || "").trim();
  if (!/^\d+$/.test(id)) return [];
  const type = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
  const s = Math.max(1, parseInt(season, 10) || 1);
  const ep = Math.max(1, parseInt(episode, 10) || 1);

  try {
    const seedResponse = await fetchJson(API + "/seed?mediaId=" + encodeURIComponent(id));
    if (!seedResponse.ok) throw new Error("Vidy seed HTTP " + seedResponse.status);
    const seedData = await seedResponse.json();
    const seed = String(seedData && seedData.seed || "");
    if (!seed) throw new Error("Vidy seed missing");

    // Query every Vidy region concurrently; one healthy region must not hide the others.
    const regionalResults = await Promise.all(SERVERS.map(async (server) => {
      try {
        const url = new URL(API + "/" + server + "/sources");
        url.searchParams.set("mediaType", type);
        url.searchParams.set("tmdbId", id);
        url.searchParams.set("enc", "2");
        url.searchParams.set("seed", seed);
        if (type === "tv") {
          url.searchParams.set("seasonId", String(s));
          url.searchParams.set("episodeId", String(ep));
        }

        const response = await fetchJson(url.toString());
        if (!response.ok) {
          console.warn("[Vidy] " + server + " sources HTTP " + response.status);
          return [];
        }

        let data;
        try {
          data = JSON.parse(decryptSources(await response.text(), seed, Number(id)));
        } catch (err) {
          console.warn("[Vidy] " + server + " response could not be decrypted: " + (err.message || err));
          return [];
        }

        const subtitles = cleanSubtitles(data && data.subtitles);
        const candidates = [];
        const seen = new Set();
        const add = (candidate, fallbackQuality) => {
          const streamUrl = validUrl(candidate && candidate.url);
          if (!streamUrl || seen.has(streamUrl)) return;
          seen.add(streamUrl);
          const quality = String(candidate.quality || fallbackQuality || "Auto");
          candidates.push({
            name: "Vidy - " + server.charAt(0).toUpperCase() + server.slice(1),
            title: (type === "tv" ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0") : "Movie") + " - " + quality,
            quality,
            url: streamUrl,
            headers: HEADERS,
            behaviorHints: { notWebReady: true, proxyHeaders: { request: HEADERS } },
            subtitles,
          });
        };

        if (data && data.playlist) add({ url: data.playlist, quality: "Auto" }, "Auto");
        if (data && Array.isArray(data.sources)) {
          const ordered = data.sources.slice().sort((a, b) => {
            const rank = (x) => parseInt(String(x && x.quality || "").match(/\d+/)?.[0] || "0", 10);
            return rank(b) - rank(a);
          });
          for (const source of ordered) add(source, "Auto");
        }

        if (candidates.length) {
          console.info("[Vidy] Resolved " + type + ":" + id + " from " + server + " (" + candidates.length + " stream(s))");
        }
        return candidates;
      } catch (err) {
        console.warn("[Vidy] " + server + " lookup failed: " + (err && err.message ? err.message : err));
        return [];
      }
    }));

    const streams = regionalResults.flat();
    if (streams.length) return streams;
    console.warn("[Vidy] No playable sources for " + type + ":" + id);
    return [];
  } catch (err) {
    console.warn("[Vidy] No stream for " + type + ":" + id + ": " + (err && err.message ? err.message : err));
    return [];
  }
}

module.exports = { getStreams };
