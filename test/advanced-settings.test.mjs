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
function fixture(t, { hash = "#advanced", stored = {}, overlayMode = false, firefox = false } = {}) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: `https://settings.example/${hash}` });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.IS_FIREFOX = firefox;
  window.HOST_BROWSER = firefox ? "firefox" : "chrome";
  window.OVERLAY_MODE = overlayMode;
  window.HOST_CAPABILITIES = {
    browserShortcuts: !overlayMode, linkButtons: true, externalLinkHost: overlayMode, customJavaScript: !firefox,
    localFileAccessPrompt: !overlayMode, mediaCapture: !overlayMode && !firefox, lowMemoryMode: !firefox,
  };
  window.MINING_CAPABILITIES = { screenshot: !overlayMode, browserSpeech: !overlayMode && !firefox };
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
  return { window, el, visible,
    mediaNav: () => window.document.querySelector('.settings-nav a[href="#media"]').parentElement,
    mediaOption: () => el("settings-section").querySelector('option[value="media"]') };
}

test("Advanced lists the media mining switch and reveals Media capture only while it is on", async t => {
  const { window, el, visible, mediaNav, mediaOption } = fixture(t);
  assert.deepEqual(visible(), ["advanced"]);
  assert.equal(el("settings-section").value, "advanced");
  assert.equal(window.document.querySelector('.settings-nav a[href="#advanced"]').getAttribute("aria-current"), "page");
  assert.equal(el("options-feedback").closest("section").id, "advanced", "save feedback mounts in the section");
  assert.equal(el("experimental-empty").hidden, true);

  const toggle = el("opt-experimental-mediaMining");
  assert.equal(toggle.checked, false);
  assert.equal(mediaNav().hidden, true);
  assert.equal(mediaOption().hidden, true);
  const link = window.document.getElementById(toggle.getAttribute("aria-describedby")).querySelector("a");
  assert.equal(link.hidden, true);

  toggle.click();
  await tick();
  assert.equal(window.readOptions().experimental.mediaMining, true);
  assert.equal(JSON.stringify(window.readPending()),
    JSON.stringify({ experimental: { ...window.HDReaderOptions.DEFAULT_OPTIONS.experimental, mediaMining: true } }));
  assert.equal(window.readOptions().mediaCapture.enabled, false, "turning the flag on does not start capturing");
  assert.equal(mediaNav().hidden, false);
  assert.equal(mediaOption().hidden, false);
  assert.equal(link.hidden, false);

  window.location.hash = link.getAttribute("href");
  window.dispatchEvent(new window.Event("hashchange"));
  assert.deepEqual(visible(), ["media"]);
});

test("a hidden Media capture request lands on Advanced until the stored flag reveals it", async t => {
  const off = fixture(t, { hash: "#media" });
  assert.deepEqual(off.visible(), ["advanced"]);
  assert.equal(off.window.location.hash, "#media", "the requested fragment is kept for when the flag turns on");

  const on = fixture(t, { hash: "#media", stored: { experimental: { mediaMining: true } } });
  assert.deepEqual(on.visible(), ["media"]);
  assert.equal(on.mediaNav().hidden, false);

  const legacy = fixture(t, { hash: "#media", stored: { mediaCapture: { enabled: true } } });
  assert.deepEqual(legacy.visible(), ["media"], "a profile that enabled capture before the flag keeps its section");
  assert.equal(legacy.el("opt-experimental-mediaMining").checked, true);
});

test("turning media mining off also stops the recorder switch in the same save", async t => {
  const { window, el, visible } = fixture(t, { stored: { experimental: { mediaMining: true }, mediaCapture: { enabled: true } } });
  const toggle = el("opt-experimental-mediaMining");
  assert.equal(toggle.checked, true);
  toggle.click();
  await tick();
  await tick();
  const options = window.readOptions();
  assert.equal(options.experimental.mediaMining, false);
  assert.equal(options.mediaCapture.enabled, false);
  assert.deepEqual(Object.keys(window.readPending()).sort(), ["experimental", "mediaCapture"]);
  assert.deepEqual(visible(), ["advanced"]);

  window.location.hash = "#media";
  window.dispatchEvent(new window.Event("hashchange"));
  assert.deepEqual(visible(), ["advanced"], "the hidden section redirects to its switch");
});

test("overlay Settings toggles the flag without touching the browser's saved recorder switch", async t => {
  const { window, el } = fixture(t, { overlayMode: true,
    stored: { experimental: { mediaMining: true }, mediaCapture: { enabled: true } } });
  el("opt-experimental-mediaMining").click();
  await tick();
  assert.equal(window.readOptions().experimental.mediaMining, false);
  assert.equal(window.readOptions().mediaCapture.enabled, true, "the overlay cannot edit recorder settings");
  assert.deepEqual(Object.keys(window.readPending()), ["experimental"]);
});

test("Firefox does not list the media mining switch and a stored flag cannot reveal Media capture", async t => {
  // A backup restored from Chrome may carry mediaMining: true; Firefox has no
  // media capture, so the section, its navigation, and the switch stay away.
  const { window, el, visible, mediaNav, mediaOption } = fixture(t, {
    hash: "#media", firefox: true, stored: { experimental: { mediaMining: true }, mediaCapture: { enabled: true } },
  });
  assert.deepEqual(visible(), ["dictionaries"], "an unavailable section falls back rather than landing on Advanced");
  assert.equal(el("opt-experimental-mediaMining"), null);
  // Flags without a section are browser-independent and stay listed.
  const others = window.HDReaderOptions.EXPERIMENTAL_FEATURES.filter(feature => !feature.section);
  for (const feature of others) assert.notEqual(el(`opt-experimental-${feature.id}`), null, feature.id);
  assert.equal(el("experimental-empty").hidden, others.length > 0);
  assert.equal(mediaNav().hidden, true);
  assert.equal(mediaOption().hidden, true);
  assert.equal(el("media").hidden, true);
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
