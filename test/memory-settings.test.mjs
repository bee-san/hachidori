// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

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
function fixture(t, { hash = "#advanced", stored = {}, firefox = false, threaded = true, memory = MEMORY } = {}) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: `https://settings.example/${hash}` });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  window.IS_FIREFOX = firefox;
  window.HOST_BROWSER = firefox ? "firefox" : "chrome";
  window.OVERLAY_MODE = false;
  window.HOST_CAPABILITIES = {
    browserShortcuts: true, linkButtons: true, externalLinkHost: false, customJavaScript: !firefox,
    localFileAccessPrompt: true, mediaCapture: !firefox, lowMemoryMode: !firefox,
  };
  window.MINING_CAPABILITIES = { screenshot: true, browserSpeech: !firefox };
  window.replies = {
    hd_memory: memory,
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
    ["dictionary-progress.js", ["formatBytes"]],
    ["memory-settings.js", ["createMemorySettings"]],
    ["dictionary-name-drafts.js", ["createDictionaryNameDrafts"]],
    ["dictionary-groups.js", ["createDictionaryGroupController"]],
    ["custom-dictionary.js", ["CUSTOM_DICTIONARY_ID", "CUSTOM_DICTIONARY_TITLE"]],
    ["recommended-dictionaries.js", ["RECOMMENDED_DICTIONARIES"]],
    ["managed-dictionary-source.js", ["effectiveDictionarySchedule", "managedDictionarySource",
      "nextDictionaryUpdateCheck", "normaliseUpdateSettings", "recommendedDictionaryInstalled"]],
  ]) {
    window.eval(`{ ${withoutModules(extension(file))}\nObject.assign(globalThis, {${exports.join(",")}}); }`);
  }
  const source = withoutModules(extension("settings.js"));
  assert.ok(source.endsWith("start();\n"));
  window.eval(source.replace(/start\(\);\s*$/u, `
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

test("the Library asks only when a reader opens a row's Details", async t => {
  const { window, requests, rowMemory, openDetails } = fixture(t, { hash: "#dictionaries" });
  await settle();
  const reads = () => requests.filter(message => message.type === "hd_memory").length;
  assert.equal(reads(), 0, "rendering the Library requests nothing");
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

test("the switch is unavailable on Firefox and with the single-thread engine, while the readout stays", async t => {
  const firefox = fixture(t, { firefox: true });
  await settle();
  assert.equal(firefox.el("low-memory-mode").hidden, true);
  assert.equal(firefox.el("opt-low-memory-mode-help").hidden, true);
  assert.equal(firefox.el("low-memory-mode-unavailable").hidden, false);
  assert.equal(firefox.el("memory-total").textContent, "Engine memory: 3.00 GB across 2 dictionaries");

  const local = fixture(t, { threaded: false });
  await local.window.pollStatus();
  await settle();
  assert.equal(local.el("low-memory-mode").hidden, true);
  assert.equal(local.el("low-memory-mode-unavailable").hidden, false);
  assert.equal(local.el("memory-total").textContent, "Engine memory: 3.00 GB across 2 dictionaries");
});
