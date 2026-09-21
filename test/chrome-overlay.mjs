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
import { answerAnkiConnect } from "./anki-connect-fake.mjs";

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

  // Test-copy-only instrumentation: retain the exact runtime lookup requests
  // made after a physical pointer event without changing the source extension.
  const contentPath = resolve(TEST_EXTENSION, "content.js");
  const content = readFileSync(contentPath, "utf8");
  const instrumented = content.replace(
    "  function sendRequest(type, payload, target = TARGET) {\n",
    "  function sendRequest(type, payload, target = TARGET) {\n"
      + "    const __traceRequests = JSON.parse(document.documentElement.dataset.hachidoriPhysicalClickRequests || '[]');\n"
      + "    __traceRequests.push({ type, payload: structuredClone(payload ?? null), target });\n"
      + "    document.documentElement.dataset.hachidoriPhysicalClickRequests = JSON.stringify(__traceRequests);\n"
      + "    const __kanjiFailure = document.documentElement.dataset.hachidoriKanjiFailure;\n"
      + "    if (type === 'hd_kanji' && __kanjiFailure === 'empty') return Promise.resolve({ kanji: null });\n"
      + "    if (type === 'hd_kanji' && __kanjiFailure === 'malformed') return Promise.resolve({ kanji: { character: payload.character, entries: [{}] } });\n"
      + "    if (type === 'hd_kanji' && __kanjiFailure === 'runtime') return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));\n"
      + "    if (type === 'hd_kanji' && __kanjiFailure === 'slow-runtime') return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Could not establish connection. Receiving end does not exist.')), 500));\n",
  ).replace(
    "  function showKanji(character, _result, _candidate, sourceLink, level = rootLevel) {\n",
    "  function showKanji(character, _result, _candidate, sourceLink, level = rootLevel) {\n"
      + "    document.documentElement.dataset.hachidoriShowKanjiCalls = JSON.stringify([...(JSON.parse(document.documentElement.dataset.hachidoriShowKanjiCalls || '[]')), { character, active: !!level.activeCandidate, depth: level.depth }]);\n",
  );
  assert.notEqual(instrumented, content, "content.js exposes sendRequest for test-copy instrumentation");
  writeFileSync(contentPath, instrumented);
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

// Media capture is an experimental feature: its section only joins the
// navigation after the Advanced switch is on.
async function enableMediaMining(page) {
  await showSection(page, "advanced");
  await page.click("#opt-experimental-mediaMining");
  await page.waitForFunction(() => !document.querySelector('.settings-nav a[href="#media"]').parentElement.hidden,
    { timeout: 10_000, polling: 100 });
}

