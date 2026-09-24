// Evidence for issue #334 ("Sentence Context" theme proposal): screenshots of the
// REAL popup (content script + real Yomitan dictionaries) in the pinned Chrome for
// Testing, default theme vs vendor/themes/sentence-context{,-dark}. Not part of
// the suite. Needs the worktree-only theme host (host-prototype.patch, extended
// with view.source / api.copyText / `extends`) applied in HACHIDORI_ROOT.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> DICTS=/tmp/hd-dicts node capture-sentence-context.mjs
//
// A fake AnkiConnect answers on a loopback port so the renderer's own Anki
// button exists and sits in the theme's tools row; nothing is written anywhere.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const DICTS = process.env.DICTS ?? "/tmp/hd-dicts";
const CHROME = process.env.HACHIDORI_CHROME
  ?? resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const ARCHIVES = ["jitendex-yomitan.zip", "KANJIDIC_english.zip", "bees-ultimate-kanji-dictionary.zip", "jiten-frequency.zip", "kanjium_pitch_accents.zip"]
  .map(name => resolve(DICTS, name)).filter(path => existsSync(path));
const PROFILE = `/tmp/sentence-context-profile-${process.pid}`;
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });
const { answerAnkiConnect } = await import(resolve(ROOT, "test/anki-connect-fake.mjs"));

