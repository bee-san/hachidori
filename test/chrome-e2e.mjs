/*
 * End-to-end test in a real Chrome.
 *
 * Everything else in test/ runs the engine under node against fakes. This is the
 * only test that proves the parts node cannot reach: that Chrome accepts the
 * manifest, that the extension_pages CSP actually permits compiling the wasm in
 * the offscreen document, that chrome.offscreen and chrome.runtime.getContexts
 * behave as assumed, that OPFS survives a browser restart, and that a real
 * caretRangeFromPoint hover produces a rendered popup.
 *
 * Chrome and puppeteer-core live outside the repo (see CHROME and PUPPETEER
 * below) so that a checkout does not carry a 290 MB browser.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import {
  GENERIC_KANJI_GLOSSARY,
  GENERIC_KANJI_TITLE,
  buildRecommendedZip,
  buildTitledZip,
} from "./make-fixture.mjs";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_TITLE,
} from "../extension/custom-dictionary.js";
import { RECOMMENDED_DICTIONARIES as RECOMMENDED_CATALOGUE } from "../extension/recommended-dictionaries.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EXTENSION = resolve(REPO, "extension");
const FIXTURE = resolve(HERE, "fixtures/hachidori-fixture.zip");
const GENERIC_KANJI_FIXTURE = resolve(HERE, "fixtures/hachidori-generic-kanji-fixture.zip");
const INVALID_FIXTURE = resolve(HERE, "fixtures/malformed-index.zip");
const GENERIC_KANJI_SELECTION = { title: GENERIC_KANJI_TITLE, kind: "term" };
const FIXTURE_KANJI_SELECTION = { title: "hachidori-fixture", kind: "kanji" };
const FIXTURE_TERM_SELECTION = { title: "hachidori-fixture", kind: "term" };
const GENERIC_KANJI_SELECTION_VALUE = JSON.stringify(GENERIC_KANJI_SELECTION);
const FIXTURE_KANJI_SELECTION_VALUE = JSON.stringify(FIXTURE_KANJI_SELECTION);
const FIXTURE_TERM_SELECTION_VALUE = JSON.stringify(FIXTURE_TERM_SELECTION);
const FIXTURE_ID = "921c9971654f69cd1ad6d0e2f89b990c";
const GENERIC_KANJI_ID = "6b513edb59015829bb5bb3e91e41d357";
const FIXTURE_ALIAS = "Fixture Alias";
const MANAGED_INDEX_URL = "https://example.test/hachidori-fixture-index.json";
const MANAGED_DOWNLOAD_URL = "https://example.test/hachidori-fixture.zip";
const GENERIC_MANAGED_INDEX_URL = "https://example.test/generic-kanji-index.json";
const GENERIC_MANAGED_DOWNLOAD_URL = "https://example.test/generic-kanji.zip";
const MANAGED_UPDATE_ALARM = "hachidori-managed-dictionary-updates";
const CUSTOM_SETTINGS_SOURCE = "# Personal Japanese notes\n\u6c17\u306b\u306a\u308b, \u304d\u306b\u306a\u308b, to catch one's attention\n";
const CUSTOM_TERM_NOTE_DEFINITION = "to eat — personal usage note";
const CUSTOM_KANJI_NOTE_DEFINITION = "food; eating — kanji note";
const LAST_UPDATE_CHECK = Object.freeze({
  checkedAt: "2026-09-04T09:30:00.000Z",
  status: "update-available",
  remoteRevision: "test-2",
  error: null,
});
const GENERATION_ROOT_PATTERN = /^\/dicts\/\.hdw-generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");

function ownedGenerationRoot(path, title) {
  const suffix = `/${title}`;
  const root = typeof path === "string" && path.endsWith(suffix)
    ? path.slice(0, -suffix.length)
    : "";
  return GENERATION_ROOT_PATTERN.test(root) ? root : "";
}

function opfsPath(path) {
  return path.slice("/dicts/".length);
}

function generationExists(paths, dictionaryPath) {
  const relative = opfsPath(dictionaryPath);
  return paths.includes(`${relative}/.hoshidicts_3`)
    || paths.includes(`${relative}/.hoshidicts_4`);
}

function generationIsAbsent(paths, generationRoot) {
  const relative = opfsPath(generationRoot);
  return !paths.some((path) => path === relative || path.startsWith(`${relative}/`));
}

async function waitForGenerationAbsent(page, generationRoot) {
  const directory = opfsPath(generationRoot);
  return page.waitForFunction(async (name) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getDirectoryHandle(name);
      return false;
    } catch (error) {
      return error?.name === "NotFoundError";
    }
  }, { timeout: 15_000, polling: 100 }, directory).then(() => true).catch(() => false);
}

function cachedChrome() {
  const root = resolve(CACHE, "hachidori-browsers/chrome");
  if (!existsSync(root)) return "";
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
  const builds = readdirSync(root).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }));
  for (const build of builds) {
    for (const suffix of suffixes) {
      const candidate = resolve(root, build, ...suffix);
      if (existsSync(candidate)) return candidate;
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

const CHROME = process.env.HACHIDORI_CHROME
  || process.env.CHROME_BIN
  || cachedChrome()
  || installedChrome();
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
// Per-pid by default. Two runs sharing one profile fight over the extension's
// leveldb: the second Chrome cannot open chrome.storage.local at all
// ("IO error: .../LOCK ... LockFile"), which showed up here as a pass-2 failure
// that looked like an IDBFS regression. Kept after a failing run so the profile
// can be inspected, removed after a green one.
const PROFILE = process.env.HACHIDORI_PROFILE || `/tmp/hachidori-e2e-profile-${process.pid}`;

// The name the content script registers its Custom Highlight under, read out of
// the source instead of copied: a copy would keep passing after a rename, which
// is exactly the regression the highlight assertions exist to catch.
const HIGHLIGHT_NAME = (readFileSync(resolve(EXTENSION, "content.js"), "utf8")
  .match(/HIGHLIGHT_NAME\s*=\s*"([^"]+)"/) || [])[1];

const RECOMMENDED_FIXTURE_METADATA = {
  jitendex: {
    title: "Jitendex.org [2026-08-11]",
    revision: "2026.08.11.0",
    capabilities: ["term", "media"],
  },
  jmnedict: {
    title: "JMnedict [2026-09-04]",
    revision: "JMnedict.2026-09-04",
    capabilities: ["term"],
  },
  "bees-ultimate-kanji-dictionary": {
    title: "Bee's Ultimate Kanji Dictionary",
    revision: "2026.09.02",
    capabilities: ["term", "freq", "media"],
  },
  jiten: { title: "Jiten", revision: "Jiten 26-09-02", capabilities: ["freq"] },
};
const RECOMMENDED_DICTIONARIES = RECOMMENDED_CATALOGUE.map((entry) => ({
  ...entry,
  ...RECOMMENDED_FIXTURE_METADATA[entry.sourceId],
}));
const RECOMMENDED_LINKS = RECOMMENDED_DICTIONARIES.map(({ name, publisherUrl }) => [name, publisherUrl]);

// Every assertion this run makes, named up front. The denominator is this list,
// not the number of checks that happened to execute: a suite that skips an
// assertion under a regression prints "23/24 passed" and reads like success.
const PLANNED = [
  "extension loads and its service worker starts",
  "offscreen document compiles the wasm under the extension CSP",
  "extension pages expose pthread prerequisites",
  "chrome.offscreen.createDocument produced exactly one offscreen document",
  "manifest and settings page are branded as Hachidori",
  "Settings puts the library first and supports keyboard navigation at 320px",
  "Settings autosaves one revisioned patch and surfaces cross-page conflicts without losing drafts",
  "reader settings and their revision survive a full browser restart",
  "dictionary CSS stays scoped with malformed braces, escaped titles, and nested rules",
  "dictionary CSS cannot load remote resources or inherit resource-valued variables",
  "dictionary CSS cannot paint or intercept input outside its glossary card",
  "settings page renders exactly four safe recommended dictionary links",
  "recommended dictionaries form two columns on desktop",
  "recommended dictionaries stack without overflow on narrow screens",
  "a clean profile shows one recommended install action beside local import",
  "the recommended installer continues after a mocked download failure",
  "the starter card stays hidden after a settings reload",
  "recommended retry downloads only the missing trusted dictionary",
  "settings page exposes a .zip file input",
  "the .zip file input accepts multiple .zip files",
  "importing a Yomitan .zip from the settings page succeeds",
  "the imported dictionary is persisted in OPFS",
  "the imported dictionary is recorded in chrome.storage.local",
  "the import batch continues after failure and retains every archive outcome",
  "batch re-import preserves presentation, source, and order while clearing stale check state",
  "the dictionary list renders its alias, metadata, and five capability badges",
  "the dictionary position input stays compact on a narrow Settings page",
  "the Settings enabled control re-enables the preserved package",
  "Check now checks every managed dictionary including disabled packages without downloading",
  "managed update controls render persisted availability and last-checked state",
  "Update all atomically replaces a managed generation and preserves presentation",
  "one global update interval creates one periodic browser alarm",
  "a real browser alarm installs updates for disabled managed dictionaries",
  "a failed scheduled update preserves the working generation without OPFS debris",
  "worker restart recreates the configured managed-update alarm",
  "importing a term-only single-kanji dictionary succeeds",
  "dictionary management filters and bulk-updates visible stable selections",
  "drag and keyboard position controls share the persisted lookup order",
  "a delayed alias blur-then-click queues both dictionary edits",
  "named groups normalize unique names and keep stable dictionary memberships",
  "group and member order controls persist their shared state order",
  "a real blur-then-click queues both group edits and retains focus",
  "a newer external focus survives a group rerender",
  "the kanji dictionary chooser lists imported term and kanji dictionaries",
  "a combined archive exposes separate term and native kanji choices",
  "stale title-only kanji selections are pruned",
  "a legacy title-only kanji selection migrates to and persists its native capability",
  "the selected kanji dictionary is saved",
  "custom Settings lazily saves a source through the real WASM importer",
  "hovering an inflected verb shows a popup",
  "the content script attached its closed-shadow host to the page",
  "the popup deinflects 食べたかった to 食べる",
  "the popup renders the glossary",
  "the popup renders the frequency tag from term_meta_bank",
  "the dictionary alias labels its popup tab without replacing the canonical key",
  "selected term dictionary wins even when maximum results is one",
  "Back preserves the complete clicked-kanji drill-down history",
  "Back restores the term results after a generic kanji lookup",
  "clicked-kanji navigation moves and restores keyboard focus",
  "Back restores focus to the exact clicked duplicate kanji",
  "the Settings enabled control disables one logical package",
  "a disabled selected term dictionary falls back to native kanji",
  "a combined archive can use its term entries for clicked kanji",
  "selecting a kanji-bank dictionary keeps the native kanji view",
  `the hovered word is highlighted under CSS.highlights["${HIGHLIGHT_NAME}"]`,
  "Escape hides the popup",
  "dismissing the popup clears the extension's highlight",
  "hovering 漢字 shows a popup",
  "structured content renders a bold span element",
  "structured content renders a ul with its two li",
  "structured content renders a table with the on and kun rows",
  "a structured-content image resolves through hd_media to a data: URL",
  "the popup is showing immediately before the non-Japanese hover",
  "hovering non-Japanese text shows no popup",
  "the same hover shows a popup again after the non-Japanese one",
  "an open Note draft survives hover and consumes Escape before popup dismissal",
  "term and kanji Note forms append and refresh the managed custom dictionary",
  "the settings page lists the dictionary again after a restart",
  "the starter card stays hidden after a browser restart",
  "the dictionary survives a browser restart via OPFS",
  "lookups work after a restart with no re-import",
  "removing the dictionary clears its settings rows",
  "removing the dictionary deletes its OPFS directory",
  "lookups miss after the dictionary is removed",
  "real-WASM lookup bounds fail one request without poisoning the OPFS engine",
  "an oversized hover clears the previous popup and the next healthy hover recovers",
];

const results = [];
let failed = 0;
// Module scope, not a local of main(): an exception anywhere in the run still has
// to reach report(), and the offscreen document's console is the only place a boot
// failure shows up at all -- throwing it away in exactly the case where something
// crashed is how a 90 s "never settled" stays unexplained.
const diagnostics = [];

function check(name, ok, detail = "") {
  if (!PLANNED.includes(name)) fatal(`check("${name}") is not in PLANNED`);
  if (results.some(r => r.name === name)) fatal(`check("${name}") ran twice`);
  results.push({ name, ok, detail });
  if (!ok) failed++;
  const mark = ok ? "ok  " : "FAIL";
  console.log(`${mark} ${name}${detail && !ok ? `\n       ${detail}` : ""}`);
}

async function interceptFetches(target, routes, label) {
  const session = await target.createCDPSession();
  session.on("Fetch.requestPaused", (event) => {
    void (async () => {
      const route = routes.get(event.request.url);
      if (!route) {
        await session.send("Fetch.continueRequest", { requestId: event.requestId });
        return;
      }
      route.requests += 1;
      const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body);
      await session.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: route.status,
        responseHeaders: [
          { name: "Access-Control-Allow-Origin", value: "*" },
          { name: "Content-Type", value: route.contentType },
          { name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
        body: body.toString("base64"),
      });
    })().catch(async (error) => {
      diagnostics.push(`[${label} mock] ${error?.stack ?? error}`);
      await session.send("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "Failed",
      }).catch(() => {});
    });
  });
  await session.send("Fetch.enable", {
    patterns: [...routes.keys()].map((urlPattern) => ({ urlPattern, requestStage: "Request" })),
  });
  return session;
}

function setJsonResponse(route, value, status = 200) {
  route.status = status;
  route.contentType = "application/json";
  route.body = JSON.stringify(value);
}

function setArchiveResponse(route, bytes, status = 200) {
  route.status = status;
  route.contentType = "application/zip";
  route.body = bytes;
}

async function replaceInputText(page, selector, value) {
  await page.$eval(selector, (input) => {
    input.focus();
    input.select();
  });
  await page.keyboard.type(value);
}

async function waitForCdpTarget(session, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find(predicate);
    if (target !== undefined) {
      return target;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return null;
}

async function waitForCdpTargetGone(session, targetId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { targetInfos } = await session.send("Target.getTargets");
    if (!targetInfos.some((target) => target.targetId === targetId)) {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

function waitForRunningServiceWorker(session, scriptUrl, timeout = 30_000) {
  return new Promise((resolveWorker) => {
    const timer = setTimeout(() => {
      session.off("ServiceWorker.workerVersionUpdated", onVersionUpdated);
      resolveWorker(null);
    }, timeout);
    const onVersionUpdated = ({ versions }) => {
      const worker = versions.find((version) =>
        version.scriptURL === scriptUrl && version.runningStatus === "running");
      if (worker === undefined) {
        return;
      }
      clearTimeout(timer);
      session.off("ServiceWorker.workerVersionUpdated", onVersionUpdated);
      resolveWorker(worker);
    };
    session.on("ServiceWorker.workerVersionUpdated", onVersionUpdated);
  });
}

async function listOpfsPaths(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const paths = [];
    const walk = async (directory, prefix) => {
      for await (const [name, handle] of directory.entries()) {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        paths.push(path);
        if (handle.kind === "directory") await walk(handle, path);
      }
    };
    await walk(root, "");
    return paths.sort();
  });
}

function fatal(message) {
  console.error(`\nfatal: ${message}`);
  process.exit(1);
}

// A page served over http, because content scripts do not run on
// chrome-extension:// or about:blank, and file:// needs a per-extension opt-in
// that no command-line flag can grant.
const PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>hachidori e2e</title>
<style>
  body { font: 32px/2 serif; padding: 80px; }
  span { display: inline-block; }
</style></head>
<body>
  <p><span id="verb">食べたかった</span></p>
  <p><span id="duplicate">食食</span></p>
  <p><span id="kanjiword">漢字</span></p>
  <p><span id="latin">hello world</span></p>
  <p><ruby id="rubyword">漢字<rt>かんじ</rt></ruby></p>
</body></html>`;

// puppeteer's `pierce/` selectors cannot reach the popup: they walk
// element.shadowRoot from an injected script, and that property is null for a
// root attached with mode "closed". CDP's DOM domain can -- DOM.getDocument with
// pierce:true reports the closed root and its subtree -- so every read of the
// popup goes through a session instead of a selector.
async function popupReader(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("DOM.enable");
  await cdp.send("Runtime.enable");

  async function resolvePopupObject() {
    // nodeIds live only until the next getDocument, so each operation re-walks.
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    let nodeId = null;
    const walk = node => {
      const attributes = node.attributes || [];
      for (let i = 0; i < attributes.length; i += 2) {
        if (attributes[i] === "class" && String(attributes[i + 1]).includes("gsm-hoshidicts-popup")) {
          nodeId = node.nodeId;
        }
      }
      for (const shadow of node.shadowRoots || []) walk(shadow);
      for (const child of node.children || []) walk(child);
    };
    walk(root);
    if (nodeId === null) return null;
    const { object } = await cdp.send("DOM.resolveNode", { nodeId });
    return object;
  }

  async function state() {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      // The headword is furigana ruby, so its textContent interleaves the reading
      // into the expression -- 食べる with a た over 食 reads "食たべる". `text`
      // keeps that (it is what a reader sees); `plain` drops the <rt> so an
      // assertion can name the expression itself.
      // `tags`, `lists`, `tables` and `bold` report elements rather than text:
      // a renderer that flattened the structured content to a single text node
      // reads identically in `text`, so nothing text-based can tell a <ul> from
      // two lines of prose. `bold` carries the computed weight because the
      // fixture's span is bold through a style object, not through <b>.
      functionDeclaration: `function () {
        const stripped = this.cloneNode(true);
        for (const rt of stripped.querySelectorAll("rt, rp")) rt.remove();
        const flat = node => (node.textContent || "").replace(/\\s+/g, " ").trim();
        const view = this.ownerDocument.defaultView;
        const noteForm = this.querySelector(".gsm-hoshidicts-note-form");
        return {
          hidden: this.hasAttribute("hidden"),
          height: this.getBoundingClientRect().height,
          text: flat(this),
          plain: flat(stripped),
          images: Array.from(this.querySelectorAll("img"), img => img.getAttribute("src") || ""),
          tags: Array.from(this.querySelectorAll("*"), el => el.tagName.toLowerCase()),
          lists: Array.from(this.querySelectorAll("ul"), ul =>
            Array.from(ul.children, li => li.tagName.toLowerCase() + ":" + flat(li))),
          tables: Array.from(this.querySelectorAll("table"), table =>
            Array.from(table.rows, row =>
              Array.from(row.cells, cell => cell.tagName.toLowerCase() + ":" + flat(cell)))),
          bold: Array.from(this.querySelectorAll("*"))
            .filter(el => Number.parseInt(view.getComputedStyle(el).fontWeight, 10) >= 600)
            .map(el => el.tagName.toLowerCase() + ":" + flat(el)),
          tabs: Array.from(this.querySelectorAll(".gsm-hoshidicts-tab"), flat),
          hasBack: this.querySelector(".gsm-hoshidicts-kanji-back") !== null,
          focusedClass: this.getRootNode().activeElement?.className || "",
          focusedKanjiIndex: Array.from(this.querySelectorAll(".gsm-hoshidicts-kanji-link"))
            .indexOf(this.getRootNode().activeElement),
          noteOpen: noteForm !== null && !noteForm.hidden,
          noteTerm: noteForm?.querySelector('[name="term"]')?.value ?? null,
          noteReading: noteForm?.querySelector('[name="reading"]')?.value ?? null,
          noteDefinition: noteForm?.querySelector('[name="definition"]')?.value ?? null,
          noteError: noteForm?.querySelector(".gsm-hoshidicts-note-error")?.textContent ?? "",
        };
      }`,
    });
    return result.value;
  }

  const visible = s => !!s && !s.hidden && s.height > 0 && s.text !== "";

  async function waitForVisible(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await state();
      if (visible(current)) return current;
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // A popup that never appeared and a popup that went away are the same state
  // here on purpose: both are read only after an assertion has proved the popup
  // was showing, so neither can pass vacuously.
  async function waitForHidden(timeoutMs = 6_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await state();
      if (!visible(current)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 150));
    }
  }

  async function click(selector) {
    const object = await resolvePopupObject();
    if (object === null) return false;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: selector }],
      functionDeclaration: `function (target) {
        const element = this.querySelector(target);
        if (!element) return false;
        element.click();
        return true;
      }`,
    });
    return result.value === true;
  }

  async function writeNote(values, submit = false) {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: values }, { value: submit }],
      functionDeclaration: `function (next, shouldSubmit) {
        const form = this.querySelector(".gsm-hoshidicts-note-form");
        if (!form || form.hidden) return null;
        for (const [name, value] of Object.entries(next)) {
          const control = form.elements.namedItem(name);
          if (!(control instanceof HTMLElement) || !("value" in control)) return null;
          control.value = String(value);
          control.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (shouldSubmit) form.requestSubmit();
        return Object.fromEntries(["term", "reading", "definition"].map(name => [
          name,
          form.elements.namedItem(name)?.value ?? null,
        ]));
      }`,
    });
    return result.value ?? null;
  }

  return { click, state, visible, waitForVisible, waitForHidden, writeNote };
}

// The content script runs at document_idle and builds its host lazily, on the
// first hover, so there is nothing in the DOM to wait for beforehand: a mouse
// move that lands before its listeners attach is simply lost. So re-fire
// mousemove until the popup answers, instead of sleeping long enough to hope the
// script was ready -- the popup appearing is the only real synchronisation here.
async function hoverForPopup(page, popup, selector, { charFraction = 0.15, attempts = 12 } = {}) {
  const box = await (await page.$(selector)).boundingBox();
  // Aim at the first glyph rather than the centre, so the scan starts at the
  // beginning of the word and `matched` covers the whole inflection.
  const x = box.x + box.width * charFraction;
  const y = box.y + box.height / 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // mousemove only fires when the position changes, so step off the word
    // before stepping back onto it.
    await page.mouse.move(2, 2);
    await page.mouse.move(x, y);
    const state = await popup.waitForVisible(1500);
    if (state !== null) return state;
  }
  return null;
}

async function setDictionaryEnabledInSettings(page, title, enabled) {
  const started = await page.evaluate(async ({ dictionaryTitle, nextEnabled }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const row = [...document.querySelectorAll("#dict-list .dict-row")].find((candidate) =>
      candidate.querySelector(".dict-display-name")?.placeholder === dictionaryTitle);
    const checkbox = row?.querySelector(".dict-enabled");
    const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.title === dictionaryTitle);
    if (!(checkbox instanceof HTMLInputElement) || !dictionary) {
      return { error: "dictionary row or state was missing" };
    }
    if (checkbox.checked === nextEnabled || dictionary.enabled === nextEnabled) {
      return { error: "dictionary was not in the expected starting state" };
    }
    const baseRevision = dictionaryState.revision;
    checkbox.click();
    return { baseRevision };
  }, { dictionaryTitle: title, nextEnabled: enabled });
  if (!Number.isInteger(started?.baseRevision)) {
    return started;
  }
  const settled = await page.waitForFunction(async ({ baseRevision, dictionaryTitle, nextEnabled }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.title === dictionaryTitle);
    const row = [...document.querySelectorAll("#dict-list .dict-row")].find((candidate) =>
      candidate.querySelector(".dict-display-name")?.placeholder === dictionaryTitle);
    const checkbox = row?.querySelector(".dict-enabled");
    return dictionaryState?.revision > baseRevision
      && dictionary?.enabled === nextEnabled
      && checkbox?.checked === nextEnabled
      && checkbox.disabled === false
      ? { id: dictionary.id, revision: dictionaryState.revision }
      : false;
  }, { timeout: 15_000, polling: 100 }, {
    baseRevision: started.baseRevision,
    dictionaryTitle: title,
    nextEnabled: enabled,
  }).then((handle) => handle.jsonValue()).catch(() => null);
  return { ...started, settled };
}

async function setDictionaryAliasInSettings(page, title, alias) {
  const started = await page.evaluate(async ({ dictionaryTitle, nextAlias }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const row = [...document.querySelectorAll("#dict-list .dict-row")].find((candidate) =>
      candidate.querySelector(".dict-display-name")?.placeholder === dictionaryTitle);
    const input = row?.querySelector(".dict-display-name");
    if (!(input instanceof HTMLInputElement)) {
      return { error: "dictionary row was missing" };
    }
    const baseRevision = dictionaryState.revision;
    input.value = nextAlias;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { baseRevision };
  }, { dictionaryTitle: title, nextAlias: alias });
  if (!Number.isInteger(started?.baseRevision)) {
    return started;
  }
  const settled = await page.waitForFunction(async ({ baseRevision, dictionaryTitle, nextAlias }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.title === dictionaryTitle);
    return dictionaryState?.revision > baseRevision && dictionary?.displayName === nextAlias
      ? { id: dictionary.id, revision: dictionaryState.revision }
      : false;
  }, { timeout: 15_000, polling: 100 }, {
    baseRevision: started.baseRevision,
    dictionaryTitle: title,
    nextAlias: alias,
  }).then((handle) => handle.jsonValue()).catch(() => null);
  return { ...started, settled };
}

async function checkDictionaryStyles(page) {
  await page.addScriptTag({ url: new URL("render/glossary.js", page.url()).href });
  const requests = [];
  const intercept = (request) => {
    if (request.url().startsWith("https://dictionary-style.invalid/")) {
      requests.push(request.url());
      void request.abort();
    } else {
      void request.continue();
    }
  };
  await page.setRequestInterception(true);
  page.on("request", intercept);
  let evidence;
  try {
    evidence = await page.evaluate(async () => {
      const host = document.createElement("div");
      host.style.setProperty("--external", 'url("https://dictionary-style.invalid/inherited.png")');
      for (const suffix of [" evil", ")evil", ",evil"]) {
        host.style.setProperty(`--fg${suffix}`, 'url("https://dictionary-style.invalid/escaped-var.png")');
      }
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      const readerStyles = new CSSStyleSheet();
      readerStyles.replaceSync(await (await fetch(chrome.runtime.getURL("render/reader.css"))).text());
      shadow.adoptedStyleSheets = [readerStyles];
      const pageFont = document.createElement("style");
      pageFont.textContent = '@font-face { font-family:page-resource-test; src:url("https://dictionary-style.invalid/page-font.woff2"); } @function --external-image() { result:url("https://dictionary-style.invalid/function.png"); } @property --text-color { syntax:"<image>"; inherits:true; initial-value:url("https://dictionary-style.invalid/registered.png"); } @property --font-size-no-units { syntax:"<image>"; inherits:true; initial-value:url("https://dictionary-style.invalid/registered-number.png"); }';
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      popup.style.cssText = "left:20px;top:20px;width:400px;height:300px";
      popup.innerHTML = '<button class="outside" style="color:rgb(9, 9, 9)">Reader control</button>';
      shadow.appendChild(popup);
      const addGlossary = (dictionary) => {
        const card = document.createElement("div");
        card.className = "gsm-hoshidicts-glossary-card";
        card.style.cssText = "width:200px;height:100px;box-sizing:border-box";
        const glossary = document.createElement("div");
        glossary.className = "gsm-hoshidicts-glossary-content";
        glossary.dataset.hoshidictsDictionary = dictionary;
        card.appendChild(glossary);
        popup.appendChild(card);
        return glossary;
      };
      const escapedTitle = '辞書 "\\\n] title';
      const inside = addGlossary("scope-test");
      inside.innerHTML = '<span class="inside">Definition <b class="nested">nested</b></span>';
      const escaped = addGlossary(escapedTitle);
      escaped.textContent = "Escaped title";
      const apply = (generation, entries) => HDGlossary.applyDictionaryStyles(document, shadow, generation, entries);
      const styles = apply(1, [
        { dictionary: "scope-test", styles: '.inside { color:rgb(1, 2, 3); background:radial-gradient(var(--text-color, var(--fg, #333)), transparent); font-size:calc(var(--font-size-no-units) * 1px); & .nested { font-weight:900; } } } .outside { color:rgb(200, 0, 0) !important; } :host { --escaped:yes; } @scope (.unused) {' },
        { dictionary: escapedTitle, styles: ':scope { color:rgb(4, 5, 6); }' },
        { dictionary: "scope-test", styles: '.inside { color:red; }' },
      ]);
      const scope = {
        count: styles.length,
        inside: getComputedStyle(inside.querySelector(".inside")).color,
        nested: getComputedStyle(inside.querySelector(".nested")).fontWeight,
        gradient: getComputedStyle(inside.querySelector(".inside")).backgroundImage,
        fontSize: getComputedStyle(inside.querySelector(".inside")).fontSize,
        escapedTitle: getComputedStyle(escaped).color,
        outside: getComputedStyle(popup.querySelector(".outside")).color,
        escapedHost: getComputedStyle(host).getPropertyValue("--escaped"),
      };
      document.head.appendChild(pageFont);
      host.style.setProperty("--hoshidicts-palette-base-content", 'url("https://dictionary-style.invalid/palette.png")', "important");
      const network = addGlossary("network-test");
      const resourceCases = [
        'background-image:url("https://dictionary-style.invalid/direct.png")',
        'background-image:u\\72l("https://dictionary-style.invalid/escaped.png")',
        'background-image:image-set("https://dictionary-style.invalid/set.png" 1x)',
        '--image:u\\72l("https://dictionary-style.invalid/custom.png");background-image:var(--image)',
        'background-image:var(--external)',
        'background-image:var(--text-color)',
        'background-image:var(--font-size-no-units)',
        'background-image:var(--fg, var(--external))',
        'font-family:page-resource-test',
        'font:16px page-resource-test',
        'background:var(--external)',
        'background-image:var(--fg\\ evil)',
        'background-image:var(--fg\\)evil)',
        'background-image:var(--fg\\,evil)',
        'background-image:v\\61\r\nr(--external)',
        'background-image:--external-image()',
        'background-image:\\2d\\2d external-image()',
      ];
      network.innerHTML = resourceCases.map((_, index) => `<div class="resource-${index}">Resource test</div>`).join("");
      apply(2, [{ dictionary: "network-test", styles: [
        '@import url("https://dictionary-style.invalid/import.css");',
        '@font-face { font-family:remote-test; src:url("https://dictionary-style.invalid/font.woff2"); }',
        ...resourceCases.map((value, index) => `.resource-${index} { ${value}; color:rgb(7, 8, 9); }`),
        '.resource-0 { font-family:remote-test; }',
        '.resource-0::before { content:"/*" url("https://dictionary-style.invalid/comment-mask.png") "*/"; }',
      ].join("\n") }]);
      const resources = [...network.children].map((element) => getComputedStyle(element).backgroundImage);
      const fonts = [...network.children].map((element) => getComputedStyle(element).fontFamily);
      const pseudoContent = getComputedStyle(network.firstElementChild, "::before").content;
      const replacement = shadow.querySelectorAll("style[data-hoshidicts-dictionary-style]").length === 1
        && shadow.querySelector("style[data-hoshidicts-dictionary-style]").dataset.hoshidictsGeneration === "2"
        && getComputedStyle(inside.querySelector(".nested")).fontWeight !== "900";
      const globalRules = [...shadow.querySelector("style[data-hoshidicts-dictionary-style]").sheet.cssRules]
        .map((rule) => rule.constructor.name);
      // Flush style-driven requests before removing the test DOM/interceptor.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      network.remove();
      escaped.remove();
      inside.innerHTML = '<div class="overlay">Dictionary overlay</div>';
      apply(3, [{ dictionary: "scope-test", styles: '.overlay { position:fixed; inset:0; z-index:2147483647; background:red; box-shadow:0 0 0 10000px red; }' }]);
      const overlay = inside.querySelector(".overlay");
      const card = inside.parentElement;
      const overlayRect = overlay.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const controlRect = popup.querySelector(".outside").getBoundingClientRect();
      const containment = {
        paint: getComputedStyle(card).contain,
        withinCard: overlayRect.left >= cardRect.left && overlayRect.top >= cardRect.top
          && overlayRect.right <= cardRect.right && overlayRect.bottom <= cardRect.bottom,
        control: shadow.elementFromPoint(controlRect.left + 2, controlRect.top + 2)?.className,
        farPoint: shadow.elementFromPoint(700, 500)?.className ?? "",
      };
      host.remove();
      pageFont.remove();
      return { scope, resources, fonts, pseudoContent, replacement, globalRules, containment };
    });
  } finally {
    await page.setRequestInterception(false);
    page.off("request", intercept);
  }
  check("dictionary CSS stays scoped with malformed braces, escaped titles, and nested rules",
    evidence.scope.count === 2 && evidence.scope.inside === "rgb(1, 2, 3)"
      && evidence.scope.nested === "900" && evidence.scope.escapedTitle === "rgb(4, 5, 6)"
      && evidence.scope.gradient.startsWith("radial-gradient(") && evidence.scope.fontSize === "14px"
      && evidence.scope.outside === "rgb(9, 9, 9)" && evidence.scope.escapedHost === ""
      && evidence.replacement, JSON.stringify(evidence));
  check("dictionary CSS cannot load remote resources or inherit resource-valued variables",
    requests.length === 0 && evidence.resources.every((value) => value === "none")
      && evidence.fonts.every((value) => !value.includes("page-resource-test"))
      && evidence.pseudoContent === "none"
      && evidence.globalRules.every((name) => name === "CSSScopeRule"), JSON.stringify({ evidence, requests }));
  check("dictionary CSS cannot paint or intercept input outside its glossary card",
    evidence.containment.paint === "paint" && evidence.containment.withinCard
      && evidence.containment.control === "outside" && evidence.containment.farPoint !== "overlay",
    JSON.stringify(evidence.containment));
}

