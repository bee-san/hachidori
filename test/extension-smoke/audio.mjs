/*
 * The worker's audio relay.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { loadBackgroundScript, makeBus, makeChrome, makeStorage } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function audioRelayStage() {
  const bus = makeBus();
  const storage = makeStorage();
  const chrome = makeChrome("audio-worker", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  const sent = [];
  const backoffs = [];
  // Keep failing until the relay has scheduled its backoff: an optimistic send
  // to a previously answering document retries once immediately.
  let failing = true;
  chrome.runtime.sendMessage = async message => {
    if (message.type === "hd_audio_test" && failing) {
      throw new Error("Receiving end does not exist");
    }
    sent.push(message);
    return { ok: true, status: message.type === "hd_audio_stop" ? "cancelled" : "success" };
  };
  loadBackgroundScript({ chrome, console, URL, clearTimeout, Promise, Error,
    setTimeout: resolve => { backoffs.push(resolve); } });
  const send = (type, requestId, extra = {}, documentId = "settings-a") => bus.sendMessage("audio-settings", {
    target: "hachidori-audio", type, requestId, ...extra,
  }, { id: chrome.runtime.id, documentId });
  const source = { id: "tts", type: "text-to-speech-reading", enabled: true, url: "", voice: "" };
  async function reachBackoff() {
    for (let i = 0; i < 20 && backoffs.length === 0; i++) await Promise.resolve();
    if (!backoffs.length) throw new Error("Audio relay never reached the startup retry");
    failing = false;
  }
  const stopped = send("hd_audio_test", "stopped", { source });
  await reachBackoff();
  await send("hd_audio_stop", "stop", { playRequestId: "stopped" });
  backoffs.shift()();
  const stoppedReply = await stopped;
  failing = true;
  const old = send("hd_audio_test", "old", { source });
  await reachBackoff();
  const current = await send("hd_audio_test", "current", { source, owner: "spoofed" }, "settings-b");
  backoffs.shift()();
  const oldReply = await old;
  check("Audio Stop and newer Tests retire startup retries before stale playback can begin",
    stoppedReply.status === "cancelled" && oldReply.status === "cancelled" && current.status === "success"
      && sent.filter(message => message.type === "hd_audio_test").length === 1
      && sent.at(-1).requestId === "current" && sent.at(-1).owner === "settings-b", JSON.stringify(sent));

  await chrome.storage.local.set({ options: { revision: 1, audioSources: [source, { ...source, id: "disabled", enabled: false }] } });
  const plays = new Map(), progress = [];
  chrome.tabs = { async sendMessage(tabId, message, options) { progress.push({ tabId, message, options }); } };
  chrome.runtime.sendMessage = async message => {
    sent.push(message);
    if (message.type === "hd_audio_play") return new Promise(resolve => plays.set(message.requestId, resolve));
    return { ok: true, status: "cancelled" };
  };
  const term = { expression: "聞く", reading: "きく" };
  const play = (requestId, sender = { id: chrome.runtime.id, documentId: "reader-document", tab: { id: 42 } }) =>
    bus.sendMessage("reader", { target: "hachidori-audio", type: "hd_audio_play", requestId, term,
      sources: [{ ...source, id: "forged" }] }, sender);
  const notify = (requestId, owner = "reader-document", url = chrome.runtime.getURL("offscreen.html")) => bus.sendMessage("audio-offscreen", {
    target: "hachidori-audio-events", type: "hd_audio_playing", requestId, owner, sourceId: source.id,
  }, { id: chrome.runtime.id, url });
  const firstPlay = play("owned-play");
  await new Promise(resolve => setImmediate(resolve));
  const authoritative = sent.at(-1).sources;
  await notify("owned-play", "another-document");
  await notify("owned-play", "reader-document", "https://example.test/");
  await notify("owned-play");
  const nextPlay = play("newer-play");
  await new Promise(resolve => setImmediate(resolve));
  await notify("owned-play");
  await send("hd_audio_stop", "old-reader-stop", { playRequestId: "owned-play" }, "reader-document");
  await notify("newer-play");
  plays.get("owned-play")({ ok: true, status: "cancelled" });
  plays.get("newer-play")({ ok: true, status: "success" });
  await Promise.all([firstPlay, nextPlay]);

  const startup = documentId => ({ id: chrome.runtime.id, documentId, url: chrome.runtime.getURL("startup.html") });
  const firstStartup = play("startup-play", startup("startup-a"));
  await new Promise(resolve => setImmediate(resolve));
  await notify("startup-play", "startup-b");
  await notify("startup-play", "startup-a");
  const nextStartup = play("newer-startup-play", startup("startup-b"));
  await new Promise(resolve => setImmediate(resolve));
  await notify("startup-play", "startup-a");
  await notify("newer-startup-play", "startup-b");
  plays.get("startup-play")({ ok: true, status: "cancelled" });
  plays.get("newer-startup-play")({ ok: true, status: "success" });
  await Promise.all([firstStartup, nextStartup]);
  const otherInternal = play("other-internal", { ...startup("other-internal"), url: chrome.runtime.getURL("startup.html-other") });
  await new Promise(resolve => setImmediate(resolve));
  await notify("other-internal", "other-internal");
  plays.get("other-internal")({ ok: true, status: "success" });
  await otherInternal;
  const startupProgress = sent.filter(message => message.target === "hachidori-audio-content");
  check("popup audio uses authoritative enabled sources and routes progress only to its newest owning document",
    authoritative.length === 1 && authoritative[0].id === source.id && progress.length === 2
      && progress.every(value => value.tabId === 42 && value.options.documentId === "reader-document")
      && progress[0].message.requestId === "owned-play" && progress[1].message.requestId === "newer-play"
      && startupProgress.length === 2 && startupProgress[0].requestId === "startup-play" && startupProgress[0].owner === "startup-a"
      && startupProgress[1].requestId === "newer-startup-play" && startupProgress[1].owner === "startup-b",
    JSON.stringify({ authoritative, progress, startupProgress }));

  const read = chrome.storage.local.get;
  const heldReads = [];
  chrome.storage.local.get = async key => {
    // Maturity scheduling can read options concurrently with this audio request.
    if (key === "options") await new Promise(resolve => { heldReads.push(resolve); });
    return read(key);
  };
  const retiredRead = play("retired-read");
  await new Promise(resolve => setImmediate(resolve));
  await send("hd_audio_stop", "retire-read", { playRequestId: "retired-read" }, "reader-document");
  chrome.storage.local.get = read;
  for (const release of heldReads) release();
  const retiredReply = await retiredRead;
  const invalid = await send("hd_audio_play", "invalid-choice", { term, selection: { index: "toString" } });
  check("Stop retires popup audio awaiting source storage and malformed choices never reach the offscreen player",
    retiredReply.status === "cancelled" && invalid.ok === false
      && !sent.some(message => ["retired-read", "invalid-choice"].includes(message.requestId)), JSON.stringify({ retiredReply, invalid }));
}

describe("audio", () => {
  test("audio relay", async () => {
    await audioRelayStage();
  });
});
