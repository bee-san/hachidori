// Theme benchmark inputs for issue #334, built next to the harness's own
// benchmark/hover-popup-fixture.mjs archive:
//   theme-bench-senses.zip  a second dictionary whose 漢字 entry has 24 numbered
//                           senses of 2–3 glosses with tags — the "long JMdict
//                           entry" case (掛ける-sized); merges into the harness's
//                           flat 漢字 result, so hovering 漢字 stays one result.
//   theme-bench-kanji.zip   a kanji bank for 漢 and 字, so the popup's kanji
//                           links open the kanji view the harness times.
// The archives are Yomitan format 3, written with the same layout as
// test/make-fixture.mjs (index.json + one bank each).
//
//   HACHIDORI_ROOT=<repo> node theme-bench-fixture.mjs <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.HACHIDORI_ROOT ?? resolve(import.meta.dirname, "../../../../..");
const out = resolve(process.argv[2] ?? ".");
mkdirSync(out, { recursive: true });
const { buildTitledZip, kanjiGroupFixture } = await import(pathToFileURL(resolve(root, "test/make-fixture.mjs")).href);

const TAGS = [["n", "vs"], ["n"], ["vt"], ["n", "col"], ["exp"], ["n", "uk"]];
const GLOSSES = ["Chinese character", "kanji", "Han character", "sinograph", "logogram", "written form",
  "character used in Japanese writing", "ideograph (loosely)", "glyph", "letter", "script", "orthography"];
// 24 rows for the same term, reading and sequence: the renderer numbers them as
// one entry's senses (like the two 食べる rows in test/make-fixture.mjs:300-301).
const senses = Array.from({ length: 24 }, (_, i) => ["漢字", "かんじ", TAGS[i % TAGS.length].join(" "), "", 100 - i,
  Array.from({ length: 2 + (i % 2) }, (_, j) => `${GLOSSES[(i * 3 + j) % GLOSSES.length]} (sense ${i + 1})`), 2, ""]);
writeFileSync(resolve(out, "theme-bench-senses.zip"), buildTitledZip("theme-bench-senses", { terms: senses }));

// kanjiGroupFixture builds a kanji archive per character list; only its first
// dictionary (the kanji bank) is used, under the harness's fixed 漢字 word.
const kanji = kanjiGroupFixture([["漢", "かん"], ["字", "じ"]]).dictionaries[0].archive;
writeFileSync(resolve(out, "theme-bench-kanji.zip"), kanji);
console.log(JSON.stringify({ out, senses: senses.length, archives: ["theme-bench-senses.zip", "theme-bench-kanji.zip"] }));
