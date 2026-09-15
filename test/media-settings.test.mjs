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

function fixture(t, { overlayMode = false, mediaEnabled = false } = {}) {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: "https://settings.example" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const requests = [];
  window.OVERLAY_MODE = overlayMode;
  window.HOST_CAPABILITIES = {
    backupExport: !overlayMode,
    browserShortcuts: !overlayMode,
    customLinks: !overlayMode,
    localFileAccessPrompt: !overlayMode,
    mediaCapture: !overlayMode,
  };
  window.MINING_CAPABILITIES = { screenshot: !overlayMode };
  window.settingsReplies = {
    hd_capture_status: { ok: true, state: "stopped" },
    hd_capture_open: { ok: true },
  };
  window.chrome = {
    runtime: { sendMessage(message) {
      requests.push(structuredClone(message));
      return Promise.resolve(window.settingsReplies[message.type] ?? { ok: true, state: "stopped" });
    } },
    storage: { onChanged: { addListener() {} } },
  };
  window.eval(extension("reader-options.js"));
  window.eval(extension("dictionary-group-state.js"));
  for (const [file, exports] of [
    ["recommended-install-client.js", ["createRecommendedInstallClient"]],
    ["settings-dom.js", ["applyPageTheme", "setStatusOutput"]],
    ["dictionary-name-drafts.js", ["createDictionaryNameDrafts"]],
    ["dictionary-groups.js", ["createDictionaryGroupController"]],
  ]) {
    window.eval(`{ ${withoutModules(extension(file))}\nObject.assign(globalThis, {${exports.join(",")}}); }`);
  }
  const source = withoutModules(extension("settings.js"));
  assert.ok(source.endsWith("start();\n"));
  window.eval(source.replace(/start\(\);\s*$/u, `
    attachHandlers();
    options.mediaCapture.enabled = ${mediaEnabled};
    renderMediaSettings();
    activeSection = "media";
    globalThis.readMediaSettings = () => options.mediaCapture;
    globalThis.refreshMediaStatus = updateMediaSettings;
  `));
  const el = id => window.document.getElementById(id);
  return { window, el, requests };
}

test("fresh Settings lets a user enter a texthooker endpoint before enabling the feed", async t => {
  const { window, el } = fixture(t);
  const endpoint = el("opt-media-texthooker-url"), enabled = el("opt-media-texthooker");
  assert.equal(enabled.checked, false);
  assert.equal(endpoint.value, "");
  assert.equal(endpoint.disabled, false);
  endpoint.value = "ws://127.0.0.1:6677";
  endpoint.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick();
  assert.equal(window.readMediaSettings().texthooker.url, "ws://127.0.0.1:6677/");
  assert.equal(enabled.checked, false);
  enabled.click();
  await tick();
  assert.equal(window.readMediaSettings().texthooker.enabled, true);
  assert.equal(el("opt-media-texthooker-format").disabled, false);

  assert.equal(el("media-runtime-status").classList.contains("operational-status"), true);
  assert.equal(el("media-runtime-status").getAttribute("aria-atomic"), "true");
  await window.refreshMediaStatus();
  assert.equal(el("media-runtime-status").textContent.trim(), "Stopped");
  assert.equal(el("media-runtime-status").classList.contains("is-ready"), false);
  assert.equal(el("media-runtime-status").classList.contains("is-error"), false);

  window.settingsReplies.hd_capture_status = {
    ok: true,
    state: "recording",
    mediaSource: { name: "Reading tab" },
    linkedPage: { title: "Novel" },
  };
  await window.refreshMediaStatus();
  assert.equal(el("media-runtime-status").textContent, "Recording · Reading tab · linked to Novel");
  assert.equal(el("media-runtime-status").classList.contains("is-ready"), true);

  window.settingsReplies.hd_capture_open = { ok: false, error: "display capture is unavailable" };
  el("media-open-capture").click();
  await tick();
  assert.match(el("media-runtime-status").textContent, /display capture is unavailable/u);
  assert.equal(el("media-runtime-status").classList.contains("is-error"), true);

  window.settingsReplies.hd_capture_open = { ok: true };
  el("media-open-capture").click();
  await tick();
  assert.equal(el("media-runtime-status").textContent, "Capture controls opened in a separate tab.");
  assert.equal(el("media-runtime-status").classList.contains("is-error"), false);
});

test("overlay Settings preserves but cannot activate remote media capture options", async t => {
  const { window, el, requests } = fixture(t, { overlayMode: true, mediaEnabled: true });
  assert.equal(el("media-overlay-help").hidden, false);
  assert.equal(el("opt-media-enabled").checked, false);
  assert.ok([...window.document.querySelectorAll("#media button, #media input, #media select")]
    .every(control => control.disabled), "every recorder control is explicitly disabled");

  await window.refreshMediaStatus();
  assert.equal(el("media-runtime-status").textContent, "Media capture is unavailable in this overlay.");
  assert.equal(requests.length, 0, "status does not wake the capture host");

  el("opt-media-enabled").checked = true;
  el("opt-media-enabled").dispatchEvent(new window.Event("change", { bubbles: true }));
  el("media-open-capture").dispatchEvent(new window.Event("click", { bubbles: true }));
  await tick();
  assert.equal(window.readMediaSettings().enabled, true, "the stored host value is preserved");
  assert.equal(el("opt-media-enabled").checked, false, "the effective overlay value stays off");
  assert.equal(requests.length, 0);
});
