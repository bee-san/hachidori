// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sharing with language profiles (docs/languages.md 4.3, 4.4, 17.3-17.6 and
// the sharing cases of section 18), through the service worker's own sharing
// code: a host whose records have profiles, browsers that predate profiles,
// profile-aware browsers with and without one of the host's packs, an
// in-memory relay between them, and a stand-in engine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInContext } from "node:vm";

const ROOT = new URL("../", import.meta.url);
const LANGUAGES = JSON.parse(readFileSync(new URL("test/data/profile-languages.json", ROOT), "utf8"));
const registry = codes => ({ version: 1, codes: [...codes], get: code => (codes.includes(code) ? LANGUAGES[code] ?? null : null) });
// The modules imported here read this realm's registry: every pack the tests use.
globalThis.HDLanguages = registry(["ja", "en", "ar"]);

const profileState = await import("../extension/profile-state.js");
const japaneseView = await import("../extension/japanese-view.js");
const sharingLanguages = await import("../extension/sharing-languages.js");
const languageNameModule = await import("../extension/language-names.js");
const protocol = await import("../extension/sharing-protocol.js");
const { createUploadHost } = await import("../extension/linked-import.js");
const { CUSTOM_DICTIONARY_ID, customDictionarySemanticRevision } = await import("../extension/custom-dictionary.js");
const { FakeSharingSocket, loadBackgroundScript, makeAlarms, makeBus, makeChrome, makeStorage } = await import("./extension-smoke/fakes.mjs");

const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, what, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(2);
  }
}
const ENGLISH_ID = LANGUAGES.en.personalDictionary.id;

// Timers that do not keep the test process alive once the tests are done.
function unref(timer) {
  timer?.unref?.();
  return timer;
}
const quietTimeout = (...args) => unref(setTimeout(...args));

// The relay the Anki add-on runs, in memory: one host socket, link sockets as
// numbered clients, every frame delivered in order on a later turn.
function createRelay() {
  let host = null;
  let next = 0;
  const clients = new Map();
  const log = [];
  const later = callback => quietTimeout(callback, 0);
  const deliver = (socket, text) => {
    if (socket.readyState !== 1) return;
    socket.received.push(JSON.parse(text));
    socket.onmessage?.({ data: text });
  };
  const closeClient = clientId => {
    const socket = clients.get(clientId);
    if (socket === undefined) return;
    clients.delete(clientId);
    later(() => {
      socket.readyState = 3;
      socket.onclose?.({});
      host?.receive({ kind: "client-close", clientId });
    });
  };
  const onHostFrame = frame => {
    log.push(frame);
    if (frame.kind === "send") {
      const socket = clients.get(frame.clientId);
      if (socket) later(() => deliver(socket, frame.text));
    } else if (frame.kind === "broadcast") {
      for (const socket of clients.values()) later(() => deliver(socket, frame.text));
    } else if (frame.kind === "close") closeClient(frame.clientId);
    else if (frame.kind === "network") later(() => host?.receive({ kind: "network", enabled: frame.enabled, addresses: [] }));
  };
  const wire = () => {
    for (const socket of FakeSharingSocket.instances) {
      if (socket.relayWired) continue;
      socket.relayWired = true;
      if (socket.url.endsWith("/host")) {
        // As the add-on's relay: one host at a time.
        if (host !== null && host.readyState !== 3) {
          later(() => {
            socket.open();
            socket.receive({ kind: "listen-failed", error: "Another browser on this computer is already sharing through Anki." });
          });
          continue;
        }
        host = socket;
        socket.send = text => onHostFrame(JSON.parse(text));
        const close = socket.close.bind(socket);
        socket.close = () => {
          if (host === socket) {
            host = null;
            for (const clientId of [...clients.keys()]) closeClient(clientId);
          }
          close();
        };
        later(() => {
          socket.open();
          socket.receive({ kind: "listening", port: 8771 });
        });
      } else if (socket.url.endsWith("/link")) {
        const clientId = `client-${++next}`;
        clients.set(clientId, socket);
        Object.assign(socket, { clientId, received: [] });
        socket.send = text => {
          socket.sent.push(JSON.parse(text));
          later(() => host?.receive({ kind: "client-text", clientId, text }));
        };
        socket.close = () => {
          if (clients.has(clientId)) closeClient(clientId);
        };
        later(() => {
          host?.receive({ kind: "client-open", clientId, origin: "chrome-extension://linked", address: "127.0.0.1" });
          socket.open();
        });
      }
    }
  };
  // Referenced: it keeps the test alive while the relay runs.
  const timer = setInterval(wire, 1);
  return {
    log,
    clients,
    closes: () => log.filter(frame => frame.kind === "close").map(frame => frame.clientId),
    broadcasts: () => log.filter(frame => frame.kind === "broadcast").map(frame => JSON.parse(frame.text)),
    stop() { clearInterval(timer); },
  };
}

