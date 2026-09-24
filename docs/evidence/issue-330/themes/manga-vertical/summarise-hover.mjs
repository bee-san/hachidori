#!/usr/bin/env node
// Summarise two benchmark/hover-popup.mjs result folders (default vs theme):
// medians and p95 of input-to-first-result and input-to-complete-result for
// the warm root hovers and the deep-nesting alternation, plus the child panes.
//   node summarise-hover.mjs /tmp/hover-default /tmp/hover-theme
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [defaultDir, themeDir] = process.argv.slice(2).map(p => resolve(p));
const load = dir => JSON.parse(readFileSync(resolve(dir, "raw.json"), "utf8"));
const q = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null; };
const groups = {
  "cold first open": row => row.label === "cold",
  "warm root hovers (root-*)": row => row.label.startsWith("root-"),
  "deep-nesting entry (深層, 40 nested elements)": row => row.label.startsWith("deep-nesting-") && !row.label.startsWith("deep-nesting-flat"),
  "flat entries between them (deep-nesting-flat-*)": row => row.label.startsWith("deep-nesting-flat-"),
  "child panes (child-*)": row => row.label.startsWith("child-"),
};
const summarise = rows => Object.fromEntries(Object.entries(groups).map(([name, match]) => {
  const picked = rows.filter(match);
  return [name, { n: picked.length,
    firstMs: { median: q(picked.map(r => r.firstMs), 0.5), p95: q(picked.map(r => r.firstMs), 0.95) },
    completeMs: { median: q(picked.map(r => r.completeMs), 0.5), p95: q(picked.map(r => r.completeMs), 0.95) },
    blankMs: { median: q(picked.map(r => r.blankMs), 0.5), p95: q(picked.map(r => r.blankMs), 0.95) } }];
}));
const result = {
  default: { manifest: JSON.parse(readFileSync(resolve(defaultDir, "manifest.json"), "utf8")), summary: summarise(load(defaultDir)) },
  theme: { manifest: JSON.parse(readFileSync(resolve(themeDir, "manifest.json"), "utf8")), summary: summarise(load(themeDir)) },
};
for (const side of Object.values(result)) delete side.manifest.settings.customPopupCss;
writeFileSync(resolve(process.env.EVIDENCE_OUT ?? ".", "hover-benchmark.json"), JSON.stringify(result, null, 2));
const lines = ["| Scan | Default first / complete (median · p95, ms) | Tategaki first / complete (median · p95, ms) | n |", "| --- | --- | --- | --- |"];
for (const name of Object.keys(groups)) {
  const d = result.default.summary[name], t = result.theme.summary[name];
  lines.push(`| ${name} | ${d.firstMs.median} · ${d.firstMs.p95} / ${d.completeMs.median} · ${d.completeMs.p95} | ${t.firstMs.median} · ${t.firstMs.p95} / ${t.completeMs.median} · ${t.completeMs.p95} | ${d.n} vs ${t.n} |`);
}
console.log(lines.join("\n"));
console.log(JSON.stringify({ defaultRevision: result.default.manifest.revision, chrome: load(defaultDir)[0]?.chrome, samples: result.default.manifest.samples }, null, 2));
