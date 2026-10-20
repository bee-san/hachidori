/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

// Adapted from Manabitan's SortFrequencyDictionaryController. Settings handles
// declared modes synchronously; sample undeclared Japanese dictionaries on demand.
const COMMON_TERMS = ["来る", "言う", "出る", "入る", "方", "男", "女", "今", "何", "時"];
const LESS_COMMON_TERMS = ["行なう", "論じる", "過す", "行方", "人口", "猫", "犬", "滝", "理", "暁"];

export async function inferFrequencyDirection(dictionary, lookup) {
  if (dictionary.language && dictionary.language !== "ja") return null;

  const samples = [];
  for (const term of [...COMMON_TERMS, ...LESS_COMMON_TERMS]) {
    const reply = await lookup(term);
    const values = reply.results.flatMap(result => result.term.expression === term
      ? result.term.frequencies.filter(group => group.dictionary === dictionary.title)
        .flatMap(group => group.frequencies.map(frequency => frequency.value)).filter(Number.isFinite)
      : []);
    let min = Infinity, max = -Infinity;
    for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
    samples.push(values.length ? { min, max } : null);
  }
  let score = 0;
  for (const common of samples.slice(0, COMMON_TERMS.length)) {
    if (common === null) continue;
    for (const rare of samples.slice(COMMON_TERMS.length)) {
      if (rare !== null) score += Math.sign(common.max - rare.min) + Math.sign(common.min - rare.max);
    }
  }
  if (score < 0) return "ascending";
  if (score > 0) return "descending";
  return null;
}
