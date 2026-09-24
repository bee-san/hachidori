// Evidence for issue #334 (theme proposal "manga-vertical"): screenshots of the
// REAL popup (content script + real dictionaries) in the pinned Chrome for
// Testing, over a mokuro-style page with vertical text. Default theme vs the
// vendor/themes/manga-vertical prototype (and its -night twin). Not part of the
// test suite.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> DICTS="a.zip,b.zip,..." node capture-manga-vertical.mjs
//
// Needs the host prototype patch applied in <worktree> (docs/evidence/issue-330/
// theme-store/nazeka-js/host-prototype.patch plus the manga-vertical slugs and
// the proposed view.anchor) and both theme folders under extension/vendor/themes.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const DICTS = (process.env.DICTS || "").split(",").filter(Boolean).map(path => resolve(path));
if (DICTS.length === 0) throw new Error("DICTS= is required (comma-separated Yomitan zips)");
const PROFILE = "/tmp/manga-vertical-profile";
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const PAGE_HTML = readFileSync(resolve(HERE, "mokuro-page.html"), "utf8");
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const THEME_OPTIONS = {   // theme.yaml `options:` — the one-shot suggestions the Store would apply on "Use this theme"
  popupWidthPx: 320, popupHeightPx: 560, popupOpacityPercent: 100, popupColumns: 1,
  popupToolbarPosition: "top", showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3,
  showPitchAccentBadge: false,
};
const DEFAULT_OPTIONS = {  // what the theme's options replace; the reader's defaults (reader-options.js)
  popupWidthPx: 560, popupHeightPx: 420, popupOpacityPercent: 85, popupColumns: 1,
  popupToolbarPosition: "auto", showCompactDefinitionSummary: false, compactDefinitionSummaryCount: 3,
  showPitchAccentBadge: true,
};
const VIEWPORT = { width: 1180, height: 920 };

