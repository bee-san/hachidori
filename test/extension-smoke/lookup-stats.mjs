/*
 * Lookup statistics in the worker.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { runInContext } from "node:vm";
import { lookupStatsKey } from "../../extension/lookup-stats.js";
import {
  EXTENSION_ORIGIN,
  loadBackgroundScript,
  makeBus,
  makeChrome,
  makeStorage,
} from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function lookupStatsStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("lookup-stats-worker", bus, storage);
  const backgroundContext = loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, Promise, Error });
  await runInContext("initialiseAutomaticBackupAlarm()", backgroundContext);
  const getsBeforeLookups = storage.gets.length;
  const setsBeforeLookups = storage.sets.length;
  const send = (type, fields = {}) => bus.sendMessage("lookup-page", { target: "hoshidicts-worker", type, ...fields });
  const fields = { term: "  は\u3099 ", reading: " は\u3099 " };
  const replies = await Promise.all(Array.from({ length: 25 }, () => send("hd_lookup_stats_record", fields)));
  const current = await send("hd_lookup_stats_read", fields);
  const lookupGets = storage.gets.slice(getsBeforeLookups);
  const lookupWrites = storage.sets.slice(setsBeforeLookups);
  check("concurrent lookups increment one canonical row without scanning or rewriting the statistics collection",
    replies.every(reply => reply.ok) && current.statistics?.lookupCount === 25 && current.statistics.term === "ば"
      && current.statistics.reading === "ば" && !("seenCount" in current.statistics)
      && lookupGets.every(query => query !== null) && lookupWrites.length === 25
      && lookupWrites.every(keys => keys.length === 2 && keys.includes("lookupStats")), JSON.stringify(current));

  const restartBus = makeBus();
  const restartChrome = makeChrome("lookup-stats-restarted", restartBus, storage);
  loadBackgroundScript({ chrome: restartChrome, console, setTimeout, clearTimeout, Promise, Error });
  const restored = await restartBus.sendMessage("lookup-page", { target: "hoshidicts-worker", type: "hd_lookup_stats_read", ...fields });
  const separate = await send("hd_lookup_stats_record", { term: "ば", reading: "" });
  check("lookup counts survive worker restart and distinguish empty readings",
    restored.statistics?.lookupCount === 25 && separate.statistics?.lookupCount === 1 && separate.statistics.reading === "");

  await send("hd_options_write", { baseRevision: 0, options: { showLookupCounts: false } });
  const beforeDisabled = storage.sets.length;
  const disabled = await send("hd_lookup_stats_record", fields);
  check("disabled lookup statistics do not record or erase existing counts",
    disabled.ok && disabled.statistics === null && storage.sets.length === beforeDisabled, JSON.stringify(disabled));

  await chrome.storage.local.set({ options: { revision: 2, showLookupCounts: "false",
    corpusSeenEnabled: 1, corpusSeenUrl: "https://example.com" } });
  const beforeMalformed = storage.sets.length;
  const malformedOptions = await send("hd_lookup_stats_record", { term: "既定", reading: "きてい" });
  check("lookup statistics read scalar option defaults without normalizing unrelated settings",
    malformedOptions.statistics?.lookupCount === 1 && !("seenCount" in malformedOptions.statistics)
      && storage.sets.length === beforeMalformed + 1, JSON.stringify(malformedOptions));

  // Settings → Reading → Reset lookup counts. Holding the storage queue fixes
  // which side of the reset each lookup lands on.
  const settingsSender = { id: "hachidorismokeextensionid", url: `${EXTENSION_ORIGIN}/settings.html` };
  const reset = (sender = settingsSender) =>
    bus.sendMessage("lookup-settings", { target: "hoshidicts-worker", type: "hd_lookup_stats_reset" }, sender);
  const tick = () => new Promise(done => setTimeout(done, 0));
  const holdStorage = () => {
    let release;
    backgroundContext.lookupStatsGate = new Promise(resolveGate => { release = resolveGate; });
    const held = runInContext("serialiseStorage(() => lookupStatsGate)", backgroundContext);
    return async () => { release(); await held; };
  };
  const rowKeys = () => [...storage.raw.keys()].filter(key => key.startsWith("lookupStats:"));
  const unrelated = () => ["options", "dictionaryState", "customDictionarySource"]
    .map(key => JSON.stringify(storage.raw.get(key) ?? null)).join();
  const unrelatedBefore = unrelated();
  const original = structuredClone(storage.raw.get("lookupStats"));
  const fromPage = await send("hd_lookup_stats_reset");
  await runInContext("sharingLinked = true", backgroundContext);
  const whileLinked = await reset();
  await runInContext("sharingLinked = false", backgroundContext);
  const setsBeforeResets = storage.sets.length;
  let release = holdStorage();
  const recordedBefore = send("hd_lookup_stats_record", fields);
  await tick();
  const firstReset = reset();
  await tick();
  await release();
  const [before, first] = await Promise.all([recordedBefore, firstReset]);
  const readAfterFirst = await send("hd_lookup_stats_read", fields);
  const rowsAfterFirst = rowKeys();
  release = holdStorage();
  const secondReset = reset();
  await tick();
  const recordedAfter = send("hd_lookup_stats_record", fields);
  await tick();
  await release();
  const [second, after] = await Promise.all([secondReset, recordedAfter]);
  const newRow = lookupStatsKey(second.descriptor, after.statistics);
  // Each reset writes only the descriptor; neither lookup writes a merged row.
  const writes = storage.sets.slice(setsBeforeResets);
  check("Settings resets lookup counts to a new empty generation that orders lookups before or after it",
    fromPage.ok === false && fromPage.error.includes("Settings")
      && whileLinked.ok === false && whileLinked.error.includes("linked")
      && before.ok && before.statistics.lookupCount === 26 && before.descriptor.generation === original.generation
      && first.ok && first.descriptor.revision === before.descriptor.revision + 1
      && ![original.generation, null].includes(first.descriptor.generation)
      && readAfterFirst.statistics.lookupCount === 0
      && JSON.stringify(readAfterFirst.descriptor) === JSON.stringify(first.descriptor)
      && rowsAfterFirst.length === 0
      && second.ok && second.descriptor.revision === first.descriptor.revision + 1
      && second.descriptor.generation !== first.descriptor.generation
      && after.statistics.lookupCount === 1 && after.descriptor.generation === second.descriptor.generation
      && after.descriptor.revision === second.descriptor.revision + 1
      && JSON.stringify(rowKeys()) === JSON.stringify([newRow])
      && JSON.stringify(writes) === JSON.stringify([
        ["lookupStats", lookupStatsKey(original, before.statistics)], ["lookupStats"], ["lookupStats"], ["lookupStats", newRow],
      ])
      && unrelated() === unrelatedBefore,
    JSON.stringify({ fromPage, whileLinked, before, first, readAfterFirst, rowsAfterFirst, second, after, writes }));

  const localBus = makeBus(), localStorage = makeStorage();
  const localChrome = makeChrome("lookup-stats-local-worker", localBus, localStorage);
  await localChrome.storage.local.set({ options: { revision: 1, showLookupCounts: true,
    corpusSeenEnabled: true, corpusSeenUrl: "http://127.0.0.1:7275" } });
  const fetches = [];
  const context = loadBackgroundScript({
    chrome: localChrome, console, setTimeout, clearTimeout, Promise, Error,
    fetch: async (...args) => { fetches.push(args); throw new Error("Unexpected network request"); },
  });
  const record = await localBus.sendMessage("lookup-page", {
    target: "hoshidicts-worker", type: "hd_lookup_stats_record", term: "本", reading: "ほん",
  });
  const read = await localBus.sendMessage("lookup-page", {
    target: "hoshidicts-worker", type: "hd_lookup_stats_read", term: "本", reading: "ほん",
  });
  const projected = context.HDReaderOptions.normaliseOptions((await localChrome.storage.local.get("options")).options);
  check("legacy corpus settings cannot contact another app and local counts still persist",
    record.ok && read.ok && record.statistics?.lookupCount === 1 && read.statistics?.lookupCount === 1
      && !("seenCount" in read.statistics) && fetches.length === 0
      && !("corpusSeenEnabled" in projected) && !("corpusSeenUrl" in projected),
    JSON.stringify({ record, read, fetches }));

}

describe("lookup statistics", () => {
  test("lookup statistics in the worker", async () => {
    await lookupStatsStage();
  });
});
