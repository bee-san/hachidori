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
// HACHIDORI_LOOKUP_LANGUAGE=<code> times another language instead: its pack
// from extension/vendor/languages/ is loaded (hdw_language_load), the corpus
// is a file of sentences, one per line, and every word of every sentence is
// looked up the way a hover on it is: from the word's first character
// (`text.wordCharacters`) through the scan window content.js collects,
// max(scanLength, the dictionary's longest key + 8) code points capped at 256,
// extended to the end of the last word. Only the request with profiles exists
// for such a language.
//
//   node benchmark/node-lookup.mjs <imported dictionary directory | archive.zip> <corpus.tsv | sentences.txt> [output.json]
//   HACHIDORI_WASM_VARIANT=fallback|threaded-idbfs  (default: threaded)
//   HACHIDORI_LOOKUP_PASSES=200 (reference words) HACHIDORI_CORPUS_PASSES=6
//   HACHIDORI_LOOKUP_LANGUAGE=ja (default) | en | ar | ...
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const [dictionaryDir, corpusFile, output] = process.argv.slice(2);
if (!dictionaryDir || !corpusFile) throw new Error("usage: node benchmark/node-lookup.mjs <dictionary dir> <corpus.tsv> [output.json]");
const VARIANT = { fallback: "hoshidicts", "threaded-idbfs": "hoshidicts-threaded-idbfs" }[process.env.HACHIDORI_WASM_VARIANT]
  ?? "hoshidicts-threaded";
const REFERENCE_PASSES = Number(process.env.HACHIDORI_LOOKUP_PASSES ?? 200);
const CORPUS_PASSES = Number(process.env.HACHIDORI_CORPUS_PASSES ?? 6);
const LANGUAGE = process.env.HACHIDORI_LOOKUP_LANGUAGE ?? "ja";
const JAPANESE = LANGUAGE === "ja";
const SCAN_LENGTH = 16;
const REFERENCE = JAPANESE ? ["食べました", "走り出した", "美しい景色", "日本語を勉強しています"] : [];
const lines = readFileSync(corpusFile, "utf8").split("\n").filter(line => line && !line.startsWith("#"));

const { default: createHoshidicts } = await import(join(HERE, "..", "extension", "vendor", `${VARIANT}.mjs`));
const M = await createHoshidicts();
const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
const lastError = () => call("hdw_last_error", "string", [], []);
call("hdw_init_storage", "number", ["number"], [0]);
let path;
let importMs = null;
if (dictionaryDir.endsWith(".zip")) {
  M.FS.mkdir("/work");
  M.FS.writeFile("/work/dictionary.zip", readFileSync(dictionaryDir));
  const started = performance.now();
  const report = JSON.parse(call("hdw_import", "string", ["string", "string", "number"], ["/work/dictionary.zip", "/dicts", 0]));
  importMs = performance.now() - started;
  if (!report.success) throw new Error(report.error);
  path = `/dicts/${report.title}`;
} else {
  path = `/dicts/${basename(dictionaryDir)}`;
  M.FS.mkdir(path);
  for (const name of readdirSync(dictionaryDir)) M.FS.writeFile(`${path}/${name}`, readFileSync(join(dictionaryDir, name)));
}
if (call("hdw_add_dict", "number", ["string", "number", "number"], [path, 0, 0]) !== 1) throw new Error(lastError());

// Another language's pack and the hover texts of its sentences.
let corpus;
let longKeyLength = null;
if (JAPANESE) {
  corpus = [...new Set(lines.map(line => line.split("\t")[2]).filter(Boolean))];
} else {
  const packs = join(HERE, "..", "extension", "vendor", "languages");
  const languageJson = readFileSync(join(packs, LANGUAGE, "language.json"), "utf8");
  const transforms = JSON.parse(languageJson).lookup?.transforms;
  const transformsJson = transforms ? readFileSync(join(packs, LANGUAGE, transforms), "utf8") : "";
  if (call("hdw_language_load", "number", ["string", "string"], [languageJson, transformsJson]) !== 1) throw new Error(lastError());
  // The longest key, from the scan index header (engine-service.js
  // longKeyLengthFromScanIndex): u32 magic, u32 version, u32 count, u16 key.
  const header = M.FS.readFile(`${path}/scan.idx`).slice(0, 16);
  longKeyLength = new DataView(header.buffer).getUint16(12, true);
  const scanWindow = Math.min(256, Math.max(SCAN_LENGTH, longKeyLength === 0 ? 0 : longKeyLength + 8));
  runInThisContext(readFileSync(join(packs, "registry.js"), "utf8"));
  const wordCharacter = new RegExp(`^${globalThis.HDLanguages.get(LANGUAGE).text.wordCharacters}$`, "u");
  corpus = lines.flatMap((sentence) => {
    const characters = [...sentence];
    const inWord = index => index < characters.length && wordCharacter.test(characters[index]);
    const texts = [];
    for (let start = 0; start < characters.length; start += 1) {
      if (!inWord(start) || inWord(start - 1)) continue;
      let end = Math.min(characters.length, start + scanWindow);
      while (inWord(end) && inWord(end - 1)) end += 1;
      texts.push(characters.slice(start, end).join(""));
    }
    return texts;
  });
}

const base = { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "", metadataOnlyTerms: false };
const MODES = JAPANESE
  ? { "single-profile": JSON.stringify(base), profiles: JSON.stringify({ ...base, language: "ja", dictionaries: [path] }) }
  : { profiles: JSON.stringify({ ...base, language: LANGUAGE, dictionaries: [path] }) };

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
        const json = call("hdw_lookup", "string", ["string", "number", "number", "string"], [word, 16, SCAN_LENGTH, MODES[mode]]);
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
  language: LANGUAGE, importMs, longKeyLength, corpusSources: corpus.length, modes: {} };
const reference = REFERENCE.length > 0 ? time(REFERENCE, REFERENCE_PASSES) : null;
const corpusTimes = time(corpus, CORPUS_PASSES);
for (const mode of Object.keys(MODES)) report.modes[mode] = { ...(reference ? { reference: reference[mode] } : {}), corpus: corpusTimes[mode] };
if (!JAPANESE) {
  // One lookup per text after the timed passes: what each text found.
  report.texts = corpus.map(text => ({ text, results: JSON.parse(call("hdw_lookup", "string", ["string", "number", "number", "string"],
    [text, 16, SCAN_LENGTH, MODES.profiles])).results.length }));
}
const json = JSON.stringify(report, null, 2);
if (output) writeFileSync(output, `${json}\n`);
console.log(json);
