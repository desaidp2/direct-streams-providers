/**
 * HLS master playlist parser shared by 7Movies (VidLink) and FlyStream (source-hls) playlists.
 *
 * One regex pass over the text: O(n) time, O(v) space for v variants, and no
 * split("\n") copy of the whole playlist.
 *
 * The old single regex `#EXT-X-STREAM-INF:[^\n]*?(?:RESOLUTION=(\d+)x(\d+))?[^\n]*\n`
 * never captured RESOLUTION: the lazy `[^\n]*?` stops at zero chars, the optional
 * group matches empty there, and `[^\n]*` eats the rest, so every variant was "Auto".
 * Here the attribute list is captured whole and RESOLUTION is read from it.
 */

// group 1: attribute list, group 2: the variant URI on the next non-comment line
const STREAM_INF_RE = /#EXT-X-STREAM-INF:([^\r\n]*)\r?\n\s*([^\s#][^\r\n]*)/g;
const RESOLUTION_RE = /(?:^|,)RESOLUTION=(\d+)x(\d+)/;
const BANDWIDTH_RE = /(?:^|,)BANDWIDTH=(\d+)/;

function resolveAgainst(url, base) {
  if (!url || url.startsWith("http")) return url;
  try {
    return new URL(url, base).toString();
  } catch (e) {
    return url;
  }
}

/**
 * @param {string} text Playlist body
 * @param {string} playlistUrl Absolute URL the playlist was fetched from
 * @returns {Array<{url: string, width: number|null, height: number|null, bandwidth: number|null}>}
 */
function parseMasterPlaylist(text, playlistUrl) {
  const variants = [];
  STREAM_INF_RE.lastIndex = 0;
  let match;
  while ((match = STREAM_INF_RE.exec(text)) !== null) {
    const res = RESOLUTION_RE.exec(match[1]);
    const bw = BANDWIDTH_RE.exec(match[1]);
    variants.push({
      url: resolveAgainst(match[2].trim(), playlistUrl),
      width: res ? parseInt(res[1], 10) : null,
      height: res ? parseInt(res[2], 10) : null,
      bandwidth: bw ? parseInt(bw[1], 10) : null,
    });
  }
  return variants;
}

module.exports = { parseMasterPlaylist, resolveAgainst };
