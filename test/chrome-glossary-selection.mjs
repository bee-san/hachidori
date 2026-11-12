// Select a specific dictionary row and highlight one repeated passage through
// the production reader and Anki exporter in a real browser.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
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
const firefox = process.argv.includes("--firefox");
const firefoxBuild = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8")).config.firefox;
const firefoxPath = process.env.HACHIDORI_FIREFOX || resolve(root, `test/tmp/browsers/firefox/linux-${firefoxBuild}/firefox/firefox`);
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-glossary-selection-"));
const evidence = resolve(root, `test/tmp/ci/glossary-selection${firefox ? "-firefox" : ""}`);
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
// Firefox BiDi exposes closed roots by shared node identity. This is the
// existing Firefox suite's inspection boundary, without opening the popup root.
function reader(page) {
  if (!firefox) return popupRoot(page);
  async function evaluate(callback, ...args) {
    const context = page.mainFrame().browsingContext;
    const session = context.userContext.browser.session;
    const { result: host } = await session.send("script.callFunction", {
      functionDeclaration: "() => document.querySelector('hachidori-host')", awaitPromise: false, target: { context: context.id },
      serializationOptions: { maxDomDepth: 1, includeShadowTree: "all" } });
    const shadow = host.result?.value?.shadowRoot?.sharedId;
    if (!shadow) return null;
    const { result } = await session.send("script.callFunction", {
      functionDeclaration: `async (root, args) => JSON.stringify(await (${callback.toString()})(root, ...JSON.parse(args)))`,
      awaitPromise: true, target: { context: context.id },
      arguments: [{ sharedId: shadow }, { type: "string", value: JSON.stringify(args) }] });
    if (result.type === "exception") throw new Error(result.exceptionDetails?.text ?? "popup script failed");
    return JSON.parse(result.result?.value ?? "null");
  }
  async function waitFor(callback, { timeout = 30_000 } = {}, ...args) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await evaluate(callback, ...args);
      if (result) return result;
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error(`Popup condition timed out: ${callback}`);
  }
  return { evaluate, waitFor };
}
async function navigate(page, url) {
  if (!firefox) return page.goto(url);
  const context = page.mainFrame().browsingContext;
  await context.userContext.browser.session.send("browsingContext.navigate", { context: context.id, url, wait: "none" });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(expected => location.href === expected && document.readyState === "complete", url).catch(() => false)) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`Page did not load: ${url}`);
}
let browser;
try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let extensionOrigin;
  if (firefox) {
    const extension = resolve(root, "test/tmp/glossary-selection-firefox-extension");
    execFileSync("python3", ["scripts/build-firefox.py", "--output-dir", extension]);
    const uuid = "a6810000-0000-4000-8000-000000000001";
    browser = await puppeteer.launch({ browser: "firefox", executablePath: firefoxPath, headless: true, userDataDir: profile,
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
      extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({ "{b39ca224-e554-498d-8d8b-b2a5ad2f7a13}": uuid }),
        "dom.disable_beforeunload": true, "media.cubeb.force_mock_context": true } });
    await browser.installExtension(extension);
    extensionOrigin = `moz-extension://${uuid}`;
  } else {
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true, userDataDir: profile,
      args: [`--disable-extensions-except=${resolve(root, "extension")}`, `--load-extension=${resolve(root, "extension")}`,
        "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"] });
    const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
    extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  }
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120_000);
  await navigate(settings, `${extensionOrigin}/settings.html#anki`);
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { polling: 100 });
  // This standalone mining fixture never hosts other browsers' dictionaries.
  await settings.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ target: "hachidori-sharing", type: "hd_sharing_host_disable", requestId: "selection-private-host" });
    if (!reply.ok) throw new Error(reply.error);
  });
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
    await navigate(page, `${origin}/`);
    await page.bringToFront();
    await page.mouse.move(2, 2);
    const point = await page.$eval("#word", node => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await reader(page).waitFor(shadow => shadow.querySelectorAll(".gsm-hoshidicts-select-definition").length >= 8);
  };
  const outcomes = [];
  for (const theme of ["default", "jl", "bee", "nazeka", "crystal"]) {
    await open(theme);
    const selected = await reader(page).evaluate(shadow => {
      const buttons = [...shadow.querySelectorAll(".gsm-hoshidicts-select-definition")];
      const button = buttons.find(node => node.parentNode.textContent.includes("猫 repeated"));
      const content = button.parentNode.querySelector(".gsm-hoshidicts-glossary-content, .bee-rich-row > ul, .gloss-list") ?? button.nextElementSibling;
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let chosen;
      while (walker.nextNode()) if (walker.currentNode.data.includes("猫 repeated")) chosen = walker.currentNode;
      const range = document.createRange();
      const offset = chosen.data.indexOf("猫 repeated");
      range.setStart(chosen, offset); range.setEnd(chosen, offset + 1);
      const selection = shadow.getSelection?.() ?? window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      content.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      button.scrollIntoView({ block: "center" });
      button.focus();
      return { selected: button.getAttribute("aria-pressed"), label: button.textContent };
    });
    assert.equal(selected.selected, "true", `${theme}: text selection selects its owning entry`);
    await reader(page).waitFor(shadow => [...shadow.querySelectorAll(".gsm-hoshidicts-mine-button")]
      .some(button => button.dataset.state === "ready" || button.dataset.state === "add-duplicate"));
    await page.screenshot({ path: resolve(evidence, `${theme}.png`) });
    const previous = notes.length;
    await reader(page).evaluate(shadow => {
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
    if (theme !== "default" && theme !== "nazeka") {
      const count = notes.length;
      await reader(page).evaluate(shadow => shadow.querySelector(".gsm-hoshidicts-mine-button").click());
      const until = Date.now() + 30_000;
      while (notes.length === count && Date.now() < until) await new Promise(done => setTimeout(done, 50));
      assert.equal(notes.length, count + 1, `${theme}: another dictionary's Add keeps its own entries`);
      assert.match(notes.at(-1).fields.Back, /definition from dictionary 1/u);
      assert.doesNotMatch(notes.at(-1).fields.Back, /猫 repeated/u);
    }
    outcomes.push({ theme, selected, noteId: notes.length, highlighted: true });
    console.log(`ok ${theme}: selected complete entry, one exact highlighted occurrence, one note`);
  }
  const groupStatus = await settings.evaluate(async () => {
    const { dictionaryState: state } = await chrome.storage.local.get("dictionaryState");
    const id = index => state.dictionaries.find(row => row.title === `Selection dictionary ${index}`).id;
    const before = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: state.revision, dictionaries: state.dictionaries,
      groups: [{ id: "Mono-ID", name: "Monolingual", dictionaryIds: [id(7), id(2)] },
        { id: "bi", name: "Bilingual", dictionaryIds: [id(1), id(3)] }] });
    if (!reply.ok) throw new Error(reply.error);
    const after = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return { before: before.generation, after: after.generation };
  });
  assert.equal(groupStatus.before, groupStatus.after, "group-only changes preserve the loaded dictionary generation");
  await update({ anki: { ...anki, url: `${origin}/anki`, model: "Basic", duplicateBehavior: "new",
    monolingualGroupId: "Mono-ID", bilingualGroupId: "bi", fieldTemplates: {
      Front: { value: "{expression}", overwriteMode: "coalesce" },
      Back: { value: "{monolingual-definition}", overwriteMode: "coalesce" },
      All: { value: "{bilingual-definition}", overwriteMode: "coalesce" },
    } } });
  await open("default");
  await reader(page).evaluate(shadow => {
    const button = [...shadow.querySelectorAll(".gsm-hoshidicts-select-definition")]
      .find(button => button.parentNode.textContent.includes("another row"));
    button.click();
  });
  await reader(page).waitFor(shadow => [...shadow.querySelectorAll(".gsm-hoshidicts-mine-button")]
    .some(button => button.dataset.state === "ready" || button.dataset.state === "add-duplicate"));
  const groupNoteCount = notes.length;
  await reader(page).evaluate(shadow => shadow.querySelector(".gsm-hoshidicts-mine-button").click());
  const groupDeadline = Date.now() + 30_000;
  while (notes.length === groupNoteCount && Date.now() < groupDeadline) await new Promise(done => setTimeout(done, 50));
  assert.equal(notes.length, groupNoteCount + 1, "one grouped Add creates one note");
  assert.match(notes.at(-1).fields.Back, /another row/u, "the monolingual field keeps the exact selected row");
  assert.doesNotMatch(notes.at(-1).fields.Back, /猫 repeated|definition from dictionary/u);
  assert.match(notes.at(-1).fields.All, /definition from dictionary 1/u, "the bilingual field uses its own priority fallback");
  assert.doesNotMatch(notes.at(-1).fields.All, /another row|猫 repeated/u, "a selection outside the group cannot leak into it");
  console.log("ok group fields: selected exact row, separate bilingual fallback, stable dictionary generation");
  if (firefox) await settings.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.update(tab.id, { active: true });
  });
  else await settings.bringToFront();
  await navigate(settings, settings.url());
  await settings.waitForSelector('#opt-anki-monolingual-group option[value="Mono-ID"]');
  assert.equal(await settings.$eval("#opt-anki-monolingual-group", node => node.value), "Mono-ID");
  const groupEvidence = resolve(root, "test/tmp/ci/anki-glossary-groups");
  mkdirSync(groupEvidence, { recursive: true });
  for (const [name, palette] of [["light", "girlypop"], ["dark", "default"], ["contrast", "high-contrast"]]) {
    await update({ popupTheme: palette });
    await settings.waitForFunction(palette => document.documentElement.dataset.hoshidictsTheme === palette, {}, palette);
    await settings.$eval("#anki-glossary-selection", node => node.scrollIntoView({ block: "center" }));
    await (await settings.$("#anki-glossary-selection")).screenshot({ path: resolve(groupEvidence, `${name}.png`) });
  }
  console.log("ok group Settings: saved stable IDs and light/dark/high-contrast screenshots");
  // Default's palette variants use the same control. Capture all of them with
  // a visible pressed label, including emulated Windows contrast themes.
  const palettes = firefox ? [] : globalThis.HDReaderOptions.POPUP_THEME_GROUPS.flatMap(group => group.themes.map(theme => theme.id));
  for (const palette of palettes) {
    await open(palette);
    await reader(page).evaluate(shadow => {
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
