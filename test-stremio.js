const assert = require("assert");
const { route } = require("./src/stremio/router");

async function runTests() {
  console.log("\n🧪 Running Stremio / WuPlay Addon Tests...\n");

  const baseUrl = "http://127.0.0.1:7070";

  // Test 1: Manifest
  console.log("== Testing GET /manifest.json ==");
  const manifestRes = await route("/manifest.json", {}, baseUrl);
  assert.strictEqual(manifestRes.status, 200, "Manifest status must be 200");
  const manifest = JSON.parse(manifestRes.body);
  assert.strictEqual(manifest.id, "community.directstreamsproviders");
  assert(manifest.resources.includes("stream"), "Manifest must declare stream resource");
  assert(manifest.resources.includes("subtitles"), "Manifest must declare subtitles resource");
  assert(manifest.types.includes("movie") && manifest.types.includes("series"));
  console.log("✓ Manifest valid:", manifest.name, "v" + manifest.version, "resources:", manifest.resources);

  // Test 2: Movie by IMDB ID (The Dark Knight tt0468569)
  console.log("\n== Testing Movie Streams: tt0468569 (The Dark Knight) ==");
  const movieRes = await route("/stream/movie/tt0468569.json", {}, baseUrl);
  assert.strictEqual(movieRes.status, 200);
  const movieData = JSON.parse(movieRes.body);
  assert(Array.isArray(movieData.streams), "Response must contain streams array");
  assert(movieData.streams.length > 0, "Dark Knight must return streams");
  console.log(`✓ Resolved ${movieData.streams.length} stream(s):`);
  movieData.streams.slice(0, 3).forEach((s) => {
    console.log(`  - ${s.name.replace(/\n/g, " ")} | ${s.url.slice(0, 80)}...`);
    assert(s.url, "Stream must have a url");
    assert(s.behaviorHints, "Stream must have behaviorHints");
    assert(s.behaviorHints.proxyHeaders, "Stream must have proxyHeaders");
    assert(s.behaviorHints.proxyHeaders.request, "Stream must have proxyHeaders.request");
  });

  // Verify stream subtitles have ISO 639-2 codes
  if (movieData.streams[0].subtitles.length > 0) {
    const sub0 = movieData.streams[0].subtitles[0];
    assert(/^[a-z]{3}$/.test(sub0.lang), `Subtitle lang must be ISO 639-2: ${sub0.lang}`);
    assert(sub0.url.includes(".srt"), `Subtitle url must end with .srt: ${sub0.url}`);
    console.log(`✓ Stream subtitles normalized with ISO 639-2: ${sub0.lang} -> ${sub0.url.slice(0, 80)}...`);
  }

  // Test 3: Subtitles endpoint GET /subtitles/:type/:id.json
  console.log("\n== Testing Subtitles Endpoint: /subtitles/movie/tt0468569.json ==");
  const subRes = await route("/subtitles/movie/tt0468569.json", {}, baseUrl);
  assert.strictEqual(subRes.status, 200);
  const subData = JSON.parse(subRes.body);
  assert(Array.isArray(subData.subtitles), "Response must contain subtitles array");
  assert(subData.subtitles.length > 0, "Dark Knight must return subtitles");
  console.log(`✓ Resolved ${subData.subtitles.length} subtitle tracks:`);
  subData.subtitles.slice(0, 5).forEach((sub) => {
    console.log(`  - [${sub.lang}] ${sub.name} -> ${sub.url.slice(0, 75)}...`);
    assert(/^[a-z]{3}$/.test(sub.lang), `Subtitle lang code must be 3-letter ISO-639-2: ${sub.lang}`);
    assert(sub.url.includes(".srt"), "Subtitle URL path must include .srt for ExoPlayer");
  });

  // Test 4: Subtitle proxy endpoint /subtitles/file.srt?url=...
  console.log("\n== Testing Subtitle Proxy: /subtitles/file.srt ==");
  const sampleSubUrl = subData.subtitles[0].url;
  const proxyQueryUrl = new URL(sampleSubUrl).searchParams.get("url");
  assert(proxyQueryUrl, "Proxy URL query param must exist");
  const proxyRes = await route("/subtitles/file.srt", { url: proxyQueryUrl }, baseUrl);
  assert.strictEqual(proxyRes.status, 200, "Subtitle proxy must return 200");
  assert.strictEqual(proxyRes.headers["Content-Type"], "application/x-subrip; charset=utf-8");
  assert(proxyRes.body.includes("-->"), "Subtitle content must contain SRT timestamps");
  console.log("✓ Subtitle proxy correctly fetched and served application/x-subrip payload");

  // Test 5: TV Series by IMDB ID: tt0903747:1:1 (Breaking Bad S01E01)
  console.log("\n== Testing Series by IMDB ID: tt0903747:1:1 (Breaking Bad S01E01) ==");
  const seriesRes = await route("/stream/series/tt0903747:1:1.json", {}, baseUrl);
  assert.strictEqual(seriesRes.status, 200);
  const seriesData = JSON.parse(seriesRes.body);
  assert(seriesData.streams.length > 0, "Breaking Bad S01E01 must return streams");
  console.log(`✓ Resolved ${seriesData.streams.length} stream(s)`);

  console.log("\n🎉 All Stremio & WuPlay addon tests passed successfully!\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
