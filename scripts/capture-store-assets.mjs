// Capture the real extension and original artwork in a disposable Chrome profile.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = resolve(root, "extension");
const output = resolve(root, "docs/store");
const cache = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const chromePath = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || "/usr/bin/chromium";
const puppeteerPath = process.env.HACHIDORI_PUPPETEER
  || resolve(cache, "hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
assert.ok(existsSync(chromePath), "Set HACHIDORI_CHROME to Chrome for Testing or Chromium.");
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-store-assets-"));
const source = "# Original examples for store screenshots\n食べる, たべる, to eat\\n朝ごはんを食べる。 — I eat breakfast.\n光, ひかり, light; sunlight\n鳥, とり, bird\n";
const readerOptions = { popupTheme: "light", popupHeightPx: 320, popupOpacityPercent: 100 };
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(readFileSync(resolve(output, "reading-sample.html")));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const blocked = [];
const interception = new Map();

async function isolate(target) {
  if (!["page", "service_worker", "background_page"].includes(target.type())) return;
  if (!interception.has(target)) interception.set(target, (async () => {
    const cdp = await target.createCDPSession();
    cdp.on("Fetch.requestPaused", async event => {
      const url = event.request.url;
      if (url.startsWith(`${origin}/`)) await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
      else {
        blocked.push(url);
        await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      }
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] });
  })());
  await interception.get(target);
}

async function until(read, predicate, description) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function popupText(cdp) {
  const { root: document } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const walk = node => {
    const classes = (node.attributes || []).findIndex(value => value === "class");
    if (classes >= 0 && node.attributes[classes + 1].split(" ").includes("gsm-hoshidicts-popup")) return node.nodeId;
    for (const child of [...node.children || [], ...node.shadowRoots || []]) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  const nodeId = walk(document);
  if (!nodeId) return "";
  const { object } = await cdp.send("DOM.resolveNode", { nodeId });
  try {
    const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
      functionDeclaration: "function () { return this.hidden ? '' : this.textContent; }" });
    return result.value || "";
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
  }
}

try {
  mkdirSync(output, { recursive: true });
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile,
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  browser.on("targetcreated", target => { isolate(target).catch(() => {}); });
  await Promise.all(browser.targets().map(isolate));
  const target = await browser.waitForTarget(candidate => candidate.type() === "page" && candidate.url().endsWith("/startup.html"));
  await isolate(target);
  const startup = await target.page();
  const settingsUrl = `${target.url().slice(0, target.url().lastIndexOf("/"))}/settings.html`;
  await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await until(() => startup.evaluate(() => document.getElementById("setup-heading")?.textContent),
    value => value === "Welcome to Hachidori", "the welcome disclosure");
  assert.equal(blocked.length, 0, "The untouched welcome page should make no dictionary or Anki request.");
  await startup.screenshot({ path: resolve(output, "welcome-1280x800.png") });
  // Startup rebuilds its controls on storage events; resolve and click in the
  // same page task so a saved element handle cannot be detached meanwhile.
  await startup.evaluate(() => document.getElementById("setup-manual").click());
  await until(() => startup.evaluate(() => document.getElementById("setup-finish") !== null), Boolean, "manual setup");
  await startup.evaluate(() => document.getElementById("setup-finish").click());

  const settings = await browser.newPage();
  await isolate(settings.target());
  await settings.goto(`${settingsUrl}#custom-dictionary`);
  await until(() => settings.evaluate(() => document.getElementById("custom-dictionary-open")?.checkVisibility()), Boolean, "the personal dictionary editor");
  await settings.click("#custom-dictionary-open");
  await until(() => settings.evaluate(() => document.getElementById("custom-dictionary-status")?.textContent),
    value => value === "Loaded source revision 0.", "the empty personal source");
  await settings.$eval("#custom-dictionary-source", (textarea, text) => {
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, source);
  await settings.click("#custom-dictionary-save");
  await until(() => settings.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState?.dictionaries?.[0]?.termCount),
    value => value === 3, "the production dictionary import");
  await settings.evaluate(async options => {
    const stored = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      requestId: "store-reader-appearance", baseRevision: stored.options.revision, options });
    if (!reply?.ok) throw new Error(reply?.error || "Could not save screenshot appearance.");
  }, readerOptions);

  const reading = await browser.newPage();
  await isolate(reading.target());
  await reading.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await reading.goto(`${origin}/reading-sample.html`);
  const hover = await reading.$eval("#lookup-word", node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + 5, y: rect.y + rect.height / 2 };
  });
  await reading.mouse.move(hover.x, hover.y);
  const cdp = await reading.createCDPSession();
  await cdp.send("DOM.enable");
  await until(() => popupText(cdp), value => value.includes("to eat") && value.includes("I eat breakfast"), "the real hover lookup");
  await reading.screenshot({ path: resolve(output, "lookup-1280x800.png") });

  const promo = await browser.newPage();
  await promo.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
  await promo.goto(pathToFileURL(resolve(output, "promo.html")).href);
  await promo.screenshot({ path: resolve(output, "promo-440x280.png") });
  writeFileSync(resolve(output, "capture.json"), `${JSON.stringify({ chrome: await browser.version(),
    viewport: { width: 1280, height: 800 }, promo: { width: 440, height: 280 },
    dictionarySource: source, readerOptions, blockedRequests: blocked }, null, 2)}\n`);
  console.log(`Created welcome, real lookup and promotional assets in ${output}`);
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
  rmSync(profile, { recursive: true, force: true });
}
