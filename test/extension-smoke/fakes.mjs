/*
 * The fakes and loaders every smoke file shares.
 *
 * Nothing here is a browser. The fakes cover only the Chrome surface the
 * extension actually touches: a message bus, chrome.storage.local, IndexedDB,
 * fetch, navigator and the script loaders.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { before } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import {
  ANKI_INDEX_ALARM,
  ANKI_INDEX_KEY,
  ankiIndexConfigurationChange,
  createAnkiDuplicateIndex,
} from "../../extension/anki-index-cache.js";
import { lookupAnkiIndex } from "../../extension/anki-index.js";
import { ankiSetupFamily } from "../../extension/anki-setup.js";
import { createAnkiWorkerService } from "../../extension/anki-worker.js";
import { createBackupDownloads } from "../../extension/backup-downloads.js";
import { assertBackupSnapshot, backupRevisions } from "../../extension/backup-state.js";
import {
  detectLocalAudioSource as realDetectLocalAudioSource,
} from "../../extension/local-audio-setup.js";
import { captureNetflixPreview } from "../../extension/netflix-preview.js";
import { canDiscoverSharingHost } from "../../extension/sharing-protocol.js";
import { SETTINGS_PAGE_MODULES } from "../settings-modules.mjs";

const nativeFetch = globalThis.fetch.bind(globalThis);

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(HERE, "..");
const EXTENSION = resolve(ROOT, "extension");
const EXTENSION_MANIFEST = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"));
const FIXTURE = resolve(HERE, "fixtures/hachidori-fixture.zip");
const EXTENSION_ORIGIN = "chrome-extension://hachidorismokeextensionid";

const FIXTURE_TITLE = "hachidori-fixture";
const GENERATION_ROOT_PATTERN = /^\/dicts\/\.hdw-generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DICTIONARY_PACKAGE_KEYS = [
  "displayName",
  "downloadUrl",
  "enabled",
  "favorite",
  "frequencyCount",
  "frequencyMode",
  "id",
  "indexUrl",
  "installedAt",
  "isUpdatable",
  "kanjiCount",
  "language",
  "lastUpdateCheck",
  "longKeyLength",
  "mediaCount",
  "path",
  "pitchCount",
  "revision",
  "termCount",
  "title",
];

function ownedGenerationRoot(path, title) {
  const suffix = `/${title}`;
  const root = typeof path === "string" && path.endsWith(suffix)
    ? path.slice(0, -suffix.length)
    : "";
  return GENERATION_ROOT_PATTERN.test(root) ? root : "";
}

function genericPackage(overrides = {}) {
  return {
    id: "0228c6d48ecf92b90092974400dbf390",
    title: "Generic",
    displayName: null,
    path: "/dicts/Generic",
    enabled: true,
    favorite: false,
    revision: "test-1",
    isUpdatable: false,
    indexUrl: null,
    downloadUrl: null,
    language: "ja",
    termCount: 1,
    frequencyCount: 0,
    frequencyMode: null,
    pitchCount: 0,
    kanjiCount: 0,
    mediaCount: 0,
    installedAt: "2026-09-04T00:00:00.000Z",
    lastUpdateCheck: null,
    ...overrides,
  };
}
// Where chrome-e2e.mjs already keeps puppeteer-core, so one out-of-repo tree
// holds every test dependency. HACHIDORI_JSDOM or NODE_PATH override it.
const DEFAULT_JSDOM_TREE = resolve(
  process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"),
  "hachidori-e2e",
);

/* ---------------------------------------------------------------- fake IndexedDB */

// IDBFS uses one object store keyed by path, plus a `timestamp` index it walks
// with openKeyCursor to find what changed. Nothing else of IndexedDB is needed.
function installFakeIndexedDB() {
  const databases = new Map();
  const soon = (fn) => setTimeout(fn, 0);
  const request = () => ({ onsuccess: null, onerror: null, result: undefined });

  function store(rows, transaction) {
    return {
      indexNames: { contains: () => true },
      createIndex() {},
      index() {
        return {
          openKeyCursor() {
            const pending = request();
            const ordered = [...rows.entries()].sort(
              (a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime(),
            );
            let position = 0;
            const step = () => {
              const row = ordered[position];
              pending.result =
                row === undefined
                  ? null
                  : {
                      key: row[1].timestamp,
                      primaryKey: row[0],
                      continue() {
                        position += 1;
                        soon(step);
                      },
                    };
              pending.onsuccess?.({ target: pending });
            };
            soon(step);
            return pending;
          },
        };
      },
      get(key) {
        const pending = request();
        transaction.begin();
        soon(() => {
          pending.result = rows.get(key);
          pending.onsuccess?.({ target: pending });
          transaction.end();
        });
        return pending;
      },
      put(value, key) {
        const pending = request();
        transaction.begin();
        soon(() => {
          rows.set(key, value);
          pending.onsuccess?.({ target: pending });
          transaction.end();
        });
        return pending;
      },
      delete(key) {
        const pending = request();
        transaction.begin();
        soon(() => {
          rows.delete(key);
          pending.onsuccess?.({ target: pending });
          transaction.end();
        });
        return pending;
      },
    };
  }

  function database(name) {
    if (!databases.has(name)) {
      databases.set(name, new Map());
    }
    const rows = databases.get(name);
    return {
      objectStoreNames: { contains: () => true },
      createObjectStore() {
        return store(rows, { begin() {}, end() {} });
      },
      close() {},
      transaction() {
        const transaction = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          pending: 0,
          settled: false,
          begin() {
            transaction.pending += 1;
          },
          end() {
            transaction.pending -= 1;
            soon(transaction.check);
          },
          check() {
            if (transaction.settled || transaction.pending > 0) {
              return;
            }
            transaction.settled = true;
            transaction.oncomplete?.({ target: transaction });
          },
          objectStore() {
            return store(rows, transaction);
          },
        };
        // A transaction that issues no request at all still has to complete.
        soon(() => soon(transaction.check));
        return transaction;
      },
    };
  }

  globalThis.indexedDB = {
    open(name) {
      const pending = request();
      soon(() => {
        const fresh = !databases.has(name);
        const db = database(name);
        pending.result = db;
        if (fresh) {
          pending.onupgradeneeded?.({
            target: { result: db, transaction: db.transaction() },
          });
        }
        pending.onsuccess?.({ target: pending });
      });
      return pending;
    },
  };
  return {
    count: (name) => databases.get(name)?.size ?? 0,
    // IDBFS keys its one store by absolute path, so these are the files that would
    // come back after a restart -- the only place a test outside a browser can see
    // what persistence actually captured.
    keys: (name) => [...(databases.get(name)?.keys() ?? [])],
    names: () => [...databases.keys()],
  };
}

