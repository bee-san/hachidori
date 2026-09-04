// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { closeBrowserVerified, verifyBrowserCleanupAfterFailure } from "./browser.mjs";
import {
  lookupSemanticSignature,
  selectedComparisonQueries,
} from "./comparison-lib.mjs";
import { sha256Canonical } from "./lib.mjs";
import { hostSnapshot, startProcessSampler } from "./system.mjs";

function describe(error) {
  return error?.stack || error?.message || String(error);
}

export async function retryTransientEvaluation(operation, {
  attempts,
  timeoutMs,
  label,
}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await new Promise((resolvePromise, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`${label} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        Promise.resolve().then(operation).then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolvePromise(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts`, { cause: lastError });
}

function chromeArguments(definition, config) {
  const args = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--disable-extensions-except=${definition.runtime.yomitanExtensionPath}`,
    `--load-extension=${definition.runtime.yomitanExtensionPath}`,
  ];
  if (config.allowNoSandbox) args.push("--no-sandbox");
  return args;
}

function normalizeResult(raw, query) {
  if (!raw || !Array.isArray(raw.dictionaryEntries) || !Number.isInteger(raw.originalTextLength)) {
    throw new Error(`Yomitan returned an invalid termsFind result for ${query.id}`);
  }
  const expressions = [...new Set(raw.dictionaryEntries.flatMap((entry) =>
    Array.isArray(entry?.headwords)
      ? entry.headwords.map((headword) => headword?.term).filter((term) => typeof term === "string")
      : []))].sort();
  const normalizedResponse = {
    resultCount: raw.dictionaryEntries.length,
    expressions,
    originalTextLength: raw.originalTextLength,
  };
  return {
    queryId: query.id,
    text: query.text,
    latencyMs: raw.latencyMs,
    resultCount: normalizedResponse.resultCount,
    expressions,
    responseSha256: sha256Canonical(normalizedResponse),
  };
}

async function rawLookup(page, queries, label) {
  return page.evaluate(async ({ queryRows, prefix }) => {
    const send = (action, params = {}) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, params }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else if (!response || response.error) reject(new Error(JSON.stringify(response?.error ?? "missing response")));
        else resolve(response.result);
      });
    });
    const options = await send("optionsGetFull");
    const details = [];
    const passStart = performance.now();
    for (let index = 0; index < queryRows.length; index += 1) {
      const query = queryRows[index];
      const started = performance.now();
      const result = await send("termsFind", {
        text: query.text,
        details: {},
        optionsContext: { index: options.profileCurrent },
      });
      const ended = performance.now();
      details.push({ ...result, latencyMs: ended - started, requestId: `${prefix}-${index}` });
    }
    return { wallMs: performance.now() - passStart, details };
  }, {
    queryRows: queries.map(({ id, text }) => ({ id, text })),
    prefix: `${label}-${Date.now()}`,
  });
}

async function lookupDataset(page, queries, label, index) {
  const raw = await rawLookup(page, queries, label);
  const details = raw.details.map((entry, offset) => normalizeResult(entry, queries[offset]));
  return {
    ...(index === undefined ? {} : { index }),
    wallMs: raw.wallMs,
    details,
    semanticSha256: lookupSemanticSignature(details),
  };
}

async function extensionId(browser, timeoutMs) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker" && candidate.url().startsWith("chrome-extension://"),
    { timeout: Math.min(timeoutMs, 60_000) },
  );
  const id = new URL(target.url()).host;
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`Yomitan extension ID is invalid: ${id}`);
  return id;
}

async function openSettings(browser, id, timeoutMs, diagnostics) {
  const page = await browser.newPage();
  page.on("console", (message) => diagnostics.push(`[settings console ${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`[settings pageerror] ${describe(error)}`));
  await page.goto(`chrome-extension://${id}/settings.html`, {
    waitUntil: "domcontentloaded",
    timeout: Math.min(timeoutMs, 60_000),
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.loaded === "true",
    { timeout: timeoutMs, polling: 20 },
  );
  return page;
}

async function instrumentImport(page) {
  await page.evaluate(() => {
    const input = document.querySelector("#dictionary-import-file-input");
    const button = document.querySelector("#dictionary-import-button");
    const progress = [...document.querySelectorAll(".dictionary-import-progress")];
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement) || progress.length === 0) {
      throw new Error("Yomitan import controls are missing");
    }
    globalThis.__hachidoriComparisonImport = {
      startedMs: null,
      busySeen: false,
      uiCompletedMs: null,
    };
    const observe = () => {
      const state = globalThis.__hachidoriComparisonImport;
      if (button.disabled || progress.some((node) => !node.hidden)) state.busySeen = true;
    };
    new MutationObserver(observe).observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    input.addEventListener("change", () => {
      globalThis.__hachidoriComparisonImport.startedMs = performance.now();
      observe();
    }, { capture: true, once: true });
  });
}

