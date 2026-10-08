/*
 * Backups: the relay, the lifecycle port, automatic backups and Settings retention.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { runInContext } from "node:vm";
import { customDictionarySemanticRevision } from "../../extension/custom-dictionary.js";
import {
  EXTENSION,
  EXTENSION_ORIGIN,
  loadBackgroundScript,
  loadJsdom,
  loadSettingsScript,
  makeAlarms,
  makeBus,
  makeChrome,
  makeEvent,
  makeStorage,
} from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function automaticBackupBackgroundStage() {
  let now = Date.parse("2026-09-18T12:00:00.000Z");
  const day = 24 * 60 * 60_000;
  class BackupDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
  const chrome = makeChrome("automatic-backup-worker", bus, storage, alarms);
  const semanticRevision = await customDictionarySemanticRevision([]);
  await chrome.storage.local.set({
    dictionaryState: { schemaVersion: 1, revision: 1, dictionaries: [], groups: [] },
    options: { revision: 1 },
    customDictionarySource: { schemaVersion: 1, revision: 1, semanticRevision, text: "" },
    dictionaryUpdates: { revision: 1, schedule: "off", lastCheckedAt: null },
    lookupStats: { generation: null, revision: 0 },
  });
  const cleanups = [];
  bus.addListener("automatic-backup-engine", (message, sender, sendResponse) => {
    if (message?.target !== "hoshidicts-offscreen" || message.relayed !== true) return false;
    cleanups.push(structuredClone(message));
    sendResponse({ type: `${message.type}_result`, requestId: message.requestId, ok: true });
    return true;
  });
  const context = loadBackgroundScript({
    chrome, console, setTimeout, clearTimeout, Promise, Error, Date: BackupDate,
  });
  const reconcile = () => runInContext("reconcileAutomaticBackups()", context);
  await runInContext("initialiseAutomaticBackupAlarm()", context);
  const firstStore = structuredClone(storage.raw.get("automaticBackups"));
  const firstWrites = storage.sets.filter(keys => keys.length === 1 && keys[0] === "automaticBackups").length;
  check("an absent automatic-backup store is created as v1 on worker initialization",
    firstStore.schemaVersion === 1
      && firstStore.backups.length === 1
      && Date.parse(firstStore.backups[0].createdAt) === now
      && (await alarms.api.get("hachidori-automatic-backup"))?.scheduledTime === now + day,
    JSON.stringify({ committedAt: firstStore.backups[0].createdAt,
      alarm: await alarms.api.get("hachidori-automatic-backup") }));

  now += day;
  const queuedAt = now;
  let releaseQueue;
  context.automaticBackupQueueGate = new Promise(resolve => { releaseQueue = resolve; });
  const blocker = runInContext("serialiseStorage(() => automaticBackupQueueGate)", context);
  const delayed = Promise.all([reconcile(), reconcile(), reconcile()]);
  now += 3 * 60 * 60_000;
  releaseQueue();
  await blocker;
  await delayed;
  const secondStore = structuredClone(storage.raw.get("automaticBackups"));
  const automaticWrites = storage.sets.filter(keys => keys.length === 1 && keys[0] === "automaticBackups").length;
  check("automatic backups timestamp serialized creation after queue delay and retain only the default two payloads",
    firstStore.backups.length === 1
      && firstWrites === 1
      && secondStore.backups.length === 2
      && automaticWrites === 2
      && cleanups.length === 2
      && Date.parse(secondStore.backups[0].createdAt) === now
      && Date.parse(secondStore.backups[0].createdAt) !== queuedAt
      && (await alarms.api.get("hachidori-automatic-backup"))?.scheduledTime === now + day,
    JSON.stringify({ queuedAt, firstStore, secondStore, automaticWrites, cleanups: cleanups.length,
      metadataBytes: Buffer.byteLength(JSON.stringify(secondStore)) }));

  now += day;
  const futureStore = { schemaVersion: 2, backups: structuredClone(secondStore.backups) };
  const writesBeforeFuture = storage.sets.filter(keys =>
    keys.length === 1 && keys[0] === "automaticBackups").length;
  const cleanupsBeforeFuture = cleanups.length;
  storage.raw.set("automaticBackups", structuredClone(futureStore));
  let futureFailure = null;
  try { await reconcile(); } catch (error) { futureFailure = error; }
  const futureAfterFailure = structuredClone(storage.raw.get("automaticBackups"));
  const writesAfterFuture = storage.sets.filter(keys =>
    keys.length === 1 && keys[0] === "automaticBackups").length;
  check("an unsupported future automatic-backup schema fails closed without overwrite or generation cleanup",
    /unsupported schema/u.test(futureFailure?.message ?? "")
      && JSON.stringify(futureAfterFailure) === JSON.stringify(futureStore)
      && writesAfterFuture === writesBeforeFuture
      && cleanups.length === cleanupsBeforeFuture,
    JSON.stringify({ futureFailure: futureFailure?.message, futureAfterFailure,
      writesBeforeFuture, writesAfterFuture, cleanupsBeforeFuture, cleanupsAfterFuture: cleanups.length }));
  storage.raw.set("automaticBackups", structuredClone(secondStore));

  const beforeRefusal = structuredClone(secondStore);
  const cleanupsBeforeRefusal = cleanups.length;
  storage.failNextSet("injected automatic metadata failure");
  let refusal = null;
  try { await reconcile(); } catch (error) { refusal = error; }
  check("a refused automatic-backup metadata write retains the authoritative index and skips generation cleanup",
    /injected automatic metadata failure/u.test(refusal?.message ?? "")
      && JSON.stringify(storage.raw.get("automaticBackups")) === JSON.stringify(beforeRefusal)
      && cleanups.length === cleanupsBeforeRefusal,
    JSON.stringify({ refusal: refusal?.message, store: storage.raw.get("automaticBackups"), cleanups: cleanups.length }));

  storage.loseNextSetReply("lost automatic metadata reply");
  await reconcile();
  const recovered = structuredClone(storage.raw.get("automaticBackups"));
  check("a lost automatic-backup metadata reply is recovered by exact readback without a duplicate snapshot",
    recovered.backups.length === 2
      && Date.parse(recovered.backups[0].createdAt) === now
      && new Set(recovered.backups.map(record => record.id)).size === 2
      && storage.sets.filter(keys => keys.length === 1 && keys[0] === "automaticBackups").length === 3
      && cleanups.length === cleanupsBeforeRefusal + 1,
    JSON.stringify({ recovered, writes: storage.sets, cleanups: cleanups.length }));

  await alarms.api.clear("hachidori-automatic-backup");
  await runInContext("automaticBackupNextAt = null", context);
  alarms.failNextCreate("injected automatic alarm failure");
  let alarmFailure = null;
  try { await runInContext(`scheduleAutomaticBackup(${now + day})`, context); }
  catch (error) { alarmFailure = error; }
  const nextAtAfterFailure = runInContext("automaticBackupNextAt", context);
  await runInContext(`scheduleAutomaticBackup(${now + day})`, context);
  check("a rejected automatic-backup alarm creation leaves scheduling retryable until a later create succeeds",
    /injected automatic alarm failure/u.test(alarmFailure?.message ?? "")
      && nextAtAfterFailure === null
      && runInContext("automaticBackupNextAt", context) === now + day
      && (await alarms.api.get("hachidori-automatic-backup"))?.scheduledTime === now + day,
    JSON.stringify({ alarmFailure: alarmFailure?.message, nextAtAfterFailure,
      retryAlarm: await alarms.api.get("hachidori-automatic-backup") }));

  const corrupt = structuredClone(recovered);
  corrupt.backups[0].snapshot.state.schemaVersion = 99;
  await chrome.storage.local.set({ automaticBackups: corrupt });
  const settingsChrome = makeChrome("automatic-backup-settings", bus, storage, alarms);
  const listed = await settingsChrome.runtime.sendMessage({
    target: "hoshidicts-worker", type: "hd_backup_auto_list",
  });
  const roots = await bus.sendMessage("automatic-backup-engine-host", {
    target: "hoshidicts-worker", type: "hd_backup_auto_roots",
  }, { id: chrome.runtime.id, url: chrome.runtime.getURL("offscreen.html") });
  check("a corrupt newest automatic backup leaves the valid older snapshot visible and blocks unsafe cleanup",
    listed?.ok === true && listed.corruptCount === 1 && listed.backups.length === 1
      && listed.backups[0].id === corrupt.backups[1].id
      && roots?.ok === true && roots.complete === false && roots.dictionaries.length === 0,
    JSON.stringify({ listed, roots }));

  await alarms.api.clear("hachidori-automatic-backup");
  const writesBeforeRestart = storage.sets.length;
  const restartedBus = makeBus();
  const restartedChrome = makeChrome("automatic-backup-restarted", restartedBus, storage, alarms);
  const restarted = loadBackgroundScript({
    chrome: restartedChrome, console, setTimeout, clearTimeout, Promise, Error, Date: BackupDate,
  });
  await runInContext("initialiseAutomaticBackupAlarm()", restarted);
  check("worker restart recreates the automatic-backup alarm from retained metadata without another write",
    (await alarms.api.get("hachidori-automatic-backup"))?.scheduledTime === now + day
      && storage.sets.length === writesBeforeRestart,
    JSON.stringify({ alarm: await alarms.api.get("hachidori-automatic-backup"),
      writesBeforeRestart, writesAfterRestart: storage.sets.length }));

  const noStoreStorage = makeStorage();
  const noStoreAlarms = makeAlarms();
  const notReadyBus = makeBus();
  const notReadyChrome = makeChrome("automatic-backup-not-ready", notReadyBus, noStoreStorage, noStoreAlarms);
  const notReady = loadBackgroundScript({
    chrome: notReadyChrome, console, setTimeout, clearTimeout, Promise, Error, Date: BackupDate,
  });
  await runInContext("initialiseAutomaticBackupAlarm()", notReady);
  const waitedWithoutStore = !noStoreStorage.raw.has("automaticBackups")
    && runInContext("automaticBackupWaitingForState", notReady) === true;
  noStoreStorage.raw.set("dictionaryState",
    { schemaVersion: 1, revision: 1, dictionaries: [], groups: [] });
  noStoreStorage.raw.set("options", { revision: 1 });
  noStoreStorage.raw.set("customDictionarySource",
    { schemaVersion: 1, revision: 1, semanticRevision, text: "" });
  noStoreStorage.raw.set("dictionaryUpdates",
    { revision: 1, schedule: "off", lastCheckedAt: null });
  noStoreStorage.raw.set("lookupStats", { generation: null, revision: 0 });

  const noStoreRestartBus = makeBus();
  noStoreRestartBus.addListener("automatic-backup-no-store-engine", (message, _sender, sendResponse) => {
    if (message?.target !== "hoshidicts-offscreen" || message.relayed !== true) return false;
    sendResponse({ type: `${message.type}_result`, requestId: message.requestId, ok: true });
    return true;
  });
  const noStoreRestartChrome = makeChrome(
    "automatic-backup-no-store-restarted", noStoreRestartBus, noStoreStorage, noStoreAlarms,
  );
  const noStoreRestart = loadBackgroundScript({
    chrome: noStoreRestartChrome, console, setTimeout, clearTimeout, Promise, Error, Date: BackupDate,
  });
  await runInContext("initialiseAutomaticBackupAlarm()", noStoreRestart);
  const restartedStore = structuredClone(noStoreStorage.raw.get("automaticBackups"));
  check("worker restart retries an initial snapshot when the previous no-store attempt was not ready",
    waitedWithoutStore
      && restartedStore.schemaVersion === 1
      && restartedStore.backups.length === 1
      && (await noStoreAlarms.api.get("hachidori-automatic-backup"))?.scheduledTime === now + day,
    JSON.stringify({ waitedWithoutStore, restartedStore,
      alarm: await noStoreAlarms.api.get("hachidori-automatic-backup") }));

  // The saved automaticBackupDays option decides how many daily snapshots the
  // next write retains; lowering it prunes at that write, not immediately.
  const retentionReconcile = () => runInContext("reconcileAutomaticBackups()", noStoreRestart);
  noStoreStorage.raw.set("options", { revision: 2, automaticBackupDays: 3 });
  for (let index = 0; index < 3; index += 1) {
    now += day;
    await retentionReconcile();
  }
  const threeDayStore = structuredClone(noStoreStorage.raw.get("automaticBackups"));
  const threeDayListed = await makeChrome("automatic-backup-retention-settings", noStoreRestartBus, noStoreStorage, noStoreAlarms)
    .runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_backup_auto_list" });
  noStoreStorage.raw.set("options", { revision: 3, automaticBackupDays: 1 });
  const beforeLowered = structuredClone(noStoreStorage.raw.get("automaticBackups"));
  now += day;
  await retentionReconcile();
  const loweredStore = structuredClone(noStoreStorage.raw.get("automaticBackups"));
  check("automatic backups retain the configured number of daily snapshots and prune to a lowered count on the next snapshot",
    threeDayStore.backups.length === 3
      && Date.parse(threeDayStore.backups[0].createdAt) === now - day
      && Date.parse(threeDayStore.backups[2].createdAt) === now - 3 * day
      && threeDayListed?.ok === true && threeDayListed.backups.length === 3
      && JSON.stringify(beforeLowered) === JSON.stringify(threeDayStore)
      && loweredStore.backups.length === 1
      && Date.parse(loweredStore.backups[0].createdAt) === now,
    JSON.stringify({ threeDay: threeDayStore.backups.map(record => record.createdAt), threeDayListed,
      lowered: loweredStore.backups.map(record => record.createdAt) }));
}

async function backupRelayStage() {
  const results = [];
  for (const prepareType of ["hd_backup_prepare", "hd_backup_auto_prepare"]) {
    for (const retry of [false, true]) {
    const bus = makeBus(), storage = makeStorage();
    const chrome = makeChrome("backup-relay", bus, storage);
    const sent = [], backoffs = [];
    let releaseStartup, reachedStartup, releaseCancel, fail = retry;
    const startup = new Promise(resolve => { reachedStartup = resolve; });
    chrome.runtime.getContexts = async () => {
      if (retry || releaseStartup) return [{}];
      return new Promise(resolve => { releaseStartup = () => resolve([{}]); reachedStartup(); });
    };
    chrome.runtime.sendMessage = async message => {
      sent.push(message.type);
      if (message.type === prepareType && fail) { fail = false; return undefined; }
      if (message.type === "hd_backup_cancel" && !releaseCancel) {
        return new Promise(resolve => { releaseCancel = () => resolve({ ok: true }); });
      }
      return { ok: true };
    };
    loadBackgroundScript({ chrome, console, clearTimeout, Promise, Error,
      setTimeout: resolve => backoffs.push(resolve) });
    const send = (type, token = "departed-page") => bus.sendMessage("backup-settings", { target: "hoshidicts-offscreen", type, token });
    const pending = send(prepareType);
    if (retry) {
      for (let i = 0; i < 20 && backoffs.length === 0; i++) await Promise.resolve();
      if (backoffs.length === 0) throw new Error("Backup relay did not reach its retry");
    } else await startup;
    const cancelled = send("hd_backup_cancel");
    const otherCancelled = send("hd_backup_cancel", "stale-preview");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const waitedForPreparation = sent.filter(type => type === "hd_backup_cancel").length === 0;
    if (retry) backoffs.shift()();
    else releaseStartup();
    const reply = await pending;
    for (let i = 0; i < 20 && !releaseCancel; i++) await Promise.resolve();
    if (!releaseCancel) throw new Error("Backup cancellation did not reach the engine");
    const serialized = sent.filter(type => type === "hd_backup_cancel").length === 1;
    releaseCancel();
    await Promise.all([cancelled, otherCancelled]);
    results.push(waitedForPreparation && serialized && reply.status === "cancelled"
      && sent.filter(type => type === prepareType).length === Number(retry)
      && sent.filter(type => type === "hd_backup_cancel").length === 2);
    }
  }
  check("manual and automatic backup cancellation retire delayed startup and lost-reply retries before they can recreate staging",
    results.every(Boolean));
}

async function backupLifecyclePortStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("backup-lifecycle", bus, storage);
  chrome.runtime.getContexts = async () => [{}];
  const sent = [];
  let releasePreparation;
  chrome.runtime.sendMessage = message => {
    sent.push(message.type);
    if (message.type === "hd_backup_prepare") {
      return new Promise(resolve => { releasePreparation = () => resolve({ ok: true }); });
    }
    return Promise.resolve({ ok: true });
  };
  loadBackgroundScript({ chrome, console, clearTimeout, setTimeout, Promise, Error });

  const onMessage = makeEvent(), onDisconnect = makeEvent();
  chrome.__events.onConnect.fire({
    name: "hachidori-backup-settings",
    sender: { id: chrome.runtime.id, url: chrome.runtime.getURL("settings.html") },
    onMessage,
    onDisconnect,
    disconnect() {},
  });
  onMessage.fire({ type: "track", token: "departed-page", active: true });
  const pending = bus.sendMessage("backup-settings", {
    target: "hoshidicts-offscreen", type: "hd_backup_prepare", token: "departed-page",
  });
  for (let i = 0; i < 20 && !releasePreparation; i++) await Promise.resolve();
  if (!releasePreparation) throw new Error("Backup preparation did not reach the engine");
  onDisconnect.fire();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const waitedForPreparation = sent.filter(type => type === "hd_backup_cancel").length === 0;
  releasePreparation();
  await pending;
  for (let i = 0; i < 20 && sent.filter(type => type === "hd_backup_cancel").length === 0; i++) {
    await Promise.resolve();
  }

  let refused = false;
  chrome.__events.onConnect.fire({
    name: "hachidori-backup-settings",
    sender: { id: chrome.runtime.id, url: chrome.runtime.getURL("startup.html") },
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    disconnect() { refused = true; },
  });
  check("Settings backup ownership cleans prepared files on port disconnect and refuses other extension pages",
    waitedForPreparation && sent.filter(type => type === "hd_backup_cancel").length === 1 && refused,
    JSON.stringify({ sent, waitedForPreparation, refused }));
}

async function settingsBackupRetentionStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/settings.html#backup`,
  });
  const { window } = dom;
  const document = window.document;
  let storedOptions = { revision: 1, automaticBackupDays: 7 };
  const writes = [];
  window.chrome = {
    runtime: {
      id: "hachidoribackupretentionsmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          return { ok: true, state: { schemaVersion: 1, revision: 1, dictionaries: [], groups: [] } };
        }
        if (message.type === "hd_status") return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
        if (message.type === "hd_backup_auto_list") return { ok: true, backups: [], corruptCount: 0 };
        if (message.type === "hd_options_write") {
          writes.push(structuredClone(message.options));
          storedOptions = { ...storedOptions, ...message.options, revision: storedOptions.revision + 1 };
          return { ok: true, options: structuredClone(storedOptions) };
        }
        throw new Error(`unexpected backup retention request ${message.type}`);
      },
    },
    storage: {
      local: { async get() { return { options: structuredClone(storedOptions) }; } },
      onChanged: { addListener() {} },
    },
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((done) => window.setTimeout(done, 5));
    }
  };
  try {
    loadSettingsScript(window);
    await waitFor(() => document.getElementById("engine-status")?.textContent?.startsWith("Ready"));
    const input = document.getElementById("opt-automatic-backup-days");
    const result = { section: input?.closest("section")?.id, rendered: input?.value, min: input?.min, max: input?.max };
    input.value = "5";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => writes.length === 1);
    result.afterFive = input.value;
    const status = () => document.querySelector("#backup #options-status")?.textContent;
    await waitFor(() => status() === "Saved.");
    result.status = status();
    input.value = "99";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => writes.length === 2);
    result.afterClamp = input.value;
    result.writes = writes;
    return result;
  } finally {
    window.close();
  }
}

describe("backups", () => {
  test("backup relay", async () => {
    await backupRelayStage();
  });

  test("backup lifecycle port", async () => {
    await backupLifecyclePortStage();
  });

  test("automatic backups in the worker", async () => {
    await automaticBackupBackgroundStage();
  });

  test("Settings backup retention", async () => {
    const backupRetention = await settingsBackupRetentionStage();
    check("the Backup section saves the automatic snapshot retention, says so and clamps it to the shared option range",
      backupRetention?.section === "backup"
        && backupRetention.status === "Saved."
        && backupRetention.rendered === "7"
        && backupRetention.min === "1" && backupRetention.max === "30"
        && backupRetention.afterFive === "5"
        && backupRetention.afterClamp === "30"
        && JSON.stringify(backupRetention.writes) === JSON.stringify([{ automaticBackupDays: 5 }, { automaticBackupDays: 30 }]),
      JSON.stringify(backupRetention));
  });
});
