// Evidence for issue #334 ("Theme proposal: Retro Terminal"): screenshots of the
// REAL popup (content script + dictionaries imported through Settings) in the
// pinned Chrome for Testing, default theme vs vendor/themes/retro-terminal.
// Not part of the suite.
//
//   HACHIDORI_ROOT=<worktree with host-prototype.patch applied> EVIDENCE_OUT=<dir> \
//   [RT_DICTS=/path/JMdict_english.zip,/path/kanjium_pitch_accents.zip,...] \
//     node capture-retro-terminal.mjs
//
// Session A imports the repo fixture (test/make-fixture.mjs) and shoots
// 食べたかった and the 食 kanji view in both themes, then the keyboard-selection
// state. Session B imports the real dictionaries named by RT_DICTS and shoots a
// long multi-sense entry, a multi-candidate list, its keyboard states and the
// KANJIDIC 食 view. The extension is copied to a temp dir with one added line in
// the theme host that writes each onRender duration to <html data-rt-hook-ms>,
// so the hook's cost is measured in the real page (host log only reports > 8 ms).
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, homedir, loadavg, tmpdir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const REAL_DICTS = (process.env.RT_DICTS || "").split(",").map(s => s.trim()).filter(Boolean);
const SLUG = "retro-terminal";
mkdirSync(OUT, { recursive: true });

// ---- instrumented copy of the extension --------------------------------------
const scratch = mkdtempSync(resolve(tmpdir(), "rt-evidence-"));
const EXTENSION = resolve(scratch, "extension");
cpSync(resolve(ROOT, "extension"), EXTENSION, { recursive: true });
{
  const path = resolve(EXTENSION, "content.js");
  const source = readFileSync(path, "utf8");
  const marker = "      if (elapsed > 8) console.debug(`hachidori theme ${theme.slug}: onRender took ${elapsed.toFixed(1)} ms`);";
  if (!source.includes(marker)) throw new Error("host-prototype.patch marker not found in content.js");
  writeFileSync(path, source.replace(marker, `${marker}\n      document.documentElement.dataset.rtHookMs = (document.documentElement.dataset.rtHookMs ? document.documentElement.dataset.rtHookMs + "," : "") + elapsed.toFixed(3); // evidence probe`));
}

