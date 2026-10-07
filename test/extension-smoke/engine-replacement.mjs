/*
 * Interactive atomic replacement through the real engine.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./engine.mjs";
import { describe } from "node:test";
import { dictionaryImportTarget } from "../../extension/dictionary-import.js";
import { buildTitledZip } from "../make-fixture.mjs";
import {
  advancedPresentationDuringConflict,
  advancePresentationBeforeStateCas,
  idb,
  observedEngine,
  pageChrome,
  request,
  setAdvancePresentationBeforeStateCas,
  storage,
  storedDictionaryState,
  transactionCounts,
} from "./engine.mjs";
import { createObjectURL } from "./fakes.mjs";
import { check, section, step } from "./harness.mjs";

// Values that more than one step uses; the step that creates each one assigns it.
let atomicTitle, atomicSource, atomicArchive, atomicIdentity, atomicIndex, atomicGroup,
  transactionSnapshot, transactionDelta, generationRoots, atomicReplaced, atomicGenerationRows,
  separateTitle, separatePackage, separateThreeTitle, atomicAfterFailures, atomicConflictPackage,
  atomicGenerationPackage;

describe("engine: atomic replacement", () => {
  step("an interactive replacement keeps its package and presentation", async () => {
    section("interactive atomic replacement");
    atomicTitle = "atomic-replacement-fixture";
    atomicSource = {
      sourceId: "atomic-managed-source",
      indexUrl: "https://example.invalid/atomic/index.json",
      downloadUrl: "https://example.invalid/atomic/archive.zip",
    };
    atomicArchive = (revision, definition, overrides = {}) => buildTitledZip(atomicTitle, {
      revision,
      terms: [["原子語", "げんしご", "", "", 0, [definition], 1, ""]],
      ...overrides,
    });
    atomicIdentity = (revision, overrides = {}) => ({
      title: atomicTitle,
      revision,
      indexUrl: null,
      downloadUrl: null,
      ...overrides,
    });
    const atomicInstall = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("1", "atomic version one")),
      fileName: "atomic-v1.zip",
      importDecision: {
        action: "install",
        identity: atomicIdentity("1"),
        matchKind: null,
        target: null,
      },
    });
    const atomicInstalledState = await storedDictionaryState();
    const atomicInstalled = atomicInstalledState.dictionaries.find(
      dictionary => dictionary.title === atomicTitle,
    );
    atomicIndex = atomicInstalledState.dictionaries.indexOf(atomicInstalled);
    atomicGroup = { id: "atomic-group", name: "Atomic", dictionaryIds: [atomicInstalled.id] };
    const atomicPresentation = {
      ...atomicInstalled,
      displayName: "My atomic dictionary",
      enabled: false,
      favorite: true,
      isUpdatable: true,
      ...atomicSource,
      updateScheduleOverride: "weekly",
      lastUpdateCheck: {
        checkedAt: "2026-09-17T00:00:00.000Z",
        status: "update-available",
        remoteRevision: "2",
        error: null,
      },
      futureUserSetting: { retained: true },
    };
    const atomicPresented = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: atomicInstalledState.revision,
      dictionaries: atomicInstalledState.dictionaries.map((dictionary, index) =>
        index === atomicIndex ? atomicPresentation : dictionary),
      groups: [atomicGroup],
    });
    const atomicBeforeReplace = atomicPresented.state.dictionaries[atomicIndex];
    const atomicOldPath = atomicBeforeReplace.path;
    transactionSnapshot = () => ({ ...transactionCounts });
    transactionDelta = (before) => Object.fromEntries(
      Object.entries(transactionCounts).map(([key, value]) => [key, value - before[key]]),
    );
    generationRoots = () => new Set(idb.keys("/dicts").flatMap((path) => {
      const match = /^\/dicts\/\.hdw-generation-[^/]+/u.exec(path);
      return match === null ? [] : [match[0]];
    }));
    const atomicReplacementCountsBefore = transactionSnapshot();
    const atomicReplacementRevisionBefore = atomicPresented.state.revision;
    const atomicReplacementRootsBefore = generationRoots();
    const hostileSource = {
      indexUrl: "https://attacker.invalid/retarget.json",
      downloadUrl: "https://attacker.invalid/retarget.zip",
    };
    const atomicReplacement = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("2", "atomic version two", hostileSource)),
      fileName: "atomic-v2.zip",
      importDecision: {
        action: "replace",
        identity: atomicIdentity("2", hostileSource),
        matchKind: "title",
        target: dictionaryImportTarget(atomicBeforeReplace),
      },
    });
    const atomicReplacedState = await storedDictionaryState();
    atomicReplaced = atomicReplacedState.dictionaries[atomicIndex];
    const atomicOldPersisted = idb.keys("/dicts").some(path =>
      path === atomicOldPath || path.startsWith(`${atomicOldPath}/`));
    const atomicReplacementAccounting = {
      ...transactionDelta(atomicReplacementCountsBefore),
      stateRevisionWrites: atomicReplacedState.revision - atomicReplacementRevisionBefore,
      generationRootsBefore: atomicReplacementRootsBefore.size,
      generationRootsAfter: generationRoots().size,
      obsoleteGenerationRetired: !atomicOldPersisted,
      candidateGenerationPublished: idb.keys("/dicts").some(path =>
        path === atomicReplaced.path || path.startsWith(`${atomicReplaced.path}/`)),
    };
    check(
      "explicit local replacement preserves the stable package and every target-owned field",
      atomicInstall.ok === true
        && atomicPresented.ok === true
        && atomicReplacement.ok === true
        && atomicReplacement.report?.title === atomicTitle
        && atomicReplacedState.dictionaries.length === atomicInstalledState.dictionaries.length
        && atomicReplaced.id === atomicInstalled.id
        && atomicReplaced.title === atomicTitle
        && atomicReplaced.path !== atomicOldPath
        && atomicReplaced.revision === "2"
        && atomicReplaced.displayName === "My atomic dictionary"
        && atomicReplaced.enabled === false
        && atomicReplaced.favorite === true
        && atomicReplaced.sourceId === atomicSource.sourceId
        && atomicReplaced.indexUrl === atomicSource.indexUrl
        && atomicReplaced.downloadUrl === atomicSource.downloadUrl
        && atomicReplaced.isUpdatable === true
        && atomicReplaced.updateScheduleOverride === "weekly"
        && atomicReplaced.lastUpdateCheck === null
        && atomicReplaced.futureUserSetting?.retained === true
        && JSON.stringify(atomicReplacedState.groups) === JSON.stringify([atomicGroup])
        && atomicOldPersisted === false
        && JSON.stringify(atomicReplacementAccounting) === JSON.stringify({
          nativeImports: 1,
          stateReads: 2,
          stateCasAttempts: 1,
          durableFilesystemWrites: 2,
          stateRevisionWrites: 1,
          generationRootsBefore: atomicReplacementRootsBefore.size,
          generationRootsAfter: atomicReplacementRootsBefore.size,
          obsoleteGenerationRetired: true,
          candidateGenerationPublished: true,
        }),
      JSON.stringify({
        atomicInstall,
        atomicPresented,
        atomicReplacement,
        atomicReplacedState,
        atomicOldPersisted,
        atomicReplacementAccounting,
      }),
    );
    console.log(`     I04 replacement transaction accounting: ${JSON.stringify(atomicReplacementAccounting)}`);
  });

  step("Add separately persists a suffixed canonical title", async () => {
    atomicGenerationRows = () => idb.keys("/dicts")
      .filter((path) => path.startsWith("/dicts/.hdw-generation-"))
      .sort();
    const atomicSeparate = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("3", "atomic separate version")),
      fileName: "atomic-v3.zip",
      importDecision: {
        action: "separate",
        identity: atomicIdentity("3"),
        matchKind: "title",
        target: dictionaryImportTarget(atomicReplaced),
      },
    });
    const atomicSeparateState = await storedDictionaryState();
    separateTitle = `${atomicTitle} (2)`;
    separatePackage = atomicSeparateState.dictionaries.find(
      dictionary => dictionary.title === separateTitle,
    );
    const separateIndex = separatePackage && JSON.parse(new TextDecoder().decode(
      observedEngine.FS.readFile(`${separatePackage.path}/index.json`),
    ));
    const separateLookup = await request("hd_lookup", {
      text: "原子語",
      maxResults: 32,
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    const separateLabels = separateLookup.results?.flatMap(result =>
      result.term?.glossaries?.map(glossary => glossary.dictionary) ?? []) ?? [];
    check(
      "Add separately persists and reports its suffixed canonical title through native lookup",
      atomicSeparate.ok === true
        && atomicSeparate.report?.title === separateTitle
        && separatePackage?.id !== atomicReplaced.id
        && separatePackage?.path.endsWith(`/${separateTitle}`)
        && separatePackage?.revision === "3"
        && separateIndex?.title === separateTitle
        && separateLabels.includes(separateTitle)
        && !separateLabels.includes(atomicTitle)
        && atomicSeparateState.dictionaries[atomicIndex].id === atomicReplaced.id
        && atomicSeparateState.dictionaries[atomicIndex].path === atomicReplaced.path
        && JSON.stringify(atomicSeparateState.groups) === JSON.stringify([atomicGroup]),
      JSON.stringify({ atomicSeparate, atomicSeparateState, separateIndex, separateLabels }),
    );
  });

  step("an existing Title (2) makes Add separately persist Title (3)", async () => {
    const atomicSeparateThree = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("4", "atomic third copy")),
      fileName: "atomic-v4.zip",
      importDecision: {
        action: "separate",
        identity: atomicIdentity("4"),
        matchKind: "title",
        target: dictionaryImportTarget(atomicReplaced),
      },
    });
    const atomicSeparateThreeState = await storedDictionaryState();
    separateThreeTitle = `${atomicTitle} (3)`;
    const separateThreePackage = atomicSeparateThreeState.dictionaries.find(
      dictionary => dictionary.title === separateThreeTitle,
    );
    const separateThreeIndex = separateThreePackage && JSON.parse(new TextDecoder().decode(
      observedEngine.FS.readFile(`${separateThreePackage.path}/index.json`),
    ));
    const separateThreeLookup = await request("hd_lookup", {
      text: "原子語",
      maxResults: 32,
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    const separateThreeLabels = separateThreeLookup.results?.flatMap(result =>
      result.term?.glossaries?.map(glossary => glossary.dictionary) ?? []) ?? [];
    check(
      "an existing Title (2) makes Add separately persist native Title (3)",
      atomicSeparateThree.ok === true
        && atomicSeparateThree.report?.title === separateThreeTitle
        && separateThreePackage?.id !== atomicReplaced.id
        && separateThreePackage?.id !== separatePackage.id
        && separateThreePackage?.path.endsWith(`/${separateThreeTitle}`)
        && separateThreeIndex?.title === separateThreeTitle
        && separateThreeLabels.includes(separateTitle)
        && separateThreeLabels.includes(separateThreeTitle)
        && !separateThreeLabels.includes(atomicTitle),
      JSON.stringify({
        atomicSeparateThree,
        atomicSeparateThreeState,
        separateThreeIndex,
        separateThreeLabels,
      }),
    );
  });

  step("failed replacements clean their generation roots", async () => {
    const atomicBeforeFailures = await storedDictionaryState();
    const mismatchRowsBefore = atomicGenerationRows();
    const atomicMetadataMismatch = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("5", "metadata mismatch")),
      fileName: "atomic-metadata-mismatch.zip",
      importDecision: {
        action: "replace",
        identity: atomicIdentity("6"),
        matchKind: "title",
        target: dictionaryImportTarget(atomicBeforeFailures.dictionaries[atomicIndex]),
      },
    });
    const atomicAfterMismatch = await storedDictionaryState();
    const mismatchRowsAfter = atomicGenerationRows();
    const corruptRowsBefore = atomicGenerationRows();
    const atomicCorrupt = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("5", "corrupt bank", { rawTermBank: "{" })),
      fileName: "atomic-corrupt.zip",
      importDecision: {
        action: "replace",
        identity: atomicIdentity("5"),
        matchKind: "title",
        target: dictionaryImportTarget(atomicBeforeFailures.dictionaries[atomicIndex]),
      },
    });
    atomicAfterFailures = await storedDictionaryState();
    const corruptRowsAfter = atomicGenerationRows();
    check(
      "metadata mismatch and post-preflight native failure clean their generation roots",
      atomicMetadataMismatch.ok === false
        && atomicMetadataMismatch.error?.includes("did not match the reviewed archive")
        && atomicCorrupt.ok === false
        && JSON.stringify(atomicAfterMismatch) === JSON.stringify(atomicBeforeFailures)
        && JSON.stringify(atomicAfterFailures) === JSON.stringify(atomicBeforeFailures)
        && JSON.stringify(mismatchRowsAfter) === JSON.stringify(mismatchRowsBefore)
        && JSON.stringify(corruptRowsAfter) === JSON.stringify(corruptRowsBefore),
      JSON.stringify({
        atomicMetadataMismatch,
        atomicCorrupt,
        atomicBeforeFailures,
        atomicAfterMismatch,
        atomicAfterFailures,
        mismatchRowsBefore,
        mismatchRowsAfter,
        corruptRowsBefore,
        corruptRowsAfter,
      }),
    );
  });

  step("replacement retries a CAS conflict", async () => {
    const atomicConflictCountsBefore = transactionSnapshot();
    const atomicConflictRevisionBefore = atomicAfterFailures.revision;
    const atomicConflictRootsBefore = generationRoots();
    setAdvancePresentationBeforeStateCas({
      targetId: atomicReplaced.id,
      candidateRevision: "6",
      patch: {
        displayName: "Concurrent atomic alias",
        enabled: true,
        favorite: false,
        updateScheduleOverride: "daily",
        futureUserSetting: { retained: "latest" },
      },
    });
    const atomicConflictReplacement = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("6", "atomic conflict replacement")),
      fileName: "atomic-v6-conflict.zip",
      importDecision: {
        action: "replace",
        identity: atomicIdentity("6"),
        matchKind: "title",
        target: dictionaryImportTarget(atomicAfterFailures.dictionaries[atomicIndex]),
      },
    });
    const atomicConflictState = await storedDictionaryState();
    atomicConflictPackage = atomicConflictState.dictionaries.find(
      dictionary => dictionary.id === atomicReplaced.id,
    );
    const atomicConflictAccounting = {
      ...transactionDelta(atomicConflictCountsBefore),
      stateRevisionWrites: atomicConflictState.revision - atomicConflictRevisionBefore,
      generationRootsBefore: atomicConflictRootsBefore.size,
      generationRootsAfter: generationRoots().size,
      obsoleteGenerationRetired: !idb.keys("/dicts").some(path =>
        path === atomicReplaced.path || path.startsWith(`${atomicReplaced.path}/`)),
      candidateGenerationPublished: idb.keys("/dicts").some(path =>
        path === atomicConflictPackage.path || path.startsWith(`${atomicConflictPackage.path}/`)),
    };
    check(
      "replacement retries a CAS conflict and preserves the latest presentation fields",
      atomicConflictReplacement.ok === true
        && advancedPresentationDuringConflict?.ok === true
        && advancePresentationBeforeStateCas === null
        && atomicConflictPackage?.revision === "6"
        && atomicConflictPackage?.path !== atomicReplaced.path
        && atomicConflictPackage?.displayName === "Concurrent atomic alias"
        && atomicConflictPackage?.enabled === true
        && atomicConflictPackage?.favorite === false
        && atomicConflictPackage?.updateScheduleOverride === "daily"
        && atomicConflictPackage?.futureUserSetting?.retained === "latest"
        && atomicConflictPackage?.sourceId === atomicSource.sourceId
        && atomicConflictPackage?.indexUrl === atomicSource.indexUrl
        && atomicConflictPackage?.downloadUrl === atomicSource.downloadUrl
        && JSON.stringify(atomicConflictState.groups) === JSON.stringify([atomicGroup])
        && JSON.stringify(atomicConflictAccounting) === JSON.stringify({
          nativeImports: 1,
          stateReads: 3,
          stateCasAttempts: 2,
          durableFilesystemWrites: 2,
          stateRevisionWrites: 2,
          generationRootsBefore: atomicConflictRootsBefore.size,
          generationRootsAfter: atomicConflictRootsBefore.size,
          obsoleteGenerationRetired: true,
          candidateGenerationPublished: true,
        }),
      JSON.stringify({
        atomicConflictReplacement,
        advancedPresentationDuringConflict,
        atomicConflictState,
        atomicConflictAccounting,
      }),
    );
    console.log(`     I04 CAS-conflict transaction accounting: ${JSON.stringify(atomicConflictAccounting)}`);
  });

  step("a changed target generation refuses stale replacement", async () => {
    const staleGenerationTarget = dictionaryImportTarget(atomicConflictPackage);
    const atomicGenerationAdvance = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("7", "atomic concurrent generation")),
      fileName: "atomic-v7.zip",
      importDecision: {
        action: "replace",
        identity: atomicIdentity("7"),
        matchKind: "title",
        target: staleGenerationTarget,
      },
    });
    const atomicGenerationState = await storedDictionaryState();
    atomicGenerationPackage = atomicGenerationState.dictionaries.find(
      dictionary => dictionary.id === atomicReplaced.id,
    );
    const staleGenerationRowsBefore = atomicGenerationRows();
    const staleGenerationImport = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("8", "stale generation candidate")),
      fileName: "atomic-v8-stale.zip",
      importDecision: {
        action: "replace",
        identity: atomicIdentity("8"),
        matchKind: "title",
        target: staleGenerationTarget,
      },
    });
    const staleGenerationState = await storedDictionaryState();
    const staleGenerationRowsAfter = atomicGenerationRows();
    check(
      "a changed target generation refuses stale replacement without staged debris",
      atomicGenerationAdvance.ok === true
        && atomicGenerationPackage?.revision === "7"
        && atomicGenerationPackage?.path !== staleGenerationTarget.path
        && staleGenerationImport.ok === false
        && staleGenerationImport.error?.includes("changed while")
        && JSON.stringify(staleGenerationState) === JSON.stringify(atomicGenerationState)
        && JSON.stringify(staleGenerationRowsAfter) === JSON.stringify(staleGenerationRowsBefore),
      JSON.stringify({
        atomicGenerationAdvance,
        atomicGenerationState,
        staleGenerationImport,
        staleGenerationState,
        staleGenerationRowsBefore,
        staleGenerationRowsAfter,
      }),
    );
  });

  step("a removed target refuses stale replacement; selector replacement", async () => {
    const removedTarget = dictionaryImportTarget(atomicGenerationPackage);
    const atomicRemoved = await request("hd_remove", { title: atomicTitle });
    const removedState = await storedDictionaryState();
    const removedRowsBefore = atomicGenerationRows();
    const staleRemovedImport = await request("hd_import", {
      blobUrl: createObjectURL(atomicArchive("9", "removed target candidate")),
      fileName: "atomic-v9-removed.zip",
      importDecision: {
        action: "replace",
        identity: atomicIdentity("9"),
        matchKind: "title",
        target: removedTarget,
      },
    });
    const staleRemovedState = await storedDictionaryState();
    const removedRowsAfter = atomicGenerationRows();
    check(
      "a removed target refuses stale replacement without recreating or staging it",
      atomicRemoved.ok === true
        && !removedState.dictionaries.some(dictionary => dictionary.id === atomicReplaced.id)
        && staleRemovedImport.ok === false
        && staleRemovedImport.error?.includes("changed while")
        && JSON.stringify(staleRemovedState) === JSON.stringify(removedState)
        && JSON.stringify(removedRowsAfter) === JSON.stringify(removedRowsBefore),
      JSON.stringify({
        atomicRemoved,
        removedState,
        staleRemovedImport,
        staleRemovedState,
        removedRowsBefore,
        removedRowsAfter,
      }),
    );

    const selectorTitle = "atomic-selector-fixture";
    const renamedSelectorTitle = "renamed-atomic-selector-fixture";
    const selectorQuery = "選択語";
    const selectorSource = {
      sourceId: "atomic-selector-source",
      indexUrl: "https://example.invalid/atomic-selector/index.json",
      downloadUrl: "https://example.invalid/atomic-selector/archive.zip",
    };
    const selectorArchive = (title, revision, definition, overrides = {}) => buildTitledZip(title, {
      revision,
      indexUrl: selectorSource.indexUrl,
      downloadUrl: selectorSource.downloadUrl,
      indexOverrides: { isUpdatable: true },
      terms: [[selectorQuery, "せんたくご", "", "", 0, [definition], 1, ""]],
      termMeta: [[selectorQuery, "freq", { value: 1, displayValue: "1" }]],
      ...overrides,
    });
    const selectorIdentity = (title, revision, overrides = {}) => ({
      title,
      revision,
      indexUrl: selectorSource.indexUrl,
      downloadUrl: selectorSource.downloadUrl,
      ...overrides,
    });
    const selectorInstall = await request("hd_import", {
      blobUrl: createObjectURL(selectorArchive(selectorTitle, "1", "selector version one")),
      fileName: "atomic-selector-v1.zip",
      importDecision: {
        action: "install",
        identity: selectorIdentity(selectorTitle, "1"),
        matchKind: null,
        target: null,
      },
    });
    const selectorInstalledState = await storedDictionaryState();
    const selectorInstalled = selectorInstalledState.dictionaries.find(
      dictionary => dictionary.title === selectorTitle,
    );
    const selectorGroup = {
      id: "atomic-selector-group",
      name: "Atomic selector",
      dictionaryIds: [selectorInstalled.id],
    };
    const selectorPresented = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: selectorInstalledState.revision,
      dictionaries: selectorInstalledState.dictionaries.map(dictionary =>
        dictionary.id === selectorInstalled.id ? {
          ...dictionary,
          displayName: "Selector alias",
          favorite: true,
          sourceId: selectorSource.sourceId,
          futureSelectorSetting: { retained: true },
        } : dictionary),
      groups: [selectorGroup],
    });
    const selectorOptionsWrite = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision: (await storage.api().local.get("options")).options?.revision ?? 0,
      options: {
        frequencyDictionary: selectorTitle,
        definitionBlurFrequencyDictionary: selectorTitle,
        compactDefinitionSummaryDictionary: selectorTitle,
        kanjiClickDictionary: { title: selectorTitle, kind: "term" },
        popupImageSource: { kind: "dictionary", title: selectorTitle },
        pitchAccentFuriganaDictionary: selectorTitle,
      },
    });
    const selectorBeforeReplace = selectorPresented.state.dictionaries.find(
      dictionary => dictionary.id === selectorInstalled.id,
    );
    const importedSelectorSource = {
      indexUrl: selectorSource.indexUrl,
      downloadUrl: "https://attacker.invalid/selector-retarget.zip",
    };
    const selectorReplacement = await request("hd_import", {
      blobUrl: createObjectURL(selectorArchive(
        renamedSelectorTitle,
        "2",
        "selector version two",
        { downloadUrl: importedSelectorSource.downloadUrl },
      )),
      fileName: "atomic-selector-v2.zip",
      importDecision: {
        action: "replace",
        identity: selectorIdentity(renamedSelectorTitle, "2", importedSelectorSource),
        matchKind: "source",
        target: dictionaryImportTarget(selectorBeforeReplace),
      },
    });
    const selectorReplacedState = await storedDictionaryState();
    const selectorReplaced = selectorReplacedState.dictionaries.find(
      dictionary => dictionary.id === selectorInstalled.id,
    );
    const selectorOptions = (await storage.api().local.get("options")).options;
    check(
      "stable-ID replacement preserves groups and migrates every dictionary selector",
      selectorInstall.ok === true
        && selectorPresented.ok === true
        && selectorOptionsWrite.ok === true
        && selectorReplacement.ok === true
        && selectorReplaced?.id === selectorInstalled.id
        && selectorReplaced?.title === renamedSelectorTitle
        && selectorReplaced?.displayName === "Selector alias"
        && selectorReplaced?.favorite === true
        && selectorReplaced?.sourceId === selectorSource.sourceId
        && selectorReplaced?.indexUrl === selectorSource.indexUrl
        && selectorReplaced?.downloadUrl === selectorSource.downloadUrl
        && selectorReplaced?.futureSelectorSetting?.retained === true
        && JSON.stringify(selectorReplacedState.groups) === JSON.stringify([selectorGroup])
        && selectorOptions.frequencyDictionary === renamedSelectorTitle
        && selectorOptions.definitionBlurFrequencyDictionary === renamedSelectorTitle
        && selectorOptions.compactDefinitionSummaryDictionary === renamedSelectorTitle
        && selectorOptions.kanjiClickDictionary?.title === renamedSelectorTitle
        && selectorOptions.kanjiClickDictionary?.kind === "term"
        && selectorOptions.popupImageSource?.title === renamedSelectorTitle
        && selectorOptions.pitchAccentFuriganaDictionary === renamedSelectorTitle
        && selectorOptions.revision === selectorOptionsWrite.options.revision + 1,
      JSON.stringify({
        selectorInstall,
        selectorPresented,
        selectorOptionsWrite,
        selectorReplacement,
        selectorReplacedState,
        selectorOptions,
      }),
    );
    await request("hd_remove", { title: renamedSelectorTitle });
    await request("hd_remove", { title: separateTitle });
    await request("hd_remove", { title: separateThreeTitle });
  });
});
