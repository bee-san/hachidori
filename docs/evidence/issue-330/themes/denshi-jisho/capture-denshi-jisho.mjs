// Evidence for issue #334 (theme proposal "denshi-jisho"): screenshots of the
// REAL popup (content script + dictionaries imported through Settings) in the
// pinned Chrome for Testing, default theme vs vendor/themes/denshi-jisho.
// Not part of the test suite.
//
//   HACHIDORI_ROOT=<worktree with the host patch applied> EVIDENCE_OUT=<dir> \
//   DJ_DICTS=/tmp/dj-dicts/JMdict_english.zip:/tmp/dj-dicts/KANJIDIC_english.zip:... \
//   node capture-denshi-jisho.mjs
//
// DJ_DICTS (optional, colon-separated) adds real Yomitan dictionaries next to
// the test fixture; the archives themselves are never committed.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const EXTRA = (process.env.DJ_DICTS || "").split(":").filter(Boolean);
const REDUCED_MOTION = process.env.DJ_REDUCED_MOTION === "1";
const PROFILE = `/tmp/denshi-jisho-profile${REDUCED_MOTION ? "-rm" : ""}`;
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>denshi-jisho evidence</title>
<style>body{font:30px/2.1 "Noto Sans CJK JP",serif;padding:48px 72px;background:#f4efe6;color:#222;max-width:860px} span{display:inline-block}</style>
</head><body><p>朝ごはんを<span id="verb">食べたかった</span>。<span id="w-kanji">漢字</span>を<span id="w-yomu">読む</span>のは<span id="w-kimochi">気持ち</span>がいい。写真を<span id="w-toru">取った</span>。<span id="w-arigatou">ありがとう</span>。</p></body></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const report = { chrome: null, reducedMotion: REDUCED_MOTION,
  extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  dictionaries: [FIXTURE, ...EXTRA].map(path => path.split("/").pop()), shots: {}, console: [] };
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE, timeout: 180_000, protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
browser.process()?.on("exit", (code, signal) => console.error(`[chrome exited] code=${code} signal=${signal}`));
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;

  // ---- import the dictionaries through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  const archives = [FIXTURE, ...EXTRA];
  await (await settings.$("#import-file")).uploadFile(...archives);
  report.importState = await settings.waitForFunction(count => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith(`Finished ${count} of ${count} archive`) ? text : false;
  }, { timeout: 600_000, polling: 500 }, archives.length).then(h => h.jsonValue());
  console.error(`[import] ${report.importState}`);
  if (!report.importState.includes(`${archives.length} imported`)) throw new Error(`import failed: ${report.importState}`);

  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  // Plain hover, opaque popup, grammar tags on (the device prints the part of speech).
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100, hidePopupGrammarTags: false });

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.on("console", message => { const line = `[tab ${message.type()}] ${message.text()}`; report.console.push(line); console.error(line); });
  tab.on("pageerror", error => { report.console.push(`[pageerror] ${error.message}`); console.error(`[tab pageerror] ${error.message}`); });
  await tab.setViewport({ width: 1000, height: 760, deviceScaleFactor: 2 });
  if (REDUCED_MOTION) await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));

  const popupState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const style = node => (node ? getComputedStyle(node) : null);
    const cursor = popup.querySelector("[data-dj-cursor]");
    const screen = popup.querySelector(":scope > .dj-title");
    const content = popup.querySelector(":scope > .gsm-hoshidicts-content-scroll");
    const line = cursor?.querySelector(":scope > .gsm-hoshidicts-entry-header, :scope > .gsm-hoshidicts-kanji-dictionary");
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      device: Boolean(popup.querySelector(":scope > .dj-keys")),
      mode: popup.dataset.djMode ?? null,
      gloss: popup.dataset.djGloss ?? null,
      backlight: popup.dataset.djBacklight ?? null,
      cursorIndex: cursor?.dataset.djIndex ?? null,
      cursorText: line?.textContent.replace(/\s+/g, " ").trim().slice(0, 80) ?? null,
      title: screen?.textContent.replace(/\s+/g, " ").trim() ?? null,
      status: popup.querySelector(".dj-status")?.textContent ?? null,
      hint: [...popup.querySelectorAll(".dj-hint:not([hidden])")].map(n => n.textContent.replace(/\s+/g, " ").trim()).join(" | "),
      chromeHidden: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      focusIn: popup.contains(host.shadowRoot.activeElement) ? host.shadowRoot.activeElement.className : null,
      jump: popup.querySelector("[data-dj-jump]")?.textContent ?? null,
      background: style(popup).backgroundColor,
      lcd: content ? { background: style(content).backgroundColor, color: style(content).color, font: style(content).fontFamily.split(",")[0] } : null,
      headword: (() => { const node = popup.querySelector(".gsm-hoshidicts-expression"); return node ? { size: style(node).fontSize, color: style(node).color } : null; })(),
      gloss1: (() => { const node = popup.querySelector(".gsm-hoshidicts-glossary-content"); return node ? { size: style(node).fontSize, color: style(node).color, visible: style(node).color !== "rgba(0, 0, 0, 0)" } : null; })(),
      keys: [...popup.querySelectorAll(".dj-key")].map(k => `${k.dataset.key}${k.disabled ? "(disabled)" : ""}${k.getAttribute("aria-pressed") ? `[${k.getAttribute("aria-pressed")}]` : ""}`),
      menuItems: [...popup.querySelectorAll(".dj-menu-item")].map(n => n.textContent.replace(/\s+/g, " ").trim()),
      history: [...popup.querySelectorAll(".dj-history-item")].map(n => n.textContent.replace(/\s+/g, " ").trim()),
      table: [...popup.querySelectorAll(".dj-table-label")].map(n => n.textContent),
      motion: screen && content ? { titleTransition: style(screen).transitionDuration, contentTransition: style(content).transitionDuration,
        scrollBehavior: style(content).scrollBehavior, lineTransition: style(line || popup).transitionDuration } : null,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
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
  const settle = () => tab.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 450)))));

  async function hoverWord(id, expect, { optional = false } = {}) {
    const box = await (await tab.$(`#${id}`)).boundingBox();
    for (let attempt = 0; attempt < (optional ? 3 : 12); attempt += 1) {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.12, box.y + box.height / 2);
      try { return await waitFor(expect, 2500); } catch (error) { console.error(`[hover ${id} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    if (optional) { console.error(`[hover ${id}] no results (fixture-only run?) — skipped`); return null; }
    throw new Error(`no popup after hovering #${id}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 700));
  }
  // Centre of a node inside the popup's shadow root, in page coordinates.
  const point = selector => tab.evaluate(selector => {
    const host = document.querySelector("hachidori-host");
    const node = host.shadowRoot.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, selector);
  async function clickIn(selector) {
    let at = null;
    for (let attempt = 0; attempt < 15 && !at; attempt += 1) {
      at = await point(selector);
      if (!at) await new Promise(r => setTimeout(r, 200));
    }
    if (!at) throw new Error(`nothing to click for ${selector}: ${JSON.stringify(await popupState())}`);
    await tab.mouse.move(at.x, at.y);
    await tab.mouse.click(at.x, at.y);
    await new Promise(r => setTimeout(r, 250));
  }
  async function pressKey(id) { await clickIn(`.dj-key[data-key="${id}"]`); }
  async function keyboard(key) { await tab.keyboard.press(key); await new Promise(r => setTimeout(r, 250)); }
  async function shot(name, extra = {}) {
    await settle();
    const fresh = await popupState();
    const pad = 28;
    const clip = { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad),
      width: Math.min(1000, fresh.rect.width + pad * 2), height: Math.min(760, fresh.rect.height + pad * 2) };
    // captureBeyondViewport would override the device metrics for the shot,
    // which the content script sees as a resize and may answer by hiding.
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip, captureBeyondViewport: false });
    if (!(await popupState())) { report.shots[`${name}:vanished`] = true; console.error(`[shot] ${name}: popup vanished after the screenshot`); }
    report.shots[name] = { ...fresh, ...extra };
    console.error(`[shot] ${name}: mode=${fresh.mode} cursor=${fresh.cursorIndex} ${fresh.cursorText ?? ""}`);
    return fresh;
  }

  // ---- default theme ----
  await hoverWord("verb", s => s.term > 0);
  await shot("default-term");
  await clickIn(".gsm-hoshidicts-kanji-link");
  await waitFor(s => s.kanji > 0);
  await shot("default-kanji");
  await closePopup();
  const hasLong = Boolean(await hoverWord("w-toru", s => s.term > 0, { optional: true }));
  if (hasLong) { await shot("default-long"); await closePopup(); }

  // ---- 電子辞書 ----
  await writeOptions({ popupTheme: "denshi-jisho" });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "denshi-jisho", { timeout: 15_000 });
  // A few lookups first, so the メニュー history has something to show.
  for (const id of ["w-kanji", "w-yomu", "w-kimochi", "w-arigatou"]) {
    if (await hoverWord(id, s => s.term > 0 && s.device, { optional: true })) await closePopup();
  }

  await hoverWord("verb", s => s.term > 0 && s.device);
  await shot("dj-term-list");
  // Keyboard model: click the screen once (as a reader would), then only keys.
  await clickIn(".dj-title");
  await keyboard("ArrowDown");
  await shot("dj-term-down", { keyboard: "ArrowDown" });
  await keyboard("Enter");
  await shot("dj-term-detail", { keyboard: "Enter" });
  await keyboard("Backspace");
  await waitFor(s => s.mode === "list");
  await keyboard("ArrowUp");
  await pressKey("yaku");
  await shot("dj-term-yaku-off", { key: "訳" });
  await pressKey("yaku");
  await pressKey("jump");
  await shot("dj-term-jump", { key: "ジャンプ" });
  await keyboard("ArrowRight");
  report.shots["dj-term-jump-right"] = await popupState();
  await keyboard("ArrowLeft");
  await keyboard("Enter");
  await waitFor(s => s.kanji > 0 && s.device);
  await shot("dj-kanji", { keyboard: "Enter in ジャンプ" });
  report.kanjiWatch = [];
  for (let i = 0; i < 12; i += 1) {
    const state = await popupState();
    const focus = await tab.evaluate(() => {
      const host = document.querySelector("hachidori-host");
      const active = host?.shadowRoot?.activeElement;
      return { page: document.activeElement?.tagName, shadow: active ? `${active.tagName}.${active.className}` : null,
        popupHidden: host?.shadowRoot?.querySelector(".gsm-hoshidicts-popup")?.hidden };
    });
    report.kanjiWatch.push({ t: i * 250, alive: Boolean(state), mode: state?.mode, ...focus });
    if (!state) break;
    await new Promise(r => setTimeout(r, 250));
  }
  console.error(`[watch] ${JSON.stringify(report.kanjiWatch)}`);
  // 決定 on the kanji screen unfolds every index number the dictionary carries.
  await keyboard("Enter");
  if ((await popupState())?.mode === "detail") {
    await shot("dj-kanji-indices", { keyboard: "Enter on the 漢字辞典 screen" });
    await keyboard("Backspace");
    await waitFor(s => s.mode === "list");
  }
  await pressKey("menu");
  await waitFor(s => s.mode === "menu");
  await shot("dj-menu", { key: "メニュー" });
  // backlight off through the menu, then look at the kanji screen unlit
  const backlightItem = await point('.dj-menu-item[data-menu="backlight"]');
  await tab.mouse.click(backlightItem.x, backlightItem.y);
  await new Promise(r => setTimeout(r, 500));
  await pressKey("menu");
  await waitFor(s => s.mode !== "menu" && s.backlight === "off");
  await shot("dj-kanji-backlight-off", { menu: "バックライト OFF" });
  await pressKey("menu");
  await tab.mouse.click(backlightItem.x, backlightItem.y);
  await new Promise(r => setTimeout(r, 500));
  await pressKey("menu");
  await waitFor(s => s.mode !== "menu" && s.backlight === "on");
  // 戻る returns to the word; the cursor position is remembered.
  await pressKey("back");
  await waitFor(s => s.term > 0 && s.device);
  await shot("dj-term-back", { key: "戻る" });
  await closePopup();

  // A long, multi-sense entry (取る in JMdict has dozens of senses).
  if (hasLong) {
    await hoverWord("w-toru", s => s.term > 0 && s.device);
    await shot("dj-long-list");
    await clickIn(".dj-title");
    await keyboard("Enter");
    await shot("dj-long-detail", { keyboard: "Enter" });
    await keyboard("PageDown");
    await shot("dj-long-detail-scrolled", { keyboard: "PageDown" });
    await closePopup();
  }

  // Audio key: the reader's own audio button is clicked (TTS is muted here).
  await hoverWord("verb", s => s.term > 0 && s.device);
  await pressKey("audio");
  await new Promise(r => setTimeout(r, 400));
  report.shots["dj-audio"] = await popupState();
  await closePopup();
} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ shots: Object.keys(report.shots), console: report.console.length }, null, 2));
