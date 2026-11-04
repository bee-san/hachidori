// Probe for #656 (not committed to main): the "read held" scenario of
// test/chrome-settings-first-frame.mjs, timed. Settings opens with every
// storage read parked; after a release, how long until its first paint and
// until the saved theme is set? Run against one extension directory.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = "/home/skerraut/herd-synth3/clones/hachi-issue-656";
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const EXTENSION = process.env.EXT;
const RUNS = Number(process.env.RUNS || 5);
const browser = await puppeteer.launch({
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-paint-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const url = `chrome-extension://${id}/settings.html`;
  const helper = await browser.newPage();
  await helper.goto(url, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  await helper.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { popupTheme: "light" } });
  });
  const results = [];
  for (let run = 0; run < RUNS; run += 1) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 700 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.evaluateOnNewDocument(() => {
      if (window !== window.top) return;
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      const released = new Promise(resolve => { globalThis.releaseThemeStorage = () => { globalThis.releasedAt = performance.now(); resolve(); }; });
      chrome.storage.local.get = async (...args) => { await released; return get(...args); };
      globalThis.themeSetAt = null;
      new MutationObserver(() => {
        if (globalThis.themeSetAt === null && document.documentElement?.hasAttribute("data-hoshidicts-theme")) globalThis.themeSetAt = performance.now();
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-hoshidicts-theme"] });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 150));
    await page.evaluate(() => globalThis.releaseThemeStorage());
    await page.waitForFunction(() => performance.getEntriesByName("first-paint").length > 0, { polling: 10, timeout: 10000 }).catch(() => {});
    results.push(await page.evaluate(() => ({
      paint: Math.round((performance.getEntriesByName("first-paint")[0]?.startTime ?? NaN) - globalThis.releasedAt),
      theme: Math.round((globalThis.themeSetAt ?? NaN) - globalThis.releasedAt),
    })));
    await page.close();
  }
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
