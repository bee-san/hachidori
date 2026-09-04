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
  return puppeteer.launch({ executablePath: CHROME, userDataDir: PROFILE, headless: true, args });
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
  await page.waitForFunction(() => {
    const text = (document.querySelector("#engine-status")?.textContent || "").toLowerCase();
    return text.includes("ready") || text.includes("no dictionaries") || text.includes("error");
  }, { timeout: 90_000 });
  return page;
}

async function inspect(page) {
  return page.evaluate(async () => {
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
    const root = await navigator.storage.getDirectory();
    const opfsEntries = [];
    for await (const [name] of root.entries()) opfsEntries.push(name);
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      status,
      lookup,
      opfsEntries,
    };
  });
}

rmSync(PROFILE, { recursive: true, force: true });
prepareExtension();
let browser;
let passed = false;
try {
  browser = await launch();
  const id = await extensionId(browser);
  let page = await openSettings(browser, id);
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
  let observed = await inspect(page);
  assert.equal(observed.crossOriginIsolated, false);
  assert.equal(observed.status.ok, true);
  assert.equal(observed.status.storageBackend, "idbfs");
  assert.equal(observed.status.threaded, false);
  assert.equal(observed.lookup.ok, true);
  assert.equal(observed.lookup.dictionaryCount, 4);
  assert.equal(observed.lookup.results[0]?.deinflected, "食べる");
  assert.equal(observed.lookup.results[0]?.term?.frequencies?.[0]?.frequencies?.[0]?.value, 142);
  assert.deepEqual(observed.opfsEntries, []);
  await browser.close();

  browser = await launch();
  await extensionId(browser);
  page = await openSettings(browser, id);
  await page.waitForFunction(
    () => document.querySelector("#engine-status")?.textContent?.includes("1 dictionary enabled"),
    { timeout: 90_000 },
  );
  observed = await inspect(page);
  assert.equal(observed.crossOriginIsolated, false);
  assert.equal(observed.status.storageBackend, "idbfs");
  assert.equal(observed.status.threaded, false);
  assert.equal(observed.lookup.dictionaryCount, 4);
  assert.equal(observed.lookup.results[0]?.deinflected, "食べる");
  assert.deepEqual(observed.opfsEntries, []);

  passed = true;
  console.log("single-thread IDBFS fallback imported, persisted, and restored without OPFS");
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
