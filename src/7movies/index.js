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

const VIDLINK_API = "https://vidlink.pro/api/b";
const ENC_API = "https://enc-dec.app/api/enc-vidlink";

const VIDLINK_HEADERS = {
  "User-Agent": UA,
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro",
};

const QUALITY_ORDER = {
  "4K": 6,
  "1440p": 5,
  "1080p": 4,
  "720p": 3,
  "480p": 2,
  "360p": 1,
  Auto: 0,
  Unknown: -1,
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

// Bounded LRU/FIFO in-memory caches to optimize time complexity O(network) -> O(1)
const MAX_CACHE_SIZE = 100;
const encCache = new Map();
const streamCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (well inside CDN signature window)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded cache insertion with FIFO eviction
function setBoundedCache(map, key, value, limit = MAX_CACHE_SIZE) {
  if (map.size >= limit) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

// Resilient HTTP fetcher with exponential backoff & jitter for 429/492 rate-limits
async function fetchWithRetry(url, headers, retries = 2, baseDelay = 600) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: headers || {} });
      if (res.ok) return res;

      // Handle HTTP 429, 492 (Too Many Requests / CDN rate limit), or 503
      if ((res.status === 429 || res.status === 492 || res.status === 503) && attempt < retries) {
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
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(baseDelay * Math.pow(2, attempt) + Math.random() * 200);
    }
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
      headers: { "User-Agent": UA },
    });
  }
  return out;
}

function playbackHeaders(qualityData) {
  const h = { "User-Agent": UA };
  const src = (qualityData && qualityData.headers) || {};
  const referer = src.referer || src.Referer;
  const origin = src.origin || src.Origin;
  if (referer) h.Referer = referer;
  if (origin) h.Origin = origin;
  if (!referer && !origin) {
    h.Referer = VIDLINK_HEADERS.Referer;
    h.Origin = VIDLINK_HEADERS.Origin;
  }
  return h;
}

function createMirrorUrl(url) {
  if (typeof url === "string" && url.includes("://bcdn.hakunaymatata.com/")) {
    return url.replace("://bcdn.hakunaymatata.com/", "://bcdnxw.hakunaymatata.com/");
  }
  return null;
}

function resolveAgainst(url, base) {
  if (!url || url.startsWith("http")) return url;
  try {
    return new URL(url, base).toString();
  } catch (e) {
    return url;
  }
}

// O(1) auxiliary space streaming HLS master playlist parser.
// Avoids splitting multi-megabyte strings into arrays to prevent GC stalls in QuickJS/Hermes.
async function expandPlaylist(playlistUrl, headers, subtitles, title) {
  try {
    const text = await fetchText(playlistUrl, headers);
    const variants = [];
    
    // Single-pass regex scan over the playlist
    const streamInfRegex = /#EXT-X-STREAM-INF:[^\n]*?(?:RESOLUTION=(\d+)x(\d+))?[^\n]*\n([^\s#]+)/g;
    let match;

    while ((match = streamInfRegex.exec(text)) !== null) {
      const height = match[2] ? parseInt(match[2], 10) : null;
      const lineUrl = match[3].trim();
      const resolvedUrl = resolveAgainst(lineUrl, playlistUrl);
      const q = height ? qualityLabel(String(height)) : "Auto";

      variants.push({
        name: "7Movies - " + q,
        title: title,
        url: resolvedUrl,
        quality: q,
        headers: headers,
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

    // Fast-path: check in-memory cache O(1)
    const cached = streamCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.streams;
    }

    // Step 1: Encrypt TMDB id with O(1) caching
    let encHash = encCache.get(cleanId);
    if (!encHash) {
      const enc = await fetchJson(ENC_API + "?text=" + encodeURIComponent(cleanId), {
        "User-Agent": UA,
      });
      if (!enc || !enc.result) return [];
      encHash = enc.result;
      setBoundedCache(encCache, cleanId, encHash);
    }

    // Step 2: Query upstream VidLink JSON API
    const apiUrl = normType === "tv"
      ? `${VIDLINK_API}/tv/${encHash}/${s}/${ep}`
      : `${VIDLINK_API}/movie/${encHash}`;

    const data = await fetchJson(apiUrl, VIDLINK_HEADERS);
    if (!data || !data.stream) return [];

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
        const headers = playbackHeaders(qd);
        const mirrorUrl = createMirrorUrl(qd.url);

        // Add non-throttled alternate edge mirror (bcdnxw) first to avoid Nginx 429
        if (mirrorUrl) {
          streams.push({
            name: "7Movies - " + q + " (Mirror)",
            title: title + " - " + q + " (Mirror)",
            url: mirrorUrl,
            quality: q,
            headers: headers,
            subtitles: subtitles,
          });
        }

        streams.push({
          name: "7Movies - " + q,
          title: title + " - " + q + (qd.type ? " " + String(qd.type).toUpperCase() : ""),
          url: qd.url,
          quality: q,
          headers: headers,
          subtitles: subtitles,
        });
      }
    }

    // Step 4: Expand HLS master playlist if available
    if (stream.playlist) {
      const expanded = await expandPlaylist(
        stream.playlist,
        VIDLINK_HEADERS,
        subtitles,
        title
      );
      for (let i = 0; i < expanded.length; i++) {
        streams.push(expanded[i]);
      }
    }

    // Step 5: Sort by quality descending
    streams.sort(
      (a, b) => (QUALITY_ORDER[b.quality] || -2) - (QUALITY_ORDER[a.quality] || -2)
    );

    // Cache the result for 10 minutes
    if (streams.length > 0) {
      setBoundedCache(streamCache, cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        streams: streams,
      });
    }

    return streams;
  } catch (e) {
    console.error("[7Movies] " + (e && e.message ? e.message : e));
    return [];
  }
}

module.exports = { getStreams };

