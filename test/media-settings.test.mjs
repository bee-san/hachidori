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

test("fresh Settings lets a user enter a texthooker endpoint before enabling the feed", async t => {
  const dom = new JSDOM(extension("settings.html"), { runScripts: "outside-only", url: "https://settings.example" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.chrome = {
    runtime: { sendMessage(message, callback) { callback({ ok: true, state: "stopped" }); } },
    storage: { onChanged: { addListener() {} } },
  };
  window.eval(extension("reader-options.js"));
  window.eval(extension("dictionary-group-state.js"));
  for (const [file, exports] of [
    ["recommended-install-client.js", ["createRecommendedInstallClient"]],
    ["dictionary-name-drafts.js", ["createDictionaryNameDrafts"]],
    ["dictionary-groups.js", ["createDictionaryGroupController"]],
  ]) {
    window.eval(`{ ${withoutModules(extension(file))}\nObject.assign(globalThis, {${exports.join(",")}}); }`);
  }
  const source = withoutModules(extension("settings.js"));
  assert.ok(source.endsWith("start();\n"));
  window.eval(source.replace(/start\(\);\s*$/u, `
    attachHandlers();
    renderMediaSettings();
    globalThis.readMediaSettings = () => options.mediaCapture;
  `));
  const el = id => window.document.getElementById(id);
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
});
