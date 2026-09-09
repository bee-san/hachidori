#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { directoryContentSha256, hostSnapshot, sha256File } from "./system.mjs";

const SCRIPT_REPO = resolve(import.meta.dirname, "..");
const REPO = resolve(process.env.HACHIDORI_BENCH_REPO || SCRIPT_REPO);
const EXTENSION = resolve(REPO, "extension");
const TITLE = "Bee's Ultimate Kanji Dictionary";
const EXPECTED_ARCHIVE_BYTES = 11_782_705;
const EXPECTED_ARCHIVE_SHA256 = "f96fbead89f86a584298f710d71f49eccec623b54f1c73a00501a87567e93f09";
const EXPECTED_DICTIONARY_COUNT = 2;
const TARGET = "hoshidicts-offscreen";
const TIMEOUT_MS = 300_000;
const QUERIES = ["食", "日", "生", "行", "人", "見", "学", "大", "本", "年", "時", "手"];

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function cachedChrome(cache) {
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
    const root = resolve(cache, name, "chrome");
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

function cachedPuppeteer(cache) {
  return ["hachidori-e2e", "hdw-e2e"]
    .map((name) => resolve(
      cache,
      name,
      "node_modules",
      "puppeteer-core",
      "lib",
      "puppeteer",
      "puppeteer-core.js",
    ))
    .find(existsSync) ?? "";
}

function revision(path) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
}

const archiveInput = process.env.HACHIDORI_KANJI_ARCHIVE;
if (!archiveInput) {
  throw new Error("set HACHIDORI_KANJI_ARCHIVE to the pinned Bee's Ultimate Kanji Dictionary ZIP");
}
const cache = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const chromeInput = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || cachedChrome(cache);
const puppeteerInput = process.env.HACHIDORI_PUPPETEER || cachedPuppeteer(cache);
const ARCHIVE = resolve(archiveInput);
const CHROME = chromeInput ? resolve(chromeInput) : "";
const PUPPETEER = puppeteerInput ? resolve(puppeteerInput) : "";
const SAMPLE_COUNT = positiveInteger(process.env.HACHIDORI_KANJI_SAMPLES, 3, "HACHIDORI_KANJI_SAMPLES");
const LOOKUP_PASSES = positiveInteger(process.env.HACHIDORI_KANJI_PASSES, 3, "HACHIDORI_KANJI_PASSES");
const QUIET = process.env.HACHIDORI_KANJI_QUIET === "1";

for (const [label, path] of [["archive", ARCHIVE], ["Chrome", CHROME], ["Puppeteer", PUPPETEER]]) {
  if (!path || !existsSync(path)) throw new Error(`${label} not found: ${path || "(not configured)"}`);
}

const archiveIdentity = {
  bytes: statSync(ARCHIVE).size,
  sha256: sha256File(ARCHIVE),
};
if (archiveIdentity.bytes !== EXPECTED_ARCHIVE_BYTES
    || archiveIdentity.sha256 !== EXPECTED_ARCHIVE_SHA256) {
  throw new Error(
    `archive identity mismatch: expected ${EXPECTED_ARCHIVE_BYTES} bytes/${EXPECTED_ARCHIVE_SHA256}, `
    + `got ${archiveIdentity.bytes} bytes/${archiveIdentity.sha256}`,
  );
}

const puppeteer = await import(pathToFileURL(PUPPETEER).href);
let nextRequestId = 0;
let browserVersion = "";
let expectedSignatures = null;

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function request(page, type, fields = {}) {
  const requestId = `kanji-click-benchmark-${++nextRequestId}`;
  const result = await page.evaluate(async ({ target, type: requestType, requestId: id, fields: payload }) => {
    const started = performance.now();
    const reply = await chrome.runtime.sendMessage({
      target,
      type: requestType,
      requestId: id,
      ...payload,
    });
    return { latencyMs: performance.now() - started, reply };
  }, { target: TARGET, type, requestId, fields });
  if (result.reply?.type !== `${type}_result` || result.reply.requestId !== requestId
      || result.reply.ok !== true || result.reply.error !== null) {
    throw new Error(`${type} failed: ${JSON.stringify(result.reply)}`);
  }
  return result;
}

