// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createSharingSettingsController } from "../extension/sharing-settings.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

const idle = () => new Promise(resolveIdle => setTimeout(resolveIdle, 0));

function status(overrides = {}) {
  return { enabled: false, connected: false, port: 8771, address: "ws://127.0.0.1:8771/link", clients: [], error: null, ...overrides };
}

function fixture(t) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"),
    { pretendToBeVisual: true, url: "https://extension.test/settings.html" });
  const { document } = dom.window;
  const el = id => document.getElementById(id);
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async text => { copied.push(text); } } });
  const requests = [];
  const statuses = [];
  const replies = { hd_sharing_status: () => ({ ok: true, sharing: status() }) };
  const chrome = { runtime: { id: "hachidorisettingsextensionid" },
    permissions: { requested: [], async request(details) { this.requested.push(details); return true; } } };
  const controller = createSharingSettingsController({ document, chrome,
    send: async (type, fields = {}) => { requests.push({ type, ...fields }); return replies[type](fields); },
    setStatus: (message, tone) => statuses.push([message, tone]) });
  t.after(() => { controller.stop(); dom.window.close(); });
  return { window: dom.window, document, el, controller, requests, replies, statuses, copied, chrome,
    toggle(checked) {
      el("sharing-host-enabled").checked = checked;
      el("sharing-host-enabled").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    lastStatus: () => statuses.at(-1) };
}

test("the host card renders the polled status, the address and the install command", async t => {
  const f = fixture(t);
  assert.equal(f.el("sharing-host-enabled").disabled, true, "the switch waits for the first status");
  f.controller.start();
  await idle();
  assert.deepEqual(f.requests, [{ type: "hd_sharing_status" }]);
  assert.equal(f.el("sharing-host-enabled").checked, false);
  assert.equal(f.el("sharing-host-enabled").disabled, false);
  assert.equal(f.el("sharing-host-port").value, "8771");
  assert.equal(f.el("sharing-host-port").disabled, false);
  assert.equal(f.el("sharing-host-address").value, "ws://127.0.0.1:8771/link");
  assert.equal(f.el("sharing-install-command").textContent, "node bridge/install.mjs --extension-id hachidorisettingsextensionid");
  assert.deepEqual(f.lastStatus(), ["Not sharing.", undefined]);

  f.el("sharing-host-port").value = "9000";
  f.el("sharing-host-port").dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.el("sharing-host-address").value, "ws://127.0.0.1:9000/link", "the address follows the port while sharing is off");

  f.el("sharing-host-copy").click();
  await idle();
  assert.deepEqual(f.copied, ["ws://127.0.0.1:9000/link"]);
  assert.deepEqual(f.lastStatus(), ["Copied ws://127.0.0.1:9000/link.", "ready"]);
});

test("turning sharing on asks for the permission, sends the port and shows linked browsers", async t => {
  const f = fixture(t);
  f.controller.start();
  await idle();
  f.el("sharing-host-port").value = "9000";
  f.replies.hd_sharing_host_enable = fields => ({ ok: true, sharing: status({ enabled: true, connected: true, port: fields.port,
    address: `ws://127.0.0.1:${fields.port}/link`, clients: [{ id: "c1", name: "GSM" }, { id: "c2", name: "" }] }) });
  f.toggle(true);
  await idle();
  assert.deepEqual(f.chrome.permissions.requested, [{ permissions: ["nativeMessaging"] }]);
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_host_enable", port: 9000 });
  assert.equal(f.el("sharing-host-enabled").checked, true);
  assert.equal(f.el("sharing-host-port").disabled, true, "the port is fixed while sharing");
  assert.equal(f.el("sharing-host-address").value, "ws://127.0.0.1:9000/link");
  assert.equal(f.el("sharing-host-clients").textContent, "Linked: GSM, another browser.");
  assert.deepEqual(f.lastStatus(), ["Sharing on port 9000.", "ready"]);

  f.replies.hd_sharing_host_disable = () => ({ ok: true, sharing: status() });
  f.toggle(false);
  await idle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_host_disable" });
  assert.equal(f.el("sharing-host-enabled").checked, false);
  assert.equal(f.el("sharing-host-clients").textContent, "");
  assert.deepEqual(f.lastStatus(), ["Not sharing.", undefined]);
});

test("a missing bridge is reported with Chrome's reason and opens the install instructions", async t => {
  const f = fixture(t);
  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ enabled: true, error: "Specified native messaging host not found." }) });
  f.controller.start();
  await idle();
  assert.equal(f.el("sharing-host-enabled").checked, true);
  assert.equal(f.el("sharing-install").open, true);
  assert.deepEqual(f.lastStatus(), ["Sharing is on, but the bridge is not running: Specified native messaging host not found.", "error"]);

  f.replies.hd_sharing_host_enable = () => ({ ok: false, error: "the bridge refused" });
  f.chrome.permissions.request = async () => false;
  f.toggle(true);
  await idle();
  assert.deepEqual(f.lastStatus(), ["Chrome did not allow Hachidori to start the bridge.", "error"]);
  assert.equal(f.requests.filter(request => request.type === "hd_sharing_host_enable").length, 0, "no enable is sent without the permission");
});
