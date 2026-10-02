// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

const { DEFAULT_OPTIONS, DEFINITION_LOOKUP_MODES, KEYBIND_TOGGLE_OPTIONS, normaliseKanjiSelection, normaliseOptions,
  projectStoredOptions, resolveKanjiDictionary, validateOptionsPatch } = globalThis.HDReaderOptions;

function dictionary(id, title, counts = {}) {
  return { id, title, enabled: true, termCount: 0, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, ...counts };
}

const dictionaries = [
  dictionary("kanjidic", "KANJIDIC", { kanjiCount: 1 }),
  dictionary("bees", "Bee's Kanji", { termCount: 1, frequencyCount: 1 }),
  dictionary("disabled", "Disabled kanji", { kanjiCount: 1, enabled: false }),
  dictionary("pitch", "Pitch only", { pitchCount: 1 }),
  dictionary("legacy", "Legacy counts"),
];
const groups = [
  { id: "g1", name: "Kanji", dictionaryIds: ["bees", "missing", "disabled", "pitch", "kanjidic", "legacy"] },
  { id: "empty", name: "Empty", dictionaryIds: ["pitch", "disabled"] },
];

test("a group reference round-trips through the clicked-kanji option", () => {
  const group = { kind: "tabGroup", id: "g1" };
  assert.deepEqual(normaliseKanjiSelection(group), group);
  assert.deepEqual(normaliseKanjiSelection({ ...group, ignored: true }), group, "unknown fields are dropped");
  assert.deepEqual(normaliseOptions({ kanjiClickDictionary: group }).kanjiClickDictionary, group);
  assert.deepEqual(validateOptionsPatch({ kanjiClickDictionary: group }), { kanjiClickDictionary: group });
  assert.deepEqual(normaliseKanjiSelection({ title: "KANJIDIC", kind: "kanji" }), { title: "KANJIDIC", kind: "kanji" },
    "dictionary selections are unchanged");
  assert.equal(normaliseKanjiSelection("KANJIDIC"), "KANJIDIC", "legacy titles are unchanged");
  for (const garbage of [{ kind: "tabGroup", id: "" }, { kind: "tabGroup", title: "g1" }, { kind: "tabGroup", id: 3 }]) {
    assert.equal(normaliseKanjiSelection(garbage), "", `garbage ${JSON.stringify(garbage)}`);
    assert.throws(() => validateOptionsPatch({ kanjiClickDictionary: garbage }), /invalid reader option/);
  }
});

test("a group resolves to its eligible members in group order with a kind per member", () => {
  assert.deepEqual(resolveKanjiDictionary({ kind: "tabGroup", id: "g1" }, dictionaries, groups), {
    kind: "group",
    members: [
      { kind: "term", title: "Bee's Kanji" },
      { kind: "kanji", title: "KANJIDIC" },
      { kind: "term", title: "Legacy counts" },
    ],
  }, "uninstalled, disabled and metadata-only members are skipped");
  assert.equal(resolveKanjiDictionary({ kind: "tabGroup", id: "empty" }, dictionaries, groups), null,
    "a group without an eligible member falls back to native kanji");
  assert.equal(resolveKanjiDictionary({ kind: "tabGroup", id: "gone" }, dictionaries, groups), null,
    "a removed group falls back to native kanji");
  assert.equal(resolveKanjiDictionary({ kind: "tabGroup", id: "g1" }, dictionaries), null,
    "callers without group state resolve no group");
});

test("dictionary selections still resolve to one capability", () => {
  assert.deepEqual(resolveKanjiDictionary({ title: "KANJIDIC", kind: "kanji" }, dictionaries, groups),
    { kind: "kanji", title: "KANJIDIC" });
  assert.deepEqual(resolveKanjiDictionary("Bee's Kanji", dictionaries, groups), { kind: "term", title: "Bee's Kanji" },
    "a legacy title infers its kind");
  assert.equal(resolveKanjiDictionary({ title: "Disabled kanji", kind: "kanji" }, dictionaries, groups), null);
  assert.equal(resolveKanjiDictionary({ title: "KANJIDIC", kind: "term" }, dictionaries, groups), null,
    "a requested kind the dictionary lacks is unavailable");
  assert.equal(resolveKanjiDictionary("", dictionaries, groups), null);
});

test("definition text follows the page lookup mode unless a child popup trigger is chosen", () => {
  assert.equal(DEFAULT_OPTIONS.definitionLookupMode, "inherit");
  assert.deepEqual(DEFINITION_LOOKUP_MODES, ["inherit", "activation", "click"]);
  assert.equal(normaliseOptions({}).definitionLookupMode, "inherit", "missing");
  for (const mode of DEFINITION_LOOKUP_MODES) {
    assert.equal(normaliseOptions({ definitionLookupMode: mode }).definitionLookupMode, mode);
    assert.deepEqual(validateOptionsPatch({ definitionLookupMode: mode }), { definitionLookupMode: mode });
  }
  for (const garbage of ["bogus", 3, null, "hover"]) {
    assert.equal(normaliseOptions({ definitionLookupMode: garbage }).definitionLookupMode, "inherit",
      `garbage ${JSON.stringify(garbage)}`);
    assert.throws(() => validateOptionsPatch({ definitionLookupMode: garbage }), /invalid reader option/);
  }
  assert.deepEqual(projectStoredOptions({ definitionLookupMode: "bogus" }), { definitionLookupMode: "inherit" },
    "stored garbage falls back to the default without throwing");
  assert.ok(!KEYBIND_TOGGLE_OPTIONS.includes("definitionLookupMode"), "not a boolean hotkey toggle");
});

