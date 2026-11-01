// The language-aware theme contract in real Chrome (docs/languages.md 11.7):
// every vendored theme and Crystal variant, declared and with its
// declaration removed, on a left-to-right page and on an
// `<html lang="ar" dir="rtl">` page, measured by geometry. Run once on the
// current and once on the minimum Chrome (HACHIDORI_CHROME). The fonts must
// cover every sample (FONTCONFIG_FILE can point at a private fontconfig).
// Screenshots: test/tmp/languages/<chrome>/<theme>-<language>.png.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { PACKS, SCENARIOS, THEMES, VARIANTS } from "./theme-languages-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const executablePath = process.env.HACHIDORI_CHROME || resolve(root, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const chromeName = /linux-(\d+)\./u.exec(executablePath)?.[1] ?? "chrome";
const output = resolve(root, "test/tmp/languages", chromeName);
mkdirSync(output, { recursive: true });

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html" };
const SCRIPTS = ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js", "language-text.js", "theme-host.js"];

function catalogue(mode) {
  const parsed = JSON.parse(readFileSync(resolve(root, "extension/vendor/themes/index.json"), "utf8"));
  parsed.themes.push({ slug: "legacy", name: "Legacy", designSettings: [] });
  if (mode === "undeclared") for (const theme of parsed.themes) delete theme.language;
  return JSON.stringify(parsed);
}

