/**
 * Shared helpers for every provider (bundled into each providers/<name>.js by build.js).
 *
 * Hermes / QuickJS safe: no AbortController, Buffer or Node built-ins are required.
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
function qualityRank(quality) {
  return Object.prototype.hasOwnProperty.call(QUALITY_ORDER, quality)
    ? QUALITY_ORDER[quality]
    : -2;
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

module.exports = { QUALITY_ORDER, qualityRank, sortByQuality, withTimeout, TtlCache };
