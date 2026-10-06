// SPDX-License-Identifier: GPL-3.0-or-later
// Summarises index-residency.mjs and index-residency-native.mjs output:
//   node benchmark/index-residency-report.mjs <results-directory>...
// Each directory gains summary.json and summary.md; the tables are printed.
// Latency percentiles pool every query of every repetition for one pass;
// other figures are the median across repetitions.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readJsonlRecoveringTail } from "./system.mjs";

const MIB = 1024 * 1024;
const LABELS = { baseline: "main (all resident)", resident: "PR, resident", paged: "PR, all paged" };
const label = (variant, defaultBudgetMiB = 32) => LABELS[variant]
  ?? `PR, ${variant} MiB budget${Number(variant) === defaultBudgetMiB ? " (default)" : ""}`;

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
// The same rank rule as the harness's per-sample distribution.
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
};
const sum = values => values.reduce((total, value) => total + value, 0);
const latency = values => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99),
  throughputPerSecond: values.length ? values.length / (sum(values) / 1000) : null, count: values.length });

function browserVariant(variant, rows, { fixture, defaultBudgetMiB }) {
  const pass = n => rows.flatMap(row => row.passes[n].latencies);
  const engine = n => rows.flatMap(row => row.passes[n].native);
  const memory = n => rows.map(row => row.passes[n].memory);
  const residentHash = item => item.residentHashBytes ?? (item.hashIndexStorage === "paged" ? 0 : null);
  const fixtureHashBytes = fixture.hashTableBytes
    ?? fixture.dictionaries.length * fixture.files.find(file => file.name === "hash.table").bytes;
  const indexReads = rows.map(row => row.passes[1].memory.indexes?.reads - row.passes[0].memory.indexes?.reads);
  return {
    variant, label: label(variant, defaultBudgetMiB), samples: rows.length,
    startupMs: median(rows.map(row => row.restartMs)),
    firstLookupMs: median(rows.map(row => row.passes[0].latencies[0])),
    cold: { roundTrip: latency(pass(0)), engine: latency(engine(0)),
      samplesP50: rows.map(row => percentile(row.passes[0].latencies, 0.5)) },
    warm: { roundTrip: latency(pass(1)), engine: latency(engine(1)),
      samplesP50: rows.map(row => percentile(row.passes[1].latencies, 0.5)) },
    // main reports no hash residency field: every hash table is resident.
    residentHashBytes: median(rows.map(row => {
      const values = row.fresh.dictionaries.map(residentHash);
      return values.every(Number.isFinite) ? sum(values) : fixtureHashBytes;
    })),
    residentFileBytes: median(rows.map(row => sum(row.fresh.dictionaries.map(item => item.bytes)))),
    heapAfterLoadBytes: median(rows.map(row => row.fresh.heapBytes)),
    // WASM memory never shrinks: the heap after both passes is the session peak.
    heapPeakBytes: median(memory(1).map(item => item.heapBytes)),
    liveAfterLookupsBytes: median(memory(1).map(item => item.liveAllocatedBytes)),
    pageCacheAfterLookupsBytes: median(memory(1).map(item => item.pageCacheBytes)),
    warmIndexReads: median(indexReads),
    extensionRssPeakBytes: median(rows.map(row => row.processRss?.peak.extensionRssBytes)),
    extensionRssSteadyBytes: median(rows.map(row => row.processRss?.last.extensionRssBytes)),
    treeRssPeakBytes: median(rows.map(row => row.processRss?.peak.treeRssBytes)),
    treeRssSteadyBytes: median(rows.map(row => row.processRss?.last.treeRssBytes)),
    reimportMs: median(rows.map(row => row.reimport?.ms)),
    disabledRestartMs: median(rows.map(row => row.disabledRestartMs)),
    recycleMs: median(rows.map(row => row.recycleMs)),
    hoverFirst: percentile(rows.flatMap(row => row.hover.map(item => item.first)), 0.5),
    hoverComplete: percentile(rows.flatMap(row => row.hover.map(item => item.complete)), 0.5),
  };
}

function nativeVariant(mode, rows) {
  const pass = n => rows.flatMap(row => row.passes[n]);
  return { variant: mode, label: mode === "paged" ? "all paged (native)" : "resident (native)", samples: rows.length,
    cold: { engine: latency(pass(0)) }, warm: { engine: latency(pass(1)) },
    warmIndexReads: median(rows.map(row => row.cache?.[1]?.indexes.reads - row.cache?.[0]?.indexes.reads)) };
}

const change = (value, base) => (Number.isFinite(value) && Number.isFinite(base)
  ? { delta: value - base, percent: base ? (value - base) / base * 100 : null } : null);

function comparisons(variants) {
  const base = variants.find(item => item.variant === "baseline") ?? variants.find(item => item.variant === "resident");
  if (!base) return [];
  return variants.filter(item => item !== base).map(item => ({
    variant: item.variant, against: base.variant,
    coldP50Ms: change(item.cold.roundTrip?.p50 ?? item.cold.engine.p50, base.cold.roundTrip?.p50 ?? base.cold.engine.p50),
    coldP95Ms: change(item.cold.roundTrip?.p95 ?? item.cold.engine.p95, base.cold.roundTrip?.p95 ?? base.cold.engine.p95),
    warmP50Ms: change(item.warm.roundTrip?.p50 ?? item.warm.engine.p50, base.warm.roundTrip?.p50 ?? base.warm.engine.p50),
    warmP95Ms: change(item.warm.roundTrip?.p95 ?? item.warm.engine.p95, base.warm.roundTrip?.p95 ?? base.warm.engine.p95),
    warmThroughput: change(item.warm.roundTrip?.throughputPerSecond ?? item.warm.engine.throughputPerSecond,
      base.warm.roundTrip?.throughputPerSecond ?? base.warm.engine.throughputPerSecond),
    startupMs: change(item.startupMs, base.startupMs),
    heapPeakBytes: change(item.heapPeakBytes, base.heapPeakBytes),
    heapAfterLoadBytes: change(item.heapAfterLoadBytes, base.heapAfterLoadBytes),
    extensionRssPeakBytes: change(item.extensionRssPeakBytes, base.extensionRssPeakBytes),
    extensionRssSteadyBytes: change(item.extensionRssSteadyBytes, base.extensionRssSteadyBytes),
  }));
}

