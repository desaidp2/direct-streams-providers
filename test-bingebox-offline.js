const assert = require("node:assert/strict");
const { getStreams } = require("./src/bingebox");

(async () => {
  assert.deepEqual(await getStreams("", "movie"), []);
  assert.deepEqual(await getStreams("not-a-tmdb-id", "movie"), []);
  assert.deepEqual(await getStreams("0", "movie"), []);
  assert.deepEqual(await getStreams("123", "tv"), []);
  const originalFetch = global.fetch;
  const originalBrowser = global.challengeBrowser;
  let browserCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes("api.themoviedb.org/3/movie/872585")) {
      return { ok: true, json: async () => ({ title: "Oppenheimer", release_date: "2023-07-21" }) };
    }
    throw new Error("Unexpected direct fetch; browser path should resolve BingeBox API");
  };
  global.challengeBrowser = {
    execute: async (url, options) => {
      browserCalls++;
      assert(url.startsWith("https://bingebox.ac/"), "browser must load BingeBox origin");
      assert(options.reuse === true, "browser page should be reused");
      assert(options.evaluateJs.includes("/api/sources?"), "browser must fetch unified sources API in-page");
      return {
        result: JSON.stringify({
          status: 200,
          body: JSON.stringify({
            success: true,
            sources: [{
              label: "test-cdn",
              stream: {
                playlist: "https://cdn.example/test.m3u8",
                captions: [{ url: "https://subs.example/en.srt", label: "English", language: "en" }]
              }
            }]
          })
        }),
        cookies: "session=browser-cookie",
        userAgent: "Browser Test UA"
      };
    }
  };
  try {
    const browserStreams = await getStreams("872585", "movie");
    assert.strictEqual(browserCalls, 1, "BingeBox should use the existing challengeBrowser session");
    assert.strictEqual(browserStreams.length, 1);
    assert.strictEqual(browserStreams[0].url, "https://cdn.example/test.m3u8");
    assert.strictEqual(browserStreams[0].behaviorHints.proxyHeaders.request.Cookie, "session=browser-cookie");
    assert.strictEqual(browserStreams[0].behaviorHints.proxyHeaders.request["User-Agent"], "Browser Test UA");
    assert.strictEqual(browserStreams[0].subtitles[0].headers.Cookie, "session=browser-cookie");
  } finally {
    global.fetch = originalFetch;
    if (originalBrowser === undefined) delete global.challengeBrowser;
    else global.challengeBrowser = originalBrowser;
  }

  const originalFetchV2 = global.fetchv2;
  let nativeCalls = 0;
  global.fetchv2 = async (url, requestHeaders, method) => {
    nativeCalls++;
    assert.strictEqual(method, "GET");
    if (String(url).includes("api.themoviedb.org/3/movie/27205")) {
      return { ok: true, json: async () => ({ title: "Inception", release_date: "2010-07-16" }) };
    }
    if (String(url).startsWith("https://bingebox.ac/api/sources?")) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          sources: [{ label: "native-cdn", stream: { url: "https://cdn.example/native.mp4", captions: [] } }]
        })
      };
    }
    throw new Error("Unexpected fetchv2 URL: " + url);
  };
  try {
    const nativeStreams = await getStreams("27205", "movie");
    assert.strictEqual(nativeCalls, 2, "TMDB metadata and BingeBox sources should use fetchv2");
    assert.strictEqual(nativeStreams.length, 1);
    assert.strictEqual(nativeStreams[0].name, "BingeBox - native-cdn");
  } finally {
    if (originalFetchV2 === undefined) delete global.fetchv2;
    else global.fetchv2 = originalFetchV2;
  }

  const { route } = require("./src/stremio/router");
  const manifestRes = await route("/manifest.json", {}, "http://localhost");
  const manifest = JSON.parse(manifestRes.body);
  assert(manifest.scrapers.some((item) => item.id === "bingebox"), "BingeBox must be registered in the scraper manifest");
  const invalidStreamRes = await route("/stream/movie/not-an-id.json", {}, "http://localhost");
  assert.deepEqual(JSON.parse(invalidStreamRes.body).streams, []);
  console.log("BingeBox browser-session, native-fetch, provider, and router offline checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
