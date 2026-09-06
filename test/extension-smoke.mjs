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
  frequencyRankingFixture,
  imagePreviewFixture,
  imageSizingFixture,
  makePng,
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
  "frequencyMode",
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
  const readerOptions = readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8");
  const externalLinks = readFileSync(resolve(EXTENSION, "external-links.js"), "utf8");
  const groupState = readFileSync(resolve(EXTENSION, "dictionary-group-state.js"), "utf8");
  const recommended = readFileSync(resolve(EXTENSION, "recommended-dictionaries.js"), "utf8");
  const customDictionary = readFileSync(resolve(EXTENSION, "custom-dictionary.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const jsonValue = readFileSync(resolve(EXTENSION, "json-value.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const responseLimits = readFileSync(resolve(EXTENSION, "response-limits.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const managedSource = readFileSync(resolve(EXTENSION, "managed-dictionary-source.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "");
  const background = readFileSync(resolve(EXTENSION, "background.js"), "utf8")
    .replace(/import "\.\/reader-options\.js";\s*/u, "")
    .replace(/import "\.\/external-links\.js";\s*/u, "")
    .replace(/import "\.\/dictionary-group-state\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/managed-dictionary-source\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/custom-dictionary\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/json-value\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/response-limits\.js";\s*/u, "");
  sandbox.TextEncoder ??= TextEncoder;
  sandbox.URL ??= URL;
  sandbox.Uint8Array ??= Uint8Array;
  sandbox.Uint32Array ??= Uint32Array;
  sandbox.DataView ??= DataView;
  sandbox.crypto ??= globalThis.crypto;
  const context = createContext(sandbox);
  context.globalThis = context;
  runInContext(
    `${recommended.replace(/^export\s+/gmu, "")}\n`
      + `${customDictionary}\n${jsonValue}\n${responseLimits}\n`
      + `${managedSource.replace(/^export\s+/gmu, "")}\n${readerOptions}\n${externalLinks}\n${groupState}\n${background}`,
    context,
    { filename: resolve(EXTENSION, "background.js") },
  );
  return context;
}

async function externalLinksBackgroundStage() {
  const bus = makeBus();
  const storage = makeStorage();
  const chrome = makeChrome("external-links-worker", bus, storage);
  const tabs = [];
  chrome.tabs = { async create(properties) { tabs.push(structuredClone(properties)); return { id: tabs.length }; } };
  loadBackgroundScript({ chrome, console, URL, setTimeout, clearTimeout, Promise, Error });
  await bus.sendMessage("external-links-reader", {
    target: "hoshidicts-worker", type: "hd_state_read", requestId: "external-links-ready",
  });
  const send = (payload, sender = { id: chrome.runtime.id, tab: { windowId: 9 } }) => bus.sendMessage(
    "external-links-reader",
    { target: "hoshidicts-worker", type: "hd_open_external", requestId: "external-link", ...payload },
    sender,
  );
  const accepted = await send({ url: " HTTPS://EXAMPLE.COM:443/日本?q=1#term ", active: false, windowId: 99, openerTabId: 11 });
  const local = await send({ url: "http://127.0.0.1:9876/reference" });
  const rejected = [];
  for (const url of ["javascript:alert(1)", "file:///tmp/a", "chrome://settings", "/relative", "https://", "https://user:pass@example.test/", "https://exam\nple.test/", { href: "https://example.test/" }]) {
    rejected.push(await send({ url }));
  }
  rejected.push(await send({ url: "https://example.test/", active: "yes" }));
  rejected.push(await send({ url: "https://example.test/" }, { id: "another-extension" }));
  const validReply = reply => reply?.type === "hd_open_external_result" && reply.requestId === "external-link";
  check("external links validate HTTP URLs and sender identity before creating one browser-owned tab",
    accepted?.ok && accepted.opened === true && validReply(accepted)
      && local?.ok && validReply(local)
      && JSON.stringify(tabs) === JSON.stringify([
        { url: "https://example.com/%E6%97%A5%E6%9C%AC?q=1#term", active: false, windowId: 9 },
        { url: "http://127.0.0.1:9876/reference", active: true, windowId: 9 },
      ])
      && rejected.every(reply => validReply(reply) && reply.ok === false && typeof reply.error === "string"),
    JSON.stringify({ accepted, local, tabs, rejected }));

  const originalSet = chrome.storage.local.set;
  let releaseWrite;
  chrome.storage.local.set = items => new Promise((resolveWrite, rejectWrite) => {
    releaseWrite = () => originalSet(items).then(resolveWrite, rejectWrite);
  });
  const writing = bus.sendMessage("external-links-reader", {
    target: "hoshidicts-worker", type: "hd_options_write", requestId: "held-options-write",
    baseRevision: 0, options: { scanLength: 17 },
  });
  for (let attempt = 0; !releaseWrite && attempt < 100; attempt += 1) {
    await new Promise(resolveTimer => setTimeout(resolveTimer, 0));
  }
  if (!releaseWrite) throw new Error("the external-link test did not hold its options write");
  let externalSettled = false;
  const before = { reads: storage.gets.length, writes: storage.sets.length, engine: offscreenState.created };
  const opening = send({ url: "https://example.test/while-saving" }).then(reply => { externalSettled = reply?.ok === true; return reply; });
  await new Promise(resolveTimer => setTimeout(resolveTimer, 0));
  const independent = externalSettled && before.reads === storage.gets.length
    && before.writes === storage.sets.length && before.engine === offscreenState.created;
  releaseWrite();
  await writing;
  await opening;
  chrome.storage.local.set = originalSet;
  let failureAttempts = 0;
  chrome.tabs.create = async () => { failureAttempts += 1; throw new Error("tab creation failed"); };
  const failed = await send({ url: "https://example.test/failure" });
  check("external tab creation bypasses storage and engine queues and reports a failure without retry",
    independent && failureAttempts === 1 && failed?.ok === false && validReply(failed) && failed.error.includes("tab creation failed")
      && !bus.log.some(message => message.relayed),
    JSON.stringify({ independent, failed, log: bus.log }));
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
  const settings = readFileSync(resolve(EXTENSION, "settings.js"), "utf8")
    .replace(/import "\.\/reader-options\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/dictionary-groups\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/managed-dictionary-source\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/recommended-dictionaries\.js";\s*/u, "")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/custom-dictionary\.js";\s*/u, "");
  window.TextEncoder ??= TextEncoder;
  window.eval(
    `${recommended.replace(/^export\s+/gmu, "")}\n${customDictionary}\n${managedSource}\n${groupState}\n${groups}\n${readerOptions}\n${settings}`,
  );
}

async function checkReaderOptionsTransport(pageChrome, storage) {
  const local = storage.api().local;
  const saved = await local.get(["options", "dictionaryState"]);
  const frameLimit = 1024 * 1024;
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const message = (options = {}, extra = {}) => ({
    target: "hoshidicts-worker", type: "hd_options_write", requestId: "options-contract",
    baseRevision: 2, options, ...extra,
  });
  const send = (value) => pageChrome.runtime.sendMessage(value);
  const unchanged = async (before) => JSON.stringify(await local.get(["options", "dictionaryState"]))
    === JSON.stringify(before);
  try {
    const readerContext = createContext({});
    runInContext(readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8"), readerContext);
    const reader = readerContext.HDReaderOptions;
    const plain = reader.normaliseOptions({ modifier: "none" });
    const held = reader.normaliseOptions({ modifier: "ctrl" });
    const explicit = reader.projectStoredOptions({ modifier: "alt", lookupMode: "hover", activationKey: "K" });
    const legacyPatch = reader.validateOptionsPatch({ modifier: "shift" });
    const invalidActivation = [
      { hoverEnabled: 1 }, { lookupMode: "always" }, { activationKey: "not a key" },
      { popupHideDelayMs: -1 }, { popupHideDelayMs: 5001 },
    ].every((patch) => {
      try { reader.validateOptionsPatch(patch); return false; } catch { return true; }
    });
    check("reader activation options migrate legacy modes without competing policies and validate new fields",
      plain.hoverEnabled === true && plain.lookupMode === "hover" && plain.activationKey === "Shift"
        && plain.popupHideDelayMs === 160 && held.lookupMode === "activation" && held.activationKey === "Control"
        && explicit.lookupMode === "hover" && explicit.activationKey === "K" && explicit.modifier === undefined
        && legacyPatch.lookupMode === "activation" && legacyPatch.activationKey === "Shift"
        && legacyPatch.modifier === undefined && invalidActivation,
      JSON.stringify({ plain, held, explicit, legacyPatch, invalidActivation }));
    const depths = [];
    for (const depth of [0, 2, Number.MAX_SAFE_INTEGER]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupNestingMaxDepth: depth }));
      depths.push(reply.ok === true && reply.options?.popupNestingMaxDepth === depth);
    }
    const badDepths = [];
    for (const depth of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupNestingMaxDepth: depth }));
      badDepths.push(reply.ok === false && await unchanged(saved));
    }
    check("nested lookup depth defaults to ten children and accepts zero through the safe-integer range via options CAS",
      reader.normaliseOptions({}).popupNestingMaxDepth === 10
        && depths.every(Boolean) && badDepths.every(Boolean), JSON.stringify({ depths, badDepths }));
    const columns = [];
    for (const count of [1, 2, 3, 4]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupColumns: count }));
      columns.push(reply.ok === true && reply.options?.popupColumns === count);
    }
    const badColumns = [];
    for (const count of [0, 5, 1.5, "2", null]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupColumns: count }));
      badColumns.push(reply.ok === false && await unchanged(saved));
    }
    check("definition columns default to one and accept only integers one through four via options CAS",
      reader.normaliseOptions({}).popupColumns === 1
        && columns.every(Boolean) && badColumns.every(Boolean), JSON.stringify({ columns, badColumns }));
    const summaryDefaults = reader.normaliseOptions({});
    const summaryAccepted = [];
    for (const count of [1, 3, 6]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ showCompactDefinitionSummary: true,
        compactDefinitionSummaryCount: count, compactDefinitionSummaryDictionary: "Personal source" }));
      summaryAccepted.push(reply.ok === true && reply.options?.showCompactDefinitionSummary === true
        && reply.options?.compactDefinitionSummaryCount === count
        && reply.options?.compactDefinitionSummaryDictionary === "Personal source");
    }
    const summaryRejected = [];
    for (const patch of [{ showCompactDefinitionSummary: 1 }, { compactDefinitionSummaryDictionary: null },
      ...[0, 7, 1.5, "3"].map(count => ({ compactDefinitionSummaryCount: count }))]) {
      await local.set({ options: saved.options });
      const reply = await send(message(patch));
      summaryRejected.push(reply.ok === false && await unchanged(saved));
    }
    check("compact summaries default off with three snippets and preserve a soft source preference through strict options CAS",
      summaryDefaults.showCompactDefinitionSummary === false && summaryDefaults.compactDefinitionSummaryCount === 3
        && summaryDefaults.compactDefinitionSummaryDictionary === ""
        && summaryAccepted.every(Boolean) && summaryRejected.every(Boolean),
      JSON.stringify({ summaryDefaults, summaryAccepted, summaryRejected }));
    const imageSources = [];
    for (const source of [null, { kind: "dictionary", title: "Images: 日本語" }, { kind: "tabGroup", id: "group:media" }]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupImageSource: source && { ...source, ignored: true } }));
      const noOp = await send(message({ popupImageSource: source }, { baseRevision: 3 }));
      imageSources.push(reply.ok === true && reply.options?.revision === 3
        && JSON.stringify(reply.options?.popupImageSource) === JSON.stringify(source)
        && noOp.ok === true && noOp.options?.revision === 3);
    }
    const invalidImageSources = [];
    for (const source of ["Images", 0, [], {}, { kind: "dictionary", title: "" },
      { kind: "dictionary", title: 2 }, { kind: "tabGroup", id: "" },
      { kind: "tabGroup", title: "group:media" }, { kind: "other", title: "Images" }]) {
      await local.set({ options: saved.options });
      const reply = await send(message({ popupImageSource: source }));
      invalidImageSources.push(reply.ok === false && await unchanged(saved));
    }
    check("popup images default to Automatic and preserve canonical dictionary or stable group selection through strict idempotent CAS",
      reader.normaliseOptions({}).popupImageSource === null
        && !Object.hasOwn(reader.projectStoredOptions({}), "popupImageSource")
        && reader.normaliseOptions({ popupImageSource: { kind: "other" } }).popupImageSource === null
        && imageSources.every(Boolean) && invalidImageSources.every(Boolean),
      JSON.stringify({ imageSources, invalidImageSources }));
    const invalid = [
      { scanLength: "18" }, { scanLength: 0 }, { maxResults: 257 },
      { hoverDelayMs: -1 }, { hoverDelayMs: 1.5 }, { modifier: "meta" },
      { frequencyOrder: "sideways" }, { frequencyDictionary: {} },
      { kanjiClickDictionary: { title: "字", kind: "other" } },
      { kanjiClickDictionary: { title: "", kind: "kanji" } },
    ];
    const rejected = [];
    for (const patch of invalid) {
      await local.set({ options: saved.options });
      const reply = await send(message(patch));
      rejected.push(reply.ok === false && reply.requestId === "options-contract" && await unchanged(saved));
    }
    await local.set({ options: saved.options });
    const healthy = await send(message({ scanLength: 64, maxResults: 256, hoverDelayMs: 2000, modifier: "alt" }));
    check("reader options reject malformed known fields without committing and accept a healthy follow-up",
      rejected.every(Boolean) && healthy.ok === true && healthy.options?.revision === 3
        && healthy.options?.scanLength === 64 && healthy.options?.maxResults === 256
        && healthy.options?.hoverDelayMs === 2000 && healthy.options?.lookupMode === "activation"
        && healthy.options?.activationKey === "Alt" && healthy.options?.modifier === undefined,
      JSON.stringify({ rejected, healthy }));

    await local.set({ options: saved.options });
    const ignored = await send(message({ unknown: "ignored", revision: 999 }));
    const ignoredUnchanged = await unchanged(saved);
    const legacy = {
      revision: 2, scanLength: "20.9", maxResults: 900, modifier: "bad",
      hoverDelayMs: { toString: null },
      kanjiClickDictionary: { title: "旧名", kind: "kanji", ignored: true },
      unknown: "stored junk",
    };
    await local.set({ options: legacy });
    const conflict = await send(message({}, { baseRevision: 1 }));
    const conflictUnchanged = JSON.stringify((await local.get("options")).options) === JSON.stringify(legacy);
    const repaired = await send(message());
    const noOp = await send(message({}, { baseRevision: 3 }));
    check("reader options project unknown fields and repair legacy values at one newer revision",
      ignored.ok === true && ignored.options?.revision === 2 && ignored.options?.unknown === undefined
        && ignoredUnchanged && conflict.ok === false && conflict.conflict === true && conflictUnchanged
        && conflict.options?.unknown === undefined && conflict.options?.scanLength === 20
        && conflict.options?.maxResults === 256 && conflict.options?.lookupMode === "hover"
        && conflict.options?.modifier === undefined
        && conflict.options?.kanjiClickDictionary?.ignored === undefined
        && conflict.options?.hoverDelayMs === 50 && conflict.options?.frequencyOrder === undefined
        && repaired.ok === true
        && repaired.options?.revision === 3 && noOp.options?.revision === 3
        && JSON.stringify((await local.get("options")).options) === JSON.stringify(repaired.options),
      JSON.stringify({ ignored, ignoredUnchanged, conflict, conflictUnchanged, repaired, noOp }));

    await local.set({ options: { scanLength: 16 } });
    const missingRevision = await send(message({ scanLength: 16 }, { baseRevision: 0 }));
    const sparseUnchanged = JSON.stringify((await local.get("options")).options) === '{"scanLength":16}';
    await local.remove("options");
    const empty = await send(message({ unknown: true }, { baseRevision: 0 }));
    const absentUnchanged = (await local.get("options")).options === undefined;
    await local.set({ options: { revision: 3, scanLength: 16, unknown: "prune me" } });
    const stateCommit = await send({ target: "hoshidicts-worker", type: "hd_state_cas", baseRevision: 0, dictionaries: [] });
    const pruned = (await local.get("options")).options;
    check("reader option projection preserves sparse no-ops and repairs options inside dictionary CAS",
      missingRevision.ok === true && missingRevision.options?.revision === 0 && sparseUnchanged
        && empty.ok === true && empty.options?.revision === 0 && absentUnchanged
        && stateCommit.ok === true && pruned.revision === 4 && pruned.scanLength === 16
        && Object.keys(pruned).length === 2,
      JSON.stringify({ missingRevision, sparseUnchanged, empty, absentUnchanged, stateCommit, pruned }));
    await local.remove("dictionaryState");
    await local.set({ options: saved.options });

    const exact = message({}, { padding: "猫\\\"" });
    exact.padding += "x".repeat(frameLimit - bytes(exact));
    const atLimit = await send(exact);
    const beyond = await send({ ...exact, padding: `${exact.padding}x` });
    const objectId = await send(message({ scanLength: 19 }, { requestId: {} }));
    const largeId = await send(message({ scanLength: 19 }, { requestId: "猫".repeat(frameLimit) }));
    let failureSerializations = 0;
    let failureEncodedUnits = 0;
    const failureContext = createContext({
      TextEncoder: class {
        encode(value) {
          failureEncodedUnits += value.length;
          return new TextEncoder().encode(value);
        }
      },
      JSON: { stringify(value) { failureSerializations += 1; return JSON.stringify(value); } },
    });
    runInContext(readFileSync(resolve(EXTENSION, "response-limits.js"), "utf8")
      .replace(/^export\s+/gmu, ""), failureContext);
    const oversizedFailure = failureContext.boundResponseFailure({
      type: "hd_options_write_result", requestId: "x".repeat(frameLimit), ok: false,
      error: failureContext.responseLimitError("hd_options_write_result"),
    });
    const identicalFailurePasses = failureSerializations;
    failureSerializations = 0;
    const shrinkableFailure = failureContext.boundResponseFailure({
      type: "hd_options_write_result", requestId: "keep-me", ok: false, error: "x".repeat(frameLimit),
    });
    check("reader option request framing counts the complete UTF-8 envelope and bounds failure correlation",
      bytes(exact) === frameLimit && atLimit.ok === true && beyond.ok === false
        && bytes(beyond) <= frameLimit && beyond.requestId === "options-contract"
        && objectId.ok === false && objectId.requestId === null
        && largeId.ok === false && largeId.requestId === null && bytes(largeId) <= frameLimit
        && oversizedFailure.requestId === null && identicalFailurePasses === 1
        && shrinkableFailure.requestId === "keep-me" && failureSerializations === 2
        && failureEncodedUnits === 0
        && await unchanged(saved),
      JSON.stringify({ exactBytes: bytes(exact), atLimit: atLimit.ok, beyond: beyond.ok,
        objectId: objectId.ok, largeId: largeId.ok, largeReplyBytes: bytes(largeId),
        identicalFailurePasses, shrinkableFailurePasses: failureSerializations, failureEncodedUnits }));

    const next = { revision: 10, scanLength: 17, frequencyDictionary: "猫\\\"" };
    const expectedReply = { type: "hd_options_write_result", requestId: "options-contract", ok: true, error: null, options: next };
    next.frequencyDictionary += "x".repeat(frameLimit - bytes(expectedReply));
    const oversizedStored = { ...next, revision: 9, scanLength: 16, frequencyDictionary: `${next.frequencyDictionary}x` };
    await local.set({ options: oversizedStored });
    const overflowReply = await send(message({ scanLength: 17 }, { baseRevision: 9 }));
    const rejectedBeforeCommit = JSON.stringify((await local.get("options")).options) === JSON.stringify(oversizedStored);
    await local.set({ options: { ...next, revision: 9, scanLength: 16 } });
    const conflictBefore = await local.get("options");
    const conflictOverflow = await send(message({}, { baseRevision: 8 }));
    const conflictDidNotWrite = JSON.stringify(await local.get("options")) === JSON.stringify(conflictBefore);
    const fittingReply = await send(message({ scanLength: 17 }, { baseRevision: 9 }));
    check("reader options preflight exact success and conflict frames before any storage commit",
      bytes(expectedReply) === frameLimit && overflowReply.ok === false && rejectedBeforeCommit
        && overflowReply.options === undefined && bytes(overflowReply) <= frameLimit
        && conflictOverflow.ok === false && conflictOverflow.options === undefined && conflictDidNotWrite
        && bytes(conflictOverflow) <= frameLimit && fittingReply.ok === true
        && fittingReply.options?.revision === 10 && bytes(fittingReply) === frameLimit,
      JSON.stringify({ expectedBytes: bytes(expectedReply), overflow: overflowReply.ok, rejectedBeforeCommit,
        conflictReplyBytes: bytes(conflictOverflow), conflictDidNotWrite,
        fitting: fittingReply.ok, fittingBytes: bytes(fittingReply) }));
  } finally {
    await local.set({ options: saved.options });
    if (saved.dictionaryState === undefined) await local.remove("dictionaryState");
    else await local.set({ dictionaryState: saved.dictionaryState });
  }
}

// The shared reader range must agree with the HTML inputs and the independent
// engine request boundary, so persisted settings cannot request fewer results
// in one runtime context than another.
const OPTION_RANGES = [
  [
    "maxResults",
    [
      ["reader-options.js", /maxResults:\s*\[(\d+),\s*(\d+)\]/u],
      ["settings.html", /id="opt-max-results"[^>]*?min="(\d+)"[^>]*?max="(\d+)"/u],
      ["engine-service.js", /clampInt\(\s*message\.maxResults,\s*(\d+),\s*(\d+)/u],
    ],
  ],
  [
    "scanLength",
    [
      ["reader-options.js", /scanLength:\s*\[(\d+),\s*(\d+)\]/u],
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
      && (html.match(/Install recommended/gu) ?? []).length === 1
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
  const background = readFileSync(resolve(EXTENSION, "background.js"), "utf8");
  const sharedFile = resolve(EXTENSION, "dictionary-group-state.js");
  const shared = existsSync(sharedFile) ? loadClassicScript(sharedFile, {}).HDDictionaryGroups : null;
  const dictionaries = [{ id: "first" }, { id: "disabled", enabled: false }, { id: "last" }];
  const input = [{
    id: "study", name: "  Ｓｔｕｄｙ\n\t Deck  ",
    dictionaryIds: ["disabled", "missing", "first", "disabled", "last", "first"],
    metadata: { retained: true },
  }, { id: "empty", name: "Empty" }];
  const before = JSON.stringify(input);
  const normalised = shared?.normaliseDictionaryGroups([...input, null, { id: "" }, { id: "blank", name: " " }], dictionaries);
  const pruned = shared?.pruneGroupMemberships(input, dictionaries);
  const members = ["disabled", "first", "last"];
  check(
    "settings imports its dictionary-group module",
    groups.includes("export function createDictionaryGroupController")
      && groups.includes('import "./dictionary-group-state.js"')
      && background.includes('import "./dictionary-group-state.js"')
      && settings.includes('from "./dictionary-groups.js"')
      && shared?.groupNameKey(input[0].name) === "study deck"
      && JSON.stringify(normalised) === JSON.stringify([
        { id: "study", name: "Study Deck", dictionaryIds: members },
        { id: "empty", name: "Empty", dictionaryIds: [] },
      ])
      && JSON.stringify(pruned) === JSON.stringify([
        { ...input[0], dictionaryIds: members }, { ...input[1], dictionaryIds: [] },
      ])
      && pruned[0].metadata === input[0].metadata
      && JSON.stringify(input) === before,
    JSON.stringify({ normalised, pruned }),
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

  section("external dictionary links");
  await externalLinksBackgroundStage();

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
    "the offscreen bridge places a hard bound on pending engine requests",
    /pending\.size\s*>=\s*MAX_PENDING_REQUESTS/u.test(offscreenSource)
      && /message\??\.type\s*===\s*"hd_status"/u.test(offscreenSource),
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
  await checkReaderOptionsTransport(pageChrome, storage);
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
  swChrome.runtime.sendMessage = (message) => message.relayed && ["hd_lookup", "hd_media"].includes(message.type)
    ? Promise.reject(new Error("long relay failure ".repeat(20))) : originalWorkerSend(message);
  try {
    const relayCases = [];
    for (const [type, responseLimit] of [["hd_lookup", 32 * 1024 * 1024], ["hd_media", 6 * 1024 * 1024]]) {
      const sendFailed = (requestId) => pageChrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type, text: "食", requestId,
      });
      const oversized = await sendFailed("x".repeat(responseLimit));
      const invalid = await sendFailed({});
      const compact = { ...oversized, requestId: "" };
      const exactId = "x".repeat(responseLimit - Buffer.byteLength(JSON.stringify(compact)));
      const correlated = await sendFailed(exactId);
      relayCases.push(oversized.ok === false && oversized.requestId === null && invalid.requestId === null
        && correlated.ok === false && correlated.requestId === exactId
        && correlated.error === compact.error
        && Buffer.byteLength(JSON.stringify(correlated)) === responseLimit);
    }
    check(
      "service-worker relay failures use the shared bounded lookup and media correlation rule",
      relayCases.every(Boolean), JSON.stringify(relayCases),
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
  const renamedCommunityTitle = "Renamed Community Dictionary";
  const selectedCommunityImage = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_options_write",
    baseRevision: (await storage.api().local.get("options")).options?.revision ?? 0,
    options: { popupImageSource: { kind: "dictionary", title: communityTitle } },
  });
  remoteJson(communityIndexUrl, { revision: "community-3" });
  remoteArchive(
    communityDownloadUrl,
    buildRecommendedZip({
      title: renamedCommunityTitle,
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
  const renamedImageOptions = (await storage.api().local.get("options")).options;
  const staleImageSelection = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_options_write",
    baseRevision: selectedCommunityImage.options.revision,
    options: { popupImageSource: selectedCommunityImage.options.popupImageSource },
  });
  check(
    "a managed title change migrates its image selection and rejects the old options revision",
    statusFailureCommunity.id === community.id
      && statusFailureCommunity.title === renamedCommunityTitle
      && renamedImageOptions.popupImageSource?.title === renamedCommunityTitle
      && renamedImageOptions.revision === selectedCommunityImage.options.revision + 1
      && staleImageSelection.conflict === true
      && staleImageSelection.options.popupImageSource?.title === renamedCommunityTitle,
    JSON.stringify({ statusFailureCommunity, renamedImageOptions, staleImageSelection }),
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
  await request("hd_remove", { title: renamedCommunityTitle });
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

  const frequencyFixture = frequencyRankingFixture();
  const frequencyMetadata = [];
  for (const dictionary of frequencyFixture.dictionaries) {
    const imported = await request("hd_import", { blobUrl: createObjectURL(dictionary.archive) });
    const stored = (await storedDictionaryState()).dictionaries.find(({ title }) => title === dictionary.title);
    const index = stored && JSON.parse(new TextDecoder().decode(observedEngine.FS.readFile(`${stored.path}/index.json`)));
    frequencyMetadata.push(imported.ok && index?.frequencyMode === dictionary.frequencyMode
      && stored?.frequencyMode === dictionary.frequencyMode);
  }
  const frequencyOrders = [];
  const [rankTitle, occurrenceTitle] = frequencyFixture.dictionaries.map(({ title }) => title);
  for (const [frequencyDictionary, frequencyOrder, readings] of [
    [rankTitle, "ascending", ["い", "あ", "う"]],
    [rankTitle, "descending", ["う", "あ", "い"]],
    [occurrenceTitle, "ascending", ["あ", "い", "う"]],
    [occurrenceTitle, "descending", ["う", "い", "あ"]],
    [occurrenceTitle, "disabled", ["あ", "い", "う"]],
    [occurrenceTitle, "auto", ["い", "あ", "う"]],
  ]) {
    for (const maxResults of [1, 3]) {
      const ranked = await request("hd_lookup", {
        text: frequencyFixture.query, scanLength: 16, maxResults,
        options: { frequencyDictionary, frequencyOrder },
      });
      frequencyOrders.push(ranked.ok && ranked.results.length === maxResults
        && ranked.results.every(({ term }, index) => term.reading === readings[index]
          && term.glossaries.map(({ dictionary }) => dictionary).join("|") === `${rankTitle}|${occurrenceTitle}`));
    }
  }
  check("frequency sorting precedes result limits and preserves manifest-ordered dictionary identity",
    frequencyOrders.every(Boolean), JSON.stringify(frequencyOrders));
  const beforeFrequencyReload = await storedDictionaryState();
  const legacyFrequencyState = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker", type: "hd_state_cas", baseRevision: beforeFrequencyReload.revision,
    dictionaries: beforeFrequencyReload.dictionaries.map(({ frequencyMode, ...dictionary }) => dictionary),
  });
  const frequencyReload = await request("hd_reload");
  const afterFrequencyReload = await storedDictionaryState();
  frequencyMetadata.push(legacyFrequencyState.ok && frequencyReload.ok
    && frequencyFixture.dictionaries.every(({ title, frequencyMode }) =>
      afterFrequencyReload.dictionaries.find((dictionary) => dictionary.title === title)?.frequencyMode === frequencyMode));
  check("real WASM frequency modes reach package metadata and recover from old committed generations",
    frequencyMetadata.every(Boolean), JSON.stringify(frequencyMetadata));
  for (const { title } of frequencyFixture.dictionaries) await request("hd_remove", { title });

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

  const media = await request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: "media/kanji.png" });
  check(
    "hd_media returns a data: URL glossary.js will accept",
    media.ok === true && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(media.dataUrl ?? ""),
    JSON.stringify(media.dataUrl?.slice(0, 48)),
  );
  const absentMedia = await request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: "media/nope.png" });
  equal("absent media is dataUrl null, not an error", [absentMedia.ok, absentMedia.dataUrl], [true, null]);

  const mediaDictionaryBoundary = "あ".repeat(341) + "x";
  const mediaPathBoundary = "media/" + "あ".repeat(1363) + "x";
  const exactMediaReferences = await Promise.all([
    request("hd_media", { generation: lookup.generation, dictionary: mediaDictionaryBoundary, path: "media/kanji.png" }),
    request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: mediaPathBoundary }),
  ]);
  const invalidMediaReferences = await Promise.all([
    request("hd_media", { generation: lookup.generation, dictionary: mediaDictionaryBoundary + "x", path: "media/kanji.png" }),
    request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: mediaPathBoundary + "x" }),
    request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE + "\0suffix", path: "media/kanji.png" }),
    request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: "media/kanji.png\0suffix" }),
  ]);
  check("media references use exact UTF-8 bounds and never truncate embedded NUL",
    Buffer.byteLength(mediaDictionaryBoundary) === 1024 && Buffer.byteLength(mediaPathBoundary) === 4096
      && exactMediaReferences.every((reply) => reply.ok === true && reply.dataUrl === null)
      && invalidMediaReferences.every((reply) => reply.ok === false && reply.dataUrl === null),
    JSON.stringify({ exact: exactMediaReferences.map(({ ok }) => ok), invalid: invalidMediaReferences.map(({ ok, error }) => ({ ok, error })) }));

  const mediaFrameLimit = 6 * 1024 * 1024;
  const mediaMessage = { type: "hd_media", generation: lookup.generation, dictionary: FIXTURE_TITLE, path: "media/kanji.png", requestId: "" };
  const smallMediaFrame = await engineService.handleEngineMessage(mediaMessage);
  const mediaIdBytes = mediaFrameLimit - Buffer.byteLength(JSON.stringify(smallMediaFrame));
  const exactMediaId = "あ".repeat(Math.floor(mediaIdBytes / 3)) + "x".repeat(mediaIdBytes % 3);
  const exactMediaFrame = await engineService.handleEngineMessage({ ...mediaMessage, requestId: exactMediaId });
  const excessiveMediaFrame = await engineService.handleEngineMessage({ ...mediaMessage, requestId: exactMediaId + "x" });
  check("media accepts exactly 6 MiB and rejects one extra complete frame byte",
    exactMediaFrame.ok === true && Buffer.byteLength(JSON.stringify(exactMediaFrame)) === mediaFrameLimit
      && exactMediaFrame.dataUrl === smallMediaFrame.dataUrl
      && excessiveMediaFrame.ok === false && excessiveMediaFrame.dataUrl === null
      && excessiveMediaFrame.requestId === exactMediaId + "x"
      && /6 MiB/u.test(excessiveMediaFrame.error)
      && Buffer.byteLength(JSON.stringify(excessiveMediaFrame)) <= mediaFrameLimit,
    JSON.stringify({ exact: exactMediaFrame.ok, excessive: excessiveMediaFrame.ok, error: excessiveMediaFrame.error }));
  const invalidMediaId = await engineService.handleEngineMessage({ ...mediaMessage, requestId: {} });
  const impossibleMediaId = await engineService.handleEngineMessage({ ...mediaMessage, requestId: "x".repeat(mediaFrameLimit) });
  check("invalid or impossible media correlation IDs receive bounded null-ID errors",
    [invalidMediaId, impossibleMediaId].every((reply) => reply.ok === false && reply.requestId === null
      && reply.dataUrl === null && Buffer.byteLength(JSON.stringify(reply)) <= mediaFrameLimit),
    JSON.stringify({ invalid: invalidMediaId.ok, impossible: impossibleMediaId.ok }));

  const largeMediaTitle = "bounded-media-fixture";
  const largeMediaBytes = Buffer.alloc(4 * 1024 * 1024);
  makePng().copy(largeMediaBytes);
  const largeMediaArchive = buildTitledZip(largeMediaTitle, { mediaEntries: [
    ["media/exact.png", largeMediaBytes],
    ["media/over.png", Buffer.concat([largeMediaBytes, Buffer.from([0])])],
  ] });
  const largeMediaImport = await request("hd_import", {
    blobUrl: createObjectURL(largeMediaArchive), fileName: "bounded-media.zip",
  });
  const exactNativeMedia = await request("hd_media", { generation: largeMediaImport.generation, dictionary: largeMediaTitle, path: "media/exact.png" });
  const overNativeMedia = await request("hd_media", { generation: largeMediaImport.generation, dictionary: largeMediaTitle, path: "media/over.png" });
  const healthyMediaAfterError = await request("hd_media", { generation: largeMediaImport.generation, dictionary: FIXTURE_TITLE, path: "media/kanji.png" });
  const largeMediaRemoved = await request("hd_remove", { title: largeMediaTitle });
  check("media imports stay uncapped while oversized native fetches propagate real errors",
    largeMediaImport.ok === true && largeMediaImport.report.mediaCount === 2
      && exactNativeMedia.ok === true
      && Buffer.from(exactNativeMedia.dataUrl?.split(",")[1] ?? "", "base64").equals(largeMediaBytes)
      && overNativeMedia.ok === false && overNativeMedia.dataUrl === null && /media/u.test(overNativeMedia.error)
      && healthyMediaAfterError.ok === true && healthyMediaAfterError.dataUrl === media.dataUrl
      && largeMediaRemoved.ok === true,
    JSON.stringify({ imported: largeMediaImport.ok, exact: exactNativeMedia.ok, over: overNativeMedia.ok,
      error: overNativeMedia.error, healthy: healthyMediaAfterError.ok, removed: largeMediaRemoved.ok }));

  let nativeMediaCalls = 0;
  observedEngine.ccall = (name, ...args) => {
    if (name === "hdw_media") nativeMediaCalls += 1;
    return originalCcall(name, ...args);
  };
  try {
    const reload = engineService.handleEngineMessage({ type: "hd_reload", requestId: "media-reload" });
    const staleMedia = engineService.handleEngineMessage({
      ...mediaMessage, generation: largeMediaRemoved.generation, requestId: "stale-media",
    });
    const [reloadedMedia, stale] = await Promise.all([reload, staleMedia]);
    const invalid = await Promise.all([undefined, -1, 1.5, "1"].map((generation) =>
      engineService.handleEngineMessage({ ...mediaMessage, generation })));
    const callsBeforeCurrent = nativeMediaCalls;
    const current = await engineService.handleEngineMessage({
      ...mediaMessage, generation: reloadedMedia.generation,
    });
    check("queued media rejects stale or invalid generations before native extraction",
      reloadedMedia.ok && stale.ok === false && /generation/u.test(stale.error)
        && invalid.every((reply) => !reply.ok && reply.dataUrl === null)
        && callsBeforeCurrent === 0 && nativeMediaCalls === 1
        && current.ok && current.generation === reloadedMedia.generation && current.dataUrl === media.dataUrl,
      JSON.stringify({ stale: stale.ok, invalid: invalid.map(({ ok }) => ok), callsBeforeCurrent,
        nativeMediaCalls, current: current.ok }));
  } finally {
    observedEngine.ccall = originalCcall;
  }

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
    generation: statusAfterRejectedReimport.generation,
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

  const previewFixture = imagePreviewFixture();
  const previewImport = await request("hd_import", {
    blobUrl: createObjectURL(previewFixture.archive), fileName: "image-preview.zip",
  });
  const previewMedia = [];
  for (const image of previewFixture.images) {
    const reply = await request("hd_media", {
      dictionary: previewFixture.title, generation: previewImport.generation, path: image.path,
    });
    previewMedia.push(reply.ok && reply.dataUrl === `data:${image.type};base64,${image.bytes.toString("base64")}`);
  }
  check("real WASM imports AVIF and SVG and returns their exact bytes with the correct MIME types",
    previewImport.ok && previewMedia.every(Boolean), JSON.stringify(previewMedia));
  await request("hd_remove", { title: previewFixture.title });

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
      && settingsConflict.casRequests[0].dictionaries[0].frequencyMode === "rank-based"
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
  const navigationSettings = await settingsNavigationStage();
  check("Settings navigation preserves mounted views and pending reader drafts without extra requests",
    navigationSettings?.navigation === true && navigationSettings.draft === true,
    JSON.stringify(navigationSettings));
  check("dictionary details retain their stable identity and focus across rerenders and filtering",
    navigationSettings?.details === true, JSON.stringify(navigationSettings));
  const frequencySettings = await settingsFrequencyStage();
  check("Settings derives frequency direction only on dictionary selection or explicit Auto",
    frequencySettings?.explicit === true, JSON.stringify(frequencySettings));
  check("frequency controls preserve unavailable selections and revision-bound native drafts",
    frequencySettings?.availability === true && frequencySettings.draft === true,
    JSON.stringify(frequencySettings));
  check("compact-summary Settings preserve count, soft canonical source and focused revision-bound drafts",
    frequencySettings?.summary === true, JSON.stringify(frequencySettings));
  check("image-source Settings preserve canonical dictionary and group choices through availability changes and focused conflicts",
    frequencySettings?.imageSources === true, JSON.stringify(frequencySettings));
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
  check("content routes external links to the worker without retrying or changing the current Note view",
    noteContent?.externalLinks === true, JSON.stringify(noteContent?.externalLinks));
  for (const [name, passed] of Object.entries(noteContent?.scanning ?? {})) {
    check(name, passed === true, JSON.stringify(passed));
  }
  for (const [name, passed] of Object.entries(noteContent?.activation ?? {})) {
    check(name, passed === true, JSON.stringify(passed));
  }
  for (const [name, passed] of Object.entries(noteContent?.mediaOwnership ?? {})) {
    check(name, passed === true, JSON.stringify(passed));
  }
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
  const selectedImageOptions = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_options_write",
    baseRevision: (await storage.api().local.get("options")).options.revision,
    options: { popupImageSource: { kind: "dictionary", title: FIXTURE_TITLE } },
  });
  storage.failNextSet("injected storage failure");
  const failedRemove = await request("hd_remove", { title: FIXTURE_TITLE });
  const stateAfterFailedRemove = await storedDictionaryState();
  const optionsAfterFailedRemove = (await storage.api().local.get("options")).options;
  check(
    "a remove whose storage write fails reports the failure",
    failedRemove.ok === false
      && JSON.stringify(stateAfterFailedRemove) === JSON.stringify(stateBeforeFailedRemove)
      && JSON.stringify(optionsAfterFailedRemove) === JSON.stringify(selectedImageOptions.options),
    JSON.stringify({ failedRemove, stateAfterFailedRemove, optionsAfterFailedRemove }),
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

  const writesBeforeRemove = storage.sets.length;
  const removed = await request("hd_remove", { title: FIXTURE_TITLE });
  const removalWrites = storage.sets.slice(writesBeforeRemove);
  check("hd_remove succeeds", removed.ok === true, JSON.stringify(removed));
  const afterRemove = await request("hd_status");
  equal("nothing is loaded after a remove", [afterRemove.ready, afterRemove.dictionaryCount], [true, 0]);
  const stateAfterRemove = await storedDictionaryState();
  equal("the logical dictionary inventory is empty", stateAfterRemove.dictionaries, []);
  equal("removing a dictionary prunes its stable group membership", stateAfterRemove.groups, [{
    ...studyGroup,
    dictionaryIds: [],
  }]);
  const optionsAfterRemove = (await storage.api().local.get("options")).options;
  const staleImageWrite = await pageChrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_options_write",
    baseRevision: selectedImageOptions.options.revision,
    options: { popupImageSource: selectedImageOptions.options.popupImageSource },
  });
  check(
    "removal atomically clears the selected image package and refuses a stale options write",
    optionsAfterRemove.popupImageSource === null
      && optionsAfterRemove.revision === selectedImageOptions.options.revision + 1
      && staleImageWrite.conflict === true
      && staleImageWrite.options.popupImageSource === null
      && JSON.stringify(removalWrites) === JSON.stringify([["dictionaryState", "options"]]),
    JSON.stringify({ optionsAfterRemove, staleImageWrite, removalWrites }),
  );
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

