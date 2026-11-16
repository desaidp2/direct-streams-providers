/**
 * BingeBang provider flow ported from RisPNG/fmhywebstremio.
 * Upstream extractor: MIT-licensed project; see docs/bingebox-upstream.md.
 */
const { createHash } = require("node:crypto");

const DEFAULT_BASES = ["https://bingebang.sx", "https://bingebang.st"];
const PLAYER_ENVELOPE_SEED = "9e2b7c41a0f6d85b3c1e7a94f25d0b86";
const QUALITY_HEIGHTS = { "4K ULTRA HD": 2160, "FULL HD": 1080, "HD": 720, "SD": 480 };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

function getBaseUrls() {
  if (typeof process !== "undefined" && process.env && process.env.BINGEBANG_BASE_URL) {
    return [process.env.BINGEBANG_BASE_URL.replace(/\/+$/, "")];
  }
  return DEFAULT_BASES;
}

function decryptEnvelope(envelope, ticket) {
  const key = createHash("sha256").update(PLAYER_ENVELOPE_SEED + ticket).digest();
  const payload = Buffer.from(envelope, "base64url");
  if (payload.byteLength <= 16) throw new Error("BingeBang envelope is shorter than its nonce");
  const nonce = payload.subarray(0, 16);
  const encrypted = payload.subarray(16);
  const plaintext = Buffer.alloc(encrypted.byteLength);
  const counterBlock = Buffer.concat([key, nonce, Buffer.alloc(4)]);
  for (let offset = 0, counter = 0; offset < encrypted.byteLength; offset += 32, counter++) {
    counterBlock.writeUInt32BE(counter, key.byteLength + nonce.byteLength);
    const keystream = createHash("sha256").update(counterBlock).digest();
    for (let i = 0; i < keystream.byteLength && offset + i < encrypted.byteLength; i++) {
      plaintext[offset + i] = encrypted[offset + i] ^ keystream[i];
    }
  }
  return plaintext.toString("utf8");
}

function readPlayerConfiguration(html) {
  const match = String(html || "").match(/var k=\[([\d,\s]+)\],d=\[([\d,\s]+)\]/);
  if (!match || !match[1] || !match[2]) return undefined;
  const key = match[1].split(",").map(Number);
  const data = match[2].split(",").map(Number);
  if (!key.length || key.some(n => !Number.isFinite(n)) || data.some(n => !Number.isFinite(n))) return undefined;
  return Buffer.from(data.map((value, index) => value ^ key[index % key.length])).toString("utf8");
}

async function checkedResponse(fetchUpstream, url, options, label) {
  const response = await fetchUpstream(url, options || {}, label);
  if (!response || !response.ok) throw new Error("BingeBang HTTP " + (response && response.status || "unknown"));
  return response;
}

