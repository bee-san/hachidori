/*
 * Sharing with language profiles in real Chrome and the Anki add-on's relay
 * (docs/languages.md 17.3-17.6 and the sharing cases of section 18). A host
 * with every fixture pack shares through the relay; the released Hachidori
 * (from before profiles) and profile-aware builds link to it:
 *
 *   host      Japanese, English and Arabic packs
 *   older     the released build test/chrome-backup-release.mjs pins
 *   wide      the host's packs and one more (Esperanto, made from the
 *             English fixture pack)
 *   narrow    Japanese and English only
 *   own       the host's packs, with its own English profile before linking
 *
 * The relay comes from HACHIDORI_RELAY_SERVER (a server.py), else from
 * HACHIDORI_ANKI_ADDON (an .ankiaddon), else from the pinned release that
 * Settings → Sharing downloads; python3 runs it.
 *
 *   node test/run.mjs chrome-languages
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ANKI_ADDON_FILE_NAME, ANKI_ADDON_URL, ANKI_ADDON_VERSION } from "../../extension/anki-addon.js";
import { startAnkiRelayServer } from "../anki-relay-server.mjs";
import { extensionWith, launchExtension, releasedExtension } from "./builds.mjs";
import { ENGLISH, buildLanguageFixtureZip } from "../make-language-fixtures.mjs";
import { buildFixtureZip, buildTitledZip } from "../make-fixture.mjs";

const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || "";
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
const puppeteer = await import(PUPPETEER.startsWith("/") ? `file://${PUPPETEER}` : PUPPETEER);
// A test-only port, away from chrome-sharing's and a developer's own relay.
const PORT = Number(process.env.HACHIDORI_LANGUAGES_SHARING_PORT) || 18773;
const ADDRESS = `127.0.0.1:${PORT}`;
const ESPERANTO = { code: "eo", name: "Esperanto", iso639_3: "epo" };
// A dictionary with Han headwords in the English profile: an older browser,
// whose requests mean Japanese, must never see it answer.
const HAN_TITLE = "hachidori-han-in-english";
const HAN_GLOSSARY = "a Han headword that only the English profile uses";
const NO_JAPANESE = "This Hachidori has no Japanese profile. Add Japanese in its Settings, or update the linked browser.";

const PLANNED = [
  "a single-profile host gives the older and the profile-aware browser today's records, and neither opts in",
  "when the host gains profiles both reconnect: the older browser keeps the Japanese view, the profile-aware one opts in, at newer revisions",
  "an open toolbar and Settings on the profile-aware browser show the host's profiles once the host gains them",
  "the older browser finds only the Japanese profile's dictionaries for Han text and cannot delete a package English uses",
  "an open toolbar and Settings on a profile-aware browser show the host's profiles right after a new link",
  "when the host adds a language a linked browser lacks, it never stores that profile, also with a write in flight, and keeps working",
  "Settings → Sharing on the refused browser names the language it needs",
  "adding a language this browser has and the host lacks is refused with its message",
  "an opt-in refused for a language the host holds only through data is accepted after that language is erased",
  "unlinking keeps the browser's own English counts and document, above the mirror's revision, and its language choice",
  "an older browser linked to an English-only host finds nothing and its profile writes are refused, global ones are not",
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

const scratch = mkdtempSync(join(tmpdir(), "hachidori-languages-sharing-"));
const errors = [];
const browsers = [];
let relay = null;

async function launch(name, extension) {
  const installation = await launchExtension(puppeteer, { chrome: CHROME, scratch, name, extension, errors });
  browsers.push(installation.browser);
  return installation;
}

// The relay from a server.py, an add-on archive, or the pinned release.
async function startRelay() {
  if (process.env.HACHIDORI_RELAY_SERVER) return startAnkiRelayServer({ serverPath: process.env.HACHIDORI_RELAY_SERVER, port: PORT });
  let archive = process.env.HACHIDORI_ANKI_ADDON;
  if (!archive) {
    archive = resolve(CACHE, "hachidori-anki-addon", ANKI_ADDON_VERSION, ANKI_ADDON_FILE_NAME);
    if (!existsSync(archive)) {
      const response = await fetch(ANKI_ADDON_URL);
      if (!response.ok) throw new Error(`${ANKI_ADDON_URL}: HTTP ${response.status}`);
      mkdirSync(dirname(archive), { recursive: true });
      writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    }
  }
  return startAnkiRelayServer({ archive, port: PORT });
}

const sharing = (installation, type, fields = {}) => installation.message({ target: "hachidori-sharing", type, ...fields });
const status = async installation => (await sharing(installation, "hd_sharing_status"))?.sharing;
const profilesOf = async installation => (await status(installation))?.client?.languageProfiles;
const engine = (installation, type, fields = {}) => installation.message({ target: "hoshidicts-offscreen", type, ...fields });
const worker = (installation, type, fields = {}) => installation.message({ target: "hoshidicts-worker", type, ...fields });
const lookup = (installation, text, profileId) => engine(installation, "hd_lookup", { text, maxResults: 16, scanLength: 16, options: {},
  ...(profileId === undefined ? {} : { profileId }) });
const glossaries = reply => JSON.stringify(reply?.results ?? []);
const languagesOf = options => (options?.profiles ?? []).map(profile => profile.language);

async function link(installation) {
  const reply = await sharing(installation, "hd_sharing_client_link", { address: ADDRESS });
  if (reply?.ok !== true) throw new Error(`${installation.name} could not link: ${JSON.stringify(reply)}`);
  const linked = await until(async () => (await status(installation))?.client?.connected === true, { timeout: 30_000 });
  if (!linked) throw new Error(`${installation.name} did not connect`);
  return reply;
}

// What an open page of the browser shows: the toolbar's language buttons and
// the Settings Language menu's choices.
const toolbarLanguages = page => page.evaluate(() =>
  [...document.querySelectorAll("#language-switcher [data-profile-id]")].map(button => button.dataset.profileId));
const menuLanguages = page => page.evaluate(() =>
  [...(document.getElementById("settings-language-select")?.options ?? [])].map(option => option.value));

try {
  const [hostBuild, wideBuild, narrowBuild, olderBuild] = await Promise.all([
    extensionWith(scratch, "host", ["en", "ar"]),
    extensionWith(scratch, "wide", ["en", "ar"], [ESPERANTO]),
    extensionWith(scratch, "narrow", ["en"]),
    releasedExtension(scratch),
  ]);
  relay = await startRelay();

  const host = await launch("host", hostBuild);
  await host.importArchive(buildFixtureZip(), "hachidori-fixture.zip");
  const enabled = await sharing(host, "hd_sharing_host_enable", { port: PORT });
  if (enabled?.ok !== true) throw new Error(`sharing could not be enabled: ${JSON.stringify(enabled)}`);
  if (!await until(async () => (await status(host))?.connected === true)) throw new Error("the host did not reach the relay");

  const older = await launch("older", olderBuild);
  const wide = await launch("wide", wideBuild);
  let wideToolbar = null, wideSettings = null;

  await step(PLANNED[0], async () => {
    await link(older);
    await link(wide);
    const [olderRecords, wideRecords, wideProfiles] = await Promise.all([older.storage(["options", "dictionaryState"]),
      wide.storage(["options", "dictionaryState"]), profilesOf(wide)]);
    check(PLANNED[0], olderRecords.dictionaryState?.schemaVersion === 1 && wideRecords.dictionaryState?.schemaVersion === 1
      && !Object.hasOwn(wideRecords.options ?? {}, "profiles") && wideProfiles === undefined
      && (await status(wide)).client.host?.capabilities?.includes("language-profiles-v1") === false,
    JSON.stringify({ older: olderRecords.dictionaryState?.schemaVersion, wide: wideRecords.dictionaryState?.schemaVersion, wideProfiles }));
    wideToolbar = await wide.page("toolbar.html");
    wideSettings = await wide.page("settings.html#lookup");
    await wideSettings.waitForSelector("#settings-language-select", { timeout: 30_000 });
  });

  let olderBefore = null;
  await step(PLANNED[1], async () => {
    olderBefore = await older.storage(["options", "dictionaryState"]);
    const added = await engine(host, "hd_profile_add", { language: "en", copyFrom: "ja" });
    if (added?.ok !== true) throw new Error(`hd_profile_add en: ${JSON.stringify(added)}`);
    await host.importArchive(buildLanguageFixtureZip(ENGLISH), ENGLISH.file, "en");
    await host.importArchive(buildTitledZip(HAN_TITLE, { terms: [["食べる", "たべる", "v1", "v1", 100, [HAN_GLOSSARY], 1, ""]],
      indexOverrides: { sourceLanguage: "ja", targetLanguage: "en" } }), `${HAN_TITLE}.zip`, "en");
    for (const text of ["swim, , to move through water\n", "swim, , to move through water\ndive, , to go under water\n"]) {
      const document = (await worker(host, "hd_custom_read", { profileId: "en" })).document;
      const saved = await engine(host, "hd_custom_save", { profileId: "en", baseDocumentRevision: document.revision, text });
      if (saved?.ok !== true) throw new Error(`host English save: ${JSON.stringify(saved)}`);
    }
    const wideProfiles = await until(async () => {
      const value = await profilesOf(wide);
      return value?.optIn === "accepted" ? value : null;
    });
    const olderAfter = await until(async () => {
      const value = await older.storage(["options", "dictionaryState"]);
      return value.dictionaryState?.dictionaries?.some(entry => entry.title === HAN_TITLE) ? value : null;
    }) ?? {};
    const wideRecords = await until(async () => {
      const value = await wide.storage(["options", "dictionaryState"]);
      return value.dictionaryState?.dictionaries?.some(entry => entry.title === HAN_TITLE) ? value : null;
    }) ?? {};
    check(PLANNED[1], olderAfter.dictionaryState?.schemaVersion === 1 && !Object.hasOwn(olderAfter.options ?? {}, "profiles")
      && olderAfter.dictionaryState.dictionaries.find(entry => entry.title === HAN_TITLE)?.enabled === false
      && olderAfter.options.revision > olderBefore.options.revision
      && olderAfter.dictionaryState.revision > olderBefore.dictionaryState.revision
      && [...(wideProfiles?.hostLanguages ?? [])].sort().join() === "ar,en,ja"
      && languagesOf(wideRecords.options).join() === "ja,en" && wideRecords.dictionaryState?.schemaVersion === 2,
    JSON.stringify({ olderState: olderAfter.dictionaryState?.dictionaries?.map(entry => [entry.title, entry.enabled]),
      olderRevisions: [olderBefore.options?.revision, olderAfter.options?.revision], wideProfiles,
      wideLanguages: languagesOf(wideRecords.options) }));
  });

  await step(PLANNED[2], async () => {
    const toolbar = await until(async () => {
      const value = await toolbarLanguages(wideToolbar);
      return value.length === 2 ? value : null;
    }) ?? await toolbarLanguages(wideToolbar);
    const menu = await until(async () => {
      const value = await menuLanguages(wideSettings);
      return value.length === 2 ? value : null;
    }) ?? await menuLanguages(wideSettings);
    check(PLANNED[2], toolbar.join() === "ja,en" && menu.join() === "ja,en", JSON.stringify({ toolbar, menu }));
  });

  await step(PLANNED[3], async () => {
    const found = await lookup(older, "食べる");
    const han = (await host.storage(["dictionaryState"])).dictionaryState.dictionaries.find(entry => entry.title === HAN_TITLE);
    const removal = await engine(older, "hd_remove", { id: han.id, title: HAN_TITLE });
    const kept = (await host.storage(["dictionaryState"])).dictionaryState.dictionaries.some(entry => entry.id === han.id);
    check(PLANNED[3], glossaries(found).includes("to eat") && !glossaries(found).includes(HAN_GLOSSARY)
      && removal?.ok === false && removal.error === "This dictionary is used by English on the linked Hachidori. Remove it there."
      && kept, JSON.stringify({ found: glossaries(found).slice(0, 300), removal, kept }));
  });

  const narrow = await launch("narrow", narrowBuild);
  let narrowSettings = null;
  await step(PLANNED[4], async () => {
    const toolbar = await narrow.page("toolbar.html");
    const before = await toolbarLanguages(toolbar);
    await link(narrow);
    const accepted = await until(async () => (await profilesOf(narrow))?.optIn === "accepted");
    const after = await until(async () => {
      const value = await toolbarLanguages(toolbar);
      return value.length === 2 ? value : null;
    }) ?? await toolbarLanguages(toolbar);
    narrowSettings = await narrow.page("settings.html#lookup");
    await narrowSettings.waitForSelector("#settings-language-select", { timeout: 30_000 });
    const menu = await until(async () => {
      const value = await menuLanguages(narrowSettings);
      return value.length === 2 ? value : null;
    }) ?? await menuLanguages(narrowSettings);
    check(PLANNED[4], before.length === 0 && accepted && after.join() === "ja,en" && menu.join() === "ja,en",
      JSON.stringify({ before, accepted, after, menu }));
  });

  await step(PLANNED[5], async () => {
    // Every storage event and every Language menu this page ever shows.
    await narrowSettings.evaluate(() => {
      window.arabicSeen = [];
      chrome.storage.onChanged.addListener(changes => {
        for (const [key, change] of Object.entries(changes)) {
          if (JSON.stringify(change.newValue ?? null).includes('"language":"ar"')) window.arabicSeen.push(key);
        }
      });
      new MutationObserver(() => {
        if ([...document.querySelectorAll("#settings-language-select option")].some(option => option.value === "ar")) {
          window.arabicSeen.push("menu");
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    const revision = (await narrow.storage(["options"])).options.revision;
    // A write from this browser's page, in flight while the host adds Arabic.
    const writing = narrowSettings.evaluate(base => chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      requestId: "write-across-add", baseRevision: base, profileId: "en", options: { scanLength: 22 } }), revision);
    const added = await engine(host, "hd_profile_add", { language: "ar", copyFrom: "ja" });
    const written = await writing;
    const refused = await until(async () => {
      const value = await profilesOf(narrow);
      return value?.optIn === "refused" ? value : null;
    });
    await wait(1000);
    const stored = await narrow.storage(["options", "dictionaryState"]);
    const seen = await narrowSettings.evaluate(() => window.arabicSeen);
    const japanese = await lookup(narrow, "食べたかった");
    check(PLANNED[5], added?.ok === true && refused?.missingLanguages?.join() === "ar"
      && !JSON.stringify(written ?? null).includes('"language":"ar"') && seen.length === 0
      && !Object.hasOwn(stored.options ?? {}, "profiles") && stored.dictionaryState?.schemaVersion === 1
      && glossaries(japanese).includes("食べる"),
    JSON.stringify({ added: added?.ok, written: { ok: written?.ok, error: written?.error }, refused, seen,
      options: Object.keys(stored.options ?? {}).includes("profiles"), japanese: glossaries(japanese).slice(0, 120) }));
  });

  await step(PLANNED[6], async () => {
    await narrowSettings.evaluate(() => { location.hash = "#sharing"; });
    const text = await until(async () => {
      const value = await narrowSettings.evaluate(() => document.getElementById("sharing-status")?.textContent ?? "");
      return /Update Hachidori in this browser/u.test(value) ? value : null;
    }) ?? await narrowSettings.evaluate(() => document.getElementById("sharing-status")?.textContent ?? "");
    check(PLANNED[6], /^Using the Hachidori in .+\. Update Hachidori in this browser to use Arabic from .+\.$/u.test(text), text);
  });

  await step(PLANNED[7], async () => {
    const reply = await engine(wide, "hd_profile_add", { language: "eo", copyFrom: "ja" });
    const hostLanguages = languagesOf((await host.storage(["options"])).options);
    check(PLANNED[7], reply?.ok === false && reply.error === "The linked Hachidori does not have Esperanto. Update it and try again."
      && !hostLanguages.includes("eo"), JSON.stringify({ reply, hostLanguages }));
  });

  await step(PLANNED[8], async () => {
    const counted = await worker(host, "hd_lookup_stats_record", { term: "\u0643\u062A\u0627\u0628", reading: "", profileId: "ar" });
    const removed = await engine(host, "hd_profile_remove", { profileId: "ar" });
    await wait(1500);
    const stillRefused = await profilesOf(narrow);
    const erased = await engine(host, "hd_profile_remove", { language: "ar", erase: true, baseDocumentRevision: 0 });
    const accepted = await until(async () => {
      const value = await profilesOf(narrow);
      return value?.optIn === "accepted" ? value : null;
    });
    const stored = await until(async () => {
      const value = await narrow.storage(["options"]);
      return value.options?.profiles?.length === 2 ? value : null;
    }) ?? {};
    check(PLANNED[8], counted?.ok === true && removed?.ok === true && stillRefused?.optIn === "refused"
      && stillRefused.missingLanguages?.join() === "ar" && erased?.ok === true && Boolean(accepted)
      && languagesOf(stored.options).join() === "ja,en",
    JSON.stringify({ counted: counted?.ok, removed, stillRefused, erased, accepted, languages: languagesOf(stored.options) }));
  });

  await step(PLANNED[9], async () => {
    const own = await launch("own", hostBuild);
    const added = await engine(own, "hd_profile_add", { language: "en", copyFrom: "ja" });
    if (added?.ok !== true) throw new Error(`own English: ${JSON.stringify(added)}`);
    const saved = await engine(own, "hd_custom_save", { profileId: "en", baseDocumentRevision: 0, text: "float, , to rest on water\n" });
    if (saved?.ok !== true) throw new Error(`own English save: ${JSON.stringify(saved)}`);
    for (let count = 0; count < 3; count += 1) await worker(own, "hd_lookup_stats_record", { term: "run", reading: "", profileId: "en" });
    const selection = await worker(own, "hd_language_selection_write", { baseRevision: 0, activeProfileId: "en" });
    await link(own);
    await until(async () => (await profilesOf(own))?.optIn === "accepted");
    const mirrored = await until(async () => {
      const value = await own.storage(["customDictionarySource"]);
      return value.customDictionarySource?.languages?.en?.text?.startsWith("swim") ? value : null;
    }) ?? {};
    const unlinked = await sharing(own, "hd_sharing_client_unlink");
    const stored = await own.storage(["customDictionarySource", "lookupStats", "languageSelection", "options"]);
    const count = await worker(own, "hd_lookup_stats_read", { term: "run", reading: "", profileId: "en" });
    const mirrorRevision = mirrored.customDictionarySource?.languages?.en?.revision ?? -1;
    check(PLANNED[9], unlinked?.ok === true && count?.statistics?.lookupCount === 3
      && stored.customDictionarySource?.languages?.en?.text === "float, , to rest on water\n"
      && stored.customDictionarySource.languages.en.revision === Math.max(1, mirrorRevision) + 1
      && stored.languageSelection?.activeProfileId === "en" && stored.languageSelection.revision > selection?.selection?.revision
      && languagesOf(stored.options).join() === "ja,en",
    JSON.stringify({ unlinked: unlinked?.ok, count: count?.statistics, mirrorRevision, document: stored.customDictionarySource?.languages,
      selection: stored.languageSelection }));
  });

  await step(PLANNED[10], async () => {
    const removed = await engine(host, "hd_profile_remove", { profileId: "ja" });
    if (removed?.ok !== true) throw new Error(`removing Japanese: ${JSON.stringify(removed)}`);
    const view = await until(async () => {
      const value = await older.storage(["options", "dictionaryState"]);
      return value.dictionaryState?.dictionaries?.every(entry => entry.enabled === false) ? value : null;
    }) ?? {};
    const found = await lookup(older, "食べる");
    const profileWrite = await worker(older, "hd_options_write", { baseRevision: view.options?.revision, options: { scanLength: 9 } });
    const globalWrite = await worker(older, "hd_options_write", { baseRevision: view.options?.revision, options: { hoverEnabled: false } });
    const hostOptions = (await host.storage(["options"])).options;
    check(PLANNED[10], found?.ok === true && (found.results ?? []).length === 0
      && profileWrite?.ok === false && profileWrite.error === NO_JAPANESE
      && globalWrite?.ok === true && hostOptions.hoverEnabled === false && languagesOf(hostOptions).join() === "en",
    JSON.stringify({ found: found?.results?.length, profileWrite, globalWrite: { ok: globalWrite?.ok, error: globalWrite?.error },
      languages: languagesOf(hostOptions) }));
  });
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  await relay?.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}

const failed = PLANNED.filter(name => results.get(name)?.ok !== true);
for (const name of PLANNED.filter(planned => !results.has(planned))) console.log(`FAIL  ${name}\n      check never ran`);
if (errors.length > 0) console.log(`page errors:\n  ${errors.join("\n  ")}`);
console.log(`\n${PLANNED.length - failed.length}/${PLANNED.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
