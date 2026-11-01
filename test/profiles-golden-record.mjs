#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Records test/data/profiles-golden.json, the golden files profiles.test.mjs
// compares the profile layer with (docs/languages.md, sections 6.2 and 18):
// every option record the existing suites pass to normaliseOptions and
// projectStoredOptions, with what reader-options.js returned for it before the
// profile layer existed.
//
//   node test/profiles-golden-record.mjs <capture.jsonl> <reader-options.js> [output]
//
// <capture.jsonl> holds one {"fn", "suite", "json"} line per call, written by a
// run of `node test/run.mjs node` and `node test/run.mjs smoke` with a preload
// that hands HDReaderOptions a recorder in every realm. <reader-options.js> is
// the file of the commit the golden describes (multi-language base 99960c7c).
// The goldens were recorded once, before reader-options.js changed; running this
// on a later reader-options.js records that file's behaviour instead.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [capturePath, readerOptionsPath, output = resolve(ROOT, "test/data/profiles-golden.json")] = process.argv.slice(2);
if (!capturePath || !readerOptionsPath) {
  throw new Error("usage: node test/profiles-golden-record.mjs <capture.jsonl> <reader-options.js> [output]");
}

// URL is the one global reader-options.js uses (normaliseAnkiConnectUrl).
const context = { URL };
vm.runInNewContext(readFileSync(readerOptionsPath, "utf8"), context);
const { normaliseOptions, projectStoredOptions } = context.HDReaderOptions;

// A long string the suites build by repetition (response-limit cases) is kept
// as its prefix, repeated unit and suffix; profiles.test.mjs expands it.
function encode(value) {
  if (typeof value === "string" && value.length > 512) {
    for (let unitLength = 1; unitLength <= 8; unitLength += 1) {
      for (let start = 0; start <= 64; start += 1) {
        const unit = value.slice(start, start + unitLength);
        let times = 0;
        while (value.startsWith(unit, start + times * unitLength)) times += 1;
        const end = start + times * unitLength;
        if (times * unitLength > 256 && value.length - end <= 64) {
          return { $repeat: [value.slice(0, start), unit, times, value.slice(end)] };
        }
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));

const inputs = new Map();
for (const line of readFileSync(capturePath, "utf8").split("\n")) {
  if (line === "") continue;
  const { json, suite } = JSON.parse(line);
  if (!inputs.has(json)) inputs.set(json, new Set());
  inputs.get(json).add(suite);
}

const defaults = plain(normaliseOptions(undefined));
const entries = [...inputs.keys()].sort().map(json => {
  const input = json === "__undefined__" ? undefined : JSON.parse(json);
  const normalised = plain(normaliseOptions(input));
  const stored = plain(projectStoredOptions(input));
  const changed = Object.fromEntries(Object.entries(normalised)
    .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(defaults[key])));
  return {
    ...(input === undefined ? { undefined: true } : { input: encode(input) }),
    suites: [...inputs.get(json)].sort(),
    normalised: encode(changed),
    normalisedSha256: sha256(normalised),
    storedSha256: sha256(stored),
  };
});

// One record per line, so a diff of the file shows which records changed.
const body = entries.map(entry => JSON.stringify(entry)).join(",\n");
writeFileSync(output, `${JSON.stringify({
  description: "normaliseOptions and projectStoredOptions of every option record the existing suites use, "
    + "recorded from reader-options.js before the profile layer (docs/languages.md 6.2). "
    + "`normalised` lists the keys of normaliseOptions' result that differ from `defaults`; the SHA-256 values are of "
    + "JSON.stringify of the complete results of normaliseOptions and projectStoredOptions, so key order is pinned too.",
  recordedFrom: "bee-san/hachidori feat/multi-language 99960c7c extension/reader-options.js",
  defaults,
  entries: [],
}).slice(0, -3)}[\n${body}\n]}\n`);
console.log(`${entries.length} records -> ${output}`);
