// SPDX-License-Identifier: GPL-3.0-or-later
// Times the production complete-index pull (`fetchAnkiIndex`: two `findNotes`
// plus one whole-collection `notesInfo`) and the live per-word miss path
// (`lookupAnkiIndex`: `findNotes`, `notesInfo`, `findNotes`) against a real
// isolated Anki profile seeded with a configurable number of notes. It answers
// "is the API just slow?" for hachidori#260 and decides whether the full
// `notesInfo` needs to be chunked below the 25 s worker timeout.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { createAnkiGateway } from "../extension/anki.js";
import { ankiIndexSource, fetchAnkiIndex, lookupAnkiIndex } from "../extension/anki-index.js";
import "../extension/reader-options.js";

const DEFAULTS = {
  endpoint: "http://127.0.0.1:18765",
  model: "Hachidori Duplicate Index Benchmark",
  deck: "Hachidori Duplicate Index Benchmark",
  notes: 20_000,
  runs: 5,
  backBytes: 0,
  expression: "食べる",
  output: "",
  expectedMediaDir: "",
};

function argumentsFrom(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/u, "").replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (!(key in options)) throw new Error(`Unknown option ${argv[index]}`);
    const value = argv[index + 1];
    options[key] = typeof options[key] === "number" ? Number(value) : value;
  }
  if (new URL(options.endpoint).port === "8765") {
    throw new Error("Refusing the standard AnkiConnect port; use an isolated Anki profile.");
  }
  return options;
}

const template = value => ({ value, overwriteMode: "coalesce" });
const elapsedMs = started => Number(process.hrtime.bigint() - started) / 1e6;
const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const stats = values => ({ samples: values.length, minMs: Math.min(...values), medianMs: median(values), maxMs: Math.max(...values) });

// A gateway whose fetch records the action, wall time and reply bytes of each request.
function recordingGateway(log) {
  return createAnkiGateway({
    fetch: async (url, init) => {
      const { action, params } = JSON.parse(init.body);
      const started = process.hrtime.bigint();
      const response = await globalThis.fetch(url, init);
      const text = await response.text();
      log.push({ action, ms: elapsedMs(started), bytes: text.length,
        notes: Array.isArray(params?.notes) ? params.notes.length : undefined });
      return new Response(text, { status: response.status, headers: response.headers });
    },
  });
}

async function ensureCollection(invoke, config, notes, expression, backBytes) {
  const models = await invoke("modelNames", {});
  if (!models.includes(config.model)) {
    await invoke("createModel", {
      modelName: config.model,
      inOrderFields: ["Expression", "Back"],
      css: "",
      isCloze: false,
      cardTemplates: [{ Name: "Card 1", Front: "{{Expression}}", Back: "{{FrontSide}}<hr id=answer>{{Back}}" }],
    });
  }
  await invoke("createDeck", { deck: config.deck });
  const existing = await invoke("findNotes", { query: `"note:${config.model}"` });
  const missing = notes - existing.length;
  if (missing > 0) {
    // Distinct expressions with a handful of shared kanji so rows stay realistic.
    const kanji = "食飲見聞書読話買行来帰学働遊寝起歩走泳飛切作使待持立座開閉";
    const batch = [];
    for (let index = existing.length; index < notes; index++) {
      const word = index === 0 ? expression
        : `${kanji[index % kanji.length]}${kanji[Math.floor(index / kanji.length) % kanji.length]}${index}`;
      batch.push({ deckName: config.deck, modelName: config.model, tags: ["hachidori_index_refresh_benchmark"],
        fields: { Expression: word, Back: `benchmark definition ${index} ${"<b>語</b>".repeat(Math.ceil(backBytes / 10))}` },
        options: { allowDuplicate: true } });
      if (batch.length === 1000 || index === notes - 1) {
        const ids = await invoke("addNotes", { notes: batch.splice(0) }, 120_000);
        if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id))) throw new Error("Anki did not add benchmark notes.");
        process.stderr.write(`seeded ${index + 1}/${notes}\n`);
      }
    }
  }
  return (await invoke("findNotes", { query: `"note:${config.model}"` })).length;
}

async function ensureExpression(invoke, config, source, expression) {
  const found = await lookupAnkiIndex(invoke, source, expression);
  if (found.noteIds.length) return;
  await invoke("addNote", { note: { deckName: config.deck, modelName: config.model, tags: ["hachidori_index_refresh_benchmark"],
    fields: { Expression: expression, Back: "benchmark definition" }, options: { allowDuplicate: true } } });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const log = [];
  const gateway = recordingGateway(log);
  const invoke = (action, params, timeoutMs) => gateway.invoke(action, params, "", timeoutMs, options.endpoint);
  const mediaDir = resolve(await invoke("getMediaDirPath", {}));
  if (options.expectedMediaDir && resolve(options.expectedMediaDir) !== mediaDir) {
    throw new Error(`Anki opened ${mediaDir}; expected ${options.expectedMediaDir}.`);
  }
  const config = globalThis.HDReaderOptions.normaliseOptions({ anki: {
    url: options.endpoint, apiKey: "", model: options.model, deck: options.deck, duplicateScope: "model",
    fieldTemplates: { Expression: template("{expression}"), Back: template("{definition}") },
  } }).anki;
  let noteCount = await ensureCollection(invoke, config, options.notes, options.expression, options.backBytes);
  const source = await ankiIndexSource(config);
  await ensureExpression(invoke, config, source, options.expression);
  noteCount = (await invoke("findNotes", { query: `"note:${config.model}"` })).length;

  const refresh = [], refreshActions = [];
  for (let run = 0; run < options.runs; run++) {
    log.length = 0;
    const started = process.hrtime.bigint();
    const rows = await fetchAnkiIndex(invoke, source);
    refresh.push(elapsedMs(started));
    refreshActions.push(log.map(entry => ({ ...entry, ms: Math.round(entry.ms) })));
    if (run === 0) refresh.rows = rows.length;
  }
  const live = [], liveActions = [];
  for (let run = 0; run < options.runs; run++) {
    log.length = 0;
    const started = process.hrtime.bigint();
    const result = await lookupAnkiIndex(invoke, source, options.expression);
    live.push(elapsedMs(started));
    liveActions.push(log.map(entry => ({ ...entry, ms: Math.round(entry.ms) })));
    if (run === 0 && !result.noteIds.length) throw new Error("The live lookup did not find the seeded expression.");
  }

  const perAction = actions => Object.fromEntries(["modelNamesAndIds", "findNotes", "notesInfo"].map(action => {
    const samples = actions.flatMap(run => run.filter(entry => entry.action === action));
    return samples.length ? [action, { ...stats(samples.map(entry => entry.ms)),
      bytes: Math.max(...samples.map(entry => entry.bytes)) }] : [action, null];
  }).filter(([, value]) => value));

  const git = args => { try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return null; } };
  const report = {
    endpoint: options.endpoint,
    ankiVersion: await invoke("version", {}),
    mediaDir,
    noteCount,
    backBytes: options.backBytes,
    indexRows: refresh.rows,
    workerTimeoutMs: 25_000,
    completeRefresh: { ...stats(refresh), perAction: perAction(refreshActions), runs: refreshActions },
    liveMissLookup: { ...stats(live), perAction: perAction(liveActions), runs: liveActions },
    commit: git(["rev-parse", "HEAD"]),
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model,
    measuredAt: new Date().toISOString(),
  };
  const text = JSON.stringify(report, null, 2);
  if (options.output) writeFileSync(options.output, text);
  console.log(text);
}

main().catch(error => { console.error(error); process.exit(1); });
