/**
 * Offline spec for the Movy server fallback (issue #1). `fetch` is stubbed: nothing here
 * contacts movy.sx or api.wecollege.net. Payloads are real mvm1 ciphertext built with the
 * provider's own keystream, so decryption is exercised end to end.
 *
 * Behaviour pinned (from movy.sx's player script, 2026-11-08):
 *  - original-audio servers in the site's order: miami, boise, nashville, chicago, vegas, reno,
 *    oakland, seattle, phoenix, atlanta, portland, austin, dallas; dubbed servers never asked
 *  - miami + boise first, then the rest in batches of 3, stopping after the first batch with sources
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
  if (u.hostname === "subtitles.vidy.st") return reply(200, "[]");
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
  world.servers.reno = { status: 200, sources: [src("900p", "re")] };
  s = await getStreams("1644913", "movie");
  assert.deepStrictEqual(s.map((x) => `${x.name}|${x.quality}`), ["Movy Reno - 900p|900p"]);
  assert.deepStrictEqual(served().slice(0, 2).sort(), ["boise", "miami"]);
  assert.deepStrictEqual(served().slice(2).sort(), ["chicago", "nashville", "oakland", "reno", "seattle", "vegas"].sort());
  for (const later of ["phoenix", "atlanta", "portland", "austin", "dallas"]) assert(!served().includes(later), later + " must not be asked after Reno's batch had sources");
  for (const d of DUBBED) assert(!served().includes(d), d + " (dubbed) must never be asked");
  console.log("✓ Reno 900p found: walks the site's order in batches, stops after the first batch with sources");

  // 3. Batches run one after another, in the site's order, 3 at a time.
  resetWorld();
  for (const n of ORIGINAL) world.servers[n] = { status: 500, delayMs: 40 };
  s = await getStreams("1644914", "movie", undefined, undefined, { budgetMs: 5000 });
  assert.deepStrictEqual(s, []);
  const order = served();
  assert.deepStrictEqual(order.slice(0, 2).sort(), ["boise", "miami"]);
  const batches = [["nashville", "chicago", "vegas"], ["reno", "oakland", "seattle"], ["phoenix", "atlanta", "portland"], ["austin", "dallas"]];
  let i = 2;
  for (const batch of batches) {
    assert.deepStrictEqual(order.slice(i, i + batch.length).sort(), batch.slice().sort(), "batch " + batch.join(","));
    i += batch.length;
  }
  assert.strictEqual(order.length, ORIGINAL.length, "each original-audio server asked exactly once (no retries)");
  const startOf = (n) => world.calls.find((c) => c.server === n).t;
  assert(startOf("reno") >= startOf("vegas") + 30, "next batch starts after the previous one finished");
  console.log("✓ all 13 original-audio servers, site order, batches of 3, one attempt each");

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
  resetWorld({ details: null });
  world.servers.miami = { status: 200, sources: [src("1080p", "nd")] };
  s = await getStreams("1644919", "movie");
  assert.strictEqual(s.length, 1);
  assert(!("title" in world.calls[0].params), "no title when the detail page is unavailable");
  console.log("✓ works without the detail page");

  // 11. 900p sorts between 1080p and 720p; existing ranks unchanged.
  const ranked = sortByQuality(["720p", "Auto", "900p", "4K", "1080p", "Unknown", "240p"].map((q) => ({ quality: q }))).map((x) => x.quality);
  assert.deepStrictEqual(ranked, ["4K", "1080p", "900p", "720p", "Auto", "Unknown", "240p"]);
  console.log("✓ 900p ranks between 1080p and 720p");

  console.log("\n🎉 Movy fallback offline tests passed\n");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
