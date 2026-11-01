// The requests the service worker answers itself (WORKER_HANDLERS), recommended installs and requests
// from linked browsers, and the Anki gateway, mining service and duplicate index they create on first use.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { readDebugLog } from "./debug-log.js";
import { describeErrorOrJson } from "./error-text.js";
import { createAnkiGateway } from "./anki.js";
import { detectAnkiSetup, verifyAnkiSetup } from "./anki-setup.js";
import { createAnkiWorkerService } from "./anki-worker.js";
import { detectLocalAudioSource } from "./local-audio-setup.js";
import { createLocalAudioSource, findLocalAudioSource } from "./local-audio-source.js";
import { lookupAnkiIndex, lookupAnkiIndexMany } from "./anki-index.js";
import { ANKI_INDEX_KEY, createAnkiDuplicateIndex } from "./anki-index-cache.js";
import { assertBackupSnapshot, backupRevisions } from "./backup-state.js";
import { AUTOMATIC_BACKUPS_KEY, automaticBackupStore, validAutomaticBackups } from "./backup-automatic.js";
import { API_REQUESTS } from "./api-host.js";
import { SHARING_LOCAL_STATE_KEY } from "./sharing-client.js";
import {
  LINKED_ANKI_CAPABILITY, LINKED_IMPORT_TARGET, allowLinkedAnkiDiscoveryRequest, allowLinkedAnkiRequest,
  allowLinkedAnkiSetupRequest, allowLinkedImportRequest, forwardableRequest,
} from "./sharing-protocol.js";
import {
  LOOKUP_STATS_KEY, assertLookupStatsDescriptor, assertLookupStatsRows, emptyLookupStats,
  incrementLookupStats, lookupStatsKey, lookupStatsLanguageView, normaliseLookupTerm, resetLookupStats,
  unreachableLookupStatsKeys, withLookupStatsGeneration, withoutLookupStatsLanguage,
} from "./lookup-stats.js";
import { installedRecommendedDictionary, recommendedDictionarySource } from "./managed-dictionary-source.js";
import {
  CUSTOM_DICTIONARY_SOURCE_KEY, CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION, EMPTY_CUSTOM_DICTIONARY_SEMANTIC_REVISION,
  assertCustomDictionaryCommit, assertCustomSourceState, customDictionaryDocumentFor, customDictionarySemanticRevision,
  normaliseCustomDictionaryDocument, parseCustomDictionary, personalDictionaryIdentity, personalDictionaryLanguage,
  withCustomDictionaryDocument,
} from "./custom-dictionary.js";
import {
  dictionaryStateWithProfiles, dictionaryStateWithoutProfiles, newProfileSettings, optionsWithProfiles,
  optionsWithoutProfiles, packSettingDefaults, singleProfileShape,
} from "./profile-state.js";
import { sameJsonValue } from "./json-value.js";
import { responseFits, responseLimitError, validResponseRequestId } from "./response-limits.js";
import { HOST_CAPABILITIES } from "./overlay-mode.js";
import {
  FIRST_INSTALL_SELECTIONS, SETUP_STATE_KEY, STARTUP_PAGE, RECOMMENDED_SELECTIONS_KEY, advanceSetupState,
  normaliseSetupState, recordSetupAnki, recordSetupDictionaries,
} from "./setup-state.js";
import {
  ankiTemplateConfig, normaliseOptions, projectStoredOptions, validateOptionsPatch, normaliseExternalUrl,
  pruneGroupMemberships, WORD_STATUS_OVERRIDES_KEY, normaliseWordStatusOverrides,
  OFFSCREEN_DOCUMENT, TARGET, UPDATE_TARGET, SETUP_TARGET, WORKER_TARGET, DICTIONARY_STATE_KEY, OPTIONS_KEY,
  UPDATE_SETTINGS_KEY, engineSender, ankiSettingsSender, writeLocalState, relay, readDictionaryStorage,
  normaliseDictionarySelections, assertDictionaryState, assertOrdinaryCustomTransition,
  assertCustomDictionaryCasRequest, dictionaryCommit, optionsRevision, removeLegacyDictionaryRows, startupSender,
  optionsWriteResult, serialiseStorage, workerReply, failureReply, JAPANESE_PROFILE_ID, NO_JAPANESE_PROFILE, PROFILE_REMOVED,
  hasProfiles, hasDictionaryProfiles, optionProfiles, applyOptionsPatch, projectDictionaryState, profileError,
  requestProfileId, profileLanguages, assertPersonalPlacement, assertOrdinaryPersonalTransition,
  assertProfileDictionaryState, profileDictionaryCommit,
  profileViewCommit, languageDescriptor, LANGUAGE_SELECTION_KEY, normaliseLanguageSelection,
} from "./background-core.js";
import { trackAnkiOperation, readAnkiOptions, sendAnkiRequest, answerAnkiRequest } from "./background-anki.js";
import {
  getBackupDownloads, assertBackupEngineSender, readBackupPayload, automaticBackupSummary, relayEngineRequest,
} from "./background-backup.js";
import { reconcileUpdateAlarm, handleUpdatesRequest } from "./background-updates.js";
import {
  remoteUploadOwner, answerUploadRequest, getApiHost, sharingLinked, sharingTransitionTail, WORKER_FORWARDS,
  stateStore, getSharingClient, forwardToHost, compatibleLinkedWorkerMessage, forwardWorkerRequest,
} from "./background-sharing.js";
import { alarms, sharingReady } from "./background.js";

