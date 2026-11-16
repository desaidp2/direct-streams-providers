const assert = require("node:assert/strict");
const { getStreams } = require("./src/bingebox");

(async () => {
  assert.deepEqual(await getStreams("", "movie"), []);
  assert.deepEqual(await getStreams("not-a-tmdb-id", "movie"), []);
  assert.deepEqual(await getStreams("0", "movie"), []);
  assert.deepEqual(await getStreams("123", "tv"), []);
  console.log("BingeBox provider input validation passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