async function navigateSettingsSection(window, id) {
  window.location.hash = id;
  await new Promise((done) => window.setTimeout(done, 10));
}

async function settingsNavigationStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/settings.html#lookup`,
  });
  const { window } = dom;
  const document = window.document;
  let listener;
  let pendingSave;
  const requests = [];
  const storedOptions = { revision: 1, maxResults: 32 };
  let state = { schemaVersion: 1, revision: 1, groups: [], dictionaries: [
    genericPackage({ id: "first", title: "First" }),
    genericPackage({ id: "second", title: "Second" }),
  ] };
  window.chrome = {
    runtime: { async sendMessage(message) {
      requests.push(structuredClone(message));
      if (message.type === "hd_state_read") return { ok: true, state: structuredClone(state) };
      if (message.type === "hd_status") return { ok: true, ready: true, loading: false, dictionaryCount: 2 };
      if (message.type === "hd_options_write") return new Promise((resolveReply) => { pendingSave = resolveReply; });
      throw new Error(`Unexpected navigation request ${message.type}`);
    } },
    storage: {
      local: { async get() { return { options: structuredClone(storedOptions) }; } },
      onChanged: { addListener(value) { listener = value; } },
    },
  };
  const pause = () => new Promise((done) => setTimeout(done, 10));
  async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await pause();
    if (!predicate()) throw new Error("Settings navigation did not reach its expected state");
  }
  const active = () => [...document.querySelectorAll("main > section")].filter((section) => !section.hidden);
  async function navigate(id) {
    await navigateSettingsSection(window, id);
  }
  const row = () => document.querySelector('.dict-row[data-dictionary-id="first"]');
  try {
    loadSettingsScript(window);
    await until(() => document.getElementById("engine-status").textContent.startsWith("Ready"));
    if (active().length !== 1 || !document.querySelector('.settings-nav [aria-current="page"]')) {
      return { navigation: false, draft: false, details: false };
    }
    const initial = active()[0].id === "lookup";
    const reading = document.getElementById("lookup");
    const source = document.getElementById("custom-dictionary-source");
    const beforeNavigation = requests.length;
    await navigate("custom-dictionary");
    await navigate("lookup");
    const navigation = initial && active().length === 1 && active()[0] === reading
      && source === document.getElementById("custom-dictionary-source")
      && document.querySelector('.settings-nav [aria-current="page"]').hash === "#lookup"
      && requests.length === beforeNavigation;

    const input = document.getElementById("opt-max-results");
    input.value = "64";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => pendingSave !== undefined);
    const beforeLeaving = requests.length;
    await navigate("dictionaries");
    pendingSave({ ok: false, conflict: true, error: "Settings changed in another page.", options: storedOptions });
    await until(() => document.getElementById("options-status").textContent.includes("Could not save"));
    const mirror = document.getElementById("nav-status-lookup");
    const failureVisible = mirror.textContent.startsWith("Reading: Could not save")
      && mirror.classList.contains("is-error") && !mirror.closest("[hidden]");
    await navigate("lookup");
    const draft = input === document.getElementById("opt-max-results") && input.value === "64"
      && !document.getElementById("options-conflict-actions").hidden && requests.length === beforeLeaving
      && failureVisible && mirror.textContent === "";

    await navigate("dictionaries");
    const disclosure = row().querySelector(".dict-details");
    if (!disclosure) return { navigation, draft, details: false };
    disclosure.open = true;
    row().querySelector(".dict-details-toggle").focus();
    state = { ...state, revision: 2, dictionaries: state.dictionaries.map((entry) => ({ ...entry, favorite: true })) };
    listener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
    const focusKept = row().querySelector(".dict-details").open
      && document.activeElement === row().querySelector(".dict-details-toggle");
    const firstRow = row();
    const secondRow = document.querySelector('.dict-row[data-dictionary-id="second"]');
    const selectVisible = document.getElementById("dict-select-visible");
    const beforeFiltering = requests.length;
    selectVisible.click();
    const selectionKeptRows = row() === firstRow
      && document.querySelector('.dict-row[data-dictionary-id="second"]') === secondRow
      && firstRow.querySelector(".dict-selected").checked
      && secondRow.querySelector(".dict-selected").checked;
    selectVisible.click();
    const deselectionKeptRows = row() === firstRow
      && !firstRow.querySelector(".dict-selected").checked
      && !secondRow.querySelector(".dict-selected").checked;
    const search = document.getElementById("dict-search");
    search.focus();
    secondRow.classList.add("is-drop-target");
    let filteringKeptRows = true;
    for (const value of ["Second", ""]) {
      search.value = value;
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
      filteringKeptRows &&= document.querySelector('.dict-row[data-dictionary-id="second"]') === secondRow;
    }
    let details = focusKept && row().querySelector(".dict-details").open
      && !document.querySelector('.dict-row[data-dictionary-id="second"] .dict-details').open
      && document.activeElement === search && selectionKeptRows && deselectionKeptRows
      && filteringKeptRows && !secondRow.classList.contains("is-drop-target")
      && requests.length === beforeFiltering;
    for (const action of ["search", "select-visible"]) {
      row().querySelector(".dict-display-name").focus();
      const oldRow = row();
      const label = `New name before ${action}`;
      state = { ...state, revision: state.revision + 1,
        dictionaries: state.dictionaries.map((entry) => entry.id === "first" ? { ...entry, displayName: label } : entry) };
      listener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
      const deferred = row() === oldRow && row().querySelector(".dict-title").textContent !== label;
      if (action === "search") search.dispatchEvent(new window.Event("input", { bubbles: true }));
      else selectVisible.click();
      details &&= deferred && row() !== oldRow && row().querySelector(".dict-title").textContent === label;
    }
    await navigate("lookup");
    document.getElementById("options-use-saved").click();
    input.value = "96";
    const beforeSave = requests.length;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => requests.length > beforeSave);
    await navigate("dictionaries");
    pendingSave({ ok: true, options: { ...storedOptions, revision: 2, maxResults: 96 } });
    await until(() => document.getElementById("options-status").textContent === "Saved.");
    const unseenCompletion = mirror.textContent === "Reading: Saved.";
    await navigate("lookup");
    await navigate("dictionaries");
    return { navigation, draft: draft && unseenCompletion && mirror.textContent === "", details };
  } finally {
    window.close();
  }
}

async function settingsFrequencyStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/settings.html#lookup`,
  });
  const { window } = dom;
  let listener;
  let storedOptions = { revision: 1, frequencyDictionary: "", frequencyOrder: "disabled" };
  let state = { schemaVersion: 1, revision: 1, groups: [], dictionaries: [
    genericPackage({ id: "rank", title: "Rank", frequencyCount: 3, frequencyMode: "rank-based" }),
    genericPackage({ id: "occurrence", title: "Occurrence", frequencyCount: 3, frequencyMode: "occurrence-based" }),
    genericPackage({ id: "unknown", title: "Unknown mode", frequencyCount: 3 }),
  ] };
  const writes = [];
  const emitOptions = (patch) => {
    storedOptions = { ...storedOptions, ...patch, revision: storedOptions.revision + 1 };
    listener({ options: { newValue: structuredClone(storedOptions) } }, "local");
  };
  const emitDictionaries = (patch) => {
    state = { ...state, revision: state.revision + 1,
      dictionaries: state.dictionaries.map((dictionary) => dictionary.title === "Rank" ? { ...dictionary, ...patch } : dictionary) };
    listener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  };
  window.chrome = {
    runtime: { async sendMessage(message) {
      if (message.type === "hd_state_read") return { ok: true, state: structuredClone(state) };
      if (message.type === "hd_status") return { ok: true, ready: true, loading: false, dictionaryCount: 3 };
      if (message.type !== "hd_options_write") throw new Error(`Unexpected frequency Settings request ${message.type}`);
      writes.push(structuredClone(message));
      if (message.baseRevision !== storedOptions.revision) {
        return { ok: false, conflict: true, error: "Settings changed in another page.", options: structuredClone(storedOptions) };
      }
      emitOptions(message.options);
      return { ok: true, options: structuredClone(storedOptions) };
    } },
    storage: {
      local: { async get() { return { options: structuredClone(storedOptions) }; } },
      onChanged: { addListener(value) { listener = value; } },
    },
  };
  const field = (name) => window.document.getElementById(`opt-frequency-${name}`);
  const status = () => window.document.getElementById("options-status").textContent;
  async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
    if (!predicate()) throw new Error("Frequency Settings did not reach its expected state");
  }
  async function edit(name, value) {
    const count = writes.length;
    field(name).value = value;
    field(name).dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => writes.length === count + 1 && status() === "Saved.");
    return writes.at(-1).options;
  }
  try {
    loadSettingsScript(window);
    await until(() => window.document.getElementById("engine-status").textContent.startsWith("Ready"));
    const imageSource = window.document.getElementById("opt-image-source");
    const imageSourceDefault = imageSource?.value === "" && !imageSource.disabled && writes.length === 0;
    const auto = field("auto");
    if (!auto) return { explicit: false, availability: false, draft: false, error: "Auto direction is missing" };
    const passive = storedOptions.frequencyOrder === "disabled" && field("order").value === "disabled"
      && auto.disabled && writes.length === 0 && auto.getAttribute("aria-label")?.includes(auto.textContent.trim());
    const rank = await edit("dictionary", "Rank");
    const hint = window.document.getElementById("frequency-order-hint");
    const rankHint = hint.firstChild;
    await edit("order", "descending");
    const beforeMetadata = writes.length;
    emitDictionaries({ displayName: "Rank alias" });
    const manualKept = field("order").value === "descending" && writes.length === beforeMetadata
      && hint.firstChild === rankHint;
    auto.click();
    await until(() => writes.length === beforeMetadata + 1 && status() === "Saved.");
    const autoOrder = writes.at(-1).options.frequencyOrder;
    const occurrence = await edit("dictionary", "Occurrence");
    const occurrenceHint = hint.textContent.startsWith("Occurrence-based:");
    await edit("dictionary", "Unknown mode");
    const unknown = storedOptions.frequencyOrder;
    const any = await edit("dictionary", "");
    const explicit = passive && manualKept && occurrenceHint && autoOrder === "ascending"
      && rank.frequencyDictionary === "Rank" && rank.frequencyOrder === "ascending"
      && occurrence.frequencyDictionary === "Occurrence" && occurrence.frequencyOrder === "descending"
      && unknown === "descending" && any.frequencyDictionary === "" && any.frequencyOrder === "auto";

    const chooser = field("dictionary");
    chooser.focus();
    chooser.value = "Rank";
    chooser.dispatchEvent(new window.Event("input", { bubbles: true }));
    const beforeUnavailableChoice = writes.length;
    emitDictionaries({ frequencyCount: 0 });
    chooser.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 180));
    const unavailableChoiceRefused = writes.length === beforeUnavailableChoice
      && chooser.value === "" && storedOptions.frequencyDictionary === "";
    chooser.blur();
    emitOptions({ frequencyDictionary: "Rank", frequencyOrder: "descending" });
    emitDictionaries({ frequencyCount: 0 });
    const manual = [...field("order").options].filter(({ value }) => ["ascending", "descending"].includes(value));
    const global = [...field("order").options].filter(({ value }) => ["auto", "disabled"].includes(value));
    const availability = unavailableChoiceRefused && auto.disabled
      && manual.every(({ disabled }) => disabled) && global.every(({ disabled }) => !disabled)
      && field("dictionary").value === "Rank" && field("order").value === "descending";
    emitDictionaries({ frequencyCount: 3 });
    const baseRevision = storedOptions.revision;
    const select = field("dictionary");
    select.focus();
    select.value = "Occurrence";
    select.dispatchEvent(new window.Event("input", { bubbles: true }));
    emitOptions({ frequencyDictionary: "Unknown mode", frequencyOrder: "ascending" });
    const nativeDraftKept = select.value === "Occurrence";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => status().includes("Could not save"));
    const conflict = writes.at(-1);
    select.blur();
    window.document.getElementById("options-use-saved").click();
    const draft = nativeDraftKept && conflict.baseRevision === baseRevision
      && conflict.options.frequencyDictionary === "Occurrence" && conflict.options.frequencyOrder === "descending"
      && field("dictionary").value === "Unknown mode" && field("order").value === "ascending";
    const summaryToggle = window.document.getElementById("opt-compact-summary");
    const snippets = window.document.getElementById("opt-summary-count");
    const preferred = window.document.getElementById("opt-summary-dictionary");
    if (!summaryToggle || !snippets || !preferred) return { explicit, availability, draft, writes, summary: false };
    const summaryDefault = !summaryToggle.checked && snippets.value === "3" && snippets.disabled
      && preferred.value === "" && preferred.disabled;
    async function editControl(control, value) {
      const before = writes.length;
      if (control === summaryToggle) control.checked = value;
      else control.value = value;
      control.dispatchEvent(new window.Event("change", { bubbles: true }));
      await until(() => writes.length === before + 1 && status() === "Saved.");
    }
    await editControl(summaryToggle, true);
    await editControl(snippets, "6");
    await editControl(preferred, "Rank");
    const beforePresentation = writes.length;
    preferred.focus();
    const choice = preferred.selectedOptions[0];
    emitDictionaries({ enabled: false, displayName: "Dormant source" });
    const focusedChoice = preferred.selectedOptions[0] === choice && preferred.value === "Rank";
    preferred.blur();
    const disabledKept = preferred.value === "Rank" && preferred.selectedOptions[0].textContent.includes("Dormant source")
      && !preferred.selectedOptions[0].disabled && writes.length === beforePresentation;
    emitDictionaries({ termCount: 0, frequencyCount: 3 });
    const unavailableKept = preferred.value === "Rank" && preferred.selectedOptions[0].textContent.includes("unavailable")
      && !preferred.selectedOptions[0].disabled && writes.length === beforePresentation;
    await editControl(summaryToggle, false);
    const offKept = snippets.disabled && preferred.disabled && snippets.value === "6" && preferred.value === "Rank"
      && JSON.stringify(writes.at(-1).options) === JSON.stringify({ showCompactDefinitionSummary: false });
    await editControl(summaryToggle, true);
    preferred.focus();
    preferred.value = "Occurrence";
    preferred.dispatchEvent(new window.Event("input", { bubbles: true }));
    const summaryRevision = storedOptions.revision;
    emitOptions({ compactDefinitionSummaryDictionary: "Unknown mode", showCompactDefinitionSummary: false });
    const nativeSummaryDraft = preferred.value === "Occurrence" && !preferred.disabled;
    preferred.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => status().includes("Could not save"));
    const summaryConflict = writes.at(-1).baseRevision === summaryRevision
      && writes.at(-1).options.compactDefinitionSummaryDictionary === "Occurrence";
    preferred.blur();
    window.document.getElementById("options-use-saved").click();
    const disabledAfterBlur = preferred.disabled;
    await editControl(summaryToggle, true);
    snippets.focus();
    snippets.value = "4";
    snippets.dispatchEvent(new window.Event("input", { bubbles: true }));
    const countRevision = storedOptions.revision;
    emitOptions({ showCompactDefinitionSummary: false });
    const countDraft = snippets.value === "4" && !snippets.disabled;
    snippets.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => status().includes("Could not save"));
    const countConflict = writes.at(-1).baseRevision === countRevision && writes.at(-1).options.compactDefinitionSummaryCount === 4;
    snippets.blur();
    window.document.getElementById("options-use-saved").click();
    const summary = summaryDefault && focusedChoice && disabledKept && unavailableKept && offKept
      && nativeSummaryDraft && summaryConflict && disabledAfterBlur && countDraft && countConflict
      && snippets.disabled && preferred.value === "Unknown mode" && snippets.value === "6";
    let imageSources = false;
    if (imageSource) {
      const supplier = { kind: "dictionary", title: "Pictures:日本語" };
      const group = { kind: "tabGroup", id: "pictures:stable" };
      const emitImageState = (patch) => {
        state = { ...state, ...patch, revision: state.revision + 1 };
        listener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
      };
      emitImageState({ dictionaries: [...state.dictionaries,
        genericPackage({ id: "pictures", title: supplier.title, termCount: 0, kanjiCount: 1, mediaCount: 2 }),
      ], groups: [{ id: group.id, name: "Picture group", dictionaryIds: ["pictures"] }] });
      await editControl(imageSource, JSON.stringify(supplier));
      const dictionarySaved = JSON.stringify(writes.at(-1).options) === JSON.stringify({ popupImageSource: supplier });
      const beforeNames = writes.length;
      imageSource.focus();
      const focusedOption = imageSource.selectedOptions[0];
      emitImageState({ dictionaries: state.dictionaries.map(dictionary => dictionary.id === "pictures"
        ? { ...dictionary, displayName: "Picture book", enabled: false } : dictionary),
        groups: [{ ...state.groups[0], name: "Renamed pictures" }],
      });
      const nativeImageDraft = imageSource.selectedOptions[0] === focusedOption
        && imageSource.value === JSON.stringify(supplier);
      imageSource.blur();
      const disabledImageKept = imageSource.value === JSON.stringify(supplier)
        && imageSource.selectedOptions[0].textContent.includes("Picture book")
        && imageSource.selectedOptions[0].textContent.includes("disabled") && writes.length === beforeNames;
      await editControl(imageSource, JSON.stringify(group));
      const groupSaved = JSON.stringify(writes.at(-1).options) === JSON.stringify({ popupImageSource: group })
        && imageSource.selectedOptions[0].textContent.includes("Renamed pictures");
      const beforeRemoval = writes.length;
      emitImageState({ dictionaries: state.dictionaries.filter(dictionary => dictionary.id !== "pictures"), groups: [] });
      const missingGroupKept = imageSource.value === JSON.stringify(group)
        && imageSource.selectedOptions[0].textContent.includes("unavailable") && writes.length === beforeRemoval;
      imageSource.focus();
      const desiredSource = { kind: "dictionary", title: "Rank" };
      imageSource.value = JSON.stringify(desiredSource);
      imageSource.dispatchEvent(new window.Event("input", { bubbles: true }));
      const imageRevision = storedOptions.revision;
      emitOptions({ popupImageSource: null, hoverEnabled: false });
      const imageDraftKept = imageSource.value === JSON.stringify(desiredSource) && !imageSource.disabled;
      imageSource.dispatchEvent(new window.Event("change", { bubbles: true }));
      await until(() => status().includes("Could not save"));
      const imageConflict = writes.at(-1).baseRevision === imageRevision
        && JSON.stringify(writes.at(-1).options.popupImageSource) === JSON.stringify(desiredSource);
      imageSource.blur();
      window.document.getElementById("options-use-saved").click();
      imageSources = imageSourceDefault && dictionarySaved && nativeImageDraft && disabledImageKept
        && groupSaved && missingGroupKept && imageDraftKept && imageConflict
        && imageSource.value === "" && !imageSource.disabled;
    }
    return { explicit, availability, draft, writes, summary, imageSources,
      summaryDetails: { summaryDefault, focusedChoice, disabledKept, unavailableKept, offKept, nativeSummaryDraft,
        summaryConflict, disabledAfterBlur, countDraft, countConflict } };
  } finally {
    window.close();
  }
}

