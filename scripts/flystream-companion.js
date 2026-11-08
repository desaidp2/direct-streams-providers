#!/usr/bin/env node

/**
 * FlyStream Companion Server runner.
 *
 * Dedicated launcher for the self-hosted FlyStream challenge browser companion
 * and Stremio / WuPlay add-on server.
 *
 * Automatically loads .env, initializes patchright / Chromium stealth browser context,
 * resolves local network interfaces (LAN IP), and prints ready-to-use companion URLs
 * for Nuvio TV, WuPlay, and Stremio.
 *
 * Usage:
 *   node scripts/flystream-companion.js
 *   npm run companion
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

// Ensure environment is configured for companion mode
if (!process.env.CHALLENGE_BROWSER) {
  process.env.CHALLENGE_BROWSER = "patchright";
}

// Discover all non-internal IPv4 LAN addresses
function getLanIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

const port = process.env.PORT || 7070;
const lanIps = getLanIps();

console.log(`
╔═════════════════════════════════════════════════════════════════════════════╗
║                   FlyStream Companion Server (Patchright)                   ║
╚═════════════════════════════════════════════════════════════════════════════╝
`);

console.log("📡 Network Endpoints:");
console.log(`   - Local:      http://127.0.0.1:${port}`);
for (const iface of lanIps) {
  console.log(`   - LAN (${iface.name}): http://${iface.address}:${port}`);
}

console.log("\n📺 Companion Integration URLs:");
if (lanIps.length > 0) {
  const primaryIp = lanIps[0].address;
  console.log(`   - Nuvio TV (FLYSTREAM_COMPANION_URL): http://${primaryIp}:${port}`);
  console.log(`   - Stremio / WuPlay Manifest:        http://${primaryIp}:${port}/manifest.json`);
} else {
  console.log(`   - Nuvio TV (FLYSTREAM_COMPANION_URL): http://127.0.0.1:${port}`);
  console.log(`   - Stremio / WuPlay Manifest:        http://127.0.0.1:${port}/manifest.json`);
}
console.log("\n───────────────────────────────────────────────────────────────────────────────\n");

// Launch main server
require("../server.js");
