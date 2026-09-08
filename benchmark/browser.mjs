// SPDX-License-Identifier: GPL-3.0-or-later

import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  analyzeLookupPass,
  canonicalJson,
  orderQueries,
  sha256Canonical,
  validateStoredDictionaries,
} from "./lib.mjs";
import {
  hostSnapshot,
  startDescendantProcessSampler,
  startProcessSampler,
} from "./system.mjs";

const TARGET = "hoshidicts-offscreen";
const ARCHIVE_IMPORT_COMPLETION = /^Finished (\d+) of (\d+) archives? — (\d+) imported, (\d+) failed\.$/;
let requestCounter = 0;

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function archiveImportCounts(text) {
  const match = ARCHIVE_IMPORT_COMPLETION.exec(text);
  if (!match) return null;
  return {
    completed: Number(match[1]),
    total: Number(match[2]),
    imported: Number(match[3]),
    failed: Number(match[4]),
  };
}

export function isTerminalArchiveImportState(text) {
  return archiveImportCounts(text) !== null;
}

export function isSuccessfulArchiveImportState(text) {
  const counts = archiveImportCounts(text);
  return counts !== null
    && counts.completed === counts.total
    && counts.imported === counts.total
    && counts.failed === 0;
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error) {
  return error?.stack || error?.message || String(error);
}

function watchBrowser(browser, diagnostics) {
  const watched = new Set();
  const watch = async (target) => {
    if (watched.has(target)) return;
    watched.add(target);
    try {
      if (target.url().endsWith("offscreen.html")) {
        const cdp = await target.createCDPSession();
        await cdp.send("Runtime.enable");
        const flatten = (args) => (args || [])
          .map((argument) => argument.value ?? argument.description ?? argument.unserializableValue ?? "")
          .join(" ");
        cdp.on("Runtime.consoleAPICalled", (event) => {
          diagnostics.push(`[offscreen] ${event.type}: ${flatten(event.args)}`);
        });
        cdp.on("Runtime.exceptionThrown", (event) => {
          diagnostics.push(`[offscreen] exception: ${event.exceptionDetails?.exception?.description
            ?? event.exceptionDetails?.text ?? "unknown"}`);
        });
      }
    } catch (error) {
      diagnostics.push(`[harness] could not inspect ${target.type()} ${target.url()}: ${describe(error)}`);
    }
  };
  browser.on("targetcreated", watch);
  for (const target of browser.targets()) watch(target);
}

export function chromeArguments(definition, config) {
  const args = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--disable-extensions-except=${definition.runtime.extensionPath}`,
    `--load-extension=${definition.runtime.extensionPath}`,
  ];
  if (config.allowNoSandbox) args.unshift("--no-sandbox");
  return args;
}

async function launchBrowser(launch, definition, config, profile, diagnostics) {
  const started = performance.now();
  const browser = await launch.launch({
    executablePath: definition.runtime.chromePath,
    headless: config.headless ? true : false,
    userDataDir: profile,
    args: chromeArguments(definition, config),
  });
  watchBrowser(browser, diagnostics);
  return { browser, launchWallMs: performance.now() - started };
}

async function extensionIdOf(browser, timeoutMs) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker"
      && candidate.url().startsWith("chrome-extension://"),
    { timeout: timeoutMs },
  );
  return new URL(target.url()).host;
}

function serviceWorkerTarget(browser, extensionId) {
  return browser.targets().find((target) => target.type() === "service_worker"
    && target.url().startsWith(`chrome-extension://${extensionId}/`));
}

async function waitForTargetDestroyed(browser, target, timeoutMs) {
  const started = performance.now();
  let destroyed;
  try {
    await withTimeout(new Promise((resolveDestroyed) => {
      destroyed = (candidate) => {
        if (candidate === target) resolveDestroyed();
      };
      browser.on("targetdestroyed", destroyed);
      if (!browser.targets().includes(target)) resolveDestroyed();
    }), timeoutMs, "service worker termination");
  } finally {
    if (destroyed) browser.off("targetdestroyed", destroyed);
  }
  return performance.now() - started;
}

