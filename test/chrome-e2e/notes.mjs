/*
 * Term and kanji Notes appended through the popup.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./popup-content.mjs";
import { describe } from "node:test";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_TITLE,
} from "../../extension/custom-dictionary.js";
import { customSettingsGeneration, customSettingsResult } from "./custom-dictionary.mjs";
import { check, step } from "./harness.mjs";
import { hover, popup, tab } from "./reader.mjs";
import {
  CUSTOM_KANJI_NOTE_DEFINITION,
  CUSTOM_SETTINGS_SOURCE,
  CUSTOM_TERM_NOTE_DEFINITION,
  generationExists,
  generationIsAbsent,
  listOpfsPaths,
  ownedGenerationRoot,
  page,
  showSettingsSection,
  waitForGenerationAbsent,
} from "./session.mjs";

describe("personal dictionary Notes", () => {
  step("term and kanji Note forms", async () => {
    const termNoteHover = await hover("#verb");
    const termNoteOpened = await popup.click(".gsm-hoshidicts-note-button");
    const termNotePrefill = await popup.state();
    const termNoteSubmitted = await popup.writeNote(
      { definition: CUSTOM_TERM_NOTE_DEFINITION },
      true,
    );
    const savedTermNote = await page.waitForFunction(async ({ dictionaryId, sourceKey, sourcePrefix, definition }) => {
      const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
      const source = stored[sourceKey];
      const dictionary = stored.dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
      return source?.revision === 2
        && source.text === `${sourcePrefix}食べる, たべる, ${definition}\n`
        && stored.dictionaryState?.dictionaries?.[0]?.id === dictionaryId
        && dictionary?.enabled === true
        && dictionary.termCount === 2
        && typeof dictionary.path === "string"
        ? { dictionary, source }
        : false;
    }, { timeout: 90_000, polling: 250 }, {
      dictionaryId: CUSTOM_DICTIONARY_ID,
      sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
      sourcePrefix: CUSTOM_SETTINGS_SOURCE,
      definition: CUSTOM_TERM_NOTE_DEFINITION,
    }).then((handle) => handle.jsonValue()).catch(() => null);
    let refreshedTermNote = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await popup.state();
      if (popup.visible(state)
          && state?.noteOpen === false
          && state.text.includes(CUSTOM_TERM_NOTE_DEFINITION)) {
        refreshedTermNote = state;
        break;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }

    // The storage commit precedes generation cleanup. The refreshed popup is the
    // existing barrier proving that the save completed and lookups are available.
    const customGlobalTermLookup = await page.evaluate(() => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_lookup",
      requestId: "e2e-custom-global-term-lookup",
      text: "食べたかった",
      maxResults: 1,
      scanLength: 16,
      options: {
        frequencyDictionary: "",
        frequencyOrder: "auto",
        primaryReading: "",
      },
    }));

    const clickedCustomKanji = await popup.click(".gsm-hoshidicts-kanji-link");
    let customKanjiView = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await popup.state();
      if (state?.hasBack === true && state.text.includes("food")) {
        customKanjiView = state;
        break;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    const kanjiNoteOpened = await popup.click(".gsm-hoshidicts-note-button");
    const kanjiNotePrefill = await popup.state();
    const kanjiNoteSubmitted = await popup.writeNote({
      reading: "しょく",
      definition: CUSTOM_KANJI_NOTE_DEFINITION,
    }, true);
    const savedKanjiNote = await page.waitForFunction(async ({ dictionaryId, sourceKey, termDefinition, kanjiDefinition }) => {
      const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
      const source = stored[sourceKey];
      const dictionary = stored.dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
      return source?.revision === 3
        && source.text.includes(`食べる, たべる, ${termDefinition}\n`)
        && source.text.endsWith(`食, しょく, ${kanjiDefinition}\n`)
        && stored.dictionaryState?.dictionaries?.[0]?.id === dictionaryId
        && dictionary?.enabled === true
        && dictionary.termCount === 3
        && typeof dictionary.path === "string"
        ? { dictionary, source }
        : false;
    }, { timeout: 90_000, polling: 250 }, {
      dictionaryId: CUSTOM_DICTIONARY_ID,
      sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
      termDefinition: CUSTOM_TERM_NOTE_DEFINITION,
      kanjiDefinition: CUSTOM_KANJI_NOTE_DEFINITION,
    }).then((handle) => handle.jsonValue()).catch(() => null);
    let refreshedKanjiNote = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const state = await popup.state();
      if (popup.visible(state)
          && state?.noteOpen === false
          && state.hasBack === true
          && state.text.includes("food")) {
        refreshedKanjiNote = state;
        break;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    const customKanjiBack = await popup.click(".gsm-hoshidicts-kanji-back");
    let restoredCustomTerm = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await popup.state();
      if (state?.hasBack === false && state.text.includes(CUSTOM_TERM_NOTE_DEFINITION)) {
        restoredCustomTerm = state;
        break;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    const termNoteGeneration = ownedGenerationRoot(
      savedTermNote?.dictionary?.path,
      CUSTOM_DICTIONARY_TITLE,
    );
    const kanjiNoteGeneration = ownedGenerationRoot(
      savedKanjiNote?.dictionary?.path,
      CUSTOM_DICTIONARY_TITLE,
    );
    const customNotePaths = await listOpfsPaths(page);
    check(
      "term and kanji Note forms append and refresh the managed custom dictionary",
      termNoteHover !== null
        && termNoteOpened
        && termNotePrefill?.noteOpen === true
        && termNotePrefill.noteTerm === "食べる"
        && termNotePrefill.noteReading === "たべる"
        && termNotePrefill.noteDefinition === ""
        && termNoteSubmitted?.definition === CUSTOM_TERM_NOTE_DEFINITION
        && savedTermNote !== null
        && savedTermNote.dictionary.path !== customSettingsResult?.dictionary?.path
        && customGlobalTermLookup?.results?.[0]?.term?.glossaries?.[0]?.dictionary
          === CUSTOM_DICTIONARY_TITLE
        && JSON.stringify(customGlobalTermLookup).includes(CUSTOM_TERM_NOTE_DEFINITION)
        && refreshedTermNote !== null
        && clickedCustomKanji
        && customKanjiView !== null
        && kanjiNoteOpened
        && kanjiNotePrefill?.noteOpen === true
        && kanjiNotePrefill.noteTerm === "食"
        && kanjiNotePrefill.noteReading === ""
        && kanjiNotePrefill.noteDefinition === ""
        && kanjiNoteSubmitted?.reading === "しょく"
        && kanjiNoteSubmitted.definition === CUSTOM_KANJI_NOTE_DEFINITION
        && savedKanjiNote !== null
        && savedKanjiNote.dictionary.path !== savedTermNote?.dictionary?.path
        && refreshedKanjiNote !== null
        && customKanjiBack
        && restoredCustomTerm !== null
        && termNoteGeneration !== ""
        && kanjiNoteGeneration !== ""
        && generationIsAbsent(customNotePaths, customSettingsGeneration)
        && generationIsAbsent(customNotePaths, termNoteGeneration)
        && generationExists(customNotePaths, savedKanjiNote.dictionary.path),
      JSON.stringify({
        termNoteHover,
        termNoteOpened,
        termNotePrefill,
        termNoteSubmitted,
        savedTermNote,
        customGlobalTermLookup,
        refreshedTermNote,
        clickedCustomKanji,
        customKanjiView,
        kanjiNoteOpened,
        kanjiNotePrefill,
        kanjiNoteSubmitted,
        savedKanjiNote,
        refreshedKanjiNote,
        customKanjiBack,
        restoredCustomTerm,
        paths: customNotePaths,
      }),
    );

    const editorAdoptedNotes = await page.waitForFunction(({ termDefinition, kanjiDefinition }) => {
      const value = document.getElementById("custom-dictionary-source")?.value ?? "";
      return value.includes(termDefinition) && value.includes(kanjiDefinition);
    }, { timeout: 30_000, polling: 100 }, {
      termDefinition: CUSTOM_TERM_NOTE_DEFINITION,
      kanjiDefinition: CUSTOM_KANJI_NOTE_DEFINITION,
    }).then(() => true).catch(() => false);
    if (!editorAdoptedNotes) {
      throw new Error("Settings did not adopt the Note-appended custom source");
    }
    await page.bringToFront();
    await showSettingsSection(page, "custom-dictionary");
    if (process.env.HACHIDORI_CUSTOM_SCREENSHOT) {
      await page.setViewport({ width: 960, height: 900 });
      const customCard = await page.$('section[aria-labelledby="custom-dictionary-heading"]');
      await customCard.screenshot({ path: process.env.HACHIDORI_CUSTOM_SCREENSHOT });
    }

    // Later managed-update assertions intentionally begin with the same two
    // packages and native dictionary count they had before D8. Saving zero valid
    // rows performs the product cleanup path and must remove its final generation.
    await page.$eval("#custom-dictionary-source", (textarea) => {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click("#custom-dictionary-save");
    const customRemoved = await page.waitForFunction(async ({ dictionaryId, sourceKey }) => {
      const stored = await chrome.storage.local.get([sourceKey, "dictionaryState"]);
      const status = document.getElementById("custom-dictionary-status")?.textContent ?? "";
      if (
        stored[sourceKey]?.revision !== 4
        || stored[sourceKey]?.text !== ""
        || stored.dictionaryState?.dictionaries?.some((entry) => entry.id === dictionaryId)
        || !status.includes("removed the custom dictionary")
      ) {
        return false;
      }
      const engineStatus = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_status",
        requestId: "e2e-custom-cleanup-status",
      });
      return engineStatus?.ok === true && engineStatus.dictionaryCount === 4;
    }, { timeout: 90_000, polling: 250 }, {
      dictionaryId: CUSTOM_DICTIONARY_ID,
      sourceKey: CUSTOM_DICTIONARY_SOURCE_KEY,
    }).then(() => true).catch(() => false);
    const customGenerationRemoved = kanjiNoteGeneration !== ""
      && await waitForGenerationAbsent(page, kanjiNoteGeneration);
    if (!customRemoved || !customGenerationRemoved) {
      throw new Error(`custom cleanup failed: ${JSON.stringify({
        customRemoved,
        customGenerationRemoved,
        paths: await listOpfsPaths(page),
      })}`);
    }
    await tab.bringToFront();
  });
});
