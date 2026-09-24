// docs/evidence/issue-330/themes/rpg-dialogue/bench-summary.mjs — summarises two
// benchmark/hover-popup.mjs result folders (default theme vs rpg-dialogue) plus
// the theme host's onRender timings dumped per session (issue #334 evidence).
//
//   node bench-summary.mjs /tmp/hover-default /tmp/hover-rpg
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const [defaultDir, themeDir] = process.argv.slice(2).map(path => resolve(path));
const load = dir => JSON.parse(readFileSync(resolve(dir, "raw.json"), "utf8"));
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const median = values => quantile(values, 0.5);
const round = value => (value === null ? null : Math.round(value * 10) / 10);
const metric = (row, name) => row.metricsAfter?.find(item => item.name === name)?.value ?? null;

function summarise(dir) {
  const rows = load(dir);
  const pick = (test) => rows.filter(row => test(row.label));
  const groups = {
    cold: pick(label => label === "cold"),
    root: pick(label => label.startsWith("root-")),
    deep: pick(label => /^deep-nesting-\d/.test(label)),
    deepFlat: pick(label => label.startsWith("deep-nesting-flat-")),
    child: pick(label => label.startsWith("child-")),
  };
  const stats = values => ({ n: values.length, median: round(median(values)), p95: round(quantile(values, 0.95)), max: round(Math.max(...values)) });
  const out = {};
  for (const [name, list] of Object.entries(groups)) {
    if (list.length === 0) continue;
    out[name] = { firstMs: stats(list.map(row => row.firstMs)), completeMs: stats(list.map(row => row.completeMs)) };
  }
  const heaps = rows.filter(row => row.label === "rapid-final").map(row => metric(row, "JSHeapUsedSize"));
  out.heapUsedMiBAtEnd = heaps.length ? round(median(heaps) / 1048576) : null;
  const hooks = readdirSync(dir).filter(name => /-theme-hooks\.json$/.test(name))
    .flatMap(name => JSON.parse(readFileSync(resolve(dir, name), "utf8")));
  if (hooks.length) {
    const elapsed = hooks.map(hook => hook.elapsed);
    out.onRender = { calls: hooks.length, medianMs: round(median(elapsed)), p95Ms: round(quantile(elapsed, 0.95)), maxMs: round(Math.max(...elapsed)),
      byKind: Object.fromEntries(["term", "kanji"].map(kind => [kind, hooks.filter(hook => hook.kind === kind).length])) };
  }
  out.sessions = new Set(rows.map(row => row.session)).size;
  out.chrome = rows[0]?.chrome;
  return out;
}

const summary = { default: summarise(defaultDir), theme: summarise(themeDir) };
for (const name of ["cold", "root", "deep", "deepFlat"]) {
  const a = summary.default[name], b = summary.theme[name];
  if (a && b) summary[`${name}DeltaCompleteMedianMs`] = round(b.completeMs.median - a.completeMs.median);
}
summary.heapDeltaMiB = round((summary.theme.heapUsedMiBAtEnd ?? 0) - (summary.default.heapUsedMiBAtEnd ?? 0));
console.log(JSON.stringify(summary, null, 2));
