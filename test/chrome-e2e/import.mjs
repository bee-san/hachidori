/*
 * Importing Yomitan archives from Settings.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./recommended.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { GENERIC_KANJI_TITLE } from "../make-fixture.mjs";
import { check, HERE, report, step } from "./harness.mjs";
import {
  browser,
  FIXTURE,
  FIXTURE_ALIAS,
  FIXTURE_ID,
  generationExists,
  generationIsAbsent,
  GENERIC_KANJI_FIXTURE,
  GENERIC_KANJI_ID,
  listOpfsPaths,
  MANAGED_DOWNLOAD_URL,
  MANAGED_INDEX_URL,
  openDictionaryDetails,
  ownedGenerationRoot,
  page,
  server,
  setDictionaryAliasInSettings,
  showSettingsSection,
  waitForGenerationAbsent,
} from "./session.mjs";

const INVALID_FIXTURE = resolve(HERE, "fixtures/malformed-index.zip");
const LAST_UPDATE_CHECK = Object.freeze({
  checkedAt: "2026-09-04T09:30:00.000Z",
  status: "update-available",
  remoteRevision: "test-2",
  error: null,
});

// Values that more than one step uses; the step that creates each one assigns it.
let input, dictionaryState, fixturePackage, fixtureId, firstFixtureGeneration, replacedState,
  replacedPackage, genericPackage, replacedFixtureGeneration, opfsAfterBatch;

describe("import", () => {
  step("the .zip file input", async () => {
    // ------------------------------------------------------------------ import
    await showSettingsSection(page, "add-dictionaries");
    input = await page.$("#import-file");
    check("settings page exposes a .zip file input", !!input);
    if (!input) {
      await browser.close();
      server.close();
      return report();
    }
    // An <input> of the wrong type takes no file at all, and one that accepts
    // everything offers the reader dictionaries it cannot import.
    const inputShape = await page.evaluate(() => {
      const el = document.getElementById("import-file");
      return {
        tag: el.tagName.toLowerCase(),
        type: el.type,
        accept: el.getAttribute("accept") || "",
        multiple: el.multiple,
      };
    });
    check("the .zip file input accepts multiple .zip files",
      inputShape.tag === "input" && inputShape.type === "file"
        && inputShape.accept.split(",").map(s => s.trim()).includes(".zip")
        && inputShape.multiple === true,
      `#import-file: ${JSON.stringify(inputShape)}`);
  });

  step("importing a Yomitan .zip", async () => {
    await input.uploadFile(FIXTURE);

    const importState = await page.waitForFunction(() => {
      const t = (document.getElementById("import-state")?.textContent || "").trim();
      return t.startsWith("Finished 1 of 1 archive") ? t : false;
    }, { timeout: 120_000, polling: 500 }).then(h => h.jsonValue()).catch(() => "(never settled)");
    const importDetail = await page.evaluate(() => {
      const row = document.querySelector("#import-progress .setup-dictionary");
      return {
        name: row?.querySelector(".setup-dictionary-name")?.textContent ?? "",
        status: row?.querySelector(".setup-dictionary-status")?.textContent ?? "",
        trackHidden: row?.querySelector(".setup-track")?.hidden === true,
      };
    });
    const importOk = importState === "Finished 1 of 1 archive — 1 imported, 0 failed."
      && importDetail.name === "hachidori-fixture.zip"
      && /^Imported hachidori-fixture in \d+(?:\.\d)? seconds: /u.test(importDetail.status)
      && importDetail.trackHidden;
    check("importing a Yomitan .zip from the settings page succeeds", importOk,
      `#import-state: ${importState}\n       import progress: ${JSON.stringify(importDetail)}`);

    const opfsFiles = await listOpfsPaths(page);

    const stored = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
    dictionaryState = stored?.dictionaryState;
    const dicts = dictionaryState?.dictionaries ?? [];
    fixturePackage = dicts[0];
    fixtureId = fixturePackage?.id ?? "";
    firstFixtureGeneration = ownedGenerationRoot(fixturePackage?.path, "hachidori-fixture");
    check("the imported dictionary is persisted in OPFS",
      firstFixtureGeneration !== "" && generationExists(opfsFiles, fixturePackage.path),
      `dictionary path: ${JSON.stringify(fixturePackage?.path)}; OPFS paths: ${JSON.stringify(opfsFiles)}`);
    // The fixture has term, frequency, pitch, kanji and media data, but is one
    // installed package. Native dictionaryCount still counts its four query kinds.
    check("the imported dictionary is recorded in chrome.storage.local",
      dictionaryState?.schemaVersion === 1
        && Number.isInteger(dictionaryState.revision)
        && dictionaryState.revision > 0
        && dicts.length === 1
        && fixtureId === FIXTURE_ID
        && fixturePackage.title === "hachidori-fixture"
        && fixturePackage.displayName === null
        && firstFixtureGeneration !== ""
        && fixturePackage.enabled === true
        && fixturePackage.favorite === false
        && fixturePackage.revision === "test-1"
        && fixturePackage.isUpdatable === false
        && fixturePackage.indexUrl === null
        && fixturePackage.downloadUrl === null
        && fixturePackage.language === "ja"
        && fixturePackage.termCount === 6
        && fixturePackage.frequencyCount === 2
        && fixturePackage.pitchCount === 2
        && fixturePackage.kanjiCount === 1
        && fixturePackage.mediaCount === 1
        && typeof fixturePackage.installedAt === "string"
        && Number.isFinite(Date.parse(fixturePackage.installedAt))
        && fixturePackage.lastUpdateCheck === null,
      `dictionaryState: ${JSON.stringify(dictionaryState)}`);
  });

  step("batch import and re-import", async () => {
    const aliasChanged = await setDictionaryAliasInSettings(page, "hachidori-fixture", FIXTURE_ALIAS);
    const stateBeforeReimport = await page.evaluate(async (presentation) => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      return chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_apply_state",
        requestId: "e2e-preserve-reimport-state",
        baseRevision: current.revision,
        dictionaries: current.dictionaries.map((dictionary) => ({
          ...dictionary,
          ...(dictionary.title === "hachidori-fixture" ? presentation : {}),
        })),
      });
    }, {
      enabled: false,
      favorite: true,
      isUpdatable: true,
      indexUrl: MANAGED_INDEX_URL,
      downloadUrl: MANAGED_DOWNLOAD_URL,
      lastUpdateCheck: LAST_UPDATE_CHECK,
    });

    await showSettingsSection(page, "add-dictionaries");
    const dropProof = await page.evaluate((archives) => {
      const zone = document.getElementById("import-drop-zone");
      const transfer = new DataTransfer();
      for (const archive of archives) {
        const bytes = Uint8Array.from(atob(archive.base64), (character) => character.charCodeAt(0));
        transfer.items.add(new File([bytes], archive.name, { type: "application/zip" }));
      }
      const dispatch = (type) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        zone.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const dragEnterPrevented = dispatch("dragenter");
      const dragOverPrevented = dispatch("dragover");
      const highlighted = zone.classList.contains("is-dragging");
      const dropEffect = transfer.dropEffect;
      const dropPrevented = dispatch("drop");
      return {
        dragEnterPrevented,
        dragOverPrevented,
        highlighted,
        dropEffect,
        dropPrevented,
        cleared: !zone.classList.contains("is-dragging"),
      };
    }, [
      { name: "hachidori-generic-kanji-fixture.zip", base64: readFileSync(GENERIC_KANJI_FIXTURE).toString("base64") },
      { name: "malformed-index.zip", base64: readFileSync(INVALID_FIXTURE).toString("base64") },
      { name: "hachidori-fixture.zip", base64: readFileSync(FIXTURE).toString("base64") },
    ]);
    await page.waitForFunction(() => {
      const outcomes = [...document.querySelectorAll("#import-progress .setup-dictionary-status")];
      return outcomes[0]?.textContent.includes("Imported")
        && outcomes[1]?.textContent.includes("Failed before import")
        && document.getElementById("import-decision-dialog")?.open;
    }, { timeout: 180_000, polling: 100 });
    await page.focus('#import-decision-dialog button[value="replace"]');
    await page.keyboard.press("Enter");
    const batchState = await page.waitForFunction(() => {
      const text = (document.getElementById("import-state")?.textContent || "").trim();
      return text.startsWith("Finished 3 of 3 archives") ? text : false;
    }, { timeout: 180_000, polling: 250 }).then(handle => handle.jsonValue()).catch(() => "(never settled)");
    const batchUi = await page.evaluate(() => ({
      pickerValue: document.getElementById("import-file")?.value ?? "missing",
      sharedRows: document.querySelector("#import-progress .setup-dictionary-list")
        ?.getAttribute("aria-label") === "Dictionary import progress",
      stateError: document.getElementById("import-state")?.classList.contains("is-error"),
      outcomes: [...document.querySelectorAll("#import-progress .setup-dictionary")].map((result) => ({
        name: result.querySelector(".setup-dictionary-name")?.textContent ?? "",
        text: result.querySelector(".setup-dictionary-status")?.textContent ?? "",
        error: result.querySelector(".setup-dictionary-status")?.classList.contains("is-error") === true,
        trackHidden: result.querySelector(".setup-track")?.hidden === true,
      })),
    }));
    replacedState = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
    const replacedDictionaries = replacedState?.dictionaryState?.dictionaries ?? [];
    replacedPackage = replacedDictionaries.find(
      (dictionary) => dictionary.title === "hachidori-fixture",
    );
    genericPackage = replacedDictionaries.find(
      (dictionary) => dictionary.title === GENERIC_KANJI_TITLE,
    );
    replacedFixtureGeneration = ownedGenerationRoot(
      replacedPackage?.path,
      "hachidori-fixture",
    );
    await waitForGenerationAbsent(page, firstFixtureGeneration);
    opfsAfterBatch = await listOpfsPaths(page);
    check("the import batch continues after failure and retains every archive outcome",
      batchState === "Finished 3 of 3 archives — 2 imported, 1 failed."
        && batchUi.pickerValue === ""
        && dropProof.dragEnterPrevented && dropProof.dragOverPrevented
        && dropProof.highlighted && dropProof.dropPrevented && dropProof.cleared
        && batchUi.sharedRows === true
        && batchUi.stateError === true
        && batchUi.outcomes.length === 3
        && batchUi.outcomes[0].error === false
        && batchUi.outcomes[0].text.includes(`Imported ${GENERIC_KANJI_TITLE}`)
        && /\d+(?:\.\d)? seconds/u.test(batchUi.outcomes[0].text)
        && batchUi.outcomes[1].error === true
        && batchUi.outcomes[1].text.includes("Failed before import")
        && batchUi.outcomes[1].text.includes("malformed-index.zip: reading dictionary metadata failed")
        && batchUi.outcomes[2].error === false
        && batchUi.outcomes[2].text.includes("Imported hachidori-fixture")
        && JSON.stringify(batchUi.outcomes.map(({ name }) => name)) === JSON.stringify([
          "hachidori-generic-kanji-fixture.zip", "malformed-index.zip", "hachidori-fixture.zip",
        ])
        && batchUi.outcomes.every(({ trackHidden }) => trackHidden)
        && [batchUi.outcomes[0], batchUi.outcomes[2]]
          .every(({ text }) => /\d+(?:\.\d)? seconds/u.test(text)),
      `#import-state: ${batchState}; drop: ${JSON.stringify(dropProof)}; batch UI: ${JSON.stringify(batchUi)}`);
    check("batch re-import preserves presentation, source, and order while clearing stale check state",
      aliasChanged?.settled?.id === FIXTURE_ID
        && stateBeforeReimport?.ok === true
        && replacedDictionaries.length === 2
        && replacedState.dictionaryState.revision > dictionaryState.revision
        && JSON.stringify(replacedDictionaries.map((dictionary) => dictionary.id))
          === JSON.stringify([FIXTURE_ID, GENERIC_KANJI_ID])
        && replacedPackage?.id === FIXTURE_ID
        && replacedFixtureGeneration !== ""
        && replacedPackage.path !== fixturePackage.path
        && generationExists(opfsAfterBatch, replacedPackage.path)
        && generationIsAbsent(opfsAfterBatch, firstFixtureGeneration)
        && replacedPackage?.displayName === FIXTURE_ALIAS
        && replacedPackage?.enabled === false
        && replacedPackage?.favorite === true
        && replacedPackage?.isUpdatable === true
        && replacedPackage?.indexUrl === MANAGED_INDEX_URL
        && replacedPackage?.downloadUrl === MANAGED_DOWNLOAD_URL
        && replacedPackage?.lastUpdateCheck === null,
      `alias change: ${JSON.stringify(aliasChanged)}; state before reimport: ${JSON.stringify(stateBeforeReimport)};`
        + ` dictionaryState: ${JSON.stringify(replacedState?.dictionaryState)}; OPFS paths: ${JSON.stringify(opfsAfterBatch)}`);
  });

  step("the dictionary list renders alias, metadata and badges", async () => {
    if (process.env.HACHIDORI_IMPORT_SCREENSHOT) {
      const importCard = await page.$('section[aria-labelledby="import-heading"]');
      await importCard.screenshot({ path: process.env.HACHIDORI_IMPORT_SCREENSHOT });
    }

    await page.waitForFunction((alias) => {
      const row = document.querySelector("#dict-list .dict-row");
      return row?.querySelector(".dict-title")?.textContent === alias
        && row.querySelectorAll(".dict-badge").length === 5;
    }, { timeout: 10_000, polling: 100 }, FIXTURE_ALIAS).catch(() => {});
    await openDictionaryDetails(page, FIXTURE_ID);
    const renderedDictionary = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#dict-list .dict-row")];
      const row = rows[0];
      return {
        count: rows.length,
        title: row?.querySelector(".dict-title")?.textContent ?? "",
        canonical: row?.querySelector(".dict-canonical")?.textContent ?? "",
        alias: row?.querySelector(".dict-display-name")?.value ?? "",
        enabled: row?.querySelector(".dict-enabled")?.checked,
        favorite: row?.querySelector(".dict-favorite")?.hidden === false,
        badges: [...(row?.querySelectorAll(".dict-badge") ?? [])].map((badge) => ({
          capability: badge.dataset.capability,
          text: badge.textContent,
        })),
        metadata: row?.querySelector(".dict-metadata")?.textContent ?? "",
      };
    });
    check("the dictionary list renders its alias, metadata, and five capability badges",
      renderedDictionary.count === 2
        && renderedDictionary.title === FIXTURE_ALIAS
        && renderedDictionary.canonical === "hachidori-fixture"
        && renderedDictionary.alias === FIXTURE_ALIAS
        && renderedDictionary.enabled === false
        && renderedDictionary.favorite === true
        && JSON.stringify(renderedDictionary.badges) === JSON.stringify([
          { capability: "terms", text: "Terms 6" },
          { capability: "frequency", text: "Frequency 2" },
          { capability: "pitch", text: "Pitch 2" },
          { capability: "kanji", text: "Kanji 1" },
          { capability: "media", text: "Media 1" },
        ])
        && renderedDictionary.metadata.includes("Revision test-1")
        && renderedDictionary.metadata.includes("ja")
        && renderedDictionary.metadata.includes("Imported ")
        && renderedDictionary.metadata.includes(`Package ID ${FIXTURE_ID}`)
        && renderedDictionary.metadata.includes("Update source available"),
      `#dict-list: ${JSON.stringify(renderedDictionary)}`);
  });
});

export {
  firstFixtureGeneration, fixtureId, genericPackage, opfsAfterBatch, replacedFixtureGeneration,
  replacedPackage, replacedState,
};
