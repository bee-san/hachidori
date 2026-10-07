/*
 * The managed personal dictionary: storage ownership, the engine transaction and Settings.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import {
  buildCustomDictionaryZip,
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_TITLE,
  customDictionarySemanticRevision,
  parseCustomDictionary,
} from "../../extension/custom-dictionary.js";
import { buildTitledZip } from "../make-fixture.mjs";
import {
  createObjectURL,
  EXTENSION,
  EXTENSION_ORIGIN,
  genericPackage,
  installFetch,
  installNavigator,
  loadBackgroundScript,
  loadJsdom,
  loadSettingsScript,
  makeAlarms,
  makeBus,
  makeChrome,
  makeStorage,
  navigateSettingsSection,
} from "./fakes.mjs";
import { check, equal, section, test } from "./harness.mjs";

async function customBackgroundStage() {
  const bus = makeBus();
  const storage = makeStorage();
  const alarms = makeAlarms();
  const swChrome = makeChrome("custom-background-sw", bus, storage, alarms);
  loadBackgroundScript({
    chrome: swChrome,
    console,
    fetch: globalThis.fetch,
    setTimeout,
    clearTimeout,
    Promise,
    Error,
    TypeError,
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
  const pageChrome = makeChrome("custom-background-page", bus, storage, alarms);
  const send = (type, fields = {}) => pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type,
    requestId: `custom-background-${type}`,
    ...fields,
  });

  const initialState = await send("hd_state_cas", { baseRevision: 0, dictionaries: [] });
  await send("hd_state_read");
  const ordinaryReadKeys = storage.gets.at(-1);
  const empty = await send("hd_custom_read");
  const customReadKeys = storage.gets.at(-1);
  const source = "\u98df\u3079\u308b, \u305f\u3079\u308b, to eat\r\n";
  const semanticRevision = await customDictionarySemanticRevision(
    parseCustomDictionary(source).entries,
  );
  const customPackage = genericPackage({
    id: CUSTOM_DICTIONARY_ID,
    title: CUSTOM_DICTIONARY_TITLE,
    path: `/dicts/.hdw-generation-00000000-0000-4000-8000-000000000001/${CUSTOM_DICTIONARY_TITLE}`,
    revision: semanticRevision,
  });
  const committed = await send("hd_custom_cas", {
    baseDocumentRevision: 0,
    baseRevision: initialState.state?.revision,
    text: source,
    semanticRevision,
    dictionaries: [customPackage],
  });
  const atomicKeys = storage.sets.at(-1);
  const changedSource = `${source}追加, ついか, added\r\n`;
  const changedSemanticRevision = await customDictionarySemanticRevision(
    parseCustomDictionary(changedSource).entries,
  );
  const omittedChangedState = await send("hd_custom_cas", {
    baseDocumentRevision: committed.document?.revision,
    baseRevision: committed.state?.revision,
    text: changedSource,
    semanticRevision: changedSemanticRevision,
  });
  const staleChangedPackage = await send("hd_custom_cas", {
    baseDocumentRevision: committed.document?.revision,
    baseRevision: committed.state?.revision,
    text: changedSource,
    semanticRevision: changedSemanticRevision,
    dictionaries: [customPackage],
  });
  const afterRejectedDivergence = await send("hd_custom_read");
  const removeThroughOrdinaryCas = await send("hd_state_cas", {
    baseRevision: committed.state?.revision,
    dictionaries: [],
  });
  const disableThroughOrdinaryCas = await send("hd_state_cas", {
    baseRevision: committed.state?.revision,
    dictionaries: [{ ...customPackage, enabled: false }],
  });
  const stale = await send("hd_custom_cas", {
    baseDocumentRevision: 0,
    baseRevision: committed.state?.revision,
    text: "stale, \u3059\u3066\u30fc\u308b, stale",
    semanticRevision: await customDictionarySemanticRevision([
      { term: "stale", reading: "\u3059\u3066\u30fc\u308b", definition: "stale" },
    ]),
    dictionaries: [customPackage],
  });
  const emptySource = "# cleared\nmalformed";
  const emptySemanticRevision = await customDictionarySemanticRevision([]);
  const removed = await send("hd_custom_cas", {
    baseDocumentRevision: committed.document?.revision,
    baseRevision: committed.state?.revision,
    text: emptySource,
    semanticRevision: emptySemanticRevision,
    dictionaries: [],
  });
  const stored = await storage.api().local.get(["customDictionarySource", "dictionaryState"]);

  return {
    atomicKeys,
    committed,
    disableThroughOrdinaryCas,
    empty,
    initialState,
    ordinaryReadKeys,
    customReadKeys,
    omittedChangedState,
    staleChangedPackage,
    afterRejectedDivergence,
    removeThroughOrdinaryCas,
    removed,
    stale,
    stored,
  };
}

async function customEngineStage() {
  installFetch();
  installNavigator();
  const bus = makeBus();
  const storage = makeStorage();
  const alarms = makeAlarms();
  const swChrome = makeChrome("custom-engine-sw", bus, storage, alarms);
  loadBackgroundScript({
    chrome: swChrome,
    console,
    fetch: globalThis.fetch,
    setTimeout,
    clearTimeout,
    Promise,
    Error,
    TypeError,
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
  const pageChrome = makeChrome("custom-engine-page", bus, storage, alarms);
  const engineChrome = makeChrome("custom-engine-offscreen", bus, storage, alarms);
  const engineService = await import(
    `file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}?custom-engine-stage`
  );
  const { default: createHoshidicts } = await import(
    `file://${resolve(EXTENSION, "vendor", "hoshidicts.mjs").replace(/\\/gu, "/")}?custom-engine-stage`
  );
  let engine = null;
  let advancePresentationBeforeCustomCas = false;
  let advancePresentationAfterCustomCas = false;
  let loseNextCustomCasReply = false;
  const sendWorker = (type, fields = {}) => pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type,
    ...fields,
  });
  engineService.configureEngineService(
    async (message) => {
      if (message.type === "hd_custom_cas" && advancePresentationBeforeCustomCas) {
        advancePresentationBeforeCustomCas = false;
        const current = (await storage.api().local.get("dictionaryState")).dictionaryState;
        await sendWorker("hd_state_cas", {
          baseRevision: current.revision,
          dictionaries: current.dictionaries.map((dictionary) =>
            dictionary.id === CUSTOM_DICTIONARY_ID
              ? { ...dictionary, displayName: "Personal notes", favorite: true }
              : dictionary),
        });
      }
      const reply = await engineChrome.runtime.sendMessage(message);
      if (message.type === "hd_custom_cas"
          && reply?.ok === true
          && advancePresentationAfterCustomCas) {
        advancePresentationAfterCustomCas = false;
        await sendWorker("hd_state_cas", {
          baseRevision: reply.state.revision,
          dictionaries: reply.state.dictionaries.map((dictionary) =>
            dictionary.id === CUSTOM_DICTIONARY_ID
              ? { ...dictionary, displayName: "Advanced after commit" }
              : dictionary),
        });
        throw new Error("injected ambiguous custom CAS reply");
      }
      if (message.type === "hd_custom_cas" && reply?.ok === true && loseNextCustomCasReply) {
        loseNextCustomCasReply = false;
        throw new Error("injected lost custom CAS reply");
      }
      return reply;
    },
    {
      createHoshidicts: async (...args) => {
        engine = await createHoshidicts(...args);
        return engine;
      },
      storageBackend: "memory",
      lowRam: true,
    },
  );
  engineService.startEngine();
  let counter = 0;
  const request = (type, fields = {}) => {
    counter += 1;
    return engineService.handleEngineMessage({
      type,
      requestId: `custom-engine-${counter}`,
      ...fields,
    });
  };
  let status = await request("hd_status");
  const deadline = Date.now() + 30_000;
  while (!(status.ok && status.ready && !status.loading) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
    status = await request("hd_status");
  }

  const reservedEntries = [{ term: "reserved", reading: "\u3088\u3084\u304f", definition: "reserved" }];
  const reservedRevision = await customDictionarySemanticRevision(reservedEntries);
  const reservedImport = await request("hd_import", {
    blobUrl: createObjectURL(buildCustomDictionaryZip(reservedEntries, reservedRevision)),
    fileName: "reserved-custom.zip",
  });
  const afterReservedImport = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_state_read",
  });
  const generationRoots = () => engine.FS.readdir("/dicts").filter((name) =>
    name !== "." && name !== ".." && name.startsWith(".hdw-generation-"));
  check(
    "public ZIP import cannot claim the reserved custom title",
    reservedImport.ok === false
      && afterReservedImport.state?.dictionaries?.length === 0
      && generationRoots().length === 0,
    JSON.stringify({ reservedImport, afterReservedImport, roots: generationRoots() }),
  );
  if (reservedImport.ok === true) {
    await request("hd_remove", { title: CUSTOM_DICTIONARY_TITLE });
  }

  const source = [
    "# personal entries",
    "\u98df\u3079\u308b, \u305f\u3079\u308b, to eat",
    "literal, \u308a\u3066\u3089\u308b, literal\\\\nmarker",
    "broken",
    "",
  ].join("\r\n");
  const saved = await request("hd_custom_save", { baseDocumentRevision: 0, text: source });
  const savedStatus = await request("hd_status");
  const savedLookup = await request("hd_lookup_dictionary", {
    dictionary: CUSTOM_DICTIONARY_TITLE,
    text: "\u98df\u3079\u308b",
  });
  check(
    "custom save compiles with real WASM and publishes the fixed package first and enabled",
    saved.type === "hd_custom_save_result"
      && /^custom-engine-\d+$/u.test(saved.requestId)
      && saved.ok === true
      && saved.errors?.length === 1
      && saved.document?.revision === 1
      && saved.state?.dictionaries?.length === 1
      && saved.state.dictionaries[0]?.id === CUSTOM_DICTIONARY_ID
      && saved.state.dictionaries[0]?.title === CUSTOM_DICTIONARY_TITLE
      && saved.state.dictionaries[0]?.enabled === true
      && saved.state.dictionaries[0]?.revision === saved.document?.semanticRevision
      && saved.state.dictionaries[0]?.termCount === 2
      && savedStatus.dictionaryCount === 1
      && savedLookup.results?.[0]?.term?.expression === "\u98df\u3079\u308b",
    JSON.stringify({ saved, savedStatus, savedLookup }),
  );

  const protectedRemoval = await request("hd_remove", {
    id: CUSTOM_DICTIONARY_ID,
    title: CUSTOM_DICTIONARY_TITLE,
  });
  const protectedDisable = await request("hd_apply_state", {
    baseRevision: saved.state?.revision,
    dictionaries: (saved.state?.dictionaries ?? []).map((dictionary) => ({
      ...dictionary,
      enabled: false,
    })),
  });
  const afterProtectedMutation = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_custom_read",
  });
  check(
    "public removal and ordinary state writes cannot mutate the fixed package",
    protectedRemoval.ok === false
      && protectedDisable.ok === false
      && afterProtectedMutation.state?.dictionaries?.[0]?.enabled === true,
    JSON.stringify({ protectedRemoval, protectedDisable, afterProtectedMutation }),
  );

  const reformattedSource = [
    "# reformatted only",
    " \u98df\u3079\u308b , \u305f\u3079\u308b , to eat ",
    "literal,\u308a\u3066\u3089\u308b,literal\\\\nmarker",
    "",
  ].join("\r\n");
  const beforeSourceOnly = await request("hd_status");
  const sourceOnly = await request("hd_custom_save", {
    baseDocumentRevision: saved.document?.revision ?? 0,
    text: reformattedSource,
  });
  const afterSourceOnly = await request("hd_status");
  const exactNoop = await request("hd_custom_save", {
    baseDocumentRevision: sourceOnly.document?.revision ?? 0,
    text: reformattedSource,
  });
  check(
    "source-only and exact semantic no-ops do not rebuild or bump dictionary state",
    sourceOnly.ok === true
      && sourceOnly.rebuilt === false
      && sourceOnly.document?.revision === (saved.document?.revision ?? 0) + 1
      && sourceOnly.state?.revision === saved.state?.revision
      && sourceOnly.state?.dictionaries?.[0]?.path === saved.state?.dictionaries?.[0]?.path
      && afterSourceOnly.generation === beforeSourceOnly.generation
      && exactNoop.ok === true
      && exactNoop.document?.revision === sourceOnly.document?.revision
      && exactNoop.state?.revision === sourceOnly.state?.revision
      && (await request("hd_status")).generation === beforeSourceOnly.generation,
    JSON.stringify({ saved, sourceOnly, exactNoop, beforeSourceOnly, afterSourceOnly }),
  );

  const stale = await request("hd_custom_save", {
    baseDocumentRevision: saved.document?.revision ?? 0,
    text: "stale, \u3059\u3066\u30fc\u308b, stale",
  });
  check(
    "a stale Settings save is refused before compilation",
    stale.ok === false
      && stale.stale === true
      && stale.document?.revision === sourceOnly.document?.revision
      && stale.state?.dictionaries?.[0]?.path === sourceOnly.state?.dictionaries?.[0]?.path,
    JSON.stringify(stale),
  );

  const appended = await request("hd_custom_append", {
    entry: { term: "\u6ce8\u8a18", reading: "\u3061\u3085\u3046\u304d", definition: "noted\nagain" },
  });
  const appendedLookup = await request("hd_lookup_dictionary", {
    dictionary: CUSTOM_DICTIONARY_TITLE,
    text: "\u6ce8\u8a18",
  });
  check(
    "queued Note append reads the latest source, preserves CRLF, and recompiles once",
    appended.type === "hd_custom_append_result"
      && /^custom-engine-\d+$/u.test(appended.requestId)
      && appended.ok === true
      && appended.document?.revision === (sourceOnly.document?.revision ?? 0) + 1
      && appended.document?.text.includes("\r\n\u6ce8\u8a18, \u3061\u3085\u3046\u304d, noted\\nagain\r\n")
      && appended.state?.revision === (sourceOnly.state?.revision ?? 0) + 1
      && appendedLookup.results?.[0]?.term?.expression === "\u6ce8\u8a18",
    JSON.stringify({ appended, appendedLookup }),
  );

  const conflictSource = `${appended.document?.text ?? ""}conflict, \u304d\u3087\u3046\u305d\u3046, conflict\r\n`;
  advancePresentationBeforeCustomCas = true;
  const conflictSaved = await request("hd_custom_save", {
    baseDocumentRevision: appended.document?.revision ?? 0,
    text: conflictSource,
  });
  check(
    "custom state CAS retries preserve concurrent presentation edits",
    conflictSaved.ok === true
      && conflictSaved.document?.text === conflictSource
      && conflictSaved.state?.dictionaries?.[0]?.displayName === "Personal notes"
      && conflictSaved.state?.dictionaries?.[0]?.favorite === true
      && conflictSaved.state?.dictionaries?.[0]?.enabled === true
      && conflictSaved.state?.dictionaries?.[0]?.path !== appended.state?.dictionaries?.[0]?.path
      && generationRoots().length === 1,
    JSON.stringify({ conflictSaved, roots: generationRoots() }),
  );

  const lostSource = `${conflictSource}lost, \u308d\u3059\u3068, recovered\r\n`;
  loseNextCustomCasReply = true;
  const recoveredLostReply = await request("hd_custom_save", {
    baseDocumentRevision: conflictSaved.document?.revision ?? 0,
    text: lostSource,
  });
  check(
    "an exact source and state readback recovers a lost custom CAS reply",
    recoveredLostReply.ok === true
      && recoveredLostReply.document?.text === lostSource
      && recoveredLostReply.state?.dictionaries?.[0]?.revision
        === recoveredLostReply.document?.semanticRevision
      && generationRoots().length === 1,
    JSON.stringify({ recoveredLostReply, roots: generationRoots() }),
  );

  const beforeFailedSave = await sendWorker("hd_custom_read");
  const rootsBeforeFailedSave = generationRoots();
  storage.failNextSet("injected custom storage failure");
  const failedSave = await request("hd_custom_save", {
    baseDocumentRevision: beforeFailedSave.document?.revision ?? 0,
    text: `${lostSource}failure, \u3057\u3063\u3071\u3044, failure\r\n`,
  });
  const afterFailedSave = await sendWorker("hd_custom_read");
  const statusAfterFailedSave = await request("hd_status");
  check(
    "a failed custom commit restores the working generation without debris",
    failedSave.ok === false
      && failedSave.generation === statusAfterFailedSave.generation
      && failedSave.generation > 0
      && JSON.stringify(afterFailedSave) === JSON.stringify(beforeFailedSave)
      && JSON.stringify(generationRoots()) === JSON.stringify(rootsBeforeFailedSave),
    JSON.stringify({
      failedSave,
      statusAfterFailedSave,
      beforeFailedSave,
      afterFailedSave,
      roots: generationRoots(),
    }),
  );

  const invariantPeer = await request("hd_import", {
    blobUrl: createObjectURL(buildTitledZip("Custom invariant peer")),
    fileName: "custom-invariant-peer.zip",
  });
  const stateWithInvariantPeer = await sendWorker("hd_custom_read");
  // Issue #358: the reader's personalDictionary flag filters the managed
  // package's glossaries per request; the package stays loaded and first.
  const personalLookups = {};
  const statusBeforePersonal = await request("hd_status");
  for (const personalDictionary of [false, true]) {
    const options = { personalDictionary };
    personalLookups[personalDictionary] = {
      shared: await request("hd_lookup", { text: "\u98df\u3079\u308b", options }),
      personalOnly: await request("hd_lookup", { text: "\u6ce8\u8a18", options }),
      routed: await request("hd_lookup_dictionary", { dictionary: CUSTOM_DICTIONARY_TITLE, text: "\u6ce8\u8a18", options }),
    };
  }
  const glossaryTitles = (reply) => (reply.results ?? []).flatMap((result) =>
    (result.term?.glossaries ?? []).map((glossary) => glossary.dictionary));
  const personalOff = personalLookups.false;
  const personalOn = personalLookups.true;
  check(
    "a lookup with the personal dictionary off leaves out only its glossaries without reloading the engine",
    invariantPeer.ok === true
      && personalOff.shared.ok === true && glossaryTitles(personalOff.shared).length > 0
      && glossaryTitles(personalOff.shared).every((title) => title === "Custom invariant peer")
      && personalOff.personalOnly.ok === true && personalOff.personalOnly.results.length === 0
      && personalOff.routed.ok === true && personalOff.routed.results.length === 0
      && glossaryTitles(personalOn.shared).includes(CUSTOM_DICTIONARY_TITLE)
      && glossaryTitles(personalOn.shared).includes("Custom invariant peer")
      && personalOn.personalOnly.results[0]?.term?.expression === "\u6ce8\u8a18"
      && personalOn.routed.results[0]?.term?.expression === "\u6ce8\u8a18"
      && (await request("hd_status")).generation === statusBeforePersonal.generation
      && JSON.stringify(await sendWorker("hd_custom_read")) === JSON.stringify(stateWithInvariantPeer),
    JSON.stringify({ personalLookups, statusBeforePersonal }),
  );
  // Word highlighting (#520) splits the page as a hover reads it: with the
  // personal dictionary off, a word only it has (注記) is no span, while one
  // another dictionary has too (食べる) stays.
  const personalSegments = {};
  for (const personalDictionary of [false, true]) {
    personalSegments[personalDictionary] = await request("hd_segment", { scanLength: 16, options: { personalDictionary },
      chunks: [{ id: 0, text: "\u6ce8\u8a18\u3068\u98df\u3079\u308b" }] });
  }
  const segmentHeadwords = (reply) => (reply.segments?.[0]?.spans ?? []).map((span) => span.candidates[0]?.expression);
  check(
    "segmentation with the personal dictionary off leaves out only the words it alone has",
    personalSegments.false.ok === true && !segmentHeadwords(personalSegments.false).includes("\u6ce8\u8a18")
      && segmentHeadwords(personalSegments.false).includes("\u98df\u3079\u308b")
      && personalSegments.true.ok === true && segmentHeadwords(personalSegments.true).includes("\u6ce8\u8a18")
      && segmentHeadwords(personalSegments.true).includes("\u98df\u3079\u308b"),
    JSON.stringify(personalSegments),
  );
  const brokenState = {
    ...stateWithInvariantPeer.state,
    revision: stateWithInvariantPeer.state.revision + 1,
    dictionaries: stateWithInvariantPeer.state.dictionaries.map((dictionary, index) => index === 0
      ? { ...dictionary, installedAt: "2000-01-01T00:00:00.000Z", language: "en" }
      : { ...dictionary, id: CUSTOM_DICTIONARY_ID }),
  };
  await storage.api().local.set({ dictionaryState: brokenState });
  const repaired = await request("hd_custom_save", {
    baseDocumentRevision: afterFailedSave.document.revision,
    text: afterFailedSave.document.text,
  });
  check(
    "a semantic no-op rebuilds a committed package that violates fixed invariants",
    invariantPeer.ok === true
      && repaired.ok === true
      && repaired.rebuilt === true
      && repaired.document?.revision === afterFailedSave.document.revision
      && repaired.state?.revision === brokenState.revision + 1
      && repaired.state?.dictionaries?.length === 1
      && repaired.state?.dictionaries?.[0]?.enabled === true
      && repaired.state?.dictionaries?.[0]?.language === "ja"
      && repaired.state?.dictionaries?.[0]?.path
        !== afterFailedSave.state?.dictionaries?.[0]?.path
      && generationRoots().length === 1,
    JSON.stringify({ repaired, roots: generationRoots() }),
  );

  const legacyCollisionId = "legacy-reserved-title-package";
  const collisionState = {
    ...repaired.state,
    revision: repaired.state.revision + 1,
    dictionaries: repaired.state.dictionaries.map((dictionary) => ({
      ...dictionary,
      id: legacyCollisionId,
    })),
  };
  await storage.api().local.set({ dictionaryState: collisionState });
  const collisionSave = await request("hd_custom_save", {
    baseDocumentRevision: repaired.document.revision,
    text: repaired.document.text,
  });
  const removedCollision = await request("hd_remove", {
    id: legacyCollisionId,
    title: CUSTOM_DICTIONARY_TITLE,
  });
  const rebuiltAfterCollision = await request("hd_custom_save", {
    baseDocumentRevision: repaired.document.revision,
    text: repaired.document.text,
  });
  check(
    "a pre-existing reserved-title package is a removable collision, not the managed package",
    collisionSave.ok === false
      && collisionSave.error?.includes("already installed")
      && removedCollision.ok === true
      && rebuiltAfterCollision.ok === true
      && rebuiltAfterCollision.state?.dictionaries?.[0]?.id === CUSTOM_DICTIONARY_ID
      && generationRoots().length === 1,
    JSON.stringify({ collisionSave, removedCollision, rebuiltAfterCollision, roots: generationRoots() }),
  );

  const ambiguousSource = `${rebuiltAfterCollision.document?.text ?? ""}ambiguous, \u3042\u3044\u307e\u3044, retained\r\n`;
  const rootsBeforeAmbiguous = generationRoots();
  advancePresentationAfterCustomCas = true;
  const ambiguous = await request("hd_custom_save", {
    baseDocumentRevision: rebuiltAfterCollision.document?.revision ?? 0,
    text: ambiguousSource,
  });
  const authoritativeAfterAmbiguous = await sendWorker("hd_custom_read");
  const rootsAfterAmbiguous = generationRoots();
  const recoveredAmbiguous = await request("hd_reload");
  check(
    "a non-exact lost-reply readback retains both generations until authoritative reload",
    ambiguous.ok === false
      && ambiguous.error?.includes("outcome is unknown")
      && authoritativeAfterAmbiguous.document?.text === ambiguousSource
      && authoritativeAfterAmbiguous.state?.dictionaries?.[0]?.displayName
        === "Advanced after commit"
      && rootsBeforeAmbiguous.length === 1
      && rootsAfterAmbiguous.length === 2
      && recoveredAmbiguous.ok === true
      && generationRoots().length === 1,
    JSON.stringify({
      ambiguous,
      authoritativeAfterAmbiguous,
      recoveredAmbiguous,
      rootsBeforeAmbiguous,
      rootsAfterAmbiguous,
      rootsAfterReload: generationRoots(),
    }),
  );

  const clearedSource = "# retained source\r\nmalformed";
  const cleared = await request("hd_custom_save", {
    baseDocumentRevision: authoritativeAfterAmbiguous.document?.revision ?? 0,
    text: clearedSource,
  });
  const clearedStatus = await request("hd_status");
  check(
    "zero valid rows save the source and atomically remove the managed package",
    cleared.ok === true
      && cleared.removed === true
      && cleared.errors?.length === 1
      && cleared.document?.text === clearedSource
      && cleared.state?.dictionaries?.length === 0
      && clearedStatus.dictionaryCount === 0
      && generationRoots().length === 0,
    JSON.stringify({ cleared, clearedStatus, roots: generationRoots() }),
  );
}

async function settingsCustomDictionaryStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html#custom-dictionary`,
  });
  const { window } = dom;
  const customPackage = genericPackage({
    id: CUSTOM_DICTIONARY_ID,
    title: CUSTOM_DICTIONARY_TITLE,
    path: `/dicts/custom-generation/${CUSTOM_DICTIONARY_TITLE}`,
    revision: "a".repeat(64),
    enabled: true,
    termCount: 1,
  });
  let state = {
    schemaVersion: 1,
    revision: 40,
    dictionaries: [
      customPackage,
      genericPackage({ id: "ordinary-id", title: "Ordinary" }),
      genericPackage({ id: "third-id", title: "Third" }),
    ],
    groups: [],
  };
  let customDocument = {
    schemaVersion: 1,
    revision: 5,
    semanticRevision: "a".repeat(64),
    text: "initial, いにしゃる, first\n",
  };
  let storageListener = null;
  let holdFirstRead = true;
  let pendingRead = null;
  let pendingSave = null;
  const customReadRequests = [];
  const customSaveRequests = [];
  const stateRequests = [];
  const storageGetKeys = [];
  const publish = (changes) => storageListener?.(changes, "local");
  const readReply = () => ({
    ok: true,
    document: structuredClone(customDocument),
    state: structuredClone(state),
  });

  window.chrome = {
    runtime: {
      id: "hachidoricustomsettingssmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: 3 };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_custom_read") {
          customReadRequests.push(structuredClone(message));
          if (holdFirstRead) {
            holdFirstRead = false;
            const olderReply = readReply();
            return new Promise((resolveRead) => {
              pendingRead = () => {
                pendingRead = null;
                resolveRead(olderReply);
              };
            });
          }
          return readReply();
        }
        if (message.type === "hd_custom_save") {
          customSaveRequests.push(structuredClone(message));
          return new Promise((resolveSave) => {
            pendingSave = resolveSave;
          });
        }
        if (message.type === "hd_apply_state" || message.type === "hd_state_cas") {
          stateRequests.push(structuredClone(message));
          state = {
            ...state,
            revision: state.revision + 1,
            dictionaries: structuredClone(message.dictionaries),
          };
          publish({ dictionaryState: { newValue: structuredClone(state) } });
          return { ok: true, state: structuredClone(state) };
        }
        throw new Error(`unexpected custom settings request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get(keys) {
          storageGetKeys.push(structuredClone(keys));
          return { options: { kanjiClickDictionary: "" } };
        },
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        },
      },
    },
  };
  loadSettingsScript(window);

  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((done) => window.setTimeout(done, 5));
    }
  };
  await waitFor(() => window.document.getElementById("engine-status")?.textContent?.startsWith("Ready"));
  const form = window.document.getElementById("custom-dictionary-form");
  const source = window.document.getElementById("custom-dictionary-source");
  const save = window.document.getElementById("custom-dictionary-save");
  const reload = window.document.getElementById("custom-dictionary-reload");
  if (!form || !source || !save || !reload) {
    dom.window.close();
    return {
      error: "the custom dictionary editor controls did not render",
      customReadCount: customReadRequests.length,
      storageGetKeys,
    };
  }

  const result = {
    startup: {
      customReadCount: customReadRequests.length,
      formHidden: form.hidden,
      openControlAbsent: window.document.getElementById("custom-dictionary-open") === null,
      sourceFetchedDirectly: storageGetKeys.some((keys) =>
        Array.isArray(keys) && keys.includes("customDictionarySource")),
      sourceHasMaximumLength: source.hasAttribute("maxlength"),
      sourceDescribedBy: source.getAttribute("aria-describedby"),
    },
  };

  await waitFor(() => pendingRead !== null);
  await navigateSettingsSection(window, "dictionaries");
  customDocument = {
    ...customDocument,
    revision: 6,
    semanticRevision: "b".repeat(64),
    text: "newer event, にゅー, wins\r\n",
  };
  publish({ customDictionarySource: { newValue: structuredClone(customDocument) } });
  pendingRead?.();
  await waitFor(() => form.hidden === false && source.value === "newer event, にゅー, wins\n");
  result.eventBeforeReadReply = {
    value: source.value,
    formHidden: form.hidden,
    readCount: customReadRequests.length,
    saveDisabled: save.disabled,
    unseenCompletion: window.document.getElementById("nav-status-dictionaries").textContent
      === "Personal dictionary: Loaded source revision 6.",
  };
  await navigateSettingsSection(window, "custom-dictionary");
  await navigateSettingsSection(window, "dictionaries");
  result.eventBeforeReadReply.completionClearedAfterVisit =
    window.document.getElementById("nav-status-dictionaries").textContent === "";

  const customRow = () => window.document.querySelector(`[data-dictionary-id="${CUSTOM_DICTIONARY_ID}"]`);
  const ordinaryRow = () => window.document.querySelector('[data-dictionary-id="ordinary-id"]');
  const fixed = customRow();
  const ordinary = ordinaryRow();
  result.fixedControls = {
    first: fixed?.previousElementSibling === null,
    selectedDisabled: fixed?.querySelector(".dict-selected")?.disabled,
    enabled: fixed?.querySelector(".dict-enabled")?.checked,
    enabledDisabled: fixed?.querySelector(".dict-enabled")?.disabled,
    draggable: fixed?.querySelector(".dict-drag")?.draggable,
    upDisabled: fixed?.querySelector(".dict-up")?.disabled,
    downDisabled: fixed?.querySelector(".dict-down")?.disabled,
    positionDisabled: fixed?.querySelector(".dict-position-input")?.disabled,
    moveDisabled: fixed?.querySelector(".dict-move")?.disabled,
    removeHidden: fixed?.querySelector(".dict-remove")?.hidden,
    aliasDisabled: fixed?.querySelector(".dict-display-name")?.disabled,
    ordinaryUpDisabled: ordinary?.querySelector(".dict-up")?.disabled,
    ordinaryPositionMin: ordinary?.querySelector(".dict-position-input")?.min,
    metadata: fixed?.querySelector(".dict-metadata")?.textContent,
    enabledLabel: fixed?.querySelector(".dict-enabled")?.getAttribute("aria-label"),
    upLabel: fixed?.querySelector(".dict-up")?.getAttribute("aria-label"),
  };
  // Typing 1 while the managed package is pinned first is the reporter's way of
  // saying "as high as possible": it must land on the first movable slot
  // instead of being discarded.
  const thirdPosition = window.document.querySelector('[data-dictionary-id="third-id"] .dict-position-input');
  thirdPosition.value = "1";
  thirdPosition.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  await waitFor(() => stateRequests.length === 1);
  result.positionOneClamp = {
    order: stateRequests[0]?.dictionaries?.map(({ id }) => id),
    inputValue: window.document.querySelector('[data-dictionary-id="third-id"] .dict-position-input')?.value,
    rank: window.document.querySelector('[data-dictionary-id="third-id"] .dict-rank')?.textContent,
  };
  await navigateSettingsSection(window, "dictionaries");
  window.document.getElementById("dict-select-visible")?.click();
  window.document.getElementById("dict-bulk-disable")?.click();
  await waitFor(() => stateRequests.length === 2
    && window.document.getElementById("dict-bulk-favorite")?.disabled === false);
  result.bulkState = stateRequests[1]?.dictionaries?.map(({ id, enabled }) => ({ id, enabled }));
  window.document.getElementById("dict-bulk-favorite")?.click();
  await waitFor(() => stateRequests.length === 3);
  result.favoriteState = stateRequests[2]?.dictionaries?.map(({ id, favorite }) => ({ id, favorite }));

  await navigateSettingsSection(window, "custom-dictionary");
  source.focus();
  source.value = "draft, どらふと, keep me\n";
  source.dispatchEvent(new window.Event("input", { bubbles: true }));
  const readsBeforeNavigation = customReadRequests.length;
  await navigateSettingsSection(window, "lookup");
  await navigateSettingsSection(window, "custom-dictionary");
  if (source !== window.document.getElementById("custom-dictionary-source")
      || source.value !== "draft, どらふと, keep me\n"
      || customReadRequests.length !== readsBeforeNavigation) {
    throw new Error("Settings navigation replaced or reloaded the source draft");
  }
  source.focus();
  customDocument = {
    ...customDocument,
    revision: 7,
    semanticRevision: "c".repeat(64),
    text: "external, そと, reload me\r\n",
  };
  publish({ customDictionarySource: { newValue: structuredClone(customDocument) } });
  const savesBeforeStaleSubmit = customSaveRequests.length;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((done) => window.setTimeout(done, 0));
  result.staleDraft = {
    value: source.value,
    focused: window.document.activeElement === source,
    saveDisabled: save.disabled,
    saveRefused: customSaveRequests.length === savesBeforeStaleSubmit,
    status: window.document.getElementById("custom-dictionary-status")?.textContent ?? "",
  };

  reload.click();
  await waitFor(() => customReadRequests.length === 2 && source.value === "external, そと, reload me\n");
  result.reloadedValue = source.value;

  const errors = window.document.getElementById("custom-dictionary-errors");
  const status = window.document.getElementById("custom-dictionary-status");
  for (const text of ["broken", "broken\n, reading, definition", "valid, reading, definition\nbroken\n, reading, definition"]) {
    source.value = text;
    source.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  result.liveValidation = {
    deferred: errors.childElementCount === 0,
    saveEnabled: !save.disabled,
  };
  await waitFor(() => errors.childElementCount === 2 && status.textContent.includes("ready to save"));
  result.liveValidation.latestErrors = JSON.stringify([...errors.children].map((item) => item.textContent))
    === JSON.stringify(["Line 2: expected two commas", "Line 3: term is empty"]);
  const firstError = errors.firstElementChild;
  source.value = source.value.replace("valid", "edited");
  source.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => status.textContent.includes("ready to save"));
  result.liveValidation.unchangedErrorsReused = errors.firstElementChild === firstError;

  source.value += " edited";
  source.dispatchEvent(new window.Event("input", { bubbles: true }));
  holdFirstRead = true;
  reload.click();
  await waitFor(() => pendingRead !== null);
  const loadingStatus = status.textContent;
  await new Promise((done) => window.setTimeout(done, 200));
  result.liveValidation.reloadStatusPreserved = status.textContent === loadingStatus
    && loadingStatus.startsWith("Loading");
  pendingRead?.();
  await waitFor(() => !source.disabled && source.value === "external, そと, reload me\n");

  const eventFirstText = "valid, ばりっど, line\\nsecond\nbroken\n, よみ, missing term\n";
  source.value = eventFirstText;
  source.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => pendingSave !== null && customSaveRequests.length === 1);
  const eventFirstSavedText = eventFirstText.replace(/\n/gu, "\r\n");
  const eventFirstParsed = parseCustomDictionary(eventFirstSavedText);
  customDocument = {
    schemaVersion: 1,
    revision: 8,
    semanticRevision: "d".repeat(64),
    text: eventFirstSavedText,
  };
  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: state.dictionaries.map((dictionary) =>
      dictionary.id === CUSTOM_DICTIONARY_ID
        ? { ...dictionary, revision: customDocument.semanticRevision, termCount: eventFirstParsed.entries.length }
        : dictionary),
  };
  publish({
    customDictionarySource: { newValue: structuredClone(customDocument) },
    dictionaryState: { newValue: structuredClone(state) },
  });
  const resolveEventFirst = pendingSave;
  pendingSave = null;
  resolveEventFirst?.({
    ok: true,
    document: structuredClone(customDocument),
    state: structuredClone(state),
    errors: structuredClone(eventFirstParsed.errors),
    rebuilt: true,
    removed: false,
    report: { termCount: eventFirstParsed.entries.length },
  });
  await waitFor(() => !source.disabled
    && window.document.getElementById("custom-dictionary-status")?.textContent?.includes("Saved"));
  const savedStatus = status.textContent;
  await new Promise((done) => window.setTimeout(done, 200));
  result.eventFirstSave = {
    statusPreserved: status.textContent === savedStatus && savedStatus.includes("Saved"),
    baseRevision: customSaveRequests[0]?.baseDocumentRevision,
    text: customSaveRequests[0]?.text,
    value: source.value,
    submittedUsesCrlf: customSaveRequests[0]?.text === eventFirstSavedText,
    saveDisabled: save.disabled,
    diagnostics: [...window.document.querySelectorAll("#custom-dictionary-errors li")]
      .map((item) => item.textContent),
  };

  const replyFirstText = `${eventFirstText}reply first, へんじ, later event\n`;
  source.value = replyFirstText;
  source.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => pendingSave !== null && customSaveRequests.length === 2);
  const replyFirstParsed = parseCustomDictionary(replyFirstText);
  const replyFirstSavedText = replyFirstText.replace(/\n/gu, "\r\n");
  customDocument = {
    schemaVersion: 1,
    revision: 9,
    semanticRevision: "e".repeat(64),
    text: replyFirstSavedText,
  };
  state = { ...state, revision: state.revision + 1 };
  const resolveReplyFirst = pendingSave;
  pendingSave = null;
  resolveReplyFirst?.({
    ok: true,
    document: structuredClone(customDocument),
    state: structuredClone(state),
    errors: structuredClone(replyFirstParsed.errors),
    rebuilt: true,
    removed: false,
    report: { termCount: replyFirstParsed.entries.length },
  });
  await waitFor(() => !source.disabled && source.value === replyFirstText && save.disabled);
  result.replyBeforeEvent = {
    value: source.value,
    saveDisabled: save.disabled,
  };
  publish({
    customDictionarySource: { newValue: structuredClone(customDocument) },
    dictionaryState: { newValue: structuredClone(state) },
  });
  await new Promise((done) => window.setTimeout(done, 0));
  result.equalEventIgnored = source.value === replyFirstText && save.disabled;

  const staleReplyDraft = "stale reply, ふるい, preserve this\n";
  source.value = staleReplyDraft;
  source.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => pendingSave !== null && customSaveRequests.length === 3);
  customDocument = {
    schemaVersion: 1,
    revision: 10,
    semanticRevision: "f".repeat(64),
    text: "newest source, さいしん, authoritative\r\n",
  };
  const resolveStale = pendingSave;
  pendingSave = null;
  resolveStale?.({
    ok: false,
    stale: true,
    error: "the custom dictionary source changed while it was being saved",
    document: structuredClone(customDocument),
    state: structuredClone(state),
  });
  await waitFor(() => !source.disabled
    && window.document.getElementById("custom-dictionary-status")?.textContent?.includes("changed"));
  result.staleReply = {
    value: source.value,
    saveDisabled: save.disabled,
    status: window.document.getElementById("custom-dictionary-status")?.textContent ?? "",
  };
  reload.click();
  await waitFor(() => customReadRequests.length === 4
    && source.value === "newest source, さいしん, authoritative\n");
  result.finalReload = source.value;

  dom.window.close();
  return result;
}

describe("personal dictionary", () => {
  test("custom dictionary storage ownership", async () => {
    section("custom dictionary storage ownership");
    const customBackground = await customBackgroundStage();
    const emptySemanticRevision = await customDictionarySemanticRevision([]);
    equal("an absent custom source reads as revision zero", customBackground.empty, {
      type: "hd_custom_read_result",
      requestId: "custom-background-hd_custom_read",
      ok: true,
      error: null,
      document: {
        schemaVersion: 1,
        revision: 0,
        semanticRevision: emptySemanticRevision,
        text: "",
      },
      state: customBackground.initialState.state,
    });
    check(
      "ordinary state reads leave the lazy custom source off the hot path",
      Array.isArray(customBackground.ordinaryReadKeys)
        && !customBackground.ordinaryReadKeys.includes(CUSTOM_DICTIONARY_SOURCE_KEY)
        && Array.isArray(customBackground.customReadKeys)
        && customBackground.customReadKeys.includes(CUSTOM_DICTIONARY_SOURCE_KEY),
      JSON.stringify({
        ordinary: customBackground.ordinaryReadKeys,
        custom: customBackground.customReadKeys,
      }),
    );
    check(
      "custom source and dictionary state commit in one storage write",
      customBackground.committed.ok === true
        && customBackground.committed.document?.revision === 1
        && customBackground.committed.state?.revision === 2
        && customBackground.committed.state?.dictionaries?.[0]?.id === CUSTOM_DICTIONARY_ID
        && customBackground.committed.state?.dictionaries?.[0]?.title === CUSTOM_DICTIONARY_TITLE
        && customBackground.committed.state?.dictionaries?.[0]?.enabled === true
        && JSON.stringify(customBackground.atomicKeys)
          === JSON.stringify(["customDictionarySource", "dictionaryState"]),
      JSON.stringify(customBackground),
    );
    check(
      "custom CAS binds changed source semantics to the fixed package state",
      customBackground.omittedChangedState.ok === false
        && customBackground.staleChangedPackage.ok === false
        && JSON.stringify(customBackground.afterRejectedDivergence.document)
          === JSON.stringify(customBackground.committed.document)
        && JSON.stringify(customBackground.afterRejectedDivergence.state)
          === JSON.stringify(customBackground.committed.state),
      JSON.stringify(customBackground),
    );
    check(
      "ordinary state CAS cannot remove or disable the fixed custom package",
      customBackground.removeThroughOrdinaryCas.ok === false
        && customBackground.disableThroughOrdinaryCas.ok === false
        && customBackground.removeThroughOrdinaryCas.state?.revision === 2
        && customBackground.disableThroughOrdinaryCas.state?.revision === 2,
      JSON.stringify(customBackground),
    );
    check(
      "a stale custom document write is refused without merging",
      customBackground.stale.ok === false
        && customBackground.stale.stale === true
        && customBackground.stale.document?.revision === 1
        && customBackground.stale.state?.revision === 2,
      JSON.stringify(customBackground.stale),
    );
    check(
      "the dedicated custom CAS can atomically save a zero-row source and remove its package",
      customBackground.removed.ok === true
        && customBackground.removed.document?.revision === 2
        && customBackground.removed.document?.text === "# cleared\nmalformed"
        && customBackground.removed.document?.semanticRevision === emptySemanticRevision
        && customBackground.removed.state?.revision === 3
        && customBackground.removed.state?.dictionaries?.length === 0
        && JSON.stringify(customBackground.stored.customDictionarySource)
          === JSON.stringify(customBackground.removed.document)
        && JSON.stringify(customBackground.stored.dictionaryState)
          === JSON.stringify(customBackground.removed.state),
      JSON.stringify(customBackground),
    );
  });

  test("managed custom dictionary engine transaction", async () => {
    section("managed custom dictionary engine transaction");
    await customEngineStage();
  });

  test("Settings personal dictionary", async () => {
    const settingsCustom = await settingsCustomDictionaryStage();
    check(
      "settings coalesces source validation while saving the exact current draft",
      settingsCustom?.liveValidation?.deferred === true
        && settingsCustom.liveValidation.saveEnabled === true
        && settingsCustom.liveValidation.latestErrors === true
        && settingsCustom.liveValidation.unchangedErrorsReused === true
        && settingsCustom.liveValidation.reloadStatusPreserved === true
        && settingsCustom.eventFirstSave?.statusPreserved === true,
      JSON.stringify(settingsCustom),
    );
    check(
      "settings lazily loads the newest custom source across event and reply ordering",
      settingsCustom?.startup?.customReadCount === 1
        && settingsCustom.startup.formHidden === false
        && settingsCustom.startup.openControlAbsent === true
        && settingsCustom.startup.sourceFetchedDirectly === false
        && settingsCustom.startup.sourceHasMaximumLength === false
        && settingsCustom.startup.sourceDescribedBy
          === "custom-dictionary-status custom-dictionary-errors"
        && settingsCustom.eventBeforeReadReply?.value === "newer event, にゅー, wins\n"
        && settingsCustom.eventBeforeReadReply.formHidden === false
        && settingsCustom.eventBeforeReadReply.readCount === 1
        && settingsCustom.eventBeforeReadReply.saveDisabled === true
        && settingsCustom.eventBeforeReadReply.unseenCompletion === true
        && settingsCustom.eventBeforeReadReply.completionClearedAfterVisit === true
        && settingsCustom.eventFirstSave?.baseRevision === 7
        && settingsCustom.eventFirstSave.submittedUsesCrlf === true
        && settingsCustom.eventFirstSave.saveDisabled === true
        && settingsCustom.replyBeforeEvent?.saveDisabled === true
        && settingsCustom.equalEventIgnored === true,
      JSON.stringify(settingsCustom),
    );
    check(
      "settings refuses stale custom drafts and reports every malformed line",
      settingsCustom?.staleDraft?.value === "draft, どらふと, keep me\n"
        && settingsCustom.staleDraft.focused === true
        && settingsCustom.staleDraft.saveDisabled === true
        && settingsCustom.staleDraft.saveRefused === true
        && settingsCustom.staleDraft.status.includes("changed")
        && settingsCustom.reloadedValue === "external, そと, reload me\n"
        && JSON.stringify(settingsCustom.eventFirstSave?.diagnostics)
          === JSON.stringify(["Line 2: expected two commas", "Line 3: term is empty"])
        && settingsCustom.staleReply?.value === "stale reply, ふるい, preserve this\n"
        && settingsCustom.staleReply.saveDisabled === true
        && settingsCustom.staleReply.status.includes("changed")
        && settingsCustom.finalReload === "newest source, さいしん, authoritative\n",
      JSON.stringify(settingsCustom),
    );
    check(
      "settings pins the managed custom package while leaving presentation editable",
      settingsCustom?.fixedControls?.first === true
        && settingsCustom.fixedControls.selectedDisabled === false
        && settingsCustom.fixedControls.enabled === true
        && settingsCustom.fixedControls.enabledDisabled === true
        && settingsCustom.fixedControls.draggable === false
        && settingsCustom.fixedControls.upDisabled === true
        && settingsCustom.fixedControls.downDisabled === true
        && settingsCustom.fixedControls.positionDisabled === true
        && settingsCustom.fixedControls.moveDisabled === true
        && settingsCustom.fixedControls.removeHidden === true
        && settingsCustom.fixedControls.aliasDisabled === false
        && settingsCustom.fixedControls.ordinaryUpDisabled === true
        && settingsCustom.fixedControls.ordinaryPositionMin === "2"
        && settingsCustom.fixedControls.metadata?.startsWith("Managed · always enabled and first · ")
        && settingsCustom.fixedControls.enabledLabel
          === `Enabled for ${CUSTOM_DICTIONARY_TITLE} (managed; always enabled)`
        && settingsCustom.fixedControls.upLabel
          === `Move ${CUSTOM_DICTIONARY_TITLE} up (managed; fixed first)`
        && JSON.stringify(settingsCustom.positionOneClamp) === JSON.stringify({
          order: [CUSTOM_DICTIONARY_ID, "third-id", "ordinary-id"],
          inputValue: "2",
          rank: "2",
        })
        && JSON.stringify(settingsCustom.bulkState) === JSON.stringify([
          { id: CUSTOM_DICTIONARY_ID, enabled: true },
          { id: "third-id", enabled: false },
          { id: "ordinary-id", enabled: false },
        ])
        && JSON.stringify(settingsCustom.favoriteState) === JSON.stringify([
          { id: CUSTOM_DICTIONARY_ID, favorite: true },
          { id: "third-id", favorite: true },
          { id: "ordinary-id", favorite: true },
        ]),
      JSON.stringify(settingsCustom),
    );
  });
});
