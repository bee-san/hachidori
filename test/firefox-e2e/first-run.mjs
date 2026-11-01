/*
 * First-run setup from the startup page: the recommended installer in
 * Firefox's background page, Retry, the Anki step, practice and Finish, then
 * Remove all imported dictionaries.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./install.mjs";
import { describe } from "node:test";
import { buildRecommendedZip } from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import {
  anki, ANKI_REFUSED_PATH, dictionaryState, evaluateJson, findPage, listIdbfsPaths, page, readPopup, readStorage, RECOMMENDED,
  reloadPage, routes, serverUrl, showSettingsSection, sleep, waitFor, writeOptions,
} from "./session.mjs";

function readStartup(startup) {
  return startup.evaluate(() => ({
    heading: document.getElementById("setup-heading")?.textContent ?? "",
    rows: [...document.querySelectorAll(".setup-dictionary")].map(row => [row.dataset.sourceId,
      row.querySelector(".setup-dictionary-status")?.textContent ?? ""]),
    actions: [...document.querySelectorAll("#setup-actions button")].map(button => button.id),
    stage: document.querySelector('.setup-step[aria-current="step"]')?.dataset.stage ?? null,
    outcome: document.querySelector(".setup-anki-outcome")?.dataset.status ?? null,
    outcomeText: document.querySelector(".setup-anki-outcome")?.textContent ?? "",
    instruction: document.getElementById("setup-practice-instruction")?.textContent ?? "",
    selection: getSelection().toString(),
  }));
}

async function clickControl(target, id) {
  await target.evaluate(control => document.getElementById(control).click(), id);
}

describe("first run", () => {
  let startup = null;

  step("Start setup installs the recommended dictionaries", async () => {
    startup = await findPage("startup.html");
    // Each publisher URL answers with a small fixture archive; JMnedict's fails once.
    for (const entry of RECOMMENDED) {
      const body = buildRecommendedZip(entry);
      routes.set(entry.downloadUrl, entry.sourceId === "jmnedict"
        ? { respond: () => (routes.get(entry.downloadUrl).requests > 1
          ? { body, contentType: "application/zip" } : { status: 503, body: "unavailable", contentType: "text/plain" }) }
        : { body, contentType: "application/zip" });
    }
    // AnkiConnect's address drops the connection, as when Anki is closed, so a
    // real Anki on this machine cannot decide the Anki step.
    const defaults = await evaluateJson(page, () => JSON.stringify(HDReaderOptions.normaliseOptions({}).anki));
    await writeOptions(page, { anki: { ...defaults, url: `${serverUrl}${ANKI_REFUSED_PATH}` } });
    await clickControl(startup, "setup-start");
    const failed = await waitFor(async () => {
      const state = await readStartup(startup);
      return state.heading === "Some dictionaries could not be installed" ? state : false;
    }, { timeout: 120_000, interval: 200 });
    const stored = await readStorage(page, ["setupState", "dictionaryState"]);
    const outcomes = stored.setupState?.dictionaries?.outcomes ?? {};
    const rows = (failed?.rows ?? []).map(([id, text]) => [id, text.replace(/\d+(\.\d+)? seconds/u, "N seconds")]);
    check("Start setup downloads and installs the five recommended dictionaries in the background page",
      JSON.stringify(rows) === JSON.stringify([
        ["jitendex", "Installed in N seconds"],
        ["jmnedict", "Failed: JMnedict.zip: reading the archive failed. could not read JMnedict.zip: HTTP 503"],
        ["bees-ultimate-kanji-dictionary", "Installed in N seconds"],
        ["jiten", "Installed in N seconds"],
        ["bees-ultimate-grammar-dictionary", "Installed in N seconds"],
      ])
        && RECOMMENDED.every(({ downloadUrl }) => routes.get(downloadUrl).requests === 1)
        && outcomes.jmnedict?.status === "failed"
        && (stored.dictionaryState?.dictionaries ?? []).length === RECOMMENDED.length - 1,
      JSON.stringify({ failed, outcomes, dictionaries: stored.dictionaryState?.dictionaries?.map(entry => entry.title) }));

    await clickControl(startup, "setup-retry");
    const installed = await waitFor(async () => {
      const state = await readStartup(startup);
      return state.stage === "anki" || state.stage === "practice" || state.heading.startsWith("All dictionaries installed")
        ? state : false;
    }, { timeout: 120_000, interval: 100 });
    const afterRetry = await readStorage(page, ["setupState", "dictionaryState"]);
    check("a download that fails is retried by Retry missing dictionaries",
      installed !== null && routes.get(RECOMMENDED.find(({ sourceId }) => sourceId === "jmnedict").downloadUrl).requests === 2
        && RECOMMENDED.filter(({ sourceId }) => sourceId !== "jmnedict").every(({ downloadUrl }) => routes.get(downloadUrl).requests === 1)
        && afterRetry.setupState?.dictionaries?.outcomes?.jmnedict?.status === "installed"
        && (afterRetry.dictionaryState?.dictionaries ?? []).length === RECOMMENDED.length,
      JSON.stringify({ installed, afterRetry }));
  });

  step("the Anki step and practice", async () => {
    const practice = await waitFor(async () => {
      const state = await readStartup(startup);
      return state.stage === "practice" && state.instruction.startsWith("Try looking up a word below.") ? state : false;
    }, { timeout: 60_000, interval: 100 });
    const setup = (await readStorage(page, ["setupState"])).setupState;
    check("the Anki step reports Anki as not connected and setup reaches practice",
      practice !== null && setup?.anki?.status === "unavailable" && setup.stage === "practice" && anki.refused > 0,
      JSON.stringify({ practice, anki: setup?.anki, ankiRequests: anki.refused }));
    // The practice page selects 辞書 and looks it up once it is answerable.
    const shown = await waitFor(() => readPopup(startup), { timeout: 30_000 });
    const jitendex = RECOMMENDED.find(({ sourceId }) => sourceId === "jitendex");
    check("the practice step looks up its word with the installed dictionaries",
      shown?.plain.includes("辞書") && shown.plain.includes(`${jitendex.title} term fixture`),
      JSON.stringify(shown));
  });

  step("Finish completes setup", async () => {
    await startup.keyboard.press("Escape");
    await clickControl(startup, "setup-finish");
    const completed = await waitFor(async () => {
      const { setupState } = await readStorage(page, ["setupState"]);
      return setupState?.stage === "complete" ? setupState : false;
    }, { timeout: 20_000 });
    await reloadPage(page);
    const resumeHidden = await waitFor(() => page.evaluate(() => document.getElementById("setup-resume").hidden || false));
    check("Finish completes setup and Settings no longer offers Resume setup",
      completed?.completedAt !== null && completed?.stage === "complete" && resumeHidden === true,
      JSON.stringify({ completed, resumeHidden }));
  });

  step("Remove all imported dictionaries", async () => {
    await showSettingsSection(page, "dictionaries");
    const before = await listIdbfsPaths(page);
    // The page asks once with window.confirm; this answers it.
    await page.evaluate(() => { window.confirm = () => true; });
    await waitFor(() => page.evaluate(() => !document.getElementById("library-remove-all").disabled
      && !document.getElementById("library-reset").hidden));
    await page.evaluate(() => document.getElementById("library-remove-all").click());
    const emptied = await waitFor(async () => {
      const state = await dictionaryState(page);
      return state && state.dictionaries.length === 0 ? state : false;
    }, { timeout: 60_000 });
    const after = await waitFor(async () => {
      const paths = await listIdbfsPaths(page);
      return paths.some(path => path.includes(".hdw-generation-")) ? false : paths;
    }, { timeout: 30_000 });
    await sleep(200);
    check("Remove all imported dictionaries empties the library",
      emptied !== null && before.some(path => path.includes(".hdw-generation-")) && after !== null,
      JSON.stringify({ emptied, before: before.length, after }));
  });
});
