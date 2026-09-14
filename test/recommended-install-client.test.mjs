// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createRecommendedInstallClient } from "../extension/recommended-install-client.js";
import { installEntryState } from "../extension/dictionary-progress.js";

const snapshot = (sequence, finished = false, runId = "run") => ({ ok: true, runId, sequence, finished,
  entries: [{ sourceId: "jitendex", phase: finished ? "installed" : "downloading", receivedBytes: 1024, totalBytes: 4096, seconds: 2 }] });
const event = value => ({ target: "hachidori-setup-events", type: "hd_setup_progress", ...value });

test("startup and Settings retain ordered progress, and a quiet linked page can observe completion", async () => {
  let timer;
  let answer = snapshot(1);
  let updates = 0;
  const requests = [];
  const client = createRecommendedInstallClient({
    send: async ids => { requests.push(ids); return answer; },
    onChange: () => { updates++; }, onError: error => { throw error; },
    timers: { setTimeout(callback) { timer = callback; return 1; }, clearTimeout() { timer = null; } },
  });
  await client.request(["jitendex"]);
  client.receive(event(snapshot(3)));
  client.receive(event(snapshot(2)));
  client.receive(event(snapshot(9, false, "old-run")));
  assert.equal(client.run.sequence, 3);
  assert.equal(updates, 2);
  assert.equal(installEntryState(client.run.entries[0]).progress.value, .25);
  answer = snapshot(4, true);
  await timer();
  assert.deepEqual(requests, [["jitendex"], []], "polling only observes; it never starts another batch");
  assert.equal(client.run.finished, true);
  assert.equal(timer, null);
  assert.equal(installEntryState(client.run.entries[0]).text, "Installed in 2.0 seconds");
  client.stop();
  client.receive(event(snapshot(1, false, "next-run")));
  assert.equal(client.run.runId, "run", "closing a page detaches its observer");
});

test("a click during initial observation is retained and a late reply cannot roll live progress back", async () => {
  let reply;
  const requests = [];
  const client = createRecommendedInstallClient({
    send: ids => { requests.push(ids); return requests.length === 1 ? new Promise(resolve => { reply = resolve; }) : snapshot(1); },
    onChange() {}, onError: error => { throw error; }, timers: { setTimeout() {}, clearTimeout() {} },
  });
  const observe = client.request([]);
  const install = client.request(["jitendex"]);
  await Promise.resolve();
  reply({ ok: true, runId: null, sequence: 0, finished: true, entries: [] });
  await observe;
  client.receive(event(snapshot(5)));
  await install;
  assert.deepEqual(requests, [[], ["jitendex"]]);
  assert.equal(client.run.sequence, 5);
});

test("an unsuccessful start is reported once and waits for an explicit retry", async () => {
  let requests = 0, errors = 0, timers = 0;
  const client = createRecommendedInstallClient({
    send: async () => { requests++; return { ok: false, error: "worker unavailable" }; },
    onChange() {}, onError: error => { assert.match(error.message, /worker unavailable/); errors++; },
    timers: { setTimeout() { timers++; }, clearTimeout() {} },
  });
  await client.request(["jitendex"]);
  assert.equal(client.failed, true);
  assert.equal(client.pending, null);
  assert.deepEqual([requests, errors, timers], [1, 1, 0]);
});
