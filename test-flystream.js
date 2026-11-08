/**
 * FlyStream provider tests, fully offline: `fetch` is stubbed, so this never contacts
 * flystream.net. The previous version called the live site and only checked stream shape
 * `if (streams.length > 0)`, so it passed while returning zero streams.
 * Run: node test-flystream.js
 */
const assert = require("assert");

let fetchCalls = 0;
let mode = "gated";
global.fetch = async () => {
  fetchCalls++;
  if (mode === "gated") return { ok: false, status: 403, text: async () => "" };
  if (mode === "hang") return new Promise(() => {});
  return {
    ok: true,
    status: 200,
    text: async () =>
      '<html><iframe src="//embed.example/e/1"></iframe>' +
      '<script>var a="https://cdn.example/v/1080p/index.m3u8";var b="https://cdn.example/v/auto.mp4";</script></html>',
  };
};

const { getStreams, search, fetchPageDOM } = require("./providers/flystream.js");

async function runTests() {
  console.log("\n🧪 FlyStream provider tests (offline)\n");

  assert.strictEqual(typeof getStreams, "function");
  assert.strictEqual(typeof search, "function");
  assert.strictEqual(typeof fetchPageDOM, "function");
  assert.deepStrictEqual(await getStreams(null, "movie"), []);
  assert.deepStrictEqual(await getStreams("", "movie"), []);
  assert.strictEqual(fetchCalls, 0, "empty ids must not fetch");
  console.log("✓ exports present; null / empty id returns [] without a request");

  // Gated (403) -> [] and the miss is cached: a retrying client does not re-request the page
  assert.deepStrictEqual(await getStreams("1", "movie"), []);
  assert.deepStrictEqual(await getStreams("1", "movie"), []);
  assert.strictEqual(fetchCalls, 1, "a gated miss must be cached");
  console.log("✓ gated page -> [] and cached (1 request for 2 calls)");

  // A stalled page is cut at the 5 s page timeout instead of hanging forever
  mode = "hang";
  const t0 = Date.now();
  assert.deepStrictEqual(await getStreams("2", "movie"), []);
  const took = Date.now() - t0;
  assert(took >= 4900 && took < 6500, `stalled page must time out at ~5 s, took ${took} ms`);
  console.log(`✓ stalled page times out in ${took} ms`);

  // Fixture page: shape, header forwarding, quality order (regression for the refactor)
  mode = "page";
  const streams = await getStreams("3", "tv", 1, 2);
  assert.deepStrictEqual(
    streams.map((s) => s.quality),
    ["1080p", "Auto", "Auto"],
    "1080p first, Auto after (old comparator used || -1)"
  );
  assert(streams.some((s) => s.url === "https://embed.example/e/1"), "protocol-relative iframe resolved");
  for (const s of streams) {
    assert.strictEqual(s.behaviorHints.notWebReady, true);
    assert.strictEqual(s.behaviorHints.proxyHeaders.request["User-Agent"], "okhttp/4.12.0");
  }
  console.log("✓ fixture page parsed, headers forwarded, sorted by quality");

  console.log("\n🎉 FlyStream offline tests passed\n");
  process.exit(0); // the stubbed hanging fetch never settles
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
