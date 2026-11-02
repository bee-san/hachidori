import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const EXTENSION = join(REPO, "extension");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644f-")),
  args: ["--no-sandbox", "--disable-gpu", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  const errors = [];
  const watch = page => { page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (["error", "warn"].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`); }); };
  const frameOf = page => page.frames().find(f => f.url().endsWith("/search-frame.html"));
  const check = async (page, label) => {
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && !frameOf(page); i += 1) await sleep(100);
    const frame = frameOf(page);
    await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
    const focused = await frame.evaluate(() => ({ active: document.activeElement?.localName + "#" + document.activeElement?.id, hasFocus: document.hasFocus() }));
    const later = await frame.evaluate(() => { document.getElementById("search-input").focus(); return document.activeElement?.localName + "#" + document.activeElement?.id; });
    const blurred = await frame.evaluate(() => { document.activeElement.blur(); return document.activeElement?.localName; });
    const viaShell = await page.evaluate(() => { document.querySelector("iframe").focus(); return document.activeElement?.localName; });
    await sleep(100);
    const afterShell = await frame.evaluate(() => { document.getElementById("search-input").focus(); return document.activeElement?.localName + "#" + document.activeElement?.id; });
    console.log(label, "later:", later, "blurred:", blurred, "viaShell:", viaShell, "afterShell:", afterShell);
    await page.keyboard.type("a");
    const value = await frame.evaluate(() => document.getElementById("search-input").value);
    const shellActive = await page.evaluate(() => document.activeElement?.localName);
    console.log(label, JSON.stringify({ focused, typed: value, shellActive }));
  };
  const tab = await browser.newPage();
  watch(tab);
  await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await check(tab, "tab:");
  const opened = browser.waitForTarget(t => t.url().endsWith("/search.html") && t !== tab.target(), { timeout: 15000 });
  await settings.evaluate(async () => { const { openSearchPage } = await import(chrome.runtime.getURL("search-window.js")); await openSearchPage(chrome, "popup"); });
  const popup = await (await opened).page();
  watch(popup);
  await check(popup, "popup window:");
  console.log("errors:", JSON.stringify(errors));
} finally { await browser.close(); }
