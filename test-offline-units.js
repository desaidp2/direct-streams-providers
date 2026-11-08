/**
 * Offline unit tests (no network): shared helpers, the 7Movies HLS parser and retry policy,
 * and the Movy mvm1 byte codecs. Run: node test-offline-units.js
 */
const assert = require("assert");
const { qualityRank, sortByQuality, withTimeout, fetchWithTimeout, TtlCache } = require("./src/shared/provider-utils");
const { parseMasterPlaylist } = require("./src/shared/hls-master-playlist-parser");
const { b64decode, utf8decode, keystream, decryptSources } = require("./src/movy/mvm1-byte-codecs");

async function run() {
  console.log("\n🧪 Offline unit tests\n");

  // --- quality sort: Auto (0) must rank above Unknown (-1) and unknown labels
  const sorted = sortByQuality(["Auto", "Unknown", "240p", "720p", "4K"].map((q) => ({ quality: q }))).map((s) => s.quality);
  assert.deepStrictEqual(sorted, ["4K", "720p", "Auto", "Unknown", "240p"]);
  assert.strictEqual(qualityRank("Auto"), 0);
  console.log("✓ sortByQuality ranks Auto above Unknown");

  // --- withTimeout rejects late promises and passes through early ones
  assert.strictEqual(await withTimeout(Promise.resolve(7), 50), 7);
  await assert.rejects(withTimeout(new Promise(() => {}), 30, "T"), /T 30ms/);
  console.log("✓ withTimeout resolves early / rejects late");

  // --- TtlCache: LRU eviction, TTL expiry, empty-array values are real hits
  const c = new TtlCache(2, 1000);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a"); // refresh a -> b is now least recent
  c.set("c", 3);
  assert.strictEqual(c.get("b"), undefined, "LRU must evict b");
  assert.strictEqual(c.get("a"), 1);
  c.set("empty", [], 1000);
  assert.deepStrictEqual(c.get("empty"), [], "cached miss ([]) must be a hit");
  c.set("short", 1, 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(c.get("short"), undefined, "expired entry must be gone");
  assert(c.size <= 2);
  console.log("✓ TtlCache LRU + TTL + cached misses");

  // --- HLS master playlist: RESOLUTION anywhere in the attribute list, CRLF, relative URIs
  const pl =
    "#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\r\n360/index.m3u8\r\n" +
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=24\r\nhttps://cdn2/1080.m3u8\r\n' +
    "#EXT-X-STREAM-INF:BANDWIDTH=100000\r\naudio.m3u8\r\n";
  const v = parseMasterPlaylist(pl, "https://cdn/x/master.m3u8");
  assert.deepStrictEqual(v, [
    { url: "https://cdn/x/360/index.m3u8", width: 640, height: 360, bandwidth: 800000 },
    { url: "https://cdn2/1080.m3u8", width: 1920, height: 1080, bandwidth: 5000000 },
    { url: "https://cdn/x/audio.m3u8", width: null, height: null, bandwidth: 100000 },
  ]);
  console.log("✓ HLS parser reads RESOLUTION (old regex labelled every variant Auto)");

  // --- 7Movies: a 404 is not retried; a 429 is
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (url.includes("enc-dec.app")) return { ok: true, status: 200, json: async () => ({ result: "HASH" }) };
    return { ok: false, status: 404, headers: { get: () => null } };
  };
  const p7 = require("./providers/7movies.js");
  const t0 = Date.now();
  assert.deepStrictEqual(await p7.getStreams("424242", "movie"), []);
  const vidlinkCalls = calls.filter((u) => u.includes("vidlink.pro")).length;
  assert.strictEqual(vidlinkCalls, 1, "404 must not be retried");
  assert(Date.now() - t0 < 500, "404 miss must not sleep through retry backoff");
  await p7.getStreams("424242", "movie");
  assert.strictEqual(calls.filter((u) => u.includes("vidlink.pro")).length, 1, "a definitive miss must be cached");
  console.log(`✓ 7Movies: 404 fails in ${Date.now() - t0} ms with 1 call, then served from the miss cache`);

  let n429 = 0;
  global.fetch = async (url) => {
    if (url.includes("enc-dec.app")) return { ok: true, status: 200, json: async () => ({ result: "H2" }) };
    n429++;
    return { ok: false, status: 429, headers: { get: () => "0" } };
  };
  await p7.getStreams("434343", "movie");
  assert.strictEqual(n429, 3, "429 must be retried (1 + 2 retries)");
  global.fetch = realFetch;
  console.log("✓ 7Movies: 429 still retried with backoff");

  // --- Movy codecs: byte-exact vs Buffer on random data, both base64 alphabets
  for (const len of [0, 1, 2, 3, 17, 4097, 100000]) {
    const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 131 + 7) & 255));
    assert(Buffer.from(b64decode(bytes.toString("base64"))).equals(bytes), "b64 std len " + len);
    assert(Buffer.from(b64decode(bytes.toString("base64url"))).equals(bytes), "b64url len " + len);
  }
  const text = "plain ascii, tiếng Việt, 中文, emoji 🎬🍿 ".repeat(800); // > 8192 units, surrogates
  assert.strictEqual(utf8decode(new Uint8Array(Buffer.from(text))), text);
  console.log("✓ b64decode / utf8decode byte-exact vs Buffer (incl. chunk boundary + surrogates)");

  // --- Movy decryptSources round trip (XOR keystream is symmetric)
  const json = JSON.stringify({ sources: [{ url: "https://x/2160p.m3u8", quality: "2160p" }], t: "Phim hay ✓" });
  const plain = Buffer.concat([Buffer.from("mvm1"), Buffer.from(json)]);
  const ks = keystream("seed-abc", 872585, plain.length);
  const enc = Buffer.from(plain.map((b, i) => b ^ ks[i])).toString("base64url");
  assert.strictEqual(decryptSources('"' + enc + '"', "seed-abc", "872585"), json);
  assert.throws(() => decryptSources(enc, "wrong-seed", "872585"), /magic mismatch/);
  console.log("✓ decryptSources round-trips and rejects a wrong seed");

  // --- fetchWithTimeout aborts the underlying request (local server that never answers)
  const http = require("http");
  let open = 0;
  const hang = http.createServer((req) => {
    open++;
    req.socket.on("close", () => open--);
  });
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const hangUrl = `http://127.0.0.1:${hang.address().port}/`;
  const tA = Date.now();
  await assert.rejects(fetchWithTimeout(hangUrl, {}, 150, "Hang"), /Hang 150ms/);
  assert(Date.now() - tA < 1000, "rejects at the deadline");
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(open, 0, "socket must be closed after the timeout (request aborted)");
  // Without AbortController it degrades to withTimeout (QuickJS / Hermes path)
  // (Node's own fetch needs AbortController internally, so this half uses a stub fetch.)
  const savedAC = global.AbortController;
  const savedFetch = global.fetch;
  let sawSignal = null;
  global.AbortController = undefined;
  global.fetch = (u, init) => {
    sawSignal = init && "signal" in init;
    return new Promise(() => {});
  };
  await assert.rejects(fetchWithTimeout(hangUrl, {}, 100, "NoAC"), /NoAC 100ms/);
  assert.strictEqual(sawSignal, false, "no signal passed when the runtime has no AbortController");
  global.AbortController = savedAC;
  global.fetch = savedFetch;
  hang.closeAllConnections();
  await new Promise((r) => hang.close(r));
  console.log("✓ fetchWithTimeout aborts the socket at the deadline; degrades without AbortController");

  console.log("\n🎉 Offline unit tests passed\n");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
