#!/usr/bin/env node
// Regenerate extension/vendor/kanjidic/kanji-readings.json, the kanji readings
// the furigana split uses (#459), from the KANJIDIC archive that `url` and
// `sha256` in extension/vendor/kanjidic/source.json pin. To move to a newer
// KANJIDIC, point both at a newer jmdict-yomitan release and run this again:
// it rewrites the table and source.json's title, revision and file checksum.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import "../extension/render/glossary.js";
import { BlobReader, TextWriter, ZipReader } from "../extension/vendor/zip.js";

const DIRECTORY = new URL("../extension/vendor/kanjidic/", import.meta.url);
const SOURCE = new URL("source.json", DIRECTORY);
const TABLE = new URL("kanji-readings.json", DIRECTORY);
const sha256 = data => createHash("sha256").update(data).digest("hex");

const source = JSON.parse(readFileSync(SOURCE, "utf8"));
const response = await fetch(source.url);
if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
const archive = new Uint8Array(await response.arrayBuffer());
if (sha256(archive) !== source.sha256) {
  throw new Error(`${source.url} has SHA-256 ${sha256(archive)}, not the pinned ${source.sha256}`);
}

const reader = new ZipReader(new BlobReader(new Blob([archive])), { useWebWorkers: false });
const entries = await reader.getEntries();
const read = entry => entry.getData(new TextWriter()).then(JSON.parse);
const index = await read(entries.find(entry => entry.filename === "index.json"));
// A kanji bank row is [character, onyomi, kunyomi, tags, meanings, stats],
// each list of readings separated by spaces.
const rows = (await Promise.all(entries.filter(entry => /^kanji_bank_\d+\.json$/u.test(entry.filename)).map(read))).flat();
await reader.close();

const readings = new Map();
for (const [character, onyomi, kunyomi] of rows) {
  // Readings in hiragana, as the split compares them (KANJIDIC writes on'yomi
  // and loanword kun'yomi such as 吋 インチ in katakana); kun'yomi keep the "."
  // before their okurigana. The "-" marking a prefix or suffix is dropped.
  const list = [...onyomi.split(" "), ...kunyomi.split(" ")]
    .map(reading => globalThis.HDGlossary.toHiragana(reading).replaceAll("-", "")).filter(Boolean);
  if (list.length > 0) readings.set(character, [...new Set(list)].join(" "));
}
// One kanji per line in code point order, so a regenerated table diffs by kanji.
const lines = [...readings].sort(([left], [right]) => left.codePointAt(0) - right.codePointAt(0))
  .map(([character, list]) => `${JSON.stringify(character)}:${JSON.stringify(list)}`);
const table = `{"readings":{\n${lines.join(",\n")}\n}}\n`;
writeFileSync(TABLE, table);
writeFileSync(SOURCE, `${JSON.stringify({ ...source, title: index.title, revision: index.revision,
  files: { "kanji-readings.json": { sha256: sha256(table) } } }, null, 2)}\n`);
console.log(`${index.title} (${index.revision}): ${readings.size} of ${rows.length} kanji have readings;`
  + ` kanji-readings.json is ${Buffer.byteLength(table)} bytes`);
