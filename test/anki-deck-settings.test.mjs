// SPDX-License-Identifier: GPL-3.0-or-later
//
// The popup's Anki button for a Template that names no deck (docs/languages.md
// 6.3, the lead's answer to anki-audio 8): the mining service marks that
// availability, the button stays titled "Choose an available deck." and its
// click opens Settings → Anki on the profile in effect; every other state is
// today's. The worker opens the page and Settings starts on the profile its
// address names.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import "../extension/reader-options.js";
import "../extension/anki-content.js";
import { createAnkiMiningService } from "../extension/anki-mining.js";
import { contentNoteStage, createHarness } from "./extension-smoke/content-harness.mjs";
import { loadBackgroundScript, makeAlarms, makeBus, makeChrome, makeStorage } from "./extension-smoke/fakes.mjs";
import { openSettings, settle } from "./language-settings-harness.mjs";

const profileState = await import("../extension/profile-state.js");
const { profileTemplateKey } = await import("../extension/anki-worker.js");

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));
const reader = globalThis.HDReaderOptions;
const tick = () => new Promise(resolveTick => setImmediate(resolveTick));
async function until(predicate) {
  for (let n = 0; n < 100 && !predicate(); n++) await tick();
  assert.ok(predicate(), "the Anki controls did not settle");
}

// What the worker's mining service answers for a Template with `patch`, from
// an AnkiConnect that has the deck "Default" and the note type Basic.
async function statusFor(patch) {
  const anki = reader.normaliseOptions({}).anki;
  const config = { ...anki, model: "Basic", fields: { ...anki.fields, expression: "Front", definition: "Back" }, ...patch };
  const service = createAnkiMiningService({
    gateway: { discover: async () => ({ connected: true, model: config.model, decks: ["Default"], models: ["Basic"],
      fields: ["Front", "Back"], errors: [] }) },
    readConfig: async () => config, duplicateIndex: null, buildFields: null, beforeWrite: null, enrich: null,
  });
  return service.status("default");
}