async function checkSettingsAutosave(page, browser, settingsUrl) {
  const mirror = await browser.newPage();
  const edit = (target, changes) => target.evaluate((values) => {
    for (const [id, value] of Object.entries(values)) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, changes);
  const saved = (target) => target.waitForFunction(() =>
    document.getElementById("options-status").textContent === "Saved.", { timeout: 10_000, polling: 100 });
  let evidence;
  try {
    await mirror.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    for (const target of [page, mirror]) {
      await target.waitForFunction(() => document.getElementById("engine-status").textContent.startsWith("Ready"),
        { timeout: 90_000, polling: 100 });
    }
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const probe = { calls: [], hold: true, release: null, restore: () => { chrome.runtime.sendMessage = original; } };
      window.__optionsSaveProbe = probe;
      chrome.runtime.sendMessage = async (message) => {
        if (message.type !== "hd_options_write") return original(message);
        probe.calls.push(message);
        const reply = await original(message);
        if (probe.hold) {
          probe.hold = false;
          await new Promise((resolveReply) => { probe.release = resolveReply; });
        }
        return reply;
      };
    });
    await edit(page, { "opt-scan-length": "25", "opt-max-results": "64" });
    await page.waitForFunction(() => typeof window.__optionsSaveProbe.release === "function", { polling: 100 });
    await edit(page, { "opt-max-results": "96" });
    await mirror.waitForFunction(() => document.getElementById("opt-max-results").value === "64", { polling: 100 });
    await edit(mirror, { "opt-frequency-order": "descending" });
    await saved(mirror);
    const writesWhileHeld = await page.evaluate(() => window.__optionsSaveProbe.calls.length);
    await page.evaluate(() => window.__optionsSaveProbe.release());
    await page.waitForFunction(() => !document.getElementById("options-conflict-actions").hidden, { polling: 100 });
    evidence = await page.evaluate(async () => ({
      calls: window.__optionsSaveProbe.calls,
      draft: document.getElementById("opt-max-results").value,
      order: document.getElementById("opt-frequency-order").value,
      status: document.getElementById("options-status").textContent,
      stored: (await chrome.storage.local.get("options")).options,
    }));
    evidence.writesWhileHeld = writesWhileHeld;
    await page.bringToFront();
    await page.click("#options-use-saved");
    evidence.discardedValue = await page.$eval("#opt-max-results", (input) => input.value);
    await edit(page, { "opt-scan-length": "16", "opt-max-results": "32", "opt-frequency-order": "auto" });
    await saved(page);
    await mirror.waitForFunction(() => document.getElementById("opt-max-results").value === "32", { polling: 100 });
    check(
      "Settings autosaves one revisioned patch and surfaces cross-page conflicts without losing drafts",
      evidence.writesWhileHeld === 1 && evidence.calls.length === 2
        && evidence.calls[1].baseRevision === evidence.calls[0].baseRevision + 1
        && evidence.calls[0].options.scanLength === 25 && evidence.calls[0].options.maxResults === 64
        && evidence.draft === "96" && evidence.order === "descending"
        && evidence.status.includes("changed in another page")
        && evidence.stored.maxResults === 64 && evidence.discardedValue === "64",
      JSON.stringify(evidence),
    );
    if (process.env.HACHIDORI_OPTIONS_SCREENSHOT) {
      await page.bringToFront();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await (await page.$("#lookup")).screenshot({ path: process.env.HACHIDORI_OPTIONS_SCREENSHOT });
    }
  } finally {
    await page.evaluate(() => {
      window.__optionsSaveProbe?.release?.();
      window.__optionsSaveProbe?.restore();
      delete window.__optionsSaveProbe;
    });
    await mirror.close();
  }
}

