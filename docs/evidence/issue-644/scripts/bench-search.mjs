// Search page timings for one extension build, for #644: how long a new
// search page takes to accept a search, and how long a search takes from Enter
// to its result in the popup's DOM. Custom JavaScript is saved as a comment
// with user scripts left off, so the popup's root is open on both builds and
// nothing runs. Prints one JSON line. Not part of the repo.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, EXTENSION, ROUNDS = "5"] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Each word's result, told from the one before it by a gloss of its own.
const WORDS = [["食べたかった", "to eat"], ["漢字", "Chinese characters"], ["読む", "to read"],
  ["ありがとう", "thank you"], ["食べる", "to eat"]];
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644bench-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
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
        requestId: `b-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(() => null);
      if (reply?.ok) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }, fixture);
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { showLookupCounts: false, customPopupJavascript: "/* open root */" } });
  });
  await sleep(300);
  const ready = [], searches = [];
  for (let round = 0; round < Number(ROUNDS); round += 1) {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 900, height: 700 });
    const opened = Date.now();
    await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
    // This PR's page is search.html's frame; main's is search.html itself.
    let doc = null;
    for (let i = 0; i < 2000 && !doc; i += 1) {
      doc = tab.frames().find(f => f.url().endsWith("/search-frame.html"))
        ?? (await tab.mainFrame().evaluate(() => document.getElementById("search-submit") !== null).catch(() => false) ? tab.mainFrame() : null);
      if (!doc) await sleep(2);
    }
    await doc.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 2, timeout: 20000 });
    ready.push(Date.now() - opened);
    for (const [word, gloss] of WORDS) {
      searches.push(await doc.evaluate((word, gloss) => new Promise((resolve) => {
        const box = document.getElementById("search-input");
        box.value = word;
        const shown = () => {
          const popup = document.querySelector("hachidori-host")?.shadowRoot
            ?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
          return Boolean(popup && !popup.hidden && popup.textContent.includes(gloss));
        };
        const started = performance.now();
        const watched = new Set();
        const observer = new MutationObserver(() => {
          const root = document.querySelector("hachidori-host")?.shadowRoot;
          if (root && !watched.has(root)) {
            watched.add(root);
            observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
          }
          if (!shown()) return;
          observer.disconnect();
          resolve(performance.now() - started);
        });
        const root = document.querySelector("hachidori-host")?.shadowRoot;
        if (root) {
          watched.add(root);
          observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
        }
        // The first search builds the host; the document shows when it does.
        observer.observe(document.body, { childList: true, subtree: true });
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        setTimeout(() => { observer.disconnect(); resolve(null); }, 10000);
      }), word, gloss));
    }
    await tab.close();
  }
  console.log(JSON.stringify({ ready, searches }));
} finally {
  await browser.close();
}
