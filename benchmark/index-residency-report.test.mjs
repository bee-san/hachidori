// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markdown, summarise } from "./index-residency-report.mjs";

const MIB = 1024 * 1024;
const memory = (heap, dictionaries = []) => ({ heapBytes: heap * MIB, pageCacheBytes: 0, dictionaries });
const row = (variant, repetition, { cold, warm, wallMs, heap, dictionaries }) => ({
  variant, repetition, restartMs: 1000, fresh: memory(heap, dictionaries),
  passes: [{ latencies: cold, native: cold, memory: memory(heap) },
    { latencies: warm, native: warm, wallMs, memory: memory(heap) }],
  processRss: { peak: { extensionRssBytes: heap * MIB, treeRssBytes: 0 }, last: { extensionRssBytes: heap * MIB, treeRssBytes: 0 } },
  hover: [{ first: 1, complete: 2 }], reimport: { ms: 10 },
});

test("takes each figure's median across repetitions and compares it with main", () => {
  const directory = mkdtempSync(join(tmpdir(), "index-report-"));
  try {
    writeFileSync(join(directory, "definition.json"), JSON.stringify({ variants: ["baseline", "32"], defaultBudgetMiB: 32,
      fixture: { label: "test", packages: 2, corpus: ["a", "b", "c"], files: [{ name: "hash.table", bytes: 4 * MIB }],
        dictionaries: [{}, {}] } }));
    // main reports no hash residency, so every table counts as resident.
    const resident = [{ bytes: 5 * MIB }, { bytes: 5 * MIB }];
    const budget = [{ bytes: 5 * MIB, residentHashBytes: 4 * MIB }, { bytes: MIB, residentHashBytes: 0 }];
    const main = { cold: [3, 3, 3], heap: 100, dictionaries: resident };
    const rows = [
      row("baseline", 0, { ...main, warm: [1, 1, 1] }),
      row("baseline", 1, { ...main, warm: [1, 1, 1] }),
      // A repetition the host disturbed: it must not move the medians.
      row("baseline", 2, { ...main, warm: [9, 9, 9] }),
      ...[0, 1, 2].map(n => row("32", n, { cold: [4, 4, 4], warm: [2, 2, 2], wallMs: 10, heap: 40, dictionaries: budget })),
    ];
    writeFileSync(join(directory, "raw.jsonl"), `${rows.map(value => JSON.stringify(value)).join("\n")}\n`);
    const summary = summarise(directory);
    const [baseline, paged] = summary.variants;
    assert.equal(baseline.residentHashBytes, 8 * MIB);
    assert.equal(paged.residentHashBytes, 4 * MIB);
    assert.equal(paged.label, "PR, 32 MiB budget (default)");
    assert.deepEqual([baseline.warm.roundTrip.p50, baseline.warm.roundTrip.p95, baseline.warm.roundTrip.p50Range], [1, 1, [1, 9]]);
    assert.equal(baseline.warm.roundTrip.throughputPerSecond, 1000);
    assert.equal(paged.warm.roundTrip.throughputPerSecond, 300, "a pass's wall time sets its throughput");
    const [change] = summary.comparisons;
    assert.deepEqual(change.warmP95Ms, { delta: 1, percent: 100 });
    assert.deepEqual(change.warmThroughput, { delta: -700, percent: -70 });
    assert.deepEqual(change.heapPeakBytes, { delta: -60 * MIB, percent: -60 });
    assert.match(markdown(summary), /\| PR, 32 MiB budget \(default\) \| \+1\.00 ms \(\+33\.3%\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
