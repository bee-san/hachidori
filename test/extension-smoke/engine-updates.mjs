/*
 * Trusted recommended imports and managed updates through the real engine.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./engine-replacement.mjs";
import { describe } from "node:test";
import { buildAnkiFields } from "../../extension/anki-values.js";
import { dictionaryImportTarget } from "../../extension/dictionary-import.js";
import { recommendedIndexUrlMatches } from "../../extension/managed-dictionary-source.js";
import {
  RECOMMENDED_DICTIONARIES as RECOMMENDED_CATALOGUE,
} from "../../extension/recommended-dictionaries.js";
import { buildRecommendedZip } from "../make-fixture.mjs";
import {
  advancedStateDuringCleanup,
  alarms,
  failAfterCommittedRevision,
  idb,
  importedPackage,
  pageChrome,
  request,
  setAdvanceGroupsAfterCommittedRevision,
  setFailAfterCommittedRevision,
  setLoseNextStateCasReply,
  storage,
  storedDictionaryState,
  swChrome,
} from "./engine.mjs";
import {
  createObjectURL,
  FIXTURE_TITLE,
  ownedGenerationRoot,
  RECOMMENDED_DICTIONARIES,
  remoteArchive,
  remoteJson,
  remoteResponses,
} from "./fakes.mjs";
import { check, section, step } from "./harness.mjs";

// Values that more than one step uses; the step that creates each one assigns it.
let recommended, updatedTitle, localUpdateTitle, reloadedManagedState, reloadedManagedPackage,
  updateTarget, updateAlarmName, managedId, managedGroup, archiveRequests, manuallyUpdated,
  cleanupRaceGroup, cleanupRaceState, cleanupRacePackage, alarmRevision, makeManagedCheckDue,
  alarmUpdated, communityTitle, communityIndexUrl, communityDownloadUrl, communityZip, community,
  rotatingCommunityDownloadUrl, editCommunity, transportStart, renamedCommunityTitle,
  statusFailureState, statusFailureCommunity;

describe("engine: recommended imports and managed updates", () => {
  step("trusted recommended imports", async () => {
    section("trusted recommended imports");
    recommended = RECOMMENDED_DICTIONARIES[0];
    const recommendedFields = {
      sourceId: recommended.sourceId,
      finalUrl: `https://release-assets.githubusercontent.com/github-production-release-asset/${recommended.githubRepositoryId}/asset`
        + "?response-content-disposition=attachment%3B%20filename%3Djitendex-yomitan.zip",
    };
    const recommendedArchive = (overrides = {}) => createObjectURL(buildRecommendedZip({
      title: recommended.title,
      revision: recommended.revision,
      indexUrl: recommended.indexUrl,
      downloadUrl: recommended.downloadUrl,
      capabilities: recommended.capabilities,
      ...overrides,
    }));
    const rejectRecommended = async (name, fields, overrides, importedTitle) => {
      const before = await storedDictionaryState();
      const rowsBefore = idb.keys("/dicts").filter((path) => path.includes("/dicts/.hdw-generation-")).sort();
      const reply = await request("hd_import", {
        blobUrl: recommendedArchive(overrides),
        fileName: `${name}.zip`,
        ...fields,
      });
      const after = await storedDictionaryState();
      const rowsAfter = idb.keys("/dicts").filter((path) => path.includes("/dicts/.hdw-generation-")).sort();
      check(
        name,
        reply.ok === false
          && JSON.stringify(after) === JSON.stringify(before)
          && JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore),
        JSON.stringify({ reply, before, after, rowsBefore, rowsAfter }),
      );
      // Keeps this stage isolated when run against a pre-feature engine during
      // test-first development, where the trust fields are simply ignored.
      await request("hd_remove", { title: importedTitle });
    };
    await rejectRecommended(
      "recommended import rejects an unknown catalogue source before publication",
      { sourceId: "not-in-the-catalogue", finalUrl: recommended.downloadUrl },
      {},
      recommended.title,
    );
    await rejectRecommended(
      "recommended import rejects a final URL outside its catalogue entry",
      { sourceId: recommended.sourceId, finalUrl: "https://example.invalid/not-jitendex.zip" },
      {},
      recommended.title,
    );
    await rejectRecommended(
      "recommended import rejects a release asset from another repository",
      {
        sourceId: recommended.sourceId,
        finalUrl: "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset"
          + "?response-content-disposition=attachment%3B%20filename%3Djitendex-yomitan.zip",
      },
      {},
      recommended.title,
    );
    await rejectRecommended(
      "recommended import rejects a mismatched title before publication",
      recommendedFields,
      { title: "Not Jitendex" },
      "Not Jitendex",
    );
    await rejectRecommended(
      "recommended import rejects mismatched capabilities before publication",
      recommendedFields,
      { capabilities: ["freq"] },
      recommended.title,
    );

    const trustedImport = await request("hd_import", {
      blobUrl: recommendedArchive({ capabilities: ["term", "freq", "media"] }),
      fileName: "jitendex-yomitan.zip",
      ...recommendedFields,
      // Message-owned metadata must never override the built-in catalogue.
      catalogue: {
        indexUrl: "https://example.invalid/forged-index.json",
        downloadUrl: "https://example.invalid/forged.zip",
      },
    });
    const trustedState = await storedDictionaryState();
    const trustedPackage = trustedState.dictionaries.find(
      (dictionary) => dictionary.sourceId === recommended.sourceId,
    );
    check(
      "recommended import publishes its revision and catalogue-owned source atomically",
      trustedImport.ok === true
        && trustedImport.report?.success === true
        && trustedPackage?.title === recommended.title
        && trustedPackage?.revision === recommended.revision
        && trustedPackage?.sourceId === recommended.sourceId
        && trustedPackage?.isUpdatable === true
        && trustedPackage?.indexUrl === recommended.indexUrl
        && trustedPackage?.downloadUrl === recommended.downloadUrl
        && trustedPackage?.termCount === 2
        && trustedPackage?.frequencyCount === 1
        && trustedPackage?.mediaCount === 1,
      JSON.stringify({ trustedImport, trustedState }),
    );
    const trustedIndex = trustedState.dictionaries.findIndex(
      (dictionary) => dictionary.sourceId === recommended.sourceId,
    );
    const presentedState = await request("hd_apply_state", {
      baseRevision: trustedState.revision,
      dictionaries: trustedState.dictionaries.map((dictionary, index) => index === trustedIndex
        ? { ...dictionary, displayName: "Starter terms", enabled: false, favorite: true, updateScheduleOverride: "off" }
        : dictionary),
    });
    const presentedPackage = presentedState.state?.dictionaries?.[trustedIndex];
    const stableMarkerTemplates = {
      Alias: { value: "{single-glossary-starter-terms-plain-no-dictionary}", overwriteMode: "coalesce" },
      Package: { value: `{single-glossary-id--${trustedPackage.id}-brief}`, overwriteMode: "coalesce" },
      Historical: { value: "{single-glossary-jitendexorg-2026-08-11}", overwriteMode: "coalesce" },
    };
    const stableMarkerTemplateSnapshot = JSON.stringify(stableMarkerTemplates);
    const markerFields = dictionary => buildAnkiFields({
      term: { expression: "辞書", reading: "じしょ", rules: "", frequencies: [], pitches: [],
        glossaries: [
          { dictionary: dictionary.title, glossary: '["dictionary"]', definitionTags: "", termTags: "" },
          { dictionary: dictionary.title, glossary: '["duplicate row"]', definitionTags: "", termTags: "" },
        ] },
      trace: [], sentence: "辞書", matchOffset: 0, matched: "辞書", popupSelectionText: "",
      searchQuery: "辞書", documentTitle: "marker integration",
      dictionaryAliases: { [dictionary.title]: dictionary.displayName },
      dictionaryIds: { [dictionary.title]: dictionary.id },
      frequencyDictionaries: [],
    }, stableMarkerTemplates, { definition: ({ dictionary: selected } = {}) =>
      selected === dictionary.title ? "matched" : "" });
    const markersBeforeUpdate = await markerFields(presentedPackage);
    updatedTitle = "Jitendex.org [2026-09-05]";
    const updatedRevision = "2026.09.05.0";
    const updatedImport = await request("hd_import", {
      blobUrl: recommendedArchive({ title: updatedTitle, revision: updatedRevision }),
      fileName: "jitendex-yomitan.zip",
      ...recommendedFields,
    });
    const updatedState = await storedDictionaryState();
    const updatedPackage = updatedState.dictionaries[trustedIndex];
    check(
      "a dated recommended update preserves package identity, order, and presentation",
      presentedState.ok === true
        && updatedImport.ok === true
        && updatedState.dictionaries.length === trustedState.dictionaries.length
        && updatedPackage?.id === trustedPackage.id
        && updatedPackage?.title === updatedTitle
        && updatedPackage?.revision === updatedRevision
        && updatedPackage?.sourceId === recommended.sourceId
        && updatedPackage?.displayName === "Starter terms"
        && updatedPackage?.enabled === false
        && updatedPackage?.updateScheduleOverride === "off"
        && updatedPackage?.favorite === true,
      JSON.stringify({ presentedState, updatedImport, updatedState }),
    );
    localUpdateTitle = "Jitendex.org [2026-09-06]";
    const localUpdateRevision = "2026.09.06.0";
    const localUpdateImport = await request("hd_import", {
      blobUrl: recommendedArchive({ title: localUpdateTitle, revision: localUpdateRevision }),
      fileName: "jitendex-yomitan.zip",
      importDecision: {
        action: "replace",
        identity: {
          title: localUpdateTitle,
          revision: localUpdateRevision,
          indexUrl: recommended.indexUrl,
          downloadUrl: recommended.downloadUrl,
        },
        matchKind: "source",
        target: dictionaryImportTarget(updatedPackage),
      },
    });
    const localUpdateState = await storedDictionaryState();
    const localUpdatePackage = localUpdateState.dictionaries[trustedIndex];
    check(
      "a local managed reimport matches its index URL and preserves catalogue identity",
      localUpdateImport.ok === true
        && localUpdateState.dictionaries.length === trustedState.dictionaries.length
        && localUpdatePackage?.id === trustedPackage.id
        && localUpdatePackage?.title === localUpdateTitle
        && localUpdatePackage?.revision === localUpdateRevision
        && localUpdatePackage?.sourceId === recommended.sourceId
        && localUpdatePackage?.displayName === "Starter terms"
        && localUpdatePackage?.enabled === false
        && localUpdatePackage?.updateScheduleOverride === "off"
        && localUpdatePackage?.favorite === true,
      JSON.stringify({ localUpdateImport, localUpdateState }),
    );
    const collisionRowsBefore = idb.keys("/dicts")
      .filter((path) => path.includes("/dicts/.hdw-generation-"))
      .sort();
    const collidingLocalReimport = await request("hd_import", {
      blobUrl: recommendedArchive({
        title: FIXTURE_TITLE,
        revision: "2026.09.06.collision",
      }),
      fileName: "colliding-local-reimport.zip",
      importDecision: {
        action: "replace",
        identity: {
          title: FIXTURE_TITLE,
          revision: "2026.09.06.collision",
          indexUrl: recommended.indexUrl,
          downloadUrl: recommended.downloadUrl,
        },
        matchKind: "source",
        target: dictionaryImportTarget(localUpdatePackage),
      },
    });
    const collisionState = await storedDictionaryState();
    const collisionRowsAfter = idb.keys("/dicts")
      .filter((path) => path.includes("/dicts/.hdw-generation-"))
      .sort();
    check(
      "a source-target decision cannot bypass an exact canonical-title match",
      collidingLocalReimport.ok === false
        && collidingLocalReimport.error?.includes("no longer matches the imported source")
        && JSON.stringify(collisionState) === JSON.stringify(localUpdateState)
        && JSON.stringify(collisionRowsAfter) === JSON.stringify(collisionRowsBefore),
      JSON.stringify({
        collidingLocalReimport,
        localUpdateState,
        collisionState,
        collisionRowsBefore,
        collisionRowsAfter,
      }),
    );
    const managedReload = await request("hd_reload");
    reloadedManagedState = await storedDictionaryState();
    reloadedManagedPackage = reloadedManagedState.dictionaries[trustedIndex];
    const markersAfterRestart = await markerFields(reloadedManagedPackage);
    check(
      "managed package identity survives dictionary reconciliation",
      managedReload.ok === true
        && reloadedManagedPackage?.id === trustedPackage.id
        && reloadedManagedPackage?.title === localUpdateTitle
        && reloadedManagedPackage?.sourceId === recommended.sourceId
        && reloadedManagedPackage?.displayName === "Starter terms"
        && reloadedManagedPackage?.enabled === false
        && reloadedManagedPackage?.favorite === true,
      JSON.stringify({ managedReload, reloadedManagedState }),
    );
    check(
      "stable single-glossary aliases and package IDs survive dated update and restart without rewriting templates",
      /^[0-9a-f]{32}$/u.test(trustedPackage.id)
        && markersBeforeUpdate.Alias === "matched"
        && markersBeforeUpdate.Package === "matched"
        && markersBeforeUpdate.Historical === "matched"
        && markersAfterRestart.Alias === "matched"
        && markersAfterRestart.Package === "matched"
        && markersAfterRestart.Historical === ""
        && JSON.stringify(stableMarkerTemplates) === stableMarkerTemplateSnapshot,
      JSON.stringify({
        packageId: trustedPackage.id,
        beforeTitle: presentedPackage?.title,
        afterTitle: reloadedManagedPackage?.title,
        markersBeforeUpdate,
        markersAfterRestart,
        templatesUnchanged: JSON.stringify(stableMarkerTemplates) === stableMarkerTemplateSnapshot,
      }),
    );
  });

  step("managed dictionary updates", async () => {
    section("managed dictionary updates");
    updateTarget = "hachidori-updates";
    updateAlarmName = "hachidori-managed-dictionary-updates";
    managedId = reloadedManagedPackage.id;
    managedGroup = { id: "managed", name: "Managed", dictionaryIds: [managedId] };
    const grouped = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      baseRevision: reloadedManagedState.revision,
      dictionaries: reloadedManagedState.dictionaries,
      groups: [managedGroup],
    });
    check("managed update fixture adds a stable-id group", grouped?.ok === true, JSON.stringify(grouped));

    archiveRequests = { count: 0 };
    const untrustedIndexRevision = "2026.09.06.0";
    remoteJson(
      recommended.indexUrl,
      { revision: untrustedIndexRevision },
      200,
      "https://unrelated.example/update-index.json",
    );
    const untrustedIndexCheck = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_check",
    });
    const untrustedIndexState = await storedDictionaryState();
    const untrustedIndexPackage = untrustedIndexState.dictionaries.find((entry) => entry.id === managedId);
    const untrustedIndexOutcome = untrustedIndexCheck?.outcomes?.find((entry) => entry.id === managedId);
    const jmnedictSource = RECOMMENDED_CATALOGUE.find((entry) => entry.sourceId === "jmnedict");
    check(
      "recommended update indexes stay pinned to their catalogue repository",
      untrustedIndexCheck?.ok === true
        && untrustedIndexOutcome?.status === "check-failed"
        && untrustedIndexOutcome.error?.includes("unexpected final URL")
        && untrustedIndexPackage?.revision === reloadedManagedPackage.revision
        && untrustedIndexPackage?.path === reloadedManagedPackage.path
        && untrustedIndexPackage?.lastUpdateCheck?.status === "check-failed"
        && archiveRequests.count === 0
        && recommendedIndexUrlMatches(
          jmnedictSource,
          "https://github.com/yomidevs/jmdict-yomitan/releases/download/JMnedict.2026-09-04/JMnedict.json",
        )
        && !recommendedIndexUrlMatches(
          jmnedictSource,
          "https://github.com/unrelated/project/releases/download/JMnedict.2026-09-04/JMnedict.json",
        ),
      JSON.stringify({ untrustedIndexCheck, untrustedIndexState, archiveRequests }),
    );
  });

  step("Check now records a disabled managed package without downloading", async () => {
    const checkedRevision = "2026.09.07.0";
    remoteJson(recommended.indexUrl, { revision: checkedRevision });
    remoteArchive(
      recommended.downloadUrl,
      buildRecommendedZip({
        title: "Jitendex.org [2026-09-07]",
        revision: checkedRevision,
        indexUrl: recommended.indexUrl,
        downloadUrl: recommended.downloadUrl,
        capabilities: recommended.capabilities,
      }),
      recommended.downloadUrl,
      archiveRequests,
    );
    const checked = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_check",
    });
    const checkedState = await storedDictionaryState();
    const checkedManaged = checkedState.dictionaries.find((entry) => entry.id === managedId);
    const checkedLocal = checkedState.dictionaries.find((entry) => entry.id === importedPackage.id);
    const checkedGlobals = (await storage.api().local.get("dictionaryUpdates")).dictionaryUpdates;
    check(
      "Check now records a disabled managed package without downloading and skips local archives",
      checked?.ok === true
        && checkedManaged?.enabled === false
        && checkedManaged?.lastUpdateCheck?.status === "update-available"
        && checkedManaged.lastUpdateCheck.remoteRevision === checkedRevision
        && checkedLocal?.lastUpdateCheck === null
        && archiveRequests.count === 0
        && Number.isFinite(Date.parse(checkedGlobals?.lastCheckedAt)),
      JSON.stringify({ checked, checkedState, checkedGlobals, archiveRequests }),
    );

    // The per-package update state is structured data. Losing the import CAS reply
    // must still recognize the cloned readback as the exact committed value. Real
    // Chrome also returns stored object keys in a different order, which must not
    // prevent the replaced generation from being collected after that readback.
    const managedGenerationBeforeManual = ownedGenerationRoot(
      checkedManaged.path,
      checkedManaged.title,
    );
    setLoseNextStateCasReply(true);
    storage.sortDictionaryKeysOnRead(true);
    const manualUpdate = await Promise.race([
      pageChrome.runtime.sendMessage({
        target: updateTarget,
        type: "hd_updates_install",
        dictionaryIds: [managedId],
      }),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 10000)),
    ]);
    storage.sortDictionaryKeysOnRead(false);
    const manualState = await storedDictionaryState();
    manuallyUpdated = manualState.dictionaries.find((entry) => entry.id === managedId);
    const managedGenerationRowsAfterManual = idb.keys("/dicts");
    check(
      "manual Update rechecks and atomically replaces through the existing import transaction",
      manualUpdate?.ok === true
        && manualUpdate.timeout !== true
        && archiveRequests.count === 1
        && manuallyUpdated?.revision === checkedRevision
        && manuallyUpdated?.id === managedId
        && manuallyUpdated?.displayName === "Starter terms"
        && manuallyUpdated?.enabled === false
        && manuallyUpdated?.favorite === true
        && manuallyUpdated?.lastUpdateCheck?.status === "up-to-date"
        && !managedGenerationRowsAfterManual.some((path) =>
          path === managedGenerationBeforeManual
            || path.startsWith(`${managedGenerationBeforeManual}/`))
        && JSON.stringify(manualState.groups) === JSON.stringify([managedGroup]),
      JSON.stringify({
        manualUpdate,
        manualState,
        archiveRequests,
        managedGenerationBeforeManual,
        managedGenerationRowsAfterManual,
      }),
    );
  });

  step("generation cleanup follows a group-only state advance", async () => {
    const cleanupRaceRevision = "2026.09.07.1";
    cleanupRaceGroup = { ...managedGroup, name: "Managed after update" };
    const cleanupRaceGeneration = ownedGenerationRoot(
      manuallyUpdated.path,
      manuallyUpdated.title,
    );
    const cleanupArchiveRequests = { count: 0 };
    remoteJson(recommended.indexUrl, { revision: cleanupRaceRevision });
    remoteArchive(
      recommended.downloadUrl,
      buildRecommendedZip({
        title: "Jitendex.org [2026-09-07]",
        revision: cleanupRaceRevision,
        indexUrl: recommended.indexUrl,
        downloadUrl: recommended.downloadUrl,
        capabilities: recommended.capabilities,
      }),
      recommended.downloadUrl,
      cleanupArchiveRequests,
    );
    setAdvanceGroupsAfterCommittedRevision({
      revision: cleanupRaceRevision,
      groups: [cleanupRaceGroup],
    });
    const cleanupRaceUpdate = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [managedId],
    });
    cleanupRaceState = await storedDictionaryState();
    cleanupRacePackage = cleanupRaceState.dictionaries.find((entry) => entry.id === managedId);
    const cleanupRaceRows = idb.keys("/dicts");
    check(
      "generation cleanup follows an authoritative group-only state advance",
      cleanupRaceUpdate?.ok === true
        && cleanupArchiveRequests.count === 1
        && advancedStateDuringCleanup?.ok === true
        && cleanupRacePackage?.revision === cleanupRaceRevision
        && JSON.stringify(cleanupRaceState.groups) === JSON.stringify([cleanupRaceGroup])
        && !cleanupRaceRows.some((path) =>
          path === cleanupRaceGeneration || path.startsWith(`${cleanupRaceGeneration}/`)),
      JSON.stringify({
        cleanupRaceUpdate,
        cleanupRaceState,
        cleanupArchiveRequests,
        advancedStateDuringCleanup,
        cleanupRaceGeneration,
        cleanupRaceRows,
      }),
    );
  });

  step("one global schedule creates one browser alarm", async () => {
    await pageChrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: cleanupRaceState.revision, dictionaries: cleanupRaceState.dictionaries.map(dictionary => dictionary.id === managedId
        ? { ...dictionary, updateScheduleOverride: null } : dictionary) });
    const scheduleBase = (await storage.api().local.get("dictionaryUpdates")).dictionaryUpdates?.revision ?? 0;
    const scheduled = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_schedule",
      baseRevision: scheduleBase,
      schedule: "hourly",
    });
    const hourlyAlarm = await alarms.api.get(updateAlarmName);
    const managedAlarms = [...alarms.values.values()].filter(alarm => alarm.name === updateAlarmName);
    check(
      "one global schedule creates one browser alarm",
      scheduled?.ok === true
        && scheduled.settings?.schedule === "hourly"
        && hourlyAlarm?.periodInMinutes === undefined
        && hourlyAlarm?.scheduledTime === Date.parse(cleanupRacePackage.lastUpdateCheck.checkedAt) + 3_600_000
        && managedAlarms.length === 1,
      JSON.stringify({ scheduled, hourlyAlarm, alarms: [...alarms.values.values()] }),
    );

    const staleSchedule = await pageChrome.runtime.sendMessage({ target: updateTarget,
      type: "hd_updates_schedule", baseRevision: scheduleBase, schedule: "weekly" });
    const latestSchedule = (await storage.api().local.get("dictionaryUpdates")).dictionaryUpdates;
    check("managed update preferences reject stale schedule writes with the current revision and preserve the alarm",
      scheduled.settings?.revision === scheduleBase + 1 && staleSchedule?.ok === false
        && staleSchedule.settings?.revision === latestSchedule.revision
        && latestSchedule.schedule === "hourly"
        && (await alarms.api.get(updateAlarmName))?.scheduledTime === hourlyAlarm.scheduledTime,
      JSON.stringify({ scheduleBase, scheduled, staleSchedule, latestSchedule }));

    alarmRevision = "2026.09.08.0";
    makeManagedCheckDue = async () => {
      const state = await storedDictionaryState();
      return pageChrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
        baseRevision: state.revision, dictionaries: state.dictionaries.map(dictionary => dictionary.id === managedId
          ? { ...dictionary, lastUpdateCheck: { ...dictionary.lastUpdateCheck, checkedAt: new Date(Date.now() - 7_200_000).toISOString() } }
          : dictionary) });
    };
    remoteJson(recommended.indexUrl, { revision: alarmRevision });
    remoteArchive(
      recommended.downloadUrl,
      buildRecommendedZip({
        title: "Jitendex.org [2026-09-08]",
        revision: alarmRevision,
        indexUrl: recommended.indexUrl,
        downloadUrl: recommended.downloadUrl,
        capabilities: recommended.capabilities,
      }),
      recommended.downloadUrl,
      archiveRequests,
    );
    await makeManagedCheckDue();
    alarms.fire(updateAlarmName);
    const alarmDeadline = Date.now() + 10000;
    let alarmState = await storedDictionaryState();
    while ((alarmState.dictionaries.find((entry) => entry.id === managedId)?.revision !== alarmRevision
        || alarmState.dictionaries.find((entry) => entry.id === managedId)?.lastUpdateCheck?.status !== "up-to-date")
        && Date.now() < alarmDeadline) {
      await new Promise((done) => setTimeout(done, 25));
      alarmState = await storedDictionaryState();
    }
    alarmUpdated = alarmState.dictionaries.find((entry) => entry.id === managedId);
    check(
      "the scheduled alarm auto-installs available updates without deadlocking storage",
      alarmUpdated?.revision === alarmRevision
        && alarmUpdated?.lastUpdateCheck?.status === "up-to-date"
        && archiveRequests.count === 2
        && alarmUpdated.id === managedId
        && alarmUpdated.displayName === "Starter terms"
        && alarmUpdated.enabled === false
        && alarmUpdated.favorite === true
        && JSON.stringify(alarmState.groups) === JSON.stringify([cleanupRaceGroup]),
      JSON.stringify({ alarmState, archiveRequests }),
    );
  });

  step("service-worker startup recreates a missing configured alarm", async () => {
    await alarms.api.clear(updateAlarmName);
    swChrome.__events.onStartup.fire();
    const alarmRepairDeadline = Date.now() + 2000;
    let repairedAlarm = await alarms.api.get(updateAlarmName);
    while (!repairedAlarm && Date.now() < alarmRepairDeadline) {
      await new Promise((done) => setTimeout(done, 10));
      repairedAlarm = await alarms.api.get(updateAlarmName);
    }
    check(
      "service-worker startup recreates a missing configured alarm",
      repairedAlarm?.periodInMinutes === undefined
        && repairedAlarm?.scheduledTime === Date.parse(alarmUpdated.lastUpdateCheck.checkedAt) + 3_600_000
        && [...alarms.values].filter(([name]) => name === updateAlarmName).length === 1,
      JSON.stringify({ repairedAlarm, alarms: [...alarms.values.values()] }),
    );

    const failedRevision = "2026.09.09.0";
    const beforeFailedAlarm = await storedDictionaryState();
    const beforeFailedPackage = beforeFailedAlarm.dictionaries.find((entry) => entry.id === managedId);
    remoteJson(recommended.indexUrl, { revision: failedRevision });
    remoteArchive(
      recommended.downloadUrl,
      buildRecommendedZip({
        title: "Jitendex.org [2026-09-09]",
        revision: "wrong-revision",
        indexUrl: recommended.indexUrl,
        downloadUrl: recommended.downloadUrl,
        capabilities: recommended.capabilities,
      }),
      recommended.downloadUrl,
      archiveRequests,
    );
    await makeManagedCheckDue();
    alarms.fire(updateAlarmName);
    const failureDeadline = Date.now() + 10000;
    let failedAlarmState = await storedDictionaryState();
    while (!failedAlarmState.dictionaries.find((entry) => entry.id === managedId)?.lastUpdateCheck?.error
        && Date.now() < failureDeadline) {
      await new Promise((done) => setTimeout(done, 25));
      failedAlarmState = await storedDictionaryState();
    }
    const failedAlarmPackage = failedAlarmState.dictionaries.find((entry) => entry.id === managedId);
    check(
      "a failed scheduled replacement retains the old generation and reports the available revision",
      failedAlarmPackage?.revision === alarmRevision
        && failedAlarmPackage?.path === beforeFailedPackage.path
        && failedAlarmPackage?.lastUpdateCheck?.status === "update-available"
        && failedAlarmPackage?.lastUpdateCheck?.remoteRevision === failedRevision
        && failedAlarmPackage?.lastUpdateCheck?.error?.includes("revision")
        && JSON.stringify(failedAlarmState.groups) === JSON.stringify([cleanupRaceGroup]),
      JSON.stringify({ beforeFailedAlarm, failedAlarmState }),
    );
  });

  step("an index failure is recorded per item", async () => {
    remoteJson(recommended.indexUrl, {}, 503);
    const failedCheck = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_check",
    });
    const failedCheckState = await storedDictionaryState();
    const failedCheckPackage = failedCheckState.dictionaries.find((entry) => entry.id === managedId);
    check(
      "an index failure is recorded per item without changing the installed revision",
      failedCheck?.ok === true
        && failedCheckPackage?.revision === alarmRevision
        && failedCheckPackage?.lastUpdateCheck?.status === "check-failed"
        && failedCheckPackage?.lastUpdateCheck?.error?.includes("HTTP 503"),
      JSON.stringify({ failedCheck, failedCheckState }),
    );

    const scheduleOff = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_schedule",
      baseRevision: (await storage.api().local.get("dictionaryUpdates")).dictionaryUpdates.revision,
      schedule: "off",
    });
    check(
      "turning periodic checks off clears the one managed-update alarm",
      scheduleOff?.ok === true
        && scheduleOff.settings?.schedule === "off"
        && await alarms.api.get(updateAlarmName) === undefined,
      JSON.stringify({ scheduleOff, alarms: [...alarms.values.values()] }),
    );

    communityTitle = "Community Dictionary";
    communityIndexUrl = "https://example.test/community/index.json";
    communityDownloadUrl = "https://example.test/community/archive.zip";
    communityZip = ({
      title = communityTitle,
      revision,
      indexUrl = communityIndexUrl,
      downloadUrl = communityDownloadUrl,
    }) => buildRecommendedZip({ title, revision, indexUrl, downloadUrl, capabilities: ["term"] });
    const communityImport = await request("hd_import", {
      blobUrl: createObjectURL(communityZip({ revision: "community-1" })),
      fileName: "community.zip",
    });
    const communityState = await storedDictionaryState();
    community = communityState.dictionaries.find((entry) => entry.title === communityTitle);
    rotatingCommunityDownloadUrl = "https://example.test/community/releases/community-2.zip";
    const rotatingArchiveRequests = { count: 0 };
    remoteJson(communityIndexUrl, {
      revision: "community-2",
      downloadUrl: rotatingCommunityDownloadUrl,
    });
    remoteArchive(
      rotatingCommunityDownloadUrl,
      communityZip({ revision: "community-2" }),
      rotatingCommunityDownloadUrl,
      rotatingArchiveRequests,
    );
    const communityUpdate = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community?.id],
    });
    const updatedCommunityState = await storedDictionaryState();
    const updatedCommunity = updatedCommunityState.dictionaries.find((entry) => entry.id === community?.id);
    check(
      "a generic managed source can select a rotating HTTPS archive from its remote index",
      communityImport.ok === true
        && community?.sourceId === undefined
        && community?.isUpdatable === true
        && communityUpdate?.ok === true
        && updatedCommunity?.revision === "community-2"
        && updatedCommunity?.id === community.id
        && updatedCommunity?.lastUpdateCheck?.status === "up-to-date"
        && updatedCommunity?.indexUrl === communityIndexUrl
        && updatedCommunity?.downloadUrl === communityDownloadUrl
        && rotatingArchiveRequests.count === 1,
      JSON.stringify({
        communityImport,
        community,
        communityUpdate,
        updatedCommunityState,
        rotatingArchiveRequests,
      }),
    );
  });

  step("generic updates reject non-HTTPS redirects and remote download URLs", async () => {
    editCommunity = async (patch) => {
      const current = await storedDictionaryState();
      return pageChrome.runtime.sendMessage({
        target: "hoshidicts-worker",
        type: "hd_state_cas",
        baseRevision: current.revision,
        dictionaries: current.dictionaries.map((dictionary) =>
          dictionary.id === community.id ? { ...dictionary, ...patch } : dictionary),
      });
    };

    transportStart = (await storedDictionaryState()).dictionaries.find(
      (entry) => entry.id === community.id,
    );
    remoteJson(communityIndexUrl, {
      revision: "community-3",
      downloadUrl: "http://example.test/community-3.zip",
    });
    const insecureDownload = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    remoteJson(
      communityIndexUrl,
      { revision: "community-3" },
      200,
      "http://example.test/community-index.json",
    );
    const insecureIndexRedirect = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    remoteJson(communityIndexUrl, {
      revision: "community-3",
      downloadUrl: rotatingCommunityDownloadUrl,
    });
    remoteArchive(
      rotatingCommunityDownloadUrl,
      communityZip({ revision: "community-3" }),
      "http://example.test/community-3.zip",
    );
    const insecureArchiveRedirect = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    const transportState = await storedDictionaryState();
    const transportCommunity = transportState.dictionaries.find((entry) => entry.id === community.id);
    check(
      "generic updates reject non-HTTPS index redirects, archive redirects, and remote download URLs",
      insecureDownload?.outcomes?.[0]?.status === "check-failed"
        && insecureDownload.outcomes[0].error?.includes("non-HTTPS download URL")
        && insecureIndexRedirect?.outcomes?.[0]?.status === "check-failed"
        && insecureIndexRedirect.outcomes[0].error?.includes("non-HTTPS")
        && insecureArchiveRedirect?.outcomes?.[0]?.status === "update-available"
        && insecureArchiveRedirect.outcomes[0].error?.includes("unexpected final URL")
        && transportCommunity?.revision === "community-2"
        && transportCommunity?.path === transportStart.path,
      JSON.stringify({
        insecureDownload,
        insecureIndexRedirect,
        insecureArchiveRedirect,
        transportState,
      }),
    );
  });

  step("a managed replacement cannot take another package's title or ID", async () => {
    remoteJson(communityIndexUrl, { revision: "community-collision" });
    remoteArchive(
      communityDownloadUrl,
      communityZip({ title: FIXTURE_TITLE, revision: "community-collision" }),
    );
    const beforeTitleCollision = await storedDictionaryState();
    const titleCollisionUpdate = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    const titleCollisionState = await storedDictionaryState();
    const titleCollisionCommunity = titleCollisionState.dictionaries.find(
      (entry) => entry.id === community.id,
    );
    check(
      "a managed replacement cannot take another installed package's title or logical ID",
      titleCollisionUpdate?.ok === true
        && titleCollisionUpdate.outcomes?.[0]?.error?.includes("already installed")
        && titleCollisionCommunity?.title === communityTitle
        && titleCollisionCommunity?.revision === "community-2"
        && titleCollisionCommunity?.path === transportStart.path
        && titleCollisionState.dictionaries.filter((entry) => entry.title === FIXTURE_TITLE).length === 1,
      JSON.stringify({ beforeTitleCollision, titleCollisionUpdate, titleCollisionState }),
    );
    const collisionFixtureRestored = await request("hd_import", {
      blobUrl: createObjectURL(communityZip({ revision: "community-2" })),
      fileName: "community.zip",
    });

    const beforePathRace = (await storedDictionaryState()).dictionaries.find(
      (entry) => entry.id === community.id,
    );
    const pathRaceArchiveRequests = { count: 0 };
    remoteArchive(
      communityDownloadUrl,
      communityZip({ revision: "community-3" }),
      communityDownloadUrl,
      pathRaceArchiveRequests,
    );
    let concurrentReimport = null;
    remoteJson(communityIndexUrl, async () => {
      concurrentReimport = await request("hd_import", {
        blobUrl: createObjectURL(communityZip({ revision: "community-2" })),
        fileName: "community.zip",
      });
      return { revision: "community-3" };
    });
    const stalePathUpdate = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    const stalePathState = await storedDictionaryState();
    const stalePathCommunity = stalePathState.dictionaries.find((entry) => entry.id === community.id);
    check(
      "a same-revision reimport invalidates a managed check captured from the old path",
      collisionFixtureRestored?.ok === true
        && concurrentReimport?.ok === true
        && stalePathUpdate?.ok === true
        && stalePathUpdate.outcomes?.[0]?.error?.includes("changed while")
        && stalePathCommunity?.revision === "community-2"
        && stalePathCommunity?.path !== beforePathRace.path
        && stalePathCommunity?.lastUpdateCheck === null
        && pathRaceArchiveRequests.count === 0,
      JSON.stringify({
        collisionFixtureRestored,
        concurrentReimport,
        stalePathUpdate,
        stalePathState,
        pathRaceArchiveRequests,
      }),
    );
  });

  step("a stale check cannot downgrade a changed managed source", async () => {
    const changedCommunityIndexUrl = "https://example.test/community-other/index.json";
    const changedCommunityDownloadUrl = "https://example.test/community-other/archive.zip";
    const staleSourceArchiveRequests = { count: 0 };
    remoteArchive(
      changedCommunityDownloadUrl,
      buildRecommendedZip({
        title: communityTitle,
        revision: "community-3",
        indexUrl: changedCommunityIndexUrl,
        downloadUrl: changedCommunityDownloadUrl,
        capabilities: ["term"],
      }),
      changedCommunityDownloadUrl,
      staleSourceArchiveRequests,
    );
    let changedSource = null;
    remoteJson(communityIndexUrl, async () => {
      changedSource = await editCommunity({
        revision: "community-4",
        indexUrl: changedCommunityIndexUrl,
        downloadUrl: changedCommunityDownloadUrl,
        lastUpdateCheck: null,
      });
      return { revision: "community-3" };
    });
    const staleSourcePath = (await storedDictionaryState()).dictionaries.find(
      (entry) => entry.id === community.id,
    ).path;
    const staleSourceUpdate = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    const staleSourceState = await storedDictionaryState();
    const staleSourceCommunity = staleSourceState.dictionaries.find((entry) => entry.id === community.id);
    check(
      "a stale check cannot downgrade a dictionary whose managed source changed before import",
      changedSource?.ok === true
        && staleSourceUpdate?.ok === true
        && staleSourceUpdate.outcomes?.[0]?.error?.includes("changed while")
        && staleSourceCommunity?.revision === "community-4"
        && staleSourceCommunity?.path === staleSourcePath
        && staleSourceCommunity?.indexUrl === changedCommunityIndexUrl
        && staleSourceCommunity?.downloadUrl === changedCommunityDownloadUrl
        && staleSourceCommunity?.lastUpdateCheck === null
        && staleSourceArchiveRequests.count === 0,
      JSON.stringify({ changedSource, staleSourceUpdate, staleSourceState, staleSourceArchiveRequests }),
    );
  });

  step("a managed replacement revalidates after staging", async () => {
    const sourceRestored = await editCommunity({
      revision: "community-2",
      indexUrl: communityIndexUrl,
      downloadUrl: communityDownloadUrl,
      lastUpdateCheck: null,
    });
    const commitRaceArchiveRequests = { count: 0 };
    let concurrentRevision = null;
    remoteJson(communityIndexUrl, { revision: "community-3" });
    remoteArchive(
      communityDownloadUrl,
      buildRecommendedZip({
        title: communityTitle,
        revision: "community-3",
        indexUrl: communityIndexUrl,
        downloadUrl: communityDownloadUrl,
        capabilities: ["term"],
      }),
      communityDownloadUrl,
      commitRaceArchiveRequests,
      async () => {
        concurrentRevision = await editCommunity({
          revision: "community-4",
          lastUpdateCheck: null,
        });
      },
    );
    const beforeCommitRace = (await storedDictionaryState()).dictionaries.find(
      (entry) => entry.id === community.id,
    );
    const statusBeforeCommitRace = await request("hd_status");
    const staleCommitUpdate = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    const staleCommitState = await storedDictionaryState();
    const staleCommitCommunity = staleCommitState.dictionaries.find((entry) => entry.id === community.id);
    const statusAfterCommitRace = await request("hd_status");
    const lookupAfterCommitRace = await request("hd_lookup", { text: "食べる" });
    check(
      "a managed replacement revalidates after staging before unloading the working generation",
      sourceRestored?.ok === true
        && concurrentRevision?.ok === true
        && staleCommitUpdate?.ok === true
        && staleCommitUpdate.outcomes?.[0]?.error?.includes("changed while")
        && staleCommitCommunity?.revision === "community-4"
        && staleCommitCommunity?.path === beforeCommitRace.path
        && staleCommitCommunity?.lastUpdateCheck === null
        && commitRaceArchiveRequests.count === 1
        && statusAfterCommitRace.generation === statusBeforeCommitRace.generation
        && lookupAfterCommitRace.generation === statusBeforeCommitRace.generation
        && lookupAfterCommitRace.results?.some((result) => result.term?.expression === "食べる"),
      JSON.stringify({
        sourceRestored,
        concurrentRevision,
        staleCommitUpdate,
        staleCommitState,
        statusBeforeCommitRace,
        statusAfterCommitRace,
        lookupAfterCommitRace,
      }),
    );
  });

  step("a failed archive body leaves the committed generation loaded", async () => {
    const downloadFailureRestored = await editCommunity({
      revision: "community-2",
      indexUrl: communityIndexUrl,
      downloadUrl: communityDownloadUrl,
      lastUpdateCheck: null,
    });
    const beforeDownloadFailure = (await storedDictionaryState()).dictionaries.find(
      (entry) => entry.id === community.id,
    );
    const statusBeforeDownloadFailure = await request("hd_status");
    remoteJson(communityIndexUrl, { revision: "community-3" });
    const failingArchive = new Uint8Array(communityZip({ revision: "community-3" }));
    remoteResponses.set(communityDownloadUrl, async () => {
      let read = false;
      return {
        ok: true,
        status: 200,
        url: communityDownloadUrl,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            async read() {
              if (!read) {
                read = true;
                return { done: false, value: failingArchive.subarray(0, 32) };
              }
              throw new Error("injected archive stream failure");
            },
            releaseLock() {},
          }),
        },
      };
    });
    const failedDownloadUpdate = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    const failedDownloadState = await storedDictionaryState();
    const failedDownloadCommunity = failedDownloadState.dictionaries.find(
      (entry) => entry.id === community.id,
    );
    const statusAfterDownloadFailure = await request("hd_status");
    const lookupAfterDownloadFailure = await request("hd_lookup", { text: "食べる" });
    check(
      "a failed archive body leaves the committed generation loaded and searchable",
      downloadFailureRestored?.ok === true
        && failedDownloadUpdate?.ok === true
        && failedDownloadUpdate.outcomes?.[0]?.error?.includes("injected archive stream failure")
        && failedDownloadCommunity?.revision === beforeDownloadFailure.revision
        && failedDownloadCommunity?.path === beforeDownloadFailure.path
        && statusAfterDownloadFailure.generation === statusBeforeDownloadFailure.generation
        && lookupAfterDownloadFailure.generation === statusBeforeDownloadFailure.generation
        && lookupAfterDownloadFailure.results?.some((result) => result.term?.expression === "食べる"),
      JSON.stringify({
        downloadFailureRestored,
        failedDownloadUpdate,
        failedDownloadState,
        statusBeforeDownloadFailure,
        statusAfterDownloadFailure,
        lookupAfterDownloadFailure,
      }),
    );
  });

  step("a successful replacement commits its up-to-date status", async () => {
    const statusFixtureRestored = await editCommunity({
      revision: "community-2",
      indexUrl: communityIndexUrl,
      downloadUrl: communityDownloadUrl,
      lastUpdateCheck: null,
    });
    renamedCommunityTitle = "Renamed Community Dictionary";
    const selectedCommunityImage = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision: (await storage.api().local.get("options")).options?.revision ?? 0,
      options: { popupImageSource: { kind: "dictionary", title: communityTitle },
        pitchAccentFuriganaDictionary: communityTitle },
    });
    remoteJson(communityIndexUrl, { revision: "community-3" });
    remoteArchive(
      communityDownloadUrl,
      buildRecommendedZip({
        title: renamedCommunityTitle,
        revision: "community-3",
        indexUrl: communityIndexUrl,
        downloadUrl: communityDownloadUrl,
        capabilities: ["term"],
      }),
    );
    const beforeStatusFailure = (await storedDictionaryState()).dictionaries.find(
      (entry) => entry.id === community.id,
    );
    setFailAfterCommittedRevision({
      revision: "community-3",
      error: "injected post-install settings failure",
    });
    const statusFailureUpdate = await pageChrome.runtime.sendMessage({
      target: updateTarget,
      type: "hd_updates_install",
      dictionaryIds: [community.id],
    });
    statusFailureState = await storedDictionaryState();
    statusFailureCommunity = statusFailureState.dictionaries.find((entry) => entry.id === community.id);
    check(
      "a successful replacement commits its up-to-date status before a later settings write",
      statusFixtureRestored?.ok === true
        && statusFailureUpdate?.ok === false
        && statusFailureUpdate.error?.includes("injected post-install settings failure")
        && statusFailureCommunity?.revision === "community-3"
        && statusFailureCommunity?.path !== beforeStatusFailure.path
        && statusFailureCommunity?.lastUpdateCheck?.status === "up-to-date"
        && statusFailureCommunity.lastUpdateCheck.remoteRevision === "community-3"
        && statusFailureCommunity.lastUpdateCheck.error === null
        && failAfterCommittedRevision === null,
      JSON.stringify({ statusFixtureRestored, statusFailureUpdate, statusFailureState }),
    );
    const renamedImageOptions = (await storage.api().local.get("options")).options;
    const staleImageSelection = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      baseRevision: selectedCommunityImage.options.revision,
      options: { popupImageSource: selectedCommunityImage.options.popupImageSource },
    });
    check(
      "a managed title change migrates its image selection and rejects the old options revision",
      statusFailureCommunity.id === community.id
        && statusFailureCommunity.title === renamedCommunityTitle
        && renamedImageOptions.popupImageSource?.title === renamedCommunityTitle
        && renamedImageOptions.pitchAccentFuriganaDictionary === renamedCommunityTitle
        && renamedImageOptions.revision === selectedCommunityImage.options.revision + 1
        && staleImageSelection.conflict === true
        && staleImageSelection.options.popupImageSource?.title === renamedCommunityTitle,
      JSON.stringify({ statusFailureCommunity, renamedImageOptions, staleImageSelection }),
    );
  });

  step("the managed import protocol rejects an injected blob archive", async () => {
    const injectedBlobRowsBefore = idb.keys("/dicts").sort();
    const injectedBlobImport = await request("hd_import", {
      blobUrl: createObjectURL(communityZip({ revision: "community-injected" })),
      fileName: "injected-managed-update.zip",
      managedFingerprint: {
        id: statusFailureCommunity.id,
        path: statusFailureCommunity.path,
        revision: statusFailureCommunity.revision,
        source: {
          kind: "generic",
          sourceId: null,
          indexUrl: communityIndexUrl,
          downloadUrl: communityDownloadUrl,
        },
      },
      archiveUrl: communityDownloadUrl,
      expectedRevision: "community-injected",
      checkedAt: "2026-09-04T12:00:00.000Z",
    });
    const injectedBlobStateAfter = await storedDictionaryState();
    const injectedBlobRowsAfter = idb.keys("/dicts").sort();
    check(
      "the managed import protocol rejects an injected blob archive",
      injectedBlobImport?.ok === false
        && injectedBlobImport.error?.includes("blob URL")
        && JSON.stringify(injectedBlobStateAfter) === JSON.stringify(statusFailureState)
        && JSON.stringify(injectedBlobRowsAfter) === JSON.stringify(injectedBlobRowsBefore),
      JSON.stringify({
        injectedBlobImport,
        statusFailureState,
        injectedBlobStateAfter,
        injectedBlobRowsBefore,
        injectedBlobRowsAfter,
      }),
    );
    await request("hd_remove", { title: renamedCommunityTitle });
    await request("hd_remove", { title: "Jitendex.org [2026-09-08]" });
    await request("hd_remove", { title: localUpdateTitle });
    await request("hd_remove", { title: updatedTitle });
    await request("hd_remove", { title: recommended.title });
  });

  step("retired recommended source", async () => {
    // A package installed while its source was still recommended keeps that
    // sourceId after the catalogue drops the entry (#290). It is then an ordinary
    // local dictionary: never an update candidate, untouched by a check, and
    // still answering lookups.
    section("retired recommended source");
    const retiredTitle = "sankoku8-gpt-5.6-luna";
    const retiredImport = await request("hd_import", {
      blobUrl: createObjectURL(buildRecommendedZip({
        title: retiredTitle, revision: "sankoku8-gpt-5.6-luna", indexUrl: null, downloadUrl: null, capabilities: ["term"],
      })),
      fileName: "en.zip",
    });
    const retiredBase = await storedDictionaryState();
    const retiredId = retiredBase.dictionaries.find((entry) => entry.title === retiredTitle)?.id;
    // The record exactly as the installer committed it while the source was catalogued.
    const retiredSeed = await pageChrome.runtime.sendMessage({
      target: "hoshidicts-worker", type: "hd_state_cas", baseRevision: retiredBase.revision,
      dictionaries: retiredBase.dictionaries.map((entry) => entry.id !== retiredId ? entry : {
        ...entry, sourceId: "sankoku8-eng", isUpdatable: false, indexUrl: null,
        downloadUrl: "https://github.com/shoui520/sankoku8-eng/releases/download/latest/en.zip",
      }),
    });
    const retiredBefore = await storedDictionaryState();
    const retiredRowsBefore = idb.keys("/dicts").sort();
    const retiredCheck = await pageChrome.runtime.sendMessage({ target: updateTarget, type: "hd_updates_check" });
    const retiredScoped = await pageChrome.runtime.sendMessage({ target: updateTarget, type: "hd_updates_check", dictionaryIds: [retiredId] });
    const retiredAfter = await storedDictionaryState();
    const retiredLookup = await request("hd_lookup", { text: "辞書" });
    check(
      "a package from a retired recommended source stays local-only through update checks and keeps answering lookups",
      retiredImport.ok === true && retiredSeed?.ok === true
        && retiredBefore.dictionaries.find((entry) => entry.id === retiredId)?.sourceId === "sankoku8-eng"
        && retiredCheck?.ok === true && retiredCheck.outcomes.every((outcome) => outcome.id !== retiredId)
        && Number.isFinite(Date.parse(retiredCheck.settings?.lastCheckedAt))
        && retiredScoped?.ok === true && retiredScoped.outcomes.length === 0
        && JSON.stringify(retiredAfter.dictionaries) === JSON.stringify(retiredBefore.dictionaries)
        && JSON.stringify(idb.keys("/dicts").sort()) === JSON.stringify(retiredRowsBefore)
        && retiredLookup.ok === true && JSON.stringify(retiredLookup).includes(`${retiredTitle} term fixture`),
      JSON.stringify({ retiredImport, retiredSeed, retiredCheck, retiredScoped, retiredBefore, retiredAfter, retiredLookup }),
    );
    await request("hd_remove", { title: retiredTitle });
  });
});
