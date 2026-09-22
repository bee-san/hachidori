import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_INSTALL_OPTIONS, FIRST_INSTALL_SELECTIONS, SETUP_ANKI_STATUSES, SETUP_STAGES, advanceSetupState, capabilityAnkiOptions, initialSetupState,
  normaliseSetupState, overlayAnkiOptions, recordSetupAnki, recordSetupDictionaries, setupIncomplete,
} from "../extension/setup-state.js";
import "../extension/reader-options.js";

test("overlay mining never takes a screenshot or records browser speech or captured media", () => {
  const template = globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE;
  const stored = globalThis.HDReaderOptions.normaliseOptions({
    anki: { templates: [
      { ...template, id: "default", name: "Words", captureScreenshot: true },
      { ...template, id: "sentence", name: "Sentences", captureScreenshot: true },
    ] },
    mediaCapture: { enabled: true },
    audioSources: [
      { id: "tts", type: "text-to-speech", enabled: true, url: "", voice: "" },
      { id: "reading", type: "text-to-speech-reading", enabled: true, url: "", voice: "" },
      { id: "jpod", type: "custom", enabled: true, url: "https://audio.test/%w", voice: "" },
    ],
  });
  const overlay = overlayAnkiOptions(stored);
  assert.equal(overlay.anki.captureScreenshot, false);
  assert.deepEqual(overlay.anki.templates.map(value => value.captureScreenshot), [false, false]);
  assert.equal(overlay.mediaCapture.enabled, false);
  assert.deepEqual(overlay.audioSources.map(source => source.id), ["jpod"]);
  assert.equal(stored.anki.captureScreenshot, true, "the stored options are not changed");
  assert.deepEqual(stored.anki.templates.map(value => value.captureScreenshot), [true, true]);
  assert.equal(stored.mediaCapture.enabled, true);
  assert.equal(stored.audioSources.length, 3);
});

test("Firefox mining projection preserves saved Chrome media settings", () => {
  const stored = globalThis.HDReaderOptions.normaliseOptions({
    anki: { captureScreenshot: true },
    mediaCapture: { enabled: true },
    audioSources: [
      { id: "tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" },
      { id: "remote", type: "custom", enabled: true, url: "https://audio.test/%w", voice: "" },
    ],
  });
  const firefox = capabilityAnkiOptions(stored, {
    screenshot: true,
    browserSpeech: false,
    mediaCapture: false,
  });
  assert.equal(firefox.anki.captureScreenshot, true);
  assert.equal(firefox.mediaCapture.enabled, false);
  assert.deepEqual(firefox.audioSources.map(source => source.id), ["remote"]);
  assert.equal(stored.mediaCapture.enabled, true);
  assert.deepEqual(stored.audioSources.map(source => source.id), ["tts", "remote"]);
});

const EMPTY_DICTIONARIES = { outcomes: {}, totalSeconds: null, continued: false, selectionsApplied: [], recordedRuns: [] };

test("a new installation starts at welcome and advances through revisioned stages", () => {
  const started = initialSetupState("2026-09-07T10:00:00.000Z");
  assert.deepEqual(started, {
    schemaVersion: 1, revision: 1, startedAt: "2026-09-07T10:00:00.000Z", stage: "welcome", completedAt: null,
    dictionaries: EMPTY_DICTIONARIES, anki: null,
  });
  assert.equal(setupIncomplete(started), true);
  const dictionaries = advanceSetupState(started, "dictionaries", "2026-09-07T10:00:30.000Z");
  assert.deepEqual(dictionaries, { ...started, revision: 2, stage: "dictionaries" });
  const anki = advanceSetupState(dictionaries, "anki", "2026-09-07T10:01:00.000Z");
  assert.deepEqual(anki, { ...started, revision: 3, stage: "anki" });
  const complete = advanceSetupState(anki, "complete", "2026-09-07T10:02:00.000Z");
  assert.deepEqual(complete, { ...started, revision: 4, stage: "complete", completedAt: "2026-09-07T10:02:00.000Z" });
  assert.equal(setupIncomplete(complete), false);
  // Setup is monotonic: repeating a stage, returning to one, or reopening a
  // finished setup is refused even with the current revision.
  assert.throws(() => advanceSetupState(complete, "complete", "2026-09-07T10:03:00.000Z"), /backwards/u);
  assert.throws(() => advanceSetupState(anki, "dictionaries", "2026-09-07T10:03:00.000Z"), /backwards/u);
  assert.throws(() => advanceSetupState(complete, "practice", "2026-09-07T10:03:00.000Z"), /backwards/u);
  assert.throws(() => advanceSetupState(started, "lookup", "2026-09-07T10:02:00.000Z"), /invalid/u);
  assert.deepEqual(normaliseSetupState(complete), complete);
  assert.deepEqual(normaliseSetupState({ ...complete, extra: true }), complete);
  // A record written before dictionary outcomes existed reads as an empty stage.
  const { dictionaries: _dictionaries, anki: _anki, ...legacy } = started;
  assert.deepEqual(normaliseSetupState({ ...legacy, stage: "dictionaries" }), { ...started, stage: "dictionaries" });
});

