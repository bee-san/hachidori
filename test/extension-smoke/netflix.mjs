/*
 * Experimental Netflix mining: the recorder port, the line audio request, and
 * the Netflix scripts for a page open before the switch went on.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
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

// Experimental Netflix mining: a Netflix page that was open before the switch
// went on gets the Netflix scripts in its own top-frame document, as netflix.js
// registers them, and only while the switch is on.
async function netflixLoadStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("netflix-load", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  const injected = [];
  chrome.scripting = { executeScript: async injection => { injected.push(JSON.parse(JSON.stringify(injection))); return [{}]; } };
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, crypto, Error, Promise });
  const experimental = { ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.experimental, netflixMining: true };
  await storage.api().local.set({ options: { revision: 1, experimental } });
  const ask = sender => bus.sendMessage("reader", { target: "hachidori-netflix", type: "hd_netflix_load",
    requestId: "netflix-load" }, sender);
  const browse = "https://www.netflix.com/browse";
  const reader = { id: chrome.runtime.id, url: browse, frameId: 0, documentId: "netflix-document", tab: { id: 7, url: browse } };
  const loaded = await ask(reader);
  const scripts = injected.splice(0);
  const refused = [await ask({ ...reader, frameId: 2 }), await ask({ ...reader, url: "https://example.test/" }),
    await ask({ ...reader, documentId: undefined })];
  await storage.api().local.set({ options: { revision: 2, experimental: { ...experimental, netflixMining: false } } });
  const off = await ask(reader);
  const target = { tabId: 7, documentIds: ["netflix-document"] };
  check("a Netflix page open before the switch went on gets the Netflix scripts in its own document, with the switch on",
    loaded?.ok === true && JSON.stringify(scripts) === JSON.stringify([
      { target, files: ["netflix-page.js"], world: "MAIN" },
      { target, files: ["netflix-subtitles.js", "netflix-audio.js", "netflix-content.js"], world: "ISOLATED" }])
      && refused.every(reply => reply?.ok === false && reply.error.includes("Only a Netflix page"))
      && off?.ok === false && off.error.includes("turned off in Settings") && injected.length === 0,
    JSON.stringify({ loaded, scripts, refused, off, injected }));
}

// The reader's side: on a Netflix page without netflix-content.js it asks
// once when the switch is on, then follows the switch through the scripts it
// got; elsewhere, with the switch off or with the scripts there, it asks nothing.
async function netflixLoadCase() {
  const { DEFAULT_OPTIONS } = globalThis.HDReaderOptions;
  const on = { ...DEFAULT_OPTIONS.experimental, netflixMining: true };
  const off = DEFAULT_OPTIONS.experimental;
  const loads = harness => harness.sent.filter(request => request.type === "hd_netflix_load")
    .map(request => request.target);
  const harness = await createHarness(undefined, { url: "https://www.netflix.com/watch/81000001" });
  const window = harness.popup.ownerDocument.defaultView;
  const offAsked = loads(harness).length;
  harness.emitOptions({ experimental: on });
  harness.emitOptions({ experimental: on, maxResults: 5 });
  const asked = loads(harness);
  // A load that fails is asked for again with the next options.
  harness.reply(harness.take("hd_netflix_load"), { error: "No document with id" }, false);
  await harness.settle();
  harness.emitOptions({ experimental: on, maxResults: 6 });
  const retried = loads(harness).length;
  // The worker added the scripts: netflix-content.js publishes HDNetflix.
  const calls = [];
  window.HDNetflix = { setHoverPause: value => calls.push(["hover", value]), setLineAudio: value => calls.push(["audio", value]),
    miningFields: () => ({}), observe: () => null };
  harness.reply(harness.take("hd_netflix_load"), { loaded: true });
  await harness.settle();
  const followedOn = JSON.stringify(calls) === JSON.stringify([["hover", true], ["audio", true]]);
  harness.emitOptions({ experimental: off });
  harness.emitOptions({ experimental: on, maxResults: 7 });
  const followed = followedOn && JSON.stringify(calls.slice(2)) === JSON.stringify([["hover", false], ["audio", false],
    ["hover", true], ["audio", true]]) && loads(harness).length === 2;
  harness.close();
  // Opened with the switch already on, it asks at once; elsewhere it never does.
  const opened = await createHarness(undefined, { url: "https://www.netflix.com/browse", options: { experimental: on } });
  const openedAsked = loads(opened).length;
  opened.close();
  const elsewhere = await createHarness(undefined, { url: "https://example.test/", options: { experimental: on } });
  const elsewhereAsked = loads(elsewhere).length;
  elsewhere.close();
  return {
    "a Netflix page open before the switch went on asks once for the Netflix scripts and follows the switch with them":
      offAsked === 0 && JSON.stringify(asked) === JSON.stringify(["hachidori-netflix"]) && retried === 2 && followed
      || { offAsked, asked, retried, calls },
    "a page opened with the switch on asks at once, and other sites never ask": openedAsked === 1 && elsewhereAsked === 0
      || { openedAsked, elsewhereAsked },
  };
}

describe("Netflix", () => {
  test("Netflix recorder port", async () => {
    await netflixRecorderPortStage();
  });
  test("Netflix line audio", async () => {
    await netflixLineAudioStage();
  });
  test("Netflix scripts for an open page", async () => {
    await netflixLoadStage();
    const reader = await contentNoteStage({ netflix: netflixLoadCase });
    for (const [name, passed] of Object.entries(reader?.netflix ?? { "the reader's Netflix load ran": false })) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });
});
