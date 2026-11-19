const assert = require("node:assert/strict");
const { getStreams } = require("./src/vixsrc");

(async () => {
  assert.deepEqual(await getStreams("", "movie"), []);
  assert.deepEqual(await getStreams("not-a-tmdb-id", "movie"), []);
  assert.deepEqual(await getStreams("0", "movie"), []);
  assert.deepEqual(await getStreams("-1", "movie"), []);
  console.log("VixSrc provider input validation passed.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
