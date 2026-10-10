/*
 * The extension layer against the real wasm engine: boot, relay and import.
 *
 * The engine steps here and in the other engine-*.mjs files are one scenario on
 * one engine: each file imports the one before it, so it runs after its steps.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe } from "node:test";
import { createContext, runInContext } from "node:vm";
import {
  buildLongKeyZip,
  EXPECTED,
  LONG_KEY_LENGTH,
  LONG_KEY_PHRASE,
  LONG_KEY_PHRASE_INFLECTED,
  LONG_KEY_PROVERB,
  LONG_KEY_TITLE,
} from "../make-fixture.mjs";
import {
  createObjectURL,
  DICTIONARY_PACKAGE_KEYS,
  EXTENSION,
  EXTENSION_MANIFEST,
  FIXTURE,
  FIXTURE_TITLE,
  HERE,
  installFakeIndexedDB,
  installFetch,
  installNavigator,
  loadBackgroundScript,
  makeAlarms,
  makeBus,
  makeChrome,
  makeStorage,
  mjs,
  offscreenState,
  ownedGenerationRoot,
  ROOT,
} from "./fakes.mjs";
import { check, equal, section, step, test } from "./harness.mjs";

async function checkReaderOptionsTransport(pageChrome, storage) {
  const local = storage.api().local;
  const saved = await local.get(["options", "dictionaryState"]);
  const frameLimit = 1024 * 1024;
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const message = (options = {}, extra = {}) => ({
    target: "hoshidicts-worker", type: "hd_options_write", requestId: "options-contract",
    baseRevision: 2, options, ...extra,
  });
  const send = (value) => pageChrome.runtime.sendMessage(value);
  const unchanged = async (before) => JSON.stringify(await local.get(["options", "dictionaryState"]))
    === JSON.stringify(before);
  try {
    const readerContext = createContext({});
    runInContext(readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8"), readerContext);
    const reader = readerContext.HDReaderOptions;
    const noticeCases = [];
    const selectionOptions = ["showNoResultNotice", "personalDictionaryEnabled"];
    for (const key of selectionOptions) {
      for (const value of [false, true, "false", 0, null]) {
        await local.set({ options: saved.options });
        const reply = await send(message({ [key]: value }));
        noticeCases.push(typeof value === "boolean"
          ? reply.ok === true && reply.options?.[key] === value
          : reply.ok === false && await unchanged(saved));
      }
    }
    check("selection notices and the personal dictionary default on and use strict boolean options CAS",
      selectionOptions.every(key => reader.normaliseOptions({})[key] === true
        && reader.normaliseOptions({ [key]: "false" })[key] === true)
        && !reader.DESIGN_OPTION_KEYS.includes("personalDictionaryEnabled")
        && noticeCases.every(Boolean), JSON.stringify(noticeCases));
    const cssCases = [];
    for (const value of ["", "/* 日本語 */\r\n.gsm-hoshidicts-popup { color: red; }\n", "/*" + "x".repeat(40_000) + "*/"]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ customPopupCss: value }));
      const repeated = await send(message({ customPopupCss: value }, { baseRevision: reply.options?.revision }));
      cssCases.push(reply.ok === true && reply.options?.customPopupCss === value
        && repeated.options?.revision === reply.options.revision);
    }
    for (const value of [null, 1, {}, false]) {
      await local.set({ options: saved.options });
      cssCases.push((await send(message({ customPopupCss: value }))).ok === false && await unchanged(saved));
    }
    check("custom popup CSS preserves exact strings without a source-specific cap and uses idempotent options CAS",
      reader.normaliseOptions({}).customPopupCss === "" && reader.DESIGN_OPTION_KEYS.includes("customPopupCss")
        && cssCases.every(Boolean), JSON.stringify(cssCases));
    const toolbarCases = [];
    for (const value of ["auto", "top", "bottom"]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupToolbarPosition: value }));
      const repeated = await send(message({ popupToolbarPosition: value }, { baseRevision: reply.options?.revision }));
      toolbarCases.push(reply.ok === true && reply.options?.popupToolbarPosition === value
        && repeated.options?.revision === reply.options.revision);
    }
    for (const value of ["left", "", null, 1]) {
      await local.set({ options: saved.options });
      toolbarCases.push((await send(message({ popupToolbarPosition: value }))).ok === false && await unchanged(saved));
    }
    check("toolbar preferences default to Automatic and accept only the three persisted idempotent choices",
      reader.normaliseOptions({}).popupToolbarPosition === "auto"
        && reader.normaliseOptions({ popupToolbarPosition: "left" }).popupToolbarPosition === "auto"
        && reader.DESIGN_OPTION_KEYS.includes("popupToolbarPosition") && toolbarCases.every(Boolean),
      JSON.stringify(toolbarCases));
    const appearanceDefaults = { popupTheme: "default", popupWidthPx: 560, popupHeightPx: 420,
      popupOpacityPercent: 85, sourceHighlightEnabled: true, showPopupAudioButton: true };
    const appearanceAccepted = [];
    for (const [key, value] of Object.entries({ popupTheme: "miku", popupWidthPx: 1200, popupHeightPx: 200,
      popupOpacityPercent: 0, sourceHighlightEnabled: false, showPopupAudioButton: false })) {
      await local.set({ options: saved.options });
      const reply = await send(message({ [key]: value }));
      const repeated = await send(message({ [key]: value }, { baseRevision: 3 }));
      appearanceAccepted.push(reply.ok === true && reply.options?.[key] === value
        && reply.options.revision === 3 && repeated.options?.revision === 3);
    }
    const appearanceRejected = [];
    for (const patch of [{ popupTheme: "unknown" }, { popupTheme: null }, { popupWidthPx: 279 },
      { popupWidthPx: 1201 }, { popupHeightPx: 199 }, { popupHeightPx: 901 },
      { popupOpacityPercent: -1 }, { popupOpacityPercent: 101 }, { popupOpacityPercent: 50.5 },
      { popupWidthPx: "560" }, { sourceHighlightEnabled: "true" }, { showPopupAudioButton: "false" }]) {
      await local.set({ options: saved.options });
      const reply = await send(message(patch));
      appearanceRejected.push(reply.ok === false && await unchanged(saved));
    }
    const themes = reader.POPUP_THEME_GROUPS?.flatMap(group => group.themes) || [];
    const cssThemes = new Set(["default", ...[...readFileSync(resolve(EXTENSION, "render/reader.css"), "utf8")
      .matchAll(/data-hoshidicts-theme="([^"]+)"/gu)].map(match => match[1])]);
    check("appearance preferences preserve audited defaults, ranges and strict idempotent CAS",
      Object.entries(appearanceDefaults).every(([key, value]) => reader.normaliseOptions({})[key] === value)
        && appearanceAccepted.every(Boolean) && appearanceRejected.every(Boolean),
      JSON.stringify({ appearanceAccepted, appearanceRejected }));
    check("AUTO plus the grouped 42-palette catalogue validates every persisted ID",
      themes.length === 43 && new Set(themes.map(theme => theme.id)).size === 43
        && JSON.stringify(reader.POPUP_THEME_GROUPS?.map(group => group.themes.length)) === "[1,18,23,1]"
        && themes.every(theme => (theme.id === "auto" || cssThemes.has(theme.id)) && typeof theme.label === "string"
          && reader.validateOptionsPatch({ popupTheme: theme.id }).popupTheme === theme.id)
        && reader.normaliseOptions({ popupTheme: "unknown" }).popupTheme === "default",
      JSON.stringify({ themes, cssThemes: [...cssThemes] }));
    const readerCss = readFileSync(resolve(EXTENSION, "render/reader.css"), "utf8");
    const frameRule = readerCss.match(/^\.gsm-hoshidicts-popup \{([^}]+)\}/mu)?.[1];
    const scrollRule = readerCss.match(/^\.gsm-hoshidicts-content-scroll \{([^}]+)\}/mu)?.[1];
    const toolbarRule = readerCss.match(/^\.gsm-hoshidicts-result-chrome \{([^}]+)\}/mu)?.[1];
    const noteRule = [...readerCss.matchAll(/^\.gsm-hoshidicts-note-form \{([^}]+)\}/gmu)]
      .map(match => match[1]).join("\n");
    check("transparent popup backgrounds keep their opacity while the frame clips independently scrolling content and controls",
      /display: flex;/u.test(frameRule) && /overflow: hidden;/u.test(frameRule)
        && /background: var\(--hoshidicts-popup-background\);/u.test(frameRule)
        && /--hoshidicts-background-opacity: var\(\s*--gsm-hoshidicts-popup-opacity,\s*85%\s*\)/u.test(frameRule)
        && /--hoshidicts-chrome-background: color-mix\([^;]+var\(--hoshidicts-background-opacity\)[^;]+transparent\s*\)/u.test(frameRule)
        && [scrollRule, toolbarRule, noteRule].every(rule => /min-height: 0;/u.test(rule) && /overflow-y: auto;/u.test(rule))
        && /flex: 1 1 0;/u.test(scrollRule) && /max-height: 50%;/u.test(toolbarRule)
        && /flex: 0 0 auto;/u.test(noteRule) && /max-height: 80%;/u.test(noteRule)
        && !/position: sticky;/u.test(toolbarRule));
    const tagRule = readerCss.match(/^\.gsm-hoshidicts-tag \{([^}]+)\}/mu)?.[1];
    const definitionTagRule = readerCss.match(/^\.gsm-hoshidicts-tag-definition \{([^}]+)\}/mu)?.[1];
    const metadataValueRules = ["tag-frequency", "pitch-source"].map(kind => [...readerCss
      .matchAll(new RegExp(`^\\.gsm-hoshidicts-${kind} \\{([^}]+)\\}`, "gmu"))].map(match => match[1]).join("\n"));
    check("pronunciation and frequency values use the theme foreground while filled definition badges retain their paired foreground",
      /color: var\(--text-color\);/u.test(tagRule)
        && metadataValueRules.every(rule => /color: var\(--text-color\);/u.test(rule))
        && /--pronunciation-annotation-color: var\(--text-color\);/u.test(readerCss)
        && /color: var\(--hoshidicts-tag-text\);/u.test(definitionTagRule)
        && /--text-color: var\(--hoshidicts-text\);/u.test(readerCss)
        && /--hoshidicts-text: var\(--hoshidicts-palette-base-content\);/u.test(readerCss));
    // Yomitan's tag categories (#426) on each palette's colour and content pair.
    const categoryRule = category => readerCss.match(new RegExp(
      `^\\.gsm-hoshidicts-tag-definition\\[data-category="${category}"\\] \\{([^}]+)\\}`, "mu"))?.[1] ?? "";
    check("definition tags take their tag-bank category's palette pair; an archaism is tinted and other categories stay neutral",
      [["expression", "expression", "secondary"], ["partOfSpeech", "part-of-speech", "accent"],
        ["popular", "popular", "primary"], ["frequent", "frequent", "info"]].every(([category, token, role]) =>
        categoryRule(category).includes(`background: var(--tag-${token}-background-color);`)
          && categoryRule(category).includes(`color: var(--hoshidicts-tag-${token}-text);`)
          && readerCss.includes(`--tag-${token}-background-color: var(--hoshidicts-palette-${role});`)
          && readerCss.includes(`--hoshidicts-tag-${token}-text: var(--hoshidicts-palette-${role}-content);`))
        && /border: 1px solid var\(--hoshidicts-palette-error\);/u.test(categoryRule("archaism"))
        && /background: color-mix\(in srgb, var\(--hoshidicts-palette-error\) 12%, var\(--hoshidicts-palette-base-100\)\);/u
          .test(categoryRule("archaism"))
        && /color: var\(--text-color\);/u.test(categoryRule("archaism"))
        && ["default", "dictionary", "name"].every(category => categoryRule(category) === ""));
    const metadataDefaults = {
      averageFrequency: false, showFrequencyDictionaryNames: false,
      showPitchAccentFurigana: true, pitchAccentFuriganaDictionary: "",
      showPitchAccentBadge: true, showPitchAccentDictionaryNames: true, showPitchAccentText: true,
      showPitchAccentPosition: true, showPitchAccentGraph: false, showPitchAccentColors: false, hidePopupGrammarTags: true,
    };
    const metadataAccepted = [];
    const metadataRejected = [];
    for (const [key, value] of Object.entries(metadataDefaults)) {
      await local.set({ options: saved.options });
      const desired = typeof value === "boolean" ? !value : "Pitch: 辞書";
      const reply = await send(message({ [key]: desired }));
      const noOp = await send(message({ [key]: desired }, { baseRevision: 3 }));
      metadataAccepted.push(reply.ok === true && reply.options?.[key] === desired
        && reply.options.revision === 3 && noOp.options?.revision === 3);
      await local.set({ options: saved.options });
      const invalid = await send(message({ [key]: typeof value === "boolean" ? "true" : {} }));
      metadataRejected.push(invalid.ok === false && await unchanged(saved));
    }
    check("metadata preferences preserve current defaults and use strict sparse idempotent options CAS",
      Object.entries(metadataDefaults).every(([key, value]) => reader.normaliseOptions({})[key] === value
        && !Object.hasOwn(reader.projectStoredOptions({}), key))
        && metadataAccepted.every(Boolean) && metadataRejected.every(Boolean),
      JSON.stringify({ metadataAccepted, metadataRejected }));
    const plain = reader.normaliseOptions({ modifier: "none" });
    const held = reader.normaliseOptions({ modifier: "ctrl" });
    const explicit = reader.projectStoredOptions({ modifier: "alt", lookupMode: "hover", activationKey: "K" });
    const legacyPatch = reader.validateOptionsPatch({ modifier: "shift" });
    const invalidActivation = [
      { hoverEnabled: 1 }, { lookupMode: "always" }, { activationKey: "not a key" },
      { activationKey: "mouse2" }, { activationKey: "Mouse3" }, { activationKey: "mousemiddle" },
      { popupHideDelayMs: -1 }, { popupHideDelayMs: 5001 },
      { hidePopupOnCursorExit: 1 }, { hidePopupOnCursorExitDelayMs: -1 }, { hidePopupOnCursorExitDelayMs: 5001 },
    ].every((patch) => {
      try { reader.validateOptionsPatch(patch); return false; } catch { return true; }
    });
    // Yomitan's bit-index names are not Hachidori's: `mouse2` does not become a button.
    const buttons = ["MouseMiddle", "MouseBack", "MouseForward"];
    const buttonActivation = buttons.every(key => reader.normaliseOptions({ activationKey: key }).activationKey === key
        && reader.validateOptionsPatch({ activationKey: key }).activationKey === key)
      && ["mouse2", "Mouse3", "Middle"].every(key => reader.normaliseOptions({ activationKey: key }).activationKey === "Shift")
      && JSON.stringify(buttons.map(reader.activationLabel))
        === JSON.stringify(["the middle mouse button", "the Back mouse button", "the Forward mouse button"])
      && reader.activationLabel("Shift") === "Shift";
    check("reader activation options migrate legacy modes without competing policies and validate new fields",
      plain.hoverEnabled === true && plain.lookupMode === "hover" && plain.activationKey === "Shift"
        && plain.popupHideDelayMs === 160 && plain.hidePopupOnCursorExit === false
        && plain.hidePopupOnCursorExitDelayMs === 160 && held.lookupMode === "activation" && held.activationKey === "Control"
        && explicit.lookupMode === "hover" && explicit.activationKey === "K" && explicit.modifier === undefined
        && legacyPatch.lookupMode === "activation" && legacyPatch.activationKey === "Shift"
        && legacyPatch.modifier === undefined && invalidActivation && buttonActivation,
      JSON.stringify({ plain, held, explicit, legacyPatch, invalidActivation, buttonActivation }));
    const depths = [];
    for (const depth of [0, 2, Number.MAX_SAFE_INTEGER]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupNestingMaxDepth: depth }));
      depths.push(reply.ok === true && reply.options?.popupNestingMaxDepth === depth);
    }
    const badDepths = [];
    for (const depth of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupNestingMaxDepth: depth }));
      badDepths.push(reply.ok === false && await unchanged(saved));
    }
    check("nested lookup depth defaults to ten children and accepts zero through the safe-integer range via options CAS",
      reader.normaliseOptions({}).popupNestingMaxDepth === 10
        && depths.every(Boolean) && badDepths.every(Boolean), JSON.stringify({ depths, badDepths }));
    const columns = [];
    for (const count of [1, 2, 3, 4]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupColumns: count }));
      columns.push(reply.ok === true && reply.options?.popupColumns === count);
    }
    const badColumns = [];
    for (const count of [0, 5, 1.5, "2", null]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupColumns: count }));
      badColumns.push(reply.ok === false && await unchanged(saved));
    }
    check("definition columns default to one and accept only integers one through four via options CAS",
      reader.normaliseOptions({}).popupColumns === 1
        && columns.every(Boolean) && badColumns.every(Boolean), JSON.stringify({ columns, badColumns }));
    const summaryDefaults = reader.normaliseOptions({});
    const summaryAccepted = [];
    for (const count of [1, 3, 6]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ showCompactDefinitionSummary: true,
        compactDefinitionSummaryCount: count, compactDefinitionSummaryDictionary: "Personal source" }));
      summaryAccepted.push(reply.ok === true && reply.options?.showCompactDefinitionSummary === true
        && reply.options?.compactDefinitionSummaryCount === count
        && reply.options?.compactDefinitionSummaryDictionary === "Personal source");
    }
    const summaryRejected = [];
    for (const patch of [{ showCompactDefinitionSummary: 1 }, { compactDefinitionSummaryDictionary: null },
      ...[0, 7, 1.5, "3"].map(count => ({ compactDefinitionSummaryCount: count }))]) {
      await local.set({ options: saved.options });
      const reply = await send(message(patch));
      summaryRejected.push(reply.ok === false && await unchanged(saved));
    }
    check("compact summaries default off with three snippets and preserve a soft source preference through strict options CAS",
      summaryDefaults.showCompactDefinitionSummary === false && summaryDefaults.compactDefinitionSummaryCount === 3
        && summaryDefaults.compactDefinitionSummaryDictionary === ""
        && summaryAccepted.every(Boolean) && summaryRejected.every(Boolean),
      JSON.stringify({ summaryDefaults, summaryAccepted, summaryRejected }));
    const imageSources = [];
    for (const source of [null, { kind: "dictionary", title: "Images: 日本語" }, { kind: "tabGroup", id: "group:media" }]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupImageSource: source && { ...source, ignored: true } }));
      const noOp = await send(message({ popupImageSource: source }, { baseRevision: 3 }));
      imageSources.push(reply.ok === true && reply.options?.revision === 3
        && JSON.stringify(reply.options?.popupImageSource) === JSON.stringify(source)
        && noOp.ok === true && noOp.options?.revision === 3);
    }
    const invalidImageSources = [];
    for (const source of ["Images", 0, [], {}, { kind: "dictionary", title: "" },
      { kind: "dictionary", title: 2 }, { kind: "tabGroup", id: "" },
      { kind: "tabGroup", title: "group:media" }, { kind: "other", title: "Images" }]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupImageSource: source }));
      invalidImageSources.push(reply.ok === false && await unchanged(saved));
    }
    check("popup images default to Automatic and preserve canonical dictionary or stable group selection through strict idempotent CAS",
      reader.normaliseOptions({}).popupImageSource === null
        && !Object.hasOwn(reader.projectStoredOptions({}), "popupImageSource")
        && reader.normaliseOptions({ popupImageSource: { kind: "other" } }).popupImageSource === null
        && imageSources.every(Boolean) && invalidImageSources.every(Boolean),
      JSON.stringify({ imageSources, invalidImageSources }));
    const invalid = [
      { scanLength: "18" }, { scanLength: 0 }, { maxResults: 257 },
      { definitionBlurCountEnabled: "true" }, { definitionBlurEnabled: 1 }, { modifier: "meta" },
      { frequencyOrder: "sideways" }, { frequencyDictionary: {} },
      { kanjiClickDictionary: { title: "字", kind: "other" } },
      { kanjiClickDictionary: { title: "", kind: "kanji" } },
      { kanjiClickDictionary: { kind: "tabGroup", id: "" } },
      { kanjiClickDictionary: { kind: "tabGroup", title: "kanji-group" } },
    ];
    const rejected = [];
    for (const patch of invalid) {
      await local.set({ options: saved.options });
      const reply = await send(message(patch));
      rejected.push(reply.ok === false && reply.requestId === "options-contract" && await unchanged(saved));
    }
    await local.set({ options: saved.options });
    // Retired keys from an older Settings page: the removed hover delay is
    // ignored and the renamed blur switch migrates.
    const healthy = await send(message({ scanLength: 64, maxResults: 256, hoverDelayMs: 0, modifier: "alt",
      definitionBlurEnabled: true }));
    check("reader options reject malformed known fields without committing and accept a healthy follow-up",
      rejected.every(Boolean) && healthy.ok === true && healthy.options?.revision === 3
        && healthy.options?.scanLength === 64 && healthy.options?.maxResults === 256
        && !Object.hasOwn(healthy.options ?? {}, "hoverDelayMs") && healthy.options?.lookupMode === "activation"
        && healthy.options?.definitionBlurCountEnabled === true && !Object.hasOwn(healthy.options ?? {}, "definitionBlurEnabled")
        && healthy.options?.activationKey === "Alt" && healthy.options?.modifier === undefined,
      JSON.stringify({ rejected, healthy }));

    await local.set({ options: saved.options });
    const ignored = await send(message({ unknown: "ignored", revision: 999 }));
    const ignoredUnchanged = await unchanged(saved);
    const legacy = {
      revision: 2, scanLength: "20.9", maxResults: 900, modifier: "bad",
      hoverDelayMs: { toString: null }, definitionBlurEnabled: true,
      kanjiClickDictionary: { title: "旧名", kind: "kanji", ignored: true },
      unknown: "stored junk",
    };
    await local.set({ options: legacy });
    const conflict = await send(message({}, { baseRevision: 1 }));
    const conflictUnchanged = JSON.stringify((await local.get("options")).options) === JSON.stringify(legacy);
    const repaired = await send(message());
    const noOp = await send(message({}, { baseRevision: 3 }));
    check("reader options project unknown fields and repair legacy values at one newer revision",
      ignored.ok === true && ignored.options?.revision === 2 && ignored.options?.unknown === undefined
        && ignoredUnchanged && conflict.ok === false && conflict.conflict === true && conflictUnchanged
        && conflict.options?.unknown === undefined && conflict.options?.scanLength === 20
        && conflict.options?.maxResults === 256 && conflict.options?.lookupMode === "hover"
        && conflict.options?.modifier === undefined
        && conflict.options?.kanjiClickDictionary?.ignored === undefined
        && !Object.hasOwn(conflict.options ?? {}, "hoverDelayMs") && conflict.options?.frequencyOrder === undefined
        && conflict.options?.definitionBlurCountEnabled === true && !Object.hasOwn(conflict.options ?? {}, "definitionBlurEnabled")
        && repaired.ok === true
        && repaired.options?.revision === 3 && noOp.options?.revision === 3
        && JSON.stringify((await local.get("options")).options) === JSON.stringify(repaired.options),
      JSON.stringify({ ignored, ignoredUnchanged, conflict, conflictUnchanged, repaired, noOp }));

    await local.set({ options: { scanLength: 16 } });
    const missingRevision = await send(message({ scanLength: 16 }, { baseRevision: 0 }));
    const sparseUnchanged = JSON.stringify((await local.get("options")).options) === '{"scanLength":16}';
    await local.remove("options");
    const empty = await send(message({ unknown: true }, { baseRevision: 0 }));
    const absentUnchanged = (await local.get("options")).options === undefined;
    await local.set({ options: { revision: 3, scanLength: 16, unknown: "prune me" } });
    const stateCommit = await send({ target: "hoshidicts-worker", type: "hd_state_cas", baseRevision: 0, dictionaries: [] });
    const pruned = (await local.get("options")).options;
    check("reader option projection preserves sparse no-ops and repairs options inside dictionary CAS",
      missingRevision.ok === true && missingRevision.options?.revision === 0 && sparseUnchanged
        && empty.ok === true && empty.options?.revision === 0 && absentUnchanged
        && stateCommit.ok === true && pruned.revision === 4 && pruned.scanLength === 16
        && Object.keys(pruned).length === 2,
      JSON.stringify({ missingRevision, sparseUnchanged, empty, absentUnchanged, stateCommit, pruned }));
    await local.remove("dictionaryState");
    await local.set({ options: saved.options });

    // A clicked-kanji group reference is a stable ID, like an Image source
    // group: strict CAS keeps it exactly, a dictionary commit that keeps the
    // group leaves it alone, and removing the group resets the option.
    const groupRef = { kind: "tabGroup", id: "kanji-group" };
    const kanjiGroup = { id: "kanji-group", name: "Kanji", dictionaryIds: [] };
    const optionsRevision = async () => (await local.get("options")).options.revision;
    const stateCas = (baseRevision, groups) => send({ target: "hoshidicts-worker", type: "hd_state_cas", baseRevision, dictionaries: [], groups });
    const groupCreated = await stateCas(0, [kanjiGroup]);
    const groupWrite = await send(message({ kanjiClickDictionary: { ...groupRef, ignored: true } }, { baseRevision: await optionsRevision() }));
    const groupRepeat = await send(message({ kanjiClickDictionary: groupRef }, { baseRevision: groupWrite.options?.revision }));
    const groupRenamed = await stateCas(1, [{ ...kanjiGroup, name: "Kanji dictionaries" }]);
    const afterRename = (await local.get("options")).options;
    const groupRemoved = await stateCas(2, []);
    const afterRemoval = (await local.get("options")).options;
    const missingGroup = await send(message({ kanjiClickDictionary: { kind: "tabGroup", id: "never-created" } }, { baseRevision: afterRemoval.revision }));
    check("a clicked-kanji group reference passes strict options CAS, survives group edits and resets with the group's removal",
      groupCreated.ok === true && groupWrite.ok === true && groupRepeat.ok === true
        && JSON.stringify(groupWrite.options?.kanjiClickDictionary) === JSON.stringify(groupRef)
        && groupRepeat.options?.revision === groupWrite.options?.revision
        && groupRenamed.ok === true && JSON.stringify(afterRename) === JSON.stringify(groupWrite.options)
        && groupRemoved.ok === true && afterRemoval.kanjiClickDictionary === ""
        && afterRemoval.revision === groupWrite.options.revision + 1
        && missingGroup.ok === true && missingGroup.options?.kanjiClickDictionary === "",
      JSON.stringify({ groupCreated, groupWrite, groupRepeat, groupRenamed, afterRename, groupRemoved, afterRemoval, missingGroup }));
    await local.remove("dictionaryState");
    await local.set({ options: saved.options });

    const exact = message({}, { padding: "猫\\\"" });
    exact.padding += "x".repeat(frameLimit - bytes(exact));
    const atLimit = await send(exact);
    const beyond = await send({ ...exact, padding: `${exact.padding}x` });
    const objectId = await send(message({ scanLength: 19 }, { requestId: {} }));
    const largeId = await send(message({ scanLength: 19 }, { requestId: "猫".repeat(frameLimit) }));
    let failureSerializations = 0;
    let failureEncodedUnits = 0;
    const failureContext = createContext({
      TextEncoder: class {
        encode(value) {
          failureEncodedUnits += value.length;
          return new TextEncoder().encode(value);
        }
      },
      JSON: { stringify(value) { failureSerializations += 1; return JSON.stringify(value); } },
    });
    runInContext(readFileSync(resolve(EXTENSION, "response-limits.js"), "utf8")
      .replace(/^export\s+/gmu, ""), failureContext);
    const oversizedFailure = failureContext.boundResponseFailure({
      type: "hd_options_write_result", requestId: "x".repeat(frameLimit), ok: false,
      error: failureContext.responseLimitError("hd_options_write_result"),
    });
    const identicalFailurePasses = failureSerializations;
    failureSerializations = 0;
    const shrinkableFailure = failureContext.boundResponseFailure({
      type: "hd_options_write_result", requestId: "keep-me", ok: false, error: "x".repeat(frameLimit),
    });
    check("reader option request framing counts the complete UTF-8 envelope and bounds failure correlation",
      bytes(exact) === frameLimit && atLimit.ok === true && beyond.ok === false
        && bytes(beyond) <= frameLimit && beyond.requestId === "options-contract"
        && objectId.ok === false && objectId.requestId === null
        && largeId.ok === false && largeId.requestId === null && bytes(largeId) <= frameLimit
        && oversizedFailure.requestId === null && identicalFailurePasses === 1
        && shrinkableFailure.requestId === "keep-me" && failureSerializations === 2
        && failureEncodedUnits === 0
        && await unchanged(saved),
      JSON.stringify({ exactBytes: bytes(exact), atLimit: atLimit.ok, beyond: beyond.ok,
        objectId: objectId.ok, largeId: largeId.ok, largeReplyBytes: bytes(largeId),
        identicalFailurePasses, shrinkableFailurePasses: failureSerializations, failureEncodedUnits }));

    const next = { revision: 10, scanLength: 17, frequencyDictionary: "猫\\\"" };
    const expectedReply = { type: "hd_options_write_result", requestId: "options-contract", ok: true, error: null, options: next };
    next.frequencyDictionary += "x".repeat(frameLimit - bytes(expectedReply));
    const oversizedStored = { ...next, revision: 9, scanLength: 16, frequencyDictionary: `${next.frequencyDictionary}x` };
    await local.set({ options: oversizedStored });
    const overflowReply = await send(message({ scanLength: 17 }, { baseRevision: 9 }));
    const rejectedBeforeCommit = JSON.stringify((await local.get("options")).options) === JSON.stringify(oversizedStored);
    await local.set({ options: { ...next, revision: 9, scanLength: 16 } });
    const conflictBefore = await local.get("options");
    const conflictOverflow = await send(message({}, { baseRevision: 8 }));
    const conflictDidNotWrite = JSON.stringify(await local.get("options")) === JSON.stringify(conflictBefore);
    const fittingReply = await send(message({ scanLength: 17 }, { baseRevision: 9 }));
    check("reader options preflight exact success and conflict frames before any storage commit",
      bytes(expectedReply) === frameLimit && overflowReply.ok === false && rejectedBeforeCommit
        && overflowReply.options === undefined && bytes(overflowReply) <= frameLimit
        && conflictOverflow.ok === false && conflictOverflow.options === undefined && conflictDidNotWrite
        && bytes(conflictOverflow) <= frameLimit && fittingReply.ok === true
        && fittingReply.options?.revision === 10 && bytes(fittingReply) === frameLimit,
      JSON.stringify({ expectedBytes: bytes(expectedReply), overflow: overflowReply.ok, rejectedBeforeCommit,
        conflictReplyBytes: bytes(conflictOverflow), conflictDidNotWrite,
        fitting: fittingReply.ok, fittingBytes: bytes(fittingReply) }));
  } finally {
    await local.set({ options: saved.options });
    if (saved.dictionaryState === undefined) await local.remove("dictionaryState");
    else await local.set({ dictionaryState: saved.dictionaryState });
  }
}