// One Hachidori's service worker, with the modules its harness leaves out and
// the language registry of its build.
function installation({ name, codes = ["ja", "en", "ar"], records = {}, overlayMode = false }) {
  const bus = makeBus(), storage = makeStorage(), alarms = makeAlarms();
  for (const [key, value] of Object.entries(records)) storage.raw.set(key, structuredClone(value));
  const build = registry(codes);
  const relayed = [];
  bus.addListener(`${name}-engine`, (message, _sender, respond) => {
    if (message?.relayed !== true || message.target !== "hoshidicts-offscreen") return false;
    relayed.push(structuredClone(message));
    const found = Array.isArray(message.dictionaries) && message.dictionaries.length === 0 ? [] : [{ matched: message.text }];
    respond({ type: `${message.type}_result`, requestId: message.requestId ?? null, ok: true, error: null, results: found });
    return true;
  });
  const sandbox = {
    chrome: makeChrome(`${name}-worker`, bus, storage, alarms), console: quiet, Promise, Error, TypeError, JSON, URL, Map, Set,
    String, Number, Boolean, Object, Array, RegExp, Math, Date, Intl,
    setTimeout: quietTimeout, clearTimeout, WebSocket: FakeSharingSocket,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
    HDLanguages: build,
    ...Object.fromEntries(Object.entries(profileState).filter(([, value]) => typeof value === "function")),
    ...japaneseView, ...sharingLanguages, ...languageNameModule,
    // This build's packs, as the worker's own registry gives them.
    packCodes: () => [...build.codes],
    hasLanguagePack: code => code === "ja" || build.get(code) !== null,
  };
  const context = loadBackgroundScript(sandbox, { overlayMode });
  const page = makeChrome(`${name}-page`, bus, storage, alarms);
  const writes = [];
  const set = storage.api().local.set;
  return {
    context, storage, relayed, writes,
    stored: key => plain(storage.raw.get(key)),
    worker: async (type, fields = {}) => plain(await page.runtime.sendMessage({ target: "hoshidicts-worker", type, requestId: `${name}-${type}`, ...fields })),
    engine: async (type, fields = {}) => plain(await page.runtime.sendMessage({ target: "hoshidicts-offscreen", type, requestId: `${name}-${type}`, ...fields })),
    sharing: async (type, fields = {}) => plain(await page.runtime.sendMessage({ target: "hachidori-sharing", type, requestId: `${name}-${type}`, ...fields })),
    write: values => storage.api().local.set(structuredClone(values)),
    recordWrites() {
      storage.api().local.set = (items, callback) => {
        writes.push(structuredClone(items));
        return set(items, callback);
      };
    },
  };
}

// A browser that predates profiles: a bare link socket that says hello and
// asks what it is told to.
async function olderClient() {
  const socket = new FakeSharingSocket("ws://127.0.0.1:8771/link");
  await until(() => socket.readyState === 1, "the older client's connection");
  socket.send(JSON.stringify({ kind: "hello", protocol: 1, version: "0.3.2", name: "GSM", capabilities: ["linked-anki-v1", "linked-anki-v2"] }));
  const hello = await until(() => socket.received.find(frame => frame.kind === "hello"), "the hello to the older client");
  let counter = 0;
  const pendingReplies = new Map();
  return {
    socket, hello,
    frames: kind => socket.received.filter(frame => frame.kind === kind),
    send(message) {
      counter += 1;
      const id = `older-${counter}`;
      socket.send(JSON.stringify({ kind: "request", id, message }));
      const reply = until(() => socket.received.find(frame => frame.kind === "reply" && frame.id === id), `the reply to ${message.type}`)
        .then(frame => frame.response);
      pendingReplies.set(id, reply);
      return reply;
    },
  };
}

function dictionary(id, title, language, extra = {}) {
  return { id, title, displayName: null, path: `/dicts/.hdw-generation-00000000-0000-4000-8000-${id.padStart(12, "0").slice(-12)}/${title}`,
    favorite: false, revision: "1", isUpdatable: false, indexUrl: null, downloadUrl: null, language, frequencyMode: null,
    termCount: 3, frequencyCount: 0, pitchCount: 0, kanjiCount: 0, mediaCount: 0, installedAt: "2026-10-01T00:00:00.000Z",
    lastUpdateCheck: null, ...extra };
}

const JA_DICTIONARY = dictionary("1", "Japanese words", "ja");
const EN_DICTIONARY = dictionary("2", "English words", "en");
const AR_DICTIONARY = dictionary("3", "Arabic words", "ar");

function singleProfileRecords() {
  return {
    options: { revision: 4, hoverEnabled: true, scanLength: 12 },
    dictionaryState: { schemaVersion: 1, revision: 7, dictionaries: [{ ...JA_DICTIONARY, enabled: true }], groups: [] },
    lookupStats: { generation: "ja-generation", revision: 3 },
  };
}

