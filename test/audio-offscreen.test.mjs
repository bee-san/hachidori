// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAudioService } from "../extension/audio-offscreen.js";

test("offscreen Test cancellation belongs to its document and request, with an independent deadline", async () => {
  const timers = new Map(), requests = [];
  let nextTimer = 0;
  const service = createAudioService({
    performance,
    addEventListener() {},
    fetch: (url, { signal }) => new Promise((_, reject) => {
      requests.push({ url, signal });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    setTimeout(callback, delay) { assert.equal(delay, 15_000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = { id: "url", type: "custom", enabled: true, url: "https://example.test/{term}/{reading}.wav", voice: "" };
  const play = requestId => service({ type: "hd_audio_test", source, owner: "settings-a", requestId });
  const pending = play("first");
  await Promise.resolve();
  await service({ type: "hd_audio_stop", owner: "settings-b", playRequestId: "first" });
  await service({ type: "hd_audio_stop", owner: "settings-a", playRequestId: "different" });
  assert.equal(requests[0].signal.aborted, false);
  await service({ type: "hd_audio_stop", owner: "settings-a", playRequestId: "first" });
  assert.equal((await pending).status, "cancelled");
  assert.equal(timers.size, 0);
  const timed = play("second");
  await Promise.resolve();
  const rejection = assert.rejects(timed, /timed out after 15 seconds/u);
  [...timers.values()][0]();
  await rejection;
  assert.equal(timers.size, 0);
  assert.equal(requests[1].url, "https://example.test/%E8%81%9E%E3%81%8F/%E3%81%8D%E3%81%8F.wav");
});

test("a selected pronunciation binds its exact source, term and candidate even after provider reordering", async () => {
  let now = 0;
  const events = [], downloads = [];
  const source = { id: "json", type: "custom-json", enabled: true, url: "https://example.test/list", voice: "" };
  const term = { expression: "聞く", reading: "きく" };
  let candidates = [{ url: "https://example.test/one.wav", name: "Tokyo" }, { url: "https://example.test/two.wav", name: "Osaka" }];
  const service = createAudioService({
    performance: { now: () => now }, addEventListener() {}, setTimeout, clearTimeout,
    URL: { createObjectURL: () => "blob:audio", revokeObjectURL() {} },
    Audio: class {
      play() { queueMicrotask(() => { this.onplaying?.(); this.onended?.(); }); return Promise.resolve(); }
      pause() {} removeAttribute() {} load() {}
    },
    chrome: { runtime: { async sendMessage(event) { events.push(event); } } },
    fetch: async url => {
      if (url === source.url) return { ok: true, json: async () => ({ type: "audioSourceList", audioSources: candidates }) };
      downloads.push(url);
      return { ok: true, blob: async () => new Blob(["audio"]) };
    },
  });
  const message = { sources: [source], term, owner: "reader", requestId: "choose" };
  const { groups } = await service({ ...message, type: "hd_audio_candidates" });
  assert.deepEqual(downloads, []);
  const selection = { sourceId: source.id, sourceKey: groups[0].sourceKey, ...term, index: 1, ...candidates[1] };
  const result = await service({ ...message, type: "hd_audio_play", selection });
  assert.equal(result.candidate.index, 1);
  assert.deepEqual(downloads, [candidates[1].url]);
  assert.equal(events[0].requestId, message.requestId);
  assert.equal(events[0].candidate.name, "Osaka");
  now = 5 * 60_000;
  candidates = [...candidates].reverse();
  await assert.rejects(service({ ...message, type: "hd_audio_play", selection }), /choices changed/u);
  await assert.rejects(service({ ...message, term: { expression: "違う", reading: "ちがう" }, type: "hd_audio_play", selection }), /no longer current/u);
  await assert.rejects(service({ ...message, sources: [{ ...source, url: "https://example.test/replacement" }],
    type: "hd_audio_play", selection }), /no longer current/u);
  assert.equal(downloads.length, 1);
});

test("fallback resumes the remaining discovery deadline after a playing recording fails", async () => {
  let now = 0, timerId = 0;
  const timers = new Map();
  let playing, stalled;
  const started = Promise.withResolvers(), requested = Promise.withResolvers();
  const service = createAudioService({
    performance: { now: () => now }, addEventListener() {},
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    URL: { createObjectURL: () => "blob:audio", revokeObjectURL() {} },
    Audio: class {
      play() { playing = this; now = 2000; this.onplaying(); started.resolve(); return Promise.resolve(); }
      pause() {} removeAttribute() {} load() {}
    },
    chrome: { runtime: { async sendMessage() {} } },
    fetch: async (url, { signal }) => {
      if (url.endsWith("list")) return { ok: true, json: async () => ({ type: "audioSourceList", audioSources: [
        { url: "https://example.test/one.wav", name: "One" }, { url: "https://example.test/two.wav", name: "Two" },
      ] }) };
      if (url.endsWith("one.wav")) return { ok: true, blob: async () => new Blob(["audio"]) };
      stalled = signal;
      requested.resolve();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const pending = service({ type: "hd_audio_play", owner: "reader", requestId: "fallback",
    term: { expression: "聞く", reading: "きく" },
    sources: [{ id: "json", type: "custom-json", url: "https://example.test/list", voice: "", enabled: true }],
  });
  const rejected = assert.rejects(pending, /discovery timed out after 12 seconds/u);
  await started.promise;
  assert.equal(timers.size, 0, "playable media has no duration limit");
  now = 62_000;
  playing.onerror();
  await requested.promise;
  const resumed = [...timers.values()][0];
  // Always settle the pending request, including when this regression fails.
  if (!resumed) await service({ type: "hd_audio_stop", owner: "reader", playRequestId: "fallback" });
  else resumed.callback();
  await rejected;
  assert.equal(resumed.delay, 10_000, "one minute playing does not consume the remaining discovery budget");
  assert.equal(stalled.aborted, true);
  assert.equal(timers.size, 0);
});
