// Search page timings for one extension build (the search history PR): how
// long a new search page takes to accept a search, how long a search takes
// from Enter to its result in the popup's DOM, and on a build with the history
// how long the line takes to be kept (Enter to the "line" event), an Up in the
// box (to the recalled line), a Right in the searched text (to the next word's
// result) and an Up past its top row (to the earlier line, then its result),
// with `PREFILL` lines kept beforehand. Custom JavaScript is saved as a
// comment with user scripts off, so the popup's root is open on both builds.
// Prints one JSON line. Not part of the repo.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, EXTENSION, ROUNDS = "3", PREFILL = "0"] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WORDS = [["食べたかった", "to eat"], ["漢字", "Chinese character"], ["読む", "to read"],
  ["ありがとう", "thank you"], ["食べる", "to eat"]];
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hshbench-")),
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
  // Lines kept before the measured searches, written straight into the history's database.
  if (Number(PREFILL) > 0) {
    await settings.evaluate(count => new Promise((resolve, reject) => {
      const opening = indexedDB.open("hachidori-search-history", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("lines", { keyPath: "id", autoIncrement: true });
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const transaction = opening.result.transaction("lines", "readwrite");
        const lines = transaction.objectStore("lines");
        for (let index = 0; index < count; index += 1) {
          lines.add({ text: `昨日は友達と一緒に駅前の喫茶店へ行った。${index}`, at: Date.now(), source: "clipboard", page: "tab" });
        }
        transaction.oncomplete = () => { opening.result.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    }), Number(PREFILL));
  }
  await sleep(300);
  const ready = [], searches = [], kept = [], walk = [], word = [], visit = [], visitShown = [];
  for (let round = 0; round < Number(ROUNDS); round += 1) {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 900, height: 700 });
    const opened = Date.now();
    await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
    let doc = null;
    for (let i = 0; i < 2000 && !doc; i += 1) {
      doc = tab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? null;
      if (!doc) await sleep(2);
    }
    await doc.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 2, timeout: 20000 });
    ready.push(Date.now() - opened);
    const history = await doc.evaluate(() => Boolean(globalThis.HDSearchHistory));
    for (const [text, gloss] of WORDS) {
      const result = await doc.evaluate((text, gloss, history) => new Promise((resolve) => {
        const box = document.getElementById("search-input");
        box.value = text;
        const shown = () => {
          const popup = document.querySelector("hachidori-host")?.shadowRoot
            ?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
          return Boolean(popup && !popup.hidden && popup.textContent.includes(gloss));
        };
        const times = { search: null, kept: history ? null : 0 };
        const done = () => { if (times.search !== null && times.kept !== null) resolve(times); };
        const started = performance.now();
        if (history) {
          const onLine = () => { times.kept = performance.now() - started; globalThis.HDSearchHistory.removeEventListener("line", onLine); done(); };
          globalThis.HDSearchHistory.addEventListener("line", onLine);
        }
        const watched = new Set();
        const observer = new MutationObserver(() => {
          const root = document.querySelector("hachidori-host")?.shadowRoot;
          if (root && !watched.has(root)) {
            watched.add(root);
            observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
          }
          if (!shown() || times.search !== null) return;
          times.search = performance.now() - started;
          observer.disconnect();
          done();
        });
        const root = document.querySelector("hachidori-host")?.shadowRoot;
        if (root) {
          watched.add(root);
          observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
        }
        observer.observe(document.body, { childList: true, subtree: true });
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        setTimeout(() => { observer.disconnect(); resolve(times); }, 10000);
      }), text, gloss, history);
      searches.push(result.search);
      if (history) kept.push(result.kept);
      await sleep(50);
    }
    if (history) {
      // Up in the box: the line before the draft.
      walk.push(await doc.evaluate(() => new Promise((resolve) => {
        const box = document.getElementById("search-input");
        box.focus();
        box.value = "下書き";
        box.setSelectionRange(3, 3);
        const started = performance.now();
        const poll = () => (box.value !== "下書き" ? resolve(performance.now() - started) : requestAnimationFrame(poll));
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", bubbles: true, cancelable: true }));
        poll();
      })));
      // A line of three words; Right to the second word's result; Up to the earlier line, then its result.
      await doc.evaluate(() => new Promise((resolve) => {
        const box = document.getElementById("search-input");
        box.value = "漢字読むありがとう";
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        const poll = () => {
          const [cursor] = CSS.highlights.get("hd-search-cursor") ?? [];
          if (cursor?.toString() === "漢字") resolve(); else requestAnimationFrame(poll);
        };
        poll();
      }));
      const timed = (key, gloss, until) => doc.evaluate((key, gloss, until) => new Promise((resolve) => {
        const query = document.getElementById("search-query");
        const shown = () => document.querySelector("hachidori-host")?.shadowRoot
          ?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]')?.textContent.includes(gloss);
        const started = performance.now();
        let step = null;
        const poll = () => {
          if (step === null && (until === null || query.textContent === until)) step = performance.now() - started;
          if (step !== null && shown()) resolve({ step, shown: performance.now() - started });
          else requestAnimationFrame(poll);
        };
        query.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
        poll();
      }), key, gloss, until);
      word.push((await timed("ArrowRight", "to read", null)).shown);
      const earlier = await timed("ArrowUp", "to eat", "食べる");
      visit.push(earlier.step);
      visitShown.push(earlier.shown);
    }
    await tab.close();
  }
  console.log(JSON.stringify({ ready, searches, kept, walk, word, visit, visitShown }));
} finally {
  await browser.close();
}