async function editSettingsControls(settings, values) {
  const section = await settings.evaluate((id) => {
    const owner = document.getElementById(id).closest("section");
    return { id: owner.id, hidden: owner.hidden };
  }, Object.keys(values)[0]);
  if (section.hidden) await showSection(settings, section.id);
  for (const [id, value] of Object.entries(values)) {
    await settings.evaluate(([controlId, controlValue]) => {
      const input = document.getElementById(controlId);
      for (let parent = input.closest("details"); parent; parent = parent.parentElement.closest("details")) parent.open = true;
      if (input.type === "checkbox") input.checked = controlValue;
      else input.value = controlValue;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, [id, value]);
    await settings.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
      { polling: 100, timeout: 10_000 });
  }
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
      linkButtons: this.querySelectorAll(".gsm-hoshidicts-external-link-button").length,
      noteOpen: noteForm !== null && !noteForm.hidden,
      noteTerm: noteForm?.querySelector('[name="term"]')?.value ?? null,
      kanjiBack: this.querySelector(".gsm-hoshidicts-kanji-back") !== null,
      kanjiGlyph: this.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent ?? null,
      failureKind: this.querySelector(".gsm-hoshidicts-lookup-failure")?.dataset.kind ?? null,
      failureText: this.querySelector(".gsm-hoshidicts-lookup-failure")?.textContent ?? null,
      theme: this.getRootNode().host.dataset.hoshidictsTheme,
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
  const rect = selector => call(`function (target) {
    const element = this.querySelector(target);
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      text: element.textContent };
  }`, [selector]);
  const physicalTrace = selector => call(`function (target) {
    const element = this.querySelector(target);
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    const describe = node => node ? {
      className: typeof node.className === "string" ? node.className : "",
      label: node.getAttribute?.("aria-label") ?? "",
      localName: node.localName ?? "",
      text: node.textContent ?? "",
    } : null;
    const trace = { x, y, element: describe(element), shadowPointTarget: describe(this.getRootNode().elementFromPoint(x, y)),
      documentPointTarget: describe(document.elementFromPoint(x, y)), events: [] };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      element.addEventListener(type, event => trace.events.push({ type, target: describe(event.target),
        composedPath: event.composedPath().slice(0, 4).map(describe) }), { once: true });
    }
    globalThis.__hachidoriPhysicalClickTrace = trace;
    document.documentElement.dataset.hachidoriPhysicalClickRequests = "[]";
    document.documentElement.dataset.hachidoriShowKanjiCalls = "[]";
    return trace;
  }`, [selector]);
  const trace = () => call(`function () {
    return { trace: globalThis.__hachidoriPhysicalClickTrace ?? null,
      requests: JSON.parse(document.documentElement.dataset.hachidoriPhysicalClickRequests || "[]"),
      showKanjiCalls: JSON.parse(document.documentElement.dataset.hachidoriShowKanjiCalls || "[]") };
  }`);
  const anki = () => call(`function () {
    const button = this.querySelector(".gsm-hoshidicts-mine-button");
    const icon = button?.querySelector(".gsm-hoshidicts-mine-icon");
    return button ? {
      state: button.dataset.state,
      icon: icon?.dataset.icon ?? "",
      action: button.dataset.action,
      disabled: button.disabled,
      hidden: button.hidden,
      ariaBusy: button.getAttribute("aria-busy"),
      ariaLabel: button.getAttribute("aria-label"),
      focused: button.getRootNode().activeElement === button,
      popupRect: this.getBoundingClientRect().toJSON(),
    } : null;
  }`);
  const focusAnki = () => call(`function () {
    const button = this.querySelector(".gsm-hoshidicts-mine-button");
    button?.focus();
    return button?.getRootNode().activeElement === button;
  }`);
  return { anki, focusAnki, state, visible, waitForVisible, waitForHidden, click, rect, physicalTrace, trace };
}

