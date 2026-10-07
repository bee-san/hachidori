// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { collectDebugInfo, debugInfoBlob, debugInfoFilename, listOpfs, REDACTED } from "../extension/debug-info.js";

const STORED = {
  options: { revision: 3, lowMemoryMode: true, anki: { url: "http://127.0.0.1:8765", apiKey: "hunter2" },
    experimental: { netflixMining: false } },
  sharing: { enabled: false, token: "" },
  customDictionarySource: { schemaVersion: 1, revision: 4, semanticRevision: "a".repeat(64), text: "猫,ねこ,cat\n犬,いぬ,dog" },
  "lookupStats:x": { term: "猫", reading: "ねこ", lookupCount: 2, firstLookedUpAt: 1, lastLookedUpAt: 2 },
  "lookupStats:y": { term: "犬", reading: "いぬ", lookupCount: 1, firstLookedUpAt: 1, lastLookedUpAt: 1 },
  lookupStats: { generation: "g", revision: 1 },
  ankiDuplicateIndex: { version: 1, snapshot: { sourceKey: "k", refreshedAt: 1, rows: [["猫", true, [1]]] } },
  automaticBackups: { schemaVersion: 1, backups: [{ id: "b1", createdAt: "2026-10-01T00:00:00.000Z", snapshot: { secretNotes: "猫" } }] },
  wordStatusOverrides: { revision: 3, known: ["鶏肉", "豚肉"], ignored: ["牛肉"] },
};

const TARGETS = { worker: "worker", sharing: "sharing", anki: "anki" };

function host({ fail = new Set() } = {}) {
  const sent = [];
  const reject = name => Promise.reject(new Error(`${name} unavailable`));
  const chrome = {
    runtime: {
      id: "extension-id",
      getManifest: () => ({ name: "Hachidori", version: "1.2.3", manifest_version: 3 }),
      getPlatformInfo: () => fail.has("platform") ? reject("platform") : Promise.resolve({ os: "linux", arch: "x86-64" }),
    },
    permissions: { getAll: () => Promise.resolve({ permissions: ["storage"], origins: ["<all_urls>"] }) },
    management: { getSelf: () => Promise.resolve({ installType: "development", enabled: true }) },
    extension: { isAllowedFileSchemeAccess: () => Promise.resolve(false), isAllowedIncognitoAccess: () => Promise.resolve(false) },
    alarms: { getAll: () => Promise.resolve([{ name: "hachidori-automatic-backup", scheduledTime: Date.UTC(2026, 9, 7) }]) },
    commands: { getAll: () => Promise.resolve([{ name: "toggleTextScanning", shortcut: "Alt+Delete" }]) },
    storage: { local: { get: () => Promise.resolve(structuredClone(STORED)), getBytesInUse: () => Promise.resolve(4096) } },
  };
  const window = {
    navigator: { userAgent: "Test/1", languages: ["ja-JP", "en"], hardwareConcurrency: 8,
      storage: { estimate: () => Promise.resolve({ usage: 10, quota: 100 }), persisted: () => Promise.resolve(true) } },
    location: { href: "chrome-extension://extension-id/settings.html#advanced" },
    crossOriginIsolated: true, SharedArrayBuffer, WebAssembly,
  };
  const replies = {
    hd_status: { ok: true, ready: true, dictionaryCount: 2, storageBackend: "opfs", threaded: true },
    hd_memory: { ok: true, heapBytes: 1024, dictionaries: [] },
    hd_memory_total: { ok: true, bytes: 2048 },
    hd_debug_log: { ok: true, logs: [{ context: "offscreen", entries: [{ level: "warn", message: "hoshidicts: direct OPFS is unavailable" }] }] },
    hd_sharing_status: { ok: true, sharing: { enabled: false } },
    hd_anki_status: { ok: true, available: false, error: "Choose an Anki note type in Settings." },
    hd_state_read: { ok: true, state: { dictionaries: [{ id: "a", title: "Jitendex", enabled: true }] } },
  };
  const send = async (type, fields, target = "offscreen") => {
    sent.push({ type, target });
    if (fail.has(type)) throw new Error("the extension's service worker did not reply");
    if (type === "hd_debug_log" && target === "worker") return { ok: true, log: { context: "service-worker", entries: [] } };
    if (type === "hd_memory_total" && fail.has("hang")) return new Promise(() => {});
    return replies[type];
  };
  return { chrome, window, send, sent };
}

