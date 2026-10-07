import { extensionApi as chrome } from "./browser-api.js";
import { captureWorkerDebugLog, readDebugLog } from "./debug-log.js";
import { describeErrorOrJson } from "./error-text.js";
import "./reader-options.js";
import { createAnkiGateway } from "./anki.js";
import { detectAnkiSetup, verifyAnkiSetup } from "./anki-setup.js";
import { createAnkiWorkerService } from "./anki-worker.js";
import { detectLocalAudioSource } from "./local-audio-setup.js";
import { createLocalAudioSource, findLocalAudioSource } from "./local-audio-source.js";
import { lookupAnkiIndex, lookupAnkiIndexMany } from "./anki-index.js";
import { ANKI_INDEX_KEY, createAnkiDuplicateIndex } from "./anki-index-cache.js";
import { assertBackupSnapshot, backupRevisions } from "./backup-state.js";
import {
  AUTOMATIC_BACKUP_ALARM, AUTOMATIC_BACKUPS_KEY, automaticBackupStore, nextAutomaticBackupTime, validAutomaticBackups,
} from "./backup-automatic.js";
import { SHARING_KEY } from "./sharing-host.js";
import { API_REQUESTS } from "./api-host.js";
import { SHARING_LOCAL_STATE_KEY } from "./sharing-client.js";
import {
  LINKED_ANKI_CAPABILITY, LINKED_IMPORT_CAPABILITY, LINKED_IMPORT_TARGET, allowLinkedAnkiDiscoveryRequest,
  allowLinkedAnkiRequest, allowLinkedAnkiSetupRequest, allowLinkedImportRequest, forwardableRequest,
} from "./sharing-protocol.js";
import { LOOKUP_STATS_KEY, LOOKUP_STATS_ROW_PREFIX, assertLookupStatsDescriptor, assertLookupStatsRows, emptyLookupStats, incrementLookupStats, lookupStatsKey, lookupStatsPrefix, normaliseLookupTerm, resetLookupStats } from "./lookup-stats.js";
import "./external-links.js";
import "./dictionary-group-state.js";
import "./word-status-overrides.js";
import { installedRecommendedDictionary, recommendedDictionarySource } from "./managed-dictionary-source.js";
import {
  CUSTOM_DICTIONARY_SOURCE_KEY, CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION, assertCustomDictionaryCommit,
  assertCustomSourceState, customDictionarySemanticRevision, normaliseCustomDictionaryDocument, parseCustomDictionary,
} from "./custom-dictionary.js";
import { sameJsonValue } from "./json-value.js";
import { responseFits, responseLimitError, validResponseRequestId } from "./response-limits.js";
import { HOST_CAPABILITIES, OVERLAY_MODE } from "./overlay-mode.js";
import {
  FIRST_INSTALL_OPTIONS, FIRST_INSTALL_SELECTIONS, OVERLAY_MODE_OPTIONS, SETUP_STATE_KEY, STARTUP_PAGE,
  RECOMMENDED_SELECTIONS_KEY, advanceSetupState, initialSetupState, normaliseSetupState, overlayAnkiOptions,
  recordSetupAnki, recordSetupDictionaries, withOverlayLookupDefault,
} from "./setup-state.js";
import { applyCustomJavaScript } from "./custom-javascript.js";
import { applyGoogleDocsFlag } from "./google-docs.js";
import { applyNetflixFlag } from "./netflix.js";
import {
  DEFAULT_OPTIONS, ankiTemplateConfig, normaliseOptions, projectStoredOptions, validateOptionsPatch,
  normaliseExternalUrl, pruneGroupMemberships, WORD_STATUS_OVERRIDES_KEY, normaliseWordStatusOverrides,
  withWordStatusOverride, OFFSCREEN_DOCUMENT, TARGET, UPDATE_TARGET, AUDIO_TARGET, SETUP_TARGET, PAGE_ZOOM_TARGET,
  BACKUP_LIFECYCLE_PORT, WORKER_TARGET, DICTIONARY_STATE_KEY, OPTIONS_KEY, UPDATE_SETTINGS_KEY, engineSender,
  ankiSettingsSender, writeLocalState, ensureOffscreen, relay, readDictionaryStorage, normaliseDictionarySelections,
  assertDictionaryState, assertOrdinaryCustomTransition, assertCustomDictionaryCasRequest, dictionaryCommit,
  optionsRevision, removeLegacyDictionaryRows, startupSender, optionsWriteResult, serialiseStorage, workerReply,
  failureReply,
} from "./background-core.js";
import {
  trackAnkiOperation, readAnkiOptions, broadcastWordStatus, indexRevision, reconcileAnkiIndex, handleAnkiRequest,
  sendAnkiRequest, answerAnkiRequest,
} from "./background-anki.js";
import {
  automaticBackupNextAt, automaticBackupWaitingForState, getBackupDownloads, assertBackupEngineSender,
  readBackupPayload, automaticBackupSummary, scheduleAutomaticBackup, queueAutomaticBackup, relayEngineRequest,
  validBackupPreparationToken, cancelOwnedBackupPreparation, handleAlarm,
} from "./background-backup.js";
import {
  updateCycleActive, reconcileUpdateAlarm, refreshUpdateAlarm, updateTiming, handleUpdatesRequest,
} from "./background-updates.js";
import {
  SHARED_STATE_KEYS, sharingHost, dictionaryCount, LOCAL_UPLOAD_OWNER, remoteUploadOwner, answerUploadRequest,
  getApiHost, sharingLinked, sharingTransitionTail, WORKER_FORWARDS, stateStore, getSharingClient, forwardToHost,
  compatibleLinkedWorkerMessage, forwardWorkerRequest, serialiseSharingTransition, SHARING_HANDLERS,
  initialiseSharing,
} from "./background-sharing.js";
import {
  NETFLIX_TARGET, NETFLIX_RECORDER_PORT, NETFLIX_WATCH_URL, adoptNetflixRecorder, handleNetflixRequest,
} from "./background-netflix.js";

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

let ankiGateway, ankiMining, ankiDuplicateIndex;

// One first-run Anki detection at a time; duplicate startup pages share it.
let ankiSetupDetection = null;

// Settings → Advanced → Get debug info reads this worker's recent warnings,
// errors and failed replies (debug-log.js).
captureWorkerDebugLog(globalThis, chrome.storage.session);

// The overlay host (Electron 43) exposes chrome.alarms, and create()/get()
// even record the alarm, but onAlarm never dispatches to the worker; a host
// without the API at all behaves the same. Keep the one-shot contract on
// worker-lifetime timers there: a worker restart re-runs the module-load
// reconciliation, which re-arms whatever is still due.
const alarms = chrome.alarms && !OVERLAY_MODE ? chrome.alarms : createTimerAlarms();

