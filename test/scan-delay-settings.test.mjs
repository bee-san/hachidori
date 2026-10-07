// SPDX-License-Identifier: GPL-3.0-or-later
// Issues #502 and #503: Reading → Activation offers a hover scan delay for No
// key lookups and a definition delay that follows it unless set.
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
// Longer than the Settings save debounce, so each edit is its own write.
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

// Settings on Reading over a worker that commits each patch onto the stored options.
function fixture(t, initial = {}) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: "https://settings.example/#lookup" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.OVERLAY_MODE = false;
  window.HOST_CAPABILITIES = {
    browserShortcuts: true, linkButtons: true, externalLinkHost: false, customJavaScript: true,
    localFileAccessPrompt: true, lowMemoryMode: true,
  };
  window.MINING_CAPABILITIES = { screenshot: true, browserSpeech: true };
  let stored = { revision: 1, ...initial };
  const writes = [];
  window.chrome = {
    runtime: { sendMessage(message) {
      if (message.type !== "hd_options_write") return Promise.resolve({ ok: true, state: "stopped" });
      writes.push(message.options);
      stored = { ...stored, ...message.options, revision: stored.revision + 1 };
      return Promise.resolve({ ok: true, options: stored });
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
    adoptOptions(${JSON.stringify(stored)});
  `));
  const el = id => window.document.getElementById(id);
  const change = (id, value) => {
    el(id).value = value;
    el(id).dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  return { el, change, writes };
}

test("the delays show only where a lookup needs no key", t => {
  const shifted = fixture(t);
  assert.equal(shifted.el("opt-scan-delay-row").hidden, true, "a held key never waits");
  assert.equal(shifted.el("opt-definition-scan-delay-row").hidden, true);

  const { el, change } = fixture(t, { lookupMode: "hover", scanDelayMs: 200 });
  assert.equal(el("opt-scan-delay-row").hidden, false);
  assert.equal(el("opt-scan-delay").value, "200");
  assert.equal(el("opt-definition-scan-delay-row").hidden, false);
  assert.equal(el("opt-definition-scan-delay-mode").value, "inherit");
  assert.equal(el("opt-definition-scan-delay-mode").options[0].textContent, "Same as page delay (200 ms)");
  assert.equal(el("opt-definition-scan-delay-custom").hidden, true);
  for (const [mode, hidden] of [["click", true], ["activation", true], ["inherit", false]]) {
    change("opt-definition-lookup-mode", mode);
    assert.equal(el("opt-definition-scan-delay-row").hidden, hidden, `Child popups: ${mode}`);
  }
  change("opt-activation-key", "Shift");
  assert.equal(el("opt-scan-delay-row").hidden, true);
  assert.equal(el("opt-definition-scan-delay-row").hidden, true);
});

test("Same as page delay saves null and a custom delay, 0 included, saves as set", async t => {
  const { el, change, writes } = fixture(t, { lookupMode: "hover", scanDelayMs: 200 });
  change("opt-definition-scan-delay-mode", "custom");
  assert.equal(el("opt-definition-scan-delay-custom").hidden, false);
  assert.equal(el("opt-definition-scan-delay").value, "200", "Custom starts from the delay it was following");
  await settle();
  change("opt-definition-scan-delay", "0");
  await settle();
  change("opt-scan-delay", "250");
  await settle();
  assert.equal(el("opt-definition-scan-delay").value, "0", "a custom delay stops following the page");
  change("opt-definition-scan-delay-mode", "inherit");
  await settle();
  assert.equal(el("opt-definition-scan-delay-custom").hidden, true);
  assert.equal(el("opt-definition-scan-delay-mode").options[0].textContent, "Same as page delay (250 ms)");
  // The writes come from the page's realm.
  assert.equal(JSON.stringify(writes), JSON.stringify([{ definitionScanDelayMs: 200 }, { definitionScanDelayMs: 0 },
    { scanDelayMs: 250 }, { definitionScanDelayMs: null }]));
});