test("the Anki outcome settles once with its status, reason and exact configured names", () => {
  const started = initialSetupState("2026-09-07T10:00:00.000Z");
  const configured = recordSetupAnki(started, { status: "configured", detail: null, model: "Kiku v2", deck: "Mining::Words" });
  assert.equal(configured.revision, 2);
  assert.deepEqual(configured.anki, { status: "configured", detail: null, model: "Kiku v2", deck: "Mining::Words" });
  assert.deepEqual(normaliseSetupState(configured), configured);
  const absent = recordSetupAnki(started, { status: "unavailable", detail: "Open Anki with the AnkiConnect add-on installed, then retry.", model: "ignored", deck: null });
  assert.deepEqual(absent.anki, { status: "unavailable", detail: "Open Anki with the AnkiConnect add-on installed, then retry.", model: null, deck: null });
  assert.deepEqual(recordSetupAnki(started, { status: "needs-attention", detail: "Two note types share the highest note count.", model: null, deck: null }).anki.model, null);
  // A configured outcome carries no reason text, so no view can render one.
  assert.equal(recordSetupAnki(started, { status: "configured", detail: "ignored", model: "Kiku", deck: "Mining" }).anki.detail, null);
  assert.deepEqual(SETUP_ANKI_STATUSES, ["configured", "already-configured", "unavailable", "needs-attention"]);
  // A status that needs a reason cannot settle without one.
  for (const outcome of [null, { status: "done" }, { status: "configured", detail: null, model: null, deck: "Mining" },
    { status: "already-configured", detail: null, model: "Kiku", deck: null }, { status: "unavailable", detail: 5, model: null, deck: null },
    { status: "unavailable", detail: null, model: null, deck: null }, { status: "needs-attention", detail: "", model: null, deck: null }]) {
    assert.throws(() => recordSetupAnki(started, outcome), /malformed/u);
  }
  assert.throws(() => normaliseSetupState({ ...started, anki: { status: "later" } }), /malformed/u);
});