function createTimerAlarms() {
  const MAX_TIMER_MS = 2 ** 31 - 1;
  const pending = new Map();
  function arm(name, when) {
    pending.get(name).timer = setTimeout(() => {
      if (Date.now() < when) {
        arm(name, when);
        return;
      }
      pending.delete(name);
      handleAlarm({ name, scheduledTime: when });
    }, Math.min(Math.max(when - Date.now(), 0), MAX_TIMER_MS));
  }
  return {
    async create(name, { when, delayInMinutes }) {
      clearTimeout(pending.get(name)?.timer);
      const scheduledTime = when ?? Date.now() + delayInMinutes * 60_000;
      pending.set(name, { when: scheduledTime });
      arm(name, scheduledTime);
    },
    async get(name) {
      const entry = pending.get(name);
      return entry ? { name, scheduledTime: entry.when } : undefined;
    },
    async clear(name) {
      const entry = pending.get(name);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(name);
      return true;
    },
  };
}

let sharingReady = Promise.resolve();

function getAnkiDuplicateIndex() {
  ankiDuplicateIndex ??= createAnkiDuplicateIndex({
    fetchRows: async source => {
      const reply = await relay({ target: "hachidori-anki-render", type: "hd_anki_index_refresh",
        requestId: `anki-index-${crypto.randomUUID()}`, source });
      if (!reply.ok) throw new Error(reply.error);
      return reply.rows;
    },
    lookupLive: (source, expression, invoke) => lookupAnkiIndex(invoke, source, expression),
    lookupLiveMany: (source, expressions, invoke) => lookupAnkiIndexMany(invoke, source, expressions),
    readOptions: readAnkiOptions,
    readState: async () => (await chrome.storage.local.get(ANKI_INDEX_KEY))[ANKI_INDEX_KEY],
    updateState: update => serialiseStorage(async () => {
      const stored = await chrome.storage.local.get([OPTIONS_KEY, ANKI_INDEX_KEY]);
      const state = stored[ANKI_INDEX_KEY];
      const next = await update({ options: normaliseOptions(stored[OPTIONS_KEY]), state });
      if (next !== undefined && !sameJsonValue(state, next)) {
        await writeLocalState({ [ANKI_INDEX_KEY]: next });
      }
      return next ?? state;
    }),
    alarms,
  });
  return ankiDuplicateIndex;
}

let latestAudioOperation = null;

// The engine or settings page reads state, changes it, and sends it back a
// message round trip later. A caller includes the revision it read so a stale
// write cannot discard a change made by another extension context.
async function lookupStatisticsStorage(message, record) {
  const term = normaliseLookupTerm(message.term, message.reading);
  const stored = await chrome.storage.local.get([LOOKUP_STATS_KEY, OPTIONS_KEY]);
  let descriptor = stored[LOOKUP_STATS_KEY] === undefined ? emptyLookupStats() : stored[LOOKUP_STATS_KEY];
  assertLookupStatsDescriptor(descriptor);
  const storedOptions = stored[OPTIONS_KEY];
  if (storedOptions?.showLookupCounts === false) {
    return { descriptor, statistics: null };
  }
  const key = lookupStatsKey(descriptor, term);
  let row = descriptor.generation === null ? undefined : (await chrome.storage.local.get(key))[key];
  if (record) {
    row = incrementLookupStats(row, term, Date.now());
    descriptor = { generation: descriptor.generation ?? crypto.randomUUID(), revision: descriptor.revision + 1 };
    assertLookupStatsDescriptor(descriptor);
    await writeLocalState({ [LOOKUP_STATS_KEY]: descriptor, [lookupStatsKey(descriptor, term)]: row });
  } else if (row !== undefined) {
    assertLookupStatsRows(descriptor, [row]);
    if (lookupStatsKey(descriptor, row) !== key) throw new Error("The lookup statistics row does not match its key.");
  }
  return {
    descriptor,
    statistics: row ?? { ...term, lookupCount: 0 },
  };
}

function lookupStatistics(message, record) {
  return serialiseStorage(
    () => lookupStatisticsStorage(message, record),
  );
}

// Rows outside the committed descriptor's generation are unreachable.
async function removeObsoleteLookupStatsRows() {
  const stored = await chrome.storage.local.get(null);
  const descriptor = stored[LOOKUP_STATS_KEY] === undefined ? emptyLookupStats() : stored[LOOKUP_STATS_KEY];
  assertLookupStatsDescriptor(descriptor);
  const prefix = lookupStatsPrefix(descriptor);
  const unused = Object.keys(stored).filter(key => key.startsWith(LOOKUP_STATS_ROW_PREFIX) && !key.startsWith(prefix));
  if (unused.length > 0) await chrome.storage.local.remove(unused);
}

