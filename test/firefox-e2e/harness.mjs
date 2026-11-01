/*
 * The real-Firefox suite's checks on node:test.
 *
 * As in the Chrome suite (test/chrome-e2e/harness.mjs), every assertion has a
 * fixed name declared up front in PLANNED: the denominator is that list, not
 * the number of checks that happened to run. A check that never ran fails the
 * complete run. Each step is one node:test test, run in order in one Firefox
 * profile, and fails once any of its checks has failed.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { rmSync } from "node:fs";
import { test as nodeTest } from "node:test";

let current = null;
let completeSuite = false;
const steps = [];

const NAME_FILTERED = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/u)]
  .some(argument => /^--test-(?:name-pattern|skip-pattern|only)\b/u.test(argument));

// The entry file names its plan; until it does, every check is refused.
let PLANNED = [];

function markCompleteSuite(planned) {
  PLANNED = planned;
  completeSuite = true;
}

function completeRun() {
  return completeSuite && !NAME_FILTERED;
}

// One step of the scenario. Steps share one browser and run in order; when a
// name pattern leaves out earlier steps, the selected step runs them first.
function step(name, body) {
  const entry = { name, body, ran: false, failures: [], error: null };
  const index = steps.push(entry) - 1;
  nodeTest(name, async () => {
    for (const earlier of steps.slice(0, index)) {
      if (!earlier.ran) {
        console.log(`first the earlier step "${earlier.name}"`);
        await run(earlier);
      }
    }
    await run(entry);
    if (entry.error) throw entry.error;
    if (entry.failures.length) throw new Error(`failed checks: ${entry.failures.join("; ")}`);
  });
}

async function run(entry) {
  if (entry.ran) return;
  entry.ran = true;
  current = entry;
  try {
    await entry.body();
  } catch (error) {
    entry.error = error;
    console.log(`FAIL ${entry.name} finished without throwing\n       ${error?.stack ?? error}`);
  } finally {
    current = null;
  }
}

const E2E_PLANNED = [
  // session
  "Firefox installs the Firefox build with its gecko ID",
  "the background page runs background.js and holds the engine, with no offscreen document",
  "the engine runs single-threaded on IndexedDB in Firefox",
  "a first install opens one startup page",
  // first run
  "Start setup downloads and installs the five recommended dictionaries in the background page",
  "a download that fails is retried by Retry missing dictionaries",
  "the Anki step reports Anki as not connected and setup reaches practice",
  "the practice step looks up its word with the installed dictionaries",
  "Finish completes setup and Settings no longer offers Resume setup",
  "Remove all imported dictionaries empties the library",
  // import
  "settings page exposes a .zip file input",
  "importing a Yomitan .zip from the settings page succeeds",
  "the imported dictionary is recorded in chrome.storage.local",
  "the imported dictionary is persisted in IndexedDB",
  "a batch of archives imports in one selection",
  "re-importing an installed dictionary replaces its generation",
  "a malformed archive fails with its reason and leaves the library unchanged",
  // library
  "an alias renames the dictionary in Settings",
  "disabling a dictionary keeps its row and removes its results from lookups",
  "a dictionary group is saved with its member",
  // reader
  "hovering 食べたかった with Shift shows a popup",
  "the popup shows the deinflected headword 食べる with its furigana",
  "the extension's highlight marks the source word",
  "the popup shows the fixture's frequency and pitch accents",
  "hovering 漢字 shows its structured content: bold span, list and table",
  "a structured-content image resolves through hd_media to a data: URL",
  "the popup is showing immediately before the non-Japanese hover",
  "hovering non-Japanese text shows no popup",
  "the same hover shows a popup again after the non-Japanese one",
  "Escape hides the popup and clears the highlight",
  "a page loaded in a frame gets its own reader",
  "hovering a word in the definitions opens a nested popup",
  "clicking a headword kanji opens its kanji entry and Back returns to the word",
  "an Alt+ArrowDown keybind moves to the next entry",
  "selecting text with Shift held looks up exactly the selection",
  "lookup counts are recorded and shown in the popup",
  "definition blur hides definitions for a word looked up enough times and a click reveals them",
  "each bundled popup theme renders the lookup",
  "custom popup CSS applies to the popup",
  "the toolbar switch turns lookups off and on",
  // notes
  "the Note form appends a personal entry and the popup shows it",
  // settings
  "Settings autosaves a Reading option and the reader follows it",
  "the Design preview renders its sample popup",
  "Keybinds list Yomitan's default keybinds",
  "browser shortcuts list Firefox's commands and open Firefox's shortcut manager",
  "Custom JavaScript runs on pages once Firefox grants user scripts",
  "Get debug info reports Firefox and its IndexedDB engine",
  // audio and Anki
  "pronunciation audio plays from a URL source",
  "Anki settings list AnkiConnect's decks and note types",
  "Add to Anki creates a note with the configured fields and a page screenshot",
  "the added note turns the button into View in Anki",
  "word highlighting marks words by their Anki status",
  // updates
  "Check now records an available update from the dictionary's update index",
  "Update installs the newer revision",
  // backups
  "Export backup asks where to save the backup and Firefox saves the ZIP there",
  "a backup exported by Hachidori 0.1.1 for Chrome restores in Firefox",
  "a backup exported by Hachidori 0.3.0 for Chrome restores in Firefox",
  "the restored library answers lookups and shows the personal entry",
  "the Firefox backup restores into a fresh Firefox profile",
  // sharing
  "Settings downloads the pinned Hachidori Relay add-on",
  "the Firefox Hachidori shares through the relay",
  "a second Firefox links to it and looks up words with its dictionaries",
  // idle and restart
  "the engine keeps its dictionaries through Firefox's 30-second idle limit",
  "dictionaries, settings and counts survive a Firefox restart",
  "lookups work after the restart without re-importing",
  "removing a dictionary deletes its IndexedDB files and its lookups",
  // local files
  "Settings says where Firefox's local-file switch is",
  "turning on Access local files in about:addons lets the reader run on file: pages",
];

const results = [];
let failed = 0;
const diagnostics = [];
let profiles = [];

function check(name, ok, detail = "") {
  if (!PLANNED.includes(name)) fatal(`check("${name}") is not in PLANNED`);
  if (results.some(result => result.name === name)) fatal(`check("${name}") ran twice`);
  results.push({ name, ok, detail });
  if (!ok) {
    failed += 1;
    current?.failures.push(name);
  }
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? `\n       ${detail}` : ""}`);
}

function fatal(message) {
  console.error(`\nfatal: ${message}`);
  process.exit(1);
}

function keepProfiles(...paths) {
  profiles = [...new Set([...profiles, ...paths])];
}

function report(exit = true) {
  for (const name of completeRun() ? PLANNED : []) {
    if (!results.some(result => result.name === name)) {
      results.push({ name, ok: false, detail: "check never ran" });
      failed += 1;
      console.log(`FAIL ${name}\n       check never ran`);
    }
  }
  console.log(`\n${results.length - failed}/${completeRun() ? PLANNED.length : results.length} checks passed`);
  if (failed) {
    console.log(`profiles kept for inspection: ${profiles.join(", ")}`);
    console.log("\nfailures:");
    for (const result of results.filter(entry => !entry.ok)) {
      console.log(`  - ${result.name}${result.detail ? `\n      ${result.detail}` : ""}`);
    }
    if (diagnostics.length) {
      console.log("\nbrowser diagnostics (last 60):");
      for (const line of diagnostics.slice(-60)) console.log(`  ${line}`);
    }
  } else if (!process.env.HACHIDORI_FIREFOX_PROFILE) {
    for (const path of profiles) rmSync(path, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
  if (exit) process.exit(failed ? 1 : 0);
}

export { check, diagnostics, E2E_PLANNED, fatal, keepProfiles, markCompleteSuite, report, step };
