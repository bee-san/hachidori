// SPDX-License-Identifier: GPL-3.0-or-later
// Popup Anki readiness for K results against a real, isolated AnkiConnect.
// Loads one checkout's production gateway, duplicate index, live lookup and
// mining service, then measures what a popup cache miss costs: status, then
// every result's preflight the way that checkout's reader asks for them (one
// `preflightMany` batch when it has one, otherwise one `preflight` per result
// in order). Pass `--extension /path/to/other/checkout/extension` to compare
// revisions with the same harness.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIKU_FIELDS = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "Picture",
  "SelectionText", "MainDefinition", "Glossary", "Sentence", "SentenceFurigana", "PitchPosition",
  "PitchCategories", "Frequency", "FreqSort", "MiscInfo"];
const SENREN_FIELDS = ["word", "reading", "sentence", "sentenceFurigana", "sentenceAudio", "definition", "wordAudio",
  "picture", "glossary", "frequencies", "freqSort", "miscInfo"];
// The destination and three other recognized note types (#440's collection).
const MODELS = [
  { name: "Kiku Benchmark", fields: KIKU_FIELDS },
  { name: "Lapis Benchmark", fields: KIKU_FIELDS },
  { name: "Lapis Benchmark Morph", fields: KIKU_FIELDS },
  { name: "Senren Benchmark", fields: SENREN_FIELDS },
];
const DECK = "Hachidori Popup Readiness Benchmark";
const TAG = "hachidori_popup_readiness_benchmark";
// Already in Anki: 猫 as the destination type, 犬 only as another recognized type.
const PRESENT = [["Kiku Benchmark", "Expression", "猫"], ["Lapis Benchmark", "Expression", "犬"]];
// A popup's results: an unknown verb's forms, repeated expressions and both duplicates.
const WORDS = ["食べる", "食べられる", "猫", "食べる", "犬", "飲む", "見る", "猫", "行く", "来る"];

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`Expected --name value pairs, got ${JSON.stringify(argv.slice(index))}.`);
    }
    values[name.slice(2)] = argv[index + 1];
  }
  const url = new URL(values.endpoint ?? "http://127.0.0.1:18765");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !url.port) {
    throw new Error("The benchmark endpoint must be an explicit loopback HTTP URL with a port.");
  }
  if (url.port === "8765") throw new Error("Refusing the standard AnkiConnect port 8765; use an isolated profile and port.");
  if (!values["expected-media-dir"]) throw new Error("--expected-media-dir is required to prove which isolated profile is open.");
  const entries = (values.entries ?? "1,5,10").split(",").map(Number);
  const runs = Number(values.runs ?? 10), warmups = Number(values.warmups ?? 2), seed = Number(values.seed ?? 0);
  if (!entries.every(value => Number.isSafeInteger(value) && value >= 1 && value <= WORDS.length)) {
    throw new Error(`--entries takes a comma-separated list of counts from 1 to ${WORDS.length}.`);
  }
  if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(warmups) || warmups < 0
      || !Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("--runs must be at least 1, and --warmups and --seed at least 0.");
  }
  return {
    extension: resolve(values.extension ?? resolve(dirname(fileURLToPath(import.meta.url)), "../extension")),
    endpoint: url.toString(),
    expectedMediaDir: resolve(values["expected-media-dir"]),
    entries,
    scopes: (values.scopes ?? "model,deck,all").split(","),
    behaviors: (values.behaviors ?? "prevent,new").split(","),
    runs,
    warmups,
    seed,
    label: values.label ?? null,
    output: values.output ? resolve(values.output) : null,
  };
}

const elapsedMs = started => Number(process.hrtime.bigint() - started) / 1e6;
const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const describe = body => body.action === "multi"
  ? `multi[${body.params.actions.map(entry => entry.action).join(",")}]`
  : body.action === "canAddNotesWithErrorDetail" ? `canAddNotesWithErrorDetail(${body.params.notes.length})` : body.action;

// AnkiConnect closes every socket after its reply without saying so, and
// Node's fetch would now and then reuse a socket that is closing. Ask for the
// close it performs anyway, so every request opens its own connection.
const fetchClosing = (url, init) => globalThis.fetch(url, { ...init, headers: { ...init.headers, Connection: "close" } });