const WORKER_HANDLERS = {
  hd_lookup_stats_record(message) { return lookupStatistics(message, true); },
  hd_lookup_stats_read(message) { return lookupStatistics(message, false); },
  async hd_lookup_stats_cleanup(_message, sender) {
    assertBackupEngineSender(sender);
    await removeObsoleteLookupStatsRows();
    return {};
  },
  // Runs in the storage queue, so each lookup is recorded wholly before or
  // after the new generation; the old rows are unreachable once it commits.
  async hd_lookup_stats_reset(_message, sender) {
    if (!ankiSettingsSender(sender)) throw new Error("Lookup counts can be reset only from Hachidori Settings.");
    // A linked install mirrors the host's counts; resetting the mirror would not reset them.
    if (sharingLinked) throw new Error("Lookup counts belong to the linked Hachidori. Unlink to reset this browser's counts.");
    const stored = await chrome.storage.local.get(LOOKUP_STATS_KEY);
    const descriptor = resetLookupStats(stored[LOOKUP_STATS_KEY]);
    await writeLocalState({ [LOOKUP_STATS_KEY]: descriptor });
    try {
      await removeObsoleteLookupStatsRows();
    } catch (error) {
      console.warn("hachidori: lookup counts were reset; the replaced rows could not be removed yet:", describeErrorOrJson(error));
    }
    return { descriptor };
  },
  // Mark as known and Ignore (#520): one headword set to known or ignored, or
  // cleared with null. It runs in the storage queue and changes only that
  // headword, so writes from several tabs compose without a base revision.
  async hd_word_status_override(message) {
    const stored = (await chrome.storage.local.get(WORD_STATUS_OVERRIDES_KEY))[WORD_STATUS_OVERRIDES_KEY];
    const current = normaliseWordStatusOverrides(stored);
    const next = withWordStatusOverride(current, message.headword, message.status);
    if (next !== current) await writeLocalState({ [WORD_STATUS_OVERRIDES_KEY]: next });
    return { revision: next.revision };
  },
  async hd_backup_download(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("settings.html")) {
      throw new Error("Backup downloads are available only from Hachidori Settings.");
    }
    return getBackupDownloads().download();
  },
  async hd_backup_base_read() {
    const stored = await chrome.storage.local.get([
      DICTIONARY_STATE_KEY, OPTIONS_KEY, CUSTOM_DICTIONARY_SOURCE_KEY, UPDATE_SETTINGS_KEY, LOOKUP_STATS_KEY,
      WORD_STATUS_OVERRIDES_KEY,
    ]);
    return { snapshot: {
      state: stored[DICTIONARY_STATE_KEY] ?? null,
      options: stored[OPTIONS_KEY] ?? null,
      document: stored[CUSTOM_DICTIONARY_SOURCE_KEY] ?? null,
      updates: stored[UPDATE_SETTINGS_KEY] ?? null,
      lookupStats: stored[LOOKUP_STATS_KEY] ?? null,
      wordStatusOverrides: stored[WORD_STATUS_OVERRIDES_KEY] ?? null,
    } };
  },

  async hd_backup_read() {
    return readBackupPayload();
  },

  async hd_debug_log(_message, sender) {
    if (!ankiSettingsSender(sender)) throw new Error("The debug log is available only from Hachidori Settings.");
    return { log: await readDebugLog(globalThis) };
  },
  async hd_backup_auto_list(_message, sender) {
    if (!ankiSettingsSender(sender)) {
      throw new Error("Automatic backups are available only from Hachidori Settings.");
    }
    if (sharingLinked) return { backups: [], corruptCount: 0, linked: true };
    const stored = (await chrome.storage.local.get(AUTOMATIC_BACKUPS_KEY))[AUTOMATIC_BACKUPS_KEY];
    const { backups, corruptCount } = await validAutomaticBackups(stored);
    return { backups: backups.map(automaticBackupSummary), corruptCount };
  },

  async hd_backup_auto_get(message, sender) {
    assertBackupEngineSender(sender);
    if (typeof message.id !== "string" || message.id === "") {
      throw new Error("Choose an automatic backup to restore.");
    }
    const stored = (await chrome.storage.local.get(AUTOMATIC_BACKUPS_KEY))[AUTOMATIC_BACKUPS_KEY];
    const { backups } = await validAutomaticBackups(stored);
    const matches = backups.filter(record => record.id === message.id);
    if (matches.length !== 1) {
      throw new Error("This automatic backup is corrupt or no longer retained.");
    }
    return { backup: matches[0] };
  },

  async hd_backup_auto_roots(_message, sender) {
    assertBackupEngineSender(sender);
    const stored = (await chrome.storage.local.get(AUTOMATIC_BACKUPS_KEY))[AUTOMATIC_BACKUPS_KEY];
    const store = automaticBackupStore(stored);
    const { backups, corruptCount } = await validAutomaticBackups(store);
    if (corruptCount > 0 || backups.length !== store.backups.length) {
      return { complete: false, dictionaries: [] };
    }
    return {
      complete: true,
      dictionaries: backups.flatMap(record => record.snapshot.state.dictionaries),
    };
  },

  async hd_backup_cas(message, sender) {
    assertBackupEngineSender(sender);
    const { snapshot: current } = await WORKER_HANDLERS.hd_backup_base_read();
    if (!sameJsonValue(message.base, current)) {
      return { ok: false, conflict: true, error: "Hachidori changed since this backup was prepared. Prepare it again before restoring." };
    }
    const snapshot = message.snapshot;
    await assertBackupSnapshot(snapshot);
    assertLookupStatsRows(snapshot.lookupStats, message.lookupStatsRows);
    if (snapshot.lookupStats.generation === null || snapshot.lookupStats.generation === current.lookupStats?.generation) {
      throw new Error("A backup restore requires a fresh lookup statistics namespace.");
    }
    const expected = Object.fromEntries(Object.entries(backupRevisions(current)).map(([key, revision]) => [key, revision + 1]));
    if (!sameJsonValue(backupRevisions(snapshot), expected)) throw new Error("Invalid backup restore revisions.");
    if (!sameJsonValue(snapshot.options, normaliseDictionarySelections(snapshot.options, snapshot.state.dictionaries, snapshot.state.groups))) {
      throw new Error("The backup reader settings refer to unavailable dictionaries.");
    }
    await writeLocalState({
      [DICTIONARY_STATE_KEY]: snapshot.state,
      [OPTIONS_KEY]: snapshot.options,
      [CUSTOM_DICTIONARY_SOURCE_KEY]: snapshot.document,
      [UPDATE_SETTINGS_KEY]: snapshot.updates,
      [LOOKUP_STATS_KEY]: snapshot.lookupStats,
      [WORD_STATUS_OVERRIDES_KEY]: snapshot.wordStatusOverrides,
      ...Object.fromEntries(message.lookupStatsRows.map(row => [lookupStatsKey(snapshot.lookupStats, row), row])),
    });
    return { snapshot };
  },

  async hd_anki_discover(message, sender) {
    if (!ankiSettingsSender(sender)) {
      throw new Error("Anki discovery is available only from Hachidori Settings");
    }
    if (typeof message.model !== "string" || typeof message.apiKey !== "string") {
      throw new TypeError("Anki discovery requires a note type and API key string");
    }
    ankiGateway ??= createAnkiGateway();
    const stored = await chrome.storage.local.get(OPTIONS_KEY);
    const url = message.url === undefined ? normaliseOptions(stored[OPTIONS_KEY]).anki.url : message.url;
    return ankiGateway.discover({ model: message.model, apiKey: message.apiKey, url });
  },
  async hd_anki_setup(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("settings.html")) {
      throw new Error("Anki setup discovery is available only from Hachidori Settings");
    }
    // Settings owns the draft and saves a proposal through its ordinary options
    // CAS. Discovery itself neither changes options nor records onboarding.
    return checkAnkiSetup(validateOptionsPatch({ anki: message.anki }).anki);
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

  async hd_state_read(message, sender) {
    const { state, legacyDictionaries } = await readDictionaryStorage(false, stateStore(sender));
    return { state, legacyDictionaries };
  },

  async hd_state_cas(message, sender) {
    const store = stateStore(sender);
    if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
      throw new Error("the dictionary state write request carried no valid base revision");
    }
    if (!Array.isArray(message?.dictionaries)) {
      throw new TypeError("the dictionary state write request carried no list");
    }
    if (message.groups !== undefined && !Array.isArray(message.groups)) {
      throw new TypeError("the dictionary state write request carried invalid groups");
    }

    const { state: current, legacyDictionaries, options: currentOptions } = await readDictionaryStorage(false, store);
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
        error: describeErrorOrJson(error),
        state: current,
      };
    }
    const { state, values } = dictionaryCommit(
      current,
      currentOptions,
      message.dictionaries,
      message.groups,
    );
    await writeLocalState(values, store);
    await removeLegacyDictionaryRows(current, legacyDictionaries);
    return { state };
  },

  async hd_custom_read(message, sender) {
    const { state, customDocument } = await readDictionaryStorage(true, stateStore(sender));
    assertDictionaryState(state);
    return {
      document: normaliseCustomDictionaryDocument(customDocument),
      state,
    };
  },

  async hd_custom_cas(message, sender) {
    const store = stateStore(sender);
    const changesDictionaryState = assertCustomDictionaryCasRequest(message);

    const {
      state: current,
      legacyDictionaries,
      options: currentOptions,
      customDocument: storedDocument,
    } = await readDictionaryStorage(true, store);
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
      await writeLocalState(values, store);
      if (state !== current) {
        await removeLegacyDictionaryRows(current, legacyDictionaries);
      }
    }
    return { document: nextDocument, state };
  },

  async hd_options_write(message) {
    const patch = validateOptionsPatch(message.options);
    const { state, options: currentOptions } = await readDictionaryStorage();
    const result = optionsWriteResult(message, patch, state, currentOptions);
    if (result.ok !== false && result.options.revision !== optionsRevision(currentOptions)) {
      await writeLocalState({ [OPTIONS_KEY]: result.options });
    }
    return result;
  },

  async hd_setup_cas(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL(STARTUP_PAGE)) {
      throw new Error("Setup progress can be changed only from the Hachidori startup page.");
    }
    if (!Number.isInteger(message.baseRevision) || message.baseRevision < 0) {
      throw new Error("the setup write request carried no valid base revision");
    }
    if (message.continued !== undefined && typeof message.continued !== "boolean") {
      throw new Error("the setup write request carried an invalid continuation flag");
    }
    const stored = await chrome.storage.local.get(SETUP_STATE_KEY);
    const current = normaliseSetupState(stored[SETUP_STATE_KEY]);
    if (current === null) throw new Error("Setup has not started on this installation.");
    if (message.baseRevision !== current.revision) {
      return { ok: false, conflict: true, error: "Setup changed in another tab.", state: current };
    }
    const state = advanceSetupState(current, message.stage, new Date().toISOString(), { continued: message.continued === true });
    await writeLocalState({ [SETUP_STATE_KEY]: state });
    return { state };
  },

  // The offscreen installer reports each dictionary outcome and each run's
  // duration; a committed catalogue entry also settles its first-install
  // selection exactly once.
  // The startup page asks once for Anki and local-audio detection. The Anki
  // outcome is the durable gate, so duplicate startup pages share one run.
  async hd_setup_anki(message, sender) {
    if (!startupSender(sender)) throw new Error("Anki setup is available only from the Hachidori startup page.");
    const stored = await chrome.storage.local.get(SETUP_STATE_KEY);
    const current = normaliseSetupState(stored[SETUP_STATE_KEY]);
    if (current === null) throw new Error("Setup has not started on this installation.");
    if (current.stage === "welcome") throw new Error("Start setup before checking Anki.");
    if (current.anki !== null) return { state: current };
    ankiSetupDetection ??= detectFirstRunAnki().finally(() => { ankiSetupDetection = null; });
    return ankiSetupDetection;
  },

  // The offscreen document reads the engine's own options once at start; the
  // storage listener below pushes later changes to it.
  async hd_engine_config(message, sender) {
    if (!engineSender(sender)) throw new Error("The engine configuration is read only by the dictionary engine host.");
    const stored = await chrome.storage.local.get(OPTIONS_KEY);
    const { lowMemoryMode, dictionaryEntryStorage, dictionaryIndexStorage, useLessRamByDefault } = normaliseOptions(stored[OPTIONS_KEY]);
    return { lowMemoryMode, dictionaryEntryStorage, dictionaryIndexStorage, useLessRamByDefault };
  },

  async hd_setup_record(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT)) {
      throw new Error("Setup outcomes are recorded only by the dictionary engine host.");
    }
    const outcomes = message.outcomes ?? {};
    if (!outcomes || typeof outcomes !== "object" || Array.isArray(outcomes)
        || !Object.keys(outcomes).every((sourceId) => recommendedDictionarySource(sourceId) !== null)) {
      throw new Error("the setup record names an unknown catalogue source");
    }
    const stored = await chrome.storage.local.get([SETUP_STATE_KEY, DICTIONARY_STATE_KEY, OPTIONS_KEY, RECOMMENDED_SELECTIONS_KEY]);
    const store = stateStore(sender);
    const library = store === chrome.storage.local ? stored : await store.get([DICTIONARY_STATE_KEY, OPTIONS_KEY]);
    const current = normaliseSetupState(stored[SETUP_STATE_KEY]);
    const previousSelections = stored[RECOMMENDED_SELECTIONS_KEY] ?? current?.dictionaries.selectionsApplied ?? [];
    const selections = firstInstallSelections(previousSelections, outcomes, library[DICTIONARY_STATE_KEY], library[OPTIONS_KEY]);
    const state = recordSetupDictionaries(message.recordSetup === false ? null : current, {
      runId: message.runId, outcomes, runSeconds: message.runSeconds ?? null, selectionsApplied: selections.applied,
    });
    const values = state === null ? {} : { [SETUP_STATE_KEY]: state };
    if (selections.applied.length > 0) values[RECOMMENDED_SELECTIONS_KEY] = [...new Set([...previousSelections, ...selections.applied])];
    if (selections.options !== null) {
      if (store === chrome.storage.local) values[OPTIONS_KEY] = selections.options;
      else {
        const captured = (await chrome.storage.local.get(SHARING_LOCAL_STATE_KEY))[SHARING_LOCAL_STATE_KEY];
        values[SHARING_LOCAL_STATE_KEY] = { ...captured, options: selections.options };
      }
    }
    if (Object.keys(values).length > 0) await writeLocalState(values);
    return { state };
  },
};

