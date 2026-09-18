/*
 * Real Chrome + real AnkiConnect acceptance path for Custom buttons and Anki
 * Templates. This is intentionally separate from the hermetic Chrome suite:
 * callers provide an isolated Anki endpoint and this harness creates only its
 * fixed disposable decks, note types, notes and media.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const PROFILE = process.env.HACHIDORI_CUSTOM_BUTTONS_PROFILE
  || resolve(tmpdir(), `hachidori-custom-buttons-profile-${process.pid}`);
const REUSE_PROFILE = process.env.HACHIDORI_CUSTOM_BUTTONS_REUSE_PROFILE === "1";
const EVIDENCE = process.env.HACHIDORI_CUSTOM_BUTTONS_EVIDENCE_DIR || "";
const ANKI_URL = process.env.HACHIDORI_ANKI_URL || "";
const PAGE_URL = "http://127.0.0.1:18774/";
const WORD_DECK = "Hachidori I23 Words";
const SENTENCE_DECK = "Hachidori I23 Sentences";
const WORD_MODEL = "Hachidori I23 Word";
const SENTENCE_MODEL = "Hachidori I23 Sentence";
const E2E_TAG = "hachidori-i23-e2e";
const WORD_DRAFT = " \tword {expression}{expression} {unknown}\n literal  ";
const SENTENCE_DRAFT = "\n sentence {sentence}{sentence} {unknown}\t ";
const WORD_EXPRESSION_MAPPING = "word [{expression}] + [{expression}]";
const WORD_SOURCE_MAPPING = " \tcontext {sentence} + {sentence}\n ";
const SENTENCE_MAPPING = "\ncontext {sentence} + {sentence}\t";
const SENTENCE_EXPRESSION_MAPPING = "selected [{expression}]";
const MINED_SENTENCE = "昨日、<b>食べたかった</b>。とてもおいしかった。";
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const diagnostics = [];

const PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Hachidori Custom buttons and Templates</title>
  <style>
    body { margin: 0; padding: 96px; font: 34px/2 system-ui, sans-serif; }
    #sentence { max-width: 920px; }
    #word { display: inline-block; padding: 4px 8px; }
  </style>
</head>
<body>
  <p id="sentence">昨日、<span id="word">食べたかった</span>。とてもおいしかった。</p>
</body>
</html>`;

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
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || PUPPETEER_CANDIDATES.find(existsSync) || PUPPETEER_CANDIDATES[0];

function requireEnvironment() {
  if (!ANKI_URL) throw new Error("set HACHIDORI_ANKI_URL to an explicitly configured isolated AnkiConnect endpoint");
  const endpoint = new URL(ANKI_URL);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
    throw new Error("HACHIDORI_ANKI_URL must be an explicit http://127.0.0.1 endpoint");
  }
  if (!CHROME || !existsSync(CHROME)) {
    throw new Error("no Chrome found (set HACHIDORI_CHROME or install it as described in test/README.md)");
  }
  if (!existsSync(PUPPETEER)) {
    throw new Error(`no puppeteer-core at ${PUPPETEER} (set HACHIDORI_PUPPETEER)`);
  }
  if (!existsSync(FIXTURE)) throw new Error(`missing ${FIXTURE}; run node test/make-fixture.mjs`);
}

async function anki(action, params = {}) {
  const response = await fetch(ANKI_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`AnkiConnect ${action} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error !== null) throw new Error(`AnkiConnect ${action}: ${payload.error}`);
  return payload.result;
}

async function prepareAnki() {
  const version = await anki("version");
  assert.equal(version, 6, "AnkiConnect API version");
  const existing = await anki("findNotes", { query: `tag:${E2E_TAG}` });
  if (existing.length > 0) await anki("deleteNotes", { notes: existing });
  await anki("createDeck", { deck: WORD_DECK });
  await anki("createDeck", { deck: SENTENCE_DECK });

  const definitions = [
    {
      name: WORD_MODEL,
      fields: ["Expression", "Reading", "Glossary", "Source"],
      front: "{{Expression}}",
      back: "{{FrontSide}}<hr>{{Reading}}<br>{{Glossary}}<br>{{Source}}",
    },
    {
      name: SENTENCE_MODEL,
      fields: ["Sentence", "Expression", "Glossary", "Screenshot"],
      front: "{{Sentence}}",
      back: "{{FrontSide}}<hr>{{Expression}}<br>{{Glossary}}<br>{{Screenshot}}",
    },
  ];
  const names = new Set(await anki("modelNames"));
  for (const definition of definitions) {
    if (!names.has(definition.name)) {
      await anki("createModel", {
        modelName: definition.name,
        inOrderFields: definition.fields,
        css: ".card { font-family: sans-serif; font-size: 24px; } img { max-width: 100%; }",
        cardTemplates: [{
          Name: "Card 1",
          Front: definition.front,
          Back: definition.back,
        }],
      });
    }
    assert.deepEqual(await anki("modelFieldNames", { modelName: definition.name }), definition.fields);
  }
  return { apiVersion: version, models: definitions.map(({ name }) => name), decks: [WORD_DECK, SENTENCE_DECK] };
}

async function waitForAnkiModel(modelName, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const noteIds = await anki("findNotes", { query: `tag:${E2E_TAG}` });
    const notes = noteIds.length === 0 ? [] : await anki("notesInfo", { notes: noteIds });
    const note = notes.find(candidate => candidate.modelName === modelName);
    if (note) return note;
    if (Date.now() >= deadline) {
      throw new Error(`Anki never received the ${modelName} note; current models: ${
        notes.map(candidate => candidate.modelName).join(", ") || "(none)"}`);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
}

function launchArguments() {
  return [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
  ];
}

async function extensionId(browser) {
  const target = await browser.waitForTarget(
    candidate => candidate.type() === "service_worker" && candidate.url().startsWith("chrome-extension://"),
    { timeout: 30_000 },
  );
  return new URL(target.url()).host;
}

async function showSection(page, id) {
  await page.evaluate((section) => {
    const picker = document.getElementById("settings-section");
    if (picker.checkVisibility()) {
      picker.value = section;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      document.querySelector(`.settings-nav a[href="#${section}"], #library-navigation a[href="#${section}"]`).click();
    }
  }, id);
  await page.waitForFunction((section) => {
    const visible = [...document.querySelectorAll("main > section")].filter(node => !node.hidden);
    return visible.length === 1 && visible[0].id === section;
  }, { timeout: 30_000, polling: 50 }, id);
}

async function openSettings(browser, id) {
  const page = await browser.newPage();
  page.on("console", message => diagnostics.push(`[settings] ${message.type()}: ${message.text()}`));
  page.on("pageerror", error => diagnostics.push(`[settings] pageerror: ${error.message}`));
  await page.setViewport({ width: 1440, height: 1200 });
  await page.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => {
      const status = document.getElementById("engine-status");
      const text = status?.textContent?.toLowerCase() || "";
      return text.includes("ready") || status?.classList.contains("is-error");
    }, { timeout: 90_000 });
  } catch (error) {
    const detail = await page.evaluate(async () => ({
      engineStatus: document.getElementById("engine-status")?.textContent || "",
      engineClass: document.getElementById("engine-status")?.className || "",
      importState: document.getElementById("import-state")?.textContent || "",
      options: (await chrome.storage.local.get("options")).options ?? null,
      readyState: document.readyState,
    }));
    if (detail.engineStatus.toLowerCase().includes("ready")
        && !detail.engineClass.split(/\s+/u).includes("is-error")) {
      return page;
    }
    throw new Error(`Settings engine did not settle: ${JSON.stringify(detail)}`, { cause: error });
  }
  return page;
}

async function importFixture(page) {
  if ((await page.$eval("#engine-status", status => status.textContent)).includes("1 dictionary enabled")) return;
  await showSection(page, "add-dictionaries");
  await page.waitForSelector("#import-file", { visible: true });
  await (await page.$("#import-file")).uploadFile(FIXTURE);
  await page.waitForFunction(
    () => document.getElementById("import-state")?.textContent?.trim()
      === "Finished 1 of 1 archive — 1 imported, 0 failed.",
    { timeout: 120_000, polling: 100 },
  );
  await page.waitForFunction(
    () => document.getElementById("engine-status")?.textContent?.includes("1 dictionary enabled"),
    { timeout: 90_000, polling: 100 },
  );
}

async function writeOptions(page, patch) {
  return page.evaluate(async (optionsPatch) => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      requestId: `custom-buttons-e2e-${crypto.randomUUID()}`,
      baseRevision: Number.isInteger(options?.revision) ? options.revision : 0,
      options: optionsPatch,
    });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options;
  }, patch);
}

async function storedOptions(page) {
  return page.evaluate(async () => (await chrome.storage.local.get("options")).options);
}

async function waitForStored(page, predicate, argument) {
  await page.waitForFunction(predicate, { timeout: 15_000, polling: 50 }, argument);
}

async function replaceText(page, selector, value) {
  await page.focus(selector);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
  await page.keyboard.type(value);
  await page.keyboard.press("Tab");
}

async function keyboardActivate(page, selector) {
  await page.focus(selector);
  const before = await page.evaluate(() => ({
    id: document.activeElement?.id || "",
    label: document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim() || "",
  }));
  await page.keyboard.press("Enter");
  return before;
}

async function insertText(page, text) {
  const session = await page.createCDPSession();
  try {
    await session.send("Input.insertText", { text });
  } finally {
    await session.detach();
  }
}

const fieldSelector = field => `#anki-templates [data-anki-field="${field}"] [role="combobox"]`;

async function waitForMapping(page, field, value) {
  await waitForStored(page, async expected => {
    const { options } = await chrome.storage.local.get("options");
    const selected = document.getElementById("anki-template-select").value;
    return options.anki.templates.find(template => template.id === selected)
      ?.fieldTemplates?.[expected.field]?.value === expected.value;
  }, { field, value });
}

async function editMapping(page, field, value, inputType = "insertText") {
  await page.$eval(fieldSelector(field), (node, [text, type]) => {
    node.focus();
    node.value = text;
    node.setSelectionRange(text.length, text.length);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type, data: text }));
  }, [value, inputType]);
  await waitForMapping(page, field, value);
}

async function accessibilityNode(page, selector) {
  const session = await page.createCDPSession();
  try {
    await session.send("DOM.enable");
    await session.send("Accessibility.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { node } = await session.send("DOM.describeNode", { nodeId });
    const { nodes } = await session.send("Accessibility.getPartialAXTree", {
      backendNodeId: node.backendNodeId,
      fetchRelatives: false,
    });
    const ax = nodes.find(candidate => !candidate.ignored) ?? nodes[0];
    const property = name => ax?.properties?.find(candidate => candidate.name === name)?.value?.value ?? null;
    return {
      role: ax?.role?.value ?? null,
      name: ax?.name?.value ?? null,
      expanded: property("expanded"),
      focusable: property("focusable"),
    };
  } finally {
    await session.detach();
  }
}

async function exerciseMarkerComboboxes(settings) {
  await settings.waitForFunction(() => {
    const fields = [...document.querySelectorAll("#anki-templates [data-anki-field]")]
      .map(node => node.dataset.ankiField);
    return ["Expression", "Reading", "Glossary", "Source"].every(field => fields.includes(field));
  }, { timeout: 20_000, polling: 100 });
  const contract = await settings.evaluate(async () => {
    const { ANKI_TEMPLATE_MARKER_OPTIONS, ANKI_TEMPLATE_MARKERS } = await import("./anki-templates.js");
    const rows = [...document.querySelectorAll("#anki-templates [data-anki-field]")];
    const control = rows[0].querySelector('[role="combobox"]');
    const listbox = document.getElementById(control.getAttribute("aria-controls"));
    const options = [...listbox.querySelectorAll('[role="option"]')];
    return {
      fields: rows.map(row => row.dataset.ankiField),
      allEditable: rows.every(row => {
        const editor = row.querySelector('[role="combobox"]');
        return editor && !editor.readOnly && !editor.disabled;
      }),
      options: options.map(option => option.dataset.marker),
      expected: ANKI_TEMPLATE_MARKER_OPTIONS.map(option => option.value),
      core: ANKI_TEMPLATE_MARKERS.map(marker => `{${marker}}`),
      described: options.every(option => option.getAttribute("aria-label")?.includes(": ")),
      label: document.querySelector(`label[for="${control.id}"]`)?.textContent,
      expanded: control.getAttribute("aria-expanded"),
      controls: control.getAttribute("aria-controls"),
      autocomplete: control.getAttribute("aria-autocomplete"),
      haspopup: control.getAttribute("aria-haspopup"),
      listboxRole: listbox.getAttribute("role"),
      statusRole: control.closest(".anki-template-row").querySelector('[role="status"]').getAttribute("role"),
    };
  });

  const expression = fieldSelector("Expression");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await settings.focus(expression);
  await settings.keyboard.down(modifier);
  await settings.keyboard.press("KeyA");
  await settings.keyboard.up(modifier);
  await settings.keyboard.type("{expr");
  await settings.waitForFunction(selector =>
    document.querySelector(selector).getAttribute("aria-expanded") === "true", {}, expression);
  const filtered = await settings.$eval('#anki-templates [data-anki-field="Expression"]', node => {
    const control = node.querySelector('[role="combobox"]');
    const listbox = document.getElementById(control.getAttribute("aria-controls"));
    const visible = [...listbox.querySelectorAll('[role="option"]')].filter(option => !option.hidden);
    return {
      value: control.value,
      markers: visible.map(option => option.dataset.marker),
      active: control.getAttribute("aria-activedescendant"),
      selected: visible.filter(option => option.getAttribute("aria-selected") === "true").map(option => option.id),
      status: node.querySelector('[role="status"]').textContent,
    };
  });
  await settings.keyboard.press("Escape");
  await waitForMapping(settings, "Expression", "{expr");
  const escaped = await settings.$eval(expression, node => ({
    value: node.value,
    expanded: node.getAttribute("aria-expanded"),
  }));

  const freeForm = "literal {expression} + suffix  ";
  await settings.focus(expression);
  await settings.keyboard.down(modifier);
  await settings.keyboard.press("KeyA");
  await settings.keyboard.up(modifier);
  await insertText(settings, freeForm);
  await waitForMapping(settings, "Expression", freeForm);
  const highlightedBeforeTab = await settings.$eval(expression,
    node => node.getAttribute("aria-activedescendant"));
  await settings.keyboard.press("Tab");
  const tabExit = await settings.evaluate(async selector => {
    const control = document.querySelector(selector);
    const { options } = await chrome.storage.local.get("options");
    const selected = document.getElementById("anki-template-select").value;
    return {
      value: control.value,
      stored: options.anki.templates.find(template => template.id === selected)
        .fieldTemplates.Expression.value,
      expanded: control.getAttribute("aria-expanded"),
      leftControl: document.activeElement !== control,
      focused: document.activeElement?.id ?? "",
    };
  }, expression);

  await editMapping(settings, "Source", "before  after");
  await settings.$eval(fieldSelector("Source"), node => node.setSelectionRange(7, 7));
  await settings.click('#anki-templates [data-anki-field="Source"] [role="option"][data-marker="{sentence}"]');
  await waitForMapping(settings, "Source", "before {sentence} after");
  const pointerValue = await settings.$eval(fieldSelector("Source"), node => node.value);

  await editMapping(settings, "Source", "{expression}{expression}");
  await settings.$eval(fieldSelector("Source"), node => {
    const boundary = "{expression}".length;
    node.setSelectionRange(boundary, boundary);
  });
  await settings.click('#anki-templates [data-anki-field="Source"] [role="option"][data-marker="{reading}"]');
  await waitForMapping(settings, "Source", "{expression}{reading}{expression}");
  const adjacentMarkerValue = await settings.$eval(fieldSelector("Source"), node => node.value);

  await editMapping(settings, "Source", "");
  await settings.keyboard.press("Escape");
  await settings.focus(fieldSelector("Source"));
  await settings.keyboard.press("ArrowDown");
  const keyboardFirst = await settings.$eval(fieldSelector("Source"),
    node => node.getAttribute("aria-activedescendant"));
  await settings.keyboard.press("ArrowDown");
  const keyboardSecond = await settings.$eval(fieldSelector("Source"),
    node => node.getAttribute("aria-activedescendant"));
  await settings.keyboard.press("Enter");
  const keyboardValue = await settings.$eval(fieldSelector("Source"), node => node.value);
  await waitForMapping(settings, "Source", keyboardValue);

  await editMapping(settings, "Expression", "{definitely-no-marker");
  const empty = await settings.$eval('#anki-templates [data-anki-field="Expression"]', node => ({
    visible: !node.querySelector(".anki-marker-empty").hidden,
    active: node.querySelector('[role="combobox"]').getAttribute("aria-activedescendant"),
    status: node.querySelector('[role="status"]').textContent,
  }));
  await settings.keyboard.press("Escape");

  const reading = fieldSelector("Reading");
  await settings.focus(reading);
  await settings.keyboard.down(modifier);
  await settings.keyboard.press("KeyA");
  await settings.keyboard.up(modifier);
  await insertText(settings, WORD_DRAFT);
  await waitForMapping(settings, "Reading", WORD_DRAFT);
  await settings.keyboard.down(modifier);
  await settings.keyboard.press("KeyA");
  await settings.keyboard.press("KeyC");
  await settings.keyboard.up(modifier);
  await settings.focus(expression);
  await settings.keyboard.down(modifier);
  await settings.keyboard.press("KeyA");
  await settings.keyboard.press("KeyV");
  await settings.keyboard.up(modifier);
  await waitForMapping(settings, "Expression", WORD_DRAFT);
  const clipboard = await settings.evaluate(async selector => {
    const control = document.querySelector(selector);
    const { options } = await chrome.storage.local.get("options");
    const selected = document.getElementById("anki-template-select").value;
    const mappings = options.anki.templates.find(template => template.id === selected).fieldTemplates;
    return {
      control: control.value,
      expression: mappings.Expression.value,
      reading: mappings.Reading.value,
      invalid: control.getAttribute("aria-invalid"),
      error: control.closest(".anki-template-row").querySelector(".anki-template-error").textContent,
      status: document.getElementById("anki-status").textContent,
    };
  }, expression);

  await editMapping(settings, "Glossary", "composition: ");
  const glossary = fieldSelector("Glossary");
  await settings.$eval(glossary, node => {
    node.focus();
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    node.value = "composition: 日本";
    node.setSelectionRange(node.value.length, node.value.length);
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertCompositionText",
      data: "日本",
      isComposing: true,
    }));
  });
  const compositionDuring = await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const selected = document.getElementById("anki-template-select").value;
    return options.anki.templates.find(template => template.id === selected).fieldTemplates.Glossary.value;
  });
  await settings.$eval(glossary, node => {
    node.value = "composition: 日本語\t";
    node.setSelectionRange(node.value.length, node.value.length);
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }));
  });
  await waitForMapping(settings, "Glossary", "composition: 日本語\t");
  const compositionAfter = await settings.$eval(glossary, node => node.value);

  await editMapping(settings, "Reading", "{reading}");
  await editMapping(settings, "Glossary", "{glossary}");
  await editMapping(settings, "Source", "{sentence}");
  await editMapping(settings, "Expression", WORD_DRAFT, "insertFromPaste");
  await settings.keyboard.press("Escape");
  await settings.click('#anki-templates [data-anki-field="Expression"] .anki-marker-combobox-toggle');
  const opened = await settings.$eval(expression, node => ({
    expanded: node.getAttribute("aria-expanded"),
    listboxHidden: document.getElementById(node.getAttribute("aria-controls")).hidden,
  }));
  const accessibility = await accessibilityNode(settings, expression);
  const markerScreenshot = await screenshotElement(settings, "#anki-field-mapping", "marker-combobox-settings.png");
  await settings.keyboard.press("Escape");

  assert.equal(contract.allEditable, true);
  assert.deepEqual(contract.options, contract.expected);
  assert.ok(contract.core.every(marker => contract.options.includes(marker)));
  assert.equal(contract.described, true);
  assert.equal(contract.label, "Expression");
  assert.equal(contract.expanded, "false");
  assert.equal(contract.autocomplete, "list");
  assert.equal(contract.haspopup, "listbox");
  assert.equal(contract.listboxRole, "listbox");
  assert.equal(contract.statusRole, "status");
  assert.deepEqual(filtered.markers, ["{expression}"]);
  assert.equal(filtered.active, filtered.selected[0]);
  assert.match(filtered.status, /1 marker suggestion/u);
  assert.deepEqual(escaped, { value: "{expr", expanded: "false" });
  assert.ok(highlightedBeforeTab);
  assert.equal(tabExit.value, freeForm);
  assert.equal(tabExit.stored, freeForm);
  assert.equal(tabExit.expanded, "false");
  assert.equal(tabExit.leftControl, true);
  assert.equal(pointerValue, "before {sentence} after");
  assert.equal(adjacentMarkerValue, "{expression}{reading}{expression}");
  assert.ok(keyboardFirst);
  assert.notEqual(keyboardSecond, keyboardFirst);
  assert.notEqual(keyboardValue, "");
  assert.equal(empty.visible, true);
  assert.equal(empty.active, null);
  assert.match(empty.status, /No marker suggestions/u);
  assert.equal(clipboard.control, WORD_DRAFT);
  assert.equal(clipboard.expression, WORD_DRAFT);
  assert.equal(clipboard.reading, WORD_DRAFT);
  assert.equal(clipboard.invalid, "true");
  assert.match(clipboard.error, /Unknown marker: \{unknown\}/u);
  assert.match(clipboard.status, /Unknown marker/u);
  assert.equal(compositionDuring, "composition: ");
  assert.equal(compositionAfter, "composition: 日本語\t");
  assert.deepEqual(opened, { expanded: "true", listboxHidden: false });
  assert.deepEqual(accessibility, {
    role: "combobox",
    name: "Expression",
    expanded: true,
    focusable: true,
  });

  return {
    contract,
    filtered,
    escaped,
    highlightedBeforeTab,
    tabExit,
    pointerValue,
    adjacentMarkerValue,
    keyboardFirst,
    keyboardSecond,
    keyboardValue,
    empty,
    clipboard,
    compositionDuring,
    compositionAfter,
    opened,
    accessibility,
    markerScreenshot,
    wordDraft: WORD_DRAFT,
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function measureTemplateSwitching(page, cycles = 40) {
  return page.evaluate(async (count) => {
    const durations = [];
    const select = document.getElementById("anki-template-select");
    const previous = document.getElementById("anki-template-previous");
    const next = document.getElementById("anki-template-next");
    const manager = document.getElementById("anki-template-manager");
    for (let index = 0; index < count; index += 1) {
      const control = select.selectedIndex === 0 ? next : previous;
      const started = performance.now();
      control.click();
      await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      manager.getBoundingClientRect();
      durations.push(performance.now() - started);
    }
    return durations;
  }, cycles).then(durations => ({
    cycles,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: Math.max(...durations),
    samplesMs: durations,
  }));
}

async function screenshotElement(page, selector, name) {
  if (!EVIDENCE) return "";
  const path = resolve(EVIDENCE, name);
  const element = await page.$(selector);
  if (!element) throw new Error(`could not screenshot missing ${selector}`);
  await element.screenshot({ path });
  return path;
}

async function popupReader(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("DOM.enable");
  await cdp.send("Runtime.enable");

  async function resolvePopupObject() {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    let nodeId = null;
    const walk = node => {
      const attributes = node.attributes || [];
      for (let index = 0; index < attributes.length; index += 2) {
        if (attributes[index] === "class"
            && String(attributes[index + 1]).includes("gsm-hoshidicts-popup")
            && attributes[attributes.indexOf("data-hoshidicts-depth") + 1] === "0") {
          nodeId = node.nodeId;
        }
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
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration,
      arguments: args.map(value => ({ value })),
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  const state = () => call(`function () {
    const stripped = this.cloneNode(true);
    for (const rt of stripped.querySelectorAll("rt, rp")) rt.remove();
    const action = button => ({
      id: button.dataset.customButtonId || "built-in",
      type: button.classList.contains("gsm-hoshidicts-custom-anki-button")
        ? "anki"
        : button.classList.contains("gsm-hoshidicts-external-link-button") ? "link" : "built-in",
      label: button.textContent.trim(),
      state: button.dataset.state || "",
      disabled: button.disabled,
      ariaBusy: button.getAttribute("aria-busy"),
      ariaLabel: button.getAttribute("aria-label"),
    });
    const bounds = this.getBoundingClientRect();
    return {
      hidden: this.hasAttribute("hidden"),
      height: bounds.height,
      rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      plain: (stripped.textContent || "").replace(/\\s+/g, " ").trim(),
      feedback: this.querySelector(".gsm-hoshidicts-mining-feedback")?.textContent?.replace(/\\s+/g, " ").trim() || "",
      actions: [...this.querySelectorAll(
        ".gsm-hoshidicts-mine-button, .gsm-hoshidicts-external-link-button, .gsm-hoshidicts-custom-anki-button",
      )].map(action),
    };
  }`);

  async function waitFor(predicate, description, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await state();
      if (current && !current.hidden && current.height > 0 && predicate(current)) return current;
      if (Date.now() >= deadline) {
        throw new Error(`${description}: ${JSON.stringify(current)}`);
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }

  const focus = selector => call(`function (target) {
    const button = this.querySelector(target);
    button?.focus();
    return button?.getRootNode().activeElement === button;
  }`, [selector]);
  const rect = selector => call(`function (target) {
    const button = this.querySelector(target);
    if (!button) return null;
    const bounds = button.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }`, [selector]);

  return { state, waitFor, focus, rect, detach: () => cdp.detach() };
}

async function waitForContentWorld(page, extensionId) {
  const session = await page.createCDPSession();
  const contexts = new Set();
  session.on("Runtime.executionContextCreated", ({ context }) => contexts.add(context.id));
  session.on("Runtime.executionContextDestroyed", ({ executionContextId }) => contexts.delete(executionContextId));
  await session.send("Runtime.enable");
  const deadline = Date.now() + 15_000;
  try {
    for (;;) {
      for (const contextId of [...contexts]) {
        try {
          const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
            contextId,
            expression: `(async () => {
              if (globalThis.chrome?.runtime?.id !== ${JSON.stringify(extensionId)}
                  || typeof globalThis.HDPopup !== "object") return null;
              await globalThis.HDReaderReady;
              const { options } = await chrome.storage.local.get("options");
              const projected = HDReaderOptions.normaliseOptions(options);
              return {
                extensionId: chrome.runtime.id,
                hoverEnabled: projected.hoverEnabled,
                lookupMode: projected.lookupMode,
                templates: projected.anki.templates.length,
                customButtons: projected.customButtons.length,
              };
            })()`,
            awaitPromise: true,
            returnByValue: true,
          });
          if (!exceptionDetails && result.value?.extensionId === extensionId) return result.value;
        } catch {
          contexts.delete(contextId);
        }
      }
      if (Date.now() >= deadline) throw new Error("Hachidori content world did not load on the reader page");
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  } finally {
    await session.detach();
  }
}

async function configureThroughSettings(settings) {
  const fields = {
    expression: "Expression",
    reading: "Reading",
    definition: "Glossary",
    sentence: "Source",
    frequency: "",
    pitch: "",
    audio: "",
    captureAnimation: "",
    captureAudio: "",
    screenshot: "",
  };
  const legacy = {
    url: ANKI_URL,
    apiKey: "",
    deck: WORD_DECK,
    model: WORD_MODEL,
    tags: [E2E_TAG, "word-template"],
    fields,
    duplicateScope: "model",
    duplicateBehavior: "new",
    captureScreenshot: false,
    fieldTemplates: null,
  };
  await writeOptions(settings, {
    lookupMode: "hover",
    hoverEnabled: true,
    customLinks: [{
      label: "Dictionary search",
      url: "https://example.test/search/%w",
    }],
    anki: legacy,
  });
  await settings.reload({ waitUntil: "domcontentloaded" });
  await settings.waitForFunction(() => typeof document.defaultView.HDReaderOptions?.normaliseOptions === "function");

  const migrated = await storedOptions(settings);
  const { url: _url, apiKey: _apiKey, ...legacyTemplate } = legacy;
  assert.equal(migrated.anki.templates.length, 1);
  assert.deepEqual(migrated.anki.templates[0], {
    id: "default",
    name: "Default",
    ...legacyTemplate,
  });
  assert.deepEqual(migrated.customButtons, [{
    id: "legacy-link-1",
    type: "link",
    label: "Dictionary search",
    url: "https://example.test/search/%w",
  }]);

  await showSection(settings, "anki");
  await settings.waitForFunction(
    () => document.getElementById("anki-status")?.textContent?.includes("Connected"),
    { timeout: 20_000, polling: 100 },
  );
  await replaceText(settings, "#opt-anki-template-name", "Words");
  await waitForStored(settings, async () => {
    const { options } = await chrome.storage.local.get("options");
    return options.anki.templates[0].name === "Words";
  });
  const combobox = await exerciseMarkerComboboxes(settings);

  const keyboard = {
    duplicate: await keyboardActivate(settings, "#anki-template-duplicate"),
  };
  await waitForStored(settings, async () => {
    const { options } = await chrome.storage.local.get("options");
    return options.anki.templates.length === 2;
  });
  await replaceText(settings, "#opt-anki-template-name", "Sentences");
  await waitForStored(settings, async () => {
    const { options } = await chrome.storage.local.get("options");
    return options.anki.templates[1].name === "Sentences";
  });

  keyboard.add = await keyboardActivate(settings, "#anki-template-add");
  await waitForStored(settings, async () => {
    const { options } = await chrome.storage.local.get("options");
    return options.anki.templates.length === 3;
  });
  await replaceText(settings, "#opt-anki-template-name", "Scratch");
  keyboard.move = await keyboardActivate(settings, "#anki-template-up");
  keyboard.remove = await keyboardActivate(settings, "#anki-template-delete");
  await waitForStored(settings, async () => {
    const { options } = await chrome.storage.local.get("options");
    return options.anki.templates.length === 2
      && options.anki.templates.map(template => template.name).join(",") === "Words,Sentences";
  });

  keyboard.previous = await keyboardActivate(settings, "#anki-template-previous");
  assert.equal(await settings.$eval("#anki-template-select", select => select.value),
    (await storedOptions(settings)).anki.templates[0].id);
  keyboard.next = await keyboardActivate(settings, "#anki-template-next");

  await settings.select("#opt-anki-model", SENTENCE_MODEL);
  await waitForStored(settings, async model => {
    const { options } = await chrome.storage.local.get("options");
    return options.anki.templates[1].model === model;
  }, SENTENCE_MODEL);
  await settings.waitForFunction(
    () => [...document.querySelectorAll("#anki-templates [data-anki-field]")]
      .some(row => row.dataset.ankiField === "Sentence"),
    { timeout: 20_000, polling: 100 },
  );
  await settings.select("#opt-anki-deck", SENTENCE_DECK);
  for (const [field, value] of [
    ["Sentence", SENTENCE_DRAFT],
    ["Expression", "{expression}"],
    ["Glossary", "{glossary}"],
    ["Screenshot", "{screenshot}"],
  ]) {
    await editMapping(settings, field, value);
  }
  await replaceText(settings, "#opt-anki-tags", `${E2E_TAG} sentence-draft`);
  await waitForStored(settings, async expected => {
    const { options } = await chrome.storage.local.get("options");
    const selected = options.anki.templates[1];
    return selected.deck === expected.deck
      && selected.fieldTemplates.Sentence.value === expected.mapping
      && selected.fieldTemplates.Expression.value === "{expression}"
      && selected.fieldTemplates.Glossary.value === "{glossary}"
      && selected.tags.join(" ") === expected.tags;
  }, {
    deck: SENTENCE_DECK,
    mapping: SENTENCE_DRAFT,
    tags: `${E2E_TAG} sentence-draft`,
  });

  let current = await storedOptions(settings);
  let [word, sentence] = current.anki.templates;
  assert.equal(word.fieldTemplates.Expression.value, WORD_DRAFT);
  assert.equal(sentence.fieldTemplates.Sentence.value, SENTENCE_DRAFT);
  await settings.select("#anki-template-select", word.id);
  await settings.waitForFunction(expected =>
    document.querySelector('#anki-templates [data-anki-field="Expression"] [role="combobox"]')?.value === expected,
  {}, WORD_DRAFT);
  await settings.select("#anki-template-select", sentence.id);
  await settings.waitForFunction(expected =>
    document.querySelector('#anki-templates [data-anki-field="Sentence"] [role="combobox"]')?.value === expected,
  {}, SENTENCE_DRAFT);
  await settings.reload({ waitUntil: "domcontentloaded" });
  await showSection(settings, "anki");
  await settings.select("#anki-template-select", sentence.id);
  await settings.waitForFunction(expected =>
    document.querySelector('#anki-templates [data-anki-field="Sentence"] [role="combobox"]')?.value === expected,
  {}, SENTENCE_DRAFT);
  current = await storedOptions(settings);
  [word, sentence] = current.anki.templates;
  const preservation = {
    word: word.fieldTemplates.Expression.value,
    sentence: sentence.fieldTemplates.Sentence.value,
    sentenceTags: sentence.tags,
    reloadedControl: await settings.$eval(fieldSelector("Sentence"), node => node.value),
  };
  assert.equal(preservation.word, WORD_DRAFT);
  assert.equal(preservation.sentence, SENTENCE_DRAFT);
  assert.equal(preservation.reloadedControl, SENTENCE_DRAFT);

  await showSection(settings, "design");
  await settings.focus("#opt-custom-button-name");
  await settings.keyboard.type("Sentence card");
  await settings.select("#opt-custom-button-type", "anki");
  await settings.select("#opt-custom-button-template", sentence.id);
  keyboard.addButton = await keyboardActivate(settings, "#custom-button-submit");
  await waitForStored(settings, async () => {
    const { options } = await chrome.storage.local.get("options");
    return options.customButtons.length === 2
      && options.customButtons[1].type === "anki"
      && options.customButtons[1].templateId !== "";
  });

  keyboard.buttonUp = await settings.evaluate(() => {
    const control = document.querySelector("#custom-button-list li:nth-child(2) [data-action='up']");
    control.focus();
    return { label: control.getAttribute("aria-label"), focused: document.activeElement === control };
  });
  await settings.keyboard.press("Enter");
  await waitForStored(settings, async () => {
    const { options } = await chrome.storage.local.get("options");
    return options.customButtons[0].type === "anki";
  });
  keyboard.buttonDown = await settings.evaluate(() => {
    const control = document.querySelector("#custom-button-list li:first-child [data-action='down']");
    control.focus();
    return { label: control.getAttribute("aria-label"), focused: document.activeElement === control };
  });
  await settings.keyboard.press("Enter");
  await waitForStored(settings, async () => {
    const { options } = await chrome.storage.local.get("options");
    return options.customButtons[0].type === "link" && options.customButtons[1].type === "anki";
  });

  const configured = await settings.evaluate(async ({
    ankiUrl,
    wordId,
    sentenceId,
    tag,
    wordDeck,
    sentenceDeck,
    wordModel,
    sentenceModel,
    wordExpression,
    wordSource,
    sentenceMapping,
    sentenceExpression,
  }) => {
    const { options } = await chrome.storage.local.get("options");
    const fields = Object.fromEntries(document.defaultView.HDReaderOptions.ANKI_FIELDS.map(field => [field, ""]));
    const template = (id, name, deck, model, tags, fieldTemplates, captureScreenshot) => ({
      ...document.defaultView.HDReaderOptions.DEFAULT_ANKI_TEMPLATE,
      id,
      name,
      deck,
      model,
      tags,
      fields,
      duplicateScope: "model",
      duplicateBehavior: "new",
      captureScreenshot,
      fieldTemplates: Object.fromEntries(Object.entries(fieldTemplates)
        .map(([field, value]) => [field, { value, overwriteMode: "overwrite" }])),
    });
    const anki = document.defaultView.HDReaderOptions.normaliseAnki({
      url: ankiUrl,
      apiKey: "",
      templates: [
        template(wordId, "Words", wordDeck, wordModel,
          [tag, "word-template"], {
            Expression: wordExpression,
            Reading: "{reading}",
            Glossary: "{glossary}",
            Source: wordSource,
          }, false),
        template(sentenceId, "Sentences", sentenceDeck, sentenceModel,
          [tag, "sentence-template"], {
            Sentence: sentenceMapping,
            Expression: sentenceExpression,
            Glossary: "{glossary}",
            Screenshot: "{screenshot}",
          }, true),
      ],
    });
    const sentenceButton = options.customButtons.find(button => button.type === "anki");
    const customButtons = [
      options.customButtons.find(button => button.type === "link"),
      { ...sentenceButton, label: "Sentence card", templateId: sentenceId },
      { id: "missing-template", type: "anki", label: "Unavailable card", templateId: "removed-template" },
    ];
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      requestId: `custom-buttons-final-${crypto.randomUUID()}`,
      baseRevision: options.revision,
      options: { anki, customButtons },
    });
    if (!reply.ok) throw new Error(reply.error);
    return {
      options: reply.options,
      sentenceButtonId: sentenceButton.id,
    };
  }, {
    ankiUrl: ANKI_URL,
    wordId: word.id,
    sentenceId: sentence.id,
    tag: E2E_TAG,
    wordDeck: WORD_DECK,
    sentenceDeck: SENTENCE_DECK,
    wordModel: WORD_MODEL,
    sentenceModel: SENTENCE_MODEL,
    wordExpression: WORD_EXPRESSION_MAPPING,
    wordSource: WORD_SOURCE_MAPPING,
    sentenceMapping: SENTENCE_MAPPING,
    sentenceExpression: SENTENCE_EXPRESSION_MAPPING,
  });

  await showSection(settings, "anki");
  await settings.select("#anki-template-select", sentence.id);
  await settings.waitForFunction(
    () => document.getElementById("anki-template-position").textContent === "2 of 2",
    { timeout: 10_000, polling: 50 },
  );
  const timing = await measureTemplateSwitching(settings);
  await settings.select("#anki-template-select", sentence.id);
  const templateScreenshot = await screenshotElement(settings, "#anki-template-manager", "templates-settings.png");
  await showSection(settings, "design");
  await settings.waitForFunction(
    () => document.querySelectorAll("#custom-button-list > li").length === 3,
    { timeout: 10_000, polling: 50 },
  );
  const buttonScreenshot = await screenshotElement(settings, "#custom-buttons-settings", "custom-buttons-settings.png");

  return {
    keyboard,
    migration: {
      template: migrated.anki.templates[0],
      customButton: migrated.customButtons[0],
    },
    combobox,
    preservation,
    timing,
    screenshots: { markerScreenshot: combobox.markerScreenshot, templateScreenshot, buttonScreenshot },
    wordTemplateId: word.id,
    sentenceTemplateId: sentence.id,
    sentenceButtonId: configured.sentenceButtonId,
  };
}

async function mineFromPage(browser, extensionId, configured) {
  const tab = await browser.newPage();
  tab.on("console", message => diagnostics.push(`[reader] ${message.type()}: ${message.text()}`));
  tab.on("pageerror", error => diagnostics.push(`[reader] pageerror: ${error.message}`));
  await tab.setViewport({ width: 1280, height: 800 });
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await tab.bringToFront();
  const contentWorld = await waitForContentWorld(tab, extensionId);
  assert.deepEqual(contentWorld, {
    extensionId,
    hoverEnabled: true,
    lookupMode: "hover",
    templates: 2,
    customButtons: 3,
  });
  const popup = await popupReader(tab);
  const word = await tab.$eval("#word", element => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  });
  await tab.mouse.move(2, 2);
  await tab.mouse.move(word.x + word.width * 0.15, word.y + word.height / 2);
  const sentenceSelector = `[data-custom-button-id="${configured.sentenceButtonId}"]`;
  const missingSelector = '[data-custom-button-id="missing-template"]';
  const ready = await popup.waitFor((state) => {
    const builtIn = state.actions.find(action => action.id === "built-in");
    const sentence = state.actions.find(action => action.id === configured.sentenceButtonId);
    const missing = state.actions.find(action => action.id === "missing-template");
    return state.plain.includes("食べる")
      && builtIn?.state === "ready" && builtIn.disabled === false
      && sentence?.state === "ready" && sentence.disabled === false
      && missing?.state === "unavailable" && missing.disabled === true
      && state.feedback.includes("no longer available");
  }, "popup actions did not reach independent Template readiness");

  let popupScreenshot = "";
  if (EVIDENCE) {
    popupScreenshot = resolve(EVIDENCE, "custom-buttons-popup.png");
    await tab.screenshot({ path: popupScreenshot, clip: ready.rect });
  }

  assert.equal(await popup.focus(sentenceSelector), true, "custom Anki button receives keyboard focus");
  await tab.keyboard.press("Enter");
  const sentenceNote = await waitForAnkiModel(SENTENCE_MODEL);
  const sentenceResult = {
    noteId: sentenceNote.noteId,
    model: sentenceNote.modelName,
    popupAfterCapture: await popup.state(),
  };
  await tab.mouse.move(2, 2);
  await tab.mouse.move(word.x + word.width * 0.15, word.y + word.height / 2);
  await popup.waitFor(state => {
    const builtIn = state.actions.find(action => action.id === "built-in");
    return state.plain.includes("食べる") && builtIn?.state === "ready" && builtIn.disabled === false;
  }, "built-in first Template did not become ready after the custom Template write");
  const builtInRect = await popup.rect(".gsm-hoshidicts-mine-button");
  assert.ok(builtInRect, "built-in Anki button remains present");
  await tab.mouse.click(
    builtInRect.x + builtInRect.width / 2,
    builtInRect.y + builtInRect.height / 2,
  );
  const completed = await popup.waitFor(state =>
    state.actions.find(action => action.id === "built-in")?.state === "success",
  "pointer built-in Template submission did not finish", 30_000);
  await popup.detach();
  await tab.close();
  return {
    popupScreenshot,
    initial: ready,
    sentenceResult,
    completed,
    keyboardCustomButton: true,
    pointerBuiltInButton: true,
    missingTemplateVisible: true,
    contentWorld,
  };
}

async function verifyAnkiWrites() {
  const noteIds = await anki("findNotes", { query: `tag:${E2E_TAG}` });
  assert.equal(noteIds.length, 2, `expected two notes, got ${noteIds.join(", ")}`);
  const notes = await anki("notesInfo", { notes: noteIds });
  const cards = await anki("cardsInfo", { cards: notes.flatMap(note => note.cards) });
  const deckByNote = new Map(cards.map(card => [card.note, card.deckName]));
  const word = notes.find(note => note.modelName === WORD_MODEL);
  const sentence = notes.find(note => note.modelName === SENTENCE_MODEL);
  assert.ok(word, "word Template wrote its note type");
  assert.ok(sentence, "sentence Template wrote its note type");
  assert.equal(deckByNote.get(word.noteId), WORD_DECK);
  assert.equal(deckByNote.get(sentence.noteId), SENTENCE_DECK);
  assert.equal(word.fields.Expression.value, "word [食べる] + [食べる]");
  assert.equal(word.fields.Reading.value, "たべる");
  assert.match(word.fields.Glossary.value, /eat/iu);
  assert.equal(word.fields.Source.value, ` \tcontext ${MINED_SENTENCE} + ${MINED_SENTENCE}\n `);
  assert.equal(sentence.fields.Sentence.value, `\ncontext ${MINED_SENTENCE} + ${MINED_SENTENCE}\t`);
  assert.equal(sentence.fields.Expression.value, "selected [食べる]");
  assert.match(sentence.fields.Glossary.value, /eat/iu);
  assert.equal(word.fields.Screenshot, undefined);
  const screenshotMatch = sentence.fields.Screenshot.value.match(/<img src="([^"]+)">/u);
  assert.ok(screenshotMatch, `sentence screenshot field was empty: ${sentence.fields.Screenshot.value}`);
  const screenshot = await anki("retrieveMediaFile", { filename: screenshotMatch[1] });
  assert.ok(typeof screenshot === "string", "Anki returned the selected Template screenshot");
  const screenshotBytes = Buffer.from(screenshot, "base64");
  assert.ok(screenshotBytes.length > 1000, "Anki stored the selected Template screenshot");
  assert.deepEqual([...screenshotBytes.subarray(0, 3)], [0xff, 0xd8, 0xff], "Anki stored a JPEG screenshot");
  return {
    noteIds,
    word: {
      noteId: word.noteId,
      deck: deckByNote.get(word.noteId),
      model: word.modelName,
      fields: Object.fromEntries(Object.entries(word.fields).map(([name, value]) => [name, value.value])),
      tags: word.tags,
    },
    sentence: {
      noteId: sentence.noteId,
      deck: deckByNote.get(sentence.noteId),
      model: sentence.modelName,
      fields: Object.fromEntries(Object.entries(sentence.fields).map(([name, value]) => [name, value.value])),
      tags: sentence.tags,
      screenshot: {
        filename: screenshotMatch[1],
        byteLength: screenshotBytes.length,
      },
    },
  };
}

async function main() {
  requireEnvironment();
  if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
  if (process.env.HACHIDORI_CUSTOM_BUTTONS_PROFILE) {
    if (!REUSE_PROFILE && existsSync(PROFILE) && readdirSync(PROFILE).length > 0) {
      throw new Error(`HACHIDORI_CUSTOM_BUTTONS_PROFILE=${PROFILE} must be empty`);
    }
  } else {
    rmSync(PROFILE, { recursive: true, force: true });
  }
  mkdirSync(PROFILE, { recursive: true });

  console.log("     preparing isolated Anki fixtures");
  const ankiEnvironment = await prepareAnki();
  const pageServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE_HTML);
  });
  await new Promise((resolveListen, rejectListen) => {
    pageServer.once("error", rejectListen);
    pageServer.listen(18774, "127.0.0.1", resolveListen);
  });
  let browser = null;
  let result;
  try {
    const puppeteerModule = await import(pathToFileURL(PUPPETEER).href);
    const puppeteer = puppeteerModule.default?.launch ? puppeteerModule.default : puppeteerModule;
    const launchBrowser = async () => {
      console.log(`     launching Chrome profile ${PROFILE}`);
      const launched = await puppeteer.launch({
        executablePath: CHROME,
        enableExtensions: true,
        userDataDir: PROFILE,
        headless: true,
        args: launchArguments(),
      });
      const watchTarget = target => {
        if (!target.url().startsWith("chrome-extension://")) return;
        void target.createCDPSession().then(async session => {
          await session.send("Runtime.enable");
          await session.send("Runtime.runIfWaitingForDebugger").catch(() => {});
          session.on("Runtime.consoleAPICalled", event => diagnostics.push(
            `[${target.type()}] ${event.type}: ${(event.args || [])
              .map(argument => argument.value ?? argument.description ?? "").join(" ")}`,
          ));
          session.on("Runtime.exceptionThrown", event => diagnostics.push(
            `[${target.type()}] exception: ${event.exceptionDetails?.exception?.description
              ?? event.exceptionDetails?.text ?? "(no detail)"}`,
          ));
        }).catch(() => {});
      };
      launched.on("targetcreated", watchTarget);
      launched.on("targetchanged", watchTarget);
      for (const target of launched.targets()) watchTarget(target);
      return launched;
    };
    browser = await launchBrowser();
    let id = await extensionId(browser);
    console.log("     opening Settings and waiting for the dictionary engine");
    let settings = await openSettings(browser, id);
    console.log("     importing the dictionary fixture");
    await importFixture(settings);
    if (!REUSE_PROFILE) {
      console.log("     restarting Chrome after the fresh import");
      await settings.close();
      await browser.close();
      browser = await launchBrowser();
      id = await extensionId(browser);
      settings = await openSettings(browser, id);
    }
    console.log("     exercising migration, Templates and Custom buttons");
    const configured = await configureThroughSettings(settings);
    const browserVersion = await browser.version();
    console.log("     mining through the real popup");
    const runtime = await mineFromPage(browser, id, configured);
    console.log("     reading both notes and screenshot media back from Anki");
    const writes = await verifyAnkiWrites();
    result = {
      passed: true,
      browserVersion,
      extensionId: id,
      ankiUrl: ANKI_URL,
      ankiEnvironment,
      profile: PROFILE,
      configured,
      runtime,
      writes,
      diagnostics,
    };
    await settings.close();
    console.log("     browser assertions complete");
  } finally {
    await browser?.close().catch(() => {});
    await new Promise(resolveClose => pageServer.close(resolveClose));
  }
  if (EVIDENCE) {
    writeFileSync(resolve(EVIDENCE, "custom-buttons-templates-result.json"),
      `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(resolve(EVIDENCE, "template-switch-timing.json"),
      `${JSON.stringify(result.configured.timing, null, 2)}\n`);
  }
  console.log(`PASS Custom buttons and Templates real Chrome/Anki E2E\n${JSON.stringify(result, null, 2)}`);
}

main().catch(error => {
  console.error(error?.stack ?? error);
  if (diagnostics.length > 0) console.error(diagnostics.join("\n"));
  process.exitCode = 1;
});