async function openSettings(browser, extensionId, diagnostics, label, timeoutMs) {
  const page = await browser.newPage();
  page.on("console", (message) => diagnostics.push(`[${label}] ${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`[${label}] pageerror: ${error.message}`));
  await page.evaluateOnNewDocument(() => {
    window.__hdwImportHandlerAttached = false;
    const original = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function benchmarkObservedAddEventListener(type, listener, options) {
      if (type === "change" && this instanceof HTMLInputElement && this.id === "import-file") {
        window.__hdwImportHandlerAttached = true;
      }
      return original.call(this, type, listener, options);
    };
  });
  await page.goto(`chrome-extension://${extensionId}/settings.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__hdwImportHandlerAttached === true, { timeout: timeoutMs });
  return page;
}

async function openIdleProbe(browser, extensionId, diagnostics) {
  const page = await browser.newPage();
  page.on("console", (message) => diagnostics.push(`[idle-probe] ${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`[idle-probe] pageerror: ${error.message}`));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url() === `chrome-extension://${extensionId}/settings.js`) request.abort();
    else request.continue();
  });
  await page.goto(`chrome-extension://${extensionId}/settings.html`, { waitUntil: "domcontentloaded" });
  const usable = await page.evaluate(() => typeof chrome?.runtime?.sendMessage === "function");
  if (!usable) throw new Error("idle probe has no chrome.runtime access");
  return page;
}

async function runtimeRequest(page, type, fields, timeoutMs) {
  const requestId = `benchmark-${type.replace(/^hd_/, "")}-${++requestCounter}`;
  const reply = await withTimeout(page.evaluate(async ({ target, type: requestType, requestId: id, fields: payload }) =>
    chrome.runtime.sendMessage({ target, type: requestType, requestId: id, ...payload }), {
    target: TARGET,
    type,
    requestId,
    fields,
  }), timeoutMs, type);
  if (!reply || reply.type !== `${type}_result` || reply.requestId !== requestId) {
    throw new Error(`${type} returned an invalid response envelope`);
  }
  if (reply.ok !== true || reply.error !== null) {
    const error = new Error(`${type} failed: ${reply?.error ?? "invalid response"}`);
    error.extensionResponse = reply;
    throw error;
  }
  return reply;
}

async function waitForReady(page, timeoutMs, expectedDictionaryCount) {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      last = await runtimeRequest(page, "hd_status", {}, Math.min(10_000, Math.max(1, deadline - Date.now())));
    } catch (error) {
      if (error.extensionResponse) throw error;
      last = { ok: false, error: describe(error) };
    }
    if (last?.ok === true && last.ready === true && last.loading === false) {
      if (expectedDictionaryCount !== undefined && last.dictionaryCount !== expectedDictionaryCount) {
        throw new Error(`engine loaded ${last.dictionaryCount} dictionaries, expected ${expectedDictionaryCount}`);
      }
      return { status: last, wallMs: performance.now() - started };
    }
    if (Date.now() >= deadline) {
      throw new Error(`engine did not become ready: ${canonicalJson(last)}`);
    }
    await sleep(100);
  }
}

async function installImportProbe(page) {
  const installed = await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const state = { active: null };
    window.__hdwBenchmarkImport = state;
    const wrapped = async (...args) => {
      const message = args[0];
      if (message?.type !== "hd_import" || !state.active) return original(...args);
      state.active.requestId = message.requestId;
      state.active.messageStart = performance.now();
      try {
        const reply = await original(...args);
        state.active.reply = reply;
        return reply;
      } catch (error) {
        state.active.messageError = error?.message ?? String(error);
        throw error;
      } finally {
        state.active.messageEnd = performance.now();
        state.active.messageDone = true;
      }
    };
    try {
      chrome.runtime.sendMessage = wrapped;
    } catch {
      return false;
    }
    return chrome.runtime.sendMessage === wrapped;
  });
  if (!installed) throw new Error("could not instrument settings.html's chrome.runtime.sendMessage");
}

