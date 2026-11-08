/**
 * Shared helpers for every provider (bundled into each providers/<name>.js by build.js).
 *
 * Hermes / QuickJS safe: no AbortController, Buffer or Node built-ins are required
 * (fetchWithTimeout uses AbortController only when the runtime has one).
 */

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

// Labels outside the table (e.g. "240p") rank below Unknown.
// The old `QUALITY_ORDER[q] || -2` turned Auto (0) into -2, sorting it under Unknown.
// Non-standard heights inside the table's range ("900p" from Movy's Reno server) rank between
// their neighbours by linear interpolation, so 900p sorts after 1080p and before 720p.
const HEIGHT_STEPS = [
  [360, 1],
  [480, 2],
  [720, 3],
  [1080, 4],
  [1440, 5],
  [2160, 6],
];
function qualityRank(quality) {
  if (Object.prototype.hasOwnProperty.call(QUALITY_ORDER, quality)) return QUALITY_ORDER[quality];
  const m = /^(\d{3,4})p$/.exec(String(quality));
  if (m) {
    const h = parseInt(m[1], 10);
    for (let i = 1; i < HEIGHT_STEPS.length; i++) {
      const [h0, r0] = HEIGHT_STEPS[i - 1];
      const [h1, r1] = HEIGHT_STEPS[i];
      if (h > h0 && h < h1) return r0 + ((h - h0) / (h1 - h0)) * (r1 - r0);
    }
  }
  return -2;
}

// In-place stable sort, highest quality first. O(S log S) time, O(1) extra space.
function sortByQuality(streams) {
  return streams.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
}

/**
 * Rejects after `ms` unless `promise` settles first. The timer is always cleared,
 * so a settled request never keeps the event loop alive.
 */
function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== "function") return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || "Timeout") + " " + ms + "ms")), ms);
  });
  return Promise.race([promise, timeoutPromise]).then(
    (value) => {
      if (typeof clearTimeout === "function") clearTimeout(timer);
      return value;
    },
    (err) => {
      if (typeof clearTimeout === "function") clearTimeout(timer);
      throw err;
    }
  );
}

/**
 * fetch() bounded by `ms`. Where the runtime has AbortController (Node 17.3+, browsers,
 * Workers) the request itself is aborted at the deadline, so a stalled upstream no longer
 * holds its socket and response buffers open after the caller has given up. On runtimes
 * without it this degrades to withTimeout: same latency bound, the request just finishes
 * in the background as before.
 *
 * Nuvio (Android TV, QuickJS): the plugin runtime polyfills AbortController, but its fetch
 * wraps a synchronous `__native_fetch`, checking `signal.aborted` only before and after the
 * native call. No timer can fire during that call, so neither the timeout nor the abort can
 * cut a Nuvio request short; passing the signal is harmless there. The bound and the
 * socket release apply on Node (server.js, the Pi companion) and Workers.
 */
function fetchWithTimeout(url, init, ms, label) {
  if (typeof AbortController !== "function" || typeof setTimeout !== "function") {
    return withTimeout(fetch(url, init), ms, label);
  }
  // One timer (withTimeout's): on its rejection the request is aborted, so callers still see
  // the labelled "<label> <ms>ms" error rather than a bare AbortError.
  const controller = new AbortController();
  const opts = Object.assign({}, init || {}, { signal: controller.signal });
  return withTimeout(fetch(url, opts), ms, label).catch((err) => {
    controller.abort();
    throw err;
  });
}

/**
 * Bounded LRU cache with per-entry TTL.
 * get/set/delete are O(1): a Map keeps insertion order, and a hit re-inserts the key
 * so eviction drops the least recently used entry (the old helper evicted FIFO, so a
 * hot title could be evicted by 100 one-off lookups). Space is O(limit).
 */
class TtlCache {
  constructor(limit, defaultTtlMs) {
    this.limit = limit;
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value: value, expiresAt: Date.now() + (ttlMs || this.defaultTtlMs) });
  }

  delete(key) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { QUALITY_ORDER, qualityRank, sortByQuality, withTimeout, fetchWithTimeout, TtlCache };