export function summarise(directory) {
  const definition = JSON.parse(readFileSync(resolve(directory, "definition.json"), "utf8"));
  const rows = readJsonlRecoveringTail(resolve(directory, "raw.jsonl"));
  const native = rows.length > 0 && "mode" in rows[0];
  const order = native ? ["resident", "paged"] : definition.variants;
  const variants = order.map(variant => {
    const matching = rows.filter(row => (native ? row.mode : row.variant) === variant);
    if (!matching.length) return null;
    return native ? nativeVariant(variant, matching) : browserVariant(variant, matching, definition);
  }).filter(Boolean);
  return { kind: native ? "native" : "browser", fixture: definition.fixture.label, packages: definition.fixture.packages,
    hashTableBytes: definition.fixture.hashTableBytes ?? null, corpus: definition.fixture.corpus.length,
    revision: definition.revision ?? null, beforeRevision: definition.beforeRevision ?? null, variants,
    comparisons: comparisons(variants) };
}

const ms = value => (Number.isFinite(value) ? value.toFixed(2) : "–");
const whole = value => (Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "–");
const mib = value => (Number.isFinite(value) ? (value / MIB).toFixed(1) : "–");
const signed = (value, digits = 2) => (Number.isFinite(value) ? `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}` : "–");
const delta = (item, unit, scale = 1, digits = 2) => (item
  ? `${signed(item.delta / scale, digits)} ${unit} (${signed(item.percent, 1)}%)` : "–");

export function markdown(summary) {
  const lines = [];
  if (summary.kind === "native") {
    lines.push("| Hash storage | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s | Warm hash-page reads |",
      "| --- | ---: | ---: | ---: | ---: |");
    for (const item of summary.variants) {
      lines.push(`| ${item.label} | ${ms(item.cold.engine.p50)} / ${ms(item.cold.engine.p95)} | ${ms(item.warm.engine.p50)} / ${ms(item.warm.engine.p95)}`
        + ` | ${whole(item.warm.engine.throughputPerSecond)} | ${whole(item.warmIndexReads)} |`);
    }
  } else {
    lines.push("| Variant | Resident hashes (MiB) | Startup (ms) | Cold p50 / p95 (ms) | Warm p50 / p95 (ms) | Warm lookups/s"
      + " | Heap after load / peak (MiB) | Live after lookups (MiB) | Extension RSS peak / steady (MiB) | Reimport (ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const item of summary.variants) {
      lines.push(`| ${item.label} | ${mib(item.residentHashBytes)} | ${whole(item.startupMs)}`
        + ` | ${ms(item.cold.roundTrip.p50)} / ${ms(item.cold.roundTrip.p95)} | ${ms(item.warm.roundTrip.p50)} / ${ms(item.warm.roundTrip.p95)}`
        + ` | ${whole(item.warm.roundTrip.throughputPerSecond)} | ${mib(item.heapAfterLoadBytes)} / ${mib(item.heapPeakBytes)}`
        + ` | ${mib(item.liveAfterLookupsBytes)} | ${mib(item.extensionRssPeakBytes)} / ${mib(item.extensionRssSteadyBytes)}`
        + ` | ${whole(item.reimportMs)} |`);
    }
  }
  if (summary.comparisons.length) {
    const against = summary.variants.find(item => item.variant === summary.comparisons[0].against).label;
    lines.push("", `Against ${against}:`, "");
    if (summary.kind === "native") {
      lines.push("| Hash storage | Cold p50 | Warm p50 | Warm p95 | Warm throughput |", "| --- | ---: | ---: | ---: | ---: |");
      for (const item of summary.comparisons) {
        lines.push(`| ${summary.variants.find(v => v.variant === item.variant).label} | ${delta(item.coldP50Ms, "ms", 1, 3)}`
          + ` | ${delta(item.warmP50Ms, "ms", 1, 3)} | ${delta(item.warmP95Ms, "ms", 1, 3)} | ${signed(item.warmThroughput?.percent, 1)}% |`);
      }
    } else {
      lines.push("| Variant | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Warm throughput | Heap peak | Extension RSS peak |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const item of summary.comparisons) {
        lines.push(`| ${summary.variants.find(v => v.variant === item.variant).label} | ${delta(item.coldP50Ms, "ms")}`
          + ` | ${delta(item.coldP95Ms, "ms")} | ${delta(item.warmP50Ms, "ms")} | ${delta(item.warmP95Ms, "ms")}`
          + ` | ${signed(item.warmThroughput?.percent, 1)}% | ${delta(item.heapPeakBytes, "MiB", MIB, 1)}`
          + ` | ${delta(item.extensionRssPeakBytes, "MiB", MIB, 1)} |`);
      }
    }
  }
  return lines.join("\n");
}

export function writeSummary(directory) {
  const summary = summarise(directory);
  const table = markdown(summary);
  writeFileSync(resolve(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(resolve(directory, "summary.md"), `${table}\n`);
  return table;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const directory of process.argv.slice(2)) {
    const summary = summarise(directory);
    console.log(`\n## ${summary.fixture} (${summary.packages} packages, ${summary.corpus} queries)\n`);
    console.log(writeSummary(directory));
  }
}
