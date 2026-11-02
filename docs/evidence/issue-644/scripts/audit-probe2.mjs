// Parity audit probe, part 2: behaviours on a web page popup and on the
// search page's docked result. Not part of the repo.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.argv[2];
const OUT = process.argv[3] ?? "/tmp/hachi644/audit2";
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const EXTENSION = process.env.PROBE_EXTENSION ?? join(REPO, "extension");
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>reading</title></head>
<body style="font-size:24px;padding:40px"><p id="verb">食べたかった</p><p id="kanji">漢字</p></body></html>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644b-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
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
        requestId: `audit-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(() => null);
      if (reply?.ok) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }, fixture);
  const writeOptions = patch => settings.evaluate(async patch => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: patch });
      if (reply.ok) return;
    }
    throw new Error("options write failed");
  }, patch);
  // An open root lets the probe read the popup from page script.
  await writeOptions({ hoverEnabled: true, lookupMode: "hover", customPopupJavascript: "/* open */", popupOpacityPercent: 100 });
  await sleep(500);

  const state = target => target.evaluate(() => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    const popups = [...(root?.querySelectorAll(".gsm-hoshidicts-popup") ?? [])].filter(p => !p.hidden);
    const root0 = popups.find(p => p.dataset.hoshidictsDepth === "0");
    const active = root?.activeElement;
    const entries = root0 ? [...root0.querySelectorAll(".gsm-hoshidicts-entry, .gsm-hoshidicts-kanji-entry")] : [];
    const focusedEntry = entries.findIndex(e => e === active || e.contains(active) || e.matches(":focus-within") || e.classList.contains("gsm-hoshidicts-entry-current") || e.dataset.current === "true");
    return {
      open: popups.length, depths: popups.map(p => p.dataset.hoshidictsDepth),
      kanji: Boolean(root0?.querySelector(".gsm-hoshidicts-kanji-entry")), back: Boolean(root0?.querySelector(".gsm-hoshidicts-kanji-back")),
      entries: entries.length, focusedEntry, activeClass: active?.className ?? null,
      scrollTop: root0?.querySelector(".gsm-hoshidicts-content-scroll")?.scrollTop ?? null,
      audio: [...(root0?.querySelectorAll(".gsm-hoshidicts-audio-button") ?? [])].map(b => [b.getAttribute("aria-pressed"), b.dataset.state ?? b.className]).slice(0, 2),
      highlights: CSS.highlights ? [...CSS.highlights.keys()].map(k => [k, CSS.highlights.get(k).size]) : null,
      text: root0?.textContent.slice(0, 80) ?? null,
    };
  });

  const web = await browser.newPage();
  await web.setViewport({ width: 960, height: 760 });
  await web.goto(pageUrl, { waitUntil: "load" });
  await sleep(800);
  const hoverWeb = async (selector, index = 0) => {
    await web.bringToFront();
    const point = await web.evaluate((sel, index) => {
      const node = document.querySelector(sel).firstChild;
      const range = document.createRange();
      range.setStart(node, index); range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, selector, index);
    await web.mouse.move(point.x - 2, point.y);
    await web.mouse.move(point.x, point.y, { steps: 3 });
    for (let i = 0; i < 60; i += 1) { const s = await state(web); if (s.open) return s; await sleep(100); }
    return state(web);
  };
  const searchTab = await browser.newPage();
  await searchTab.setViewport({ width: 700, height: 420 });
  await searchTab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await sleep(500);
  const frameOf = () => searchTab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? searchTab.mainFrame();
  const search = new Proxy({}, { get: (_, key) => {
    if (["screenshot", "bringToFront", "keyboard", "mouse", "url", "setViewport"].includes(key)) return typeof searchTab[key] === "function" ? searchTab[key].bind(searchTab) : searchTab[key];
    const frame = frameOf();
    return typeof frame[key] === "function" ? frame[key].bind(frame) : frame[key];
  } });
  await search.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  const searchFor = async text => {
    await search.bringToFront();
    await search.focus("#search-input");
    await search.$eval("#search-input", (box, value) => { box.value = value; }, text);
    await search.keyboard.press("Enter");
    for (let i = 0; i < 60; i += 1) { const s = await state(search); if (s.open && s.entries) return s; await sleep(100); }
    return state(search);
  };
  const press = async (target, key, modifiers = []) => {
    for (const m of modifiers) await target.keyboard.down(m);
    await target.keyboard.press(key);
    for (const m of modifiers.reverse()) await target.keyboard.up(m);
    await sleep(400);
    return state(target);
  };
  // Move the pointer into the popup, onto its header, so a web popup stays.
  const intoPopup = async target => {
    const point = await target.evaluate(() => {
      const popup = document.querySelector("hachidori-host").shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
      const r = popup.getBoundingClientRect();
      return { x: r.left + r.width - 30, y: r.top + r.height - 30 };
    });
    await target.mouse.move(point.x, point.y, { steps: 4 });
    await sleep(200);
  };
  const clickInPopup = async (target, selector) => {
    const point = await target.evaluate(sel => {
      const popup = document.querySelector("hachidori-host").shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
      const element = popup.querySelector(sel);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2 };
    }, selector);
    if (!point) return false;
    await target.mouse.move(point.x, point.y, { steps: 4 });
    await target.mouse.click(point.x, point.y);
    await sleep(600);
    return true;
  };

  const report = {};
  for (const [name, target, open] of [["web", web, () => hoverWeb("#verb")], ["search", search, () => searchFor("食べたかった")]]) {
    const r = {};
    r.opened = (await open()).entries;
    if (name === "web") await intoPopup(web);
    r.altDown = (await press(target, "ArrowDown", ["Alt"])).scrollTop;
    r.altUp = (await press(target, "ArrowUp", ["Alt"])).scrollTop;
    r.kanjiClicked = await clickInPopup(target, ".gsm-hoshidicts-expression ruby, .gsm-hoshidicts-expression");
    r.kanji = (await state(target)).kanji;
    r.historyBack = (await press(target, "KeyB", ["Alt"])).kanji;
    r.historyForward = (await press(target, "KeyF", ["Alt"])).kanji;
    r.backButton = await clickInPopup(target, ".gsm-hoshidicts-kanji-back");
    r.afterBack = (await state(target)).kanji;
    const tabId = await settings.evaluate(async url => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
      if (contexts[0]) return contexts[0].tabId;
      const [tab] = await chrome.tabs.query({ url });
      return tab?.id ?? null;
    }, name === "web" ? pageUrl : `chrome-extension://${id}/search.html`);
    await target.bringToFront();
    const before = (await state(target)).scrollTop;
    r.commandDelivery = await settings.evaluate(async (tabId) => {
      try { return JSON.stringify(await chrome.tabs.sendMessage(tabId, { target: "hachidori-reader", type: "hd_reader_command", action: "nextEntry" })) ?? "undefined"; }
      catch (error) { return `ERROR ${error.message}`; }
    }, tabId);
    await sleep(500);
    r.commandScroll = [before, (await state(target)).scrollTop];
    report[name] = r;
  }
  log(JSON.stringify(report, null, 1));
} finally {
  await browser.close();
  server.close();
}
