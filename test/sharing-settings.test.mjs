// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createSharingSettingsController } from "../extension/sharing-settings.js";
import { setStatusOutput } from "../extension/settings-dom.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

const settle = () => new Promise(resolveSettle => setTimeout(resolveSettle, 10));

function status(overrides = {}) {
  return { enabled: true, connected: false, port: 8771, dictionaries: 0, error: null,
    network: { enabled: false, active: false, addresses: [], error: null }, clients: [],
    client: { linked: false, address: null, display: null, connected: false, host: null, error: null }, ...overrides };
}

const CHROME = { version: "0.1.0", name: "Chrome", dictionaryCount: 5 };

function linkedStatus(overrides = {}) {
  return status({ enabled: false, client: { linked: true, address: "ws://100.75.152.75:8771/link", display: "100.75.152.75", connected: true,
    host: CHROME, error: null, ...overrides } });
}

function fixture(t, { probe = () => ({ ok: false, error: "No shared Hachidori answered at ws://127.0.0.1:8771/link." }), download = async () => {} } = {}) {
  const dom = new JSDOM(readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8"),
    { pretendToBeVisual: true, url: "https://extension.test/settings.html" });
  const { document } = dom.window;
  const el = id => document.getElementById(id);
  const copied = [];
  const downloads = [];
  const requests = [];
  const statuses = [];
  const replies = { hd_sharing_status: () => ({ ok: true, sharing: status() }), hd_sharing_client_probe: probe };
  const reloads = [];
  const controller = createSharingSettingsController({ document,
    send: async (type, fields = {}) => { requests.push({ type, ...fields }); return replies[type](fields); },
    setStatus: (message, tone) => {
      statuses.push([message, tone]);
      setStatusOutput(el("sharing-status"), message, tone);
    },
    downloadAddon: async () => { downloads.push(true); await download(); },
    copy: async text => { copied.push(text); },
    reload: () => reloads.push(true) });
  t.after(() => { controller.stop(); dom.window.close(); });
  return { window: dom.window, document, el, controller, requests, replies, statuses, copied, downloads, reloads,
    toggle(id, checked) {
      el(id).checked = checked;
      el(id).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    lastStatus: () => statuses.at(-1),
    sent: type => requests.filter(request => request.type === type) };
}

test("a fresh install waits for dictionaries, offers the add-on, and looks for a shared Hachidori on this computer", async t => {
  const f = fixture(t);
  assert.equal(f.el("sharing-status").classList.contains("operational-status"), true);
  assert.equal(f.el("sharing-status").getAttribute("aria-atomic"), "true");
  assert.equal(f.el("sharing-host-enabled").disabled, true, "the switch waits for the first status");
  f.controller.start();
  await settle();
  assert.deepEqual(f.sent("hd_sharing_status").length, 1);
  assert.deepEqual(f.sent("hd_sharing_client_probe"), [{ type: "hd_sharing_client_probe", address: "" }], "this computer is probed once on opening");
  assert.equal(f.el("sharing-host-enabled").checked, true);
  assert.equal(f.el("sharing-host-enabled").disabled, false);
  assert.equal(f.el("sharing-host-network").checked, false);
  assert.equal(f.el("sharing-host-network").disabled, false);
  assert.equal(f.el("sharing-addon").hidden, false, "the add-on is offered until Anki carries the connection");
  assert.equal(f.el("sharing-host-port").value, "8771");
  assert.equal(f.el("sharing-host-port").disabled, true, "the port is fixed while sharing");
  assert.equal(f.el("sharing-host-addresses").hidden, true);
  assert.equal(f.el("sharing-host-clients").textContent, "");
  assert.equal(f.el("sharing-client-nearby").hidden, false);
  assert.equal(f.el("sharing-client-found").textContent, "No other Hachidori is sharing on this computer.");
  assert.equal(f.el("sharing-client-use").hidden, true);
  assert.equal(f.el("sharing-client-remote").hidden, false);
  assert.deepEqual(f.lastStatus(), ["Sharing starts once this Hachidori has dictionaries.", undefined]);
  assert.equal(f.el("sharing-status").classList.contains("is-ready"), false);
  assert.equal(f.el("sharing-status").classList.contains("is-error"), false);

  f.el("sharing-addon-download").click();
  await settle();
  assert.deepEqual(f.downloads, [true]);
  assert.deepEqual(f.lastStatus(), ["Saved hachidori-relay.ankiaddon to your downloads. Double-click it to install it in Anki, then restart Anki.", "ready"]);
});

test("a pending download keeps its progress through polls, reports failure, and allows retry", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let rejectDownload;
  let attempts = 0;
  const f = fixture(t, { download: () => {
    attempts += 1;
    if (attempts === 1) return new Promise((_resolve, reject) => { rejectDownload = reject; });
  } });
  f.controller.start();
  await settle();
  const button = f.el("sharing-addon-download");
  button.click();
  button.click();
  assert.deepEqual(f.downloads, [true], "only one download runs at a time");
  assert.equal(button.disabled, true);
  assert.deepEqual(f.lastStatus(), ["Downloading the Anki add-on from GitHub…", undefined]);
  now += 60_000;
  f.controller.render();
  assert.deepEqual(f.lastStatus(), ["Downloading the Anki add-on from GitHub…", undefined]);

  rejectDownload(new Error("Network offline."));
  await settle();
  assert.equal(button.disabled, false);
  assert.deepEqual(f.lastStatus(), ["Could not download the add-on: Network offline.", "error"]);
  f.controller.render();
  assert.deepEqual(f.lastStatus(), ["Could not download the add-on: Network offline.", "error"]);

  button.click();
  await settle();
  assert.deepEqual(f.downloads, [true, true]);
  assert.equal(button.disabled, false);
  assert.equal(f.lastStatus()[1], "ready");
});

