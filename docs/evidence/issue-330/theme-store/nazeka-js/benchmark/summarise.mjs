// Summarise two benchmark/hover-popup.mjs output directories (baseline, themed)
// into medians and p95s per input, the theme's onRender cost, and a verdict
// against the budgets proposed in issue #334.
//
//   node summarise.mjs <baseline-dir> <themed-dir> <out-prefix>
//
// Inputs are grouped by what was hovered (the harness's fixed words):
//   short      食べる — one flat sense (warm root-*, deep-nesting-flat-*, trace-1, rapid-final)
//   long       漢字   — 24 numbered senses from theme-bench-senses.zip (warm root-*, deep-nesting-flat-*, kanji-term-*, trace-0)
//   deep       深層   — a gloss under 40 nested elements (deep-nesting-*, kanji-reset-*)
//   kanji      漢     — the kanji view opened from the 漢字 popup (kanji-view-*)
//   cold       first hover of a fresh profile (one per session)
// warmup-* and child-* (depth 1) rows are left out of the tables.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [baselineDir, themedDir, outPrefix] = process.argv.slice(2);
const load = dir => ({ rows: JSON.parse(readFileSync(resolve(dir, "raw.json"), "utf8")),
  manifest: JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) });
const baseline = load(baselineDir), themed = load(themedDir);

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};
const round = (value, digits = 2) => value === null ? null : Number(value.toFixed(digits));
const metric = (row, name, when) => row[when].find(entry => entry.name === name)?.value ?? null;
const delta = (row, name) => metric(row, name, "metricsAfter") - metric(row, name, "metricsBefore");

const GROUPS = {
  short: row => row.kind !== "kanji" && row.depth === 0 && row.expected === "食べる" && !/^(cold|warmup)/.test(row.label),
  long: row => row.kind !== "kanji" && row.depth === 0 && row.expected === "漢字" && !/^(cold|warmup)/.test(row.label),
  deep: row => row.kind !== "kanji" && row.depth === 0 && row.expected === "深層",
  kanji: row => row.kind === "kanji",
  cold: row => row.label === "cold",
};

function stats(rows, group) {
  const selected = rows.filter(GROUPS[group]);
  const series = (pick) => selected.map(pick).filter(value => typeof value === "number" && Number.isFinite(value));
  const summary = (pick, digits = 1) => {
    const values = series(pick);
    return { n: values.length, median: round(quantile(values, 0.5), digits), p95: round(quantile(values, 0.95), digits), max: round(Math.max(...values), digits) };
  };
  const result = { n: selected.length };
  if (group === "kanji") {
    result.renderMs = summary(row => row.renderMs);      // click → kanji entries in the DOM (incl. onRender)
    result.frameMs = summary(row => row.frameMs);        // click → next animation frame
  } else {
    result.firstMs = summary(row => row.firstMs);        // pointer input → first correct frame
    result.completeMs = summary(row => row.completeMs);  // pointer input → complete, stable result
    result.blankMs = summary(row => row.blankMs);
    result.popupNodes = summary(row => row.states.at(-1)?.levels[row.depth]?.nodes, 0);
  }
  // Renderer-side costs between the two Performance.getMetrics snapshots of each scan.
  result.layoutMs = summary(row => delta(row, "LayoutDuration") * 1000, 2);
  result.recalcStyleMs = summary(row => delta(row, "RecalcStyleDuration") * 1000, 2);
  result.scriptMs = summary(row => delta(row, "ScriptDuration") * 1000, 2);
  result.layoutCount = summary(row => delta(row, "LayoutCount"), 0);
  result.longTasksMs = summary(row => (row.longTasks ?? []).filter(task => task.startTime >= row.start && task.startTime <= (row.complete ?? row.now))
    .reduce((sum, task) => sum + task.duration, 0), 1);
  const hooks = selected.flatMap(row => row.theme?.samples ?? []).map(sample => sample.ms);
  result.onRenderMs = hooks.length ? { n: hooks.length, median: round(quantile(hooks, 0.5), 2), p95: round(quantile(hooks, 0.95), 2), max: round(Math.max(...hooks), 2) } : null;
  return result;
}

