// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { runInContext } from "node:vm";
import { genericPackage, loadBackgroundScript, makeAlarms, makeBus, makeChrome, makeStorage } from "./extension-smoke/fakes.mjs";

for (const phase of ["headers", "body"]) {
  test(`a stalled update ${phase} times out, permits sibling checks and retry, and ignores late data`, async () => {
    const bus = makeBus(), storage = makeStorage();
    const chrome = makeChrome("check-worker", bus, storage, makeAlarms());
    const dictionaries = ["first", "second"].map(id => genericPackage({
      id, title: id, path: `/dicts/${id}`, revision: "1", isUpdatable: true,
      indexUrl: `https://example.com/${id}.json`, downloadUrl: `https://example.com/${id}.zip`,
    }));
    await chrome.storage.local.set({ dictionaryState: { schemaVersion: 1, revision: 1, groups: [], dictionaries } });
    let expire, release, signal, cancelCount = 0, stalled = true;
    const pending = new Promise(resolve => { release = resolve; });
    const received = [];
    const response = url => ({ ok: true, url, json: async () => ({ revision: "2" }),
      body: { cancel: async () => { cancelCount++; } } });
    const context = loadBackgroundScript({ chrome, console, Promise, Error, TypeError,
      setTimeout(callback, delay, ...args) {
        if (delay !== 120_000) return setTimeout(callback, delay, ...args);
        expire = callback;
        return { deadline: true };
      },
      clearTimeout(timer) { if (!timer?.deadline) clearTimeout(timer); },
      async fetch(url, init) {
        received.push(url);
        const result = response(url);
        if (!stalled || url !== dictionaries[0].indexUrl) return result;
        signal = init.signal;
        if (phase === "headers") return pending;
        result.json = () => pending;
        return result;
      },
    });
    const check = () => runInContext("queueManagedUpdate()", context);
    const running = check();
    while (!signal) await new Promise(resolve => setImmediate(resolve));
    // Let response.json() acquire the body before its deadline is triggered.
    await new Promise(resolve => setImmediate(resolve));
    expire();
    const first = await running;
    assert.deepEqual(Array.from(first.outcomes, entry => entry.status), ["check-failed", "update-available"]);
    assert.match(first.outcomes[0].error, /no data for two minutes/u);
    assert.equal(signal.aborted, true);
    assert.deepEqual(received, dictionaries.map(entry => entry.indexUrl));
    const beforeLate = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
    release(phase === "headers" ? response(dictionaries[0].indexUrl) : { revision: "late" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await chrome.storage.local.get("dictionaryState")).dictionaryState, beforeLate);
    assert.equal(cancelCount, 1);
    stalled = false;
    const retry = await check();
    assert.deepEqual(Array.from(retry.outcomes, entry => entry.status), ["update-available", "update-available"]);
  });
}

test("slow index chunks renew inactivity without a total deadline, and empty chunks do not renew it", async () => {
  const chrome = makeChrome("check-worker", makeBus(), makeStorage(), makeAlarms());
  let now = 0, stream, signal;
  const timers = new Set();
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  const context = loadBackgroundScript({ chrome, console, Promise, Error, TypeError, TextDecoder,
    setTimeout(callback, delay, ...args) {
      if (delay !== 120_000) return setTimeout(callback, delay, ...args);
      const timer = { at: now + delay, callback };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { if (!timers.delete(timer)) clearTimeout(timer); },
    fetch: async (url, init) => { signal = init.signal; return { ok: true, url, body }; },
  });
  const advance = duration => {
    now += duration;
    for (const timer of timers) if (timer.at <= now) { timers.delete(timer); timer.callback(); }
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const running = runInContext('remoteUpdate({fingerprint: {source: {kind: "generic", indexUrl: "https://example.com/index.json", downloadUrl: "https://example.com/archive.zip"}}})', context);
  await flush();
  const bytes = new TextEncoder().encode('{"revision":"次版"}');
  advance(90_000);
  stream.enqueue(bytes.slice(0, 15)); // Split a UTF-8 character between chunks.
  await flush();
  assert.equal([...timers][0].at, 210_000);
  advance(90_000);
  stream.enqueue(new Uint8Array());
  await flush();
  assert.equal([...timers][0].at, 210_000);
  advance(20_000);
  stream.enqueue(bytes.slice(15));
  stream.close();
  assert.equal((await running).revision, "次版");
  assert.equal(signal.aborted, false);
  assert.equal(timers.size, 0, "metadata timers retire before any archive download or import begins");
});