async function main() {
  if (!CHROME || !existsSync(CHROME)) {
    fatal("no Chrome found (set HACHIDORI_CHROME or install it as described in test/README.md)");
  }
  if (!existsSync(PUPPETEER)) fatal(`no puppeteer-core at ${PUPPETEER} (set HACHIDORI_PUPPETEER)`);
  if (!existsSync(resolve(EXTENSION, "vendor/hoshidicts.wasm"))) {
    fatal("extension/vendor/hoshidicts.wasm is missing -- run wasm/build.sh first");
  }
  if (!HIGHLIGHT_NAME) {
    fatal("could not read HIGHLIGHT_NAME out of extension/content.js");
  }
  if (!existsSync(FIXTURE) || !existsSync(GENERIC_KANJI_FIXTURE)) {
    const r = spawnSync(process.execPath, [resolve(HERE, "make-fixture.mjs")], { encoding: "utf8" });
    if (r.status !== 0) fatal(`make-fixture.mjs failed:\n${r.stdout}\n${r.stderr}`);
  }

  const puppeteer = await import(PUPPETEER);
  const launch = puppeteer.default?.launch ? puppeteer.default : puppeteer;

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  // Start from a clean profile so the persistence check below is meaningful: the
  // dictionary must arrive via import, not via a leftover IndexedDB. Only the
  // per-pid default is deleted to get there -- an explicit HACHIDORI_PROFILE may be any
  // directory the reader named, including a real browser profile, and recursively
  // deleting that is not this file's business.
  if (process.env.HACHIDORI_PROFILE) {
    if (existsSync(PROFILE) && readdirSync(PROFILE).length > 0) {
      fatal(`HACHIDORI_PROFILE=${PROFILE} is not empty. Pass 1 has to import the fixture into a`
        + ` clean profile or the restart check proves nothing; remove it yourself and re-run.`);
    }
  } else {
    rmSync(PROFILE, { recursive: true, force: true });
  }
  mkdirSync(PROFILE, { recursive: true });
  console.log(`     profile: ${PROFILE}`);

  const launchArgs = {
    executablePath: CHROME,
    dumpio: process.env.HACHIDORI_DUMPIO === "1",
    headless: "shell" === process.env.HACHIDORI_HEADLESS ? "shell" : true,
    userDataDir: PROFILE,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
    ],
  };

  // Nothing else can see inside the offscreen document: puppeteer reports it as a
  // background_page, it has no console anyone reads, and a boot failure there is
  // silent. Every failure in this file that is not a rendering failure shows up
  // here first, so the CDP session is permanent rather than a debugging aid.
  async function watchOffscreen(target) {
    if (!target.url().endsWith("offscreen.html")) return;
    try {
      const cdp = await target.createCDPSession();
      await cdp.send("Runtime.enable");
      const flatten = args => (args || [])
        .map(a => a.value ?? a.description ?? a.unserializableValue ?? JSON.stringify(a.preview ?? null))
        .join(" ");
      cdp.on("Runtime.consoleAPICalled", e => diagnostics.push(`[offscreen] ${e.type}: ${flatten(e.args)}`));
      cdp.on("Runtime.exceptionThrown", e => diagnostics.push(
        `[offscreen] exception: ${e.exceptionDetails?.exception?.description
          ?? e.exceptionDetails?.text ?? "(no detail)"}`));
    } catch (e) {
      diagnostics.push(`[offscreen] could not attach: ${e?.message ?? e}`);
    }
  }

  const watchedServiceWorkers = new Map();
  function watch(browser) {
    browser.on("targetcreated", async target => {
      watchOffscreen(target);
      try {
        const worker = await target.worker?.();
        worker?.on?.("console", m => diagnostics.push(`[sw] ${m.text()}`));
        if (worker && target.type() === "service_worker") {
          watchedServiceWorkers.set(target, worker);
        }
      } catch { /* not a worker target */ }
    });
    browser.on("targetdestroyed", target => watchedServiceWorkers.delete(target));
    // The offscreen document is created from onInstalled, which can win the race
    // against the listener above.
    for (const target of browser.targets()) watchOffscreen(target);
  }

  // ---------------------------------------------------------------- pass 1
  let browser = await launch.launch(launchArgs);
  watch(browser);

  let swTarget;
  try {
    swTarget = await browser.waitForTarget(
      t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
      { timeout: 30_000 },
    );
  } catch {
    check("extension loads and its service worker starts", false,
      `no extension service_worker target appeared. targets:\n` +
      browser.targets().map(t => `  ${t.type()} ${t.url()}`).join("\n"));
    await browser.close();
    server.close();
    return report();
  }
  const extensionId = new URL(swTarget.url()).host;
  check("extension loads and its service worker starts", !!extensionId,
    `service_worker url: ${swTarget.url()}`);
  console.log(`     extension id: ${extensionId}`);

  const settingsUrl = `chrome-extension://${extensionId}/settings.html`;

  let page = await browser.newPage();
  page.on("console", m => diagnostics.push(`[settings] ${m.type()}: ${m.text()}`));
  page.on("pageerror", e => diagnostics.push(`[settings] pageerror: ${e.message}`));
  await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });

  const branding = await page.evaluate(() => {
    const manifest = chrome.runtime.getManifest();
    return {
      heading: document.querySelector(".masthead h1")?.textContent?.trim() ?? "",
      brand: document.querySelector(".brand")?.textContent?.trim() ?? "",
      icons: manifest.icons ?? {},
      name: manifest.name,
      shortName: manifest.short_name,
      title: document.title,
    };
  });
  check(
    "manifest and settings page are branded as Hachidori",
    branding.name === "Hachidori"
      && branding.shortName === "Hachidori"
      && branding.title === "Hachidori settings"
      && branding.heading === "Settings"
      && branding.brand === "Hachidori"
      && ["16", "32", "48", "128"].every(
        size => branding.icons[size] === `icons/hachidori-${size}.png`,
      ),
    JSON.stringify(branding),
  );
  await checkSettingsAutosave(page, browser, settingsUrl);
  await checkDictionaryStyles(page);

  await page.waitForFunction(() =>
    document.querySelectorAll("#recommended-dictionary-list > li").length === 4
      && document.getElementById("recommended-starter")?.hidden === false,
  { timeout: 90_000, polling: 100 }).catch(() => {});
  await page.setViewport({ width: 960, height: 900 });
  const desktopRecommendations = await page.evaluate(() => {
    const list = document.querySelector(".recommended-dictionary-list");
    const items = list ? [...list.children] : [];
    return {
      columns: list ? getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      links: [...document.querySelectorAll("a.recommended-dictionary-link")].map(anchor => [
        anchor.textContent.trim(),
        anchor.href,
        anchor.target,
        anchor.rel,
      ]),
      rects: items.map(item => {
        const rect = item.getBoundingClientRect();
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      }),
    };
  });
  const desktopLinks = desktopRecommendations.links.map(([name, url]) => [name, url]);
  check(
    "settings page renders exactly four safe recommended dictionary links",
    JSON.stringify(desktopLinks) === JSON.stringify(RECOMMENDED_LINKS)
      && desktopRecommendations.links.every(([, , target, rel]) =>
        target === "_blank" && rel.split(/\s+/u).includes("noopener") && rel.split(/\s+/u).includes("noreferrer")),
    JSON.stringify(desktopRecommendations.links),
  );
  const desktopRects = desktopRecommendations.rects;
  check(
    "recommended dictionaries form two columns on desktop",
    desktopRecommendations.columns === 2
      && desktopRects.length === RECOMMENDED_LINKS.length
      && Math.abs(desktopRects[0].top - desktopRects[1].top) <= 1
      && Math.abs(desktopRects[2].top - desktopRects[3].top) <= 1
      && desktopRects[0].left < desktopRects[1].left
      && desktopRects[2].top >= Math.max(desktopRects[0].bottom, desktopRects[1].bottom),
    JSON.stringify(desktopRecommendations),
  );

  await page.setViewport({ width: 480, height: 900 });
  const narrowRecommendations = await page.evaluate(() => {
    const list = document.querySelector(".recommended-dictionary-list");
    const items = list ? [...list.children] : [];
    const listRect = list?.getBoundingClientRect();
    return {
      columns: list ? getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      documentWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      list: listRect ? { left: listRect.left, right: listRect.right } : null,
      rects: items.map(item => {
        const rect = item.getBoundingClientRect();
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      }),
    };
  });
  check(
    "recommended dictionaries stack without overflow on narrow screens",
    narrowRecommendations.columns === 1
      && narrowRecommendations.rects.length === RECOMMENDED_LINKS.length
      && narrowRecommendations.scrollWidth <= narrowRecommendations.documentWidth
      && narrowRecommendations.rects.every((rect, index, rects) =>
        rect.left >= narrowRecommendations.list.left - 1
          && rect.right <= narrowRecommendations.list.right + 1
          && (index === 0 || rect.top >= rects[index - 1].bottom)),
    JSON.stringify(narrowRecommendations),
  );
  await page.setViewport({ width: 800, height: 600 });

  // The offscreen document is where the wasm is compiled. If the CSP forbids it,
  // or chrome.offscreen misbehaves, the engine never reaches a ready state and
  // this is the assertion that catches it.
  let statusText = "";
  const ready = await page.waitForFunction(() => {
    const el = document.getElementById("engine-status");
    const t = (el?.textContent || "").toLowerCase();
    return t.includes("ready") || t.includes("no dictionaries") || t.includes("error") || t.includes("fail")
      ? t : false;
  }, { timeout: 90_000, polling: 500 }).then(h => h.jsonValue()).catch(() => null);
  statusText = ready || "(never settled)";
  const engineUp = !!ready && !ready.includes("error") && !ready.includes("fail");
  check("offscreen document compiles the wasm under the extension CSP", engineUp,
    `#engine-status settled on: ${statusText}`);

  const threadPrerequisites = await page.evaluate(() => ({
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
  }));
  check("extension pages expose pthread prerequisites",
    threadPrerequisites.crossOriginIsolated && threadPrerequisites.sharedArrayBuffer,
    `thread prerequisites: ${JSON.stringify(threadPrerequisites)}`);

  const offscreenExists = await page.evaluate(async () =>
    (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length);
  check("chrome.offscreen.createDocument produced exactly one offscreen document",
    offscreenExists === 1, `getContexts returned ${offscreenExists}`);

  if (!engineUp) {
    await browser.close();
    server.close();
    return report();
  }

  const cleanInstaller = await page.evaluate(() => ({
    starterHidden: document.getElementById("recommended-starter")?.hidden,
    installText: document.getElementById("install-recommended")?.textContent?.trim() ?? "",
    retryHidden: document.getElementById("recommended-retry")?.hidden,
    localInputVisible: document.getElementById("import-file")?.closest(".file-button")?.hidden !== true,
    dictionaryManagementVisible: document.getElementById("dict-list")?.closest(".card")?.hidden !== true,
  }));
  check(
    "a clean profile shows one recommended install action beside local import",
    cleanInstaller.starterHidden === false
      && cleanInstaller.installText === "Install all recommended dictionaries"
      && cleanInstaller.retryHidden === true
      && cleanInstaller.localInputVisible === true
      && cleanInstaller.dictionaryManagementVisible === true,
    JSON.stringify(cleanInstaller),
  );
  if (process.env.HACHIDORI_SETTINGS_SCREENSHOT) {
    const importCard = await page.$('section[aria-labelledby="import-heading"]');
    await importCard.screenshot({ path: process.env.HACHIDORI_SETTINGS_SCREENSHOT });
  }

  const recommendedFixtures = new Map(RECOMMENDED_DICTIONARIES.map((entry) => [
    entry.downloadUrl,
    buildRecommendedZip(entry),
  ]));
  const recommendedRequests = [];
  const recommendedAttempts = new Map();
  const interceptRecommendedDownload = async (request) => {
    const archive = recommendedFixtures.get(request.url());
    if (!archive) {
      await request.continue();
      return;
    }
    const entry = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.downloadUrl === request.url());
    const attempt = (recommendedAttempts.get(entry.sourceId) ?? 0) + 1;
    recommendedAttempts.set(entry.sourceId, attempt);
    recommendedRequests.push(entry.sourceId);
    const headers = {
      "access-control-allow-origin": "*",
      "content-type": "application/zip",
      "cross-origin-resource-policy": "cross-origin",
    };
    if (entry.sourceId === "jmnedict" && attempt === 1) {
      await request.respond({ status: 503, headers, body: "mocked publisher failure" });
      return;
    }
    await request.respond({ status: 200, headers, body: archive });
  };
  await page.setRequestInterception(true);
  const recommendedRequestHandler = (request) => {
    void interceptRecommendedDownload(request).catch(async (error) => {
      diagnostics.push(`[recommendation mock] ${error?.stack ?? error}`);
      await request.abort().catch(() => {});
    });
  };
  page.on("request", recommendedRequestHandler);

  await page.click("#install-recommended");
  const recommendedFirstState = await page.waitForFunction(() => {
    const text = document.getElementById("import-state")?.textContent?.trim() ?? "";
    return text.startsWith("Finished 4 of 4 recommended dictionaries") ? text : false;
  }, { timeout: 120_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => "(never settled)");
  const recommendedFirst = await page.evaluate(() => ({
    state: document.getElementById("import-state")?.textContent?.trim() ?? "",
    progressHidden: document.getElementById("import-progress")?.hidden,
    starterHidden: document.getElementById("recommended-starter")?.hidden,
    retryHidden: document.getElementById("recommended-retry")?.hidden,
    localInputVisible: document.getElementById("import-file")?.closest(".file-button")?.hidden !== true,
    outcomes: [...document.querySelectorAll("#import-detail .import-result")].map((item) => ({
      text: item.textContent.trim(),
      error: item.classList.contains("is-error"),
    })),
  }));
  const recommendedFirstStorage = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
  const firstRecommendedPackages = recommendedFirstStorage.dictionaryState?.dictionaries ?? [];
  check(
    "the recommended installer continues after a mocked download failure",
    recommendedFirstState === "Finished 4 of 4 recommended dictionaries — 3 imported, 1 failed."
      && JSON.stringify(recommendedRequests) === JSON.stringify(
        RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId),
      )
      && recommendedFirst.progressHidden === true
      && recommendedFirst.starterHidden === true
      && recommendedFirst.retryHidden === false
      && recommendedFirst.localInputVisible === true
      && recommendedFirst.outcomes.length === 4
      && JSON.stringify(recommendedFirst.outcomes.map(({ error }) => error))
        === JSON.stringify([false, true, false, false])
      && firstRecommendedPackages.length === 3
      && firstRecommendedPackages.every((dictionary) => {
        const entry = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === dictionary.sourceId);
        return entry
          && dictionary.title === entry.title
          && dictionary.revision === entry.revision
          && dictionary.isUpdatable === true
          && dictionary.indexUrl === entry.indexUrl
          && dictionary.downloadUrl === entry.downloadUrl;
      }),
    `${recommendedFirstState}; UI: ${JSON.stringify(recommendedFirst)}; requests: ${JSON.stringify(recommendedRequests)};`
      + ` state: ${JSON.stringify(recommendedFirstStorage.dictionaryState)}`,
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedRecommended = await page.waitForFunction(() => {
    const rows = document.querySelectorAll("#dict-list .dict-row").length;
    return rows === 3 ? {
      rows,
      starterHidden: document.getElementById("recommended-starter")?.hidden,
      retryHidden: document.getElementById("recommended-retry")?.hidden,
      localInputVisible: document.getElementById("import-file")?.closest(".file-button")?.hidden !== true,
    } : false;
  }, { timeout: 90_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => null);
  check(
    "the starter card stays hidden after a settings reload",
    reloadedRecommended?.rows === 3
      && reloadedRecommended.starterHidden === true
      && reloadedRecommended.retryHidden === false
      && reloadedRecommended.localInputVisible === true,
    JSON.stringify(reloadedRecommended),
  );

  const requestsBeforeRetry = recommendedRequests.length;
  await page.click("#retry-recommended");
  const recommendedRetryState = await page.waitForFunction(() => {
    const text = document.getElementById("import-state")?.textContent?.trim() ?? "";
    return text.startsWith("Finished 1 of 1 recommended dictionary") ? text : false;
  }, { timeout: 120_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => "(never settled)");
  const recommendedRetry = await page.evaluate(() => ({
    outcomes: [...document.querySelectorAll("#import-detail .import-result")].map((item) => item.textContent.trim()),
    retryHidden: document.getElementById("recommended-retry")?.hidden,
    state: document.getElementById("import-state")?.textContent?.trim() ?? "",
  }));
  const recommendedRetryStorage = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
  const allRecommendedPackages = recommendedRetryStorage.dictionaryState?.dictionaries ?? [];
  check(
    "recommended retry downloads only the missing trusted dictionary",
    recommendedRetryState === "Finished 1 of 1 recommended dictionary — 1 imported, 0 failed."
      && JSON.stringify(recommendedRequests.slice(requestsBeforeRetry)) === JSON.stringify(["jmnedict"])
      && recommendedRetry.outcomes.length === 1
      && recommendedRetry.outcomes[0].includes("JMnedict for Yomitan")
      && recommendedRetry.retryHidden === true
      && allRecommendedPackages.length === RECOMMENDED_DICTIONARIES.length
      && RECOMMENDED_DICTIONARIES.every((entry) => allRecommendedPackages.some((dictionary) =>
        dictionary.sourceId === entry.sourceId
          && dictionary.title === entry.title
          && dictionary.revision === entry.revision
          && dictionary.indexUrl === entry.indexUrl
          && dictionary.downloadUrl === entry.downloadUrl)),
    `${recommendedRetryState}; UI: ${JSON.stringify(recommendedRetry)}; requests: ${JSON.stringify(recommendedRequests)};`
      + ` state: ${JSON.stringify(recommendedRetryStorage.dictionaryState)}`,
  );

  if (process.env.HACHIDORI_LIBRARY_SCREENSHOT) {
    await page.setViewport({ width: 1280, height: 1100 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: process.env.HACHIDORI_LIBRARY_SCREENSHOT });
    if (process.env.HACHIDORI_LIBRARY_DARK_SCREENSHOT) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
      await page.screenshot({ path: process.env.HACHIDORI_LIBRARY_DARK_SCREENSHOT });
    }
    await page.emulateMediaFeatures([]);
    await page.setViewport({ width: 800, height: 600 });
  }

  for (const { title } of RECOMMENDED_DICTIONARIES) {
    const removed = await page.evaluate((dictionaryTitle) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_remove",
      requestId: `e2e-remove-recommended-${dictionaryTitle}`,
      title: dictionaryTitle,
    }), title);
    if (removed?.ok !== true) {
      throw new Error(`could not clear mocked recommended dictionary ${title}: ${JSON.stringify(removed)}`);
    }
  }
  await page.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return dictionaryState?.dictionaries?.length === 0
      && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 100 });
  page.off("request", recommendedRequestHandler);
  await page.setRequestInterception(false);

  // ------------------------------------------------------------------ import
  const input = await page.$("#import-file");
  check("settings page exposes a .zip file input", !!input);
  if (!input) {
    await browser.close();
    server.close();
    return report();
  }
  // An <input> of the wrong type takes no file at all, and one that accepts
  // everything offers the reader dictionaries it cannot import.
  const inputShape = await page.evaluate(() => {
    const el = document.getElementById("import-file");
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type,
      accept: el.getAttribute("accept") || "",
      multiple: el.multiple,
    };
  });
  check("the .zip file input accepts multiple .zip files",
    inputShape.tag === "input" && inputShape.type === "file"
      && inputShape.accept.split(",").map(s => s.trim()).includes(".zip")
      && inputShape.multiple === true,
    `#import-file: ${JSON.stringify(inputShape)}`);
  await input.uploadFile(FIXTURE);

  const importState = await page.waitForFunction(() => {
    const t = (document.getElementById("import-state")?.textContent || "").trim();
    return t.startsWith("Finished 1 of 1 archive") ? t : false;
  }, { timeout: 120_000, polling: 500 }).then(h => h.jsonValue()).catch(() => "(never settled)");
  const importDetail = await page.evaluate(() =>
    (document.getElementById("import-detail")?.textContent || "").trim());
  const importOk = importState === "Finished 1 of 1 archive — 1 imported, 0 failed."
    && importDetail.includes("hachidori-fixture.zip")
    && importDetail.includes("Imported hachidori-fixture");
  check("importing a Yomitan .zip from the settings page succeeds", importOk,
    `#import-state: ${importState}\n       #import-detail: ${importDetail}`);

  const opfsFiles = await listOpfsPaths(page);

  const stored = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
  const dictionaryState = stored?.dictionaryState;
  const dicts = dictionaryState?.dictionaries ?? [];
  const fixturePackage = dicts[0];
  const fixtureId = fixturePackage?.id ?? "";
  const firstFixtureGeneration = ownedGenerationRoot(fixturePackage?.path, "hachidori-fixture");
  check("the imported dictionary is persisted in OPFS",
    firstFixtureGeneration !== "" && generationExists(opfsFiles, fixturePackage.path),
    `dictionary path: ${JSON.stringify(fixturePackage?.path)}; OPFS paths: ${JSON.stringify(opfsFiles)}`);
  // The fixture has term, frequency, pitch, kanji and media data, but is one
  // installed package. Native dictionaryCount still counts its four query kinds.
  check("the imported dictionary is recorded in chrome.storage.local",
    dictionaryState?.schemaVersion === 1
      && Number.isInteger(dictionaryState.revision)
      && dictionaryState.revision > 0
      && dicts.length === 1
      && fixtureId === FIXTURE_ID
      && fixturePackage.title === "hachidori-fixture"
      && fixturePackage.displayName === null
      && firstFixtureGeneration !== ""
      && fixturePackage.enabled === true
      && fixturePackage.favorite === false
      && fixturePackage.revision === "test-1"
      && fixturePackage.isUpdatable === false
      && fixturePackage.indexUrl === null
      && fixturePackage.downloadUrl === null
      && fixturePackage.language === "ja"
      && fixturePackage.termCount === 6
      && fixturePackage.frequencyCount === 2
      && fixturePackage.pitchCount === 2
      && fixturePackage.kanjiCount === 1
      && fixturePackage.mediaCount === 1
      && typeof fixturePackage.installedAt === "string"
      && Number.isFinite(Date.parse(fixturePackage.installedAt))
      && fixturePackage.lastUpdateCheck === null,
    `dictionaryState: ${JSON.stringify(dictionaryState)}`);

  const aliasChanged = await setDictionaryAliasInSettings(page, "hachidori-fixture", FIXTURE_ALIAS);
  const stateBeforeReimport = await page.evaluate(async (presentation) => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    return chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_apply_state",
      requestId: "e2e-preserve-reimport-state",
      baseRevision: current.revision,
      dictionaries: current.dictionaries.map((dictionary) => ({
        ...dictionary,
        ...(dictionary.title === "hachidori-fixture" ? presentation : {}),
      })),
    });
  }, {
    enabled: false,
    favorite: true,
    isUpdatable: true,
    indexUrl: MANAGED_INDEX_URL,
    downloadUrl: MANAGED_DOWNLOAD_URL,
    lastUpdateCheck: LAST_UPDATE_CHECK,
  });

  const batchInput = await page.$("#import-file");
  await batchInput.uploadFile(GENERIC_KANJI_FIXTURE, INVALID_FIXTURE, FIXTURE);
  const batchState = await page.waitForFunction(() => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith("Finished 3 of 3 archives") ? text : false;
  }, { timeout: 180_000, polling: 250 }).then(handle => handle.jsonValue()).catch(() => "(never settled)");
  const batchUi = await page.evaluate(() => ({
    pickerValue: document.getElementById("import-file")?.value ?? "missing",
    progressHidden: document.getElementById("import-progress")?.hidden,
    stateError: document.getElementById("import-state")?.classList.contains("is-error"),
    outcomes: [...document.querySelectorAll("#import-detail .import-result")].map((result) => ({
      text: result.textContent.trim(),
      error: result.classList.contains("is-error"),
    })),
  }));
  const replacedState = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
  const replacedDictionaries = replacedState?.dictionaryState?.dictionaries ?? [];
  const replacedPackage = replacedDictionaries.find(
    (dictionary) => dictionary.title === "hachidori-fixture",
  );
  const genericPackage = replacedDictionaries.find(
    (dictionary) => dictionary.title === GENERIC_KANJI_TITLE,
  );
  const replacedFixtureGeneration = ownedGenerationRoot(
    replacedPackage?.path,
    "hachidori-fixture",
  );
  await waitForGenerationAbsent(page, firstFixtureGeneration);
  const opfsAfterBatch = await listOpfsPaths(page);
  check("the import batch continues after failure and retains every archive outcome",
    batchState === "Finished 3 of 3 archives — 2 imported, 1 failed."
      && batchUi.pickerValue === ""
      && batchUi.progressHidden === true
      && batchUi.stateError === true
      && batchUi.outcomes.length === 3
      && batchUi.outcomes[0].error === false
      && batchUi.outcomes[0].text.includes("hachidori-generic-kanji-fixture.zip")
      && batchUi.outcomes[0].text.includes(`Imported ${GENERIC_KANJI_TITLE}`)
      && batchUi.outcomes[1].error === true
      && batchUi.outcomes[1].text.includes("malformed-index.zip")
      && batchUi.outcomes[1].text.includes("Could not be imported")
      && batchUi.outcomes[2].error === false
      && batchUi.outcomes[2].text.includes("hachidori-fixture.zip")
      && batchUi.outcomes[2].text.includes("Imported hachidori-fixture"),
    `#import-state: ${batchState}; batch UI: ${JSON.stringify(batchUi)}`);
  check("batch re-import preserves presentation, source, and order while clearing stale check state",
    aliasChanged?.settled?.id === FIXTURE_ID
      && stateBeforeReimport?.ok === true
      && replacedDictionaries.length === 2
      && replacedState.dictionaryState.revision > dictionaryState.revision
      && JSON.stringify(replacedDictionaries.map((dictionary) => dictionary.id))
        === JSON.stringify([FIXTURE_ID, GENERIC_KANJI_ID])
      && replacedPackage?.id === FIXTURE_ID
      && replacedFixtureGeneration !== ""
      && replacedPackage.path !== fixturePackage.path
      && generationExists(opfsAfterBatch, replacedPackage.path)
      && generationIsAbsent(opfsAfterBatch, firstFixtureGeneration)
      && replacedPackage?.displayName === FIXTURE_ALIAS
      && replacedPackage?.enabled === false
      && replacedPackage?.favorite === true
      && replacedPackage?.isUpdatable === true
      && replacedPackage?.indexUrl === MANAGED_INDEX_URL
      && replacedPackage?.downloadUrl === MANAGED_DOWNLOAD_URL
      && replacedPackage?.lastUpdateCheck === null,
    `alias change: ${JSON.stringify(aliasChanged)}; state before reimport: ${JSON.stringify(stateBeforeReimport)};`
      + ` dictionaryState: ${JSON.stringify(replacedState?.dictionaryState)}; OPFS paths: ${JSON.stringify(opfsAfterBatch)}`);

  await page.waitForFunction((alias) => {
    const row = document.querySelector("#dict-list .dict-row");
    return row?.querySelector(".dict-title")?.textContent === alias
      && row.querySelectorAll(".dict-badge").length === 5;
  }, { timeout: 10_000, polling: 100 }, FIXTURE_ALIAS).catch(() => {});
  const renderedDictionary = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#dict-list .dict-row")];
    const row = rows[0];
    return {
      count: rows.length,
      title: row?.querySelector(".dict-title")?.textContent ?? "",
      canonical: row?.querySelector(".dict-canonical")?.textContent ?? "",
      alias: row?.querySelector(".dict-display-name")?.value ?? "",
      enabled: row?.querySelector(".dict-enabled")?.checked,
      favorite: row?.querySelector(".dict-favorite")?.hidden === false,
      badges: [...(row?.querySelectorAll(".dict-badge") ?? [])].map((badge) => ({
        capability: badge.dataset.capability,
        text: badge.textContent,
      })),
      metadata: row?.querySelector(".dict-metadata")?.textContent ?? "",
    };
  });
  check("the dictionary list renders its alias, metadata, and five capability badges",
    renderedDictionary.count === 2
      && renderedDictionary.title === FIXTURE_ALIAS
      && renderedDictionary.canonical === "hachidori-fixture"
      && renderedDictionary.alias === FIXTURE_ALIAS
      && renderedDictionary.enabled === false
      && renderedDictionary.favorite === true
      && JSON.stringify(renderedDictionary.badges) === JSON.stringify([
        { capability: "terms", text: "Terms 6" },
        { capability: "frequency", text: "Frequency 2" },
        { capability: "pitch", text: "Pitch 2" },
        { capability: "kanji", text: "Kanji 1" },
        { capability: "media", text: "Media 1" },
      ])
      && renderedDictionary.metadata.includes("Revision test-1")
      && renderedDictionary.metadata.includes("ja")
      && renderedDictionary.metadata.includes("Imported ")
      && renderedDictionary.metadata.includes("Update source available"),
    `#dict-list: ${JSON.stringify(renderedDictionary)}`);

  await page.setViewport({ width: 1280, height: 900 });
  const libraryFirst = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const row = document.querySelector("#dict-list .dict-row");
    const links = [...document.querySelectorAll(".settings-nav a")];
    return document.querySelector("main > section")?.id === "dictionaries"
      && row.getBoundingClientRect().bottom < window.innerHeight
      && links.length === 6
      && links.every((link) => document.getElementById(link.hash.slice(1))?.tagName === "SECTION");
  });
  const selectionActions = await page.evaluate(() => {
    const actions = document.getElementById("dict-bulk-actions");
    const selected = document.querySelector(".dict-selected");
    const initiallyHidden = actions.hidden;
    selected.click();
    const visibleWhenSelected = !actions.hidden;
    selected.click();
    return initiallyHidden && visibleWhenSelected && actions.hidden;
  });
  await page.setViewport({ width: 1280, height: 320 });
  await page.focus('.settings-nav a[href="#lookup"]');
  const shortWindowNavigation = await page.evaluate(() => {
    const rect = document.activeElement.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  await page.setViewport({ width: 320, height: 900 });
  await page.focus('.settings-nav a[href="#lookup"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#lookup");
  const narrowThemes = [];
  for (const theme of ["light", "dark"]) {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    narrowThemes.push(await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const inputs = [...document.querySelectorAll("#lookup input, #lookup select")];
      return {
        noOverflow: document.documentElement.scrollWidth <= width,
        fieldsFit: inputs.every((input) => {
          const rect = input.getBoundingClientRect();
          return rect.width > 0 && rect.left >= 0 && rect.right <= width;
        }),
        disabledRowReadable: getComputedStyle(document.querySelector(".dict-row.is-off")).opacity === "1",
        emptyStatusExposed: getComputedStyle(document.getElementById("custom-dictionary-status")).display !== "none",
      };
    }));
  }
  await page.focus(".skip-link");
  await page.keyboard.press("Enter");
  const skipFocusedMain = await page.evaluate(() => document.activeElement.id === "settings-content");
  check(
    "Settings puts the library first and supports keyboard navigation at 320px",
    libraryFirst && selectionActions && skipFocusedMain && shortWindowNavigation
      && narrowThemes.every((theme) => theme.noOverflow && theme.fieldsFit
        && theme.disabledRowReadable && theme.emptyStatusExposed),
    JSON.stringify({ libraryFirst, selectionActions, skipFocusedMain, shortWindowNavigation, narrowThemes }),
  );
  await page.emulateMediaFeatures([]);
  await page.setViewport({ width: 480, height: 900 });
  const narrowPosition = await page.evaluate(() => {
    const row = document.querySelector("#dict-list .dict-row");
    const actions = row?.querySelector(".dict-actions");
    const input = row?.querySelector(".dict-position-input");
    const inputRect = input?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    const inputStyle = input ? getComputedStyle(input) : null;
    return {
      actionsRight: actionsRect?.right ?? 0,
      contentWidth: Number.parseFloat(inputStyle?.width ?? "0"),
      fontSize: Number.parseFloat(inputStyle?.fontSize ?? "0"),
      inputWidth: inputRect?.width ?? 0,
      pageWidth: document.documentElement.clientWidth,
      rowRight: rowRect?.right ?? 0,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  check(
    "the dictionary position input stays compact on a narrow Settings page",
    narrowPosition.inputWidth > 0
      && Math.abs(narrowPosition.inputWidth - (narrowPosition.fontSize * 4.5)) <= 1
      && narrowPosition.actionsRight <= narrowPosition.rowRight + 1
      && narrowPosition.scrollWidth === narrowPosition.pageWidth,
    JSON.stringify(narrowPosition),
  );
  await page.setViewport({ width: 800, height: 600 });

  const fixtureEnabled = await setDictionaryEnabledInSettings(page, "hachidori-fixture", true);
  check(
    "the Settings enabled control re-enables the preserved package",
    fixtureEnabled?.settled?.id === FIXTURE_ID,
    JSON.stringify(fixtureEnabled),
  );

  check(
    "importing a term-only single-kanji dictionary succeeds",
    genericPackage?.id === GENERIC_KANJI_ID
      && genericPackage.id !== fixtureId
      && generationExists(opfsAfterBatch, genericPackage.path),
    `dictionaryState: ${JSON.stringify(replacedState?.dictionaryState)}; OPFS paths: ${JSON.stringify(opfsAfterBatch)}`,
  );

  await page.waitForFunction(() => document.querySelectorAll("#dict-list .dict-row").length === 2, {
    timeout: 10_000,
    polling: 100,
  });
  const managementStarted = await page.evaluate(async (fixtureId) => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    const search = document.getElementById("dict-search");
    search.value = "ＦＩＸＴＵＲＥ ＡＬＩＡＳ";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const visibleIds = [...document.querySelectorAll("#dict-list .dict-row")]
      .map((row) => row.dataset.dictionaryId);
    document.getElementById("dict-select-visible").click();
    const selectedIds = [...document.querySelectorAll("#dict-list .dict-row")]
      .filter((row) => row.querySelector(".dict-selected")?.checked)
      .map((row) => row.dataset.dictionaryId);
    document.getElementById("dict-bulk-disable").click();
    return {
      baseRevision: current.revision,
      fixtureId,
      query: search.value,
      selectedIds,
      visibleIds,
    };
  }, FIXTURE_ID);
  const managementDisabled = await page.waitForFunction(async ({ baseRevision, fixtureId }) => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    const fixture = current?.dictionaries?.find((dictionary) => dictionary.id === fixtureId);
    const other = current?.dictionaries?.find((dictionary) => dictionary.id !== fixtureId);
    const selected = document.querySelector("#dict-list .dict-selected")?.checked === true;
    return current?.revision > baseRevision
      && fixture?.enabled === false
      && other?.enabled === true
      && selected
      && document.getElementById("dict-search")?.value === "ＦＩＸＴＵＲＥ ＡＬＩＡＳ"
      ? { revision: current.revision }
      : false;
  }, { timeout: 10_000, polling: 100 }, managementStarted).then((handle) => handle.jsonValue());
  await page.click("#dict-bulk-enable");
  const managementEnabled = await page.waitForFunction(async ({ revision, fixtureId }) => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    const fixture = current?.dictionaries?.find((dictionary) => dictionary.id === fixtureId);
    return current?.revision > revision && fixture?.enabled === true
      ? { revision: current.revision }
      : false;
  }, { timeout: 10_000, polling: 100 }, {
    fixtureId: FIXTURE_ID,
    revision: managementDisabled.revision,
  }).then((handle) => handle.jsonValue());
  check(
    "dictionary management filters and bulk-updates visible stable selections",
    managementStarted.query === "ＦＩＸＴＵＲＥ ＡＬＩＡＳ"
      && JSON.stringify(managementStarted.visibleIds) === JSON.stringify([FIXTURE_ID])
      && JSON.stringify(managementStarted.selectedIds) === JSON.stringify([FIXTURE_ID])
      && managementDisabled.revision > managementStarted.baseRevision
      && managementEnabled.revision > managementDisabled.revision,
    JSON.stringify({ managementStarted, managementDisabled, managementEnabled }),
  );

  await page.evaluate(() => {
    const search = document.getElementById("dict-search");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const orderBeforeDrag = await page.evaluate(async () => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    return {
      order: current.dictionaries.map((dictionary) => dictionary.id),
      revision: current.revision,
    };
  });
  const dragHandle = await page.$(
    `#dict-list .dict-row[data-dictionary-id="${GENERIC_KANJI_ID}"] .dict-drag`,
  );
  const dragTarget = await page.$(
    `#dict-list .dict-row[data-dictionary-id="${FIXTURE_ID}"]`,
  );
  await page.setDragInterception(true);
  await dragHandle.dragAndDrop(dragTarget);
  await page.setDragInterception(false);
  const orderAfterDrag = await page.waitForFunction(async ({ fixtureId, genericId, revision }) => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    const order = current?.dictionaries?.map((dictionary) => dictionary.id);
    return current?.revision > revision && order?.[0] === genericId && order?.[1] === fixtureId
      ? { order, revision: current.revision }
      : false;
  }, { timeout: 10_000, polling: 100 }, {
    fixtureId: FIXTURE_ID,
    genericId: GENERIC_KANJI_ID,
    revision: orderBeforeDrag.revision,
  }).then((handle) => handle.jsonValue());
  await page.evaluate((fixtureId) => {
    const row = [...document.querySelectorAll("#dict-list .dict-row")]
      .find((candidate) => candidate.dataset.dictionaryId === fixtureId);
    const position = row.querySelector(".dict-position-input");
    position.value = "1";
    position.focus();
  }, FIXTURE_ID);
  await page.keyboard.press("Enter");
  const orderAfterKeyboardMove = await page.waitForFunction(async ({ fixtureId, genericId, revision }) => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    const order = current?.dictionaries?.map((dictionary) => dictionary.id);
    const selected = [...document.querySelectorAll("#dict-list .dict-row")]
      .find((row) => row.dataset.dictionaryId === fixtureId)
      ?.querySelector(".dict-selected")?.checked === true;
    return current?.revision > revision && order?.[0] === fixtureId && order?.[1] === genericId && selected
      ? { order, revision: current.revision, selected }
      : false;
  }, { timeout: 10_000, polling: 100 }, {
    fixtureId: FIXTURE_ID,
    genericId: GENERIC_KANJI_ID,
    revision: orderAfterDrag.revision,
  }).then((handle) => handle.jsonValue());
  check(
    "drag and keyboard position controls share the persisted lookup order",
    JSON.stringify(orderBeforeDrag.order) === JSON.stringify([FIXTURE_ID, GENERIC_KANJI_ID])
      && JSON.stringify(orderAfterDrag.order) === JSON.stringify([GENERIC_KANJI_ID, FIXTURE_ID])
      && JSON.stringify(orderAfterKeyboardMove.order) === JSON.stringify(orderBeforeDrag.order)
      && orderAfterKeyboardMove.selected === true,
    JSON.stringify({ orderBeforeDrag, orderAfterDrag, orderAfterKeyboardMove }),
  );

  const aliasRowSelector = `#dict-list .dict-row[data-dictionary-id="${FIXTURE_ID}"]`;
  const beforeAliasBlurAction = orderAfterKeyboardMove.revision;
  await replaceInputText(page, `${aliasRowSelector} .dict-display-name`, "Blurred alias");
  await page.click(`${aliasRowSelector} .dict-down`, { delay: 150 });
  const aliasBlurAction = await page.evaluate(async ({ beforeRevision, dictionaryId }) => {
    const deadline = Date.now() + 3000;
    let current;
    do {
      current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
      if (current.revision >= beforeRevision + 2) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    } while (Date.now() < deadline);
    return {
      revision: current.revision,
      alias: current.dictionaries.find((dictionary) => dictionary.id === dictionaryId)?.displayName,
      lastDictionaryId: current.dictionaries.at(-1)?.id,
      focusedDictionaryId: document.activeElement?.closest(".dict-row")?.dataset.dictionaryId,
    };
  }, { beforeRevision: beforeAliasBlurAction, dictionaryId: FIXTURE_ID });
  check(
    "a delayed alias blur-then-click queues both dictionary edits",
    aliasBlurAction.revision >= beforeAliasBlurAction + 2
      && aliasBlurAction.alias === "Blurred alias"
      && aliasBlurAction.lastDictionaryId === FIXTURE_ID
      && aliasBlurAction.focusedDictionaryId === FIXTURE_ID,
    JSON.stringify({ beforeAliasBlurAction, aliasBlurAction }),
  );
  await page.click(`${aliasRowSelector} .dict-up`);
  await page.waitForFunction(async ({ dictionaryId, revision }) => {
    const current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
    return current.revision > revision && current.dictionaries[0]?.id === dictionaryId;
  }, { timeout: 10_000, polling: 100 }, {
    dictionaryId: FIXTURE_ID,
    revision: aliasBlurAction.revision,
  });

  const groupManagement = await page.evaluate(async ({ fixtureId, genericId, fixtureAlias }) => {
    const nameInput = document.getElementById("dict-group-name-new");
    const createButton = document.getElementById("dict-group-create");
    const error = document.getElementById("dict-group-error");
    if (!(nameInput instanceof HTMLInputElement)
        || !(createButton instanceof HTMLButtonElement)
        || !(error instanceof HTMLElement)) {
      return { error: "dictionary group controls were missing" };
    }

    const state = async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState;
    const waitFor = async (revision, matches) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const current = await state();
        if (current.revision > revision && matches(current)) return current;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      throw new Error("dictionary group state did not settle");
    };
    const groupRow = (id) => [...document.querySelectorAll("#dict-group-list .dict-group")]
      .find((row) => row.dataset.groupId === id);
    const memberRow = (groupId, dictionaryId) => [...groupRow(groupId)
      ?.querySelectorAll(".dict-group-member") ?? []]
      .find((row) => row.dataset.dictionaryId === dictionaryId);
    const addMember = async (groupId, dictionaryId) => {
      const before = await state();
      const row = groupRow(groupId);
      const select = row.querySelector(".dict-group-add-select");
      select.value = dictionaryId;
      row.querySelector(".dict-group-add").click();
      return waitFor(before.revision, (current) => current.groups
        .find((group) => group.id === groupId)?.dictionaryIds.includes(dictionaryId));
    };

    let current = await state();
    nameInput.value = "  Ｓtudy\t  Deck ";
    createButton.click();
    current = await waitFor(current.revision, (candidate) => candidate.groups?.length === 1);
    const studyGroupId = current.groups[0].id;
    const normalisedName = current.groups[0].name;
    const createRevision = current.revision;

    nameInput.value = "study deck";
    createButton.click();
    const duplicateError = error.textContent;
    nameInput.value = " Ａｌｌ ";
    createButton.click();
    const reservedError = error.textContent;
    const invalidRevision = (await state()).revision;

    nameInput.value = "Grammar";
    createButton.click();
    current = await waitFor(current.revision, (candidate) => candidate.groups?.length === 2);
    const grammarGroupId = current.groups.find((group) => group.name === "Grammar").id;
    const grammarUp = groupRow(grammarGroupId).querySelector(".dict-group-up");
    grammarUp.focus();
    grammarUp.click();
    current = await waitFor(current.revision, (candidate) => candidate.groups?.[0]?.id === grammarGroupId);
    const groupOrderAfterMove = current.groups.map((group) => group.name);
    const groupMoveFocusRetained = document.activeElement?.classList.contains("dict-group-down") === true
      && document.activeElement.closest(".dict-group")?.dataset.groupId === grammarGroupId;

    const rename = groupRow(studyGroupId).querySelector(".dict-group-name");
    rename.value = "Reading";
    rename.dispatchEvent(new Event("change", { bubbles: true }));
    current = await waitFor(current.revision, (candidate) => candidate.groups
      .find((group) => group.id === studyGroupId)?.name === "Reading");

    const studyAdd = groupRow(studyGroupId).querySelector(".dict-group-add");
    studyAdd.focus();
    current = await addMember(studyGroupId, fixtureId);
    const groupAddFocusRetained = document.activeElement?.classList.contains("dict-group-add") === true
      && document.activeElement.closest(".dict-group")?.dataset.groupId === studyGroupId;
    current = await addMember(studyGroupId, genericId);
    const membershipBeforeMove = current.groups
      .find((group) => group.id === studyGroupId).dictionaryIds;
    const genericUp = memberRow(studyGroupId, genericId).querySelector(".dict-group-member-up");
    genericUp.focus();
    genericUp.click();
    current = await waitFor(current.revision, (candidate) => candidate.groups
      .find((group) => group.id === studyGroupId)?.dictionaryIds[0] === genericId);
    const membershipAfterMove = current.groups
      .find((group) => group.id === studyGroupId).dictionaryIds;
    const memberMoveFocusRetained = document.activeElement?.classList.contains("dict-group-member-down") === true
      && document.activeElement.closest(".dict-group-member")?.dataset.dictionaryId === genericId;

    const aliasInput = [...document.querySelectorAll("#dict-list .dict-row")]
      .find((row) => row.dataset.dictionaryId === fixtureId)
      ?.querySelector(".dict-display-name");
    const beforeAlias = current.revision;
    aliasInput.value = "Grouped alias";
    aliasInput.dispatchEvent(new Event("change", { bubbles: true }));
    current = await waitFor(beforeAlias, (candidate) => candidate.dictionaries
      .find((dictionary) => dictionary.id === fixtureId)?.displayName === "Grouped alias");
    const membershipAfterAlias = current.groups
      .find((group) => group.id === studyGroupId).dictionaryIds;
    const groupedAliasLabel = memberRow(studyGroupId, fixtureId)
      ?.querySelector(".dict-group-member-name")?.textContent;

    const restoredAliasInput = [...document.querySelectorAll("#dict-list .dict-row")]
      .find((row) => row.dataset.dictionaryId === fixtureId)
      ?.querySelector(".dict-display-name");
    restoredAliasInput.value = fixtureAlias;
    restoredAliasInput.dispatchEvent(new Event("change", { bubbles: true }));
    current = await waitFor(current.revision, (candidate) => candidate.dictionaries
      .find((dictionary) => dictionary.id === fixtureId)?.displayName === fixtureAlias);

    return {
      studyGroupId,
      normalisedName,
      duplicateError,
      reservedError,
      createRevision,
      invalidRevision,
      groupOrderAfterMove,
      groupMoveFocusRetained,
      groupAddFocusRetained,
      finalGroupOrder: current.groups.map((group) => group.name),
      membershipBeforeMove,
      membershipAfterMove,
      memberMoveFocusRetained,
      membershipAfterAlias,
      groupedAliasLabel,
    };
  }, { fixtureId: FIXTURE_ID, genericId: GENERIC_KANJI_ID, fixtureAlias: FIXTURE_ALIAS });
  check(
    "named groups normalize unique names and keep stable dictionary memberships",
    groupManagement.normalisedName === "Study Deck"
      && groupManagement.duplicateError?.includes("already exists")
      && groupManagement.reservedError?.includes("reserved")
      && groupManagement.invalidRevision === groupManagement.createRevision
      && groupManagement.groupMoveFocusRetained === true
      && groupManagement.groupAddFocusRetained === true
      && groupManagement.memberMoveFocusRetained === true
      && JSON.stringify(groupManagement.membershipAfterAlias)
        === JSON.stringify(groupManagement.membershipAfterMove)
      && groupManagement.groupedAliasLabel === "Grouped alias",
    JSON.stringify(groupManagement),
  );
  check(
    "group and member order controls persist their shared state order",
    JSON.stringify(groupManagement.groupOrderAfterMove) === JSON.stringify(["Grammar", "Study Deck"])
      && JSON.stringify(groupManagement.finalGroupOrder) === JSON.stringify(["Grammar", "Reading"])
      && JSON.stringify(groupManagement.membershipBeforeMove) === JSON.stringify([FIXTURE_ID, GENERIC_KANJI_ID])
      && JSON.stringify(groupManagement.membershipAfterMove) === JSON.stringify([GENERIC_KANJI_ID, FIXTURE_ID]),
    JSON.stringify(groupManagement),
  );

  const editedGroupSelector = `[data-group-id="${groupManagement.studyGroupId}"]`;
  const beforeBlurAction = await page.evaluate(async () =>
    (await chrome.storage.local.get("dictionaryState")).dictionaryState.revision);
  await replaceInputText(page, `${editedGroupSelector} .dict-group-name`, "Focused reading");
  await page.click(`${editedGroupSelector} .dict-group-up`, { delay: 150 });
  const blurAction = await page.evaluate(async ({ beforeRevision, groupId }) => {
    const deadline = Date.now() + 3000;
    let current;
    do {
      current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
      if (current.revision >= beforeRevision + 2) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    } while (Date.now() < deadline);
    return {
      revision: current.revision,
      name: current.groups.find((group) => group.id === groupId)?.name,
      firstGroupId: current.groups[0]?.id,
      focusedGroupId: document.activeElement?.closest(".dict-group")?.dataset.groupId,
    };
  }, { beforeRevision: beforeBlurAction, groupId: groupManagement.studyGroupId });
  check(
    "a real blur-then-click queues both group edits and retains focus",
    blurAction.revision >= beforeBlurAction + 2
      && blurAction.name === "Focused reading"
      && blurAction.firstGroupId === groupManagement.studyGroupId
      && blurAction.focusedGroupId === groupManagement.studyGroupId,
    JSON.stringify({ beforeBlurAction, blurAction }),
  );

  const externalFocus = await page.evaluate(async (groupId) => {
    const before = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
    const input = document.querySelector(`[data-group-id="${groupId}"] .dict-group-name`);
    const search = document.getElementById("dict-search");
    input.focus();
    input.value = "Externally focused reading";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    search.focus();

    const deadline = Date.now() + 3000;
    let current;
    do {
      current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
      if (current.revision > before.revision) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    } while (Date.now() < deadline);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    return {
      focusedId: document.activeElement?.id,
      name: current.groups.find((group) => group.id === groupId)?.name,
    };
  }, groupManagement.studyGroupId);
  check(
    "a newer external focus survives a group rerender",
    externalFocus.focusedId === "dict-search"
      && externalFocus.name === "Externally focused reading",
    JSON.stringify(externalFocus),
  );

  const kanjiChooser = await page.evaluate(() => {
    const select = document.getElementById("opt-kanji-dictionary");
    return {
      exists: select instanceof HTMLSelectElement,
      options: select
        ? Array.from(select.options, option => ({ text: option.textContent, value: option.value }))
        : [],
    };
  });
  check(
    "the kanji dictionary chooser lists imported term and kanji dictionaries",
    kanjiChooser.exists
      && kanjiChooser.options.some(({ value }) => value === FIXTURE_KANJI_SELECTION_VALUE)
      && kanjiChooser.options.some(({ value }) => value === GENERIC_KANJI_SELECTION_VALUE),
    JSON.stringify(kanjiChooser),
  );
  check(
    "a combined archive exposes separate term and native kanji choices",
    kanjiChooser.options.some(({ value }) => value === FIXTURE_KANJI_SELECTION_VALUE)
      && kanjiChooser.options.some(({ value }) => value === FIXTURE_TERM_SELECTION_VALUE),
    JSON.stringify(kanjiChooser),
  );

  const staleChoiceResults = [];
  for (const staleTitle of ["legacy selection {not-json", "123"]) {
    await page.evaluate(async (title) => {
      const storedOptions = (await chrome.storage.local.get("options")).options;
      await chrome.runtime.sendMessage({
        target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: storedOptions?.revision ?? 0,
        options: { kanjiClickDictionary: title },
      });
    }, staleTitle);
    const pruned = await page.waitForFunction(async () =>
      document.getElementById("opt-kanji-dictionary")?.value === ""
        && (await chrome.storage.local.get("options")).options?.kanjiClickDictionary === "",
    { timeout: 10_000, polling: 100 }).then(() => true).catch(() => false);
    staleChoiceResults.push({ pruned, title: staleTitle });
  }
  check(
    "stale title-only kanji selections are pruned",
    staleChoiceResults.every(({ pruned }) => pruned),
    JSON.stringify(staleChoiceResults),
  );

  await page.evaluate(async () => {
    const storedOptions = (await chrome.storage.local.get("options")).options;
    await chrome.runtime.sendMessage({
      target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: storedOptions?.revision ?? 0,
      options: { kanjiClickDictionary: "hachidori-fixture" },
    });
  });
  const migratedLegacySelection = await page.waitForFunction(async (value) => {
    const selected = document.getElementById("opt-kanji-dictionary")?.value;
    const saved = (await chrome.storage.local.get("options")).options?.kanjiClickDictionary;
    return selected === value && saved?.title === "hachidori-fixture" && saved?.kind === "kanji";
  }, { timeout: 10_000, polling: 100 }, FIXTURE_KANJI_SELECTION_VALUE)
    .then(() => true)
    .catch(() => false);
  check(
    "a legacy title-only kanji selection migrates to and persists its native capability",
    migratedLegacySelection,
    `chooser and storage: ${JSON.stringify(await page.evaluate(async () => ({
      value: document.getElementById("opt-kanji-dictionary")?.value,
      saved: (await chrome.storage.local.get("options")).options?.kanjiClickDictionary,
    })))}`,
  );

  let savedKanjiDictionary = false;
  if (kanjiChooser.exists && kanjiChooser.options.some(({ value }) => value === GENERIC_KANJI_SELECTION_VALUE)) {
    await page.select("#opt-kanji-dictionary", GENERIC_KANJI_SELECTION_VALUE);
    savedKanjiDictionary = await page.waitForFunction(async (selection) => {
      const saved = (await chrome.storage.local.get("options")).options?.kanjiClickDictionary;
      return saved?.title === selection.title && saved?.kind === selection.kind;
    }, { timeout: 10_000, polling: 100 }, GENERIC_KANJI_SELECTION)
      .then(() => true)
      .catch(() => false);
  }
  check(
    "the selected kanji dictionary is saved",
    savedKanjiDictionary,
    `chooser: ${JSON.stringify(kanjiChooser)}`,
  );
  await page.evaluate(async () => {
    const storedOptions = (await chrome.storage.local.get("options")).options;
    await chrome.runtime.sendMessage({
      target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: storedOptions?.revision ?? 0,
      options: { maxResults: 1 },
    });
  });

  // ------------------------------------------------------- custom dictionary
  // The editor must not read the potentially large source until the reader asks
  // for it. Saving here also puts the production ZIP compiler through the real
  // offscreen WASM importer before either popup Note path builds on that source.
  const customEditorBeforeOpen = await page.evaluate(() => ({
    expanded: document.getElementById("custom-dictionary-open")?.getAttribute("aria-expanded"),
    formHidden: document.getElementById("custom-dictionary-form")?.hidden,
    source: document.getElementById("custom-dictionary-source")?.value ?? null,
    sourceHasMaximumLength: document.getElementById("custom-dictionary-source")?.hasAttribute("maxlength"),
  }));
  await page.click("#custom-dictionary-open");
  const customEditorLoaded = await page.waitForFunction(() => {
    const form = document.getElementById("custom-dictionary-form");
    const status = document.getElementById("custom-dictionary-status")?.textContent ?? "";
    return form?.hidden === false && status === "Loaded source revision 0.";
  }, { timeout: 30_000, polling: 100 }).then(() => true).catch(() => false);
  await page.$eval("#custom-dictionary-source", (textarea, source) => {
    textarea.value = source;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, CUSTOM_SETTINGS_SOURCE);
  await page.click("#custom-dictionary-save");
  const customSettingsResult = await page.waitForFunction(async ({ dictionaryId, dictionaryTitle, sourceKey, sourceText }) => {
    const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
    const source = stored[sourceKey];
    const dictionaries = stored.dictionaryState?.dictionaries ?? [];
    const dictionary = dictionaries.find((entry) => entry.id === dictionaryId);
    const row = document.querySelector(`[data-dictionary-id="${dictionaryId}"]`);
    const status = document.getElementById("custom-dictionary-status")?.textContent ?? "";
    if (
      source?.revision !== 1
      || source.text !== sourceText
      || dictionaries[0]?.id !== dictionaryId
      || dictionary?.title !== dictionaryTitle
      || dictionary.enabled !== true
      || dictionary.termCount !== 1
      || typeof dictionary.path !== "string"
      || !row
      || row.previousElementSibling !== null
      || !row.querySelector(".dict-enabled")?.checked
      || row.querySelector(".dict-enabled")?.disabled !== true
      || row.querySelector(".dict-drag")?.draggable !== false
      || row.querySelector(".dict-remove")?.hidden !== true
      || row.querySelector(".dict-remove")?.disabled !== true
      || !status.includes("rebuilt the custom dictionary")
    ) {
      return false;
    }
    const lookup = await chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_lookup_dictionary",
      requestId: "e2e-custom-settings-lookup",
      dictionary: dictionaryTitle,
      text: "\u6c17\u306b\u306a\u308b",
    });
    if (
      lookup?.ok !== true
      || lookup.results?.[0]?.term?.expression !== "\u6c17\u306b\u306a\u308b"
      || !JSON.stringify(lookup).includes("to catch one's attention")
    ) {
      return false;
    }
    return { dictionary, lookup, source, status };
  }, { timeout: 90_000, polling: 250 }, {
    dictionaryId: CUSTOM_DICTIONARY_ID,
    dictionaryTitle: CUSTOM_DICTIONARY_TITLE,
    sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
    sourceText: CUSTOM_SETTINGS_SOURCE,
  }).then((handle) => handle.jsonValue()).catch(() => null);
  const customSettingsGeneration = ownedGenerationRoot(
    customSettingsResult?.dictionary?.path,
    CUSTOM_DICTIONARY_TITLE,
  );
  const customSettingsPaths = await listOpfsPaths(page);
  check(
    "custom Settings lazily saves a source through the real WASM importer",
    customEditorBeforeOpen.expanded === "false"
      && customEditorBeforeOpen.formHidden === true
      && customEditorBeforeOpen.source === ""
      && customEditorBeforeOpen.sourceHasMaximumLength === false
      && customEditorLoaded
      && customSettingsResult !== null
      && customSettingsGeneration !== ""
      && generationExists(customSettingsPaths, customSettingsResult.dictionary.path),
    JSON.stringify({
      beforeOpen: customEditorBeforeOpen,
      editorLoaded: customEditorLoaded,
      result: customSettingsResult,
      generation: customSettingsGeneration,
      paths: customSettingsPaths,
    }),
  );

  // ------------------------------------------------------------------- hover
  const tab = await browser.newPage();
  tab.on("console", m => diagnostics.push(`[page] ${m.type()}: ${m.text()}`));
  tab.on("pageerror", e => diagnostics.push(`[page] pageerror: ${e.message}`));
  await tab.setViewport({ width: 1280, height: 900 });
  await tab.goto(pageUrl, { waitUntil: "load" });

  const popup = await popupReader(tab);

  const hover = (selector, options) => hoverForPopup(tab, popup, selector, options);

  // CSS.highlights is a per-document registry, so the extension's entry is
  // readable from the page's own world even though the content script that set
  // it runs in an isolated one. -1 means the API itself is missing, which would
  // make the assertions below meaningless rather than failed.
  const highlightSize = () => tab.evaluate(name => {
    if (typeof CSS === "undefined" || !CSS.highlights) return -1;
    const highlight = CSS.highlights.get(name);
    return highlight ? highlight.size : 0;
  }, HIGHLIGHT_NAME);

  const verb = await hover("#verb");
  check("hovering an inflected verb shows a popup", verb !== null,
    "no .gsm-hoshidicts-popup appeared within 12 hover attempts");
  const hostPresent = verb === null ? false : await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    // A closed root is invisible from here, which is the point: page script
    // cannot reach into the popup either.
    return !!host && host.isConnected && host.shadowRoot === null;
  });
  check("the content script attached its closed-shadow host to the page", hostPresent,
    "no connected <hachidori-host> with a closed shadow root");

  // Read through a default rather than under an `if`: a popup that never appeared
  // must fail these three as well, not quietly remove them from the total.
  const verbState = verb ?? { plain: "", text: "" };
  check("the popup deinflects 食べたかった to 食べる", verbState.plain.includes("食べる"),
    `popup text: ${verbState.text.slice(0, 400)}`);
  check("the popup renders the glossary", verbState.text.includes("to eat"),
    `popup text: ${verbState.text.slice(0, 400)}`);
  check("the popup renders the frequency tag from term_meta_bank",
    verbState.text.includes("142"), `popup text: ${verbState.text.slice(0, 400)}`);
  check(
    "the dictionary alias labels its popup tab without replacing the canonical key",
    Array.isArray(verbState.tabs)
      && verbState.tabs.includes(FIXTURE_ALIAS)
      && !verbState.tabs.includes("hachidori-fixture")
      && replacedPackage?.title === "hachidori-fixture",
    `popup tabs: ${JSON.stringify(verbState.tabs)}`,
  );

  const clickedKanji = await popup.click(".gsm-hoshidicts-kanji-link");
  let genericKanjiState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await popup.state();
    if (state?.text.includes(GENERIC_KANJI_GLOSSARY)) {
      genericKanjiState = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  check(
    "selected term dictionary wins even when maximum results is one",
    clickedKanji
      && genericKanjiState?.hasBack === true
      && genericKanjiState.text.includes(GENERIC_KANJI_TITLE)
      && !genericKanjiState.text.includes("food"),
    `popup state: ${JSON.stringify(await popup.state())}`,
  );
  const clickedNestedKanji = await popup.click(".gsm-hoshidicts-kanji-link");
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  const clickedNestedBack = await popup.click(".gsm-hoshidicts-kanji-back");
  const restoredIntermediateState = await popup.state();
  check(
    "Back preserves the complete clicked-kanji drill-down history",
    clickedNestedKanji
      && clickedNestedBack
      && restoredIntermediateState?.hasBack === true
      && restoredIntermediateState.text.includes(GENERIC_KANJI_GLOSSARY),
    `popup state: ${JSON.stringify(restoredIntermediateState)}`,
  );
  const clickedBack = await popup.click(".gsm-hoshidicts-kanji-back");
  const restoredTermState = await popup.state();
  check(
    "Back restores the term results after a generic kanji lookup",
    genericKanjiState !== null
      && clickedBack
      && restoredTermState?.text.includes("to eat")
      && !restoredTermState.text.includes(GENERIC_KANJI_GLOSSARY),
    `popup state: ${JSON.stringify(restoredTermState)}`,
  );
  check(
    "clicked-kanji navigation moves and restores keyboard focus",
    genericKanjiState?.focusedClass.includes("gsm-hoshidicts-kanji-back")
      && restoredTermState?.focusedClass.includes("gsm-hoshidicts-kanji-link"),
    JSON.stringify({ genericKanjiState, restoredTermState }),
  );

  await tab.keyboard.press("Escape");
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  const duplicateTermState = await hover("#duplicate");
  const clickedSecondDuplicate = await popup.click(".gsm-hoshidicts-kanji-link:nth-of-type(2)");
  let duplicateKanjiState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await popup.state();
    if (state?.text.includes(GENERIC_KANJI_GLOSSARY)) {
      duplicateKanjiState = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  const duplicateBack = await popup.click(".gsm-hoshidicts-kanji-back");
  const duplicateRestoredState = await popup.state();
  check(
    "Back restores focus to the exact clicked duplicate kanji",
    duplicateTermState?.text.includes("duplicate-kanji focus fixture")
      && clickedSecondDuplicate
      && duplicateKanjiState?.hasBack === true
      && duplicateBack
      && duplicateRestoredState?.focusedKanjiIndex === 1,
    JSON.stringify({ duplicateTermState, duplicateKanjiState, duplicateRestoredState }),
  );

  const genericDisabled = await setDictionaryEnabledInSettings(page, GENERIC_KANJI_TITLE, false);
  check(
    "the Settings enabled control disables one logical package",
    genericDisabled?.settled?.id === GENERIC_KANJI_ID,
    JSON.stringify(genericDisabled),
  );
  const refreshedAfterDisable = await hover("#duplicate");
  const clickedDisabledKanji = await popup.click(".gsm-hoshidicts-kanji-link");
  let disabledKanjiState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await popup.state();
    if (state?.text.includes("food")) {
      disabledKanjiState = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  check(
    "a disabled selected term dictionary falls back to native kanji",
    refreshedAfterDisable !== null
      && clickedDisabledKanji
      && disabledKanjiState?.hasBack === true
      && !disabledKanjiState.text.includes(GENERIC_KANJI_GLOSSARY),
    `popup state: ${JSON.stringify(await popup.state())}`,
  );
  await popup.click(".gsm-hoshidicts-kanji-back");

  await page.select("#opt-kanji-dictionary", FIXTURE_TERM_SELECTION_VALUE);
  await page.waitForFunction(async (selection) => {
    const saved = (await chrome.storage.local.get("options")).options?.kanjiClickDictionary;
    return saved?.title === selection.title && saved?.kind === selection.kind;
  }, { timeout: 10_000, polling: 100 }, FIXTURE_TERM_SELECTION);
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  const refreshedForCombinedTerm = await hover("#duplicate");
  const clickedCombinedTerm = await popup.click(".gsm-hoshidicts-kanji-link");
  let combinedTermState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await popup.state();
    if (state?.text.includes("unrelated term-dictionary definition")) {
      combinedTermState = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  check(
    "a combined archive can use its term entries for clicked kanji",
    refreshedForCombinedTerm !== null
      && clickedCombinedTerm
      && combinedTermState !== null
      && !combinedTermState.text.includes("Meaningsfoodeatmeal"),
    `popup state: ${JSON.stringify(await popup.state())}`,
  );
  await popup.click(".gsm-hoshidicts-kanji-back");

  await page.select("#opt-kanji-dictionary", FIXTURE_KANJI_SELECTION_VALUE);
  await page.waitForFunction(async (selection) => {
    const saved = (await chrome.storage.local.get("options")).options?.kanjiClickDictionary;
    return saved?.title === selection.title && saved?.kind === selection.kind;
  }, { timeout: 10_000, polling: 100 }, FIXTURE_KANJI_SELECTION);
  const clickedNativeKanji = await popup.click(".gsm-hoshidicts-kanji-link");
  let nativeKanjiState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await popup.state();
    if (state?.text.includes("food") && state.text.includes(FIXTURE_ALIAS)) {
      nativeKanjiState = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  check(
    "selecting a kanji-bank dictionary keeps the native kanji view",
    clickedNativeKanji
      && nativeKanjiState?.hasBack === true
      && !nativeKanjiState.text.includes(GENERIC_KANJI_GLOSSARY),
    `popup state: ${JSON.stringify(await popup.state())}`,
  );
  await popup.click(".gsm-hoshidicts-kanji-back");

  // The pointer is still on 食べたかった here, so the extension's own highlight
  // must be registered with at least one range. Asserting CSS.highlights exists
  // would only test Chrome; asserting the extension's name is in it tests the
  // extension.
  const hoveredHighlight = await highlightSize();
  check(`the hovered word is highlighted under CSS.highlights["${HIGHLIGHT_NAME}"]`,
    hoveredHighlight >= 1,
    hoveredHighlight === -1
      ? "CSS.highlights is missing entirely"
      : `CSS.highlights.get("${HIGHLIGHT_NAME}") covered ${hoveredHighlight} ranges`);

  // Both of these are conditioned on the popup having been up in the first
  // place: "it is hidden now" and "the registry is empty now" are true of an
  // extension that never showed anything at all.
  await tab.keyboard.press("Escape");
  const escapeHid = verb !== null && await popup.waitForHidden();
  check("Escape hides the popup", escapeHid,
    `popup shown first: ${verb !== null}, popup state: ${JSON.stringify(await popup.state())}`);
  const dismissedHighlight = await highlightSize();
  check("dismissing the popup clears the extension's highlight",
    hoveredHighlight >= 1 && dismissedHighlight === 0,
    `CSS.highlights.get("${HIGHLIGHT_NAME}") covered ${hoveredHighlight} ranges while hovered`
      + ` and ${dismissedHighlight} after Escape`);

  const sc = await hover("#kanjiword");
  check("hovering 漢字 shows a popup", sc !== null,
    "no .gsm-hoshidicts-popup appeared for 漢字");
  // Text alone cannot tell structured content from prose: a renderer that
  // flattened everything into one text node would satisfy every `includes`
  // below. So each of these names an element.
  const scState = sc ?? { bold: [], lists: [], tables: [], tags: [], text: "" };
  check("structured content renders a bold span element",
    scState.bold.includes("span:Chinese characters"),
    `bold elements: ${JSON.stringify(scState.bold)}\n       popup text: ${scState.text.slice(0, 300)}`);
  // One of the <ul>s belongs to the renderer (one li per sense); the structured
  // content's own list is the one whose two li carry the fixture's items, the
  // second of which is an <em> plus a text node.
  check("structured content renders a ul with its two li",
    scState.lists.filter(li => JSON.stringify(li) ===
      JSON.stringify(["li:kanji", "li:Han characters"])).length === 1,
    `ul contents: ${JSON.stringify(scState.lists)}`);
  check("structured content renders a table with the on and kun rows",
    JSON.stringify(scState.tables) ===
      JSON.stringify([[["th:on", "td:カン"], ["th:kun", "td:あざ"]]]),
    `tables: ${JSON.stringify(scState.tables)}`);

  // hd_media answers asynchronously, so the <img> can arrive a beat after the
  // glossary text it sits in.
  let withImage = scState;
  for (const _ of [0, 1, 2, 3, 4, 5, 6, 7]) {
    if ((withImage.images ?? []).some(src => src.startsWith("data:image/"))) break;
    await new Promise(r => setTimeout(r, 400));
    withImage = (await popup.state()) ?? withImage;
  }
  const src = (withImage.images ?? [])[0] ?? "";
  check("a structured-content image resolves through hd_media to a data: URL",
    src.startsWith("data:image/") && withImage.tags.includes("img"),
    `img src: ${src.slice(0, 80) || "(no img element found)"}`
      + `\n       img elements: ${withImage.tags.filter(tag => tag === "img").length}`);
  if (process.env.HACHIDORI_POPUP_SCREENSHOT) {
    await tab.bringToFront();
    await tab.screenshot({ path: process.env.HACHIDORI_POPUP_SCREENSHOT });
  }

  // "no popup for latin text" is worth nothing on its own: it passes against an
  // extension whose hover is completely dead. So it is sandwiched between a
  // popup that was on screen the moment before and one that comes back the
  // moment after, from the same hover routine.
  const beforeLatin = await popup.state();
  check("the popup is showing immediately before the non-Japanese hover",
    popup.visible(beforeLatin), `popup state: ${JSON.stringify(beforeLatin)}`);
  // Dismissed first because the popup for 漢字 is tall enough to sit under the
  // #latin paragraph, and a pointer inside the popup keeps it open by design.
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  const latin = await hover("#latin", { attempts: 3 });
  check("hovering non-Japanese text shows no popup",
    popup.visible(beforeLatin) && latin === null,
    `popup shown for 漢字 first: ${popup.visible(beforeLatin)}\n`
      + `       popup state after the latin hover: ${JSON.stringify(latin)}`);
  const control = await hover("#verb");
  check("the same hover shows a popup again after the non-Japanese one",
    control !== null && control.plain.includes("食べる"),
    `popup text: ${control ? control.plain.slice(0, 200) : "(no popup)"}`);

  // Opening the form deliberately suspends the hover-hide path. Escape belongs
  // to the form on its first press and to the popup on its second, even though
  // both live inside a closed shadow root.
  const draftNoteOpened = await popup.click(".gsm-hoshidicts-note-button");
  const draftPrefill = await popup.state();
  const draftValues = await popup.writeNote({ definition: "unsaved hover draft" });
  await tab.mouse.move(2, 2);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
  const preservedDraft = await popup.state();
  await tab.keyboard.press("Escape");
  let afterFirstNoteEscape = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    afterFirstNoteEscape = await popup.state();
    if (popup.visible(afterFirstNoteEscape) && afterFirstNoteEscape?.noteOpen === false) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  await tab.keyboard.press("Escape");
  const noteSecondEscapeHid = await popup.waitForHidden();
  check(
    "an open Note draft survives hover and consumes Escape before popup dismissal",
    draftNoteOpened
      && draftPrefill?.noteOpen === true
      && draftPrefill.noteTerm === "食べる"
      && draftPrefill.noteReading === "たべる"
      && draftPrefill.noteDefinition === ""
      && draftValues?.definition === "unsaved hover draft"
      && popup.visible(preservedDraft)
      && preservedDraft.noteOpen === true
      && preservedDraft.noteDefinition === "unsaved hover draft"
      && popup.visible(afterFirstNoteEscape)
      && afterFirstNoteEscape.noteOpen === false
      && noteSecondEscapeHid,
    JSON.stringify({
      opened: draftNoteOpened,
      prefill: draftPrefill,
      draftValues,
      preservedDraft,
      afterFirstEscape: afterFirstNoteEscape,
      secondEscapeHid: noteSecondEscapeHid,
    }),
  );

  const termNoteHover = await hover("#verb");
  const termNoteOpened = await popup.click(".gsm-hoshidicts-note-button");
  const termNotePrefill = await popup.state();
  const termNoteSubmitted = await popup.writeNote(
    { definition: CUSTOM_TERM_NOTE_DEFINITION },
    true,
  );
  const savedTermNote = await page.waitForFunction(async ({ dictionaryId, sourceKey, sourcePrefix, definition }) => {
    const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
    const source = stored[sourceKey];
    const dictionary = stored.dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
    return source?.revision === 2
      && source.text === `${sourcePrefix}食べる, たべる, ${definition}\n`
      && stored.dictionaryState?.dictionaries?.[0]?.id === dictionaryId
      && dictionary?.enabled === true
      && dictionary.termCount === 2
      && typeof dictionary.path === "string"
      ? { dictionary, source }
      : false;
  }, { timeout: 90_000, polling: 250 }, {
    dictionaryId: CUSTOM_DICTIONARY_ID,
    sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
    sourcePrefix: CUSTOM_SETTINGS_SOURCE,
    definition: CUSTOM_TERM_NOTE_DEFINITION,
  }).then((handle) => handle.jsonValue()).catch(() => null);
  const customGlobalTermLookup = await page.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen",
    type: "hd_lookup",
    requestId: "e2e-custom-global-term-lookup",
    text: "食べたかった",
    maxResults: 1,
    scanLength: 16,
    options: {
      frequencyDictionary: "",
      frequencyOrder: "auto",
      primaryReading: "",
    },
  }));
  let refreshedTermNote = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await popup.state();
    if (popup.visible(state)
        && state?.noteOpen === false
        && state.text.includes(CUSTOM_TERM_NOTE_DEFINITION)) {
      refreshedTermNote = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }

  const clickedCustomKanji = await popup.click(".gsm-hoshidicts-kanji-link");
  let customKanjiView = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await popup.state();
    if (state?.hasBack === true && state.text.includes("food")) {
      customKanjiView = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  const kanjiNoteOpened = await popup.click(".gsm-hoshidicts-note-button");
  const kanjiNotePrefill = await popup.state();
  const kanjiNoteSubmitted = await popup.writeNote({
    reading: "しょく",
    definition: CUSTOM_KANJI_NOTE_DEFINITION,
  }, true);
  const savedKanjiNote = await page.waitForFunction(async ({ dictionaryId, sourceKey, termDefinition, kanjiDefinition }) => {
    const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
    const source = stored[sourceKey];
    const dictionary = stored.dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
    return source?.revision === 3
      && source.text.includes(`食べる, たべる, ${termDefinition}\n`)
      && source.text.endsWith(`食, しょく, ${kanjiDefinition}\n`)
      && stored.dictionaryState?.dictionaries?.[0]?.id === dictionaryId
      && dictionary?.enabled === true
      && dictionary.termCount === 3
      && typeof dictionary.path === "string"
      ? { dictionary, source }
      : false;
  }, { timeout: 90_000, polling: 250 }, {
    dictionaryId: CUSTOM_DICTIONARY_ID,
    sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
    termDefinition: CUSTOM_TERM_NOTE_DEFINITION,
    kanjiDefinition: CUSTOM_KANJI_NOTE_DEFINITION,
  }).then((handle) => handle.jsonValue()).catch(() => null);
  let refreshedKanjiNote = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await popup.state();
    if (popup.visible(state)
        && state?.noteOpen === false
        && state.hasBack === true
        && state.text.includes("food")) {
      refreshedKanjiNote = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  const customKanjiBack = await popup.click(".gsm-hoshidicts-kanji-back");
  let restoredCustomTerm = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await popup.state();
    if (state?.hasBack === false && state.text.includes(CUSTOM_TERM_NOTE_DEFINITION)) {
      restoredCustomTerm = state;
      break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  const termNoteGeneration = ownedGenerationRoot(
    savedTermNote?.dictionary?.path,
    CUSTOM_DICTIONARY_TITLE,
  );
  const kanjiNoteGeneration = ownedGenerationRoot(
    savedKanjiNote?.dictionary?.path,
    CUSTOM_DICTIONARY_TITLE,
  );
  const customNotePaths = await listOpfsPaths(page);
  check(
    "term and kanji Note forms append and refresh the managed custom dictionary",
    termNoteHover !== null
      && termNoteOpened
      && termNotePrefill?.noteOpen === true
      && termNotePrefill.noteTerm === "食べる"
      && termNotePrefill.noteReading === "たべる"
      && termNotePrefill.noteDefinition === ""
      && termNoteSubmitted?.definition === CUSTOM_TERM_NOTE_DEFINITION
      && savedTermNote !== null
      && savedTermNote.dictionary.path !== customSettingsResult?.dictionary?.path
      && customGlobalTermLookup?.results?.[0]?.term?.glossaries?.[0]?.dictionary
        === CUSTOM_DICTIONARY_TITLE
      && JSON.stringify(customGlobalTermLookup).includes(CUSTOM_TERM_NOTE_DEFINITION)
      && refreshedTermNote !== null
      && clickedCustomKanji
      && customKanjiView !== null
      && kanjiNoteOpened
      && kanjiNotePrefill?.noteOpen === true
      && kanjiNotePrefill.noteTerm === "食"
      && kanjiNotePrefill.noteReading === ""
      && kanjiNotePrefill.noteDefinition === ""
      && kanjiNoteSubmitted?.reading === "しょく"
      && kanjiNoteSubmitted.definition === CUSTOM_KANJI_NOTE_DEFINITION
      && savedKanjiNote !== null
      && savedKanjiNote.dictionary.path !== savedTermNote?.dictionary?.path
      && refreshedKanjiNote !== null
      && customKanjiBack
      && restoredCustomTerm !== null
      && termNoteGeneration !== ""
      && kanjiNoteGeneration !== ""
      && generationIsAbsent(customNotePaths, customSettingsGeneration)
      && generationIsAbsent(customNotePaths, termNoteGeneration)
      && generationExists(customNotePaths, savedKanjiNote.dictionary.path),
    JSON.stringify({
      termNoteHover,
      termNoteOpened,
      termNotePrefill,
      termNoteSubmitted,
      savedTermNote,
      customGlobalTermLookup,
      refreshedTermNote,
      clickedCustomKanji,
      customKanjiView,
      kanjiNoteOpened,
      kanjiNotePrefill,
      kanjiNoteSubmitted,
      savedKanjiNote,
      refreshedKanjiNote,
      customKanjiBack,
      restoredCustomTerm,
      paths: customNotePaths,
    }),
  );

  const editorAdoptedNotes = await page.waitForFunction(({ termDefinition, kanjiDefinition }) => {
    const value = document.getElementById("custom-dictionary-source")?.value ?? "";
    return value.includes(termDefinition) && value.includes(kanjiDefinition);
  }, { timeout: 30_000, polling: 100 }, {
    termDefinition: CUSTOM_TERM_NOTE_DEFINITION,
    kanjiDefinition: CUSTOM_KANJI_NOTE_DEFINITION,
  }).then(() => true).catch(() => false);
  if (!editorAdoptedNotes) {
    throw new Error("Settings did not adopt the Note-appended custom source");
  }
  await page.bringToFront();
  if (process.env.HACHIDORI_CUSTOM_SCREENSHOT) {
    await page.setViewport({ width: 960, height: 900 });
    const customCard = await page.$('section[aria-labelledby="custom-dictionary-heading"]');
    await customCard.screenshot({ path: process.env.HACHIDORI_CUSTOM_SCREENSHOT });
  }

  // Later managed-update assertions intentionally begin with the same two
  // packages and native dictionary count they had before D8. Saving zero valid
  // rows performs the product cleanup path and must remove its final generation.
  await page.$eval("#custom-dictionary-source", (textarea) => {
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#custom-dictionary-save");
  const customRemoved = await page.waitForFunction(async ({ dictionaryId, sourceKey }) => {
    const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
    const status = document.getElementById("custom-dictionary-status")?.textContent ?? "";
    if (
      stored[sourceKey]?.revision !== 4
      || stored[sourceKey]?.text !== ""
      || stored.dictionaryState?.dictionaries?.some((entry) => entry.id === dictionaryId)
      || !status.includes("removed the custom dictionary")
    ) {
      return false;
    }
    const engineStatus = await chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_status",
      requestId: "e2e-custom-cleanup-status",
    });
    return engineStatus?.ok === true && engineStatus.dictionaryCount === 4;
  }, { timeout: 90_000, polling: 250 }, {
    dictionaryId: CUSTOM_DICTIONARY_ID,
    sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
  }).then(() => true).catch(() => false);
  const customGenerationRemoved = kanjiNoteGeneration !== ""
    && await waitForGenerationAbsent(page, kanjiNoteGeneration);
  if (!customRemoved || !customGenerationRemoved) {
    throw new Error(`custom cleanup failed: ${JSON.stringify({
      customRemoved,
      customGenerationRemoved,
      paths: await listOpfsPaths(page),
    })}`);
  }
  await tab.bringToFront();

  // ---------------------------------------------------------- managed updates
  // The generic-kanji package is already disabled at this point. Giving it a
  // complete generic source makes the manual check prove that enabled state is
  // irrelevant, while the combined fixture proves that every other managed
  // package was checked too. The engine owns this state change so its loaded set
  // and the worker-owned manifest cannot diverge.
  const managedFixture = await page.evaluate(async ({ dictionaryId, indexUrl, downloadUrl }) => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    return chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_apply_state",
      requestId: "e2e-manage-generic-source",
      baseRevision: current.revision,
      dictionaries: current.dictionaries.map((dictionary) => dictionary.id === dictionaryId
        ? {
            ...dictionary,
            isUpdatable: true,
            indexUrl,
            downloadUrl,
            lastUpdateCheck: null,
          }
        : dictionary),
    });
  }, {
    dictionaryId: GENERIC_KANJI_ID,
    indexUrl: GENERIC_MANAGED_INDEX_URL,
    downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
  });

  // Wake the worker immediately before attaching Fetch. A long renderer pass is
  // enough time for an MV3 worker to idle, so the target captured at launch is
  // not assumed to still be authoritative here.
  await page.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_state_read",
  }));
  const updateWorkerTarget = await browser.waitForTarget(
    (target) => target.type() === "service_worker"
      && target.url() === `chrome-extension://${extensionId}/background.js`,
    { timeout: 30_000 },
  );
  const updateOffscreenTarget = await browser.waitForTarget(
    (target) => target.url() === `chrome-extension://${extensionId}/offscreen.html`,
    { timeout: 30_000 },
  );

  const fixtureIndexRoute = { requests: 0 };
  const genericIndexRoute = { requests: 0 };
  const fixtureArchiveRoute = { requests: 0 };
  const genericArchiveRoute = { requests: 0 };
  setJsonResponse(fixtureIndexRoute, { revision: "test-1" });
  setJsonResponse(genericIndexRoute, { revision: "test-2" });
  setArchiveResponse(fixtureArchiveRoute, readFileSync(FIXTURE));
  setArchiveResponse(genericArchiveRoute, buildRecommendedZip({
    title: GENERIC_KANJI_TITLE,
    revision: "test-2",
    indexUrl: GENERIC_MANAGED_INDEX_URL,
    downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
    capabilities: ["term"],
  }));
  const indexRoutes = new Map([
    [MANAGED_INDEX_URL, fixtureIndexRoute],
    [GENERIC_MANAGED_INDEX_URL, genericIndexRoute],
  ]);
  const archiveRoutes = new Map([
    [MANAGED_DOWNLOAD_URL, fixtureArchiveRoute],
    [GENERIC_MANAGED_DOWNLOAD_URL, genericArchiveRoute],
  ]);

  // Indexes are fetched by background.js; archives are fetched below the
  // offscreen document, whose Fetch domain also covers its dedicated module
  // worker. Attaching to engine-worker.js itself is both unnecessary and racy.
  const updateIndexSession = await interceptFetches(
    updateWorkerTarget,
    indexRoutes,
    "managed index",
  );
  const updateArchiveSession = await interceptFetches(
    updateOffscreenTarget,
    archiveRoutes,
    "managed archive",
  );

  await page.evaluate(() => document.getElementById("update-check-now").click());
  const checkSummary = await page.waitForFunction(() => {
    const text = document.getElementById("update-state")?.textContent?.trim() ?? "";
    return text.startsWith("Checked 2 managed dictionaries") ? text : false;
  }, { timeout: 30_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => "(never settled)");
  const checkedStorage = await page.evaluate(() => chrome.storage.local.get([
    "dictionaryState",
    "dictionaryUpdates",
  ]));
  const checkedFixture = checkedStorage.dictionaryState?.dictionaries?.find(
    (dictionary) => dictionary.id === FIXTURE_ID,
  );
  const checkedGeneric = checkedStorage.dictionaryState?.dictionaries?.find(
    (dictionary) => dictionary.id === GENERIC_KANJI_ID,
  );
  check(
    "Check now checks every managed dictionary including disabled packages without downloading",
    managedFixture?.ok === true
      && checkSummary === "Checked 2 managed dictionaries — 1 update available, 0 failed."
      && checkedFixture?.lastUpdateCheck?.status === "up-to-date"
      && checkedFixture.lastUpdateCheck.remoteRevision === "test-1"
      && checkedGeneric?.enabled === false
      && checkedGeneric?.lastUpdateCheck?.status === "update-available"
      && checkedGeneric.lastUpdateCheck.remoteRevision === "test-2"
      && fixtureIndexRoute.requests === 1
      && genericIndexRoute.requests === 1
      && fixtureArchiveRoute.requests === 0
      && genericArchiveRoute.requests === 0
      && Number.isFinite(Date.parse(checkedStorage.dictionaryUpdates?.lastCheckedAt)),
    JSON.stringify({
      managedFixture,
      checkSummary,
      checkedStorage,
      requests: {
        fixtureIndex: fixtureIndexRoute.requests,
        genericIndex: genericIndexRoute.requests,
        fixtureArchive: fixtureArchiveRoute.requests,
        genericArchive: genericArchiveRoute.requests,
      },
    }),
  );

  // Reload rather than trusting the storage-event render that followed the
  // check. This proves the controls hydrate from persisted per-package and
  // global check state.
  await page.reload({ waitUntil: "domcontentloaded" });
  const persistedUpdateUi = await page.waitForFunction(async ({ fixtureId, genericId }) => {
    const rows = [...document.querySelectorAll("#dict-list .dict-row")];
    const byId = (id) => rows.find((row) => row.dataset.dictionaryId === id);
    const fixture = byId(fixtureId);
    const generic = byId(genericId);
    const stored = await chrome.storage.local.get("dictionaryUpdates");
    const lastCheckedAt = stored.dictionaryUpdates?.lastCheckedAt;
    const expectedLastChecked = Number.isFinite(Date.parse(lastCheckedAt))
      ? `Last checked ${new Date(lastCheckedAt).toLocaleString()}.`
      : "";
    const value = {
      expectedLastChecked,
      fixtureStatus: fixture?.querySelector(".dict-update-status")?.textContent ?? "",
      fixtureUpdateHidden: fixture?.querySelector(".dict-update")?.hidden,
      genericStatus: generic?.querySelector(".dict-update-status")?.textContent ?? "",
      genericUpdateHidden: generic?.querySelector(".dict-update")?.hidden,
      lastChecked: document.getElementById("update-last-checked")?.textContent ?? "",
      updateAllDisabled: document.getElementById("update-all")?.disabled,
    };
    return value.fixtureStatus === "Up to date"
      && value.genericStatus === "Update available: test-2"
      && value.lastChecked === expectedLastChecked
      ? value
      : false;
  }, { timeout: 30_000, polling: 100 }, {
    fixtureId: FIXTURE_ID,
    genericId: GENERIC_KANJI_ID,
  }).then((handle) => handle.jsonValue()).catch(() => null);
  check(
    "managed update controls render persisted availability and last-checked state",
    persistedUpdateUi?.expectedLastChecked.startsWith("Last checked ") === true
      && persistedUpdateUi.fixtureUpdateHidden === true
      && persistedUpdateUi.genericUpdateHidden === false
      && persistedUpdateUi.updateAllDisabled === false,
    JSON.stringify(persistedUpdateUi),
  );

  if (process.env.HACHIDORI_UPDATE_SCREENSHOT) {
    await page.bringToFront();
    await page.setViewport({ width: 960, height: 900 });
    const updateCard = await page.$('section[aria-labelledby="updates-heading"]');
    await updateCard.screenshot({ path: process.env.HACHIDORI_UPDATE_SCREENSHOT });
  }

  const beforeUpdateState = checkedStorage.dictionaryState;
  const beforeUpdatePackage = checkedGeneric;
  const beforeUpdateGeneration = ownedGenerationRoot(
    beforeUpdatePackage?.path,
    GENERIC_KANJI_TITLE,
  );
  await page.evaluate(() => document.getElementById("update-all").click());
  const manualUpdateSummary = await page.waitForFunction((dictionaryId) => {
    const text = document.getElementById("update-state")?.textContent?.trim() ?? "";
    return chrome.storage.local.get("dictionaryState").then(({ dictionaryState }) => {
      const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
      return dictionary?.revision === "test-2" && text.startsWith("Finished 1 dictionary update")
        ? text
        : false;
    });
  }, { timeout: 90_000, polling: 100 }, GENERIC_KANJI_ID)
    .then((handle) => handle.jsonValue())
    .catch(() => "(never settled)");
  const afterUpdateState = (await page.evaluate(() =>
    chrome.storage.local.get("dictionaryState"))).dictionaryState;
  const afterUpdatePackage = afterUpdateState?.dictionaries?.find(
    (dictionary) => dictionary.id === GENERIC_KANJI_ID,
  );
  const afterUpdateGeneration = ownedGenerationRoot(
    afterUpdatePackage?.path,
    GENERIC_KANJI_TITLE,
  );
  const opfsAfterUpdate = await listOpfsPaths(page);
  check(
    "Update all atomically replaces a managed generation and preserves presentation",
    manualUpdateSummary === "Finished 1 dictionary update — 1 updated, 0 failed."
      && genericArchiveRoute.requests === 1
      && afterUpdatePackage?.id === beforeUpdatePackage?.id
      && afterUpdatePackage?.path !== beforeUpdatePackage?.path
      && afterUpdatePackage?.revision === "test-2"
      && afterUpdatePackage?.displayName === beforeUpdatePackage?.displayName
      && afterUpdatePackage?.enabled === beforeUpdatePackage?.enabled
      && afterUpdatePackage?.favorite === beforeUpdatePackage?.favorite
      && afterUpdatePackage?.isUpdatable === beforeUpdatePackage?.isUpdatable
      && afterUpdatePackage?.indexUrl === beforeUpdatePackage?.indexUrl
      && afterUpdatePackage?.downloadUrl === beforeUpdatePackage?.downloadUrl
      && afterUpdatePackage?.lastUpdateCheck?.status === "up-to-date"
      && JSON.stringify(afterUpdateState.dictionaries.map((dictionary) => dictionary.id))
        === JSON.stringify(beforeUpdateState.dictionaries.map((dictionary) => dictionary.id))
      && JSON.stringify(afterUpdateState.groups) === JSON.stringify(beforeUpdateState.groups)
      && afterUpdateGeneration !== ""
      && generationExists(opfsAfterUpdate, afterUpdatePackage.path)
      && generationIsAbsent(opfsAfterUpdate, beforeUpdateGeneration),
    JSON.stringify({
      manualUpdateSummary,
      beforeUpdatePackage,
      afterUpdatePackage,
      groupsBefore: beforeUpdateState.groups,
      groupsAfter: afterUpdateState.groups,
      opfsAfterUpdate,
      archiveRequests: genericArchiveRoute.requests,
    }),
  );

  await page.select("#update-schedule", "hourly");
  const scheduledAlarm = await page.waitForFunction(async (alarmName) => {
    const { dictionaryUpdates } = await chrome.storage.local.get("dictionaryUpdates");
    const alarms = await chrome.alarms.getAll();
    const alarm = alarms.find((candidate) => candidate.name === alarmName);
    return dictionaryUpdates?.schedule === "hourly" && alarm?.periodInMinutes === 60
      ? { alarm, alarms, dictionaryUpdates }
      : false;
  }, { timeout: 30_000, polling: 100 }, MANAGED_UPDATE_ALARM)
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check(
    "one global update interval creates one periodic browser alarm",
    scheduledAlarm?.alarms?.length === 1
      && scheduledAlarm.alarm.name === MANAGED_UPDATE_ALARM
      && scheduledAlarm.alarm.periodInMinutes === 60,
    JSON.stringify(scheduledAlarm),
  );

  setJsonResponse(genericIndexRoute, { revision: "test-3" });
  setArchiveResponse(genericArchiveRoute, buildRecommendedZip({
    title: GENERIC_KANJI_TITLE,
    revision: "test-3",
    indexUrl: GENERIC_MANAGED_INDEX_URL,
    downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
    capabilities: ["term"],
  }));
  const archiveRequestsBeforeAlarm = genericArchiveRoute.requests;
  await page.evaluate(async (alarmName) => {
    await chrome.alarms.clear(alarmName);
    await chrome.alarms.create(alarmName, { when: Date.now() + 1000 });
  }, MANAGED_UPDATE_ALARM);
  const alarmUpdateResult = await page.waitForFunction(async ({ dictionaryId, previousCheckedAt }) => {
    const { dictionaryState, dictionaryUpdates } = await chrome.storage.local.get([
      "dictionaryState",
      "dictionaryUpdates",
    ]);
    const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
    return dictionary?.revision === "test-3"
      && dictionary.lastUpdateCheck?.status === "up-to-date"
      && Date.parse(dictionaryUpdates?.lastCheckedAt) > Date.parse(previousCheckedAt)
      ? { dictionaryState, dictionaryUpdates }
      : false;
  }, { timeout: 90_000, polling: 100 }, {
    dictionaryId: GENERIC_KANJI_ID,
    previousCheckedAt: scheduledAlarm?.dictionaryUpdates?.lastCheckedAt,
  })
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  const alarmUpdateState = alarmUpdateResult?.dictionaryState;
  const alarmUpdatedPackage = alarmUpdateState?.dictionaries?.find(
    (dictionary) => dictionary.id === GENERIC_KANJI_ID,
  );
  check(
    "a real browser alarm installs updates for disabled managed dictionaries",
    alarmUpdatedPackage?.revision === "test-3"
      && alarmUpdatedPackage?.enabled === false
      && alarmUpdatedPackage?.id === GENERIC_KANJI_ID
      && alarmUpdatedPackage?.displayName === afterUpdatePackage?.displayName
      && alarmUpdatedPackage?.favorite === afterUpdatePackage?.favorite
      && genericArchiveRoute.requests === archiveRequestsBeforeAlarm + 1
      && JSON.stringify(alarmUpdateState.groups) === JSON.stringify(afterUpdateState.groups),
    JSON.stringify({
      alarmUpdatedPackage,
      archiveRequestsBeforeAlarm,
      archiveRequestsAfterAlarm: genericArchiveRoute.requests,
      groups: alarmUpdateState?.groups,
    }),
  );

  const beforeFailedAlarmState = alarmUpdateState;
  const beforeFailedAlarmPackage = alarmUpdatedPackage;
  const beforeFailedAlarmPaths = await listOpfsPaths(page);
  setJsonResponse(genericIndexRoute, { revision: "test-4" });
  setArchiveResponse(genericArchiveRoute, buildRecommendedZip({
    title: GENERIC_KANJI_TITLE,
    revision: "wrong-test-4",
    indexUrl: GENERIC_MANAGED_INDEX_URL,
    downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
    capabilities: ["term"],
  }));
  await page.evaluate(async (alarmName) => {
    await chrome.alarms.clear(alarmName);
    await chrome.alarms.create(alarmName, { when: Date.now() + 1000 });
  }, MANAGED_UPDATE_ALARM);
  const failedAlarmResult = await page.waitForFunction(async ({ dictionaryId, previousCheckedAt }) => {
    const { dictionaryState, dictionaryUpdates } = await chrome.storage.local.get([
      "dictionaryState",
      "dictionaryUpdates",
    ]);
    const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
    return dictionary?.lastUpdateCheck?.remoteRevision === "test-4"
      && typeof dictionary.lastUpdateCheck?.error === "string"
      && Date.parse(dictionaryUpdates?.lastCheckedAt) > Date.parse(previousCheckedAt)
      ? { dictionaryState, dictionaryUpdates }
      : false;
  }, { timeout: 90_000, polling: 100 }, {
    dictionaryId: GENERIC_KANJI_ID,
    previousCheckedAt: alarmUpdateResult?.dictionaryUpdates?.lastCheckedAt,
  })
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  const failedAlarmState = failedAlarmResult?.dictionaryState;
  const failedAlarmPackage = failedAlarmState?.dictionaries?.find(
    (dictionary) => dictionary.id === GENERIC_KANJI_ID,
  );
  const afterFailedAlarmPaths = await listOpfsPaths(page);
  const statusAfterFailedAlarm = await page.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen",
    type: "hd_status",
    requestId: "e2e-failed-update-status",
  }));
  check(
    "a failed scheduled update preserves the working generation without OPFS debris",
    failedAlarmPackage?.revision === beforeFailedAlarmPackage?.revision
      && failedAlarmPackage?.path === beforeFailedAlarmPackage?.path
      && failedAlarmPackage?.lastUpdateCheck?.status === "update-available"
      && failedAlarmPackage?.lastUpdateCheck?.remoteRevision === "test-4"
      && failedAlarmPackage?.lastUpdateCheck?.error?.includes("revision")
      && JSON.stringify(failedAlarmState?.groups) === JSON.stringify(beforeFailedAlarmState?.groups)
      && JSON.stringify(afterFailedAlarmPaths) === JSON.stringify(beforeFailedAlarmPaths)
      && !afterFailedAlarmPaths.includes(".hdw-archive.zip")
      && failedAlarmPackage !== undefined
      && generationExists(afterFailedAlarmPaths, failedAlarmPackage.path)
      && statusAfterFailedAlarm?.ok === true
      && statusAfterFailedAlarm?.ready === true
      && statusAfterFailedAlarm?.dictionaryCount === 4,
    JSON.stringify({
      beforeFailedAlarmPackage,
      failedAlarmPackage,
      beforeFailedAlarmPaths,
      afterFailedAlarmPaths,
      statusAfterFailedAlarm,
    }),
  );

  const alarmGone = await page.waitForFunction(async (alarmName) =>
    (await chrome.alarms.get(alarmName)) === undefined,
  { timeout: 30_000, polling: 100 }, MANAGED_UPDATE_ALARM)
    .then(() => true)
    .catch(() => false);
  await Promise.all([
    updateIndexSession.send("Fetch.disable"),
    updateArchiveSession.send("Fetch.disable"),
  ]);
  await Promise.all([
    updateIndexSession.detach(),
    updateArchiveSession.detach(),
  ]);
  const updateWorkerDiagnostics = watchedServiceWorkers.get(updateWorkerTarget);
  if (updateWorkerDiagnostics) {
    await updateWorkerDiagnostics.client.detach();
    watchedServiceWorkers.delete(updateWorkerTarget);
  }
  const browserCdp = await browser.target().createCDPSession();
  const targetInfos = await browserCdp.send("Target.getTargets");
  const workerTargetInfo = targetInfos.targetInfos.find((target) =>
    target.type === "service_worker"
      && target.url === `chrome-extension://${extensionId}/background.js`);
  const serviceWorkerCdp = await page.createCDPSession();
  const workerScriptUrl = `chrome-extension://${extensionId}/background.js`;
  const runningWorkerPromise = waitForRunningServiceWorker(serviceWorkerCdp, workerScriptUrl);
  await serviceWorkerCdp.send("ServiceWorker.enable");
  const runningWorker = await runningWorkerPromise;
  const stopWorkerReply = runningWorker === null
    ? { error: "the running managed-update service worker version was not found" }
    : await serviceWorkerCdp.send("ServiceWorker.stopWorker", {
        versionId: runningWorker.versionId,
      });
  const stoppedWorker = runningWorker?.targetId !== undefined
    && await waitForCdpTargetGone(browserCdp, runningWorker.targetId);
  const restartedWorkerPromise = waitForCdpTarget(browserCdp, (target) =>
    target.type === "service_worker"
      && target.url === `chrome-extension://${extensionId}/background.js`
      && target.targetId !== runningWorker?.targetId);
  const restartedPage = await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 })
    .then(() => true)
    .catch((error) => ({ error: String(error) }));
  const restartedWorker = await restartedWorkerPromise;
  const restartWakeReply = await page.evaluate(() => Promise.race([
    chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_read",
    }),
    new Promise((resolveWake) => setTimeout(() => resolve({ timeout: true }), 10_000)),
  ])).catch((error) => ({ error: String(error) }));
  const recreatedAlarm = await page.waitForFunction(async (alarmName) => {
    const alarms = await chrome.alarms.getAll();
    const alarm = alarms.find((candidate) => candidate.name === alarmName);
    return alarm?.periodInMinutes === 60 ? { alarm, alarms } : false;
  }, { timeout: 30_000, polling: 100 }, MANAGED_UPDATE_ALARM)
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  await serviceWorkerCdp.send("ServiceWorker.disable");
  await serviceWorkerCdp.detach();
  await browserCdp.detach();
  check(
    "worker restart recreates the configured managed-update alarm",
    alarmGone
      && workerTargetInfo !== undefined
      && stoppedWorker === true
      && restartedPage === true
      && restartWakeReply?.ok === true
      && restartedWorker?.url === `chrome-extension://${extensionId}/background.js`
      && recreatedAlarm?.alarms?.length === 1
      && recreatedAlarm.alarm.name === MANAGED_UPDATE_ALARM
      && recreatedAlarm.alarm.periodInMinutes === 60,
    JSON.stringify({
      alarmGone,
      workerTargetInfo,
      runningWorker,
      stopWorkerReply,
      stoppedWorker,
      restartedPage,
      restartWakeReply,
      restartedWorker,
      recreatedAlarm,
    }),
  );

  const optionsBeforeRestart = await page.evaluate(async () =>
    (await chrome.storage.local.get("options")).options);
  const chromeProcess = browser.process();
  const chromeKilled = new Promise((resolveKilled) => chromeProcess.once("close", resolveKilled));
  chromeProcess.kill("SIGKILL");
  await chromeKilled;

  // ---------------------------------------------------------------- pass 2
  // Same profile after an abrupt browser exit: the dictionary must come back out of OPFS
  // without another import. This is the assertion that node cannot make at all.
  browser = await launch.launch(launchArgs);
  watch(browser);
  try {
    await browser.waitForTarget(
      t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
      { timeout: 30_000 });
  } catch { /* asserted below via the settings page */ }

  page = await browser.newPage();
  page.on("console", m => diagnostics.push(`[settings2] ${m.type()}: ${m.text()}`));
  await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });

  const restoredOptions = await page.waitForFunction(async (expected) => {
    const { options } = await chrome.storage.local.get("options");
    return JSON.stringify(options) === JSON.stringify(expected)
      && document.getElementById("opt-max-results").value === String(expected.maxResults)
      ? options : false;
  }, { timeout: 30_000, polling: 100 }, optionsBeforeRestart).then((handle) => handle.jsonValue()).catch(() => null);
  check("reader settings and their revision survive a full browser restart",
    restoredOptions?.revision === optionsBeforeRestart.revision && restoredOptions !== null,
    JSON.stringify({ optionsBeforeRestart, restoredOptions }));

  const persistedPackage = await page.waitForFunction(async (id, expectedPath) => {
    const t = (document.getElementById("dict-list")?.textContent || "");
    const { dictionaryState: state } = await chrome.storage.local.get("dictionaryState");
    const dictionary = state?.dictionaries?.find(candidate =>
      candidate.id === id && candidate.title === "hachidori-fixture");
    return t.includes("hachidori-fixture") && dictionary?.path === expectedPath
      ? dictionary
      : false;
  }, { timeout: 90_000, polling: 500 }, fixtureId, replacedPackage.path)
    .then(handle => handle.jsonValue())
    .catch(() => null);
  check("the settings page lists the dictionary again after a restart",
    persistedPackage?.path === replacedPackage.path
      && ownedGenerationRoot(persistedPackage.path, "hachidori-fixture") === replacedFixtureGeneration,
    `expected path: ${JSON.stringify(replacedPackage.path)}; persisted package: ${JSON.stringify(persistedPackage)}`);
  const restartedSettingsUi = await page.evaluate(() => ({
    localInputVisible: document.getElementById("import-file")?.closest(".file-button")?.hidden !== true,
    starterHidden: document.getElementById("recommended-starter")?.hidden,
  }));
  check(
    "the starter card stays hidden after a browser restart",
    restartedSettingsUi.starterHidden === true && restartedSettingsUi.localInputVisible === true,
    JSON.stringify(restartedSettingsUi),
  );

  // #dict-list above reflects worker-owned chrome.storage.local state, which
  // persists regardless of OPFS; only a dictionaryCount from the fresh engine
  // proves that the imported files came back.
  const reloadCount = await page.evaluate(async () => {
    const deadline = Date.now() + 90_000;
    let reply;
    for (;;) {
      reply = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_status", requestId: "e2e-1",
      });
      if (reply && reply.ok && reply.ready && !reply.loading) return reply;
      if (Date.now() >= deadline) return reply;
      await new Promise(r => setTimeout(r, 500));
    }
  }).catch(e => ({ error: String(e) }));
  const opfsAfterRestart = await listOpfsPaths(page);
  // The disabled generic package stays disabled across restart; the combined
  // fixture still restores all four of its native capabilities.
  check("the dictionary survives a browser restart via OPFS",
    reloadCount?.dictionaryCount === 4
      && generationExists(opfsAfterRestart, replacedPackage.path)
      && generationIsAbsent(opfsAfterRestart, firstFixtureGeneration),
    `hd_status reply: ${JSON.stringify(reloadCount)}; latest path: ${JSON.stringify(replacedPackage.path)};`
      + ` OPFS paths: ${JSON.stringify(opfsAfterRestart)}`);

  const tab2 = await browser.newPage();
  tab2.on("pageerror", e => diagnostics.push(`[page2] pageerror: ${e.message}`));
  await tab2.setViewport({ width: 1280, height: 900 });
  await tab2.goto(pageUrl, { waitUntil: "load" });
  const popup2 = await popupReader(tab2);
  const afterRestart = (await hoverForPopup(tab2, popup2, "#verb"))?.plain ?? null;
  check("lookups work after a restart with no re-import",
    !!afterRestart && afterRestart.includes("食べる"),
    `popup text: ${afterRestart ? afterRestart.slice(0, 300) : "(no popup)"}`);

  await page.evaluate((title) => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen",
    type: "hd_remove",
    requestId: "e2e-remove-generic-kanji",
    title,
  }), GENERIC_KANJI_TITLE);
  const removeReply = await page.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen",
    type: "hd_remove",
    requestId: "e2e-remove",
    title: "hachidori-fixture",
  })).catch(error => ({ error: String(error) }));
  const removed = await page.waitForFunction(async () => {
    const stored = await chrome.storage.local.get("dictionaryState");
    const status = await chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_status", requestId: "e2e-remove-status",
    });
    return (stored.dictionaryState?.dictionaries ?? []).length === 0
      && status?.ok
      && status.dictionaryCount === 0;
  }, { timeout: 90_000, polling: 250 }).then(() => true).catch(() => false);
  check("removing the dictionary clears its settings rows", removeReply?.ok === true && removed,
    `remove reply: ${JSON.stringify(removeReply)}`);

  const opfsAfterRemoval = await listOpfsPaths(page);
  const opfsRemoved = generationIsAbsent(opfsAfterRemoval, replacedFixtureGeneration);
  check("removing the dictionary deletes its OPFS directory", opfsRemoved,
    `${replacedFixtureGeneration} still exists in OPFS: ${JSON.stringify(opfsAfterRemoval)}`);

  const removedLookup = await page.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen",
    type: "hd_lookup",
    requestId: "e2e-removed",
    text: "食べる",
  })).catch(error => ({ error: String(error) }));
  check("lookups miss after the dictionary is removed",
    removedLookup?.ok === true && removedLookup?.dictionaryCount === 0
      && Array.isArray(removedLookup?.results) && removedLookup.results.length === 0,
    `lookup reply: ${JSON.stringify(removedLookup)}`);

  await browser.close();
  server.close();
  return report();
}