/* -------------------------------------------------------------------- fake chrome */

// One bus, several senders. chrome.runtime.sendMessage never delivers to the
// sender itself, and a message from an extension context never reaches a content
// script -- both matter here, because background.js relies on exactly that to
// avoid answering its own relayed copy.
function makeBus() {
  const listeners = [];
  const log = [];

  function addListener(owner, fn) {
    listeners.push({ fn, owner });
  }

  function sendMessage(owner, message, sender = { id: "hachidorismokeextensionid" }) {
    log.push({ from: owner, type: message?.type, relayed: message?.relayed === true });
    return new Promise((resolveReply, rejectReply) => {
      const audience = listeners.filter((entry) => entry.owner !== owner);
      let settled = false;
      let open = false;
      const respond = (reply) => {
        if (!settled) {
          settled = true;
          resolveReply(reply);
        }
      };
      for (const entry of audience) {
        let keepOpen;
        try {
          keepOpen = entry.fn(message, sender, respond);
        } catch (error) {
          rejectReply(error);
          return;
        }
        if (keepOpen === true) {
          open = true;
        }
      }
      if (!open && !settled) {
        // Chrome's "Receiving end does not exist" case.
        settled = true;
        resolveReply(undefined);
      }
    });
  }

  return { addListener, log, sendMessage };
}

function makeStorage() {
  const local = new Map();
  const changeListeners = [];
  const gets = [];
  const sets = [];
  let pendingSetFailure = null;
  let pendingSetReplyFailure = null;
  let sortDictionaryKeysOnRead = false;

  function withSortedDictionaryKeys(value) {
    if (Array.isArray(value)) {
      return value.map(withSortedDictionaryKeys);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const keys = "id" in value && "title" in value && "path" in value
      ? Object.keys(value).sort()
      : Object.keys(value);
    return Object.fromEntries(keys.map((key) => [
      key,
      withSortedDictionaryKeys(value[key]),
    ]));
  }

  function read(query) {
    if (query === null || query === undefined) {
      return Object.fromEntries(local);
    }
    if (typeof query === "string") {
      return local.has(query) ? { [query]: local.get(query) } : {};
    }
    if (Array.isArray(query)) {
      const out = {};
      for (const key of query) {
        if (local.has(key)) {
          out[key] = local.get(key);
        }
      }
      return out;
    }
    const out = {};
    for (const [key, fallback] of Object.entries(query)) {
      out[key] = local.has(key) ? local.get(key) : fallback;
    }
    return out;
  }

  function api() {
    return {
      local: {
        get(query, callback) {
          gets.push(structuredClone(query));
          const stored = structuredClone(read(query));
          const value = sortDictionaryKeysOnRead ? withSortedDictionaryKeys(stored) : stored;
          if (typeof callback === "function") {
            setTimeout(() => callback(value), 0);
            return undefined;
          }
          return Promise.resolve(value);
        },
        set(items, callback) {
          if (pendingSetFailure !== null) {
            const failure = pendingSetFailure;
            pendingSetFailure = null;
            // Only the promise form is faked: it is the only one the extension uses.
            return Promise.reject(failure);
          }
          const changes = {};
          sets.push(Object.keys(items).sort());
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { newValue: structuredClone(value), oldValue: local.get(key) };
            local.set(key, structuredClone(value));
          }
          for (const listener of changeListeners) {
            setTimeout(() => listener(structuredClone(changes), "local"), 0);
          }
          if (typeof callback === "function") {
            setTimeout(callback, 0);
            return undefined;
          }
          if (pendingSetReplyFailure !== null) {
            const failure = pendingSetReplyFailure;
            pendingSetReplyFailure = null;
            return Promise.reject(failure);
          }
          return Promise.resolve();
        },
        remove(keys, callback) {
          const changes = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (local.has(key)) {
              changes[key] = { oldValue: structuredClone(local.get(key)) };
              local.delete(key);
            }
          }
          if (Object.keys(changes).length > 0) {
            for (const listener of changeListeners) {
              setTimeout(() => listener(structuredClone(changes), "local"), 0);
            }
          }
          if (typeof callback === "function") {
            setTimeout(callback, 0);
            return undefined;
          }
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener(fn) {
          changeListeners.push(fn);
        },
        removeListener(fn) {
          const index = changeListeners.indexOf(fn);
          if (index >= 0) {
            changeListeners.splice(index, 1);
          }
        },
      },
    };
  }

  return {
    api,
    gets,
    raw: local,
    sets,
    failNextSet(message) {
      pendingSetFailure = new Error(message);
    },
    loseNextSetReply(message) {
      pendingSetReplyFailure = new Error(message);
    },
    sortDictionaryKeysOnRead(value) {
      sortDictionaryKeysOnRead = value;
    },
  };
}

function makeEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    fire(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function makeAlarms() {
  const values = new Map();
  const onAlarm = makeEvent();
  let pendingCreateFailure = null;
  return {
    api: {
      async clear(name) {
        return values.delete(name);
      },
      async create(name, info) {
        if (pendingCreateFailure !== null) {
          const failure = pendingCreateFailure;
          pendingCreateFailure = null;
          throw failure;
        }
        values.set(name, { name, ...structuredClone(info), scheduledTime: info.when ?? Date.now() + info.periodInMinutes * 60_000 });
      },
      async get(name) {
        return values.has(name) ? structuredClone(values.get(name)) : undefined;
      },
      onAlarm,
    },
    fire(name) {
      const alarm = values.get(name);
      if (alarm) onAlarm.fire(structuredClone(alarm));
    },
    failNextCreate(message) {
      pendingCreateFailure = new Error(message);
    },
    values,
  };
}

const offscreenState = { created: 0, exists: false, concurrent: 0, peakConcurrent: 0 };

function makeChrome(owner, bus, storage, alarms = makeAlarms()) {
  const onInstalled = makeEvent();
  const onStartup = makeEvent();
  const onConnect = makeEvent();
  return {
    alarms: alarms.api,
    downloads: { onChanged: makeEvent() },
    __events: { onInstalled, onStartup, onConnect },
    runtime: {
      id: "hachidorismokeextensionid",
      lastError: undefined,
      getManifest() {
        return { version: "0.0.0-smoke" };
      },
      getURL(path) {
        return `${EXTENSION_ORIGIN}/${String(path).replace(/^\//u, "")}`;
      },
      async getContexts() {
        return offscreenState.exists ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
      },
      onMessage: {
        addListener(fn) {
          bus.addListener(owner, fn);
        },
        removeListener() {},
      },
      onInstalled,
      onStartup,
      onConnect,
      sendMessage(message, callback) {
        const promise = bus.sendMessage(owner, message, {
          id: "hachidorismokeextensionid",
          url: `${EXTENSION_ORIGIN}/${owner.includes("offscreen") ? "offscreen.html" : "settings.html"}`,
        });
        if (typeof callback !== "function") {
          return promise;
        }
        promise.then(
          (reply) => {
            // Chrome reports a missing receiver through lastError, not a throw.
            globalThis.chrome = globalThis.chrome ?? {};
            callback(reply);
          },
          (error) => {
            callback(undefined);
            console.error("smoke: sendMessage rejected", error);
          },
        );
        return undefined;
      },
    },
    offscreen: {
      async createDocument() {
        offscreenState.concurrent += 1;
        offscreenState.peakConcurrent = Math.max(
          offscreenState.peakConcurrent,
          offscreenState.concurrent,
        );
        offscreenState.created += 1;
        await new Promise((done) => setTimeout(done, 5));
        offscreenState.exists = true;
        offscreenState.concurrent -= 1;
      },
    },
    storage: storage.api(),
  };
}

/* --------------------------------------------------------------------- fake fetch */

const blobUrls = new Map();
const declaredLengthUrls = new Map();
const remoteResponses = new Map();
let nextBlobId = 0;

function installFetch() {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("blob:nodedata:")) return nativeFetch(input);
    if (remoteResponses.has(url)) {
      return remoteResponses.get(url)(url);
    }
    if (declaredLengthUrls.has(url)) {
      const { contentLength, bytes } = declaredLengthUrls.get(url);
      let offset = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(contentLength) : null) },
        body: {
          getReader: () => ({
            async read() {
              if (offset >= bytes.byteLength) return { done: true, value: undefined };
              const value = bytes.subarray(offset, Math.min(offset + 257, bytes.byteLength));
              offset += value.byteLength;
              return { done: false, value };
            },
          }),
        },
        arrayBuffer: async () => { throw new Error("blob responses must be streamed into the WASM filesystem"); },
      };
    }
    if (blobUrls.has(url)) {
      const bytes = blobUrls.get(url);
      let offset = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            async read() {
              if (offset >= bytes.byteLength) return { done: true, value: undefined };
              const value = bytes.subarray(offset, Math.min(offset + 257, bytes.byteLength));
              offset += value.byteLength;
              return { done: false, value };
            },
          }),
        },
        arrayBuffer: async () => { throw new Error("blob responses must be streamed into the WASM filesystem"); },
      };
    }
    if (url.startsWith(`${EXTENSION_ORIGIN}/`)) {
      const path = url.slice(EXTENSION_ORIGIN.length + 1);
      try {
        const body = await readFile(resolve(EXTENSION, path), "utf8");
        return { ok: true, status: 200, text: async () => body };
      } catch {
        return { ok: false, status: 404, text: async () => "" };
      }
    }
    return { ok: false, status: 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

function remoteJson(url, value, status = 200, finalUrl = url) {
  remoteResponses.set(url, async () => ({
    ok: status >= 200 && status < 300,
    status,
    url: finalUrl,
    async json() {
      return structuredClone(typeof value === "function" ? await value() : value);
    },
  }));
}

function remoteArchive(url, bytes, finalUrl = url, observed = null, beforeFirstChunk = null) {
  remoteResponses.set(url, async () => {
    if (observed) observed.count += 1;
    let offset = 0;
    let firstChunk = true;
    return {
      ok: true,
      status: 200,
      url: finalUrl,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          async read() {
            if (firstChunk) {
              firstChunk = false;
              await beforeFirstChunk?.();
            }
            if (offset >= bytes.byteLength) return { done: true, value: undefined };
            const value = bytes.subarray(offset, Math.min(offset + 257, bytes.byteLength));
            offset += value.byteLength;
            return { done: false, value };
          },
          releaseLock() {},
        }),
      },
    };
  });
}

