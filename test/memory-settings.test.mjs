// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SETTINGS_PAGE_MODULES } from "./settings-modules.mjs";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const extension = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");
const withoutModules = source => source.replace(/^import(?:[^;]+);\s*/gmu, "").replace(/^export\s+/gmu, "");
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };

const PACKAGE = (id, title, extra = {}) => ({ id, title, revision: "1", enabled: true, favorite: false, displayName: null,
  termCount: 1, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, mediaCount: 0, path: `/dicts/g/${id}`, ...extra });
const DICTIONARIES = [PACKAGE("a".repeat(32), "Jitendex"), PACKAGE("b".repeat(32), "Pixiv")];
const MEMORY = { ok: true, heapBytes: 3 * 1_073_741_824, dictionaries: [
  { id: DICTIONARIES[0].id, title: "Jitendex", path: DICTIONARIES[0].path, bytes: 512 * 1_048_576 },
  { id: DICTIONARIES[1].id, title: "Pixiv", path: DICTIONARIES[1].path, bytes: 1_500_000_000 },
] };

// Settings as a user opens it on Advanced with two installed dictionaries.
function fixture(t, { hash = "#advanced", stored = {}, threaded = true, memory = MEMORY, total = { ok: true, bytes: 3.5 * 1_073_741_824, heapBytes: 3 * 1_073_741_824 } } = {}) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: `https://settings.example/${hash}` });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  window.OVERLAY_MODE = false;
  window.HOST_CAPABILITIES = {
    browserShortcuts: true, linkButtons: true, externalLinkHost: false, customJavaScript: true,
    localFileAccessPrompt: true, lowMemoryMode: true,
  };
  window.MINING_CAPABILITIES = { screenshot: true, browserSpeech: true };
  window.replies = {
    hd_memory: memory,
    hd_memory_total: total,
    hd_status: { ok: true, ready: true, loading: false, dictionaryCount: 2, failedDictionaries: [], generation: 1,
      storageBackend: "opfs", threaded },
  };
  window.chrome = {
    runtime: { sendMessage(message) {
      requests.push(structuredClone(message));
      const reply = window.replies[message.type];
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve(reply ?? { ok: true, state: "stopped" });
    } },
    storage: { onChanged: { addListener() {} }, local: { get: () => Promise.resolve({}) } },
  };
  window.eval(extension("reader-options.js"));
  window.eval(extension("dictionary-group-state.js"));
  for (const [file, exports] of [
    ["recommended-install-client.js", ["createRecommendedInstallClient"]],
    ["settings-dom.js", ["applyPageTheme", "setStatusOutput"]],
    ["settings-search.js", ["createSettingsSearch"]],
    ["experimental-settings.js", ["createExperimentalSettings"]],
    ["theme-store.js", ["createThemeStore"]],
    ["activation-settings.js", ["createActivationSettings"]],
    ["dictionary-progress.js", ["formatBytes"]],
    ["memory-settings.js", ["createMemorySettings"]],
    ["dictionary-name-drafts.js", ["createDictionaryNameDrafts"]],
    ["dictionary-groups.js", ["createDictionaryGroupController"]],
    ["error-text.js", ["describeErrorOrJson"]],
    ["custom-dictionary.js", ["CUSTOM_DICTIONARY_ID", "CUSTOM_DICTIONARY_TITLE"]],
    ["recommended-dictionaries.js", ["RECOMMENDED_DICTIONARIES"]],
    ["managed-dictionary-source.js", ["effectiveDictionarySchedule", "managedDictionarySource",
      "nextDictionaryUpdateCheck", "normaliseUpdateSettings", "recommendedDictionaryInstalled"]],
  ]) {
    window.eval(`{ ${withoutModules(extension(file))}\nObject.assign(globalThis, {${exports.join(",")}}); }`);
  }
  const source = withoutModules(SETTINGS_PAGE_MODULES.map(extension).join("\n"));
  assert.ok(source.endsWith("await start();\n"));
  window.eval(source.replace(/await start\(\);\s*$/u, `
    configureBrowserUi();
    renderMiningCapabilityHelp();
    attachSettingsNavigation();
    attachHandlers();
    adoptOptions({ revision: 1, ...${JSON.stringify(stored)} });
    dictionaryState = { schemaVersion: 1, revision: 2, groups: [], dictionaries: ${JSON.stringify(DICTIONARIES)} };
    dictionaries = dictionaryState.dictionaries;
    renderDictionaries();
    globalThis.readOptions = () => options;
    globalThis.readPending = () => pendingOptions;
    globalThis.pollStatus = refreshStatus;
    globalThis.rerenderDictionaries = () => renderDictionaries();
    globalThis.showSection = (id) => { location.hash = id; showSettingsSection(); };
  `));
  const el = id => window.document.getElementById(id);
  const rowMemory = id => window.document.querySelector(`.dict-row[data-dictionary-id="${id}"] .dict-memory`).textContent;
  const openDetails = id => window.document.querySelector(`.dict-row[data-dictionary-id="${id}"] .dict-details-toggle`).click();
  return { window, el, requests, rowMemory, openDetails };
}

