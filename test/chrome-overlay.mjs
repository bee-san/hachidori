/*
 * Overlay mode in a real Chrome: the reader's own glyph selection over a page
 * that boxes every glyph the way GameSentenceMiner's OCR overlay does, and the
 * host events that keep such a click-through window interactive around a drag.
 *
 * The extension is copied with OVERLAY_MODE set, since the flag is a source
 * constant. Chrome and puppeteer-core live outside the repo, as for
 * chrome-e2e.mjs.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSION = resolve(ROOT, "extension");
const TEST_EXTENSION = resolve(tmpdir(), `hachidori-overlay-extension-${process.pid}`);
const PROFILE = resolve(tmpdir(), `hachidori-overlay-profile-${process.pid}`);
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");

function cachedChrome() {
  const suffixes = process.platform === "linux"
    ? [["chrome-linux64", "chrome"]]
    : process.platform === "darwin"
      ? [
          ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
          ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ]
      : process.platform === "win32"
        ? [["chrome-win64", "chrome.exe"], ["chrome-win32", "chrome.exe"]]
        : [];
  for (const name of ["hachidori-browsers", "hdw-browsers"]) {
    const root = resolve(CACHE, name, "chrome");
    if (!existsSync(root)) continue;
    const builds = readdirSync(root).sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }));
    for (const build of builds) {
      for (const suffix of suffixes) {
        const candidate = resolve(root, build, ...suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return "";
}

function installedChrome() {
  const candidates = process.platform === "linux"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [resolve(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe")]
        : [];
  return candidates.find(existsSync) || "";
}

const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || cachedChrome() || installedChrome();
const PUPPETEER_CANDIDATES = ["hachidori-e2e", "hdw-e2e"].map((name) =>
  resolve(CACHE, name, "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js"));
const PUPPETEER = process.env.HACHIDORI_PUPPETEER || PUPPETEER_CANDIDATES.find(existsSync) || PUPPETEER_CANDIDATES[0];
if (!CHROME) throw new Error("no Chrome found (set HACHIDORI_CHROME or install it as described in test/README.md)");
if (!existsSync(PUPPETEER)) throw new Error(`no puppeteer-core at ${PUPPETEER} (set HACHIDORI_PUPPETEER)`);
if (!existsSync(FIXTURE)) {
  const made = spawnSync(process.execPath, [resolve(ROOT, "test/make-fixture.mjs")], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`make-fixture.mjs failed:\n${made.stdout}\n${made.stderr}`);
}
const puppeteer = await import(`file://${PUPPETEER}`);

// GameSentenceMiner's layout: one absolutely positioned flex span per glyph,
// wider than the glyph it centres, inside a full-size click-through paragraph,
// with a "\n" span separating blocks. The host events are recorded in order.
const TEXT = "食べたかった";
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>overlay</title><style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  .text-box { position: absolute; white-space: nowrap; pointer-events: auto; user-select: text; z-index: 999;
    display: flex; align-items: center; justify-content: center; overflow: visible; font-size: 34px; line-height: 1; }
</style></head><body>
<p id="line" style="position:absolute;pointer-events:none;left:0;top:0;width:100%;height:100%;margin:0;padding:0"></p>
<span id="separator" style="position:absolute">
</span>
<p id="line2" style="position:absolute;pointer-events:none;left:0;top:0;width:100%;height:100%;margin:0;padding:0"></p>
<script>
  const box = (line, text, top) => Array.from(text).forEach((glyph, index) => {
    const span = document.createElement("span");
    span.className = "text-box";
    span.dataset.selectable = "true";
    span.textContent = glyph;
    span.style.cssText = "left:" + (100 + index * 64) + "px; top:" + top + "px; width:60px; height:48px";
    document.getElementById(line).append(span);
  });
  box("line", ${JSON.stringify(TEXT)}, 100);
  box("line2", "漢字", 200);
  window.__hostEvents = [];
  for (const type of ["hachidori-popup-shown", "hachidori-popup-hidden"]) {
    window.addEventListener(type, () => window.__hostEvents.push(type.replace("hachidori-popup-", "")));
  }
</script></body></html>`;

function prepareExtension() {
  rmSync(TEST_EXTENSION, { recursive: true, force: true });
  cpSync(SOURCE_EXTENSION, TEST_EXTENSION, { recursive: true });
  const flagPath = resolve(TEST_EXTENSION, "overlay-mode.js");
  const flagged = readFileSync(flagPath, "utf8").replace("OVERLAY_MODE = false;", "OVERLAY_MODE = true;");
  assert.notEqual(flagged, readFileSync(flagPath, "utf8"), "overlay-mode.js exposes the flag to set");
  writeFileSync(flagPath, flagged);
}

function launch() {
  const args = [
    `--disable-extensions-except=${TEST_EXTENSION}`,
    `--load-extension=${TEST_EXTENSION}`,
    "--disable-gpu",
    "--disable-dev-shm-usage",
  ];
  if (process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1") args.push("--no-sandbox");
  return puppeteer.launch({ executablePath: CHROME, enableExtensions: true, userDataDir: PROFILE, headless: true, args });
}

async function extensionId(browser) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker" && candidate.url().startsWith("chrome-extension://"),
    { timeout: 30_000 },
  );
  return new URL(target.url()).host;
}

// The default window is narrow, so Settings shows its section picker instead of
// the sidebar links; either route must reach the section.
async function showSection(page, id) {
  await page.evaluate((section) => {
    const picker = document.getElementById("settings-section");
    if (picker.checkVisibility()) {
      picker.value = section;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else document.querySelector(`.settings-nav a[href="#${section}"], #library-navigation a[href="#${section}"]`).click();
  }, id);
  await page.waitForFunction((section) => {
    const visible = [...document.querySelectorAll("main > section")].filter((node) => !node.hidden);
    return visible.length === 1 && visible[0].id === section;
  }, { timeout: 30_000, polling: 100 }, id);
}

async function editSettingsControls(settings, values) {
  const section = await settings.evaluate((id) => {
    const owner = document.getElementById(id).closest("section");
    return { id: owner.id, hidden: owner.hidden };
  }, Object.keys(values)[0]);
  if (section.hidden) await showSection(settings, section.id);
  await settings.evaluate((changes) => {
    for (const [id, value] of Object.entries(changes)) {
      const input = document.getElementById(id);
      for (let parent = input.closest("details"); parent; parent = parent.parentElement.closest("details")) parent.open = true;
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, values);
  await settings.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
    { polling: 100, timeout: 10_000 });
}

async function openSettings(browser, id) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.waitForFunction(() => {
    const text = (document.querySelector("#engine-status")?.textContent || "").toLowerCase();
    return text.includes("ready") || text.includes("no dictionaries") || text.includes("error");
  }, { timeout: 90_000 });
  return page;
}

async function importFixture(page) {
  await showSection(page, "add-dictionaries");
  await page.waitForSelector("#import-file", { visible: true });
  await (await page.$("#import-file")).uploadFile(FIXTURE);
  await page.waitForFunction(
    () => (document.querySelector("#import-state")?.textContent || "").trim()
      === "Finished 1 of 1 archive — 1 imported, 0 failed.",
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    () => document.querySelector("#engine-status")?.textContent?.includes("1 dictionary enabled"),
    { timeout: 90_000 },
  );
}

// The popup lives in a closed shadow root, so it is read through CDP.
async function popupReader(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("DOM.enable");
  await cdp.send("Runtime.enable");
  async function resolvePopupObject() {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    let nodeId = null;
    const walk = (node) => {
      const attributes = node.attributes || [];
      for (let index = 0; index < attributes.length; index += 2) {
        if (attributes[index] === "class" && String(attributes[index + 1]).includes("gsm-hoshidicts-popup")
            && attributes[attributes.indexOf("data-hoshidicts-depth") + 1] === "0") nodeId = node.nodeId;
      }
      for (const shadow of node.shadowRoots || []) walk(shadow);
      for (const child of node.children || []) walk(child);
    };
    walk(root);
    if (nodeId === null) return null;
    return (await cdp.send("DOM.resolveNode", { nodeId })).object;
  }
  async function call(functionDeclaration, args = []) {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, functionDeclaration,
      arguments: args.map((value) => ({ value })),
    });
    return result.value;
  }
  const state = () => call(`function () {
    const stripped = this.cloneNode(true);
    for (const rt of stripped.querySelectorAll("rt, rp")) rt.remove();
    const noteForm = this.querySelector(".gsm-hoshidicts-note-form");
    return {
      hidden: this.hasAttribute("hidden"),
      height: this.getBoundingClientRect().height,
      plain: (stripped.textContent || "").replace(/\\s+/g, " ").trim(),
      pencil: this.querySelector(".gsm-hoshidicts-note-button") !== null,
      noteOpen: noteForm !== null && !noteForm.hidden,
      noteTerm: noteForm?.querySelector('[name="term"]')?.value ?? null,
    };
  }`);
  const visible = (current) => Boolean(current) && !current.hidden && current.height > 0 && current.plain !== "";
  async function waitForVisible(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await state();
      if (visible(current)) return current;
      if (Date.now() >= deadline) return null;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  async function waitForHidden(timeoutMs = 6_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!visible(await state())) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  const click = (selector) => call(`function (target) {
    const element = this.querySelector(target);
    if (!element) return false;
    element.click();
    return true;
  }`, [selector]);
  return { state, visible, waitForVisible, waitForHidden, click };
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// The extension's own pages have no console anyone reads; a failure there shows
// up as a popup that never appears, so every message is kept for the report.
const diagnostics = [];
function watchExtensionTarget(target) {
  if (!target.url().startsWith("chrome-extension://")) return;
  target.createCDPSession().then(async (cdp) => {
    await cdp.send("Runtime.enable");
    const flatten = (args) => (args || [])
      .map((argument) => argument.value ?? argument.description ?? JSON.stringify(argument.preview ?? null)).join(" ");
    cdp.on("Runtime.consoleAPICalled", (event) => diagnostics.push(`[${target.type()}] ${event.type}: ${flatten(event.args)}`));
    cdp.on("Runtime.exceptionThrown", (event) => diagnostics.push(
      `[${target.type()}] exception: ${event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "(no detail)"}`));
  }).catch(() => {});
}

rmSync(PROFILE, { recursive: true, force: true });
prepareExtension();
let browser;
let passed = false;
try {
  browser = await launch();
  browser.on("targetcreated", watchExtensionTarget);
  for (const target of browser.targets()) watchExtensionTarget(target);
  const id = await extensionId(browser);
  const settings = await openSettings(browser, id);
  await importFixture(settings);
  // Setup never opens in an overlay: the host has no tab to show it in.
  assert.equal(browser.targets().some((target) => target.url().endsWith("/startup.html")), false,
    "overlay mode opens no startup page");
  // A long hover delay keeps a press from racing the hover lookup, so the
  // drag below provably starts with no popup open.
  await editSettingsControls(settings, { "opt-hover-delay": "1500" });

  const tab = await browser.newPage();
  tab.on("console", (message) => diagnostics.push(`[page] ${message.type()}: ${message.text()}`));
  tab.on("pageerror", (error) => diagnostics.push(`[page] error: ${error.message}`));
  await tab.setViewport({ width: 1280, height: 720 });
  await tab.goto(pageUrl, { waitUntil: "load" });
  await tab.bringToFront();
  const popup = await popupReader(tab);
  const boxes = await tab.$$eval("#line .text-box", (nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }));
  const second = await tab.$eval("#line2 .text-box", (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  });
  // The trailing margin of a box: past the glyph, where Chromium's caret lands
  // after it and its own drag anchors nowhere.
  const trailing = (box) => [box.x + box.width - 5, box.y + box.height / 2];
  const middle = (box) => [box.x + box.width / 2, box.y + box.height / 2];
  const selected = () => tab.evaluate(() => window.getSelection().toString());
  const events = () => tab.evaluate(() => window.__hostEvents.splice(0));
  const settle = (ms = 250) => new Promise((done) => setTimeout(done, ms));

  // Hovering still works, with the overlay's own delay.
  await tab.mouse.move(...middle(boxes[0]));
  const hovered = await popup.waitForVisible(10_000);
  assert.ok(hovered?.plain.includes("食べる"), `hover reads the boxed word: ${JSON.stringify(hovered)}`);
  assert.deepEqual(await events(), ["shown"]);
  await tab.keyboard.press("Escape");
  assert.equal(await popup.waitForHidden(), true, "Escape closes the hover popup");
  assert.deepEqual(await events(), ["hidden"]);

  // A drag from the trailing margin of the first glyph to the trailing margin
  // of the last, with no popup open, selects every glyph and looks it up.
  await tab.mouse.move(2, 2);
  await tab.mouse.move(...trailing(boxes[0]));
  await tab.mouse.down();
  const pressed = { events: await events(), popup: popup.visible(await popup.state()), selected: await selected() };
  await tab.mouse.move(...trailing(boxes[5]), { steps: 10 });
  const dragged = { events: await events(), selected: await selected(), popup: popup.visible(await popup.state()) };
  await tab.mouse.up();
  const exact = await popup.waitForVisible();
  const released = { events: await events(), selected: await selected() };
  assert.deepEqual(pressed, { events: ["shown"], popup: false, selected: "" },
    "the press claims the host window before any popup exists");
  assert.deepEqual(dragged, { events: [], selected: TEXT, popup: false },
    "the drag selects whole glyphs from the pressed one and keeps the claim");
  assert.ok(exact?.plain.includes("食べる"), `release looks up the selection: ${JSON.stringify(exact)}`);
  assert.deepEqual(released, { events: [], selected: TEXT }, "the lookup inherits the claim without a gap");

  // Dragging backwards from the last glyph's margin, past a gap, selects the
  // glyphs under both ends; an unknown selection offers the pencil, prefilled.
  await tab.keyboard.press("Escape");
  assert.equal(await popup.waitForHidden(), true);
  await tab.evaluate(() => window.getSelection().removeAllRanges());
  await settle();
  await events();
  await tab.mouse.move(...trailing(boxes[5]));
  await tab.mouse.down();
  await tab.mouse.move(boxes[1].x + 2, boxes[1].y + boxes[1].height / 2, { steps: 10 });
  const backwards = await selected();
  await tab.mouse.up();
  const miss = await popup.waitForVisible();
  assert.equal(backwards, TEXT.slice(1), "a backward drag includes the pressed and pointed glyphs");
  assert.ok(miss?.plain.includes("No definition found") && miss.pencil, `an unknown selection offers the pencil: ${JSON.stringify(miss)}`);
  assert.equal(await popup.click(".gsm-hoshidicts-note-button"), true);
  await settle();
  const note = await popup.state();
  assert.equal(note.noteOpen, true, "the pencil opens the note form");
  assert.equal(note.noteTerm, TEXT.slice(1), "the note form is prefilled with the selection");
  assert.deepEqual(await events(), ["shown"]);
  await popup.click(".gsm-hoshidicts-note-cancel");
  await settle();

  // A press that does not travel is a click: it clears the selection,
  // dismisses the popup and releases the host window.
  await tab.mouse.move(...middle(second));
  await tab.mouse.down();
  await tab.mouse.up();
  assert.equal(await popup.waitForHidden(), true, "a click dismisses the popup");
  await settle();
  assert.deepEqual({ events: await events(), selected: await selected() }, { events: ["hidden"], selected: "" });

  // Past the last box the pointer is over nothing; the selection keeps the
  // last glyph it reached.
  await tab.mouse.move(...middle(boxes[2]));
  await tab.mouse.down();
  await tab.mouse.move(boxes[5].x + boxes[5].width + 60, boxes[5].y + boxes[5].height / 2, { steps: 10 });
  const beyond = await selected();
  await tab.mouse.up();
  await popup.waitForVisible();
  assert.equal(beyond, TEXT.slice(2), "dragging past the last box keeps its glyph");
  await tab.keyboard.press("Escape");
  assert.equal(await popup.waitForHidden(), true);

  passed = true;
  console.log("overlay mode selects boxed glyphs by drag, offers the pencil for unknown text and keeps the host window claimed");
} finally {
  server.close();
  if (browser !== undefined) await browser.close().catch(() => {});
  if (passed) {
    rmSync(PROFILE, { recursive: true, force: true });
    rmSync(TEST_EXTENSION, { recursive: true, force: true });
  } else {
    console.error(`overlay profile kept for inspection: ${PROFILE}`);
    console.error(`overlay extension kept for inspection: ${TEST_EXTENSION}`);
    if (diagnostics.length > 0) console.error(`diagnostics:\n  ${diagnostics.join("\n  ")}`);
  }
}
