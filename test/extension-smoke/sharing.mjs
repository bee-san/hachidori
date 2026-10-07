/*
 * Sharing: the host, the linked client and switching between them.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { runInContext } from "node:vm";
import { ANKI_INDEX_ALARM } from "../../extension/anki-index-cache.js";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_TITLE,
  customDictionarySemanticRevision,
  parseCustomDictionary,
} from "../../extension/custom-dictionary.js";
import {
  EXTENSION_ORIGIN,
  FakeSharingSocket,
  genericPackage,
  loadBackgroundScript,
  makeAlarms,
  makeBus,
  makeChrome,
  makeStorage,
  offscreenState,
} from "./fakes.mjs";
import { check, test } from "./harness.mjs";

// The host side of sharing: a fake WebSocket stands in for the Anki add-on's
// relay, and a fake offscreen engine answers the relayed lookup.
async function sharingHostStage() {
  FakeSharingSocket.instances.length = 0;
  const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
  const chrome = makeChrome("sharing-host-worker", bus, storage, alarms);
  const hostAnkiCalls = [];
  const hostSetupCalls = [];
  const hostSetupFetch = async (url, options) => {
    const request = JSON.parse(options.body);
    hostSetupCalls.push({ url, action: request.action, key: request.key ?? "", params: request.params });
    const results = {
      modelNamesAndIds: { Basic: 1 },
      deckNames: ["Default"],
      modelFieldNames: ["Front", "Back"],
    };
    return {
      ok: true,
      status: 200,
      async json() { return { result: results[request.action], error: null }; },
    };
  };
  const hostAnkiService = {
    status() { hostAnkiCalls.push(["status"]); return { available: true, configKey: "host-config" }; },
    view(request) {
      hostAnkiCalls.push(["view", structuredClone(request)]);
      return { state: "duplicate", canAdd: false, noteIds: [70, 71], configKey: "host-config", cached: true };
    },
    preflightClient(request) {
      hostAnkiCalls.push(["preflightClient", structuredClone(request)]);
      return { state: "addable", canAdd: true, clientSpeech: {
        sourceId: "default-tts",
        sourceKey: "host-source",
        expression: request.term.expression,
        reading: request.term.reading,
      } };
    },
    submitClient(request, clientMedia) {
      hostAnkiCalls.push(["submitClient", structuredClone(request), structuredClone(clientMedia)]);
      return { state: "added", noteId: 71, warnings: [] };
    },
    browse(request) {
      hostAnkiCalls.push(["browse", structuredClone(request)]);
      return { opened: true, noteIds: [71], repaired: true };
    },
    maturity(request) { hostAnkiCalls.push(["maturity", structuredClone(request)]); return { mature: true }; },
    screenshot() { hostAnkiCalls.push(["screenshot"]); return { token: "wrong-host" }; },
  };
  Object.assign(offscreenState, { created: 0, exists: false, concurrent: 0, peakConcurrent: 0 });
  const relayed = [];
  bus.addListener("sharing-engine", (message, sender, sendResponse) => {
    if (message?.target !== "hoshidicts-offscreen" || message.relayed !== true) return false;
    relayed.push(structuredClone(message));
    sendResponse({ type: `${message.type}_result`, requestId: message.requestId, ok: true, results: [{ matched: message.text }] });
    return true;
  });
  loadBackgroundScript({ chrome, console, fetch: hostSetupFetch, setTimeout, clearTimeout, Promise, Error, WebSocket: FakeSharingSocket,
    createAnkiWorkerService: () => hostAnkiService });
  const settle = async (predicate = () => false) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
    }
  };
  const send = (type, fields = {}) => bus.sendMessage("sharing-page", { target: "hachidori-sharing", type, requestId: `sharing-${type}`, ...fields });
  const hostSockets = () => FakeSharingSocket.instances.filter(socket => socket.url.endsWith("/host"));
  const sent = socket => socket.sent.filter(frame => frame.kind === "send").map(frame => JSON.parse(frame.text));
  const broadcasts = socket => socket.sent.filter(frame => frame.kind === "broadcast").map(frame => JSON.parse(frame.text));
  const clientText = (socket, text) => socket.receive({ kind: "client-text", clientId: "client-1", text });

  // Sharing is on from install but waits for something to share.
  await settle();
  const empty = await send("hd_sharing_status");
  const noSocketWhileEmpty = hostSockets().length === 0;
  const dictionary = { id: "host-dict", title: "Host", displayName: null, path: "/dicts/Host", enabled: true, favorite: false, revision: "1",
    isUpdatable: false, indexUrl: null, downloadUrl: null, language: "ja", frequencyMode: null, termCount: 3, frequencyCount: 0,
    pitchCount: 0, kanjiCount: 0, mediaCount: 0, installedAt: "2026-09-01T00:00:00.000Z", lastUpdateCheck: null };
  await storage.api().local.set({ dictionaryState: { schemaVersion: 1, revision: 1, dictionaries: [dictionary], groups: [] } });
  await settle(() => hostSockets().length >= 1);
  const initial = hostSockets()[0];
  const before = await send("hd_sharing_status");
  const enabled = await send("hd_sharing_host_enable", { port: 4321, network: true });
  await settle(() => hostSockets().length >= 2 && storage.raw.get("sharing")?.host?.enabled === true);
  const socket = hostSockets()[1];
  socket.open();
  socket.receive({ kind: "listening", port: 4321 });
  await settle(() => socket.sent.some(frame => frame.kind === "network"));
  const askedForNetwork = socket.sent.find(frame => frame.kind === "network");
  socket.receive({ kind: "network", enabled: true, addresses: [{ address: "100.75.152.75", kind: "tailscale" }, { address: "192.168.1.123", kind: "local" }] });
  socket.receive({ kind: "client-open", clientId: "client-1", origin: "chrome-extension://linkedbrowser", address: "127.0.0.1" });
  clientText(socket, JSON.stringify({ kind: "hello", protocol: 1, version: "0.1.0", name: "GSM",
    capabilities: ["linked-anki-v1"] }));
  await settle(() => sent(socket).length >= 1);
  const hello = sent(socket)[0];
  const listening = await send("hd_sharing_status");
  check("a browser install shares by default once it has dictionaries, connects to the relay on the chosen port, asks for the network it was set to, and answers a linked browser's hello with the shared snapshot",
    empty.sharing?.enabled === true && empty.sharing.connected === false && empty.sharing.dictionaries === 0 && noSocketWhileEmpty
      && before.sharing?.enabled === true && before.sharing.connected === false && before.sharing.error === null && before.sharing.dictionaries === 1
      && initial.url === "ws://127.0.0.1:8771/host" && initial.readyState === 3
      && enabled.ok === true && enabled.sharing.enabled === true && socket.url === "ws://127.0.0.1:4321/host"
      && storage.raw.get("sharing")?.host?.port === 4321 && storage.raw.get("sharing")?.host?.network === true
      && JSON.stringify(askedForNetwork) === JSON.stringify({ kind: "network", enabled: true })
      && listening.sharing.connected === true && listening.sharing.port === 4321
      && listening.sharing.network.enabled === true && listening.sharing.network.active === true
      && JSON.stringify(listening.sharing.network.addresses) === JSON.stringify([{ address: "100.75.152.75", kind: "tailscale" }, { address: "192.168.1.123", kind: "local" }])
      && listening.sharing.clients.length === 1 && listening.sharing.clients[0].name === "GSM"
      && JSON.stringify(listening.sharing.clients[0].capabilities) === JSON.stringify(["linked-anki-v1"])
      && listening.sharing.clients[0].address === "127.0.0.1" && listening.sharing.clients[0].local === true
      && hello?.kind === "hello" && hello.protocol === 1 && hello.version === "0.0.0-smoke" && hello.name === "another browser" && hello.dictionaryCount === 1
      && JSON.stringify(hello.capabilities) === JSON.stringify(["linked-anki-v1", "linked-anki-v2", "hoshidicts-api-v1", "linked-import-v1"])
      && JSON.stringify(Object.keys(hello.snapshot).sort()) === JSON.stringify(["customDictionarySource", "dictionaryState", "dictionaryUpdates", "lookupStats", "options",
        "wordStatusOverrides"])
      && hello.snapshot.options === null,
    JSON.stringify({ empty, noSocketWhileEmpty, before, enabled, askedForNetwork, listening, hello, sockets: FakeSharingSocket.instances.map(s => [s.url, s.readyState]) }));

  clientText(socket, JSON.stringify({ kind: "request", id: "r1",
    message: { target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "lookup-9", text: "猫" } }));
  await settle(() => sent(socket).length >= 2);
  const lookup = sent(socket)[1];
  const lookupRelays = relayed.filter(message => message.type === "hd_lookup");
  check("a forwarded lookup reaches the engine once and returns its exact reply",
    lookupRelays.length === 1 && lookupRelays[0].text === "猫" && lookupRelays[0].requestId === "lookup-9"
      && lookup?.kind === "reply" && lookup.id === "r1" && lookup.response?.type === "hd_lookup_result"
      && lookup.response.ok === true && lookup.response.requestId === "lookup-9" && lookup.response.results?.[0]?.matched === "猫",
    JSON.stringify({ relayed, lookup }));

  // The relay's Yomitan API asks as a client of its own; the answers are the
  // contract's plain objects, not runtime reply envelopes.
  clientText(socket, JSON.stringify({ kind: "request", id: "api-1", message: { target: "hoshidicts-offscreen", type: "hd_api_version" } }));
  clientText(socket, JSON.stringify({ kind: "request", id: "api-2", message: { target: "hoshidicts-offscreen", type: "hd_api_dictionaries" } }));
  clientText(socket, JSON.stringify({ kind: "request", id: "api-3", message: { target: "hoshidicts-offscreen", type: "hd_api_dictionary_open", id: "missing" } }));
  await settle(() => sent(socket).length >= 5);
  const api = Object.fromEntries(sent(socket).slice(2, 5).map(frame => [frame.id, frame.response]));
  check("the relay's API requests are answered by the host with the contract's objects",
    JSON.stringify(api["api-1"]) === JSON.stringify({ version: "0.0.0-smoke" })
      && JSON.stringify(api["api-2"]) === JSON.stringify({ dictionaries: [{ id: "host-dict", title: "Host", revision: "1", fileName: "Host.hachidori.zip" }] })
      && JSON.stringify(api["api-3"]) === JSON.stringify({ error: "unknown dictionary", notFound: true })
      && !relayed.some(message => message.type.startsWith("hd_api_")),
    JSON.stringify(api));

  clientText(socket, JSON.stringify({ kind: "request", id: "r2",
    message: { target: "hoshidicts-worker", type: "hd_options_write", requestId: "write-1", baseRevision: 0, options: { hoverEnabled: false } } }));
  await settle(() => sent(socket).length >= 6 && broadcasts(socket).length >= 1);
  const written = sent(socket)[5];
  const broadcast = broadcasts(socket)[0];
  await storage.api().local.set({ setupState: { stage: "welcome" } });
  await settle();
  clientText(socket, JSON.stringify({ kind: "request", id: "r3", message: { target: "hachidori-audio", type: "hd_audio_play", requestId: "audio-1" } }));
  await settle(() => sent(socket).length >= 7);
  const refused = sent(socket)[6];
  clientText(socket, JSON.stringify({ kind: "request", id: "r4",
    message: { target: "hoshidicts-worker", type: "hd_open_external", requestId: "external-1", url: "https://client.invalid/" } }));
  await settle(() => sent(socket).length >= 8);
  const refusedWorker = sent(socket)[7];
  check("the host accepts only forwardable linked requests, commits shared writes and keeps local-only actions home",
    written?.kind === "reply" && written.id === "r2" && written.response?.ok === true && written.response.options?.hoverEnabled === false
      && storage.raw.get("options")?.hoverEnabled === false
      && broadcast?.kind === "storage" && JSON.stringify(Object.keys(broadcast.changes)) === JSON.stringify(["options"])
      && broadcast.changes.options.revision === written.response.options.revision
      && broadcasts(socket).length === 1
      && refused?.kind === "reply" && refused.id === "r3" && refused.response?.ok === false
      && /unsupported shared request target/u.test(refused.response.error)
      && refusedWorker?.kind === "reply" && refusedWorker.id === "r4" && refusedWorker.response?.ok === false
      && /unsupported shared request/u.test(refusedWorker.response.error),
    JSON.stringify({ written, broadcasts: broadcasts(socket), refused, refusedWorker }));

  const readerOptions = globalThis.HDReaderOptions;
  const exactWordMapping = " \tword {expression}{expression} {unknown}\n literal  ";
  const exactSentenceMapping = "\n{sentence} + literal\t{sentence}\n";
  const richAnki = readerOptions.normaliseAnki({
    url: "https://host.example/original",
    apiKey: "host-key",
    templates: [
      {
        ...readerOptions.DEFAULT_ANKI_TEMPLATE,
        id: "word-template",
        name: "Word card",
        deck: "Words",
        model: "Basic",
        fields: { ...readerOptions.DEFAULT_ANKI_TEMPLATE.fields, expression: "Front" },
        fieldTemplates: {
          Front: { value: exactWordMapping, overwriteMode: "coalesce" },
        },
      },
      {
        ...readerOptions.DEFAULT_ANKI_TEMPLATE,
        id: "sentence-template",
        name: "Sentence card",
        deck: "Sentences",
        model: "Sentence",
        fields: { ...readerOptions.DEFAULT_ANKI_TEMPLATE.fields, sentence: "Front" },
        fieldTemplates: {
          Front: { value: exactSentenceMapping, overwriteMode: "prepend" },
        },
      },
    ],
  });
  const richOptions = readerOptions.normaliseOptions({
    ...storage.raw.get("options"),
    anki: richAnki,
    customButtons: [
      { id: "host-link-a", type: "link", label: "A", url: "https://a.example/%w" },
      { id: "host-sentence", type: "anki", label: "Sentence", templateId: "sentence-template" },
      { id: "host-link-b", type: "link", label: "B", url: "https://b.example/%w" },
    ],
  });
  richOptions.revision = storage.raw.get("options").revision + 1;
  await storage.api().local.set({ options: richOptions });

  let beforeLegacy = sent(socket).length;
  clientText(socket, JSON.stringify({ kind: "request", id: "legacy-links", message: {
    target: "hoshidicts-worker",
    type: "hd_options_write",
    requestId: "legacy-links-write",
    baseRevision: richOptions.revision,
    options: { customLinks: [
      { label: "B", url: "https://b.example/%w" },
      { label: "C", url: "https://c.example/%w" },
      { label: "A", url: "https://a.example/%w" },
    ] },
  } }));
  await settle(() => sent(socket).length > beforeLegacy);
  const legacyLinksReply = sent(socket).at(-1);
  const afterLegacyLinks = storage.raw.get("options");

  const legacyAnki = Object.fromEntries(["url", "apiKey", ...readerOptions.ANKI_TEMPLATE_CONFIG_KEYS]
    .map(key => [key, structuredClone(afterLegacyLinks.anki[key])]));
  Object.assign(legacyAnki, {
    url: "https://legacy.example/anki",
    apiKey: "legacy-key",
    deck: "Legacy words",
    model: "Legacy Basic",
    tags: ["legacy"],
  });
  beforeLegacy = sent(socket).length;
  clientText(socket, JSON.stringify({ kind: "request", id: "legacy-anki", message: {
    target: "hoshidicts-worker",
    type: "hd_options_write",
    requestId: "legacy-anki-write",
    baseRevision: afterLegacyLinks.revision,
    options: { anki: legacyAnki },
  } }));
  await settle(() => sent(socket).length > beforeLegacy);
  const legacyAnkiReply = sent(socket).at(-1);
  const afterLegacyAnki = storage.raw.get("options");
  const beforeRichWrite = JSON.stringify(afterLegacyAnki);

  beforeLegacy = sent(socket).length;
  clientText(socket, JSON.stringify({ kind: "request", id: "legacy-rich-write", message: {
    target: "hoshidicts-worker",
    type: "hd_options_write",
    requestId: "legacy-rich-write",
    baseRevision: afterLegacyAnki.revision,
    options: { customButtons: [
      { id: "erase", type: "link", label: "Erase", url: "https://erase.invalid/" },
    ] },
  } }));
  await settle(() => sent(socket).length > beforeLegacy);
  const legacyRichReply = sent(socket).at(-1);
  check("a legacy linked reader can edit its first Anki setup and link list without erasing newer Templates or Anki buttons",
    legacyLinksReply.response?.ok === true
      && legacyAnkiReply.response?.ok === true
      && JSON.stringify(afterLegacyLinks.customLinks.map(link => link.label)) === JSON.stringify(["B", "C", "A"])
      && afterLegacyLinks.customButtons[0]?.id === "host-link-b"
      && afterLegacyLinks.customButtons[1]?.id === "host-sentence"
      && afterLegacyLinks.customButtons[1]?.templateId === "sentence-template"
      && afterLegacyLinks.customButtons[3]?.id === "host-link-a"
      && afterLegacyAnki.anki.url === "https://legacy.example/anki"
      && afterLegacyAnki.anki.apiKey === "legacy-key"
      && afterLegacyAnki.anki.templates[0]?.id === "word-template"
      && afterLegacyAnki.anki.templates[0]?.name === "Word card"
      && afterLegacyAnki.anki.templates[0]?.deck === "Legacy words"
      && afterLegacyAnki.anki.templates[0]?.model === "Legacy Basic"
      && afterLegacyAnki.anki.templates[0]?.fieldTemplates?.Front?.value === exactWordMapping
      && afterLegacyAnki.anki.templates[1]?.id === "sentence-template"
      && afterLegacyAnki.anki.templates[1]?.name === "Sentence card"
      && afterLegacyAnki.anki.templates[1]?.fieldTemplates?.Front?.value === exactSentenceMapping
      && afterLegacyAnki.customButtons.some(button => button.id === "host-sentence")
      && legacyRichReply.response?.ok === false
      && /Update the linked Hachidori/u.test(legacyRichReply.response.error)
      && JSON.stringify(storage.raw.get("options")) === beforeRichWrite,
    JSON.stringify({ legacyLinksReply, legacyAnkiReply, legacyRichReply, afterLegacyLinks, afterLegacyAnki }));

  const currentOptions = storage.raw.get("options");
  const setupBase = globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE;
  const setupAnki = globalThis.HDReaderOptions.normaliseAnki({
    url: "https://host.example/anki",
    apiKey: "host-secret",
    templates: [
      {
        ...setupBase,
        id: "first-template",
        name: "First",
        model: "Basic",
        deck: "Unavailable deck",
        fieldTemplates: {
          Front: { value: "{expression}", overwriteMode: "coalesce" },
          Back: { value: "{definition}", overwriteMode: "coalesce" },
        },
      },
      {
        ...setupBase,
        id: "setup-template",
        name: "Setup",
        model: "Basic",
        deck: "Default",
        fieldTemplates: {
          Front: { value: "{expression}", overwriteMode: "coalesce" },
          Back: { value: "{definition}", overwriteMode: "coalesce" },
        },
      },
    ],
  });
  await storage.api().local.set({ options: {
    ...currentOptions,
    anki: setupAnki,
    revision: currentOptions.revision + 1,
  } });
  const beforeSetup = sent(socket).length;
  clientText(socket, JSON.stringify({ kind: "request", id: "anki-setup", message: {
    target: "hoshidicts-worker",
    type: "hd_anki_setup",
    requestId: "host-hd_anki_setup",
    templateId: "setup-template",
    anki: {
      model: "Client model",
      deck: "Client deck",
      url: "https://client.invalid/anki",
      apiKey: "client-secret",
    },
  } }));
  await settle(() => sent(socket).length > beforeSetup);
  const linkedSetup = sent(socket).at(-1);

  const ankiRequest = {
    term: { expression: "猫", reading: "ねこ" },
    generation: 3,
    trace: [],
    configKey: "",
    url: "https://client.invalid/anki",
    apiKey: "client-secret",
    anki: { url: "https://client.invalid/anki", apiKey: "client-secret" },
  };
  const askAnki = async (id, type, fields = {}) => {
    const beforeCount = sent(socket).length;
    clientText(socket, JSON.stringify({ kind: "request", id, message: {
      target: "hachidori-anki", type, requestId: `host-${type}`, ...fields,
    } }));
    await settle(() => sent(socket).length > beforeCount);
    return sent(socket).at(-1);
  };
  const ankiView = await askAnki("anki-view", "hd_anki_view", { request: ankiRequest });
  const ankiStatus = await askAnki("anki-status", "hd_anki_status");
  ankiRequest.configKey = ankiStatus.response?.configKey;
  const staleHostKey = await askAnki("anki-stale-key", "hd_anki_preflight", {
    request: { ...ankiRequest, configKey: "host-config" },
  });
  const ankiPreflight = await askAnki("anki-preflight", "hd_anki_preflight", { request: ankiRequest });
  const ankiSubmit = await askAnki("anki-submit", "hd_anki_submit", { request: ankiRequest, clientMedia: {} });
  const ankiBrowse = await askAnki("anki-browse", "hd_anki_browse", {
    request: { noteIds: [71], expression: "猫", configKey: ankiRequest.configKey, apiKey: "client-secret" },
  });
  const staleBrowse = await askAnki("anki-stale-browse", "hd_anki_browse", {
    request: { noteIds: [71], expression: "猫", configKey: "host-config" },
  });
  const ankiMaturity = await askAnki("anki-maturity", "hd_anki_maturity", {
    request: { term: { expression: "猫", reading: "ねこ", url: "https://client.invalid" } },
  });
  const hostScreenshot = await askAnki("anki-screenshot", "hd_anki_screenshot");
  const submitted = hostAnkiCalls.find(call => call[0] === "submitClient");
  check("linked Anki Settings and mining use the host configuration and singleton while page-local screenshots are refused",
    linkedSetup?.kind === "reply" && linkedSetup.id === "anki-setup"
      && linkedSetup.response?.ok === true && linkedSetup.response.outcome?.status === "already-configured"
      && linkedSetup.response.outcome.model === "Basic" && linkedSetup.response.outcome.deck === "Default"
      && JSON.stringify(hostSetupCalls.map(call => call.action)) === JSON.stringify([
        "modelNamesAndIds", "deckNames", "modelFieldNames",
      ])
      && hostSetupCalls.every(call => call.url === "https://host.example/anki" && call.key === "host-secret")
      && ankiView.response?.cached === true && JSON.stringify(ankiView.response.noteIds) === JSON.stringify([70, 71])
      && /^linked:[0-9a-f-]+:host-config$/u.test(ankiView.response.configKey)
      && ankiStatus.response?.available === true && /^linked:[0-9a-f-]+:host-config$/u.test(ankiStatus.response.configKey)
      && staleHostKey.response?.ok === false && /configuration changed/u.test(staleHostKey.response.error)
      && ankiPreflight.response?.state === "addable" && ankiSubmit.response?.state === "added"
      && ankiBrowse.response?.opened === true && ankiMaturity.response?.mature === true
      && staleBrowse.response?.ok === false && /configuration changed/u.test(staleBrowse.response.error)
      && hostScreenshot.response?.ok === false && /unsupported linked Anki request/u.test(hostScreenshot.response.error)
      && JSON.stringify(hostAnkiCalls.map(call => call[0])) === JSON.stringify([
        "view", "status", "preflightClient", "submitClient", "browse", "maturity",
      ])
      && JSON.stringify(hostAnkiCalls[0][1]) === JSON.stringify({ term: { expression: "猫", reading: "ねこ" } })
      && submitted?.[1]?.url === undefined && submitted?.[1]?.apiKey === undefined && submitted?.[1]?.anki === undefined
      && submitted?.[1]?.configKey === "host-config"
      && submitted?.[1]?.term?.expression === "猫" && JSON.stringify(submitted?.[2]) === JSON.stringify({}),
    JSON.stringify({ linkedSetup, hostSetupCalls, ankiView, ankiStatus, staleHostKey, ankiPreflight, ankiSubmit, ankiBrowse,
      staleBrowse, ankiMaturity, hostScreenshot, hostAnkiCalls }));

  socket.drop();
  await settle();
  const relayedBeforeLateFrame = relayed.length;
  clientText(socket, JSON.stringify({ kind: "request", id: "late",
    message: { target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "late-lookup", text: "遅い" } }));
  await settle();
  const retiredHostFrameIgnored = relayed.length === relayedBeforeLateFrame;
  const dropped = await send("hd_sharing_status");
  const retrying = alarms.values.has("hachidori-sharing-host");
  // The first retry follows the capture host's backoff: 500 ms.
  for (let attempt = 0; attempt < 400 && hostSockets().length < 3; attempt += 1) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
  }
  const retried = hostSockets()[2];
  retried.open();
  retried.receive({ kind: "listen-failed", error: "Another browser on this computer is already sharing through Anki." });
  await settle();
  const refusedHost = await send("hd_sharing_status");
  const restartBus = makeBus();
  const restartChrome = makeChrome("sharing-host-restart", restartBus, storage, makeAlarms());
  const socketsBefore = FakeSharingSocket.instances.length;
  loadBackgroundScript({ chrome: restartChrome, console, setTimeout, clearTimeout, Promise, Error, WebSocket: FakeSharingSocket });
  await settle(() => FakeSharingSocket.instances.length > socketsBefore);
  const restarted = FakeSharingSocket.instances[socketsBefore];
  const disabled = await send("hd_sharing_host_disable");
  await settle(() => storage.raw.get("sharing")?.host === null);
  const off = await restartBus.sendMessage("sharing-page", { target: "hachidori-sharing", type: "hd_sharing_host_disable", requestId: "restart-off" });
  check("a relay that goes away is waited for and retried by alarm, a refusal is reported, a restarted worker reconnects to the stored port, and turning sharing off closes the socket",
    dropped.sharing.enabled === true && dropped.sharing.connected === false && dropped.sharing.error === null
      && dropped.sharing.clients.length === 0 && dropped.sharing.network.active === false && dropped.sharing.network.addresses.length === 0 && retrying
      && retiredHostFrameIgnored
      && refusedHost.sharing.error === "Another browser on this computer is already sharing through Anki."
      && restarted?.url === "ws://127.0.0.1:4321/host"
      && disabled.ok === true && disabled.sharing.enabled === false && disabled.sharing.error === null
      && !alarms.values.has("hachidori-sharing-host") && storage.raw.get("sharing")?.host === null
      && off.ok === true && restarted.readyState === 3,
    JSON.stringify({ dropped, retrying, retiredHostFrameIgnored, refusedHost, disabled, off,
      sockets: FakeSharingSocket.instances.map(s => [s.url, s.readyState]) }));
}

async function sharingClientStage() {
  FakeSharingSocket.instances.length = 0;
  const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
  const chrome = makeChrome("sharing-client-worker", bus, storage, alarms);
  const localAnkiCalls = [];
  const localScreenshot = {
    token: "client-screenshot",
    filename: "hachidori-screenshot-123e4567-e89b-42d3-a456-426614174000.jpg",
  };
  const localAnkiService = {
    screenshot() {
      localAnkiCalls.push(["screenshot"]);
      return localScreenshot;
    },
    discardScreenshot(request) {
      localAnkiCalls.push(["discardScreenshot", structuredClone(request)]);
      return { discarded: true };
    },
    clientMedia(request) {
      localAnkiCalls.push(["clientMedia", structuredClone(request)]);
      return {
        ...(request?.screenshot ? { screenshot: { ...request.screenshot, data: "AQI=" } } : {}),
        ...(request?.clientSpeech ? { speech: {
          ...request.clientSpeech,
          filename: `hachidori_${"a".repeat(64)}.wav`,
          byteLength: 4,
          data: "UklGRg==",
        } } : {}),
      };
    },
    preflightClientSpeech(request) {
      localAnkiCalls.push(["preflightClientSpeech", structuredClone(request)]);
      return { available: true };
    },
    settleClientMedia(request, state) {
      localAnkiCalls.push(["settleClientMedia", structuredClone(request), state]);
      return { settled: true };
    },
    status() {
      localAnkiCalls.push(["status"]);
      return localStatusGate ?? { available: true, configKey: "local-config", error: null };
    },
    view() { throw new Error("linked View readiness ran in the reading browser"); },
    preflight() { throw new Error("linked preflight ran in the reading browser"); },
    preflightMany() { throw new Error("linked batch preflight ran in the reading browser"); },
    submit() { throw new Error("linked submit ran in the reading browser"); },
    browse() { throw new Error("linked browse ran in the reading browser"); },
    maturity() { throw new Error("linked maturity ran in the reading browser"); },
  };
  const localDictionary = { id: "local-id", title: "Local", displayName: null, path: "/dicts/Local", enabled: true, favorite: false,
    revision: "1", isUpdatable: false, indexUrl: null, downloadUrl: null, language: "ja", frequencyMode: null,
    termCount: 3, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, mediaCount: 0, installedAt: "2026-09-01T00:00:00.000Z", lastUpdateCheck: null };
  const localState = { schemaVersion: 1, revision: 2, dictionaries: [localDictionary], groups: [] };
  const localStats = { generation: "local-gen", revision: 1 };
  const localRow = { term: "猫", reading: "ねこ", lookupCount: 4, firstLookedUpAt: 1, lastLookedUpAt: 2 };
  const linkedMapping = " \tlinked {expression}{expression} {unknown}\n literal  ";
  const linkedAnki = globalThis.HDReaderOptions.normaliseAnki({
    templates: [{
      ...globalThis.HDReaderOptions.DEFAULT_ANKI_TEMPLATE,
      id: "linked-template",
      name: "Linked",
      model: "Basic",
      fieldTemplates: {
        Front: { value: linkedMapping, overwriteMode: "coalesce" },
      },
    }],
  });
  await storage.api().local.set({
    options: { hoverEnabled: true, revision: 3 },
    dictionaryState: localState,
    lookupStats: localStats,
    ['lookupStats:"local-gen":["猫","ねこ"]']: localRow,
  });
  storage.sets.length = 0;
  loadBackgroundScript({ chrome, console, setTimeout, clearTimeout, Promise, Error, WebSocket: FakeSharingSocket,
    createAnkiWorkerService: () => localAnkiService });
  const settle = async (predicate = () => false) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
    }
  };
  const send = (type, fields = {}, target = "hachidori-sharing") => bus.sendMessage("sharing-client-page",
    { target, type, requestId: `client-${type}`, ...fields });
  const engineSender = { id: "hachidorismokeextensionid", url: `${EXTENSION_ORIGIN}/offscreen.html` };
  const hostDictionary = { ...localDictionary, id: "host-id", title: "Host", path: "/dicts/Host", termCount: 900 };
  const hostSnapshot = {
    dictionaryState: { schemaVersion: 1, revision: 7, dictionaries: [hostDictionary], groups: [] },
    options: { hoverEnabled: false, revision: 1, anki: linkedAnki },
    customDictionarySource: null,
    dictionaryUpdates: { revision: 0, schedule: "off", lastCheckedAt: null },
    lookupStats: { generation: "host-gen", revision: 40 },
  };
  const hello = { kind: "hello", protocol: 1, version: "9.9.9", name: "Chrome", dictionaryCount: 1,
    capabilities: ["linked-anki-v1", "linked-anki-v2"], snapshot: hostSnapshot };
  let releaseLocalStatus;
  let localStatusGate = null;

  // Linking stops this install's own hosting first (sharing is on by default,
  // and this install has a dictionary), then probes, then keeps one connection.
  const hostSockets = () => FakeSharingSocket.instances.filter(entry => entry.url.endsWith("/host"));
  const linkSockets = () => FakeSharingSocket.instances.filter(entry => entry.url.endsWith("/link"));
  await settle(() => hostSockets().length >= 1);
  const ownHost = hostSockets()[0];
  const failing = send("hd_sharing_client_link", { address: "127.0.0.1:9999" });
  await settle(() => linkSockets().length >= 1);
  const hostClosedForProbe = ownHost.readyState === 3;
  linkSockets()[0].drop();
  const refusedLink = await failing;
  await settle(() => hostSockets().length >= 2);
  const hostBack = hostSockets()[1];
  check("a link that finds nothing puts this install's own sharing back",
    hostClosedForProbe && refusedLink.ok === false && refusedLink.error === "No shared Hachidori answered at ws://127.0.0.1:9999/link."
      && hostBack?.url === "ws://127.0.0.1:8771/host" && hostBack.readyState !== 3
      && storage.raw.get("sharing") === undefined && !storage.raw.has("sharingLocalState"),
    JSON.stringify({ hostClosedForProbe, refusedLink, sockets: FakeSharingSocket.instances.map(s => [s.url, s.readyState]) }));

  localStatusGate = new Promise(resolve => { releaseLocalStatus = resolve; });
  const localStatus = send("hd_anki_status", {}, "hachidori-anki");
  await settle(() => localAnkiCalls.some(call => call[0] === "status"));
  const linking = send("hd_sharing_client_link", { address: "127.0.0.1:9100" });
  await settle(() => linkSockets().length >= 2);
  const probe = linkSockets()[1];
  probe.open();
  await settle(() => probe.sent.length >= 1);
  probe.receive(hello);
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  const linkWaitedForLocalAnki = linkSockets().length === 2 && !storage.raw.has("sharingLocalState");
  releaseLocalStatus({ available: true, configKey: "local-config", error: null });
  const localStatusReply = await localStatus;
  localStatusGate = null;
  await settle(() => linkSockets().length >= 3);
  const socket = linkSockets()[2];
  socket.open();
  await settle(() => socket.sent.length >= 1);
  socket.receive(hello);
  const linkedReply = await linking;
  // The kept connection's own hello lands after the reply; wait for it.
  let linkedStatus = await send("hd_sharing_status");
  for (let attempt = 0; attempt < 200 && !linkedStatus.sharing?.client?.connected; attempt += 1) {
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
    linkedStatus = await send("hd_sharing_status");
  }
  const mirrorSet = storage.sets.find(keys => keys.includes("dictionaryState") && keys.includes("options") && keys.includes("lookupStats"));
  check("linking keeps this install's shared state aside and mirrors the host's snapshot in one write",
    probe.url === "ws://127.0.0.1:9100/link" && probe.sent[0]?.kind === "hello"
      && JSON.stringify(probe.sent[0]?.capabilities) === JSON.stringify(["linked-anki-v1", "linked-anki-v2"]) && probe.readyState === 3
      && socket.sent[0]?.kind === "hello" && socket.sent[0].protocol === 1
      && JSON.stringify(socket.sent[0]?.capabilities) === JSON.stringify(["linked-anki-v1", "linked-anki-v2"])
      && linkedReply.ok === true && linkedReply.sharing.client.linked === true && linkedReply.sharing.client.address === "ws://127.0.0.1:9100/link"
      && linkedReply.sharing.client.display === "this computer"
      && linkedStatus.sharing.client.connected === true && linkedStatus.sharing.client.host?.name === "Chrome"
      && JSON.stringify(linkedStatus.sharing.client.host?.capabilities) === JSON.stringify(["linked-anki-v1", "linked-anki-v2"])
      && linkedReply.sharing.enabled === false && hostBack.readyState === 3 && storage.raw.get("sharing")?.host?.enabled === false
      && linkWaitedForLocalAnki && localStatusReply.available === true
      && JSON.stringify(storage.raw.get("sharingLocalState")) === JSON.stringify({ dictionaryState: localState, options: { hoverEnabled: true, revision: 3 },
        customDictionarySource: null, dictionaryUpdates: null, lookupStats: localStats, wordStatusOverrides: null })
      && JSON.stringify(storage.raw.get("dictionaryState")) === JSON.stringify(hostSnapshot.dictionaryState)
      && JSON.stringify(storage.raw.get("options")) === JSON.stringify(hostSnapshot.options)
      && JSON.stringify(storage.raw.get("lookupStats")) === JSON.stringify(hostSnapshot.lookupStats)
      && !storage.raw.has("customDictionarySource") && mirrorSet !== undefined
      && storage.raw.get("sharing")?.client?.address === "ws://127.0.0.1:9100/link",
    JSON.stringify({ linkedReply, linkedStatus, linkWaitedForLocalAnki, localStatusReply,
      sets: storage.sets, local: storage.raw.get("sharingLocalState"), sockets: FakeSharingSocket.instances.map(s => s.url) }));

  // Page requests forward and take the host's reply verbatim; the mirror only
  // moves when the host pushes its storage batch.
  const setsBefore = storage.sets.length;
  const pushedOptions = { ...hostSnapshot.options, hoverEnabled: true, revision: 2 };
  const writing = send("hd_options_write", {
    baseRevision: 1,
    options: { hoverEnabled: true, anki: structuredClone(linkedAnki) },
  }, "hoshidicts-worker");
  await settle(() => socket.requests().length >= 1);
  const forwardedWrite = socket.requests()[0];
  socket.receive({ kind: "reply", id: forwardedWrite.id, response: {
    type: "hd_options_write_result", requestId: "client-hd_options_write", ok: true, error: null, options: pushedOptions,
  } });
  const written = await writing;
  const beforePush = storage.raw.get("options").revision;
  socket.receive({ kind: "storage", changes: { options: pushedOptions } });
  await settle(() => storage.raw.get("options").revision === 2);
  const looking = send("hd_lookup", { text: "猫" }, "hoshidicts-offscreen");
  await settle(() => socket.requests().length >= 2);
  const forwardedLookup = socket.requests()[1];
  socket.receive({ kind: "reply", id: forwardedLookup.id, response: { type: "hd_lookup_result", requestId: "client-hd_lookup", ok: true, error: null, results: [{ matched: "猫" }], generation: 3 } });
  const looked = await looking;
  const counting = send("hd_lookup_stats_record", { term: "猫", reading: "ねこ" }, "hoshidicts-worker");
  await settle(() => socket.requests().length >= 3);
  const forwardedCount = socket.requests()[2];
  socket.receive({ kind: "reply", id: forwardedCount.id, response: { type: "hd_lookup_stats_record_result", requestId: "client-hd_lookup_stats_record", ok: true, error: null, descriptor: { generation: "host-gen", revision: 41 }, statistics: { term: "猫", reading: "ねこ", lookupCount: 9 } } });
  const counted = await counting;
  const rowKey = 'lookupStats:"host-gen":["猫","ねこ"]';
  socket.receive({ kind: "storage", changes: { lookupStats: { generation: "host-gen", revision: 41 }, [rowKey]: { term: "猫", reading: "ねこ", lookupCount: 9, firstLookedUpAt: 1, lastLookedUpAt: 3 } } });
  await settle(() => storage.raw.has(rowKey));
  const rowSet = storage.sets.slice(setsBefore).find(keys => keys.includes("lookupStats") && keys.includes(rowKey));
  check("a linked page's writes, lookups and lookup counts go to the host, whose storage batches land locally as single writes",
    forwardedWrite.message.type === "hd_options_write" && forwardedWrite.message.target === "hoshidicts-worker" && forwardedWrite.message.baseRevision === 1
      && forwardedWrite.message.options.anki.templates[0].fieldTemplates.Front.value === linkedMapping
      && written.ok === true && written.options.revision === 2 && written.requestId === "client-hd_options_write"
      && beforePush === 1 && storage.raw.get("options").revision === 2
      && storage.raw.get("options").anki.templates[0].fieldTemplates.Front.value === linkedMapping
      && forwardedLookup.message.type === "hd_lookup" && forwardedLookup.message.text === "猫" && looked.results?.[0]?.matched === "猫"
      && bus.log.every(entry => !(entry.type === "hd_lookup" && entry.relayed))
      && forwardedCount.message.type === "hd_lookup_stats_record" && counted.statistics?.lookupCount === 9
      && rowSet !== undefined && rowSet.length === 2
      && storage.sets.slice(setsBefore).every(keys => keys.every(key => key !== "options" || true)),
    JSON.stringify({ forwardedWrite, written, looked, counted, sets: storage.sets.slice(setsBefore) }));

  const askLinkedAnki = async (type, fields, result) => {
    const beforeRequests = socket.requests().length;
    const pending = send(type, fields, "hachidori-anki");
    await settle(() => socket.requests().length > beforeRequests);
    const forwarded = socket.requests().at(-1);
    socket.receive({ kind: "reply", id: forwarded.id, response: {
      type: `${type}_result`, requestId: `client-${type}`, ok: true, error: null, ...result,
    } });
    return { forwarded, reply: await pending };
  };
  const linkedRequest = {
    term: { expression: "猫", reading: "ねこ" },
    generation: 7,
    trace: [],
    configKey: "host-config",
    screenshot: localScreenshot,
  };
  const linkedSpeech = {
    sourceId: "default-tts",
    sourceKey: "host-source",
    expression: "猫",
    reading: "ねこ",
  };
  const ankiView = await askLinkedAnki("hd_anki_view", { request: { term: linkedRequest.term } },
    { state: "duplicate", canAdd: false, noteIds: [81, 82], configKey: "host-config", cached: true });
  const ankiStatus = await askLinkedAnki("hd_anki_status", {}, { available: true, configKey: "host-config" });
  const ankiPreflight = await askLinkedAnki("hd_anki_preflight", { request: linkedRequest },
    { state: "addable", canAdd: true, clientSpeech: linkedSpeech });
  // A popup batch crosses the link as today's single preflights, sent
  // together, so a host without batches keeps answering. The host replies
  // out of order; each reply still lands on its own entry.
  const batchRequests = [structuredClone(linkedRequest),
    { ...structuredClone(linkedRequest), term: { expression: "犬", reading: "いぬ" } }];
  const batchStart = socket.requests().length;
  const batching = send("hd_anki_preflight_batch", { requests: batchRequests }, "hachidori-anki");
  await settle(() => socket.requests().length >= batchStart + 2);
  const batchForwards = socket.requests().slice(batchStart);
  const batchReplies = [{ state: "addable", canAdd: true, clientSpeech: linkedSpeech },
    { ok: false, error: "The dictionary generation changed." }];
  for (const index of [1, 0]) {
    socket.receive({ kind: "reply", id: batchForwards[index].id, response: {
      type: "hd_anki_preflight_result", requestId: batchForwards[index].message.requestId, ok: true, error: null,
      ...batchReplies[index],
    } });
  }
  const batched = await batching;
  check("a linked browser forwards a popup batch to its host as single preflights and keeps each reply with its entry",
    batchForwards.length === 2
      && batchForwards.every((forwarded, index) => forwarded.message.target === "hachidori-anki"
        && forwarded.message.type === "hd_anki_preflight"
        && JSON.stringify(forwarded.message.request) === JSON.stringify(batchRequests[index]))
      && batched.ok === true && batched.type === "hd_anki_preflight_batch_result"
      && JSON.stringify(batched.replies) === JSON.stringify([
        { error: null, state: "addable", canAdd: true, clientSpeech: linkedSpeech },
        { state: "error", canAdd: false, error: "The dictionary generation changed." },
      ])
      && JSON.stringify(localAnkiCalls.filter(call => call[0] === "preflightClientSpeech").at(-1)?.[1])
        === JSON.stringify({ ...batchRequests[0], clientSpeech: linkedSpeech }),
    JSON.stringify({ batchForwards, batched, localAnkiCalls }));
  linkedRequest.clientSpeech = ankiPreflight.reply.clientSpeech;
  const screenshot = await send("hd_anki_screenshot", { request: {} }, "hachidori-anki");
  const requestsBeforeSubmit = socket.requests().length;
  const ankiSubmit = await askLinkedAnki("hd_anki_submit", { request: linkedRequest },
    { state: "added", noteId: 82, warnings: [] });
  const ankiBrowse = await askLinkedAnki("hd_anki_browse", {
    request: { noteIds: [82], expression: "猫", configKey: linkedRequest.configKey },
  },
    { opened: true });
  const ankiMaturity = await askLinkedAnki("hd_anki_maturity", { request: { term: linkedRequest.term } },
    { mature: true });
  const rejectedRequest = { ...linkedRequest, term: { expression: "犬", reading: "いぬ" } };
  delete rejectedRequest.screenshot;
  delete rejectedRequest.clientSpeech;
  const beforeRejected = socket.requests().length;
  const rejecting = send("hd_anki_submit", { request: rejectedRequest }, "hachidori-anki");
  await settle(() => socket.requests().length > beforeRejected);
  const forwardedRejected = socket.requests().at(-1);
  socket.receive({ kind: "reply", id: forwardedRejected.id, response: {
    type: "hd_anki_submit_result", requestId: "client-hd_anki_submit", ok: false,
    error: "The dictionary generation changed.", generation: 0,
  } });
  const rejected = await rejecting;
  const localOperations = localAnkiCalls.map(call => call[0]);
  check("linked Anki preparation and writes go to the host while screenshot bytes and confirmed cleanup stay in the reading browser",
    ankiView.forwarded.message.type === "hd_anki_view" && ankiView.reply.cached === true
      && JSON.stringify(ankiView.forwarded.message.request) === JSON.stringify({ term: linkedRequest.term })
      && ankiStatus.forwarded.message.type === "hd_anki_status" && ankiStatus.reply.available === true
      && ankiPreflight.forwarded.message.type === "hd_anki_preflight" && ankiPreflight.reply.state === "addable"
      && screenshot.ok === true && screenshot.token === localScreenshot.token
      && socket.requests().length === requestsBeforeSubmit + 4
      && ankiSubmit.forwarded.message.type === "hd_anki_submit"
      && JSON.stringify(ankiSubmit.forwarded.message.clientMedia) === JSON.stringify({
        screenshot: { ...localScreenshot, data: "AQI=" },
        speech: {
          ...linkedRequest.clientSpeech,
          filename: `hachidori_${"a".repeat(64)}.wav`,
          byteLength: 4,
          data: "UklGRg==",
        },
      })
      && ankiSubmit.reply.state === "added" && ankiSubmit.reply.noteId === 82
      && ankiBrowse.forwarded.message.type === "hd_anki_browse" && ankiBrowse.reply.opened === true
      && ankiMaturity.forwarded.message.type === "hd_anki_maturity" && ankiMaturity.reply.mature === true
      && rejected.ok === false && /generation changed/u.test(rejected.error)
      && JSON.stringify(forwardedRejected.message.clientMedia) === JSON.stringify({})
      && JSON.stringify(localOperations) === JSON.stringify([
        "status", "preflightClientSpeech", "preflightClientSpeech", "screenshot", "clientMedia", "settleClientMedia",
        "clientMedia", "settleClientMedia",
      ])
      && localAnkiCalls[5]?.[2] === "added" && localAnkiCalls[7]?.[2] === "invalid",
    JSON.stringify({ ankiView, ankiStatus, ankiPreflight, screenshot, ankiSubmit, ankiBrowse, ankiMaturity,
      rejected, forwardedRejected, localAnkiCalls }));

  const beforeDiscovery = socket.requests().length;
  const discovering = bus.sendMessage("sharing-client-settings", {
    target: "hoshidicts-worker",
    type: "hd_anki_discover",
    requestId: "client-anki-discover",
    model: "Basic",
    url: "https://client.invalid/anki",
    apiKey: "client-secret",
  }, { id: chrome.runtime.id, url: chrome.runtime.getURL("settings.html#anki") });
  await settle(() => socket.requests().length > beforeDiscovery);
  const forwardedDiscovery = socket.requests().at(-1);
  socket.receive({ kind: "reply", id: forwardedDiscovery.id, response: {
    type: "hd_anki_discover_result",
    requestId: "client-anki-discover",
    ok: true,
    error: null,
    connected: true,
    model: "Basic",
    decks: ["Default"],
    models: ["Basic"],
    fields: ["Front", "Back"],
    errors: [],
  } });
  const discovered = await discovering;
  const beforeSetup = socket.requests().length;
  const checkingSetup = bus.sendMessage("sharing-client-settings", {
    target: "hoshidicts-worker",
    type: "hd_anki_setup",
    requestId: "client-anki-setup",
    templateId: "sentence-template",
    anki: {
      model: "Client model",
      deck: "Client deck",
      url: "https://client.invalid/anki",
      apiKey: "client-secret",
    },
  }, { id: chrome.runtime.id, url: chrome.runtime.getURL("settings.html#anki") });
  await settle(() => socket.requests().length > beforeSetup);
  const forwardedSetup = socket.requests().at(-1);
  socket.receive({ kind: "reply", id: forwardedSetup.id, response: {
    type: "hd_anki_setup_result",
    requestId: "client-anki-setup",
    ok: true,
    error: null,
    proposal: { status: "already-configured" },
    outcome: { status: "already-configured", detail: null, model: "Basic", deck: "Default" },
  } });
  const setup = await checkingSetup;
  check("linked Anki Settings checks run on the host without forwarding the reading browser's endpoint, key or mapping",
    JSON.stringify(forwardedDiscovery.message) === JSON.stringify({
      target: "hoshidicts-worker",
      type: "hd_anki_discover",
      requestId: "client-anki-discover",
      model: "Basic",
    })
      && discovered.ok === true && discovered.connected === true
      && JSON.stringify(discovered.fields) === JSON.stringify(["Front", "Back"])
      && JSON.stringify(forwardedSetup.message) === JSON.stringify({
        target: "hoshidicts-worker",
        type: "hd_anki_setup",
        requestId: "client-anki-setup",
        templateId: "sentence-template",
      })
      && setup.ok === true && setup.outcome?.status === "already-configured"
      && setup.outcome.model === "Basic" && setup.outcome.deck === "Default",
    JSON.stringify({ forwardedDiscovery, discovered, forwardedSetup, setup }));

  // This install's own engine keeps its pre-link state.
  const engineRead = await bus.sendMessage("sharing-client-engine", { target: "hoshidicts-worker", type: "hd_state_read", requestId: "engine-read" }, engineSender);
  const engineCas = await bus.sendMessage("sharing-client-engine", { target: "hoshidicts-worker", type: "hd_state_cas", requestId: "engine-cas",
    baseRevision: 2, dictionaries: [{ ...localDictionary, enabled: false }], groups: [] }, engineSender);
  const cleanup = await bus.sendMessage("sharing-client-engine", { target: "hoshidicts-worker", type: "hd_lookup_stats_cleanup", requestId: "engine-cleanup" }, engineSender);
  check("a linked install's engine reads and commits the state it had before linking, never the mirror",
    engineRead.ok === true && engineRead.state?.revision === 2 && engineRead.state.dictionaries[0].id === "local-id"
      && engineCas.ok === true && engineCas.state.revision === 3 && engineCas.state.dictionaries[0].enabled === false
      && storage.raw.get("sharingLocalState").dictionaryState.revision === 3
      && storage.raw.get("dictionaryState").revision === 7 && storage.raw.get("dictionaryState").dictionaries[0].id === "host-id"
      && cleanup.ok === true && storage.raw.has(rowKey),
    JSON.stringify({ engineRead, engineCas, cleanup, local: storage.raw.get("sharingLocalState") }));

  // Losing the host fails reads, marks sent mutations as uncertain, and a
  // restarted worker relinks by itself.
  const requestsBeforeDrop = socket.requests().length;
  const dangling = send("hd_lookup", { text: "犬" }, "hoshidicts-offscreen");
  const uncertainEdit = send("hd_options_write", {
    baseRevision: 2, options: { hoverEnabled: false },
  }, "hoshidicts-worker");
  const uncertainSubmit = send("hd_anki_submit", { request: {
    term: { expression: "犬", reading: "いぬ" }, generation: 7, trace: [], configKey: "host-config",
  } }, "hachidori-anki");
  await settle(() => socket.requests().length >= requestsBeforeDrop + 3);
  socket.drop();
  const failed = await dangling;
  const editUnknown = await uncertainEdit;
  const uncertain = await uncertainSubmit;
  const status = await send("hd_sharing_status");
  const restartBus = makeBus();
  const restartAlarms = makeAlarms();
  restartAlarms.api.create(ANKI_INDEX_ALARM, { when: Date.now() });
  restartAlarms.api.create("hachidori-managed-dictionary-updates", { when: Date.now() });
  const restartChrome = makeChrome("sharing-client-restart", restartBus, storage, restartAlarms);
  const linkSocketsBefore = linkSockets().length;
  loadBackgroundScript({ chrome: restartChrome, console, setTimeout, clearTimeout, Promise, Error, WebSocket: FakeSharingSocket });
  await settle(() => linkSockets().length > linkSocketsBefore);
  await settle(() => !restartAlarms.values.has(ANKI_INDEX_ALARM)
    && !restartAlarms.values.has("hachidori-managed-dictionary-updates"));
  const restartSocket = linkSockets()[linkSocketsBefore];
  const restartedWithoutLocalAnki = !restartBus.log.some(message => message.type === "hd_anki_index_refresh")
    && !restartAlarms.values.has(ANKI_INDEX_ALARM)
    && !restartAlarms.values.has("hachidori-managed-dictionary-updates");
  check("losing the host fails reads, reports sent mutations as uncertain, and restores the linked role before local work",
    failed.ok === false && failed.error === "The linked Hachidori is not reachable."
      && failed.errorCode === "sharing-disconnected"
      && editUnknown.ok === false && editUnknown.outcomeUnknown === true
      && editUnknown.error === "The linked Hachidori may have completed this change. Check its state before trying again."
      && uncertain.ok === true && uncertain.state === "uncertain" && uncertain.error.includes("Check Anki before trying again")
      && localAnkiCalls.filter(call => call[0] === "settleClientMedia").length === 2
      && status.sharing.client.linked === true && status.sharing.client.connected === false
      && restartSocket?.url === "ws://127.0.0.1:9100/link" && restartedWithoutLocalAnki,
    JSON.stringify({ failed, editUnknown, uncertain, status, restartedWithoutLocalAnki, restartLog: restartBus.log,
      restartAlarms: [...restartAlarms.values], localAnkiCalls, sockets: FakeSharingSocket.instances.map(s => s.url) }));

  // Unlinking restores the kept state above the mirror's revisions and drops the host's rows.
  const unlinked = await send("hd_sharing_client_unlink");
  await settle(() => !storage.raw.has("sharingLocalState"));
  const restoredState = storage.raw.get("dictionaryState");
  const restoredOptions = storage.raw.get("options");
  const restoredStats = storage.raw.get("lookupStats");
  check("unlinking restores this install's own state with newer revisions and removes the host's lookup rows",
    unlinked.ok === true && unlinked.sharing.client.linked === false
      && restoredState.revision === 8 && restoredState.dictionaries[0].id === "local-id" && restoredState.dictionaries[0].enabled === false
      && restoredOptions.revision === 4 && restoredOptions.hoverEnabled === true
      && restoredStats.generation === "local-gen" && restoredStats.revision === 42
      && storage.raw.has('lookupStats:"local-gen":["猫","ねこ"]') && !storage.raw.has(rowKey)
      && !storage.raw.has("dictionaryUpdates") && !storage.raw.has("customDictionarySource")
      && storage.raw.get("sharing")?.client === null,
    JSON.stringify({ unlinked, restoredState, restoredOptions, restoredStats, keys: [...storage.raw.keys()] }));
}

async function sharingTransitionStage() {
  const tick = () => new Promise(resolveTimer => setTimeout(resolveTimer, 2));
  const until = async predicate => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (predicate()) return;
      await tick();
    }
    throw new Error("sharing transition did not settle");
  };
  async function fixture({
    overlayMode = false,
    initial = null,
    ankiService = null,
    ankiIndex = null,
    automaticBackup = false,
  } = {}) {
    let now = Date.parse("2026-09-18T12:00:00.000Z");
    class SharingDate extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    }
    const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
    const chrome = makeChrome("sharing-transitions-worker", bus, storage, alarms);
    const text = "私語,しご,my personal entry\n";
    const semanticRevision = await customDictionarySemanticRevision(parseCustomDictionary(text).entries);
    const local = {
      dictionaryState: { schemaVersion: 1, revision: 2, dictionaries: [genericPackage({
        id: CUSTOM_DICTIONARY_ID, title: CUSTOM_DICTIONARY_TITLE, revision: semanticRevision,
      })], groups: [] },
      options: { hoverEnabled: true, revision: 3, ...(overlayMode ? {
        lookupMode: "hover", sourceHighlightEnabled: false, popupWidthPx: 420, popupTheme: "sunset",
      } : {}) },
      customDictionarySource: { schemaVersion: 1, revision: 4, semanticRevision, text },
      dictionaryUpdates: null, lookupStats: null,
      wordStatusOverrides: { revision: 2, known: ["猫"], ignored: ["さん"] },
    };
    const automaticBackups = {
      schemaVersion: 1,
      backups: [{
        id: "local-before-link",
        createdAt: new SharingDate(now).toISOString(),
        snapshot: {
          state: local.dictionaryState,
          options: local.options,
          document: local.customDictionarySource,
          updates: { revision: 0, schedule: "off", lastCheckedAt: null },
          lookupStats: { generation: null, revision: 0 },
        },
        lookupStatsRows: [],
      }],
    };
    await chrome.storage.local.set(initial ?? {
      sharing: { host: null },
      ...Object.fromEntries(Object.entries(local).filter(([, value]) => value !== null)),
      ...(automaticBackup ? { automaticBackups } : {}),
    });
    const automaticCleanups = [];
    const pendingAutomaticCleanups = [];
    let holdAutomaticCleanup = false;
    bus.addListener("sharing-transition-automatic-engine", (message, _sender, sendResponse) => {
      if (message?.target !== "hoshidicts-offscreen" || message.relayed !== true
          || message.type !== "hd_backup_auto_cleanup") return false;
      automaticCleanups.push(structuredClone(message));
      const reply = () => sendResponse({
        type: "hd_backup_auto_cleanup_result", requestId: message.requestId, ok: true, error: null,
      });
      if (holdAutomaticCleanup) pendingAutomaticCleanups.push(reply);
      else reply();
      return true;
    });
    const sockets = [];
    class Socket extends FakeSharingSocket {
      constructor(url) { super(url); sockets.push(this); }
    }
    const sandbox = {
      chrome, console, setTimeout, clearTimeout, Promise, Error, Date: SharingDate, WebSocket: Socket,
    };
    if (ankiService !== null) sandbox.createAnkiWorkerService = () => ankiService;
    if (ankiIndex !== null) sandbox.createAnkiDuplicateIndex = () => ankiIndex;
    const context = loadBackgroundScript(sandbox, { overlayMode });
    const send = (type, fields = {}, target = "hachidori-sharing", sender) => bus.sendMessage("sharing-settings-tab",
      { target, type, requestId: `transition-${type}`, ...fields }, sender);
    await send("hd_sharing_status");
    const hello = { kind: "hello", protocol: 1, version: "1", name: "Host", dictionaryCount: 1, snapshot: {
      dictionaryState: { schemaVersion: 1, revision: 9, dictionaries: [genericPackage({ id: "host" })], groups: [] },
      options: { hoverEnabled: false, revision: 10, ...(overlayMode ? {
        lookupMode: "activationSticky", sourceHighlightEnabled: true, popupWidthPx: 1000, popupTheme: "light",
      } : {}) }, customDictionarySource: null,
      dictionaryUpdates: { revision: 5, schedule: "off", lastCheckedAt: null }, lookupStats: null,
      wordStatusOverrides: { revision: 1, known: ["犬"], ignored: [] },
    } };
    async function finishLinks(requests) {
      let replies;
      const finished = Promise.all(requests).then(value => { replies = value; });
      await until(() => {
        for (const socket of sockets.filter(item => item.readyState === 0)) {
          socket.open();
          socket.receive(hello);
        }
        return replies !== undefined;
      });
      await finished;
      await tick();
      return replies;
    }
    return { chrome, storage, alarms, automaticCleanups, pendingAutomaticCleanups, local, sockets, send, hello, finishLinks,
      record: outcomes => bus.sendMessage("local-installer", { target: "hoshidicts-worker", type: "hd_setup_record",
        runId: "local-linked-run", recordSetup: false, outcomes },
      { id: chrome.runtime.id, url: chrome.runtime.getURL("offscreen.html") }),
      link: () => send("hd_sharing_client_link", { address: "127.0.0.1:9100" }),
      advance: milliseconds => { now += milliseconds; },
      holdAutomaticCleanup: value => { holdAutomaticCleanup = value; },
      releaseAutomaticCleanups: () => {
        for (const reply of pendingAutomaticCleanups.splice(0)) reply();
      },
      queueAutomatic: () => runInContext("queueAutomaticBackup(true)", context),
      reconcileAutomatic: () => runInContext("reconcileAutomaticBackups()", context),
      dispose: () => runInContext("getSharingClient().unlink()", context) };
  }

  const f = await fixture();
  try {
    f.hello.capabilities = ["linked-anki-v1"];
    const first = f.link(), second = f.link();
    await until(() => f.sockets.length > 0);
    const edit = await f.send("hd_options_write", { baseRevision: 3, options: { showLookupCounts: false } }, "hoshidicts-worker");
    f.local.options = structuredClone(f.storage.raw.get("options"));
    const links = await f.finishLinks([first, second]);
    const kept = structuredClone(f.storage.raw.get("sharingLocalState"));
    const mirroredOverrides = structuredClone(f.storage.raw.get("wordStatusOverrides"));
    check("concurrent Links keep the original personal state including edits made while the probe waits",
      edit.ok && links.every(reply => reply.ok) && f.sockets.length === 2
        && JSON.stringify(kept) === JSON.stringify(f.local)
        && JSON.stringify(mirroredOverrides) === JSON.stringify(f.hello.snapshot.wordStatusOverrides),
      JSON.stringify({ links, kept, local: f.local, mirroredOverrides, sockets: f.sockets.length }));
    const keptSocket = f.sockets.at(-1);
    const requestsBeforeOldAnki = keptSocket.requests().length;
    const oldAnki = await f.send("hd_anki_status", {}, "hachidori-anki");
    const oldTemplateWrite = await f.send("hd_options_write", {
      baseRevision: f.storage.raw.get("options").revision,
      options: { customButtons: [{ id: "sentence", type: "anki", label: "Sentence", templateId: "sentence" }] },
    }, "hoshidicts-worker");
    const oldDiscovery = await f.send("hd_anki_discover", {
      model: "Basic",
      url: "https://client.invalid/anki",
      apiKey: "client-secret",
    }, "hoshidicts-worker", {
      id: f.chrome.runtime.id,
      url: f.chrome.runtime.getURL("settings.html#anki"),
    });
    const oldSetup = await f.send("hd_anki_setup", {
      anki: {
        model: "Basic",
        deck: "Default",
        url: "https://client.invalid/anki",
        apiKey: "client-secret",
      },
    }, "hoshidicts-worker", {
      id: f.chrome.runtime.id,
      url: f.chrome.runtime.getURL("settings.html#anki"),
    });
    check("an old host keeps linked dictionaries available but reports host-owned Anki mining unavailable without sending a request",
      oldAnki.ok === true && oldAnki.available === false
        && oldAnki.error === "The linked Hachidori does not support host-owned Anki mining. Update it and try again."
        && oldDiscovery.ok === false
        && oldDiscovery.error === "The linked Hachidori does not support host-owned Anki mining. Update it and try again."
        && oldSetup.ok === false
        && oldSetup.error === "The linked Hachidori does not support host-owned Anki mining. Update it and try again."
        && oldTemplateWrite.ok === false
        && oldTemplateWrite.error === "The linked Hachidori does not support host-owned Anki mining. Update it and try again."
        && keptSocket.requests().length === requestsBeforeOldAnki,
      JSON.stringify({ oldAnki, oldDiscovery, oldSetup, oldTemplateWrite, requests: keptSocket.requests() }));
    const writes = f.storage.sets.length, sockets = f.sockets.length;
    await f.finishLinks([f.link()]);
    check("a repeated Link returns the current link without probing or replacing its saved state",
      f.storage.sets.length === writes && f.sockets.length === sockets
        && JSON.stringify(f.storage.raw.get("sharingLocalState")) === JSON.stringify(kept));

    const unlinks = await Promise.all([f.send("hd_sharing_client_unlink"), f.send("hd_sharing_client_unlink")]);
    const restored = Object.fromEntries(f.storage.raw);
    await f.send("hd_sharing_client_unlink");
    check("concurrent and repeated Unlinks restore personal entries and settings once without erasing them",
      unlinks.every(reply => reply.ok && !reply.sharing.client.linked)
        && restored.customDictionarySource?.text === f.local.customDictionarySource.text
        && restored.dictionaryState?.dictionaries[0].id === CUSTOM_DICTIONARY_ID
        && restored.options?.showLookupCounts === false && restored.options?.revision > 10
        // The kept words come back, at a revision above the mirror's.
        && JSON.stringify(restored.wordStatusOverrides) === JSON.stringify({ ...f.local.wordStatusOverrides, revision: 3 })
        && !f.storage.raw.has("sharingLocalState") && !f.storage.raw.has("dictionaryUpdates")
        && JSON.stringify(Object.fromEntries(f.storage.raw)) === JSON.stringify(restored), JSON.stringify({ unlinks, restored }));
  } finally { f.dispose(); }

  const automatic = await fixture({ automaticBackup: true });
  const originalAutomaticSet = automatic.chrome.storage.local.set;
  let releaseLinkStorage = () => {};
  try {
    await until(() => automatic.alarms.values.has("hachidori-automatic-backup"));
    const beforeLink = structuredClone(automatic.storage.raw.get("automaticBackups"));
    const automaticWritesBeforeLink = automatic.storage.sets.filter(keys =>
      keys.length === 1 && keys[0] === "automaticBackups").length;
    automatic.advance(24 * 60 * 60_000);
    let linkStorageEntered = false;
    const linkStorageGate = new Promise(resolve => { releaseLinkStorage = resolve; });
    automatic.chrome.storage.local.set = async (items, callback) => {
      if (!linkStorageEntered && items.sharing?.client?.address) {
        linkStorageEntered = true;
        await linkStorageGate;
      }
      return originalAutomaticSet(items, callback);
    };
    const linking = automatic.link();
    await until(() => automatic.sockets.some(socket => socket.readyState === 0));
    for (const socket of automatic.sockets.filter(item => item.readyState === 0)) {
      socket.open();
      socket.receive(automatic.hello);
    }
    await until(() => linkStorageEntered);
    const queuedReconcile = automatic.reconcileAutomatic();
    await tick();
    releaseLinkStorage();
    const [linked, queuedResult] = await Promise.all([linking, queuedReconcile]);
    automatic.chrome.storage.local.set = originalAutomaticSet;
    await until(() => !automatic.alarms.values.has("hachidori-automatic-backup"));
    const whileLinked = structuredClone(automatic.storage.raw.get("automaticBackups"));
    const alarmWhileLinked = automatic.alarms.values.has("hachidori-automatic-backup");
    const automaticWritesWhileLinked = automatic.storage.sets.filter(keys =>
      keys.length === 1 && keys[0] === "automaticBackups").length;
    check("an automatic backup queued behind Link rechecks linked ownership before it can snapshot the host mirror",
      linked.ok && linked.sharing.client.linked
        && queuedResult.linked === true && queuedResult.created === false
        && automatic.storage.raw.get("dictionaryState").dictionaries[0].id === "host"
        && JSON.stringify(whileLinked) === JSON.stringify(beforeLink)
        && automaticWritesWhileLinked === automaticWritesBeforeLink
        && automatic.automaticCleanups.length === 0
        && alarmWhileLinked === false,
      JSON.stringify({ linked, queuedResult, beforeLink, whileLinked,
        automaticWritesBeforeLink, automaticWritesWhileLinked,
        cleanups: automatic.automaticCleanups.length, alarmWhileLinked }));
    const unlinked = await automatic.send("hd_sharing_client_unlink");
    const resumed = structuredClone(automatic.storage.raw.get("automaticBackups"));
    check("Link suppresses local automatic snapshots and Unlink resumes from the restored local snapshot store",
      linked.ok && linked.sharing.client.linked
        && JSON.stringify(whileLinked) === JSON.stringify(beforeLink)
        && alarmWhileLinked === false
        && unlinked.ok && !unlinked.sharing.client.linked
        && resumed.backups.length === 2
        && resumed.backups[0].snapshot.state.dictionaries[0].id === CUSTOM_DICTIONARY_ID
        && resumed.backups[0].snapshot.state.dictionaries.every(dictionary => dictionary.id !== "host")
        && resumed.backups[1].id === "local-before-link"
        && automatic.alarms.values.get("hachidori-automatic-backup")?.scheduledTime
          === Date.parse(resumed.backups[0].createdAt) + 24 * 60 * 60_000,
      JSON.stringify({ linked, beforeLink, whileLinked, alarmWhileLinked, unlinked, resumed,
        alarm: automatic.alarms.values.get("hachidori-automatic-backup") }));
  } finally {
    releaseLinkStorage();
    automatic.chrome.storage.local.set = originalAutomaticSet;
    automatic.dispose();
  }

  const transitionAutomatic = await fixture({ automaticBackup: true });
  const originalTransitionClear = transitionAutomatic.alarms.api.clear;
  let releaseLinkedSuppression = () => {};
  try {
    await until(() => transitionAutomatic.alarms.values.has("hachidori-automatic-backup"));
    transitionAutomatic.advance(24 * 60 * 60_000);
    transitionAutomatic.holdAutomaticCleanup(true);
    const localAutomaticRun = transitionAutomatic.queueAutomatic();
    await until(() => transitionAutomatic.pendingAutomaticCleanups.length === 1);
    const alarmFromLocalRun = structuredClone(
      transitionAutomatic.alarms.values.get("hachidori-automatic-backup"),
    );
    let linkSettled = false;
    const finishingLink = transitionAutomatic.finishLinks([transitionAutomatic.link()])
      .then(replies => {
        linkSettled = true;
        return replies;
      });
    await until(() => transitionAutomatic.storage.raw.get("sharing")?.client?.address
      && transitionAutomatic.storage.raw.get("dictionaryState")?.dictionaries[0]?.id === "host");
    await tick();
    const linkWaitedForLocalRun = !linkSettled
      && transitionAutomatic.alarms.values.has("hachidori-automatic-backup");
    transitionAutomatic.releaseAutomaticCleanups();
    const [linked] = await finishingLink;
    await localAutomaticRun;
    const alarmAfterLink = transitionAutomatic.alarms.values.get("hachidori-automatic-backup");
    check("Link drains an in-flight local automatic run before fresh linked suppression",
      linkWaitedForLocalRun
        && linked.ok && linked.sharing.client.linked
        && alarmFromLocalRun?.scheduledTime !== undefined
        && alarmAfterLink === undefined,
      JSON.stringify({ linkWaitedForLocalRun, linked, alarmFromLocalRun, alarmAfterLink }));

    await transitionAutomatic.alarms.api.create("hachidori-automatic-backup", {
      when: Date.now() + 24 * 60 * 60_000,
    });
    let linkedSuppressionEntered = false;
    const linkedSuppressionGate = new Promise(resolve => { releaseLinkedSuppression = resolve; });
    transitionAutomatic.alarms.api.clear = async name => {
      if (!linkedSuppressionEntered && name === "hachidori-automatic-backup") {
        linkedSuppressionEntered = true;
        await linkedSuppressionGate;
      }
      return originalTransitionClear(name);
    };
    const linkedSuppression = transitionAutomatic.queueAutomatic();
    await until(() => linkedSuppressionEntered);
    let unlinkSettled = false;
    const unlinking = transitionAutomatic.send("hd_sharing_client_unlink").then(reply => {
      unlinkSettled = true;
      return reply;
    });
    await until(() => transitionAutomatic.storage.raw.get("sharing")?.client === null
      && transitionAutomatic.storage.raw.get("dictionaryState")?.dictionaries[0]?.id === CUSTOM_DICTIONARY_ID);
    await tick();
    const unlinkWaitedForLinkedRun = !unlinkSettled;
    releaseLinkedSuppression();
    const unlinked = await unlinking;
    await linkedSuppression;
    transitionAutomatic.alarms.api.clear = originalTransitionClear;
    const resumedStore = transitionAutomatic.storage.raw.get("automaticBackups");
    const resumedAlarm = transitionAutomatic.alarms.values.get("hachidori-automatic-backup");
    check("Unlink drains an in-flight linked suppression before fresh local scheduling",
      unlinkWaitedForLinkedRun
        && unlinked.ok && !unlinked.sharing.client.linked
        && resumedAlarm?.scheduledTime
          === Date.parse(resumedStore.backups[0].createdAt) + 24 * 60 * 60_000,
      JSON.stringify({ unlinkWaitedForLinkedRun, unlinked, resumedStore, resumedAlarm }));
  } finally {
    transitionAutomatic.holdAutomaticCleanup(false);
    transitionAutomatic.releaseAutomaticCleanups();
    releaseLinkedSuppression();
    transitionAutomatic.alarms.api.clear = originalTransitionClear;
    transitionAutomatic.dispose();
  }

  const indexCalls = [];
  const indexRace = await fixture({ ankiIndex: {
    async suspend() { indexCalls.push("suspend"); },
    async resume() { indexCalls.push("resume"); },
    async source() { return null; },
    async lookup() { return { wordKey: null, mature: false, noteIds: [], cached: false }; },
    async repair() { return { wordKey: null, mature: false, noteIds: [], cached: false }; },
    async recordWrite() {},
    async has() { return false; },
  } });
  const originalIndexSet = indexRace.chrome.storage.local.set;
  try {
    await until(() => indexCalls.includes("resume"));
    for (let idle = 0; idle < 3; idle += 1) await tick();
    indexCalls.length = 0;
    const enteredCommit = Promise.withResolvers();
    const releaseCommit = Promise.withResolvers();
    let holdCommit = true;
    indexRace.chrome.storage.local.set = async values => {
      if (holdCommit && values.sharing?.client?.address) {
        holdCommit = false;
        enteredCommit.resolve();
        await releaseCommit.promise;
      }
      return originalIndexSet(values);
    };
    const finishingLink = indexRace.finishLinks([indexRace.link()]);
    await enteredCommit.promise;
    indexRace.chrome.alarms.onAlarm.fire({ name: ANKI_INDEX_ALARM });
    await tick();
    await tick();
    const duringTransition = [...indexCalls];
    releaseCommit.resolve();
    const [linked] = await finishingLink;
    await tick();
    await tick();
    check("an index alarm during Link cannot resume the reading browser's local Anki behind the suspended transition",
      linked.ok && duringTransition.length === 1 && duringTransition[0] === "suspend"
        && indexCalls.filter(call => call === "suspend").length >= 2
        && !indexCalls.includes("resume"),
      JSON.stringify({ duringTransition, indexCalls, linked }));
  } finally {
    indexRace.chrome.storage.local.set = originalIndexSet;
    indexRace.dispose();
  }

  const failure = await fixture();
  try {
    await failure.finishLinks([failure.link()]);
    const before = JSON.stringify(Object.fromEntries(failure.storage.raw));
    failure.storage.failNextSet("restoration refused");
    const refused = await failure.send("hd_sharing_client_unlink");
    const status = await failure.send("hd_sharing_status");
    check("a refused restoration keeps the saved state and linked routing available for retry",
      !refused.ok && refused.error === "restoration refused" && status.sharing.client.linked
        && before === JSON.stringify(Object.fromEntries(failure.storage.raw)), JSON.stringify({ refused, status }));
    const remove = failure.chrome.storage.local.remove;
    failure.chrome.storage.local.remove = async () => { throw new Error("restoration removal refused"); };
    const partial = await failure.send("hd_sharing_client_unlink");
    failure.chrome.storage.local.remove = remove;
    const partialStatus = await failure.send("hd_sharing_status");
    const retained = failure.storage.raw.has("sharingLocalState");
    const retried = await failure.send("hd_sharing_client_unlink");
    check("a partial restoration retains its snapshot until removals succeed and the retry restores personal entries",
      !partial.ok && partialStatus.sharing.client.linked && retained && retried.ok
        && failure.storage.raw.get("customDictionarySource")?.text === failure.local.customDictionarySource.text,
      JSON.stringify({ partial, partialStatus, retained, retried }));
    await failure.finishLinks([failure.link()]);
    await remove("sharingLocalState");
    const withoutSnapshot = JSON.stringify(Object.fromEntries([...failure.storage.raw].filter(([key]) => key !== "sharing")));
    const missing = await failure.send("hd_sharing_client_unlink");
    check("a linked install with no saved snapshot unlinks without deleting its current user data",
      missing.ok && !missing.sharing.client.linked
        && withoutSnapshot === JSON.stringify(Object.fromEntries([...failure.storage.raw].filter(([key]) => key !== "sharing"))));
  } finally { failure.dispose(); }

  const late = await fixture();
  try {
    await late.finishLinks([late.link()]);
    const oldSocket = late.sockets.at(-1);
    const set = late.chrome.storage.local.set;
    let release, restoring = false;
    const held = new Promise(resolveHeld => { release = resolveHeld; });
    late.chrome.storage.local.set = async values => {
      if (values.dictionaryState?.dictionaries[0]?.id === CUSTOM_DICTIONARY_ID) {
        restoring = true;
        await held;
      }
      return set(values);
    };
    const unlink = late.send("hd_sharing_client_unlink");
    await until(() => restoring);
    oldSocket.receive({ kind: "storage", changes: { options: { revision: 100, hoverEnabled: false } } });
    release();
    await unlink;
    oldSocket.receive(late.hello);
    await tick();
    await tick();
    check("host batches queued during Unlink and late frames from its retired socket cannot overwrite the restoration",
      late.storage.raw.get("options")?.hoverEnabled === true && late.storage.raw.get("options")?.revision === 11
        && late.storage.raw.get("customDictionarySource")?.text === late.local.customDictionarySource.text,
      JSON.stringify(Object.fromEntries(late.storage.raw)));
  } finally { late.dispose(); }

  const exported = Promise.withResolvers();
  const remoteAnkiCalls = [];
  const remote = await fixture({ ankiService: {
    async clientMedia(request) {
      remoteAnkiCalls.push(["clientMedia", structuredClone(request)]);
      return exported.promise;
    },
    async settleClientMedia(request, state) {
      remoteAnkiCalls.push(["settleClientMedia", structuredClone(request), state]);
      return { settled: true };
    },
  } });
  try {
    remote.hello.capabilities = ["linked-anki-v1", "linked-anki-v2"];
    await remote.finishLinks([remote.link()]);
    const oldAddress = "ws://127.0.0.1:9100/link";
    const oldSocket = remote.sockets.find(socket => socket.url === oldAddress && socket.readyState === 1);
    const submitting = remote.send("hd_anki_submit", { request: {
      term: { expression: "猫", reading: "ねこ" },
      generation: 7,
      trace: [],
      configKey: "old-host-config",
    } }, "hachidori-anki");
    await until(() => remoteAnkiCalls.some(call => call[0] === "clientMedia"));
    const switching = remote.send("hd_sharing_client_link", { address: "127.0.0.1:9200" });
    await until(() => remote.sockets.some(socket => socket.url === "ws://127.0.0.1:9200/link"));
    const switchProbe = remote.sockets.find(socket => socket.url === "ws://127.0.0.1:9200/link");
    switchProbe.open();
    switchProbe.receive(remote.hello);
    await tick();
    const blockedOnExport = remote.storage.raw.get("sharing")?.client?.address === oldAddress
      && remote.sockets.filter(socket => socket.url === "ws://127.0.0.1:9200/link").length === 1;
    exported.resolve({});
    await until(() => oldSocket.requests().some(request =>
      request.message?.target === "hachidori-anki" && request.message.type === "hd_anki_submit"));
    const oldSubmission = oldSocket.requests().find(request =>
      request.message?.target === "hachidori-anki" && request.message.type === "hd_anki_submit");
    oldSocket.receive({ kind: "reply", id: oldSubmission.id, response: {
      type: "hd_anki_submit_result",
      requestId: "transition-hd_anki_submit",
      ok: true,
      error: null,
      state: "added",
      noteId: 81,
      warnings: [],
    } });
    const submitted = await submitting;
    const switched = await switching;
    check("switching hosts drains a linked submission before publishing the new route",
      blockedOnExport && submitted.state === "added" && switched.ok
        && switched.sharing.client.address === "ws://127.0.0.1:9200/link"
        && remoteAnkiCalls.at(-1)?.[0] === "settleClientMedia"
        && remoteAnkiCalls.at(-1)?.[2] === "added"
        && remote.sockets.filter(socket => socket.url === "ws://127.0.0.1:9200/link").length === 2,
      JSON.stringify({ blockedOnExport, submitted, switched, remoteAnkiCalls,
        sockets: remote.sockets.map(socket => [socket.url, socket.readyState]) }));
  } finally { remote.dispose(); }

  const pending = await fixture();
  try {
    const link = pending.link();
    await until(() => pending.sockets.length > 0);
    const unlink = pending.send("hd_sharing_client_unlink");
    const replies = await pending.finishLinks([link, unlink]);
    const status = await pending.send("hd_sharing_status");
    check("Unlink from another Settings tab waits for an already pending Link and then restores local state",
      replies.every(reply => reply.ok) && !status.sharing.client.linked
        && pending.storage.raw.get("customDictionarySource")?.text === pending.local.customDictionarySource.text
        && !pending.storage.raw.has("sharingLocalState"), JSON.stringify({ replies, status }));
  } finally { pending.dispose(); }

  const overlay = await fixture({ overlayMode: true });
  let restarted;
  let legacy;
  let modeless;
  try {
    overlay.hello.capabilities = ["linked-anki-v1"];
    await overlay.finishLinks([overlay.link()]);
    const socket = overlay.sockets.at(-1);
    const current = () => overlay.storage.raw.get("options");
    const write = (patch, baseRevision = current().revision) => overlay.send("hd_options_write",
      { baseRevision, options: patch }, "hoshidicts-worker");
    const initial = structuredClone(current());
    const blockedTemplates = await write({
      anki: globalThis.HDReaderOptions.normaliseOptions({}).anki,
    });
    const local = await write({ hoverEnabled: false, popupWidthPx: 480, definitionLookupMode: "click",
      scanDelayMs: 200, definitionScanDelayMs: 0 });
    const rawHost = { ...overlay.hello.snapshot.options, revision: 11, popupTheme: "dracula", popupWidthPx: 1200 };
    socket.receive({ kind: "storage", changes: { options: rawHost } });
    await until(() => current().popupTheme === "dracula");
    const mirrored = structuredClone(current());
    socket.receive({ kind: "storage", changes: { options: overlay.hello.snapshot.options } });
    await tick();
    check("a linked overlay keeps activation, highlighting and geometry local through host option batches",
      initial.hoverEnabled && initial.lookupMode === "hover" && !initial.sourceHighlightEnabled
        && initial.popupWidthPx === 420 && initial.popupTheme === "light"
        && blockedTemplates.ok === false
        && blockedTemplates.error === "The linked Hachidori does not support host-owned Anki mining. Update it and try again."
        && local.ok && local.options.revision === initial.revision + 1 && socket.requests().length === 0
        && mirrored.popupWidthPx === 480 && !mirrored.hoverEnabled && mirrored.lookupMode === "hover"
        && mirrored.definitionLookupMode === "click" && current().definitionLookupMode === "click"
        && mirrored.scanDelayMs === 200 && mirrored.definitionScanDelayMs === 0 && current().definitionScanDelayMs === 0
        && !mirrored.sourceHighlightEnabled && mirrored.revision === local.options.revision + 1
        && current().revision === mirrored.revision && current().popupTheme === "dracula"
        && overlay.storage.raw.get("sharingLocalState").options.popupWidthPx === 480
        && overlay.storage.raw.get("sharingLocalState").options.definitionLookupMode === "click"
        && overlay.storage.raw.get("sharingLocalState").options.scanDelayMs === 200,
      JSON.stringify({ initial, blockedTemplates, local, mirrored, current: current() }));

    async function answerWrite(promise, hostOptions, expectedCount, ok = true) {
      await until(() => socket.requests().length === expectedCount);
      const request = socket.requests().at(-1);
      socket.receive({ kind: "reply", id: request.id, response: { type: "hd_options_write_result", requestId: request.message.requestId,
        ok, error: ok ? null : "host changed", ...(ok ? {} : { conflict: true }), options: hostOptions } });
      return { request: request.message, reply: await promise };
    }
    const shared = await answerWrite(write({ popupTheme: "forest" }), { ...rawHost, revision: 12, popupTheme: "forest" }, 1);
    const mixedHost = { ...rawHost, revision: 13, popupTheme: "light" };
    const mixed = await answerWrite(write({ popupTheme: "light", popupWidthPx: 520 }), mixedHost, 2);
    const afterMixed = structuredClone(current());
    socket.receive({ kind: "storage", changes: { options: mixedHost } });
    await tick();
    const stale = await write({ popupWidthPx: 900 }, initial.revision);
    check("overlay saves translate host revisions, split mixed patches and reject stale local edits",
      shared.request.baseRevision === 11 && shared.reply.ok && shared.reply.options.popupWidthPx === 480
        && shared.reply.options.revision === 13
        && mixed.request.baseRevision === 12 && JSON.stringify(mixed.request.options) === JSON.stringify({ popupTheme: "light" })
        && mixed.reply.ok && mixed.reply.options.popupWidthPx === 520 && mixed.reply.options.revision === 15
        && JSON.stringify(current()) === JSON.stringify(afterMixed)
        && stale.ok === false && stale.conflict === true && socket.requests().length === 2,
      JSON.stringify({ shared, mixed, afterMixed, current: current(), stale }));

    const conflictHost = { ...mixedHost, revision: 14, popupTheme: "dark" };
    const conflict = await answerWrite(write({ popupTheme: "forest", popupWidthPx: 600 }), conflictHost, 3, false);
    const pendingShared = write({ popupTheme: "forest", popupWidthPx: 700 });
    await until(() => socket.requests().length === 4);
    const concurrent = await write({ popupWidthPx: 640 });
    const raced = await answerWrite(pendingShared, { ...conflictHost, revision: 15, popupTheme: "forest" }, 4);
    check("host conflicts and concurrent local edits preserve the overlay draft boundary",
      !conflict.reply.ok && conflict.reply.conflict && conflict.reply.options.popupWidthPx === 520
        && concurrent.ok && raced.reply.ok === false && raced.reply.conflict
        && current().popupWidthPx === 640 && overlay.storage.raw.get("sharingLocalState").options.popupWidthPx === 640,
      JSON.stringify({ conflict, concurrent, raced, current: current() }));

    const localCapture = structuredClone(overlay.storage.raw.get("sharingLocalState"));
    const installedTitle = "Jitendex.org [2026-08-11]";
    localCapture.dictionaryState.dictionaries.push(genericPackage({ id: "local-jitendex", title: installedTitle, sourceId: "jitendex" }));
    await overlay.chrome.storage.local.set({ sharingLocalState: localCapture });
    const beforeRecord = JSON.stringify(current());
    const recorded = await overlay.record({ jitendex: { status: "installed", seconds: 1 } });
    check("a local installer settling after Link updates its kept selections rather than the host mirror",
      recorded.ok && overlay.storage.raw.get("sharingLocalState").options.compactDefinitionSummaryDictionary === installedTitle
        && JSON.stringify(current()) === beforeRecord && !overlay.storage.raw.has("setupState"));

    const restartState = structuredClone(Object.fromEntries(overlay.storage.raw));
    const legacyState = structuredClone(restartState);
    delete legacyState.sharingOptionsVersion;
    legacyState.options = { ...conflictHost, revision: 15, popupWidthPx: 1200 };
    legacy = await fixture({ overlayMode: true, initial: legacyState });
    check("an existing linked overlay restores its kept preferences before the host reconnects",
      legacy.storage.raw.get("options").popupWidthPx === 640
        && legacy.storage.raw.get("options").lookupMode === "hover"
        && !legacy.storage.raw.get("options").sourceHighlightEnabled
        && legacy.storage.raw.get("options").revision > 15
        && legacy.storage.raw.get("options").popupTheme === "dark");
    const modelessState = structuredClone(legacyState);
    delete modelessState.sharingLocalState.options.lookupMode;
    modeless = await fixture({ overlayMode: true, initial: modelessState });
    const composed = structuredClone(modeless.storage.raw.get("options"));
    const modelessUnlinked = await modeless.send("hd_sharing_client_unlink");
    const modelessRestored = modeless.storage.raw.get("options");
    check("a linked overlay whose local record chose no lookup mode composes and unlinks on hover",
      legacyState.options.lookupMode === "activationSticky" && composed.lookupMode === "hover"
        && modelessUnlinked.ok && modelessRestored.lookupMode === "hover" && modelessRestored.popupWidthPx === 640,
      JSON.stringify({ composed, modelessUnlinked, modelessRestored }));
    restarted = await fixture({ overlayMode: true, initial: restartState });
    const offline = await restarted.send("hd_options_write", { baseRevision: restarted.storage.raw.get("options").revision,
      options: { popupWidthPx: 680 } }, "hoshidicts-worker");
    const offlineRestored = await restarted.send("hd_sharing_client_unlink");
    check("overlay-local edits survive worker restart, work while disconnected and remain after Unlink",
      offline.ok && restarted.sockets.every(item => item.requests().length === 0) && offlineRestored.ok
        && restarted.storage.raw.get("options").popupWidthPx === 680
        && restarted.storage.raw.get("options").popupTheme === "sunset"
        && !restarted.storage.raw.has("sharingOptionsVersion"), JSON.stringify({ offline, offlineRestored }));

    const lateWrite = write({ popupTheme: "light", popupWidthPx: 750 });
    await until(() => socket.requests().length === 5);
    const unlinked = await overlay.send("hd_sharing_client_unlink");
    const lateReply = await lateWrite;
    socket.receive({ kind: "storage", changes: { options: { revision: 100, popupWidthPx: 1100 } } });
    await tick();
    check("Unlink can complete during an overlay shared save and its late reply cannot overwrite local preferences",
      unlinked.ok && lateReply.ok === false && current().popupWidthPx === 640 && current().popupTheme === "sunset"
        && current().revision > restartState.options.revision && !overlay.storage.raw.has("sharingLocalState")
        && !overlay.storage.raw.has("sharingOptionsVersion"), JSON.stringify({ unlinked, lateReply, current: current() }));
  } finally { overlay.dispose(); restarted?.dispose(); legacy?.dispose(); modeless?.dispose(); }
}

describe("sharing", () => {
  test("sharing host", async () => {
    await sharingHostStage();
  });

  test("sharing client", async () => {
    await sharingClientStage();
  });

  test("sharing transitions", async () => {
    await sharingTransitionStage();
  });
});
