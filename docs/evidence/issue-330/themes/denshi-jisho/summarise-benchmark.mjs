// Summarise benchmark/hover-popup raw.json for two runs (issue #334 evidence).
//   node summarise-benchmark.mjs /tmp/hover-default /tmp/hover-dj
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
const round = value => (value === null ? null : Math.round(value * 10) / 10);
const groups = {
  "cold (first open, 1 per session)": row => row.label === "cold",
  "warm root (root-*, 8 per session)": row => row.label.startsWith("root-"),
  "deep nesting (deep-nesting-N, 8 per session)": row => /^deep-nesting-\d+$/u.test(row.label),
  "deep nesting flat (deep-nesting-flat-N)": row => row.label.startsWith("deep-nesting-flat-"),
  "child popup (child-first, child-replace)": row => row.label.startsWith("child-"),
};
const summary = {};
for (const directory of process.argv.slice(2)) {
  const rows = JSON.parse(readFileSync(resolve(directory, "raw.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  const out = { theme: manifest.settings.popupTheme ?? "default", revision: manifest.revision, samples: manifest.samples,
    chrome: rows[0]?.chrome, groups: {} };
  for (const [name, filter] of Object.entries(groups)) {
    const subset = rows.filter(filter);
    out.groups[name] = { n: subset.length,
      firstMs: { median: round(quantile(subset.map(r => r.firstMs), 0.5)), p95: round(quantile(subset.map(r => r.firstMs), 0.95)) },
      completeMs: { median: round(quantile(subset.map(r => r.completeMs), 0.5)), p95: round(quantile(subset.map(r => r.completeMs), 0.95)) },
      blankMs: { median: round(quantile(subset.map(r => r.blankMs), 0.5)), p95: round(quantile(subset.map(r => r.blankMs), 0.95)) } };
  }
  summary[directory] = out;
}
console.log(JSON.stringify(summary, null, 2));
const [base, theme] = Object.values(summary);
if (base && theme) {
  console.log("\n| Scan | metric | default median / p95 | denshi-jisho median / p95 | Δ median |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const name of Object.keys(groups)) {
    for (const metric of ["firstMs", "completeMs"]) {
      const b = base.groups[name][metric], t = theme.groups[name][metric];
      console.log(`| ${name} | ${metric} | ${b.median} / ${b.p95} | ${t.median} / ${t.p95} | ${round(t.median - b.median)} ms |`);
    }
  }
}
