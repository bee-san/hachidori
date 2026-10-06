// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAudioRepository } from "../extension/audio-repository.js";

const source = { id: "source", type: "custom-json", enabled: true, url: "https://example.test/?term={term}", voice: "" };
const term = { expression: "聞く", reading: "きく" };
const candidate = { url: "https://example.test/audio.wav", name: "Tokyo" };
const signal = () => new AbortController().signal;

function fixture() {
  let now = 0, size = 4;
  const requests = [], created = [], revoked = [];
  const repository = createAudioRepository({ now: () => now,
    window: { URL: { createObjectURL(blob) { created.push(blob); return `blob:${created.length}`; },
      revokeObjectURL(url) { revoked.push(url); } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ type: "audioSourceList", audioSources: [candidate] }),
        blob: async () => ({ size }) };
    },
  });
  return { repository, requests, created, revoked, time(value) { now = value; }, size(value) { size = value; } };
}

test("warm pronunciation discovery and media reuse one offscreen Blob URL without another download", async () => {
  const f = fixture();
  assert.deepEqual(await f.repository.candidates(source, term, signal()), [candidate]);
  assert.deepEqual(await f.repository.candidates(source, term, signal()), [candidate]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "https://example.test/?term=%E8%81%9E%E3%81%8F");
  const first = await f.repository.acquire(candidate, signal()); first.release();
  const second = await f.repository.acquire(candidate, signal()); second.release();
  assert.equal(second.url, first.url);
  assert.equal(f.requests.length, 2);
  assert.equal(f.created.length, 1);
  assert.ok(f.requests.every(({ options }) => options.credentials === "omit"));
  f.repository.clear();
  assert.deepEqual(f.revoked, [first.url]);
});

test("expired media stays alive for an active pronunciation and is retired when its lease ends", async () => {
  const f = fixture();
  const active = await f.repository.acquire(candidate, signal());
  f.time(30 * 60_000);
  const replacement = await f.repository.acquire(candidate, signal());
  assert.notEqual(active.url, replacement.url);
  assert.deepEqual(f.revoked, []);
  active.release();
  assert.deepEqual(f.revoked, [active.url]);
  replacement.invalidate(); replacement.release();
  assert.deepEqual(f.revoked, [active.url, replacement.url]);
  const retry = await f.repository.acquire(candidate, signal()); retry.release();
  assert.equal(f.requests.length, 3);
  f.repository.clear();
});

test("media above the retention budget remains playable uncached and is released afterwards", async () => {
  const f = fixture();
  f.size(64 * 1024 * 1024 + 1);
  const oversized = await f.repository.acquire(candidate, signal());
  assert.equal(typeof oversized.url, "string");
  assert.deepEqual(f.revoked, []);
  oversized.release();
  const repeated = await f.repository.acquire(candidate, signal()); repeated.release();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.revoked, [oversized.url, repeated.url]);
});

test("candidate retention counts source keys as well as response data without limiting accepted URLs", async () => {
  const f = fixture();
  const largeSource = { ...source, url: `https://example.test/?padding=${"x".repeat(2 * 1024 * 1024)}&term={term}` };
  assert.deepEqual(await f.repository.candidates(largeSource, term, signal()), [candidate]);
  assert.deepEqual(await f.repository.candidates(largeSource, term, signal()), [candidate]);
  assert.equal(f.requests.length, 2, "an oversized source key must not be retained outside the byte budget");
  f.repository.clear();
});

test("list and recording failures say which request failed, with its HTTP status or network error (#499)", async () => {
  const responses = new Map();
  const repository = createAudioRepository({ window: { URL: { createObjectURL: () => "blob:1", revokeObjectURL() {} } },
    fetch: async url => {
      const response = responses.get(url);
      if (typeof response === "function") return response();
      if (response instanceof Error) throw response;
      return response;
    } });
  const list = "https://example.test/?term=%E8%81%9E%E3%81%8F";
  responses.set(list, { ok: false, status: 403 });
  await assert.rejects(repository.candidates(source, term, signal()), { message: "The pronunciation list returned HTTP 403." });
  responses.set(candidate.url, { ok: false, status: 404 });
  await assert.rejects(repository.acquire(candidate, signal()), { message: "The recording returned HTTP 404." });
  responses.set(candidate.url, new TypeError("Failed to fetch"));
  await assert.rejects(repository.acquire(candidate, signal()),
    { message: "The recording could not be downloaded (Failed to fetch)." });
  // A Yomitan JSON source pointed at a recording (an MP3's ID3 header).
  responses.set(list, { ok: true, headers: new Headers({ "content-type": "audio/mpeg" }),
    json: async () => JSON.parse("ID3\u0004") });
  await assert.rejects(repository.candidates(source, term, signal()), { message: "The pronunciation list is not JSON "
    + "(audio/mpeg). If this URL plays a recording itself, set this source's type to Audio URL in Audio Settings." });
  // Stopping while the download is in flight stays a cancellation.
  const controller = new AbortController();
  responses.set(candidate.url, () => {
    controller.abort(new DOMException("Playback stopped.", "AbortError"));
    throw controller.signal.reason;
  });
  await assert.rejects(repository.acquire(candidate, controller.signal), { name: "AbortError" });
});
