/**
 * flystream - Built from src/flystream/
 * Generated: 2026-11-08T10:16:35.194Z
 */
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
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

// src/shared/provider-utils.js
var require_provider_utils = __commonJS({
  "src/shared/provider-utils.js"(exports2, module2) {
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
    function qualityRank(quality) {
      return Object.prototype.hasOwnProperty.call(QUALITY_ORDER, quality) ? QUALITY_ORDER[quality] : -2;
    }
    function sortByQuality2(streams) {
      return streams.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    }
    function withTimeout2(promise, ms, label) {
      if (typeof setTimeout !== "function")
        return promise;
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error((label || "Timeout") + " " + ms + "ms")), ms);
      });
      return Promise.race([promise, timeoutPromise]).then(
        (value) => {
          if (typeof clearTimeout === "function")
            clearTimeout(timer);
          return value;
        },
        (err) => {
          if (typeof clearTimeout === "function")
            clearTimeout(timer);
          throw err;
        }
      );
    }
    var TtlCache2 = class {
      constructor(limit, defaultTtlMs) {
        this.limit = limit;
        this.defaultTtlMs = defaultTtlMs;
        this.map = /* @__PURE__ */ new Map();
      }
      get(key) {
        const entry = this.map.get(key);
        if (!entry)
          return void 0;
        if (entry.expiresAt <= Date.now()) {
          this.map.delete(key);
          return void 0;
        }
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
      }
      has(key) {
        return this.get(key) !== void 0;
      }
      set(key, value, ttlMs) {
        if (this.map.has(key))
          this.map.delete(key);
        else if (this.map.size >= this.limit)
          this.map.delete(this.map.keys().next().value);
        this.map.set(key, { value, expiresAt: Date.now() + (ttlMs || this.defaultTtlMs) });
      }
      delete(key) {
        this.map.delete(key);
      }
      get size() {
        return this.map.size;
      }
    };
    module2.exports = { QUALITY_ORDER, qualityRank, sortByQuality: sortByQuality2, withTimeout: withTimeout2, TtlCache: TtlCache2 };
  }
});