async function waitReady(page, expectedCount) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    try {
      last = (await request(page, "hd_status")).reply;
      if (last.ready === true && last.loading === false && last.dictionaryCount === expectedCount) return last;
    } catch (error) {
      last = { error: error.message };
    }
    await sleep(100);
  }
  throw new Error(`engine not ready: ${JSON.stringify(last)}`);
}

async function extensionId(browser) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker"
      && candidate.url().startsWith("chrome-extension://"),
    { timeout: TIMEOUT_MS },
  );
  return new URL(target.url()).host;
}

async function openSettings(browser, id) {
  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.on("console", (message) => process.stderr.write(`[settings] ${message.type()}: ${message.text()}\n`));
  page.on("pageerror", (error) => process.stderr.write(`[settings] pageerror: ${error.message}\n`));
  await page.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const input = document.getElementById("import-file");
    return input && !input.disabled;
  }, { timeout: TIMEOUT_MS });
  return page;
}

async function importArchive(page, archiveUrl) {
  await page.evaluate(() =>
    document.querySelector('#library-navigation a[href="#add-dictionaries"]')?.click());
  await page.waitForFunction(() => {
    const input = document.getElementById("import-file");
    return input && !input.disabled && !input.closest("[hidden]");
  }, { timeout: TIMEOUT_MS });
  await page.evaluate(async ({ archiveUrl: url, name }) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`archive fetch failed: HTTP ${response.status}`);
    const file = new File([await response.blob()], name, { type: "application/zip" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById("import-file");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { archiveUrl, name: ARCHIVE.split("/").at(-1) });
  await page.waitForFunction(() =>
    /^Finished 1 of 1 archive — 1 imported, 0 failed\.$/u.test(
      document.getElementById("import-state")?.textContent?.trim() || "",
    ), { timeout: TIMEOUT_MS, polling: 50 });
}

async function launch(profile) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 10 * 60 * 1000,
    userDataDir: profile,
    args: [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
    ],
  });
  const version = await browser.version();
  if (browserVersion && browserVersion !== version) {
    throw new Error(`Chrome version changed during benchmark: ${browserVersion} -> ${version}`);
  }
  browserVersion = version;
  return browser;
}

function semanticSignature(reply) {
  const { generation: _generation, requestId: _requestId, type: _type, ...semantic } = reply;
  return JSON.stringify(semantic);
}

async function lookup(page, type, character) {
  const result = await request(page, type, {
    dictionary: TITLE,
    maxResults: 32,
    options: {
      frequencyDictionary: "",
      frequencyOrder: "auto",
      primaryReading: "",
    },
    scanLength: 1,
    text: character,
  });
  if (!Array.isArray(result.reply.results) || result.reply.results.length === 0) {
    throw new Error(`${type} missed ${character}`);
  }
  return { latencyMs: result.latencyMs, signature: semanticSignature(result.reply) };
}

async function measurePhase(page) {
  const firstSelected = await lookup(page, "hd_lookup_dictionary", QUERIES[0]);
  const selectedMs = [];
  const ordinaryMs = [];
  const signatures = {};
  for (let pass = 0; pass < LOOKUP_PASSES; pass += 1) {
    for (const character of QUERIES) {
      const ordinary = await lookup(page, "hd_lookup", character);
      const selected = await lookup(page, "hd_lookup_dictionary", character);
      if (selected.signature !== ordinary.signature) {
        throw new Error(`selected and ordinary lookup semantics differ for ${character}`);
      }
      if (signatures[character] && signatures[character] !== selected.signature) {
        throw new Error(`lookup semantics changed between passes for ${character}`);
      }
      signatures[character] = selected.signature;
      ordinaryMs.push(ordinary.latencyMs);
      selectedMs.push(selected.latencyMs);
    }
  }
  if (firstSelected.signature !== signatures[QUERIES[0]]) {
    throw new Error(`first selected lookup semantics differ for ${QUERIES[0]}`);
  }
  if (expectedSignatures === null) {
    expectedSignatures = signatures;
  } else if (JSON.stringify(expectedSignatures) !== JSON.stringify(signatures)) {
    throw new Error("lookup semantics changed between profiles or restart phases");
  }
  return { firstSelectedMs: firstSelected.latencyMs, selectedMs, ordinaryMs };
}

