// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBUG_LOG_LIMIT, DEBUG_LOG_MESSAGE_LIMIT, DEBUG_LOG_SESSION_KEY,
  captureDebugLog, captureWorkerDebugLog, readDebugLog, recordDebugFailure,
} from "../extension/debug-log.js";

function scope() {
  const printed = [];
  const listeners = {};
  return {
    printed, listeners,
    console: { warn: (...args) => printed.push(["warn", ...args]), error: (...args) => printed.push(["error", ...args]) },
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };
}

test("warnings, errors, uncaught failures and failed replies are kept and still printed", async () => {
  const global = scope();
  captureDebugLog(global, { context: "offscreen", now: () => 0 });
  global.console.warn("hoshidicts: direct OPFS is unavailable", { reason: "denied" });
  global.console.error(new Error("engine failed"));
  global.listeners.unhandledrejection({ reason: "lost reply" });
  recordDebugFailure(global, "hd_lookup", "the dictionary engine is still starting");
  const { context, entries } = await readDebugLog(global);
  assert.equal(context, "offscreen");
  assert.deepEqual(entries.map(entry => [entry.level, entry.message.split("\n")[0]]), [
    ["warn", 'hoshidicts: direct OPFS is unavailable {"reason":"denied"}'],
    ["error", "Error: engine failed"],
    ["unhandledrejection", "lost reply"],
    ["failed-request", "hd_lookup: the dictionary engine is still starting"],
  ]);
  assert.equal(entries[0].at, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(global.printed[0], ["warn", "hoshidicts: direct OPFS is unavailable", { reason: "denied" }]);
  assert.equal(captureDebugLog(global, { context: "again" }).context, "offscreen", "one capture per global");
});

test("the log keeps the newest entries and cuts long messages", async () => {
  const global = scope();
  captureDebugLog(global, { context: "engine-worker" });
  for (let index = 0; index < DEBUG_LOG_LIMIT + 5; index += 1) global.console.warn(`entry ${index}`);
  global.console.error("x".repeat(DEBUG_LOG_MESSAGE_LIMIT + 10));
  const { entries } = await readDebugLog(global);
  assert.equal(entries.length, DEBUG_LOG_LIMIT);
  assert.equal(entries[0].message, "entry 6");
  assert.equal(entries.at(-1).message.length, DEBUG_LOG_MESSAGE_LIMIT + 1);
});

test("a restarted service worker keeps the entries persisted before the restart", async () => {
  const stored = { [DEBUG_LOG_SESSION_KEY]: [{ at: "earlier", context: "service-worker", level: "warn", message: "before restart" }] };
  const session = { get: async () => structuredClone(stored), set: async (items) => Object.assign(stored, structuredClone(items)) };
  const global = scope();
  captureWorkerDebugLog(global, session);
  global.console.warn("after restart");
  const { entries } = await readDebugLog(global);
  assert.deepEqual(entries.map(entry => entry.message), ["before restart", "after restart"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stored[DEBUG_LOG_SESSION_KEY].map(entry => entry.message), ["before restart", "after restart"]);
});

test("a context without a capture reports an empty log", async () => {
  assert.deepEqual(await readDebugLog({}), { context: null, entries: [] });
  recordDebugFailure({}, "hd_status", "ignored");
});
