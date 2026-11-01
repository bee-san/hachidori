// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pronunciation per language profile (docs/languages.md 13): browser speech in
// the pack's `host.ttsLanguage`, with messages that name the language; the
// pack's `host.audioLanguage` in URL templates; Settings' Test with the pack's
// sample entry; Local Audio Server for Japanese only; and the worker naming the
// language of the profile a request is for. Japanese, and a request without a
// profile, keep today's ja-JP, 聞く and wording.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { PACKS } from "./theme-languages-fixtures.mjs";
import { registryOf } from "./language-settings-harness.mjs";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(homedir(), ".cache/hachidori-e2e")] }));

const vendored = {};
vendored.globalThis = vendored;
vm.runInNewContext(readFileSync(new URL("../extension/vendor/languages/registry.js", import.meta.url), "utf8"), vendored);
const REGISTRY = { ja: vendored.HDLanguages.get("ja"), en: PACKS.en, ar: PACKS.ar };
globalThis.HDLanguages = registryOf(REGISTRY);

await import("../extension/reader-options.js");
const { audioSourceUrl, pronunciationLanguage } = await import("../extension/audio-sources.js");
const { createAudioRepository } = await import("../extension/audio-repository.js");
const { createAudioPlayer } = await import("../extension/audio-player.js");
const { createAudioService } = await import("../extension/audio-offscreen.js");
const { exportAnkiAudio } = await import("../extension/anki-audio.js");
const { createAudioSettingsController } = await import("../extension/audio-settings.js");

const RUN = { expression: "run", reading: "run" };
const SPEECH = { id: "speech", type: "text-to-speech-reading", enabled: true, url: "", voice: "" };
const VOICES = [
  { voiceURI: "kyoko", name: "Kyoko", lang: "ja-JP", default: true },
  { voiceURI: "google-ja", name: "Google 日本語", lang: "ja-JP" },
  { voiceURI: "samantha", name: "Samantha", lang: "en-US", default: true },
  { voiceURI: "google-uk", name: "Google UK English Female", lang: "en-GB" },
  { voiceURI: "maged", name: "Maged", lang: "ar-SA" },
];

function speechWindow(voices = VOICES) {
  const utterances = [];
  return {
    utterances,
    URL: { createObjectURL: () => "blob:audio", revokeObjectURL() {} },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: {
      getVoices: () => voices,
      addEventListener() {}, removeEventListener() {},
      speak(utterance) { utterances.push(utterance); queueMicrotask(() => utterance.onend?.()); },
      cancel() {},
    },
  };
}

test("a profile's pronunciation language is its pack's; a request without one keeps Japanese", () => {
  assert.equal(pronunciationLanguage(undefined), null);
  assert.equal(pronunciationLanguage("vi"), null, "a language this build has no pack for");
  assert.deepEqual(pronunciationLanguage("en"), { code: "en", name: "English", speech: "en-US", url: "en" });
  assert.deepEqual(pronunciationLanguage("ja"), { code: "ja", name: "Japanese", speech: "ja-JP", url: "ja" });
  const template = "https://audio.example/{language}/{term}?r={reading}";
  assert.equal(audioSourceUrl(template, RUN), "https://audio.example/ja/run?r=run", "{language} is ja without a profile");
  assert.equal(audioSourceUrl(template, RUN, pronunciationLanguage("en").url), "https://audio.example/en/run?r=run");
  assert.equal(audioSourceUrl(template, { expression: "كتاب", reading: "كتاب" }, "ar"),
    "https://audio.example/ar/%D9%83%D8%AA%D8%A7%D8%A8?r=%D9%83%D8%AA%D8%A7%D8%A8");
});

