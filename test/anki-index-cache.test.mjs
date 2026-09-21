// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import {
  ANKI_INDEX_ALARM,
  ANKI_INDEX_REFRESH_MS,
  ankiIndexConfigurationChange,
  createAnkiDuplicateIndex,
} from "../extension/anki-index-cache.js";

const copy = value => structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(saved) {
  let options = globalThis.HDReaderOptions.normaliseOptions({ anki: {
    model: "Japanese",
    fields: { expression: "Expression" },
  } });
  let state = copy(saved), clock = 1_800_000, rows = [["猫", true, [9, 7]]];
  let held = null, failure = null, writeFailure = false, storageTail = Promise.resolve(), writing = false;
  const refreshes = [], lookups = [], alarms = new Map();
  const dependencies = {
    async fetchRows(source) {
      assert.equal(writing, false, "Anki refresh must run outside the storage queue");
      refreshes.push(source);
      if (held) { const pending = held; held = null; await pending.promise; }
      if (failure) throw failure;
      return copy(rows);
    },
    async lookupLive(source, expression, invoke) {
      lookups.push({ source, expression, invoke });
      return invoke.answer(expression);
    },
    readOptions: async () => copy(options),
    readState: async () => copy(state),
    updateState(update) {
      const run = storageTail.then(async () => {
        writing = true;
        try {
          const next = await update({ options: copy(options), state: copy(state) });
          if (writeFailure) throw new Error("storage unavailable");
          if (next !== undefined) state = copy(next);
          return copy(state);
        } finally {
          writing = false;
        }
      });
      storageTail = run.catch(() => {});
      return run;
    },
    alarms: {
      get: async name => copy(alarms.get(name)),
      clear: async name => alarms.delete(name),
      create: async (name, value) => alarms.set(name, { name, scheduledTime: value.when }),
    },
    now: () => clock,
    reportError() {},
  };
  const service = createAnkiDuplicateIndex(dependencies);
  return {
    service,
    dependencies,
    alarms,
    refreshes,
    lookups,
    invoke(answer) { return { answer }; },
    get options() { return copy(options); },
    get state() { return copy(state); },
    setRows(value) { rows = copy(value); },
    fail(value = new Error("Anki closed")) { failure = value; },
    failWrites(value = true) { writeFailure = value; },
    hold() { return held = deferred(); },
    due() { clock += ANKI_INDEX_REFRESH_MS; },
    tick() { clock += 1; },
    async change(patch, notify = true) {
      const commit = storageTail.then(async () => {
        const nextOptions = globalThis.HDReaderOptions.normaliseOptions({ ...options, ...patch });
        const nextState = await ankiIndexConfigurationChange(options, nextOptions, copy(state));
        options = nextOptions;
        if (nextState !== undefined) state = copy(nextState);
      });
      storageTail = commit.catch(() => {});
      await commit;
      if (notify) return service.reconcile();
    },
  };
}

test("cold maturity checks stay cache-only while one refresh supplies every later lookup", async () => {
  const f = fixture(), hold = f.hold();
  const refresh = f.service.reconcile();
  while (!f.refreshes.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.service.has(f.options.anki, "猫"), false);
  assert.equal(f.lookups.length, 0);
  hold.resolve();
  await refresh;
  for (let index = 0; index < 5; index++) assert.equal(await f.service.has(f.options.anki, "猫"), true);
  assert.equal(await f.service.has(f.options.anki, "犬"), false);
  assert.equal(f.refreshes.length, 1);
  assert.equal(f.lookups.length, 0, "an unrelated absent word must not query Anki for maturity");
});

