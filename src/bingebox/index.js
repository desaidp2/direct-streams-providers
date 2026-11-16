/**
 * BingeBox / PopcornMovies provider.
 *
 * Uses the public BingeBox unified sources API (TMDB keyed) and returns direct
 * HTTP/HLS streams. This provider is isolated from Cinejoy and 7Movies.
 */
const { fetchWithTimeout, withTimeout, TtlCache } = require("../shared/provider-utils");

const BASE_URL = (typeof process !== "undefined" && process.env && process.env.BINGEBOX_BASE_URL)
  ? process.env.BINGEBOX_BASE_URL.replace(/\/+$/, "")
  : "https://bingebox.ac";
const API_URL = BASE_URL + "/api/sources";
const TMDB_API_KEY = "f5b2cdde0b678e87f5c68b61b43c688c";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MEDIA_UA = "okhttp/4.12.0";
const REFERER = BASE_URL + "/";
const cache = new TtlCache(100, 5 * 60 * 1000);
const TIMEOUT_MS = 6500;
const BROWSER_ORIGIN_PAGE = BASE_URL + "/";

function headers() {
  return { "User-Agent": UA, "Referer": REFERER, "Origin": BASE_URL };
}

// Nuvio/Sora-like hosts may expose fetchv2, which performs native HTTP requests
// outside browser CORS restrictions. Prefer it when available, matching the
// upstream BingeBox module's transport behavior.
// Sora/Nuvio builds differ: fetchv2 may return a Response, a raw body string,
// or reject on non-2xx. Match the upstream module's fallback and normalize raw bodies.
function normalizeUpstreamResponse(response) {
  if (response && typeof response.json === "function") return response;
  const body = typeof response === "string" ? response : (response == null ? "" : String(response));
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body)
  };
}

async function fetchUpstream(url, init, label) {
  const opts = init || {};
  if (typeof fetchv2 === "function") {
    try {
      const nativeResponse = await withTimeout(
        fetchv2(url, opts.headers || {}, opts.method || "GET", opts.body || null),
        TIMEOUT_MS,
        label || "BingeBox native fetch"
      );
      if (nativeResponse != null) return normalizeUpstreamResponse(nativeResponse);
    } catch (err) {
      console.warn("[BingeBox] fetchv2 failed; trying fetch:", err && err.message || err);
    }
  }
  return fetchWithTimeout(url, opts, TIMEOUT_MS, label || "BingeBox fetch");
}

function hostChallengeBrowser() {
  return typeof challengeBrowser !== "undefined" &&
    challengeBrowser && typeof challengeBrowser.execute === "function"
    ? challengeBrowser : null;
}

function inPageFetchJs(path) {
  return "(async () => { const r = await fetch(" + JSON.stringify(path) +
    ", { headers: { Accept: 'application/json' }, credentials: 'include', referrer: " + JSON.stringify(REFERER) + " });" +
    " return JSON.stringify({ status: r.status, body: await r.text() }); })()";
}

async function fetchSources(apiUrl) {
  const cb = hostChallengeBrowser();
  if (cb) {
    try {
      const browserResult = await cb.execute(BROWSER_ORIGIN_PAGE, {
        reuse: true,
        evaluateJs: inPageFetchJs(apiUrl.slice(BASE_URL.length)),
        timeoutMs: TIMEOUT_MS
      });
      const response = JSON.parse(String((browserResult && browserResult.result) || ""));
      if (response.status !== 200) throw new Error("browser HTTP " + response.status);
      const cookie = browserResult.cookies ||
        (typeof cb.getCookies === "function" ? await cb.getCookies(BASE_URL) : "");
      const userAgent = browserResult.userAgent ||
        (typeof cb.getUserAgent === "function" ? await cb.getUserAgent() : UA);
      return { payload: JSON.parse(response.body), session: { cookie, userAgent } };
    } catch (err) {
      console.warn("[BingeBox] Browser API path failed, trying direct fetch:", err && err.message || err);
    }
  }

  const res = await fetchUpstream(apiUrl, {
    headers: Object.assign({ "Accept": "application/json" }, headers())
  }, "BingeBox sources");
  if (!res.ok) throw new Error("BingeBox API HTTP " + res.status);
  return { payload: await res.json(), session: null };
}