// Values that more than one step uses; the step that creates each one assigns it.
let idb, bus, storage, alarms, offscreenChrome, swChrome, swContext, pageChrome,
  writeReaderOptions, counter, engineService, formerArchiveByteLimit, createHoshidicts,
  forwardedLowRam, observedEngine, peakLoadedDictionaryPaths, transactionCounts, nativeCounts,
  loseNextStateCasReply, failAfterCommittedRevision, advanceGroupsAfterCommittedRevision,
  advancedStateDuringCleanup, advancePresentationBeforeStateCas,
  advancedPresentationDuringConflict, storedDictionaryState, zip, importedPackage, expressions;

function setPeakLoadedDictionaryPaths(value) {
  peakLoadedDictionaryPaths = value;
}

function setLoseNextStateCasReply(value) {
  loseNextStateCasReply = value;
}

function setFailAfterCommittedRevision(value) {
  failAfterCommittedRevision = value;
}

function setAdvanceGroupsAfterCommittedRevision(value) {
  advanceGroupsAfterCommittedRevision = value;
}

function setAdvancePresentationBeforeStateCas(value) {
  advancePresentationBeforeStateCas = value;
}

async function request(type, fields = {}) {
  counter += 1;
  return pageChrome.runtime.sendMessage({
    target: "hoshidicts-offscreen",
    type,
    requestId: `${type.replace(/^hd_/u, "")}-${counter}`,
    ...fields,
  });
}