test("Advanced shows the engine total and each Library row shows its share", async t => {
  const { el, requests, rowMemory } = fixture(t);
  await settle();
  assert.equal(el("memory-total").textContent, "Engine memory: 3.00 GB across 2 dictionaries");
  assert.equal(rowMemory(DICTIONARIES[0].id), "In memory: \u2248 512.0 MB");
  assert.equal(rowMemory(DICTIONARIES[1].id), "In memory: \u2248 1.40 GB");
  assert.equal(requests.filter(message => message.type === "hd_memory").length, 1, "one read for the Advanced visit, not a poll");
});

test("Advanced shows the extension total beside the engine line, and a dash where it cannot be measured", async t => {
  const measured = fixture(t);
  await settle();
  assert.equal(measured.el("memory-total").textContent, "Engine memory: 3.00 GB across 2 dictionaries");
  assert.equal(measured.el("memory-extension-total").textContent, "Extension total: 3.50 GB (512.0 MB outside the engine heap)");
  assert.equal(measured.requests.filter(message => message.type === "hd_memory_total").length, 1);

  // Firefox and hosts without cross-origin isolation have no measurement.
  const unsupported = fixture(t, { total: { ok: true, bytes: null, heapBytes: null } });
  await settle();
  assert.equal(unsupported.el("memory-total").textContent, "Engine memory: 3.00 GB across 2 dictionaries");
  assert.equal(unsupported.el("memory-extension-total").textContent, "Extension total: \u2014");

  const failed = fixture(t, { total: new Error("Could not establish connection") });
  await settle();
  assert.equal(failed.el("memory-extension-total").textContent, "Extension total: \u2014");
});

test("a slow extension measurement does not hold the engine line", async t => {
  let release;
  const { el } = fixture(t, { total: new Promise(resolve => { release = resolve; }) });
  await settle();
  assert.equal(el("memory-total").textContent, "Engine memory: 3.00 GB across 2 dictionaries");
  assert.equal(el("memory-extension-total").textContent, "Extension total: \u2014");
  release({ ok: true, bytes: 2 * 1_073_741_824 });
  await settle();
  assert.equal(el("memory-extension-total").textContent, "Extension total: 2.00 GB");
});

test("a row whose entries are read from disk says so", async t => {
  const paged = { ...MEMORY, pageCacheBytes: 4 * 1_048_576, dictionaries: [
    { ...MEMORY.dictionaries[0], bytes: 13 * 1_048_576, paged: true },
    { ...MEMORY.dictionaries[1], paged: false },
  ] };
  const { rowMemory } = fixture(t, { memory: paged });
  await settle();
  assert.equal(rowMemory(DICTIONARIES[0].id), "In memory: \u2248 13.0 MB (entries read from disk)");
  assert.equal(rowMemory(DICTIONARIES[1].id), "In memory: \u2248 1.40 GB");
});

test("the Library asks only when a reader opens a row's Details", async t => {
  const { window, requests, rowMemory, openDetails } = fixture(t, { hash: "#dictionaries" });
  await settle();
  const reads = () => requests.filter(message => message.type === "hd_memory").length;
  assert.equal(reads(), 0, "rendering the Library requests nothing");
  const totals = () => requests.filter(message => message.type === "hd_memory_total").length;
  assert.equal(rowMemory(DICTIONARIES[0].id), "In memory: \u2014");
  window.rerenderDictionaries();
  await window.pollStatus();
  await settle();
  assert.equal(reads(), 0, "rerenders and status polls outside Advanced request nothing");
  openDetails(DICTIONARIES[0].id);
  await settle();
  assert.equal(reads(), 1);
  assert.equal(rowMemory(DICTIONARIES[0].id), "In memory: \u2248 512.0 MB");
  window.rerenderDictionaries();
  assert.equal(rowMemory(DICTIONARIES[1].id), "In memory: \u2248 1.40 GB", "rebuilt rows show the last reading at once");
  assert.equal(reads(), 1, "a rebuilt open row does not ask again");
  assert.equal(totals(), 0, "a row's Details does not measure the whole extension");
});

test("a busy or unreachable engine renders a dash rather than an error", async t => {
  const busy = fixture(t, { memory: { ok: false, error: "the dictionary engine is busy mutating", errorCode: "engine-mutating" } });
  await settle();
  assert.equal(busy.el("memory-total").textContent, "Engine memory: \u2014");
  assert.equal(busy.rowMemory(DICTIONARIES[0].id), "In memory: \u2014");

  const unreachable = fixture(t, { memory: new Error("Could not establish connection") });
  await settle();
  assert.equal(unreachable.el("memory-total").textContent, "Engine memory: \u2014");
});

