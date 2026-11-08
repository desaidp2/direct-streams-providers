/**
 * Offline router tests (no network): providers are replaced with stubs.
 * Covers the per-provider deadline, in-flight dedup, shared subtitle mapping and bad paths.
 * Run: node test-router-offline.js
 */
const assert = require("assert");
const path = require("path");

process.env.PROVIDER_DEADLINE_MS = "300";

const calls = { movy: 0, seven: 0, fly: 0 };
const subs = [
  { url: "https://s/en", language: "English" },
  { url: "https://s/vi", language: "vi" },
];
const fast = (tag, n) => async () => {
  calls[tag]++;
  await new Promise((r) => setTimeout(r, 50));
  return Array.from({ length: n }, (_, i) => ({ name: tag + i, url: `https://${tag}/${i}`, quality: "1080p", subtitles: subs }));
};
let flyMode = "hang";
let flyArgs = null;
const fly = async (...args) => {
  calls.fly++;
  flyArgs = args;
  if (flyMode === "hang") return new Promise(() => {});
  if (flyMode === "throw") throw new Error("boom");
  return [{ name: "fly", url: "https://fly/1", quality: "Auto", subtitles: [] }];
};

function stub(rel, exportsObj) {
  const p = require.resolve(path.join(__dirname, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
stub("src/movy/index.js", { getStreams: fast("movy", 3), fetchSubtitles: async () => subs });
stub("src/7movies/index.js", { getStreams: fast("seven", 2) });
stub("src/flystream/index.js", { getStreams: fly });

const { route, handleStreams } = require("./src/stremio/router");

async function run() {
  console.log("\n🧪 Offline router tests\n");

  // 1. A hanging provider is cut at the deadline; the others still answer
  let t0 = Date.now();
  let r = await handleStreams("movie", "tmdb:1", "http://h");
  const took = Date.now() - t0;
  assert.strictEqual(r.streams.length, 5, "movy 3 + 7movies 2, flystream skipped");
  assert(took >= 280 && took < 700, `response must be bounded by the deadline, took ${took} ms`);
  assert(r.streams[0].name.includes("movy0") && r.streams[3].name.includes("seven0"), "provider order kept");
  console.log(`✓ hanging provider dropped at the deadline (${took} ms)`);

  // 2. A throwing provider is ignored
  flyMode = "throw";
  r = await handleStreams("movie", "tmdb:2", "http://h");
  assert.strictEqual(r.streams.length, 5);
  console.log("✓ throwing provider ignored");

  // 3. Identical concurrent requests share one resolution
  flyMode = "ok";
  const before = { ...calls };
  const all = await Promise.all([1, 2, 3, 4].map(() => handleStreams("movie", "tmdb:3", "http://h")));
  assert.strictEqual(calls.movy - before.movy, 1);
  assert.strictEqual(calls.seven - before.seven, 1);
  assert.strictEqual(calls.fly - before.fly, 1);
  assert(all.every((x) => x.streams.length === 6));
  await handleStreams("movie", "tmdb:3", "http://h");
  assert.strictEqual(calls.movy - before.movy, 2, "dedup only spans in-flight requests");
  console.log("✓ 4 concurrent identical requests -> 1 call per provider");

  // 4. Subtitle mapping: correct shape, mapped once and shared
  const s0 = all[0].streams[0].subtitles;
  assert.deepStrictEqual(s0[0], {
    id: "eng_0",
    url: "http://h/subtitles/file.srt?url=" + encodeURIComponent("https://s/en"),
    lang: "eng",
    name: "eng",
  });
  assert.strictEqual(s0[1].lang, "vie");
  assert.strictEqual(all[0].streams[1].subtitles, s0, "streams sharing a source array share the mapped array");
  assert.strictEqual(all[0].streams[5].subtitles.length, 0);
  console.log("✓ subtitles mapped once per distinct source array, ISO 639-2 + .srt bridge");

  // 5. HTTP-level checks
  const bad = await route("/stream/movie/%E0%A4%A.json", {}, "http://h");
  assert.strictEqual(bad.status, 400, "malformed %-escape must be 400, not a thrown 500");
  const scheme = await route("/subtitles/file.srt", { url: "file:///etc/passwd" }, "http://h");
  assert.strictEqual(scheme.status, 400, "non-http(s) subtitle targets must be refused");
  const subsRes = JSON.parse((await route("/subtitles/movie/tmdb:1.json", {}, "http://h")).body);
  assert.strictEqual(subsRes.subtitles.length, 2);
  const manifest = JSON.parse((await route("/manifest.json", {}, "")).body);
  assert.strictEqual(manifest.id, "community.directstreamsproviders");

  // 6. Companion endpoints
  const compRes = await route("/companion/flystream", { tmdbId: "3", type: "movie" }, "http://h", { clientAddress: "192.168.1.20" });
  assert.strictEqual(compRes.status, 200);
  const compData = JSON.parse(compRes.body);
  assert.strictEqual(compData.ok, true);
  assert(compData.streams.length > 0);

  const cookieRes = await route("/companion/flystream/cookies", {}, "http://h", { clientAddress: "192.168.1.20" });
  assert.strictEqual(cookieRes.status, 200);
  console.log("✓ companion endpoints /companion/flystream and /cookies OK");
  console.log("✓ 400 on malformed path / non-http subtitle url; subtitles + manifest routes OK");

  // 7. Companion route passes skipCompanion (server must never query its own companion)
  flyArgs = null;
  await route("/companion/flystream", { tmdbId: "77", type: "movie" }, "http://h", { clientAddress: "192.168.1.20" });
  assert(flyArgs && flyArgs[4] && flyArgs[4].skipCompanion === true, "companion route must pass skipCompanion");
  assert.strictEqual(flyArgs[4].meta, undefined, "no title -> no meta passthrough");
  await route("/companion/flystream", { tmdbId: "78", type: "movie", title: "The Dark Knight", imdb: "tt0468569", year: "2008" }, "http://h", { clientAddress: "10.0.0.2" });
  assert.deepStrictEqual(flyArgs[4].meta, { title: "The Dark Knight", imdbId: "tt0468569", year: 2008 });
  await route("/companion/flystream", { tmdbId: "79", title: "X", imdb: "nm123", year: "20x8" }, "http://h", { clientAddress: "10.0.0.2" });
  assert.deepStrictEqual(flyArgs[4].meta, { title: "X", imdbId: undefined, year: undefined }, "bad imdb / year dropped");
  await route("/companion/flystream", { tmdbId: "80", title: "y".repeat(201) }, "http://h", { clientAddress: "10.0.0.2" });
  assert.strictEqual(flyArgs[4].meta, undefined, "over-long title rejected");
  console.log("✓ /companion/flystream calls getStreams with skipCompanion");

  // 8. Serve-time injection: marker replaced; missing marker throws instead of shipping silently
  const { injectCompanionUrl } = require("./src/stremio/router");
  const out = injectCompanionUrl('x;var BUILD_COMPANION_URL = true ? "" : "";y', "http://pi:7070,http://b:1");
  assert(out.includes('var BUILD_COMPANION_URL = "http://pi:7070,http://b:1";'));
  assert.throws(() => injectCompanionUrl("no marker here", "http://pi"));
  const built = require("fs").readFileSync(path.join(__dirname, "providers/flystream.js"), "utf8");
  assert(/var BUILD_COMPANION_URL\s*=[^;]+;/.test(built), "built providers/flystream.js must keep the injection marker");
  console.log("✓ companion URL injection: marker present in build, replaced, missing marker throws");

  // 9. Manifest body is cached: same string object until manifest.json mtime changes
  const m1 = (await route("/manifest.json", {}, "")).body;
  const m2 = (await route("/manifest.json", {}, "")).body;
  assert.strictEqual(m1, m2);
  assert(Array.isArray(JSON.parse(m1).scrapers), "Nuvio scrapers merged into manifest");
  console.log("✓ manifest served from mtime cache with Nuvio scrapers merged");

  // 10. Companion routes are LAN-only and never send CORS headers
  const gate = require("./src/stremio/client-address-private-network-check");
  for (const ip of ["127.0.0.1", "::1", "::ffff:192.168.1.5", "10.0.0.9", "172.16.0.1", "172.31.255.1",
    "192.168.0.1", "169.254.1.1", "100.64.0.1", "100.127.1.1", "fd12:3456::1", "fe80::1", "[::1]"]) {
    assert(gate.isPrivateAddress(ip), ip + " should be private");
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "2001:4860::8888", "", undefined, "not-an-ip", "256.1.1.1"]) {
    assert(!gate.isPrivateAddress(ip), ip + " should be public");
  }
  assert.strictEqual(gate.effectiveClientAddress("127.0.0.1", "192.168.1.9, 8.8.8.8"), "8.8.8.8", "rightmost XFF hop wins");
  assert.strictEqual(gate.effectiveClientAddress("192.168.1.2", undefined), "192.168.1.2");
  let callsBefore = calls.fly;
  for (const p of ["/companion/flystream", "/api/flystream/streams", "/companion/flystream/cookies"]) {
    for (const info of [{ clientAddress: "8.8.8.8" }, {}, undefined]) {
      const r = await route(p, { tmdbId: "5" }, "http://h", info);
      assert.strictEqual(r.status, 403, p + " must refuse a public / unknown client");
    }
  }
  assert.strictEqual(calls.fly, callsBefore, "a refused request must not reach the provider");
  const lanRes = await route("/companion/flystream/cookies", {}, "http://h", { clientAddress: "10.1.2.3" });
  assert.strictEqual(lanRes.status, 200);
  assert(!("Access-Control-Allow-Origin" in lanRes.headers), "companion routes must not send CORS headers");
  assert.strictEqual(lanRes.headers["Cache-Control"], "no-store");
  process.env.COMPANION_ALLOW_PUBLIC = "1";
  assert.strictEqual((await route("/companion/flystream/cookies", {}, "http://h", { clientAddress: "8.8.8.8" })).status, 200);
  delete process.env.COMPANION_ALLOW_PUBLIC;
  console.log("✓ companion routes: LAN-only gate (IPv4/IPv6/mapped/XFF), 403 before provider, no CORS, opt-out env");

  console.log("\n🎉 Offline router tests passed\n");
  process.exit(0); // the stub flystream promise never settles
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
