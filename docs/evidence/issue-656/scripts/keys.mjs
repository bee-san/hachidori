// Local preview for #656 (not committed): the Template switch's keyboard and pointer paths.
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
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: process.env.BUILD || "152.0.7977.75" }),
  enableExtensions: true, headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), "hachi656-keys-")),
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
    const first = anki.templates[0];
    const next = globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
      templates: [{ ...first, name: "Sentences" }, { ...first, id: "words", name: "Words" }, { ...first, id: "kanji", name: "Kanji" }] });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { anki: next } });
    if (!reply.ok) throw new Error(reply.error);
  });
  const stored = () => settings.evaluate(async () => (await chrome.storage.local.get("options")).options.anki.templates.map(t => t.id));
  const search = await browser.newPage();
  await search.setViewport({ width: 600, height: 640 });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  const frameUrl = `chrome-extension://${id}/search-frame.html`;
  await search.waitForFrame(frameUrl, { timeout: 30000 });
  const frame = search.frames().find(f => f.url() === frameUrl);
  await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 30000 });
  await search.waitForFunction(() => !document.getElementById("search-template").hidden, { polling: 100, timeout: 10000 });
  const state = async () => ({ ...await search.evaluate(() => ({ value: document.getElementById("search-template").value,
    active: document.activeElement?.id || document.activeElement?.localName })), copy: await frame.$eval("select.search-template", s => s.value),
    frameFocus: await frame.evaluate(() => document.hasFocus() && document.activeElement?.id), stored: await stored() });
  console.log("start", JSON.stringify(await state()));
  await search.focus("#search-template");
  await search.keyboard.press("ArrowDown");
  await new Promise(r => setTimeout(r, 700));
  console.log("ArrowDown", JSON.stringify(await state()));
  await search.keyboard.press("ArrowUp");
  await new Promise(r => setTimeout(r, 300));
  await search.keyboard.press("ArrowUp");
  await new Promise(r => setTimeout(r, 700));
  console.log("ArrowUp x2", JSON.stringify(await state()));
  // Pointer: from the box, click the menu, then choose.
  await frame.focus("#search-input");
  await search.click("#search-template");
  await new Promise(r => setTimeout(r, 300));
  console.log("after click", JSON.stringify(await state()));
  await search.select("#search-template", "words");
  await new Promise(r => setTimeout(r, 700));
  console.log("pointer choice", JSON.stringify(await state()));
  await search.keyboard.press("Escape");
  await new Promise(r => setTimeout(r, 300));
  console.log("after Escape", JSON.stringify(await state()));
} finally {
  await browser.close();
}
