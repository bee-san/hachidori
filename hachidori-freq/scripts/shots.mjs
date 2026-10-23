// Popup screenshots for the hachidori-freq PRs: a real lookup in real Chrome with
// the unpacked extension of one checkout, over small made-up frequency lists in
// the Discord report's shape (a rank-based Jiten-like list and a CC100-like list
// without frequencyMode). Not part of the repository's suites.
//
// node shots.mjs <checkout> <out-dir> <label> [option-sets-json]
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, out, label] = process.argv.slice(2);
const require = createRequire(resolve(checkout, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { buildTitledZip } = await import(pathToFileURL(resolve(checkout, "test/make-fixture.mjs")).href);
const CHROME = process.env.HACHIDORI_CHROME;
const PROFILE = resolve(tmpdir(), `hachidori-freq-shots-${process.pid}`);
mkdirSync(out, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const query = "平均", reading = "へいきん";
const terms = buildTitledZip("Example terms", { terms: [[query, reading, "", "", 10, ["average; mean"], 0, ""]] });
// SHOTS_DATASET=jpdb: one list shaped like JPDB v2.2 Kana Display Only, whose
// display value carries the word's rank and then its kana form's.
const archives = process.env.SHOTS_DATASET === "jpdb" ? [terms,
  buildTitledZip("JPDBv2㋕", { banks: false, frequencyMode: "rank-based", termMeta: [
    [query, "freq", { reading, frequency: { value: 312, displayValue: "312, 19896㋕" } }]] }),
] : [terms,
  buildTitledZip("Jiten", { banks: false, frequencyMode: "rank-based", termMeta: [
    [query, "freq", { reading, frequency: { value: 15700, displayValue: "15700" } }]] }),
  buildTitledZip("CC100", { banks: false, termMeta: [[query, "freq", 26700]] }),
];
const sets = JSON.parse(process.argv[5] ?? "null") ?? [
  ["averages-off", { averageFrequency: false }],
  ["averages", { averageFrequency: true }],
  ["averages-and-dictionaries", { averageFrequency: true, showFrequencyTagsWithAverage: true }],
];

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><body style="font: 28px sans-serif; margin: 40px 40px 0">
    <p><span id="word">${query}</span>を計算する。</p></body></html>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--lang=en-US",
    `--disable-extensions-except=${resolve(checkout, "extension")}`, `--load-extension=${resolve(checkout, "extension")}`],
});
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const other of await browser.pages()) if (other.url().endsWith("/startup.html")) await other.close();
  await settings.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
    type: "hd_status", requestId: "status" }))?.ready === true, { polling: 200, timeout: 120_000 });
  for (const [index, archive] of archives.entries()) {
    const reply = await settings.evaluate(async (base64, index) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: `import-${index}`,
        blobUrl: URL.createObjectURL(new Blob([bytes])), fileName: `archive-${index}.zip` });
    }, archive.toString("base64"), index);
    if (!reply?.ok) throw new Error(`import ${index} failed: ${JSON.stringify(reply)}`);
  }
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      requestId: `options-${Date.now()}`, baseRevision: options?.revision ?? 0, options: patch });
    if (!reply?.ok) throw new Error(JSON.stringify(reply));
  }, patch);
  await writeOptions({ lookupMode: "hover", compactFrequencyNumbers: true, showLookupCounts: false,
    popupWidthPx: 420, popupHeightPx: 260, popupTheme: "light" });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 560, height: 380, deviceScaleFactor: 2 });
  await tab.goto(pageUrl, { waitUntil: "load" });
  for (const [name, patch] of sets) {
    await writeOptions(patch);
    await tab.bringToFront();
    await tab.mouse.move(5, 5);
    await new Promise(done => setTimeout(done, 300));
    const box = await (await tab.$("#word")).boundingBox();
    // Step off and back on, as the suites do: the reader builds its host lazily.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await tab.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
      await new Promise(done => setTimeout(done, 600));
      await tab.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    }
    await new Promise(done => setTimeout(done, 1500));
    await tab.screenshot({ path: resolve(out, `${label}-${name}.png`) });
    console.log(`${label}-${name}.png`);
  }
} finally {
  await browser.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
