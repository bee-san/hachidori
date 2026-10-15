// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEBUG_LOG_LIMIT, DEBUG_LOG_MESSAGE_LIMIT, REDACTED, REDACTED_JAPANESE,
  captureDebugLog, captureDocumentActions, formatDebugErrorReport, openDebugLogStore, readDebugLog,
  recordDebugFailure, recordUserError, redactDebugText,
} from "../extension/debug-log.js";
import { assembleDebugLog } from "../extension/debug-info.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

function scope({ fetch = null } = {}) {
  const printed = [];
  const listeners = {};
  return {
    printed, listeners,
    console: { warn: (...args) => printed.push(["warn", ...args]), error: (...args) => printed.push(["error", ...args]) },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    ...(fetch ? { fetch } : {}),
  };
}

// The part of IndexedDB the ring uses: one database of object stores with
// out-of-line or generated keys, get, add, put, getAll and a forward cursor.
// Each request answers on a later turn, a transaction completes once no
// request is waiting, and a database runs one transaction at a time, as a
// browser does for transactions whose stores overlap.
function fakeIndexedDB() {
  const databases = new Map();
  const later = callback => setImmediate(callback);
  const request = () => ({ onsuccess: null, onerror: null, result: undefined, error: null });
  function transaction(database) {
    let waiting = 0;
    let complete = false;
    let finish;
    const started = database.tail;
    database.tail = new Promise(resolveFinished => { finish = resolveFinished; });
    const handle = { oncomplete: null, onerror: null, onabort: null, error: null };
    const settle = () => later(() => {
      if (complete || waiting > 0) return;
      complete = true;
      finish();
      handle.oncomplete?.();
    });
    const answer = (pending, result) => {
      waiting += 1;
      void started.then(() => later(() => {
        pending.result = result();
        waiting -= 1;
        pending.onsuccess?.();
        settle();
      }));
      return pending;
    };
    const run = result => answer(request(), result);
    handle.objectStore = (name) => {
      const store = database.stores.get(name);
      const keys = () => [...store.rows.keys()].sort((left, right) => left - right);
      return {
        get: key => run(() => structuredClone(store.rows.get(key))),
        add: value => run(() => {
          const key = store.next++;
          store.rows.set(key, structuredClone(value));
          return key;
        }),
        put: (value, key) => run(() => {
          store.rows.set(key, structuredClone(value));
          return key;
        }),
        getAll: () => run(() => keys().map(key => structuredClone(store.rows.get(key)))),
        openCursor() {
          const pending = request();
          const order = keys();
          let at = 0;
          const step = () => answer(pending, () => {
            const key = order[at];
            return key === undefined ? null : {
              key, value: structuredClone(store.rows.get(key)),
              delete: () => { store.rows.delete(key); },
              continue: () => { at += 1; step(); },
            };
          });
          return step();
        },
      };
    };
    settle();
    return handle;
  }
  return {
    databases,
    open(name) {
      const opening = request();
      later(() => {
        const created = !databases.has(name);
        if (created) databases.set(name, { stores: new Map(), tail: Promise.resolve() });
        const database = databases.get(name);
        opening.result = {
          createObjectStore(store) { database.stores.set(store, { rows: new Map(), next: 1 }); },
          transaction: () => transaction(database),
          close() {},
        };
        if (created) opening.onupgradeneeded?.();
        opening.onsuccess?.();
      });
      return opening;
    },
  };
}

