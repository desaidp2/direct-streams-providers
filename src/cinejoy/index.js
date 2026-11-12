/**
 * Cinejoy Stremio provider.
 * The resolver runner is adapted from EasyProxy by nzo66 (MIT); see THIRD_PARTY_NOTICES.md.
 * Runs the upstream's documented gateway flow and returns the resolved HLS master URL.
 */
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const RUNNER = path.join(__dirname, "cinejoy_runner.mjs");
const TIMEOUT_MS = Number(process.env.CINEJOY_TIMEOUT_MS || 18000);
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
      if (code !== 0 || payload.error || !/^https?:\/\//i.test(String(payload.url || ""))) {
        return finish(new Error(String(payload.error || stderr || "No Cinejoy stream returned")));
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
    const headers = {
      "User-Agent": UA,
      Referer: "https://cinejoy.to/",
      Origin: "https://cinejoy.to",
    };
    return [{
      name: "Cinejoy - HLS",
      title: (isTv ? `S${String(target.season).padStart(2, "0")}E${String(target.episode).padStart(2, "0")}` : "Movie") + " - Auto HLS",
      url: resolved.url,
      quality: "Auto",
      headers,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } },
      subtitles: [],
    }];
  } catch (err) {
    console.warn("[Cinejoy] " + (err && err.message ? err.message : err));
    return [];
  }
}

module.exports = { getStreams };
