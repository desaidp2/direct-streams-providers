/**
 * 7Movies provider for Nuvio.
 *
 * 7movies.ac is a TMDB-keyed front end: /movie/{tmdbId}/watch and
 * /tv/{tmdbId}/watch. Its watch page offers several embed players;
 * this provider resolves the VidLink upstream (one of the site's own
 * player sources) through VidLink's JSON API, which returns direct
 * mp4/HLS links plus captions — exactly what Nuvio plays.
 *
 * Flow: enc-dec.app encrypts the TMDB id -> vidlink.pro/api/b/...
 * No search step is needed because Nuvio hands us the TMDB id.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const MEDIA_UA = "okhttp/4.12.0";

const { sortByQuality, withTimeout, TtlCache } = require("../shared/provider-utils");
const { parseMasterPlaylist } = require("./hls-master-playlist-parser");

const VIDLINK_API = "https://vidlink.pro/api/b";
const ENC_API = "https://enc-dec.app/api/enc-vidlink";

const VIDLINK_HEADERS = {
  "User-Agent": UA,
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro",
};

const LANG_CODES = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  russian: "ru",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  hindi: "hi",
  arabic: "ar",
  vietnamese: "vi",
  indonesian: "id",
  filipino: "tl",
  turkish: "tr",
  polish: "pl",
  dutch: "nl",
  swedish: "sv",
  thai: "th",
};

// Bounded LRU caches with TTL: a repeat lookup costs O(1) instead of 2-3 network round trips.
const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (well inside CDN signature window)
// A title with no sources is remembered briefly so a retrying client does not re-run the chain.
const EMPTY_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;
const encCache = new TtlCache(MAX_CACHE_SIZE, 6 * 60 * 60 * 1000);
const streamCache = new TtlCache(MAX_CACHE_SIZE, CACHE_TTL_MS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUS = { 429: true, 492: true, 503: true };

// Resilient HTTP fetcher with exponential backoff & jitter for 429/492/503 and network errors.
// Any other HTTP status (404 for a missing title, 400, 403) fails at once: the old loop threw
// inside its own try and so retried every 404 twice, adding ~1.8 s of sleeps to each miss.
async function fetchWithRetry(url, headers, retries = 2, baseDelay = 600) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await withTimeout(fetch(url, { headers: headers || {} }), REQUEST_TIMEOUT_MS, "7Movies fetch");
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(baseDelay * Math.pow(2, attempt) + Math.random() * 200);
      continue;
    }
    if (res.ok) return res;

    // Handle HTTP 429, 492 (Too Many Requests / CDN rate limit), or 503
    if (RETRYABLE_STATUS[res.status] && attempt < retries) {
      const retryAfter = res.headers && typeof res.headers.get === "function"
        ? res.headers.get("retry-after")
        : null;
      const delayMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000 || baseDelay, 4000)
        : baseDelay * Math.pow(2, attempt) + Math.random() * 200;
      await sleep(delayMs);
      continue;
    }
    throw new Error("HTTP " + res.status + " for " + url);
  }
}

async function fetchJson(url, headers) {
  const res = await fetchWithRetry(url, headers);
  return await res.json();
}

async function fetchText(url, headers) {
  const res = await fetchWithRetry(url, headers);
  return await res.text();
}

function qualityLabel(key) {
  const n = parseInt(key, 10);
  if (!isNaN(n)) {
    if (n >= 2160) return "4K";
    if (n >= 1440) return "1440p";
    if (n >= 1080) return "1080p";
    if (n >= 720) return "720p";
    if (n >= 480) return "480p";
    if (n >= 360) return "360p";
    return n + "p";
  }
  const s = String(key || "").toLowerCase();
  if (s.includes("2160") || s.includes("4k")) return "4K";
  if (s.includes("1080")) return "1080p";
  if (s.includes("720")) return "720p";
  if (s.includes("480")) return "480p";
  if (s.includes("360")) return "360p";
  return "Unknown";
}

function mapSubtitles(captions) {
  if (!Array.isArray(captions)) return [];
  const out = [];
  const seenUrls = new Set();

  for (const c of captions) {
    if (!c || !c.url || seenUrls.has(c.url)) continue;
    seenUrls.add(c.url);

    const name = c.language || c.label || c.name || "Unknown";
    const code =
      LANG_CODES[String(name).trim().toLowerCase()] ||
      (String(name).length === 2 ? String(name).toLowerCase() : "und");

    out.push({
      url: c.url,
      language: code,
      name: String(name),
      headers: { "User-Agent": MEDIA_UA },
    });
  }
  return out;
}

function playbackHeaders(qualityData, streamData) {
  const src = Object.assign(
    {},
    (streamData && streamData.headers) || {},
    (qualityData && qualityData.headers) || {}
  );
  // Default to native media client User-Agent. Nuvio TV's default OkHttpDataSource
  // sets a browser Mozilla/5.0 UA, which triggers HTTP 428 Precondition Required
  // on Tengine/Nginx CDNs (bcdn.hakunaymatata.com) due to missing browser bot cookies.
  const h = {
    "User-Agent": MEDIA_UA,
  };
  for (const k of Object.keys(src)) {
    const val = src[k];
    if (val) {
      if (k.toLowerCase() === "referer") h["Referer"] = val;
      else if (k.toLowerCase() === "origin") h["Origin"] = val;
      else if (k.toLowerCase() === "user-agent") {
        h["User-Agent"] = val.includes("Mozilla") ? MEDIA_UA : val;
      }
      else h[k] = val;
    }
  }
  return h;
}

// Expands an HLS master playlist into one stream per variant (parser: hls-master-playlist-parser.js).
async function expandPlaylist(playlistUrl, headers, subtitles, title) {
  try {
    const text = await fetchText(playlistUrl, headers);
    const parsed = parseMasterPlaylist(text, playlistUrl);
    const variants = [];

    for (let i = 0; i < parsed.length; i++) {
      const resolvedUrl = parsed[i].url;
      const q = parsed[i].height ? qualityLabel(String(parsed[i].height)) : "Auto";

      variants.push({
        name: "7Movies - " + q,
        title: title,
        url: resolvedUrl,
        quality: q,
        headers: headers,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: headers,
          },
        },
        subtitles: subtitles,
      });
    }

    if (!variants.length) throw new Error("no variants");
    return variants;
  } catch (e) {
    return [
      {
        name: "7Movies - Auto",
        title: title,
        url: playlistUrl,
        quality: "Auto",
        headers: headers,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: headers,
          },
        },
        subtitles: subtitles,
      },
    ];
  }
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (!tmdbId) return [];
    const cleanId = String(tmdbId).trim();
    if (!cleanId) return [];

    const normType = mediaType === "tv" ? "tv" : "movie";
    const s = normType === "tv" ? Math.max(1, parseInt(season, 10) || 1) : null;
    const ep = normType === "tv" ? Math.max(1, parseInt(episode, 10) || 1) : null;
    const cacheKey = normType === "tv" ? `${cleanId}:${s}:${ep}` : cleanId;

    // Fast-path: check in-memory cache O(1) (an empty array is a remembered miss)
    const cached = streamCache.get(cacheKey);
    if (cached) return cached;

    // Step 1: Encrypt TMDB id with O(1) caching
    let encHash = encCache.get(cleanId);
    if (!encHash) {
      const enc = await fetchJson(ENC_API + "?text=" + encodeURIComponent(cleanId), {
        "User-Agent": UA,
      });
      if (!enc || !enc.result) return [];
      encHash = enc.result;
      encCache.set(cleanId, encHash);
    }

    // Step 2: Query upstream VidLink JSON API
    const apiUrl = normType === "tv"
      ? `${VIDLINK_API}/tv/${encHash}/${s}/${ep}`
      : `${VIDLINK_API}/movie/${encHash}`;

    let data;
    try {
      data = await fetchJson(apiUrl, VIDLINK_HEADERS);
    } catch (e) {
      // A definitive HTTP answer (e.g. 404: title not on VidLink) is a miss worth remembering;
      // timeouts and network errors are not, so the next request tries again.
      if (/^HTTP \d+/.test(e.message || "")) streamCache.set(cacheKey, [], EMPTY_TTL_MS);
      throw e;
    }
    if (!data || !data.stream) {
      streamCache.set(cacheKey, [], EMPTY_TTL_MS);
      return [];
    }

    const stream = data.stream;
    const subtitles = mapSubtitles(stream.captions || data.captions);
    const title = normType === "tv"
      ? "S" + String(s).padStart(2, "0") + "E" + String(ep).padStart(2, "0")
      : "Movie";

    const streams = [];

    // Step 3: Extract direct MP4 qualities
    if (stream.qualities) {
      const keys = Object.keys(stream.qualities);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const qd = stream.qualities[key];
        if (!qd || !qd.url) continue;
        const q = qualityLabel(key);
        const headers = playbackHeaders(qd, stream);

        streams.push({
          name: "7Movies - " + q,
          title: title + " - " + q + (qd.type ? " " + String(qd.type).toUpperCase() : ""),
          url: qd.url,
          quality: q,
          headers: headers,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: headers,
            },
          },
          subtitles: subtitles,
        });
      }
    }

    // Step 4: Expand HLS master playlist if available
    if (stream.playlist) {
      const plHeaders = playbackHeaders(null, stream);
      const expanded = await expandPlaylist(
        stream.playlist,
        plHeaders || VIDLINK_HEADERS,
        subtitles,
        title
      );
      for (let i = 0; i < expanded.length; i++) {
        streams.push(expanded[i]);
      }
    }

    // Step 5: Sort by quality descending
    sortByQuality(streams);

    // Cache the result for 10 minutes (a miss for 2)
    streamCache.set(cacheKey, streams, streams.length ? CACHE_TTL_MS : EMPTY_TTL_MS);

    return streams;
  } catch (e) {
    console.error("[7Movies] " + (e && e.message ? e.message : e));
    return [];
  }
}

module.exports = { getStreams };

