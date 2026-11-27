"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const RUNNER = path.join(__dirname, "vidfast_runner.mjs");
const TIMEOUT_MS = Number(process.env.VIDFAST_TIMEOUT_MS || 125000);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function pageUrl(tmdbId, mediaType, season, episode) {
  const id = String(tmdbId || "").trim();
  if (!/^\\d+$/.test(id)) throw new Error("VidFast requires a numeric TMDB id");
  if (mediaType === "tv" || mediaType === "series") {
    const s = Math.max(1, parseInt(season, 10) || 1);
    const ep = Math.max(1, parseInt(episode, 10) || 1);
    return "https://vidfast.vc/tv/" + id + "/" + s + "/" + ep;
  }
  return "https://vidfast.vc/movie/" + id;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  let url;
  try {
    url = pageUrl(tmdbId, mediaType, season, episode);
    const { stdout, stderr } = await execFileAsync(process.execPath, [RUNNER, url], {
      timeout: TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, VIDFAST_DEBUG: process.env.VIDFAST_DEBUG || "0" },
      windowsHide: true,
    });
    const payload = JSON.parse(String(stdout || "").trim().split(/\\r?\\n/).filter(Boolean).pop() || "{}");
    if (payload.error) throw new Error(payload.error);
    const streamUrl = String(payload.url || "").trim();
    if (!/^https?:\\/\\//i.test(streamUrl)) throw new Error("VidFast returned no playable URL");
    const headers = payload.headers && typeof payload.headers === "object" ? payload.headers : {
      "User-Agent": UA,
      Referer: url,
      Origin: "https://vidfast.vc",
    };
    const subtitles = (Array.isArray(payload.subtitles) ? payload.subtitles : [])
      .filter(item => item && /^https?:\\/\\//i.test(String(item.url || "")))
      .slice(0, 80)
      .map(item => ({
        url: String(item.url),
        language: String(item.language || "und").slice(0, 16),
        name: String(item.display || item.language || "Subtitle").slice(0, 80),
        headers,
      }));
    console.info("[VidFast] Resolved " + mediaType + ":" + tmdbId + " through original player runner");
    return [{
      name: "VidFast - Player resolver",
      title: "Auto HLS - Player fallback",
      quality: "Auto",
      url: streamUrl,
      headers,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } },
      subtitles,
    }];
  } catch (error) {
    const detail = error && error.stderr ? String(error.stderr).slice(-500) : "";
    console.warn("[VidFast] Could not resolve " + (url || tmdbId) + ": " + (error.message || error) + (detail ? " | " + detail : ""));
    return [];
  }
}

async function fetchSubtitles(tmdbId, mediaType, season, episode) {
  const streams = await getStreams(tmdbId, mediaType, season, episode);
  return streams.flatMap(stream => stream.subtitles || []);
}

module.exports = { getStreams, fetchSubtitles };
