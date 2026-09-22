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
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

const PACKAGE = (id, title, extra = {}) => ({ id, title, revision: "1", enabled: true, favorite: false, displayName: null,
  termCount: 1, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, mediaCount: 0, path: `/dicts/g/${id}`, ...extra });
const KANJIDIC = PACKAGE("a".repeat(32), "KANJIDIC", { termCount: 0, kanjiCount: 1 });
const BEES = PACKAGE("b".repeat(32), "Bee's Kanji");
const GROUP = { id: "kanji-group", name: "Kanji", dictionaryIds: [KANJIDIC.id, BEES.id] };
const GROUP_VALUE = JSON.stringify({ kind: "tabGroup", id: GROUP.id });

// Settings as a user opens it on Reading with two dictionaries and one group.
function fixture(t, kanjiClickDictionary) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: "https://settings.example/#lookup" });
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
  const writes = [];
  window.chrome = {
    runtime: { sendMessage(message) {
      if (message.type === "hd_options_write") {
        writes.push(message.options);
        return Promise.resolve({ ok: true, options: { ...message.options, revision: message.baseRevision + 1 } });
      }
      return Promise.resolve({ ok: true, ready: true, loading: false, dictionaryCount: 2, failedDictionaries: [] });
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
    adoptOptions({ revision: 1, kanjiClickDictionary: ${JSON.stringify(kanjiClickDictionary)} });
    globalThis.adoptState = state => { dictionaryState = state; renderDictionaryState(); };
    globalThis.currentOptions = () => options;
  `));
  const state = (revision, groups) => ({ schemaVersion: 1, revision, groups, dictionaries: [KANJIDIC, BEES] });
  window.adoptState(state(2, [GROUP]));
  const select = window.document.getElementById("opt-kanji-dictionary");
  const choices = () => [...select.children].map(node => node.tagName === "OPTGROUP"
    ? [node.label, [...node.children].map(option => [option.textContent, option.value])]
    : [node.textContent, node.value]);
  return { window, select, choices, state, writes };
}

test("the chooser lists groups after the dictionaries and saves a group by its stable ID", async t => {
  const { window, select, choices, writes } = fixture(t, "");
  assert.deepEqual(choices(), [
    ["Automatic — use every kanji dictionary", ""],
    ["Kanji dictionaries", [["KANJIDIC", JSON.stringify({ title: "KANJIDIC", kind: "kanji" })]]],
    ["Term dictionaries — requires a matching single-kanji entry", [["Bee's Kanji", JSON.stringify({ title: "Bee's Kanji", kind: "term" })]]],
    ["Groups", [["Kanji", GROUP_VALUE]]],
  ]);
  select.value = GROUP_VALUE;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(JSON.stringify(writes), JSON.stringify([{ kanjiClickDictionary: { kind: "tabGroup", id: GROUP.id } }]));
  assert.equal(select.value, GROUP_VALUE);
});

test("a saved group keeps a focused chooser through rerenders and resets when the group is removed", async t => {
  const { window, select, choices, state } = fixture(t, { kind: "tabGroup", id: GROUP.id });
  assert.equal(select.value, GROUP_VALUE);
  const groupOption = select.querySelector(`option[value='${GROUP_VALUE}']`);
  select.focus();
  window.adoptState(state(3, [{ ...GROUP, name: "Kanji sources" }]));
  assert.equal(select.querySelector(`option[value='${GROUP_VALUE}']`), groupOption, "a focused chooser is not rebuilt");
  assert.equal(select.value, GROUP_VALUE);
  select.blur();
  select.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  assert.notEqual(window.document.activeElement, select);
  assert.deepEqual(choices().at(-1), ["Groups", [["Kanji sources", GROUP_VALUE]]], "focusout applies the newer label");
  assert.equal(select.value, GROUP_VALUE);
  window.adoptState(state(4, []));
  assert.equal(window.currentOptions().kanjiClickDictionary, "", "a removed group resets the option");
  assert.equal(select.value, "");
  assert.equal(select.querySelector("optgroup[label=Groups]"), null, "no groups, no group choices");
});