const report = {
  chrome: null,
  extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  dictionaries: DICTS, viewport: VIEWPORT, themeOptions: THEME_OPTIONS, shots: {}, checks: {},
};
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE, protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
const warnings = [];
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;

  // ---- import the dictionaries through Settings → Add dictionaries ----------
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
  await (await settings.$("#import-file")).uploadFile(...DICTS);
  report.importState = await settings.waitForFunction(count => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith(`Finished ${count} of ${count}`) ? text : false;
  }, { timeout: 600_000, polling: 500 }, DICTS.length).then(h => h.jsonValue());
  report.importSeconds = (Date.now() - importStarted) / 1000;
  report.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
  console.error(`[import] ${report.importState} in ${report.importSeconds}s`);
  for (const line of report.importDetail) console.error(`[import detail] ${line}`);
  if (!report.importState.includes(`${DICTS.length} imported, 0 failed`)) throw new Error(`import failed: ${report.importState}`);

  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  // A plain hover opens the popup; lookup counts on so the theme's page memory
  // and the reader's own count can be told apart in the shots.
  await writeOptions({ lookupMode: "hover", hoverDelayMs: 0, showLookupCounts: true });
  // Favourite Jitendex, as a reader with a main dictionary would: the popup
  // then shows dictionary tabs (All / Jitendex), which the theme sets as a
  // thumb index. Same CAS write Settings uses for the star (settings.js).
  report.favourite = await settings.evaluate(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const dictionaries = dictionaryState.dictionaries.map(d => d.title.startsWith("Jitendex") ? { ...d, favorite: true } : d);
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: dictionaryState.revision, dictionaries, groups: dictionaryState.groups });
    if (!reply.ok) throw new Error(reply.error);
    return reply.state.dictionaries.filter(d => d.favorite).map(d => d.title);
  });
  console.error(`[favourite] ${JSON.stringify(report.favourite)}`);

  // ---- the manga page ---------------------------------------------------
  const tab = await browser.newPage();
  tab.on("console", message => {
    const text = message.text();
    if (/hachidori/u.test(text)) warnings.push(text);
    console.error(`[tab console ${message.type()}] ${text}`);
  });
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  await tab.setViewport({ ...VIEWPORT, deviceScaleFactor: 2 });
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1200));
  const cdp = await tab.createCDPSession();

  const popupState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const style = getComputedStyle(popup);
    const q = selector => popup.querySelector(selector);
    const text = node => node?.textContent.replace(/\s+/g, " ").trim() ?? null;
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      writingMode: style.writingMode,
      background: style.backgroundColor,
      color: style.color,
      fontFamily: style.fontFamily.split(",")[0],
      transition: style.transitionDuration,
      tail: { display: style.getPropertyValue("--theme-tail-display").trim() || null,
        x: style.getPropertyValue("--theme-tail-x").trim() || null, y: style.getPropertyValue("--theme-tail-y").trim() || null,
        origin: style.getPropertyValue("--theme-tail-origin").trim() || null },
      toolbar: !!q(":scope > .mv-toolbar"),
      toolbarButtons: [...(q(":scope > .mv-toolbar")?.querySelectorAll("button") ?? [])].map(b => b.getAttribute("aria-label") || b.textContent.trim()),
      history: [...popup.querySelectorAll(".mv-history-item")].map(text),
      surface: text(q(".mv-surface-word")),
      surfaceRuby: [...popup.querySelectorAll(".mv-surface-word ruby")].map(r => `${[...r.childNodes].filter(n => n.nodeName !== "RT").map(n => n.textContent).join("")}(${r.querySelector("rt")?.textContent})`),
      steps: text(q(".mv-surface-steps")),
      headwordRuby: [...(q(".gsm-hoshidicts-primary-header .gsm-hoshidicts-expression")?.querySelectorAll("ruby") ?? [])].length,
      headwordSize: q(".gsm-hoshidicts-expression") ? getComputedStyle(q(".gsm-hoshidicts-expression")).fontSize : null,
      glossSize: q(".gsm-hoshidicts-glossary-content") ? getComputedStyle(q(".gsm-hoshidicts-glossary-content")).fontSize : null,
      gist: [...popup.querySelectorAll(".gsm-hoshidicts-compact-definition-items > li")].map(text),
      tabs: [...popup.querySelectorAll(".gsm-hoshidicts-tab")].map(t => `${t.textContent.trim()}${t.getAttribute("aria-selected") === "true" ? "*" : ""}`),
      yomi: [...popup.querySelectorAll(".mv-yomi")].map(text),
      facts: [...popup.querySelectorAll(".mv-fact")].map(text),
      chromeHidden: q(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      contentScroll: q(".gsm-hoshidicts-content-scroll") ? { scrollWidth: q(".gsm-hoshidicts-content-scroll").scrollWidth, clientWidth: q(".gsm-hoshidicts-content-scroll").clientWidth } : null,
      activeElement: host.shadowRoot.activeElement ? `${host.shadowRoot.activeElement.tagName.toLowerCase()}.${host.shadowRoot.activeElement.className}`.slice(0, 80) : null,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  });
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popupState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)?.slice(0, 600)}`);
      await new Promise(r => setTimeout(r, 150));
    }
  };
  const settle = (ms = 420) => tab.evaluate(ms => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ms)))), ms);

  // The glyph to hover: the first character of `word` inside the mokuro text
  // box, located through a Range like the reader itself does.
  const glyphPoint = (boxId, word) => tab.evaluate((boxId, word) => {
    const box = document.getElementById(boxId);
    for (const p of box.matches("p") ? [box] : box.querySelectorAll("p")) {
      const node = p.firstChild;
      const offset = node.nodeValue.indexOf(word);
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset); range.setEnd(node, offset + 1);
      const r = range.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }
    throw new Error(`${word} not in #${boxId}`);
  }, boxId, word);

  async function hover(boxId, word, expect) {
    const point = await glyphPoint(boxId, word);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await tab.mouse.move(4, 4);
      await new Promise(r => setTimeout(r, 120));
      await tab.mouse.move(point.x, point.y);
      try { return { state: await waitFor(expect, 2500), point }; } catch (error) { console.error(`[hover ${word} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering ${word}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(4, 4);
    await new Promise(r => setTimeout(r, 500));
  }
  const inPopup = (selector, index = 0) => tab.evaluate((selector, index) => {
    const host = document.querySelector("hachidori-host");
    const node = host.shadowRoot.querySelectorAll(selector)[index];
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, selector, index);
  async function clickKanji(character, expect) {
    const point = await tab.waitForFunction(character => {
      const host = document.querySelector("hachidori-host");
      const link = [...host.shadowRoot.querySelectorAll(".gsm-hoshidicts-primary-header .gsm-hoshidicts-kanji-link")].find(b => b.textContent === character);
      if (!link) return false;
      const rect = link.getBoundingClientRect();
      return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : false;
    }, { timeout: 10_000, polling: 100 }, character).then(handle => handle.jsonValue()).catch(async error => {
      console.error(`[clickKanji ${character}] ${error.message}; popup: ${JSON.stringify(await popupState())?.slice(0, 500)}`);
      throw error;
    });
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
    return waitFor(expect);
  }
  // Every shot is the whole viewport: a CDP clip screenshot moves the visual
  // viewport for the capture, and the reader hides its popup on that scroll.
  // The clip is recorded and applied afterwards by compose.py.
  async function shot(name, { pad = 34, full = false, clipTo = null } = {}) {
    await settle();
    const fresh = await popupState();
    await tab.screenshot({ path: resolve(OUT, `${name}.png`) });
    let clip = null;
    if (!full) {
      const r = clipTo ?? fresh.rect;
      const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
      clip = { x, y, width: Math.min(VIEWPORT.width - x, r.x + r.width + pad - x), height: Math.min(VIEWPORT.height - y, r.y + r.height + pad - y) };
    }
    report.shots[name] = { ...fresh, clip };
    console.error(`[shot] ${name} ${JSON.stringify(fresh?.rect)} clip=${JSON.stringify(clip)}`);
    return fresh;
  }
  // The popup plus the bubble it points at, in one clip.
  const union = (a, b, pad = 30) => {
    const x = Math.min(a.x, b.x) - pad, y = Math.min(a.y, b.y) - pad;
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) + pad - x, height: Math.max(a.y + a.height, b.y + b.height) + pad - y };
  };
  const boxRect = boxId => tab.evaluate(boxId => {
    const r = document.getElementById(boxId).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, boxId);

  // ======================= default theme, reader defaults =======================
  // The host element is created lazily on the first lookup, so the theme is
  // checked on the popup state rather than awaited on the host.
  await writeOptions({ popupTheme: "auto", ...DEFAULT_OPTIONS });   // a fresh install: AUTO → light in headless Chrome
  let hovered = await hover("box1", "食", s => s.term > 0 && s.theme === "light");
  await shot("default-term-page", { full: true });
  await shot("default-term", { clipTo: union(hovered.state.rect, await boxRect("box1")) });
  await clickKanji("食", s => s.kanji > 0);
  await shot("default-kanji");
  await closePopup();
  hovered = await hover("box2", "掛", s => s.term > 0);
  await shot("default-long");
  await closePopup();

  // ======================= manga-vertical (light) ==============================
  await writeOptions({ popupTheme: "manga-vertical", ...THEME_OPTIONS });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "manga-vertical", { timeout: 15_000 });
  await new Promise(r => setTimeout(r, 800));   // theme.css + theme.js load once per page

  // Page memory: two earlier lookups before the headline word, one of them twice.
  await hover("box3", "逃", s => s.term > 0 && s.toolbar);
  await closePopup();
  await hover("box4", "読", s => s.term > 0 && s.toolbar);
  await closePopup();
  await hover("box3", "逃", s => s.term > 0 && s.toolbar);
  await closePopup();

  hovered = await hover("box1", "食", s => s.term > 0 && s.toolbar && s.surface);
  report.checks.termAnchor = hovered.point;
  await shot("theme-term-page", { full: true });
  await shot("theme-term", { clipTo: union(hovered.state.rect, await boxRect("box1")) });
  await shot("theme-term-popup", { pad: 26 });
  // Colours the a11y section reports, read from the live popup.
  report.checks.computedColors = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host.shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const pick = (selector, property = "color") => { const n = popup.querySelector(selector); return n ? getComputedStyle(n)[property] : null; };
    return {
      paper: getComputedStyle(popup).backgroundColor,
      ink: getComputedStyle(popup).color,
      furigana: pick(".gsm-hoshidicts-expression rt"),
      surfaceRest: pick(".mv-surface-rest"),
      steps: pick(".mv-surface-steps"),
      gist: pick(".gsm-hoshidicts-compact-definition-items > li"),
      cardTitle: pick(".gsm-hoshidicts-glossary-card-title"),
      gloss: pick(".gsm-hoshidicts-glossary-content"),
      tabText: pick('.gsm-hoshidicts-tab:not([aria-selected="true"])'),
      tabSelectedText: pick('.gsm-hoshidicts-tab[aria-selected="true"]'),
      tabSelectedBackground: pick('.gsm-hoshidicts-tab[aria-selected="true"]', "backgroundColor"),
      frequencyTag: pick(".gsm-hoshidicts-tag-frequency"),
      grammarTag: pick(".gsm-hoshidicts-primary-grammar-tag") ?? pick(".gsm-hoshidicts-tag-term"),
      pitchTag: pick(".gsm-hoshidicts-tag-pitch"),
      history: pick(".mv-history-item"),
      historyCount: pick(".mv-history-count"),
      toolbarBackground: pick(".mv-toolbar", "backgroundColor"),
      toolbarButton: pick(".mv-toolbar button"),
      toolbarButtonBackground: pick(".mv-toolbar button", "backgroundColor"),
      lookupStats: pick(".gsm-hoshidicts-lookup-stats"),
    };
  });
  // Hover state: the kanji you can click turns 朱 and its marker solid.
  const kanjiLink = await inPopup(".gsm-hoshidicts-primary-header .gsm-hoshidicts-kanji-link");
  await tab.mouse.move(kanjiLink.x, kanjiLink.y);
  await settle(200);
  report.checks.kanjiLinkHoverColor = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const link = host.shadowRoot.querySelector(".gsm-hoshidicts-primary-header .gsm-hoshidicts-kanji-link");
    return { color: getComputedStyle(link).color, borderLeft: getComputedStyle(link).borderLeft };
  });
  await shot("theme-hover-kanji", { pad: 26 });
  // Scrolled: the glosses continue to the left, the way a page does.
  await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const scroll = host.shadowRoot.querySelector(".gsm-hoshidicts-content-scroll");
    scroll.scrollLeft = -scroll.clientWidth;   // one screen of columns to the left: the first dictionary card
  });
  report.checks.scrolledLeft = await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-content-scroll").scrollLeft);
  await shot("theme-term-scrolled", { pad: 26 });
  // Keyboard: Tab moves focus through the popup; the toolbar's round buttons
  // show a 朱 focus ring.
  await tab.mouse.move(hovered.point.x, hovered.point.y);
  await settle(200);
  const focusTrail = [];
  for (let i = 0; i < 6; i += 1) {
    await tab.keyboard.press("Tab");
    await new Promise(r => setTimeout(r, 80));
    const active = await tab.evaluate(() => {
      const host = document.querySelector("hachidori-host");
      const a = host.shadowRoot.activeElement;
      return a ? `${a.tagName.toLowerCase()}.${a.className.split(" ")[0]}${a.getAttribute("aria-label") ? ` (${a.getAttribute("aria-label")})` : ""}` : null;
    });
    focusTrail.push(active);
    if (active?.includes("note-button")) break;
  }
  report.checks.focusTrail = focusTrail;
  await shot("theme-focus-toolbar", { pad: 26 });
  // Note form: opens as a horizontal panel between the headword and the glosses.
  const noteButton = await inPopup(".mv-toolbar .gsm-hoshidicts-note-button");
  await tab.mouse.click(noteButton.x, noteButton.y);
  await tab.waitForFunction(() => !document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-note-form")?.hidden, { timeout: 5000 });
  report.checks.noteForm = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const form = host.shadowRoot.querySelector(".gsm-hoshidicts-note-form");
    const popup = form.closest(".gsm-hoshidicts-popup");
    return { writingMode: getComputedStyle(form).writingMode, order: [...popup.children].map(c => c.className.split(" ")[0]),
      term: form.querySelector(".gsm-hoshidicts-note-term").value, reading: form.querySelector(".gsm-hoshidicts-note-reading").value };
  });
  await shot("theme-note-form", { pad: 26 });
  await tab.keyboard.press("Escape");   // closes the form first (draft ownership), popup stays
  await settle(200);
  // Dictionary tabs: the thumb index; select the second dictionary.
  const secondTab = await inPopup(".gsm-hoshidicts-tab", 1);
  if (secondTab) {
    await tab.mouse.click(secondTab.x, secondTab.y);
    await waitFor(s => s.tabs.some((t, i) => i === 1 && t.endsWith("*")));
    await shot("theme-tab-switched", { pad: 26 });
    const firstTab = await inPopup(".gsm-hoshidicts-tab", 0);
    await tab.mouse.click(firstTab.x, firstTab.y);
    await waitFor(s => s.tabs[0]?.endsWith("*"));
  }
  // Kanji view: 音・訓, 画数・学年・頻度・旧JLPT, the practice square; Back is
  // focused by the reader, so its ring shows in the toolbar.
  await clickKanji("食", s => s.kanji > 0 && s.yomi.length > 0);
  await shot("theme-kanji", { pad: 26 });
  await shot("theme-kanji-page", { full: true });
  // Back re-renders the term view; the hook runs again and page memory is unchanged.
  const back = await inPopup(".mv-toolbar .gsm-hoshidicts-kanji-back");
  await tab.mouse.click(back.x, back.y);
  report.shots["theme-back"] = await waitFor(s => s.term > 0 && s.toolbar && s.surface);
  await closePopup();

  // A godan te-form in the bottom-left bubble: 読んで → 読む keeps 読(よ), the
  // changed kana んで are set in 藍.
  hovered = await hover("box4", "読", s => s.term > 0 && s.toolbar && s.surface);
  await shot("theme-te-form", { clipTo: union(hovered.state.rect, await boxRect("box4")) });
  await closePopup();

  // The long entry: 掛ける (Jitendex, ~two dozen senses) as a vertical column.
  hovered = await hover("box2", "掛", s => s.term > 0 && s.toolbar);
  await shot("theme-long", { clipTo: union(hovered.state.rect, await boxRect("box2")) });
  await shot("theme-long-page", { full: true });
  await closePopup();

  // Placement to the left of the word (a narrower window): the tail moves to
  // the right edge; the reading order inside the bubble does not change.
  await tab.setViewport({ width: 860, height: VIEWPORT.height, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 400));
  hovered = await hover("box1", "食", s => s.term > 0 && s.toolbar && s.rect.x < 400);
  report.checks.leftPlacement = { popup: hovered.state.rect, tail: hovered.state.tail };
  await shot("theme-term-left-page", { full: true });
  await closePopup();
  await tab.setViewport({ ...VIEWPORT, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 400));

  // Reduced motion: the pop-in transition is off.
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  hovered = await hover("box1", "食", s => s.term > 0 && s.toolbar);
  report.checks.reducedMotionTransition = hovered.state.transition;
  await closePopup();
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] });

  // Without the proposed view.anchor (today's API): no tail, plain bubble.
  await tab.evaluate(() => document.documentElement.setAttribute("data-hd-theme-no-anchor", ""));
  hovered = await hover("box1", "食", s => s.term > 0 && s.toolbar);
  await shot("theme-term-no-anchor", { clipTo: union(hovered.state.rect, await boxRect("box1")) });
  await closePopup();
  await tab.evaluate(() => document.documentElement.removeAttribute("data-hd-theme-no-anchor"));

  // A horizontal page: the same theme on a VN-style line (tail on the top edge).
  await tab.evaluate(() => {
    const line = document.createElement("p");
    line.id = "horizontal";
    line.textContent = "夕方には駅前で待ち合わせて、いっしょに帰ろうと約束した。";
    line.style.cssText = "position:absolute;left:40px;top:22px;margin:0;font:22px/1.6 'Noto Sans CJK JP',sans-serif;color:#141414;background:#fbf8f1;padding:4px 10px;border:2px solid #141414;z-index:5";
    document.body.appendChild(line);
  });
  hovered = await hover("horizontal", "約束", s => s.term > 0 && s.toolbar);
  await shot("theme-horizontal-page", { full: true });
  await closePopup();
  await tab.evaluate(() => document.getElementById("horizontal").remove());

  // ======================= manga-vertical-night ===============================
  await tab.evaluate(() => document.body.classList.add("night"));
  await writeOptions({ popupTheme: "manga-vertical-night" });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "manga-vertical-night", { timeout: 15_000 });
  await new Promise(r => setTimeout(r, 800));
  hovered = await hover("box1", "食", s => s.term > 0 && s.toolbar && s.surface);
  await shot("night-term-page", { full: true });
  await shot("night-term", { clipTo: union(hovered.state.rect, await boxRect("box1")) });
  report.checks.nightColors = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host.shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const pick = (selector, property = "color") => { const n = popup.querySelector(selector); return n ? getComputedStyle(n)[property] : null; };
    return { paper: getComputedStyle(popup).backgroundColor, ink: getComputedStyle(popup).color, furigana: pick(".gsm-hoshidicts-expression rt"),
      surfaceRest: pick(".mv-surface-rest"), steps: pick(".mv-surface-steps"), gist: pick(".gsm-hoshidicts-compact-definition-items > li"),
      cardTitle: pick(".gsm-hoshidicts-glossary-card-title"), gloss: pick(".gsm-hoshidicts-glossary-content"),
      tabText: pick('.gsm-hoshidicts-tab:not([aria-selected="true"])'), tabSelectedText: pick('.gsm-hoshidicts-tab[aria-selected="true"]'),
      tabSelectedBackground: pick('.gsm-hoshidicts-tab[aria-selected="true"]', "backgroundColor"), frequencyTag: pick(".gsm-hoshidicts-tag-frequency"),
      grammarTag: pick(".gsm-hoshidicts-primary-grammar-tag") ?? pick(".gsm-hoshidicts-tag-term"), pitchTag: pick(".gsm-hoshidicts-tag-pitch"),
      history: pick(".mv-history-item"), historyCount: pick(".mv-history-count"), toolbarBackground: pick(".mv-toolbar", "backgroundColor"),
      toolbarButton: pick(".mv-toolbar button"), toolbarButtonBackground: pick(".mv-toolbar button", "backgroundColor"), lookupStats: pick(".gsm-hoshidicts-lookup-stats") };
  });
  await clickKanji("食", s => s.kanji > 0 && s.yomi.length > 0);
  await shot("night-kanji", { pad: 26 });
  await closePopup();
} catch (error) {
  report.error = String(error?.stack || error);
  throw error;
} finally {
  await browser.close();
  server.close();
  report.hachidoriConsole = warnings;
  writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ shots: Object.keys(report.shots), checks: report.checks, warnings, error: report.error }, null, 2));
}
