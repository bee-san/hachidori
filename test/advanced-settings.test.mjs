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
// Values from the page's realm, compared as data.
const plain = value => JSON.parse(JSON.stringify(value));

// Settings as a user opens it: navigation attached, then stored options adopted.
function fixture(t, { hash = "#advanced", stored = {}, overlayMode = false } = {}) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: `https://settings.example/${hash}` });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.OVERLAY_MODE = overlayMode;
  window.HOST_CAPABILITIES = {
    browserShortcuts: !overlayMode, linkButtons: true, externalLinkHost: overlayMode, customJavaScript: true,
    localFileAccessPrompt: !overlayMode, lowMemoryMode: true,
  };
  window.MINING_CAPABILITIES = { screenshot: !overlayMode, browserSpeech: !overlayMode };
  window.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ ok: true, state: "stopped" }) },
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
  ]) {
    window.eval(`{ ${withoutModules(extension(file))}\nObject.assign(globalThis, {${exports.join(",")}}); }`);
  }
  const source = withoutModules(extension("settings.js"));
  assert.ok(source.endsWith("await start();\n"));
  window.eval(source.replace(/await start\(\);\s*$/u, `
    configureBrowserUi();
    renderMiningCapabilityHelp();
    attachSettingsNavigation();
    attachHandlers();
    adoptOptions({ revision: 1, ...${JSON.stringify(stored)} });
    globalThis.readOptions = () => options;
    globalThis.readPending = () => pendingOptions;
    globalThis.readActiveSection = () => activeSection;
  `));
  const el = id => window.document.getElementById(id);
  const visible = () => [...window.document.querySelectorAll("main > section")].filter(node => !node.hidden).map(node => node.id);
  return { window, el, visible };
}

test("Advanced keeps dictionary experiments and discards removed media settings", async t => {
  const { window, el, visible } = fixture(t, {
    hash: "#media", stored: { experimental: { mediaMining: true }, mediaCapture: { enabled: true } },
  });
  assert.deepEqual(visible(), ["dictionaries"]);
  assert.equal(el("media"), null);
  assert.equal(el("opt-experimental-mediaMining"), null);
  assert.equal(window.document.querySelector('.settings-nav a[href="#media"]'), null);
  assert.equal(Object.hasOwn(window.readOptions(), "mediaCapture"), false);
  assert.equal(Object.hasOwn(window.readOptions().experimental, "mediaMining"), false);
  window.location.hash = "#advanced";
  window.dispatchEvent(new window.Event("hashchange"));
  assert.deepEqual(visible(), ["advanced"]);
  assert.equal(el("experimental-empty").hidden, true);
});

test("the import picker takes Yomitan ZIPs and MDX dictionaries without a switch", t => {
  const { el } = fixture(t);
  assert.equal(el("import-file").accept, ".zip,application/zip,.mdx,.mdd");
  assert.equal(el("import-file-label").textContent, "Choose dictionary files");
  assert.match(el("import-drop-hint").textContent, /MDX dictionary with its MDD files/u);
  assert.equal(el("opt-experimental-mdxImport"), null);
});

test("Word highlighting is a Reading section that only its experimental switch reveals, search included", t => {
  const { window, el, visible } = fixture(t, { hash: "#word-highlighting", stored: { wordHighlightKnown: true } });
  const railItem = () => window.document.querySelector('.settings-nav a[href="#word-highlighting"]').parentElement;
  const pickerOption = () => el("settings-section").querySelector('option[value="word-highlighting"]');
  const search = words => {
    el("settings-search").value = words;
    el("settings-search").dispatchEvent(new window.Event("input"));
    const found = [...el("settings-search-matches").querySelectorAll("strong")].map(node => node.textContent);
    el("settings-search").value = "";
    el("settings-search").dispatchEvent(new window.Event("input"));
    return found;
  };
  // Off: the section, its rail link, its picker option and its settings in search are all hidden.
  assert.deepEqual(visible(), ["advanced"]);
  assert.equal(railItem().hidden, true);
  assert.equal(pickerOption().hidden, true);
  assert.deepEqual(search("mark unknown words"), []);

  el("opt-experimental-wordHighlighting").click();
  assert.deepEqual(visible(), ["word-highlighting"], "the requested section opens once its switch is on");
  assert.equal(railItem().hidden, false);
  assert.equal(pickerOption().hidden, false);
  assert.deepEqual(search("mark unknown words"), ["Mark unknown words"]);
  assert.equal(el("opt-word-highlight").checked, false, "highlighting itself starts off");
  assert.equal(el("opt-word-highlight-unknown").checked, true);
  assert.equal(el("opt-word-highlight-known").checked, true);
  assert.equal(el("opt-word-highlight-style").value, "underline");
  el("opt-word-highlight").click();
  el("opt-word-highlight-style").value = "background";
  el("opt-word-highlight-style").dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.deepEqual(plain(window.readPending()), { experimental: { ...plain(window.readOptions().experimental), wordHighlighting: true },
    wordHighlightEnabled: true, wordHighlightStyle: "background" });
});

test("turning Word highlighting's experimental switch off stops the marks in the same save and keeps its settings", t => {
  const { window, el, visible } = fixture(t, { hash: "#word-highlighting", stored: {
    experimental: { wordHighlighting: true }, wordHighlightEnabled: true, wordHighlightKnown: true, wordHighlightStyle: "color" } });
  assert.deepEqual(visible(), ["word-highlighting"]);
  assert.equal(el("opt-word-highlight").checked, true);
  el("opt-experimental-wordHighlighting").click();
  assert.deepEqual(visible(), ["advanced"]);
  assert.deepEqual(plain(window.readPending()), {
    experimental: { ...plain(window.readOptions().experimental), wordHighlighting: false }, wordHighlightEnabled: false });
  assert.equal(window.readOptions().wordHighlightKnown, true);
  assert.equal(window.readOptions().wordHighlightStyle, "color");
});
