// Probe for #656 (not committed to main): the Template switch retries a
// write that met a conflict, keeps the other page's write, and goes back to
// the stored Template when a write fails.
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
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-conflict-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const settle = ms => new Promise(r => setTimeout(r, ms));
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const anki = globalThis.HDReaderOptions.normaliseOptions(options).anki;
    const next = globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: "secret",
      templates: [{ ...anki.templates[0], name: "Sentences" }, { ...anki.templates[0], id: "words", name: "Words" }] });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { anki: next } });
    if (!reply.ok) throw new Error(reply.error);
  });
  const stored = () => settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    return { order: options.anki.templates.map(t => t.id), apiKey: options.anki.apiKey, autoplay: options.audioAutoplay ?? false,
      revision: options.revision };
  });
  const search = await browser.newPage();
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  await search.waitForFunction(() => !document.getElementById("search-template").hidden, { polling: 100, timeout: 20000 });
  // Another page writes between the switch's read and its write: the first
  // write the switch sends goes out after an unrelated write of its own.
  await search.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.writes = [];
    let first = true;
    chrome.runtime.sendMessage = async (message, ...rest) => {
      if (message?.type === "hd_options_write" && first) {
        first = false;
        const { options } = await chrome.storage.local.get("options");
        await send({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
          options: { audioAutoplay: true } });
      }
      const reply = await send(message, ...rest);
      if (message?.type === "hd_options_write") globalThis.writes.push({ ok: reply?.ok, conflict: reply?.conflict ?? false });
      return reply;
    };
  });
  const before = await stored();
  await search.select("#search-template", "words");
  await settle(1000);
  const afterConflict = { ...await stored(), writes: await search.evaluate(() => globalThis.writes),
    shown: await search.$eval("#search-template", s => s.value) };
  // A write that fails goes back to the stored Template.
  await search.evaluate(() => {
    chrome.runtime.sendMessage = async () => ({ ok: false, error: "the worker went away" });
  });
  await search.select("#search-template", "default");
  await settle(800);
  const afterFailure = { ...await stored(), shown: await search.$eval("#search-template", s => s.value) };
  console.log(JSON.stringify({ before, afterConflict, afterFailure }, null, 1));
} finally {
  await browser.close();
}