async function getMetadata(tmdbId, type) {
  const key = type + ":" + tmdbId;
  const hit = cache.get("meta:" + key);
  if (hit) return hit;
  const endpoint = type === "tv" ? "tv" : "movie";
  const url = "https://api.themoviedb.org/3/" + endpoint + "/" +
    encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=en-US";
  const res = await fetchUpstream(url, { headers: { "User-Agent": UA } }, "BingeBox TMDB metadata");
  if (!res.ok) throw new Error("TMDB metadata HTTP " + res.status);
  const data = await res.json();
  const result = {
    title: String(type === "tv" ? (data.name || data.original_name || "") : (data.title || data.original_title || "")),
    year: String(((type === "tv" ? data.first_air_date : data.release_date) || "").slice(0, 4))
  };
  if (!result.title) throw new Error("TMDB title missing");
  cache.set("meta:" + key, result, 24 * 60 * 60 * 1000);
  return result;
}

function mapCaptions(captions, playbackHeaders) {
  if (!Array.isArray(captions)) return [];
  const seen = new Set();
  const out = [];
  for (const cap of captions) {
    if (!cap || typeof cap.url !== "string" || !/^https?:\/\//i.test(cap.url) || seen.has(cap.url)) continue;
    seen.add(cap.url);
    const label = String(cap.label || cap.language || "Unknown");
    out.push({
      url: cap.url,
      language: String(cap.language || label).slice(0, 32),
      name: label,
      headers: playbackHeaders || { "User-Agent": MEDIA_UA, "Referer": REFERER }
    });
  }
  return out;
}

async function getStreams(tmdbId, type, season, episode) {
  const id = String(tmdbId || "");
  if (!/^\d{1,12}$/.test(id) || Number(id) <= 0) return [];
  const isTv = type === "tv" || type === "series";
  const mediaType = isTv ? "show" : "movie";
  const s = Number(season), e = Number(episode);
  if (isTv && (!Number.isInteger(s) || s < 1 || !Number.isInteger(e) || e < 1)) return [];
  try {
    const meta = await getMetadata(id, isTv ? "tv" : "movie");
    const params = new URLSearchParams({
      tmdbId: id,
      mediaType,
      title: meta.title,
      year: meta.year || ""
    });
    if (isTv) {
      params.set("season", String(s));
      params.set("episode", String(e));
    }
    const cacheKey = "streams:" + params.toString();
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const fetched = await fetchSources(API_URL + "?" + params.toString());
    const payload = fetched.payload;
    const playbackHeaders = {
      "User-Agent": (fetched.session && fetched.session.userAgent) || MEDIA_UA,
      "Referer": REFERER,
      "Origin": BASE_URL
    };
    if (fetched.session && fetched.session.cookie) playbackHeaders.Cookie = fetched.session.cookie;
    if (!payload || payload.success !== true || !Array.isArray(payload.sources)) return [];
    const seen = new Set();
    const streams = [];
    for (const source of payload.sources) {
      const stream = source && source.stream;
      if (!stream) continue;
      const url = stream.playlist || stream.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      const label = String(source.label || source.sourceId || "Server");
      const subtitles = mapCaptions(stream.captions, playbackHeaders);
      streams.push({
        name: "BingeBox - " + label,
        title: (isTv ? "S" + String(season).padStart(2, "0") + "E" + String(episode).padStart(2, "0") : "Movie") + " - Auto",
        url,
        quality: /2160|4k/i.test(url) ? "4K" : "Auto",
        headers: playbackHeaders,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: { request: playbackHeaders }
        },
        subtitles
      });
    }
    cache.set(cacheKey, streams, streams.length ? 5 * 60 * 1000 : 60 * 1000);
    console.info("[BingeBox] " + streams.length + " stream(s) for " + mediaType + ":" + id);
    return streams;
  } catch (err) {
    console.warn("[BingeBox] No streams for " + (isTv ? "tv" : "movie") + ":" + id + ": " + (err && err.message || err));
    return [];
  }
}

module.exports = { getStreams };
