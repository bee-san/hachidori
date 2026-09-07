// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createCaptureSession } from "../extension/capture-session.js";

const source = readFileSync(new URL("../extension/capture-host.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\n/gmu, "").replace(/^export\s/gmu, "");
const options = {
  enabled: true, historySeconds: 60, clipSeconds: 10, videoPreset: "standard",
  includeAnimation: true, includeCapturedAudio: false, timingMode: "recent", estimatedOffsetMs: -500,
  texthooker: { enabled: false, url: "", format: "plain" },
  page: { nativeCues: true, domText: true, autoLearnArea: true },
};

async function fixture() {
  const requests = [];
  const messages = [];
  const frameEncoders = [];
  const preview = { videoWidth: 640, videoHeight: 360, play: async () => {} };
  const context = vm.createContext({
    createCaptureSession, structuredClone, performance, crypto,
    createCaptureFrameEncoder: () => {
      const encoder = { closed: false, close() { this.closed = true; } };
      frameEncoders.push(encoder);
      return encoder;
    },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    document: { body: { append() {} }, createElement: type => type === "video" ? preview
      : { getContext: () => ({}) } },
    navigator: { mediaDevices: { getDisplayMedia() {
      return new Promise((resolve, reject) => requests.push({ resolve, reject }));
    } } },
    chrome: { runtime: { async sendMessage(message) {
      messages.push(message);
      return { ok: true, documentId: "host-document", mediaCapture: options };
    } } },
  });
  const handle = await vm.runInContext(`(async () => {${source}\nreturn handleCaptureMessage;})()`, context);
  const command = (type, fields = {}) => handle({ type, captureDocumentId: "host-document", ...fields });
  return { requests, messages, preview, command, frameEncoders };
}

function sharedStream() {
  const track = new EventTarget();
  track.kind = "video";
  track.stopped = false;
  track.stop = () => { track.stopped = true; };
  track.getSettings = () => ({ displaySurface: "browser" });
  return { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [], track };
}

function delayedReaderLink(host, pauseAt = "metadata") {
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const pauses = new Map();
  const hold = step => {
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const queue = pauses.get(step) ?? [];
    queue.push({ entered, gate });
    pauses.set(step, queue);
    return { waiting, release };
  };
  const firstPause = hold(pauseAt);
  const readers = new Set();
  const pause = async step => {
    const next = pauses.get(step)?.shift();
    if (next) { next.entered(); await next.gate; }
  };
  const context = vm.createContext({
    OPTIONS_KEY: "options", CAPTURE_PAGE_TARGET: "hachidori-capture-page",
    CAPTURE_CONTENT_TARGET: "hachidori-capture-content",
    CAPTURE_CONTENT_TYPES: new Set(["hd_capture_content_identify"]),
    capturePage: { documentId: "host-document" }, captureContentDocument: null, captureLink: null,
    HDReaderOptions: { projectContentOptions: () => ({ mediaCapture: options }) },
    assertCaptureTabId: tabId => assert.ok([7, 8].includes(tabId)), shortCaptureString: value => typeof value === "string" && value.length > 0,
    chrome: { storage: { local: { get: async () => { await pause("storage"); return { options }; } } },
      runtime: { id: "hachidori", sendMessage: message => host.command(message.type, message) },
      tabs: {
        get: async () => {
          await pause("metadata");
          return { title: "Reader", url: "https://reader.example" };
        },
        sendMessage: async (tabId, message, identity) => {
          assert.equal(message.type, "hd_capture_unlink");
          assert.equal(identity.documentId, `reader-document-${tabId}`);
          readers.delete(tabId);
        },
      },
    },
    unlinkCaptureContent: async () => {
      readers.delete(context.captureContentDocument?.tabId);
      context.captureContentDocument = null;
    },
    commandCaptureContent: async (tabId, _type, fields) => {
      await pause("identify");
      await context.handleCaptureContent({ type: "hd_capture_content_identify", captureSessionId: fields.captureSessionId },
        { id: "hachidori", tab: { id: tabId }, frameId: 0, documentId: `reader-document-${tabId}` });
      readers.add(tabId);
      return { videos: [] };
    },
    relayCapture: message => host.command(message.type, message),
  });
  vm.runInContext(background.slice(background.indexOf("function assertCurrentCaptureLink("),
    background.indexOf("async function handleCaptureHostMessage(")) + "\n" +
    background.slice(background.indexOf("async function handleCaptureContent("),
      background.indexOf("function assertCaptureLookup(")), context);
  return { ...firstPause, hold, context, readerLinked: tabId => readers.has(tabId),
    link: (tabId = 7) => context.linkCapturePage({ tabId, requestId: "delayed-reader-link" }) };
}

test("Stop retires an outstanding picker and stops its late stream without starting a session", async () => {
  const f = await fixture();
  const pending = f.command("hd_capture_start");
  assert.equal((await f.command("hd_capture_status")).starting, true);
  await assert.rejects(f.command("hd_capture_start"), /already being selected/u);
  await f.command("hd_capture_stop");
  const late = sharedStream();
  f.requests[0].resolve(late);
  await pending;
  const status = await f.command("hd_capture_status");
  assert.equal(status.state, "stopped");
  assert.equal(status.captureSessionId, "");
  assert.equal(late.track.stopped, true);
  assert.equal(f.preview.srcObject, null);
});

test("settings changes cancel a pending picker and an older picker cannot replace the next session", async () => {
  const f = await fixture();
  const first = f.command("hd_capture_start");
  await f.command("hd_capture_configure", { mediaCapture: { ...options, clipSeconds: 5 } });
  const second = f.command("hd_capture_start");
  const current = sharedStream();
  f.requests[1].resolve(current);
  const started = await second;
  const late = sharedStream();
  f.requests[0].resolve(late);
  await first;
  const status = await f.command("hd_capture_status");
  assert.equal(status.state, "recording");
  assert.equal(status.captureSessionId, started.captureSessionId);
  assert.equal(status.config.clipSeconds, 5);
  assert.equal(f.preview.srcObject, current);
  assert.equal(late.track.stopped, true);
  assert.equal(current.track.stopped, false);
  await f.command("hd_capture_stop");
});

test("a reader link finishing after Stop cannot restore its binding or enter a replacement session", async () => {
  for (const pauseAt of ["storage", "identify", "metadata"]) {
    for (const replacement of ["none", "unlinked", "same-page", "different-page"]) {
      const host = await fixture();
      const starting = host.command("hd_capture_start");
      host.requests[0].resolve(sharedStream());
      await starting;
      const reader = delayedReaderLink(host, pauseAt);
      const pending = reader.link();
      await reader.waiting;
      await host.command("hd_capture_stop");
      if (replacement !== "none") {
        const restarting = host.command("hd_capture_start");
        host.requests[1].resolve(sharedStream());
        await restarting;
      }
      const replacementTab = replacement === "same-page" ? 7 : replacement === "different-page" ? 8 : null;
      if (replacementTab) await reader.link(replacementTab);
      reader.release();
      await assert.rejects(pending, /capture session changed|not being linked/u);
      const status = await host.command("hd_capture_status");
      assert.equal(status.state, replacement === "none" ? "stopped" : "recording");
      const replacementDocument = replacementTab ? `reader-document-${replacementTab}` : null;
      assert.equal(status.linkedPage?.documentId ?? null, replacementDocument, `${pauseAt}/${replacement}: host`);
      assert.equal(reader.context.captureContentDocument?.documentId ?? null, replacementDocument, `${pauseAt}/${replacement}: routing`);
      assert.equal(reader.readerLinked(7), replacementTab === 7, `${pauseAt}/${replacement}: old collector`);
      assert.equal(reader.readerLinked(8), replacementTab === 8, `${pauseAt}/${replacement}: new collector`);
      await host.command("hd_capture_stop");
    }
    }
});

test("an older same-session link cannot unlink a newer same-page collector, even before host admission", async () => {
  for (const pauseAt of [null, "storage", "identify", "metadata"]) {
    const host = await fixture();
    const starting = host.command("hd_capture_start");
    host.requests[0].resolve(sharedStream());
    await starting;
    const reader = delayedReaderLink(host);
    const first = reader.link();
    await reader.waiting;
    const gate = pauseAt ? reader.hold(pauseAt) : null;
    const second = reader.link();
    if (gate) await gate.waiting;
    else await second;
    reader.release();
    await assert.rejects(first, /capture session changed/u);
    if (!pauseAt || pauseAt === "metadata") {
      assert.equal(reader.context.captureContentDocument?.documentId, "reader-document-7");
      assert.equal(reader.readerLinked(7), true);
    }
    gate?.release();
    await second;
    assert.equal(reader.context.captureContentDocument?.documentId, "reader-document-7");
    assert.equal(reader.readerLinked(7), true);
    assert.equal((await host.command("hd_capture_status")).linkedPage.documentId, "reader-document-7");
    await host.command("hd_capture_stop");
  }
});

test("reader linking requires the active capture session before starting a collector", async () => {
  const reader = delayedReaderLink(await fixture());
  await assert.rejects(reader.link(), /Start capture before linking/u);
  assert.equal(reader.readerLinked(7), false);
  assert.equal(reader.context.captureContentDocument, null);
});

test("source loss closes host tracks and clears the linked reader without a controls page", async () => {
  const f = await fixture();
  const pending = f.command("hd_capture_start");
  const shared = sharedStream();
  f.requests[0].resolve(shared);
  const started = await pending;
  await f.command("hd_capture_linked", {
    captureSessionId: (await f.command("hd_capture_status")).captureSessionId,
    page: { tabId: 7, documentId: "reader-document", title: "Reader", url: "https://reader.example", videos: [] },
  });
  shared.track.dispatchEvent(new Event("mute"));
  const status = await f.command("hd_capture_status");
  assert.equal(status.state, "stopped");
  assert.equal(status.linkedPage, null);
  assert.equal(shared.track.stopped, true);
  assert.match(status.error, /became unavailable/u);
  assert.equal(f.frameEncoders[0].closed, true);
  assert.ok(f.messages.some(message => message.type === "hd_capture_host_stopped"
    && message.captureDocumentId === "host-document"
    && message.captureSessionId === started.captureSessionId
    && message.linkedPage.tabId === 7 && message.linkedPage.documentId === "reader-document"));
});

test("only the background worker may dispatch capture Start to the offscreen host", async () => {
  const offscreen = readFileSync(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  const start = offscreen.indexOf("chrome.runtime.onMessage.addListener");
  const end = offscreen.indexOf("\n});", start) + "\n});".length;
  let listener;
  const calls = [];
  vm.runInNewContext(offscreen.slice(start, end), {
    captureService: Promise.resolve({ handleCaptureMessage(message) { calls.push(message); return { state: "recording" }; } }),
    chrome: { runtime: { id: "hachidori", getURL: file => `chrome-extension://hachidori/${file}`,
      onMessage: { addListener(value) { listener = value; } } } },
  });
  const message = { target: "hachidori-capture-page", relayed: true,
    type: "hd_capture_start", captureDocumentId: "known-host-document" };
  for (const sender of [
    { id: "hachidori", url: "https://reader.example/", tab: { id: 7 } },
    { id: "hachidori", url: "chrome-extension://hachidori/capture.html", tab: { id: 8 } },
    { id: "hachidori", url: "chrome-extension://hachidori/background.js", tab: { id: 9 } },
    { id: "another-extension", url: "chrome-extension://hachidori/background.js" },
  ]) assert.equal(listener(message, sender, () => assert.fail("untrusted capture request was answered")), false);
  assert.equal(calls.length, 0);
  const reply = await new Promise(resolve => {
    assert.equal(listener(message, { id: "hachidori", url: "chrome-extension://hachidori/background.js" }, resolve), true);
  });
  assert.equal(calls.length, 1);
  assert.equal(reply.state, "recording");
});