function report() {
  // An assertion that did not run is a failed assertion. Anything else lets a
  // regression shrink the denominator, and "25/25 checks passed" printed by a
  // run that abandoned half of them is worse than a plain failure.
  for (const name of PLANNED) {
    if (!results.some(r => r.name === name)) {
      results.push({ name, ok: false, detail: "check never ran" });
      failed++;
      console.log(`FAIL ${name}\n       check never ran`);
    }
  }
  console.log(`\n${results.length - failed}/${PLANNED.length} checks passed`);
  if (failed) {
    console.log(`profile kept for inspection: ${PROFILE}`);
    console.log("\nfailures:");
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  - ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
    }
    if (diagnostics.length) {
      console.log("\nbrowser diagnostics (last 60):");
      for (const d of diagnostics.slice(-60)) console.log(`  ${d}`);
    }
  } else if (!process.env.HACHIDORI_PROFILE) {
    rmSync(PROFILE, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

// Through report(), not fatal(): a throw is one more way for an assertion not to
// run, so it has to be counted like one -- and the browser diagnostics are worth
// more here than anywhere else. The synthetic failure is what keeps the exit code
// non-zero when the throw came after the last check.
main().catch(e => {
  results.push({ name: "the run finished without throwing", ok: false, detail: e?.stack || String(e) });
  failed++;
  console.log(`FAIL the run finished without throwing\n       ${e?.stack || e}`);
  report();
});
