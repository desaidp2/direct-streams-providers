const assert = require("node:assert/strict");
const { getStreams } = require("./src/cinejoy");

(async () => {
  assert.deepEqual(await getStreams("", "movie"), []);
  assert.deepEqual(await getStreams("not-a-tmdb-id", "movie"), []);
  assert.deepEqual(await getStreams("0", "movie"), []);
  console.log("Cinejoy provider input validation passed.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
