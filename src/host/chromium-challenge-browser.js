/**
 * Node-only `challengeBrowser` host for server.js, backed by a real, unmodified Chromium
 * (playwright-core driving the system browser, e.g. /usr/bin/chromium on the Raspberry Pi).
 *
 * Providers already look for a host `challengeBrowser.execute(url, opts)` (the SkyStream /
 * webview contract). On a self-hosted server there is no app webview, so this module supplies
 * one: each call opens a tab in one persistent browser profile, loads the URL like any visitor,
 * lets the site's own interstitial (e.g. an Anubis "making sure you're not a bot" page) run its
 * JavaScript and redirect, then evaluates `opts.evaluateJs` on the final page.
 *
 * Deliberately NOT done: no stealth patches, no User-Agent / fingerprint spoofing, no solving
 * challenges outside the page. If the site does not let this browser through, the call fails.
 *
 * Not bundled into providers/*.js (src/host has no index.js, so build.js skips it).
 *
 * Env:
 *   CHALLENGE_BROWSER_PATH      Chromium binary (default /usr/bin/chromium)
 *   CHALLENGE_BROWSER_PROFILE   profile dir (default /tmp/dsp-challenge-browser, RAM on the Pi)
 *   CHALLENGE_BROWSER_HEADLESS  "0" for a headed browser (run under xvfb-run)
 */

const fs = require("fs");

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TABS = 2;
// Interstitial markers: Anubis serves its challenge under /.within.website/ with this title.
const INTERSTITIAL_URL = /\/\.within\.website\//;
const INTERSTITIAL_TITLE = /not a bot|checking your browser|ddos-guard/i;

let contextPromise = null;
let activeTabs = 0;
const waiters = [];

function loadBrowserEngine() {
  try {
    return require("patchright");
  } catch (_) {
    try {
      return require("playwright-core");
    } catch (e) {
      throw new Error("Neither patchright nor playwright-core is installed (npm i patchright)");
    }
  }
}

function resolveProfileDir() {
  if (process.env.CHALLENGE_BROWSER_PROFILE) return process.env.CHALLENGE_BROWSER_PROFILE;
  const homeConfig = process.env.HOME ? process.env.HOME + "/.config/dsp-challenge-browser" : null;
  return homeConfig || "/tmp/dsp-challenge-browser";
}

function resolveDisplay() {
  if (process.env.DISPLAY) return;
  if (fs.existsSync("/tmp/.X11-unix/X0")) process.env.DISPLAY = ":0";
}

function getContext() {
  if (!contextPromise) {
    resolveDisplay();
    const { chromium } = loadBrowserEngine();
    const execPath =
      process.env.CHALLENGE_BROWSER_PATH ||
      (typeof chromium.executablePath === "function" ? chromium.executablePath() : "/usr/bin/chromium");
    const profileDir = resolveProfileDir();
    const headless = process.env.CHALLENGE_BROWSER_HEADLESS === "1";
    contextPromise = chromium
      .launchPersistentContext(profileDir, {
        executablePath: execPath,
        headless: headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      })
      .then((ctx) => {
        // A crashed/closed browser is relaunched on the next call.
        ctx.on("close", () => {
          contextPromise = null;
          cachedUserAgent = "";
        });
        return ctx;
      })
      .catch((err) => {
        contextPromise = null;
        throw err;
      });
  }
  return contextPromise;
}

// At most MAX_TABS pages at once: a Pi 4 has 4 cores and every tab runs page JS.
async function acquireTab() {
  if (activeTabs < MAX_TABS) {
    activeTabs++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  activeTabs++;
}
function releaseTab() {
  activeTabs--;
  const next = waiters.shift();
  if (next) next();
}

async function onInterstitial(page) {
  if (INTERSTITIAL_URL.test(page.url())) return true;
  const title = await page.title().catch(() => "");
  return INTERSTITIAL_TITLE.test(title);
}

// Kept tabs for `reuse: true`: one open page per URL, so repeated same-origin work (an in-page
// fetch of a JSON API, as the site's own scripts do) skips a full page load per call.
const keptPages = new Map();

async function openKeptPage(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.on("close", () => keptPages.delete(url));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: left() });
    while (await onInterstitial(page)) {
      if (Date.now() >= deadline) throw new Error("interstitial did not clear in " + timeoutMs + "ms");
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: left() }).catch(() => {});
    }
    return page;
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

