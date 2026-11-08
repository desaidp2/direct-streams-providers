/**
 * FlyStream JSON stream API client, ported from the Dart FlyStreamScraper in
 * sakinator/hostreamio (lib/upstream/services/scraper/sites/flystream.dart; the
 * android_app/ copy is byte-identical).
 *
 * Dart behaviour kept as-is:
 *   GET https://flystream.net/api/streams
 *     ?type=movie|tv &viewerId=<32 random hex> &title=<title>
 *     [&tmdbId] [&imdb] [&year] [&season &episode (tv only)]
 *   headers: browser UA, Referer https://flystream.net/, Accept application/json
 *   5 s timeout; only HTTP 200 is read; body is { streams: [{ url, quality, videoCodec,
 *   size, name | title }] }; a relative url ("/...") is prefixed with the site origin and
 *   anything not http(s) is skipped; playback headers are the browser UA + flystream Referer.
 *
 * Hermes / QuickJS safe: no URL / URLSearchParams / crypto globals.
 */

const { withTimeout } = require("../shared/provider-utils");

const API_BASE = "https://flystream.net";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const API_HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: API_BASE + "/",
  Accept: "application/json",
};

// The Dart scraper sends these with every stream; forwarded to ExoPlayer via proxyHeaders.
const PLAYBACK_HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: API_BASE + "/",
};

const API_TIMEOUT_MS = 5000;

// 32 lowercase hex chars, one fresh value per request (Dart: Random().nextInt(16) x 32).
function randomViewerId() {
  let out = "";
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

// Same params, same inclusion rules as the Dart map literal. Values are strings.
function buildApiParams({ mediaType, title, tmdbId, imdbId, year, season, episode, viewerId }) {
  const isTv = mediaType === "tv";
  const params = [
    ["type", isTv ? "tv" : "movie"],
    ["viewerId", viewerId || randomViewerId()],
    ["title", title || ""],
  ];
  if (tmdbId != null && tmdbId !== "") params.push(["tmdbId", String(tmdbId)]);
  if (imdbId) params.push(["imdb", String(imdbId)]);
  if (year != null && year !== "") params.push(["year", String(year)]);
  if (isTv && season != null) params.push(["season", String(season)]);
  if (isTv && episode != null) params.push(["episode", String(episode)]);
  return params;
}

function buildApiUrl(params) {
  const qs = params.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  return `${API_BASE}/api/streams?${qs}`;
}

// Free-form upstream quality ("2160p", "4K", "1080p HEVC", "Auto") -> the shared sort labels.
function normalizeQuality(raw) {
  const q = String(raw || "");
  if (/2160|4k|uhd/i.test(q)) return "4K";
  if (/1440/.test(q)) return "1440p";
  if (/1080/.test(q)) return "1080p";
  if (/720/.test(q)) return "720p";
  if (/480/.test(q)) return "480p";
  if (/360/.test(q)) return "360p";
  return "Auto";
}

function str(v) {
  return v == null ? "" : String(v);
}

/**
 * Pure: maps the API JSON body to provider stream objects (Nuvio shape + Stremio
 * behaviorHints). Unusable entries are skipped exactly as the Dart loop skips them.
 * Attaches the browser session's Cookie and matching User-Agent so ExoPlayer on
 * Android TV / Nuvio can play the HLS stream without being rejected by FlyStream's
 * session-auth check.
 */
function mapApiStreams(data, fallbackTitle, session) {
  const list = data && Array.isArray(data.streams) ? data.streams : [];
  const streams = [];
  const seen = new Set();
  const ua = (session && session.userAgent) || BROWSER_UA;
  const playbackHeaders = {
    "User-Agent": ua,
    Referer: API_BASE + "/",
  };
  if (session && session.cookie) {
    playbackHeaders["Cookie"] = session.cookie;
  }

  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const rawUrl = str(s.url);
    if (!rawUrl) continue;
    const url = rawUrl.startsWith("/") ? API_BASE + rawUrl : rawUrl;
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);

    const qualityLabel = str(s.quality) || "Auto";
    const codec = str(s.videoCodec);
    const size = str(s.size);
    const name = str(s.name) || str(s.title) || fallbackTitle || "Stream";
    const details = [qualityLabel, codec ? codec.toUpperCase() : "", size].filter(Boolean).join(" · ");

    const stream = {
      name: `FlyStream - ${qualityLabel}`,
      title: `FlyStream ${name}\n${details || "Direct HLS Stream"}`,
      url: url,
      quality: normalizeQuality(qualityLabel),
      headers: playbackHeaders,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: { request: playbackHeaders },
      },
      subtitles: [],
    };
    if (size) stream.size = size;
    streams.push(stream);
  }
  return streams;
}

// Browser path bound: meta lookup (2 s) + this stays under the router's 9 s deadline.
const BROWSER_API_TIMEOUT_MS = 6500;

function hostChallengeBrowser() {
  return typeof challengeBrowser !== "undefined" &&
    challengeBrowser &&
    typeof challengeBrowser.execute === "function"
    ? challengeBrowser
    : null;
}

// Same-origin document the kept browser tab sits on. Light (no player, no trailers), and any
// flystream.net page carries the cookies the site set when the browser passed its checks.
const BROWSER_ORIGIN_PAGE = API_BASE + "/robots.txt";

