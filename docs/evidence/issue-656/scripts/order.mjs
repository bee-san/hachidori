// Probe for #656 (not committed to main): in search-frame.html, is the
// invisible Template copy laid out before the frame tells search.html it is
// shown? Logs both moments, in the frame's own clock, over several loads.
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
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-order-")),
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
    const next = globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
      templates: [anki.templates[0], { ...anki.templates[0], id: "words", name: "Words" }] });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { anki: next } });
    if (!reply.ok) throw new Error(reply.error);
  });
  const results = [];
  for (let run = 0; run < 8; run += 1) {
    const search = await browser.newPage();
    await search.evaluateOnNewDocument(() => {
      if (!location.href.endsWith("/search-frame.html")) return;
      globalThis.__order = [];
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (data, ...rest) {
        if (data?.kind === "shown") globalThis.__order.push(["shown", performance.now()]);
        return post.call(this, data, ...rest);
      };
      document.addEventListener("DOMContentLoaded", () => {
        const select = document.querySelector("select.search-template");
        new MutationObserver(() => {
          if (!select.hidden) globalThis.__order.push(["copy", performance.now()]);
        }).observe(select, { attributes: true, attributeFilter: ["hidden"] });
      });
    });
    await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
    const frameUrl = `chrome-extension://${id}/search-frame.html`;
    await search.waitForFrame(frameUrl, { timeout: 30000 });
    const frame = search.frames().find(f => f.url() === frameUrl);
    await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 30000 });
    results.push(await frame.evaluate(() => globalThis.__order.map(([what, at]) => `${what}@${at.toFixed(1)}`).join(" ")));
    await search.close();
  }
  console.log(results.join("\n"));
} finally {
  await browser.close();
}
