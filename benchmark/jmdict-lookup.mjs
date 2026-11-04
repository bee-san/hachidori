#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

// Hachidori vs Yomitan lookup speed on one real dictionary (JMdict), both on their shipped
// defaults. Runs the production-path adapters from hachidori.mjs and yomitan.mjs on an
// alternating schedule; compare.mjs remains the three-engine (JL included) contract.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { makeComparisonSchedule, validateLookupEvidence } from "./comparison-lib.mjs";
import { runHachidoriSample } from "./hachidori.mjs";
import { normalizeConfig, percentile, sha256Canonical } from "./lib.mjs";
import { directoryContentSha256, hostSnapshot, persistThenCleanup, sha256File } from "./system.mjs";
import { runYomitanSample } from "./yomitan.mjs";

const REPO = resolve(import.meta.dirname, "..");
const SCAN_LENGTH = 16; // Hachidori's and Yomitan's default scan length
const MAX_RESULTS = 32; // and default result limit
const ATTEMPTS = 6;

// Public-domain prose (Natsume Sōseki, Akutagawa, Dazai) and everyday sentences. A lookup starts
// at each character except punctuation and spaces, as a hover would, and scans up to the next 16
// characters; a scan that repeats an earlier one is dropped.
const TEXTS = [
  "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。",
  "親譲りの無鉄砲で小供の時から損ばかりしている。",
  "ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。広い門の下には、この男のほかに誰もいない。",
  "メロスは激怒した。必ず、かの邪智暴虐の王を除かなければならぬと決意した。メロスには政治がわからぬ。メロスは、村の牧人である。笛を吹き、羊と遊んで暮して来た。",
  "昨日友達と一緒に新しいラーメン屋に行ってみたけど、思ったより美味しくなかった。",
  "明日は雨が降るらしいから、傘を持って行ったほうがいいよ。",
  "彼女は日本語を勉強しながら、アニメを字幕なしで見られるようになりたいと言っていた。",
  "会議の資料はもう送っておきましたので、確認していただけますか。",
];

export function hoverQueries(texts = TEXTS) {
  const queries = [];
  const seen = new Set();
  for (const text of texts) {
    const chars = [...text];
    for (let index = 0; index < chars.length; index += 1) {
      if (/[、。「」『』（）\s]/u.test(chars[index])) continue;
      const scan = chars.slice(index, index + SCAN_LENGTH).join("");
      if (seen.has(scan)) continue;
      seen.add(scan);
      queries.push({ id: `scan-${String(queries.length).padStart(3, "0")}`, text: scan, expect: "any" });
    }
  }
  return [
    ...queries,
    { id: "eat-exact", text: "食べる", expect: "hit", expectedExpression: "食べる" },
    { id: "eat-deinflected", text: "食べたかった", expect: "hit", expectedExpression: "食べる" },
    { id: "japan-exact", text: "日本", expect: "hit", expectedExpression: "日本" },
    { id: "emoji-miss", text: "🫠🫨🪼", expect: "miss" },
  ];
}

function archiveReport(archive) {
  const unzip = (...args) => execFileSync("unzip", args, { encoding: "utf8", maxBuffer: 1 << 30 });
  const index = JSON.parse(unzip("-p", archive, "index.json"));
  const banks = unzip("-Z1", archive).split("\n").filter((name) => /^term_bank_\d+\.json$/.test(name));
  const termCount = banks.reduce((sum, bank) => sum + JSON.parse(unzip("-p", archive, bank)).length, 0);
  return { title: index.title, termCount };
}

export function summarize(rows) {
  const engines = {};
  for (const engine of ["hachidori", "yomitan"]) {
    const measured = rows.filter((row) => row.engine === engine && !row.warmup);
    const latencies = (row) => row.lookup.passes.flatMap((pass) => pass.details.map((detail) => detail.latencyMs));
    const all = measured.flatMap(latencies).sort((a, b) => a - b);
    const passWallMs = measured.flatMap((row) => row.lookup.passes.map((pass) => pass.wallMs));
    engines[engine] = {
      samples: measured.length,
      lookups: all.length,
      meanMs: all.reduce((sum, value) => sum + value, 0) / all.length,
      ...Object.fromEntries([50, 90, 95, 99].map((p) => [`p${p}Ms`, percentile(all, p / 100)])),
      minMs: all[0],
      maxMs: all.at(-1),
      samplesP50Ms: measured.map((row) => percentile(latencies(row).sort((a, b) => a - b), 0.5)),
      lookupsPerSecond: all.length / (passWallMs.reduce((sum, value) => sum + value, 0) / 1000),
      importSeconds: measured.map((row) => row.metrics.importUsableWallMs / 1000),
      firstLookupMs: measured.map((row) => row.firstLookup.latencyMs),
      semanticSha256: [...new Set(measured.map((row) => row.lookup.semanticSha256))],
      cdf: Array.from({ length: 201 }, (_, step) => [percentile(all, step / 200), step / 200]),
    };
  }
  return engines;
}

