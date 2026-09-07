import "./reader-options.js";
import { createAnkiGateway } from "./anki.js";
import { createAnkiWorkerService } from "./anki-worker.js";
import { createBackupDownloads } from "./backup-downloads.js";
import { assertBackupSnapshot, backupRevisions } from "./backup-state.js";
import "./external-links.js";
import "./dictionary-group-state.js";
import {
  httpsUrl,
  MANAGED_DICTIONARY_CHANGED,
  MANAGED_UPDATE_SCHEDULE_MINUTES,
  managedDictionaryFingerprint,
  managedDictionaryMatches,
  managedUpdateSchedule,
  normaliseUpdateSettings,
  recommendedDictionarySource,
  recommendedIndexUrlMatches,
} from "./managed-dictionary-source.js";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION,
  CUSTOM_DICTIONARY_TITLE,
  assertCustomDictionaryCommit,
  assertCustomSourceState,
  customDictionarySemanticRevision,
  normaliseCustomDictionaryDocument,
  parseCustomDictionary,
} from "./custom-dictionary.js";
import { sameJsonValue } from "./json-value.js";
import {
  boundResponseFailure, responseFits, responseLimitError, validResponseRequestId,
} from "./response-limits.js";

const { projectStoredOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
const { normaliseExternalUrl } = globalThis.HDExternalLinks;
const { pruneGroupMemberships } = globalThis.HDDictionaryGroups;

/*
 * Service worker for Hachidori.
 *
 * The worker holds no engine state: it only guarantees that the offscreen
 * document exists and relays requests to it. The engine lives in the offscreen
 * document because a service worker is torn down after 30 s idle, which would
 * throw away the loaded dictionaries.
 *
 * It owns the revisioned `dictionaryState` value and dictionary-backed option
 * writes in chrome.storage.local. An offscreen document is granted chrome.runtime
 * and nothing else -- no chrome.storage -- so every read and write the engine
 * needs arrives here as a message.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const OFFSCREEN_DOCUMENT = "offscreen.html";
const TARGET = "hoshidicts-offscreen";
const UPDATE_TARGET = "hachidori-updates";
const AUDIO_TARGET = "hachidori-audio";

// Requests the worker answers itself. A second target is what keeps them out of
// the relay below: a message from the offscreen document carrying TARGET is
// indistinguishable from one sent by an extension page, so it would be stamped
// `relayed` and handed straight back to the offscreen document, where the
// engine's own request queue would then wait on itself.
const WORKER_TARGET = "hoshidicts-worker";
let ankiGateway, ankiMining;
let backupDownloads;

function getBackupDownloads() {
  backupDownloads ??= createBackupDownloads(chrome, relay);
  return backupDownloads;
}

const DICTIONARY_STATE_KEY = "dictionaryState";
const LEGACY_DICTIONARIES_KEY = "dictionaries";
const OPTIONS_KEY = "options";
const UPDATE_SETTINGS_KEY = "dictionaryUpdates";
const UPDATE_ALARM = "hachidori-managed-dictionary-updates";
const DICTIONARY_STATE_SCHEMA_VERSION = 1;
const KANJI_SELECTION_KINDS = new Set(["term", "kanji"]);
// A relayed request can arrive in the window between createDocument() resolving
// and offscreen.js running its module body, where nothing is listening yet.
const RELAY_ATTEMPTS = 5;
const RELAY_BACKOFF_MS = 40;
const NOT_LISTENING = /Receiving end does not exist|Could not establish connection/i;

let creating = null;
let latestAudioOperation = null;

function describe(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)],
  });
  return contexts.length > 0;
}

async function createOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ["DOM_SCRAPING", "AUDIO_PLAYBACK"],
      justification:
        "Runs the WebAssembly dictionary engine, parses Yomitan archives, and plays configured pronunciation audio outside page content policies.",
    });
  } catch (error) {
    // Another extension context may have won the race; only a genuine absence
    // is a failure.
    if (!(await offscreenExists())) {
      throw error;
    }
  } finally {
    creating = null;
  }
}

// createDocument() rejects when called while another call is in flight, so every
// caller waits on the same promise.
async function ensureOffscreen() {
  if (await offscreenExists()) {
    return;
  }
  if (creating === null) {
    creating = createOffscreen();
  }
  await creating;
}

async function relay(message, stillCurrent = null) {
  let failure = null;
  for (let attempt = 0; attempt < RELAY_ATTEMPTS; attempt += 1) {
    await ensureOffscreen();
    if (stillCurrent && !stillCurrent()) {
      return { type: `${message.type}_result`, requestId: message.requestId, ok: true, status: "cancelled" };
    }
    try {
      // `relayed` is what lets offscreen.js ignore the copy of this message that
      // chrome.runtime.sendMessage also delivers to it directly, so a request
      // from an extension page runs on the engine exactly once.
      const reply = await chrome.runtime.sendMessage({ ...message, relayed: true });
      if (reply !== undefined) {
        return reply;
      }
      failure = new Error("offscreen document sent no reply");
    } catch (error) {
      if (!NOT_LISTENING.test(describe(error))) {
        throw error;
      }
      failure = error;
    }
    await sleep(RELAY_BACKOFF_MS * (attempt + 1));
  }
  throw failure ?? new Error("offscreen document unreachable");
}

async function readDictionaryStorage(includeCustomDocument = false) {
  const keys = [
    DICTIONARY_STATE_KEY,
    LEGACY_DICTIONARIES_KEY,
    OPTIONS_KEY,
  ];
  if (includeCustomDocument) keys.push(CUSTOM_DICTIONARY_SOURCE_KEY);
  const stored = await chrome.storage.local.get(keys);
  const state = stored?.[DICTIONARY_STATE_KEY] ?? null;
  return {
    state,
    legacyDictionaries:
      state === null && Array.isArray(stored?.[LEGACY_DICTIONARIES_KEY])
        ? stored[LEGACY_DICTIONARIES_KEY]
        : null,
    options: stored?.[OPTIONS_KEY],
    customDocument: includeCustomDocument
      ? stored?.[CUSTOM_DICTIONARY_SOURCE_KEY] ?? null
      : undefined,
  };
}

async function readUpdateSettings() {
  const stored = await chrome.storage.local.get(UPDATE_SETTINGS_KEY);
  return normaliseUpdateSettings(stored?.[UPDATE_SETTINGS_KEY]);
}

function hasCapability(dictionary, kind) {
  if (kind === "freq") return dictionary.frequencyCount > 0;
  if (kind === "kanji") return dictionary.kanjiCount > 0;
  if (dictionary.termCount > 0) return true;
  return dictionary.frequencyCount === 0 && dictionary.pitchCount === 0 && dictionary.kanjiCount === 0;
}

function normaliseDictionarySelections(value, dictionaries) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const options = { ...value };
  const selectedFrequency = dictionaries.find((entry) =>
    entry.title === options.frequencyDictionary);
  if (
    options.frequencyDictionary
    && (!selectedFrequency || selectedFrequency.enabled === false || !hasCapability(selectedFrequency, "freq"))
  ) {
    options.frequencyDictionary = "";
  }

  const selection = typeof options.kanjiClickDictionary === "string"
    ? { title: options.kanjiClickDictionary, kind: "" }
    : options.kanjiClickDictionary;
  if (selection?.title) {
    const selected = dictionaries.find((entry) => entry.title === selection.title);
    let kind = selection.kind;
    if (!KANJI_SELECTION_KINDS.has(kind)) {
      kind = selected && hasCapability(selected, "kanji") ? "kanji" : "term";
    }
    if (!selected || selected.enabled === false || !hasCapability(selected, kind)) {
      options.kanjiClickDictionary = "";
    } else if (!KANJI_SELECTION_KINDS.has(selection.kind)) {
      options.kanjiClickDictionary = { title: selection.title, kind };
    }
  }
  return options;
}

function assertDictionaryState(state) {
  if (state !== null && state?.schemaVersion !== DICTIONARY_STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported dictionary state schema ${String(state?.schemaVersion)}`);
  }
}

function customPackageEngineState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const engineState = { ...value };
  delete engineState.displayName;
  delete engineState.favorite;
  return engineState;
}

function assertOrdinaryCustomTransition(currentDictionaries, nextDictionaries) {
  const currentIndex = currentDictionaries.findIndex(
    (dictionary) => dictionary?.id === CUSTOM_DICTIONARY_ID,
  );
  const nextIndexes = nextDictionaries.flatMap((dictionary, index) =>
    dictionary?.id === CUSTOM_DICTIONARY_ID ? [index] : []);
  if (currentIndex < 0 && nextIndexes.length === 0) return;
  if (currentIndex < 0 || nextIndexes.length !== 1) {
    throw new Error("the managed custom dictionary can only be changed by its source editor");
  }
  const current = currentDictionaries[currentIndex];
  const next = nextDictionaries[nextIndexes[0]];
  if (currentIndex !== 0
      || current?.title !== CUSTOM_DICTIONARY_TITLE
      || current?.enabled !== true
      || nextIndexes[0] !== 0
      || next?.title !== CUSTOM_DICTIONARY_TITLE
      || next?.enabled !== true
      || !sameJsonValue(customPackageEngineState(current), customPackageEngineState(next))) {
    throw new Error("the managed custom dictionary must stay enabled and first");
  }
}

function assertCustomDictionaryCasRequest(message) {
  if (!Number.isInteger(message?.baseDocumentRevision)
      || message.baseDocumentRevision < 0) {
    throw new Error("the custom dictionary write carried no valid document revision");
  }
  if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
    throw new Error("the custom dictionary write carried no valid dictionary revision");
  }
  if (typeof message?.text !== "string"
      || typeof message?.semanticRevision !== "string") {
    throw new TypeError("the custom dictionary write carried no source document");
  }
  const changesDictionaryState = message.dictionaries !== undefined;
  if (changesDictionaryState && !Array.isArray(message.dictionaries)) {
    throw new TypeError("the custom dictionary write carried an invalid dictionary list");
  }
  if (message.groups !== undefined && !Array.isArray(message.groups)) {
    throw new TypeError("the custom dictionary write carried invalid groups");
  }
  return changesDictionaryState;
}

function committedSelectionTitle(title, current, dictionaries) {
  const selected = current?.dictionaries.find((entry) => entry.title === title);
  return selected ? dictionaries.find((entry) => entry.id === selected.id)?.title ?? "" : title;
}

function dictionaryCommit(current, currentOptions, dictionaries, groups) {
  const currentRevision = current?.revision ?? 0;
  const state = {
    schemaVersion: DICTIONARY_STATE_SCHEMA_VERSION,
    revision: currentRevision + 1,
    dictionaries,
    groups: pruneGroupMemberships(groups ?? current?.groups, dictionaries),
  };
  const values = { [DICTIONARY_STATE_KEY]: state };
  if (currentOptions !== undefined) {
    const revision = optionsRevision(currentOptions);
    const nextOptions = normaliseDictionarySelections(
      { ...projectStoredOptions(currentOptions), revision }, state.dictionaries,
    );
    if (nextOptions.popupImageSource?.kind === "dictionary") {
      const title = committedSelectionTitle(nextOptions.popupImageSource.title, current, dictionaries);
      nextOptions.popupImageSource = title ? { kind: "dictionary", title } : null;
    }
    if (nextOptions.pitchAccentFuriganaDictionary) {
      nextOptions.pitchAccentFuriganaDictionary = committedSelectionTitle(
        nextOptions.pitchAccentFuriganaDictionary, current, dictionaries,
      );
    }
    if (!sameJsonValue(nextOptions, { ...currentOptions, revision })) {
      values[OPTIONS_KEY] = { ...nextOptions, revision: revision + 1 };
    }
  }
  return { state, values };
}

function optionsRevision(options) {
  return Number.isInteger(options?.revision) && options.revision >= 0 ? options.revision : 0;
}

async function removeLegacyDictionaryRows(current, legacyDictionaries) {
  if (current !== null || legacyDictionaries === null) return;
  try {
    await chrome.storage.local.remove(LEGACY_DICTIONARIES_KEY);
  } catch (error) {
    console.warn("hoshidicts: could not remove legacy dictionary rows:", describe(error));
  }
}

// The engine or settings page reads state, changes it, and sends it back a
// message round trip later. A caller includes the revision it read so a stale
// write cannot discard a change made by another extension context.
const WORKER_HANDLERS = {
  async hd_backup_download(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("settings.html")) {
      throw new Error("Backup downloads are available only from Hachidori Settings.");
    }
    return getBackupDownloads().download();
  },
  async hd_backup_base_read() {
    const stored = await chrome.storage.local.get([
      DICTIONARY_STATE_KEY, OPTIONS_KEY, CUSTOM_DICTIONARY_SOURCE_KEY, UPDATE_SETTINGS_KEY,
    ]);
    return { snapshot: {
      state: stored[DICTIONARY_STATE_KEY] ?? null,
      options: stored[OPTIONS_KEY] ?? null,
      document: stored[CUSTOM_DICTIONARY_SOURCE_KEY] ?? null,
      updates: stored[UPDATE_SETTINGS_KEY] ?? null,
    } };
  },

  async hd_backup_read() {
    const { snapshot } = await WORKER_HANDLERS.hd_backup_base_read();
    return { snapshot: {
      state: snapshot.state,
      options: { ...projectStoredOptions(snapshot.options), revision: optionsRevision(snapshot.options) },
      document: normaliseCustomDictionaryDocument(snapshot.document),
      updates: normaliseUpdateSettings(snapshot.updates),
    } };
  },

  async hd_backup_cas(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT)) {
      throw new Error("A backup restore must be prepared by the dictionary engine.");
    }
    const { snapshot: current } = await WORKER_HANDLERS.hd_backup_base_read();
    if (!sameJsonValue(message.base, current)) {
      return { ok: false, conflict: true, error: "Hachidori changed since this backup was prepared. Prepare it again before restoring." };
    }
    const snapshot = message.snapshot;
    await assertBackupSnapshot(snapshot);
    const expected = Object.fromEntries(Object.entries(backupRevisions(current)).map(([key, revision]) => [key, revision + 1]));
    if (!sameJsonValue(backupRevisions(snapshot), expected)) throw new Error("Invalid backup restore revisions.");
    if (!sameJsonValue(snapshot.options, normaliseDictionarySelections(snapshot.options, snapshot.state.dictionaries))) {
      throw new Error("The backup reader settings refer to unavailable dictionaries.");
    }
    await chrome.storage.local.set({
      [DICTIONARY_STATE_KEY]: snapshot.state,
      [OPTIONS_KEY]: snapshot.options,
      [CUSTOM_DICTIONARY_SOURCE_KEY]: snapshot.document,
      [UPDATE_SETTINGS_KEY]: snapshot.updates,
    });
    return { snapshot };
  },

  async hd_anki_discover(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("settings.html")) {
      throw new Error("Anki discovery is available only from Hachidori Settings");
    }
    if (typeof message.model !== "string" || typeof message.apiKey !== "string") {
      throw new TypeError("Anki discovery requires a note type and API key string");
    }
    ankiGateway ??= createAnkiGateway();
    return ankiGateway.discover({ model: message.model, apiKey: message.apiKey });
  },
  async hd_open_external(message, sender) {
    if (sender.id !== chrome.runtime.id) throw new Error("external link request came from another extension");
    const url = normaliseExternalUrl(message.url);
    if (!url) throw new TypeError("external link URL is invalid");
    const active = message.active === undefined ? true : message.active;
    if (typeof active !== "boolean") throw new TypeError("external link activation is invalid");
    await chrome.tabs.create({ url, active, ...(sender.tab ? { windowId: sender.tab.windowId } : {}) });
    return { opened: true };
  },

  async hd_state_read() {
    const { state, legacyDictionaries } = await readDictionaryStorage();
    return { state, legacyDictionaries };
  },

  async hd_state_cas(message) {
    if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
      throw new Error("the dictionary state write request carried no valid base revision");
    }
    if (!Array.isArray(message?.dictionaries)) {
      throw new TypeError("the dictionary state write request carried no list");
    }
    if (message.groups !== undefined && !Array.isArray(message.groups)) {
      throw new TypeError("the dictionary state write request carried invalid groups");
    }

    const { state: current, legacyDictionaries, options: currentOptions } = await readDictionaryStorage();
    assertDictionaryState(current);
    const currentRevision = current?.revision ?? 0;
    if (message.baseRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        error: "the dictionary state changed while it was being written",
        state: current,
      };
    }

    try {
      assertOrdinaryCustomTransition(current?.dictionaries ?? [], message.dictionaries);
    } catch (error) {
      return {
        ok: false,
        protected: true,
        error: describe(error),
        state: current,
      };
    }
    const { state, values } = dictionaryCommit(
      current,
      currentOptions,
      message.dictionaries,
      message.groups,
    );
    await chrome.storage.local.set(values);
    await removeLegacyDictionaryRows(current, legacyDictionaries);
    return { state };
  },

  async hd_custom_read() {
    const { state, customDocument } = await readDictionaryStorage(true);
    assertDictionaryState(state);
    return {
      document: normaliseCustomDictionaryDocument(customDocument),
      state,
    };
  },

  async hd_custom_cas(message) {
    const changesDictionaryState = assertCustomDictionaryCasRequest(message);

    const {
      state: current,
      legacyDictionaries,
      options: currentOptions,
      customDocument: storedDocument,
    } = await readDictionaryStorage(true);
    assertDictionaryState(current);
    const document = normaliseCustomDictionaryDocument(storedDocument);
    if (message.baseDocumentRevision !== document.revision) {
      return {
        ok: false,
        stale: true,
        error: "the custom dictionary source changed while it was being saved",
        document,
        state: current,
      };
    }
    const currentRevision = current?.revision ?? 0;
    if (message.baseRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        error: "the dictionary state changed while the custom dictionary was being saved",
        document,
        state: current,
      };
    }
    const parsed = parseCustomDictionary(message.text);
    const calculatedRevision = await customDictionarySemanticRevision(parsed.entries);
    if (calculatedRevision !== message.semanticRevision) {
      throw new Error("the custom dictionary semantic revision does not match its source");
    }
    assertCustomSourceState(
      changesDictionaryState ? message.dictionaries : current?.dictionaries ?? [],
      calculatedRevision,
      parsed.entries.length,
    );

    const documentChanged = document.text !== message.text
      || document.semanticRevision !== message.semanticRevision;
    const nextDocument = documentChanged
      ? {
          schemaVersion: CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION,
          revision: document.revision + 1,
          semanticRevision: message.semanticRevision,
          text: message.text,
        }
      : document;
    let state = current;
    const values = {};
    if (documentChanged) {
      values[CUSTOM_DICTIONARY_SOURCE_KEY] = nextDocument;
    }
    if (changesDictionaryState) {
      assertCustomDictionaryCommit(message.dictionaries);
      const nextGroups = pruneGroupMemberships(
        message.groups ?? current?.groups,
        message.dictionaries,
      );
      const dictionaryChanged = current === null
        || !sameJsonValue(current.dictionaries, message.dictionaries)
        || !sameJsonValue(current.groups, nextGroups);
      if (dictionaryChanged) {
        const commit = dictionaryCommit(
          current,
          currentOptions,
          message.dictionaries,
          nextGroups,
        );
        state = commit.state;
        Object.assign(values, commit.values);
      }
    }
    if (Object.keys(values).length > 0) {
      await chrome.storage.local.set(values);
      if (state !== current) {
        await removeLegacyDictionaryRows(current, legacyDictionaries);
      }
    }
    return { document: nextDocument, state };
  },

  async hd_options_write(message) {
    const patch = validateOptionsPatch(message.options);
    if (!Number.isInteger(message.baseRevision) || message.baseRevision < 0) {
      throw new Error("the options write request carried no valid base revision");
    }
    const { state, options: currentOptions } = await readDictionaryStorage();
    assertDictionaryState(state);
    const revision = optionsRevision(currentOptions);
    const current = { ...projectStoredOptions(currentOptions), revision };
    if (message.baseRevision !== revision) {
      return checkedOptionsResult(message, {
        ok: false,
        conflict: true,
        error: "Settings changed in another page. Review your changes before saving again.",
        options: current,
      });
    }
    // Patch only edited fields; revision is owned here, never by the caller.
    const patched = { ...current, ...patch, revision };
    const options = state === null
      ? patched
      : normaliseDictionarySelections(patched, state.dictionaries);
    const changed = !sameJsonValue(options, { ...currentOptions, revision });
    if (changed) options.revision += 1;
    // Check the exact prospective reply, including its final revision, before
    // committing. An oversized success must never become a post-commit error.
    const result = checkedOptionsResult(message, { options });
    if (changed) {
      await chrome.storage.local.set({ [OPTIONS_KEY]: options });
    }
    return result;
  },
};

// One read-then-write at a time, so the check above cannot be overtaken by
// another worker-mediated write between its get and its set.
let storageTail = Promise.resolve();

function serialiseStorage(job) {
  const run = storageTail.then(job, job);
  storageTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeUpdateSettings(update) {
  return serialiseStorage(async () => {
    const current = await readUpdateSettings();
    const next = update(current);
    if (next === null) return { ok: false, error: "The update settings changed elsewhere. Review the current schedule before retrying.", settings: current };
    if (sameJsonValue(next, current)) return { settings: current };
    const settings = { ...next, revision: current.revision + 1 };
    await chrome.storage.local.set({ [UPDATE_SETTINGS_KEY]: settings });
    return { settings };
  });
}

async function updateDictionaryCheck(fingerprint, lastUpdateCheck) {
  return serialiseStorage(async () => {
    const { state } = await readDictionaryStorage();
    const index = state?.dictionaries?.findIndex(
      (dictionary) => dictionary?.id === fingerprint.id,
    ) ?? -1;
    if (index < 0 || !managedDictionaryMatches(state.dictionaries[index], fingerprint)) {
      return null;
    }
    const dictionaries = [...state.dictionaries];
    dictionaries[index] = { ...dictionaries[index], lastUpdateCheck };
    const reply = await WORKER_HANDLERS.hd_state_cas({
      baseRevision: state.revision,
      dictionaries,
    });
    if (reply.ok === false) {
      throw new Error(reply.error || "the dictionary update state could not be saved");
    }
    return reply.state.dictionaries.find((dictionary) => dictionary?.id === fingerprint.id) ?? null;
  });
}

async function managedCandidates(dictionaryIds) {
  const selected = dictionaryIds === null ? null : new Set(dictionaryIds);
  const { state } = await serialiseStorage(readDictionaryStorage);
  return (state?.dictionaries ?? []).flatMap((dictionary) => {
    if (selected !== null && !selected.has(dictionary?.id)) {
      return [];
    }
    const fingerprint = managedDictionaryFingerprint(dictionary);
    return fingerprint === null ? [] : [{
      id: dictionary.id,
      title: dictionary.displayName || dictionary.title,
      fingerprint,
    }];
  });
}

async function remoteUpdate(candidate) {
  const { source } = candidate.fingerprint;
  const response = await fetch(source.indexUrl, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`update index request failed with HTTP ${response.status}`);
  }
  if (source.kind === "recommended"
      && !recommendedIndexUrlMatches(recommendedDictionarySource(source.sourceId), response.url)) {
    throw new Error("update index downloaded from an unexpected final URL");
  }
  if (source.kind === "generic" && httpsUrl(response.url) === null) {
    throw new Error("update index redirected to a non-HTTPS URL");
  }
  const index = await response.json();
  if (typeof index?.revision !== "string" || index.revision === "") {
    throw new Error("update index did not declare a revision");
  }
  let archiveUrl = source.downloadUrl;
  if (source.kind === "generic"
      && typeof index.downloadUrl === "string"
      && index.downloadUrl !== "") {
    archiveUrl = httpsUrl(index.downloadUrl);
    if (archiveUrl === null) {
      throw new Error("update index returned a non-HTTPS download URL");
    }
  }
  return { revision: index.revision, archiveUrl };
}

let updateRequestCounter = 0;

async function installManagedCandidate(candidate, update, checkedAt) {
  updateRequestCounter += 1;
  const { fingerprint } = candidate;
  const reply = await relay({
    target: TARGET,
    type: "hd_import",
    requestId: `managed-update-${updateRequestCounter}`,
    managedFingerprint: fingerprint,
    sourceId: fingerprint.source.kind === "recommended" ? fingerprint.source.sourceId : null,
    archiveUrl: update.archiveUrl,
    expectedRevision: update.revision,
    checkedAt,
    fileName: candidate.title,
  });
  if (!reply?.ok || !reply.report?.success) {
    throw new Error(reply?.error || reply?.report?.error || "the dictionary update failed");
  }
}

function changedManagedOutcome(candidate) {
  return {
    id: candidate.id,
    status: "check-failed",
    error: MANAGED_DICTIONARY_CHANGED,
  };
}

async function recordManagedOutcome(candidate, lastUpdateCheck, outcome) {
  const recorded = await updateDictionaryCheck(candidate.fingerprint, lastUpdateCheck);
  return recorded === null ? changedManagedOutcome(candidate) : outcome;
}

async function checkManagedCandidate(candidate, checkedAt) {
  let update;
  try {
    update = await remoteUpdate(candidate);
  } catch (error) {
    const message = describe(error);
    return {
      update: null,
      available: null,
      outcome: await recordManagedOutcome(
        candidate,
        {
          checkedAt,
          status: "check-failed",
          remoteRevision: null,
          error: message,
        },
        { id: candidate.id, status: "check-failed", error: message },
      ),
    };
  }

  if (update.revision === candidate.fingerprint.revision) {
    const outcome = await recordManagedOutcome(
      candidate,
      {
        checkedAt,
        status: "up-to-date",
        remoteRevision: update.revision,
        error: null,
      },
      { id: candidate.id, status: "up-to-date" },
    );
    return { update: null, available: null, outcome };
  }

  const available = {
    checkedAt,
    status: "update-available",
    remoteRevision: update.revision,
    error: null,
  };
  const outcome = await recordManagedOutcome(
    candidate,
    available,
    { id: candidate.id, status: "update-available" },
  );
  return {
    update: outcome.status === "update-available" ? update : null,
    available,
    outcome,
  };
}

async function installCheckedCandidate(candidate, checked, checkedAt) {
  if (checked.update === null) {
    return checked.outcome;
  }
  try {
    await installManagedCandidate(candidate, checked.update, checkedAt);
    return { id: candidate.id, status: "updated" };
  } catch (error) {
    let message = describe(error);
    const failed = await updateDictionaryCheck(
      candidate.fingerprint,
      { ...checked.available, error: message },
    );
    if (failed === null) message = MANAGED_DICTIONARY_CHANGED;
    return {
      id: candidate.id,
      status: failed === null ? "check-failed" : "update-available",
      error: message,
    };
  }
}

async function runManagedUpdateCycle({ dictionaryIds = null, install = false } = {}) {
  const candidates = await managedCandidates(dictionaryIds);
  const checkedAt = new Date().toISOString();
  const outcomes = [];

  for (const candidate of candidates) {
    const checked = await checkManagedCandidate(candidate, checkedAt);
    outcomes.push(install
      ? await installCheckedCandidate(candidate, checked, checkedAt)
      : checked.outcome);
  }

  const { settings } = await writeUpdateSettings((current) => ({
    ...current,
    lastCheckedAt: checkedAt,
  }));
  return { outcomes, settings };
}

let updateTail = Promise.resolve();

function queueManagedUpdate(options) {
  const run = updateTail.then(
    () => runManagedUpdateCycle(options),
    () => runManagedUpdateCycle(options),
  );
  updateTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let alarmTail = Promise.resolve();

function reconcileUpdateAlarm() {
  const run = alarmTail.then(async () => {
    const settings = await readUpdateSettings();
    const periodInMinutes = MANAGED_UPDATE_SCHEDULE_MINUTES[settings.schedule];
    const existing = await chrome.alarms.get(UPDATE_ALARM);
    if (periodInMinutes === null) {
      if (existing) await chrome.alarms.clear(UPDATE_ALARM);
      return;
    }
    if (existing?.periodInMinutes === periodInMinutes) {
      return;
    }
    if (existing) await chrome.alarms.clear(UPDATE_ALARM);
    await chrome.alarms.create(UPDATE_ALARM, { periodInMinutes });
  });
  alarmTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const UPDATE_HANDLERS = {
  async hd_updates_schedule(message) {
    const schedule = managedUpdateSchedule(message?.schedule);
    if (schedule === null) {
      throw new Error("the dictionary update schedule is invalid");
    }
    const result = await writeUpdateSettings(current =>
      message.baseRevision === current.revision ? { ...current, schedule } : null);
    if (result.ok !== false) await reconcileUpdateAlarm();
    return result;
  },

  async hd_updates_check() {
    return queueManagedUpdate({ install: false });
  },

  async hd_updates_install(message) {
    if (!Array.isArray(message?.dictionaryIds)) {
      throw new TypeError("the dictionary update request carried no dictionary IDs");
    }
    return queueManagedUpdate({ dictionaryIds: message.dictionaryIds, install: true });
  },
};

function workerReply(message, result) {
  const { ok = true, error = null, ...payload } = result ?? {};
  return { type: `${message.type}_result`, requestId: message.requestId ?? null, ok, error, ...payload };
}

function checkedOptionsResult(message, result) {
  if (!responseFits(workerReply(message, result))) throw new Error(responseLimitError(message.type));
  return result;
}

function failureReply(message, error) {
  return boundResponseFailure({
    type: `${message?.type ?? "hd_unknown"}_result`,
    requestId: message?.requestId ?? null,
    ok: false,
    error: describe(error),
    generation: 0,
  });
}

const ANKI_METHODS = { hd_anki_status: "status", hd_anki_preflight: "preflight", hd_anki_submit: "submit", hd_anki_browse: "browse" };

// Anki owns its own mutation queue. Discovery, DOM rendering and network I/O
// must never hold the dictionary storage queue while the engine calls into it.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "hachidori-anki") return false;
  Promise.resolve().then(async () => {
    if (sender.id !== chrome.runtime.id || !Object.hasOwn(ANKI_METHODS, message.type)) throw new Error("Unknown Anki request.");
    if (!ankiMining) {
      const send = async (target, fields) => {
        const reply = await relay({ ...fields, target, requestId: `anki-${crypto.randomUUID()}` });
        if (!reply?.ok) throw new Error(reply?.error || "Anki preparation did not complete.");
        return reply;
      };
      ankiGateway ??= createAnkiGateway();
      ankiMining = createAnkiWorkerService({ gateway: ankiGateway,
        readOptions: async () => globalThis.HDReaderOptions.normaliseOptions((await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY]),
        readDictionaries: async () => (await readDictionaryStorage()).state?.dictionaries ?? [],
        engine: fields => send(TARGET, fields), offscreen: fields => send("hachidori-anki-render", fields),
      });
    }
    return ankiMining[ANKI_METHODS[message.type]](message.type === "hd_anki_browse" ? message.expression : message.request);
  }).then(result => sendResponse(workerReply(message, result)), error => sendResponse(failureReply(message, error)));
  return true;
});

const backupPreparations = new Map();

async function relayEngineRequest(message) {
  if (message.type === "hd_backup_cancel") {
    const preparation = backupPreparations.get(message.token);
    if (preparation) preparation.cancelled = true;
    return relay(message);
  }
  if (message.type !== "hd_backup_prepare") return relay(message);
  const preparation = { cancelled: false };
  backupPreparations.set(message.token, preparation);
  try {
    return await relay(message, () => !preparation.cancelled);
  } finally {
    if (backupPreparations.get(message.token) === preparation) backupPreparations.delete(message.token);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.target !== TARGET && message.target !== AUDIO_TARGET) || message.relayed === true) {
    return false;
  }
  let stillCurrent = null;
  let operation = null;
  if (message.target === AUDIO_TARGET) {
    try {
      if (!["hd_audio_test", "hd_audio_play", "hd_audio_candidates", "hd_audio_stop", "hd_audio_voices"].includes(message.type)) throw new Error("Unknown audio request.");
      validateAudioRequest(message);
      // Chrome supplies the document ID, so an old Settings tab cannot stop a
      // pronunciation subsequently started by a different document.
      message = { ...message, owner: sender.documentId };
      if (["hd_audio_test", "hd_audio_play", "hd_audio_candidates"].includes(message.type)) {
        operation = { ...message, tabId: sender.tab?.id };
        latestAudioOperation = operation;
        stillCurrent = () => latestAudioOperation === operation;
      } else if (message.type === "hd_audio_stop"
          && latestAudioOperation?.owner === message.owner && latestAudioOperation?.requestId === message.playRequestId) {
        // Retire it before awaiting offscreen startup. Otherwise its relay
        // retry could start playback after this Stop has already completed.
        latestAudioOperation = null;
      }
    } catch (error) {
      sendResponse(failureReply(message, error));
      return false;
    }
  }
  const response = message.target === AUDIO_TARGET
    ? prepareAudioRequest(message).then(prepared => relay(prepared, stillCurrent)) : relayEngineRequest(message);
  response.then(sendResponse, error => {
    sendResponse(failureReply(message, error));
  }).finally(() => { if (operation && latestAudioOperation === operation) latestAudioOperation = null; });
  return true;
});

function validateAudioRequest(message) {
  if (message.type === "hd_audio_test") {
    globalThis.HDReaderOptions.validateOptionsPatch({ audioSources: [message.source] });
    return;
  }
  if (message.type !== "hd_audio_play" && message.type !== "hd_audio_candidates") return;
  if (typeof message.term?.expression !== "string" || !message.term.expression
      || typeof message.term.reading !== "string") throw new Error("A pronunciation needs an expression and reading.");
  const choice = message.selection;
  if (choice !== undefined && (!choice || !Number.isInteger(choice.index) || choice.index < 0
      || !["sourceId", "sourceKey", "expression", "reading", "name"].every(key => typeof choice[key] === "string")
      || (choice.url !== null && typeof choice.url !== "string"))) throw new Error("Invalid pronunciation selection.");
}

async function prepareAudioRequest(message) {
  if (message.type !== "hd_audio_play" && message.type !== "hd_audio_candidates") return message;
  const stored = await chrome.storage.local.get(OPTIONS_KEY);
  const options = globalThis.HDReaderOptions.normaliseOptions(stored[OPTIONS_KEY]);
  return { ...message, sources: options.audioSources.filter(source => source.enabled) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "hachidori-audio-events") return false;
  const operation = latestAudioOperation;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT)
      || operation?.tabId === undefined || operation.owner !== message.owner
      || operation.requestId !== message.requestId || message.type !== "hd_audio_playing") return false;
  chrome.tabs.sendMessage(operation.tabId, { ...message, target: "hachidori-audio-content" }, { documentId: operation.owner })
    .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
});

// Never relay(): a WORKER_TARGET request must be answered here, or the engine's
// storage reads would re-enter the offscreen document.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== WORKER_TARGET) {
    return false;
  }
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.prototype.hasOwnProperty.call(WORKER_HANDLERS, type)) {
    sendResponse(failureReply(message, new Error(`unknown worker request type ${JSON.stringify(type)}`)));
    return false;
  }
  if (type === "hd_options_write") {
    let error = null;
    if (!validResponseRequestId(message.requestId ?? null)) {
      error = "the options write request carried an invalid request ID";
    } else if (!responseFits(message)) {
      error = responseLimitError(type);
    }
    if (error !== null) {
      sendResponse(failureReply(message, error));
      return true;
    }
  }
  const invoke = () => WORKER_HANDLERS[type](message, sender);
  // Navigation and read-only Anki discovery must not hold up storage commits.
  const operation = ["hd_open_external", "hd_anki_discover", "hd_backup_download"].includes(type) ? invoke() : serialiseStorage(invoke);
  operation.then(
    async (result) => {
      if (type === "hd_backup_cas" && result.ok !== false) {
        try { await reconcileUpdateAlarm(); }
        catch (error) { result.warning = `Restored successfully; update alarm could not be refreshed: ${describe(error)}`; }
      }
      sendResponse(workerReply(message, result));
    },
    (error) => {
      sendResponse(failureReply(message, error));
    },
  );
  return true;
});

// Update cycles relay imports back through the engine, which calls into the
// storage handlers above while committing. Keep this listener outside
// serialiseStorage() so the engine can complete that callback.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== UPDATE_TARGET) {
    return false;
  }
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.hasOwn(UPDATE_HANDLERS, type)) {
    sendResponse(failureReply(message, new Error(`unknown update request type ${JSON.stringify(type)}`)));
    return false;
  }
  Promise.resolve(UPDATE_HANDLERS[type](message)).then(
    (result) => {
      const { ok = true, error = null, ...payload } = result ?? {};
      sendResponse({ type: `${type}_result`, requestId: message.requestId ?? null, ok, error, ...payload });
    },
    (error) => {
      sendResponse(failureReply(message, error));
    },
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== UPDATE_ALARM) {
    return;
  }
  void readUpdateSettings().then((settings) => {
    if (settings.schedule !== "off") {
      return queueManagedUpdate({ install: true });
    }
    return undefined;
  }).catch((error) => {
    console.error("hoshidicts: scheduled dictionary updates failed:", describe(error));
  });
});

chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || delta.state.current === "in_progress") return;
  getBackupDownloads().changed(delta.id).catch(error => {
    console.warn("hoshidicts: could not release a finished backup download:", describe(error));
  });
});

function warmUp() {
  ensureOffscreen().catch((error) => {
    console.error("hoshidicts: could not create the offscreen document:", describe(error));
  });
  reconcileUpdateAlarm().catch((error) => {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describe(error));
  });
}

// Load the dictionaries before the first hover asks for them.
chrome.runtime.onInstalled.addListener(warmUp);
chrome.runtime.onStartup.addListener(warmUp);

// Alarms may be cleared across browser restarts. Module evaluation is the one
// startup path every MV3 worker takes, including starts not caused by either
// lifecycle event above.
async function initialiseUpdateAlarm() {
  try {
    await reconcileUpdateAlarm();
  } catch (error) {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describe(error));
  }
}

void initialiseUpdateAlarm(); // NOSONAR -- top-level await prevents this MV3 worker from activating.
