process.env.CHALLENGE_BROWSER_HEADLESS = "1";
const browserHost = require("./src/host/chromium-challenge-browser");
const { getStreams } = require("./src/bingebox");

(async () => {
  global.challengeBrowser = browserHost;
  const streams = await getStreams("872585", "movie");
  console.log("[BingeBox browser live smoke] Oppenheimer (TMDB 872585): " + streams.length + " stream(s)");
  for (const stream of streams.slice(0, 5)) {
    console.log("- " + stream.name + " | " + stream.quality + " | " + stream.url.slice(0, 120));
  }
  if (!streams.length) {
    console.error("BingeBox returned no playable sources through the browser-session path.");
    process.exitCode = 2;
  }
})().catch((err) => {
  console.error("BingeBox browser live smoke failed:", err);
  process.exitCode = 2;
}).finally(async () => {
  delete global.challengeBrowser;
  await browserHost.close().catch(() => {});
});