test("the image hover preview defaults to large images and keeps only its three modes", () => {
  const { IMAGE_HOVER_PREVIEWS, DESIGN_OPTION_KEYS } = globalThis.HDReaderOptions;
  assert.equal(DEFAULT_OPTIONS.imageHoverPreview, "large");
  assert.deepEqual(IMAGE_HOVER_PREVIEWS, ["off", "large", "all"]);
  assert.equal(normaliseOptions({}).imageHoverPreview, "large", "missing");
  for (const mode of IMAGE_HOVER_PREVIEWS) {
    assert.equal(normaliseOptions({ imageHoverPreview: mode }).imageHoverPreview, mode);
    assert.deepEqual(validateOptionsPatch({ imageHoverPreview: mode }), { imageHoverPreview: mode });
  }
  for (const garbage of ["bogus", true, null, "Large"]) {
    assert.equal(normaliseOptions({ imageHoverPreview: garbage }).imageHoverPreview, "large",
      `garbage ${JSON.stringify(garbage)}`);
    assert.throws(() => validateOptionsPatch({ imageHoverPreview: garbage }), /invalid reader option/);
  }
  assert.deepEqual(projectStoredOptions({ imageHoverPreview: "bogus" }), { imageHoverPreview: "large" },
    "stored garbage falls back to the default without throwing");
  assert.ok(DESIGN_OPTION_KEYS.includes("imageHoverPreview"), "Design's reset restores it");
});

test("compact glossaries default off and keep only Yomitan's two popup layout values", () => {
  const { GLOSSARY_LAYOUT_MODES, DESIGN_OPTION_KEYS } = globalThis.HDReaderOptions;
  assert.equal(DEFAULT_OPTIONS.glossaryLayoutMode, "default");
  assert.deepEqual(GLOSSARY_LAYOUT_MODES, ["default", "compact"]);
  assert.equal(normaliseOptions({}).glossaryLayoutMode, "default", "missing");
  for (const mode of GLOSSARY_LAYOUT_MODES) {
    assert.equal(normaliseOptions({ glossaryLayoutMode: mode }).glossaryLayoutMode, mode);
    assert.deepEqual(validateOptionsPatch({ glossaryLayoutMode: mode }), { glossaryLayoutMode: mode });
  }
  for (const garbage of ["bogus", true, null, "Compact", "compact-popup-anki"]) {
    assert.equal(normaliseOptions({ glossaryLayoutMode: garbage }).glossaryLayoutMode, "default",
      `garbage ${JSON.stringify(garbage)}`);
    assert.throws(() => validateOptionsPatch({ glossaryLayoutMode: garbage }), /invalid reader option/);
  }
  assert.deepEqual(projectStoredOptions({ glossaryLayoutMode: "bogus" }), { glossaryLayoutMode: "default" },
    "stored garbage falls back to the default without throwing");
  assert.ok(DESIGN_OPTION_KEYS.includes("glossaryLayoutMode"), "Design's reset restores it");
  assert.ok(!KEYBIND_TOGGLE_OPTIONS.includes("glossaryLayoutMode"), "not a boolean hotkey toggle");
});

test("the furigana pitch style defaults to the contour and keeps only its two values", () => {
  const { PITCH_ACCENT_FURIGANA_STYLES, DESIGN_OPTION_KEYS } = globalThis.HDReaderOptions;
  assert.equal(DEFAULT_OPTIONS.pitchAccentFuriganaStyle, "contour");
  assert.deepEqual(PITCH_ACCENT_FURIGANA_STYLES, ["contour", "overline"]);
  assert.equal(normaliseOptions({}).pitchAccentFuriganaStyle, "contour", "missing");
  assert.deepEqual(validateOptionsPatch({ pitchAccentFuriganaStyle: "overline" }), { pitchAccentFuriganaStyle: "overline" });
  for (const garbage of ["bogus", true, null, "Overline"]) {
    assert.equal(normaliseOptions({ pitchAccentFuriganaStyle: garbage }).pitchAccentFuriganaStyle, "contour",
      `garbage ${JSON.stringify(garbage)}`);
    assert.throws(() => validateOptionsPatch({ pitchAccentFuriganaStyle: garbage }), /invalid reader option/);
  }
  assert.ok(DESIGN_OPTION_KEYS.includes("pitchAccentFuriganaStyle"), "Design's reset restores it");
  assert.ok(!KEYBIND_TOGGLE_OPTIONS.includes("pitchAccentFuriganaStyle"), "not a boolean hotkey toggle");
});

test("stored options drop the removed hover delay and migrate the renamed blur-count switch", () => {
  assert.equal(Object.hasOwn(DEFAULT_OPTIONS, "hoverDelayMs"), false);
  assert.equal(Object.hasOwn(DEFAULT_OPTIONS, "definitionBlurEnabled"), false);
  const legacy = { hoverDelayMs: 250, definitionBlurEnabled: true };
  assert.deepEqual(projectStoredOptions(legacy), { definitionBlurCountEnabled: true });
  assert.equal(normaliseOptions(legacy).definitionBlurCountEnabled, true);
  assert.equal(Object.hasOwn(normaliseOptions(legacy), "hoverDelayMs"), false);
  // A record that has both keeps the renamed one.
  assert.equal(normaliseOptions({ definitionBlurEnabled: true, definitionBlurCountEnabled: false })
    .definitionBlurCountEnabled, false);
  assert.deepEqual(validateOptionsPatch({ definitionBlurEnabled: false }), { definitionBlurCountEnabled: false });
  assert.throws(() => validateOptionsPatch({ definitionBlurEnabled: "yes" }));
});