// Ordinary absence is a connection that never answered; an answer that refused
// or failed keeps its specific reason.
function ankiSetupFailure(error) {
  const detail = describeErrorOrJson(error);
  const unavailable = /Open Anki with the AnkiConnect add-on|timed out/iu.test(detail);
  return { status: unavailable ? "unavailable" : "needs-attention", detail, model: null, deck: null };
}

// One read-only conversation with Anki: an unconfigured profile is offered a
// proposal, and a mapping the user already saved is verified the way Settings
// verifies it, never replaced. Nothing here holds the storage queue.
async function checkAnkiSetup(anki) {
  ankiGateway ??= createAnkiGateway();
  const invoke = (action, params) => ankiGateway.invoke(action, params, anki.apiKey, undefined, anki.url);
  try {
    const proposal = anki.model === "" ? await detectAnkiSetup(invoke, anki) : await verifyAnkiSetup(invoke, anki);
    return { proposal, outcome: { status: proposal.status, detail: proposal.detail, model: proposal.model, deck: proposal.deck } };
  } catch (error) {
    // Nothing is claimed about a mapping that could not be checked: the
    // connection's own reason is the outcome, and the mapping is left untouched.
    return { proposal: null, outcome: ankiSetupFailure(error) };
  }
}

// The check runs outside the storage queue, so the mapping it judged can change
// while it runs. Such a check is stale: the write is abandoned and the mapping
// now stored is checked instead. Only a mapping that stops changing can be
// recorded, so a user still editing Anki settings gets that reason and the link.
const ANKI_SETUP_ATTEMPTS = 3;
const ANKI_SETUP_CHANGED = "Anki settings changed while setup checked them. Confirm the mapping in Settings.";

async function detectFirstRunLocalAudio(options) {
  if (sharingLinked || findLocalAudioSource(options.audioSources) !== null) return null;
  try {
    return await detectLocalAudioSource({ fetch: globalThis.fetch });
  } catch {
    // Local audio is optional. Its absence never changes the Anki outcome or
    // interrupts first-run setup.
    return null;
  }
}

