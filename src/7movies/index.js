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

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers: headers || {} });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return await res.json();
}

async function fetchText(url, headers) {
  const res = await fetch(url, { headers: headers || {} });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
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
  for (const c of captions) {
    if (!c || !c.url) continue;
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

function resolveAgainst(url, base) {
  if (!url || url.startsWith("http")) return url;
  try {
    return new URL(url, base).toString();
  } catch (e) {
    return url;
  }
}

// Expand an HLS master playlist into per-quality streams. Falls back
// to the master URL itself when there are no variants.
async function expandPlaylist(playlistUrl, headers, subtitles, title) {
  try {
    const text = await fetchText(playlistUrl, headers);
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const variants = [];
    let current = null;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        current = {};
        const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
        if (res) current.height = parseInt(res[2], 10);
      } else if (current && !line.startsWith("#")) {
        current.url = resolveAgainst(line, playlistUrl);
        variants.push(current);
        current = null;
      }
    }
    if (!variants.length) throw new Error("no variants");
    return variants.map((v) => {
      const q = v.height ? qualityLabel(String(v.height)) : "Auto";
      return {
        name: "7Movies - " + q,
        title: title,
        url: v.url,
        quality: q,
        headers: headers,
        subtitles: subtitles,
      };
    });
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
    const enc = await fetchJson(ENC_API + "?text=" + encodeURIComponent(tmdbId), {
      "User-Agent": UA,
    });
    if (!enc || !enc.result) return [];

    let apiUrl;
    if (mediaType === "tv") {
      apiUrl =
        VIDLINK_API +
        "/tv/" +
        enc.result +
        "/" +
        (season || 1) +
        "/" +
        (episode || 1);
    } else {
      apiUrl = VIDLINK_API + "/movie/" + enc.result;
    }

    const data = await fetchJson(apiUrl, VIDLINK_HEADERS);
    if (!data || !data.stream) return [];

    const stream = data.stream;
    const subtitles = mapSubtitles(stream.captions || data.captions);
    const title =
      mediaType === "tv"
        ? "S" +
          String(season || 1).padStart(2, "0") +
          "E" +
          String(episode || 1).padStart(2, "0")
        : "Movie";

    const streams = [];

    if (stream.qualities) {
      for (const key of Object.keys(stream.qualities)) {
        const qd = stream.qualities[key];
        if (!qd || !qd.url) continue;
        const q = qualityLabel(key);
        streams.push({
          name: "7Movies - " + q,
          title: title + " - " + q + (qd.type ? " " + String(qd.type).toUpperCase() : ""),
          url: qd.url,
          quality: q,
          headers: playbackHeaders(qd),
          subtitles: subtitles,
        });
      }
    }

    if (stream.playlist) {
      const expanded = await expandPlaylist(
        stream.playlist,
        VIDLINK_HEADERS,
        subtitles,
        title
      );
      for (const s of expanded) streams.push(s);
    }

    streams.sort(
      (a, b) => (QUALITY_ORDER[b.quality] || -2) - (QUALITY_ORDER[a.quality] || -2)
    );
    return streams;
  } catch (e) {
    console.error("[7Movies] " + (e && e.message ? e.message : e));
    return [];
  }
}

module.exports = { getStreams };
