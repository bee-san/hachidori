import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_INSTALL_OPTIONS, SETUP_STAGES, advanceSetupState, initialSetupState, normaliseSetupState, setupIncomplete,
} from "../extension/setup-state.js";
import "../extension/reader-options.js";

test("a new installation starts at the dictionary stage and advances through revisioned stages", () => {
  const started = initialSetupState("2026-09-07T10:00:00.000Z");
  assert.deepEqual(started, {
    schemaVersion: 1, revision: 1, startedAt: "2026-09-07T10:00:00.000Z", stage: "dictionaries", completedAt: null,
  });
  assert.equal(setupIncomplete(started), true);
  const anki = advanceSetupState(started, "anki", "2026-09-07T10:01:00.000Z");
  assert.deepEqual(anki, { ...started, revision: 2, stage: "anki" });
  const complete = advanceSetupState(anki, "complete", "2026-09-07T10:02:00.000Z");
  assert.deepEqual(complete, { ...started, revision: 3, stage: "complete", completedAt: "2026-09-07T10:02:00.000Z" });
  assert.equal(setupIncomplete(complete), false);
  // Setup is monotonic: repeating a stage, returning to one, or reopening a
  // finished setup is refused even with the current revision.
  assert.throws(() => advanceSetupState(complete, "complete", "2026-09-07T10:03:00.000Z"), /backwards/u);
  assert.throws(() => advanceSetupState(anki, "dictionaries", "2026-09-07T10:03:00.000Z"), /backwards/u);
  assert.throws(() => advanceSetupState(complete, "practice", "2026-09-07T10:03:00.000Z"), /backwards/u);
  assert.throws(() => advanceSetupState(started, "lookup", "2026-09-07T10:02:00.000Z"), /invalid/u);
  assert.deepEqual(normaliseSetupState(complete), complete);
  assert.deepEqual(normaliseSetupState({ ...complete, extra: true }), complete);
});

test("absent state is null and malformed or unsupported state is refused", () => {
  assert.equal(normaliseSetupState(undefined), null);
  assert.equal(normaliseSetupState(null), null);
  assert.equal(setupIncomplete(null), false);
  const valid = initialSetupState("2026-09-07T10:00:00.000Z");
  assert.throws(() => normaliseSetupState({ ...valid, schemaVersion: 2 }), /unsupported setup state schema 2/u);
  for (const edit of [
    value => { value.revision = 0; },
    value => { value.revision = "1"; },
    value => { delete value.startedAt; },
    value => { value.stage = "done"; },
    value => { value.completedAt = 5; },
  ]) {
    const value = structuredClone(valid);
    edit(value);
    assert.throws(() => normaliseSetupState(value), /malformed/u);
  }
  assert.deepEqual(SETUP_STAGES, ["dictionaries", "anki", "practice", "complete"]);
});

test("first-install preferences are a valid options patch that leaves reader defaults untouched", () => {
  const { DEFAULT_OPTIONS, validateOptionsPatch } = globalThis.HDReaderOptions;
  assert.deepEqual(validateOptionsPatch(FIRST_INSTALL_OPTIONS), { ...FIRST_INSTALL_OPTIONS });
  assert.equal(DEFAULT_OPTIONS.showCompactDefinitionSummary, false);
  assert.equal(DEFAULT_OPTIONS.popupTheme, "default");
  assert.equal(DEFAULT_OPTIONS.popupOpacityPercent, 85);
  assert.equal(DEFAULT_OPTIONS.audioAutoplay, false);
  assert.deepEqual(DEFAULT_OPTIONS.audioSources.map(source => [source.type, source.enabled]), [["text-to-speech-reading", true]]);
});
