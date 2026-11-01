/*
 * Backups with language profiles in real Chrome (docs/languages.md 17.2,
 * 17.6 and the backup cases of section 18): an installation with Japanese and
 * English profiles exports a version 4 backup; a fresh installation restores
 * it through Settings, names the languages in the preview, rebuilds the
 * English personal dictionary from its document and looks up English at once;
 * an automatic snapshot with profiles is listed and restored in place; a build
 * without the English pack restores the rest and names English; and the
 * released Hachidori restores the backup's Japanese view.
 *
 * The extensions under test are copies whose language registry holds the
 * Japanese pack and the English and Arabic fixture packs of
 * test/data/languages/ (or, for "a build without English", Japanese and
 * Arabic), as test/chrome-languages.mjs builds them. The released build is
 * the one test/chrome-backup-release.mjs pins; HACHIDORI_BACKUP_RELEASE_ZIP
 * uses a local copy, and HACHIDORI_SKIP_RELEASE=1 leaves that check out
 * (it then fails, as a check that never runs).
 *
 *   node test/run.mjs chrome-languages
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BlobReader, Uint8ArrayWriter, ZipReader } from "../../extension/vendor/zip.js";
import { extensionWith, launchExtension, releasedExtension } from "./builds.mjs";
import { ENGLISH, buildLanguageFixtureZip } from "../make-language-fixtures.mjs";
import { buildFixtureZip } from "../make-fixture.mjs";

const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || "";
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
const puppeteer = await import(PUPPETEER.startsWith("/") ? `file://${PUPPETEER}` : PUPPETEER);
const ENGLISH_PERSONAL = "swim, , to move through water\n";
const ENGLISH_PERSONAL_TITLE = "Hachidori Custom Dictionary (English)";

const PLANNED = [
  "an installation with Japanese and English exports a version 4 backup whose snapshot is the Japanese view",
  "a fresh installation's Settings preview names the restored languages and counts every language's personal entries",
  "the restore rebuilds the English personal dictionary from its document and keeps English counts and marks",
  "right after the restore English and Japanese look up, the English pack loaded before the restore published",
  "an automatic snapshot with profiles is listed as valid with every language's dictionaries and personal entries",
  "restoring the automatic snapshot brings back the English personal entries it holds",
  "a build without the English pack restores Japanese, keeps the English dictionary in no profile, and names English",
  "the released Hachidori restores the version 4 backup's Japanese view and looks up Japanese",
];
const results = new Map();
function check(name, ok, detail = "") {
  if (!PLANNED.includes(name)) throw new Error(`unplanned check: ${name}`);
  results.set(name, { ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail}`}`);
}
async function step(name, run) {
  try {
    await run();
  } catch (error) {
    if (!results.has(name)) check(name, false, error?.stack ?? String(error));
    else console.log(`      after ${name}: ${error?.stack ?? error}`);
  }
}
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(probe, { timeout = 30_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await wait(interval);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "hachidori-languages-backup-"));
const errors = [];
const browsers = [];

async function launch(name, extension) {
  const installation = await launchExtension(puppeteer, { chrome: CHROME, scratch, name, extension, errors });
  browsers.push(installation.browser);
  return installation;
}

// The backup archive the engine exports, as the Settings fallback reads it.
async function exportBackup(installation) {
  const page = await installation.page("settings.html#backup");
  const base64 = await page.evaluate(async () => {
    const exported = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_backup_export", requestId: "export" });
    if (exported?.ok !== true) throw new Error(JSON.stringify(exported));
    const bytes = new Uint8Array(await (await fetch(exported.blobUrl)).arrayBuffer());
    await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_backup_release", requestId: "release", blobUrl: exported.blobUrl });
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(text);
  });
  await page.close();
  return Buffer.from(base64, "base64");
}

async function readManifest(bytes) {
  const reader = new ZipReader(new BlobReader(new Blob([bytes])), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    const manifest = entries.find(entry => entry.filename === "hachidori-backup.json");
    return { manifest: JSON.parse(new TextDecoder().decode(await manifest.getData(new Uint8ArrayWriter()))),
      files: entries.map(entry => entry.filename) };
  } finally {
    await reader.close();
  }
}

// Settings → Backup & restore: choose the file, read the preview, confirm, restore.
async function restoreInSettings(installation, file) {
  const page = await installation.page("settings.html#backup");
  await page.waitForSelector("#backup-file", { timeout: 30_000 });
  await (await page.$("#backup-file")).uploadFile(file);
  await page.waitForFunction(() => document.getElementById("backup-preview")?.hidden === false, { timeout: 120_000, polling: 100 });
  const preview = await page.evaluate(() => ({
    count: document.getElementById("backup-count").textContent,
    notes: [...document.querySelectorAll("#backup-language-notes p")].map(line => line.textContent),
    dictionaries: [...document.querySelectorAll("#backup-dictionaries li")].map(item => item.textContent),
  }));
  await page.click("#backup-confirm");
  await page.click("#backup-restore");
  await page.waitForFunction(() => /^Restored successfully/u.test(document.getElementById("backup-status").textContent),
    { timeout: 120_000, polling: 100 }).catch(() => {});
  const status = await page.evaluate(() => document.getElementById("backup-status").textContent);
  await page.close();
  return { preview, status };
}

const lookup = (installation, text, profileId) => installation.message({ target: "hoshidicts-offscreen", type: "hd_lookup", text,
  maxResults: 16, scanLength: 16, options: {}, ...(profileId === undefined ? {} : { profileId }) });

const glossaries = reply => JSON.stringify(reply?.results ?? []);

try {
  const full = await extensionWith(scratch, "full", ["en", "ar"]);
  const withoutEnglish = await extensionWith(scratch, "without-english", ["ar"]);
  const backupFile = join(scratch, "hachidori-languages-backup.zip");
  let source = null;

  await step(PLANNED[0], async () => {
    source = await launch("source", full);
    await source.importArchive(buildFixtureZip(), "hachidori-fixture.zip");
    const added = await source.message({ target: "hoshidicts-offscreen", type: "hd_profile_add", language: "en", copyFrom: "ja" });
    if (added?.ok !== true) throw new Error(`hd_profile_add: ${JSON.stringify(added)}`);
    await source.importArchive(buildLanguageFixtureZip(ENGLISH), ENGLISH.file, "en");
    const saved = await source.message({ target: "hoshidicts-offscreen", type: "hd_custom_save", profileId: "en",
      baseDocumentRevision: 0, text: ENGLISH_PERSONAL });
    if (saved?.ok !== true) throw new Error(`hd_custom_save: ${JSON.stringify(saved)}`);
    for (let count = 0; count < 2; count += 1) {
      await source.message({ target: "hoshidicts-worker", type: "hd_lookup_stats_record", term: "run", reading: "", profileId: "en" });
    }
    await source.message({ target: "hoshidicts-worker", type: "hd_word_status_override", headword: "walk", status: "known", profileId: "en" });
    const archive = await exportBackup(source);
    writeFileSync(backupFile, archive);
    const { manifest, files } = await readManifest(archive);
    const titles = manifest.snapshot.state.dictionaries.map(entry => [entry.title, entry.enabled]);
    check(PLANNED[0], manifest.version === 4 && manifest.snapshot.state.schemaVersion === 1
      && JSON.stringify(titles) === JSON.stringify([["hachidori-fixture", true], [ENGLISH.title, false]])
      && manifest.profiles?.options?.profiles?.map(profile => profile.id).join() === "ja,en"
      && manifest.profiles.languages?.en?.document?.text === ENGLISH_PERSONAL
      && manifest.profiles.languages.en.lookupStatsRows?.[0]?.lookupCount === 2
      && !files.some(path => path.startsWith("dictionaries/2/")),
    JSON.stringify({ version: manifest.version, titles, files, languages: manifest.profiles?.languages }));
  });

  let target = null;
  await step(PLANNED[1], async () => {
    target = await launch("target", full);
    const { preview, status } = await restoreInSettings(target, backupFile);
    check(PLANNED[1], preview.notes.join("|") === "Restores Japanese and English." && preview.count === "3 dictionaries · 1 personal entries"
      && preview.dictionaries.includes(ENGLISH_PERSONAL_TITLE), JSON.stringify({ preview, status }));
  });

  await step(PLANNED[2], async () => {
    const stored = await until(async () => {
      const value = await target.storage(["options", "dictionaryState", "customDictionarySource", "lookupStats", "wordStatusOverrides"]);
      return value.options?.profiles?.length === 2 ? value : null;
    }) ?? {};
    const personal = stored.dictionaryState?.dictionaries?.find(entry => entry.title === ENGLISH_PERSONAL_TITLE);
    const count = await target.message({ target: "hoshidicts-worker", type: "hd_lookup_stats_read", term: "run", reading: "", profileId: "en" });
    check(PLANNED[2], Boolean(personal) && stored.dictionaryState.profiles.en.dictionaries[0]?.id === personal.id
      && stored.customDictionarySource?.languages?.en?.text === ENGLISH_PERSONAL
      && count?.statistics?.lookupCount === 2
      && stored.wordStatusOverrides?.languages?.en?.known?.join() === "walk"
      && stored.wordStatusOverrides.languages.en.ignored?.length === 0,
    JSON.stringify({ personal, profiles: stored.dictionaryState?.profiles, count, marks: stored.wordStatusOverrides }));
  });

  await step(PLANNED[3], async () => {
    const english = await lookup(target, "running", "en");
    const personal = await lookup(target, "swim", "en");
    const japanese = await lookup(target, "食べたかった");
    const status = await target.message({ target: "hoshidicts-offscreen", type: "hd_status" });
    check(PLANNED[3], glossaries(english).includes("to move swiftly on foot") && glossaries(personal).includes("to move through water")
      && glossaries(japanese).includes("食べる") && Array.isArray(status?.failedLanguages) && status.failedLanguages.length === 0,
    JSON.stringify({ english: glossaries(english).slice(0, 300), personal: glossaries(personal).slice(0, 300),
      japanese: glossaries(japanese).slice(0, 200), failed: status?.failedLanguages }));
  });

  await step(PLANNED[4], async () => {
    // A due snapshot of the records as they are now, with English.
    await source.worker.evaluate(async () => {
      await chrome.storage.local.set({ automaticBackups: { schemaVersion: 1, backups: [] } });
      await chrome.alarms.create("hachidori-automatic-backup", { when: Date.now() });
    });
    const store = await until(async () => {
      const value = (await source.storage(["automaticBackups"])).automaticBackups;
      return value?.backups?.length === 1 ? value : null;
    }, { timeout: 60_000 });
    const page = await source.page("settings.html#backup");
    const listed = await until(() => page.evaluate(() => {
      const row = document.querySelector("#automatic-backup-list .automatic-backup-detail");
      return row ? { detail: row.textContent, status: document.getElementById("automatic-backup-status").textContent } : null;
    }), { timeout: 30_000 });
    await page.close();
    // The Japanese fixture, the English one and the English personal dictionary.
    check(PLANNED[4], Boolean(store?.backups?.[0]?.profiles) && listed?.detail === "3 dictionaries · 1 personal entries"
      && !/damaged/u.test(listed.status), JSON.stringify({ listed, keys: Object.keys(store?.backups?.[0] ?? {}) }));
  });

  await step(PLANNED[5], async () => {
    const before = await source.message({ target: "hoshidicts-worker", type: "hd_custom_read", profileId: "en" });
    const cleared = await source.message({ target: "hoshidicts-offscreen", type: "hd_custom_save", profileId: "en",
      baseDocumentRevision: before.document.revision, text: "" });
    if (cleared?.ok !== true) throw new Error(`clearing: ${JSON.stringify(cleared)}`);
    const page = await source.page("settings.html#backup");
    await page.waitForSelector("#automatic-backup-list .automatic-backup-restore", { timeout: 30_000 });
    await page.click("#automatic-backup-list .automatic-backup-restore");
    await page.waitForFunction(() => document.getElementById("backup-preview")?.hidden === false, { timeout: 120_000, polling: 100 });
    const notes = await page.evaluate(() => [...document.querySelectorAll("#backup-language-notes p")].map(line => line.textContent));
    await page.click("#backup-confirm");
    await page.click("#backup-restore");
    const restored = await until(async () => {
      const value = await source.storage(["customDictionarySource"]);
      return value.customDictionarySource?.languages?.en?.text === ENGLISH_PERSONAL ? value : null;
    }, { timeout: 120_000 });
    await page.close();
    const personal = await lookup(source, "swim", "en");
    check(PLANNED[5], Boolean(restored) && notes.join("|") === "Restores Japanese and English."
      && glossaries(personal).includes("to move through water"),
    JSON.stringify({ notes, document: restored?.customDictionarySource?.languages, personal: glossaries(personal).slice(0, 200) }));
  });

  await step(PLANNED[6], async () => {
    const reduced = await launch("without-english", withoutEnglish);
    const { preview } = await restoreInSettings(reduced, backupFile);
    const stored = await until(async () => {
      const value = await reduced.storage(["options", "dictionaryState", "customDictionarySource"]);
      return value.dictionaryState?.dictionaries?.some(entry => entry.title === ENGLISH.title) ? value : null;
    }) ?? {};
    const inProfile = Object.values(stored.dictionaryState?.profiles ?? {}).some(profile =>
      profile.dictionaries.some(entry => stored.dictionaryState.dictionaries.find(row => row.id === entry.id)?.title === ENGLISH.title));
    const japanese = await lookup(reduced, "食べたかった");
    check(PLANNED[6], preview.notes.includes("English needs a newer Hachidori and is not restored.")
      && !inProfile && !Object.hasOwn(stored.options ?? {}, "profiles") && stored.dictionaryState.schemaVersion === 1
      && stored.dictionaryState.dictionaries.find(entry => entry.title === ENGLISH.title)?.enabled === false
      && !stored.dictionaryState.dictionaries.some(entry => entry.title === ENGLISH_PERSONAL_TITLE)
      && glossaries(japanese).includes("食べる"),
    JSON.stringify({ preview, state: stored.dictionaryState, options: Object.keys(stored.options ?? {}) }));
  });

  await step(PLANNED[7], async () => {
    if (process.env.HACHIDORI_SKIP_RELEASE === "1") return;
    const released = await launch("released", await releasedExtension(scratch));
    const page = await released.page("settings.html#backup");
    const reply = await page.evaluate(async base64 => {
      const data = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
      const token = crypto.randomUUID();
      const prepared = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_backup_prepare", requestId: "prepare",
        blobUrl, token });
      if (prepared?.ok !== true) return { prepared };
      const restored = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_backup_restore", requestId: "restore", token });
      return { prepared, restored };
    }, readFileSync(backupFile).toString("base64"));
    const stored = await released.storage(["options", "dictionaryState"]);
    const japanese = await lookup(released, "食べたかった");
    check(PLANNED[7], reply.restored?.ok === true && stored.dictionaryState?.schemaVersion === 1
      && JSON.stringify(stored.dictionaryState.dictionaries.map(entry => [entry.title, entry.enabled]))
        === JSON.stringify([["hachidori-fixture", true], [ENGLISH.title, false]])
      && !Object.hasOwn(stored.options ?? {}, "profiles") && glossaries(japanese).includes("食べる"),
    JSON.stringify({ reply, state: stored.dictionaryState?.dictionaries?.map(entry => entry.title) }));
  });
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}

const failed = PLANNED.filter(name => results.get(name)?.ok !== true);
for (const name of PLANNED.filter(planned => !results.has(planned))) console.log(`FAIL  ${name}\n      check never ran`);
if (errors.length > 0) console.log(`page errors:\n  ${errors.join("\n  ")}`);
console.log(`\n${PLANNED.length - failed.length}/${PLANNED.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
