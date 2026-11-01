// jsdom helpers for the language-aware theme contract (docs/languages.md
// 11.7): a page with the reader's renderer scripts and a theme host, and
// renders through it. Run directly with `--record <extension dir> <file>` it
// records the single-profile markup of that build, which
// test/theme-languages.test.mjs compares with this build's (design 4.5).
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PACKS, SCENARIOS, THEMES } from "./theme-languages-fixtures.mjs";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
export const EXTENSION = resolve(import.meta.dirname, "../extension");
const LEGACY = new URL("./data/theme-languages/legacy-theme.mjs", import.meta.url);
const SCRIPTS = ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js", "language-text.js", "theme-host.js"];

export const settle = (ms = 0) => new Promise(done => setTimeout(done, ms));

// `catalogue` edits the theme catalogue as the host reads it: "undeclared"
// removes every language declaration (11.4).
export function languageDom(extension = EXTENSION, { page = { lang: "en", dir: "ltr" }, catalogue = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html lang="${page.lang}" dir="${page.dir}"><body><div id="host"></div></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.test/" });
  const { window } = dom;
  window.CSS = { highlights: new Map() };
  window.Highlight = class extends Set { constructor(...ranges) { super(ranges); } };
  for (const name of SCRIPTS) {
    let source;
    try { source = readFileSync(resolve(extension, name), "utf8"); } catch { continue; }
    window.eval(source);
  }
  const files = path => {
    if (path === "vendor/themes/legacy/theme.js") return fileURLToPath(LEGACY);
    return resolve(extension, path);
  };
  window.chrome = { runtime: { getURL: path => pathToFileURL(files(path)).href } };
  window.fetch = async url => {
    const path = fileURLToPath(url);
    let text = path.endsWith("/legacy/theme.css") ? "" : readFileSync(path, "utf8");
    if (path.endsWith("vendor/themes/index.json")) {
      const parsed = JSON.parse(text);
      parsed.themes.push({ slug: "legacy", name: "Legacy", designSettings: [] });
      if (catalogue === "undeclared") for (const theme of parsed.themes) delete theme.language;
      text = JSON.stringify(parsed);
    }
    return { ok: true, text: async () => text, json: async () => JSON.parse(text) };
  };
  window.HDLanguages = { get: code => PACKS[code] ?? null };
  return dom;
}

// The language of a scenario's profile, as content.js builds it once the
// records have profiles.
export function scenarioLanguage(window, scenario, packSettings = scenario.packSettings) {
  return window.HDThemeHost.createLanguage(PACKS[scenario.profile], { marked: true, packSettings,
    dictionaries: scenario.dictionaries, packFor: code => PACKS[code] ?? null });
}

export function renderContext(scenario, extra = {}) {
  return {
    dictionaryPresentation: scenario.dictionaries.map(({ title }) => ({ title, frequencyMode: "rank-based" })),
    dictionaryTabGroups: [], generation: 1, showFrequencyDictionaryNames: true,
    isCurrentRequest: () => true, isCurrentView: () => true, ...extra,
  };
}

// A view of `theme` in a shadow root, with the options content.js passes.
export async function themeView(dom, theme, { language, variant = "auto", onKanjiClick = () => {} } = {}) {
  const { window } = dom, { document } = window;
  const options = { ...window.HDReaderOptions.DEFAULT_OPTIONS, popupTheme: theme, popupThemeVariant: variant };
  if (theme === "legacy") window.HDReaderOptions.popupRenderer = value => value;
  const host = window.HDThemeHost.createThemeHost({ getOptions: () => options });
  const element = document.getElementById("host");
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
  host.attach(shadow);
  await host.sync();
  if (variant !== "auto") element.dataset.hoshidictsThemeVariant = variant;
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  shadow.append(popup);
  const bound = { rendered: null, expanded: [], clicks: [] };
  const view = host.createView({ document, window, popup, positionPopup() {},
    ...(language ? { language } : {}),
    appendExpressionRuby: window.HDGlossary.appendExpressionRuby,
    createPronunciationPitchAccent: window.HDGlossary.createPronunciationPitchAccent,
    appendTextOnlyGlossary: window.HDGlossary.appendTextOnlyGlossary,
    appendStructuredImage: window.HDGlossary.appendStructuredImage,
    parseTagList: window.HDGlossary.parseTagList, customButtons: [], idPrefix: `hoshidicts-${theme}`,
    onKanjiClick(...args) { bound.clicks.push(args[0]); onKanjiClick(...args); },
    onResultsRendered(value) { bound.rendered = value; },
    onResultsExpanded(value) { bound.expanded.push(value); },
  });
  return { host, view, popup, shadow, bound };
}

// Default fills later results' glossaries after a task and appends results
// over animation frames; text themes render at once.
export async function renderTerms(rendering, scenario, { language, results = scenario.results, extra = {} } = {}) {
  rendering.view.renderResults(results, { query: results[0].matched, sentence: results[0].matched, matchOffset: 0 },
    renderContext(scenario, { ...(language ? { language } : {}), ...extra }));
  await settle(50);
}

export async function renderCharacter(rendering, scenario, { language } = {}) {
  rendering.view.renderKanji(scenario.kanji, { query: scenario.kanji.character, sentence: scenario.kanji.character, matchOffset: 0 },
    renderContext(scenario, { ...(language ? { language } : {}), highlightText: scenario.kanji.character, onBack() {} }));
  await settle(50);
}

// Today's markup in the single-profile shape: every theme's term and
// character views of the Japanese fixture, with no language passed.
export async function singleProfileSnapshots(extension = EXTENSION) {
  const snapshots = {};
  const scenario = SCENARIOS.ja;
  const results = [scenario.results[0], { ...scenario.results[0], term: { ...scenario.results[0].term, expression: "食う", reading: "くう" } },
    { ...scenario.results[0], term: { ...scenario.results[0].term, expression: "たべる", reading: "たべる" } }];
  for (const theme of THEMES) {
    const dom = languageDom(extension, { page: { lang: "ja", dir: "ltr" } });
    try {
      const rendering = await themeView(dom, theme);
      await renderTerms(rendering, scenario, { results });
      await settle(300);
      const terms = rendering.popup.outerHTML;
      await renderCharacter(rendering, scenario);
      snapshots[theme] = { terms, character: rendering.popup.outerHTML };
      rendering.view.destroy();
    } finally { dom.window.close(); }
  }
  return snapshots;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--record") {
  const [, , , extension, output] = process.argv;
  writeFileSync(output, `${JSON.stringify(await singleProfileSnapshots(resolve(extension)), null, 1)}\n`);
  console.log(`recorded ${output}`);
}
