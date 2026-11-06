/*
 * Experimental YouTube mining: the recorder port, the line audio request, the
 * YouTube scripts for a page open before the switch went on, and the video
 * frame {screenshot} takes on YouTube.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
import { loadBackgroundScript, makeBus, makeChrome, makeEvent, makeStorage } from "./fakes.mjs";
import { check, test } from "./harness.mjs";
import { captureYouTubeFrame } from "../../extension/youtube-frame.js";

const WATCH = "https://www.youtube.com/watch?v=Ab3dEf6hI9k";
const flags = (on, extra = {}) => ({ ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.experimental, youtubeMining: on, ...extra });

// Only the extension's own YouTube recorder page, framed in a YouTube tab,
// keeps its port, and only while YouTube mining is on: Netflix's switch and
// Netflix's recorder page do not count.
async function youtubeRecorderPortStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("youtube-recorder", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  chrome.runtime.sendMessage = () => Promise.resolve({ ok: true });
  loadBackgroundScript({ chrome, console, clearTimeout, setTimeout, Promise, Error });
  const tab = { id: 7, url: WATCH };
  const connect = (sender, name = "hachidori-youtube-recorder") => {
    const port = { name, sender, onMessage: makeEvent(), onDisconnect: makeEvent(),
      disconnected: false, disconnect() { this.disconnected = true; this.onDisconnect.fire(); } };
    chrome.__events.onConnect.fire(port);
    return port;
  };
  const recorder = { id: chrome.runtime.id, url: chrome.runtime.getURL("youtube-recorder.html"), frameId: 3, tab };
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await chrome.storage.local.set({ options: { revision: 1, experimental: flags(false, { netflixMining: true }) } });
  const netflixOnly = connect(recorder);
  await settle();
  const refusedWithNetflixOnly = netflixOnly.disconnected;
  await chrome.storage.local.set({ options: { revision: 2, experimental: flags(true) } });
  // Each refused port is read before a later port for the same tab, which
  // would replace one that was kept, connects.
  const refused = {};
  for (const [name, sender, portName] of [
    ["netflixPage", { ...recorder, url: chrome.runtime.getURL("netflix-recorder.html") }],
    ["topFrame", { ...recorder, frameId: 0 }],
    ["elsewhere", { ...recorder, tab: { id: 7, url: "https://m.youtube.com/watch?v=Ab3dEf6hI9k" } }],
    ["wrongPort", recorder, "hachidori-netflix-recorder"],
  ]) {
    const port = connect(sender, portName);
    await settle();
    refused[name] = port.disconnected;
  }
  const on = connect(recorder);
  // In the miniplayer the player plays on another page of the site.
  const miniplayer = connect({ ...recorder, tab: { id: 8, url: "https://www.youtube.com/feed/subscriptions" } });
  await settle();
  check("the YouTube recorder port is kept only for YouTube's recorder page framed in a YouTube tab while YouTube mining is on",
    refusedWithNetflixOnly && Object.values(refused).every(Boolean) && !on.disconnected && !miniplayer.disconnected,
    JSON.stringify({ refusedWithNetflixOnly, refused, on: on.disconnected, miniplayer: miniplayer.disconnected }));
}

// A {gif} recording forwards to the recorder the part of the tab the reader
// asked for when it fits in the tab, and drops one that does not.
async function youtubeCropStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("youtube-crop", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  const tab = { id: 7, active: true, windowId: 3, url: WATCH };
  chrome.tabs = {
    async get(id) { if (id !== tab.id) throw new Error("No tab with id"); return { ...tab }; },
    async sendMessage() { return { present: true }; },
  };
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, crypto, Error, Promise });
  await storage.api().local.set({ options: { revision: 1, experimental: flags(true) } });
  const recorded = [];
  // The recorder frame: it answers each record request as the real one does.
  const connectRecorder = () => {
    const port = { name: "hachidori-youtube-recorder", onMessage: makeEvent(), onDisconnect: makeEvent(), disconnected: false,
      sender: { id: chrome.runtime.id, url: chrome.runtime.getURL("youtube-recorder.html"), frameId: 3, tab },
      disconnect() { this.disconnected = true; this.onDisconnect.fire(); },
      postMessage(message) {
        recorded.push(message);
        if (message.type === "record") queueMicrotask(() => port.onMessage.fire({ type: "started", padMs: 250 }));
      } };
    chrome.__events.onConnect.fire(port);
    return port;
  };
  const reader = { id: chrome.runtime.id, url: WATCH, frameId: 0, documentId: "watch-document", tab: { id: tab.id, url: WATCH } };
  const start = crop => bus.sendMessage("reader", { target: "hachidori-youtube", type: "hd_youtube_capture_start",
    requestId: "youtube-crop", cue: { movieId: "Ab3dEf6hI9k", startMs: 2000, endMs: 4200 }, audio: false, gif: true, crop },
  reader);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const crop = { left: 0.125, top: 0.125, width: 0.625, height: 0.5, aspect: 16 / 9 };
  connectRecorder();
  await settle();
  const fits = await start(crop);
  connectRecorder();
  await settle();
  const outside = await start({ ...crop, width: 0.9 });
  const records = recorded.filter(message => message.type === "record");
  check("a YouTube GIF recording forwards a crop that fits in the tab to the recorder and drops one that does not",
    fits?.ok === true && typeof fits.sessionId === "string" && outside?.ok === true && records.length === 2
      && JSON.stringify(records[0].crop) === JSON.stringify(crop) && !Object.hasOwn(records[1], "crop")
      && records.every(record => record.gif === true && record.audio === false && record.targetTabId === 7),
    JSON.stringify({ fits, outside, records }));
}

// The WAV the YouTube page cut from what the viewer heard is held for that
// top-frame YouTube document only, with YouTube mining on.
async function youtubeLineAudioStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("youtube-line-audio", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  let tab = { id: 7, active: false, windowId: 3, url: WATCH };
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
  await storage.api().local.set({ options: { revision: 1, anki, experimental: flags(true) } });
  const wav = Buffer.from("RIFF\u0024\u0000\u0000\u0000WAVEfmt ", "latin1").toString("base64");
  const ask = (sender, type = "hd_youtube_line_audio", target = "hachidori-youtube") => bus.sendMessage("reader",
    { target, type, requestId: "youtube-line-audio", data: wav, templateId: "default" }, sender);
  const reader = { id: chrome.runtime.id, url: tab.url, frameId: 0, documentId, tab: { id: tab.id, url: tab.url } };
  const held = await ask(reader);
  const subframe = await ask({ ...reader, frameId: 2 });
  // Netflix's request and target are Netflix's switch's.
  const asNetflix = await ask(reader, "hd_netflix_line_audio", "hachidori-netflix");
  const wrongTarget = await ask(reader, "hd_netflix_line_audio");
  tab = { ...tab, url: "https://www.netflix.com/watch/81000001" };
  const leftYouTube = await ask(reader);
  tab = { ...tab, url: "https://www.youtube.com/" };
  const miniplayer = await ask(reader);
  documentId = "replacement-document";
  const reloaded = await ask(reader);
  documentId = reader.documentId;
  await storage.api().local.set({ options: { revision: 2, anki, experimental: flags(false, { netflixMining: true }) } });
  const off = await ask(reader);
  check("the YouTube line audio is held only for a YouTube page's own top-frame document, with YouTube mining on",
    held?.ok === true && /^hachidori-sentence-audio-[0-9a-f-]{36}\.wav$/u.test(held.filename ?? "")
      && subframe?.ok === false && subframe.error.includes("YouTube player page")
      && asNetflix?.ok === false && asNetflix.error.includes("Netflix mining is turned off")
      && wrongTarget?.ok === false && wrongTarget.error.includes("Unknown YouTube request")
      && leftYouTube?.ok === false && leftYouTube.error.includes("no longer showing YouTube")
      && miniplayer?.ok === true
      && reloaded?.ok === false && reloaded.error.includes("page changed")
      && off?.ok === false && off.error.includes("YouTube mining is turned off in Settings"),
    JSON.stringify({ held, subframe, asNetflix, wrongTarget, leftYouTube, miniplayer, reloaded, off }));
}

// A YouTube page open before the switch went on gets the YouTube scripts in
// its own top-frame document, as youtube.js registers them.
async function youtubeLoadStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("youtube-load", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  const injected = [];
  chrome.scripting = { executeScript: async injection => { injected.push(JSON.parse(JSON.stringify(injection))); return [{}]; } };
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, crypto, Error, Promise });
  await storage.api().local.set({ options: { revision: 1, experimental: flags(true) } });
  const ask = sender => bus.sendMessage("reader", { target: "hachidori-youtube", type: "hd_youtube_load",
    requestId: "youtube-load" }, sender);
  const reader = { id: chrome.runtime.id, url: WATCH, frameId: 0, documentId: "youtube-document", tab: { id: 7, url: WATCH } };
  const loaded = await ask(reader);
  const scripts = injected.splice(0);
  const refused = [await ask({ ...reader, frameId: 2 }), await ask({ ...reader, url: "https://www.youtube-nocookie.com/embed/x" }),
    await ask({ ...reader, url: "https://www.netflix.com/browse" })];
  await storage.api().local.set({ options: { revision: 2, experimental: flags(false) } });
  const off = await ask(reader);
  const target = { tabId: 7, documentIds: ["youtube-document"] };
  check("a YouTube page open before the switch went on gets the YouTube scripts in its own document, with the switch on",
    loaded?.ok === true && JSON.stringify(scripts) === JSON.stringify([
      { target, files: ["netflix-page.js"], world: "MAIN" },
      { target, files: ["netflix-subtitles.js", "netflix-audio.js", "netflix-content.js", "youtube-content.js"],
        world: "ISOLATED" }])
      && refused.every(reply => reply?.ok === false && reply.error.includes("Only a YouTube page"))
      && off?.ok === false && off.error.includes("turned off in Settings") && injected.length === 0,
    JSON.stringify({ loaded, scripts, refused, off, injected }));
}

// With YouTube mining on, {screenshot} for a note from a caption on a YouTube
// page is the frame its player shows, read in the exact top-frame document; a
// note from other text, a player that shows no frame, a subframe and the
// switch off keep the viewport capture.
async function youtubeFrameStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("youtube-frame", bus, storage);
  const captures = [];
  const injections = [];
  const tab = { id: 7, active: true, url: WATCH, windowId: 3 };
  const documentId = "watch-document";
  chrome.tabs = {
    async get(id) { if (id !== tab.id) throw new Error("No tab with id"); return { ...tab }; },
    async sendMessage(id, message, options) {
      if (id !== tab.id || options.documentId !== documentId) throw new Error("The document was removed.");
      return { present: true };
    },
    async captureVisibleTab(windowId, options) { captures.push({ windowId, options }); return "data:image/jpeg;base64,c2hvdA=="; },
  };
  let frameResult = { dataUrl: "data:image/jpeg;base64,/9j/4AAQ/9k=" };
  let otherDocument = false;
  chrome.scripting = { executeScript: async injection => {
    injections.push(injection);
    return [{ frameId: 0, documentId: otherDocument ? "replacement-document" : documentId, result: frameResult }];
  } };
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, AbortController, crypto, Error, Promise });
  const anki = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic" };
  const ask = (sender, videoFrame = true) => bus.sendMessage("reader", { target: "hachidori-anki", type: "hd_anki_screenshot",
    requestId: "youtube-frame", ...(videoFrame ? { videoFrame: true } : {}) }, sender);
  const reader = { id: chrome.runtime.id, url: WATCH, frameId: 0, documentId, tab: { id: tab.id, url: WATCH } };
  await storage.api().local.set({ options: { revision: 1, anki, experimental: flags(false) } });
  const switchedOff = await ask(reader);
  const offInjections = injections.length;
  await storage.api().local.set({ options: { revision: 2, anki, experimental: flags(true) } });
  const capturesBefore = captures.length;
  const frame = await ask(reader);
  const afterFrame = captures.length;
  const [injected] = injections;
  frameResult = { none: true };
  const noPicture = await ask(reader);
  const afterNoPicture = captures.length;
  frameResult = { error: "YouTube video frame: the video's picture could not be read." };
  const unreadable = await ask(reader);
  frameResult = { dataUrl: "data:image/png;base64,c2hvdA==" };
  const notJpeg = await ask(reader);
  frameResult = { dataUrl: "data:image/jpeg;base64,/9j/4AAQ/9k=" };
  otherDocument = true;
  const fromOtherDocument = await ask(reader);
  otherDocument = false;
  const beforeSubframe = injections.length;
  const subframe = await ask({ ...reader, frameId: 1 });
  const otherText = await ask(reader, false);
  check("YouTube mining's {screenshot} for a caption note is the video's frame from the exact top-frame document, else the viewport",
    switchedOff?.ok === true && offInjections === 0 && afterFrame === capturesBefore
      && frame?.ok === true && /^hachidori-screenshot-[0-9a-f-]{36}\.jpg$/u.test(frame.filename ?? "")
      && injected.func === captureYouTubeFrame && injected.world === undefined
      && injected.target.tabId === tab.id && injected.target.documentIds.join() === documentId
      && injected.args[0] === WATCH
      && noPicture?.ok === true && afterNoPicture === capturesBefore + 1
      && unreadable?.ok === false && unreadable.error.includes("could not be read")
      && notJpeg?.ok === false && notJpeg.error.includes("no JPEG image")
      && fromOtherDocument?.ok === false && fromOtherDocument.error.includes("reading document changed")
      && subframe?.ok === true && otherText?.ok === true && injections.length === beforeSubframe
      && captures.length === capturesBefore + 3,
    JSON.stringify({ switchedOff, frame, noPicture, unreadable, notJpeg, fromOtherDocument, subframe, otherText,
      captures: captures.length,
      capturesBefore, injections: injections.length, world: injected?.world, target: injected?.target }));
}

// The reader's side: on a YouTube page without the YouTube scripts it asks
// once when YouTube mining is on, then follows the switch with them; with
// only Netflix mining on, or elsewhere, it never asks.
async function youtubeLoadCase() {
  const loads = harness => harness.sent.filter(request => request.type === "hd_youtube_load").map(request => request.target);
  const harness = await createHarness(undefined, { url: WATCH, options: { experimental: flags(false, { netflixMining: true }) } });
  const window = harness.popup.ownerDocument.defaultView;
  const netflixOnly = loads(harness).length + harness.sent.filter(request => request.type === "hd_netflix_load").length;
  harness.emitOptions({ experimental: flags(true) });
  const asked = loads(harness);
  const calls = [];
  window.HDYouTube = { setHoverPause: value => calls.push(["hover", value]), setLineAudio: value => calls.push(["audio", value]),
    setSubtitleDragging: value => calls.push(["drag", value]), setSubtitleLanguage: value => calls.push(["language", value]),
    miningFields: () => ({}), observe: () => null };
  harness.reply(harness.take("hd_youtube_load"), { loaded: true });
  await harness.settle();
  const followed = JSON.stringify(calls) === JSON.stringify([["hover", true], ["audio", true], ["drag", true]]);
  harness.emitOptions({ experimental: flags(false) });
  const off = JSON.stringify(calls.slice(3)) === JSON.stringify([["hover", false], ["audio", false], ["drag", false]]);
  harness.close();
  return {
    "a YouTube page open before YouTube mining went on asks once for the YouTube scripts and follows the switch with them":
      netflixOnly === 0 && JSON.stringify(asked) === JSON.stringify(["hachidori-youtube"]) && followed && off
      || { netflixOnly, asked, calls },
  };
}

// A stand-in for YouTube's reader (youtube-content.js), whose captions are in
// the language `language` names.
function youtubeReader(language = () => null) {
  return { setHoverPause() {}, setLineAudio() {}, setSubtitleDragging() {}, miningFields: () => ({}), observe: () => null,
    captionLanguage: language };
}

// A YouTube caption window in YouTube's markup, two rows of ten-pixel
// characters at y 10-30 and 40-60, and the control bar over all of it, as
// YouTube's auto-hidden control bar and its miniplayer's scrim lie over its
// captions: the hit test and the caret find the bar, never the caption. With
// `label`, text lies over the second row's べた (x 10-30): in the bar, as its
// time display or chapter title can, or in a menu of the player's (`menu`).
function coveredCaption(window, { label = null, menu = false } = {}) {
  const { document } = window;
  const player = document.createElement("div");
  player.id = "movie_player";
  const labelled = label === null ? "" : `<span>${label}</span>`;
  player.innerHTML = '<div class="ytp-caption-window-container"><div class="caption-window"><span class="captions-text">'
    + '<span class="caption-visual-line"><span class="ytp-caption-segment">朝ごはんを</span></span>'
    + '<span class="caption-visual-line"><span class="ytp-caption-segment">食べたかった</span></span></span></div></div>'
    + `<div class="ytp-chrome-bottom">${menu ? "" : labelled}</div><div class="ytp-settings-menu">${menu ? labelled : ""}</div>`;
  document.body.append(player);
  const [first, second] = player.querySelectorAll(".ytp-caption-segment");
  const cover = player.querySelector(".ytp-chrome-bottom");
  const labelText = player.querySelector(":is(.ytp-chrome-bottom, .ytp-settings-menu) span")?.firstChild ?? null;
  window.Range.prototype.getClientRects = function () {
    const node = this.startContainer;
    // A range over a whole caption window has its two rows.
    if (node.nodeType !== window.Node.TEXT_NODE) return [{ left: 0, right: 50, top: 10, bottom: 30 }, { left: 0, right: 60, top: 40, bottom: 60 }];
    const left = node === labelText ? 10 : 0;
    const top = node.parentElement === first ? 10 : 40;
    return [{ left: left + this.startOffset * 10, right: left + this.endOffset * 10, top, bottom: top + 20 }];
  };
  const overLabel = (x, y) => labelText !== null && x >= 10 && x <= 10 + label.length * 10 && y >= 40 && y <= 60;
  document.elementFromPoint = (x, y) => (overLabel(x, y) ? labelText.parentElement : cover);
  document.caretRangeFromPoint = (x, y) => {
    const range = document.createRange();
    if (overLabel(x, y)) range.setStart(labelText, Math.floor((x - 10) / 10));
    else range.setStart(cover, 0);
    return range;
  };
  return { first, second };
}

// YouTube's control bar and miniplayer scrim lie over its captions, which are
// scanned from the glyph under the pointer as Netflix's are (#662), while
// YouTube mining is on; off, YouTube is as before.
async function youtubeCoveredCaptionCase() {
  const scan = async (on, fixture = {}) => {
    const harness = await createHarness(undefined, { url: WATCH, options: { experimental: flags(on) } });
    harness.window.HDYouTube = youtubeReader();
    const caption = coveredCaption(harness.window, fixture);
    const at = (x, y) => harness.driver.resolveCandidate(x, y);
    const result = { covered: at(15, 50), gap: at(15, 35), caption }; // Over the second row's べ, and between the rows.
    harness.close();
    return result;
  };
  const on = await scan(true);
  const off = await scan(false);
  // Text over べ: the bar's own, a menu's, and the bar's with the switch off.
  const bar = await scan(true, { label: "読む" });
  const menu = await scan(true, { label: "読む", menu: true });
  const barOff = await scan(false, { label: "読む" });
  return {
    "a YouTube caption under the player's control bar is scanned from the glyph under the pointer while YouTube mining is on, and not while it is off":
      (on.covered?.query.startsWith("べたかった") && on.caption.second.contains(on.covered.anchor) && on.gap === null && off.covered === null)
      || { query: on.covered?.query ?? null, gap: on.gap?.query ?? null, switchedOff: off.covered?.query ?? null },
    "a YouTube caption outranks the control bar's own text over it, while a menu's text over it comes first, and with the switch off the bar's":
      (bar.covered?.query.startsWith("べたかった") && bar.caption.second.contains(bar.covered.anchor)
        && menu.covered?.query === "読む" && barOff.covered?.query === "読む")
      || { bar: bar.covered?.query ?? null, menu: menu.covered?.query ?? null, switchedOff: barOff.covered?.query ?? null },
  };
}

// With Switch language automatically on, a lookup in a caption takes the
// profile of the caption track's language (docs/languages.md 8.5), which
// YouTube's markup does not carry for a typed track: the page itself names its
// interface language, English here.
async function youtubeCaptionProfileCase() {
  const profiles = [{ id: "ja", language: "ja", settings: {}, packSettings: {} },
    { id: "en", language: "en", settings: {}, packSettings: {} }];
  const harness = await createHarness(undefined, { url: WATCH, options: { experimental: flags(true), profiles } });
  const { window } = harness;
  window.document.documentElement.lang = "en";
  harness.emitChanges({ languageSelection: { newValue: { revision: 1, activeProfileId: "ja", autoSwitch: true } } });
  window.HDYouTube = youtubeReader(element => (element?.closest?.(".ytp-caption-window-container") ? "ja" : null));
  const caption = coveredCaption(window);
  const inCaption = harness.driver.resolveCandidate(15, 50);
  harness.close();
  return {
    "with automatic switching, a YouTube caption is looked up in its track's language, not the page's":
      (inCaption?.profile?.id === "ja" && caption.second.contains(inCaption.anchor))
      || { profile: inCaption?.profile?.id ?? null, query: inCaption?.query ?? null },
  };
}

describe("YouTube", () => {
  test("YouTube recorder port", async () => {
    await youtubeRecorderPortStage();
  });
  test("YouTube line audio", async () => {
    await youtubeLineAudioStage();
  });
  test("YouTube scripts for an open page", async () => {
    await youtubeLoadStage();
    const reader = await contentNoteStage({ youtube: youtubeLoadCase });
    for (const [name, passed] of Object.entries(reader?.youtube ?? { "the reader's YouTube load ran": false })) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });
  test("YouTube video frame screenshots", async () => {
    await youtubeFrameStage();
  });
  test("YouTube GIF crop", async () => {
    await youtubeCropStage();
  });
  test("YouTube captions under the player's controls, and their track's language", async () => {
    const reader = await contentNoteStage({ covered: youtubeCoveredCaptionCase, profile: youtubeCaptionProfileCase });
    for (const [name, passed] of Object.entries({ ...reader?.covered, ...reader?.profile }
      ?? { "the reader's caption cases ran": false })) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });
});
