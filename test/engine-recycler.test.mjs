// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createEngineRecycler, RECYCLE_IDLE_MS } from "../extension/engine-recycler.js";

// A manual clock: timers fire only when the test advances time.
function harness({ idle = true } = {}) {
  const timers = new Map();
  let now = 0;
  let nextId = 0;
  const state = { idle, restarts: [] };
  const recycler = createEngineRecycler({
    isIdle: () => state.idle,
    restart: (lowMemory) => {
      state.restarts.push({ lowMemory, at: now });
      recycler.setRunning(lowMemory);
    },
    setTimer: (fn, ms) => {
      nextId += 1;
      timers.set(nextId, { fn, due: now + ms });
      return nextId;
    },
    clearTimer: (id) => timers.delete(id),
  });
  state.advance = (ms) => {
    const target = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].due;
      next[1].fn();
    }
    now = target;
  };
  state.pendingTimers = () => timers.size;
  state.recycler = recycler;
  return state;
}

test("nothing happens while the mode is off and the worker matches", () => {
  const h = harness();
  h.recycler.setRunning(false);
  h.recycler.setDesired(false);
  h.recycler.noteMutationSettled();
  h.advance(RECYCLE_IDLE_MS * 3);
  assert.deepEqual(h.restarts, []);
  assert.equal(h.pendingTimers(), 0);
});

test("a mode mismatch restarts the worker once it has been idle for the window", () => {
  const h = harness();
  h.recycler.setRunning(false);
  h.recycler.setDesired(true);
  h.advance(RECYCLE_IDLE_MS - 1);
  assert.deepEqual(h.restarts, []);
  h.advance(1);
  assert.deepEqual(h.restarts, [{ lowMemory: true, at: RECYCLE_IDLE_MS }]);
  // The new worker matches; nothing more is scheduled.
  h.advance(RECYCLE_IDLE_MS * 2);
  assert.equal(h.restarts.length, 1);
  assert.equal(h.pendingTimers(), 0);
});

test("turning the mode off restarts a low-memory worker back to the full pool", () => {
  const h = harness();
  h.recycler.setRunning(true);
  h.recycler.setDesired(false);
  h.advance(RECYCLE_IDLE_MS);
  assert.deepEqual(h.restarts, [{ lowMemory: false, at: RECYCLE_IDLE_MS }]);
});

test("with the mode on, a settled mutation recycles the worker after the idle window", () => {
  const h = harness();
  h.recycler.setDesired(true);
  h.recycler.setRunning(true);
  h.advance(RECYCLE_IDLE_MS);
  assert.deepEqual(h.restarts, [], "a fresh matching worker is not recycled");
  h.recycler.noteMutationSettled();
  h.advance(RECYCLE_IDLE_MS);
  assert.deepEqual(h.restarts, [{ lowMemory: true, at: 2 * RECYCLE_IDLE_MS }]);
});

test("no restart while requests are in flight; the window restarts when they finish", () => {
  const h = harness({ idle: false });
  h.recycler.setDesired(true);
  h.recycler.setRunning(true);
  h.recycler.noteMutationSettled();
  h.advance(RECYCLE_IDLE_MS * 4);
  assert.deepEqual(h.restarts, [], "busy engines are never recycled");
  h.idle = true;
  h.recycler.noteIdle();
  h.advance(RECYCLE_IDLE_MS - 1);
  assert.deepEqual(h.restarts, []);
  h.advance(1);
  assert.equal(h.restarts.length, 1);
});

test("back-to-back mutations cause one restart, and a request resets the idle window", () => {
  const h = harness();
  h.recycler.setDesired(true);
  h.recycler.setRunning(true);
  h.recycler.noteMutationSettled();
  h.advance(RECYCLE_IDLE_MS / 2);
  h.recycler.noteMutationSettled();
  h.advance(RECYCLE_IDLE_MS / 2);
  h.recycler.noteIdle();
  h.advance(RECYCLE_IDLE_MS - 1);
  assert.deepEqual(h.restarts, [], "each completion restarts the window");
  h.advance(1);
  assert.equal(h.restarts.length, 1);
  h.advance(RECYCLE_IDLE_MS * 2);
  assert.equal(h.restarts.length, 1, "the recycled worker starts clean");
});

test("a mutation that settles between fire and the next worker is kept for that worker", () => {
  const h = harness();
  h.recycler.setDesired(true);
  h.recycler.setRunning(true);
  h.recycler.noteMutationSettled();
  h.advance(RECYCLE_IDLE_MS);
  assert.equal(h.restarts.length, 1);
  h.recycler.noteMutationSettled();
  h.advance(RECYCLE_IDLE_MS);
  assert.equal(h.restarts.length, 2);
});

test("nothing is scheduled before the owner reports a running worker", () => {
  const h = harness();
  h.recycler.setDesired(true);
  h.recycler.noteMutationSettled();
  h.advance(RECYCLE_IDLE_MS * 2);
  assert.deepEqual(h.restarts, []);
  h.recycler.setRunning(false);
  h.advance(RECYCLE_IDLE_MS);
  assert.deepEqual(h.restarts, [{ lowMemory: true, at: 3 * RECYCLE_IDLE_MS }]);
});