test("browser speech speaks the pack's language with that language's voice, Google's first as for Japanese", async () => {
  const window = speechWindow();
  const player = createAudioPlayer({ window, fetch: () => assert.fail("speech fetches nothing") });
  for (const [language, text, lang, voice] of [
    [null, "きく", "ja-JP", "google-ja"],
    [pronunciationLanguage("ja"), "きく", "ja-JP", "google-ja"],
    [pronunciationLanguage("en"), "run", "en-US", "google-uk"],
    [pronunciationLanguage("ar"), "كتاب", "ar-SA", "maged"],
  ]) {
    const term = language?.code === "ar" ? { expression: "كتاب", reading: "كتاب" }
      : language?.code === "en" ? RUN : { expression: "聞く", reading: "きく" };
    const played = await player.play(SPEECH, term, { language });
    assert.equal(played.status, "success");
    const utterance = window.utterances.at(-1);
    assert.deepEqual([utterance.text, utterance.lang, utterance.voice.voiceURI], [text, lang, voice]);
    assert.equal(played.candidate.voice, "");
  }
  const japaneseOnly = createAudioPlayer({ window: speechWindow(VOICES.slice(0, 2)), fetch: () => assert.fail() });
  await assert.rejects(japaneseOnly.play(SPEECH, RUN, { language: pronunciationLanguage("en") }),
    { message: "No English speech voice is available. Install a voice for English or add an audio provider in Audio Settings." });
  const englishOnly = createAudioPlayer({ window: speechWindow(VOICES.slice(2, 4)), fetch: () => assert.fail() });
  for (const language of [null, pronunciationLanguage("ja")]) {
    await assert.rejects(englishOnly.play(SPEECH, RUN, { language }), { message:
      "No Japanese speech voice is available. Install a Japanese voice or add an audio provider in Audio Settings." });
  }
});

test("the repository names automatic speech after the language and fills {language} from the pack", async () => {
  const fetched = [];
  const repository = createAudioRepository({ window: speechWindow(), now: () => 0, fetch: async url => {
    fetched.push(url);
    return { ok: true, json: async () => ({ type: "audioSourceList", audioSources: [{ url: `${url}.mp3`, name: "Clip" }] }) };
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await repository.candidates(SPEECH, RUN, signal), [{ name: "Automatic Japanese" }]);
  assert.deepEqual(await repository.candidates(SPEECH, RUN, signal, pronunciationLanguage("en")), [{ name: "Automatic English" }]);
  const list = { id: "list", type: "custom-json", enabled: true, url: "https://audio.example/{language}/{term}", voice: "" };
  await repository.candidates(list, RUN, signal);
  await repository.candidates(list, RUN, signal, pronunciationLanguage("en"));
  await repository.candidates(list, RUN, signal, pronunciationLanguage("en"));
  assert.deepEqual(fetched, ["https://audio.example/ja/run", "https://audio.example/en/run"],
    "each language has its own cached list");
});

test("Settings' Test plays the pack's sample entry in its language, and Japanese keeps 聞く", async () => {
  const window = { ...speechWindow(), performance, addEventListener() {}, setTimeout, clearTimeout,
    chrome: { runtime: { sendMessage: async () => {} } }, fetch: async () => assert.fail("speech fetches nothing") };
  const service = createAudioService(window);
  const test = fields => service({ type: "hd_audio_test", source: SPEECH, owner: "settings", requestId: crypto.randomUUID(), ...fields });
  assert.equal((await test({ term: RUN, language: "en" })).status, "success");
  assert.deepEqual([window.utterances.at(-1).text, window.utterances.at(-1).lang], ["run", "en-US"]);
  assert.equal((await test({ language: "ja" })).status, "success");
  assert.deepEqual([window.utterances.at(-1).text, window.utterances.at(-1).lang], ["きく", "ja-JP"]);
  assert.equal((await test({})).status, "success");
  assert.deepEqual([window.utterances.at(-1).text, window.utterances.at(-1).lang], ["きく", "ja-JP"]);
  // The popup's choices name automatic speech after the request's language.
  const { groups } = await service({ type: "hd_audio_candidates", sources: [SPEECH], term: RUN, language: "en",
    owner: "reader", requestId: "choices" });
  assert.deepEqual(groups[0].candidates, [{ name: "Automatic English" }]);
});

test("a note's pronunciation fills {language} from its profile's pack", async () => {
  const fetched = [];
  const window = { ...speechWindow(), FileReader: class {}, Audio: class {} };
  const repository = createAudioRepository({ window, now: () => 0, fetch: async url => {
    fetched.push(url);
    return { ok: true, json: async () => ({ type: "audioSourceList", audioSources: [] }) };
  } });
  const list = { id: "list", type: "custom-json", enabled: true, url: "https://audio.example/{language}/{term}", voice: "" };
  const term = { expression: "كتاب", reading: "كتاب" };
  await assert.rejects(exportAnkiAudio(window, repository, { sources: [list], term, language: "ar" }, new AbortController().signal),
    /No downloadable pronunciation/u);
  await assert.rejects(exportAnkiAudio(window, repository, { sources: [list], term }, new AbortController().signal),
    /No downloadable pronunciation/u);
  assert.deepEqual(fetched, ["https://audio.example/ar/%D9%83%D8%AA%D8%A7%D8%A8", "https://audio.example/ja/%D9%83%D8%AA%D8%A7%D8%A8"]);
});

// ---------------------------------------------------------------------------
// Settings → Audio
// ---------------------------------------------------------------------------

const SETTINGS_HTML = readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8");
const tick = () => new Promise(resolveTick => setImmediate(resolveTick));

function audioSettings(t, readLanguage) {
  const dom = new JSDOM(SETTINGS_HTML, { runScripts: "outside-only", url: "https://settings.example/settings.html" });
  const { window } = dom;
  t.after(() => window.close());
  window.document.getElementById("audio").hidden = false;
  window.eval(readFileSync(new URL("../extension/reader-options.js", import.meta.url), "utf8"));
  window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } };
  window.crypto.randomUUID ??= () => "request";
  window.fetch = async url => {
    const pack = String(url).match(/vendor\/languages\/([a-z]+)\/language\.json$/u)?.[1];
    return pack === "en" ? { ok: true, json: async () => ({ host: { sample: { entry: RUN } } }) } : { ok: false, status: 404 };
  };
  let sources = [SPEECH];
  const sent = [];
  const controller = createAudioSettingsController({ document: window.document, readLanguage,
    readSources: () => sources, editSources(next) { sources = next; },
    async send(type, fields) {
      sent.push({ type, ...fields });
      return type === "hd_audio_voices" ? { ok: true, voices: VOICES } : { ok: true, status: "success" };
    } });
  const row = () => window.document.querySelector("#audio-source-list .audio-source-row");
  return { window, controller, sent, row,
    async render() { controller.render(); for (let turn = 0; turn < 10; turn++) await tick(); },
    voices: () => [...row().querySelector(".audio-voice").options].map(option => option.textContent) };
}

