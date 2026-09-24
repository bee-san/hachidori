// Benchmark for issue #334 ("Theme proposal: Retro Terminal"): the repo's own
// hover-popup harness, unchanged, run against three copies of the worktree that
// differ in exactly one line — the DEFAULT_OPTIONS.popupTheme value in
// extension/reader-options.js — so a fresh profile opens with that theme.
// Variants are interleaved per round to spread machine noise evenly.
//
//   HACHIDORI_ROOT=<worktree with host-prototype.patch applied> BENCH_OUT=<dir> \
//   [BENCH_ROUNDS=3] node bench-themes.mjs
//   BENCH_OUT=<dir> BENCH_SUMMARISE_ONLY=1 node bench-themes.mjs   # re-summarise finished rounds
//
// Writes <dir>/<round>-<variant>/… (the harness's raw.json, manifest.json, …) and
// <dir>/summary.json with medians / p95 of firstMs and completeMs per variant. A
// round that fails (this box is shared and its load average passes 1000 at times)
// is recorded under `failed` and left out of the summary.
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, loadavg } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.BENCH_OUT;
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const VARIANTS = ["default", "retro-terminal", "nazeka"];
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const PUPPETEER = resolve(homedir(), ".cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
mkdirSync(OUT, { recursive: true });
const failed = [];

if (!process.env.BENCH_SUMMARISE_ONLY) {
  const fixture = resolve(OUT, "hover-fixture.zip");
  execFileSync("node", [resolve(ROOT, "benchmark/hover-popup-fixture.mjs"), fixture], { stdio: "inherit" });

  // One repo copy per variant: extension/ + benchmark/ + test/ (the fixture builder), .git for rev-parse.
  const copies = {};
  for (const variant of VARIANTS) {
    const copy = resolve(OUT, `repo-${variant}`);
    rmSync(copy, { recursive: true, force: true });
    mkdirSync(copy, { recursive: true });
    for (const part of ["extension", "benchmark", "test"]) cpSync(resolve(ROOT, part), resolve(copy, part), { recursive: true });
    cpSync(resolve(ROOT, ".git"), resolve(copy, ".git"), { recursive: true, dereference: true }); // worktree pointer file
    const optionsPath = resolve(copy, "extension/reader-options.js");
    const source = readFileSync(optionsPath, "utf8");
    const line = '    popupTheme: "default",';
    if (!source.includes(line)) throw new Error("DEFAULT_OPTIONS.popupTheme line not found");
    writeFileSync(optionsPath, source.replace(line, `    popupTheme: "${variant}",`));
    copies[variant] = copy;
  }

  for (let round = 0; round < ROUNDS; round += 1) {
    for (const variant of VARIANTS) {
      const dir = resolve(OUT, `${round}-${variant}`);
      if (existsSync(resolve(dir, "raw.json"))) { console.log(`\n=== round ${round} ${variant}: already done ===`); continue; }
      console.log(`\n=== round ${round} ${variant} (load ${loadavg().map(v => v.toFixed(0)).join("/")}) ===`);
      try {
        execFileSync("node", [resolve(copies[variant], "benchmark/hover-popup.mjs"), dir, fixture], {
          stdio: "inherit", cwd: copies[variant],
          env: { ...process.env, HACHIDORI_BENCH_REPO: copies[variant], HACHIDORI_CHROME: CHROME, HACHIDORI_PUPPETEER: PUPPETEER,
            HACHIDORI_HOVER_SAMPLES: "1", TMPDIR: process.env.TMPDIR ?? "/tmp" },
        });
      } catch (error) {
        failed.push({ round, variant, load: loadavg(), message: String(error.message).slice(0, 200) });
        rmSync(dir, { recursive: true, force: true });
        console.log(`=== round ${round} ${variant} FAILED (load ${loadavg().map(v => v.toFixed(0)).join("/")}) ===`);
      }
    }
  }
  for (const variant of VARIANTS) rmSync(copies[variant], { recursive: true, force: true });
}

// ---- summary over every finished <round>-<variant>/raw.json ----
const results = {};
const rounds = new Set();
for (const entry of readdirSync(OUT)) {
  const match = /^(\d+)-(.+)$/u.exec(entry);
  if (!match || !existsSync(resolve(OUT, entry, "raw.json"))) continue;
  const [, round, variant] = match;
  rounds.add(Number(round));
  const rows = JSON.parse(readFileSync(resolve(OUT, entry, "raw.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(OUT, entry, "manifest.json"), "utf8"));
  (results[variant] ??= []).push(...rows.map(row => ({ round: Number(round), label: row.label, firstMs: row.firstMs, completeMs: row.completeMs,
    blankMs: row.blankMs, longTasks: row.longTasks?.length ?? 0, loadAtStart: manifest.load })));
}
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
};
const round1 = value => value === null ? null : Math.round(value * 10) / 10;
const groups = { cold: row => row.label === "cold", root: row => row.label.startsWith("root-"),
  deep: row => row.label.startsWith("deep-nesting-") && !row.label.includes("flat"), flat: row => row.label.startsWith("deep-nesting-flat-"),
  child: row => row.label.startsWith("child-") };
const summary = { rounds: [...rounds].sort(), failed,
  harness: "benchmark/hover-popup.mjs (unchanged), HACHIDORI_HOVER_SAMPLES=1 per round, variants interleaved per round; each variant = one fresh Chrome profile with the hover-popup fixture imported through Settings",
  variants: {} };
for (const variant of Object.keys(results)) {
  summary.variants[variant] = { loadAtStart: [...new Set(results[variant].map(r => JSON.stringify(r.loadAtStart.map(v => Math.round(v)))))] };
  for (const [group, filter] of Object.entries(groups)) {
    const rows = results[variant].filter(filter);
    summary.variants[variant][group] = { n: rows.length,
      firstMs: { median: round1(quantile(rows.map(r => r.firstMs), 0.5)), p95: round1(quantile(rows.map(r => r.firstMs), 0.95)) },
      completeMs: { median: round1(quantile(rows.map(r => r.completeMs), 0.5)), p95: round1(quantile(rows.map(r => r.completeMs), 0.95)) } };
  }
}
writeFileSync(resolve(OUT, "summary.json"), JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
