/*
 * The personal dictionary in Settings.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./library.mjs";
import { describe } from "node:test";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_TITLE,
} from "../../extension/custom-dictionary.js";
import { check, step } from "./harness.mjs";
import {
  CUSTOM_SETTINGS_SOURCE,
  generationExists,
  listOpfsPaths,
  ownedGenerationRoot,
  page,
  showSettingsSection,
} from "./session.mjs";

// Values that more than one step uses; the step that creates each one assigns it.
let customSettingsResult, customSettingsGeneration;

describe("personal dictionary", () => {
  step("Settings saves a personal source through the real importer", async () => {
    // ------------------------------------------------------- custom dictionary
    // Entering Personal dictionary loads the saved source into its visible editor.
    // Saving here also puts the production ZIP compiler through the real
    // offscreen WASM importer before either popup Note path builds on that source.
    await showSettingsSection(page, "custom-dictionary");
    const customEditorOnVisit = await page.evaluate(() => ({
      openControlAbsent: document.getElementById("custom-dictionary-open") === null,
      formHidden: document.getElementById("custom-dictionary-form")?.hidden,
      source: document.getElementById("custom-dictionary-source")?.value ?? null,
      sourceHasMaximumLength: document.getElementById("custom-dictionary-source")?.hasAttribute("maxlength"),
      placeholderLines: document.getElementById("custom-dictionary-source")?.placeholder.split("\n").length,
    }));
    const customEditorLoaded = await page.waitForFunction(() => {
      const form = document.getElementById("custom-dictionary-form");
      const status = document.getElementById("custom-dictionary-status")?.textContent ?? "";
      return form?.hidden === false && status === "Loaded source revision 0.";
    }, { timeout: 30_000, polling: 100 }).then(() => true).catch(() => false);
    const examplesBeforeTyping = await page.$eval("#custom-dictionary-source", textarea =>
      textarea.matches(":placeholder-shown") && textarea.value === ""
        && document.getElementById("custom-dictionary-save").disabled);
    await page.type("#custom-dictionary-source", "蜂");
    const examplesAfterTyping = await page.evaluate(async sourceKey => {
      const textarea = document.getElementById("custom-dictionary-source");
      const saved = await chrome.storage.local.get(sourceKey);
      return !textarea.matches(":placeholder-shown") && textarea.value === "蜂"
        && (saved[sourceKey]?.text ?? "") === "";
    }, CUSTOM_DICTIONARY_SOURCE_KEY);
    await page.$eval("#custom-dictionary-source", (textarea, source) => {
      textarea.value = source;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }, CUSTOM_SETTINGS_SOURCE);
    const sourceNode = await page.$("#custom-dictionary-source");
    await showSettingsSection(page, "lookup");
    await showSettingsSection(page, "custom-dictionary");
    const sourceDraftRetained = await page.evaluate((node, source) =>
      node === document.getElementById("custom-dictionary-source") && node.value === source, sourceNode, CUSTOM_SETTINGS_SOURCE);
    await sourceNode.dispose();
    if (!sourceDraftRetained) throw new Error("Navigating Settings replaced the unsaved source draft");
    await page.click("#custom-dictionary-save");
    customSettingsResult = await page.waitForFunction(async ({ dictionaryId, dictionaryTitle, sourceKey, sourceText }) => {
      const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
      const source = stored[sourceKey];
      const dictionaries = stored.dictionaryState?.dictionaries ?? [];
      const dictionary = dictionaries.find((entry) => entry.id === dictionaryId);
      const row = document.querySelector(`[data-dictionary-id="${dictionaryId}"]`);
      const status = document.getElementById("custom-dictionary-status")?.textContent ?? "";
      if (
        source?.revision !== 1
        || source.text !== sourceText
        || dictionaries[0]?.id !== dictionaryId
        || dictionary?.title !== dictionaryTitle
        || dictionary.enabled !== true
        || dictionary.termCount !== 1
        || typeof dictionary.path !== "string"
        || !row
        || row.previousElementSibling !== null
        || !row.querySelector(".dict-enabled")?.checked
        || row.querySelector(".dict-enabled")?.disabled !== true
        || row.querySelector(".dict-drag")?.draggable !== false
        || row.querySelector(".dict-remove")?.hidden !== true
        || row.querySelector(".dict-remove")?.disabled !== true
        || !status.includes("rebuilt the custom dictionary")
      ) {
        return false;
      }
      const lookup = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_lookup_dictionary",
        requestId: "e2e-custom-settings-lookup",
        dictionary: dictionaryTitle,
        text: "\u6c17\u306b\u306a\u308b",
      });
      if (
        lookup?.ok !== true
        || lookup.results?.[0]?.term?.expression !== "\u6c17\u306b\u306a\u308b"
        || !JSON.stringify(lookup).includes("to catch one's attention")
      ) {
        return false;
      }
      return { dictionary, lookup, source, status };
    }, { timeout: 90_000, polling: 250 }, {
      dictionaryId: CUSTOM_DICTIONARY_ID,
      dictionaryTitle: CUSTOM_DICTIONARY_TITLE,
      sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
      sourceText: CUSTOM_SETTINGS_SOURCE,
    }).then((handle) => handle.jsonValue()).catch(() => null);
    customSettingsGeneration = ownedGenerationRoot(
      customSettingsResult?.dictionary?.path,
      CUSTOM_DICTIONARY_TITLE,
    );
    const customSettingsPaths = await listOpfsPaths(page);
    check(
      "custom Settings lazily saves a source through the real WASM importer",
      customEditorOnVisit.openControlAbsent === true
        && customEditorOnVisit.formHidden === false
        && customEditorOnVisit.source === ""
        && customEditorOnVisit.sourceHasMaximumLength === false
        && customEditorOnVisit.placeholderLines === 3
        && customEditorLoaded
        && examplesBeforeTyping && examplesAfterTyping
        && customSettingsResult !== null
        && customSettingsGeneration !== ""
        && generationExists(customSettingsPaths, customSettingsResult.dictionary.path),
      JSON.stringify({
        onVisit: customEditorOnVisit,
        editorLoaded: customEditorLoaded,
        examplesBeforeTyping, examplesAfterTyping,
        result: customSettingsResult,
        generation: customSettingsGeneration,
        paths: customSettingsPaths,
      }),
    );
  });
});

export { customSettingsGeneration, customSettingsResult };
