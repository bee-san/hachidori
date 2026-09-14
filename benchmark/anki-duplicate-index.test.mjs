// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { argumentsFrom, median, percentile, summary } from "./anki-duplicate-index.mjs";

test("duplicate-index benchmark statistics use measured samples and nearest-rank p95", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 0.95), 95);
  assert.deepEqual(summary([1, 2, 3, 4], 8), {
    samples: 4,
    medianMs: 2.5,
    p95Ms: 4,
    requestCount: 8,
    requestsPerRun: 2,
  });
});

test("duplicate-index benchmark requires an explicit isolated profile and refuses the live port", () => {
  const options = argumentsFrom([
    "--endpoint", "http://127.0.0.1:18765",
    "--expected-media-dir", "/tmp/fixture/collection.media",
    "--runs", "20",
    "--warmups", "4",
  ]);
  assert.equal(options.endpoint, "http://127.0.0.1:18765/");
  assert.equal(options.runs, 20);
  assert.equal(options.warmups, 4);
  assert.throws(() => argumentsFrom([
    "--endpoint", "http://127.0.0.1:8765",
    "--expected-media-dir", "/tmp/fixture/collection.media",
  ]), /standard AnkiConnect port/u);
  assert.throws(() => argumentsFrom(["--endpoint", "http://127.0.0.1:18765"]), /expected-media-dir/u);
});
