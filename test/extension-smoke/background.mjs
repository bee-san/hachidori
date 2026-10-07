/*
 * The service worker: hosting, alarms, external links, first run and overlay mode.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { runInContext } from "node:vm";
import { ANKI_INDEX_ALARM } from "../../extension/anki-index-cache.js";
import {
  RECOMMENDED_DICTIONARIES as RECOMMENDED_CATALOGUE,
} from "../../extension/recommended-dictionaries.js";
import {
  loadBackgroundScript,
  makeAlarms,
  makeBus,
  makeChrome,
  makeStorage,
  offscreenState,
} from "./fakes.mjs";
import { check, section, test } from "./harness.mjs";

async function hostedExtensionBackgroundStage() {
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("hosted-worker", bus, storage);
  delete chrome.alarms;
  delete chrome.downloads;
  delete chrome.offscreen;
  delete chrome.runtime.getContexts;
  Object.assign(offscreenState, { created: 0, exists: false, concurrent: 0, peakConcurrent: 0 });

  const relayed = [];
  bus.addListener("hosted-engine", (message, sender, sendResponse) => {
    if (message?.target !== "hoshidicts-offscreen" || message.relayed !== true) return false;
    relayed.push(structuredClone(message));
    sendResponse({
      type: `${message.type}_result`,
      requestId: message.requestId,
      ok: true,
      hosted: true,
    });
    return true;
  });

  let loadError = null;
  try {
    loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, Promise, Error });
  } catch (error) {
    loadError = error;
  }
  const reply = loadError === null
    ? await bus.sendMessage("hosted-page", {
        target: "hoshidicts-offscreen",
        type: "hd_status",
        requestId: "hosted-status",
      })
    : null;
  check(
    "a host-owned engine works without offscreen, alarm or download APIs",
    loadError === null
      && reply?.ok === true
      && reply.hosted === true
      && reply.requestId === "hosted-status"
      && relayed.length === 1
      && offscreenState.created === 0,
    JSON.stringify({ loadError: loadError?.message, reply, relayed, offscreenState }),
  );
}

// The Electron overlay host exposes chrome.alarms but never dispatches
// onAlarm, and a host may lack the API entirely; in both shapes the worker
// keeps one-shot alarms on its own timers so the duplicate-index refresh (and
// the other alarm consumers) still fire at their scheduled time.
async function timerAlarmsStage({ overlayMode, alarmsApi }) {
  const bus = makeBus(), storage = makeStorage(), hostAlarms = makeAlarms();
  const chrome = makeChrome(`timer-alarms-${overlayMode ? "overlay" : "bare"}-worker`, bus, storage, hostAlarms);
  if (!alarmsApi) delete chrome.alarms;
  delete chrome.downloads;
  delete chrome.offscreen;
  let clock = 1_800_000_000_000, nextTimer = 1, resumes = 0;
  const timers = new Map();
  const context = loadBackgroundScript({
    chrome, console, Promise, Error,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    createAnkiDuplicateIndex: () => ({
      async reconcile() {}, async suspend() {}, async resume() { resumes += 1; },
      source: async () => null, async peek() { return { noteIds: [] }; }, async lookup() {}, async repair() {},
      async recordWrite() {}, async has() { return false; },
    }),
  }, { overlayMode });
  // Startup writes options in overlay mode, and the storage fake delivers that
  // onChanged event on a real zero-delay timer which then resumes the index.
  // A setImmediate loop can finish before that timer is due on a fast host, so
  // settle on the timer phase: a timer queued here runs after any already
  // pending one and after the microtasks that one started.
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  const fire = () => {
    const [id, timer] = [...timers].find(([, entry]) => entry.armed) ?? [];
    timers.delete(id);
    timer?.callback();
    return timer?.delay;
  };
  await settle();
  const before = resumes;
  const known = new Set(timers.keys());
  await runInContext(`alarms.create(${JSON.stringify(ANKI_INDEX_ALARM)}, { when: Date.now() + 60_000 })`, context);
  for (const [id, timer] of timers) if (!known.has(id)) timer.armed = true;
  const armed = await runInContext(`alarms.get(${JSON.stringify(ANKI_INDEX_ALARM)})`, context);
  const armedDelay = fire();
  await settle();
  const earlyResumes = resumes;
  for (const [id, timer] of timers) if (!known.has(id)) timer.armed = true;
  clock += 60_000;
  const rearmedDelay = fire();
  await settle();
  const afterFire = await runInContext(`alarms.get(${JSON.stringify(ANKI_INDEX_ALARM)})`, context);
  await runInContext(`alarms.create(${JSON.stringify(ANKI_INDEX_ALARM)}, { when: Date.now() + 5_000 })`, context);
  const cleared = await runInContext(`alarms.clear(${JSON.stringify(ANKI_INDEX_ALARM)})`, context);
  const clearedAgain = await runInContext(`alarms.clear(${JSON.stringify(ANKI_INDEX_ALARM)})`, context);
  check(
    `${overlayMode ? "an overlay host's inert chrome.alarms is bypassed:" : "without chrome.alarms"} a worker timer fires the index alarm handler at its scheduled time, not before`,
    armed?.scheduledTime === clock && armedDelay === 60_000 && earlyResumes === before
      && rearmedDelay === 60_000 && resumes === before + 1 && afterFire === undefined
      && cleared === true && clearedAgain === false && hostAlarms.values.size === 0,
    JSON.stringify({ armed, armedDelay, before, earlyResumes, rearmedDelay, resumes, afterFire, cleared, clearedAgain,
      hostAlarms: [...hostAlarms.values.keys()] }),
  );
}

async function externalLinksBackgroundStage() {
  const bus = makeBus();
  const storage = makeStorage();
  const chrome = makeChrome("external-links-worker", bus, storage);
  const tabs = [];
  chrome.tabs = { async create(properties) { tabs.push(structuredClone(properties)); return { id: tabs.length }; } };
  loadBackgroundScript({ chrome, console, URL, setTimeout, clearTimeout, Promise, Error });
  await bus.sendMessage("external-links-reader", {
    target: "hoshidicts-worker", type: "hd_state_read", requestId: "external-links-ready",
  });
  const send = (payload, sender = { id: chrome.runtime.id, tab: { windowId: 9 } }) => bus.sendMessage(
    "external-links-reader",
    { target: "hoshidicts-worker", type: "hd_open_external", requestId: "external-link", ...payload },
    sender,
  );
  const accepted = await send({ url: " HTTPS://EXAMPLE.COM:443/日本?q=1#term ", active: false, windowId: 99, openerTabId: 11 });
  const local = await send({ url: "http://127.0.0.1:9876/reference" });
  const rejected = [];
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/a",
    "chrome://settings",
    "/relative",
    "https:example.test/",
    "https:/example.test/",
    "https://",
    "https://user:pass@example.test/",
    "\nhttps://example.test/",
    "https://example.test/\r",
    "https://exam\nple.test/",
    { href: "https://example.test/" },
  ]) {
    rejected.push(await send({ url }));
  }
  rejected.push(await send({ url: "https://example.test/", active: "yes" }));
  rejected.push(await send({ url: "https://example.test/" }, { id: "another-extension" }));
  const validReply = reply => reply?.type === "hd_open_external_result" && reply.requestId === "external-link";
  check("external links validate HTTP URLs and sender identity before creating one browser-owned tab",
    accepted?.ok && accepted.opened === true && validReply(accepted)
      && local?.ok && validReply(local)
      && JSON.stringify(tabs) === JSON.stringify([
        { url: "https://example.com/%E6%97%A5%E6%9C%AC?q=1#term", active: false, windowId: 9 },
        { url: "http://127.0.0.1:9876/reference", active: true, windowId: 9 },
      ])
      && rejected.every(reply => validReply(reply) && reply.ok === false && typeof reply.error === "string"),
    JSON.stringify({ accepted, local, tabs, rejected }));

  const originalSet = chrome.storage.local.set;
  let releaseWrite;
  chrome.storage.local.set = items => new Promise((resolveWrite, rejectWrite) => {
    releaseWrite = () => originalSet(items).then(resolveWrite, rejectWrite);
  });
  const writing = bus.sendMessage("external-links-reader", {
    target: "hoshidicts-worker", type: "hd_options_write", requestId: "held-options-write",
    baseRevision: 0, options: { scanLength: 17 },
  });
  for (let attempt = 0; !releaseWrite && attempt < 100; attempt += 1) {
    await new Promise(resolveTimer => setTimeout(resolveTimer, 0));
  }
  if (!releaseWrite) throw new Error("the external-link test did not hold its options write");
  let externalSettled = false;
  const before = { reads: storage.gets.length, writes: storage.sets.length, engine: offscreenState.created };
  const opening = send({ url: "https://example.test/while-saving" }).then(reply => { externalSettled = reply?.ok === true; return reply; });
  await new Promise(resolveTimer => setTimeout(resolveTimer, 0));
  const independent = externalSettled && before.reads === storage.gets.length
    && before.writes === storage.sets.length && before.engine === offscreenState.created;
  releaseWrite();
  await writing;
  await opening;
  chrome.storage.local.set = originalSet;
  let failureAttempts = 0;
  chrome.tabs.create = async () => { failureAttempts += 1; throw new Error("tab creation failed"); };
  const failed = await send({ url: "https://example.test/failure" });
  check("external tab creation bypasses storage and engine queues and reports a failure without retry",
    independent && failureAttempts === 1 && failed?.ok === false && validReply(failed) && failed.error.includes("tab creation failed")
      && !bus.log.some(message => message.relayed),
    JSON.stringify({ independent, failed, log: bus.log }));
}

// A host that embeds Hachidori in an overlay has no tab for setup and wants
// hover lookups without a page highlight from the first launch.
async function overlayModeBackgroundStage() {
  const storage = makeStorage();
  const tabs = [];
  const tabsApi = { async create(properties) { tabs.push(structuredClone(properties)); return { id: tabs.length }; } };
  const start = (name, store) => {
    const bus = makeBus();
    const chrome = makeChrome(name, bus, store);
    chrome.__bus = bus;
    chrome.tabs = tabsApi;
    loadBackgroundScript({ chrome, console, URL, setTimeout, clearTimeout, Promise, Error }, { overlayMode: true });
    return chrome;
  };
  const settle = async (predicate = () => false) => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
    }
  };

  const chrome = start("overlay-worker", storage);
  chrome.__events.onInstalled.fire({ reason: "install" });
  await settle(() => storage.raw.has("options"));
  await settle();
  const seeded = storage.raw.get("options");
  const overlayAnki = globalThis.HDReaderOptions.normaliseOptions({ anki: {
    ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki,
    captureScreenshot: false,
  } }).anki;
  const seededOnce = tabs.length === 0 && !storage.raw.has("setupState")
    && JSON.stringify(seeded) === JSON.stringify({
      lookupMode: "hover", popupTheme: "auto",
      anki: overlayAnki,
      sourceHighlightEnabled: false,
      showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 2, revision: 1,
    });

  // The seeded values are defaults, not locks: a later edit survives a restarted worker.
  const edited = { ...seeded, lookupMode: "activation", sourceHighlightEnabled: true, revision: 2 };
  await storage.api().local.set({ options: edited });
  start("overlay-worker-restart", storage).__events.onInstalled.fire({ reason: "install" });
  await settle();
  const preserved = tabs.length === 0 && !storage.raw.has("setupState")
    && JSON.stringify(storage.raw.get("options")) === JSON.stringify(edited);

  // A profile carried from before overlay mode never chose a lookup mode, so it
  // reads on hover after one revisioned write. A legacy modifier is a choice.
  const carried = makeStorage();
  await carried.api().local.set({ options: { scanLength: 20, revision: 4 } });
  start("overlay-worker-carried", carried);
  await settle(() => carried.raw.get("options")?.revision !== 4);
  const legacy = makeStorage();
  await legacy.api().local.set({ options: { modifier: "ctrl", revision: 3 } });
  start("overlay-worker-legacy", legacy);
  await settle();
  const carriedHover = JSON.stringify(carried.raw.get("options"))
      === JSON.stringify({ scanLength: 20, revision: 5, lookupMode: "hover" })
    && JSON.stringify(legacy.raw.get("options")) === JSON.stringify({ modifier: "ctrl", revision: 3 });

  check("overlay mode seeds hover lookups without a highlight or mining screenshot once and never opens setup",
    seededOnce && preserved && carriedHover,
    JSON.stringify({ tabs, seeded, options: storage.raw.get("options"), setup: storage.raw.get("setupState"),
      carried: [...carried.raw.entries()], legacy: [...legacy.raw.entries()] }));

  const unavailable = await chrome.__bus.sendMessage("overlay-reader", {
    target: "hoshidicts-worker", type: "hd_open_external", requestId: "overlay-link",
    url: "https://example.test/", active: true,
  }, { id: chrome.runtime.id, url: "https://reader.test/page", tab: { id: 1, windowId: 1 } });
  const unsupportedGuarded = unavailable?.ok === false
    && unavailable.error.includes("only from lookup popups") && tabs.length === 0;

  // Electron has no chrome.tabs.captureVisibleTab, so a profile that kept the
  // screenshot switched on from before overlay mode must never reach for it.
  const kept = makeStorage(), bus = makeBus();
  await kept.api().local.set({ options: { revision: 1,
    anki: { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic", captureScreenshot: true } } });
  const keptChrome = makeChrome("overlay-worker-screenshot", bus, kept);
  keptChrome.tabs = tabsApi;
  loadBackgroundScript({ chrome: keptChrome, console, URL, setTimeout, clearTimeout, Promise, Error }, { overlayMode: true });
  const screenshot = await bus.sendMessage("overlay-reader", { target: "hachidori-anki", type: "hd_anki_screenshot",
    requestId: "overlay-screenshot", request: {} }, { id: keptChrome.runtime.id, url: "https://reader.test/page",
    frameId: 0, documentId: "overlay-document", tab: { id: 1 } });
  check("overlay mode never takes a mining screenshot, even when the stored option is on",
    screenshot?.ok === false && screenshot.error.includes("turned off") && unsupportedGuarded,
    JSON.stringify({ screenshot, unavailable, tabs }));
}

async function firstRunBackgroundStage() {
  const bus = makeBus();
  const storage = makeStorage();
  const chrome = makeChrome("first-run-worker", bus, storage);
  const tabs = [];
  chrome.tabs = { async create(properties) { tabs.push(structuredClone(properties)); return { id: tabs.length }; } };
  const sandbox = () => ({ chrome, console, URL, setTimeout, clearTimeout, Promise, Error });
  loadBackgroundScript(sandbox());
  const settle = async (predicate = () => false) => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
    }
  };
  const startupUrl = chrome.runtime.getURL("startup.html");
  const validIso = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

  // A fresh installation: one tab, one seeded setup record, one initial options revision.
  chrome.__events.onInstalled.fire({ reason: "install" });
  await settle(() => tabs.length === 1 && offscreenState.exists);
  const seeded = { setup: storage.raw.get("setupState"), options: storage.raw.get("options") };
  const seededOnce = tabs.length === 1 && tabs[0].url === startupUrl
    && JSON.stringify(seeded.setup) === JSON.stringify({
      schemaVersion: 1, revision: 1, startedAt: seeded.setup?.startedAt, stage: "welcome", completedAt: null,
      dictionaries: { outcomes: {}, totalSeconds: null, continued: false, selectionsApplied: [], recordedRuns: [] },
      anki: null,
    }) && validIso(seeded.setup?.startedAt)
    && JSON.stringify(seeded.options) === JSON.stringify({
      popupTheme: "auto", showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 2, revision: 1,
    })
    && JSON.stringify(storage.sets) === JSON.stringify([["options", "setupState"]]);

  // The user edits a seeded preference; updates, browser starts, a restarted
  // worker and the repeated "install" reason Chrome reports for a command-line
  // loaded extension must neither reopen setup nor touch that edit.
  const edited = { ...seeded.options, showCompactDefinitionSummary: false, revision: 2 };
  await storage.api().local.set({ options: edited });
  chrome.__events.onInstalled.fire({ reason: "update", previousVersion: "0.1.0" });
  chrome.__events.onStartup.fire();
  chrome.__events.onInstalled.fire({ reason: "chrome_update" });
  chrome.__events.onInstalled.fire({ reason: "install" });
  // A restarted worker replaces the previous one, so it listens on its own bus.
  const restarted = makeChrome("first-run-worker-restart", makeBus(), storage);
  restarted.tabs = chrome.tabs;
  loadBackgroundScript({ ...sandbox(), chrome: restarted });
  restarted.__events.onStartup.fire();
  await settle();
  const preserved = tabs.length === 1
    && JSON.stringify(storage.raw.get("options")) === JSON.stringify(edited)
    && JSON.stringify(storage.raw.get("setupState")) === JSON.stringify(seeded.setup);

  // Seeding writes only absent values: a profile that already carries settings keeps them.
  const carried = makeStorage();
  await carried.api().local.set({ options: { scanLength: 20, revision: 4 } });
  const carriedChrome = makeChrome("first-run-worker-carried", makeBus(), carried);
  const carriedTabs = [];
  carriedChrome.tabs = { async create(properties) { carriedTabs.push(structuredClone(properties)); return { id: 1 }; } };
  loadBackgroundScript({ ...sandbox(), chrome: carriedChrome });
  carriedChrome.__events.onInstalled.fire({ reason: "install" });
  await settle(() => carriedTabs.length === 1);
  const carriedKept = carriedTabs.length === 1
    && JSON.stringify(carried.raw.get("options")) === JSON.stringify({ scanLength: 20, revision: 4 })
    && carried.raw.get("setupState")?.stage === "welcome"
    && JSON.stringify(carried.sets.at(-1)) === JSON.stringify(["setupState"]);
  check("a fresh installation opens one startup tab and seeds first-install preferences exactly once",
    seededOnce && preserved && carriedKept,
    JSON.stringify({ tabs, seeded, sets: storage.sets, options: storage.raw.get("options"), carriedTabs, carried: [...carried.raw.entries()] }));

  // Stage transitions are compare-and-set writes from the startup page only.
  const startupSender = { id: chrome.runtime.id, url: `${startupUrl}#resume` };
  const refusedInstall = await bus.sendMessage("startup-page", {
    target: "hachidori-setup", type: "hd_setup_install", requestId: "unaccepted-install", sourceIds: ["jitendex"],
  }, startupSender);
  check("the worker refuses starter downloads until the welcome stage has been accepted",
    refusedInstall?.ok === false && refusedInstall.error.includes("Start setup")
      && !bus.log.some((message) => message.relayed), JSON.stringify(refusedInstall));
  const send = (fields, sender = startupSender) => bus.sendMessage("startup-page", {
    target: "hoshidicts-worker", type: "hd_setup_cas", requestId: "setup-cas", ...fields,
  }, sender);
  const writesBefore = storage.sets.length;
  const advanced = await send({ baseRevision: 1, stage: "dictionaries" });
  const stale = await send({ baseRevision: 1, stage: "practice" });
  const rejected = [
    await send({ baseRevision: 2, stage: "lookup" }),
    await send({ stage: "practice" }),
    await send({ baseRevision: 2, stage: "practice" }, { id: chrome.runtime.id, url: chrome.runtime.getURL("settings.html") }),
    await send({ baseRevision: 2, stage: "practice" }, { id: "another-extension", url: startupUrl }),
  ];
  const continuedWrite = await send({ baseRevision: 2, stage: "complete", continued: "yes" });
  rejected.push(continuedWrite);
  const completed = await send({ baseRevision: 2, stage: "complete" });
  // Setup is monotonic: a current-revision write cannot reopen a finished setup.
  rejected.push(await send({ baseRevision: 3, stage: "practice" }));
  const validReply = (reply) => reply?.type === "hd_setup_cas_result" && reply.requestId === "setup-cas";
  check("startup-page setup writes are revision-checked, forward-only and refused from other senders",
    advanced?.ok && validReply(advanced)
      && JSON.stringify(advanced.state) === JSON.stringify({ ...seeded.setup, revision: 2, stage: "dictionaries" })
      && stale?.ok === false && stale.conflict === true && validReply(stale)
      && JSON.stringify(stale.state) === JSON.stringify(advanced.state)
      && rejected.every((reply) => validReply(reply) && reply.ok === false && typeof reply.error === "string" && reply.conflict === undefined)
      && rejected.at(-1).error.includes("backwards")
      && completed?.ok && completed.state.stage === "complete" && completed.state.revision === 3
      && validIso(completed.state.completedAt)
      && JSON.stringify(storage.raw.get("setupState")) === JSON.stringify(completed.state)
      && JSON.stringify(storage.sets.slice(writesBefore)) === JSON.stringify([["setupState"], ["setupState"]])
      && !bus.log.some((message) => message.relayed),
    JSON.stringify({ advanced, stale, rejected, completed, sets: storage.sets.slice(writesBefore) }));

  // The offscreen installer records outcomes; a committed Jitendex or Bee's
  // entry settles its first-install selection once without touching an edit.
  const offscreenSender = { id: chrome.runtime.id, url: chrome.runtime.getURL("offscreen.html") };
  const record = (fields, sender = offscreenSender) => bus.sendMessage("offscreen-installer", {
    target: "hoshidicts-worker", type: "hd_setup_record", requestId: "setup-record", runId: "run-1", ...fields,
  }, sender);
  const jitendexTitle = "Jitendex.org [2026-08-11]";
  const beesTitle = "Bee's Ultimate Kanji Dictionary";
  const committed = (id, title, sourceId, extra = {}) => ({ id, title, sourceId, revision: "1", enabled: true, favorite: false,
    displayName: null, termCount: 1, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, mediaCount: 0, path: `/dicts/g/${id}`, ...extra });
  await storage.api().local.set({ dictionaryState: { schemaVersion: 1, revision: 1, groups: [],
    dictionaries: [committed("jitendex-id", jitendexTitle, "jitendex"), committed("bees-id", beesTitle, "bees-ultimate-kanji-dictionary")] } });
  const recordWritesBefore = storage.sets.length;
  const fromPage = await record({ outcomes: { jitendex: { status: "installed", seconds: 2.5 } } }, startupSender);
  const unknownSource = await record({ outcomes: { jmdict: { status: "installed", seconds: 2.5 } } });
  const jitendexRecorded = await record({ outcomes: { jitendex: { status: "installed", seconds: 2.5 } } });
  const afterJitendex = { setup: storage.raw.get("setupState"), options: storage.raw.get("options") };
  // The user picks another summary source before a repeated record; the earlier choice must stand.
  await storage.api().local.set({ options: { ...afterJitendex.options, compactDefinitionSummaryDictionary: beesTitle, revision: afterJitendex.options.revision + 1 } });
  const jitendexAgain = await record({ outcomes: { jitendex: { status: "installed", seconds: 1 } } });
  // An option the user already changed is consumed without being overwritten.
  await storage.api().local.set({ options: { ...storage.raw.get("options"), kanjiClickDictionary: { title: jitendexTitle, kind: "term" }, revision: storage.raw.get("options").revision + 1 } });
  const optionsBeforeBees = storage.raw.get("options");
  const beesRecorded = await record({ outcomes: { "bees-ultimate-kanji-dictionary": { status: "installed", seconds: 4 } }, runSeconds: 6.5 });
  // A resent run record (lost reply) must not count the run again; a later run does.
  const resentRun = await record({ runSeconds: 6.5 });
  const failedRecorded = await record({ runId: "run-2", outcomes: { jiten: { status: "failed", seconds: 0.5, error: "HTTP 503" } }, runSeconds: 0.5 });
  const noRun = await record({ runId: "", runSeconds: 1 });
  const finalSetup = storage.raw.get("setupState");
  const settingsRecorded = await record({ runId: "settings-run", recordSetup: false,
    outcomes: { jmnedict: { status: "installed", seconds: 2 } }, runSeconds: 2 });
  // A package setup finds already installed — including one whose commit
  // outlived the installer that made it — still settles its selection.
  const reconcile = makeStorage();
  const reconcileBus = makeBus();
  const reconcileChrome = makeChrome("first-run-worker-reconcile", reconcileBus, reconcile);
  reconcileChrome.tabs = { async create() { return { id: 1 }; } };
  loadBackgroundScript({ ...sandbox(), chrome: reconcileChrome });
  reconcileChrome.__events.onInstalled.fire({ reason: "install" });
  await settle(() => reconcile.raw.get("setupState") !== undefined);
  // Recognised through its exact update index, the way a package imported by
  // hand or carried in from another profile is: no stored catalogue source ID.
  const beesIndexUrl = RECOMMENDED_CATALOGUE.find((entry) => entry.sourceId === "bees-ultimate-kanji-dictionary").indexUrl;
  await reconcile.api().local.set({ dictionaryState: { schemaVersion: 1, revision: 1, groups: [],
    dictionaries: [committed("bees-id", beesTitle, undefined, { indexUrl: beesIndexUrl })] } });
  const reconciled = await reconcileBus.sendMessage("offscreen-installer", {
    target: "hoshidicts-worker", type: "hd_setup_record", requestId: "setup-record", runId: "run-1",
    outcomes: { "bees-ultimate-kanji-dictionary": { status: "already-installed", seconds: 3 } },
  }, { id: reconcileChrome.runtime.id, url: reconcileChrome.runtime.getURL("offscreen.html") });
  check("installer outcomes are recorded from the engine host only and settle each dictionary selection once without overwriting edits",
    fromPage?.ok === false && fromPage.error.includes("engine host") && unknownSource?.ok === false && unknownSource.error.includes("unknown catalogue source")
      && jitendexRecorded?.ok === true && JSON.stringify(jitendexRecorded.state.dictionaries.outcomes) === JSON.stringify({ jitendex: { status: "installed", seconds: 2.5, error: null } })
      && JSON.stringify(jitendexRecorded.state.dictionaries.selectionsApplied) === JSON.stringify(["jitendex"])
      && afterJitendex.options.compactDefinitionSummaryDictionary === jitendexTitle && afterJitendex.options.showCompactDefinitionSummary === false
      && afterJitendex.options.revision === edited.revision + 1
      && JSON.stringify(storage.sets.slice(recordWritesBefore, recordWritesBefore + 1)) === JSON.stringify([["options", "recommendedDictionarySelections", "setupState"]])
      && jitendexAgain?.ok === true && storage.raw.get("options").compactDefinitionSummaryDictionary === beesTitle
      && jitendexAgain.state.dictionaries.outcomes.jitendex.seconds === 1
      && beesRecorded?.ok === true && JSON.stringify(storage.raw.get("options")) === JSON.stringify(optionsBeforeBees)
      && JSON.stringify(beesRecorded.state.dictionaries.selectionsApplied) === JSON.stringify(["jitendex", "bees-ultimate-kanji-dictionary"])
      && beesRecorded.state.dictionaries.totalSeconds === 6.5
      && resentRun?.ok === true && resentRun.state.dictionaries.totalSeconds === 6.5
      && JSON.stringify(resentRun.state.dictionaries.recordedRuns) === JSON.stringify(["run-1"])
      && failedRecorded?.ok === true && finalSetup.dictionaries.totalSeconds === 7
      && JSON.stringify(finalSetup.dictionaries.recordedRuns) === JSON.stringify(["run-1", "run-2"])
      && noRun?.ok === false && noRun.error.includes("names no run")
      && settingsRecorded?.ok === true && settingsRecorded.state === null
      && JSON.stringify(storage.raw.get("setupState")) === JSON.stringify(finalSetup)
      && JSON.stringify(finalSetup.dictionaries.outcomes.jiten) === JSON.stringify({ status: "failed", seconds: 0.5, error: "HTTP 503" })
      && finalSetup.stage === "complete" && finalSetup.revision === completed.state.revision + 5
      && reconciled?.ok === true
      && JSON.stringify(reconciled.state.dictionaries.outcomes) === JSON.stringify({ "bees-ultimate-kanji-dictionary": { status: "already-installed", seconds: null, error: null } })
      && JSON.stringify(reconciled.state.dictionaries.selectionsApplied) === JSON.stringify(["bees-ultimate-kanji-dictionary"])
      && JSON.stringify(reconcile.raw.get("options").kanjiClickDictionary) === JSON.stringify({ title: beesTitle, kind: "term" }),
    JSON.stringify({ fromPage, unknownSource, jitendexRecorded, afterJitendex, jitendexAgain, beesRecorded, resentRun, failedRecorded, noRun, finalSetup, reconciled, reconcileOptions: reconcile.raw.get("options"), sets: storage.sets.slice(recordWritesBefore) }));

  const overlayStorage = makeStorage(), overlayBus = makeBus();
  const overlayChrome = makeChrome("recommended-overlay", overlayBus, overlayStorage);
  loadBackgroundScript({ ...sandbox(), chrome: overlayChrome }, { overlayMode: true });
  await settle(() => overlayStorage.raw.has("options"));
  await overlayChrome.storage.local.set({ dictionaryState: { schemaVersion: 1, revision: 1, groups: [],
    dictionaries: [committed("bees-id", beesTitle, "bees-ultimate-kanji-dictionary")] } });
  const overlayRecord = () => overlayBus.sendMessage("offscreen-installer", {
    target: "hoshidicts-worker", type: "hd_setup_record", runId: "overlay-run",
    outcomes: { "bees-ultimate-kanji-dictionary": { status: "installed", seconds: 1 } },
  }, { id: overlayChrome.runtime.id, url: overlayChrome.runtime.getURL("offscreen.html") });
  const installed = await overlayRecord();
  const selected = overlayStorage.raw.get("options").kanjiClickDictionary;
  await overlayChrome.storage.local.set({ options: { ...overlayStorage.raw.get("options"), kanjiClickDictionary: "" } });
  await overlayRecord();
  check("recommended installation selects Bee's term route without onboarding and consumes the default once",
    installed.ok && !overlayStorage.raw.has("setupState") && selected?.title === beesTitle && selected.kind === "term"
      && overlayStorage.raw.get("options").kanjiClickDictionary === ""
      && overlayStorage.raw.get("recommendedDictionarySelections").includes("bees-ultimate-kanji-dictionary"));
}

describe("service worker", () => {
  test("a hosted extension background relays nothing and creates no engine", async () => {
    section("external dictionary links");
    await hostedExtensionBackgroundStage();
  });

  test("timer alarms with an overlay host and the alarms API", async () => {
    await timerAlarmsStage({ overlayMode: true, alarmsApi: true });
  });

  test("timer alarms without an overlay host or the alarms API", async () => {
    await timerAlarmsStage({ overlayMode: false, alarmsApi: false });
  });

  test("external dictionary links", async () => {
    await externalLinksBackgroundStage();
  });

  test("first-run background setup", async () => {
    await firstRunBackgroundStage();
  });

  test("overlay mode background", async () => {
    await overlayModeBackgroundStage();
  });
});