test("waiting for Anki, a refusal by another host, and sharing are told apart", async t => {
  const f = fixture(t);
  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ dictionaries: 3 }) });
  f.controller.start();
  await settle();
  assert.deepEqual(f.lastStatus(), ["Waiting for Anki. Sharing starts when Anki is open with the Hachidori Relay add-on.", undefined]);

  // The relay turning this install away means another browser is sharing: it is looked for again and offered.
  f.replies.hd_sharing_client_probe = () => ({ ok: true, address: "ws://127.0.0.1:8771/link", display: "this computer", host: CHROME });
  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ dictionaries: 3, error: "Another browser on this computer is already sharing through Anki." }) });
  f.controller.stop();
  f.controller.start();
  await settle();
  assert.deepEqual(f.lastStatus(), ["Sharing is on, but another browser on this computer is already sharing through Anki.", "error"]);
  assert.equal(f.el("sharing-status").classList.contains("is-error"), true);
  assert.equal(f.sent("hd_sharing_client_probe").length, 2);
  assert.equal(f.el("sharing-client-found").textContent, "Another browser on this computer is sharing: the Hachidori in Chrome on this computer (5 dictionaries).");
  assert.equal(f.el("sharing-client-use").hidden, false);

  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ dictionaries: 3, connected: true, clients: [
    { id: "c1", name: "Microsoft Edge", address: "127.0.0.1", local: true }, { id: "c2", name: "", address: "100.75.152.76", local: false },
    // The relay's own Yomitan API session is not a linked browser.
    { id: "c3", name: "Hachidori Relay API", origin: "relay://yomitan-api", address: "127.0.0.1", local: true }] }) });
  f.controller.stop();
  f.controller.start();
  await settle();
  assert.deepEqual(f.lastStatus(), ["Sharing through Anki.", "ready"]);
  assert.equal(f.el("sharing-status").classList.contains("is-ready"), true);
  assert.equal(f.el("sharing-status").classList.contains("is-error"), false);
  assert.equal(f.el("sharing-addon").hidden, true);
  assert.equal(f.el("sharing-client-nearby").hidden, true, "the host is not offered itself");
  assert.equal(f.sent("hd_sharing_client_probe").length, 2, "and does not probe");
  assert.equal(f.el("sharing-host-clients").textContent, "Linked: Microsoft Edge on this computer, another browser at 100.75.152.76.");
});

