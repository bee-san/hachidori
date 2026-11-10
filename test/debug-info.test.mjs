// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "../extension/reader-options.js";
import { collectDebugInfo, debugInfoBlob, debugInfoFilename, listOpfs, summariseStorage } from "../extension/debug-info.js";
import { REDACTED } from "../extension/debug-log.js";

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

function host({ fail = new Set(), stored = STORED } = {}) {
  const sent = [];
  let storageReads = 0;
  const reject = name => Promise.reject(new Error(`${name} unavailable`));
  const chrome = {
    runtime: {
      id: "extension-id",
      getURL: path => `chrome-extension://extension-id/${path}`,
      getManifest: () => ({ name: "Hachidori", version: "1.2.3", manifest_version: 3 }),
      getPlatformInfo: () => fail.has("platform") ? reject("platform") : Promise.resolve({ os: "linux", arch: "x86-64" }),
    },
    permissions: { getAll: () => Promise.resolve({ permissions: ["storage"], origins: ["<all_urls>"] }) },
    management: { getSelf: () => Promise.resolve({ installType: "development", enabled: true }) },
    extension: { isAllowedFileSchemeAccess: () => Promise.resolve(false), isAllowedIncognitoAccess: () => Promise.resolve(false) },
    alarms: { getAll: () => Promise.resolve([{ name: "hachidori-automatic-backup", scheduledTime: Date.UTC(2026, 9, 7) }]) },
    commands: { getAll: () => Promise.resolve([{ name: "toggleTextScanning", shortcut: "Alt+Delete" }]) },
    storage: { local: { get: () => {
      storageReads += 1;
      return fail.has("storage") ? reject("storage") : Promise.resolve(structuredClone(stored));
    }, getBytesInUse: () => Promise.resolve(4096) } },
  };
  const window = {
    navigator: { userAgent: "Test/1", languages: ["ja-JP", "en"], hardwareConcurrency: 8,
      storage: { estimate: () => Promise.resolve({ usage: 10, quota: 100 }), persisted: () => Promise.resolve(true) } },
    location: { href: "chrome-extension://extension-id/settings.html#advanced" },
    crossOriginIsolated: true, SharedArrayBuffer, WebAssembly,
    fetch: async url => {
      const path = new URL(url).pathname.slice(1);
      if (fail.has(path)) throw new Error(`${path} unavailable`);
      return { ok: true, json: async () => JSON.parse(await readFile(new URL(`../extension/${path}`, import.meta.url), "utf8")) };
    },
  };
  const replies = {
    hd_status: { ok: true, ready: true, dictionaryCount: 2, storageBackend: "opfs", threaded: true },
    hd_memory: { ok: true, heapBytes: 1024, dictionaries: [] },
    hd_memory_total: { ok: true, bytes: 2048 },
    hd_debug_log: { ok: true, logs: [{ context: "offscreen", session: "o1", entries: [{ at: "2026-10-06T09:00:00.000Z",
      session: "o1", n: 1, context: "offscreen", version: "1.2.3", level: "warn", message: "hoshidicts: direct OPFS is unavailable" }] }] },
    hd_sharing_status: { ok: true, sharing: { enabled: false } },
    hd_anki_status: { ok: true, available: false, error: "Choose an Anki note type in Settings." },
    hd_state_read: { ok: true, state: { dictionaries: [{ id: "a", title: "Jitendex", enabled: true }] } },
  };
  const send = async (type, fields, target = "offscreen") => {
    sent.push({ type, target });
    if (fail.has(type)) throw new Error("the extension's service worker did not reply");
    if (type === "hd_debug_log" && target === "worker") return { ok: true, log: { context: "service-worker", session: "w1", entries: [] } };
    if (type === "hd_memory_total" && fail.has("hang")) return new Promise(() => {});
    return replies[type];
  };
  return { chrome, window, send, sent, storageReads: () => storageReads };
}