// Records with a profile per language of `languages`, each with its own dictionary.
function profileRecords(languages, { revision = 10, extra = {} } = {}) {
  const rows = { ja: JA_DICTIONARY, en: EN_DICTIONARY, ar: AR_DICTIONARY };
  return {
    options: { revision, hoverEnabled: true, profiles: languages.map(code => ({ id: code, language: code,
      settings: { scanLength: code === "ja" ? 12 : 20 }, packSettings: {} })) },
    dictionaryState: { schemaVersion: 2, revision: revision + 20, dictionaries: Object.values(rows),
      profiles: Object.fromEntries(languages.map(code => [code, { dictionaries: [{ id: rows[code].id, enabled: true }], groups: [] }])) },
    lookupStats: { generation: "ja-generation", revision: 3 },
    ...extra,
  };
}

async function hosting(records, options = {}) {
  FakeSharingSocket.instances.length = 0;
  const relay = createRelay();
  const host = installation({ name: "host", records, ...options });
  await until(() => FakeSharingSocket.instances.some(socket => socket.url.endsWith("/host") && socket.readyState === 1), "the host's relay connection");
  return { relay, host };
}

async function linked(name, codes, { overlayMode = false, records = {} } = {}) {
  const client = installation({ name, codes, records, overlayMode });
  const reply = await client.sharing("hd_sharing_client_link", { address: "127.0.0.1:8771" });
  assert.equal(reply.ok, true, reply.error);
  await until(async () => (await client.sharing("hd_sharing_status")).sharing.client.connected, `${name} to connect`);
  return client;
}

const languageProfilesOf = async client => (await client.sharing("hd_sharing_status")).sharing.client.languageProfiles;

test("a single-profile host keeps today's hello, its one broadcast and its replies", async () => {
  const { relay, host } = await hosting(singleProfileRecords());
  try {
    const older = await olderClient();
    assert.deepEqual(older.hello.capabilities, ["linked-anki-v1", "linked-anki-v2", "hoshidicts-api-v1", "linked-import-v1"]);
    assert.deepEqual(older.hello.snapshot.options, singleProfileRecords().options);
    const client = await linked("aware", ["ja", "en", "ar"]);
    const linkSockets = FakeSharingSocket.instances.filter(socket => socket.url.endsWith("/link") && socket !== older.socket);
    assert.ok(linkSockets.every(socket => !socket.sent.some(frame => frame.message?.type === "hd_language_profiles_opt_in")),
      "a profile-aware browser does not opt in without the capability");
    assert.equal(await languageProfilesOf(client), undefined, "and its status is today's");
    assert.deepEqual(client.stored("options"), singleProfileRecords().options);
    await host.write({ options: { ...singleProfileRecords().options, revision: 5, scanLength: 14 } });
    await until(() => relay.broadcasts().some(frame => frame.changes.options?.revision === 5), "the broadcast");
    assert.equal(relay.log.filter(frame => frame.kind === "send" && JSON.parse(frame.text).kind === "storage").length, 0,
      "change frames go out as one broadcast");
    const read = await older.send({ target: "hoshidicts-worker", type: "hd_state_read", requestId: "read" });
    assert.deepEqual(Object.keys(read).sort(), ["error", "legacyDictionaries", "ok", "requestId", "state", "type"]);
  } finally {
    relay.stop();
  }
});

test("a host that gains profiles closes every connection once its requests have finished; each comes back with its projection", async () => {
  const { relay, host } = await hosting(singleProfileRecords());
  try {
    const older = await olderClient();
    const client = await linked("aware", ["ja", "en", "ar"]);
    // A request of the older browser running across the change.
    let release;
    host.context.gate = new Promise(resolve => { release = resolve; });
    const blocker = runInContext("serialiseStorage(() => gate)", host.context);
    const running = older.send({ target: "hoshidicts-worker", type: "hd_options_write", requestId: "write", baseRevision: 4,
      options: { hoverEnabled: false } });
    await wait(20);
    const framesBefore = relay.log.length;
    const gained = profileRecords(["ja", "en"], { revision: 5 });
    await host.write({ options: gained.options, dictionaryState: gained.dictionaryState });
    await wait(20);
    const lookup = await older.send({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "lookup", text: "猫" });
    const refused = await older.send({ target: "hoshidicts-worker", type: "hd_state_read", requestId: "read" });
    assert.equal(lookup.ok, true, "requests sent after the change are dispatched");
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "The linked Hachidori is changing its languages. Try again.", "unless their replies carry records");
    assert.equal(relay.closes().includes(older.socket.clientId), false, "the connection waits for its running request");
    release();
    await blocker;
    const written = await running;
    assert.equal(written.ok, false, "the write met the change's newer revision");
    assert.equal(written.conflict, true);
    assert.equal(Object.hasOwn(written.options, "profiles"), false, "its reply carries the Japanese view");
    assert.equal(written.options.revision, 5);
    assert.equal(written.options.scanLength, 12);
    await until(() => relay.closes().includes(older.socket.clientId), "the older connection to close");
    assert.equal(relay.log.slice(framesBefore).filter(frame => frame.kind === "broadcast"
      || (frame.kind === "send" && JSON.parse(frame.text).kind === "storage")).length, 0, "no change frame carries the change");
    // The older browser says hello again and reads the Japanese view.
    const again = await olderClient();
    assert.ok(again.hello.capabilities.includes("language-profiles-v1"));
    assert.equal(again.hello.snapshot.dictionaryState.schemaVersion, 1);
    assert.equal(Object.hasOwn(again.hello.snapshot.options, "profiles"), false);
    // The profile-aware browser comes back opted in, at newer revisions.
    await until(async () => (await languageProfilesOf(client))?.optIn === "accepted", "the opt-in");
    assert.deepEqual(await languageProfilesOf(client), { capability: true, optIn: "accepted", missingLanguages: [],
      hostLanguages: ["ja", "en", "ar"] });
    await until(() => client.stored("options")?.profiles?.length === 2, "the records with profiles in the mirror");
    assert.equal(client.stored("dictionaryState").schemaVersion, 2);
    assert.ok(client.stored("options").revision > 4);
  } finally {
    relay.stop();
  }
});