test("dictionary outcomes accumulate across runs and continuing records an incomplete set", () => {
  const started = { ...initialSetupState("2026-09-07T10:00:00.000Z"), stage: "dictionaries" };
  const first = recordSetupDictionaries(started, {
    runId: "run-1",
    outcomes: { jitendex: { status: "installed", seconds: 12.5 }, jmnedict: { status: "failed", seconds: 3, error: "HTTP 503" } },
  });
  assert.equal(first.revision, 2);
  assert.deepEqual(first.dictionaries.outcomes, {
    jitendex: { status: "installed", seconds: 12.5, error: null },
    jmnedict: { status: "failed", seconds: 3, error: "HTTP 503" },
  });
  assert.equal(first.dictionaries.totalSeconds, null);
  assert.deepEqual(first.dictionaries.recordedRuns, []);
  const run = recordSetupDictionaries(first, { runId: "run-1", runSeconds: 16.25, selectionsApplied: ["jitendex"] });
  assert.equal(run.dictionaries.totalSeconds, 16.25);
  assert.deepEqual(run.dictionaries.selectionsApplied, ["jitendex"]);
  assert.deepEqual(run.dictionaries.recordedRuns, ["run-1"]);
  // A resent record for a run whose duration already landed changes nothing but the revision.
  const resent = recordSetupDictionaries(run, { runId: "run-1", runSeconds: 16.25 });
  assert.equal(resent.dictionaries.totalSeconds, 16.25);
  assert.deepEqual(resent.dictionaries.recordedRuns, ["run-1"]);
  const retry = recordSetupDictionaries(run, {
    runId: "run-2",
    outcomes: { jmnedict: { status: "installed", seconds: 4 }, jiten: { status: "already-installed", seconds: 9, error: "ignored" } },
    runSeconds: 4.5, selectionsApplied: ["jitendex"],
  });
  assert.equal(retry.revision, 4);
  assert.deepEqual(retry.dictionaries.outcomes.jmnedict, { status: "installed", seconds: 4, error: null });
  assert.deepEqual(retry.dictionaries.outcomes.jiten, { status: "already-installed", seconds: null, error: null });
  assert.equal(retry.dictionaries.totalSeconds, 20.75);
  assert.deepEqual(retry.dictionaries.selectionsApplied, ["jitendex"]);
  assert.deepEqual(retry.dictionaries.recordedRuns, ["run-1", "run-2"]);
  assert.deepEqual(normaliseSetupState(retry), retry);
  // An outcome keyed by a source the catalogue has since dropped is kept as recorded.
  const retired = recordSetupDictionaries(retry, { runId: "run-3", outcomes: { "sankoku8-eng": { status: "already-installed" } } });
  assert.deepEqual(normaliseSetupState(retired).dictionaries.outcomes["sankoku8-eng"], { status: "already-installed", seconds: null, error: null });
  assert.throws(() => recordSetupDictionaries(retry, { runId: "run-3", outcomes: { jitendex: { status: "done" } } }), /malformed/u);
  assert.throws(() => recordSetupDictionaries(retry, { runId: "run-3", runSeconds: -1 }), /invalid/u);
  assert.throws(() => recordSetupDictionaries(retry, { runId: "run-3", selectionsApplied: ["jiten"] }), /unknown/u);
  assert.throws(() => recordSetupDictionaries(retry, { runSeconds: 1 }), /names no run/u);
  const continued = advanceSetupState(retry, "anki", "2026-09-07T10:01:00.000Z", { continued: true });
  assert.equal(continued.dictionaries.continued, true);
  assert.equal(advanceSetupState(retry, "anki", "2026-09-07T10:01:00.000Z").dictionaries.continued, false);
  // Continuing only describes the dictionary stage.
  assert.equal(advanceSetupState(continued, "practice", "2026-09-07T10:02:00.000Z", { continued: true }).dictionaries.continued, true);
  assert.equal(advanceSetupState(advanceSetupState(retry, "anki", "x"), "practice", "y", { continued: true }).dictionaries.continued, false);
  assert.deepEqual(Object.keys(FIRST_INSTALL_SELECTIONS), ["jitendex", "bees-ultimate-kanji-dictionary"]);
  assert.equal(FIRST_INSTALL_SELECTIONS.jitendex.select("Jitendex.org [2026-08-11]"), "Jitendex.org [2026-08-11]");
  assert.deepEqual(FIRST_INSTALL_SELECTIONS["bees-ultimate-kanji-dictionary"].select("Bee's Ultimate Kanji Dictionary"),
    { title: "Bee's Ultimate Kanji Dictionary", kind: "term" });
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
    value => { value.dictionaries = []; },
    value => { value.dictionaries.outcomes = null; },
    value => { value.dictionaries.outcomes = { jitendex: { status: "installed", seconds: -2 } }; },
    value => { value.dictionaries.totalSeconds = "3"; },
    value => { value.dictionaries.continued = "yes"; },
    value => { value.dictionaries.selectionsApplied = ["jiten"]; },
    value => { value.dictionaries.recordedRuns = [""]; },
    value => { delete value.dictionaries.recordedRuns; },
  ]) {
    const value = structuredClone(valid);
    edit(value);
    assert.throws(() => normaliseSetupState(value), /malformed/u);
  }
  assert.deepEqual(SETUP_STAGES, ["welcome", "dictionaries", "anki", "practice", "complete"]);
});

test("first-install preferences are a valid options patch that leaves reader defaults untouched", () => {
  const { DEFAULT_OPTIONS, normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
  assert.deepEqual(validateOptionsPatch(FIRST_INSTALL_OPTIONS), { ...FIRST_INSTALL_OPTIONS });
  assert.equal(FIRST_INSTALL_OPTIONS.popupTheme, "auto");
  assert.equal(DEFAULT_OPTIONS.showCompactDefinitionSummary, false);
  assert.equal(DEFAULT_OPTIONS.popupTheme, "default");
  assert.equal(normaliseOptions({}).popupTheme, "default");
  assert.deepEqual(["default", "light", "dark", "dracula"].map(popupTheme =>
    normaliseOptions({ popupTheme }).popupTheme), ["default", "light", "dark", "dracula"]);
  assert.equal(DEFAULT_OPTIONS.popupOpacityPercent, 85);
  assert.equal(DEFAULT_OPTIONS.audioAutoplay, false);
  assert.deepEqual(DEFAULT_OPTIONS.audioSources.map(source => [source.type, source.enabled]), [["text-to-speech-reading", true]]);
});
