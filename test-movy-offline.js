/**
 * Offline spec for the Movy server fallback (issue #1). `fetch` is stubbed: nothing here
 * contacts movy.sx or api.wecollege.net. Payloads are real mvm1 ciphertext built with the
 * provider's own keystream, so decryption is exercised end to end.
 *
 * Behaviour pinned (from movy.sx's player script, 2026-11-08):
 *  - original-audio servers in the site's order: miami, boise, nashville, chicago, vegas, reno,
 *    oakland, seattle, phoenix, atlanta, portland, austin, dallas; dubbed servers never asked
 *  - miami + boise first, then the rest through a sliding window of 3 (a slow failure never blocks
 *    the next server); launching stops at the first server with sources (+ short grace)
 *  - a source labelled "Auto" is a master playlist: one variant -> its height ("900p", as the
 *    site shows Reno), several -> "Auto"; language labels stay "Unknown (<label>)"
 *  - every request carries the site's fields; one seed per title, one re-seed on 401
 *  - one attempt per server (site: retry 0); a 429 stops the walk; a seed 429 asks no server
 *  - the whole lookup stays inside a time budget
 * Run: node test-movy-offline.js
 */
const assert = require("assert");
const { keystream } = require("./src/movy/mvm1-byte-codecs");
const { sortByQuality } = require("./src/shared/provider-utils");

const API = "https://api.wecollege.net";
const ORIGINAL = ["miami", "boise", "nashville", "chicago", "vegas", "reno", "oakland", "seattle", "phoenix", "atlanta", "portland", "austin", "dallas"];
const DUBBED = ["munich", "berlin", "paris", "delhi", "cancun", "anikoto"];

let world; // per-test behaviour + call log
function resetWorld(over) {
  world = Object.assign(
    {
      seedMode: "ok", // ok | 429
      seedCalls: 0,
      seedValue: 0,
      servers: {}, // name -> { status, sources, delayMs, hang, unauthorizedOnce }
      calls: [], // { server, params, t }
      details: { title: "Jimmy O. Yang: Finally Home", year: 2026, imdbId: "tt40642070" },
      tmdbMeta: null,
      t0: Date.now(),
    },
    over || {}
  );
}

function encrypt(obj, seed, mediaId) {
  const plain = Buffer.concat([Buffer.from("mvm1"), Buffer.from(JSON.stringify(obj))]);
  const ks = keystream(seed, Number(mediaId), plain.length);
  return '"' + Buffer.from(plain.map((b, i) => b ^ ks[i])).toString("base64url") + '"';
}
const reply = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

global.fetch = async (url) => {
  const u = new URL(url);
  if (u.origin === API && u.pathname === "/seed") {
    world.seedCalls++;
    if (world.seedMode === "429") return reply(429, '{"error":"rate limited"}');
    world.seedValue++;
    return reply(200, JSON.stringify({ seed: "seed-" + world.seedValue, ttlMs: 30000 }));
  }
  if (u.origin === API && u.pathname.endsWith("/sources")) {
    const server = u.pathname.split("/")[1];
    const params = Object.fromEntries(u.searchParams.entries());
    world.calls.push({ server, params, t: Date.now() - world.t0 });
    const b = world.servers[server] || { status: 500 };
    if (b.hang) return new Promise(() => {});
    if (b.delayMs) await delay(b.delayMs);
    if (b.unauthorizedOnce && !b._did401) {
      b._did401 = true;
      return reply(401, "unauthorized");
    }
    if (b.status && b.status !== 200) return reply(b.status, "err");
    return reply(200, encrypt({ sources: b.sources || [], subtitles: [] }, params.seed, params.tmdbId));
  }
  if (u.origin === "https://www.movy.sx") {
    if (!world.details) return reply(404, "");
    const nd = { props: { pageProps: { details: world.details } } };
    return reply(200, `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script></html>`);
  }
  if (u.hostname === "db.wecollege.net" && u.pathname.startsWith("/3/")) {
    return world.tmdbMeta ? reply(200, JSON.stringify(world.tmdbMeta)) : reply(404, "{}");
  }
  if (u.hostname === "subtitles.vidy.st") return reply(200, "[]");
  if (u.hostname === "cdn.example" && world.masters && url in world.masters) {
    const m = world.masters[url];
    if (m.hang) return new Promise(() => {});
    return reply(m.status || 200, m.body);
  }
  throw new Error("unexpected network call in offline test: " + url);
};

const { getStreams } = require("./src/movy/index.js");
const served = () => world.calls.map((c) => c.server);
const src = (q, tag) => ({ url: `https://cdn.example/${tag}/${q}.m3u8`, quality: q });