async function settingsAutosaveStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html#lookup`,
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
    url: `${EXTENSION_ORIGIN}/settings.html#add-dictionaries`,
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
    url: `${EXTENSION_ORIGIN}/settings.html#add-dictionaries`,
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
    expanded: open.getAttribute("aria-expanded"),
    readCount: customReadRequests.length,
    saveDisabled: save.disabled,
    unseenCompletion: window.document.getElementById("nav-status-custom-dictionary").textContent
      === "Personal dictionary: Loaded source revision 6.",
  };
  await navigateSettingsSection(window, "custom-dictionary");
  await navigateSettingsSection(window, "dictionaries");
  result.eventBeforeReadReply.completionClearedAfterVisit =
    window.document.getElementById("nav-status-custom-dictionary").textContent === "";

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
  await navigateSettingsSection(window, "dictionaries");
  window.document.getElementById("dict-select-visible")?.click();
  window.document.getElementById("dict-bulk-disable")?.click();
  await waitFor(() => stateRequests.length === 1
    && window.document.getElementById("dict-bulk-favorite")?.disabled === false);
  result.bulkState = stateRequests[0]?.dictionaries?.map(({ id, enabled }) => ({ id, enabled }));
  window.document.getElementById("dict-bulk-favorite")?.click();
  await waitFor(() => stateRequests.length === 2);
  result.favoriteState = stateRequests[1]?.dictionaries?.map(({ id, favorite }) => ({ id, favorite }));

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
    dictionaries: [genericPackage({ frequencyMode: "rank-based" })],
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

  displayName.closest("details").querySelector("summary").click();
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

  rowFor(ids.gamma).querySelector(".dict-details-toggle").click();
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
  await navigateSettingsSection(window, "dictionary-groups");
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
  const outsideGroupControl = window.document.querySelector('.settings-nav a[href="#lookup"]');
  outsideGroupControl.focus();
  await waitForRequestCount(4);
  const externalFocusPreserved = window.document.activeElement === outsideGroupControl;

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
  window.eval(readFileSync(resolve(EXTENSION, "render/popup.js"), "utf8"));
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
      rootLevel.activeCandidate = candidate;
      rootLevel.activeHighlightText = "";
      rootLevel.activeTermRender = { candidate, dictionaries, generation: 0, matchedText: "食べる", renderOptions: {}, results: [] };
      currentGeneration = 0;
      styleGeneration = 0;
      rootLevel.popup = nextPopup;
      rootLevel.view = nextView;
      highlighter = nextHighlighter;
      rootLevel.highlighter = nextHighlighter;
    },
    restore() {
      return restoreTermRender(rootLevel.activeTermRender, { character: "食", index: 0 }, rootLevel);
    },
    showKanji,
  };
  start();
}());`);
  if (instrumented === source) {
    return ["content.js instrumentation marker was not found"];
  }
  window.eval(readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "dictionary-group-state.js"), "utf8"));
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
      hideImagePreview() {},
      updateDictionaryPresentation() {},
      flushDictionaryPresentation() {},
      renderKanji(value) { renders.push(value); },
      renderResults(value) { renders.push(value); },
      setToolbarPosition() {},
    },
    { apply() {}, clear() {}, clearAll() {}, scope() { return { apply() {}, clear() {} }; } },
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
    const popupRecords = new Map();
    let stylesGeneration = 2;
    let holdStyles = false;
    const appliedStyles = [];
    const pending = [];
    const sent = [];
    const renders = [];

    function createView(callbacks) {
      const record = {
        callbacks, editing: false, closeNext: false, closeCalls: 0,
        clearCount: 0, previewDismissals: 0, layoutSchedules: 0, renders: [],
        presentations: [], presentationFlushes: 0,
      };
      function stopEditing() {
        if (!record.editing) return;
        record.editing = false;
        callbacks.onNoteEditingChange(false);
      }
      function recordRender(render) {
        if (render.context?.preserveViewControls !== true) stopEditing();
        record.renders.push(render);
        renders.push(render);
      }
      const view = {
        updateDictionaryPresentation(context) { record.presentations.push(context); },
        flushDictionaryPresentation() { record.presentationFlushes += 1; },
        hideImagePreview() { record.previewDismissals += 1; },
        clear() {
          record.clearCount += 1;
          const wasEditing = record.editing;
          stopEditing();
          if (wasEditing) callbacks.positionPopup();
        },
        closeNoteForm() {
          record.closeCalls += 1;
          if (!record.closeNext) return false;
          record.closeNext = false;
          stopEditing();
          return true;
        },
        destroy() { record.layoutView?.destroy(); },
        scheduleMasonry() {
          record.layoutSchedules += 1;
          record.layoutView?.scheduleMasonry();
        },
        renderKanji(value, candidate, context) {
          recordRender({ kind: "kanji", value, candidate, context });
        },
        renderNotice(value, candidate) {
          recordRender({ kind: "notice", value, candidate, context: {} });
        },
        renderResults(results, candidate, context) {
          recordRender({ kind: "terms", results, candidate, context });
        },
        setToolbarPosition() {},
      };
      popupRecords.set(callbacks.popup, record);
      return view;
    }
    window.HDGlossary = {
      appendExpressionRuby() {},
      appendTextOnlyGlossary() {},
      applyDictionaryStyles(_document, _shadow, generation, styles) {
        appliedStyles.push({ generation, styles });
        return [];
      },
      parseTagList() { return []; },
    };
    window.eval(readFileSync(resolve(EXTENSION, "render/popup.js"), "utf8"));
    const createLayoutView = window.HDPopup.createPopupView;
    window.HDPopup = {
      ...window.HDPopup,
      createPopupView: createView,
      createSourceHighlighter() {
        return { apply() {}, clear() {}, clearAll() {}, scope() { return { apply() {}, clear() {} }; } };
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
          if (request.type === "hd_styles" && !holdStyles) {
            callback({
              generation: stylesGeneration,
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
      return rootLevel.popup;
    },
    popupAt(depth = 0) { return levels[depth]?.popup; },
    hideTimerPending() { return hideTimer !== null; },
    viewRequest(depth = 0) { return levels[depth]?.currentViewRequest; },
    resolveCandidate,
    setScanCandidate(candidate) { resolveCandidate = () => candidate; },
    onMouseMove,
    onMouseDown,
    onMouseOut,
    onWindowBlur,
    onScroll,
    onInternalLink,
    pointInsidePopup,
    onKeyDown,
    runLookup,
    scanPointer,
    scheduleHide,
    showKanji,
    teardown,
    snapshot(depth = 0) {
      const level = levels[depth];
      return {
        currentGeneration,
        styleGeneration,
        dictionaryStateRevision,
        noteEditing: level?.noteEditing === true,
        activeHighlightText: level?.activeHighlightText ?? "",
        dictionaries: dictionaries.map((dictionary) => ({ ...dictionary })),
        popupHidden: !level?.popup || level.popup.hidden === true,
      };
    },
  };
  start();
}());`);
    if (instrumented === source) {
      dom.window.close();
      throw new Error("content.js Note instrumentation marker was not found");
    }
    window.eval(readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "dictionary-group-state.js"), "utf8"));
    window.eval(instrumented);
    const driver = window.__hachidoriContentNoteSmoke;
    const popup = driver.install();
    const popupRecord = (depth = 0) => popupRecords.get(driver.popupAt(depth));
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

    function emitState(value, nextOptions) {
      storageListener?.({ dictionaryState: { newValue: value },
        ...(nextOptions ? { options: { newValue: nextOptions } } : {}),
      }, "local");
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

    async function initialLookup(generation = 2) {
      const operation = driver.runLookup(candidate);
      const request = take("hd_lookup");
      reply(request, { generation, dictionaryCount: 1, results: [term(candidate.query)] });
      await operation;
      return request;
    }

    return {
      anchor,
      appliedStyles,
      candidate,
      createLayoutView(callbacks) {
        const view = createLayoutView(callbacks);
        popupRecords.get(callbacks.popup).layoutView = view;
        return view;
      },
      callbacks: (depth = 0) => popupRecord(depth).callbacks,
      close() { dom.window.close(); },
      driver,
      edit(value, depth = 0) {
        const record = popupRecord(depth);
        record.editing = value === true;
        record.callbacks.onNoteEditingChange(record.editing);
      },
      emitOptions,
      emitState,
      initialLookup,
      internalLink(link, depth = 0) {
        const record = popupRecord(depth);
        const anchor = window.document.createElement("a");
        anchor.href = "#";
        anchor.textContent = link.query;
        record.callbacks.popup.appendChild(anchor);
        return record.renders.at(-1).context.onInternalLink({ ...link, anchor });
      },
      pending,
      popup,
      render: (depth = 0) => popupRecord(depth)?.renders.at(-1),
      presentations: (depth = 0) => popupRecord(depth)?.presentations,
      presentationFlushes: (depth = 0) => popupRecord(depth)?.presentationFlushes,
      renders,
      reply,
      requestPayload,
      sent,
      settle,
      state,
      stats(depth = 0) {
        const { clearCount, closeCalls, previewDismissals, layoutSchedules } = popupRecord(depth);
        return { clearCount, closeCalls, previewDismissals, layoutSchedules };
      },
      take,
      term,
      setCloseNext(value, depth = 0) { popupRecord(depth).closeNext = value === true; },
      setStylesGeneration(value) { stylesGeneration = value; },
      setHoldStyles() { holdStyles = true; },
      installMediaClock() {
        const timers = new Map();
        const originalSetTimeout = window.setTimeout.bind(window);
        const originalClearTimeout = window.clearTimeout.bind(window);
        let nextTimerId = -1;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay !== 4000) return originalSetTimeout(callback, delay, ...args);
          const id = nextTimerId--;
          timers.set(id, callback);
          return id;
        };
        window.clearTimeout = (id) => {
          if (!timers.delete(id)) originalClearTimeout(id);
        };
        return {
          size: () => timers.size,
          expireFirst() {
            const first = timers.entries().next().value;
            if (!first) return false;
            timers.delete(first[0]);
            first[1]();
            return true;
          },
        };
      },
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
    const internal = harness.internalLink({
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
    harness.render(1).context.onDictionaryTabSelected({ dictionary: "Projected" });
    harness.edit(true, 1);
    harness.emitOptions({
      frequencyDictionary: "Different",
      frequencyOrder: "ascending",
      hoverDelayMs: 0,
      kanjiClickDictionary: "",
      maxResults: 2,
      modifier: "none",
      scanLength: 2,
    });
    const append = harness.callbacks(1).onAddCustomEntry({
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
    const snapshot = harness.driver.snapshot(1);
    const result = {
      displayName: snapshot.dictionaries[0]?.displayName,
      popupHidden: snapshot.popupHidden,
      request,
      selectedDictionaryTab: harness.render(1).context.selectedDictionaryTab,
      stateRevision: snapshot.dictionaryStateRevision,
    };
    harness.close();
    return result;
  }

  async function inheritedTabsCase() {
    const outcomes = [];
    for (const kind of ["term", "kanji"]) {
      for (const selection of [{ dictionary: "Generic" }, { groupId: "study" }, { favourites: true }]) {
        const harness = await createHarness({ title: "Generic", kind });
        await harness.initialLookup();
        const dictionaries = harness.driver.snapshot().dictionaries;
        const memberId = dictionaries[0].id;
        harness.emitState({ revision: 2, dictionaries,
          groups: [{ id: "study", name: "Study", dictionaryIds: [memberId, "missing", memberId] }] });
        harness.render().context.onDictionaryTabSelected(selection);
        const parent = harness.driver.viewRequest();
        const operation = harness.internalLink({ query: "child", primaryReading: "reading" });
        const pending = harness.take("hd_lookup");
        harness.emitState({ revision: 3, dictionaries,
          groups: [{ id: "study", name: "Latest group", dictionaryIds: [memberId] }] });
        harness.emitState({ revision: 2, dictionaries, groups: [] });
        harness.reply(pending, { dictionaryCount: 1, results: [harness.term("child")] });
        await operation;
        const child = harness.driver.viewRequest(1);
        const childContext = harness.render(1).context;
        const sameSelection = (value) => JSON.stringify(value) === JSON.stringify(selection);
        const inherited = sameSelection(childContext.selectedDictionaryTab)
          && child.selectedDictionaryTab !== parent.selectedDictionaryTab
          && JSON.stringify(childContext.dictionaryTabGroups) === JSON.stringify([
            { id: "study", name: "Latest group", dictionaries: ["Generic"] },
          ]);
        const clicked = harness.callbacks(1).onKanjiClick("食");
        const request = harness.take(kind === "term" ? "hd_lookup_dictionary" : "hd_kanji");
        harness.reply(request, kind === "term"
          ? { dictionaryCount: 1, results: [harness.term("食")] }
          : { kanji: { character: "食", entries: [{ dictionary: "Generic" }] } });
        await clicked;
        const clickedRequest = harness.driver.viewRequest(1);
        const clickedContext = harness.render(1).context;
        const copied = sameSelection(clickedContext.selectedDictionaryTab)
          && clickedRequest.selectedDictionaryTab !== child.selectedDictionaryTab;
        clickedContext.onDictionaryTabSelected?.(null);
        const independent = clickedRequest.selectedDictionaryTab === null
          && sameSelection(child.selectedDictionaryTab) && sameSelection(parent.selectedDictionaryTab);
        const beforeBack = harness.sent.length;
        await clickedContext.onBack();
        outcomes.push(inherited && copied && independent && harness.sent.length === beforeBack
          && harness.driver.viewRequest(1) === child && sameSelection(harness.render(1).context.selectedDictionaryTab));
        harness.close();
      }
    }
    return { "linked and clicked-kanji requests copy tab context and retain exact parent and Back selections": outcomes.every(Boolean) };
  }

  async function nestedLevelsCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    const parent = harness.driver.viewRequest();
    const parentContext = harness.render().context;
    const open = async (query, depth = 0) => {
      const operation = harness.internalLink({ query, primaryReading: "reading" }, depth);
      const request = harness.take("hd_lookup");
      if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term(query)] });
      await operation;
      return request;
    };
    await open("child");
    const child = harness.driver.viewRequest(1);
    const childAnchor = child.candidate.anchor;
    const childPopup = harness.driver.popupAt(1);
    let ancestorLayouts = 0;
    const anchorRect = harness.anchor.getBoundingClientRect.bind(harness.anchor);
    harness.anchor.getBoundingClientRect = () => { ancestorLayouts += 1; return anchorRect(); };
    harness.callbacks(1).positionPopup();
    harness.popup.dispatchEvent(new harness.anchor.ownerDocument.defaultView.Event("scroll"));
    const layoutStartsAtOwner = ancestorLayouts === 0;
    const childRect = { left: Number.parseFloat(childPopup.style.left), top: Number.parseFloat(childPopup.style.top),
      width: Number.parseFloat(childPopup.style.width), height: Number.parseFloat(childPopup.style.height) };
    const positioned = Object.values(childRect).every(Number.isFinite)
      && childRect.left >= 6 && childRect.top >= 6
      && childRect.left + childRect.width <= harness.anchor.ownerDocument.defaultView.innerWidth - 6
      && childRect.top + childRect.height <= harness.anchor.ownerDocument.defaultView.innerHeight - 6;
    const childContext = harness.render(1).context;
    const count = harness.sent.length;
    await parentContext.onInternalLink({ query: "child", primaryReading: "reading", anchor: childAnchor });
    const deduped = harness.sent.length === count && harness.driver.viewRequest(1) === child;
    await open("grandchild", 1);
    const grandchildContext = harness.render(2).context;
    await open("great-grandchild", 2);
    harness.edit(true, 3);
    let pruneThrew = false;
    try { harness.callbacks(1).onBeforeResultsRendered(); } catch { pruneThrew = true; }
    const prunedOnlyBelow = !harness.driver.popupAt(2) && harness.driver.viewRequest(1) === child
      && parentContext.isCurrentRequest() && childContext.isCurrentRequest() && !grandchildContext.isCurrentRequest() && !pruneThrew;
    const clicked = harness.callbacks(1).onKanjiClick("食");
    const kanjiRequest = harness.take("hd_lookup_dictionary");
    harness.reply(kanjiRequest, { dictionaryCount: 1, results: [harness.term("食")] });
    await clicked;
    const relink = parentContext.onInternalLink({ query: "child", primaryReading: "reading", anchor: childAnchor });
    const relinkRequest = harness.take("hd_lookup");
    if (relinkRequest) harness.reply(relinkRequest, { dictionaryCount: 1, results: [harness.term("child")] });
    await relink;
    const reactivated = relinkRequest?.request.text === "child" && harness.driver.viewRequest(1)?.kind === "term";
    const currentChild = harness.driver.viewRequest(1);
    const clickedAgain = harness.callbacks(1).onKanjiClick("食");
    harness.reply(harness.take("hd_lookup_dictionary"), { dictionaryCount: 1, results: [harness.term("食")] });
    await clickedAgain;
    await harness.render(1).context.onBack();
    const childBack = harness.driver.viewRequest(1) === currentChild && harness.driver.viewRequest() === parent;
    harness.driver.popupAt(1).tabIndex = -1;
    harness.driver.popupAt(1).focus();
    await harness.render(1).context.onBack();
    const returned = !harness.driver.popupAt(1) && harness.driver.viewRequest() === parent
      && childAnchor.getRootNode().activeElement === childAnchor;
    ancestorLayouts = 0;
    harness.popup.dispatchEvent(new harness.anchor.ownerDocument.defaultView.Event("scroll"));
    const rootOnlyScroll = ancestorLayouts === 0;
    harness.emitOptions({ popupNestingMaxDepth: 0 });
    const disabled = await open("disabled") === null && !harness.driver.popupAt(1);
    harness.emitOptions({ popupNestingMaxDepth: 2 });
    await open("one");
    await open("two", 1);
    const limited = await open("three", 2) === null && !harness.driver.popupAt(3);
    harness.emitOptions({ popupNestingMaxDepth: 1 });
    const lowered = !harness.driver.popupAt(2) && !harness.driver.snapshot(1).popupHidden
      && harness.driver.viewRequest() === parent;
    const window = harness.anchor.ownerDocument.defaultView;
    window.innerWidth = 12;
    harness.callbacks(1).positionPopup();
    const shrunk = !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden;
    const noViewport = await open("no viewport") === null && !harness.driver.popupAt(1);
    harness.close();
    return {
      "linked levels preserve independent Back and render owners, deduplicate, and prune only descendants": deduped && prunedOnlyBelow && reactivated && childBack && returned,
      "child popup depth is live and child geometry is clamped to the viewport": positioned && layoutStartsAtOwner && rootOnlyScroll
        && disabled && limited && lowered && shrunk && noViewport,
    };
  }

  async function livePresentationCase() {
    const harness = await createHarness();
    const checks = [];
    const name = "presentation-only state adopts newest labels without invalidating requests or pending child anchors";
    try {
      await harness.initialLookup();
      const request = harness.driver.viewRequest();
      const render = harness.render();
      const snapshot = harness.driver.snapshot();
      const presentation = { schemaVersion: 1, revision: 2,
        dictionaries: snapshot.dictionaries.map(dictionary => ({ ...dictionary, displayName: "Live alias", favorite: false })),
        groups: [{ id: "live", name: "Live group", dictionaryIds: [snapshot.dictionaries[0].id] }],
      };
      const sent = harness.sent.length;
      harness.emitState(presentation);
      checks.push(harness.render() === render && harness.driver.viewRequest() === request && render.context.isCurrentRequest()
        && !harness.driver.snapshot().popupHidden && harness.sent.length === sent
        && harness.presentations().at(-1)?.dictionaryPresentation[0].displayName === "Live alias"
        && harness.presentations().at(-1)?.dictionaryTabGroups[0].dictionaries[0] === "Generic");
      harness.emitState(presentation);
      harness.emitState({ ...presentation, revision: 1 });
      checks.push(harness.presentations().length === 1);
      const child = harness.internalLink({ query: "pending child" });
      const pending = harness.take("hd_lookup");
      if (!pending) return { [name]: false };
      const anchor = harness.popup.lastElementChild;
      harness.emitState({ ...presentation, revision: 3, groups: [] });
      checks.push(harness.driver.popupAt(1)?.hidden === true && anchor.isConnected && render.context.isCurrentRequest()
        && harness.callbacks().canProjectDictionaryPresentation?.() === false);
      harness.reply(pending, { dictionaryCount: 1, results: [harness.term("pending child")] });
      await child;
      checks.push(harness.render(1).context.dictionaryTabGroups.length === 0 && !harness.driver.snapshot(1).popupHidden);
      const flushes = harness.presentationFlushes();
      harness.render(1).context.onBack();
      checks.push(!harness.driver.popupAt(1) && harness.callbacks().canProjectDictionaryPresentation?.() === true
        && harness.presentationFlushes() > flushes);
      const resizeChild = harness.internalLink({ query: "resize child" });
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("resize child")] });
      await resizeChild;
      harness.emitState({ ...presentation, revision: 4 });
      const beforeResizeFlush = harness.presentationFlushes();
      Object.defineProperty(harness.popup.ownerDocument.defaultView, "innerWidth", { configurable: true, value: 10 });
      harness.callbacks().positionPopup();
      await harness.settle();
      checks.push(!harness.driver.popupAt(1) && harness.presentationFlushes() > beforeResizeFlush);
      harness.edit(true);
      harness.emitState({ ...presentation, revision: 5 });
      checks.push(harness.callbacks().canProjectDictionaryPresentation?.() === false && render.context.isCurrentRequest());
      harness.edit(false);
      const updates = harness.presentations().length;
      harness.emitState({ ...presentation, revision: 6, groups: [] }, { revision: 99, maxResults: 99 });
      checks.push(harness.presentations().length === updates && !render.context.isCurrentRequest());

      for (const update of ["contents", "alias", "options"]) {
        const combined = await createHarness();
        try {
          await combined.initialLookup();
          const current = combined.render().context;
          const options = { revision: 1, frequencyDictionary: "Frequency A", frequencyOrder: "descending", hoverDelayMs: 0,
            kanjiClickDictionary: { title: "Generic", kind: "term" }, maxResults: 7, scanLength: 9,
            showCompactDefinitionSummary: true };
          if (update === "options") combined.emitOptions(options);
          else combined.emitState({ schemaVersion: 1, revision: 2, groups: [],
            dictionaries: combined.driver.snapshot().dictionaries.map(dictionary => ({ ...dictionary,
              ...(update === "contents" ? { path: "/dicts/replacement/Generic", revision: "replacement" }
                : { displayName: "Combined alias" }),
            })),
          }, options);
          if (update === "contents") {
            checks.push(combined.presentations().length === 0 && !current.isCurrentRequest()
              && combined.driver.snapshot().popupHidden);
          } else {
            const presentations = combined.presentations();
            checks.push(presentations.length === 1 && current.isCurrentRequest() && !combined.driver.snapshot().popupHidden
              && presentations[0].showCompactDefinitionSummary === true
              && (update === "options" || presentations[0].dictionaryPresentation[0].displayName === "Combined alias"));
          }
        } finally { combined.driver.teardown(); combined.close(); }
      }

      for (const update of ["membership", "summary"]) {
        const detached = await createHarness();
        try {
          const installed = detached.driver.snapshot().dictionaries;
          const state = { schemaVersion: 1, revision: 2,
            dictionaries: [...installed, genericPackage({ id: "other-id", title: "Other", path: "/dicts/Other" })],
            groups: [{ id: "g", name: "Group", dictionaryIds: [installed[0].id] }],
          };
          detached.emitState(state);
          await detached.initialLookup();
          detached.render().context.onDictionaryTabSelected({ groupId: "g" });
          const operation = detached.internalLink({ query: "orphan child" });
          const result = detached.term("orphan child");
          Object.assign(result.term, { frequencies: [], pitches: [] });
          if (update === "summary") result.term.glossaries[0].glossary = JSON.stringify([
            { type: "image", path: "leading.png" }, "child definition",
          ]);
          result.term.glossaries.push({ dictionary: "Other", glossary: "other definition" });
          detached.reply(detached.take("hd_lookup"), { dictionaryCount: 2, results: [result] });
          await operation;
          const childRender = detached.render(1);
          const childPopup = detached.driver.popupAt(1);
          const callbacks = detached.callbacks(1);
          const fills = [];
          let allowed = null;
          let permissionChecks = 0;
          let summaryImages = 0;
          const view = detached.createLayoutView({ ...callbacks,
            appendTextOnlyGlossary(_document, _container, _glossary, context) { fills.push(context.dictionary); },
            appendStructuredImage() { summaryImages += 1; },
            canUpdateCompactSummary() {
              permissionChecks += 1;
              allowed = callbacks.canUpdateCompactSummary?.();
              return allowed;
            },
            canProjectDictionaryPresentation() {
              permissionChecks += 1;
              allowed = callbacks.canProjectDictionaryPresentation();
              return allowed;
            },
          });
          view.renderResults(childRender.results, childRender.candidate, childRender.context);
          const beforeFills = fills.length;
          detached.anchor.remove();
          const connectedChildSource = childRender.candidate.anchor.isConnected;
          if (update === "membership") {
            detached.emitState({ ...state, revision: 3,
              groups: [{ id: "g", name: "Group", dictionaryIds: ["other-id"] }],
            });
          } else {
            detached.emitOptions({ frequencyDictionary: "Frequency A", frequencyOrder: "descending", hoverDelayMs: 0,
              kanjiClickDictionary: { title: "Generic", kind: "term" }, maxResults: 7, scanLength: 9,
              showCompactDefinitionSummary: true });
          }
          // The content harness records this storage delivery; run it through
          // the attached real renderer and its actual content owner predicate.
          const delivered = detached.presentations(1).at(-1);
          view.updateDictionaryPresentation(delivered);
          checks.push(beforeFills === 1 && connectedChildSource && allowed === false
            && detached.driver.snapshot().popupHidden && !detached.driver.popupAt(1)
            && childPopup.hidden && fills.length === beforeFills && summaryImages === 0);
          const checked = permissionChecks;
          view.flushDictionaryPresentation();
          view.updateDictionaryPresentation(delivered);
          checks.push(permissionChecks === checked && fills.length === beforeFills);
        } finally { detached.driver.teardown(); detached.close(); }
      }

      const detachedRoot = await createHarness();
      try {
        await detachedRoot.initialLookup();
        detachedRoot.anchor.remove();
        checks.push(detachedRoot.callbacks().canProjectDictionaryPresentation() === false
          && detachedRoot.driver.snapshot().popupHidden);
      } finally { detachedRoot.driver.teardown(); detachedRoot.close(); }
      return { [name]: checks.every(Boolean) || checks };
    } finally { harness.close(); }
  }

  async function nestedResizeCase() {
    const harness = await createHarness();
    const window = harness.anchor.ownerDocument.defaultView;
    const views = [];
    const frames = new Map();
    const observers = [];
    let nextFrame = 0;
    let layouts = 0;
    let popupReads = 0;
    let rootReads = 0;
    let queueDuringLayout = false;
    const initialMasonryReads = [];
    let recordMasonryReads = true;
    const frame = () => {
      for (const [id, callback] of [...frames]) {
        if (!frames.delete(id)) continue;
        callback();
      }
    };
    try {
      await harness.initialLookup();
      for (let depth = 0; depth < 3; depth += 1) {
        const operation = harness.internalLink({ query: `level-${depth + 1}` }, depth);
        harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term(`level-${depth + 1}`)] });
        await operation;
      }
      window.innerWidth = 2400;
      window.innerHeight = 700;
      window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
      window.cancelAnimationFrame = id => frames.delete(id);
      window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {}
        disconnect() {}
      };
      const rootRect = harness.anchor.getBoundingClientRect.bind(harness.anchor);
      harness.anchor.getBoundingClientRect = () => { rootReads += 1; return rootRect(); };
      for (let depth = 0; depth < 4; depth += 1) {
        const popup = harness.driver.popupAt(depth);
        popup.getBoundingClientRect = () => {
          popupReads += 1;
          const left = Number.parseFloat(popup.style.left);
          const top = Number.parseFloat(popup.style.top);
          const width = Number.parseFloat(popup.style.width);
          const height = Number.parseFloat(popup.style.height);
          return { left, top, width, height, right: left + width, bottom: top + height };
        };
        const grid = window.document.createElement("div");
        grid.className = "gsm-hoshidicts-glossary-grid";
        grid.append(window.document.createElement("div"), window.document.createElement("div"));
        for (const card of grid.children) {
          Object.defineProperty(card, "offsetHeight", { get() {
            if (recordMasonryReads) initialMasonryReads.push({
              widths: [...grid.children].map(child => child.style.width),
              transforms: [...grid.children].map(child => child.style.transform),
            });
            return 0;
          } });
        }
        Object.defineProperty(grid, "clientWidth", { get: () => Number.parseFloat(popup.style.width) });
        popup.append(grid);
        // Real per-view resize/masonry callbacks, bound to the real content
        // owners; the request harness continues to own only lookup replies.
        views.push(harness.createLayoutView({ ...harness.callbacks(depth),
          getPopupColumns() {
            layouts += 1;
            if (depth === 0 && queueDuringLayout) {
              queueDuringLayout = false;
              views[0].scheduleMasonry();
            }
            return 2;
          } }));
      }
      window.dispatchEvent(new window.Event("resize"));
      const oneBatch = frames.size === 1 && layouts === 0;
      frame();
      recordMasonryReads = false;
      const resize = layouts === 4 && rootReads === 1 && popupReads === 4 && frames.size === 0
        && initialMasonryReads.length === 8 && initialMasonryReads.every(read =>
          read.widths.every(width => width !== "" && width === read.widths[0])
          && read.transforms.every(transform => transform === ""))
        && [0, 1, 2, 3].every(depth => {
          const popup = harness.driver.popupAt(depth);
          return Number.parseFloat(popup.style.left) >= 6
            && Number.parseFloat(popup.style.left) + Number.parseFloat(popup.style.width) <= 2394
            && popup.querySelector(".gsm-hoshidicts-glossary-grid").style.height !== "";
        });
      window.innerWidth = 500;
      window.dispatchEvent(new window.Event("resize"));
      frame();
      layouts = 0; rootReads = 0; popupReads = 0;
      observers.forEach(observer => observer.callback());
      frame();
      const observerFollowup = layouts === 4 && rootReads === 1 && popupReads === 4 && frames.size === 0
        && [0, 1, 2, 3].every(depth => {
          const popup = harness.driver.popupAt(depth);
          const card = popup.querySelector(".gsm-hoshidicts-glossary-grid").firstElementChild;
          return Number.parseFloat(popup.style.width) === 488 && Number.parseFloat(card.style.width) === 240;
        });

      // A queued root resize still places the surviving chain after a child
      // retires; a queued retired child cannot target its depth replacement.
      const childCallbacks = harness.callbacks(1);
      views[0].scheduleMasonry();
      harness.emitOptions({ popupNestingMaxDepth: 0 });
      rootReads = 0; popupReads = 0;
      frame();
      const rootSurvivesPrune = rootReads === 1 && popupReads === 0;
      childCallbacks.queueMasonry(() => { layouts += 1; });
      const retiredIgnored = frames.size === 0;
      rootReads = 0; layouts = 0;
      views[0].scheduleMasonry();
      views[0].scheduleMasonry();
      frame();
      const rootSameFrame = layouts === 1 && rootReads === 1 && frames.size === 0;

      // Work queued while a batch runs belongs to the next frame, not this
      // snapshot. The native observer-width followup is checked separately.
      layouts = 0; rootReads = 0;
      queueDuringLayout = true;
      views[0].scheduleMasonry();
      frame();
      const nextBatchQueued = layouts === 1 && rootReads === 1 && frames.size === 1;
      frame();
      const nextBatchCompleted = layouts === 2 && rootReads === 2 && frames.size === 0;

      harness.emitOptions({ popupNestingMaxDepth: 1 });
      const child = harness.internalLink({ query: "replacement" });
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("replacement")] });
      await child;
      const retiring = harness.callbacks(1);
      const retiringView = harness.createLayoutView(retiring);
      views.push(retiringView);
      retiringView.scheduleMasonry();
      const childQueued = frames.size === 1;
      harness.render(1).context.onBack();
      const retiredCancelled = frames.size === 0;
      const replacement = harness.internalLink({ query: "same depth" });
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("same depth")] });
      await replacement;
      retiring.queueMasonry(() => { layouts += 1; });
      const replacementUntouched = frames.size === 0;
      let childLayouts = 0;
      const replacementView = harness.createLayoutView({ ...harness.callbacks(1),
        getPopupColumns() { childLayouts += 1; return 2; } });
      views.push(replacementView);
      layouts = 0; rootReads = 0;
      views[0].scheduleMasonry();
      replacementView.scheduleMasonry();
      replacementView.destroy();
      frame();
      const liveDestroyPreservesRoot = childLayouts === 0 && layouts === 1
        && rootReads === 1 && frames.size === 0;
      const soleView = harness.createLayoutView(harness.callbacks(1));
      views.push(soleView);
      soleView.scheduleMasonry();
      soleView.destroy();
      const liveDestroyCancelsFrame = frames.size === 0;
      views[0].scheduleMasonry();
      harness.driver.onKeyDown({ key: "Escape", repeat: false, stopPropagation() {} });
      // First Escape closes the unfocused child; the next dismisses the root.
      harness.driver.onKeyDown({ key: "Escape", repeat: false, stopPropagation() {} });
      const hiddenCancelled = frames.size === 0;
      await harness.initialLookup();
      const next = harness.internalLink({ query: "teardown" });
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("teardown")] });
      await next;
      views[0].scheduleMasonry();
      harness.driver.teardown();
      const teardownCancelled = frames.size === 0;
      return { "viewport and observer layout place a popup chain linearly and retire queued owners":
        oneBatch && resize && observerFollowup && rootSurvivesPrune && retiredIgnored && rootSameFrame
        && nextBatchQueued && nextBatchCompleted && liveDestroyPreservesRoot && liveDestroyCancelsFrame
        && childQueued && retiredCancelled && replacementUntouched && hiddenCancelled && teardownCancelled };
    } finally {
      views.forEach(view => view.destroy());
      harness.close();
    }
  }

  async function columnPreferenceCase() {
    const harness = await createHarness();
    try {
      // Use one complete default option snapshot before starting either
      // request, so the later event changes columns alone.
      harness.emitOptions({});
      await harness.initialLookup();
      const linked = harness.internalLink({ query: "columns child" });
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("columns child")] });
      await linked;
      harness.edit(true, 1);
      const panes = [0, 1].map(depth => ({
        popup: harness.driver.popupAt(depth), request: harness.driver.viewRequest(depth),
        context: harness.render(depth).context,
      }));
      const defaultColumns = [0, 1].every(depth => harness.callbacks(depth).getPopupColumns() === 1);
      const sentBefore = harness.sent.length;
      harness.emitOptions({ popupColumns: 4 });
      harness.emitOptions({ popupColumns: 4 });
      return { "live column preferences relayout each visible owner without lookup, retirement or Note loss":
        defaultColumns && harness.sent.length === sentBefore && harness.driver.snapshot(1).noteEditing
        && panes.every(({ popup, request, context }, depth) =>
          harness.callbacks(depth).getPopupColumns() === 4 && harness.stats(depth).layoutSchedules === 1
          && harness.driver.popupAt(depth) === popup && !popup.hidden
          && harness.driver.viewRequest(depth) === request && context.isCurrentRequest()) };
    } finally { harness.close(); }
  }

  async function nestedPointerCase() {
    const harness = await createHarness();
    const window = harness.anchor.ownerDocument.defaultView;
    await harness.initialLookup();
    const child = harness.internalLink({ query: "child" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
    await child;
    harness.popup.getBoundingClientRect = () => ({ left: 10, right: 110, top: 10, bottom: 110 });
    harness.driver.popupAt(1).getBoundingClientRect = () => ({ left: 114, right: 214, top: 60, bottom: 160 });
    const corridor = harness.driver.pointInsidePopup(112, 90) && !harness.driver.pointInsidePopup(50, 150);
    const timers = new Map();
    let nextTimer = 0;
    window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
    window.clearTimeout = (id) => timers.delete(id);
    const fire = (delay) => {
      const entry = [...timers].find(([, value]) => value.delay === delay);
      if (!entry) return false;
      timers.delete(entry[0]);
      entry[1].callback();
      return true;
    };
    harness.driver.popupAt(1).dispatchEvent(new window.MouseEvent("mouseenter"));
    harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
    const originalChild = harness.driver.viewRequest(1);
    const beforeReactivation = harness.sent.length;
    await harness.render().context.onInternalLink({ query: "child", primaryReading: "", anchor: originalChild.candidate.anchor });
    fire(160);
    const reactivated = harness.driver.viewRequest(1) === originalChild && harness.sent.length === beforeReactivation;
    harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
    const pruneScheduled = fire(160);
    const parentReturn = pruneScheduled && !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden;
    const second = harness.internalLink({ query: "child again" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child again")] });
    await second;
    harness.edit(true, 1);
    harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
    fire(160);
    const draftRetained = harness.driver.snapshot(1).noteEditing && !harness.driver.snapshot(1).popupHidden;
    harness.edit(false, 1);
    harness.driver.setScanCandidate({ ...harness.candidate, query: "new page word" });
    harness.driver.onMouseMove({ target: harness.popup.getRootNode().host, clientX: 10, clientY: 10, buttons: 0 });
    harness.driver.onMouseMove({ target: harness.anchor, clientX: 900, clientY: 700, buttons: 0 });
    fire(50);
    const beforeGrace = harness.take("hd_lookup") === null;
    fire(80);
    fire(50);
    const lookup = harness.take("hd_lookup");
    if (lookup) harness.reply(lookup, { dictionaryCount: 1, results: [harness.term("new page word")] });
    await harness.settle();
    harness.close();
    return { "ancestor pointer return prunes descendants but preserves drafts and a stationary departure resumes scanning":
      corridor && reactivated && parentReturn && draftRetained && beforeGrace && lookup?.request.text === "new page word" };
  }

  async function nestedNotesCase() {
    const outcomes = [];
    for (const navigation of ["close", "navigate", "back", "lower"]) {
      const harness = await createHarness();
      await harness.initialLookup();
      const rootRequest = harness.driver.viewRequest();
      const originalContext = harness.render().context;
      const child = harness.internalLink({ query: "child" });
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
      await child;
      const source = harness.driver.viewRequest(1).candidate.anchor;
      harness.edit(true);
      harness.edit(true, 1);
      const append = harness.callbacks().onAddCustomEntry({ term: "parent", reading: "", definition: "saved" });
      const mutation = harness.take("hd_custom_append");
      harness.emitState(harness.state(2, "event first"));
      harness.reply(mutation, { state: harness.state(2, "event first") });
      await append;
      const deferred = harness.take("hd_lookup") === null && source.isConnected
        && harness.driver.snapshot().noteEditing && harness.driver.snapshot(1).noteEditing
        && !originalContext.isCurrentRequest();
      if (navigation === "navigate") {
        const clicked = harness.callbacks().onKanjiClick("食");
        harness.reply(harness.take("hd_lookup_dictionary"), { generation: 3, dictionaryCount: 1, results: [harness.term("食")] });
        await clicked;
        harness.edit(true);
        harness.edit(false);
        outcomes.push(deferred && !harness.driver.snapshot().popupHidden
          && harness.driver.viewRequest()?.kind === "kanji" && !harness.driver.popupAt(1)
          && harness.take("hd_lookup") === null);
      } else {
        harness.edit(false);
        const retained = source.isConnected && harness.driver.snapshot(1).noteEditing;
        if (navigation === "back") harness.render(1).context.onBack();
        else if (navigation === "lower") harness.emitOptions({ popupNestingMaxDepth: 0 });
        else harness.edit(false, 1);
        const refresh = harness.take("hd_lookup");
        if (refresh) harness.reply(refresh, { generation: 3, dictionaryCount: 1, results: [harness.term("parent")] });
        await harness.settle();
        outcomes.push(deferred && retained && refresh?.request.text === rootRequest.payload.text
          && !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden);
      }
      harness.close();
    }
    for (const failedRefresh of [false, true]) {
      const concurrent = await createHarness();
      await concurrent.initialLookup();
      const rootRequest = concurrent.driver.viewRequest();
      const linked = concurrent.internalLink({ query: "child", primaryReading: "reading" });
      concurrent.reply(concurrent.take("hd_lookup"), { dictionaryCount: 1, results: [concurrent.term("child")] });
      await linked;
      const childRequest = concurrent.driver.viewRequest(1);
      concurrent.edit(true);
      concurrent.edit(true, 1);
      const parentAppend = concurrent.callbacks().onAddCustomEntry({ term: "parent", reading: "", definition: "first" });
      const parentMutation = concurrent.take("hd_custom_append");
      const childAppend = concurrent.callbacks(1).onAddCustomEntry({ term: "child", reading: "reading", definition: "second" });
      const childMutation = concurrent.take("hd_custom_append");
      concurrent.emitState(concurrent.state(3, "newest"));
      concurrent.reply(childMutation, { state: concurrent.state(3, "newest") });
      await childAppend;
      const childRefresh = concurrent.take("hd_lookup");
      concurrent.reply(parentMutation, { state: concurrent.state(2, "older reply") });
      await parentAppend;
      concurrent.emitState(concurrent.state(2, "older event"));
      const retainedWhileHeld = concurrent.driver.snapshot().dictionaryStateRevision === 3
        && concurrent.driver.snapshot().dictionaries[0].displayName === "newest"
        && concurrent.driver.viewRequest() === rootRequest && concurrent.driver.viewRequest(1) === childRequest
        && childRequest.candidate.anchor.isConnected && concurrent.take("hd_lookup") === null;
      concurrent.setStylesGeneration(3);
      if (childRefresh) concurrent.reply(childRefresh, { generation: 3, dictionaryCount: 1, results: [concurrent.term("child")] }, !failedRefresh);
      await concurrent.settle();
      const parentRefresh = concurrent.take("hd_lookup");
      if (parentRefresh) concurrent.reply(parentRefresh, { generation: 3, dictionaryCount: 1, results: [concurrent.term("parent")] });
      await concurrent.settle();
      outcomes.push(retainedWhileHeld && childRefresh?.request.text === "child"
        && childRefresh.request.options.primaryReading === "reading" && parentRefresh?.request.text === rootRequest.payload.text
        && concurrent.driver.viewRequest() === rootRequest && !concurrent.driver.popupAt(1)
        && concurrent.sent.filter(request => request.type === "hd_custom_append").length === 2
        && concurrent.take("hd_lookup") === null);
      concurrent.close();
    }

    const retired = await createHarness();
    await retired.initialLookup();
    const first = retired.internalLink({ query: "old child" });
    retired.reply(retired.take("hd_lookup"), { dictionaryCount: 1, results: [retired.term("old child")] });
    await first;
    retired.edit(true, 1);
    const saving = retired.callbacks(1).onAddCustomEntry({ term: "old child", reading: "", definition: "saved after pruning" });
    const mutation = retired.take("hd_custom_append");
    retired.callbacks().onBeforeResultsRendered();
    const replacement = retired.internalLink({ query: "new child" });
    retired.reply(retired.take("hd_lookup"), { dictionaryCount: 1, results: [retired.term("new child")] });
    await replacement;
    const replacementRequest = retired.driver.viewRequest(1);
    retired.edit(true, 1);
    retired.reply(mutation, { state: retired.state(2, "committed retired append") });
    await saving;
    outcomes.push(retired.driver.snapshot().dictionaryStateRevision === 2
      && retired.driver.viewRequest(1) === replacementRequest && retired.driver.snapshot(1).noteEditing
      && retired.take("hd_lookup") === null);
    retired.close();
    return { "parent Note replay waits for a child draft and accepted explicit navigation consumes obsolete deferred state": outcomes.every(Boolean) };
  }

  async function nestedReplyRaceCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    const first = harness.internalLink({ query: "old child" });
    const oldRequest = harness.take("hd_lookup");
    harness.callbacks().onBeforeResultsRendered();
    const next = harness.internalLink({ query: "new child" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("new child")] });
    await next;
    const current = harness.driver.viewRequest(1);
    const currentPopup = harness.driver.popupAt(1);
    const before = harness.sent.length;
    harness.reply(oldRequest, { generation: 99, dictionaryCount: 1, results: [harness.term("old child")] });
    await first;
    const retiredIgnored = harness.driver.viewRequest(1) === current && harness.driver.popupAt(1) === currentPopup
      && harness.driver.snapshot().currentGeneration === 2 && harness.sent.length === before;
    harness.close();
    const detached = await createHarness();
    await detached.initialLookup();
    const pendingChild = detached.internalLink({ query: "detached ancestor" });
    const held = detached.take("hd_lookup");
    detached.anchor.remove();
    detached.reply(held, { generation: 99, dictionaryCount: 1, results: [detached.term("must not render")] });
    await pendingChild;
    const detachedIgnored = detached.driver.snapshot().currentGeneration === 2 && detached.renders.length === 1
      && detached.driver.snapshot().popupHidden && !detached.driver.popupAt(1);
    detached.close();
    const optionsRace = await createHarness();
    await optionsRace.initialLookup();
    const obsolete = optionsRace.internalLink({ query: "same pending child", primaryReading: "reading" });
    const obsoleteRequest = optionsRace.take("hd_lookup");
    const obsoletePopup = optionsRace.driver.popupAt(1);
    const anchor = optionsRace.popup.lastElementChild;
    optionsRace.emitOptions({ maxResults: 4 });
    const retry = optionsRace.render().context.onInternalLink({
      anchor, query: "same pending child", primaryReading: "reading",
    });
    const retryRequest = optionsRace.take("hd_lookup");
    const replacementPopup = optionsRace.driver.popupAt(1);
    optionsRace.reply(obsoleteRequest, { generation: 99, dictionaryCount: 1, results: [optionsRace.term("obsolete")] });
    await obsolete;
    const obsoletePendingIgnored = optionsRace.renders.length === 1
      && optionsRace.driver.snapshot().currentGeneration === 2;
    if (retryRequest) optionsRace.reply(retryRequest, {
      dictionaryCount: 1, results: [optionsRace.term("same pending child")],
    });
    await retry;
    const invalidatedPendingRetried = retryRequest?.request.maxResults === 4
      && obsoletePopup !== replacementPopup && obsoletePendingIgnored
      && optionsRace.driver.viewRequest(1)?.payload.options.primaryReading === "reading"
      && optionsRace.render(1).context.isCurrentRequest();
    optionsRace.close();
    const generations = [];
    for (const generation of [3, 1]) {
      const race = await createHarness();
      await race.initialLookup();
      const parent = race.driver.viewRequest();
      const child = race.internalLink({ query: "new generation" });
      const childRequest = race.take("hd_lookup");
      const kanji = race.callbacks().onKanjiClick("食");
      const parentRequest = race.take("hd_lookup_dictionary");
      race.setStylesGeneration(generation);
      race.reply(childRequest, { generation, dictionaryCount: 1, results: [race.term("new generation")] });
      await child;
      race.reply(parentRequest, { generation: 2, dictionaryCount: 1, results: [race.term("obsolete parent")] });
      await kanji;
      await race.settle();
      generations.push(race.driver.snapshot().currentGeneration === generation
        && race.driver.viewRequest() === parent && race.driver.viewRequest(1)?.payload.text === "new generation"
        && race.render(1).context.isCurrentRequest() && race.driver.snapshot().styleGeneration === generation);
      race.close();
    }
    return { "retired child replies and older parent replies cannot replace a new level or roll back engine generation":
      retiredIgnored && detachedIgnored && invalidatedPendingRetried && generations.every(Boolean) };
  }

  async function retainedParentNavigationCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    const parentRequest = harness.driver.viewRequest();
    const parentContext = harness.render().context;
    const child = harness.internalLink({ query: "child", primaryReading: "reading" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
    await child;
    harness.edit(true, 1);
    const append = harness.callbacks(1).onAddCustomEntry({ term: "child", reading: "reading", definition: "saved" });
    harness.emitState(harness.state(2, "child saved"));
    harness.reply(harness.take("hd_custom_append"), { state: harness.state(2, "child saved") });
    await append;
    harness.setStylesGeneration(3);
    harness.reply(harness.take("hd_lookup"), { generation: 3, dictionaryCount: 1, results: [harness.term("child")] });
    await harness.settle();
    const retained = !parentContext.isCurrentRequest() && parentContext.isCurrentView?.() === true;
    const next = harness.internalLink({ query: "another child", primaryReading: "another reading" });
    const linked = harness.take("hd_lookup");
    if (linked) harness.reply(linked, { generation: 3, dictionaryCount: 1, results: [harness.term("another child")] });
    await next;
    parentContext.onDictionaryTabSelected({ dictionary: "Generic" });
    const delegated = harness.callbacks().onBeforeResultsRendered() === false;
    const replay = harness.take("hd_lookup");
    if (replay) harness.reply(replay, { generation: 3, dictionaryCount: 1, results: [harness.term("parent refreshed")] });
    await harness.settle();
    const fresh = harness.driver.viewRequest() === parentRequest
      && harness.render().context.selectedDictionaryTab?.dictionary === "Generic"
      && harness.render().context.isCurrentRequest() && !harness.driver.popupAt(1);
    harness.callbacks().onBeforeResultsRendered();
    const currentTabLocal = harness.take("hd_lookup") === null;
    harness.close();

    async function retainedReplay(kind = "term") {
      const owner = await createHarness();
      await owner.initialLookup();
      if (kind === "clicked-term") {
        const clicked = owner.callbacks().onKanjiClick("食");
        owner.reply(owner.take("hd_lookup_dictionary"), { dictionaryCount: 1, results: [owner.term("食")] });
        await clicked;
      }
      const request = owner.driver.viewRequest();
      const context = owner.render().context;
      const linked = owner.internalLink({ query: "generation child", primaryReading: "reading" });
      owner.setStylesGeneration(3);
      owner.reply(owner.take("hd_lookup"), { generation: 3, dictionaryCount: 1, results: [owner.term("generation child")] });
      await linked;
      return { owner, request, context, type: kind === "clicked-term" ? "hd_lookup_dictionary" : "hd_lookup" };
    }

    const protectedReplays = [];
    for (const [kind, noteTiming, outcome] of [
      ["term", "before", "hit"],
      ["term", "during", "failure"],
      ["term", "during", "miss"],
      ["term", "during", "empty-library"],
      ["clicked-term", "during", "hit"],
    ]) {
      const { owner, request, context, type } = await retainedReplay(kind);
      try {
        if (noteTiming === "before") owner.edit(true);
        context.onDictionaryTabSelected({ dictionary: "Generic" });
        owner.callbacks().onBeforeResultsRendered();
        const held = owner.take(type);
        if (!held) { protectedReplays.push(false); continue; }
        if (noteTiming === "during") owner.edit(true);
        const visible = owner.render();
        const before = owner.sent.filter(message => message.type === type).length;
        // Repeated input shares the held exact descriptor, but keeps the latest
        // projection/expansion intent for the eventual current response.
        context.onDictionaryTabSelected(null);
        owner.callbacks().onBeforeResultsRendered({ expandAll: true });
        context.onDictionaryTabSelected({ dictionary: "Generic" });
        owner.callbacks().onBeforeResultsRendered();
        const expandAll = kind === "clicked-term";
        if (expandAll) owner.callbacks().onBeforeResultsRendered({ expandAll: true });
        const shared = owner.sent.filter(message => message.type === type).length === before;
        owner.reply(held, outcome === "failure" ? { error: "held replay failure" } : {
          generation: 3, dictionaryCount: outcome === "empty-library" ? 0 : 1,
          results: outcome === "hit" ? [owner.term("fresh projection")] : [],
        }, outcome !== "failure");
        await owner.settle();
        const rendered = owner.render();
        const protectedNote = owner.driver.snapshot().noteEditing && !owner.driver.snapshot().popupHidden
          && owner.driver.viewRequest() === request;
        const refreshed = outcome === "hit"
          ? rendered !== visible && rendered.context.preserveViewControls === true
            && rendered.context.expandAll === expandAll
            && rendered.context.selectedDictionaryTab?.dictionary === "Generic"
          : rendered === visible && context.isCurrentView() && !context.isCurrentRequest();
        let normalBack = true;
        if (kind === "clicked-term") {
          const back = rendered.context.onBack();
          const restoring = owner.take("hd_lookup");
          if (restoring) owner.reply(restoring, { generation: 3, dictionaryCount: 1, results: [owner.term(owner.candidate.query)] });
          await back;
          normalBack = Boolean(restoring) && owner.render().context.preserveViewControls !== true
            && owner.render().context.expandAll !== true && !owner.driver.snapshot().noteEditing;
        }
        protectedReplays.push(shared && protectedNote && refreshed && normalBack);
      } finally { owner.close(); }
    }

    // A live internal anchor is insufficient when its page-root ancestor was
    // detached during a protected failed replay.
    const detached = await createHarness();
    let detachedProtectedReply;
    try {
      await detached.initialLookup();
      const child = detached.internalLink({ query: "retained child" });
      detached.reply(detached.take("hd_lookup"), { dictionaryCount: 1, results: [detached.term("retained child")] });
      await child;
      const grandchild = detached.internalLink({ query: "new generation" }, 1);
      detached.setStylesGeneration(3);
      detached.reply(detached.take("hd_lookup"), { generation: 3, dictionaryCount: 1, results: [detached.term("new generation")] });
      await grandchild;
      detached.edit(true, 1);
      detached.callbacks(1).onBeforeResultsRendered();
      const failed = detached.take("hd_lookup");
      const source = detached.driver.viewRequest(1).candidate.anchor;
      detached.anchor.remove();
      const ownAnchorStillConnected = source.isConnected;
      if (failed) detached.reply(failed, { error: "detached ancestor" }, false);
      await detached.settle();
      detachedProtectedReply = Boolean(failed) && ownAnchorStillConnected
        && detached.driver.snapshot().popupHidden && !detached.driver.popupAt(1);
    } finally { detached.close(); }

    // Sharing expires with its token: a child accepting another generation
    // cannot make the next displayed action join the obsolete held replay.
    const changed = await retainedReplay();
    let generationEndsSharing;
    try {
      changed.owner.callbacks().onBeforeResultsRendered();
      const oldReplay = changed.owner.take("hd_lookup");
      const newerChild = changed.owner.internalLink({ query: "next generation" });
      const childRequest = changed.owner.take("hd_lookup");
      changed.owner.setStylesGeneration(4);
      if (childRequest) changed.owner.reply(childRequest, { generation: 4, dictionaryCount: 1, results: [changed.owner.term("next generation")] });
      await newerChild;
      changed.context.onDictionaryTabSelected({ dictionary: "Generic" });
      changed.owner.callbacks().onBeforeResultsRendered({ expandAll: true });
      const newReplay = changed.owner.take("hd_lookup");
      if (newReplay) changed.owner.reply(newReplay, { generation: 4, dictionaryCount: 1, results: [changed.owner.term("latest parent")] });
      await changed.owner.settle();
      const latest = changed.owner.render();
      if (oldReplay) changed.owner.reply(oldReplay, { generation: 3, dictionaryCount: 1, results: [changed.owner.term("obsolete parent")] });
      await changed.owner.settle();
      generationEndsSharing = Boolean(oldReplay && childRequest && newReplay)
        && changed.owner.render() === latest && latest.results[0].term.expression === "latest parent"
        && latest.context.expandAll === true && changed.owner.driver.snapshot().currentGeneration === 4;
    } finally { changed.owner.close(); }

    return { "retained parent navigation stays usable while stale tabs replay current dictionaries without reviving old resources":
      retained && linked?.request.text === "another child" && linked.request.options.primaryReading === "another reading"
      && delegated && replay?.request.text === parentRequest.payload.text && fresh && currentTabLocal
      && protectedReplays.every(Boolean) && detachedProtectedReply && generationEndsSharing };
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
      const restoring = refreshed.context.onBack();
      const backLookup = harness.take("hd_lookup");
      harness.reply(backLookup, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
      await restoring;
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

  async function selectionEditingCase() {
    const outcomes = [];
    for (const tag of ["button", "span", "contents", "restored", "restored-child"]) {
      const harness = await createHarness();
      const window = harness.popup.ownerDocument.defaultView;
      harness.anchor.textContent = "食";
      const control = window.document.createElement(tag === "button" ? "button" : "span");
      control.textContent = "べ";
      control.style.visibility = "visible";
      control.getClientRects = () => tag === "contents" ? [] : [{}];
      window.Range.prototype.getClientRects = () => [{}];
      if (tag !== "button") {
        control.setAttribute("contenteditable", "true");
        Object.defineProperty(control, "isContentEditable", { value: true });
        if (tag === "contents") control.style.display = "contents";
      }
      if (tag === "restored-child") {
        control.style.visibility = "hidden";
        const child = window.document.createElement("b");
        child.style.visibility = "visible";
        child.textContent = "べ";
        child.getClientRects = () => [{}];
        control.append(child);
      }
      let editingNode = control;
      if (tag === "restored") {
        editingNode = window.document.createElement("span");
        editingNode.style.visibility = "hidden";
        editingNode.append(control);
      }
      harness.anchor.append(editingNode, window.document.createTextNode("た"));
      window.getSelection().selectAllChildren(harness.anchor);
      window.document.dispatchEvent(new window.Event("selectionchange"));
      const selected = harness.take("hd_lookup");
      if (selected) harness.reply(selected, { dictionaryCount: 1, results: [] });
      await harness.settle();
      harness.driver.setScanCandidate(harness.candidate);
      harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
      const fallback = harness.take("hd_lookup");
      outcomes.push(selected === null && fallback === null);
      if (fallback) harness.reply(fallback, { dictionaryCount: 1, results: [] });
      await harness.settle();
      harness.close();
    }
    return { "selections spanning editing controls are ignored without falling back to pointer prefixes":
      outcomes.every(Boolean) || outcomes };
  }

  async function popupSelectionCase() {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const request = harness.take("hd_lookup");
    if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
    await harness.settle();
    const current = harness.driver.viewRequest();
    const text = window.document.createTextNode("Selected glossary text");
    harness.popup.append(text);
    const range = window.document.createRange();
    range.selectNodeContents(text);
    // jsdom cannot select closed-shadow text. Chrome exposes these real endpoints.
    const originalSelection = window.getSelection;
    window.getSelection = () => ({
      anchorNode: text, focusNode: text, isCollapsed: false, rangeCount: 1,
      getRangeAt: () => range, toString: () => range.toString(),
    });
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const retained = current !== null && harness.driver.viewRequest() === current
      && !harness.driver.snapshot().popupHidden && harness.take("hd_lookup") === null;
    window.getSelection = originalSelection;
    harness.close();
    return { "selecting popup glossary text preserves the current page-selection view": retained };
  }

  async function selectionInvalidationCase() {
    const outcomes = [];
    for (const [reason, phase] of ["dictionary", "options"].flatMap((reason) =>
      ["pending", "miss", "hit"].map((phase) => [reason, phase]))) {
      const harness = await createHarness();
      const window = harness.popup.ownerDocument.defaultView;
      window.getSelection().selectAllChildren(harness.anchor);
      window.document.dispatchEvent(new window.Event("selectionchange"));
      const first = harness.take("hd_lookup");
      const exactResults = [harness.term(harness.candidate.query)];
      if (phase !== "pending" && first) {
        harness.reply(first, { dictionaryCount: 1, results: phase === "hit" ? exactResults : [] });
        await harness.settle();
      }
      harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
      const unchangedRetained = harness.take("hd_lookup") === null;
      if (reason === "dictionary") harness.emitState(harness.state(2, "New dictionary generation"));
      else harness.emitOptions({ maxResults: 5 });
      if (phase === "pending" && first) harness.reply(first, { dictionaryCount: 1, results: exactResults });
      await harness.settle();
      const oldRejected = phase !== "pending"
        || (harness.renders.length === 0 && harness.driver.snapshot().popupHidden);
      harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
      const retry = harness.take("hd_lookup");
      if (retry) harness.reply(retry, { dictionaryCount: 1, results: exactResults });
      await harness.settle();
      outcomes.push(unchangedRetained && oldRejected && retry?.request.text === harness.candidate.query
        && (reason !== "options" || retry?.request.maxResults === 5)
        && harness.render()?.results[0].matched === harness.candidate.query
        && !harness.driver.snapshot().popupHidden);
      harness.close();
    }
    return { "pending selections and resolved hits or misses retry only after dictionary or result-option invalidation":
      outcomes.every(Boolean) || outcomes };
  }

  async function selectionDescriptorCase() {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const query = harness.candidate.query;
    const exactResults = [harness.term("食"), { ...harness.term("食べる"), matched: query }];
    harness.emitOptions({ scanLength: 1, kanjiClickDictionary: { title: "Generic", kind: "term" } });
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const first = harness.take("hd_lookup");
    if (first) harness.reply(first, { dictionaryCount: 1, results: exactResults });
    await harness.settle();
    const original = harness.driver.viewRequest();
    async function noteRefresh(revision, generation, results, eventFirst, depth = 0) {
      harness.edit(true, depth);
      window.getSelection().removeAllRanges();
      const append = harness.callbacks(depth).onAddCustomEntry({ term: "食べる", reading: "たべる", definition: "eat" });
      const mutation = harness.take("hd_custom_append");
      const state = harness.state(revision, "Saved Note");
      if (eventFirst) harness.emitState(state);
      if (mutation) harness.reply(mutation, { generation, document: { revision }, state });
      await harness.settle();
      const refresh = harness.take("hd_lookup");
      if (refresh) harness.reply(refresh, { generation, dictionaryCount: 2, results });
      await append;
      await harness.settle();
      window.getSelection().selectAllChildren(harness.anchor);
      return refresh;
    }
    const selectedRefresh = await noteRefresh(2, 2, exactResults, true);
    const selectedKept = selectedRefresh?.request.text === query && selectedRefresh.request.scanLength === 3
      && harness.driver.viewRequest() === original && original?.exactSelection === true
      && harness.render()?.results.length === 1;
    const clicked = harness.driver.showKanji("食");
    const kanji = harness.take("hd_lookup_dictionary");
    if (kanji) harness.reply(kanji, { generation: 3, results: [harness.term("食")] });
    await clicked;
    window.getSelection().removeAllRanges();
    const back = harness.render()?.context.onBack?.();
    const backRequest = harness.take("hd_lookup");
    if (backRequest) harness.reply(backRequest, { generation: 3, dictionaryCount: 2, results: exactResults });
    await back;
    window.getSelection().selectAllChildren(harness.anchor);
    const backKept = backRequest?.request.text === query && backRequest.request.scanLength === 3
      && harness.driver.viewRequest() === original && harness.render()?.results.length === 1;
    const link = harness.internalLink({ query: "別の語", primaryReading: "べつ" });
    const linked = harness.take("hd_lookup");
    if (linked) harness.reply(linked, { generation: 3, dictionaryCount: 2, results: [harness.term("別")] });
    await link;
    const linkedDescriptor = harness.driver.viewRequest(1);
    const linkKept = linked?.request.text === "別の語" && linked.request.options.primaryReading === "べつ"
      && linked.request.scanLength === 1 && linkedDescriptor?.exactSelection === false
      && harness.render(1)?.results[0].matched === "別"
      && harness.driver.viewRequest() === original && harness.driver.snapshot().activeHighlightText === query;
    const linkedRefresh = await noteRefresh(3, 3, [harness.term("別")], false, 1);
    harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
    const linkedRefreshKept = linkedRefresh?.request.text === "別の語"
      && linkedRefresh.request.options.primaryReading === "べつ"
      && harness.driver.viewRequest(1) === linkedDescriptor && harness.render(1)?.results[0].matched === "別"
      && harness.driver.viewRequest() === original && harness.driver.snapshot().activeHighlightText === query
      && harness.take("hd_lookup") === null;
    harness.close();
    return { "Note and kanji Back preserve exact selection descriptors while linked queries retain their own matching mode":
      selectedKept && backKept && linkKept && linkedRefreshKept
        || { selectedKept, backKept, linkKept, linkedRefreshKept } };
  }

  async function selectionRecoveryCase() {
    const recovered = [];
    for (const reason of ["Escape", "disable", "blur", "dictionary-state"]) {
      const harness = await createHarness();
      const window = harness.popup.ownerDocument.defaultView;
      window.getSelection().selectAllChildren(harness.anchor);
      window.document.dispatchEvent(new window.Event("selectionchange"));
      const first = harness.take("hd_lookup");
      if (first) harness.reply(first, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
      await harness.settle();
      if (reason === "Escape") harness.driver.onKeyDown({ key: "Escape", stopPropagation() {} });
      else if (reason === "disable") {
        harness.emitOptions({ hoverEnabled: false });
        harness.emitOptions({ hoverEnabled: true });
      } else if (reason === "blur") harness.driver.onWindowBlur();
      else harness.emitState(harness.state(2, "Changed dictionaries"));
      harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
      harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
      const retry = harness.take("hd_lookup");
      recovered.push(retry?.request.text === harness.candidate.query);
      if (retry) harness.reply(retry, { dictionaryCount: 1, results: [] });
      await harness.settle();
      harness.close();
    }
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const settings = { lookupMode: "activation", activationKey: "K", scanLength: 1, onlyScanJapaneseText: true };
    harness.emitOptions(settings);
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const selected = harness.take("hd_lookup");
    harness.emitOptions({ ...settings, onlyScanJapaneseText: false });
    window.document.dispatchEvent(new window.KeyboardEvent("keyup", { key: "k", code: "KeyK" }));
    harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
    harness.driver.onMouseMove({ target: harness.anchor, clientX: 200, clientY: 200 });
    if (selected) harness.reply(selected, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
    await harness.settle();
    const retained = selected !== null && !harness.driver.snapshot().popupHidden && harness.take("hd_lookup") === null;
    harness.close();
    return {
      "dismissed selections can be looked up again after Escape, enablement, blur and dictionary changes":
        recovered.every(Boolean) || recovered,
      "an explicit selection survives automatic scanning policy changes, key release and pointer motion": retained,
    };
  }

  async function selectedTextCase() {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const selection = window.getSelection();
    harness.anchor.innerHTML = '食べ<span hidden>隠し</span>た';
    selection.selectAllChildren(harness.anchor);
    let visible = "食べた";
    let materializations = 0;
    // jsdom uses raw Range text here; the Chrome suite verifies rendered text.
    Object.defineProperty(selection, "toString", { configurable: true, value: () => {
      materializations += 1;
      return visible;
    } });
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const first = harness.take("hd_lookup");
    if (first) harness.reply(first, { dictionaryCount: 1, results: [harness.term(visible)] });
    await harness.settle();
    const selectedText = first?.request.text === visible
      && harness.driver.viewRequest()?.highlightText === "食べ隠した";
    harness.anchor.firstChild.replaceData(1, 1, "ん");
    visible = "食んた";
    materializations = 0;
    for (let index = 0; index < 4; index += 1) {
      harness.driver.onMouseMove({ target: harness.anchor, clientX: 200 + index, clientY: 200 });
    }
    const throttled = materializations === 0;
    await harness.settle();
    const changed = harness.take("hd_lookup");
    const changedText = changed?.request.text === visible;
    if (changed) harness.reply(changed, { dictionaryCount: 1, results: [] });
    await harness.settle();
    harness.close();
    return { "selection lookup uses visible text, raw highlight offsets and text-aware unchanged detection":
      selectedText && changedText && throttled };
  }

  async function selectionCancellationCase() {
    const outcomes = [];
    for (const reason of ["Escape", "scroll", "window-exit", "collapse", "disable", "replace", "mutate"]) {
      const harness = await createHarness();
      const window = harness.popup.ownerDocument.defaultView;
      const selection = window.getSelection();
      const changed = () => window.document.dispatchEvent(new window.Event("selectionchange"));
      selection.selectAllChildren(harness.anchor);
      changed();
      const first = harness.take("hd_lookup");
      let replacement = null;
      if (reason === "Escape") harness.driver.onKeyDown({ key: "Escape" });
      else if (reason === "scroll") harness.driver.onScroll();
      else if (reason === "window-exit") harness.driver.onMouseOut({ relatedTarget: null });
      else if (reason === "disable") harness.emitOptions({ hoverEnabled: false });
      else if (reason === "mutate") harness.anchor.firstChild.replaceData(1, 1, "ん");
      else if (reason === "collapse") {
        selection.removeAllRanges();
        changed();
      } else {
        selection.setBaseAndExtent(harness.anchor.firstChild, 0, harness.anchor.firstChild, 1);
        changed();
        replacement = harness.take("hd_lookup");
      }
      if (first) harness.reply(first, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
      await harness.settle();
      outcomes.push(first !== null && harness.driver.snapshot().popupHidden
        && harness.renders.length === 0 && (reason !== "replace" || replacement !== null));
      if (reason === "mutate") {
        changed();
        replacement = harness.take("hd_lookup");
        outcomes.push(replacement?.request.text === "食んた");
      }
      if (replacement) harness.reply(replacement, { dictionaryCount: 1, results: [] });
      await harness.settle();
      harness.close();
    }
    return { "pending selections cannot reopen after dismissal, replacement or selected-text mutation":
      outcomes.every(Boolean) || outcomes };
  }

  async function exactSelectionCase() {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const document = window.document;
    const selection = window.getSelection();
    harness.emitOptions({ lookupMode: "activation", activationKey: "K", scanLength: 1 });
    const mouse = (type) => harness.anchor.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, button: 0, clientX: 200, clientY: 200,
    }));
    const changed = () => document.dispatchEvent(new window.Event("selectionchange"));
    const selectText = (text) => {
      mouse("mousedown");
      harness.anchor.textContent = text;
      selection.selectAllChildren(harness.anchor);
      changed();
      mouse("mouseup");
      changed();
      return harness.take("hd_lookup");
    };
    harness.anchor.innerHTML = '<b style="display:inline"> 食べ</b><i style="display:inline">たかった </i>';
    mouse("mousedown");
    selection.setBaseAndExtent(harness.anchor.lastChild.firstChild, 4, harness.anchor.firstChild.firstChild, 1);
    changed();
    harness.driver.onMouseMove({ target: harness.anchor, clientX: 200, clientY: 200, buttons: 1 });
    await harness.settle();
    const dragQuiet = harness.take("hd_lookup") === null;
    mouse("mouseup");
    changed();
    const exact = harness.take("hd_lookup");
    const query = "食べたかった";
    if (exact) harness.reply(exact, { dictionaryCount: 1, results: [
      harness.term("食べ"), { ...harness.term("食べる"), matched: query },
    ] });
    await harness.settle();
    const rendered = harness.render();
    const exactResult = dragQuiet && exact?.request.text === query
      && exact.request.scanLength === Array.from(query).length
      && harness.take("hd_lookup") === null && rendered?.results.length === 1
      && rendered.results[0].term.expression === "食べる"
      && rendered.candidate.query === query
      && rendered.candidate.sentence === " 食べたかった "
      && rendered.candidate.matchOffset === 1
      && rendered.candidate.sourceElements.map((node) => node.textContent).join("") === rendered.candidate.sentence;
    const raw = " hello\n world ";
    const rawRequest = selectText(raw);
    if (rawRequest) harness.reply(rawRequest, { dictionaryCount: 1, results: [] });
    await harness.settle();
    const long = "あ".repeat(70);
    const longRequest = selectText(long);
    if (longRequest) harness.reply(longRequest, { dictionaryCount: 1, results: [harness.term(long.slice(0, 64))] });
    await harness.settle();
    const exactBound = rawRequest?.request.text === raw && longRequest?.request.text === long
      && longRequest.request.scanLength === 64 && harness.driver.snapshot().popupHidden;
    harness.close();
    return {
      "exact reverse inline selections bypass activation and preserve raw context while rejecting prefix results": exactResult,
      "explicit selections preserve whitespace and full queries beyond the engine scan window": exactBound,
    };
  }

  async function releasedSelectionDragCase() {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const pointer = { target: harness.anchor, clientX: 200, clientY: 200, buttons: 1 };
    harness.driver.onMouseDown({ ...pointer, button: 0 });
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    harness.driver.onMouseOut({ relatedTarget: null });
    harness.driver.onMouseMove(pointer);
    await harness.settle();
    const held = harness.take("hd_lookup") === null;
    // The primary button was released outside the document: no mouseup arrives.
    harness.driver.onMouseMove({ ...pointer, buttons: 0 });
    await harness.settle();
    const recovered = harness.take("hd_lookup");
    if (recovered) harness.reply(recovered, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
    await harness.settle();
    const visible = !harness.driver.snapshot().popupHidden;
    harness.close();
    return { "selection drags remain quiet while held and recover on re-entry after an outside release":
      held && recovered?.request.text === harness.candidate.query && visible };
  }

  async function scanExtractionCase() {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const document = window.document;
    const block = document.createElement("p");
    block.style.display = "block";
    document.body.append(block);
    const scan = (node, offset = 0) => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      document.caretRangeFromPoint = () => range;
      return harness.driver.resolveCandidate(0, 0);
    };
    block.innerHTML = '<b style="display:inline">食</b><i style="display:inline">べたかった</i>。';
    const inline = scan(block.firstChild.firstChild);
    const crossedInline = inline?.query === "食べたかった。"
      && inline.sourceElements.map((element) => element.textContent).join("") === inline.sentence;
    block.textContent = "hello world";
    const japaneseOnly = scan(block.firstChild) === null;
    harness.emitOptions({ onlyScanJapaneseText: false });
    const unrestricted = scan(block.firstChild)?.query === "hello world";
    harness.emitOptions({ onlyScanJapaneseText: true });
    const gatedAgain = scan(block.firstChild) === null;
    const controls = [];
    for (const tag of ["button", "select", "textarea", "input", "span"]) {
      block.innerHTML = '<b style="display:inline">食</b>';
      const control = document.createElement(tag);
      control.style.display = "inline";
      control.getClientRects = () => [{}];
      control.textContent = "べたかった";
      if (tag === "span") {
        control.setAttribute("contenteditable", "true");
        // jsdom lacks this browser property; Chrome exercises actual inheritance.
        Object.defineProperty(control, "isContentEditable", { value: true });
      }
      block.append(control, document.createTextNode("語"));
      controls.push(scan(control.firstChild) === null && scan(block.firstChild.firstChild)?.query === "食");
      control.style.display = "none";
      controls.push(scan(block.firstChild.firstChild)?.query === "食語");
    }
    block.innerHTML = '食<span style="display:inline;visibility:hidden">隠し<b style="display:inline;visibility:visible">べ</b></span>た';
    const restored = block.querySelector("b");
    const restoredProse = scan(block.firstChild)?.query === "食べた" && scan(restored.firstChild)?.query === "べた";
    block.querySelector("span").style.display = "block";
    const restoredBlock = scan(block.firstChild)?.query === "食";
    block.querySelector("span").style.display = "inline";
    for (const editor of [block.querySelector("span"), restored]) {
      editor.setAttribute("contenteditable", "true");
      Object.defineProperty(editor, "isContentEditable", { configurable: true, value: true });
      restored.getClientRects = () => [{}];
      controls.push(scan(block.firstChild)?.query === "食");
      editor.removeAttribute("contenteditable");
      delete editor.isContentEditable;
    }
    harness.close();
    return {
      "pointer scans cross ordinary inline text and apply the live Japanese-only preference":
        crossedInline && japaneseOnly && unrestricted && gatedAgain && restoredProse && restoredBlock,
      "editing controls and contenteditable text stop both direct and forward pointer scanning":
        controls.every(Boolean) || controls,
    };
  }

  async function focusedEditingCase() {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const input = window.document.createElement("input");
    window.document.body.append(input);
    harness.driver.setScanCandidate(harness.candidate);
    harness.emitOptions({ lookupMode: "activation", activationKey: "K", hoverDelayMs: 0 });
    const pointer = { target: harness.anchor, clientX: 200, clientY: 200 };
    harness.driver.onMouseMove(pointer);
    input.focus();
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true }));
    harness.driver.onMouseMove(pointer);
    await harness.settle();
    const whileEditing = harness.take("hd_lookup");
    if (whileEditing) harness.reply(whileEditing, {}, false);
    await harness.settle();
    input.blur();
    harness.emitOptions({ onlyScanJapaneseText: false });
    harness.driver.setScanCandidate({ ...harness.candidate, query: "hello" });
    harness.driver.scanPointer(pointer);
    const beforeGate = harness.take("hd_lookup");
    harness.emitOptions({ onlyScanJapaneseText: true });
    if (beforeGate) harness.reply(beforeGate, { dictionaryCount: 1, results: [harness.term("hello")] });
    await harness.settle();
    const obsoleteRejected = harness.driver.snapshot().popupHidden;
    harness.close();
    return {
      "focused editing suppresses stationary activation and Japanese gating cancels prior pending scans":
        whileEditing === null && beforeGate !== null && obsoleteRejected,
    };
  }

  async function shadowEditingCase() {
    const outcomes = [];
    for (const tag of ["input", "div"]) {
      const harness = await createHarness();
      const window = harness.popup.ownerDocument.defaultView;
      const host = window.document.createElement("div");
      window.document.body.append(host);
      const innerHost = window.document.createElement("div");
      host.attachShadow({ mode: "open" }).append(innerHost);
      const editor = window.document.createElement(tag);
      editor.tabIndex = 0;
      if (tag === "div") {
        editor.setAttribute("contenteditable", "true");
        Object.defineProperty(editor, "isContentEditable", { value: true });
      }
      innerHost.attachShadow({ mode: "open" }).append(editor);
      harness.driver.setScanCandidate(harness.candidate);
      const pointer = { target: harness.anchor, clientX: 200, clientY: 200 };
      harness.emitOptions({ lookupMode: "activation", activationKey: "K", hoverDelayMs: 0 });
      harness.driver.onMouseMove(pointer);
      editor.focus();
      editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true, composed: true }));
      await harness.settle();
      const typing = harness.take("hd_lookup");
      if (typing) harness.reply(typing, {}, false);
      editor.blur();
      harness.emitOptions({ lookupMode: "hover", hoverDelayMs: 0 });
      harness.driver.onMouseMove(pointer);
      editor.focus();
      await harness.settle();
      const delayed = harness.take("hd_lookup");
      if (delayed) harness.reply(delayed, {}, false);
      editor.blur();
      harness.driver.scanPointer(pointer);
      const pending = harness.take("hd_lookup");
      editor.focus();
      if (pending) harness.reply(pending, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
      await harness.settle();
      outcomes.push(typing === null && delayed === null && pending !== null && harness.driver.snapshot().popupHidden);
      harness.close();
    }
    return { "nested open-shadow editors suppress activation and cancel delayed and pending candidate work":
      outcomes.every(Boolean) || outcomes };
  }

  async function pendingScanCase() {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const scan = (candidate) => {
      harness.driver.setScanCandidate(candidate);
      harness.driver.scanPointer({ target: window.document.body, clientX: 200, clientY: 200 });
    };
    scan(harness.candidate);
    const first = harness.take("hd_lookup");
    scan(harness.candidate);
    const duplicate = harness.take("hd_lookup");
    const otherAnchor = window.document.createElement("span");
    otherAnchor.textContent = harness.candidate.query;
    window.document.body.append(otherAnchor);
    const other = {
      ...harness.candidate,
      anchor: otherAnchor,
      sourceElements: [otherAnchor],
      scanEntries: [{ ...harness.candidate.scanEntries[0], node: otherAnchor.firstChild }],
    };
    scan(other);
    const newer = harness.take("hd_lookup");
    for (const request of [first, duplicate].filter(Boolean)) {
      harness.reply(request, { dictionaryCount: 1, results: [harness.term("old node")] });
    }
    await harness.settle();
    scan(other);
    const lateDuplicate = harness.take("hd_lookup");
    for (const request of [newer, lateDuplicate].filter(Boolean)) harness.reply(request, {}, false);
    await harness.settle();
    scan(other);
    const retry = harness.take("hd_lookup");
    if (retry) harness.reply(retry, { dictionaryCount: 1, results: [harness.term(other.query)] });
    await harness.settle();
    scan(other);
    const renderedDuplicate = harness.take("hd_lookup");
    const passed = first !== null && newer !== null && retry !== null
      && duplicate === null && lateDuplicate === null && renderedDuplicate === null
      && !harness.driver.snapshot().popupHidden;
    harness.close();
    return { "pending pointer candidates deduplicate by node and query without losing retries or newer ownership": passed };
  }

  async function activationCase() {
    const result = {};
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const timers = new Map();
    let nextTimer = 0;
    window.setTimeout = (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    const fire = (delay) => {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      if (!entry) return false;
      timers.delete(entry[0]);
      entry[1].callback();
      return true;
    };
    const key = (type, value, code, extra = {}) => window.document.dispatchEvent(
      new window.KeyboardEvent(type, { key: value, code, bubbles: true, ...extra }),
    );
    const move = (target = window.document.body, extra = {}) => harness.driver.onMouseMove({
      clientX: 200, clientY: 200, target, ...extra,
    });
    const settings = { lookupMode: "activation", activationKey: "Shift", hoverDelayMs: 75, popupHideDelayMs: 250 };
    harness.emitOptions(settings);
    harness.driver.setScanCandidate(harness.candidate);
    move();
    fire(75);
    const gated = harness.take("hd_lookup") === null;
    key("keydown", "Shift", "ShiftLeft", { shiftKey: true });
    const delayed = harness.take("hd_lookup") === null && [...timers.values()].some((timer) => timer.delay === 75);
    key("keyup", "Shift", "ShiftLeft");
    const cancelledTimer = !fire(75);
    key("keydown", "Shift", "ShiftLeft", { shiftKey: true });
    fire(75);
    const pending = harness.take("hd_lookup");
    key("keyup", "Shift", "ShiftLeft");
    if (pending) harness.reply(pending, { dictionaryCount: 1, results: [harness.term("released")] });
    await harness.settle();
    result["activation release cancels delayed scans and a first pending reply without pointer motion"] =
      gated && delayed && cancelledTimer && pending !== null && harness.driver.snapshot().popupHidden;

    harness.emitOptions({ ...settings, activationKey: "/" });
    key("keydown", "/", "Slash");
    key("keydown", "/", "Slash", { repeat: true });
    const oneTimer = [...timers.values()].filter((timer) => timer.delay === 75).length === 1;
    fire(75);
    const printable = harness.take("hd_lookup");
    key("keyup", "?", "Slash", { shiftKey: true });
    if (printable) harness.reply(printable, { dictionaryCount: 1, results: [harness.term("released punctuation")] });
    await harness.settle();
    result["configured printable activation keys release by physical code and ignore repeats"] =
      oneTimer && printable !== null && harness.driver.snapshot().popupHidden;

    harness.emitOptions({ ...settings, activationKey: "Escape" });
    key("keydown", "Escape", "Escape");
    key("keydown", "Escape", "Escape", { repeat: true });
    fire(75);
    const escaped = harness.take("hd_lookup");
    if (escaped) harness.reply(escaped, { dictionaryCount: 1, results: [harness.term("Escape key")] });
    await harness.settle();
    key("keydown", "Escape", "Escape", { repeat: true });
    const escapeRepeatRetained = !harness.driver.snapshot().popupHidden;
    harness.edit(true);
    harness.setCloseNext(true);
    key("keydown", "Escape", "Escape");
    key("keydown", "Escape", "Escape", { repeat: true });
    const noteRepeatRetained = !harness.driver.snapshot().popupHidden && !harness.driver.snapshot().noteEditing;
    key("keyup", "Escape", "Escape");
    key("keydown", "Escape", "Escape");
    const escapeDismissed = harness.driver.snapshot().popupHidden;
    key("keyup", "Escape", "Escape");
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const selectedMiss = harness.take("hd_lookup");
    if (selectedMiss) harness.reply(selectedMiss, { dictionaryCount: 1, results: [] });
    await harness.settle();
    key("keydown", "Escape", "Escape");
    const missTimer = fire(75);
    const unexpectedRetry = harness.take("hd_lookup");
    if (unexpectedRetry) harness.reply(unexpectedRetry, { dictionaryCount: 1, results: [] });
    await harness.settle();
    result["Escape activation respects Note dismissal, retained selection misses and auto-repeat"] =
      escaped !== null && escapeRepeatRetained && noteRepeatRetained && escapeDismissed
      && selectedMiss !== null && !missTimer && unexpectedRetry === null;
    key("keyup", "Escape", "Escape");
    window.getSelection().removeAllRanges();
    window.document.dispatchEvent(new window.Event("selectionchange"));

    const departures = [];
    for (const reason of ["no-candidate", "window-exit", "blur", "Escape", "click", "scroll"]) {
      harness.emitOptions({ ...settings, lookupMode: "hover" });
      harness.driver.setScanCandidate(harness.candidate);
      move();
      fire(75);
      const departed = harness.take("hd_lookup");
      if (reason === "no-candidate") {
        harness.driver.setScanCandidate(null);
        move();
        fire(75);
      } else if (reason === "window-exit") harness.driver.onMouseOut({ relatedTarget: null });
      else if (reason === "blur") harness.driver.onWindowBlur();
      else if (reason === "Escape") key("keydown", "Escape", "Escape");
      else if (reason === "scroll") harness.driver.onScroll();
      else harness.driver.onMouseDown({ target: window.document.body, clientX: 200, clientY: 200 });
      if (departed) harness.reply(departed, { dictionaryCount: 1, results: [harness.term(reason)] });
      await harness.settle();
      departures.push(departed !== null && harness.driver.snapshot().popupHidden);
      harness.driver.onWindowBlur();
    }
    result["pointer departure, click, Escape, blur and scroll cancel the first pending popup"] =
      departures.every(Boolean) || departures;

    harness.emitOptions({ ...settings, lookupMode: "hover" });
    await harness.initialLookup();
    harness.driver.setScanCandidate(null);
    move();
    fire(75);
    const transferDelay = harness.driver.hideTimerPending() && !harness.driver.snapshot().popupHidden
      && [...timers.values()].some((timer) => timer.delay === 250);
    move(harness.popup.getRootNode().host);
    const transferred = !harness.driver.hideTimerPending();
    fire(75);
    harness.edit(true);
    move();
    fire(75);
    const draftProtected = !harness.driver.hideTimerPending() && !harness.driver.snapshot().popupHidden;
    harness.edit(false);
    harness.emitOptions({ ...settings, lookupMode: "hover", popupHideDelayMs: 0 });
    const retainedViewCurrent = harness.render().context.isCurrentRequest();
    move();
    fire(75);
    fire(0);
    result["configured transfer delays preserve popup entry and Note editing and allow immediate hide"] =
      transferDelay && transferred && draftProtected && retainedViewCurrent && harness.driver.snapshot().popupHidden
        || { transferDelay, transferred, draftProtected, retainedViewCurrent, hidden: harness.driver.snapshot().popupHidden };

    harness.emitOptions({ ...settings, lookupMode: "hover" });
    await harness.initialLookup();
    const oldViewContext = harness.render().context;
    harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
    move();
    fire(75);
    const supersededPointer = harness.take("hd_lookup");
    const oldViewRetired = harness.driver.snapshot().popupHidden && !oldViewContext.isCurrentRequest();
    const rendersBeforeNote = harness.renders.length;
    harness.driver.setScanCandidate(null);
    move();
    fire(75);
    if (supersededPointer) harness.reply(supersededPointer, { dictionaryCount: 1, results: [harness.term("late pointer")] });
    await harness.settle();
    const cancelledReplacement = harness.driver.snapshot().popupHidden && harness.renders.length === rendersBeforeNote;
    await harness.initialLookup();
    harness.edit(true);
    harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
    move();
    fire(75);
    result["a new pointer candidate retires the old view while an open Note prevents replacement"] =
      supersededPointer !== null && oldViewRetired && cancelledReplacement
        && harness.driver.snapshot().noteEditing && harness.render().context.isCurrentRequest()
        && harness.take("hd_lookup") === null && !harness.driver.snapshot().popupHidden;
    harness.edit(false);

    const focusedControl = window.document.createElement("button");
    focusedControl.textContent = "Back";
    harness.popup.append(focusedControl);
    focusedControl.focus();
    move();
    fire(75);
    const focusedRequest = harness.take("hd_lookup");
    const focusKept = harness.popup.getRootNode().activeElement === focusedControl;
    const focusedVisible = !harness.driver.snapshot().popupHidden;
    if (focusedRequest) harness.reply(focusedRequest, { dictionaryCount: 1, results: [harness.term("incidental pointer")] });
    await harness.settle();
    result["keyboard-focused popup controls suppress incidental pointer replacements"] =
      focusedRequest === null && focusKept && focusedVisible && harness.render().context.isCurrentRequest();
    focusedControl.blur();

    harness.driver.setScanCandidate(harness.candidate);
    move();
    harness.emitOptions({ ...settings, hoverEnabled: false });
    const disabledTimer = !fire(75);
    move();
    fire(75);
    const disabledScan = harness.take("hd_lookup") === null;
    harness.emitOptions({ ...settings, lookupMode: "hover" });
    const disabledPending = harness.driver.runLookup(harness.candidate);
    const disabledRequest = harness.take("hd_lookup");
    harness.emitOptions({ ...settings, hoverEnabled: false });
    harness.reply(disabledRequest, { dictionaryCount: 1, results: [harness.term("disabled while pending")] });
    await disabledPending;
    const disabledReply = harness.driver.snapshot().popupHidden;
    harness.emitOptions({ ...settings, lookupMode: "hover" });
    await harness.initialLookup();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({ term: "食べた", reading: "たべた", definition: "ate" });
    const appendRequest = harness.take("hd_custom_append");
    harness.emitOptions({ ...settings, hoverEnabled: false });
    const closedDraft = harness.driver.snapshot().popupHidden;
    harness.reply(appendRequest, { document: { revision: 2 }, state: harness.state(2, "saved while disabled") });
    await append;
    await harness.settle();
    result["master disable stops scans and closes drafts without cancelling or refreshing a committed Note"] =
      disabledTimer && disabledScan && disabledReply && closedDraft && harness.driver.snapshot().popupHidden
        && harness.take("hd_lookup") === null;
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

  async function mediaOwnershipCase() {
    const result = {};
    const url = "data:image/png;base64,YQ==";
    const load = (harness, context = harness.render().context) => context.resolveMedia({
      dictionary: "Generic", generation: context.generation, path: "media/owned.png",
      isCurrent: context.isCurrentRequest,
    }).catch(() => null);
    const finish = (harness, dataUrl = url, ok = true) => {
      const request = harness.take("hd_media");
      if (request) harness.reply(request, { dataUrl, generation: harness.render().context.generation }, ok);
      return request;
    };

    const late = await createHarness();
    await late.initialLookup();
    const old = load(late);
    const oldRequest = late.take("hd_media");
    late.setStylesGeneration(3);
    await late.initialLookup(3);
    const current = load(late);
    const currentRequest = finish(late);
    await current;
    late.reply(oldRequest, { dataUrl: url, generation: 2 });
    await old;
    const generationStayedCurrent = late.driver.snapshot().currentGeneration === 3;
    const cached = load(late);
    const unexpected = finish(late);
    await cached;
    late.setStylesGeneration(1);
    await late.initialLookup(1);
    result["late media cannot roll back generation or evict a newer cached image"] = generationStayedCurrent
      && oldRequest.request.generation === 2 && currentRequest?.request.generation === 3
      && !unexpected && late.driver.snapshot().currentGeneration === 1;
    late.close();

    const shared = await createHarness();
    await shared.initialLookup();
    const oldContext = shared.render().context;
    const first = load(shared);
    await shared.initialLookup();
    const second = load(shared);
    const staleSubscriber = load(shared, oldContext);
    finish(shared);
    const values = await Promise.all([first, second, staleSubscriber]);
    const third = load(shared);
    const redundant = finish(shared);
    await third;
    result["a current view adopts one pending media fetch without a stale subscriber stealing ownership"] =
      values[1] === url && values[2] === null && !redundant
      && shared.sent.filter(({ type }) => type === "hd_media").length === 1;
    shared.close();

    const replaced = await createHarness();
    await replaced.initialLookup();
    const abandoned = load(replaced);
    const abandonedRequest = replaced.take("hd_media");
    replaced.emitState(replaced.state(2, "replaced"));
    await replaced.initialLookup();
    const replacement = load(replaced);
    const replacementRequest = replaced.take("hd_media");
    replaced.reply(abandonedRequest, { dataUrl: "data:image/png;base64,b2xk" });
    await abandoned;
    const joinReplacement = load(replaced);
    const extra = finish(replaced);
    if (replacementRequest) replaced.reply(replacementRequest, { dataUrl: url });
    const replacementValues = await Promise.all([replacement, joinReplacement]);
    result["dictionary invalidation prevents old same-generation jobs from poisoning or deleting replacements"] =
      Boolean(replacementRequest) && !extra && replacementValues.every((value) => value === url);
    replaced.close();

    const retries = [];
    for (const ok of [false, true]) {
      const harness = await createHarness();
      await harness.initialLookup();
      const failed = load(harness);
      finish(harness, null, ok);
      await failed;
      await harness.initialLookup();
      const retry = load(harness);
      const retried = finish(harness);
      const value = await retry;
      await harness.initialLookup();
      const reused = load(harness);
      const refetched = finish(harness);
      await reused;
      retries.push(Boolean(retried) && value === url && !refetched);
      harness.close();
    }
    result["failed and missing media retry while successful images survive repeat hovers"] = retries.every(Boolean);

    const hidden = await createHarness();
    await hidden.initialLookup();
    const hiddenFetch = load(hidden);
    hidden.popup.ownerDocument.dispatchEvent(new hidden.popup.ownerDocument.defaultView.KeyboardEvent(
      "keydown", { bubbles: true, cancelable: true, key: "Escape" },
    ));
    finish(hidden);
    await hiddenFetch;
    await hidden.initialLookup();
    const afterHidden = load(hidden);
    const hiddenRefetch = finish(hidden);
    const hiddenValue = await afterHidden;
    result["valid media completed while hidden stays reusable without touching an obsolete view"] =
      !hiddenRefetch && hiddenValue === url;
    hidden.close();

    const presentation = await createHarness();
    await presentation.initialLookup();
    const firstImage = load(presentation);
    finish(presentation);
    await firstImage;
    const stylesBefore = presentation.sent.filter(({ type }) => type === "hd_styles").length;
    presentation.emitState({
      revision: 2,
      dictionaries: presentation.driver.snapshot().dictionaries.map((dictionary) => ({
        ...dictionary, displayName: "New alias", favorite: !dictionary.favorite,
      })),
    });
    await presentation.initialLookup();
    const afterPresentation = load(presentation);
    const presentationRefetch = finish(presentation);
    await afterPresentation;
    result["alias and favorite changes preserve successful media and styles without re-fetching"] =
      !presentationRefetch && presentation.sent.filter(({ type }) => type === "hd_styles").length === stylesBefore;
    presentation.close();

    const styles = await createHarness();
    await styles.initialLookup(3);
    await styles.settle();
    result["a mismatched style reply cannot adopt generation and remains retryable"] =
      styles.driver.snapshot().currentGeneration === 3 && styles.driver.snapshot().styleGeneration === -1;
    styles.close();
    for (const ok of [false, true]) {
      const reused = await createHarness();
      reused.setHoldStyles();
      await reused.initialLookup();
      const obsoleteStyles = reused.take("hd_styles");
      reused.emitState(reused.state(2, "new dictionary state"));
      await reused.initialLookup();
      const newStyles = reused.take("hd_styles");
      reused.reply(obsoleteStyles, { styles: ["obsolete"] }, ok);
      await reused.settle();
      const oldIgnored = reused.appliedStyles.length === 0 && reused.driver.snapshot().styleGeneration === 2;
      reused.reply(newStyles, { styles: ["current"] });
      await reused.settle();
      result["a mismatched style reply cannot adopt generation and remains retryable"] &&=
        oldIgnored && reused.appliedStyles.length === 1 && reused.appliedStyles[0].styles[0] === "current";
      reused.close();
    }

    const back = await createHarness();
    await back.initialLookup();
    const clicked = back.callbacks().onKanjiClick("食", null, null, null);
    back.setStylesGeneration(3);
    back.reply(back.take("hd_lookup_dictionary"), {
      generation: 3, dictionaryCount: 1, results: [back.term("clicked newer")],
    });
    await clicked;
    const restoring = back.render().context.onBack();
    const refresh = back.take("hd_lookup");
    if (refresh) back.reply(refresh, {
      generation: 3, dictionaryCount: 1, results: [back.term("refreshed Back")],
    });
    await restoring;
    result["Back refreshes an old result snapshot before requesting current-generation media"] =
      Boolean(refresh) && back.render().results[0].term.expression === "refreshed Back"
        && back.render().context.generation === 3;
    back.close();
    return result;
  }

  async function imageSourceRoutingCase() {
    const harness = await createHarness();
    const results = {};
    const url = "data:image/png;base64,Yg==";
    const otherUrl = "data:image/png;base64,Yw==";
    const sourceOptions = {
      frequencyDictionary: "Frequency A", frequencyOrder: "descending", hoverDelayMs: 0,
      kanjiClickDictionary: { title: "Generic", kind: "term" }, maxResults: 7,
      modifier: "none", scanLength: 9,
    };
    const select = (popupImageSource) => harness.emitOptions({ ...sourceOptions, popupImageSource });
    const inventory = {
      revision: 2,
      dictionaries: [...harness.driver.snapshot().dictionaries,
        genericPackage({ id: "image-b", title: "Images:B", path: "/dicts/images-b", termCount: 0 }),
        genericPackage({ id: "image-c", title: "Images:C", path: "/dicts/images-c", termCount: 0 }),
        genericPackage({ id: "image-off", title: "Images:Disabled", path: "/dicts/images-off", enabled: false }),
      ],
      groups: [{ id: "image-order", name: "Images", dictionaryIds: ["image-b", "image-c"] }],
    };
    harness.emitState(inventory);
    let inventoryRevision = inventory.revision;
    const changeInventory = (patch) => harness.emitState({ ...inventory, ...patch, revision: ++inventoryRevision });
    await harness.initialLookup();
    const context = harness.render().context;
    const descriptor = harness.driver.viewRequest();
    const renderCount = harness.renders.length;
    const sources = [];
    const load = (path, owns = () => true) => context.resolveMedia({
      dictionary: "Generic", generation: context.generation, path,
      isCurrent: () => owns() && context.isCurrentRequest(),
      onResolvedSource: (title) => sources.push({ path, title }),
    }).catch(() => null);
    const finish = (dataUrl = url) => {
      const request = harness.take("hd_media");
      if (request) harness.reply(request, { dataUrl });
      return request?.request;
    };
    try {
      select({ kind: "dictionary", title: "Images:B" });
      const explicit = load("explicit.png");
      const explicitRequest = finish();
      results["explicit image sources resolve another dictionary's path without changing its text or lookup owner"] =
        await explicit === url && explicitRequest?.dictionary === "Images:B"
        && sources.at(-1)?.title === "Images:B"
        && harness.driver.viewRequest() === descriptor && context.isCurrentRequest()
        && harness.renders.length === renderCount && harness.driver.snapshot().currentGeneration === 2;

      select({ kind: "tabGroup", id: "image-order" });
      const firstPath = load("group-x.png");
      const firstCandidate = finish(null);
      await harness.settle();
      const fallback = finish(otherUrl);
      const firstValue = await firstPath;
      const secondPath = load("group-y.png");
      const secondCandidate = finish();
      const secondValue = await secondPath;
      const exhausted = load("absent.png");
      finish(null);
      await harness.settle();
      finish(null);
      const exhaustedValue = await exhausted;
      const beforeUnavailable = harness.sent.length;
      const unavailableValues = [];
      for (const source of [{ kind: "tabGroup", id: "removed-group" },
        { kind: "dictionary", title: "Removed" }, { kind: "dictionary", title: "Images:Disabled" }]) {
        select(source);
        const unavailable = load("unavailable.png");
        finish();
        unavailableValues.push(await unavailable);
      }
      results["image groups fall through separately for each path and unavailable or exhausted sources fail normally"] =
        firstCandidate?.dictionary === "Images:B" && fallback?.dictionary === "Images:C"
        && firstValue === otherUrl && secondCandidate?.dictionary === "Images:B" && secondValue === url
        && exhaustedValue === null && unavailableValues.every(value => value === null) && harness.sent.length === beforeUnavailable;

      select({ kind: "tabGroup", id: "image-order" });
      let ownsFirst = true;
      const beforeShared = harness.sent.length;
      const first = load("shared-route.png", () => ownsFirst);
      const second = load("shared-route.png");
      ownsFirst = false;
      const sharedFirst = finish(null);
      await harness.settle();
      const sharedFallback = finish(otherUrl);
      const sharedValues = await Promise.all([first, second]);
      results["routed media shares pending candidates without a retired consumer publishing provenance or cancelling its peer"] =
        sharedFirst?.dictionary === "Images:B" && sharedFallback?.dictionary === "Images:C"
        && sharedValues[0] === null && sharedValues[1] === otherUrl
        && harness.sent.length === beforeShared + 2
        && sources.filter(({ path }) => path === "shared-route.png").length === 1;

      const stale = [];
      for (const successful of [false, true, "group-reorder", "automatic"]) {
        select(successful === "automatic" ? null : { kind: "tabGroup", id: "image-order" });
        const path = `obsolete-${successful}.png`;
        const operation = load(path);
        const request = harness.take("hd_media");
        const beforeChange = harness.sent.length;
        if (successful === "group-reorder") {
          changeInventory({ groups: [{ ...inventory.groups[0], dictionaryIds: ["image-c", "image-b"] }] });
        } else select({ kind: "dictionary", title: "Images:C" });
        harness.reply(request, { dataUrl: successful ? url : null });
        await harness.settle();
        finish();
        stale.push(await operation === null && harness.sent.length === beforeChange
          && !sources.some(item => item.path === path));
      }
      results["changing the effective image route stops stale success and further fallback without invalidating the lookup"] =
        stale.every(Boolean) && context.isCurrentRequest() && harness.driver.viewRequest() === descriptor;

      changeInventory({});
      select({ kind: "tabGroup", id: "image-order" });
      const pendingAlias = load("alias.png");
      const aliasRequest = harness.take("hd_media");
      const beforeAlias = harness.sent.length;
      changeInventory({ dictionaries: inventory.dictionaries.map(dictionary =>
        dictionary.id === "image-b" ? { ...dictionary, displayName: "Picture book" } : dictionary),
        groups: [{ ...inventory.groups[0], name: "Renamed pictures" }],
      });
      harness.reply(aliasRequest, { dataUrl: url });
      const aliasValue = await pendingAlias;
      const cachedAlias = await load("alias.png");
      results["image-source aliases retain pending ownership and cached bytes without additional content requests"] =
        aliasValue === url && cachedAlias === url && sources.at(-1)?.title === "Images:B"
        && harness.sent.length === beforeAlias && context.isCurrentRequest()
        && harness.driver.viewRequest() === descriptor && harness.renders.length === renderCount;
      const callbackFailure = context.resolveMedia({
        dictionary: "Generic", generation: context.generation, path: "alias.png",
        isCurrent: context.isCurrentRequest,
        onResolvedSource() { throw new Error("provenance callback failed"); },
      }).catch(error => error.message);
      await harness.settle();
      finish();
      results["image provenance callback errors do not trigger another supplier lookup"] =
        await callbackFailure === "provenance callback failed" && harness.sent.length === beforeAlias;
      return results;
    } finally { harness.close(); }
  }

  async function previewInvalidationCase() {
    const cases = [];
    for (const kind of ["term", "clicked-term", "kanji", "options", "dictionary-note"]) {
      const harness = await createHarness({ title: "Generic", kind: kind === "kanji" ? "kanji" : "term" });
      await harness.initialLookup();
      const previous = harness.render().context;
      const before = harness.stats().previewDismissals;
      let operation;
      if (kind === "term") operation = harness.driver.runLookup(harness.candidate);
      else if (kind === "clicked-term" || kind === "kanji") operation = harness.callbacks().onKanjiClick("食");
      else if (kind === "options") harness.emitOptions({ maxResults: 9 });
      else {
        harness.edit(true);
        harness.emitState(harness.state(2, "new dictionary state"));
      }
      const dismissedBeforeReply = harness.stats().previewDismissals === before + 1
        && previous.isCurrentRequest() === false;
      const retainedDraft = kind !== "dictionary-note" || !harness.driver.snapshot().popupHidden;
      const request = harness.take(kind === "term" ? "hd_lookup" : kind === "kanji" ? "hd_kanji" : "hd_lookup_dictionary");
      if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term("食")],
        kanji: { character: "食", entries: [{ dictionary: "Generic" }] } });
      await operation;
      cases.push(dismissedBeforeReply && retainedDraft);
      harness.close();
    }
    const focused = await createHarness();
    await focused.initialLookup();
    const link = focused.popup.ownerDocument.createElement("a");
    link.href = "#";
    link.textContent = "Keyboard image owner";
    focused.popup.appendChild(link);
    focused.driver.scheduleHide();
    const pendingBeforeFocus = focused.driver.hideTimerPending();
    link.focus();
    const focusCancelledHide = !focused.driver.hideTimerPending();
    focused.driver.scheduleHide();
    const stayedUnscheduled = !focused.driver.hideTimerPending();
    link.blur();
    await focused.settle();
    const leavingRearmed = focused.driver.hideTimerPending();
    await new Promise(done => setTimeout(done, 180));
    const hiddenAfterBlur = focused.driver.snapshot().popupHidden;
    await focused.initialLookup();
    link.focus();
    link.blur();
    focused.popup.replaceChildren();
    await focused.settle();
    const replacementDidNotScheduleHide = !focused.driver.hideTimerPending();
    focused.close();
    return {
      "new term or kanji requests and settings invalidation dismiss previews before their replies": cases.every(Boolean),
      "popup keyboard focus cancels hover dismissal and leaving focus rearms it": pendingBeforeFocus
        && focusCancelledHide && stayedUnscheduled && leavingRearmed && hiddenAfterBlur,
      "replacing focused popup content does not schedule dismissal of its refreshed view": replacementDidNotScheduleHide,
    };
  }

  async function boundedMediaCase() {
    const result = {};
    const url = "data:image/png;base64,YQ==";
    const load = (harness, path) => {
      const context = harness.render().context;
      return context.resolveMedia({
        dictionary: "Generic", generation: context.generation, path,
        isCurrent: context.isCurrentRequest,
      }).catch(() => null);
    };
    const count = (harness) => harness.sent.filter(({ type }) => type === "hd_media").length;
    const reply = (harness, request, dataUrl = url) => harness.reply(request, { dataUrl });
    async function drain(harness) {
      for (;;) {
        const request = harness.take("hd_media");
        if (!request) return;
        reply(harness, request);
        await harness.settle();
      }
    }
    async function fetch(harness, path, dataUrl = url) {
      const operation = load(harness, path);
      const request = harness.take("hd_media");
      if (request) reply(harness, request, dataUrl);
      return { value: await operation, fetched: request !== null };
    }

    const capacity = await createHarness();
    await capacity.initialLookup();
    const jobs = Array.from({ length: 132 }, (_, index) => load(capacity, `capacity-${index}.png`));
    const deduped = load(capacity, "capacity-0.png");
    const firstDispatch = count(capacity);
    reply(capacity, capacity.take("hd_media"));
    await capacity.settle();
    const nextDispatch = count(capacity);
    await drain(capacity);
    const values = await Promise.all(jobs);
    result["media admits 128 total jobs, dispatches four, and deduplicates even at capacity"] =
      firstDispatch === 4 && nextDispatch === 5 && count(capacity) === 128
        && values.slice(0, 128).every((value) => value === url)
        && values.slice(128).every((value) => value === null) && await deduped === url;
    capacity.close();

    const timeout = await createHarness();
    await timeout.initialLookup();
    const clock = timeout.installMediaClock();
    const timedJobs = Array.from({ length: 6 }, (_, index) => load(timeout, `timeout-${index}.png`));
    const firstTimers = clock.size();
    const expiredRequest = timeout.take("hd_media");
    const expired = clock.expireFirst();
    await timeout.settle();
    const dispatchedAfterTimeout = count(timeout);
    const timersAfterTimeout = clock.size();
    reply(timeout, expiredRequest);
    await timeout.settle();
    const dispatchedAfterLateReply = count(timeout);
    const retry = load(timeout, "timeout-0.png");
    await drain(timeout);
    const timedValues = await Promise.all(timedJobs);
    result["media timeout starts at dispatch and a late reply cannot free capacity twice or poison retry"] =
      firstTimers === 4 && expired && dispatchedAfterTimeout === 5 && timersAfterTimeout === 4
        && dispatchedAfterLateReply === 5 && timedValues[0] === null
        && await retry === url && count(timeout) === 7 && clock.size() === 0;
    timeout.close();

    const superseded = await createHarness();
    await superseded.initialLookup();
    const obsolete = Array.from({ length: 128 }, (_, index) => load(superseded, `old-${index}.png`));
    await superseded.initialLookup();
    const reattached = load(superseded, "old-4.png");
    const fresh = load(superseded, "fresh.png");
    await drain(superseded);
    const oldValues = await Promise.all(obsolete);
    const startedCache = await fetch(superseded, "old-0.png");
    result["new views reattach matching queued media and prune obsolete work before capacity rejection"] =
      count(superseded) === 6 && oldValues.every((value) => value === null)
        && await reattached === url && await fresh === url && !startedCache.fetched && startedCache.value === url;
    superseded.close();

    const shared = await createHarness();
    await shared.initialLookup();
    const occupied = Array.from({ length: 4 }, (_, index) => load(shared, `occupied-${index}.png`));
    const parent = load(shared, "shared.png");
    let childCurrent = true;
    const child = shared.render().context.resolveMedia({
      dictionary: "Generic", generation: 2, path: "shared.png", isCurrent: () => childCurrent,
    }).catch(() => null);
    childCurrent = false;
    await drain(shared);
    await Promise.all(occupied);
    result["a retired child cannot cancel queued media still owned by its parent"] =
      await parent === url && await child === null && count(shared) === 5;
    shared.close();

    const invalidations = [];
    for (const kind of ["dictionary", "teardown"]) {
      const harness = await createHarness();
      await harness.initialLookup();
      const timers = harness.installMediaClock();
      let settled = 0;
      const pending = Array.from({ length: 8 }, (_, index) => load(harness, `invalidated-${index}.png`)
        .then((value) => { settled += 1; return value; }));
      if (kind === "teardown") harness.driver.teardown();
      else harness.emitState(harness.state(2, "new generation"));
      await harness.settle();
      const settledImmediately = settled === 8 && timers.size() === 0;
      await drain(harness);
      const rejected = (await Promise.all(pending)).every((value) => value === null);
      invalidations.push(settledImmediately && rejected && count(harness) === 4);
      harness.close();
    }
    result["resource invalidation and teardown settle all media without dispatching obsolete queued work"] =
      invalidations.every(Boolean);

    const entries = await createHarness();
    await entries.initialLookup();
    for (let index = 0; index < 64; index += 1) await fetch(entries, `entry-${index}.png`);
    const exactEntries = await fetch(entries, "entry-0.png");
    await fetch(entries, "entry-64.png");
    const promoted = await fetch(entries, "entry-0.png");
    const evicted = await fetch(entries, "entry-1.png");
    result["media LRU accepts exactly 64 entries and promotes hits before evicting the oldest"] =
      !exactEntries.fetched && !promoted.fetched && evicted.fetched && count(entries) === 66;
    entries.close();

    const bytes = await createHarness();
    await bytes.initialLookup();
    const largeUrl = `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024).toString("base64")}`;
    for (let index = 0; index < 4; index += 1) await fetch(bytes, `bytes-${index}.png`, largeUrl);
    const exactBytes = await fetch(bytes, "bytes-0.png", largeUrl);
    await fetch(bytes, "one-byte.png");
    const promotedBytes = await fetch(bytes, "bytes-0.png", largeUrl);
    const evictedBytes = await fetch(bytes, "bytes-1.png", largeUrl);
    bytes.emitState(bytes.state(2, "new generation"));
    await bytes.initialLookup();
    for (let index = 0; index < 4; index += 1) await fetch(bytes, `reset-${index}.png`, largeUrl);
    const afterClear = await fetch(bytes, "reset-0.png", largeUrl);
    result["media LRU measures decoded bytes, accepts exactly 16 MiB, and resets accounting on invalidation"] =
      !exactBytes.fetched && !promotedBytes.fetched && evictedBytes.fetched && !afterClear.fetched;
    bytes.close();
    return result;
  }

  async function externalLinksCase() {
    const harness = await createHarness();
    try {
      await harness.initialLookup();
      harness.edit(true);
      const open = harness.render().context.onExternalLink;
      if (typeof open !== "function") return false;
      const before = JSON.stringify({ snapshot: harness.driver.snapshot(), stats: harness.stats() });
      const descriptor = harness.driver.viewRequest();
      const sentBefore = harness.sent.length;
      for (const kind of ["success", "failure", "lost-reply"]) {
        open({ url: "https://example.test/reference", active: false });
        const item = harness.take("hd_open_external");
        if (item?.request.target !== "hoshidicts-worker" || item.request.active !== false
            || item.request.url !== "https://example.test/reference") return false;
        if (kind === "lost-reply") item.callback(undefined);
        else harness.reply(item, kind === "success" ? { opened: true } : { error: "tab creation failed" }, kind === "success");
        await harness.settle();
      }
      return harness.sent.length === sentBefore + 3 && harness.pending.length === 0
        && harness.driver.viewRequest() === descriptor
        && JSON.stringify({ snapshot: harness.driver.snapshot(), stats: harness.stats() }) === before;
    } finally { harness.close(); }
  }

  return {
    callbacksWired,
    externalLinks: await externalLinksCase(),
    scanning: { ...await pendingScanCase(), ...await scanExtractionCase(), ...await focusedEditingCase(), ...await shadowEditingCase(),
      ...await exactSelectionCase(), ...await selectionCancellationCase(), ...await selectionRecoveryCase(),
      ...await releasedSelectionDragCase(),
      ...await selectedTextCase(), ...await selectionDescriptorCase(), ...await selectionInvalidationCase(),
      ...await selectionEditingCase(), ...await popupSelectionCase() },
    activation: await activationCase(),
    mediaOwnership: { ...await mediaOwnershipCase(), ...await imageSourceRoutingCase(), ...await boundedMediaCase(), ...await previewInvalidationCase(),
      ...await nestedLevelsCase(), ...await livePresentationCase(), ...await inheritedTabsCase(), ...await nestedResizeCase(), ...await columnPreferenceCase(), ...await nestedNotesCase(), ...await nestedPointerCase(), ...await nestedReplyRaceCase(),
      ...await retainedParentNavigationCase() },
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

  const sandbox = createContext({ window, document, console, URL: window.URL, globalThis: undefined });
  sandbox.globalThis = sandbox;
  sandbox.window = window;
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js"]) {
    runInContext(readFileSync(resolve(EXTENSION, file), "utf8"), sandbox, { filename: file });
  }
  const HDGlossary = sandbox.HDGlossary ?? window.HDGlossary;
  const HDPopup = sandbox.HDPopup ?? window.HDPopup;
  check("render/glossary.js publishes HDGlossary", Boolean(HDGlossary), "HDGlossary was undefined");
  check("render/popup.js publishes HDPopup", Boolean(HDPopup), "HDPopup was undefined");
  if (!HDGlossary || !HDPopup) {
    return false;
  }

  const summaryRaw = JSON.stringify([{ type: "structured-content", content: [
    { tag: "span", data: { content: "part-of-speech" }, content: "noun" },
    { tag: "img", path: "media/kanji.png", width: 16, height: 16, collapsed: true },
    { tag: "ul", data: { content: "glossary" }, content: [
      { tag: "li", content: "first • • second" }, { tag: "li", content: "third" },
    ] },
    { tag: "div", data: { content: "example" }, content: "not a definition" },
  ] }]);
  const summaryGlossaries = [
    { dictionary: "Plain", glossary: JSON.stringify(["plain first", "plain second"]) },
    { dictionary: "Illustrated", glossary: summaryRaw },
  ];
  const summaryBefore = JSON.stringify(summaryGlossaries);
  const compact = HDPopup.extractCompactDefinitionSummary(summaryGlossaries, "Illustrated", 2);
  const fallback = HDPopup.extractCompactDefinitionSummary(summaryGlossaries, "Absent", 1);
  const lateImage = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Late", glossary: JSON.stringify([
    "text before image", { type: "image", path: "media/kanji.png" },
  ]) }]);
  const nonImageLeads = [0, false, { type: "text", content: "prefix" },
    { type: "text", tag: "img", text: "prefix", path: "wrong.png" },
    { type: "structured-content", tag: "img", content: "prefix", path: "wrong.png" },
  ].map(lead => HDPopup.extractCompactDefinitionSummary([{ dictionary: "Leading text", glossary: JSON.stringify([
    lead, { type: "image", path: "late.png" }, "definition",
  ]) }]));
  const bulletText = ("first • first • second • " + "unused • ".repeat(50000)).trim();
  const longText = "長😀".repeat(50000);
  const duplicateText = "a".repeat(200) + " • " + "a".repeat(200) + " • tail";
  sandbox.__summaryWork = { bulletText, longText, splitFragments: 0, codePoints: 0, emptyNormalizations: 0,
    largeNormalizations: 0, largeTrims: 0, matchedCodeUnits: 0, duplicateText, duplicateMatches: 0,
    countDuplicateBoundaries: false, duplicateBoundaries: 0, duplicatePointArrays: 0, spanNormalizations: 0 };
  runInContext(`
    (() => {
      const split = String.prototype.split;
      const at = Array.prototype.at;
      const from = Array.from;
      const replace = String.prototype.replace;
      const trim = String.prototype.trim;
      const toLowerCase = String.prototype.toLowerCase;
      const codePointAt = String.prototype.codePointAt;
      const exec = RegExp.prototype.exec;
      const iterator = String.prototype[Symbol.iterator];
      Array.prototype.at = function (...args) {
        if (__summaryWork.countDuplicateBoundaries) __summaryWork.duplicateBoundaries += 1;
        return at.apply(this, args);
      };
      Array.from = function (value, ...args) {
        if (__summaryWork.countDuplicateBoundaries && typeof value === "string") __summaryWork.duplicatePointArrays += 1;
        return from.call(this, value, ...args);
      };
      String.prototype.toLowerCase = function () {
        if (String(this) === "span") __summaryWork.spanNormalizations += 1;
        return toLowerCase.call(this);
      };
      String.prototype.split = function (...args) {
        const result = split.apply(this, args);
        if (String(this) === __summaryWork.bulletText) __summaryWork.splitFragments += result.length;
        return result;
      };
      String.prototype.replace = function (...args) {
        if (String(this).trim() === "") __summaryWork.emptyNormalizations += 1;
        if (String(this).length > 482) __summaryWork.largeNormalizations += 1;
        return replace.apply(this, args);
      };
      String.prototype.trim = function () {
        if (String(this).length > 482) __summaryWork.largeTrims += 1;
        return trim.call(this);
      };
      String.prototype.codePointAt = function (...args) {
        if (String(this) === __summaryWork.longText) __summaryWork.codePoints += 1;
        return codePointAt.apply(this, args);
      };
      RegExp.prototype.exec = function (...args) {
        const result = exec.apply(this, args);
        __summaryWork.matchedCodeUnits = Math.max(__summaryWork.matchedCodeUnits, result?.[0].length || 0);
        if (args[0] === __summaryWork.duplicateText) __summaryWork.duplicateMatches += 1;
        return result;
      };
      String.prototype[Symbol.iterator] = function* () {
        const observed = String(this) === __summaryWork.longText;
        for (const character of { [Symbol.iterator]: () => iterator.call(this) }) {
          if (observed) __summaryWork.codePoints += 1;
          yield character;
        }
      };
      globalThis.__restoreSummaryWork = () => {
        Array.prototype.at = at;
        Array.from = from;
        String.prototype.split = split;
        String.prototype.replace = replace;
        String.prototype.trim = trim;
        String.prototype.toLowerCase = toLowerCase;
        String.prototype.codePointAt = codePointAt;
        RegExp.prototype.exec = exec;
        String.prototype[Symbol.iterator] = iterator;
      };
    })();
  `, sandbox);
  let boundedSummaryWork, bulletSummary;
  try {
    bulletSummary = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Bullets",
      glossary: JSON.stringify([" • ".repeat(150000) + "first • second"]) }]);
    const bullets = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Bullets", glossary: JSON.stringify([bulletText]) }], null, 2);
    const long = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Long", glossary: JSON.stringify([longText]) }], null, 1);
    sandbox.__summaryWork.countDuplicateBoundaries = true;
    const repeated = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Repeated", glossary: JSON.stringify([duplicateText]) }]);
    sandbox.__summaryWork.countDuplicateBoundaries = false;
    sandbox.__summaryWork.spanNormalizations = 0;
    const afterEmptySenses = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Empty senses", glossary: JSON.stringify([
      ...Array.from({ length: 16 }, () => ({ tag: "span", content: Array.from({ length: 128 }, () => ({ tag: "span", content: "" })) })),
      "useful final sense",
    ]) }], null, 1);
    boundedSummaryWork = JSON.stringify(bullets?.items) === JSON.stringify(["first", "second"])
      && long?.items[0] === "長😀".repeat(119) + "長…"
      && sandbox.__summaryWork.splitFragments === 0 && sandbox.__summaryWork.codePoints <= 241
      && sandbox.__summaryWork.emptyNormalizations === 0 && sandbox.__summaryWork.largeNormalizations === 0
      && sandbox.__summaryWork.largeTrims === 0 && sandbox.__summaryWork.matchedCodeUnits <= 482
      && JSON.stringify(repeated?.items) === JSON.stringify(["a".repeat(200), "tail"])
      && sandbox.__summaryWork.duplicateMatches <= 6 && sandbox.__summaryWork.duplicateBoundaries <= 3
      && sandbox.__summaryWork.duplicatePointArrays === 0
      && JSON.stringify(afterEmptySenses?.items) === JSON.stringify(["useful final sense"])
      // Original tag work plus 256 records classified by the marked-section
      // visibility pass; neither number is a product input cap.
      && sandbox.__summaryWork.spanNormalizations <= 2832 + 256;
  } finally { sandbox.__restoreSummaryWork(); }
  const summaryWork = { splitFragments: sandbox.__summaryWork.splitFragments, codePoints: sandbox.__summaryWork.codePoints,
    emptyNormalizations: sandbox.__summaryWork.emptyNormalizations, largeNormalizations: sandbox.__summaryWork.largeNormalizations,
    largeTrims: sandbox.__summaryWork.largeTrims, matchedCodeUnits: sandbox.__summaryWork.matchedCodeUnits,
    duplicateMatches: sandbox.__summaryWork.duplicateMatches, duplicateBoundaries: sandbox.__summaryWork.duplicateBoundaries,
    duplicatePointArrays: sandbox.__summaryWork.duplicatePointArrays, spanNormalizations: sandbox.__summaryWork.spanNormalizations };
  delete sandbox.__summaryWork;
  delete sandbox.__restoreSummaryWork;
  const duplicate = "a".repeat(200);
  const streamedText = [
    { content: ["pre", { tag: "div", content: "" }, "fix"], items: ["prefix"] },
    { content: ["pre", { tag: "div", content: " \r\n" }, "fix"], items: ["pre fix"] },
    { content: ["a".repeat(238), "\ud83d", "\ude00", "z"], items: ["a".repeat(238) + "😀z"] },
    { content: ["a".repeat(238), "\ud83d", "\ude00", "zq"], items: ["a".repeat(238) + "😀…"] },
    { content: ["a".repeat(239) + "\ud83d", "\ude00z"], items: ["a".repeat(239) + "…"] },
    { content: ["a".repeat(240), " \r\n"], items: ["a".repeat(240)] },
    { content: [duplicate, " • ", duplicate, " • tail"], items: [duplicate, "tail"] },
  ].every(({ content, items }) => JSON.stringify(HDPopup.extractCompactDefinitionSummary([{ dictionary: "Stream",
    glossary: JSON.stringify({ tag: "ul", content: { tag: "li", content } }) }])?.items) === JSON.stringify(items));
  const mixedSenses = [
    ["first sense", { tag: "p", content: "second sense" }],
    [{ tag: "p", content: "first sense" }, "second sense"],
    [{ type: "text", text: "first sense" }, { tag: "p", content: "second sense" }],
    [{ type: "structured-content", content: { tag: "div", content: [
      { tag: "p", content: "first sense" }, { tag: "p", content: "second sense" },
    ] } }],
  ].map(senses => HDPopup.extractCompactDefinitionSummary([{ dictionary: "Mixed", glossary: JSON.stringify(senses) }])?.items);
  const brokenLines = [
    { tag: "p", content: ["first", { tag: "br" }, "second"] },
    { tag: "p", content: ["first", { tag: "br", content: "not rendered" }, "second"] },
    { tag: "p", data: { content: "glossary" }, content: ["first", { tag: "br" }, "second"] },
    { tag: "ul", content: { tag: "li", content: ["first", { tag: "br" }, "second"] } },
  ].map(content => HDPopup.extractCompactDefinitionSummary([{ dictionary: "Line breaks",
    glossary: JSON.stringify([{ type: "structured-content", content }]) }])?.items);
  const ruby = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Ruby", glossary: JSON.stringify([
    { tag: "p", content: [
      { tag: "ruby", content: ["食", { tag: "rp", content: "(" },
        { tag: "rt", content: "た" }, { tag: "rp", content: ")" }] }, "べる (literal)",
    ] },
  ]) }]);
  const phantomList = { tag: "ul", content: { tag: "li", content: "not rendered" } };
  const renderedDispatch = [
    ...["br", "img", "script", "button", "input", "source"].map(tag => [{ tag, content: phantomList }, "visible"]),
    [{ type: "text", tag: "img", text: "visible", content: phantomList }],
    [{ type: "text", tag: "br", text: "visible", content: phantomList }],
    [{ type: "text", tag: "rp", text: "visible", content: phantomList }],
    [{ type: "structured-content", tag: "img", content: "visible" }],
  ].map(content => HDPopup.extractCompactDefinitionSummary([{ dictionary: "Dispatch", glossary: JSON.stringify(content) }])?.items);
  const imageAfterBreak = HDPopup.extractCompactDefinitionSummary([{ dictionary: "Break image", glossary: JSON.stringify([
    { tag: "br", content: "not rendered" }, { tag: "img", path: "leading.png" }, "visible",
  ]) }]);
  check("compact summaries preserve ordered text, split nonempty bullets and select only a leading image without changing full glossaries",
    JSON.stringify(compact?.items) === JSON.stringify(["first", "second"])
      && compact?.dictionary === "Illustrated" && compact?.image?.path === "media/kanji.png"
      && JSON.stringify(fallback?.items) === JSON.stringify(["plain first"])
      && !lateImage?.image && JSON.stringify(bulletSummary?.items) === JSON.stringify(["first", "second"])
      && nonImageLeads.every(summary => !summary?.image)
      && JSON.stringify(summaryGlossaries) === summaryBefore && boundedSummaryWork && streamedText
      && mixedSenses.every(items => JSON.stringify(items) === JSON.stringify(["first sense", "second sense"]))
      && brokenLines.every(items => JSON.stringify(items) === JSON.stringify(["first second"]))
      && JSON.stringify(ruby?.items) === JSON.stringify(["食べる (literal)"])
      && renderedDispatch.every(items => JSON.stringify(items) === JSON.stringify(["visible"]))
      && imageAfterBreak?.image?.path === "leading.png",
    JSON.stringify({ compact, fallback, lateImage, bulletSummary, nonImageLeads, summaryWork, streamedText, mixedSenses, brokenLines, ruby, renderedDispatch, imageAfterBreak }));

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
  const explanation = headword?.querySelector(".gsm-hoshidicts-deinflection");
  check("the real deinflection endpoints and ordered native trace render in a collapsed disclosure",
    explanation?.open === false
      && explanation.querySelector("summary").textContent === `${lookup.results[0].matched} → ${lookup.results[0].deinflected}`
      && JSON.stringify([...explanation.querySelectorAll("ol > li")].map((item) => [
        item.querySelector(".gsm-hoshidicts-deinflection-step-name").textContent,
        item.querySelector(".gsm-hoshidicts-deinflection-step-description")?.textContent ?? "",
      ])) === JSON.stringify(lookup.results[0].trace.map(({ name, description }) => [name, description])),
    explanation?.outerHTML ?? "missing disclosure");
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
  const tabResults = structuredClone(noteResults);
  tabResults[0].term.glossaries.push({ ...glossary, dictionary: "Dictionary C" });
  const originalTabResults = JSON.stringify(tabResults);
  const tabSelections = [];
  const tabContext = {
    dictionaryPresentation: [
      { title: "Dictionary A", displayName: "All", favorite: true },
      { title: "Dictionary B", displayName: "Favourite B", favorite: true },
      { title: "Missing", favorite: true },
    ],
    dictionaryTabGroups: [
      { id: "bc", name: "Favourite B", dictionaries: ["Dictionary B", "Dictionary C"] },
      { id: "a", name: "Favourites", dictionaries: ["Dictionary A"] },
      { id: "empty", name: "Empty", dictionaries: ["Missing"] },
    ],
    onDictionaryTabSelected(selection) { tabSelections.push(selection); },
  };
  view.renderResults(tabResults, candidate, tabContext);
  const allTabs = [...popup.querySelectorAll('[role="tab"]')];
  check("dictionary tabs include every contributor, aggregate favourites and ordered nonempty groups",
    JSON.stringify(allTabs.map((tab) => [tab.textContent, { ...tab.dataset }])) === JSON.stringify([
      ["All", {}],
      ["All (dictionary)", { dictionary: "Dictionary A" }],
      ["Dictionary C", { dictionary: "Dictionary C" }],
      ["Favourite B", { dictionary: "Dictionary B" }],
      ["Favourites", { favourites: "true" }],
      ["Favourite B (group)", { groupId: "bc" }],
      ["Favourites (group)", { groupId: "a" }],
    ]), JSON.stringify(allTabs.map((tab) => [tab.textContent, { ...tab.dataset }])));
  const tabProjections = [];
  for (const selector of [
    '[data-dictionary="Dictionary B"]', '[data-favourites="true"]',
    '[data-group-id="bc"]', '[data-group-id="a"]',
  ]) {
    const tab = popup.querySelector(`[role="tab"]${selector}`);
    tab?.click();
    popup.querySelector(".gsm-hoshidicts-show-more")?.click();
    tabProjections.push([...popup.querySelectorAll(".gsm-hoshidicts-glossary-card > summary")]
      .map((summary) => summary.title));
  }
  const sameTabPanel = popup.querySelector(".gsm-hoshidicts-tab-panel").firstElementChild;
  const beforeSameTab = positioned;
  popup.querySelector('[role="tab"][data-group-id="a"]')?.click();
  check("dictionary, favourites and group tabs project locally in native order without mutating results",
    JSON.stringify(tabProjections) === JSON.stringify([
      ["Dictionary B"], ["Dictionary A", "Dictionary B"],
      ["Dictionary C", "Dictionary B"], ["Dictionary A"],
    ])
      && JSON.stringify(tabSelections) === JSON.stringify([
        null, { dictionary: "Dictionary B" }, { favourites: true }, { groupId: "bc" }, { groupId: "a" },
      ])
      && JSON.stringify(tabResults) === originalTabResults
      && sameTabPanel === popup.querySelector(".gsm-hoshidicts-tab-panel").firstElementChild
      && positioned === beforeSameTab,
    JSON.stringify({ tabProjections, tabSelections, positioned, beforeSameTab }));
  const inheritedProjections = [];
  for (const selection of [
    { dictionary: "Dictionary C" }, { groupId: "bc" }, { favourites: true }, { groupId: "empty" },
  ]) {
    let selected;
    const context = { ...tabContext, selectedDictionaryTab: selection, expandAll: true,
      onDictionaryTabSelected(value) { selected = value; } };
    view.renderResults(tabResults, candidate, context);
    inheritedProjections.push([selected,
      [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card > summary")].map((item) => item.title)]);
    selected = undefined;
    view.renderKanji({ ...kanji, entries: ["Dictionary A", "Dictionary C", "Dictionary B"]
      .map((dictionary) => ({ ...kanji.entries[0], dictionary })) }, candidate, context);
    inheritedProjections.push([selected,
      [...popup.querySelectorAll(".gsm-hoshidicts-kanji-entry")].map((item) => item.dataset.dictionary)]);
  }
  check("term and native-kanji destinations adopt contributing tab context or explicitly fall back to All",
    JSON.stringify(inheritedProjections) === JSON.stringify([
      [{ dictionary: "Dictionary C" }, ["Dictionary C"]], [{ dictionary: "Dictionary C" }, ["Dictionary C"]],
      [{ groupId: "bc" }, ["Dictionary C", "Dictionary B"]], [{ groupId: "bc" }, ["Dictionary C", "Dictionary B"]],
      [{ favourites: true }, ["Dictionary A", "Dictionary B"]], [{ favourites: true }, ["Dictionary A", "Dictionary B"]],
      [null, ["Dictionary A", "Dictionary C", "Dictionary B"]], [null, ["Dictionary A", "Dictionary C", "Dictionary B"]],
    ]), JSON.stringify(inheritedProjections));
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
  let scrollAtNoteFocus;
  popup.addEventListener("focus", () => { scrollAtNoteFocus = popup.scrollTop; }, { capture: true, once: true });
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
      && scrollAtNoteFocus === popup.scrollHeight
      && popup.children[0] === resultToolbar
      && popup.children[1] === bottomNoteForm,
    JSON.stringify({
      bottomOrder: bottomChildren.map(({ className }) => className),
      openedAtBottom,
      scrollAtNoteFocus,
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
  const scrollProperty = Object.getOwnPropertyDescriptor(window.Element.prototype, "scrollTop");
  let scrollWrites = 0;
  Object.defineProperty(popup, "scrollTop", {
    configurable: true,
    get() { return scrollProperty.get.call(this); },
    set(value) { scrollWrites += 1; scrollProperty.set.call(this, value); },
  });
  popup.hidden = true;
  view.clear();
  const hiddenCleared = popup.childElementCount === 0 && scrollWrites === 0;
  popup.hidden = false;
  const visibleResets = [
    () => view.renderNotice("nothing found", candidate),
    () => view.renderKanji(kanji, candidate),
    () => view.renderResults(lookup.results, candidate),
  ].map((render) => {
    popup.scrollTop = 120;
    scrollWrites = 0;
    render();
    return scrollWrites > 0 && popup.scrollTop === 0;
  });
  check("clear empties hidden popups without scrolling and every visible view resets scroll",
    hiddenCleared && visibleResets.every(Boolean), JSON.stringify({ hiddenCleared, visibleResets }));
  delete popup.scrollTop;
  view.clear();
  await imagePreviewStage({ view, popup, shadow, document, window, candidate,
    calculatePopupPosition: HDPopup.calculatePopupPosition,
    result: imageLookup.results[0], mediaUrl: media.dataUrl });
  structuredRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  externalLinksRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  internalLinksRenderStage({ HDGlossary, document, window });
  await retainedNavigationRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  await deinflectionRenderStage({ HDGlossary, HDPopup, document, window, candidate, result: lookup.results[0] });
  await mediaRenderStage({ HDGlossary, document, window });
  await compactSummaryRenderStage({ HDGlossary, HDPopup, document, window, candidate,
    result: lookup.results[0], mediaUrl: media.dataUrl, summaryGlossaries });
  await imageSourceRenderStage({ HDGlossary, HDPopup, document, window, candidate,
    result: lookup.results[0], mediaUrl: media.dataUrl, summaryGlossaries });
  dom.window.close();
  return true;
}

async function compactSummaryRenderStage({ HDGlossary, HDPopup, document, window, candidate, result, mediaUrl, summaryGlossaries }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const projected = { ...result, term: { ...result.term, glossaries: summaryGlossaries } };
  const original = JSON.stringify(projected);
  const mediaRequests = [];
  let finishMedia;
  const pendingMedia = new Promise(resolve => { finishMedia = resolve; });
  let positions = 0;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    appendStructuredImage: HDGlossary.appendStructuredImage,
    parseTagList: HDGlossary.parseTagList, positionPopup() { positions += 1; },
  });
  const context = { generation: 23, dictionaryPresentation: [], dictionaryTabGroups: [],
    resolveMedia(query) { mediaRequests.push(query); return pendingMedia; },
    showCompactDefinitionSummary: false, compactDefinitionSummaryCount: 2,
    compactDefinitionSummaryDictionary: "Illustrated" };
  try {
    view.renderResults([projected], candidate, context);
    const absent = popup.querySelector(".gsm-hoshidicts-compact-definition-summary") === null && mediaRequests.length === 1;
    const cards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
    const bodies = cards.map(card => card.textContent);
    const expression = popup.querySelector(".gsm-hoshidicts-expression");
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const note = popup.querySelector(".gsm-hoshidicts-note-form");
    const input = note.querySelector(".gsm-hoshidicts-note-definition");
    input.value = "retained draft";
    input.focus();
    input.setSelectionRange(2, 6);
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true });
    const summary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
    const image = summary?.querySelector("img");
    const live = summary?.dataset.hoshidictsDictionary === "Illustrated"
      && JSON.stringify([...summary.querySelectorAll("li")].map(node => node.textContent)) === JSON.stringify(["first", "second"])
      && image && mediaRequests.length === 2 && mediaRequests[1].generation === 23
      && mediaRequests[1].dictionary === "Illustrated" && mediaRequests[1].isCurrent()
      && image.closest(".gloss-image-link").dataset.collapsed === "false"
      && popup.querySelector(".gsm-hoshidicts-glossary-content .gloss-image-link").dataset.collapsed === "true";
    const retained = popup.querySelector(".gsm-hoshidicts-expression") === expression
      && popup.querySelector(".gsm-hoshidicts-note-form") === note && document.activeElement === input
      && input.value === "retained draft" && input.selectionStart === 2 && input.selectionEnd === 6
      && cards.every((card, index) => card.isConnected && card.textContent === bodies[index]);
    view.updateDictionaryPresentation({ dictionaryPresentation: [], dictionaryTabGroups: [] });
    const unchangedSummary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary") === summary
      && mediaRequests.length === 2;
    view.updateDictionaryPresentation(context);
    const obsolete = image && !image.isConnected && mediaRequests[1].isCurrent() === false;
    await new Promise(done => window.setTimeout(done, 40));
    const beforeReply = positions;
    finishMedia(mediaUrl);
    await new Promise(done => window.setTimeout(done, 0));
    const oldImageUntouched = !image?.getAttribute("src");
    // The full-card consumer remains current; only its actual load can position.
    const noLatePosition = positions === beforeReply;
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true,
      compactDefinitionSummaryDictionary: "Absent", compactDefinitionSummaryCount: 1 });
    const fallback = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
    const fallbackText = fallback?.textContent;
    const fullImageLink = popup.querySelector(".gsm-hoshidicts-glossary-content .gloss-image-link");
    fullImageLink.dispatchEvent(new window.Event("mouseenter"));
    const fullPreview = popup.parentNode.querySelector(".gsm-hoshidicts-image-hover-preview");
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true,
      compactDefinitionSummaryDictionary: "Absent", compactDefinitionSummaryCount: 2 });
    const previewKept = fullPreview?.isConnected === true;
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true });
    await new Promise(done => window.setTimeout(done, 0));
    const focusedThumbnail = popup.querySelector(".gsm-hoshidicts-compact-definition-summary .gloss-image-link");
    focusedThumbnail.focus();
    view.updateDictionaryPresentation({ ...context, showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3 });
    const summaryFocusKept = document.activeElement === focusedThumbnail && focusedThumbnail.isConnected
      && popup.querySelectorAll(".gsm-hoshidicts-compact-definition-summary li").length === 2;
    focusedThumbnail.blur();
    await new Promise(done => window.setTimeout(done, 0));
    const summaryFlushed = popup.querySelectorAll(".gsm-hoshidicts-compact-definition-summary li").length === 3;
    const failedThumbnails = [];
    for (const failure of ["missing", "rejected", "decode"]) {
      view.renderResults([projected], candidate, { ...context, showCompactDefinitionSummary: true,
        resolveMedia() {
          if (failure === "rejected") return Promise.reject(new Error("missing dictionary image"));
          return failure === "missing" ? null : mediaUrl;
        },
      });
      await new Promise(done => window.setTimeout(done, 0));
      if (failure === "decode") {
        for (const failedImage of popup.querySelectorAll("img")) {
          failedImage.dispatchEvent(new window.Event("error"));
        }
      }
      const textSummary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
      const fullCardError = popup.querySelector(".gsm-hoshidicts-glossary-content .gloss-image-link");
      failedThumbnails.push(textSummary?.querySelector(".gsm-hoshidicts-compact-definition-image") === null
        && JSON.stringify([...textSummary.querySelectorAll("li")].map(node => node.textContent)) === JSON.stringify(["first", "second"])
        && fullCardError?.dataset.imageLoadState === "load-error"
        && fullCardError.textContent.includes("Image failed to load"));
    }
    check("live compact summaries preserve Note and cards while retiring only their own media and falling back within projected results",
      absent && live && retained && unchangedSummary && obsolete && oldImageUntouched && noLatePosition
        && fallbackText === "plain first" && fallback.dataset.hoshidictsDictionary === "Plain" && previewKept
        && summaryFocusKept && summaryFlushed && failedThumbnails.every(Boolean)
        && JSON.stringify(projected) === original,
      JSON.stringify({ absent, live: Boolean(live), retained, unchangedSummary, obsolete, oldImageUntouched, noLatePosition,
        fallback: fallback?.outerHTML, previewKept, summaryFocusKept, summaryFlushed, failedThumbnails,
        mediaRequests: mediaRequests.map(({ isCurrent, ...query }) => query) }));
  } finally {
    finishMedia(mediaUrl);
    view.destroy();
    popup.remove();
  }
}

