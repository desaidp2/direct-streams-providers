/**
 * Offline tests for src/host/chromium-challenge-browser.js. The browser engine is a stub
 * registered as `patchright` in the require cache, so no Chromium starts and no site is
 * contacted. Covers: UA read once per context, cookies read every call, getUserAgent obeys
 * MAX_TABS. Run: node test-challenge-browser-offline.js
 */
const assert = require("assert");
const Module = require("module");

const stats = { uaEvaluates: 0, cookieReads: 0, openPages: 0, maxOpenPages: 0, newPages: 0 };
function makePage(ctx) {
  stats.newPages++;
  stats.openPages++;
  stats.maxOpenPages = Math.max(stats.maxOpenPages, stats.openPages);
  const handlers = {};
  return {
    on: (ev, fn) => (handlers[ev] = fn),
    url: () => "https://example.test/robots.txt",
    title: async () => "ok",
    goto: async () => {},
    waitForNavigation: async () => {},
    waitForSelector: async () => {},
    context: () => ctx,
    mainFrame: () => ({}),
    evaluate: async (fn) => {
      if (typeof fn === "function") {
        stats.uaEvaluates++;
        await new Promise((r) => setTimeout(r, 20));
        return "StubUA/1.0";
      }
      return "result";
    },
    close: async () => {
      stats.openPages--;
      if (handlers.close) handlers.close();
    },
  };
}
const ctx = {
  pagesList: [],
  on: () => {},
  pages() {
    return this.pagesList;
  },
  newPage: async () => makePage(ctx),
  cookies: async () => {
    stats.cookieReads++;
    return [{ name: "a", value: "1" }, { name: "b", value: "2" }];
  },
  close: async () => {},
};
const stubEngine = { chromium: { executablePath: () => "/stub", launchPersistentContext: async () => ctx } };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "patchright") return "patchright";
  return origResolve.call(this, req, ...rest);
};
require.cache["patchright"] = { id: "patchright", filename: "patchright", loaded: true, exports: stubEngine };

const host = require("./src/host/chromium-challenge-browser");

async function run() {
  console.log("\n🧪 Challenge browser host offline tests\n");

  // getUserAgent with no page open goes through acquireTab: never more than MAX_TABS (2) pages.
  const busy = [host.execute("https://example.test/a", {}), host.execute("https://example.test/b", {})];
  const ua0 = await Promise.all([host.getUserAgent(), ...busy]);
  assert.strictEqual(ua0[0], "StubUA/1.0");
  assert(stats.maxOpenPages <= 2, `MAX_TABS exceeded: ${stats.maxOpenPages} pages open at once`);
  console.log(`✓ getUserAgent respects MAX_TABS (peak ${stats.maxOpenPages} pages)`);

  // UA is read once per context; cookies every call.
  const uaBefore = stats.uaEvaluates;
  const cookieBefore = stats.cookieReads;
  for (let i = 0; i < 10; i++) {
    const r = await host.execute("https://example.test/robots.txt", { reuse: true, evaluateJs: "1" });
    assert.strictEqual(r.userAgent, "StubUA/1.0");
    assert.strictEqual(r.cookies, "a=1; b=2");
  }
  assert.strictEqual(stats.uaEvaluates - uaBefore, 0, "UA must come from the cache");
  assert.strictEqual(stats.cookieReads - cookieBefore, 10, "cookies are re-read every call");
  assert.strictEqual(await host.getUserAgent(), "StubUA/1.0");
  console.log(`✓ 10 execute() calls: ${stats.uaEvaluates - uaBefore} UA evaluates (cached), ${stats.cookieReads - cookieBefore} cookie reads`);

  await host.close();
  console.log("\n🎉 Challenge browser host offline tests passed\n");
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
