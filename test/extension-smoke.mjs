/*
 * Drives the extension's own JavaScript against the real wasm engine.
 *
 * node-smoke.mjs proves the C ABI; this proves the layer above it: that
 * background.js relays, that offscreen.js answers every message type in
 * contract C with the documented reply shape, and that the engine's contract-B
 * JSON survives a trip through the ported renderer.
 *
 * Nothing here is a browser. The fakes cover only the Chrome surface the
 * extension actually touches, so this catches typo'd message names, wrong reply
 * shapes, unhandled rejections and renderer/engine field mismatches -- not
 * Chrome's own acceptance of the manifest, offscreen documents, IndexedDB or
 * MV3 CSP.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// The trained fixture is built in memory rather than read out of test/fixtures:
// the .zip on disk is only there for the browser test, which needs a real file to
// hand to an <input type=file>.
import {
  EXPECTED,
  TRAINED_TERMS,
  TRAINED_TITLE,
  buildRecommendedZip,
  buildTitledZip,
  buildTrainedZip,
} from "./make-fixture.mjs";
import { recommendedIndexUrlMatches } from "../extension/managed-dictionary-source.js";
import { RECOMMENDED_DICTIONARIES as RECOMMENDED_CATALOGUE } from "../extension/recommended-dictionaries.js";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_SOURCE_KEY,
  CUSTOM_DICTIONARY_TITLE,
  buildCustomDictionaryZip,
  customDictionarySemanticRevision,
  parseCustomDictionary,
} from "../extension/custom-dictionary.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXTENSION = resolve(ROOT, "extension");
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
  "id",
  "indexUrl",
  "installedAt",
  "isUpdatable",
  "kanjiCount",
  "language",
  "lastUpdateCheck",
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

let passed = 0;
let failed = 0;

function pass(what) {
  passed += 1;
  console.log(`  PASS  ${what}`);
}

function fail(what, detail) {
  failed += 1;
  console.log(`  FAIL  ${what}`);
  for (const line of String(detail).split("\n")) {
    console.log(`        ${line}`);
  }
}

function check(what, condition, detail = "") {
  if (condition) {
    pass(what);
  } else {
    fail(what, detail || "condition was false");
  }
}

function equal(what, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(what, a === b, `expected: ${b}\nactual:   ${a}`);
}

function section(name) {
  console.log(`\n# ${name}`);
}

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

  function sendMessage(owner, message) {
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
          keepOpen = entry.fn(message, { id: "smoke" }, respond);
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
  return {
    api: {
      async clear(name) {
        return values.delete(name);
      },
      create(name, info) {
        values.set(name, { name, ...structuredClone(info) });
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
    values,
  };
}

const offscreenState = { created: 0, exists: false, concurrent: 0, peakConcurrent: 0 };

function makeChrome(owner, bus, storage, alarms = makeAlarms()) {
  const onInstalled = makeEvent();
  const onStartup = makeEvent();
  return {
    alarms: alarms.api,
    __events: { onInstalled, onStartup },
    runtime: {
      id: "hachidorismokeextensionid",
      lastError: undefined,
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
      sendMessage(message, callback) {
        const promise = bus.sendMessage(owner, message);
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

function loadBackgroundScript(sandbox) {
  const recommended = readFileSync(resolve(EXTENSION, "recommended-dictionaries.js"), "utf8");
  const customDictionary = readFileSync(resolve(EXTENSION, "custom-dictionary.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const jsonValue = readFileSync(resolve(EXTENSION, "json-value.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const lookupResponse = readFileSync(resolve(EXTENSION, "lookup-response.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const managedSource = readFileSync(resolve(EXTENSION, "managed-dictionary-source.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "");
  const background = readFileSync(resolve(EXTENSION, "background.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/managed-dictionary-source\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/custom-dictionary\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/json-value\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/lookup-response\.js";\s*/u, "");
  sandbox.TextEncoder ??= TextEncoder;
  sandbox.Uint8Array ??= Uint8Array;
  sandbox.Uint32Array ??= Uint32Array;
  sandbox.DataView ??= DataView;
  sandbox.crypto ??= globalThis.crypto;
  const context = createContext(sandbox);
  context.globalThis = context;
  runInContext(
    `${recommended.replace(/^export\s+/gmu, "")}\n`
      + `${customDictionary}\n${jsonValue}\n${lookupResponse}\n`
      + `${managedSource.replace(/^export\s+/gmu, "")}\n${background}`,
    context,
    { filename: resolve(EXTENSION, "background.js") },
  );
  return context;
}

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
      const reply = await pageChrome.runtime.sendMessage(message);
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