async function waitForImport(page, timeoutMs) {
  await page.waitForFunction(() => {
    const state = globalThis.__hachidoriComparisonImport;
    const button = document.querySelector("#dictionary-import-button");
    const error = document.querySelector("#dictionary-error");
    const installed = document.querySelector("#dictionary-install-count")?.textContent?.trim();
    const progress = [...document.querySelectorAll(".dictionary-import-progress")];
    if (!state || typeof state.startedMs !== "number") return false;
    if (error && !error.hidden && (error.textContent ?? "").trim() !== "") {
      throw new Error(`Yomitan dictionary import failed: ${(error.textContent ?? "").trim()}`);
    }
    const complete = state.busySeen === true && installed === "1"
      && button instanceof HTMLButtonElement && !button.disabled
      && progress.length > 0 && progress.every((node) => node.hidden);
    if (complete && state.uiCompletedMs === null) state.uiCompletedMs = performance.now();
    return complete;
  }, { timeout: timeoutMs, polling: 20 });
  return page.evaluate(() => ({ ...globalThis.__hachidoriComparisonImport }));
}

async function readOptions(page, timeoutMs) {
  return retryTransientEvaluation(() => page.evaluate(async () => {
    const send = (action, params = {}) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, params }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else if (!response || response.error) reject(new Error(JSON.stringify(response?.error ?? "missing response")));
        else resolve(response.result);
      });
    });
    const [options, dictionaries] = await Promise.all([
      send("optionsGetFull"),
      send("getDictionaryInfo"),
    ]);
    const profile = options.profiles[options.profileCurrent];
    return {
      profileCurrent: options.profileCurrent,
      dictionaries: profile.options.dictionaries,
      maxResults: profile.options.general.maxResults,
      dictionaryInfo: dictionaries,
      manifest: chrome.runtime.getManifest(),
    };
  }), {
    attempts: 3,
    timeoutMs: Math.min(timeoutMs, 30_000),
    label: "Yomitan options read",
  });
}

async function ensureEnabled(page, timeoutMs) {
  let state = await readOptions(page, timeoutMs);
  if (state.dictionaries.length !== 1) {
    throw new Error(`Yomitan installed ${state.dictionaries.length} dictionary settings, expected 1`);
  }
  if (!state.dictionaries[0].enabled) {
    await page.click('[data-modal-action="show,dictionaries"]');
    await page.waitForSelector(".dictionary-enabled", { visible: true, timeout: Math.min(timeoutMs, 30_000) });
    await page.click(".dictionary-enabled");
    await page.waitForFunction(async () => {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "optionsGetFull", params: {} }, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) reject(new Error(lastError.message));
          else if (!response || response.error) reject(new Error(JSON.stringify(response?.error ?? "missing response")));
          else resolve(response.result);
        });
      });
      const profile = result.profiles[result.profileCurrent];
      return profile.options.dictionaries.length === 1 && profile.options.dictionaries[0].enabled === true;
    }, { timeout: Math.min(timeoutMs, 30_000), polling: 20 });
    state = await readOptions(page, timeoutMs);
  }
  return state;
}

