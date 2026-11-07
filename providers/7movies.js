/**
 * 7movies - Built from src/7movies/
 * Generated: 2026-11-07T11:35:00.375Z
 */
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/7movies/index.js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var VIDLINK_API = "https://vidlink.pro/api/b";
var ENC_API = "https://enc-dec.app/api/enc-vidlink";
var VIDLINK_HEADERS = {
  "User-Agent": UA,
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro"
};
var QUALITY_ORDER = {
  "4K": 6,
  "1440p": 5,
  "1080p": 4,
  "720p": 3,
  "480p": 2,
  "360p": 1,
  Auto: 0,
  Unknown: -1
};
var LANG_CODES = {
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
  thai: "th"
};
function fetchJson(url, headers) {
  return __async(this, null, function* () {
    const res = yield fetch(url, { headers: headers || {} });
    if (!res.ok)
      throw new Error("HTTP " + res.status + " for " + url);
    return yield res.json();
  });
}
function fetchText(url, headers) {
  return __async(this, null, function* () {
    const res = yield fetch(url, { headers: headers || {} });
    if (!res.ok)
      throw new Error("HTTP " + res.status + " for " + url);
    return yield res.text();
  });
}
function qualityLabel(key) {
  const n = parseInt(key, 10);
  if (!isNaN(n)) {
    if (n >= 2160)
      return "4K";
    if (n >= 1440)
      return "1440p";
    if (n >= 1080)
      return "1080p";
    if (n >= 720)
      return "720p";
    if (n >= 480)
      return "480p";
    if (n >= 360)
      return "360p";
    return n + "p";
  }
  const s = String(key || "").toLowerCase();
  if (s.includes("2160") || s.includes("4k"))
    return "4K";
  if (s.includes("1080"))
    return "1080p";
  if (s.includes("720"))
    return "720p";
  if (s.includes("480"))
    return "480p";
  if (s.includes("360"))
    return "360p";
  return "Unknown";
}
function mapSubtitles(captions) {
  if (!Array.isArray(captions))
    return [];
  const out = [];
  for (const c of captions) {
    if (!c || !c.url)
      continue;
    const name = c.language || c.label || c.name || "Unknown";
    const code = LANG_CODES[String(name).trim().toLowerCase()] || (String(name).length === 2 ? String(name).toLowerCase() : "und");
    out.push({
      url: c.url,
      language: code,
      name: String(name),
      headers: { "User-Agent": UA }
    });
  }
  return out;
}
function playbackHeaders(qualityData) {
  const h = { "User-Agent": UA };
  const src = qualityData && qualityData.headers || {};
  const referer = src.referer || src.Referer;
  const origin = src.origin || src.Origin;
  if (referer)
    h.Referer = referer;
  if (origin)
    h.Origin = origin;
  if (!referer && !origin) {
    h.Referer = VIDLINK_HEADERS.Referer;
    h.Origin = VIDLINK_HEADERS.Origin;
  }
  return h;
}
function resolveAgainst(url, base) {
  if (!url || url.startsWith("http"))
    return url;
  try {
    return new URL(url, base).toString();
  } catch (e) {
    return url;
  }
}
function expandPlaylist(playlistUrl, headers, subtitles, title) {
  return __async(this, null, function* () {
    try {
      const text = yield fetchText(playlistUrl, headers);
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      const variants = [];
      let current = null;
      for (const line of lines) {
        if (line.startsWith("#EXT-X-STREAM-INF:")) {
          current = {};
          const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
          if (res)
            current.height = parseInt(res[2], 10);
        } else if (current && !line.startsWith("#")) {
          current.url = resolveAgainst(line, playlistUrl);
          variants.push(current);
          current = null;
        }
      }
      if (!variants.length)
        throw new Error("no variants");
      return variants.map((v) => {
        const q = v.height ? qualityLabel(String(v.height)) : "Auto";
        return {
          name: "7Movies - " + q,
          title,
          url: v.url,
          quality: q,
          headers,
          subtitles
        };
      });
    } catch (e) {
      return [
        {
          name: "7Movies - Auto",
          title,
          url: playlistUrl,
          quality: "Auto",
          headers,
          subtitles
        }
      ];
    }
  });
}
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      const enc = yield fetchJson(ENC_API + "?text=" + encodeURIComponent(tmdbId), {
        "User-Agent": UA
      });
      if (!enc || !enc.result)
        return [];
      let apiUrl;
      if (mediaType === "tv") {
        apiUrl = VIDLINK_API + "/tv/" + enc.result + "/" + (season || 1) + "/" + (episode || 1);
      } else {
        apiUrl = VIDLINK_API + "/movie/" + enc.result;
      }
      const data = yield fetchJson(apiUrl, VIDLINK_HEADERS);
      if (!data || !data.stream)
        return [];
      const stream = data.stream;
      const subtitles = mapSubtitles(stream.captions || data.captions);
      const title = mediaType === "tv" ? "S" + String(season || 1).padStart(2, "0") + "E" + String(episode || 1).padStart(2, "0") : "Movie";
      const streams = [];
      if (stream.qualities) {
        for (const key of Object.keys(stream.qualities)) {
          const qd = stream.qualities[key];
          if (!qd || !qd.url)
            continue;
          const q = qualityLabel(key);
          streams.push({
            name: "7Movies - " + q,
            title: title + " - " + q + (qd.type ? " " + String(qd.type).toUpperCase() : ""),
            url: qd.url,
            quality: q,
            headers: playbackHeaders(qd),
            subtitles
          });
        }
      }
      if (stream.playlist) {
        const expanded = yield expandPlaylist(
          stream.playlist,
          VIDLINK_HEADERS,
          subtitles,
          title
        );
        for (const s of expanded)
          streams.push(s);
      }
      streams.sort(
        (a, b) => (QUALITY_ORDER[b.quality] || -2) - (QUALITY_ORDER[a.quality] || -2)
      );
      return streams;
    } catch (e) {
      console.error("[7Movies] " + (e && e.message ? e.message : e));
      return [];
    }
  });
}
module.exports = { getStreams };
