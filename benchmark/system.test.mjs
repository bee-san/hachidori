// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireFileLock,
  appendJsonlDurable,
  assertFileIdentity,
  createContentAddressedSnapshot,
  directoryContentSha256,
  persistThenCleanup,
  readJsonlRecoveringTail,
  sha256File,
  startDescendantProcessSampler,
  treeUsage,
  writeAllSync,
} from "./system.mjs";

test("post-persistence cleanup failure is reported without repeating persistence", () => {
  const errors = [];
  let persistenceCalls = 0;
  const cleaned = persistThenCleanup({
    persist: () => { persistenceCalls += 1; },
    cleanup: () => { throw new Error("synthetic cleanup failure"); },
    onCleanupError: (error) => errors.push(error.message),
  });
  assert.equal(cleaned, false);
  assert.equal(persistenceCalls, 1);
  assert.deepEqual(errors, ["synthetic cleanup failure"]);
  assert.equal(persistThenCleanup({
    persist: () => { persistenceCalls += 1; },
    cleanup: () => { throw new Error("second cleanup failure"); },
    onCleanupError: () => { throw new Error("reporting failure"); },
  }), false);
  assert.equal(persistenceCalls, 2);

  let cleanupCalls = 0;
  assert.throws(() => persistThenCleanup({
    persist: () => { throw new Error("synthetic persistence failure"); },
    cleanup: () => { cleanupCalls += 1; },
  }), /persistence failure/);
  assert.equal(cleanupCalls, 0);
});

test("sha256File and treeUsage account for durable regular files only", () => {
  const root = mkdtempSync(join(tmpdir(), "hdw-bench-system-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "a"), "abc");
    writeFileSync(join(root, "nested", "b"), "12345");
    symlinkSync(join(root, "a"), join(root, "link"));

    assert.equal(
      sha256File(join(root, "a")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const usage = treeUsage(root);
    assert.equal(usage.logicalBytes, 8);
    assert.equal(usage.fileCount, 2);
    assert.ok(usage.allocatedBytes >= 8);
    const contentHash = directoryContentSha256(root);
    writeFileSync(join(root, "nested", "b"), "changed");
    assert.notEqual(directoryContentSha256(root), contentHash);
    assert.equal(directoryContentSha256(root, { exclude: ["nested"] }), directoryContentSha256(root, { exclude: ["nested", "missing"] }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("content-addressed corpus snapshots preserve pinned bytes and detect mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "hdw-bench-snapshot-"));
  try {
    const source = join(root, "dictionary.zip");
    const snapshots = join(root, "snapshots");
    writeFileSync(source, "original archive bytes");
    const snapshot = createContentAddressedSnapshot(source, snapshots);
    assert.equal(readFileSync(snapshot.path, "utf8"), "original archive bytes");
    assert.doesNotThrow(() => assertFileIdentity(snapshot.path, snapshot));

    writeFileSync(source, "different archive bytes");
    assert.throws(() => assertFileIdentity(source, snapshot), /changed|identity|size|sha-256/i);
    assert.equal(readFileSync(snapshot.path, "utf8"), "original archive bytes");

    chmodSync(snapshot.path, 0o644);
    writeFileSync(snapshot.path, "mutated snapshot bytes");
    assert.throws(() => assertFileIdentity(snapshot.path, snapshot), /changed|identity|size|sha-256/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("writeAllSync retries short writes", () => {
  const chunks = [];
  const fakeWrite = (_descriptor, buffer, offset, length) => {
    const written = Math.min(2, length);
    chunks.push(buffer.subarray(offset, offset + written));
    return written;
  };
  assert.equal(writeAllSync(123, Buffer.from("abcdef"), fakeWrite), 6);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "abcdef");
});

test("durable JSONL append recovers only an unterminated final record", () => {
  const root = mkdtempSync(join(tmpdir(), "hdw-bench-jsonl-"));
  try {
    const path = join(root, "raw.jsonl");
    appendJsonlDurable(path, { runId: "a", value: 1 });
    appendJsonlDurable(path, { runId: "b", value: 2 });
    assert.deepEqual(readJsonlRecoveringTail(path), [
      { runId: "a", value: 1 },
      { runId: "b", value: 2 },
    ]);

    writeFileSync(path, `${readFileSync(path, "utf8")}{\"runId\":\"torn`);
    assert.deepEqual(readJsonlRecoveringTail(path), [
      { runId: "a", value: 1 },
      { runId: "b", value: 2 },
    ]);
    assert.match(readFileSync(path, "utf8"), /"runId":"b".*\n$/s);

    writeFileSync(path, "{\"runId\":\"a\"}\nnot-json\n{\"runId\":\"b\"}\n");
    assert.throws(() => readJsonlRecoveringTail(path), /invalid complete JSONL record 2/i);

    writeFileSync(path, "{\"runId\":\"a\"}\n\n{\"runId\":\"b\"}\n");
    assert.throws(() => readJsonlRecoveringTail(path), /blank complete JSONL record 2/i);

    writeFileSync(path, Buffer.concat([Buffer.from("{\"text\":\""), Buffer.from([0xff]), Buffer.from("\"}\n")]));
    assert.throws(() => readJsonlRecoveringTail(path), /utf-8/i);

    writeFileSync(path, Buffer.concat([Buffer.from("{\"runId\":\"a\"}\n{\"text\":\""), Buffer.from([0xe2, 0x82])]));
    assert.deepEqual(readJsonlRecoveringTail(path), [{ runId: "a" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file locks fail closed until released", () => {
  const root = mkdtempSync(join(tmpdir(), "hdw-bench-lock-"));
  try {
    const path = join(root, ".lock");
    const release = acquireFileLock(path, { owner: "first" });
    assert.throws(() => acquireFileLock(path, { owner: "second" }), /already locked/i);
    release();
    const releaseAgain = acquireFileLock(path, { owner: "third" });
    releaseAgain();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("descendant sampler starts before child launch and excludes the harness process", {
  skip: process.platform !== "linux" && "Process RSS and CPU sampling requires Linux /proc",
}, async () => {
  const sampler = startDescendantProcessSampler(process.pid, 5);
  const child = spawn(process.execPath, ["-e", "const end=Date.now()+120; while(Date.now()<end){}"]);
  await once(child, "exit");
  const sample = sampler.stop();
  assert.ok(sample.peakProcessCount >= 1);
  assert.ok(sample.peakRssBytes > 0);
  assert.ok(sample.processTreeCpuTicks > 0);
});
