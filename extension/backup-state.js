// Complete persisted-state contract shared by the engine and storage owner.
// SPDX-License-Identifier: GPL-3.0-or-later
import "./reader-options.js";
import "./dictionary-group-state.js";
import "./word-status-overrides.js";
import {
  assertCustomSourceState, customDictionarySemanticRevision,
  normaliseCustomDictionaryDocument, parseCustomDictionary,
} from "./custom-dictionary.js";
import { assertDictionaryUpdateSchedule, assertRecommendedDictionary, normaliseUpdateSettings, recommendedDictionarySource } from "./managed-dictionary-source.js";
import { sameJsonValue } from "./json-value.js";
import { assertLookupStatsDescriptor } from "./lookup-stats.js";
import { withOverlayLookupDefault } from "./setup-state.js";

export function backupRevisions(snapshot) {
  return Object.fromEntries(["state", "options", "document", "updates", "lookupStats", "wordStatusOverrides"].map(key => {
    const revision = snapshot[key]?.revision;
    return [key, Number.isSafeInteger(revision) && revision >= 0 ? revision : 0];
  }));
}

// An overlay restores an archive that never chose a lookup mode on hover, and
// an automatic snapshot from before word status overrides restores none. The
// engine builds the snapshot once, so the storage CAS and its exact readback
// commit and verify the same values.
export function restoredBackupSnapshot(current, archived, dictionaries, { overlay = false } = {}) {
  const options = overlay ? withOverlayLookupDefault(archived.options) : archived.options;
  const restored = { ...archived, options: globalThis.HDReaderOptions.projectStoredOptions(options),
    wordStatusOverrides: globalThis.HDWordStatusOverrides.normaliseWordStatusOverrides(archived.wordStatusOverrides) };
  return Object.fromEntries(Object.entries(backupRevisions(current)).map(([key, revision]) => [key, {
    ...restored[key],
    ...(key === "state" ? { dictionaries } : {}),
    ...(key === "lookupStats" ? { generation: crypto.randomUUID() } : {}),
    revision: revision + 1,
  }]));
}

function assertDictionaryList(dictionaries) {
  const ids = new Set(), titles = new Set();
  for (const entry of dictionaries) {
    assertDictionaryUpdateSchedule(entry);
    if (typeof entry?.id !== "string" || entry.id === "" || ids.has(entry.id)
        || typeof entry.title !== "string" || entry.title === "" || titles.has(entry.title)
        || typeof entry.revision !== "string"
        || typeof entry.enabled !== "boolean" || typeof entry.favorite !== "boolean"
        || (entry.displayName !== null && typeof entry.displayName !== "string")
        || ["termCount", "frequencyCount", "pitchCount", "kanjiCount", "mediaCount"].some(key =>
          !Number.isSafeInteger(entry[key]) || entry[key] < 0)) {
      throw new Error("The backup contains invalid or duplicate dictionary packages.");
    }
    const recommended = recommendedDictionarySource(entry.sourceId);
    if (recommended) {
      assertRecommendedDictionary(recommended, entry);
      if (entry.downloadUrl !== recommended.downloadUrl) {
        throw new Error("The backup dictionary does not match its recommended source.");
      }
    }
    ids.add(entry.id);
    titles.add(entry.title);
  }
}

function assertGroups(groups, dictionaries) {
  const { normaliseDictionaryGroups, groupNameKey } = globalThis.HDDictionaryGroups;
  if (!Array.isArray(groups) || !sameJsonValue(groups, normaliseDictionaryGroups(groups, dictionaries))) {
    throw new Error("The backup contains invalid dictionary groups.");
  }
  const ids = new Set(), names = new Set(["all"]);
  for (const group of groups) {
    const key = groupNameKey(group.name);
    if (ids.has(group.id) || names.has(key)) throw new Error("The backup contains duplicate dictionary groups.");
    ids.add(group.id);
    names.add(key);
  }
}

function projectBackupReaderSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const { revision, ...options } = settings;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  const { DEFAULT_OPTIONS, RETIRED_OPTION_KEYS } = globalThis.HDReaderOptions;
  const allowed = new Set([...Object.keys(DEFAULT_OPTIONS), ...RETIRED_OPTION_KEYS]);
  if (Object.keys(options).some(key => !allowed.has(key))) return null;
  // Each release writes its own complete flag set. Like the stored record, an
  // archived one keeps its known flags, starts newer flags off and drops
  // retired ones; a non-boolean flag remains invalid.
  const { experimental } = options;
  if (experimental && typeof experimental === "object" && !Array.isArray(experimental)
      && Object.values(experimental).every(value => typeof value === "boolean")) {
    options.experimental = globalThis.HDReaderOptions.normaliseExperimental(experimental);
  }
  let projected;
  try {
    projected = globalThis.HDReaderOptions.validateOptionsPatch(options);
  } catch {
    return null;
  }
  // A legacy backup may have only `customLinks`, and its singleton Anki
  // object has no `templates`. If the richer fields are present, however, they
  // must already be canonical instead of relying on migration to resolve two
  // conflicting representations.
  if (Object.hasOwn(options, "customButtons") && Object.hasOwn(options, "customLinks")
      && !sameJsonValue(options.customLinks, projected.customLinks)) return null;
  if (options.anki && Object.hasOwn(options.anki, "templates")
      && !sameJsonValue(options.anki, projected.anki)) return null;
  return { ...projected, revision };
}

function validBackupUpdateSettings(settings) {
  return Number.isSafeInteger(settings?.revision) && settings.revision >= 0
    && sameJsonValue(settings, normaliseUpdateSettings(settings));
}

// A backup from any version restores its dictionaries. Its settings are read
// one by one like a stored record: a setting this version does not know or
// cannot read is skipped, and one the backup lacks keeps its default (#577).
// Selectors are pruned against the restored library before the storage CAS.
export async function prepareBackupSnapshot(archived) {
  await assertBackupSnapshot(archived, { allowInvalidSettings: true });
  const { normaliseDictionarySelections, projectStoredOptions } = globalThis.HDReaderOptions;
  const projected = projectStoredOptions(archived.options);
  const options = normaliseDictionarySelections(projected, archived.state.dictionaries, archived.state.groups);
  // A legacy clicked-kanji title migrates to `{ title, kind }`; only a
  // selection that becomes Automatic was reset.
  const reset = ["frequencyDictionary", "kanjiClickDictionary"].some(key => projected[key] && !options[key]);
  return {
    snapshot: { ...archived, options: { ...options, revision: backupRevisions(archived).options },
      updates: normaliseUpdateSettings(archived.updates) },
    warning: reset ? "Unavailable dictionary selections were reset." : null,
  };
}

export async function assertBackupSnapshot(snapshot, { allowInvalidSettings = false } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || ["state", "document"].some(key =>
        !Number.isSafeInteger(snapshot[key]?.revision) || snapshot[key].revision < 0)
      || snapshot.state?.schemaVersion !== 1 || !Array.isArray(snapshot.state.dictionaries)) {
    throw new Error("The backup contains invalid dictionary state.");
  }
  assertDictionaryList(snapshot.state.dictionaries);
  assertLookupStatsDescriptor(snapshot.lookupStats);
  assertGroups(snapshot.state.groups, snapshot.state.dictionaries);
  const document = normaliseCustomDictionaryDocument(snapshot.document);
  const entries = parseCustomDictionary(document.text).entries;
  const semanticRevision = await customDictionarySemanticRevision(entries);
  if (document.semanticRevision !== semanticRevision) throw new Error("The backup custom source has invalid semantics.");
  assertCustomSourceState(snapshot.state.dictionaries, semanticRevision, entries.length);
  if (!allowInvalidSettings && projectBackupReaderSettings(snapshot.options) === null) {
    throw new Error("The backup contains invalid reader settings.");
  }
  if (!allowInvalidSettings && !validBackupUpdateSettings(snapshot.updates)) {
    throw new Error("The backup contains invalid update settings.");
  }
  // Absent from automatic snapshots taken before overrides existed.
  if (snapshot.wordStatusOverrides !== undefined && !sameJsonValue(snapshot.wordStatusOverrides,
    globalThis.HDWordStatusOverrides.normaliseWordStatusOverrides(snapshot.wordStatusOverrides))) {
    throw new Error("The backup contains invalid word status overrides.");
  }
}
