/*
 * Importing Yomitan archives from Settings into the IndexedDB engine, and
 * managing the library: aliases, enabling and groups.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./first-run.mjs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { buildTitledZip, GENERIC_KANJI_GLOSSARY, GENERIC_KANJI_TITLE } from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import {
  dictionaryState, FIXTURE, FIXTURE_ID, HERE, importArchives, listIdbfsPaths, page, sendRuntime, setInputFiles,
  showSettingsSection, waitFor,
} from "./session.mjs";

const NESTED_TITLE = "hachidori-firefox-nested";
// A definition with Japanese in it, for a lookup inside the popup.
const NESTED_ARCHIVE = buildTitledZip(NESTED_TITLE, {
  terms: [["猫", "ねこ", "n", "", 1, ["a cat; likes to 食べる fish"], 1, ""]],
});

const files = paths => paths.map(path => ({ name: path.split("/").at(-1), path }));
const generationRoot = path => path?.split("/").slice(0, 3).join("/") ?? "";
const lookupTitles = async text => {
  const reply = await sendRuntime(page, { target: "hoshidicts-offscreen", type: "hd_lookup", requestId: `lookup-${text}`, text });
  return (reply.results ?? []).flatMap(result => result.term?.glossaries?.map(glossary => glossary.dictionary) ?? []);
};

describe("import", () => {
  let fixturePackage = null;

  step("importing a Yomitan .zip", async () => {
    await showSettingsSection(page, "add-dictionaries");
    const shape = await page.evaluate(() => {
      const input = document.getElementById("import-file");
      return input && { type: input.type, accept: input.getAttribute("accept") ?? "", multiple: input.multiple };
    });
    check("settings page exposes a .zip file input",
      shape?.type === "file" && shape.accept.split(",").map(value => value.trim()).includes(".zip") && shape.multiple === true,
      JSON.stringify(shape));
    const state = await importArchives(page, files([FIXTURE]));
    const row = await page.evaluate(() => document.querySelector("#import-progress .setup-dictionary-status")?.textContent ?? "");
    check("importing a Yomitan .zip from the settings page succeeds",
      state === "Finished 1 of 1 archive — 1 imported, 0 failed." && /^Imported hachidori-fixture in \d+(\.\d)? seconds: /u.test(row),
      JSON.stringify({ state, row }));
    const stored = await dictionaryState(page);
    fixturePackage = stored?.dictionaries?.find(entry => entry.title === "hachidori-fixture");
    check("the imported dictionary is recorded in chrome.storage.local",
      stored?.dictionaries.length === 1 && fixturePackage?.id === FIXTURE_ID && fixturePackage.enabled === true
        && fixturePackage.termCount === 6 && fixturePackage.frequencyCount === 2 && fixturePackage.pitchCount === 2
        && fixturePackage.kanjiCount === 1 && fixturePackage.mediaCount === 1,
      JSON.stringify(stored));
    const paths = await listIdbfsPaths(page);
    check("the imported dictionary is persisted in IndexedDB",
      ["blobs.bin", "hash.table", "index.json", "media.bin"].every(name => paths.includes(`${fixturePackage?.path}/${name}`)),
      JSON.stringify({ path: fixturePackage?.path, paths }));
  });

  step("batch import and re-import", async () => {
    const batch = await importArchives(page, [
      ...files([resolve(HERE, "fixtures/hachidori-generic-kanji-fixture.zip"), resolve(HERE, "fixtures/malformed-index.zip")]),
      { name: `${NESTED_TITLE}.zip`, bytes: NESTED_ARCHIVE },
    ]);
    const outcomes = await page.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
      .map(row => [row.querySelector(".setup-dictionary-name")?.textContent ?? "",
        row.querySelector(".setup-dictionary-status")?.textContent ?? ""]));
    const afterBatch = await dictionaryState(page);
    check("a batch of archives imports in one selection",
      batch === "Finished 3 of 3 archives — 2 imported, 1 failed."
        && JSON.stringify(afterBatch?.dictionaries.map(entry => entry.title).sort())
          === JSON.stringify(["hachidori-fixture", GENERIC_KANJI_TITLE, NESTED_TITLE].sort()),
      JSON.stringify({ batch, outcomes, titles: afterBatch?.dictionaries.map(entry => entry.title) }));
    check("a malformed archive fails with its reason and leaves the library unchanged",
      outcomes.some(([name, text]) => name === "malformed-index.zip" && text.startsWith("Failed before import"))
        && afterBatch?.dictionaries.length === 3,
      JSON.stringify(outcomes));

    // A second import of an installed title asks whether to replace it.
    await showSettingsSection(page, "add-dictionaries");
    await setInputFiles(page, "#import-file", files([FIXTURE]));
    const asked = await waitFor(() => page.evaluate(() => document.getElementById("import-decision-dialog")?.open || false));
    await page.evaluate(() => document.querySelector('#import-decision-dialog button[value="replace"]').click());
    const replaced = await waitFor(() => page.evaluate(() => {
      const text = (document.getElementById("import-state")?.textContent ?? "").trim();
      return text.startsWith("Finished 1 of 1 archive") ? text : false;
    }), { timeout: 120_000 });
    const afterReplace = await dictionaryState(page);
    const replacement = afterReplace?.dictionaries.find(entry => entry.title === "hachidori-fixture");
    const gone = await waitFor(async () => {
      const paths = await listIdbfsPaths(page);
      return paths.some(path => path.startsWith(`${generationRoot(fixturePackage?.path)}/`)) ? false : paths;
    }, { timeout: 30_000 });
    check("re-importing an installed dictionary replaces its generation",
      asked === true && replaced === "Finished 1 of 1 archive — 1 imported, 0 failed."
        && replacement?.id === FIXTURE_ID && replacement.path !== fixturePackage?.path
        && gone?.some(path => path.startsWith(`${replacement.path}/`)) === true && afterReplace.dictionaries.length === 3,
      JSON.stringify({ asked, replaced, before: fixturePackage?.path, after: replacement?.path }));
  });
});

describe("library", () => {
  step("aliases, enabling and groups", async () => {
    await showSettingsSection(page, "dictionaries");
    const id = FIXTURE_ID;
    await page.evaluate(dictionaryId => {
      const details = document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-details`);
      details.open = true;
      const input = details.querySelector(".dict-display-name");
      input.value = "Fixture Alias";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, id);
    const aliased = await waitFor(async () => {
      const state = await dictionaryState(page);
      return state?.dictionaries.find(entry => entry.id === id)?.displayName === "Fixture Alias" ? state : false;
    });
    const label = await waitFor(() => page.evaluate(dictionaryId => {
      const title = document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-title`)?.textContent ?? "";
      return title.includes("Fixture Alias") ? title : false;
    }, id));
    check("an alias renames the dictionary in Settings", aliased !== null && label !== null,
      JSON.stringify({ label }));

    const generic = (await dictionaryState(page)).dictionaries.find(entry => entry.title === GENERIC_KANJI_TITLE);
    const before = await lookupTitles("食");
    const toggle = async enabled => {
      await page.evaluate(dictionaryId => document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"] .dict-enabled`)
        .click(), generic.id);
      return waitFor(async () => (await dictionaryState(page)).dictionaries
        .find(entry => entry.id === generic.id)?.enabled === enabled || false);
    };
    const disabled = await toggle(false);
    const whileDisabled = await waitFor(async () => {
      const titles = await lookupTitles("食");
      return titles.includes(GENERIC_KANJI_TITLE) ? false : titles;
    });
    const rowKept = await page.evaluate(dictionaryId => document.querySelector(`.dict-row[data-dictionary-id="${dictionaryId}"]`) !== null,
      generic.id);
    const enabled = await toggle(true);
    const afterEnable = await waitFor(async () => {
      const titles = await lookupTitles("食");
      return titles.includes(GENERIC_KANJI_TITLE) ? titles : false;
    });
    check("disabling a dictionary keeps its row and removes its results from lookups",
      before.includes(GENERIC_KANJI_TITLE) && disabled && whileDisabled !== null && rowKept && enabled && afterEnable !== null,
      JSON.stringify({ before, whileDisabled, afterEnable, glossary: GENERIC_KANJI_GLOSSARY }));

    await showSettingsSection(page, "dictionary-groups");
    await page.evaluate(() => {
      const name = document.getElementById("dict-group-name-new");
      name.value = "Study";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("dict-group-create").click();
    });
    const created = await waitFor(async () => {
      const state = await dictionaryState(page);
      return state?.groups?.find(group => group.name === "Study") ?? false;
    });
    await waitFor(() => page.evaluate(() => document.querySelector(".dict-group .dict-group-add-select") !== null || false));
    await page.evaluate(dictionaryId => {
      const group = [...document.querySelectorAll(".dict-group")].find(node => node.querySelector(".dict-group-name")?.value === "Study");
      const select = group.querySelector(".dict-group-add-select");
      select.value = dictionaryId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      group.querySelector(".dict-group-add").click();
    }, id);
    const member = await waitFor(async () => {
      const state = await dictionaryState(page);
      const group = state?.groups?.find(entry => entry.name === "Study");
      return group?.dictionaryIds?.includes(id) ? group : false;
    });
    check("a dictionary group is saved with its member", created !== null && member !== null, JSON.stringify({ created, member }));
  });
});

export { NESTED_TITLE };