function renderMarkdown(definition, engines) {
  const h = engines.hachidori;
  const y = engines.yomitan;
  const median = (values) => percentile([...values].sort((a, b) => a - b), 0.5);
  const row = (label, format, hv, yv, ratio) => `| ${label} | ${format(hv)} | ${format(yv)} | ${ratio} |`;
  const ms = (value) => `${value.toFixed(2)} ms`;
  return [
    `# JMdict lookup: Hachidori vs Yomitan`,
    "",
    `Hachidori ${definition.engines[0].commit.slice(0, 8)}, Yomitan ${definition.engines[1].version}, ` +
      `${definition.corpus.title} (${definition.corpus.termCount} terms), ${definition.chromeVersion}.`,
    `${h.samples} measured installs per reader, ${definition.config.lookupPasses} passes of ${definition.queryCount} lookups each.`,
    "",
    "| Metric | Hachidori | Yomitan | Ratio |",
    "| --- | ---: | ---: | ---: |",
    ...["p50", "p90", "p95", "p99"].map((key) =>
      row(`Lookup ${key}`, ms, h[`${key}Ms`], y[`${key}Ms`], `${(y[`${key}Ms`] / h[`${key}Ms`]).toFixed(1)}×`)),
    row("Mean lookup", ms, h.meanMs, y.meanMs, `${(y.meanMs / h.meanMs).toFixed(1)}×`),
    row("Lookups per second", (value) => value.toFixed(0), h.lookupsPerSecond, y.lookupsPerSecond,
      `${(h.lookupsPerSecond / y.lookupsPerSecond).toFixed(1)}×`),
    row("Import to first lookup (median)", (value) => `${value.toFixed(1)} s`, median(h.importSeconds), median(y.importSeconds),
      `${(median(y.importSeconds) / median(h.importSeconds)).toFixed(0)}×`),
    row("Per-install lookup p50", (values) => values.map((value) => value.toFixed(2)).join(", "), h.samplesP50Ms, y.samplesP50Ms, ""),
    "",
  ].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      jmdict: { type: "string" },
      yomitan: { type: "string" },
      output: { type: "string" },
      warmups: { type: "string", default: "1" },
      samples: { type: "string", default: "5" },
      passes: { type: "string", default: "5" },
      "summarize-only": { type: "boolean", default: false },
    },
  });
  if (!values.output || (!values["summarize-only"] && (!values.jmdict || !values.yomitan))) {
    throw new Error("usage: jmdict-lookup.mjs --jmdict JMdict_english.zip --yomitan yomitan-chrome.zip --output DIR");
  }
  const output = resolve(values.output);
  const rawPath = resolve(output, "raw.jsonl");
  const definitionPath = resolve(output, "definition.json");
  if (values["summarize-only"]) {
    writeSummary(output, JSON.parse(readFileSync(definitionPath, "utf8")), rawPath);
    return;
  }
  const jmdict = resolve(values.jmdict);
  const corpus = archiveReport(jmdict);
  const queries = hoverQueries();
  const config = normalizeConfig({
    corpora: [{
      id: "jmdict",
      archive: jmdict,
      expectedSha256: sha256File(jmdict),
      expectedReport: corpus,
      expectedDictionaryCount: 1,
    }],
    queries,
    warmups: Number(values.warmups),
    samples: Number(values.samples),
    lookupPasses: Number(values.passes),
    idleCheckMs: 0,
    seed: 20261102,
    timeoutMs: 300_000,
    headless: true,
    keepProfiles: false,
    allowNoSandbox: process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1",
    lookup: {
      maxResults: MAX_RESULTS,
      scanLength: SCAN_LENGTH,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    },
  }, REPO);
  for (const entry of config.corpora) {
    entry.archiveSha256 = sha256File(entry.archive);
    entry.archiveBytes = readFileSync(entry.archive).length;
  }

  mkdirSync(output, { recursive: true });
  const yomitanDirectory = resolve(output, "yomitan-extension");
  if (!existsSync(resolve(yomitanDirectory, "manifest.json"))) {
    mkdirSync(yomitanDirectory, { recursive: true });
    execFileSync("unzip", ["-oq", resolve(values.yomitan), "-d", yomitanDirectory]);
  }
  const yomitanVersion = JSON.parse(readFileSync(resolve(yomitanDirectory, "manifest.json"), "utf8")).version;
  const commit = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const extensionContentSha256 = directoryContentSha256(resolve(REPO, "extension"));
  const engines = [
    { id: "hachidori", kind: "hachidori", label: "Hachidori", commit, extensionContentSha256,
      revision: { repositoryCommit: commit, extensionContentSha256 } },
    { id: "yomitan", kind: "yomitan", label: "Yomitan", version: yomitanVersion,
      archiveSha256: sha256File(resolve(values.yomitan)) },
  ];
  const chromePath = process.env.HACHIDORI_CHROME ?? "/usr/bin/chromium";
  const puppeteerPath = process.env.HACHIDORI_PUPPETEER
    ?? resolve(homedir(), ".cache", "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
  const definition = {
    config,
    configSha256: sha256Canonical(config),
    engines,
    schedule: makeComparisonSchedule(engines.map((engine) => engine.id), ["jmdict"], config),
    runtime: {
      chromePath,
      chromeSha256: sha256File(chromePath),
      puppeteerPath,
      puppeteerPackageSha256: null,
      hachidoriExtensionPath: resolve(REPO, "extension"),
      yomitanExtensionPath: yomitanDirectory,
    },
    corpus,
    queryCount: queries.length,
    chromeVersion: execFileSync(chromePath, ["--version"], { encoding: "utf8" }).trim(),
    host: hostSnapshot(),
  };
  if (!existsSync(definitionPath)) writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);

  const puppeteer = await import(pathToFileURL(puppeteerPath).href);
  const launch = puppeteer.default?.launch ? puppeteer.default : puppeteer;
  const failuresPath = resolve(output, "failures.jsonl");
  const records = (path) => (existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : []);
  const done = new Set(records(rawPath).map((row) => row.runId));
  const failures = records(failuresPath);
  for (const item of definition.schedule) {
    if (done.has(item.runId)) continue;
    const run = item.engine === "hachidori" ? runHachidoriSample : runYomitanSample;
    // The adapters clear an attempt's directory before using it, so a resumed cell numbers its
    // attempts after the failed ones, whose profiles and diagnostics stay for diagnosis.
    const failed = failures.filter((entry) => entry.runId === item.runId).map((entry) => entry.attempt);
    const first = failed.length === 0 ? 0 : Math.max(...failed) + 1;
    for (let attempt = first; ; attempt += 1) {
      process.stdout.write(`run  ${item.runId} attempt ${attempt}\n`);
      try {
        const result = await run({ item: { ...item, attempt }, corpus: config.corpora[0], config, definition, output, launch });
        const row = { ...item, attempt, ...result, diagnostics: undefined };
        validateLookupEvidence(row, config);
        // A failed attempt keeps its profile for diagnosis; a successful one's goes once its row is written.
        persistThenCleanup({
          persist: () => appendFileSync(rawPath, `${JSON.stringify(row)}\n`),
          cleanup: () => rmSync(result.profilePath, { recursive: true, force: true }),
          onCleanupError: (error) => process.stderr.write(`WARN ${item.runId}: could not remove ${result.profilePath}: ${error.message}\n`),
        });
        process.stdout.write(`ok   ${item.runId} import=${(result.metrics.importUsableWallMs / 1000).toFixed(1)}s\n`);
        break;
      } catch (error) {
        const message = error?.message ?? String(error);
        appendFileSync(failuresPath,
          `${JSON.stringify({ runId: item.runId, attempt, error: message, at: new Date().toISOString() })}\n`);
        process.stdout.write(`fail ${item.runId} attempt ${attempt}: ${message.split("\n")[0]}\n`);
        if (attempt + 1 - first >= ATTEMPTS) throw error;
      }
    }
  }
  writeSummary(output, definition, rawPath);
}

function writeSummary(output, definition, rawPath) {
  const rows = readFileSync(rawPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const engines = summarize(rows);
  writeFileSync(resolve(output, "summary.json"), `${JSON.stringify({
    hachidoriCommit: definition.engines[0].commit,
    yomitanVersion: definition.engines[1].version,
    corpus: definition.corpus,
    chromeVersion: definition.chromeVersion,
    queryCount: definition.queryCount,
    lookupPasses: definition.config.lookupPasses,
    engines,
  }, null, 1)}\n`);
  const markdown = renderMarkdown(definition, engines);
  writeFileSync(resolve(output, "summary.md"), markdown);
  process.stdout.write(markdown);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