test("the debug report carries version, engine, dictionaries and settings without reader content or credentials", async () => {
  const { chrome, window, send, sent } = host();
  const report = await collectDebugInfo({ chrome, window, send, targets: TARGETS,
    context: { effectiveOptions: { anki: { apiKey: "hunter2" } } }, now: () => new Date("2026-10-06T10:00:00.123Z") });

  assert.equal(report.extension.version, "1.2.3");
  assert.deepEqual(report.browser.os, { os: "linux", arch: "x86-64" });
  assert.equal(report.engine.status.dictionaryCount, 2);
  assert.equal(report.engine.memory.heapBytes, 1024);
  assert.equal(report.engine.extensionMemory.bytes, 2048);
  assert.equal(report.dictionaries.state.dictionaries[0].title, "Jitendex");
  assert.deepEqual(sent.find(message => message.type === "hd_state_read"), { type: "hd_state_read", target: "worker" });
  assert.equal(report.extension.self.installType, "development");
  assert.equal(report.extension.fileSchemeAccess, false);
  assert.equal(report.extension.alarms[0].scheduledAt, "2026-10-07T00:00:00.000Z");
  assert.equal(report.extension.manifest.version, "1.2.3");
  assert.equal(report.logs.engine.logs[0].entries[0].message, "hoshidicts: direct OPFS is unavailable");
  assert.equal(report.logs.serviceWorker.log.context, "service-worker");
  assert.equal(report.services.anki.error, "Choose an Anki note type in Settings.");
  assert.deepEqual(sent.filter(message => ["hd_sharing_status", "hd_anki_status"].includes(message.type)).map(message => message.target),
    ["sharing", "anki"]);
  assert.deepEqual(report.extension.userScripts, { available: false });
  assert.ok(report.extension.contexts.error, "an API this host lacks is reported, not fatal");

  const { keys, lookupStatsRows } = report.storage.local;
  assert.equal(keys.options.value.lowMemoryMode, true);
  assert.equal(keys.options.value.anki.apiKey, REDACTED);
  assert.equal(report.settingsPage.effectiveOptions.anki.apiKey, REDACTED);
  assert.equal(keys.sharing.value.token, "", "an unset credential stays visibly unset");
  assert.deepEqual(keys.customDictionarySource.value.text, { omitted: true, characters: 17, lines: 2 });
  assert.equal(lookupStatsRows.count, 2);
  assert.equal(keys["lookupStats:x"], undefined);
  assert.deepEqual(keys.lookupStats.value, { generation: "g", revision: 1 });
  assert.deepEqual(keys.ankiDuplicateIndex.value.snapshot.rows, { omitted: true, count: 1 });
  assert.equal(keys.automaticBackups.value.backups[0].id, "b1");
  assert.ok(keys.automaticBackups.value.backups[0].bytes > 0);
  assert.deepEqual(keys.wordStatusOverrides.value,
    { revision: 3, known: { omitted: true, count: 2 }, ignored: { omitted: true, count: 1 } });

  const text = await debugInfoBlob(report).text();
  for (const secret of ["hunter2", "ねこ", "secretNotes", "鶏肉", "牛肉"]) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.equal(debugInfoFilename(new Date(report.generatedAt)), "hachidori-debug-2026-10-06T10-00-00Z.json");
});

test("a probe that fails is recorded in place and the rest of the report survives", async () => {
  const { chrome, window, send } = host({ fail: new Set(["platform", "hd_memory"]) });
  const report = await collectDebugInfo({ chrome, window, send, targets: TARGETS });
  assert.deepEqual(report.browser.os, { error: "platform unavailable" });
  assert.deepEqual(report.engine.memory, { error: "the extension's service worker did not reply" });
  assert.equal(report.engine.status.ready, true);
  assert.equal(report.extension.version, "1.2.3");
});

test("a probe that never answers times out instead of holding the report", async () => {
  const { chrome, window, send } = host({ fail: new Set(["hang"]) });
  const report = await collectDebugInfo({ chrome, window, send, targets: TARGETS, timeoutMs: 20 });
  assert.deepEqual(report.engine.extensionMemory, { error: "no answer within 0.02 seconds" });
  assert.equal(report.engine.status.ready, true);
});

test("the OPFS listing gives every file's path and size and each directory's total", async () => {
  const file = (size) => ({ kind: "file", getFile: async () => ({ size, lastModified: 0 }) });
  const directory = (children) => ({ kind: "directory", async *entries() { yield* Object.entries(children); } });
  const root = directory({ dicts: directory({ g1: directory({ "hash.table": file(10), "blobs.bin": file(30) }) }), "a.txt": file(2) });
  const listed = await listOpfs(root);
  assert.equal(listed.bytes, 42);
  assert.deepEqual(listed.entries.map(({ path, bytes }) => [path, bytes]),
    [["/a.txt", 2], ["/dicts", 40], ["/dicts/g1", 40], ["/dicts/g1/blobs.bin", 30], ["/dicts/g1/hash.table", 10]]);
});
