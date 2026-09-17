// SPDX-License-Identifier: GPL-3.0-or-later
// Alternating production-path benchmark against a warm isolated Anki profile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAnkiGateway } from "../extension/anki.js";
import { createAnkiDuplicateIndex } from "../extension/anki-index-cache.js";
import { ankiIndexSource, lookupAnkiIndex } from "../extension/anki-index.js";
import { createAnkiMiningService } from "../extension/anki-mining.js";
import "../extension/reader-options.js";

const template = value => ({ value, overwriteMode: "coalesce" });

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`Expected --name value pairs, got ${JSON.stringify(argv.slice(index))}.`);
    }
    values[name.slice(2)] = argv[index + 1];
  }
  const endpoint = values.endpoint ?? "http://127.0.0.1:18765";
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !url.port) {
    throw new Error("The benchmark endpoint must be an explicit loopback HTTP URL with a port.");
  }
  if (url.port === "8765") {
    throw new Error("Refusing the standard AnkiConnect port 8765; use an isolated profile and port.");
  }
  const expectedMediaDir = values["expected-media-dir"];
  if (!expectedMediaDir) throw new Error("--expected-media-dir is required to prove which isolated profile is open.");
  const runs = Number(values.runs ?? 200);
  const warmups = Number(values.warmups ?? 20);
  if (!Number.isSafeInteger(runs) || runs < 2 || !Number.isSafeInteger(warmups) || warmups < 1) {
    throw new Error("--runs must be at least 2 and --warmups at least 1.");
  }
  return {
    endpoint: url.toString(),
    expectedMediaDir: resolve(expectedMediaDir),
    model: values.model ?? "Hachidori Duplicate Index Benchmark",
    deck: values.deck ?? "Hachidori Duplicate Index Benchmark",
    expression: values.expression ?? "統合重複索引ベンチ",
    ankiVersion: values["anki-version"] ?? null,
    runs,
    warmups,
    output: values.output ? resolve(values.output) : null,
  };
}

function percentile(values, fraction) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[rank];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summary(samples, requests) {
  return {
    samples: samples.length,
    medianMs: median(samples),
    p95Ms: percentile(samples, 0.95),
    requestCount: requests,
    requestsPerRun: requests / samples.length,
  };
}

function actionCounts(actions) {
  return Object.fromEntries([...new Set(actions)].sort()
    .map(action => [action, actions.filter(value => value === action).length]));
}

const elapsedMs = started => Number(process.hrtime.bigint() - started) / 1e6;

async function ensureFixture(invoke, config, expression) {
  const mediaDir = resolve(await invoke("getMediaDirPath", {}));
  const models = await invoke("modelNames", {});
  if (!Array.isArray(models) || models.some(model => typeof model !== "string")) {
    throw new Error("AnkiConnect returned an invalid note type list.");
  }
  if (!models.includes(config.model)) {
    await invoke("createModel", {
      modelName: config.model,
      inOrderFields: ["Expression", "Back"],
      css: "",
      isCloze: false,
      cardTemplates: [{
        Name: "Card 1",
        Front: "{{Expression}}",
        Back: "{{FrontSide}}<hr id=answer>{{Back}}",
      }],
    });
  } else {
    const fields = await invoke("modelFieldNames", { modelName: config.model });
    if (JSON.stringify(fields) !== JSON.stringify(["Expression", "Back"])) {
      throw new Error(`Benchmark note type ${JSON.stringify(config.model)} has unexpected fields.`);
    }
  }
  await invoke("createDeck", { deck: config.deck });
  const source = await ankiIndexSource(config);
  let duplicate = await lookupAnkiIndex(invoke, source, expression);
  if (!duplicate.noteIds.length) {
    const noteId = await invoke("addNote", {
      note: {
        deckName: config.deck,
        modelName: config.model,
        fields: { Expression: expression, Back: "benchmark fixture" },
        tags: ["hachidori_duplicate_index_benchmark"],
        options: { allowDuplicate: true },
      },
    });
    if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new Error("Anki did not create the benchmark note.");
    duplicate = await lookupAnkiIndex(invoke, source, expression);
  }
  if (!duplicate.noteIds.length) throw new Error("The benchmark duplicate could not be read back.");
  return { mediaDir, source, duplicate };
}

async function inMemoryIndex(config, live) {
  let state;
  const index = createAnkiDuplicateIndex({
    async fetchRows() { throw new Error("A measured duplicate lookup must not refresh the index."); },
    lookupLive: live,
    readOptions: async () => ({ anki: config }),
    readState: async () => structuredClone(state),
    async updateState(update) {
      const next = await update({ options: { anki: config }, state: structuredClone(state) });
      if (next !== undefined) state = structuredClone(next);
      return structuredClone(state);
    },
    alarms: { async get() {}, async clear() {}, async create() {} },
    reportError(error) { throw error; },
  });
  return index;
}

function miningService(gateway, duplicateIndex, config) {
  return createAnkiMiningService({
    gateway,
    duplicateIndex,
    readConfig: async () => config,
    buildFields: async request => ({
      fields: {
        Expression: request.term.expression,
        Back: "benchmark fixture",
      },
    }),
  });
}