async function importThroughSettings(page, archive, timeoutMs, beforeUpload) {
  await page.bringToFront();
  await page.click('#library-navigation a[href="#add-dictionaries"]');
  await page.waitForFunction(() => {
    const input = document.getElementById("import-file");
    return input && !input.disabled && !input.closest("[hidden]") && input.getBoundingClientRect().width > 0;
  }, { timeout: timeoutMs });
  await installImportProbe(page);
  const input = await page.$("#import-file");
  if (!input) throw new Error("settings.html has no #import-file");
  await page.evaluate((completionPattern) => {
    const completion = new RegExp(completionPattern);
    const state = window.__hdwBenchmarkImport;
    state.active = {
      userStart: performance.now(),
      requestId: null,
      messageStart: null,
      messageEnd: null,
      messageDone: false,
      uiEnd: null,
      uiState: "",
      uiDetail: "",
      reply: null,
      messageError: null,
    };
    const outcome = () => {
      const text = (document.getElementById("import-state")?.textContent || "").trim();
      if (!completion.test(text)) return;
      state.active.uiEnd = performance.now();
      state.active.uiState = text;
      state.active.uiDetail = (document.getElementById("import-detail")?.textContent || "").trim();
      observer.disconnect();
    };
    const observer = new MutationObserver(outcome);
    observer.observe(document.getElementById("import-state"), { childList: true, subtree: true, characterData: true });
  }, ARCHIVE_IMPORT_COMPLETION.source);
  await beforeUpload();
  await input.uploadFile(archive);
  await page.waitForFunction(() => {
    const active = window.__hdwBenchmarkImport?.active;
    return active?.messageDone === true && active?.uiEnd !== null;
  }, { timeout: timeoutMs, polling: 50 });
  return page.evaluate(() => {
    const active = window.__hdwBenchmarkImport.active;
    return {
      reply: active.reply,
      requestId: active.requestId,
      messageError: active.messageError,
      userStartMs: active.userStart,
      messageStartMs: active.messageStart,
      messageEndMs: active.messageEnd,
      uiEndMs: active.uiEnd,
      messageWallMs: active.messageEnd - active.messageStart,
      userVisibleWallMs: active.uiEnd - active.userStart,
      uiState: active.uiState,
      uiDetail: active.uiDetail,
    };
  });
}

async function rawLookupPass(page, queries, options, timeoutMs, label) {
  return withTimeout(page.evaluate(async ({ queries: fixtures, options: lookupOptions, prefix }) => {
    const observations = [];
    const passStart = performance.now();
    for (let index = 0; index < fixtures.length; index += 1) {
      const query = fixtures[index];
      const requestId = `${prefix}-${index}`;
      const started = performance.now();
      const reply = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_lookup",
        requestId,
        text: query.text,
        maxResults: lookupOptions.maxResults,
        scanLength: lookupOptions.scanLength,
        options: lookupOptions.options,
      });
      observations.push({ queryId: query.id, requestId, latencyMs: performance.now() - started, reply });
    }
    const passEnd = performance.now();
    return { wallMs: passEnd - passStart, endMs: passEnd, observations };
  }, {
    queries: queries.map(({ id, text }) => ({ id, text })),
    options,
    prefix: `${label}-${Date.now()}`,
  }), timeoutMs, `lookup pass ${label}`);
}