test("a new engine generation refreshes the readout while Advanced is shown", async t => {
  const { window, el, requests, rowMemory } = fixture(t);
  await settle();
  const reads = () => requests.filter(message => message.type === "hd_memory").length;
  const before = reads();
  window.replies.hd_memory = { ...MEMORY, heapBytes: 1_073_741_824, dictionaries: [MEMORY.dictionaries[0]] };
  window.replies.hd_status = { ...window.replies.hd_status, generation: 2 };
  await window.pollStatus();
  await settle();
  assert.equal(reads(), before + 1);
  assert.equal(el("memory-total").textContent, "Engine memory: 1.00 GB across 1 dictionary");
  assert.equal(rowMemory(DICTIONARIES[1].id), "In memory: \u2014", "a package the engine no longer holds shows no share");

  await window.pollStatus();
  await settle();
  assert.equal(reads(), before + 1, "an unchanged generation does not read again");

  window.showSection("dictionaries");
  window.replies.hd_status = { ...window.replies.hd_status, generation: 3 };
  await window.pollStatus();
  await settle();
  assert.equal(reads(), before + 1, "a generation change outside Advanced does not read");
});

test("the low memory switch saves through the ordinary options queue and reflects the stored value", async t => {
  const { window, el } = fixture(t);
  await settle();
  const toggle = el("opt-low-memory-mode");
  assert.equal(el("low-memory-mode").hidden, false);
  assert.equal(el("low-memory-mode-unavailable").hidden, true);
  assert.equal(toggle.checked, false);
  toggle.click();
  await tick();
  assert.equal(window.readOptions().lowMemoryMode, true);
  assert.equal(JSON.stringify(window.readPending()), JSON.stringify({ lowMemoryMode: true }));

  const stored = fixture(t, { stored: { lowMemoryMode: true } });
  await settle();
  assert.equal(stored.el("opt-low-memory-mode").checked, true);
});

test("the switch is unavailable with the single-thread engine while the readout stays", async t => {
  const local = fixture(t, { threaded: false });
  await local.window.pollStatus();
  await settle();
  assert.equal(local.el("low-memory-mode").hidden, true);
  assert.equal(local.el("low-memory-mode-unavailable").hidden, false);
  assert.equal(local.el("memory-total").textContent, "Engine memory: 3.00 GB across 2 dictionaries");
});


test("entry storage saves independently and low memory temporarily overrides its control", async t => {
  const { window, el } = fixture(t);
  await settle();
  const select = el("opt-dictionary-entry-storage");
  assert.equal(select.value, "auto");
  assert.equal(select.disabled, false);
  select.value = "resident";
  select.dispatchEvent(new window.Event("change"));
  await tick();
  assert.equal(window.readOptions().dictionaryEntryStorage, "resident");
  assert.equal(window.readOptions().lowMemoryMode, false);
  assert.equal(JSON.stringify(window.readPending()), JSON.stringify({ dictionaryEntryStorage: "resident" }));
  el("opt-low-memory-mode").click();
  await tick();
  assert.equal(select.disabled, true);
  assert.equal(select.value, "resident", "the explicit resident preference is preserved");
  el("opt-low-memory-mode").click();
  await tick();
  assert.equal(select.disabled, false);

  const local = fixture(t, { threaded: false });
  await local.window.pollStatus();
  await settle();
  assert.equal(local.el("dictionary-entry-storage").hidden, true);
});


test("Use less ram by default saves independently and yields to explicit hash storage and Low memory mode", async t => {
  const { window, el } = fixture(t);
  await settle();
  const toggle = el("opt-use-less-ram-by-default");
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  toggle.click();
  await tick();
  assert.equal(window.readOptions().useLessRamByDefault, true);
  assert.equal(window.readOptions().lowMemoryMode, false);
  assert.equal(JSON.stringify(window.readPending()), JSON.stringify({ useLessRamByDefault: true }));
  const hashes = el("opt-dictionary-index-storage");
  hashes.value = "resident";
  hashes.dispatchEvent(new window.Event("change"));
  assert.equal(toggle.disabled, true);
  hashes.value = "auto";
  hashes.dispatchEvent(new window.Event("change"));
  assert.equal(toggle.disabled, false);
  el("opt-low-memory-mode").click();
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.checked, true, "Low memory mode preserves the preference");
  const local = fixture(t, { threaded: false });
  await local.window.pollStatus();
  assert.equal(local.el("use-less-ram-by-default").hidden, true);
});

test("memory separates the index budget, shared cache and entry-paging label", async t => {
  const memory = { ok: true, heapBytes: 64 * 1048576, hashIndexStorage: "budget", dictionaryIndexStorage: "auto",
    residentHashBudgetBytes: 32 * 1048576, pageCacheBytes: 2 * 1048576,
    dictionaries: DICTIONARIES.map((item, index) => ({ id: item.id, bytes: 1048576, paged: true,
      hashIndexStorage: index ? "resident" : "paged", residentHashBytes: index ? 1048576 : 0 })) };
  const { el, rowMemory } = fixture(t, { memory });
  await settle();
  assert.match(el("memory-indexes").textContent, /1.0 MB resident.*32.0 MB budget; 1 read from disk.*requested: Automatic.*2.0 MB/);
  assert.match(rowMemory(DICTIONARIES[0].id), /entries and hash index read from disk/);
  assert.match(rowMemory(DICTIONARIES[1].id), /entries read from disk/);
});
