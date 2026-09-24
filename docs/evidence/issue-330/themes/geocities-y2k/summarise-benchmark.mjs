// Summarises two benchmark/hover-popup.mjs runs (default vs theme) from their raw.json:
//   node summarise-benchmark.mjs <default-dir> <theme-dir> > benchmark.json
// Groups: cold (first open per fresh profile), root (warm flat entries 食べる/漢字),
// deep (深層, the 40-level nested gloss), deep-flat, child (nested popup), rapid-final.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
const round = value => (value === null ? null : Math.round(value * 10) / 10);
const groups = {
  cold: label => label === "cold",
  root: label => label.startsWith("root-"),
  deep: label => /^deep-nesting-\d/u.test(label),
  "deep-flat": label => label.startsWith("deep-nesting-flat-"),
  child: label => label.startsWith("child-"),
  "rapid-final": label => label === "rapid-final",
};
const summary = {};
for (const [side, directory] of [["default", process.argv[2]], ["theme", process.argv[3]]]) {
  const rows = JSON.parse(readFileSync(resolve(directory, "raw.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  summary[side] = { revision: manifest.revision, chrome: rows[0]?.chrome, sessions: manifest.samples, settings: manifest.settings, groups: {} };
  for (const [group, test] of Object.entries(groups)) {
    const matching = rows.filter(row => test(row.label));
    const first = matching.map(row => row.firstMs), complete = matching.map(row => row.completeMs), blank = matching.map(row => row.blankMs);
    summary[side].groups[group] = { n: matching.length,
      firstMedianMs: round(quantile(first, 0.5)), firstP95Ms: round(quantile(first, 0.95)),
      completeMedianMs: round(quantile(complete, 0.5)), completeP95Ms: round(quantile(complete, 0.95)),
      blankMedianMs: round(quantile(blank, 0.5)) };
  }
  const heap = rows.filter(row => row.metricsAfter).map(row => row.metricsAfter.find(m => m.name === "JSHeapUsedSize")?.value ?? null).filter(v => v !== null);
  summary[side].jsHeapUsedMiBLast = heap.length ? Math.round(heap.at(-1) / 1048576 * 100) / 100 : null;
  summary[side].jsHeapUsedMiBMax = heap.length ? Math.round(Math.max(...heap) / 1048576 * 100) / 100 : null;
}
console.log(JSON.stringify(summary, null, 2));
