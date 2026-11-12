// Select a specific dictionary row and highlight one repeated passage through
// the production reader and Anki exporter in a real browser.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
import { popupRoot } from "./chrome-popup-root.mjs";
import { buildTitledZip } from "./make-fixture.mjs";
import "../extension/reader-options.js";
const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const chromeBuild = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8")).config.chrome;
const chrome = process.env.HACHIDORI_CHROME || resolve(root, `test/tmp/browsers/chrome/linux-${chromeBuild}/chrome-linux64/chrome`);
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-glossary-selection-"));
const evidence = resolve(root, "test/tmp/ci/glossary-selection");
mkdirSync(evidence, { recursive: true });
const notes = [], calls = [];
const server = createServer(async (request, response) => {
  if (request.url === "/anki") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const reply = await answerAnkiConnect(JSON.parse(Buffer.concat(chunks)), async (action, params) => {
      calls.push(action);
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelFieldNames") return ["Front", "Back", "All"];
      if (action === "findNotes") return [];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      if (action === "addNote") { notes.push(params.note); return notes.length; }
      if (action === "guiBrowse") return [];
      throw new Error(`Unexpected Anki action ${action}`);
    });
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify(reply));
  } else response.end('<!doctype html><meta charset="utf-8"><style>body{font:32px sans-serif;padding:50px}</style><span id="word">猫</span>');
});
let browser;
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true, userDataDir: profile,
    args: [`--disable-extensions-except=${resolve(root, "extension")}`, `--load-extension=${resolve(root, "extension")}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"] });
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120_000);
  await settings.goto(`chrome-extension://${new URL(worker.url()).host}/settings.html#anki`);
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  for (let index = 1; index <= 7; index++) {
    const gloss = index === 7 ? [{ type: "structured-content", content: ["猫 repeated ", { tag: "em", content: "猫 repeated" }, " suffix"] }]
      : [`definition from dictionary ${index}`];
    const archive = buildTitledZip(`Selection dictionary ${index}`, { terms: [["猫", "ねこ", "", "", 1, gloss, 1, ""],
      ...index === 7 ? [["猫", "ねこ", "", "", 1, ["another row"], 2, ""]] : []] });
    await settings.evaluate(async base64 => {
      const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))]));
      try {
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: `selection-${crypto.randomUUID()}`, blobUrl, fileName: "selection.zip" });
        if (!reply.ok) throw new Error(reply.error);
      } finally { URL.revokeObjectURL(blobUrl); }
    }, archive.toString("base64"));
  }
  const { anki } = globalThis.HDReaderOptions.normaliseOptions({});
  const update = patch => settings.evaluate(async next => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: next });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  await update({ hoverEnabled: true, lookupMode: "hover", popupWidthPx: 700, popupHeightPx: 600,
    anki: { ...anki, url: `${origin}/anki`, model: "Basic", duplicateBehavior: "new", fieldTemplates: {
      Front: { value: "{expression}", overwriteMode: "coalesce" },
      Back: { value: "{selected-glossary}", overwriteMode: "coalesce" },
      All: { value: "{glossary}", overwriteMode: "coalesce" },
    } }, audioSources: [] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 850 });
  const open = async theme => {
    await update({ popupTheme: theme });
    await page.goto(origin);
    await page.mouse.move(2, 2);
    const point = await page.$eval("#word", node => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await popupRoot(page).waitFor(shadow => shadow.querySelectorAll(".gsm-hoshidicts-select-definition").length >= 8);
  };
  const outcomes = [];
  for (const theme of ["default", "jl", "bee", "nazeka", "crystal"]) {
    await open(theme);
    const selected = await popupRoot(page).evaluate(shadow => {
      const buttons = [...shadow.querySelectorAll(".gsm-hoshidicts-select-definition")];
      const button = buttons.find(node => node.parentNode.textContent.includes("猫 repeated"));
      const content = button.parentNode.querySelector(".gsm-hoshidicts-glossary-content, .bee-rich-row > ul, .gloss-list") ?? button.nextElementSibling;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let chosen;
      while (walker.nextNode()) if (walker.currentNode.data.includes("猫 repeated")) chosen = walker.currentNode;
      const range = document.createRange();
      const offset = chosen.data.indexOf("猫 repeated");
      range.setStart(chosen, offset); range.setEnd(chosen, offset + 1);
      const selection = shadow.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      content.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      button.scrollIntoView({ block: "center" });
      button.focus();
      return { selected: button.getAttribute("aria-pressed"), label: button.textContent };
    });
    assert.equal(selected.selected, "true", `${theme}: text selection selects its owning entry`);
    await popupRoot(page).waitFor(shadow => [...shadow.querySelectorAll(".gsm-hoshidicts-mine-button")]
      .some(button => button.dataset.state === "ready" || button.dataset.state === "add-duplicate"));
    await page.screenshot({ path: resolve(evidence, `${theme}.png`) });
    const previous = notes.length;
    await popupRoot(page).evaluate(shadow => {
      const selected = shadow.querySelector('.gsm-hoshidicts-select-definition[aria-pressed="true"]');
      const entry = selected.closest(".gsm-hoshidicts-entry, .crystal-dictionary");
      (entry?.querySelector(".gsm-hoshidicts-mine-button") ?? shadow.querySelector(".gsm-hoshidicts-mine-button")).click();
    });
    const deadline = Date.now() + 30_000;
    while (notes.length === previous && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    assert.equal(notes.length, previous + 1, `${theme}: one explicit Add creates one note`);
    const { Back: html, All: all } = notes.at(-1).fields;
    assert.match(html, /猫 repeated/u);
    assert.match(html, /<b>猫<\/b>/u, `${theme}: source range survives popup layout`);
    assert.doesNotMatch(html, /another row|definition from dictionary/u);
    if (theme === "default") assert.match(all, /definition from dictionary 1/u, "legacy glossary still exports every dictionary");
    outcomes.push({ theme, selected, noteId: notes.length, highlighted: true });
    console.log(`ok ${theme}: selected complete entry, one exact highlighted occurrence, one note`);
  }
  // Default's palette variants use the same control. Capture all of them with
  // a visible pressed label, including emulated Windows contrast themes.
  const palettes = globalThis.HDReaderOptions.POPUP_THEME_GROUPS.flatMap(group => group.themes.map(theme => theme.id));
  for (const palette of palettes) {
    await open(palette);
    await popupRoot(page).evaluate(shadow => {
      const button = shadow.querySelector(".gsm-hoshidicts-select-definition");
      button.click(); button.focus();
    });
    await page.screenshot({ path: resolve(evidence, `palette-${palette}.png`) });
  }
  const images = ["default", "jl", "bee", "nazeka", "crystal", ...palettes.map(palette => `palette-${palette}`)]
    .map(name => ({ name, base64: readFileSync(resolve(evidence, `${name}.png`)).toString("base64") }));
  const filmstrip = await settings.evaluate(async images => {
    const width = 240, height = 230, columns = 6;
    const canvas = document.createElement("canvas");
    canvas.width = width * columns; canvas.height = height * Math.ceil(images.length / columns);
    const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    for (const [index, { name, base64 }] of images.entries()) {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const x = index % columns * width, y = Math.floor(index / columns) * height;
      context.fillStyle = "black"; context.font = "14px sans-serif"; context.fillText(name, x + 6, y + 17);
      context.drawImage(bitmap, x, y + 23, width, width * bitmap.height / bitmap.width);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, images);
  writeFileSync(resolve(evidence, "palettes.png"), Buffer.from(filmstrip, "base64"));
  writeFileSync(resolve(evidence, "results.json"), JSON.stringify({ outcomes, palettes, calls }, null, 2));
  console.log(`PASS ${outcomes.length} renderer mining scenarios and ${palettes.length} palette screenshots`);
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
  rmSync(profile, { recursive: true, force: true });
}
