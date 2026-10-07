/*
 * Experimental Netflix mining: the recorder port.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { loadBackgroundScript, makeBus, makeChrome, makeEvent, makeStorage } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

// Experimental Netflix mining: only the extension's own recorder page, framed
// in a Netflix watch tab, keeps its port, and only while the switch is on.
async function netflixRecorderPortStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("netflix-recorder", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  chrome.runtime.sendMessage = () => Promise.resolve({ ok: true });
  loadBackgroundScript({ chrome, console, clearTimeout, setTimeout, Promise, Error });
  const watch = { id: 7, url: "https://www.netflix.com/watch/81000001" };
  const connect = (sender) => {
    const port = { name: "hachidori-netflix-recorder", sender, onMessage: makeEvent(), onDisconnect: makeEvent(),
      disconnected: false, disconnect() { this.disconnected = true; this.onDisconnect.fire(); } };
    chrome.__events.onConnect.fire(port);
    return port;
  };
  const recorder = { id: chrome.runtime.id, url: chrome.runtime.getURL("netflix-recorder.html"), frameId: 3, tab: watch };
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const off = connect(recorder);
  const wrongPage = connect({ ...recorder, url: chrome.runtime.getURL("settings.html") });
  const topFrame = connect({ ...recorder, frameId: 0 });
  const browsePage = connect({ ...recorder, tab: { id: 7, url: "https://www.netflix.com/browse" } });
  await settle();
  // Read now: a later port for the same tab would replace this one either way.
  const refusedWhileOff = off.disconnected;
  const flags = { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.experimental, netflixMining: true };
  await chrome.storage.local.set({ options: { revision: 1, experimental: flags } });
  const on = connect(recorder);
  await settle();
  check("the Netflix recorder port is kept only for the recorder page framed in a watch tab while the switch is on",
    refusedWhileOff && wrongPage.disconnected && topFrame.disconnected && browsePage.disconnected && !on.disconnected,
    JSON.stringify({ off: refusedWhileOff, wrongPage: wrongPage.disconnected, topFrame: topFrame.disconnected,
      browsePage: browsePage.disconnected, on: on.disconnected }));
}

describe("Netflix", () => {
  test("Netflix recorder port", async () => {
    await netflixRecorderPortStage();
  });
});
