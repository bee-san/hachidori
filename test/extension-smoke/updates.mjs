/*
 * Managed dictionary updates: the schedule, checks and Settings controls.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { runInContext } from "node:vm";
import { backupRevisions } from "../../extension/backup-state.js";
import {
  EXTENSION,
  EXTENSION_ORIGIN,
  genericPackage,
  loadBackgroundScript,
  loadJsdom,
  loadSettingsScript,
  makeAlarms,
  makeBus,
  makeChrome,
  makeStorage,
} from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function managedCheckStage() {
  const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
  const chrome = makeChrome("check-worker", bus, storage, alarms);
  const dictionaries = ["first", "second"].map((id, index) => genericPackage({
    id, title: id, path: `/dicts/${id}`, revision: "test-1", enabled: index === 0,
    isUpdatable: true, indexUrl: `https://example.com/${id}.json`, downloadUrl: `https://example.com/${id}.zip`,
  }));
  await chrome.storage.local.set({ dictionaryState: { schemaVersion: 1, revision: 1, groups: [], dictionaries },
    dictionaryUpdates: { revision: 1, schedule: "off", lastCheckedAt: null } });
  const fetched = [], relayed = [];
  bus.addListener("check-engine", (message, _sender, sendResponse) => {
    if (message?.target !== "hoshidicts-offscreen" || message.relayed !== true) return false;
    relayed.push(message.type);
    sendResponse({ type: `${message.type}_result`, requestId: message.requestId, ok: true });
    return true;
  });
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, Promise, Error, TypeError,
    fetch: async url => {
      fetched.push(url);
      return { ok: true, url, json: async () => ({ revision: "test-2" }) };
    } });
  const send = fields => bus.sendMessage("check-page", { target: "hachidori-updates", type: "hd_updates_check", ...fields });
  const selected = await send({ dictionaryIds: ["second"] });
  const selectedState = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
  check("a scoped check requests one index and changes only that package's check status without importing",
    selected.ok && selected.outcomes.length === 1 && selected.outcomes[0].id === "second"
      && JSON.stringify(fetched) === JSON.stringify([dictionaries[1].indexUrl])
      && JSON.stringify(selectedState.dictionaries[0]) === JSON.stringify(dictionaries[0])
      && selectedState.dictionaries[1].lastUpdateCheck?.status === "update-available"
      && selectedState.dictionaries.every((entry, index) => entry.revision === dictionaries[index].revision
        && entry.path === dictionaries[index].path)
      && !relayed.includes("hd_import"),
    JSON.stringify({ selected, selectedState, fetched, relayed }));
  fetched.length = 0;
  const all = await send({});
  const allState = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
  check("Check now checks all managed indexes but never imports or changes installed revisions when newer indexes exist",
    all.ok && all.outcomes.length === 2
      && JSON.stringify(fetched) === JSON.stringify(dictionaries.map(entry => entry.indexUrl))
      && allState.dictionaries.every((entry, index) => entry.lastUpdateCheck?.status === "update-available"
        && entry.revision === dictionaries[index].revision && entry.path === dictionaries[index].path)
      && !relayed.includes("hd_import"),
    JSON.stringify({ all, allState, fetched, relayed }));
  fetched.length = 0;
  const empty = await send({ dictionaryIds: [] });
  const invalid = await Promise.all([null, "second", {}].map(dictionaryIds => send({ dictionaryIds })));
  check("scoped checks accept an empty selection and reject non-array selections before fetching",
    empty.ok && empty.outcomes.length === 0 && invalid.every(reply => !reply.ok && /dictionary IDs/u.test(reply.error))
      && fetched.length === 0, JSON.stringify({ empty, invalid, fetched }));
}

async function managedScheduleStage() {
  let now = Date.parse("2026-09-07T12:00:00Z");
  const hour = 3_600_000;
  class ScheduleDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
  const chrome = makeChrome("schedule-worker", bus, storage, alarms);
  const dictionary = (id, override, age, enabled = true) => genericPackage({ id, title: id, path: `/dicts/${id}`, revision: "1",
    isUpdatable: true, enabled, updateScheduleOverride: override,
    indexUrl: `https://example.com/${id}.json`, downloadUrl: `https://example.com/${id}.zip`,
    lastUpdateCheck: { checkedAt: new Date(now - age * hour).toISOString(), status: "up-to-date" } });
  await chrome.storage.local.set({ dictionaryState: { schemaVersion: 1, revision: 1, groups: [], dictionaries: [
    dictionary("hourly", "hourly", 2, false), dictionary("daily", null, 2), dictionary("off", "off", 48),
  ] }, dictionaryUpdates: { revision: 1, schedule: "daily", lastCheckedAt: null } });
  const fetched = [];
  let fail = false, onFetch = async () => {};
  const context = loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, Promise, Error, Date: ScheduleDate,
    fetch: async url => {
      fetched.push(url);
      await onFetch(url);
      return { ok: !fail, status: fail ? 503 : 200, url, json: async () => ({ revision: "1" }) };
    } });
  await runInContext("initialiseUpdateAlarm()", context);
  const name = "hachidori-managed-dictionary-updates";
  check("an overdue scheduled package creates an immediate alarm", (await alarms.api.get(name))?.scheduledTime === now);
  const firstAlarm = await alarms.api.get(name);
  now += 100;
  await runInContext("reconcileUpdateAlarm()", context);
  check("reconciling an already-due alarm does not postpone its browser delivery",
    (await alarms.api.get(name))?.scheduledTime === firstAlarm.scheduledTime);
  const cycle = () => runInContext("queueManagedUpdate({ install: true, dueOnly: true })", context);
  await cycle();
  let saved = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
  const managedAlarms = [...alarms.values.values()].filter(alarm => alarm.name === name);
  check("per-dictionary schedules check only due managed packages including disabled overrides",
    JSON.stringify(fetched) === JSON.stringify(["https://example.com/hourly.json"])
      && saved.dictionaries[0].enabled === false && saved.dictionaries[0].lastUpdateCheck.checkedAt === new Date(now).toISOString()
      && (await alarms.api.get(name))?.scheduledTime === now + hour && managedAlarms.length === 1,
    JSON.stringify({ fetched, saved, alarms: [...alarms.values.values()] }));
  const writes = storage.sets.length;
  await cycle();
  check("an early scheduled wake does not fetch or write state", fetched.length === 1 && storage.sets.length === writes);

  await bus.sendMessage("schedule-page", { target: "hachidori-updates", type: "hd_updates_check" });
  check("manual Check now still checks Off and not-yet-due dictionary policies", fetched.length === 4);
  saved = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
  const changed = { ...saved, revision: saved.revision + 1,
    dictionaries: saved.dictionaries.map(entry => ({ ...entry, lastUpdateCheck: null })) };
  await chrome.storage.local.set({ dictionaryState: changed,
    dictionaryUpdates: { revision: 10, schedule: "off", lastCheckedAt: null } });
  fail = true;
  await cycle();
  saved = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
  check("explicit schedules survive global Off and failed checks advance their due time",
    fetched.length === 5 && saved.dictionaries[0].lastUpdateCheck.status === "check-failed"
      && (await alarms.api.get(name))?.scheduledTime === now + hour);

  // A policy may change while a preceding dictionary's fetch is in flight.
  fail = false;
  await chrome.storage.local.set({ dictionaryState: { ...saved, revision: saved.revision + 1,
    dictionaries: saved.dictionaries.slice(0, 2).map(entry => ({ ...entry, updateScheduleOverride: "hourly", lastUpdateCheck: null })) } });
  onFetch = async () => {
    const state = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
    await chrome.storage.local.set({ dictionaryState: { ...state, revision: state.revision + 1,
      dictionaries: state.dictionaries.map(entry => entry.id === "daily" ? { ...entry, updateScheduleOverride: "off" } : entry) } });
  };
  await cycle();
  check("scheduled work rechecks a later package policy before fetching", fetched.length === 6 && fetched.at(-1).includes("hourly"));
  await alarms.api.clear(name);
  await runInContext("initialiseUpdateAlarm()", context);
  check("worker startup restores the same next-due alarm without a periodic polling interval",
    (await alarms.api.get(name))?.scheduledTime === now + hour && (await alarms.api.get(name))?.periodInMinutes === undefined);

  const settleAlarm = async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    await runInContext("alarmTail", context);
  };
  await settleAlarm();
  const originalGet = alarms.api.get;
  let alarmReads = 0;
  alarms.api.get = (...args) => { if (args[0] === name) alarmReads += 1; return originalGet(...args); };
  const schedule = async value => bus.sendMessage("schedule-page", { target: "hachidori-updates", type: "hd_updates_schedule",
    baseRevision: (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates.revision, schedule: value });
  await schedule("daily");
  await settleAlarm();
  const savedReads = alarmReads, savedWrites = storage.sets.length;
  await schedule("daily");
  await settleAlarm();
  check("global schedule saves and no-op retries each reconcile exactly once",
    savedReads === 1 && alarmReads === 2 && storage.sets.length === savedWrites,
    JSON.stringify({ savedReads, alarmReads, savedWrites, writes: storage.sets.length }));

  const base = (await bus.sendMessage("schedule-page", { target: "hoshidicts-worker", type: "hd_backup_base_read" })).snapshot;
  const snapshot = (await bus.sendMessage("schedule-page", { target: "hoshidicts-worker", type: "hd_backup_read" })).snapshot;
  for (const [key, revision] of Object.entries(backupRevisions(base))) snapshot[key].revision = revision + 1;
  snapshot.lookupStats.generation = crypto.randomUUID();
  snapshot.updates.schedule = "weekly";
  const beforeRestoreReads = alarmReads;
  const restored = await bus.sendMessage("schedule-offscreen", { target: "hoshidicts-worker", type: "hd_backup_cas", base, snapshot, lookupStatsRows: [] },
    { id: chrome.runtime.id, url: chrome.runtime.getURL("offscreen.html") });
  await settleAlarm();
  check("backup schedule-only publication reconciles without relying on a settings storage event",
    restored.ok && alarmReads === beforeRestoreReads + 1, JSON.stringify({ restored, alarmReads, beforeRestoreReads }));

  await chrome.storage.local.set({ dictionaryState: { ...snapshot.state, revision: snapshot.state.revision + 1, dictionaries: [] },
    dictionaryUpdates: { ...snapshot.updates, revision: snapshot.updates.revision + 1, lastCheckedAt: null } });
  const manual = await bus.sendMessage("schedule-page", { target: "hachidori-updates", type: "hd_updates_check" });
  check("manual Check now records completion even when no managed dictionary is installed",
    manual.ok && manual.outcomes.length === 0 && manual.settings.lastCheckedAt === new Date(now).toISOString(), JSON.stringify(manual));
}

async function settingsManagedUpdatesStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: `${EXTENSION_ORIGIN}/settings.html`,
  });
  const { window } = dom;
  let state = {
    schemaVersion: 1,
    revision: 4,
    dictionaries: [
      genericPackage({
        id: "managed-id",
        title: "Managed terms",
        updateScheduleOverride: "monthly",
        enabled: false,
        isUpdatable: true,
        indexUrl: "https://example.test/managed/index.json",
        downloadUrl: "https://example.test/managed/archive.zip",
        lastUpdateCheck: {
          checkedAt: "2026-09-04T10:00:00.000Z",
          status: "update-available",
          remoteRevision: "test-2",
          error: null,
        },
      }),
      genericPackage({
        id: "insecure-id",
        title: "Insecure source",
        isUpdatable: true,
        indexUrl: "http://example.test/insecure/index.json",
        downloadUrl: "http://example.test/insecure/archive.zip",
        lastUpdateCheck: {
          checkedAt: "2026-09-04T10:00:00.000Z",
          status: "update-available",
          remoteRevision: "test-2",
          error: null,
        },
      }),
      genericPackage({ id: "local-id", title: "Local terms" }),
    ],
    groups: [],
  };
  let updateSettings = { revision: 0, schedule: "off", lastCheckedAt: "2026-09-04T10:00:00.000Z" };
  let storageListener = null;
  const updateRequests = [];
  const stateRequests = [];
  let heldSchedule = null, activeSchedules = 0, heldState = null;
  let loseScheduleReply = false, firstRead = true;
  let releaseInitialRead;

  const publishState = (dictionary) => {
    state = {
      ...state,
      revision: state.revision + 1,
      dictionaries: state.dictionaries.map((entry) => entry.id === dictionary.id ? dictionary : entry),
    };
    storageListener?.({ dictionaryState: { newValue: structuredClone(state) } }, "local");
  };
  window.chrome = {
    runtime: {
      id: "hachidoriupdatessettingssmoke",
      async sendMessage(message) {
        if (message.type === "hd_state_read") {
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_status") {
          return { ok: true, ready: true, loading: false, dictionaryCount: 1 };
        }
        if (message.type === "hd_state_cas") {
          stateRequests.push(structuredClone(message));
          if (message.baseRevision !== state.revision) return { ok: false, conflict: true, state: structuredClone(state) };
          state = { ...state, revision: state.revision + 1, dictionaries: message.dictionaries, groups: message.groups };
          storageListener({ dictionaryState: { newValue: structuredClone(state) } }, "local");
          if (heldState) await heldState.promise;
          return { ok: true, state: structuredClone(state) };
        }
        if (message.type === "hd_options_write") {
          return { ok: true, options: structuredClone(message.options) };
        }
        if (message.type === "hd_updates_schedule") {
          updateRequests.push(structuredClone(message));
          if (message.baseRevision !== updateSettings.revision) return { ok: false, error: "Schedule changed elsewhere", settings: structuredClone(updateSettings) };
          activeSchedules++;
          if (updateSettings.schedule !== message.schedule) {
            updateSettings = { ...updateSettings, revision: updateSettings.revision + 1, schedule: message.schedule };
          }
          storageListener?.({
            dictionaryUpdates: { newValue: structuredClone(updateSettings) },
          }, "local");
          const reply = { ok: true, settings: structuredClone(updateSettings) };
          if (heldSchedule) await heldSchedule.promise;
          activeSchedules--;
          if (loseScheduleReply) {
            loseScheduleReply = false;
            throw new Error("simulated lost schedule reply");
          }
          return reply;
        }
        if (message.type === "hd_updates_check") {
          updateRequests.push(structuredClone(message));
          await new Promise((done) => window.setTimeout(done, 0));
          const managed = state.dictionaries.find((entry) => entry.id === "managed-id");
          publishState({
            ...managed,
            lastUpdateCheck: {
              checkedAt: "2026-09-04T11:00:00.000Z",
              status: "update-available",
              remoteRevision: "test-2",
              error: null,
            },
          });
          updateSettings = { ...updateSettings, revision: updateSettings.revision + 1, lastCheckedAt: "2026-09-04T11:00:00.000Z" };
          storageListener?.({
            dictionaryUpdates: { newValue: structuredClone(updateSettings) },
          }, "local");
          return {
            ok: true,
            settings: structuredClone(updateSettings),
            outcomes: [{ id: "managed-id", status: "update-available" }],
          };
        }
        if (message.type === "hd_updates_install") {
          updateRequests.push(structuredClone(message));
          await new Promise((done) => window.setTimeout(done, 0));
          const managed = state.dictionaries.find((entry) => entry.id === "managed-id");
          publishState({
            ...managed,
            revision: "test-2",
            lastUpdateCheck: {
              checkedAt: "2026-09-04T11:05:00.000Z",
              status: "up-to-date",
              remoteRevision: "test-2",
              error: null,
            },
          });
          return {
            ok: true,
            settings: structuredClone(updateSettings),
            outcomes: [{ id: "managed-id", status: "updated" }],
          };
        }
        throw new Error(`unexpected managed-update settings request ${message.type}`);
      },
    },
    storage: {
      local: {
        async get() {
          const captured = structuredClone(updateSettings);
          if (firstRead) {
            firstRead = false;
            await new Promise(done => { releaseInitialRead = done; });
            updateSettings = { ...updateSettings, revision: 1, schedule: "weekly" };
            storageListener({ dictionaryUpdates: { newValue: structuredClone(updateSettings) } }, "local");
            await new Promise(done => window.setTimeout(done, 0));
          }
          return {
            options: { kanjiClickDictionary: "" },
            dictionaryUpdates: captured,
          };
        },
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        },
      },
    },
  };
  loadSettingsScript(window);

  const initialReadBlocked = window.document.getElementById("update-schedule").disabled;
  releaseInitialRead();

  await waitSchedule(() => window.document.getElementById("engine-status")?.textContent?.startsWith("Ready"));
  const managedRow = () => window.document.querySelector('[data-dictionary-id="managed-id"]');
  const insecureRow = () => window.document.querySelector('[data-dictionary-id="insecure-id"]');
  const localRow = () => window.document.querySelector('[data-dictionary-id="local-id"]');
  const result = {
    initialReadBlocked,
    initial: {
      schedule: window.document.getElementById("update-schedule")?.value,
      lastChecked: window.document.getElementById("update-last-checked")?.textContent ?? "",
      managedStatus: managedRow()?.querySelector(".dict-update-status")?.textContent ?? "",
      managedUpdateHidden: managedRow()?.querySelector(".dict-update")?.hidden,
      managedCheckHidden: managedRow()?.querySelector(".dict-update-check")?.hidden,
      insecureMetadata: insecureRow()?.querySelector(".dict-metadata")?.textContent ?? "",
      insecureStatus: insecureRow()?.querySelector(".dict-update-status")?.textContent ?? "",
      insecureUpdateHidden: insecureRow()?.querySelector(".dict-update")?.hidden,
      insecureCheckHidden: insecureRow()?.querySelector(".dict-update-check")?.hidden,
      localStatus: localRow()?.querySelector(".dict-update-status")?.textContent ?? "",
      localUpdateHidden: localRow()?.querySelector(".dict-update")?.hidden,
      localCheckHidden: localRow()?.querySelector(".dict-update-check")?.hidden,
    },
  };

  window.document.getElementById("update-check-now")?.click();
  await waitSchedule(() => updateRequests.some((request) => request.type === "hd_updates_check"));
  await waitSchedule(() => !window.document.getElementById("update-check-now")?.disabled);
  result.checkRequest = updateRequests.find((request) => request.type === "hd_updates_check");
  result.checkedState = window.document.getElementById("update-state")?.textContent ?? "";

  managedRow()?.querySelector(".dict-update-check")?.click();
  result.rowCheckDisabled = managedRow()?.querySelector(".dict-update-check")?.disabled;
  await waitSchedule(() => updateRequests.filter(request => request.type === "hd_updates_check").length === 2);
  await waitSchedule(() => !window.document.getElementById("update-check-now")?.disabled);
  result.rowCheckRequest = updateRequests.filter(request => request.type === "hd_updates_check")[1];
  result.rowCheckedState = window.document.getElementById("update-state")?.textContent ?? "";

  managedRow()?.querySelector(".dict-update")?.click();
  await waitSchedule(() => updateRequests.filter((request) => request.type === "hd_updates_install").length >= 1);
  await waitSchedule(() => managedRow()?.querySelector(".dict-update-status")?.textContent?.startsWith("Up to date"));
  result.oneRequest = updateRequests.find((request) => request.type === "hd_updates_install");
  result.afterOneStatus = managedRow()?.querySelector(".dict-update-status")?.textContent ?? "";

  const managed = state.dictionaries.find((entry) => entry.id === "managed-id");
  publishState({
    ...managed,
    revision: "test-1",
    lastUpdateCheck: {
      checkedAt: "2026-09-04T12:00:00.000Z",
      status: "update-available",
      remoteRevision: "test-2",
      error: null,
    },
  });
  await new Promise((done) => window.setTimeout(done, 0));
  window.document.getElementById("update-all")?.click();
  await waitSchedule(() => updateRequests.filter((request) => request.type === "hd_updates_install").length >= 2);
  await waitSchedule(() => !window.document.getElementById("update-check-now")?.disabled);
  result.allRequest = updateRequests.filter((request) => request.type === "hd_updates_install")[1];

  const schedule = window.document.getElementById("update-schedule");
  if (schedule) {
    schedule.value = "daily";
    schedule.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  await waitSchedule(() => updateRequests.some((request) => request.type === "hd_updates_schedule"));
  await new Promise((done) => window.setTimeout(done, 0));
  result.scheduleRequest = updateRequests.find((request) => request.type === "hd_updates_schedule");

  const chooseSchedule = value => { schedule.value = value; schedule.dispatchEvent(new window.Event("change", { bubbles: true })); };
  const scheduleRequests = () => updateRequests.filter(request => request.type === "hd_updates_schedule");
  const pause = ms => new Promise(done => window.setTimeout(done, ms));
  async function waitSchedule(predicate) {
    const until = Date.now() + 2000;
    while (!predicate() && Date.now() < until) await new Promise(done => window.setTimeout(done, 5));
  }
  heldSchedule = Promise.withResolvers();
  chooseSchedule("hourly");
  await waitSchedule(() => activeSchedules === 1);
  updateSettings = { ...updateSettings, revision: updateSettings.revision + 1, schedule: "weekly" };
  storageListener({ dictionaryUpdates: { newValue: structuredClone(updateSettings) } }, "local");
  heldSchedule.resolve();
  heldSchedule = null;
  await waitSchedule(() => activeSchedules === 0);
  await pause(0);
  result.newerSchedule = schedule.value;

  const beforeCoalescing = scheduleRequests().length;
  for (const value of ["off", "hourly", "daily"]) chooseSchedule(value);
  result.queuedNotice = window.document.getElementById("nav-status-dictionaries").textContent.includes("Updates: Unsaved schedule");
  await pause(250);
  result.coalesced = scheduleRequests().length === beforeCoalescing + 1 && updateSettings.schedule === "daily";

  const beforeQueued = scheduleRequests().length;
  heldSchedule = Promise.withResolvers();
  chooseSchedule("hourly");
  await waitSchedule(() => activeSchedules === 1);
  chooseSchedule("weekly");
  chooseSchedule("monthly");
  await pause(250);
  result.serialized = activeSchedules === 1 && scheduleRequests().length === beforeQueued + 1;
  heldSchedule.resolve();
  heldSchedule = null;
  await waitSchedule(() => activeSchedules === 0 && updateSettings.schedule === "monthly");
  await pause(0);
  result.finalSchedule = schedule.value;

  const conflictActions = window.document.getElementById("update-schedule-conflict-actions");
  loseScheduleReply = true;
  chooseSchedule("off");
  await waitSchedule(() => !conflictActions.hidden);
  const lostRevision = updateSettings.revision;
  result.lostReplyRetained = schedule.value === "off" && !conflictActions.hidden;
  window.document.getElementById("update-schedule-retry").click();
  await waitSchedule(() => conflictActions.hidden && activeSchedules === 0);
  await pause(0);
  result.retryNoWrite = updateSettings.revision === lostRevision && updateSettings.schedule === "off";

  chooseSchedule("hourly");
  updateSettings = { ...updateSettings, revision: updateSettings.revision + 1, schedule: "daily" };
  storageListener({ dictionaryUpdates: { newValue: structuredClone(updateSettings) } }, "local");
  await waitSchedule(() => !conflictActions.hidden);
  const beforeDiscard = scheduleRequests().length;
  window.document.getElementById("update-schedule-discard").click();
  await pause(200);
  result.discarded = schedule.value === "daily" && conflictActions.hidden
    && scheduleRequests().length === beforeDiscard && updateSettings.schedule === "daily";
  const policy = () => managedRow()?.querySelector(".dict-update-schedule");
  result.dictionarySchedule = false;
  if (policy()) {
    const initial = policy().value === "monthly" && !policy().disabled
      && insecureRow().querySelector(".dict-schedule").hidden && localRow().querySelector(".dict-schedule").hidden;
    policy().focus();
    heldState = Promise.withResolvers();
    policy().value = "hourly";
    policy().dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitSchedule(() => stateRequests.length === 1);
    const editBlockedDuringSave = policy().disabled;
    heldState.resolve();
    heldState = null;
    await waitSchedule(() => stateRequests.length === 1 && !policy().disabled);
    const saved = state.dictionaries.find(entry => entry.id === "managed-id");
    const persisted = saved.updateScheduleOverride === "hourly" && saved.enabled === false
      && stateRequests[0].target === "hoshidicts-worker" && policy().value === "hourly"
      && window.document.activeElement === policy();
    const stale = policy();
    stale.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    publishState({ ...saved, updateScheduleOverride: "weekly" });
    stale.value = "off";
    stale.dispatchEvent(new window.Event("change", { bubbles: true }));
    await pause(20);
    result.dictionarySchedule = initial && persisted && editBlockedDuringSave && stateRequests.length === 1
      && state.dictionaries.find(entry => entry.id === "managed-id").updateScheduleOverride === "weekly"
      && stale.isConnected && policy().value === "weekly" && managedRow().querySelector(".dict-next-check").textContent.startsWith("Weekly");
    window.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true }));
  }
  dom.window.close();
  return result;
}

describe("managed updates", () => {
  test("managed update schedule", async () => {
    await managedScheduleStage();
  });

  test("managed update checks", async () => {
    await managedCheckStage();
  });

  test("Settings managed update controls", async () => {
    const managedUpdateSettings = await settingsManagedUpdatesStage();
    check(
      "settings expose one global schedule and per-package managed update actions",
      managedUpdateSettings?.initial.schedule === "weekly"
        && managedUpdateSettings.initial.lastChecked.includes("9/4/2026")
        && managedUpdateSettings.initial.managedStatus.includes("Update available")
        && managedUpdateSettings.initial.managedUpdateHidden === false
        && managedUpdateSettings.initial.managedCheckHidden === false
        && managedUpdateSettings.initial.insecureMetadata.includes("Local archive")
        && managedUpdateSettings.initial.insecureStatus === "Not update-checkable"
        && managedUpdateSettings.initial.insecureUpdateHidden === true
        && managedUpdateSettings.initial.insecureCheckHidden === true
        && managedUpdateSettings.initial.localStatus === "Not update-checkable"
        && managedUpdateSettings.initial.localUpdateHidden === true
        && managedUpdateSettings.initial.localCheckHidden === true
        && managedUpdateSettings.checkRequest?.type === "hd_updates_check"
        && managedUpdateSettings.checkRequest.dictionaryIds === undefined
        && managedUpdateSettings.checkedState.includes("1 update available")
        && managedUpdateSettings.rowCheckRequest?.dictionaryIds?.join(",") === "managed-id"
        && managedUpdateSettings.rowCheckDisabled === true
        && managedUpdateSettings.rowCheckedState === "Checked 1 managed dictionary — 1 update available, 0 failed."
        && managedUpdateSettings.oneRequest?.type === "hd_updates_install"
        && managedUpdateSettings.oneRequest.dictionaryIds?.join(",") === "managed-id"
        && managedUpdateSettings.afterOneStatus.startsWith("Up to date")
        && managedUpdateSettings.allRequest?.type === "hd_updates_install"
        && managedUpdateSettings.allRequest.dictionaryIds?.join(",") === "managed-id"
        && managedUpdateSettings.scheduleRequest?.type === "hd_updates_schedule"
        && managedUpdateSettings.scheduleRequest.schedule === "daily",
      JSON.stringify(managedUpdateSettings),
    );
    check("managed schedule autosave coalesces edits, serializes requests and ignores an older saved reply",
      managedUpdateSettings?.newerSchedule === "weekly" && managedUpdateSettings.coalesced === true
        && managedUpdateSettings.serialized === true && managedUpdateSettings.finalSchedule === "monthly",
      JSON.stringify(managedUpdateSettings));
    check("managed schedule conflicts retain drafts, retry a lost reply without another write, and discard explicitly",
      managedUpdateSettings?.lostReplyRetained === true && managedUpdateSettings.retryNoWrite === true
        && managedUpdateSettings.discarded === true,
      JSON.stringify(managedUpdateSettings));
    check("managed schedule waits for its initial revision and exposes queued work outside Updates",
      managedUpdateSettings?.initialReadBlocked === true && managedUpdateSettings.queuedNotice === true,
      JSON.stringify(managedUpdateSettings));
    check("dictionary schedule controls persist only metadata, retain focus and refuse stale policy edits",
      managedUpdateSettings?.dictionarySchedule === true, JSON.stringify(managedUpdateSettings));
  });
});