async function imageSourceRenderStage({ HDGlossary, HDPopup, document, window, candidate, result, mediaUrl, summaryGlossaries }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const projected = { ...result, term: { ...result.term, glossaries: summaryGlossaries } };
  const requests = [];
  let sources = null;
  let current = true;
  let canUpdate = true;
  let admissions = 0;
  let fills = 0;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary(...args) { fills += 1; return HDGlossary.appendTextOnlyGlossary(...args); },
    appendStructuredImage: HDGlossary.appendStructuredImage,
    parseTagList: HDGlossary.parseTagList, positionPopup() {},
    canUpdateCompactSummary() { admissions += 1; return canUpdate; },
  });
  const context = { generation: 23, dictionaryPresentation: [{ title: "Pictures", displayName: "Picture book" }],
    dictionaryTabGroups: [], isCurrentRequest: () => current, isCurrentView: () => true,
    showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 2,
    compactDefinitionSummaryDictionary: "Illustrated", popupImageSources: sources,
    resolveMedia(query) {
      const supplier = sources?.[0] || query.dictionary;
      return new Promise((resolve, reject) => requests.push({ query, supplier, resolve, reject }));
    },
  };
  const tick = () => new Promise(done => window.setTimeout(done, 0));
  const route = (next, extra = {}) => {
    sources = next;
    Object.assign(context, { popupImageSources: sources }, extra);
    view.updateDictionaryPresentation({ ...context });
  };
  const settle = (pending, url = mediaUrl) => {
    for (const request of pending) {
      request.query.onResolvedSource?.(request.supplier);
      request.resolve(url);
    }
  };
  try {
    view.renderResults([projected], candidate, context);
    const automatic = requests.slice();
    const summary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
    const items = summary.querySelector("ul");
    const images = [...popup.querySelectorAll("img")];
    const links = images.map(image => image.closest(".gloss-image-link"));
    const listeners = [];
    const addImageListener = images[1].addEventListener;
    images[1].addEventListener = function (type, listener, options) {
      listeners.push({ type, listener });
      return addImageListener.call(this, type, listener, options);
    };
    const cards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
    const originalFills = fills;
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const form = popup.querySelector("form");
    form.elements.definition.value = "keep image-source draft";
    form.elements.definition.focus();
    form.elements.definition.setSelectionRange(2, 7);
    route(["Pictures"]);
    const replacement = requests.slice(automatic.length);
    const beforeAlias = requests.length;
    route(sources, { dictionaryPresentation: [{ title: "Pictures", displayName: "Renamed pictures" }] });
    settle(replacement);
    await tick();
    const suppliers = [...popup.querySelectorAll(".gloss-image-source")];
    const currentLoaded = replacement.length === 2 && replacement.every(({ query }) => query.isCurrent())
      && images.every(image => image.src === mediaUrl && !image.hidden)
      && suppliers.length === 2 && suppliers.every(label => label.textContent === "Image: Renamed pictures"
        && label.dataset.dictionary === "Pictures" && label.title === "Pictures")
      && !summary.querySelector(".gsm-hoshidicts-compact-definition-image .gloss-image-source");
    settle(automatic, "data:image/png;base64,b2xk");
    await tick();
    check("live image-source changes retain mounted cards and Note selection while rejecting old Automatic replies and relabelling the actual supplier",
      currentLoaded && requests.length === beforeAlias && automatic.every(({ query }) => !query.isCurrent())
        && images.every((image, index) => image.isConnected && image.src === mediaUrl && image.closest("a") === links[index])
        && cards.every(card => card.isConnected) && fills === originalFills && summary.querySelector("ul") === items
        && popup.querySelector("form") === form && document.activeElement === form.elements.definition
        && form.elements.definition.value === "keep image-source draft"
        && form.elements.definition.selectionStart === 2 && form.elements.definition.selectionEnd === 7,
      JSON.stringify({ currentLoaded, requests: requests.length, beforeAlias, fills, originalFills,
        suppliers: suppliers.map(label => label.outerHTML), replacement: replacement.length }));

    const oldListeners = listeners.slice();
    links[1].focus();
    const previewOpened = Boolean(popup.parentNode.querySelector(".gsm-hoshidicts-image-hover-preview"));
    const beforeFocusRoute = requests.length;
    route(["Focused supplier"]);
    for (const { listener } of oldListeners) listener();
    const pendingFocused = document.activeElement === links[1] && links[1].getAttribute("tabindex") === "0"
      && !links[1].hasAttribute("href") && links[1].dataset.imageLoadState === "not-loaded"
      && !popup.parentNode.querySelector(".gsm-hoshidicts-image-hover-preview");
    view.hideImagePreview();
    settle(requests.slice(beforeFocusRoute));
    await tick();
    images[1].dispatchEvent(new window.Event("load"));
    const dismissedKept = !popup.parentNode.querySelector(".gsm-hoshidicts-image-hover-preview");
    for (const { listener } of oldListeners) listener();
    check("image route refresh retains keyboard focus and ignores retired load/error callbacks without reviving a dismissed preview",
      previewOpened && pendingFocused && dismissedKept && document.activeElement === links[1]
        && !images[1].hidden && images[1].src === mediaUrl && links[1].dataset.imageLoadState === "loaded",
      JSON.stringify({ previewOpened, pendingFocused, dismissedKept }));
    delete images[1].addEventListener;
    const beforeFocusedFailure = requests.length;
    route(["Missing focused source"]);
    settle(requests.slice(beforeFocusedFailure), null);
    await tick();
    const failedStillFocused = document.activeElement === links[1] && links[1].dataset.imageLoadState === "load-error";
    links[1].blur();
    check("a failed refreshed image drops its temporary tab stop when keyboard focus leaves",
      failedStillFocused && !links[1].hasAttribute("href") && !links[1].hasAttribute("tabindex"));
    form.elements.definition.focus();

    const beforeAutomatic = requests.length;
    route(null);
    settle(requests.slice(beforeAutomatic), null);
    await tick();
    const failed = summary.querySelector(".gsm-hoshidicts-compact-definition-image") === null
      && !popup.querySelector(".gloss-image-source") && links[1].dataset.imageLoadState === "load-error";
    const beforeRecovery = requests.length;
    route(["Pictures"]);
    settle(requests.slice(beforeRecovery));
    await tick();
    check("a failed compact thumbnail recovers under a new image source without reparsing or replacing its summary, full image or Note draft",
      failed && requests.length === beforeRecovery + 2 && images.every(image => image.isConnected && !image.hidden && image.src === mediaUrl)
        && summary.querySelectorAll(".gsm-hoshidicts-compact-definition-image").length === 1
        && summary.querySelector("ul") === items && fills === originalFills
        && popup.querySelector("form") === form && !form.hidden && document.activeElement === form.elements.definition,
      JSON.stringify({ failed, beforeRecovery, requests: requests.length, summary: summary.outerHTML }));

    // A retained parent can accept aliases, but cannot restart asynchronous work.
    current = false;
    const beforeStale = requests.length;
    route(sources, { dictionaryPresentation: [{ title: "Pictures", displayName: "Retained alias" }] });
    const staleLabels = [...popup.querySelectorAll(".gloss-image-source")].every(label => label.textContent === "Image: Retained alias");
    route(["Other"]);
    check("retained image labels may refresh without admitting media for an obsolete request",
      staleLabels && requests.length === beforeStale && images.every(image => image.src === mediaUrl));
    current = true;
    const beforeRetry = requests.length;
    route(["Retry"]);
    const retired = requests.slice(beforeRetry);
    view.clear();
    settle(retired);
    await tick();
    check("clearing the projection retires all image refresh handles and their pending completions",
      retired.length === 2 && retired.every(({ query }) => !query.isCurrent())
        && !popup.hasChildNodes() && images.every(image => !image.isConnected));

    sources = null;
    const group = { id: "reading", name: "Reading", dictionaries: ["Illustrated", "Plain"] };
    Object.assign(context, { popupImageSources: null, dictionaryTabGroups: [group] });
    view.renderResults([projected], candidate, { ...context, selectedDictionaryTab: { groupId: group.id } });
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const protectedCards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
    const beforeProtected = requests.length;
    route(["Pictures"], { dictionaryTabGroups: [{ ...group, dictionaries: ["Plain"] }] });
    const protectedRequests = requests.slice(beforeProtected);
    settle(protectedRequests);
    await tick();
    const beforeOrphan = { requests: requests.length, admissions };
    canUpdate = false;
    route(null);
    check("image-source admission compares the applied route while protected tab membership still awaits projection",
      protectedRequests.length === 2 && protectedCards.every(card => card.isConnected)
        && admissions === beforeOrphan.admissions + 1 && requests.length === beforeOrphan.requests,
      JSON.stringify({ protectedRequests: protectedRequests.length, beforeOrphan, requests: requests.length, admissions }));
    canUpdate = true;
    route(["Pictures"], { dictionaryPresentation: [{ title: "Pictures", displayName: "Latest pictures" }] });
    const beforeTab = requests.length;
    popup.querySelector('[role="tab"][data-dictionary="Illustrated"]').click();
    settle(requests.slice(beforeTab));
    await tick();
    const projectedLabels = [...popup.querySelectorAll(".gloss-image-source")];
    const latestLabels = projectedLabels.length === 2
      && projectedLabels.every(label => label.textContent === "Image: Latest pictures");
    const beforeFlush = requests.length;
    view.flushDictionaryPresentation();
    check("local tab projection retains the latest image route and aliases without reloading again on deferred presentation flush",
      latestLabels && beforeFlush === beforeTab + 2 && requests.length === beforeFlush,
      JSON.stringify({ latestLabels, beforeTab, beforeFlush, requests: requests.length }));

    const replacementProjections = [];
    for (const title of ["Illustrated", "Plain"]) {
      sources = null;
      Object.assign(context, { popupImageSources: sources, dictionaryTabGroups: [group] });
      const beforeInitial = requests.length;
      view.renderResults([projected], candidate, { ...context, expandAll: true,
        selectedDictionaryTab: { groupId: group.id } });
      settle(requests.slice(beforeInitial));
      await tick();
      const oldCards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
      const beforeReplacement = requests.length;
      route(["Pictures"], { dictionaryTabGroups: [{ ...group, dictionaries: [title] }] });
      const pending = requests.slice(beforeReplacement);
      const expectedImages = title === "Illustrated" ? 2 : 0;
      replacementProjections.push(pending.length === expectedImages
        && pending.every(({ query, supplier }) => query.isCurrent() && supplier === "Pictures")
        && oldCards.every(card => !card.isConnected));
      settle(pending);
      await tick();
      replacementProjections.push(popup.querySelectorAll("img").length === expectedImages);
    }
    check("group membership and image-route changes load only the replacement projection's images",
      replacementProjections.every(Boolean), JSON.stringify(replacementProjections));

    const replacementSummaries = [];
    for (const enabled of [true, false]) {
      sources = null;
      Object.assign(context, { popupImageSources: sources, dictionaryTabGroups: [],
        showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 2 });
      const beforeInitial = requests.length;
      view.renderResults([projected], candidate, context);
      settle(requests.slice(beforeInitial));
      await tick();
      const oldSummary = popup.querySelector(".gsm-hoshidicts-compact-definition-summary");
      const oldCards = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-card")];
      const beforeReplacement = requests.length;
      route(["Pictures"], { showCompactDefinitionSummary: enabled, compactDefinitionSummaryCount: 3 });
      const pending = requests.slice(beforeReplacement);
      const expectedImages = enabled ? 2 : 1;
      replacementSummaries.push(pending.length === expectedImages
        && pending.every(({ query, supplier }) => query.isCurrent() && supplier === "Pictures")
        && !oldSummary.isConnected && oldCards.every(card => card.isConnected));
      settle(pending);
      await tick();
      replacementSummaries.push(popup.querySelectorAll("img").length === expectedImages);
    }
    check("combined summary and image-route changes load only retained or replacement images",
      replacementSummaries.every(Boolean), JSON.stringify(replacementSummaries));
  } finally {
    settle(requests);
    view.destroy();
    popup.remove();
  }
}

