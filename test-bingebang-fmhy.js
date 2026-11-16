const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { getStreams, decryptEnvelope, readPlayerConfiguration } = require("./src/bingebox/bingebang");

const SEED = "9e2b7c41a0f6d85b3c1e7a94f25d0b86";
const TICKET = "fixture-ticket";

function encryptedEnvelope(value) {
  const key = createHash("sha256").update(SEED + TICKET).digest();
  const nonce = Buffer.from("0123456789abcdef");
  const plain = Buffer.from(JSON.stringify(value));
  const encrypted = Buffer.alloc(plain.length);
  const counterBlock = Buffer.concat([key, nonce, Buffer.alloc(4)]);
  for (let offset = 0, counter = 0; offset < plain.length; offset += 32, counter++) {
    counterBlock.writeUInt32BE(counter, key.length + nonce.length);
    const pad = createHash("sha256").update(counterBlock).digest();
    for (let i = 0; i < pad.length && offset + i < plain.length; i++) encrypted[offset + i] = plain[offset + i] ^ pad[i];
  }
  return Buffer.concat([nonce, encrypted]).toString("base64url");
}

function playerHtml(mediaType, season, episode) {
  const config = 'ticket: "' + TICKET + '", mediaType: "' + mediaType + '"' +
    (mediaType === "episode" ? ", season: " + season + ", episode: " + episode : "");
  const key = [7, 19, 31];
  const data = Array.from(Buffer.from(config)).map((byte, i) => byte ^ key[i % key.length]);
  return '<html><script>var k=[' + key.join(",") + '],d=[' + data.join(",") + '];</script></html>';
}

function response(url, body, text) {
  return { ok: true, status: 200, url, json: async () => body, text: async () => text || "" };
}

async function runCase(isTv) {
  const requests = [];
  const season = 2, episode = 3;
  const fetchUpstream = async (url, options) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, options: options || {} });
    if (parsed.pathname.startsWith("/api/search/")) {
      return response(url, { results: [{
        id: 1, media_type: isTv ? "tv" : "movie",
        title: isTv ? "The Boys" : "Inception",
        year: isTv ? 2019 : 2010, number_of_seasons: 4,
        play_url: isTv ? "/tv/play/the-boys-test" : "/movie/play/inception-test"
      }] });
    }
    if (parsed.pathname.includes("/play/")) {
      return response(url, null, playerHtml(isTv ? "episode" : "movie", season, episode));
    }
    if (parsed.pathname === "/api/player/sources") {
      return response(url, { enc: encryptedEnvelope({ servers: [
        { id: "a", label: "Yildun", quality: "4K ULTRA HD", source_url: "server-4k" }
      ] }) });
    }
    if (parsed.pathname === "/api/player/resolve") {
      assert.equal(parsed.searchParams.get("src"), "server-4k");
      assert.equal(options.headers["X-BB-Ticket"], TICKET);
      return response(url, { enc: encryptedEnvelope({ ok: true, type: "hls", url: "https://cdn.example/master.m3u8" }) });
    }
    throw new Error("Unexpected BingeBang request " + url);
  };
  const streams = await getStreams(
    { title: isTv ? "The Boys" : "Inception", year: isTv ? "2019" : "2010" },
    isTv, isTv ? season : undefined, isTv ? episode : undefined, fetchUpstream
  );
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, "https://cdn.example/master.m3u8");
  assert.equal(streams[0].name, "BingeBang - Yildun");
  assert.equal(streams[0].quality, "4K");
  assert.equal(requests[0].url.hostname, "bingebang.sx");
  assert.equal(requests[0].url.pathname, isTv ? "/api/search/tv" : "/api/search/movie");
  assert.equal(requests[1].url.pathname, isTv ? "/tv/play/the-boys-test/2/3" : "/movie/play/inception-test");
  assert.equal(requests[2].options.headers["X-BB-Player"], "1");
}

(async () => {
  const key = [1];
  const plain = 'ticket: "test", mediaType: "movie"';
  const encoded = Array.from(Buffer.from(plain)).map(byte => byte ^ key[0]);
  assert.equal(readPlayerConfiguration('<script>var k=[1],d=[' + encoded.join(",") + '];</script>'), plain);
  assert.equal(decryptEnvelope(encryptedEnvelope({ ok: true }), TICKET), '{"ok":true}');
  assert.throws(() => decryptEnvelope("c2hvcnQ", TICKET), /shorter than its nonce/);
  await runCase(false);
  await runCase(true);
  console.log("FMHY BingeBang movie/episode search, ticket, encrypted source and resolve tests passed.");
})().catch(error => { console.error(error); process.exit(1); });
