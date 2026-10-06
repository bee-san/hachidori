// SPDX-License-Identifier: GPL-3.0-or-later
// Real importer output with synthetic Japanese terms. It does not contain, or
// claim to reproduce, the reporter's private dictionaries.
//
//   <output> <importer> [rows=200000] [packages=58]
//     uniform: 58 copies of one imported dictionary under distinct titles, so
//     every synthetic hit is present in every package (maximal index I/O).
//   <output> <importer> reporter
//     reporter-shaped: one import per package, sized so each package's
//     resident index files approximate the 58-package inventory in #496.
//     Vocabularies are nested by rank (a smaller package holds only the more
//     common words) and the corpus samples ranks log-uniformly (Zipf, s = 1).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildTitledZip, TERMS, TERM_META, KANJI, makePng } from "../test/make-fixture.mjs";

// Resident file bytes of the 58 packages in the #496 report, largest first.
const REPORTER_RESIDENT_BYTES = [29446514, 22356436, 21607844, 21596692, 18755392, 17065234, 14249240,
  13705576, 11546484, 11362600, 11238468, 9921144, 6792148, 4721716, 4570768, 4172104, 3764004, 3714264,
  3662744, 3416392, 3223576, 3169524, 3123156, 2919780, 2469524, 2144852, 2116520, 2109076, 2056392,
  2019572, 1925688, 1843304, 1234420, 994228, 795636, 743367, 698532, 525540, 499856, 468436, 423508,
  308800, 293182, 290292, 260964, 253748, 191476, 166516, 166404, 161716, 156644, 149012, 148100, 147204,
  141492, 138724, 137428, 64311];
// hash.table holds 10/7 slots of 16 bytes per key and bloom.filter ~10.5 bits.
const RESIDENT_BYTES_PER_KEY = 16 * 10 / 7 + 1.31;

const output = resolve(process.argv[2]);
const importer = resolve(process.argv[3]);
const shape = process.argv[4] === "reporter" ? "reporter" : "uniform";
const sizes = shape === "reporter"
  ? REPORTER_RESIDENT_BYTES.map(bytes => Math.max(64, Math.round(bytes / RESIDENT_BYTES_PER_KEY)))
  : Array(Number(process.argv[5] ?? 58)).fill(Number(process.argv[4] ?? 200000));
const rows = Math.max(...sizes);
const packages = sizes.length;
mkdirSync(output, { recursive: true });
const word = n => `測定${String(n).padStart(7, "0")}`;
const contents = count => ({ terms: [...TERMS, ...Array.from({ length: count }, (_, n) => [word(n), "", "", "", n % 10,
  [`Synthetic definition ${n}.`], n, ""])], termMeta: TERM_META,
mediaEntries: [["kanji_bank_1.json", Buffer.from(JSON.stringify(KANJI))], ["media/kanji.png", makePng()]] });
const label = shape === "reporter" ? "Index residency reporter-shaped" : "Index residency synthetic";
const titleOf = n => `${label} ${String(n).padStart(2, "0")}`;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const listFiles = directory => readdirSync(directory).sort().map(name => ({ name,
  bytes: statSync(resolve(directory, name)).size, sha256: sha256(readFileSync(resolve(directory, name))) }));

// The importer writes the package next to its archive, named by the title.
function importArchive(title, archive) {
  const archivePath = resolve(output, `${title}.zip`);
  writeFileSync(archivePath, archive);
  const started = performance.now();
  execFileSync(importer, ["import", archivePath], { stdio: "pipe" });
  const ms = performance.now() - started;
  rmSync(archivePath);
  return ms;
}

const dictionaries = [];
let files, archiveSha256, importMs = 0;
const replacement = buildTitledZip(titleOf(0), contents(sizes[0]));
writeFileSync(resolve(output, "replace.zip"), replacement);
if (shape === "uniform") {
  const archive = buildTitledZip("index-residency-template", contents(rows));
  archiveSha256 = sha256(archive);
  importMs = importArchive("index-residency-template", archive);
  files = listFiles(resolve(output, "index-residency-template"));
}
for (let n = 0; n < packages; ++n) {
  const title = titleOf(n);
  const directory = resolve(output, title);
  let packageFiles = files;
  if (shape === "uniform") {
    mkdirSync(directory);
    for (const { name } of files) copyFileSync(resolve(output, "index-residency-template", name), resolve(directory, name));
    const index = JSON.parse(readFileSync(resolve(directory, "index.json"), "utf8"));
    writeFileSync(resolve(directory, "index.json"), JSON.stringify({ ...index, title }));
  } else {
    const archive = buildTitledZip(title, contents(sizes[n]));
    importMs += importArchive(title, archive);
    packageFiles = listFiles(directory);
  }
  const index = JSON.parse(readFileSync(resolve(directory, "index.json"), "utf8"));
  dictionaries.push({ title, directory, id: sha256(title).slice(0, 32),
    path: `/dicts/${title}`, enabled: true, revision: index.revision,
    termCount: index.counts.terms.total, frequencyCount: index.counts.termMeta.freq,
    pitchCount: index.counts.termMeta.pitch, kanjiCount: index.counts.kanji.total,
    mediaCount: index.counts.media.total, syntheticRows: sizes[n],
    ...(shape === "reporter" ? { reporterResidentBytes: REPORTER_RESIDENT_BYTES[n], files: packageFiles } : {}) });
}
let seed = 496;
const corpus = ["食べる", "食べました", "読んだ", "漢字", "ありがとう", "存在しない"];
for (let n = 0; n < Math.min(rows, 512); ++n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  // Log-uniform ranks: frequent words recur, as in reading, and reach every package.
  corpus.push(word(shape === "reporter" ? Math.floor(Math.exp((seed / 2 ** 32) * Math.log(rows + 1))) - 1 : seed % rows));
  if (n % 10 === 0) corpus.push(`未登録${String(seed).padStart(10, "0")}`);
}
const hashBytes = dictionaries.map(dictionary => (dictionary.files ?? files).find(file => file.name === "hash.table").bytes);
writeFileSync(resolve(output, "words.txt"), `${corpus.join("\n")}\n`);
writeFileSync(resolve(output, "fixture.json"), JSON.stringify({
  label: shape === "reporter"
    ? "synthetic importer output; package sizes approximate the #496 inventory; nested vocabularies; Zipf corpus"
    : "synthetic importer output; repeated terms across distinct packages",
  shape, rows, packages, archiveSha256, replacementSha256: sha256(replacement), importMs,
  hashTableBytes: hashBytes.reduce((sum, bytes) => sum + bytes, 0), files, dictionaries, corpus }, null, 2));
console.log(JSON.stringify({ output, shape, rows, packages, importMs,
  hashTableBytes: hashBytes.reduce((sum, bytes) => sum + bytes, 0), distinctQueries: new Set(corpus).size }));