test("suspending drains an admitted refresh, clears its alarm, and blocks local pulls until resume", async () => {
  const f = fixture(), hold = f.hold();
  const refresh = f.service.reconcile();
  while (!f.refreshes.length) await new Promise(resolve => setImmediate(resolve));
  let suspended = false;
  const suspension = f.service.suspend().then(() => { suspended = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(suspended, false);
  hold.resolve();
  await Promise.all([refresh, suspension]);
  assert.equal(f.alarms.has(ANKI_INDEX_ALARM), false);
  f.due();
  await f.service.reconcile();
  assert.equal(f.refreshes.length, 1);
  await f.service.resume();
  assert.equal(f.refreshes.length, 2);
});

test("warm hits return sorted note IDs without Anki, while an absent word is never negatively cached", async () => {
  const f = fixture();
  await f.service.reconcile();
  const forbidden = f.invoke(() => { throw new Error("warm hit queried Anki"); });
  assert.deepEqual(await f.service.peek(f.options.anki, "猫"), {
    wordKey: "猫",
    mature: true,
    noteIds: [7, 9],
    cached: true,
  });
  assert.deepEqual(await f.service.peek(f.options.anki, "犬"), {
    wordKey: "犬",
    mature: false,
    noteIds: [],
    cached: false,
  });
  assert.equal(f.lookups.length, 0, "cache-only misses must remain unknown without querying Anki");
  assert.deepEqual(await f.service.lookup(f.options.anki, "猫", forbidden), {
    wordKey: "猫",
    mature: true,
    noteIds: [7, 9],
    cached: true,
  });
  const live = f.invoke(() => ({ wordKey: "犬", mature: false, noteIds: [] }));
  assert.deepEqual(await f.service.lookup(f.options.anki, "犬", live), {
    wordKey: "犬",
    mature: false,
    noteIds: [],
    cached: false,
  });
  assert.equal(f.lookups.length, 1);
  await f.service.lookup(f.options.anki, "犬", live);
  assert.equal(f.lookups.length, 2, "a miss without notes must not create a negative row");
});

test("a miss repaired from Anki is persisted once and the second lookup makes zero Anki requests", async () => {
  const f = fixture();
  await f.service.reconcile();
  const invoke = f.invoke(expression => ({ wordKey: expression, mature: true, noteIds: [42, 12, 42] }));
  const first = await f.service.lookup(f.options.anki, "犬", invoke);
  assert.deepEqual(first, { wordKey: "犬", mature: true, noteIds: [12, 42], cached: false });
  const calls = f.lookups.length;
  const second = await f.service.lookup(f.options.anki, "犬",
    f.invoke(() => { throw new Error("repaired hit queried Anki"); }));
  assert.deepEqual(second, { wordKey: "犬", mature: true, noteIds: [12, 42], cached: true });
  assert.equal(f.lookups.length, calls);
  assert.deepEqual(f.state.snapshot.rows, [["犬", true, [12, 42]], ["猫", true, [7, 9]]]);
});

test("forced stale repair replaces or removes the compact row", async () => {
  const f = fixture();
  await f.service.reconcile();
  const replaced = await f.service.repair(f.options.anki, "猫",
    f.invoke(() => ({ wordKey: "猫", mature: false, noteIds: [15] })));
  assert.deepEqual(replaced.noteIds, [15]);
  assert.deepEqual(f.state.snapshot.rows, [["猫", false, [15]]]);
  await f.service.repair(f.options.anki, "猫",
    f.invoke(() => ({ wordKey: "猫", mature: false, noteIds: [] })));
  assert.deepEqual(f.state.snapshot.rows, []);
  assert.equal(await f.service.has(f.options.anki, "猫"), false);
});

test("confirmed adds and overwrites update the row immediately without changing its maturity", async () => {
  const f = fixture();
  await f.service.reconcile();
  await f.service.recordWrite(f.options.anki, "猫", 8);
  assert.deepEqual(f.state.snapshot.rows, [["猫", true, [7, 8, 9]]]);
  await f.service.recordWrite(f.options.anki, "犬", 20, { mature: false });
  assert.deepEqual(f.state.snapshot.rows, [["犬", false, [20]], ["猫", true, [7, 8, 9]]]);
  assert.equal(await f.service.has(f.options.anki, "犬"), false);
  assert.equal(f.lookups.length, 0, "maturity membership must remain cache-only");
});

test("the complete index refreshes every 30 minutes and retries if a post-write update races its pull", async () => {
  const f = fixture(), hold = f.hold();
  const refresh = f.service.reconcile();
  while (!f.refreshes.length) await new Promise(resolve => setImmediate(resolve));
  await f.service.recordWrite(f.options.anki, "犬", 20);
  f.setRows([["犬", false, [20]], ["猫", true, [7, 9]]]);
  hold.resolve();
  await refresh;
  while (f.refreshes.length < 2) await new Promise(resolve => setImmediate(resolve));
  while (!f.state.snapshot.rows.some(([word]) => word === "犬")) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(f.refreshes.length, 2, "a pull started before the write must not erase its row");
  assert.equal(f.alarms.get(ANKI_INDEX_ALARM).scheduledTime, 3_600_000);
  assert.ok(f.state.snapshot.rows.some(([word]) => word === "犬"));
  f.due();
  await f.service.reconcile();
  while (f.refreshes.length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.refreshes.length, 3);
});

test("refreshes retain the previous snapshot through pending, offline, malformed and failed-storage outcomes", async () => {
  const f = fixture();
  await f.service.reconcile();
  const original = f.state.snapshot;

  f.due();
  const hold = f.hold(), refresh = f.service.reconcile();
  while (f.refreshes.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.service.has(f.options.anki, "猫"), true);
  f.setRows([["犬", false, [20]]]);
  hold.resolve();
  await refresh;
  assert.equal(await f.service.has(f.options.anki, "犬"), false);
  assert.equal(f.state.snapshot.rows[0][0], "犬");

  f.due();
  f.fail();
  await f.service.reconcile();
  assert.equal(f.state.snapshot.rows[0][0], "犬");
  f.fail(null);
  f.due();
  f.setRows([["invalid"]]);
  await f.service.reconcile();
  assert.equal(f.state.snapshot.rows[0][0], "犬");

  f.due();
  f.setRows([["鳥", true, [30]]]);
  f.failWrites();
  await f.service.reconcile();
  assert.equal(f.state.snapshot.rows[0][0], "犬");
  assert.notDeepEqual(f.state.snapshot, original);
});

test("a restarted worker restores the snapshot and missing alarm without repeating a recent failed pull", async () => {
  const f = fixture();
  await f.service.reconcile();
  f.due();
  f.fail();
  await f.service.reconcile();
  const calls = f.refreshes.length;
  f.alarms.clear();
  const restarted = createAnkiDuplicateIndex(f.dependencies);
  await restarted.reconcile();
  assert.equal(await restarted.has(f.options.anki, "猫"), true);
  assert.equal(f.refreshes.length, calls);
  assert.equal(f.alarms.get(ANKI_INDEX_ALARM).scheduledTime, 5_400_000);
});

test("a refresh interrupted before commit is retried by the next worker start", async () => {
  const f = fixture(), hold = f.hold();
  const interrupted = f.service.reconcile();
  while (!f.refreshes.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.attempt.finishedAt, undefined, "a reservation carries no outcome until its pull ends");
  // The worker that reserved this pull is gone; a repaired miss in between
  // must not disguise the unfinished refresh as a complete one.
  f.tick();
  const restarted = createAnkiDuplicateIndex(f.dependencies);
  await restarted.lookup(f.options.anki, "犬", f.invoke(() => ({ wordKey: "犬", mature: true, noteIds: [12] })));
  await restarted.reconcile();
  assert.equal(f.refreshes.length, 2, "an orphaned attempt is due immediately, not at its 30-minute mark");
  hold.resolve();
  await interrupted;
  assert.equal(typeof f.state.attempt.finishedAt, "number");
  assert.equal(await restarted.has(f.options.anki, "猫"), true);
  // Its own reservation is never mistaken for an orphan: a repeat reconcile waits.
  await restarted.reconcile();
  assert.equal(f.refreshes.length, 2);
  assert.equal(f.alarms.get(ANKI_INDEX_ALARM).scheduledTime, 3_600_001);
});

test("scope changes invalidate membership and schedule an immediate replacement, while policy changes retain it", async () => {
  const f = fixture();
  await f.service.reconcile();
  const before = f.state.configurationRevision;
  await f.change({ anki: { ...f.options.anki, duplicateBehavior: "overwrite" } });
  assert.equal(f.state.configurationRevision, before);
  assert.equal(await f.service.has(f.options.anki, "猫"), true);
  await f.change({ anki: { ...f.options.anki, duplicateScope: "all" } }, false);
  assert.equal(f.state.configurationRevision, before + 1);
  assert.equal(await f.service.has(f.options.anki, "猫"), false);
  await f.service.reconcile();
  assert.equal(f.refreshes.length, 2);
});

test("endpoint changes make the old collection ineligible before the replacement refresh completes", async () => {
  const f = fixture();
  await f.service.reconcile();
  assert.equal(await f.service.has(f.options.anki, "猫"), true);
  const next = { ...f.options.anki, url: "http://127.0.0.1:9876" };
  const hold = f.hold();
  const change = f.change({ anki: next });
  while (f.refreshes.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.service.has(next, "猫"), false);
  f.setRows([["犬", true, [15]]]);
  hold.resolve();
  await change;
  assert.equal(await f.service.has(next, "犬"), true);
});
