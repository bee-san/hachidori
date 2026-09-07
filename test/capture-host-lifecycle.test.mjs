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

test("source loss closes host tracks and clears the linked reader without a controls page", async () => {
  const f = await fixture();
  const pending = f.command("hd_capture_start");
  const shared = sharedStream();
  f.requests[0].resolve(shared);
  const started = await pending;
  await f.command("hd_capture_linked", {
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
