/*
 * Owns the single hoshidicts engine instance inside a dedicated Web Worker.
 *
 * Everything that touches the engine runs on one promise chain: the engine is
 * not reentrant, and an import must never interleave with a lookup. Blocking the
 * worker for the length of an import is safe: pthread joins and synchronous
 * OPFS access must not block the offscreen document's browser main thread.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const WORKER_TARGET = "hoshidicts-worker";
const DICT_ROOT = "/dicts";
const REMOVAL_ROOT = `${DICT_ROOT}/.hdw-remove`;
const IMPORT_ZIP = "/.hdw-archive.zip";
const OPFS_IMPORT_ZIP = `${DICT_ROOT}/.hdw-archive.zip`;

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
// its filesystem did not mount -- which nothing in this worker can undo.
let bootError = null;
// Set when the engine is fine but the dictionary list could not be read or
// written, which leaves nothing loaded. Recoverable, so it is reported and
// retried rather than latched.
let reloadError = null;
let ready = false;
let busy = 0;
let generation = 0;
let dictionaryCount = 0;
let hostRequest = null;
let started = false;
let createHoshidicts = null;
let storageBackend = "memory";
let lowRam = true;

export function configureEngineService(request, options = {}) {
  if (hostRequest !== null) {
    throw new Error("the engine service is already configured");
  }
  hostRequest = request;
  createHoshidicts = options.createHoshidicts;
  storageBackend = options.storageBackend ?? "memory";
  lowRam = options.lowRam !== false;
}

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

function usableDictionaryTitle(title) {
  return (
    title !== "" &&
    title !== "." &&
    title !== ".." &&
    title !== ".hdw-import" &&
    title !== ".hdw-remove" &&
    !title.includes("/") &&
    !title.includes("\\") &&
    !title.includes("\0")
  );
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

async function persistFilesystem() {
  if (storageBackend === "idbfs") {
    await syncfs(false);
  }
}

function exists(path) {
  try {
    engine.FS.stat(path);
    return true;
  } catch (error) {
    return false;
  }
}

function isDirectory(stat) {
  return (stat.mode & 0o170000) === 0o040000;
}

function removeTree(path) {
  const FS = engine.FS;
  let stat;
  try {
    stat = FS.stat(path);
  } catch (error) {
    return;
  }
  if (!isDirectory(stat)) {
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

function removeEmptyDirectory(path) {
  if (exists(path) && engine.FS.readdir(path).every((name) => name === "." || name === "..")) {
    engine.FS.rmdir(path);
  }
}

function moveDictionaryFiles(source, destination, markerLast) {
  const FS = engine.FS;
  if (!exists(destination)) {
    FS.mkdir(destination);
  }
  const files = FS.readdir(source).filter((name) => name !== "." && name !== "..");
  for (const name of files) {
    if (isDirectory(FS.stat(`${source}/${name}`))) {
      throw new Error("an imported dictionary contains an unsupported nested path");
    }
  }
  const markers = files.filter((name) => MARKER_FILES.includes(name));
  const data = files.filter((name) => !MARKER_FILES.includes(name));
  for (const name of markerLast ? [...data, ...markers] : [...markers, ...data]) {
    FS.rename(`${source}/${name}`, `${destination}/${name}`);
  }
  removeEmptyDirectory(source);
}

function settleStagedRemoval(title, restore) {
  const stagedPath = `${REMOVAL_ROOT}/${title}`;
  if (!exists(stagedPath)) {
    return false;
  }
  if (restore) {
    moveDictionaryFiles(stagedPath, `${DICT_ROOT}/${title}`, true);
  } else {
    removeTree(stagedPath);
  }
  removeEmptyDirectory(REMOVAL_ROOT);
  return true;
}

function count(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function optionalText(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function installedAt(importDate, path) {
  if (typeof importDate === "number" && Number.isFinite(importDate)) {
    return new Date(importDate).toISOString();
  }
  const mtime = engine.FS.stat(`${path}/index.json`).mtime;
  return new Date(mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000).toISOString();
}

async function stableDictionaryId(title) {
  const bytes = new TextEncoder().encode(title.normalize("NFC"));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function packageFromIndex(path) {
  const json = new TextDecoder().decode(engine.FS.readFile(`${path}/index.json`));
  const index = parseJson(json, `${path}/index.json`);
  const title = text(index?.title);
  if (title === "") {
    throw new Error(`${path}/index.json has no dictionary title`);
  }
  return {
    id: await stableDictionaryId(title),
    title,
    displayName: null,
    path,
    enabled: true,
    favorite: false,
    revision: text(index?.revision),
    isUpdatable: index?.isUpdatable === true,
    indexUrl: optionalText(index?.indexUrl),
    downloadUrl: optionalText(index?.downloadUrl),
    language: optionalText(index?.sourceLanguage),
    termCount: count(index?.counts?.terms?.total),
    frequencyCount: count(index?.counts?.termMeta?.freq),
    pitchCount: count(index?.counts?.termMeta?.pitch) + count(index?.counts?.termMeta?.ipa),
    kanjiCount: count(index?.counts?.kanji?.total),
    mediaCount: count(index?.counts?.media?.total),
    installedAt: installedAt(index?.importDate, path),
    lastUpdateCheck: null,
  };
}

async function listImported() {
  const FS = engine.FS;
  const dictionaries = [];
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
    if (isDirectory(stat) && MARKER_FILES.some((marker) => exists(`${path}/${marker}`))) {
      dictionaries.push(await packageFromIndex(path));
    }
  }
  return dictionaries;
}

async function ask(type, fields = {}) {
  if (hostRequest === null) {
    throw new Error("the engine service has no host bridge");
  }
  const reply = await hostRequest({ target: WORKER_TARGET, type, ...fields });
  // A message nothing answers resolves with undefined rather than rejecting, and
  // an unanswered dictionary read is indistinguishable from empty storage --
  // reconcile() would adopt every directory on disk as a term dictionary and
  // write that back over the user's choices. Never degrade to a default here.
  if (reply === undefined || reply === null) {
    throw new Error(`the service worker did not answer ${type}`);
  }
  return reply;
}

async function readDictionaryStorage() {
  const reply = await ask("hd_state_read");
  if (reply.ok !== true) {
    throw new Error(reply.error || "the service worker could not read dictionary state");
  }
  if (reply.state !== null && (
    reply.state?.schemaVersion !== 1
    || !Number.isInteger(reply.state?.revision)
    || reply.state.revision < 0
    || !Array.isArray(reply.state?.dictionaries)
  )) {
    throw new Error("the service worker returned invalid dictionary state");
  }
  if (reply.legacyDictionaries !== null && !Array.isArray(reply.legacyDictionaries)) {
    throw new Error("the service worker returned an invalid legacy dictionary list");
  }
  return {
    state: reply.state,
    legacyDictionaries: reply.legacyDictionaries,
  };
}

async function readStoredDictionaries() {
  const { state } = await readDictionaryStorage();
  return state?.dictionaries ?? [];
}

function sameDictionaries(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// A service worker can commit the CAS and disappear before its reply reaches
// this worker. Read back that one exact revision so callers do not report a
// failed change which storage already accepted.
async function commitDictionaryState(baseRevision, dictionaries) {
  try {
    return await ask("hd_state_cas", { baseRevision, dictionaries });
  } catch (error) {
    const { state } = await readDictionaryStorage();
    if (state?.revision === baseRevision + 1
        && sameDictionaries(state.dictionaries, dictionaries)) {
      return { ok: true, state };
    }
    throw error;
  }
}

async function recoverPendingRemovals(snapshot) {
  if (!exists(REMOVAL_ROOT)) {
    return;
  }
  const stored = snapshot.state?.dictionaries ?? snapshot.legacyDictionaries ?? [];
  const retainedTitles = new Set(stored.map((dictionary) => text(dictionary?.title)));
  let changed = false;
  for (const title of engine.FS.readdir(REMOVAL_ROOT)) {
    if (title === "." || title === ".." || !usableDictionaryTitle(title)) {
      continue;
    }
    changed = settleStagedRemoval(title, retainedTitles.has(title)) || changed;
  }
  if (changed) {
    await persistFilesystem();
  }
}

// `modify` must be a pure function of the storage snapshot, because a write the
// worker refuses is retried against a fresh read.
async function updateDictionaryState(modify) {
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = await readDictionaryStorage();
    const next = await modify(snapshot);
    if (snapshot.state !== null && sameDictionaries(next, snapshot.state.dictionaries)) {
      return snapshot.state;
    }
    const baseRevision = snapshot.state?.revision ?? 0;
    const reply = await commitDictionaryState(baseRevision, next);
    if (reply.ok === true) {
      if (reply.state?.schemaVersion !== 1
          || !Number.isInteger(reply.state?.revision)
          || !Array.isArray(reply.state?.dictionaries)) {
        throw new Error("the service worker returned invalid committed dictionary state");
      }
      return reply.state;
    }
    if (reply.conflict !== true || attempt + 1 >= STORAGE_ATTEMPTS) {
      throw new Error(reply.error || "the service worker could not save dictionary state");
    }
  }
}

function withStoredPresentation(generated, stored) {
  return {
    ...generated,
    displayName: typeof stored?.displayName === "string" ? stored.displayName : null,
    enabled: stored?.enabled !== false,
    favorite: stored?.favorite === true,
    isUpdatable: stored?.isUpdatable === true || generated.isUpdatable,
    indexUrl: stored?.indexUrl ?? generated.indexUrl,
    downloadUrl: stored?.downloadUrl ?? generated.downloadUrl,
    lastUpdateCheck: stored?.lastUpdateCheck ?? null,
  };
}

// Storage holds the load order, the engine holds the data; either can be ahead
// of the other after a crash, so trust generated index.json for metadata and
// storage for order and presentation.
function reconcilePackages(stored, onDisk) {
  const entries = [];
  const listed = new Set();
  for (const storedPackage of stored) {
    const title = text(storedPackage?.title);
    const generated = onDisk.get(title);
    if (generated !== undefined && !listed.has(title)) {
      listed.add(title);
      entries.push(withStoredPresentation(generated, storedPackage));
    }
  }
  for (const [title, generated] of onDisk) {
    if (!listed.has(title)) {
      listed.add(title);
      entries.push(generated);
    }
  }
  return entries;
}

function migrateLegacyPackages(legacy, onDisk) {
  const orderedTitles = [];
  const enabledByTitle = new Map();
  for (const row of legacy) {
    const title = text(row?.title);
    if (title === "" || !onDisk.has(title)) {
      continue;
    }
    if (!enabledByTitle.has(title)) {
      orderedTitles.push(title);
      enabledByTitle.set(title, false);
    }
    if (row?.enabled !== false) {
      enabledByTitle.set(title, true);
    }
  }

  const entries = [];
  const listed = new Set();
  for (const title of orderedTitles) {
    listed.add(title);
    entries.push({ ...onDisk.get(title), enabled: enabledByTitle.get(title) });
  }
  for (const [title, generated] of onDisk) {
    if (!listed.has(title)) {
      entries.push(generated);
    }
  }
  return entries;
}

async function reconcile() {
  await recoverPendingRemovals(await readDictionaryStorage());
  const onDisk = new Map((await listImported()).map((dictionary) => [dictionary.title, dictionary]));
  const state = await updateDictionaryState((snapshot) => {
    if (snapshot.state !== null) {
      return reconcilePackages(snapshot.state.dictionaries, onDisk);
    }
    return migrateLegacyPackages(snapshot.legacyDictionaries ?? [], onDisk);
  });
  return state.dictionaries;
}

function kindsForPackage(dictionary) {
  const kinds = [
    ["term", dictionary.termCount],
    ["freq", dictionary.frequencyCount],
    ["pitch", dictionary.pitchCount],
    ["kanji", dictionary.kanjiCount],
  ]
    .filter(([, capabilityCount]) => Number(capabilityCount) > 0)
    .map(([kind]) => kind);
  return kinds.length === 0 ? ["term"] : kinds;
}

function loadDictionaries(dictionaries, { strict = false } = {}) {
  engine.ccall("hdw_reset", null, [], []);
  let loadedCount = 0;
  for (const dictionary of dictionaries) {
    if (dictionary.enabled === false) {
      continue;
    }
    for (const kindName of kindsForPackage(dictionary)) {
      const kind = KINDS.indexOf(kindName);
      if (engine.ccall("hdw_add_dict", "number", ["string", "number"], [dictionary.path, kind])) {
        loadedCount += 1;
      } else {
        const error = `could not load ${dictionary.path} as ${kindName}: ${lastError()}`;
        if (strict) {
          throw new Error(error);
        }
        console.warn(`hoshidicts: ${error}`);
      }
    }
  }
  return loadedCount;
}

function publishLoadedDictionaries(loadedCount) {
  dictionaryCount = loadedCount;
  generation += 1;
}

async function restoreCommittedDictionaries(state = null) {
  const committed = state ?? (await readDictionaryStorage()).state;
  if (committed === null) {
    throw new Error("the committed dictionary state is unavailable");
  }
  publishLoadedDictionaries(loadDictionaries(committed.dictionaries, { strict: true }));
  reloadError = null;
}

async function loadRemovalCandidate(state, dictionaries) {
  try {
    return loadDictionaries(dictionaries, { strict: true });
  } catch (error) {
    await restoreCommittedDictionaries(state);
    throw error;
  }
}

function stageDictionaryRemoval(title) {
  const installedPath = `${DICT_ROOT}/${title}`;
  if (!exists(installedPath)) {
    return;
  }
  if (!exists(REMOVAL_ROOT)) {
    engine.FS.mkdir(REMOVAL_ROOT);
  }
  moveDictionaryFiles(installedPath, `${REMOVAL_ROOT}/${title}`, false);
}

async function settleRemovalForState(title, state) {
  const retained = state.dictionaries.some(
    (dictionary) => text(dictionary?.title) === title,
  );
  if (settleStagedRemoval(title, retained)) {
    await persistFilesystem();
  }
  await restoreCommittedDictionaries(state);
}

async function commitRemovalState(snapshot, title, remaining) {
  const reply = await commitDictionaryState(snapshot.state.revision, remaining);
  if (reply.ok === true) {
    return null;
  }
  if (reply.conflict !== true || reply.state === null) {
    throw new Error(reply.error || "the dictionary removal could not be saved");
  }
  await settleRemovalForState(title, reply.state);
  return {
    ok: false,
    conflict: true,
    error: reply.error || "the dictionary state changed during removal",
    state: reply.state,
  };
}

async function rollbackRemoval(snapshot, title, readCurrentState) {
  let state = snapshot.state;
  if (readCurrentState) {
    ({ state } = await readDictionaryStorage());
    if (state === null) {
      throw new Error("the dictionary state is unavailable during removal rollback");
    }
  }
  await settleRemovalForState(title, state);
}

// The only thing that can fail here is the storage round trip through the
// service worker -- the worker can be torn down between the request and the
// reply, and reconcile() gives up after three refused writes. The engine is
// untouched by that, so it stays usable; what it has loaded is not, hence the
// error is kept for hd_status to report and for the next request to retry.
async function reloadFromStorage() {
  try {
    publishLoadedDictionaries(loadDictionaries(await reconcile()));
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
    if (typeof createHoshidicts !== "function") {
      throw new Error("the engine service has no WASM factory");
    }
    engine = await createHoshidicts();
    if (storageBackend === "idbfs") {
      if (!exists(DICT_ROOT)) {
        engine.FS.mkdir(DICT_ROOT);
      }
      engine.FS.mount(engine.IDBFS, {}, DICT_ROOT);
      await syncfs(true);
    } else {
      const initialized = engine.ccall(
        "hdw_init_storage",
        "number",
        ["number"],
        [storageBackend === "opfs" ? 1 : 0],
      );
      if (initialized !== 1) {
        throwIfEngineFailed("hdw_init_storage");
        throw new Error("hdw_init_storage failed");
      }
      if (storageBackend === "opfs") {
        try {
          engine.FS.unlink(OPFS_IMPORT_ZIP);
        } catch {
          // No archive was left by an interrupted import.
        }
      }
    }
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

function withImport(stored, generated) {
  const existingIndex = stored.findIndex((dictionary) =>
    dictionary?.id === generated.id || text(dictionary?.title) === generated.title);
  if (existingIndex < 0) {
    return [...stored, generated];
  }
  const next = [...stored];
  next[existingIndex] = withStoredPresentation(generated, stored[existingIndex]);
  return next;
}

async function recordImport(report) {
  const generated = await packageFromIndex(`${DICT_ROOT}/${report.title}`);
  await updateDictionaryState((snapshot) => withImport(snapshot.state?.dictionaries ?? [], generated));
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

export async function streamResponseToFile(FS, response, path) {
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    FS.writeFile(path, bytes);
    return bytes.byteLength;
  }

  const output = FS.open(path, "w");
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes.byteLength === 0) continue;
      FS.write(output, bytes, 0, bytes.byteLength);
      written += bytes.byteLength;
    }
  } finally {
    FS.close(output);
    reader.releaseLock?.();
  }
  return written;
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

  async hd_lookup_dictionary(message) {
    await ensureLoaded();
    const title = text(message.dictionary);
    const entry = (await readStoredDictionaries()).find((candidate) =>
      candidate?.enabled !== false
      && kindsForPackage(candidate).includes("term")
      && candidate?.title === title);
    if (!entry) {
      return { results: [], dictionaryCount };
    }
    const options = {
      frequencyDictionary: text(message.options?.frequencyDictionary),
      frequencyOrder: FREQUENCY_ORDERS.includes(message.options?.frequencyOrder)
        ? message.options.frequencyOrder
        : "auto",
      primaryReading: text(message.options?.primaryReading),
    };
    const json = engine.ccall(
      "hdw_lookup_dictionary",
      "string",
      ["string", "string", "number", "number", "string"],
      [
        text(message.text),
        text(entry.path),
        clampInt(message.maxResults, 1, 256, DEFAULT_MAX_RESULTS),
        clampInt(message.scanLength, 1, 64, DEFAULT_SCAN_LENGTH),
        JSON.stringify(options),
      ],
    );
    throwIfEngineFailed("hdw_lookup_dictionary");
    const parsed = parseJson(json, "hdw_lookup_dictionary");
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
    const importLowRam = typeof message.lowRam === "boolean" ? message.lowRam : lowRam;
    if (blobUrl === "") {
      throw new Error("the import request carried no archive URL");
    }

    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new Error(`could not read ${fileName}: HTTP ${response.status}`);
    }
    // Unload before importing: the loaded dictionaries are mapped into the same
    // 32-bit address space the importer needs, and re-importing a title writes
    // over files the query still holds open. Lookups cannot be served during an
    // import anyway, since they queue behind it.
    engine.ccall("hdw_reset", null, [], []);
    dictionaryCount = 0;
    generation += 1;

    const archivePath = storageBackend === "opfs" ? OPFS_IMPORT_ZIP : IMPORT_ZIP;
    let report;
    try {
      try {
        const archiveBytes = await streamResponseToFile(FS, response, archivePath);
        if (archiveBytes === 0) {
          throw new Error(`${fileName} is empty`);
        }
        report = normaliseReport(
          parseJson(
            engine.ccall(
              "hdw_import",
              "string",
              ["string", "string", "number"],
              [archivePath, DICT_ROOT, importLowRam ? 1 : 0],
            ),
            "hdw_import",
          ),
        );
      } finally {
        try {
          FS.unlink(archivePath);
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
        await persistFilesystem();
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

  async hd_apply_state(message) {
    requireEngine();
    if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
      throw new Error("the dictionary state change carried no valid base revision");
    }
    if (!Array.isArray(message?.dictionaries)) {
      throw new TypeError("the dictionary state change carried no dictionary list");
    }

    let restorationAttempted = false;
    try {
      const loadedCount = loadDictionaries(message.dictionaries, { strict: true });
      const reply = await commitDictionaryState(message.baseRevision, message.dictionaries);
      if (reply.ok === true) {
        publishLoadedDictionaries(loadedCount);
        reloadError = null;
        return { state: reply.state };
      }
      if (reply.conflict !== true || reply.state === null) {
        throw new Error(reply.error || "the dictionary state could not be saved");
      }
      restorationAttempted = true;
      await restoreCommittedDictionaries(reply.state);
      return {
        ok: false,
        conflict: true,
        error: reply.error || "the dictionary state changed while it was being written",
        state: reply.state,
      };
    } catch (error) {
      if (restorationAttempted) {
        reloadError = asError(error);
        throw error;
      }
      try {
        const { state } = await readDictionaryStorage();
        await restoreCommittedDictionaries(state);
      } catch (restoreError) {
        reloadError = asError(restoreError);
      }
      throw error;
    }
  },

  async hd_reload() {
    requireEngine();
    await reloadFromStorage();
    return { dictionaryCount };
  },

  async hd_remove(message) {
    requireEngine();
    const title = text(message.title);
    if (!usableDictionaryTitle(title)) {
      throw new Error("the remove request carried an unusable dictionary title");
    }
    const snapshot = await readDictionaryStorage();
    if (snapshot.state === null) {
      throw new Error("the dictionary state is unavailable");
    }
    await recoverPendingRemovals(snapshot);

    const remaining = snapshot.state.dictionaries.filter(
      (dictionary) => text(dictionary?.title) !== title,
    );
    const installedPath = `${DICT_ROOT}/${title}`;
    if (remaining.length === snapshot.state.dictionaries.length && !exists(installedPath)) {
      // Nothing to do, and reloading for nothing would invalidate the renderer's
      // media cache.
      return {};
    }

    const loadedCount = await loadRemovalCandidate(snapshot.state, remaining);

    let casAttempted = false;
    try {
      stageDictionaryRemoval(title);
      await persistFilesystem();

      casAttempted = true;
      const conflict = await commitRemovalState(snapshot, title, remaining);
      if (conflict !== null) {
        return conflict;
      }

      publishLoadedDictionaries(loadedCount);
      reloadError = null;
    } catch (error) {
      try {
        await rollbackRemoval(snapshot, title, casAttempted);
      } catch (restoreError) {
        reloadError = asError(restoreError);
        throw new Error(`${describe(error)}; removal rollback failed: ${describe(restoreError)}`);
      }
      throw error;
    }

    // The package is no longer reachable through storage or the live engine.
    // Cleanup may be retried by reconcile() after a crash or filesystem error.
    try {
      if (settleStagedRemoval(title, false)) {
        await persistFilesystem();
      }
    } catch (error) {
      console.warn(`hoshidicts: could not finish removing ${title}: ${describe(error)}`);
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
      storageBackend,
      threaded: storageBackend === "opfs",
    };
  },
};

function failurePayload(type) {
  switch (type) {
    case "hd_lookup":
    case "hd_lookup_dictionary":
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

export async function handleEngineMessage(message) {
  const type = text(message.type);
  const requestId = message.requestId ?? null;
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, type)) {
    return {
      type: `${type || "hd_unknown"}_result`,
      requestId,
      ok: false,
      error: `unknown request type ${JSON.stringify(type)}`,
      generation,
    };
  }

  const handler = HANDLERS[type];
  const run = UNQUEUED.has(type)
    ? Promise.resolve().then(() => handler(message))
    : serialise(() => handler(message));
  try {
    const result = await run;
    const { ok = true, error = null, ...payload } = result ?? {};
    return { type: `${type}_result`, requestId, ok, error, generation, ...payload };
  } catch (error) {
    return {
      type: `${type}_result`,
      requestId,
      ok: false,
      error: describe(error),
      generation,
      ...failurePayload(type),
    };
  }
}

export function startEngine() {
  if (started) {
    throw new Error("the engine service is already started");
  }
  started = true;
  serialise(boot);
}
