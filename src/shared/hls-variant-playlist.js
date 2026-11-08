/**
 * Single-variant HLS master playlists served by the add-on server.
 *
 * FlyStream names its variant playlists like MPEG-TS files (`.../asset/<token>.ts`). Players infer
 * the stream type from the URL, treat such a URL as a progressive TS file and fail
 * (ExoPlayer: UnrecognizedInputFormatException) before falling back to sniffing. So a variant row
 * points at a tiny master on this server instead:
 *
 *   GET /hls/flystream/variant.m3u8?u=<variant url>&b=<bandwidth>&r=<WxH>
 *   -> #EXTM3U / #EXT-X-STREAM-INF:BANDWIDTH=..,RESOLUTION=.. / <variant url>
 *
 * The player then loads the variant playlist and its segments straight from the site with the
 * stream's proxy headers. The server only echoes ~150 bytes and never fetches anything, and it
 * accepts exactly the observed FlyStream variant URL shape (endpoint allowlist, no CR/LF), so the
 * route cannot be pointed at other hosts or used to inject playlist lines.
 *
 * Variant rows are built with a base-URL placeholder (the provider does not know the host the
 * client used); the router swaps in its own base URL per response.
 */

const VARIANT_BASE_TOKEN = "dsp-variant-base:";
const VARIANT_PATH = "/hls/flystream/variant.m3u8";
const FLYSTREAM_VARIANT_RE = /^https:\/\/flystream\.net\/source-hls\/[0-9a-f]{32}\/asset\/[A-Za-z0-9_-]{8,2048}\.ts$/;

function buildVariantUrl(variantUrl, bandwidth, width, height) {
  let qs = "u=" + encodeURIComponent(variantUrl) + "&b=" + (bandwidth > 0 ? Math.floor(bandwidth) : 1);
  if (width > 0 && height > 0) qs += "&r=" + width + "x" + height;
  return VARIANT_BASE_TOKEN + VARIANT_PATH + "?" + qs;
}

// Swaps the placeholder for the server's base URL. O(1) per stream.
function resolveVariantUrl(url, baseUrl) {
  if (typeof url !== "string" || url.indexOf(VARIANT_BASE_TOKEN) !== 0) return url;
  return (baseUrl || "").replace(/\/+$/, "") + url.slice(VARIANT_BASE_TOKEN.length);
}

/**
 * @param {object} query parsed query string ({ u, b, r })
 * @returns {{status: number, body: string}} playlist, or 400 when anything is off
 */
function renderVariantPlaylist(query) {
  const u = typeof query.u === "string" ? query.u : "";
  const b = typeof query.b === "string" ? query.b : "";
  const r = typeof query.r === "string" ? query.r : "";
  if (!FLYSTREAM_VARIANT_RE.test(u) || !/^\d{1,10}$/.test(b) || (r && !/^\d{2,5}x\d{2,5}$/.test(r))) {
    return { status: 400, body: "#EXTM3U\n# invalid variant\n" };
  }
  const inf = "#EXT-X-STREAM-INF:BANDWIDTH=" + b + (r ? ",RESOLUTION=" + r : "");
  return { status: 200, body: "#EXTM3U\n#EXT-X-VERSION:4\n" + inf + "\n" + u + "\n" };
}

module.exports = { VARIANT_BASE_TOKEN, VARIANT_PATH, FLYSTREAM_VARIANT_RE, buildVariantUrl, resolveVariantUrl, renderVariantPlaylist };
