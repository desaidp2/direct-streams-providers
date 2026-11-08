#!/usr/bin/env node

/**
 * Direct Streams Providers - Stremio & WuPlay Add-on Server
 *
 * Runs a standalone HTTP server implementing the Stremio Addon Protocol.
 * Works out of the box with zero runtime dependencies.
 *
 * Usage:
 *   node server.js
 *   PORT=7000 node server.js
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

// Load .env file if present (zero external dependencies)
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (_) {}
}
loadEnv();

const { route, CORS_HEADERS } = require("./src/stremio/router");

function hasBrowserEngine() {
  try {
    require("patchright");
    return true;
  } catch (_) {
    try {
      require("playwright-core");
      return true;
    } catch (_) {
      return false;
    }
  }
}

// Real-browser host (auto-enabled if patchright or playwright-core is available,
// or via CHALLENGE_BROWSER=patchright/chromium/1; disable with CHALLENGE_BROWSER=0).
const enableBrowser =
  process.env.CHALLENGE_BROWSER === "chromium" ||
  process.env.CHALLENGE_BROWSER === "patchright" ||
  process.env.CHALLENGE_BROWSER === "1" ||
  process.env.CHALLENGE_BROWSER === "true" ||
  (process.env.CHALLENGE_BROWSER !== "0" && hasBrowserEngine());

if (enableBrowser) {
  try {
    const browserHost = require("./src/host/chromium-challenge-browser");
    global.challengeBrowser = browserHost;
    browserHost.warmUp("https://flystream.net/");
    const shutdown = () => browserHost.close().finally(() => process.exit(0));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    console.log("[ChallengeBrowser] enabled (patchright / chromium host)");
  } catch (err) {
    console.warn("[ChallengeBrowser] failed to initialize:", err.message || err);
  }
}

const PORT = parseInt(process.env.PORT || "7070", 10);
const HOST = process.env.HOST || "0.0.0.0";

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Only GET or HEAD
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, CORS_HEADERS);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const host = req.headers.host || `127.0.0.1:${PORT}`;
  // WHATWG URL instead of the deprecated url.parse (DEP0169)
  const parsedUrl = new URL(req.url, "http://127.0.0.1");
  const pathname = parsedUrl.pathname || "/";
  const query = Object.fromEntries(parsedUrl.searchParams.entries());
  const proto = req.headers["x-forwarded-proto"] || "http";
  const baseUrl = `${proto}://${host}`;

  console.log(`[HTTP] ${req.method} ${pathname}`);

  try {
    const response = await route(pathname, query, baseUrl);
    res.writeHead(response.status, response.headers);
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(response.body);
    }
  } catch (err) {
    console.error("[Server Error]", err);
    res.writeHead(500, CORS_HEADERS);
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://127.0.0.1:${PORT}/manifest.json`;
  const stremioUrl = `stremio://127.0.0.1:${PORT}/manifest.json`;
  console.log(`
🚀 Direct Streams Providers (Stremio & WuPlay Add-on)
────────────────────────────────────────────────────
📡 Local URL:   ${localUrl}
📺 Stremio URL: ${stremioUrl}
⚡ Status:      Listening on ${HOST}:${PORT}
────────────────────────────────────────────────────
Install in Stremio / WuPlay by pasting:
  ${localUrl}
`);
});
