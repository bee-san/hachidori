// Evidence for issue #334 ("omikuji-shrine" theme proposal): screenshots of the
// REAL popup (content script + real Yomitan dictionaries) in the pinned Chrome
// for Testing, default theme vs vendor/themes/omikuji-shrine. Not part of the suite.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> DICTS=<dir with the three zips> \
//     node capture-omikuji-shrine.mjs
//
// Dictionaries (downloaded to DICTS, never committed): jitendex-yomitan.zip
// (terms), jiten-frequency.zip (rank-based frequency), KANJIDIC_english.zip (kanji).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const DICTS = process.env.DICTS;
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const ARCHIVES = ["jitendex-yomitan.zip", "jiten-frequency.zip", "KANJIDIC_english.zip"].map(name => resolve(DICTS, name));
const PROFILE = `/tmp/omikuji-shrine-profile-${process.pid}`;
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

// A visual-novel-like reading page: night sky, a text box, the sentence that
// hovers each target word. Everything drawn with CSS; no assets.
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>omikuji evidence</title>
<style>
  html,body{margin:0;height:100%}
  body{min-height:100%;background:
    radial-gradient(ellipse at 70% 12%, rgba(255,214,150,.18), transparent 28%),
    radial-gradient(circle at 18% 30%, rgba(255,255,255,.08) 0 1px, transparent 2px),
    radial-gradient(circle at 42% 18%, rgba(255,255,255,.1) 0 1px, transparent 2px),
    radial-gradient(circle at 83% 40%, rgba(255,255,255,.08) 0 1px, transparent 2px),
    linear-gradient(180deg,#0b1024 0%,#1a2140 55%,#2b2a3a 100%);color:#f2ecdf;
    font:26px/1.9 "Noto Serif CJK JP","Noto Serif JP",serif}
  .box{position:absolute;left:40px;right:40px;top:36px;padding:22px 34px;border:1px solid rgba(255,235,200,.35);
    border-radius:8px;background:rgba(10,12,28,.78);box-shadow:0 12px 40px rgba(0,0,0,.5)}
  .name{color:#f0c97a;font-size:16px;letter-spacing:.2em;margin-bottom:4px}
  p{margin:0}
  span{display:inline-block}
</style></head><body>
<div class="box"><div class="name">巫女</div>
<p>朝ごはんを<span id="w-taberu">食べたかった</span>けれど、先に<span id="w-jinja">神社</span>へ<span id="w-sanpai">参拝</span>することにした。<span id="w-torii">鳥居</span>をくぐり、<span id="w-saisen">賽銭</span>を投げて、巫女さんから<span id="w-mikuji">御籤</span>を引く。</p>
<p>電話を<span id="w-kakeru">掛ける</span>前に、結果を見る。<span id="w-daikichi">大吉</span>。<span id="w-unmei">運命</span>というものを、少しだけ信じてみたくなった。</p>
</div></body></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const report = { chrome: null, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  shots: {}, hookOver8ms: [], consoleWarnings: [] };
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
      cdp.on("Runtime.exceptionThrown", e => console.error(`[${target.type()} exception] ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`));
    } catch (error) { console.error(`[watch] ${error.message}`); }
  });

  // ---- import the three dictionaries through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  const importStarted = Date.now();
  await (await settings.$("#import-file")).uploadFile(...ARCHIVES);
  report.importState = await settings.waitForFunction(() => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith("Finished 3 of 3 archives") ? text : false;
  }, { timeout: 600_000, polling: 500 }).then(h => h.jsonValue());
  report.importSeconds = (Date.now() - importStarted) / 1000;
  report.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
  console.error(`[import] ${report.importState} in ${report.importSeconds}s`);
  for (const line of report.importDetail) console.error(`[import detail] ${line}`);
  if (!report.importState.includes("3 imported")) throw new Error(`import failed: ${report.importState}`);

  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  // Plain hover opens the popup; one custom link button stands in for the kind
  // of extra tool a learner adds (it becomes an ema plaque like the others).
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100,
    customButtons: [{ id: "jisho", type: "link", label: "Jisho", url: "https://jisho.org/search/{term}" }] });

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.on("console", message => {
    const text = message.text();
    if (/onRender took/u.test(text)) report.hookOver8ms.push(text);
    if (message.type() === "warning" || message.type() === "error") report.consoleWarnings.push(text);
    console.error(`[tab console ${message.type()}] ${text}`);
  });
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  await tab.setViewport({ width: 1000, height: 940, deviceScaleFactor: 2 });
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));
  const cdp = await tab.createCDPSession();
  await cdp.send("Animation.enable");

  const popupState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const style = node => node ? getComputedStyle(node) : null;
    const grade = popup.querySelector(".omikuji-grade");
    const expression = popup.querySelector(".gsm-hoshidicts-expression");
    const gloss = popup.querySelector(".gsm-hoshidicts-glossary-content");
    const content = popup.querySelector(":scope > .gsm-hoshidicts-content-scroll");
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      fortunes: popup.querySelectorAll(":scope > .omikuji-fortune").length,
      grade: grade?.textContent ?? null,
      gradeId: popup.querySelector(".omikuji-fortune")?.dataset.omikujiGrade ?? null,
      slipNumber: popup.querySelector(".omikuji-number")?.textContent ?? null,
      verse: popup.querySelector(".omikuji-verse")?.textContent ?? null,
      source: popup.querySelector(".omikuji-fortune .omikuji-source")?.textContent ?? null,
      seal: popup.querySelector(".omikuji-seal")?.textContent ?? null,
      minis: [...popup.querySelectorAll(".omikuji-mini")].map(node => `${node.textContent} (${node.title})`),
      shelf: [...popup.querySelectorAll(".omikuji-shelf button")].map(button => button.getAttribute("aria-label") || button.textContent.trim()),
      ribbons: [...popup.querySelectorAll(".omikuji-ribbon")].map(node => node.textContent),
      emaGlyph: popup.querySelector(".omikuji-ema-glyph")?.textContent ?? null,
      chromeHidden: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      gradeFont: grade ? `${style(grade).fontWeight} ${style(grade).fontSize} ${style(grade).fontFamily.split(",")[0]}` : null,
      gradeColor: grade ? style(grade).color : null,
      headwordSize: style(expression)?.fontSize ?? null,
      headwordColor: style(expression)?.color ?? null,
      glossSize: style(gloss)?.fontSize ?? null,
      glossColor: style(gloss)?.color ?? null,
      contentTransform: style(content)?.transform ?? null,
      contentOpacity: style(content)?.opacity ?? null,
      hiddenByTheme: popup.querySelectorAll("[data-theme-hidden]").length,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  });
  const waitFor = async (predicate, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popupState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)}`);
      await new Promise(r => setTimeout(r, 100));
    }
  };
  const settle = (ms = 700) => tab.evaluate(ms => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ms)))), ms);

  async function hoverWord(id, expect) {
    const box = await (await tab.$(`#${id}`)).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(6, 900);
      await new Promise(r => setTimeout(r, 120));
      await tab.mouse.move(box.x + Math.min(14, box.width * 0.2), box.y + box.height / 2);
      try { return await waitFor(expect, 2500); } catch (error) { console.error(`[hover ${id} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering #${id}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(6, 900);
    await new Promise(r => setTimeout(r, 700));
  }
  async function shadowPoint(selector, text = null) {
    return tab.evaluate((selector, text) => {
      const host = document.querySelector("hachidori-host");
      const nodes = [...host.shadowRoot.querySelectorAll(selector)];
      const node = text ? nodes.find(n => n.textContent.trim() === text) : nodes[0];
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    }, selector, text);
  }
  async function clickKanji(character, expect, rehover = null) {
    let point = null;
    for (let attempt = 0; attempt < 60 && !point; attempt += 1) {
      point = await shadowPoint(".gsm-hoshidicts-kanji-link", character);
      if (!point) {
        const state = await popupState();
        console.error(`[kanji ${character} attempt ${attempt}] popup=${state ? "visible" : "hidden"}`);
        if (!state && rehover) await hoverWord(rehover, s => s.term > 0);
        else await new Promise(r => setTimeout(r, 100));
      }
    }
    if (!point) throw new Error(`no kanji link ${character}`);
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
    return waitFor(expect);
  }
  async function shot(name, { pad = 26, settleMs = 700, includePage = false, word = null } = {}) {
    if (settleMs) await settle(settleMs);
    let fresh = await popupState();
    if (!fresh && word) {
      console.error(`[shot ${name}] popup gone; hovering #${word} again`);
      fresh = await hoverWord(word, s => s.term > 0 || s.kanji > 0);
      await settle(settleMs || 300);
      fresh = await popupState();
    }
    if (!fresh) throw new Error(`shot ${name}: no popup`);
    const viewport = { width: 1000, height: 940 };
    const clip = includePage
      ? { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, fresh.rect.y + fresh.rect.height + pad) }
      : { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad),
        width: Math.min(viewport.width - Math.max(0, fresh.rect.x - pad), fresh.rect.width + pad * 2),
        height: Math.min(viewport.height - Math.max(0, fresh.rect.y - pad), fresh.rect.height + pad * 2) };
    // No viewport override for the capture: a metrics change is a resize to the
    // page, and the reader hides its popup on resize.
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip, captureBeyondViewport: false });
    report.shots[name] = fresh;
    console.error(`[shot] ${name} ${fresh.rect.width}x${fresh.rect.height} grade=${fresh.grade} ${fresh.slipNumber ?? ""}`);
    return fresh;
  }

  // ---- default theme, default size, same dictionaries ----
  await hoverWord("w-taberu", s => s.term > 0);
  await shot("default-term", { word: "w-taberu" });
  await clickKanji("食", s => s.kanji > 0, "w-taberu");
  await shot("default-kanji");
  await closePopup();

  // ---- omikuji-shrine: the theme's suggested one-shot options (theme.yaml `options:`) ----
  await writeOptions({ popupTheme: "omikuji-shrine", popupWidthPx: 400, popupHeightPx: 640, popupColumns: 1 });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "omikuji-shrine", { timeout: 15_000 });
  await new Promise(r => setTimeout(r, 500));

  // 食べたかった → 食べる: Jiten rank 190 → 大吉.
  await hoverWord("w-taberu", s => s.term > 0 && s.fortunes === 1);
  await shot("omikuji-term", { word: "w-taberu" });
  await shot("omikuji-term-page", { includePage: true, settleMs: 0, word: "w-taberu" });
  // Hover an ema plaque: it swings on its cord.
  const audioPoint = await shadowPoint(".omikuji-shelf .gsm-hoshidicts-audio-button");
  if (audioPoint) {
    await tab.mouse.move(audioPoint.x, audioPoint.y);
    await shot("omikuji-ema-hover", { settleMs: 600 });
  }
  // Keyboard: Tab into the shelf until the Note plaque has focus (focus ring).
  for (let presses = 0; presses < 20; presses += 1) {
    await tab.keyboard.press("Tab");
    const focused = await tab.evaluate(() => document.querySelector("hachidori-host")?.shadowRoot?.activeElement?.className ?? "");
    if (/gsm-hoshidicts-note-button/u.test(focused)) break;
  }
  report.shots["omikuji-focus-target"] = await tab.evaluate(() => document.querySelector("hachidori-host")?.shadowRoot?.activeElement?.getAttribute("aria-label") ?? null);
  await shot("omikuji-ema-focus", { settleMs: 500 });
  // Kanji view: 食 on an ema board, KANJIDIC newspaper rank 382.
  await clickKanji("食", s => s.kanji > 0 && s.emaGlyph === "食", "w-taberu");
  await shot("omikuji-kanji");
  // Back re-renders the term view; the hook runs again and must not duplicate anything.
  const backPoint = await shadowPoint(".omikuji-shelf .gsm-hoshidicts-kanji-back");
  await tab.mouse.click(backPoint.x, backPoint.y);
  report.shots["omikuji-back"] = await waitFor(s => s.term > 0 && s.fortunes === 1 && s.seal === "食");
  await closePopup();

  // Slide-out frames: slow every animation 12.5× (CDP Animation domain) and
  // catch the slip mid-way out of the box. 鳥居 → rank 19,820 → 末吉.
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.08 });
  await hoverWord("w-torii", s => s.term > 0 && s.fortunes === 1);
  await shot("omikuji-slide-1", { settleMs: 0 });
  await new Promise(r => setTimeout(r, 900));
  await shot("omikuji-slide-2", { settleMs: 0 });
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  await new Promise(r => setTimeout(r, 1200));
  await shot("omikuji-slide-3", { settleMs: 200 });
  await closePopup();

  // 神社 (rank 5,475 → 小吉); the further entries (神 …) each carry a miniature
  // fortune from their own rank. Scroll the verses to the second entry.
  await hoverWord("w-jinja", s => s.term > 0 && s.fortunes === 1);
  await shot("omikuji-secondary", { word: "w-jinja" });
  await tab.evaluate(() => {
    const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
    const content = popup.querySelector(":scope > .gsm-hoshidicts-content-scroll");
    const second = popup.querySelectorAll(".gsm-hoshidicts-entry")[1];
    if (second) content.scrollTop += second.getBoundingClientRect().top - content.getBoundingClientRect().top - 6;
  });
  await shot("omikuji-secondary-scrolled", { word: "w-jinja", settleMs: 400 });
  await closePopup();

  // Long multi-sense entry: 掛ける (Jitendex, many senses).
  await hoverWord("w-kakeru", s => s.term > 0 && s.fortunes === 1);
  await shot("omikuji-long", { word: "w-kakeru" });
  await closePopup();

  // Bad fortunes: 参拝 (rank 28,383 → 凶) and 御籤 (rank 178,352 → 大凶), printed in sumi.
  await hoverWord("w-sanpai", s => s.term > 0 && s.fortunes === 1);
  await shot("omikuji-kyo", { word: "w-sanpai" });
  await closePopup();
  await hoverWord("w-mikuji", s => s.term > 0 && s.fortunes === 1);
  await shot("omikuji-daikyo", { word: "w-mikuji" });
  await closePopup();
  // The word 大吉 itself.
  await hoverWord("w-daikichi", s => s.term > 0 && s.fortunes === 1);
  await shot("omikuji-word-daikichi", { word: "w-daikichi" });
  await closePopup();

  // Reduced motion: the slip appears in place; no transform, full opacity at once.
  await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.08 });
  await hoverWord("w-unmei", s => s.term > 0 && s.fortunes === 1);
  report.shots["omikuji-reduced-motion-immediate"] = await popupState();
  await shot("omikuji-reduced-motion", { settleMs: 0 });
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  await tab.emulateMediaFeatures([]);
  await closePopup();
} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ chrome: report.chrome, import: report.importState, seconds: report.importSeconds,
  shots: Object.fromEntries(Object.entries(report.shots).map(([k, v]) => [k, typeof v === "object" && v ? { rect: v.rect, grade: v.grade, slipNumber: v.slipNumber, fortunes: v.fortunes } : v])),
  hookOver8ms: report.hookOver8ms, consoleWarnings: report.consoleWarnings }, null, 2));
