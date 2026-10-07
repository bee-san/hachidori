/*
 * Anki: first-run detection, the worker's Anki routes, word status and screenshots.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { ANKI_INDEX_KEY } from "../../extension/anki-index-cache.js";
import { captureNetflixPreview } from "../../extension/netflix-preview.js";
import { answerAnkiConnect } from "../anki-connect-fake.mjs";
import {
  existingOffscreenStage,
  EXTENSION,
  EXTENSION_ORIGIN,
  FakeSharingSocket,
  loadBackgroundScript,
  loadJsdom,
  loadSettingsScript,
  makeBus,
  makeChrome,
  makeStorage,
  settleSharing,
  shareWithLinkedReader,
} from "./fakes.mjs";
import { check, test } from "./harness.mjs";

// First-run Anki detection: read-only calls through the gateway, the
// revisioned options write for a recognised setup, one durable outcome.
async function firstRunAnkiStage() {
  const KIKU_FIELDS = ["Expression", "ExpressionFurigana", "ExpressionReading", "ExpressionAudio", "SelectionText", "MainDefinition",
    "Glossary", "Sentence", "SentenceFurigana", "SentenceAudio", "PitchPosition", "PitchCategories", "Frequency", "FreqSort", "MiscInfo", "Picture"];
  const setupRecord = (patch = {}) => ({ schemaVersion: 1, revision: 4, startedAt: "2026-09-07T10:00:00.000Z", stage: "anki", completedAt: null,
    dictionaries: { outcomes: {}, totalSeconds: null, continued: false, selectionsApplied: [], recordedRuns: [] }, anki: null, ...patch });
  const defaultAnki = () => globalThis.HDReaderOptions.normaliseOptions({}).anki;
  // A usable saved mapping: a note type, a deck and a mapped first field. Choosing
  // only a note type in Settings leaves the fields blank, which is not one.
  const configuredAnki = (model, deck) => ({ ...defaultAnki(), model, deck,
    fields: { ...defaultAnki().fields, expression: "Front" } });
  function worldFor(name, { answer, options = null, setup = setupRecord(), localAudio = false, sharing = null }) {
    const bus = makeBus();
    const storage = makeStorage();
    const chrome = makeChrome(`${name}-worker`, bus, storage);
    const requests = [];
    const held = [];
    const audioRequests = [];
    const audioHeld = [];
    if (sharing !== null) storage.raw.set("sharing", structuredClone(sharing));
    loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, AbortController, URL, Promise, Error,
      fetch(url, init) {
        if (url.startsWith("http://127.0.0.1:5050/")) {
          audioRequests.push({ url, init });
          if (localAudio === false) return Promise.reject(new TypeError("Failed to fetch"));
          const value = { type: "audioSourceList", audioSources: [] };
          if (localAudio === "hold" && audioRequests.length === 1) {
            return new Promise(resolve => audioHeld.push(() => resolve({ ok: true, async json() { return value; } })));
          }
          return Promise.resolve({ ok: true, async json() { return value; } });
        }
        const body = JSON.parse(init.body);
        requests.push({ url, action: body.action, params: body.params, key: body.key ?? null });
        const result = answer(body.action, body.params, requests.length);
        if (result === "hold") {
          return new Promise((resolve) => held.push(() => resolve({ ok: true, async json() { return { result: answer(body.action, body.params, 0), error: null }; } })));
        }
        if (result instanceof Error) return Promise.reject(result);
        if (result?.status) return Promise.resolve({ ok: false, status: result.status });
        return Promise.resolve({ ok: true, async json() { return { result, error: null }; } });
      } });
    storage.raw.set("setupState", structuredClone(setup));
    if (options) storage.raw.set("options", structuredClone(options));
    const send = (fields = {}, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("startup.html") }) => bus.sendMessage(
      "startup-page", { target: "hoshidicts-worker", type: "hd_setup_anki", requestId: `anki-setup-${name}`, ...fields }, sender);
    return { bus, storage, chrome, requests, held, audioRequests, audioHeld, send };
  }
  const collection = (action, params) => {
    switch (action) {
      case "modelNamesAndIds": return { Basic: 1, "Kiku v2": 2, "My Kiku": 3 };
      case "deckNames": return ["Default", "Words", "Mining", "Mining::Old"];
      case "modelFieldNames": return params.modelName === "Kiku v2" ? KIKU_FIELDS : ["Front", "Back"];
      case "findNotes": return [21, 22, 23];
      case "findCards": return [211, 212, 221, 231];
      case "getDecks": return { Mining: [211, 212, 221], "Mining::Old": [231] };
      case "cardsToNotes": return params.cards.includes(231) ? [23] : [21, 22];
      default: throw new Error(`unexpected ${action}`);
    }
  };

  const unaccepted = worldFor("anki-unaccepted", { answer: collection, setup: setupRecord({ stage: "welcome" }) });
  const unacceptedReply = await unaccepted.send();
  check("the worker refuses first-run Anki discovery before Start setup without contacting Anki",
    unacceptedReply?.ok === false && unacceptedReply.error.includes("Start setup") && unaccepted.requests.length === 0,
    JSON.stringify({ unacceptedReply, requests: unaccepted.requests }));

  // Ordinary absence: the connection never answers.
  const absent = worldFor("anki-absent", { answer: () => new TypeError("Failed to fetch") });
  const fromSettings = await absent.send({}, { id: absent.chrome.runtime.id, url: absent.chrome.runtime.getURL("settings.html") });
  const unavailable = await absent.send();
  const again = await absent.send();
  // A refusal keeps its reason.
  const denied = worldFor("anki-denied", { answer: () => ({ status: 403 }) });
  const deniedReply = await denied.send();
  // A configuration the user already has is verified the way Settings verifies
  // it, then reported without proposing or writing anything.
  const existing = worldFor("anki-existing", { answer: collection, options: { revision: 3, anki: configuredAnki("Basic", "Words") } });
  const existingReply = await existing.send();
  // A note type chosen in Settings without its fields is not a configured setup:
  // Anki's own availability rules name what is missing.
  const partial = worldFor("anki-partial", { answer: collection, options: { revision: 3, anki: { ...defaultAnki(), model: "Basic", deck: "Words" } } });
  const partialReply = await partial.send();
  // A saved mapping that could not be checked is not claimed to be set up: the
  // connection's own reason is recorded and the mapping is left untouched.
  const offline = worldFor("anki-offline", { answer: () => new TypeError("Failed to fetch"),
    options: { revision: 3, anki: configuredAnki("Basic", "Words") } });
  const offlineReply = await offline.send();
  check("first-run Anki detection is startup-only, records absence or a specific refusal once, and reports an existing setup without any call",
    fromSettings?.ok === false && fromSettings.error.includes("startup page")
      && unavailable?.ok === true && unavailable.state.anki?.status === "unavailable" && unavailable.state.anki.detail.includes("Open Anki")
      && unavailable.state.revision === 5 && absent.requests.length === 1 && absent.requests[0].action === "modelNamesAndIds"
      && absent.requests[0].url === "http://127.0.0.1:8765" && again?.ok === true && again.state.revision === 5 && absent.requests.length === 1
      && absent.storage.raw.get("options") === undefined
      && deniedReply?.ok === true && deniedReply.state.anki?.status === "needs-attention" && deniedReply.state.anki.detail.includes("denied permission")
      && existingReply?.ok === true && existingReply.state.anki?.status === "already-configured"
      && existingReply.state.anki.model === "Basic" && existingReply.state.anki.deck === "Words"
      && JSON.stringify(existing.requests.map((request) => request.action)) === JSON.stringify(["modelNamesAndIds", "deckNames", "modelFieldNames"])
      && existing.storage.raw.get("options").revision === 3
      && partialReply?.ok === true && partialReply.state.anki?.status === "needs-attention"
      && partialReply.state.anki.detail === "Map the first field, “Front”, of note type “Basic” before adding notes. Anki requires it."
      && partialReply.state.anki.model === null
      && JSON.stringify(partial.requests.map((request) => request.action)) === JSON.stringify(["modelNamesAndIds", "deckNames", "modelFieldNames"])
      && partial.storage.raw.get("options").revision === 3
      && offlineReply?.ok === true && offlineReply.state.anki?.status === "unavailable"
      && offlineReply.state.anki.detail.includes("Open Anki") && offlineReply.state.anki.model === null
      && JSON.stringify(offline.storage.raw.get("options").anki) === JSON.stringify(configuredAnki("Basic", "Words"))
      && offline.storage.raw.get("options").revision === 3,
    JSON.stringify({ fromSettings, unavailable, again, absentRequests: absent.requests, deniedReply, existingReply,
      existingRequests: existing.requests, partialReply, partialRequests: partial.requests, offlineReply }));

  // A recognised setup: duplicate requests share one detection, the ranked
  // model and deck are saved with the preset through the options CAS, and the
  // outcome lands in the same storage write.
  const found = worldFor("anki-found", { answer: collection, localAudio: true,
    options: { revision: 2, anki: { ...defaultAnki(), apiKey: "local-key" } } });
  const writesBefore = found.storage.sets.length;
  const [first, second] = await Promise.all([found.send(), found.send({ requestId: "anki-setup-duplicate" })]);
  const savedOptions = found.storage.raw.get("options");
  const actions = found.requests.map((request) => request.action);
  check("first-run Anki detection ranks note types and decks read-only and saves the exact names with the preset once",
    first?.ok === true && second?.ok === true && JSON.stringify(first.state) === JSON.stringify(second.state)
      && first.state.anki?.status === "configured" && first.state.anki.model === "Kiku v2" && first.state.anki.deck === "Mining"
      && actions.filter((action) => action === "modelNamesAndIds").length === 1
      // "My Kiku" and "Basic" are never consulted: only a leading family name is a candidate.
      && JSON.stringify(actions) === JSON.stringify(["modelNamesAndIds", "modelFieldNames", "findNotes", "findCards", "getDecks", "cardsToNotes", "cardsToNotes"])
      && found.requests.every((request) => request.key === "local-key")
      && found.requests.find((request) => request.action === "findNotes").params.query === "mid:2"
      && found.requests.find((request) => request.action === "findCards").params.query === "mid:2 -deck:filtered"
      && savedOptions.revision === 3 && savedOptions.anki.model === "Kiku v2" && savedOptions.anki.deck === "Mining" && savedOptions.anki.apiKey === "local-key"
      && savedOptions.anki.fieldTemplates.Expression.value === "{expression}"
      && savedOptions.anki.fieldTemplates.SentenceAudio.value === ""
      && savedOptions.anki.fieldTemplates.Picture.value === "{screenshot}"
      && Object.keys(savedOptions.anki.fieldTemplates).length === KIKU_FIELDS.length
      && savedOptions.audioSources[0].type === "custom-json"
      && savedOptions.audioSources[0].enabled === true
      && savedOptions.audioSources[0].url === "http://127.0.0.1:5050/?term={term}&reading={reading}"
      && savedOptions.audioSources[1].id === "default-tts"
      && JSON.stringify(found.audioRequests.map(request => request.url)) === JSON.stringify([
        "http://127.0.0.1:5050/?term=%E7%8C%AB&reading=%E3%81%AD%E3%81%93",
      ])
      && JSON.stringify(found.storage.sets.slice(writesBefore)) === JSON.stringify([[ANKI_INDEX_KEY, "options", "setupState"]])
      && first.state.revision === 5,
    JSON.stringify({ first, second, actions, audioRequests: found.audioRequests, savedOptions, sets: found.storage.sets.slice(writesBefore) }));

  const exact = { id: "local-audio", type: "custom-json", enabled: false,
    url: "http://127.0.0.1:5050/?term={term}&reading={reading}", voice: "" };
  const speech = { id: "speech", type: "text-to-speech-reading", enabled: true, url: "", voice: "" };
  const duplicate = worldFor("anki-audio-existing", { answer: collection, localAudio: true,
    options: { revision: 2, anki: defaultAnki(), audioSources: [speech, exact] } });
  await duplicate.send();
  const duplicateSources = duplicate.storage.raw.get("options").audioSources;
  const audioRace = worldFor("anki-audio-race", { answer: collection, localAudio: "hold",
    options: { revision: 1, anki: defaultAnki(), audioSources: [speech] } });
  const pendingAudio = audioRace.send();
  for (let attempt = 0; attempt < 100 && audioRace.audioHeld.length === 0; attempt += 1) {
    await new Promise(resolveTimer => setTimeout(resolveTimer, 2));
  }
  const audioChoice = await audioRace.bus.sendMessage("settings-page", {
    target: "hoshidicts-worker", type: "hd_options_write", requestId: "audio-user",
    baseRevision: 1, options: { audioSources: [exact, speech] },
  });
  audioRace.audioHeld.forEach(release => release());
  await pendingAudio;
  const racedSources = audioRace.storage.raw.get("options").audioSources;
  const linked = worldFor("anki-audio-linked", { answer: collection, localAudio: true,
    sharing: { host: null, client: { address: "ws://127.0.0.1:9100/link" } },
    options: { revision: 2, anki: defaultAnki(), audioSources: [speech] } });
  await linked.send();
  check("first-run setup prepends detected local audio once and leaves existing, racing and linked sources alone",
    duplicate.audioRequests.length === 0 && JSON.stringify(duplicateSources) === JSON.stringify([speech, exact])
      && audioRace.audioRequests.length === 1 && audioChoice?.ok === true
      && JSON.stringify(racedSources) === JSON.stringify([exact, speech])
      && racedSources.filter(source => source.url === exact.url).length === 1
      && linked.audioRequests.length === 0
      && JSON.stringify(linked.storage.raw.get("options").audioSources) === JSON.stringify([speech]),
    JSON.stringify({ duplicateAudioRequests: duplicate.audioRequests, duplicateSources, audioChoice,
      raceAudioRequests: audioRace.audioRequests, racedSources, linkedAudioRequests: linked.audioRequests,
      linkedSources: linked.storage.raw.get("options").audioSources }));

  // A choice the user makes while detection runs is kept.
  const racing = worldFor("anki-racing", { answer: (action, params, count) => (action === "modelNamesAndIds" && count === 1 ? "hold" : collection(action, params)),
    options: { revision: 1 } });
  const pendingDetection = racing.send();
  for (let attempt = 0; attempt < 100 && racing.held.length === 0; attempt += 1) await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
  const userChoice = await racing.bus.sendMessage("settings-page", { target: "hoshidicts-worker", type: "hd_options_write", requestId: "anki-user",
    baseRevision: 1, options: { anki: configuredAnki("Basic", "Default") } });
  racing.held.forEach((release) => release());
  const raced = await pendingDetection;
  // A mapping changed while a check ran makes that check stale: the new mapping
  // is checked instead, so a failure of the old check is never recorded for it.
  const failing = worldFor("anki-racing-absent", { answer: (action, params, count) => (count === 1 ? "hold" : new TypeError("Failed to fetch")),
    options: { revision: 1 } });
  const pendingFailure = failing.send();
  for (let attempt = 0; attempt < 100 && failing.held.length === 0; attempt += 1) await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
  const lateChoice = await failing.bus.sendMessage("settings-page", { target: "hoshidicts-worker", type: "hd_options_write", requestId: "anki-late",
    baseRevision: 1, options: { anki: configuredAnki("Kiku v2", "Mining") } });
  failing.held.forEach((release) => release());
  const rescued = await pendingFailure;
  check("a note type chosen while first-run Anki detection runs is reported as already configured and never overwritten",
    racing.held.length === 1 && userChoice?.ok === true && raced?.ok === true && raced.state.anki?.status === "already-configured"
      && raced.state.anki.model === "Basic" && racing.storage.raw.get("options").anki.model === "Basic"
      && racing.storage.raw.get("options").revision === 2
      && lateChoice?.ok === true && rescued?.ok === true && rescued.state.anki?.status === "unavailable"
      && rescued.state.anki.detail.includes("Open Anki")
      && failing.requests.filter((request) => request.action === "modelNamesAndIds").length === 2
      && failing.storage.raw.get("options").anki.model === "Kiku v2"
      && failing.storage.raw.get("options").revision === 2,
    JSON.stringify({ userChoice, raced, options: racing.storage.raw.get("options"), lateChoice, rescued, failingOptions: failing.storage.raw.get("options") }));

  let connected = false;
  const recovery = worldFor("anki-settings-recovery", { setup: null, options: { revision: 2, anki: defaultAnki() },
    answer: (action, params) => connected ? collection(action, params) : new TypeError("Failed to fetch") });
  const settingsSender = { id: recovery.chrome.runtime.id, url: recovery.chrome.runtime.getURL("settings.html#anki") };
  const detect = () => recovery.send({ type: "hd_anki_setup", anki: defaultAnki() }, settingsSender);
  const missing = await detect();
  connected = true;
  const proposal = await detect();
  const unchanged = recovery.storage.raw.get("options").revision === 2 && recovery.storage.raw.get("setupState") === null;
  const refused = await recovery.send({ type: "hd_anki_setup", anki: defaultAnki() });
  const write = baseRevision => recovery.bus.sendMessage("settings-page", { target: "hoshidicts-worker", type: "hd_options_write",
    baseRevision, options: { anki: { ...defaultAnki(), model: proposal.proposal.model, deck: proposal.proposal.deck,
      fieldTemplates: proposal.proposal.fieldTemplates } } }, settingsSender);
  const saved = await write(2);
  const stale = await write(2);
  check("Settings Anki recovery retries read-only detection without onboarding and saves only through revision-checked options",
    missing.ok && missing.outcome.status === "unavailable" && proposal.ok && proposal.outcome.status === "configured"
      && proposal.proposal.model === "Kiku v2" && unchanged && refused.ok === false
      && saved.ok && saved.options.revision === 3 && stale.ok === false && stale.conflict === true
      && recovery.storage.raw.get("setupState") === null,
    JSON.stringify({ missing, proposal, unchanged, refused, saved, stale }));
}

// A mining screenshot is captured from the page that asked, and only while that
// page is still what the window shows.
async function ankiScreenshotStage() {
  const bus = makeBus();
  const storage = makeStorage();
  const chrome = makeChrome("anki-screenshot", bus, storage);
  const uploads = [];
  const captures = [];
  let tab = { id: 7, active: true, url: "https://reader.test/page", windowId: 3 };
  let captureFailures = 0;
  let moveDuringCapture = false;
  let documentId = "reading-document";
  let reloadDuringCapture = false;
  let navigateDuringCapture = false;
  const documentChecks = [];
  const contextChecks = [];
  const getContexts = chrome.runtime.getContexts;
  chrome.runtime.getContexts = async filter => {
    if (!filter.documentIds) return getContexts(filter);
    contextChecks.push(filter);
    return filter.documentIds.includes(documentId)
      ? [{ documentId, tabId: tab.id, documentUrl: tab.url, contextType: "TAB" }] : [];
  };
  chrome.tabs = {
    async get(id) {
      if (id !== tab.id) throw new Error("No tab with id");
      const result = { ...tab };
      if (result.url.startsWith("chrome-extension:")) delete result.url;
      return result;
    },
    async sendMessage(id, message, options) {
      documentChecks.push({ id, message, options });
      if (id !== tab.id || options.documentId !== documentId) throw new Error("The document was removed.");
      return { present: true };
    },
    async captureVisibleTab(windowId, options) {
      captures.push({ windowId, options });
      if (captureFailures > 0) {
        captureFailures -= 1;
        throw new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded");
      }
      if (moveDuringCapture) tab = { ...tab, windowId: 4 };
      if (reloadDuringCapture) documentId = "replacement-document";
      if (navigateDuringCapture) tab = { ...tab, url: "https://reader.test/watch/5678" };
      return "data:image/jpeg;base64,c2hvdA==";
    },
  };
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, AbortController, crypto, Error, Promise,
    fetch(url, options) {
      const body = JSON.parse(options.body);
      uploads.push({ url, action: body.action, params: body.params, key: body.key ?? null });
      return Promise.resolve({ ok: true, async json() { return { result: body.params.filename, error: null }; } });
    },
  });
  await storage.api().local.set({ options: { revision: 1, anki: { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic" } } });
  const ask = (sender) => bus.sendMessage("reader", { target: "hachidori-anki", type: "hd_anki_screenshot",
    requestId: "anki-screenshot", request: {} }, sender);
  const reader = { id: chrome.runtime.id, url: tab.url, frameId: 0, documentId, tab: { id: tab.id } };

  const taken = await ask(reader);
  tab = { ...tab, url: "https://reader.test/watch/1234?trackId=example%3Fvalue#player" };
  const spaReader = { ...reader, tab: { id: tab.id, url: tab.url } };
  const sameDocument = await ask(spaReader);
  navigateDuringCapture = true;
  const routeChanged = await ask(spaReader);
  navigateDuringCapture = false;
  tab = { ...tab, url: reader.url };
  check("a mining screenshot accepts a current SPA route despite its stale script URL and rejects a route change during capture",
    sameDocument?.ok === true && routeChanged?.ok === false && routeChanged.error.includes("moved to another page"),
    JSON.stringify({ sameDocument, routeChanged }));
  // Chrome rate-limits captures, so one wait is worth a screenshot.
  captureFailures = 1;
  const retried = await ask(reader);
  // A rate-limited attempt is retried, but the tab it belongs to is checked
  // again first: a switch during the wait takes no picture at all.
  captureFailures = 1;
  const capturesBeforeSwitch = captures.length;
  const switchedAway = await (async () => {
    const pending = ask(reader);
    for (let attempt = 0; attempt < 200 && captures.length === capturesBeforeSwitch; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    tab = { ...tab, active: false };
    const reply = await pending;
    tab = { ...tab, active: true };
    return reply;
  })();
  const capturesAfterSwitch = captures.length;
  captureFailures = 3;
  const givenUp = await ask(reader);
  captureFailures = 0;
  // Dragging the active reading tab to another window leaves it active with the
  // same URL, but the capture was bound to the old window's replacement tab.
  moveDuringCapture = true;
  const movedWindow = await ask(reader);
  moveDuringCapture = false;
  tab = { ...tab, windowId: 3 };
  // A reload can replace the document while its tab, URL and window all stay
  // the same. It must fail both before capture and after pixels return.
  reloadDuringCapture = true;
  const reloadedDuring = await ask(reader);
  reloadDuringCapture = false;
  const capturesBeforeReload = captures.length;
  const alreadyReloaded = await ask(reader);
  const capturesAfterReload = captures.length;
  documentId = reader.documentId;
  tab = { ...tab, active: false };
  const background = await ask(reader);
  tab = { ...tab, active: true, url: "https://reader.test/elsewhere" };
  const navigated = await ask(reader);
  const fromExtensionPage = await ask({ id: chrome.runtime.id, url: chrome.runtime.getURL("settings.html") });
  tab = { ...tab, url: chrome.runtime.getURL("startup.html#setup-heading") };
  const startup = { id: chrome.runtime.id, url: tab.url, documentId };
  const startupTaken = await ask(startup);
  const startupWithTab = { ...startup, frameId: 0, tab: { id: tab.id } };
  const startupTabTaken = await ask(startupWithTab);
  reloadDuringCapture = true;
  const startupReloaded = await ask(startupWithTab);
  reloadDuringCapture = false;
  const capturesBeforeStartupReload = captures.length;
  const startupGone = await ask(startupWithTab);
  const capturesAfterStartupReload = captures.length;
  await storage.api().local.set({ options: { revision: 2,
    anki: { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic", captureScreenshot: false } } });
  tab = { ...tab, url: "https://reader.test/page" };
  const switchedOff = await ask(reader);
  check("a mining screenshot captures the asking page once it is still the window's own, and never any other page",
    taken?.ok === true && /^hachidori-screenshot-[0-9a-f-]{36}\.jpg$/u.test(taken.filename)
      && /^[0-9a-f-]{36}$/u.test(taken.token ?? "")
      // The picture waits for the note: capturing talks to nothing but the tab.
      && uploads.length === 0
      && retried?.ok === true && captures.filter(({ windowId }) => windowId === 3).length === captures.length
      && captures.every(({ options }) => options.format === "jpeg")
      && switchedAway?.ok === false && switchedAway.error.includes("no longer the active tab")
      && capturesAfterSwitch === capturesBeforeSwitch + 1
      && givenUp?.ok === false && givenUp.error.includes("quota")
      && movedWindow?.ok === false && movedWindow.error.includes("moved to another window")
      && reloadedDuring?.ok === false && reloadedDuring.error.includes("document")
      && alreadyReloaded?.ok === false && alreadyReloaded.error.includes("document")
      && capturesBeforeReload === capturesAfterReload
      && documentChecks.length > 0 && documentChecks.every(value => value.id === tab.id
        && value.options.documentId === reader.documentId
        && value.message.target === "hachidori-anki-content" && value.message.type === "hd_anki_document")
      && background?.ok === false && background.error.includes("no longer the active tab")
      && navigated?.ok === false && navigated.error.includes("moved to another page")
      && fromExtensionPage?.ok === false && fromExtensionPage.error.includes("reading tab")
      && startupTaken?.ok === true && startupTabTaken?.ok === true && contextChecks.length > 0
      && startupReloaded?.ok === false && startupReloaded.error.includes("document")
      && startupGone?.ok === false && startupGone.error.includes("document")
      && capturesBeforeStartupReload === capturesAfterStartupReload
      && switchedOff?.ok === false && switchedOff.error.includes("turned off in Settings"),
    JSON.stringify({ taken, retried, switchedAway, givenUp, movedWindow, reloadedDuring, alreadyReloaded,
      background, navigated, fromExtensionPage, startupTaken, startupTabTaken, startupReloaded, startupGone, switchedOff, uploads, captures, documentChecks, contextChecks }));

  const injections = [];
  const previewData = "data:image/jpeg;base64,/9j/4AAQ/9k=";
  let previewResult = { dataUrl: previewData };
  let duringPreview = () => {};
  chrome.scripting = { executeScript: async injection => {
    injections.push(injection);
    duringPreview();
    return [{ frameId: 0, documentId: reader.documentId, result: previewResult }];
  } };
  const screenshotOptions = { ...globalThis.HDReaderOptions.normaliseOptions({}).anki, model: "Basic" };
  await storage.api().local.set({ options: { revision: 3, anki: screenshotOptions } });
  documentId = reader.documentId;
  tab = { ...tab, url: "https://www.netflix.com/watch/81000001?trackId=123" };
  const netflixReader = { ...reader, url: tab.url, tab: { id: tab.id, url: tab.url } };
  const beforeDefault = captures.length;
  const defaultNetflix = await ask(netflixReader);
  check("Netflix screenshots keep the viewport capture until preview screenshots are enabled",
    defaultNetflix.ok === true && captures.length === beforeDefault + 1 && injections.length === 0,
    JSON.stringify({ defaultNetflix, captures: captures.length, injections: injections.length }));

  await storage.api().local.set({ options: { revision: 4, anki: screenshotOptions,
    experimental: { netflixPreviewScreenshots: true } } });
  const beforePreview = captures.length;
  const previewTaken = await ask(netflixReader);
  const injected = injections[0];
  check("enabled Netflix previews target the exact top-frame document in MAIN world without viewport capture",
    previewTaken.ok === true && captures.length === beforePreview && injections.length === 1
      && injected.func === captureNetflixPreview && injected.world === "MAIN"
      && injected.target.tabId === tab.id && injected.target.documentIds.join() === reader.documentId
      && injected.args[0] === netflixReader.url,
    JSON.stringify({ previewTaken, target: injected?.target, world: injected?.world, args: injected?.args }));

  previewResult = { error: "Netflix preview screenshot: this player has no seek preview image." };
  const previewMissing = await ask(netflixReader);
  previewResult = { dataUrl: "data:image/png;base64,c2hvdA==" };
  const previewInvalid = await ask(netflixReader);
  check("unavailable or invalid Netflix previews report an error without substituting a viewport screenshot",
    previewMissing.ok === false && previewMissing.error.includes("no seek preview image")
      && previewInvalid.ok === false && previewInvalid.error.includes("no JPEG preview image")
      && captures.length === beforePreview,
    JSON.stringify({ previewMissing, previewInvalid }));

  previewResult = { dataUrl: previewData };
  duringPreview = () => { tab = { ...tab, url: "https://www.netflix.com/watch/999" }; };
  const previewNavigated = await ask(netflixReader);
  tab = { ...tab, url: netflixReader.url };
  duringPreview = () => { documentId = "replacement-document"; };
  const previewReloaded = await ask(netflixReader);
  documentId = reader.documentId;
  duringPreview = () => { tab = { ...tab, windowId: 4 }; };
  const previewMoved = await ask(netflixReader);
  tab = { ...tab, windowId: 3, active: false };
  duringPreview = () => {};
  const beforeInactive = injections.length;
  const previewInactive = await ask(netflixReader);
  check("Netflix previews preserve the active tab, document, route and window ownership checks",
    previewNavigated.ok === false && previewNavigated.error.includes("moved to another page")
      && previewReloaded.ok === false && previewReloaded.error.includes("document")
      && previewMoved.ok === false && previewMoved.error.includes("moved to another window")
      && previewInactive.ok === false && previewInactive.error.includes("no longer the active tab")
      && injections.length === beforeInactive && captures.length === beforePreview,
    JSON.stringify({ previewNavigated, previewReloaded, previewMoved, previewInactive }));

  tab = { ...tab, active: true };
  const subframe = await ask({ ...netflixReader, frameId: 1 });
  tab = { ...tab, url: reader.url };
  const ordinaryPage = await ask(reader);
  check("the preview flag leaves non-Netflix pages and subframes on the ordinary screenshot path",
    subframe.ok === true && ordinaryPage.ok === true && captures.length === beforePreview + 2
      && injections.length === beforeInactive,
    JSON.stringify({ subframe, ordinaryPage }));
}

async function ankiBackgroundStage() {
  const bus = makeBus();
  const storage = makeStorage();
  const chrome = makeChrome("anki-worker", bus, storage);
  const requests = [];
  const releases = [];
  const context = loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, AbortController,
    fetch(url, options) {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      return new Promise(resolve => releases.push(async () => resolve({ ok: true,
        json: async () => answerAnkiConnect(body, action => action === "deckNames" ? ["Default"] : []) })));
    },
  });
  const send = (patch = {}, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("settings.html#anki") }) =>
    bus.sendMessage("anki-settings", { target: "hoshidicts-worker", type: "hd_anki_discover",
      requestId: "anki-discover", model: "", apiKey: "", ...patch }, sender);
  const rejected = await send({}, { id: chrome.runtime.id, url: "https://example.test" });
  const invalid = await send({ model: null });
  const pending = send({ endpoint: "https://untrusted.test", action: "deleteDecks" });
  const written = await bus.sendMessage("anki-settings", { target: "hoshidicts-worker", type: "hd_options_write",
    requestId: "anki-parallel-options", baseRevision: 0, options: { scanLength: 19 } });
  const read = await bus.sendMessage("anki-settings", { target: "hoshidicts-worker", type: "hd_state_read" });
  const independent = releases.length === 1 && written.ok && read.ok;
  releases.forEach(release => release());
  const result = await pending;
  // Discovery is one `multi` round trip whose sub-actions are the fixed
  // read-only trio; the message's own action name never reaches Anki.
  check("Anki discovery uses only fixed read-only calls from Settings in one batch and never holds the storage queue",
    !rejected.ok && !invalid.ok && independent && result.ok && result.connected
      && requests.every(({ url }) => url === "http://127.0.0.1:8765")
      && requests.map(({ body }) => body.action).join() === "multi"
      && requests[0].body.params.actions.map(entry => entry.action).join() === "deckNames,modelNames,modelFieldNames"
      && requests[0].body.params.actions.every(entry => entry.version === 6)
      && !bus.log.some(message => message.relayed), JSON.stringify({ rejected, invalid, independent, result, requests }));
  const options = context.HDReaderOptions.normaliseOptions({}).anki;
  const commit = await bus.sendMessage("anki-settings", { target: "hoshidicts-worker", type: "hd_options_write",
    requestId: "anki-config-write", baseRevision: written.options.revision,
    options: { anki: { ...options, model: "Basic", fields: { ...options.fields, expression: "Front" } } } });
  const stale = await bus.sendMessage("anki-settings", { target: "hoshidicts-worker", type: "hd_options_write",
    requestId: "anki-config-stale", baseRevision: written.options.revision, options: { anki: options } });
  check("Anki model and mappings commit together through the existing options CAS and reject stale edits",
    commit.ok && commit.options.anki.model === "Basic" && commit.options.anki.fields.expression === "Front"
      && !stale.ok && stale.options.anki.model === "Basic", JSON.stringify({ commit, stale }));

  const cacheBus = makeBus(), cacheStorage = makeStorage();
  const cacheChrome = makeChrome("anki-cache-worker", cacheBus, cacheStorage);
  loadBackgroundScript({ chrome: cacheChrome, console, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ result: [], error: null }) }),
  });
  const writeCacheOptions = (baseRevision, options) => cacheBus.sendMessage("anki-settings", {
    target: "hoshidicts-worker", type: "hd_options_write", baseRevision, options,
  });
  const enabled = await writeCacheOptions(0, { definitionBlurAnkiMature: true, anki: commit.options.anki });
  const enabledIndex = structuredClone(cacheStorage.raw.get(ANKI_INDEX_KEY));
  const disabled = await writeCacheOptions(enabled.options.revision, { definitionBlurAnkiMature: false });
  const disabledIndex = cacheStorage.raw.get(ANKI_INDEX_KEY);
  const optionsCommits = cacheStorage.sets.filter(keys => keys.includes("options"));
  check("Anki index source invalidation commits atomically while blur-only changes retain the same rows",
    enabled.ok && disabled.ok && enabledIndex.configurationRevision === 1
      && disabledIndex.configurationRevision === 1
      && optionsCommits.length === 2
      && optionsCommits[0].length === 2 && optionsCommits[0].includes(ANKI_INDEX_KEY)
      && optionsCommits[1].length === 1,
    JSON.stringify({ enabledIndex, disabledIndex, optionsCommits }));
}

// Page-wide word status (#520): the worker answers a batch from the first
// Template's cached index rows and never contacts Anki; a linked browser sends
// the batch to its host, which owns that evidence.
async function ankiWordStatusStage() {
  const restoreOffscreen = existingOffscreenStage();
  const settle = settleSharing;
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("word-status-worker", bus, storage);
  const broadcasts = [];
  chrome.tabs = {
    async query() { return [{ id: 9 }, { id: 10 }]; },
    async sendMessage(tabId, message) { broadcasts.push({ tabId, message }); },
  };
  const ankiConnect = [];
  const refreshes = [];
  bus.addListener("word-status-render", (message, sender, sendResponse) => {
    if (message?.target !== "hachidori-anki-render" || message.type !== "hd_anki_index_refresh"
        || message.relayed !== true) return false;
    refreshes.push(rows => sendResponse({ type: "hd_anki_index_refresh_result", requestId: message.requestId, ok: true, rows }));
    return true;
  });
  await storage.api().local.set({ options: { anki: { model: "Basic", fields: { expression: "Front" } }, revision: 1 } });
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, Promise, Error, WebSocket: FakeSharingSocket,
    fetch: async (url) => {
      ankiConnect.push(String(url));
      throw new Error("word status contacted AnkiConnect");
    } });
  const page = { id: chrome.runtime.id, url: "https://reader.example/novel", tab: { id: 9 }, frameId: 0 };
  const ask = (request, requestId = "page-word-status") => bus.sendMessage("word-status-page",
    { target: "hachidori-anki", type: "hd_anki_word_status", requestId, request }, page);
  await settle(() => refreshes.length === 1);
  const cold = await ask({ headwords: ["食べる"] }, "cold-word-status");
  refreshes[0]?.([["食べる", true, [11]], ["読む", false, [12]]]);
  await settle(() => storage.raw.get(ANKI_INDEX_KEY)?.rowRevision === 1);
  const warm = await ask({ headwords: ["食べる", "読む", "猫", "食べる"] });
  const malformed = await ask({ headwords: "食べる" }, "malformed-word-status");
  await settle(() => broadcasts.length >= 2);
  check("word status answers a page's batch from the first Template's cached rows without contacting Anki",
    cold.ok === true && cold.revision === 0 && cold.statuses === null
      && warm.ok === true && warm.type === "hd_anki_word_status_result" && warm.requestId === "page-word-status"
      && warm.revision === 1 && JSON.stringify(warm.statuses) === JSON.stringify(["known", "learning", "unknown", "known"])
      && malformed.ok === false && malformed.requestId === "malformed-word-status"
      && ankiConnect.length === 0 && refreshes.length === 1,
    JSON.stringify({ cold, warm, malformed, ankiConnect, refreshes: refreshes.length }));
  check("a changed index row revision is broadcast to every reading tab so the page can re-read word status",
    broadcasts.length === 2
      && broadcasts.every(entry => entry.message.target === "hachidori-anki-content"
        && entry.message.type === "hd_anki_word_status_changed" && entry.message.revision === 1)
      && JSON.stringify(broadcasts.map(entry => entry.tabId).sort((a, b) => a - b)) === JSON.stringify([9, 10]),
    JSON.stringify({ broadcasts }));

  // The same worker shares itself once it has a dictionary. A linked
  // browser's batch is rebuilt from its headwords and read from this index.
  const { host, fromReader, toReader } = await shareWithLinkedReader(storage);
  fromReader({ kind: "request", id: "linked-word-status", message: {
    target: "hachidori-anki", type: "hd_anki_word_status", requestId: "reader-word-status",
    request: { headwords: ["読む", "猫"], url: "https://client.invalid/anki", apiKey: "client-secret" },
  } });
  await settle(() => toReader().some(frame => frame.id === "linked-word-status"));
  const hostReply = toReader().find(frame => frame.id === "linked-word-status");
  check("the host answers a linked browser's word status batch from its own index",
    hostReply?.kind === "reply" && hostReply.response?.ok === true && hostReply.response.requestId === "reader-word-status"
      && hostReply.response.revision === 1
      && JSON.stringify(hostReply.response.statuses) === JSON.stringify(["learning", "unknown"])
      && ankiConnect.length === 0,
    JSON.stringify({ hostReply, sent: toReader(), ankiConnect }));

  // Another Template source keeps the row revision but none of its rows, so
  // pages and linked browsers are told without one, then again by its pull.
  const linkedBroadcasts = () => (host?.sent ?? []).filter(frame => frame.kind === "broadcast")
    .map(frame => JSON.parse(frame.text)).filter(frame => frame.kind === "word-status");
  const beforeSource = broadcasts.length;
  const storedOptions = storage.raw.get("options");
  const sourceWrite = await bus.sendMessage("word-status-settings", { target: "hoshidicts-worker", type: "hd_options_write",
    requestId: "word-status-source", baseRevision: storedOptions.revision, options: { anki: {
      ...globalThis.HDReaderOptions.normaliseOptions(storedOptions).anki, duplicateScope: "all" } } });
  await settle(() => broadcasts.length >= beforeSource + 2 && refreshes.length === 2);
  const sourceChanged = broadcasts.slice(beforeSource).map(entry => entry.message.revision);
  const unavailable = await ask({ headwords: ["食べる"] }, "source-word-status");
  refreshes[1]?.([["猫", true, [13]]]);
  await settle(() => broadcasts.length >= beforeSource + 4);
  const pulled = await ask({ headwords: ["食べる", "猫"] }, "pulled-word-status");
  check("another Template source is announced to every reading tab and linked browser without a revision",
    sourceWrite.ok === true && JSON.stringify(sourceChanged) === JSON.stringify([null, null])
      && unavailable.ok === true && unavailable.revision === 1 && unavailable.statuses === null
      && JSON.stringify(broadcasts.slice(beforeSource + 2).map(entry => entry.message.revision)) === JSON.stringify([2, 2])
      && pulled.revision === 2 && JSON.stringify(pulled.statuses) === JSON.stringify(["unknown", "known"])
      && JSON.stringify(linkedBroadcasts()) === JSON.stringify([
        { kind: "word-status", revision: null }, { kind: "word-status", revision: 2 }])
      && ankiConnect.length === 0,
    JSON.stringify({ sourceWrite, sourceChanged, unavailable, pulled, broadcasts, linked: linkedBroadcasts() }));

  // A linked reading browser forwards the page's batch once and returns the
  // host's reply; its own index and Anki service are never consulted.
  const clientBus = makeBus(), clientStorage = makeStorage();
  const clientChrome = makeChrome("word-status-client", clientBus, clientStorage);
  const clientBroadcasts = [];
  clientChrome.tabs = {
    async query() { return [{ id: 21 }]; },
    async sendMessage(tabId, message) { clientBroadcasts.push({ tabId, message }); },
  };
  const linkAddress = "ws://127.0.0.1:9101/link";
  await clientStorage.api().local.set({ sharing: { host: null, client: { address: linkAddress } } });
  loadBackgroundScript({ chrome: clientChrome, console, setTimeout, clearTimeout, Promise, Error, WebSocket: FakeSharingSocket,
    createAnkiWorkerService: () => ({ wordStatus() { throw new Error("linked word status ran in the reading browser"); } }) });
  await settle(() => FakeSharingSocket.instances.some(socket => socket.url === linkAddress));
  const link = FakeSharingSocket.instances.find(socket => socket.url === linkAddress);
  link?.open();
  link?.receive({ kind: "hello", protocol: 1, version: "0.0.0-smoke", name: "Host", dictionaryCount: 1,
    capabilities: ["linked-anki-v1", "linked-anki-v2"], snapshot: {} });
  await settle(() => clientBroadcasts.length >= 1);
  const asking = clientBus.sendMessage("word-status-client-page", { target: "hachidori-anki", type: "hd_anki_word_status",
    requestId: "reader-word-status", request: { headwords: ["読む", "猫"] } }, page);
  await settle(() => (link?.requests().length ?? 0) >= 1);
  const forwarded = link?.requests() ?? [];
  link?.receive({ kind: "reply", id: forwarded[0]?.id, response: hostReply?.response });
  const linked = await asking;
  check("a linked page's word status crosses the link as one batch and takes the host's reply",
    forwarded.length === 1 && JSON.stringify(forwarded[0].message) === JSON.stringify({
      target: "hachidori-anki", type: "hd_anki_word_status", requestId: "reader-word-status",
      request: { headwords: ["読む", "猫"] },
    })
      && hostReply !== undefined && JSON.stringify(linked) === JSON.stringify(hostReply.response),
    JSON.stringify({ forwarded, linked }));

  // The host's index starts answering this browser's pages at the link's
  // hello and stops at unlinking; neither continues the other's revisions.
  link?.receive({ kind: "word-status", revision: 2 });
  await settle(() => clientBroadcasts.length >= 2);
  const unlinked = await clientBus.sendMessage("word-status-client-settings", {
    target: "hachidori-sharing", type: "hd_sharing_client_unlink", requestId: "word-status-unlink" });
  await settle(() => clientBroadcasts.length >= 3);
  check("a linked browser's pages re-read word status when the link's hello completes, on each host revision and after unlinking",
    unlinked.ok === true
      && JSON.stringify(clientBroadcasts.map(entry => [entry.tabId, entry.message.revision])) === JSON.stringify([[21, null], [21, 2], [21, null]])
      && clientBroadcasts.every(entry => entry.message.target === "hachidori-anki-content"
        && entry.message.type === "hd_anki_word_status_changed"),
    JSON.stringify({ unlinked, clientBroadcasts }));
  restoreOffscreen();
}

// Mark as known and Ignore (#520): the worker changes one headword per write in
// its storage queue, without a base revision, so writes from several tabs
// compose. A linked browser sends the write to its host, whose record comes
// back through the mirror like any other shared value.
async function wordStatusOverridesStage() {
  const restoreOffscreen = existingOffscreenStage();
  const settle = settleSharing;
  const bus = makeBus(), storage = makeStorage();
  const chrome = makeChrome("word-overrides-worker", bus, storage);
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, Promise, Error, WebSocket: FakeSharingSocket });
  const page = { id: chrome.runtime.id, url: "https://reader.example/novel", tab: { id: 9 }, frameId: 0 };
  const change = (fields, requestId, target = bus) => target.sendMessage("word-overrides-page",
    { target: "hoshidicts-worker", type: "hd_word_status_override", requestId, ...fields }, page);
  const overrideWrites = () => storage.sets.filter(keys => keys.includes("wordStatusOverrides")).length;
  const known = await change({ headword: "猫", status: "known" }, "known");
  const again = await change({ headword: "猫", status: "known" }, "again");
  const writesAfterRepeat = overrideWrites();
  const [ignored, dog] = await Promise.all([change({ headword: "猫", status: "ignored" }, "ignored"),
    change({ headword: "犬", status: "known" }, "dog")]);
  const cleared = await change({ headword: "猫", status: null }, "cleared");
  const malformed = await Promise.all([change({ headword: "", status: "known" }, "empty"),
    change({ headword: "猫", status: "learning" }, "learning"), change({ headword: "猫" }, "missing")]);
  check("Mark as known and Ignore write one headword in the worker's storage queue, compose across tabs, skip a repeat and refuse malformed changes",
    known.ok === true && known.type === "hd_word_status_override_result" && known.requestId === "known" && known.revision === 1
      && again.ok === true && again.revision === 1 && writesAfterRepeat === 1
      && ignored.revision === 2 && dog.revision === 3 && cleared.revision === 4
      && JSON.stringify(storage.raw.get("wordStatusOverrides")) === JSON.stringify({ revision: 4, known: ["犬"], ignored: [] })
      && malformed.every(reply => reply.ok === false) && overrideWrites() === 4,
    JSON.stringify({ known, again, ignored, dog, cleared, malformed, stored: storage.raw.get("wordStatusOverrides") }));

  // Shared once it has a dictionary: a linked browser's hello carries the
  // record, and its Ignore is committed here and pushed back as a batch.
  const { host, fromReader, toReader } = await shareWithLinkedReader(storage);
  const pushed = () => (host?.sent ?? []).filter(frame => frame.kind === "broadcast").map(frame => JSON.parse(frame.text))
    .filter(frame => frame.kind === "storage" && frame.changes.wordStatusOverrides);
  const hello = toReader().find(frame => frame.kind === "hello");
  fromReader({ kind: "request", id: "linked-override", message: { target: "hoshidicts-worker", type: "hd_word_status_override",
    requestId: "reader-override", headword: "さん", status: "ignored" } });
  await settle(() => toReader().some(frame => frame.id === "linked-override") && pushed().length > 0);
  const hostReply = toReader().find(frame => frame.id === "linked-override");
  const hostRecord = { revision: 5, known: ["犬"], ignored: ["さん"] };
  check("the host's hello carries its word status overrides, and a linked browser's Ignore is committed there and pushed back",
    JSON.stringify(hello?.snapshot.wordStatusOverrides) === JSON.stringify({ revision: 4, known: ["犬"], ignored: [] })
      && hostReply?.response?.ok === true && hostReply.response.revision === 5
      && JSON.stringify(storage.raw.get("wordStatusOverrides")) === JSON.stringify(hostRecord)
      && pushed().length === 1 && JSON.stringify(pushed()[0].changes.wordStatusOverrides) === JSON.stringify(hostRecord),
    JSON.stringify({ hello: hello?.snapshot.wordStatusOverrides, hostReply, pushed: pushed() }));

  // A linked reading browser sends a page's Mark as known to the host as it
  // came, commits nothing itself, and stores the record the host pushes back.
  const clientBus = makeBus(), clientStorage = makeStorage();
  const clientChrome = makeChrome("word-overrides-client", clientBus, clientStorage);
  const linkAddress = "ws://127.0.0.1:9102/link";
  await clientStorage.api().local.set({ sharing: { host: null, client: { address: linkAddress } } });
  loadBackgroundScript({ chrome: clientChrome, console, setTimeout, clearTimeout, Promise, Error, WebSocket: FakeSharingSocket });
  await settle(() => FakeSharingSocket.instances.some(socket => socket.url === linkAddress));
  const link = FakeSharingSocket.instances.find(socket => socket.url === linkAddress);
  link?.open();
  link?.receive({ kind: "hello", protocol: 1, version: "0.0.0-smoke", name: "Host", dictionaryCount: 1,
    capabilities: ["linked-anki-v1", "linked-anki-v2"], snapshot: { wordStatusOverrides: hostRecord } });
  await settle(() => clientStorage.raw.get("wordStatusOverrides")?.revision === 5);
  const mirroredOnHello = structuredClone(clientStorage.raw.get("wordStatusOverrides"));
  const writing = change({ headword: "猫", status: "known" }, "client-override", clientBus);
  await settle(() => (link?.requests().length ?? 0) >= 1);
  const forwarded = link?.requests() ?? [];
  const committed = { revision: 6, known: ["犬", "猫"], ignored: ["さん"] };
  link?.receive({ kind: "reply", id: forwarded[0]?.id, response: { type: "hd_word_status_override_result",
    requestId: "client-override", ok: true, error: null, revision: 6 } });
  const linkedReply = await writing;
  link?.receive({ kind: "storage", changes: { wordStatusOverrides: committed } });
  await settle(() => clientStorage.raw.get("wordStatusOverrides")?.revision === 6);
  check("a linked page's Mark as known crosses the link once and its record arrives through the mirror",
    JSON.stringify(mirroredOnHello) === JSON.stringify(hostRecord)
      && forwarded.length === 1 && JSON.stringify(forwarded[0].message) === JSON.stringify({ target: "hoshidicts-worker",
        type: "hd_word_status_override", requestId: "client-override", headword: "猫", status: "known" })
      && linkedReply.ok === true && linkedReply.revision === 6
      && JSON.stringify(clientStorage.raw.get("wordStatusOverrides")) === JSON.stringify(committed),
    JSON.stringify({ mirroredOnHello, forwarded, linkedReply, mirrored: clientStorage.raw.get("wordStatusOverrides") }));
  await clientBus.sendMessage("word-overrides-client-settings", {
    target: "hachidori-sharing", type: "hd_sharing_client_unlink", requestId: "word-overrides-unlink" });
  restoreOffscreen();
}

async function settingsLinkedAnkiDiscoveryStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) return null;
  const dom = new jsdom.JSDOM(readFileSync(resolve(EXTENSION, "settings.html"), "utf8"), {
    pretendToBeVisual: true, runScripts: "outside-only", url: `${EXTENSION_ORIGIN}/settings.html#anki`,
  });
  const { window } = dom;
  const document = window.document;
  const requests = [];
  let pendingWrite = null;
  const options = globalThis.HDReaderOptions.normaliseOptions({ anki: {
    ...globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki,
    model: "Basic",
    fieldTemplates: {
      Front: { value: "{expression}", overwriteMode: "coalesce" },
      Back: { value: "{definition}", overwriteMode: "coalesce" },
    },
  } });
  const storedOptions = { ...options, revision: 1 };
  const state = { schemaVersion: 1, revision: 1, groups: [], dictionaries: [] };
  window.chrome = {
    runtime: { async sendMessage(message) {
      requests.push(structuredClone(message));
      if (message.type === "hd_state_read") return { ok: true, state: structuredClone(state) };
      if (message.type === "hd_status") return { ok: true, ready: true, loading: false, dictionaryCount: 0 };
      if (message.type === "hd_anki_discover") return {
        ok: true,
        connected: true,
        model: message.model,
        decks: ["Default"],
        models: ["Basic"],
        fields: ["Front", "Back"],
        errors: [],
      };
      if (message.type === "hd_anki_setup") return {
        ok: true,
        proposal: { status: "already-configured" },
        outcome: { status: "already-configured", detail: null, model: "Basic", deck: "Default" },
      };
      if (message.type === "hd_options_write") {
        return new Promise(resolveReply => {
          pendingWrite = { message: structuredClone(message), requestIndex: requests.length - 1, resolveReply };
        });
      }
      throw new Error(`Unexpected linked Anki Settings request ${message.type}`);
    } },
    storage: {
      local: { async get() {
        return {
          options: structuredClone(storedOptions),
          sharing: { client: { address: "ws://127.0.0.1:8771/link" } },
        };
      } },
      onChanged: { addListener() {} },
    },
  };
  const pause = () => new Promise(resolvePause => setTimeout(resolvePause, 10));
  async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await pause();
    if (!predicate()) throw new Error("Linked Anki Settings did not reach its expected state");
  }
  try {
    loadSettingsScript(window);
    await until(() => requests.filter(request => request.type === "hd_anki_discover").length === 1);
    const url = document.getElementById("opt-anki-url");
    url.value = "https://host-new.example/anki";
    url.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => pendingWrite !== null);
    document.getElementById("anki-find-setup").click();
    const discoveriesBeforeSave = requests.filter(request => request.type === "hd_anki_discover").length;
    const setupChecksBeforeSave = requests.filter(request => request.type === "hd_anki_setup").length;
    const savedOptions = { ...storedOptions, ...pendingWrite.message.options, revision: 2 };
    pendingWrite.resolveReply({ ok: true, options: savedOptions });
    await until(() => requests.filter(request => request.type === "hd_anki_discover").length === 2);
    await until(() => requests.filter(request => request.type === "hd_anki_setup").length === 1);
    const discovery = requests.filter(request => request.type === "hd_anki_discover").at(-1);
    const setup = requests.find(request => request.type === "hd_anki_setup");
    return {
      discoveriesBeforeSave,
      setupChecksBeforeSave,
      writeIndex: pendingWrite.requestIndex,
      discoveryIndex: requests.lastIndexOf(discovery),
      setupIndex: requests.indexOf(setup),
      savedUrl: pendingWrite.message.options?.anki?.url,
      discoveryUrl: discovery.url,
      discoveryApiKey: discovery.apiKey,
      discoveryModel: discovery.model,
      setupUrl: setup.anki?.url,
      setupApiKey: setup.anki?.apiKey,
      setupModel: setup.anki?.model,
    };
  } finally {
    window.close();
  }
}

describe("Anki", () => {
  test("first-run Anki detection", async () => {
    await firstRunAnkiStage();
  });

  test("Anki in the worker", async () => {
    await ankiBackgroundStage();
  });

  test("Anki word status", async () => {
    await ankiWordStatusStage();
  });

  test("word status overrides", async () => {
    await wordStatusOverridesStage();
  });

  test("Anki screenshots", async () => {
    await ankiScreenshotStage();
  });

  test("linked Anki Settings discovery and setup checks", async () => {
    const linkedAnkiSettings = await settingsLinkedAnkiDiscoveryStage();
    check("linked Anki Settings saves endpoint drafts on the host before running host-owned discovery or setup checks",
      linkedAnkiSettings?.discoveriesBeforeSave === 1
        && linkedAnkiSettings.setupChecksBeforeSave === 0
        && linkedAnkiSettings.writeIndex >= 0
        && linkedAnkiSettings.discoveryIndex > linkedAnkiSettings.writeIndex
        && linkedAnkiSettings.setupIndex > linkedAnkiSettings.writeIndex
        && linkedAnkiSettings.savedUrl === "https://host-new.example/anki"
        && linkedAnkiSettings.discoveryUrl === "https://host-new.example/anki"
        && linkedAnkiSettings.discoveryApiKey === ""
        && linkedAnkiSettings.discoveryModel === "Basic"
        && linkedAnkiSettings.setupUrl === "https://host-new.example/anki"
        && linkedAnkiSettings.setupApiKey === ""
        && linkedAnkiSettings.setupModel === "Basic",
      JSON.stringify(linkedAnkiSettings));
  });
});