let ankiGateway, ankiMining, ankiDuplicateIndex;

// One first-run Anki detection at a time; duplicate startup pages share it.
let ankiSetupDetection = null;

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

// The engine or settings page reads state, changes it, and sends it back a
// message round trip later. A caller includes the revision it read so a stale
// write cannot discard a change made by another extension context.
async function lookupStatisticsStorage(message, record) {
  const term = normaliseLookupTerm(message.term, message.reading);
  const stored = await chrome.storage.local.get([LOOKUP_STATS_KEY, OPTIONS_KEY]);
  let descriptor = stored[LOOKUP_STATS_KEY] === undefined ? emptyLookupStats() : stored[LOOKUP_STATS_KEY];
  assertLookupStatsDescriptor(descriptor);
  const storedOptions = stored[OPTIONS_KEY];
  if (hasProfiles(storedOptions) || descriptor.languages !== undefined) {
    return languageLookupStatistics(message, record, term, descriptor, storedOptions);
  }
  if (message.profileId !== undefined) requestProfileId(message, storedOptions);
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

// Counts of the language of the profile a request is for (docs/languages.md
// 4.3): rows keep their key under that language's generation, and the
// language's first row creates its generation in the same write.
async function languageLookupStatistics(message, record, term, descriptor, storedOptions) {
  const profileId = message.profileId === undefined && !optionProfiles(storedOptions).some(profile => profile.id === JAPANESE_PROFILE_ID)
    ? null : requestProfileId(message, storedOptions);
  const language = profileId === null ? JAPANESE_PROFILE_ID : profileLanguages(storedOptions).get(profileId);
  if (globalThis.HDReaderOptions.projectOptions(storedOptions, profileId ?? JAPANESE_PROFILE_ID).showLookupCounts === false) {
    return { descriptor, statistics: null };
  }
  const view = lookupStatsLanguageView(descriptor, language);
  const key = lookupStatsKey(view, term);
  let row = view.generation === null ? undefined : (await chrome.storage.local.get(key))[key];
  if (record) {
    row = incrementLookupStats(row, term, Date.now());
    descriptor = view.generation === null ? withLookupStatsGeneration(descriptor, language, crypto.randomUUID())
      : { ...descriptor, revision: descriptor.revision + 1 };
    assertLookupStatsDescriptor(descriptor);
    await writeLocalState({ [LOOKUP_STATS_KEY]: descriptor, [lookupStatsKey(lookupStatsLanguageView(descriptor, language), term)]: row });
  } else if (row !== undefined) {
    assertLookupStatsRows(view, [row]);
    if (lookupStatsKey(view, row) !== key) throw new Error("The lookup statistics row does not match its key.");
  }
  return { descriptor, statistics: row ?? { ...term, lookupCount: 0 } };
}

function lookupStatistics(message, record) {
  return serialiseStorage(
    () => lookupStatisticsStorage(message, record),
  );
}

// Rows outside the committed descriptor's live generations are unreachable.
async function removeObsoleteLookupStatsRows() {
  const stored = await chrome.storage.local.get(null);
  const descriptor = stored[LOOKUP_STATS_KEY] === undefined ? emptyLookupStats() : stored[LOOKUP_STATS_KEY];
  assertLookupStatsDescriptor(descriptor);
  const unused = unreachableLookupStatsKeys(Object.keys(stored), descriptor);
  if (unused.length > 0) await chrome.storage.local.remove(unused);
}

// The language of the profile a request names (docs/languages.md 5.4).
async function requestLanguage(message, store = chrome.storage.local) {
  const storedOptions = (await store.get(OPTIONS_KEY))[OPTIONS_KEY];
  return profileLanguages(storedOptions).get(requestProfileId(message, storedOptions));
}

// The language a personal-dictionary request is for: the engine names it, a
// page names its profile, and a request that names neither means Japanese.
function customRequestLanguage(message, storedOptions) {
  if (message.language !== undefined) {
    if (typeof message.language !== "string" || !/^[a-z]{2,3}$/u.test(message.language)) {
      throw new TypeError("the custom dictionary request named an invalid language");
    }
    return message.language;
  }
  if (message.profileId !== undefined) return profileLanguages(storedOptions).get(requestProfileId(message, storedOptions));
  return JAPANESE_PROFILE_ID;
}

// A schema-2 state body as a stored state, so it can be projected.
function profileStateOf(body, revision) {
  return { schemaVersion: 2, revision, dictionaries: body.dictionaries, profiles: body.profiles };
}

// The engine's commit of a whole schema-2 record (docs/languages.md 5.2):
// import, reimport, managed update, removal and reconciliation. Every
// profile's selections are pruned against its own packages and groups.
async function wholeStateCas(message, store) {
  const { state: current, options: currentOptions } = await readDictionaryStorage(false, store);
  assertDictionaryState(current);
  if (message.baseRevision !== (current?.revision ?? 0)) {
    return { ok: false, conflict: true, error: "the dictionary state changed while it was being written", state: current };
  }
  if (!hasProfiles(currentOptions) || !hasDictionaryProfiles(current)) {
    throw new Error("the dictionary state write carried profiles this installation does not have");
  }
  assertProfileDictionaryState(message.state, currentOptions);
  try {
    assertOrdinaryPersonalTransition(current, profileStateOf(message.state, current.revision), profileLanguages(currentOptions));
  } catch (error) {
    return { ok: false, protected: true, error: describeErrorOrJson(error), state: current };
  }
  const { state, values } = profileDictionaryCommit(current, currentOptions, message.state);
  await writeLocalState(values, store);
  return { state };
}

const PROFILE_RECORD_KEYS = [OPTIONS_KEY, DICTIONARY_STATE_KEY, CUSTOM_DICTIONARY_SOURCE_KEY, LOOKUP_STATS_KEY,
  WORD_STATUS_OVERRIDES_KEY, LANGUAGE_SELECTION_KEY, SETUP_STATE_KEY];

// The options a profile request leaves: a profile added after the ones there
// are, copying the settings of `copyFrom` (section 6.3), or the only profile
// at first run, holding the stored profile keys; or a profile removed.
function profileRequestOptions(message, stored, language) {
  const storedOptions = stored[OPTIONS_KEY];
  if (message.action === "add") {
    const descriptor = languageDescriptor(language);
    if (descriptor === null) throw profileError(`This Hachidori has no pack for ${language}.`, "language-unknown");
    const added = source => ({ id: language, language, settings: newProfileSettings(source.settings, descriptor),
      packSettings: packSettingDefaults(descriptor) });
    if (message.firstRun === true) {
      // Still at the start (section 16.1): unlinked, setup at its welcome card,
      // the single-profile shape and no packages, judged on this snapshot.
      const setup = normaliseSetupState(stored[SETUP_STATE_KEY]);
      if (hasProfiles(storedOptions) || setup?.stage !== "welcome"
          || (stored[DICTIONARY_STATE_KEY]?.dictionaries?.length ?? 0) > 0) {
        throw profileError(`Hachidori is already set up. Add ${descriptor.name} in Settings.`, "already-set-up");
      }
      return { ...optionsWithProfiles(storedOptions), profiles: [added(optionProfiles(storedOptions)[0])] };
    }
    const record = optionsWithProfiles(storedOptions);
    if (record.profiles.some(profile => profile.language === language)) {
      throw profileError(`${descriptor.name} is already one of your languages.`, "language-present");
    }
    const source = record.profiles.find(profile => profile.id === (message.copyFrom ?? JAPANESE_PROFILE_ID));
    if (source === undefined) throw profileError("The language to copy settings from was removed.", "profile-missing");
    return { ...record, profiles: [...record.profiles, added(source)] };
  }
  if (message.action !== "remove") throw new Error("unknown profile request");
  if (!hasProfiles(storedOptions)) throw new Error("The last language cannot be removed.");
  const record = applyOptionsPatch(storedOptions, {});
  if (message.profileId === undefined) {
    // Erasing a held language that has no profile.
    if (record.profiles.some(profile => profile.language === language)) throw new Error("Remove the language before erasing it.");
    return record;
  }
  if (!record.profiles.some(profile => profile.id === message.profileId)) {
    throw profileError(PROFILE_REMOVED, "profile-missing");
  }
  if (record.profiles.length === 1) throw new Error("The last language cannot be removed.");
  return { ...record, profiles: record.profiles.filter(profile => profile.id !== message.profileId) };
}

// The worker side of hd_profile_add and hd_profile_remove (docs/languages.md
// 5.2 and 16.5): options and dictionaryState in one compare-and-set against
// the dictionary state the engine read (and, for an erase, the language's
// personal document). The options are derived here, inside the storage
// queue, so an unrelated options write cannot make the request conflict; so
// are an erase's count descriptor and marks. When the result is the
// single-profile shape, the records convert back and `languageSelection` goes.
async function profileCas(message) {
  const stored = await chrome.storage.local.get(PROFILE_RECORD_KEYS);
  const current = stored[DICTIONARY_STATE_KEY] ?? null;
  assertDictionaryState(current);
  if (!Number.isInteger(message.baseRevision) || message.baseRevision < 0) {
    throw new Error("the language request carried no valid base revision");
  }
  if (message.baseRevision !== (current?.revision ?? 0)) {
    return { ok: false, conflict: true, error: "the dictionary state changed while the language was being changed", state: current };
  }
  const named = message.profileId === undefined ? null : profileLanguages(stored[OPTIONS_KEY]).get(message.profileId);
  const language = message.action === "remove" && named !== undefined && named !== null ? named : message.language;
  if (typeof language !== "string" || !/^[a-z]{2,3}$/u.test(language)) throw new TypeError("the language request named no language");
  const existing = optionProfiles(stored[OPTIONS_KEY]);
  // A first-run choice whose reply was lost is already the only profile.
  if (message.action === "add" && message.firstRun === true && hasProfiles(stored[OPTIONS_KEY])
      && existing.length === 1 && existing[0].language === language) {
    return { state: current, converted: false, languages: [language] };
  }
  const options = profileRequestOptions(message, stored, language);
  const languages = profileLanguages(options);
  assertProfileDictionaryState(message.state, options);
  const revision = (current?.revision ?? 0) + 1;
  const state = profileStateOf(message.state, revision);
  assertPersonalPlacement(state, languages);
  // A language request changes no package; an erase removes the language's
  // personal package and nothing else.
  const before = new Map(dictionaryStateWithProfiles(current).dictionaries.map(row => [row.id, row]));
  const personal = personalDictionaryIdentity(language);
  if (state.dictionaries.some(row => !sameJsonValue(before.get(row.id), row))) {
    throw new Error("adding or removing a language changes no dictionary");
  }
  const kept = new Set(state.dictionaries.map(row => row.id));
  if ([...before.keys()].some(id => !kept.has(id) && !(message.erase === true && id === personal?.id))) {
    throw new Error("adding or removing a language removes no dictionary");
  }
  let document = stored[CUSTOM_DICTIONARY_SOURCE_KEY];
  let lookupStats = stored[LOOKUP_STATS_KEY] ?? emptyLookupStats();
  let marks = stored[WORD_STATUS_OVERRIDES_KEY];
  const values = {};
  if (message.erase === true) {
    const languageDocument = customDictionaryDocumentFor(document, language);
    if (message.baseDocumentRevision !== languageDocument.revision) {
      return { ok: false, stale: true, error: "The personal dictionary changed after you confirmed, so it was kept. Review it and try again.",
        document: languageDocument, state: current };
    }
    if (state.dictionaries.some(row => row.id === personal?.id)) throw new Error("an erase removes the personal dictionary");
    document = withCustomDictionaryDocument(document, language, { schemaVersion: CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION,
      revision: languageDocument.revision + 1, semanticRevision: EMPTY_CUSTOM_DICTIONARY_SEMANTIC_REVISION, text: "" });
    assertLookupStatsDescriptor(lookupStats);
    lookupStats = withoutLookupStatsLanguage(lookupStats, language);
    const { normaliseWordStatusOverrides: normaliseMarks, withLanguageWordStatusOverrides } = globalThis.HDWordStatusOverrides;
    marks = withLanguageWordStatusOverrides(marks, language,
      { revision: normaliseMarks(marks).revision + 1, known: [], ignored: [] });
    Object.assign(values, { [CUSTOM_DICTIONARY_SOURCE_KEY]: document, [LOOKUP_STATS_KEY]: lookupStats, [WORD_STATUS_OVERRIDES_KEY]: marks });
  }
  const converted = singleProfileShape({ options, state, document, lookupStats, wordStatusOverrides: marks });
  values[OPTIONS_KEY] = { ...(converted ? optionsWithoutProfiles(options) : options), revision: optionsRevision(stored[OPTIONS_KEY]) + 1 };
  values[DICTIONARY_STATE_KEY] = converted ? dictionaryStateWithoutProfiles(state) : state;
  const removals = [];
  if (converted) {
    // The single-profile shape has no `languages` maps (section 4.5).
    const top = normaliseCustomDictionaryDocument(document);
    if (document !== undefined && document !== null) {
      if (top.revision === 0 && top.text === "") removals.push(CUSTOM_DICTIONARY_SOURCE_KEY);
      else values[CUSTOM_DICTIONARY_SOURCE_KEY] = top;
    }
    if (stored[LANGUAGE_SELECTION_KEY] !== undefined) removals.push(LANGUAGE_SELECTION_KEY);
  }
  for (const key of removals) delete values[key];
  await writeLocalState(values);
  if (removals.length > 0) await chrome.storage.local.remove(removals);
  if (message.erase === true) {
    try {
      await removeObsoleteLookupStatsRows();
    } catch (error) {
      console.warn("hachidori: the language was erased; its lookup counts could not be removed yet:", describeErrorOrJson(error));
    }
  }
  return { state: values[DICTIONARY_STATE_KEY], converted, ...(converted ? {} : { languages: [...new Set(languages.values())] }) };
}

// hd_custom_cas on a record with profiles, or for a language other than
// Japanese (docs/languages.md 15): the language's document, its personal
// package's rules checked in every profile of the language, the other
// languages' documents and packages kept.
async function languageCustomCas(message, store, read) {
  const { state: current, options: currentOptions, customDocument: storedDocument } = read;
  if (!hasProfiles(currentOptions)) throw new Error("This language has no profile on this Hachidori.");
  const language = customRequestLanguage(message, currentOptions);
  const languages = profileLanguages(currentOptions);
  if (![...languages.values()].includes(language)) {
    throw language === JAPANESE_PROFILE_ID ? profileError(NO_JAPANESE_PROFILE, "no-japanese-profile")
      : profileError(PROFILE_REMOVED, "profile-missing");
  }
  const identity = personalDictionaryIdentity(language);
  if (identity === null) throw new Error("This Hachidori has no personal dictionary for this language.");
  const document = customDictionaryDocumentFor(storedDocument, language);
  if (message.baseDocumentRevision !== document.revision) {
    return { ok: false, stale: true, error: "the custom dictionary source changed while it was being saved", document, state: current };
  }
  if (message.baseRevision !== (current?.revision ?? 0)) {
    return { ok: false, conflict: true, error: "the dictionary state changed while the custom dictionary was being saved",
      document, state: current };
  }
  const parsed = parseCustomDictionary(message.text, identity);
  const calculatedRevision = await customDictionarySemanticRevision(parsed.entries, identity);
  if (calculatedRevision !== message.semanticRevision) {
    throw new Error("the custom dictionary semantic revision does not match its source");
  }
  const next = message.state === undefined ? current : profileStateOf(message.state, current.revision);
  if (message.state !== undefined) {
    assertProfileDictionaryState(message.state, currentOptions);
    // Only this language's personal package may change here.
    for (const row of [...(current?.dictionaries ?? []), ...next.dictionaries]) {
      const owner = personalDictionaryLanguage(row);
      if (owner === null || owner === language) continue;
      const before = current.dictionaries.find(entry => entry.id === row.id);
      const after = next.dictionaries.find(entry => entry.id === row.id);
      if (!before || !after || !sameJsonValue(before, after)) {
        throw new Error("the managed custom dictionary can only be changed by its source editor");
      }
    }
    assertPersonalPlacement(next, languages);
  }
  const rows = next.dictionaries.filter(row => row.id === identity.id);
  if (parsed.entries.length === 0 ? rows.length !== 0 : rows.length !== 1) {
    throw new Error("the custom dictionary package does not match its source semantics");
  }
  for (const [profileId, profileLanguage] of languages) {
    if (profileLanguage !== language) continue;
    assertCustomSourceState(projectDictionaryState(next, profileId).dictionaries, calculatedRevision, parsed.entries.length, identity);
  }
  const documentChanged = document.text !== message.text || document.semanticRevision !== message.semanticRevision;
  const nextDocument = documentChanged
    ? { schemaVersion: CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION, revision: document.revision + 1,
      semanticRevision: message.semanticRevision, text: message.text }
    : document;
  let state = current;
  const values = {};
  if (documentChanged) values[CUSTOM_DICTIONARY_SOURCE_KEY] = withCustomDictionaryDocument(storedDocument, language, nextDocument);
  if (message.state !== undefined && !sameJsonValue({ dictionaries: current.dictionaries, profiles: current.profiles }, message.state)) {
    const commit = profileDictionaryCommit(current, currentOptions, message.state);
    state = commit.state;
    Object.assign(values, commit.values);
  }
  if (Object.keys(values).length > 0) await writeLocalState(values, store);
  return { document: nextDocument, state };
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
  // A request names the profile whose language the headword belongs to; the
  // other languages' marks are kept (docs/languages.md 4.3).
  async hd_word_status_override(message) {
    const language = message.profileId === undefined ? JAPANESE_PROFILE_ID : await requestLanguage(message);
    const stored = (await chrome.storage.local.get(WORD_STATUS_OVERRIDES_KEY))[WORD_STATUS_OVERRIDES_KEY];
    const { withLanguageWordStatusOverride } = globalThis.HDWordStatusOverrides;
    const next = withLanguageWordStatusOverride(stored, language, message.headword, message.status);
    if (next !== stored) await writeLocalState({ [WORD_STATUS_OVERRIDES_KEY]: next });
    return { revision: normaliseWordStatusOverrides(next).revision };
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
    // A restore that yields the single-profile shape removes the
    // installation-local language choice (docs/languages.md 4.4).
    if (!hasProfiles(snapshot.options)) {
      const selection = (await chrome.storage.local.get(LANGUAGE_SELECTION_KEY))[LANGUAGE_SELECTION_KEY];
      if (selection !== undefined) await chrome.storage.local.remove(LANGUAGE_SELECTION_KEY);
    }
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

  // Once the records have profiles, the reply also carries their language
  // codes, which the engine loads the packs of (docs/languages.md 9.2).
  async hd_state_read(message, sender) {
    const { state, legacyDictionaries, options } = await readDictionaryStorage(false, stateStore(sender));
    if (!hasProfiles(options)) return { state, legacyDictionaries };
    return { state, legacyDictionaries, languages: [...new Set(profileLanguages(options).values())] };
  },

  async hd_state_cas(message, sender) {
    const store = stateStore(sender);
    if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
      throw new Error("the dictionary state write request carried no valid base revision");
    }
    // The engine's own commits write the whole schema-2 record.
    if (message?.state !== undefined) return wholeStateCas(message, store);
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
    if (hasProfiles(currentOptions)) {
      let commit;
      try {
        commit = profileViewCommit(message, current, currentOptions);
      } catch (error) {
        if (error?.code !== undefined) throw error;
        return { ok: false, protected: true, error: describeErrorOrJson(error), state: current };
      }
      await writeLocalState(commit.values, store);
      return { state: commit.state };
    }
    if (message.profileId !== undefined) requestProfileId(message, currentOptions);

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
    const { state, options, customDocument } = await readDictionaryStorage(true, stateStore(sender));
    assertDictionaryState(state);
    return {
      document: customDictionaryDocumentFor(customDocument, customRequestLanguage(message, options)),
      state,
    };
  },

  async hd_custom_cas(message, sender) {
    const store = stateStore(sender);
    const changesDictionaryState = message?.state === undefined ? assertCustomDictionaryCasRequest(message)
      : assertCustomDictionaryCasRequest({ ...message, state: undefined, dictionaries: undefined, groups: undefined });

    const read = await readDictionaryStorage(true, store);
    const {
      state: current,
      legacyDictionaries,
      options: currentOptions,
      customDocument: storedDocument,
    } = read;
    assertDictionaryState(current);
    if (hasProfiles(currentOptions) || message.state !== undefined
        || (message.language !== undefined && message.language !== JAPANESE_PROFILE_ID)
        || (message.profileId !== undefined && message.profileId !== JAPANESE_PROFILE_ID)) {
      return languageCustomCas(message, store, read);
    }
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

  // The one compare-and-set of hd_profile_add and hd_profile_remove
  // (docs/languages.md 5.2), asked by the engine under its mutation lock.
  async hd_profile_cas(message, sender) {
    if (!engineSender(sender)) throw new Error("Languages are added and removed only by the dictionary engine.");
    if (sharingLinked) throw new Error("Add and remove languages on the linked Hachidori.");
    return profileCas(message);
  },

  // The installation-local active profile and automatic switching (section
  // 4.4). Never forwarded to a sharing host: each browser chooses its own.
  async hd_language_selection_write(message) {
    const stored = await chrome.storage.local.get([LANGUAGE_SELECTION_KEY, OPTIONS_KEY]);
    if (!hasProfiles(stored[OPTIONS_KEY])) throw new Error("Add a second language before choosing one.");
    if (!Number.isInteger(message.baseRevision) || message.baseRevision < 0) {
      throw new Error("the language selection write carried no valid base revision");
    }
    const current = normaliseLanguageSelection(stored[LANGUAGE_SELECTION_KEY]);
    if (message.baseRevision !== current.revision) {
      return { ok: false, conflict: true, error: "The language changed in another page.", selection: current };
    }
    if (message.activeProfileId !== undefined
        && !optionProfiles(stored[OPTIONS_KEY]).some(profile => profile.id === message.activeProfileId)) {
      throw profileError(PROFILE_REMOVED, "profile-missing");
    }
    if (message.autoSwitch !== undefined && typeof message.autoSwitch !== "boolean") {
      throw new TypeError("the language selection write carried an invalid automatic switch");
    }
    const next = { revision: current.revision + 1, activeProfileId: message.activeProfileId ?? current.activeProfileId,
      autoSwitch: message.autoSwitch ?? current.autoSwitch };
    if (stored[LANGUAGE_SELECTION_KEY] !== undefined && next.activeProfileId === current.activeProfileId
        && next.autoSwitch === current.autoSwitch) return { selection: current };
    await writeLocalState({ [LANGUAGE_SELECTION_KEY]: next });
    return { selection: next };
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
      const japaneseMissing = hasProfiles(current[OPTIONS_KEY])
        && !optionProfiles(current[OPTIONS_KEY]).some(profile => profile.id === JAPANESE_PROFILE_ID);
      if (Object.keys(patch).length > 0 && !japaneseMissing) {
        const revision = optionsRevision(current[OPTIONS_KEY]);
        // Kiku, Lapis, Senren and Local Audio Server are Japanese: setup
        // writes the Japanese profile (docs/languages.md 5.2).
        values[OPTIONS_KEY] = hasProfiles(current[OPTIONS_KEY])
          ? { ...applyOptionsPatch(current[OPTIONS_KEY], validateOptionsPatch(patch), JAPANESE_PROFILE_ID), revision: revision + 1 }
          : {
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
  if (hasProfiles(storedOptions)) {
    // Jitendex and Bee's Ultimate Kanji Dictionary are the Japanese profile's.
    if (!optionProfiles(storedOptions).some(profile => profile.id === JAPANESE_PROFILE_ID)) return { applied, options: null };
    const view = projectDictionaryState(dictionaryState, JAPANESE_PROFILE_ID) ?? { dictionaries: [], groups: [] };
    const record = applyOptionsPatch(storedOptions, validateOptionsPatch(patch), JAPANESE_PROFILE_ID);
    const options = { ...record, profiles: record.profiles.map(profile => profile.id !== JAPANESE_PROFILE_ID ? profile
      : { ...profile, settings: normaliseDictionarySelections(profile.settings, view.dictionaries, view.groups) }) };
    return { applied, options: sameJsonValue(options, { ...storedOptions, revision }) ? null : { ...options, revision: revision + 1 } };
  }
  const options = normaliseDictionarySelections(
    { ...projectStoredOptions(storedOptions), ...validateOptionsPatch(patch), revision }, dictionaries, dictionaryState?.groups ?? [],
  );
  return { applied, options: sameJsonValue(options, { ...storedOptions, revision }) ? null : { ...options, revision: revision + 1 } };
}

function getAnkiMining() {
  if (!ankiMining) {
    const send = sendAnkiRequest;
    ankiGateway ??= createAnkiGateway();
    ankiMining = createAnkiWorkerService({ gateway: ankiGateway,
      readOptions: readAnkiOptions,
      duplicateIndex: getAnkiDuplicateIndex(),
      // The dictionaries of the profile a note is for (docs/languages.md 5.4).
      readDictionaries: async profileId => {
        const { state } = await readDictionaryStorage();
        return (hasDictionaryProfiles(state) ? projectDictionaryState(state, profileId ?? JAPANESE_PROFILE_ID)?.dictionaries
          : state?.dictionaries) ?? [];
      },
      engine: fields => send(TARGET, fields), offscreen: fields => send("hachidori-anki-render", fields),
    });
  }
  return ankiMining;
}

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

async function handleWorkerRequest(message, sender) { // NOSONAR: moved verbatim (#533)
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.prototype.hasOwnProperty.call(WORKER_HANDLERS, type)) { // NOSONAR: moved verbatim (#533)
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

export {
  getAnkiDuplicateIndex, WORKER_HANDLERS, getAnkiMining, handleRecommendedInstall, handleWorkerRequest,
  SHARING_TARGET, dispatchSharedRequest,
};
