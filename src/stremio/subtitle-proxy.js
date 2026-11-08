/**
 * Subtitle proxy: serves upstream subtitle files as application/x-subrip with an .srt path,
 * which ExoPlayer needs to pick a parser.
 *
 * Fixes vs the inline version in router.js:
 *   - the 6 s timeout now covers reading the body too (it was cleared before res.text());
 *   - only http(s) targets are fetched (it would fetch any scheme a client sent);
 *   - bodies over MAX_SUB_BYTES are refused, so the cache is bounded at
 *     MAX_SUB_CACHE x MAX_SUB_BYTES instead of 100 x unbounded;
 *   - LRU instead of FIFO: a hit refreshes recency.
 */

const { CORS_HEADERS } = require("./http-constants");

const MAX_SUB_CACHE = 100;
const MAX_SUB_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const SUBTITLE_CACHE = new Map();

const SRT_HEADERS = {
  "Content-Type": "application/x-subrip; charset=utf-8",
  "Content-Disposition": 'inline; filename="subtitle.srt"',
  "Access-Control-Allow-Origin": "*",
};

function jsonError(status, message) {
  return { status: status, headers: CORS_HEADERS, body: JSON.stringify({ error: message }) };
}

function cacheGet(key) {
  const hit = SUBTITLE_CACHE.get(key);
  if (hit === undefined) return undefined;
  SUBTITLE_CACHE.delete(key);
  SUBTITLE_CACHE.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  if (SUBTITLE_CACHE.size >= MAX_SUB_CACHE) {
    SUBTITLE_CACHE.delete(SUBTITLE_CACHE.keys().next().value);
  }
  SUBTITLE_CACHE.set(key, value);
}

async function handleSubtitleProxy(targetUrl) {
  if (!targetUrl) return jsonError(400, "Missing url parameter");
  if (!/^https?:\/\//i.test(targetUrl)) return jsonError(400, "Only http(s) subtitle urls are proxied");

  const cached = cacheGet(targetUrl);
  if (cached !== undefined) return { status: 200, headers: SRT_HEADERS, body: cached };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "okhttp/4.12.0" },
    });
    if (!res.ok) return jsonError(res.status, `Subtitle fetch failed (${res.status})`);

    const declared = parseInt(res.headers.get("content-length") || "0", 10);
    if (declared > MAX_SUB_BYTES) return jsonError(413, "Subtitle file too large");
    const text = await res.text();
    if (text.length > MAX_SUB_BYTES) return jsonError(413, "Subtitle file too large");

    cacheSet(targetUrl, text);
    return { status: 200, headers: SRT_HEADERS, body: text };
  } catch (e) {
    return jsonError(502, "Subtitle proxy upstream error");
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { handleSubtitleProxy };
