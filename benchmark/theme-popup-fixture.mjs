// Long dictionary entry companion to hover-popup-fixture.mjs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { buildTitledZip } from "../test/make-fixture.mjs";
const tags = ["n vs", "n", "vt", "n col", "exp", "n uk"];
const glosses = ["Chinese character", "kanji", "Han character", "sinograph", "logogram", "written form",
  "character used in Japanese writing", "ideograph (loosely)", "glyph", "letter", "script", "orthography"];
const terms = Array.from({ length: 24 }, (_, i) => ["漢字", "かんじ", tags[i % tags.length], "", 100 - i,
  Array.from({ length: 2 + i % 2 }, (_, j) => `${glosses[(i * 3 + j) % glosses.length]} (sense ${i + 1})`), 2, ""]);
writeFileSync(process.argv[2], buildTitledZip("theme-bench-senses", { terms }));
