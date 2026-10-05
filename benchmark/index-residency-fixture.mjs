// SPDX-License-Identifier: GPL-3.0-or-later
// Real importer output with synthetic Japanese terms. The many-package shape
// uses 58 copies of one imported dictionary, with distinct titles. It does
// not contain, or claim to reproduce, the reporter's private dictionaries.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildTitledZip, TERMS, TERM_META, KANJI, makePng } from "../test/make-fixture.mjs";

const output = resolve(process.argv[2]);
const importer = resolve(process.argv[3]);
const rows = Number(process.argv[4] ?? 200000);
const packages = Number(process.argv[5] ?? 58);
mkdirSync(output, { recursive: true });
const word = n => `測定${String(n).padStart(7, "0")}`;
const terms = [...TERMS, ...Array.from({ length: rows }, (_, n) => [word(n), "", "", "", n % 10,
  [`Synthetic definition ${n}.`], n, ""])];
const contents = { terms, termMeta: TERM_META,
  mediaEntries: [["kanji_bank_1.json", Buffer.from(JSON.stringify(KANJI))], ["media/kanji.png", makePng()]] };
const archive = buildTitledZip("index-residency-template", contents);
const archivePath = resolve(output, "template.zip");
writeFileSync(archivePath, archive);
const replacement = buildTitledZip("Index residency synthetic 00", contents);
writeFileSync(resolve(output, "replace.zip"), replacement);
const started = performance.now();
execFileSync(importer, ["import", archivePath], { stdio: "pipe" });
const importMs = performance.now() - started;
const template = resolve(output, "index-residency-template");
const files = readdirSync(template).map(name => ({ name, bytes: statSync(resolve(template, name)).size,
  sha256: createHash("sha256").update(readFileSync(resolve(template, name))).digest("hex") }));
const dictionaries = [];
for (let n = 0; n < packages; ++n) {
  const title = `Index residency synthetic ${String(n).padStart(2, "0")}`;
  const directory = resolve(output, title);
  mkdirSync(directory);
  for (const { name } of files) copyFileSync(resolve(template, name), resolve(directory, name));
  const index = JSON.parse(readFileSync(resolve(directory, "index.json"), "utf8"));
  index.title = title;
  writeFileSync(resolve(directory, "index.json"), JSON.stringify(index));
  dictionaries.push({ title, directory, id: createHash("sha256").update(title).digest("hex").slice(0, 32),
    path: `/dicts/${title}`, enabled: true, revision: index.revision,
    termCount: index.counts.terms.total, frequencyCount: index.counts.termMeta.freq,
    pitchCount: index.counts.termMeta.pitch, kanjiCount: index.counts.kanji.total,
    mediaCount: index.counts.media.total });
}
let seed = 496;
const corpus = ["食べる", "食べました", "読んだ", "漢字", "ありがとう", "存在しない"];
for (let n = 0; n < Math.min(rows, 512); ++n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  corpus.push(word(seed % rows));
  if (n % 10 === 0) corpus.push(`未登録${String(seed).padStart(10, "0")}`);
}
writeFileSync(resolve(output, "words.txt"), `${corpus.join("\n")}\n`);
writeFileSync(resolve(output, "fixture.json"), JSON.stringify({ label: "synthetic importer output; repeated terms across distinct packages",
  rows, packages, archiveSha256: createHash("sha256").update(archive).digest("hex"),
  replacementSha256: createHash("sha256").update(replacement).digest("hex"), importMs, files, dictionaries, corpus }, null, 2));
console.log(JSON.stringify({ output, rows, packages, importMs, hashBytes: files.find(file => file.name === "hash.table").bytes }));
