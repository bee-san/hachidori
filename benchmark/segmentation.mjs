// SPDX-License-Identifier: GPL-3.0-or-later
//
// Segmentation throughput and the hover-lookup latency a reader sees while a
// page is being segmented (#520, phase 1).
//
// `hdw_segment` runs one deinflecting lookup per code point, so it is the
// heaviest engine call the word-highlighting feature adds. This measures:
//
//   - segments per second and the per-line time distribution, over a corpus of
//     representative lines, with and without the frequency tie-break;
//   - the latency of a hover `hdw_lookup` issued on the same engine instance,
//     both idle and immediately after a page-sized segmentation batch, so the
//     cost of segmenting next to a reader's own hovers is visible.
//
// It drives the frozen C ABI directly on the real WASM build in MEMFS, the way
// node-smoke.mjs does, rather than the browser path (benchmark/run.mjs). That
// isolates the engine cost from messaging, OPFS and paint; the numbers are a
// per-call lower bound, not end-to-end latency.
//
// Dictionaries: a real Jitendex + Jiten frequency pair when their archives are
// given (HACHIDORI_SEGMENT_TERM_ZIP / HACHIDORI_SEGMENT_FREQ_ZIP), otherwise the
// small self-contained reference dictionary from the segmentation test set, so
// the benchmark runs with no external data.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  REFERENCE_LINES,
  SEGMENTATION_DICTIONARY_TITLE,
  SEGMENTATION_FREQUENCY_TITLE,
  buildSegmentationDictionaryZip,
  buildSegmentationFrequencyZip,
} from "../test/segmentation-reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VARIANT = process.env.HACHIDORI_WASM_VARIANT === "fallback" ? "hoshidicts"
  : process.env.HACHIDORI_WASM_VARIANT === "threaded-idbfs" ? "hoshidicts-threaded-idbfs" : "hoshidicts-threaded";
const MODULE_PATH = join(HERE, "..", "extension", "vendor", `${VARIANT}.mjs`);

const SCAN_LENGTH = 16;
const WARMUP = Number(process.env.HACHIDORI_SEGMENT_WARMUP ?? 50);
const SAMPLES = Number(process.env.HACHIDORI_SEGMENT_SAMPLES ?? 400);
const AUTO = JSON.stringify({ frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" });
const DISABLED = JSON.stringify({ frequencyDictionary: "", frequencyOrder: "disabled", primaryReading: "" });

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    meanMs: total / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
  };
}

const { default: createHoshidicts } = await import(MODULE_PATH);
const M = await createHoshidicts();
const call = (name, ret, types, args) => M.ccall(name, ret, types, args);
const lastError = () => call("hdw_last_error", "string", [], []);
M.FS.mkdir("/work");
call("hdw_init_storage", "number", ["number"], [0]);

function importZip(bytes, out) {
  M.FS.writeFile("/work/seg.zip", Buffer.from(bytes));
  const report = JSON.parse(call("hdw_import", "string", ["string", "string", "number"], ["/work/seg.zip", out, 0]));
  M.FS.unlink("/work/seg.zip");
  if (!report.success) throw new Error(`import failed: ${report.error}`);
  return report;
}

const termZipPath = process.env.HACHIDORI_SEGMENT_TERM_ZIP;
const freqZipPath = process.env.HACHIDORI_SEGMENT_FREQ_ZIP;
let corpusLabel;
if (termZipPath && freqZipPath) {
  const term = importZip(readFileSync(termZipPath), "/dicts");
  const freq = importZip(readFileSync(freqZipPath), "/dicts");
  call("hdw_add_dict", "number", ["string", "number", "number"], [`/dicts/${term.title}`, 0, 0]);
  call("hdw_add_dict", "number", ["string", "number", "number"], [`/dicts/${freq.title}`, 1, 0]);
  corpusLabel = `${term.title} (${term.termCount} terms) + ${freq.title} (${freq.frequencyCount} freq)`;
} else {
  importZip(buildSegmentationDictionaryZip(), "/dicts");
  importZip(buildSegmentationFrequencyZip(), "/dicts");
  call("hdw_add_dict", "number", ["string", "number", "number"], [`/dicts/${SEGMENTATION_DICTIONARY_TITLE}`, 0, 0]);
  call("hdw_add_dict", "number", ["string", "number", "number"], [`/dicts/${SEGMENTATION_FREQUENCY_TITLE}`, 1, 0]);
  corpusLabel = "segmentation reference dictionary (set HACHIDORI_SEGMENT_TERM_ZIP/_FREQ_ZIP for a real corpus)";
}

