/**
 * Pure ECMAScript mvm1 decryption for Movy (QuickJS / Hermes safe: no Buffer, atob or TextDecoder).
 *
 * Payload: base64url text of "mvm1" || JSON, XORed with a keystream derived from seed + mediaId.
 * Every stage is O(n) time; peak extra space is one Uint8Array of the decoded bytes plus the output string.
 */

const MAGIC = [109, 118, 109, 49]; // "mvm1"

// Sextet lookup for both alphabets ('+/' and url-safe '-_'); -1 marks characters to skip.
// The old decoder ran three regex replaces (three n-char string copies), then
// B64_CHARS.indexOf per char (up to 64 compares) into a plain JS array of numbers.
const B64_LOOKUP = (function () {
  const t = new Int8Array(128).fill(-1);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i;
  t[45] = 62; // '-'
  t[95] = 63; // '_'
  return t;
})();

function mix(e) {
  e = e >>> 0;
  e ^= e >>> 16;
  e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 0xc2b2ae35) >>> 0;
  return (e ^ (e >>> 16)) >>> 0;
}

function rotl(e, a) {
  e = e >>> 0;
  a &= 31;
  return a === 0 ? e : ((e << a) | (e >>> (32 - a))) >>> 0;
}

// O(n) time, one preallocated Uint8Array (3/4 of the input length) instead of a JS number array.
function b64decode(str) {
  str = String(str || "");
  const out = new Uint8Array(Math.floor((str.length * 3) / 4));
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) continue; // padding, whitespace, quotes
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 255;
      buf &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, o);
}

// Decoded UTF-16 code units are flushed in fixed-size chunks and joined once, so the cost is
// O(n). The old per-character `s +=` is cheap in V8 (ropes) but copies the string each time
// in engines without ropes, which is O(n^2).
const UTF8_CHUNK = 8192;

function utf8decode(bytes) {
  const parts = [];
  const units = new Uint16Array(UTF8_CHUNK + 1); // +1: a surrogate pair may straddle the limit
  let k = 0;
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    let cp;
    if (c < 0x80) {
      cp = c;
    } else if (c < 0xe0) {
      cp = ((c & 31) << 6) | (bytes[i++] & 63);
    } else if (c < 0xf0) {
      cp = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    } else {
      cp =
        ((c & 7) << 18) |
        ((bytes[i++] & 63) << 12) |
        ((bytes[i++] & 63) << 6) |
        (bytes[i++] & 63);
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      units[k++] = 0xd800 + (cp >> 10);
      units[k++] = 0xdc00 + (cp & 1023);
    } else {
      units[k++] = cp;
    }
    if (k >= UTF8_CHUNK) {
      parts.push(String.fromCharCode.apply(null, units.subarray(0, k)));
      k = 0;
    }
  }
  if (k) parts.push(String.fromCharCode.apply(null, units.subarray(0, k)));
  return parts.join("");
}


function initState(seed, mediaId) {
  let fnv = 0x811c9dc5;
  for (let t = 0; t < seed.length; t++) {
    fnv = Math.imul(fnv ^ seed.charCodeAt(t), 0x1000193) >>> 0;
  }
  const S = new Uint32Array(61);
  const used = new Uint8Array(61);
  let n = mix((mix(fnv) ^ mix(((Number(mediaId) >>> 0) ^ 0x9e3779b9) >>> 0)) >>> 0) >>> 0;
  for (let e = 0; e < 8; e++) {
    const a = n % 61;
    n = rotl((n + 0x9e3779b9) >>> 0, 7 + (7 & e));
    S[a] = (n ^ mix(n)) >>> 0;
    used[a] = 1;
    n = mix((n + a) >>> 0);
  }
  return { S: S, used: used, acc: mix(0xa5a5a5a5 ^ n) >>> 0 };
}

function keystream(seed, mediaId, len) {
  const st = initState(seed, mediaId);
  const S = st.S;
  const used = st.used;
  let acc = st.acc;
  const out = new Uint8Array(len);
  let counter = 0;
  for (let e = 0; e < len; ) {
    const dd = acc % 61;
    const negIn = used[dd] ? -1 : 0;
    const r = S[dd] >>> 0;
    const cc = Math.imul(0x9e3779b9, counter + 1) >>> 0;
    const nn = (r ^ cc) >>> 0;
    let b = (((acc ^ nn) >>> 0) | ((acc & nn & negIn) >>> 0)) >>> 0;
    b = (rotl((b + acc) >>> 0, 31 & dd) ^ rotl(acc, 31 & Math.imul(dd, 7))) >>> 0;
    acc = mix((b + 0x9e3779b9) >>> 0);
    S[dd] = acc >>> 0;
    used[dd] = 1;
    const word = acc >>> 0;
    counter++;
    out[e++] = 255 & word;
    if (e < len) out[e++] = (word >>> 8) & 255;
    if (e < len) out[e++] = (word >>> 16) & 255;
    if (e < len) out[e++] = (word >>> 24) & 255;
  }
  return out;
}

function decryptSources(payloadText, seed, mediaId) {
  const cleanText = String(payloadText || "").replace(/^\s*"|"\s*$/g, "").trim();
  const data = b64decode(cleanText);
  const ks = keystream(seed, Number(mediaId), data.length);
  for (let j = 0; j < data.length; j++) data[j] ^= ks[j];
  for (let j = 0; j < MAGIC.length; j++) {
    if (data[j] !== MAGIC[j]) throw new Error("mvm1 magic mismatch");
  }
  return utf8decode(data.subarray(MAGIC.length));
}

module.exports = { b64decode, utf8decode, keystream, decryptSources };