// The page side: a shadow host as content.js creates it, a theme host, and
// measurements of what the theme drew.
function pageHarness() {
  const state = {};
  const assetUrl = mode => path => {
    if (path === "vendor/themes/index.json") return `/catalogue?mode=${mode}`;
    if (path.startsWith("vendor/themes/legacy/")) return `/legacy/${path.split("/").pop()}`;
    return `/extension/${path}`;
  };
  window.renderScenario = async ({ theme, variant, mode, profile, packs, scenario, packSettings, extra = {} }) => {
    globalThis.HDLanguages = { get: code => packs[code] ?? null };
    if (theme === "legacy") HDReaderOptions.popupRenderer = value => value;
    const options = { ...HDReaderOptions.DEFAULT_OPTIONS, popupTheme: theme, popupThemeVariant: variant,
      popupWidthPx: 560, popupHeightPx: 760 };
    document.getElementById("host")?.remove();
    const host = document.createElement("div");
    host.id = "host";
    host.style.cssText = ["all: initial !important", "position: fixed !important", "top: 0 !important", "left: 0 !important",
      "width: 0 !important", "height: 0 !important", "z-index: 2147483647 !important"].join("; ");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const appearance = HDPopup.createPopupAppearance(host);
    appearance.update(options);
    const themeHost = HDThemeHost.createThemeHost({ getOptions: () => options, assetUrl: assetUrl(mode) });
    themeHost.attach(shadow);
    await themeHost.sync();
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    Object.assign(popup.style, { left: "20px", top: "20px", width: "560px", height: "760px" });
    shadow.append(popup);
    const language = HDThemeHost.createLanguage(packs[profile], { marked: true, packSettings: packSettings ?? scenario.packSettings,
      dictionaries: scenario.dictionaries, packFor: code => packs[code] ?? null });
    const clicks = [];
    const view = themeHost.createView({ document, window, popup, language, positionPopup() {},
      appendExpressionRuby: HDGlossary.appendExpressionRuby, createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, appendStructuredImage: HDGlossary.appendStructuredImage,
      parseTagList: HDGlossary.parseTagList, customButtons: [], idPrefix: "languages",
      onKanjiClick: character => clicks.push(character), onResultsRendered() {}, onResultsExpanded() {} });
    const context = (more = {}) => ({ language, generation: 1, showFrequencyDictionaryNames: true,
      dictionaryPresentation: scenario.dictionaries.map(({ title }) => ({ title, frequencyMode: "rank-based" })),
      dictionaryTabGroups: [], isCurrentRequest: () => true, isCurrentView: () => true, onClose() {}, ...extra, ...more });
    Object.assign(state, { themeHost, view, popup, shadow, language, scenario, context, clicks, profile });
    view.renderResults(extra.results ?? scenario.results, { query: scenario.results[0].matched, sentence: scenario.results[0].matched, matchOffset: 0 },
      context());
    if (extra.showMore) {
      const button = popup.querySelector(".gsm-hoshidicts-show-more");
      state.showMorePressed = Boolean(button);
      button?.click();
    }
    await new Promise(done => setTimeout(done, 350));
    await document.fonts.ready;
    return themeHost.renderer;
  };
  window.renderCharacterView = async () => {
    const { view, scenario, context } = state;
    view.renderKanji(scenario.kanji ?? { character: "ك", frequencies: [], entries: [{ dictionary: scenario.dictionaries[0].title,
      onyomi: "", kunyomi: "", tags: "", definitions: ["كتابة"], stats: [] }] }, { query: "ك" }, context({ onBack() {}, onClose: undefined }));
    await new Promise(done => setTimeout(done, 100));
  };
  window.rerender = async (more = {}) => {
    const { view, scenario, context } = state;
    view.renderResults(more.results ?? scenario.results, { query: scenario.results[0].matched }, context(more));
    await new Promise(done => setTimeout(done, 350));
  };

  const rect = element => element.getBoundingClientRect();
  const isBlock = element => ["block", "list-item", "table-cell", "flow-root", "grid", "flex"].includes(getComputedStyle(element).display);
  const contentBox = element => {
    const box = rect(element), style = getComputedStyle(element);
    const number = name => Number.parseFloat(style[name]) || 0;
    return { left: box.left + number("borderLeftWidth") + number("paddingLeft"),
      right: box.right - number("borderRightWidth") - number("paddingRight") };
  };
  // Every occurrence of `text` in the popup: the text node, its offset and its line.
  function occurrences(text) {
    const found = [];
    const walker = document.createTreeWalker(state.popup, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let index = node.data.indexOf(text);
      while (index >= 0) {
        const lineStart = node.data.lastIndexOf("\n", index) + 1;
        const lineEnd = node.data.indexOf("\n", index + text.length);
        found.push({ node, index, lineStart, lineEnd: lineEnd < 0 ? node.data.length : lineEnd });
        index = node.data.indexOf(text, index + 1);
      }
    }
    return found;
  }
  const range = (node, start, end) => {
    const value = document.createRange();
    value.setStart(node, start);
    value.setEnd(node, end);
    return value;
  };
  const visible = rects => [...rects].filter(item => item.width > 0 && item.height > 0);

  // 11.7's geometry for one paragraph: its order (where its final period
  // sits on its line) and where its line starts in its block.
  window.measureParagraph = (text, textMode) => occurrences(text).map(({ node, index, lineStart, lineEnd }) => {
    const element = node.parentElement;
    const direction = getComputedStyle(element).direction;
    const own = /[\u0600-\u06FF]/u.test(text) && (text.match(/[\u0600-\u06FF]/gu).length * 2 > text.match(/\p{L}/gu).length) ? "rtl" : "ltr";
    const sentence = visible(range(node, index, index + text.length).getClientRects());
    let order = null;
    if (text.endsWith(".")) {
      const period = visible(range(node, index + text.length - 1, index + text.length).getClientRects()).at(-1);
      const line = sentence.filter(item => Math.abs(item.top - period.top) < 2);
      const left = Math.min(...line.map(item => item.left)), right = Math.max(...line.map(item => item.right));
      order = own === "rtl" ? period.left <= left + 1 : period.right >= right - 1;
    }
    let block = element;
    while (block && !isBlock(block)) block = block.parentElement;
    // The visual line the paragraph starts on, with everything the block
    // draws on it (a theme's label or a list marker included).
    let first = lineStart;
    while (first < lineEnd && /[\s\u2066-\u2069]/u.test(node.data[first])) first += 1;
    const firstRect = visible(range(node, first, first + 1).getClientRects())[0];
    const lineRects = [];
    const blockWalker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let text_ = blockWalker.nextNode(); text_; text_ = blockWalker.nextNode()) {
      for (const item of visible(range(text_, 0, text_.data.length).getClientRects())) {
        if (Math.abs(item.top + item.height / 2 - (firstRect.top + firstRect.height / 2)) < 3) lineRects.push(item);
      }
    }
    const box = contentBox(block);
    const blockDirection = getComputedStyle(block).direction;
    const lineLeft = Math.min(...lineRects.map(item => item.left)), lineRight = Math.max(...lineRects.map(item => item.right));
    const fallback = element.closest("[data-hd-fallback]")?.dataset.hdFallback ?? null;
    // Under unicode-bidi: plaintext each line takes its first strong character's direction.
    const strong = /[\p{L}]/u.exec(node.data.slice(lineStart, lineEnd))?.[0] ?? "";
    const startGap = (fallback === "plaintext" ? (/[\u0600-\u06FF]/u.test(strong) ? "rtl" : "ltr") : blockDirection) === "rtl"
      ? box.right - lineRight : lineLeft - box.left;
    return { text, own, direction, blockDirection, order, startGap: Math.round(startGap * 10) / 10, textMode, fallback,
      firstStrong: /[\u0600-\u06FF]/u.test(strong) ? "rtl" : "ltr", lang: element.closest("[lang]")?.getAttribute("lang") ?? null };
  });

  // List markers and sense numbers: room on each item's start side inside its card.
  window.measureMarkers = theme => {
    const results = [];
    if (theme === "crystal") {
      for (const sense of state.popup.querySelectorAll(".crystal-senses:not([data-count='1']) > .crystal-sense")) {
        const direction = getComputedStyle(sense).direction;
        const content = sense.firstElementChild;
        const gutter = direction === "rtl" ? rect(sense).right - rect(content).right : rect(content).left - rect(sense).left;
        results.push({ direction, gutter: Math.round(gutter), kind: "diamond" });
      }
      return results;
    }
    const card = item => item.closest(".gsm-hoshidicts-glossary-card, .bee-rich-content, .jl-entry") ?? state.popup;
    for (const item of state.popup.querySelectorAll(".gsm-hoshidicts-definitions li")) {
      const style = getComputedStyle(item);
      if (style.display !== "list-item" || style.listStyleType === "none" || rect(item).width === 0) continue;
      const box = contentBox(card(item));
      const direction = style.direction;
      const gutter = direction === "rtl" ? box.right - rect(item).right : rect(item).left - box.left;
      results.push({ direction, gutter: Math.round(gutter), kind: style.listStyleType, text: item.textContent.slice(0, 20) });
    }
    return results;
  };

  window.measureTrail = theme => {
    if (theme === "default") {
      const [matched, lemma] = [...state.popup.querySelectorAll(".gsm-hoshidicts-deinflection-endpoint")].map(rect);
      return matched && lemma ? { ok: matched.left < lemma.left } : null;
    }
    const trail = state.popup.querySelector(".jl-deconj, .crystal-deconj");
    if (!trail?.firstElementChild || !trail.lastChild || trail.lastChild.nodeType !== 3) return null;
    const process = visible(range(trail.lastChild, 1, trail.lastChild.data.length).getClientRects())[0];
    return { ok: rect(trail.firstElementChild).left < process.left };
  };

  window.measureFrequencies = (name, value) => {
    for (const { node, index } of occurrences(name)) {
      const nameRect = range(node, index, index + name.length).getBoundingClientRect();
      const tag = node.parentElement.closest(".gsm-hoshidicts-tag-frequency, .jl-frequency");
      if (!tag) continue;
      const values = occurrences(value).filter(item => tag.contains(item.node));
      if (!values.length) continue;
      const valueRect = range(values[0].node, values[0].index, values[0].index + value.length).getBoundingClientRect();
      return { after: valueRect.left >= nameRect.right - 1, gap: Math.round(valueRect.left - nameRect.right), sameLine: Math.abs(valueRect.top - nameRect.top) < 6 };
    }
    return null;
  };

  window.measureSpacing = () => {
    const spaced = [];
    for (const element of state.popup.querySelectorAll("*")) {
      const own = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.data).join("");
      if (/[\u0600-\u06FF]/u.test(own) && getComputedStyle(element).letterSpacing !== "normal") {
        spaced.push(`${element.className}: ${getComputedStyle(element).letterSpacing}`);
      }
    }
    return spaced;
  };

  // The interface: Close, Back and the first tab, relative to the popup, and
  // whether it reads in the page's language.
  window.measureInterface = pageLanguage => {
    const popupRect = rect(state.popup);
    const position = selector => {
      const element = state.popup.querySelector(selector);
      if (!element) return null;
      const box = rect(element);
      return { x: Math.round(box.left - popupRect.left), y: Math.round(box.top - popupRect.top),
        w: Math.round(box.width), h: Math.round(box.height), pageLanguage: element.matches(`:lang(${pageLanguage})`),
        english: element.matches(":lang(en)") };
    };
    return { close: position(".gsm-hoshidicts-popup-close"), back: position(".gsm-hoshidicts-kanji-back"),
      tab: position(".gsm-hoshidicts-tab, .jl-tab, .crystal-tab") };
  };

  window.nativeAsEnglish = pattern => {
    const found = [];
    const expression = new RegExp(pattern, "u");
    const walker = document.createTreeWalker(state.popup, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (expression.test(node.data) && node.parentElement.matches(":lang(en)")) found.push(node.data.slice(0, 30));
    }
    return found;
  };

  window.mixedLists = () => [...state.popup.querySelectorAll("[data-hd-mixed-list]")].map(list => ({
    start: getComputedStyle(list).paddingInlineStart, end: list.style.paddingInlineEnd }));
  window.popupBox = () => { const box = rect(state.popup); return { x: box.left, y: box.top, width: box.width, height: box.height }; };
  window.clickFirstCharacter = () => { state.popup.querySelector(".gsm-hoshidicts-kanji-link")?.click(); return state.clicks.length; };
  window.selectTab = label => {
    const tab = [...state.popup.querySelectorAll(".gsm-hoshidicts-tab")].find(item => item.textContent === label);
    tab?.click();
    return Boolean(tab);
  };
  window.showMorePressed = () => state.showMorePressed === true;
}

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const send = (body, type) => { response.setHeader("Content-Type", type); response.end(body); };
  try {
    if (url.pathname === "/page") {
      const lang = url.searchParams.get("lang"), dir = url.searchParams.get("dir");
      send(`<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><style>body{font:16px sans-serif;margin:0}</style>
${SCRIPTS.map(name => `<script src="/extension/${name}"></script>`).join("\n")}<script src="/harness.js"></script></head>
<body><p>Page text in the page's language.</p></body></html>`, "text/html; charset=utf-8");
    } else if (url.pathname === "/harness.js") send(`(${pageHarness})();`, "text/javascript");
    else if (url.pathname === "/catalogue") send(catalogue(url.searchParams.get("mode")), "application/json");
    else if (url.pathname === "/legacy/theme.js") send(readFileSync(resolve(root, "test/data/theme-languages/legacy-theme.mjs")), "text/javascript");
    else if (url.pathname === "/legacy/theme.css") send("", "text/css");
    else if (url.pathname.startsWith("/extension/")) {
      const path = resolve(root, "extension", decodeURIComponent(url.pathname.slice("/extension/".length)));
      if (!path.startsWith(resolve(root, "extension"))) throw new Error("outside the extension");
      send(readFileSync(path), TYPES[extname(path)] ?? "application/octet-stream");
    } else { response.statusCode = 404; response.end(); }
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

// Families that cover a sample's script, by fontconfig.
const covering = character => new Set(execFileSync("fc-list", ["--format", "%{family}\n",
  `:charset=${character.codePointAt(0).toString(16)}`], { encoding: "utf8" }).split(/[\n,]/u).map(name => name.trim()).filter(Boolean));
const SAMPLES = { ar: "ك", ja: "食", ko: "학", zh: "学", en: "r" };
const coverage = Object.fromEntries(Object.entries(SAMPLES).map(([code, character]) => [code, covering(character)]));

const runs = [...THEMES.flatMap(theme => (VARIANTS[theme] ?? ["auto"]).map(variant => ({ theme, variant }))), { theme: "legacy", variant: "auto" }];
const RICH = new Set(["default", "bee", "crystal"]);
const TEXT_MODE = new Set(["jl", "nazeka", "plain", "legacy"]);
const PAGES = { ltr: { lang: "en", dir: "ltr" }, rtl: { lang: "ar", dir: "rtl" } };
const current = Number(chromeName) >= 152;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const browser = await puppeteer.launch({ executablePath, headless: true,
  args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox", "--font-render-hinting=none"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", error => check(`page error: ${error.message}`, false));
  await page.setViewport({ width: 1000, height: 820 });
  const client = await page.createCDPSession();
  const interfaces = new Map();
  for (const { theme, variant } of runs) {
    const label = variant === "auto" ? theme : `${theme}-${variant}`;
    const modes = theme === "legacy" ? ["undeclared"] : ["declared", "undeclared"];
    for (const mode of modes) {
      for (const [pageName, pageDirection] of Object.entries(PAGES)) {
        const profiles = pageName === "rtl" ? ["ar"] : ["ja", "en", "ar", "ko"];
        for (const profile of profiles) {
          const scenario = SCENARIOS[profile];
          const page_ = profile === "ja" && pageName === "ltr" ? { lang: "ja", dir: "ltr" } : pageDirection;
          await page.goto(`${origin}/page?lang=${page_.lang}&dir=${page_.dir}`);
          const renderer = await page.evaluate(config => window.renderScenario(config),
            { theme, variant, mode, profile, packs: PACKS, scenario });
          const id = `${chromeName} ${label} ${mode} ${pageName} ${profile}`;
          check(`${id}: renders`, renderer === theme, `renderer ${renderer}`);
          // Fonts: headless Chrome draws a missing glyph as empty space.
          if (theme !== "plain") {
            await client.send("DOM.enable");
            await client.send("CSS.enable");
            const { root: documentNode } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
            const hostNode = (function find(node) {
              if (node.attributes?.includes("id") && node.attributes[node.attributes.indexOf("id") + 1] === "host") return node;
              for (const child of node.children ?? []) { const found = find(child); if (found) return found; }
              return null;
            })(documentNode);
            const shadowId = hostNode.shadowRoots[0].nodeId;
            const { nodeIds } = await client.send("DOM.querySelectorAll", { nodeId: shadowId, selector: ".gsm-hoshidicts-expression" });
            const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId: nodeIds[0] });
            const covered = fonts.some(font => coverage[profile].has(font.familyName));
            check(`${id}: a font covers the headword`, covered, fonts.map(font => font.familyName).join(", "));
          }
          // The interface does not read in the page's language.
          const ui = await page.evaluate(language => window.measureInterface(language), page_.lang);
          if (ui.close) check(`${id}: Close reads in English, not the page's language`, ui.close.english && (page_.lang === "en" || !ui.close.pageLanguage));
          interfaces.set(`${label} ${mode} ${pageName} ${profile}`, ui);
          // Text in the profile's own non-Latin script never reads as English.
          const native = { ja: "[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}]", ar: "\\p{Script=Arabic}", ko: "[\\p{Script=Hangul}\\p{Script=Han}]" }[profile];
          if (native) {
            const english = await page.evaluate(pattern => window.nativeAsEnglish(pattern), native);
            check(`${id}: no ${profile} text reads as English`, english.length === 0, english.join(" | "));
          }
          if (profile === "ar") {
            for (const [text] of scenario.expected) {
              if (!/[.]$/u.test(text) && !/[\u0600-\u06FF]/u.test(text)) continue;
              const measured = await page.evaluate((value, textMode) => window.measureParagraph(value, textMode), text, TEXT_MODE.has(theme));
              for (const item of measured) {
                // Without a declaration the claim is 11.4's: Arabic paragraphs read in
                // order and start on the right side, except where a plaintext row takes
                // the direction of the Latin text it begins with; a theme that knows no
                // languages gets direction only in right-to-left dictionaries.
                if (mode === "undeclared" && (item.own !== "rtl" || (item.fallback === "plaintext" && item.firstStrong !== "rtl")
                    || (theme === "legacy" && item.blockDirection !== "rtl"))) continue;
                if (item.order !== null) check(`${id}: "${text}" reads in its own order`, item.order, JSON.stringify(item));
                const ownDirection = item.direction === item.own;
                // A line in its block's direction starts at the block's start edge;
                // in core's structured-content renderer, on the current Chrome, so
                // does a paragraph of the other direction (11.2: not in text mode).
                if (item.blockDirection === item.own && (ownDirection || TEXT_MODE.has(theme))) {
                  check(`${id}: "${text}" starts at its block's start edge`, Math.abs(item.startGap) <= 2.5, JSON.stringify(item));
                } else if (RICH.has(theme) && current) {
                  check(`${id}: "${text}" keeps its own alignment`, Math.abs(item.startGap) <= 2.5, JSON.stringify(item));
                }
              }
            }
            if (theme !== "legacy") {
              for (const marker of await page.evaluate(name => window.measureMarkers(name), theme)) {
                check(`${id}: a ${marker.kind} marker sits inside its card on the ${marker.direction} start side`,
                  marker.gutter >= (marker.kind === "diamond" ? 26 : 14), JSON.stringify(marker));
              }
              for (const list of await page.evaluate(() => window.mixedLists())) {
                check(`${id}: a list of mixed direction pads its end as its start`, list.end === list.start, JSON.stringify(list));
              }
            }
            const trail = await page.evaluate(name => window.measureTrail(name), theme);
            if (trail) check(`${id}: the deinflection trail keeps the matched form first`, trail.ok);
            if (["default", "bee", "crystal", "jl"].includes(theme)) {
              for (const [name, value] of [["تردد الكلمات", "95"], ["Arabic Frequency", "312"]]) {
                const frequency = await page.evaluate((n, v) => window.measureFrequencies(n, v), name, value);
                if (frequency) check(`${id}: ${value} sits after its own name`, frequency.after && frequency.gap < 24 && frequency.sameLine, JSON.stringify(frequency));
              }
            }
            const spaced = await page.evaluate(() => window.measureSpacing());
            check(`${id}: joined Arabic text has no letter-spacing`, spaced.length === 0, spaced.join(" | "));
          }
          if (mode === "declared" && pageName === "ltr" && current) {
            const clip = await page.evaluate(() => window.popupBox());
            await page.screenshot({ path: resolve(output, `${label}-${profile}.png`), clip });
          }
          if (mode === "declared" && pageName === "ltr" && profile === "ar" && current) {
            const clip = await page.evaluate(() => window.popupBox());
            await page.goto(`${origin}/page?lang=ar&dir=rtl`);
            await page.evaluate(config => window.renderScenario(config), { theme, variant, mode, profile, packs: PACKS, scenario });
            await page.screenshot({ path: resolve(output, `${label}-ar-rtl-page.png`), clip });
          }
        }
      }
      // Close, Back and the tabs: the same on both pages and as in Japanese.
      const ltr = interfaces.get(`${label} ${mode} ltr ar`), rtl = interfaces.get(`${label} ${mode} rtl ar`);
      const japanese = interfaces.get(`${label} ${mode} ltr ja`);
      for (const part of ["close", "tab"]) {
        if (!ltr?.[part]) continue;
        const same = (a, b) => a && b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.h - b.h) <= 1;
        check(`${chromeName} ${label} ${mode}: ${part} is where it is on a left-to-right page`, same(ltr[part], rtl[part]),
          `${JSON.stringify(ltr[part])} ${JSON.stringify(rtl[part])}`);
        // Japanese headwords carry ruby, so only the side and size can match.
        const mirrored = (a, b) => a && b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
        if (part === "close") check(`${chromeName} ${label} ${mode}: ${part} is where it is in Japanese`, mirrored(ltr[part], japanese[part]),
          `${JSON.stringify(ltr[part])} ${JSON.stringify(japanese[part])}`);
      }
    }
  }
  // An undeclared theme outside Japanese: character clicks are ignored (11.4).
  for (const [profile, expected] of [["zh", 0], ["ja", 1]]) {
    await page.goto(`${origin}/page?lang=en&dir=ltr`);
    await page.evaluate(config => window.renderScenario(config), { theme: "legacy", variant: "auto", mode: "undeclared", profile, packs: PACKS, scenario: SCENARIOS[profile] });
    check(`${chromeName} legacy ${profile}: character clicks ${expected ? "work" : "are ignored"}`, await page.evaluate(() => window.clickFirstCharacter()) === expected);
  }
  // Default: a tab group, Back from the character view and Show more keep
  // the labels and the list padding (10.1).
  const arabic = SCENARIOS.ar;
  const second = { ...arabic.results[0], term: { ...arabic.results[0].term, expression: "كُتُب" } };
  await page.goto(`${origin}/page?lang=ar&dir=rtl`);
  await page.evaluate(config => window.renderScenario(config), { theme: "default", variant: "auto", mode: "declared", profile: "ar",
    packs: PACKS, scenario: arabic, extra: { results: [arabic.results[0], second], showMore: true,
      dictionaryTabGroups: [{ id: "g1", name: "Monolingual", dictionaries: ["المعجم الوسيط"] }] } });
  const steps = [];
  steps.push(["Show more", await page.evaluate(() => window.showMorePressed())]);
  steps.push(["tab group", await page.evaluate(() => window.selectTab("Monolingual"))]);
  await new Promise(done => setTimeout(done, 200));
  steps.push(["character view", await page.evaluate(async () => { await window.renderCharacterView(); return true; })]);
  steps.push(["Back", await page.evaluate(async () => { await window.rerender({ expandAll: true }); return true; })]);
  for (const [step, ran] of steps) {
    check(`${chromeName} default ar: ${step} ran`, ran === true);
  }
  const english = await page.evaluate(pattern => window.nativeAsEnglish(pattern), "\\p{Script=Arabic}");
  check(`${chromeName} default ar after Show more, a tab group and Back: no Arabic text reads as English`, english.length === 0, english.join(" | "));
  const lists = await page.evaluate(() => window.mixedLists());
  check(`${chromeName} default ar after Back: lists of mixed direction are padded`, lists.length > 0 && lists.every(list => list.end === list.start),
    JSON.stringify(lists));
  for (const marker of await page.evaluate(() => window.measureMarkers("default"))) {
    check(`${chromeName} default ar after Back: markers inside the card`, marker.gutter >= 14, JSON.stringify(marker));
  }
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter(item => !item.ok);
console.log(`${results.length - failed.length} passed, ${failed.length} failed (Chrome ${chromeName})${current ? `; screenshots in ${output}` : ""}`);
assert.equal(failed.length, 0, `${failed.length} language checks failed`);
assert.ok(results.length > 500, `only ${results.length} checks ran`);
