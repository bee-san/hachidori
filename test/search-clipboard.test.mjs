// SPDX-License-Identifier: GPL-3.0-or-later
// The search page's clipboard monitor (#639): Yomitan's ClipboardMonitor
// polling, with the reads and the timer driven by the test.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIPBOARD_POLL_MS, CLIPBOARD_SEARCH_LENGTH, clipboardSearchText, createClipboardMonitor,
} from "../extension/search-clipboard.js";

// A timer the test fires itself, and reads that answer in the order given.
function harness(answers) {
  const reads = [...answers];
  const changes = [];
  const timer = { next: null, delay: null };
  const scope = {
    setTimeout(callback, delay) {
      Object.assign(timer, { next: callback, delay });
      return 1;
    },
    clearTimeout() {
      Object.assign(timer, { next: null, delay: null });
    },
  };
  let pending = null;
  const read = () => {
    const answer = reads.shift();
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === "hold") return new Promise(resolve => { pending = resolve; });
    return Promise.resolve(answer);
  };
  const monitor = createClipboardMonitor({ read, change: text => changes.push(text), scope });
  // Lets the read in flight settle, then starts the next one.
  const settle = () => new Promise(resolve => { setImmediate(resolve); });
  async function tick() {
    const next = timer.next;
    assert.ok(next, "a read is scheduled");
    timer.next = null;
    next();
    await settle();
  }
  return { monitor, changes, timer, reads, tick, settle, release: text => pending(text) };
}

test("the first read is where the monitor starts; each new text after it is reported once, trimmed", async () => {
  const { monitor, changes, timer, reads, tick, settle } = harness([
    "食べたかった", " 食べたかった\n", "", "  ", new Error("no clipboard access"), 42, "読む", "読む ", "\t食べる",
  ]);
  monitor.start();
  await settle();
  assert.deepEqual(changes, [], "what was on the clipboard before is not searched");
  assert.equal(timer.delay, CLIPBOARD_POLL_MS);
  assert.equal(CLIPBOARD_POLL_MS, 250, "Yomitan's interval");
  for (let index = 0; index < 8; index += 1) await tick();
  assert.deepEqual(changes, ["読む", "食べる"], "repeats, blanks, failures and non-text are not reported");
  assert.equal(reads.length, 0);
  assert.equal(monitor.running, true);
});

test("stop() ends polling and drops a read in flight; start() begins again from the clipboard as it is", async () => {
  const { monitor, changes, timer, tick, settle, release } = harness(["読む", "hold", "食べる", "食べる", "漢字"]);
  monitor.start();
  await settle();
  await tick();
  monitor.stop();
  release("聞く");
  await settle();
  assert.equal(monitor.running, false);
  assert.equal(timer.next, null, "nothing more is read");
  assert.deepEqual(changes, [], "the read that ended after stop() is dropped");
  monitor.start();
  await settle();
  await tick();
  assert.deepEqual(changes, [], "a restart takes the clipboard's text as where it starts");
  await tick();
  assert.deepEqual(changes, ["漢字"]);
});

test("a copy longer than Yomitan's 1,000 characters is searched from its start, without splitting a character", () => {
  assert.equal(CLIPBOARD_SEARCH_LENGTH, 1000, "Yomitan's default clipboard.maximumSearchLength");
  assert.equal(clipboardSearchText("食べたかった"), "食べたかった");
  const exact = "あ".repeat(1000);
  assert.equal(clipboardSearchText(exact), exact);
  assert.equal(clipboardSearchText(`${"あ".repeat(1000)}い`), exact);
  // 𠮷 is two UTF-16 code units; one at the edge is left out whole rather than halved.
  const edge = `${"あ".repeat(999)}𠮷${"あ".repeat(10)}`;
  assert.equal(clipboardSearchText(edge), "あ".repeat(999));
  assert.equal(clipboardSearchText(`${"あ".repeat(998)}𠮷あ`), `${"あ".repeat(998)}𠮷`);
  // The 1,000 characters start after the copy's leading spaces, as Yomitan cuts the trimmed text.
  assert.equal(clipboardSearchText(`${" \n\u3000".repeat(700)}読む`), "読む");
  assert.equal(clipboardSearchText(`\u3000${"あ".repeat(1200)}`), "あ".repeat(1000));
});
