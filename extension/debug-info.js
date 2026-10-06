// Settings → Advanced → Troubleshooting → Get debug info. One JSON report of
// what a maintainer needs to reproduce a problem: the version and browser, the
// engine's status and memory, the installed dictionaries, and every setting.
// Each probe is recorded on its own, so one that fails or is missing in this
// host leaves `{ error }` in its place instead of losing the report.
//
// Credentials are redacted. Reader-authored content is reduced to counts: the
// personal dictionary text, lookup history rows, Anki duplicate-index rows and
// automatic backup payloads never leave the browser through this file.
// SPDX-License-Identifier: GPL-3.0-or-later
import { CUSTOM_DICTIONARY_SOURCE_KEY } from "./custom-dictionary.js";
import { LOOKUP_STATS_ROW_PREFIX } from "./lookup-stats.js";
import { ANKI_INDEX_KEY } from "./anki-index-cache.js";
import { AUTOMATIC_BACKUPS_KEY } from "./backup-automatic.js";

export const DEBUG_INFO_SCHEMA_VERSION = 1;
export const REDACTED = "[redacted]";

const SECRET_KEY = /api.?key|token|secret|password/iu;

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function probe(read) {
  try {
    return await read();
  } catch (error) {
    return { error: describeError(error) };
  }
}

// Replace every non-empty string under a credential-like key, at any depth.
// An empty value stays empty so the report still shows it was never set.
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    SECRET_KEY.test(key) && typeof entry === "string" && entry !== "" ? REDACTED : redactSecrets(entry)]));
}

const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value) ?? "").length;

function summariseCustomDictionary(value) {
  const { text, ...rest } = value ?? {};
  return typeof text === "string"
    ? { ...rest, text: { omitted: true, characters: text.length, lines: text === "" ? 0 : text.split(/\r?\n/u).length } }
    : value;
}

function summariseAnkiIndex(value) {
  const rows = value?.snapshot?.rows;
  if (!Array.isArray(rows)) return value;
  return { ...value, snapshot: { ...value.snapshot, rows: { omitted: true, count: rows.length } } };
}

function summariseAutomaticBackups(value) {
  if (!Array.isArray(value?.backups)) return value;
  return { schemaVersion: value.schemaVersion, backups: value.backups.map(record => ({
    id: record?.id, createdAt: record?.createdAt, bytes: jsonBytes(record),
  })) };
}

const SUMMARISERS = {
  [CUSTOM_DICTIONARY_SOURCE_KEY]: summariseCustomDictionary,
  [ANKI_INDEX_KEY]: summariseAnkiIndex,
  [AUTOMATIC_BACKUPS_KEY]: summariseAutomaticBackups,
};

// Every chrome.storage.local key with its stored size, the value redacted and
// reader content summarised. Lookup rows (one key per word) collapse to a count.
export function summariseStorage(items) {
  const keys = {};
  const lookupRows = { count: 0, bytes: 0 };
  for (const key of Object.keys(items).sort()) {
    const value = items[key];
    if (key.startsWith(LOOKUP_STATS_ROW_PREFIX)) {
      lookupRows.count += 1;
      lookupRows.bytes += jsonBytes(value);
      continue;
    }
    const summarise = SUMMARISERS[key];
    keys[key] = { bytes: jsonBytes(value), value: redactSecrets(summarise ? summarise(value) : value) };
  }
  return { keys, lookupStatsRows: lookupRows };
}

function browserFacts(navigator, window) {
  const data = navigator.userAgentData;
  return {
    userAgent: navigator.userAgent,
    brands: data?.brands ?? null,
    mobile: data?.mobile ?? null,
    platform: data?.platform ?? navigator.platform ?? null,
    languages: [...(navigator.languages ?? [navigator.language])],
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: navigator.deviceMemory ?? null,
    crossOriginIsolated: window.crossOriginIsolated === true,
    sharedArrayBuffer: typeof window.SharedArrayBuffer === "function",
    webAssembly: typeof window.WebAssembly === "object",
    opfs: typeof navigator.storage?.getDirectory === "function",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: window.screen ? { width: window.screen.width, height: window.screen.height, devicePixelRatio: window.devicePixelRatio } : null,
  };
}

function pageMemory(window) {
  const memory = window.performance?.memory;
  return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null;
}

// `send(type, fields, target)` is Settings' runtime message helper; `context`
// is what only the page knows (its host capabilities and the visible state).
export async function collectDebugInfo({ chrome, window, send, workerTarget, context = {}, now = () => new Date() }) {
  const { navigator } = window;
  const manifest = chrome.runtime.getManifest();
  const [platform, permissions, commands, storageEstimate, storagePersisted, storageBytesInUse,
    storage, engineStatus, engineMemory, extensionMemory, dictionaryState] = await Promise.all([
    probe(() => chrome.runtime.getPlatformInfo()),
    probe(() => chrome.permissions.getAll()),
    probe(() => chrome.commands.getAll()),
    probe(() => navigator.storage.estimate()),
    probe(() => navigator.storage.persisted()),
    probe(() => chrome.storage.local.getBytesInUse(null)),
    probe(async () => summariseStorage(await chrome.storage.local.get(null))),
    probe(() => send("hd_status")),
    probe(() => send("hd_memory")),
    probe(() => send("hd_memory_total")),
    probe(() => send("hd_state_read", {}, workerTarget)),
  ]);
  return {
    schemaVersion: DEBUG_INFO_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    extension: {
      id: chrome.runtime.id,
      name: manifest.name,
      version: manifest.version,
      versionName: manifest.version_name ?? null,
      manifestVersion: manifest.manifest_version,
      minimumChromeVersion: manifest.minimum_chrome_version ?? null,
      permissions,
      commands,
    },
    browser: { ...browserFacts(navigator, window), os: platform },
    settingsPage: { url: window.location.href, memory: pageMemory(window), ...redactSecrets(context) },
    engine: { status: engineStatus, memory: engineMemory, extensionMemory },
    dictionaries: redactSecrets(dictionaryState),
    storage: { estimate: storageEstimate, persisted: storagePersisted, localBytesInUse: storageBytesInUse, local: storage },
  };
}

export function debugInfoFilename(date) {
  const stamp = date.toISOString().replace(/\.\d+Z$/u, "Z").replace(/[:]/gu, "-");
  return `hachidori-debug-${stamp}.json`;
}

export function debugInfoBlob(report) {
  return new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" });
}
