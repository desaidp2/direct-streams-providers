/**
 * Vidy provider offline tests. All upstream requests are stubbed.
 * Run: node test-vidy-offline.js
 */
const assert = require("assert");
const { keystream } = require("./src/movy/mvm1-byte-codecs");

const API = "https://api.wecollege.net";
const SERVERS = [
  "miami", "boise", "vegas", "reno", "oakland", "seattle", "phoenix",
  "atlanta", "portland", "austin", "dallas", "tampa", "orlando",
  "denver", "munich", "berlin", "paris", "delhi", "cancun",
];
let calls;
let sourceByServer;
function encrypt(obj, seed, mediaId) {
  const plain = Buffer.concat([Buffer.from("mvm1"), Buffer.from(JSON.stringify(obj))]);
  const ks = keystream(seed, Number(mediaId), plain.length);
  return '"' + Buffer.from(plain.map((b, i) => b ^ ks[i])).toString("base64url") + '"';
}
function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}
global.fetch = async (input) => {
  const u = new URL(input);
  calls.push(u);
  if (u.origin !== API) throw new Error("Unexpected request: " + input);
  if (u.pathname === "/seed") return reply(200, JSON.stringify({ seed: "vidy-test-seed" }));
  const server = u.pathname.split("/")[1];
  const result = sourceByServer[server];
  if (!result) return reply(503, "unavailable");
  return reply(200, encrypt(result, u.searchParams.get("seed"), u.searchParams.get("tmdbId")));
};

const { getStreams } = require("./src/vidy");
async function run() {
  calls = [];
  sourceByServer = {
    miami: { playlist: "https://cdn.example/miami.m3u8", sources: [
      { quality: "720p", url: "https://cdn.example/miami-720.m3u8" },
    ] },
    atlanta: { playlist: "https://cdn.example/master.m3u8", sources: [
      { quality: "720p", url: "https://cdn.example/720.m3u8" },
      { quality: "1080p", url: "https://cdn.example/1080.m3u8" },
    ], subtitles: [{ language: "English", url: "https://subs.example/en.srt" }] },
    delhi: { playlist: "https://cdn.example/delhi.m3u8" },
  };
  let streams = await getStreams("12345", "movie");
  assert.deepStrictEqual(streams.map((s) => s.url), [
    "https://cdn.example/miami.m3u8",
    "https://cdn.example/miami-720.m3u8",
    "https://cdn.example/master.m3u8",
    "https://cdn.example/1080.m3u8",
    "https://cdn.example/720.m3u8",
    "https://cdn.example/delhi.m3u8",
  ]);
  assert.strictEqual(streams[0].name, "Vidy - Miami");
  assert.strictEqual(streams[2].name, "Vidy - Atlanta");
  assert.strictEqual(streams[5].name, "Vidy - Delhi");
  assert.strictEqual(streams[2].quality, "Auto");
  assert.strictEqual(streams[3].quality, "1080p");
  assert.strictEqual(streams[2].subtitles.length, 1);
  for (const server of SERVERS) {
    assert(calls.some((u) => u.pathname === "/" + server + "/sources"), "query " + server);
  }
  console.log("✓ movie: queries all candidate regions and returns streams from multiple regions");

  calls = [];
  sourceByServer = { miami: { sources: [{ quality: "1080p", url: "https://cdn.example/tv.m3u8" }] } };
  streams = await getStreams("67890", "tv", 2, 7);
  const sourceCall = calls.find((u) => u.pathname === "/miami/sources");
  assert.strictEqual(sourceCall.searchParams.get("mediaType"), "tv");
  assert.strictEqual(sourceCall.searchParams.get("seasonId"), "2");
  assert.strictEqual(sourceCall.searchParams.get("episodeId"), "7");
  assert(streams[0].title.startsWith("S02E07"));
  console.log("✓ TV: season and episode parameters");

  assert.deepStrictEqual(await getStreams("../bad", "movie"), []);
  console.log("✓ invalid TMDB IDs rejected");
  console.log("\nVidy offline tests passed\n");
}
run().catch((err) => { console.error(err); process.exit(1); });