async function ensureFixture(invoke, seed) {
  const existing = await invoke("modelNames", {});
  for (const model of MODELS) {
    if (existing.includes(model.name)) {
      assert.deepEqual(await invoke("modelFieldNames", { modelName: model.name }), model.fields,
        `Benchmark note type ${model.name} has unexpected fields.`);
      continue;
    }
    await invoke("createModel", { modelName: model.name, inOrderFields: model.fields, css: "", isCloze: false,
      cardTemplates: [{ Name: "Card 1", Front: `{{${model.fields[0]}}}`, Back: "{{FrontSide}}" }] });
  }
  await invoke("createDeck", { deck: DECK });
  for (const [modelName, field, value] of PRESENT) {
    if ((await invoke("findNotes", { query: `"note:${modelName}" "${field}:${value}"` })).length) continue;
    await invoke("addNote", { note: { deckName: DECK, modelName, fields: { [field]: value }, tags: [TAG],
      options: { allowDuplicate: true } } });
  }
  // Optional padding of the destination type, so Anki's field scans cost
  // what they cost in a large collection. Seeded words never match a result.
  const padded = await invoke("findNotes", { query: `"note:${MODELS[0].name}" tag:${TAG}_padding` });
  for (let index = padded.length; index < seed; index += 1000) {
    const notes = Array.from({ length: Math.min(1000, seed - index) }, (_, offset) => ({
      deckName: DECK, modelName: MODELS[0].name, tags: [TAG, `${TAG}_padding`],
      fields: { Expression: `語${index + offset}`, MainDefinition: `benchmark definition ${index + offset}` },
      options: { allowDuplicate: true },
    }));
    const ids = await invoke("addNotes", { notes }, 120_000);
    if (!Array.isArray(ids) || !ids.every(Number.isSafeInteger)) throw new Error("Anki did not add the padding notes.");
  }
  return (await invoke("findNotes", { query: "deck:*" })).length;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const module = file => import(pathToFileURL(resolve(options.extension, file)).href);
  await module("reader-options.js");
  const { createAnkiGateway } = await module("anki.js");
  const { createAnkiDuplicateIndex } = await module("anki-index-cache.js");
  const index = await module("anki-index.js");
  const { createAnkiMiningService } = await module("anki-mining.js");

  const plain = createAnkiGateway({ fetch: fetchClosing });
  const invoke = (action, params, timeoutMs) => plain.invoke(action, params, "", timeoutMs, options.endpoint);
  const mediaDir = resolve(await invoke("getMediaDirPath", {}));
  if (mediaDir !== options.expectedMediaDir) {
    throw new Error(`Anki opened ${mediaDir}; expected isolated media directory ${options.expectedMediaDir}.`);
  }
  const noteCount = await ensureFixture(invoke, options.seed);

  const template = value => ({ value, overwriteMode: "coalesce" });
  const configFor = (scope, behavior) => globalThis.HDReaderOptions.normaliseOptions({ anki: {
    url: options.endpoint, apiKey: "", model: MODELS[0].name, deck: DECK,
    duplicateScope: scope, duplicateBehavior: behavior,
    fieldTemplates: { Expression: template("{expression}"), Sentence: template("{sentence}") },
  } }).anki;
  // A fresh, eligible and empty canonical index: every result is a cache miss.
  function memoryIndex(config) {
    let state;
    return createAnkiDuplicateIndex({
      async fetchRows() { throw new Error("A measured popup must not refresh the index."); },
      lookupLive: (source, expression, call) => index.lookupAnkiIndex(call, source, expression),
      ...(index.lookupAnkiIndexMany
        ? { lookupLiveMany: (source, expressions, call) => index.lookupAnkiIndexMany(call, source, expressions) } : {}),
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
  }

  async function sample(scope, behavior, words) {
    const requests = [];
    const gateway = createAnkiGateway({ fetch: (url, init) => {
      requests.push(describe(JSON.parse(init.body)));
      return fetchClosing(url, init);
    } });
    const config = configFor(scope, behavior);
    const service = createAnkiMiningService({ gateway, duplicateIndex: memoryIndex(config),
      readConfig: async () => config,
      buildFields: async request => ({ fields: { Expression: request.term.expression, Sentence: "文" } }) });
    const batched = typeof service.preflightMany === "function";
    const started = process.hrtime.bigint();
    const { configKey } = await service.status();
    const statusRequests = requests.length;
    const preflights = words.map(expression => ({ term: { expression, reading: "" }, configKey }));
    const replies = [], ready = [];
    if (batched) {
      replies.push(...await service.preflightMany(preflights));
      ready.push(...preflights.map(() => elapsedMs(started)));
    } else {
      for (const preflight of preflights) {
        replies.push(await service.preflight(preflight));
        ready.push(elapsedMs(started));
      }
    }
    return { batched, ready, requests: requests.slice(statusRequests),
      decisions: replies.map(reply => `${reply.state}${reply.noteIds?.length ? `[${reply.noteIds.length}]` : ""}`) };
  }

  const results = [];
  for (const behavior of options.behaviors) {
    for (const scope of options.scopes) {
      for (const entries of options.entries) {
        const words = WORDS.slice(0, entries);
        const samples = [];
        for (let run = 0; run < options.warmups + options.runs; run++) {
          const value = await sample(scope, behavior, words);
          if (run >= options.warmups) samples.push(value);
        }
        const [first] = samples;
        for (const value of samples) {
          assert.deepEqual(value.requests, first.requests, "the request sequence is deterministic");
          assert.deepEqual(value.decisions, first.decisions, "the decisions are deterministic");
        }
        const lastReady = samples.map(value => value.ready.at(-1));
        results.push({ behavior, scope, entries, batched: first.batched, requests: first.requests.length,
          sequence: first.requests, decisions: first.decisions,
          firstReadyMedianMs: median(samples.map(value => value.ready[0])), lastReadyMedianMs: median(lastReady),
          rawLastReadyMs: lastReady.map(value => Math.round(value * 10) / 10) });
        const row = results.at(-1);
        console.error(`${options.label ?? options.extension} ${behavior}/${scope} K=${entries}: ${row.requests} requests, `
          + `all ready ${row.lastReadyMedianMs.toFixed(1)} ms`);
      }
    }
  }
  let commit = null;
  try {
    commit = execFileSync("git", ["-C", options.extension, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch { /* A source archive has no Git metadata. */ }
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    scope: "Service-level popup Anki readiness: status, then every result's preflight, from an empty canonical index. Field rendering, browser messaging and DOM work are excluded.",
    label: options.label,
    extension: options.extension,
    commit,
    endpoint: options.endpoint,
    mediaDir,
    noteCount,
    warmups: options.warmups,
    runs: options.runs,
    environment: { node: process.version, platform: process.platform, osRelease: os.release(),
      cpuModel: os.cpus()[0]?.model ?? null, ankiConnectApiVersion: await invoke("version", {}) },
    results,
  };
  if (options.output) writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

await main();