async function runLookupPhase(page, queries, config, corpus, phase, dictionaryCount) {
  const warmRaw = await rawLookupPass(page, queries, config.lookup, config.timeoutMs, `${phase}-warmup`);
  const warm = analyzeLookupPass(queries, warmRaw.observations, corpus, dictionaryCount);
  const responseEvidence = { ...warm.responseEvidence };
  if (warm.expectationMismatches.length > 0) {
    throw new Error(`${phase} lookup expectations failed: ${canonicalJson(warm.expectationMismatches)}`);
  }
  const passes = [];
  for (let index = 0; index < config.lookupPasses; index += 1) {
    const raw = await rawLookupPass(page, queries, config.lookup, config.timeoutMs, `${phase}-${index}`);
    const analysis = analyzeLookupPass(queries, raw.observations, corpus, dictionaryCount);
    if (analysis.signature !== warm.signature) {
      throw new Error(`${phase} pass ${index} correctness signature drifted`);
    }
    if (analysis.generation !== warm.generation) {
      throw new Error(`${phase} pass ${index} engine generation changed`);
    }
    if (analysis.expectationMismatches.length > 0) {
      throw new Error(`${phase} lookup expectations failed: ${canonicalJson(analysis.expectationMismatches)}`);
    }
    Object.assign(responseEvidence, analysis.responseEvidence);
    passes.push({
      index,
      wallMs: raw.wallMs,
      latenciesMs: analysis.latenciesMs,
      details: analysis.details,
      signature: analysis.signature,
    });
  }
  return {
    signature: warm.signature,
    generation: warm.generation,
    hitCount: warm.hitCount,
    missCount: warm.missCount,
    responseEvidence,
    warmup: {
      wallMs: warmRaw.wallMs,
      latenciesMs: warm.latenciesMs,
      details: warm.details,
      signature: warm.signature,
    },
    passes,
  };
}

async function firstLookup(page, queries, config, corpus, phase, dictionaryCount) {
  const query = queries.find((candidate) =>
    (candidate.expectByCorpus?.[corpus] ?? candidate.expect) === "hit");
  if (!query) throw new Error(`${corpus} has no positive query for the first-usable lookup barrier`);
  const raw = await rawLookupPass(page, [query], config.lookup, config.timeoutMs, `${phase}-first`);
  const analysis = analyzeLookupPass([query], raw.observations, corpus, dictionaryCount);
  if (analysis.expectationMismatches.length > 0) {
    throw new Error(`${phase} first lookup expectation failed: ${canonicalJson(analysis.expectationMismatches)}`);
  }
  return {
    wallMs: raw.wallMs,
    completedAtMs: raw.endMs,
    latencyMs: analysis.latenciesMs[0],
    signature: analysis.signature,
    responseEvidence: analysis.responseEvidence,
    generation: analysis.generation,
    detail: analysis.details[0],
  };
}

function expectedDictionaryCount(corpus, report) {
  if (Number.isInteger(corpus.expectedDictionaryCount)) return corpus.expectedDictionaryCount;
  const counts = [report.termCount, report.frequencyCount, report.pitchCount, report.kanjiCount]
    .filter((count) => Number(count) > 0).length;
  return counts || 1;
}

async function opfsSnapshot(page) {
  return page.evaluate(async () => {
    const files = [];
    async function walk(directory, prefix = "") {
      for await (const [name, handle] of directory.entries()) {
        const path = `${prefix}${name}`;
        if (handle.kind === "directory") {
          await walk(handle, `${path}/`);
          continue;
        }
        const file = await handle.getFile();
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        files.push({
          path,
          bytes: file.size,
          sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        });
      }
    }
    await walk(await navigator.storage.getDirectory());
    files.sort((left, right) => left.path.localeCompare(right.path));
    const estimate = await navigator.storage.estimate();
    return {
      backend: "opfs",
      origin: location.origin,
      logicalBytes: files.reduce((total, file) => total + file.bytes, 0),
      usageBytes: estimate.usage,
      quotaBytes: estimate.quota,
      fileCount: files.length,
      files,
    };
  });
}