describe("engine: boot and import", () => {
  test("offscreen and engine sources", async () => {
    // Only chrome.runtime exists in an offscreen document. A path that is never
    // exercised below would still be a boot failure in a browser, so this is a
    // static check as well as a runtime one.
    const offscreenSource = readFileSync(resolve(EXTENSION, "offscreen.js"), "utf8");
    const offscreenApis = [...offscreenSource.matchAll(/\bchrome\.([A-Za-z_$][\w$]*)/gu)].map((m) => m[1]);
    check(
      "offscreen.js uses no chrome API beyond chrome.runtime",
      offscreenApis.every((api) => api === "runtime"),
      [...new Set(offscreenApis)].join(", "),
    );
    check(
      "dictionary storage relies on unlimitedStorage without a redundant persistence request",
      EXTENSION_MANIFEST.permissions?.includes("unlimitedStorage") === true
        && !offscreenSource.includes("navigator.storage.persist"),
      JSON.stringify({
        permissions: EXTENSION_MANIFEST.permissions,
        requestsPersistentStorage: offscreenSource.includes("navigator.storage.persist"),
      }),
    );
    check(
      "runtime selection depends on capabilities rather than stored dictionaries",
      !offscreenSource.includes("hd_dicts_read") && !offscreenSource.includes("opfsDictionaryTitles"),
      "offscreen.js still contains legacy-storage selection logic",
    );
    check(
      "the offscreen bridge places a hard bound on pending engine requests",
      /pending\.size\s*>=\s*MAX_PENDING_REQUESTS/u.test(offscreenSource)
        && /message\??\.type\s*===\s*"hd_status"/u.test(offscreenSource),
      "offscreen.js does not cap its pending map while preserving status replies",
    );
    const probePath = resolve(EXTENSION, "opfs-capability-worker.js");
    const probeSource = existsSync(probePath) ? readFileSync(probePath, "utf8") : "";
    check(
      "threaded selection probes the exact OPFS primitives WasmFS needs",
      offscreenSource.includes("opfs-capability-worker.js")
        && probeSource.includes("createSyncAccessHandle")
        && probeSource.includes(".move("),
      "the direct-OPFS path lacks a worker-side sync-access and move probe",
    );
    check(
      "the OPFS probe uses collision-resistant temporary names",
      probeSource.includes("crypto.randomUUID()") && !probeSource.includes("Math.random()"),
      "the OPFS probe still derives a temporary path from Math.random()",
    );
    const engineServiceSource = readFileSync(resolve(EXTENSION, "engine-service.js"), "utf8");
    check(
      "fallback imports keep scratch archives outside the dictionary-title namespace",
      engineServiceSource.includes('const IMPORT_ZIP = "/.hdw-archive.zip";')
        && engineServiceSource.includes("const OPFS_IMPORT_ZIP = `${DICT_ROOT}/.hdw-archive.zip`;"),
      "the fallback import archive can collide with a dictionary title",
    );
    const bindingsSource = readFileSync(resolve(ROOT, "wasm/bindings.cpp"), "utf8");
    check(
      "the OPFS durability barrier opens writable sync-access handles before fsync",
      /open\(path\.c_str\(\), O_RDWR\)/u.test(bindingsSource)
        && !/open\(path\.c_str\(\), O_RDONLY\)/u.test(bindingsSource),
      "flush_file can still select WasmFS's non-flushing Blob path",
    );
    check(
      "replacement commit state remains outside the backup being deleted",
      bindingsSource.includes("destination / NEW_COMMITTED")
        && !bindingsSource.includes("aside / NEW_COMMITTED"),
      "the durable replacement marker is not anchored in the destination",
    );
  });

  step("reader options use serialized revision-checked patches", async () => {
    idb = installFakeIndexedDB();
    installFetch();
    installNavigator();

    bus = makeBus();
    storage = makeStorage();
    alarms = makeAlarms();

    // offscreen.js is a real ES module, so it reads `chrome` off the shared global;
    // the scripts loaded into a vm context get their own chrome.
    //
    // A real offscreen document is granted chrome.runtime and nothing else --
    // Object.keys(chrome) there is csi,loadTimes,runtime, and getContexts is absent
    // too. Withholding the rest is what lets this harness catch a call that only
    // fails in a browser: offscreen.js reading chrome.storage.local looked correct
    // here for as long as the fake handed it one.
    offscreenChrome = makeChrome("offscreen", bus, storage, alarms);
    delete offscreenChrome.storage;
    delete offscreenChrome.offscreen;
    delete offscreenChrome.runtime.getContexts;
    globalThis.chrome = offscreenChrome;

    swChrome = makeChrome("sw", bus, storage, alarms);
    swContext = loadBackgroundScript({
      chrome: swChrome,
      console,
      fetch: globalThis.fetch,
      setTimeout,
      clearTimeout,
      Promise,
      Error,
      JSON,
      String,
      Number,
      Boolean,
      Object,
      Array,
      RegExp,
      Math,
      Date,
      URL,
    });

    pageChrome = makeChrome("page", bus, storage, alarms);
    writeReaderOptions = (baseRevision, options) => pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision,
      options,
    });
    const firstOptions = await writeReaderOptions(0, { scanLength: 12, maxResults: 24 });
    const [nextOptions, conflictingOptions] = await Promise.all([
      writeReaderOptions(1, { scanLength: 18 }),
      writeReaderOptions(1, { maxResults: 48 }),
    ]);
    const unchangedOptions = await writeReaderOptions(2, { scanLength: 18 });
    const unversionedOptions = await writeReaderOptions(undefined, { scanLength: 2 });
    check(
      "reader options use serialized revision-checked patches and preserve unchanged revisions",
      firstOptions.ok === true && firstOptions.options?.revision === 1
        && nextOptions.ok === true && nextOptions.options?.revision === 2
        && nextOptions.options?.maxResults === 24
        && conflictingOptions.ok === false && conflictingOptions.conflict === true
        && conflictingOptions.options?.scanLength === 18
        && conflictingOptions.options?.maxResults === 24
        && unchangedOptions.ok === true && unchangedOptions.options?.revision === 2
        && unversionedOptions.ok === false,
      JSON.stringify({ firstOptions, nextOptions, conflictingOptions, unchangedOptions, unversionedOptions }),
    );
  });

  step("reader options transport", async () => {
    await checkReaderOptionsTransport(pageChrome, storage);
  });

  step("an actual streamed body crosses the former fixed byte cap", async () => {
    counter = 0;

    await import(`file://${mjs.replace(/\\/gu, "/")}`); // fail fast if the bundle is broken
    engineService = await import(
      `file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}`
    );
    formerArchiveByteLimit = 536870912;
    const streamChunk = new Uint8Array(1024 * 1024);
    let streamRemaining = formerArchiveByteLimit + 1;
    let streamedBytes = 0;
    let streamWrites = 0;
    let streamedPath = null;
    let streamClosed = false;
    let streamed = null;
    let streamError = null;
    try {
      streamed = await engineService.streamResponseToFile(
        { FS: {
          open: (path) => ({ fd: 7, path }),
          // WasmFS FS.write copies byte by byte from JavaScript, so the body must
          // arrive as one write rather than one per stream chunk.
          write(stream, data, offset, length) {
            streamWrites += 1;
            streamedPath = stream.path;
            streamedBytes += length - offset;
            return length;
          },
          close() {
            streamClosed = true;
          },
        } },
        {
          body: {
            getReader: () => ({
              async read() {
                if (streamRemaining === 0) return { done: true, value: undefined };
                const value = streamRemaining >= streamChunk.byteLength
                  ? streamChunk
                  : streamChunk.subarray(0, streamRemaining);
                streamRemaining -= value.byteLength;
                return { done: false, value };
              },
            }),
          },
        },
        "/streamed-boundary.zip",
      );
    } catch (error) {
      streamError = error;
    }
    equal(
      "an actual streamed body crosses the former fixed byte cap",
      [streamError?.message ?? null, streamed, streamedBytes, streamWrites, streamedPath, streamClosed],
      [null, formerArchiveByteLimit + 1, formerArchiveByteLimit + 1, 1, "/streamed-boundary.zip", true],
    );
  });

  step("boot and relay", async () => {
    ({ default: createHoshidicts } = await import(
      `file://${resolve(EXTENSION, "vendor", "hoshidicts.mjs").replace(/\\/gu, "/")}?service`
    ));
    forwardedLowRam = null;
    observedEngine = null;
    let loadedDictionaryPaths = new Set();
    peakLoadedDictionaryPaths = 0;
    transactionCounts = {
      nativeImports: 0,
      stateReads: 0,
      stateCasAttempts: 0,
      durableFilesystemWrites: 0,
    };
    nativeCounts = { resets: 0, adds: 0, removes: 0, reorders: 0, lookups: 0 };
    const createObservedHoshidicts = async (...args) => {
      const module = await createHoshidicts(...args);
      observedEngine = module;
      const ccall = module.ccall.bind(module);
      module.ccall = (name, returnType, argumentTypes, argumentValues) => {
        if (name === "hdw_import") {
          forwardedLowRam = argumentValues[2];
          transactionCounts.nativeImports += 1;
        }
        const result = ccall(name, returnType, argumentTypes, argumentValues);
        if (name === "hdw_reset") {
          nativeCounts.resets += 1;
          loadedDictionaryPaths = new Set();
        } else if (name === "hdw_add_dict" && result) {
          nativeCounts.adds += 1;
          loadedDictionaryPaths.add(argumentValues[0]);
          peakLoadedDictionaryPaths = Math.max(
            peakLoadedDictionaryPaths,
            loadedDictionaryPaths.size,
          );
        } else if (name === "hdw_remove_dict" && result) {
          nativeCounts.removes += 1;
          loadedDictionaryPaths.delete(argumentValues[0]);
        } else if (name === "hdw_set_dict_order" && result) {
          nativeCounts.reorders += 1;
        } else if (name === "hdw_lookup") {
          nativeCounts.lookups += 1;
        }
        return result;
      };
      const syncfs = module.FS.syncfs.bind(module.FS);
      module.FS.syncfs = (populate, callback) => {
        if (!populate) transactionCounts.durableFilesystemWrites += 1;
        return syncfs(populate, callback);
      };
      return module;
    };
    loseNextStateCasReply = false;
    failAfterCommittedRevision = null;
    advanceGroupsAfterCommittedRevision = null;
    advancedStateDuringCleanup = null;
    advancePresentationBeforeStateCas = null;
    advancedPresentationDuringConflict = null;
    engineService.configureEngineService(
      async (message) => {
        if (message.type === "hd_state_read") transactionCounts.stateReads += 1;
        if (message.type === "hd_state_cas") transactionCounts.stateCasAttempts += 1;
        if (message.type === "hd_state_cas"
            && advancePresentationBeforeStateCas !== null
            && message.dictionaries?.some((dictionary) =>
              dictionary.id === advancePresentationBeforeStateCas.targetId
                && dictionary.revision === advancePresentationBeforeStateCas.candidateRevision)) {
          const advance = advancePresentationBeforeStateCas;
          advancePresentationBeforeStateCas = null;
          const current = await offscreenChrome.runtime.sendMessage({
            target: "hoshidicts-worker",
            type: "hd_state_read",
          });
          advancedPresentationDuringConflict = await offscreenChrome.runtime.sendMessage({
            target: "hoshidicts-worker",
            type: "hd_state_cas",
            baseRevision: current.state.revision,
            dictionaries: current.state.dictionaries.map((dictionary) =>
              dictionary.id === advance.targetId
                ? { ...dictionary, ...advance.patch }
                : dictionary),
            groups: current.state.groups,
          });
        }
        const reply = await offscreenChrome.runtime.sendMessage(message);
        if (message.type === "hd_state_cas"
            && reply?.ok === true
            && advanceGroupsAfterCommittedRevision !== null
            && reply.state?.dictionaries?.some(
              (dictionary) => dictionary.revision === advanceGroupsAfterCommittedRevision.revision,
            )) {
          const advance = advanceGroupsAfterCommittedRevision;
          advanceGroupsAfterCommittedRevision = null;
          advancedStateDuringCleanup = await offscreenChrome.runtime.sendMessage({
            target: "hoshidicts-worker",
            type: "hd_state_cas",
            baseRevision: reply.state.revision,
            dictionaries: reply.state.dictionaries,
            groups: advance.groups,
          });
        }
        if (loseNextStateCasReply && message.type === "hd_state_cas") {
          loseNextStateCasReply = false;
          throw new Error("injected lost CAS reply");
        }
        if (message.type === "hd_state_cas"
            && reply?.ok === true
            && failAfterCommittedRevision !== null
            && reply.state?.dictionaries?.some(
              (dictionary) => dictionary.revision === failAfterCommittedRevision.revision,
            )) {
          storage.failNextSet(failAfterCommittedRevision.error);
          failAfterCommittedRevision = null;
        }
        return reply;
      },
      { createHoshidicts: createObservedHoshidicts, storageBackend: "idbfs", lowRam: true },
    );
    engineService.startEngine();
    offscreenChrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.target !== "hoshidicts-offscreen" || message.relayed !== true) return false;
      engineService.handleEngineMessage(message).then(sendResponse);
      return true;
    });

    section("boot and relay");
    let status = await request("hd_status");
    equal("hd_status replies with the contract-C envelope", Object.keys(status).sort(), [
      "dictionaryCount",
      "dictionaryEntryStorage",
      "dictionaryIndexStorage",
      "error",
      "failedDictionaries",
      "generation",
      "hashIndexStorage",
      "lastLoadPath",
      "loading",
      "lowMemory",
      "ok",
      "packageCount",
      "pagedDictionaries",
      "ready",
      "registeredKindCount",
      "requestId",
      "residentHashBudgetBytes",
      "storageBackend",
      "threaded",
      "type",
      "useLessRamByDefault",
    ]);
    check("hd_status echoes the requestId", status.requestId === "status-1", JSON.stringify(status));
    check(
      "the fallback reports single-thread IDBFS with dictionary entries in memory",
      status.storageBackend === "idbfs" && status.threaded === false && status.pagedDictionaries === false,
      JSON.stringify(status),
    );

    const deadline = Date.now() + 30000;
    while (!(status.ok && status.ready && !status.loading) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 25));
      status = await request("hd_status");
    }
    check("the engine reaches ready", status.ready === true, JSON.stringify(status));
    check("the offscreen document was created exactly once", offscreenState.created === 1, `created ${offscreenState.created}`);
    check(
      "createDocument was never called concurrently",
      offscreenState.peakConcurrent <= 1,
      `peak ${offscreenState.peakConcurrent}`,
    );
    check(
      "background.js stamps relayed on the forwarded copy only",
      bus.log.some((row) => row.from === "sw" && row.relayed) &&
        bus.log.every((row) => row.from !== "page" || !row.relayed),
      JSON.stringify(bus.log.slice(0, 6)),
    );
    const originalWorkerSend = swChrome.runtime.sendMessage;
    swChrome.runtime.sendMessage = (message) => message.relayed && ["hd_lookup", "hd_media"].includes(message.type)
      ? Promise.reject(new Error("long relay failure ".repeat(20))) : originalWorkerSend(message);
    try {
      const relayCases = [];
      for (const [type, responseLimit] of [["hd_lookup", 32 * 1024 * 1024], ["hd_media", 6 * 1024 * 1024]]) {
        const sendFailed = (requestId) => pageChrome.runtime.sendMessage({
          target: "hoshidicts-offscreen", type, text: "食", requestId,
        });
        const oversized = await sendFailed("x".repeat(responseLimit));
        const invalid = await sendFailed({});
        const compact = { ...oversized, requestId: "" };
        const exactId = "x".repeat(responseLimit - Buffer.byteLength(JSON.stringify(compact)));
        const correlated = await sendFailed(exactId);
        relayCases.push(oversized.ok === false && oversized.requestId === null && invalid.requestId === null
          && correlated.ok === false && correlated.requestId === exactId
          && correlated.error === compact.error
          && Buffer.byteLength(JSON.stringify(correlated)) === responseLimit);
      }
      check(
        "service-worker relay failures use the shared bounded lookup and media correlation rule",
        relayCases.every(Boolean), JSON.stringify(relayCases),
      );
    } finally {
      swChrome.runtime.sendMessage = originalWorkerSend;
    }
  });

  step("storage ownership: an empty profile has revisioned dictionary state", async () => {
    section("storage ownership and hd_import");
    // The engine's view of this key goes offscreen -> worker -> chrome.storage,
    // while this harness can inspect the worker-owned storage map directly.
    storedDictionaryState = async () =>
      (await storage.api().local.get("dictionaryState")).dictionaryState;
    equal("an empty profile has revisioned dictionary state", await storedDictionaryState(), {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [],
      groups: [],
    });
    const readBack = await pageChrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_read" });
    equal(
      "the service worker answers hd_state_read without relaying it",
      [readBack?.ok, readBack?.state, bus.log.some((row) => row.type === "hd_state_read" && row.relayed)],
      [true, { schemaVersion: 1, revision: 1, dictionaries: [], groups: [] }, false],
    );
  });

  step("hd_engine_config: the engine's own options and their pushes", async () => {
    // hd_engine_config: the offscreen document reads the engine's own option;
    // a page cannot, and a change to the stored option is pushed to the document.
    const engineConfigSender = { id: swChrome.runtime.id, url: swChrome.runtime.getURL("offscreen.html") };
    const readEngineConfig = (sender) => bus.sendMessage("offscreen-config", {
      target: "hoshidicts-worker", type: "hd_engine_config", requestId: "engine-config",
    }, sender);
    const configFromPage = await readEngineConfig({ id: swChrome.runtime.id, url: swChrome.runtime.getURL("settings.html") });
    const pushFromPage = await pageChrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_engine_config", lowMemoryMode: true });
    const configOff = await readEngineConfig(engineConfigSender);
    const optionsBeforeLowMemory = (await storage.api().local.get("options")).options;
    const pushesBefore = bus.log.filter((row) => row.type === "hd_engine_config" && row.from === "sw").length;
    const lowMemoryWrite = await writeReaderOptions(optionsBeforeLowMemory.revision, { lowMemoryMode: true });
    const enginePushes = () => bus.log.filter((row) => row.type === "hd_engine_config" && row.from === "sw").length;
    for (let attempt = 0; attempt < 50 && enginePushes() === pushesBefore; attempt += 1) {
      await new Promise((done) => setTimeout(done, 2));
    }
    const configOn = await readEngineConfig(engineConfigSender);
    // An unrelated option write does not push.
    const unrelatedWrite = await writeReaderOptions(lowMemoryWrite.options.revision, { scanLength: 20 });
    await new Promise((done) => setTimeout(done, 20));
    const pushesAfterUnrelated = enginePushes();
    const entryStorageWrite = await writeReaderOptions(unrelatedWrite.options.revision, { dictionaryEntryStorage: "resident" });
    for (let attempt = 0; attempt < 50 && enginePushes() === pushesAfterUnrelated; attempt += 1) {
      await new Promise((done) => setTimeout(done, 2));
    }
    const residentConfig = await readEngineConfig(engineConfigSender);
    check(
      "hd_engine_config is read by the engine host only and pushed when the option changes",
      configFromPage?.ok === false
        && pushFromPage?.ok === false
        && configOff?.ok === true && configOff.lowMemoryMode === false && configOff.dictionaryEntryStorage === "auto"
        && configOff.useLessRamByDefault === false
        && lowMemoryWrite.ok === true
        && configOn?.ok === true && configOn.lowMemoryMode === true
        && unrelatedWrite.ok === true
        && pushesAfterUnrelated === pushesBefore + 1
        && entryStorageWrite.ok === true && enginePushes() === pushesAfterUnrelated + 1
        && residentConfig?.dictionaryEntryStorage === "resident" && residentConfig.lowMemoryMode === true,
      JSON.stringify({ configFromPage, pushFromPage, configOff, configOn, residentConfig, pushesBefore, pushesAfterUnrelated }),
    );
    const pushesBeforeLessRam = enginePushes();
    const lessRamWrite = await writeReaderOptions(entryStorageWrite.options.revision, { useLessRamByDefault: true });
    for (let attempt = 0; attempt < 50 && enginePushes() === pushesBeforeLessRam; attempt += 1) {
      await new Promise((done) => setTimeout(done, 2));
    }
    const lessRamConfig = await readEngineConfig(engineConfigSender);
    check("changing only the RAM default pushes the engine configuration",
      lessRamWrite.ok === true && enginePushes() === pushesBeforeLessRam + 1
        && lessRamConfig.useLessRamByDefault === true && lessRamConfig.lowMemoryMode === true
        && lessRamConfig.dictionaryEntryStorage === "resident",
      JSON.stringify({ lessRamConfig, pushesBeforeLessRam, pushesAfter: enginePushes() }));
    await writeReaderOptions(lessRamWrite.options.revision, { lowMemoryMode: false, useLessRamByDefault: true,
      dictionaryEntryStorage: "auto", scanLength: optionsBeforeLowMemory.scanLength ?? 16 });
  });

  step("hd_import of the fixture", async () => {
    zip = new Uint8Array(await readFile(FIXTURE));
    const blobUrl = createObjectURL(zip);
    const imported = await request("hd_import", { blobUrl, fileName: "hachidori-fixture.zip", lowRam: false });
    check("hd_import succeeds", imported.ok === true, JSON.stringify(imported));
    equal("hd_import forwards its request-level lowRam override", forwardedLowRam, 0);
    equal("hd_import_result carries the full ImportReport", Object.keys(imported.report ?? {}).sort(), [
      "error",
      "frequencyCount",
      "kanjiCount",
      "mediaCount",
      "metaCount",
      "missingResourceCount",
      "pitchCount",
      "skippedRecordCount",
      "success",
      "termCount",
      "title",
      "unreadableResourceCount",
      "unresolvedRedirectCount",
    ]);
    equal(
      "the report counts match the fixture baseline",
      [
        imported.report.title,
        imported.report.termCount,
        imported.report.metaCount,
        imported.report.frequencyCount,
        imported.report.pitchCount,
        imported.report.kanjiCount,
        imported.report.mediaCount,
      ],
      [
        EXPECTED.title,
        EXPECTED.termCount,
        EXPECTED.metaCount,
        EXPECTED.frequencyCount,
        EXPECTED.pitchCount,
        EXPECTED.kanjiCount,
        EXPECTED.mediaCount,
      ],
    );
  });

  step("the import writes one logical package; hd_memory", async () => {
    // The fixture carries four engine capabilities, but it is one installed
    // package. The native dictionaryCount below deliberately remains four.
    const importedState = await storedDictionaryState();
    importedPackage = importedState?.dictionaries?.[0];
    check(
      "the import writes one logical dictionary package with complete metadata",
      importedState?.schemaVersion === 1
        && Number.isInteger(importedState.revision)
        && importedState.revision > 0
        && importedState.dictionaries.length === 1
        && JSON.stringify(Object.keys(importedPackage ?? {}).sort()) === JSON.stringify(DICTIONARY_PACKAGE_KEYS)
        && /^[0-9a-f]{32}$/u.test(importedPackage?.id ?? "")
        && importedPackage.title === FIXTURE_TITLE
        && importedPackage.displayName === null
        && ownedGenerationRoot(importedPackage.path, FIXTURE_TITLE) !== ""
        && importedPackage.enabled === true
        && importedPackage.favorite === false
        && importedPackage.revision === "test-1"
        && importedPackage.isUpdatable === false
        && importedPackage.indexUrl === null
        && importedPackage.downloadUrl === null
        && importedPackage.language === "ja"
        && importedPackage.termCount === EXPECTED.termCount
        && importedPackage.frequencyCount === EXPECTED.frequencyCount
        && importedPackage.pitchCount === EXPECTED.pitchCount
        && importedPackage.kanjiCount === EXPECTED.kanjiCount
        && importedPackage.mediaCount === EXPECTED.mediaCount
        && typeof importedPackage.installedAt === "string"
        && Number.isFinite(Date.parse(importedPackage.installedAt))
        && importedPackage.lastUpdateCheck === null,
      JSON.stringify(importedState),
    );
    const afterLogicalImport = await request("hd_status");
    equal("one logical package loads all four native capabilities", afterLogicalImport.dictionaryCount, 4);
    check("syncfs(false) wrote the dictionary to IndexedDB", idb.count("/dicts") > 0, `${idb.count("/dicts")} rows in ${idb.names()}`);

    // hd_memory: the heap, and each loaded package's resident file bytes once,
    // however many native kinds it loads as (the fixture package loads under
    // four, which share one copy). media.bin stays on disk.
    const memory = await request("hd_memory");
    const fileSize = (name) => {
      try { return observedEngine.FS.stat(`${importedPackage.path}/${name}`).size; } catch { return 0; }
    };
    const residentFileBytes = ["hash.table", "bloom.filter", "blobs.bin", "media.idx", "scan.idx", "dict.zstd"]
      .reduce((sum, name) => sum + fileSize(name), 0);
    check(
      "hd_memory reports the heap and each loaded package's resident bytes once",
      memory.ok === true
        && Number.isInteger(memory.heapBytes)
        && memory.heapBytes === observedEngine.HEAPU8.byteLength
        && memory.pageCacheBytes === 0
        && memory.dictionaries.length === 1
        && memory.dictionaries[0].id === importedPackage.id
        && memory.dictionaries[0].title === importedPackage.title
        && memory.dictionaries[0].path === importedPackage.path
        && memory.dictionaries[0].paged === false
        && residentFileBytes > 0
        && fileSize("media.bin") > 0
        && memory.dictionaries[0].bytes === residentFileBytes
        && memory.heapBytes >= memory.dictionaries[0].bytes,
      JSON.stringify({ memory, residentFileBytes }),
    );
  });

  step("long keys and hd_segment", async () => {
    // A dictionary with keys longer than the scan length: the import records the
    // longest such key on the package row (from scan.idx), and the same
    // scanLength 16 lookup that could never reach a 27-code-point key now returns
    // it when the text begins like it.
    const longKeyImport = await request("hd_import", {
      blobUrl: createObjectURL(buildLongKeyZip()), fileName: "long-key.zip", lowRam: false,
    });
    const longKeyState = await storedDictionaryState();
    const longKeyPackage = longKeyState.dictionaries.find((dictionary) => dictionary.title === LONG_KEY_TITLE);
    const longKeyLookup = await request("hd_lookup", {
      text: `${LONG_KEY_PROVERB}と昔から言われている。`, maxResults: 32, scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    const longKeyInflected = await request("hd_lookup", {
      text: `${LONG_KEY_PHRASE_INFLECTED}と昔から言われている。`, maxResults: 32, scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    expressions = (reply) => reply.results?.map((result) => result.term?.expression) ?? [];
    check(
      "an import records its longest indexed key and scanLength 16 lookups reach keys longer than 16",
      longKeyImport.ok === true
        && longKeyPackage?.longKeyLength === LONG_KEY_LENGTH
        && importedPackage.longKeyLength === 0
        && expressions(longKeyLookup).includes(LONG_KEY_PROVERB)
        && longKeyLookup.results.find((result) => result.term?.expression === LONG_KEY_PROVERB)?.matched === LONG_KEY_PROVERB
        && expressions(longKeyInflected).includes(LONG_KEY_PHRASE),
      JSON.stringify({ ok: longKeyImport.ok, error: longKeyImport.error, longKeyLength: longKeyPackage?.longKeyLength,
        proverb: expressions(longKeyLookup), inflected: expressions(longKeyInflected) }),
    );
    await request("hd_remove", { id: longKeyPackage?.id, title: LONG_KEY_TITLE });

    // hd_segment (#520): a batch of text chunks, each split into the words a
    // hover would show, through the real background -> offscreen -> engine path.
    // The reply keeps one entry per chunk with its id, every span carries a
    // candidate headword and a function-word flag, and offsets are UTF-16 units
    // inside the chunk.
    const segmentBatch = await request("hd_segment", {
      chunks: [{ id: "a", text: "食べる" }, { id: "b", text: "漢字を読む" }, { id: "c", text: "。、" }],
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    const segA = segmentBatch.segments?.find((segment) => segment.id === "a");
    const segB = segmentBatch.segments?.find((segment) => segment.id === "b");
    const segC = segmentBatch.segments?.find((segment) => segment.id === "c");
    const headwords = (segment) => segment?.spans?.map((span) => span.candidates?.[0]?.expression) ?? [];
    check(
      "hd_segment splits a batch of chunks into spans, keyed by chunk id",
      segmentBatch.ok === true
        && segmentBatch.segments?.length === 3
        && headwords(segA).includes("食べる")
        && segA.spans[0].start === 0 && segA.spans[0].length === 3
        && typeof segA.spans[0].functionWord === "boolean"
        && Array.isArray(segA.spans[0].candidates)
        && headwords(segB).includes("漢字") && headwords(segB).includes("読む")
        && Array.isArray(segC.spans) && segC.spans.length === 0,
      JSON.stringify({ ok: segmentBatch.ok, error: segmentBatch.error,
        a: headwords(segA), b: headwords(segB), c: segC?.spans?.length }),
    );
    // A hover that arrives while a chunk is being segmented runs before the
    // batch's next chunk, because hd_segment takes one engine turn per chunk.
    // The lookup arrives as a message during the first chunk's native call, as a
    // hover reaches the engine worker: a task of its own, which a batch run as
    // one chain of engine turns would keep waiting until its last chunk.
    const nativeOrder = [];
    const hoverMessage = new MessageChannel();
    let lookupDuringChunk = null;
    const lookupArrived = new Promise((resolveArrival) => {
      hoverMessage.port1.onmessage = () => {
        hoverMessage.port1.close();
        lookupDuringChunk = engineService.handleEngineMessage({
          type: "hd_lookup", requestId: "lookup-during-segment", text: "漢字", maxResults: 32, scanLength: 16,
        });
        resolveArrival();
      };
    });
    const segmentingCcall = observedEngine.ccall;
    observedEngine.ccall = (name, returnType, argumentTypes, argumentValues) => {
      if (name === "hdw_segment") {
        nativeOrder.push(argumentValues[0]);
        if (nativeOrder.length === 1) hoverMessage.port2.postMessage(null);
      } else if (name === "hdw_lookup") {
        nativeOrder.push(name);
      }
      return segmentingCcall(name, returnType, argumentTypes, argumentValues);
    };
    let interleavedSegment = null;
    try {
      interleavedSegment = await engineService.handleEngineMessage({
        type: "hd_segment", requestId: "segment-around-lookup", scanLength: 16,
        chunks: [{ id: "x", text: "読む" }, { id: "y", text: "食べる" }],
      });
    } finally {
      observedEngine.ccall = segmentingCcall;
    }
    await lookupArrived;
    const interleavedLookup = await lookupDuringChunk;
    check(
      "a hover that arrives during a segment chunk runs before the batch's next chunk",
      interleavedSegment?.ok === true && interleavedSegment.segments?.length === 2
        && interleavedLookup?.ok === true && interleavedLookup.results?.[0]?.term?.expression === "漢字"
        && JSON.stringify(nativeOrder) === JSON.stringify(["読む", "hdw_lookup", "食べる"]),
      JSON.stringify({ nativeOrder, segment: interleavedSegment?.ok, lookup: interleavedLookup?.results?.[0]?.term?.expression }),
    );
    // A chunk cut inside a surrogate pair (a pair split across two text nodes)
    // still segments with its offsets, the lone surrogate counting as one unit.
    // An oversized chunk refuses the batch before any chunk takes an engine turn.
    const surrogateBatch = await request("hd_segment", {
      chunks: [{ id: "split", text: "食べる\uDC00読む\uD83D" }], scanLength: 16,
    });
    let refusedBatchSegmentCalls = 0;
    const refusingCcall = observedEngine.ccall;
    observedEngine.ccall = (name, ...rest) => {
      if (name === "hdw_segment") refusedBatchSegmentCalls += 1;
      return refusingCcall(name, ...rest);
    };
    let oversizedBatch = null;
    try {
      oversizedBatch = await request("hd_segment", {
        chunks: [{ id: "first", text: "食べる" }, { id: "huge", text: "あ".repeat(1366) }], scanLength: 16,
      });
    } finally {
      observedEngine.ccall = refusingCcall;
    }
    const surrogateSpans = surrogateBatch.segments?.[0]?.spans?.map((span) =>
      [span.start, span.length, span.candidates?.[0]?.expression]);
    check(
      "hd_segment keeps a lone surrogate's offsets and refuses an oversized chunk before any engine turn",
      surrogateBatch.ok === true
        && JSON.stringify(surrogateSpans) === JSON.stringify([[0, 3, "食べる"], [4, 2, "読む"]])
        && oversizedBatch?.ok === false && /4096-byte/u.test(oversizedBatch.error)
        && refusedBatchSegmentCalls === 0,
      JSON.stringify({ surrogate: surrogateBatch.error ?? surrogateSpans,
        oversized: oversizedBatch?.error, refusedBatchSegmentCalls }),
    );
  });

  step("MDict imports", async () => {
    // An MDict dictionary: the .mdx plus its .mdd travel as blob URLs, the engine
    // service stages them side by side under their own names so the importer
    // finds the resource file, and the result is an ordinary package whose media
    // and stylesheet come from the MDD. The staging directory must not outlive
    // the import. A resource list on a ZIP import is refused before any staging.
    const mdxFixtures = resolve(HERE, "mdict");
    const mdxBytes = (name) => new Uint8Array(readFileSync(resolve(mdxFixtures, name)));
    const mdxImport = await request("hd_import", {
      blobUrl: createObjectURL(mdxBytes("v2_utf8_lzo_html.mdx")), fileName: "v2_utf8_lzo_html.mdx", lowRam: false,
      resources: [{ fileName: "v2_utf8_lzo_html.mdd", blobUrl: createObjectURL(mdxBytes("v2_utf8_lzo_html.mdd")) }],
    });
    const mdxState = await storedDictionaryState();
    const mdxPackage = mdxState.dictionaries.find((dictionary) => dictionary.title === "HTML Fixture");
    const mdxLookup = await request("hd_lookup", {
      text: "食べる", maxResults: 32, scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    const mdxStyles = await request("hd_styles");
    const mdxMedia = await request("hd_media", { generation: mdxLookup.generation, dictionary: "HTML Fixture", path: "mdict-media/img/pic.png" });
    const mdxZipWithResources = await request("hd_import", {
      blobUrl: createObjectURL(buildLongKeyZip()), fileName: "long-key.zip", lowRam: false,
      resources: [{ fileName: "long-key.mdd", blobUrl: createObjectURL(mdxBytes("v2_utf8_lzo_html.mdd")) }],
    });
    check(
      "an .mdx with its .mdd imports through hd_import as a package with MDD media and styles",
      mdxImport.ok === true
        && mdxImport.report?.title === "HTML Fixture"
        && mdxPackage?.termCount === 8
        && mdxPackage?.mediaCount === 3
        && mdxPackage?.revision === "mdx import"
        && expressions(mdxLookup).includes("食べる")
        && mdxStyles.styles?.some((entry) => entry.dictionary === "HTML Fixture" && entry.styles.includes(".mdx-red"))
        && /^data:image\/png;base64,/u.test(mdxMedia.dataUrl ?? "")
        && !observedEngine.FS.analyzePath("/.hdw-mdx").exists
        && mdxZipWithResources.ok === false
        && /only a local \.mdx import can carry resource files/u.test(mdxZipWithResources.error ?? ""),
      JSON.stringify({ import: mdxImport, package: mdxPackage, lookup: expressions(mdxLookup), styles: mdxStyles.styles,
        media: mdxMedia.dataUrl?.slice(0, 32), staging: observedEngine.FS.analyzePath("/.hdw-mdx").exists,
        zipWithResources: mdxZipWithResources }),
    );
    // The reply carries what the import left out, for Settings to word; the
    // stored package does not.
    check(
      "the hd_import reply reports what an MDX import left out, and the package does not store it",
      mdxImport.report?.skippedRecordCount === 0
        && mdxImport.report?.unresolvedRedirectCount === 1
        && mdxImport.report?.missingResourceCount === 1
        && mdxImport.report?.unreadableResourceCount === 0
        && ["skippedRecordCount", "unresolvedRedirectCount", "missingResourceCount", "unreadableResourceCount"]
          .every((key) => mdxPackage !== undefined && !Object.hasOwn(mdxPackage, key)),
      JSON.stringify({ report: mdxImport.report, package: mdxPackage }),
    );
    await request("hd_remove", { id: mdxPackage?.id, title: "HTML Fixture" });
  });
});

export {
  advancedPresentationDuringConflict, advancedStateDuringCleanup,
  advancePresentationBeforeStateCas, alarms, createHoshidicts, engineService,
  failAfterCommittedRevision, formerArchiveByteLimit, idb, importedPackage, nativeCounts,
  observedEngine, offscreenChrome, pageChrome, peakLoadedDictionaryPaths, request,
  setAdvanceGroupsAfterCommittedRevision, setAdvancePresentationBeforeStateCas,
  setFailAfterCommittedRevision, setLoseNextStateCasReply, setPeakLoadedDictionaryPaths, storage,
  storedDictionaryState, swChrome, swContext, transactionCounts, zip,
};
