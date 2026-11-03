// Local preview for #656 (not committed): the search page header with the
// Anki Template switch, click lookups, and the popup window size, in real Chrome.
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
const OUT = process.env.OUT || "/tmp/hachi656-probe/shots";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-preview-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const errors = [];
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  settings.on("pageerror", e => errors.push(`[settings] ${e.message}`));
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const imported = await settings.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try { return await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: "p", blobUrl, fileName: "f.zip" }); }
    finally { URL.revokeObjectURL(blobUrl); }
  }, buildFixtureZip().toString("base64"));
  assert.equal(imported?.ok, true, JSON.stringify(imported));
  const write = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options;
  }, patch);
  const { anki } = await settings.evaluate(async () => globalThis.HDReaderOptions.normaliseOptions((await chrome.storage.local.get("options")).options));
  const base = anki.templates[0];
  await write({ anki: await settings.evaluate((anki) => globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
    templates: [{ ...anki.templates[0], name: "Lapis sentences" }, { ...anki.templates[0], id: "words", name: "Words" },
      { ...anki.templates[0], id: "kanji", name: "Kanji" }] }), anki) });
  await write({ searchClickLookup: process.env.CLICK !== "0", lookupMode: "activationSticky" });

  for (const [width, height] of [[600, 640], [960, 760], [420, 600]]) {
    const search = await browser.newPage();
    search.on("pageerror", e => errors.push(`[search] ${e.message}`));
    await search.setViewport({ width, height });
    await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
    const frameUrl = `chrome-extension://${id}/search-frame.html`;
    await search.waitForFrame(frameUrl, { timeout: 30000 });
    const frame = search.frames().find(f => f.url() === frameUrl);
    await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 30000 });
    await search.waitForFunction(() => !document.querySelector(".search-template").hidden, { polling: 100, timeout: 10000 });
    const rects = {
      shell: await search.evaluate(() => [".search-template", ".lookup-enable", "h1"].map(s => document.querySelector(s).getBoundingClientRect().toJSON())),
      frame: await frame.evaluate(() => [".search-template", ".lookup-enable", "h1"].map(s => document.querySelector(s).getBoundingClientRect().toJSON())),
      value: await search.$eval("#search-template", s => [s.value, [...s.options].map(o => o.text)]),
    };
    const same = rects.shell.every((r, i) => ["x", "y", "width", "height"].every(k => Math.abs(r[k] - rects.frame[i][k]) < 0.5));
    console.log(`${width}x${height} aligned=${same}`, JSON.stringify(rects.value), JSON.stringify(rects.shell.map(r => [r.x, r.y, r.width, r.height].map(Math.round))));
    await frame.focus("#search-input");
    await frame.$eval("#search-input", box => { box.value = "漢字を読む"; });
    await search.keyboard.press("Enter");
    const popup = await popupReader(search, 0, frameUrl);
    const shown = await popup.waitForVisible(15000, s => s.plain.includes("漢字"));
    await search.screenshot({ path: `${OUT}/search-${width}x${height}.png` });
    if (width === 960) {
      // Click 読 in the echoed query.
      const point = await frame.evaluate(() => {
        const node = document.getElementById("search-query").firstChild;
        const range = document.createRange();
        const offset = node.nodeValue.indexOf("読");
        range.setStart(node, offset); range.setEnd(node, offset + 1);
        const r = range.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await search.mouse.click(point.x, point.y);
      const read = await popup.waitForVisible(10000, s => s.plain.includes("読む"));
      console.log("click query ->", read?.plain.slice(0, 40) ?? null);
      // Choose a Template with the mouse-like select.
      await search.select("#search-template", "kanji");
      await new Promise(r => setTimeout(r, 500));
      const stored = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options.anki.templates.map(t => t.id));
      const focus = await search.evaluate(() => document.activeElement?.id || document.activeElement?.localName);
      console.log("templates after choice", JSON.stringify(stored), "shell focus", focus,
        "frame copy", await frame.$eval("select.search-template", s => s.value));
      await search.screenshot({ path: `${OUT}/search-${width}x${height}-after.png` });
      await search.screenshot({ path: `${OUT}/header-${width}.png`, clip: { x: 0, y: 0, width, height: 120 } });
    }
    await search.close();
  }
  console.log("errors:", JSON.stringify(errors));
} finally {
  await browser.close();
}