const ENGLISH = { code: "en", name: "English", speech: "en-US", warmup: "running" };

test("Audio settings label Test and automatic speech by the edited profile's language and list its voices first", async t => {
  let language = ENGLISH;
  const f = audioSettings(t, () => language);
  await f.render();
  assert.equal(f.row().querySelector(".audio-test").getAttribute("aria-label"), "Test run: source 1");
  assert.deepEqual(f.voices().slice(0, 3), ["Automatic English", "Samantha (en-US) — online", "Google UK English Female (en-GB) — online"]);
  f.row().querySelector(".audio-test").click();
  await f.render();
  const tested = f.sent.find(message => message.type === "hd_audio_test");
  assert.deepEqual(tested.term, RUN, "Test plays the pack's sample entry");
  // Japanese keeps 聞く, its label and its voices first.
  language = { code: "ja", name: "Japanese", speech: "ja-JP", warmup: "食べました" };
  await f.render();
  assert.equal(f.row().querySelector(".audio-test").getAttribute("aria-label"), "Test 聞く / きく: source 1");
  assert.deepEqual(f.voices().slice(0, 3), ["Automatic Japanese", "Kyoko (ja-JP) — online", "Google 日本語 (ja-JP) — online"]);
  f.sent.length = 0;
  f.row().querySelector(".audio-test").click();
  await f.render();
  assert.equal(Object.hasOwn(f.sent.find(message => message.type === "hd_audio_test"), "term"), false);
});

test("without a language Audio settings are today's", async t => {
  const f = audioSettings(t, () => null);
  await f.render();
  assert.equal(f.row().querySelector(".audio-test").getAttribute("aria-label"), "Test 聞く / きく: source 1");
  assert.equal(f.voices()[0], "Automatic Japanese");
  f.row().querySelector(".audio-test").click();
  await f.render();
  assert.deepEqual(Object.keys(f.sent.find(message => message.type === "hd_audio_test")).sort(), ["requestId", "source", "type"]);
});