// src/flystream/flystream-api-streams.js
var require_flystream_api_streams = __commonJS({
  "src/flystream/flystream-api-streams.js"(exports2, module2) {
    var { withTimeout: withTimeout2 } = require_provider_utils();
    var API_BASE = "https://flystream.net";
    var BROWSER_UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    var API_HEADERS = {
      "User-Agent": BROWSER_UA2,
      Referer: API_BASE + "/",
      Accept: "application/json"
    };
    var PLAYBACK_HEADERS = {
      "User-Agent": BROWSER_UA2,
      Referer: API_BASE + "/"
    };
    var API_TIMEOUT_MS = 5e3;
    function randomViewerId() {
      let out = "";
      for (let i = 0; i < 32; i++)
        out += Math.floor(Math.random() * 16).toString(16);
      return out;
    }
    function buildApiParams({ mediaType, title, tmdbId, imdbId, year, season, episode, viewerId }) {
      const isTv = mediaType === "tv";
      const params = [
        ["type", isTv ? "tv" : "movie"],
        ["viewerId", viewerId || randomViewerId()],
        ["title", title || ""]
      ];
      if (tmdbId != null && tmdbId !== "")
        params.push(["tmdbId", String(tmdbId)]);
      if (imdbId)
        params.push(["imdb", String(imdbId)]);
      if (year != null && year !== "")
        params.push(["year", String(year)]);
      if (isTv && season != null)
        params.push(["season", String(season)]);
      if (isTv && episode != null)
        params.push(["episode", String(episode)]);
      return params;
    }
    function buildApiUrl(params) {
      const qs = params.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
      return `${API_BASE}/api/streams?${qs}`;
    }
    function normalizeQuality(raw) {
      const q = String(raw || "");
      if (/2160|4k|uhd/i.test(q))
        return "4K";
      if (/1440/.test(q))
        return "1440p";
      if (/1080/.test(q))
        return "1080p";
      if (/720/.test(q))
        return "720p";
      if (/480/.test(q))
        return "480p";
      if (/360/.test(q))
        return "360p";
      return "Auto";
    }
    function str(v) {
      return v == null ? "" : String(v);
    }
    function mapApiStreams(data, fallbackTitle, session) {
      const list = data && Array.isArray(data.streams) ? data.streams : [];
      const streams = [];
      const seen = /* @__PURE__ */ new Set();
      const ua = session && session.userAgent || BROWSER_UA2;
      const playbackHeaders = {
        "User-Agent": ua,
        Referer: API_BASE + "/"
      };
      if (session && session.cookie) {
        playbackHeaders["Cookie"] = session.cookie;
      }
      for (const s of list) {
        if (!s || typeof s !== "object")
          continue;
        const rawUrl = str(s.url);
        if (!rawUrl)
          continue;
        const url = rawUrl.startsWith("/") ? API_BASE + rawUrl : rawUrl;
        if (!/^https?:\/\//i.test(url) || seen.has(url))
          continue;
        seen.add(url);
        const qualityLabel = str(s.quality) || "Auto";
        const codec = str(s.videoCodec);
        const size = str(s.size);
        const name = str(s.name) || str(s.title) || fallbackTitle || "Stream";
        const details = [qualityLabel, codec ? codec.toUpperCase() : "", size].filter(Boolean).join(" \xB7 ");
        const stream = {
          name: `FlyStream - ${qualityLabel}`,
          title: `FlyStream ${name}
${details || "Direct HLS Stream"}`,
          url,
          quality: normalizeQuality(qualityLabel),
          headers: playbackHeaders,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: { request: playbackHeaders }
          },
          subtitles: []
        };
        if (size)
          stream.size = size;
        streams.push(stream);
      }
      return streams;
    }
    var BROWSER_API_TIMEOUT_MS = 6500;
    function hostChallengeBrowser() {
      return typeof challengeBrowser !== "undefined" && challengeBrowser && typeof challengeBrowser.execute === "function" ? challengeBrowser : null;
    }
    var BROWSER_ORIGIN_PAGE = API_BASE + "/robots.txt";
    function inPageFetchJs(path) {
      return "(async () => { const r = await fetch(" + JSON.stringify(path) + ", { headers: { Accept: 'application/json' }, credentials: 'same-origin' }); return JSON.stringify({ status: r.status, body: await r.text() }); })()";
    }
    function fetchViaHostBrowser(cb, url, title) {
      return __async(this, null, function* () {
        try {
          const r = yield withTimeout2(
            cb.execute(BROWSER_ORIGIN_PAGE, {
              reuse: true,
              evaluateJs: inPageFetchJs(url.slice(API_BASE.length)),
              timeoutMs: BROWSER_API_TIMEOUT_MS
            }),
            BROWSER_API_TIMEOUT_MS + 500,
            "FlyStream API (browser)"
          );
          const res = JSON.parse(String(r && r.result || ""));
          if (res.status !== 200)
            return { ok: false, reason: `browser HTTP ${res.status}` };
          const cookie = r && r.cookies || (typeof cb.getCookies === "function" ? yield cb.getCookies() : "");
          const userAgent = r && r.userAgent || (typeof cb.getUserAgent === "function" ? yield cb.getUserAgent() : BROWSER_UA2);
          return {
            ok: true,
            streams: mapApiStreams(JSON.parse(res.body), title, { cookie, userAgent }),
            via: "browser"
          };
        } catch (err) {
          return { ok: false, reason: "browser: " + String(err && err.message || err) };
        }
      });
    }
    var BUILD_COMPANION_URL = true ? "" : "";
    function getCompanionCandidates() {
      const envUrl = typeof process !== "undefined" && process.env ? process.env.FLYSTREAM_COMPANION_URL : null;
      const list = [];
      if (BUILD_COMPANION_URL)
        list.push(BUILD_COMPANION_URL);
      if (envUrl) {
        envUrl.split(",").map((s) => s.trim()).filter(Boolean).forEach((u) => list.push(u));
      }
      list.push("http://127.0.0.1:7070");
      return [...new Set(list)];
    }
    function fetchViaCompanion(query) {
      return __async(this, null, function* () {
        const candidates = getCompanionCandidates();
        const qs = buildApiParams(query).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
        for (const host of candidates) {
          try {
            const endpoint = `${host.replace(/\/+$/, "")}/companion/flystream?${qs}`;
            console.log(`[FlyStream] Querying companion: ${endpoint}`);
            const res = yield withTimeout2(fetch(endpoint), 8e3, "FlyStream Companion");
            if (res && res.ok) {
              const data = yield res.json();
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
      });
    }
    function fetchApiStreams2(query) {
      return __async(this, null, function* () {
        const cb = hostChallengeBrowser();
        if (cb) {
          const url2 = buildApiUrl(buildApiParams(query));
          return fetchViaHostBrowser(cb, url2, query.title);
        }
        const companionResult = yield fetchViaCompanion(query);
        if (companionResult && companionResult.ok) {
          return companionResult;
        }
        const url = buildApiUrl(buildApiParams(query));
        try {
          const res = yield withTimeout2(fetch(url, { headers: API_HEADERS }), API_TIMEOUT_MS, "FlyStream API");
          if (res.status !== 200)
            return { ok: false, reason: `HTTP ${res.status}` };
          const data = JSON.parse(yield res.text());
          return { ok: true, streams: mapApiStreams(data, query.title) };
        } catch (err) {
          return { ok: false, reason: String(err && err.message || err) };
        }
      });
    }
    module2.exports = {
      API_BASE,
      PLAYBACK_HEADERS,
      randomViewerId,
      buildApiParams,
      buildApiUrl,
      normalizeQuality,
      mapApiStreams,
      fetchApiStreams: fetchApiStreams2
    };
  }
});

// src/flystream/tmdb-title-metadata.js
var require_tmdb_title_metadata = __commonJS({
  "src/flystream/tmdb-title-metadata.js"(exports2, module2) {
    var { withTimeout: withTimeout2, TtlCache: TtlCache2 } = require_provider_utils();
    var TMDB_PROXY = "https://db.wecollege.net/3";
    var META_TIMEOUT_MS = 2e3;
    var META_TTL_MS = 6 * 60 * 60 * 1e3;
    var MISS_TTL_MS = 5 * 60 * 1e3;
    var metaCache = new TtlCache2(200, META_TTL_MS);
    function pickTitleMetadata(data, mediaType) {
      if (!data || typeof data !== "object")
        return {};
      const isTv = mediaType === "tv";
      const title = (isTv ? data.name || data.original_name : data.title || data.original_title) || void 0;
      const date = (isTv ? data.first_air_date : data.release_date) || "";
      const yearMatch = /^(\d{4})/.exec(String(date));
      const imdb = data.external_ids && data.external_ids.imdb_id || data.imdb_id || void 0;
      return {
        title: title ? String(title) : void 0,
        year: yearMatch ? parseInt(yearMatch[1], 10) : void 0,
        imdbId: imdb && /^tt\d+$/.test(imdb) ? imdb : void 0
      };
    }
    function fetchTitleMetadata2(tmdbId, mediaType) {
      return __async(this, null, function* () {
        const key = `${mediaType}:${tmdbId}`;
        const cached = metaCache.get(key);
        if (cached)
          return cached;
        let meta = {};
        try {
          const url = `${TMDB_PROXY}/${mediaType}/${encodeURIComponent(tmdbId)}?append_to_response=external_ids`;
          const res = yield withTimeout2(
            fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }),
            META_TIMEOUT_MS,
            "FlyStream TMDB meta"
          );
          if (res.ok)
            meta = pickTitleMetadata(yield res.json(), mediaType);
        } catch (err) {
          console.warn("[FlyStream] title metadata lookup failed:", err.message || err);
        }
        metaCache.set(key, meta, meta.title ? META_TTL_MS : MISS_TTL_MS);
        return meta;
      });
    }
    module2.exports = { fetchTitleMetadata: fetchTitleMetadata2, pickTitleMetadata };
  }
});

// src/flystream/index.js
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var BASE_URL = "https://flystream.net";
var HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: BASE_URL + "/",
  Origin: BASE_URL,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
};
var { sortByQuality, withTimeout, TtlCache } = require_provider_utils();
var { fetchApiStreams } = require_flystream_api_streams();
var { fetchTitleMetadata } = require_tmdb_title_metadata();
var MAX_CACHE_SIZE = 100;
var CACHE_TTL_MS = 10 * 60 * 1e3;
var EMPTY_TTL_MS = 5 * 60 * 1e3;
var PAGE_TIMEOUT_MS = 5e3;
var streamCache = new TtlCache(MAX_CACHE_SIZE, CACHE_TTL_MS);
function fetchPageDOM(url, timeoutMs) {
  return __async(this, null, function* () {
    try {
      return yield withTimeout(loadPage(url), timeoutMs || PAGE_TIMEOUT_MS, "FlyStream page");
    } catch (err) {
      console.error("[FlyStream] fetchPageDOM failed:", err.message || err);
      return null;
    }
  });
}
function loadPage(url) {
  return __async(this, null, function* () {
    if (typeof challengeBrowser !== "undefined" && challengeBrowser && typeof challengeBrowser.execute === "function") {
      try {
        const response = yield challengeBrowser.execute(url, {
          method: "GET",
          headers: { "User-Agent": BROWSER_UA },
          evaluateJs: "document.documentElement.outerHTML",
          waitForSelector: "body"
        });
        if (response && response.result) {
          return response.result;
        }
      } catch (cbErr) {
        console.warn("[FlyStream] challengeBrowser error, falling back to fetch:", cbErr.message || cbErr);
      }
    }
    const res = yield fetch(url, {
      method: "GET",
      headers: HEADERS,
      cache: "no-store"
    });
    if (res.status === 403 || res.status === 401) {
      console.warn(`[FlyStream] Endpoint gated (${res.status}) on ${url}`);
      return null;
    }
    if (!res.ok) {
      return null;
    }
    return yield res.text();
  });
}
function search(query) {
  return __async(this, null, function* () {
    try {
      const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
      const htmlContent = yield fetchPageDOM(searchUrl);
      if (!htmlContent)
        return [];
      const results = [];
      const stateMatch = htmlContent.match(/__FLYCAST_DATA__\s*=\s*(\{.*?\});/);
      if (stateMatch) {
        try {
          const pageData = JSON.parse(stateMatch[1]);
          if (pageData && Array.isArray(pageData.results)) {
            return pageData.results.map((item) => ({
              title: item.title || item.name,
              url: `${BASE_URL}/${item.media_type || "movie"}/${item.id}`,
              poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "",
              type: item.media_type === "tv" ? "tv" : "movie",
              id: item.id
            }));
          }
        } catch (e) {
        }
      }
      const cardRegex = /<a\s+href="\/([^"]+)"[^>]*class="[^"]*card[^"]*"[^>]*([\s\S]*?)<\/a>/g;
      let match;
      while ((match = cardRegex.exec(htmlContent)) !== null) {
        const path = match[1];
        const innerHtml = match[2];
        const titleMatch = innerHtml.match(/class="title"[^>]*>([^<]+)/);
        const imgMatch = innerHtml.match(/src="([^"]+)"/);
        if (path && titleMatch) {
          const isTv = path.startsWith("tv/");
          results.push({
            title: titleMatch[1].trim(),
            url: `${BASE_URL}/${path}`,
            poster: imgMatch ? imgMatch[1] : "",
            type: isTv ? "tv" : "movie"
          });
        }
      }
      return results;
    } catch (err) {
      console.error("[FlyStream] Search error:", err.message || err);
      return [];
    }
  });
}
function getStreams(tmdbId, mediaType = "movie", season = 1, episode = 1) {
  return __async(this, null, function* () {
    if (!tmdbId)
      return [];
    const normType = mediaType === "series" || mediaType === "tv" ? "tv" : "movie";
    const s = normType === "tv" ? season || 1 : null;
    const e = normType === "tv" ? episode || 1 : null;
    const cacheKey = `${normType}:${tmdbId}:${s}:${e}`;
    const cached = streamCache.get(cacheKey);
    if (cached)
      return cached;
    try {
      const meta = yield fetchTitleMetadata(String(tmdbId), normType);
      const result = yield fetchApiStreams({
        mediaType: normType,
        title: meta.title,
        tmdbId,
        imdbId: meta.imdbId,
        year: meta.year,
        season: s,
        episode: e
      });
      if (!result.ok)
        console.warn(`[FlyStream] API call failed (${result.reason}) for ${cacheKey}`);
      const streams = result.ok ? sortByQuality(result.streams) : [];
      streamCache.set(cacheKey, streams, streams.length ? CACHE_TTL_MS : EMPTY_TTL_MS);
      console.log(`[FlyStream] ${streams.length} stream(s) for ${cacheKey}`);
      return streams;
    } catch (err) {
      console.error("[FlyStream] getStreams error:", err.message || err);
      return [];
    }
  });
}
module.exports = {
  getStreams,
  search,
  fetchPageDOM
};
