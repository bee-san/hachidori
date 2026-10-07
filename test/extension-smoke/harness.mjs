/*
 * The smoke suite's checks on node:test.
 *
 * check(), equal(), pass() and fail() keep their former output and never stop a
 * block: a block is one node:test test that fails once any of its checks has
 * failed, and a block that throws fails alone while the run goes on. step()
 * registers one block of the shared engine scenario; when a name pattern skips
 * the earlier steps a selected step depends on, it runs them first.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { after, test as nodeTest } from "node:test";

let current = null;
const failedBlocks = [];
const stray = [];

// Called by fail(): a failed check fails the block that made it.
function attribute(what) {
  if (current) current.failures.push(what);
  else stray.push(what);
}

async function runBlock(context, name, fn) {
  const record = { failures: [] };
  current = record;
  console.log(`\n=== ${context.fullName}`);
  try {
    await fn();
  } catch (error) {
    failedBlocks.push(name);
    throw error;
  } finally {
    current = null;
  }
  if (record.failures.length) {
    failedBlocks.push(name);
    throw new Error(`${record.failures.length} check(s) failed: ${record.failures.join("; ")}`);
  }
}

// One block of checks.
function test(name, fn) {
  return nodeTest(name, (context) => runBlock(context, name, fn));
}

// One block of the engine scenario, which shares one engine and its state. When a name
// pattern leaves out earlier steps, the selected step runs them first, in order.
const steps = [];
function step(name, fn) {
  const entry = { name, fn, ran: false };
  steps.push(entry);
  return nodeTest(name, (context) => runBlock(context, name, async () => {
    for (const earlier of steps.slice(0, steps.indexOf(entry))) {
      if (earlier.ran) continue;
      earlier.ran = true;
      console.log(`\n=== ${context.fullName}: first the earlier step "${earlier.name}"`);
      try {
        await earlier.fn();
      } catch (error) {
        fail(`the earlier step "${earlier.name}" finished`, error?.stack ?? error);
      }
    }
    entry.ran = true;
    await fn();
  }));
}

let passed = 0;
let failed = 0;

function pass(what) {
  passed += 1;
  console.log(`  PASS  ${what}`);
}

function fail(what, detail) {
  failed += 1;
  attribute(what);
  console.log(`  FAIL  ${what}`);
  for (const line of String(detail).split("\n")) {
    console.log(`        ${line}`);
  }
}

function check(what, condition, detail = "") {
  if (condition) {
    pass(what);
  } else {
    fail(what, detail || "condition was false");
  }
}

function equal(what, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(what, a === b, `expected: ${b}\nactual:   ${a}`);
}

function section(name) {
  console.log(`\n# ${name}`);
}

after(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  for (const name of failedBlocks) console.log(`  failed: ${name}`);
  if (stray.length) throw new Error(`${stray.length} check(s) failed outside any block: ${stray.join("; ")}`);
});

// The code under test leaves timers behind (background.js's emulated alarms), so the
// former script ended with process.exit(). Once every block has run, exit the same way;
// this timer cannot keep the process alive on its own.
after(() => {
  setTimeout(() => process.exit(failedBlocks.length || stray.length ? 1 : 0), 1000).unref();
});

export { check, equal, fail, pass, section, step, test };
