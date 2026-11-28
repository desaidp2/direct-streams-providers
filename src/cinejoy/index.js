/**
 * Cinejoy Stremio provider.
 * The resolver runner is adapted from EasyProxy by nzo66 (MIT); see THIRD_PARTY_NOTICES.md.
 * Runs the upstream gateway flow and returns one HLS stream per working server.
 */
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const RUNNER = path.join(__dirname, "cinejoy_runner.mjs");
const TIMEOUT_MS = Number(process.env.CINEJOY_TIMEOUT_MS || 65000);
const MAX_OUTPUT = 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function runResolver(target) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, JSON.stringify(target)], {
      env: { ...process.env, CINEJOY_DEBUG: process.env.CINEJOY_DEBUG || "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Cinejoy resolver timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish(new Error("Cinejoy resolver output exceeded limit"));
      }
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.on("error", err => finish(err));
    child.on("close", code => {
      if (settled) return;
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let payload;
      try { payload = JSON.parse(lines[lines.length - 1] || "{}"); }
      catch { return finish(new Error("Cinejoy returned invalid JSON: " + stderr.slice(-500))); }
      if (code !== 0 || payload.error || !Array.isArray(payload.streams)) {
        return finish(new Error(String(payload.error || stderr || "No Cinejoy streams returned")));
      }
      finish(null, payload);
    });
  });
}

async function getStreams(tmdbId, type, season, episode) {
  const id = Number(tmdbId);
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const isTv = type === "tv" || type === "series";
  const target = {
    type: isTv ? "tv" : "movie",
    tmdbId: id,
    ...(isTv ? { season: Number(season || 1), episode: Number(episode || 1) } : {}),
  };

  try {
    const resolved = await runResolver(target);
    console.info(`[Cinejoy] Resolved ${target.type}:${id}: ${resolved.streams.length}/${resolved.serversAttempted || resolved.streams.length} server(s): ${resolved.streams.map((s) => s.server).join(", ")}`);
    const headers = {
      "User-Agent": UA,
      Referer: "https://cinejoy.to/",
      Origin: "https://cinejoy.to",
    };
    return resolved.streams.map((resolvedStream) => {
      const hls = resolvedStream.hls || {};
      const hlsLabel = hls.variants
        ? ` - ${hls.variants} quality variant(s)${hls.audioTracks ? ` / ${hls.audioTracks} audio track(s)` : ""}`
        : "";
      return ({
      name: `Cinejoy - ${resolvedStream.server} - HLS`,
      title: (isTv ? `S${String(target.season).padStart(2, "0")}E${String(target.episode).padStart(2, "0")}` : "Movie") + ` - ${resolvedStream.server} - Auto HLS${hlsLabel}`,
      url: resolvedStream.url,
      quality: "Auto",
      headers,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } },
      subtitles: Array.isArray(resolvedStream.subtitles) ? resolvedStream.subtitles.map((sub) => ({
        url: sub.url,
        language: sub.language || "und",
        name: sub.display || sub.language || "subtitle",
        headers,
      })) : [],
      });
    });
  } catch (err) {
    console.warn(`[Cinejoy] No stream for ${target.type}:${id}: ` + (err && err.message ? err.message : err));
    return [];
  }
}

module.exports = { getStreams };