async function retainedNavigationRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  let current = true;
  let displayed = true;
  let links = 0;
  let fills = 0;
  let replays = 0;
  let selected = null;
  let replayIntent = null;
  let finishAppend;
  let appends = 0;
  const linkPredicates = [];
  const originalResizeObserver = window.ResizeObserver;
  const observedTargets = new Set();
  const observations = [];
  let observerDisconnects = 0;
  // Track the renderer's observation ownership, not native layout or heap size.
  window.ResizeObserver = class {
    observe(target) { observedTargets.add(target); }
    unobserve(target) { observedTargets.delete(target); }
    disconnect() { observerDisconnects += 1; observedTargets.clear(); }
  };
  function observeProjection(stage, expectedCount) {
    const currentTargets = [...popup.querySelectorAll(".gsm-hoshidicts-glossary-grid, .gsm-hoshidicts-glossary-card")];
    const detached = [...observedTargets].filter(target => !target.isConnected).length;
    observations.push({ stage, observed: observedTargets.size, current: currentTargets.length, detached,
      valid: observedTargets.size === expectedCount && currentTargets.length === expectedCount
        && currentTargets.every(target => target.isConnected && observedTargets.has(target)) });
  }
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary(...args) {
      fills += 1;
      linkPredicates.push(args[3].isCurrentLink);
      return HDGlossary.appendTextOnlyGlossary(...args);
    },
    parseTagList: HDGlossary.parseTagList, positionPopup() {},
    onBeforeResultsRendered(intent) { if (!current) { replays += 1; replayIntent = intent; return false; } },
    onAddCustomEntry() { appends += 1; return new Promise(resolve => { finishAppend = resolve; }); },
  });
  const results = ["First", "Second"].map((dictionary) => ({ ...result, term: { ...result.term,
    glossaries: [{ dictionary, glossary: JSON.stringify([{ type: "structured-content", content: {
      tag: "a", href: "?query=食", content: "linked word",
    } }]) }],
  } }));
  const context = { isCurrentRequest: () => current, isCurrentView: () => displayed,
    onInternalLink() { links += 1; }, onDictionaryTabSelected(value) { selected = value; },
    dictionaryPresentation: [{ title: "First", favorite: true }, { title: "Second", favorite: true }],
  };
  try {
    view.renderResults(results, candidate, { ...context, expandAll: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    const initialPredicates = linkPredicates.slice();
    const sharedPredicate = initialPredicates.length === 2
      && initialPredicates[0] === initialPredicates[1];
    const first = popup.querySelector("a[data-hoshidicts-query]");
    const initialFills = fills;
    current = false;
    first.click();
    popup.querySelector('[role="tab"][data-dictionary="Second"]').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const retained = links === 1 && replays === 1 && selected?.dictionary === "Second"
      && first.isConnected && fills === initialFills && initialPredicates.every(owns => owns());
    displayed = false;
    first.click();
    popup.querySelector('[role="tab"][data-dictionary="First"]').click();
    const obsoleteIgnored = links === 1 && replays === 1 && initialPredicates.every(owns => !owns());
    current = true;
    displayed = true;
    view.renderResults(results, candidate, context);
    popup.querySelector('[role="tab"][data-dictionary="Second"]').click();
    observeProjection("dictionary tab", 2);
    check("retained displayed links and stale-tab handoff never reenable obsolete glossary work",
      sharedPredicate && retained && obsoleteIgnored && replays === 1 && fills > initialFills
        && initialPredicates.every(owns => !owns()),
      JSON.stringify({ sharedPredicate, retained, obsoleteIgnored, links, replays, fills, initialFills }));

    const preserved = [];
    for (const toolbarPosition of ["top", "bottom"]) {
      view.setToolbarPosition(toolbarPosition);
      view.renderResults(results, candidate, context);
      current = false;
      popup.querySelector('[data-dictionary="Second"][role="tab"]').click();
      // Open after replay started: retain the live form, not request-start state.
      popup.querySelector(".gsm-hoshidicts-note-button").click();
      const form = popup.querySelector("form");
      const definition = form.elements.definition;
      definition.value = "keep this draft";
      definition.focus();
      definition.setSelectionRange(2, 7);
      const observer = new window.MutationObserver(() => {});
      observer.observe(popup, { childList: true });
      current = true;
      view.renderResults(results, candidate, { ...context, preserveViewControls: true,
        selectedDictionaryTab: { dictionary: "Second" } });
      preserved.push(popup.querySelector("form") === form && !form.hidden
        && definition.value === "keep this draft" && document.activeElement === definition
        && definition.selectionStart === 2 && definition.selectionEnd === 7
        && !observer.takeRecords().some(record => [...record.removedNodes].includes(form)));
      observer.disconnect();
      // A form opened before a replay and a pending save keep the same controls.
      form.elements.term.value = "saved";
      form.elements.reading.value = "reading";
      const beforeAppend = appends;
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      view.renderResults(results, candidate, { ...context, preserveViewControls: true });
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      preserved.push(popup.querySelector("form") === form && form.getAttribute("aria-busy") === "true"
        && form.elements.definition.disabled && appends === beforeAppend + 1);
      finishAppend();
      await new Promise(resolve => setTimeout(resolve, 0));
      const refreshed = [{ ...results[0], term: { ...results[0].term, expression: "new prefill", reading: "new reading" } }];
      view.renderResults(refreshed, candidate, { ...context, preserveViewControls: true });
      popup.querySelector(".gsm-hoshidicts-note-button").click();
      preserved.push(form.elements.term.value === "new prefill" && form.elements.reading.value === "new reading");
      view.closeNoteForm();

      view.renderResults(results, candidate, context);
      const oldTab = popup.querySelector('[data-dictionary="Second"][role="tab"]');
      oldTab.focus();
      view.renderResults(results, candidate, { ...context, preserveViewControls: true,
        selectedDictionaryTab: { dictionary: "Second" } });
      preserved.push(document.activeElement === popup.querySelector('[data-dictionary="Second"][role="tab"]'));
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      view.renderResults(results, candidate, { ...context, preserveViewControls: true });
      preserved.push(document.activeElement === outside);
      outside.remove();
    }
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const kanjiForm = popup.querySelector("form");
    kanjiForm.elements.definition.value = "draft during generic fallback";
    kanjiForm.elements.definition.focus();
    view.renderKanji({ character: "食", entries: [{ dictionary: "Kanji", tags: "", onyomi: "ショク",
      kunyomi: "", definitions: ["eat"], stats: [] }] }, candidate, { preserveViewControls: true, onBack() {} });
    preserved.push(popup.querySelector("form") === kanjiForm && !kanjiForm.hidden
      && document.activeElement === kanjiForm.elements.definition && kanjiForm.elements.definition.value === "draft during generic fallback");
    view.closeNoteForm();
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    preserved.push(kanjiForm.elements.term.value === "食" && kanjiForm.elements.reading.value === "");
    view.renderResults(results, candidate, context);
    preserved.push(!kanjiForm.isConnected && !popup.querySelector("form"));
    check("same-view refresh preserves mounted Note drafts, pending saves and response-time focus",
      preserved.every(Boolean), JSON.stringify(preserved));

    view.renderResults(results, candidate, context);
    current = false;
    const beforeReplay = replays;
    const beforeFills = fills;
    popup.querySelector(".gsm-hoshidicts-show-more").click();
    const expansionDelegated = replays === beforeReplay + 1 && replayIntent?.expandAll === true
      && fills === beforeFills && popup.querySelectorAll("article").length === 1;
    current = true;
    view.renderResults(results, candidate, { ...context, preserveViewControls: true, expandAll: true });
    const expanded = popup.querySelectorAll("article").length === 2 && !popup.querySelector(".gsm-hoshidicts-show-more");
    view.renderResults(results, candidate, context);
    popup.querySelector(".gsm-hoshidicts-show-more").click();
    observeProjection("Show more retains all current targets", 4);
    check("stale Show more replays fresh results while current expansion remains lookup-free",
      expansionDelegated && expanded && replays === beforeReplay + 1 && popup.querySelectorAll("article").length === 2);

    const live = [];
    const presentation = {
      dictionaryPresentation: [{ title: "First", displayName: "First alias", favorite: true }, { title: "Second", favorite: true }],
      dictionaryTabGroups: [{ id: "first", name: "First group", dictionaries: ["First"] },
        { id: "second", name: "Second group", dictionaries: ["Second"] }],
    };
    const firstGroup = '[role="tab"][data-group-id="first"]';
    const secondGroup = '[role="tab"][data-group-id="second"]';
    current = true;
    const writes = { selected: [], tabIndex: [], panelLabel: [] };
    const setAttribute = window.Element.prototype.setAttribute;
    const tabIndex = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "tabIndex");
    window.Element.prototype.setAttribute = function (name, value) {
      if (name === "aria-selected" && this.getAttribute("role") === "tab") writes.selected.push(this);
      if (name === "aria-labelledby" && this.classList.contains("gsm-hoshidicts-tab-panel")) writes.panelLabel.push(this);
      return setAttribute.call(this, name, value);
    };
    Object.defineProperty(window.HTMLElement.prototype, "tabIndex", { ...tabIndex,
      set(value) {
        if (this.getAttribute("role") === "tab") writes.tabIndex.push(this);
        tabIndex.set.call(this, value);
      },
    });
    const beforeInitialDisconnects = observerDisconnects;
    try {
      view.renderResults(results, candidate, { ...context, ...presentation, selectedDictionaryTab: { groupId: "first" } });
    } finally {
      window.Element.prototype.setAttribute = setAttribute;
      Object.defineProperty(window.HTMLElement.prototype, "tabIndex", tabIndex);
    }
    const initialTabs = [...popup.querySelectorAll('[role="tab"]')];
    const initialPanel = popup.querySelector('[role="tabpanel"]');
    const tabStateCounts = {
      tabs: initialTabs.map(button => ({ label: button.textContent,
        selected: writes.selected.filter(target => target === button).length,
        tabIndex: writes.tabIndex.filter(target => target === button).length,
      })),
      panelLabel: writes.panelLabel.length,
      observerDisconnects: observerDisconnects - beforeInitialDisconnects,
    };
    live.push(initialTabs.length === 6 && tabStateCounts.tabs.every(row => row.selected === 1 && row.tabIndex === 1)
      && tabStateCounts.observerDisconnects === 1
      && tabStateCounts.panelLabel === 1 && writes.panelLabel[0] === initialPanel
      && initialTabs.every(button => button.getAttribute("aria-controls") === initialPanel.id
        && button.getAttribute("aria-selected") === String(button.matches(firstGroup))
        && button.tabIndex === (button.matches(firstGroup) ? 0 : -1))
      && initialPanel.getAttribute("aria-labelledby") === popup.querySelector(firstGroup).id);
    const groupButton = popup.querySelector(firstGroup);
    groupButton.focus();
    const anchor = popup.querySelector("a[data-hoshidicts-query]");
    const card = popup.querySelector("details");
    card.open = false;
    const beforePresentation = { fills, replays };
    const reordered = { ...presentation,
      dictionaryPresentation: [{ title: "First", displayName: "Renamed", favorite: true }, { title: "Second", favorite: true }],
      dictionaryTabGroups: [presentation.dictionaryTabGroups[1], { ...presentation.dictionaryTabGroups[0], name: "Renamed group" }],
    };
    view.updateDictionaryPresentation?.(reordered);
    live.push(popup.querySelector(firstGroup) === groupButton && document.activeElement === groupButton
      && groupButton.textContent === "Renamed group" && groupButton.previousElementSibling === popup.querySelector(secondGroup)
      && popup.querySelector("a[data-hoshidicts-query]") === anchor && popup.querySelector("details") === card && !card.open
      && card.querySelector("summary").textContent === "Renamed" && fills === beforePresentation.fills && replays === beforePresentation.replays
      && popup.querySelector('[role="tabpanel"]').getAttribute("aria-labelledby") === groupButton.id);
    groupButton.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    observeProjection("group tab", 2);
    live.push(selected?.groupId === "second" && document.activeElement === popup.querySelector(secondGroup)
      && popup.querySelector(".gsm-hoshidicts-glossary-card > summary").title === "Second");
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const draft = popup.querySelector("form");
    draft.elements.definition.value = "presentation draft";
    const changedMembers = { ...reordered, dictionaryTabGroups: [
      { id: "second", name: "Changed group", dictionaries: ["First"] }, reordered.dictionaryTabGroups[1],
    ] };
    view.updateDictionaryPresentation({ ...changedMembers, dictionaryTabGroups: [
      { id: "second", name: "Intermediate group", dictionaries: ["First", "Second"] }, reordered.dictionaryTabGroups[1],
    ] });
    view.updateDictionaryPresentation?.(changedMembers);
    live.push(popup.querySelector(secondGroup).textContent === "Second group"
      && popup.querySelector(".gsm-hoshidicts-glossary-card > summary").title === "Second"
      && popup.querySelector("form") === draft && !draft.hidden && draft.elements.definition.value === "presentation draft");
    view.closeNoteForm();
    observeProjection("live membership flush", 2);
    live.push(popup.querySelector(secondGroup).textContent === "Changed group"
      && popup.querySelector(".gsm-hoshidicts-glossary-card > summary").title === "First"
      && popup.querySelector("form") === draft && draft.hidden && selected?.groupId === "second"
      && document.activeElement === popup.querySelector(".gsm-hoshidicts-note-button"));
    const protectedLink = popup.querySelector("a[data-hoshidicts-query]");
    protectedLink.focus();
    view.updateDictionaryPresentation?.(reordered);
    live.push(popup.querySelector("a[data-hoshidicts-query]") === protectedLink && protectedLink.isConnected);
    protectedLink.blur();
    await new Promise(resolve => setTimeout(resolve, 0));
    live.push(popup.querySelector(".gsm-hoshidicts-glossary-card > summary").title === "Second");
    current = false;
    const staleAnchor = popup.querySelector("a[data-hoshidicts-query]");
    const staleFills = fills;
    view.updateDictionaryPresentation?.(changedMembers);
    view.flushDictionaryPresentation?.();
    live.push(popup.querySelector("a[data-hoshidicts-query]") === staleAnchor && fills === staleFills);
    current = true;
    view.renderResults(results, candidate, context);
    view.flushDictionaryPresentation?.();
    live.push(!popup.querySelector(secondGroup) && selected === null);

    view.renderResults(results, candidate, { ...context, ...presentation, selectedDictionaryTab: { groupId: "first" } });
    popup.querySelector(firstGroup).focus();
    view.updateDictionaryPresentation({ ...presentation, dictionaryTabGroups: [] });
    live.push(selected === null && document.activeElement === popup.querySelector('[role="tab"][aria-selected="true"]'));
    const outside = document.createElement("button");
    document.body.append(outside);
    view.renderResults(results, candidate, { ...context, ...presentation, selectedDictionaryTab: { groupId: "first" } });
    outside.focus();
    view.updateDictionaryPresentation({ ...presentation, dictionaryTabGroups: [] });
    live.push(selected === null && document.activeElement === outside);
    outside.remove();

    const metadataResults = results.map(entry => ({ ...entry, term: { ...entry.term,
      expression: entry.term.glossaries[0].dictionary,
      frequencies: [{ dictionary: "Rank", frequencies: [{ value: 42, displayValue: null }] }],
      pitches: [{ dictionary: "Pitch", transcriptions: [], pitches: [{ position: 1, pattern: "LH" }] }],
    } }));
    const metadataBefore = JSON.stringify(metadataResults);
    view.renderResults(metadataResults, candidate, { ...context, showPitchAccentBadge: true });
    const frequencyValue = popup.querySelector(".gsm-hoshidicts-frequency-value");
    const pitchBody = popup.querySelector(".gsm-hoshidicts-pitch-body");
    view.updateDictionaryPresentation({ dictionaryPresentation: [
      { title: "Rank", displayName: "Rank alias" }, { title: "Pitch", displayName: "Pitch alias" },
      { title: "Second", displayName: "Second alias" },
    ], dictionaryTabGroups: [] });
    live.push(popup.querySelector(".gsm-hoshidicts-frequency-value") === frequencyValue && frequencyValue.textContent === "42"
      && popup.querySelector(".gsm-hoshidicts-pitch-body") === pitchBody
      && popup.querySelector(".gsm-hoshidicts-frequency-source").textContent === "Rank alias"
      && popup.querySelector(".gsm-hoshidicts-pitch-source").textContent === "Pitch alias");
    popup.querySelector(".gsm-hoshidicts-show-more").click();
    const secondary = popup.querySelectorAll("article")[1];
    live.push(secondary.querySelector(".gsm-hoshidicts-glossary-card > summary").textContent === "Second alias"
      && secondary.querySelector(".gsm-hoshidicts-frequency-source").textContent === "Rank alias"
      && secondary.querySelector(".gsm-hoshidicts-pitch-source").textContent === "Pitch alias"
      && JSON.stringify(metadataResults) === metadataBefore);
    const expandedGroup = { ...presentation, dictionaryTabGroups: [{ id: "expanded", name: "Expanded", dictionaries: ["First", "Second"] }] };
    view.renderResults(metadataResults, candidate, { ...context, ...expandedGroup, expandAll: true, selectedDictionaryTab: { groupId: "expanded" } });
    view.updateDictionaryPresentation({ ...expandedGroup, dictionaryTabGroups: [{ id: "expanded", name: "Narrow", dictionaries: ["First"] }] });
    view.updateDictionaryPresentation(expandedGroup);
    live.push(popup.querySelectorAll("article").length === 2 && !popup.querySelector(".gsm-hoshidicts-show-more"));
    view.updateDictionaryPresentation({ ...expandedGroup, dictionaryTabGroups: [{ id: "expanded", name: "Only second", dictionaries: ["Second"] }] });
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    live.push(popup.querySelector("form").elements.term.value === "Second");
    view.closeNoteForm();
    view.clear();
    observeProjection("clear", 0);
    check("live presentation keeps keyed tabs and protected views coherent until local projection is safe",
      live.every(Boolean) && observations.every(value => value.valid), JSON.stringify({ live, observations, tabStateCounts }));

    const kanji = { character: "食", entries: ["First", "Second"].map(dictionary => ({
      dictionary, tags: "", onyomi: "ショク", kunyomi: "", definitions: [dictionary], stats: [],
    })) };
    view.renderKanji(kanji, candidate, { ...context, ...presentation, selectedDictionaryTab: { groupId: "first" } });
    const kanjiEntry = popup.querySelector("article");
    view.updateDictionaryPresentation?.(reordered);
    const aliasOnly = popup.querySelector("article") === kanjiEntry
      && kanjiEntry.querySelector("h3").textContent === "Renamed";
    popup.querySelector(".gsm-hoshidicts-note-button").click();
    const kanjiDraft = popup.querySelector("form");
    kanjiDraft.elements.definition.value = "kanji draft";
    view.updateDictionaryPresentation?.({ ...reordered, dictionaryTabGroups: [] });
    const kanjiProtected = popup.querySelectorAll("article").length === 1 && selected?.groupId === "first";
    view.closeNoteForm();
    check("native kanji presentation refreshes its original entries without replacing Note controls or term history",
      aliasOnly && kanjiProtected && selected === null && popup.querySelectorAll("article").length === 2
        && popup.querySelector("form") === kanjiDraft && kanjiDraft.elements.definition.value === "kanji draft"
        && kanji.entries.length === 2,
      JSON.stringify({ aliasOnly, kanjiProtected, selected, entries: popup.querySelectorAll("article").length }));
  } finally {
    view.destroy();
    window.ResizeObserver = originalResizeObserver;
    popup.remove();
  }
}

