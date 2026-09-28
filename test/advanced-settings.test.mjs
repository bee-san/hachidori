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
    ["dictionary-progress.js", ["formatBytes"]],
    ["memory-settings.js", ["createMemorySettings"]],
    ["dictionary-name-drafts.js", ["createDictionaryNameDrafts"]],
    ["dictionary-groups.js", ["createDictionaryGroupController"]],
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

test("the MDX dictionaries switch widens the import picker to .mdx and .mdd files", async t => {
  const { window, el } = fixture(t);
  const picker = el("import-file");
  assert.equal(picker.accept, ".zip,application/zip");
  assert.equal(el("import-file-label").textContent, "Choose ZIP files");
  assert.match(el("import-drop-hint").textContent, /^Or drag and drop Yomitan ZIP files here\.$/u);

  el("opt-experimental-mdxImport").click();
  await tick();
  assert.equal(window.readOptions().experimental.mdxImport, true);
  assert.equal(picker.accept, ".zip,application/zip,.mdx,.mdd");
  assert.equal(el("import-file-label").textContent, "Choose dictionary files");
  assert.match(el("import-drop-hint").textContent, /MDX dictionary with its MDD files/u);

  el("opt-experimental-mdxImport").click();
  await tick();
  assert.equal(picker.accept, ".zip,application/zip", "turning the flag off narrows the picker again");
});
