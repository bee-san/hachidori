// Evidence for #656 (not committed): the search page with the Anki Template
// switch in four palettes, its keyboard focus, a click lookup, the popup
// window at a set size, and Settings → Reading → Search page.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = "/home/skerraut/herd-synth3/clones/hachi-issue-656";
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const { buildFixtureZip } = await import(resolve(ROOT, "test/make-fixture.mjs"));
const { popupReader } = await import(resolve(ROOT, "test/chrome-e2e/popup-reader.mjs"));
const EXTENSION = resolve(ROOT, "extension");
const OUT = process.env.OUT || "/tmp/hachi656-probe/evidence";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-evidence-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", 
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const settle = ms => new Promise(r => setTimeout(r, ms));
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const imported = await settings.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try { return await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: "e", blobUrl, fileName: "f.zip" }); }
    finally { URL.revokeObjectURL(blobUrl); }
  }, buildFixtureZip().toString("base64"));
  assert.equal(imported?.ok, true, JSON.stringify(imported));
  const write = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const anki = await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const anki = globalThis.HDReaderOptions.normaliseOptions(options).anki;
    return globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
      templates: [{ ...anki.templates[0], name: "Lapis sentences" }, { ...anki.templates[0], id: "words", name: "Words" },
        { ...anki.templates[0], id: "kanji", name: "Kanji" }] });
  });
  await write({ anki, lookupMode: "activationSticky" });

  const search = await browser.newPage();
  await search.setViewport({ width: 600, height: 640 });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  const frameUrl = `chrome-extension://${id}/search-frame.html`;
  await search.waitForFrame(frameUrl, { timeout: 30000 });
  const frame = search.frames().find(f => f.url() === frameUrl);
  await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 30000 });
  await search.waitForFunction(() => !document.getElementById("search-template").hidden, { polling: 100, timeout: 10000 });
  await frame.focus("#search-input");
  await frame.$eval("#search-input", box => { box.value = "漢字を読む"; });
  await search.keyboard.press("Enter");
  const popup = await popupReader(search, 0, frameUrl);
  await popup.waitForVisible(15000, s => s.plain.includes("漢字"));
  for (const theme of ["default", "girlypop", "dracula", "high-contrast"]) {
    await write({ popupTheme: theme });
    await frame.waitForFunction(t => document.documentElement.dataset.hoshidictsTheme === t, { polling: 100, timeout: 10000 }, theme).catch(() => {});
    await settle(400);
    await search.screenshot({ path: `${OUT}/search-template-${theme}.png` });
  }
  await write({ popupTheme: "default" });
  await search.emulateMediaFeatures([{ name: "forced-colors", value: "active" }]);
  await settle(400);
  await search.screenshot({ path: `${OUT}/search-template-forced-colors.png` });
  await search.emulateMediaFeatures([]);
  // Keyboard focus on the switch: Shift+Tab from the box goes out of the frame to the header.
  await frame.focus("#search-input");
  await search.keyboard.down("Shift");
  await search.keyboard.press("Tab");
  await search.keyboard.press("Tab");
  await search.keyboard.up("Shift");
  await settle(200);
  const focus = await search.evaluate(() => ({ id: document.activeElement?.id, visible: document.activeElement?.matches(":focus-visible"),
    outline: getComputedStyle(document.activeElement).outlineStyle + " " + getComputedStyle(document.activeElement).outlineWidth }));
  console.log("Shift+Tab focus", JSON.stringify(focus));
  await search.screenshot({ path: `${OUT}/search-template-focus.png`, clip: { x: 0, y: 0, width: 600, height: 70 } });
  // A click lookup on 読む in the query, with the option on.
  await write({ searchClickLookup: true });
  await settle(300);
  const point = await frame.evaluate(() => {
    const node = document.getElementById("search-query").firstChild;
    const range = document.createRange();
    range.setStart(node, 3); range.setEnd(node, 4);
    const r = range.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await search.mouse.click(point.x, point.y);
  console.log("click", (await popup.waitForVisible(10000, s => s.plain.includes("to read")))?.plain.slice(0, 30));
  await search.screenshot({ path: `${OUT}/search-click-lookup.png` });
  // Settings → Reading → Search page.
  await settings.bringToFront();
  await settings.goto(`chrome-extension://${id}/settings.html#lookup`, { waitUntil: "domcontentloaded" });
  await settings.waitForFunction(() => document.getElementById("opt-search-click-lookup")?.checked === true, { polling: 100, timeout: 10000 });
  await settle(500);
  const clip = await settings.$eval("#search-page-settings", element => {
    element.scrollIntoView({ block: "center" });
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x: x + scrollX, y: y + scrollY, width, height };
  });
  await settle(300);
  await settings.screenshot({ path: `${OUT}/settings-search-page.png`, clip });
  // The popup window at a set size.
  await write({ searchWindowWidthPx: 520, searchWindowHeightPx: 480 });
  const size = await settings.evaluate(async () => {
    const { openSearchPage } = await import(chrome.runtime.getURL("search-window.js"));
    await openSearchPage(chrome, "popup");
    await new Promise(r => setTimeout(r, 500));
    const windows = await chrome.windows.getAll();
    return windows.filter(w => w.type === "popup").map(w => [w.width, w.height]);
  });
  console.log("popup window", JSON.stringify(size));
} finally {
  await browser.close();
}
