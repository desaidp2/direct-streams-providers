/**
 * Splits each FlyStream HLS master into one stream per variant plus an "Auto" row, the way the
 * Movy provider already does, so players (WuPlay, Nuvio) can pick 1080p / 720p instead of only
 * the master labelled with its top resolution.
 *
 * Observed masters (2026-11-08): `dseg=1` 4K sources list 3840x2160 / 1920x1080 / 1280x720; `cv=`
 * widescreen sources list 1920x800 / 1280x534 / 640x266. Audio is muxed into every variant
 * (CODECS carries mp4a, no EXT-X-MEDIA), so a variant URL plays on its own. A master that DOES
 * declare separate audio renditions is left unsplit: a lone variant would play without sound.
 *
 * Cost: one master fetch per source, all in parallel, bounded by `timeoutMs`. Any failure keeps
 * the original single row. Runs on the server / companion only (the TV receives the split list).
 * Time O(m) per master of m bytes (one regex pass), space O(v) for v variants.
 */

const { fetchWithTimeout } = require("../shared/provider-utils");
const { parseMasterPlaylist } = require("../shared/hls-master-playlist-parser");
const { FLYSTREAM_VARIANT_RE, buildVariantUrl } = require("../shared/hls-variant-playlist");

// Row URL for one variant: a real .m3u8 is used as is; FlyStream's disguised ".ts" variant playlists
// go through the server's single-variant master (see shared/hls-variant-playlist.js); any other
// shape returns null and the master is left whole.
function variantRowUrl(v) {
  if (/\.m3u8(?:[?#]|$)/i.test(v.url)) return v.url;
  if (FLYSTREAM_VARIANT_RE.test(v.url)) return buildVariantUrl(v.url, v.bandwidth, v.width, v.height);
  return null;
}

const SEPARATE_AUDIO_RE = /#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO[^\r\n]*URI=/;

// Quality class from a variant's resolution. Widescreen encodes keep the width of their class but
// a shorter height (1920x800 is a 1080p encode), so the larger of the width and height classes wins.
function qualityFromResolution(width, height) {
  const byHeight = (h) => (h >= 2000 ? 2160 : h >= 1300 ? 1440 : h >= 1000 ? 1080 : h >= 700 ? 720 : h >= 460 ? 480 : h ? 360 : 0);
  const byWidth = (w) => (w >= 3200 ? 2160 : w >= 2400 ? 1440 : w >= 1700 ? 1080 : w >= 1100 ? 720 : w >= 800 ? 480 : w ? 360 : 0);
  const p = Math.max(byHeight(height || 0), byWidth(width || 0));
  if (!p) return null;
  return p === 2160 ? "4K" : p + "p";
}

// "FlyStream S1 - 2160p" -> "FlyStream S1"
function namePrefix(name) {
  const i = name.lastIndexOf(" - ");
  return i > 0 ? name.slice(0, i) : name;
}

// Title is "FlyStream <name> · <quality>\n<quality> · <codec> · <size>". Line 1 loses the site's
// quality suffix (it named the master, not this row); line 2 is rebuilt for the row.
function titleFor(stream, label, extra) {
  const lines = String(stream.title || "").split("\n");
  const head = lines[0].replace(/ · (?:\d{3,4}p|4K|Auto)$/i, "");
  const rest = (lines[1] || "").split(" · ").slice(1);
  return [head, [label].concat(extra || [], rest).filter(Boolean).join(" · ")].join("\n");
}

async function expandStream(stream, timeoutMs) {
  if (!/\.m3u8(?:[?#]|$)/i.test(stream.url)) return [stream];
  try {
    const res = await fetchWithTimeout(stream.url, { headers: stream.headers || {} }, timeoutMs, "FlyStream master");
    if (!res || !res.ok) return [stream];
    const text = await res.text();
    if (SEPARATE_AUDIO_RE.test(text)) return [stream];
    const variants = parseMasterPlaylist(text, stream.url).filter((v) => v.url && (v.width || v.height));
    if (variants.length < 2) return [stream];
    const urls = variants.map(variantRowUrl);
    if (urls.some((u) => !u)) return [stream];

    const prefix = namePrefix(stream.name);
    const rows = [];
    let top = null;
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const q = qualityFromResolution(v.width, v.height);
      if (!q) continue;
      if (!top) top = q;
      rows.push(
        Object.assign({}, stream, {
          name: `${prefix} - ${q}`,
          title: titleFor(stream, q, [v.width && v.height ? `${v.width}×${v.height}` : ""]),
          url: urls[i],
          quality: q,
        })
      );
    }
    if (rows.length < 2) return [stream];
    const best = rows.reduce((a, b) => (rank(b.quality) > rank(a.quality) ? b : a)).quality;
    rows.push(
      Object.assign({}, stream, {
        name: `${prefix} - Auto`,
        title: titleFor(stream, `Auto (up to ${best})`),
        quality: "Auto",
      })
    );
    return rows;
  } catch (_) {
    return [stream];
  }
}

function rank(q) {
  return q === "4K" ? 2160 : parseInt(q, 10) || 0;
}

/**
 * @param {Array} streams mapped FlyStream streams (each with url, name, title, headers)
 * @param {number} timeoutMs per-master bound; all masters are fetched in parallel
 * @returns {Promise<Array>} variant rows + Auto row per splittable master, others unchanged;
 *   duplicate URLs dropped.
 */
async function expandHlsVariants(streams, timeoutMs) {
  const parts = await Promise.all(streams.map((s) => expandStream(s, timeoutMs)));
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    for (const s of part) {
      const key = s.url + "|" + s.quality;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

module.exports = { expandHlsVariants, qualityFromResolution };
