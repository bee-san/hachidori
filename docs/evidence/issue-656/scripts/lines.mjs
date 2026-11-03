// Quick check (not committed): the lines of the frame header's title and
// Clipboard monitor label at 600 px with a long Template name, as the e2e
// step counts them.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = "/home/skerraut/herd-synth3/clones/hachi-issue-656";
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const EXTENSION = resolve(ROOT, "extension");
const browser = await puppeteer.launch({
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: process.env.BUILD || "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-lines-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const anki = globalThis.HDReaderOptions.normaliseOptions(options).anki;
    const next = globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey, templates: [
      { ...anki.templates[0], name: "Sentences with audio and a picture" }, { ...anki.templates[0], id: "words", name: "Words" },
      { ...anki.templates[0], id: "kanji", name: "Kanji" }] });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { anki: next } });
    if (!reply.ok) throw new Error(reply.error);
  });
  const search = await browser.newPage();
  await search.setViewport({ width: 600, height: 640 });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  const frameUrl = `chrome-extension://${id}/search-frame.html`;
  await search.waitForFrame(frameUrl, { timeout: 30000 });
  const frame = search.frames().find(f => f.url() === frameUrl);
  await frame.waitForFunction(() => !document.querySelector("select.search-template").hidden, { polling: 100, timeout: 20000 });
  console.log(JSON.stringify(await frame.evaluate(() => {
    const lines = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
    };
    return [lines(document.querySelector(".search-header h1")), lines(document.querySelector(".search-header .lookup-enable span"))];
  })));
} finally {
  await browser.close();
}