const overlayAnkiCalls = [];
let overlayAnkiGate = null;
const server = createServer((request, response) => {
  if (request.url?.startsWith("/anki")) {
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "content-type": "application/json",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    void (async () => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const envelope = await answerAnkiConnect(JSON.parse(body), async (action, params) => {
          overlayAnkiCalls.push({ action, params });
          if (action === "deckNames") return ["Default"];
          if (action === "modelNames") return ["Basic"];
          if (action === "modelNamesAndIds") return { Basic: 1 };
          if (action === "modelFieldNames") return ["Front", "Back"];
          if (action === "findNotes" || action === "findCards" || action === "cardsToNotes"
              || action === "cardsInfo" || action === "notesInfo" || action === "guiBrowse") return [];
          if (action === "getDecks") return {};
          if (action === "canAddNotesWithErrorDetail") {
            const gate = overlayAnkiGate;
            if (gate) await gate.promise;
            return params.notes.map(() => ({ canAdd: true, error: null }));
          }
          throw new Error(`Unexpected overlay Anki action ${action}`);
        });
        response.writeHead(200, headers);
        response.end(JSON.stringify(envelope));
      } catch (error) {
        response.writeHead(500, headers);
        response.end(JSON.stringify({ result: null, error: error.message }));
      }
    })();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const ankiUrl = `${pageUrl}anki`;

// The extension's own pages have no console anyone reads; a failure there shows
// up as a popup that never appears, so every message is kept for the report.
const diagnostics = [];
function watchExtensionTarget(target) {
  if (!target.url().startsWith("chrome-extension://")) return;
  target.createCDPSession().then(async (cdp) => {
    await cdp.send("Runtime.enable");
    // Puppeteer attaches dedicated workers paused; without this the OPFS probe
    // and engine workers never run and the engine silently falls back.
    await cdp.send("Runtime.runIfWaitingForDebugger").catch(() => {});
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
  const automaticSettingsThemes = [];
  for (const scheme of ["light", "dark"]) {
    await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await settings.waitForFunction(async expected => {
      const options = (await chrome.storage.local.get("options")).options;
      return options?.popupTheme === "auto" && document.documentElement.dataset.hoshidictsTheme === expected;
    }, {}, scheme);
    automaticSettingsThemes.push(await settings.evaluate(async () => ({
      effective: document.documentElement.dataset.hoshidictsTheme,
      stored: (await chrome.storage.local.get("options")).options.popupTheme,
    })));
  }
  await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  assert.deepEqual(automaticSettingsThemes, [
    { effective: "light", stored: "auto" }, { effective: "dark", stored: "auto" },
  ], "overlay Settings follows the live browser preference from its first seeded options");
  await importFixture(settings);
  await enableMediaMining(settings);
  await showSection(settings, "media");
  await settings.waitForFunction(() =>
    [...document.querySelectorAll("#media button, #media input, #media select")].every(control => control.disabled));
  await settings.waitForFunction(() => {
    const status = document.getElementById("options-status").textContent;
    return !status.includes("Unsaved") && !status.includes("Saving");
  });
  const mediaSettings = await settings.evaluate(() => ({
    controlsDisabled: [...document.querySelectorAll("#media button, #media input, #media select")]
      .every(control => control.disabled),
    enabled: document.getElementById("opt-media-enabled").checked,
    note: document.getElementById("media-overlay-help").textContent,
    noteVisible: !document.getElementById("media-overlay-help").hidden,
    status: document.getElementById("media-runtime-status").textContent,
  }));
  if (process.env.HACHIDORI_OVERLAY_SETTINGS_SCREENSHOT) {
    await settings.setViewport({ width: 1280, height: 1200 });
    await settings.$eval("#media-heading", heading => heading.scrollIntoView({ block: "start" }));
    await settings.screenshot({ path: process.env.HACHIDORI_OVERLAY_SETTINGS_SCREENSHOT });
  }
  await showSection(settings, "keybinds");
  const keybindSettings = await settings.evaluate(() => ({
    browserDisabled: document.getElementById("browser-shortcuts").disabled,
    browserHelpVisible: !document.getElementById("browser-shortcuts-overlay-help").hidden,
    pageKeybindsEnabled: !document.getElementById("keybind-add").disabled,
  }));
  await showSection(settings, "design");
  await settings.type("#opt-custom-button-name", "Overlay editor");
  await settings.type("#opt-custom-button-url", "https://example.test/%w");
  await settings.click("#custom-button-submit");
  await settings.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
    { polling: 100, timeout: 10_000 });
  const designSettings = await settings.evaluate(() => ({
    customButtonsDisabled: document.getElementById("custom-buttons-settings").disabled,
    customButtonsHelpVisible: !document.getElementById("custom-buttons-overlay-help").hidden,
    savedButton: document.querySelector("#custom-button-list strong")?.textContent || "",
    themeEnabled: !document.getElementById("opt-popup-theme").disabled,
  }));
  await showSection(settings, "backup");
  const backupSettings = await settings.evaluate(() => ({
    exportDisabled: document.getElementById("backup-export").disabled,

    restoreEnabled: !document.getElementById("backup-file").disabled,
  }));
  await showSection(settings, "audio");
  const audioSettings = await settings.evaluate(() => ({
    sourceEditorEnabled: !document.getElementById("audio-source-add").disabled,
    speechHelpVisible: !document.getElementById("audio-mining-help").hidden,
  }));
  await showSection(settings, "anki");
  await settings.waitForFunction(() => document.getElementById("opt-anki-screenshot").disabled);
  const ankiSettings = await settings.evaluate(() => ({
    screenshotDisabled: document.getElementById("opt-anki-screenshot").disabled,
    screenshotEnabled: document.getElementById("opt-anki-screenshot").checked,
    screenshotHelp: document.getElementById("anki-screenshot-help").textContent,
  }));
  await showSection(settings, "lookup");
  const readingSettings = await settings.evaluate(() => ({
    readingEnabled: !document.getElementById("opt-hover-enabled").disabled,
    localFilePromptHidden: document.getElementById("settings-local-file-access").hidden,
    localFilePromptEmpty: document.getElementById("settings-local-file-access").childElementCount === 0,
  }));
  const guardedRequests = await settings.evaluate(() => Promise.all([
    chrome.runtime.sendMessage({ target: "hachidori-capture", type: "hd_capture_open", requestId: "overlay-ui-capture" }),

    chrome.runtime.sendMessage({
      target: "hoshidicts-worker", type: "hd_open_external", requestId: "overlay-ui-link",
      url: "https://example.test/", active: true,
    }),
  ]));
  assert.deepEqual(mediaSettings, {
    controlsDisabled: true,
    enabled: false,
    note: "Hachidori recording is unavailable in this embedded overlay. GameSentenceMiner owns game screenshots, recordings and sentence audio; these saved browser settings are left unchanged.",
    noteVisible: true,
    status: "Media capture is unavailable in this overlay.",
  });
  assert.deepEqual(keybindSettings, { browserDisabled: true, browserHelpVisible: true, pageKeybindsEnabled: true });
  assert.deepEqual(designSettings, {
    customButtonsDisabled: false,
    customButtonsHelpVisible: true,
    savedButton: "Overlay editor",
    themeEnabled: true,
  });
  assert.deepEqual(backupSettings, { exportDisabled: false, restoreEnabled: true });
  assert.deepEqual(audioSettings, { sourceEditorEnabled: true, speechHelpVisible: true });
  assert.equal(ankiSettings.screenshotDisabled, true);
  assert.equal(ankiSettings.screenshotEnabled, false);
  assert.match(ankiSettings.screenshotHelp, /unavailable in this overlay/u);
  assert.deepEqual(readingSettings, { readingEnabled: true, localFilePromptHidden: true, localFilePromptEmpty: true });
  assert.ok(guardedRequests[0].ok === false && guardedRequests[0].error.includes("unavailable in this overlay")
    && guardedRequests[1].ok === false && guardedRequests[1].error.includes("only from lookup popups"),
  JSON.stringify(guardedRequests));
  assert.equal(browser.targets().some(target => target.url().endsWith("/capture.html")), false,
    "disabled media controls never open a capture tab");
  // Setup never opens in an overlay: the host has no tab to show it in.
  assert.equal(browser.targets().some((target) => target.url().endsWith("/startup.html")), false,
    "overlay mode opens no startup page");
  // Blur is disabled for the pointer-ownership checks below.
  await editSettingsControls(settings, {
    "opt-blur-count": false,
    "opt-blur-anki": false,
    "opt-blur-frequency": false,
  });
  await settings.evaluate(async () => {
    const stored = await chrome.storage.local.get("options");
    const options = HDReaderOptions.normaliseOptions(stored.options);
    await chrome.storage.local.set({ options: {
      ...stored.options,
      customButtons: [{
        id: "remote-link", type: "link", label: "Remote link", url: "https://example.test/%w",
      }],
      customLinks: [{ label: "Remote link", url: "https://example.test/%w" }],
      mediaCapture: { ...options.mediaCapture, enabled: true },
      revision: options.revision + 1,
    } });
  });
  const configureOverlayAnki = model => settings.evaluate(async ({ modelName, url }) => {
    const { options } = await chrome.storage.local.get("options");
    const normalised = HDReaderOptions.normaliseOptions(options);
    const optionRevision = Number.isInteger(options?.revision) && options.revision >= 0 ? options.revision : 0;
    const template = value => ({ value, overwriteMode: "overwrite" });
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      requestId: `overlay-anki-${modelName || "disabled"}`,
      baseRevision: optionRevision,
      options: {
        anki: {
          ...normalised.anki,
          url,
          model: modelName,
          deck: "Default",
          fieldTemplates: {
            Front: template("{expression}"),
            Back: template("{glossary}"),
          },
        },
      },
    });
    if (!reply.ok) throw new Error(reply.error);
  }, { modelName: model, url: ankiUrl });
  await configureOverlayAnki("Basic");

  const tab = await browser.newPage();
  tab.on("console", (message) => diagnostics.push(`[page] ${message.type()}: ${message.text()}`));
  tab.on("pageerror", (error) => diagnostics.push(`[page] error: ${error.message}`));
  await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
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
  const waitForAnki = async predicate => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = await popup.anki();
      if (predicate(state)) return state;
      if (Date.now() >= deadline) throw new Error(`overlay Anki state did not settle: ${JSON.stringify(state)}`);
      await settle(50);
    }
  };
  const setKanjiFailure = mode => tab.evaluate(value => {
    if (value === null) delete document.documentElement.dataset.hachidoriKanjiFailure;
    else document.documentElement.dataset.hachidoriKanjiFailure = value;
  }, mode);

  overlayAnkiGate = Promise.withResolvers();
  const overlayPreflights = overlayAnkiCalls.filter(call => call.action === "canAddNotesWithErrorDetail").length;
  await tab.mouse.move(...middle(boxes[0]));
  const ankiPopup = await popup.waitForVisible(10_000);
  assert.ok(ankiPopup?.plain.includes("食べる"), `overlay Anki hover reads the boxed word: ${JSON.stringify(ankiPopup)}`);
  const automaticPopupThemes = [ankiPopup.theme];
  await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  const automaticThemeDeadline = Date.now() + 5000;
  while (automaticPopupThemes.at(-1) !== "dark" && Date.now() < automaticThemeDeadline) {
    await settle(50);
    automaticPopupThemes[1] = (await popup.state())?.theme;
  }
  assert.deepEqual(automaticPopupThemes, ["light", "dark"],
    "the open overlay popup follows a live browser preference change");
  await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  const loadingAnki = await waitForAnki(state => state?.state === "checking"
    && overlayAnkiCalls.filter(call => call.action === "canAddNotesWithErrorDetail").length > overlayPreflights);
  const loadingAnkiFocused = await popup.focusAnki();
  const mutationsBefore = overlayAnkiCalls.filter(call => ["addNote", "guiBrowse"].includes(call.action)).length;
  await popup.click(".gsm-hoshidicts-mine-button");
  await settle(100);
  const loadingAnkiInert = overlayAnkiCalls.filter(call => ["addNote", "guiBrowse"].includes(call.action)).length
    === mutationsBefore;
  if (process.env.HACHIDORI_OVERLAY_ANKI_LOADING_SCREENSHOT) {
    const { x, y, width, height } = loadingAnki.popupRect;
    await tab.screenshot({ path: process.env.HACHIDORI_OVERLAY_ANKI_LOADING_SCREENSHOT,
      clip: { x, y, width, height } });
  }
  overlayAnkiGate.resolve();
  overlayAnkiGate = null;
  const readyAnki = await waitForAnki(state => state?.state === "ready" && !state.disabled);
  const readyAnkiFocused = await popup.focusAnki();
  if (process.env.HACHIDORI_OVERLAY_ANKI_READY_SCREENSHOT) {
    const { x, y, width, height } = readyAnki.popupRect;
    await tab.screenshot({ path: process.env.HACHIDORI_OVERLAY_ANKI_READY_SCREENSHOT,
      clip: { x, y, width, height } });
  }
  assert.deepEqual({
    state: loadingAnki.state,
    icon: loadingAnki.icon,
    action: loadingAnki.action,
    disabled: loadingAnki.disabled,
    ariaBusy: loadingAnki.ariaBusy,
    ariaLabel: loadingAnki.ariaLabel,
    focused: loadingAnkiFocused,
    inert: loadingAnkiInert,
  }, {
    state: "checking",
    icon: "arrow-clockwise",
    action: "add",
    disabled: true,
    ariaBusy: "true",
    ariaLabel: "Checking Anki card status",
    focused: false,
    inert: true,
  }, "GSM overlay exposes the same disabled accessible Anki readiness action");
  assert.deepEqual({
    state: readyAnki.state,
    icon: readyAnki.icon,
    action: readyAnki.action,
    disabled: readyAnki.disabled,
    ariaBusy: readyAnki.ariaBusy,
    ariaLabel: readyAnki.ariaLabel,
    focused: readyAnkiFocused,
  }, {
    state: "ready",
    icon: "add",
    action: "add",
    disabled: false,
    ariaBusy: "false",
    ariaLabel: "Mine to Anki",
    focused: true,
  }, "GSM overlay resolves the readiness action to keyboard-focusable Add");
  console.log(`overlay Anki readiness ${JSON.stringify({ loading: loadingAnki, loadingAnkiFocused,
    loadingAnkiInert, ready: readyAnki, readyAnkiFocused, actions: overlayAnkiCalls.map(call => call.action) })}`);
  await tab.keyboard.press("Escape");
  assert.equal(await popup.waitForHidden(), true);
  assert.deepEqual(await events(), ["shown", "hidden"]);
  await configureOverlayAnki("");

  // Hovering still works, with the overlay's own delay.
  await tab.mouse.move(...middle(boxes[0]));
  const hovered = await popup.waitForVisible(10_000);
  assert.ok(hovered?.plain.includes("食べる"), `hover reads the boxed word: ${JSON.stringify(hovered)}`);
  const kanjiLink = await popup.rect(".gsm-hoshidicts-kanji-link");
  assert.ok(kanjiLink?.width > 0, `the popup exposes a physical kanji target: ${JSON.stringify(kanjiLink)}`);

  // A clicked-kanji transition is speculative until its reply can render. A
  // miss, malformed reply, or runtime messaging failure must retain the term
  // view and the host's popup claim instead of looking like an intentional
  // close. Exercise the real closed-shadow button with physical pointer input.
  for (const failure of ["empty", "malformed", "runtime"]) {
    await setKanjiFailure(failure);
    const beforeFailureEvents = await events();
    assert.deepEqual(beforeFailureEvents, failure === "empty" ? ["shown"] : []);
    const target = await popup.rect(".gsm-hoshidicts-kanji-link");
    await tab.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await tab.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    await settle();
    const retained = await popup.state();
    assert.ok(retained && !retained.hidden && retained.plain.includes("食べる")
      && retained.failureText?.includes("Kanji"),
    `${failure} kanji failure retains the current popup with an inline error: ${JSON.stringify(retained)}`);
    assert.deepEqual(await events(), [], `${failure} kanji failure does not publish an intentional close`);
  }
  await setKanjiFailure(null);

  // GSM can move native focus while an interactive lookup is still in flight.
  // A genuine top-level blur at that point must not discard the term view.
  await setKanjiFailure("slow-runtime");
  const guardedLink = await popup.rect(".gsm-hoshidicts-kanji-link");
  await tab.mouse.move(guardedLink.x + guardedLink.width / 2, guardedLink.y + guardedLink.height / 2);
  await tab.mouse.click(guardedLink.x + guardedLink.width / 2, guardedLink.y + guardedLink.height / 2);
  await settings.bringToFront();
  await settle(750);
  const afterInteractiveBlur = await popup.state();
  assert.ok(afterInteractiveBlur && !afterInteractiveBlur.hidden && afterInteractiveBlur.plain.includes("食べる")
    && afterInteractiveBlur.failureText?.includes("Kanji"),
    `window blur during popup interaction retains the view: ${JSON.stringify(afterInteractiveBlur)}`);
  assert.deepEqual(await events(), [], "interactive blur does not publish an intentional close");
  await setKanjiFailure(null);
  await tab.bringToFront();
  await settings.bringToFront();
  assert.equal(await popup.waitForHidden(), true, "a later genuine blur closes after the interaction settles");
  assert.deepEqual(await events(), ["hidden"], "the later blur publishes one intentional close");
  await tab.bringToFront();
  await tab.mouse.move(2, 2);
  await tab.mouse.move(...middle(boxes[0]));
  await popup.waitForVisible(10_000);
  await events();

  const physicalBefore = await popup.physicalTrace(".gsm-hoshidicts-kanji-link");
  await tab.mouse.click(kanjiLink.x + kanjiLink.width / 2, kanjiLink.y + kanjiLink.height / 2);
  const kanjiDeadline = Date.now() + 5_000;
  let kanjiView = await popup.state();
  while (kanjiView?.kanjiGlyph !== "食" && Date.now() < kanjiDeadline) {
    await settle(50);
    kanjiView = await popup.state();
  }
  const physicalAfter = await popup.trace();
  assert.equal(kanjiView?.kanjiGlyph, "食",
    `a real pointer click on ${kanjiLink?.text} opens its kanji view: ${JSON.stringify({ kanjiView, physicalBefore, physicalAfter })}`);
  assert.deepEqual(physicalAfter.requests.filter(request => ["hd_lookup_dictionary", "hd_kanji"].includes(request.type)), [
    { type: "hd_kanji", payload: { character: "食" }, target: "hoshidicts-offscreen" },
  ], `physical kanji lookup request: ${JSON.stringify(physicalAfter)}`);
  console.log(`physical kanji trace ${JSON.stringify({ before: physicalBefore, after: physicalAfter })}`);
  await popup.click(".gsm-hoshidicts-kanji-back");
  await popup.waitForVisible();

  // The same physical path must survive the blur reveal boundary. Keep the
  // lookup open while enabling a qualifying count condition, then create a new
  // popup so this click starts from genuinely blurred definitions.
  await tab.keyboard.press("Escape");
  assert.equal(await popup.waitForHidden(), true);
  await settings.evaluate(async () => {
    const stored = (await chrome.storage.local.get("options")).options;
    const optionRevision = Number.isInteger(stored?.revision) && stored.revision >= 0 ? stored.revision : 0;
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      requestId: "overlay-blur-physical-click",
      baseRevision: optionRevision,
      options: {
        showLookupCounts: true,
        definitionBlurEnabled: true,
        definitionBlurDirection: "atLeast",
        definitionBlurThreshold: 1,
        definitionBlurReveal: "hover",
      },
    });
    if (!reply.ok) throw new Error(reply.error);
  });
  await tab.bringToFront();
  await tab.mouse.move(2, 2);
  await tab.mouse.move(...middle(boxes[0]));
  const blurred = await popup.waitForVisible(10_000);
  assert.ok(blurred?.plain.includes("食べる"), `blurred hover reads the boxed word: ${JSON.stringify(blurred)}`);
  const blurredLink = await popup.rect(".gsm-hoshidicts-kanji-link");
  assert.ok(blurredLink?.width > 0, `blurred popup exposes a physical kanji target: ${JSON.stringify(blurredLink)}`);
  const blurredBefore = await popup.physicalTrace(".gsm-hoshidicts-kanji-link");
  await tab.mouse.move(blurredLink.x + blurredLink.width / 2, blurredLink.y + blurredLink.height / 2);
  await settle(100);
  await tab.mouse.click(blurredLink.x + blurredLink.width / 2, blurredLink.y + blurredLink.height / 2);
  const blurredDeadline = Date.now() + 5_000;
  let blurredKanji = await popup.state();
  while (blurredKanji?.kanjiGlyph !== "食" && Date.now() < blurredDeadline) {
    await settle(50);
    blurredKanji = await popup.state();
  }
  const blurredAfter = await popup.trace();
  assert.equal(blurredKanji?.kanjiGlyph, "食",
    `a real pointer reveal and click opens the kanji view: ${JSON.stringify({ blurredKanji, blurredBefore, blurredAfter })}`);
  assert.deepEqual(blurredAfter.requests.filter(request => ["hd_lookup_dictionary", "hd_kanji"].includes(request.type)), [
    { type: "hd_kanji", payload: { character: "食" }, target: "hoshidicts-offscreen" },
  ], `blurred physical kanji lookup request: ${JSON.stringify(blurredAfter)}`);
  console.log(`blurred physical kanji trace ${JSON.stringify({ before: blurredBefore, after: blurredAfter })}`);
  await popup.click(".gsm-hoshidicts-kanji-back");
  await popup.waitForVisible();
  assert.equal(hovered.linkButtons, 1, "stored or remotely shared link buttons render in the overlay popup");
  assert.deepEqual(await events(), ["hidden", "shown"]);
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
  overlayAnkiGate?.resolve();
  overlayAnkiGate = null;
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
