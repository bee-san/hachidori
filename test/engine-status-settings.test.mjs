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
const GENERATION = "/dicts/.hdw-generation-0c1f6f8e-3b5a-4d2e-9f7a-2b8c4d6e8f01";
// The engine's own load-failure records: `could not load <path> as <kind>: <native error>`.
// One title and one error look like markup, which the sidebar must show as literal text.
const FAILURES = [
  { id: "c".repeat(32), title: "NHK日本語発音アクセント新辞典",
    error: `could not load ${GENERATION}/NHK日本語発音アクセント新辞典 as pitch: unsupported pitch bank format` },
  { id: "d".repeat(32), title: '<b>大辞泉</b> & "quotes"',
    error: `could not load ${GENERATION}/<b>大辞泉</b> as term: <script>alert(1)</script>` },
  { id: "e".repeat(32), title: "Kanjium",
    error: `could not load ${GENERATION}/Kanjium as pitch: not enough memory to load the dictionary` },
];

// Settings as a user opens it on Dictionaries with two healthy installed dictionaries.
function fixture(t, { failedDictionaries = [] } = {}) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: "https://settings.example/#dictionaries" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.IS_FIREFOX = false;
  window.HOST_BROWSER = "chrome";
  window.OVERLAY_MODE = false;
  window.HOST_CAPABILITIES = {
    browserShortcuts: true, linkButtons: true, externalLinkHost: false, customJavaScript: true,
    localFileAccessPrompt: true, mediaCapture: true, lowMemoryMode: true,
  };
  window.MINING_CAPABILITIES = { screenshot: true, browserSpeech: true };
  window.replies = {
    hd_status: { ok: true, ready: true, loading: false, dictionaryCount: 2, failedDictionaries, generation: 1,
      storageBackend: "opfs", threaded: true },
  };
  window.chrome = {
    runtime: { sendMessage(message) {
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
    adoptOptions({ revision: 1 });
    dictionaryState = { schemaVersion: 1, revision: 2, groups: [], dictionaries: ${JSON.stringify(DICTIONARIES)} };
    dictionaries = dictionaryState.dictionaries;
    renderDictionaries();
    globalThis.pollStatus = refreshStatus;
  `));
  const el = id => window.document.getElementById(id);
  const poll = async () => { await window.pollStatus(); await settle(); };
  const entries = () => [...el("engine-status-failures").children].map(item => ({
    title: item.querySelector(".engine-status-failure-title").textContent,
    error: item.querySelector(".engine-status-failure-error").textContent,
  }));
  return { window, el, poll, entries };
}

test("several load failures render as a summary and one literal-text entry per dictionary", async t => {
  const { el, poll, entries } = fixture(t, { failedDictionaries: FAILURES });
  await poll();
  const status = el("engine-status");
  assert.equal(status.textContent, "Could not load 3 dictionaries. Re-import or remove them; the other dictionaries still work.");
  assert.equal(status.classList.contains("is-error"), true);

  const list = el("engine-status-failures");
  assert.equal(list.tagName, "UL");
  assert.equal(list.hidden, false);
  assert.equal(list.getAttribute("aria-labelledby"), "engine-status", "the list is named by the summary it details");
  assert.deepEqual(entries(), FAILURES.map(({ title, error }) => ({ title, error })));
  assert.equal(list.querySelector("b, script"), null, "markup-like titles and errors are data, not HTML");
  assert.ok(list.innerHTML.includes("&lt;b&gt;大辞泉&lt;/b&gt;"));

  const items = [...list.children];
  await poll();
  assert.deepEqual([...list.children], items, "an unchanged status poll keeps the rendered entries");
});

test("one failure keeps singular wording, and a repair clears the list", async t => {
  const { window, el, poll, entries } = fixture(t, { failedDictionaries: [FAILURES[0]] });
  await poll();
  assert.equal(el("engine-status").textContent, "Could not load 1 dictionary. Re-import or remove it; the other dictionaries still work.");
  assert.deepEqual(entries(), [{ title: FAILURES[0].title, error: FAILURES[0].error }]);

  window.replies.hd_status = { ...window.replies.hd_status, failedDictionaries: [] };
  await poll();
  assert.equal(el("engine-status").textContent, "Ready, 2 dictionaries enabled.");
  assert.equal(el("engine-status").classList.contains("is-error"), false);
  assert.equal(el("engine-status-failures").hidden, true);
  assert.equal(el("engine-status-failures").childElementCount, 0);
});

test("a status the failures do not belong to hides the list", async t => {
  const { window, el, poll } = fixture(t, { failedDictionaries: FAILURES });
  await poll();
  assert.equal(el("engine-status-failures").childElementCount, 3);

  window.replies.hd_status = new Error("Could not establish connection");
  await poll();
  assert.match(el("engine-status").textContent, /^Cannot reach the engine: /u);
  assert.equal(el("engine-status-failures").hidden, true);
});
