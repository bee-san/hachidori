// Pixel-check monochrome dictionary images and word highlights (#520) in every
// popup palette and both emulated Windows contrast palettes through the real
// extension and importer.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
import { buildTitledZip, monochromeImageFixture } from "./make-fixture.mjs";
import "../extension/reader-options.js";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const chromeBuild = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8")).config.chrome;
const chrome = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${chromeBuild}/chrome-linux64/chrome`);
const filmstrip = process.env.HACHIDORI_THEME_CONTRAST_FILMSTRIP
  || resolve(root, "test/tmp/ci/theme-contrast.png");
const themes = globalThis.HDReaderOptions.POPUP_THEME_GROUPS.flatMap(group => group.themes.map(theme => theme.id));
const scenarios = [
  ...themes.map(theme => ({ name: theme, theme, scheme: "dark", forced: false })),
  { name: "forced colors dark", theme: "default", scheme: "dark", forced: true },
  { name: "forced colors light", theme: "default", scheme: "light", forced: true },
];
const fixture = monochromeImageFixture();
// One word per Anki status, marked on a light page and on a dark one: 学生 has
// no card, 先生 a card being learned and 漢字 a mature one.
const WORDS = { unknown: "学生", learning: "先生", known: "漢字" };
const STATUSES = Object.keys(WORDS);
const wordArchive = buildTitledZip("word-highlight-contrast",
  { terms: Object.values(WORDS).map((word, index) => [word, "", "", "", 1, [`word ${index + 1}`], index + 1, ""]) });
const CARDS = new Map([[1, WORDS.learning], [2, WORDS.known]]);
const MATURE = [2];
const WORD_PAGES = { light: { background: "#ffffff", text: "#1a1a1a" }, dark: { background: "#1e1e1e", text: "#e6e6e6" } };
const centre = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
const near = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.every((value, index) => Math.abs(value - right[index]) <= 3);
const luminance = pixel => pixel.map(value => value / 255)
  .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (first, second) => {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

async function sample(tab, points) {
  const png = await tab.screenshot({ encoding: "base64" });
  const pixels = await tab.evaluate(async ({ png, points }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / window.innerWidth;
    return points.map(({ x, y }) => [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)]);
  }, { png, points });
  return { png, pixels };
}

// Each status's line under its word: the colour it is drawn in (the owned
// sheet's, or HighlightText under forced colours), what it is drawn on, how
// much of the word it spans and in how many pieces (solid, dashed, dotted).
async function sampleWords(tab, theme, forced) {
  await tab.bringToFront();
  await tab.waitForFunction(expected => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === expected
    && ["unknown", "learning", "known"].every(status => CSS.highlights.get(`hd-word-${status}`)?.size > 0), {}, theme);
  await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await tab.screenshot({ encoding: "base64" });
  return tab.evaluate(async ({ png, forced, statuses }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / window.innerWidth;
    const paint = value => {
      const probe = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const rules = [...document.adoptedStyleSheets].flatMap(sheet => [...sheet.cssRules])
      .flatMap(rule => (rule.cssRules ? [...rule.cssRules] : [rule]));
    let forcedLine = null;
    if (forced) {
      const probe = document.createElement("span");
      probe.style.color = "HighlightText";
      document.documentElement.append(probe);
      forcedLine = paint(getComputedStyle(probe).color);
      probe.remove();
    }
    const close = (pixel, colour) => pixel.every((value, index) => Math.abs(value - colour[index]) <= 12);
    const result = {};
    for (const status of statuses) {
      const line = forcedLine
        ?? paint(rules.find(rule => rule.selectorText === `::highlight(hd-word-${status})`).style.textDecorationColor);
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(status));
      const rect = range.getBoundingClientRect();
      const left = Math.round(rect.left * scale);
      const width = Math.round(rect.width * scale);
      // The line lies in the bottom of the word's own box, which forced
      // colours fill with Highlight; below it is the page.
      const top = Math.round((rect.bottom - 16) * scale);
      const height = Math.round(16 * scale);
      const { data } = context.getImageData(left, top, width, height);
      const pixel = (x, y) => [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)];
      let best = { row: 0, coverage: -1, on: [] };
      for (let y = 0; y < height; y += 1) {
        const on = Array.from({ length: width }, (_, x) => close(pixel(x, y), line));
        const coverage = on.filter(Boolean).length / width;
        if (coverage > best.coverage) best = { row: y, coverage, on };
      }
      // What the line is drawn on: the commonest colour a little above it.
      const counts = new Map();
      for (let x = 0; x < width; x += 1) {
        const key = pixel(x, Math.max(0, best.row - Math.round(4 * scale))).join();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const under = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
      result[status] = { line, under, coverage: Number(best.coverage.toFixed(2)),
        pieces: best.on.filter((on, x) => on && !best.on[x - 1]).length };
    }
    const first = document.getElementById(statuses[0]).getBoundingClientRect();
    const last = document.getElementById(statuses.at(-1)).getBoundingClientRect();
    return { marks: result, viewport: window.innerWidth,
      rect: { left: first.left - 6, top: first.top - 2, width: last.right - first.left + 12, height: first.height + 6 } };
  }, { png, forced, statuses: STATUSES }).then(measured => ({ ...measured, png }));
}

function wordsPassed({ marks }) {
  const { unknown, learning, known } = marks;
  return STATUSES.every(status => marks[status].coverage >= 0.3 && contrast(marks[status].line, marks[status].under) >= 3)
    // Not by colour alone: one solid line, a dashed one, a dotted one.
    && unknown.pieces === 1 && learning.pieces > 1 && known.pieces > learning.pieces;
}

async function writeFilmstrip(tab, tiles) {
  const png = await tab.evaluate(async entries => {
    const columns = 6;
    const tileWidth = 220;
    const tileHeight = 190;
    const canvas = document.createElement("canvas");
    canvas.width = columns * tileWidth;
    canvas.height = Math.ceil(entries.length / columns) * tileHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "12px sans-serif";
    const draw = async (encoded, rect, x, y, width, height, viewport = window.innerWidth) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const scale = image.naturalWidth / viewport;
      context.drawImage(image, rect.left * scale, rect.top * scale,
        rect.width * scale, rect.height * scale, x, y, width, height);
    };
    for (const [index, tile] of entries.entries()) {
      const x = (index % columns) * tileWidth;
      const y = Math.floor(index / columns) * tileHeight;
      context.fillStyle = "#111";
      context.fillText(tile.name, x + 7, y + 15);
      await draw(tile.cardPng, tile.cardRect, x + 7, y + 23, 96, 96);
      await draw(tile.previewPng, tile.previewRect, x + 113, y + 23, 96, 96);
      // The word highlights, on the light page and then the dark one.
      for (const [row, words] of tile.words.entries()) {
        const width = Math.min(206, Math.round(28 * words.rect.width / words.rect.height));
        await draw(words.png, words.rect, x + 7, y + 126 + row * 32, width, 28, words.viewport);
      }
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, tiles);
  mkdirSync(dirname(filmstrip), { recursive: true });
  writeFileSync(filmstrip, Buffer.from(png, "base64"));
  console.log(`Filmstrip: ${filmstrip}`);
}

const profile = mkdtempSync(resolve(tmpdir(), "hachidori-theme-contrast-"));
const server = createServer(async (request, response) => {
  // Anki, as AnkiConnect answers the word status index's refresh.
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = await answerAnkiConnect(JSON.parse(body), async (action, params) => {
      if (action === "findNotes") return params.query.endsWith("prop:ivl>=21") ? MATURE : [...CARDS.keys()];
      if (action === "notesInfo") {
        return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [noteId],
          fields: { Front: { value: CARDS.get(noteId), order: 0 } } }));
      }
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelFieldNames") return ["Front", "Back"];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      throw new Error(`Unexpected Anki action ${action}`);
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  const page = WORD_PAGES[request.url.slice(1)];
  response.end(page
    ? `<!doctype html><meta charset="utf-8"><style>body{font:32px/2 sans-serif;padding:40px;margin:0;background:${page.background};color:${page.text}}</style>`
      + `<p id="words"><span id="unknown">${WORDS.unknown}</span>と<span id="learning">${WORDS.learning}</span>と<span id="known">${WORDS.known}</span></p>`
    : `<!doctype html><meta charset="utf-8"><style>body{font:32px sans-serif;padding:80px}</style><span id="word">${fixture.query}</span>`);
});
let browser;
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true, userDataDir: profile,
    args: [`--disable-extensions-except=${resolve(root, "extension")}`, `--load-extension=${resolve(root, "extension")}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"] });
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120_000);
  await settings.goto(`${extensionOrigin}/settings.html#add-dictionaries`);
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  for (const [name, archive] of [["theme-contrast.zip", fixture.archive], ["word-highlight-contrast.zip", wordArchive]]) {
    await settings.evaluate(async (base64, fileName) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      try {
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
          requestId: "theme-contrast-import", blobUrl, fileName });
        if (!reply.ok) throw new Error(reply.error);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }, archive.toString("base64"), name);
  }
  const writeOptions = patch => settings.evaluate(async next => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: next });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const { anki, experimental } = globalThis.HDReaderOptions.normaliseOptions({});
  await writeOptions({ hoverEnabled: true, lookupMode: "hover", popupTheme: "default",
    anki: { ...anki, url: `${origin}/anki`, model: "Basic", fields: { ...anki.fields, expression: "Front" } },
    experimental: { ...experimental, wordHighlighting: true },
    wordHighlightEnabled: true, wordHighlightKnown: true });
  const wordTabs = [];
  for (const name of Object.keys(WORD_PAGES)) {
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 200 });
    await page.goto(`${origin}/${name}`);
    wordTabs.push({ name, page, media: await page.createCDPSession() });
  }
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1100, height: 800 });
  await tab.goto(origin);
  const media = await tab.createCDPSession();
  const results = [];
  const tiles = [];
  let interrupted = null;
  try {
    for (const scenario of scenarios) {
      const expectedTheme = scenario.theme === "auto" ? scenario.scheme : scenario.theme;
      for (const session of [media, ...wordTabs.map(word => word.media)]) {
        await session.send("Emulation.setEmulatedMedia", { features: [
          { name: "prefers-reduced-motion", value: "reduce" },
          { name: "prefers-color-scheme", value: scenario.scheme },
          ...(scenario.forced ? [{ name: "forced-colors", value: "active" }] : []),
        ] });
      }
      await writeOptions({ popupTheme: scenario.theme });
      await tab.bringToFront();
      await tab.mouse.move(2, 2);
      await tab.keyboard.press("Escape");
      const point = await tab.$eval("#word", node => {
        const range = document.createRange();
        range.setStart(node.firstChild, 0);
        range.setEnd(node.firstChild, 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await tab.mouse.move(point.x, point.y);
      await tab.waitForFunction(theme => {
        const root = document.querySelector("hachidori-host")?.shadowRoot;
        const images = root?.querySelectorAll(".gloss-image-link img");
        return root?.host.dataset.hoshidictsTheme === theme && images?.length === 2
          && [...images].every(image => image.naturalWidth === 100);
      }, {}, expectedTheme);
      // Natural dimensions can be available before the CSS mask is painted.
      await tab.evaluate(async () => {
        await Promise.all([...document.querySelector("hachidori-host").shadowRoot.querySelectorAll(".gloss-image-link img")]
          .map(image => image.decode()));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const state = await tab.evaluate(() => {
        const root = document.querySelector("hachidori-host").shadowRoot;
        const popup = root.querySelector(".gsm-hoshidicts-popup");
        const images = [...root.querySelectorAll(".gloss-image-link img")];
        const colour = new OffscreenCanvas(1, 1).getContext("2d");
        colour.fillStyle = getComputedStyle(popup).color;
        colour.fillRect(0, 0, 1, 1);
        return { theme: root.host.dataset.hoshidictsTheme,
          textColor: [...colour.getImageData(0, 0, 1, 1).data.slice(0, 3)],
          rects: images.map(image => image.closest(".gloss-image-container").getBoundingClientRect().toJSON()) };
      });
      const cardRect = state.rects[0];
      const { png: cardPng, pixels: [ink, auto, background] } = await sample(tab, [
        ...state.rects.map(centre),
        { x: cardRect.left + cardRect.width * 0.04, y: cardRect.top + cardRect.height / 2 },
      ]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const imagePoint = centre(cardRect);
        if (attempt === 0) await tab.mouse.move(imagePoint.x, imagePoint.y);
        else await tab.$eval("hachidori-host", host => host.shadowRoot.querySelector(".gloss-image-link").focus());
        try {
          await tab.waitForFunction(() => {
            const preview = document.querySelector("hachidori-host")?.shadowRoot
              ?.querySelector(".gsm-hoshidicts-image-hover-preview");
            return preview?.querySelector("img")?.naturalWidth === 100;
          }, { timeout: 7500 });
          break;
        } catch (error) {
          if (attempt === 1) throw new Error(`${scenario.name}: preview did not open`, { cause: error });
          await tab.mouse.move(2, 2);
          await tab.mouse.move(point.x, point.y);
          await tab.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot
            ?.querySelectorAll(".gloss-image-link img")?.length === 2);
        }
      }
      const preview = await tab.evaluate(() => {
        const node = document.querySelector("hachidori-host").shadowRoot
          .querySelector(".gsm-hoshidicts-image-hover-preview");
        return { rect: node.getBoundingClientRect().toJSON(), appearance: node.dataset.appearance };
      });
      const { png: previewPng, pixels: [previewInk] } = await sample(tab, [centre(preview.rect)]);
      await tab.$eval("hachidori-host", host => host.shadowRoot.activeElement?.blur());
      await tab.mouse.move(2, 2);
      const words = [];
      for (const word of wordTabs) words.push(await sampleWords(word.page, expectedTheme, scenario.forced));
      const textColor = state.textColor;
      const ratio = contrast(ink, background);
      const imagesPassed = state.theme === expectedTheme && near(ink, textColor) && near(auto, [0, 0, 0])
        && preview.appearance === "monochrome" && near(previewInk, textColor)
        && ratio >= (scenario.forced ? 20 : 3);
      const passed = imagesPassed && words.every(wordsPassed);
      const result = { name: scenario.name, passed, theme: state.theme, ink, auto, background,
        previewInk, textColor, contrast: Number(ratio.toFixed(2)),
        words: Object.fromEntries(wordTabs.map((word, index) => [word.name, Object.fromEntries(STATUSES.map(status => {
          const mark = words[index].marks[status];
          return [status, { ...mark, contrast: Number(contrast(mark.line, mark.under).toFixed(2)) }];
        }))])) };
      results.push(result);
      tiles.push({ name: scenario.name, cardPng, cardRect, previewPng, previewRect: preview.rect,
        words: words.map(({ png, rect, viewport }) => ({ png, rect, viewport })) });
      console.log(`${passed ? "ok  " : "FAIL"} ${scenario.name}${passed ? "" : ` ${JSON.stringify(result)}`}`);
    }
  } catch (error) {
    interrupted = error;
    console.error(error);
  } finally {
    for (const session of [media, ...wordTabs.map(word => word.media)]) {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
      await session.detach();
    }
  }
  for (const scenario of scenarios.slice(results.length)) {
    results.push({ name: scenario.name, passed: false, error: "check never completed" });
  }
  if (tiles.length) await writeFilmstrip(tab, tiles);
  const output = resolve(dirname(filmstrip), "theme-contrast.json");
  writeFileSync(output, JSON.stringify({ chrome: await browser.version(), results }, null, 2));
  console.log(`${results.filter(result => result.passed).length}/${scenarios.length} contrast rows passed`);
  if (interrupted || results.some(result => !result.passed)) process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
