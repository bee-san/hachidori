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

// Reader settings can change between releases without invalidating dictionary
// files. Keep the local settings when the archived record cannot be imported;
// prune selectors against the restored library before the exact storage CAS.
export async function prepareBackupSnapshot(current, archived) {
  await assertBackupSnapshot(archived, { allowInvalidSettings: true });
  const compatible = projectBackupReaderSettings(archived.options);
  const { normaliseDictionarySelections, projectStoredOptions } = globalThis.HDReaderOptions;
  const projected = compatible ?? { ...projectStoredOptions(current.options), revision: backupRevisions(current).options };
  const selected = normaliseDictionarySelections(projected, archived.state.dictionaries, archived.state.groups);
  const warnings = [];
  if (!compatible) warnings.push("Incompatible reader settings were skipped. Your current reader settings were kept.");
  const updates = validBackupUpdateSettings(archived.updates) ? archived.updates : normaliseUpdateSettings(current.updates);
  if (updates !== archived.updates) warnings.push("Incompatible update settings were skipped. Your current update schedule was kept.");
  if (projected.frequencyDictionary !== selected.frequencyDictionary
      || !sameJsonValue(projected.kanjiClickDictionary, selected.kanjiClickDictionary)) {
    warnings.push("Unavailable dictionary selections were reset.");
  }
  return {
    snapshot: { ...archived, options: selected, updates },
    warning: warnings.length ? warnings.join(" ") : null,
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