test("Local Audio Server detection is offered only in Japanese", () => {
  const { document } = new JSDOM(SETTINGS_HTML).window;
  const row = document.getElementById("anki-audio-check").closest("[data-requires]");
  assert.ok(row?.contains(document.getElementById("anki-audio-add")));
  const requirement = JSON.parse(row.dataset.requires);
  const { optionRequirementMet } = globalThis.HDReaderOptions;
  assert.deepEqual([optionRequirementMet(requirement, "ja"), optionRequirementMet(requirement, "en"),
    optionRequirementMet(requirement, "ar")], [true, false, false]);
});

// ---------------------------------------------------------------------------
// The service worker names the profile's language
// ---------------------------------------------------------------------------

const { loadBackgroundScript, makeAlarms, makeBus, makeChrome, makeStorage } = await import("./extension-smoke/fakes.mjs");
const profileState = await import("../extension/profile-state.js");
const ankiWorker = await import("../extension/anki-worker.js");
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function audioWorker(records) {
  const bus = makeBus();
  const storage = makeStorage();
  for (const [key, value] of Object.entries(records)) storage.raw.set(key, structuredClone(value));
  const alarms = makeAlarms();
  const sandbox = {
    chrome: makeChrome("sw", bus, storage, alarms), console: quiet, Promise, Error, TypeError, JSON, URL, Map, Set,
    setTimeout: (...args) => setTimeout(...args).unref?.() ?? undefined, clearTimeout,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
    HDLanguages: globalThis.HDLanguages,
    ...Object.fromEntries(Object.entries(profileState).filter(([, value]) => typeof value === "function")),
    profileTemplateKey: ankiWorker.profileTemplateKey,
  };
  loadBackgroundScript(sandbox);
  const page = makeChrome("page", bus, storage, alarms);
  const relayed = [];
  bus.addListener("offscreen-audio", (message, _sender, respond) => {
    if (message?.relayed !== true || message.target !== "hachidori-audio") return false;
    relayed.push(structuredClone(message));
    respond({ type: `${message.type}_result`, requestId: message.requestId ?? null, ok: true, status: "success" });
    return true;
  });
  return { relayed, audio: message => page.runtime.sendMessage({ target: "hachidori-audio", ...message }) };
}

const sources = name => [{ id: name, type: "custom", enabled: true, url: `https://audio.example/${name}/{term}`, voice: "" }];
const WITH_PROFILES = { options: { revision: 3, audioSources: sources("old"), profiles: [
  { id: "ja", language: "ja", settings: { audioSources: sources("ja") }, packSettings: {} },
  { id: "en", language: "en", settings: { audioSources: sources("en") }, packSettings: {} },
] } };

test("the worker sends a profile's sources with its language, and a request without a profile as today", async () => {
  const worker = audioWorker(WITH_PROFILES);
  let reply = await worker.audio({ type: "hd_audio_play", term: RUN, requestId: "a", profileId: "en" });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(worker.relayed.at(-1).language, "en");
  assert.deepEqual(worker.relayed.at(-1).sources, sources("en"));
  reply = await worker.audio({ type: "hd_audio_test", source: SPEECH, term: RUN, requestId: "b", profileId: "en" });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual([worker.relayed.at(-1).language, worker.relayed.at(-1).term], ["en", RUN]);
  reply = await worker.audio({ type: "hd_audio_test", source: SPEECH, term: { expression: "" }, requestId: "c", profileId: "en" });
  assert.equal(reply.ok, false, "a Test word without an expression is refused");
  const today = audioWorker({ options: { revision: 1, audioSources: sources("ja") } });
  reply = await today.audio({ type: "hd_audio_play", term: RUN, requestId: "d" });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(Object.hasOwn(today.relayed.at(-1), "language"), false);
  await today.audio({ type: "hd_audio_test", source: SPEECH, requestId: "e" });
  assert.deepEqual(Object.keys(today.relayed.at(-1)).filter(key => ["language", "term", "sources"].includes(key)), []);
});
