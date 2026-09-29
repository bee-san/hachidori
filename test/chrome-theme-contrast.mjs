// Pixel-check monochrome dictionary images in every popup palette and both
// emulated Windows contrast palettes through the real extension and importer.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { monochromeImageFixture } from "./make-fixture.mjs";
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

async function writeFilmstrip(tab, tiles) {
  const png = await tab.evaluate(async entries => {
    const columns = 6;
    const tileWidth = 220;
    const tileHeight = 126;
    const canvas = document.createElement("canvas");
    canvas.width = columns * tileWidth;
    canvas.height = Math.ceil(entries.length / columns) * tileHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "12px sans-serif";
    const draw = async (encoded, rect, x, y) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const scale = image.naturalWidth / window.innerWidth;
      context.drawImage(image, rect.left * scale, rect.top * scale,
        rect.width * scale, rect.height * scale, x, y, 96, 96);
    };
    for (const [index, tile] of entries.entries()) {
      const x = (index % columns) * tileWidth;
      const y = Math.floor(index / columns) * tileHeight;
      context.fillStyle = "#111";
      context.fillText(tile.name, x + 7, y + 15);
      await draw(tile.cardPng, tile.cardRect, x + 7, y + 23);
      await draw(tile.previewPng, tile.previewRect, x + 113, y + 23);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, tiles);
  mkdirSync(dirname(filmstrip), { recursive: true });
  writeFileSync(filmstrip, Buffer.from(png, "base64"));
  console.log(`Filmstrip: ${filmstrip}`);
}

const profile = mkdtempSync(resolve(tmpdir(), "hachidori-theme-contrast-"));
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><meta charset="utf-8"><style>body{font:32px sans-serif;padding:80px}</style><span id="word">${fixture.query}</span>`);
});
let browser;
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true, userDataDir: profile,
    args: [`--disable-extensions-except=${resolve(root, "extension")}`, `--load-extension=${resolve(root, "extension")}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"] });
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120_000);
  await settings.goto(`${origin}/settings.html#add-dictionaries`);
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  await settings.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: "theme-contrast-import", blobUrl, fileName: "theme-contrast.zip" });
      if (!reply.ok) throw new Error(reply.error);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, fixture.archive.toString("base64"));
  const writeOptions = patch => settings.evaluate(async next => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: next });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  await writeOptions({ hoverEnabled: true, lookupMode: "hover", popupTheme: "default" });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1100, height: 800 });
  await tab.goto(`http://127.0.0.1:${server.address().port}`);
  const media = await tab.createCDPSession();
  const results = [];
  const tiles = [];
  let interrupted = null;
  try {
    for (const scenario of scenarios) {
      const expectedTheme = scenario.theme === "auto" ? scenario.scheme : scenario.theme;
      await media.send("Emulation.setEmulatedMedia", { features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-color-scheme", value: scenario.scheme },
        ...(scenario.forced ? [{ name: "forced-colors", value: "active" }] : []),
      ] });
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
      const textColor = state.textColor;
      const ratio = contrast(ink, background);
      const passed = state.theme === expectedTheme && near(ink, textColor) && near(auto, [0, 0, 0])
        && preview.appearance === "monochrome" && near(previewInk, textColor)
        && ratio >= (scenario.forced ? 20 : 3);
      const result = { name: scenario.name, passed, theme: state.theme, ink, auto, background,
        previewInk, textColor, contrast: Number(ratio.toFixed(2)) };
      results.push(result);
      tiles.push({ name: scenario.name, cardPng, cardRect, previewPng, previewRect: preview.rect });
      console.log(`${passed ? "ok  " : "FAIL"} ${scenario.name}${passed ? "" : ` ${JSON.stringify(result)}`}`);
      await tab.$eval("hachidori-host", host => host.shadowRoot.activeElement?.blur());
      await tab.mouse.move(2, 2);
    }
  } catch (error) {
    interrupted = error;
    console.error(error);
  } finally {
    await media.send("Emulation.setEmulatedMedia", { features: [] });
    await media.detach();
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