test("an older browser reads the Japanese view in its hello, change frames and replies, and its profileId is ignored", async () => {
  const records = profileRecords(["ja", "en"]);
  records.lookupStats = { generation: "ja-generation", revision: 3, languages: { en: "en-generation" } };
  const { relay, host } = await hosting(records);
  try {
    const older = await olderClient();
    assert.ok(older.hello.capabilities.includes("language-profiles-v1"));
    assert.deepEqual(older.hello.snapshot.dictionaryState, profileState.japaneseDictionaryView(records.dictionaryState));
    assert.deepEqual(older.hello.snapshot.lookupStats, { generation: "ja-generation", revision: 3 });
    await host.write({
      lookupStats: { ...records.lookupStats, revision: 4 },
      'lookupStats:"ja-generation":["猫",""]': { term: "猫", reading: "", lookupCount: 1, firstLookedUpAt: 1, lastLookedUpAt: 1 },
      'lookupStats:"en-generation":["run",""]': { term: "run", reading: "", lookupCount: 1, firstLookedUpAt: 1, lastLookedUpAt: 1 },
    });
    const frame = await until(() => older.frames("storage")[0], "the older browser's change frame");
    assert.deepEqual(Object.keys(frame.changes).sort(), ['lookupStats', 'lookupStats:"ja-generation":["猫",""]']);
    assert.deepEqual(frame.changes.lookupStats, { generation: "ja-generation", revision: 4 });
    const read = await older.send({ target: "hoshidicts-worker", type: "hd_state_read", requestId: "read" });
    assert.deepEqual(Object.keys(read).sort(), ["error", "legacyDictionaries", "ok", "requestId", "state", "type"]);
    assert.equal(read.state.schemaVersion, 1);
    const written = await older.send({ target: "hoshidicts-worker", type: "hd_options_write", requestId: "write", baseRevision: 10,
      profileId: "en", options: { scanLength: 33 } });
    assert.equal(written.ok, true, written.error);
    assert.equal(written.options.scanLength, 33);
    assert.equal(Object.hasOwn(written.options, "profiles"), false);
    const stored = host.stored("options");
    assert.equal(stored.profiles.find(profile => profile.id === "ja").settings.scanLength, 33, "the write goes to the Japanese profile");
    assert.equal(stored.profiles.find(profile => profile.id === "en").settings.scanLength, 20);
    const addition = await older.send({ target: "hoshidicts-offscreen", type: "hd_profile_add", requestId: "add", language: "ar", copyFrom: "ja" });
    assert.equal(addition.ok, false, "a browser that has not opted in adds no language");
    assert.equal(host.relayed.some(message => message.type === "hd_profile_add"), false);
  } finally {
    relay.stop();
  }
});

