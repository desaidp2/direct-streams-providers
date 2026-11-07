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

const http = require("http");
const url = require("url");
const { route, CORS_HEADERS } = require("./src/stremio/router");

const PORT = parseInt(process.env.PORT || "7000", 10);
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

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || "/";

  try {
    const response = await route(pathname);
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
