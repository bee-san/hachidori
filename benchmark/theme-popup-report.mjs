// Summarise repeated renderer comparisons without discarding raw samples.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
const [destination, ...runs] = process.argv.slice(2);
mkdirSync(destination, { recursive: true });
const distribution = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { n: sorted.length, median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2, p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};
const metricDelta = (row, name) => ((row.metricsAfter.find(item => item.name === name)?.value ?? 0)
  - (row.metricsBefore.find(item => item.name === name)?.value ?? 0)) * 1000;
const summary = {};
for (const theme of ["default", "nazeka", "plain", "jl"]) {
  const rows = [];
  for (const [index, run] of runs.entries()) {
    const directory = resolve(run, theme);
    const raw = readFileSync(resolve(directory, "raw.json"));
    writeFileSync(resolve(destination, `${theme}-${index + 1}-raw.json.gz`), gzipSync(raw, { level: 9 }));
    writeFileSync(resolve(destination, `${theme}-${index + 1}-manifest.json`), readFileSync(resolve(directory, "manifest.json")));
    rows.push(...JSON.parse(raw));
  }
  const warm = rows.filter(row => /^(root-|deep-nesting)/u.test(row.label));
  const cold = rows.filter(row => row.label === "cold");
  summary[theme] = {
    profiles: cold.length,
    coldFirstMs: distribution(cold.map(row => row.firstMs)),
    coldCompleteMs: distribution(cold.map(row => row.completeMs)),
    warmFirstMs: distribution(warm.map(row => row.firstMs)),
    warmCompleteMs: distribution(warm.map(row => row.completeMs)),
    renderMs: distribution(warm.flatMap(row => row.renderer.samples.filter(sample => sample.method === "renderResults").map(sample => sample.ms))),
    nodes: distribution(warm.map(row => row.states.at(-1).levels[0].nodes)),
    scriptMs: distribution(warm.map(row => metricDelta(row, "ScriptDuration"))),
    styleMs: distribution(warm.map(row => metricDelta(row, "RecalcStyleDuration"))),
    layoutMs: distribution(warm.map(row => metricDelta(row, "LayoutDuration"))),
    heapBytes: distribution(warm.map(row => row.metricsAfter.find(item => item.name === "JSHeapUsedSize").value)),
    rendererWork: rows.filter(row => row.label === "child-replace").map(row => row.rendererWork),
    coldSamples: cold.map(row => ({ firstMs: row.firstMs, completeMs: row.completeMs })),
  };
}
writeFileSync(resolve(destination, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
