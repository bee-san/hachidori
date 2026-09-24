// Evidence for issue #334 ("Nazeka (JS) prototype"): screenshots of the REAL
// popup (content script + fixture dictionary) in the pinned Chrome for Testing,
// default theme vs the vendor/themes/nazeka prototype. Not part of the suite.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> node capture-nazeka-js.mjs
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const PROFILE = "/tmp/nazeka-js-profile";
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>nazeka evidence</title>
<style>body{font:32px/2 "Noto Sans CJK JP",serif;padding:56px 80px;background:#f4efe6;color:#222} span{display:inline-block}</style>
</head><body><p>朝ごはんを<span id="verb">食べたかった</span>。</p></body></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const report = { chrome: null, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version, shots: {} };
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  browser.on("targetcreated", async target => {
    if (!target.url().endsWith("offscreen.html") && target.type() !== "service_worker") return;
    try {
      const cdp = await target.createCDPSession();
      await cdp.send("Runtime.enable");
      cdp.on("Runtime.consoleAPICalled", e => console.error(`[${target.type()} ${e.type}] ${(e.args || []).map(a => a.value ?? a.description ?? "").join(" ")}`));
      cdp.on("Runtime.exceptionThrown", e => console.error(`[${target.type()} exception] ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`));
    } catch (error) { console.error(`[watch] ${error.message}`); }
  });

  // ---- import the fixture dictionary through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  // As in chrome-e2e.mjs: wait for the empty-library starter card, i.e. the engine's start-up mutation is over.
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  await (await settings.$("#import-file")).uploadFile(FIXTURE);
  report.importState = await settings.waitForFunction(() => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith("Finished 1 of 1 archive") ? text : false;
  }, { timeout: 120_000, polling: 500 }).then(h => h.jsonValue());
  report.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
  console.error(`[import detail] ${JSON.stringify(report.importDetail)}`);
  if (!report.importState.includes("1 imported")) throw new Error(`fixture import failed: ${report.importState}`);

  // Hover lookups without an activation key, so the capture mirrors a plain hover.
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100 });

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.on("console", message => console.error(`[tab console ${message.type()}] ${message.text()}`));
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  console.error(`[import] ${report.importState}`);
  await tab.setViewport({ width: 1000, height: 760, deviceScaleFactor: 2 });
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500)); // the host element is created lazily on the first lookup

  const popupState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      nazeka: !!popup.querySelector(".nazeka-head"),
      chromeHidden: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      background: getComputedStyle(popup).backgroundColor,
      headwordSize: getComputedStyle(popup.querySelector(".gsm-hoshidicts-expression") || popup).fontSize,
      headwordColor: getComputedStyle(popup.querySelector(".gsm-hoshidicts-expression") || popup).color,
      readingInline: popup.querySelector(".nazeka-reading")?.textContent ?? null,
      glossSize: getComputedStyle(popup.querySelector(".gsm-hoshidicts-glossary-content") || popup).fontSize,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 240),
    };
  });
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popupState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };
  const settle = () => tab.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 350)))));

  async function hoverVerb(expect) {
    const box = await (await tab.$("#verb")).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
      try { return await waitFor(expect, 1500); } catch (error) { console.error(`[hover attempt ${attempt}] ${error.message.slice(0, 400)}`); }
    }
    const debug = await tab.evaluate(() => {
      const host = document.querySelector("hachidori-host");
      return { host: !!host, shadow: !!host?.shadowRoot, children: host?.shadowRoot ? [...host.shadowRoot.children].map(c => `${c.tagName}.${c.className}#hidden=${c.hidden}`) : null };
    });
    throw new Error(`no popup after hovering 食べたかった: ${JSON.stringify(debug)}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 600));
  }
  async function clickKanji(character, expect) {
    const point = await tab.waitForFunction(character => {
      const host = document.querySelector("hachidori-host");
      const link = [...host.shadowRoot.querySelectorAll(".gsm-hoshidicts-kanji-link")].find(b => b.textContent === character);
      if (!link) return false;
      const rect = link.getBoundingClientRect();
      return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : false;
    }, { timeout: 10_000, polling: 100 }, character).then(handle => handle.jsonValue());
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
    return waitFor(expect);
  }
  async function shot(name, state) {
    await settle();
    const fresh = await popupState();
    const pad = 28;
    const clip = { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad),
      width: Math.min(1000, fresh.rect.width + pad * 2), height: Math.min(760, fresh.rect.height + pad * 2) };
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip });
    report.shots[name] = fresh;
    return fresh;
  }

  // ---- default theme ----
  await hoverVerb(s => s.term > 0);
  await shot("default-term");
  await clickKanji("食", s => s.kanji > 0);
  await shot("default-kanji");
  await closePopup();

  // ---- nazeka (JS) theme ----
  await writeOptions({ popupTheme: "nazeka" });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "nazeka", { timeout: 15_000 });
  await hoverVerb(s => s.term > 0 && s.nazeka);
  await shot("nazeka-term");
  await clickKanji("食", s => s.kanji > 0 && s.nazeka);
  await shot("nazeka-kanji");
  // Back returns to the term view and the hook runs again on the re-render.
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back").click());
  report.shots["nazeka-back"] = await waitFor(s => s.term > 0 && s.nazeka);
  await closePopup();
} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