function loadSettingsScript(window) {
  const recommended = readFileSync(resolve(EXTENSION, "recommended-dictionaries.js"), "utf8");
  const customDictionary = readFileSync(resolve(EXTENSION, "custom-dictionary.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const managedSource = readFileSync(resolve(EXTENSION, "managed-dictionary-source.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/^export\s+/gmu, "");
  const groups = readFileSync(resolve(EXTENSION, "dictionary-groups.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const settings = readFileSync(resolve(EXTENSION, "settings.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/dictionary-groups\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/managed-dictionary-source\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/custom-dictionary\.js";\s*/u, "");
  window.TextEncoder ??= TextEncoder;
  window.eval(
    `${recommended.replace(/^export\s+/gmu, "")}\n${customDictionary}\n${managedSource}\n${groups}\n${settings}`,
  );
}

// content.js cannot be driven here (it needs a page), so the one thing worth
// checking statically is that the layers clamping an option agree on its range.
// They are four separate literals, and a narrower one in the content script
// silently shrinks the result set the options page accepted and stored.
const OPTION_RANGES = [
  [
    "maxResults",
    [
      ["content.js", /maxResults:\s*clampInteger\(\s*source\.maxResults,\s*(\d+),\s*(\d+)/u],
      ["settings.js", /key:\s*"maxResults",[^}]*?min:\s*(\d+),\s*max:\s*(\d+)/u],
      ["settings.html", /id="opt-max-results"[^>]*?min="(\d+)"[^>]*?max="(\d+)"/u],
      ["engine-service.js", /clampInt\(\s*message\.maxResults,\s*(\d+),\s*(\d+)/u],
    ],
  ],
  [
    "scanLength",
    [
      ["content.js", /scanLength:\s*clampInteger\(\s*source\.scanLength,\s*(\d+),\s*(\d+)/u],
      ["settings.js", /key:\s*"scanLength",[^}]*?min:\s*(\d+),\s*max:\s*(\d+)/u],
      ["settings.html", /id="opt-scan-length"[^>]*?min="(\d+)"[^>]*?max="(\d+)"/u],
      ["engine-service.js", /clampInt\(\s*message\.scanLength,\s*(\d+),\s*(\d+)/u],
    ],
  ],
];

function checkOptionRanges() {
  for (const [option, layers] of OPTION_RANGES) {
    const ranges = [];
    for (const [file, pattern] of layers) {
      const found = pattern.exec(readFileSync(resolve(EXTENSION, file), "utf8"));
      if (found === null) {
        fail(
          `${file} declares a ${option} range`,
          `nothing matched ${pattern}; if the clamp moved, move this check with it`,
        );
        continue;
      }
      ranges.push(`${file} ${found[1]}..${found[2]}`);
    }
    check(
      `every layer clamps ${option} to the same range`,
      new Set(ranges.map((range) => range.split(" ")[1])).size === 1,
      ranges.join("\n"),
    );
  }
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
];

function checkRecommendedDictionaries() {
  const cataloguePath = resolve(EXTENSION, "recommended-dictionaries.js");
  if (!existsSync(cataloguePath)) {
    fail("the recommended catalogue exists", `${cataloguePath} is missing`);
    return;
  }
  pass("the recommended catalogue exists");
  const manifest = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"));
  check(
    "the extension requests the browser alarm permission for managed updates",
    manifest.permissions?.includes("alarms") === true,
    JSON.stringify(manifest.permissions),
  );
  const catalogueContract = (entry) => ({
    sourceId: entry.sourceId,
    name: entry.name,
    publisherUrl: entry.publisherUrl,
    downloadUrl: entry.downloadUrl,
    indexUrl: entry.indexUrl,
    githubRepositoryId: entry.githubRepositoryId,
    requiredCapability: entry.requiredCapability,
  });
  const actual = RECOMMENDED_CATALOGUE.map(catalogueContract);
  const expected = RECOMMENDED_DICTIONARIES.map(catalogueContract);
  check(
    "the catalogue names exactly four trusted recommendations and their publishers",
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual),
  );
  const html = readFileSync(resolve(EXTENSION, "settings.html"), "utf8");
  check(
    "settings has one clean-install action and a distinct partial retry action",
    (html.match(/id="install-recommended"/gu) ?? []).length === 1
      && (html.match(/Install all recommended dictionaries/gu) ?? []).length === 1
      && (html.match(/id="retry-recommended"/gu) ?? []).length === 1,
    "the starter/retry controls were missing or duplicated",
  );
  check(
    "settings keeps local import outside the hideable starter card",
    html.indexOf('id="import-file"') < html.indexOf('id="recommended-starter"'),
    "the local picker moved inside the starter card",
  );
}

function checkDictionaryGroupModule() {
  const groups = readFileSync(resolve(EXTENSION, "dictionary-groups.js"), "utf8");
  const settings = readFileSync(resolve(EXTENSION, "settings.js"), "utf8");
  check(
    "settings imports its dictionary-group module",
    groups.includes("export function createDictionaryGroupController")
      && groups.includes("export function normaliseDictionaryGroups")
      && settings.includes('from "./dictionary-groups.js"'),
    settings.slice(0, 240),
  );
}

async function main() {
  const mjs = resolve(EXTENSION, "vendor/hoshidicts.mjs");
  const wasm = resolve(EXTENSION, "vendor/hoshidicts.wasm");
  if (!existsSync(mjs) || !existsSync(wasm)) {
    console.error(`missing ${mjs}\nmissing ${wasm}\nBuild the wasm module first: ./wasm/build.sh`);
    process.exit(2);
  }
  if (!existsSync(FIXTURE)) {
    console.error(`missing ${FIXTURE}\nGenerate the fixtures first: node test/make-fixture.mjs`);
    process.exit(2);
  }

  section("option ranges");
  checkOptionRanges();

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

  section("managed custom dictionary engine transaction");
  await customEngineStage();

  section("recommended dictionaries");
  checkRecommendedDictionaries();
  checkDictionaryGroupModule();

  // Only chrome.runtime exists in an offscreen document. A path that is never
  // exercised below would still be a boot failure in a browser, so this is a
  // static check as well as a runtime one.
  const offscreenSource = readFileSync(resolve(EXTENSION, "offscreen.js"), "utf8");
  const offscreenApis = [...offscreenSource.matchAll(/\bchrome\.([A-Za-z_$][\w$]*)/gu)].map((m) => m[1]);
  check(
    "offscreen.js uses no chrome API beyond chrome.runtime",
    offscreenApis.every((api) => api === "runtime"),
    [...new Set(offscreenApis)].join(", "),
  );
  check(
    "runtime selection depends on capabilities rather than stored dictionaries",
    !offscreenSource.includes("hd_dicts_read") && !offscreenSource.includes("opfsDictionaryTitles"),
    "offscreen.js still contains legacy-storage selection logic",
  );
  check(
    "the threaded bridge places a hard bound on pending engine requests",
    /pending\.size\s*>=\s*MAX_PENDING_REQUESTS/u.test(offscreenSource)
      && /message\?\.type\s*===\s*"hd_status"/u.test(offscreenSource),
    "offscreen.js does not cap its pending map while preserving status replies",
  );
  const probePath = resolve(EXTENSION, "opfs-capability-worker.js");
  const probeSource = existsSync(probePath) ? readFileSync(probePath, "utf8") : "";
  check(
    "threaded selection probes the exact OPFS primitives WasmFS needs",
    offscreenSource.includes("opfs-capability-worker.js")
      && probeSource.includes("createSyncAccessHandle")
      && probeSource.includes(".move("),
    "the direct-OPFS path lacks a worker-side sync-access and move probe",
  );
  check(
    "the OPFS probe uses collision-resistant temporary names",
    probeSource.includes("crypto.randomUUID()") && !probeSource.includes("Math.random()"),
    "the OPFS probe still derives a temporary path from Math.random()",
  );
  const engineServiceSource = readFileSync(resolve(EXTENSION, "engine-service.js"), "utf8");
  check(
    "fallback imports keep scratch archives outside the dictionary-title namespace",
    engineServiceSource.includes('const IMPORT_ZIP = "/.hdw-archive.zip";')
      && engineServiceSource.includes("const OPFS_IMPORT_ZIP = `${DICT_ROOT}/.hdw-archive.zip`;"),
    "the fallback import archive can collide with a dictionary title",
  );
  const bindingsSource = readFileSync(resolve(ROOT, "wasm/bindings.cpp"), "utf8");
  check(
    "the OPFS durability barrier opens writable sync-access handles before fsync",
    /open\(path\.c_str\(\), O_RDWR\)/u.test(bindingsSource)
      && !/open\(path\.c_str\(\), O_RDONLY\)/u.test(bindingsSource),
    "flush_file can still select WasmFS's non-flushing Blob path",
  );
  check(
    "replacement commit state remains outside the backup being deleted",
    bindingsSource.includes("destination / NEW_COMMITTED")
      && !bindingsSource.includes("aside / NEW_COMMITTED"),
    "the durable replacement marker is not anchored in the destination",
  );

  const idb = installFakeIndexedDB();
  installFetch();
  installNavigator();

  const bus = makeBus();
  const storage = makeStorage();
  const alarms = makeAlarms();

  // offscreen.js is a real ES module, so it reads `chrome` off the shared global;
  // the scripts loaded into a vm context get their own chrome.
  //
  // A real offscreen document is granted chrome.runtime and nothing else --
  // Object.keys(chrome) there is csi,loadTimes,runtime, and getContexts is absent
  // too. Withholding the rest is what lets this harness catch a call that only
  // fails in a browser: offscreen.js reading chrome.storage.local looked correct
  // here for as long as the fake handed it one.
  const offscreenChrome = makeChrome("offscreen", bus, storage, alarms);
  delete offscreenChrome.storage;
  delete offscreenChrome.offscreen;
  delete offscreenChrome.runtime.getContexts;
  globalThis.chrome = offscreenChrome;

  const swChrome = makeChrome("sw", bus, storage, alarms);
  loadBackgroundScript({
    chrome: swChrome,
    console,
    fetch: globalThis.fetch,
    setTimeout,
    clearTimeout,
    Promise,
    Error,
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

  const pageChrome = makeChrome("page", bus, storage, alarms);
  const writeReaderOptions = (baseRevision, options) => pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_options_write",
    baseRevision,
    options,
  });
  const firstOptions = await writeReaderOptions(0, { scanLength: 12, maxResults: 24 });
  const [nextOptions, conflictingOptions] = await Promise.all([
    writeReaderOptions(1, { scanLength: 18 }),
    writeReaderOptions(1, { maxResults: 48 }),
  ]);
  const unchangedOptions = await writeReaderOptions(2, { scanLength: 18 });
  const unversionedOptions = await writeReaderOptions(undefined, { scanLength: 2 });
  check(
    "reader options use serialized revision-checked patches and preserve unchanged revisions",
    firstOptions.ok === true && firstOptions.options?.revision === 1
      && nextOptions.ok === true && nextOptions.options?.revision === 2
      && nextOptions.options?.maxResults === 24
      && conflictingOptions.ok === false && conflictingOptions.conflict === true
      && conflictingOptions.options?.scanLength === 18
      && conflictingOptions.options?.maxResults === 24
      && unchangedOptions.ok === true && unchangedOptions.options?.revision === 2
      && unversionedOptions.ok === false,
    JSON.stringify({ firstOptions, nextOptions, conflictingOptions, unchangedOptions, unversionedOptions }),
  );
  let counter = 0;
  async function request(type, fields = {}) {
    counter += 1;
    return pageChrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type,
      requestId: `${type.replace(/^hd_/u, "")}-${counter}`,
      ...fields,
    });
  }

  await import(`file://${mjs.replace(/\\/gu, "/")}`); // fail fast if the bundle is broken
  const engineService = await import(
    `file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}`
  );
  const formerArchiveByteLimit = 536870912;
  const streamChunk = new Uint8Array(1024 * 1024);
  let streamRemaining = formerArchiveByteLimit + 1;
  let streamedBytes = 0;
  let streamClosed = false;
  let streamUnlinked = false;
  let streamed = null;
  let streamError = null;
  try {
    streamed = await engineService.streamResponseToFile(
      {
        open: () => ({}),
        write(_stream, _value, _offset, length) {
          streamedBytes += length;
          return length;
        },
        close() {
          streamClosed = true;
        },
        unlink() {
          streamUnlinked = true;
        },
      },
      {
        body: {
          getReader: () => ({
            async read() {
              if (streamRemaining === 0) return { done: true, value: undefined };
              const value = streamRemaining >= streamChunk.byteLength
                ? streamChunk
                : streamChunk.subarray(0, streamRemaining);
              streamRemaining -= value.byteLength;
              return { done: false, value };
            },
          }),
        },
      },
      "/streamed-boundary.zip",
    );
  } catch (error) {
    streamError = error;
  }
  equal(
    "an actual streamed body crosses the former fixed byte cap",
    [streamError?.message ?? null, streamed, streamedBytes, streamClosed, streamUnlinked],
    [null, formerArchiveByteLimit + 1, formerArchiveByteLimit + 1, true, false],
  );
  const { default: createHoshidicts } = await import(
    `file://${resolve(EXTENSION, "vendor", "hoshidicts.mjs").replace(/\\/gu, "/")}?service`
  );
  let forwardedLowRam = null;
  let observedEngine = null;
  let loadedDictionaryPaths = new Set();
  let peakLoadedDictionaryPaths = 0;
  const createObservedHoshidicts = async (...args) => {
    const module = await createHoshidicts(...args);
    observedEngine = module;
    const ccall = module.ccall.bind(module);
    module.ccall = (name, returnType, argumentTypes, argumentValues) => {
      if (name === "hdw_import") {
        forwardedLowRam = argumentValues[2];
      }
      const result = ccall(name, returnType, argumentTypes, argumentValues);
      if (name === "hdw_reset") {
        loadedDictionaryPaths = new Set();
      } else if (name === "hdw_add_dict" && result) {
        loadedDictionaryPaths.add(argumentValues[0]);
        peakLoadedDictionaryPaths = Math.max(
          peakLoadedDictionaryPaths,
          loadedDictionaryPaths.size,
        );
      }
      return result;
    };
    return module;
  };
  let loseNextStateCasReply = false;
  let failAfterCommittedRevision = null;
  let advanceGroupsAfterCommittedRevision = null;
  let advancedStateDuringCleanup = null;
  engineService.configureEngineService(
    async (message) => {
      const reply = await offscreenChrome.runtime.sendMessage(message);
      if (message.type === "hd_state_cas"
          && reply?.ok === true
          && advanceGroupsAfterCommittedRevision !== null
          && reply.state?.dictionaries?.some(
            (dictionary) => dictionary.revision === advanceGroupsAfterCommittedRevision.revision,
          )) {
        const advance = advanceGroupsAfterCommittedRevision;
        advanceGroupsAfterCommittedRevision = null;
        advancedStateDuringCleanup = await offscreenChrome.runtime.sendMessage({
          target: "hoshidicts-worker",
          type: "hd_state_cas",
          baseRevision: reply.state.revision,
          dictionaries: reply.state.dictionaries,
          groups: advance.groups,
        });
      }
      if (loseNextStateCasReply && message.type === "hd_state_cas") {
        loseNextStateCasReply = false;
        throw new Error("injected lost CAS reply");
      }
      if (message.type === "hd_state_cas"
          && reply?.ok === true
          && failAfterCommittedRevision !== null
          && reply.state?.dictionaries?.some(
            (dictionary) => dictionary.revision === failAfterCommittedRevision.revision,
          )) {
        storage.failNextSet(failAfterCommittedRevision.error);
        failAfterCommittedRevision = null;
      }
      return reply;
    },
    { createHoshidicts: createObservedHoshidicts, storageBackend: "idbfs", lowRam: true },
  );
  engineService.startEngine();
  offscreenChrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "hoshidicts-offscreen" || message.relayed !== true) return false;
    engineService.handleEngineMessage(message).then(sendResponse);
    return true;
  });

  section("boot and relay");
  let status = await request("hd_status");
  equal("hd_status replies with the contract-C envelope", Object.keys(status).sort(), [
    "dictionaryCount",
    "error",
    "generation",
    "loading",
    "ok",
    "ready",
    "requestId",
    "storageBackend",
    "threaded",
    "type",
  ]);
  check("hd_status echoes the requestId", status.requestId === "status-1", JSON.stringify(status));
  check(
    "the fallback reports single-thread IDBFS",
    status.storageBackend === "idbfs" && status.threaded === false,
    JSON.stringify(status),
  );

  const deadline = Date.now() + 30000;
  while (!(status.ok && status.ready && !status.loading) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
    status = await request("hd_status");
  }
  check("the engine reaches ready", status.ready === true, JSON.stringify(status));
  check("the offscreen document was created exactly once", offscreenState.created === 1, `created ${offscreenState.created}`);
  check(
    "createDocument was never called concurrently",
    offscreenState.peakConcurrent <= 1,
    `peak ${offscreenState.peakConcurrent}`,
  );
  check(
    "background.js stamps relayed on the forwarded copy only",
    bus.log.some((row) => row.from === "sw" && row.relayed) &&
      bus.log.every((row) => row.from !== "page" || !row.relayed),
    JSON.stringify(bus.log.slice(0, 6)),
  );
  const originalWorkerSend = swChrome.runtime.sendMessage;
  swChrome.runtime.sendMessage = (message) => message.relayed && message.type === "hd_lookup"
    ? Promise.reject(new Error("long relay failure ".repeat(20))) : originalWorkerSend(message);
  try {
    const responseLimit = 32 * 1024 * 1024;
    const sendFailedLookup = (requestId) => pageChrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_lookup", text: "食", requestId,
    });
    const oversized = await sendFailedLookup("x".repeat(responseLimit));
    const invalid = await sendFailedLookup({});
    const compact = { ...oversized, requestId: "" };
    const exactId = "x".repeat(responseLimit - Buffer.byteLength(JSON.stringify(compact)));
    const correlated = await sendFailedLookup(exactId);
    check(
      "service-worker relay failures use the shared bounded lookup correlation rule",
      oversized.ok === false && oversized.requestId === null && invalid.requestId === null
        && correlated.ok === false && correlated.requestId === exactId
        && correlated.error === compact.error
        && Buffer.byteLength(JSON.stringify(correlated)) === responseLimit,
      JSON.stringify({ oversizedOk: oversized.ok, correlated: correlated.requestId === exactId }),
    );
  } finally {
    swChrome.runtime.sendMessage = originalWorkerSend;
  }

  section("storage ownership and hd_import");
  // The engine's view of this key goes offscreen -> worker -> chrome.storage,
  // while this harness can inspect the worker-owned storage map directly.
  const storedDictionaryState = async () =>
    (await storage.api().local.get("dictionaryState")).dictionaryState;
  equal("an empty profile has revisioned dictionary state", await storedDictionaryState(), {
    schemaVersion: 1,
    revision: 1,
    dictionaries: [],
    groups: [],
  });
  const readBack = await pageChrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_read" });
  equal(
    "the service worker answers hd_state_read without relaying it",
    [readBack?.ok, readBack?.state, bus.log.some((row) => row.type === "hd_state_read" && row.relayed)],
    [true, { schemaVersion: 1, revision: 1, dictionaries: [], groups: [] }, false],
  );

  const zip = new Uint8Array(await readFile(FIXTURE));
  const blobUrl = createObjectURL(zip);
  const imported = await request("hd_import", { blobUrl, fileName: "hachidori-fixture.zip", lowRam: false });
  check("hd_import succeeds", imported.ok === true, JSON.stringify(imported));
  equal("hd_import forwards its request-level lowRam override", forwardedLowRam, 0);
  equal("hd_import_result carries the full ImportReport", Object.keys(imported.report ?? {}).sort(), [
    "error",
    "frequencyCount",
    "kanjiCount",
    "mediaCount",
    "metaCount",
    "pitchCount",
    "success",
    "termCount",
    "title",
  ]);
  equal(
    "the report counts match the fixture baseline",
    [
      imported.report.title,
      imported.report.termCount,
      imported.report.metaCount,
      imported.report.frequencyCount,
      imported.report.pitchCount,
      imported.report.kanjiCount,
      imported.report.mediaCount,
    ],
    [
      EXPECTED.title,
      EXPECTED.termCount,
      EXPECTED.metaCount,
      EXPECTED.frequencyCount,
      EXPECTED.pitchCount,
      EXPECTED.kanjiCount,
      EXPECTED.mediaCount,
    ],
  );

  // The fixture carries four engine capabilities, but it is one installed
  // package. The native dictionaryCount below deliberately remains four.
  const importedState = await storedDictionaryState();
  const importedPackage = importedState?.dictionaries?.[0];
  check(
    "the import writes one logical dictionary package with complete metadata",
    importedState?.schemaVersion === 1
      && Number.isInteger(importedState.revision)
      && importedState.revision > 0
      && importedState.dictionaries.length === 1
      && JSON.stringify(Object.keys(importedPackage ?? {}).sort()) === JSON.stringify(DICTIONARY_PACKAGE_KEYS)
      && /^[0-9a-f]{32}$/u.test(importedPackage?.id ?? "")
      && importedPackage.title === FIXTURE_TITLE
      && importedPackage.displayName === null
      && ownedGenerationRoot(importedPackage.path, FIXTURE_TITLE) !== ""
      && importedPackage.enabled === true
      && importedPackage.favorite === false
      && importedPackage.revision === "test-1"
      && importedPackage.isUpdatable === false
      && importedPackage.indexUrl === null
      && importedPackage.downloadUrl === null
      && importedPackage.language === "ja"
      && importedPackage.termCount === EXPECTED.termCount
      && importedPackage.frequencyCount === EXPECTED.frequencyCount
      && importedPackage.pitchCount === EXPECTED.pitchCount
      && importedPackage.kanjiCount === EXPECTED.kanjiCount
      && importedPackage.mediaCount === EXPECTED.mediaCount
      && typeof importedPackage.installedAt === "string"
      && Number.isFinite(Date.parse(importedPackage.installedAt))
      && importedPackage.lastUpdateCheck === null,
    JSON.stringify(importedState),
  );
  const afterLogicalImport = await request("hd_status");
  equal("one logical package loads all four native capabilities", afterLogicalImport.dictionaryCount, 4);
  check("syncfs(false) wrote the dictionary to IndexedDB", idb.count("/dicts") > 0, `${idb.count("/dicts")} rows in ${idb.names()}`);

  section("trusted recommended imports");
  const recommended = RECOMMENDED_DICTIONARIES[0];
  const recommendedFields = {
    sourceId: recommended.sourceId,
    finalUrl: `https://release-assets.githubusercontent.com/github-production-release-asset/${recommended.githubRepositoryId}/asset`
      + "?response-content-disposition=attachment%3B%20filename%3Djitendex-yomitan.zip",
  };
  const recommendedArchive = (overrides = {}) => createObjectURL(buildRecommendedZip({
    title: recommended.title,
    revision: recommended.revision,
    indexUrl: recommended.indexUrl,
    downloadUrl: recommended.downloadUrl,
    capabilities: recommended.capabilities,
    ...overrides,
  }));
  const rejectRecommended = async (name, fields, overrides, importedTitle) => {
    const before = await storedDictionaryState();
    const rowsBefore = idb.keys("/dicts").filter((path) => path.includes("/dicts/.hdw-generation-")).sort();
    const reply = await request("hd_import", {
      blobUrl: recommendedArchive(overrides),
      fileName: `${name}.zip`,
      ...fields,
    });
    const after = await storedDictionaryState();
    const rowsAfter = idb.keys("/dicts").filter((path) => path.includes("/dicts/.hdw-generation-")).sort();
    check(
      name,
      reply.ok === false
        && JSON.stringify(after) === JSON.stringify(before)
        && JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore),
      JSON.stringify({ reply, before, after, rowsBefore, rowsAfter }),
    );
    // Keeps this stage isolated when run against a pre-feature engine during
    // test-first development, where the trust fields are simply ignored.
    await request("hd_remove", { title: importedTitle });
  };
  await rejectRecommended(
    "recommended import rejects an unknown catalogue source before publication",
    { sourceId: "not-in-the-catalogue", finalUrl: recommended.downloadUrl },
    {},
    recommended.title,
  );
  await rejectRecommended(
    "recommended import rejects a final URL outside its catalogue entry",
    { sourceId: recommended.sourceId, finalUrl: "https://example.invalid/not-jitendex.zip" },
    {},
    recommended.title,
  );
  await rejectRecommended(
    "recommended import rejects a release asset from another repository",
    {
      sourceId: recommended.sourceId,
      finalUrl: "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset"
        + "?response-content-disposition=attachment%3B%20filename%3Djitendex-yomitan.zip",
    },
    {},
    recommended.title,
  );
  await rejectRecommended(
    "recommended import rejects a mismatched title before publication",
    recommendedFields,
    { title: "Not Jitendex" },
    "Not Jitendex",
  );
  await rejectRecommended(
    "recommended import rejects mismatched capabilities before publication",
    recommendedFields,
    { capabilities: ["freq"] },
    recommended.title,
  );

  const trustedImport = await request("hd_import", {
    blobUrl: recommendedArchive({ capabilities: ["term", "freq", "media"] }),
    fileName: "jitendex-yomitan.zip",
    ...recommendedFields,
    // Message-owned metadata must never override the built-in catalogue.
    catalogue: {
      indexUrl: "https://example.invalid/forged-index.json",
      downloadUrl: "https://example.invalid/forged.zip",
    },
  });
  const trustedState = await storedDictionaryState();
  const trustedPackage = trustedState.dictionaries.find(
    (dictionary) => dictionary.sourceId === recommended.sourceId,
  );
  check(
    "recommended import publishes its revision and catalogue-owned source atomically",
    trustedImport.ok === true
      && trustedImport.report?.success === true
      && trustedPackage?.title === recommended.title
      && trustedPackage?.revision === recommended.revision
      && trustedPackage?.sourceId === recommended.sourceId
      && trustedPackage?.isUpdatable === true
      && trustedPackage?.indexUrl === recommended.indexUrl
      && trustedPackage?.downloadUrl === recommended.downloadUrl
      && trustedPackage?.termCount === 1
      && trustedPackage?.frequencyCount === 1
      && trustedPackage?.mediaCount === 1,
    JSON.stringify({ trustedImport, trustedState }),
  );
  const trustedIndex = trustedState.dictionaries.findIndex(
    (dictionary) => dictionary.sourceId === recommended.sourceId,
  );
  const presentedState = await request("hd_apply_state", {
    baseRevision: trustedState.revision,
    dictionaries: trustedState.dictionaries.map((dictionary, index) => index === trustedIndex
      ? { ...dictionary, displayName: "Starter terms", enabled: false, favorite: true }
      : dictionary),
  });
  const updatedTitle = "Jitendex.org [2026-09-05]";
  const updatedRevision = "2026.09.05.0";
  const updatedImport = await request("hd_import", {
    blobUrl: recommendedArchive({ title: updatedTitle, revision: updatedRevision }),
    fileName: "jitendex-yomitan.zip",
    ...recommendedFields,
  });
  const updatedState = await storedDictionaryState();
  const updatedPackage = updatedState.dictionaries[trustedIndex];
  check(
    "a dated recommended update preserves package identity, order, and presentation",
    presentedState.ok === true
      && updatedImport.ok === true
      && updatedState.dictionaries.length === trustedState.dictionaries.length
      && updatedPackage?.id === trustedPackage.id
      && updatedPackage?.title === updatedTitle
      && updatedPackage?.revision === updatedRevision
      && updatedPackage?.sourceId === recommended.sourceId
      && updatedPackage?.displayName === "Starter terms"
      && updatedPackage?.enabled === false
      && updatedPackage?.favorite === true,
    JSON.stringify({ presentedState, updatedImport, updatedState }),
  );
  const localUpdateTitle = "Jitendex.org [2026-09-06]";
  const localUpdateRevision = "2026.09.06.0";
  const localUpdateImport = await request("hd_import", {
    blobUrl: recommendedArchive({ title: localUpdateTitle, revision: localUpdateRevision }),
    fileName: "jitendex-yomitan.zip",
  });
  const localUpdateState = await storedDictionaryState();
  const localUpdatePackage = localUpdateState.dictionaries[trustedIndex];
  check(
    "a local managed reimport matches its index URL and preserves catalogue identity",
    localUpdateImport.ok === true
      && localUpdateState.dictionaries.length === trustedState.dictionaries.length
      && localUpdatePackage?.id === trustedPackage.id
      && localUpdatePackage?.title === localUpdateTitle
      && localUpdatePackage?.revision === localUpdateRevision
      && localUpdatePackage?.sourceId === recommended.sourceId
      && localUpdatePackage?.displayName === "Starter terms"
      && localUpdatePackage?.enabled === false
      && localUpdatePackage?.favorite === true,
    JSON.stringify({ localUpdateImport, localUpdateState }),
  );
  const collisionRowsBefore = idb.keys("/dicts")
    .filter((path) => path.includes("/dicts/.hdw-generation-"))
    .sort();
  const collidingLocalReimport = await request("hd_import", {
    blobUrl: recommendedArchive({
      title: FIXTURE_TITLE,
      revision: "2026.09.06.collision",
    }),
    fileName: "colliding-local-reimport.zip",
  });
  const collisionState = await storedDictionaryState();
  const collisionRowsAfter = idb.keys("/dicts")
    .filter((path) => path.includes("/dicts/.hdw-generation-"))
    .sort();
  check(
    "a local reimport matched by source cannot take another package's canonical title",
    collidingLocalReimport.ok === false
      && collidingLocalReimport.error?.includes("already installed")
      && JSON.stringify(collisionState) === JSON.stringify(localUpdateState)
      && JSON.stringify(collisionRowsAfter) === JSON.stringify(collisionRowsBefore),
    JSON.stringify({
      collidingLocalReimport,
      localUpdateState,
      collisionState,
      collisionRowsBefore,
      collisionRowsAfter,
    }),
  );
  const managedReload = await request("hd_reload");
  const reloadedManagedState = await storedDictionaryState();
  const reloadedManagedPackage = reloadedManagedState.dictionaries[trustedIndex];
  check(
    "managed package identity survives dictionary reconciliation",
    managedReload.ok === true
      && reloadedManagedPackage?.id === trustedPackage.id
      && reloadedManagedPackage?.title === localUpdateTitle
      && reloadedManagedPackage?.sourceId === recommended.sourceId
      && reloadedManagedPackage?.displayName === "Starter terms"
      && reloadedManagedPackage?.enabled === false
      && reloadedManagedPackage?.favorite === true,
    JSON.stringify({ managedReload, reloadedManagedState }),
  );

  section("managed dictionary updates");
  const updateTarget = "hachidori-updates";
  const updateAlarmName = "hachidori-managed-dictionary-updates";
  const managedId = reloadedManagedPackage.id;
  const managedGroup = { id: "managed", name: "Managed", dictionaryIds: [managedId] };
  const grouped = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_state_cas",
    baseRevision: reloadedManagedState.revision,
    dictionaries: reloadedManagedState.dictionaries,
    groups: [managedGroup],
  });
  check("managed update fixture adds a stable-id group", grouped?.ok === true, JSON.stringify(grouped));

  const archiveRequests = { count: 0 };
  const untrustedIndexRevision = "2026.09.06.0";
  remoteJson(
    recommended.indexUrl,
    { revision: untrustedIndexRevision },
    200,
    "https://unrelated.example/update-index.json",
  );
  const untrustedIndexCheck = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_check",
  });
  const untrustedIndexState = await storedDictionaryState();
  const untrustedIndexPackage = untrustedIndexState.dictionaries.find((entry) => entry.id === managedId);
  const untrustedIndexOutcome = untrustedIndexCheck?.outcomes?.find((entry) => entry.id === managedId);
  const jmnedictSource = RECOMMENDED_CATALOGUE.find((entry) => entry.sourceId === "jmnedict");
  check(
    "recommended update indexes stay pinned to their catalogue repository",
    untrustedIndexCheck?.ok === true
      && untrustedIndexOutcome?.status === "check-failed"
      && untrustedIndexOutcome.error?.includes("unexpected final URL")
      && untrustedIndexPackage?.revision === reloadedManagedPackage.revision
      && untrustedIndexPackage?.path === reloadedManagedPackage.path
      && untrustedIndexPackage?.lastUpdateCheck?.status === "check-failed"
      && archiveRequests.count === 0
      && recommendedIndexUrlMatches(
        jmnedictSource,
        "https://github.com/yomidevs/jmdict-yomitan/releases/download/JMnedict.2026-09-04/JMnedict.json",
      )
      && !recommendedIndexUrlMatches(
        jmnedictSource,
        "https://github.com/unrelated/project/releases/download/JMnedict.2026-09-04/JMnedict.json",
      ),
    JSON.stringify({ untrustedIndexCheck, untrustedIndexState, archiveRequests }),
  );

  const checkedRevision = "2026.09.07.0";
  remoteJson(recommended.indexUrl, { revision: checkedRevision });
  remoteArchive(
    recommended.downloadUrl,
    buildRecommendedZip({
      title: "Jitendex.org [2026-09-07]",
      revision: checkedRevision,
      indexUrl: recommended.indexUrl,
      downloadUrl: recommended.downloadUrl,
      capabilities: recommended.capabilities,
    }),
    recommended.downloadUrl,
    archiveRequests,
  );
  const checked = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_check",
  });
  const checkedState = await storedDictionaryState();
  const checkedManaged = checkedState.dictionaries.find((entry) => entry.id === managedId);
  const checkedLocal = checkedState.dictionaries.find((entry) => entry.id === importedPackage.id);
  const checkedGlobals = (await storage.api().local.get("dictionaryUpdates")).dictionaryUpdates;
  check(
    "Check now records a disabled managed package without downloading and skips local archives",
    checked?.ok === true
      && checkedManaged?.enabled === false
      && checkedManaged?.lastUpdateCheck?.status === "update-available"
      && checkedManaged.lastUpdateCheck.remoteRevision === checkedRevision
      && checkedLocal?.lastUpdateCheck === null
      && archiveRequests.count === 0
      && Number.isFinite(Date.parse(checkedGlobals?.lastCheckedAt)),
    JSON.stringify({ checked, checkedState, checkedGlobals, archiveRequests }),
  );

  // The per-package update state is structured data. Losing the import CAS reply
  // must still recognize the cloned readback as the exact committed value. Real
  // Chrome also returns stored object keys in a different order, which must not
  // prevent the replaced generation from being collected after that readback.
  const managedGenerationBeforeManual = ownedGenerationRoot(
    checkedManaged.path,
    checkedManaged.title,
  );
  loseNextStateCasReply = true;
  storage.sortDictionaryKeysOnRead(true);
  const manualUpdate = await Promise.race([
    pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [managedId],
    }),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 10000)),
  ]);
  storage.sortDictionaryKeysOnRead(false);
  const manualState = await storedDictionaryState();
  const manuallyUpdated = manualState.dictionaries.find((entry) => entry.id === managedId);
  const managedGenerationRowsAfterManual = idb.keys("/dicts");
  check(
    "manual Update rechecks and atomically replaces through the existing import transaction",
    manualUpdate?.ok === true
      && manualUpdate.timeout !== true
      && archiveRequests.count === 1
      && manuallyUpdated?.revision === checkedRevision
      && manuallyUpdated?.id === managedId
      && manuallyUpdated?.displayName === "Starter terms"
      && manuallyUpdated?.enabled === false
      && manuallyUpdated?.favorite === true
      && manuallyUpdated?.lastUpdateCheck?.status === "up-to-date"
      && !managedGenerationRowsAfterManual.some((path) =>
        path === managedGenerationBeforeManual
          || path.startsWith(`${managedGenerationBeforeManual}/`))
      && JSON.stringify(manualState.groups) === JSON.stringify([managedGroup]),
    JSON.stringify({
      manualUpdate,
      manualState,
      archiveRequests,
      managedGenerationBeforeManual,
      managedGenerationRowsAfterManual,
    }),
  );

  const cleanupRaceRevision = "2026.09.07.1";
  const cleanupRaceGroup = { ...managedGroup, name: "Managed after update" };
  const cleanupRaceGeneration = ownedGenerationRoot(
    manuallyUpdated.path,
    manuallyUpdated.title,
  );
  const cleanupArchiveRequests = { count: 0 };
  remoteJson(recommended.indexUrl, { revision: cleanupRaceRevision });
  remoteArchive(
    recommended.downloadUrl,
    buildRecommendedZip({
      title: "Jitendex.org [2026-09-07]",
      revision: cleanupRaceRevision,
      indexUrl: recommended.indexUrl,
      downloadUrl: recommended.downloadUrl,
      capabilities: recommended.capabilities,
    }),
    recommended.downloadUrl,
    cleanupArchiveRequests,
  );
  advanceGroupsAfterCommittedRevision = {
    revision: cleanupRaceRevision,
    groups: [cleanupRaceGroup],
  };
  const cleanupRaceUpdate = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [managedId],
  });
  const cleanupRaceState = await storedDictionaryState();
  const cleanupRacePackage = cleanupRaceState.dictionaries.find((entry) => entry.id === managedId);
  const cleanupRaceRows = idb.keys("/dicts");
  check(
    "generation cleanup follows an authoritative group-only state advance",
    cleanupRaceUpdate?.ok === true
      && cleanupArchiveRequests.count === 1
      && advancedStateDuringCleanup?.ok === true
      && cleanupRacePackage?.revision === cleanupRaceRevision
      && JSON.stringify(cleanupRaceState.groups) === JSON.stringify([cleanupRaceGroup])
      && !cleanupRaceRows.some((path) =>
        path === cleanupRaceGeneration || path.startsWith(`${cleanupRaceGeneration}/`)),
    JSON.stringify({
      cleanupRaceUpdate,
      cleanupRaceState,
      cleanupArchiveRequests,
      advancedStateDuringCleanup,
      cleanupRaceGeneration,
      cleanupRaceRows,
    }),
  );

  const scheduled = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_schedule",
    schedule: "hourly",
  });
  const hourlyAlarm = await alarms.api.get(updateAlarmName);
  check(
    "one global schedule creates one browser alarm",
    scheduled?.ok === true
      && scheduled.settings?.schedule === "hourly"
      && hourlyAlarm?.periodInMinutes === 60
      && alarms.values.size === 1,
    JSON.stringify({ scheduled, hourlyAlarm, alarms: [...alarms.values.values()] }),
  );

  const alarmRevision = "2026.09.08.0";
  remoteJson(recommended.indexUrl, { revision: alarmRevision });
  remoteArchive(
    recommended.downloadUrl,
    buildRecommendedZip({
      title: "Jitendex.org [2026-09-08]",
      revision: alarmRevision,
      indexUrl: recommended.indexUrl,
      downloadUrl: recommended.downloadUrl,
      capabilities: recommended.capabilities,
    }),
    recommended.downloadUrl,
    archiveRequests,
  );
  alarms.fire(updateAlarmName);
  const alarmDeadline = Date.now() + 10000;
  let alarmState = await storedDictionaryState();
  while ((alarmState.dictionaries.find((entry) => entry.id === managedId)?.revision !== alarmRevision
      || alarmState.dictionaries.find((entry) => entry.id === managedId)?.lastUpdateCheck?.status !== "up-to-date")
      && Date.now() < alarmDeadline) {
    await new Promise((done) => setTimeout(done, 25));
    alarmState = await storedDictionaryState();
  }
  const alarmUpdated = alarmState.dictionaries.find((entry) => entry.id === managedId);
  check(
    "the scheduled alarm auto-installs available updates without deadlocking storage",
    alarmUpdated?.revision === alarmRevision
      && alarmUpdated?.lastUpdateCheck?.status === "up-to-date"
      && archiveRequests.count === 2
      && alarmUpdated.id === managedId
      && alarmUpdated.displayName === "Starter terms"
      && alarmUpdated.enabled === false
      && alarmUpdated.favorite === true
      && JSON.stringify(alarmState.groups) === JSON.stringify([cleanupRaceGroup]),
    JSON.stringify({ alarmState, archiveRequests }),
  );

  await alarms.api.clear(updateAlarmName);
  swChrome.__events.onStartup.fire();
  const alarmRepairDeadline = Date.now() + 2000;
  let repairedAlarm = await alarms.api.get(updateAlarmName);
  while (!repairedAlarm && Date.now() < alarmRepairDeadline) {
    await new Promise((done) => setTimeout(done, 10));
    repairedAlarm = await alarms.api.get(updateAlarmName);
  }
  check(
    "service-worker startup recreates a missing configured alarm",
    repairedAlarm?.periodInMinutes === 60 && alarms.values.size === 1,
    JSON.stringify({ repairedAlarm, alarms: [...alarms.values.values()] }),
  );

  const failedRevision = "2026.09.09.0";
  const beforeFailedAlarm = await storedDictionaryState();
  const beforeFailedPackage = beforeFailedAlarm.dictionaries.find((entry) => entry.id === managedId);
  remoteJson(recommended.indexUrl, { revision: failedRevision });
  remoteArchive(
    recommended.downloadUrl,
    buildRecommendedZip({
      title: "Jitendex.org [2026-09-09]",
      revision: "wrong-revision",
      indexUrl: recommended.indexUrl,
      downloadUrl: recommended.downloadUrl,
      capabilities: recommended.capabilities,
    }),
    recommended.downloadUrl,
    archiveRequests,
  );
  alarms.fire(updateAlarmName);
  const failureDeadline = Date.now() + 10000;
  let failedAlarmState = await storedDictionaryState();
  while (!failedAlarmState.dictionaries.find((entry) => entry.id === managedId)?.lastUpdateCheck?.error
      && Date.now() < failureDeadline) {
    await new Promise((done) => setTimeout(done, 25));
    failedAlarmState = await storedDictionaryState();
  }
  const failedAlarmPackage = failedAlarmState.dictionaries.find((entry) => entry.id === managedId);
  check(
    "a failed scheduled replacement retains the old generation and reports the available revision",
    failedAlarmPackage?.revision === alarmRevision
      && failedAlarmPackage?.path === beforeFailedPackage.path
      && failedAlarmPackage?.lastUpdateCheck?.status === "update-available"
      && failedAlarmPackage?.lastUpdateCheck?.remoteRevision === failedRevision
      && failedAlarmPackage?.lastUpdateCheck?.error?.includes("revision")
      && JSON.stringify(failedAlarmState.groups) === JSON.stringify([cleanupRaceGroup]),
    JSON.stringify({ beforeFailedAlarm, failedAlarmState }),
  );

  remoteJson(recommended.indexUrl, {}, 503);
  const failedCheck = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_check",
  });
  const failedCheckState = await storedDictionaryState();
  const failedCheckPackage = failedCheckState.dictionaries.find((entry) => entry.id === managedId);
  check(
    "an index failure is recorded per item without changing the installed revision",
    failedCheck?.ok === true
      && failedCheckPackage?.revision === alarmRevision
      && failedCheckPackage?.lastUpdateCheck?.status === "check-failed"
      && failedCheckPackage?.lastUpdateCheck?.error?.includes("HTTP 503"),
    JSON.stringify({ failedCheck, failedCheckState }),
  );

  const scheduleOff = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_schedule",
    schedule: "off",
  });
  check(
    "turning periodic checks off clears the one managed-update alarm",
    scheduleOff?.ok === true
      && scheduleOff.settings?.schedule === "off"
      && await alarms.api.get(updateAlarmName) === undefined,
    JSON.stringify({ scheduleOff, alarms: [...alarms.values.values()] }),
  );

  const communityTitle = "Community Dictionary";
  const communityIndexUrl = "https://example.test/community/index.json";
  const communityDownloadUrl = "https://example.test/community/archive.zip";
  const communityZip = ({
    title = communityTitle,
    revision,
    indexUrl = communityIndexUrl,
    downloadUrl = communityDownloadUrl,
  }) => buildRecommendedZip({ title, revision, indexUrl, downloadUrl, capabilities: ["term"] });
  const communityImport = await request("hd_import", {
    blobUrl: createObjectURL(communityZip({ revision: "community-1" })),
    fileName: "community.zip",
  });
  const communityState = await storedDictionaryState();
  const community = communityState.dictionaries.find((entry) => entry.title === communityTitle);
  const rotatingCommunityDownloadUrl = "https://example.test/community/releases/community-2.zip";
  const rotatingArchiveRequests = { count: 0 };
  remoteJson(communityIndexUrl, {
    revision: "community-2",
    downloadUrl: rotatingCommunityDownloadUrl,
  });
  remoteArchive(
    rotatingCommunityDownloadUrl,
    communityZip({ revision: "community-2" }),
    rotatingCommunityDownloadUrl,
    rotatingArchiveRequests,
  );
  const communityUpdate = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community?.id],
  });
  const updatedCommunityState = await storedDictionaryState();
  const updatedCommunity = updatedCommunityState.dictionaries.find((entry) => entry.id === community?.id);
  check(
    "a generic managed source can select a rotating HTTPS archive from its remote index",
    communityImport.ok === true
      && community?.sourceId === undefined
      && community?.isUpdatable === true
      && communityUpdate?.ok === true
      && updatedCommunity?.revision === "community-2"
      && updatedCommunity?.id === community.id
      && updatedCommunity?.lastUpdateCheck?.status === "up-to-date"
      && updatedCommunity?.indexUrl === communityIndexUrl
      && updatedCommunity?.downloadUrl === communityDownloadUrl
      && rotatingArchiveRequests.count === 1,
    JSON.stringify({
      communityImport,
      community,
      communityUpdate,
      updatedCommunityState,
      rotatingArchiveRequests,
    }),
  );

  const editCommunity = async (patch) => {
    const current = await storedDictionaryState();
    return pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: current.revision,
      dictionaries: current.dictionaries.map((dictionary) =>
        dictionary.id === community.id ? { ...dictionary, ...patch } : dictionary),
    });
  };

  const transportStart = (await storedDictionaryState()).dictionaries.find(
    (entry) => entry.id === community.id,
  );
  remoteJson(communityIndexUrl, {
    revision: "community-3",
    downloadUrl: "http://example.test/community-3.zip",
  });
  const insecureDownload = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community.id],
  });
  remoteJson(
    communityIndexUrl,
    { revision: "community-3" },
    200,
    "http://example.test/community-index.json",
  );
  const insecureIndexRedirect = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community.id],
  });
  remoteJson(communityIndexUrl, {
    revision: "community-3",
    downloadUrl: rotatingCommunityDownloadUrl,
  });
  remoteArchive(
    rotatingCommunityDownloadUrl,
    communityZip({ revision: "community-3" }),
    "http://example.test/community-3.zip",
  );
  const insecureArchiveRedirect = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community.id],
  });
  const transportState = await storedDictionaryState();
  const transportCommunity = transportState.dictionaries.find((entry) => entry.id === community.id);
  check(
    "generic updates reject non-HTTPS index redirects, archive redirects, and remote download URLs",
    insecureDownload?.outcomes?.[0]?.status === "check-failed"
      && insecureDownload.outcomes[0].error?.includes("non-HTTPS download URL")
      && insecureIndexRedirect?.outcomes?.[0]?.status === "check-failed"
      && insecureIndexRedirect.outcomes[0].error?.includes("non-HTTPS")
      && insecureArchiveRedirect?.outcomes?.[0]?.status === "update-available"
      && insecureArchiveRedirect.outcomes[0].error?.includes("unexpected final URL")
      && transportCommunity?.revision === "community-2"
      && transportCommunity?.path === transportStart.path,
    JSON.stringify({
      insecureDownload,
      insecureIndexRedirect,
      insecureArchiveRedirect,
      transportState,
    }),
  );

  remoteJson(communityIndexUrl, { revision: "community-collision" });
  remoteArchive(
    communityDownloadUrl,
    communityZip({ title: FIXTURE_TITLE, revision: "community-collision" }),
  );
  const beforeTitleCollision = await storedDictionaryState();
  const titleCollisionUpdate = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community.id],
  });
  const titleCollisionState = await storedDictionaryState();
  const titleCollisionCommunity = titleCollisionState.dictionaries.find(
    (entry) => entry.id === community.id,
  );
  check(
    "a managed replacement cannot take another installed package's title or logical ID",
    titleCollisionUpdate?.ok === true
      && titleCollisionUpdate.outcomes?.[0]?.error?.includes("already installed")
      && titleCollisionCommunity?.title === communityTitle
      && titleCollisionCommunity?.revision === "community-2"
      && titleCollisionCommunity?.path === transportStart.path
      && titleCollisionState.dictionaries.filter((entry) => entry.title === FIXTURE_TITLE).length === 1,
    JSON.stringify({ beforeTitleCollision, titleCollisionUpdate, titleCollisionState }),
  );
  const collisionFixtureRestored = await request("hd_import", {
    blobUrl: createObjectURL(communityZip({ revision: "community-2" })),
    fileName: "community.zip",
  });

  const beforePathRace = (await storedDictionaryState()).dictionaries.find(
    (entry) => entry.id === community.id,
  );
  const pathRaceArchiveRequests = { count: 0 };
  remoteArchive(
    communityDownloadUrl,
    communityZip({ revision: "community-3" }),
    communityDownloadUrl,
    pathRaceArchiveRequests,
  );
  let concurrentReimport = null;
  remoteJson(communityIndexUrl, async () => {
    concurrentReimport = await request("hd_import", {
      blobUrl: createObjectURL(communityZip({ revision: "community-2" })),
      fileName: "community.zip",
    });
    return { revision: "community-3" };
  });
  const stalePathUpdate = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community.id],
  });
  const stalePathState = await storedDictionaryState();
  const stalePathCommunity = stalePathState.dictionaries.find((entry) => entry.id === community.id);
  check(
    "a same-revision reimport invalidates a managed check captured from the old path",
    collisionFixtureRestored?.ok === true
      && concurrentReimport?.ok === true
      && stalePathUpdate?.ok === true
      && stalePathUpdate.outcomes?.[0]?.error?.includes("changed while")
      && stalePathCommunity?.revision === "community-2"
      && stalePathCommunity?.path !== beforePathRace.path
      && stalePathCommunity?.lastUpdateCheck === null
      && pathRaceArchiveRequests.count === 0,
    JSON.stringify({
      collisionFixtureRestored,
      concurrentReimport,
      stalePathUpdate,
      stalePathState,
      pathRaceArchiveRequests,
    }),
  );

  const changedCommunityIndexUrl = "https://example.test/community-other/index.json";
  const changedCommunityDownloadUrl = "https://example.test/community-other/archive.zip";
  const staleSourceArchiveRequests = { count: 0 };
  remoteArchive(
    changedCommunityDownloadUrl,
    buildRecommendedZip({
      title: communityTitle,
      revision: "community-3",
      indexUrl: changedCommunityIndexUrl,
      downloadUrl: changedCommunityDownloadUrl,
      capabilities: ["term"],
    }),
    changedCommunityDownloadUrl,
    staleSourceArchiveRequests,
  );
  let changedSource = null;
  remoteJson(communityIndexUrl, async () => {
    changedSource = await editCommunity({
      revision: "community-4",
      indexUrl: changedCommunityIndexUrl,
      downloadUrl: changedCommunityDownloadUrl,
      lastUpdateCheck: null,
    });
    return { revision: "community-3" };
  });
  const staleSourcePath = (await storedDictionaryState()).dictionaries.find(
    (entry) => entry.id === community.id,
  ).path;
  const staleSourceUpdate = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community.id],
  });
  const staleSourceState = await storedDictionaryState();
  const staleSourceCommunity = staleSourceState.dictionaries.find((entry) => entry.id === community.id);
  check(
    "a stale check cannot downgrade a dictionary whose managed source changed before import",
    changedSource?.ok === true
      && staleSourceUpdate?.ok === true
      && staleSourceUpdate.outcomes?.[0]?.error?.includes("changed while")
      && staleSourceCommunity?.revision === "community-4"
      && staleSourceCommunity?.path === staleSourcePath
      && staleSourceCommunity?.indexUrl === changedCommunityIndexUrl
      && staleSourceCommunity?.downloadUrl === changedCommunityDownloadUrl
      && staleSourceCommunity?.lastUpdateCheck === null
      && staleSourceArchiveRequests.count === 0,
    JSON.stringify({ changedSource, staleSourceUpdate, staleSourceState, staleSourceArchiveRequests }),
  );

  const sourceRestored = await editCommunity({
    revision: "community-2",
    indexUrl: communityIndexUrl,
    downloadUrl: communityDownloadUrl,
    lastUpdateCheck: null,
  });
  const commitRaceArchiveRequests = { count: 0 };
  let concurrentRevision = null;
  remoteJson(communityIndexUrl, { revision: "community-3" });
  remoteArchive(
    communityDownloadUrl,
    buildRecommendedZip({
      title: communityTitle,
      revision: "community-3",
      indexUrl: communityIndexUrl,
      downloadUrl: communityDownloadUrl,
      capabilities: ["term"],
    }),
    communityDownloadUrl,
    commitRaceArchiveRequests,
    async () => {
      concurrentRevision = await editCommunity({
        revision: "community-4",
        lastUpdateCheck: null,
      });
    },
  );
  const beforeCommitRace = (await storedDictionaryState()).dictionaries.find(
    (entry) => entry.id === community.id,
  );
  const staleCommitUpdate = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community.id],
  });
  const staleCommitState = await storedDictionaryState();
  const staleCommitCommunity = staleCommitState.dictionaries.find((entry) => entry.id === community.id);
  check(
    "a managed replacement revalidates the installed revision at the commit snapshot",
    sourceRestored?.ok === true
      && concurrentRevision?.ok === true
      && staleCommitUpdate?.ok === true
      && staleCommitUpdate.outcomes?.[0]?.error?.includes("changed while")
      && staleCommitCommunity?.revision === "community-4"
      && staleCommitCommunity?.path === beforeCommitRace.path
      && staleCommitCommunity?.lastUpdateCheck === null
      && commitRaceArchiveRequests.count === 1,
    JSON.stringify({ sourceRestored, concurrentRevision, staleCommitUpdate, staleCommitState }),
  );

  const statusFixtureRestored = await editCommunity({
    revision: "community-2",
    indexUrl: communityIndexUrl,
    downloadUrl: communityDownloadUrl,
    lastUpdateCheck: null,
  });
  remoteJson(communityIndexUrl, { revision: "community-3" });
  remoteArchive(
    communityDownloadUrl,
    buildRecommendedZip({
      title: communityTitle,
      revision: "community-3",
      indexUrl: communityIndexUrl,
      downloadUrl: communityDownloadUrl,
      capabilities: ["term"],
    }),
  );
  const beforeStatusFailure = (await storedDictionaryState()).dictionaries.find(
    (entry) => entry.id === community.id,
  );
  failAfterCommittedRevision = {
    revision: "community-3",
    error: "injected post-install settings failure",
  };
  const statusFailureUpdate = await pageChrome.runtime.sendMessage({
    target: updateTarget,
    type: "hd_updates_install",
    dictionaryIds: [community.id],
  });
  const statusFailureState = await storedDictionaryState();
  const statusFailureCommunity = statusFailureState.dictionaries.find((entry) => entry.id === community.id);
  check(
    "a successful replacement commits its up-to-date status before a later settings write",
    statusFixtureRestored?.ok === true
      && statusFailureUpdate?.ok === false
      && statusFailureUpdate.error?.includes("injected post-install settings failure")
      && statusFailureCommunity?.revision === "community-3"
      && statusFailureCommunity?.path !== beforeStatusFailure.path
      && statusFailureCommunity?.lastUpdateCheck?.status === "up-to-date"
      && statusFailureCommunity.lastUpdateCheck.remoteRevision === "community-3"
      && statusFailureCommunity.lastUpdateCheck.error === null
      && failAfterCommittedRevision === null,
    JSON.stringify({ statusFixtureRestored, statusFailureUpdate, statusFailureState }),
  );

  const injectedBlobRowsBefore = idb.keys("/dicts").sort();
  const injectedBlobImport = await request("hd_import", {
    blobUrl: createObjectURL(communityZip({ revision: "community-injected" })),
    fileName: "injected-managed-update.zip",
    managedFingerprint: {
      id: statusFailureCommunity.id,
      path: statusFailureCommunity.path,
      revision: statusFailureCommunity.revision,
      source: {
        kind: "generic",
        sourceId: null,
        indexUrl: communityIndexUrl,
        downloadUrl: communityDownloadUrl,
      },
    },
    archiveUrl: communityDownloadUrl,
    expectedRevision: "community-injected",
    checkedAt: "2026-09-04T12:00:00.000Z",
  });
  const injectedBlobStateAfter = await storedDictionaryState();
  const injectedBlobRowsAfter = idb.keys("/dicts").sort();
  check(
    "the managed import protocol rejects an injected blob archive",
    injectedBlobImport?.ok === false
      && injectedBlobImport.error?.includes("blob URL")
      && JSON.stringify(injectedBlobStateAfter) === JSON.stringify(statusFailureState)
      && JSON.stringify(injectedBlobRowsAfter) === JSON.stringify(injectedBlobRowsBefore),
    JSON.stringify({
      injectedBlobImport,
      statusFailureState,
      injectedBlobStateAfter,
      injectedBlobRowsBefore,
      injectedBlobRowsAfter,
    }),
  );
  await request("hd_remove", { title: communityTitle });
  await request("hd_remove", { title: "Jitendex.org [2026-09-08]" });
  await request("hd_remove", { title: localUpdateTitle });
  await request("hd_remove", { title: updatedTitle });
  await request("hd_remove", { title: recommended.title });

  // Model an actual pre-D9 install: legacy rows named a canonical title path,
  // before immutable UUID generation roots existed.
  const legacyPath = `/dicts/${FIXTURE_TITLE}`;
  observedEngine.FS.mkdir(legacyPath);
  for (const name of observedEngine.FS.readdir(importedPackage.path)) {
    if (name !== "." && name !== "..") {
      observedEngine.FS.writeFile(
        `${legacyPath}/${name}`,
        observedEngine.FS.readFile(`${importedPackage.path}/${name}`),
      );
    }
  }
  await storage.api().local.remove("dictionaryState");
  await storage.api().local.set({
    dictionaries: ["term", "freq", "pitch", "kanji"].map((kind, index) => ({
      title: FIXTURE_TITLE,
      path: `/dicts/${FIXTURE_TITLE}`,
      kind,
      enabled: index !== 0,
    })),
  });
  const preMigrationOptions = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_options_write",
    baseRevision: (await storage.api().local.get("options")).options?.revision ?? 0,
    options: {
      frequencyDictionary: FIXTURE_TITLE,
      kanjiClickDictionary: FIXTURE_TITLE,
    },
  });
  equal(
    "an options write preserves valid dictionary selections before legacy state migrates",
    [preMigrationOptions?.options?.frequencyDictionary, preMigrationOptions?.options?.kanjiClickDictionary],
    [FIXTURE_TITLE, FIXTURE_TITLE],
  );
  const migratedReload = await request("hd_reload");
  const migratedState = await storedDictionaryState();
  const legacyAfterMigration = await storage.api().local.get("dictionaries");
  const optionsAfterMigration = (await storage.api().local.get("options")).options;
  check(
    "legacy capability rows migrate once into the generated logical package",
    migratedReload.ok === true
      && migratedReload.dictionaryCount === 4
      && migratedState?.schemaVersion === 1
      && migratedState.revision === 1
      && migratedState.dictionaries?.length === 1
      && migratedState.dictionaries[0].id === importedPackage.id
      && migratedState.dictionaries[0].enabled === true
      && migratedState.dictionaries[0].frequencyCount === EXPECTED.frequencyCount
      && optionsAfterMigration?.frequencyDictionary === FIXTURE_TITLE
      && optionsAfterMigration?.kanjiClickDictionary?.title === FIXTURE_TITLE
      && optionsAfterMigration?.kanjiClickDictionary?.kind === "kanji"
      && !Object.prototype.hasOwnProperty.call(legacyAfterMigration, "dictionaries"),
    JSON.stringify({ migratedReload, migratedState, legacyAfterMigration }),
  );

  const firstWriterDictionaries = migratedState.dictionaries.map((entry) => ({
    ...entry,
    favorite: true,
  }));
  const staleWriterDictionaries = migratedState.dictionaries.map((entry) => ({
    ...entry,
    displayName: "stale writer",
  }));
  const studyGroup = {
    id: "study-group",
    name: "Study",
    dictionaryIds: [importedPackage.id],
  };
  const firstWriter = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_state_cas",
    baseRevision: migratedState.revision,
    dictionaries: firstWriterDictionaries,
    groups: [studyGroup],
  });
  const staleWriter = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_state_cas",
    baseRevision: migratedState.revision,
    dictionaries: staleWriterDictionaries,
  });
  const stateAfterConflict = await storedDictionaryState();
  check(
    "dictionary state has one serialized compare-and-swap owner",
    firstWriter?.ok === true
      && firstWriter.state?.revision === migratedState.revision + 1
      && firstWriter.state?.dictionaries?.[0]?.favorite === true
      && JSON.stringify(firstWriter.state?.groups) === JSON.stringify([studyGroup])
      && staleWriter?.ok === false
      && staleWriter.conflict === true
      && JSON.stringify(staleWriter.state) === JSON.stringify(firstWriter.state)
      && JSON.stringify(stateAfterConflict) === JSON.stringify(firstWriter.state),
    JSON.stringify({ firstWriter, staleWriter, stateAfterConflict }),
  );

  const incompleteDictionaries = stateAfterConflict.dictionaries.map((entry) => ({
    ...entry,
    frequencyCount: 0,
    pitchCount: 0,
    kanjiCount: 0,
    mediaCount: 0,
  }));
  const selectedOptions = {
    frequencyDictionary: FIXTURE_TITLE,
    kanjiClickDictionary: { title: FIXTURE_TITLE, kind: "kanji" },
  };
  await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_options_write",
    baseRevision: (await storage.api().local.get("options")).options?.revision ?? 0,
    options: selectedOptions,
  });
  const selectedOptionsRevision = (await storage.api().local.get("options")).options.revision;
  await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_state_cas",
    baseRevision: stateAfterConflict.revision,
    dictionaries: incompleteDictionaries,
  });
  const optionsAfterCapabilityRemoval = (await storage.api().local.get("options")).options;
  const staleOptionsWrite = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_options_write",
    baseRevision: selectedOptionsRevision,
    options: selectedOptions,
  });
  equal(
    "state commits atomically prune invalid selectors and stale pages cannot restore them",
    [
      optionsAfterCapabilityRemoval?.frequencyDictionary,
      optionsAfterCapabilityRemoval?.kanjiClickDictionary,
      staleOptionsWrite?.options?.frequencyDictionary,
      staleOptionsWrite?.options?.kanjiClickDictionary,
    ],
    ["", "", "", ""],
  );
  check(
    "selector pruning advances the options revision in the dictionary commit",
    optionsAfterCapabilityRemoval?.revision === selectedOptionsRevision + 1
      && staleOptionsWrite.conflict === true,
    JSON.stringify({ selectedOptionsRevision, optionsAfterCapabilityRemoval, staleOptionsWrite }),
  );
  const reloaded = await request("hd_reload");
  const reconciledState = await storedDictionaryState();
  const reconciledPackage = reconciledState?.dictionaries?.[0];
  equal(
    "reconciliation restores package capabilities without changing its identity or presentation",
    [
      reloaded.ok,
      reloaded.dictionaryCount,
      reconciledState?.dictionaries?.length,
      reconciledPackage?.id,
      reconciledPackage?.favorite,
      reconciledPackage?.termCount,
      reconciledPackage?.frequencyCount,
      reconciledPackage?.pitchCount,
      reconciledPackage?.kanjiCount,
      reconciledPackage?.mediaCount,
    ],
    [
      true,
      4,
      1,
      importedPackage.id,
      true,
      EXPECTED.termCount,
      EXPECTED.frequencyCount,
      EXPECTED.pitchCount,
      EXPECTED.kanjiCount,
      EXPECTED.mediaCount,
    ],
  );

  const disabledDictionaries = reconciledState.dictionaries.map((dictionary) => ({
    ...dictionary,
    enabled: false,
  }));
  loseNextStateCasReply = true;
  const disabled = await request("hd_apply_state", {
    baseRevision: reconciledState.revision,
    dictionaries: disabledDictionaries,
  });
  const disabledStatus = await request("hd_status");
  check(
    "a package-wide state change survives a lost CAS reply without splitting storage and native state",
    disabled.ok === true
      && disabled.state?.dictionaries?.[0]?.enabled === false
      && disabledStatus.dictionaryCount === 0,
    JSON.stringify({ disabled, disabledStatus }),
  );
  const staleEnable = await request("hd_apply_state", {
    baseRevision: reconciledState.revision,
    dictionaries: reconciledState.dictionaries,
  });
  const afterStaleEnable = await request("hd_status");
  check(
    "a stale package change restores the committed native load set",
    staleEnable.ok === false
      && staleEnable.conflict === true
      && staleEnable.state?.dictionaries?.[0]?.enabled === false
      && afterStaleEnable.dictionaryCount === 0,
    JSON.stringify({ staleEnable, afterStaleEnable }),
  );
  const reenabled = await request("hd_apply_state", {
    baseRevision: disabled.state.revision,
    dictionaries: reconciledState.dictionaries,
  });
  check(
    "an enabled logical package restores every native capability",
    reenabled.ok === true && (await request("hd_status")).dictionaryCount === 4,
    JSON.stringify(reenabled),
  );

  const scratchTitle = ".hdw-archive.zip";
  const scratchTitleImport = await request("hd_import", {
    blobUrl: createObjectURL(buildTitledZip(scratchTitle)),
    fileName: `${scratchTitle}.zip`,
  });
  check(
    "a fallback scratch archive cannot collide with an accepted dictionary title",
    scratchTitleImport.ok === true && scratchTitleImport.report?.title === scratchTitle,
    JSON.stringify(scratchTitleImport),
  );
  const scratchTitleRemoval = await request("hd_remove", { title: scratchTitle });
  check(
    "the scratch-title regression dictionary can be removed normally",
    scratchTitleRemoval.ok === true,
    JSON.stringify(scratchTitleRemoval),
  );

  const canonicallyEquivalentTitles = ["Caf\u00e9", "Cafe\u0301"];
  for (const title of canonicallyEquivalentTitles) {
    const result = await request("hd_import", {
      blobUrl: createObjectURL(buildTitledZip(title)),
      fileName: `${title}.zip`,
    });
    check(`the ${JSON.stringify(title)} dictionary imports`, result.ok === true, JSON.stringify(result));
  }
  const canonicallyEquivalentPackages = (await storedDictionaryState()).dictionaries.filter(
    (dictionary) => canonicallyEquivalentTitles.includes(dictionary.title),
  );
  check(
    "distinct on-disk titles have distinct stable package IDs",
    canonicallyEquivalentPackages.length === 2
      && new Set(canonicallyEquivalentPackages.map((dictionary) => dictionary.id)).size === 2,
    JSON.stringify(canonicallyEquivalentPackages),
  );
  const stateWithThreePackages = await storedDictionaryState();
  peakLoadedDictionaryPaths = 0;
  const allDisabled = await request("hd_apply_state", {
    baseRevision: stateWithThreePackages.revision,
    dictionaries: stateWithThreePackages.dictionaries.map((dictionary) => ({
      ...dictionary,
      enabled: false,
    })),
  });
  const disabledValidationPeak = peakLoadedDictionaryPaths;
  const disabledStatusAfterValidation = await request("hd_status");
  const restoredThreePackages = await request("hd_apply_state", {
    baseRevision: allDisabled.state.revision,
    dictionaries: stateWithThreePackages.dictionaries,
  });
  check(
    "disabled packages are validated independently before publishing an empty load set",
    allDisabled.ok === true
      && disabledStatusAfterValidation.dictionaryCount === 0
      && disabledValidationPeak === 1
      && restoredThreePackages.ok === true,
    JSON.stringify({ allDisabled, disabledValidationPeak, restoredThreePackages }),
  );
  for (const title of canonicallyEquivalentTitles) {
    await request("hd_remove", { title });
  }

  const removalRootImport = await request("hd_import", {
    blobUrl: createObjectURL(buildTitledZip(".hdw-remove")),
    fileName: "reserved-removal-root.zip",
  });
  check(
    "the removal staging root cannot be imported as a dictionary title",
    removalRootImport.ok === false
      && !(await storedDictionaryState()).dictionaries.some((entry) => entry.title === ".hdw-remove"),
    JSON.stringify(removalRootImport),
  );

  const legacyRemovalTitle = ".hdw-remove";
  const legacyRemovalPath = `/dicts/${legacyRemovalTitle}`;
  observedEngine.FS.mkdir(legacyRemovalPath);
  for (const name of observedEngine.FS.readdir(`/dicts/${FIXTURE_TITLE}`)) {
    if (name === "." || name === "..") continue;
    const source = `/dicts/${FIXTURE_TITLE}/${name}`;
    let bytes = observedEngine.FS.readFile(source);
    if (name === "index.json") {
      const legacyIndex = JSON.parse(new TextDecoder().decode(bytes));
      legacyIndex.title = legacyRemovalTitle;
      bytes = new TextEncoder().encode(JSON.stringify(legacyIndex));
    }
    observedEngine.FS.writeFile(`${legacyRemovalPath}/${name}`, bytes);
  }
  const stagedBesideLegacyPath = `${legacyRemovalPath}/${FIXTURE_TITLE}`;
  observedEngine.FS.mkdir(stagedBesideLegacyPath);
  for (const name of observedEngine.FS.readdir(`/dicts/${FIXTURE_TITLE}`)) {
    if (name !== "." && name !== "..") {
      observedEngine.FS.rename(
        `/dicts/${FIXTURE_TITLE}/${name}`,
        `${stagedBesideLegacyPath}/${name}`,
      );
    }
  }
  observedEngine.FS.rmdir(`/dicts/${FIXTURE_TITLE}`);
  const beforeLegacyRemovalReload = await storedDictionaryState();
  await storage.api().local.set({
    dictionaryState: {
      ...beforeLegacyRemovalReload,
      revision: beforeLegacyRemovalReload.revision + 1,
      dictionaries: [
        ...beforeLegacyRemovalReload.dictionaries,
        { ...importedPackage, id: "legacy-placeholder", title: legacyRemovalTitle, path: legacyRemovalPath },
      ],
    },
  });
  const legacyRemovalReload = await request("hd_reload");
  const afterLegacyRemovalReload = await storedDictionaryState();
  check(
    "removal recovery preserves a legacy .hdw-remove dictionary and restores its staged child",
    legacyRemovalReload.ok === true
      && observedEngine.FS.analyzePath(`${legacyRemovalPath}/.hoshidicts_3`).exists
      && observedEngine.FS.analyzePath(`/dicts/${FIXTURE_TITLE}/.hoshidicts_3`).exists
      && !observedEngine.FS.analyzePath(stagedBesideLegacyPath).exists
      && afterLegacyRemovalReload.dictionaries.some((dictionary) => dictionary.title === legacyRemovalTitle),
    JSON.stringify({ legacyRemovalReload, afterLegacyRemovalReload }),
  );
  const removedLegacyRemovalRoot = await request("hd_remove", { title: legacyRemovalTitle });
  const afterLegacyRemoval = await storedDictionaryState();
  check(
    "the preserved .hdw-remove dictionary remains removable",
    removedLegacyRemovalRoot.ok === true
      && !observedEngine.FS.analyzePath(legacyRemovalPath).exists
      && !afterLegacyRemoval.dictionaries.some(
        (dictionary) => dictionary.title === legacyRemovalTitle,
      ),
    JSON.stringify({ removedLegacyRemovalRoot, afterLegacyRemoval }),
  );

  const invalidLoadTitle = "invalid-native-load";
  const invalidGenerationRoot = "/dicts/.hdw-generation-00000000-0000-4000-8000-000000000000";
  const invalidLoadPath = `${invalidGenerationRoot}/${invalidLoadTitle}`;
  const invalidImportDate = 0;
  observedEngine.FS.mkdir(invalidGenerationRoot);
  observedEngine.FS.mkdir(invalidLoadPath);
  observedEngine.FS.writeFile(`${invalidLoadPath}/.hoshidicts_3`, new Uint8Array());
  observedEngine.FS.writeFile(`${invalidLoadPath}/index.json`, JSON.stringify({
    title: invalidLoadTitle,
    revision: "test-1",
    importDate: invalidImportDate,
    counts: { terms: { total: 1 } },
  }));
  const stateBeforeInvalidLoad = await storedDictionaryState();
  const invalidPackage = {
    id: createHash("sha256").update(invalidLoadTitle).digest("hex").slice(0, 32),
    title: invalidLoadTitle,
    displayName: null,
    path: invalidLoadPath,
    enabled: true,
    favorite: false,
    revision: "test-1",
    isUpdatable: false,
    indexUrl: null,
    downloadUrl: null,
    language: null,
    termCount: 1,
    frequencyCount: 0,
    pitchCount: 0,
    kanjiCount: 0,
    mediaCount: 0,
    installedAt: new Date(invalidImportDate).toISOString(),
    lastUpdateCheck: null,
  };
  const invalidStateWrite = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_state_cas",
    baseRevision: stateBeforeInvalidLoad.revision,
    dictionaries: [...stateBeforeInvalidLoad.dictionaries, invalidPackage],
  });
  const authoritativeInvalidState = invalidStateWrite.state;
  const invalidReload = await request("hd_reload");
  const stateAfterInvalidReload = await storedDictionaryState();
  check(
    "reload rejects an authoritative invalid package without pruning its state",
    invalidStateWrite.ok === true
      && authoritativeInvalidState.dictionaries.length === stateBeforeInvalidLoad.dictionaries.length + 1
      && invalidReload.ok === false
      && invalidReload.error?.includes("could not load")
      && JSON.stringify(stateAfterInvalidReload) === JSON.stringify(authoritativeInvalidState),
    JSON.stringify({ invalidStateWrite, invalidReload, stateAfterInvalidReload }),
  );
  const repairedStateWrite = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_state_cas",
    baseRevision: stateAfterInvalidReload.revision,
    dictionaries: stateAfterInvalidReload.dictionaries.filter(
      (dictionary) => dictionary.title !== invalidLoadTitle,
    ),
  });
  observedEngine.FS.unlink(`${invalidLoadPath}/index.json`);
  observedEngine.FS.unlink(`${invalidLoadPath}/.hoshidicts_3`);
  observedEngine.FS.rmdir(invalidLoadPath);
  observedEngine.FS.rmdir(invalidGenerationRoot);
  const repairedReload = await request("hd_reload");
  const stateAfterRepair = await storedDictionaryState();
  check(
    "reload recovers after the invalid package is explicitly removed",
    repairedStateWrite.ok === true
      && !repairedStateWrite.state.dictionaries.some(
        (dictionary) => dictionary.title === invalidLoadTitle,
      )
      && repairedReload.ok === true
      && repairedReload.dictionaryCount === 4
      && JSON.stringify(stateAfterRepair) === JSON.stringify(repairedStateWrite.state),
    JSON.stringify({ repairedStateWrite, repairedReload, stateAfterRepair }),
  );

  section("lookup, kanji, styles, media");
  const lookup = await request("hd_lookup", {
    text: "食べたかった",
    maxResults: 32,
    scanLength: 16,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
  });
  check("hd_lookup succeeds", lookup.ok === true, JSON.stringify(lookup.error));
  equal("hd_lookup_result payload keys", Object.keys(lookup).sort(), [
    "dictionaryCount",
    "error",
    "generation",
    "ok",
    "requestId",
    "results",
    "type",
  ]);
  check("hd_lookup returns results", lookup.results.length > 0, JSON.stringify(lookup.results));
  const first = lookup.results[0];
  equal("the deinflection trace survives the round trip", [
    first.matched,
    first.deinflected,
    first.trace.map((step) => step.name),
  ], ["食べたかった", "食べる", ["-た", "-たい"]]);
  check(
    "glossary stays a raw structured-content string",
    typeof first.term.glossaries[0].glossary === "string" &&
      first.term.glossaries[0].glossary.startsWith("["),
    JSON.stringify(first.term.glossaries[0]),
  );
  check("frequencies came through", first.term.frequencies.length > 0, JSON.stringify(first.term.frequencies));
  check("pitches came through", first.term.pitches.length > 0, JSON.stringify(first.term.pitches));

  const selectedLookup = await request("hd_lookup_dictionary", {
    dictionary: FIXTURE_TITLE,
    text: "食べたかった",
    maxResults: 1,
    scanLength: 16,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
  });
  check(
    "hd_lookup_dictionary returns only the selected enabled term dictionary",
    selectedLookup.ok === true
      && selectedLookup.results.length === 1
      && selectedLookup.results[0].term.glossaries.every(({ dictionary }) => dictionary === FIXTURE_TITLE),
    JSON.stringify(selectedLookup),
  );
  const missingSelectedLookup = await request("hd_lookup_dictionary", {
    dictionary: "not imported",
    text: "食",
  });
  equal(
    "hd_lookup_dictionary refuses a title that is not enabled and stored",
    [missingSelectedLookup.ok, missingSelectedLookup.results, missingSelectedLookup.dictionaryCount],
    [true, [], 4],
  );

  // content.js renders "no dictionaries imported" on dictionaryCount 0, so an
  // ordinary no-match must not report 0 the way the engine's error fallback does.
  const noMatch = await request("hd_lookup", {
    text: "zzz",
    maxResults: 32,
    scanLength: 16,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
  });
  equal(
    "a no-match lookup still reports the real dictionaryCount",
    [noMatch.ok, noMatch.results, noMatch.dictionaryCount],
    [true, [], 4],
  );

  const kanji = await request("hd_kanji", { character: "食" });
  check("hd_kanji returns a LookupKanji", kanji.ok === true && kanji.kanji?.character === "食", JSON.stringify(kanji));
  check(
    "kanji onyomi/kunyomi/tags are strings, as contract B says",
    ["onyomi", "kunyomi", "tags"].every((key) => typeof kanji.kanji.entries[0][key] === "string"),
    JSON.stringify(kanji.kanji.entries[0]),
  );
  const missingKanji = await request("hd_kanji", { character: "鰷" });
  equal("an unmatched kanji maps to null", [missingKanji.ok, missingKanji.kanji], [true, null]);

  const invalidLookupRequests = [
    { type: "hd_lookup", text: "食\0べる" },
    { type: "hd_lookup_dictionary", dictionary: FIXTURE_TITLE, text: "食\0べる" },
    { type: "hd_kanji", character: "食\0" },
    { type: "hd_lookup", text: "あ".repeat(1366) },
    { type: "hd_lookup", text: "食", options: { primaryReading: "あ".repeat(1366) } },
    { type: "hd_lookup", text: "食", options: { frequencyDictionary: "あ".repeat(1366) } },
  ];
  const invalidLookupReplies = [];
  for (const message of invalidLookupRequests) {
    invalidLookupReplies.push(await engineService.handleEngineMessage({ ...message, requestId: "bounded-input" }));
  }
  check(
    "lookup inputs reject oversized UTF-8 and C-string NUL without truncation",
    invalidLookupReplies.every((reply) => reply.ok === false
      && reply.requestId === "bounded-input"
      && /4096-byte|NUL/u.test(reply.error)
      && (reply.kanji === null || reply.results?.length === 0)),
    JSON.stringify(invalidLookupReplies),
  );

  const originalCcall = observedEngine.ccall;
  const lookupNativeNames = new Set(["hdw_lookup", "hdw_lookup_dictionary", "hdw_kanji"]);
  let injectedLookupJson = "null";
  let injectedLookupError = "";
  observedEngine.ccall = (name, ...args) => {
    if (lookupNativeNames.has(name)) return injectedLookupJson;
    if (name === "hdw_last_error") return injectedLookupError;
    return originalCcall(name, ...args);
  };
  try {
    const malformedReplies = [];
    for (const type of ["hd_lookup", "hd_lookup_dictionary", "hd_kanji"]) {
      for (const json of ["null", "{}", '{"results":[],"dictionaryCount":"4"}', '{"character":"食","entries":{}}']) {
        injectedLookupJson = json;
        malformedReplies.push(await engineService.handleEngineMessage({
          type, requestId: "malformed", dictionary: FIXTURE_TITLE, text: "食", character: "食",
        }));
      }
    }
    check(
      "malformed native lookup shapes fail instead of becoming successful misses",
      malformedReplies.every((reply) => reply.ok === false && /malformed/u.test(reply.error)),
      JSON.stringify(malformedReplies),
    );

    const responseLimit = 32 * 1024 * 1024;
    for (const [type, nativeValue, field] of [
      ["hd_lookup", { results: [first], dictionaryCount: 4 }, "results"],
      ["hd_lookup_dictionary", { results: [first], dictionaryCount: 4 }, "results"],
      ["hd_kanji", kanji.kanji, "kanji"],
    ]) {
      injectedLookupJson = JSON.stringify(nativeValue);
      const message = { type, dictionary: FIXTURE_TITLE, text: "食", character: "食", requestId: "" };
      const smallReply = await engineService.handleEngineMessage(message);
      // A long multibyte correlation ID makes the complete public envelope
      // cross the limit even though the native JSON itself is small.
      const remaining = responseLimit - Buffer.byteLength(JSON.stringify(smallReply));
      const exactId = "あ".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
      const exact = await engineService.handleEngineMessage({ ...message, requestId: exactId });
      const over = await engineService.handleEngineMessage({ ...message, requestId: exactId + "x" });
      check(
        `${type} accepts exactly 32 MiB and rejects one extra envelope byte`,
        exact.ok === true && Buffer.byteLength(JSON.stringify(exact)) === responseLimit
          && JSON.stringify(exact[field]) === JSON.stringify(smallReply[field])
          && over.ok === false && /32 MiB/u.test(over.error)
          && over.requestId === exactId + "x"
          && Buffer.byteLength(JSON.stringify(over)) <= responseLimit,
        JSON.stringify({ exactOk: exact.ok, overOk: over.ok, error: over.error }),
      );
    }
    injectedLookupJson = JSON.stringify({ results: [], dictionaryCount: 4 });
    const invalidId = await engineService.handleEngineMessage({ type: "hd_lookup", text: "食", requestId: {} });
    const oversizedId = await engineService.handleEngineMessage({
      type: "hd_lookup", text: "食", requestId: "x".repeat(responseLimit),
    });
    check(
      "lookup correlation IDs fail closed when invalid or unable to fit an error reply",
      invalidId.ok === false && invalidId.requestId === null
        && oversizedId.ok === false && oversizedId.requestId === null
        && Buffer.byteLength(JSON.stringify(oversizedId)) <= responseLimit,
      JSON.stringify({ invalidOk: invalidId.ok, oversizedOk: oversizedId.ok }),
    );
    const genericErrorFrame = { ...oversizedId, requestId: "" };
    const errorId = "x".repeat(responseLimit - Buffer.byteLength(JSON.stringify(genericErrorFrame)));
    injectedLookupError = "long native failure ".repeat(20);
    const correlatedFailure = await engineService.handleEngineMessage({
      type: "hd_lookup", text: "食", requestId: errorId,
    });
    check(
      "an oversized native error retains correlation when the bounded error frame fits",
      correlatedFailure.ok === false && correlatedFailure.requestId === errorId
        && correlatedFailure.error === genericErrorFrame.error
        && Buffer.byteLength(JSON.stringify(correlatedFailure)) === responseLimit,
      JSON.stringify({ ok: correlatedFailure.ok, idRetained: correlatedFailure.requestId === errorId }),
    );
  } finally {
    observedEngine.ccall = originalCcall;
  }
  const afterBoundedFailure = await request("hd_lookup", { text: "食べる" });
  check(
    "a healthy lookup after boundary errors keeps its generation and complete result",
    afterBoundedFailure.ok === true && afterBoundedFailure.generation === lookup.generation
      && afterBoundedFailure.results[0]?.term.expression === "食べる",
    JSON.stringify(afterBoundedFailure.error),
  );

  const styles = await request("hd_styles");
  check(
    "hd_styles returns the dictionary's CSS",
    styles.ok === true && styles.styles.length === 1 && styles.styles[0].dictionary === FIXTURE_TITLE,
    JSON.stringify(styles),
  );

  const media = await request("hd_media", { dictionary: FIXTURE_TITLE, path: "media/kanji.png" });
  check(
    "hd_media returns a data: URL glossary.js will accept",
    media.ok === true && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(media.dataUrl ?? ""),
    JSON.stringify(media.dataUrl?.slice(0, 48)),
  );
  const absentMedia = await request("hd_media", { dictionary: FIXTURE_TITLE, path: "media/nope.png" });
  equal("absent media is dataUrl null, not an error", [absentMedia.ok, absentMedia.dataUrl], [true, null]);

  section("error paths");
  const bogus = await request("hd_bogus");
  equal("an unknown type is answered, not dropped", [bogus.type, bogus.ok], ["hd_bogus_result", false]);
  check("the unknown-type reply names the type", /hd_bogus/u.test(bogus.error ?? ""), JSON.stringify(bogus.error));

  const badImport = await request("hd_import", {
    blobUrl: createObjectURL(new Uint8Array(await readFile(resolve(HERE, "fixtures/not-a-zip.txt")))),
    fileName: "not-a-zip.txt",
  });
  check("importing a non-zip fails cleanly", badImport.ok === false, JSON.stringify(badImport));
  check("the failed import still carries a report", badImport.report?.success === false, JSON.stringify(badImport.report));
  const afterBadImport = await request("hd_status");
  equal(
    "a failed import restores the previously loaded set",
    [afterBadImport.ready, afterBadImport.dictionaryCount],
    [true, 4],
  );

  const noBlob = await request("hd_import", { blobUrl: "", fileName: "x.zip" });
  check("an import with no blob URL is rejected, not thrown", noBlob.ok === false, JSON.stringify(noBlob));

  const declaredLength = await request("hd_import", {
    blobUrl: createDeclaredLengthURL(formerArchiveByteLimit + 1, zip),
    fileName: "huge.zip",
  });
  equal(
    "a valid archive with a declared length above the former cap imports successfully",
    [declaredLength.ok, declaredLength.report?.title, declaredLength.report?.termCount],
    [true, FIXTURE_TITLE, 6],
  );

  const afterDeclaredLength = await request("hd_status");
  equal(
    "a failed empty import restores the previously loaded set",
    [afterDeclaredLength.ready, afterDeclaredLength.dictionaryCount],
    [true, 4],
  );

  const stateBeforeRejectedReimport = await storedDictionaryState();
  const generationRowsBeforeRejectedReimport = idb.keys("/dicts")
    .filter((path) => path.startsWith("/dicts/.hdw-generation-"))
    .sort();
  storage.failNextSet("injected reimport state CAS failure");
  const rejectedReimport = await request("hd_import", {
    blobUrl: createObjectURL(buildTitledZip(FIXTURE_TITLE)),
    fileName: "rejected-reimport.zip",
  });
  const stateAfterRejectedReimport = await storedDictionaryState();
  const statusAfterRejectedReimport = await request("hd_status");
  const mediaAfterRejectedReimport = await request("hd_media", {
    dictionary: FIXTURE_TITLE,
    path: "media/kanji.png",
  });
  const generationRowsAfterRejectedReimport = idb.keys("/dicts")
    .filter((path) => path.startsWith("/dicts/.hdw-generation-"))
    .sort();
  equal(
    "a failed reimport state CAS preserves the prior stored path and data",
    [
      rejectedReimport.ok,
      stateAfterRejectedReimport,
      statusAfterRejectedReimport.dictionaryCount,
      mediaAfterRejectedReimport.dataUrl,
      generationRowsAfterRejectedReimport,
    ],
    [
      false,
      stateBeforeRejectedReimport,
      4,
      media.dataUrl,
      generationRowsBeforeRejectedReimport,
    ],
  );

  // Restore the fixture so this deliberately failing regression does not turn
  // the existing renderer and removal checks into unrelated follow-on failures.
  await request("hd_import", {
    blobUrl: createObjectURL(zip),
    fileName: "restore-after-rejected-reimport.zip",
  });

  section("renderer against real engine output");
  // 漢字 is the fixture's structured-content entry, the only one carrying an <img>.
  const imageLookup = await request("hd_lookup", {
    text: "漢字",
    maxResults: 32,
    scanLength: 16,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
  });
  check("hd_lookup finds the structured-content entry", imageLookup.results.length > 0, JSON.stringify(imageLookup.error));
  // A skip here is a failure. The renderer is the only consumer that reads
  // contract B field by field, and a printed SKIP under "44 passed, 0 failed"
  // hid the fact that nothing exercised it at all.
  const rendered = await renderStage({ imageLookup, kanji: kanji.kanji, lookup, media });
  if (rendered === null) {
    fail(
      "jsdom is loadable, so the renderer stage can run",
      `${jsdomFailure}\nSearched: ${jsdomSearchPaths().join(", ")}\n` +
        "Install it outside the repo and point HACHIDORI_JSDOM or NODE_PATH at that tree:\n" +
        `  (cd ${DEFAULT_JSDOM_TREE} && npm install jsdom)\n` +
        `  NODE_PATH=${DEFAULT_JSDOM_TREE}/node_modules node test/extension-smoke.mjs`,
    );
  }
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
    settingsCustom?.startup?.customReadCount === 0
      && settingsCustom.startup.formHidden === true
      && settingsCustom.startup.sourceFetchedDirectly === false
      && settingsCustom.startup.sourceHasMaximumLength === false
      && settingsCustom.startup.sourceDescribedBy
        === "custom-dictionary-status custom-dictionary-errors"
      && settingsCustom.eventBeforeReadReply?.value === "newer event, にゅー, wins\n"
      && settingsCustom.eventBeforeReadReply.expanded === "true"
      && settingsCustom.eventBeforeReadReply.readCount === 1
      && settingsCustom.eventBeforeReadReply.saveDisabled === true
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
      && JSON.stringify(settingsCustom.bulkState) === JSON.stringify([
        { id: CUSTOM_DICTIONARY_ID, enabled: true },
        { id: "ordinary-id", enabled: false },
      ])
      && JSON.stringify(settingsCustom.favoriteState) === JSON.stringify([
        { id: CUSTOM_DICTIONARY_ID, favorite: true },
        { id: "ordinary-id", favorite: true },
      ]),
    JSON.stringify(settingsCustom),
  );
  const settingsConflict = await settingsConflictStage();
  check(
    "settings preserve a concurrent alias draft, queue its next action, and restore a rejected edit",
    settingsConflict?.draftSurvived === true
      && settingsConflict.secondActionTargetSurvived === true
      && settingsConflict.casRequests?.length === 2
      && settingsConflict.casRequests[0].type === "hd_state_cas"
      && settingsConflict.casRequests[0].baseRevision === 8
      && settingsConflict.casRequests[0].dictionaries[0].displayName === "My draft"
      && settingsConflict.casRequests[0].dictionaries[0].favorite === true
      && settingsConflict.casRequests[1].type === "hd_apply_state"
      && settingsConflict.casRequests[1].baseRevision === 9
      && settingsConflict.casRequests[1].dictionaries[0].displayName === "My draft"
      && settingsConflict.casRequests[1].dictionaries[0].enabled === false
      && settingsConflict.directDictionaryWrites === 0
      && settingsConflict.enabled === true
      && settingsConflict.kanjiChoice === true
      && settingsConflict.title === "Concurrent final"
      && settingsConflict.canonical === "Generic"
      && settingsConflict.favorite === true
      && settingsConflict.checkboxFocused === true
      && settingsConflict.conflictStatus.includes("not saved")
      && settingsConflict.removalControlsBlocked === true
      && settingsConflict.removalControlsRestored === true,
    JSON.stringify(settingsConflict),
  );
  check(
    "settings search, visible selection, bulk changes, and every reorder path share stable package state",
    settingsConflict?.management?.localeIndependentVisibleIds?.join(",") === "11111111111111111111111111111111"
      && settingsConflict.management.visibleIds?.join(",") === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,cccccccccccccccccccccccccccccccc"
      && settingsConflict.management.selectedVisibleIds?.join(",") === settingsConflict.management.visibleIds.join(",")
      && settingsConflict.management.bulkRequests?.length === 4
      && settingsConflict.management.bulkRequests.every((request, index) =>
        request.type === (index < 2 ? "hd_apply_state" : "hd_state_cas"))
      && settingsConflict.management.bulkHiddenUntouched === true
      && settingsConflict.management.bulkValues?.join(",") === "false,false,false,true,true,true,true,true,true,false,false,false"
      && JSON.stringify(settingsConflict.management.queuedOrderTitles) === JSON.stringify([
        ["ＡＬＰＨＡ", "Hidden one", "Alpha alias", "Ａｌｐｈａ notes", "Hidden two"],
        ["ＡＬＰＨＡ", "Hidden one", "Ａｌｐｈａ notes", "Alpha alias", "Hidden two"],
      ])
      && settingsConflict.management.orderRequests?.every((request) => request.type === "hd_apply_state")
      && JSON.stringify(settingsConflict.management.orderTitles) === JSON.stringify([
        ["ＡＬＰＨＡ", "Alpha alias", "Hidden one", "Hidden two", "Ａｌｐｈａ notes"],
        ["Ａｌｐｈａ notes", "ＡＬＰＨＡ", "Alpha alias", "Hidden one", "Hidden two"],
        ["Ａｌｐｈａ notes", "Alpha alias", "ＡＬＰＨＡ", "Hidden one", "Hidden two"],
        ["Alpha alias", "Ａｌｐｈａ notes", "ＡＬＰＨＡ", "Hidden one", "Hidden two"],
      ])
      && settingsConflict.management.hiddenOrderPreserved === true
      && settingsConflict.management.searchAfterOperations === " ＡｌＰｈＡ "
      && settingsConflict.management.selectedAfterOperations?.join(",") === settingsConflict.management.visibleIds.join(",")
      && settingsConflict.management.selectedAfterExternalChange?.join(",") === "cccccccccccccccccccccccccccccccc,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      && settingsConflict.management.visibleAfterExternalChange?.join(",") === "cccccccccccccccccccccccccccccccc,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    JSON.stringify(settingsConflict?.management),
  );
  const settingsBatch = await settingsBatchImportStage();
  check(
    "settings import every selected archive sequentially and retain each outcome",
    settingsBatch?.multiple === true
      && settingsBatch.pickerValue === ""
      && JSON.stringify(settingsBatch.importRequests?.map(({ fileName }) => fileName))
        === JSON.stringify(["first.zip", "broken.zip", "replacement.zip"])
      && settingsBatch.importRequests?.every(({ state, completed }, index) =>
        state.includes(`${index + 1} of 3`)
          && state.includes(`${index} of 3 complete`)
          && completed === index)
      && settingsBatch.maxActiveImports === 1
      && JSON.stringify(settingsBatch.revokedUrls) === JSON.stringify(settingsBatch.createdUrls)
      && JSON.stringify(settingsBatch.outcomes?.map(({ error }) => error))
        === JSON.stringify([false, true, false])
      && settingsBatch.outcomes?.[0]?.text.includes("first.zip")
      && settingsBatch.outcomes[0].text.includes("Imported First")
      && settingsBatch.outcomes?.[1]?.text.includes("broken.zip")
      && settingsBatch.outcomes[1].text.includes("broken archive")
      && settingsBatch.outcomes?.[2]?.text.includes("replacement.zip")
      && settingsBatch.outcomes[2].text.includes("Imported First")
      && settingsBatch.finalState === "Finished 3 of 3 archives — 2 imported, 1 failed."
      && settingsBatch.controlsRestored === true
      && settingsBatch.stateReads === 1
      && settingsBatch.statusReads === 1,
    JSON.stringify(settingsBatch),
  );
  const autosave = await settingsAutosaveStage();
  check(
    "Settings coalesces edited fields and queues only one revisioned save at a time",
    autosave?.writesBeforeDelay === 0 && autosave.writesDuringSave === 1
      && autosave.firstRequest?.baseRevision === 4
      && JSON.stringify(autosave.firstRequest?.options) === JSON.stringify({ scanLength: 25, maxResults: 64 })
      && autosave.secondRequest?.baseRevision === 5
      && JSON.stringify(autosave.secondRequest?.options) === JSON.stringify({ maxResults: 96 }),
    JSON.stringify(autosave),
  );
  check(
    "Settings keeps newer committed state and local drafts across old replies and explicit conflicts",
    autosave?.afterOldReply?.maxResults === "96"
      && autosave.afterOldReply.frequencyOrder === "descending"
      && autosave.conflictVisible === true
      && autosave.afterDiscard?.maxResults === "64"
      && autosave.afterDiscard.frequencyOrder === "descending"
      && autosave.afterStaleEvent?.maxResults === "80"
      && autosave.afterStaleEvent.frequencyOrder === "descending",
    JSON.stringify(autosave),
  );
  check(
    "Settings retains failed drafts and retries against the current committed revision",
    autosave?.failedDraft === "90"
      && autosave.retryRequest?.baseRevision === 7
      && autosave.retryRequest?.options?.maxResults === 90
      && autosave.finalValue === "90" && autosave.finalStatus === "Saved."
      && autosave.typedBeforeExternalRequest?.baseRevision === 8
      && autosave.startupRequest?.baseRevision === 2 && autosave.undoCanLeave === true,
    JSON.stringify(autosave),
  );
  check(
    "settings manage normalized global groups and stable ordered memberships",
    settingsConflict?.groups?.normalisedGroupName === "INDIGO Deck"
      && settingsConflict.groups.duplicateError?.includes("already exists")
      && settingsConflict.groups.reservedError?.includes("reserved")
      && settingsConflict.groups.requestsAfterDuplicate === 1
      && settingsConflict.groups.requestsAfterReserved === 1
      && settingsConflict.groups.groupOrderAfterMove?.join(",") === "Grammar,INDIGO Deck"
      && settingsConflict.groups.groupMoveFocusRetained === true
      && settingsConflict.groups.groupAddFocusRetained === true
      && settingsConflict.groups.membershipBeforeMove?.join(",")
        === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      && settingsConflict.groups.membershipAfterMove?.join(",")
        === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      && settingsConflict.groups.memberMoveFocusRetained === true
      && settingsConflict.groups.memberRemoveFocusRetained === true
      && settingsConflict.groups.membershipAfterAlias?.join(",")
        === settingsConflict.groups.membershipAfterMove.join(",")
      && settingsConflict.groups.renamedMemberLabel === "Renamed after grouping"
      && settingsConflict.groups.finalGroups?.length === 1
      && settingsConflict.groups.finalGroups[0].name === "Reading"
      && settingsConflict.groups.finalGroups[0].dictionaryIds?.join(",")
        === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      && settingsConflict.groups.requestTypes?.length === 9
      && settingsConflict.groups.requestTypes.every((type) => type === "hd_state_cas")
      && settingsConflict.groups.dictionarySnapshots.every((snapshot) =>
        snapshot.join(",") === settingsConflict.groups.dictionarySnapshots[0].join(","))
     && settingsConflict.directDictionaryWrites === 0,
    JSON.stringify(settingsConflict?.groups),
  );
  check(
    "queued group creates and renames revalidate normalized unique names",
    settingsConflict?.groups?.queuedCreateNames?.length === 1
      && settingsConflict.groups.queuedCreateError?.includes("already exists")
      && settingsConflict.groups.queuedCreateRequestCount === 1
      && settingsConflict.groups.queuedRenameNames?.filter((name) => name === "Shared name").length === 1
      && settingsConflict.groups.queuedRenameNames?.includes("Rename two")
      && settingsConflict.groups.queuedRenameError?.includes("already exists")
      && settingsConflict.groups.queuedRenameRequestCount === 1,
    JSON.stringify(settingsConflict?.groups),
  );
  check(
    "group rerenders preserve newer focus outside the management lists",
    settingsConflict?.groups?.externalFocusPreserved === true,
    JSON.stringify(settingsConflict?.groups),
  );
  const recommendedSettings = await settingsRecommendedImportStage();
  check(
    "settings install the trusted catalogue sequentially and retry only missing entries",
    recommendedSettings?.clean.starterHidden === false
      && recommendedSettings.clean.installHidden === false
      && recommendedSettings.clean.retryHidden === true
      && recommendedSettings.clean.localImportVisible === true
      && JSON.stringify(recommendedSettings.clean.links.map(({ name, href }) => [name, href]))
        === JSON.stringify(RECOMMENDED_DICTIONARIES.map((entry) => [entry.name, entry.publisherUrl]))
      && recommendedSettings.clean.links.every(({ target, rel }) =>
        target === "_blank" && rel.split(/\s+/u).includes("noopener") && rel.split(/\s+/u).includes("noreferrer"))
      && JSON.stringify(recommendedSettings.fetches.slice(0, 4).map(({ sourceId }) => sourceId))
        === JSON.stringify(RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId))
      && recommendedSettings.fetches.every(({ sourceId, state }) =>
        state.includes(`Downloading ${RECOMMENDED_DICTIONARIES.find((entry) => entry.sourceId === sourceId).name}`))
      && recommendedSettings.imports.every(({ sourceId, finalUrl, state }) => {
        const entry = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.sourceId === sourceId);
        return finalUrl === entry.downloadUrl && state.includes(`Importing ${entry.name}`);
      })
      && recommendedSettings.maxActiveDownloads === 1
      && recommendedSettings.maxActiveImports === 1
      && recommendedSettings.firstOutcomes.length === 4
      && JSON.stringify(recommendedSettings.firstOutcomes.map(({ error }) => error))
        === JSON.stringify([false, true, true, false])
      && recommendedSettings.partial.state
        === "Finished 4 of 4 recommended dictionaries — 2 imported, 2 failed."
      && recommendedSettings.starterHiddenAfterFirst === true
      && recommendedSettings.partial.starterHidden === true
      && recommendedSettings.partial.retryHidden === false
      && JSON.stringify(recommendedSettings.partial.sourceIds)
        === JSON.stringify(["jitendex", "jiten"])
      && JSON.stringify(recommendedSettings.retrySourceIds)
        === JSON.stringify(["jmnedict", "bees-ultimate-kanji-dictionary"])
      && recommendedSettings.completeSourceIds.length === RECOMMENDED_DICTIONARIES.length
      && RECOMMENDED_DICTIONARIES.every(({ sourceId }) =>
        recommendedSettings.completeSourceIds.includes(sourceId))
      && recommendedSettings.retryHiddenWhenComplete === true
      && recommendedSettings.legacyIndexOnlySkipped === true,
    JSON.stringify(recommendedSettings),
  );
  const managedUpdateSettings = await settingsManagedUpdatesStage();
  check(
    "settings expose one global schedule and per-package managed update actions",
    managedUpdateSettings?.initial.schedule === "weekly"
      && managedUpdateSettings.initial.lastChecked.includes("9/4/2026")
      && managedUpdateSettings.initial.managedStatus.includes("Update available")
      && managedUpdateSettings.initial.managedUpdateHidden === false
      && managedUpdateSettings.initial.insecureMetadata.includes("Local archive")
      && managedUpdateSettings.initial.insecureStatus === "Not update-checkable"
      && managedUpdateSettings.initial.insecureUpdateHidden === true
      && managedUpdateSettings.initial.localStatus === "Not update-checkable"
      && managedUpdateSettings.initial.localUpdateHidden === true
      && managedUpdateSettings.checkRequest?.type === "hd_updates_check"
      && managedUpdateSettings.checkedState.includes("1 update available")
      && managedUpdateSettings.oneRequest?.type === "hd_updates_install"
      && managedUpdateSettings.oneRequest.dictionaryIds?.join(",") === "managed-id"
      && managedUpdateSettings.afterOneStatus.startsWith("Up to date")
      && managedUpdateSettings.allRequest?.type === "hd_updates_install"
      && managedUpdateSettings.allRequest.dictionaryIds?.join(",") === "managed-id"
      && managedUpdateSettings.scheduleRequest?.type === "hd_updates_schedule"
      && managedUpdateSettings.scheduleRequest.schedule === "daily",
    JSON.stringify(managedUpdateSettings),
  );
  const staleKanjiRenders = await staleKanjiResponseStage("storage-change");
  check(
    "a storage change invalidates an in-flight clicked-kanji lookup",
    Array.isArray(staleKanjiRenders?.renders) && staleKanjiRenders.renders.length === 0,
    JSON.stringify(staleKanjiRenders),
  );
  const groupOnlyKanjiRenders = await staleKanjiResponseStage("group-storage-change");
  check(
    "a group-only state change leaves an in-flight clicked-kanji lookup alone",
    Array.isArray(groupOnlyKanjiRenders?.renders)
      && groupOnlyKanjiRenders.renders.length === 1
      && groupOnlyKanjiRenders.popupHidden === false,
    JSON.stringify(groupOnlyKanjiRenders),
  );
  const staleBackRenders = await staleKanjiResponseStage("back");
  check(
    "Back invalidates an in-flight clicked-kanji lookup",
    Array.isArray(staleBackRenders?.renders) && staleBackRenders.renders.length === 1,
    JSON.stringify(staleBackRenders),
  );
  const staleInitialStorageRenders = await staleKanjiResponseStage("initial-storage");
  check(
    "initial dictionary hydration invalidates the lookup and hides its stale popup",
    Array.isArray(staleInitialStorageRenders?.renders)
      && staleInitialStorageRenders.renders.length === 0
      && staleInitialStorageRenders.popupHidden === true,
    JSON.stringify(staleInitialStorageRenders),
  );

  const noteContent = await contentNoteStage();
  check(
    "only the current render failure clears the content popup",
    noteContent?.renderFailure === true,
    JSON.stringify(noteContent?.renderFailure),
  );
  check(
    "content readers ignore older and repeated option revisions before their next lookup",
    noteContent?.newestOnlyOptions === true,
    JSON.stringify(noteContent?.newestOnlyOptions),
  );
  check(
    "content Note callbacks replay exact ordinary and internal-link requests with newer state",
    noteContent?.callbacksWired === true
      && noteContent.eventFirst?.request?.type === "hd_lookup"
      && noteContent.eventFirst.request.text === "\u5185\u90e8\u8a9e"
      && noteContent.eventFirst.request.maxResults === 7
      && noteContent.eventFirst.request.scanLength === 9
      && noteContent.eventFirst.request.options?.frequencyDictionary === "Frequency A"
      && noteContent.eventFirst.request.options?.frequencyOrder === "descending"
      && noteContent.eventFirst.request.options?.primaryReading === "\u306a\u3044\u3076\u3054"
      && noteContent.eventFirst.selectedDictionaryTab?.dictionary === "Projected"
      && noteContent.eventFirst.stateRevision === 3
      && noteContent.eventFirst.displayName === "event-newer"
      && noteContent.eventFirst.popupHidden === false
      && noteContent.replyFirst?.request?.type === "hd_lookup"
      && noteContent.replyFirst.request.text === "\u98df\u3079\u305f"
      && noteContent.replyFirst.stateRevision === 4
      && noteContent.replyFirst.displayName === "reply-newer",
    JSON.stringify(noteContent),
  );
  check(
    "content Note refresh preserves clicked-kanji dictionary intent and Back context",
    noteContent?.termKanji?.request?.type === "hd_lookup_dictionary"
      && noteContent.termKanji.request.dictionary === "Generic"
      && noteContent.termKanji.request.text === "\u98df"
      && noteContent.termKanji.request.scanLength === 1
      && noteContent.termKanji.request.maxResults === 7
      && noteContent.termKanji.request.options?.frequencyDictionary === "Frequency A"
      && noteContent.termKanji.request.options?.frequencyOrder === "descending"
      && noteContent.termKanji.hasBack === true
      && noteContent.termKanji.backExpression === "\u98df\u3079\u305f"
      && noteContent.kanji?.request?.type === "hd_kanji"
      && noteContent.kanji.request.character === "\u98df"
      && noteContent.kanji.renderedDictionaries?.join(",") === "Generic"
      && noteContent.kanji.hasBack === true,
    JSON.stringify(noteContent),
  );
  check(
    "a successful Note append cannot become retryable when lookup refresh fails",
    noteContent?.refreshFailure?.resolved === true
      && noteContent.refreshFailure.appendCount === 1
      && noteContent.refreshFailure.refreshCount === 1,
    JSON.stringify(noteContent?.refreshFailure),
  );
  check(
    "Note refresh skips a replaced view or an anchor detached before or during its response",
    noteContent?.replaced?.refreshCount === 0
      && noteContent.replaced.backExpression === "\u98df\u3079\u305f"
      && noteContent.replaced.popupHidden === true
      && noteContent.detached?.refreshCount === 0
      && noteContent.detached.resolved === true
      && noteContent.detachedDuringRefresh?.term?.refreshCount === 1
      && noteContent.detachedDuringRefresh.term.renderCount === 0
      && noteContent.detachedDuringRefresh.term.popupHidden === true
      && noteContent.detachedDuringRefresh.term.resolved === true
      && noteContent.detachedDuringRefresh?.kanji?.refreshCount === 1
      && noteContent.detachedDuringRefresh.kanji.renderCount === 0
      && noteContent.detachedDuringRefresh.kanji.popupHidden === true
      && noteContent.detachedDuringRefresh.kanji.resolved === true,
    JSON.stringify({
      replaced: noteContent?.replaced,
      detached: noteContent?.detached,
      detachedDuringRefresh: noteContent?.detachedDuringRefresh,
    }),
  );
  check(
    "Note editing cancels hover dismissal and consumes Escape before popup capture",
    noteContent?.guards?.pendingBeforeEditing === true
      && noteContent.guards.pendingWhileEditing === false
      && noteContent.guards.caretCalls === 0
      && noteContent.guards.firstEscapeHidden === false
      && noteContent.guards.firstEscapeClears === 0
      && noteContent.guards.secondEscapeHidden === true
      && noteContent.guards.secondEscapeClears === 1
      && noteContent.guards.closeCalls === 2
      && noteContent.deferredInvalidation?.visibleWhileEditing === true
      && noteContent.deferredInvalidation.hiddenAfterClose === true,
    JSON.stringify({
      deferredInvalidation: noteContent?.deferredInvalidation,
      guards: noteContent?.guards,
    }),
  );

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
  storage.failNextSet("injected storage failure");
  const failedRemove = await request("hd_remove", { title: FIXTURE_TITLE });
  const stateAfterFailedRemove = await storedDictionaryState();
  check(
    "a remove whose storage write fails reports the failure",
    failedRemove.ok === false
      && JSON.stringify(stateAfterFailedRemove) === JSON.stringify(stateBeforeFailedRemove),
    JSON.stringify({ failedRemove, stateAfterFailedRemove }),
  );
  const afterFailedRemove = await request("hd_status");
  equal(
    "a failed remove reloads the dictionaries it unloaded",
    [afterFailedRemove.ready, afterFailedRemove.dictionaryCount],
    [true, 4],
  );

  const unsafeRemove = await request("hd_remove", { title: "../outside" });
  const afterUnsafeRemove = await request("hd_status");
  equal(
    "hd_remove rejects a title that can escape the dictionary root",
    [unsafeRemove.ok, afterUnsafeRemove.dictionaryCount],
    [false, 4],
  );

  const removed = await request("hd_remove", { title: FIXTURE_TITLE });
  check("hd_remove succeeds", removed.ok === true, JSON.stringify(removed));
  const afterRemove = await request("hd_status");
  equal("nothing is loaded after a remove", [afterRemove.ready, afterRemove.dictionaryCount], [true, 0]);
  const stateAfterRemove = await storedDictionaryState();
  equal("the logical dictionary inventory is empty", stateAfterRemove.dictionaries, []);
  equal("removing a dictionary prunes its stable group membership", stateAfterRemove.groups, [{
    ...studyGroup,
    dictionaryIds: [],
  }]);
  const generationBefore = afterRemove.generation;
  const noop = await request("hd_remove", { title: "never imported" });
  const afterNoop = await request("hd_status");
  equal(
    "removing an unknown title is a no-op that does not bump generation",
    [noop.ok, afterNoop.generation],
    [true, generationBefore],
  );

  section("a trained (.hoshidicts_4) dictionary through the extension layer");
  // Everything above imports the 6-row fixture, which is under the importer's
  // zstd-training floor and therefore lands in the pre-4 layout. Nothing outside
  // node-smoke.mjs had ever seen the layout the current engine writes for a real
  // dictionary: a .hoshidicts_4 marker, a dict.zstd, and glossaries compressed
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
  // runtime that does not recognise .hoshidicts_4 rejects this package instead.
  const trainedStatus = await request("hd_status");
  equal(
    "offscreen.js recognises the .hoshidicts_4 directory as a dictionary",
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
      && persisted.includes(`${trainedPath}/.hoshidicts_4`),
    JSON.stringify(persisted.sort()),
  );
  // The real assertion: these bytes only come back if the dictionary the importer
  // trained was found and loaded.
  const [trainedExpression, , , , , trainedGlossary] = TRAINED_TERMS[TRAINED_TERMS.length - 1];
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

  const restartedEngineService = await import(
    `file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}?restart`
  );
  restartedEngineService.configureEngineService(
    (message) => offscreenChrome.runtime.sendMessage(message),
    { createHoshidicts, storageBackend: "idbfs", lowRam: true },
  );
  let restartCounter = 0;
  const restartRequest = (type, fields = {}) => {
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
  const restartedReload = await restartRequest("hd_reload");
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

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

async function settingsAutosaveStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html`,
  });
  const { window } = dom;
  let listener;
  let storedOptions = { revision: 2, scanLength: 16, maxResults: 32, frequencyOrder: "auto" };
  let releaseInitialState;
  const writes = [];
  const pending = [];
  window.chrome = {
    runtime: {
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          await new Promise((release) => { releaseInitialState = release; });
          return { ok: true, state: { schemaVersion: 1, revision: 0, dictionaries: [], groups: [] } };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
        }
        if (message.type === "hd_options_write") {
          writes.push(structuredClone(message));
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        }
        throw new Error(`unexpected autosave request ${message.type}`);
      },
    },
    storage: {
      local: { async get() { return { options: structuredClone(storedOptions) }; } },
      onChanged: { addListener(value) { listener = value; } },
    },
  };
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await wait(5);
    if (!predicate()) throw new Error("Settings autosave did not reach its expected state");
  }
  const field = (name) => window.document.getElementById(`opt-${name}`);
  const state = () => ({ maxResults: field("max-results").value, frequencyOrder: field("frequency-order").value });
  const edit = (name, value) => {
    field(name).value = value;
    field(name).dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const emit = (value) => listener({ options: { newValue: structuredClone(value) } }, "local");
  const commit = (value) => { storedOptions = value; emit(value); };
  const status = () => window.document.getElementById("options-status").textContent;
  try {
    loadSettingsScript(window);
    await until(() => typeof releaseInitialState === "function");
    field("max-results").focus();
    field("max-results").value = "64";
    field("max-results").dispatchEvent(new window.Event("input", { bubbles: true }));
    releaseInitialState();
    await until(() => window.document.getElementById("engine-status").textContent.startsWith("Ready"));
    commit({ ...storedOptions, revision: 3, maxResults: 16 });
    field("max-results").dispatchEvent(new window.Event("change", { bubbles: true }));
    field("max-results").blur();
    await until(() => writes.length === 1);
    const startupRequest = writes[0];
    pending.shift().resolve({ ok: false, conflict: true, error: "Settings changed in another page.", options: storedOptions });
    await until(() => status().includes("Could not save"));
    window.document.getElementById("options-use-saved").click();
    field("max-results").focus();
    for (const value of ["64", "16"]) {
      field("max-results").value = value;
      field("max-results").dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    field("max-results").blur();
    const leave = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    const undoCanLeave = !leave.defaultPrevented;
    commit({ ...storedOptions, revision: 4, maxResults: 32 });
    writes.length = 0;
    edit("scan-length", "25");
    edit("max-results", "64");
    const result = { writesBeforeDelay: writes.length, startupRequest, undoCanLeave };
    await until(() => writes.length === 1);
    result.firstRequest = writes[0];
    edit("max-results", "96");
    await wait(180);
    result.writesDuringSave = writes.length;
    const firstCommit = { revision: 5, scanLength: 25, maxResults: 64, frequencyOrder: "auto" };
    commit(firstCommit);
    commit({ ...firstCommit, revision: 6, frequencyOrder: "descending" });
    pending.shift().resolve({ ok: true, options: firstCommit });
    await until(() => writes.length === 2);
    result.secondRequest = writes[1];
    result.afterOldReply = state();
    pending.shift().resolve({ ok: false, conflict: true, error: "Settings changed in another page.", options: storedOptions });
    await until(() => status().includes("Could not save"));
    await wait(0);
    result.conflictVisible = !window.document.getElementById("options-conflict-actions").hidden;
    window.document.getElementById("options-use-saved").click();
    result.afterDiscard = state();
    edit("max-results", "80");
    await until(() => writes.length === 3);
    const thirdCommit = { ...storedOptions, revision: 7, maxResults: 80 };
    storedOptions = thirdCommit;
    pending.shift().resolve({ ok: true, options: thirdCommit });
    await until(() => status() === "Saved.");
    emit({ ...firstCommit, revision: 6 });
    emit(thirdCommit);
    result.afterStaleEvent = state();
    edit("max-results", "90");
    await until(() => writes.length === 4);
    pending.shift().reject(new Error("worker reply was lost"));
    await until(() => status().includes("Could not save"));
    await wait(0);
    result.failedDraft = field("max-results").value;
    window.document.getElementById("options-retry").click();
    await until(() => writes.length === 5);
    result.retryRequest = writes[4];
    commit({ ...storedOptions, revision: 8, maxResults: 90 });
    pending.shift().resolve({ ok: true, options: storedOptions });
    await until(() => status() === "Saved.");
    result.finalValue = field("max-results").value;
    result.finalStatus = status();
    field("max-results").focus();
    field("max-results").value = "128";
    field("max-results").dispatchEvent(new window.Event("input", { bubbles: true }));
    commit({ ...storedOptions, revision: 9, maxResults: 24 });
    field("max-results").dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => writes.length === 6);
    result.typedBeforeExternalRequest = writes[5];
    pending.shift().resolve({ ok: false, conflict: true, error: "Settings changed in another page.", options: storedOptions });
    await until(() => status().includes("Could not save"));
    return result;
  } finally {
    dom.window.close();
  }
}

async function settingsBatchImportStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html`,
  });
  const { window } = dom;
  const state = { schemaVersion: 1, revision: 0, dictionaries: [] };
  const importReplies = [
    { ok: true, report: { success: true, title: "First", termCount: 1 } },
    { ok: false, error: "broken archive", report: { success: false, error: "broken archive" } },
    { ok: true, report: { success: true, title: "First", termCount: 2 } },
  ];
  const importRequests = [];
  const createdUrls = [];
  const revokedUrls = [];
  let activeImports = 0;
  let maxActiveImports = 0;
  let stateReads = 0;
  let statusReads = 0;

  window.URL.createObjectURL = (file) => {
    const url = `blob:settings-batch/${createdUrls.length}-${file.name}`;
    createdUrls.push(url);
    return url;
  };
  window.URL.revokeObjectURL = (url) => revokedUrls.push(url);
  window.chrome = {
    runtime: {
      id: "hachidorisettingsbatchsmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          stateReads += 1;
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_status") {
          statusReads += 1;
          return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_import") {
          activeImports += 1;
          maxActiveImports = Math.max(maxActiveImports, activeImports);
          const index = importRequests.length;
          importRequests.push({
            fileName: message.fileName,
            state: window.document.getElementById("import-state")?.textContent ?? "",
            completed: window.document.querySelectorAll("#import-detail .import-result").length,
          });
          await new Promise((done) => window.setTimeout(done, 0));
          activeImports -= 1;
          return importReplies[index];
        }
        throw new Error(`unexpected settings batch request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
          return { options: { kanjiClickDictionary: "" } };
        },
      },
      onChanged: { addListener() {} },
    },
  };
  loadSettingsScript(window);

  const deadline = Date.now() + 2000;
  while (!window.document.getElementById("engine-status")?.textContent?.startsWith("Ready")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  stateReads = 0;
  statusReads = 0;

  const input = window.document.getElementById("import-file");
  const files = [
    new window.File(["first"], "first.zip", { type: "application/zip" }),
    new window.File(["broken"], "broken.zip", { type: "application/zip" }),
    new window.File(["replacement"], "replacement.zip", { type: "application/zip" }),
  ];
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));

  const batchDeadline = Date.now() + 2000;
  while ((importRequests.length < files.length || input.disabled) && Date.now() < batchDeadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const outcomes = [...window.document.querySelectorAll("#import-detail .import-result")].map((item) => ({
    text: item.textContent,
    error: item.classList.contains("is-error"),
  }));
  const result = {
    multiple: input.multiple,
    pickerValue: input.value,
    importRequests,
    maxActiveImports,
    createdUrls,
    revokedUrls,
    outcomes,
    finalState: window.document.getElementById("import-state")?.textContent ?? "",
    controlsRestored: input.disabled === false,
    stateReads,
    statusReads,
  };
  dom.window.close();
  return result;
}

async function settingsRecommendedImportStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html`,
  });
  const { window } = dom;
  let state = { schemaVersion: 1, revision: 0, dictionaries: [] };
  let storageListener = null;
  const fetches = [];
  const imports = [];
  const fetchAttempts = new Map();
  const importAttempts = new Map();
  let activeDownloads = 0;
  let maxActiveDownloads = 0;
  let activeImports = 0;
  let maxActiveImports = 0;
  let starterHiddenAfterFirst = false;

  window.URL.createObjectURL = (file) => `blob:recommended/${file.name}`;
  window.URL.revokeObjectURL = () => {};
  window.fetch = async (url) => {
    const entry = RECOMMENDED_DICTIONARIES.find((candidate) => candidate.downloadUrl === url);
    if (!entry) {
      throw new Error(`unexpected recommended URL ${url}`);
    }
    activeDownloads += 1;
    maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
    const attempt = (fetchAttempts.get(entry.sourceId) ?? 0) + 1;
    fetchAttempts.set(entry.sourceId, attempt);
    fetches.push({
      sourceId: entry.sourceId,
      state: window.document.getElementById("import-state")?.textContent ?? "",
    });
    await new Promise((done) => window.setTimeout(done, 0));
    activeDownloads -= 1;
    if (entry.sourceId === "jmnedict" && attempt === 1) {
      return { ok: false, status: 503, url };
    }
    return {
      ok: true,
      status: 200,
      url,
      async blob() {
        return new window.Blob([entry.sourceId], { type: "application/zip" });
      },
    };
  };
  window.chrome = {
    runtime: {
      id: "hachidorirecommendedsmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: state.dictionaries.length };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_import") {
          activeImports += 1;
          maxActiveImports = Math.max(maxActiveImports, activeImports);
          const entry = RECOMMENDED_DICTIONARIES.find(
            (candidate) => candidate.sourceId === message.sourceId,
          );
          const attempt = (importAttempts.get(message.sourceId) ?? 0) + 1;
          importAttempts.set(message.sourceId, attempt);
          imports.push({
            sourceId: message.sourceId,
            finalUrl: message.finalUrl,
            fileName: message.fileName,
            state: window.document.getElementById("import-state")?.textContent ?? "",
          });
          await new Promise((done) => window.setTimeout(done, 0));
          activeImports -= 1;
          if (message.sourceId === "bees-ultimate-kanji-dictionary" && attempt === 1) {
            return { ok: false, error: "simulated import failure", report: { success: false } };
          }
          const counts = {
            termCount: entry.capabilities.includes("term") ? 1 : 0,
            frequencyCount: entry.capabilities.includes("freq") ? 1 : 0,
            pitchCount: entry.capabilities.includes("pitch") ? 1 : 0,
            kanjiCount: entry.capabilities.includes("kanji") ? 1 : 0,
            mediaCount: entry.capabilities.includes("media") ? 1 : 0,
          };
          const dictionary = genericPackage({
            id: `recommended-${entry.sourceId}`,
            title: entry.title,
            revision: entry.revision,
            sourceId: entry.sourceId,
            isUpdatable: true,
            indexUrl: entry.indexUrl,
            downloadUrl: entry.downloadUrl,
            ...counts,
          });
          state = {
            schemaVersion: 1,
            revision: state.revision + 1,
            dictionaries: [
              ...state.dictionaries.filter((candidate) => candidate.sourceId !== entry.sourceId),
              dictionary,
            ],
          };
          storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
          if (state.dictionaries.length === 1) {
            starterHiddenAfterFirst = window.document.getElementById("recommended-starter")?.hidden === true;
          }
          return { ok: true, report: { success: true, title: entry.title, ...counts } };
        }
        throw new Error(`unexpected recommended settings request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
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

  const deadline = Date.now() + 2000;
  while (!window.document.getElementById("engine-status")?.textContent?.startsWith("Ready")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const links = [...window.document.querySelectorAll("a.recommended-dictionary-link")].map((anchor) => ({
    name: anchor.textContent,
    href: anchor.href,
    target: anchor.target,
    rel: anchor.rel,
  }));
  const clean = {
    starterHidden: window.document.getElementById("recommended-starter")?.hidden,
    installHidden: window.document.getElementById("install-recommended")?.hidden,
    retryHidden: window.document.getElementById("recommended-retry")?.hidden,
    localImportVisible: window.document.getElementById("import-file")?.closest(".file-button")?.hidden !== true,
    links,
  };

  window.document.getElementById("install-recommended")?.click();
  while (!(window.document.getElementById("import-state")?.textContent ?? "").startsWith(
    "Finished 4 of 4 recommended dictionaries",
  ) && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const firstOutcomes = [...window.document.querySelectorAll("#import-detail .import-result")].map((item) => ({
    text: item.textContent,
    error: item.classList.contains("is-error"),
  }));
  const partial = {
    state: window.document.getElementById("import-state")?.textContent ?? "",
    starterHidden: window.document.getElementById("recommended-starter")?.hidden,
    retryHidden: window.document.getElementById("recommended-retry")?.hidden,
    sourceIds: state.dictionaries.map((dictionary) => dictionary.sourceId),
  };

  const retryStart = fetches.length;
  window.document.getElementById("retry-recommended")?.click();
  while (!(window.document.getElementById("import-state")?.textContent ?? "").startsWith(
    "Finished 2 of 2 recommended dictionaries",
  ) && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const result = {
    clean,
    fetches,
    imports,
    firstOutcomes,
    partial,
    retrySourceIds: fetches.slice(retryStart).map(({ sourceId }) => sourceId),
    completeSourceIds: state.dictionaries.map((dictionary) => dictionary.sourceId),
    retryHiddenWhenComplete: window.document.getElementById("recommended-retry")?.hidden,
    starterHiddenAfterFirst,
    maxActiveDownloads,
    maxActiveImports,
  };
  const [legacyDictionary, ...otherDictionaries] = state.dictionaries;
  const legacyIndexOnlyDictionary = { ...legacyDictionary };
  delete legacyIndexOnlyDictionary.sourceId;
  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: [legacyIndexOnlyDictionary, ...otherDictionaries],
  };
  storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  await new Promise((done) => window.setTimeout(done, 0));
  const fetchCountBeforeLegacyRetry = fetches.length;
  window.document.getElementById("retry-recommended")?.click();
  await new Promise((done) => window.setTimeout(done, 10));
  result.legacyIndexOnlySkipped =
    window.document.getElementById("recommended-retry")?.hidden === true
    && fetches.length === fetchCountBeforeLegacyRetry;
  dom.window.close();
  return result;
}

async function settingsManagedUpdatesStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html`,
  });
  const { window } = dom;
  let state = {
    schemaVersion: 1,
    revision: 4,
    dictionaries: [
      genericPackage({
        id: "managed-id",
        title: "Managed terms",
        enabled: false,
        isUpdatable: true,
        indexUrl: "https://example.test/managed/index.json",
        downloadUrl: "https://example.test/managed/archive.zip",
        lastUpdateCheck: {
          checkedAt: "2026-09-04T10:00:00.000Z",
          status: "update-available",
          remoteRevision: "test-2",
          error: null,
        },
      }),
      genericPackage({
        id: "insecure-id",
        title: "Insecure source",
        isUpdatable: true,
        indexUrl: "http://example.test/insecure/index.json",
        downloadUrl: "http://example.test/insecure/archive.zip",
        lastUpdateCheck: {
          checkedAt: "2026-09-04T10:00:00.000Z",
          status: "update-available",
          remoteRevision: "test-2",
          error: null,
        },
      }),
      genericPackage({ id: "local-id", title: "Local terms" }),
    ],
    groups: [],
  };
  let updateSettings = { schedule: "weekly", lastCheckedAt: "2026-09-04T10:00:00.000Z" };
  let storageListener = null;
  const updateRequests = [];

  const publishState = (dictionary) => {
    state = {
      ...state,
      revision: state.revision + 1,
      dictionaries: state.dictionaries.map((entry) => entry.id === dictionary.id ? dictionary : entry),
    };
    storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  };
  window.chrome = {
    runtime: {
      id: "hachidoriupdatessettingssmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: 1 };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_updates_schedule") {
          updateRequests.push(structuredClone(message));
          updateSettings = { ...updateSettings, schedule: message.schedule };
          storageListener?.({
            dictionaryUpdates: { newValue: structuredClone(updateSettings) },
          }, "local");
          return { ok: true, settings: structuredClone(updateSettings) };
        }
        if (message.type === "hd_updates_check") {
          updateRequests.push(structuredClone(message));
          await new Promise((done) => window.setTimeout(done, 0));
          const managed = state.dictionaries.find((entry) => entry.id === "managed-id");
          publishState({
            ...managed,
            lastUpdateCheck: {
              checkedAt: "2026-09-04T11:00:00.000Z",
              status: "update-available",
              remoteRevision: "test-2",
              error: null,
            },
          });
          updateSettings = { ...updateSettings, lastCheckedAt: "2026-09-04T11:00:00.000Z" };
          storageListener?.({
            dictionaryUpdates: { newValue: structuredClone(updateSettings) },
          }, "local");
          return {
            ok: true,
            settings: structuredClone(updateSettings),
            outcomes: [{ id: "managed-id", status: "update-available" }],
          };
        }
        if (message.type === "hd_updates_install") {
          updateRequests.push(structuredClone(message));
          await new Promise((done) => window.setTimeout(done, 0));
          const managed = state.dictionaries.find((entry) => entry.id === "managed-id");
          publishState({
            ...managed,
            revision: "test-2",
            lastUpdateCheck: {
              checkedAt: "2026-09-04T11:05:00.000Z",
              status: "up-to-date",
              remoteRevision: "test-2",
              error: null,
            },
          });
          return {
            ok: true,
            settings: structuredClone(updateSettings),
            outcomes: [{ id: "managed-id", status: "updated" }],
          };
        }
        throw new Error(`unexpected managed-update settings request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
          return {
            options: { kanjiClickDictionary: "" },
            dictionaryUpdates: structuredClone(updateSettings),
          };
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

  const deadline = Date.now() + 2000;
  while (!window.document.getElementById("engine-status")?.textContent?.startsWith("Ready")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const managedRow = () => window.document.querySelector('[data-dictionary-id="managed-id"]');
  const insecureRow = () => window.document.querySelector('[data-dictionary-id="insecure-id"]');
  const localRow = () => window.document.querySelector('[data-dictionary-id="local-id"]');
  const result = {
    initial: {
      schedule: window.document.getElementById("update-schedule")?.value,
      lastChecked: window.document.getElementById("update-last-checked")?.textContent ?? "",
      managedStatus: managedRow()?.querySelector(".dict-update-status")?.textContent ?? "",
      managedUpdateHidden: managedRow()?.querySelector(".dict-update")?.hidden,
      insecureMetadata: insecureRow()?.querySelector(".dict-metadata")?.textContent ?? "",
      insecureStatus: insecureRow()?.querySelector(".dict-update-status")?.textContent ?? "",
      insecureUpdateHidden: insecureRow()?.querySelector(".dict-update")?.hidden,
      localStatus: localRow()?.querySelector(".dict-update-status")?.textContent ?? "",
      localUpdateHidden: localRow()?.querySelector(".dict-update")?.hidden,
    },
  };

  window.document.getElementById("update-check-now")?.click();
  while (!updateRequests.some((request) => request.type === "hd_updates_check")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  while (window.document.getElementById("update-check-now")?.disabled && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  result.checkRequest = updateRequests.find((request) => request.type === "hd_updates_check");
  result.checkedState = window.document.getElementById("update-state")?.textContent ?? "";

  managedRow()?.querySelector(".dict-update")?.click();
  while (updateRequests.filter((request) => request.type === "hd_updates_install").length < 1
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  while (managedRow()?.querySelector(".dict-update-status")?.textContent?.includes("Update available")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  result.oneRequest = updateRequests.find((request) => request.type === "hd_updates_install");
  result.afterOneStatus = managedRow()?.querySelector(".dict-update-status")?.textContent ?? "";

  const managed = state.dictionaries.find((entry) => entry.id === "managed-id");
  publishState({
    ...managed,
    revision: "test-1",
    lastUpdateCheck: {
      checkedAt: "2026-09-04T12:00:00.000Z",
      status: "update-available",
      remoteRevision: "test-2",
      error: null,
    },
  });
  await new Promise((done) => window.setTimeout(done, 0));
  window.document.getElementById("update-all")?.click();
  while (updateRequests.filter((request) => request.type === "hd_updates_install").length < 2
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  while (window.document.getElementById("update-check-now")?.disabled && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  result.allRequest = updateRequests.filter((request) => request.type === "hd_updates_install")[1];

  const schedule = window.document.getElementById("update-schedule");
  if (schedule) {
    schedule.value = "daily";
    schedule.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  while (!updateRequests.some((request) => request.type === "hd_updates_schedule")
      && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  await new Promise((done) => window.setTimeout(done, 0));
  result.scheduleRequest = updateRequests.find((request) => request.type === "hd_updates_schedule");
  dom.window.close();
  return result;
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
    url: `${EXTENSION_ORIGIN}/settings.html`,
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
    dictionaries: [customPackage, genericPackage({ id: "ordinary-id", title: "Ordinary" })],
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
          return { ok: true, ready: true, loading: false, dictionaryCount: 2 };
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
  const open = window.document.getElementById("custom-dictionary-open");
  const form = window.document.getElementById("custom-dictionary-form");
  const source = window.document.getElementById("custom-dictionary-source");
  const save = window.document.getElementById("custom-dictionary-save");
  const reload = window.document.getElementById("custom-dictionary-reload");
  if (!open || !form || !source || !save || !reload) {
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
      sourceFetchedDirectly: storageGetKeys.some((keys) =>
        Array.isArray(keys) && keys.includes("customDictionarySource")),
      sourceHasMaximumLength: source.hasAttribute("maxlength"),
      sourceDescribedBy: source.getAttribute("aria-describedby"),
    },
  };

  open.click();
  await waitFor(() => pendingRead !== null);
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
    expanded: open.getAttribute("aria-expanded"),
    readCount: customReadRequests.length,
    saveDisabled: save.disabled,
  };

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
  window.document.getElementById("dict-select-visible")?.click();
  window.document.getElementById("dict-bulk-disable")?.click();
  await waitFor(() => stateRequests.length === 1
    && window.document.getElementById("dict-bulk-favorite")?.disabled === false);
  result.bulkState = stateRequests[0]?.dictionaries?.map(({ id, enabled }) => ({ id, enabled }));
  window.document.getElementById("dict-bulk-favorite")?.click();
  await waitFor(() => stateRequests.length === 2);
  result.favoriteState = stateRequests[1]?.dictionaries?.map(({ id, favorite }) => ({ id, favorite }));

  source.focus();
  source.value = "draft, どらふと, keep me\n";
  source.dispatchEvent(new window.Event("input", { bubbles: true }));
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

async function settingsConflictStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html`,
  });
  const { window } = dom;
  let state = {
    schemaVersion: 1,
    revision: 7,
    dictionaries: [genericPackage()],
    groups: [],
  };
  let storageListener = null;
  const casRequests = [];
  let rejectNextApply = true;
  let holdNextApply = false;
  let releaseHeldApply = null;
  let directDictionaryWrites = 0;
  let removeStarted = false;
  let releaseRemove = null;
  const acceptState = (nextDictionaries, nextGroups = state.groups) => {
    state = {
      schemaVersion: 1,
      revision: state.revision + 1,
      dictionaries: structuredClone(nextDictionaries),
      groups: structuredClone(nextGroups),
    };
    storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
    return { ok: true, state: structuredClone(state) };
  };
  window.chrome = {
    runtime: {
      id: "hachidorisettingssmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_state_cas") {
          casRequests.push({
            type: message.type,
            baseRevision: message.baseRevision,
            dictionaries: structuredClone(message.dictionaries),
            groups: message.groups === undefined ? undefined : structuredClone(message.groups),
          });
          return acceptState(message.dictionaries, message.groups);
        }
        if (message.type === "hd_apply_state") {
          casRequests.push({
            type: message.type,
            baseRevision: message.baseRevision,
            dictionaries: structuredClone(message.dictionaries),
            groups: message.groups === undefined ? undefined : structuredClone(message.groups),
          });
          if (!rejectNextApply) {
            if (!holdNextApply) {
              return acceptState(message.dictionaries);
            }
            holdNextApply = false;
            return new Promise((resolveApply) => {
              releaseHeldApply = () => {
                releaseHeldApply = null;
                resolveApply(acceptState(message.dictionaries));
              };
            });
          }
          rejectNextApply = false;
          state = {
            schemaVersion: 1,
            revision: state.revision + 1,
            dictionaries: [{
              ...state.dictionaries[0],
              displayName: "Concurrent final",
              enabled: true,
              favorite: true,
            }],
            groups: structuredClone(state.groups),
          };
          storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
          return {
            ok: false,
            conflict: true,
            error: "simulated change from another settings page",
            state: structuredClone(state),
          };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_remove") {
          removeStarted = true;
          return new Promise((resolveRemove) => {
            releaseRemove = () => resolveRemove({ ok: false, error: "simulated held removal" });
          });
        }
        throw new Error(`unexpected settings request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
          return { options: { kanjiClickDictionary: "" } };
        },
        async set(values) {
          if (values.dictionaryState !== undefined || values.dictionaries !== undefined) {
            directDictionaryWrites += 1;
          }
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

  const deadline = Date.now() + 2000;
  let displayName = null;
  while (Date.now() < deadline) {
    displayName = window.document.querySelector("#dict-list .dict-display-name");
    if (displayName) break;
    await new Promise((done) => window.setTimeout(done, 5));
  }
  if (!displayName) {
    dom.window.close();
    return { error: "the settings dictionary row did not render" };
  }

  displayName.focus();
  displayName.value = "My draft";
  state = {
    ...state,
    revision: 8,
    dictionaries: [{
      ...state.dictionaries[0],
      displayName: "Other writer",
      favorite: true,
    }],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  const draftSurvived = displayName.isConnected
    && window.document.activeElement === displayName
    && displayName.value === "My draft";

  displayName.dispatchEvent(new window.Event("change", { bubbles: true }));
  const checkbox = window.document.querySelector("#dict-list .dict-enabled");
  const secondActionTargetSurvived = checkbox?.isConnected === true && checkbox.disabled === false;
  checkbox?.focus();
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
  const selectedValue = JSON.stringify({ title: "Generic", kind: "term" });
  while (casRequests.length < 2 && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  await new Promise((done) => window.setTimeout(done, 0));
  const conflictStatus = window.document.getElementById("engine-status")?.textContent ?? "";
  const checkboxFocused = window.document.activeElement?.classList.contains("dict-enabled") === true;

  window.confirm = () => true;
  window.document.querySelector("#dict-list .dict-remove")?.click();
  while (!removeStarted && Date.now() < deadline) {
    await new Promise((done) => window.setTimeout(done, 5));
  }
  const removalControlsBlocked = [...window.document.querySelectorAll("#dict-list input, #dict-list button")]
    .every((control) => control.disabled)
    && [...window.document.querySelectorAll("#dict-list .dict-drag")]
      .every((drag) => drag.draggable === false);
  releaseRemove?.();
  await new Promise((done) => window.setTimeout(done, 0));
  const removalControlsRestored = [...window.document.querySelectorAll("#dict-list input, #dict-list button")]
    .some((control) => !control.disabled)
    && [...window.document.querySelectorAll("#dict-list .dict-drag")]
      .every((drag) => drag.draggable === true);

  const result = {
    draftSurvived,
    secondActionTargetSurvived,
    casRequests: structuredClone(casRequests),
    directDictionaryWrites,
    enabled: window.document.querySelector("#dict-list .dict-enabled")?.checked,
    kanjiChoice: [...window.document.querySelectorAll("#opt-kanji-dictionary option")]
      .some((option) => option.value === selectedValue),
    title: window.document.querySelector("#dict-list .dict-title")?.textContent,
    canonical: window.document.querySelector("#dict-list .dict-canonical")?.textContent,
    favorite: window.document.querySelector("#dict-list .dict-favorite")?.hidden === false,
    checkboxFocused,
    conflictStatus,
    removalControlsBlocked,
    removalControlsRestored,
  };

  casRequests.length = 0;
  const ids = {
    alpha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    beta: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    gamma: "cccccccccccccccccccccccccccccccc",
    hiddenOne: "11111111111111111111111111111111",
    hiddenTwo: "22222222222222222222222222222222",
  };
  const managementDictionaries = [
    genericPackage({ id: ids.alpha, title: "ＡＬＰＨＡ", path: "/dicts/ＡＬＰＨＡ" }),
    genericPackage({ id: ids.hiddenOne, title: "Hidden one", path: "/dicts/Hidden one" }),
    genericPackage({
      id: ids.beta,
      title: "Beta",
      displayName: "Alpha alias",
      path: "/dicts/Beta",
    }),
    genericPackage({ id: ids.hiddenTwo, title: "Hidden two", path: "/dicts/Hidden two" }),
    genericPackage({
      id: ids.gamma,
      title: "Gamma",
      displayName: "Ａｌｐｈａ notes",
      path: "/dicts/Gamma",
    }),
  ];
  state = {
    schemaVersion: 1,
    revision: state.revision + 1,
    dictionaries: managementDictionaries,
    groups: [],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  await new Promise((done) => window.setTimeout(done, 0));

  const search = window.document.getElementById("dict-search");
  const selectAll = window.document.getElementById("dict-select-visible");
  const bulkButtonIds = [
    "dict-bulk-disable",
    "dict-bulk-enable",
    "dict-bulk-favorite",
    "dict-bulk-unfavorite",
  ];
  if (!(search instanceof window.HTMLInputElement)
      || !(selectAll instanceof window.HTMLInputElement)
      || bulkButtonIds.some((id) => !(window.document.getElementById(id) instanceof window.HTMLButtonElement))) {
    result.management = { error: "dictionary management controls did not render" };
    dom.window.close();
    return result;
  }

  const rowIds = () => [...window.document.querySelectorAll("#dict-list .dict-row")]
    .map((row) => row.dataset.dictionaryId);
  const selectedRowIds = () => [...window.document.querySelectorAll("#dict-list .dict-row")]
    .filter((row) => row.querySelector(".dict-selected")?.checked)
    .map((row) => row.dataset.dictionaryId);
  const rowFor = (id) => [...window.document.querySelectorAll("#dict-list .dict-row")]
    .find((row) => row.dataset.dictionaryId === id);
  const waitForRequestCount = async (count) => {
    const requestDeadline = Date.now() + 2000;
    while (casRequests.length < count && Date.now() < requestDeadline) {
      await new Promise((done) => window.setTimeout(done, 5));
    }
    await new Promise((done) => window.setTimeout(done, 0));
  };

  const localeLowerCase = window.String.prototype.toLocaleLowerCase;
  window.String.prototype.toLocaleLowerCase = function toTurkishLowerCase() {
    return localeLowerCase.call(this, "tr");
  };
  search.value = "HIDDEN O";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const localeIndependentVisibleIds = rowIds();
  window.String.prototype.toLocaleLowerCase = localeLowerCase;

  search.value = " ＡｌＰｈＡ ";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const visibleIds = rowIds();
  selectAll.click();
  const selectedVisibleIds = selectedRowIds();

  for (const [index, buttonId] of bulkButtonIds.entries()) {
    window.document.getElementById(buttonId).click();
    await waitForRequestCount(index + 1);
  }
  const bulkRequests = structuredClone(casRequests);
  const selectedIds = [ids.alpha, ids.beta, ids.gamma];
  const bulkValues = bulkRequests.flatMap((request, index) => selectedIds.map((id) => {
    const dictionary = request.dictionaries.find((entry) => entry.id === id);
    return index < 2 ? dictionary.enabled : dictionary.favorite;
  }));
  const bulkHiddenUntouched = bulkRequests.every((request) =>
    [ids.hiddenOne, ids.hiddenTwo].every((id) => {
      const dictionary = request.dictionaries.find((entry) => entry.id === id);
      return dictionary.enabled === true && dictionary.favorite === false;
    }));

  holdNextApply = true;
  const queuedUp = rowFor(ids.gamma).querySelector(".dict-up");
  queuedUp.click();
  await waitForRequestCount(5);
  queuedUp.click();
  releaseHeldApply?.();
  await waitForRequestCount(6);
  const queuedOrderTitles = casRequests.slice(4).map((request) =>
    request.dictionaries.map((dictionary) => dictionary.displayName || dictionary.title));

  state = {
    schemaVersion: 1,
    revision: state.revision + 1,
    dictionaries: structuredClone(managementDictionaries),
    groups: [],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  casRequests.splice(4);

  rowFor(ids.beta).querySelector(".dict-up").click();
  await waitForRequestCount(5);

  const position = rowFor(ids.gamma).querySelector(".dict-position-input");
  position.value = "1";
  position.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  await waitForRequestCount(6);

  const dragStart = new window.Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(dragStart, "dataTransfer", {
    value: { effectAllowed: "", setData() {} },
  });
  rowFor(ids.alpha).querySelector(".dict-drag").dispatchEvent(dragStart);
  rowFor(ids.beta).dispatchEvent(new window.Event("dragover", { bubbles: true, cancelable: true }));
  rowFor(ids.beta).dispatchEvent(new window.Event("drop", { bubbles: true, cancelable: true }));
  await waitForRequestCount(7);

  rowFor(ids.gamma).querySelector(".dict-down").click();
  await waitForRequestCount(8);

  const orderRequests = casRequests.slice(4);
  const orderTitles = orderRequests.map((request) =>
    request.dictionaries.map((dictionary) => dictionary.displayName || dictionary.title));
  const hiddenOrderPreserved = orderRequests.every((request) =>
    request.dictionaries.findIndex((dictionary) => dictionary.id === ids.hiddenOne)
      < request.dictionaries.findIndex((dictionary) => dictionary.id === ids.hiddenTwo));
  const searchAfterOperations = search.value;
  const selectedAfterOperations = selectedRowIds().sort();

  const removedBeta = state.dictionaries.find((dictionary) => dictionary.id === ids.beta);
  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: state.dictionaries.filter((dictionary) => dictionary.id !== ids.beta),
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: [...state.dictionaries.slice(0, 2), removedBeta, ...state.dictionaries.slice(2)],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");

  result.management = {
    localeIndependentVisibleIds,
    visibleIds,
    selectedVisibleIds,
    bulkRequests,
    bulkValues,
    bulkHiddenUntouched,
    queuedOrderTitles,
    orderRequests,
    orderTitles,
    hiddenOrderPreserved,
    searchAfterOperations,
    selectedAfterOperations,
    selectedAfterExternalChange: selectedRowIds(),
    visibleAfterExternalChange: rowIds(),
  };

  casRequests.length = 0;
  const newGroupName = window.document.getElementById("dict-group-name-new");
  const createGroup = window.document.getElementById("dict-group-create");
  const groupError = window.document.getElementById("dict-group-error");
  if (!(newGroupName instanceof window.HTMLInputElement)
      || !(createGroup instanceof window.HTMLButtonElement)
      || !(groupError instanceof window.HTMLElement)) {
    result.groups = { error: "dictionary group controls did not render" };
    result.directDictionaryWrites = directDictionaryWrites;
    dom.window.close();
    return result;
  }

  const groupRow = (id) => [...window.document.querySelectorAll("#dict-group-list .dict-group")]
    .find((row) => row.dataset.groupId === id);
  const groupMemberRow = (groupId, dictionaryId) => [...groupRow(groupId)
    ?.querySelectorAll(".dict-group-member") ?? []]
    .find((row) => row.dataset.dictionaryId === dictionaryId);
  const addGroupMember = async (groupId, dictionaryId, requestCount) => {
    const row = groupRow(groupId);
    const select = row?.querySelector(".dict-group-add-select");
    select.value = dictionaryId;
    row.querySelector(".dict-group-add").click();
    await waitForRequestCount(requestCount);
  };

  window.String.prototype.toLocaleLowerCase = function toTurkishLowerCase() {
    return localeLowerCase.call(this, "tr");
  };
  newGroupName.value = "  ＩＮＤＩＧＯ\t  Deck ";
  createGroup.click();
  await waitForRequestCount(1);
  const studyGroupId = state.groups[0]?.id;
  const normalisedGroupName = state.groups[0]?.name;

  newGroupName.value = "indigo deck";
  createGroup.click();
  await new Promise((done) => window.setTimeout(done, 0));
  const duplicateError = groupError.textContent;
  const requestsAfterDuplicate = casRequests.length;
  window.String.prototype.toLocaleLowerCase = localeLowerCase;

  newGroupName.value = " Ａｌｌ ";
  createGroup.click();
  await new Promise((done) => window.setTimeout(done, 0));
  const reservedError = groupError.textContent;
  const requestsAfterReserved = casRequests.length;

  newGroupName.value = "Grammar";
  createGroup.click();
  await waitForRequestCount(2);
  const grammarGroupId = state.groups.find((group) => group.name === "Grammar")?.id;
  const grammarUp = groupRow(grammarGroupId).querySelector(".dict-group-up");
  grammarUp.focus();
  grammarUp.click();
  await waitForRequestCount(3);
  const groupOrderAfterMove = state.groups.map((group) => group.name);
  const groupMoveFocusRetained = window.document.activeElement?.classList.contains("dict-group-down") === true
    && window.document.activeElement.closest(".dict-group")?.dataset.groupId === grammarGroupId;

  const studyName = groupRow(studyGroupId).querySelector(".dict-group-name");
  studyName.focus();
  studyName.value = "Reading";
  studyName.dispatchEvent(new window.Event("change", { bubbles: true }));
  search.focus();
  await waitForRequestCount(4);
  const externalFocusPreserved = window.document.activeElement === search;

  const studyAdd = groupRow(studyGroupId).querySelector(".dict-group-add");
  studyAdd.focus();
  await addGroupMember(studyGroupId, ids.beta, 5);
  const groupAddFocusRetained = window.document.activeElement?.classList.contains("dict-group-add") === true
    && window.document.activeElement.closest(".dict-group")?.dataset.groupId === studyGroupId;
  await addGroupMember(studyGroupId, ids.alpha, 6);
  const membershipBeforeMove = state.groups.find((group) => group.id === studyGroupId)?.dictionaryIds;
  const alphaUp = groupMemberRow(studyGroupId, ids.alpha).querySelector(".dict-group-member-up");
  alphaUp.focus();
  alphaUp.click();
  await waitForRequestCount(7);
  const membershipAfterMove = state.groups.find((group) => group.id === studyGroupId)?.dictionaryIds;
  const memberMoveFocusRetained = window.document.activeElement?.classList.contains("dict-group-member-down") === true
    && window.document.activeElement.closest(".dict-group-member")?.dataset.dictionaryId === ids.alpha;

  state = {
    ...state,
    revision: state.revision + 1,
    dictionaries: state.dictionaries.map((dictionary) => dictionary.id === ids.beta
      ? { ...dictionary, displayName: "Renamed after grouping" }
      : dictionary),
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  await new Promise((done) => window.setTimeout(done, 0));
  const membershipAfterAlias = state.groups.find((group) => group.id === studyGroupId)?.dictionaryIds;
  const renamedMemberLabel = groupMemberRow(studyGroupId, ids.beta)
    ?.querySelector(".dict-group-member-name")?.textContent;

  const betaRemove = groupMemberRow(studyGroupId, ids.beta).querySelector(".dict-group-member-remove");
  betaRemove.focus();
  betaRemove.click();
  await waitForRequestCount(8);
  const memberRemoveFocusRetained = window.document.activeElement?.classList.contains("dict-group-member-remove") === true
    && window.document.activeElement.closest(".dict-group-member")?.dataset.dictionaryId === ids.alpha;
  groupRow(grammarGroupId).querySelector(".dict-group-delete").click();
  await waitForRequestCount(9);

  const finalGroups = structuredClone(state.groups);
  const requestTypes = casRequests.map((request) => request.type);
  const dictionarySnapshots = casRequests.map((request) =>
    request.dictionaries.map((dictionary) => dictionary.id));

  casRequests.length = 0;
  newGroupName.value = "Queued group";
  createGroup.click();
  newGroupName.value = " queued\tgroup ";
  createGroup.click();
  await waitForRequestCount(1);
  const queuedCreateNames = state.groups
    .filter((group) => group.name.toLowerCase() === "queued group")
    .map((group) => group.name);
  const queuedCreateError = groupError.textContent;
  const queuedCreateRequestCount = casRequests.length;

  state = {
    ...state,
    revision: state.revision + 1,
    groups: [
      { id: "rename-one", name: "Rename one", dictionaryIds: [] },
      { id: "rename-two", name: "Rename two", dictionaryIds: [] },
    ],
  };
  storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  casRequests.length = 0;

  const firstRename = groupRow("rename-one").querySelector(".dict-group-name");
  const secondRename = groupRow("rename-two").querySelector(".dict-group-name");
  firstRename.value = "Shared name";
  firstRename.dispatchEvent(new window.Event("change", { bubbles: true }));
  secondRename.value = " shared\tname ";
  secondRename.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitForRequestCount(1);
  const queuedRenameNames = state.groups.map((group) => group.name);
  const queuedRenameError = groupError.textContent;
  const queuedRenameRequestCount = casRequests.length;

  result.groups = {
    normalisedGroupName,
    duplicateError,
    reservedError,
    requestsAfterDuplicate,
    requestsAfterReserved,
    groupOrderAfterMove,
    groupMoveFocusRetained,
    externalFocusPreserved,
    groupAddFocusRetained,
    membershipBeforeMove,
    membershipAfterMove,
    memberMoveFocusRetained,
    memberRemoveFocusRetained,
    membershipAfterAlias,
    renamedMemberLabel,
    finalGroups,
    requestTypes,
    dictionarySnapshots,
    queuedCreateNames,
    queuedCreateError,
    queuedCreateRequestCount,
    queuedRenameNames,
    queuedRenameError,
    queuedRenameRequestCount,
  };
  result.directDictionaryWrites = directDictionaryWrites;
  dom.window.close();
  return result;
}

async function staleKanjiResponseStage(invalidation) {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM("<!doctype html><body><span id=anchor>食</span></body>", {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://example.test/",
  });
  const { window } = dom;
  let storageListener = null;
  let initialStorageCallback = null;
  let pending = null;
  const firstSelection = { title: "Generic", kind: "term" };
  const dictionaryState = {
    schemaVersion: 1,
    revision: 1,
    dictionaries: [genericPackage()],
  };
  window.chrome = {
    runtime: {
      id: "hachidoricontentsmoke",
      lastError: null,
      getURL: (path) => `chrome-extension://hachidoricontentsmoke/${path}`,
      sendMessage(request, callback) {
        pending = { callback, request };
      },
    },
    storage: {
      local: {
        get(defaults, callback) {
          const stored = {
            ...defaults,
            dictionaryState,
            options: { ...defaults.options, kanjiClickDictionary: firstSelection },
          };
          if (invalidation === "initial-storage") {
            initialStorageCallback = () => callback(stored);
          } else {
            callback(stored);
          }
        },
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        },
        removeListener() {},
      },
    },
  };
  const marker = "  start();\n}());";
  const source = readFileSync(resolve(EXTENSION, "content.js"), "utf8");
  const instrumented = source.replace(marker, `
  globalThis.__hachidoriContentSmoke = {
    setState(candidate, nextPopup, nextView, nextHighlighter) {
      activeCandidate = candidate;
      activeHighlightText = "";
      activeTermRender = { candidate, matchedText: "食べる", renderOptions: {}, results: [] };
      currentGeneration = 0;
      styleGeneration = 0;
      popup = nextPopup;
      view = nextView;
      highlighter = nextHighlighter;
    },
    restore() {
      restoreTermRender(activeTermRender, { character: "食", index: 0 });
    },
    showKanji,
  };
  start();
}());`);
  if (instrumented === source) {
    return ["content.js instrumentation marker was not found"];
  }
  window.eval(instrumented);
  const anchor = window.document.getElementById("anchor");
  const popup = window.document.createElement("div");
  popup.hidden = false;
  window.document.body.appendChild(popup);
  const renders = [];
  window.__hachidoriContentSmoke.setState(
    {
      anchor,
      matchOffset: 0,
      scanEntries: [{ node: anchor.firstChild, offset: 0, sourceLength: 1, text: "食" }],
      vertical: false,
    },
    popup,
    {
      clear() {},
      renderKanji(value) { renders.push(value); },
      renderResults(value) { renders.push(value); },
      setToolbarPosition() {},
    },
    { apply() {}, clearAll() {} },
  );
  const lookup = window.__hachidoriContentSmoke.showKanji("食");
  if (invalidation === "storage-change") {
    storageListener({
      options: {
        newValue: { revision: 1, kanjiClickDictionary: { title: "Other", kind: "term" } },
      },
    }, "local");
  } else if (invalidation === "group-storage-change") {
    storageListener({
      dictionaryState: {
        newValue: {
          ...dictionaryState,
          revision: dictionaryState.revision + 1,
          groups: [{ id: "study", name: "Study", dictionaryIds: [] }],
        },
      },
    }, "local");
  } else if (invalidation === "back") {
    window.__hachidoriContentSmoke.restore();
  } else {
    initialStorageCallback();
  }
  const reply = pending.request.type === "hd_kanji"
    ? {
        generation: 0,
        kanji: { character: "食", entries: [{ dictionary: "Native" }] },
        ok: true,
        requestId: pending.request.requestId,
        type: "hd_kanji_result",
      }
    : {
        generation: 0,
        ok: true,
        requestId: pending.request.requestId,
        results: [{ term: { expression: "食", glossaries: [{ dictionary: "Generic" }] } }],
        type: "hd_lookup_dictionary_result",
      };
  pending.callback(reply);
  await lookup;
  const result = { renders, popupHidden: popup.hidden };
  dom.window.close();
  return result;
}

