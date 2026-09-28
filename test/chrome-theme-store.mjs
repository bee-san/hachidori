// Focused MVP check: Store opt-in, real hover, kanji/Back, and Default restore.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const output = resolve(process.env.HACHIDORI_THEME_OUTPUT || resolve(root, "test/tmp/theme-store"));
const extension = resolve(root, "extension");
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-theme-smoke-"));
mkdirSync(output, { recursive: true });
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><meta charset="utf-8"><style>body{font:32px sans-serif;padding:80px}</style><p>朝ごはんを<span id="word">食べたかった</span>。</p>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.HACHIDORI_CHROME || resolve(root, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"),
    headless: true, enableExtensions: true, userDataDir: profile,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
  });
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120000);
  const errors = [];
  settings.on("pageerror", error => { errors.push(error.message); console.log("page error", error.message); });
  await settings.setViewport({ width: 1400, height: 1000 });
  await settings.goto(`${origin}/settings.html#add-dictionaries`);
  await settings.bringToFront();
  console.log("settings loaded");
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  console.log("engine ready");
  await (await settings.$("#import-file")).uploadFile(resolve(root, "test/fixtures/hachidori-fixture.zip"));
  await settings.waitForFunction(() => document.getElementById("import-state").textContent.includes("1 imported, 0 failed"));
  console.log("fixture imported");
  assert.equal(await settings.$eval("#theme-store", node => node.hidden), true);
  await settings.evaluate(() => { location.hash = "advanced"; });
  await settings.waitForSelector("#opt-experimental-themeStore", { visible: true });
  await settings.click("#opt-experimental-themeStore");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options?.experimental?.themeStore === true);
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { hoverEnabled: true, lookupMode: "hover" } });
    if (!reply.ok) throw new Error(reply.error);
    location.hash = "design";
  });
  await settings.waitForSelector(".theme-store-card button", { visible: true });
  assert.equal(await settings.$$eval(".theme-store-card", cards => cards.length), 2);
  const tab = await browser.newPage();
  tab.on("pageerror", error => { errors.push(error.message); console.log("tab error", error.message); });
  tab.on("console", message => { if (["error", "warn"].includes(message.type())) console.log(message.type(), message.text()); });
  await tab.setViewport({ width: 1100, height: 800 });
  await tab.goto(`http://127.0.0.1:${server.address().port}`);
  const popup = () => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
  const hover = async () => {
    await tab.bringToFront();
    await tab.mouse.move(2, 2);
    const point = await tab.$eval("#word", node => {
      const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 1);
      const box = range.getBoundingClientRect(); return { x: box.x + box.width * .2, y: box.y + box.height / 2 };
    });
    await tab.mouse.move(point.x, point.y);
    await tab.waitForFunction(() => {
      const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
      return popup && !popup.hidden && popup.querySelector(".gsm-hoshidicts-entry");
    });
  };
  const screenshot = async name => {
    const handle = await tab.evaluateHandle(popup);
    await handle.asElement().screenshot({ path: resolve(output, `${name}.png`) });
    await handle.dispose();
  };
  console.log("hover");
  await hover();
  await screenshot("default");
  await settings.bringToFront();
  await settings.click(".theme-store-card:nth-child(2) button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "nazeka");
  console.log("hover");
  await hover();
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".nazeka-reading")?.textContent === "たべる");
  const evidence = await tab.evaluate(() => {
    const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
    const shadow = popup.getRootNode();
    return { defaultStyles: shadow.adoptedStyleSheets.some(sheet => [...sheet.cssRules].some(rule => rule.cssText.includes(".gsm-hoshidicts-glossary-card"))),
      dictionaryStyles: shadow.querySelectorAll("[data-hoshidicts-dictionary-style]").length,
      richNodes: popup.querySelectorAll(".gsm-hoshidicts-glossary-card,img,.gloss-link").length,
      hiddenToolbar: !popup.querySelector(".gsm-hoshidicts-result-chrome"),
      background: getComputedStyle(popup).backgroundColor,
      reading: popup.querySelector(".nazeka-reading").textContent,
      word: popup.querySelector(".gsm-hoshidicts-expression").getAttribute("aria-label") };
  });
  assert.equal(evidence.hiddenToolbar, true);
  assert.equal(evidence.defaultStyles, false);
  assert.equal(evidence.dictionaryStyles, 0);
  assert.equal(evidence.richNodes, 0);
  assert.equal(evidence.background, "rgb(17, 17, 17)");
  await screenshot("nazeka");
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-link").click());
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".nazeka-kanji-info"));
  await screenshot("nazeka-kanji");
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back").click());
  await tab.waitForFunction(() => !!document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".nazeka-word"));
  await settings.bringToFront();
  await settings.waitForFunction(() => [...document.querySelectorAll(".theme-store-preview")].every(image => image.complete && image.naturalWidth > 0));
  const carousel = await settings.$eval(".theme-store-grid", node => ({ width: node.clientWidth, scroll: node.scrollWidth, flow: getComputedStyle(node).gridAutoFlow }));
  assert.equal(carousel.flow, "column");
  assert.ok(carousel.scroll > carousel.width, "cards scroll horizontally");
  const preview = settings.frames().find(frame => frame.url().includes("design-preview.html"));
  assert.equal(await preview.evaluate(() => document.getElementById("preview-host").dataset.hoshidictsRenderer), "nazeka");
  await settings.screenshot({ path: resolve(output, "store.png") });
  await settings.click(".theme-store-card:first-child button");
  await settings.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupTheme === "default");
  console.log("hover");
  await hover();
  await tab.waitForFunction(() => {
    const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
    return popup && !popup.querySelector(".nazeka-word") && !popup.querySelector(".gsm-hoshidicts-result-chrome")?.hidden;
  });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify({ chrome: await browser.version(), ...evidence,
    checks: ["Store hidden by default", "experimental opt-in", "two bundled themes", "Nazeka hover", "kanji and Back", "Default restore"], errors }, null, 2));
  console.log(`PASS: Store opt-in, Nazeka hover, kanji/Back and Default restore. Evidence: ${output}`);
} catch (error) { console.error(error); throw error; } finally {
  await browser?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