function verifyImport(corpus, imported) {
  const reply = imported.reply;
  if (!reply || reply.type !== "hd_import_result" || reply.requestId !== imported.requestId) {
    throw new Error("import returned an invalid response envelope");
  }
  if (reply.ok !== true || reply.report?.success !== true) {
    const error = new Error(`import failed: ${reply.error ?? imported.messageError ?? imported.uiDetail ?? "no detail"}`);
    error.benchmarkFailure = { phase: "import", origin: "extension", response: reply };
    throw error;
  }
  if (reply.error !== null) throw new Error("successful import returned an unexpected error field");
  if (!isSuccessfulArchiveImportState(imported.uiState)) {
    throw new Error(`settings page did not report success: ${imported.uiState}`);
  }
  for (const [key, expected] of Object.entries(corpus.expectedReport ?? {})) {
    if (reply.report[key] !== expected) {
      throw new Error(`import report ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(reply.report[key])}`);
    }
  }
  return reply.report;
}

function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return;
  await withTimeout(once(child, "exit"), timeoutMs, "browser process exit");
}

async function forceKillChild(child, diagnostics) {
  if (childExited(child)) return;
  try {
    const signalled = child.kill("SIGKILL");
    if (!signalled && !childExited(child)) throw new Error("SIGKILL was not delivered");
    await waitForChildExit(child, 2_000);
  } catch (error) {
    diagnostics.push(`[harness] browser force-kill failed: ${describe(error)}`);
    throw error;
  }
}

export async function closeBrowserVerified(
  browser,
  diagnostics = [],
  timeoutMs = 10_000,
) {
  if (!browser) return;
  const child = browser.process?.() ?? null;
  let failure = null;
  try {
    await withTimeout(Promise.resolve().then(() => browser.close()), timeoutMs, "browser close");
    if (!child) throw new Error("browser process handle is unavailable after close");
    await waitForChildExit(child, timeoutMs);
  } catch (error) {
    failure = error;
    diagnostics.push(`[harness] browser close failed: ${describe(error)}`);
    try {
      await forceKillChild(child, diagnostics);
    } catch (killError) {
      if (!failure) failure = killError;
    }
  }
  if (failure) {
    if (/timed out/i.test(failure.message ?? "")) {
      throw new Error(`browser did not exit after close: ${failure.message}`, { cause: failure });
    }
    throw failure;
  }
}

export async function verifyBrowserCleanupAfterFailure(
  browser,
  diagnostics,
  originalError,
  timeoutMs = 10_000,
) {
  try {
    await closeBrowserVerified(browser, diagnostics, timeoutMs);
    return true;
  } catch (shutdownError) {
    const error = new Error(
      `${describe(originalError)}; browser shutdown could not be verified: ${describe(shutdownError)}`,
      { cause: shutdownError },
    );
    error.benchmarkFailure = {
      phase: "cleanup",
      origin: "harness",
      originalPhase: originalError.benchmarkFailure?.phase ?? null,
      originalOrigin: originalError.benchmarkFailure?.origin ?? null,
    };
    throw error;
  }
}

export function assertIdleContinuity({
  beforeStatus,
  afterStatus,
  beforeContextIds,
  afterContextIds,
  lookupGeneration,
  lookupSignature,
  expectedSignature,
}) {
  if (!Array.isArray(beforeContextIds) || !Array.isArray(afterContextIds)
    || beforeContextIds.length !== 1 || afterContextIds.length !== 1
    || typeof beforeContextIds[0] !== "string" || beforeContextIds[0] === ""
    || typeof afterContextIds[0] !== "string" || afterContextIds[0] === ""
    || beforeContextIds[0] !== afterContextIds[0]) {
    throw new Error(`offscreen context identity changed while idle: ${canonicalJson(beforeContextIds)} -> ${canonicalJson(afterContextIds)}`);
  }
  if (beforeStatus.generation !== afterStatus.generation
    || lookupGeneration !== afterStatus.generation) {
    throw new Error(`engine generation changed while idle: ${beforeStatus.generation} -> ${afterStatus.generation} -> ${lookupGeneration}`);
  }
  if (lookupSignature !== expectedSignature) {
    throw new Error("post-idle lookup signature differs from post-restart lookups");
  }
}