async function contentNoteStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const settle = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  async function createHarness(kanjiClickDictionary = { title: "Generic", kind: "term" }) {
    const dom = new JSDOM(
      "<!doctype html><body><span id=anchor>\u98df\u3079\u305f</span></body>",
      {
        pretendToBeVisual: true,
        runScripts: "outside-only",
        url: "https://example.test/",
      },
    );
    const { window } = dom;
    let storageListener = null;
    let popupCallbacks = null;
    let editing = false;
    let closeNext = false;
    let closeCalls = 0;
    let clearCount = 0;
    const pending = [];
    const sent = [];
    const renders = [];

    function stopEditing() {
      if (!editing || typeof popupCallbacks?.onNoteEditingChange !== "function") return;
      editing = false;
      popupCallbacks.onNoteEditingChange(false);
    }

    const view = {
      clear() {
        clearCount += 1;
        stopEditing();
      },
      closeNoteForm() {
        closeCalls += 1;
        if (!closeNext) return false;
        closeNext = false;
        stopEditing();
        return true;
      },
      destroy() {},
      renderKanji(value, candidate, context) {
        stopEditing();
        renders.push({ kind: "kanji", value, candidate, context });
      },
      renderNotice(value, candidate) {
        stopEditing();
        renders.push({ kind: "notice", value, candidate, context: {} });
      },
      renderResults(results, candidate, context) {
        stopEditing();
        renders.push({ kind: "terms", results, candidate, context });
      },
      setToolbarPosition() {},
    };
    window.HDGlossary = {
      appendExpressionRuby() {},
      appendTextOnlyGlossary() {},
      applyDictionaryStyles() { return []; },
      parseTagList() { return []; },
    };
    window.HDPopup = {
      createPopupView(options) {
        popupCallbacks = options;
        return view;
      },
      createSourceHighlighter() {
        return { apply() {}, clearAll() {} };
      },
    };
    const initialState = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [genericPackage({
        favorite: true,
        kanjiCount: kanjiClickDictionary?.kind === "kanji" ? 1 : 0,
      })],
    };
    window.chrome = {
      runtime: {
        id: "hachidoricontnotesmoke",
        lastError: null,
        getURL: (path) => `chrome-extension://hachidoricontnotesmoke/${path}`,
        sendMessage(request, callback) {
          sent.push(JSON.parse(JSON.stringify(request)));
          if (request.type === "hd_styles") {
            callback({
              generation: 2,
              ok: true,
              requestId: request.requestId,
              styles: [],
              type: "hd_styles_result",
            });
            return;
          }
          pending.push({ callback, request });
        },
      },
      storage: {
        local: {
          get(defaults, callback) {
            callback({
              ...defaults,
              dictionaryState: initialState,
              options: {
                frequencyDictionary: "Frequency A",
                frequencyOrder: "descending",
                hoverDelayMs: 0,
                kanjiClickDictionary,
                maxResults: 7,
                modifier: "none",
                scanLength: 9,
              },
            });
          },
        },
        onChanged: {
          addListener(listener) { storageListener = listener; },
          removeListener() {},
        },
      },
    };
    const marker = "  start();\n}());";
    const source = readFileSync(resolve(EXTENSION, "content.js"), "utf8");
    const instrumented = source.replace(marker, `
  globalThis.__hachidoriContentNoteSmoke = {
    install() {
      buildUi({ sheet: null, text: "" });
      uiPromise = Promise.resolve();
      currentGeneration = 1;
      styleGeneration = 1;
      return popup;
    },
    hideTimerPending() { return hideTimer !== null; },
    onInternalLink,
    onKeyDown,
    runLookup,
    scanPointer,
    scheduleHide,
    showKanji,
    snapshot() {
      return {
        dictionaryStateRevision,
        dictionaries: dictionaries.map((dictionary) => ({ ...dictionary })),
        popupHidden: popup?.hidden === true,
      };
    },
  };
  start();
}());`);
    if (instrumented === source) {
      dom.window.close();
      throw new Error("content.js Note instrumentation marker was not found");
    }
    window.eval(instrumented);
    const driver = window.__hachidoriContentNoteSmoke;
    const popup = driver.install();
    const anchor = window.document.getElementById("anchor");
    const candidate = {
      anchor,
      matchOffset: 0,
      query: "\u98df\u3079\u305f",
      scanEntries: [{
        node: anchor.firstChild,
        offset: 0,
        sourceLength: 3,
        text: "\u98df\u3079\u305f",
      }],
      sentence: "\u98df\u3079\u305f",
      sourceElements: [anchor],
      vertical: false,
    };

    function take(type) {
      const index = pending.findIndex(({ request }) => request.type === type);
      return index < 0 ? null : pending.splice(index, 1)[0];
    }

    function reply(item, payload = {}, ok = true) {
      if (item === null) throw new Error("the expected content request was not queued");
      item.callback({
        generation: 2,
        ok,
        requestId: item.request.requestId,
        type: `${item.request.type}_result`,
        ...payload,
      });
    }

    function term(expression, dictionary = "Generic") {
      return {
        matched: expression,
        term: {
          expression,
          reading: "\u3088\u307f",
          glossaries: [{ dictionary, glossary: "definition" }],
        },
      };
    }

    function state(revision, displayName) {
      return {
        schemaVersion: 1,
        revision,
        dictionaries: [
          genericPackage({
            displayName,
            favorite: true,
            kanjiCount: kanjiClickDictionary?.kind === "kanji" ? 1 : 0,
          }),
          genericPackage({
            id: CUSTOM_DICTIONARY_ID,
            title: CUSTOM_DICTIONARY_TITLE,
            displayName: null,
            path: `/dicts/custom-${revision}/${CUSTOM_DICTIONARY_TITLE}`,
            revision: `custom-${revision}`,
          }),
        ],
      };
    }

    function emitState(value) {
      storageListener?.({ dictionaryState: { newValue: value } }, "local");
    }

    let emittedOptionsRevision = 0;
    function emitOptions(value) {
      emittedOptionsRevision += 1;
      storageListener?.({ options: { newValue: { revision: emittedOptionsRevision, ...value } } }, "local");
    }

    function requestPayload(request) {
      const { requestId, target, ...payload } = request;
      return payload;
    }

    async function initialLookup() {
      const operation = driver.runLookup(candidate);
      const request = take("hd_lookup");
      reply(request, { dictionaryCount: 1, results: [term(candidate.query)] });
      await operation;
      return request;
    }

    return {
      anchor,
      candidate,
      callbacks: () => popupCallbacks,
      close() { dom.window.close(); },
      driver,
      edit(value) {
        editing = value === true;
        popupCallbacks.onNoteEditingChange(editing);
      },
      emitOptions,
      emitState,
      initialLookup,
      pending,
      popup,
      render: () => renders.at(-1),
      renders,
      reply,
      requestPayload,
      sent,
      settle,
      state,
      stats() { return { clearCount, closeCalls }; },
      take,
      term,
      setCloseNext(value) { closeNext = value === true; },
    };
  }

  const probe = await createHarness();
  const callbacksWired = typeof probe.callbacks()?.onAddCustomEntry === "function"
    && typeof probe.callbacks()?.onNoteEditingChange === "function";
  probe.emitOptions({ revision: 4, maxResults: 50 });
  probe.emitOptions({ revision: 2, maxResults: 2 });
  probe.emitOptions({ revision: 4, maxResults: 3 });
  const newestOnlyOptions = (await probe.initialLookup()).request.maxResults === 50;
  probe.close();
  if (!callbacksWired) return { callbacksWired };

  async function eventFirstCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    const internal = harness.driver.onInternalLink({
      primaryReading: "\u306a\u3044\u3076\u3054",
      query: "\u5185\u90e8\u8a9e",
    });
    const linked = harness.take("hd_lookup");
    harness.reply(linked, {
      dictionaryCount: 2,
      results: [
        harness.term("\u5185\u90e8\u8a9e"),
        harness.term("\u5185\u90e8\u8a9e", "Projected"),
      ],
    });
    await (internal || harness.settle());
    harness.render().context.onDictionaryTabSelected({ dictionary: "Projected" });
    harness.edit(true);
    harness.emitOptions({
      frequencyDictionary: "Different",
      frequencyOrder: "ascending",
      hoverDelayMs: 0,
      kanjiClickDictionary: "",
      maxResults: 2,
      modifier: "none",
      scanLength: 2,
    });
    const append = harness.callbacks().onAddCustomEntry({
      definition: "inside",
      reading: "\u306a\u3044\u3076\u3054",
      term: "\u5185\u90e8\u8a9e",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.emitState(harness.state(3, "event-newer"));
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "reply-older"),
    });
    await harness.settle();
    const refresh = harness.take("hd_lookup");
    const request = harness.requestPayload(refresh.request);
    harness.reply(refresh, {
      dictionaryCount: 2,
      results: [harness.term("\u5185\u90e8\u8a9e", "Projected")],
    });
    await append;
    const snapshot = harness.driver.snapshot();
    const result = {
      displayName: snapshot.dictionaries[0]?.displayName,
      popupHidden: snapshot.popupHidden,
      request,
      selectedDictionaryTab: harness.render().context.selectedDictionaryTab,
      stateRevision: snapshot.dictionaryStateRevision,
    };
    harness.close();
    return result;
  }

  async function replyFirstCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "ate",
      reading: "\u305f\u3079\u305f",
      term: "\u98df\u3079\u305f",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.reply(appendRequest, {
      document: { revision: 4, semanticRevision: "four", text: "" },
      state: harness.state(4, "reply-newer"),
    });
    await harness.settle();
    harness.emitState(harness.state(3, "event-older"));
    const refresh = harness.take("hd_lookup");
    const request = harness.requestPayload(refresh.request);
    harness.reply(refresh, { dictionaryCount: 1, results: [harness.term("\u98df\u3079\u305f")] });
    await append;
    const snapshot = harness.driver.snapshot();
    const result = {
      displayName: snapshot.dictionaries[0]?.displayName,
      request,
      stateRevision: snapshot.dictionaryStateRevision,
    };
    harness.close();
    return result;
  }

  async function termKanjiCase(replaceBeforeReply = false) {
    const harness = await createHarness();
    await harness.initialLookup();
    const clicked = harness.callbacks().onKanjiClick("\u98df", null, null, null);
    const selected = harness.take("hd_lookup_dictionary");
    harness.reply(selected, {
      dictionaryCount: 1,
      results: [harness.term("clicked")],
    });
    await clicked;
    const clickedRender = harness.render();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "food",
      reading: "\u3057\u3087\u304f",
      term: "\u98df",
    });
    const appendRequest = harness.take("hd_custom_append");
    if (replaceBeforeReply) clickedRender.context.onBack();
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "after-note"),
    });
    await harness.settle();
    const refresh = harness.take("hd_lookup_dictionary");
    let request = null;
    if (refresh !== null) {
      request = harness.requestPayload(refresh.request);
      harness.reply(refresh, {
        dictionaryCount: 1,
        results: [harness.term("clicked refreshed")],
      });
    }
    await append;
    const refreshed = harness.render();
    let backExpression = refreshed.results?.[0]?.term?.expression ?? "";
    const hasBack = typeof refreshed.context?.onBack === "function";
    if (!replaceBeforeReply && hasBack) {
      refreshed.context.onBack();
      backExpression = harness.render().results?.[0]?.term?.expression ?? "";
    }
    const result = {
      backExpression,
      hasBack,
      popupHidden: harness.driver.snapshot().popupHidden,
      refreshCount: refresh === null ? 0 : 1,
      request,
    };
    harness.close();
    return result;
  }

  async function kanjiCase() {
    const harness = await createHarness({ title: "Generic", kind: "kanji" });
    await harness.initialLookup();
    const clicked = harness.callbacks().onKanjiClick("\u98df", null, null, null);
    const selected = harness.take("hd_kanji");
    harness.reply(selected, {
      kanji: {
        character: "\u98df",
        entries: [{ dictionary: "Generic" }, { dictionary: "Other" }],
      },
    });
    await clicked;
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "food",
      reading: "\u3057\u3087\u304f",
      term: "\u98df",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "after-note"),
    });
    await harness.settle();
    const refresh = harness.take("hd_kanji");
    const request = harness.requestPayload(refresh.request);
    harness.reply(refresh, {
      kanji: {
        character: "\u98df",
        entries: [{ dictionary: "Generic" }, { dictionary: "Other" }],
      },
    });
    await append;
    const result = {
      hasBack: typeof harness.render().context?.onBack === "function",
      renderedDictionaries: harness.render().value.entries.map(({ dictionary }) => dictionary),
      request,
    };
    harness.close();
    return result;
  }

  async function refreshFailureCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "ate",
      reading: "\u305f\u3079\u305f",
      term: "\u98df\u3079\u305f",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "after-note"),
    });
    await harness.settle();
    const refresh = harness.take("hd_lookup");
    harness.reply(refresh, { error: "injected refresh failure" }, false);
    let resolved = true;
    try {
      await append;
    } catch {
      resolved = false;
    }
    const result = {
      appendCount: harness.sent.filter(({ type }) => type === "hd_custom_append").length,
      refreshCount: refresh === null ? 0 : 1,
      resolved,
    };
    harness.close();
    return result;
  }

  async function detachedCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "ate",
      reading: "\u305f\u3079\u305f",
      term: "\u98df\u3079\u305f",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.anchor.remove();
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "after-note"),
    });
    await harness.settle();
    const refresh = harness.take("hd_lookup");
    let resolved = true;
    try {
      await append;
    } catch {
      resolved = false;
    }
    const result = { refreshCount: refresh === null ? 0 : 1, resolved };
    harness.close();
    return result;
  }

  async function detachedDuringRefreshCase() {
    async function run(kind) {
      const nativeKanji = kind === "kanji";
      const harness = await createHarness(nativeKanji
        ? { title: "Generic", kind: "kanji" }
        : undefined);
      await harness.initialLookup();
      if (nativeKanji) {
        const clicked = harness.callbacks().onKanjiClick("\u98df", null, null, null);
        const selected = harness.take("hd_kanji");
        harness.reply(selected, {
          kanji: {
            character: "\u98df",
            entries: [{ dictionary: "Generic" }],
          },
        });
        await clicked;
      }
      harness.edit(true);
      const append = harness.callbacks().onAddCustomEntry({
        definition: nativeKanji ? "food" : "ate",
        reading: nativeKanji ? "\u3057\u3087\u304f" : "\u305f\u3079\u305f",
        term: nativeKanji ? "\u98df" : "\u98df\u3079\u305f",
      });
      const appendRequest = harness.take("hd_custom_append");
      harness.reply(appendRequest, {
        document: { revision: 2, semanticRevision: "two", text: "" },
        state: harness.state(2, "after-note"),
      });
      await harness.settle();
      const refresh = harness.take(nativeKanji ? "hd_kanji" : "hd_lookup");
      const renderCount = harness.renders.length;
      harness.anchor.remove();
      harness.reply(refresh, nativeKanji
        ? {
            kanji: {
              character: "\u98df",
              entries: [{ dictionary: "Generic" }],
            },
          }
        : {
            dictionaryCount: 1,
            results: [harness.term("\u98df\u3079\u305f refreshed")],
          });
      await harness.settle();
      let resolved = true;
      try {
        await append;
      } catch {
        resolved = false;
      }
      const result = {
        popupHidden: harness.driver.snapshot().popupHidden,
        refreshCount: refresh === null ? 0 : 1,
        renderCount: harness.renders.length - renderCount,
        resolved,
      };
      harness.close();
      return result;
    }

    return {
      kanji: await run("kanji"),
      term: await run("term"),
    };
  }

  async function guardCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.driver.scheduleHide();
    const pendingBeforeEditing = harness.driver.hideTimerPending();
    harness.edit(true);
    const pendingWhileEditing = harness.driver.hideTimerPending();
    let caretCalls = 0;
    harness.popup.ownerDocument.caretRangeFromPoint = () => {
      caretCalls += 1;
      return null;
    };
    harness.driver.scanPointer({
      clientX: 200,
      clientY: 200,
      modifierHeld: true,
      target: harness.popup.ownerDocument.body,
    });
    harness.setCloseNext(true);
    harness.popup.ownerDocument.dispatchEvent(new harness.popup.ownerDocument.defaultView.KeyboardEvent(
      "keydown",
      { bubbles: true, cancelable: true, key: "Escape" },
    ));
    const firstEscapeHidden = harness.driver.snapshot().popupHidden;
    const firstEscapeClears = harness.stats().clearCount;
    harness.popup.ownerDocument.dispatchEvent(new harness.popup.ownerDocument.defaultView.KeyboardEvent(
      "keydown",
      { bubbles: true, cancelable: true, key: "Escape" },
    ));
    const result = {
      caretCalls,
      closeCalls: harness.stats().closeCalls,
      firstEscapeClears,
      firstEscapeHidden,
      pendingBeforeEditing,
      pendingWhileEditing,
      secondEscapeClears: harness.stats().clearCount,
      secondEscapeHidden: harness.driver.snapshot().popupHidden,
    };
    harness.close();
    return result;
  }

  async function deferredInvalidationCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.edit(true);
    harness.emitState(harness.state(2, "external-change"));
    const visibleWhileEditing = harness.driver.snapshot().popupHidden === false;
    harness.edit(false);
    const hiddenAfterClose = harness.driver.snapshot().popupHidden === true;
    const result = { hiddenAfterClose, visibleWhileEditing };
    harness.close();
    return result;
  }

  async function renderFailureCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    const previousContext = harness.render().context;
    const previous = harness.render().context.onRenderError;
    await harness.initialLookup();
    const currentContext = harness.render().context;
    const current = harness.render().context.onRenderError;
    const requestOwnership = previousContext.isCurrentRequest?.() === false
      && currentContext.isCurrentRequest?.() === true;
    previous?.(new Error("superseded render"));
    const stayedVisible = !harness.driver.snapshot().popupHidden;
    current?.(new Error("current render"));
    const result = typeof previous === "function" && typeof current === "function"
      && requestOwnership
      && stayedVisible && harness.driver.snapshot().popupHidden;
    harness.close();
    return result;
  }

  return {
    callbacksWired,
    newestOnlyOptions,
    renderFailure: await renderFailureCase(),
    deferredInvalidation: await deferredInvalidationCase(),
    detached: await detachedCase(),
    detachedDuringRefresh: await detachedDuringRefreshCase(),
    eventFirst: await eventFirstCase(),
    guards: await guardCase(),
    kanji: await kanjiCase(),
    refreshFailure: await refreshFailureCase(),
    replaced: await termKanjiCase(true),
    replyFirst: await replyFirstCase(),
    termKanji: await termKanjiCase(false),
  };
}

