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

const { withTimeout, fetchWithTimeout } = require("../shared/provider-utils");

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
    // Several sources of the same quality (e.g. three "1080p" buckets) are told apart by the
    // site's source bucket ("s1", "s2", ...), when it sends one.
    const bucket = /^s\d{1,2}$/i.test(str(s.sourceBucket)) ? " " + str(s.sourceBucket).toUpperCase() : "";
    const details = [qualityLabel, codec ? codec.toUpperCase() : "", size].filter(Boolean).join(" · ");

    const stream = {
      name: `FlyStream${bucket} - ${qualityLabel}`,
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
// Turns a host execute() result into the { ok, streams | reason } contract.
async function parseBrowserResult(cb, r, title) {
  const res = JSON.parse(String((r && r.result) || ""));
  if (res.status !== 200) return { ok: false, reason: `browser HTTP ${res.status}` };
  const cookie = (r && r.cookies) || (typeof cb.getCookies === "function" ? await cb.getCookies() : "");
  const userAgent = (r && r.userAgent) || (typeof cb.getUserAgent === "function" ? await cb.getUserAgent() : BROWSER_UA);
  return { ok: true, streams: mapApiStreams(JSON.parse(res.body), title, { cookie, userAgent }), via: "browser" };
}

// Calls the API through the host browser. On timeout the in-page fetch keeps running, and the
// result carries `late`: a promise of its eventual outcome, so the caller can still cache it.
// (Measured on the Pi: uncached API answers take 1-6 s, so some calls overrun the budget.)
async function fetchViaHostBrowser(cb, url, title, timeoutMs) {
  const budget = timeoutMs || BROWSER_API_TIMEOUT_MS;
  const work = Promise.resolve()
    .then(() =>
      cb.execute(BROWSER_ORIGIN_PAGE, { reuse: true, evaluateJs: inPageFetchJs(url.slice(API_BASE.length)), timeoutMs: budget })
    )
    .then((r) => parseBrowserResult(cb, r, title));
  try {
    return await withTimeout(work, budget + 500, "FlyStream API (browser)");
  } catch (err) {
    const reason = "browser: " + String((err && err.message) || err);
    const timedOut = /FlyStream API \(browser\) \d+ms/.test(reason);
    return timedOut ? { ok: false, reason, late: work.catch(() => null) } : { ok: false, reason };
  }
}

// Candidate companion endpoints. Configure via FLYSTREAM_COMPANION_URL (in .env or app settings).
// Both the build/serve-time value and the env value may be comma-separated lists.
//
// There is deliberately NO implicit http://127.0.0.1 fallback: on the TV, 127.0.0.1 is the TV
// itself (nothing listens there), and on the server it is the server's own /companion route, which
// would call itself again on every hop (one request fanned out into ~5k self-requests in 8.7 s).
const BUILD_COMPANION_URL =
  typeof __FLYSTREAM_COMPANION_URL__ !== "undefined" ? __FLYSTREAM_COMPANION_URL__ : "";

// Companion budget: meta lookup (2 s) + this stays under the router's / app's 9 s deadline.
// 8 s: the companion's own worst case is ~9 s (2 s meta + 7 s browser) and its late-fill cache
// makes the retry instant. On Nuvio this bound cannot fire anyway (synchronous native fetch).
const COMPANION_TIMEOUT_MS = 8000;

function splitUrls(v) {
  return v ? String(v).split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean) : [];
}

function getCompanionCandidates() {
  const envUrl = typeof process !== "undefined" && process.env ? process.env.FLYSTREAM_COMPANION_URL : "";
  return [...new Set(splitUrls(BUILD_COMPANION_URL).concat(splitUrls(envUrl)))];
}

// One companion host. Resolves { ok: true, streams } or rejects, so the caller can race hosts.
async function queryCompanion(host, qs) {
  const endpoint = `${host}/companion/flystream?${qs}`;
  console.log(`[FlyStream] Querying companion: ${endpoint}`);
  const res = await fetchWithTimeout(endpoint, undefined, COMPANION_TIMEOUT_MS, "FlyStream Companion");
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  const data = await res.json();
  if (!data || !data.ok || !Array.isArray(data.streams) || data.streams.length === 0) {
    throw new Error("no streams");
  }
  return { ok: true, streams: data.streams, via: "companion" };
}

// First success wins (hand-rolled Promise.any: not available on every QuickJS / Hermes build).
// On Node / Workers the hosts run concurrently: worst case is one COMPANION_TIMEOUT_MS for all
// hosts together, not one per host. On Nuvio the native fetch is synchronous, so the hosts are
// effectively tried in list order: put the usual companion first in FLYSTREAM_COMPANION_URL.
function firstSuccess(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (!pending) return resolve(null);
    promises.forEach((p) =>
      p.then(resolve, (err) => {
        console.warn(`[FlyStream] Companion failed: ${(err && err.message) || err}`);
        if (--pending === 0) resolve(null);
      })
    );
  });
}

/**
 * When running client-side (e.g. QuickJS on Android TV) without a host browser,
 * query the companion server(s) configured via FLYSTREAM_COMPANION_URL, which hold the
 * challengeBrowser session and return streams with the required session cookies.
 */
async function fetchViaCompanion(query) {
  const candidates = getCompanionCandidates();
  if (!candidates.length) return null;
  const qs = buildApiParams(query)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  const result = await firstSuccess(candidates.map((host) => queryCompanion(host, qs)));
  if (result) console.log(`[FlyStream] Companion returned ${result.streams.length} stream(s)`);
  return result;
}

/**
 * Calls the API once. Resolves { ok: true, streams } on HTTP 200 with parseable JSON,
 * else { ok: false, reason } (non-200, bad JSON, timeout, network error). Never throws.
 * When the host provides `challengeBrowser` (server.js on the Pi, SkyStream, a webview) the
 * call goes through it; checks LAN companion when running without a browser (Nuvio);
 * plain fetch is used as the last fallback.
 */
async function fetchApiStreams(query, opts) {
  const cb = hostChallengeBrowser();
  if (cb) {
    const url = buildApiUrl(buildApiParams(query));
    return fetchViaHostBrowser(cb, url, query.title, opts && opts.browserTimeoutMs);
  }

  // Not in host browser context (e.g. Nuvio on Android TV): check LAN companion.
  // The server's own /companion route passes skipCompanion so it can never call itself.
  const companionResult = opts && opts.skipCompanion ? null : await fetchViaCompanion(query);
  if (companionResult && companionResult.ok) {
    return companionResult;
  }

  const url = buildApiUrl(buildApiParams(query));
  try {
    const res = await fetchWithTimeout(url, { headers: API_HEADERS }, API_TIMEOUT_MS, "FlyStream API");
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
    const data = JSON.parse(await res.text());
    return { ok: true, streams: mapApiStreams(data, query.title) };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

module.exports = {
  API_BASE,
  BROWSER_ORIGIN_PAGE,
  PLAYBACK_HEADERS,
  randomViewerId,
  buildApiParams,
  buildApiUrl,
  normalizeQuality,
  mapApiStreams,
  fetchApiStreams,
  getCompanionCandidates,
};
