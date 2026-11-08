/**
 * FlyStream provider tests, fully offline: `fetch` is stubbed, so this never contacts
 * flystream.net or the TMDB proxy. Covers the JSON-API port of the hostreamio Dart scraper.
 * Run: node test-flystream.js
 */
const assert = require("assert");

const calls = [];
let apiMode = "ok";
let metaMode = "ok";
const json = (body, status) => ({
  ok: (status || 200) === 200,
  status: status || 200,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => body,
});

const API_BODY = {
  streams: [
    { url: "/hls/abc/master.m3u8", quality: "1080p", videoCodec: "h264", size: "2.1 GB", name: "Main" },
    { url: "https://cdn.example/4k/index.m3u8", quality: "2160p", videoCodec: "hevc", title: "UHD" },
    { url: "https://cdn.example/4k/index.m3u8", quality: "2160p" }, // duplicate url -> dropped
    { url: "ftp://bad.example/x.mp4", quality: "720p" }, // not http(s) -> dropped
    { url: "", quality: "720p" }, // empty -> dropped
    "not-an-object",
    { url: "https://cdn.example/auto.m3u8" }, // no quality -> Auto, name falls back to title
  ],
};

global.fetch = async (url, opts) => {
  calls.push({ url, headers: (opts && opts.headers) || {} });
  if (url.startsWith("https://db.wecollege.net/3/")) {
    if (metaMode === "fail") return json({}, 500);
    if (url.includes("/tv/")) {
      return json({ name: "Show & Co", first_air_date: "2019-03-01", external_ids: { imdb_id: "tt0000002" } });
    }
    return json({ title: "Film: One", release_date: "2008-07-16", external_ids: { imdb_id: "tt0468569" } });
  }
  if (global.__companion && url.includes("/companion/flystream?")) return global.__companion(url);
  if (global.__masters && url in global.__masters) {
    global.__masterHits.push({ url, headers: (opts && opts.headers) || {} });
    return json(global.__masters[url]);
  }
  if (global.__apiBody && url.startsWith("https://flystream.net/api/streams?")) {
    if (global.__apiClockJump) {
      const real = Date.now;
      const jump = global.__apiClockJump;
      Date.now = () => real() + jump;
      global.__restoreClock = () => (Date.now = real);
    }
    return json(global.__apiBody);
  }
  if (url.startsWith("https://flystream.net/api/streams?")) {
    if (apiMode === "hang") return new Promise(() => {});
    if (apiMode === "403") return json("", 403);
    if (apiMode === "badjson") return json("<html>oops</html>");
    return json(API_BODY);
  }
  throw new Error("unexpected network call in offline test: " + url);
};

const api = require("./src/flystream/flystream-api-streams.js");
const meta = require("./src/flystream/tmdb-title-metadata.js");
const { getStreams, search, fetchPageDOM } = require("./providers/flystream.js");

function query(url) {
  const out = {};
  url.split("?")[1].split("&").forEach((kv) => {
    const [k, v] = kv.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  });
  return out;
}
const apiCalls = () => calls.filter((c) => c.url.startsWith("https://flystream.net/api/streams?"));