// The renderer is the one consumer that reads contract B field by field, so it
// is driven with the engine's own bytes rather than a hand-written payload.
async function renderStage({ imageLookup, kanji, lookup, media }) {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;

  const dom = new JSDOM("<!doctype html><html><body><p>...</p></body></html>", {
    pretendToBeVisual: true,
    url: "https://example.test/",
  });
  const { window } = dom;
  const { document } = window;

  const sandbox = createContext({ window, document, console, globalThis: undefined });
  sandbox.globalThis = sandbox;
  sandbox.window = window;
  for (const file of ["render/glossary.js", "render/popup.js"]) {
    runInContext(readFileSync(resolve(EXTENSION, file), "utf8"), sandbox, { filename: file });
  }
  const HDGlossary = sandbox.HDGlossary ?? window.HDGlossary;
  const HDPopup = sandbox.HDPopup ?? window.HDPopup;
  check("render/glossary.js publishes HDGlossary", Boolean(HDGlossary), "HDGlossary was undefined");
  check("render/popup.js publishes HDPopup", Boolean(HDPopup), "HDPopup was undefined");
  if (!HDGlossary || !HDPopup) {
    return false;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  shadow.appendChild(popup);

  let positioned = 0;
  const noteEntries = [];
  const noteEditingStates = [];
  let addNoteEntry = async () => {};
  const view = HDPopup.createPopupView({
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    document,
    getPopupColumns: () => 1,
    idPrefix: "hoshidicts",
    onKanjiClick() {},
    onAddCustomEntry(entry) {
      noteEntries.push(structuredClone(entry));
      return addNoteEntry(entry);
    },
    onNoteEditingChange(editing) {
      noteEditingStates.push(editing);
    },
    parseTagList: HDGlossary.parseTagList,
    popup,
    positionPopup() {
      positioned += 1;
    },
    window,
  });

  const source = document.querySelector("p");
  source.textContent = lookup.results[0].matched;
  const candidate = {
    anchor: source,
    matchOffset: 0,
    query: lookup.results[0].matched,
    sentence: source.textContent,
    sourceElements: [source],
  };

  const mediaRequests = [];
  let stats;
  try {
    stats = view.renderResults(lookup.results, candidate, {
      generation: lookup.generation,
      hidePopupGrammarTags: false,
      resolveMedia(query) {
        mediaRequests.push(query);
        return Promise.resolve(media.dataUrl);
      },
      showFrequencyDictionaryNames: true,
      showPitchAccentBadge: true,
      showPitchAccentFurigana: true,
    });
  } catch (error) {
    fail("renderResults accepts the engine's LookupResult verbatim", error.stack ?? error);
    return false;
  }
  pass("renderResults accepts the engine's LookupResult verbatim");
  check("renderResults asked the caller to position the popup", positioned > 0, `positioned ${positioned}`);
  check("renderResults returned its lookupStats slot", stats !== undefined && "lookupStats" in stats, JSON.stringify(stats));

  const headword = popup.querySelector(".gsm-hoshidicts-headword");
  check(
    "the headword renders the deinflected expression",
    (headword?.textContent ?? "").includes(lookup.results[0].term.expression),
    JSON.stringify(headword?.textContent),
  );
  const glossaryContent = popup.querySelector(".gsm-hoshidicts-glossary-content");
  check(
    "the raw structured-content glossary was parsed and rendered",
    Boolean(glossaryContent) && (glossaryContent.textContent ?? "").length > 0,
    JSON.stringify(glossaryContent?.textContent?.slice(0, 80)),
  );
  // The engine hands over the raw glossary *array* of one term-bank row, and
  // every element of it is a separate sense. Appending them into one parent runs
  // them together with no separator ("to eatto live on (e.g. a salary)").
  const senses = JSON.parse(lookup.results[0].term.glossaries[0].glossary);
  check("the fixture's first glossary carries more than one sense", senses.length > 1, JSON.stringify(senses));
  equal(
    "every element of the glossary array renders as its own item",
    [...(glossaryContent?.querySelectorAll(".gloss-item") ?? [])].map((item) => item.textContent),
    senses,
  );
  check(
    "the glossary card is tagged with its dictionary for @scope",
    glossaryContent?.dataset.hoshidictsDictionary === lookup.results[0].term.glossaries[0].dictionary,
    JSON.stringify(glossaryContent?.dataset?.hoshidictsDictionary),
  );
  check(
    "frequency metadata rendered",
    popup.textContent.includes(lookup.results[0].term.frequencies[0].frequencies[0].displayValue),
    JSON.stringify(popup.textContent.slice(0, 200)),
  );

  const glossary = lookup.results[0].term.glossaries[0];
  const noteResults = [
    {
      ...lookup.results[0],
      term: {
        ...lookup.results[0].term,
        expression: "All-tab primary",
        reading: "おーる",
        glossaries: [{ ...glossary, dictionary: "Dictionary A" }],
      },
    },
    {
      ...lookup.results[0],
      term: {
        ...lookup.results[0].term,
        expression: "Projected primary",
        reading: "ぷろじぇくてっど",
        glossaries: [{ ...glossary, dictionary: "Dictionary B" }],
      },
    },
  ];
  const selectedTabs = [];
  view.renderResults(noteResults, candidate, {
    dictionaryPresentation: [{ title: "Dictionary B", displayName: "Favourite B", favorite: true }],
    onDictionaryTabSelected(tab) {
      selectedTabs.push(tab);
    },
  });
  popup.querySelector('[role="tab"][data-dictionary="Dictionary B"]')?.click();
  const termNoteButton = popup.querySelector(".gsm-hoshidicts-note-button");
  const termFormWasLazy = popup.querySelector(".gsm-hoshidicts-note-form") === null
    && view.closeNoteForm() === false;
  const resultToolbar = popup.querySelector(".gsm-hoshidicts-result-chrome");
  Object.defineProperty(popup, "scrollHeight", { configurable: true, value: 480 });
  view.setToolbarPosition("bottom");
  popup.scrollTop = 0;
  termNoteButton?.click();
  const bottomNoteForm = popup.querySelector(".gsm-hoshidicts-note-form");
  const bottomChildren = [...popup.children];
  const openedAtBottom = popup.scrollTop;
  view.setToolbarPosition("top");
  check(
    "the bottom Note form stays beside its toolbar and opens at the active edge",
    termFormWasLazy
      && bottomChildren.at(-2) === bottomNoteForm
      && bottomChildren.at(-1) === resultToolbar
      && openedAtBottom === popup.scrollHeight
      && popup.children[0] === resultToolbar
      && popup.children[1] === bottomNoteForm,
    JSON.stringify({
      bottomOrder: bottomChildren.map(({ className }) => className),
      openedAtBottom,
      scrollHeight: popup.scrollHeight,
      topOrder: [...popup.children].map(({ className }) => className),
    }),
  );
  const termNoteForm = popup.querySelector(".gsm-hoshidicts-note-form");
  const termInput = termNoteForm?.querySelector(".gsm-hoshidicts-note-term");
  const readingInput = termNoteForm?.querySelector(".gsm-hoshidicts-note-reading");
  const definitionInput = termNoteForm?.querySelector(".gsm-hoshidicts-note-definition");
  check(
    "the shared Note form uses the currently projected primary term",
    selectedTabs.length === 2
      && selectedTabs[0] === null
      && selectedTabs[1]?.dictionary === "Dictionary B"
      && termNoteButton?.getAttribute("aria-expanded") === "true"
      && termNoteButton?.getAttribute("aria-controls") === termNoteForm?.id
      && termNoteForm?.id === "hoshidicts-note-form"
      && termInput?.value === "Projected primary"
      && readingInput?.value === "ぷろじぇくてっど"
      && definitionInput?.value === ""
      && !termInput?.hasAttribute("maxlength")
      && !readingInput?.hasAttribute("maxlength")
      && !definitionInput?.hasAttribute("maxlength"),
    JSON.stringify({
      selectedTabs,
      expanded: termNoteButton?.getAttribute("aria-expanded"),
      term: termInput?.value,
      reading: readingInput?.value,
      definition: definitionInput?.value,
    }),
  );
  if (definitionInput) definitionInput.value = "A retained draft";
  addNoteEntry = async () => {
    throw new Error("simulated append failure");
  };
  termNoteForm?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((done) => window.setTimeout(done, 0));
  const rejectedDraft = {
    hidden: termNoteForm?.hidden,
    definition: definitionInput?.value,
    error: termNoteForm?.querySelector(".gsm-hoshidicts-note-error")?.textContent,
  };
  let resolveNoteEntry;
  addNoteEntry = () => new Promise((resolveNote) => {
    resolveNoteEntry = resolveNote;
  });
  termNoteForm?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((done) => window.setTimeout(done, 0));
  const pendingNote = {
    formBusy: termNoteForm?.getAttribute("aria-busy"),
    saveText: termNoteForm?.querySelector(".gsm-hoshidicts-note-save")?.textContent,
  };
  resolveNoteEntry?.();
  await new Promise((done) => window.setTimeout(done, 0));
  check(
    "a rejected Note append retains its draft and a successful retry closes it",
    rejectedDraft.hidden === false
      && rejectedDraft.definition === "A retained draft"
      && rejectedDraft.error?.includes("simulated append failure")
      && noteEntries.length === 2
      && noteEntries.every((entry) => JSON.stringify(entry) === JSON.stringify({
        term: "Projected primary",
        reading: "ぷろじぇくてっど",
        definition: "A retained draft",
      }))
      && pendingNote.formBusy === "true"
      && pendingNote.saveText === "Saving…"
      && termNoteForm?.hidden === true
      && shadow.activeElement === termNoteButton
      && noteEditingStates.join(",") === "true,false",
    JSON.stringify({
      activeClass: shadow.activeElement?.className,
      hidden: termNoteForm?.hidden,
      noteEditingStates,
      noteEntries,
      pendingNote,
      rejectedDraft,
    }),
  );
  termNoteButton?.click();
  const firstEscapeClosed = typeof view.closeNoteForm === "function" && view.closeNoteForm();
  const secondEscapeClosed = typeof view.closeNoteForm === "function" && view.closeNoteForm();
  check(
    "the Note controller consumes Escape only while its form is open",
    firstEscapeClosed === true
      && secondEscapeClosed === false
      && noteEditingStates.join(",") === "true,false,true,false",
    JSON.stringify({ firstEscapeClosed, secondEscapeClosed, noteEditingStates }),
  );

  view.renderResults(imageLookup.results, candidate, {
    generation: imageLookup.generation,
    hidePopupGrammarTags: false,
    resolveMedia(query) {
      mediaRequests.push(query);
      return Promise.resolve(media.dataUrl);
    },
  });
  await new Promise((done) => setTimeout(done, 20));
  check(
    "the structured-content image asked for media with a dictionary and a path",
    mediaRequests.length > 0 &&
      typeof mediaRequests[0].dictionary === "string" &&
      mediaRequests[0].path === "media/kanji.png",
    JSON.stringify(mediaRequests),
  );
  const image = popup.querySelector(".gsm-hoshidicts-glossary-content img");
  check(
    "the resolved data: URL reached the <img>",
    image?.getAttribute("src") === media.dataUrl,
    JSON.stringify(image?.getAttribute("src")?.slice(0, 48)),
  );
  // The class a dictionary's own CSS can target. It only fires if the array
  // element, not the array, is what gets inspected.
  const structuredContainer = popup.querySelector(".gsm-hoshidicts-glossary-content");
  check(
    "a structured-content glossary tags its container",
    structuredContainer?.classList.contains("structured-content") === true,
    JSON.stringify(structuredContainer?.className),
  );

  try {
    view.renderKanji(kanji, candidate, { dictionaryPresentation: [], highlightText: kanji.character });
  } catch (error) {
    fail("renderKanji accepts contract-B string onyomi/kunyomi/tags", error.stack ?? error);
    return false;
  }
  pass("renderKanji accepts contract-B string onyomi/kunyomi/tags");
  check(
    "the kanji view renders the readings without splitting them per character",
    popup.textContent.includes(kanji.entries[0].onyomi.split(/[\s,;]/u)[0]),
    JSON.stringify(popup.textContent.slice(0, 200)),
  );
  const kanjiNoteButton = popup.querySelector(".gsm-hoshidicts-note-button");
  const kanjiFormWasLazy = popup.querySelector(".gsm-hoshidicts-note-form") === null;
  kanjiNoteButton?.click();
  const kanjiNoteForm = popup.querySelector(".gsm-hoshidicts-note-form");
  check(
    "the kanji view uses the same Note form with a glyph-only prefill",
    kanjiFormWasLazy
      && kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-term")?.value === kanji.character
      && kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-reading")?.value === ""
      && kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-definition")?.value === "",
    JSON.stringify({
      term: kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-term")?.value,
      reading: kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-reading")?.value,
      definition: kanjiNoteForm?.querySelector(".gsm-hoshidicts-note-definition")?.value,
    }),
  );

  view.renderNotice("nothing found", candidate);
  check("renderNotice replaces the view", popup.textContent.includes("nothing found"), JSON.stringify(popup.textContent));
  view.clear();
  equal("clear empties the popup", popup.childElementCount, 0);
  view.destroy();
  structuredRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  dom.window.close();
  return true;
}

function structuredRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const rejected = (operation) => {
    try { operation(); return false; }
    catch (error) {
      if (error.name !== "RangeError" || !/structured.*limit/iu.test(error.message)) throw error;
      return true;
    }
  };
  const nested = (depth) => {
    let value = "leaf";
    for (let index = 0; index < depth; index += 1) value = { type: "text", text: value };
    return JSON.stringify([value]);
  };
  const parent = document.createElement("div");
  HDGlossary.appendTextOnlyGlossary(document, parent, nested(24));
  const exactDepth = parent.textContent === "leaf";
  parent.replaceChildren();
  const excessiveDepth = rejected(() => HDGlossary.appendTextOnlyGlossary(document, parent, nested(25)));
  HDGlossary.appendTextOnlyGlossary(document, parent, '[{"tag":"unknown","content":"kept"}]');
  HDGlossary.appendTextOnlyGlossary(document, parent, "<literal>");
  check("structured depth rejects overflow and preserves ordinary fallback text",
    exactDepth && excessiveDepth && parent.textContent === "kept<literal>", parent.textContent);

  const limit = 1_048_576;
  const values = [
    { value: null, count: 1 },
    { value: "text", count: 1 },
    { value: { tag: "script", content: "ignored" }, count: 1 },
    { value: [null], count: 2 },
    { value: { type: "text", text: "leaf" }, count: 2 },
    { value: { tag: "unknown", content: null }, count: 2 },
  ];
  const nodeCases = values.map(({ value, count }) => {
    const state = { nodes: limit - count };
    const accepted = !rejected(() => HDGlossary.appendStructuredValue(document, parent, value, state, 0));
    return accepted && state.nodes === limit
      && rejected(() => HDGlossary.appendStructuredValue(document, parent, null, state, 0))
      && rejected(() => HDGlossary.appendStructuredValue(document, parent, value, { nodes: limit - count + 1 }, 0));
  });
  check("structured node accounting includes containers, wrappers and ignored values without truncation",
    nodeCases.every(Boolean), JSON.stringify(nodeCases));

  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const queued = [];
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = (callback) => { queued.push(callback); return queued.length; };
  let fills = 0;
  let layouts = 0;
  let media = 0;
  let errors = 0;
  let requestCurrent = true;
  const view = HDPopup.createPopupView({
    document, window, popup, initialResultCount: 2,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    parseTagList: HDGlossary.parseTagList,
    appendTextOnlyGlossary(...args) { fills += 1; return HDGlossary.appendTextOnlyGlossary(...args); },
    positionPopup() { layouts += 1; },
  });
  const entry = (dictionary, glossary) => ({
    ...result,
    term: { ...result.term, glossaries: [{ dictionary, glossary }] },
  });
  const healthy = entry("Healthy", '["healthy"]');
  const invalid = entry("Invalid", nested(25));
  const imageEntry = entry("Image", '[{"type":"image","path":"media/image.png","width":16,"height":16}]');
  const context = {
    isCurrentRequest: () => requestCurrent,
    dictionaryPresentation: [{ title: "Healthy", favorite: true }, { title: "Invalid", favorite: true }],
    onRenderError() { errors += 1; view.clear(); },
    resolveMedia() { media += 1; return Promise.resolve(null); },
  };
  const drain = () => {
    let escaped = 0;
    for (const callback of queued.splice(0)) {
      try { callback(); } catch { escaped += 1; }
    }
    return escaped;
  };
  try {
    view.renderResults([healthy, invalid], candidate, context);
    const escaped = drain();
    const deferredHandled = errors === 1 && escaped === 0 && popup.childElementCount === 0;
    view.renderResults([healthy, invalid], candidate, context);
    popup.querySelector('[data-dictionary="Invalid"][role="tab"]')?.click();
    const tabHandled = errors === 2 && popup.childElementCount === 0;
    drain();
    view.renderResults([healthy, healthy, invalid], candidate, context);
    drain();
    popup.querySelector(".gsm-hoshidicts-show-more")?.click();
    const moreEscaped = drain();
    check("deferred, tab and expanded render failures reach their owner without escaping",
      deferredHandled && tabHandled && errors === 3 && moreEscaped === 0 && popup.childElementCount === 0,
      JSON.stringify({ deferredHandled, tabHandled, errors, escaped, moreEscaped }));

    const replacements = [
      () => view.renderResults([healthy], candidate, context),
      () => popup.querySelector('[data-dictionary="Healthy"][role="tab"]')?.click(),
      () => view.clear(),
      () => { requestCurrent = false; },
      () => view.destroy(),
    ];
    const staleCases = replacements.map((replace) => {
      requestCurrent = true;
      view.renderResults([healthy, imageEntry], candidate, context);
      replace();
      const before = { fills, layouts, media, errors };
      const staleEscaped = drain();
      return staleEscaped === 0 && JSON.stringify(before) === JSON.stringify({ fills, layouts, media, errors });
    });
    check("superseded glossary tasks do no rendering, media or layout work",
      staleCases.every(Boolean), JSON.stringify(staleCases));
  } finally {
    window.setTimeout = originalSetTimeout;
    view.destroy();
    popup.remove();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
