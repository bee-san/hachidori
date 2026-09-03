// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { retryTransientEvaluation } from "./yomitan.mjs";

test("retryTransientEvaluation retries a request whose response never arrives", async () => {
  let attempts = 0;
  const result = await retryTransientEvaluation(() => {
    attempts += 1;
    return attempts === 1 ? new Promise(() => {}) : Promise.resolve("ready");
  }, {
    attempts: 2,
    timeoutMs: 5,
    label: "options read",
  });

  assert.equal(result, "ready");
  assert.equal(attempts, 2);
});
