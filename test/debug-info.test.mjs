// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { collectDebugInfo, debugInfoBlob, debugInfoFilename, REDACTED } from "../extension/debug-info.js";

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
};

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
    hd_state_read: { ok: true, state: { dictionaries: [{ id: "a", title: "Jitendex", enabled: true }] } },
  };
  const send = async (type, fields = {}, target = "offscreen") => {
    sent.push({ type, target });
    if (fail.has(type)) throw new Error("the extension's service worker did not reply");
    return replies[type];
  };
  return { chrome, window, send, sent };
}

test("the debug report carries version, engine, dictionaries and settings without reader content or credentials", async () => {
  const { chrome, window, send, sent } = host();
  const report = await collectDebugInfo({ chrome, window, send, workerTarget: "worker",
    context: { effectiveOptions: { anki: { apiKey: "hunter2" } } }, now: () => new Date("2026-10-06T10:00:00.123Z") });

  assert.equal(report.extension.version, "1.2.3");
  assert.deepEqual(report.browser.os, { os: "linux", arch: "x86-64" });
  assert.equal(report.engine.status.dictionaryCount, 2);
  assert.equal(report.engine.memory.heapBytes, 1024);
  assert.equal(report.engine.extensionMemory.bytes, 2048);
  assert.equal(report.dictionaries.state.dictionaries[0].title, "Jitendex");
  assert.deepEqual(sent.find(message => message.type === "hd_state_read"), { type: "hd_state_read", target: "worker" });

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

  const text = await debugInfoBlob(report).text();
  for (const secret of ["hunter2", "ねこ", "secretNotes"]) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.equal(debugInfoFilename(new Date(report.generatedAt)), "hachidori-debug-2026-10-06T10-00-00Z.json");
});

test("a probe that fails is recorded in place and the rest of the report survives", async () => {
  const { chrome, window, send } = host({ fail: new Set(["platform", "hd_memory"]) });
  const report = await collectDebugInfo({ chrome, window, send, workerTarget: "worker" });
  assert.deepEqual(report.browser.os, { error: "platform unavailable" });
  assert.deepEqual(report.engine.memory, { error: "the extension's service worker did not reply" });
  assert.equal(report.engine.status.ready, true);
  assert.equal(report.extension.version, "1.2.3");
});