function internalLinksRenderStage({ HDGlossary, document, window }) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const calls = [];
  let current = true;
  HDGlossary.appendTextOnlyGlossary(document, parent, JSON.stringify([{ type: "structured-content", content: [
    { tag: "a", href: "?query=食&primary_reading=しょく", content: "linked term" },
    { tag: "a", href: "?query=outer", content: { tag: "a", href: "?query=inner", content: "inner term" } },
  ] }]), { isCurrent: () => current, onInternalLink(value) { calls.push(value); } });
  const first = parent.querySelector("a");
  const activate = (anchor, detail = 0) => {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, detail });
    anchor.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const active = activate(first) && calls.length === 1 && calls[0].anchor === first
      && calls[0].query === "食" && calls[0].primaryReading === "しょく" && calls[0].focusChild === true;
    current = false;
    const stale = activate(first) && calls.length === 1;
    current = true;
    const nested = activate(parent.querySelector('[data-hoshidicts-query="inner"]'), 1)
      && calls.length === 2 && calls[1].query === "inner" && calls[1].focusChild === false;
    first.remove();
    const detached = activate(first) && calls.length === 2;
    check("internal links retain exact query and reading while rejecting stale, detached and enclosing actions",
      active && stale && nested && detached, JSON.stringify({ active, stale, nested, detached, queries: calls.map(value => value.query) }));
  } finally { parent.remove(); }
}

function externalLinksRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  const calls = [];
  let current = true;
  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList, positionPopup() {},
  });
  const href = "  HTTPS://EXAMPLE.test:443/参照?q=食#meaning  ";
  const entry = (dictionary, content) => ({ ...result,
    term: { ...result.term, glossaries: [{ dictionary, glossary: JSON.stringify([
      { type: "structured-content", content },
    ]) }] },
  });
  const link = (url, content = "reference <literal>") => ({ tag: "a", href: url, content });
  const first = entry("Links", link(href));
  const context = {
    isCurrentRequest: () => current,
    onExternalLink(value) { calls.push(value); },
    dictionaryPresentation: [{ title: "Links", favorite: true }, { title: "Other", favorite: true }],
  };
  const dispatch = (anchor, type = "click", options = {}) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options });
    anchor.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const invalid = ["javascript:alert(1)", "file:///tmp/reference", "/relative", "https://[bad/",
      "https://user:secret@example.test/", "https://example.test/line\nbreak"];
    view.renderResults([entry("Links", [link(href), link("http://localhost/reference"), ...invalid.map((url) => link(url))])], candidate, context);
    const anchors = [...popup.querySelectorAll(".gloss-link")];
    const normalised = new URL(href.trim()).href;
    const preserved = anchors[0].href === normalised && anchors[0].target === "_blank"
      && anchors[0].rel === "noopener noreferrer"
      && anchors[0].querySelector(".gloss-link-text").textContent === "reference <literal>"
      && anchors[1].href === "http://localhost/reference"
      && anchors.slice(2).every((anchor) => !anchor.hasAttribute("href"));
    anchors[0].href = "https://mutated.test/";
    const events = [
      ["click", { detail: 1 }, true], ["click", { detail: 0 }, true],
      ["click", { ctrlKey: true }, false], ["click", { metaKey: true }, false],
      ["auxclick", { button: 1 }, false], ["auxclick", { button: 1, shiftKey: true }, true],
    ];
    const prevented = events.map(([type, options]) => dispatch(anchors[0], type, options));
    const nativeContext = !dispatch(anchors[0], "auxclick", { button: 2 })
      && !dispatch(anchors[0], "contextmenu", { button: 2 });
    check("external anchors keep safe native links and route primary, keyboard and middle activation exactly once",
      preserved && prevented.every(Boolean) && nativeContext && calls.length === events.length
        && calls.every((value, index) => value.url === normalised && value.active === events[index][2]),
      JSON.stringify({ preserved, prevented, nativeContext, calls }));

    const stale = [
      () => view.renderResults([first], candidate, context),
      () => popup.querySelector('[data-dictionary="Other"][role="tab"]').click(),
      () => { current = false; },
      (anchor) => anchor.remove(),
      () => view.clear(),
      () => view.destroy(),
    ].map((replace) => {
      current = true;
      view.renderResults([first, entry("Other", "other")], candidate, context);
      const anchor = popup.querySelector(".gloss-link");
      replace(anchor);
      const count = calls.length;
      return dispatch(anchor) && dispatch(anchor, "auxclick", { button: 1 }) && calls.length === count;
    });
    check("obsolete external anchors cancel native navigation without dispatching a new tab",
      stale.every(Boolean), JSON.stringify(stale));

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let internal = 0;
    const before = calls.length;
    HDGlossary.appendTextOnlyGlossary(document, parent, JSON.stringify([{ type: "structured-content",
      content: [link("https://outer.test/", link("https://inner.test/")),
        link("https://outer.test/", link("?query=食&primary_reading=しょく")),
        link("?query=outer", link("https://inner.test/second"))],
    }]), { onExternalLink: context.onExternalLink, onInternalLink() { internal += 1; } });
    dispatch(parent.querySelector('a[href="https://inner.test/"]'));
    dispatch(parent.querySelector('[data-hoshidicts-query]'));
    dispatch(parent.querySelector('a[href="https://inner.test/second"]'));
    check("nested structured links dispatch only the handled inner action",
      calls.length === before + 2 && calls[before]?.url === "https://inner.test/"
        && calls.at(-1)?.url === "https://inner.test/second" && internal === 1,
      JSON.stringify({ calls: calls.slice(before), internal }));
    parent.remove();
  } finally { view.destroy(); popup.remove(); }
}

