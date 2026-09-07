// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  createCaptureTimeline,
  normaliseCaptureText,
  resolveCaptureInterval,
} from "../extension/capture-timeline.js";

const record = (patch = {}) => ({
  sourceKind: "dom",
  sourceId: "tab:1",
  sourceEpoch: "document:1",
  occurrenceId: "line:1",
  text: "  猫 は\u3099 いる ",
  startMs: 1000,
  ...patch,
});

test("capture text normalization is modest NFC plus whitespace normalization", () => {
  assert.equal(normaliseCaptureText("  猫\nは\u3099\tいる。 "), "猫 ば いる。");
  assert.notEqual(normaliseCaptureText("猫、いる"), normaliseCaptureText("猫いる"));
});

test("timeline revisions preserve onset while repeated occurrences remain distinct", () => {
  const timeline = createCaptureTimeline();
  timeline.begin(record());
  timeline.begin(record({ text: "猫 ば いるよ", startMs: 2000 }));
  timeline.begin(record({ occurrenceId: "line:2", startMs: 2500 }));
  const values = timeline.snapshot();
  assert.equal(values.length, 2);
  assert.equal(values[0].startMs, 1000);
  assert.equal(values[0].text, "猫 ば いるよ");
  assert.equal(values[1].startMs, 2500);
  assert.deepEqual(timeline.close(values[0], 3000).endMs, 3000);
  assert.equal(timeline.close(values[0], 4000), null);
});

test("timeline enforces identity, text bounds, monotonic closes and record caps", () => {
  const timeline = createCaptureTimeline({ limit: 2, textLimit: 8 });
  assert.throws(() => timeline.begin(record({ sourceId: "" })), /identity/u);
  assert.throws(() => timeline.begin(record({ text: "123456789" })), /at most/u);
  timeline.begin(record({ text: "one", occurrenceId: "1" }));
  assert.throws(() => timeline.close(record({ occurrenceId: "1" }), 999), /precedes/u);
  timeline.begin(record({ text: "two", occurrenceId: "2" }));
  timeline.begin(record({ text: "three", occurrenceId: "3" }));
  assert.deepEqual(timeline.snapshot().map(value => value.occurrenceId), ["2", "3"]);
});

test("lookup timing follows texthooker, cue, DOM, then recent priority with source-specific offsets", () => {
  const records = [
    record({ sourceKind: "dom", occurrenceId: "dom", text: "猫", startMs: 3000 }),
    record({ sourceKind: "cue", occurrenceId: "cue", text: "猫", startMs: 2500 }),
    record({ sourceKind: "texthooker", sourceId: "ws", sourceEpoch: "connection:1",
      occurrenceId: "ws", text: "猫", startMs: 2000 }),
  ];
  const common = { records, lookupText: "猫", lookupTimeMs: 4000, availableStartMs: 0,
    clipSeconds: 5, estimatedOffsetMs: -500 };
  assert.deepEqual(resolveCaptureInterval({ ...common, texthookerActive: true }), {
    sourceKind: "texthooker", sourceLabel: "Texthooker estimate", occurrenceId: "ws",
    startMs: 1500, endMs: 6500, pendingTail: true,
  });
  assert.equal(resolveCaptureInterval({ ...common, texthookerActive: false }).sourceKind, "cue");
  assert.equal(resolveCaptureInterval({ ...common, timingMode: "page", texthookerActive: true }).sourceKind, "cue");
  assert.deepEqual(resolveCaptureInterval({ ...common, timingMode: "recent", availableStartMs: 2000 }), {
    sourceKind: "recent", sourceLabel: "Recent clip", occurrenceId: "",
    startMs: 2000, endMs: 4000, pendingTail: false, partial: true,
  });
});

test("unknown onsets, duplicate ambiguity and evicted starts fall through conservatively", () => {
  const duplicate = record({ sourceKind: "cue", occurrenceId: "one", text: "猫", onsetKnown: true });
  const records = [duplicate, { ...duplicate, occurrenceId: "two" },
    record({ occurrenceId: "dom", text: "猫", onsetKnown: false })];
  const result = resolveCaptureInterval({ records, lookupText: "猫", lookupTimeMs: 1500,
    availableStartMs: 1200, clipSeconds: 5, texthookerActive: false });
  assert.equal(result.sourceKind, "recent");
  assert.equal(result.partial, true);
  assert.equal(resolveCaptureInterval({ records: [duplicate], lookupText: "猫", occurrenceId: "one",
    lookupTimeMs: 1500, availableStartMs: 1100, clipSeconds: 5, texthookerActive: false }).sourceKind, "recent");
});