export async function runYomitanSample({ item, corpus, config, definition, output, launch }) {
  const attempt = item.attempt ?? 0;
  const runDirectory = resolve(output, "runs", `${item.runId}-attempt-${String(attempt).padStart(2, "0")}`);
  const profilePath = resolve(runDirectory, "profile");
  rmSync(runDirectory, { recursive: true, force: true });
  mkdirSync(profilePath, { recursive: true });
  const diagnostics = [];
  const startedUtc = new Date().toISOString();
  const hostStart = hostSnapshot();
  const queries = selectedComparisonQueries(config, corpus.id);
  let browser = null;
  let sampler = null;
  try {
    browser = await launch.launch({
      executablePath: definition.runtime.chromePath,
      headless: config.headless,
      protocolTimeout: config.timeoutMs,
      userDataDir: profilePath,
      args: chromeArguments(definition, config),
    });
    browser.on("targetcreated", (target) => diagnostics.push(`[target ${target.type()}] ${target.url()}`));
    const id = await extensionId(browser, config.timeoutMs);
    diagnostics.push(`[stage] service worker ready ${id}`);
    const page = await openSettings(browser, id, config.timeoutMs, diagnostics);
    diagnostics.push("[stage] settings ready");
    await instrumentImport(page);
    sampler = startProcessSampler(browser.process().pid);
    const input = await page.$("#dictionary-import-file-input");
    if (!input) throw new Error("Yomitan dictionary file input is missing");
    await input.uploadFile(corpus.archive);
    diagnostics.push("[stage] archive submitted");
    const importTiming = await waitForImport(page, config.timeoutMs);
    diagnostics.push(`[stage] import UI complete ${importTiming.uiCompletedMs - importTiming.startedMs} ms`);
    const options = await ensureEnabled(page, config.timeoutMs);
    diagnostics.push("[stage] dictionary enabled");
    if (options.manifest.version !== definition.engines.find((engine) => engine.id === item.engine).version) {
      throw new Error(`Yomitan manifest version ${options.manifest.version} does not match the pinned release`);
    }
    if (options.maxResults !== config.lookup.maxResults) {
      throw new Error(`Yomitan maxResults ${options.maxResults}, expected ${config.lookup.maxResults}`);
    }
    if (!Array.isArray(options.dictionaryInfo) || options.dictionaryInfo.length !== 1) {
      throw new Error(`Yomitan database contains ${options.dictionaryInfo?.length ?? "no"} dictionary records, expected 1`);
    }
    const dictionaryInfo = options.dictionaryInfo[0];
    if (dictionaryInfo.title !== corpus.expectedReport.title
      || dictionaryInfo.counts?.terms?.total !== corpus.expectedReport.termCount) {
      throw new Error(`Yomitan imported unexpected dictionary metadata: ${JSON.stringify({
        title: dictionaryInfo.title,
        terms: dictionaryInfo.counts?.terms?.total,
      })}`);
    }
    const firstQuery = queries.find((query) => (query.expectByCorpus?.[corpus.id] ?? query.expect) === "hit");
    if (!firstQuery) throw new Error(`${corpus.id} has no first-hit query`);
    const firstRaw = await rawLookup(page, [firstQuery], `first-${item.runId}`);
    diagnostics.push("[stage] first lookup complete");
    const firstLookup = normalizeResult(firstRaw.details[0], firstQuery);
    const importCompletedMs = await page.evaluate(() => performance.now());
    const importUsableWallMs = importCompletedMs - importTiming.startedMs;
    const importCoreWallMs = importTiming.uiCompletedMs - importTiming.startedMs;
    const resources = sampler.stop();
    sampler = null;
    const warmup = await lookupDataset(page, queries, `warm-${item.runId}`);
    const passes = [];
    for (let index = 0; index < config.lookupPasses; index += 1) {
      passes.push(await lookupDataset(page, queries, `pass-${index}-${item.runId}`, index));
    }
    diagnostics.push("[stage] measured lookups complete");
    const semanticSha256 = warmup.semanticSha256;
    if (passes.some((pass) => pass.semanticSha256 !== semanticSha256)) {
      throw new Error("Yomitan lookup semantics changed after warmup");
    }
    await closeBrowserVerified(browser, diagnostics);
    browser = null;
    const enabled = options.dictionaries.filter((dictionary) => dictionary.enabled);
    const result = {
      metrics: { importUsableWallMs, importCoreWallMs },
      firstLookup,
      lookup: {
        warmupExcluded: true,
        queryIds: queries.map((query) => query.id),
        queryFixtureSha256: sha256Canonical(queries),
        semanticSha256,
        warmup,
        passes,
      },
      productionEvidence: {
        verified: true,
        adapter: "yomitan-browser-extension",
        manifestVersion: options.manifest.version,
        manifestName: options.manifest.name,
        extensionId: id,
        importPath: "settings.html#dictionary-import-file-input",
        lookupPath: "chrome.runtime.sendMessage:termsFind",
        installedDictionaryCount: options.dictionaries.length,
        enabledDictionaryCount: enabled.length,
        dictionaryNames: enabled.map((dictionary) => dictionary.name),
        dictionaryInfo: options.dictionaryInfo.map((dictionary) => ({
          title: dictionary.title,
          revision: dictionary.revision,
          version: dictionary.version,
          sequenced: dictionary.sequenced,
          counts: dictionary.counts,
          importSuccess: dictionary.importSuccess,
          sourceLanguage: dictionary.sourceLanguage,
          targetLanguage: dictionary.targetLanguage,
          isUpdatable: dictionary.isUpdatable,
        })),
        maxResults: options.maxResults,
        importTransitionObserved: importTiming.busySeen,
      },
      resources,
      profilePath,
      processExitVerified: true,
      diagnostics,
      hostStart,
      hostEnd: hostSnapshot(),
      startedUtc,
      endedUtc: new Date().toISOString(),
    };
    writeFileSync(resolve(runDirectory, "diagnostics.log"), `${diagnostics.join("\n")}\n`);
    return result;
  } catch (error) {
    if (sampler) {
      try { sampler.stop(); } catch (samplerError) { diagnostics.push(`[sampler] ${describe(samplerError)}`); }
    }
    let finalError = error;
    try {
      await verifyBrowserCleanupAfterFailure(browser, diagnostics, error);
    } catch (cleanupError) {
      finalError = cleanupError;
    }
    writeFileSync(resolve(runDirectory, "diagnostics.log"), `${diagnostics.join("\n")}\n`);
    finalError.benchmarkContext = {
      profilePath,
      runDirectory,
      diagnostics: diagnostics.slice(-100),
      hostStart,
      hostEnd: hostSnapshot(),
      startedUtc,
      endedUtc: new Date().toISOString(),
    };
    throw finalError;
  }
}