async function runTests() {
  console.log("\n🧪 FlyStream provider tests (offline)\n");

  // Pure units
  assert.match(api.randomViewerId(), /^[0-9a-f]{32}$/);
  assert.deepStrictEqual(
    api.buildApiParams({ mediaType: "movie", title: "X", tmdbId: 1, season: 1, episode: 2, viewerId: "v" }),
    [["type", "movie"], ["viewerId", "v"], ["title", "X"], ["tmdbId", "1"]],
    "movie never sends season/episode; absent imdb/year omitted"
  );
  assert.deepStrictEqual(
    ["2160p", "4K", "UHD", "1080p HEVC", "720", "Auto", "", "weird"].map(api.normalizeQuality),
    ["4K", "4K", "4K", "1080p", "720p", "Auto", "Auto", "Auto"]
  );
  assert.deepStrictEqual(meta.pickTitleMetadata({ title: "A", release_date: "1999-01-01", imdb_id: "tt1" }, "movie"), {
    title: "A",
    year: 1999,
    imdbId: "tt1",
  });
  assert.deepStrictEqual(meta.pickTitleMetadata(null, "tv"), {});
  console.log("✓ viewerId, param rules, quality normalisation, TMDB field pick");

  assert.strictEqual(typeof search, "function");
  assert.strictEqual(typeof fetchPageDOM, "function");
  assert.deepStrictEqual(await getStreams(null, "movie"), []);
  assert.deepStrictEqual(await getStreams("", "movie"), []);
  assert.strictEqual(calls.length, 0, "empty ids must not fetch");
  console.log("✓ exports present; null / empty id returns [] without a request");

  // Movie: request shape matches the Dart scraper
  const movie = await getStreams("155", "movie");
  const mq = query(apiCalls()[0].url);
  assert.strictEqual(mq.type, "movie");
  assert.match(mq.viewerId, /^[0-9a-f]{32}$/);
  assert.strictEqual(mq.title, "Film: One", "title from TMDB, url-decoded round trip");
  assert.strictEqual(mq.tmdbId, "155");
  assert.strictEqual(mq.imdb, "tt0468569");
  assert.strictEqual(mq.year, "2008");
  assert(!("season" in mq) && !("episode" in mq), "movie sends no season/episode");
  const h = apiCalls()[0].headers;
  assert.strictEqual(h.Referer, "https://flystream.net/");
  assert.strictEqual(h.Accept, "application/json");
  assert.match(h["User-Agent"], /^Mozilla\/5\.0/);
  console.log("✓ movie API request: type, viewerId, title, tmdbId, imdb, year, headers");

  // Response mapping
  assert.deepStrictEqual(movie.map((s) => s.quality), ["4K", "1080p", "Auto"], "sorted, junk + dup dropped");
  assert.strictEqual(movie[1].url, "https://flystream.net/hls/abc/master.m3u8", "relative url prefixed");
  assert.strictEqual(movie[1].size, "2.1 GB");
  assert.strictEqual(movie[1].title, "FlyStream Main\n1080p · H264 · 2.1 GB");
  assert.strictEqual(movie[0].title, "FlyStream UHD\n2160p · HEVC");
  assert.strictEqual(movie[2].title, "FlyStream Film: One\nAuto", "name falls back to the TMDB title");
  for (const s of movie) {
    assert.strictEqual(s.behaviorHints.notWebReady, true);
    assert.strictEqual(s.behaviorHints.proxyHeaders.request.Referer, "https://flystream.net/");
    assert.deepStrictEqual(s.headers, s.behaviorHints.proxyHeaders.request);
  }
  console.log("✓ streams mapped: relative urls, dedupe, quality sort, titles, playback headers");

  // Cache: a replay costs no request
  const before = calls.length;
  await getStreams("155", "movie");
  assert.strictEqual(calls.length, before, "cached replay");
  console.log("✓ cached replay sends no request");

  // TV: season/episode sent, TV metadata fields used
  await getStreams("1396", "tv", 2, 5);
  const tq = query(apiCalls()[1].url);
  assert.deepStrictEqual([tq.type, tq.title, tq.year, tq.imdb, tq.season, tq.episode], [
    "tv", "Show & Co", "2019", "tt0000002", "2", "5",
  ]);
  console.log("✓ tv API request carries season/episode and TV metadata");

  // Metadata lookup fails -> API still called by tmdbId, with an empty title slot
  metaMode = "fail";
  await getStreams("777", "movie");
  const fq = query(apiCalls()[2].url);
  assert.strictEqual(fq.tmdbId, "777");
  assert.strictEqual(fq.title, "");
  assert(!("imdb" in fq) && !("year" in fq));
  metaMode = "ok";
  console.log("✓ metadata miss still queries the API by tmdbId");

  // Non-200 / bad JSON -> [] and the miss is cached
  apiMode = "403";
  assert.deepStrictEqual(await getStreams("9", "movie"), []);
  const n = apiCalls().length;
  assert.deepStrictEqual(await getStreams("9", "movie"), []);
  assert.strictEqual(apiCalls().length, n, "a failed lookup is cached");
  // ...but only briefly (30 s), unlike a genuine empty answer (5 min)
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 1000;
  await getStreams("9", "movie");
  Date.now = realNow;
  assert.strictEqual(apiCalls().length, n + 1, "a failed lookup expires after ~30 s");
  apiMode = "badjson";
  assert.deepStrictEqual(await getStreams("10", "movie"), []);
  console.log("✓ 403 and non-JSON body -> [] (failure cached 30 s, not 5 min)");

  // Host challengeBrowser present (server.js on the Pi): the API goes through it, not fetch
  apiMode = "403"; // fetch would fail, so success proves the browser path was used
  const browserCalls = [];
  global.challengeBrowser = {
    execute: async (url, opts) => {
      browserCalls.push({ url, opts });
      const body = JSON.stringify({ streams: [{ url: "/hls/b.m3u8", quality: "720p" }] });
      return {
        status: 200,
        result: JSON.stringify({ status: 200, body }),
        cookies: "cf_clearance=test123; session=abc",
        userAgent: "CustomUA/1.0",
      };
    },
  };
  const viaBrowser = await getStreams("20", "movie");
  assert.strictEqual(browserCalls.length, 1);
  assert.strictEqual(browserCalls[0].url, "https://flystream.net/robots.txt", "kept same-origin tab");
  assert.strictEqual(browserCalls[0].opts.reuse, true);
  assert(browserCalls[0].opts.evaluateJs.includes('fetch("/api/streams?type=movie'), "in-page fetch of the API path");
  assert.deepStrictEqual(viaBrowser.map((s) => s.url), ["https://flystream.net/hls/b.m3u8"]);
  assert.strictEqual(viaBrowser[0].headers.Cookie, "cf_clearance=test123; session=abc", "headers.Cookie forwarded");
  assert.strictEqual(
    viaBrowser[0].behaviorHints.proxyHeaders.request.Cookie,
    "cf_clearance=test123; session=abc",
    "proxyHeaders.Cookie forwarded to ExoPlayer"
  );
  assert.strictEqual(viaBrowser[0].headers["User-Agent"], "CustomUA/1.0", "matching browser UA forwarded");
  global.challengeBrowser.execute = async () => ({ status: 200, result: JSON.stringify({ status: 403, body: "<html>403</html>" }) });
  assert.deepStrictEqual(await getStreams("21", "movie"), [], "browser 403 -> []");
  global.challengeBrowser.execute = async () => {
    throw new Error("interstitial did not clear");
  };
  assert.deepStrictEqual(await getStreams("22", "movie"), [], "browser error -> []");
  delete global.challengeBrowser;
  console.log("✓ host challengeBrowser used for the API call; cookies and UA forwarded; 403 / errors -> []");

  // A stalled API is cut at the 5 s timeout (Dart: .timeout(Duration(seconds: 5)))
  apiMode = "hang";
  const t0 = Date.now();
  assert.deepStrictEqual(await getStreams("11", "movie"), []);
  const took = Date.now() - t0;
  assert(took >= 4900 && took < 6500, `stalled API must time out at ~5 s, took ${took} ms`);
  console.log(`✓ stalled API times out in ${took} ms`);

  // --- companion client (src module; fetch stub routes /companion/flystream to __companion) ---
  delete global.challengeBrowser;
  apiMode = "ok";
  const COMP_STREAM = { name: "FlyStream - 4K", url: "https://flystream.net/source-hls/x/index.m3u8", quality: "4K" };
  const compHits = [];
  global.__companion = (url) => {
    compHits.push(url);
    if (url.startsWith("http://slow")) return new Promise(() => {});
    if (url.startsWith("http://dead")) return Promise.reject(new Error("ECONNREFUSED"));
    return Promise.resolve(json({ ok: true, streams: [COMP_STREAM] }));
  };

  // No companion configured -> no companion request at all (the old implicit 127.0.0.1 is gone).
  delete process.env.FLYSTREAM_COMPANION_URL;
  assert.deepStrictEqual(api.getCompanionCandidates(), []);
  await api.fetchApiStreams({ mediaType: "movie", title: "T", tmdbId: 1 });
  assert.strictEqual(compHits.length, 0, "no companion request without FLYSTREAM_COMPANION_URL");

  // Comma list, trailing slashes trimmed, duplicates dropped.
  process.env.FLYSTREAM_COMPANION_URL = "http://slow:1/, http://dead:2,http://good:3,http://good:3/";
  assert.deepStrictEqual(api.getCompanionCandidates(), ["http://slow:1", "http://dead:2", "http://good:3"]);

  // Hosts are raced: a hung first host and a dead second do not delay the good third.
  let t1 = Date.now();
  const raced = await api.fetchApiStreams({ mediaType: "movie", title: "T", tmdbId: 2 });
  assert.strictEqual(raced.via, "companion");
  assert.strictEqual(raced.streams.length, 1);
  assert(Date.now() - t1 < 500, `race must not wait for the hung host, took ${Date.now() - t1} ms`);
  console.log(`✓ companion hosts raced in parallel (${Date.now() - t1} ms with one host hung)`);

  // skipCompanion (server's own /companion route) never calls a companion -> no self-recursion.
  compHits.length = 0;
  const skipped = await api.fetchApiStreams({ mediaType: "movie", title: "T", tmdbId: 3 }, { skipCompanion: true });
  assert.strictEqual(compHits.length, 0, "skipCompanion must not query any companion");
  assert.strictEqual(skipped.ok, true); // fell through to the direct API stub
  console.log("✓ skipCompanion: zero companion requests (server cannot call itself)");

  // All hosts failing -> bounded by one companion timeout, then the direct API fallback.
  process.env.FLYSTREAM_COMPANION_URL = "http://dead:2";
  const fellBack = await api.fetchApiStreams({ mediaType: "movie", title: "T", tmdbId: 4 });
  assert.strictEqual(fellBack.ok, true);
  assert.notStrictEqual(fellBack.via, "companion");
  delete process.env.FLYSTREAM_COMPANION_URL;
  delete global.__companion;
  console.log("✓ all companions down -> direct API fallback");

  // In-flight dedupe: concurrent identical getStreams share one API call.
  calls.length = 0;
  const [a, b, c] = await Promise.all([getStreams(4242, "movie"), getStreams(4242, "movie"), getStreams(4242, "movie")]);
  assert.strictEqual(apiCalls().length, 1, `3 concurrent requests -> 1 API call, got ${apiCalls().length}`);
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  console.log("✓ 3 concurrent identical getStreams -> 1 API call");

  // Metadata passthrough: given title/imdb/year -> no TMDB request, API carries them.
  calls.length = 0;
  await getStreams(5151, "movie", 1, 1, { skipCompanion: true, meta: { title: "Given Title", imdbId: "tt0000009", year: 1999 } });
  assert.strictEqual(calls.filter((c) => c.url.includes("db.wecollege.net")).length, 0, "no TMDB lookup when meta is given");
  const gq = query(apiCalls()[0].url);
  assert.strictEqual(gq.title, "Given Title");
  assert.strictEqual(gq.imdb, "tt0000009");
  assert.strictEqual(gq.year, "1999");
  console.log("✓ companion meta passthrough skips the TMDB round trip");

  // Late fill: a browser call that overruns its budget is still cached when it lands.
  let execs = 0;
  global.challengeBrowser = {
    execute: async () => {
      execs++;
      await new Promise((r) => setTimeout(r, 900));
      return { result: JSON.stringify({ status: 200, body: JSON.stringify(API_BODY) }), cookies: "c=1", userAgent: "UA" };
    },
  };
  const first = await getStreams(6262, "movie", 1, 1, { browserTimeoutMs: 50 });
  assert.deepStrictEqual(first, [], "timed out -> [] now");
  await new Promise((r) => setTimeout(r, 500));
  const second = await getStreams(6262, "movie", 1, 1, { browserTimeoutMs: 50 });
  assert(second.length > 0, "late result must be served from cache");
  assert.strictEqual(execs, 1, "retry is a cache hit, not a second browser call");
  delete global.challengeBrowser;
  console.log(`✓ late fill: timed-out browser call cached on arrival (${second.length} streams, ${execs} browser call)`);

  // --- HLS variant split (masters as observed on the site, 2026-11-08)
  const { qualityFromResolution } = require("./src/flystream/flystream-hls-variant-expansion.js");
  const qtab = [[3840, 2160, "4K"], [1920, 1080, "1080p"], [1280, 720, "720p"], [1920, 800, "1080p"], [1280, 534, "720p"],
    [640, 266, "360p"], [854, 480, "480p"], [2560, 1440, "1440p"], [null, 1080, "1080p"], [null, null, null]];
  for (const [w, h, q] of qtab) assert.strictEqual(qualityFromResolution(w, h), q, `${w}x${h}`);

  const M4K = "#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160\nhttps://flystream.net/v/2160.m3u8\n" +
    "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhttps://flystream.net/v/1080.m3u8\n" +
    "#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\nhttps://flystream.net/v/720.m3u8\n";
  const MWIDE = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=810647,CODECS="mp4a.40.2,avc1.42c015",RESOLUTION=640x266,FRAME-RATE=24\nhttps://flystream.net/w/360.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=2540758,CODECS="mp4a.40.2,avc1.64001f",RESOLUTION=1280x534,FRAME-RATE=24\nhttps://flystream.net/w/720.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=4629855,CODECS="mp4a.40.2,avc1.640028",RESOLUTION=1920x800,FRAME-RATE=24\nhttps://flystream.net/w/1080.m3u8\n';
  const MAUDIO = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="https://flystream.net/a/en.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="a"\nhttps://flystream.net/a/1080.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="a"\nhttps://flystream.net/a/720.m3u8\n';
  global.__masters = {
    "https://flystream.net/source-hls/k4/index.m3u8?dseg=1": M4K,
    "https://flystream.net/source-hls/wd/index.m3u8?cv=t": MWIDE,
    "https://flystream.net/source-hls/au/index.m3u8?cv=u": MAUDIO,
  };
  global.__masterHits = [];
  global.__apiBody = { streams: [
    { url: "/source-hls/k4/index.m3u8?dseg=1", quality: "2160p", videoCodec: "h264", name: "Film · 2160p", sourceBucket: "s1" },
    { url: "/source-hls/wd/index.m3u8?cv=t", quality: "1080p", videoCodec: "h264", name: "Film · 1080p", sourceBucket: "s2" },
    { url: "/source-hls/au/index.m3u8?cv=u", quality: "1080p", videoCodec: "h264", name: "Film · 1080p", sourceBucket: "s3" },
  ] };
  delete global.challengeBrowser;
  const split = await getStreams(7070, "movie", 1, 1, { skipCompanion: true });
  const rows = split.map((s) => `${s.name}|${s.quality}|${s.url.replace("https://flystream.net", "")}`);
  assert.deepStrictEqual(rows, [
    "FlyStream S1 - 4K|4K|/v/2160.m3u8",
    "FlyStream S1 - 1080p|1080p|/v/1080.m3u8",
    "FlyStream S2 - 1080p|1080p|/w/1080.m3u8",
    "FlyStream S3 - 1080p|1080p|/source-hls/au/index.m3u8?cv=u",
    "FlyStream S1 - 720p|720p|/v/720.m3u8",
    "FlyStream S2 - 720p|720p|/w/720.m3u8",
    "FlyStream S2 - 360p|360p|/w/360.m3u8",
    "FlyStream S1 - Auto|Auto|/source-hls/k4/index.m3u8?dseg=1",
    "FlyStream S2 - Auto|Auto|/source-hls/wd/index.m3u8?cv=t",
  ], "variants split, widescreen labelled by width, separate-audio master kept whole, Auto rows last");
  assert.strictEqual(split[0].title.split("\n")[1], "4K · 3840×2160 · H264");
  assert.strictEqual(split[7].title.split("\n")[1], "Auto (up to 4K) · H264");
  for (const s of split) {
    assert.strictEqual(s.behaviorHints.proxyHeaders.request.Referer, "https://flystream.net/", "variants keep playback headers");
    assert.strictEqual(s.headers, s.behaviorHints.proxyHeaders.request);
  }
  assert.strictEqual(global.__masterHits.length, 3, "one master fetch per source");
  assert(global.__masterHits.every((h) => h.headers.Referer === "https://flystream.net/"), "masters fetched with playback headers");
  console.log(`✓ HLS variants: ${split.length} rows from 3 sources (4K + widescreen split, separate-audio master kept, Auto last)`);

  // Not enough of the 9 s budget left after the API call -> no split (one row per source).
  global.__masterHits = [];
  global.__apiClockJump = 7600;
  const late = await getStreams(7071, "movie", 1, 1, { skipCompanion: true });
  global.__restoreClock();
  delete global.__apiClockJump;
  assert.strictEqual(late.length, 3, "budget exhausted -> masters left whole");
  assert.strictEqual(global.__masterHits.length, 0, "no master fetched without budget");
  console.log("✓ HLS variants skipped when the lookup budget is spent");

  // Companion results are already split by the server: the client does not fetch masters again.
  global.__masterHits = [];
  process.env.FLYSTREAM_COMPANION_URL = "http://pi.test:7070";
  global.__companion = () => Promise.resolve(json({ ok: true, streams: [{ name: "FlyStream S1 - 4K", url: "https://flystream.net/source-hls/k4/index.m3u8?dseg=1", quality: "4K", title: "x" }] }));
  const viaComp = await getStreams(7072, "movie");
  assert.strictEqual(viaComp.length, 1);
  assert.strictEqual(global.__masterHits.length, 0, "companion streams are not re-split on the client");
  delete process.env.FLYSTREAM_COMPANION_URL;
  delete global.__companion;
  delete global.__masters;
  delete global.__apiBody;
  console.log("✓ companion results are not re-split on the TV");

  console.log("\n🎉 FlyStream offline tests passed\n");
  process.exit(0); // the stubbed hanging fetch never settles
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