// ---- pages ------------------------------------------------------------------
const PLAIN_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>sentence-context evidence</title>
<style>body{font:30px/2 "Noto Serif CJK JP",serif;padding:56px 80px;background:#f4efe6;color:#222} span{display:inline-block}</style>
</head><body><p>朝ごはんを<span id="verb">食べたかった</span>。</p></body></html>`;

// A texthooker-like page: several visual-novel lines, newest at the bottom.
const LINES = [
  "「ねえ、聞いてる？」",
  "彼女は窓の外を見ながら、小さくため息をついた。",
  "昨日の夜、駅前の喫茶店で偶然あの人に会ったんだ。",
  "「本当は、ずっと前から君に伝えたかったことがある」",
  "そう言われた瞬間、心臓が止まりそうになった。",
  "何も答えられなくて、ただ黙って彼の顔を見つめていた。",
];
const HOOKER_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>texthooker</title>
<style>
  body{margin:0;background:#141414;color:#e8e8e8;font:26px/1.9 "Noto Sans CJK JP",sans-serif}
  main{max-width:900px;margin:0 auto;padding:40px 48px}
  p{margin:0 0 6px;padding:8px 12px;border-left:3px solid #2a2a2a}
  p:last-child{border-left-color:#7aa2f7}
  .count{position:fixed;right:24px;top:16px;font:14px monospace;color:#777}
</style></head><body><div class="count">6 lines · 92 chars</div><main>${LINES.map((line, index) => `<p id="line-${index}">${line}</p>`).join("")}</main></body></html>`;

const pages = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(request.url.startsWith("/hooker") ? HOOKER_HTML : PLAIN_HTML);
});
await new Promise(done => pages.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${pages.address().port}/`;

// ---- fake AnkiConnect ----------------------------------------------------------
const ankiCalls = [];
const anki = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", async () => {
    const reply = await answerAnkiConnect(JSON.parse(body || "{}"), async (action, params) => {
      ankiCalls.push(action);
      switch (action) {
        case "version": return 6;
        case "requestPermission": return { permission: "granted", requireApiKey: false, version: 6 };
        case "deckNames": return ["Default", "Mining"];
        case "modelNames": return ["Basic"];
        case "modelNamesAndIds": return { Basic: 1 };
        case "modelFieldNames": return ["Front", "Back", "Sentence"];
        case "canAddNotes": return params.notes.map(() => true);
        case "canAddNotesWithErrorDetail": return params.notes.map(() => ({ canAdd: true, error: null }));
        case "findNotes": return [];
        case "notesInfo": return [];
        case "cardsInfo": return [];
        default: throw new Error(`fake AnkiConnect: unexpected action ${action}`);
      }
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
});
await new Promise(done => anki.listen(0, "127.0.0.1", done));
const ANKI_URL = `http://127.0.0.1:${anki.address().port}`;

const report = { chrome: null, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  archives: ARCHIVES, shots: {} };
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE, protocolTimeout: 600_000, timeout: 180_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;

  // ---- import the dictionaries through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  settings.setDefaultTimeout(600_000);
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  await (await settings.$("#import-file")).uploadFile(...ARCHIVES);
  const count = ARCHIVES.length;
  report.importState = await settings.waitForFunction(count => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith(`Finished ${count} of ${count} archive`) ? text : false;
  }, { timeout: 600_000, polling: 500 }, count).then(h => h.jsonValue());
  console.error(`[import] ${report.importState}`);
  if (!report.importState.includes(`${count} imported`)) throw new Error(`import failed: ${report.importState}`);

  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  const defaults = await settings.evaluate(() => HDReaderOptions.normaliseOptions({}));
  // Plain hover, opaque popup, the fake Anki so the mine button exists.
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100, hoverDelayMs: 0,
    anki: { ...defaults.anki, url: ANKI_URL, model: "Basic", deck: "Mining",
      fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" }, Back: { value: "{glossary}", overwriteMode: "overwrite" },
        Sentence: { value: "{sentence}", overwriteMode: "overwrite" } } } });

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.setDefaultTimeout(60_000);
  tab.on("console", message => { if (message.type() !== "debug") console.error(`[tab ${message.type()}] ${message.text()}`); });
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  await tab.setViewport({ width: 1100, height: 820, deviceScaleFactor: 2 });
  // Puppeteer's overridePermissions(["clipboard-write"]) denies writeText in
  // headless Chrome 152; the CDP grant with Chrome's own names allows it, and
  // clipboardReadWrite lets the script read the clipboard back to verify.
  await (await browser.target().createCDPSession()).send("Browser.grantPermissions",
    { origin: PAGE_URL, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await tab.bringToFront();

  const popupState = (depth = 0) => tab.evaluate(depth => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector(`.gsm-hoshidicts-popup[data-hoshidicts-depth="${depth}"]`);
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const css = (selector, property) => { const node = popup.querySelector(selector); return node ? getComputedStyle(node)[property] : null; };
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      masthead: !!popup.querySelector(".sc-masthead"),
      sentence: popup.querySelector(".sc-sentence")?.textContent ?? null,
      match: popup.querySelector(".sc-match")?.textContent ?? null,
      chips: [...popup.querySelectorAll(".sc-chip")].map(chip => chip.textContent),
      tools: [...popup.querySelectorAll(".sc-tools button")].map(button => button.getAttribute("aria-label") || button.textContent.trim() || button.className),
      mineState: popup.querySelector(".gsm-hoshidicts-mine-button")?.dataset.state ?? null,
      copyState: popup.querySelector(".sc-copy")?.dataset.state ?? null,
      noteOpen: popup.querySelector(".sc-trail-note")?.hidden === false,
      marked: popup.querySelector(".sc-sentence")?.classList.contains("sc-marked") ?? null,
      wordsMarked: popup.querySelectorAll(".sc-word").length,
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      background: getComputedStyle(popup).backgroundColor,
      font: getComputedStyle(popup).fontFamily.split(",")[0],
      headwordSize: css(".gsm-hoshidicts-expression", "fontSize"),
      sentenceSize: css(".sc-sentence", "fontSize"),
      glossSize: css(".gsm-hoshidicts-glossary-content", "fontSize"),
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  }, depth);
  const waitFor = async (predicate, ms = 30_000, depth = 0) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popupState(depth);
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)?.slice(0, 600)}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };
  const settle = (ms = 450) => tab.evaluate(ms => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ms)))), ms);

  async function hoverElement(selector, expect, fraction = 0.15) {
    const box = await (await tab.$(selector)).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(2, 2);
      await new Promise(r => setTimeout(r, 150));
      await tab.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
      try { return await waitFor(expect, 2500); } catch (error) { console.error(`[hover ${selector} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering ${selector}`);
  }
  // Hovers a character range inside a text node of the page so the sentence is realistic.
  async function hoverText(selector, word, expect) {
    const point = await tab.evaluate(({ selector, word }) => {
      const node = document.querySelector(selector).firstChild;
      const offset = node.nodeValue.indexOf(word);
      const range = document.createRange();
      range.setStart(node, offset); range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width * 0.4, y: rect.y + rect.height / 2 };
    }, { selector, word });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(2, 2);
      await new Promise(r => setTimeout(r, 150));
      await tab.mouse.move(point.x, point.y);
      try { return await waitFor(expect, 2500); } catch (error) { console.error(`[hoverText ${word} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering ${word}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 700));
  }
  const inPopup = (selector, depth = 0) => tab.evaluate(({ selector, depth }) => {
    const host = document.querySelector("hachidori-host");
    const popup = host.shadowRoot.querySelector(`.gsm-hoshidicts-popup[data-hoshidicts-depth="${depth}"]`);
    const node = popup?.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, { selector, depth });
  async function clickInPopup(selector, depth = 0) {
    const point = await inPopup(selector, depth);
    if (!point) throw new Error(`${selector} not in popup`);
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
    return point;
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
  // Puppeteer's clipped screenshot emulates device metrics for the clip, which
  // fires resize + mouseleave on the page and makes a hover popup close. The raw
  // CDP capture with a clip does not, so the popup survives its own screenshot.
  const cdp = await tab.createCDPSession();
  // The theme host records every onRender duration in the content script's
  // isolated world (window.__hachidoriThemeHookTimes, prototype only); read it
  // through CDP from whichever execution context has it.
  const contexts = new Map();
  cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.set(context.id, context));
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on("Runtime.executionContextsCleared", () => contexts.clear());
  await cdp.send("Runtime.enable");
  const hookTimes = async () => {
    const all = [];
    for (const id of contexts.keys()) {
      const result = await cdp.send("Runtime.evaluate", { contextId: id, returnByValue: true,
        expression: "JSON.stringify(typeof __hachidoriThemeHookTimes === 'object' ? __hachidoriThemeHookTimes : null)" }).catch(() => null);
      const value = result?.result?.value ? JSON.parse(result.result.value) : null;
      if (Array.isArray(value)) all.push(...value);
    }
    return all;
  };
  async function shot(name, { pad = 28, full = false, depth = 0 } = {}) {
    await settle();
    const fresh = await popupState(depth);
    const viewport = tab.viewport();
    let clip;
    if (full) clip = { x: 0, y: 0, width: viewport.width, height: viewport.height };
    else {
      const rects = [fresh.rect];
      const child = await popupState(depth + 1);
      if (child) rects.push(child.rect);
      const x0 = Math.max(0, Math.min(...rects.map(r => r.x)) - pad), y0 = Math.max(0, Math.min(...rects.map(r => r.y)) - pad);
      const x1 = Math.min(viewport.width, Math.max(...rects.map(r => r.x + r.width)) + pad);
      const y1 = Math.min(viewport.height, Math.max(...rects.map(r => r.y + r.height)) + pad);
      clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
    writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(data, "base64"));
    report.shots[name] = fresh;
    console.error(`[shot] ${name} ${JSON.stringify({ rect: fresh.rect, masthead: fresh.masthead, chips: fresh.chips, tools: fresh.tools, mine: fresh.mineState })}`);
    return fresh;
  }
  const useTheme = async slug => {
    await writeOptions({ popupTheme: slug });
    // The host element is created lazily on the first lookup of a page; until
    // then there is nothing to observe and the theme applies on creation.
    await tab.waitForFunction(slug => {
      const host = document.querySelector("hachidori-host");
      return !host || host.dataset.hoshidictsTheme === slug;
    }, { timeout: 30_000 }, slug);
    await new Promise(r => setTimeout(r, 600));
  };

  // ================= plain page =================
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));
  // The first lookup after an import pays for the engine loading the new
  // generation (tens of seconds for Jitendex); wait it out once.
  {
    const box = await (await tab.$("#verb")).boundingBox();
    await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
    await waitFor(s => s.term > 0, 180_000);
    await closePopup();
  }

  // ---- default theme, for comparison ----
  await hoverElement("#verb", s => s.term > 0);
  await waitFor(s => s.mineState && s.mineState !== "checking", 10_000).catch(() => {});
  await shot("default-term");
  await clickKanji("食", s => s.kanji > 0);
  await shot("default-kanji");
  await closePopup();

  // ---- sentence-context (light) ----
  // Clicking inside the popup focuses it, which pins it open and pauses hover
  // lookups (keyboard users); Escape releases it before the next hover.
  await useTheme("sentence-context");
  await hoverElement("#verb", s => s.term > 0 && s.masthead);
  await waitFor(s => s.mineState && s.mineState !== "checking", 10_000).catch(() => {});
  await shot("sc-term");
  // A step chip reveals the dictionary's grammar note for that step.
  await clickInPopup(".sc-chip-step");
  await waitFor(s => s.masthead && s.noteOpen);
  await shot("sc-term-step-note");
  await closePopup();
  // "Mark words" underlines the other likely words; the toggle is remembered for the page.
  await hoverElement("#verb", s => s.term > 0 && s.masthead);
  await clickInPopup(".sc-mark");
  await waitFor(s => s.marked === true);
  await shot("sc-term-marked");
  await closePopup();
  // Copy sentence → "Copied" while the pointer stays on the button. The popup
  // re-opens already marked: module state survives the re-render.
  await hoverElement("#verb", s => s.term > 0 && s.masthead && s.marked === true);
  await clickInPopup(".sc-copy");
  const copied = await waitFor(s => s.copyState === "copied" || s.copyState === "failed", 5_000);
  report.clipboard = await tab.evaluate(() => navigator.clipboard.readText().catch(error => `error: ${error.message}`));
  await shot("sc-term-copied");
  console.error(`[copy] state=${copied.copyState} clipboard=${JSON.stringify(report.clipboard)}`);
  await closePopup();
  // Hover a word inside the masthead sentence: the sentence is a lookup surface
  // and opens a child popup like a definition would.
  await hoverElement("#verb", s => s.term > 0 && s.masthead);
  const wordPoint = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const words = [...host.shadowRoot.querySelectorAll('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"] .sc-word')];
    const target = words.find(w => w.textContent === "朝ごはん") ?? words[0];
    const range = document.createRange();
    range.setStart(target.firstChild, 0); range.setEnd(target.firstChild, 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + rect.width * 0.5, y: rect.y + rect.height / 2, text: target.textContent };
  });
  await tab.mouse.move(wordPoint.x, wordPoint.y);
  const child = await waitFor(s => s.term > 0 && s.masthead, 30_000, 1);
  console.error(`[nested] hovered ${wordPoint.text} → child popup ${JSON.stringify(child.textSample.slice(0, 80))}`);
  await shot("sc-term-nested", { pad: 28 });
  await closePopup();
  await closePopup();
  // Mark words off again.
  await hoverElement("#verb", s => s.term > 0 && s.masthead);
  await clickInPopup(".sc-mark");
  await waitFor(s => s.marked === false);
  await closePopup();

  // Kanji view keeps the sentence (kanji emphasised) and shows word › lemma › kanji.
  await hoverElement("#verb", s => s.term > 0 && s.masthead);
  await clickKanji("食", s => s.kanji > 0 && s.masthead);
  await shot("sc-kanji");
  // Back re-renders the term view; the hook runs again.
  await clickInPopup(".gsm-hoshidicts-kanji-back");
  report.shots["sc-back"] = await waitFor(s => s.term > 0 && s.masthead);
  await closePopup();

  // Keyboard focus ring on a tools button.
  await hoverElement("#verb", s => s.term > 0 && s.masthead);
  await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    host.shadowRoot.querySelector(".sc-copy")?.focus();
  });
  await shot("sc-term-focus");
  await closePopup();

  report.hookTimesPlain = await hookTimes();

  // ================= texthooker page =================
  await tab.goto(`${PAGE_URL}hooker`, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1200));
  await useTheme("sentence-context-dark");
  await hoverText("#line-3", "伝えたかった", s => s.term > 0 && s.masthead);
  await waitFor(s => s.mineState && s.mineState !== "checking", 10_000).catch(() => {});
  await shot("sc-dark-hooker-full", { full: true });
  await shot("sc-dark-term");
  await clickInPopup(".sc-mark");
  await waitFor(s => s.marked === true);
  await shot("sc-dark-term-marked");
  await closePopup();
  await hoverText("#line-3", "伝えたかった", s => s.term > 0 && s.masthead);
  await clickInPopup(".sc-mark");
  await waitFor(s => s.marked === false);
  await closePopup();
  // A long multi-sense entry: 見つめていた → 見つめる, or 会った → 会う.
  await hoverText("#line-5", "見つめていた", s => s.term > 0 && s.masthead);
  await waitFor(s => s.mineState && s.mineState !== "checking", 10_000).catch(() => {});
  await shot("sc-dark-long");
  await closePopup();
  // Same line, light theme, for the side-by-side.
  await useTheme("sentence-context");
  await hoverText("#line-2", "会った", s => s.term > 0 && s.masthead);
  await waitFor(s => s.mineState && s.mineState !== "checking", 10_000).catch(() => {});
  await shot("sc-light-hooker");
  await closePopup();
  await useTheme("default");
  await hoverText("#line-2", "会った", s => s.term > 0 && !s.masthead);
  await waitFor(s => s.mineState && s.mineState !== "checking", 10_000).catch(() => {});
  await shot("default-hooker");
  await closePopup();

  report.ankiCalls = [...new Set(ankiCalls)];
  report.hookTimesHooker = await hookTimes();
} finally {
  await browser.close();
  pages.close();
  anki.close();
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
const times = [...(report.hookTimesPlain ?? []), ...(report.hookTimesHooker ?? [])].map(t => t.elapsed).sort((a, b) => a - b);
const quantile = q => times.length ? Number(times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(2)) : null;
report.hookSummary = { renders: times.length, medianMs: quantile(0.5), p95Ms: quantile(0.95), maxMs: times.length ? Number(times.at(-1).toFixed(2)) : null };
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ chrome: report.chrome, importState: report.importState, shots: Object.keys(report.shots), clipboard: report.clipboard,
  hookSummary: report.hookSummary }, null, 2));
