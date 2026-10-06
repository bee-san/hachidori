// SPDX-License-Identifier: GPL-3.0-or-later
//
// Segmentation throughput, the longest engine turn a page's segmentation can
// take, and how the best split compares with the greedy parse (#520, phase 1).
//
// `hdw_segment` runs one deinflecting lookup per code point, so it is the
// heaviest engine call the word-highlighting feature adds. This measures:
//
//   - segments per second and the per-line time distribution, over a corpus of
//     representative lines, with and without the frequency tie-break;
//   - one call on the largest chunk hd_segment accepts (4 KiB of UTF-8). The
//     engine is not reentrant and hd_segment yields it only between chunks, so
//     a hover that arrives during a chunk waits for the rest of it: up to the
//     per-line time when a chunk is one line, up to this time for the largest;
//   - the latency of a hover `hdw_lookup` on an idle engine and right after a
//     one-line segment call has returned, which is what interleaving costs a
//     hover beyond that wait;
//   - the reference-set scores (test/segmentation-reference.mjs) of the best
//     split and the greedy parse with the loaded dictionaries.
//
// It drives the frozen C ABI directly on the real WASM build in MEMFS, the way
// node-smoke.mjs does, rather than the browser path (benchmark/run.mjs). That
// isolates the engine cost from messaging, OPFS and paint; the numbers are
// per-call engine timings, not end-to-end latency.
//
// Dictionaries: a real Jitendex + frequency pair when their archives are given
// (HACHIDORI_SEGMENT_TERM_ZIP / HACHIDORI_SEGMENT_FREQ_ZIP), otherwise the
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
  formatReferenceScore,
  scoreReferenceSet,
} from "../test/segmentation-reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VARIANT = process.env.HACHIDORI_WASM_VARIANT === "fallback" ? "hoshidicts"
  : process.env.HACHIDORI_WASM_VARIANT === "threaded-idbfs" ? "hoshidicts-threaded-idbfs" : "hoshidicts-threaded";
const MODULE_PATH = join(HERE, "..", "extension", "vendor", `${VARIANT}.mjs`);

const SCAN_LENGTH = 16;
// hd_segment's per-chunk limit, the same 4 KiB of UTF-8 as a lookup's text.
const MAX_CHUNK_BYTES = 4 * 1024;
const WARMUP = Number(process.env.HACHIDORI_SEGMENT_WARMUP ?? 50);
const SAMPLES = Number(process.env.HACHIDORI_SEGMENT_SAMPLES ?? 400);
const LARGEST_CHUNK_SAMPLES = Math.max(5, Math.ceil(SAMPLES / 20));
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

function lookup(text, maxResults = 32, options = AUTO) {
  const json = call("hdw_lookup", "string", ["string", "number", "number", "string"], [text, maxResults, SCAN_LENGTH, options]);
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

// --- The longest engine turn ----------------------------------------------
// The corpus lines, repeated up to the 4 KiB one chunk may hold: one call is
// one engine turn, the longest a hover can wait behind a single chunk.
function largestChunk() {
  let chunk = "";
  for (let i = 0; ; i += 1) {
    const next = chunk + CORPUS[i % CORPUS.length];
    if (Buffer.byteLength(next) > MAX_CHUNK_BYTES) return chunk;
    chunk = next;
  }
}

function measureLargestChunk() {
  const chunk = largestChunk();
  segment(chunk, AUTO);
  const samples = [];
  let spans = 0;
  for (let i = 0; i < LARGEST_CHUNK_SAMPLES; i += 1) {
    const before = performance.now();
    spans = segment(chunk, AUTO).spans.length;
    samples.push(performance.now() - before);
  }
  return { bytes: Buffer.byteLength(chunk), codepoints: Array.from(chunk).length, spans, ...summarise(samples) };
}

// --- Hover latency, idle and after a segment turn --------------------------
// A hover is timed right after a one-line segment call returns, as one that
// runs between two of a batch's chunks is. Its wait for the chunk ahead of it
// is the segment time above, not part of this figure.
const HOVER_QUERIES = ["食べる", "読む", "漢字", "白い猫", "気がする"];
function measureHover({ afterSegment }) {
  for (let i = 0; i < WARMUP; i += 1) lookup(HOVER_QUERIES[i % HOVER_QUERIES.length]);
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    if (afterSegment) segment(CORPUS[i % CORPUS.length], AUTO);
    const query = HOVER_QUERIES[i % HOVER_QUERIES.length];
    const before = performance.now();
    lookup(query);
    samples.push(performance.now() - before);
  }
  return summarise(samples);
}

// --- Reference-set scores ---------------------------------------------------
// The greedy parse looks up with the same options as the split it is compared
// with.
function referenceScore(options) {
  return scoreReferenceSet({
    segment: (text) => segment(text, options).spans,
    lookupFirst: (text) => lookup(text, 1, options).results[0],
  });
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
  largestChunk: measureLargestChunk(),
  hoverIdle: measureHover({ afterSegment: false }),
  hoverAfterSegmentTurn: measureHover({ afterSegment: true }),
  referenceAutoFrequency: referenceScore(AUTO),
  referenceNoFrequency: referenceScore(DISABLED),
};

const ms = (value) => `${value.toFixed(3)} ms`;
console.log(JSON.stringify(report, null, 2));
console.log("");
console.log(`corpus: ${report.corpus}`);
console.log(`segment (auto freq): ${report.segmentAutoFrequency.linesPerSecond.toFixed(0)} lines/s, `
  + `${report.segmentAutoFrequency.segmentsPerSecond.toFixed(0)} segments/s, `
  + `${report.segmentAutoFrequency.codepointsPerSecond.toFixed(0)} codepoints/s, `
  + `p50 ${ms(report.segmentAutoFrequency.p50Ms)}, p95 ${ms(report.segmentAutoFrequency.p95Ms)}`);
console.log(`segment (no freq)  : ${report.segmentNoFrequency.linesPerSecond.toFixed(0)} lines/s, `
  + `${report.segmentNoFrequency.segmentsPerSecond.toFixed(0)} segments/s, `
  + `p50 ${ms(report.segmentNoFrequency.p50Ms)}`);
console.log(`largest chunk (${report.largestChunk.bytes} bytes, ${report.largestChunk.codepoints} code points, `
  + `${report.largestChunk.count} calls): p50 ${ms(report.largestChunk.p50Ms)}, max ${ms(report.largestChunk.maxMs)}`);
console.log(`hover latency idle : p50 ${ms(report.hoverIdle.p50Ms)}, p95 ${ms(report.hoverIdle.p95Ms)}`);
console.log(`hover after a segment turn: p50 ${ms(report.hoverAfterSegmentTurn.p50Ms)}, `
  + `p95 ${ms(report.hoverAfterSegmentTurn.p95Ms)}`);
for (const [label, score] of [["auto frequency", report.referenceAutoFrequency], ["no frequency", report.referenceNoFrequency]]) {
  console.log(`${label}:`);
  for (const line of formatReferenceScore(score)) console.log(`  ${line}`);
}