// In-page fetch, as the site's own scripts call the API (a top-level navigation to the API URL
// is refused with 403). Returns a JSON string { status, body } to the host.
function inPageFetchJs(path) {
  return (
    "(async () => { const r = await fetch(" +
    JSON.stringify(path) +
    ", { headers: { Accept: 'application/json' }, credentials: 'same-origin' });" +
    " return JSON.stringify({ status: r.status, body: await r.text() }); })()"
  );
}

// Calls the API through the host browser (a real tab that has passed the site's bot check).
// Same { ok, streams | reason } contract as the fetch path. Forwards session cookies and
// User-Agent to the stream objects for ExoPlayer playback.
async function fetchViaHostBrowser(cb, url, title) {
  try {
    const r = await withTimeout(
      cb.execute(BROWSER_ORIGIN_PAGE, {
        reuse: true,
        evaluateJs: inPageFetchJs(url.slice(API_BASE.length)),
        timeoutMs: BROWSER_API_TIMEOUT_MS,
      }),
      BROWSER_API_TIMEOUT_MS + 500,
      "FlyStream API (browser)"
    );
    const res = JSON.parse(String((r && r.result) || ""));
    if (res.status !== 200) return { ok: false, reason: `browser HTTP ${res.status}` };
    const cookie = (r && r.cookies) || (typeof cb.getCookies === "function" ? await cb.getCookies() : "");
    const userAgent = (r && r.userAgent) || (typeof cb.getUserAgent === "function" ? await cb.getUserAgent() : BROWSER_UA);
    return {
      ok: true,
      streams: mapApiStreams(JSON.parse(res.body), title, { cookie, userAgent }),
      via: "browser",
    };
  } catch (err) {
    return { ok: false, reason: "browser: " + String((err && err.message) || err) };
  }
}

// Candidate companion endpoints. Configure via FLYSTREAM_COMPANION_URL (in .env or app settings).
// Supports compile-time injection during build and comma-separated URLs for multi-device setups.
const BUILD_COMPANION_URL =
  typeof __FLYSTREAM_COMPANION_URL__ !== "undefined" ? __FLYSTREAM_COMPANION_URL__ : "";

function getCompanionCandidates() {
  const envUrl = typeof process !== "undefined" && process.env ? process.env.FLYSTREAM_COMPANION_URL : null;
  const list = [];
  if (BUILD_COMPANION_URL) list.push(BUILD_COMPANION_URL);
  if (envUrl) {
    envUrl
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((u) => list.push(u));
  }
  // Generic local fallback when companion runs on the same machine
  list.push("http://127.0.0.1:7070");
  return [...new Set(list)];
}

/**
 * When running client-side (e.g. QuickJS on Android TV) without a host browser,
 * query the companion server (e.g. on a local Raspberry Pi or server configured
 * via FLYSTREAM_COMPANION_URL) which has the challengeBrowser session and can
 * return streams with the required session cookies.
 */
async function fetchViaCompanion(query) {
  const candidates = getCompanionCandidates();
  const qs = buildApiParams(query)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  for (const host of candidates) {
    try {
      const endpoint = `${host.replace(/\/+$/, "")}/companion/flystream?${qs}`;
      console.log(`[FlyStream] Querying companion: ${endpoint}`);
      const res = await withTimeout(fetch(endpoint), 8000, "FlyStream Companion");
      if (res && res.ok) {
        const data = await res.json();
        if (data && data.ok && Array.isArray(data.streams) && data.streams.length > 0) {
          console.log(`[FlyStream] Companion returned ${data.streams.length} stream(s)`);
          return { ok: true, streams: data.streams, via: "companion" };
        }
      }
    } catch (err) {
      console.warn(`[FlyStream] Companion ${host} failed: ${err.message || err}`);
    }
  }
  return null;
}

/**
 * Calls the API once. Resolves { ok: true, streams } on HTTP 200 with parseable JSON,
 * else { ok: false, reason } (non-200, bad JSON, timeout, network error). Never throws.
 * When the host provides `challengeBrowser` (server.js on the Pi, SkyStream, a webview) the
 * call goes through it; checks LAN companion when running without a browser (Nuvio);
 * plain fetch is used as the last fallback.
 */
async function fetchApiStreams(query) {
  const cb = hostChallengeBrowser();
  if (cb) {
    const url = buildApiUrl(buildApiParams(query));
    return fetchViaHostBrowser(cb, url, query.title);
  }

  // Not in host browser context (e.g. Nuvio on Android TV): check LAN companion
  const companionResult = await fetchViaCompanion(query);
  if (companionResult && companionResult.ok) {
    return companionResult;
  }

  const url = buildApiUrl(buildApiParams(query));
  try {
    const res = await withTimeout(fetch(url, { headers: API_HEADERS }), API_TIMEOUT_MS, "FlyStream API");
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
    const data = JSON.parse(await res.text());
    return { ok: true, streams: mapApiStreams(data, query.title) };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

module.exports = {
  API_BASE,
  PLAYBACK_HEADERS,
  randomViewerId,
  buildApiParams,
  buildApiUrl,
  normalizeQuality,
  mapApiStreams,
  fetchApiStreams,
};