async function getStreamsAtBase(meta, isTv, season, episode, fetchUpstream, base) {
  if (!meta || !meta.title || typeof fetchUpstream !== "function") return [];
  if (isTv && (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1)) return [];
  const origin = base + "/";
  const headers = { "User-Agent": UA, "Referer": origin, "Origin": base, "Accept": "application/json, text/html;q=0.9" };
  try {
    const searchUrl = new URL("/api/search/" + (isTv ? "tv" : "movie"), base);
    searchUrl.searchParams.set("query", meta.title);
    searchUrl.searchParams.set("page", "1");
    const searchResponse = await checkedResponse(fetchUpstream, searchUrl.toString(), { headers }, "BingeBang search");
    const search = await searchResponse.json();
    if (!search || !Array.isArray(search.results)) return [];
    const normalized = String(meta.title).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const match = search.results.find(item => {
      const title = String(item && (item.title || item.name) || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      return title === normalized &&
        item.media_type === (isTv ? "tv" : "movie") &&
        typeof item.play_url === "string" &&
        (isTv
          ? typeof item.number_of_seasons === "number" && season <= item.number_of_seasons
          : !meta.year || !item.year || Number(meta.year) === Number(item.year));
    });
    if (!match || !match.play_url) return [];

    const playerUrl = new URL(match.play_url, searchUrl);
    const episodeUrl = isTv
      ? new URL(playerUrl.pathname.replace(/\/$/, "") + "/" + season + "/" + episode, playerUrl)
      : playerUrl;
    const page = await checkedResponse(fetchUpstream, episodeUrl.toString(), { headers: Object.assign({}, headers, { Accept: "text/html" }) }, "BingeBang player page");
    const configuration = readPlayerConfiguration(await page.text());
    const ticket = configuration && configuration.match(/ticket:\s*"([^"]+)"/)?.[1];
    if (!configuration || !ticket) return [];

    const declaredType = configuration.match(/mediaType:\s*"([a-z]+)"/)?.[1];
    const declaredEpisode = configuration.match(/season:\s*(\d+),\s*episode:\s*(\d+)/);
    if (declaredType !== (isTv ? "episode" : "movie")) return [];
    if (isTv && (Number(declaredEpisode && declaredEpisode[1]) !== season || Number(declaredEpisode && declaredEpisode[2]) !== episode)) return [];

    const apiHeaders = Object.assign({}, headers, { "X-BB-Player": "1", "X-BB-Ticket": ticket, Referer: episodeUrl.toString() });
    const sourceResponse = await checkedResponse(fetchUpstream, new URL("/api/player/sources", base).toString(), { headers: apiHeaders }, "BingeBang source list");
    const sourceEnvelope = (await sourceResponse.json() || {}).enc;
    if (typeof sourceEnvelope !== "string") return [];
    const serverList = JSON.parse(decryptEnvelope(sourceEnvelope, ticket));
    if (!serverList || !Array.isArray(serverList.servers)) return [];

    const streams = [];
    const seen = new Set();
    const playbackHeaders = {
      "User-Agent": sourceResponse.userAgent || UA,
      Referer: origin
    };
    if (sourceResponse.cookies) playbackHeaders.Cookie = sourceResponse.cookies;
    for (const server of serverList.servers.slice(0, 9)) {
      if (!server || typeof server.source_url !== "string" || !server.source_url) continue;
      const resolveUrl = new URL("/api/player/resolve", base);
      resolveUrl.searchParams.set("src", server.source_url);
      const resolveResponse = await checkedResponse(fetchUpstream, resolveUrl.toString(), { headers: apiHeaders }, "BingeBang resolve");
      const resolveEnvelope = (await resolveResponse.json() || {}).enc;
      if (typeof resolveEnvelope !== "string") continue;
      let resolved;
      try { resolved = JSON.parse(decryptEnvelope(resolveEnvelope, ticket)); } catch (_) { continue; }
      if (!resolved || !resolved.ok || typeof resolved.url !== "string" || !/^https?:\/\//i.test(resolved.url) || seen.has(resolved.url)) continue;
      seen.add(resolved.url);
      const quality = String(server.quality || "").toUpperCase();
      const height = QUALITY_HEIGHTS[quality];
      streams.push({
        name: "BingeBang - " + String(server.label || "Server"),
        title: (isTv ? "S" + String(season).padStart(2, "0") + "E" + String(episode).padStart(2, "0") : "Movie") + " - " + (quality || "Auto"),
        url: resolved.url,
        quality: height === 2160 ? "4K" : (height ? height + "p" : "Auto"),
        headers: playbackHeaders,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: playbackHeaders } },
        subtitles: []
      });
    }
    return streams;
  } catch (error) {
    console.warn("[BingeBang] FMHY extractor failed:", error && error.message || error);
    return [];
  }
}

async function getStreams(meta, isTv, season, episode, fetchUpstream) {
  for (const base of getBaseUrls()) {
    const streams = await getStreamsAtBase(meta, isTv, season, episode, fetchUpstream, base);
    if (streams.length) return streams;
  }
  return [];
}

module.exports = { getStreams, decryptEnvelope, readPlayerConfiguration };
