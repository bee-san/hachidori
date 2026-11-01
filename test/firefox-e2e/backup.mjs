/*
 * Managed dictionary updates, and backups: export through Firefox's
 * downloads, restoring backups the Chrome releases exported, and restoring a
 * Firefox backup into a fresh Firefox profile.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./anki.mjs";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe } from "node:test";
import { buildTitledZip } from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import {
  activate, dictionaryState, downloadedFiles, downloadsDirectory, HERE, importArchives, installHachidori, launchFirefox,
  openExtensionPage, page, readStorage, reloadPage, sendRuntime, setInputFiles, showSettingsSection, sleep, updateOrigin, updateRoutes,
  waitFor,
} from "./session.mjs";

const MANAGED_TITLE = "hachidori-firefox-managed";

const managedArchive = revision => buildTitledZip(MANAGED_TITLE, {
  revision,
  indexUrl: `${updateOrigin}/managed-index.json`,
  downloadUrl: `${updateOrigin}/managed.zip`,
  indexOverrides: { isUpdatable: true },
  terms: [["更新", "こうしん", "n", "", 1, [`update fixture ${revision}`], 1, ""]],
});

const updateState = target => target.evaluate(() => document.getElementById("update-state")?.textContent?.trim() ?? "");
const lookupText = async (target, text) => JSON.stringify((await sendRuntime(target, { target: "hoshidicts-offscreen",
  type: "hd_lookup", requestId: `lookup-${text}`, text })).results ?? []);

// Prepares a backup file in Settings, confirms it and restores it.
async function restoreBackup(target, file) {
  await showSettingsSection(target, "backup");
  await setInputFiles(target, "#backup-file", [file]);
  const preview = await waitFor(() => target.evaluate(() => {
    const shown = document.getElementById("backup-preview");
    return shown && !shown.hidden && document.getElementById("backup-status")?.textContent.startsWith("Backup checked")
      ? [...document.querySelectorAll("#backup-dictionaries li")].map(item => item.textContent) : false;
  }), { timeout: 60_000 });
  await target.evaluate(() => {
    const confirm = document.getElementById("backup-confirm");
    confirm.checked = true;
    confirm.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("backup-restore").click();
  });
  const restored = await waitFor(() => target.evaluate(() => {
    const text = document.getElementById("backup-status")?.textContent ?? "";
    return text.startsWith("Restored successfully") ? text : false;
  }), { timeout: 120_000 });
  return { preview, restored };
}

let exported = null;

describe("updates", () => {
  step("Check now and Update", async () => {
    updateRoutes.set("/managed-index.json", { contentType: "application/json", body: JSON.stringify({ revision: "managed-2" }) });
    updateRoutes.set("/managed.zip", { contentType: "application/zip", body: managedArchive("managed-2") });
    await activate(page);
    await importArchives(page, [{ name: "managed.zip", bytes: managedArchive("managed-1") }]);
    const installed = (await dictionaryState(page)).dictionaries.find(entry => entry.title === MANAGED_TITLE);
    await showSettingsSection(page, "updates");
    await page.evaluate(() => document.getElementById("update-check-now").click());
    const checked = await waitFor(async () => {
      const text = await updateState(page);
      return text.startsWith("Checked") ? text : false;
    }, { timeout: 60_000 });
    const afterCheck = (await dictionaryState(page)).dictionaries.find(entry => entry.title === MANAGED_TITLE);
    check("Check now records an available update from the dictionary's update index",
      installed?.revision === "managed-1" && checked === "Checked 1 managed dictionary — 1 update available, 0 failed."
        && afterCheck?.lastUpdateCheck?.status === "update-available" && afterCheck.revision === "managed-1"
        && updateRoutes.get("/managed-index.json").requests === 1 && !updateRoutes.get("/managed.zip").requests,
      JSON.stringify({ installed: installed?.revision, checked, lastUpdateCheck: afterCheck?.lastUpdateCheck }));
    await waitFor(() => page.evaluate(() => !document.getElementById("update-all").disabled || false));
    await page.evaluate(() => document.getElementById("update-all").click());
    const finished = await waitFor(async () => {
      const text = await updateState(page);
      return text.startsWith("Finished") ? text : false;
    }, { timeout: 120_000 });
    const updated = (await dictionaryState(page)).dictionaries.find(entry => entry.title === MANAGED_TITLE);
    check("Update installs the newer revision",
      finished === "Finished 1 dictionary update — 1 updated, 0 failed." && updated?.revision === "managed-2"
        && updated.path !== installed?.path && (await lookupText(page, "更新")).includes("update fixture managed-2")
        && updateRoutes.get("/managed.zip").requests === 1,
      JSON.stringify({ finished, updated }));
  });
});

describe("backups", () => {
  step("export a backup", async () => {
    await reloadPage(page);
    await showSettingsSection(page, "backup");
    const existing = new Set(downloadedFiles());
    await page.evaluate(() => document.getElementById("backup-export").click());
    const file = await waitFor(async () => {
      const name = downloadedFiles().find(entry => !existing.has(entry) && /^hachidori-backup-\d{4}-\d{2}-\d{2}.*\.zip$/u.test(entry));
      if (!name) return false;
      const size = statSync(resolve(downloadsDirectory(), name)).size;
      await sleep(300);
      return size > 0 && size === statSync(resolve(downloadsDirectory(), name)).size ? name : false;
    }, { timeout: 60_000 });
    const status = await page.evaluate(() => document.getElementById("backup-status")?.textContent ?? "");
    exported = file ? { name: file, path: resolve(downloadsDirectory(), file) } : null;
    const header = exported ? readFileSync(exported.path).subarray(0, 4).toString("latin1") : "";
    check("Export backup downloads a backup ZIP through Firefox's downloads",
      exported !== null && header === "PK\u0003\u0004" && status.startsWith("Download started"),
      JSON.stringify({ file, status, header }));
  });

  step("restore backups the Chrome releases exported", async () => {
    for (const release of ["0.1.1", "0.3.0"]) {
      const { preview, restored } = await restoreBackup(page, { name: `hachidori-${release}.zip`,
        path: resolve(HERE, `data/backups/hachidori-${release}.zip`) });
      const stored = await readStorage(page, ["options", "dictionaryState", "dictionaryUpdates", "wordStatusOverrides"]);
      const stats = await sendRuntime(page, { target: "hoshidicts-worker", type: "hd_lookup_stats_read", requestId: "stats",
        term: "食べる", reading: "たべる" });
      const options = stored.options ?? {};
      check(`a backup exported by Hachidori ${release} for Chrome restores in Firefox`,
        JSON.stringify(preview) === JSON.stringify(["Hachidori Custom Dictionary", "hachidori-fixture"]) && restored !== null
          && options.scanLength === 20 && options.maxResults === 40 && options.popupTheme === "dark"
          && options.popupWidthPx === 640 && options.showPopupAudioButton === false
          && JSON.stringify(stored.dictionaryState?.groups?.map(({ name, dictionaryIds }) => [name, dictionaryIds.length]))
            === JSON.stringify([["Study", 1]])
          && stored.dictionaryUpdates?.schedule === "weekly"
          && JSON.stringify(stats).includes("\"lookupCount\":2")
          && JSON.stringify(stored.wordStatusOverrides?.known ?? []) === JSON.stringify(release === "0.3.0" ? ["猫"] : []),
        JSON.stringify({ preview, restored, options: { scanLength: options.scanLength, maxResults: options.maxResults,
          popupTheme: options.popupTheme }, groups: stored.dictionaryState?.groups, updates: stored.dictionaryUpdates, stats,
        overrides: stored.wordStatusOverrides }));
    }
    const verb = await lookupText(page, "食べたかった");
    const note = await lookupText(page, "猫");
    check("the restored library answers lookups and shows the personal entry",
      verb.includes("to eat") && note.includes("personal note"), JSON.stringify({ verb: verb.slice(0, 200), note: note.slice(0, 300) }));
  });

  step("restore the Firefox backup into a fresh profile", async () => {
    const fresh = resolve(tmpdir(), `hachidori-firefox-fresh-${process.pid}`);
    const second = await launchFirefox(fresh);
    let result = null;
    try {
      await installHachidori(second.browser);
      const settings = await openExtensionPage("settings.html", second.browser);
      await waitFor(async () => (await sendRuntime(settings, { target: "hoshidicts-offscreen", type: "hd_status", requestId: "s" }))?.ready
        || false, { timeout: 60_000 });
      const { preview, restored } = await restoreBackup(settings, exported);
      const state = await dictionaryState(settings);
      const { customDictionarySource } = await readStorage(settings, ["customDictionarySource"]);
      result = {
        preview, restored,
        titles: state?.dictionaries?.map(entry => entry.title).sort(),
        alias: state?.dictionaries?.find(entry => entry.title === "hachidori-fixture")?.displayName,
        note: customDictionarySource?.text?.includes("a personal note from Firefox") ?? false,
        managed: state?.dictionaries?.find(entry => entry.title === MANAGED_TITLE)?.revision,
        lookup: (await lookupText(settings, "更新")).includes("update fixture managed-2"),
      };
    } finally {
      await second.browser.close().catch(() => {});
    }
    check("the Firefox backup restores into a fresh Firefox profile",
      result?.restored !== null && JSON.stringify(result.titles) === JSON.stringify(["Hachidori Custom Dictionary",
        "hachidori-firefox-managed", "hachidori-firefox-nested", "hachidori-fixture", "hachidori-generic-kanji-fixture"])
        && result.alias === "Fixture Alias" && result.note && result.managed === "managed-2" && result.lookup,
      JSON.stringify(result));
  });
});

export { MANAGED_TITLE };
