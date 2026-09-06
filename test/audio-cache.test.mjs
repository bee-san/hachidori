// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAudioCache } from "../extension/audio-cache.js";

test("audio retention obeys byte/count LRU bounds and expires without refreshing its TTL on reads", () => {
  let now = 0;
  const evicted = [];
  const cache = createAudioCache({ maxEntries: 2, maxBytes: 5, ttlMs: 10, now: () => now,
    onEvict: value => evicted.push(value) });
  cache.set("a", "A", 2);
  cache.set("b", "B", 2);
  assert.equal(cache.get("a"), "A");
  cache.set("c", "C", 2);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(evicted, ["B"]);
  now = 9;
  assert.equal(cache.get("a"), "A");
  now = 10;
  assert.equal(cache.get("a"), undefined);
  assert.deepEqual(evicted, ["B", "A"]);
  cache.set("d", "D", 4);
  assert.deepEqual(evicted, ["B", "A", "C"]);
  cache.clear();
  assert.equal(cache.get("d"), undefined);
  assert.deepEqual(evicted, ["B", "A", "C", "D"]);
});

test("oversized audio values bypass retention rather than rejecting playback or leaving an older cached value", () => {
  const evicted = [];
  const cache = createAudioCache({ maxEntries: 2, maxBytes: 5, ttlMs: 10,
    onEvict: value => evicted.push(value) });
  assert.equal(cache.set("url", "old", 2), true);
  assert.equal(cache.set("url", "larger", 6), false);
  assert.equal(cache.get("url"), undefined);
  assert.deepEqual(evicted, ["old"]);
  assert.equal(cache.set("other", "current", 5), true);
  assert.equal(cache.get("other"), "current");
});
