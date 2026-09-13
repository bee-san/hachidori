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
  return { enabled: false, connected: false, port: 8771, address: "ws://127.0.0.1:8771/link", clients: [], error: null,
    client: { linked: false, address: null, connected: false, host: null, error: null }, ...overrides };
}

function linkedStatus(overrides = {}) {
  return status({ client: { linked: true, address: "ws://127.0.0.1:8771/link", connected: true,
    host: { version: "0.1.0", dictionaryCount: 5 }, error: null, ...overrides } });
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
  const reloads = [];
  const controller = createSharingSettingsController({ document,
    send: async (type, fields = {}) => { requests.push({ type, ...fields }); return replies[type](fields); },
    setStatus: (message, tone) => statuses.push([message, tone]),
    reload: () => reloads.push(true) });
  t.after(() => { controller.stop(); dom.window.close(); });
  return { window: dom.window, document, el, controller, requests, replies, statuses, copied, reloads,
    toggle(checked) {
      el("sharing-host-enabled").checked = checked;
      el("sharing-host-enabled").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    lastStatus: () => statuses.at(-1) };
}

test("the host card renders the polled status and the address", async t => {
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
  assert.deepEqual(f.lastStatus(), ["Not sharing.", undefined]);

  f.el("sharing-host-port").value = "9000";
  f.el("sharing-host-port").dispatchEvent(new f.window.Event("input", { bubbles: true }));
  assert.equal(f.el("sharing-host-address").value, "ws://127.0.0.1:9000/link", "the address follows the port while sharing is off");

  f.el("sharing-host-copy").click();
  await idle();
  assert.deepEqual(f.copied, ["ws://127.0.0.1:9000/link"]);
  assert.deepEqual(f.lastStatus(), ["Copied ws://127.0.0.1:9000/link.", "ready"]);
});

test("turning sharing on sends the port and shows linked browsers", async t => {
  const f = fixture(t);
  f.controller.start();
  await idle();
  f.el("sharing-host-port").value = "9000";
  f.replies.hd_sharing_host_enable = fields => ({ ok: true, sharing: status({ enabled: true, connected: true, port: fields.port,
    address: `ws://127.0.0.1:${fields.port}/link`, clients: [{ id: "c1", name: "GSM" }, { id: "c2", name: "" }] }) });
  f.toggle(true);
  await idle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_host_enable", port: 9000 });
  assert.equal(f.el("sharing-host-enabled").checked, true);
  assert.equal(f.el("sharing-host-port").disabled, true, "the port is fixed while sharing");
  assert.equal(f.el("sharing-host-address").value, "ws://127.0.0.1:9000/link");
  assert.equal(f.el("sharing-host-clients").textContent, "Linked: GSM, another browser.");
  assert.deepEqual(f.lastStatus(), ["Sharing through GameSentenceMiner on port 9000.", "ready"]);

  f.replies.hd_sharing_host_disable = () => ({ ok: true, sharing: status() });
  f.toggle(false);
  await idle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_host_disable" });
  assert.equal(f.el("sharing-host-enabled").checked, false);
  assert.equal(f.el("sharing-host-clients").textContent, "");
  assert.deepEqual(f.lastStatus(), ["Not sharing.", undefined]);
});

test("waiting for GameSentenceMiner and a relay refusal are told apart, and a failed action stays visible", async t => {
  const f = fixture(t);
  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ enabled: true }) });
  f.controller.start();
  await idle();
  assert.equal(f.el("sharing-host-enabled").checked, true);
  assert.equal(f.el("sharing-host-port").disabled, true);
  assert.deepEqual(f.lastStatus(), ["Sharing is on. Waiting for GameSentenceMiner to start.", undefined]);

  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ enabled: true, error: "Another Hachidori is already sharing through GameSentenceMiner." }) });
  f.controller.stop();
  f.controller.start();
  await idle();
  assert.deepEqual(f.lastStatus(), ["Sharing is on, but Another Hachidori is already sharing through GameSentenceMiner.", "error"]);

  f.replies.hd_sharing_host_disable = () => ({ ok: false, error: "the worker did not answer" });
  f.toggle(false);
  await idle();
  assert.deepEqual(f.lastStatus(), ["the worker did not answer", "error"]);
  assert.equal(f.el("sharing-host-enabled").checked, true, "the switch shows the stored state, not the failed request");
});