async function run() {
  console.log("\n🧪 Movy fallback offline tests\n");

  // 1. Primary hit: Miami answers, nothing else is asked; request carries the site's fields.
  resetWorld();
  world.servers.miami = { status: 200, sources: [src("2160p", "mi"), src("1080p", "mi")] };
  let s = await getStreams("1644912", "movie");
  assert.deepStrictEqual(s.map((x) => x.name), ["Movy Miami - 4K", "Movy Miami - 1080p"]);
  assert.deepStrictEqual(served().sort(), ["boise", "miami"], "only the two primary servers on a hit");
  const p = world.calls.find((c) => c.server === "miami").params;
  assert.strictEqual(p.title, encodeURIComponent("Jimmy O. Yang: Finally Home"), "title is double-encoded on the wire, like the site");
  assert.deepStrictEqual(
    { mediaType: p.mediaType, year: p.year, totalSeasons: p.totalSeasons, episodeId: p.episodeId, seasonId: p.seasonId, tmdbId: p.tmdbId, imdbId: p.imdbId, enc: p.enc },
    { mediaType: "movie", year: "2026", totalSeasons: "0", episodeId: "1", seasonId: "1", tmdbId: "1644912", imdbId: "tt40642070", enc: "2" },
    "round 1 sends the site's full field set"
  );
  assert(p.seed, "seed sent");
  console.log("✓ primary hit: Miami/Boise only, site field set on round 1");

  // 2. The reported edge case: Miami/Boise and the first fallback batch fail; Reno has 900p.
  resetWorld();
  // Live shape (2026-11-08): Reno answers one source, quality "Auto", a master with one 1600x900 variant.
  const renoUrl = "https://cdn.example/re/master.m3u8";
  world.servers.reno = { status: 200, sources: [{ url: renoUrl, quality: "Auto" }] };
  world.masters = { [renoUrl]: { body: '#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2552213,RESOLUTION=1600x900,FRAME-RATE=24.000,CODECS="avc1.640028,mp4a.40.2"\nindex-900.m3u8\n' } };
  for (const n of ["nashville", "chicago", "vegas"]) world.servers[n] = { status: 500, delayMs: 30 };
  s = await getStreams("1644913", "movie");
  assert.deepStrictEqual(s.map((x) => `${x.name}|${x.quality}`), ["Movy Reno - 900p|900p"], "Auto master with one 900p variant is labelled 900p");
  assert.strictEqual(s[0].url, renoUrl, "the row keeps the master URL");
  assert(/ - 900p HLS$/.test(s[0].title), s[0].title);
  assert.deepStrictEqual(served().slice(0, 2).sort(), ["boise", "miami"]);
  for (const later of ["portland", "austin", "dallas"]) assert(!served().includes(later), later + " must not be asked once Reno had sources");
  for (const d of DUBBED) assert(!served().includes(d), d + " (dubbed) must never be asked");
  console.log("✓ Reno 900p found (Auto master, one 1600x900 variant): sliding window stops once Reno has sources");

  // 3. Sliding window: site order, at most 3 in flight, a slow failure does not block the next server.
  resetWorld();
  let inFlight = 0;
  let peak = 0;
  for (const n of ORIGINAL) world.servers[n] = { status: 500, delayMs: 40 };
  world.servers.nashville = { status: 500, delayMs: 400 }; // slow failure
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    const isSrc = String(url).includes("/sources?") && !/\/(miami|boise)\//.test(String(url));
    if (isSrc) peak = Math.max(peak, ++inFlight);
    try { return await origFetch(url, init); } finally { if (isSrc) inFlight--; }
  };
  s = await getStreams("1644914", "movie", undefined, undefined, { budgetMs: 5000 });
  global.fetch = origFetch;
  assert.deepStrictEqual(s, []);
  const order = served();
  assert.deepStrictEqual(order.slice(0, 2).sort(), ["boise", "miami"]);
  const launched = world.calls.slice(2).map((c) => c.server);
  assert.deepStrictEqual(launched.slice().sort((x, y) => ORIGINAL.indexOf(x) - ORIGINAL.indexOf(y)), launched, "fallback servers launched in the site's order");
  assert.strictEqual(order.length, ORIGINAL.length, "each original-audio server asked exactly once (no retries)");
  assert(peak <= 3, `at most 3 fallback requests in flight, saw ${peak}`);
  const startOf = (n) => world.calls.find((c) => c.server === n).t;
  assert(startOf("dallas") < startOf("nashville") + 400, "the slow Nashville failure did not hold back later servers");
  console.log(`✓ all 13 servers once, site order, sliding window (peak ${peak} in flight), slow failure non-blocking`);

  // 4. One seed for the whole title, however many servers are asked.
  assert.strictEqual(world.seedCalls, 1, "one seed fetch per title");
  console.log("✓ one shared seed per title");

  // 5. Concurrent 401s -> exactly one re-seed, each 401'd server retried once.
  resetWorld();
  world.servers.miami = { status: 200, sources: [src("1080p", "mi")], unauthorizedOnce: true };
  world.servers.boise = { status: 200, sources: [src("720p", "bo")], unauthorizedOnce: true };
  s = await getStreams("1644915", "movie");
  assert.strictEqual(s.length, 2);
  assert.strictEqual(world.seedCalls, 2, "concurrent 401s share a single re-seed");
  assert.strictEqual(served().filter((n) => n === "miami").length, 2, "401 -> one retry with the new seed");
  console.log("✓ concurrent 401s: one re-seed, one retry per server");

  // 6. Seed rate-limited -> no server asked, and the miss is cached briefly (no hammering).
  resetWorld({ seedMode: "429" });
  s = await getStreams("1644916", "movie");
  assert.deepStrictEqual(s, []);
  assert.strictEqual(world.calls.length, 0, "no /sources request while /seed is rate-limited");
  const seedsBefore = world.seedCalls;
  s = await getStreams("1644916", "movie");
  assert.strictEqual(world.seedCalls, seedsBefore, "repeat lookup served from the short miss cache");
  console.log("✓ seed 429: zero server requests, miss cached");

  // 7. A server 429 during the walk stops it (the API is rate-limiting us).
  resetWorld();
  world.servers.chicago = { status: 429 };
  s = await getStreams("1644917", "movie");
  assert.deepStrictEqual(s, []);
  for (const later of ["reno", "oakland", "seattle", "phoenix", "atlanta", "portland", "austin", "dallas"]) {
    assert(!served().includes(later), later + " must not be asked after a 429");
  }
  console.log("✓ a 429 mid-walk stops the fallback");

  // 8. Time budget: hanging servers cannot hold the lookup past budgetMs.
  resetWorld();
  for (const n of ORIGINAL) world.servers[n] = { hang: true };
  const t = Date.now();
  s = await getStreams("1644918", "movie", undefined, undefined, { budgetMs: 1200, requestTimeoutMs: 400 });
  const took = Date.now() - t;
  assert.deepStrictEqual(s, []);
  assert(took < 1700, `lookup must respect the budget, took ${took} ms`);
  assert(served().length < ORIGINAL.length, "not every server is asked once the budget is spent");
  console.log(`✓ budget respected with hanging servers (${took} ms, ${served().length} servers asked)`);

  // 9. TV: season / episode / totalSeasons as the site sends them.
  resetWorld({ details: { title: "Some Show", year: 2024, imdbId: "tt1234567", seasons: [{}, {}, {}] } });
  world.servers.miami = { status: 200, sources: [src("1080p", "tv")] };
  s = await getStreams("99001", "tv", 2, 5);
  const tp = world.calls.find((c) => c.server === "miami").params;
  assert.deepStrictEqual(
    { mediaType: tp.mediaType, seasonId: tp.seasonId, episodeId: tp.episodeId, totalSeasons: tp.totalSeasons },
    { mediaType: "tv", seasonId: "2", episodeId: "5", totalSeasons: "3" }
  );
  assert(s[0].title.startsWith("S02E05"));
  console.log("✓ TV request fields");

  // 10. Detail page unavailable: still asks the servers (fields the site would send are omitted).
  resetWorld({ details: null, tmdbMeta: { title: "Recovered Movie", release_date: "2025-04-03", external_ids: { imdb_id: "tt7654321" } } });
  world.servers.miami = { status: 200, sources: [src("1080p", "nd")] };
  s = await getStreams("1644919", "movie");
  assert.strictEqual(s.length, 1);
  assert.strictEqual(world.calls[0].params.title, encodeURIComponent("Recovered Movie"));
  assert.strictEqual(world.calls[0].params.year, "2025");
  assert.strictEqual(world.calls[0].params.imdbId, "tt7654321");
  console.log("✓ recovers title/year/IMDb from TMDB proxy when Movy detail page is unavailable");

  // 11. "Auto" labelling: multi-variant master -> Auto (up to X); unreadable master -> Auto;
  //     a language label stays Unknown (<label>).
  resetWorld();
  const multi = "https://cdn.example/mi/multi.m3u8";
  const broken = "https://cdn.example/mi/broken.m3u8";
  world.servers.miami = { status: 200, sources: [{ url: multi, quality: "Auto" }, { url: broken, quality: "auto" }, { url: "https://cdn.example/mi/en.m3u8", quality: "English" }] };
  world.masters = {
    [multi]: { body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nb.m3u8\n" },
    [broken]: { status: 403, body: "" },
  };
  s = await getStreams("1644920", "movie");
  const byUrl = Object.fromEntries(s.map((x) => [x.url, x]));
  assert.strictEqual(byUrl[multi].name, "Movy Miami - Auto");
  assert(/Auto \(up to 1080p\) HLS$/.test(byUrl[multi].title), byUrl[multi].title);
  assert.strictEqual(byUrl[broken].name, "Movy Miami - Auto", "unreadable master stays Auto");
  assert.strictEqual(byUrl["https://cdn.example/mi/en.m3u8"].quality, "Unknown");
  assert(/\(English\)/.test(byUrl["https://cdn.example/mi/en.m3u8"].title));
  console.log("✓ Auto sources: single variant -> its height, several -> Auto (up to X), unreadable -> Auto; language labels kept");

  // 12. 900p sorts between 1080p and 720p; existing ranks unchanged.
  const ranked = sortByQuality(["720p", "Auto", "900p", "4K", "1080p", "Unknown", "240p"].map((q) => ({ quality: q }))).map((x) => x.quality);
  assert.deepStrictEqual(ranked, ["4K", "1080p", "900p", "720p", "Auto", "Unknown", "240p"]);
  console.log("✓ 900p ranks between 1080p and 720p");

  console.log("\n🎉 Movy fallback offline tests passed\n");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
