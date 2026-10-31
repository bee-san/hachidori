/*
 * Clicked-kanji navigation and kanji dictionary choices.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./anki.mjs";
import { describe } from "node:test";
import { popupRoot } from "../chrome-popup-root.mjs";
import { GENERIC_KANJI_GLOSSARY, GENERIC_KANJI_TITLE } from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import { hover, popup, tab } from "./reader.mjs";
import {
  FIXTURE_ALIAS,
  FIXTURE_KANJI_SELECTION,
  FIXTURE_KANJI_SELECTION_VALUE,
  FIXTURE_TERM_SELECTION,
  FIXTURE_TERM_SELECTION_VALUE,
  GENERIC_KANJI_ID,
  page,
  setDictionaryEnabledInSettings,
  showSettingsSection,
} from "./session.mjs";

describe("clicked kanji", () => {
  step("clicked-kanji navigation", async () => {
    const clickedKanji = await popup.click(".gsm-hoshidicts-kanji-link");
    let genericKanjiState = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await popup.state();
      if (state?.text.includes(GENERIC_KANJI_GLOSSARY)) {
        // The lookup count paints after its own worker round trip; keep the view
        // once it stops changing so the pointer comparison below is exact.
        if (state.text === genericKanjiState?.text) break;
        genericKanjiState = state;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    check(
      "selected term dictionary wins even when maximum results is one",
      clickedKanji
        && genericKanjiState?.hasBack === true
        && genericKanjiState.text.includes(GENERIC_KANJI_TITLE)
        && !genericKanjiState.text.includes("food"),
      `popup state: ${JSON.stringify(await popup.state())}`,
    );
    const incidentalWord = await (await tab.$("#duplicate")).boundingBox();
    await tab.mouse.move(incidentalWord.x + incidentalWord.width * 0.15, incidentalWord.y + incidentalWord.height / 2);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const focusedPointerState = await popup.state();
    const clickedNestedKanji = await popup.click(".gsm-hoshidicts-kanji-link");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    const clickedNestedBack = await popup.click(".gsm-hoshidicts-kanji-back");
    const restoredIntermediateState = await popup.state();
    check(
      "Back preserves the complete clicked-kanji drill-down history",
      clickedNestedKanji
        && clickedNestedBack
        && restoredIntermediateState?.hasBack === true
        && restoredIntermediateState.text.includes(GENERIC_KANJI_GLOSSARY),
      `popup state: ${JSON.stringify(restoredIntermediateState)}`,
    );
    const clickedBack = await popup.click(".gsm-hoshidicts-kanji-back");
    const restoredTermState = await popup.state();
    check(
      "Back restores the term results after a generic kanji lookup",
      genericKanjiState !== null
        && clickedBack
        && restoredTermState?.text.includes("to eat")
        && !restoredTermState.text.includes(GENERIC_KANJI_GLOSSARY),
      `popup state: ${JSON.stringify(restoredTermState)}`,
    );
    check(
      "clicked-kanji navigation moves and restores keyboard focus",
      genericKanjiState?.focusedClass.includes("gsm-hoshidicts-kanji-back")
        && focusedPointerState?.focusedClass.includes("gsm-hoshidicts-kanji-back")
        && focusedPointerState?.text === genericKanjiState?.text
        && restoredTermState?.focusedClass.includes("gsm-hoshidicts-kanji-link"),
      JSON.stringify({ genericKanjiState, focusedPointerState, restoredTermState }),
    );
  });

  // Yomitan's Navigate forward in history (#609) on its default Alt+F, with
  // Alt+B for Back. The Backs above left the generic kanji view ahead of the
  // term results; a kanji clicked afresh has nothing ahead of it.
  step("Forward reopens the view Back left", async () => {
    await tab.evaluate(() => {
      window.__historyKeys = [];
      window.__recordHistoryKey = event => {
        if (event.altKey && ["KeyB", "KeyF"].includes(event.code)) window.__historyKeys.push(event.defaultPrevented);
      };
      window.addEventListener("keydown", window.__recordHistoryKey);
    });
    const press = async (code, accept) => {
      const pressed = await tab.evaluate(() => window.__historyKeys.length);
      await tab.keyboard.down("Alt");
      await tab.keyboard.press(code);
      await tab.keyboard.up("Alt");
      let state = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        state = await popup.state();
        if (await tab.evaluate(count => window.__historyKeys.length > count, pressed) && accept(state)) break;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
      }
      return state;
    };
    const onKanji = state => state?.text.includes(GENERIC_KANJI_GLOSSARY) && state.hasBack === true;
    const onTerm = state => state?.text.includes("to eat") && !state.text.includes(GENERIC_KANJI_GLOSSARY);
    try {
      const forward = await press("KeyF", state => onKanji(state)
        && state.focusedClass.includes("gsm-hoshidicts-kanji-back"));
      const back = await press("KeyB", state => onTerm(state) && state.focusedClass.includes("gsm-hoshidicts-kanji-link"));
      const reopened = await tab.evaluate(() => [...window.__historyKeys]);
      check(
        "Alt+F reopens the kanji view Back left with Back focused, and Alt+B returns from it",
        onKanji(forward) && forward.focusedClass.includes("gsm-hoshidicts-kanji-back")
          && onTerm(back) && back.focusedClass.includes("gsm-hoshidicts-kanji-link")
          && JSON.stringify(reopened) === "[true,true]",
        JSON.stringify({ forward, back, reopened }),
      );
      const clicked = await popup.click(".gsm-hoshidicts-kanji-link");
      let clickedState = null;
      for (let attempt = 0; attempt < 40 && !onKanji(clickedState); attempt += 1) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
        clickedState = await popup.state();
      }
      const ahead = await press("KeyF", onKanji);
      const returned = await press("KeyB", onTerm);
      const keys = await tab.evaluate(() => [...window.__historyKeys]);
      check(
        "Alt+F is left to the page when nothing is ahead, as after a new kanji click",
        clicked && onKanji(clickedState) && onKanji(ahead) && onTerm(returned)
          && JSON.stringify(keys) === "[true,true,false,true]",
        JSON.stringify({ clickedState, ahead, returned, keys }),
      );
    } finally {
      await tab.evaluate(() => window.removeEventListener("keydown", window.__recordHistoryKey));
    }
  });

  step("a duplicate clicked kanji", async () => {
    await tab.keyboard.press("Escape");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    const duplicateTermState = await hover("#duplicate");
    // The second 食 of 食(しょく)食(しょく), each kanji its own ruby (#605).
    const clickedSecondDuplicate = await popup.click(".gsm-hoshidicts-kanji-link", 1);
    let duplicateKanjiState = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await popup.state();
      if (state?.text.includes(GENERIC_KANJI_GLOSSARY)) {
        duplicateKanjiState = state;
        break;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    const duplicateBack = await popup.click(".gsm-hoshidicts-kanji-back");
    const duplicateRestoredState = await popup.state();
    check(
      "Back restores focus to the exact clicked duplicate kanji",
      duplicateTermState?.text.includes("duplicate-kanji focus fixture")
        && clickedSecondDuplicate
        && duplicateKanjiState?.hasBack === true
        && duplicateBack
        && duplicateRestoredState?.focusedKanjiIndex === 1,
      JSON.stringify({ duplicateTermState, duplicateKanjiState, duplicateRestoredState }),
    );
  });

  step("a disabled term dictionary falls back to native kanji", async () => {
    const genericDisabled = await setDictionaryEnabledInSettings(page, GENERIC_KANJI_TITLE, false);
    check(
      "the Settings enabled control disables one logical package",
      genericDisabled?.settled?.id === GENERIC_KANJI_ID,
      JSON.stringify(genericDisabled),
    );
    const refreshedAfterDisable = await hover("#duplicate");
    const clickedDisabledKanji = await popup.click(".gsm-hoshidicts-kanji-link");
    let disabledKanjiState = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await popup.state();
      if (state?.text.includes("food")) {
        disabledKanjiState = state;
        break;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    check(
      "a disabled selected term dictionary falls back to native kanji",
      refreshedAfterDisable !== null
        && clickedDisabledKanji
        && disabledKanjiState?.hasBack === true
        && !disabledKanjiState.text.includes(GENERIC_KANJI_GLOSSARY),
      `popup state: ${JSON.stringify(await popup.state())}`,
    );
    await popup.click(".gsm-hoshidicts-kanji-back");
  });

  step("re-enabling a selected term-only kanji dictionary", async () => {
    const reenabled = await setDictionaryEnabledInSettings(page, GENERIC_KANJI_TITLE, true);
    const selection = await page.evaluate(async () =>
      (await chrome.storage.local.get("options")).options?.kanjiClickDictionary);
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await hover("#duplicate");
    const clicked = await popup.click(".gsm-hoshidicts-kanji-link");
    await popupRoot(tab).waitFor((root, glossary) => root.textContent.includes(glossary), {}, GENERIC_KANJI_GLOSSARY);
    const restored = await popup.state();
    check(
      "re-enabling a selected term-only kanji dictionary restores its saved route",
      reenabled?.settled?.id === GENERIC_KANJI_ID
        && selection?.title === GENERIC_KANJI_TITLE && selection?.kind === "term"
        && clicked && restored?.text.includes(GENERIC_KANJI_GLOSSARY),
      JSON.stringify({ reenabled, selection, restored }),
    );
    await popup.click(".gsm-hoshidicts-kanji-back");
    await setDictionaryEnabledInSettings(page, GENERIC_KANJI_TITLE, false);
    await hover("#duplicate");
  });

  step("a combined archive's term entries", async () => {
    await showSettingsSection(page, "lookup");
    await page.select("#opt-kanji-dictionary", FIXTURE_TERM_SELECTION_VALUE);
    await page.waitForFunction(async (selection) => {
      const saved = (await chrome.storage.local.get("options")).options?.kanjiClickDictionary;
      return saved?.title === selection.title && saved?.kind === selection.kind;
    }, { timeout: 10_000, polling: 100 }, FIXTURE_TERM_SELECTION);
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    const refreshedForCombinedTerm = await hover("#duplicate");
    const clickedCombinedTerm = await popup.click(".gsm-hoshidicts-kanji-link");
    let combinedTermState = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await popup.state();
      if (state?.text.includes("unrelated term-dictionary definition")) {
        combinedTermState = state;
        break;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    check(
      "a combined archive can use its term entries for clicked kanji",
      refreshedForCombinedTerm !== null
        && clickedCombinedTerm
        && combinedTermState !== null
        && !combinedTermState.text.includes("Meaningsfoodeatmeal"),
      `popup state: ${JSON.stringify(await popup.state())}`,
    );
    await popup.click(".gsm-hoshidicts-kanji-back");
  });

  step("a kanji-bank dictionary keeps the native view", async () => {
    await page.select("#opt-kanji-dictionary", FIXTURE_KANJI_SELECTION_VALUE);
    await page.waitForFunction(async (selection) => {
      const saved = (await chrome.storage.local.get("options")).options?.kanjiClickDictionary;
      return saved?.title === selection.title && saved?.kind === selection.kind;
    }, { timeout: 10_000, polling: 100 }, FIXTURE_KANJI_SELECTION);
    const clickedNativeKanji = await popup.click(".gsm-hoshidicts-kanji-link");
    let nativeKanjiState = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await popup.state();
      if (state?.text.includes("food") && state.text.includes(FIXTURE_ALIAS)) {
        nativeKanjiState = state;
        break;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    check(
      "selecting a kanji-bank dictionary keeps the native kanji view",
      clickedNativeKanji
        && nativeKanjiState?.hasBack === true
        && !nativeKanjiState.text.includes(GENERIC_KANJI_GLOSSARY),
      `popup state: ${JSON.stringify(await popup.state())}`,
    );
    await popup.click(".gsm-hoshidicts-kanji-back");
  });
});
