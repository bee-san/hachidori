// Evidence for #607 through the real extension, kept on the evidence branch.
// Loads one checkout's unpacked extension in Chrome for Testing with a fresh
// profile, imports a made-up term dictionary for 非常に and 非常, twelve
// frequency dictionaries ranking both and two pitch dictionaries through the
// offscreen engine (hd_import), hovers 非常に on a local page, presses Show
// more, and reads which pitch dictionaries each entry shows; then hovers 非常
// on its own. Uses the suite's closed-shadow popup reader.
// Usage: HACHIDORI_CHROME=... node extension-probe.mjs <repo> <label> <output dir>
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, label, output] = process.argv.slice(2);
mkdirSync(output, { recursive: true });
const { buildTitledZip } = await import(pathToFileURL(resolve(repo, "test/make-fixture.mjs")));
const { hoverForPopup, popupReader } = await import(pathToFileURL(resolve(repo, "test/chrome-e2e/popup-reader.mjs")));
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");

const word = ["非常", "ひじょう"];
const phrase = ["非常に", "ひじょうに"];
const rank = ([expression, reading], value) => [expression, "freq", { reading, frequency: { value, displayValue: String(value) } }];
const pitch = (...positions) => [word[0], "pitch", { reading: word[1], pitches: positions.map(position => ({ position })) }];
const archives = [
  ["Sample terms", { terms: [[...phrase, "adv", "", 0, ["very; extremely"], 1, ""], [...word, "n", "", 0, ["emergency"], 2, ""]] }],
  ["Pitch sample A", { banks: false, termMeta: [pitch(0), [phrase[0], "pitch", { reading: phrase[1], pitches: [{ position: 0 }] }]] }],
  ["Pitch sample B", { banks: false, termMeta: [pitch(0, 1)] }],
  ...Array.from({ length: 12 }, (_, index) => [`Frequency ${String(index + 1).padStart(2, "0")}`, { banks: false,
    termMeta: [rank(word, 1000 + 37 * (index + 1)), rank(phrase, 2000 + 41 * (index + 1))] }]),
];

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<!doctype html><meta charset="utf-8"><body style="font:28px sans-serif;margin:40px">'
    + '<p><span id="verb">非常に</span></p></body>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const profile = mkdtempSync(join(tmpdir(), "hachi-607-probe-"));
const extension = resolve(repo, "extension");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true,
  headless: true, userDataDir: profile, protocolTimeout: 120_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const result = { label };
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().endsWith("/background.js"), { timeout: 60_000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  await settings.waitForFunction(async () => (await chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen", type: "hd_status" }))?.ready === true, { timeout: 120_000, polling: 250 });
  for (const [title, options] of archives) {
    await settings.evaluate(async base64 => {
      const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))],
        { type: "application/zip" }));
      try {
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
          requestId: "probe-import", blobUrl, fileName: "probe.zip" });
        if (!reply.ok) throw new Error(reply.error);
      } finally { URL.revokeObjectURL(blobUrl); }
    }, buildTitledZip(title, options).toString("base64"));
  }
  // The reader's defaults, written as Settings writes them, plus lookups on a
  // plain hover (a fresh profile waits for the activation key).
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { lookupMode: "hover", maxResults: 32, averageFrequency: false,
        showPitchAccentBadge: true } });
    if (!reply.ok) throw new Error(reply.error);
  });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 900, height: 900 });
  await tab.goto(pageUrl, { waitUntil: "load" });
  const popup = await popupReader(tab);
  async function entries(text, gloss) {
    await tab.keyboard.press("Escape");
    await tab.$eval("#verb", (element, value) => { element.textContent = value; }, text);
    const shown = await hoverForPopup(tab, popup, "#verb", { accept: value => value.plain.includes(gloss) });
    if (!shown) throw new Error(`no popup for ${text}`);
    await popup.click(".gsm-hoshidicts-show-more");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = await popup.dictionaryTabs();
      if (value && !value.showMore && value.entries[0]?.expression === text
        && value.entries.some(entry => entry.expression === word[0])) return value;
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error(`${text} did not list ${word[0]}`);
  }
  const summary = value => value.entries.map(entry => ({ expression: entry.expression,
    frequencyTags: entry.frequencyDictionaries.length, pitchDictionaries: entry.pitchDictionaries }));
  const later = await entries(phrase[0], "extremely");
  result[phrase[0]] = summary(later);
  // The later entry, scrolled into view, as the reader scrolls down to it.
  await popup.dictionaryTabs("scroll", 100_000);
  await new Promise(done => setTimeout(done, 300));
  const { rect } = await popup.dictionaryTabs();
  await tab.screenshot({ path: resolve(output, `extension-${label}-later.png`),
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  result[word[0]] = summary(await entries(word[0], "emergency"));
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
writeFileSync(resolve(output, `extension-${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