function heap(rows) {
  // JS heap of the reading tab at the end of each session (after every scan).
  const bySession = new Map();
  for (const row of rows) bySession.set(row.session, metric(row, "JSHeapUsedSize", "metricsAfter"));
  const values = [...bySession.values()].map(bytes => bytes / 1024 / 1024);
  return { sessions: values.length, medianMiB: round(quantile(values, 0.5)), maxMiB: round(Math.max(...values)) };
}

const report = {
  generatedAt: new Date().toISOString(),
  chrome: baseline.rows[0]?.chrome, node: baseline.manifest.node, cpu: baseline.manifest.cpu, logicalCpus: baseline.manifest.logicalCpus,
  revision: baseline.manifest.revision, sessions: baseline.manifest.samples,
  archives: baseline.manifest.archives.map(archive => ({ path: archive.path.split("/").pop(), sha256: archive.sha256 })),
  settings: { baseline: baseline.manifest.settings, themed: themed.manifest.settings },
  load: { baseline: baseline.manifest.load, themed: themed.manifest.load },
  theme: themed.rows.find(row => row.theme)?.theme?.theme ?? null,
  themeDisabled: themed.rows.some(row => row.theme?.disabled),
  groups: {},
  heapMiB: { baseline: heap(baseline.rows), themed: heap(themed.rows) },
};
for (const group of Object.keys(GROUPS)) report.groups[group] = { baseline: stats(baseline.rows, group), themed: stats(themed.rows, group) };

// Budgets proposed for hachidori-themes CI (issue #334). The hover ones follow the
// harness's own rule: a first/complete regression needs BOTH > 5 ms and > 10 %.
const allHooks = themed.rows.flatMap(row => row.theme?.samples ?? []).map(sample => sample.ms);
const onRenderP95 = round(quantile(allHooks, 0.95), 2), onRenderMax = round(Math.max(...allHooks), 2);
const regress = (name, key) => {
  const b = report.groups[name].baseline[key].median, t = report.groups[name].themed[key].median;
  const deltaMs = round(t - b, 1), percent = b ? round((t - b) / b * 100, 1) : null;
  return { baselineMedian: b, themedMedian: t, deltaMs, percent, fails: deltaMs > 5 && percent > 10 };
};
report.budget = {
  onRender: { p95Ms: onRenderP95, maxMs: onRenderMax, budgetP95Ms: 2, pass: onRenderP95 <= 2 },
  hover: Object.fromEntries(["short", "long", "deep"].flatMap(group => [
    [`${group}.firstMs`, regress(group, "firstMs")], [`${group}.completeMs`, regress(group, "completeMs")]])),
  kanji: { renderMs: regress("kanji", "renderMs"), frameMs: regress("kanji", "frameMs") },
  heap: { deltaMiB: round(report.heapMiB.themed.medianMiB - report.heapMiB.baseline.medianMiB), budgetMiB: 2 },
};
report.budget.heap.pass = report.budget.heap.deltaMiB <= report.budget.heap.budgetMiB;
report.budget.pass = report.budget.onRender.pass && report.budget.heap.pass
  && !Object.values(report.budget.hover).some(entry => entry.fails) && !report.budget.kanji.renderMs.fails;
writeFileSync(`${outPrefix}.json`, JSON.stringify(report, null, 2));

