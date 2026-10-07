/*
 * Library state through the real engine: migration, CAS ownership, titles and reloads.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./engine-updates.mjs";
import { createHash } from "node:crypto";
import { describe } from "node:test";
import { buildTitledZip, EXPECTED, frequencyRankingFixture } from "../make-fixture.mjs";
import {
  importedPackage,
  nativeCounts,
  observedEngine,
  pageChrome,
  peakLoadedDictionaryPaths,
  request,
  setLoseNextStateCasReply,
  setPeakLoadedDictionaryPaths,
  storage,
  storedDictionaryState,
} from "./engine.mjs";
import { createObjectURL, FIXTURE_TITLE } from "./fakes.mjs";
import { check, equal, step } from "./harness.mjs";

// Values that more than one step uses; the step that creates each one assigns it.
let migratedState, studyGroup, reconciledState;

describe("engine: library state", () => {
  step("legacy rows migrate to one logical package", async () => {
    // Model an actual pre-D9 install: legacy rows named a canonical title path,
    // before immutable UUID generation roots existed.
    const legacyPath = `/dicts/${FIXTURE_TITLE}`;
    observedEngine.FS.mkdir(legacyPath);
    for (const name of observedEngine.FS.readdir(importedPackage.path)) {
      if (name !== "." && name !== "..") {
        observedEngine.FS.writeFile(
          `${legacyPath}/${name}`,
          observedEngine.FS.readFile(`${importedPackage.path}/${name}`),
        );
      }
    }
    await storage.api().local.remove("dictionaryState");
    await storage.api().local.set({
      dictionaries: ["term", "freq", "pitch", "kanji"].map((kind, index) => ({
        title: FIXTURE_TITLE,
        path: `/dicts/${FIXTURE_TITLE}`,
        kind,
        enabled: index !== 0,
      })),
    });
    const preMigrationOptions = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision: (await storage.api().local.get("options")).options?.revision ?? 0,
      options: {
        frequencyDictionary: FIXTURE_TITLE,
        kanjiClickDictionary: FIXTURE_TITLE,
      },
    });
    equal(
      "an options write preserves valid dictionary selections before legacy state migrates",
      [preMigrationOptions?.options?.frequencyDictionary, preMigrationOptions?.options?.kanjiClickDictionary],
      [FIXTURE_TITLE, FIXTURE_TITLE],
    );
    const migratedReload = await request("hd_reload");
    migratedState = await storedDictionaryState();
    const legacyAfterMigration = await storage.api().local.get("dictionaries");
    const optionsAfterMigration = (await storage.api().local.get("options")).options;
    check(
      "legacy capability rows migrate once into the generated logical package",
      migratedReload.ok === true
        && migratedReload.dictionaryCount === 4
        && migratedState?.schemaVersion === 1
        && migratedState.revision === 1
        && migratedState.dictionaries?.length === 1
        && migratedState.dictionaries[0].id === importedPackage.id
        && migratedState.dictionaries[0].enabled === true
        && migratedState.dictionaries[0].frequencyCount === EXPECTED.frequencyCount
        && optionsAfterMigration?.frequencyDictionary === FIXTURE_TITLE
        && optionsAfterMigration?.kanjiClickDictionary?.title === FIXTURE_TITLE
        && optionsAfterMigration?.kanjiClickDictionary?.kind === "kanji"
        && !Object.prototype.hasOwnProperty.call(legacyAfterMigration, "dictionaries"),
      JSON.stringify({ migratedReload, migratedState, legacyAfterMigration }),
    );
  });

  step("dictionary state has one serialized compare-and-swap owner", async () => {
    const firstWriterDictionaries = migratedState.dictionaries.map((entry) => ({
      ...entry,
      favorite: true,
    }));
    const staleWriterDictionaries = migratedState.dictionaries.map((entry) => ({
      ...entry,
      displayName: "stale writer",
    }));
    studyGroup = {
      id: "study-group",
      name: "Study",
      dictionaryIds: [importedPackage.id],
    };
    const firstWriter = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: migratedState.revision,
      dictionaries: firstWriterDictionaries,
      groups: [studyGroup],
    });
    const staleWriter = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: migratedState.revision,
      dictionaries: staleWriterDictionaries,
    });
    const stateAfterConflict = await storedDictionaryState();
    check(
      "dictionary state has one serialized compare-and-swap owner",
      firstWriter?.ok === true
        && firstWriter.state?.revision === migratedState.revision + 1
        && firstWriter.state?.dictionaries?.[0]?.favorite === true
        && JSON.stringify(firstWriter.state?.groups) === JSON.stringify([studyGroup])
        && staleWriter?.ok === false
        && staleWriter.conflict === true
        && JSON.stringify(staleWriter.state) === JSON.stringify(firstWriter.state)
        && JSON.stringify(stateAfterConflict) === JSON.stringify(firstWriter.state),
      JSON.stringify({ firstWriter, staleWriter, stateAfterConflict }),
    );

    const incompleteDictionaries = stateAfterConflict.dictionaries.map((entry) => ({
      ...entry,
      frequencyCount: 0,
      pitchCount: 0,
      kanjiCount: 0,
      mediaCount: 0,
    }));
    const selectedOptions = {
      frequencyDictionary: FIXTURE_TITLE,
      kanjiClickDictionary: { title: FIXTURE_TITLE, kind: "kanji" },
    };
    await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision: (await storage.api().local.get("options")).options?.revision ?? 0,
      options: selectedOptions,
    });
    const selectedOptionsRevision = (await storage.api().local.get("options")).options.revision;
    await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: stateAfterConflict.revision,
      dictionaries: incompleteDictionaries,
    });
    const optionsAfterCapabilityRemoval = (await storage.api().local.get("options")).options;
    const staleOptionsWrite = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision: selectedOptionsRevision,
      options: selectedOptions,
    });
    equal(
      "state commits atomically prune invalid selectors and stale pages cannot restore them",
      [
        optionsAfterCapabilityRemoval?.frequencyDictionary,
        optionsAfterCapabilityRemoval?.kanjiClickDictionary,
        staleOptionsWrite?.options?.frequencyDictionary,
        staleOptionsWrite?.options?.kanjiClickDictionary,
      ],
      ["", "", "", ""],
    );
    check(
      "selector pruning advances the options revision in the dictionary commit",
      optionsAfterCapabilityRemoval?.revision === selectedOptionsRevision + 1
        && staleOptionsWrite.conflict === true,
      JSON.stringify({ selectedOptionsRevision, optionsAfterCapabilityRemoval, staleOptionsWrite }),
    );
    const reloaded = await request("hd_reload");
    reconciledState = await storedDictionaryState();
    const reconciledPackage = reconciledState?.dictionaries?.[0];
    equal(
      "reconciliation restores package capabilities without changing its identity or presentation",
      [
        reloaded.ok,
        reloaded.dictionaryCount,
        reconciledState?.dictionaries?.length,
        reconciledPackage?.id,
        reconciledPackage?.favorite,
        reconciledPackage?.termCount,
        reconciledPackage?.frequencyCount,
        reconciledPackage?.pitchCount,
        reconciledPackage?.kanjiCount,
        reconciledPackage?.mediaCount,
      ],
      [
        true,
        4,
        1,
        importedPackage.id,
        true,
        EXPECTED.termCount,
        EXPECTED.frequencyCount,
        EXPECTED.pitchCount,
        EXPECTED.kanjiCount,
        EXPECTED.mediaCount,
      ],
    );
  });

  step("a package-wide state change survives a lost CAS reply", async () => {
    const disabledDictionaries = reconciledState.dictionaries.map((dictionary) => ({
      ...dictionary,
      enabled: false,
    }));
    setLoseNextStateCasReply(true);
    const disabled = await request("hd_apply_state", {
      baseRevision: reconciledState.revision,
      dictionaries: disabledDictionaries,
    });
    const disabledStatus = await request("hd_status");
    check(
      "a package-wide state change survives a lost CAS reply without splitting storage and native state",
      disabled.ok === true
        && disabled.state?.dictionaries?.[0]?.enabled === false
        && disabledStatus.dictionaryCount === 0,
      JSON.stringify({ disabled, disabledStatus }),
    );
    const staleEnable = await request("hd_apply_state", {
      baseRevision: reconciledState.revision,
      dictionaries: reconciledState.dictionaries,
    });
    const afterStaleEnable = await request("hd_status");
    check(
      "a stale package change restores the committed native load set",
      staleEnable.ok === false
        && staleEnable.conflict === true
        && staleEnable.state?.dictionaries?.[0]?.enabled === false
        && afterStaleEnable.dictionaryCount === 0,
      JSON.stringify({ staleEnable, afterStaleEnable }),
    );
    const reenabled = await request("hd_apply_state", {
      baseRevision: disabled.state.revision,
      dictionaries: reconciledState.dictionaries,
    });
    check(
      "an enabled logical package restores every native capability",
      reenabled.ok === true && (await request("hd_status")).dictionaryCount === 4,
      JSON.stringify(reenabled),
    );

    const scratchTitle = ".hdw-archive.zip";
    const scratchTitleImport = await request("hd_import", {
      blobUrl: createObjectURL(buildTitledZip(scratchTitle)),
      fileName: `${scratchTitle}.zip`,
    });
    check(
      "a fallback scratch archive cannot collide with an accepted dictionary title",
      scratchTitleImport.ok === true && scratchTitleImport.report?.title === scratchTitle,
      JSON.stringify(scratchTitleImport),
    );
    const scratchTitleRemoval = await request("hd_remove", { title: scratchTitle });
    check(
      "the scratch-title regression dictionary can be removed normally",
      scratchTitleRemoval.ok === true,
      JSON.stringify(scratchTitleRemoval),
    );
  });

  step("distinct on-disk titles have distinct stable package IDs", async () => {
    const canonicallyEquivalentTitles = ["Caf\u00e9", "Cafe\u0301"];
    for (const title of canonicallyEquivalentTitles) {
      const result = await request("hd_import", {
        blobUrl: createObjectURL(buildTitledZip(title)),
        fileName: `${title}.zip`,
      });
      check(`the ${JSON.stringify(title)} dictionary imports`, result.ok === true, JSON.stringify(result));
    }
    const canonicallyEquivalentPackages = (await storedDictionaryState()).dictionaries.filter(
      (dictionary) => canonicallyEquivalentTitles.includes(dictionary.title),
    );
    check(
      "distinct on-disk titles have distinct stable package IDs",
      canonicallyEquivalentPackages.length === 2
        && new Set(canonicallyEquivalentPackages.map((dictionary) => dictionary.id)).size === 2,
      JSON.stringify(canonicallyEquivalentPackages),
    );
    const stateWithThreePackages = await storedDictionaryState();
    const lookupBeforeReorder = await request("hd_lookup", { text: "食べる" });
    const statusBeforeReorder = await request("hd_status");
    const packageCount = stateWithThreePackages.dictionaries.length;
    const nativeBeforeReorder = { ...nativeCounts };
    const reorderedThreePackages = await request("hd_apply_state", {
      baseRevision: stateWithThreePackages.revision,
      dictionaries: [...stateWithThreePackages.dictionaries].reverse(),
    });
    const reorderSkippedWarmup = nativeCounts.lookups === nativeBeforeReorder.lookups;
    const lookupAfterReorder = await request("hd_lookup", { text: "食べる" });
    const statusAfterReorder = await request("hd_status");
    const dictionaryNames = (lookup) => lookup.results.flatMap((result) =>
      result.term.glossaries.map((glossary) => glossary.dictionary));
    check(
      "reordering loaded packages reorders the engine in place instead of reloading every package",
      reorderedThreePackages.ok === true
        && reorderedThreePackages.state.dictionaries.map(({ id }) => id).join()
          === [...stateWithThreePackages.dictionaries].reverse().map(({ id }) => id).join()
        && nativeCounts.resets === nativeBeforeReorder.resets
        && nativeCounts.adds === nativeBeforeReorder.adds
        && nativeCounts.reorders === nativeBeforeReorder.reorders + 1
        && reorderSkippedWarmup
        && statusAfterReorder.lastLoadPath === "order-only"
        && statusAfterReorder.dictionaryCount === statusBeforeReorder.dictionaryCount
        && statusAfterReorder.generation === statusBeforeReorder.generation + 1
        && lookupAfterReorder.ok === true
        && dictionaryNames(lookupAfterReorder).length === dictionaryNames(lookupBeforeReorder).length
        && dictionaryNames(lookupAfterReorder).length > 1
        && dictionaryNames(lookupAfterReorder).join() !== dictionaryNames(lookupBeforeReorder).join(),
      JSON.stringify({
        reorderedThreePackages,
        counts: { before: nativeBeforeReorder, after: nativeCounts },
        before: dictionaryNames(lookupBeforeReorder),
        after: dictionaryNames(lookupAfterReorder),
      }),
    );
    setPeakLoadedDictionaryPaths(0);
    const nativeBeforeDisable = { ...nativeCounts };
    const allDisabled = await request("hd_apply_state", {
      baseRevision: reorderedThreePackages.state.revision,
      dictionaries: reorderedThreePackages.state.dictionaries.map((dictionary) => ({
        ...dictionary,
        enabled: false,
      })),
    });
    const disabledValidationPeak = peakLoadedDictionaryPaths;
    const disabledStatusAfterValidation = await request("hd_status");
    const nativeBeforeRestore = { ...nativeCounts };
    const restoredThreePackages = await request("hd_apply_state", {
      baseRevision: allDisabled.state.revision,
      dictionaries: stateWithThreePackages.dictionaries,
    });
    const lookupAfterRestore = await request("hd_lookup", { text: "食べる" });
    check(
      "disabling and re-enabling packages this session already loaded drops and re-adds only them",
      allDisabled.ok === true
        && disabledStatusAfterValidation.dictionaryCount === 0
        && disabledValidationPeak === 0
        && nativeCounts.resets === nativeBeforeDisable.resets
        && nativeBeforeRestore.removes === nativeBeforeDisable.removes + packageCount
        && restoredThreePackages.ok === true
        && nativeCounts.adds === nativeBeforeRestore.adds + statusBeforeReorder.dictionaryCount
        && (await request("hd_status")).dictionaryCount === statusBeforeReorder.dictionaryCount
        && dictionaryNames(lookupAfterRestore).join() === dictionaryNames(lookupBeforeReorder).join(),
      JSON.stringify({
        allDisabled,
        disabledValidationPeak,
        restoredThreePackages,
        counts: { beforeDisable: nativeBeforeDisable, beforeRestore: nativeBeforeRestore, after: nativeCounts },
      }),
    );
    for (const title of canonicallyEquivalentTitles) {
      await request("hd_remove", { title });
    }
  });

  step("staging roots cannot be imported as dictionary titles", async () => {
    const removalRootImport = await request("hd_import", {
      blobUrl: createObjectURL(buildTitledZip(".hdw-remove")),
      fileName: "reserved-removal-root.zip",
    });
    check(
      "the removal staging root cannot be imported as a dictionary title",
      removalRootImport.ok === false
        && !(await storedDictionaryState()).dictionaries.some((entry) => entry.title === ".hdw-remove"),
      JSON.stringify(removalRootImport),
    );

    const legacyRemovalTitle = ".hdw-remove";
    const legacyRemovalPath = `/dicts/${legacyRemovalTitle}`;
    observedEngine.FS.mkdir(legacyRemovalPath);
    for (const name of observedEngine.FS.readdir(`/dicts/${FIXTURE_TITLE}`)) {
      if (name === "." || name === "..") continue;
      const source = `/dicts/${FIXTURE_TITLE}/${name}`;
      let bytes = observedEngine.FS.readFile(source);
      if (name === "index.json") {
        const legacyIndex = JSON.parse(new TextDecoder().decode(bytes));
        legacyIndex.title = legacyRemovalTitle;
        bytes = new TextEncoder().encode(JSON.stringify(legacyIndex));
      }
      observedEngine.FS.writeFile(`${legacyRemovalPath}/${name}`, bytes);
    }
    const stagedBesideLegacyPath = `${legacyRemovalPath}/${FIXTURE_TITLE}`;
    observedEngine.FS.mkdir(stagedBesideLegacyPath);
    for (const name of observedEngine.FS.readdir(`/dicts/${FIXTURE_TITLE}`)) {
      if (name !== "." && name !== "..") {
        observedEngine.FS.rename(
          `/dicts/${FIXTURE_TITLE}/${name}`,
          `${stagedBesideLegacyPath}/${name}`,
        );
      }
    }
    observedEngine.FS.rmdir(`/dicts/${FIXTURE_TITLE}`);
    const beforeLegacyRemovalReload = await storedDictionaryState();
    await storage.api().local.set({
      dictionaryState: {
        ...beforeLegacyRemovalReload,
        revision: beforeLegacyRemovalReload.revision + 1,
        dictionaries: [
          ...beforeLegacyRemovalReload.dictionaries,
          { ...importedPackage, id: "legacy-placeholder", title: legacyRemovalTitle, path: legacyRemovalPath },
        ],
      },
    });
    const legacyRemovalReload = await request("hd_reload");
    const afterLegacyRemovalReload = await storedDictionaryState();
    check(
      "removal recovery preserves a legacy .hdw-remove dictionary and restores its staged child",
      legacyRemovalReload.ok === true
        && observedEngine.FS.analyzePath(`${legacyRemovalPath}/.hoshidicts_5`).exists
        && observedEngine.FS.analyzePath(`/dicts/${FIXTURE_TITLE}/.hoshidicts_5`).exists
        && !observedEngine.FS.analyzePath(stagedBesideLegacyPath).exists
        && afterLegacyRemovalReload.dictionaries.some((dictionary) => dictionary.title === legacyRemovalTitle),
      JSON.stringify({ legacyRemovalReload, afterLegacyRemovalReload }),
    );
    const removedLegacyRemovalRoot = await request("hd_remove", { title: legacyRemovalTitle });
    const afterLegacyRemoval = await storedDictionaryState();
    check(
      "the preserved .hdw-remove dictionary remains removable",
      removedLegacyRemovalRoot.ok === true
        && !observedEngine.FS.analyzePath(legacyRemovalPath).exists
        && !afterLegacyRemoval.dictionaries.some(
          (dictionary) => dictionary.title === legacyRemovalTitle,
        ),
      JSON.stringify({ removedLegacyRemovalRoot, afterLegacyRemoval }),
    );
  });

  step("reload skips and reports an unloadable committed package", async () => {
    const invalidLoadTitle = "invalid-native-load";
    const invalidGenerationRoot = "/dicts/.hdw-generation-00000000-0000-4000-8000-000000000000";
    const invalidLoadPath = `${invalidGenerationRoot}/${invalidLoadTitle}`;
    const invalidImportDate = 0;
    observedEngine.FS.mkdir(invalidGenerationRoot);
    observedEngine.FS.mkdir(invalidLoadPath);
    observedEngine.FS.writeFile(`${invalidLoadPath}/.hoshidicts_3`, new Uint8Array());
    observedEngine.FS.writeFile(`${invalidLoadPath}/index.json`, JSON.stringify({
      title: invalidLoadTitle,
      revision: "test-1",
      importDate: invalidImportDate,
      counts: { terms: { total: 1 } },
    }));
    const stateBeforeInvalidLoad = await storedDictionaryState();
    const invalidPackage = {
      id: createHash("sha256").update(invalidLoadTitle).digest("hex").slice(0, 32),
      title: invalidLoadTitle,
      displayName: null,
      path: invalidLoadPath,
      enabled: true,
      favorite: false,
      revision: "test-1",
      isUpdatable: false,
      indexUrl: null,
      downloadUrl: null,
      language: null,
      termCount: 1,
      frequencyCount: 0,
      pitchCount: 0,
      kanjiCount: 0,
      mediaCount: 0,
      installedAt: new Date(invalidImportDate).toISOString(),
      lastUpdateCheck: null,
    };
    const invalidStateWrite = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: stateBeforeInvalidLoad.revision,
      dictionaries: [...stateBeforeInvalidLoad.dictionaries, invalidPackage],
    });
    const authoritativeInvalidState = invalidStateWrite.state;
    const invalidReload = await request("hd_reload");
    const stateAfterInvalidReload = await storedDictionaryState();
    const invalidStatus = await request("hd_status");
    const lookupBesideInvalid = await request("hd_lookup", { text: "食べる" });
    check(
      "reload skips and reports an unloadable committed package while the others keep working",
      invalidStateWrite.ok === true
        && authoritativeInvalidState.dictionaries.length === stateBeforeInvalidLoad.dictionaries.length + 1
        && invalidReload.ok === true
        && invalidReload.dictionaryCount === 4
        && invalidStatus.ok === true
        && invalidStatus.failedDictionaries.length === 1
        && invalidStatus.failedDictionaries[0].title === invalidLoadTitle
        && invalidStatus.failedDictionaries[0].id === invalidPackage.id
        && invalidStatus.failedDictionaries[0].error.includes("could not load")
        && lookupBesideInvalid.ok === true
        && lookupBesideInvalid.results.some((result) => result.term.expression === "食べる")
        && JSON.stringify(stateAfterInvalidReload.dictionaries.map(({ id, path }) => [id, path]))
          === JSON.stringify(authoritativeInvalidState.dictionaries.map(({ id, path }) => [id, path])),
      JSON.stringify({ invalidStateWrite, invalidReload, invalidStatus, lookupBesideInvalid, stateAfterInvalidReload }),
    );
    const beforeFailedPackageOrder = { ...nativeCounts };
    const reorderedInvalidState = await request("hd_apply_state", {
      baseRevision: stateAfterInvalidReload.revision,
      dictionaries: [...stateAfterInvalidReload.dictionaries].reverse(),
    });
    const reorderedInvalidStatus = await request("hd_status");
    check("reordering beside an unloadable committed package neither reloads nor loses its diagnostic",
      reorderedInvalidState.ok === true
        && nativeCounts.resets === beforeFailedPackageOrder.resets
        && nativeCounts.adds === beforeFailedPackageOrder.adds
        && nativeCounts.lookups === beforeFailedPackageOrder.lookups
        && nativeCounts.reorders === beforeFailedPackageOrder.reorders + 1
        && reorderedInvalidStatus.lastLoadPath === "order-only"
        && JSON.stringify(reorderedInvalidStatus.failedDictionaries) === JSON.stringify(invalidStatus.failedDictionaries),
      JSON.stringify({ beforeFailedPackageOrder, nativeCounts, reorderedInvalidStatus }));
    const disabledInvalidWrite = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: reorderedInvalidState.state.revision,
      dictionaries: stateAfterInvalidReload.dictionaries.map((dictionary) =>
        dictionary.title === invalidLoadTitle ? { ...dictionary, enabled: false } : dictionary),
    });
    const disabledInvalidReload = await request("hd_reload");
    const disabledInvalidStatus = await request("hd_status");
    const stateAfterDisabledInvalidReload = await storedDictionaryState();
    check(
      "a disabled package that never loaded this session is still validated and reported",
      disabledInvalidWrite.ok === true
        && disabledInvalidReload.ok === true
        && disabledInvalidReload.dictionaryCount === 4
        && disabledInvalidStatus.failedDictionaries.length === 1
        && disabledInvalidStatus.failedDictionaries[0].id === invalidPackage.id,
      JSON.stringify({ disabledInvalidWrite, disabledInvalidReload, disabledInvalidStatus }),
    );
    const beforeDisabledPackageOrder = { ...nativeCounts };
    const reorderedDisabledInvalid = await request("hd_apply_state", {
      baseRevision: stateAfterDisabledInvalidReload.revision,
      dictionaries: [...stateAfterDisabledInvalidReload.dictionaries].reverse(),
    });
    const reorderedDisabledStatus = await request("hd_status");
    check("an unchanged disabled failed package does not force order-only edits to rebuild",
      reorderedDisabledInvalid.ok === true
        && nativeCounts.resets === beforeDisabledPackageOrder.resets
        && nativeCounts.adds === beforeDisabledPackageOrder.adds
        && nativeCounts.lookups === beforeDisabledPackageOrder.lookups
        && nativeCounts.reorders === beforeDisabledPackageOrder.reorders + 1
        && reorderedDisabledStatus.lastLoadPath === "order-only"
        && JSON.stringify(reorderedDisabledStatus.failedDictionaries) === JSON.stringify(disabledInvalidStatus.failedDictionaries),
      JSON.stringify({ beforeDisabledPackageOrder, nativeCounts, reorderedDisabledStatus }));
    const repairedStateWrite = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: reorderedDisabledInvalid.state.revision,
      dictionaries: stateAfterDisabledInvalidReload.dictionaries.filter(
        (dictionary) => dictionary.title !== invalidLoadTitle,
      ),
    });
    observedEngine.FS.unlink(`${invalidLoadPath}/index.json`);
    observedEngine.FS.unlink(`${invalidLoadPath}/.hoshidicts_3`);
    observedEngine.FS.rmdir(invalidLoadPath);
    observedEngine.FS.rmdir(invalidGenerationRoot);
    const repairedReload = await request("hd_reload");
    const stateAfterRepair = await storedDictionaryState();
    const repairedStatus = await request("hd_status");
    check(
      "reload stops reporting the invalid package once it is explicitly removed",
      repairedStateWrite.ok === true
        && !repairedStateWrite.state.dictionaries.some(
          (dictionary) => dictionary.title === invalidLoadTitle,
        )
        && repairedReload.ok === true
        && repairedReload.dictionaryCount === 4
        && repairedStatus.failedDictionaries.length === 0
        && JSON.stringify(stateAfterRepair) === JSON.stringify(repairedStateWrite.state),
      JSON.stringify({ repairedStateWrite, repairedReload, repairedStatus, stateAfterRepair }),
    );
  });

  step("frequency sorting precedes result limits", async () => {
    const frequencyFixture = frequencyRankingFixture();
    const frequencyMetadata = [];
    for (const dictionary of frequencyFixture.dictionaries) {
      const imported = await request("hd_import", { blobUrl: createObjectURL(dictionary.archive) });
      const stored = (await storedDictionaryState()).dictionaries.find(({ title }) => title === dictionary.title);
      const index = stored && JSON.parse(new TextDecoder().decode(observedEngine.FS.readFile(`${stored.path}/index.json`)));
      frequencyMetadata.push(imported.ok && index?.frequencyMode === dictionary.frequencyMode
        && stored?.frequencyMode === dictionary.frequencyMode);
    }
    const frequencyOrders = [];
    const [rankTitle, occurrenceTitle] = frequencyFixture.dictionaries.map(({ title }) => title);
    for (const [frequencyDictionary, frequencyOrder, readings] of [
      [rankTitle, "ascending", ["い", "あ", "う"]],
      [rankTitle, "descending", ["う", "あ", "い"]],
      [occurrenceTitle, "ascending", ["あ", "い", "う"]],
      [occurrenceTitle, "descending", ["う", "い", "あ"]],
      [occurrenceTitle, "disabled", ["あ", "い", "う"]],
      [occurrenceTitle, "auto", ["い", "あ", "う"]],
    ]) {
      for (const maxResults of [1, 3]) {
        const ranked = await request("hd_lookup", {
          text: frequencyFixture.query, scanLength: 16, maxResults,
          options: { frequencyDictionary, frequencyOrder },
        });
        frequencyOrders.push(ranked.ok && ranked.results.length === maxResults
          && ranked.results.every(({ term }, index) => term.reading === readings[index]
            && term.glossaries.map(({ dictionary }) => dictionary).join("|") === `${rankTitle}|${occurrenceTitle}`));
      }
    }
    check("frequency sorting precedes result limits and preserves manifest-ordered dictionary identity",
      frequencyOrders.every(Boolean), JSON.stringify(frequencyOrders));
    const beforeFrequencyReload = await storedDictionaryState();
    const legacyFrequencyState = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker", type: "hd_state_cas", baseRevision: beforeFrequencyReload.revision,
      dictionaries: beforeFrequencyReload.dictionaries.map(({ frequencyMode, ...dictionary }) => dictionary),
    });
    const frequencyReload = await request("hd_reload");
    const afterFrequencyReload = await storedDictionaryState();
    frequencyMetadata.push(legacyFrequencyState.ok && frequencyReload.ok
      && frequencyFixture.dictionaries.every(({ title, frequencyMode }) =>
        afterFrequencyReload.dictionaries.find((dictionary) => dictionary.title === title)?.frequencyMode === frequencyMode));
    check("real WASM frequency modes reach package metadata and recover from old committed generations",
      frequencyMetadata.every(Boolean), JSON.stringify(frequencyMetadata));
    for (const { title } of frequencyFixture.dictionaries) await request("hd_remove", { title });
  });
});

export { studyGroup };
