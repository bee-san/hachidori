// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markdown, summarise } from "./index-residency-report.mjs";

const MIB = 1024 * 1024;
const memory = (heap, extra = {}) => ({ heapBytes: heap * MIB, pageCacheBytes: 0, dictionaries: [], ...extra });
const row = (variant, repetition, cold, warm, heap, dictionaries) => ({
  variant, repetition, restartMs: 1000, fresh: { ...memory(heap), dictionaries },
  passes: [{ latencies: cold, native: cold, memory: memory(heap) }, { latencies: warm, native: warm, memory: memory(heap) }],
  processRss: { peak: { extensionRssBytes: heap * MIB, treeRssBytes: 0 }, last: { extensionRssBytes: heap * MIB, treeRssBytes: 0 } },
  hover: [{ first: 1, complete: 2 }], reimport: { ms: 10 },
});

test("pools every repetition's queries and compares against main", () => {
  const directory = mkdtempSync(join(tmpdir(), "index-report-"));
  try {
    const hash = { name: "hash.table", bytes: 4 * MIB };
    writeFileSync(join(directory, "definition.json"), JSON.stringify({ variants: ["baseline", "32"], defaultBudgetMiB: 32,
      fixture: { label: "test", packages: 2, corpus: ["a", "b"], files: [hash], dictionaries: [{}, {}] } }));
    const resident = [{ bytes: 5 * MIB }, { bytes: 5 * MIB }];
    const budget = [{ bytes: 5 * MIB, residentHashBytes: 4 * MIB }, { bytes: MIB, residentHashBytes: 0 }];
    writeFileSync(join(directory, "raw.jsonl"), [
      row("baseline", 0, [1, 2], [1, 1], 100, resident), row("baseline", 1, [3, 4], [1, 3], 100, resident),
      row("32", 0, [2, 3], [2, 2], 40, budget), row("32", 1, [4, 5], [2, 4], 40, budget),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const summary = summarise(directory);
    const [main, paged] = summary.variants;
    assert.equal(main.residentHashBytes, 8 * MIB, "main has every hash table resident");
    assert.equal(paged.residentHashBytes, 4 * MIB);
    assert.equal(paged.label, "PR, 32 MiB budget (default)");
    assert.deepEqual([main.cold.roundTrip.p50, main.cold.roundTrip.p95], [3, 4]);
    assert.deepEqual([paged.warm.roundTrip.p50, paged.warm.roundTrip.p95], [2, 4]);
    assert.equal(paged.warm.roundTrip.throughputPerSecond, 400);
    const [change] = summary.comparisons;
    assert.deepEqual(change.warmP50Ms, { delta: 1, percent: 100 });
    assert.deepEqual(change.heapPeakBytes, { delta: -60 * MIB, percent: -60 });
    assert.match(markdown(summary), /\| PR, 32 MiB budget \(default\) \| \+1\.00 ms \(\+33\.3%\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