test("configuration includes every current default, migrated userscripts and bundled theme and language metadata", async () => {
  const stored = structuredClone(STORED);
  stored.options.customPopupJavascript = "const popup = document.querySelector('hachidori-host');";
  stored.futureConfiguration = { enabled: true };
  const env = host({ stored });
  const report = await collectDebugInfo({ ...env, targets: TARGETS });
  const { DEFAULT_OPTIONS, EXPERIMENTAL_FEATURES } = globalThis.HDReaderOptions;
  const configuration = report.configuration;
  assert.equal(configuration.activeProfileId, "ja");
  assert.equal(configuration.optionsRevision, 3);
  assert.deepEqual(configuration.experimentalFeatures, EXPERIMENTAL_FEATURES);
  const profile = configuration.profiles[0];
  assert.deepEqual(Object.keys(profile.effectiveOptions).sort(), Object.keys(DEFAULT_OPTIONS).sort());
  assert.equal(profile.effectiveOptions.userScripts[0].name, "Custom JavaScript");
  assert.equal(profile.effectiveOptions.userScripts[0].javascript, stored.options.customPopupJavascript);
  assert.deepEqual(profile.theme, { selected: "default", renderer: "default", variant: "auto" });
  assert.ok(configuration.languages.packs.some(pack => pack.code === "ja" && pack.name === "Japanese"));
  assert.ok(report.themes.catalogue.themes.some(theme => theme.slug === "crystal"));
  assert.deepEqual(report.themes.palettes, globalThis.HDReaderOptions.POPUP_THEME_GROUPS);
  assert.deepEqual(report.themes.variants, globalThis.HDReaderOptions.POPUP_THEME_VARIANTS);
  assert.match(report.themes.source.revision, /^[a-f\d]{40}$/u);
  assert.deepEqual(report.storage.local.keys.futureConfiguration.value, { enabled: true });
  assert.equal(env.storageReads(), 1, "configuration and storage use the same snapshot");
});

test("each language keeps its stored and effective settings, selected theme, scripts and pack defaults", async () => {
  const stored = structuredClone(STORED);
  stored.options = { revision: 7, experimental: { multipleLanguages: true },
    anki: { apiKey: "profile-key" }, customPopupCss: ".custom { color: red; }",
    userScripts: [{ id: "layout", name: "Layout", enabled: false, javascript: "const label = '猫';",
      css: ".word { display: block; }", store: { slug: "layout", version: "1.2.0" } }],
    profiles: [
      { id: "ja", language: "ja", settings: { popupTheme: "crystal", popupThemeVariant: "blue" }, packSettings: {} },
      { id: "ar", language: "ar", settings: { showPitchAccentColors: true, maxResults: 8 }, packSettings: {} },
      { id: "zz", language: "zz", settings: {}, packSettings: { preserved: true } },
    ] };
  stored.languageSelection = { revision: 2, activeProfileId: "ar", autoSwitch: true };
  const env = host({ stored });
  const registration = { id: "layout", matches: ["<all_urls>"], allFrames: true, matchOriginAsFallback: true,
    runAt: "document_idle", world: "USER_SCRIPT", js: [{ file: "custom-javascript-bridge.js" }, { code: "const apiKey = 'script-key';" }] };
  env.chrome.userScripts = { getScripts: async () => [registration] };
  const report = await collectDebugInfo({ ...env, targets: TARGETS });
  const config = report.configuration;
  assert.equal(config.activeProfileId, "ar");
  assert.deepEqual(config.languageSelection, stored.languageSelection);
  const [ja, ar, missing] = config.profiles;
  assert.deepEqual(ja.theme, { selected: "crystal", renderer: "crystal", variant: "blue" });
  assert.equal(ar.packAvailable, true);
  assert.equal(ar.settings.showPitchAccentColors, true);
  assert.equal(ar.effectiveOptions.showPitchAccentColors, false, "capability masking is visible beside the stored setting");
  assert.equal(ar.effectiveOptions.maxResults, 8);
  assert.deepEqual(ar.effectivePackSettings, Object.fromEntries(globalThis.HDLanguages.get("ar").settings
    .map(setting => [setting.id, setting.default])));
  assert.equal(missing.packAvailable, false);
  assert.deepEqual(missing.packSettings, { preserved: true });
  assert.equal(ja.effectiveOptions.anki.apiKey, REDACTED);
  assert.deepEqual(ar.effectiveOptions.userScripts, stored.options.userScripts);
  assert.equal(ar.effectiveOptions.customPopupCss, stored.options.customPopupCss);
  const registered = report.extension.userScripts.scripts[0];
  assert.equal(registered.matchOriginAsFallback, true);
  assert.equal(registered.js[0].file, "custom-javascript-bridge.js");
  assert.ok(registered.js[1].code.includes(REDACTED));
  assert.ok(!JSON.stringify(report).includes("script-key"));
  assert.equal(stored.options.anki.apiKey, "profile-key", "export does not change saved configuration");
});

