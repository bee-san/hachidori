// Writes the 32 Jitendex entries benchmark/theme-languages.mjs renders, from a
// dictionary imported with hoshidicts-cli (third_party/hoshidicts):
//
//   node benchmark/theme-languages-sample.mjs path/to/hoshidicts-cli "path/to/Jitendex.org [2026-10-03]" OUTPUT.json
//
// Each row is the first entry `hoshidicts-cli query` prints for a common word.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { writeFileSync } from "node:fs";

const [cli, dictionary, output] = process.argv.slice(2);
assert.ok(cli && dictionary && output, "usage: theme-languages-sample.mjs HOSHIDICTS_CLI DICTIONARY OUTPUT.json");
const WORDS = ("食べる 見る 行く 来る 言う 日本 学校 時間 人 大きい 新しい 書く 読む 話す 聞く 思う 知る 出る 入る 持つ "
  + "待つ 作る 使う 会う 帰る 始める 分かる 考える 走る 遊ぶ 勉強 先生 手 目 上 下 子供 友達 電車 仕事").split(" ");
const title = basename(dictionary);
const rows = [];
for (const word of WORDS) {
  if (rows.length === 32) break;
  const lines = execFileSync(cli, ["query", dictionary, word], { encoding: "utf8", timeout: 60_000 }).split("\n");
  // An entry's headline, its glossary count, a rule, then the title and its glossary JSON.
  const at = lines.findIndex((line, index) => line.startsWith(title) && lines[index + 1]?.startsWith("["));
  if (at < 0) continue;
  let head = at;
  while (head > 0 && (!lines[head] || /^-+$/u.test(lines[head]) || lines[head].startsWith(title) || / glossary entries$/u.test(lines[head]))) head -= 1;
  const [expression, reading = expression, ...rules] = lines[head].split(" ");
  rows.push({ expression, reading, rules: rules.join(" "), glossary: lines[at + 1] });
}
assert.equal(rows.length, 32, `found ${rows.length} of 32 entries`);
writeFileSync(output, JSON.stringify(rows));
console.log(`${rows.length} entries, ${rows.reduce((total, row) => total + row.glossary.length, 0)} glossary characters`);
