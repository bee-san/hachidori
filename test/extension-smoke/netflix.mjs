/*
 * Experimental Netflix mining: the recorder port and the line audio request.
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

// Experimental Netflix mining: the WAV the player page cut from what the viewer
// heard is held for the note for that top-frame watch document only, with the
// switch on. Nothing was captured, so it need not be the active tab.
async function netflixLineAudioStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("netflix-line-audio", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  let tab = { id: 7, active: false, windowId: 3, url: "https://www.netflix.com/watch/81000001" };
  let documentId = "watch-document";
  chrome.tabs = {
    async get(id) {
      if (id !== tab.id) throw new Error("No tab with id");
      return { ...tab };
    },
    async sendMessage(id, message, options) {
      if (id !== tab.id || options.documentId !== documentId || message.type !== "hd_anki_document") {
        throw new Error("The document was removed.");
      }
      return { present: true };
    },
  };
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, crypto, Error, Promise });
  const anki = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic" };
  const experimental = { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.experimental, netflixMining: true };
  await storage.api().local.set({ options: { revision: 1, anki, experimental } });
  const wav = Buffer.from("RIFF\u0024\u0000\u0000\u0000WAVEfmt ", "latin1").toString("base64");
  const ask = (sender, data = wav) => bus.sendMessage("reader", { target: "hachidori-netflix", type: "hd_netflix_line_audio",
    requestId: "netflix-line-audio", data, templateId: "default" }, sender);
  const reader = { id: chrome.runtime.id, url: tab.url, frameId: 0, documentId, tab: { id: tab.id, url: tab.url } };
  const held = await ask(reader);
  const subframe = await ask({ ...reader, frameId: 2 });
  const notWav = await ask(reader, Buffer.from("GIF89a").toString("base64"));
  documentId = "replacement-document";
  const reloaded = await ask(reader);
  documentId = reader.documentId;
  tab = { ...tab, url: "https://www.netflix.com/browse" };
  const browsing = await ask(reader);
  tab = { ...tab, url: reader.url };
  await storage.api().local.set({ options: { revision: 2, anki, experimental: { ...experimental, netflixMining: false } } });
  const off = await ask(reader);
  check("the Netflix line audio is held only for the watch page's own top-frame document, with the switch on",
    held?.ok === true && /^hachidori-sentence-audio-[0-9a-f-]{36}\.wav$/u.test(held.filename ?? "")
      && /^[0-9a-f-]{36}$/u.test(held.token ?? "")
      && subframe?.ok === false && subframe.error.includes("Netflix player page")
      && notWav?.ok === false && notWav.error.includes("no WAV")
      && reloaded?.ok === false && reloaded.error.includes("page changed")
      && browsing?.ok === false && browsing.error.includes("no longer playing")
      && off?.ok === false && off.error.includes("turned off in Settings"),
    JSON.stringify({ held, subframe, notWav, reloaded, browsing, off }));
}

describe("Netflix", () => {
  test("Netflix recorder port", async () => {
    await netflixRecorderPortStage();
  });
  test("Netflix line audio", async () => {
    await netflixLineAudioStage();
  });
});
