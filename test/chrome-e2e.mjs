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
import { createHash } from "node:crypto";
import { existsSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import {
  GENERIC_KANJI_GLOSSARY,
  GENERIC_KANJI_TITLE,
  buildRecommendedZip,
  buildTitledZip,
  compactSummaryFixture,
  dictionaryTabsFixture,
  externalLinksFixture,
  frequencyRankingFixture,
  imagePreviewFixture,
  imageSizingFixture,
  makePng,
  nestedLinksFixture,
} from "./make-fixture.mjs";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_TITLE,
} from "../extension/custom-dictionary.js";
import { RECOMMENDED_DICTIONARIES as RECOMMENDED_CATALOGUE } from "../extension/recommended-dictionaries.js";
import { BACKUP_CHROME_CHECKS, backupChromeScenarios } from "./chrome-backup-scenarios.mjs";

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
// The reader as the manifest injects it into a page, minus `reader-options.js`,
// which the startup page's own module already provides. Read from the manifest
// so a reordered or extended reader cannot pass against a stale copy.
const READER_SCRIPTS = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"))
  .content_scripts[0].js.filter((src) => src !== "reader-options.js");

const PLANNED = [
  ...BACKUP_CHROME_CHECKS,
  "extension loads and its service worker starts",
  "offscreen document compiles the wasm under the extension CSP",
  "extension pages expose pthread prerequisites",
  "chrome.offscreen.createDocument produced exactly one offscreen document",
  "manifest and settings page are branded as Hachidori",
  "a fresh install opens one startup tab at the dictionary stage with first-install preferences",
  "Settings shows Resume setup while first-run setup is incomplete",
  "a reconnecting startup page rejoins the running installer whose held download stays indeterminate",
  "the automatic installer continues after a mocked failure through real download and installation phases",
  "Retry installs only the missing dictionary and the committed entries settle their selections once",
  "the all-installed result stays five seconds before setup checks for Anki",
  "startup practice uses the installed dictionaries through keyboard selection and the ordinary reader",
  "the startup reader exception keeps Settings and the static preview excluded",
  "saved-page setup rechecks Chrome file access and a local HTML file uses the real reader",
  "startup practice without a usable dictionary retains recovery and completion controls",
  "the practice step looks a word up on the startup page through the real reader and the installed dictionaries",
  "the reader refuses to run on Settings even when its own scripts are loaded there",
  "an absent Anki settles by itself and the startup page finishes setup, closes its tab and hides Resume setup",
  "first-run detection configures an existing Kiku mining setup read-only from the startup page",
  "a browser restart keeps completed setup closed and the edited first-install preference",
  "Settings puts the library first and supports keyboard navigation at 320px",
  "Settings light and dark themes keep every task view readable without horizontal overflow",
  "Settings autosaves one revisioned patch and surfaces cross-page conflicts without losing drafts",
  "Settings rejects malformed and oversized option frames before commit and still autosaves without reload",
  "Design lazily renders local sample terms, kanji and images through the production popup",
  "Design live edits preserve popup cards and Notes while sample appends cannot mutate dictionaries",
  "Design fits the popup without changing its actual dimensions and keeps narrow Settings scrollable",
  "Design exposes 42 grouped themes and applies real palette overrides without rebuilding the preview",
  "Design previews opacity and dimensions immediately and resets only Design settings",
  "live appearance changes preserve reader Notes and resources while applying the selected page highlight",
  "toolbar preferences persist and move the preview without detaching focused Notes or rebuilding cards",
  "live toolbar overrides apply to root and child and survive resize without focus or resource loss",
  "custom CSS editor previews unsaved text, persists its count and resets only its stylesheet",
  "custom CSS overrides built-in and late dictionary styles only inside the popup shadow tree and tolerates invalid CSS",
  "live custom CSS updates root and child without losing Notes, Back or making engine requests",
  "Audio Settings preserve ordered source edits and disabled rows through revisioned save and reload",
  "Audio source Tests use encoded URLs and ordered JSON candidates with visible success, no-result and error feedback",
  "Audio Tests cancel stale playback and preserve the dictionary engine after audio becomes idle",
  "Anki discovery is lazy and refresh recovers an offline connection through the real service worker",
  "Anki Settings reject stale model replies and preserve unavailable mappings without discovery writes",
  "Anki configuration persists through reload without reloading the dictionary engine",
  "Anki presets expose editable field templates and persist overwrite modes with visible marker errors",
  "Anki templates survive refresh and reload while disabled values stay disabled and lookup generation stays unchanged",
  "Anki glossary export preserves native scoped styles and image proportions without loading media or allowing CSS markup escape",
  "Anki worker preflight is read-only and submission verifies a real-WASM result with scoped dictionary media",
  "Anki first-field audio is checked without uploads or playback and the exact chosen recording survives submission",
  "Anki reader controls stay absent until configured and preserve raw ruby context through one confirmed Add and View",
  "Popup audio is silent by default and manually falls back through enabled sources and playable candidates",
  "Popup pronunciation choices preserve source identity and warm replay reuses native cached media",
  "Popup autoplay is optional and does not replay after presentation updates or Back",
  "Popup audio cancels obsolete discovery and playback on dismissal, source changes and navigation",
  "accepted reader lookups persist canonical counts without delaying definitions",
  "live lookup-count Settings pause recording and preserve the displayed reader view",
  "optional GSM Seen counts use the configured loopback corpus and fail open",
  "definition blur follows real lookup counts and settings and holds autoplay for blurred results",
  "blurred definitions reveal on hover, at the timed deadline and at once when blur is disabled",
  "Anki maturity blur is opt-in and persists independently of lookup counts",
  "held Anki maturity keeps the first local popup responsive and mature definitions reveal silently",
  "nonmature and unavailable Anki fail open while qualifying lookup counts still blur independently",
  "lookup counts survive a full browser restart",
  "reader settings and their revision survive a full browser restart",
  "hover enablement closes active popups and changes already-open tabs without reloading the engine",
  "configured activation keys open stationary lookups and release them using the saved delays",
  "Settings persists frequency directions and applies them to real-WASM lookup results",
  "exact selections override scan length, preserve cross-inline highlights and reject prefix-only matches",
  "source highlights reconcile selected text mutations without changing selection",
  "nested source highlights retain ancestor ownership when children close in native and fallback modes",
  "fallback source paint stays exact through clipping, scrolling, visibility and cleanup",
  "fallback source paint tracks CSS transitions and animated ancestors",
  "fallback source paint follows sibling layout changes inside fixed-size ancestors",
  "fallback source paint stays beneath page headers and overlays",
  "fallback source paint refreshes after stylesheet loading and CSSOM edits",
  "editable controls preserve normal editing and suppress pointer and selection lookups",
  "Japanese-only preferences change automatic scanning in an already-open tab",
  "dictionary CSS stays scoped with malformed braces, escaped titles, and nested rules",
  "dictionary CSS cannot load remote resources or inherit resource-valued variables",
  "dictionary CSS cannot paint or intercept input outside its glossary card",
  "settings page renders exactly four safe recommended dictionary links",
  "recommended dictionaries form a readable list on desktop",
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
  "one aggregate browser alarm follows the next dictionary due time",
  "per-dictionary schedules persist without engine reload and override global Off",
  "Settings schedule drafts preserve newer commits and retry lost replies without duplicate writes or alarms",
  "Settings name autosave merges unrelated edits, rejects external renames and paints one completion",
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
  "deinflection disclosure exposes the real ordered trace and remains keyboard reachable",
  "internal links open a positioned popup chain with level-local Note and Back and live depth limits",
  "Popup tabs project every contributing dictionary, favourites and ordered groups without another lookup",
  "Live dictionary presentation preserves pending replies, focused Note drafts and child anchors",
  "Saved popup columns reflow complete cards after expansion, media load and resize",
  "Compact summaries persist Settings, share leading media and update live without replacing definitions or Note drafts",
  "Live image sources recover missing thumbnails, preserve owners and resolve groups per path with accurate aliases",
  "Live metadata Settings preserve Note and dictionary content while independently controlling frequency pitch grammar and IPA",
  "external dictionary Enter activation creates one safe browser tab through the extension",
  "the popup renders the glossary",
  "the popup renders the frequency tag from term_meta_bank",
  "the dictionary alias labels its popup tab without replacing the canonical key",
  "selected term dictionary wins even when maximum results is one",
  "Back preserves the complete clicked-kanji drill-down history",
  "Back restores expanded linked results, exact tab, scroll, highlight and toolbar without lookup",
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
  "a structured-depth render failure clears its popup and the next healthy hover recovers",
  "large media imports through OPFS while oversized and malformed fetches fail without poisoning the engine",
  "a late real media reply cannot replace a current generation image",
  "failed media exposes its failure state and text while a later hover retries",
  "media cache deduplicates and bounds a real browser image burst",
  "obsolete queued images never dispatch while started images stay reusable",
  "dictionary AVIF and SVG decode through real WASM without extra preview fetches",
  "image hover and keyboard previews stay larger, viewport-clamped and motion-aware",
  "image previews close on leave, blur, scrolling and pending navigation",
  "dictionary image sizing preserves ordinary geometry and enforces its existing aspect bound",
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
      // A route may also refuse the connection, which is how a local service
      // this suite does not own is kept out of a check's outcome.
      if (route.fail) {
        await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: route.fail });
        return;
      }
      const response = route.respond ? await route.respond(event.request) : route;
      const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
      await session.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: response.status,
        responseHeaders: [
          { name: "Access-Control-Allow-Origin", value: "*" },
          { name: "Content-Type", value: response.contentType },
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

// The ordinary-webpage fixture. Startup exercises its narrow internal-page
// exception separately, and the saved-page check serves this prose from file://
// after verifying Chrome's per-extension file-access switch.
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
async function popupReader(page, depth = 0) {
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
        if (attributes[i] === "class" && String(attributes[i + 1]).includes("gsm-hoshidicts-popup")
            && attributes[attributes.indexOf("data-hoshidicts-depth") + 1] === String(depth)) {
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
          imageStates: Array.from(this.querySelectorAll(".gloss-image-link"), link => {
            const text = link.querySelector(".gloss-image-link-text");
            return {
              state: link.dataset.imageLoadState,
              label: link.getAttribute("aria-label"),
              width: link.querySelector("img")?.naturalWidth ?? 0,
              errorVisible: text?.textContent.includes("Image failed to load")
                && text.getBoundingClientRect().width > 16,
            };
          }),
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
      try {
        if (!visible(await state())) return true;
      } catch (error) {
        // A child can be pruned between getDocument and resolveNode. That
        // vanished snapshot is not proof of hiding: inspect again in case a
        // replacement child exists, within the same polling deadline.
        if (error.originalMessage !== "No node with given id found"
            || !error.message.includes("(DOM.resolveNode)")) throw error;
      }
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

  async function externalLink() {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: `function () {
        const link = this.querySelector('a[data-external="true"]');
        if (!link) return null;
        link.focus();
        return { href: link.href, target: link.target, rel: link.rel,
          text: link.querySelector(".gloss-link-text").textContent,
          focused: this.getRootNode().activeElement === link,
          frames: this.querySelectorAll("iframe").length };
      }`,
    });
    return result.value;
  }

  async function selectGlossaryText() {
    const object = await resolvePopupObject();
    if (object === null) return "";
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const glossary = this.querySelector(".gloss-item");
        if (!glossary) return "";
        const selection = this.ownerDocument.defaultView.getSelection();
        selection.selectAllChildren(glossary);
        return selection.toString();
      }`,
    });
    return result.value;
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

  async function imagePreview(index = 0, action = "read") {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: index }, { value: action }],
      functionDeclaration: `function (index, action) {
        const root = this.getRootNode();
        const links = [...this.querySelectorAll(".gloss-image-link")];
        const link = links[index];
        const image = link?.querySelector("img");
        if (action === "focus") link.focus();
        else if (action === "blur") link.blur();
        else if (action === "scroll") this.scrollTop += this.scrollTop > 0 ? -30 : 30;
        else if (action === "mouseenter" || action === "mouseleave") link.dispatchEvent(new Event(action));
        const preview = root.querySelector(".gsm-hoshidicts-image-hover-preview");
        const expanded = preview?.querySelector("img");
        const view = this.ownerDocument.defaultView;
        return {
          scrollTop: this.scrollTop,
          sourceRect: image?.getBoundingClientRect().toJSON(),
          focusedImage: links.indexOf(root.activeElement),
          images: links.map(link => {
            const image = link.querySelector("img");
            const container = link.querySelector(".gloss-image-container");
            const rect = container.getBoundingClientRect();
            return { source: image.src, width: image.naturalWidth, height: image.naturalHeight,
              tabStop: link.getAttribute("tabindex"), href: link.getAttribute("href"),
              display: { width: rect.width, height: rect.height, inlineWidth: container.style.width,
                fontSize: Number.parseFloat(view.getComputedStyle(container).fontSize) } };
          }),
          preview: preview ? {
            rect: preview.getBoundingClientRect().toJSON(),
            source: expanded.src, width: expanded.naturalWidth, height: expanded.naturalHeight,
            sibling: preview.parentNode === this.parentNode,
            hiddenFromAccessibility: preview.getAttribute("aria-hidden"),
            pointerEvents: view.getComputedStyle(preview).pointerEvents,
            animation: view.getComputedStyle(expanded).animationName,
            background: view.getComputedStyle(expanded).backgroundColor,
          } : null,
        };
      }`,
    });
    return result.value ?? null;
  }

  async function deinflection(action = "read") {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      awaitPromise: true,
      arguments: [{ value: action }],
      functionDeclaration: `async function (action) {
        const details = this.querySelector(".gsm-hoshidicts-deinflection");
        const summary = details?.querySelector("summary");
        if (!summary) return null;
        const list = details.querySelector("ol");
        const lastStep = list.lastElementChild;
        const glossary = this.querySelector(".gsm-hoshidicts-glossary-content");
        if (action === "focus") summary.focus();
        else if (action === "blur") summary.blur();
        else if (action === "last-step") lastStep.scrollIntoView({ block: "end" });
        else if (action === "glossary") glossary.scrollIntoView({ block: "center" });
        const view = this.ownerDocument.defaultView;
        await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
        const root = this.getRootNode();
        const note = this.querySelector(".gsm-hoshidicts-note-button");
        const noteRect = note.getBoundingClientRect();
        const termInput = this.querySelector(".gsm-hoshidicts-note-term");
        const reachable = element => {
          const rect = element.getBoundingClientRect();
          return element.contains(root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        };
        return {
          count: this.querySelectorAll(".gsm-hoshidicts-deinflection").length,
          language: view.navigator.language,
          open: details.open,
          focused: root.activeElement === summary,
          path: summary.textContent,
          label: summary.getAttribute("aria-label"),
          stepsLabel: list.getAttribute("aria-label"),
          steps: [...list.children].map(item => ({
            name: item.querySelector(".gsm-hoshidicts-deinflection-step-name").textContent,
            description: item.querySelector(".gsm-hoshidicts-deinflection-step-description")?.textContent ?? "",
          })),
          whitespace: view.getComputedStyle(details.querySelector(".gsm-hoshidicts-deinflection-endpoint")).whiteSpace,
          marker: view.getComputedStyle(summary).listStyleType,
          summaryDisplay: view.getComputedStyle(summary).display,
          popupRect: this.getBoundingClientRect().toJSON(),
          detailsRect: details.getBoundingClientRect().toJSON(),
          listRect: list.getBoundingClientRect().toJSON(),
          lastStepRect: lastStep.getBoundingClientRect().toJSON(),
          noteRect: noteRect.toJSON(),
          noteReachable: !note.disabled && note.contains(root.elementFromPoint(
            noteRect.x + noteRect.width / 2, noteRect.y + noteRect.height / 2)),
          scrollTop: this.scrollTop,
          lastStepReachable: reachable(lastStep),
          glossaryReachable: reachable(glossary),
          noteInputFocused: root.activeElement === termInput,
          noteInputReachable: termInput !== null && reachable(termInput),
        };
      }`,
    });
    return result.value ?? null;
  }

  async function nested(action = "read") {
    const object = await resolvePopupObject();
    if (!object) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      arguments: [{ value: action }],
      functionDeclaration: `function (action) {
        const root = this.getRootNode();
        const link = this.querySelector("a[data-hoshidicts-query]");
        if (action === "focus-link") link.focus();
        if (action === "remember") { root.__nestedParent = this; root.__nestedAnchor = link; }
        if (action === "blur") root.activeElement?.blur();
        const rect = this.getBoundingClientRect();
        return {
          depth: Number(this.dataset.hoshidictsDepth), rect: rect.toJSON(),
          linkRect: link?.getBoundingClientRect().toJSON(),
          query: link?.dataset.hoshidictsQuery, reading: link?.dataset.hoshidictsReading,
          linkFocused: root.activeElement === link,
          sameParent: root.querySelector('[data-hoshidicts-depth="0"]') === root.__nestedParent,
          sameAnchor: root.__nestedAnchor?.isConnected === true,
          depths: [...root.querySelectorAll(".gsm-hoshidicts-popup")].filter(popup => !popup.hidden)
            .map(popup => Number(popup.dataset.hoshidictsDepth)),
          imagesReady: [...this.querySelectorAll("img")].every(image => image.complete && image.naturalWidth === 16),
          viewport: { width: innerWidth, height: innerHeight },
        };
      }`,
    });
    return result.value;
  }

  async function sourcePaint(action = "read", sourceSelector = null) {
    const object = await resolvePopupObject();
    if (!object) return null;
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: action }, { value: sourceSelector }],
      functionDeclaration: `function (action, sourceSelector) {
        const root = this.getRootNode();
        const layer = root.querySelector(".gsm-hoshidicts-source-highlight-layer");
        if (action === "remember") root.__sourcePaintOwner = layer?.firstElementChild;
        if (action === "cover-parent") {
          const rect = layer.firstElementChild.firstElementChild.getBoundingClientRect();
          this.style.left = rect.left + "px";
          this.style.top = rect.top + "px";
          root.dispatchEvent(new Event("scroll"));
        }
        const sameOwner = layer?.firstElementChild === root.__sourcePaintOwner;
        if (action === "forget") delete root.__sourcePaintOwner;
        const ownerRects = [...(layer?.children || [])].map(group => [...group.children].map(mark => ({
          ...mark.getBoundingClientRect().toJSON(), pointerEvents: getComputedStyle(mark).pointerEvents,
        })));
        let source;
        if (sourceSelector) {
          const element = document.querySelector(sourceSelector);
          const clip = element.getBoundingClientRect();
          const left = clip.left + element.clientLeft, top = clip.top + element.clientTop;
          const expected = [...element.querySelectorAll("b,i")].flatMap(part => {
            const range = document.createRange();
            range.selectNodeContents(part.firstChild);
            return [...range.getClientRects()].map(rect => ({ left: Math.max(left, rect.left), top: Math.max(top, rect.top),
              right: Math.min(left + element.clientWidth, rect.right), bottom: Math.min(top + element.clientHeight, rect.bottom) }))
              .filter(rect => rect.right > rect.left && rect.bottom > rect.top);
          });
          source = { expected, html: element.innerHTML, className: element.className, selection: getSelection().toString(),
            cover: document.querySelector("[data-e17-painted-cover]")?.getBoundingClientRect().toJSON() };
        }
        return { groups: layer?.children.length || 0, sameOwner,
          rects: ownerRects.flat(), ownerRects, source };
      }`,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }

  async function retainedControls(action = "read") {
    const object = await resolvePopupObject();
    if (!object) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: action }],
      functionDeclaration: `function (action) {
        const root = this.getRootNode();
        if (action === "focus-tab") this.querySelector('[role="tab"][aria-selected="true"]').focus();
        if (action === "remember") {
          root.__retainedControls?.observer.disconnect();
          const form = this.querySelector("form");
          const input = form.elements.definition;
          input.focus();
          input.setSelectionRange(2, 7);
          const saved = { form, input, detached: false, panel: this.querySelector('.gsm-hoshidicts-tab-panel') };
          const observer = new MutationObserver(records => {
            saved.detached ||= records.some(record => [...record.removedNodes].includes(form));
          });
          observer.observe(this, { childList: true });
          saved.observer = observer;
          root.__retainedControls = saved;
        }
        if (action === "remember-panel") root.__retainedControls.panel = this.querySelector('.gsm-hoshidicts-tab-panel');
        const saved = root.__retainedControls;
        const input = saved?.input;
        const rect = input?.getBoundingClientRect();
        return {
          toolbar: this.dataset.toolbarPosition,
          sameForm: this.querySelector('form') === saved?.form,
          mounted: saved?.form.isConnected && !saved.form.hidden && !saved.detached
            && !saved.observer.takeRecords().some(record => [...record.removedNodes].includes(saved.form)),
          draft: input?.value, selection: [input?.selectionStart, input?.selectionEnd],
          inputFocused: root.activeElement === input,
          inputReachable: rect && root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input,
          inputRect: rect?.toJSON(), popupRect: this.getBoundingClientRect().toJSON(), scrollTop: this.scrollTop,
          centerOwner: rect && root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.className,
          tabFocused: root.activeElement === this.querySelector('[role="tab"][aria-selected="true"]'),
          replaced: this.querySelector('.gsm-hoshidicts-tab-panel') !== saved?.panel,
        };
      }`,
    });
    return result.value;
  }

  async function dictionaryTabs(action = "read", key = null) {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      arguments: [{ value: action }, { value: key }],
      functionDeclaration: function (action, key) {
        const root = this.getRootNode();
        const tabs = [...this.querySelectorAll('[role="tab"]')];
        if (action === "scroll") this.scrollTop = key;
        const tabKey = button => button.dataset.dictionary ? `dictionary:${button.dataset.dictionary}`
          : button.dataset.groupId ? `group:${button.dataset.groupId}`
            : button.dataset.favourites === "true" ? "favourites" : "all";
        if (action === "select" || action === "focus") {
          const button = tabs.find(button => tabKey(button) === key);
          if (!button) throw new Error(`Missing dictionary tab: ${key}`);
          if (action === "select") button.click(); else button.focus();
        }
        if (action === "cleanup") {
          root.__retainedControls?.observer.disconnect();
          delete root.__retainedControls;
          delete root.__nestedParent;
          delete root.__nestedAnchor;
          delete this.__dictionaryTabs;
          return true;
        }
        const panel = this.querySelector(".gsm-hoshidicts-tab-panel");
        const selected = tabs.find(button => button.getAttribute("aria-selected") === "true");
        const cards = [...this.querySelectorAll(".gsm-hoshidicts-glossary-card")];
        if (action === "collapse-card") cards[key].open = false;
        if (action === "remember") this.__dictionaryTabs = {
          panel, selected, tabs: new Map(tabs.map(button => [tabKey(button), button])), cards,
          link: this.querySelector("a[data-hoshidicts-query]"),
          images: new Map([...this.querySelectorAll("img")].map(image => [image, image.closest(".gloss-image-link")])),
        };
        const saved = this.__dictionaryTabs;
        const entries = [...this.querySelectorAll(".gsm-hoshidicts-entry")].map((entry, index) => ({
          expression: entry.dataset.expression,
          aria: (index === 0 ? this.querySelector(".gsm-hoshidicts-primary-header") : entry)
            ?.querySelector(".gsm-hoshidicts-expression")?.getAttribute("aria-label"),
          cards: [...entry.querySelectorAll(".gsm-hoshidicts-glossary-card")].map(card => ({
            open: card.open,
            dictionary: card.querySelector("summary").title,
            label: card.querySelector("summary").textContent,
            bodies: [...card.querySelectorAll(".gsm-hoshidicts-glossary-content")].map(body => body.innerHTML),
            text: [...card.querySelectorAll(".gsm-hoshidicts-glossary-content")].map(body => body.textContent),
          })),
        }));
        // Attribute insertion order is not DOM meaning. Compare the complete
        // ordered body DOM, retaining every node and attribute name/value.
        if (action === "matches") return entries.length === key.length && entries.every((entry, index) => {
          const expected = key[index];
          return entry.expression === expected.expression && entry.aria === expected.aria
            && entry.cards.length === expected.cards.length && entry.cards.every((card, cardIndex) => {
              const other = expected.cards[cardIndex];
              return card.dictionary === other.dictionary && card.open === other.open && card.bodies.length === other.bodies.length
                && card.bodies.every((html, bodyIndex) => {
                  const left = this.ownerDocument.createElement("template");
                  const right = this.ownerDocument.createElement("template");
                  left.innerHTML = html; right.innerHTML = other.bodies[bodyIndex];
                  return left.content.isEqualNode(right.content);
                });
            });
        });
        return {
          hidden: this.hidden, entries, scrollTop: this.scrollTop,
          customOutline: getComputedStyle(this).outlineColor,
          showMore: Boolean(this.querySelector(".gsm-hoshidicts-show-more")),
          toolbar: this.dataset.toolbarPosition,
          tabs: tabs.map(button => ({ key: tabKey(button), label: button.textContent, title: button.title,
            selected: button.getAttribute("aria-selected") === "true", focused: root.activeElement === button,
            tabIndex: button.tabIndex, controls: button.getAttribute("aria-controls"), id: button.id,
            aria: button.getAttribute("aria-label"),
            same: saved?.tabs.get(tabKey(button)) === button,
          })),
          selected: selected ? tabKey(selected) : null,
          panelId: panel?.id, labelledBy: panel?.getAttribute("aria-labelledby"),
          samePanel: panel === saved?.panel, sameSelected: selected === saved?.selected,
          sameCards: cards.length === saved?.cards.length && cards.every((card, index) => card === saved.cards[index]),
          sameAnchor: saved?.link?.isConnected === true && this.contains(saved.link),
          images: [...this.querySelectorAll("img")].map(image => ({ src: image.getAttribute("src") || "",
            same: saved?.images.has(image) && saved.images.get(image) === image.closest(".gloss-image-link"),
            path: image.closest(".gloss-image-link")?.dataset.path,
            complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })),
          imageSources: [...this.querySelectorAll(".gloss-image-source")].map(label => ({
            text: label.textContent, dictionary: label.dataset.dictionary, title: label.title,
            outsideThumbnail: !label.closest(".gsm-hoshidicts-compact-definition-image"),
          })),
          metadata: {
            frequencyNames: [...this.querySelectorAll(".gsm-hoshidicts-frequency-source")].map(node => node.textContent),
            frequencies: [...this.querySelectorAll(".gsm-hoshidicts-frequency-value")].map(node => Number(node.dataset.frequency)),
            clippedFrequencies: [...this.querySelectorAll(".gsm-hoshidicts-primary-frequencies .gsm-hoshidicts-frequency-value")].some(node => {
              const value = node.getBoundingClientRect();
              const tag = node.closest(".gsm-hoshidicts-tag-frequency").getBoundingClientRect();
              const capsule = node.closest(".gsm-hoshidicts-primary-metadata-capsule").getBoundingClientRect();
              return value.right > Math.min(tag.right, capsule.right) + 1 || value.left < Math.max(tag.left, capsule.left) - 1;
            }),
            pitch: this.querySelectorAll(".gsm-hoshidicts-tag-pitch").length,
            ruby: [...this.querySelectorAll(".gsm-hoshidicts-pitch-reading")].map(node => node.dataset.pitchDictionary),
            ipa: [...this.querySelectorAll(".gsm-hoshidicts-ipa-body")].map(node => node.textContent),
            ipaFits: [...this.querySelectorAll(".gsm-hoshidicts-ipa-body")].every(node => {
              const body = node.getBoundingClientRect();
              const tag = node.parentNode.getBoundingClientRect();
              const bounds = this.getBoundingClientRect();
              return body.left >= tag.left - 1 && body.right <= tag.right + 1
                && tag.left >= bounds.left - 1 && tag.right <= bounds.right + 1;
            }),
            ipaSourceEllipsized: [...this.querySelectorAll(".gsm-hoshidicts-ipa-source")]
              .some(node => node.scrollWidth > node.clientWidth),
            grammar: this.querySelectorAll(".gsm-hoshidicts-primary-grammar-tag").length,
            definitionTags: this.querySelectorAll(".gsm-hoshidicts-definition-tags").length,
          },
          rect: this.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight },
          grids: [...this.querySelectorAll(".gsm-hoshidicts-glossary-grid")].map(grid => ({
            width: grid.clientWidth, rect: grid.getBoundingClientRect().toJSON(), height: grid.style.height,
            masonry: grid.classList.contains("gsm-hoshidicts-glossary-grid-masonry"),
            cards: [...grid.children].map(card => ({ rect: card.getBoundingClientRect().toJSON(),
              offsetHeight: card.offsetHeight, width: card.style.width, transform: card.style.transform,
              visibility: card.style.visibility, open: card.open,
            })),
          })),
        };
      }.toString(),
    });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  }

  async function compactSummaries() {
    const object = await resolvePopupObject();
    if (!object) return [];
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        return [...this.querySelectorAll(".gsm-hoshidicts-compact-definition-summary")].map(summary => ({
          dictionary: summary.dataset.hoshidictsDictionary,
          items: [...summary.querySelectorAll("li")].map(item => item.textContent),
          thumbnailCount: summary.querySelectorAll(".gsm-hoshidicts-compact-definition-image").length,
          image: [...summary.querySelectorAll("img")].map(image => ({
            src: image.getAttribute("src"), complete: image.complete,
            width: image.naturalWidth, height: image.naturalHeight, hidden: image.hidden,
            rect: image.getBoundingClientRect().toJSON(),
            state: image.closest(".gloss-image-link").dataset.imageLoadState,
          })),
        }));
      }.toString(),
    });
    return reply.result.value;
  }
  async function audio(action = "read", index = 0) {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: action }, { value: index }],
      functionDeclaration: function (action, index) {
        const root = this.getRootNode(), view = this.ownerDocument.defaultView;
        const button = this.querySelectorAll(".gsm-hoshidicts-audio-button")[index];
        if (action === "play") button.click();
        if (action === "choose") button.dispatchEvent(new view.MouseEvent("click", { shiftKey: true, bubbles: true }));
        const candidate = this.querySelectorAll(".gsm-hoshidicts-audio-choices div button")[index];
        if (action === "candidate") candidate.scrollIntoView({ block: "nearest" });
        const menu = this.querySelector(".gsm-hoshidicts-audio-choices");
        const menuRect = menu?.getBoundingClientRect();
        const popupRect = this.getBoundingClientRect();
        const candidateRect = candidate?.getBoundingClientRect();
        return { text: this.textContent, button: button?.textContent,
          feedback: [...this.querySelectorAll(".gsm-hoshidicts-audio-status")].map(node => node.textContent),
          choices: [...this.querySelectorAll(".gsm-hoshidicts-audio-choices div button")].map(node => node.textContent),
          menu: Boolean(this.querySelector(".gsm-hoshidicts-audio-choices")),
          menuFits: Boolean(menuRect && menuRect.height > 100 && menuRect.top >= popupRect.top && menuRect.bottom <= popupRect.bottom),
          candidatePoint: candidateRect && { x: candidateRect.x + candidateRect.width / 2, y: candidateRect.y + candidateRect.height / 2 },
          focused: root.activeElement?.className, rect: this.getBoundingClientRect().toJSON() };
      }.toString(),
    });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  }
  async function anki() {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        return { rect: this.getBoundingClientRect().toJSON(), hidden: this.hidden,
          controls: [...this.querySelectorAll(".gsm-hoshidicts-anki-control")].map(control => {
            const add = control.querySelector(".gsm-hoshidicts-mine-button");
            const view = control.querySelector(".gsm-hoshidicts-anki-view");
            return { hidden: control.hidden, text: add.textContent, state: add.dataset.state, disabled: add.disabled,
              output: control.querySelector("output").textContent, viewDisabled: view.disabled, rect: add.getBoundingClientRect().toJSON() };
          }) };
      }.toString(),
    });
    return reply.result.value;
  }
  async function lookupStatistics(action = "read") {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: action }],
      functionDeclaration: function (action) {
        const root = this.getRootNode();
        const line = this.querySelector(".gsm-hoshidicts-lookup-stats");
        if (action === "remember") {
          root.__lookupStatisticsView = {
            popup: this,
            line,
            panel: this.querySelector(".gsm-hoshidicts-tab-panel"),
          };
        }
        if (action === "cleanup") {
          delete root.__lookupStatisticsView;
          return null;
        }
        const saved = root.__lookupStatisticsView;
        return {
          hidden: line?.hidden ?? true,
          text: line?.textContent ?? "",
          popupHidden: this.hidden,
          samePopup: saved?.popup === this,
          sameLine: saved?.line === line,
          samePanel: saved?.panel === this.querySelector(".gsm-hoshidicts-tab-panel"),
        };
      }.toString(),
    });
    return reply.result.value;
  }
  async function definitionBlur() {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        const definitions = this.querySelector(".gsm-hoshidicts-definitions");
        const rect = definitions?.getBoundingClientRect();
        return {
          state: this.dataset.definitionBlurState ?? "revealed",
          definitionsState: definitions?.dataset.definitionBlurState ?? "revealed",
          definitionsPoint: rect && { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 12) },
          audioFeedback: [...this.querySelectorAll(".gsm-hoshidicts-audio-status")].map(node => node.textContent),
          countText: this.querySelector(".gsm-hoshidicts-lookup-stats")?.textContent ?? "",
        };
      }.toString(),
    });
    return reply.result.value;
  }
  return {
    anki, audio, click, compactSummaries, definitionBlur, dictionaryTabs, deinflection, externalLink, imagePreview,
    lookupStatistics, nested, sourcePaint, retainedControls, selectGlossaryText, state, visible,
    waitForVisible, waitForHidden, writeNote,
  };
}

// Content scripts have their own Highlight constructor; changing the page's
// main-world global would leave the production path untested.
async function forceSourceFallback(tab, settings) {
  const cdp = await tab.createCDPSession();
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context.id));
  await cdp.send("Runtime.enable");
  const extensionId = new URL(settings.url()).host;
  let contextId;
  for (const id of contexts) {
    const { result } = await cdp.send("Runtime.evaluate", { contextId: id,
      expression: `typeof HDPopup === "object" && globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}` });
    if (result.value === true) { contextId = id; break; }
  }
  if (contextId === undefined) { await cdp.detach(); throw new Error("Hachidori content world not found"); }
  const evaluate = async expression => {
    const { exceptionDetails } = await cdp.send("Runtime.evaluate", { contextId, expression });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
  };
  const toggle = async () => {
    for (const enabled of [false, true]) {
      await settings.evaluate(async sourceHighlightEnabled => {
        const { options } = await chrome.storage.local.get("options");
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
          baseRevision: options.revision, options: { sourceHighlightEnabled } });
        if (!reply.ok) throw new Error(reply.error);
      }, enabled);
      await tab.evaluate(() => new Promise(done => setTimeout(done, 100)));
    }
  };
  await evaluate("globalThis.__sourceHighlightConstructor = globalThis.Highlight; globalThis.Highlight = undefined");
  await toggle();
  return async () => {
    try {
      await evaluate("globalThis.Highlight = globalThis.__sourceHighlightConstructor; delete globalThis.__sourceHighlightConstructor");
      await toggle();
    } finally { await cdp.detach(); }
  };
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

async function checkDeinflectionDisclosure(settings, tab, popup) {
  const native = await settings.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "e2e-deinflection-trace",
    text: "食べたかった", maxResults: 1, scanLength: 16,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
  }));
  const expected = native.results?.[0];
  const closed = await popup.deinflection();
  const labels = new Map([
    ["en", ["Deinflection steps", `Why this matched: ${expected?.matched} became ${expected?.deinflected}`]],
    ["ja", ["活用解除の手順", `一致した理由: ${expected?.matched} から ${expected?.deinflected} に戻しました`]],
    ["uk", ["Кроки відновлення словникової форми", `Чому це збіглося: ${expected?.matched} перетворено на ${expected?.deinflected}`]],
  ]);
  const [stepsLabel, summaryLabel] = labels.get(closed?.language.toLowerCase().split("-")[0]) ?? labels.get("en");
  const viewport = tab.viewport();
  let focused;
  let expanded;
  let collapsed;
  let lastStep;
  let glossary;
  let note;
  try {
    await tab.bringToFront();
    await tab.setViewport({ width: 360, height: 900 });
    focused = await popup.deinflection("focus");
    await tab.keyboard.press("Enter");
    expanded = await popup.deinflection();
    await popup.click(".gsm-hoshidicts-note-button");
    note = await popup.deinflection();
    await tab.keyboard.press("Escape");
    lastStep = await popup.deinflection("last-step");
    glossary = await popup.deinflection("glossary");
    await popup.deinflection("focus");
    await tab.keyboard.press("Space");
    collapsed = await popup.deinflection();
    if (process.env.HACHIDORI_DEINFLECTION_SCREENSHOT) {
      await tab.setViewport(viewport);
      await tab.keyboard.press("Enter");
      await popup.deinflection();
      await tab.screenshot({ path: process.env.HACHIDORI_DEINFLECTION_SCREENSHOT });
      await tab.keyboard.press("Space");
    }
  } finally {
    await popup.deinflection("blur");
    await tab.setViewport(viewport);
  }
  const fitsWidth = (outer, inner) => inner?.width > 0 && inner.height > 0
    && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
  check("deinflection disclosure exposes the real ordered trace and remains keyboard reachable",
    native.ok && expected?.matched === "食べたかった" && expected.deinflected === "食べる"
      && JSON.stringify(expected.trace.map(step => step.name)) === JSON.stringify(["-た", "-たい"])
      && closed?.count === 1 && closed.open === false
      && closed.path === `${expected.matched} → ${expected.deinflected}`
      && closed.label === summaryLabel && closed.stepsLabel === stepsLabel
      && JSON.stringify(closed.steps) === JSON.stringify(expected.trace.map(({ name, description }) => ({ name, description })))
      && focused?.focused === true && expanded?.open === true && expanded.focused
      && collapsed?.open === false && collapsed.focused
      && expanded.whitespace === "pre-wrap" && expanded.summaryDisplay === "list-item"
      && expanded.marker !== "none" && expanded.noteReachable
      && expanded.popupRect.left >= 0 && expanded.popupRect.right <= 360
      && fitsWidth(expanded.popupRect, expanded.detailsRect)
      && fitsWidth(expanded.popupRect, expanded.listRect)
      && fitsWidth(expanded.popupRect, expanded.noteRect)
      && Math.abs(expanded.noteRect.top - focused.noteRect.top) <= 1
      && note?.open === true && note.noteInputFocused && note.noteInputReachable
      && lastStep?.open === true && lastStep.scrollTop > 0 && lastStep.lastStepReachable
      && lastStep.lastStepRect.top >= lastStep.popupRect.top
      && lastStep.lastStepRect.bottom <= lastStep.popupRect.bottom
      && glossary?.open === true && glossary.glossaryReachable,
    JSON.stringify({ expected, closed, focused, expanded, collapsed, lastStep, glossary, note }));
}

async function checkExternalLinks(browser, settings, tab, popup) {
  const sourceUrl = tab.url();
  const destinationUrl = new URL("external-reference?query=%E5%8F%82%E7%85%A7#meaning", sourceUrl).href;
  const fixture = externalLinksFixture(destinationUrl);
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  await installMediaArchive(settings, fixture.archive);
  const worker = await (await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"))).worker();
  await worker.evaluate(() => {
    const probe = { requests: [], creates: [], pending: [], create: chrome.tabs.create };
    probe.listener = message => {
      if (message.type === "hd_open_external") probe.requests.push(message);
    };
    chrome.runtime.onMessage.addListener(probe.listener);
    chrome.tabs.create = function (properties) {
      const operation = probe.create.call(this, properties).then(tab => {
        probe.creates.push({ properties, id: tab.id, openerTabId: tab.openerTabId });
        return tab;
      });
      probe.pending.push(operation);
      return operation;
    };
    globalThis.__externalLinksProbe = probe;
  });
  const created = [];
  const onCreated = target => { if (target.type() === "page") created.push(target); };
  browser.on("targetcreated", onCreated);
  let evidence;
  try {
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    const link = await popup.externalLink();
    const [target] = await Promise.all([
      browser.waitForTarget(target => target.type() === "page" && target.url() === destinationUrl, { timeout: 10_000 }),
      tab.keyboard.press("Enter"),
    ]);
    const destination = await target.page();
    const navigation = await destination.evaluate(() => ({ url: location.href, opener: window.opener !== null }));
    const afterOpen = await worker.evaluate(async () => {
      const probe = globalThis.__externalLinksProbe;
      await Promise.all(probe.pending);
      return { requests: probe.requests, creates: probe.creates };
    });
    const invalid = await settings.evaluate(() => chrome.runtime.sendMessage({
      target: "hoshidicts-worker", type: "hd_open_external", requestId: "external-invalid",
      url: "javascript:document.body.remove()",
    }));
    const afterInvalid = await worker.evaluate(() => globalThis.__externalLinksProbe.creates.length);
    await destination.close();
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    const restored = await hoverForPopup(tab, popup, "#verb");
    evidence = { link, navigation, afterOpen, afterInvalid, invalid, created: created.length,
      sourceUnchanged: tab.url() === sourceUrl, restored: restored?.text.includes("外部辞典 <reference>") };
  } finally {
    browser.off("targetcreated", onCreated);
    for (const target of created) {
      const page = await target.page();
      if (page && !page.isClosed()) await page.close();
    }
    await worker.evaluate(() => {
      const probe = globalThis.__externalLinksProbe;
      chrome.tabs.create = probe.create;
      chrome.runtime.onMessage.removeListener(probe.listener);
      delete globalThis.__externalLinksProbe;
    });
    const removed = await settings.evaluate(title => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_remove", title,
    }), fixture.title);
    if (!removed.ok) throw new Error(removed.error);
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
  }
  check("external dictionary Enter activation creates one safe browser tab through the extension",
    evidence.link?.focused && evidence.link.href === destinationUrl && evidence.link.frames === 0
      && evidence.link.target === "_blank" && evidence.link.rel === "noopener noreferrer"
      && evidence.link.text === "外部辞典 <reference>"
      && evidence.navigation.url === destinationUrl && !evidence.navigation.opener
      && evidence.created === 1 && evidence.afterOpen.requests.length === 1 && evidence.afterOpen.creates.length === 1
      && evidence.afterOpen.requests[0].url === destinationUrl
      && evidence.afterOpen.creates[0].properties.url === destinationUrl
      && evidence.afterOpen.creates[0].properties.active === true
      && evidence.afterOpen.creates[0].openerTabId === undefined
      && evidence.invalid.ok === false && evidence.invalid.requestId === "external-invalid"
      && evidence.afterInvalid === 1 && evidence.sourceUnchanged && evidence.restored, JSON.stringify(evidence));
}

async function installMediaArchive(page, archive) {
  return page.evaluate(async (base64) => {
    const blobUrl = URL.createObjectURL(new Blob([
      Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
    ], { type: "application/zip" }));
    try {
      const reply = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_import", requestId: "owned-media-import",
        blobUrl, fileName: "owned-media.zip",
      });
      if (!reply.ok) throw new Error(reply.error);
      return reply.generation;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, archive.toString("base64"));
}

async function checkDictionaryTabsColumns(settings, tab, popup, browser) {
  const fixture = dictionaryTabsFixture();
  const titles = fixture.dictionaries.map(item => item.title);
  const [links, usage, examples, reference] = titles;
  const studyId = "e2e-tabs-study", examplesId = "e2e-tabs-examples", emptyId = "e2e-tabs-empty";
  const studyKey = `group:${studyId}`;
  const installed = [];
  const original = await settings.evaluate(() => chrome.storage.local.get(["options", "dictionaryState"]));
  const originalVerb = await tab.$eval("#verb", element => ({ html: element.innerHTML, style: element.getAttribute("style") }));
  const viewport = tab.viewport(), settingsViewport = settings.viewport();
  const child = await popupReader(tab, 1);
  const evidence = { projections: [], columns: [] };
  let worker, failure;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function until(read, predicate, description) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now() >= deadline) throw new Error(`${description}: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const status = () => settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
  const ready = () => until(status, value => value.ok && value.ready && !value.loading, "E8 native readiness");
  const optionsWrite = options => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, options);
  const presentation = (patches, groups) => settings.evaluate(async ({ patches, groups }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: dictionaryState.revision,
      dictionaries: dictionaryState.dictionaries.map(dictionary => ({ ...dictionary, ...patches[dictionary.title] })), groups });
    if (!reply.ok) throw new Error(reply.error);
    return reply.state;
  }, { patches, groups });
  const requests = () => worker.evaluate(() => globalThis.__ownedMediaProbe.requests);
  const rootState = () => popup.dictionaryTabs();
  const childState = () => child.dictionaryTabs();
  const imageReady = value => value?.images.length === 1 && value.images[0].complete
    && value.images[0].width === 16 && value.images[0].height === 16;
  const visible = value => value && !value.hidden && value.entries.length > 0;
  const selectedReady = key => value => visible(value) && value.selected === key;
  const bounded = value => value.rect.left >= 5 && value.rect.top >= 5
    && value.rect.right <= value.viewport.width - 5 && value.rect.bottom <= value.viewport.height - 5;
  async function setColumns(value) {
    await editSettingsControls(settings, { "opt-popup-columns": String(value) });
    await settings.waitForFunction(async value => (await chrome.storage.local.get("options")).options.popupColumns === value,
      { polling: 50, timeout: 10_000 }, value);
  }
  function packed(value, requested) {
    if (!visible(value) || !bounded(value) || !value.grids.length) return false;
    const near = (a, b) => Math.abs(a - b) <= 1;
    return value.grids.every(grid => {
      const columns = Math.min(requested, grid.cards.length), heights = Array(columns).fill(0);
      const width = (grid.width - 8 * (columns - 1)) / columns;
      if (grid.width <= 0 || grid.masonry !== (columns > 1)) return false;
      for (const [index, card] of grid.cards.entries()) {
        const column = heights.indexOf(Math.min(...heights));
        const x = column * (width + 8), y = heights[column];
        if (!card.open || !near(card.rect.width, width) || !near(card.rect.left - grid.rect.left, x)
            || !near(card.rect.top - grid.rect.top, y) || card.rect.right > grid.rect.right + 1) return false;
        if (columns === 1 && (card.width !== "" || card.transform !== "" || card.visibility !== "")) return false;
        if (columns > 1 && (card.visibility !== "visible" || !near(Number.parseFloat(card.width), width))) return false;
        for (const other of grid.cards.slice(0, index)) {
          if (Math.min(card.rect.right, other.rect.right) - Math.max(card.rect.left, other.rect.left) > 1
              && Math.min(card.rect.bottom, other.rect.bottom) - Math.max(card.rect.top, other.rect.top) > 1) return false;
        }
        heights[column] += (columns === 1 ? card.rect.height : card.offsetHeight) + 8;
      }
      return columns === 1 ? grid.height === ""
        : near(Number.parseFloat(grid.height), Math.max(...heights) - 8);
    });
  }
  async function openChild() {
    require((await popup.nested("focus-link"))?.linkFocused, "E8 parent source link focus");
    await tab.keyboard.press("Enter");
    return until(childState, value => selectedReady(studyKey)(value) && imageReady(value), "E8 linked Study view");
  }
  try {
    for (const dictionary of fixture.dictionaries) {
      await installMediaArchive(settings, dictionary.archive);
      installed.push(dictionary.title);
    }
    const initialStatus = await ready();
    await optionsWrite({ popupColumns: 1, popupNestingMaxDepth: 2, maxResults: 32, kanjiClickDictionary: GENERIC_KANJI_SELECTION });
    const packages = await settings.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState.dictionaries);
    const id = title => packages.find(dictionary => dictionary.title === title)?.id;
    require([...titles, GENERIC_KANJI_TITLE].every(title => id(title)), "E8 exact package identities");
    let groups = [
      { id: studyId, name: "Study", dictionaryIds: [id(links), id(usage), id(GENERIC_KANJI_TITLE)] },
      { id: examplesId, name: "Examples", dictionaryIds: [id(links), id(examples)] },
      { id: emptyId, name: "Empty", dictionaryIds: [id(GENERIC_KANJI_TITLE)] },
    ];
    await presentation(Object.fromEntries(titles.map((title, index) => [title,
      { displayName: ["Links", "Usage", "Examples", "Reference"][index], favorite: index === 0 || index === 3 }])), groups);
    // Current E2E also retains the generic 食/しょく package. Preserve its genuine
    // extra prefix result instead of copying the five-package preflight oracle.
    evidence.native = await settings.evaluate(async ({ root, child, reading }) => {
      const { options } = await chrome.storage.local.get("options");
      const lookup = (text, primaryReading) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup",
        text, maxResults: options.maxResults, scanLength: options.scanLength,
        options: { frequencyDictionary: options.frequencyDictionary, frequencyOrder: options.frequencyOrder, primaryReading } });
      return { root: await lookup(root, ""), child: await lookup(child, reading) };
    }, { root: fixture.query, child: fixture.child, reading: fixture.reading });
    require(evidence.native.root.ok && evidence.native.child.ok
      && evidence.native.root.results.length === 1
      && equal(evidence.native.root.results[0].term.glossaries.map(glossary => glossary.dictionary), titles), "E8 native four-card root");
    const childExpected = evidence.native.child.results.map(({ term }) => ({
      expression: term.expression, aria: term.reading && term.reading !== term.expression ? `${term.expression}, ${term.reading}` : term.expression,
      dictionaries: [...new Set(term.glossaries.map(glossary => glossary.dictionary))],
    }));
    require(childExpected.length > 1 && childExpected[0].expression === fixture.child
      && childExpected.some(entry => entry.dictionaries.includes(GENERIC_KANJI_TITLE)), "E8 genuine child prefix input");
    worker = await installMediaReplyProbe(browser);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await tab.setViewport({ width: 1880, height: 960 });
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    const all = await until(rootState, value => selectedReady("all")(value) && imageReady(value), "E8 complete root");
    const expectedKeys = ["all", ...titles.map(title => `dictionary:${title}`), "favourites", studyKey, `group:${examplesId}`];
    require(equal(all.tabs.map(tab => tab.key), expectedKeys)
      && equal(all.tabs.map(tab => tab.label), ["All", "Links", "Usage", "Examples", "Reference", "Favourites", "Study", "Examples (group)"])
      && all.tabs.every(tab => tab.controls === all.panelId && tab.aria === tab.title)
      && all.labelledBy === all.tabs[0].id, "E8 semantic tabs and accessible panel linkage");
    const projectionStart = (await requests()).length;
    for (const [key, members] of [
      ...titles.map(title => [`dictionary:${title}`, [title]]),
      ["favourites", [links, reference]], [studyKey, [links, usage]], [`group:${examplesId}`, [links, examples]], ["all", titles],
    ]) {
      await popup.dictionaryTabs("select", key);
      await until(rootState, selectedReady(key), `E8 projection ${key}`);
      const expected = all.entries.map(entry => ({ ...entry, cards: entry.cards.filter(card => members.includes(card.dictionary)) }));
      await until(() => popup.dictionaryTabs("matches", expected), Boolean, `E8 complete dictionary projection ${key}`);
      evidence.projections.push(key);
    }
    await popup.dictionaryTabs("remember");
    await popup.dictionaryTabs("select", "all");
    const noOp = await rootState();
    require(noOp.sameCards && noOp.samePanel && (await requests()).length === projectionStart, "E8 warmed tabs must stay local and same-tab must retain cards");

    // Internal-link → clicked-kanji → Back preserves semantic Study context.
    await popup.dictionaryTabs("select", studyKey);
    await tab.setViewport({ width: 1880, height: 240 });
    const inherited = await openChild();
    require(await child.click(".gsm-hoshidicts-show-more"), "E13 expand linked results before drill-down");
    const studyResultCount = childExpected.filter(entry => entry.dictionaries.some(title => [links, usage, GENERIC_KANJI_TITLE].includes(title))).length;
    await until(childState, value => value?.entries.length === studyResultCount
      && value.entries.at(-1).cards.some(card => card.text.includes(GENERIC_KANJI_GLOSSARY)), "E13 complete deferred bodies");
    await child.dictionaryTabs("collapse-card", 0);
    const beforeBack = await child.dictionaryTabs("scroll", 80);
    require(beforeBack.scrollTop > 0, "E13 nonzero prior scroll");
    const highlights = () => tab.evaluate(name => Array.from(CSS.highlights.get(name) ?? [], range => range.toString()), HIGHLIGHT_NAME);
    const previousHighlights = await highlights();
    require(await child.click(".gsm-hoshidicts-kanji-link"), "E8 clicked-kanji control");
    const kanji = await until(childState, value => selectedReady(studyKey)(value)
      && value.entries[0].cards[0].dictionary === GENERIC_KANJI_TITLE, "E8 clicked-kanji group context");
    await child.dictionaryTabs("select", "all");
    const beforeBackRequests = (await requests()).length;
    await optionsWrite({ customPopupCss: ".gsm-hoshidicts-popup { outline-color: rgb(12, 34, 56); }" });
    await until(childState, value => value.customOutline === "rgb(12, 34, 56)", "E18 live child CSS");
    evidence.cssChild = (await rootState()).customOutline === "rgb(12, 34, 56)";
    require(await child.click(".gsm-hoshidicts-kanji-back"), "E8 term Back");
    const back = await until(childState, value => selectedReady(studyKey)(value)
      && value.entries.length === beforeBack.entries.length && !value.showMore
      && Math.abs(value.scrollTop - beforeBack.scrollTop) < 1, "E13 expanded linked Back viewport");
    evidence.back = back.toolbar === beforeBack.toolbar
      && await child.dictionaryTabs("matches", beforeBack.entries)
      && equal(await highlights(), previousHighlights)
      && (await requests()).length === beforeBackRequests;
    require(evidence.back, "E13 exact Back state and no native lookup");
    await optionsWrite({ popupWidthPx: 640, popupHeightPx: 480 });
    const resizedChild = await until(childState, value => value.rect.width === Math.min(640, value.viewport.width - 12)
      && value.rect.height === Math.min(480, value.viewport.height - 12),
      "E15 live child dimensions");
    evidence.appearanceChild = bounded(resizedChild) && (await rootState()).rect.width === 640;
    const automaticRoot = (await rootState()).toolbar;
    evidence.toolbarChild = true;
    for (const edge of ["bottom", "top", "auto"]) {
      await optionsWrite({ popupToolbarPosition: edge });
      await until(childState, value => value.toolbar === (edge === "auto" ? "top" : edge), "E16 child toolbar edge");
      evidence.toolbarChild &&= (await rootState()).toolbar === (edge === "auto" ? automaticRoot : edge);
    }
    await optionsWrite({ popupWidthPx: 560, popupHeightPx: 420 });
    await until(childState, value => value.rect.width === Math.min(560, value.viewport.width - 12)
      && value.rect.height === Math.min(420, value.viewport.height - 12), "E15 restore child dimensions");
    if (process.env.HACHIDORI_KANJI_BACK_SCREENSHOT) {
      const { x, y, width, height } = back.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_KANJI_BACK_SCREENSHOT, clip: { x, y, width, height } });
    }
    require(await child.click(".gsm-hoshidicts-kanji-back") && await child.waitForHidden(), "E8 close child Back");
    await tab.setViewport({ width: 1880, height: 960 });
    evidence.inheritance = { inherited: inherited.selected, kanji: kanji.selected, back: back.selected,
      parent: (await rootState()).selected };
    require(evidence.inheritance.parent === studyKey, "E8 child navigation changed parent tab");
    require((await status()).generation === initialStatus.generation, "E8 presentation or tabs reloaded native dictionaries");

    const liveStart = (await requests()).length;
    await popup.dictionaryTabs("focus", studyKey);
    await popup.dictionaryTabs("remember");
    groups = [groups[1], { ...groups[0], name: "Reading list" }, groups[2]];
    await presentation({ [usage]: { displayName: "Usage notes" } }, groups);
    const renamed = await until(rootState, value => value?.tabs.some(tab => tab.key === studyKey && tab.label === "Reading list"), "E8 focused live labels");
    require(renamed.sameCards && renamed.samePanel && renamed.sameSelected && renamed.sameAnchor
      && renamed.tabs.filter(tab => tab.key.startsWith("group:")).map(tab => tab.key).join() === `group:${examplesId},${studyKey}`
      && renamed.tabs.every(tab => tab.same)
      && renamed.tabs.find(tab => tab.key === studyKey).focused
      && renamed.entries[0].cards.find(card => card.dictionary === usage).label === "Usage notes", `E8 labels/order preserve focused keyed controls and bodies: ${JSON.stringify(renamed)}`);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
    await popup.nested("remember");
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.heldLookups.length), count => count === 1, "E8 held child reply");
    groups = groups.map(group => group.id === studyId ? { ...group, name: "Learning" } : group);
    await presentation({}, groups);
    require((await popup.nested()).sameAnchor, "E8 pending child lost its parent anchor");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.heldLookups.splice(0)) release(); });
    const newest = await until(childState, value => selectedReady(studyKey)(value)
      && value.tabs.find(tab => tab.key === studyKey)?.label === "Learning" && imageReady(value), "E8 pending child uses newest presentation");
    require(await popup.click(".gsm-hoshidicts-note-button"), "E8 parent Note");
    await popup.writeNote({ definition: "E8 protected presentation draft" });
    const draft = await popup.retainedControls("remember");
    await popup.dictionaryTabs("remember");
    groups = groups.map(group => group.id === studyId ? { ...group, dictionaryIds: [id(links), id(GENERIC_KANJI_TITLE)] } : group);
    await presentation({}, groups);
    // The real state event must have arrived: the child's same-membership label
    // changes too, while the protected parent still cannot replace its cards.
    groups = groups.map(group => group.id === studyId ? { ...group, name: "Focused learning" } : group);
    await presentation({}, groups);
    await until(childState, value => value?.tabs.find(tab => tab.key === studyKey)?.label === "Focused learning", "E8 protected state event delivered");
    const protectedView = await rootState(), protectedDraft = await popup.retainedControls();
    await optionsWrite({ customPopupCss: ".gsm-hoshidicts-popup { outline-color: rgb(56, 34, 12); }" });
    await until(rootState, value => value.customOutline === "rgb(56, 34, 12)", "E18 live root CSS");
    const cssDraft = await popup.retainedControls();
    evidence.css = evidence.cssChild && (await childState()).customOutline === "rgb(56, 34, 12)"
      && (await rootState()).sameCards && cssDraft.sameForm && cssDraft.mounted && cssDraft.inputFocused
      && cssDraft.draft === draft.draft && equal(cssDraft.selection, [2, 7]);
    await optionsWrite({ customPopupCss: "" });
    require(protectedView.sameCards && protectedView.samePanel && protectedView.sameAnchor
      && protectedView.entries[0].cards.length === 2 && protectedDraft.sameForm && protectedDraft.mounted
      && protectedDraft.inputFocused && protectedDraft.draft === draft.draft && equal(protectedDraft.selection, [2, 7]), "E8 live Note and child protect their original projection");
    await tab.keyboard.press("Escape");
    require((await popup.state()).noteOpen === false, "E8 Note must close before child retirement");
    require(await child.click(".gsm-hoshidicts-kanji-back") && await child.waitForHidden(), "E8 protected child retirement");
    await popup.dictionaryTabs("focus", studyKey);
    const flushed = await until(rootState, value => selectedReady(studyKey)(value)
      && equal(value.entries[0].cards.map(card => card.dictionary), [links]), "E8 safe presentation flush");
    require(flushed.tabs.find(tab => tab.key === studyKey).focused, "E8 safe flush stole selected-tab focus");
    groups = groups.filter(group => group.id !== studyId);
    await presentation({}, groups);
    const fallback = await until(rootState, value => selectedReady("all")(value) && value.entries[0].cards.length === 4, "E8 removed selected group fallback");
    require(fallback.tabs.find(tab => tab.key === "all").focused, "E8 removed-group fallback focus");
    const liveRequests = (await requests()).slice(liveStart);
    require(liveRequests.length === 1 && liveRequests[0].type === "hd_lookup"
      && liveRequests[0].text === fixture.child && newest.selected === studyKey, "E8 live presentation duplicated lookup/media/style work");
    evidence.live = { renamed, newest, protectedView, protectedDraft, flushed, fallback, liveRequests };

    // Columns must preserve mounted controls/cards; actual rects expose the
    // content-box width bug instead of accepting overlapping width styles.
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "E8 columns keep this exact draft" });
    const columnDraft = await popup.retainedControls("remember");
    await popup.dictionaryTabs("remember");
    const columnsStart = (await requests()).length;
    const toolbarEdges = [];
    for (const edge of ["bottom", "top"]) {
      await optionsWrite({ popupToolbarPosition: edge });
      await until(rootState, value => value.toolbar === edge, "E16 root toolbar edge");
      for (const size of [{ width: 520, height: 740 }, { width: 1880, height: 960 }]) {
        await tab.setViewport(size);
        const placed = await until(rootState, value => value.viewport.width === size.width && value.toolbar === edge,
          "E16 fixed edge survives resize");
        const controls = await popup.retainedControls();
        toolbarEdges.push(placed.sameCards && placed.samePanel && controls.sameForm && controls.mounted
          && controls.inputFocused && controls.draft === columnDraft.draft && equal(controls.selection, [2, 7]));
      }
    }
    await optionsWrite({ popupToolbarPosition: "auto" });
    evidence.toolbar = evidence.toolbarChild && toolbarEdges.every(Boolean) && (await requests()).length === columnsStart;
    const sourceSpan = await highlights();
    const pageTheme = await tab.evaluate(() => ({ theme: document.documentElement.getAttribute("data-hoshidicts-theme"),
      style: document.documentElement.getAttribute("style") }));
    await optionsWrite({ popupTheme: "high-contrast", popupOpacityPercent: 0, sourceHighlightEnabled: false });
    await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "high-contrast"
      && !CSS.highlights.has("gsm-hoshidicts-match"));
    await optionsWrite({ sourceHighlightEnabled: true });
    await until(highlights, value => equal(value, sourceSpan), "E15 restore the exact current source highlight");
    const appearance = await tab.evaluate(() => {
      const host = document.querySelector("hachidori-host");
      return { primary: getComputedStyle(host).getPropertyValue("--hoshidicts-palette-primary").trim(),
        opacity: host.style.getPropertyValue("--gsm-hoshidicts-popup-opacity"),
        highlight: getComputedStyle(document.getElementById("verb"), "::highlight(gsm-hoshidicts-match)").backgroundColor,
        theme: document.documentElement.getAttribute("data-hoshidicts-theme"),
        style: document.documentElement.getAttribute("style") };
    });
    const appearanceDraft = await popup.retainedControls();
    evidence.appearance = evidence.appearanceChild && appearance.primary === "#ffe000" && appearance.opacity === "0%"
      && appearance.highlight.endsWith(" / 0.56)") && appearance.theme === pageTheme.theme && appearance.style === pageTheme.style
      && appearanceDraft.sameForm && appearanceDraft.inputFocused && appearanceDraft.draft === columnDraft.draft
      && (await rootState()).sameCards && (await requests()).length === columnsStart;
    await optionsWrite({ popupTheme: "default", popupOpacityPercent: 85 });
    for (const columns of [1, 2, 3, 4, 1]) {
      await setColumns(columns);
      const geometry = await until(rootState, value => packed(value, columns), `E8 ${columns}-column geometry`);
      const controls = await popup.retainedControls();
      require(geometry.sameCards && geometry.samePanel && controls.sameForm && controls.mounted && controls.inputFocused
        && controls.draft === columnDraft.draft && equal(controls.selection, [2, 7]), "E8 column update replaced a mounted draft or card");
      evidence.columns.push({ columns, geometry, controls });
    }
    await setColumns(3);
    for (const size of [{ width: 520, height: 740 }, { width: 1880, height: 960 }]) {
      await tab.setViewport(size);
      const geometry = await until(rootState, value => value.viewport.width === size.width && packed(value, 3), "E8 focused resize geometry");
      require(geometry.sameCards && (await popup.retainedControls()).inputFocused, "E8 resize changed focused Note ownership");
    }
    require((await requests()).length === columnsStart, "E8 columns or resize issued dictionary resource work");
    await setColumns(2);
    await tab.keyboard.press("Escape");
    require(!(await popup.state()).noteOpen, "E8 finished column draft did not close");
    const screenshotView = await until(rootState, value => packed(value, 2), "E8 two-column reader capture");
    if (process.env.HACHIDORI_TABS_SCREENSHOT) {
      const { x, y, width, height } = screenshotView.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_TABS_SCREENSHOT, clip: { x, y, width, height } });
    }
    if (process.env.HACHIDORI_OPTIONS_SCREENSHOT || process.env.HACHIDORI_OPTIONS_DARK_SCREENSHOT) {
      await settings.bringToFront();
      await settings.setViewport({ width: 1280, height: 1000 });
      await showSettingsSection(settings, "lookup");
      for (const [scheme, path] of [["light", process.env.HACHIDORI_OPTIONS_SCREENSHOT], ["dark", process.env.HACHIDORI_OPTIONS_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await (await settings.$("#lookup")).screenshot({ path });
      }
    }
    // Retire the old view before importing a cold generation and arming the
    // real media reply hold; a protected Note would deliberately prevent rehover.
    await tab.bringToFront();
    require(!(await popup.state()).noteOpen, "E8 cold media setup retained Note");
    await tab.keyboard.press("Escape");
    require(await popup.waitForHidden(), "E8 cold media setup retained popup");
    await installMediaArchive(settings, fixture.archive);
    await ready();
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = true; });
    await hoverForPopup(tab, popup, "#verb");
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.held.length), count => count === 1, "E8 held real media");
    const loading = await until(rootState, value => packed(value, 2) && value.images.length === 1 && value.images[0].src === "", "E8 reserved pending-image geometry");
    await popup.dictionaryTabs("remember");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.held.splice(0)) release(); });
    const loaded = await until(rootState, value => packed(value, 2) && imageReady(value), "E8 decoded media reflow");
    require(loaded.sameCards && loaded.images[0].src === `data:image/png;base64,${makePng().toString("base64")}`, "E8 media reflow changed card or bytes");
    await popup.nested("remember");
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    await until(childState, value => selectedReady("all")(value) && imageReady(value), "E8 All child before expansion");
    require(await child.click(".gsm-hoshidicts-show-more"), "E8 genuine child Show more");
    const expanded = await until(childState, value => value?.entries.length === childExpected.length && packed(value, 2)
      && value.entries.flatMap(entry => entry.cards).some(card => card.text.includes(GENERIC_KANJI_GLOSSARY)), "E8 complete child expansion");
    require(equal(expanded.entries.map(entry => ({ expression: entry.expression, aria: entry.aria,
      dictionaries: entry.cards.map(card => card.dictionary) })), childExpected), "E8 expanded native expression/reading/dictionary order");
    await child.dictionaryTabs("remember");
    await child.click(".gsm-hoshidicts-note-button");
    await child.writeNote({ definition: "E8 child holds its anchor through resize" });
    const childDraft = await child.retainedControls("remember");
    const nestedResizeStart = (await requests()).length;
    for (const size of [{ width: 520, height: 740 }, { width: 1880, height: 960 }]) {
      await tab.setViewport(size);
      const resized = await until(childState, value => value?.viewport.width === size.width && packed(value, 2), "E8 expanded child resize");
      const controls = await child.retainedControls();
      require(resized.sameCards && await child.dictionaryTabs("matches", expanded.entries)
        && (await popup.nested()).sameAnchor && controls.sameForm && controls.mounted
        && controls.inputFocused && controls.draft === childDraft.draft, "E8 child resize replaced complete results, Note or parent anchor");
    }
    require((await requests()).length === nestedResizeStart, "E8 child resize issued extra resource work");
    evidence.media = { loading, loaded, expanded };
    evidence.passed = true;
  } catch (error) {
    failure = error;
  } finally {
    // Complete every owned cleanup even if setup failed halfway, while retaining
    // both the original error and any cleanup error rather than swallowing either.
    const errors = [];
    const clean = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    if (worker) await clean(() => restoreMediaReplyProbe(worker));
    await clean(() => child.dictionaryTabs("cleanup"));
    await clean(() => popup.dictionaryTabs("cleanup"));
    await clean(() => optionsWrite({ popupColumns: original.options.popupColumns ?? 1,
      popupTheme: original.options.popupTheme ?? "default", popupOpacityPercent: original.options.popupOpacityPercent ?? 85,
      popupWidthPx: original.options.popupWidthPx ?? 560, popupHeightPx: original.options.popupHeightPx ?? 420,
      sourceHighlightEnabled: original.options.sourceHighlightEnabled ?? true,
      popupNestingMaxDepth: original.options.popupNestingMaxDepth ?? 10, maxResults: original.options.maxResults,
      kanjiClickDictionary: original.options.kanjiClickDictionary }));
    for (const title of installed) await clean(async () => {
      const reply = await settings.evaluate(title => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_remove", title }), title);
      if (!reply.ok) throw new Error(reply.error);
    });
    await clean(() => presentation({}, original.dictionaryState.groups ?? []));
    await clean(() => tab.$eval("#verb", (element, original) => {
      element.innerHTML = original.html;
      if (original.style === null) element.removeAttribute("style"); else element.setAttribute("style", original.style);
    }, originalVerb));
    await clean(() => tab.setViewport(viewport));
    await clean(() => settings.setViewport(settingsViewport));
    await clean(() => settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]));
    await clean(async () => {
      await tab.bringToFront();
      // At most the two deliberate Note forms and two live levels remain.
      for (let index = 0; index < 4 && !(await popup.waitForHidden(1)); index++) await tab.keyboard.press("Escape");
      require(await popup.waitForHidden(), "E8 cleanup retained its popup");
    });
    if (errors.length) failure = new AggregateError(failure ? [failure, ...errors] : errors, "E8 scenario/cleanup failure");
  }
  if (failure) throw failure;
  check("Back restores expanded linked results, exact tab, scroll, highlight and toolbar without lookup",
    evidence.back === true, JSON.stringify(evidence.inheritance));
  check("Popup tabs project every contributing dictionary, favourites and ordered groups without another lookup",
    evidence.passed && evidence.projections.length === 8, JSON.stringify({ projections: evidence.projections, inheritance: evidence.inheritance }));
  check("Live dictionary presentation preserves pending replies, focused Note drafts and child anchors",
    evidence.passed && evidence.live.liveRequests.length === 1, JSON.stringify(evidence.live));
  check("Saved popup columns reflow complete cards after expansion, media load and resize",
    evidence.passed && evidence.columns.length === 5, JSON.stringify({ columns: evidence.columns, media: evidence.media }));
  check("live appearance changes preserve reader Notes and resources while applying the selected page highlight",
    evidence.passed && evidence.appearance === true, JSON.stringify({ appearance: evidence.appearance, child: evidence.appearanceChild }));
  check("live toolbar overrides apply to root and child and survive resize without focus or resource loss",
    evidence.passed && evidence.toolbar === true, JSON.stringify({ toolbar: evidence.toolbar, child: evidence.toolbarChild }));
  check("live custom CSS updates root and child without losing Notes, Back or making engine requests",
    evidence.passed && evidence.css && evidence.back && evidence.live.liveRequests.length === 1,
    JSON.stringify({ css: evidence.css, child: evidence.cssChild }));
}

async function checkCompactSummaries(settings, tab, popup, browser) {
  const fixture = compactSummaryFixture();
  const original = await settings.evaluate(() => chrome.storage.local.get("options"));
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  const child = await popupReader(tab, 1);
  const installed = [], evidence = {};
  let worker, failure;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function until(read, predicate, label) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const write = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const summaries = () => popup.compactSummaries();
  const show = async query => {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await tab.$eval("#verb", (element, text) => { element.textContent = text; }, query);
    await hoverForPopup(tab, popup, "#verb");
  };
  try {
    for (const dictionary of fixture.dictionaries) {
      await installMediaArchive(settings, dictionary.archive);
      installed.push(dictionary.title);
    }
    evidence.native = await settings.evaluate(async text => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_lookup", text, maxResults: 32, scanLength: 16,
    }), fixture.query);
    require(evidence.native.ok && evidence.native.results.length === 1
      && evidence.native.results[0].term.glossaries[0].glossary === JSON.stringify(fixture.leading), "E10 real native leading glossary");
    await settings.evaluate(async names => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: dictionaryState.revision,
        dictionaries: dictionaryState.dictionaries.map(dictionary => ({ ...dictionary,
          displayName: names[dictionary.title] ?? dictionary.displayName })), groups: dictionaryState.groups });
      if (!reply.ok) throw new Error(reply.error);
    }, { [fixture.illustrated]: "Illustrated definitions", [fixture.plain]: "Brief meanings" });
    await settings.bringToFront();
    await editSettingsControls(settings, { "opt-compact-summary": true, "opt-summary-count": "2",
      "opt-summary-dictionary": fixture.illustrated, "opt-max-results": "32" });
    for (const [id, value] of [["opt-summary-dictionary", ""], ["opt-summary-count", "4"]]) {
      // Hold the established input-before-change draft seam. The input seed is
      // synthetic; external CAS and Chrome's disable/blur behavior are native.
      await settings.$eval(`#${id}`, (control, value) => {
        control.focus(); control.value = value; control.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await write({ showCompactDefinitionSummary: false });
      await settings.waitForFunction(() => !document.getElementById("opt-compact-summary").checked);
      require(await settings.$eval(`#${id}`, (control, value) => document.activeElement === control
        && !control.disabled && control.value === value, value), `E10 external off discarded ${id} draft`);
      await settings.$eval(`#${id}`, control => control.dispatchEvent(new Event("change", { bubbles: true })));
      await settings.waitForFunction(() => document.getElementById("options-status").textContent.includes("Could not save"));
      await settings.$eval(`#${id}`, control => control.blur());
      await settings.click("#options-use-saved");
      require(await settings.$eval(`#${id}`, control => control.disabled), `E10 ${id} did not disable after blur`);
      await editSettingsControls(settings, { "opt-compact-summary": true });
    }
    worker = await installMediaReplyProbe(browser);
    await show(fixture.query);
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.held.length), count => count === 1, "E10 shared held image");
    const initial = await summaries();
    require(equal(initial[0]?.items, ["短い説明", "使い方"]) && initial[0].image.length === 1
      && !initial[0].image[0].src, "E10 text is usable while leading image waits");
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "E10 keeps this exact draft" });
    const draft = await popup.retainedControls("remember");
    await popup.dictionaryTabs("remember");
    await write({ compactDefinitionSummaryDictionary: fixture.plain });
    await until(summaries, value => value[0]?.items[0] === "Alternative first", "E10 live source");
    const controls = await popup.retainedControls(), cards = await popup.dictionaryTabs();
    require(controls.sameForm && controls.mounted && controls.inputFocused && controls.draft === draft.draft
      && equal(controls.selection, [2, 7]) && cards.sameCards && cards.samePanel && cards.sameAnchor, "E10 live source preserves owners");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.held.splice(0)) release(); });
    const loadedCards = await until(() => popup.dictionaryTabs(), value => value.images.length === 1
      && value.images[0].complete && value.images[0].width === 16, "E10 remaining full-card media consumer");
    await write({ compactDefinitionSummaryDictionary: fixture.illustrated, compactDefinitionSummaryCount: 3 });
    const loaded = await until(summaries, value => value[0]?.items.length === 3 && value[0].image[0]?.complete
      && value[0].image[0].width === 16, "E10 cached compact image");
    require(equal(loaded[0].items, ["短い説明", "使い方", "別の意味"])
      && loaded[0].image[0].rect.width === 36 && loaded[0].image[0].rect.height === 36
      && await popup.dictionaryTabs("matches", loadedCards.entries), "E10 compact geometry and unchanged complete definitions");
    const media = await worker.evaluate(() => globalThis.__ownedMediaProbe.requests.filter(request => request.type === "hd_media"));
    const encoded = loaded[0].image[0].src.split(",")[1];
    require(media.length === 1 && media[0].dictionary === fixture.illustrated
      && Buffer.from(encoded, "base64").equals(makePng()), "E10 one shared native media request and exact PNG bytes");
    evidence.sharedMedia = media.length;
    await tab.keyboard.press("Escape");
    if (process.env.HACHIDORI_SUMMARY_POPUP_SCREENSHOT) {
      const { x, y, width, height } = (await popup.dictionaryTabs()).rect;
      await tab.screenshot({ path: process.env.HACHIDORI_SUMMARY_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    await popup.dictionaryTabs("select", `dictionary:${fixture.plain}`);
    await until(summaries, value => equal(value[0]?.items, ["Alternative first", "Alternative second"])
      && value[0].image.length === 0, "E10 tab-local soft fallback");
    await popup.dictionaryTabs("select", "all");
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    await until(() => child.compactSummaries(), value => value[0]?.items[0] === "Text before the image."
      && value[0].image.length === 0, "E10 child late-image negative");
    require(await child.click(".gsm-hoshidicts-show-more"), "E10 genuine prefix Show more");
    await until(() => child.compactSummaries(), value => value.length === 2
      && value[1].items.length === 3, "E10 deferred headers use current preferences");
    require(await child.click(".gsm-hoshidicts-kanji-back") && await child.waitForHidden(), "E10 child Back");

    await show(fixture.broken);
    await until(summaries, value => equal(value[0]?.items, ["The text remains available."])
      && value[0].image.length === 0 && value[0].thumbnailCount === 0, "E10 failed leading image text-only fallback");
    const failedCard = await popup.state();
    require(failedCard.imageStates.length === 1 && failedCard.imageStates[0].state === "load-error"
      && failedCard.imageStates[0].errorVisible && failedCard.plain.includes("The text remains available."),
      "E10 missing thumbnail retains the full-card image error and definition");

    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "Keep the image-source draft" });
    await popup.retainedControls("remember");
    await popup.dictionaryTabs("remember");
    const beforeImageRoute = await worker.evaluate(() => globalThis.__ownedMediaProbe.requests.length);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = true; });
    // Exercise the native chooser without blurring the reader: foregrounding
    // Settings intentionally dismisses the popup via the production blur rule.
    await editSettingsControls(settings, { "opt-image-source": JSON.stringify({ kind: "dictionary", title: fixture.plain }) });
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.held.length), count => count === 1, "E11 shared alternate image");
    require((await summaries())[0]?.thumbnailCount === 1, "E11 failed compact thumbnail did not remount");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.held.splice(0)) release(); });
    const alternate = await until(() => popup.dictionaryTabs(), value => value.images.length === 2
      && value.images.every(image => image.complete && image.width === 16), "E11 alternate bytes decoded");
    const alternateBytes = Buffer.concat([makePng(), Buffer.from([1])]);
    const sourceLabels = (value, title, name) => value.imageSources.length === 2 && value.imageSources.every(label =>
      label.dictionary === title && label.title === title && label.text === `Image: ${name}` && label.outsideThumbnail);
    const routedControls = await popup.retainedControls();
    require(alternate.sameCards && alternate.samePanel && alternate.images[1].same
      && alternate.entries[0].cards.length === 1 && alternate.entries[0].cards[0].dictionary === fixture.illustrated
      && alternate.entries[0].cards[0].text.some(text => text.includes("The text remains available."))
      && equal((await summaries())[0]?.items, ["The text remains available."])
      && alternate.images.every(image => Buffer.from(image.src.split(",")[1], "base64").equals(alternateBytes))
      && sourceLabels(alternate, fixture.plain, "Brief meanings")
      && routedControls.sameForm && routedControls.mounted && routedControls.inputFocused
      && routedControls.draft === "Keep the image-source draft" && equal(routedControls.selection, [2, 7]),
      "E11 alternate provenance/bytes changed the text or mounted Note/image owners");
    const imageRouteRequests = await worker.evaluate(start => globalThis.__ownedMediaProbe.requests.slice(start), beforeImageRoute);
    require(imageRouteRequests.length === 1 && imageRouteRequests[0].type === "hd_media"
      && imageRouteRequests[0].dictionary === fixture.plain && imageRouteRequests[0].path === "media/missing.png",
      "E11 alternate thumbnail/full-card request was not shared");
    await settings.evaluate(async ({ illustrated, plain }) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: dictionaryState.revision,
        dictionaries: dictionaryState.dictionaries.map(dictionary => dictionary.title === plain
          ? { ...dictionary, displayName: "Alternate illustrations" } : dictionary),
        groups: [...dictionaryState.groups, { id: "e11-images", name: "Illustrations",
          dictionaryIds: [illustrated, plain].map(title => dictionaryState.dictionaries.find(dictionary => dictionary.title === title).id) }],
      });
      if (!reply.ok) throw new Error(reply.error);
    }, fixture);
    const aliased = await until(() => popup.dictionaryTabs(), value => sourceLabels(value, fixture.plain, "Alternate illustrations"), "E11 live supplier alias");
    require(aliased.sameCards && aliased.entries[0].cards[0].text.some(text => text.includes("The text remains available."))
      && equal((await summaries())[0]?.items, ["The text remains available."]), "E11 alias discarded definition text");
    require(await worker.evaluate(() => globalThis.__ownedMediaProbe.requests.length) === beforeImageRoute + 1,
      "E11 alias/group-name presentation refetched content");
    const beforeGroupRoute = await worker.evaluate(() => globalThis.__ownedMediaProbe.requests.length);
    await write({ popupImageSource: { kind: "tabGroup", id: "e11-images" } });
    await until(() => worker.evaluate(start => globalThis.__ownedMediaProbe.requests.slice(start), beforeGroupRoute),
      requests => requests.some(request => request.type === "hd_media" && request.dictionary === fixture.illustrated
        && request.path === "media/missing.png"), "E11 group route adopted before output comparison");
    await until(() => popup.dictionaryTabs(), value => !value.hidden && value.images.length === 2
      && value.images.every(image => image.complete && image.width === 16)
      && sourceLabels(value, fixture.plain, "Alternate illustrations"), "E11 group fallback to alternate");
    const groupRequests = await worker.evaluate(start => globalThis.__ownedMediaProbe.requests.slice(start), beforeGroupRoute);
    require(groupRequests.length === 1 && groupRequests[0].type === "hd_media"
      && groupRequests[0].dictionary === fixture.illustrated && groupRequests[0].path === "media/missing.png",
      "E11 ordered group did not reuse its successful alternate cache entry");
    if (process.env.HACHIDORI_IMAGE_SOURCE_POPUP_SCREENSHOT) {
      await tab.keyboard.press("Escape");
      const { x, y, width, height } = (await popup.dictionaryTabs()).rect;
      await tab.screenshot({ path: process.env.HACHIDORI_IMAGE_SOURCE_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    if (process.env.HACHIDORI_IMAGE_SOURCE_SETTINGS_SCREENSHOT || process.env.HACHIDORI_IMAGE_SOURCE_SETTINGS_DARK_SCREENSHOT) {
      await settings.bringToFront();
      await showSettingsSection(settings, "lookup");
      for (const [scheme, path] of [["light", process.env.HACHIDORI_IMAGE_SOURCE_SETTINGS_SCREENSHOT],
        ["dark", process.env.HACHIDORI_IMAGE_SOURCE_SETTINGS_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await (await settings.$("#lookup")).screenshot({ path });
      }
    }
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await show(fixture.query);
    const groupOriginal = await until(() => popup.dictionaryTabs(), value => value.images.length === 2
      && value.images.every(image => image.complete && image.width === 16), "E11 group first supplier for another path");
    require(groupOriginal.imageSources.length === 0
      && groupOriginal.images.every(image => Buffer.from(image.src.split(",")[1], "base64").equals(makePng())),
      "E11 group incorrectly retained one global supplier across paths");
    await popup.dictionaryTabs("remember");
    await popup.imagePreview(1, "focus");
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = true; });
    await write({ popupImageSource: { kind: "dictionary", title: fixture.plain } });
    await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.held.length), count => count === 1, "E11 focused alternate image");
    const focusedPending = await popup.imagePreview(1);
    require(focusedPending.focusedImage === 1 && focusedPending.preview === null,
      "E11 changing the image URL lost keyboard focus or retained stale preview bytes");
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.held.splice(0)) release(); });
    const focusedLoaded = await until(() => popup.imagePreview(1), value => value.focusedImage === 1
      && value.preview?.width === 16, "E11 focused alternate preview resumes");
    require(Buffer.from(focusedLoaded.preview.source.split(",")[1], "base64").equals(alternateBytes)
      && (await popup.dictionaryTabs()).images.every(image => image.same), "E11 focused source refresh replaced its image owners");
    await write({ popupImageSource: { kind: "dictionary", title: "Unavailable E11 image source" } });
    const focusedFailure = await until(() => popup.imagePreview(0), value => value.images.length === 1
      && value.images[0].href === null && value.preview === null, "E11 focused source failure");
    require(focusedFailure.focusedImage === 0 && focusedFailure.images[0].tabStop === "0",
      "E11 pending/failing route discarded deliberate keyboard focus");
    const blurredFailure = await popup.imagePreview(0, "blur");
    require(blurredFailure.images[0].tabStop === null, "E11 failed image retained a noninteractive tab stop after blur");
    await write({ popupImageSource: null });
    await until(() => popup.dictionaryTabs(), value => !value.hidden && value.images.length === 2 && value.imageSources.length === 0
      && value.images[1].same
      && value.images.every(image => image.complete && Buffer.from(image.src.split(",")[1], "base64").equals(makePng())),
      "E11 Automatic restores original images without alternate provenance");
    evidence.imageSources = { shared: imageRouteRequests, groupFallback: groupRequests, focused: focusedPending.focusedImage };
    await tab.keyboard.press("Escape");
    await tab.$eval("#verb", (element, text) => { element.textContent = text; }, fixture.query);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
    const pendingHover = hoverForPopup(tab, popup, "#verb");
    try {
      await until(() => worker.evaluate(() => globalThis.__ownedMediaProbe.heldLookups.length), count => count === 1, "E10 held valid lookup");
      await write({ compactDefinitionSummaryDictionary: fixture.plain, compactDefinitionSummaryCount: 1 });
    } finally {
      await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.heldLookups.splice(0)) release(); });
      await pendingHover;
    }
    await until(summaries, value => equal(value[0]?.items, ["Alternative first"]), "E10 pending lookup adopts latest summary options");
    const status = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
    require(status.generation === evidence.native.generation, "E10 presentation reloaded the engine");
    if (process.env.HACHIDORI_SUMMARY_SETTINGS_SCREENSHOT || process.env.HACHIDORI_SUMMARY_SETTINGS_DARK_SCREENSHOT) {
      await settings.bringToFront();
      await showSettingsSection(settings, "lookup");
      await editSettingsControls(settings, { "opt-summary-count": "3", "opt-summary-dictionary": fixture.illustrated });
      for (const [scheme, path] of [["light", process.env.HACHIDORI_SUMMARY_SETTINGS_SCREENSHOT],
        ["dark", process.env.HACHIDORI_SUMMARY_SETTINGS_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await (await settings.$("#lookup")).screenshot({ path });
      }
    }
    evidence.passed = true;
  } catch (error) {
    failure = error;
  } finally {
    const errors = [];
    const clean = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
    if (worker) await clean(() => restoreMediaReplyProbe(worker));
    await clean(() => popup.dictionaryTabs("cleanup"));
    await clean(() => child.dictionaryTabs("cleanup"));
    await clean(() => write({ maxResults: original.options.maxResults,
      popupImageSource: original.options.popupImageSource ?? null,
      showCompactDefinitionSummary: original.options.showCompactDefinitionSummary ?? false,
      compactDefinitionSummaryCount: original.options.compactDefinitionSummaryCount ?? 3,
      compactDefinitionSummaryDictionary: original.options.compactDefinitionSummaryDictionary ?? "" }));
    await clean(() => settings.evaluate(async () => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: dictionaryState.revision, dictionaries: dictionaryState.dictionaries,
        groups: dictionaryState.groups.filter(group => group.id !== "e11-images") });
      if (!reply.ok) throw new Error(reply.error);
    }));
    for (const title of installed) await clean(async () => {
      const reply = await settings.evaluate(title => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_remove", title }), title);
      if (!reply.ok) throw new Error(reply.error);
    });
    await clean(() => tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb));
    await clean(() => settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]));
    await clean(async () => {
      await tab.bringToFront();
      for (let index = 0; index < 4 && !(await popup.waitForHidden(1)); index++) await tab.keyboard.press("Escape");
      require(await popup.waitForHidden(), "E10 cleanup retained a popup");
    });
    if (errors.length) failure = new AggregateError(failure ? [failure, ...errors] : errors, "E10 scenario/cleanup failure");
  }
  if (failure) throw failure;
  check("Compact summaries persist Settings, share leading media and update live without replacing definitions or Note drafts",
    evidence.passed && evidence.sharedMedia === 1, JSON.stringify(evidence));
  check("Live image sources recover missing thumbnails, preserve owners and resolve groups per path with accurate aliases",
    evidence.passed && evidence.imageSources?.focused === 1, JSON.stringify(evidence.imageSources));
}

async function checkNestedLinks(settings, tab, popup, browser) {
  async function waitForPopupState(reader, predicate) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = await reader.state();
      if (reader.visible(state) && predicate(state)) return state;
      if (Date.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const fixture = nestedLinksFixture();
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  const originalStyle = await tab.$eval("#verb", element => element.getAttribute("style"));
  const originalOptions = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const originalViewport = tab.viewport();
  const child = await popupReader(tab, 1);
  const grandchild = await popupReader(tab, 2);
  const setDepth = (value) => settings.evaluate(async (popupNestingMaxDepth) => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { popupNestingMaxDepth } });
    if (!reply.ok) throw new Error(reply.error);
  }, value);
  const bounded = (value) => value && value.rect.width > 0 && value.rect.height > 0
    && value.rect.left >= 5 && value.rect.top >= 5
    && value.rect.right <= value.viewport.width - 5 && value.rect.bottom <= value.viewport.height - 5;
  let evidence;
  await installMediaArchive(settings, fixture.archive);
  try {
    await setDepth(2);
    await tab.setViewport({ width: 1880, height: 960 });
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    await tab.evaluate(name => {
      window.__sourceAncestorRanges = [...CSS.highlights.get(name)];
    }, HIGHLIGHT_NAME);
    await popup.nested("remember");
    const source = await popup.nested("focus-link");
    await tab.mouse.click(source.linkRect.x + source.linkRect.width / 2, source.linkRect.y + source.linkRect.height / 2);
    const mouseChild = await child.waitForVisible();
    const mousePosition = await child.nested();
    let corridorRetained = false;
    if (mousePosition) {
      await popup.nested("blur");
      await tab.mouse.move((source.rect.right + mousePosition.rect.left) / 2, mousePosition.rect.top + 20);
      await new Promise(resolve => setTimeout(resolve, 120));
      corridorRetained = child.visible(await child.state());
      await tab.mouse.move(mousePosition.rect.right - 8, mousePosition.rect.bottom - 8);
      await tab.mouse.move(source.rect.left + 8, source.rect.top + 8);
    }
    const pointerReturn = await child.waitForHidden();
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    const first = await waitForPopupState(child, state => state.plain.includes(fixture.child)
      && state.imageStates.length === 1 && state.imageStates[0].width === 16);
    const chain = await child.nested();
    await child.click(".gsm-hoshidicts-note-button");
    const draft = await child.writeNote({ definition: "child draft survives parent Note" });
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "independent parent draft" });
    const parentDraft = await popup.state();
    const childDraft = await child.state();
    await tab.keyboard.press("Escape");
    const parentClosed = await popup.state();
    const childStillEditing = await child.state();
    await tab.keyboard.press("Escape");
    await child.nested("focus-link");
    await tab.keyboard.press("Enter");
    const second = await waitForPopupState(grandchild, state => state.plain.includes(fixture.grandchild)
      && state.imageStates.length === 1 && state.imageStates[0].width === 16);
    const fullChain = await grandchild.nested();
    const fullHighlights = await tab.evaluate(name => {
      const ranges = [...(CSS.highlights.get(name) || [])];
      const rootRetained = ranges[0] === window.__sourceAncestorRanges[0];
      window.__sourceAncestorRanges = ranges;
      return { rootRetained, texts: ranges.map(range => range.toString()) };
    }, HIGHLIGHT_NAME);
    await grandchild.nested("focus-link");
    await tab.keyboard.press("Enter");
    const limited = await grandchild.nested();
    if (process.env.HACHIDORI_NESTED_SCREENSHOT) {
      await tab.screenshot({ path: process.env.HACHIDORI_NESTED_SCREENSHOT });
    }
    await tab.setViewport({ width: 520, height: 740 });
    await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const narrow = await grandchild.nested();
    await tab.setViewport({ width: 1880, height: 960 });
    await setDepth(1);
    const lowered = await grandchild.waitForHidden();
    await child.click(".gsm-hoshidicts-kanji-link");
    const kanji = await waitForPopupState(child, state => state.hasBack && !state.plain.includes("The referenced entry."));
    await child.click(".gsm-hoshidicts-kanji-back");
    const back = await waitForPopupState(child, state => state.plain.includes("The referenced entry."));
    await child.click(".gsm-hoshidicts-kanji-back");
    const returned = await child.waitForHidden();
    const retained = await popup.nested();
    const ancestorHighlight = await tab.evaluate(name => {
      const ranges = [...(CSS.highlights.get(name) || [])];
      const same = ranges.length === 1 && ranges[0] === window.__sourceAncestorRanges[0];
      delete window.__sourceAncestorRanges;
      return { same, text: ranges[0]?.toString() };
    }, HIGHLIGHT_NAME);
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    await child.waitForVisible();
    const linkRects = await tab.evaluate(name => Array.from([...CSS.highlights.get(name)][1]
      .getClientRects(), rect => rect.toJSON()), HIGHLIGHT_NAME);
    const restoreHighlight = await forceSourceFallback(tab, settings);
    let fallback;
    try {
      const before = await popup.sourcePaint("remember");
      await child.sourcePaint("cover-parent");
      await tab.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const covered = await popup.sourcePaint();
      await child.click(".gsm-hoshidicts-kanji-back");
      await child.waitForHidden();
      await tab.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const after = await popup.sourcePaint("forget");
      fallback = { before, covered, after, linkRects };
    } finally { await restoreHighlight(); }
    check("nested source highlights retain ancestor ownership when children close in native and fallback modes",
      fullHighlights.rootRetained && fullHighlights.texts.length === 3
        && fullHighlights.texts.every(Boolean) && ancestorHighlight.same && ancestorHighlight.text === fixture.query
        && fallback.before.groups === 2 && fallback.before.ownerRects[1].length > 0
        && fallback.before.ownerRects[1].every(rect => linkRects.some(source => rect.left >= source.left - 1
          && rect.right <= source.right + 1 && rect.top >= source.top - 1 && rect.bottom <= source.bottom + 1))
        && fallback.covered.ownerRects[0].length === 0
        && fallback.after.groups === 1 && fallback.after.sameOwner && fallback.after.ownerRects[0].length > 0,
      JSON.stringify({ fullHighlights, ancestorHighlight, fallback }));
    await setDepth(0);
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    const disabled = await popup.nested();
    const refreshedControls = await checkRetainedLinkControls(browser, settings, tab, popup, child, fixture, setDepth);
    evidence = { source, mouseChild, corridorRetained, pointerReturn, first, chain, draft, parentDraft, childDraft, parentClosed, childStillEditing,
      second, fullChain, limited, narrow, lowered, kanji, back, returned, retained, disabled, refreshedControls };
  } finally {
    await setDepth(originalOptions.popupNestingMaxDepth ?? 10);
    const removed = await settings.evaluate(title => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_remove", title,
    }), fixture.title);
    if (!removed.ok) throw new Error(removed.error);
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
    await tab.$eval("#verb", (element, style) => {
      if (style === null) element.removeAttribute("style"); else element.setAttribute("style", style);
    }, originalStyle);
    await tab.setViewport(originalViewport);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
  }
  check("internal links open a positioned popup chain with level-local Note and Back and live depth limits",
    evidence.source.query === fixture.child && evidence.source.reading === fixture.reading
      && evidence.mouseChild !== null && evidence.corridorRetained && evidence.pointerReturn
      && evidence.first?.plain.includes(fixture.child) && bounded(evidence.chain)
      && evidence.chain.sameParent && evidence.chain.sameAnchor && evidence.chain.imagesReady
      && evidence.draft?.term === fixture.child && evidence.draft.reading === fixture.reading
      && evidence.parentDraft.noteDefinition === "independent parent draft"
      && evidence.childDraft.noteDefinition === "child draft survives parent Note"
      && !evidence.parentClosed.noteOpen && evidence.childStillEditing.noteOpen
      && evidence.second?.plain.includes(fixture.grandchild) && bounded(evidence.fullChain)
      && JSON.stringify(evidence.limited.depths) === "[0,1,2]"
      && bounded(evidence.narrow)
      && evidence.lowered && evidence.kanji && evidence.back && evidence.returned
      && evidence.retained.sameParent && evidence.retained.sameAnchor && evidence.retained.imagesReady
      && JSON.stringify(evidence.disabled.depths) === "[0]"
      && evidence.refreshedControls.every(value => value === true), JSON.stringify(evidence));
}

async function checkRetainedLinkControls(browser, settings, tab, popup, child, fixture, setDepth) {
  const favorite = await settings.evaluate(async (title) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_apply_state",
      baseRevision: dictionaryState.revision,
      dictionaries: dictionaryState.dictionaries.map(dictionary => dictionary.title === title
        ? { ...dictionary, favorite: true } : dictionary) });
  }, fixture.title);
  if (!favorite.ok) throw new Error(favorite.error);
  const worker = await installMediaReplyProbe(browser);
  const evidence = [];
  const hold = () => worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
  const waitHeld = () => worker.evaluate(async () => {
    const deadline = Date.now() + 10_000;
    while (!globalThis.__ownedMediaProbe.heldLookups.length) {
      if (Date.now() >= deadline) throw new Error("retained view replay never reached its held reply");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  const release = () => worker.evaluate(() => {
    for (const resume of globalThis.__ownedMediaProbe.heldLookups.splice(0)) resume();
  });
  async function refreshed() {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await popup.retainedControls();
      if (value?.replaced || Date.now() >= deadline) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  try {
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await setDepth(1);
    for (const position of ["top", "bottom"]) {
      await tab.keyboard.press("Escape");
      await tab.setViewport({ width: 900, height: 420 });
      await tab.$eval("#verb", (element, position) => {
        element.style.cssText = 'position:fixed;left:20px;' + (position === 'top' ? 'top:10px' : 'bottom:10px');
      }, position);
      await tab.bringToFront();
      await hoverForPopup(tab, popup, "#verb");
      if (position === "top") {
        await popup.click(".gsm-hoshidicts-note-button");
        await popup.writeNote({ definition: "retained draft before replay" });
      } else {
        await popup.nested("focus-link");
        await tab.keyboard.press("Enter");
        await child.waitForVisible();
        await child.click(".gsm-hoshidicts-note-button");
      }
      await installMediaArchive(settings, fixture.archive);
      await hold();
      await popup.retainedControls("focus-tab");
      await tab.keyboard.press("ArrowRight");
      await waitHeld();
      if (position === "bottom") {
        await popup.click(".gsm-hoshidicts-note-button");
        await popup.writeNote({ definition: "retained draft during replay" });
      }
      const before = await popup.retainedControls("remember");
      await release();
      const after = await refreshed();
      evidence.push(after?.toolbar === position && after.sameForm && after.mounted
        && after.inputFocused && after.inputReachable && after.draft === before.draft
        && JSON.stringify(after.selection) === "[2,7]" || { position, before, after });
      await installMediaArchive(settings, fixture.archive);
      await hold();
      await popup.retainedControls("remember-panel");
      await popup.retainedControls("focus-tab");
      await tab.keyboard.press("ArrowLeft");
      await waitHeld();
      await release();
      const keyboard = await refreshed();
      evidence.push(keyboard?.sameForm && keyboard.mounted && keyboard.tabFocused && keyboard.draft === before.draft);
      await tab.keyboard.press("Escape");
      await tab.keyboard.press("Escape");
    }
    return evidence;
  } finally {
    await restoreMediaReplyProbe(worker);
  }
}

async function installMediaReplyProbe(browser) {
  const workerTarget = await browser.waitForTarget((target) => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"));
  const worker = await workerTarget.worker();
  // Let the real offscreen/WASM operation finish, then delay only delivery of
  // its reply. Other messages and the mutation queue remain production paths.
  await worker.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    const probe = { original, held: [], heldLookups: [], lookups: [], requests: [], holdNextLookup: false,
      holdNext: true, holdAll: false, failNext: false,
      count: 0, active: 0, maxActive: 0 };
    globalThis.__ownedMediaProbe = probe;
    chrome.runtime.sendMessage = function (message, ...args) {
      const response = original.call(this, message, ...args);
      if (message.relayed && message.type === "hd_lookup") probe.lookups.push(message);
      if (message.relayed && ["hd_lookup", "hd_lookup_dictionary", "hd_kanji", "hd_media", "hd_styles"].includes(message.type)) {
        probe.requests.push(message);
      }
      if (message.relayed && ["hd_lookup", "hd_lookup_dictionary", "hd_kanji"].includes(message.type) && probe.holdNextLookup) {
        probe.holdNextLookup = false;
        return response.then(reply => new Promise(resolveReply => {
          probe.heldLookups.push(() => resolveReply(reply));
        }));
      }
      if (!message.relayed || message.type !== "hd_media") return response;
      probe.count += 1;
      probe.active += 1;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      const hold = probe.holdNext || probe.holdAll;
      const fail = probe.failNext;
      probe.holdNext = false;
      probe.failNext = false;
      return response.then((reply) => {
        if (hold) return new Promise((resolveReply) => {
          probe.held.push(() => resolveReply(reply));
        });
        return fail ? { ...reply, ok: false, dataUrl: null, error: "injected transient media failure" } : reply;
      }).finally(() => { probe.active -= 1; });
    };
  });
  return worker;
}

async function restoreMediaReplyProbe(worker) {
  await worker.evaluate(() => {
    const probe = globalThis.__ownedMediaProbe;
    chrome.runtime.sendMessage = probe.original;
    for (const release of probe.held) release();
    for (const release of probe.heldLookups) release();
    delete globalThis.__ownedMediaProbe;
  });
}

async function mediaOwnershipChrome({ browser, page, tab, popup }) {
  const title = "owned-media-fixture";
  const oldBytes = makePng();
  const newBytes = Buffer.concat([oldBytes, Buffer.from([1])]);
  const archive = (bytes) => buildTitledZip(title, { terms: [
    ["画像", "がぞう", "", "", 0, ["surrounding image definition", {
      type: "structured-content", content: {
        tag: "img", path: "media/owned.png", width: 16, height: 16, alt: "Owned dictionary image",
      },
    }], 1, ""],
  ], mediaEntries: [["media/owned.png", bytes]] });
  const install = (bytes) => installMediaArchive(page, archive(bytes));
  const worker = await installMediaReplyProbe(browser);
  async function waitForImage(predicate) {
    const deadline = Date.now() + 10_000;
    do {
      const state = await popup.state();
      if (predicate(state)) return state;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    } while (Date.now() < deadline);
    throw new Error("owned media image did not reach its expected state");
  }
  async function rehover() {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    return hoverForPopup(tab, popup, "#verb");
  }
  try {
    const firstGeneration = await install(oldBytes);
    await tab.evaluate(() => { document.getElementById("verb").textContent = "画像"; });
    await rehover();
    await worker.evaluate(async () => {
      const deadline = Date.now() + 10_000;
      while (globalThis.__ownedMediaProbe.held.length === 0) {
        if (Date.now() >= deadline) throw new Error("real media reply was not held");
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
      }
    });
    const held = await popup.state();
    const nextGeneration = await install(newBytes);
    await rehover();
    const expectedUrl = `data:image/png;base64,${newBytes.toString("base64")}`;
    await waitForImage((state) => state?.images[0] === expectedUrl && state.imageStates[0]?.width === 16);
    await worker.evaluate(() => globalThis.__ownedMediaProbe.held.shift()());
    await rehover();
    const current = await waitForImage((state) => state?.images[0] === expectedUrl
      && state.imageStates[0]?.width === 16);
    const count = await worker.evaluate(() => globalThis.__ownedMediaProbe.count);
    check("a late real media reply cannot replace a current generation image",
      firstGeneration !== nextGeneration && held.images[0] === "" && count === 2
        && current.plain.includes("surrounding image definition"),
      JSON.stringify({ firstGeneration, nextGeneration, held: held.images, count, current: current.imageStates }));

    await install(newBytes);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.failNext = true; });
    await rehover();
    const failedImage = await waitForImage((state) => state?.imageStates[0]?.state === "load-error");
    if (process.env.HACHIDORI_MEDIA_FAILURE_SCREENSHOT) {
      await tab.screenshot({ path: process.env.HACHIDORI_MEDIA_FAILURE_SCREENSHOT });
    }
    await rehover();
    const retried = await waitForImage((state) => state?.images[0] === expectedUrl
      && state.imageStates[0]?.width === 16);
    const afterRetry = await worker.evaluate(() => globalThis.__ownedMediaProbe.count);
    check("failed media exposes its failure state and text while a later hover retries",
      failedImage.plain.includes("surrounding image definition")
        && failedImage.imageStates[0].label.includes("Owned dictionary image")
        && failedImage.imageStates[0].errorVisible
        && retried.imageStates[0].state === "loaded" && afterRetry === count + 2,
      JSON.stringify({ failed: failedImage.imageStates, retried: retried.imageStates, count, afterRetry }));
  } finally {
    await restoreMediaReplyProbe(worker);
  }
}

async function boundedMediaChrome({ browser, page, tab, popup }) {
  const png = makePng();
  const paths = Array.from({ length: 12 }, (_, index) => `media/burst-${index}.png`);
  const archive = buildTitledZip("bounded-media-queue-fixture", {
    terms: [["並列画像", "へいれつがぞう", "", "", 0, [{
      type: "structured-content", content: paths.flatMap((path) => [
        { tag: "img", path, width: 16, height: 16 },
        { tag: "img", path, width: 16, height: 16 },
      ]),
    }], 1, ""]],
    mediaEntries: paths.map((path) => [path, png]),
  });
  await installMediaArchive(page, archive);
  const worker = await installMediaReplyProbe(browser);
  try {
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdAll = true; });
    await tab.evaluate(() => { document.getElementById("verb").textContent = "並列画像"; });
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await hoverForPopup(tab, popup, "#verb");
    const held = await worker.evaluate(async () => {
      const probe = globalThis.__ownedMediaProbe;
      const deadline = Date.now() + 3000;
      while (probe.held.length < 4) {
        if (Date.now() >= deadline) throw new Error("browser media burst never dispatched four jobs");
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
      }
      return { count: probe.count, active: probe.active, maxActive: probe.maxActive };
    });
    const before = await popup.state();
    check("media cache deduplicates and bounds a real browser image burst",
      before.images.length === 24 && before.images.every((url) => url === "")
        && held.count === 4 && held.active === 4 && held.maxActive === 4,
      JSON.stringify({ images: before.images.length, held }));

    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await worker.evaluate(async () => {
      const probe = globalThis.__ownedMediaProbe;
      probe.holdAll = false;
      for (const release of probe.held.splice(0)) release();
      // Let delivered callbacks settle before a new view can claim queued work.
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
    });
    const afterHide = await worker.evaluate(() => globalThis.__ownedMediaProbe.count);
    await hoverForPopup(tab, popup, "#verb");
    const expected = `data:image/png;base64,${png.toString("base64")}`;
    const deadline = Date.now() + 10_000;
    let restored;
    do {
      restored = await popup.state();
      if (restored?.images.length === 24 && restored.images.every((url) => url === expected)
          && restored.imageStates.every((image) => image.width === 16)) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    } while (Date.now() < deadline);
    const after = await worker.evaluate(() => ({
      count: globalThis.__ownedMediaProbe.count, maxActive: globalThis.__ownedMediaProbe.maxActive,
    }));
    check("obsolete queued images never dispatch while started images stay reusable",
      afterHide === 4 && after.count === 12 && after.maxActive === 4
        && restored.images.length === 24 && restored.images.every((url) => url === expected)
        && restored.imageStates.every((image) => image.width === 16),
      JSON.stringify({ afterHide, after, images: restored.imageStates }));
  } finally {
    await restoreMediaReplyProbe(worker);
  }
}

async function imagePreviewChrome({ browser, page, tab, popup }) {
  const fixture = imagePreviewFixture();
  await installMediaArchive(page, fixture.archive);
  const worker = await installMediaReplyProbe(browser);
  const expected = [...fixture.images, fixture.images[1]];
  async function waitForPreview(predicate, index = 0) {
    const deadline = Date.now() + 6000;
    let state;
    do {
      state = await popup.imagePreview(index);
      if (predicate(state)) return state;
      await new Promise(done => setTimeout(done, 25));
    } while (Date.now() < deadline);
    throw new Error(`Image preview did not reach its expected state: ${JSON.stringify(state)}`);
  }
  try {
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await tab.evaluate(query => { document.getElementById("verb").textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await hoverForPopup(tab, popup, "#verb");
    const decoded = await waitForPreview(state => state?.images.length === expected.length
      && state.images.every((image, index) => image.width === expected[index].width && image.height === expected[index].height));
    const requestCount = () => worker.evaluate(() => globalThis.__ownedMediaProbe.count);
    const initialCount = await requestCount();
    const inline = decoded.sourceRect;
    await tab.mouse.move(inline.left + inline.width / 2, inline.top + inline.height / 2);
    const hovered = await waitForPreview(state => state?.preview?.width === fixture.images[0].width);
    await tab.mouse.move(1, 1);
    const left = await waitForPreview(state => state?.preview === null);
    await popup.imagePreview(0, "focus");
    await tab.keyboard.press("Tab");
    const focused = await waitForPreview(state => state?.focusedImage === 1 && state.preview?.width === fixture.images[1].width, 1);
    const focusRect = focused.sourceRect;
    await tab.mouse.move(focusRect.left + focusRect.width / 2, focusRect.top + focusRect.height / 2);
    await tab.mouse.move(1, 1);
    const focusSurvivedLeave = (await popup.imagePreview(1))?.preview?.source === focused.preview.source;
    await tab.mouse.move(focusRect.left + focusRect.width / 2, focusRect.top + focusRect.height / 2);
    const hoverSurvivedBlur = (await popup.imagePreview(1, "blur"))?.preview?.source === focused.preview.source;
    await tab.mouse.move(1, 1);
    const bothLeftClosed = (await popup.imagePreview(1))?.preview === null;
    await popup.imagePreview(1, "focus");
    const viewport = tab.viewport();
    const fits = ({ rect }) => rect.left >= 8 && rect.top >= 8
      && rect.right <= viewport.width - 8 && rect.bottom <= viewport.height - 8;
    await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const reduced = await waitForPreview(state => state?.preview?.animation === "none", 1);
    if (process.env.HACHIDORI_IMAGE_PREVIEW_SCREENSHOT) {
      mkdirSync(dirname(process.env.HACHIDORI_IMAGE_PREVIEW_SCREENSHOT), { recursive: true });
      await tab.screenshot({ path: process.env.HACHIDORI_IMAGE_PREVIEW_SCREENSHOT });
    }
    check("dictionary AVIF and SVG decode through real WASM without extra preview fetches",
      decoded.images.every((image, index) => image.source === `data:${expected[index].type};base64,${expected[index].bytes.toString("base64")}`)
        && hovered.preview.source === decoded.images[0].source && focused.preview.source === decoded.images[1].source
        && initialCount === 2 && await requestCount() === 2,
      JSON.stringify({ images: decoded.images.map(({ width, height }) => ({ width, height })), initialCount }));
    check("image hover and keyboard previews stay larger, viewport-clamped and motion-aware",
      hovered.preview.rect.width > inline.width && hovered.preview.rect.height > inline.height
        && fits(hovered.preview) && fits(focused.preview) && focused.preview.sibling
        && focused.preview.hiddenFromAccessibility === "true" && focused.preview.pointerEvents === "none"
        && focusSurvivedLeave && hoverSurvivedBlur && bothLeftClosed
        && focused.preview.animation === "gsm-hoshidicts-image-emerge" && reduced.preview.animation === "none"
        && focused.preview.background !== "rgba(0, 0, 0, 0)" && left.preview === null,
      JSON.stringify({ hoverRect: hovered.preview.rect, focusRect: focused.preview.rect, animation: focused.preview.animation,
        focusSurvivedLeave, hoverSurvivedBlur, bothLeftClosed }));

    await popup.imagePreview(1, "blur");
    const blurred = await waitForPreview(state => state?.preview === null);
    await popup.imagePreview(2, "focus");
    // Focusing below the fold causes a native scroll after focus. The preview
    // must survive that event and follow the now-visible keyboard owner.
    await new Promise(done => setTimeout(done, 100));
    const scrolledFocus = await popup.imagePreview(2);
    await popup.imagePreview(2, "blur");
    await popup.imagePreview(2, "mouseenter");
    await popup.imagePreview(2, "scroll");
    const hoverScrollClosed = await waitForPreview(state => state?.preview === null);
    await popup.imagePreview(2, "focus");
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
    // A linked child retains this parent's render/media owner. Use same-level
    // kanji navigation to exercise invalidation while its replacement is held.
    const navigationClicked = await popup.click(".gsm-hoshidicts-kanji-link");
    if (!navigationClicked) throw new Error(`Navigation link disappeared while focusing images: ${JSON.stringify({
      scrolledFocus, hoverScrollClosed, current: await popup.state(),
    })}`);
    await worker.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (globalThis.__ownedMediaProbe.heldLookups.length === 0) {
        if (Date.now() >= deadline) throw new Error("navigation lookup never reached the held reply");
        await new Promise(done => setTimeout(done, 25));
      }
    });
    const pending = await popup.imagePreview(2, "mouseenter");
    check("image previews close on leave, blur, scrolling and pending navigation",
      blurred.preview === null && scrolledFocus.scrollTop > 0 && scrolledFocus.focusedImage === 2
        && scrolledFocus.preview?.source === decoded.images[2].source && fits(scrolledFocus.preview)
        && hoverScrollClosed.images.length === 3 && hoverScrollClosed.preview === null
        && pending.images.length === 3 && pending.preview === null,
      JSON.stringify({ scrolledFocus: { scrollTop: scrolledFocus.scrollTop, focused: scrolledFocus.focusedImage,
        previewRect: scrolledFocus.preview?.rect }, pendingPreview: pending.preview }));
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.heldLookups.splice(0)) release(); });
  } finally {
    await tab.emulateMediaFeatures([]);
    await restoreMediaReplyProbe(worker);
  }
}

async function imageSizingChrome({ page, tab, popup }) {
  const fixture = imageSizingFixture();
  await installMediaArchive(page, fixture.archive);
  await tab.evaluate(query => { document.getElementById("verb").textContent = query; }, fixture.query);
  await tab.bringToFront();
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  await hoverForPopup(tab, popup, "#verb");
  const deadline = Date.now() + 6000;
  let state;
  do {
    state = await popup.imagePreview();
    if (state?.images.length === fixture.cases.length && state.images.every(image => image.width === 16)) break;
    await new Promise(done => setTimeout(done, 25));
  } while (Date.now() < deadline);
  const expectedSource = `data:image/png;base64,${fixture.bytes.toString("base64")}`;
  check("dictionary image sizing preserves ordinary geometry and enforces its existing aspect bound",
    state?.images.length === fixture.cases.length && state.images.every((image, index) => {
      const expected = fixture.cases[index];
      const units = expected.dimensions.sizeUnits === "em" ? "em" : "px";
      const { display } = image;
      const maximumWidth = expected.width * (units === "em" ? display.fontSize : 1);
      return image.source === expectedSource && image.width === 16 && image.height === 16
        && display.inlineWidth.endsWith(units)
        // CSSOM rounds the recovered fractional width to 0.202402px.
        && Math.abs(Number.parseFloat(display.inlineWidth) - expected.width) < 1e-6
        && display.width <= maximumWidth + 1 / 64
        && (index >= 7 || Math.abs(display.width - maximumWidth) <= 1 / 64)
        && Math.abs(display.height - display.width * expected.padding / 100) <= 1 / 32;
    }), JSON.stringify(state?.images.map(({ display }) => display)));
}

async function showSettingsSection(page, id) {
  // Do not foreground the tab here: reader activation tests deliberately keep
  // their popup focused while changing a visible Settings view in another tab.
  await page.$eval(`.settings-nav a[href="#${id}"]`, (link) => link.click());
  await page.waitForFunction((sectionId) => {
    const visible = [...document.querySelectorAll("main > section")].filter((section) => !section.hidden);
    return visible.length === 1 && visible[0].id === sectionId
      && document.querySelector('.settings-nav [aria-current="page"]')?.hash === `#${sectionId}`;
  }, {}, id);
}

async function openDictionaryDetails(page, id) {
  await showSettingsSection(page, "dictionaries");
  const selector = `.dict-row[data-dictionary-id="${id}"] .dict-details`;
  if (!await page.$eval(selector, (details) => details.open)) {
    await page.bringToFront();
    await page.click(`${selector} > summary`);
  }
  await page.waitForFunction((detailsSelector) => document.querySelector(detailsSelector)?.open, {}, selector);
}

async function setDictionaryEnabledInSettings(page, title, enabled) {
  await showSettingsSection(page, "dictionaries");
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
  const id = await page.evaluate(async (dictionaryTitle) =>
    (await chrome.storage.local.get("dictionaryState")).dictionaryState.dictionaries
      .find((entry) => entry.title === dictionaryTitle)?.id, title);
  if (!id) return { error: "dictionary state was missing" };
  await openDictionaryDetails(page, id);
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
    const row = [...document.querySelectorAll(".dict-row")].find((entry) => entry.dataset.dictionaryId === dictionary?.id);
    return dictionaryState?.revision > baseRevision && dictionary?.displayName === nextAlias
      && row?.querySelector(".dict-details").open
      && row.querySelector(".dict-display-name").checkVisibility()
      && row.querySelector(".dict-display-name").value === nextAlias
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
  await page.addScriptTag({ url: new URL("external-links.js", page.url()).href });
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
      await showSettingsSection(target, "lookup");
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

async function checkSettingsTransport(page) {
  await showSettingsSection(page, "lookup");
  const evidence = await page.evaluate(async () => {
    const read = () => chrome.storage.local.get(["options", "dictionaryState"]);
    const status = () => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    const before = await read();
    const generation = (await status()).generation;
    const request = {
      target: "hoshidicts-worker", type: "hd_options_write", requestId: "browser-options-frame",
      baseRevision: before.options?.revision ?? 0, options: { maxResults: "invalid" },
    };
    const malformed = await chrome.runtime.sendMessage(request);
    const oversized = await chrome.runtime.sendMessage({ ...request, options: { maxResults: 48 }, padding: "x".repeat(1024 * 1024) });
    const after = await read();
    return { rejected: malformed.ok === false && oversized.ok === false,
      unchanged: JSON.stringify(before) === JSON.stringify(after), generation,
      revision: before.options?.revision ?? 0, originalMaxResults: before.options?.maxResults ?? 32 };
  });
  const edit = async (value) => {
    await page.$eval("#opt-max-results", (input, next) => {
      input.value = String(next);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    await page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
      { timeout: 10_000, polling: 100 });
  };
  const nextMaxResults = evidence.originalMaxResults === 48 ? 32 : 48;
  await edit(nextMaxResults);
  const saved = await page.evaluate(async () => ({
    options: (await chrome.storage.local.get("options")).options,
    status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
  }));
  await edit(evidence.originalMaxResults);
  check("Settings rejects malformed and oversized option frames before commit and still autosaves without reload",
    evidence.rejected && evidence.unchanged && saved.options.revision === evidence.revision + 1
      && saved.options.maxResults === nextMaxResults && saved.status.generation === evidence.generation,
    JSON.stringify({ evidence, saved }));
}

async function checkManagementAutosave(page, browser, settingsUrl) {
  const mirror = await browser.newPage();
  const groupId = "browser-autosave-group";
  const groupInput = `[data-group-id="${groupId}"] .dict-group-name`;
  const edit = (target, selector, values, event = "input") => target.evaluate((selector, values, event) => {
    const input = document.querySelector(selector);
    for (const value of values) {
      input.value = value;
      input.dispatchEvent(new Event(event, { bubbles: true }));
    }
  }, selector, values, event);
  const mutateGroup = (target, patch) => target.evaluate(async (id, patch) => {
    const { dictionaryState: state } = await chrome.storage.local.get("dictionaryState");
    const groups = state.groups.some(group => group.id === id)
      ? state.groups.map(group => group.id === id ? { ...group, ...patch } : group)
      : [...state.groups, { id, name: "Study", dictionaryIds: [], ...patch }];
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: state.revision, dictionaries: state.dictionaries, groups });
    if (!reply.ok) throw new Error(reply.error);
  }, groupId, patch);
  const waitName = (name) => page.waitForFunction(async (id, name) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return dictionaryState.groups.find(group => group.id === id)?.name === name;
  }, { polling: 50 }, groupId, name);
  try {
    await mirror.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await mirror.waitForFunction(() => document.getElementById("engine-status").textContent.startsWith("Ready"), { polling: 100 });
    for (const target of [page, mirror]) await showSettingsSection(target, "updates");
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const probe = { calls: [], hold: true, lose: false, type: "hd_updates_schedule", release: null,
        restore: () => { chrome.runtime.sendMessage = original; } };
      window.__managementAutosave = probe;
      chrome.runtime.sendMessage = async message => {
        if (message.type !== probe.type) return original(message);
        probe.calls.push(message);
        const reply = await original(message);
        if (probe.hold) {
          probe.hold = false;
          await new Promise(done => { probe.release = done; });
        }
        if (probe.lose) { probe.lose = false; throw new Error("simulated lost Settings reply"); }
        return reply;
      };
    });
    await edit(page, "#update-schedule", ["off", "hourly", "daily"], "change");
    await page.waitForFunction(() => typeof window.__managementAutosave.release === "function", { polling: 50 });
    await edit(page, "#update-schedule", ["monthly"], "change");
    await mirror.waitForFunction(() => document.getElementById("update-schedule").value === "daily", { polling: 50 });
    await edit(mirror, "#update-schedule", ["weekly"], "change");
    await mirror.waitForFunction(() => document.getElementById("update-state").textContent === "Schedule saved.", { polling: 50 });
    const whileHeld = await page.evaluate(() => window.__managementAutosave.calls.length);
    await page.evaluate(() => window.__managementAutosave.release());
    await page.waitForFunction(() => !document.getElementById("update-schedule-conflict-actions").hidden, { polling: 50 });
    const schedule = await page.evaluate(async () => ({
      draft: document.getElementById("update-schedule").value,
      stored: (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates,
      calls: window.__managementAutosave.calls,
    }));
    await page.bringToFront();
    await page.click("#update-schedule-discard");
    await page.evaluate(() => { window.__managementAutosave.lose = true; });
    await edit(page, "#update-schedule", ["off"], "change");
    await page.waitForFunction(() => !document.getElementById("update-schedule-conflict-actions").hidden, { polling: 50 });
    const lostRevision = await page.evaluate(async () => (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates.revision);
    await page.click("#update-schedule-retry");
    await page.waitForFunction(() => document.getElementById("update-state").textContent === "Schedule saved.", { polling: 50 });
    const retried = await page.evaluate(async () => ({
      stored: (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates,
      alarms: await chrome.alarms.getAll(), calls: window.__managementAutosave.calls.length,
    }));
    check("Settings schedule drafts preserve newer commits and retry lost replies without duplicate writes or alarms",
      whileHeld === 1 && schedule.calls.length === 2 && schedule.draft === "monthly"
        && schedule.stored.schedule === "weekly"
        && schedule.calls[1].baseRevision === schedule.calls[0].baseRevision + 1
        && retried.stored.revision === lostRevision && retried.stored.schedule === "off"
        && retried.calls === 4 && retried.alarms.length === 0,
      JSON.stringify({ whileHeld, schedule, lostRevision, retried }));

    await mutateGroup(page, {});
    for (const target of [page, mirror]) {
      await showSettingsSection(target, "dictionary-groups");
      await target.waitForSelector(groupInput);
    }
    await page.evaluate(() => {
      Object.assign(window.__managementAutosave, { type: "hd_state_cas", calls: [], release: null });
    });
    await page.focus(groupInput);
    await edit(page, groupInput, ["P", "Personal"]);
    await mutateGroup(mirror, { dictionaryIds: [FIXTURE_ID] });
    await waitName("Personal");
    const coalesced = await page.evaluate(selector => ({
      calls: window.__managementAutosave.calls.length,
      focused: document.activeElement === document.querySelector(selector),
    }), groupInput);
    await page.evaluate(() => { window.__managementAutosave.hold = true; });
    await edit(page, groupInput, ["Mine"], "change");
    await page.waitForFunction(() => typeof window.__managementAutosave.release === "function", { polling: 50 });
    await edit(page, groupInput, ["Next"]);
    await mirror.waitForFunction(selector => document.querySelector(selector).value === "Mine", { polling: 50 }, groupInput);
    await edit(mirror, groupInput, ["Shared"]);
    await waitName("Shared");
    await page.evaluate(() => window.__managementAutosave.release());
    await page.waitForSelector(`${groupInput}[aria-invalid="true"]`);
    const names = await page.evaluate(async (id, selector) => ({
      stored: (await chrome.storage.local.get("dictionaryState")).dictionaryState.groups.find(group => group.id === id),
      draft: document.querySelector(selector).value,
      calls: window.__managementAutosave.calls.length,
    }), groupId, groupInput);
    if (process.env.HACHIDORI_AUTOSAVE_SCREENSHOT) {
      await page.bringToFront();
      await page.setViewport({ width: 1080, height: 900 });
      await (await page.$("#dictionary-groups")).screenshot({ path: process.env.HACHIDORI_AUTOSAVE_SCREENSHOT });
    }
    await page.evaluate(() => {
      const probe = window.__managementAutosave;
      probe.renders = 0;
      probe.observer = new MutationObserver(records => {
        probe.renders += records.filter(record => record.target.id === "dict-group-list" && record.removedNodes.length > 0).length;
      });
      probe.observer.observe(document.getElementById("dict-group-list"), { childList: true });
    });
    await page.click(`[data-group-id="${groupId}"] .name-draft-retry`);
    await waitName("Next");
    await page.waitForFunction(() => !document.querySelector(".name-draft-feedback"), { polling: 50 });
    await page.waitForFunction(() => window.__managementAutosave.renders > 0, { polling: 50 });
    const renders = await page.evaluate(() => window.__managementAutosave.renders);
    check("Settings name autosave merges unrelated edits, rejects external renames and paints one completion",
      coalesced.calls === 1 && coalesced.focused && names.calls === 2 && names.draft === "Next"
        && names.stored.name === "Shared" && names.stored.dictionaryIds.join(",") === FIXTURE_ID && renders === 1,
      JSON.stringify({ coalesced, names, renders }));
  } finally {
    await page.evaluate(async id => {
      window.__managementAutosave?.release?.();
      window.__managementAutosave?.observer?.disconnect();
      window.__managementAutosave?.restore();
      delete window.__managementAutosave;
      const { dictionaryState: state } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: state.revision, dictionaries: state.dictionaries, groups: state.groups.filter(group => group.id !== id) });
      if (!reply.ok) throw new Error(reply.error);
    }, groupId);
    await mirror.close();
    await showSettingsSection(page, "updates");
  }
}

function makeAudioWav() {
  // A genuine one-second PCM clip, decoded and completed by native Chrome.
  const samples = 8000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(i % 2 ? 100 : -100, 44 + i * 2);
  return wav;
}

async function checkPopupAudio(settings, tab, popup, browser) {
  const original = await settings.evaluate(async () => ({
    options: (await chrome.storage.local.get("options")).options,
    status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
  }));
  const write = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const source = (id, type, url, enabled = true) => ({ id, type, url, enabled, voice: "" });
  const base = "https://audio.example.test/popup-";
  const routes = new Map();
  const route = (path, body, contentType = "application/json", status = 200) =>
    routes.set(base + path, { body, contentType, status, requests: 0 });
  route("failure", "Unavailable", "text/plain", 503);
  route("disabled", "Must not request", "text/plain", 503);
  route("bad.wav", "not audio", "audio/wav");
  route("tokyo.wav", makeAudioWav(), "audio/wav");
  route("osaka.wav", makeAudioWav(), "audio/wav");
  route("list", JSON.stringify({ type: "audioSourceList", audioSources: [
    { url: base + "bad.wav", name: "Unplayable" }, { url: base + "tokyo.wav", name: "Tokyo" },
    { url: base + "osaka.wav", name: "Osaka" },
  ] }));
  const sources = [source("disabled", "custom", base + "disabled", false),
    source("failure", "custom", base + "failure"), source("json", "custom-json", base + "list")];
  const target = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
  const session = await interceptFetches(target, routes, "popup-audio");
  const native = await target.createCDPSession();
  const evaluate = async expression => {
    const reply = await native.send("Runtime.evaluate", { expression, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  await evaluate(`globalThis.__e20NativeAudio = Audio; globalThis.__e20Audio = [];
    globalThis.Audio = function (...args) { const audio = new __e20NativeAudio(...args); __e20Audio.push(audio); return audio; };`);
  const count = () => [...routes.values()].reduce((sum, route) => sum + route.requests, 0);
  async function until(predicate) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await popup.audio();
      if (predicate(state)) return state;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Popup audio state timed out: ${JSON.stringify(await popup.audio())}`);
  }
  const completed = () => until(state => state?.button === "Audio" && state.feedback[0].startsWith("Played"));
  const rehover = async () => {
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
  };
  try {
    await write({ audioSources: sources, audioAutoplay: false });
    await rehover();
    const silent = count() === 0;
    await popup.audio("play");
    const played = await completed();
    check("Popup audio is silent by default and manually falls back through enabled sources and playable candidates",
      silent && played.feedback[0] === "Played — Tokyo." && routes.get(base + "disabled").requests === 0
        && routes.get(base + "failure").requests === 1 && routes.get(base + "bad.wav").requests === 1,
      JSON.stringify({ silent, played, requests: [...routes].map(([url, route]) => [url, route.requests]) }));

    await popup.audio("choose");
    const choices = await until(state => state?.choices.length === 4);
    if (process.env.HACHIDORI_AUDIO_POPUP_SCREENSHOT) {
      const { x, y, width, height } = choices.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_AUDIO_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    await tab.keyboard.press("Escape");
    const escaped = await popup.audio();
    await popup.audio("choose");
    await until(state => state?.choices.length === 4);
    const candidate = await popup.audio("candidate", 3);
    await tab.mouse.click(candidate.candidatePoint.x, candidate.candidatePoint.y);
    const chosen = await completed();
    const beforeWarm = count();
    await popup.audio("play");
    const warm = await completed();
    const media = await evaluate("__e20Audio.map(audio => ({ ended: audio.ended, source: audio.getAttribute('src'), paused: audio.paused }))");
    check("Popup pronunciation choices preserve source identity and warm replay reuses native cached media",
      choices.menuFits && choices.choices.join(",") === "Pronunciation 1,Unplayable,Tokyo,Osaka" && !escaped.menu
        && escaped.focused === "gsm-hoshidicts-audio-button" && chosen.feedback[0] === "Played — Osaka."
        && warm.feedback[0] === chosen.feedback[0] && count() === beforeWarm && media.length === 4
        && media.every(item => item.paused && item.source === null), JSON.stringify({ choices, escaped, chosen, warm, media }));

    await write({ audioSources: [source("auto", "custom", base + "tokyo.wav")], audioAutoplay: true });
    await rehover();
    await completed();
    const beforeEcho = await evaluate("__e20Audio.length");
    await write({ popupTheme: "light" });
    await popup.click(".gsm-hoshidicts-kanji-link");
    await until(state => state?.text.includes(GENERIC_KANJI_GLOSSARY));
    await completed();
    const beforeBack = await evaluate("__e20Audio.length");
    await popup.click(".gsm-hoshidicts-kanji-back");
    await until(state => state?.text.includes("to eat"));
    const afterBack = await evaluate("__e20Audio.length");
    check("Popup autoplay is optional and does not replay after presentation updates or Back",
      beforeBack === beforeEcho + 1 && afterBack === beforeBack, JSON.stringify({ beforeEcho, beforeBack, afterBack }));

    await write({ audioAutoplay: false, audioSources: [source("pending", "custom", base + "pending")] });
    const hold = await target.createCDPSession();
    let held;
    hold.on("Fetch.requestPaused", event => { held = event.requestId; });
    await hold.send("Fetch.enable", { patterns: [{ urlPattern: base + "pending", requestStage: "Request" }] });
    await popup.audio("play");
    const holdDeadline = Date.now() + 5000;
    while (!held && Date.now() < holdDeadline) await new Promise(done => setTimeout(done, 20));
    if (!held) throw new Error("Popup pronunciation did not start its pending fetch");
    await tab.keyboard.press("Escape");
    await hold.send("Fetch.failRequest", { requestId: held, errorReason: "Aborted" }).catch(() => {});
    await hold.detach();
    const dismissed = !await popup.visible();
    await write({ audioSources: [source("current", "custom", base + "tokyo.wav")] });
    await rehover();
    await popup.audio("play");
    await until(state => state?.feedback[0].startsWith("Playing"));
    await write({ audioSources: [] });
    await until(state => state?.feedback[0] === "Stopped.");
    const changed = await evaluate("__e20Audio.at(-1).paused && __e20Audio.at(-1).getAttribute('src') === null");
    await write({ audioSources: [source("current", "custom", base + "tokyo.wav")] });
    await popup.audio("play");
    await until(state => state?.feedback[0].startsWith("Playing"));
    await tab.reload({ waitUntil: "load" });
    const navigated = await evaluate("__e20Audio.at(-1).paused && __e20Audio.at(-1).getAttribute('src') === null");
    const status = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
    check("Popup audio cancels obsolete discovery and playback on dismissal, source changes and navigation",
      dismissed && changed && navigated && status.generation === original.status.generation,
      JSON.stringify({ dismissed, changed, navigated, status }));
  } finally {
    await evaluate("globalThis.Audio = __e20NativeAudio; delete globalThis.__e20NativeAudio; delete globalThis.__e20Audio");
    await native.detach();
    await session.detach();
    await write({ audioSources: original.options.audioSources, audioAutoplay: original.options.audioAutoplay ?? false,
      popupTheme: original.options.popupTheme });
    await tab.keyboard.press("Escape");
  }
}

async function checkAudioSettings(page, browser) {
  await showSettingsSection(page, "audio");
  const original = await page.evaluate(async () => ({
    options: (await chrome.storage.local.get("options")).options,
    status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
    context: (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))[0].documentId,
  }));
  const saved = () => page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
  const input = async (selector, value, event = "input") => {
    await page.$eval(selector, (field, next, kind) => {
      field.focus();
      if (field.type === "checkbox") field.checked = next;
      else field.value = next;
      field.dispatchEvent(new Event(kind, { bubbles: true }));
      field.blur();
    }, value, event);
    await saved();
  };
  const customRow = ".audio-source-row:first-child";
  const click = async selector => { await page.$eval(selector, button => button.click()); await saved(); };
  const routes = new Map();
  const route = (path, body, contentType = "application/json", status = 200) => {
    routes.set(`https://audio.example.test/${path}`, { body, contentType, status, requests: 0 });
  };
  route("valid.wav", makeAudioWav(), "audio/wav");
  route("invalid.wav", "not audio", "audio/wav");
  route("list?term=%E8%81%9E%E3%81%8F&reading=%E3%81%8D%E3%81%8F&lang=ja", JSON.stringify({
    type: "audioSourceList", audioSources: [
      { url: "https://audio.example.test/invalid.wav", name: "Unplayable" },
      { url: "https://audio.example.test/valid.wav", name: "Playable" },
    ],
  }));
  route("empty", JSON.stringify({ type: "audioSourceList", audioSources: [] }));
  route("failure", "Unavailable", "text/plain", 503);
  const target = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
  const session = await interceptFetches(target, routes, "audio");
  try {
    const defaults = await page.$eval(".audio-source-row", row =>
      row.querySelector(".audio-type").value === "text-to-speech-reading" && row.querySelector(".audio-enabled").checked);
    await click("#audio-source-add");
    await click(".audio-source-row:last-child .audio-up");
    await input(`${customRow} .audio-type`, "custom-json", "change");
    const template = "https://audio.example.test/list?term={term}&reading={reading}&lang={language}";
    await input(`${customRow} .audio-url`, template);
    await input(`${customRow} .audio-enabled`, false, "change");
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".audio-source-row").length === 2);
    const retained = await page.evaluate(() => [...document.querySelectorAll(".audio-source-row")].map(row => ({
      type: row.querySelector(".audio-type").value, enabled: row.querySelector(".audio-enabled").checked,
      url: row.querySelector(".audio-url").value,
    })));
    check("Audio Settings preserve ordered source edits and disabled rows through revisioned save and reload",
      defaults && retained[0].url === template && !retained[0].enabled && retained[1].enabled
        && retained[1].type === "text-to-speech-reading", JSON.stringify(retained));
    async function testRow() {
      await page.$eval(`${customRow} .audio-test`, button => button.click());
      await page.waitForFunction(() => document.querySelector(".audio-test").textContent === "Test", { timeout: 20_000 });
      return page.$eval(`${customRow} .audio-test-status`, output => output.textContent);
    }
    const success = await testRow();
    await input(`${customRow} .audio-url`, "https://audio.example.test/empty");
    const obsoleteCleared = await page.$eval(`${customRow} .audio-test-status`, output => output.textContent === "");
    const empty = await testRow();
    await input(`${customRow} .audio-url`, "https://audio.example.test/failure");
    const failure = await testRow();
    check("Audio source Tests use encoded URLs and ordered JSON candidates with visible success, no-result and error feedback",
      obsoleteCleared && success === "Played 聞く / きく — Playable." && empty === "No pronunciation was returned."
        && failure.includes("503") && [...routes.values()].every(route => route.requests === 1),
      JSON.stringify({ success, empty, failure, requests: [...routes].map(([url, route]) => [url, route.requests]) }));
    await input(`${customRow} .audio-url`, template);
    if (process.env.HACHIDORI_AUDIO_SCREENSHOT) {
      await page.setViewport({ width: 1200, height: 1100 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: process.env.HACHIDORI_AUDIO_SCREENSHOT, fullPage: true });
    }
    // Hold a real request at the offscreen target, then stop and release it.
    let held;
    const hold = await target.createCDPSession();
    hold.on("Fetch.requestPaused", event => { held = event.requestId; });
    await hold.send("Fetch.enable", { patterns: [{ urlPattern: "https://audio.example.test/pending", requestStage: "Request" }] });
    await input(`${customRow} .audio-url`, "https://audio.example.test/pending");
    await page.$eval(`${customRow} .audio-test`, button => button.click());
    const deadline = Date.now() + 5000;
    while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!held) throw new Error("Audio Test did not reach the offscreen fetch");
    await page.$eval(`${customRow} .audio-test`, button => button.click());
    await hold.send("Fetch.failRequest", { requestId: held, errorReason: "Aborted" }).catch(() => {});
    await hold.detach();
    const stopped = await page.$eval(`${customRow} .audio-test-status`, output => output.textContent);
    const idleSince = Date.now();
    await page.waitForFunction(start => Date.now() - start > 31_000, { polling: 1000, timeout: 35_000 }, idleSince);
    const after = await page.evaluate(async () => ({
      status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
      context: (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))[0].documentId,
      feedback: document.querySelector(".audio-test-status").textContent,
    }));
    check("Audio Tests cancel stale playback and preserve the dictionary engine after audio becomes idle",
      stopped === "Stopped." && after.feedback === stopped && after.status.ready
        && after.status.generation === original.status.generation && after.context === original.context, JSON.stringify(after));
  } finally {
    await session.detach();
    await page.evaluate(async sources => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        requestId: "restore-audio", baseRevision: options.revision, options: { audioSources: sources } });
      if (!reply.ok) throw new Error(reply.error);
    }, original.options?.audioSources ?? [{ id: "default-tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" }]);
  }
}

async function checkAnkiSubmission(settings, browser, tab, popup) {
  const original = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const notes = new Map(), calls = [], files = new Map();
  const apiRoute = { requests: 0, async respond(request) {
    const { action, params } = JSON.parse(request.postData);
    calls.push({ action, params });
    let result;
    if (action === "deckNames") result = ["Default"];
    else if (action === "modelNames") result = ["Basic"];
    else if (action === "modelFieldNames") result = ["Front", "Back", "Audio"];
    else if (action === "canAddNotesWithErrorDetail") result = params.notes.map(note => {
      const duplicate = [...notes.values()].some(fields => fields.Front === note.fields.Front);
      return { canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null };
    });
    else if (action === "addNote") { result = notes.size + 1; notes.set(result, params.note.fields); }
    else if (action === "notesInfo") result = params.notes.map(noteId => ({ noteId,
      fields: Object.fromEntries(Object.entries(notes.get(noteId)).map(([field, value]) => [field, { value }])) }));
    else if (action === "updateNoteFields") { notes.set(params.note.id, { ...notes.get(params.note.id), ...params.note.fields }); result = null; }
    else if (action === "storeMediaFile") { files.set(params.filename, params.data); result = params.filename; }
    else if (action === "guiBrowse") result = [...notes.keys()];
    else throw new Error(`Unexpected Anki action ${action}`);
    return { body: JSON.stringify({ result, error: null }), status: 200, contentType: "application/json" };
  } };
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const api = await interceptFetches(worker, new Map([["http://127.0.0.1:8765/", apiRoute]]), "anki-submission");
  const source = { id: "anki-json", type: "custom-json", url: "https://audio.example.test/anki-list", enabled: true, voice: "" };
  const chosen = { url: "https://audio.example.test/anki-chosen.wav", name: "Chosen recording" };
  const other = { url: "https://audio.example.test/anki-other.wav", name: "Other recording" };
  const wav = makeAudioWav();
  const routes = new Map([
    [source.url, { body: JSON.stringify({ type: "audioSourceList", audioSources: [other, chosen] }), contentType: "application/json", status: 200, requests: 0 }],
    [chosen.url, { body: wav, contentType: "audio/wav", status: 200, requests: 0 }],
    [other.url, { body: "must not download", contentType: "audio/wav", status: 200, requests: 0 }],
  ]);
  const target = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
  const media = await interceptFetches(target, routes, "anki-audio");
  const native = await target.createCDPSession();
  await native.send("Runtime.evaluate", { expression: `globalThis.__ankiNativePlay = Audio.prototype.play; globalThis.__ankiPlayCount = 0;
    Audio.prototype.play = function (...args) { globalThis.__ankiPlayCount++; return __ankiNativePlay.apply(this, args); };` });
  const configure = (audio, anki = {}) => settings.evaluate(async ({ audio, source, anki }) => {
    const { options } = await chrome.storage.local.get("options");
    const template = value => ({ value, overwriteMode: "overwrite" });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
      options: { audioSources: [source], audioAutoplay: false, anki: { ...HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
        fieldTemplates: { Front: template(audio ? "{expression}{audio}" : "{expression}"), Back: template("{glossary}"), Audio: template(audio ? "{audio}" : "") }, ...anki } } });
    if (!reply.ok) throw new Error(reply.error);
  }, { audio, source, anki });
  const operation = (type, request) => settings.evaluate(async ({ type, request }) => {
    const reply = await chrome.runtime.sendMessage({ target: "hachidori-anki", type, requestId: "anki-browser-test", request });
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  }, { type, request });
  try {
    await configure(false);
    const request = await settings.evaluate(async () => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "漢字", maxResults: 4 });
      if (!reply.ok || !reply.results.length) throw new Error(reply.error || "No Anki fixture result");
      return { ...reply.results[0], generation: reply.generation, sentence: "漢字。", matched: "漢字", matchOffset: 0,
        popupSelectionText: "", searchQuery: "漢字", documentTitle: "Anki browser test", dictionaryAliases: {}, frequencyDictionaries: [] };
    });
    request.configKey = (await operation("hd_anki_status")).configKey;
    const before = await operation("hd_anki_preflight", request);
    const readOnly = !calls.some(call => ["addNote", "updateNoteFields", "storeMediaFile"].includes(call.action));
    const added = await operation("hd_anki_submit", request);
    const duplicate = await operation("hd_anki_preflight", request);
    const note = notes.get(added.noteId);
    const images = [...note.Back.matchAll(/<img[^>]+src="([^"]+)"/gu)].map(match => match[1]);
    check("Anki worker preflight is read-only and submission verifies a real-WASM result with scoped dictionary media",
      before.canAdd && readOnly && added.state === "added" && added.warnings.length === 0 && duplicate.state === "duplicate" && !duplicate.canAdd
        && images.length > 0 && images.every(filename => files.has(filename)) && note.Back.includes("@scope")
        && calls.filter(call => call.action === "addNote").length === 1 && [...routes.values()].every(route => route.requests === 0),
      JSON.stringify({ before, readOnly, added, duplicate, images, actions: calls.map(call => call.action) }));

    await configure(true);
    request.configKey = (await operation("hd_anki_status")).configKey;
    const choices = await settings.evaluate(async term => {
      const reply = await chrome.runtime.sendMessage({ target: "hachidori-audio", type: "hd_audio_candidates", term });
      if (!reply.ok) throw new Error(reply.error);
      return reply.groups;
    }, { expression: request.term.expression, reading: request.term.reading });
    request.audioSelection = { sourceId: source.id, sourceKey: choices[0].sourceKey, expression: request.term.expression,
      reading: request.term.reading, index: 1, ...chosen };
    const uploadsBefore = calls.filter(call => call.action === "storeMediaFile").length;
    await operation("hd_anki_preflight", request);
    const checked = calls.filter(call => call.action === "canAddNotesWithErrorDetail").at(-1).params.notes[0].fields.Front;
    const noUpload = calls.filter(call => call.action === "storeMediaFile").length === uploadsBefore;
    const withAudio = await operation("hd_anki_submit", request);
    const filename = /\[sound:([^\]]+)\]/u.exec(checked)?.[1];
    const playCount = (await native.send("Runtime.evaluate", { expression: "globalThis.__ankiPlayCount", returnByValue: true })).result.value;
    check("Anki first-field audio is checked without uploads or playback and the exact chosen recording survives submission",
      noUpload && withAudio.state === "added" && withAudio.warnings.length === 0 && notes.get(withAudio.noteId).Front === checked
        && files.get(filename) === wav.toString("base64") && routes.get(chosen.url).requests === 1
        && routes.get(other.url).requests === 0 && playCount === 0,
      JSON.stringify({ noUpload, withAudio, checked, filename, playCount, requests: [...routes].map(([url, route]) => [url, route.requests]) }));
    await checkAnkiReader(tab, popup, configure, calls, notes);
  } finally {
    await settings.evaluate(async original => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
        options: { anki: original.anki, audioSources: original.audioSources, audioAutoplay: original.audioAutoplay } });
      if (!reply.ok) throw new Error(reply.error);
    }, original);
    await native.send("Runtime.evaluate", { expression: "Audio.prototype.play = __ankiNativePlay; delete globalThis.__ankiNativePlay; delete globalThis.__ankiPlayCount;" });
    await native.detach();
    await media.detach();
    await api.detach();
  }
}

async function checkAnkiReader(tab, popup, configure, calls, notes) {
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  async function settled(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await popup.anki();
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Anki reader did not settle: ${JSON.stringify(await popup.anki())}`);
  }
  try {
    await configure(false, { model: "" });
    await tab.$eval("#verb", element => { element.innerHTML = "<ruby>食<rt>た</rt></ruby>べる。"; });
    const before = calls.length;
    await hoverForPopup(tab, popup, "#verb");
    const quiet = (await popup.anki()).controls.length === 0 && calls.length === before;
    const template = value => ({ value, overwriteMode: "overwrite" });
    await configure(false, { fieldTemplates: { Front: template("{expression}"),
      Back: template("{cloze-body}|{cloze-suffix}|{sentence}"), Audio: template("") } });
    const ready = await settled(state => state?.controls.some(control => !control.hidden && !control.disabled));
    const addCount = calls.filter(call => call.action === "addNote").length;
    const rect = ready.controls[0].rect;
    await tab.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { clickCount: 2 });
    const saved = await settled(state => state?.controls.some(control => control.state === "success"));
    await popup.click(".gsm-hoshidicts-mine-button");
    const browseCount = calls.filter(call => call.action === "guiBrowse").length;
    await popup.click(".gsm-hoshidicts-anki-view");
    await settled(state => calls.filter(call => call.action === "guiBrowse").length > browseCount && !state.controls[0].viewDisabled);
    const note = [...notes.values()].at(-1);
    const browse = calls.filter(call => call.action === "guiBrowse").at(-1);
    check("Anki reader controls stay absent until configured and preserve raw ruby context through one confirmed Add and View",
      quiet && saved.controls[0].disabled && note.Front === "食べる"
        && note.Back === "食たべる|。|<b>食たべる</b>。"
        && calls.filter(call => call.action === "addNote").length === addCount + 1 && browse.params.query === '"食べる"',
      JSON.stringify({ quiet, saved, note, browse }));
    if (process.env.HACHIDORI_ANKI_POPUP_SCREENSHOT) {
      const { x, y, width, height } = (await popup.anki()).rect;
      await tab.screenshot({ path: process.env.HACHIDORI_ANKI_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
  } finally {
    await tab.keyboard.press("Escape");
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
  }
}

async function checkAnkiGlossaryExport(page) {
  const imageRequests = [];
  const observe = request => { if (request.url().includes("hd-anki-inert-image.png")) imageRequests.push(request.url()); };
  page.on("request", observe);
  try {
    const result = await page.evaluate(async () => {
      const { createAnkiDefinitionRenderer } = await import("./anki-glossary.js");
      const dictionary = "Anki <Dictionary>";
      const source = { term: { rules: "", glossaries: [{ dictionary, glossary: JSON.stringify([
        { type: "structured-content", content: [
          { tag: "strong", content: "Scoped definition" },
          { tag: "img", path: "image.png", width: 200, height: 100, preferredWidth: 400 },
          { tag: "img", path: "image.png", width: 200, height: 100, preferredHeight: 200 },
        ] },
      ]) }] }, trace: [], dictionaryAliases: {}, generation: 1,
      dictionaryMedia: [{ dictionary, path: "image.png", filename: "hd-anki-inert-image.png" }],
      dictionaryStyles: [{ dictionary, styles: '.gloss-sc-strong { color: rgb(17, 34, 51) } .gloss-sc-strong::before { content: "</style><img src=x onerror=alert(1)>" }' }] };
      const html = await createAnkiDefinitionRenderer(document, source)({});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const inert = document.implementation.createHTMLDocument("");
      inert.body.innerHTML = html;
      const images = [...inert.querySelectorAll("img")];
      const safe = images.length === 2 && !inert.querySelector("[onerror], script")
        && images.every(image => image.getAttribute("src") === "hd-anki-inert-image.png");
      if (!safe) return { safe, html };
      // Only now mount a copy, replacing planned Anki filenames with a local
      // image so layout is measured without fetching the exported media.
      for (const image of images) image.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>');
      const holder = document.createElement("div");
      holder.style.cssText = "width: 1000px; color: rgb(0, 0, 0);";
      holder.append(...inert.body.childNodes);
      const outside = document.createElement("strong");
      outside.className = "gloss-sc-strong";
      outside.textContent = "Outside glossary";
      holder.append(outside);
      document.body.append(holder);
      try {
        await Promise.all(images.map(image => image.decode()));
        const color = getComputedStyle(holder.querySelector(".gsm-hoshidicts-glossary-content strong")).color;
        const outsideColor = getComputedStyle(outside).color;
        const sizes = images.map(image => { const rect = image.getBoundingClientRect(); return [rect.width, rect.height]; });
        return { safe, color, outsideColor, sizes, style: holder.querySelector("style").textContent };
      } finally { holder.remove(); }
    });
    check("Anki glossary export preserves native scoped styles and image proportions without loading media or allowing CSS markup escape",
      result.safe && result.color === "rgb(17, 34, 51)" && result.outsideColor === "rgb(0, 0, 0)"
        && result.sizes.every(([width, height]) => width === 400 && height === 200)
        && imageRequests.length === 0, JSON.stringify({ ...result, imageRequests }));
  } finally { page.off("request", observe); }
}

async function checkStartupPractice(startup, browser, startupUrl) {
  await startup.bringToFront();
  await startup.waitForSelector("#setup-practice-lookup:not([disabled])");
  const popup = await popupReader(startup);
  await startup.focus("#setup-heading");
  // Reach the real control through the page's tab order, then activate it with
  // Enter. The control selects prose; only the ordinary reader sends the lookup.
  let keyboardReached = false;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await startup.keyboard.press("Tab");
    keyboardReached = await startup.evaluate(() => document.activeElement?.id === "setup-practice-lookup");
    if (keyboardReached) break;
  }
  if (!keyboardReached) throw new Error("The practice lookup control was not reachable through the tab order.");
  await startup.keyboard.press("Enter");
  const selected = await popup.waitForVisible();
  if (process.env.HACHIDORI_STARTUP_LOOKUP_SCREENSHOT) {
    await startup.screenshot({ path: process.env.HACHIDORI_STARTUP_LOOKUP_SCREENSHOT });
  }
  const originalOpacity = await startup.evaluate(async () => {
    window.__practiceScene = document.getElementById("setup-practice-scene");
    window.__practiceRender = { events: 0, detached: false };
    window.__practiceObserver = new MutationObserver(records => {
      window.__practiceRender.events += records.length;
      for (const record of records) {
        if ([...record.removedNodes].some(node => node.contains(window.__practiceScene))) window.__practiceRender.detached = true;
      }
    });
    window.__practiceObserver.observe(document.getElementById("setup-body"), { childList: true });
    const { options } = await chrome.storage.local.get("options");
    const opacity = options.popupOpacityPercent ?? 85;
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { popupOpacityPercent: opacity === 85 ? 90 : 85 } });
    if (!reply.ok) throw new Error(reply.error);
    return opacity;
  });
  await startup.waitForFunction(() => window.__practiceRender.events > 0);
  const source = await startup.evaluate(() => ({
    selected: getSelection().toString(),
    text: document.getElementById("setup-practice-text")?.textContent,
    sameScene: document.getElementById("setup-practice-scene") === window.__practiceScene,
    detached: window.__practiceRender.detached,
    readerScripts: [...document.scripts].filter(script => script.src.endsWith("/content.js")).length,
    finish: document.getElementById("setup-finish")?.disabled === false,
    settings: document.querySelector('a[href="settings.html"]') !== null,
  }));
  await startup.keyboard.press("Escape");
  const escaped = await popup.waitForHidden();
  await startup.evaluate(() => getSelection().removeAllRanges());
  const hovered = await hoverForPopup(startup, popup, "#setup-practice-word");
  const genuine = state => state?.plain.includes("辞書")
    && state.text.includes(`${RECOMMENDED_DICTIONARIES[0].title} term fixture`);
  check("startup practice uses the installed dictionaries through keyboard selection and the ordinary reader",
    keyboardReached && genuine(selected) && genuine(hovered) && escaped
      && source.selected === "辞書" && source.text.includes("辞書") && source.sameScene && !source.detached
      && source.readerScripts === 1 && source.finish && source.settings,
    JSON.stringify({ keyboardReached, selected, hovered, source, escaped }));
  await startup.keyboard.press("Escape");
  await startup.mouse.move(2, 2);
  await startup.evaluate(async popupOpacityPercent => {
    window.__practiceObserver.disconnect();
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { popupOpacityPercent } });
    if (!reply.ok) throw new Error(reply.error);
  }, originalOpacity);

  // These pages do not normally load content.js. Inject the production script
  // list explicitly so this checks its URL boundary, not just missing scripts.
  const scriptPaths = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).content_scripts[0].js;
  const restricted = [];
  for (const relative of ["settings.html", "design-preview.html", "startup.html?reader-boundary"]) {
    const internal = await browser.newPage();
    try {
      await internal.goto(new URL(relative, startupUrl).href, { waitUntil: "networkidle0" });
      await internal.evaluate(() => {
        window.__practiceLookupRequests = 0;
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = function (...args) {
          if (args[0]?.type === "hd_lookup") window.__practiceLookupRequests += 1;
          return send.apply(this, args);
        };
      });
      for (const script of scriptPaths) await internal.addScriptTag({ url: new URL(script, startupUrl).href });
      await internal.evaluate(() => {
        const prose = document.createElement("p");
        prose.textContent = "辞書";
        document.body.append(prose);
        getSelection().selectAllChildren(prose);
      });
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
      restricted.push(await internal.evaluate(() => ({
        url: location.href,
        requests: window.__practiceLookupRequests,
        hosts: document.querySelectorAll("hachidori-host").length,
        scripts: [...document.scripts].filter(script => script.src.endsWith("/content.js")).length,
      })));
    } finally { await internal.close(); }
  }
  check("the startup reader exception keeps Settings and the static preview excluded",
    restricted.length === 3 && restricted.every(result => result.requests === 0 && result.hosts === 0 && result.scripts >= 1),
    JSON.stringify(restricted));
}

// Run last: Chrome reloads the extension when its native file switch changes,
// closing every extension page and invalidating the suite's earlier handles.
async function checkStartupFileAccess(settings, browser, startupUrl) {
  const detailsUrl = `chrome://extensions/?id=${new URL(startupUrl).host}`;
  const settingsUrl = new URL("settings.html", startupUrl).href;
  await installMediaArchive(settings, buildRecommendedZip(RECOMMENDED_DICTIONARIES[0]));
  const resumeState = await settings.evaluate(async () => {
    const { setupState, options } = await chrome.storage.local.get(["setupState", "options"]);
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { hoverEnabled: true, lookupMode: "hover",
        anki: { ...globalThis.HDReaderOptions.normaliseOptions(options).anki, model: "" } } });
    if (!reply.ok) throw new Error(reply.error);
    const state = { ...setupState, revision: setupState.revision + 1, stage: "practice", completedAt: null };
    await chrome.storage.local.set({ setupState: state });
    return state;
  });
  let startup = await browser.newPage();
  await startup.goto(startupUrl, { waitUntil: "domcontentloaded" });
  const readPrompt = () => ({
    status: document.getElementById("local-file-status")?.textContent ?? "",
    open: document.getElementById("local-file-open")?.checkVisibility() === true,
    skip: document.getElementById("local-file-skip")?.checkVisibility() === true,
    instruction: document.getElementById("local-file-instruction")?.textContent ?? "",
    finish: document.getElementById("setup-finish")?.disabled === false,
    settings: document.querySelector('a[href="settings.html"]')?.checkVisibility() === true,
  });
  const fileAllowed = page => page.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
  const waitClosed = page => new Promise(resolveClosed => {
    const timer = setTimeout(() => { page.off("close", onClose); resolveClosed(false); }, 10_000);
    const onClose = () => { clearTimeout(timer); resolveClosed(true); };
    page.once("close", onClose);
  });
  const openSettings = async details => {
    await details.bringToFront();
    // The row is disabled briefly while Chrome reloads the extension.
    await details.waitForFunction(() => document.querySelector("extensions-manager")?.shadowRoot
      .querySelector("extensions-detail-view")?.shadowRoot.querySelector("#extensionsOptions")?.disabled === false);
    const [target] = await Promise.all([
      browser.waitForTarget(target => target.type() === "page" && target.url() === settingsUrl, { timeout: 10_000 }),
      details.$eval("pierce/#extensionsOptions", control => control.click()),
    ]);
    return target.page();
  };
  const resume = async details => {
    const page = await openSettings(details);
    await page.waitForSelector("#setup-resume", { visible: true });
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#setup-resume")]);
    await page.waitForSelector("#setup-finish");
    return page;
  };
  const toggleSelector = "pierce/#allow-on-file-urls";
  const toggle = async (details, enabled) => {
    await details.bringToFront();
    await details.waitForSelector(toggleSelector);
    const changes = await details.$eval(toggleSelector, (row, checked) => row.checked !== checked, enabled);
    if (!changes) return false;
    const closed = waitClosed(startup);
    await details.$eval(toggleSelector, row => row.shadowRoot.querySelector("#crToggle").click());
    if (!await closed) throw new Error("Chrome did not close setup during the native file-access reload.");
    startup = await resume(details);
    await startup.waitForFunction(async expected => await chrome.extension.isAllowedFileSchemeAccess() === expected,
      { timeout: 10_000 }, enabled);
    return true;
  };
  await startup.bringToFront();
  await startup.waitForFunction(() => document.getElementById("local-file-open")?.checkVisibility()
    || document.getElementById("local-file-status")?.textContent === "Local-file lookups enabled");
  const initial = await startup.evaluate(readPrompt);
  const initiallyAllowed = await fileAllowed(startup);
  // Unpacked extensions initially have file access. Use Chrome's real controls
  // to establish the disabled scenario, then test setup's own details shortcut.
  const preparation = await browser.newPage();
  try {
    await preparation.goto(detailsUrl, { waitUntil: "domcontentloaded" });
    // --load-extension initially bypasses Developer mode, but the native file
    // switch reloads it as unpacked. Match a normal Load unpacked installation.
    await preparation.waitForSelector("pierce/#devMode");
    await preparation.$eval("pierce/#devMode", control => { if (!control.checked) control.click(); });
    await toggle(preparation, false);
    await startup.bringToFront();
    await startup.waitForSelector("#local-file-open", { visible: true });
  } finally { await preparation.close(); }
  const before = await startup.evaluate(readPrompt);
  const disabledBefore = await fileAllowed(startup);
  const [detailsTarget] = await Promise.all([
    browser.waitForTarget(target => target.type() === "page" && target.url() === detailsUrl, { timeout: 10_000 }),
    startup.click("#local-file-open"),
  ]);
  const details = await detailsTarget.page();
  let local = null;
  let afterReturn, enabled, afterReload, localResult, skipped, completed;
  let enabledReload, disabledReload, statePreserved, finishedClosed;
  const localPath = resolve(PROFILE, "setup-saved-page.html");
  try {
    await details.waitForSelector(toggleSelector);
    await startup.bringToFront();
    await startup.waitForFunction(() => document.visibilityState === "visible");
    afterReturn = await startup.evaluate(readPrompt);
    enabledReload = await toggle(details, true);
    await startup.bringToFront();
    await startup.waitForFunction(() => document.getElementById("local-file-status")?.textContent === "Local-file lookups enabled");
    enabled = await startup.evaluate(readPrompt);
    statePreserved = await startup.evaluate(async expected =>
      JSON.stringify((await chrome.storage.local.get("setupState")).setupState) === JSON.stringify(expected), resumeState);
    await startup.reload({ waitUntil: "domcontentloaded" });
    await startup.waitForFunction(() => document.getElementById("local-file-status")?.textContent === "Local-file lookups enabled");
    afterReload = await startup.evaluate(readPrompt);
    writeFileSync(localPath, PAGE_HTML.replace("食べたかった", "辞書"));
    local = await browser.newPage();
    await local.goto(pathToFileURL(localPath).href, { waitUntil: "domcontentloaded" });
    const popup = await popupReader(local);
    localResult = await hoverForPopup(local, popup, "#verb");
    await local.close();
    local = null;
    disabledReload = await toggle(details, false);
    await startup.bringToFront();
    await startup.waitForSelector("#local-file-skip", { visible: true });
    await startup.focus("#local-file-skip");
    await startup.keyboard.press("Enter");
    skipped = await startup.evaluate(readPrompt);
    const closed = waitClosed(startup);
    await startup.click("#setup-finish");
    finishedClosed = await closed;
    const finishedSettings = await openSettings(details);
    await finishedSettings.waitForSelector("#setup-resume", { hidden: true });
    completed = await finishedSettings.evaluate(async () => ({
      state: (await chrome.storage.local.get("setupState")).setupState,
      allowed: await chrome.extension.isAllowedFileSchemeAccess(),
      resumeHidden: document.getElementById("setup-resume")?.hidden === true,
    }));
  } finally {
    if (local) await local.close();
    await details.close();
    rmSync(localPath, { force: true });
  }
  check("saved-page setup rechecks Chrome file access and a local HTML file uses the real reader",
    (initiallyAllowed ? initial.status === "Local-file lookups enabled" && !initial.open && !initial.skip : initial.open && initial.skip)
      && disabledBefore === false && before.open && before.skip && before.finish && before.settings
      && afterReturn.open && afterReturn.skip && !afterReturn.status.includes("enabled")
      && afterReturn.instruction.includes("Allow access to file URLs")
      && enabledReload && disabledReload && statePreserved
      && enabled.status === "Local-file lookups enabled" && !enabled.open && !enabled.skip
      && afterReload.status === "Local-file lookups enabled" && afterReload.finish && afterReload.settings
      && localResult?.plain.includes("辞書") && localResult.text.includes(`${RECOMMENDED_DICTIONARIES[0].title} term fixture`)
      && skipped.open === false && skipped.skip === false && skipped.finish && skipped.settings
      && finishedClosed && completed.allowed === false && completed.resumeHidden
      && completed.state.stage === "complete" && typeof completed.state.completedAt === "string",
    JSON.stringify({ initiallyAllowed, initial, disabledBefore, before, detailsUrl, afterReturn, enabledReload, disabledReload,
      statePreserved, enabled, afterReload, localResult, skipped, finishedClosed, completed }));
}

// First-run Anki detection against a mocked AnkiConnect on the real service
// worker: the startup page asks once, the ranked note type and deck are saved
// with the preset, and nothing in the collection is modified. Setup state and
// options are restored afterwards so the later Anki checks start as they did.
async function checkFirstRunAnkiDetection(page, browser, startupUrl) {
  const KIKU_FIELDS = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "SelectionText", "MainDefinition",
    "Glossary", "Sentence", "SentenceFurigana", "PitchPosition", "PitchCategories", "Frequency", "FreqSort", "MiscInfo", "Picture"];
  const calls = [];
  const route = { requests: 0, respond(request) {
    const { action, params, version } = JSON.parse(request.postData);
    calls.push({ action, params, version });
    // Two notes live in Mining and one in the child deck, so Mining wins.
    const result = action === "modelNamesAndIds" ? { Basic: 1, "Kiku v2": 2, "My Kiku": 3 }
      : action === "modelFieldNames" ? (params.modelName === "Kiku v2" ? KIKU_FIELDS : ["Front", "Back"])
        : action === "findNotes" ? [21, 22, 23]
          : action === "findCards" ? [211, 212, 221, 231]
            : action === "getDecks" ? { Mining: [211, 212, 221], "Mining::Old": [231] }
              : action === "cardsToNotes" ? (params.cards.includes(231) ? [23] : [21, 22]) : null;
    if (result === null) return { body: JSON.stringify({ result: null, error: `unexpected ${action}` }), status: 200, contentType: "application/json" };
    return { body: JSON.stringify({ result, error: null }), status: 200, contentType: "application/json" };
  } };
  const worker = await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const session = await interceptFetches(worker, new Map([["http://127.0.0.1:8765/", route]]), "anki setup");
  const saved = await page.evaluate(async () => (await chrome.storage.local.get(["setupState", "options"])));
  let startup = null;
  try {
    // Setup returns to the Anki stage with no outcome yet; the dictionary stage
    // is already behind it, so the page checks Anki as soon as it opens.
    await page.evaluate(async (previous) => {
      await chrome.storage.local.set({ setupState: { ...previous, revision: previous.revision + 1, stage: "anki", completedAt: null, anki: null } });
    }, saved.setupState);
    startup = await browser.newPage();
    startup.on("console", (message) => diagnostics.push(`[startup anki] ${message.type()}: ${message.text()}`));
    startup.on("pageerror", (error) => diagnostics.push(`[startup anki] pageerror: ${error.message}`));
    await startup.goto(startupUrl, { waitUntil: "domcontentloaded" });
    await startup.evaluate(() => {
      window.__headingLog = [];
      const record = () => {
        const text = document.getElementById("setup-heading")?.textContent ?? "";
        if (window.__headingLog.at(-1) !== text) window.__headingLog.push(text);
      };
      record();
      new MutationObserver(record).observe(document.getElementById("setup-card"), { childList: true, subtree: true, characterData: true });
    });
    const ready = await startup.waitForFunction(() => document.getElementById("setup-heading")?.textContent === "Add a dictionary to try Hachidori"
      ? { outcome: document.querySelector(".setup-anki-outcome")?.dataset.status ?? null,
        outcomeText: document.querySelector(".setup-anki-outcome")?.textContent ?? "",
        outcomeLink: document.querySelector('.setup-anki-outcome a[href="settings.html#anki"]') !== null,
        done: document.querySelectorAll(".setup-step.is-done").length,
        status: document.getElementById("setup-status")?.textContent ?? "" } : false,
    { timeout: 30_000, polling: 50 }).then((handle) => handle.jsonValue()).catch(() => null);
    const headingLog = await startup.evaluate(() => window.__headingLog ?? []);
    const detected = await page.evaluate(async () => (await chrome.storage.local.get(["setupState", "options"])));
    const anki = detected.options?.anki ?? {};
    const templates = anki.fieldTemplates ?? {};
    const recovery = await startup.evaluate(() => ({
      link: document.querySelector("#setup-practice-recovery a")?.getAttribute("href"),
      visible: document.getElementById("setup-practice-recovery")?.checkVisibility() === true,
      exercise: document.getElementById("setup-practice-lookup")?.checkVisibility() === true,
      finish: document.getElementById("setup-finish")?.disabled === false,
      settings: document.querySelector('a[href="settings.html"]')?.checkVisibility() === true,
    }));
    check("startup practice without a usable dictionary retains recovery and completion controls",
      recovery.link === "settings.html#add-dictionaries" && recovery.visible && recovery.exercise === false
        && recovery.finish && recovery.settings,
      JSON.stringify(recovery));
    if (process.env.HACHIDORI_STARTUP_ANKI_SCREENSHOT || process.env.HACHIDORI_STARTUP_ANKI_DARK_SCREENSHOT) {
      await startup.setViewport({ width: 900, height: 820 });
      for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_ANKI_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_ANKI_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await startup.screenshot({ path });
      }
      await startup.emulateMediaFeatures([]);
    }
    check(
      "first-run detection configures an existing Kiku mining setup read-only from the startup page",
      JSON.stringify(headingLog.slice(0, 3)) === JSON.stringify(["Connect Anki, if you use it", "Anki is set up", "Add a dictionary to try Hachidori"])
        && ready?.outcome === "configured" && ready.outcomeLink && ready.status === "Add a dictionary to try Hachidori"
        && ready.outcomeText === "Automatically set up Kiku v2 for deck ‘Mining’. Change in Settings."
        && ready.done === 2
        // The durable outcome and the saved mapping name the same note type and deck.
        && detected.setupState?.anki?.status === "configured" && detected.setupState.anki.detail === null
        && detected.setupState.anki.model === "Kiku v2" && detected.setupState.anki.deck === "Mining"
        && anki.model === "Kiku v2" && anki.deck === "Mining"
        && detected.options.revision === saved.options.revision + 1
        && Object.keys(templates).length === KIKU_FIELDS.length
        && templates.Expression?.value === "{expression}" && templates.Picture?.value === ""
        // Only the fixed read-only actions ran, in ranking order, at protocol version 6.
        && JSON.stringify(calls.map(({ action }) => action)) === JSON.stringify(
          ["modelNamesAndIds", "modelFieldNames", "findNotes", "findCards", "getDecks", "cardsToNotes", "cardsToNotes"])
        && calls.every(({ version }) => version === 6)
        && calls.find(({ action }) => action === "findNotes").params.query === "mid:2"
        && calls.find(({ action }) => action === "findCards").params.query === "mid:2 -deck:filtered",
      JSON.stringify({ headingLog, ready, detected, calls }),
    );
  } finally {
    if (startup !== null) await startup.close().catch(() => {});
    await session.detach().catch(() => {});
    // The remaining Anki checks expect the unconfigured mapping and a completed setup.
    await page.evaluate(async (previous) => {
      const { options } = await chrome.storage.local.get("options");
      await chrome.storage.local.set({ setupState: previous.setupState, options: { ...previous.options, revision: options.revision + 1 } });
    }, saved);
    await page.waitForFunction(async (expected) => {
      const stored = await chrome.storage.local.get(["setupState", "options"]);
      return stored.setupState?.stage === "complete"
        && JSON.stringify(stored.options.anki ?? null) === JSON.stringify(expected ?? null);
    }, { timeout: 10_000, polling: 100 }, saved.options.anki ?? null);
  }
}

async function checkAnkiSettings(page, browser) {
  const original = await page.evaluate(async () => ({
    options: (await chrome.storage.local.get("options")).options,
    status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
  }));
  let offline = true, holdA = false, missingField = false;
  let releaseA;
  const calls = [];
  const route = { requests: 0, async respond(request) {
    const { action, params } = JSON.parse(request.postData);
    calls.push({ action, params });
    if (offline) return { body: "Unavailable", status: 503, contentType: "text/plain" };
    if (action === "modelFieldNames" && params.modelName === "Japanese" && holdA) {
      holdA = false;
      await new Promise(resolve => { releaseA = resolve; });
    }
    const fields = params.modelName === "Basic" ? ["Front", "Back"]
      : missingField ? ["Changed"] : ["Expression", "Reading", "Meaning", "Sentence", "Frequency", "Pitch", "Audio"];
    const result = action === "deckNames" ? ["Default", "Japanese"]
      : action === "modelNames" ? ["Japanese", "Basic"] : fields;
    return { body: JSON.stringify({ result, error: null }), status: 200, contentType: "application/json" };
  } };
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const session = await interceptFetches(worker, new Map([["http://127.0.0.1:8765/", route]]), "anki");
  const status = () => page.$eval("#anki-status", node => node.textContent);
  const settled = () => page.waitForFunction(() => !document.getElementById("anki-refresh").disabled);
  const saved = () => page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
  const choose = async (id, value) => { await page.select(`#opt-anki-${id}`, value); await saved(); };
  try {
    const lazy = route.requests === 0;
    await showSettingsSection(page, "anki");
    await page.waitForFunction(() => document.getElementById("anki-status").textContent.includes("HTTP 503"));
    const failed = await status();
    offline = false;
    await page.click("#anki-refresh");
    await settled();
    check("Anki discovery is lazy and refresh recovers an offline connection through the real service worker",
      lazy && failed.includes("Not connected") && (await status()).includes("Connected")
        && await page.$eval("#opt-anki-model", node => [...node.options].some(option => option.value === "Japanese")),
      JSON.stringify({ failed, current: await status(), calls }));

    holdA = true;
    await page.select("#opt-anki-model", "Japanese");
    const deadline = Date.now() + 1000;
    while (!releaseA && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (!releaseA) throw new Error("Anki model A did not reach its deferred field response");
    await page.select("#opt-anki-model", "Basic");
    await settled();
    releaseA();
    await saved();
    const newest = await page.$eval("#opt-anki-field-expression", node => [...node.options].map(option => option.value));
    await choose("field-expression", "Front");
    await choose("model", "Japanese");
    await settled();
    await choose("field-expression", "Expression");
    const revision = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    missingField = true;
    await page.click("#anki-refresh");
    await settled();
    const unavailable = await page.$eval("#opt-anki-field-expression", node => ({ value: node.value, text: node.textContent }));
    const afterRefresh = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    check("Anki Settings reject stale model replies and preserve unavailable mappings without discovery writes",
      newest.includes("Front") && !newest.includes("Expression") && unavailable.value === "Expression"
        && unavailable.text.includes("unavailable") && (await status()).includes("unavailable")
        && revision === afterRefresh, JSON.stringify({ newest, unavailable, revision, afterRefresh }));

    missingField = false;
    await page.click("#anki-refresh");
    await settled();
    for (const [key, field] of [["reading", "Reading"], ["definition", "Meaning"], ["sentence", "Sentence"],
      ["frequency", "Frequency"], ["pitch", "Pitch"], ["audio", "Audio"]]) await choose(`field-${key}`, field);
    await choose("deck", "Japanese");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("anki-status").textContent.includes("configuration ready"));
    await saved();
    const persisted = await page.evaluate(async () => ({
      anki: (await chrome.storage.local.get("options")).options.anki,
      status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
    }));
    check("Anki configuration persists through reload without reloading the dictionary engine",
      persisted.anki.deck === "Japanese" && persisted.anki.model === "Japanese"
        && persisted.anki.fields.expression === "Expression" && persisted.anki.fields.audio === "Audio"
        && persisted.status.generation === original.status.generation, JSON.stringify(persisted));
    await page.select("#anki-preset", "kiku");
    await page.click("#anki-apply-preset");
    await saved();
    const templateEditor = await page.$("#anki-templates textarea");
    const templateId = await templateEditor.evaluate(node => node.id);
    await templateEditor.dispose();
    const editTemplate = async value => {
      await page.$eval(`#${templateId}`, (node, text) => {
        node.focus(); node.value = text; node.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await saved();
    };
    await editTemplate("<b>{expression}</b> {unknown}");
    const invalidMarker = await status();
    await editTemplate("<b>{expression}</b>");
    await page.$eval(".anki-details", node => { node.open = true; });
    await choose("duplicate-behavior", "overwrite");
    await page.select(`#${templateId}-mode`, "coalesce-new");
    await saved();
    const templateState = await page.evaluate(async () => ({
      config: (await chrome.storage.local.get("options")).options.anki,
      editors: [...document.querySelectorAll("#anki-templates textarea")].map(node => ({ value: node.value, readOnly: node.readOnly })),
    }));
    check("Anki presets expose editable field templates and persist overwrite modes with visible marker errors",
      invalidMarker.includes("Unknown marker: {unknown}") && templateState.config.fieldTemplates.Expression.value === "<b>{expression}</b>"
        && templateState.config.fieldTemplates.Expression.overwriteMode === "coalesce-new"
        && templateState.editors.every(row => !row.readOnly), JSON.stringify({ invalidMarker, templateState }));
    // Kiku does not map this model's generic Reading field; a blank template
    // remains intentional through discovery and restart, not an auto-fill hint.
    const beforeTemplateRefresh = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    await page.click("#anki-refresh");
    await settled();
    const afterTemplateRefresh = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.revision);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("anki-status").textContent.includes("configuration ready"));
    await saved();
    const templateReload = await page.evaluate(async () => ({
      config: (await chrome.storage.local.get("options")).options.anki,
      status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }),
      editor: document.querySelector("#anki-templates textarea").value,
    }));
    check("Anki templates survive refresh and reload while disabled values stay disabled and lookup generation stays unchanged",
      beforeTemplateRefresh === afterTemplateRefresh && templateReload.config.fieldTemplates.Reading.value === ""
        && templateReload.config.fieldTemplates.Expression.overwriteMode === "coalesce-new"
        && templateReload.editor === "<b>{expression}</b>" && templateReload.status.generation === original.status.generation,
      JSON.stringify({ beforeTemplateRefresh, afterTemplateRefresh, templateReload }));
    await checkAnkiGlossaryExport(page);
    if (process.env.HACHIDORI_ANKI_SCREENSHOT) await page.screenshot({ path: process.env.HACHIDORI_ANKI_SCREENSHOT, fullPage: true });
  } finally {
    releaseA?.();
    await showSettingsSection(page, "lookup");
    await page.evaluate(async anki => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        requestId: "restore-anki", baseRevision: options.revision,
        options: { anki: anki ?? HDReaderOptions.normaliseOptions({}).anki } });
      if (!reply.ok) throw new Error(reply.error);
    }, original.options?.anki);
    // Later layout checks also visit Anki. Their caller releases this mock
    // before worker-restart checks; tests must never contact the user's Anki.
    offline = true;
  }
  return session;
}

async function readSettingsControls(settings, ids) {
  return settings.evaluate((names) => Object.fromEntries(names.map((id) => {
    const input = document.getElementById(id);
    return [id, input.type === "checkbox" ? input.checked : input.value];
  })), ids);
}

async function editSettingsControls(settings, values) {
  const section = await settings.evaluate(id => {
    const owner = document.getElementById(id).closest("section");
    return { id: owner.id, hidden: owner.hidden };
  }, Object.keys(values)[0]);
  // Re-clicking the active navigation tab would itself blur a focused preview.
  if (section.hidden) await showSettingsSection(settings, section.id);
  await settings.evaluate((changes) => {
    for (const [id, value] of Object.entries(changes)) {
      const input = document.getElementById(id);
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, values);
  await settings.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
    { polling: 100, timeout: 10_000 });
}

async function updateSettingsControls(settings, values) {
  const current = await readSettingsControls(settings, Object.keys(values));
  const changed = Object.fromEntries(Object.entries(values).filter(([id, value]) => current[id] !== value));
  if (Object.keys(changed).length > 0) await editSettingsControls(settings, changed);
}

async function waitForLookupStatistics(popup, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < deadline) {
    current = await popup.lookupStatistics();
    if (predicate(current)) return current;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  return current;
}

async function readLookupStatistics(settings) {
  return settings.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_lookup_stats_read",
    term: "食べる",
    reading: "たべる",
  })).catch(error => ({ error: String(error) }));
}

async function checkLookupStatistics({ browser, settings, tab, popup, extensionId }) {
  const original = await readSettingsControls(settings, [
    "opt-lookup-counts", "opt-corpus-seen", "opt-corpus-url",
  ]);
  let corpusSession = null;
  const freshLookup = async () => {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    return hoverForPopup(tab, popup, "#verb");
  };
  try {
    await updateSettingsControls(settings, {
      "opt-lookup-counts": true,
      "opt-corpus-seen": false,
    });
    const initialDefinition = await popup.state();
    const initialLine = await waitForLookupStatistics(
      popup,
      value => value !== null && !value.hidden && value.text.includes("Looked up"),
    );
    const before = await readLookupStatistics(settings);
    const secondDefinition = await freshLookup();
    const secondLine = await waitForLookupStatistics(
      popup,
      value => value !== null && !value.hidden && value.text.includes("Looked up"),
    );
    const after = await readLookupStatistics(settings);
    check(
      "accepted reader lookups persist canonical counts without delaying definitions",
      initialDefinition?.plain.includes("食べる")
        && secondDefinition?.plain.includes("食べる")
        && initialLine?.text.includes(`Looked up ${before.statistics?.lookupCount}`)
        && secondLine?.text.includes(`Looked up ${after.statistics?.lookupCount}`)
        && before.ok === true
        && before.statistics?.term === "食べる"
        && before.statistics?.reading === "たべる"
        && Number.isFinite(before.statistics?.firstLookedUpAt)
        && after.statistics?.lookupCount === before.statistics.lookupCount + 1
        && after.statistics.firstLookedUpAt === before.statistics.firstLookedUpAt
        && after.statistics.lastLookedUpAt >= before.statistics.lastLookedUpAt,
      JSON.stringify({ initialDefinition, initialLine, before, secondDefinition, secondLine, after }),
    );

    await popup.lookupStatistics("remember");
    await updateSettingsControls(settings, { "opt-lookup-counts": false });
    const hidden = await waitForLookupStatistics(
      popup,
      value => value?.hidden === true && value.popupHidden === false,
    );
    const retainedDefinition = await popup.state();
    const disabledDefinition = await freshLookup();
    await popup.lookupStatistics("remember");
    await updateSettingsControls(settings, { "opt-lookup-counts": true });
    // Re-enabling paints the popup that rendered while counts were off, with
    // one read: the same popup and panel, and no new hover or increment.
    const reenabled = await waitForLookupStatistics(
      popup,
      value => value !== null && !value.hidden && value.text.includes("Looked up"),
    );
    const afterPause = await readLookupStatistics(settings);
    const resumedDefinition = await freshLookup();
    const incrementedLine = await waitForLookupStatistics(
      popup,
      value => value !== null && !value.hidden && value.text.includes("Looked up"),
    );
    const afterResume = await readLookupStatistics(settings);
    check(
      "live lookup-count Settings pause recording and preserve the displayed reader view",
      hidden?.samePopup === true
        && hidden.sameLine === true
        && hidden.samePanel === true
        && retainedDefinition?.plain.includes("食べる")
        && disabledDefinition?.plain.includes("食べる")
        && reenabled?.samePopup === true
        && reenabled.sameLine === true
        && reenabled.samePanel === true
        && reenabled.text.includes(`Looked up ${afterPause.statistics?.lookupCount}`)
        && resumedDefinition?.plain.includes("食べる")
        && incrementedLine?.text.includes(`Looked up ${afterResume.statistics?.lookupCount}`)
        && afterPause.statistics?.lookupCount === after.statistics.lookupCount
        && afterResume.statistics?.lookupCount === afterPause.statistics.lookupCount + 1,
      JSON.stringify({
        hidden, retainedDefinition, disabledDefinition, reenabled, afterPause,
        resumedDefinition, incrementedLine, afterResume,
      }),
    );

    const workerTarget = browser.targets().find(target =>
      target.type() === "service_worker"
        && target.url() === `chrome-extension://${extensionId}/background.js`);
    const corpusRoute = {
      requests: 0,
      body: JSON.stringify({ total_occurrences: 9 }),
      status: 200,
      contentType: "application/json",
    };
    const corpusUrl = "http://127.0.0.1:7275/api/tokenization/word/%E9%A3%9F%E3%81%B9%E3%82%8B";
    let corpusEvidence;
    if (workerTarget === undefined) {
      corpusEvidence = { error: "service worker target unavailable" };
    } else {
      corpusSession = await interceptFetches(
        workerTarget,
        new Map([[corpusUrl, corpusRoute]]),
        "lookup-statistics-corpus",
      );
      await updateSettingsControls(settings, {
        "opt-corpus-url": "http://127.0.0.1:7275",
        "opt-corpus-seen": true,
      });
      const available = await waitForLookupStatistics(
        popup,
        value => value?.text.includes("Seen 9 times") && value.text.includes("Looked up"),
      );
      setJsonResponse(corpusRoute, { error: "Tokenization unavailable" }, 503);
      const failedDefinition = await freshLookup();
      const unavailable = await waitForLookupStatistics(
        popup,
        value => corpusRoute.requests >= 2 && value !== null && !value.hidden
          && value.text.includes("Looked up") && !value.text.includes("Seen"),
      );
      if (process.env.HACHIDORI_LOOKUP_STATS_SCREENSHOT) {
        await settings.bringToFront();
        await settings.setViewport({ width: 960, height: 900 });
        await showSettingsSection(settings, "design");
        const screenshotClip = await settings.$eval("#lookup-history-settings", (element) => {
          element.scrollIntoView({ block: "center" });
          const rect = element.getBoundingClientRect();
          const padding = 12;
          const x = Math.max(0, rect.x - padding);
          const y = Math.max(0, rect.y - padding);
          return {
            x,
            y,
            width: Math.min(innerWidth - x, rect.width + (2 * padding)),
            height: Math.min(innerHeight - y, rect.height + (2 * padding)),
          };
        });
        await settings.screenshot({
          captureBeyondViewport: false,
          clip: screenshotClip,
          path: process.env.HACHIDORI_LOOKUP_STATS_SCREENSHOT,
        });
      }
      await updateSettingsControls(settings, { "opt-corpus-seen": false });
      const afterCorpusFailure = await readLookupStatistics(settings);
      corpusEvidence = {
        available,
        unavailable,
        failedDefinition,
        requests: corpusRoute.requests,
        afterCorpusFailure,
      };
    }
    check(
      "optional GSM Seen counts use the configured loopback corpus and fail open",
      corpusEvidence?.available?.text.includes("Seen 9 times")
        && corpusEvidence.available.text.includes(`Looked up ${afterResume.statistics.lookupCount}`)
        && corpusEvidence.failedDefinition?.plain.includes("食べる")
        && corpusEvidence.unavailable?.text.includes(
          `Looked up ${corpusEvidence.afterCorpusFailure?.statistics?.lookupCount}`,
        )
        && !corpusEvidence.unavailable.text.includes("Seen")
        && corpusEvidence.afterCorpusFailure?.statistics?.lookupCount === afterResume.statistics.lookupCount + 1
        && corpusEvidence.requests === 2,
      JSON.stringify(corpusEvidence),
    );
  } finally {
    if (corpusSession !== null) {
      await corpusSession.send("Fetch.disable").catch(() => {});
      await corpusSession.detach().catch(() => {});
    }
    await updateSettingsControls(settings, original).catch(error => {
      diagnostics.push(`[lookup statistics restore] ${error?.stack ?? error}`);
    });
    await popup.lookupStatistics("cleanup").catch(() => {});
    await tab.bringToFront();
    if (!popup.visible(await popup.state())) await hoverForPopup(tab, popup, "#verb");
  }
}

async function waitForDefinitionBlur(popup, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < deadline) {
    current = await popup.definitionBlur();
    if (predicate(current)) return current;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  return current;
}

async function checkDefinitionBlur({ settings, tab, popup }) {
  const controls = ["opt-lookup-counts", "opt-blur-enabled", "opt-blur-direction", "opt-blur-threshold",
    "opt-blur-reveal", "opt-blur-delay", "opt-audio-autoplay"];
  const original = await readSettingsControls(settings, controls);
  const freshLookup = async () => {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    return hoverForPopup(tab, popup, "#verb");
  };
  // The decision is made once the count line is painted from the same reply.
  const decided = () => waitForDefinitionBlur(popup, value => value?.countText.includes("Looked up"));
  try {
    const before = await readLookupStatistics(settings);
    const threshold = before.statistics.lookupCount + 1;
    await updateSettingsControls(settings, {
      "opt-lookup-counts": true, "opt-audio-autoplay": true, "opt-blur-enabled": true,
      "opt-blur-direction": "atLeast", "opt-blur-threshold": String(threshold), "opt-blur-reveal": "hover",
    });
    const qualifyingDefinition = await freshLookup();
    const qualifying = await decided();
    const pendingOrBlurred = await popup.definitionBlur();
    await tab.mouse.move(qualifying.definitionsPoint.x, qualifying.definitionsPoint.y);
    const hovered = await waitForDefinitionBlur(popup, value => value?.state === "revealed");
    await updateSettingsControls(settings, { "opt-blur-direction": "below" });
    const revealedDefinition = await freshLookup();
    const notQualifying = await decided();
    const autoplayed = await waitForDefinitionBlur(popup, value => value?.audioFeedback.some(Boolean), 5_000);
    check("definition blur follows real lookup counts and settings and holds autoplay for blurred results",
      qualifyingDefinition?.plain.includes("食べる")
        && qualifying?.state === "blurred" && qualifying.definitionsState === "blurred"
        && qualifying.countText.includes(`Looked up ${threshold}`)
        && !pendingOrBlurred.audioFeedback.some(Boolean)
        && hovered?.state === "revealed" && !hovered.audioFeedback.some(Boolean)
        && revealedDefinition?.plain.includes("食べる")
        && notQualifying?.state === "revealed" && notQualifying.countText.includes(`Looked up ${threshold + 1}`)
        && autoplayed?.audioFeedback.some(Boolean),
      JSON.stringify({ threshold, qualifying, pendingOrBlurred, hovered, notQualifying, autoplayed }));

    await updateSettingsControls(settings, {
      "opt-audio-autoplay": false, "opt-blur-direction": "atLeast", "opt-blur-threshold": "1",
      "opt-blur-reveal": "timed", "opt-blur-delay": "1",
    });
    const timedStart = Date.now();
    await freshLookup();
    const timedBlurred = await decided();
    const timedRevealed = await waitForDefinitionBlur(popup, value => value?.state === "revealed", 5_000);
    const elapsedMs = Date.now() - timedStart;
    await updateSettingsControls(settings, { "opt-blur-delay": "3600" });
    await freshLookup();
    const longBlurred = await decided();
    await popup.lookupStatistics("remember");
    await updateSettingsControls(settings, { "opt-blur-enabled": false });
    const disabled = await waitForDefinitionBlur(popup, value => value?.state === "revealed", 5_000);
    const retained = await popup.lookupStatistics();
    check("blurred definitions reveal on hover, at the timed deadline and at once when blur is disabled",
      hovered?.state === "revealed"
        && timedBlurred?.state === "blurred" && timedRevealed?.state === "revealed"
        && elapsedMs >= 1000 && elapsedMs < 4000
        && longBlurred?.state === "blurred" && disabled?.state === "revealed"
        && retained?.samePopup === true && retained.samePanel === true && retained.popupHidden === false,
      JSON.stringify({ hovered, timedBlurred, timedRevealed, elapsedMs, longBlurred, disabled, retained }));
  } finally {
    await popup.lookupStatistics("cleanup").catch(() => {});
    await updateSettingsControls(settings, original).catch(error => {
      diagnostics.push(`[definition blur restore] ${error?.stack ?? error}`);
    });
    await tab.bringToFront();
    if (!popup.visible(await popup.state())) await hoverForPopup(tab, popup, "#verb");
  }
}

async function checkAnkiMatureDefinitionBlur({ browser, settings, tab, popup }) {
  const original = await readSettingsControls(settings, ["opt-lookup-counts", "opt-blur-enabled", "opt-blur-anki-mature",
    "opt-blur-direction", "opt-blur-threshold", "opt-blur-reveal", "opt-blur-delay", "opt-audio-autoplay"]);
  const originalAnki = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options.anki);
  const calls = [];
  let mode = "nonmature", releaseMaturity = null;
  // Match the entire fixed AnkiConnect endpoint, including mining discovery and
  // preflight: no action in this block may reach the user's running Anki.
  const route = { requests: 0, async respond(request) {
    const { action, params } = JSON.parse(request.postData);
    calls.push({ action, params });
    if (mode === "offline") return { body: "Anki unavailable", status: 503, contentType: "text/plain" };
    let result;
    if (action === "findCards") {
      const mature = mode === "mature";
      if (mature) await new Promise(resolve => { releaseMaturity = resolve; });
      result = mature ? [70] : [];
    } else if (action === "deckNames") result = ["Default"];
    else if (action === "modelNames") result = ["Basic"];
    else if (action === "modelFieldNames") result = ["Front", "Back"];
    else if (action === "canAddNotesWithErrorDetail") result = params.notes.map(() => ({ canAdd: true, error: null }));
    else throw new Error(`Unexpected Anki maturity action ${action}`);
    return { body: JSON.stringify({ result, error: null }), status: 200, contentType: "application/json" };
  } };
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const session = await interceptFetches(worker, new Map([["http://127.0.0.1:8765/", route]]), "anki-maturity");
  const freshLookup = async () => {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    return hoverForPopup(tab, popup, "#verb");
  };
  try {
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await updateSettingsControls(settings, {
      "opt-lookup-counts": false, "opt-blur-enabled": false, "opt-audio-autoplay": true, "opt-blur-reveal": "hover",
    });
    await settings.evaluate(async () => {
      const { options } = await chrome.storage.local.get("options");
      const defaults = HDReaderOptions.normaliseOptions({}).anki;
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
        options: { anki: { ...defaults, model: "Basic", fields: { ...defaults.fields, expression: "Front" } } } });
      if (!reply.ok) throw new Error(reply.error);
    });
    await updateSettingsControls(settings, { "opt-blur-anki-mature": true });
    // Keep the main Settings page's already-open custom source editor alive for
    // the later Note adoption contract while independently proving a reload.
    const reloadedSettings = await browser.newPage();
    let persisted;
    try {
      await reloadedSettings.goto(settings.url(), { waitUntil: "domcontentloaded" });
      await reloadedSettings.reload({ waitUntil: "domcontentloaded" });
      await reloadedSettings.waitForFunction(() => document.getElementById("opt-blur-anki-mature").checked);
      persisted = await reloadedSettings.evaluate(async () => {
        const { options } = await chrome.storage.local.get("options");
        return { enabled: options.definitionBlurAnkiMature, counts: options.showLookupCounts, countBlur: options.definitionBlurEnabled,
          checked: document.getElementById("opt-blur-anki-mature").checked,
          revealDisabled: document.getElementById("opt-blur-reveal").disabled };
      });
    } finally { await reloadedSettings.close(); }
    check("Anki maturity blur is opt-in and persists independently of lookup counts",
      original["opt-blur-anki-mature"] === false && persisted.enabled && persisted.checked
        && !persisted.counts && !persisted.countBlur && !persisted.revealDisabled,
      JSON.stringify({ original, persisted }));

    const before = await readLookupStatistics(settings);
    mode = "mature";
    const definition = await freshLookup();
    const pending = await waitForDefinitionBlur(popup, value => releaseMaturity !== null && value?.state === "pending", 800);
    const respondedAfterDisplay = releaseMaturity !== null && popup.visible(definition);
    releaseMaturity?.();
    releaseMaturity = null;
    mode = "nonmature";
    const mature = await waitForDefinitionBlur(popup, value => value?.state === "blurred");
    await tab.mouse.move(mature.definitionsPoint.x, mature.definitionsPoint.y);
    const hovered = await waitForDefinitionBlur(popup, value => value?.state === "revealed");
    const after = await readLookupStatistics(settings);
    const query = calls.find(call => call.action === "findCards")?.params.query ?? "";
    check("held Anki maturity keeps the first local popup responsive and mature definitions reveal silently",
      definition?.plain.includes("食べる") && respondedAfterDisplay
        && pending?.state === "pending" && !pending.audioFeedback.some(Boolean)
        && mature?.state === "blurred" && mature.definitionsState === "blurred" && !mature.audioFeedback.some(Boolean)
        && hovered?.state === "revealed" && !hovered.audioFeedback.some(Boolean)
        && before.ok && after.ok && before.statistics === null && after.statistics === null
        && before.descriptor.generation === after.descriptor.generation && before.descriptor.revision === after.descriptor.revision
        && query.includes("is:review") && query.includes("-is:learn") && query.includes("prop:ivl>=21")
        && query.includes("note:Basic") && query.includes("Front:食べる") && !query.includes("deck:"),
      JSON.stringify({ respondedAfterDisplay, pending, mature, hovered, before, after, query }));

    const nonmatureDefinition = await freshLookup();
    const nonmature = await waitForDefinitionBlur(popup, value => value?.state === "revealed" && value.audioFeedback.some(Boolean), 5_000);
    mode = "offline";
    const offlineDefinition = await freshLookup();
    const offline = await waitForDefinitionBlur(popup, value => value?.state === "revealed" && value.audioFeedback.some(Boolean), 5_000);
    mode = "nonmature";
    await updateSettingsControls(settings, { "opt-lookup-counts": true, "opt-blur-enabled": true,
      "opt-blur-direction": "atLeast", "opt-blur-threshold": "1" });
    await freshLookup();
    const countQualified = await waitForDefinitionBlur(popup, value => value?.state === "blurred" && value.countText.includes("Looked up"));
    check("nonmature and unavailable Anki fail open while qualifying lookup counts still blur independently",
      nonmatureDefinition?.plain.includes("食べる") && nonmature?.state === "revealed" && nonmature.audioFeedback.some(Boolean)
        && offlineDefinition?.plain.includes("食べる") && offline?.state === "revealed" && offline.audioFeedback.some(Boolean)
        && countQualified?.state === "blurred" && !countQualified.audioFeedback.some(Boolean)
        && calls.every(call => ["findCards", "deckNames", "modelNames", "modelFieldNames", "canAddNotesWithErrorDetail"].includes(call.action)),
      JSON.stringify({ nonmature, offline, countQualified, calls }));
    if (process.env.HACHIDORI_DEFINITION_BLUR_SCREENSHOT) {
      await updateSettingsControls(settings, { "opt-blur-threshold": "5", "opt-blur-reveal": "timed", "opt-blur-delay": "5" });
      await settings.bringToFront();
      await settings.setViewport({ width: 960, height: 900 });
      await showSettingsSection(settings, "design");
      const card = await settings.$("#definition-blur-settings");
      await card.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await settings.evaluate(() => new Promise(requestAnimationFrame));
      await card.screenshot({ path: process.env.HACHIDORI_DEFINITION_BLUR_SCREENSHOT });
    }
  } finally {
    releaseMaturity?.();
    await updateSettingsControls(settings, original);
    await settings.evaluate(async anki => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision, options: { anki } });
      if (!reply.ok) throw new Error(reply.error);
    }, originalAnki);
    await session.detach();
    await tab.bringToFront();
    if (!popup.visible(await popup.state())) await hoverForPopup(tab, popup, "#verb");
  }
}

async function checkToolbarPreview(page, frame) {
  const original = await readSettingsControls(page, ["opt-popup-toolbar"]);
  await frame.evaluate(() => {
    const root = document.getElementById("preview-host").shadowRoot;
    const popup = root.querySelector(".gsm-hoshidicts-popup");
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const form = popup.querySelector("form");
    const input = form.elements.definition;
    input.value = "A toolbar draft";
    input.focus();
    input.setSelectionRange(2, 7);
    const proof = { form, input, cards: [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")], removed: false, blurs: 0 };
    input.addEventListener("blur", () => { proof.blurs += 1; });
    proof.observer = new MutationObserver(records => {
      proof.removed ||= records.some(record => [...record.removedNodes].some(node => node.contains(input)));
    });
    proof.observer.observe(popup, { childList: true });
    window.toolbarProof = proof;
  });
  try {
    const cases = [];
    for (const edge of ["bottom", "top", "auto"]) {
      await editSettingsControls(page, { "opt-popup-toolbar": edge });
      const saved = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.popupToolbarPosition);
      cases.push(saved === edge && await frame.evaluate(edge => {
        const proof = window.toolbarProof;
        const root = document.getElementById("preview-host").shadowRoot;
        const popup = root.querySelector(".gsm-hoshidicts-popup");
        const cards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
        return popup.dataset.toolbarPosition === (edge === "auto" ? "top" : edge)
          && root.activeElement === proof.input && proof.input.value === "A toolbar draft"
          && proof.input.selectionStart === 2 && proof.input.selectionEnd === 7 && !proof.removed && proof.blurs === 0
          && proof.form === popup.querySelector("form") && cards.length === proof.cards.length
          && cards.every((card, index) => card === proof.cards[index]);
      }, edge));
    }
    check("toolbar preferences persist and move the preview without detaching focused Notes or rebuilding cards",
      cases.every(Boolean), JSON.stringify(cases));
  } finally {
    await frame.evaluate(() => {
      window.toolbarProof.observer.disconnect();
      window.toolbarProof.form.querySelector(".gsm-hoshidicts-note-cancel").click();
      delete window.toolbarProof;
    });
    await editSettingsControls(page, original);
  }
}

async function checkDesignAppearance(page, frame) {
  const saved = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const drain = () => frame.evaluate(async () => {
    for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame);
  });
  try {
    const catalogue = await page.$eval("#opt-popup-theme", select => ({ count: select.options.length,
      groups: [...select.children].map(group => group.children.length) }));
    await frame.evaluate(() => {
      const host = document.getElementById("preview-host");
      window.appearanceProof = { card: host.shadowRoot.querySelector(".gsm-hoshidicts-glossary-card"),
        stylesheet: host.shadowRoot.querySelector("link").sheet, highlightSheet: document.adoptedStyleSheets[0] };
    });
    const palettes = [];
    for (const theme of ["miku", "girlypop", "light", "high-contrast"]) {
      await editSettingsControls(page, { "opt-popup-theme": theme });
      palettes.push(await frame.evaluate(() => {
        const host = document.getElementById("preview-host");
        const popup = host.shadowRoot.querySelector(".gsm-hoshidicts-popup");
        return { primary: getComputedStyle(host).getPropertyValue("--hoshidicts-palette-primary").trim(),
          backdrop: getComputedStyle(popup).backdropFilter,
          retained: window.appearanceProof.card === popup.querySelector(".gsm-hoshidicts-glossary-card")
            && window.appearanceProof.stylesheet === host.shadowRoot.querySelector("link").sheet
            && window.appearanceProof.highlightSheet === document.adoptedStyleSheets[0],
          pageUntouched: !document.documentElement.hasAttribute("data-hoshidicts-theme") };
      }));
      if (theme === "miku" || theme === "girlypop") {
        const stops = async opacity => {
          await editSettingsControls(page, { "opt-popup-opacity": String(opacity) });
          return frame.evaluate(() => {
            const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
            return [...getComputedStyle(popup).backgroundImage.matchAll(/color\(srgb[^)]* \/ ([\d.]+)\)/g)]
              .map(match => Number(match[1]));
          });
        };
        palettes.at(-1).zeroStops = await stops(0);
        palettes.at(-1).fullStops = await stops(100);
      }
    }
    check("Design exposes 42 grouped themes and applies real palette overrides without rebuilding the preview",
      catalogue.count === 42 && JSON.stringify(catalogue.groups) === "[18,23,1]"
        && palettes.every(value => value.retained && value.pageUntouched)
        && palettes[0].primary === "#39c5bb" && palettes[2].primary === "oklch(45% 0.24 277.023)"
        && palettes[3].primary === "#ffe000" && palettes[3].backdrop === "none"
        && palettes.slice(0, 2).every(value => JSON.stringify(value.zeroStops) === "[0,0]")
        && JSON.stringify(palettes[0].fullStops) === "[0.18,0.12]"
        && JSON.stringify(palettes[1].fullStops) === "[0.22,0.12]", JSON.stringify({ catalogue, palettes }));
    await editSettingsControls(page, { "opt-popup-theme": "default" });
    const immediate = await page.evaluate(async () => {
      const revision = (await chrome.storage.local.get("options")).options.revision;
      for (const [id, value] of [["opt-popup-width", "720"], ["opt-popup-height", "500"], ["opt-popup-opacity", "0"]]) {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const host = document.getElementById("design-preview").contentDocument.getElementById("preview-host");
      return host.style.getPropertyValue("--gsm-hoshidicts-popup-width") === "720px"
        && host.style.getPropertyValue("--gsm-hoshidicts-popup-height") === "500px"
        && host.style.getPropertyValue("--gsm-hoshidicts-popup-opacity") === "0%"
        && (await chrome.storage.local.get("options")).options.revision === revision;
    });
    await page.waitForFunction(async () => (await chrome.storage.local.get("options")).options.popupWidthPx === 720);
    await drain();
    const geometry = await frame.evaluate(() => {
      const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      return { width: popup.getBoundingClientRect().width, height: popup.getBoundingClientRect().height,
        background: getComputedStyle(popup).backgroundColor, opacity: getComputedStyle(popup).opacity };
    });
    await editSettingsControls(page, { "opt-popup-opacity": "100" });
    const opaque = await frame.evaluate(() => getComputedStyle(document.getElementById("preview-host")
      .shadowRoot.querySelector(".gsm-hoshidicts-popup")).backgroundColor);
    await frame.evaluate(() => document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-link").click());
    await editSettingsControls(page, { "opt-source-highlight": false });
    const disabled = await frame.evaluate(() => !CSS.highlights.has("gsm-hoshidicts-match"));
    await editSettingsControls(page, { "opt-source-highlight": true });
    const restored = await frame.evaluate(() => [...CSS.highlights.get("gsm-hoshidicts-match")].map(range => range.toString()).join(""));
    await frame.evaluate(() => document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back").click());
    const beforeReset = await page.evaluate(() => chrome.storage.local.get(["options", "dictionaryState", "dictionaryUpdates"]));
    await page.$eval("#reset-design", button => button.click());
    await page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
    const reset = await page.evaluate(async before => {
      const after = await chrome.storage.local.get(["options", "dictionaryState", "dictionaryUpdates"]);
      const { DEFAULT_OPTIONS, DESIGN_OPTION_KEYS, normaliseOptions } = HDReaderOptions;
      const options = normaliseOptions(after.options);
      return DESIGN_OPTION_KEYS.every(key => JSON.stringify(options[key]) === JSON.stringify(DEFAULT_OPTIONS[key]))
        && Object.keys(before.options).filter(key => key !== "revision" && !DESIGN_OPTION_KEYS.includes(key))
          .every(key => JSON.stringify(after.options[key]) === JSON.stringify(before.options[key]))
        && JSON.stringify(before.dictionaryState) === JSON.stringify(after.dictionaryState)
        && JSON.stringify(before.dictionaryUpdates) === JSON.stringify(after.dictionaryUpdates);
    }, beforeReset);
    check("Design previews opacity and dimensions immediately and resets only Design settings", immediate && reset
      && geometry.width === 720 && geometry.height === 500 && geometry.opacity === "1"
      && geometry.background.endsWith(" / 0)") && !opaque.includes(" / ") && disabled && restored === "食べる",
    JSON.stringify({ immediate, geometry, opaque, disabled, restored, reset }));
  } finally {
    await page.evaluate(async saved => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options.revision, options: HDReaderOptions.normaliseOptions(saved) });
      if (!reply.ok) throw new Error(reply.error);
    }, saved);
  }
}

async function checkCustomCssPreview(page, frame) {
  const saved = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const css = "/* My popup */\n.gsm-hoshidicts-popup {\n  outline-color: rgb(12, 34, 56);\n  font-size: 17px;\n}\nbody { background: red; }\n.bad { color: ???; }";
  const savedStatus = () => page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
  const input = text => page.evaluate(text => {
    const editor = document.getElementById("opt-custom-popup-css");
    editor.value = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    const root = document.getElementById("design-preview").contentDocument.getElementById("preview-host").shadowRoot;
    return { color: getComputedStyle(root.querySelector(".gsm-hoshidicts-popup")).outlineColor,
      status: document.getElementById("options-status").textContent,
      count: document.getElementById("custom-css-count").textContent };
  }, text);
  await frame.evaluate(() => {
    const root = document.getElementById("preview-host").shadowRoot;
    const popup = root.querySelector(".gsm-hoshidicts-popup");
    const base = new CSSStyleSheet();
    base.replaceSync(".gsm-hoshidicts-popup { outline-color: rgb(1, 2, 3); }");
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, base];
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const form = popup.querySelector("form");
    form.elements.definition.value = "Keep my draft";
    window.cssProof = { base, form, card: popup.querySelector(".gsm-hoshidicts-glossary-card"),
      pageBackground: getComputedStyle(document.body).backgroundColor };
  });
  try {
    const immediate = await input(css);
    await savedStatus();
    const persisted = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.customPopupCss);
    const cascade = await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      const popup = root.querySelector(".gsm-hoshidicts-popup");
      const late = document.createElement("style");
      late.textContent = ".gsm-hoshidicts-popup { outline-color: rgb(7, 8, 9); }";
      root.append(late);
      window.cssProof.late = late;
      const style = getComputedStyle(popup);
      return style.outlineColor === "rgb(12, 34, 56)" && style.fontSize === "17px"
        && getComputedStyle(document.body).backgroundColor === window.cssProof.pageBackground
        && root.adoptedStyleSheets.length === 2 && root.adoptedStyleSheets[0] === window.cssProof.base
        && root.querySelector("form") === window.cssProof.form && window.cssProof.form.elements.definition.value === "Keep my draft"
        && root.querySelector(".gsm-hoshidicts-glossary-card") === window.cssProof.card;
    });
    if (process.env.HACHIDORI_CUSTOM_CSS_SCREENSHOT) {
      await input("/* A little more breathing room */\n.gsm-hoshidicts-popup {\n  font-size: 17px;\n}\n\n.gsm-hoshidicts-glossary-card {\n  border-radius: 10px;\n}");
      await savedStatus();
      await frame.evaluate(() => window.cssProof.form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await page.setViewport({ width: 1440, height: 1000 });
      await page.$eval("#opt-custom-popup-css", editor => editor.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: process.env.HACHIDORI_CUSTOM_CSS_SCREENSHOT });
      await frame.evaluate(() => {
        const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
        popup.querySelector(".gsm-hoshidicts-note-button").click();
        window.cssProof.form = popup.querySelector("form");
      });
    }
    const beforeReset = await page.evaluate(() => chrome.storage.local.get(["options", "dictionaryState"]));
    await page.$eval("#reset-custom-css", button => button.click());
    await savedStatus();
    const reset = await page.evaluate(async before => {
      const after = await chrome.storage.local.get(["options", "dictionaryState"]);
      return after.options.customPopupCss === "" && document.getElementById("opt-custom-popup-css").value === ""
        && document.getElementById("custom-css-count").textContent === "0 characters"
        && Object.keys(before.options).filter(key => !["revision", "customPopupCss"].includes(key))
          .every(key => JSON.stringify(before.options[key]) === JSON.stringify(after.options[key]))
        && JSON.stringify(before.dictionaryState) === JSON.stringify(after.dictionaryState);
    }, beforeReset);
    const detached = await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      return root.adoptedStyleSheets.length === 1 && root.adoptedStyleSheets[0] === window.cssProof.base
        && getComputedStyle(root.querySelector(".gsm-hoshidicts-popup")).outlineColor === "rgb(1, 2, 3)"
        && root.querySelector("form") === window.cssProof.form;
    });
    check("custom CSS editor previews unsaved text, persists its count and resets only its stylesheet",
      immediate.color === "rgb(12, 34, 56)" && immediate.status === "Unsaved changes…"
        && immediate.count === `${css.length} characters` && persisted === css && reset && detached,
      JSON.stringify({ immediate, reset, detached }));
    check("custom CSS overrides built-in and late dictionary styles only inside the popup shadow tree and tolerates invalid CSS", cascade);
  } finally {
    await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter(sheet => sheet !== window.cssProof.base);
      window.cssProof.late?.remove();
      window.cssProof.form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      delete window.cssProof;
    });
    await input(saved.customPopupCss || "");
    await savedStatus();
  }
}

async function checkDesignPreview(page) {
  const original = await readSettingsControls(page, ["opt-popup-columns", "opt-compact-summary", "opt-frequency-names"]);
  const originalViewport = page.viewport();
  const before = await page.evaluate(async (sourceKey) => ({
    lazy: document.getElementById("design-preview") === null,
    stored: await chrome.storage.local.get(["dictionaryState", sourceKey]),
  }), CUSTOM_DICTIONARY_SOURCE_KEY);
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await showSettingsSection(page, "design");
    const frame = await (await page.$("#design-preview")).contentFrame();
    await frame.waitForFunction(() => document.getElementById("preview-host")?.shadowRoot
      ?.querySelector('.gloss-image-link[data-image-load-state="loaded"] img')?.naturalWidth > 0,
    { timeout: 10_000 });
    const sample = await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      const popup = root.querySelector(".gsm-hoshidicts-popup");
      window.previewCard = popup.querySelector(".gsm-hoshidicts-glossary-card");
      const initial = popup.textContent.includes("食べる") && !!popup.querySelector(".gsm-hoshidicts-tag-frequency")
        && !!popup.querySelector(".gsm-hoshidicts-tag-pitch") && CSS.highlights.has("gsm-hoshidicts-match");
      popup.querySelector(".gsm-hoshidicts-kanji-link").focus();
      return initial && popup.querySelectorAll(".gsm-hoshidicts-glossary-card").length === 4
        && root.querySelector('link[href="render/reader.css"]') !== null;
    });
    await page.keyboard.press("Enter");
    const kanji = await frame.evaluate(() => {
      const root = document.getElementById("preview-host").shadowRoot;
      return root.querySelector(".gsm-hoshidicts-kanji-glyph")?.textContent === "食"
        && root.activeElement?.classList.contains("gsm-hoshidicts-kanji-back")
        && [...CSS.highlights.get("gsm-hoshidicts-match")].map(range => range.toString()).join("") === "食べる";
    });
    await page.keyboard.press("Enter");
    const back = await frame.evaluate(() => document.getElementById("preview-host").shadowRoot
      .activeElement?.classList.contains("gsm-hoshidicts-kanji-link"));
    check("Design lazily renders local sample terms, kanji and images through the production popup", before.lazy && sample && kanji && back,
      JSON.stringify({ lazy: before.lazy, sample, kanji, back }));
    await frame.evaluate(() => {
      const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      window.previewCard = popup.querySelector(".gsm-hoshidicts-glossary-card");
      popup.querySelector(".gsm-hoshidicts-note-button").click();
      window.previewForm = popup.querySelector("form");
      window.previewForm.elements.definition.value = "Preview only";
    });
    await editSettingsControls(page, { "opt-popup-columns": "2", "opt-compact-summary": true, "opt-frequency-names": false });
    const live = await frame.evaluate(async () => {
      const popup = document.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      const retained = popup.querySelector(".gsm-hoshidicts-glossary-card") === window.previewCard
        && popup.querySelector("form") === window.previewForm && !!popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
      window.previewForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      return retained && popup.textContent.includes("This is a preview. Notes are not saved.")
        && window.previewForm.elements.definition.value === "Preview only";
    });
    const after = await page.evaluate(sourceKey => chrome.storage.local.get(["dictionaryState", sourceKey]), CUSTOM_DICTIONARY_SOURCE_KEY);
    check("Design live edits preserve popup cards and Notes while sample appends cannot mutate dictionaries",
      live && JSON.stringify(before.stored) === JSON.stringify(after));
    await frame.evaluate(() => window.previewForm.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const geometry = () => page.evaluate(() => {
      const frame = document.getElementById("design-preview");
      const viewport = document.getElementById("preview-viewport");
      const popup = frame.contentDocument.getElementById("preview-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
      return { scale: new DOMMatrix(getComputedStyle(frame).transform).a, frameWidth: frame.getBoundingClientRect().width,
        available: viewport.clientWidth, width: popup.getBoundingClientRect().width, height: popup.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        localOverflow: viewport.scrollWidth > viewport.clientWidth,
        retained: popup.querySelector(".gsm-hoshidicts-glossary-card") === frame.contentWindow.previewCard };
    });
    const fit = await geometry();
    await page.select("#preview-size", "actual");
    const actual = await geometry();
    await page.setViewport({ width: 320, height: 900 });
    await page.select("#preview-size", "fit");
    await page.waitForFunction(() => document.getElementById("design-preview").getBoundingClientRect().width
      <= document.getElementById("preview-viewport").clientWidth + 1);
    const narrow = await geometry();
    check("Design fits the popup without changing its actual dimensions and keeps narrow Settings scrollable",
      [fit, actual, narrow].every(value => value.width === 560 && value.height === 420 && !value.overflow && value.retained)
        && fit.scale < 1 && fit.frameWidth <= fit.available + 1 && actual.scale === 1 && actual.localOverflow
        && narrow.scale < fit.scale, JSON.stringify({ fit, actual, narrow }));
    await page.setViewport({ width: 1280, height: 900 });
    await checkDesignAppearance(page, frame);
    await checkToolbarPreview(page, frame);
    await checkCustomCssPreview(page, frame);
    if (process.env.HACHIDORI_DESIGN_SCREENSHOT) {
      await page.setViewport({ width: 1440, height: 1000 });
      await frame.evaluate(async () => {
        for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame);
      });
      await page.screenshot({ path: process.env.HACHIDORI_DESIGN_SCREENSHOT });
    }
  } finally {
    await page.setViewport(originalViewport);
    await editSettingsControls(page, original);
    await showSettingsSection(page, "lookup");
  }
}

async function checkFrequencyDirection(browser, settings, tab, popup) {
  const fixture = frequencyRankingFixture();
  const original = await readSettingsControls(settings, ["opt-frequency-dictionary", "opt-frequency-order", "opt-max-results"]);
  const originalVerb = await tab.$eval("#verb", (element) => element.innerHTML);
  const viewport = settings.viewport();
  const status = () => settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
  const before = await status();
  const installed = [];
  let worker;
  const evidence = [];
  let metadata;
  let manualSurvived;
  let cleaned;
  try {
    for (const dictionary of fixture.dictionaries) {
      await installMediaArchive(settings, dictionary.archive);
      installed.push(dictionary.title);
    }
    await settings.waitForFunction((titles) => titles.every((title) =>
      [...document.getElementById("opt-frequency-dictionary").options].some((option) => option.value === title)),
    { timeout: 10_000 }, installed);
    worker = await installMediaReplyProbe(browser);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await editSettingsControls(settings, { "opt-max-results": "1" });
    async function observe(title, direction, reading) {
      await tab.bringToFront();
      await tab.keyboard.press("Escape");
      await tab.evaluate(() => { window.getSelection().removeAllRanges(); document.activeElement?.blur(); });
      await worker.evaluate(() => { globalThis.__ownedMediaProbe.lookups.length = 0; });
      const rendered = await hoverForPopup(tab, popup, "#verb");
      const requests = await worker.evaluate(() => globalThis.__ownedMediaProbe.lookups);
      const options = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options);
      evidence.push(options.frequencyDictionary === title && options.frequencyOrder === direction && options.maxResults === 1
        && rendered?.text.includes(`${fixture.dictionaries[0].title}: ${reading}`)
        && requests.some((request) => request.text === fixture.query && request.maxResults === 1
          && request.options.frequencyDictionary === title && request.options.frequencyOrder === direction));
      return options;
    }
    const [rank, occurrence] = installed;
    await editSettingsControls(settings, { "opt-frequency-dictionary": rank });
    const generation = (await status()).generation;
    await observe(rank, "ascending", "い");
    await editSettingsControls(settings, { "opt-frequency-order": "descending" });
    const manual = await observe(rank, "descending", "う");
    const alias = await setDictionaryAliasInSettings(settings, rank, "Rank alias");
    await showSettingsSection(settings, "lookup");
    await settings.waitForFunction(() => document.getElementById("opt-frequency-order").value === "descending");
    manualSurvived = (await observe(rank, "descending", "う")).revision === manual.revision;
    await settings.bringToFront();
    await settings.click("#opt-frequency-auto");
    await settings.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
    await observe(rank, "ascending", "い");
    await editSettingsControls(settings, { "opt-frequency-dictionary": occurrence });
    await observe(occurrence, "descending", "う");
    const state = await settings.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState);
    metadata = !!alias.settled && state.dictionaries.find((dictionary) => dictionary.title === rank)?.displayName === "Rank alias"
      && fixture.dictionaries.every(({ title, frequencyMode }) =>
        state.dictionaries.find((dictionary) => dictionary.title === title)?.frequencyMode === frequencyMode);
    evidence.push((await status()).generation === generation);
    if (process.env.HACHIDORI_FREQUENCY_SCREENSHOT) {
      await editSettingsControls(settings, { "opt-max-results": original["opt-max-results"] });
      await settings.bringToFront();
      await settings.setViewport({ width: 1280, height: 1000 });
      await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await (await settings.$("#lookup")).screenshot({ path: process.env.HACHIDORI_FREQUENCY_SCREENSHOT });
    }
  } finally {
    if (worker) await restoreMediaReplyProbe(worker);
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
    await editSettingsControls(settings, original);
    for (const title of installed) {
      const removed = await settings.evaluate((title) => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_remove", title,
      }), title);
      if (!removed.ok) throw new Error(removed.error);
    }
    cleaned = (await status()).dictionaryCount === before.dictionaryCount;
    await settings.setViewport(viewport);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
  }
  check("Settings persists frequency directions and applies them to real-WASM lookup results",
    evidence.length === 6 && evidence.every(Boolean) && metadata && manualSurvived && cleaned,
    JSON.stringify({ evidence, metadata, manualSurvived, cleaned }));
}

async function checkPopupMetadata(browser, settings, tab, popup) {
  const controls = ["opt-frequency-names", "opt-average-frequency", "opt-pitch-furigana",
    "opt-pitch-dictionary", "opt-pitch-badge", "opt-grammar-tags"];
  const original = await readSettingsControls(settings, controls);
  const originalAlias = await settings.evaluate(async () => (await chrome.storage.local.get("dictionaryState"))
    .dictionaryState.dictionaries.find(dictionary => dictionary.title === "hachidori-fixture").displayName || "");
  const originalViewport = settings.viewport();
  let worker;
  const evidence = [];
  const counts = () => worker.evaluate(() => ({ lookups: globalThis.__ownedMediaProbe.lookups.length,
    media: globalThis.__ownedMediaProbe.requests.length }));
  const read = () => popup.dictionaryTabs();
  async function expectMetadata(predicate) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await read();
      if (predicate(value.metadata)) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`metadata did not settle: ${JSON.stringify(await read())}`);
  }
  try {
    await editSettingsControls(settings, { "opt-frequency-names": true, "opt-average-frequency": false,
      "opt-pitch-furigana": true, "opt-pitch-dictionary": "", "opt-pitch-badge": true, "opt-grammar-tags": true });
    await tab.bringToFront();
    await hoverForPopup(tab, popup, "#verb");
    await expectMetadata(value => value.frequencyNames.length > 0 && value.pitch > 0
      && value.ruby.length > 0 && value.grammar > 0 && value.ipa.includes("tabeɾɯ"));
    worker = await installMediaReplyProbe(browser);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "Keep the metadata draft" });
    await popup.retainedControls("remember");
    const before = await popup.dictionaryTabs("remember");
    const beforeRequests = await counts();
    // Dispatch native Settings changes without activating its tab: a real
    // tab switch intentionally dismisses a popup through the window blur rule.
    await editSettingsControls(settings, { "opt-frequency-names": false, "opt-pitch-furigana": false,
      "opt-pitch-badge": false, "opt-grammar-tags": false });
    const hidden = await expectMetadata(value => value.frequencyNames.length === 0 && value.pitch === 0
      && value.ruby.length === 0 && value.grammar === 0);
    const retained = await popup.retainedControls();
    evidence.push(hidden.metadata.ipa.includes("tabeɾɯ") && hidden.metadata.definitionTags === before.metadata.definitionTags
      && hidden.sameCards && hidden.samePanel && await popup.dictionaryTabs("matches", before.entries)
      && retained.sameForm && retained.mounted && retained.inputFocused && retained.draft === "Keep the metadata draft"
      && JSON.stringify(retained.selection) === "[2,7]");
    await editSettingsControls(settings, { "opt-average-frequency": true });
    const averaged = await expectMetadata(value => value.frequencyNames.includes("Frequency average (unspecified)"));
    evidence.push(averaged.metadata.frequencies.length > 0 && averaged.metadata.frequencies.every(Number.isFinite)
      && !averaged.metadata.clippedFrequencies
      && averaged.sameCards && JSON.stringify(await counts()) === JSON.stringify(beforeRequests));
    await editSettingsControls(settings, { "opt-pitch-furigana": true, "opt-pitch-dictionary": "hachidori-fixture" });
    const contour = await expectMetadata(value => value.ruby.includes("hachidori-fixture") && value.pitch === 0);
    evidence.push(contour.metadata.grammar === 0 && contour.metadata.ipa.includes("tabeɾɯ")
      && JSON.stringify(await counts()) === JSON.stringify(beforeRequests));
    if (process.env.HACHIDORI_METADATA_POPUP_SCREENSHOT) {
      await popup.click(".gsm-hoshidicts-note-cancel");
      const { x, y, width, height } = (await read()).rect;
      await tab.screenshot({ path: process.env.HACHIDORI_METADATA_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    if (process.env.HACHIDORI_METADATA_SETTINGS_SCREENSHOT) {
      await settings.bringToFront();
      await settings.setViewport({ width: 1280, height: 1000 });
      await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await (await settings.$("#lookup")).screenshot({ path: process.env.HACHIDORI_METADATA_SETTINGS_SCREENSHOT });
    }
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await tab.keyboard.press("Escape");
    await setDictionaryAliasInSettings(settings, "hachidori-fixture", "PhoneticsWithoutSpaces".repeat(6));
    await tab.bringToFront();
    await hoverForPopup(tab, popup, "#verb");
    const longSource = await expectMetadata(value => value.ipa.includes("tabeɾɯ") && value.ipaSourceEllipsized);
    evidence.push(longSource.metadata.ipaFits);
  } finally {
    if (worker) await restoreMediaReplyProbe(worker);
    await editSettingsControls(settings, original);
    await setDictionaryAliasInSettings(settings, "hachidori-fixture", originalAlias);
    await settings.setViewport(originalViewport);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await tab.keyboard.press("Escape");
  }
  check("Live metadata Settings preserve Note and dictionary content while independently controlling frequency pitch grammar and IPA",
    evidence.length === 4 && evidence.every(Boolean), JSON.stringify(evidence));
}

async function checkReaderActivation(settings, tab, popup) {
  const original = await readSettingsControls(settings, [
    "opt-hover-enabled", "opt-lookup-mode", "opt-activation-key", "opt-hover-delay", "opt-hide-delay",
  ]);
  const edit = (values) => editSettingsControls(settings, values);
  const pause = (ms) => tab.evaluate((delay) => new Promise((resolveWait) => setTimeout(resolveWait, delay)), ms);
  const position = await (await tab.$("#verb")).boundingBox();
  const moveToWord = async () => {
    await tab.mouse.move(2, 2);
    await tab.mouse.move(position.x + position.width * 0.15, position.y + position.height / 2);
  };
  const generation = async () => settings.evaluate(async () =>
    (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" })).generation);
  const beforeGeneration = await generation();
  try {
    const opened = await hoverForPopup(tab, popup, "#verb");
    await edit({ "opt-hover-enabled": false });
    const closed = await popup.waitForHidden();
    await moveToWord();
    await pause(250);
    const disabled = !popup.visible(await popup.state());
    await edit({ "opt-hover-enabled": true });
    const reopened = await hoverForPopup(tab, popup, "#verb");
    check("hover enablement closes active popups and changes already-open tabs without reloading the engine",
      opened !== null && closed && disabled && reopened !== null && await generation() === beforeGeneration,
      JSON.stringify({ closed, disabled, reopened: reopened !== null }));

    await edit({ "opt-lookup-mode": "activation", "opt-activation-key": "K", "opt-hover-delay": "200", "opt-hide-delay": "400" });
    await popup.waitForHidden();
    await moveToWord();
    await pause(250);
    const gated = !popup.visible(await popup.state());
    await tab.keyboard.down("k");
    await pause(30);
    const delayed = !popup.visible(await popup.state());
    const activated = await popup.waitForVisible();
    await tab.keyboard.up("k");
    const retained = popup.visible(await popup.state());
    const released = await popup.waitForHidden();
    await tab.keyboard.down("k");
    await tab.keyboard.up("k");
    await pause(300);
    const cancelled = !popup.visible(await popup.state());
    const controls = await settings.evaluate(() => ({
      key: document.getElementById("opt-activation-key").value,
      disabled: document.getElementById("opt-activation-key").disabled,
      mode: document.getElementById("opt-lookup-mode").value,
    }));
    check("configured activation keys open stationary lookups and release them using the saved delays",
      gated && delayed && activated !== null && retained && released && cancelled
        && controls.key === "K" && controls.mode === "activation" && !controls.disabled,
      JSON.stringify({ gated, delayed, activated: activated !== null, retained, released, cancelled, controls }));
  } finally {
    await tab.keyboard.up("k");
    // Keep a non-default key in Hover mode to prove that mode changes preserve
    // it and that the exact setting survives the suite's full browser restart.
    await edit({ ...original, "opt-activation-key": "K" });
    await tab.keyboard.press("Escape");
  }
}

async function checkReaderSelection(browser, settings, tab, popup) {
  const original = await readSettingsControls(settings, [
    "opt-lookup-mode", "opt-activation-key", "opt-scan-length", "opt-japanese-only", "opt-hover-delay",
  ]);
  const originalVerb = await tab.$eval("#verb", (element) => element.innerHTML);
  const worker = await installMediaReplyProbe(browser);
  await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
  const lookups = () => worker.evaluate(() => globalThis.__ownedMediaProbe.lookups);
  const pause = () => tab.evaluate(() => new Promise((done) => setTimeout(done, 200)));
  const dismiss = async () => {
    await tab.keyboard.press("Escape");
    await tab.evaluate(() => {
      document.activeElement?.blur();
      window.getSelection().removeAllRanges();
    });
    await tab.mouse.move(2, 2);
    await pause();
  };
  const selectVerb = async (html) => {
    await dismiss();
    return tab.$eval("#verb", (element, contents) => {
      element.innerHTML = contents;
      const selection = window.getSelection();
      selection.selectAllChildren(element);
      return { visible: selection.toString(), raw: selection.getRangeAt(0).toString() };
    }, html);
  };
  const moveTo = async (selector) => {
    const box = await (await tab.$(selector)).boundingBox();
    await tab.mouse.move(2, 2);
    await tab.mouse.move(box.x + 4, box.y + box.height / 2);
    await pause();
  };
  try {
    await editSettingsControls(settings, {
      "opt-lookup-mode": "activation", "opt-scan-length": "1", "opt-japanese-only": true,
      "opt-hover-delay": "0",
    });
    await tab.bringToFront();
    await dismiss();
    await tab.$eval("#verb", (element) => { element.innerHTML = "<b>食べ</b><i>たかった</i>"; });
    const box = await (await tab.$("#verb")).boundingBox();
    const startCount = (await lookups()).length;
    await tab.mouse.move(box.x + 1, box.y + box.height / 2);
    await tab.mouse.down();
    let duringDrag;
    try {
      await tab.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
      duringDrag = (await lookups()).length === startCount;
    } finally {
      await tab.mouse.up();
    }
    const selected = await tab.evaluate(() => window.getSelection().toString());
    const exactPopup = await popup.waitForVisible();
    const exactRequests = (await lookups()).slice(startCount);
    const highlighted = await tab.evaluate((name) => Array.from(CSS.highlights.get(name) ?? [], (range) => ({
      text: range.toString(), startTag: range.startContainer.parentElement.localName,
      endTag: range.endContainer.parentElement.localName,
    })), HIGHLIGHT_NAME);
    const glossarySelection = await popup.selectGlossaryText();
    await pause();
    const glossaryRetained = glossarySelection.includes("to eat") && popup.visible(await popup.state())
      && (await lookups()).length === startCount + 1;
    const mutationHighlight = await tab.evaluate(async name => {
      const element = document.getElementById("verb");
      const first = [...CSS.highlights.get(name)][0];
      const selected = window.getSelection().toString();
      const unrelated = new Highlight();
      CSS.highlights.set("e17-page-owned", unrelated);
      try {
        element.innerHTML = element.innerHTML;
        await new Promise(done => requestAnimationFrame(done));
        const replacement = [...(CSS.highlights.get(name) || [])][0];
        const valid = replacement !== first && replacement?.toString() === "食べたかった";
        element.querySelector("b").firstChild.insertData(1, "別");
        await new Promise(done => requestAnimationFrame(done));
        return { valid, cleared: !CSS.highlights.has(name), selection: window.getSelection().toString() === selected,
          unrelated: CSS.highlights.get("e17-page-owned") === unrelated };
      } finally { CSS.highlights.delete("e17-page-owned"); }
    }, HIGHLIGHT_NAME);
    check("source highlights reconcile selected text mutations without changing selection",
      Object.values(mutationHighlight).every(Boolean), JSON.stringify(mutationHighlight));
    const hiddenText = await selectVerb('食べ<span style="display:none">隠し</span>たかった');
    const hiddenPopup = await popup.waitForVisible();
    const hiddenHighlight = await tab.evaluate((name) =>
      Array.from(CSS.highlights.get(name) ?? [], (range) => range.toString()), HIGHLIGHT_NAME);
    const hiddenQuery = (await lookups()).at(-1)?.text;
    const blockText = await selectVerb("<div>hello</div><div>world</div>");
    await pause();
    const blockQuery = (await lookups()).at(-1)?.text;
    await selectVerb("食べたかったXYZ");
    await pause();
    const prefixRejected = !popup.visible(await popup.state());
    const prefixQuery = (await lookups()).at(-1)?.text;
    check("exact selections override scan length, preserve cross-inline highlights and reject prefix-only matches",
      duringDrag && selected === "食べたかった" && exactPopup?.plain.includes("食べる")
        && exactRequests.length === 1 && exactRequests[0].text === selected && exactRequests[0].scanLength === 6
        && highlighted.some((range) => range.text === selected && range.startTag === "b" && range.endTag === "i")
        && glossaryRetained && hiddenText.visible === "食べたかった" && hiddenQuery === hiddenText.visible
        && hiddenPopup?.plain.includes("食べる") && hiddenHighlight.includes(hiddenText.raw)
        && blockText.visible === "hello\nworld" && blockQuery === blockText.visible
        && prefixRejected && prefixQuery === "食べたかったXYZ",
      JSON.stringify({ duringDrag, selected, exactRequests, highlighted, glossaryRetained,
        hiddenText, hiddenQuery, hiddenHighlight, blockText, blockQuery, prefixRejected, prefixQuery }));

    await dismiss();
    await editSettingsControls(settings, { "opt-lookup-mode": "hover", "opt-scan-length": "16" });
    await tab.$eval("#verb", (element) => {
      element.innerHTML = '<input value="食べたかった"><textarea>食べたかった</textarea>'
        + '<b contenteditable="true"><i>食べたかった</i></b>';
    });
    const editingStart = (await lookups()).length;
    const edits = [];
    for (const selector of ["#verb input", "#verb textarea", "#verb [contenteditable]"]) {
      await tab.focus(selector);
      await moveTo(selector);
      await tab.keyboard.press("End");
      await tab.keyboard.type("k");
      edits.push(await tab.$eval(selector, (element) => (element.value ?? element.textContent).endsWith("k")));
      await tab.$eval(selector, (element) => {
        if ("select" in element) element.select();
        else window.getSelection().selectAllChildren(element);
      });
      await pause();
      await dismiss();
    }
    for (const tag of ["input", "div"]) {
      await editSettingsControls(settings, { "opt-lookup-mode": "activation", "opt-activation-key": "K" });
      await tab.evaluate((name) => {
        const host = document.createElement("div");
        host.id = "shadow-editor";
        document.body.append(host);
        const innerHost = document.createElement("div");
        host.attachShadow({ mode: "open" }).append(innerHost);
        const editor = document.createElement(name);
        if (name === "div") editor.contentEditable = "true";
        innerHost.attachShadow({ mode: "open" }).append(editor);
        editor.focus();
      }, tag);
      await moveTo("#duplicate");
      await tab.keyboard.down("k");
      await pause();
      await tab.keyboard.up("k");
      await editSettingsControls(settings, { "opt-lookup-mode": "hover" });
      await moveTo("#duplicate");
      edits.push(await tab.evaluate(() => {
        const host = document.getElementById("shadow-editor");
        const editor = host.shadowRoot.firstChild.shadowRoot.firstChild;
        const typed = (editor.value ?? editor.textContent) === "k";
        editor.blur();
        host.remove();
        return typed;
      }));
      await dismiss();
    }
    // Neither range endpoint is editable: the interior control still excludes it.
    for (const editor of [
      '<button>べ</button>',
      '<b contenteditable="true" style="display:contents">べ</b>',
      '<span style="visibility:hidden"><b contenteditable="true" style="visibility:visible">べ</b></span>',
      '<b contenteditable="true" style="visibility:hidden">隠し<i style="visibility:visible">べ</i></b>',
    ]) {
      await selectVerb(`食${editor}たかった`);
      await moveTo("#verb");
    }
    const editingQuiet = (await lookups()).length === editingStart && !popup.visible(await popup.state());
    await dismiss();
    await tab.$eval("#verb", (element) => {
      element.innerHTML = '<b id="selection-boundary-start">食</b>'
        + '<div style="visibility:hidden"><b style="visibility:visible">べ</b></div>た';
    });
    await moveTo("#selection-boundary-start");
    const blockBoundary = (await lookups()).at(-1)?.text === "食";
    await dismiss();
    await tab.$eval("#verb", (element) => { element.innerHTML = '食<input type="hidden">べたかった'; });
    const hiddenPointerAccepted = await hoverForPopup(tab, popup, "#verb");
    await selectVerb('食べ<span style="display:none"><button>隠し</button></span>たかった');
    const hiddenControlAccepted = await popup.waitForVisible();
    check("editable controls preserve normal editing and suppress pointer and selection lookups",
      edits.every(Boolean) && editingQuiet && blockBoundary && hiddenControlAccepted?.plain.includes("食べる")
        && hiddenPointerAccepted?.plain.includes("食べる"),
      JSON.stringify({ edits, editingQuiet, blockBoundary, hiddenControlAccepted: hiddenControlAccepted !== null,
        hiddenPointerAccepted: hiddenPointerAccepted !== null }));

    await dismiss();
    const latinStart = (await lookups()).length;
    await moveTo("#latin");
    const japaneseOnly = (await lookups()).length === latinStart;
    await editSettingsControls(settings, { "opt-japanese-only": false });
    await pause();
    const latinRequests = (await lookups()).slice(latinStart);
    await editSettingsControls(settings, { "opt-japanese-only": true });
    const reenabledStart = (await lookups()).length;
    await moveTo("#latin");
    const gatedAgain = (await lookups()).length === reenabledStart;
    check("Japanese-only preferences change automatic scanning in an already-open tab",
      japaneseOnly && latinRequests.length === 1 && latinRequests[0].text === "hello world" && gatedAgain,
      JSON.stringify({ japaneseOnly, latinRequests, gatedAgain }));
  } finally {
    await dismiss();
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
    await editSettingsControls(settings, original);
    await restoreMediaReplyProbe(worker);
  }
}

async function checkSourceFallback(settings, tab, popup) {
  const original = await readSettingsControls(settings, ["opt-lookup-mode", "opt-scan-length", "opt-hover-delay"]);
  const sourceBefore = await tab.$eval("#verb", element => ({ html: element.innerHTML,
    style: element.getAttribute("style"), className: element.className }));
  const frame = () => tab.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const snapshot = async () => {
    await frame();
    const paint = await popup.sourcePaint("read", "#verb");
    const { source } = paint;
    const exact = paint.groups === 1 && paint.rects.length === source.expected.length && paint.rects.length > 0
      && paint.rects.every((rect, index) => rect.pointerEvents === "none"
        && ["left", "top", "right", "bottom"].every(key => Math.abs(rect[key] - source.expected[index][key]) < 1));
    return { paint, source, exact };
  };
  let restore;
  let evidence;
  try {
    await tab.keyboard.press("Escape");
    await editSettingsControls(settings, { "opt-lookup-mode": "hover", "opt-scan-length": "16", "opt-hover-delay": "0" });
    await tab.$eval("#verb", element => {
      getSelection().removeAllRanges();
      element.innerHTML = '前<b id="e17-source" style="padding:0 4px">食べ</b><i>たかった</i>後';
      element.classList.add("gsm-hoshidicts-source-match");
      element.style.cssText = "width:180px;overflow:hidden;white-space:nowrap;border:3px solid #888;padding:0 8px";
      const paragraph = element.parentElement;
      const box = document.createElement("div");
      box.id = "e17-source-box";
      box.style.cssText = "height:300px;display:flow-root";
      const sibling = document.createElement("div");
      sibling.id = "e17-source-sibling";
      sibling.style.height = "96px";
      sibling.textContent = "spacer";
      paragraph.replaceWith(box);
      box.append(sibling, paragraph);
    });
    await tab.bringToFront();
    const opened = await hoverForPopup(tab, popup, "#e17-source");
    restore = await forceSourceFallback(tab, settings);
    const initial = await snapshot();
    if (process.env.HACHIDORI_HIGHLIGHT_SCREENSHOT) await tab.screenshot({ path: process.env.HACHIDORI_HIGHLIGHT_SCREENSHOT });
    await tab.$eval("#verb", element => { element.scrollLeft = 45; });
    const scrolled = await snapshot();
    await tab.$eval("#verb", element => { element.style.width = "110px"; });
    const resized = await snapshot();
    await tab.$eval("#verb", element => { element.style.visibility = "hidden"; });
    await frame();
    const hidden = await popup.sourcePaint();
    await tab.$eval("#verb", element => { element.style.visibility = "visible"; element.style.opacity = "0"; });
    await frame();
    const transparent = await popup.sourcePaint();
    await tab.$eval("#verb", element => { element.style.opacity = "1"; });
    const visible = await snapshot();
    const motion = [];
    for (const kind of ["transition", "animation", "resume", "finish", "cancel", "waapi", "waapi-finish", "waapi-cancel"]) {
      if (kind.startsWith("waapi")) await new Promise(done => setTimeout(done, 350));
      await tab.$eval("#verb", (element, mode) => {
        if (mode.startsWith("waapi")) {
          const target = mode === "waapi" ? element.parentElement : element;
          const animation = target.animate([{ transform: "translateX(0)" }, { transform: "translateX(90px)" }],
            { duration: 1200, fill: "forwards" });
          if (mode !== "waapi") { animation.pause(); animation.currentTime = 500; }
          return;
        }
        if (mode === "transition") {
          element.style.transition = "transform 1s linear";
          element.getBoundingClientRect();
          element.style.transform = "translateX(90px)";
        } else {
          const style = document.createElement("style");
          style.id = "e17-animation";
          style.textContent = "@keyframes e17-move { to { transform: translateX(90px); } }"
            + "#verb:focus { animation-play-state: running !important; }";
          document.head.append(style);
          if (mode === "animation") element.parentElement.style.animation = "e17-move 1s linear";
          else {
            element.tabIndex = 0;
            element.style.animation = "e17-move 1s linear forwards paused";
            if (mode === "finish" || mode === "cancel") element.getAnimations()[0].currentTime = 500;
          }
        }
      }, kind);
      if (kind === "resume") {
        await frame();
        await tab.$eval("#verb", element => element.focus({ preventScroll: true }));
      }
      if (kind.startsWith("waapi")) await new Promise(done => setTimeout(done, 350));
      await tab.waitForFunction(mode => {
        const source = document.getElementById("verb");
        return (mode === "animation" || mode === "waapi" ? source.parentElement : source).getAnimations()
          .some(animation => animation.currentTime >= 150 && animation.currentTime < 800);
      }, {}, kind);
      motion.push(await snapshot());
      if (["finish", "cancel", "waapi-finish", "waapi-cancel"].includes(kind)) {
        await tab.$eval("#verb", (element, operation) => element.getAnimations().forEach(animation => animation[operation]()),
          kind.replace("waapi-", ""));
        motion.push(await snapshot());
      }
      await tab.$eval("#verb", async element => {
        await Promise.all([...element.getAnimations(), ...element.parentElement.getAnimations()].map(animation => animation.finished));
        [...element.getAnimations(), ...element.parentElement.getAnimations()].forEach(animation => animation.cancel());
        element.style.transition = "none";
        element.style.transform = "none";
        element.style.removeProperty("animation");
        element.blur();
        element.removeAttribute("tabindex");
        element.parentElement.style.removeProperty("animation");
        document.getElementById("e17-animation")?.remove();
      });
      await frame();
    }
    check("fallback source paint tracks CSS transitions and animated ancestors",
      motion.every(value => value.exact), JSON.stringify(motion));
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "Keep the source layout test open" });
    // Keep the pointer away: a stationary pointer over moving source text can
    // synthesize pointerout and accidentally hide missing layout observation.
    await tab.mouse.move(2, 2);
    await frame();
    const fixedBefore = await tab.$eval("#e17-source-box", box => box.getBoundingClientRect().toJSON());
    await tab.$eval("#e17-source-sibling", sibling => { sibling.style.height = "20px"; });
    const siblingStyle = await snapshot();
    await tab.$eval("#e17-source-sibling", sibling => { sibling.style.height = "auto"; });
    await frame();
    await tab.$eval("#e17-source-sibling", sibling => { sibling.firstChild.data = ""; });
    const siblingText = await snapshot();
    const fixedAfter = await tab.$eval("#e17-source-box", box => box.getBoundingClientRect().toJSON());
    check("fallback source paint follows sibling layout changes inside fixed-size ancestors",
      siblingStyle.exact && siblingText.exact && JSON.stringify(fixedBefore) === JSON.stringify(fixedAfter)
        && siblingStyle.source.expected[0].top !== siblingText.source.expected[0].top,
      JSON.stringify({ fixedBefore, fixedAfter, siblingStyle, siblingText }));
    const area = rect => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
    const overlap = (a, b) => area({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right),
      top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });
    const uncovered = await snapshot();
    const sourceRect = uncovered.source.expected[0];
    const covers = [];
    for (const kind of ["partial", "pointer-none", "modal", "sticky", "border", "fixed-escape", "motion",
      "membership", "membership-paused", "membership-late", "membership-overlap", "membership-waapi", "behind"]) {
      if (kind === "membership-late") await editSettingsControls(settings, { "opt-source-highlight": false });
      await tab.evaluate(({ source, kind }) => {
        const element = document.createElement("div");
        element.id = "e17-page-cover";
        const small = kind === "modal";
        const left = source.left + (small ? 20 : -10), top = source.top + (small ? 8 : -8);
        const width = small ? 12 : 220, height = small ? 12 : kind === "partial" ? 18 : 48;
        element.style.cssText = `position:${kind === "sticky" ? "absolute" : "fixed"};left:${left}px;top:${top}px;`
          + `width:${width}px;height:${height}px;background:white;z-index:${kind === "behind" ? -1 : 100};`
          + (kind === "pointer-none" ? "pointer-events:none;" : "");
        let painted = element;
        if (kind === "sticky") {
          element.style.background = "transparent";
          element.style.overflow = "auto";
          painted = document.createElement("div");
          painted.style.cssText = `position:sticky;top:0;height:${height}px;background:white`;
          element.append(painted);
        }
        if (kind === "border") {
          element.style.height = "8px";
          element.style.borderBottom = "18px solid white";
          element.style.overflow = "hidden";
        }
        if (kind === "fixed-escape") {
          painted = element.cloneNode();
          painted.removeAttribute("id");
          element.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden";
          element.append(painted);
        }
        document.body.append(element);
        painted.dataset.e17PaintedCover = "";
        if (kind === "motion") {
          element.style.transition = "transform 1s linear";
          element.getBoundingClientRect();
          element.style.transform = "translateX(160px)";
        }
        if (kind.startsWith("membership")) {
          const style = document.createElement("style");
          style.textContent = "@keyframes e17-cover { from { position:static; } to { position:fixed; } }"
            + "@keyframes e17-other { from { opacity:1; } to { opacity:1; } }";
          element.append(style);
          element.style.position = "static";
          if (kind !== "membership-waapi") element.style.animation = "e17-cover 1s linear forwards";
          if (kind === "membership-overlap") element.style.animation += ", e17-other 0.2s linear";
        }
      }, { source: sourceRect, kind });
      let initiallyUncovered = true;
      if (kind.startsWith("membership")) {
        if (kind === "membership-late") {
          await tab.waitForFunction(() => document.getElementById("e17-page-cover").getAnimations()
            .some(animation => animation.currentTime > 0 && animation.currentTime < 400));
          await tab.$eval("#e17-page-cover", element => element.getAnimations().forEach(animation => animation.pause()));
          await editSettingsControls(settings, { "opt-source-highlight": true });
        }
        initiallyUncovered = (await snapshot()).exact;
        if (kind === "membership-waapi") {
          await new Promise(done => setTimeout(done, 350));
          await tab.$eval("#e17-page-cover", element => {
            element.animate([{ position: "static" }, { position: "fixed" }], { duration: 1200, fill: "forwards" });
          });
        }
        if (kind === "membership-late") await tab.$eval("#e17-page-cover", element => element.getAnimations().forEach(animation => animation.play()));
        if (kind !== "membership") {
          await tab.waitForFunction(() => document.getElementById("e17-page-cover").getAnimations()
            .some(animation => animation.currentTime >= 650 && animation.currentTime < 950));
          await tab.$eval("#e17-page-cover", element => element.getAnimations().forEach(animation => animation.pause()));
        } else await tab.$eval("#e17-page-cover", element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      }
      if (kind === "motion") await tab.waitForFunction(() => document.querySelector("[data-e17-painted-cover]").getAnimations()
        .some(animation => animation.currentTime >= 300 && animation.currentTime < 800));
      const current = await snapshot();
      const cover = current.source.cover;
      const expectedArea = uncovered.source.expected.reduce((total, rect) => total + area(rect)
        - (kind === "behind" ? 0 : overlap(rect, cover)), 0);
      const actualArea = current.paint.rects.reduce((total, rect) => total + area(rect), 0);
      const bounded = current.paint.rects.every(rect => uncovered.source.expected.some(source =>
        overlap(rect, source) >= area(rect) - 1) && (kind === "behind" || overlap(rect, cover) < 1));
      await tab.$eval("#e17-page-cover", element => element.remove());
      const restored = await snapshot();
      covers.push({ kind, expectedArea, actualArea, bounded, initiallyUncovered, restored: restored.exact });
    }
    check("fallback source paint stays beneath page headers and overlays",
      covers.every(value => value.bounded && value.initiallyUncovered && value.restored && Math.abs(value.expectedArea - value.actualArea) < 2),
      JSON.stringify(covers));
    const stylesheetSource = await tab.$eval("#verb", element => element.getBoundingClientRect().toJSON());
    const styleChanges = [];
    for (const kind of ["insert", "declaration", "adopted", "load", "media-nested", "media-sheet"]) {
      let stylesSession;
      let pendingStyle;
      try {
        if (kind.startsWith("media-")) await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        if (kind === "load") {
          stylesSession = await tab.createCDPSession();
          pendingStyle = new Promise(done => stylesSession.once("Fetch.requestPaused", done));
          await stylesSession.send("Fetch.enable", { patterns: [{ urlPattern: "*/e17-late.css" }] });
        }
        const css = await tab.evaluate(({ source, kind }) => {
          const element = document.createElement("div");
          element.id = "e17-page-cover";
          element.dataset.e17PaintedCover = "";
          // Cover the measured source rather than assuming a font's glyph
          // height: Japanese serif fallback can exceed the old 40px interior.
          element.style.cssText = `width:${source.width + 20}px;height:${source.height + 16}px;background:white;z-index:100`;
          document.body.append(element);
          const initial = "#e17-page-cover { position:absolute;left:-1000px;top:0; }";
          const css = `#e17-page-cover { position:fixed;left:${source.left - 10}px;top:${source.top - 8}px; }`;
          if (kind === "adopted") {
            window.e17TestSheet = new CSSStyleSheet();
            window.e17TestSheet.replaceSync(initial);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, window.e17TestSheet];
          } else {
            const style = document.createElement("style");
            style.id = "e17-page-style";
            style.textContent = initial;
            if (kind === "media-nested") style.textContent += `@supports (display:block) { @media (prefers-color-scheme:dark) { ${css} } }`;
            document.head.append(style);
            window.e17TestSheet = style.sheet;
          }
          if (kind === "media-sheet") {
            const style = document.createElement("style");
            style.id = "e17-media-style";
            style.media = "(prefers-color-scheme:dark)";
            style.textContent = css;
            document.head.append(style);
          }
          if (kind === "load") {
            const link = document.createElement("link");
            link.id = "e17-late-style";
            link.rel = "stylesheet";
            link.href = "/e17-late.css";
            document.head.append(link);
          }
          return css;
        }, { source: stylesheetSource, kind });
        const before = await snapshot();
        if (stylesSession) {
          const request = await pendingStyle;
          await stylesSession.send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/css" }], body: Buffer.from(css).toString("base64") });
        } else if (kind.startsWith("media-")) await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
        else await tab.evaluate(({ css, kind }) => {
          const sheet = window.e17TestSheet;
          if (kind === "insert") sheet.insertRule(css, sheet.cssRules.length);
          else if (kind === "adopted") sheet.replaceSync(css);
          else sheet.cssRules[0].style.cssText = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
        }, { css, kind });
        await new Promise(done => setTimeout(done, 350));
        const changed = await snapshot();
        const fullyCovered = changed.source.expected.every(rect =>
          overlap(rect, changed.source.cover) >= area(rect) - 1);
        styleChanges.push({ kind, before: before.exact, fullyCovered,
          covered: changed.paint.groups === 1 && changed.paint.rects.length === 0 });
      } finally {
        await stylesSession?.detach();
        await tab.evaluate(() => {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== window.e17TestSheet);
          delete window.e17TestSheet;
          for (const id of ["e17-page-cover", "e17-page-style", "e17-late-style", "e17-media-style"]) document.getElementById(id)?.remove();
        });
        if (kind.startsWith("media-")) await tab.emulateMediaFeatures([]);
      }
      styleChanges.at(-1).restored = (await snapshot()).exact;
    }
    check("fallback source paint refreshes after stylesheet loading and CSSOM edits",
      styleChanges.every(value => value.before && value.fullyCovered && value.covered && value.restored), JSON.stringify(styleChanges));
    await tab.keyboard.press("Escape"); // Close the unsaved Note draft first.
    await tab.keyboard.press("Escape");
    await frame();
    const closed = await popup.sourcePaint();
    const snapshots = [initial, scrolled, resized, visible];
    evidence = { opened: !!opened, initial, scrolled, resized, hidden, transparent, visible, closed };
    check("fallback source paint stays exact through clipping, scrolling, visibility and cleanup",
      !!opened && snapshots.every(value => value.exact && value.source.html === initial.source.html
        && value.source.className === initial.source.className && value.source.selection === initial.source.selection)
        && initial.paint.rects[0].left !== scrolled.paint.rects[0].left
        && hidden.rects.length === 0 && transparent.rects.length === 0 && closed.groups === 0,
      JSON.stringify(evidence));
  } finally {
    if (restore) await restore();
    await tab.$eval("#verb", (element, value) => {
      element.innerHTML = value.html;
      element.className = value.className;
      document.getElementById("e17-source-box")?.replaceWith(element.parentElement);
      document.getElementById("e17-page-cover")?.remove();
      if (value.style === null) element.removeAttribute("style"); else element.setAttribute("style", value.style);
    }, sourceBefore);
    await editSettingsControls(settings, original);
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
      // Chromium's clocked fake output device: native decode/play/ended still
      // run when the host has no audio device. This does not bypass autoplay.
      "--disable-audio-output",
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

  // The first-run installer downloads the four catalogue archives from inside
  // the offscreen engine, so those fetches are answered on the offscreen target's
  // Fetch domain before the run can start. The first archive is held until the
  // clean-profile checks have run; the second attempt of jmnedict succeeds; Bee's
  // omits Content-Length so its progress must stay indeterminate.
  const SETUP_PADDING_BYTES = 4 * 1024 * 1024;
  const setupArchives = {
    fixtures: new Map(RECOMMENDED_DICTIONARIES.map((entry) => [entry.downloadUrl, {
      entry, body: buildRecommendedZip({ ...entry, paddingBytes: entry.sourceId === "jmnedict" ? 0 : SETUP_PADDING_BYTES }),
    }])),
    requests: [],
    attempts: new Map(),
    sessions: [],
    attached: new WeakSet(),
    release: null,
    held: null,
  };
  setupArchives.held = new Promise((resolve) => { setupArchives.release = resolve; });
  async function interceptSetupArchives(target) {
    if (!target.url().endsWith("offscreen.html") || setupArchives.attached.has(target)) return;
    setupArchives.attached.add(target);
    try {
      const session = await target.createCDPSession();
      setupArchives.sessions.push(session);
      session.on("Fetch.requestPaused", (event) => {
        void (async () => {
          const route = setupArchives.fixtures.get(event.request.url);
          if (!route) {
            await session.send("Fetch.continueRequest", { requestId: event.requestId });
            return;
          }
          const attempt = (setupArchives.attempts.get(route.entry.sourceId) ?? 0) + 1;
          setupArchives.attempts.set(route.entry.sourceId, attempt);
          setupArchives.requests.push(route.entry.sourceId);
          if (route.entry.sourceId === "jitendex" && attempt === 1) await setupArchives.held;
          const responseHeaders = [
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Content-Type", value: "application/zip" },
            { name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          ];
          if (route.entry.sourceId === "jmnedict" && attempt === 1) {
            await session.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 503, responseHeaders,
              body: Buffer.from("mocked publisher failure").toString("base64") });
            return;
          }
          if (route.entry.sourceId !== "bees-ultimate-kanji-dictionary") {
            responseHeaders.push({ name: "Content-Length", value: String(route.body.length) });
          }
          await session.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders,
            body: Buffer.from(route.body).toString("base64") });
        })().catch(async (error) => {
          diagnostics.push(`[setup archive mock] ${error?.stack ?? error}`);
          await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }).catch(() => {});
        });
      });
      await session.send("Fetch.enable", {
        patterns: [...setupArchives.fixtures.keys()].map((urlPattern) => ({ urlPattern, requestStage: "Request" })),
      });
    } catch (error) {
      diagnostics.push(`[setup archive mock] could not attach: ${error?.message ?? error}`);
    }
  }

  const watchedServiceWorkers = new Map();
  function watch(browser) {
    browser.on("targetcreated", async target => {
      watchOffscreen(target);
      void interceptSetupArchives(target);
      try {
        const worker = await target.worker?.();
        worker?.on?.("console", m => diagnostics.push(`[sw] ${m.text()}`));
        if (worker && target.type() === "service_worker") {
          watchedServiceWorkers.set(target, worker);
        }
      } catch { /* not a worker target */ }
    });
    // The offscreen target is created with an empty URL and named afterwards.
    browser.on("targetchanged", target => { void interceptSetupArchives(target); });
    browser.on("targetdestroyed", target => watchedServiceWorkers.delete(target));
    // The offscreen document is created from onInstalled, which can win the race
    // against the listener above.
    for (const target of browser.targets()) {
      watchOffscreen(target);
      void interceptSetupArchives(target);
    }
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
      heading: document.querySelector(".brand-context")?.textContent?.trim() ?? "",
      brand: document.querySelector(".brand span")?.textContent?.trim() ?? "",
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
  // ---------------------------------------------------------- first-run setup
  // chrome.runtime.onInstalled fired with reason "install" for this clean
  // profile, so the extension itself opened startup.html and its installer is
  // already waiting on the held first archive request.
  await showSettingsSection(page, "add-dictionaries");
  // Settings renders the starter card once its first dictionary-state read answers.
  await page.waitForFunction(() => document.getElementById("recommended-starter")?.hidden === false,
    { timeout: 90_000, polling: 100 }).catch(() => {});
  const cleanInstaller = await page.evaluate(() => ({
    starterHidden: document.getElementById("recommended-starter")?.hidden,
    installText: document.getElementById("install-recommended")?.textContent?.trim() ?? "",
    retryHidden: document.getElementById("recommended-retry")?.hidden,
    localInputVisible: document.getElementById("import-file")?.checkVisibility() === true,
    dictionaryManagementVisible: document.getElementById("dict-list")?.closest(".card")?.hidden !== true,
  }));
  check(
    "a clean profile shows one recommended install action beside local import",
    cleanInstaller.starterHidden === false
      && cleanInstaller.installText === "Install recommended"
      && cleanInstaller.retryHidden === true
      && cleanInstaller.localInputVisible === true
      && cleanInstaller.dictionaryManagementVisible === false,
    JSON.stringify(cleanInstaller),
  );

  const startupUrl = `chrome-extension://${extensionId}/startup.html`;
  const startupTabs = () => browser.targets().filter((target) =>
    target.type() === "page" && target.url() === startupUrl).length;
  const startupTarget = await browser.waitForTarget((target) =>
    target.type() === "page" && target.url() === startupUrl, { timeout: 30_000 }).catch(() => null);
  const startup = startupTarget === null ? null : await startupTarget.page();
  const watchStartup = (target) => {
    target.on("console", (m) => diagnostics.push(`[startup] ${m.type()}: ${m.text()}`));
    target.on("pageerror", (e) => diagnostics.push(`[startup] pageerror: ${e.message}`));
  };
  if (startup) watchStartup(startup);
  const readStartup = () => ({
    title: document.title,
    heading: document.getElementById("setup-heading")?.textContent ?? "",
    currentStep: document.querySelector('.setup-step[aria-current="step"]')?.dataset.stage ?? null,
    steps: [...document.querySelectorAll(".setup-step")].map((step) => step.textContent.trim().replace(/^\d\s*/u, "")),
    done: document.querySelectorAll(".setup-step.is-done").length,
    rows: [...document.querySelectorAll(".setup-dictionary")].map((row) => [row.dataset.sourceId,
      row.querySelector(".setup-dictionary-status")?.textContent ?? "",
      row.querySelector(".setup-track:not([hidden])")?.classList.contains("is-determinate") ?? null,
      row.querySelector(".setup-track:not([hidden])")?.getAttribute("aria-valuenow") ?? row.querySelector(".setup-track:not([hidden])")?.getAttribute("aria-valuetext") ?? null]),
    importLink: document.querySelector('#setup-body a[href="settings.html#add-dictionaries"]') !== null,
    settingsLink: document.querySelector('a[href="settings.html"]') !== null,
    actions: [...document.querySelectorAll("#setup-actions button")].map((control) => [control.id, control.textContent]),
    status: document.getElementById("setup-status")?.textContent ?? "",
    countdown: document.getElementById("setup-countdown-label")?.textContent ?? null,
    focused: document.activeElement?.id ?? "",
    background: getComputedStyle(document.body).backgroundColor,
    cardBackground: getComputedStyle(document.getElementById("setup-card")).backgroundColor,
  });
  // The startup page re-renders its controls on every storage change and
  // progress event. Click inside the page so a handle resolved before a
  // re-render cannot go stale, keeping the user-clickable requirement
  // Puppeteer's handle click would have enforced.
  const clickStartupControl = (id) => startup.evaluate((controlId) => {
    const control = document.getElementById(controlId);
    if (!control || control.disabled || !control.checkVisibility()) throw new Error(`#${controlId} is not user-clickable`);
    control.click();
  }, id);
  // Extension pages forbid eval, so the page state is read with a plain
  // evaluate and awaited from here rather than through a stringified predicate.
  const waitStartup = async (predicate, timeout) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await startup.evaluate(readStartup).catch(() => null);
      if (state !== null && predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  };
  // The engine boots first; the held request means Jitendex sits in Downloading.
  const startupShell = startup === null ? null
    : await waitStartup((state) => state.rows[0]?.[1]?.startsWith("Downloading"), 120_000);
  let skippedToSetup = null;
  if (startup) {
    await startup.bringToFront();
    await startup.focus(".skip-link");
    await startup.keyboard.press("Enter");
    skippedToSetup = await startup.evaluate(() => ({ url: location.href, focused: document.activeElement?.id }));
  }
  // The row turns to Downloading when the import is dispatched; the archive
  // request itself follows once the engine has validated the request.
  for (let attempt = 0; attempt < 200 && setupArchives.requests.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const settingsPalette = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    surface: getComputedStyle(document.querySelector(".page")).backgroundColor,
  }));
  const firstInstallStorage = await page.evaluate(async () => {
    const stored = await chrome.storage.local.get(["setupState", "options", "dictionaryState"]);
    return { ...stored, effective: globalThis.HDReaderOptions.normaliseOptions(stored.options) };
  });
  const seededOptions = firstInstallStorage.options ?? {};
  const effective = firstInstallStorage.effective ?? {};
  const seededInSettings = await page.waitForFunction(() =>
    document.getElementById("opt-compact-summary")?.checked === true
      && document.getElementById("opt-summary-count")?.value === "3",
  { timeout: 30_000, polling: 100 }).then(() => true).catch(() => false);
  check(
    "a fresh install opens one startup tab at the dictionary stage with first-install preferences",
    startupTabs() === 1 && seededInSettings
      && skippedToSetup?.url === startupUrl && skippedToSetup.focused === "setup-heading"
      && startupShell?.title === "Set up Hachidori"
      && startupShell.heading === "Installing default dictionaries…"
      && startupShell.currentStep === "dictionaries" && startupShell.done === 0
      && JSON.stringify(startupShell.steps) === JSON.stringify(["Dictionaries", "Anki Optional", "Try it"])
      && JSON.stringify(startupShell.rows) === JSON.stringify([
        ["jitendex", "Downloading… 0 KB", false, "Downloading… 0 KB"],
        ["jmnedict", "Waiting", null, null],
        ["bees-ultimate-kanji-dictionary", "Waiting", null, null],
        ["jiten", "Waiting", null, null],
      ])
      && startupShell.importLink && startupShell.settingsLink && startupShell.actions.length === 0
      && startupShell.status === "Installing default dictionaries…"
      && startupShell.background === settingsPalette.background
      && startupShell.cardBackground === settingsPalette.surface
      && firstInstallStorage.setupState?.stage === "dictionaries"
      && firstInstallStorage.setupState.revision === 1
      && firstInstallStorage.setupState.completedAt === null
      && JSON.stringify(firstInstallStorage.setupState.dictionaries?.outcomes) === "{}"
      && firstInstallStorage.setupState.dictionaries.totalSeconds === null
      && firstInstallStorage.setupState.dictionaries.continued === false
      && JSON.stringify(firstInstallStorage.setupState.dictionaries.selectionsApplied) === "[]"
      && (firstInstallStorage.dictionaryState?.dictionaries?.length ?? 0) === 0
      && JSON.stringify(Object.keys(seededOptions).sort()) === JSON.stringify(
        ["compactDefinitionSummaryCount", "revision", "showCompactDefinitionSummary"],
      )
      && seededOptions.showCompactDefinitionSummary === true && seededOptions.compactDefinitionSummaryCount === 3
      && seededOptions.revision === 1
      && effective.popupTheme === "default" && effective.popupOpacityPercent === 85
      && effective.audioAutoplay === false
      && JSON.stringify(effective.audioSources?.map((source) => [source.type, source.enabled]))
        === JSON.stringify([["text-to-speech-reading", true]])
      && JSON.stringify(setupArchives.requests) === JSON.stringify(["jitendex"]),
    JSON.stringify({ startupTabs: startupTabs(), skippedToSetup, seededInSettings, startupShell, settingsPalette, firstInstallStorage, requests: setupArchives.requests }),
  );
  if (startup && (process.env.HACHIDORI_STARTUP_SCREENSHOT || process.env.HACHIDORI_STARTUP_DARK_SCREENSHOT)) {
    await startup.setViewport({ width: 900, height: 820 });
    for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_DARK_SCREENSHOT]]) {
      if (!path) continue;
      await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await startup.screenshot({ path });
    }
    await startup.emulateMediaFeatures([]);
  }

  const resumeVisible = await page.evaluate(() => {
    const link = document.getElementById("setup-resume");
    return {
      hidden: link?.hidden, visible: link?.checkVisibility() === true, href: link?.href ?? "",
      insideNavigation: link?.closest(".settings-nav") !== null, text: link?.textContent?.trim() ?? "",
    };
  });
  check(
    "Settings shows Resume setup while first-run setup is incomplete",
    resumeVisible.hidden === false && resumeVisible.visible && resumeVisible.href === startupUrl
      && !resumeVisible.insideNavigation && resumeVisible.text === "Resume setup",
    JSON.stringify(resumeVisible),
  );

  // The user turns the seeded compact summary off through the revisioned options
  // write Settings uses; the edit must be the value that persists, and the
  // remaining assertions keep their historical popup layout. The Design view is
  // left unopened so its lazy-preview assertion below still starts cold.
  const editedPreference = await page.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      requestId: "first-run-edit", baseRevision: options.revision, options: { showCompactDefinitionSummary: false } });
    return reply.ok ? reply.options : { error: reply.error };
  });

  // A reconnecting page rejoins the same run: the held request is still the only one.
  let reconnected = null;
  if (startup !== null) {
    await startup.reload({ waitUntil: "domcontentloaded" });
    reconnected = await waitStartup((state) => state.rows[0]?.[1]?.startsWith("Downloading"), 30_000);
  }
  const setupStateWhileHeld = await page.evaluate(async () => (await chrome.storage.local.get("setupState")).setupState);
  check(
    "a reconnecting startup page rejoins the running installer whose held download stays indeterminate",
    reconnected?.heading === "Installing default dictionaries…"
      && JSON.stringify(reconnected.rows[0]) === JSON.stringify(["jitendex", "Downloading… 0 KB", false, "Downloading… 0 KB"])
      && reconnected.rows.slice(1).every((row) => row[1] === "Waiting")
      && JSON.stringify(setupArchives.requests) === JSON.stringify(["jitendex"])
      && JSON.stringify(setupStateWhileHeld?.dictionaries?.outcomes) === JSON.stringify({})
      && startupTabs() === 1,
    JSON.stringify({ reconnected, requests: setupArchives.requests, setupStateWhileHeld }),
  );

  // Release the held archive: Jitendex and Jiten arrive with a declared length,
  // Bee's without one, and jmnedict's publisher fails once. The installer's
  // broadcasts are recorded in the page so phase order does not depend on
  // polling luck; the polled rows still show what the user saw.
  if (startup !== null) {
    await startup.evaluate(() => {
      window.__setupEvents = [];
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.target === "hachidori-setup-events") window.__setupEvents.push(message);
      });
      // Every render of the rows, not only the ones a poll happens to catch.
      window.__rowLog = [];
      const rows = () => [...document.querySelectorAll(".setup-dictionary")].map((row) => [row.dataset.sourceId,
        row.querySelector(".setup-dictionary-status")?.textContent ?? "",
        row.querySelector(".setup-track:not([hidden])")?.classList.contains("is-determinate") ?? null,
        row.querySelector(".setup-track:not([hidden])")?.getAttribute("aria-valuenow") ?? row.querySelector(".setup-track:not([hidden])")?.getAttribute("aria-valuetext") ?? null]);
      new MutationObserver(() => window.__rowLog.push(rows())).observe(document.getElementById("setup-body"), { childList: true, subtree: true, characterData: true });
    });
  }
  setupArchives.release();
  const phases = [];
  const runOutcome = startup === null ? null : await (async () => {
    const deadline = Date.now() + 120_000;
    let last = null;
    while (Date.now() < deadline) {
      const state = await startup.evaluate(readStartup).catch(() => null);
      if (state !== null) {
        const key = JSON.stringify(state.rows);
        if (phases.at(-1)?.key !== key) phases.push({ key, rows: state.rows, heading: state.heading, status: state.status });
        last = state;
        if (state.heading.startsWith("Some dictionaries")) return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return last;
  })();
  const rowLog = startup === null ? [] : await startup.evaluate(() => window.__rowLog ?? []);
  const seenPhase = (sourceId, predicate) => rowLog.some((rows) => rows.some((row) => row[0] === sourceId && predicate(row)));
  const setupEvents = startup === null ? [] : await startup.evaluate(() => window.__setupEvents ?? []);
  const entryEvents = (sourceId) => setupEvents.map((event) => event.entries.find((entry) => entry.sourceId === sourceId)).filter(Boolean);
  const phaseOrder = (sourceId) => [...new Set(entryEvents(sourceId).map((entry) => entry.phase))];
  const jitendexBytes = setupArchives.fixtures.get(RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "jitendex").downloadUrl).body.length;
  const afterRun = await page.evaluate(async () => chrome.storage.local.get(["setupState", "options", "dictionaryState"]));
  const runOutcomes = afterRun.setupState?.dictionaries?.outcomes ?? {};
  const installedTitles = (afterRun.dictionaryState?.dictionaries ?? []).map((dictionary) => [dictionary.sourceId, dictionary.title]).sort();
  check(
    "the automatic installer continues after a mocked failure through real download and installation phases",
    runOutcome?.heading === "Some dictionaries could not be installed"
      && JSON.stringify(runOutcome.rows.map((row) => [row[0], row[1].replace(/\d+(\.\d+)? seconds/u, "N seconds")])) === JSON.stringify([
        ["jitendex", "Installed in N seconds"],
        ["jmnedict", "Failed: could not read JMnedict.zip: HTTP 503"],
        ["bees-ultimate-kanji-dictionary", "Installed in N seconds"],
        ["jiten", "Installed in N seconds"],
      ])
      && JSON.stringify(runOutcome.actions) === JSON.stringify([["setup-retry", "Retry missing dictionaries"], ["setup-continue", "Continue setup"]])
      && runOutcome.countdown === null && runOutcome.importLink
      // Each installed entry moved waiting → downloading → installing → installed in order (Jitendex was
      // already downloading when recording began); the declared length made Jitendex's download
      // comparable while Bee's stayed indeterminate.
      && JSON.stringify(phaseOrder("jitendex")) === JSON.stringify(["downloading", "installing", "installed"])
      && JSON.stringify(phaseOrder("bees-ultimate-kanji-dictionary")) === JSON.stringify(["waiting", "downloading", "installing", "installed"])
      && JSON.stringify(phaseOrder("jmnedict")) === JSON.stringify(["waiting", "downloading", "failed"])
      && entryEvents("jitendex").filter((entry) => entry.phase === "downloading").every((entry) => entry.totalBytes === null || entry.totalBytes === jitendexBytes)
      && entryEvents("jitendex").some((entry) => entry.phase === "downloading" && entry.totalBytes === jitendexBytes && entry.receivedBytes === jitendexBytes)
      && entryEvents("bees-ultimate-kanji-dictionary").every((entry) => entry.totalBytes === null)
      && entryEvents("bees-ultimate-kanji-dictionary").some((entry) => entry.phase === "downloading" && entry.receivedBytes > 0)
      // The rows the user saw: a determinate percentage for Jitendex, received bytes only for Bee's.
      && seenPhase("jitendex", (row) => row[2] === true && /\(\d+%\)$/u.test(row[1]))
      && !seenPhase("bees-ultimate-kanji-dictionary", (row) => row[2] === true)
      && seenPhase("bees-ultimate-kanji-dictionary", (row) => /^Downloading… [\d.]+ (KB|MB)$/u.test(row[1]) && row[3] === row[1])
      && JSON.stringify(setupArchives.requests) === JSON.stringify(RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId))
      && ["jitendex", "bees-ultimate-kanji-dictionary", "jiten"].every((sourceId) => runOutcomes[sourceId]?.status === "installed" && runOutcomes[sourceId].seconds > 0)
      && runOutcomes.jmnedict?.status === "failed" && runOutcomes.jmnedict.error === "could not read JMnedict.zip: HTTP 503"
      && afterRun.setupState.dictionaries.totalSeconds > 0 && afterRun.setupState.dictionaries.continued === false
      && afterRun.setupState.stage === "dictionaries"
      && JSON.stringify(installedTitles) === JSON.stringify(RECOMMENDED_DICTIONARIES.filter(({ sourceId }) => sourceId !== "jmnedict")
        .map(({ sourceId, title }) => [sourceId, title]).sort())
      && startupTabs() === 1,
    JSON.stringify({ runOutcome, rowLog, phases: phases.map(({ rows, status }) => [rows, status]), afterRun, requests: setupArchives.requests,
      phaseOrders: ["jitendex", "jmnedict", "bees-ultimate-kanji-dictionary", "jiten"].map(phaseOrder), events: setupEvents.length }),
  );

  // Settings meanwhile shows the partial state: no starter card, a retry control.
  const settingsAfterRun = await page.evaluate(() => ({
    starterHidden: document.getElementById("recommended-starter")?.hidden,
    retryHidden: document.getElementById("recommended-retry")?.hidden,
  }));
  const jitendexTitle = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "jitendex").title;
  const beesTitle = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "bees-ultimate-kanji-dictionary").title;
  let retried = null;
  let successShownAt = 0;
  if (startup !== null) {
    await startup.bringToFront();
    await clickStartupControl("setup-retry");
    retried = await waitStartup((state) => state.heading.startsWith("All dictionaries installed"), 60_000);
    successShownAt = Date.now();
  }
  const afterRetry = await page.evaluate(async () => chrome.storage.local.get(["setupState", "options", "dictionaryState"]));
  const retryOutcomes = afterRetry.setupState?.dictionaries?.outcomes ?? {};
  check(
    "Retry installs only the missing dictionary and the committed entries settle their selections once",
    settingsAfterRun.starterHidden === true && settingsAfterRun.retryHidden === false
      && JSON.stringify(setupArchives.requests.slice(4)) === JSON.stringify(["jmnedict"])
      && retried?.heading === `All dictionaries installed in ${afterRetry.setupState.dictionaries.totalSeconds < 10
        ? afterRetry.setupState.dictionaries.totalSeconds.toFixed(1) : Math.round(afterRetry.setupState.dictionaries.totalSeconds)} seconds`
      && retried.rows.every((row) => /^Installed in \d+(\.\d+)? seconds$/u.test(row[1]))
      && JSON.stringify(retried.actions) === JSON.stringify([["setup-continue", "Continue now"], ["setup-pause", "Pause countdown"]]) && retried.importLink
      && retried.countdown === "Continuing to Anki in 5 seconds"
      && retryOutcomes.jmnedict?.status === "installed" && retryOutcomes.jmnedict.seconds > 0
      && retryOutcomes.jitendex?.status === "installed"
      && afterRetry.setupState.dictionaries.totalSeconds > afterRun.setupState.dictionaries.totalSeconds
      && JSON.stringify(afterRetry.setupState.dictionaries.selectionsApplied) === JSON.stringify(["jitendex", "bees-ultimate-kanji-dictionary"])
      && afterRetry.options.compactDefinitionSummaryDictionary === jitendexTitle
      && afterRetry.options.kanjiClickDictionary?.title === beesTitle && afterRetry.options.kanjiClickDictionary.kind === "term"
      && afterRetry.options.showCompactDefinitionSummary === false
      && (afterRetry.dictionaryState?.dictionaries ?? []).length === RECOMMENDED_DICTIONARIES.length
      && afterRetry.setupState.stage === "dictionaries",
    JSON.stringify({ settingsAfterRun, retried, afterRetry, requests: setupArchives.requests }),
  );
  if (startup && (process.env.HACHIDORI_STARTUP_COMPLETE_SCREENSHOT || process.env.HACHIDORI_STARTUP_COMPLETE_DARK_SCREENSHOT)) {
    await startup.setViewport({ width: 900, height: 820 });
    for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_COMPLETE_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_COMPLETE_DARK_SCREENSHOT]]) {
      if (!path) continue;
      await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await startup.screenshot({ path });
    }
    await startup.emulateMediaFeatures([]);
  }

  // The first-run Anki check must find nothing. Refuse the AnkiConnect
  // connection on the worker for the duration, so a real Anki or another
  // suite's mock server on this port cannot decide this outcome.
  const ankiRefused = { requests: 0, fail: "ConnectionRefused" };
  const ankiOffline = await interceptFetches(
    await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().endsWith("/background.js")),
    new Map([["http://127.0.0.1:8765/", ankiRefused]]), "anki offline");

  // The Anki stage checks by itself and its outcome moves setup on, so both
  // headings are transient. Record every heading the page paints instead of
  // hoping a poll lands inside them.
  if (startup !== null) {
    await startup.evaluate(() => {
      window.__headingLog = [];
      const record = () => {
        const text = document.getElementById("setup-heading")?.textContent ?? "";
        if (window.__headingLog.at(-1)?.text === text) return;
        window.__headingLog.push({
          text,
          at: Date.now(),
          focused: document.activeElement?.id ?? "",
          step: document.querySelector('.setup-step[aria-current="step"]')?.dataset.stage ?? null,
          done: document.querySelectorAll(".setup-step.is-done").length,
          actions: [...document.querySelectorAll("#setup-actions button")].map((control) => control.id),
          outcome: document.querySelector(".setup-anki-outcome")?.dataset.status ?? null,
          ankiLink: document.querySelector('#setup-body a[href="settings.html#anki"]') !== null,
        });
      };
      record();
      new MutationObserver(record).observe(document.getElementById("setup-card"),
        { childList: true, subtree: true, characterData: true });
    });
  }
  let heldResult = null;
  let practiceReached = null;
  if (startup !== null) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, successShownAt + 3500 - Date.now())));
    heldResult = await startup.evaluate(readStartup).catch(() => null);
    // The final step waits for Finish, so it is the one stable state to poll for.
    practiceReached = await startup.waitForFunction(() => document.getElementById("setup-practice-instruction")?.textContent.startsWith("Try looking up a word below.")
      ? { at: Date.now(), focused: document.activeElement?.id ?? "",
        currentStep: document.querySelector('.setup-step[aria-current="step"]')?.dataset.stage ?? null,
        done: document.querySelectorAll(".setup-step.is-done").length,
        body: document.getElementById("setup-body")?.textContent ?? "",
        outcome: document.querySelector(".setup-anki-outcome")?.dataset.status ?? null,
        outcomeText: document.querySelector(".setup-anki-outcome")?.textContent ?? "",
        outcomeLink: document.querySelector('.setup-anki-outcome a[href="settings.html#anki"]') !== null,
        status: document.getElementById("setup-status")?.textContent ?? "",
        actions: [...document.querySelectorAll("#setup-actions button")].map((control) => control.id) } : false,
    { timeout: 30_000, polling: 50 }).then((handle) => handle.jsonValue()).catch(() => null);
  }
  const headingLog = startup === null ? [] : await startup.evaluate(() => window.__headingLog ?? []);
  const painted = (text) => headingLog.find((entry) => entry.text === text) ?? null;
  const checkingAnki = painted("Connect Anki, if you use it");
  const ankiStage = await page.evaluate(async () => (await chrome.storage.local.get("setupState")).setupState);
  check(
    "the all-installed result stays five seconds before setup checks for Anki",
    heldResult?.heading.startsWith("All dictionaries installed in") === true
      && /^Continuing to Anki in [123] seconds?$/u.test(heldResult.countdown ?? "")
      && checkingAnki !== null && checkingAnki.at - successShownAt >= 4800
      && checkingAnki.focused === "setup-heading" && checkingAnki.step === "anki" && checkingAnki.done === 1
      && JSON.stringify(checkingAnki.actions) === JSON.stringify(["setup-continue"])
      && ankiStage?.dictionaries.continued === false,
    JSON.stringify({ heldResult, checkingAnki, successShownAt, headingLog, ankiStage }),
  );

  // Nothing answers AnkiConnect on this host, so the ordinary absence is
  // recorded once and the page moves on without asking the user anything.
  const settledAnki = painted("Anki isn’t connected");
  if (startup && (process.env.HACHIDORI_STARTUP_READY_SCREENSHOT || process.env.HACHIDORI_STARTUP_READY_DARK_SCREENSHOT)) {
    await startup.setViewport({ width: 900, height: 820 });
    for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_READY_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_READY_DARK_SCREENSHOT]]) {
      if (!path) continue;
      await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await startup.screenshot({ path, fullPage: true });
    }
    await startup.emulateMediaFeatures([]);
  }

  if (startup) await checkStartupPractice(startup, browser, startupUrl);

  // The dictionary-dependent selections were applied once; the user now returns
  // both to Automatic so the remaining assertions keep their historical options.
  await page.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      requestId: "first-run-reset", baseRevision: options.revision,
      options: { compactDefinitionSummaryDictionary: "", kanjiClickDictionary: "" } });
    if (!reply.ok) throw new Error(reply.error);
  });

  // The final step runs the real reader on the startup page: its own packaged
  // scripts, the dictionaries this setup just installed, the ordinary runtime
  // lookup and the same closed-shadow popup a webpage gets.
  let exercise = null;
  if (startup !== null) {
    await startup.bringToFront();
    const startupPopup = await popupReader(startup);
    const injected = await startup.waitForFunction(() => {
      const sources = [...document.querySelectorAll("script[data-setup-reader]")].map((script) => script.getAttribute("src"));
      return sources.includes("content.js") ? sources : false;
    }, { timeout: 30_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => null);
    // Reuse the reviewed scene's dictionary word, aiming at its own rectangle.
    await startup.keyboard.press("Escape");
    await startup.evaluate(() => window.getSelection().removeAllRanges());
    const hoverCharacter = async (index) => {
      const point = await startup.evaluate((at) => {
        const text = document.getElementById("setup-practice-word")?.firstChild;
        if (!text) return null;
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, index);
      if (point === null) return;
      await startup.mouse.move(2, 2);
      await startup.mouse.move(point.x, point.y);
    };
    let looked = null;
    const startedLookup = Date.now();
    for (let attempt = 0; attempt < 12 && looked === null; attempt += 1) {
      await hoverCharacter(0);
      looked = await startupPopup.waitForVisible(2000);
    }
    // Chrome reports no Resource Timing for extension-scheme subresources, so
    // what the step costs is measured where it is visible: the hover that answers.
    console.log(`     practice lookup answered in ${Date.now() - startedLookup} ms`);
    if (looked !== null && (process.env.HACHIDORI_STARTUP_PRACTICE_SCREENSHOT || process.env.HACHIDORI_STARTUP_PRACTICE_DARK_SCREENSHOT)) {
      await startup.setViewport({ width: 900, height: 820 });
      for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_PRACTICE_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_PRACTICE_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await hoverCharacter(0);
        await startupPopup.waitForVisible(2000);
        await startup.screenshot({ path });
      }
      await startup.emulateMediaFeatures([]);
    }
    await startup.mouse.move(2, 2);
    const hidden = looked === null ? null : await startupPopup.waitForHidden(6000);
    exercise = { injected, looked, hidden };
  }
  const jitendexFixtureTitle = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "jitendex").title;
  check(
    "the practice step looks a word up on the startup page through the real reader and the installed dictionaries",
    JSON.stringify(exercise?.injected) === JSON.stringify(READER_SCRIPTS)
      && exercise.looked !== null && exercise.looked.plain.includes("辞書")
      && exercise.looked.text.includes(`${jitendexFixtureTitle} term fixture`)
      && exercise.hidden === true,
    JSON.stringify({ injected: exercise?.injected, looked: exercise?.looked, hidden: exercise?.hidden }),
  );

  let closedTab = null;
  if (startup !== null) {
    await startup.bringToFront();
    const startupClosed = new Promise((resolveClosed) => {
      const onDestroyed = (target) => {
        if (target.url() === startupUrl) { browser.off("targetdestroyed", onDestroyed); resolveClosed(true); }
      };
      browser.on("targetdestroyed", onDestroyed);
      setTimeout(() => { browser.off("targetdestroyed", onDestroyed); resolveClosed(false); }, 15_000);
    });
    await clickStartupControl("setup-finish");
    closedTab = await startupClosed;
  }
  const completedSetup = await page.waitForFunction(async () => {
    const { setupState } = await chrome.storage.local.get("setupState");
    return setupState?.stage === "complete" && document.getElementById("setup-resume")?.hidden === true
      ? setupState : false;
  }, { timeout: 10_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => null);
  check(
    "an absent Anki settles by itself and the startup page finishes setup, closes its tab and hides Resume setup",
    settledAnki !== null && settledAnki.step === "anki" && settledAnki.done === 1
      && settledAnki.outcome === "unavailable" && JSON.stringify(settledAnki.actions) === JSON.stringify([])
      // Exactly one AnkiConnect attempt, and the absence is not asked about twice.
      && ankiRefused.requests === 1
      && ankiStage?.anki?.status === "unavailable" && ankiStage.anki.model === null && ankiStage.anki.deck === null
      && ankiStage.anki.detail.includes("Open Anki with the AnkiConnect add-on")
      // The outcome moved setup on by itself and stays readable on the final step.
      && practiceReached?.focused === "setup-heading" && practiceReached.currentStep === "practice"
      && practiceReached.done === 2 && practiceReached.status === "You’re ready."
      && practiceReached.outcome === "unavailable" && practiceReached.outcomeLink
      && practiceReached.outcomeText === "Anki isn’t connected. It’s optional — you can set it up later in Settings."
      && practiceReached.body.includes("Try looking up a word below.")
      && practiceReached.body.includes("踏切の向こうから蝉の声が響く。")
      && JSON.stringify(practiceReached.actions) === JSON.stringify(["setup-finish"])
      && closedTab === true && startupTabs() === 0
      && typeof completedSetup?.completedAt === "string" && completedSetup.anki?.status === "unavailable"
      && JSON.stringify(Object.keys(completedSetup.dictionaries.outcomes).sort()) === JSON.stringify(RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId).sort())
      && editedPreference?.showCompactDefinitionSummary === false && editedPreference.revision === 2,
    JSON.stringify({ settledAnki, practiceReached, headingLog, completedSetup, editedPreference, closedTab,
      ankiRequests: ankiRefused.requests, startupTabs: startupTabs() }),
  );
  await ankiOffline.detach().catch(() => {});
  await page.bringToFront();

  // Only the startup page may run the reader. Loading the very same scripts into
  // Settings must leave it inert, so no internal page starts scanning text.
  const guarded = await (async () => {
    const other = await browser.newPage();
    try {
      await other.goto(settingsUrl, { waitUntil: "domcontentloaded" });
      const loaded = await other.evaluate(async (scripts) => {
        const sample = document.createElement("p");
        sample.id = "e2e-japanese";
        sample.style.cssText = "font: 32px/2 serif; padding: 40px";
        sample.textContent = "食べる";
        document.body.prepend(sample);
        for (const src of scripts) {
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = src;
            script.addEventListener("load", () => { resolve(); });
            script.addEventListener("error", () => { reject(new Error(`${src} did not load`)); });
            document.head.appendChild(script);
          });
        }
        return true;
      }, READER_SCRIPTS).catch((error) => `${error?.message ?? error}`);
      const box = await (await other.$("#e2e-japanese")).boundingBox();
      await other.mouse.move(2, 2);
      await other.mouse.move(box.x + 20, box.y + box.height / 2);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        loaded,
        popupHost: await other.evaluate(() => document.querySelector("hachidori-host") !== null),
        rendererLoaded: await other.evaluate(() => typeof window.HDPopup === "object"),
      };
    } finally {
      await other.close().catch(() => {});
    }
  })();
  check(
    "the reader refuses to run on Settings even when its own scripts are loaded there",
    guarded.loaded === true && guarded.rendererLoaded === true && guarded.popupHost === false,
    JSON.stringify(guarded),
  );

  // Clear the mocked catalogue packages so the Settings installer below starts
  // from the same clean library it always did; the setup mock stays attached so
  // no later run can reach the network, but must not answer Settings' own fetches.
  for (const { title } of RECOMMENDED_DICTIONARIES) {
    const removed = await page.evaluate((dictionaryTitle) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_remove",
      requestId: `e2e-remove-setup-${dictionaryTitle}`,
      title: dictionaryTitle,
    }), title);
    if (removed?.ok !== true) {
      throw new Error(`could not clear the setup-installed dictionary ${title}: ${JSON.stringify(removed)}`);
    }
  }
  await page.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return dictionaryState?.dictionaries?.length === 0
      && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 100 });
  const setupRequestsAfterSetup = setupArchives.requests.length;

  await checkFirstRunAnkiDetection(page, browser, startupUrl);

  await checkSettingsAutosave(page, browser, settingsUrl);
  await checkSettingsTransport(page);
  await checkDesignPreview(page);
  await checkAudioSettings(page, browser);
  const ankiSession = await checkAnkiSettings(page, browser);
  await checkDictionaryStyles(page);
  await showSettingsSection(page, "add-dictionaries");

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
    "recommended dictionaries form a readable list on desktop",
    desktopRecommendations.columns === 1
      && desktopRects.length === RECOMMENDED_LINKS.length
      && desktopRects.every((rect, index) => rect.right > rect.left
        && (index === 0 || rect.top >= desktopRects[index - 1].bottom)),
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
    await showSettingsSection(page, "dictionaries");
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
  await showSettingsSection(page, "add-dictionaries");
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

  await showSettingsSection(page, "add-dictionaries");
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
  await openDictionaryDetails(page, FIXTURE_ID);
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

  await showSettingsSection(page, "dictionaries");
  await page.setViewport({ width: 1280, height: 900 });
  const libraryFirst = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const row = document.querySelector("#dict-list .dict-row");
    const links = [...document.querySelectorAll(".settings-nav a")];
    return document.querySelector("main > section")?.id === "dictionaries"
      && row.getBoundingClientRect().bottom < window.innerHeight
      && links.length === 11
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
  await page.waitForFunction(() => location.hash === "#lookup" && !document.getElementById("lookup").hidden
    && document.querySelector('.settings-nav [aria-current="page"]')?.hash === "#lookup");
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
        statusExposed: !document.getElementById("options-status").closest("[hidden]")
          && document.getElementById("nav-status-lookup").textContent === "",
      };
    }));
  }
  await page.focus(".skip-link");
  await page.keyboard.press("Enter");
  const skipFocusedMain = await page.evaluate(() => document.activeElement.id === "settings-content"
    && !document.getElementById("lookup").hidden);
  const readingNode = await page.$("#lookup");
  await showSettingsSection(page, "updates");
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById("lookup").hidden);
  const historyRetainedView = await page.evaluate((node) => node === document.getElementById("lookup"), readingNode);
  await readingNode.dispose();
  await page.goForward();
  await page.waitForFunction(() => !document.getElementById("updates").hidden);
  await page.focus('.settings-nav a[href="#updates"]');
  await page.keyboard.press("Enter");
  const sameHashFocus = await page.evaluate(() => document.activeElement.id === "updates-heading");
  check(
    "Settings puts the library first and supports keyboard navigation at 320px",
    libraryFirst && selectionActions && skipFocusedMain && shortWindowNavigation && historyRetainedView && sameHashFocus
      && narrowThemes.every((theme) => theme.noOverflow && theme.fieldsFit && theme.statusExposed),
    JSON.stringify({ libraryFirst, selectionActions, skipFocusedMain, shortWindowNavigation, historyRetainedView, sameHashFocus, narrowThemes }),
  );
  const themeLayouts = [];
  for (const width of [320, 1280]) {
    await page.setViewport({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      for (const section of ["dictionaries", "lookup", "design", "audio", "anki", "custom-dictionary", "add-dictionaries", "updates", "dictionary-groups", "backup"]) {
        await showSettingsSection(page, section);
        themeLayouts.push(await page.evaluate(({ theme, section }) => {
          const root = getComputedStyle(document.documentElement);
          const token = (name) => root.getPropertyValue(name).trim();
          const luminance = (hex) => {
            const rgb = hex.slice(1).match(/../gu).map((part) => Number.parseInt(part, 16) / 255)
              .map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          };
          const contrast = (first, second) => {
            const a = luminance(token(first));
            const b = luminance(token(second));
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          };
          const panel = document.getElementById(section);
          const primary = {
            dictionaries: "dict-search", lookup: "opt-hover-enabled", design: "opt-popup-columns", audio: "audio-source-add", anki: "anki-refresh", "custom-dictionary": "custom-dictionary-open",
            "add-dictionaries": "import-file", updates: "update-schedule", "dictionary-groups": "dict-group-name-new", backup: "backup-export",
          };
          const controls = [...panel.querySelectorAll("input, select, button, textarea, summary")]
            .filter((control) => control.checkVisibility());
          const textPairs = [
            ["--text", "--surface"], ["--text-dim", "--surface"], ["--text-dim", "--bg"],
            ["--text-dim", "--surface-sunken"], ["--accent", "--accent-soft"],
            ["--accent", "--surface"], ["--accent-contrast", "--accent"],
            ["--error", "--surface"], ["--ok", "--bg"],
          ];
          return { theme, section, width: innerWidth,
            taskVisible: panel.querySelector("h1").checkVisibility() && document.getElementById(primary[section]).checkVisibility(),
            noOverflow: document.documentElement.scrollWidth <= innerWidth,
            controlsFit: controls.every((control) => {
              const rect = control.getBoundingClientRect();
              return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1;
            }),
            textContrast: Math.min(...textPairs.map(([first, second]) => contrast(first, second))),
            controlContrast: Math.min(contrast("--border-strong", "--surface"), contrast("--border-strong", "--surface-sunken")),
          };
        }, { theme, section }));
      }
    }
  }
  check("Settings light and dark themes keep every task view readable without horizontal overflow",
    themeLayouts.every((layout) => layout.taskVisible && layout.noOverflow && layout.controlsFit
      && layout.textContrast >= 4.5 && layout.controlContrast >= 3), JSON.stringify(themeLayouts));
  await ankiSession.detach();
  await page.emulateMediaFeatures([]);
  await page.setViewport({ width: 480, height: 900 });
  await openDictionaryDetails(page, FIXTURE_ID);
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
  await openDictionaryDetails(page, FIXTURE_ID);
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
      detailsOpen: document.querySelector(`[data-dictionary-id="${dictionaryId}"] .dict-details`)?.open,
      aliasVisible: document.querySelector(`[data-dictionary-id="${dictionaryId}"] .dict-display-name`)?.checkVisibility(),
    };
  }, { beforeRevision: beforeAliasBlurAction, dictionaryId: FIXTURE_ID });
  check(
    "a delayed alias blur-then-click queues both dictionary edits",
    aliasBlurAction.revision >= beforeAliasBlurAction + 2
      && aliasBlurAction.alias === "Blurred alias"
      && aliasBlurAction.lastDictionaryId === FIXTURE_ID
      && aliasBlurAction.focusedDictionaryId === FIXTURE_ID
      && aliasBlurAction.detailsOpen && aliasBlurAction.aliasVisible,
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

  await showSettingsSection(page, "dictionary-groups");
  const groupManagement = await page.evaluate(async ({ fixtureId, genericId }) => {
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
    };
  }, { fixtureId: FIXTURE_ID, genericId: GENERIC_KANJI_ID });
  const groupedAlias = await setDictionaryAliasInSettings(page, "hachidori-fixture", "Grouped alias");
  if (!groupedAlias.settled) throw new Error(`Group alias did not settle: ${JSON.stringify(groupedAlias)}`);
  await showSettingsSection(page, "dictionary-groups");
  Object.assign(groupManagement, await page.evaluate(async ({ groupId, fixtureId }) => ({
    membershipAfterAlias: (await chrome.storage.local.get("dictionaryState")).dictionaryState.groups
      .find((group) => group.id === groupId).dictionaryIds,
    groupedAliasLabel: document.querySelector(`[data-group-id="${groupId}"] [data-dictionary-id="${fixtureId}"] .dict-group-member-name`)?.textContent,
  }), { groupId: groupManagement.studyGroupId, fixtureId: FIXTURE_ID }));
  const restoredAlias = await setDictionaryAliasInSettings(page, "hachidori-fixture", FIXTURE_ALIAS);
  if (!restoredAlias.settled) throw new Error(`Restored alias did not settle: ${JSON.stringify(restoredAlias)}`);
  await showSettingsSection(page, "dictionary-groups");
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
    const outsideControl = document.querySelector('.settings-nav a[href="#lookup"]');
    input.focus();
    input.value = "Externally focused reading";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    outsideControl.focus();

    const deadline = Date.now() + 3000;
    let current;
    do {
      current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
      if (current.revision > before.revision) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    } while (Date.now() < deadline);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    return {
      focusedHref: document.activeElement?.getAttribute("href"),
      name: current.groups.find((group) => group.id === groupId)?.name,
    };
  }, groupManagement.studyGroupId);
  check(
    "a newer external focus survives a group rerender",
    externalFocus.focusedHref === "#lookup"
      && externalFocus.name === "Externally focused reading",
    JSON.stringify(externalFocus),
  );

  await showSettingsSection(page, "lookup");
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
  await showSettingsSection(page, "custom-dictionary");
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
  const sourceNode = await page.$("#custom-dictionary-source");
  await showSettingsSection(page, "lookup");
  await showSettingsSection(page, "custom-dictionary");
  const sourceDraftRetained = await page.evaluate((node, source) =>
    node === document.getElementById("custom-dictionary-source") && node.value === source, sourceNode, CUSTOM_SETTINGS_SOURCE);
  await sourceNode.dispose();
  if (!sourceDraftRetained) throw new Error("Navigating Settings replaced the unsaved source draft");
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

  await checkLookupStatistics({
    browser,
    settings: page,
    tab,
    popup,
    extensionId,
  });
  await checkDefinitionBlur({ settings: page, tab, popup });
  await checkAnkiMatureDefinitionBlur({ browser, settings: page, tab, popup });
  await checkDeinflectionDisclosure(page, tab, popup);
  await checkExternalLinks(browser, page, tab, popup);
  await checkNestedLinks(page, tab, popup, browser);
  await checkDictionaryTabsColumns(page, tab, popup, browser);
  await checkCompactSummaries(page, tab, popup, browser);
  await checkReaderActivation(page, tab, popup);
  await checkReaderSelection(browser, page, tab, popup);
  await checkSourceFallback(page, tab, popup);
  await checkFrequencyDirection(browser, page, tab, popup);
  await checkPopupMetadata(browser, page, tab, popup);
  await checkPopupAudio(page, tab, popup, browser);
  await tab.keyboard.press("Escape");
  await checkAnkiSubmission(page, browser, tab, popup);
  await hover("#verb");

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
  const incidentalWord = await (await tab.$("#duplicate")).boundingBox();
  await tab.mouse.move(incidentalWord.x + incidentalWord.width * 0.15, incidentalWord.y + incidentalWord.height / 2);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const focusedPointerState = await popup.state();
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
      && focusedPointerState?.focusedClass.includes("gsm-hoshidicts-kanji-back")
      && focusedPointerState?.text === genericKanjiState?.text
      && restoredTermState?.focusedClass.includes("gsm-hoshidicts-kanji-link"),
    JSON.stringify({ genericKanjiState, focusedPointerState, restoredTermState }),
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

  await showSettingsSection(page, "lookup");
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
  await showSettingsSection(page, "custom-dictionary");
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
  const managedFixture = await page.evaluate(async ({ dictionaryId, fixtureId, indexUrl, downloadUrl }) => {
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
        : dictionary.id === fixtureId ? { ...dictionary, updateScheduleOverride: "off" } : dictionary),
    });
  }, {
    dictionaryId: GENERIC_KANJI_ID,
    fixtureId: FIXTURE_ID,
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

  await showSettingsSection(page, "updates");
  await page.bringToFront();
  await page.click("#update-check-now");
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
      && checkedFixture.updateScheduleOverride === "off"
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
  await openDictionaryDetails(page, GENERIC_KANJI_ID);
  const persistedRowVisible = await page.$eval(
    `.dict-row[data-dictionary-id="${GENERIC_KANJI_ID}"] .dict-update`, (button) => button.checkVisibility());
  await showSettingsSection(page, "updates");
  check(
    "managed update controls render persisted availability and last-checked state",
    persistedUpdateUi?.expectedLastChecked.startsWith("Last checked ") === true
      && persistedUpdateUi.fixtureUpdateHidden === true
      && persistedUpdateUi.genericUpdateHidden === false
      && persistedUpdateUi.updateAllDisabled === false && persistedRowVisible,
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
  await showSettingsSection(page, "updates");
  await page.click("#update-all");
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

  await checkManagementAutosave(page, browser, settingsUrl);
  await page.select("#update-schedule", "hourly");
  const expectedNextCheck = Date.parse(afterUpdatePackage.lastUpdateCheck.checkedAt) + 3_600_000;
  const scheduledAlarm = await page.waitForFunction(async ({ alarmName, expected }) => {
    const { dictionaryUpdates } = await chrome.storage.local.get("dictionaryUpdates");
    const alarms = await chrome.alarms.getAll();
    const alarm = alarms.find((candidate) => candidate.name === alarmName);
    return dictionaryUpdates?.schedule === "hourly" && alarm?.periodInMinutes === undefined && alarm?.scheduledTime === expected
      ? { alarm, alarms, dictionaryUpdates }
      : false;
  }, { timeout: 30_000, polling: 100 }, { alarmName: MANAGED_UPDATE_ALARM, expected: expectedNextCheck })
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check(
    "one aggregate browser alarm follows the next dictionary due time",
    scheduledAlarm?.alarms?.length === 1
      && scheduledAlarm.alarm.name === MANAGED_UPDATE_ALARM
      && scheduledAlarm.alarm.periodInMinutes === undefined
      && scheduledAlarm.alarm.scheduledTime === expectedNextCheck,
    JSON.stringify(scheduledAlarm),
  );

  const generationBeforePolicy = await page.evaluate(async () => (await chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen", type: "hd_status",
  })).generation);
  await openDictionaryDetails(page, GENERIC_KANJI_ID);
  await page.select(`.dict-row[data-dictionary-id="${GENERIC_KANJI_ID}"] .dict-update-schedule`, "hourly");
  await page.waitForFunction(async dictionaryId => (await chrome.storage.local.get("dictionaryState"))
    .dictionaryState.dictionaries.find(dictionary => dictionary.id === dictionaryId).updateScheduleOverride === "hourly",
  { polling: 100 }, GENERIC_KANJI_ID);
  await showSettingsSection(page, "updates");
  await page.waitForSelector("#update-schedule:not([disabled])");
  await page.select("#update-schedule", "off");
  await page.waitForFunction(async () => (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates.schedule === "off",
    { polling: 100 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("engine-status")?.textContent.includes("Ready"), { polling: 100 });
  await openDictionaryDetails(page, GENERIC_KANJI_ID);
  const policyState = await page.evaluate(async ({ dictionaryId, fixtureId }) => ({
    override: document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-update-schedule`).value,
    fixture: document.querySelector(`.dict-row[data-dictionary-id="${fixtureId}"] .dict-update-schedule`).value,
    hint: document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-next-check`).textContent,
    global: document.getElementById("update-schedule").value,
    alarms: await chrome.alarms.getAll(),
    generation: (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" })).generation,
  }), { dictionaryId: GENERIC_KANJI_ID, fixtureId: FIXTURE_ID });
  check("per-dictionary schedules persist without engine reload and override global Off",
    policyState.override === "hourly" && policyState.fixture === "off" && policyState.global === "off"
      && policyState.hint.includes("Next check") && policyState.generation === generationBeforePolicy
      && policyState.alarms.length === 1 && policyState.alarms[0].scheduledTime === expectedNextCheck,
    JSON.stringify(policyState));
  if (process.env.HACHIDORI_SCHEDULE_SCREENSHOT) {
    await page.bringToFront();
    await page.setViewport({ width: 1200, height: 900 });
    await page.screenshot({ path: process.env.HACHIDORI_SCHEDULE_SCREENSHOT, fullPage: true });
  }
  const scheduleManagedCheckSoon = () => page.evaluate(async dictionaryId => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: current.revision, dictionaries: current.dictionaries.map(dictionary => dictionary.id === dictionaryId
        ? { ...dictionary, lastUpdateCheck: { ...dictionary.lastUpdateCheck, checkedAt: new Date(Date.now() - 3_600_000 + 1000).toISOString() } }
        : dictionary) });
    if (!reply.ok) throw new Error(reply.error);
  }, GENERIC_KANJI_ID);

  setJsonResponse(genericIndexRoute, { revision: "test-3" });
  setArchiveResponse(genericArchiveRoute, buildRecommendedZip({
    title: GENERIC_KANJI_TITLE,
    revision: "test-3",
    indexUrl: GENERIC_MANAGED_INDEX_URL,
    downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
    capabilities: ["term"],
  }));
  const archiveRequestsBeforeAlarm = genericArchiveRoute.requests;
  const fixtureChecksBeforeAlarm = fixtureIndexRoute.requests;
  await scheduleManagedCheckSoon();
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
      && fixtureIndexRoute.requests === fixtureChecksBeforeAlarm
      && alarmUpdatedPackage.updateScheduleOverride === "hourly"
      && alarmUpdateResult.dictionaryUpdates.schedule === "off"
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
  await scheduleManagedCheckSoon();
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

  // Simulate Chrome clearing the configured alarm before worker restart.
  await page.evaluate(alarmName => chrome.alarms.clear(alarmName), MANAGED_UPDATE_ALARM);
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
  const startupTabsAfterWorkerRestart = startupTabs();
  const restartWakeReply = await page.evaluate(() => Promise.race([
    chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_read",
    }),
    new Promise((resolveWake) => setTimeout(() => resolveWake({ timeout: true }), 10_000)),
  ])).catch((error) => ({ error: String(error) }));
  const expectedRecreatedCheck = Date.parse(failedAlarmPackage.lastUpdateCheck.checkedAt) + 3_600_000;
  const recreatedAlarm = await page.waitForFunction(async ({ alarmName, expected }) => {
    const alarms = await chrome.alarms.getAll();
    const alarm = alarms.find((candidate) => candidate.name === alarmName);
    return alarm?.periodInMinutes === undefined && alarm?.scheduledTime === expected ? { alarm, alarms } : false;
  }, { timeout: 30_000, polling: 100 }, { alarmName: MANAGED_UPDATE_ALARM, expected: expectedRecreatedCheck })
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
      && recreatedAlarm.alarm.periodInMinutes === undefined
      && recreatedAlarm.alarm.scheduledTime === expectedRecreatedCheck,
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

  await editSettingsControls(page, { "opt-frequency-dictionary": "hachidori-fixture", "opt-frequency-order": "ascending",
    "opt-popup-columns": "2" });
  const backupRestored = await backupChromeScenarios({ browser, page, directory: resolve(PROFILE, "backup-downloads"), check });
  const restoredFixture = backupRestored.state.dictionaries.find(dictionary => dictionary.id === fixtureId);
  const restoredFixtureGeneration = ownedGenerationRoot(restoredFixture.path, "hachidori-fixture");
  const lookupStatsBeforeRestart = await readLookupStatistics(page);
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
  await showSettingsSection(page, "lookup");

  const restoredOptions = await page.waitForFunction(async (expected) => {
    const { options } = await chrome.storage.local.get("options");
    return JSON.stringify(options) === JSON.stringify(expected)
      && document.getElementById("opt-max-results").value === String(expected.maxResults)
      && document.getElementById("opt-hover-enabled").checked === expected.hoverEnabled
      && document.getElementById("opt-lookup-mode").value === expected.lookupMode
      && document.getElementById("opt-activation-key").value === expected.activationKey
      && document.getElementById("opt-hide-delay").value === String(expected.popupHideDelayMs)
      && document.getElementById("opt-popup-columns").value === String(expected.popupColumns)
      && document.getElementById("opt-frequency-dictionary").value === expected.frequencyDictionary
      && document.getElementById("opt-frequency-order").value === expected.frequencyOrder
      ? options : false;
  }, { timeout: 30_000, polling: 100 }, optionsBeforeRestart).then((handle) => handle.jsonValue()).catch(() => null);
  check("reader settings and their revision survive a full browser restart",
    restoredOptions?.revision === optionsBeforeRestart.revision && restoredOptions !== null,
    JSON.stringify({ optionsBeforeRestart, restoredOptions }));
  const lookupStatsAfterRestart = await readLookupStatistics(page);
  check(
    "lookup counts survive a full browser restart",
    lookupStatsBeforeRestart.ok === true
      && lookupStatsAfterRestart.ok === true
      && lookupStatsAfterRestart.descriptor?.generation === lookupStatsBeforeRestart.descriptor?.generation
      && lookupStatsAfterRestart.descriptor?.revision === lookupStatsBeforeRestart.descriptor?.revision
      && JSON.stringify(lookupStatsAfterRestart.statistics) === JSON.stringify(lookupStatsBeforeRestart.statistics),
    JSON.stringify({ lookupStatsBeforeRestart, lookupStatsAfterRestart }),
  );

  // The relaunch fired onStartup, and pass 1 restarted the worker version: neither
  // may reopen the completed startup page or touch the edited preference.
  const setupAfterRestart = await page.evaluate(async () => {
    const { setupState } = await chrome.storage.local.get("setupState");
    return { setupState, resumeHidden: document.getElementById("setup-resume")?.hidden };
  });
  check(
    "a browser restart keeps completed setup closed and the edited first-install preference",
    startupTabsAfterWorkerRestart === 0 && startupTabs() === 0
      && JSON.stringify(setupAfterRestart.setupState) === JSON.stringify(completedSetup)
      && setupAfterRestart.resumeHidden === true
      && restoredOptions?.showCompactDefinitionSummary === false
      && restoredOptions.showCompactDefinitionSummary === optionsBeforeRestart.showCompactDefinitionSummary
      && setupArchives.requests.length === setupRequestsAfterSetup,
    JSON.stringify({ startupTabsAfterWorkerRestart, startupTabs: startupTabs(), setupAfterRestart, completedSetup,
      setupRequests: setupArchives.requests.length, setupRequestsAfterSetup }),
  );

  await showSettingsSection(page, "dictionaries");
  const persistedPackage = await page.waitForFunction(async (id, expectedPath) => {
    const t = (document.getElementById("dict-list")?.textContent || "");
    const { dictionaryState: state } = await chrome.storage.local.get("dictionaryState");
    const dictionary = state?.dictionaries?.find(candidate =>
      candidate.id === id && candidate.title === "hachidori-fixture");
    return t.includes("hachidori-fixture") && dictionary?.path === expectedPath
      ? dictionary
      : false;
  }, { timeout: 90_000, polling: 500 }, fixtureId, restoredFixture.path)
    .then(handle => handle.jsonValue())
    .catch(() => null);
  check("the settings page lists the dictionary again after a restart",
    persistedPackage?.path === restoredFixture.path
      && ownedGenerationRoot(persistedPackage.path, "hachidori-fixture") === restoredFixtureGeneration,
    `expected path: ${JSON.stringify(restoredFixture.path)}; persisted package: ${JSON.stringify(persistedPackage)}`);
  await showSettingsSection(page, "add-dictionaries");
  const restartedSettingsUi = await page.evaluate(() => ({
    localInputVisible: document.getElementById("import-file")?.checkVisibility() === true,
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
      && generationExists(opfsAfterRestart, restoredFixture.path)
      && generationIsAbsent(opfsAfterRestart, firstFixtureGeneration)
      && generationIsAbsent(opfsAfterRestart, replacedFixtureGeneration),
    `hd_status reply: ${JSON.stringify(reloadCount)}; latest path: ${JSON.stringify(restoredFixture.path)};`
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

  const boundedTitle = "bounded-response-fixture";
  let deepGlossary = "over-depth leaf";
  for (let depth = 0; depth < 25; depth += 1) deepGlossary = { type: "text", text: deepGlossary };
  const exactMediaBytes = Buffer.alloc(4 * 1024 * 1024);
  makePng().copy(exactMediaBytes);
  const boundedArchive = buildTitledZip(boundedTitle, { terms: [
    ["限界", "げんかい", "", "", 0, ["x".repeat(8 * 1024 * 1024 - 3)], 1, ""],
    ["速度", "そくど", "", "", 0, ["healthy bounded lookup"], 2, ""],
    ["深度", "しんど", "", "", 0, [deepGlossary], 3, ""],
  ], mediaEntries: [
    ["media/exact.png", exactMediaBytes],
    ["media/over.png", Buffer.concat([exactMediaBytes, Buffer.from([0])])],
  ] });
  await showSettingsSection(page, "add-dictionaries");
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "bounded-response.zip", { type: "application/zip" }));
    const input = document.getElementById("import-file");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, boundedArchive.toString("base64"));
  await page.waitForFunction(async (title) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return dictionaryState?.dictionaries?.some((entry) => entry.title === title);
  }, { timeout: 90_000, polling: 100 }, boundedTitle);
  const boundedReplies = await page.evaluate(async (dictionary) => {
    const request = (type, fields) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type, requestId: `bounded-${type}`, ...fields,
    });
    const before = await request("hd_status", {});
    const global = await request("hd_lookup", { text: "限界" });
    const selected = await request("hd_lookup_dictionary", { dictionary, text: "限界" });
    const nul = await request("hd_kanji", { character: "食\0" });
    const healthy = await request("hd_lookup", { text: "速度" });
    const after = await request("hd_status", {});
    return { before, global, selected, nul, healthy, after };
  }, boundedTitle);
  check(
    "real-WASM lookup bounds fail one request without poisoning the OPFS engine",
    [boundedReplies.global, boundedReplies.selected].every((reply) => reply.ok === false
      && reply.results?.length === 0 && /glossary/u.test(reply.error))
      && boundedReplies.nul.ok === false && /NUL/u.test(boundedReplies.nul.error)
      && boundedReplies.healthy.ok === true
      && boundedReplies.healthy.results[0]?.term.expression === "速度"
      && boundedReplies.before.generation === boundedReplies.after.generation
      && boundedReplies.after.ready === true && boundedReplies.after.storageBackend === "opfs",
    JSON.stringify(boundedReplies),
  );
  await tab2.evaluate(() => {
    document.getElementById("verb").textContent = "速度";
    const oversized = document.getElementById("kanjiword");
    oversized.textContent = "限界";
    // Keep this target outside the healthy word's popup hit area.
    oversized.style.cssText = "position:fixed;left:800px;top:32px";
  });
  const boundedPopupBefore = await hoverForPopup(tab2, popup2, "#verb");
  await tab2.mouse.move(2, 2);
  const oversizedWord = await tab2.$("#kanjiword");
  const oversizedBox = await oversizedWord.boundingBox();
  await tab2.mouse.move(oversizedBox.x + 5, oversizedBox.y + oversizedBox.height / 2);
  const boundedPopupHidden = await popup2.waitForHidden();
  const boundedPopupAfter = await hoverForPopup(tab2, popup2, "#verb");
  check(
    "an oversized hover clears the previous popup and the next healthy hover recovers",
    boundedPopupBefore?.plain?.includes("healthy bounded lookup")
      && boundedPopupHidden
      && boundedPopupAfter?.plain?.includes("healthy bounded lookup"),
    JSON.stringify({ before: boundedPopupBefore?.plain, hidden: boundedPopupHidden, after: boundedPopupAfter?.plain }),
  );

  const renderFailures = [];
  const onRenderConsole = (message) => {
    if (message.text().includes("could not render results")) renderFailures.push(message.text());
  };
  tab2.on("console", onRenderConsole);
  await tab2.evaluate(() => { document.getElementById("kanjiword").textContent = "深度"; });
  await tab2.mouse.move(2, 2);
  await tab2.mouse.move(oversizedBox.x + 5, oversizedBox.y + oversizedBox.height / 2);
  const deepPopupHidden = await popup2.waitForHidden();
  const deepPopupAfter = await hoverForPopup(tab2, popup2, "#verb");
  tab2.off("console", onRenderConsole);
  check(
    "a structured-depth render failure clears its popup and the next healthy hover recovers",
    renderFailures.length === 1 && deepPopupHidden
      && deepPopupAfter?.plain?.includes("healthy bounded lookup"),
    JSON.stringify({ renderFailures, hidden: deepPopupHidden, after: deepPopupAfter?.plain }),
  );

  const mediaEvidence = await page.evaluate(async (dictionary) => {
    const request = (type, fields) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type, requestId: `bounded-media-${type}`, ...fields,
    });
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const installed = dictionaryState.dictionaries.find((entry) => entry.title === dictionary);
    const before = await request("hd_status", {});
    const generation = before.generation;
    const exact = await request("hd_media", { generation, dictionary, path: "media/exact.png" });
    const bytes = Uint8Array.from(atob(exact.dataUrl?.split(",")[1] ?? ""), (character) => character.charCodeAt(0));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    const over = await request("hd_media", { generation, dictionary, path: "media/over.png" });
    const nul = await request("hd_media", { generation, dictionary, path: "media/exact.png\0suffix" });
    const absent = await request("hd_media", { generation, dictionary, path: "media/absent.png" });
    const healthy = await request("hd_lookup", { text: "速度" });
    const after = await request("hd_status", {});
    return { mediaCount: installed?.mediaCount, before, exactOk: exact.ok, bytes: bytes.length, digest,
      over: { ok: over.ok, error: over.error, empty: over.dataUrl === null },
      nul: { ok: nul.ok, error: nul.error, empty: nul.dataUrl === null }, absent, healthy, after };
  }, boundedTitle);
  check(
    "large media imports through OPFS while oversized and malformed fetches fail without poisoning the engine",
    mediaEvidence.mediaCount === 2 && mediaEvidence.exactOk && mediaEvidence.bytes === exactMediaBytes.length
      && mediaEvidence.digest === createHash("sha256").update(exactMediaBytes).digest("hex")
      && mediaEvidence.over.ok === false && mediaEvidence.over.empty && /media/u.test(mediaEvidence.over.error)
      && mediaEvidence.nul.ok === false && mediaEvidence.nul.empty && /NUL/u.test(mediaEvidence.nul.error)
      && mediaEvidence.absent.ok === true && mediaEvidence.absent.dataUrl === null
      && mediaEvidence.healthy.ok === true && mediaEvidence.healthy.results[0]?.term.expression === "速度"
      && mediaEvidence.after.ready && mediaEvidence.after.storageBackend === "opfs"
      && mediaEvidence.before.generation === mediaEvidence.after.generation,
    JSON.stringify(mediaEvidence),
  );

  await mediaOwnershipChrome({ browser, page, tab: tab2, popup: popup2 });
  await boundedMediaChrome({ browser, page, tab: tab2, popup: popup2 });
  await imagePreviewChrome({ browser, page, tab: tab2, popup: popup2 });
  await imageSizingChrome({ page, tab: tab2, popup: popup2 });
  await checkStartupFileAccess(page, browser, startupUrl);
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
