// The independent audit's probe harness for the search history PR (2026-11-04),
// as it wrote it but for PROBE_ROOT being required: the PR head's extension in
// a real Chrome, with the fixture dictionary, as test/chrome-search-history.mjs
// sets it up.
// Usage: import { start } from "./probe-harness.mjs"; const h = await start({ ... });
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const ROOT = process.env.PROBE_ROOT;
if (!ROOT) throw new Error("set PROBE_ROOT to a hachidori checkout");
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { computeExecutablePath, Browser } = await import(require.resolve("@puppeteer/browsers"));
const { buildFixtureZip } = await import(resolve(ROOT, "test/make-fixture.mjs"));
const { popupReader } = await import(resolve(ROOT, "test/chrome-e2e/popup-reader.mjs"));
export const TEXTHOOKER = existsSync(resolve(ROOT, "userscripts/texthooker.js"))
  ? readFileSync(resolve(ROOT, "userscripts/texthooker.js"), "utf8") : "";
export const settle = ms => new Promise(done => { setTimeout(done, ms); });

export async function start({ name = "probe", chromeBuild = "152.0.7977.75", args = [], headless = true,
  clipboard = true } = {}) {
  const extension = resolve(tmpdir(), `audit-hsh-${name}-ext-${process.pid}`);
  const profile = resolve(tmpdir(), `audit-hsh-${name}-profile-${process.pid}`);
  rmSync(extension, { recursive: true, force: true });
  cpSync(resolve(ROOT, "extension"), extension, { recursive: true });
  if (clipboard) {
    const manifestPath = resolve(extension, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.optional_permissions;
    manifest.permissions.push("clipboardRead");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME,
      buildId: chromeBuild }),
    enableExtensions: true, headless, userDataDir: profile, protocolTimeout: 600_000,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...args],
  });
  const log = [];
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"), { timeout: 60_000 });
  const id = new URL(worker.url()).host;
  const frameUrl = `chrome-extension://${id}/search-frame.html`;
  const watch = (page, label) => {
    page.on("console", message => log.push(`[${label}] ${message.type()}: ${message.text()}`));
    page.on("pageerror", error => log.push(`[${label}] pageerror: ${error.message}`));
    page.on("dialog", dialog => { void dialog.accept(); });
    return page;
  };
  const settings = watch(await browser.newPage(), "settings");
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const imported = await settings.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try {
      return await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: "probe-fixture", blobUrl, fileName: "hachidori-fixture.zip" });
    } finally { URL.revokeObjectURL(blobUrl); }
  }, buildFixtureZip().toString("base64"));
  if (!(imported?.ok === true && imported.report?.success === true)) throw new Error(JSON.stringify(imported));
  const writeOptions = (patch, page = settings) => page.evaluate(async (value) => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: value });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  async function openSearch(label, { width = 960, height = 760 } = {}) {
    const tab = watch(await browser.newPage(), label);
    await tab.setViewport({ width, height });
    await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
    await tab.waitForFrame(frameUrl, { timeout: 60_000 });
    const frame = tab.frames().find(candidate => candidate.url() === frameUrl);
    await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 60_000 });
    return { tab, frame, popup: await popupReader(tab, 0, frameUrl) };
  }
  // Raw IndexedDB seeding in an extension page: `count` lines "line N" in one transaction.
  const seed = (count, page = settings, prefix = "行") => page.evaluate(async (total, label) => {
    const db = await new Promise((done, fail) => {
      const opening = indexedDB.open("hachidori-search-history", 1);
      opening.onupgradeneeded = () => { opening.result.createObjectStore("lines", { keyPath: "id", autoIncrement: true }); };
      opening.onsuccess = () => done(opening.result);
      opening.onerror = () => fail(opening.error);
    });
    const started = performance.now();
    await new Promise((done, fail) => {
      const transaction = db.transaction("lines", "readwrite");
      const lines = transaction.objectStore("lines");
      const now = Date.now();
      for (let index = 0; index < total; index += 1) {
        lines.add({ text: `${label}${index}番目の文章です。`, at: now - total + index, source: "clipboard", page: "tab" });
      }
      transaction.oncomplete = done;
      transaction.onerror = () => fail(transaction.error);
    });
    db.close();
    return performance.now() - started;
  }, count, prefix);
  const view = frame => frame.evaluate(() => {
    const text = id => document.getElementById(id);
    const [cursor] = CSS.highlights.get("hd-search-cursor") ?? [];
    return {
      value: text("search-input").value, focused: document.activeElement?.id || document.activeElement?.localName,
      caret: [text("search-input").selectionStart, text("search-input").selectionEnd],
      query: text("search-query").hidden ? null : text("search-query").textContent,
      before: text("search-before").hidden ? null : text("search-before").dataset.text,
      after: text("search-after").hidden ? null : text("search-after").dataset.text,
      where: text("search-where").hidden ? null : text("search-where").textContent,
      cursor: cursor ? { at: cursor.startOffset, text: cursor.toString() } : null,
    };
  });
  return { browser, id, frameUrl, settings, writeOptions, openSearch, seed, view, watch, log,
    async close() {
      await browser.close();
      rmSync(profile, { recursive: true, force: true });
      rmSync(extension, { recursive: true, force: true });
    } };
}
