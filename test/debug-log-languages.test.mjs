// SPDX-License-Identifier: GPL-3.0-or-later
//
// Debug-log redaction of the other profiles' languages (docs/languages.md
// 8.5): a context that adopts an options record with profiles tells its log
// their languages, and text in a pack's non-Latin scripts becomes `[code]`.
// A Japanese-only installation's log is today's, byte for byte.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { DEBUG_LOG, redactDebugText, setDebugLogLanguages } from "../extension/debug-log.js";
import { fixtureLanguageFiles } from "./chrome-languages/builds.mjs";
import { loadBackgroundScript, makeAlarms, makeBus, makeChrome, makeStorage } from "./extension-smoke/fakes.mjs";
import { openSettings, settle } from "./language-settings-harness.mjs";

const profileState = await import("../extension/profile-state.js");
const { profileTemplateKey } = await import("../extension/anki-worker.js");

// A registry.js of Japanese and the English and Arabic fixture packs of
// test/data/languages/, whatever packs the build ships.
const scratch = mkdtempSync(join(tmpdir(), "hachidori-debug-log-languages-"));
const files = await fixtureLanguageFiles(scratch, "debug-log", ["en", "ar"])
  .finally(() => rmSync(scratch, { recursive: true, force: true }));
const vendored = {};
vm.runInNewContext(files.get("registry.js"), vendored);
globalThis.HDLanguages = vendored.HDLanguages;

const SAMPLE = "no entry for 食べたかった or الكتاب (running) at https://example.com/a?q=1";
const TODAY = "no entry for [ja] or الكتاب (running) at https://example.com/a?[redacted]";
const ARABIC = "الكتاب";

const PROFILES = {
  options: { revision: 3, profiles: [
    { id: "ja", language: "ja", settings: {}, packSettings: {} },
    { id: "en", language: "en", settings: {}, packSettings: {} },
    { id: "ar", language: "ar", settings: {}, packSettings: {} },
  ] },
  languageSelection: { revision: 1, activeProfileId: "ar", autoSwitch: false },
};

// The service worker on `records`, as profiles.test.mjs runs it; resolves
// with the message its log keeps for a request it cannot answer.
async function workerFailure(records, type) {
  const bus = makeBus();
  const storage = makeStorage();
  for (const [key, value] of Object.entries(records)) storage.raw.set(key, structuredClone(value));
  const alarms = makeAlarms();
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const context = loadBackgroundScript({
    chrome: makeChrome("sw", bus, storage, alarms), console: quiet, Promise, Error, TypeError, JSON, URL, Map, Set,
    setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
    HDLanguages: vendored.HDLanguages,
    ...Object.fromEntries(Object.entries(profileState).filter(([, value]) => typeof value === "function")),
    profileTemplateKey,
  });
  await settle();
  const reply = await makeChrome("page", bus, storage, alarms).runtime.sendMessage({ target: "hoshidicts-worker", type });
  assert.equal(reply.ok, false);
  // The context's global keeps its symbol-keyed properties to itself.
  const log = vm.runInContext("globalThis", context)[DEBUG_LOG];
  return log.entries().findLast(entry => entry.level === "failed-request").message;
}

test("a Japanese-only installation's debug log is today's, byte for byte", async () => {
  assert.equal(redactDebugText(SAMPLE), TODAY);
  for (const codes of [[], ["ja"]]) {
    setDebugLogLanguages(codes);
    assert.equal(redactDebugText(SAMPLE), TODAY, JSON.stringify(codes));
  }
  assert.equal(await workerFailure({ options: { revision: 1 } }, ARABIC),
    `${ARABIC}: unknown worker request type "${ARABIC}"`, "the worker of a single-profile installation");
});

test("text in an Arabic profile's script is redacted as [ar] where the options record is adopted", async t => {
  setDebugLogLanguages(["ja", "en", "ar"]);
  // English is written in Latin, as the log is, so only Arabic text changes.
  assert.equal(redactDebugText(SAMPLE), "no entry for [ja] or [ar] (running) at https://example.com/a?[redacted]");
  setDebugLogLanguages([]);
  assert.equal(redactDebugText(SAMPLE), TODAY, "without the profiles the log is today's again");

  assert.equal(await workerFailure(PROFILES, ARABIC), `[ar]: unknown worker request type "[ar]"`, "the service worker");
  const settings = openSettings(t, { hash: "#lookup", stored: PROFILES });
  await settings.page.start();
  await settle();
  const log = settings.window[DEBUG_LOG];
  assert.equal(log.record("warn", `no entry for ${ARABIC}`).message, "no entry for [ar]", "Settings");
});
