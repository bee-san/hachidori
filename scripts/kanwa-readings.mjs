#!/usr/bin/env node
// Regenerate extension/vendor/kanwa/kanwa-readings.json, the Jitendex kanwa
// readings the furigana split reads a run of kanji by where KANJIDIC's read
// none (#641), from the two files of Jitendex/jitendex-data that `commit` and
// `files` in extension/vendor/kanwa/source.json pin. The table keeps the
// character readings that extension/vendor/kanjidic/kanji-readings.json lacks,
// so run this again whenever that table changes; source.json records the one
// it was made against. To move to a newer kanwa, point `commit` at a newer
// jitendex-data commit and run this with --update, which re-pins both files.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import "../extension/render/glossary.js";

const DIRECTORY = new URL("../extension/vendor/kanwa/", import.meta.url);
const SOURCE = new URL("source.json", DIRECTORY);
const TABLE = new URL("kanwa-readings.json", DIRECTORY);
const KANJIDIC = new URL("../kanjidic/kanji-readings.json", DIRECTORY);
const sha256 = data => createHash("sha256").update(data).digest("hex");
const { toHiragana } = globalThis.HDGlossary;
// The split reads only the characters between kana (Yomitan's isCodePointKana).
const KANA = /[\u3040-\u30ff]/u;

const source = JSON.parse(readFileSync(SOURCE, "utf8"));
const update = process.argv.includes("--update");
const fetchJson = async (path) => {
  const url = `${source.repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${source.commit}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (update) source.files[path] = { sha256: sha256(data) };
  else if (sha256(data) !== source.files[path]?.sha256) {
    throw new Error(`${url} has SHA-256 ${sha256(data)}, not the pinned ${source.files[path]?.sha256}`);
  }
  return JSON.parse(new TextDecoder().decode(data));
};
const characters = await fetchJson("kanwa/characters.json");
const compounds = await fetchJson("kanwa/compounds.json");
const kanjidicTable = readFileSync(KANJIDIC);
const kanjidic = JSON.parse(kanjidicTable).readings;

// Readings in hiragana, as the split compares them; a kun'yomi keeps the "."
// before its okurigana, and the "-" marking a prefix or suffix is dropped, as
// scripts/kanji-readings.mjs does for KANJIDIC. A space separates readings in
// the table, so no reading may hold one.
const reading = (text) => {
  const value = toHiragana(text).replaceAll("-", "");
  if (/\s/u.test(value)) throw new Error(`the kanwa reading ${JSON.stringify(text)} holds a space`);
  return value;
};

// A character's on'yomi, kun'yomi, numeral and letter names (２ ふた), symbol
// names (〆 しめ) and "unknown" readings, where KANJIDIC lacks them. Chinese
// and Korean readings are for loanwords, which the split cannot tell apart;
// kana never sit in a run of kanji.
const readings = [];
for (const [character, types] of Object.entries(characters)) {
  if (KANA.test(character)) continue;
  const known = new Set(kanjidic[character]?.split(" "));
  const list = Object.entries(types).filter(([type]) => !["chinese", "korean", "kana"].includes(type))
    .flatMap(([, values]) => values.map(reading)).filter(value => value !== "" && !known.has(value));
  if (list.length > 0) readings.push([character, list]);
}

// A compound of two or more characters with no kana, read as a whole (今日
// きょう) or one part per character, "|" between the parts (日本 に|ほん).
const compoundReadings = [];
for (const [compound, types] of Object.entries(compounds)) {
  const length = Array.from(compound).length;
  if (length < 2 || KANA.test(compound)) continue;
  const list = Object.values(types).flat().map(reading);
  for (const value of list) {
    const parts = value.split("|");
    if (parts.includes("") || (parts.length > 1 && parts.length !== length)) {
      throw new Error(`the kanwa reading ${value} of ${compound} does not give each character one part`);
    }
  }
  compoundReadings.push([compound, list]);
}

// One entry per line in code point order, so a regenerated table diffs by entry.
const line = ([key, list]) => `${JSON.stringify(key)}:${JSON.stringify([...new Set(list)].join(" "))}`;
const byCodePoint = ([left], [right]) => {
  const [a, b] = [Array.from(left), Array.from(right)];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index].codePointAt(0) - b[index].codePointAt(0);
  }
  return a.length - b.length;
};
const table = `{"readings":{\n${readings.sort(byCodePoint).map(line).join(",\n")}\n},\n`
  + `"compounds":{\n${compoundReadings.sort(byCodePoint).map(line).join(",\n")}\n}}\n`;
writeFileSync(TABLE, table);
writeFileSync(SOURCE, `${JSON.stringify({ ...source, files: { ...source.files,
  "kanwa-readings.json": { sha256: sha256(table), kanjidic: sha256(kanjidicTable) } } }, null, 2)}\n`);
console.log(`kanwa at ${source.commit}: ${readings.length} characters with readings KANJIDIC lacks and`
  + ` ${compoundReadings.length} compounds; kanwa-readings.json is ${Buffer.byteLength(table)} bytes`);