async function detectFirstRunAnki() {
  let localAudioDetection = null;
  for (let attempt = 1; ; attempt += 1) {
    const stored = await chrome.storage.local.get([SETUP_STATE_KEY, OPTIONS_KEY]);
    const options = normaliseOptions(stored[OPTIONS_KEY]);
    const last = attempt >= ANKI_SETUP_ATTEMPTS;
    localAudioDetection ??= detectFirstRunLocalAudio(options);
    const [{ proposal, outcome }, detectedAudio] = await Promise.all([
      checkAnkiSetup(options.anki),
      localAudioDetection,
    ]);
    const written = await serialiseStorage(async () => {
      const current = await chrome.storage.local.get([SETUP_STATE_KEY, OPTIONS_KEY]);
      const setup = normaliseSetupState(current[SETUP_STATE_KEY]);
      if (setup === null) throw new Error("Setup has not started on this installation.");
      if (setup.anki !== null) return { state: setup };
      const currentOptions = normaliseOptions(current[OPTIONS_KEY]);
      const stale = !sameJsonValue(currentOptions.anki, options.anki);
      if (stale && !last) return null;
      const values = {};
      const patch = {};
      if (!stale && proposal?.status === "configured") {
        const anki = { ...options.anki, model: proposal.model, deck: proposal.deck, fieldTemplates: proposal.fieldTemplates };
        patch.anki = anki;
      }
      if (detectedAudio !== null && !sharingLinked && findLocalAudioSource(currentOptions.audioSources) === null) {
        patch.audioSources = [createLocalAudioSource(crypto.randomUUID(), detectedAudio), ...currentOptions.audioSources];
      }
      if (Object.keys(patch).length > 0) {
        const revision = optionsRevision(current[OPTIONS_KEY]);
        values[OPTIONS_KEY] = {
          ...projectStoredOptions(current[OPTIONS_KEY]),
          ...validateOptionsPatch(patch),
          revision: revision + 1,
        };
      }
      const state = recordSetupAnki(setup, stale
        ? { status: "needs-attention", detail: ANKI_SETUP_CHANGED, model: null, deck: null }
        : outcome);
      values[SETUP_STATE_KEY] = state;
      await writeLocalState(values);
      return { state };
    });
    if (written !== null) return written;
  }
}

// Dictionary-dependent initial preferences follow the committed entry's exact
// title, whether setup installed it or found it installed. Each is consumed
// once; an option the user already changed is left alone.
function firstInstallSelections(previousSelections, outcomes, dictionaryState, storedOptions) {
  const dictionaries = dictionaryState?.dictionaries ?? [];
  const effective = normaliseOptions(storedOptions);
  const applied = [];
  const patch = {};
  for (const [sourceId, rule] of Object.entries(FIRST_INSTALL_SELECTIONS)) {
    if (!["installed", "already-installed"].includes(outcomes[sourceId]?.status)
        || previousSelections.includes(sourceId)) continue;
    // The same catalogue identity the installer uses, so a package carried in
    // or imported by hand, which is recognised by its exact update index, is
    // the entry the selection follows.
    const source = recommendedDictionarySource(sourceId);
    const committed = source === null ? null : installedRecommendedDictionary(source, dictionaries);
    if (committed === null) continue;
    applied.push(sourceId);
    if (effective[rule.option] === "") patch[rule.option] = rule.select(committed.title);
  }
  if (Object.keys(patch).length === 0) return { applied, options: null };
  const revision = optionsRevision(storedOptions);
  const options = normaliseDictionarySelections(
    { ...projectStoredOptions(storedOptions), ...validateOptionsPatch(patch), revision }, dictionaries, dictionaryState?.groups ?? [],
  );
  return { applied, options: sameJsonValue(options, { ...storedOptions, revision }) ? null : { ...options, revision: revision + 1 } };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[DICTIONARY_STATE_KEY]) return;
  sharingHost?.setDictionaries(dictionaryCount(changes[DICTIONARY_STATE_KEY].newValue));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || updateCycleActive) return;
  const state = changes[DICTIONARY_STATE_KEY];
  // Update-settings writers reconcile explicitly after releasing the storage queue.
  if (state && !sameJsonValue(
    updateTiming(state.oldValue?.dictionaries), updateTiming(state.newValue?.dictionaries),
  )) void refreshUpdateAlarm();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[OPTIONS_KEY]) return;
  void reconcileAnkiIndex();
  void applyCustomJavaScript(chrome, normaliseOptions(changes[OPTIONS_KEY].newValue).customPopupJavascript);
  void applyGoogleDocsFlag(chrome, normaliseOptions(changes[OPTIONS_KEY].newValue).experimental.googleDocs);
  void applyNetflixFlag(chrome, normaliseOptions(changes[OPTIONS_KEY].newValue).experimental.netflixMining);
  const { lowMemoryMode, dictionaryEntryStorage, dictionaryIndexStorage, useLessRamByDefault } = normaliseOptions(changes[OPTIONS_KEY].newValue);
  const previous = normaliseOptions(changes[OPTIONS_KEY].oldValue);
  if (lowMemoryMode === previous.lowMemoryMode && dictionaryEntryStorage === previous.dictionaryEntryStorage
      && dictionaryIndexStorage === previous.dictionaryIndexStorage && useLessRamByDefault === previous.useLessRamByDefault) return;
  // Sent to the offscreen document only if it exists: a document created later
  // reads the option itself. A busy engine picks the change up when idle.
  Promise.resolve(chrome.runtime.sendMessage({ target: TARGET, type: "hd_engine_config", relayed: true,
    lowMemoryMode, dictionaryEntryStorage, dictionaryIndexStorage, useLessRamByDefault }))
    .catch(() => {});
});

// A local index change broadcasts to this install's own tabs and, while
// hosting, to every linked browser. A linked install leaves its own suspended
// index alone and relays the host's revision through the client callback.
// A source change keeps the row revision but answers from other rows (none
// until its first pull), so it is announced without one.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ANKI_INDEX_KEY]) return;
  const { oldValue, newValue } = changes[ANKI_INDEX_KEY];
  let revision;
  if (indexRevision(newValue, "configurationRevision") !== indexRevision(oldValue, "configurationRevision")) {
    revision = null;
  } else if (indexRevision(newValue, "rowRevision") !== indexRevision(oldValue, "rowRevision")) {
    revision = indexRevision(newValue, "rowRevision");
  } else {
    return;
  }
  if (!sharingLinked) broadcastWordStatus(revision);
  sharingHost?.wordStatusChanged(revision);
});