test("warnings, errors, uncaught failures, failed fetches and failed replies are kept and still printed", async () => {
  const offline = new TypeError("Failed to fetch");
  let call = 0;
  const global = scope({
    fetch: async (input) => {
      call += 1;
      if (call === 2) throw new DOMException("The operation was aborted.", "AbortError");
      if (String(input).includes("offline")) throw offline;
      return { ok: true };
    },
  });
  captureDebugLog(global, { context: "offscreen", now: () => 0, version: "1.2.3", session: "s1" });
  global.console.warn("hoshidicts: direct OPFS is unavailable", { reason: "denied" });
  global.console.error(new Error("engine failed"));
  global.listeners.unhandledrejection({ reason: "lost reply" });
  global.listeners.error({ error: new RangeError("bad index") });
  recordDebugFailure(global, "hd_lookup", "the dictionary engine is still starting");
  await assert.rejects(global.fetch("https://example.test/offline.zip"), offline);
  await assert.rejects(global.fetch("https://example.test/cancelled.zip"), { name: "AbortError" });
  assert.deepEqual(await global.fetch("https://example.test/ok.zip"), { ok: true });
  const log = await readDebugLog(global);
  assert.equal(log.context, "offscreen");
  assert.equal(log.session, "s1");
  assert.deepEqual(log.entries.map(entry => [entry.level, entry.message]), [
    ["warn", 'hoshidicts: direct OPFS is unavailable {"reason":"denied"}'],
    ["error", "Error: engine failed"],
    ["unhandledrejection", "lost reply"],
    ["uncaught", "RangeError: bad index"],
    ["failed-request", "hd_lookup: the dictionary engine is still starting"],
    ["failed-fetch", "GET https://example.test/offline.zip: TypeError: Failed to fetch"],
  ]);
  assert.match(log.entries[1].stack, /^Error: engine failed\n\s+at /u);
  assert.deepEqual(log.entries.map(entry => [entry.at, entry.session, entry.n, entry.version]).slice(0, 2),
    [["1970-01-01T00:00:00.000Z", "s1", 1, "1.2.3"], ["1970-01-01T00:00:00.000Z", "s1", 2, "1.2.3"]]);
  assert.deepEqual(global.printed[0], ["warn", "hoshidicts: direct OPFS is unavailable", { reason: "denied" }]);
  assert.equal(captureDebugLog(global, { context: "again" }).context, "offscreen", "one capture per global");
});

test("the log keeps the newest entries in memory, cuts long messages and counts a run of identical entries once", async () => {
  const global = scope();
  let clock = 0;
  captureDebugLog(global, { context: "engine-worker", now: () => clock });
  for (let index = 0; index < DEBUG_LOG_LIMIT + 5; index += 1) global.console.warn(`entry ${index}`);
  global.console.error("x".repeat(DEBUG_LOG_MESSAGE_LIMIT + 10));
  for (let index = 0; index < 3; index += 1) {
    clock += 1000;
    recordDebugFailure(global, "hd_lookup", "lookup text exceeds the 4096-byte limit");
  }
  const { entries } = await readDebugLog(global);
  assert.equal(entries.length, DEBUG_LOG_LIMIT);
  assert.equal(entries[0].message, "entry 7");
  assert.equal(entries.at(-2).message.length, DEBUG_LOG_MESSAGE_LIMIT + 1);
  assert.deepEqual(entries.at(-1), { at: "1970-01-01T00:00:01.000Z", session: entries.at(-1).session, n: DEBUG_LOG_LIMIT + 7,
    context: "engine-worker", version: null, level: "failed-request",
    message: "hd_lookup: lookup text exceeds the 4096-byte limit", repeat: 3, lastAt: "1970-01-01T00:00:03.000Z" });
});

test("redaction removes credentials, address queries and sign-ins, data payloads and Japanese text", () => {
  assert.equal(redactDebugText("GET https://reader:pw@audio.example/clip/%E7%8C%AB.mp3?term=猫&key=k#t: TypeError"),
    `GET https://${REDACTED}@audio.example/clip/${REDACTED}.mp3?${REDACTED}#${REDACTED}: TypeError`);
  assert.equal(redactDebugText('{"anki":{"apiKey":"hunter2"},"sharingToken":"tok"} token=abc; password: p'),
    `{"anki":{"apiKey":"${REDACTED}"},"sharingToken":"${REDACTED}"} token=${REDACTED}; password: ${REDACTED}`);
  assert.equal(redactDebugText("Authorization: Bearer abc.def"), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactDebugText("could not look up 食べたかった in 大辞泉"),
    `could not look up ${REDACTED_JAPANESE} in ${REDACTED_JAPANESE}`);
  assert.equal(redactDebugText("img data:image/png;base64,iVBORw0KGgo= failed"), `img data:image/png;base64,${REDACTED} failed`);
  assert.equal(redactDebugText("file:///home/reader/novel.html failed"), `file:///${REDACTED} failed`);
  assert.equal(redactDebugText("ws://127.0.0.1:8771/link?token=abc failed."), `ws://127.0.0.1:8771/link?${REDACTED} failed.`);
  const frame = "    at run (chrome-extension://abcdefghijklmnop/backup-settings.js:42:7)";
  assert.equal(redactDebugText(frame), frame, "the extension's own stack frames stay readable");
  assert.equal(redactDebugText("hd_import: the dictionary engine is busy mutating"),
    "hd_import: the dictionary engine is busy mutating");
});