test("sharing with other computers shows the addresses to enter, with a copy for each", async t => {
  const f = fixture(t);
  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ dictionaries: 3, connected: true }) });
  f.controller.start();
  await settle();
  const addresses = [{ address: "100.75.152.75", kind: "tailscale" }, { address: "192.168.1.123", kind: "local" }];
  f.replies.hd_sharing_host_enable = fields => ({ ok: true, sharing: status({ dictionaries: 3, connected: true, port: fields.port,
    network: { enabled: fields.network, active: false, addresses: [], error: null } }) });
  f.toggle("sharing-host-network", true);
  await settle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_host_enable", port: 8771, network: true });
  assert.equal(f.el("sharing-host-addresses").hidden, false);
  assert.equal(f.el("sharing-host-addresses-note").textContent, "The address appears once Anki is connected.");
  assert.equal(f.el("sharing-host-address-list").children.length, 0);

  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ dictionaries: 3, connected: true,
    network: { enabled: true, active: true, addresses, error: null } }) });
  f.controller.stop();
  f.controller.start();
  await settle();
  assert.deepEqual(f.lastStatus(), ["Sharing through Anki, on this computer and the network.", "ready"]);
  assert.equal(f.el("sharing-host-addresses-note").textContent, "On your other computer, enter one of these under Sharing:");
  const rows = [...f.el("sharing-host-address-list").children];
  assert.deepEqual(rows.map(row => [row.querySelector("code").textContent, row.querySelector("span").textContent]),
    [["100.75.152.75", "Tailscale"], ["192.168.1.123", "Local network"]]);
  rows[0].querySelector("button").click();
  await settle();
  assert.deepEqual(f.copied, ["100.75.152.75"]);
  assert.deepEqual(f.lastStatus(), ["Copied 100.75.152.75.", "ready"]);

  f.replies.hd_sharing_status = () => ({ ok: true, sharing: status({ dictionaries: 3, connected: true,
    network: { enabled: true, active: false, addresses: [], error: "[Errno 13] Permission denied" } }) });
  f.controller.stop();
  f.controller.start();
  await settle();
  assert.equal(f.el("sharing-host-addresses-note").textContent, "Anki could not share on the network: [Errno 13] Permission denied");
  assert.equal(f.el("sharing-host-address-list").children.length, 0);

  f.replies.hd_sharing_host_disable = () => ({ ok: true, sharing: status({ enabled: false, dictionaries: 3 }) });
  f.toggle("sharing-host-enabled", false);
  await settle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_host_disable" });
  assert.equal(f.el("sharing-host-network").disabled, true);
  assert.equal(f.el("sharing-host-addresses").hidden, true);
  assert.equal(f.el("sharing-host-port").disabled, false);
  assert.deepEqual(f.lastStatus(), ["Not sharing.", undefined]);

  f.el("sharing-host-port").value = "9000";
  f.el("sharing-host-port").dispatchEvent(new f.window.Event("input", { bubbles: true }));
  f.replies.hd_sharing_host_enable = fields => ({ ok: true, sharing: status({ dictionaries: 3, port: fields.port }) });
  f.toggle("sharing-host-enabled", true);
  await settle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_host_enable", port: 9000, network: false });
  assert.equal(f.el("sharing-host-port").value, "9000");
});

test("a failed action stays visible for a moment above the polled status", async t => {
  const f = fixture(t);
  f.controller.start();
  await settle();
  f.replies.hd_sharing_host_disable = () => ({ ok: false, error: "the worker did not answer" });
  f.toggle("sharing-host-enabled", false);
  await settle();
  assert.deepEqual(f.lastStatus(), ["the worker did not answer", "error"]);
  assert.equal(f.el("sharing-host-enabled").checked, true, "the switch shows the stored state, not the failed request");
  f.controller.render();
  assert.deepEqual(f.lastStatus(), ["the worker did not answer", "error"], "the next poll does not wipe it at once");
});