async function deinflectionRenderStage({ HDGlossary, HDPopup, document, window, candidate, result }) {
  const popup = document.createElement("div");
  document.body.appendChild(popup);
  let layouts = 0;
  let requestCurrent = true;
  const view = HDPopup.createPopupView({
    document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    parseTagList: HDGlossary.parseTagList,
    positionPopup() { layouts += 1; },
  });
  const disclosure = () => popup.querySelector(".gsm-hoshidicts-deinflection");
  const language = Object.getOwnPropertyDescriptor(window.navigator, "language");
  const settle = async () => {
    await new Promise((done) => window.setTimeout(done, 0));
    await new Promise((done) => window.requestAnimationFrame(() => window.requestAnimationFrame(done)));
  };
  const entry = (dictionary, matched = "Selected form") => ({
    ...result, matched, deinflected: "Dictionary form",
    term: { ...result.term, glossaries: [{ dictionary, glossary: '["definition"]' }] },
  });
  try {
    const raw = { ...entry("Raw"), matched: " <em>{deinflected} $&</em> ", deinflected: " base $' ", trace: [
      { name: "duplicate", description: "first" },
      { name: "duplicate", description: "second" },
      { name: "  ", description: " <img src=x>\n literal $& " },
      { name: " padded ", description: " padded description " },
      { name: "長".repeat(1100), description: "" },
    ] };
    const before = JSON.stringify(raw);
    const locales = [
      ["en-GB", "Deinflection steps", `Why this matched: ${raw.matched} became ${raw.deinflected}`],
      ["ja-JP", "活用解除の手順", `一致した理由: ${raw.matched} から ${raw.deinflected} に戻しました`],
      ["uk-UA", "Кроки відновлення словникової форми", `Чому це збіглося: ${raw.matched} перетворено на ${raw.deinflected}`],
      ["fr-FR", "Deinflection steps", `Why this matched: ${raw.matched} became ${raw.deinflected}`],
    ];
    const failures = [];
    for (const [locale, label, aria] of locales) {
      Object.defineProperty(window.navigator, "language", { configurable: true, value: locale });
      view.renderResults([raw], candidate, { hidePopupGrammarTags: false });
      const details = disclosure();
      const names = [...popup.querySelectorAll(".gsm-hoshidicts-deinflection-step-name")].map((node) => node.textContent);
      const descriptions = [...popup.querySelectorAll(".gsm-hoshidicts-deinflection-steps > li")]
        .map((node) => node.querySelector(".gsm-hoshidicts-deinflection-step-description")?.textContent ?? "");
      const valid = details?.open === false
        && details.querySelector("summary").textContent === `${raw.matched} → ${raw.deinflected}`
        && details.querySelector("summary").getAttribute("aria-label") === aria
        && details.querySelector("ol").getAttribute("aria-label") === label
        && JSON.stringify(names) === JSON.stringify(raw.trace.map(({ name }) => name))
        && JSON.stringify(descriptions) === JSON.stringify(raw.trace.map(({ description }) => description))
        && !details.querySelector("em, img");
      if (details) details.open = true;
      await settle();
      if (!valid || JSON.stringify(raw) !== before) failures.push(locale);
    }
    for (const [index, replacement] of [
      { matched: "" }, { matched: null }, { deinflected: "" },
      { deinflected: raw.matched }, { trace: null }, { trace: "not an array" },
      { trace: [] }, { trace: [null, {}, { name: "" }, { name: 2 }] },
    ].entries()) {
      try {
        view.renderResults([{ ...raw, ...replacement }], candidate, { hidePopupGrammarTags: false });
        if (disclosure()) failures.push(`ineligible ${index}`);
      } catch (error) { failures.push(`ineligible ${index}: ${error.message}`); }
    }
    check("deinflection disclosure preserves raw duplicate steps and localized literal text without empty explanations",
      failures.length === 0, JSON.stringify(failures));

    const first = entry("First", "First match");
    const second = entry("Second", "Second match");
    const results = [first, second];
    const originalResults = JSON.stringify(results);
    const context = {
      dictionaryPresentation: [{ title: "Second", favorite: true }],
      isCurrentRequest: () => requestCurrent,
      onBack() {},
    };
    view.renderResults(results, candidate, context);
    await settle();
    const primary = disclosure();
    const primaryOutsidePanel = primary !== null
      && popup.querySelector(".gsm-hoshidicts-primary-header").contains(primary)
      && !popup.querySelector(".gsm-hoshidicts-tab-panel").contains(primary);
    const lazy = popup.querySelectorAll(".gsm-hoshidicts-deinflection").length === 1;
    const beforeOpening = layouts;
    if (primary) primary.open = true;
    await settle();
    let currentPositioned = layouts > beforeOpening;
    const beforeClosing = layouts;
    if (primary) primary.open = false;
    await settle();
    currentPositioned &&= layouts > beforeClosing;
    popup.querySelector(".gsm-hoshidicts-show-more")?.click();
    const expanded = [...popup.querySelectorAll(".gsm-hoshidicts-deinflection")];
    const secondary = expanded.length === 2 && expanded[0] === primary && !expanded[1].open
      && expanded[1].closest("article") !== null
      && expanded[1].querySelector("summary").textContent === "Second match → Dictionary form";
    popup.querySelector('[role="tab"][data-dictionary="Second"]')?.click();
    const projected = disclosure()?.open === false
      && disclosure().querySelector("summary").textContent === "Second match → Dictionary form";
    const staleCases = [];
    for (const replace of [
      () => view.renderResults(results, candidate, context),
      () => popup.querySelector('[role="tab"][data-dictionary="Second"]')?.click(),
      () => view.clear(),
      () => { requestCurrent = false; },
      () => view.destroy(),
    ]) {
      requestCurrent = true;
      view.renderResults(results, candidate, context);
      await settle();
      const old = disclosure();
      replace();
      await settle();
      const beforeStaleToggle = layouts;
      old?.dispatchEvent(new window.Event("toggle"));
      await settle();
      staleCases.push(old !== null && layouts === beforeStaleToggle);
    }
    check("deinflection headers stay lazy and only current projected disclosures can request positioning",
      primaryOutsidePanel && lazy && currentPositioned && secondary && projected
        && staleCases.every(Boolean) && JSON.stringify(results) === originalResults,
      JSON.stringify({ primaryOutsidePanel, lazy, currentPositioned, secondary, projected, staleCases }));
  } finally {
    if (language) Object.defineProperty(window.navigator, "language", language);
    else delete window.navigator.language;
    view.destroy();
    popup.remove();
  }
}

async function imagePreviewStage({ view, popup, shadow, document, window, candidate, result, mediaUrl, calculatePopupPosition }) {
  let requests = 0;
  let ownsRequest = true;
  let holdFirstMedia = false;
  let resolveHeldMedia;
  const preview = () => shadow.querySelector(".gsm-hoshidicts-image-hover-preview");
  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this === popup) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
      width: window.innerWidth, height: window.innerHeight };
    return this.classList.contains("gsm-hoshidicts-image-hover-preview")
      ? { left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240 }
      : originalRect.call(this);
  };
  const render = async () => {
    ownsRequest = true;
    view.renderResults([{ ...result, term: { ...result.term, glossaries: ["A", "B"].map((dictionary) => ({
      dictionary,
      glossary: JSON.stringify([{ type: "structured-content", content: {
        tag: "img", path: `media/${dictionary}.png`, width: 16, height: 16,
        alt: `${dictionary} image`, appearance: "monochrome", pixelated: true,
      } }]),
    })) } }], candidate, {
      generation: 2,
      dictionaryPresentation: ["A", "B"].map((title) => ({ title, favorite: true })),
      isCurrentRequest: () => ownsRequest,
      resolveMedia({ path }) {
        requests += 1;
        return holdFirstMedia && path === "media/A.png"
          ? new Promise((resolveMedia) => { resolveHeldMedia = resolveMedia; })
          : Promise.resolve(mediaUrl);
      },
    });
    await new Promise((done) => setTimeout(done, 0));
    const links = [...popup.querySelectorAll(".gloss-image-link")];
    links.forEach((link, index) => {
      const image = link.querySelector("img");
      const left = index === 0 ? 0 : window.innerWidth - 16;
      const top = index === 0 ? 0 : window.innerHeight - 16;
      image.getBoundingClientRect = () => ({ left, top, right: left + 16, bottom: top + 16, width: 16, height: 16 });
      Object.defineProperties(image, {
        naturalWidth: { value: 16 }, naturalHeight: { value: 16 }, complete: { value: true },
      });
    });
    return links;
  };
  const event = (target, type) => target.dispatchEvent(new window.Event(type));
  try {
    let links = await render();
    const lazy = !preview();
    const beforeRequests = requests;
    links[0].focus();
    const first = preview();
    event(links[0], "mouseenter");
    const stable = preview() === first;
    const firstFits = first && Number.parseFloat(first.style.left) >= 8 && Number.parseFloat(first.style.top) >= 8;
    const firstSource = first?.querySelector("img");
    check("image preview is lazy, shadow-owned and reuses the exact source without another media request",
      lazy && first?.parentNode === shadow && first.getAttribute("aria-hidden") === "true"
        && firstSource?.src === mediaUrl && firstSource.alt === "A image"
        && first.dataset.appearance === "monochrome" && first.dataset.imageRendering === "pixelated"
        && shadow.activeElement === links[0] && stable && requests === beforeRequests
        && links[0].querySelector(".gloss-image-container").style.width === "16px",
      JSON.stringify({ lazy, stable, requests, beforeRequests, source: firstSource?.src }));

    event(links[0], "mouseleave");
    const focusSurvivedLeave = preview() === first;
    event(links[0], "mouseenter");
    links[0].blur();
    const hoverSurvivedBlur = preview() === first;
    event(links[0], "mouseleave");
    const bothLeftClosed = !preview();
    links[0].focus();
    links[1].focus();
    const second = preview();
    event(links[0], "mouseleave");
    event(links[0], "blur");
    const staleLeaveIgnored = preview() === second;
    const secondFits = second && Number.parseFloat(second.style.left) + 320 <= window.innerWidth - 8
      && Number.parseFloat(second.style.top) + 240 <= window.innerHeight - 8;
    // 92vw/vh produce fractional CSS pixels in a 320x240 Chrome viewport.
    // Rounding after clamping would cross the right/bottom padding boundary.
    const fractionalSize = { width: 294.390625, height: 220.796875 };
    const fractionalCornersFit = [0, 304].every(left => [0, 224].every(top => {
      const position = calculatePopupPosition({ left, top, right: left + 16, bottom: top + 16 },
        fractionalSize, { width: 320, height: 240 }, { gap: 8, padding: 8, vertical: true });
      return position.left >= 8 && position.top >= 8
        && position.left + fractionalSize.width <= 312 && position.top + fractionalSize.height <= 232;
    }));
    event(popup, "scroll");
    const focusedScrollKept = Boolean(second) && preview() === second;
    links[1].blur();
    const blurred = !preview();
    event(links[1], "mouseenter");
    event(links[1], "mouseleave");
    const left = !preview();
    event(links[0], "mouseenter");
    event(window, "resize");
    const resized = !preview();
    event(links[0], "mouseenter");
    event(popup, "scroll");
    const scrolled = !preview();
    event(links[0], "mouseenter");
    event(links[0].querySelector("img"), "error");
    const failed = !preview();
    check("image previews clamp both viewport corners and close only their current hover or focus owner",
      firstFits && secondFits && fractionalCornersFit && focusSurvivedLeave && hoverSurvivedBlur && bothLeftClosed
        && focusedScrollKept && staleLeaveIgnored && blurred && left && resized && scrolled && failed,
      JSON.stringify({ firstFits, secondFits, fractionalCornersFit, focusSurvivedLeave, hoverSurvivedBlur, bothLeftClosed,
        focusedScrollKept, staleLeaveIgnored, blurred, left, resized, scrolled, failed }));

    links = await render();
    event(links[0], "mouseenter");
    const beforeTab = Boolean(preview());
    popup.querySelector('[role="tab"][data-dictionary="A"]').click();
    const tabClosed = !preview();
    const current = popup.querySelector(".gloss-image-link");
    await new Promise((done) => setTimeout(done, 0));
    current.focus();
    ownsRequest = false;
    view.hideImagePreview?.();
    event(current, "mouseenter");
    check("a tab change or pending newer request prevents obsolete connected images from reopening a preview",
      beforeTab && tabClosed && current.isConnected && !preview(),
      JSON.stringify({ beforeTab, tabClosed, connected: current.isConnected, open: Boolean(preview()) }));

    holdFirstMedia = true;
    links = await render();
    event(links[0], "mouseenter");
    links[1].focus();
    const newerPreview = preview();
    resolveHeldMedia(mediaUrl);
    await new Promise((done) => setTimeout(done, 0));
    event(links[0].querySelector("img"), "load");
    const newerIntentPreserved = Boolean(newerPreview) && preview() === newerPreview;
    links = await render();
    event(links[0], "mouseenter");
    event(window, "resize");
    resolveHeldMedia(mediaUrl);
    await new Promise((done) => setTimeout(done, 0));
    event(links[0].querySelector("img"), "load");
    check("late image loads cannot steal newer preview intent or revive a dismissed preview",
      newerIntentPreserved && !preview(),
      JSON.stringify({ newerIntentPreserved, dismissedRevived: Boolean(preview()) }));
    holdFirstMedia = false;

    links = await render();
    event(links[0], "mouseenter");
    const beforeClear = Boolean(preview());
    view.clear();
    const cleared = !preview();
    links = await render();
    event(links[0], "mouseenter");
    const beforeDestroy = Boolean(preview());
    view.destroy();
    event(links[0], "mouseenter");
    check("clearing or destroying the popup removes its preview and invalidates its image listeners",
      beforeClear && cleared && beforeDestroy && !preview(),
      JSON.stringify({ beforeClear, cleared, beforeDestroy, open: Boolean(preview()) }));
  } finally {
    window.Element.prototype.getBoundingClientRect = originalRect;
    view.destroy();
  }
}

async function mediaRenderStage({ HDGlossary, document, window }) {
  const sizing = imageSizingFixture();
  const sizingParent = document.createElement("div");
  document.body.appendChild(sizingParent);
  const sized = sizing.cases.map(({ name, dimensions, width, padding }) => {
    HDGlossary.appendStructuredImage(document, sizingParent, { path: sizing.path, ...dimensions }, {
      resolveMedia: async () => `data:image/png;base64,${sizing.bytes.toString("base64")}`,
    });
    const container = sizingParent.lastElementChild.querySelector(".gloss-image-container");
    const actualWidth = Number.parseFloat(container.style.width);
    const actualPadding = Number.parseFloat(container.querySelector(".gloss-image-sizer").style.paddingTop);
    return { name, width: actualWidth, padding: actualPadding,
      dimensionsMatch: Math.abs(actualWidth - width) < 1e-12 && Math.abs(actualPadding - padding) < 0.001,
      bounded: container.style.aspectRatio === "" && Number.isFinite(actualPadding) && actualPadding <= 10_000 };
  });
  check("image aspect sizing uses the existing bounded sizer without a competing raw ratio",
    sized.every(({ bounded }) => bounded), JSON.stringify(sized));
  check("image width arithmetic recovers intermediate overflow and underflow without changing valid sizes",
    sized.every(({ dimensionsMatch }) => dimensionsMatch), JSON.stringify(sized));
  sizingParent.remove();
  const outcomes = [];
  let supplierLayout = null;
  for (const replyKind of ["missing", "failure", "valid"]) {
    for (const current of [false, true]) {
      const parent = document.createElement("div");
      let ownsView = true;
      let settleMedia;
      let layouts = 0;
      let ownerPassed = false;
      let imageHandle;
      const imageContext = { popupImageSources: ["Pictures"] };
      const pending = new Promise((resolveMedia, rejectMedia) => {
        settleMedia = () => replyKind === "failure"
          ? rejectMedia(new Error("transient media failure"))
          : resolveMedia(replyKind === "valid" ? "data:image/png;base64,YQ==" : null);
      });
      HDGlossary.appendTextOnlyGlossary(document, parent, JSON.stringify([
        "surrounding definition", { type: "structured-content", content: {
          tag: "img", path: "media/owned.png", alt: "descriptive image",
        } },
      ]), {
        dictionary: "Definitions",
        imageContext,
        onImageCreated(handle) { imageHandle = handle; },
        isCurrent: () => ownsView,
        onLayoutChange() { layouts += 1; },
        resolveMedia({ isCurrent, onResolvedSource }) {
          ownerPassed = typeof isCurrent === "function" && isCurrent();
          onResolvedSource("Pictures");
          return pending;
        },
      });
      document.body.appendChild(parent);
      ownsView = current;
      settleMedia();
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
      const image = parent.querySelector("img");
      const link = parent.querySelector(".gloss-image-link");
      if (!current) {
        image.dispatchEvent(new window.Event("load"));
        image.dispatchEvent(new window.Event("error"));
      }
      outcomes.push(current
        ? replyKind === "valid"
          ? image.getAttribute("src") === "data:image/png;base64,YQ==" && link.dataset.imageLoadState === "loaded"
          : link.dataset.imageLoadState === "load-error" && layouts > 0
          && parent.textContent.includes("surrounding definition")
          && link.getAttribute("aria-label")?.includes("descriptive image")
          && link.querySelector(".gloss-image-link-text").textContent.includes("Image failed to load")
        : ownerPassed && link.dataset.imageLoadState === "not-loaded" && layouts === 0
          && !image.hasAttribute("src") && !link.hasAttribute("href") && !image.hidden);
      if (current && replyKind === "valid") {
        const labelBeforeLoad = parent.querySelector(".gloss-image-source")?.textContent === "Image: Pictures";
        const beforeLoad = layouts;
        image.dispatchEvent(new window.Event("load"));
        const afterLoad = layouts;
        const aliasChanged = imageHandle.updatePresentation({ ...imageContext,
          dictionaryPresentation: [{ title: "Pictures", displayName: "Picture book" }] });
        const aliasNeedsLayout = aliasChanged && layouts === afterLoad
          && parent.querySelector(".gloss-image-source")?.textContent === "Image: Picture book";
        image.dispatchEvent(new window.Event("error"));
        supplierLayout = { labelBeforeLoad, beforeLoad, afterLoad, aliasNeedsLayout,
          failedLayout: layouts === afterLoad + 1 && !parent.querySelector(".gloss-image-source")
            && link.dataset.imageLoadState === "load-error" };
      }
      parent.remove();
    }
  }
  check("obsolete connected image callbacks cannot mutate or reposition their old panel",
    outcomes[0] && outcomes[2] && outcomes[4] && outcomes[5], JSON.stringify(outcomes));
  check("missing and failed images expose an accessible failure state without losing glossary text",
    outcomes[1] && outcomes[3], JSON.stringify(outcomes));
  check("supplier labels share the image completion layout while alias changes and failures retain their layout path",
    supplierLayout?.labelBeforeLoad && supplierLayout.beforeLoad === 0 && supplierLayout.afterLoad === 1
      && supplierLayout.aliasNeedsLayout && supplierLayout.failedLayout, JSON.stringify(supplierLayout));
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

    const projectionContext = { ...context, selectedDictionaryTab: { groupId: "live" },
      dictionaryTabGroups: [{ id: "live", name: "Live", dictionaries: ["Healthy"] }],
    };
    view.renderResults([healthy, invalid], candidate, projectionContext);
    let presentationEscaped = false;
    const beforePresentationError = errors;
    try {
      view.updateDictionaryPresentation({ ...projectionContext,
        dictionaryTabGroups: [{ id: "live", name: "Live", dictionaries: ["Invalid"] }],
      });
    } catch { presentationEscaped = true; }
    check("storage-driven projection failures use the current render error boundary",
      !presentationEscaped && errors === beforePresentationError + 1 && popup.childElementCount === 0,
      JSON.stringify({ presentationEscaped, errors, beforePresentationError }));

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
