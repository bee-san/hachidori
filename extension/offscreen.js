/*
 * Owns the single hoshidicts engine instance.
 *
 * Everything that touches the engine runs on one promise chain: the engine is
 * not reentrant, and an import must never interleave with a lookup. Blocking the
 * offscreen document's main thread for the length of an import is invisible
 * because this document has no UI.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import createHoshidicts from "./vendor/hoshidicts.mjs";

const TARGET = "hoshidicts-offscreen";
// An offscreen document is granted chrome.runtime and nothing else, so the
// `dictionaries` key is read and written by asking the service worker, which
// answers on its own target and therefore never relays the request back here.
const WORKER_TARGET = "hoshidicts-worker";
const DICT_ROOT = "/dicts";
const IMPORT_ZIP = "/tmp/import.zip";

// Index into this array is the `kind` argument of hdw_add_dict.
const KINDS = ["term", "freq", "pitch", "kanji"];

// A directory holding one of these is an imported dictionary; anything else
// under /dicts is debris. _4 means the importer trained a zstd dictionary for
// the term banks and wrote a dict.zstd alongside; _3 means it did not, which is
// also how every dictionary imported by an older engine looks. Both load, so the
// presence of dict.zstd is deliberately not part of the test.
const MARKER_FILES = [".hoshidicts_4", ".hoshidicts_3", ".hoshidicts_2", ".hoshidicts_1"];

const FREQUENCY_ORDERS = ["auto", "ascending", "descending", "disabled"];
const DEFAULT_MAX_RESULTS = 32;
const DEFAULT_SCAN_LENGTH = 16;

const BASE64_CHUNK = 0x8000;
const MEDIA_TYPES = {
  avif: "image/avif",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};

// No engine call, so this must not queue behind a long import: the settings page
// polls hd_status while one is running.
const UNQUEUED = new Set(["hd_status"]);

// A storage read-modify-write spans two messages, so another context can write
// in between; the worker refuses the write when that happens and the change is
// recomputed from what is there now.
const STORAGE_ATTEMPTS = 3;

let engine = null;
// Set only when the engine itself is unusable -- the wasm did not compile, or
// IDBFS did not mount -- which nothing in this document can undo.
let bootError = null;
// Set when the engine is fine but the dictionary list could not be read or
// written, which leaves nothing loaded. Recoverable, so it is reported and
// retried rather than latched.
let reloadError = null;
let ready = false;
let busy = 0;
let generation = 0;
let dictionaryCount = 0;

function describe(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  if (typeof error === "string") {
    return error;
  }
  return error?.message ? String(error.message) : JSON.stringify(error);
}

function asError(error) {
  return error instanceof Error ? error : new Error(describe(error));
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function parseJson(json, source) {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`${source} returned malformed JSON: ${describe(error)}`);
  }
}

let tail = Promise.resolve();

function serialise(job) {
  busy += 1;
  const run = tail.then(() => job(), () => job());
  run.then(
    () => {
      busy -= 1;
    },
    () => {
      busy -= 1;
    },
  );
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function requireEngine() {
  if (!ready) {
    throw bootError ?? new Error("the dictionary engine is still starting");
  }
  return engine;
}

function lastError() {
  return engine.ccall("hdw_last_error", "string", [], []) || "unknown engine error";
}

// The engine's failure fallbacks are shape-valid and indistinguishable from a
// genuine empty answer -- hdw_lookup returns dictionaryCount 0 even with
// dictionaries loaded, which the content script would render as "no dictionaries
// imported". hdw_last_error is cleared on entry to every entry point, so a
// non-empty value here means the call we just made is the one that failed.
function throwIfEngineFailed(name) {
  const message = engine.ccall("hdw_last_error", "string", [], []);
  if (message !== "") {
    throw new Error(`${name}: ${message}`);
  }
}

function syncfs(populate) {
  return new Promise((resolve, reject) => {
    engine.FS.syncfs(populate, (error) => {
      if (error) {
        reject(asError(error));
      } else {
        resolve();
      }
    });
  });
}

function exists(path) {
  return engine.FS.analyzePath(path).exists;
}

function removeTree(path) {
  const FS = engine.FS;
  let stat;
  try {
    stat = FS.stat(path);
  } catch (error) {
    return;
  }
  if (!FS.isDir(stat.mode)) {
    FS.unlink(path);
    return;
  }
  for (const name of FS.readdir(path)) {
    if (name !== "." && name !== "..") {
      removeTree(`${path}/${name}`);
    }
  }
  FS.rmdir(path);
}

function listImported() {
  const FS = engine.FS;
  const titles = [];
  for (const name of FS.readdir(DICT_ROOT)) {
    if (name === "." || name === "..") {
      continue;
    }
    const path = `${DICT_ROOT}/${name}`;
    let stat;
    try {
      stat = FS.stat(path);
    } catch (error) {
      continue;
    }
    if (FS.isDir(stat.mode) && MARKER_FILES.some((marker) => exists(`${path}/${marker}`))) {
      titles.push(name);
    }
  }
  return titles;
}

function entryFor(title, stored) {
  return {
    title,
    path: `${DICT_ROOT}/${title}`,
    kind: KINDS.includes(stored?.kind) ? stored.kind : "term",
    enabled: stored?.enabled !== false,
  };
}

async function ask(type, fields = {}) {
  const reply = await chrome.runtime.sendMessage({ target: WORKER_TARGET, type, ...fields });
  // A message nothing answers resolves with undefined rather than rejecting, and
  // an unanswered dictionary read is indistinguishable from empty storage --
  // reconcile() would adopt every directory on disk as a term dictionary and
  // write that back over the user's choices. Never degrade to a default here.
  if (reply === undefined || reply === null) {
    throw new Error(`the service worker did not answer ${type}`);
  }
  return reply;
}

async function readStoredDictionaries() {
  const reply = await ask("hd_dicts_read");
  if (reply.ok !== true) {
    throw new Error(reply.error || "the service worker could not read the dictionary list");
  }
  if (!Array.isArray(reply.dictionaries)) {
    throw new Error("the service worker returned no dictionary list");
  }
  return reply.dictionaries;
}

// `modify` must be a pure function of the stored rows, because a write the worker
// refuses is retried against a fresh read.
async function updateStoredDictionaries(modify) {
  for (let attempt = 0; ; attempt += 1) {
    const base = await readStoredDictionaries();
    const next = modify(base);
    if (JSON.stringify(next) === JSON.stringify(base)) {
      return next;
    }
    const reply = await ask("hd_dicts_write", { dictionaries: next, base });
    if (reply.ok === true) {
      return next;
    }
    if (reply.conflict !== true || attempt + 1 >= STORAGE_ATTEMPTS) {
      throw new Error(reply.error || "the service worker could not save the dictionary list");
    }
  }
}

// What hdw_import reported for a title, kept for as long as this document lives
// so that reconcileEntries() can adopt every bank of an archive whose storage
// write never landed. Nothing else remembers: the report is gone once hd_import
// has answered.
const importedKinds = new Map();

function adoptKinds(title) {
  return importedKinds.get(title) ?? ["term"];
}

// Storage holds the load order, the engine holds the data; either can be ahead
// of the other after a crash, so trust the filesystem for existence and storage
// for order and kind.
function reconcileEntries(stored, onDisk) {
  const entries = [];
  const listed = new Set();
  const kinds = new Set();
  for (const row of stored) {
    const title = text(row?.title);
    if (!onDisk.has(title)) {
      continue;
    }
    const entry = entryFor(title, row);
    // One directory may hold both terms and frequency data, and the engine takes
    // the same path under several kinds, so only an exact repeat is redundant.
    const key = `${entry.kind}\u0000${title}`;
    if (kinds.has(key)) {
      continue;
    }
    kinds.add(key);
    listed.add(title);
    entries.push(entry);
  }
  // Present on disk but not in storage: an import died between writing the files
  // and writing storage. Adopting it beats stranding the data, but adopting it as
  // a term dictionary when the archive also carried frequency, pitch or kanji
  // banks strands those instead -- silently, since the settings page can change a
  // row's kind but not add one. So ask for the kinds the importer actually found.
  for (const title of onDisk) {
    if (listed.has(title)) {
      continue;
    }
    for (const kind of adoptKinds(title)) {
      const key = `${kind}\u0000${title}`;
      if (kinds.has(key)) {
        continue;
      }
      kinds.add(key);
      entries.push(entryFor(title, { kind }));
    }
  }
  return entries;
}

async function reconcile() {
  const onDisk = new Set(listImported());
  return updateStoredDictionaries((stored) => reconcileEntries(stored, onDisk));
}

function loadDictionaries(entries) {
  engine.ccall("hdw_reset", null, [], []);
  let count = 0;
  for (const entry of entries) {
    const kind = KINDS.indexOf(entry.kind);
    if (entry.enabled === false || kind < 0) {
      continue;
    }
    if (engine.ccall("hdw_add_dict", "number", ["string", "number"], [entry.path, kind])) {
      count += 1;
    } else {
      console.warn(`hoshidicts: could not load ${entry.path} as ${entry.kind}: ${lastError()}`);
    }
  }
  dictionaryCount = count;
  generation += 1;
}

// The only thing that can fail here is the storage round trip through the
// service worker -- the worker can be torn down between the request and the
// reply, and reconcile() gives up after three refused writes. The engine is
// untouched by that, so it stays usable; what it has loaded is not, hence the
// error is kept for hd_status to report and for the next request to retry.
async function reloadFromStorage() {
  try {
    loadDictionaries(await reconcile());
    reloadError = null;
  } catch (error) {
    reloadError = asError(error);
    throw reloadError;
  }
}

// A lookup served while reloadError is set would answer dictionaryCount 0, which
// the content script renders as "no dictionaries imported" -- a lie the reader
// cannot act on. Retry instead: the usual cause is a service worker that died
// mid-message, and the next request reaches a fresh one.
async function ensureLoaded() {
  requireEngine();
  if (reloadError !== null) {
    await reloadFromStorage();
  }
}

// Single-flight: hd_status is polled every second while the engine is loading,
// and each retry unloads and reloads every dictionary.
let reloadRetry = null;

function retryReload() {
  if (reloadRetry !== null) {
    return;
  }
  // Through serialise(), or this would call hdw_reset underneath a running
  // import. The rejection is already recorded in reloadError.
  const run = serialise(reloadFromStorage);
  reloadRetry = run;
  const done = () => {
    if (reloadRetry === run) {
      reloadRetry = null;
    }
  };
  run.then(done, done);
}

async function boot() {
  try {
    if (!(await navigator.storage.persist())) {
      console.warn("hoshidicts: storage is not persistent, Chrome may evict imported dictionaries");
    }
  } catch (error) {
    console.warn(`hoshidicts: navigator.storage.persist() failed: ${describe(error)}`);
  }

  try {
    engine = await createHoshidicts();
    if (!exists(DICT_ROOT)) {
      engine.FS.mkdir(DICT_ROOT);
    }
    engine.FS.mount(engine.IDBFS, {}, DICT_ROOT);
    await syncfs(true);
    ready = true;
  } catch (error) {
    ready = false;
    bootError = asError(error);
    console.error(`hoshidicts: the engine failed to start: ${bootError.message}`);
    return;
  }

  // Outside the try above on purpose: a failed dictionary list is not a failed
  // engine, and latching bootError here would leave a working engine refusing
  // every lookup and every import until the browser restarts, since nothing
  // recreates this document.
  try {
    await reloadFromStorage();
  } catch (error) {
    console.error(`hoshidicts: could not load the dictionaries at startup: ${describe(error)}`);
  }
}

function emptyReport(error) {
  return {
    success: false,
    title: "",
    termCount: 0,
    metaCount: 0,
    frequencyCount: 0,
    pitchCount: 0,
    kanjiCount: 0,
    mediaCount: 0,
    error,
  };
}

function normaliseReport(raw) {
  const report = emptyReport(text(raw?.error));
  report.success = raw?.success === true;
  report.title = text(raw?.title);
  for (const key of ["termCount", "metaCount", "frequencyCount", "pitchCount", "kanjiCount", "mediaCount"]) {
    const count = Number(raw?.[key]);
    report[key] = Number.isFinite(count) ? count : 0;
  }
  return report;
}

// One archive can carry term, meta and kanji banks at once, and the engine keeps
// a separate index per kind: registering the directory under only one of them
// leaves the rest of the data imported but unreachable, and the settings page has
// no control for adding a kind. So register every kind the importer actually
// found, and let the reader turn the ones they do not want off.
function kindsFor(report) {
  const kinds = [
    ["term", report.termCount],
    ["freq", report.frequencyCount],
    ["pitch", report.pitchCount],
    ["kanji", report.kanjiCount],
  ]
    .filter(([, count]) => count > 0)
    .map(([kind]) => kind);
  // An archive the importer accepted with nothing countable in it is still a term
  // dictionary as far as the reader is concerned.
  return kinds.length === 0 ? ["term"] : kinds;
}

function withImport(stored, report) {
  const entries = [];
  const kinds = new Set();
  for (const row of stored) {
    if (text(row?.title) !== report.title) {
      entries.push(row);
      continue;
    }
    // Re-importing keeps the position and enabled state the reader chose.
    const entry = entryFor(report.title, row);
    if (kinds.has(entry.kind)) {
      continue;
    }
    kinds.add(entry.kind);
    entries.push(entry);
  }
  for (const kind of kindsFor(report)) {
    if (!kinds.has(kind)) {
      kinds.add(kind);
      entries.push(entryFor(report.title, { kind }));
    }
  }
  return entries;
}

async function recordImport(report) {
  await updateStoredDictionaries((stored) => withImport(stored, report));
}

function toBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

function mediaType(path) {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  return MEDIA_TYPES[extension] ?? "application/octet-stream";
}

const HANDLERS = {
  async hd_lookup(message) {
    await ensureLoaded();
    const options = {
      frequencyDictionary: text(message.options?.frequencyDictionary),
      frequencyOrder: FREQUENCY_ORDERS.includes(message.options?.frequencyOrder)
        ? message.options.frequencyOrder
        : "auto",
      primaryReading: text(message.options?.primaryReading),
    };
    const json = engine.ccall(
      "hdw_lookup",
      "string",
      ["string", "number", "number", "string"],
      [
        text(message.text),
        clampInt(message.maxResults, 1, 256, DEFAULT_MAX_RESULTS),
        clampInt(message.scanLength, 1, 64, DEFAULT_SCAN_LENGTH),
        JSON.stringify(options),
      ],
    );
    throwIfEngineFailed("hdw_lookup");
    const parsed = parseJson(json, "hdw_lookup");
    const count = Number(parsed?.dictionaryCount);
    return {
      results: Array.isArray(parsed?.results) ? parsed.results : [],
      dictionaryCount: Number.isFinite(count) ? count : dictionaryCount,
    };
  },

  async hd_kanji(message) {
    await ensureLoaded();
    const character = text(message.character);
    if (character === "") {
      return { kanji: null };
    }
    const json = engine.ccall("hdw_kanji", "string", ["string"], [character]);
    throwIfEngineFailed("hdw_kanji");
    const kanji = parseJson(json, "hdw_kanji");
    return { kanji: text(kanji?.character) === "" ? null : kanji };
  },

  hd_styles() {
    requireEngine();
    const json = engine.ccall("hdw_styles", "string", [], []);
    throwIfEngineFailed("hdw_styles");
    const styles = parseJson(json, "hdw_styles");
    return { styles: Array.isArray(styles) ? styles : [] };
  },

  hd_media(message) {
    requireEngine();
    const dictionary = text(message.dictionary);
    const path = text(message.path);
    if (dictionary === "" || path === "") {
      return { dataUrl: null };
    }
    const length = engine.ccall("hdw_media", "number", ["string", "string"], [dictionary, path]);
    if (length <= 0) {
      return { dataUrl: null };
    }
    // "pointer", not "number": the glue only masks the raw i32 back to unsigned
    // for the former, and with ALLOW_MEMORY_GROWTH up to 4GB the buffer can sit
    // above 0x80000000, where a signed read silently slices the wrong bytes.
    const pointer = engine.ccall("hdw_media_data", "pointer", [], []);
    if (pointer === 0) {
      return { dataUrl: null };
    }
    // Read HEAPU8 through the module: memory growth swaps the view out.
    const bytes = engine.HEAPU8.subarray(pointer, pointer + length);
    return { dataUrl: `data:${mediaType(path)};base64,${toBase64(bytes)}` };
  },

  async hd_import(message) {
    requireEngine();
    const FS = engine.FS;
    const blobUrl = text(message.blobUrl);
    const fileName = text(message.fileName) || "the archive";
    if (blobUrl === "") {
      throw new Error("the import request carried no archive URL");
    }

    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new Error(`could not read ${fileName}: HTTP ${response.status}`);
    }
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error(`${fileName} is empty`);
    }

    // Unload before importing: the loaded dictionaries are mapped into the same
    // 32-bit address space the importer needs, and re-importing a title writes
    // over files the query still holds open. Lookups cannot be served during an
    // import anyway, since they queue behind it.
    engine.ccall("hdw_reset", null, [], []);
    dictionaryCount = 0;
    generation += 1;

    let report;
    try {
      try {
        FS.writeFile(IMPORT_ZIP, bytes);
        // The MEMFS copy is the one the importer reads; drop ours before it runs
        // so the archive is not held twice.
        bytes = null;
        report = normaliseReport(
          parseJson(
            // low_ram caps the bank batch size at 2, which keeps peak memory down.
            engine.ccall("hdw_import", "string", ["string", "string", "number"], [IMPORT_ZIP, DICT_ROOT, 1]),
            "hdw_import",
          ),
        );
      } finally {
        try {
          FS.unlink(IMPORT_ZIP);
        } catch (error) {
          // Never written, or already gone.
        }
      }

      if (report.success && report.title === "") {
        // hdw_import refuses a title it cannot use as a folder name, so this is
        // unreachable; without a title there is nothing to register, and a row
        // with an empty title would poison reconcile().
        report.success = false;
        report.error = `${fileName} declares no dictionary title`;
      }
      if (report.success) {
        // Before recordImport, which is a message round trip and can fail: the
        // files are already on disk by then, so the reload below would adopt the
        // directory, and only this report knows which banks it holds.
        importedKinds.set(report.title, kindsFor(report));
        await syncfs(false);
        await recordImport(report);
      }
    } finally {
      // reloadFromStorage() has recorded the failure in reloadError, which
      // hd_status reports and the next lookup retries; logging here would
      // otherwise be the only trace, in a document with no console anyone reads.
      try {
        await reloadFromStorage();
      } catch (error) {
        console.error(`hoshidicts: could not reload after the import: ${describe(error)}`);
      }
    }

    if (!report.success) {
      return { ok: false, error: report.error || `${fileName} could not be imported`, report };
    }
    return { report };
  },

  async hd_reload() {
    requireEngine();
    await reloadFromStorage();
    return { dictionaryCount };
  },

  async hd_remove(message) {
    requireEngine();
    const title = text(message.title);
    if (title === "") {
      throw new Error("the remove request carried no dictionary title");
    }
    const stored = await readStoredDictionaries();
    const remaining = stored.filter((row) => text(row?.title) !== title);
    if (remaining.length === stored.length && !exists(`${DICT_ROOT}/${title}`)) {
      // Nothing to do, and reloading for nothing would invalidate the renderer's
      // media cache.
      return {};
    }

    // Unload first: the query keeps the dictionary's files open.
    engine.ccall("hdw_reset", null, [], []);
    dictionaryCount = 0;
    generation += 1;

    // Everything from here on can fail -- an IDBFS transaction can abort, an FS
    // node can refuse to go -- and the reset above has already dropped the
    // dictionaries the user is keeping. Reload whatever survived either way, or
    // every tab would report no dictionaries until the next storage edit.
    try {
      removeTree(`${DICT_ROOT}/${title}`);
      await syncfs(false);
      await updateStoredDictionaries((rows) => rows.filter((row) => text(row?.title) !== title));
      importedKinds.delete(title);
    } finally {
      // As in hd_import: the failure is in reloadError, so hd_status says so and
      // the next lookup retries rather than reporting no dictionaries.
      try {
        await reloadFromStorage();
      } catch (error) {
        console.error(`hoshidicts: could not reload after the removal: ${describe(error)}`);
      }
    }
    return {};
  },

  hd_status() {
    // Nothing else repairs a failed reload on its own. ensureLoaded() retries on
    // the next lookup, which keeps hovering alive, but a reader who only opens
    // the settings page would sit in front of "Engine error, 0 dictionaries
    // loaded" indefinitely -- the engine is fine and the files are on disk, and
    // the only way out was to go and hover a word. So a status poll drives the
    // recovery: this reply describes the state as it is now, and the next poll
    // sees the repair. A timer would do the same, but would also keep waking the
    // service worker forever in the case where the retry cannot succeed.
    if (bootError === null && reloadError !== null) {
      retryReload();
    }
    // A reload failure is reported here too, or an engine that is ready with
    // nothing loaded is indistinguishable from an empty profile: the settings
    // page would say "0 dictionaries loaded" next to the rows it just imported.
    const failure = bootError ?? reloadError;
    return {
      ok: failure === null,
      error: failure === null ? null : describe(failure),
      ready,
      loading: busy > 0,
      dictionaryCount,
      generation,
    };
  },
};

function failurePayload(type) {
  switch (type) {
    case "hd_lookup":
      return { results: [], dictionaryCount: 0 };
    case "hd_kanji":
      return { kanji: null };
    case "hd_styles":
      return { styles: [] };
    case "hd_media":
      return { dataUrl: null };
    case "hd_import":
      return { report: emptyReport("") };
    case "hd_reload":
      return { dictionaryCount: 0 };
    case "hd_status":
      return { ready: false, loading: false, dictionaryCount: 0, generation };
    default:
      return {};
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // background.js stamps `relayed`; the unstamped copy that sendMessage also
  // delivers here from an extension page would otherwise run the same request a
  // second time.
  if (!message || message.target !== TARGET || message.relayed !== true) {
    return false;
  }

  const type = text(message.type);
  const requestId = message.requestId ?? null;
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, type)) {
    sendResponse({
      type: `${type || "hd_unknown"}_result`,
      requestId,
      ok: false,
      error: `unknown request type ${JSON.stringify(type)}`,
      generation,
    });
    return false;
  }

  const handler = HANDLERS[type];
  const run = UNQUEUED.has(type)
    ? Promise.resolve().then(() => handler(message))
    : serialise(() => handler(message));
  run.then(
    (result) => {
      const { ok = true, error = null, ...payload } = result ?? {};
      sendResponse({ type: `${type}_result`, requestId, ok, error, generation, ...payload });
    },
    (error) => {
      sendResponse({
        type: `${type}_result`,
        requestId,
        ok: false,
        error: describe(error),
        generation,
        ...failurePayload(type),
      });
    },
  );
  return true;
});

serialise(boot);