async function close(browser) {
  const process = browser.process();
  await browser.close();
  if (process?.exitCode === null && process?.signalCode === null) {
    await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome did not exit")), 10_000);
      process.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
  return {
    n: sorted.length,
    min: sorted[0],
    median: pick(0.5),
    p95: pick(0.95),
    max: sorted.at(-1),
  };
}

const samples = [];
const totalStarted = performance.now();
const archiveServer = createServer((request_, response) => {
  if (request_.url !== "/dictionary.zip") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Length": archiveIdentity.bytes,
    "Content-Type": "application/zip",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  createReadStream(ARCHIVE).pipe(response);
});
await new Promise((resolveListen, reject) => {
  archiveServer.once("error", reject);
  archiveServer.listen(0, "127.0.0.1", resolveListen);
});
const archiveAddress = archiveServer.address();
const archiveUrl = `http://127.0.0.1:${archiveAddress.port}/dictionary.zip`;

try {
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const profile = mkdtempSync(resolve(tmpdir(), `hachidori-kanji-click-${sample}-`));
    let browser;
    try {
      process.stderr.write(`sample ${sample + 1}/${SAMPLE_COUNT}: import profile\n`);
      browser = await launch(profile);
      const id = await extensionId(browser);
      let page = await openSettings(browser, id);
      await waitReady(page, 0);
      await importArchive(page, archiveUrl);
      await waitReady(page, EXPECTED_DICTIONARY_COUNT);
      const postImport = await measurePhase(page);
      await close(browser);
      browser = null;

      process.stderr.write(`sample ${sample + 1}/${SAMPLE_COUNT}: retained-profile restart\n`);
      browser = await launch(profile);
      const restartedId = await extensionId(browser);
      if (restartedId !== id) throw new Error(`extension ID changed: ${id} -> ${restartedId}`);
      page = await openSettings(browser, id);
      await waitReady(page, EXPECTED_DICTIONARY_COUNT);
      const postRestart = await measurePhase(page);
      samples.push({ sample, postImport, postRestart });
      if (!QUIET) process.stdout.write(`${JSON.stringify(samples.at(-1))}\n`);
    } finally {
      if (browser) {
        try {
          await close(browser);
        } catch {
          browser.process()?.kill("SIGKILL");
        }
      }
      rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await new Promise((resolveClose, reject) =>
    archiveServer.close((error) => error ? reject(error) : resolveClose()));
}

const aggregate = {};
for (const phase of ["postImport", "postRestart"]) {
  aggregate[phase] = {
    firstSelectedMs: stats(samples.map((sample) => sample[phase].firstSelectedMs)),
    selectedMs: stats(samples.flatMap((sample) => sample[phase].selectedMs)),
    ordinaryMs: stats(samples.flatMap((sample) => sample[phase].ordinaryMs)),
  };
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  revisions: {
    hachidori: revision(REPO),
    hoshidicts: revision(resolve(REPO, "third_party/hoshidicts")),
  },
  extensionSha256: directoryContentSha256(EXTENSION),
  archive: { path: ARCHIVE, ...archiveIdentity },
  chrome: { path: CHROME, version: browserVersion },
  host: hostSnapshot(),
  sampleCount: SAMPLE_COUNT,
  lookupPasses: LOOKUP_PASSES,
  queries: QUERIES,
  elapsedMs: performance.now() - totalStarted,
  aggregate,
}, null, 2)}\n`);