// Only this extension's own recorder page, framed in a Netflix tab, may
// connect, and only while Netflix mining is on: the page is web-accessible to
// Netflix, so a frame the page made itself is refused with the switch off.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== NETFLIX_RECORDER_PORT) return;
  const { sender } = port;
  const tabId = sender?.tab?.id;
  if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("netflix-recorder.html")
      || typeof tabId !== "number" || !sender.frameId || !NETFLIX_WATCH_URL.test(sender.tab.url ?? "")) {
    port.disconnect();
    return;
  }
  let open = true;
  port.onDisconnect.addListener(() => { open = false; });
  chrome.storage.local.get(OPTIONS_KEY).then(stored => {
    if (!open) return;
    if (normaliseOptions(stored[OPTIONS_KEY]).experimental.netflixMining === true) adoptNetflixRecorder(tabId, port);
    else port.disconnect();
  }, () => port.disconnect());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== NETFLIX_TARGET) return false;
  handleNetflixRequest(message, sender).then(result => sendResponse(workerReply(message, result)),
    error => sendResponse(failureReply(message, error)));
  return true;
});

// Anki owns its own mutation queue. Discovery, DOM rendering and network I/O
// must never hold the dictionary storage queue while the engine calls into it.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "hachidori-anki") return false;
  handleAnkiRequest(message, sender).then(sendResponse, (error) => sendResponse(failureReply(message, error)));
  return true;
});

function getAnkiMining() {
  if (!ankiMining) {
    const send = sendAnkiRequest;
    ankiGateway ??= createAnkiGateway();
    ankiMining = createAnkiWorkerService({ gateway: ankiGateway,
      readOptions: readAnkiOptions,
      duplicateIndex: getAnkiDuplicateIndex(),
      readDictionaries: async () => (await readDictionaryStorage()).state?.dictionaries ?? [],
      engine: fields => send(TARGET, fields), offscreen: fields => send("hachidori-anki-render", fields),
    });
  }
  return ankiMining;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BACKUP_LIFECYCLE_PORT) return;
  if (!ankiSettingsSender(port.sender)) {
    port.disconnect();
    return;
  }
  const owned = new Set();
  port.onMessage.addListener((message) => {
    if (!validBackupPreparationToken(message?.token)) return;
    if (message.type === "track" && typeof message.active === "boolean") {
      if (message.active) owned.add(message.token);
      else owned.delete(message.token);
      return;
    }
    if (message.type === "cancel" && owned.has(message.token)) {
      void cancelOwnedBackupPreparation(message.token).then(
        () => owned.delete(message.token),
        error => console.warn("hachidori: could not discard an abandoned backup preparation:", describeErrorOrJson(error)),
      );
    }
  });
  port.onDisconnect.addListener(() => {
    const abandoned = [...owned];
    owned.clear();
    for (const token of abandoned) {
      void cancelOwnedBackupPreparation(token).catch(
        error => console.warn("hachidori: could not discard an abandoned backup preparation:", describeErrorOrJson(error)),
      );
    }
  });
});

// The reader's popup cancels browser zoom, which only extension APIs report.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== PAGE_ZOOM_TARGET) return false;
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || message.type !== "hd_page_zoom" || !Number.isInteger(tabId)) {
    sendResponse(failureReply(message, new Error("Unknown page zoom request.")));
    return false;
  }
  chrome.tabs.getZoom(tabId).then((zoomFactor) => sendResponse(workerReply(message, { zoomFactor })),
    (error) => sendResponse(failureReply(message, error)));
  return true;
});

// Startup and Settings attach to one recommended-install run. The welcome gate
// belongs to startup; opening Settings never requires an onboarding record.
async function handleRecommendedInstall(message, sender, shared = false) {
  const startup = startupSender(sender);
  const settings = sender?.id === chrome.runtime.id
    && sender.url?.split(/[?#]/u)[0] === chrome.runtime.getURL("settings.html");
  if (!shared && !startup && !settings) throw new Error("Recommended installation is available only from Hachidori startup or Settings.");
  if (message.type !== "hd_setup_install") throw new Error("Unknown recommended installation request.");
  if (startup) {
    const stored = await chrome.storage.local.get(SETUP_STATE_KEY);
    const current = normaliseSetupState(stored[SETUP_STATE_KEY]);
    if (current === null) throw new Error("Setup has not started on this installation.");
    if (current.stage === "welcome") throw new Error("Start setup before downloading dictionaries.");
  }
  // Never hold the storage queue here: each engine commit calls back into it.
  await sharingReady;
  return sharingLinked ? forwardToHost(message) : relay({ ...message, recordSetup: startup });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== SETUP_TARGET || message.relayed === true) return false;
  handleRecommendedInstall(message, sender).then(sendResponse, (error) => sendResponse(failureReply(message, error)));
  return true;
});

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
        operation = { ...message, tabId: sender.tab?.id, startup: startupSender(sender) };
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
      || !operation || (!operation.startup && operation.tabId === undefined) || operation.owner !== message.owner
      || operation.requestId !== message.requestId || message.type !== "hd_audio_playing") return false;
  const progress = { ...message, target: "hachidori-audio-content" };
  // The packaged startup reader lives in an extension page, outside the
  // content-script audience of tabs.sendMessage. Its controller accepts only
  // its active random request ID; the worker already checked the document owner.
  const delivery = operation.startup ? chrome.runtime.sendMessage(progress)
    : chrome.tabs.sendMessage(operation.tabId, progress, { documentId: operation.owner });
  delivery.then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
  return true;
});

// Never relay(): a WORKER_TARGET request must be answered here, or the engine's
// storage reads would re-enter the offscreen document.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== WORKER_TARGET) {
    return false;
  }
  handleWorkerRequest(message, sender).then(sendResponse, (error) => sendResponse(failureReply(message, error)));
  return true;
});