test("a browser that lacks a language the host holds only through data is refused, then accepted after that language is erased", async () => {
  const records = profileRecords(["ja", "en"]);
  records.lookupStats = { generation: "ja-generation", revision: 3, languages: { ar: "ar-generation" } };
  const { relay, host } = await hosting(records);
  try {
    const client = await linked("no-arabic", ["ja", "en"]);
    await until(async () => (await languageProfilesOf(client))?.optIn === "refused", "the refusal");
    const profiles = await languageProfilesOf(client);
    assert.deepEqual(profiles, { capability: true, optIn: "refused", missingLanguages: ["ar"], hostLanguages: ["ja", "en", "ar"] });
    assert.equal(Object.hasOwn(client.stored("options"), "profiles"), false, "it keeps the Japanese view");
    assert.equal(client.stored("dictionaryState").schemaVersion, 1);
    const add = await client.engine("hd_profile_add", { language: "en", copyFrom: "ja" });
    assert.equal(add.ok, false);
    assert.equal(add.error, "Update Hachidori in this browser to use Arabic from another browser.");
    const status = await client.sharing("hd_sharing_status");
    assert.equal(status.sharing.client.languageProfiles.optIn, "refused");
    // Erasing Arabic's counts leaves only languages this browser has.
    await host.write({ lookupStats: { generation: "ja-generation", revision: 4 } });
    await until(async () => (await languageProfilesOf(client))?.optIn === "accepted", "the opt-in after the erase");
    await until(() => client.stored("options")?.profiles?.length === 2, "the real records");
    assert.equal(client.stored("lookupStats").revision, 4);
  } finally {
    relay.stop();
  }
});

test("an opted-in browser never stores a profile it lacks when the host adds one, also with a write in flight across the add", async () => {
  const { relay, host } = await hosting(profileRecords(["ja", "en"]));
  try {
    const client = await linked("no-arabic", ["ja", "en"]);
    await until(async () => (await languageProfilesOf(client))?.optIn === "accepted", "the opt-in");
    client.recordWrites();
    let release;
    host.context.gate = new Promise(resolve => { release = resolve; });
    const blocker = runInContext("serialiseStorage(() => gate)", host.context);
    const writing = client.worker("hd_options_write", { baseRevision: 10, profileId: "en", options: { scanLength: 25 } });
    await wait(30);
    const added = profileRecords(["ja", "en", "ar"], { revision: 11 });
    await host.write({ options: added.options, dictionaryState: { ...added.dictionaryState, revision: 31 } });
    release();
    await blocker;
    const page = await writing;
    assert.equal(page.ok, false, "the write met the add's newer revision");
    assert.equal(Object.hasOwn(page.options ?? {}, "profiles"), false, "and its page gets the Japanese view");
    await until(async () => (await languageProfilesOf(client))?.optIn === "refused", "the refusal after the add");
    assert.deepEqual((await languageProfilesOf(client)).missingLanguages, ["ar"]);
    const stored = client.writes.flatMap(values => Object.values(values));
    assert.equal(stored.some(value => JSON.stringify(value ?? null).includes('"language":"ar"')), false,
      "no write to this browser's storage carried the Arabic profile");
    assert.equal(Object.hasOwn(client.stored("options"), "profiles"), false);
  } finally {
    relay.stop();
  }
});

test("an older browser linked to an English-only host finds nothing and its writes are refused, except global keys", async () => {
  const { relay, host } = await hosting(profileRecords(["en"]));
  try {
    const older = await olderClient();
    assert.deepEqual(older.hello.snapshot.dictionaryState.dictionaries.map(entry => entry.enabled), [false, false, false]);
    const lookup = await older.send({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "lookup", text: "猫" });
    assert.deepEqual(lookup.results, []);
    assert.deepEqual(host.relayed.find(message => message.type === "hd_lookup").dictionaries, []);
    const profileWrite = await older.send({ target: "hoshidicts-worker", type: "hd_options_write", requestId: "w1", baseRevision: 10,
      options: { scanLength: 3 } });
    assert.equal(profileWrite.ok, false);
    assert.equal(profileWrite.error, "This Hachidori has no Japanese profile. Add Japanese in its Settings, or update the linked browser.");
    const globalWrite = await older.send({ target: "hoshidicts-worker", type: "hd_options_write", requestId: "w2", baseRevision: 10,
      options: { hoverEnabled: false } });
    assert.equal(globalWrite.ok, true, globalWrite.error);
    assert.equal(host.stored("options").hoverEnabled, false);
    const semanticRevision = await customDictionarySemanticRevision([]);
    const custom = await older.send({ target: "hoshidicts-worker", type: "hd_custom_cas", requestId: "c", baseDocumentRevision: 0,
      baseRevision: 30, text: "", semanticRevision });
    assert.equal(custom.ok, false);
    assert.equal(custom.errorCode, "no-japanese-profile");
  } finally {
    relay.stop();
  }
});

