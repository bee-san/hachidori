// SPDX-License-Identifier: GPL-3.0-or-later
// #578: how a Settings import waits for its turn at the engine and retries.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ENGINE_POLL_MAX_MS, ENGINE_POLL_MS, ENGINE_WAIT_TIMEOUT_MS, IMPORT_ATTEMPTS, RETRY_DELAY_MS,
  engineBusy, importWithRetries, sleep, waitForEngine,
} from "../extension/dictionary-import-attempts.js";

const IDLE = { ok: true, ready: true, mutating: false };
const MUTATING = { ok: true, ready: true, mutating: true };
const IMPORTED = { ok: true, report: { success: true, title: "Fixture" } };
const FAILED = { ok: false, error: "the archive could not be read", errorCode: "import-failed",
  report: { success: false, error: "the archive could not be read" } };

// A fake clock: each wait records its delay and advances time, and honours
// cancellation the way sleep() does.
function fakeTime() {
  let now = 0;
  const waits = [];
  return {
    waits,
    now: () => now,
    wait: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(ms);
      now += ms;
    },
  };
}

// Answers status polls in order, repeating the last one.
function statuses(...replies) {
  const log = [];
  return {
    log,
    readStatus: async () => {
      const reply = replies[Math.min(log.length, replies.length - 1)];
      log.push(reply);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

function importer(...replies) {
  const calls = [];
  return {
    calls,
    attempt: async (number) => {
      calls.push(number);
      const reply = replies[Math.min(calls.length, replies.length) - 1];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test("the engine is busy only while it starts or a dictionary change holds its lock", () => {
  assert.equal(engineBusy({ ok: true, ready: false }), true);
  assert.equal(engineBusy(MUTATING), true);
  // Lookups in flight make the engine report loading, which is no reason to wait.
  assert.equal(engineBusy({ ...IDLE, loading: true }), false);
  assert.equal(engineBusy({ ok: false, error: "the Hoshidicts engine stopped", ready: false }), false);
  assert.equal(engineBusy(null), false);
});

test("an idle engine is not waited for", async () => {
  const time = fakeTime();
  const engine = statuses(IDLE);
  assert.equal(await waitForEngine({ ...engine, ...time }), 0);
  assert.deepEqual(time.waits, []);
  assert.equal(engine.log.length, 1);
});

test("a busy engine is polled with backoff until it is free", async () => {
  const time = fakeTime();
  const engine = statuses(MUTATING, MUTATING, MUTATING, MUTATING, MUTATING, MUTATING, IDLE);
  const waited = [];
  assert.equal(await waitForEngine({ ...engine, ...time, onWait: (ms) => waited.push(ms) }), 7750);
  assert.deepEqual(time.waits, [ENGINE_POLL_MS, 500, 1000, ENGINE_POLL_MAX_MS, ENGINE_POLL_MAX_MS, ENGINE_POLL_MAX_MS]);
  assert.deepEqual(waited, [0, 250, 750, 1750, 3750, 5750]);
});

test("a status that cannot be read ends the wait so the import can report the failure", async () => {
  const time = fakeTime();
  assert.equal(await waitForEngine({ ...statuses(new Error("the extension's service worker did not reply")), ...time }), 0);
  assert.deepEqual(time.waits, []);
});

test("an engine that stays busy ends the wait after the generous timeout", async () => {
  const time = fakeTime();
  await assert.rejects(waitForEngine({ ...statuses(MUTATING), ...time }),
    { message: "The dictionary engine was still busy after 30 minutes." });
  assert.equal(time.now(), ENGINE_WAIT_TIMEOUT_MS);
  assert.ok(time.waits.every((ms) => ms <= ENGINE_POLL_MAX_MS));
});

test("cancelling ends a wait at once", async () => {
  const controller = new AbortController();
  const waiting = waitForEngine({ ...statuses(MUTATING), signal: controller.signal });
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, { name: "AbortError" });
  assert.ok(Date.now() - started < ENGINE_POLL_MAX_MS, "the real sleep stops when cancelled");
  await assert.rejects(sleep(10, controller.signal), { name: "AbortError" });
  await sleep(1);
});

test("an import runs once when it succeeds, after waiting for the engine", async () => {
  const time = fakeTime();
  const engine = statuses(MUTATING, MUTATING, IDLE);
  const imports = importer(IMPORTED);
  const events = [];
  const outcome = await importWithRetries({ ...engine, ...time, ...imports, readRevision: async () => 4,
    onWait: () => events.push("wait"), onAttempt: (number) => events.push(`attempt ${number}`) });
  assert.deepEqual(outcome, { ok: true, reply: IMPORTED, attempts: 1 });
  assert.deepEqual(events, ["wait", "wait", "attempt 1"]);
  assert.deepEqual(imports.calls, [1]);
});

test("a failed import is retried with backoff and can then succeed", async () => {
  const time = fakeTime();
  const imports = importer(FAILED, IMPORTED);
  const retried = [];
  const outcome = await importWithRetries({ ...statuses(IDLE), ...time, ...imports, readRevision: async () => 4,
    onRetry: (number, failure) => retried.push([number, failure.reply.error]) });
  assert.deepEqual(outcome, { ok: true, reply: IMPORTED, attempts: 2 });
  assert.deepEqual(retried, [[1, FAILED.error]]);
  assert.deepEqual(time.waits, [RETRY_DELAY_MS]);
});

test("an import that keeps failing is reported after the last attempt", async () => {
  const time = fakeTime();
  const imports = importer(FAILED, new Error("the extension's service worker did not reply"), FAILED);
  const outcome = await importWithRetries({ ...statuses(IDLE), ...time, ...imports, readRevision: async () => 4 });
  assert.deepEqual(outcome, { ok: false, reply: FAILED, attempts: IMPORT_ATTEMPTS });
  assert.deepEqual(imports.calls, [1, 2, 3]);
  assert.deepEqual(time.waits, [RETRY_DELAY_MS, 2 * RETRY_DELAY_MS]);
});

test("a thrown request is a failed attempt and is retried", async () => {
  const lost = new Error("the extension's service worker did not reply");
  const outcome = await importWithRetries({ ...statuses(IDLE), ...fakeTime(), ...importer(lost, IMPORTED),
    readRevision: async () => 4 });
  assert.deepEqual(outcome, { ok: true, reply: IMPORTED, attempts: 2 });
});

test("memory, storage and engine start failures are not retried", async () => {
  for (const errorCode of ["import-memory", "import-storage-full", "engine-start-failed"]) {
    const imports = importer({ ...FAILED, errorCode });
    const outcome = await importWithRetries({ ...statuses(IDLE), ...fakeTime(), ...imports, readRevision: async () => 4 });
    assert.equal(outcome.attempts, 1, errorCode);
    assert.deepEqual(imports.calls, [1]);
  }
});

test("an import is not retried once the library changed, so it cannot run twice", async () => {
  // The reply was lost while the import still ran: the retry waits for the
  // engine, then finds the library it committed.
  const time = fakeTime();
  const engine = statuses(IDLE, MUTATING, MUTATING, IDLE);
  const revisions = [4, 5];
  const imports = importer(new Error("The message port closed before a response was received."), IMPORTED);
  const outcome = await importWithRetries({ ...engine, ...time, ...imports, readRevision: async () => revisions.shift() });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(imports.calls, [1]);
  assert.equal(engine.log.length, 4, "the retry waited for the engine before reading the library");

  const unreadable = importer(FAILED, IMPORTED);
  await importWithRetries({ ...statuses(IDLE), ...fakeTime(), ...unreadable,
    readRevision: async () => { throw new Error("the dictionary state could not be read"); } });
  assert.deepEqual(unreadable.calls, [1], "an unreadable library is not retried either");
});

test("the library is read beside the first status poll, and again after waiting for another change", async () => {
  // Idle: one read, made while the status poll is in flight.
  const reads = [];
  const idle = await importWithRetries({ ...statuses(IDLE), ...fakeTime(), ...importer(IMPORTED),
    readRevision: async () => { reads.push("read"); return 4; } });
  assert.equal(idle.ok, true);
  assert.equal(reads.length, 1);

  // Another tab's import commits while this one waits: the revision read after
  // the wait is the one a retry compares with, so the retry still happens.
  const revisions = [4, 5, 5];
  const imports = importer(FAILED, IMPORTED);
  const outcome = await importWithRetries({ ...statuses(MUTATING, IDLE), ...fakeTime(), ...imports,
    readRevision: async () => revisions.shift() });
  assert.deepEqual(outcome, { ok: true, reply: IMPORTED, attempts: 2 });
  assert.deepEqual(imports.calls, [1, 2]);
  assert.deepEqual(revisions, []);
});

test("cancelling before the first attempt imports nothing; cancelling a retry reports the failure", async () => {
  const before = new AbortController();
  const untried = importer(IMPORTED);
  const waiting = importWithRetries({ ...statuses(MUTATING), ...untried, readRevision: async () => 4, signal: before.signal });
  setTimeout(() => before.abort(), 10);
  await assert.rejects(waiting, { name: "AbortError" });
  assert.deepEqual(untried.calls, []);

  const during = new AbortController();
  const failing = importer(FAILED, IMPORTED);
  const outcome = await importWithRetries({ ...statuses(IDLE), ...failing, readRevision: async () => 4,
    signal: during.signal, onRetry: () => during.abort() });
  assert.deepEqual(outcome, { ok: false, reply: FAILED, attempts: 1 });
  assert.deepEqual(failing.calls, [1]);
});
