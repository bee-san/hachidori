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

import { GENERIC_KANJI_GLOSSARY, GENERIC_KANJI_TITLE } from "./make-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EXTENSION = resolve(REPO, "extension");
const FIXTURE = resolve(HERE, "fixtures/hachidori-fixture.zip");
const GENERIC_KANJI_FIXTURE = resolve(HERE, "fixtures/hachidori-generic-kanji-fixture.zip");
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
const LAST_UPDATE_CHECK = "2026-09-04T09:30:00.000Z";
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

const RECOMMENDED_DICTIONARIES = [
  ["Jitendex", "https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip"],
  ["JMdict (English)", "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMdict_english.zip"],
  ["Bee's Ultimate Kanji Dictionary", "https://github.com/bee-san/bees-ultimate-kanji-dictionary/releases/latest/download/bees-ultimate-kanji-dictionary.zip"],
  ["Jiten Frequency", "https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan"],
];

// Every assertion this run makes, named up front. The denominator is this list,
// not the number of checks that happened to execute: a suite that skips an
// assertion under a regression prints "23/24 passed" and reads like success.
const PLANNED = [
  "extension loads and its service worker starts",
  "offscreen document compiles the wasm under the extension CSP",
  "extension pages expose pthread prerequisites",
  "chrome.offscreen.createDocument produced exactly one offscreen document",
  "manifest and settings page are branded as Hachidori",
  "settings page renders exactly four safe recommended dictionary links",
  "recommended dictionaries form two columns on desktop",
  "recommended dictionaries stack without overflow on narrow screens",
  "settings page exposes a .zip file input",
  "the .zip file input is type=file and accepts .zip",
  "importing a Yomitan .zip from the settings page succeeds",
  "the imported dictionary is persisted in OPFS",
  "the imported dictionary is recorded in chrome.storage.local",
  "re-importing the same dictionary replaces it safely in OPFS",
  "the dictionary list renders its alias, metadata, and five capability badges",
  "the Settings enabled control re-enables the preserved package",
  "importing a term-only single-kanji dictionary succeeds",
  "dictionary management filters and bulk-updates visible stable selections",
  "drag and keyboard position controls share the persisted lookup order",
  "the kanji dictionary chooser lists imported term and kanji dictionaries",
  "a combined archive exposes separate term and native kanji choices",
  "stale title-only kanji selections are pruned",
  "a legacy title-only kanji selection migrates to and persists its native capability",
  "the selected kanji dictionary is saved",
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
  "the settings page lists the dictionary again after a restart",
  "the dictionary survives a browser restart via OPFS",
  "lookups work after a restart with no re-import",
  "removing the dictionary clears its settings rows",
  "removing the dictionary deletes its OPFS directory",
  "lookups miss after the dictionary is removed",
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

  async function state() {
    // nodeIds live only until the next getDocument, so each read re-walks.
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
    if (nodeId === null) return false;
    const { object } = await cdp.send("DOM.resolveNode", { nodeId });
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

  return { click, state, visible, waitForVisible, waitForHidden };
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

  function watch(browser) {
    browser.on("targetcreated", async target => {
      watchOffscreen(target);
      try {
        const worker = await target.worker?.();
        worker?.on?.("console", m => diagnostics.push(`[sw] ${m.text()}`));
      } catch { /* not a worker target */ }
    });
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
      && branding.heading === "Hachidori"
      && ["16", "32", "48", "128"].every(
        size => branding.icons[size] === `icons/hachidori-${size}.png`,
      ),
    JSON.stringify(branding),
  );

  await page.setViewport({ width: 960, height: 900 });
  const desktopRecommendations = await page.evaluate(expected => {
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
      expected,
    };
  }, RECOMMENDED_DICTIONARIES);
  const desktopLinks = desktopRecommendations.links.map(([name, url]) => [name, url]);
  check(
    "settings page renders exactly four safe recommended dictionary links",
    JSON.stringify(desktopLinks) === JSON.stringify(RECOMMENDED_DICTIONARIES)
      && desktopRecommendations.links.every(([, , target, rel]) =>
        target === "_blank" && rel.split(/\s+/u).includes("noopener") && rel.split(/\s+/u).includes("noreferrer")),
    JSON.stringify(desktopRecommendations.links),
  );
  const desktopRects = desktopRecommendations.rects;
  check(
    "recommended dictionaries form two columns on desktop",
    desktopRecommendations.columns === 2
      && desktopRects.length === RECOMMENDED_DICTIONARIES.length
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
      && narrowRecommendations.rects.length === RECOMMENDED_DICTIONARIES.length
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
    return { tag: el.tagName.toLowerCase(), type: el.type, accept: el.getAttribute("accept") || "" };
  });
  check("the .zip file input is type=file and accepts .zip",
    inputShape.tag === "input" && inputShape.type === "file"
      && inputShape.accept.split(",").map(s => s.trim()).includes(".zip"),
    `#import-file: ${JSON.stringify(inputShape)}`);
  await input.uploadFile(FIXTURE);

  const importState = await page.waitForFunction(() => {
    const t = (document.getElementById("import-state")?.textContent || "").trim();
    // "Importing x — 3s elapsed" is the in-progress line; anything else is the
    // outcome. An alternative matching the empty string would match every line
    // and this wait would never settle.
    return t === "" || t === "…" || /^(importing|working)/i.test(t) ? false : t;
  }, { timeout: 120_000, polling: 500 }).then(h => h.jsonValue()).catch(() => "(never settled)");
  const importDetail = await page.evaluate(() =>
    (document.getElementById("import-detail")?.textContent || "").trim());
  // The success line settings.js writes, rather than the absence of the words
  // fail and error: a wait that timed out must not read as a pass.
  const importOk = /^Imported /.test(importState);
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

  await page.evaluate(() => {
    document.getElementById("import-file").value = "";
    document.getElementById("import-state").textContent = "";
  });
  const replacementInput = await page.$("#import-file");
  await replacementInput.uploadFile(FIXTURE);
  const replacementState = await page.waitForFunction(() => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text === "" || text === "…" || /^(importing|working)/i.test(text) ? false : text;
  }, { timeout: 120_000, polling: 250 }).then(handle => handle.jsonValue()).catch(() => "(never settled)");
  const replacedState = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
  const replacedPackage = replacedState?.dictionaryState?.dictionaries?.[0];
  const replacedFixtureGeneration = ownedGenerationRoot(
    replacedPackage?.path,
    "hachidori-fixture",
  );
  const opfsAfterReimport = await listOpfsPaths(page);
  check("re-importing the same dictionary replaces it safely in OPFS",
    aliasChanged?.settled?.id === FIXTURE_ID
      && stateBeforeReimport?.ok === true
      && /^Imported /.test(replacementState)
      && replacedState?.dictionaryState?.dictionaries?.length === 1
      && replacedState.dictionaryState.revision > dictionaryState.revision
      && replacedPackage?.id === FIXTURE_ID
      && replacedFixtureGeneration !== ""
      && replacedPackage.path !== fixturePackage.path
      && generationExists(opfsAfterReimport, replacedPackage.path)
      && generationIsAbsent(opfsAfterReimport, firstFixtureGeneration)
      && replacedPackage?.displayName === FIXTURE_ALIAS
      && replacedPackage?.enabled === false
      && replacedPackage?.favorite === true
      && replacedPackage?.isUpdatable === true
      && replacedPackage?.indexUrl === MANAGED_INDEX_URL
      && replacedPackage?.downloadUrl === MANAGED_DOWNLOAD_URL
      && replacedPackage?.lastUpdateCheck === LAST_UPDATE_CHECK,
    `alias change: ${JSON.stringify(aliasChanged)}; state before reimport: ${JSON.stringify(stateBeforeReimport)}; #import-state: ${replacementState};`
      + ` dictionaryState: ${JSON.stringify(replacedState?.dictionaryState)}; OPFS paths: ${JSON.stringify(opfsAfterReimport)}`);

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
    renderedDictionary.count === 1
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

  const fixtureEnabled = await setDictionaryEnabledInSettings(page, "hachidori-fixture", true);
  check(
    "the Settings enabled control re-enables the preserved package",
    fixtureEnabled?.settled?.id === FIXTURE_ID,
    JSON.stringify(fixtureEnabled),
  );

  await input.uploadFile(GENERIC_KANJI_FIXTURE);
  const genericImportState = await page.waitForFunction((title) => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith("Imported ") && text.includes(title) ? text : false;
  }, { timeout: 120_000, polling: 500 }, GENERIC_KANJI_TITLE)
    .then(handle => handle.jsonValue())
    .catch(() => "(never settled)");
  const afterGenericImport = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
  const genericPackage = afterGenericImport?.dictionaryState?.dictionaries?.find(
    (dictionary) => dictionary.title === GENERIC_KANJI_TITLE,
  );
  check(
    "importing a term-only single-kanji dictionary succeeds",
    genericImportState.includes(GENERIC_KANJI_TITLE)
      && genericPackage?.id === GENERIC_KANJI_ID
      && genericPackage.id !== fixtureId,
    `#import-state: ${genericImportState}; dictionaryState: ${JSON.stringify(afterGenericImport?.dictionaryState)}`,
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
      await chrome.storage.local.set({
        options: { ...storedOptions, kanjiClickDictionary: title },
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
    await chrome.storage.local.set({
      options: { ...storedOptions, kanjiClickDictionary: "hachidori-fixture" },
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
    await chrome.storage.local.set({
      options: { ...storedOptions, maxResults: 1 },
    });
  });

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