function createObjectURL(bytes) {
  nextBlobId += 1;
  const url = `blob:${EXTENSION_ORIGIN}/smoke-${nextBlobId}`;
  blobUrls.set(url, bytes);
  return url;
}

function createDeclaredLengthURL(contentLength, bytes) {
  nextBlobId += 1;
  const url = `blob:${EXTENSION_ORIGIN}/declared-length-${nextBlobId}`;
  declaredLengthUrls.set(url, { contentLength, bytes });
  return url;
}

/* -------------------------------------------------------------------------- setup */

function installNavigator() {
  const value = { storage: { persist: async () => true }, userAgent: "smoke", hardwareConcurrency: 4 };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
    writable: true,
  });
}

function loadClassicScript(file, sandbox) {
  const source = readFileSync(file, "utf8");
  const context = createContext(sandbox);
  context.globalThis = context;
  runInContext(source, context, { filename: file });
  return context;
}

const BACKGROUND_MODULES = ["background-core.js", "background-netflix.js", "background.js"];

function loadBackgroundScript(sandbox, { overlayMode = false } = {}) {
  Object.assign(sandbox, { assertBackupSnapshot, backupRevisions, createBackupDownloads, captureNetflixPreview });
  sandbox.createAnkiWorkerService ??= createAnkiWorkerService;
  const anki = readFileSync(resolve(EXTENSION, "anki.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const ankiTemplates = readFileSync(resolve(EXTENSION, "anki-templates.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const ankiSetup = readFileSync(resolve(EXTENSION, "anki-setup.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const readerOptions = readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8");
  const lookupStats = readFileSync(resolve(EXTENSION, "lookup-stats-identity.js"), "utf8")
    + readFileSync(resolve(EXTENSION, "lookup-stats.js"), "utf8").replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const externalLinks = readFileSync(resolve(EXTENSION, "external-links.js"), "utf8");
  const groupState = readFileSync(resolve(EXTENSION, "dictionary-group-state.js"), "utf8");
  const wordStatusOverrides = readFileSync(resolve(EXTENSION, "word-status-overrides.js"), "utf8");
  const recommended = readFileSync(resolve(EXTENSION, "recommended-dictionaries.js"), "utf8");
  const customDictionary = readFileSync(resolve(EXTENSION, "custom-dictionary.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const jsonValue = readFileSync(resolve(EXTENSION, "json-value.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const responseLimits = readFileSync(resolve(EXTENSION, "response-limits.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const automaticBackups = readFileSync(resolve(EXTENSION, "backup-automatic.js"), "utf8")
    .replace(/^import .* from "\.\/(?:lookup-stats|backup-state)\.js";\s*/gmu, "")
    .replace(/^export\s+/gmu, "");
  const overlayModeSource = readFileSync(resolve(EXTENSION, "overlay-mode.js"), "utf8")
    .replace(/^export\s+/gmu, "")
    .replace("OVERLAY_MODE = false;", `OVERLAY_MODE = ${overlayMode};`);
  const chromeOffscreen = readFileSync(resolve(EXTENSION, "chrome-offscreen.js"), "utf8")
    .replace(/import \{ extensionApi as chrome \} from "\.\/browser-api\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const setupState = readFileSync(resolve(EXTENSION, "setup-state.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const localAudioSource = readFileSync(resolve(EXTENSION, "local-audio-source.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const sharingProtocol = readFileSync(resolve(EXTENSION, "sharing-protocol.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const sharingHost = readFileSync(resolve(EXTENSION, "sharing-host.js"), "utf8")
    .replace(/^import .* from "\.\/error-text\.js";\s*/gmu, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/sharing-protocol\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const sharingClient = readFileSync(resolve(EXTENSION, "sharing-client.js"), "utf8")
    .replace(/^import .* from "\.\/error-text\.js";\s*/gmu, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/sharing-protocol\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const glossary = readFileSync(resolve(EXTENSION, "render/glossary.js"), "utf8");
  const apiHost = readFileSync(resolve(EXTENSION, "api-host.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+\{[^}]*\}\s*from[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const managedSource = readFileSync(resolve(EXTENSION, "managed-dictionary-source.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "");
  const debugLog = readFileSync(resolve(EXTENSION, "debug-log.js"), "utf8").replace(/^export\s+/gmu, "");
  const errorText = readFileSync(resolve(EXTENSION, "error-text.js"), "utf8").replace(/^export\s+/gmu, "");
  // The worker's modules run as one script, as background.js did before it was
  // split: each without its imports and exports, and each constant declared
  // before the module-load code that reads it.
  const background = BACKGROUND_MODULES.map(file => readFileSync(resolve(EXTENSION, file), "utf8")
    .replace(/^import\s+(?:[^"';]*?\s+from\s+)?"[^"]+";\n/gmu, "")
    .replace(/^export\s*\{[^}]*\};\n/gmu, "")).join("\n");
  sandbox.TextEncoder ??= TextEncoder;
  sandbox.AbortController ??= AbortController;
  sandbox.URL ??= URL;
  sandbox.Uint8Array ??= Uint8Array;
  sandbox.Uint32Array ??= Uint32Array;
  sandbox.DataView ??= DataView;
  sandbox.crypto ??= globalThis.crypto;
  // A browser install shares by default; a socket that never opens keeps the
  // host's retry timer and alarm out of stages that fake timers or count alarms.
  sandbox.WebSocket ??= class { constructor(url) { this.url = url; this.readyState = 0; } send() {} close() {} };
  Object.assign(sandbox, {
    ANKI_INDEX_ALARM,
    ANKI_INDEX_KEY,
    ankiIndexConfigurationChange,
    createAnkiDuplicateIndex: sandbox.createAnkiDuplicateIndex ?? createAnkiDuplicateIndex,
    lookupAnkiIndex,
    detectLocalAudioSource: sandbox.detectLocalAudioSource ?? realDetectLocalAudioSource,
    applyCustomJavaScript: sandbox.applyCustomJavaScript ?? (() => Promise.resolve()),
    applyGoogleDocsFlag: sandbox.applyGoogleDocsFlag ?? (() => Promise.resolve()),
    applyNetflixFlag: sandbox.applyNetflixFlag ?? (() => Promise.resolve()),
  });
  const context = createContext(sandbox);
  context.globalThis = context;
  runInContext(
    `${readerOptions}\n${lookupStats}\n${recommended.replace(/^export\s+/gmu, "")}\n`
      + `${customDictionary}\n${jsonValue}\n${responseLimits}\n${automaticBackups}\n${overlayModeSource}\n${setupState}\n${localAudioSource}\n${sharingProtocol}\n${sharingHost}\n${sharingClient}\n${ankiTemplates}\n${glossary}\n${apiHost}\n${anki}\n${ankiSetup}\n`
      + `${managedSource.replace(/^export\s+/gmu, "")}\n${externalLinks}\n${groupState}\n${wordStatusOverrides}\n${chromeOffscreen}\n${debugLog}\n${errorText}\n`
      + background,
    context,
    { filename: resolve(EXTENSION, "background.js") },
  );
  return context;
}

// A linked install: a fake WebSocket stands in for the bridge and the host.
class FakeSharingSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    FakeSharingSocket.instances.push(this);
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({}), 0);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
  requests() { return this.sent.filter(frame => frame.kind === "request"); }
}

// The word status stages' workers run beside an offscreen engine that already
// exists, so they create none; the returned function restores the bookkeeping
// so the later single-creation checks measure their own run.
function existingOffscreenStage() {
  FakeSharingSocket.instances.length = 0;
  const offscreenBefore = { ...offscreenState };
  Object.assign(offscreenState, { created: 0, exists: true, concurrent: 0, peakConcurrent: 0 });
  return () => Object.assign(offscreenState, offscreenBefore);
}

async function settleSharing(predicate) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
  }
}

// The worker on `storage` shares itself once it has a dictionary; a linked
// reader then connects through the relay and is answered with its hello.
async function shareWithLinkedReader(storage) {
  const dictionary = { id: "word-status-dict", title: "Words", displayName: null, path: "/dicts/Words", enabled: true,
    favorite: false, revision: "1", isUpdatable: false, indexUrl: null, downloadUrl: null, language: "ja", frequencyMode: null,
    termCount: 2, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, mediaCount: 0, installedAt: "2026-10-01T00:00:00.000Z",
    lastUpdateCheck: null };
  await storage.api().local.set({ dictionaryState: { schemaVersion: 1, revision: 1, dictionaries: [dictionary], groups: [] } });
  await settleSharing(() => FakeSharingSocket.instances.some(socket => socket.url.endsWith("/host")));
  const host = FakeSharingSocket.instances.find(socket => socket.url.endsWith("/host"));
  host?.open();
  host?.receive({ kind: "listening", port: 8771 });
  host?.receive({ kind: "client-open", clientId: "reader", origin: "chrome-extension://linkedreader", address: "127.0.0.1" });
  const fromReader = frame => host?.receive({ kind: "client-text", clientId: "reader", text: JSON.stringify(frame) });
  const toReader = () => (host?.sent ?? []).filter(frame => frame.kind === "send").map(frame => JSON.parse(frame.text));
  fromReader({ kind: "hello", protocol: 1, version: "0.0.0-smoke", name: "Linked",
    capabilities: ["linked-anki-v1", "linked-anki-v2"] });
  await settleSharing(() => toReader().some(frame => frame.kind === "hello"));
  return { host, fromReader, toReader };
}

function loadSettingsScript(window, { overlayMode = false, recommendedInstall = async () => ({ ok: true, runId: null, sequence: 0, finished: true, entries: [] }) } = {}) {
  window.extensionApi = window.chrome;
  window.selectExtensionApi = scope => scope.chrome ?? null;
  window.OVERLAY_MODE = overlayMode;
  window.HOST_CAPABILITIES = {

    browserShortcuts: !overlayMode,
    linkButtons: true,
    externalLinkHost: overlayMode,
    customJavaScript: true,
    localFileAccessPrompt: !overlayMode,
    lowMemoryMode: true,
  };
  window.MINING_CAPABILITIES = { screenshot: !overlayMode, browserSpeech: !overlayMode };
  window.chrome.runtime.connect ??= () => ({
    postMessage() {},
    onDisconnect: { addListener() {} },
  });
  // Most Settings scenarios have no active offscreen batch. The installation
  // scenario supplies the real shared runner through this same transport.
  const originalSend = window.chrome.runtime.sendMessage.bind(window.chrome.runtime);
  window.chrome.runtime.sendMessage = message => message.type === "hd_setup_install"
    ? recommendedInstall(message) : originalSend(message);
  window.ankiSetupFamily = ankiSetupFamily;
  window.eval(readFileSync(resolve(EXTENSION, "recommended-install-client.js"), "utf8").replace(/^export\s+/gmu, ""));
  const externalLinks = readFileSync(resolve(EXTENSION, "external-links.js"), "utf8");
  const customButtonSettings = readFileSync(resolve(EXTENSION, "custom-button-settings.js"), "utf8")
    .replace(/^import .*\n/gmu, "").replace(/^export\s+/gmu, "");
  const searchSettings = readFileSync(resolve(EXTENSION, "settings-search.js"), "utf8").replace(/^export\s+/gmu, "");
  window.eval(`{ ${searchSettings}; window.createSettingsSearch = createSettingsSearch; }`);
  window.chrome.extension ??= { isAllowedFileSchemeAccess: async () => false };
  const localFileAccess = readFileSync(resolve(EXTENSION, "local-file-access.js"), "utf8").replace(/^export\s+/gmu, "");
  window.eval(readFileSync(resolve(EXTENSION, "blob-download.js"), "utf8").replace(/^export\s+/gmu, ""));
  const automaticBackups = readFileSync(resolve(EXTENSION, "backup-automatic.js"), "utf8")
    .replace(/^import .*\n/gmu, "").replace(/^export\s+/gmu, "");
  const backupSettings = readFileSync(resolve(EXTENSION, "backup-settings.js"), "utf8")
    .replace(/^import .*\n/gmu, "").replace(/^export\s+/gmu, "");
  const themeStore = readFileSync(resolve(EXTENSION, "theme-store.js"), "utf8").replace(/^export\s+/gmu, "");
  const experimentalSettings = readFileSync(resolve(EXTENSION, "experimental-settings.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const activationSettings = readFileSync(resolve(EXTENSION, "activation-settings.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const memorySettings = readFileSync(resolve(EXTENSION, "memory-settings.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const settingsDom = readFileSync(resolve(EXTENSION, "settings-dom.js"), "utf8").replace(/^export\s+/gmu, "");
  const anki = readFileSync(resolve(EXTENSION, "anki.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const ankiTemplates = readFileSync(resolve(EXTENSION, "anki-templates.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const ankiSettings = readFileSync(resolve(EXTENSION, "anki-settings.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  const audioSettings = readFileSync(resolve(EXTENSION, "audio-settings.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "")
    .replace(/^export\s+/gmu, "");
  const localAudioSource = readFileSync(resolve(EXTENSION, "local-audio-source.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const localAudioSetup = readFileSync(resolve(EXTENSION, "local-audio-setup.js"), "utf8")
    .replace(/^import[^\n]+\n/gmu, "").replace(/^export\s+/gmu, "");
  window.eval(`{ ${localAudioSource}\n${localAudioSetup}; window.createLocalAudioSetup = createLocalAudioSetup; }`);
  const readerOptions = readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8");
  const groupState = readFileSync(resolve(EXTENSION, "dictionary-group-state.js"), "utf8");
  const recommended = readFileSync(resolve(EXTENSION, "recommended-dictionaries.js"), "utf8");
  const customDictionary = readFileSync(resolve(EXTENSION, "custom-dictionary.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const managedSource = readFileSync(resolve(EXTENSION, "managed-dictionary-source.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const groups = readFileSync(resolve(EXTENSION, "dictionary-groups.js"), "utf8")
    .replace(/import "\.\/dictionary-group-state\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const nameDrafts = readFileSync(resolve(EXTENSION, "dictionary-name-drafts.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const dictionaryProgress = readFileSync(resolve(EXTENSION, "dictionary-progress.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const dictionaryImport = readFileSync(resolve(EXTENSION, "dictionary-import.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const importErrors = readFileSync(resolve(EXTENSION, "dictionary-import-errors.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const setupState = readFileSync(resolve(EXTENSION, "setup-state.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const settings = readFileSync(resolve(EXTENSION, "settings.js"), "utf8")
    .replace(/^import .* from "\.\/overlay-mode\.js";\s*/gmu, "")
    .replace(/^import .* from "\.\/blob-download\.js";\s*/gmu, "")
    .replace(/^import .* from "\.\/settings-dom\.js";\s*/gmu, "")
    .replace(/^import .* from "\.\/recommended-install-client\.js";\s*/gmu, "")
    .replace(/import \{ createCustomButtonSettings \} from "\.\/custom-button-settings\.js";\s*/u, "")
    .replace(/import \{ createSettingsSearch \} from "\.\/settings-search\.js";\s*/u, "")
    .replace(/import \{ createLocalFileAccessController \} from "\.\/local-file-access\.js";\s*/u, "")
    .replace(/import \{ createBackupSettingsController \} from "\.\/backup-settings\.js";\s*/u, "")
    .replace(/^import .* from "\.\/theme-store\.js";\s*/gmu, "")
    .replace(/import \{ createExperimentalSettings \} from "\.\/experimental-settings\.js";\s*/u, "")
    .replace(/import \{ createMemorySettings \} from "\.\/memory-settings\.js";\s*/u, "")
    .replace(/^import .* from "\.\/dictionary-name-drafts\.js";\s*/gmu, "")
    .replace(/import \{ createAnkiTemplateSettingsController \} from "\.\/anki-settings\.js";\s*/u, "")
    .replace(/import "\.\/reader-options\.js";\s*/u, "")
    .replace(/import\s*\{ createAudioSettingsController \}\s*from\s*"\.\/audio-settings\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/dictionary-groups\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/custom-dictionary\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/setup-state\.js";\s*/u, "")
    .replace(/import \{ captureDebugLog \} from "\.\/debug-log\.js";\s*/u, "")
    .replace(/^import .* from "\.\/error-text\.js";\s*/gmu, "")
    .replace(/^import \{[^}]*\} from "\.\/[\w-]+-settings\.js";\s*/gmu, "")
    .replace(/^export\s+/gmu, "")
    // The module awaits its entry point; a classic script has no top-level await.
    .replace(/^await start\(\);$/mu, "start();");
  // The modules that share settings.js's bindings run in its script, ahead of it.
  const settingsModules = SETTINGS_PAGE_MODULES.slice(0, -1).map(file => readFileSync(resolve(EXTENSION, file), "utf8")
    .replace(/^import[^;]+;\s*/gmu, "").replace(/^export\s+/gmu, "")).join("\n");
  const debugLog = readFileSync(resolve(EXTENSION, "debug-log.js"), "utf8").replace(/^export\s+/gmu, "");
  const errorText = readFileSync(resolve(EXTENSION, "error-text.js"), "utf8").replace(/^export\s+/gmu, "");
  window.TextEncoder ??= TextEncoder;
  for (const dialog of window.document.querySelectorAll("dialog")) {
    dialog.showModal ??= function showModal() {
      this.open = true;
      this.setAttribute("open", "");
    };
    dialog.close ??= function close(returnValue = "") {
      this.returnValue = returnValue;
      this.open = false;
      this.removeAttribute("open");
      this.dispatchEvent(new window.Event("close"));
    };
  }
  window.eval(
    `${externalLinks}\n${customButtonSettings}\n${readerOptions}\n${recommended.replace(/^export\s+/gmu, "")}\n${customDictionary}\n${managedSource}\n${groupState}\n${groups}\n${nameDrafts}\n${dictionaryProgress}\n${dictionaryImport}\n${importErrors}\nasync function readDictionaryArchiveIdentity(file) { return window.__readDictionaryArchiveIdentity(file); }\n${setupState}\n${settingsDom}\n${audioSettings}\n${ankiTemplates}\n${anki}\n${ankiSettings}\n${automaticBackups}\n${backupSettings}\n${experimentalSettings}\n${themeStore}\n${activationSettings}\n${memorySettings}\n${localFileAccess}\n${debugLog}\n${errorText}\n${settingsModules}\n${settings}`,
  );
}

const RECOMMENDED_DICTIONARIES = [
  {
    sourceId: "jitendex",
    name: "Jitendex",
    publisherUrl: "https://jitendex.org/",
    downloadUrl: "https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip",
    indexUrl: "https://jitendex.org/static/yomitan.json",
    githubRepositoryId: "744330420",
    requiredCapability: "term",
    title: "Jitendex.org [2026-08-11]",
    revision: "2026.08.11.0",
    capabilities: ["term", "media"],
  },
  {
    sourceId: "jmnedict",
    name: "JMnedict for Yomitan",
    publisherUrl: "https://github.com/yomidevs/jmdict-yomitan",
    downloadUrl: "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip",
    indexUrl: "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.json",
    githubRepositoryId: "696075636",
    requiredCapability: "term",
    title: "JMnedict [2026-09-04]",
    revision: "JMnedict.2026-09-04",
    capabilities: ["term"],
  },
  {
    sourceId: "bees-ultimate-kanji-dictionary",
    name: "Bee's Ultimate Kanji Dictionary",
    publisherUrl: "https://github.com/bee-san/bees-ultimate-kanji-dictionary",
    downloadUrl: "https://github.com/bee-san/bees-ultimate-kanji-dictionary/releases/latest/download/bees-ultimate-kanji-dictionary.zip",
    indexUrl: "https://raw.githubusercontent.com/bee-san/bees-ultimate-kanji-dictionary/main/dist/index.json",
    githubRepositoryId: "1335822804",
    requiredCapability: "term",
    title: "Bee's Ultimate Kanji Dictionary",
    revision: "2026.09.02",
    capabilities: ["term", "freq", "media"],
  },
  {
    sourceId: "jiten",
    name: "Jiten Frequency Dictionary",
    publisherUrl: "https://jiten.moe/frequency-dictionaries",
    downloadUrl: "https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan",
    indexUrl: "https://api.jiten.moe/api/frequency-list/index",
    githubRepositoryId: null,
    requiredCapability: "freq",
    title: "Jiten",
    revision: "Jiten 26-09-02",
    capabilities: ["freq"],
  },
  {
    sourceId: "bees-ultimate-grammar-dictionary",
    name: "Bee's Ultimate Grammar Dictionary",
    publisherUrl: "https://github.com/bee-san/bees-ultimate-grammar-dictionary",
    downloadUrl: "https://github.com/bee-san/bees-ultimate-grammar-dictionary/releases/latest/download/bees-ultimate-grammar-dictionary.zip",
    indexUrl: "https://raw.githubusercontent.com/bee-san/bees-ultimate-grammar-dictionary/main/dist/index.json",
    githubRepositoryId: "1363159785",
    requiredCapability: "term",
    title: "Bee's Ultimate Grammar Dictionary",
    revision: "2026.09.10",
    capabilities: ["term"],
  },
];

/* ------------------------------------------------------- renderer integration stage */

// jsdom is not a repo dependency: it lives in the same out-of-repo tree as
// puppeteer-core, so a checkout carries neither. ESM ignores NODE_PATH, hence
// resolving through require() before importing.
function jsdomSearchPaths() {
  return [
    ...(process.env.HACHIDORI_JSDOM ? [process.env.HACHIDORI_JSDOM] : []),
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(":").filter(Boolean) : []),
    ROOT,
    HERE,
    DEFAULT_JSDOM_TREE,
  ];
}

let jsdomFailure = "";

async function loadJsdom() {
  const paths = jsdomSearchPaths();
  let entry;
  try {
    entry = createRequire(import.meta.url).resolve("jsdom", { paths });
  } catch (error) {
    jsdomFailure = `could not resolve jsdom: ${error.message}`;
    return null;
  }
  try {
    const loaded = await import(`file://${entry}`);
    return loaded.JSDOM ? loaded : loaded.default;
  } catch (error) {
    // A jsdom that resolves but will not import is a broken install, not a
    // missing one, and the two need different fixes.
    jsdomFailure = `${entry} resolved but would not import: ${error.message}`;
    return null;
  }
}

async function navigateSettingsSection(window, id) {
  window.location.hash = id;
  await new Promise((done) => window.setTimeout(done, 10));
}

function loadStartupScript(window) {
  window.canDiscoverSharingHost = canDiscoverSharingHost;
  window.eval(readFileSync(resolve(EXTENSION, "settings-dom.js"), "utf8").replace(/^export\s+/gmu, ""));
  window.eval(readFileSync(resolve(EXTENSION, "recommended-install-client.js"), "utf8").replace(/^export\s+/gmu, ""));
  const readerOptions = readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8");
  const localAudioSource = readFileSync(resolve(EXTENSION, "local-audio-source.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  window.eval(readFileSync(resolve(EXTENSION, "visual-novel.js"), "utf8"));
  const recommended = readFileSync(resolve(EXTENSION, "recommended-dictionaries.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const managedSource = readFileSync(resolve(EXTENSION, "managed-dictionary-source.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const setupState = readFileSync(resolve(EXTENSION, "setup-state.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const localFileAccess = readFileSync(resolve(EXTENSION, "local-file-access.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const practice = readFileSync(resolve(EXTENSION, "startup-practice.js"), "utf8")
    .replace(/import\s*\{[^}]+\}\s*from\s*"\.\/local-file-access\.js";\s*/u, "")
    .replace(/import "\.\/reader-options\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const dictionaryProgress = readFileSync(resolve(EXTENSION, "dictionary-progress.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const errorText = readFileSync(resolve(EXTENSION, "error-text.js"), "utf8").replace(/^export\s+/gmu, "");
  const startup = readFileSync(resolve(EXTENSION, "startup.js"), "utf8")
    .replace(/^import .* from "\.\/(?:settings-dom|sharing-protocol|error-text)\.js";\s*/gmu, "")
    .replace(/^import .* from "\.\/recommended-install-client\.js";\s*/gmu, "")
    .replace(/import "\.\/reader-options\.js";\s*/u, "")
    .replace(/import "\.\/visual-novel\.js";\s*/u, "")
    .replace(/import \{ findLocalAudioSource \} from "\.\/local-audio-source\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/dictionary-progress\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/managed-dictionary-source\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/setup-state\.js";\s*/u, "")
    .replace(/import\s*\{[^}]+\}\s*from\s*"\.\/startup-practice\.js";\s*/u, "");
  // startup.js is a module with a top-level await; an async wrapper keeps that
  // legal in a classic-script eval and surfaces a load failure through its promise.
  return window.eval(`(async () => {\n${readerOptions}\n${localAudioSource}\n${recommended}\n${managedSource}\n${dictionaryProgress}\n${setupState}\n${localFileAccess}\n${practice}\n${errorText}\n${startup}\n})()`);
}

const mjs = resolve(EXTENSION, "vendor/hoshidicts.mjs");
const wasm = resolve(EXTENSION, "vendor/hoshidicts.wasm");

before(() => {
  if (!existsSync(mjs) || !existsSync(wasm)) {
    console.error(`missing ${mjs}\nmissing ${wasm}\nBuild the wasm module first: ./wasm/build.sh`);
    process.exit(2);
  }
  if (!existsSync(FIXTURE)) {
    console.error(`missing ${FIXTURE}\nGenerate the fixtures first: node test/make-fixture.mjs`);
    process.exit(2);
  }
});

export {
  createDeclaredLengthURL, createObjectURL, DEFAULT_JSDOM_TREE, DICTIONARY_PACKAGE_KEYS,
  existingOffscreenStage, EXTENSION, EXTENSION_MANIFEST, EXTENSION_ORIGIN, FakeSharingSocket,
  FIXTURE, FIXTURE_TITLE, genericPackage, HERE, installFakeIndexedDB, installFetch,
  installNavigator, jsdomFailure, jsdomSearchPaths, loadBackgroundScript, loadClassicScript,
  loadJsdom, loadSettingsScript, loadStartupScript, makeAlarms, makeBus, makeChrome, makeEvent,
  makeStorage, mjs, navigateSettingsSection, offscreenState, ownedGenerationRoot,
  RECOMMENDED_DICTIONARIES, remoteArchive, remoteJson, remoteResponses, ROOT, settleSharing,
  shareWithLinkedReader,
};
