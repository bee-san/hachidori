/*
 * Verifies the single-thread IDBFS runtime in a browser without cross-origin
 * isolation, which makes pthreads unavailable.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { backupChromeScenarios } from "./chrome-backup-scenarios.mjs";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION,
  CUSTOM_DICTIONARY_TITLE,
} from "../extension/custom-dictionary.js";
import { RECOMMENDED_DICTIONARIES } from "../extension/recommended-dictionaries.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSION = resolve(ROOT, "extension");

function scratchPath(value, prefix) {
  const resolved = resolve(value);
  const relativePath = relative(resolve(tmpdir()), resolved);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
    || dirname(relativePath) !== "."
    || !basename(relativePath).startsWith(prefix)
  ) {
    throw new Error(`${value} is not a dedicated ${prefix}* scratch path directly under ${tmpdir()}`);
  }
  return resolved;
}

const TEST_EXTENSION = scratchPath(
  process.env.HACHIDORI_FALLBACK_EXTENSION || `${tmpdir()}/hachidori-fallback-extension-${process.pid}`,
  "hachidori-fallback-extension-",
);
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const CUSTOM_SOURCE = "# Fallback persistence\n保存語, ほぞんご, persisted by the custom dictionary\n";
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

const CHROME = process.env.HACHIDORI_CHROME
  || process.env.CHROME_BIN
  || cachedChrome()
  || installedChrome();
const PUPPETEER_CANDIDATES = ["hachidori-e2e", "hdw-e2e"].map((name) =>
  resolve(CACHE, name, "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js"));
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || PUPPETEER_CANDIDATES.find(existsSync)
  || PUPPETEER_CANDIDATES[0];
const PROFILE = scratchPath(
  process.env.HACHIDORI_FALLBACK_PROFILE || `${tmpdir()}/hachidori-fallback-profile-${process.pid}`,
  "hachidori-fallback-profile-",
);
const puppeteer = await import(`file://${PUPPETEER}`);

function prepareExtension() {
  rmSync(TEST_EXTENSION, { recursive: true, force: true });
  cpSync(SOURCE_EXTENSION, TEST_EXTENSION, { recursive: true });
  const manifestPath = resolve(TEST_EXTENSION, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.cross_origin_embedder_policy;
  delete manifest.cross_origin_opener_policy;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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

// Accepting Start setup begins the first-run dictionary run inside the fallback
// engine. Its five catalogue downloads are answered 503 on the offscreen
// target's Fetch domain, so nothing reaches the network and the library the
// assertions below inspect stays empty until the fixture import.
const setupArchiveRequests = [];
function failSetupArchives(browser) {
  const attached = new WeakSet();
  const consider = async (target) => {
    if (!target.url().endsWith("offscreen.html") || attached.has(target)) return;
    attached.add(target);
    const session = await target.createCDPSession();
    session.on("Fetch.requestPaused", (event) => {
      void (async () => {
        const entry = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.downloadUrl === event.request.url);
        if (!entry) {
          await session.send("Fetch.continueRequest", { requestId: event.requestId });
          return;
        }
        setupArchiveRequests.push(entry.sourceId);
        await session.send("Fetch.fulfillRequest", {
          requestId: event.requestId,
          responseCode: 503,
          responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
          body: Buffer.from("fallback test: recommended archives are not downloaded").toString("base64"),
        });
      })().catch(() => {});
    });
    await session.send("Fetch.enable", {
      patterns: RECOMMENDED_DICTIONARIES.map((entry) => ({ urlPattern: entry.downloadUrl, requestStage: "Request" })),
    });
  };
  browser.on("targetcreated", (target) => { void consider(target); });
  browser.on("targetchanged", (target) => { void consider(target); });
  for (const target of browser.targets()) void consider(target);
}

async function extensionId(browser) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker" && candidate.url().startsWith("chrome-extension://"),
    { timeout: 30_000 },
  );
  return new URL(target.url()).host;
}

async function openSettings(browser, id) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  // A fresh install opens the extension's own startup tab in the foreground;
  // this page's animation-frame polling only runs while it is the visible tab.
  await page.bringToFront();
  await page.waitForFunction(() => {
    const text = (document.querySelector("#engine-status")?.textContent || "").toLowerCase();
    return text.includes("ready") || text.includes("no dictionaries") || text.includes("error");
  }, { timeout: 90_000 });
  return page;
}

async function inspect(page) {
  return page.evaluate(async ({ dictionaryId, dictionaryTitle, sourceKey }) => {
    const request = (type, fields = {}) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type,
      requestId: `fallback-${type}`,
      ...fields,
    });
    const status = await request("hd_status");
    const lookup = await request("hd_lookup", {
      text: "食べたかった",
      maxResults: 32,
      scanLength: 16,
      options: {},
    });
    const customLookup = await request("hd_lookup_dictionary", {
      dictionary: dictionaryTitle,
      text: "保存語",
    });
    const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
    const dictionaries = stored.dictionaryState?.dictionaries ?? [];
    const customDictionary = dictionaries.find(
      (dictionary) => dictionary.id === dictionaryId,
    );
    const root = await navigator.storage.getDirectory();
    const opfsEntries = [];
    for await (const [name] of root.entries()) opfsEntries.push(name);
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      status,
      lookup,
      customDictionary,
      customDictionaryFirst: dictionaries[0]?.id === dictionaryId,
      customLookup,
      customSource: stored[sourceKey] ?? null,
      opfsEntries,
    };
  }, {
    dictionaryId: CUSTOM_DICTIONARY_ID,
    dictionaryTitle: CUSTOM_DICTIONARY_TITLE,
    sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
  });
}

// The default window is narrow, so Settings shows its section picker instead of
// the sidebar links; either route must reach the section.
async function showSection(page, id) {
  await page.evaluate(section => {
    const picker = document.getElementById("settings-section");
    if (picker.checkVisibility()) {
      picker.value = section;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else document.querySelector(`.settings-nav a[href="#${section}"], #library-navigation a[href="#${section}"]`).click();
  }, id);
  await page.waitForFunction(section => {
    const visible = [...document.querySelectorAll("main > section")].filter(node => !node.hidden);
    return visible.length === 1 && visible[0].id === section;
  }, { timeout: 30_000, polling: 100 }, id);
}

async function saveCustomDictionary(page) {
  await showSection(page, "custom-dictionary");
  await page.waitForSelector("#custom-dictionary-source", { visible: true });
  await page.waitForFunction(() => {
    const form = document.getElementById("custom-dictionary-form");
    const status = document.getElementById("custom-dictionary-status")?.textContent ?? "";
    return form?.hidden === false && status === "Loaded source revision 0.";
  }, { timeout: 30_000, polling: 100 });
  await page.$eval("#custom-dictionary-source", (textarea, source) => {
    textarea.value = source;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, CUSTOM_SOURCE);
  await page.click("#custom-dictionary-save");
  await page.waitForFunction(async ({ dictionaryId, sourceKey, sourceText }) => {
    const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
    const custom = stored.dictionaryState?.dictionaries?.[0];
    const status = document.getElementById("custom-dictionary-status")?.textContent ?? "";
    return stored[sourceKey]?.revision === 1
      && stored[sourceKey]?.text === sourceText
      && custom?.id === dictionaryId
      && custom.enabled === true
      && custom.termCount === 1
      && status.includes("rebuilt the custom dictionary");
  }, { timeout: 120_000, polling: 250 }, {
    dictionaryId: CUSTOM_DICTIONARY_ID,
    sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
    sourceText: CUSTOM_SOURCE,
  });
}

rmSync(PROFILE, { recursive: true, force: true });
prepareExtension();
let browser;
let passed = false;
try {
  browser = await launch();
  failSetupArchives(browser);
  const id = await extensionId(browser);
  const startupTarget = await browser.waitForTarget(target => target.url() === `chrome-extension://${id}/startup.html`);
  const startup = await startupTarget.page();
  await startup.waitForSelector("#setup-start", { visible: true });
  assert.equal(setupArchiveRequests.length, 0, "fallback setup waits for the welcome decision");
  await startup.evaluate(() => document.getElementById("setup-start").click());
  let page = await openSettings(browser, id);
  // Let the automatic run fail all five sources before importing through the
  // same engine lock; a single run must have asked for each source once.
  await page.waitForFunction(async (expected) => {
    const { setupState } = await chrome.storage.local.get("setupState");
    const outcomes = setupState?.dictionaries?.outcomes ?? {};
    return expected.every((sourceId) => outcomes[sourceId]?.status === "failed") && setupState.dictionaries.totalSeconds !== null;
  }, { timeout: 120_000, polling: 100 }, RECOMMENDED_DICTIONARIES.map((entry) => entry.sourceId));
  assert.deepEqual([...setupArchiveRequests].sort(), RECOMMENDED_DICTIONARIES.map((entry) => entry.sourceId).sort());
  await showSection(page, "add-dictionaries");
  await page.waitForSelector("#import-file", { visible: true });
  const input = await page.$("#import-file");
  await input.uploadFile(FIXTURE);
  await page.waitForFunction(
    () => (document.querySelector("#import-state")?.textContent || "").trim()
      === "Finished 1 of 1 archive — 1 imported, 0 failed.",
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    () => document.querySelector("#engine-status")?.textContent?.includes("1 dictionary enabled"),
    { timeout: 90_000 },
  );
  await saveCustomDictionary(page);
  let observed = await inspect(page);
  assert.equal(observed.crossOriginIsolated, false);
  assert.equal(observed.status.ok, true);
  assert.equal(observed.status.storageBackend, "idbfs");
  assert.equal(observed.status.threaded, false);
  assert.equal(observed.lookup.ok, true);
  assert.equal(observed.lookup.dictionaryCount, 5);
  assert.equal(observed.lookup.results[0]?.deinflected, "食べる");
  assert.equal(observed.lookup.results[0]?.term?.frequencies?.[0]?.frequencies?.[0]?.value, 142);
  assert.equal(observed.customDictionary?.id, CUSTOM_DICTIONARY_ID);
  assert.equal(observed.customDictionary?.title, CUSTOM_DICTIONARY_TITLE);
  assert.equal(observed.customDictionaryFirst, true);
  assert.equal(observed.customDictionary?.enabled, true);
  assert.equal(observed.customDictionary?.termCount, 1);
  assert.equal(observed.customSource?.schemaVersion, CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION);
  assert.equal(observed.customSource?.revision, 1);
  assert.equal(observed.customSource?.text, CUSTOM_SOURCE);
  assert.equal(observed.customDictionary?.revision, observed.customSource?.semanticRevision);
  assert.equal(observed.customLookup?.ok, true);
  assert.equal(observed.customLookup?.results?.[0]?.term?.expression, "保存語");
  assert.match(JSON.stringify(observed.customLookup), /persisted by the custom dictionary/u);
  assert.deepEqual(observed.opfsEntries, []);
  const restoredBackup = await backupChromeScenarios({ browser, page, directory: resolve(PROFILE, "backup-downloads") });
  observed = await inspect(page);
  const customPath = observed.customDictionary.path;
  const customRevision = restoredBackup.document.revision;
  const setupBeforeRestart = await page.evaluate(async () => (await chrome.storage.local.get("setupState")).setupState);
  await browser.close();

  browser = await launch();
  failSetupArchives(browser);
  await extensionId(browser);
  page = await openSettings(browser, id);
  await page.waitForFunction(
    () => document.querySelector("#engine-status")?.textContent?.includes("2 dictionaries enabled"),
    { timeout: 90_000 },
  );
  observed = await inspect(page);
  // A browser restart neither reseeds setup nor retries the failed sources.
  assert.equal(setupArchiveRequests.length, RECOMMENDED_DICTIONARIES.length);
  assert.deepEqual(await page.evaluate(async () => (await chrome.storage.local.get("setupState")).setupState), setupBeforeRestart);
  assert.equal(observed.crossOriginIsolated, false);
  assert.equal(observed.status.storageBackend, "idbfs");
  assert.equal(observed.status.threaded, false);
  assert.equal(observed.lookup.dictionaryCount, 5);
  assert.equal(observed.lookup.results[0]?.deinflected, "食べる");
  assert.equal(observed.customDictionary?.id, CUSTOM_DICTIONARY_ID);
  assert.equal(observed.customDictionary?.title, CUSTOM_DICTIONARY_TITLE);
  assert.equal(observed.customDictionaryFirst, true);
  assert.equal(observed.customDictionary?.enabled, true);
  assert.equal(observed.customDictionary?.termCount, 1);
  assert.equal(observed.customDictionary?.path, customPath);
  assert.equal(observed.customSource?.schemaVersion, CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION);
  assert.equal(observed.customSource?.revision, customRevision);
  assert.equal(observed.customSource?.text, CUSTOM_SOURCE);
  assert.equal(observed.customDictionary?.revision, observed.customSource?.semanticRevision);
  assert.equal(observed.customLookup?.results?.[0]?.term?.expression, "保存語");
  assert.deepEqual(observed.opfsEntries, []);

  passed = true;
  console.log("single-thread IDBFS fallback imported, compiled custom source, and restored without OPFS");
} finally {
  if (browser !== undefined) await browser.close().catch(() => {});
  if (passed) {
    rmSync(PROFILE, { recursive: true, force: true });
    rmSync(TEST_EXTENSION, { recursive: true, force: true });
  } else {
    console.error(`fallback profile kept for inspection: ${PROFILE}`);
    console.error(`fallback extension kept for inspection: ${TEST_EXTENSION}`);
  }
}
