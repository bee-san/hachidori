/*
 * Managed dictionary updates, schedules and the update alarm.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./notes.mjs";
import { readFileSync } from "node:fs";
import { describe } from "node:test";
import { buildRecommendedZip, buildTitledZip, GENERIC_KANJI_TITLE } from "../make-fixture.mjs";
import { startupTabs } from "./first-run.mjs";
import { check, step } from "./harness.mjs";
import { hover, popup, tab } from "./reader.mjs";
import {
  browser,
  extensionId,
  FIXTURE,
  FIXTURE_ID,
  generationExists,
  generationIsAbsent,
  GENERIC_KANJI_ID,
  GENERIC_MANAGED_DOWNLOAD_URL,
  GENERIC_MANAGED_INDEX_URL,
  interceptFetches,
  listOpfsPaths,
  MANAGED_DOWNLOAD_URL,
  MANAGED_INDEX_URL,
  MANAGED_UPDATE_ALARM,
  openDictionaryDetails,
  ownedGenerationRoot,
  page,
  settingsUrl,
  setupArchives,
  showSettingsSection,
  waitForCdpTargetGone,
  waitForRunningServiceWorker,
  watchedServiceWorkers,
} from "./session.mjs";

function setJsonResponse(route, value, status = 200) {
  route.status = status;
  route.contentType = "application/json";
  route.body = JSON.stringify(value);
}

function setArchiveResponse(route, bytes, status = 200) {
  route.status = status;
  route.contentType = "application/zip";
  route.body = bytes;
}

async function waitForCdpTarget(session, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find(predicate);
    if (target !== undefined) {
      return target;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return null;
}

async function checkScopedManagedUpdate(page, routes) {
  const { fixtureIndexRoute, genericIndexRoute, fixtureArchiveRoute, genericArchiveRoute } = routes;
  const readState = () => page.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState);
  const before = await readState();
  const original = before.dictionaries.find(entry => entry.id === GENERIC_KANJI_ID);
  const row = `.dict-row[data-dictionary-id="${GENERIC_KANJI_ID}"]`;
  await openDictionaryDetails(page, GENERIC_KANJI_ID);
  const otherStatus = await page.$eval(`.dict-row[data-dictionary-id="${FIXTURE_ID}"] .dict-update-status`, el => el.textContent);
  await page.click(`${row} .dict-update-check`);
  await page.waitForFunction(() => document.getElementById("update-state")?.textContent ===
    "Checked 1 managed dictionary — 1 update available, 0 failed.", { timeout: 30_000 });
  const checked = await readState();
  const ui = await page.evaluate(({ id, otherId }) => ({
    status: document.querySelector(`[data-dictionary-id="${id}"] .dict-update-status`).textContent,
    otherStatus: document.querySelector(`[data-dictionary-id="${otherId}"] .dict-update-status`).textContent,
    updateVisible: document.querySelector(`[data-dictionary-id="${id}"] .dict-update`).checkVisibility(),
  }), { id: GENERIC_KANJI_ID, otherId: FIXTURE_ID });
  const requests = () => ({ fixtureIndex: fixtureIndexRoute.requests, genericIndex: genericIndexRoute.requests,
    fixtureArchive: fixtureArchiveRoute.requests, genericArchive: genericArchiveRoute.requests });
  check("a row check fetches only its managed index and reports availability without installing",
    ui.status === "Update available: test-row" && ui.otherStatus === otherStatus && ui.updateVisible
      && genericIndexRoute.requests === 1 && fixtureIndexRoute.requests === 0
      && genericArchiveRoute.requests === 0 && fixtureArchiveRoute.requests === 0
      && checked.dictionaries.every((entry, index) => entry.id === GENERIC_KANJI_ID
        ? entry.revision === original.revision && entry.path === original.path && entry.lastUpdateCheck?.status === "update-available"
        : JSON.stringify(entry) === JSON.stringify(before.dictionaries[index])),
    JSON.stringify({ before, checked, ui, requests: requests() }));
  if (process.env.HACHIDORI_ROW_UPDATE_SCREENSHOT) {
    await page.setViewport({ width: 1200, height: 900 });
    await (await page.$(row)).screenshot({ path: process.env.HACHIDORI_ROW_UPDATE_SCREENSHOT });
  }
  await page.click(`${row} .dict-update`);
  await page.waitForFunction(() => document.getElementById("update-state")?.textContent ===
    "Finished 1 dictionary update — 1 updated, 0 failed.", { timeout: 90_000 });
  const updated = await readState();
  check("a row Update installs only the checked package",
    genericIndexRoute.requests === 2 && fixtureIndexRoute.requests === 0
      && genericArchiveRoute.requests === 1 && fixtureArchiveRoute.requests === 0
      && updated.dictionaries.every((entry, index) => entry.id === GENERIC_KANJI_ID
        ? entry.revision === "test-row" && entry.path !== original.path && entry.lastUpdateCheck?.status === "up-to-date"
        : JSON.stringify(entry) === JSON.stringify(before.dictionaries[index])),
    JSON.stringify({ updated, requests: requests() }));
}

async function checkManagementAutosave(page, browser, settingsUrl) {
  const mirror = await browser.newPage();
  const groupId = "browser-autosave-group";
  const groupInput = `[data-group-id="${groupId}"] .dict-group-name`;
  const edit = (target, selector, values, event = "input") => target.evaluate((selector, values, event) => {
    const input = document.querySelector(selector);
    for (const value of values) {
      input.value = value;
      input.dispatchEvent(new Event(event, { bubbles: true }));
    }
  }, selector, values, event);
  const mutateGroup = (target, patch) => target.evaluate(async (id, patch) => {
    const { dictionaryState: state } = await chrome.storage.local.get("dictionaryState");
    const groups = state.groups.some(group => group.id === id)
      ? state.groups.map(group => group.id === id ? { ...group, ...patch } : group)
      : [...state.groups, { id, name: "Study", dictionaryIds: [], ...patch }];
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: state.revision, dictionaries: state.dictionaries, groups });
    if (!reply.ok) throw new Error(reply.error);
  }, groupId, patch);
  const waitName = (name) => page.waitForFunction(async (id, name) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return dictionaryState.groups.find(group => group.id === id)?.name === name;
  }, { polling: 50 }, groupId, name);
  try {
    await mirror.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await mirror.waitForFunction(() => document.getElementById("engine-status").textContent.startsWith("Ready"), { polling: 100 });
    for (const target of [page, mirror]) await showSettingsSection(target, "updates");
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const probe = { calls: [], hold: true, lose: false, type: "hd_updates_schedule", release: null,
        restore: () => { chrome.runtime.sendMessage = original; } };
      window.__managementAutosave = probe;
      chrome.runtime.sendMessage = async message => {
        if (message.type !== probe.type) return original(message);
        probe.calls.push(message);
        const reply = await original(message);
        if (probe.hold) {
          probe.hold = false;
          await new Promise(done => { probe.release = done; });
        }
        if (probe.lose) { probe.lose = false; throw new Error("simulated lost Settings reply"); }
        return reply;
      };
    });
    await edit(page, "#update-schedule", ["off", "hourly", "daily"], "change");
    await page.waitForFunction(() => typeof window.__managementAutosave.release === "function", { polling: 50 });
    await edit(page, "#update-schedule", ["monthly"], "change");
    await mirror.waitForFunction(() => document.getElementById("update-schedule").value === "daily", { polling: 50 });
    await edit(mirror, "#update-schedule", ["weekly"], "change");
    await mirror.waitForFunction(() => document.getElementById("update-state").textContent === "Schedule saved.", { polling: 50 });
    const whileHeld = await page.evaluate(() => window.__managementAutosave.calls.length);
    await page.evaluate(() => window.__managementAutosave.release());
    await page.waitForFunction(() => !document.getElementById("update-schedule-conflict-actions").hidden, { polling: 50 });
    const schedule = await page.evaluate(async () => ({
      draft: document.getElementById("update-schedule").value,
      stored: (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates,
      calls: window.__managementAutosave.calls,
    }));
    await page.bringToFront();
    await page.click("#update-schedule-discard");
    await page.evaluate(() => { window.__managementAutosave.lose = true; });
    await edit(page, "#update-schedule", ["off"], "change");
    await page.waitForFunction(() => !document.getElementById("update-schedule-conflict-actions").hidden, { polling: 50 });
    const lostRevision = await page.evaluate(async () => (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates.revision);
    await page.click("#update-schedule-retry");
    await page.waitForFunction(() => document.getElementById("update-state").textContent === "Schedule saved.", { polling: 50 });
    const retried = await page.evaluate(async () => ({
      stored: (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates,
      alarms: await chrome.alarms.getAll(), calls: window.__managementAutosave.calls.length,
    }));
    check("Settings schedule drafts preserve newer commits and retry lost replies without duplicate writes or alarms",
      whileHeld === 1 && schedule.calls.length === 2 && schedule.draft === "monthly"
        && schedule.stored.schedule === "weekly"
        && schedule.calls[1].baseRevision === schedule.calls[0].baseRevision + 1
        && retried.stored.revision === lostRevision && retried.stored.schedule === "off"
        && retried.calls === 4
        && retried.alarms.every(alarm => alarm.name !== MANAGED_UPDATE_ALARM),
      JSON.stringify({ whileHeld, schedule, lostRevision, retried }));

    await mutateGroup(page, {});
    for (const target of [page, mirror]) {
      await showSettingsSection(target, "dictionary-groups");
      await target.waitForSelector(groupInput);
    }
    await page.evaluate(() => {
      Object.assign(window.__managementAutosave, { type: "hd_state_cas", calls: [], release: null });
    });
    await page.focus(groupInput);
    await edit(page, groupInput, ["P", "Personal"]);
    await mutateGroup(mirror, { dictionaryIds: [FIXTURE_ID] });
    await waitName("Personal");
    const coalesced = await page.evaluate(selector => ({
      calls: window.__managementAutosave.calls.length,
      focused: document.activeElement === document.querySelector(selector),
    }), groupInput);
    await page.evaluate(() => { window.__managementAutosave.hold = true; });
    await edit(page, groupInput, ["Mine"], "change");
    await page.waitForFunction(() => typeof window.__managementAutosave.release === "function", { polling: 50 });
    await edit(page, groupInput, ["Next"]);
    await mirror.waitForFunction(selector => document.querySelector(selector).value === "Mine", { polling: 50 }, groupInput);
    await edit(mirror, groupInput, ["Shared"]);
    await waitName("Shared");
    await page.evaluate(() => window.__managementAutosave.release());
    await page.waitForSelector(`${groupInput}[aria-invalid="true"]`);
    const names = await page.evaluate(async (id, selector) => ({
      stored: (await chrome.storage.local.get("dictionaryState")).dictionaryState.groups.find(group => group.id === id),
      draft: document.querySelector(selector).value,
      calls: window.__managementAutosave.calls.length,
    }), groupId, groupInput);
    if (process.env.HACHIDORI_AUTOSAVE_SCREENSHOT) {
      await page.bringToFront();
      await page.setViewport({ width: 1080, height: 900 });
      await (await page.$("#dictionary-groups")).screenshot({ path: process.env.HACHIDORI_AUTOSAVE_SCREENSHOT });
    }
    await page.evaluate(() => {
      const probe = window.__managementAutosave;
      probe.renders = 0;
      probe.observer = new MutationObserver(records => {
        probe.renders += records.filter(record => record.target.id === "dict-group-list" && record.removedNodes.length > 0).length;
      });
      probe.observer.observe(document.getElementById("dict-group-list"), { childList: true });
    });
    await page.click(`[data-group-id="${groupId}"] .name-draft-retry`);
    await waitName("Next");
    await page.waitForFunction(() => !document.querySelector(".name-draft-feedback"), { polling: 50 });
    await page.waitForFunction(() => window.__managementAutosave.renders > 0, { polling: 50 });
    const renders = await page.evaluate(() => window.__managementAutosave.renders);
    check("Settings name autosave merges unrelated edits, rejects external renames and paints one completion",
      coalesced.calls === 1 && coalesced.focused && names.calls === 2 && names.draft === "Next"
        && names.stored.name === "Shared" && names.stored.dictionaryIds.join(",") === FIXTURE_ID && renders === 1,
      JSON.stringify({ coalesced, names, renders }));
  } finally {
    await page.evaluate(async id => {
      window.__managementAutosave?.release?.();
      window.__managementAutosave?.observer?.disconnect();
      window.__managementAutosave?.restore();
      delete window.__managementAutosave;
      const { dictionaryState: state } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: state.revision, dictionaries: state.dictionaries, groups: state.groups.filter(group => group.id !== id) });
      if (!reply.ok) throw new Error(reply.error);
    }, groupId);
    await mirror.close();
    await showSettingsSection(page, "updates");
  }
}

// Values that more than one step uses; the step that creates each one assigns it.
let managedFixture, updateWorkerTarget, fixtureIndexRoute, genericIndexRoute, fixtureArchiveRoute,
  genericArchiveRoute, setGenericUpdate, updateIndexSession, genericArchivesBeforeCheck,
  checkedStorage, checkedGeneric, beforeUpdateState, beforeUpdatePackage, beforeUpdateGeneration,
  afterUpdateState, afterUpdatePackage, expectedNextCheck, scheduledAlarm,
  scheduleManagedCheckSoon, alarmUpdateResult, alarmUpdateState, alarmUpdatedPackage,
  failedAlarmPackage, hoverUpdatedPackage, startupTabsAfterWorkerRestart;

describe("managed updates", () => {
  step("scoped managed checks and updates", async () => {
    // ---------------------------------------------------------- managed updates
    // The generic-kanji package is already disabled at this point. Giving it a
    // complete generic source makes the manual check prove that enabled state is
    // irrelevant, while the combined fixture proves that every other managed
    // package was checked too. The engine owns this state change so its loaded set
    // and the worker-owned manifest cannot diverge.
    managedFixture = await page.evaluate(async ({ dictionaryId, fixtureId, indexUrl, downloadUrl }) => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      return chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_apply_state",
        requestId: "e2e-manage-generic-source",
        baseRevision: current.revision,
        dictionaries: current.dictionaries.map((dictionary) => dictionary.id === dictionaryId
          ? {
              ...dictionary,
              isUpdatable: true,
              indexUrl,
              downloadUrl,
              lastUpdateCheck: null,
            }
          : dictionary.id === fixtureId ? { ...dictionary, updateScheduleOverride: "off" } : dictionary),
      });
    }, {
      dictionaryId: GENERIC_KANJI_ID,
      fixtureId: FIXTURE_ID,
      indexUrl: GENERIC_MANAGED_INDEX_URL,
      downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
    });

    // Wake the worker immediately before attaching Fetch. A long renderer pass is
    // enough time for an MV3 worker to idle, so the target captured at launch is
    // not assumed to still be authoritative here.
    await page.evaluate(() => chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_read",
    }));
    updateWorkerTarget = await browser.waitForTarget(
      (target) => target.type() === "service_worker"
        && target.url() === `chrome-extension://${extensionId}/background.js`,
      { timeout: 30_000 },
    );
    fixtureIndexRoute = { requests: 0 };
    genericIndexRoute = { requests: 0 };
    fixtureArchiveRoute = { requests: 0 };
    genericArchiveRoute = { requests: 0 };
    setJsonResponse(fixtureIndexRoute, { revision: "test-1" });
    setArchiveResponse(fixtureArchiveRoute, readFileSync(FIXTURE));
    setGenericUpdate = revision => {
      setJsonResponse(genericIndexRoute, { revision });
      setArchiveResponse(genericArchiveRoute, buildRecommendedZip({
        title: GENERIC_KANJI_TITLE, revision,
        indexUrl: GENERIC_MANAGED_INDEX_URL,
        downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
        capabilities: ["term"],
      }));
    };
    setGenericUpdate("test-row");
    const indexRoutes = new Map([
      [MANAGED_INDEX_URL, fixtureIndexRoute],
      [GENERIC_MANAGED_INDEX_URL, genericIndexRoute],
    ]);
    const archiveRoutes = new Map([
      [MANAGED_DOWNLOAD_URL, fixtureArchiveRoute],
      [GENERIC_MANAGED_DOWNLOAD_URL, genericArchiveRoute],
    ]);

    // Indexes are fetched by background.js. Archive routes use the offscreen
    // session attached before its dedicated engine worker started. Chrome 128
    // does not apply a later offscreen Fetch attachment to that existing worker.
    updateIndexSession = await interceptFetches(
      updateWorkerTarget,
      indexRoutes,
      "managed index",
    );
    setupArchives.routes = archiveRoutes;

    await checkScopedManagedUpdate(page, { fixtureIndexRoute, genericIndexRoute, fixtureArchiveRoute, genericArchiveRoute });
  });

  step("Check now", async () => {
    setGenericUpdate("test-2");
    const genericIndexesBeforeCheck = genericIndexRoute.requests;
    genericArchivesBeforeCheck = genericArchiveRoute.requests;
    const beforeCheckState = (await page.evaluate(() => chrome.storage.local.get("dictionaryState"))).dictionaryState;
    await showSettingsSection(page, "updates");
    await page.bringToFront();
    await page.click("#update-check-now");
    const checkSummary = await page.waitForFunction(() => {
      const text = document.getElementById("update-state")?.textContent?.trim() ?? "";
      return text.startsWith("Checked 2 managed dictionaries") ? text : false;
    }, { timeout: 30_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => "(never settled)");
    checkedStorage = await page.evaluate(() => chrome.storage.local.get([
      "dictionaryState",
      "dictionaryUpdates",
    ]));
    const checkedFixture = checkedStorage.dictionaryState?.dictionaries?.find(
      (dictionary) => dictionary.id === FIXTURE_ID,
    );
    checkedGeneric = checkedStorage.dictionaryState?.dictionaries?.find(
      (dictionary) => dictionary.id === GENERIC_KANJI_ID,
    );
    check(
      "Check now checks every managed dictionary including disabled packages without downloading",
      managedFixture?.ok === true
        && checkSummary === "Checked 2 managed dictionaries — 1 update available, 0 failed."
        && checkedFixture?.lastUpdateCheck?.status === "up-to-date"
        && checkedFixture.updateScheduleOverride === "off"
        && checkedFixture.lastUpdateCheck.remoteRevision === "test-1"
        && checkedGeneric?.enabled === false
        && checkedGeneric?.lastUpdateCheck?.status === "update-available"
        && checkedGeneric.lastUpdateCheck.remoteRevision === "test-2"
        && fixtureIndexRoute.requests === 1
        && genericIndexRoute.requests === genericIndexesBeforeCheck + 1
        && fixtureArchiveRoute.requests === 0
        && genericArchiveRoute.requests === genericArchivesBeforeCheck
        && checkedStorage.dictionaryState.dictionaries.every((entry, index) =>
          entry.revision === beforeCheckState.dictionaries[index].revision && entry.path === beforeCheckState.dictionaries[index].path)
        && Number.isFinite(Date.parse(checkedStorage.dictionaryUpdates?.lastCheckedAt)),
      JSON.stringify({
        managedFixture,
        checkSummary,
        checkedStorage,
        requests: {
          fixtureIndex: fixtureIndexRoute.requests,
          genericIndex: genericIndexRoute.requests,
          fixtureArchive: fixtureArchiveRoute.requests,
          genericArchive: genericArchiveRoute.requests,
        },
      }),
    );
  });

  step("persisted update controls", async () => {
    // Reload rather than trusting the storage-event render that followed the
    // check. This proves the controls hydrate from persisted per-package and
    // global check state.
    await page.reload({ waitUntil: "domcontentloaded" });
    const persistedUpdateUi = await page.waitForFunction(async ({ fixtureId, genericId }) => {
      const rows = [...document.querySelectorAll("#dict-list .dict-row")];
      const byId = (id) => rows.find((row) => row.dataset.dictionaryId === id);
      const fixture = byId(fixtureId);
      const generic = byId(genericId);
      const stored = await chrome.storage.local.get("dictionaryUpdates");
      const lastCheckedAt = stored.dictionaryUpdates?.lastCheckedAt;
      const expectedLastChecked = Number.isFinite(Date.parse(lastCheckedAt))
        ? `Last checked ${new Date(lastCheckedAt).toLocaleString()}.`
        : "";
      const value = {
        expectedLastChecked,
        fixtureStatus: fixture?.querySelector(".dict-update-status")?.textContent ?? "",
        fixtureUpdateHidden: fixture?.querySelector(".dict-update")?.hidden,
        genericStatus: generic?.querySelector(".dict-update-status")?.textContent ?? "",
        genericUpdateHidden: generic?.querySelector(".dict-update")?.hidden,
        lastChecked: document.getElementById("update-last-checked")?.textContent ?? "",
        updateAllDisabled: document.getElementById("update-all")?.disabled,
      };
      return value.fixtureStatus === "Up to date"
        && value.genericStatus === "Update available: test-2"
        && value.lastChecked === expectedLastChecked
        ? value
        : false;
    }, { timeout: 30_000, polling: 100 }, {
      fixtureId: FIXTURE_ID,
      genericId: GENERIC_KANJI_ID,
    }).then((handle) => handle.jsonValue()).catch(() => null);
    await openDictionaryDetails(page, GENERIC_KANJI_ID);
    const persistedRowVisible = await page.$eval(
      `.dict-row[data-dictionary-id="${GENERIC_KANJI_ID}"] .dict-update`, (button) => button.checkVisibility());
    await showSettingsSection(page, "updates");
    check(
      "managed update controls render persisted availability and last-checked state",
      persistedUpdateUi?.expectedLastChecked.startsWith("Last checked ") === true
        && persistedUpdateUi.fixtureUpdateHidden === true
        && persistedUpdateUi.genericUpdateHidden === false
        && persistedUpdateUi.updateAllDisabled === false && persistedRowVisible,
      JSON.stringify(persistedUpdateUi),
    );
  });

  step("lookups while a managed download is held", async () => {
    if (process.env.HACHIDORI_UPDATE_SCREENSHOT) {
      await page.bringToFront();
      await page.setViewport({ width: 960, height: 900 });
      const updateCard = await page.$('section[aria-labelledby="updates-heading"]');
      await updateCard.screenshot({ path: process.env.HACHIDORI_UPDATE_SCREENSHOT });
    }

    beforeUpdateState = checkedStorage.dictionaryState;
    beforeUpdatePackage = checkedGeneric;
    beforeUpdateGeneration = ownedGenerationRoot(
      beforeUpdatePackage?.path,
      GENERIC_KANJI_TITLE,
    );
    const engineBeforeHeldDownload = await page.evaluate(() => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_status",
      requestId: "e2e-before-held-update",
    }));
    const heldManagedDownload = Promise.withResolvers();
    const releaseManagedDownload = Promise.withResolvers();
    genericArchiveRoute.respond = async () => {
      heldManagedDownload.resolve();
      await releaseManagedDownload.promise;
      return genericArchiveRoute;
    };
    await showSettingsSection(page, "updates");
    await page.click("#update-all");
    const heldDownloadReached = await Promise.race([
      heldManagedDownload.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 30_000)),
    ]);
    let lookupDuringHeldDownload = null;
    try {
      if (heldDownloadReached) {
        lookupDuringHeldDownload = await page.evaluate(async () => {
          const [status, lookup] = await Promise.all([
            chrome.runtime.sendMessage({
              target: "hoshidicts-offscreen",
              type: "hd_status",
              requestId: "e2e-held-update-status",
            }),
            chrome.runtime.sendMessage({
              target: "hoshidicts-offscreen",
              type: "hd_lookup",
              requestId: "e2e-held-update-lookup",
              text: "食べる",
            }),
          ]);
          return { status, lookup };
        });
      }
    } finally {
      releaseManagedDownload.resolve();
      genericArchiveRoute.respond = null;
    }
    check(
      "lookups stay available while a managed archive download is held",
      heldDownloadReached
        && lookupDuringHeldDownload?.status?.loading === true
        && lookupDuringHeldDownload.status.generation === engineBeforeHeldDownload.generation
        && lookupDuringHeldDownload.lookup?.ok === true
        && lookupDuringHeldDownload.lookup.generation === engineBeforeHeldDownload.generation
        && lookupDuringHeldDownload.lookup.results?.some(
          (result) => result.term?.expression === "食べる",
        ),
      JSON.stringify({ engineBeforeHeldDownload, heldDownloadReached, lookupDuringHeldDownload }),
    );
  });

  step("Update all", async () => {
    const manualUpdateSummary = await page.waitForFunction((dictionaryId) => {
      const text = document.getElementById("update-state")?.textContent?.trim() ?? "";
      return chrome.storage.local.get("dictionaryState").then(({ dictionaryState }) => {
        const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
        return dictionary?.revision === "test-2" && text.startsWith("Finished 1 dictionary update")
          ? text
          : false;
      });
    }, { timeout: 90_000, polling: 100 }, GENERIC_KANJI_ID)
      .then((handle) => handle.jsonValue())
      .catch(() => "(never settled)");
    afterUpdateState = (await page.evaluate(() =>
      chrome.storage.local.get("dictionaryState"))).dictionaryState;
    afterUpdatePackage = afterUpdateState?.dictionaries?.find(
      (dictionary) => dictionary.id === GENERIC_KANJI_ID,
    );
    const afterUpdateGeneration = ownedGenerationRoot(
      afterUpdatePackage?.path,
      GENERIC_KANJI_TITLE,
    );
    const opfsAfterUpdate = await listOpfsPaths(page);
    check(
      "Update all atomically replaces a managed generation and preserves presentation",
      manualUpdateSummary === "Finished 1 dictionary update — 1 updated, 0 failed."
        && genericArchiveRoute.requests === genericArchivesBeforeCheck + 1
        && afterUpdatePackage?.id === beforeUpdatePackage?.id
        && afterUpdatePackage?.path !== beforeUpdatePackage?.path
        && afterUpdatePackage?.revision === "test-2"
        && afterUpdatePackage?.displayName === beforeUpdatePackage?.displayName
        && afterUpdatePackage?.enabled === beforeUpdatePackage?.enabled
        && afterUpdatePackage?.favorite === beforeUpdatePackage?.favorite
        && afterUpdatePackage?.isUpdatable === beforeUpdatePackage?.isUpdatable
        && afterUpdatePackage?.indexUrl === beforeUpdatePackage?.indexUrl
        && afterUpdatePackage?.downloadUrl === beforeUpdatePackage?.downloadUrl
        && afterUpdatePackage?.lastUpdateCheck?.status === "up-to-date"
        && JSON.stringify(afterUpdateState.dictionaries.map((dictionary) => dictionary.id))
          === JSON.stringify(beforeUpdateState.dictionaries.map((dictionary) => dictionary.id))
        && JSON.stringify(afterUpdateState.groups) === JSON.stringify(beforeUpdateState.groups)
        && afterUpdateGeneration !== ""
        && generationExists(opfsAfterUpdate, afterUpdatePackage.path)
        && generationIsAbsent(opfsAfterUpdate, beforeUpdateGeneration),
      JSON.stringify({
        manualUpdateSummary,
        beforeUpdatePackage,
        afterUpdatePackage,
        groupsBefore: beforeUpdateState.groups,
        groupsAfter: afterUpdateState.groups,
        opfsAfterUpdate,
        archiveRequests: genericArchiveRoute.requests,
      }),
    );
  });

  step("management autosave", async () => {
    await checkManagementAutosave(page, browser, settingsUrl);
  });

  step("one aggregate browser alarm", async () => {
    await page.select("#update-schedule", "hourly");
    expectedNextCheck = Date.parse(afterUpdatePackage.lastUpdateCheck.checkedAt) + 3_600_000;
    scheduledAlarm = await page.waitForFunction(async ({ alarmName, expected }) => {
      const { dictionaryUpdates } = await chrome.storage.local.get("dictionaryUpdates");
      const alarms = await chrome.alarms.getAll();
      const alarm = alarms.find((candidate) => candidate.name === alarmName);
      return dictionaryUpdates?.schedule === "hourly" && alarm?.periodInMinutes === undefined && alarm?.scheduledTime === expected
        ? { alarm, alarms, dictionaryUpdates }
        : false;
    }, { timeout: 30_000, polling: 100 }, { alarmName: MANAGED_UPDATE_ALARM, expected: expectedNextCheck })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    check(
      "one aggregate browser alarm follows the next dictionary due time",
      scheduledAlarm?.alarms?.filter(alarm => alarm.name === MANAGED_UPDATE_ALARM).length === 1
        && scheduledAlarm.alarm.name === MANAGED_UPDATE_ALARM
        && scheduledAlarm.alarm.periodInMinutes === undefined
        && scheduledAlarm.alarm.scheduledTime === expectedNextCheck,
      JSON.stringify(scheduledAlarm),
    );
  });

  step("per-dictionary schedules", async () => {
    const generationBeforePolicy = await page.evaluate(async () => (await chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_status",
    })).generation);
    await openDictionaryDetails(page, GENERIC_KANJI_ID);
    await page.select(`.dict-row[data-dictionary-id="${GENERIC_KANJI_ID}"] .dict-update-schedule`, "hourly");
    await page.waitForFunction(async dictionaryId => (await chrome.storage.local.get("dictionaryState"))
      .dictionaryState.dictionaries.find(dictionary => dictionary.id === dictionaryId).updateScheduleOverride === "hourly",
    { polling: 100 }, GENERIC_KANJI_ID);
    await showSettingsSection(page, "updates");
    await page.waitForSelector("#update-schedule:not([disabled])");
    await page.select("#update-schedule", "off");
    await page.waitForFunction(async () => (await chrome.storage.local.get("dictionaryUpdates")).dictionaryUpdates.schedule === "off",
      { polling: 100 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("engine-status")?.textContent.includes("Ready"), { polling: 100 });
    await openDictionaryDetails(page, GENERIC_KANJI_ID);
    const policyState = await page.evaluate(async ({ dictionaryId, fixtureId }) => ({
      override: document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-update-schedule`).value,
      fixture: document.querySelector(`.dict-row[data-dictionary-id="${fixtureId}"] .dict-update-schedule`).value,
      hint: document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-next-check`).textContent,
      global: document.getElementById("update-schedule").value,
      alarms: await chrome.alarms.getAll(),
      generation: (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" })).generation,
    }), { dictionaryId: GENERIC_KANJI_ID, fixtureId: FIXTURE_ID });
    check("per-dictionary schedules persist without engine reload and override global Off",
      policyState.override === "hourly" && policyState.fixture === "off" && policyState.global === "off"
        && policyState.hint.includes("Next check") && policyState.generation === generationBeforePolicy
        && policyState.alarms.filter(alarm => alarm.name === MANAGED_UPDATE_ALARM).length === 1
        && policyState.alarms.find(alarm => alarm.name === MANAGED_UPDATE_ALARM)?.scheduledTime === expectedNextCheck,
      JSON.stringify(policyState));
    if (process.env.HACHIDORI_SCHEDULE_SCREENSHOT) {
      await page.bringToFront();
      await page.setViewport({ width: 1200, height: 900 });
      await page.screenshot({ path: process.env.HACHIDORI_SCHEDULE_SCREENSHOT, fullPage: true });
    }
    scheduleManagedCheckSoon = () => page.evaluate(async dictionaryId => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: current.revision, dictionaries: current.dictionaries.map(dictionary => dictionary.id === dictionaryId
          ? { ...dictionary, lastUpdateCheck: { ...dictionary.lastUpdateCheck, checkedAt: new Date(Date.now() - 3_600_000 + 1000).toISOString() } }
          : dictionary) });
      if (!reply.ok) throw new Error(reply.error);
    }, GENERIC_KANJI_ID);
  });

  step("a real browser alarm installs updates", async () => {
    setGenericUpdate("test-3");
    const archiveRequestsBeforeAlarm = genericArchiveRoute.requests;
    const fixtureChecksBeforeAlarm = fixtureIndexRoute.requests;
    await scheduleManagedCheckSoon();
    alarmUpdateResult = await page.waitForFunction(async ({ dictionaryId, previousCheckedAt }) => {
      const { dictionaryState, dictionaryUpdates } = await chrome.storage.local.get([
        "dictionaryState",
        "dictionaryUpdates",
      ]);
      const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
      return dictionary?.revision === "test-3"
        && dictionary.lastUpdateCheck?.status === "up-to-date"
        && Date.parse(dictionaryUpdates?.lastCheckedAt) > Date.parse(previousCheckedAt)
        ? { dictionaryState, dictionaryUpdates }
        : false;
    }, { timeout: 90_000, polling: 100 }, {
      dictionaryId: GENERIC_KANJI_ID,
      previousCheckedAt: scheduledAlarm?.dictionaryUpdates?.lastCheckedAt,
    })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    alarmUpdateState = alarmUpdateResult?.dictionaryState;
    alarmUpdatedPackage = alarmUpdateState?.dictionaries?.find(
      (dictionary) => dictionary.id === GENERIC_KANJI_ID,
    );
    check(
      "a real browser alarm installs updates for disabled managed dictionaries",
      alarmUpdatedPackage?.revision === "test-3"
        && alarmUpdatedPackage?.enabled === false
        && alarmUpdatedPackage?.id === GENERIC_KANJI_ID
        && alarmUpdatedPackage?.displayName === afterUpdatePackage?.displayName
        && alarmUpdatedPackage?.favorite === afterUpdatePackage?.favorite
        && genericArchiveRoute.requests === archiveRequestsBeforeAlarm + 1
        && fixtureIndexRoute.requests === fixtureChecksBeforeAlarm
        && alarmUpdatedPackage.updateScheduleOverride === "hourly"
        && alarmUpdateResult.dictionaryUpdates.schedule === "off"
        && JSON.stringify(alarmUpdateState.groups) === JSON.stringify(afterUpdateState.groups),
      JSON.stringify({
        alarmUpdatedPackage,
        archiveRequestsBeforeAlarm,
        archiveRequestsAfterAlarm: genericArchiveRoute.requests,
        groups: alarmUpdateState?.groups,
      }),
    );
  });

  step("a failed scheduled update", async () => {
    const beforeFailedAlarmState = alarmUpdateState;
    const beforeFailedAlarmPackage = alarmUpdatedPackage;
    const beforeFailedAlarmPaths = await listOpfsPaths(page);
    setJsonResponse(genericIndexRoute, { revision: "test-4" });
    setArchiveResponse(genericArchiveRoute, buildRecommendedZip({
      title: GENERIC_KANJI_TITLE,
      revision: "wrong-test-4",
      indexUrl: GENERIC_MANAGED_INDEX_URL,
      downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
      capabilities: ["term"],
    }));
    await scheduleManagedCheckSoon();
    const failedAlarmResult = await page.waitForFunction(async ({ dictionaryId, previousCheckedAt }) => {
      const { dictionaryState, dictionaryUpdates } = await chrome.storage.local.get([
        "dictionaryState",
        "dictionaryUpdates",
      ]);
      const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.id === dictionaryId);
      return dictionary?.lastUpdateCheck?.remoteRevision === "test-4"
        && typeof dictionary.lastUpdateCheck?.error === "string"
        && Date.parse(dictionaryUpdates?.lastCheckedAt) > Date.parse(previousCheckedAt)
        ? { dictionaryState, dictionaryUpdates }
        : false;
    }, { timeout: 90_000, polling: 100 }, {
      dictionaryId: GENERIC_KANJI_ID,
      previousCheckedAt: alarmUpdateResult?.dictionaryUpdates?.lastCheckedAt,
    })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    const failedAlarmState = failedAlarmResult?.dictionaryState;
    failedAlarmPackage = failedAlarmState?.dictionaries?.find(
      (dictionary) => dictionary.id === GENERIC_KANJI_ID,
    );
    const afterFailedAlarmPaths = await listOpfsPaths(page);
    const statusAfterFailedAlarm = await page.evaluate(() => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_status",
      requestId: "e2e-failed-update-status",
    }));
    check(
      "a failed scheduled update preserves the working generation without OPFS debris",
      failedAlarmPackage?.revision === beforeFailedAlarmPackage?.revision
        && failedAlarmPackage?.path === beforeFailedAlarmPackage?.path
        && failedAlarmPackage?.lastUpdateCheck?.status === "update-available"
        && failedAlarmPackage?.lastUpdateCheck?.remoteRevision === "test-4"
        && failedAlarmPackage?.lastUpdateCheck?.error?.includes("revision")
        && JSON.stringify(failedAlarmState?.groups) === JSON.stringify(beforeFailedAlarmState?.groups)
        && JSON.stringify(afterFailedAlarmPaths) === JSON.stringify(beforeFailedAlarmPaths)
        && !afterFailedAlarmPaths.includes(".hdw-archive.zip")
        && failedAlarmPackage !== undefined
        && generationExists(afterFailedAlarmPaths, failedAlarmPackage.path)
        && statusAfterFailedAlarm?.ok === true
        && statusAfterFailedAlarm?.ready === true
        && statusAfterFailedAlarm?.dictionaryCount === 4,
      JSON.stringify({
        beforeFailedAlarmPackage,
        failedAlarmPackage,
        beforeFailedAlarmPaths,
        afterFailedAlarmPaths,
        statusAfterFailedAlarm,
      }),
    );
  });

  step("hovering through a scheduled update", async () => {
    // A scheduled update of an enabled package while the reader hovers every
    // 100 ms: the old generation answers until the new one is swapped in, so no
    // hover is refused with the update notice, and Settings names the package on
    // its row while the archive downloads and installs.
    const setGenericEnabled = (enabled) => page.evaluate(async ({ dictionaryId, enabled }) => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      const reply = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_apply_state", requestId: `e2e-hover-update-enable-${enabled}`,
        baseRevision: current.revision,
        dictionaries: current.dictionaries.map(dictionary => dictionary.id === dictionaryId ? { ...dictionary, enabled } : dictionary),
      });
      if (!reply.ok) throw new Error(reply.error);
    }, { dictionaryId: GENERIC_KANJI_ID, enabled });
    await setGenericEnabled(true);
    const hoverUpdateGlossary = `${GENERIC_KANJI_TITLE} test-5 glossary`;
    // A background tab's input is throttled; the reader must be the visible tab.
    await tab.bringToFront();
    const beforeHoverUpdate = await hover("#verb", { accept: state => state.text.includes(`${GENERIC_KANJI_TITLE} verb fixture`) });
    const beforeHoverUpdatePackage = (await page.evaluate(() => chrome.storage.local.get("dictionaryState")))
      .dictionaryState.dictionaries.find(dictionary => dictionary.id === GENERIC_KANJI_ID);
    setJsonResponse(genericIndexRoute, { revision: "test-5" });
    setArchiveResponse(genericArchiveRoute, buildTitledZip(GENERIC_KANJI_TITLE, {
      revision: "test-5",
      indexUrl: GENERIC_MANAGED_INDEX_URL,
      downloadUrl: GENERIC_MANAGED_DOWNLOAD_URL,
      indexOverrides: { isUpdatable: true },
      terms: [
        ["食べる", "たべる", "v1", "v1", 1, [hoverUpdateGlossary], 1, ""],
        // Enough rows that the installation lasts several hover intervals.
        ...Array.from({ length: 20_000 }, (_, index) => [
          String.fromCharCode(0x4e00 + (index % 20_000)) + String.fromCharCode(0x3042 + (index % 80)),
          String.fromCharCode(0x3042 + (index % 80)), "n", "", 1, [`filler ${index}`], index + 2, "",
        ]),
      ],
    }));
    const heldHoverDownload = Promise.withResolvers();
    const releaseHoverDownload = Promise.withResolvers();
    genericArchiveRoute.respond = async () => {
      heldHoverDownload.resolve();
      await releaseHoverDownload.promise;
      return genericArchiveRoute;
    };
    const hoverStates = [];
    const updatingSamples = [];
    const hoverStartedAt = Date.now();
    let hovering = true;
    const verbBox = await (await tab.$("#verb")).boundingBox();
    // Like hoverForPopup, step off and back onto the word until a popup renders:
    // a reply the state change just invalidated is discarded and the reader
    // waits for the pointer to move again, as it would under a real hand.
    const hoverOnce = async () => {
      for (const deadline = Date.now() + 3_000; Date.now() < deadline;) {
        await tab.mouse.move(2, 2);
        await tab.mouse.move(verbBox.x + verbBox.width * 0.15, verbBox.y + verbBox.height / 2);
        for (const attemptDeadline = Date.now() + 400; Date.now() < attemptDeadline;) {
          await new Promise(resolve => setTimeout(resolve, 50));
          const state = await popup.state().catch(() => null);
          if (state !== null && popup.visible(state)) return state.plain;
        }
      }
      return null;
    };
    const hoverLoop = (async () => {
      while (hovering) {
        // Escape closes the retained view so that each pass is a fresh lookup;
        // the next pass starts as soon as this one has rendered (or given up).
        await tab.keyboard.press("Escape");
        await popup.waitForHidden(1_000);
        hoverStates.push({ at: Date.now() - hoverStartedAt, plain: await hoverOnce() });
      }
    })();
    const statusLoop = (async () => {
      while (hovering) {
        const status = await page.evaluate(() => chrome.runtime.sendMessage({
          target: "hoshidicts-offscreen", type: "hd_status", requestId: "e2e-hover-update-status",
        }));
        if (status?.updating) updatingSamples.push({ at: Date.now() - hoverStartedAt, ...status.updating });
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })();
    await scheduleManagedCheckSoon();
    const hoverDownloadHeld = await Promise.race([
      heldHoverDownload.promise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 30_000)),
    ]);
    const rowWhileUpdating = hoverDownloadHeld
      ? await page.waitForFunction(dictionaryId => {
        const text = document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-update-status`)?.textContent;
        return text === "Updating…" ? text : false;
      }, { timeout: 10_000, polling: 100 }, GENERIC_KANJI_ID).then(handle => handle.jsonValue()).catch(() => null)
      : null;
    // The hold also lets the status poll observe the downloading phase.
    for (const deadline = Date.now() + 10_000; hoverDownloadHeld && Date.now() < deadline
      && !updatingSamples.some(entry => entry.phase === "downloading");) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    releaseHoverDownload.resolve();
    genericArchiveRoute.respond = null;
    hoverUpdatedPackage = await page.waitForFunction(async dictionaryId => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const dictionary = dictionaryState?.dictionaries?.find(entry => entry.id === dictionaryId);
      return dictionary?.revision === "test-5" && dictionary.lastUpdateCheck?.status === "up-to-date" ? dictionary : false;
    }, { timeout: 90_000, polling: 100 }, GENERIC_KANJI_ID).then(handle => handle.jsonValue()).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 500));
    hovering = false;
    await Promise.all([hoverLoop, statusLoop]);
    const afterHoverUpdate = await hover("#verb", { accept: state => state.text.includes(hoverUpdateGlossary) });
    const pathsAfterHoverUpdate = await listOpfsPaths(page);
    // The row reads Updating… from the last status poll until the next one (at
    // most a second later) reports the import settled.
    const rowAfterHoverUpdate = await page.waitForFunction(dictionaryId => {
      const text = document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-update-status`)?.textContent;
      return text === "Up to date" ? text : false;
    }, { timeout: 5_000, polling: 100 }, GENERIC_KANJI_ID).then(handle => handle.jsonValue()).catch(() => null);
    const hoverTexts = hoverStates.map(entry => entry.plain);
    const duringHoverUpdate = hoverTexts.filter(text => text !== null && !text.includes(hoverUpdateGlossary));
    check(
      "hovering through a scheduled update never sees an update notice and ends on the new revision",
      beforeHoverUpdate !== null && hoverDownloadHeld && rowWhileUpdating === "Updating…"
        && updatingSamples.some(entry => entry.id === GENERIC_KANJI_ID && entry.phase === "downloading")
        && updatingSamples.some(entry => entry.id === GENERIC_KANJI_ID && entry.phase === "installing" && entry.fallback === null)
        && hoverTexts.length >= 5
        && hoverTexts.every(text => text !== null && !text.includes("Dictionary update in progress") && text.includes("食べる"))
        && duringHoverUpdate.length > 0
        && duringHoverUpdate.every(text => text.includes(`${GENERIC_KANJI_TITLE} verb fixture`))
        && hoverTexts.some(text => text.includes(hoverUpdateGlossary))
        && afterHoverUpdate !== null
        && hoverUpdatedPackage?.enabled === true && hoverUpdatedPackage.path !== beforeHoverUpdatePackage?.path
        && generationExists(pathsAfterHoverUpdate, hoverUpdatedPackage.path)
        && generationIsAbsent(pathsAfterHoverUpdate, ownedGenerationRoot(beforeHoverUpdatePackage?.path, GENERIC_KANJI_TITLE))
        && rowAfterHoverUpdate === "Up to date",
      JSON.stringify({
        beforeHoverUpdate: beforeHoverUpdate?.text?.slice(0, 200), hoverDownloadHeld, rowWhileUpdating, updatingSamples,
        hoverStates: hoverStates.map(entry => ({
          at: entry.at,
          old: entry.plain?.includes(`${GENERIC_KANJI_TITLE} verb fixture`) ?? null,
          new: entry.plain?.includes(hoverUpdateGlossary) ?? null,
          notice: entry.plain?.includes("Dictionary update in progress") ?? null,
        })),
        afterHoverUpdate: afterHoverUpdate?.text?.slice(0, 200),
        beforeHoverUpdatePackage, hoverUpdatedPackage, pathsAfterHoverUpdate, rowAfterHoverUpdate,
      }),
    );
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await page.bringToFront();
    await setGenericEnabled(false);
  });

  step("worker restart recreates the update alarm", async () => {
    // Simulate Chrome clearing the configured alarm before worker restart.
    await page.evaluate(alarmName => chrome.alarms.clear(alarmName), MANAGED_UPDATE_ALARM);
    const alarmGone = await page.waitForFunction(async (alarmName) =>
      (await chrome.alarms.get(alarmName)) === undefined,
    { timeout: 30_000, polling: 100 }, MANAGED_UPDATE_ALARM)
      .then(() => true)
      .catch(() => false);
    setupArchives.routes = null;
    await updateIndexSession.send("Fetch.disable");
    await updateIndexSession.detach();
    const updateWorkerDiagnostics = watchedServiceWorkers.get(updateWorkerTarget);
    if (updateWorkerDiagnostics) {
      await updateWorkerDiagnostics.client.detach();
      watchedServiceWorkers.delete(updateWorkerTarget);
    }
    const browserCdp = await browser.target().createCDPSession();
    const targetInfos = await browserCdp.send("Target.getTargets");
    const workerTargetInfo = targetInfos.targetInfos.find((target) =>
      target.type === "service_worker"
        && target.url === `chrome-extension://${extensionId}/background.js`);
    const serviceWorkerCdp = await page.createCDPSession();
    const workerScriptUrl = `chrome-extension://${extensionId}/background.js`;
    const runningWorkerPromise = waitForRunningServiceWorker(serviceWorkerCdp, workerScriptUrl);
    await serviceWorkerCdp.send("ServiceWorker.enable");
    const runningWorker = await runningWorkerPromise;
    const stopWorkerReply = runningWorker === null
      ? { error: "the running managed-update service worker version was not found" }
      : await serviceWorkerCdp.send("ServiceWorker.stopWorker", {
          versionId: runningWorker.versionId,
        });
    const stoppedWorker = runningWorker?.targetId !== undefined
      && await waitForCdpTargetGone(browserCdp, runningWorker.targetId);
    const restartedWorkerPromise = waitForCdpTarget(browserCdp, (target) =>
      target.type === "service_worker"
        && target.url === `chrome-extension://${extensionId}/background.js`
        && target.targetId !== runningWorker?.targetId);
    const restartedPage = await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 })
      .then(() => true)
      .catch((error) => ({ error: String(error) }));
    const restartedWorker = await restartedWorkerPromise;
    startupTabsAfterWorkerRestart = startupTabs();
    const restartWakeReply = await page.evaluate(() => Promise.race([
      chrome.runtime.sendMessage({
        target: "hoshidicts-worker",
        type: "hd_state_read",
      }),
      new Promise((resolveWake) => setTimeout(() => resolveWake({ timeout: true }), 10_000)),
    ])).catch((error) => ({ error: String(error) }));
    const expectedRecreatedCheck = Date.parse((hoverUpdatedPackage ?? failedAlarmPackage).lastUpdateCheck.checkedAt) + 3_600_000;
    const recreatedAlarm = await page.waitForFunction(async ({ alarmName, expected }) => {
      const alarms = await chrome.alarms.getAll();
      const alarm = alarms.find((candidate) => candidate.name === alarmName);
      return alarm?.periodInMinutes === undefined && alarm?.scheduledTime === expected ? { alarm, alarms } : false;
    }, { timeout: 30_000, polling: 100 }, { alarmName: MANAGED_UPDATE_ALARM, expected: expectedRecreatedCheck })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    await serviceWorkerCdp.send("ServiceWorker.disable");
    await serviceWorkerCdp.detach();
    await browserCdp.detach();
    check(
      "worker restart recreates the configured managed-update alarm",
      alarmGone
        && workerTargetInfo !== undefined
        && stoppedWorker === true
        && restartedPage === true
        && restartWakeReply?.ok === true
        && restartedWorker?.url === `chrome-extension://${extensionId}/background.js`
        && recreatedAlarm?.alarms?.filter(alarm => alarm.name === MANAGED_UPDATE_ALARM).length === 1
        && recreatedAlarm.alarm.name === MANAGED_UPDATE_ALARM
        && recreatedAlarm.alarm.periodInMinutes === undefined
        && recreatedAlarm.alarm.scheduledTime === expectedRecreatedCheck,
      JSON.stringify({
        alarmGone,
        workerTargetInfo,
        runningWorker,
        stopWorkerReply,
        stoppedWorker,
        restartedPage,
        restartWakeReply,
        restartedWorker,
        recreatedAlarm,
      }),
    );
  });
});

export { startupTabsAfterWorkerRestart };
