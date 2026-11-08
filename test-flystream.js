/**
 * FlyStream provider tests, fully offline: `fetch` is stubbed, so this never contacts
 * flystream.net. The previous version called the live site and only checked stream shape
 * `if (streams.length > 0)`, so it passed while returning zero streams.
 * Run: node test-flystream.js
 */
const assert = require("assert");

let fetchCalls = 0;
let mode = "gated";
const fetched = [];
const html = (body) => ({ ok: true, status: 200, text: async () => body });
// Embed pages served by the stub (never the network). `&amp;` in the iframe src must be decoded
// before the request, and an embed with no media link must not reach the player.
const EMBEDS = {
  "https://embed.example/e/1?a=1&b=2":
    '<script>var cfg={"file":"https:\\/\\/cdn2.example\\/hls\\/720p\\/master.m3u8?t=1&amp;x=2"};</script>',
  "https://embed.example/e/dead": "<html><p>video removed</p></html>",
};
let hangEmbeds = false;
global.fetch = async (url) => {
  fetchCalls++;
  fetched.push(url);
  if (mode === "gated") return { ok: false, status: 403, text: async () => "" };
  if (mode === "hang") return new Promise(() => {});
  if (hangEmbeds && url.startsWith("https://embed.example/")) return new Promise(() => {});
  if (Object.prototype.hasOwnProperty.call(EMBEDS, url)) return html(EMBEDS[url]);
  if (url.startsWith("https://embed.example/")) return { ok: false, status: 404, text: async () => "" };
  return html(
    '<html><iframe src="//embed.example/e/1?a=1&amp;b=2"></iframe>' +
      '<iframe src="https://embed.example/e/dead"></iframe>' +
      '<script>var a="https://cdn.example/v/1080p/index.m3u8?s=1&amp;e=2";var b="https://cdn.example/v/auto.mp4";</script></html>'
  );
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
    ["1080p", "720p", "Auto"],
    "1080p first, then the 720p resolved from the embed, Auto last"
  );
  for (const s of streams) {
    assert.strictEqual(s.behaviorHints.notWebReady, true);
    assert.strictEqual(s.behaviorHints.proxyHeaders.request["User-Agent"], "okhttp/4.12.0");
  }
  console.log("✓ fixture page parsed, headers forwarded, sorted by quality");

  // Fix 1: an iframe is an HTML player page, not media. It is resolved to the media link inside it,
  // and an embed with no media link is dropped instead of being handed to the player.
  assert(!streams.some((s) => s.url.startsWith("https://embed.example/")), "no embed HTML page is returned as a stream");
  const viaEmbed = streams.find((s) => s.quality === "720p");
  assert.strictEqual(viaEmbed.url, "https://cdn2.example/hls/720p/master.m3u8?t=1&x=2", "JSON-escaped link unescaped");
  assert.strictEqual(viaEmbed.behaviorHints.proxyHeaders.request.Referer, "https://embed.example/", "embed media uses the embed referer");
  assert.strictEqual(viaEmbed.behaviorHints.proxyHeaders.request.Origin, "https://embed.example");
  assert(fetched.includes("https://embed.example/e/dead"), "the dead embed was tried");
  assert.strictEqual(streams.length, 3, "dead embed dropped");
  console.log("✓ iframe embeds resolved to media; an embed without media is dropped");

  // Fix 2: HTML entities in iframe src / media links are decoded once
  assert(fetched.includes("https://embed.example/e/1?a=1&b=2"), "iframe src &amp; decoded before the request");
  assert(!fetched.some((u) => u.includes("&amp;")), "no request carries a literal &amp;");
  assert(streams.some((s) => s.url === "https://cdn.example/v/1080p/index.m3u8?s=1&e=2"), "media link &amp; decoded");
  assert(streams.every((s) => !s.url.includes("&amp;")), "no stream url carries &amp;");
  console.log("✓ &amp; decoded in iframe src and media links");

  // A stalled embed is cut at its own 3.5 s bound, so page (5 s) + embeds stays under the
  // router's 9 s provider deadline, and the page's direct links are still returned.
  hangEmbeds = true;
  const t1 = Date.now();
  const partial = await getStreams("4", "movie");
  const tookEmbed = Date.now() - t1;
  assert(tookEmbed >= 3400 && tookEmbed < 4500, `stalled embeds must time out at ~3.5 s, took ${tookEmbed} ms`);
  assert.deepStrictEqual(partial.map((s) => s.quality), ["1080p", "Auto"], "page links survive stalled embeds");
  console.log(`✓ stalled embeds cut in ${tookEmbed} ms; page links still returned`);

  console.log("\n🎉 FlyStream offline tests passed\n");
  process.exit(0); // the stubbed hanging fetch never settles
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
