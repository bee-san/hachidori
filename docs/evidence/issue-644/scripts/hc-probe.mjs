// The search page under Chrome's own forced-colors switch (--force-high-contrast)
// rather than DevTools emulation, for one extension build. Not part of the repo.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, EXTENSION, OUT] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644hc-")),
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-high-contrast",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  for (const p of await browser.pages()) if (p.url().includes("startup.html")) await p.close();
  const fixture = readFileSync(join(REPO, "test/fixtures/hachidori-fixture.zip")).toString("base64");
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `hc-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(() => null);
      if (reply?.ok) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }, fixture);
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { popupTheme: "default", showLookupCounts: false } });
  });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 900, height: 700 });
  await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await sleep(500);
  const doc = tab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? tab.mainFrame();
  await doc.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  await doc.focus("#search-input");
  await doc.$eval("#search-input", box => { box.value = "食べる"; });
  await tab.keyboard.press("Enter");
  await doc.waitForFunction(() => document.querySelector("hachidori-host"), { timeout: 10000 });
  await sleep(1200);
  await doc.evaluate(() => document.getElementById("search-input").blur());
  await sleep(300);
  const read = frame => frame.evaluate(() => ({ forced: matchMedia("(forced-colors: active)").matches,
    body: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color }));
  console.log(JSON.stringify({ document: doc.url().split("/").pop(), top: await read(tab.mainFrame()), page: await read(doc) }));
  // Settings, an ordinary extension page, under the same switch.
  console.log(JSON.stringify({ settings: await read(settings.mainFrame()) }));
  await tab.screenshot({ path: OUT });
} finally {
  await browser.close();
}
