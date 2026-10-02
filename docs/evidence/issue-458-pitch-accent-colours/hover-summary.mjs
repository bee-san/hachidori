// Scratch (not committed): summarise benchmark/hover-popup.mjs runs for main vs branch.
import { readFileSync } from "node:fs";
const base = "/tmp/pitch458/bench";
const load = name => JSON.parse(readFileSync(`${base}/${name}/raw.json`, "utf8"));
const runs = { main: [...load("main-1"), ...load("main-2")], branch: [...load("branch-1"), ...load("branch-2")] };
const median = values => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const groups = [["cold", /^cold$/u], ["warm root", /^root-\d+$/u], ["deep nesting", /^deep-nesting-\d+$/u],
  ["deep nesting flat", /^deep-nesting-flat-\d+$/u], ["child first", /^child-first$/u], ["child replace", /^child-replace$/u]];
console.log("| Scenario | n (each) | main first ms | branch first ms | main complete ms | branch complete ms |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const [name, pattern] of groups) {
  const pick = rows => rows.filter(row => pattern.test(row.label));
  const [a, b] = [pick(runs.main), pick(runs.branch)];
  console.log(`| ${name} | ${a.length}/${b.length} | ${median(a.map(r => r.firstMs)).toFixed(1)} | ${median(b.map(r => r.firstMs)).toFixed(1)} | ${median(a.map(r => r.completeMs)).toFixed(1)} | ${median(b.map(r => r.completeMs)).toFixed(1)} |`);
}
// Same results on both sides: compare each expected word's signature.
const signatures = rows => Object.fromEntries(rows.map(row => [row.expected, row.resultSignature]));
const [sa, sb] = [signatures(runs.main), signatures(runs.branch)];
console.log("signatures equal:", JSON.stringify(sa) === JSON.stringify(sb), Object.keys(sa).length, "words");
// Synchronous renderer timings recorded by the probe, when present.
const renderer = rows => rows.filter(row => /^root-\d+$/u.test(row.label)).map(row => row.renderer).filter(Boolean);
const [ra, rb] = [renderer(runs.main), renderer(runs.branch)];
if (ra.length) {
  const keys = Object.keys(ra[0]).filter(key => typeof ra[0][key] === "number");
  for (const key of keys) console.log(`renderer ${key}: main ${median(ra.map(r => r[key])).toFixed(2)} branch ${median(rb.map(r => r[key])).toFixed(2)}`);
}
// Did the hovered words carry the pitch markup on the branch?
const sample = JSON.parse(readFileSync(`${base}/branch-1/session-0-root-0.json`, "utf8"));
console.log("sample replies pitches:", JSON.stringify(sample.replies.at(-1).results?.[0]?.term?.pitches ?? "n/a").slice(0, 200));