// Markdown table for the issue body.
const cell = value => value === null || value === undefined ? "–" : String(value);
const lines = [];
lines.push(`Chrome ${report.chrome}, Node ${report.node}, ${report.sessions} fresh profiles per side, ${report.cpu}. Times in ms (median / p95).`, "");
lines.push("| Input | Measure | Default | Nazeka (JS) | Δ median |", "|---|---|---|---|---|");
const row = (input, label, key, sub) => {
  const b = report.groups[input].baseline[key], t = report.groups[input].themed[key];
  if (!b || !t) return;
  const d = round(t.median - b.median, key.endsWith("Ms") && !["layoutMs", "recalcStyleMs", "scriptMs"].includes(key) ? 1 : 2);
  lines.push(`| ${sub ? "" : input} | ${label} | ${cell(b.median)} / ${cell(b.p95)} | ${cell(t.median)} / ${cell(t.p95)} | ${d > 0 ? "+" : ""}${cell(d)} |`);
};
for (const input of ["short", "long", "deep"]) {
  row(input, "hover → first correct frame", "firstMs");
  row(input, "hover → complete result", "completeMs", true);
  row(input, "layout time per scan", "layoutMs", true);
  row(input, "style recalc per scan", "recalcStyleMs", true);
  row(input, "script time per scan", "scriptMs", true);
  row(input, "popup DOM nodes", "popupNodes", true);
}
row("kanji", "click → kanji view in DOM", "renderMs");
row("kanji", "click → next frame", "frameMs", true);
row("kanji", "layout time per open", "layoutMs", true);
row("cold", "first hover of a fresh profile", "firstMs");
row("cold", "complete", "completeMs", true);
lines.push("", `theme.js \`onRender\` (Nazeka, all ${allHooks.length} calls): median ${round(quantile(allHooks, 0.5), 2)} ms, p95 ${onRenderP95} ms, max ${onRenderMax} ms; ` +
  `per kind — term ${cell(report.groups.short.themed.onRenderMs?.p95)} ms p95 (short), ${cell(report.groups.long.themed.onRenderMs?.p95)} ms p95 (24 senses), ` +
  `${cell(report.groups.deep.themed.onRenderMs?.p95)} ms p95 (deep), kanji ${cell(report.groups.kanji.themed.onRenderMs?.p95)} ms p95.`);
lines.push(`Reading-tab JS heap at session end: default ${report.heapMiB.baseline.medianMiB} MiB, Nazeka ${report.heapMiB.themed.medianMiB} MiB (Δ ${report.budget.heap.deltaMiB} MiB).`);
lines.push("", `Budget verdict: onRender p95 ${onRenderP95} ms ≤ 2 ms → ${report.budget.onRender.pass ? "pass" : "FAIL"}; ` +
  `hover regressions (> 5 ms and > 10 %): ${Object.values(report.budget.hover).filter(entry => entry.fails).length} of ${Object.keys(report.budget.hover).length}; ` +
  `kanji open regression: ${report.budget.kanji.renderMs.fails ? "FAIL" : "none"}; heap Δ ${report.budget.heap.deltaMiB} MiB ≤ 2 MiB → ${report.budget.heap.pass ? "pass" : "FAIL"}. Overall: ${report.budget.pass ? "PASS" : "FAIL"}.`);
writeFileSync(`${outPrefix}.md`, `${lines.join("\n")}\n`);

// Ready-to-paste theme.yaml block (schema: benchmark).
const pair = name => { const b = report.groups[name.group].baseline[name.key].median, t = report.groups[name.group].themed[name.key].median; return `{ default: ${b}, theme: ${t} }`; };
const yaml = [
  "benchmark:               # benchmark/hover-popup.mjs, this theme vs default, same Chrome and archives",
  "  harness: hover-popup.mjs",
  `  harnessCommit: ${report.revision}`,
  `  chrome: ${String(report.chrome).replace(/^Chrome\//, "")}`,
  `  sessions: ${report.sessions}`,
  `  measuredAt: ${report.generatedAt.slice(0, 10)}`,
  `  onRenderP95Ms: ${onRenderP95}`,
  `  onRenderMaxMs: ${onRenderMax}`,
  `  hoverCompleteMedianMs: ${pair({ group: "short", key: "completeMs" })}`,
  `  longEntryCompleteMedianMs: ${pair({ group: "long", key: "completeMs" })}`,
  `  deepEntryCompleteMedianMs: ${pair({ group: "deep", key: "completeMs" })}`,
  `  kanjiOpenMedianMs: ${pair({ group: "kanji", key: "renderMs" })}`,
  `  coldFirstMedianMs: ${pair({ group: "cold", key: "firstMs" })}`,
  `  heapDeltaMiB: ${report.budget.heap.deltaMiB}`,
  "  results: <URL of raw.json/summary.md for this run>",
];
writeFileSync(`${outPrefix}.yaml`, `${yaml.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`\ntheme.yaml block written to ${outPrefix}.yaml:\n${yaml.join("\n")}`);