async function targetIdentity(target) {
  const session = await target.createCDPSession();
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

async function offscreenContextIds(browser, extensionId) {
  const targets = browser.targets().filter((target) =>
    target.url() === `chrome-extension://${extensionId}/offscreen.html`);
  return (await Promise.all(targets.map(targetIdentity))).sort();
}

export async function runBrowserSample({ item, corpus, config, definition, output, launch }) {
  const attempt = item.attempt ?? 0;
  const runDirectory = resolve(output, "runs", `${item.runId}-attempt-${String(attempt).padStart(2, "0")}`);
  const profile = resolve(runDirectory, "profile");
  rmSync(runDirectory, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const diagnostics = [];
  const startedUtc = new Date().toISOString();
  const hostStart = hostSnapshot();
  let browser = null;
  let activeSampler = null;
  let extensionId = null;
  const queryById = new Map(config.queries.map((query) => [query.id, query]));
  const selectedQueries = corpus.queryIds
    ? corpus.queryIds.map((queryId) => queryById.get(queryId))
    : config.queries;
  const queries = orderQueries(selectedQueries, { seed: config.seed, corpus: corpus.id });

  try {
    const firstLaunchStarted = performance.now();
    const first = await launchBrowser(launch, definition, config, profile, diagnostics);
    browser = first.browser;
    extensionId = await extensionIdOf(browser, Math.min(config.timeoutMs, 30_000));
    const page = await openSettings(browser, extensionId, diagnostics, "settings-import", config.timeoutMs);
    const initialReady = await waitForReady(page, config.timeoutMs, 0);
    const initialReadyWallMs = performance.now() - firstLaunchStarted;

    const imported = await importThroughSettings(page, corpus.archive, config.timeoutMs, async () => {
      activeSampler = startProcessSampler(browser.process().pid);
      await page.evaluate(() => {
        window.__hdwBenchmarkImport.active.userStart = performance.now();
      });
    });
    const importReport = verifyImport(corpus, imported);
    const dictionaryCount = expectedDictionaryCount(corpus, importReport);
    const afterImport = await waitForReady(page, config.timeoutMs, dictionaryCount);
    const stored = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
    const storedDictionaries = validateStoredDictionaries(
      stored?.dictionaryState?.dictionaries,
      importReport,
      dictionaryCount,
    );
    const firstAfterImport = await firstLookup(page, queries, config, corpus.id, "post-import", dictionaryCount);
    const importUsableWallMs = firstAfterImport.completedAtMs - imported.userStartMs;
    if (!Number.isFinite(importUsableWallMs) || importUsableWallMs < imported.userVisibleWallMs) {
      throw new Error("import-to-usable timing did not extend through UI completion and first lookup");
    }
    const importResources = activeSampler.stop();
    activeSampler = null;
    const postImport = await runLookupPhase(page, queries, config, corpus.id, "post-import", dictionaryCount);
    if (firstAfterImport.generation !== afterImport.status.generation
      || postImport.generation !== afterImport.status.generation) {
      throw new Error("engine generation changed between import readiness and lookup");
    }
    const storageAfterImport = await opfsSnapshot(page);
    await closeBrowserVerified(browser, diagnostics);
    browser = null;
    if (storageAfterImport.logicalBytes <= 0) throw new Error("the extension OPFS is empty after import");

    const restartStarted = performance.now();
    activeSampler = startDescendantProcessSampler(process.pid);
    const second = await launchBrowser(launch, definition, config, profile, diagnostics);
    browser = second.browser;
    const restartedExtensionId = await extensionIdOf(browser, Math.min(config.timeoutMs, 30_000));
    if (restartedExtensionId !== extensionId) {
      throw new Error(`extension id changed across restart: ${extensionId} -> ${restartedExtensionId}`);
    }
    const restartPage = await openSettings(browser, extensionId, diagnostics, "settings-restart", config.timeoutMs);
    const restoredReady = await waitForReady(restartPage, config.timeoutMs, dictionaryCount);
    const restartReadyCompleted = performance.now();
    const restartReadyWallMs = restartReadyCompleted - restartStarted;
    const firstAfterRestart = await firstLookup(restartPage, queries, config, corpus.id, "post-restart", dictionaryCount);
    const restartFirstLookupCompleted = performance.now();
    const restartUsableWallMs = restartFirstLookupCompleted - restartStarted;
    const restoreResources = activeSampler.stop();
    activeSampler = null;
    const postRestart = await runLookupPhase(restartPage, queries, config, corpus.id, "post-restart", dictionaryCount);
    if (firstAfterRestart.generation !== restoredReady.status.generation
      || postRestart.generation !== restoredReady.status.generation) {
      throw new Error("engine generation changed between restored readiness and lookup");
    }
    const storageAfterRestart = await opfsSnapshot(restartPage);

    let idle = null;
    if (config.idleCheckMs > 0) {
      await restartPage.close();
      const idlePage = await openIdleProbe(browser, extensionId, diagnostics);
      const before = await runtimeRequest(idlePage, "hd_status", {}, config.timeoutMs);
      if (before.ready !== true || before.loading !== false || before.dictionaryCount !== dictionaryCount) {
        throw new Error("engine was not ready before the idle check");
      }
      const beforeContextIds = await offscreenContextIds(browser, extensionId);
      const worker = serviceWorkerTarget(browser, extensionId);
      if (!worker) throw new Error("service worker target is missing before idle check");
      const idleWaitMs = await waitForTargetDestroyed(browser, worker, config.idleCheckMs);
      const coldStatusStarted = performance.now();
      const after = await runtimeRequest(idlePage, "hd_status", {}, config.timeoutMs);
      const coldStatusWallMs = performance.now() - coldStatusStarted;
      if (after.ready !== true || after.loading !== false || after.dictionaryCount !== dictionaryCount) {
        throw new Error("engine was not ready after service-worker restart");
      }
      const afterContextIds = await offscreenContextIds(browser, extensionId);
      const lookup = await rawLookupPass(
        idlePage,
        queries,
        config.lookup,
        config.timeoutMs,
        "post-idle",
      );
      const analysis = analyzeLookupPass(queries, lookup.observations, corpus.id, dictionaryCount);
      assertIdleContinuity({
        beforeStatus: before,
        afterStatus: after,
        beforeContextIds,
        afterContextIds,
        lookupGeneration: analysis.generation,
        lookupSignature: analysis.signature,
        expectedSignature: postRestart.signature,
      });
      idle = {
        timeoutMs: config.idleCheckMs,
        serviceWorkerTerminationObserved: true,
        serviceWorkerIdleWaitMs: idleWaitMs,
        coldStatusWallMs,
        generationBefore: before.generation,
        generationAfter: after.generation,
        statusBefore: before,
        statusAfter: after,
        offscreenContextIdsBefore: beforeContextIds,
        offscreenContextIdsAfter: afterContextIds,
        offscreenContextsBefore: beforeContextIds.length,
        offscreenContextsAfter: afterContextIds.length,
        lookupGeneration: analysis.generation,
        lookupWallMs: lookup.wallMs,
        lookupSignature: analysis.signature,
        lookup: { wallMs: lookup.wallMs, ...analysis },
      };
    }

    await closeBrowserVerified(browser, diagnostics);
    browser = null;
    const endedUtc = new Date().toISOString();
    const row = {
      schemaVersion: 1,
      runId: item.runId,
      attempt,
      corpus: corpus.id,
      warmup: item.warmup,
      round: item.round,
      iteration: item.iteration,
      order: item.order,
      valid: true,
      shutdownVerified: true,
      extensionId,
      runDefinitionSha256: sha256Canonical(definition),
      archiveSha256: corpus.archiveSha256,
      archiveBytes: corpus.archiveBytes,
      importReport,
      importRequestId: imported.requestId,
      importResponse: imported.reply,
      importReportSignature: sha256Canonical(importReport),
      dictionaryCount,
      storedDictionaries,
      lookupQueryIds: queries.map((query) => query.id),
      lookupQueryFixtureSha256: sha256Canonical(queries),
      metrics: {
        initialLaunchWallMs: first.launchWallMs,
        initialReadyWallMs,
        importUsableWallMs,
        importWallMs: imported.userVisibleWallMs,
        importMessageWallMs: imported.messageWallMs,
        importPeakRssBytes: importResources.peakRssBytes,
        importPeakProcessCount: importResources.peakProcessCount,
        importProcessTreeCpuTicks: importResources.processTreeCpuTicks,
        importRssSampleIntervalMs: importResources.sampleIntervalMs,
        importRssSamples: importResources.samples,
        postImportReadyWaitMs: afterImport.wallMs,
        firstLookupAfterImportMs: firstAfterImport.latencyMs,
        restartLaunchWallMs: second.launchWallMs,
        restartReadyWallMs,
        restartUsableWallMs,
        restoreReadyWaitMs: restoredReady.wallMs,
        restorePeakRssBytes: restoreResources.peakRssBytes,
        restorePeakProcessCount: restoreResources.peakProcessCount,
        restoreProcessTreeCpuTicks: restoreResources.processTreeCpuTicks,
        restoreRssSampleIntervalMs: restoreResources.sampleIntervalMs,
        restoreRssSamples: restoreResources.samples,
        firstLookupAfterRestartMs: firstAfterRestart.latencyMs,
      },
      timingEvidence: {
        importPagePerformanceNow: {
          userStartMs: imported.userStartMs,
          messageStartMs: imported.messageStartMs,
          messageEndMs: imported.messageEndMs,
          uiEndMs: imported.uiEndMs,
          firstLookupCompletedMs: firstAfterImport.completedAtMs,
        },
        restartHostPerformanceNow: {
          startedMs: restartStarted,
          readyMs: restartReadyCompleted,
          firstLookupCompletedMs: restartFirstLookupCompleted,
        },
      },
      lookup: { postImport, postRestart },
      firstLookup: { postImport: firstAfterImport, postRestart: firstAfterRestart },
      idle,
      profilePath: profile,
      profileRetained: true,
      storage: storageAfterRestart,
      storageAfterImport,
      lifecycle: {
        initialStatus: initialReady.status,
        afterImportStatus: afterImport.status,
        restoredStatus: restoredReady.status,
      },
      hostStart,
      hostEnd: hostSnapshot(),
      startedUtc,
      endedUtc,
      diagnostics,
    };
    writeFileSync(resolve(runDirectory, "diagnostics.log"), `${diagnostics.join("\n")}\n`);
    return row;
  } catch (error) {
    if (activeSampler) {
      try {
        activeSampler.stop();
      } catch (samplerError) {
        diagnostics.push(`[harness] process sampler stop failed: ${describe(samplerError)}`);
      }
      activeSampler = null;
    }
    let finalError = error;
    let shutdownVerified = false;
    try {
      shutdownVerified = await verifyBrowserCleanupAfterFailure(browser, diagnostics, error);
    } catch (cleanupError) {
      finalError = cleanupError;
    }
    writeFileSync(resolve(runDirectory, "diagnostics.log"), `${diagnostics.join("\n")}\n`);
    finalError.benchmarkContext = {
      runDirectory,
      profile,
      profileRetained: true,
      shutdownVerified,
      extensionId,
      diagnostics: diagnostics.slice(-100),
      hostStart,
      hostEnd: hostSnapshot(),
      startedUtc,
      endedUtc: new Date().toISOString(),
    };
    throw finalError;
  }
}