const CORPUS = REFERENCE_LINES.map((line) => line.text);
const totalCodepoints = CORPUS.reduce((sum, line) => sum + Array.from(line).length, 0);

function segment(text, options) {
  const json = call("hdw_segment", "string", ["string", "number", "string"], [text, SCAN_LENGTH, options]);
  if (lastError() !== "") throw new Error(`hdw_segment: ${lastError()}`);
  return JSON.parse(json);
}

function lookup(text) {
  const json = call("hdw_lookup", "string", ["string", "number", "number", "string"], [text, 32, SCAN_LENGTH, AUTO]);
  if (lastError() !== "") throw new Error(`hdw_lookup: ${lastError()}`);
  return JSON.parse(json);
}

// --- Segmentation throughput ---------------------------------------------
function measureSegment(options) {
  for (let i = 0; i < WARMUP; i += 1) segment(CORPUS[i % CORPUS.length], options);
  const perLine = [];
  let segmentsProduced = 0;
  let codepoints = 0;
  const start = performance.now();
  for (let i = 0; i < SAMPLES; i += 1) {
    const line = CORPUS[i % CORPUS.length];
    const before = performance.now();
    const result = segment(line, options);
    perLine.push(performance.now() - before);
    segmentsProduced += result.spans.length;
    codepoints += Array.from(line).length;
  }
  const elapsed = performance.now() - start;
  return {
    ...summarise(perLine),
    linesPerSecond: (SAMPLES / elapsed) * 1000,
    segmentsPerSecond: (segmentsProduced / elapsed) * 1000,
    codepointsPerSecond: (codepoints / elapsed) * 1000,
  };
}

// --- Hover latency, idle and during segmentation --------------------------
// The engine is single-threaded; the extension runs one chunk per queue turn
// so a hover interleaves between chunks. Here the whole corpus is one batch and
// a hover is timed right after it, the worst case for a hover that lands when a
// chunk has just started.
const HOVER_QUERIES = ["食べる", "読む", "漢字", "白い猫", "気がする"].filter((text) => lookup(text).results.length >= 0);
function measureHover({ segmentBetween }) {
  for (let i = 0; i < WARMUP; i += 1) lookup(HOVER_QUERIES[i % HOVER_QUERIES.length]);
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    if (segmentBetween) segment(CORPUS[i % CORPUS.length], AUTO);
    const query = HOVER_QUERIES[i % HOVER_QUERIES.length];
    const before = performance.now();
    lookup(query);
    samples.push(performance.now() - before);
  }
  return summarise(samples);
}

const report = {
  variant: VARIANT,
  corpus: corpusLabel,
  lines: CORPUS.length,
  codepoints: totalCodepoints,
  scanLength: SCAN_LENGTH,
  warmup: WARMUP,
  samples: SAMPLES,
  segmentAutoFrequency: measureSegment(AUTO),
  segmentNoFrequency: measureSegment(DISABLED),
  hoverIdle: measureHover({ segmentBetween: false }),
  hoverWhileSegmenting: measureHover({ segmentBetween: true }),
};

console.log(JSON.stringify(report, null, 2));
console.log("");
console.log(`corpus: ${report.corpus}`);
console.log(`segment (auto freq): ${report.segmentAutoFrequency.linesPerSecond.toFixed(0)} lines/s, `
  + `${report.segmentAutoFrequency.segmentsPerSecond.toFixed(0)} segments/s, `
  + `${report.segmentAutoFrequency.codepointsPerSecond.toFixed(0)} codepoints/s, `
  + `p50 ${report.segmentAutoFrequency.p50Ms.toFixed(3)} ms, p95 ${report.segmentAutoFrequency.p95Ms.toFixed(3)} ms`);
console.log(`segment (no freq)  : ${report.segmentNoFrequency.linesPerSecond.toFixed(0)} lines/s, `
  + `${report.segmentNoFrequency.segmentsPerSecond.toFixed(0)} segments/s, `
  + `p50 ${report.segmentNoFrequency.p50Ms.toFixed(3)} ms`);
console.log(`hover latency idle : p50 ${report.hoverIdle.p50Ms.toFixed(3)} ms, p95 ${report.hoverIdle.p95Ms.toFixed(3)} ms`);
console.log(`hover while segmenting: p50 ${report.hoverWhileSegmenting.p50Ms.toFixed(3)} ms, `
  + `p95 ${report.hoverWhileSegmenting.p95Ms.toFixed(3)} ms`);
