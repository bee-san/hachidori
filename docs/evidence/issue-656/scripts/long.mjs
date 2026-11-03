// Probe for #656 (not committed to main): the search page header with long
// Template names at several widths; where each item lands and which wrap.
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = "/home/skerraut/herd-synth3/clones/hachi-issue-656";
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const EXTENSION = resolve(ROOT, "extension");
const OUT = process.env.OUT || "/tmp/hachi656-probe/long";
mkdirSync(OUT, { recursive: true });
const NAMES = (process.env.NAMES || "Lapis sentence cards with audio|Words").split("|");
const browser = await puppeteer.launch({
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: process.env.PROFILE_DIR || mkdtempSync(resolve(tmpdir(), "hachi656-long-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  await settings.evaluate(async (names) => {
    const { options } = await chrome.storage.local.get("options");
    const anki = globalThis.HDReaderOptions.normaliseOptions(options).anki;
    const next = globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
      templates: names.map((name, index) => ({ ...anki.templates[0], id: index === 0 ? anki.templates[0].id : `t${index}`, name })) });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { anki: next } });
    if (!reply.ok) throw new Error(reply.error);
  }, NAMES);
  for (const width of (process.env.WIDTHS || "600,520,420").split(",").map(Number)) {
    const search = await browser.newPage();
    await search.setViewport({ width, height: 400 });
    await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
    await search.waitForFunction(() => !document.getElementById("search-template").hidden, { polling: 100, timeout: 20000 });
    await new Promise(r => setTimeout(r, 300));
    const layout = await search.evaluate(() => {
      const line = element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      };
      const rect = element => { const r = element.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width), Math.round(r.height)]; };
      const h1 = document.querySelector(".search-shell-header h1");
      const select = document.getElementById("search-template");
      const label = document.querySelector(".search-shell-header .lookup-enable span");
      return { h1: [...rect(h1), line(h1)], select: rect(select), label: [...rect(label), line(label)] };
    });
    console.log(width, JSON.stringify(layout));
    await search.screenshot({ path: `${OUT}/header-${width}.png`, clip: { x: 0, y: 0, width, height: 80 } });
    await search.close();
  }
} finally {
  await browser.close();
}