test("every entry is redacted before it is kept, including a shown error's stack and cause", async () => {
  const global = scope();
  captureDebugLog(global, { context: "settings" });
  const failure = new Error("AnkiConnect refused apiKey=hunter2 at http://reader:pw@127.0.0.1:8765/?key=hunter2",
    { cause: new Error("note 猫 was a duplicate") });
  recordUserError(global, "anki-status", "Could not add 猫 to Anki.", failure);
  global.console.warn("options", { anki: { apiKey: "hunter2" }, sharing: { token: "tok" } });
  const text = JSON.stringify(await readDebugLog(global));
  for (const secret of ["hunter2", "tok\"", "reader:pw", "猫"]) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  assert.match(text, /Could not add \[ja\] to Anki\./u);
  assert.match(text, /Caused by|note \[ja\] was a duplicate/u);
});

test("a shown error keeps the message, stack, cause and code, and the actions before it name controls only", async (t) => {
  const dom = new JSDOM(`<main id="backup"><button id="backup-export">Export backup</button>
    <ul id="automatic-backup-list"><li><button class="automatic-backup-restore">Restore from 3 hours ago</button></li></ul>
    <input id="opt-anki-api-key" type="text"><input id="import-file" type="file"><output id="backup-status"></output></main>`,
  { url: "chrome-extension://hachidori/settings.html#backup" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const log = captureDebugLog(window, { context: "settings", version: "0.3.1", session: "page1" });
  captureDocumentActions(window.document, log);
  window.document.getElementById("backup-export").click();
  window.document.querySelector(".automatic-backup-restore").click();
  const key = window.document.getElementById("opt-anki-api-key");
  key.value = "hunter2";
  key.dispatchEvent(new window.Event("change", { bubbles: true }));
  window.document.getElementById("import-file").dispatchEvent(new window.Event("change", { bubbles: true }));
  window.location.hash = "#advanced";
  await new Promise(resolveHash => window.addEventListener("hashchange", resolveHash, { once: true }));
  const failure = new Error("Could not create the backup.", { cause: new TypeError("Failed to fetch") });
  failure.code = "backup-export-failed";
  const shown = recordUserError(window, "backup-status", "Could not create the backup.", failure);
  const { entries } = await readDebugLog(window);
  assert.deepEqual(entries.map(entry => [entry.level, entry.message]), [
    ["action", "open settings.html#backup"],
    ["action", "click #backup-export"],
    ["action", "click button.automatic-backup-restore in #automatic-backup-list"],
    ["action", "change #opt-anki-api-key"],
    ["action", "change #import-file (0 files)"],
    ["action", "navigate #advanced"],
    ["user-error", "Could not create the backup."],
  ]);
  assert.equal(entries.at(-1).where, "backup-status");
  assert.equal(entries.at(-1).code, "backup-export-failed");
  assert.match(entries.at(-1).stack, /^Error: Could not create the backup\.\n\s+at /u);
  assert.match(entries.at(-1).cause, /^TypeError: Failed to fetch/u);
  assert.ok(!JSON.stringify(entries).includes("hunter2"), "an action never records a control's value");
  const report = formatDebugErrorReport(log, shown, { userAgent: "Chrome/152" });
  assert.match(report, /^Hachidori 0\.3\.1 · settings · session page1\n.+ · backup-status\nCould not create the backup\.\nCode: backup-export-failed\nError: Could not create the backup\./u);
  assert.match(report, /Caused by: TypeError: Failed to fetch/u);
  assert.match(report, /Before this, on this page:\n(?: {2}\S+ .+\n){6}Browser: Chrome\/152$/u);
  assert.match(report, / {2}\S+ click #backup-export\n/u);
});

test("entries reach the ring in batches and a reloaded page's export still has them", async () => {
  const indexedDB = fakeIndexedDB();
  const before = scope();
  captureDebugLog(before, { context: "settings", version: "0.3.1", session: "first", store: openDebugLogStore(indexedDB) });
  before.console.error("button press failed before the reload");
  recordUserError(before, "backup-status", "Could not create the backup.");
  // The page goes away; a write already scheduled is what pagehide flushes.
  await before.listeners.pagehide();

  const after = scope();
  const store = openDebugLogStore(indexedDB);
  captureDebugLog(after, { context: "settings", version: "0.3.1", session: "second", store });
  after.console.warn("after the reload");
  const live = { settings: await readDebugLog(after) };
  const report = assembleDebugLog(await store.read(), live);
  assert.deepEqual(report.entries.map(entry => [entry.session, entry.level, entry.message]), [
    ["first", "error", "button press failed before the reload"],
    ["first", "user-error", "Could not create the backup."],
    ["second", "warn", "after the reload"],
  ]);
  assert.deepEqual(report.sessions.map(({ session, context, version, live: current, levels }) =>
    ({ session, context, version, live: current, levels })), [
    { session: "first", context: "settings", version: "0.3.1", live: false, levels: { error: 1, "user-error": 1 } },
    { session: "second", context: "settings", version: "0.3.1", live: true, levels: { warn: 1 } },
  ]);
  assert.equal(report.stored.entries, 3);
  assert.ok(report.stored.bytes > 0);
  assert.deepEqual(report.contexts.map(({ probe, session, saved, unsaved, error }) => ({ probe, session, saved, unsaved, error })),
    [{ probe: "settings", session: "second", saved: 1, unsaved: 0, error: null }]);
  assert.ok(report.entries.every(entry => !("bytes" in entry) && !("key" in entry)));
});

test("a repeated entry updates its ring record instead of adding one", async () => {
  const indexedDB = fakeIndexedDB();
  const global = scope();
  const store = openDebugLogStore(indexedDB);
  captureDebugLog(global, { context: "offscreen", session: "burst", store });
  recordDebugFailure(global, "hd_import", "the dictionary engine is busy mutating");
  await readDebugLog(global);
  for (let index = 0; index < 4; index += 1) recordDebugFailure(global, "hd_import", "the dictionary engine is busy mutating");
  await readDebugLog(global);
  const { records, totals } = await store.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].repeat, 5);
  assert.equal(totals.count, 1);
  assert.equal(totals.bytes, records[0].bytes);
});

test("the ring keeps the newest entries within its entry and byte limits across writers", async () => {
  const indexedDB = fakeIndexedDB();
  const writers = ["service-worker", "offscreen", "settings"].map((context) => {
    const global = scope();
    captureDebugLog(global, { context, session: context, store: openDebugLogStore(indexedDB, { maxEntries: 10 }) });
    return global;
  });
  for (let round = 0; round < 6; round += 1) {
    writers.forEach((global, index) => global.console.warn(`round ${round} writer ${index}`));
    await Promise.all(writers.map(global => readDebugLog(global)));
  }
  const kept = await openDebugLogStore(indexedDB, { maxEntries: 10 }).read();
  assert.equal(kept.records.length, 10);
  assert.equal(kept.totals.count, 10);
  // 18 entries from three writers; the oldest eight are gone.
  assert.deepEqual(kept.records.map(record => record.message).slice(0, 2), ["round 2 writer 2", "round 3 writer 0"]);
  assert.equal(kept.records.at(-1).message, "round 5 writer 2");
  assert.equal(kept.totals.bytes, kept.records.reduce((sum, record) => sum + record.bytes, 0));

  const bounded = openDebugLogStore(indexedDB, { name: "bytes", maxBytes: 2_000 });
  const global = scope();
  captureDebugLog(global, { context: "settings", store: bounded });
  for (let index = 0; index < 30; index += 1) global.console.warn(`${index} ${"x".repeat(200)}`);
  await readDebugLog(global);
  const small = await bounded.read();
  assert.ok(small.totals.bytes <= 2_000 && small.totals.bytes > 1_500, JSON.stringify(small.totals));
  assert.equal(small.records.at(-1).message, `29 ${"x".repeat(200)}`);
  assert.equal(small.totals.count, small.records.length);
});

test("a failed write keeps the entries in memory, reports why, and the next write saves them", async () => {
  const saved = [];
  let failures = 1;
  const store = {
    async write(ops) {
      if (failures-- > 0) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      saved.push(...ops.map(op => op.record.message));
      return ops.map((_op, index) => saved.length - ops.length + index + 1);
    },
  };
  const global = scope();
  captureDebugLog(global, { context: "service-worker", store });
  global.console.error("first");
  const failed = await readDebugLog(global);
  assert.equal(failed.error, "The quota has been exceeded.");
  assert.deepEqual(failed.entries.map(entry => entry.message),
    ["first", "the debug log could not be saved: The quota has been exceeded."]);
  global.console.error("second");
  const recovered = await readDebugLog(global);
  assert.deepEqual(saved, ["first", "second"]);
  assert.equal(recovered.error, null);
  assert.equal(recovered.unsaved, 0);
});

test("a context without a capture reports an empty log", async () => {
  assert.deepEqual(await readDebugLog({}), { context: null, entries: [] });
  recordDebugFailure({}, "hd_status", "ignored");
  assert.equal(recordUserError({}, "status", "ignored"), null);
});
