const { getStreams } = require("./src/bingebox");

(async () => {
  const streams = await getStreams("872585", "movie");
  console.log("[BingeBox live smoke] Oppenheimer (TMDB 872585): " + streams.length + " stream(s)");
  for (const stream of streams.slice(0, 5)) {
    console.log("- " + stream.name + " | " + stream.quality + " | " + stream.url.slice(0, 120));
  }
  if (!streams.length) {
    console.error("BingeBox upstream returned no playable sources from this CI runner.");
    process.exitCode = 2;
  }
})().catch((err) => {
  console.error("BingeBox live smoke failed:", err);
  process.exitCode = 2;
});