test("every language's reader content is summarized while custom code stays complete with credentials redacted", () => {
  const stored = structuredClone(STORED);
  stored.customDictionarySource.languages = { en: { revision: 2, text: "private-entry,,private-definition" } };
  stored.wordStatusOverrides.languages = { en: { known: ["private-known"], ignored: ["private-ignored"] } };
  stored.options.userScripts = [{ javascript: `const token = 'embedded-key';\nconst data = '${"x".repeat(20_000)}';\nconst label = '猫';` }];
  stored.ankiDuplicateIndex = { snapshots: [{ sourceKey: "en", rows: [["private-anki-note", true, [1]]] }] };
  const summary = summariseStorage(stored);
  const source = summary.keys.customDictionarySource.value.languages.en;
  assert.deepEqual(source.text, { omitted: true, characters: 33, lines: 1 });
  assert.deepEqual(summary.keys.wordStatusOverrides.value.languages.en,
    { known: { omitted: true, count: 1 }, ignored: { omitted: true, count: 1 } });
  const code = summary.keys.options.value.userScripts[0].javascript;
  assert.ok(code.includes("x".repeat(20_000)) && code.endsWith("const label = '猫';"));
  assert.ok(code.includes(REDACTED));
  for (const secret of ["private-entry", "private-definition", "private-known", "private-ignored", "private-anki-note", "embedded-key"]) {
    assert.ok(!JSON.stringify(summary).includes(secret), `${secret} leaked`);
  }
});

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
  assert.deepEqual(report.debugLog.entries.map(entry => entry.message), ["hoshidicts: direct OPFS is unavailable"]);
  assert.deepEqual(report.debugLog.contexts.map(({ probe, context }) => [probe, context]),
    [["serviceWorker", "service-worker"], ["engine", "offscreen"], ["settings", null]]);
  assert.deepEqual(report.debugLog.sessions.map(({ session, context, live }) => [session, context, live]), [["o1", "offscreen", true]]);
  assert.ok(report.debugLog.stored.error, "a host without IndexedDB reports the ring as unreadable, not fatal");
  assert.equal(report.schemaVersion, 2);
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

test("configuration, theme and storage probe failures leave the other diagnostics available", async () => {
  const env = host({ fail: new Set(["storage", "vendor/themes/index.json"]) });
  const report = await collectDebugInfo({ ...env, targets: TARGETS });
  assert.deepEqual(report.configuration, { error: "storage unavailable" });
  assert.deepEqual(report.storage.local, { error: "storage unavailable" });
  assert.deepEqual(report.themes.catalogue, { error: "vendor/themes/index.json unavailable" });
  assert.match(report.themes.source.revision, /^[a-f\d]{40}$/u);
  assert.equal(report.engine.status.ready, true);
  assert.equal(env.storageReads(), 1);
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
