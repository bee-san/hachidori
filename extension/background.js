import {
  httpsUrl,
  MANAGED_DICTIONARY_CHANGED,
  managedDictionaryFingerprint,
  managedDictionaryMatches,
} from "./managed-dictionary-source.js";

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

// Requests the worker answers itself. A second target is what keeps them out of
// the relay below: a message from the offscreen document carrying TARGET is
// indistinguishable from one sent by an extension page, so it would be stamped
// `relayed` and handed straight back to the offscreen document, where the
// engine's own request queue would then wait on itself.
const WORKER_TARGET = "hoshidicts-worker";

const DICTIONARY_STATE_KEY = "dictionaryState";
const LEGACY_DICTIONARIES_KEY = "dictionaries";
const OPTIONS_KEY = "options";
const UPDATE_SETTINGS_KEY = "dictionaryUpdates";
const UPDATE_ALARM = "hachidori-managed-dictionary-updates";
const DICTIONARY_STATE_SCHEMA_VERSION = 1;
const KANJI_SELECTION_KINDS = new Set(["term", "kanji"]);
const UPDATE_SCHEDULE_MINUTES = Object.freeze({
  hourly: 60,
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
});

// A relayed request can arrive in the window between createDocument() resolving
// and offscreen.js running its module body, where nothing is listening yet.
const RELAY_ATTEMPTS = 5;
const RELAY_BACKOFF_MS = 40;
const NOT_LISTENING = /Receiving end does not exist|Could not establish connection/i;

let creating = null;

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
      reasons: ["DOM_SCRAPING"],
      justification:
        "Runs the WebAssembly dictionary engine and parses imported Yomitan archives in a DOM context that outlives the service worker.",
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

