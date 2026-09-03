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
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// The trained fixture is built in memory rather than read out of test/fixtures:
// the .zip on disk is only there for the browser test, which needs a real file to
// hand to an <input type=file>.
import { TRAINED_TERMS, TRAINED_TITLE, buildTrainedZip } from "./make-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(HERE, "fixtures/hachidori-fixture.zip");
const EXTENSION_ORIGIN = "chrome-extension://hachidorismokeextensionid";

const FIXTURE_TITLE = "hachidori-fixture";
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
let nextBlobId = 0;

function installFetch() {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (blobUrls.has(url)) {
      const bytes = blobUrls.get(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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

/* -------------------------------------------------------------------------- setup */

function installNavigator() {
  const value = { storage: { persist: async () => true }, userAgent: "smoke" };
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
      ["offscreen.js", /clampInt\(\s*message\.maxResults,\s*(\d+),\s*(\d+)/u],
    ],
  ],
  [
    "scanLength",
    [
      ["content.js", /scanLength:\s*clampInteger\(\s*source\.scanLength,\s*(\d+),\s*(\d+)/u],
      ["settings.js", /key:\s*"scanLength",[^}]*?min:\s*(\d+),\s*max:\s*(\d+)/u],
      ["settings.html", /id="opt-scan-length"[^>]*?min="(\d+)"[^>]*?max="(\d+)"/u],
      ["offscreen.js", /clampInt\(\s*message\.scanLength,\s*(\d+),\s*(\d+)/u],
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
  await import(`file://${resolve(EXTENSION, "offscreen.js").replace(/\\/gu, "/")}`);

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
    "type",
  ]);
  check("hd_status echoes the requestId", status.requestId === "status-1", JSON.stringify(status));

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
  // The engine's view of this key now goes offscreen -> worker -> chrome.storage,
  // so read it the way the settings page does: straight out of storage.
  const storedDictionaries = async () => (await storage.api().local.get("dictionaries")).dictionaries ?? [];
  equal("an empty profile lists no dictionaries", await storedDictionaries(), []);
  const readBack = await pageChrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_dicts_read" });
  equal(
    "the service worker answers hd_dicts_read without relaying it",
    [readBack?.ok, readBack?.dictionaries, bus.log.some((row) => row.type === "hd_dicts_read" && row.relayed)],
    [true, [], false],
  );

  const zip = new Uint8Array(await readFile(FIXTURE));
  const blobUrl = createObjectURL(zip);
  const imported = await request("hd_import", { blobUrl, fileName: "hachidori-fixture.zip" });
  check("hd_import succeeds", imported.ok === true, JSON.stringify(imported));
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
    [FIXTURE_TITLE, 5, 4, 2, 2, 1, 1],
  );

  // The fixture is a combined dictionary, and the engine indexes each kind
  // separately: one storage row per kind found is what makes its frequencies,
  // pitches and kanji resolvable rather than imported-but-unreachable.
  equal(
    "the import writes one storage row per kind, in schema-D shape",
    await storedDictionaries(),
    ["term", "freq", "pitch", "kanji"].map((kind) => ({
      title: FIXTURE_TITLE,
      path: `/dicts/${FIXTURE_TITLE}`,
      kind,
      enabled: true,
    })),
  );
  check("syncfs(false) wrote the dictionary to IndexedDB", idb.count("/dicts") > 0, `${idb.count("/dicts")} rows in ${idb.names()}`);

  const reloaded = await request("hd_reload");
  equal("hd_reload loads every kind", [reloaded.ok, reloaded.dictionaryCount], [true, 4]);

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

  section("hd_remove");
  // hd_remove unloads every dictionary before it deletes anything, so if the
  // steps after that throw it must still reload what survived: otherwise every
  // tab reports no dictionaries until the next storage edit. A storage row for a
  // title that was never imported is the cheapest way in -- nothing on disk is
  // touched, so the injected storage failure is the only failure.
  const storedRows = await storedDictionaries();
  await storage.api().local.set({
    dictionaries: [...storedRows, { title: "ghost", path: "/dicts/ghost", kind: "term", enabled: true }],
  });
  storage.failNextSet("injected storage failure");
  const failedRemove = await request("hd_remove", { title: "ghost" });
  check("a remove whose storage write fails reports the failure", failedRemove.ok === false, JSON.stringify(failedRemove));
  const afterFailedRemove = await request("hd_status");
  equal(
    "a failed remove reloads the dictionaries it unloaded",
    [afterFailedRemove.ready, afterFailedRemove.dictionaryCount],
    [true, 4],
  );

  const removed = await request("hd_remove", { title: FIXTURE_TITLE });
  check("hd_remove succeeds", removed.ok === true, JSON.stringify(removed));
  const afterRemove = await request("hd_status");
  equal("nothing is loaded after a remove", [afterRemove.ready, afterRemove.dictionaryCount], [true, 0]);
  equal("the storage rows are gone", await storedDictionaries(), []);
  const generationBefore = afterRemove.generation;
  const noop = await request("hd_remove", { title: "never imported" });
  const afterNoop = await request("hd_status");
  equal(
    "removing an unknown title is a no-op that does not bump generation",
    [noop.ok, afterNoop.generation],
    [true, generationBefore],
  );

  section("a trained (.hoshidicts_4) dictionary through the extension layer");
  // Everything above imports the 5-row fixture, which is under the importer's
  // zstd-training floor and therefore lands in the pre-4 layout. Nothing outside
  // node-smoke.mjs had ever seen the layout the current engine writes for a real
  // dictionary: a .hoshidicts_4 marker, a dict.zstd, and glossaries compressed
  // against it. That layout has to survive offscreen.js's own marker list and the
  // IDBFS round trip, neither of which node-smoke.mjs touches.
  const trainedImport = await request("hd_import", {
    blobUrl: createObjectURL(buildTrainedZip()),
    fileName: "hachidori-fixture-trained.zip",
  });
  equal(
    "hd_import accepts a dictionary over the zstd training floor",
    [trainedImport.ok, trainedImport.report?.title, trainedImport.report?.termCount],
    [true, TRAINED_TITLE, TRAINED_TERMS.length],
  );
  // reloadFromStorage() -> reconcile() -> listImported() runs on the way out of
  // hd_import, and listImported() only recognises a directory by its marker: a
  // MARKER_FILES that does not name .hoshidicts_4 drops the row that was just
  // written and this count is 0.
  const trainedStatus = await request("hd_status");
  equal(
    "offscreen.js recognises the .hoshidicts_4 directory as a dictionary",
    [trainedStatus.ok, trainedStatus.dictionaryCount],
    [true, 1],
  );
  equal("the trained import writes one term row", await storedDictionaries(), [
    { title: TRAINED_TITLE, path: `/dicts/${TRAINED_TITLE}`, kind: "term", enabled: true },
  ]);
  // dict.zstd is the one file whose absence the engine cannot report: query.cpp
  // builds an empty DDict from it and every glossary decompresses to "". So it has
  // to be in the store IDBFS repopulates from, not just on the in-memory FS.
  const persisted = idb.keys("/dicts").filter((key) => key.startsWith(`/dicts/${TRAINED_TITLE}/`));
  check(
    "syncfs(false) persisted the marker and dict.zstd, not just the banks",
    persisted.includes(`/dicts/${TRAINED_TITLE}/dict.zstd`)
      && persisted.includes(`/dicts/${TRAINED_TITLE}/.hoshidicts_4`),
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
