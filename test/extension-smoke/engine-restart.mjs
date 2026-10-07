/*
 * Removal, the trained layout and an engine restart through the real engine.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./renderer.mjs";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { runInContext } from "node:vm";
import { backupEngineScenarios } from "../backup-engine-scenarios.mjs";
// The trained fixture is built in memory rather than read out of test/fixtures:
// the .zip on disk is only there for the browser test, which needs a real file to
// hand to an <input type=file>.
import {
  buildRecommendedZip,
  buildTitledZip,
  buildTrainedZip,
  TRAINED_TERMS,
  TRAINED_TITLE,
} from "../make-fixture.mjs";
import { studyGroup } from "./engine-library.mjs";
import {
  createHoshidicts,
  idb,
  observedEngine,
  offscreenChrome,
  pageChrome,
  request,
  storage,
  storedDictionaryState,
  swChrome,
  swContext,
  transactionCounts,
} from "./engine.mjs";
import {
  createObjectURL,
  EXTENSION,
  FIXTURE_TITLE,
  ownedGenerationRoot,
  RECOMMENDED_DICTIONARIES,
  remoteArchive,
} from "./fakes.mjs";
import { check, equal, section, step } from "./harness.mjs";

// Values that more than one step uses; the step that creates each one assigns it.
let selectedImageOptions, trainedExpression, trainedGlossary, restartedEngineService,
  importProgress, restartCounter, restartRequest, restartedReload;

describe("engine: removal, trained dictionaries and restart", () => {
  step("hd_remove", async () => {
    section("hd_remove");
    const rename = observedEngine.FS.rename.bind(observedEngine.FS);
    observedEngine.FS.rename = (source, destination) => {
      if ((observedEngine.FS.stat(source).mode & 0o170000) === 0o040000) {
        throw new Error("directory rename is unavailable");
      }
      return rename(source, destination);
    };
    // A storage failure after the real package has moved aside must restore both
    // the generated files and the live engine before reporting failure.
    const stateBeforeFailedRemove = await storedDictionaryState();
    selectedImageOptions = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision: (await storage.api().local.get("options")).options.revision,
      options: { popupImageSource: { kind: "dictionary", title: FIXTURE_TITLE },
        pitchAccentFuriganaDictionary: FIXTURE_TITLE },
    });
    storage.failNextSet("injected storage failure");
    const failedRemove = await request("hd_remove", { title: FIXTURE_TITLE });
    const stateAfterFailedRemove = await storedDictionaryState();
    const optionsAfterFailedRemove = (await storage.api().local.get("options")).options;
    check(
      "a remove whose storage write fails reports the failure",
      failedRemove.ok === false
        && JSON.stringify(stateAfterFailedRemove) === JSON.stringify(stateBeforeFailedRemove)
        && JSON.stringify(optionsAfterFailedRemove) === JSON.stringify(selectedImageOptions.options),
      JSON.stringify({ failedRemove, stateAfterFailedRemove, optionsAfterFailedRemove }),
    );
    const afterFailedRemove = await request("hd_status");
    equal(
      "a failed remove reloads the dictionaries it unloaded",
      [afterFailedRemove.ready, afterFailedRemove.dictionaryCount],
      [true, 4],
    );
  });

  step("hd_remove of a path-like title and of a missing title", async () => {
    // A title is a name, not a path: one spelled like a path names no
    // installed package and reaches nothing outside the dictionary root.
    const stateBeforeUnsafeRemove = await storedDictionaryState();
    const unsafeRemove = await request("hd_remove", { title: "../outside" });
    const afterUnsafeRemove = await request("hd_status");
    equal(
      "hd_remove of a title spelled like a path removes nothing",
      [unsafeRemove.ok, afterUnsafeRemove.dictionaryCount,
        JSON.stringify(await storedDictionaryState()) === JSON.stringify(stateBeforeUnsafeRemove)],
      [true, 4, true],
    );

    const writesBeforeRemove = storage.sets.length;
    const removed = await request("hd_remove", { title: FIXTURE_TITLE });
    const removalWrites = storage.sets.slice(writesBeforeRemove);
    check("hd_remove succeeds", removed.ok === true, JSON.stringify(removed));
    const afterRemove = await request("hd_status");
    equal("nothing is loaded after a remove", [afterRemove.ready, afterRemove.dictionaryCount], [true, 0]);
    const stateAfterRemove = await storedDictionaryState();
    equal("the logical dictionary inventory is empty", stateAfterRemove.dictionaries, []);
    equal("removing a dictionary prunes its stable group membership", stateAfterRemove.groups, [{
      ...studyGroup,
      dictionaryIds: [],
    }]);
    const optionsAfterRemove = (await storage.api().local.get("options")).options;
    const staleImageWrite = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision: selectedImageOptions.options.revision,
      options: { popupImageSource: selectedImageOptions.options.popupImageSource },
    });
    check(
      "removal atomically clears the selected image package and refuses a stale options write",
      optionsAfterRemove.popupImageSource === null
        && optionsAfterRemove.pitchAccentFuriganaDictionary === ""
        && optionsAfterRemove.revision === selectedImageOptions.options.revision + 1
        && staleImageWrite.conflict === true
        && staleImageWrite.options.popupImageSource === null
        && JSON.stringify(removalWrites) === JSON.stringify([["dictionaryState", "options"]]),
      JSON.stringify({ optionsAfterRemove, staleImageWrite, removalWrites }),
    );
    const generationBefore = afterRemove.generation;
    const noop = await request("hd_remove", { title: "never imported" });
    const afterNoop = await request("hd_status");
    equal(
      "removing an unknown title is a no-op that does not bump generation",
      [noop.ok, afterNoop.generation],
      [true, generationBefore],
    );
  });

  step("a trained (.hoshidicts_6) dictionary through the extension layer", async () => {
    section("a trained (.hoshidicts_6) dictionary through the extension layer");
    // Everything above imports the 6-row fixture, which is under the importer's
    // zstd-training floor and therefore lands in the untrained layout. Nothing
    // outside node-smoke.mjs had ever seen the layout the current engine writes for
    // a real dictionary: a .hoshidicts_6 marker, a dict.zstd, and glossaries compressed
    // against it. That layout has to survive the extension's strict-load and IDBFS
    // round trip, neither of which node-smoke.mjs touches.
    const trainedImport = await request("hd_import", {
      blobUrl: createObjectURL(buildTrainedZip()),
      fileName: "hachidori-fixture-trained.zip",
    });
    equal(
      "hd_import accepts a dictionary over the zstd training floor",
      [trainedImport.ok, trainedImport.report?.title, trainedImport.report?.termCount],
      [true, TRAINED_TITLE, TRAINED_TERMS.length],
    );
    // The import is not published until its exact manifest path strict-loads. A
    // runtime that does not recognise .hoshidicts_6 rejects this package instead.
    const trainedStatus = await request("hd_status");
    equal(
      "offscreen.js recognises the .hoshidicts_6 directory as a dictionary",
      [trainedStatus.ok, trainedStatus.dictionaryCount],
      [true, 1],
    );
    const trainedState = await storedDictionaryState();
    const trainedPackage = trainedState?.dictionaries?.[0];
    check(
      "the trained import writes one term-only logical package",
      trainedState?.dictionaries?.length === 1
        && trainedPackage?.title === TRAINED_TITLE
        && ownedGenerationRoot(trainedPackage?.path, TRAINED_TITLE) !== ""
        && trainedPackage?.enabled === true
        && trainedPackage?.termCount === TRAINED_TERMS.length
        && trainedPackage?.frequencyCount === 0
        && trainedPackage?.pitchCount === 0
        && trainedPackage?.kanjiCount === 0
        && trainedPackage?.mediaCount === 0,
      JSON.stringify(trainedState),
    );
    // The trained dictionary has to be in the store IDBFS repopulates from, not
    // just on the in-memory filesystem where the import ran.
    const trainedPath = trainedPackage?.path ?? "";
    const persisted = idb.keys("/dicts").filter((key) => key.startsWith(`${trainedPath}/`));
    check(
      "syncfs(false) persisted the marker and dict.zstd, not just the banks",
      persisted.includes(`${trainedPath}/dict.zstd`)
        && persisted.includes(`${trainedPath}/.hoshidicts_6`),
      JSON.stringify(persisted.sort()),
    );
    // The real assertion: these bytes only come back if the dictionary the importer
    // trained was found and loaded.
    [trainedExpression, , , , , trainedGlossary] = TRAINED_TERMS[TRAINED_TERMS.length - 1];
    const trainedLookup = await request("hd_lookup", {
      text: trainedExpression,
      maxResults: 32,
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    equal(
      "glossaries compressed against the trained dictionary survive the round trip",
      trainedLookup.results?.[0]?.term?.glossaries?.map((g) => [g.dictionary, g.glossary]),
      [[TRAINED_TITLE, JSON.stringify(trainedGlossary)]],
    );
  });

  step("backup scenarios through the real engine", async () => {
    const backupScenarioEvidence = await backupEngineScenarios({
      request,
      pageChrome,
      hostChrome: offscreenChrome,
      workerChrome: swChrome,
      storage,
      engine: observedEngine,
      transactionCounts,
      reconcileAutomatic: () => runInContext("reconcileAutomaticBackups()", swContext),
      check,
    });
    if (process.env.HACHIDORI_AUTOMATIC_BACKUP_BENCHMARK) {
      writeFileSync(
        process.env.HACHIDORI_AUTOMATIC_BACKUP_BENCHMARK,
        `${JSON.stringify(backupScenarioEvidence.automaticBackupBenchmark, null, 2)}\n`,
      );
    }
  });

  step("a restart and reload refuse an unreferenced on-disk dictionary", async () => {
    const unreferencedTitle = "hachidori-unreferenced-restart-fixture";
    const unreferencedImport = await request("hd_import", {
      blobUrl: createObjectURL(buildTitledZip(unreferencedTitle)),
      fileName: `${unreferencedTitle}.zip`,
    });
    const stateWithUnreferenced = await storedDictionaryState();
    const unreferencedPathBeforeStateRemoval = stateWithUnreferenced.dictionaries.find(
      (dictionary) => dictionary.title === unreferencedTitle,
    )?.path ?? "";
    const unreferencedStateWrite = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: stateWithUnreferenced.revision,
      dictionaries: stateWithUnreferenced.dictionaries.filter(
        (dictionary) => dictionary.title !== unreferencedTitle,
      ),
    });
    const revisionedState = unreferencedStateWrite.state;
    const fallbackPathBeforeRestart = revisionedState.dictionaries.find(
      (dictionary) => dictionary.title === TRAINED_TITLE,
    )?.path;

    restartedEngineService = await import(
      `file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}?restart`
    );
    importProgress = [];
    restartedEngineService.configureEngineService(
      (message) => offscreenChrome.runtime.sendMessage(message),
      {
        createHoshidicts,
        storageBackend: "idbfs",
        lowRam: true,
        reportProgress: (event) => importProgress.push({
          ...structuredClone(event),
          observedAt: performance.now(),
        }),
      },
    );
    restartCounter = 0;
    restartRequest = (type, fields = {}) => {
      restartCounter += 1;
      return restartedEngineService.handleEngineMessage({
        type,
        requestId: `restart-${restartCounter}`,
        ...fields,
      });
    };
    restartedEngineService.startEngine();
    let restartedStatus = await restartRequest("hd_status");
    const restartDeadline = Date.now() + 30000;
    while (!(restartedStatus.ok && restartedStatus.ready && !restartedStatus.loading)
        && Date.now() < restartDeadline) {
      await new Promise((done) => setTimeout(done, 25));
      restartedStatus = await restartRequest("hd_status");
    }
    const stateAfterRestart = await storedDictionaryState();
    restartedReload = await restartRequest("hd_reload");
    const stateAfterRestartedReload = await storedDictionaryState();
    const unreferencedGenerationPersisted = idb.keys("/dicts").some((path) =>
      path === unreferencedPathBeforeStateRemoval
        || path.startsWith(`${unreferencedPathBeforeStateRemoval}/`));
    equal(
      "a revisioned restart and reload refuse to auto-adopt an unreferenced on-disk dictionary",
      [
        unreferencedImport.ok,
        ownedGenerationRoot(unreferencedPathBeforeStateRemoval, unreferencedTitle) !== "",
        unreferencedStateWrite.ok,
        ownedGenerationRoot(fallbackPathBeforeRestart, TRAINED_TITLE) !== "",
        restartedStatus.ok,
        restartedStatus.dictionaryCount,
        stateAfterRestart?.dictionaries?.[0]?.path,
        stateAfterRestart,
        restartedReload.ok,
        restartedReload.dictionaryCount,
        stateAfterRestartedReload?.dictionaries?.[0]?.path,
        stateAfterRestartedReload,
        unreferencedGenerationPersisted,
      ],
      [
        true,
        true,
        true,
        true,
        true,
        1,
        fallbackPathBeforeRestart,
        revisionedState,
        true,
        1,
        fallbackPathBeforeRestart,
        revisionedState,
        false,
      ],
    );
  });

  step("a recommended first install downloads in the engine", async () => {
    // A recommended first install downloads its catalogue-pinned archive inside
    // the engine and reports download bytes, then one installation phase.
    const jmnedict = RECOMMENDED_DICTIONARIES.find((entry) => entry.sourceId === "jmnedict");
    const jmnedictArchive = new Uint8Array(buildRecommendedZip({
      title: jmnedict.title, revision: jmnedict.revision, indexUrl: jmnedict.indexUrl,
      downloadUrl: jmnedict.downloadUrl, capabilities: jmnedict.capabilities,
    }));
    const jmnedictRequests = { count: 0 };
    const downloadStarted = Promise.withResolvers();
    const releaseDownload = Promise.withResolvers();
    remoteArchive(
      jmnedict.downloadUrl,
      jmnedictArchive,
      "https://github.com/yomidevs/jmdict-yomitan/releases/download/JMnedict.2026-09-04/JMnedict.zip",
      jmnedictRequests,
      async () => {
        downloadStarted.resolve();
        await releaseDownload.promise;
      },
    );
    const generationBeforeStaging = restartedReload.generation;
    const remoteImportRequestId = `restart-${restartCounter + 1}`;
    const remoteRecommendedImportPromise = restartRequest("hd_import", {
      sourceId: jmnedict.sourceId, archiveUrl: jmnedict.downloadUrl, fileName: jmnedict.archiveName,
    });
    await downloadStarted.promise;
    const stagedStatus = await restartRequest("hd_status");
    const stagedLookupStartedAt = performance.now();
    const stagedLookup = await Promise.race([
      restartRequest("hd_lookup", { text: trainedExpression }),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2_000)),
    ]);
    const stagedLookupMs = performance.now() - stagedLookupStartedAt;
    releaseDownload.resolve();
    const remoteRecommendedImport = await remoteRecommendedImportPromise;
    const remoteRecommendedImportCompletedAt = performance.now();
    const remoteRecommendedState = await storedDictionaryState();
    const remoteRecommendedPackage = remoteRecommendedState.dictionaries.find((dictionary) => dictionary.sourceId === "jmnedict");
    const downloadEvents = importProgress.filter((event) => event.phase === "downloading");
    const installingEvents = importProgress.filter((event) => event.phase === "installing");
    const installPauseMs = remoteRecommendedImportCompletedAt - installingEvents[0]?.observedAt;
    const wrongArchive = await restartRequest("hd_import", {
      sourceId: "jiten", archiveUrl: "https://example.test/jiten.zip", fileName: "jiten-frequency.zip",
    });
    const noSource = await restartRequest("hd_import", { archiveUrl: jmnedict.downloadUrl, fileName: "JMnedict.zip" });
    const jiten = RECOMMENDED_DICTIONARIES.find((entry) => entry.sourceId === "jiten");
    remoteArchive(jiten.downloadUrl, jmnedictArchive, "https://unrelated.example/jiten.zip");
    const unexpectedFinal = await restartRequest("hd_import", { sourceId: "jiten", archiveUrl: jiten.downloadUrl, fileName: jiten.archiveName });
    const declared = restartedEngineService.declaredResponseLength;
    const headers = (values) => ({ headers: { get: (name) => values[name.toLowerCase()] ?? null } });
    check(
      "a recommended first install downloads its catalogue archive in the engine and reports download then installation phases",
      remoteRecommendedImport.ok === true && remoteRecommendedImport.report?.success === true && jmnedictRequests.count === 1
        && remoteRecommendedPackage?.title === jmnedict.title && remoteRecommendedPackage.indexUrl === jmnedict.indexUrl
        && remoteRecommendedPackage.downloadUrl === jmnedict.downloadUrl && remoteRecommendedPackage.isUpdatable === true
        && stagedStatus.loading === true && stagedStatus.generation === generationBeforeStaging
        && stagedLookup.timeout !== true
        && stagedLookup.ok === true
        && stagedLookup.generation === generationBeforeStaging
        && stagedLookup.results?.some((result) => result.term?.expression === trainedExpression)
        && importProgress.every((event) => event.requestId === remoteImportRequestId)
        && downloadEvents.length >= 1 && downloadEvents.every((event) => event.totalBytes === null)
        && downloadEvents.at(-1).receivedBytes === jmnedictArchive.byteLength
        && installingEvents.length === 1 && installingEvents[0].receivedBytes === jmnedictArchive.byteLength
        // An IDBFS runtime has no isolated importer, so the archive is imported
        // inside the live engine and the bridge is told to refuse reads.
        && installingEvents[0].fallback === "memory"
        && importProgress.indexOf(installingEvents[0]) > importProgress.indexOf(downloadEvents.at(-1))
        && Number.isFinite(stagedLookupMs) && Number.isFinite(installPauseMs) && installPauseMs >= 0
        && wrongArchive.ok === false && wrongArchive.error.includes("catalogue archive URL")
        && noSource.ok === false && noSource.error.includes("no archive URL")
        && unexpectedFinal.ok === false && unexpectedFinal.error.includes("unexpected final URL")
        && (await storedDictionaryState()).dictionaries.length === remoteRecommendedState.dictionaries.length
        && declared(headers({ "content-length": "4096" })) === 4096
        && declared(headers({ "content-length": "4096", "content-encoding": "gzip" })) === null
        && declared(headers({ "content-length": "4096", "content-encoding": "identity" })) === 4096
        && declared(headers({ "content-length": "0" })) === null && declared(headers({})) === null && declared({ body: {} }) === null,
      JSON.stringify({ remoteRecommendedImport, remoteRecommendedPackage, importProgress, wrongArchive, noSource, unexpectedFinal, jmnedictRequests }),
    );
    console.log(`        staged lookup ${stagedLookupMs.toFixed(1)} ms; serialized install ${installPauseMs.toFixed(1)} ms`);
  });
});

export { trainedExpression };