const PAGES = {
  fixture: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>retro-terminal evidence</title>
<style>body{font:32px/2 "Noto Sans CJK JP",serif;padding:56px 80px;background:#f4efe6;color:#222} span{display:inline-block}</style>
</head><body><p>朝ごはんを<span id="verb">食べたかった</span>。本を<span id="yomu">読んだ</span>。</p></body></html>`,
  real: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>retro-terminal evidence</title>
<style>body{font:30px/2.2 "Noto Sans CJK JP",serif;padding:48px 72px;background:#f4efe6;color:#222;max-width:900px} span{display:inline-block}</style>
</head><body><p>彼女に電話を<span id="kakeru">掛けたかった</span>が、<span id="nihongo">日本語</span>で何と言えばいいか<span id="wakaru">分からなかった</span>。</p></body></html>`,
};
let pageHtml = PAGES.fixture;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(pageHtml);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const report = { chrome: null, machine: { cpu: cpus()[0].model, logicalCpus: cpus().length, node: process.version }, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  theme: { css: readFileSync(resolve(EXTENSION, `vendor/themes/${SLUG}/theme.css`)).length,
    js: readFileSync(resolve(EXTENSION, `vendor/themes/${SLUG}/theme.js`)).length },
  sessions: {} };

async function session(name, archives, run) {
  const profile = resolve(scratch, `profile-${name}`);
  mkdirSync(profile, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: profile, protocolTimeout: 600_000,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
      `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
  });
  const record = { archives: archives.map(a => a.split("/").pop()), loadAtStart: loadavg(), shots: {}, hookMs: {}, console: [] };
  report.sessions[name] = record;
  try {
    report.chrome = await browser.version();
    const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;

    // ---- import through Settings → Add dictionaries ----
    const settings = await browser.newPage();
    settings.setDefaultNavigationTimeout(180_000);   // the box is shared; load averages above 20 are normal here
    await settings.setViewport({ width: 1200, height: 900 });
    await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
    await settings.waitForSelector("#import-file", { timeout: 20_000 });
    await settings.waitForFunction(async () => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
    }, { timeout: 90_000, polling: 200 });
    await new Promise(r => setTimeout(r, 1500));
    const importStarted = Date.now();
    await (await settings.$("#import-file")).uploadFile(...archives);
    record.importState = await settings.waitForFunction(count => {
      const text = (document.getElementById("import-state")?.textContent || "").trim();
      return text.startsWith(`Finished ${count} of ${count} archive`) ? text : false;
    }, { timeout: 600_000, polling: 500 }, archives.length).then(h => h.jsonValue());
    record.importMs = Date.now() - importStarted;
    record.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
      .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
    console.error(`[${name} import ${record.importMs} ms] ${record.importState} ${JSON.stringify(record.importDetail)}`);
    if (!record.importState.includes(`${archives.length} imported`)) throw new Error(`import failed: ${record.importState}`);

    const writeOptions = patch => settings.evaluate(async patch => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: patch });
      if (!reply.ok) throw new Error(reply.error);
      return reply.options.revision;
    }, patch);
    // Hover lookups without an activation key, so the capture mirrors a plain hover.
    await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100, popupTheme: "default" });

    // ---- the reading page ----
    const tab = await browser.newPage();
    tab.setDefaultNavigationTimeout(180_000);
    tab.on("console", message => { record.console.push(`${message.type()}: ${message.text()}`); console.error(`[tab console ${message.type()}] ${message.text()}`); });
    tab.on("pageerror", error => { record.console.push(`pageerror: ${error.message}`); console.error(`[tab pageerror] ${error.message}`); });
    await tab.setViewport({ width: 1000, height: 820, deviceScaleFactor: 2 });
    await tab.goto(PAGE_URL, { waitUntil: "load" });
    await new Promise(r => setTimeout(r, 1500));

    const popupState = () => tab.evaluate(slug => {
      const host = document.querySelector("hachidori-host");
      const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
      if (!popup || popup.hidden) return null;
      const rect = popup.getBoundingClientRect();
      const style = getComputedStyle(popup);
      const expression = popup.querySelector(".gsm-hoshidicts-expression");
      const rows = [...popup.querySelectorAll(".rt-row")];
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
        kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
        themed: Boolean(popup.querySelector(":scope > .rt-status")),
        theme: host.dataset.hoshidictsTheme,
        sheets: host.shadowRoot.adoptedStyleSheets.length,
        background: style.backgroundColor,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        headwordSize: expression ? getComputedStyle(expression).fontSize : null,
        headwordColor: expression ? getComputedStyle(expression).color : null,
        reading: popup.querySelector(".rt-reading")?.textContent ?? null,
        trace: popup.querySelector(".rt-trace")?.textContent ?? null,
        rows: rows.map(row => ({ text: row.textContent.replace(/\s+/g, " ").trim(), selected: row.getAttribute("aria-selected") === "true" })),
        listScrollTop: popup.querySelector(".rt-list")?.scrollTop ?? null,
        status: popup.querySelector(".rt-status")?.textContent.replace(/\s+/g, " ").trim() ?? null,
        selectedEntry: [...popup.querySelectorAll(".gsm-hoshidicts-entry, .gsm-hoshidicts-kanji-entry")].findIndex(e => e.hasAttribute("data-rt-selected")),
        contentScrollTop: popup.querySelector(".gsm-hoshidicts-content-scroll")?.scrollTop ?? null,
        focusInPopup: popup.contains(host.shadowRoot.activeElement),
        stats: popup.querySelector(".rt-stats")?.textContent ?? null,
        showMore: Boolean(popup.querySelector(".gsm-hoshidicts-show-more")),
        glossSize: getComputedStyle(popup.querySelector(".gsm-hoshidicts-glossary-content") || popup).fontSize,
        hookMs: (document.documentElement.dataset.rtHookMs || "").split(",").filter(Boolean).map(Number),
        textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 300),
      };
    }, SLUG);
    const waitFor = async (predicate, ms = 30_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const state = await popupState();
        if (state && predicate(state)) return state;
        if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)}`);
        await new Promise(r => setTimeout(r, 200));
      }
    };
    const settle = () => tab.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))));

    async function hoverWord(id, expect, fraction = 0.15) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (attempt === 6) {
          // The shared box sometimes invalidates the extension context under load
          // ("content script stopped"); a reload re-injects the content script.
          console.error(`[hover ${id}] reloading the page`);
          record.reloads = (record.reloads ?? 0) + 1;
          await tab.reload({ waitUntil: "load" });
          await new Promise(r => setTimeout(r, 1500));
        }
        const box = await (await tab.$(`#${id}`)).boundingBox();
        await tab.mouse.move(2, 2);
        await tab.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
        try { return await waitFor(expect, 4000); } catch (error) { console.error(`[hover ${id} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
      }
      throw new Error(`no popup after hovering #${id}`);
    }
    async function closePopup() {
      await tab.keyboard.press("Escape");
      await tab.mouse.move(2, 2);
      await new Promise(r => setTimeout(r, 700));
    }
    async function clickKanji(character, expect, rehover = null) {
      const find = () => tab.waitForFunction(character => {
        const host = document.querySelector("hachidori-host");
        const link = [...host.shadowRoot.querySelectorAll(".gsm-hoshidicts-kanji-link")].find(b => b.textContent === character);
        if (!link) return false;
        const rect = link.getBoundingClientRect();
        return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : false;
      }, { timeout: 8_000, polling: 100 }, character).then(handle => handle.jsonValue());
      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          if (attempt > 0 && rehover) { await tab.mouse.move(2, 2); await new Promise(r => setTimeout(r, 800)); await rehover(); }
          const point = await find();
          await tab.mouse.move(point.x, point.y);
          await tab.mouse.click(point.x, point.y);
          return await waitFor(expect, 20_000);
        } catch (error) {
          lastError = error;
          console.error(`[clickKanji ${character} attempt ${attempt}] ${error.message.slice(0, 120)}`);
          if (!rehover) break;
        }
      }
      throw lastError;
    }
    async function clickInPopup(selector, index = 0) {
      const point = await tab.evaluate((selector, index) => {
        const host = document.querySelector("hachidori-host");
        const node = host.shadowRoot.querySelectorAll(selector)[index];
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x + Math.min(rect.width / 2, 40), y: rect.y + rect.height / 2 };
      }, selector, index);
      if (!point) throw new Error(`no ${selector}[${index}] in popup`);
      await tab.mouse.move(point.x, point.y);
      await tab.mouse.click(point.x, point.y);
      await settle();
      return popupState();
    }
    async function shot(label, { pad = 28 } = {}) {
      await settle();
      // The block cursor blinks (steps(1, end)); hold every popup animation at
      // its visible phase so the screenshot is deterministic.
      await tab.evaluate(() => {
        const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
        for (const animation of popup?.getAnimations({ subtree: true }) ?? []) { animation.pause(); animation.currentTime = 100; }
      });
      const fresh = await popupState();
      const clip = { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad),
        width: Math.min(1000 - Math.max(0, fresh.rect.x - pad), fresh.rect.width + pad * 2),
        height: Math.min(820 - Math.max(0, fresh.rect.y - pad), fresh.rect.height + pad * 2) };
      await tab.screenshot({ path: resolve(OUT, `${label}.png`), clip, captureBeyondViewport: false });
      record.shots[label] = fresh;
      record.hookMs[label] = fresh.hookMs.slice(-3);
      console.error(`[shot ${label}] ${fresh.rect.width}x${fresh.rect.height} hook ${fresh.hookMs.slice(-3).join(",")} ms | ${fresh.status ?? fresh.textSample.slice(0, 80)}`);
      return fresh;
    }
    const activate = async slug => {
      await writeOptions({ popupTheme: slug });
      await tab.waitForFunction(slug => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === slug, { timeout: 15_000 }, slug);
      await new Promise(r => setTimeout(r, 400));
    };
    try {
      await run({ tab, hoverWord, closePopup, clickKanji, clickInPopup, shot, settle, waitFor, popupState, activate, writeOptions });
    } catch (error) {
      record.error = error.message;
      console.error(`[${name}] session aborted: ${error.message.slice(0, 300)}`);
    }
    writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
  } finally {
    record.loadAtEnd = loadavg();
    await browser.close();
  }
}

