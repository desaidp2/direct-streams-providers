const assert = require("assert");
const { route } = require("./src/stremio/router");

async function runTests() {
  console.log("\n🧪 Running Stremio / WuPlay Addon Tests...\n");

  // Test 1: Manifest
  console.log("== Testing GET /manifest.json ==");
  const manifestRes = await route("/manifest.json");
  assert.strictEqual(manifestRes.status, 200, "Manifest status must be 200");
  const manifest = JSON.parse(manifestRes.body);
  assert.strictEqual(manifest.id, "community.directstreamsproviders");
  assert(manifest.resources.includes("stream"), "Manifest must declare stream resource");
  assert(manifest.types.includes("movie") && manifest.types.includes("series"));
  console.log("✓ Manifest valid:", manifest.name, "v" + manifest.version);

  // Test 2: Movie by IMDB ID (The Dark Knight tt0468569)
  console.log("\n== Testing Movie by IMDB ID: tt0468569 (The Dark Knight) ==");
  const movieRes = await route("/stream/movie/tt0468569.json");
  assert.strictEqual(movieRes.status, 200);
  const movieData = JSON.parse(movieRes.body);
  assert(Array.isArray(movieData.streams), "Response must contain streams array");
  assert(movieData.streams.length > 0, "Dark Knight must return streams");
  console.log(`✓ Resolved ${movieData.streams.length} stream(s):`);
  movieData.streams.slice(0, 4).forEach((s) => {
    console.log(`  - ${s.name.replace(/\n/g, " ")} | ${s.url.slice(0, 80)}...`);
    assert(s.url, "Stream must have a url");
    assert(s.behaviorHints, "Stream must have behaviorHints");
    assert(s.behaviorHints.proxyHeaders, "Stream must have proxyHeaders");
    assert(s.behaviorHints.proxyHeaders.request, "Stream must have proxyHeaders.request");
  });

  // Test 3: TV Series by IMDB ID: tt0903747:1:1 (Breaking Bad S01E01)
  console.log("\n== Testing Series by IMDB ID: tt0903747:1:1 (Breaking Bad S01E01) ==");
  const seriesRes = await route("/stream/series/tt0903747:1:1.json");
  assert.strictEqual(seriesRes.status, 200);
  const seriesData = JSON.parse(seriesRes.body);
  assert(Array.isArray(seriesData.streams), "Response must contain streams array");
  assert(seriesData.streams.length > 0, "Breaking Bad S01E01 must return streams");
  console.log(`✓ Resolved ${seriesData.streams.length} stream(s):`);
  seriesData.streams.slice(0, 4).forEach((s) => {
    console.log(`  - ${s.name.replace(/\n/g, " ")} | ${s.url.slice(0, 80)}...`);
  });

  // Test 4: Movie by direct TMDB ID: tmdb:155
  console.log("\n== Testing Movie by TMDB ID: tmdb:155 ==");
  const tmdbRes = await route("/stream/movie/tmdb:155.json");
  assert.strictEqual(tmdbRes.status, 200);
  const tmdbData = JSON.parse(tmdbRes.body);
  assert(tmdbData.streams.length > 0, "Direct TMDB ID must return streams");
  console.log(`✓ Resolved ${tmdbData.streams.length} stream(s) directly from TMDB ID`);

  console.log("\n🎉 All Stremio & WuPlay addon tests passed successfully!\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
