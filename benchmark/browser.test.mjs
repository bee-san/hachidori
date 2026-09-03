// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  assertIdleContinuity,
  chromeArguments,
  closeBrowserVerified,
  verifyBrowserCleanupAfterFailure,
} from "./browser.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

test("closeBrowserVerified confirms exit and force-kills an unclosed browser", async () => {
  const cleanChild = new FakeChild();
  await closeBrowserVerified({
    process: () => cleanChild,
    close: async () => {
      cleanChild.exitCode = 0;
      cleanChild.emit("exit", 0, null);
    },
  }, [], 20);
  assert.deepEqual(cleanChild.kills, []);

  const stuckChild = new FakeChild();
  await assert.rejects(
    closeBrowserVerified({ process: () => stuckChild, close: async () => {} }, [], 5),
    /did not exit/i,
  );
  assert.deepEqual(stuckChild.kills, ["SIGKILL"]);

  const failedChild = new FakeChild();
  await assert.rejects(
    closeBrowserVerified({
      process: () => failedChild,
      close: async () => { throw new Error("close transport broke"); },
    }, [], 20),
    /close transport broke/i,
  );
  assert.deepEqual(failedChild.kills, ["SIGKILL"]);
});

test("closeBrowserVerified bounds a hung close before force-killing", async () => {
  const child = new FakeChild();
  const close = closeBrowserVerified({
    process: () => child,
    close: () => new Promise(() => {}),
  }, [], 5);
  const outcome = await Promise.race([
    close.then(() => "resolved", (error) => error),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
  ]);
  assert.notEqual(outcome, "hung");
  assert.match(outcome.message, /browser close.*timed out/i);
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("an import failure cannot remain expected when browser shutdown is unverified", async () => {
  const child = new FakeChild();
  child.kill = (signal) => {
    child.kills.push(signal);
    return false;
  };
  const importFailure = new Error("import failed: request too large");
  importFailure.benchmarkFailure = { phase: "import", origin: "extension" };
  await assert.rejects(
    verifyBrowserCleanupAfterFailure(
      { process: () => child, close: async () => { throw new Error("close transport broke"); } },
      [],
      importFailure,
      5,
    ),
    (error) => error.benchmarkFailure?.phase === "cleanup"
      && error.benchmarkFailure?.origin === "harness"
      && /shutdown could not be verified/i.test(error.message),
  );
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("assertIdleContinuity requires the same offscreen target and generation", () => {
  const evidence = {
    beforeStatus: { generation: 4 },
    afterStatus: { generation: 4 },
    beforeContextIds: ["offscreen-target"],
    afterContextIds: ["offscreen-target"],
    lookupGeneration: 4,
    lookupSignature: "lookup",
    expectedSignature: "lookup",
  };
  assert.doesNotThrow(() => assertIdleContinuity(evidence));
  assert.throws(
    () => assertIdleContinuity({ ...evidence, afterContextIds: ["replacement-target"] }),
    /offscreen.*identity/i,
  );
  assert.throws(
    () => assertIdleContinuity({ ...evidence, beforeContextIds: [null], afterContextIds: [null] }),
    /offscreen.*identity/i,
  );
  assert.throws(
    () => assertIdleContinuity({ ...evidence, lookupGeneration: 5 }),
    /generation/i,
  );
});

test("Chrome sandbox bypass is an explicit opt-in", () => {
  const definition = { runtime: { extensionPath: "/extension" } };
  assert.equal(chromeArguments(definition, { allowNoSandbox: false }).includes("--no-sandbox"), false);
  assert.equal(chromeArguments(definition, { allowNoSandbox: true }).includes("--no-sandbox"), true);
});
