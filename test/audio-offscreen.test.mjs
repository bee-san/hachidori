// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAudioService } from "../extension/audio-offscreen.js";

test("offscreen Test cancellation belongs to its document and request, with an independent deadline", async () => {
  const timers = new Map(), requests = [];
  let nextTimer = 0;
  const service = createAudioService({
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
