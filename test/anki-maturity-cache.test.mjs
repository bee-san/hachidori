// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { ANKI_MATURITY_ALARM, ANKI_MATURITY_REFRESH_MS, ankiMaturityConfigurationChange, createAnkiMaturityCache } from "../extension/anki-maturity-cache.js";
import { createAnkiOffscreenService } from "../extension/anki-offscreen.js";
import { fetchAnkiMatureWords } from "../extension/anki-maturity.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";

const copy = value => structuredClone(value);
const note = word => ({ noteId: 1, modelName: "Japanese", fields: { Expression: { value: word } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("the production worker reads only the local cache when its Anki criterion is enabled", async () => {
  let enabled = true, reads = 0;
  const service = createAnkiWorkerService({
    gateway: { invoke() { throw new Error("A lookup must not call Anki"); } },
    readOptions: async () => ({ definitionBlurAnkiMature: enabled, anki: { model: "Japanese" } }),
    maturityCache: { async has(config, expression) {
      reads++; assert.equal(config.model, "Japanese"); return expression === "猫";
    } },
  });
  assert.deepEqual(await service.maturity({ term: { expression: "猫" } }), { mature: true });
  assert.deepEqual(await service.maturity({ term: { expression: "犬" } }), { mature: false });
  enabled = false;
  assert.deepEqual(await service.maturity({ term: { expression: "猫" } }), { mature: false });
  assert.equal(reads, 2);
});

function fixture(saved) {
  let options = globalThis.HDReaderOptions.normaliseOptions({ definitionBlurAnkiMature: true,
    anki: { model: "Japanese", fields: { expression: "Expression" } } });
  let state = copy(saved), clock = 1_800_000, answer = [note("猫")], failure = null, held = null, writeFailure = false;
  let storageTail = Promise.resolve(), writing = false;
  const calls = [], alarms = new Map();
  const dependencies = {
    fetchWords: source => fetchAnkiMatureWords({ async invoke(...args) {
      assert.equal(writing, false, "network must run outside the storage queue");
      calls.push(args);
      if (held) { const pending = held; held = null; await pending.promise; }
      if (failure) throw failure;
      return copy(answer);
    } }, source),
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
        } finally { writing = false; }
      });
      storageTail = run.catch(() => {});
      return run;
    },
    alarms: { get: async name => copy(alarms.get(name)), clear: async name => alarms.delete(name),
      create: async (name, value) => { alarms.set(name, { name, scheduledTime: value.when }); } },
    now: () => clock, reportError() {},
  };
  const service = createAnkiMaturityCache(dependencies);
  return { service, calls, alarms, dependencies, get state() { return copy(state); }, get options() { return copy(options); },
    setAnswer(value) { answer = value; }, fail(value = new Error("Anki closed")) { failure = value; },
    failWrites(value) { writeFailure = value; }, hold() { return held = deferred(); },
    due() { clock += ANKI_MATURITY_REFRESH_MS; },
    async change(patch, notify = true) {
      const commit = storageTail.then(async () => {
        const nextOptions = globalThis.HDReaderOptions.normaliseOptions({ ...options, ...patch });
        const nextState = await ankiMaturityConfigurationChange(options, nextOptions, copy(state));
        options = nextOptions;
        if (nextState !== undefined) state = copy(nextState);
      });
      storageTail = commit.catch(() => {});
      await commit;
      if (notify) return service.reconcile();
    },
  };
}

test("cold lookups fail open; one background pull serves repeated warm lookups and persists a 30-minute attempt", async () => {
  const f = fixture(), hold = f.hold();
  const refresh = f.service.reconcile();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.service.has(f.options.anki, "猫"), false);
  assert.equal(f.calls.length, 1);
  hold.resolve(); await refresh;
  for (let i = 0; i < 5; i++) assert.equal(await f.service.has(f.options.anki, "猫"), true);
  assert.equal(await f.service.has(f.options.anki, "犬"), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.alarms.get(ANKI_MATURITY_ALARM).scheduledTime, 3_600_000);
  assert.equal(f.state.snapshot.refreshedAt, 1_800_000);
  assert.equal(f.state.attempt.startedAt, 1_800_000);
});

test("refreshes retain the previous snapshot until a complete success, including a valid empty collection", async () => {
  const f = fixture(); await f.service.reconcile(); f.due();
  const hold = f.hold(), refresh = f.service.reconcile();
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.service.has(f.options.anki, "猫"), true);
  f.setAnswer([note("犬")]); hold.resolve(); await refresh;
  assert.equal(await f.service.has(f.options.anki, "猫"), false);
  assert.equal(await f.service.has(f.options.anki, "犬"), true);
  f.due(); f.setAnswer([]); await f.service.reconcile();
  assert.deepEqual(f.state.snapshot.words, []);
  assert.equal(await f.service.has(f.options.anki, "犬"), false);
});

test("offline and malformed refreshes retain the last snapshot and do not retry on worker restarts", async () => {
  const f = fixture(); await f.service.reconcile(); const original = f.state.snapshot;
  f.due(); f.fail(); await f.service.reconcile();
  assert.deepEqual(f.state.snapshot, original);
  f.alarms.clear();
  const restarted = createAnkiMaturityCache(f.dependencies);
  await restarted.reconcile();
  assert.equal(await restarted.has(f.options.anki, "猫"), true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.alarms.get(ANKI_MATURITY_ALARM).scheduledTime, 5_400_000);
  f.fail(null); f.due(); f.setAnswer([{}]); await restarted.reconcile();
  assert.deepEqual(f.state.snapshot, original);
});