// A popup with one entry's actions, a custom Anki button on the same
// Template, and the reader's Anki controller answered by `status` (read on
// each request) for a Template whose deck is `deck`. `canOpenSettings: false`
// is a page that cannot open Settings.
function popup(t, status, { deck = "", canOpenSettings = true } = {}) {
  const dom = new JSDOM("<!doctype html><body><section></section></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const calls = [];
  const opened = [];
  const openSettings = canOpenSettings ? () => opened.push("settings") : null;
  const send = async (type, fields = {}) => {
    calls.push(type);
    if (type === "hd_anki_view") {
      return { state: "unknown", canAdd: false, noteIds: [], configKey: status.configKey, cached: false };
    }
    if (type === "hd_anki_status") return status;
    if (type === "hd_anki_preflight_batch") return { replies: fields.requests.map(() => ({ state: "addable", canAdd: true })) };
    if (type === "hd_anki_submit") return { state: "added", noteId: 7 };
    throw new Error(`unexpected ${type}`);
  };
  const controller = globalThis.HDAnki.createAnkiController({ send, onChange() {}, openSettings });
  const actions = document.createElement("div");
  actions.className = "gsm-hoshidicts-entry-actions";
  const custom = document.createElement("button");
  custom.className = "gsm-hoshidicts-custom-anki-button";
  custom.dataset.customButtonId = "c1";
  actions.append(custom);
  const feedback = document.createElement("div");
  feedback.hidden = true;
  const section = document.querySelector("section");
  section.append(actions, feedback);
  const options = { ...reader.DEFAULT_OPTIONS, anki: { ...reader.DEFAULT_OPTIONS.anki, model: "Basic", deck },
    customButtons: [{ id: "c1", type: "anki", label: "Mine", templateId: "default" }] };
  controller.update(options);
  controller.bind([{ actions, feedback, result: { term: { expression: "كتاب", reading: "كتاب" } } }],
    { owner: {}, popup: section, request: {}, isCurrent: () => true, getRequest: result => ({ term: result.term }) });
  const button = () => actions.querySelector(".gsm-hoshidicts-mine-button");
  const state = element => ({ hidden: element.hidden, disabled: element.disabled, state: element.dataset.state ?? null,
    title: element.title, label: element.getAttribute("aria-label") });
  return { calls, opened, controller, options, button, custom, feedback, state,
    async settled() {
      await until(() => calls.includes("hd_anki_status") && custom.dataset.state !== "checking");
      await tick();
    } };
}

test("only a Template that names no deck, and has nothing else wrong, is the empty-deck case", async () => {
  assert.deepEqual(await statusFor({ deck: "" }),
    { available: false, configKey: (await statusFor({ deck: "" })).configKey, error: "Choose an available deck.", emptyDeck: true });
  for (const [patch, error] of [
    [{ deck: "Gone" }, "Anki has no deck named “Gone”. Choose an available deck."],
    [{ deck: "", model: "Lapis" }, "Choose an available deck.\nAnki has no note type named “Lapis”. Choose an available note type."],
    [{ deck: "", model: "" }, "Choose an Anki note type in Settings."],
  ]) {
    const status = await statusFor(patch);
    assert.equal(status.error, error);
    assert.equal(Object.hasOwn(status, "emptyDeck"), false, error);
  }
  assert.equal(Object.hasOwn(await statusFor({ deck: "Default" }), "emptyDeck"), false);
});

test("the Anki button of a Template without a deck says so and opens Settings → Anki", async t => {
  const f = popup(t, await statusFor({ deck: "" }));
  await f.settled();
  const expected = { hidden: false, disabled: false, state: "unavailable", title: "Choose an available deck.",
    label: "Choose an available deck." };
  assert.deepEqual(f.state(f.button()), expected, "the primary button shows instead of hiding");
  assert.deepEqual(f.state(f.custom), expected, "a custom Anki button on the Template");
  assert.equal(f.feedback.hidden, false, "the custom button keeps today's status line");
  const { MouseEvent } = f.button().ownerDocument.defaultView;
  f.button().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  f.button().click();
  f.custom.click();
  await tick();
  assert.deepEqual(f.opened, ["settings", "settings"]);
  assert.ok(!f.calls.some(type => ["hd_anki_preflight", "hd_anki_preflight_batch", "hd_anki_submit"].includes(type)),
    JSON.stringify(f.calls));
});

test("after a deck is chosen the button adds notes again", async t => {
  let status = await statusFor({ deck: "" });
  const f = popup(t, { get available() { return status.available; }, get configKey() { return status.configKey; },
    get error() { return status.error; }, get emptyDeck() { return status.emptyDeck; } });
  await f.settled();
  assert.equal(f.button().dataset.state, "unavailable");
  status = await statusFor({ deck: "Default" });
  f.controller.update({ ...f.options, anki: { ...f.options.anki, deck: "Default" } });
  await until(() => f.button().dataset.state === "ready");
  f.button().click();
  await until(() => f.calls.includes("hd_anki_submit"));
  assert.deepEqual(f.opened, []);
});

test("every other unavailable Template behaves as today", async t => {
  for (const patch of [{ deck: "Gone" }, { deck: "", model: "Lapis" }]) {
    const status = await statusFor(patch);
    const f = popup(t, status, { deck: patch.deck });
    await f.settled();
    assert.equal(f.button().hidden, true, `${status.error}: the primary button hides`);
    assert.deepEqual(f.state(f.custom), { hidden: false, disabled: true, state: "unavailable", title: status.error,
      label: status.error }, `${status.error}: a custom button is disabled`);
    f.custom.click();
    await tick();
    assert.deepEqual(f.opened, []);
  }
  // A page that cannot open Settings (an overlay) keeps today's button too.
  const f = popup(t, await statusFor({ deck: "" }), { canOpenSettings: false });
  await f.settled();
  assert.equal(f.button().hidden, true);
  assert.equal(f.custom.disabled, true);
});

// content.js itself: the popup's Anki button, answered as the worker answers
// a Template without a deck, asks the worker for Settings → Anki on the
// profile in effect (none in the single-profile shape).
test("content.js asks the worker for Settings → Anki on the popup's profile", async () => {
  const anki = { model: "Basic", deck: "" };
  // With profiles each profile holds its Templates.
  const templates = reader.normaliseAnki({ ...reader.DEFAULT_OPTIONS.anki, ...anki }).templates;
  const opened = await contentNoteStage({
    async single() { return settingsRequest(Object.assign(await createHarness(undefined, { options: { anki } }), { single: true })); },
    async profiles() {
      return settingsRequest(await createHarness(undefined, { options: { profiles: [
        { id: "ja", language: "ja", settings: { anki: { templates } }, packSettings: {} },
        { id: "ar", language: "ar", settings: {}, packSettings: {} },
      ] } }));
    },
  });
  if (opened === null) return;
  // Without profiles the worker sends no empty-deck hint (background-anki.js),
  // and the reader ignores one: the button stays hidden, as today.
  assert.equal(opened.single, null);
  // A lookup that names no profile uses the Japanese profile (section 5.2).
  assert.deepEqual(opened.profiles, { target: "hoshidicts-worker", type: "hd_open_settings", section: "anki", profileId: "ja" });
});

// The content script's requests settle across timers, not only microtasks.
async function eventually(predicate) {
  for (let n = 0; n < 400 && !predicate(); n++) await new Promise(resolveWait => setTimeout(resolveWait, 5));
  assert.ok(predicate(), "the content script did not settle");
}

async function settingsRequest(harness) {
  try {
    await harness.initialLookup();
    const { document, MouseEvent } = harness.anchor.ownerDocument.defaultView;
    const actions = document.createElement("div");
    actions.className = "gsm-hoshidicts-entry-actions";
    const feedback = document.createElement("div");
    harness.callbacks().popup.append(actions, feedback);
    harness.callbacks().onResultsRendered({ audioButtons: [], miningActions: [{ actions, feedback,
      result: harness.term("食べる") }] });
    const answer = async (type, payload) => {
      await eventually(() => harness.pending.some(({ request }) => request.type === type));
      harness.reply(harness.take(type), payload);
    };
    await answer("hd_anki_view", { state: "unknown", canAdd: false, noteIds: [], configKey: "k", cached: false });
    await answer("hd_anki_status", { available: false, configKey: "k", error: "Choose an available deck.", emptyDeck: true });
    const button = actions.querySelector(".gsm-hoshidicts-mine-button");
    if (harness.single) {
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      assert.ok(button === null || button.hidden, "a single-profile popup shows no empty-deck button");
      return harness.sent.find(sent => sent.type === "hd_open_settings") ?? null;
    }
    await eventually(() => button.dataset.state === "unavailable" && !button.disabled && !button.hidden);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await eventually(() => harness.sent.some(request => request.type === "hd_open_settings"));
    const { requestId, ...request } = harness.sent.find(sent => sent.type === "hd_open_settings");
    assert.match(requestId, /^open_settings-\d+$/u);
    assert.ok(!harness.sent.some(sent => ["hd_anki_preflight_batch", "hd_anki_submit"].includes(sent.type)));
    return request;
  } finally {
    harness.close();
  }
}

// The service worker on `records`, as profiles.test.mjs runs it, with the
// tabs it opens.
function worker(records = {}) {
  const bus = makeBus();
  const storage = makeStorage();
  for (const [key, value] of Object.entries(records)) storage.raw.set(key, structuredClone(value));
  const alarms = makeAlarms();
  const chrome = makeChrome("sw", bus, storage, alarms);
  const tabs = [];
  chrome.tabs = { async create(properties) { tabs.push(properties); return { id: tabs.length }; } };
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  loadBackgroundScript({ chrome, console: quiet, Promise, Error, TypeError, JSON, URL, Map, Set,
    setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
    ...Object.fromEntries(Object.entries(profileState).filter(([, value]) => typeof value === "function")),
    profileTemplateKey });
  const page = makeChrome("page", bus, storage, alarms);
  return { tabs, send: message => page.runtime.sendMessage({ target: "hoshidicts-worker", ...message }) };
}

test("the worker opens Settings → Anki on the profile the popup names", async () => {
  const { tabs, send } = worker();
  let reply = await send({ type: "hd_open_settings", section: "anki", profileId: "ar" });
  assert.equal(reply.ok, true, reply.error);
  reply = await send({ type: "hd_open_settings", section: "anki" });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(tabs.map(tab => tab.url.replace(/^.*\//u, "")), ["settings.html?profile=ar#anki", "settings.html#anki"]);
  for (const message of [{ section: "lookup" }, { section: "anki", profileId: "" }, { section: "anki", profileId: 3 }]) {
    reply = await send({ type: "hd_open_settings", ...message });
    assert.equal(reply.ok, false, JSON.stringify(message));
  }
  assert.equal(tabs.length, 2);
});

test("Settings opened for a profile edits that profile; an unknown one leaves the active profile", async t => {
  const stored = {
    options: { revision: 3, profiles: [
      { id: "ja", language: "ja", settings: {}, packSettings: {} },
      { id: "en", language: "en", settings: {}, packSettings: {} },
    ] },
    languageSelection: { revision: 1, activeProfileId: "ja", autoSwitch: false },
  };
  // This harness has no Anki section, so the address names Reading; the
  // profile does not depend on the section.
  for (const [hash, edited] of [["?profile=en#lookup", "en"], ["?profile=xx#lookup", "ja"], ["#lookup", "ja"]]) {
    const settings = openSettings(t, { hash, stored });
    await settings.page.start();
    await settle();
    assert.equal(settings.el("settings-language-select").value, edited, hash);
  }
});
