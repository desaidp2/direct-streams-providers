/**
 * VixSrc Stremio provider.
 *
 * Adapted from the GPL-3.0-licensed StreamViX extractor:
 * https://github.com/emaschi5/StreamViX
 * This integration uses the TMDB ID already resolved by our Stremio router.
 */
"use strict";

const ORIGIN = process.env.VIXSRC_ORIGIN || "https://vixsrc.to";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT_MS = Number(process.env.VIXSRC_TIMEOUT_MS || 14000);

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function request(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        "Referer": referer || ORIGIN + "/",
        "Origin": ORIGIN,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractPlayerData(html) {
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const tag of scripts) {
    if (!/token/.test(tag) || !/expires/.test(tag)) continue;
    const token = tag.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/i);
    const expires = tag.match(/['"]expires['"]\s*:\s*['"]?(\d+)['"]?/i);
    const server = tag.match(/\burl\s*:\s*['"]([^'"]+)['"]/i);
    if (token && expires && server) {
      return { token: token[1], expires: expires[1], serverUrl: server[1] };
    }
  }
  return null;
}

async function getStreams(tmdbId, type, season, episode) {
  const id = validId(tmdbId);
  if (!id) return [];
  const isTv = type === "tv" || type === "series";
  const s = Math.max(1, Number(season) || 1);
  const e = Math.max(1, Number(episode) || 1);
  const targetUrl = isTv
    ? `${ORIGIN}/tv/${id}/${s}/${e}/`
    : `${ORIGIN}/movie/${id}/`;

  try {
    const response = await request(targetUrl, ORIGIN + "/");
    if (!response.ok) throw new Error(`VixSrc page HTTP ${response.status}`);
    const html = await response.text();
    const player = extractPlayerData(html);
    if (!player) throw new Error("VixSrc player token was not found");

    const separator = player.serverUrl.includes("?") ? "&" : "?";
    // VixSrc's original extractor uses h=1 to request its highest supported rendition.
    const streamUrl = `${player.serverUrl}${separator}token=${encodeURIComponent(player.token)}&expires=${encodeURIComponent(player.expires)}&h=1`;
    if (!/^https?:\/\//i.test(streamUrl)) throw new Error("VixSrc returned an invalid stream URL");

    const headers = {
      "User-Agent": UA,
      "Referer": targetUrl,
      "Origin": ORIGIN,
    };
    return [{
      name: "VixSrc - HLS",
      title: isTv ? `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")} - Auto` : "Movie - Auto",
      url: streamUrl,
      quality: "Auto",
      headers,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } },
      subtitles: [],
    }];
  } catch (err) {
    console.warn("[VixSrc] No stream for " + (isTv ? "tv" : "movie") + ":" + id + ": " + (err?.message || err));
    return [];
  }
}

module.exports = { getStreams };