test("concurrent triggers share one refresh; unrelated Anki settings do not invalidate it", async () => {
  const f = fixture(), hold = f.hold();
  const a = f.service.reconcile(), b = f.service.reconcile();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.change({ anki: { ...f.options.anki, deck: "Another deck", tags: ["new-tag"] } }, false);
  hold.resolve(); await Promise.all([a, b]);
  assert.equal(f.calls.length, 1);
  assert.equal(await f.service.has(f.options.anki, "猫"), true);
});

test("disabling cancels publication and alarms; re-enabling refreshes immediately", async () => {
  const f = fixture(); await f.service.reconcile(); f.due();
  const hold = f.hold(), refresh = f.service.reconcile();
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  await f.change({ definitionBlurAnkiMature: false });
  assert.equal(f.alarms.has(ANKI_MATURITY_ALARM), false);
  f.setAnswer([note("犬")]); hold.resolve(); await refresh;
  assert.deepEqual(f.state.snapshot.words, ["猫"]);
  await f.change({ definitionBlurAnkiMature: true });
  assert.equal(await f.service.has(f.options.anki, "犬"), true);
  assert.equal(f.calls.length, 3);
});

test("a changed source cannot read or publish the old source snapshot", async () => {
  const f = fixture(); await f.service.reconcile(); f.due();
  const hold = f.hold(), refresh = f.service.reconcile();
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  const change = f.change({ anki: { ...f.options.anki, apiKey: "new-key" } });
  assert.equal(await f.service.has({ ...f.options.anki, apiKey: "new-key" }, "猫"), false);
  f.fail(); hold.resolve(); await Promise.all([refresh, change]);
  await f.service.reconcile();
  assert.equal(await f.service.has(f.options.anki, "猫"), false);
  assert.equal(f.calls.at(-1)[2], "new-key");
});

test("failed persistence does not publish an uncommitted snapshot", async () => {
  const f = fixture(); await f.service.reconcile(); const original = f.state.snapshot; f.due();
  const hold = f.hold(), refresh = f.service.reconcile();
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  f.setAnswer([note("犬")]); f.failWrites(true); hold.resolve(); await refresh;
  assert.deepEqual(f.state.snapshot, original);
  assert.equal(await f.service.has(f.options.anki, "猫"), true);
  assert.equal(await f.service.has(f.options.anki, "犬"), false);
});


test("a delayed options event does not discard or repeat a refresh already started for the new configuration", async () => {
  const f = fixture();
  await f.change({ definitionBlurAnkiMature: false }, false);
  await f.change({ definitionBlurAnkiMature: true }, false);
  const hold = f.hold(), startup = f.service.reconcile();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  const started = f.state;
  const delayedEnableEvent = f.service.reconcile();
  hold.resolve();
  await Promise.all([startup, delayedEnableEvent]);
  await f.service.reconcile();
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.configurationRevision, started.configurationRevision);
  assert.deepEqual(f.state.attempt, started.attempt);
  assert.equal(await f.service.has(f.options.anki, "猫"), true);
});

test("an off/on configuration commit rejects the original pending response before either options event arrives", async () => {
  const f = fixture(); await f.service.reconcile();
  const original = f.state.snapshot;
  f.due();
  const hold = f.hold(), refresh = f.service.reconcile();
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  const initialRevision = f.state.configurationRevision;
  await f.change({ definitionBlurAnkiMature: false }, false);
  await f.change({ definitionBlurAnkiMature: true }, false);
  assert.equal(f.state.configurationRevision, initialRevision + 2);
  assert.equal(f.state.attempt, null);
  f.setAnswer([note("犬")]);
  const replacementHold = f.hold();
  hold.resolve(); await refresh;
  while (f.calls.length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.state.snapshot, original);
  assert.equal(await f.service.has(f.options.anki, "犬"), false);
  const delayedEvents = Promise.all([f.service.reconcile(), f.service.reconcile()]);
  replacementHold.resolve(); await delayedEvents;
  assert.equal(f.calls.length, 3);
  assert.equal(await f.service.has(f.options.anki, "犬"), true);
});


test("the offscreen refresh returns only words and terminates its worker after success or failure", async () => {
  const source = { model: "Japanese", fields: ["expression"], apiKey: "fixture-key" };
  for (const outcome of [{ words: ["猫"] }, { error: "Anki closed" }, { workerError: "Worker failed" }]) {
    let terminated = false;
    const service = createAnkiOffscreenService({ Worker: class {
      constructor(url, options) {
        assert.ok(url.pathname.endsWith("/anki-maturity-worker.js"));
        assert.deepEqual(options, { type: "module" });
      }
      postMessage(value) {
        assert.equal(value, source);
        if (outcome.workerError) this.onerror({ message: outcome.workerError });
        else this.onmessage({ data: outcome });
      }
      terminate() { terminated = true; }
    } });
    const request = service({ type: "hd_anki_maturity_refresh", source });
    if (outcome.words) assert.deepEqual(await request, outcome);
    else await assert.rejects(request, new RegExp(outcome.error || outcome.workerError));
    assert.equal(terminated, true);
  }
});
