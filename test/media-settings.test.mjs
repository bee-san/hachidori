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

test("Settings exposes one recent window while advanced timing remains dormant", async t => {
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
    globalThis.readActiveMediaSettings = () => HDReaderOptions.activeMediaCapture(options.mediaCapture);
  `));
  const el = id => window.document.getElementById(id);
  const duration = el("opt-media-clip");
  assert.equal(duration.type, "number");
  assert.equal(duration.min, "1");
  assert.equal(duration.max, "60");
  assert.equal(duration.value, "10");
  assert.equal(el("media-history-field").hidden, true);
  assert.equal(el("media-timing-settings").hidden, true);
  assert.equal(el("media-texthooker-settings").hidden, true);

  duration.value = "37";
  duration.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick();
  assert.equal(window.readMediaSettings().clipSeconds, 37);
  assert.deepEqual(JSON.parse(JSON.stringify(window.readActiveMediaSettings())), {
    ...window.readMediaSettings(),
    timingMode: "recent",
    historySeconds: 37,
    texthooker: { ...window.readMediaSettings().texthooker, enabled: false },
    page: { nativeCues: false, domText: false, autoLearnArea: false },
  });

  for (const invalid of ["", "0", "61", "1.5"]) {
    duration.value = invalid;
    duration.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
    assert.equal(duration.value, "37");
    assert.equal(window.readMediaSettings().clipSeconds, 37);
  }

  const endpoint = el("opt-media-texthooker-url");
  endpoint.value = "ws://127.0.0.1:6677";
  endpoint.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick();
  assert.equal(window.readMediaSettings().texthooker.url, "ws://127.0.0.1:6677/");
  assert.equal(window.readActiveMediaSettings().texthooker.enabled, false);
});