function formatCookieHeader(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return "";
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// The browser's UA is fixed for the life of a launched context (patchright advises against
// overriding it), so it is read once per context and reused: one CDP evaluate round-trip
// per execute() saved. Reset when the context closes, since a relaunch may change it.
let cachedUserAgent = "";

async function readUserAgent(page) {
  if (cachedUserAgent) return cachedUserAgent;
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => "");
  if (ua) cachedUserAgent = ua;
  return ua;
}

// Cookies are re-read every call on purpose: the site rotates them (Anubis / DDoS-Guard).
async function extractSessionHeaders(page, url) {
  const ctx = page.context();
  const [cookiesList, userAgent] = await Promise.all([ctx.cookies(url).catch(() => []), readUserAgent(page)]);
  return { cookies: formatCookieHeader(cookiesList), userAgent: userAgent };
}

async function executeOnKeptPage(url, options) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let entry = keptPages.get(url);
  if (!entry) {
    entry = openKeptPage(url, timeoutMs);
    keptPages.set(url, entry);
    entry.catch(() => keptPages.delete(url));
  }
  const page = await entry;
  if (await onInterstitial(page)) {
    // The site re-challenged this tab; drop it so the next call opens a fresh one.
    keptPages.delete(url);
    await page.close().catch(() => {});
    throw new Error("kept page is on an interstitial again");
  }
  const result = await page.evaluate(options.evaluateJs || "document.documentElement.outerHTML");
  const session = await extractSessionHeaders(page, url);
  return {
    result: result,
    status: 200,
    finalUrl: page.url(),
    cookies: session.cookies,
    userAgent: session.userAgent,
  };
}

// Drops every kept tab (e.g. after the site starts refusing them).
async function resetKeptPages() {
  const entries = [...keptPages.values()];
  keptPages.clear();
  for (const e of entries) {
    const page = await e.catch(() => null);
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Loads `url` in a browser tab and evaluates `opts.evaluateJs` (a JS expression string; a
 * returned Promise is awaited) on the final page. Resolves { result, status, finalUrl };
 * `status` is the HTTP status of the last document load. Rejects on timeout, browser failure,
 * or an interstitial that never clears. `opts.reuse` keeps the tab open for later calls.
 */
async function execute(url, opts) {
  const options = opts || {};
  if (options.reuse) return executeOnKeptPage(url, options);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());

  await acquireTab();
  let page = null;
  try {
    const ctx = await getContext();
    page = await ctx.newPage();
    let lastStatus = null;
    page.on("response", (res) => {
      if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) lastStatus = res.status();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: left() });

    // Let the site's own interstitial finish and navigate back to the target.
    while (await onInterstitial(page)) {
      if (Date.now() >= deadline) throw new Error("interstitial did not clear in " + timeoutMs + "ms");
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: left() }).catch(() => {});
    }

    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, { timeout: left() });
    }
    const result = await page.evaluate(options.evaluateJs || "document.documentElement.outerHTML");
    const session = await extractSessionHeaders(page, url);
    return {
      result: result,
      status: lastStatus,
      finalUrl: page.url(),
      cookies: session.cookies,
      userAgent: session.userAgent,
    };
  } finally {
    if (page) await page.close().catch(() => {});
    releaseTab();
  }
}

async function getCookies(url = "https://flystream.net") {
  const ctx = await getContext();
  const cookiesList = await ctx.cookies(url).catch(() => []);
  return formatCookieHeader(cookiesList);
}

// Cached UA, else read from an already open page, else from a short-lived tab that goes
// through acquireTab like every other tab (it used to bypass MAX_TABS on the Pi).
async function getUserAgent() {
  if (cachedUserAgent) return cachedUserAgent;
  const ctx = await getContext();
  const pages = ctx.pages();
  if (pages.length > 0) return readUserAgent(pages[0]);
  await acquireTab();
  let page = null;
  try {
    page = await ctx.newPage();
    return await readUserAgent(page);
  } catch (_) {
    return "";
  } finally {
    if (page) await page.close().catch(() => {});
    releaseTab();
  }
}

// Opens the site once so a later API call finds the profile already past the interstitial.
async function warmUp(url) {
  const t0 = Date.now();
  try {
    const r = await execute(url, { evaluateJs: "document.title", timeoutMs: 45000 });
    console.log(`[ChallengeBrowser] warm-up ${url} -> ${r.status} "${r.result}" in ${Date.now() - t0}ms`);
    return true;
  } catch (err) {
    console.warn(`[ChallengeBrowser] warm-up ${url} failed after ${Date.now() - t0}ms:`, err.message || err);
    return false;
  }
}

async function close() {
  await resetKeptPages();
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null;
  if (ctx) await ctx.close().catch(() => {});
}

module.exports = { execute, warmUp, resetKeptPages, close, getCookies, getUserAgent };
