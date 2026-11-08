/**
 * ISO 639 Language Code Normalizer for Stremio & ExoPlayer
 *
 * Maps ISO 639-1 (2-letter) codes and display names to ISO 639-2 (3-letter) codes
 * recognized by AndroidX Media3 / ExoPlayer and Stremio.
 */

const ISO_639_1_TO_2 = {
  en: "eng",
  es: "spa",
  ea: "spa", // Spanish (Latin America)
  ar: "ara",
  pb: "pob", // Portuguese (Brazil)
  pt: "por",
  de: "deu",
  fr: "fra",
  vi: "vie",
  vn: "vie",
  it: "ita",
  ru: "rus",
  zh: "zho",
  cn: "zho",
  ze: "zho", // Chinese bilingual
  ja: "jpn",
  ko: "kor",
  hi: "hin",
  id: "ind",
  tr: "tur",
  pl: "pol",
  nl: "nld",
  sv: "swe",
  no: "nor",
  da: "dan",
  fi: "fin",
  el: "ell",
  he: "heb",
  iw: "heb",
  th: "tha",
  cs: "ces",
  hu: "hun",
  ro: "ron",
  uk: "ukr",
  bs: "bos",
  hr: "hrv",
  sr: "srp",
  fa: "fas",
  sk: "slk",
  bg: "bul",
  sl: "slv",
  et: "est",
  lv: "lav",
  lt: "lit",
  ms: "msa",
  fil: "fil",
  tl: "tgl",
  si: "sin",
  ta: "tam",
  te: "tel",
  ka: "kat",
  bn: "ben",
  ur: "urd",
};

const NAME_TO_CODE = {
  english: "eng",
  spanish: "spa",
  arabic: "ara",
  portuguese: "por",
  german: "deu",
  french: "fra",
  vietnamese: "vie",
  italian: "ita",
  russian: "rus",
  chinese: "zho",
  japanese: "jpn",
  korean: "kor",
  hindi: "hin",
  indonesian: "ind",
  turkish: "tur",
  polish: "pol",
  dutch: "nld",
  swedish: "swe",
  norwegian: "nor",
  danish: "dan",
  finnish: "fin",
  greek: "ell",
  hebrew: "heb",
  thai: "tha",
  czech: "ces",
  hungarian: "hun",
  romanian: "ron",
  ukrainian: "ukr",
  bosnian: "bos",
  croatian: "hrv",
  serbian: "srp",
  persian: "fas",
  farsi: "fas",
};

// Memo for toIso6392: the name lookup below is a linear scan with substring matching
// (O(N x L) per call); real inputs repeat a few dozen labels, so a hit is O(1).
const ISO_MEMO = new Map();
const MAX_ISO_MEMO = 512;

function toIso6392(input) {
  if (!input) return "eng";
  const key = String(input);
  const hit = ISO_MEMO.get(key);
  if (hit) return hit;
  const code = lookupIso6392(key);
  if (ISO_MEMO.size >= MAX_ISO_MEMO) ISO_MEMO.delete(ISO_MEMO.keys().next().value);
  ISO_MEMO.set(key, code);
  return code;
}

function lookupIso6392(input) {
  const s = input.trim().toLowerCase();

  // If already 3 letters, return directly
  if (/^[a-z]{3}$/.test(s)) return s;

  // Direct 2-letter lookup
  if (ISO_639_1_TO_2[s]) return ISO_639_1_TO_2[s];

  // Lookup in name table
  for (const [name, code] of Object.entries(NAME_TO_CODE)) {
    if (s.includes(name)) return code;
  }

  return "eng";
}

module.exports = { toIso6392, ISO_639_1_TO_2 };