function measuredGateway(actions) {
  return createAnkiGateway({
    fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      actions.push(request.action);
      return globalThis.fetch(url, options);
    },
  });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const apiKey = process.env.HACHIDORI_ANKI_API_KEY ?? "";
  const gateway = createAnkiGateway();
  const config = globalThis.HDReaderOptions.normaliseOptions({ anki: {
    url: options.endpoint,
    apiKey,
    model: options.model,
    deck: options.deck,
    duplicateScope: "model",
    fieldTemplates: {
      Expression: template("{expression}"),
      Back: template("{definition}"),
    },
  } }).anki;
  const uncountedInvoke = (action, params, timeoutMs) =>
    gateway.invoke(action, params, apiKey, timeoutMs, options.endpoint);
  const fixture = await ensureFixture(uncountedInvoke, config, options.expression);
  if (resolve(fixture.mediaDir) !== options.expectedMediaDir) {
    throw new Error(`Anki opened ${fixture.mediaDir}; expected isolated media directory ${options.expectedMediaDir}.`);
  }

  const cache = await inMemoryIndex(config,
    (source, expression, invoke) => lookupAnkiIndex(invoke, source, expression));
  const primed = await cache.lookup(config, options.expression, uncountedInvoke);
  assert.deepEqual(primed.noteIds, fixture.duplicate.noteIds);
  const actions = { live: [], warm: [] };
  const warmService = miningService(measuredGateway(actions.warm), cache, config);
  const request = { term: { expression: options.expression, reading: "" } };
  assert.deepEqual((await warmService.view(request)).noteIds, fixture.duplicate.noteIds);
  assert.equal(actions.warm.length, 0, "a warm View readiness hit contacted Anki");

  const samples = { live: [], warm: [] };
  const total = options.warmups + options.runs;
  for (let iteration = 0; iteration < total; iteration++) {
    if (iteration === options.warmups) {
      actions.live.length = 0;
      actions.warm.length = 0;
    }
    const order = iteration % 2 === 0 ? ["live", "warm"] : ["warm", "live"];
    for (const path of order) {
      let liveService;
      if (path === "live") {
        const index = await inMemoryIndex(config,
          (source, expression, invoke) => lookupAnkiIndex(invoke, source, expression));
        await index.peek(config, options.expression);
        liveService = miningService(measuredGateway(actions.live), index, config);
      }
      const started = process.hrtime.bigint();
      let result;
      if (path === "live") {
        const miss = await liveService.view(request);
        assert.equal(miss.cached, false);
        assert.deepEqual(miss.noteIds, []);
        const status = await liveService.status();
        assert.equal(status.available, true);
        result = await liveService.preflight({ ...request, configKey: status.configKey });
      } else {
        result = await warmService.view(request);
      }
      const duration = elapsedMs(started);
      assert.deepEqual(result.noteIds, fixture.duplicate.noteIds);
      assert.equal(result.state, "duplicate");
      if (iteration >= options.warmups) samples[path].push(duration);
    }
  }

  const live = { ...summary(samples.live, actions.live.length), actionCounts: actionCounts(actions.live),
    rawSamplesMs: samples.live };
  const warm = { ...summary(samples.warm, actions.warm.length), actionCounts: actionCounts(actions.warm),
    rawSamplesMs: samples.warm };
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch { /* A source archive has no Git metadata. */ }
  const report = {
    schemaVersion: 2,
    measuredAt: new Date().toISOString(),
    scope: "Service-level View readiness for one known duplicate. The live path starts with an eligible empty canonical index, then performs the same status and preflight fallback as a popup cache miss. Browser messaging, DOM rendering, fixture setup and the complete-index refresh are excluded.",
    environment: {
      commit,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      ankiVersion: options.ankiVersion,
      ankiConnectApiVersion: await uncountedInvoke("version", {}),
    },
    endpoint: options.endpoint,
    mediaDir: fixture.mediaDir,
    model: config.model,
    deck: config.deck,
    expression: options.expression,
    noteIds: fixture.duplicate.noteIds,
    warmups: options.warmups,
    alternatingRuns: options.runs,
    live,
    warm,
    medianSpeedup: live.medianMs / warm.medianMs,
    p95Speedup: live.p95Ms / warm.p95Ms,
  };
  if (options.output) {
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "w" });
  }
  console.log(JSON.stringify(report, null, 2));
  console.log([
    "",
    "| View readiness path | median (ms) | p95 (ms) | requests | requests/run |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| Cache miss, status + live scoped repair | ${live.medianMs.toFixed(3)} | ${live.p95Ms.toFixed(3)} | ${live.requestCount} | ${live.requestsPerRun.toFixed(2)} |`,
    `| Warm canonical-index positive | ${warm.medianMs.toFixed(3)} | ${warm.p95Ms.toFixed(3)} | ${warm.requestCount} | ${warm.requestsPerRun.toFixed(2)} |`,
    "",
    `Median speedup: ${report.medianSpeedup.toFixed(1)}x`,
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

export { actionCounts, argumentsFrom, median, percentile, summary };
