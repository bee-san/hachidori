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
        if (delay !== 15_000) return setTimeout(callback, delay, ...args);
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
    assert.match(first.outcomes[0].error, /timed out after 15 seconds/u);
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
