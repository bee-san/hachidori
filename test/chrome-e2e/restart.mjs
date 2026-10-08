/*
 * Backups, atomic replacement and a full browser restart on the same profile.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./updates.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe } from "node:test";
import { backupChromeScenarios } from "../chrome-backup-scenarios.mjs";
import {
  ATOMIC_REPLACEMENT_QUERY,
  ATOMIC_REPLACEMENT_TITLE,
  buildTitledZip,
  GENERIC_KANJI_TITLE,
} from "../make-fixture.mjs";
import { completedSetup, setupRequestsAfterSetup, startupTabs } from "./first-run.mjs";
import { check, diagnostics, HERE, PROFILE, step } from "./harness.mjs";
import { firstFixtureGeneration, fixtureId, replacedFixtureGeneration } from "./import.mjs";
import { hoverForPopup, popupReader } from "./popup-reader.mjs";
import {
  browser,
  editSettingsControls,
  generationExists,
  generationIsAbsent,
  GENERIC_KANJI_ID,
  launch,
  launchArgs,
  listOpfsPaths,
  ownedGenerationRoot,
  page,
  pageUrl,
  readLookupStatistics,
  setBrowser,
  setPage,
  settingsUrl,
  setupArchives,
  showSettingsSection,
  waitForGenerationAbsent,
  watch,
} from "./session.mjs";
import { startupTabsAfterWorkerRestart } from "./updates.mjs";

const ATOMIC_FIXTURES = Object.fromEntries([
  "v1",
  "v2",
  "v3",
  "same-v2",
  "lower-v1",
  "missing-version",
  "malformed-version",
  "nonnumeric-version",
  "corrupt",
].map(name => [name, resolve(HERE, `fixtures/atomic-replacement-${name}.zip`)]));

async function atomicReplacementBrowserScenarios(page) {
  await page.bringToFront();
  await showSettingsSection(page, "add-dictionaries");
  const input = () => page.$("#import-file");
  const waitFinished = async (count, lastName) => page.waitForFunction(({ total, expectedName }) => {
    const text = document.getElementById("import-state")?.textContent?.trim() ?? "";
    const names = [...document.querySelectorAll("#import-progress .setup-dictionary-name")]
      .map(element => element.textContent.trim());
    const statuses = [...document.querySelectorAll("#import-progress .setup-dictionary-status")]
      .map(element => element.textContent.trim());
    return text.startsWith(`Finished ${total} of ${total} `)
      && names.length === total
      && names.at(-1) === expectedName
      && statuses.length === total
      && statuses.every(status => /^(?:Imported|Failed|Cancelled)/u.test(status))
      ? text
      : false;
  }, { timeout: 180_000, polling: 100 }, {
    total: count,
    expectedName: lastName,
  }).then(handle => handle.jsonValue());
  const waitDecision = async () => page.waitForFunction(() => {
    const dialog = document.getElementById("import-decision-dialog");
    return dialog?.open ? {
      labelledby: dialog.getAttribute("aria-labelledby"),
      describedby: dialog.getAttribute("aria-describedby"),
      heading: document.getElementById("import-decision-heading")?.textContent?.trim(),
      description: document.getElementById("import-decision-description")?.textContent?.trim(),
      imported: document.getElementById("import-decision-imported")?.textContent?.trim(),
      installed: document.getElementById("import-decision-installed")?.textContent?.trim(),
      active: document.activeElement?.textContent?.trim() ?? "",
      buttons: [...dialog.querySelectorAll("button")].map(button => button.textContent.trim()),
      options: [...document.getElementById("import-decision-target").options].map(option => option.textContent),
      targetHidden: document.getElementById("import-decision-target-row").hidden,
    } : false;
  }, { timeout: 90_000, polling: 50 }).then(handle => handle.jsonValue());
  const dropArchives = archives => page.evaluate((items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      const bytes = Uint8Array.from(atob(item.base64), character => character.charCodeAt(0));
      transfer.items.add(new File([bytes], item.name, { type: "application/zip" }));
    }
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    document.getElementById("import-drop-zone").dispatchEvent(event);
  }, archives);
  const archive = (path, name = path.split("/").at(-1)) => ({
    name,
    base64: readFileSync(path).toString("base64"),
  });
  const remove = ({ id = null, title }) => page.evaluate((dictionary) => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen",
    type: "hd_remove",
    requestId: `i04-remove-${dictionary.id ?? dictionary.title}`,
    id: dictionary.id,
    title: dictionary.title,
  }), { id, title });
  const state = () => page.evaluate(async () =>
    (await chrome.storage.local.get("dictionaryState")).dictionaryState);

  await (await input()).uploadFile(ATOMIC_FIXTURES.v1);
  const installedSummary = await waitFinished(1, "atomic-replacement-v1.zip");
  const installedState = await state();
  const originalGroups = installedState.groups;
  const installed = installedState.dictionaries.find(dictionary =>
    dictionary.title === ATOMIC_REPLACEMENT_TITLE);
  if (!installed) {
    const installedOutcome = await page.$eval(
      "#import-progress .setup-dictionary-status",
      output => output.textContent.trim(),
    );
    throw new Error(`atomic v1 was not installed: ${installedSummary}; ${installedOutcome}; `
      + JSON.stringify(installedState));
  }
  const installedIndex = installedState.dictionaries.indexOf(installed);
  const presentedReply = await page.evaluate(async ({ id, index }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      requestId: "i04-present-target",
      baseRevision: dictionaryState.revision,
      dictionaries: dictionaryState.dictionaries.map((dictionary, at) => at === index ? {
        ...dictionary,
        displayName: "Atomic favourite",
        enabled: false,
        favorite: true,
        isUpdatable: true,
        sourceId: "i04-managed-source",
        indexUrl: "https://example.invalid/i04/index.json",
        downloadUrl: "https://example.invalid/i04/archive.zip",
        updateScheduleOverride: "monthly",
        futureUserSetting: { retained: true },
      } : dictionary),
      groups: [{ id: "i04-group", name: "I04", dictionaryIds: [id] }],
    });
  }, { id: installed.id, index: installedIndex });
  // The presented package is managed and has no lastUpdateCheck, so it is due at
  // once: the update alarm's failed check of example.invalid can commit the next
  // revision before this poll has seen the presented one.
  await page.waitForFunction((revision) =>
    chrome.storage.local.get("dictionaryState").then(({ dictionaryState }) =>
      dictionaryState?.revision >= revision), {}, presentedReply.state.revision);
  const presented = presentedReply.state.dictionaries[installedIndex];

  await page.evaluate(() => {
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    const originalCreate = URL.createObjectURL.bind(URL);
    window.__i04ImportProbe = {
      imports: 0,
      urls: 0,
      restore() {
        chrome.runtime.sendMessage = originalSend;
        URL.createObjectURL = originalCreate;
      },
    };
    chrome.runtime.sendMessage = (message) => {
      if (message?.type === "hd_import") window.__i04ImportProbe.imports += 1;
      return originalSend(message);
    };
    URL.createObjectURL = (value) => {
      window.__i04ImportProbe.urls += 1;
      return originalCreate(value);
    };
  });
  const followupA = "i04-after-escape";
  const followupB = "i04-after-cancel";
  await dropArchives([
    archive(ATOMIC_FIXTURES.v2, "atomic-v2-escape.zip"),
    { name: `${followupA}.zip`, base64: buildTitledZip(followupA).toString("base64") },
    archive(ATOMIC_FIXTURES.v2, "atomic-v2-cancel.zip"),
    { name: `${followupB}.zip`, base64: buildTitledZip(followupB).toString("base64") },
  ]);
  const escapeDecision = await waitDecision();
  await page.bringToFront();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll("#import-progress .setup-dictionary-status")];
    return rows[0]?.textContent.includes("Cancelled before import")
      && rows[1]?.textContent.includes("Imported")
      && document.getElementById("import-decision-dialog")?.open;
  }, { timeout: 120_000, polling: 100 });
  const cancelDecision = await waitDecision();
  await page.click('#import-decision-dialog button[value="cancel"]');
  const cancelSummary = await waitFinished(4, `${followupB}.zip`);
  const cancellationUi = await page.evaluate(() => ({
    probe: { imports: window.__i04ImportProbe.imports, urls: window.__i04ImportProbe.urls },
    outcomes: [...document.querySelectorAll("#import-progress .setup-dictionary-status")]
      .map(output => output.textContent.trim()),
  }));
  await page.evaluate(() => {
    window.__i04ImportProbe.restore();
    delete window.__i04ImportProbe;
  });
  const afterCancellation = await state();
  const unchangedAfterCancel = afterCancellation.dictionaries.find(dictionary => dictionary.id === installed.id);

  const sharedIndexUrl = "https://example.invalid/i04/shared-source.json";
  const sourceTargets = await page.evaluate(async ({ atomicId, followupTitle, indexUrl }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      requestId: "i04-source-targets",
      baseRevision: dictionaryState.revision,
      dictionaries: dictionaryState.dictionaries.map(dictionary =>
        dictionary.id === atomicId || dictionary.title === followupTitle
          ? { ...dictionary, isUpdatable: true, indexUrl }
          : dictionary),
      groups: dictionaryState.groups,
    });
    return reply.state;
  }, { atomicId: installed.id, followupTitle: followupA, indexUrl: sharedIndexUrl });
  await page.waitForFunction((revision) =>
    chrome.storage.local.get("dictionaryState").then(({ dictionaryState }) =>
      dictionaryState?.revision === revision), {}, sourceTargets.revision);
  await dropArchives([{
    name: "renamed-shared-source.zip",
    base64: buildTitledZip("renamed-shared-source", {
      revision: "9",
      indexUrl: sharedIndexUrl,
    }).toString("base64"),
  }]);
  const sourceDecision = await waitDecision();
  await page.click('#import-decision-dialog button[value="cancel"]');
  await waitFinished(1, "renamed-shared-source.zip");

  check(
    "matching local imports show an accessible named revision decision before engine mutation",
    installedSummary === "Finished 1 of 1 archive — 1 imported, 0 failed."
      && presentedReply.ok === true
      && escapeDecision.labelledby === "import-decision-heading"
      && escapeDecision.describedby === "import-decision-description"
      && escapeDecision.heading === "Dictionary already installed"
      && escapeDecision.description.includes("newer")
      && escapeDecision.imported.includes("revision 2")
      && escapeDecision.installed.includes("revision 1")
      && JSON.stringify(escapeDecision.buttons)
        === JSON.stringify(["Replace existing", "Add separately", "Cancel"])
      && sourceDecision.targetHidden === false
      && sourceDecision.options.length === 2
      && new Set(sourceDecision.options).size === 2
      && sourceDecision.options.every(option => /revision .+ · ID [0-9a-f]{8}$/u.test(option)),
    JSON.stringify({ installedSummary, escapeDecision, sourceDecision }),
  );
  check(
    "Escape and explicit Cancel leave the package untouched and continue a multi-file batch",
    cancelSummary === "Finished 4 of 4 archives — 2 imported, 2 cancelled, 0 failed."
      && cancelDecision.description.includes("newer")
      && cancellationUi.probe.imports === 2
      && cancellationUi.probe.urls === 2
      && cancellationUi.outcomes[0].includes("Cancelled before import")
      && cancellationUi.outcomes[1].includes(`Imported ${followupA}`)
      && cancellationUi.outcomes[2].includes("Cancelled before import")
      && cancellationUi.outcomes[3].includes(`Imported ${followupB}`)
      && unchangedAfterCancel.path === presented.path
      && unchangedAfterCancel.revision === "1",
    JSON.stringify({ cancelSummary, cancelDecision, cancellationUi, unchangedAfterCancel }),
  );

  for (const title of [followupA, followupB]) {
    const removed = await remove({ title });
    if (removed?.ok !== true) {
      throw new Error(`could not remove ${title}: ${JSON.stringify(removed)}`);
    }
  }
  const restoredSourceState = await page.evaluate(async ({ id, indexUrl, downloadUrl }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      requestId: "i04-restore-source",
      baseRevision: dictionaryState.revision,
      dictionaries: dictionaryState.dictionaries.map(dictionary => dictionary.id === id ? {
        ...dictionary,
        isUpdatable: true,
        sourceId: "i04-managed-source",
        indexUrl,
        downloadUrl,
      } : dictionary),
      groups: dictionaryState.groups,
    });
    return reply.state;
  }, {
    id: installed.id,
    indexUrl: "https://example.invalid/i04/index.json",
    downloadUrl: "https://example.invalid/i04/archive.zip",
  });
  await page.waitForFunction((revision) =>
    chrome.storage.local.get("dictionaryState").then(({ dictionaryState }) =>
      dictionaryState?.revision === revision), {}, restoredSourceState.revision);
  const beforeReplaceState = await state();
  const beforeReplace = beforeReplaceState.dictionaries.find(dictionary => dictionary.id === installed.id);
  await (await input()).uploadFile(ATOMIC_FIXTURES.v2);
  const replaceDecision = await waitDecision();
  if (process.env.HACHIDORI_I04_DECISION_SCREENSHOT) {
    mkdirSync(dirname(process.env.HACHIDORI_I04_DECISION_SCREENSHOT), { recursive: true });
    await (await page.$("#import-decision-dialog")).screenshot({
      path: process.env.HACHIDORI_I04_DECISION_SCREENSHOT,
    });
  }
  const shownAt = Date.now();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1600));
  await page.focus('#import-decision-dialog button[value="replace"]');
  const replaceFocused = await page.evaluate(() =>
    document.activeElement?.textContent?.trim() === "Replace existing");
  await page.keyboard.press("Enter");
  const replaceSummary = await waitFinished(1, "atomic-replacement-v2.zip");
  const replacementFinishedAt = Date.now();
  const replacementStatus = await page.$eval(
    "#import-progress .setup-dictionary-status",
    output => output.textContent.trim(),
  );
  const reportedSeconds = Number(/\bin ([0-9.]+) seconds:/u.exec(replacementStatus)?.[1]);
  const replacedState = await state();
  const replaced = replacedState.dictionaries.find(dictionary => dictionary.id === installed.id);
  check(
    "keyboard Replace preserves package identity and excludes dialog dwell from import timing",
    replaceFocused
      && replaceSummary === "Finished 1 of 1 archive — 1 imported, 0 failed."
      && replacementStatus.includes(`Imported ${ATOMIC_REPLACEMENT_TITLE}`)
      && Number.isFinite(reportedSeconds)
      && replacementFinishedAt - shownAt - reportedSeconds * 1000 >= 1200
      && replaced.id === beforeReplace.id
      && replaced.path !== beforeReplace.path
      && replaced.revision === "2"
      && replaced.displayName === "Atomic favourite"
      && replaced.enabled === false
      && replaced.favorite === true
      && replaced.sourceId === "i04-managed-source"
      && replaced.indexUrl === "https://example.invalid/i04/index.json"
      && replaced.downloadUrl === "https://example.invalid/i04/archive.zip"
      && replaced.updateScheduleOverride === "monthly"
      && replaced.futureUserSetting?.retained === true
      && replacedState.dictionaries.indexOf(replaced) === installedIndex
      && replacedState.groups.some(group =>
        group.id === "i04-group" && group.dictionaryIds.includes(installed.id)),
    JSON.stringify({ replaceDecision, replaceSummary, replacementStatus, reportedSeconds,
      elapsed: replacementFinishedAt - shownAt, beforeReplace, replaced, replacedState }),
  );

  // The replacement resets the managed package's lastUpdateCheck, which makes
  // it due at once: the update alarm checks example.invalid and records a
  // failed check with a new state revision. Let that land before snapshotting
  // the state the failure paths must leave untouched.
  await page.waitForFunction((id) =>
    chrome.storage.local.get("dictionaryState").then(({ dictionaryState }) =>
      dictionaryState?.dictionaries?.find(dictionary => dictionary.id === id)?.lastUpdateCheck != null),
  { timeout: 60_000, polling: 100 }, installed.id).catch(() => null);
  const failureStateBefore = await state();
  const failureOpfsBefore = await listOpfsPaths(page);
  const metadataMismatch = await page.evaluate(async ({ base64, target, title }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    try {
      return await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_import",
        requestId: "i04-metadata-mismatch",
        blobUrl,
        fileName: "atomic-metadata-mismatch.zip",
        importDecision: {
          action: "replace",
          identity: {
            title,
            revision: "999",
            indexUrl: null,
            downloadUrl: null,
          },
          matchKind: "title",
          target,
        },
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, {
    base64: archive(ATOMIC_FIXTURES.v3).base64,
    target: {
      id: replaced.id,
      title: replaced.title,
      path: replaced.path,
      revision: replaced.revision,
      sourceId: replaced.sourceId ?? null,
      indexUrl: replaced.indexUrl ?? null,
      downloadUrl: replaced.downloadUrl ?? null,
      isUpdatable: replaced.isUpdatable === true,
    },
    title: ATOMIC_REPLACEMENT_TITLE,
  });
  const stateAfterMismatch = await state();
  const opfsAfterMismatch = await listOpfsPaths(page);
  await (await input()).uploadFile(ATOMIC_FIXTURES.corrupt);
  const corruptDecision = await waitDecision();
  await page.click('#import-decision-dialog button[value="replace"]');
  const corruptSummary = await waitFinished(1, "atomic-replacement-corrupt.zip");
  const corruptStatus = await page.$eval(
    "#import-progress .setup-dictionary-status",
    output => output.textContent.trim(),
  );
  const stateAfterCorrupt = await state();
  const opfsAfterCorrupt = await listOpfsPaths(page);
  check(
    "metadata mismatch and corrupt replacement leave no OPFS generation roots",
    metadataMismatch.ok === false
      && metadataMismatch.error?.includes("did not match the reviewed archive")
      && JSON.stringify(stateAfterMismatch) === JSON.stringify(failureStateBefore)
      && JSON.stringify(opfsAfterMismatch) === JSON.stringify(failureOpfsBefore)
      && corruptDecision.description.includes("newer")
      && corruptSummary === "Finished 1 of 1 archive — 0 imported, 1 failed."
      && corruptStatus.startsWith("Failed after ")
      && JSON.stringify(stateAfterCorrupt) === JSON.stringify(failureStateBefore)
      && JSON.stringify(opfsAfterCorrupt) === JSON.stringify(failureOpfsBefore),
    JSON.stringify({
      metadataMismatch,
      stateAfterMismatch,
      opfsAfterMismatch,
      corruptDecision,
      corruptSummary,
      corruptStatus,
      stateAfterCorrupt,
      opfsAfterCorrupt,
      failureStateBefore,
      failureOpfsBefore,
    }),
  );

  await (await input()).uploadFile(
    ATOMIC_FIXTURES["same-v2"],
    ATOMIC_FIXTURES["lower-v1"],
    ATOMIC_FIXTURES["missing-version"],
    ATOMIC_FIXTURES["malformed-version"],
    ATOMIC_FIXTURES["nonnumeric-version"],
  );
  const matrix = [];
  for (const expected of [
    "are the same",
    "older than",
    "cannot compare",
    "cannot compare",
    "cannot compare",
  ]) {
    const decision = await waitDecision();
    matrix.push(decision);
    await page.click('#import-decision-dialog button[value="cancel"]');
    if (matrix.length < 5) {
      await page.waitForFunction((description) => {
        const dialog = document.getElementById("import-decision-dialog");
        return dialog?.open
          && document.getElementById("import-decision-description")?.textContent.includes(description);
      }, { timeout: 90_000, polling: 50 }, [
        "older than", "cannot compare", "cannot compare", "cannot compare",
      ][matrix.length - 1]);
    }
    if (!decision.description.includes(expected)) break;
  }
  const matrixSummary = await waitFinished(5, "atomic-replacement-nonnumeric-version.zip");
  const afterMatrix = await state();
  check(
    "same, lower, missing, malformed, and nonnumeric revisions are described without automatic replacement",
    matrix.length === 5
      && matrix[0].description.includes("are the same")
      && matrix[1].description.includes("older than")
      && matrix.slice(2).every(decision => decision.description.includes("cannot compare"))
      && matrixSummary === "Finished 5 of 5 archives — 0 imported, 5 cancelled, 0 failed."
      && afterMatrix.dictionaries.find(dictionary => dictionary.id === installed.id)?.path === replaced.path,
    JSON.stringify({ matrix, matrixSummary, afterMatrix }),
  );

  await (await input()).uploadFile(ATOMIC_FIXTURES.v3);
  const separateDecision = await waitDecision();
  await page.bringToFront();
  await page.focus('#import-decision-dialog button[value="separate"]');
  const separateFocused = await page.evaluate(() =>
    document.activeElement?.textContent?.trim() === "Add separately");
  await page.keyboard.press("Enter");
  const separateSummary = await waitFinished(1, "atomic-replacement-v3.zip");
  const separateTitle = `${ATOMIC_REPLACEMENT_TITLE} (2)`;
  const separateState = await state();
  const separate = separateState.dictionaries.find(dictionary => dictionary.title === separateTitle);
  await (await input()).uploadFile(ATOMIC_FIXTURES.v3);
  const separateThreeDecision = await waitDecision();
  await page.bringToFront();
  await page.focus('#import-decision-dialog button[value="separate"]');
  await page.keyboard.press("Enter");
  const separateThreeSummary = await waitFinished(1, "atomic-replacement-v3.zip");
  const separateThreeTitle = `${ATOMIC_REPLACEMENT_TITLE} (3)`;
  const separateThreeState = await state();
  const separateThree = separateThreeState.dictionaries.find(
    dictionary => dictionary.title === separateThreeTitle,
  );
  const lookup = await page.evaluate((query) => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen",
    type: "hd_lookup",
    requestId: "i04-separate-lookup",
    text: query,
    maxResults: 32,
    scanLength: 16,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
  }), ATOMIC_REPLACEMENT_QUERY);
  const nativeLabels = lookup.results?.flatMap(result =>
    result.term?.glossaries?.map(glossary => glossary.dictionary) ?? []) ?? [];
  const localSourceReply = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const dictionaries = dictionaryState.dictionaries.map(dictionary => {
        const local = {
          ...dictionary,
          isUpdatable: false,
          indexUrl: null,
          downloadUrl: null,
          lastUpdateCheck: null,
        };
        delete local.sourceId;
        return local;
      });
      const reply = await chrome.runtime.sendMessage({
        target: "hoshidicts-worker",
        type: "hd_state_cas",
        requestId: `i04-local-screenshot-source-${attempt}`,
        baseRevision: dictionaryState.revision,
        dictionaries,
        groups: dictionaryState.groups,
      });
      if (reply?.ok === true || reply?.conflict !== true) return reply;
    }
    return { ok: false, error: "could not settle local screenshot sources after five conflicts" };
  });
  if (localSourceReply?.ok !== true) {
    throw new Error(`could not clear the temporary I04 managed source: ${JSON.stringify(localSourceReply)}`);
  }
  await page.waitForFunction((revision) =>
    chrome.storage.local.get("dictionaryState").then(({ dictionaryState }) =>
      dictionaryState?.revision >= revision), {}, localSourceReply.state.revision);
  if (process.env.HACHIDORI_I04_RESULT_SCREENSHOT) {
    // Render the evidence from a fresh Settings document. Earlier update tests
    // deliberately exercise deferred row refreshes; a new document reads the
    // authoritative state directly and cannot retain their transient status.
    const evidencePage = await page.browser().newPage();
    try {
      await evidencePage.setViewport({ width: 1280, height: 1000 });
      const evidenceUrl = new URL("settings.html#dictionaries", page.url()).href;
      await evidencePage.goto(evidenceUrl, { waitUntil: "domcontentloaded" });
      await showSettingsSection(evidencePage, "dictionaries");
      await evidencePage.waitForFunction((titles) => {
        const shown = [...document.querySelectorAll("#dict-list .dict-title")]
          .map(element => element.textContent.trim());
        return titles.every(title => shown.includes(title))
          && !document.getElementById("dict-list")?.textContent.includes("Check failed");
      }, { timeout: 90_000, polling: 100 }, [
        "Atomic favourite",
        separateTitle,
        separateThreeTitle,
      ]);
      mkdirSync(dirname(process.env.HACHIDORI_I04_RESULT_SCREENSHOT), { recursive: true });
      await (await evidencePage.$("#dictionaries")).screenshot({
        path: process.env.HACHIDORI_I04_RESULT_SCREENSHOT,
      });
    } finally {
      await evidencePage.close();
    }
  }
  check(
    "Add separately persists a collision-safe title that native lookup reports",
    separateFocused
      && separateDecision.description.includes("newer")
      && separateSummary === "Finished 1 of 1 archive — 1 imported, 0 failed."
      && separate?.id !== replaced.id
      && separate?.path.endsWith(`/${separateTitle}`)
      && separate?.revision === "3"
      && separateThreeDecision.description.includes("newer")
      && separateThreeSummary === "Finished 1 of 1 archive — 1 imported, 0 failed."
      && separateThree?.id !== replaced.id
      && separateThree?.id !== separate.id
      && separateThree?.path.endsWith(`/${separateThreeTitle}`)
      && separateThree?.revision === "3"
      && nativeLabels.includes(separateTitle)
      && nativeLabels.includes(separateThreeTitle)
      && !nativeLabels.includes(ATOMIC_REPLACEMENT_TITLE),
    JSON.stringify({
      separateDecision,
      separateSummary,
      separate,
      separateThreeDecision,
      separateThreeSummary,
      separateThree,
      nativeLabels,
      lookup,
    }),
  );

  const restoredGroups = await page.evaluate(async (groups) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_cas",
      requestId: "i04-restore-groups",
      baseRevision: dictionaryState.revision,
      dictionaries: dictionaryState.dictionaries,
      groups,
    });
  }, originalGroups);
  if (restoredGroups.ok !== true) {
    throw new Error(`could not restore pre-I04 groups: ${JSON.stringify(restoredGroups)}`);
  }
  await showSettingsSection(page, "add-dictionaries");
  return {
    packages: [installed.id, separate.id, separateThree.id].map(id => {
      const dictionary = localSourceReply.state.dictionaries.find(candidate => candidate.id === id);
      return {
        id: dictionary.id,
        title: dictionary.title,
        path: dictionary.path,
        generationRoot: ownedGenerationRoot(dictionary.path, dictionary.title),
      };
    }),
  };
}

// Values that more than one step uses; the step that creates each one assigns it.
let restoredFixture, restoredFixtureGeneration, lookupStatsBeforeRestart, optionsBeforeRestart,
  atomicBeforeRestart, restoredOptions, tab2, popup2;

describe("browser restart", () => {
  step("backups in Chrome", async () => {
    await editSettingsControls(page, { "opt-frequency-dictionary": "hachidori-fixture", "opt-frequency-order": "ascending",
      "opt-popup-columns": "2" });
    const backupRestored = await backupChromeScenarios({ browser, page, directory: resolve(PROFILE, "backup-downloads"), check });
    restoredFixture = backupRestored.state.dictionaries.find(dictionary => dictionary.id === fixtureId);
    restoredFixtureGeneration = ownedGenerationRoot(restoredFixture.path, "hachidori-fixture");
    lookupStatsBeforeRestart = await readLookupStatistics(page);
    optionsBeforeRestart = await page.evaluate(async () =>
      (await chrome.storage.local.get("options")).options);
  });

  step("atomic replacement in Chrome", async () => {
    atomicBeforeRestart = await atomicReplacementBrowserScenarios(page);
  });

  step("settings and lookup counts survive a browser restart", async () => {
    const chromeProcess = browser.process();
    const chromeKilled = new Promise((resolveKilled) => chromeProcess.once("close", resolveKilled));
    chromeProcess.kill("SIGKILL");
    await chromeKilled;

    // ---------------------------------------------------------------- pass 2
    // Same profile after an abrupt browser exit: the dictionary must come back out of OPFS
    // without another import. This is the assertion that node cannot make at all.
    setBrowser(await launch.launch(launchArgs));
    watch(browser);
    try {
      await browser.waitForTarget(
        t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
        { timeout: 30_000 });
    } catch { /* asserted below via the settings page */ }

    setPage(await browser.newPage());
    page.on("console", m => diagnostics.push(`[settings2] ${m.type()}: ${m.text()}`));
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await showSettingsSection(page, "lookup");

    restoredOptions = await page.waitForFunction(async (expected) => {
      const { options } = await chrome.storage.local.get("options");
      return JSON.stringify(options) === JSON.stringify(expected)
        && document.getElementById("opt-max-results").value === String(expected.maxResults)
        && document.getElementById("opt-hover-enabled").checked === expected.hoverEnabled
        && document.getElementById("opt-activation-key").value
          === (expected.lookupMode === "hover" ? "" : expected.activationKey)
        && document.getElementById("opt-lookup-sticky-row").hidden === (expected.lookupMode === "hover")
        && document.getElementById("opt-definition-lookup-mode").value === (expected.definitionLookupMode ?? "inherit")
        && document.getElementById("opt-hide-delay").value === String(expected.popupHideDelayMs)
        && document.getElementById("opt-hide-on-cursor-exit").checked === expected.hidePopupOnCursorExit
        && document.getElementById("opt-hide-on-cursor-exit-delay").value === String(expected.hidePopupOnCursorExitDelayMs)
        && document.getElementById("opt-popup-columns").value === String(expected.popupColumns)
        && document.getElementById("opt-frequency-dictionary").value === expected.frequencyDictionary
        && document.getElementById("opt-frequency-order").value === expected.frequencyOrder
        ? options : false;
    }, { timeout: 30_000, polling: 100 }, optionsBeforeRestart).then((handle) => handle.jsonValue()).catch(() => null);
    check("reader settings and their revision survive a full browser restart",
      restoredOptions?.revision === optionsBeforeRestart.revision && restoredOptions !== null,
      JSON.stringify({ optionsBeforeRestart, restoredOptions }));
    const lookupStatsAfterRestart = await readLookupStatistics(page);
    check(
      "lookup counts survive a full browser restart",
      lookupStatsBeforeRestart.ok === true
        && lookupStatsAfterRestart.ok === true
        && lookupStatsAfterRestart.descriptor?.generation === lookupStatsBeforeRestart.descriptor?.generation
        && lookupStatsAfterRestart.descriptor?.revision === lookupStatsBeforeRestart.descriptor?.revision
        && JSON.stringify(lookupStatsAfterRestart.statistics) === JSON.stringify(lookupStatsBeforeRestart.statistics),
      JSON.stringify({ lookupStatsBeforeRestart, lookupStatsAfterRestart }),
    );
  });

  step("setup stays closed after a restart", async () => {
    // The relaunch fired onStartup, and pass 1 restarted the worker version: neither
    // may reopen the completed startup page or touch the edited preference.
    const setupAfterRestart = await page.evaluate(async () => {
      const { setupState } = await chrome.storage.local.get("setupState");
      return { setupState, resumeHidden: document.getElementById("setup-resume")?.hidden };
    });
    check(
      "a browser restart keeps completed setup closed and the edited first-install preference",
      startupTabsAfterWorkerRestart === 0 && startupTabs() === 0
        && JSON.stringify(setupAfterRestart.setupState) === JSON.stringify(completedSetup)
        && setupAfterRestart.resumeHidden === true
        && restoredOptions?.showCompactDefinitionSummary === false
        && restoredOptions.showCompactDefinitionSummary === optionsBeforeRestart.showCompactDefinitionSummary
        && setupArchives.requests.length === setupRequestsAfterSetup,
      JSON.stringify({ startupTabsAfterWorkerRestart, startupTabs: startupTabs(), setupAfterRestart, completedSetup,
        setupRequests: setupArchives.requests.length, setupRequestsAfterSetup }),
    );
  });

  step("separate copies survive a restart", async () => {
    const atomicReloadCount = await page.evaluate(async () => {
      const deadline = Date.now() + 90_000;
      let reply;
      for (;;) {
        reply = await chrome.runtime.sendMessage({
          target: "hoshidicts-offscreen",
          type: "hd_status",
          requestId: "i04-restart-status",
        });
        if (reply && reply.ok && reply.ready && !reply.loading) return reply;
        if (Date.now() >= deadline) return reply;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      }
    }).catch(error => ({ error: String(error) }));
    // The reload after the restart refreshes each package from its index.json,
    // which gives the generic kanji fixture back the update source the I04
    // scenario cleared, with no lastUpdateCheck. That makes it due at once: the
    // update alarm checks example.test and records a failed check with a new
    // state revision. Let that land before the removals below, or it can fall
    // between one removal's read and its commit and make that removal conflict.
    await page.waitForFunction((id) =>
      chrome.storage.local.get("dictionaryState").then(({ dictionaryState }) =>
        dictionaryState?.dictionaries?.find(dictionary => dictionary.id === id)?.lastUpdateCheck != null),
    { timeout: 60_000, polling: 100 }, GENERIC_KANJI_ID).catch(() => null);
    const atomicRestartState = await page.evaluate(async () =>
      (await chrome.storage.local.get("dictionaryState")).dictionaryState);
    const atomicRestartLookup = await page.evaluate((query) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_lookup",
      requestId: "i04-restart-lookup",
      text: query,
      maxResults: 32,
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    }), ATOMIC_REPLACEMENT_QUERY);
    const atomicRestartLabels = atomicRestartLookup.results?.flatMap(result =>
      result.term?.glossaries?.map(glossary => glossary.dictionary) ?? []) ?? [];
    const atomicRestartPaths = await listOpfsPaths(page);
    const atomicRestartPackages = atomicBeforeRestart.packages.map(expected =>
      atomicRestartState.dictionaries.find(dictionary => dictionary.id === expected.id));
    const atomicRemoveReplies = [];
    for (const dictionary of atomicBeforeRestart.packages.toReversed()) {
      atomicRemoveReplies.push(await page.evaluate((entry) => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_remove",
        requestId: `i04-restart-remove-${entry.id}`,
        id: entry.id,
        title: entry.title,
      }), dictionary));
    }
    const atomicRemoved = await page.waitForFunction(async (ids) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_status",
        requestId: "i04-restart-clean-status",
      });
      return ids.every(id => !dictionaryState.dictionaries.some(dictionary => dictionary.id === id))
        && status?.ok === true
        && status.dictionaryCount === 4;
    }, { timeout: 90_000, polling: 250 }, atomicBeforeRestart.packages.map(dictionary => dictionary.id))
      .then(() => true)
      .catch(() => false);
    const atomicPathsAfterRemoval = await listOpfsPaths(page);
    const automaticAtomicRetention = await page.evaluate(async roots => {
      const { automaticBackups } = await chrome.storage.local.get("automaticBackups");
      const referenced = new Set((automaticBackups?.backups ?? []).flatMap(backup =>
        backup.snapshot?.state?.dictionaries?.map(dictionary => dictionary.path.split("/").slice(0, 3).join("/")) ?? []));
      return {
        schemaVersion: automaticBackups?.schemaVersion,
        backupCount: automaticBackups?.backups?.length ?? 0,
        retainedRoots: roots.filter(root => referenced.has(root)),
      };
    }, atomicBeforeRestart.packages.map(dictionary => dictionary.generationRoot));
    await page.evaluate(() => chrome.storage.local.set({
      automaticBackups: { schemaVersion: 1, backups: [] },
    }));
    const automaticRetentionCleanup = await page.evaluate(async () => {
      const deadline = Date.now() + 30_000;
      let reply;
      for (;;) {
        reply = await chrome.runtime.sendMessage({
          target: "hoshidicts-offscreen",
          type: "hd_backup_auto_cleanup",
          requestId: `i04-restart-auto-cleanup-${crypto.randomUUID()}`,
        });
        if (reply?.ok || Date.now() >= deadline) return reply;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
      }
    });
    const atomicRetiredAfterRelease = (await Promise.all(atomicBeforeRestart.packages.map(dictionary =>
      waitForGenerationAbsent(page, dictionary.generationRoot)))).every(Boolean);
    const atomicPathsAfterRetentionRelease = await listOpfsPaths(page);
    check(
      "separate copies survive a browser restart, stay retained by automatic backups, and retire after release",
      atomicReloadCount?.dictionaryCount === 6
        && atomicRestartPackages.every((dictionary, index) =>
          dictionary?.title === atomicBeforeRestart.packages[index].title
            && dictionary.path === atomicBeforeRestart.packages[index].path)
        && atomicBeforeRestart.packages.every(dictionary =>
          generationExists(atomicRestartPaths, dictionary.path))
        && atomicRestartLabels.includes(`${ATOMIC_REPLACEMENT_TITLE} (2)`)
        && atomicRestartLabels.includes(`${ATOMIC_REPLACEMENT_TITLE} (3)`)
        && atomicRemoveReplies.every(reply => reply?.ok === true)
        && atomicRemoved
        && atomicBeforeRestart.packages.every(dictionary =>
          generationExists(atomicPathsAfterRemoval, dictionary.path))
        && automaticAtomicRetention.schemaVersion === 1
        && automaticAtomicRetention.backupCount > 0
        && automaticAtomicRetention.retainedRoots.length === atomicBeforeRestart.packages.length
        && automaticRetentionCleanup?.ok === true
        && atomicRetiredAfterRelease
        && atomicBeforeRestart.packages.every(dictionary =>
          generationIsAbsent(atomicPathsAfterRetentionRelease, dictionary.generationRoot)),
      JSON.stringify({
        atomicBeforeRestart,
        atomicReloadCount,
        atomicRestartPackages,
        atomicRestartLabels,
        atomicRestartPaths,
        atomicRemoveReplies,
        atomicRemoved,
        atomicPathsAfterRemoval,
        automaticAtomicRetention,
        automaticRetentionCleanup,
        atomicRetiredAfterRelease,
        atomicPathsAfterRetentionRelease,
      }),
    );
  });

  step("the library after a restart", async () => {
    await showSettingsSection(page, "dictionaries");
    const persistedPackage = await page.waitForFunction(async (id, expectedPath) => {
      const t = (document.getElementById("dict-list")?.textContent || "");
      const { dictionaryState: state } = await chrome.storage.local.get("dictionaryState");
      const dictionary = state?.dictionaries?.find(candidate =>
        candidate.id === id && candidate.title === "hachidori-fixture");
      return t.includes("hachidori-fixture") && dictionary?.path === expectedPath
        ? dictionary
        : false;
    }, { timeout: 90_000, polling: 500 }, fixtureId, restoredFixture.path)
      .then(handle => handle.jsonValue())
      .catch(() => null);
    check("the settings page lists the dictionary again after a restart",
      persistedPackage?.path === restoredFixture.path
        && ownedGenerationRoot(persistedPackage.path, "hachidori-fixture") === restoredFixtureGeneration,
      `expected path: ${JSON.stringify(restoredFixture.path)}; persisted package: ${JSON.stringify(persistedPackage)}`);
    await showSettingsSection(page, "add-dictionaries");
    const restartedSettingsUi = await page.evaluate(() => ({
      localInputVisible: document.getElementById("import-file")?.checkVisibility() === true,
      starterHidden: document.getElementById("recommended-starter")?.hidden,
    }));
    check(
      "local-only libraries can install recommended dictionaries after a browser restart",
      restartedSettingsUi.starterHidden === false && restartedSettingsUi.localInputVisible === true,
      JSON.stringify(restartedSettingsUi),
    );
  });

  step("the dictionary survives in OPFS", async () => {
    // #dict-list above reflects worker-owned chrome.storage.local state, which
    // persists regardless of OPFS; only a dictionaryCount from the fresh engine
    // proves that the imported files came back.
    const reloadCount = await page.evaluate(async () => {
      const deadline = Date.now() + 90_000;
      let reply;
      for (;;) {
        reply = await chrome.runtime.sendMessage({
          target: "hoshidicts-offscreen", type: "hd_status", requestId: "e2e-1",
        });
        if (reply && reply.ok && reply.ready && !reply.loading) return reply;
        if (Date.now() >= deadline) return reply;
        await new Promise(r => setTimeout(r, 500));
      }
    }).catch(e => ({ error: String(e) }));
    const opfsAfterRestart = await listOpfsPaths(page);
    // The disabled generic package stays disabled across restart; the combined
    // fixture still restores all four of its native capabilities.
    check("the dictionary survives a browser restart via OPFS",
      reloadCount?.dictionaryCount === 4
        && generationExists(opfsAfterRestart, restoredFixture.path)
        && generationIsAbsent(opfsAfterRestart, firstFixtureGeneration)
        && generationIsAbsent(opfsAfterRestart, replacedFixtureGeneration),
      `hd_status reply: ${JSON.stringify(reloadCount)}; latest path: ${JSON.stringify(restoredFixture.path)};`
        + ` OPFS paths: ${JSON.stringify(opfsAfterRestart)}`);
  });

  step("lookups after a restart", async () => {
    tab2 = await browser.newPage();
    tab2.on("pageerror", e => diagnostics.push(`[page2] pageerror: ${e.message}`));
    await tab2.setViewport({ width: 1280, height: 900 });
    await tab2.goto(pageUrl, { waitUntil: "load" });
    popup2 = await popupReader(tab2);
    const afterRestart = (await hoverForPopup(tab2, popup2, "#verb"))?.plain ?? null;
    check("lookups work after a restart with no re-import",
      !!afterRestart && afterRestart.includes("食べる"),
      `popup text: ${afterRestart ? afterRestart.slice(0, 300) : "(no popup)"}`);
  });

  step("removing the dictionary", async () => {
    await page.evaluate((title) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_remove",
      requestId: "e2e-remove-generic-kanji",
      title,
    }), GENERIC_KANJI_TITLE);
    const removeReply = await page.evaluate(() => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_remove",
      requestId: "e2e-remove",
      title: "hachidori-fixture",
    })).catch(error => ({ error: String(error) }));
    const removed = await page.waitForFunction(async () => {
      const stored = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_status", requestId: "e2e-remove-status",
      });
      return (stored.dictionaryState?.dictionaries ?? []).length === 0
        && status?.ok
        && status.dictionaryCount === 0;
    }, { timeout: 90_000, polling: 250 }).then(() => true).catch(() => false);
    check("removing the dictionary clears its settings rows", removeReply?.ok === true && removed,
      `remove reply: ${JSON.stringify(removeReply)}`);

    const opfsAfterRemoval = await listOpfsPaths(page);
    const opfsRemoved = generationIsAbsent(opfsAfterRemoval, replacedFixtureGeneration);
    check("removing the dictionary deletes its OPFS directory", opfsRemoved,
      `${replacedFixtureGeneration} still exists in OPFS: ${JSON.stringify(opfsAfterRemoval)}`);

    const removedLookup = await page.evaluate(() => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen",
      type: "hd_lookup",
      requestId: "e2e-removed",
      text: "食べる",
    })).catch(error => ({ error: String(error) }));
    check("lookups miss after the dictionary is removed",
      removedLookup?.ok === true && removedLookup?.dictionaryCount === 0
        && Array.isArray(removedLookup?.results) && removedLookup.results.length === 0,
      `lookup reply: ${JSON.stringify(removedLookup)}`);
  });
});

export { popup2, tab2 };