async function handleWorkerRequest(message, sender) {
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.prototype.hasOwnProperty.call(WORKER_HANDLERS, type)) {
    return failureReply(message, new Error(`unknown worker request type ${JSON.stringify(type)}`));
  }
  if (type === "hd_backup_download" && typeof chrome.downloads?.download !== "function") {
    return failureReply(message, new Error("Browser downloads are unavailable. Export the backup from Hachidori Settings."));
  }
  if (type === "hd_open_external" && HOST_CAPABILITIES.externalLinkHost) {
    return failureReply(message, new Error(
      "Custom toolbar links open only from lookup popups in this overlay; the Settings preview cannot launch them.",
    ));
  }
  await sharingReady;
  if (["hd_anki_discover", "hd_anki_setup", "hd_setup_anki"].includes(type)) await sharingTransitionTail;
  if (sharingLinked && ["hd_anki_discover", "hd_anki_setup"].includes(type)) {
    try {
      if (!ankiSettingsSender(sender)) {
        throw new Error(`${type === "hd_anki_setup" ? "Anki setup discovery" : "Anki discovery"} is available only from Hachidori Settings`);
      }
      const allowed = type === "hd_anki_setup"
        ? allowLinkedAnkiSetupRequest(message) : allowLinkedAnkiDiscoveryRequest(message);
      return await getSharingClient().forward(allowed, { capability: LINKED_ANKI_CAPABILITY });
    } catch (error) {
      return failureReply(message, error);
    }
  }
  // The host owns the lookup-count rows a linked engine would otherwise prune.
  if (sharingLinked && type === "hd_lookup_stats_cleanup") return workerReply(message, {});
  if (type === "hd_options_write") {
    let error = null;
    if (!validResponseRequestId(message.requestId ?? null)) {
      error = "the options write request carried an invalid request ID";
    } else if (!responseFits(message)) {
      error = responseLimitError(type);
    }
    if (error !== null) {
      return failureReply(message, error);
    }
  }
  const invoke = async () => WORKER_HANDLERS[type](await compatibleLinkedWorkerMessage(message, sender), sender);
  if (sharingLinked && !engineSender(sender) && WORKER_FORWARDS.has(type)) {
    return forwardWorkerRequest(message).catch(error => failureReply(message, error));
  }
  // Navigation and read-only Anki discovery must not hold up storage commits.
  const run = () => [
    "hd_open_external", "hd_anki_discover", "hd_anki_setup", "hd_setup_anki", "hd_backup_download",
    "hd_lookup_stats_record", "hd_lookup_stats_read", "hd_engine_config", "hd_debug_log",
  ].includes(type) ? invoke() : serialiseStorage(invoke);
  const operation = ["hd_anki_discover", "hd_anki_setup", "hd_setup_anki"].includes(type)
    ? trackAnkiOperation(run) : run();
  return operation.then(
    async (result) => {
      if (type === "hd_backup_cas" && result.ok !== false) {
        try { await reconcileUpdateAlarm(); }
        catch (error) { result.warning = `Restored successfully; update alarm could not be refreshed: ${describeErrorOrJson(error)}`; }
      }
      return workerReply(message, result);
    },
    (error) => failureReply(message, error),
  );
}

// Update cycles relay imports back through the engine, which calls into the
// storage handlers above while committing. Keep this listener outside
// serialiseStorage() so the engine can complete that callback.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== UPDATE_TARGET) {
    return false;
  }
  handleUpdatesRequest(message).then(sendResponse, (error) => sendResponse(failureReply(message, error)));
  return true;
});

// A browser linked through the sharing bridge sends ordinary runtime messages;
// each one is answered by the handler for its target, as if a page sent it.
const SHARING_TARGET = "hachidori-sharing";

async function dispatchSharedRequest(message, clientId, capabilities = []) {
  const sender = {
    id: chrome.runtime.id,
    url: `hachidori-sharing://client/${clientId}`,
    linkedCapabilities: capabilities,
  };
  const ordinary = () => {
    if (!forwardableRequest(message)) {
      throw new Error(`unsupported shared request ${JSON.stringify(message.target)} ${JSON.stringify(message.type)}`);
    }
  };
  try {
    switch (message.target) {
      case TARGET:
        if (API_REQUESTS.has(message.type)) return await getApiHost()(message);
        ordinary();
        return await relayEngineRequest(message);
      case WORKER_TARGET:
        if (message.type === "hd_anki_discover") {
          const allowed = allowLinkedAnkiDiscoveryRequest(message);
          ankiGateway ??= createAnkiGateway();
          const options = await readAnkiOptions();
          return workerReply(allowed, await trackAnkiOperation(
            () => ankiGateway.discover({ ...options.anki, model: allowed.model }),
          ));
        }
        if (message.type === "hd_anki_setup") {
          const allowed = allowLinkedAnkiSetupRequest(message);
          const options = await readAnkiOptions();
          const config = ankiTemplateConfig(options.anki, allowed.templateId);
          if (config === null) throw new Error("The selected Anki Template is no longer available.");
          return workerReply(allowed, await trackAnkiOperation(() => checkAnkiSetup(config)));
        }
        ordinary();
        return await handleWorkerRequest(message, sender);
      case UPDATE_TARGET:
        ordinary();
        return await handleUpdatesRequest(message);
      case SETUP_TARGET:
        ordinary();
        return await handleRecommendedInstall(message, sender, true);
      case "hachidori-anki": return await trackAnkiOperation(
        () => answerAnkiRequest(allowLinkedAnkiRequest(message), sender, true),
      );
      case LINKED_IMPORT_TARGET:
        return await answerUploadRequest(allowLinkedImportRequest(message), remoteUploadOwner(clientId));
      default: throw new Error(`unsupported shared request target ${JSON.stringify(message.target)}`);
    }
  } catch (error) {
    return failureReply(message, error);
  }
}

// Settings, or an app driving this install, uploads a dictionary archive. A
// linked install sends it to the host; otherwise this one imports it.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== LINKED_IMPORT_TARGET) return false;
  sharingReady.then(() => (sharingLinked
    ? forwardToHost(allowLinkedImportRequest(message), LINKED_IMPORT_CAPABILITY)
    : answerUploadRequest(allowLinkedImportRequest(message), LOCAL_UPLOAD_OWNER)))
    .then(sendResponse, error => sendResponse(failureReply(message, error)));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== SHARING_TARGET) return false;
  const type = typeof message.type === "string" ? message.type : "";
  Promise.resolve().then(() => {
    if (!Object.hasOwn(SHARING_HANDLERS, type)) throw new Error(`unknown sharing request type ${JSON.stringify(type)}`);
    const invoke = () => SHARING_HANDLERS[type](message, sender);
    return ["hd_sharing_status", "hd_sharing_client_probe"].includes(type)
      ? sharingReady.then(invoke) : serialiseSharingTransition(invoke);
  }).then(result => sendResponse(workerReply(message, result)), error => sendResponse(failureReply(message, error)));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  sharingHost?.storageChanged(changes, area);
  if (area !== "local") return;
  const relevant = Object.keys(changes).some(key =>
    SHARED_STATE_KEYS.includes(key) || key.startsWith(LOOKUP_STATS_ROW_PREFIX) || key === SHARING_KEY);
  if (relevant && (automaticBackupWaitingForState
      || automaticBackupNextAt !== null && Date.now() >= automaticBackupNextAt)) {
    void queueAutomaticBackup();
  }
});

if (alarms === chrome.alarms) chrome.alarms.onAlarm.addListener(handleAlarm);

chrome.downloads?.onChanged?.addListener(delta => {
  if (!delta.state || delta.state.current === "in_progress") return;
  getBackupDownloads().changed(delta.id).catch(error => {
    console.warn("hoshidicts: could not release a finished backup download:", describeErrorOrJson(error));
  });
});

function warmUp() {
  void reconcileAnkiIndex();
  void queueAutomaticBackup(true);
  ensureOffscreen().catch((error) => {
    console.error("hoshidicts: could not create the offscreen document:", describeErrorOrJson(error));
  });
  reconcileUpdateAlarm().catch((error) => {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describeErrorOrJson(error));
  });
}

