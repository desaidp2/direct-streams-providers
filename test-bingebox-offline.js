const assert = require("node:assert/strict");
const { getStreams } = require("./src/bingebox");

(async () => {
  assert.deepEqual(await getStreams("", "movie"), []);
  assert.deepEqual(await getStreams("not-a-tmdb-id", "movie"), []);
  assert.deepEqual(await getStreams("0", "movie"), []);
  assert.deepEqual(await getStreams("123", "tv"), []);
  const { route } = require("./src/stremio/router");
  const manifestRes = await route("/manifest.json", {}, "http://localhost");
  const manifest = JSON.parse(manifestRes.body);
  assert(manifest.scrapers.some((item) => item.id === "bingebox"), "BingeBox must be registered in the scraper manifest");
  const invalidStreamRes = await route("/stream/movie/not-an-id.json", {}, "http://localhost");
  assert.deepEqual(JSON.parse(invalidStreamRes.body).streams, []);
  console.log("BingeBox provider and router offline checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
