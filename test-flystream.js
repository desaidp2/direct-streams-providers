const assert = require("assert");
const { getStreams, search, fetchPageDOM } = require("./providers/flystream.js");

async function runTests() {
  console.log("\n🧪 Running FlyStream Provider Tests...\n");

  // 1. Basic export assertions
  assert.strictEqual(typeof getStreams, "function", "getStreams must be a function");
  assert.strictEqual(typeof search, "function", "search must be a function");
  assert.strictEqual(typeof fetchPageDOM, "function", "fetchPageDOM must be a function");
  console.log("✓ Core functions exported correctly");

  // 2. Handling of invalid / null TMDB IDs
  const empty1 = await getStreams(null, "movie");
  assert(Array.isArray(empty1) && empty1.length === 0, "Null TMDB ID must return empty array");

  const empty2 = await getStreams("", "movie");
  assert(Array.isArray(empty2) && empty2.length === 0, "Empty TMDB ID must return empty array");
  console.log("✓ Null / empty ID handling returns []");

  // 3. Execution against sample title
  console.log("== Testing getStreams for Oppenheimer (872585) ==");
  const streams = await getStreams("872585", "movie");
  assert(Array.isArray(streams), "Result must always be an array");
  console.log(`✓ getStreams returned ${streams.length} stream(s)`);

  if (streams.length > 0) {
    streams.forEach((s) => {
      assert(s.name, "Stream must have a name");
      assert(s.url, "Stream must have a url");
      assert(s.behaviorHints, "Stream must have behaviorHints");
      assert(s.behaviorHints.proxyHeaders, "Stream must have proxyHeaders");
      assert.strictEqual(
        s.behaviorHints.proxyHeaders.request["User-Agent"],
        "okhttp/4.12.0",
        "User-Agent in proxyHeaders must be okhttp/4.12.0"
      );
    });
    console.log("✓ Stream behaviorHints and headers verified");
  }

  // 4. Test search handling
  console.log("== Testing search('Inception') ==");
  const searchResults = await search("Inception");
  assert(Array.isArray(searchResults), "Search must return an array");
  console.log(`✓ Search returned ${searchResults.length} result(s)`);

  console.log("\n🎉 All FlyStream unit tests passed successfully!\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
