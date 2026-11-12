// Production dictionary target search, excluding DOM layout and paint.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { createContext, runInContext } from "node:vm";

const beforeRef = process.argv[2] || "origin/main";
function load(source) {
  const context = createContext({});
  runInContext(source, context);
  return context.HDPopup.findDifferentDictionary;
}
const before = load(execFileSync("git", ["show", `${beforeRef}:extension/render/popup.js`], { encoding: "utf8" }));
const after = load(readFileSync("extension/render/popup.js", "utf8"));
const scroll = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
const iterations = 10_000;
const results = [];
for (const count of [1, 50, 500]) {
  const index = Math.floor(count / 2);
  const entries = Array.from({ length: count }, (_, i) => Array.from({ length: 30 }, (_, j) => ({
    dictionary: `D${j}`,
    getBoundingClientRect: () => ({ top: (i - index) * 5000 + j * 100, bottom: (i - index) * 5000 + j * 100 + 80 }),
  })));
  const args = [entries, index, 1, scroll, entry => entry, card => card.dictionary];
  for (const search of [before, after]) {
    for (let i = 0; i < 1000; i++) search(...args);
    assert.equal(search(...args).target, entries[index][1]);
  }
  const samples = { before: [], after: [] };
  for (let run = 0; run < 5; run++) {
    for (const name of run % 2 ? ["after", "before"] : ["before", "after"]) {
      const search = name === "before" ? before : after;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) search(...args);
      samples[name].push(Number((performance.now() - start).toFixed(3)));
    }
  }
  results.push({ entries: count, cardsPerEntry: 30, iterations, samples });
}
console.log(JSON.stringify({
  node: process.version, environment: { platform: platform(), arch: arch(), cpu: cpus()[0].model },
  baseline: execFileSync("git", ["rev-parse", beforeRef], { encoding: "utf8" }).trim(),
  scope: "production dictionary target search; synthetic stable geometry; excludes layout, paint, and scroll",
  results,
}, null, 2));