test("using the Hachidori found here, or one on another computer, links and reloads", async t => {
  const f = fixture(t, { probe: () => ({ ok: true, address: "ws://127.0.0.1:8771/link", display: "this computer", host: CHROME }) });
  f.controller.start();
  await settle();
  assert.equal(f.el("sharing-client-use").hidden, false);
  f.replies.hd_sharing_client_link = () => ({ ok: true, sharing: linkedStatus({ address: "ws://127.0.0.1:8771/link", display: "this computer" }) });
  f.el("sharing-client-use").click();
  await settle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_client_link", address: "ws://127.0.0.1:8771/link" });
  assert.deepEqual(f.reloads, [true]);

  f.el("sharing-client-address").value = " 100.75.152.75 ";
  f.replies.hd_sharing_client_link = () => ({ ok: true, sharing: linkedStatus() });
  f.el("sharing-client-link").click();
  await settle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_client_link", address: " 100.75.152.75 " });
  assert.deepEqual(f.reloads, [true, true]);

  f.replies.hd_sharing_client_link = () => ({ ok: false, error: "No shared Hachidori answered at ws://100.75.152.76:8771/link." });
  f.el("sharing-client-address").value = "100.75.152.76";
  f.el("sharing-client-link").click();
  await settle();
  assert.deepEqual(f.lastStatus(), ["No shared Hachidori answered at ws://100.75.152.76:8771/link.", "error"]);
  assert.deepEqual(f.reloads, [true, true]);
});

test("a linked browser shows what it uses, cannot share itself, and unlinks with a reload", async t => {
  const f = fixture(t);
  f.replies.hd_sharing_status = () => ({ ok: true, sharing: linkedStatus() });
  f.controller.start();
  await settle();
  assert.equal(f.el("sharing-host").disabled, true);
  assert.equal(f.el("sharing-host-enabled").checked, false);
  assert.equal(f.el("sharing-addon").hidden, true);
  assert.equal(f.el("sharing-client-nearby").hidden, true);
  assert.equal(f.el("sharing-client-remote").hidden, true);
  assert.equal(f.el("sharing-client-link").hidden, true);
  assert.equal(f.el("sharing-client-unlink").hidden, false);
  assert.equal(f.sent("hd_sharing_client_probe").length, 0);
  assert.deepEqual(f.lastStatus(), ["Using the Hachidori in Chrome at 100.75.152.75 (5 dictionaries).", "ready"]);

  f.replies.hd_sharing_status = () => ({ ok: true, sharing: linkedStatus({ connected: false, host: null, error: "The linked Hachidori is not reachable." }) });
  f.controller.stop();
  f.controller.start();
  await settle();
  assert.deepEqual(f.lastStatus(), ["Linked to 100.75.152.75, but it is not reachable. Check that Anki and the sharing browser are open there.", "error"]);

  f.replies.hd_sharing_status = () => ({ ok: true, sharing: linkedStatus({ address: "ws://127.0.0.1:8771/link", display: "this computer", connected: false, host: null, error: "The linked Hachidori is not reachable." }) });
  f.controller.stop();
  f.controller.start();
  await settle();
  assert.deepEqual(f.lastStatus(), ["Linked to a Hachidori on this computer, but it is not reachable. Check that Anki and the sharing browser are open.", "error"]);

  f.replies.hd_sharing_client_unlink = () => ({ ok: true, sharing: status({ enabled: false, dictionaries: 1 }) });
  f.el("sharing-client-unlink").click();
  await settle();
  assert.deepEqual(f.requests.at(-1), { type: "hd_sharing_client_unlink" });
  assert.deepEqual(f.reloads, [true]);
  assert.equal(f.el("sharing-host").disabled, false);
});