try {
  // ---- Session A: the repo fixture, default vs retro-terminal, kanji, keyboard ----
  pageHtml = PAGES.fixture;
  await session("fixture", [FIXTURE], async ({ tab, hoverWord, closePopup, clickKanji, clickInPopup, shot, settle, waitFor, activate }) => {
    await hoverWord("verb", s => s.term > 0);
    await shot("default-term");
    await clickKanji("食", s => s.kanji > 0, () => hoverWord("verb", s => s.term > 0));
    await shot("default-kanji");
    await closePopup();

    await activate(SLUG);
    await hoverWord("verb", s => s.term > 0 && s.themed);
    await shot("retro-term");
    // Keyboard: click row 1 to focus the list, then j moves to the second candidate.
    await clickInPopup(".rt-row", 0);
    await tab.keyboard.press("j");
    await settle();
    await shot("retro-term-keyboard");
    await tab.keyboard.press("k");
    await settle();
    const back = await waitFor(s => s.rows[0]?.selected);
    report.sessions.fixture.keyboardBack = back.status;
    await clickKanji("食", s => s.kanji > 0 && s.themed, () => hoverWord("verb", s => s.term > 0 && s.themed));
    await shot("retro-kanji");
    // Back re-renders the term view and the hook runs again on the re-render.
    await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back").click());
    report.sessions.fixture.afterBack = await waitFor(s => s.term > 0 && s.themed);
    await closePopup();

    // Reduced motion: the CRT overlay and the blink are off; contrast/text unchanged.
    await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await hoverWord("verb", s => s.term > 0 && s.themed);
    report.sessions.fixture.reducedMotion = await tab.evaluate(() => {
      const host = document.querySelector("hachidori-host");
      const popup = host.shadowRoot.querySelector(".gsm-hoshidicts-popup");
      const overlay = getComputedStyle(popup, "::after");
      const cursor = getComputedStyle(popup.querySelector('.rt-row[aria-selected="true"] .rt-cur'), "::after");
      return { overlayDisplay: overlay.display, cursorAnimation: cursor.animationName, cursorWidth: cursor.width };
    });
    await shot("retro-term-reduced-motion");
    await closePopup();
    await tab.emulateMediaFeatures([]);

    // Hook cost: 40 alternating hovers (食べたかった / 読んだ) on the same page,
    // each a full re-render → one onRender call; durations from the host probe.
    const loadBeforeLoop = loadavg();
    const before = await tab.evaluate(() => (document.documentElement.dataset.rtHookMs || "").split(",").filter(Boolean).length);
    let loopFailures = 0;
    for (let i = 0; i < 40; i += 1) {
      try {
        await hoverWord(i % 2 ? "yomu" : "verb", s => s.term > 0 && s.themed && s.rows[0]?.text.startsWith(i % 2 ? "1読む" : "1食べる"));
        await closePopup();
      } catch (error) {
        loopFailures += 1;
        console.error(`[hook cost] iteration ${i} lost: ${error.message.slice(0, 120)}`);
        if (loopFailures > 3) break;
      }
    }
    const all = await tab.evaluate(() => (document.documentElement.dataset.rtHookMs || "").split(",").filter(Boolean).map(Number));
    const samples = all.slice(before);
    const sorted = [...samples].sort((a, b) => a - b);
    const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    report.sessions.fixture.hookCost = { renders: samples.length, medianMs: q(0.5), p95Ms: q(0.95), maxMs: sorted.at(-1), samples,
      loadBefore: loadBeforeLoop, loadAfter: loadavg(),
      note: "onRender wall time inside the host's try/finally, real page, fixture dictionary, 2-entry popup; first themed render of the page excluded (see hookMs of retro-term)" };
    console.error(`[hook cost] n=${samples.length} median ${q(0.5)} ms p95 ${q(0.95)} ms max ${sorted.at(-1)} ms`);
  });

  // ---- Session B: real dictionaries — long entry, candidate list, keyboard, KANJIDIC ----
  if (REAL_DICTS.length > 0) {
    pageHtml = PAGES.real;
    await session("real", REAL_DICTS, async ({ tab, hoverWord, closePopup, clickKanji, clickInPopup, shot, settle, waitFor, activate }) => {
      await hoverWord("kakeru", s => s.term > 0);
      await shot("default-long");
      await closePopup();
      await activate(SLUG);
      await hoverWord("kakeru", s => s.term > 0 && s.themed);
      await shot("retro-long");
      // m = Show more (reveals every remaining record); then j j walks the list
      // and the body scrolls to the selected record.
      await clickInPopup(".rt-row", 0);
      const before = await waitFor(s => s.focusInPopup);
      report.sessions.real.rowsBeforeMore = before.rows.length;
      await tab.keyboard.press("m");
      await settle();
      const after = await waitFor(s => !s.showMore);
      report.sessions.real.rowsAfterMore = after.rows.length;
      await tab.keyboard.press("j");
      await tab.keyboard.press("j");
      await settle();
      await shot("retro-long-keyboard");
      await tab.keyboard.press("G");
      await settle();
      await shot("retro-long-last");
      await closePopup();

      await hoverWord("nihongo", s => s.term > 0 && s.themed, 0.1);
      await shot("retro-list");
      await clickInPopup(".rt-row", 0);
      await tab.keyboard.press("3");
      await settle();
      await shot("retro-list-keyboard");
      await closePopup();

      // KANJIDIC: hover 分からなかった then click 分.
      await hoverWord("wakaru", s => s.term > 0 && s.themed, 0.07);
      await shot("retro-wakaru");
      await clickKanji("分", s => s.kanji > 0 && s.themed, () => hoverWord("wakaru", s => s.term > 0 && s.themed, 0.07));
      await shot("retro-kanji-real");
      await closePopup();
      await activate("default");
      await hoverWord("wakaru", s => s.term > 0 && !s.themed, 0.07);
      await clickKanji("分", s => s.kanji > 0 && !s.themed, () => hoverWord("wakaru", s => s.term > 0 && !s.themed, 0.07));
      await shot("default-kanji-real");
      await closePopup();
    });
  }
} finally {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
