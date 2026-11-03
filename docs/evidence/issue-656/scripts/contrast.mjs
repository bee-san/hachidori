// Evidence for #656 (not committed to main): the Anki Template switch's text
// and border contrast in each palette the PR shows, from computed styles.
import assert from "node:assert/strict";
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
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-contrast-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const write = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const anki = await settings.evaluate(async () => {
    const anki = globalThis.HDReaderOptions.normaliseOptions((await chrome.storage.local.get("options")).options).anki;
    return globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
      templates: [{ ...anki.templates[0], name: "Lapis sentences" }, { ...anki.templates[0], id: "words", name: "Words" }] });
  });
  await write({ anki });
  const search = await browser.newPage();
  await search.setViewport({ width: 600, height: 640 });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  await search.waitForFunction(() => !document.getElementById("search-template").hidden, { polling: 100, timeout: 20000 });
  for (const theme of ["default", "girlypop", "dracula", "high-contrast"]) {
    await write({ popupTheme: theme });
    await search.waitForFunction(t => document.documentElement.dataset.hoshidictsTheme === t, { polling: 100, timeout: 10000 }, theme);
    await new Promise(r => setTimeout(r, 300));
    const measured = await search.evaluate(() => {
      // Any CSS colour, as the 8-bit sRGB a canvas paints it with.
      const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      const parse = (value) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const luminance = ([r, g, b]) => [r, g, b].map(v => v / 255)
        .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0);
      const ratio = (a, b) => { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
      const select = getComputedStyle(document.getElementById("search-template"));
      const page = getComputedStyle(document.body).backgroundColor;
      const pageColour = parse(page)[3] !== 0 ? parse(page) : parse(getComputedStyle(document.documentElement).backgroundColor);
      return { text: ratio(parse(select.color), parse(select.backgroundColor)).toFixed(2),
        border: ratio(parse(select.borderTopColor), pageColour).toFixed(2),
        colours: [select.color, select.backgroundColor, select.borderTopColor, page] };
    });
    console.log(theme, JSON.stringify(measured));
  }
} finally {
  await browser.close();
}
