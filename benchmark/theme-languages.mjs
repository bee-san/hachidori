// The large-popup benchmark of docs/languages.md 19: render plus first layout
// of a 32-result popup of Jitendex-sized entries in every theme, before and
// after, in the single-profile shape and with a second profile (a marked
// Japanese language), on a Japanese page. Run it once with the system's fonts
// and once with FONTCONFIG_FILE naming a fontconfig that has the themes'
// named fonts (Noto Sans/Serif CJK JP, Noto Serif).
//
//   node benchmark/theme-languages.mjs OUTPUT BEFORE_CHECKOUT AFTER_CHECKOUT SAMPLE.json
//
// SAMPLE.json lists 32 or more `{ expression, reading, rules, glossary }`
// rows from a real Jitendex import (each glossary its JSON string), as
// benchmark/theme-languages-sample.mjs writes them. HACHIDORI_BENCH_CONDITIONS
// lists checkout:profile pairs, 0 the before checkout and 1 the after one
// (default 0:single,1:single,1:second).
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, loadavg, platform, release } from "node:os";
import { extname, resolve } from "node:path";

const [destination, before, after, samplePath] = process.argv.slice(2);
assert.ok(destination && before && after && samplePath, "usage: theme-languages.mjs OUTPUT BEFORE_CHECKOUT AFTER_CHECKOUT SAMPLE.json");
const require = createRequire(resolve(import.meta.dirname, "../test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const executablePath = process.env.HACHIDORI_CHROME
  || resolve(import.meta.dirname, "../test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const samples = Number(process.env.HACHIDORI_BENCH_SAMPLES ?? 15), warmups = 3;
const roots = [resolve(before), resolve(after)];
const rows = JSON.parse(readFileSync(samplePath, "utf8")).slice(0, 32);
assert.equal(rows.length, 32, "the sample needs 32 entries");
mkdirSync(resolve(destination), { recursive: true });

// Each result: its Jitendex entry and two monolingual entries of ordinary length.
const DICTIONARIES = [
  { title: "Jitendex.org [2026-10-03]", targetLanguage: "en" },
  { title: "大辞林 第四版", targetLanguage: "ja" },
  { title: "明鏡国語辞典 第三版", targetLanguage: "ja" },
];
const results = rows.map(row => ({ matched: row.expression, deinflected: row.expression, trace: [], preprocessorSteps: 0,
  term: { expression: row.expression, reading: row.reading, rules: row.rules, score: 0, frequencies: [], pitches: [],
    glossaries: [
      { dictionary: DICTIONARIES[0].title, glossary: row.glossary, definitionTags: row.rules, termTags: "" },
      { dictionary: DICTIONARIES[1].title, definitionTags: "", termTags: "", glossary: JSON.stringify([
        `${row.reading}【${row.expression}】①ある物事を行うこと。また、そのさま。「${row.expression}ことにする」`,
        "②人や物が、ある状態や場所にあるようにすること。「毎日のように使われる」"]) },
      { dictionary: DICTIONARIES[2].title, definitionTags: "", termTags: "", glossary: JSON.stringify([
        `〘動〙${row.expression}。日常の場面で広く用いる語。`]) },
    ] } }));
const THEMES = (process.env.HACHIDORI_BENCH_THEMES ?? "default,nazeka,plain,jl,bee,crystal").split(",");
const CONDITIONS = (process.env.HACHIDORI_BENCH_CONDITIONS ?? "0:single,1:single,1:second").split(",").map(pair => {
  const [checkout, profile] = pair.split(":");
  assert.ok(["0", "1"].includes(checkout) && ["single", "second"].includes(profile), `bad condition ${pair}`);
  return { checkout: Number(checkout), profile };
});
const SCRIPTS = ["reader-options.js", "external-links.js", "render/glossary.js", "render/popup.js", "language-text.js", "theme-host.js"];
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer((request, response) => {
  const [index, ...parts] = new URL(request.url, "http://localhost").pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><body><p>朝ごはんを食べる。</p>
${SCRIPTS.map(name => `<script src="/${index}/${name}"></script>`).join("")}</body></html>`);
    return;
  }
  try {
    const path = resolve(roots[Number(index)], "extension", ...parts.map(decodeURIComponent));
    response.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
    response.end(readFileSync(path));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

// In the page: one view per theme in a shadow host as content.js creates it;
// each sample renders the 32 results, forces layout and, for "complete",
// waits for deferred glossary fills, progressive results and the labelling
// pass before a final layout.
async function setUp(page, theme, profile) {
  return page.evaluate(async (theme, profile, dictionaries) => {
    const options = { ...HDReaderOptions.DEFAULT_OPTIONS, popupTheme: theme, popupWidthPx: 560, popupHeightPx: 760 };
    const host = document.createElement("div");
    host.style.cssText = "all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important";
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    HDPopup.createPopupAppearance(host).update(options);
    const themeHost = HDThemeHost.createThemeHost({ getOptions: () => options,
      assetUrl: path => new URL(path, document.querySelector("script").src).href });
    themeHost.attach(shadow);
    await themeHost.sync();
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    Object.assign(popup.style, { left: "20px", top: "20px", width: "560px", height: "760px" });
    shadow.append(popup);
    const language = profile === "second"
      ? HDThemeHost.createLanguage(null, { marked: true, dictionaries }) : undefined;
    // content.js's positionPopup: the first placement for a new word reads
    // the word's rectangle, which lays out the document, then sizes the popup.
    const anchor = document.querySelector("p");
    const positionPopup = () => {
      window.bench.placed ??= anchor.getBoundingClientRect();
      Object.assign(popup.style, { left: `${Math.round(window.bench.placed.left)}px`,
        top: `${Math.round(window.bench.placed.bottom + 8)}px`, width: "560px", height: "760px" });
    };
    const view = themeHost.createView({ document, window, popup, positionPopup, ...(language ? { language } : {}),
      appendExpressionRuby: HDGlossary.appendExpressionRuby, createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary, appendStructuredImage: HDGlossary.appendStructuredImage,
      parseTagList: HDGlossary.parseTagList, customButtons: [], idPrefix: "bench", onResultsRendered() {}, onResultsExpanded() {} });
    window.bench = { view, popup, language, positionPopup, placed: null, renderer: themeHost.renderer };
    return themeHost.renderer;
  }, theme, profile, DICTIONARIES);
}

async function sample(page) {
  return page.evaluate(async (results, dictionaries) => {
    const { view, popup, language, positionPopup } = window.bench;
    const context = { generation: 1, isCurrentRequest: () => true, isCurrentView: () => true,
      dictionaryPresentation: dictionaries.map(({ title }) => ({ title })), dictionaryTabGroups: [],
      ...(language ? { language } : {}) };
    view.clear();
    void popup.getBoundingClientRect();
    await new Promise(done => requestAnimationFrame(() => setTimeout(done, 0)));
    // As content.js: show() resets the scroll, renderTerms renders and places the popup.
    window.bench.placed = null;
    const start = performance.now();
    view.scrollElement.scrollTop = 0;
    view.renderResults(results, { query: results[0].matched, sentence: results[0].matched, matchOffset: 0 }, context);
    positionPopup();
    const script = performance.now() - start;
    void popup.scrollHeight;
    void popup.getBoundingClientRect();
    const first = performance.now() - start;
    // Deferred work: Default's fills and progressive results; every theme's labelling pass.
    let last = popup.querySelectorAll("*").length, stable = 0, frames = 0, changed = 0;
    while (stable < 3) {
      await new Promise(done => requestAnimationFrame(() => setTimeout(done, 0)));
      frames += 1;
      const count = popup.querySelectorAll("*").length;
      stable = count === last ? stable + 1 : 0;
      if (count !== last) changed = frames;
      last = count;
    }
    void popup.scrollHeight;
    const complete = performance.now() - start;
    return { first, script, layout: first - script, complete, elements: last, lastChangeFrame: changed };
  }, results, DICTIONARIES);
}

const summary = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
  return { n: sorted.length, median: Math.round(at(0.5) * 100) / 100, p90: Math.round(at(0.9) * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100 };
};

const browser = await puppeteer.launch({ executablePath, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"] });
const report = { environment: { startedAt: new Date().toISOString(), platform: platform(), release: release(), node: process.version,
  cpu: cpus()[0].model, logicalCpus: cpus().length, load: loadavg(), chrome: executablePath, fontconfig: process.env.FONTCONFIG_FILE ?? "system",
  samples, warmups, results: results.length,
  glossaryBytes: rows.reduce((total, row) => total + row.glossary.length, 0),
  checkouts: roots.map(root => ({ path: root, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() })),
  boundary: "content.js's show-render-place sequence, whose first placement reads the word's rectangle, then a forced layout (first); then until the popup stops changing, with a final layout (complete, wall time including frame waits). script is the sequence alone, layout the forced layout after it" },
  cells: [] };
try {
  for (const theme of THEMES) {
    const pages = [];
    for (const condition of CONDITIONS) {
      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 900 });
      await page.goto(`${origin}/${condition.checkout}/`);
      const renderer = await setUp(page, theme, condition.profile);
      assert.equal(renderer, theme, `${theme} rendered as ${renderer}`);
      pages.push({ page, condition, first: [], script: [], layout: [], complete: [], lastChangeFrame: [] });
    }
    // Interleave the conditions, rotating which goes first.
    for (let round = 0; round < warmups + samples; round++) {
      const order = pages.map((_, index) => (index + round) % pages.length);
      for (const index of order) {
        const entry = pages[index];
        await entry.page.bringToFront();
        const measured = await sample(entry.page);
        if (round >= warmups) for (const key of ["first", "script", "layout", "complete", "lastChangeFrame"]) entry[key].push(measured[key]);
      }
    }
    for (const { page, condition, first, script, layout, complete, lastChangeFrame } of pages) {
      const raw = values => values.map(value => Math.round(value * 100) / 100);
      report.cells.push({ theme, revision: condition.checkout === 0 ? "before" : "after", profile: condition.profile,
        first: summary(first), script: summary(script), layout: summary(layout), complete: summary(complete),
        rawFirst: raw(first), rawComplete: raw(complete), lastChangeFrame });
      await page.close();
    }
    const cells = report.cells.filter(cell => cell.theme === theme);
    console.log(theme, cells.map(cell => `${cell.revision}/${cell.profile} first ${cell.first.median} (script ${cell.script.median}, layout ${cell.layout.median}) complete ${cell.complete.median}`).join("; "));
  }
} finally {
  await browser.close();
  server.close();
}
const file = resolve(destination, `theme-languages-${report.environment.fontconfig === "system" ? "system-fonts" : "named-fonts"}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${file}`);