test("languages are added on the host only by opted-in browsers, never at first run, and only with the host's packs", async () => {
  const { relay, host } = await hosting(profileRecords(["ja", "en"]), { codes: ["ja", "en"] });
  try {
    const client = await linked("aware", ["ja", "en", "ar"]);
    await until(async () => (await languageProfilesOf(client))?.optIn === "accepted", "the opt-in");
    assert.deepEqual((await languageProfilesOf(client)).hostLanguages, ["ja", "en"]);
    const missing = await client.engine("hd_profile_add", { language: "ar", copyFrom: "ja" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "The linked Hachidori does not have Arabic. Update it and try again.");
    const forwarded = await client.engine("hd_profile_remove", { profileId: "en" });
    assert.equal(forwarded.ok, true, forwarded.error);
    assert.deepEqual(host.relayed.filter(message => message.type === "hd_profile_remove").map(message => message.profileId), ["en"]);
    // The host refuses the pack it lacks itself, and strips a first-run flag.
    const socket = FakeSharingSocket.instances.find(entry => entry.url.endsWith("/link") && entry.readyState === 1 && entry.clientId);
    socket.send(JSON.stringify({ kind: "request", id: "direct-add", message: { target: "hoshidicts-offscreen", type: "hd_profile_add",
      requestId: "direct-add", language: "ar", copyFrom: "ja" } }));
    socket.send(JSON.stringify({ kind: "request", id: "first-run", message: { target: "hoshidicts-offscreen", type: "hd_profile_add",
      requestId: "first-run", language: "en", copyFrom: "ja", firstRun: true } }));
    const direct = await until(() => socket.received.find(frame => frame.id === "direct-add"), "the host's refusal");
    assert.equal(direct.response.error, "The linked Hachidori does not have Arabic. Update it and try again.");
    await until(() => host.relayed.some(message => message.requestId === "first-run"), "the forwarded add");
    assert.equal(Object.hasOwn(host.relayed.find(message => message.requestId === "first-run"), "firstRun"), false);
  } finally {
    relay.stop();
  }
});

test("a link to a host without profiles says how to add a language; selection stays in each browser", async () => {
  const { relay } = await hosting(singleProfileRecords());
  try {
    const client = await linked("aware", ["ja", "en", "ar"]);
    const add = await client.engine("hd_profile_add", { language: "en", copyFrom: "ja" });
    assert.equal(add.ok, false);
    assert.equal(add.error, "Add English on another browser first; if its Settings have no Language section, update it.");
    assert.equal(protocol.forwardableRequest({ target: "hoshidicts-worker", type: "hd_language_selection_write" }), false);
  } finally {
    relay.stop();
  }
});

test("unlinking keeps the browser's own English counts and document, above the mirror's revisions, and its language choice", async () => {
  const semanticRevision = await customDictionarySemanticRevision([{ term: "run", reading: "", definition: "to move fast" }], { readingRequired: false });
  const own = profileRecords(["ja", "en"], { revision: 3 });
  const localRow = { term: "run", reading: "", lookupCount: 4, firstLookedUpAt: 1, lastLookedUpAt: 2 };
  const localRecords = {
    ...own,
    dictionaryState: { ...own.dictionaryState, dictionaries: [...own.dictionaryState.dictionaries.slice(0, 2),
      dictionary("4", "Hachidori Custom Dictionary (English)", "en")].map(entry => (entry.id === "4" ? { ...entry, id: ENGLISH_ID } : entry)),
    profiles: { ja: own.dictionaryState.profiles.ja, en: { dictionaries: [{ id: ENGLISH_ID, enabled: true }, { id: "2", enabled: true }], groups: [] } } },
    customDictionarySource: { schemaVersion: 1, revision: 1, semanticRevision: await customDictionarySemanticRevision([]), text: "",
      languages: { en: { revision: 5, semanticRevision, text: "run, , to move fast\n" } } },
    lookupStats: { generation: "local-ja", revision: 6, languages: { en: "local-en" } },
    'lookupStats:"local-en":["run",""]': localRow,
    languageSelection: { revision: 2, activeProfileId: "en", autoSwitch: false },
  };
  const hostRecords = profileRecords(["ja", "en"], { revision: 40 });
  hostRecords.customDictionarySource = { schemaVersion: 1, revision: 9, semanticRevision: await customDictionarySemanticRevision([]), text: "",
    languages: { en: { revision: 9, semanticRevision: await customDictionarySemanticRevision([]), text: "" } } };
  hostRecords.lookupStats = { generation: "host-ja", revision: 50, languages: { en: "host-en" } };
  const { relay } = await hosting(hostRecords);
  try {
    const client = await linked("own-english", ["ja", "en"], { records: localRecords });
    await until(() => client.stored("options")?.revision === 40, "the host's records");
    await client.write({ 'lookupStats:"host-en":["walk",""]': { term: "walk", reading: "", lookupCount: 1, firstLookedUpAt: 1, lastLookedUpAt: 1 } });
    const unlinked = await client.sharing("hd_sharing_client_unlink");
    assert.equal(unlinked.ok, true, unlinked.error);
    assert.deepEqual(client.stored('lookupStats:"local-en":["run",""]'), localRow, "the browser's own English counts are kept");
    assert.equal(client.stored('lookupStats:"host-en":["walk",""]'), undefined, "the host's rows leave with the link");
    const document = client.stored("customDictionarySource");
    assert.equal(document.languages.en.revision, 10, "one above the higher of its captured and mirrored revisions");
    assert.equal(document.languages.en.text, "run, , to move fast\n");
    assert.equal(document.revision, 10);
    assert.deepEqual(client.stored("lookupStats").languages, { en: "local-en" });
    assert.deepEqual(client.stored("languageSelection"), { revision: 3, activeProfileId: "en", autoSwitch: false });
    assert.equal(client.stored("options").revision, 41);
  } finally {
    relay.stop();
  }
});

test("an overlay linked to a host with profiles lays its local keys over every profile", async () => {
  const { relay } = await hosting(profileRecords(["ja", "en"]));
  try {
    const overlay = await linked("overlay", ["ja", "en", "ar"], { overlayMode: true,
      records: { options: { revision: 2, popupColumns: 3, lookupMode: "activation" } } });
    await until(() => overlay.stored("options")?.profiles?.length === 2, "the host's profiles");
    const options = overlay.stored("options");
    assert.equal(options.lookupMode, "activation");
    assert.deepEqual(options.profiles.map(profile => profile.settings.popupColumns), [3, 3]);
    assert.deepEqual(options.profiles.map(profile => profile.settings.scanLength), [12, 20], "the host's own values stay");
  } finally {
    relay.stop();
  }
});

test("the linked Anki, Anki setup and import allowlists keep a validated profileId, and the upload passes it on", async () => {
  const anki = protocol.allowLinkedAnkiRequest({ target: "hachidori-anki", type: "hd_anki_status", requestId: 1, profileId: "en", extra: 1 });
  assert.deepEqual(anki, { target: "hachidori-anki", type: "hd_anki_status", requestId: 1, profileId: "en" });
  assert.throws(() => protocol.allowLinkedAnkiRequest({ target: "hachidori-anki", type: "hd_anki_status", profileId: "\u0000" }),
    /malformed linked profile/u);
  assert.deepEqual(protocol.allowLinkedAnkiSetupRequest({ target: "hoshidicts-worker", type: "hd_anki_setup", templateId: "t", profileId: "en" }),
    { target: "hoshidicts-worker", type: "hd_anki_setup", requestId: null, templateId: "t", profileId: "en" });
  const begin = protocol.allowLinkedImportRequest({ target: "hachidori-linked-import", type: "hd_import_begin", fileName: "a.zip",
    size: 4, replace: false, profileId: "en" });
  assert.equal(begin.profileId, "en");
  const imported = [];
  const host = createUploadHost({ store: { append: async () => {}, discard: async () => {} },
    importUpload: async (token, fields) => { imported.push(fields); return { ok: true }; } });
  const { token } = host.begin(begin, "remote");
  await host.chunk({ token, offset: 0, data: "AAAAAA==" }, "remote");
  await host.commit({ token }, "remote");
  assert.deepEqual(imported, [{ fileName: "a.zip", replace: false, profileId: "en" }]);
  assert.equal(protocol.mutatingForwardedRequest({ target: "hoshidicts-offscreen", type: "hd_profile_add" }), true);
  assert.equal(protocol.forwardableRequest({ target: "hoshidicts-worker", type: "hd_language_profiles_opt_in" }), true);
});

test("the Japanese view of change frames and replies", () => {
  const { japaneseChanges, japaneseReply, recordLanguages, snapshotLanguages } = sharingLanguages;
  const records = profileRecords(["ja", "en"]);
  const changes = { options: records.options, 'lookupStats:"en":["a",""]': { term: "a" }, 'lookupStats:"en":["b",""]': null };
  assert.deepEqual(Object.keys(japaneseChanges(changes, { generation: "ja", revision: 1 })), ["options", 'lookupStats:"en":["b",""]']);
  assert.equal(japaneseChanges({ 'lookupStats:"en":["a",""]': { term: "a" } }, { generation: "ja", revision: 1 }), null);
  const reply = japaneseReply("hd_state_read", { ok: true, state: records.dictionaryState, languages: ["ja", "en"] });
  assert.equal(reply.state.schemaVersion, 1);
  assert.equal(Object.hasOwn(reply, "languages"), false);
  assert.deepEqual(japaneseReply("hd_lookup", { ok: true, results: [] }), { ok: true, results: [] });
  assert.deepEqual([...recordLanguages("options", records.options)], ["en"]);
  assert.deepEqual([...snapshotLanguages({ ...records, wordStatusOverrides: { revision: 1, known: [], ignored: [],
    languages: { ar: { known: ["x"], ignored: [] } } } })].sort(), ["ar", "en"]);
  assert.deepEqual(japaneseView.japaneseRecord("customDictionarySource", { schemaVersion: 1, revision: 1, text: "", semanticRevision: "0",
    languages: { en: {} } }), { schemaVersion: 1, revision: 1, text: "", semanticRevision: "0" });
  assert.equal(CUSTOM_DICTIONARY_ID.length, 32);
});

test("Settings → Sharing names the languages a refused browser needs", async t => {
  const { createRequire } = await import("node:module");
  const { homedir } = await import("node:os");
  const { resolve } = await import("node:path");
  const require = createRequire(import.meta.url);
  const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
    || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
  const { createSharingSettingsController } = await import("../extension/sharing-settings.js");
  const dom = new JSDOM(readFileSync(new URL("extension/settings.html", ROOT), "utf8"), { url: "https://extension.test/settings.html" });
  const statuses = [];
  const client = { linked: true, address: "ws://127.0.0.1:8771/link", display: "this computer", connected: true, error: null,
    host: { version: "0.4.0", name: "Chrome", dictionaryCount: 5 },
    languageProfiles: { capability: true, optIn: "refused", missingLanguages: ["vi", "ar"], hostLanguages: ["ja", "ar", "vi"] } };
  const sharing = { enabled: false, connected: false, port: 8771, dictionaries: 0, error: null,
    network: { enabled: false, active: false, addresses: [], error: null }, clients: [], client };
  const controller = createSharingSettingsController({ document: dom.window.document,
    send: async () => ({ ok: true, sharing }), setStatus: (message, tone) => statuses.push([message, tone]), downloadAddon: async () => {} });
  t.after(() => { controller.stop(); dom.window.close(); });
  controller.start();
  await until(() => statuses.length > 0, "the status line");
  assert.deepEqual(statuses.at(-1), ["Using the Hachidori in Chrome on this computer (5 dictionaries). "
    + "Update Hachidori in this browser to use Vietnamese and Arabic from Chrome.", undefined]);
});

test("a profile-aware client opts in before storing anything and discards change frames until the reply", async () => {
  const { createSharingClient } = await import("../extension/sharing-client.js");
  const sockets = [];
  class Socket {
    constructor(url) { Object.assign(this, { url, sent: [], readyState: 0 }); sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  }
  const batches = [];
  const client = createSharingClient({ WebSocket: Socket, version: "0.4.0", name: "Chrome", languages: () => ["ja", "en"],
    applyBatch: async (changes, isCurrent, snapshot = false) => { if (isCurrent()) batches.push({ changes, snapshot }); } });
  client.link("ws://127.0.0.1:8771/link");
  const [socket] = sockets;
  socket.readyState = 1;
  socket.onopen();
  assert.deepEqual(socket.sent[0].capabilities, ["linked-anki-v1", "linked-anki-v2"], "the client's hello does not change");
  const view = { options: { revision: 3 } };
  socket.receive({ kind: "hello", protocol: 1, version: "0.4.0", name: "Chrome", dictionaryCount: 1,
    capabilities: ["linked-anki-v2", "language-profiles-v1"], snapshot: view });
  await wait(5);
  const request = socket.sent.find(frame => frame.message?.type === "hd_language_profiles_opt_in");
  assert.deepEqual(request.message.languages, ["ja", "en"]);
  assert.deepEqual(batches, [], "the hello's snapshot is not stored");
  socket.receive({ kind: "storage", changes: { options: { revision: 3, scanLength: 1 } } });
  await wait(5);
  assert.deepEqual(batches, [], "a change frame before the reply is discarded");
  assert.equal(client.status().connected, false);
  const records = { options: { revision: 3, profiles: [{ id: "ja", language: "ja", settings: {}, packSettings: {} }] } };
  socket.receive({ kind: "reply", id: request.id, response: { ok: true, optIn: "accepted", snapshot: records,
    missingLanguages: [], hostLanguages: ["ja", "en", "ar"] } });
  await wait(5);
  socket.receive({ kind: "storage", changes: { options: { ...records.options, revision: 4 } } });
  await wait(5);
  assert.deepEqual(batches, [{ changes: records, snapshot: true }, { changes: { options: { ...records.options, revision: 4 } }, snapshot: false }]);
  assert.deepEqual(client.status().languageProfiles, { capability: true, optIn: "accepted", missingLanguages: [],
    hostLanguages: ["ja", "en", "ar"] });
  // A failed opt-in stores nothing and starts the connection over.
  client.link("ws://127.0.0.1:8771/link");
  const second = sockets[1];
  second.readyState = 1;
  second.onopen();
  second.receive({ kind: "hello", protocol: 1, version: "0.4.0", name: "Chrome", dictionaryCount: 1,
    capabilities: ["language-profiles-v1"], snapshot: view });
  await wait(5);
  const retry = second.sent.find(frame => frame.message?.type === "hd_language_profiles_opt_in");
  second.receive({ kind: "reply", id: retry.id, response: { ok: false, error: "The linked Hachidori is changing its languages. Try again." } });
  await wait(5);
  assert.equal(second.readyState, 3);
  assert.equal(batches.length, 2);
  assert.equal(client.status().error, "The linked Hachidori is changing its languages. Try again.");
  client.unlink();
});