// A fresh installation seeds its setup state and initial preferences once, then
// opens one startup tab. Only values that are still absent are written, so a
// profile that already carries settings keeps them. Chrome reports "install"
// again on every launch for an unpacked extension loaded from the command line,
// so the absence of a setup record, not the reason alone, identifies a new
// installation.
async function beginFirstRunSetup() {
  const created = await serialiseStorage(async () => {
    const stored = await chrome.storage.local.get([SETUP_STATE_KEY, OPTIONS_KEY]);
    const values = {};
    if (stored[SETUP_STATE_KEY] === undefined) {
      values[SETUP_STATE_KEY] = initialSetupState(new Date().toISOString());
    }
    if (stored[OPTIONS_KEY] === undefined) {
      values[OPTIONS_KEY] = { ...validateOptionsPatch(FIRST_INSTALL_OPTIONS), revision: 1 };
    }
    if (Object.keys(values).length > 0) await writeLocalState(values);
    return Object.hasOwn(values, SETUP_STATE_KEY);
  });
  if (created) await chrome.tabs.create({ url: chrome.runtime.getURL(STARTUP_PAGE) });
}

// An overlay host has no tab to show setup in, so its first launch only seeds
// the initial preferences. It runs on worker start because a host may never
// report onInstalled. An unlinked profile that never chose a lookup mode, such
// as one from before overlay mode, then gets the overlay's hover default in an
// ordinary revisioned write that open Settings pages and readers adopt. A
// linked overlay composes the same default instead (composeOverlayOptions).
async function seedOverlayModeOptions() {
  await serialiseStorage(async () => {
    const stored = await chrome.storage.local.get(OPTIONS_KEY);
    if (stored[OPTIONS_KEY] !== undefined) return;
    const options = validateOptionsPatch({
      ...FIRST_INSTALL_OPTIONS,
      ...OVERLAY_MODE_OPTIONS,
      anki: overlayAnkiOptions(DEFAULT_OPTIONS).anki,
    });
    await writeLocalState({ [OPTIONS_KEY]: { ...options, revision: 1 } });
  });
  await sharingReady;
  await serialiseStorage(async () => {
    const { options } = await readDictionaryStorage();
    if (sharingLinked || withOverlayLookupDefault(options) === options) return;
    await WORKER_HANDLERS.hd_options_write({ target: WORKER_TARGET, type: "hd_options_write", requestId: null,
      baseRevision: optionsRevision(options), options: { lookupMode: OVERLAY_MODE_OPTIONS.lookupMode } });
  });
}

// Load the dictionaries before the first hover asks for them. Extension updates,
// browser starts and service-worker restarts never reach the first-run path, so
// they cannot reopen setup or reset preferences.
chrome.runtime.onInstalled.addListener((details) => {
  warmUp();
  if (details.reason !== "install" || OVERLAY_MODE) return;
  beginFirstRunSetup().catch((error) => {
    console.error("hoshidicts: could not start first-run setup:", describeErrorOrJson(error));
  });
});
chrome.runtime.onStartup.addListener(warmUp);

// Yomitan's native browser shortcuts for the features Hachidori has. The toggle
// makes the toolbar switch's revisioned write inside the storage queue.
async function toggleLookupsFromCommand() {
  await sharingReady;
  const toggle = async () => {
    const { options } = await readDictionaryStorage();
    return { target: WORKER_TARGET, type: "hd_options_write", requestId: null,
      baseRevision: optionsRevision(options), options: { hoverEnabled: !normaliseOptions(options).hoverEnabled } };
  };
  if (sharingLinked) return forwardWorkerRequest(await toggle());
  return serialiseStorage(async () => WORKER_HANDLERS.hd_options_write(await toggle()));
}

// Popup-action shortcuts run their in-page keybind action in the active tab.
// Every frame's reader receives the command; one without an open popup, or
// without a selection for the scans, does nothing. Each frame shows or hides
// its own word highlights.
const READER_CONTENT_TARGET = "hachidori-reader";
const READER_COMMANDS = new Set(["close", "addNote", "viewNotes", "playAudio", "nextEntry", "previousEntry",
  "firstEntry", "lastEntry", "nextEntryDifferentDictionary", "previousEntryDifferentDictionary", "historyBackward",
  "scanSelectedText", "scanTextAtSelection", "toggleWordHighlights", "markWordKnown", "ignoreWord"]);

chrome.commands?.onCommand?.addListener((command, tab) => {
  if (command === "openSettingsPage") {
    chrome.runtime.openOptionsPage().catch((error) => {
      console.error("hachidori: could not open settings:", describeErrorOrJson(error));
    });
  } else if (command === "toggleTextScanning") {
    toggleLookupsFromCommand().catch((error) => {
      console.error("hachidori: could not toggle lookups:", describeErrorOrJson(error));
    });
  } else if (READER_COMMANDS.has(command) && tab?.id !== undefined) {
    // Pages Chrome keeps content scripts out of, such as chrome://, have no reader.
    chrome.tabs.sendMessage(tab.id, { target: READER_CONTENT_TARGET, type: "hd_reader_command", action: command })
      .catch(() => {});
  }
});

// Alarms may be cleared across browser restarts. Module evaluation is the one
// startup path every MV3 worker takes, including starts not caused by either
// lifecycle event above.
async function initialiseUpdateAlarm() {
  try {
    await reconcileUpdateAlarm();
  } catch (error) {
    console.error("hoshidicts: could not reconcile the dictionary update alarm:", describeErrorOrJson(error));
  }
}

async function initialiseAutomaticBackupAlarm() {
  try {
    await sharingReady;
    if (sharingLinked) {
      await alarms.clear(AUTOMATIC_BACKUP_ALARM);
      return;
    }
    const stored = (await chrome.storage.local.get(AUTOMATIC_BACKUPS_KEY))[AUTOMATIC_BACKUPS_KEY];
    if (stored === undefined) {
      await queueAutomaticBackup(true);
      return;
    }
    const nextAt = nextAutomaticBackupTime(stored);
    if (Date.now() >= nextAt) await queueAutomaticBackup(true);
    else await scheduleAutomaticBackup(nextAt);
  } catch (error) {
    console.warn("hachidori: could not reconcile the automatic backup alarm:", describeErrorOrJson(error));
  }
}

sharingReady = initialiseSharing().catch((error) => {
  console.error("hachidori: could not restore sharing:", describeErrorOrJson(error));
});
void initialiseUpdateAlarm(); // NOSONAR -- top-level await prevents this MV3 worker from activating.
void initialiseAutomaticBackupAlarm(); // NOSONAR -- top-level await prevents this MV3 worker from activating.
void chrome.storage.local.get(OPTIONS_KEY).then(stored => {
  const options = normaliseOptions(stored[OPTIONS_KEY]);
  void applyCustomJavaScript(chrome, options.customPopupJavascript);
  void applyGoogleDocsFlag(chrome, options.experimental.googleDocs);
  void applyNetflixFlag(chrome, options.experimental.netflixMining);
});

if (OVERLAY_MODE) {
  seedOverlayModeOptions().catch((error) => {
    console.error("hoshidicts: could not seed overlay mode options:", describeErrorOrJson(error));
  });
}
void reconcileAnkiIndex(); // NOSONAR -- initialize without delaying worker activation.

export { alarms, sharingReady, getAnkiDuplicateIndex, WORKER_HANDLERS, getAnkiMining, dispatchSharedRequest };