test("finding a shared Hachidori offers to use it, and linking reloads the page", async t => {
  const f = fixture(t);
  f.controller.start();
  await idle();
  assert.equal(f.el("sharing-client-use").hidden, true);
  assert.equal(f.el("sharing-client-unlink").hidden, true);
  f.replies.hd_sharing_client_probe = () => ({ ok: true, address: "ws://127.0.0.1:8771/link", host: { version: "0.1.0", dictionaryCount: 5 } });
  f.el("sharing-client-find").click();
  await idle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_client_probe", address: "" });
  assert.equal(f.el("sharing-client-found").textContent, "Found Hachidori 0.1.0 with 5 dictionaries at ws://127.0.0.1:8771/link.");
  assert.equal(f.el("sharing-client-use").hidden, false);

  f.replies.hd_sharing_client_link = () => ({ ok: true, sharing: linkedStatus() });
  f.el("sharing-client-use").click();
  await idle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_client_link", address: "ws://127.0.0.1:8771/link" });
  assert.deepEqual(f.reloads, [true]);

  f.replies.hd_sharing_client_probe = () => ({ ok: false, error: "No shared Hachidori answered at ws://127.0.0.1:9000/link." });
  f.el("sharing-client-address").value = "ws://127.0.0.1:9000/link";
  f.el("sharing-client-find").click();
  await idle();
  assert.deepEqual(f.lastStatus(), ["No shared Hachidori answered at ws://127.0.0.1:9000/link.", "error"]);
  assert.equal(f.el("sharing-client-use").hidden, true);

  f.replies.hd_sharing_client_link = () => ({ ok: true, sharing: linkedStatus({ address: "ws://127.0.0.1:9000/link" }) });
  f.el("sharing-client-link").click();
  await idle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_client_link", address: "ws://127.0.0.1:9000/link" });
  assert.deepEqual(f.reloads, [true, true]);
});

test("a linked browser shows its host, cannot share itself, and unlinks with a reload", async t => {
  const f = fixture(t);
  f.replies.hd_sharing_status = () => ({ ok: true, sharing: linkedStatus() });
  f.controller.start();
  await idle();
  assert.equal(f.el("sharing-host").disabled, true);
  assert.equal(f.el("sharing-client-find").hidden, true);
  assert.equal(f.el("sharing-client-link").hidden, true);
  assert.equal(f.el("sharing-client-address").parentElement.hidden, true);
  assert.equal(f.el("sharing-client-unlink").hidden, false);
  assert.equal(f.el("sharing-client-status").textContent, "Linked to ws://127.0.0.1:8771/link: Hachidori 0.1.0 with 5 dictionaries at ws://127.0.0.1:8771/link.");
  assert.deepEqual(f.lastStatus(), ["Using the Hachidori 0.1.0 with 5 dictionaries at ws://127.0.0.1:8771/link.", "ready"]);

  f.replies.hd_sharing_status = () => ({ ok: true, sharing: linkedStatus({ connected: false, host: null, error: "The linked Hachidori is not reachable." }) });
  f.controller.stop();
  f.controller.start();
  await idle();
  assert.deepEqual(f.lastStatus(), ["Linked to ws://127.0.0.1:8771/link, but it is not reachable: The linked Hachidori is not reachable..", "error"]);

  f.replies.hd_sharing_client_unlink = () => ({ ok: true, sharing: status() });
  f.el("sharing-client-unlink").click();
  await idle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_client_unlink" });
  assert.deepEqual(f.reloads, [true]);
  assert.equal(f.el("sharing-host").disabled, false);
});

test("a sharing host cannot also link to another Hachidori", async t => {
  const f = fixture(t);
  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ enabled: true, connected: true }) });
  f.controller.start();
  await idle();
  assert.equal(f.el("sharing-client").disabled, true);
  assert.equal(f.el("sharing-host").disabled, false);
});