async function relay(message) {
  let failure = null;
  for (let attempt = 0; attempt < RELAY_ATTEMPTS; attempt += 1) {
    await ensureOffscreen();
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

async function readDictionaryStorage() {
  const stored = await chrome.storage.local.get([
    DICTIONARY_STATE_KEY,
    LEGACY_DICTIONARIES_KEY,
    OPTIONS_KEY,
  ]);
  const state = stored?.[DICTIONARY_STATE_KEY] ?? null;
  return {
    state,
    legacyDictionaries:
      state === null && Array.isArray(stored?.[LEGACY_DICTIONARIES_KEY])
        ? stored[LEGACY_DICTIONARIES_KEY]
        : null,
    options: stored?.[OPTIONS_KEY],
  };
}

function normaliseUpdateSettings(value) {
  const schedule = value?.schedule === "off"
    || Object.prototype.hasOwnProperty.call(UPDATE_SCHEDULE_MINUTES, value?.schedule)
    ? value.schedule
    : "off";
  return {
    schedule,
    lastCheckedAt: typeof value?.lastCheckedAt === "string" ? value.lastCheckedAt : null,
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

function pruneGroupMemberships(value, dictionaries) {
  if (!Array.isArray(value)) {
    return [];
  }
  const installedIds = new Set(dictionaries.map((dictionary) => dictionary.id));
  return value.map((group) => {
    const seen = new Set();
    const dictionaryIds = Array.isArray(group.dictionaryIds)
      ? group.dictionaryIds.filter((id) => {
        if (!installedIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      : [];
    return { ...group, dictionaryIds };
  });
}

// The engine or settings page reads state, changes it, and sends it back a
// message round trip later. A caller includes the revision it read so a stale
// write cannot discard a change made by another extension context.
const WORKER_HANDLERS = {
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
    if (current !== null && current?.schemaVersion !== DICTIONARY_STATE_SCHEMA_VERSION) {
      throw new Error(`unsupported dictionary state schema ${String(current?.schemaVersion)}`);
    }
    const currentRevision = current?.revision ?? 0;
    if (message.baseRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        error: "the dictionary state changed while it was being written",
        state: current,
      };
    }

    const state = {
      schemaVersion: DICTIONARY_STATE_SCHEMA_VERSION,
      revision: currentRevision + 1,
      dictionaries: message.dictionaries,
      groups: pruneGroupMemberships(message.groups ?? current?.groups, message.dictionaries),
    };
    const values = { [DICTIONARY_STATE_KEY]: state };
    if (currentOptions !== undefined) {
      const nextOptions = normaliseDictionarySelections(currentOptions, state.dictionaries);
      if (JSON.stringify(nextOptions) !== JSON.stringify(currentOptions)) {
        values[OPTIONS_KEY] = nextOptions;
      }
    }
    await chrome.storage.local.set(values);
    if (current === null && legacyDictionaries !== null) {
      try {
        await chrome.storage.local.remove(LEGACY_DICTIONARIES_KEY);
      } catch (error) {
        console.warn("hoshidicts: could not remove legacy dictionary rows:", describe(error));
      }
    }
    return { state };
  },

  async hd_options_write(message) {
    if (!message?.options || typeof message.options !== "object" || Array.isArray(message.options)) {
      throw new Error("the options write request carried no object");
    }
    const { state, options: currentOptions } = await readDictionaryStorage();
    if (state !== null && state?.schemaVersion !== DICTIONARY_STATE_SCHEMA_VERSION) {
      throw new Error(`unsupported dictionary state schema ${String(state?.schemaVersion)}`);
    }
    const options = state === null
      ? message.options
      : normaliseDictionarySelections(message.options, state.dictionaries);
    if (JSON.stringify(options) !== JSON.stringify(currentOptions)) {
      await chrome.storage.local.set({ [OPTIONS_KEY]: options });
    }
    return { options };
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
    const settings = update(current);
    await chrome.storage.local.set({ [UPDATE_SETTINGS_KEY]: settings });
    return settings;
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
  if (httpsUrl(response.url) === null) {
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

async function runManagedUpdateCycle({ dictionaryIds = null, install = false } = {}) {
  const candidates = await managedCandidates(dictionaryIds);
  const checkedAt = new Date().toISOString();
  const outcomes = [];

  for (const candidate of candidates) {
    let update;
    try {
      update = await remoteUpdate(candidate);
    } catch (error) {
      let message = describe(error);
      const recorded = await updateDictionaryCheck(candidate.fingerprint, {
        checkedAt,
        status: "check-failed",
        remoteRevision: null,
        error: message,
      });
      if (recorded === null) message = MANAGED_DICTIONARY_CHANGED;
      outcomes.push({ id: candidate.id, status: "check-failed", error: message });
      continue;
    }

    if (update.revision === candidate.fingerprint.revision) {
      const recorded = await updateDictionaryCheck(candidate.fingerprint, {
        checkedAt,
        status: "up-to-date",
        remoteRevision: update.revision,
        error: null,
      });
      outcomes.push(recorded === null
        ? { id: candidate.id, status: "check-failed", error: MANAGED_DICTIONARY_CHANGED }
        : { id: candidate.id, status: "up-to-date" });
      continue;
    }

    const available = {
      checkedAt,
      status: "update-available",
      remoteRevision: update.revision,
      error: null,
    };
    const recorded = await updateDictionaryCheck(candidate.fingerprint, available);
    if (recorded === null) {
      outcomes.push({ id: candidate.id, status: "check-failed", error: MANAGED_DICTIONARY_CHANGED });
      continue;
    }
    if (!install) {
      outcomes.push({ id: candidate.id, status: "update-available" });
      continue;
    }

    try {
      await installManagedCandidate(candidate, update, checkedAt);
      outcomes.push({ id: candidate.id, status: "updated" });
    } catch (error) {
      let message = describe(error);
      const failed = await updateDictionaryCheck(
        candidate.fingerprint,
        { ...available, error: message },
      );
      if (failed === null) message = MANAGED_DICTIONARY_CHANGED;
      outcomes.push({
        id: candidate.id,
        status: failed === null ? "check-failed" : "update-available",
        error: message,
      });
    }
  }

  const settings = await writeUpdateSettings((current) => ({
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
    const periodInMinutes = UPDATE_SCHEDULE_MINUTES[settings.schedule] ?? null;
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
  async hd_updates_read() {
    return { settings: await readUpdateSettings() };
  },

  async hd_updates_schedule(message) {
    const schedule = message?.schedule;
    if (schedule !== "off"
        && !Object.prototype.hasOwnProperty.call(UPDATE_SCHEDULE_MINUTES, schedule)) {
      throw new Error("the dictionary update schedule is invalid");
    }
    const settings = await writeUpdateSettings((current) => ({ ...current, schedule }));
    await reconcileUpdateAlarm();
    return { settings };
  },

  async hd_updates_check() {
    return queueManagedUpdate({ install: false });
  },

  async hd_updates_install(message) {
    if (!Array.isArray(message?.dictionaryIds)) {
      throw new Error("the dictionary update request carried no dictionary IDs");
    }
    return queueManagedUpdate({ dictionaryIds: message.dictionaryIds, install: true });
  },
};

function failureReply(message, error) {
  return {
    type: `${message?.type ?? "hd_unknown"}_result`,
    requestId: message?.requestId ?? null,
    ok: false,
    error: describe(error),
    generation: 0,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET || message.relayed === true) {
    return false;
  }
  relay(message).then(sendResponse, (error) => {
    sendResponse(failureReply(message, error));
  });
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
  serialiseStorage(() => WORKER_HANDLERS[type](message)).then(
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

// Update cycles relay imports back through the engine, which calls into the
// storage handlers above while committing. Keep this listener outside
// serialiseStorage() so the engine can complete that callback.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== UPDATE_TARGET) {
    return false;
  }
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.prototype.hasOwnProperty.call(UPDATE_HANDLERS, type)) {
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
reconcileUpdateAlarm().catch((error) => {
  console.error("hoshidicts: could not reconcile the dictionary update alarm:", describe(error));
});
