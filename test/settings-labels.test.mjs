// SPDX-License-Identifier: GPL-3.0-or-later
// Issue #401: one visible label names one setting, and a keybind toggle names
// its option the way the Settings control does.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const extension = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
const text = node => node.textContent.replace(/\s+/gu, " ").trim();

const document = new JSDOM(extension("settings.html")).window.document;
const context = {};
vm.runInNewContext(extension("reader-options.js"), { globalThis: context });
const { KEYBIND_TOGGLE_OPTIONS } = context.HDReaderOptions;
const { KEYBIND_OPTION_LABELS } = await import("../extension/keybind-settings.js");

// The visible name of a <label>'s control: its field-label, a `for` label's own
// text, or a switch row's leading span.
function labelText(label) {
  const fieldLabel = label.querySelector(".field-label");
  if (fieldLabel) return text(fieldLabel);
  if (label.htmlFor) return text(label);
  return text(label.querySelector("span") ?? label);
}

function controlLabels() {
  const labels = new Map();
  for (const label of document.querySelectorAll("label")) {
    const control = label.control;
    const name = labelText(label);
    // A later inline reference, such as "Turn on … above", is not the control's name.
    if (!control || !name || labels.has(control.id)) continue;
    labels.set(control.id, name);
  }
  return labels;
}

test("no two Settings controls share a visible label", () => {
  const owners = new Map();
  for (const [id, name] of controlLabels()) {
    const key = name.toLocaleLowerCase("en");
    owners.set(key, [...owners.get(key) ?? [], id]);
  }
  const duplicates = [...owners].filter(([, ids]) => new Set(ids).size > 1);
  assert.deepEqual(duplicates, []);
});

// The Settings checkbox each keybind-toggleable option is bound to.
const TOGGLE_CONTROLS = {
  hoverEnabled: "opt-hover-enabled",
  onlyScanJapaneseText: "opt-japanese-only",
  personalDictionaryEnabled: "opt-personal-dictionary",
  showNoResultNotice: "opt-no-result-notice",
  hidePopupOnCursorExit: "opt-hide-on-cursor-exit",
  audioAutoplay: "opt-audio-autoplay",
  sourceHighlightEnabled: "opt-source-highlight",
  showPopupAudioButton: "opt-popup-audio-button",
  showLookupCounts: "opt-lookup-counts",
  definitionBlurCountEnabled: "opt-blur-count",
  definitionBlurAnkiMature: "opt-blur-anki",
  definitionBlurFrequencyEnabled: "opt-blur-frequency",
  showCompactDefinitionSummary: "opt-compact-summary",
  averageFrequency: "opt-average-frequency",
  showFrequencyDictionaryNames: "opt-frequency-names",
  compactFrequencyNumbers: "opt-frequency-compact",
  showPitchAccentFurigana: "opt-pitch-furigana",
  showPitchAccentBadge: "opt-pitch-badge",
  showPitchAccentDictionaryNames: "opt-pitch-names",
  showPitchAccentText: "opt-pitch-text",
  showPitchAccentPosition: "opt-pitch-position",
  showPitchAccentGraph: "opt-pitch-graph",
  // Stored inverted: the checkbox is on while the tags are shown.
  hidePopupGrammarTags: "opt-grammar-tags",
};

test("every keybind toggle is labelled with its Settings control's wording and polarity", () => {
  assert.deepEqual([...KEYBIND_TOGGLE_OPTIONS].sort(), Object.keys(TOGGLE_CONTROLS).sort());
  assert.deepEqual(Object.keys(KEYBIND_OPTION_LABELS).sort(), Object.keys(TOGGLE_CONTROLS).sort());
  const labels = controlLabels();
  const firstWord = value => value.split(" ")[0].toLocaleLowerCase("en");
  for (const [key, id] of Object.entries(TOGGLE_CONTROLS)) {
    const settingsLabel = labels.get(id);
    assert.ok(settingsLabel, `${id} has a visible label`);
    // Same leading verb (Show/Hide/Blur/Enable…): a toggle cannot read as the
    // opposite of the checkbox it flips.
    assert.equal(firstWord(KEYBIND_OPTION_LABELS[key]), firstWord(settingsLabel),
      `${key}: keybind "${KEYBIND_OPTION_LABELS[key]}" vs Settings "${settingsLabel}"`);
  }
});

test("the sidebar has no navigation item without a link", () => {
  for (const item of document.querySelectorAll(".settings-nav .nav-item")) {
    assert.ok(item.querySelector("a[href^='#']"), item.outerHTML);
  }
  assert.equal(document.getElementById("nav-status-media"), null);
});
