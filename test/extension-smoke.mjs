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
  let pendingSetFailure = null;

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
          const value = structuredClone(read(query));
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
    raw: local,
    failNextSet(message) {
      pendingSetFailure = new Error(message);
    },
  };
}

const offscreenState = { created: 0, exists: false, concurrent: 0, peakConcurrent: 0 };

function makeChrome(owner, bus, storage) {
  const events = () => ({ addListener() {}, removeListener() {} });
  return {
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
      onInstalled: events(),
      onStartup: events(),
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
let nextBlobId = 0;

function installFetch() {
  globalThis.fetch = async (input) => {
    const url = String(input);
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

function loadSettingsScript(window) {
  const recommended = readFileSync(resolve(EXTENSION, "recommended-dictionaries.js"), "utf8");
  const groups = readFileSync(resolve(EXTENSION, "dictionary-groups.js"), "utf8")
    .replace(/^export\s+/gmu, "");
  const settings = readFileSync(resolve(EXTENSION, "settings.js"), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"\.\/dictionary-groups\.js";\s*/u, "");
  window.eval(`${recommended}\n${groups}\n${settings}`);
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
  const sandbox = createContext({});
  sandbox.globalThis = sandbox;
  runInContext(readFileSync(cataloguePath, "utf8"), sandbox, { filename: "recommended-dictionaries.js" });
  const catalogue = sandbox.HD_RECOMMENDED_DICTIONARIES ?? [];
  const actual = catalogue.map((entry) => ({
    sourceId: entry.sourceId,
    name: entry.name,
    publisherUrl: entry.publisherUrl,
    downloadUrl: entry.downloadUrl,
    indexUrl: entry.indexUrl,
    capabilities: [...entry.capabilities],
  }));
  const expected = RECOMMENDED_DICTIONARIES.map(({ title, revision, ...entry }) => entry);
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

  // offscreen.js is a real ES module, so it reads `chrome` off the shared global;
  // the scripts loaded into a vm context get their own chrome.
  //
  // A real offscreen document is granted chrome.runtime and nothing else --
  // Object.keys(chrome) there is csi,loadTimes,runtime, and getContexts is absent
  // too. Withholding the rest is what lets this harness catch a call that only
  // fails in a browser: offscreen.js reading chrome.storage.local looked correct
  // here for as long as the fake handed it one.
  const offscreenChrome = makeChrome("offscreen", bus, storage);
  delete offscreenChrome.storage;
  delete offscreenChrome.offscreen;
  delete offscreenChrome.runtime.getContexts;
  globalThis.chrome = offscreenChrome;

  const swChrome = makeChrome("sw", bus, storage);
  loadClassicScript(resolve(EXTENSION, "background.js"), {
    chrome: swChrome,
    console,
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
  });

  const pageChrome = makeChrome("page", bus, storage);
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
  engineService.configureEngineService(
    async (message) => {
      const reply = await offscreenChrome.runtime.sendMessage(message);
      if (loseNextStateCasReply && message.type === "hd_state_cas") {
        loseNextStateCasReply = false;
        throw new Error("injected lost CAS reply");
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
    finalUrl: "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset"
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
    "recommended import rejects a mismatched title before publication",
    recommendedFields,
    { title: "Not Jitendex" },
    "Not Jitendex",
  );
  await rejectRecommended(
    "recommended import rejects mismatched capabilities before publication",
    recommendedFields,
    { capabilities: ["term"] },
    recommended.title,
  );

  const trustedImport = await request("hd_import", {
    blobUrl: recommendedArchive(),
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
      && trustedPackage?.mediaCount === 1,
    JSON.stringify({ trustedImport, trustedState }),
  );
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
    options: selectedOptions,
  });
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
  const rendered = await renderStage({ imageLookup, kanji: kanji.kanji, lookup, media, styles });
  if (rendered === null) {
    fail(
      "jsdom is loadable, so the renderer stage can run",
      `${jsdomFailure}\nSearched: ${jsdomSearchPaths().join(", ")}\n` +
        "Install it outside the repo and point HACHIDORI_JSDOM or NODE_PATH at that tree:\n" +
        `  (cd ${DEFAULT_JSDOM_TREE} && npm install jsdom)\n` +
        `  NODE_PATH=${DEFAULT_JSDOM_TREE}/node_modules node test/extension-smoke.mjs`,
    );
  }
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
      && recommendedSettings.retryHiddenWhenComplete === true,
    JSON.stringify(recommendedSettings),
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
        newValue: { kanjiClickDictionary: { title: "Other", kind: "term" } },
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

// The renderer is the one consumer that reads contract B field by field, so it
// is driven with the engine's own bytes rather than a hand-written payload.
async function renderStage({ imageLookup, kanji, lookup, media, styles }) {
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
  const view = HDPopup.createPopupView({
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    document,
    getPopupColumns: () => 1,
    idPrefix: "hoshidicts",
    onKanjiClick() {},
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

  const applied = HDGlossary.applyDictionaryStyles(document, shadow, lookup.generation, styles.styles);
  check(
    "applyDictionaryStyles installs the dictionary's CSS into the shadow root",
    applied.length === 1 && shadow.querySelectorAll("style[data-hoshidicts-dictionary-style]").length === 1,
    `applied ${applied.length}`,
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

  view.renderNotice("nothing found", candidate);
  check("renderNotice replaces the view", popup.textContent.includes("nothing found"), JSON.stringify(popup.textContent));
  view.clear();
  equal("clear empties the popup", popup.childElementCount, 0);
  view.destroy();
  dom.window.close();
  return true;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
