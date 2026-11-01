#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// hdw_lookup timings in Node (docs/languages.md 19, engine contract 13): the
// four reference words and the sources of the Yomitan Japanese corpus on one
// imported dictionary, through the WebAssembly ABI on MEMFS. Each request is
// made the way a single-profile installation makes it (no language keys) and
// the way an installation with profiles makes it (`language` and
// `dictionaries`). A build without the language ABI ignores the extra keys,
// so on it the two modes measure the same request. Per-call times include the
// JSON serialisation of the reply, not messaging, OPFS or rendering.
//
//   node benchmark/node-lookup.mjs <imported dictionary directory> <corpus.tsv> [output.json]
//   HACHIDORI_WASM_VARIANT=fallback|threaded-idbfs  (default: threaded)
//   HACHIDORI_LOOKUP_PASSES=200 (reference words) HACHIDORI_CORPUS_PASSES=6
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [dictionaryDir, corpusFile, output] = process.argv.slice(2);
if (!dictionaryDir || !corpusFile) throw new Error("usage: node benchmark/node-lookup.mjs <dictionary dir> <corpus.tsv> [output.json]");
const VARIANT = { fallback: "hoshidicts", "threaded-idbfs": "hoshidicts-threaded-idbfs" }[process.env.HACHIDORI_WASM_VARIANT]
  ?? "hoshidicts-threaded";
const REFERENCE_PASSES = Number(process.env.HACHIDORI_LOOKUP_PASSES ?? 200);
const CORPUS_PASSES = Number(process.env.HACHIDORI_CORPUS_PASSES ?? 6);
const REFERENCE = ["食べました", "走り出した", "美しい景色", "日本語を勉強しています"];
const corpus = [...new Set(readFileSync(corpusFile, "utf8").split("\n").filter(line => line && !line.startsWith("#"))
  .map(line => line.split("\t")[2]).filter(Boolean))];

const { default: createHoshidicts } = await import(join(HERE, "..", "extension", "vendor", `${VARIANT}.mjs`));
const M = await createHoshidicts();
const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
call("hdw_init_storage", "number", ["number"], [0]);
const path = `/dicts/${basename(dictionaryDir)}`;
M.FS.mkdir(path);
for (const name of readdirSync(dictionaryDir)) M.FS.writeFile(`${path}/${name}`, readFileSync(join(dictionaryDir, name)));
if (call("hdw_add_dict", "number", ["string", "number", "number"], [path, 0, 0]) !== 1) {
  throw new Error(call("hdw_last_error", "string", [], []));
}

const base = { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "", metadataOnlyTerms: false };
const MODES = { "single-profile": JSON.stringify(base), profiles: JSON.stringify({ ...base, language: "ja", dictionaries: [path] }) };

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summary(samples, results, words, passes) {
  const sorted = samples.sort((a, b) => a - b);
  return { words, passes, results, p50Us: percentile(sorted, 50), p95Us: percentile(sorted, 95),
    meanUs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}

// Both modes run in every pass, in alternating order, so warm-up and drift in
// machine load affect them alike. The first pass warms the engine and is
// dropped, as benchmark-lookup drops it.
function time(words, passes) {
  const modes = Object.keys(MODES);
  const samples = Object.fromEntries(modes.map(mode => [mode, []]));
  const results = Object.fromEntries(modes.map(mode => [mode, 0]));
  for (let pass = 0; pass < passes; pass += 1) {
    for (const mode of pass % 2 === 0 ? modes : [...modes].reverse()) {
      for (const word of words) {
        const start = performance.now();
        const json = call("hdw_lookup", "string", ["string", "number", "number", "string"], [word, 16, 16, MODES[mode]]);
        const elapsed = performance.now() - start;
        if (pass === 0) continue;
        samples[mode].push(elapsed * 1000);
        results[mode] += JSON.parse(json).results.length;
      }
    }
  }
  return Object.fromEntries(modes.map(mode => [mode, summary(samples[mode], results[mode], words.length, passes)]));
}

const report = { variant: VARIANT, node: process.version, cpu: cpus()[0].model, load: loadavg(), dictionary: basename(dictionaryDir),
  corpusSources: corpus.length, modes: {} };
const reference = time(REFERENCE, REFERENCE_PASSES);
const corpusTimes = time(corpus, CORPUS_PASSES);
for (const mode of Object.keys(MODES)) report.modes[mode] = { reference: reference[mode], corpus: corpusTimes[mode] };
const json = JSON.stringify(report, null, 2);
if (output) writeFileSync(output, `${json}\n`);
console.log(json);
