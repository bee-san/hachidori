// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const extension = new URL("../extension/", import.meta.url);
const [html, source, optionsSource, manifest] = await Promise.all([
  readFile(new URL("toolbar.html", extension), "utf8"),
  readFile(new URL("toolbar.js", extension), "utf8"),
  readFile(new URL("reader-options.js", extension), "utf8"),
  readFile(new URL("manifest.json", extension), "utf8").then(JSON.parse),
]);

async function toolbar(stored = {}) {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/gu)].map(([, id]) => [id, {
    id, textContent: "", hidden: true, attributes: new Map(), listeners: new Map(),
    classList: { values: new Set(), toggle(name, enabled) {
      if (enabled) this.values.add(name); else this.values.delete(name);
    } },
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
  }]));
  const requests = [];
  let storageListener;
  let nextWriteReply;
  let openedSettings = 0;
  let closed = 0;
  const context = vm.createContext({
    document: { querySelectorAll: () => [...nodes.values()] },
    window: { close: () => { closed++; }, addEventListener() {} },
    setInterval() { return 1; }, clearInterval() {},
    chrome: {
      storage: {
        local: { async get() { return { options: stored }; } },
        onChanged: { addListener(callback) { storageListener = callback; } },
      },
      runtime: {
        async openOptionsPage() { openedSettings++; },
        async sendMessage(message) {
          requests.push(JSON.parse(JSON.stringify(message)));
          if (message.type === "hd_options_write") {
            if (nextWriteReply) {
              const reply = nextWriteReply;
              nextWriteReply = null;
              return reply;
            }
            assert.equal(message.baseRevision, stored.revision ?? 0);
            stored = { ...stored, ...message.options, revision: (stored.revision ?? 0) + 1 };
            return { ok: true, options: stored };
          }
          throw new Error(`Unexpected request: ${message.type}`);
        },
      },
    },
  });
  vm.runInContext(optionsSource, context);
  const script = source
    .replace(/import \{ extensionApi as chrome \} from "\.\/browser-api\.js";\s*/u, "")
    .replace('import "./reader-options.js";', "");
  await vm.runInContext(`(async () => { ${script} })()`, context);
  return {
    nodes, requests,
    async click(id) { nodes.get(id).listeners.get("click")(); await setImmediate(); },
    async changed(value) { stored = value; storageListener({ options: { newValue: value } }, "local"); await setImmediate(); },
    conflict(value) { stored = value; nextWriteReply = { ok: false, conflict: true,
      error: "Settings changed. Try again.", options: value }; },
    get openedSettings() { return openedSettings; },
    get closed() { return closed; },
  };
}

test("toolbar toggle persists global lookup state and follows external activation settings", async () => {
  assert.equal(manifest.action.default_popup, "toolbar.html");
  const ui = await toolbar({ hoverEnabled: true, revision: 7 });
  assert.equal(ui.nodes.get("lookup-state").textContent, "On");
  assert.equal(ui.requests.length, 0, "opening a default popup does not send requests");
  await ui.click("lookup-toggle");
  assert.deepEqual(ui.requests[0], { target: "hoshidicts-worker", type: "hd_options_write",
    requestId: "toolbar-1", baseRevision: 7, options: { hoverEnabled: false } });
  assert.equal(ui.nodes.get("lookup-toggle").attributes.get("aria-checked"), "false");
  await ui.changed({ hoverEnabled: true, lookupMode: "activation", activationKey: "Alt", revision: 9 });
  assert.equal(ui.nodes.get("activation-hint").textContent, "Hold Alt to scan");
  assert.equal(ui.nodes.get("lookup-state").textContent, "On");
});

test("toolbar conflict displays the committed switch state and allows a fresh retry", async () => {
  const ui = await toolbar({ hoverEnabled: true, revision: 1 });
  ui.conflict({ hoverEnabled: true, revision: 2 });
  await ui.click("lookup-toggle");
  assert.equal(ui.nodes.get("lookup-state").textContent, "On");
  assert.equal(ui.nodes.get("toolbar-error").hidden, false);
  assert.equal(ui.nodes.get("lookup-toggle").disabled, false);
  await ui.click("lookup-toggle");
  assert.equal(ui.requests[1].baseRevision, 2);
  assert.equal(ui.nodes.get("lookup-state").textContent, "Off");
  assert.equal(ui.nodes.get("toolbar-error").hidden, true);
});

test("settings shortcut opens Chrome options and closes the toolbar", async () => {
  const ui = await toolbar();
  await ui.click("open-settings");
  assert.equal(ui.openedSettings, 1);
  assert.equal(ui.closed, 1);
});
