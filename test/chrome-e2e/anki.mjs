/*
 * Mining to a fake AnkiConnect through the real popup.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./metadata.mjs";
import { describe } from "node:test";
import { AnkiConnectError, answerAnkiConnect } from "../anki-connect-fake.mjs";
import { buildTitledZip } from "../make-fixture.mjs";
import { check, HIGHLIGHT_NAME, step } from "./harness.mjs";
import { hoverForPopup } from "./popup-reader.mjs";
import { hover, popup, tab } from "./reader.mjs";
import { browser, installMediaArchive, interceptFetches, makeAudioWav, page } from "./session.mjs";

async function checkAnkiSubmission(settings, browser, tab, popup) {
  const original = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const screenshotDictionary = "screenshot-mining-layout";
  let screenshotDictionaryInstalled = false;
  const notes = new Map(), calls = [], files = new Map();
  // The values a search names: Anki's dupe: identity, or every "front:…"
  // term, which a popup's batched lookup ORs together.
  const queryExpressions = query => {
    const duplicate = /^"dupe:1,(.*)"$/u.exec(query);
    const values = duplicate ? [duplicate[1]]
      : [...query.matchAll(/"front:((?:\\.|[^"])*)"/giu)].map(match => match[1]);
    return values.map(value => value.replace(/\\(.)/gu, "$1"));
  };
  // Flags the checks below flip to make the mock refuse specific work.
  const control = { failScreenshotUpload: false, preflightGate: null };
  const apiRoute = { requests: 0, async respond(request) {
    const reply = await answerAnkiConnect(JSON.parse(request.postData), async (action, params) => {
      calls.push({ action, params });
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "modelFieldNames") return ["Front", "Back", "Audio"];
      if (action === "canAddNotesWithErrorDetail") {
        const gate = control.preflightGate;
        if (gate) await gate.promise;
        return params.notes.map(note => {
          const duplicate = [...notes.values()].some(fields => fields.Front === note.fields.Front);
          return { canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null };
        });
      }
      if (action === "addNote") { const noteId = notes.size + 1; notes.set(noteId, params.note.fields); return noteId; }
      if (action === "findNotes") {
        const expressions = queryExpressions(params.query);
        const matched = params.query === '"note:Basic"'
          ? [...notes.keys()]
          : [...notes].filter(([, fields]) => expressions.includes(fields.Front)).map(([noteId]) => noteId);
        // The mock schedules nothing, so no note is mature.
        return params.query.endsWith(" is:review -is:learn prop:ivl>=21") ? [] : matched;
      }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(notes.get(noteId)).map(([field, value]) => [field, { value }])) }));
      if (action === "updateNoteFields") { notes.set(params.note.id, { ...notes.get(params.note.id), ...params.note.fields }); return null; }
      if (action === "getMediaFilesNames") return files.has(params.pattern) ? [params.pattern] : [];
      if (action === "storeMediaFile") {
        if (control.failScreenshotUpload && params.filename.startsWith("hachidori-screenshot-")) {
          throw new AnkiConnectError("media folder is read-only");
        }
        files.set(params.filename, params.data);
        return params.filename;
      }
      if (action === "deleteMediaFile") { files.delete(params.filename); return null; }
      if (action === "guiBrowse") return [...notes.keys()];
      throw new Error(`Unexpected Anki action ${action}`);
    });
    return { body: JSON.stringify(reply), status: 200, contentType: "application/json" };
  } };
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const api = await interceptFetches(worker, new Map([["http://127.0.0.1:8765/", apiRoute]]), "anki-submission");
  const source = { id: "anki-json", type: "custom-json", url: "https://audio.example.test/anki-list", enabled: true, voice: "" };
  const chosen = { url: "https://audio.example.test/anki-chosen.wav", name: "Chosen recording" };
  const other = { url: "https://audio.example.test/anki-other.wav", name: "Other recording" };
  const wav = makeAudioWav();
  const routes = new Map([
    [source.url, { body: JSON.stringify({ type: "audioSourceList", audioSources: [other, chosen] }), contentType: "application/json", status: 200, requests: 0 }],
    [chosen.url, { body: wav, contentType: "audio/wav", status: 200, requests: 0 }],
    [other.url, { body: "must not download", contentType: "audio/wav", status: 200, requests: 0 }],
  ]);
  const target = await browser.waitForTarget(target => target.url().endsWith("/offscreen.html"));
  const media = await interceptFetches(target, routes, "anki-audio");
  const native = await target.createCDPSession();
  await native.send("Runtime.evaluate", { expression: `globalThis.__ankiNativePlay = Audio.prototype.play; globalThis.__ankiPlayCount = 0;
    Audio.prototype.play = function (...args) { globalThis.__ankiPlayCount++; return __ankiNativePlay.apply(this, args); };` });
  const configure = (audio, anki = {}) => settings.evaluate(async ({ audio, source, anki }) => {
    const { options } = await chrome.storage.local.get("options");
    const template = value => ({ value, overwriteMode: "overwrite" });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
      options: { audioSources: [source], audioAutoplay: false, popupColumns: 2,
        anki: { ...HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
        fieldTemplates: { Front: template(audio ? "{expression}{audio}" : "{expression}"), Back: template("{glossary}"), Audio: template(audio ? "{audio}" : "") }, ...anki } } });
    if (!reply.ok) throw new Error(reply.error);
  }, { audio, source, anki });
  // Experimental patches carry the complete flag record.
  const experimental = flags => settings.evaluate(async flags => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
      options: { experimental: { ...HDReaderOptions.normaliseOptions(options).experimental, ...flags } } });
    if (!reply.ok) throw new Error(reply.error);
  }, flags);
  const operation = (type, request) => settings.evaluate(async ({ type, request }) => {
    const reply = await chrome.runtime.sendMessage({ target: "hachidori-anki", type, requestId: "anki-browser-test", request });
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  }, { type, request });
  try {
    // A second real dictionary makes the screenshot view use production masonry,
    // whose cards explicitly set visibility:visible rather than inheriting it.
    await installMediaArchive(settings, buildTitledZip(screenshotDictionary, { terms: [
      ["漢字", "かんじ", "", "", 1, ["A second dictionary card for screenshot mining."], 1, ""],
    ] }));
    screenshotDictionaryInstalled = true;
    await configure(false);
    const request = await settings.evaluate(async () => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "漢字", maxResults: 4 });
      if (!reply.ok || !reply.results.length) throw new Error(reply.error || "No Anki fixture result");
      return { ...reply.results[0], generation: reply.generation, sentence: "漢字。", matched: "漢字", matchOffset: 0,
        popupSelectionText: "", searchQuery: "漢字", documentTitle: "Anki browser test", dictionaryAliases: {}, frequencyDictionaries: [] };
    });
    request.configKey = (await operation("hd_anki_status")).configKey;
    const before = await operation("hd_anki_preflight", request);
    const readOnly = !calls.some(call => ["addNote", "updateNoteFields", "storeMediaFile"].includes(call.action));
    const added = await operation("hd_anki_submit", request);
    const duplicate = await operation("hd_anki_preflight", request);
    const note = notes.get(added.noteId);
    const images = [...note.Back.matchAll(/<img[^>]+src="([^"]+)"/gu)].map(match => match[1]);
    const addIndex = calls.findIndex(call => call.action === "addNote");
    const imageStoreIndexes = images.map(filename =>
      calls.findIndex(call => call.action === "storeMediaFile" && call.params.filename === filename));
    check("Anki worker preflight is read-only and submission verifies a real-WASM result with scoped dictionary media",
      before.canAdd && readOnly && added.state === "added" && added.warnings.length === 0 && duplicate.state === "duplicate" && !duplicate.canAdd
        && images.length > 0 && images.every(filename => files.has(filename))
        // Dictionary styles are prefixed with their dictionary's item, as in
        // Yomitan's cards, so Anki's older Chromium applies them without @scope.
        && note.Back.includes(".yomitan-glossary [data-dictionary=") && !note.Back.includes("@scope")
        && imageStoreIndexes.every(index => index >= 0 && index < addIndex)
        && calls.filter(call => call.action === "addNote").length === 1 && [...routes.values()].every(route => route.requests === 0),
      JSON.stringify({ before, readOnly, added, duplicate, images, addIndex, imageStoreIndexes, actions: calls.map(call => call.action) }));

    // Smaller Anki cards (#354): the same result is written as compact HTML,
    // and the image it keeps is uploaded again once Anki no longer has it.
    await experimental({ smallerAnkiCards: true });
    const compactTemplate = value => ({ value, overwriteMode: "overwrite" });
    await configure(false, { fieldTemplates: { Front: compactTemplate("{expression} compact"),
      Back: compactTemplate("{glossary}"), Audio: compactTemplate("") } });
    const compactRequest = { ...request, configKey: (await operation("hd_anki_status")).configKey };
    for (const filename of images) files.delete(filename);
    const compactUploads = calls.filter(call => call.action === "storeMediaFile").length;
    const compactAdded = await operation("hd_anki_submit", compactRequest);
    await experimental({ smallerAnkiCards: false });
    const compactNote = notes.get(compactAdded.noteId);
    const compactImages = [...new Set([...compactNote.Back.matchAll(/<img[^>]+src="([^"]+)"/gu)].map(match => match[1]))];
    check("Smaller Anki cards mines compact glossary HTML through the real offscreen path and uploads only the images it keeps",
      compactAdded.state === "added" && compactAdded.warnings.length === 0 && compactNote.Front === "漢字 compact"
        && compactNote.Back.startsWith('<div class="yomitan-glossary" style="text-align: left;"><ol><li data-dictionary="')
        && !/<style|@scope|gloss-sc-|gsm-hoshidicts|data-hoshidicts|structured-content/u.test(compactNote.Back)
        && compactNote.Back.includes("<b>Chinese characters</b>") && compactNote.Back.includes("<i>Han</i>")
        && JSON.stringify(compactImages) === JSON.stringify([...new Set(images)])
        && compactImages.every(filename => files.has(filename))
        && calls.filter(call => call.action === "storeMediaFile").length === compactUploads + compactImages.length,
      JSON.stringify({ compactAdded, compactNote, compactImages, images }));

    const markerDictionary = request.term.glossaries[0].dictionary;
    const markerPackage = await settings.evaluate(async title => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      return dictionaryState.dictionaries.find(dictionary => dictionary.title === title);
    }, markerDictionary);
    const markerAlias = "Stable Browser Alias";
    const markerTemplate = {
      Front: { value: "{expression} stable-marker", overwriteMode: "overwrite" },
      Back: { value: "{single-glossary-stable-browser-alias-plain-no-dictionary}", overwriteMode: "overwrite" },
      Audio: { value: `{single-glossary-id--${markerPackage.id}-brief}`, overwriteMode: "overwrite" },
    };
    await configure(false, { fieldTemplates: markerTemplate });
    const markerRequest = {
      ...request,
      term: { ...request.term,
        glossaries: request.term.glossaries.filter(glossary => glossary.dictionary === markerDictionary) },
      dictionaryAliases: { [markerDictionary]: markerAlias },
      dictionaryIds: { [markerDictionary]: markerPackage.id },
    };
    markerRequest.configKey = (await operation("hd_anki_status")).configKey;
    const savedMarkerTemplate = await settings.evaluate(async () =>
      (await chrome.storage.local.get("options")).options.anki.fieldTemplates);
    const markerAdded = await operation("hd_anki_submit", markerRequest);
    const markerNote = notes.get(markerAdded.noteId);
    const markerTemplateAfter = await settings.evaluate(async () =>
      (await chrome.storage.local.get("options")).options.anki.fieldTemplates);
    const expectedMarkerTemplates = Object.entries(markerTemplate).every(([field, template]) =>
      savedMarkerTemplate[field]?.value === template.value
      && savedMarkerTemplate[field]?.overwriteMode === template.overwriteMode);
    check("Anki stable single-glossary aliases and package IDs render through the real offscreen path without rewriting mappings",
      /^[0-9a-f]{32}$/u.test(markerPackage.id)
        && markerAdded.state === "added" && markerAdded.warnings.length === 0
        && markerNote.Back.trim() !== "" && markerNote.Audio.trim() !== ""
        && expectedMarkerTemplates
        && JSON.stringify(markerTemplateAfter) === JSON.stringify(savedMarkerTemplate),
      JSON.stringify({ markerDictionary, markerPackageId: markerPackage.id, markerAdded,
        fields: markerNote, savedMarkerTemplate, markerTemplateAfter }));

    await configure(false, { fieldTemplates: {
      Front: { value: "{expression} pitch-graphs", overwriteMode: "overwrite" },
      Back: { value: "{pitch-accent-graphs}", overwriteMode: "overwrite" },
      Audio: { value: "{pitch-accent-graphs-jj}", overwriteMode: "overwrite" },
    } });
    const pitchRequest = await settings.evaluate(async () => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "食べる", maxResults: 4 });
      if (!reply.ok || !reply.results.length) throw new Error(reply.error || "No pitch fixture result");
      return { ...reply.results[0], generation: reply.generation, sentence: "食べる。", matched: "食べる", matchOffset: 0,
        popupSelectionText: "", searchQuery: "食べる", documentTitle: "Pitch graphs", dictionaryAliases: {}, frequencyDictionaries: [] };
    });
    pitchRequest.configKey = (await operation("hd_anki_status")).configKey;
    const pitchUploadsBefore = files.size;
    const pitchAdded = await operation("hd_anki_submit", pitchRequest);
    const pitchNote = notes.get(pitchAdded.noteId);
    const card = await browser.newPage();
    const themes = [];
    try {
      await card.setOfflineMode(true);
      for (const [theme, color, background] of [["light", "rgb(30, 30, 30)", "white"],
        ["dark", "rgb(235, 235, 235)", "#202124"], ["card-css", "rgb(255, 255, 255)", "#202124"]]) {
        // Existing Anki cards can color Yomitan's filled mora dots by radius.
        // The hollow JJ particle must remain distinct under the same rule.
        const style = theme === "card-css" ? '<style>svg > circle[r="5"] { fill: #fff !important; }</style>' : "";
        await card.setContent(`<html lang="ja">${style}<body style="font: 24px sans-serif; padding: 24px; color: ${color}; background: ${background}">`
          + `<h2>食べる — ${theme}</h2><p>${pitchNote.Back}</p><p>${pitchNote.Audio}</p></body></html>`);
        const state = await card.evaluate(() => {
          const graphs = [...document.querySelectorAll("svg")];
          return { count: graphs.length, labels: [...document.querySelectorAll("text")].map(node => node.textContent),
            visible: graphs.every(svg => svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0),
            colors: graphs.map(svg => getComputedStyle(svg.querySelector("circle")).fill),
            tails: graphs.map(svg => svg.querySelector(".pronunciation-graph-tail").dataset.pitch),
            tailFills: graphs.map(svg => getComputedStyle(svg.querySelector(".pronunciation-graph-tail")).fill),
            external: document.querySelectorAll("script, link, img, image, use").length };
        });
        themes.push({ theme, color, ...state });
      }
    } finally { await card.close(); }
    check("Anki pitch dictionary variants export as self-contained SVG graphs in light, dark and styled cards",
      pitchAdded.state === "added" && pitchAdded.warnings.length === 0 && files.size === pitchUploadsBefore
        && themes.every(state => state.count === 6 && state.visible && state.external === 0
          && state.colors.every(fill => fill === state.color || fill === "none")
          && state.tailFills.every(fill => fill === "none")
          && state.labels.join("") === "たべるたべるたべる"
          // [2], [0] and "LHH": as in Yomitan, the graph marker leaves an
          // unspecified particle low while the kana graph repeats "LHH"'s last level.
          && state.tails.join(",") === "low,high,low,low,high,high"),
      JSON.stringify({ pitchAdded, themes }));

    await configure(true);
    request.configKey = (await operation("hd_anki_status")).configKey;
    const choices = await settings.evaluate(async term => {
      const reply = await chrome.runtime.sendMessage({ target: "hachidori-audio", type: "hd_audio_candidates", term });
      if (!reply.ok) throw new Error(reply.error);
      return reply.groups;
    }, { expression: request.term.expression, reading: request.term.reading });
    request.audioSelection = { sourceId: source.id, sourceKey: choices[0].sourceKey, expression: request.term.expression,
      reading: request.term.reading, index: 1, ...chosen };
    const uploadsBefore = calls.filter(call => call.action === "storeMediaFile").length;
    await operation("hd_anki_preflight", request);
    const checked = calls.filter(call => call.action === "canAddNotesWithErrorDetail").at(-1).params.notes[0].fields.Front;
    const noUpload = calls.filter(call => call.action === "storeMediaFile").length === uploadsBefore;
    const withAudio = await operation("hd_anki_submit", request);
    const filename = /\[sound:([^\]]+)\]/u.exec(checked)?.[1];
    const playCount = (await native.send("Runtime.evaluate", { expression: "globalThis.__ankiPlayCount", returnByValue: true })).result.value;
    check("Anki first-field audio is checked without uploads or playback and the exact chosen recording survives submission",
      noUpload && withAudio.state === "added" && withAudio.warnings.length === 0 && notes.get(withAudio.noteId).Front === checked
        && files.get(filename) === wav.toString("base64") && routes.get(chosen.url).requests === 1
        && routes.get(other.url).requests === 0 && playCount === 0
        && calls.filter(call => call.action === "storeMediaFile").length === uploadsBefore + 1,
      JSON.stringify({ noUpload, withAudio, checked, filename, playCount, requests: [...routes].map(([url, route]) => [url, route.requests]) }));

    // Issue #260: {audio} only in a later field. The pronunciation is deferred
    // past the note write, so it must still be the popup's selected recording
    // and must actually reach the note instead of leaving the field empty.
    const overwrite = value => ({ value, overwriteMode: "overwrite" });
    await configure(false, { fieldTemplates: { Front: overwrite("{expression} deferred-audio"), Back: overwrite("{glossary}"), Audio: overwrite("{audio}") } });
    const deferredRequest = { ...request, audioSelection: { ...request.audioSelection } };
    deferredRequest.configKey = (await operation("hd_anki_status")).configKey;
    // The first-field check already stored this recording; drop it so the
    // deferred path has to upload the bytes itself.
    files.delete(filename);
    const deferredUploadsBefore = calls.filter(call => call.action === "storeMediaFile").length;
    const deferredAdded = await operation("hd_anki_submit", deferredRequest);
    const deferredNote = notes.get(deferredAdded.noteId);
    const deferredFilename = /^\[sound:([^\]]+)\]$/u.exec(deferredNote?.Audio ?? "")?.[1];
    const deferredActions = calls.map(call => call.action);
    check("Anki {audio} in a non-first field uploads the selected pronunciation after the note is added",
      deferredAdded.state === "added" && deferredAdded.warnings.length === 0
        && deferredNote.Front === "漢字 deferred-audio"
        && deferredFilename !== undefined && files.get(deferredFilename) === wav.toString("base64")
        && deferredFilename === filename
        && routes.get(other.url).requests === 0
        && calls.filter(call => call.action === "storeMediaFile").length === deferredUploadsBefore + 1
        && deferredActions.lastIndexOf("storeMediaFile") > deferredActions.lastIndexOf("addNote")
        && deferredActions.lastIndexOf("updateNoteFields") > deferredActions.lastIndexOf("storeMediaFile"),
      JSON.stringify({ deferredAdded, deferredNote, deferredFilename, filename, actions: deferredActions.slice(deferredActions.lastIndexOf("addNote") - 3) }));
    await checkAnkiReader(tab, popup, configure, calls, notes, files, control);
  } finally {
    await settings.evaluate(async original => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
        options: { anki: original.anki, audioSources: original.audioSources, audioAutoplay: original.audioAutoplay,
          popupColumns: original.popupColumns ?? 1, experimental: HDReaderOptions.normaliseOptions(original).experimental } });
      if (!reply.ok) throw new Error(reply.error);
    }, original);
    if (screenshotDictionaryInstalled) await settings.evaluate(async title => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_remove", title });
      if (!reply.ok) throw new Error(reply.error);
    }, screenshotDictionary);
    await native.send("Runtime.evaluate", { expression: "Audio.prototype.play = __ankiNativePlay; delete globalThis.__ankiNativePlay; delete globalThis.__ankiPlayCount;" });
    await native.detach();
    await media.detach();
    await api.detach();
  }
}

async function checkAnkiReader(tab, popup, configure, calls, notes, files, control) {
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  async function settled(predicate, read = () => popup.anki()) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await read();
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Anki reader did not settle: ${JSON.stringify(await read())}`);
  }
  try {
    await configure(false, { model: "" });
    await tab.$eval("#verb", element => { element.innerHTML = "<ruby>食<rt>た</rt></ruby>べる。"; });
    const before = calls.length;
    await hoverForPopup(tab, popup, "#verb");
    const quiet = (await popup.anki()).controls.length === 0 && calls.length === before;
    const template = value => ({ value, overwriteMode: "overwrite" });
    const preflightCount = calls.filter(call => call.action === "canAddNotesWithErrorDetail").length;
    control.preflightGate = Promise.withResolvers();
    await configure(false, { fieldTemplates: { Front: template("{expression}"),
      Back: template("{cloze-body}|{cloze-suffix}|{sentence}"), Audio: template("") } });
    const loading = await settled(state => state?.controls[0]?.state === "checking"
      && calls.filter(call => call.action === "canAddNotesWithErrorDetail").length > preflightCount);
    const loadingAccessibility = await popup.ankiAccessibility();
    const mutationCount = calls.filter(call => ["addNote", "guiBrowse"].includes(call.action)).length;
    const loadingFocused = await popup.focusAnki();
    await popup.click(".gsm-hoshidicts-mine-button");
    await new Promise(resolve => setTimeout(resolve, 100));
    const loadingInert = calls.filter(call => ["addNote", "guiBrowse"].includes(call.action)).length === mutationCount;
    if (process.env.HACHIDORI_ANKI_LOADING_SCREENSHOT) {
      const { x, y, width, height } = loading.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_ANKI_LOADING_SCREENSHOT, clip: { x, y, width, height } });
    }
    control.preflightGate.resolve();
    control.preflightGate = null;
    const ready = await settled(state => state?.controls.some(control => !control.hidden && !control.disabled));
    const readyAccessibility = await popup.ankiAccessibility();
    if (process.env.HACHIDORI_ANKI_POPUP_SCREENSHOT) {
      const { x, y, width, height } = ready.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_ANKI_POPUP_SCREENSHOT, clip: { x, y, width, height } });
    }
    const addCount = calls.filter(call => call.action === "addNote").length;
    const addFocused = await popup.focusAnki();
    await tab.keyboard.press("Enter");
    const saved = await settled(state => state?.controls.some(control => control.state === "success"));
    const browseCount = calls.filter(call => call.action === "guiBrowse").length;
    const repairStart = calls.length;
    const savedFocused = await popup.focusAnki();
    await tab.keyboard.press("Enter");
    await settled(state => calls.filter(call => call.action === "guiBrowse").length > browseCount && !state.controls[0].disabled);
    const repairCalls = calls.slice(repairStart);
    const note = [...notes.values()].at(-1);
    const browse = calls.filter(call => call.action === "guiBrowse").at(-1);
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    const duplicate = await settled(state => state?.controls[0]?.state === "view-existing"
      && !state.controls[0].disabled && state.controls[0].action === "view");
    if (process.env.HACHIDORI_ANKI_DUPLICATE_SCREENSHOT) {
      const { x, y, width, height } = duplicate.rect;
      await tab.screenshot({ path: process.env.HACHIDORI_ANKI_DUPLICATE_SCREENSHOT,
        clip: { x, y, width, height } });
    }
    const exactBrowseCount = calls.filter(call => call.action === "guiBrowse").length;
    const viewFocused = await popup.focusAnki();
    await tab.keyboard.press("Enter");
    await settled(() => calls.filter(call => call.action === "guiBrowse").length > exactBrowseCount);
    const exactBrowse = calls.filter(call => call.action === "guiBrowse").at(-1);
    console.log(`     Anki readiness evidence: ${JSON.stringify({
      loading: loading.controls[0], loadingAccessibility, loadingFocused, loadingInert,
      ready: ready.controls[0], readyAccessibility, addFocused,
      saved: saved.controls[0], savedFocused, duplicate: duplicate.controls[0], viewFocused,
    })}`);
    check("Anki readiness uses a disabled accessible Arrow Clockwise before Add and View resolve",
      loading.controls[0].icon === "arrow-clockwise"
        && loading.controls[0].state === "checking"
        && loading.controls[0].disabled
        && loading.controls[0].ariaBusy === "true"
        && loading.controls[0].ariaLabel === "Checking Anki card status"
        && loadingAccessibility?.role === "button"
        && loadingAccessibility.name === "Checking Anki card status"
        && loadingAccessibility.disabled === true
        && loadingAccessibility.busy === true
        && loadingFocused === false && loadingInert
        && ready.controls[0].icon === "add"
        && ready.controls[0].ariaBusy === "false"
        && readyAccessibility?.role === "button"
        && readyAccessibility.name === "Mine to Anki"
        && addFocused
        && saved.controls[0].icon === "book-search"
        && saved.controls[0].successColored
        && duplicate.controls[0].icon === "book-search"
        && duplicate.controls[0].successColored
        && savedFocused && viewFocused,
      JSON.stringify({ loading: loading.controls[0], loadingAccessibility, loadingFocused, loadingInert,
        ready: ready.controls[0], readyAccessibility, addFocused,
        saved: saved.controls[0], savedFocused, duplicate: duplicate.controls[0], viewFocused }));
    check("Anki reader controls stay absent until configured and keep ruby context without its reading through one confirmed Add and View",
      quiet
        && JSON.stringify(ready.order.slice(0, 3)) === JSON.stringify(["add", "audio", "note"])
        && ready.order.slice(3).every(kind => kind === "external")
        && ready.controls[0].icon === "add" && ready.controls[0].action === "add"
        && saved.controls[0].action === "view" && saved.controls[0].icon === "book-search"
        && saved.controls[0].title === "Find added note in Anki"
        && saved.feedback?.hidden === false && saved.feedback.kind === "success"
        && saved.controls[0].output.startsWith("Added note ")
        && saved.feedback.text.includes(saved.controls[0].output)
        && note.Front === "食べる"
        && note.Back === "食べる|。|<b>食べる</b>。"
        && calls.filter(call => call.action === "addNote").length === addCount + 1
        && repairCalls.some(call => call.action === "findNotes"
          && call.params.query.includes('"note:Basic"') && call.params.query.includes('"front:食べる"')
          && !call.params.query.includes("is:review"))
        && repairCalls.some(call => call.action === "notesInfo"
          && JSON.stringify(call.params.notes) === JSON.stringify([...notes.keys()].slice(-1)))
        && repairCalls.some(call => call.action === "findNotes"
          && call.params.query.includes('"front:食べる"')
          && call.params.query.endsWith(" is:review -is:learn prop:ivl>=21"))
        && !repairCalls.some(call => call.action === "findNotes" && call.params.query.startsWith("nid:"))
        && browse.params.query === `nid:${[...notes.keys()].at(-1)}`
        && duplicate.controls[0].icon === "book-search"
        && duplicate.controls[0].title === "View existing notes in Anki"
        && duplicate.controls[0].successColored
        && addFocused && savedFocused && viewFocused
        && exactBrowse.params.query === `nid:${[...notes.keys()].at(-1)}`,
      JSON.stringify({ quiet, saved, note, browse, duplicate, exactBrowse, repairCalls }));
    await checkScreenshotMining({ tab, popup, configure, calls, notes, files, control, settled });
    await checkSentenceMining({ tab, popup, configure, calls, notes, settled });
  } finally {
    control.preflightGate?.resolve();
    control.preflightGate = null;
    await tab.keyboard.press("Escape");
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
  }
}

// A real viewport screenshot for a real Add: the picture Anki receives is of the
// reading page with Hachidori's own overlays hidden, and a failed upload leaves
// the note itself successful.
async function checkScreenshotMining({ tab, popup, configure, calls, notes, files, control, settled }) {
  const template = value => ({ value, overwriteMode: "overwrite" });
  // The first field carries a marker of its own so these notes are new rather
  // than duplicates of the ones the checks above already added.
  await configure(false, { fieldTemplates: { Front: template("{expression} screenshot"), Back: template("{screenshot}"), Audio: template("") } });
  const originalUrl = tab.url();
  const spaUrl = await tab.evaluate(() => {
    history.pushState(null, "", "/watch/1234");
    history.replaceState(null, "", "?trackId=example%3Fvalue#player");
    return location.href;
  });
  // A Netflix-style player beside the text: an MSE stream recorded from a
  // canvas, paused on its first frame. The page reads that frame's colour, so
  // the picture is compared with what the video shows rather than with a guess.
  const player = await tab.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 160, height: 90 });
    const context = canvas.getContext("2d");
    const fill = () => {
      context.fillStyle = "rgb(0, 200, 80)";
      context.fillRect(0, 0, canvas.width, canvas.height);
    };
    // Painted before recording starts, so no frame comes from a blank canvas.
    fill();
    const paint = setInterval(fill, 20);
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const recorded = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 300));
    recorder.stop();
    await recorded;
    clearInterval(paint);
    const video = Object.assign(document.createElement("video"), { id: "mse-player", muted: true });
    video.style.cssText = "position: fixed; top: 16px; right: 16px; width: 240px; height: 135px";
    document.body.append(video);
    const presented = new Promise(resolve => video.requestVideoFrameCallback(resolve));
    const source = new MediaSource();
    video.src = URL.createObjectURL(source);
    await new Promise(resolve => source.addEventListener("sourceopen", resolve, { once: true }));
    const buffer = source.addSourceBuffer('video/webm; codecs="vp8"');
    buffer.appendBuffer(await new Blob(chunks).arrayBuffer());
    await new Promise((resolve, reject) => { buffer.onupdateend = resolve; buffer.onerror = reject; });
    source.endOfStream();
    await presented;
    const frame = new OffscreenCanvas(video.videoWidth, video.videoHeight).getContext("2d");
    frame.drawImage(video, 0, 0);
    const { x, y, width, height } = video.getBoundingClientRect();
    return { rect: { x, y, width, height },
      colour: [...frame.getImageData(video.videoWidth >> 1, video.videoHeight >> 1, 1, 1).data.slice(0, 3)] };
  });
  // A fresh lookup, because the previous Add left its own control terminal.
  await tab.keyboard.press("Escape");
  await hoverForPopup(tab, popup, "#kanjiword");
  const masonry = await settled(value => value.grids.some(grid => grid.masonry
    && grid.cards.length >= 2 && grid.cards.every(card => card.visibility === "visible")), () => popup.dictionaryTabs());
  // Every change to the host's inline style, so the hide and the restore around
  // the capture are observed rather than inferred.
  await tab.evaluate(() => {
    window.__hostOpacity = [];
    const host = document.querySelector("hachidori-host");
    // Restore an existing inline value and its priority, rather than deleting it.
    host.style.setProperty("opacity", "0.9", "important");
    window.__hostObserver?.disconnect();
    window.__hostObserver = new MutationObserver(() => window.__hostOpacity.push({
      value: getComputedStyle(host).opacity, priority: host.style.getPropertyPriority("opacity"),
    }));
    window.__hostObserver.observe(host, { attributes: true, attributeFilter: ["style"] });
  });
  const uploadsBefore = calls.filter(call => call.action === "storeMediaFile").length;
  const ready = await settled(state => state?.controls.some(item => !item.hidden && !item.disabled));
  const popupRect = await popup.rect();
  const addRect = ready.controls[0].rect;
  const startedMining = Date.now();
  await tab.mouse.click(addRect.x + addRect.width / 2, addRect.y + addRect.height / 2, { clickCount: 2 });
  const saved = await settled(state => state?.controls.some(item => item.state === "success"));
  await tab.evaluate(url => {
    history.replaceState(null, "", url);
    const video = document.getElementById("mse-player");
    URL.revokeObjectURL(video.src);
    video.remove();
  }, originalUrl);
  console.log(`     screenshot mining answered in ${Date.now() - startedMining} ms`);
  const opacity = await tab.evaluate(() => window.__hostOpacity ?? []);
  const upload = calls.filter(call => call.action === "storeMediaFile").at(-1);
  const note = [...notes.values()].at(-1);
  const filename = /<img src="([^"]+)">/u.exec(note.Back ?? "")?.[1] ?? null;
  // The picture itself: decoded in the page, so its size and the pixels where
  // the popup stood are read from what Anki actually received.
  const picture = filename === null || !files.has(filename) ? null : await tab.evaluate(async ({ data, rect, player }) => {
    const response = await fetch(`data:image/jpeg;base64,${data}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / window.innerWidth;
    const pixelAt = (x, y) => context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
    const luminance = (x, y) => {
      const pixel = pixelAt(x, y);
      return (pixel[0] + pixel[1] + pixel[2]) / 3;
    };
    const inPlayer = (x, y) => x >= player.x && x < player.x + player.width
      && y >= player.y && y < player.y + player.height;
    // Where the popup stood must look like the page it covered, and the picture
    // as a whole must still contain the page's own dark text.
    let popupSum = 0, popupSamples = 0, darkest = 255;
    for (let y = rect.y + 4; y < rect.y + rect.height - 4; y += 8) {
      for (let x = rect.x + 4; x < rect.x + rect.width - 4; x += 8) {
        popupSum += luminance(x, y);
        popupSamples += 1;
      }
    }
    for (let y = 2; y < window.innerHeight - 2; y += 6) {
      for (let x = 2; x < window.innerWidth - 2; x += 6) {
        if (!inPlayer(x, y)) darkest = Math.min(darkest, luminance(x, y));
      }
    }
    // The video's own frame, inside its edges.
    const playerSum = [0, 0, 0];
    let playerSamples = 0;
    for (let y = player.y + 8; y < player.y + player.height - 8; y += 8) {
      for (let x = player.x + 8; x < player.x + player.width - 8; x += 8) {
        const pixel = pixelAt(x, y);
        for (let channel = 0; channel < 3; channel += 1) playerSum[channel] += pixel[channel];
        playerSamples += 1;
      }
    }
    // The hovered word: still the page's own dark, neutral text rather than the
    // reader's coloured source highlight.
    const word = document.querySelector("#kanjiword").getBoundingClientRect();
    let wordDarkest = 255, wordColour = 0;
    for (let y = word.y + 2; y < word.y + word.height - 2; y += 2) {
      for (let x = word.x + 2; x < word.x + word.width - 2; x += 2) {
        const pixel = pixelAt(x, y);
        const spread = Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]);
        wordColour = Math.max(wordColour, spread);
        wordDarkest = Math.min(wordDarkest, (pixel[0] + pixel[1] + pixel[2]) / 3);
      }
    }
    return {
      width: bitmap.width, height: bitmap.height,
      viewport: [Math.round(window.innerWidth * devicePixelRatio), Math.round(window.innerHeight * devicePixelRatio)],
      popupMean: Math.round(popupSum / Math.max(1, popupSamples)), popupSamples, darkest,
      wordDarkest: Math.round(wordDarkest), wordColour,
      playerSamples, playerColour: playerSum.map(sum => Math.round(sum / Math.max(1, playerSamples))),
    };
  }, { data: files.get(filename), rect: popupRect, player: player.rect });
  check("Anki screenshot mining works after history.pushState and history.replaceState change the reading page URL",
    spaUrl !== originalUrl && spaUrl.includes("/watch/1234?trackId=example%3Fvalue#player")
      && saved.controls[0].state === "success" && filename !== null && files.has(filename)
      && !saved.controls[0].output.includes("Screenshot:"),
    JSON.stringify({ originalUrl, spaUrl, saved: saved.controls[0], filename }));
  // A capture that left the video region black, or showed the page behind it,
  // is not the picture the reader saw.
  check("a mined screenshot of a page with a paused MSE video contains that video's frame instead of a black region",
    player.colour[1] > 120 && player.colour[1] - player.colour[0] > 80
      && picture !== null && picture.playerSamples > 100
      && picture.playerColour.every((value, channel) => Math.abs(value - player.colour[channel]) <= 32),
    JSON.stringify({ player, picture: picture && { playerColour: picture.playerColour, playerSamples: picture.playerSamples },
      popupRect }));
  check(
    "a mined screenshot is the reading page without Hachidori's overlays and its upload cannot fail the note",
    saved.controls[0].action === "view"
      && calls.filter(call => call.action === "storeMediaFile").length === uploadsBefore + 1
      && /^hachidori-screenshot-[0-9a-f-]{36}\.jpg$/u.test(upload?.params.filename ?? "")
      && filename === upload.params.filename && files.get(filename) === upload.params.data
      // Hidden for the capture, restored afterwards.
      && masonry.grids.some(grid => grid.masonry && grid.cards.length >= 2)
      && JSON.stringify(opacity) === JSON.stringify([{ value: "0", priority: "important" }, { value: "0.9", priority: "important" }])
      // The whole viewport, the page's own light background everywhere the popup
      // stood, and the page's dark text still in the picture.
      && picture !== null && JSON.stringify([picture.width, picture.height]) === JSON.stringify(picture.viewport)
      && picture.popupSamples > 100 && picture.popupMean > 240 && picture.darkest < 120
      && picture.wordDarkest < 120 && picture.wordColour < 40,
    JSON.stringify({ saved: saved.controls[0], upload: upload && { filename: upload.params.filename, bytes: upload.params.data?.length },
      filename, opacity, picture, popupRect }),
  );
  control.failScreenshotUpload = true;
  try {
      await configure(false, { fieldTemplates: { Front: template("{expression} screenshot refused"), Back: template("{screenshot}"), Audio: template("") } });
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#kanjiword");
    const retry = await settled(state => state?.controls.some(item => !item.hidden && !item.disabled));
    const retryRect = retry.controls[0].rect;
    const addsBefore = calls.filter(call => call.action === "addNote").length;
    await tab.mouse.click(retryRect.x + retryRect.width / 2, retryRect.y + retryRect.height / 2, { clickCount: 2 });
    const failed = await settled(state => state?.controls.some(item => item.state === "success"));
    const failedNote = [...notes.values()].at(-1);
    check(
      "a screenshot upload that Anki refuses is a warning on a note that is still added",
      failed.controls[0].state === "success"
        && calls.filter(call => call.action === "addNote").length === addsBefore + 1
        && failedNote.Back === ""
        && /Screenshot: /u.test(failed.controls[0].output ?? ""),
      JSON.stringify({ failed: failed.controls[0], note: failedNote }),
    );
  } finally {
    control.failScreenshotUpload = false;
    await tab.evaluate(() => {
      window.__hostObserver?.disconnect();
      document.querySelector("hachidori-host").style.removeProperty("opacity");
    });
  }
}

// The Anki sentence is the one hooked line (issue #292). texthooker-ui renders
// every line as a <p> followed by a "\n" text node inside a flex column, and a
// milestone <div> between two lines has no such node before the next <p>: the
// line after it used to swallow the milestone's text, and every line reached
// its neighbours on pages with no newline nodes at all.
async function checkSentenceMining({ tab, popup, configure, calls, notes, settled }) {
  const template = value => ({ value, overwriteMode: "overwrite" });
  const line = "三行目で本を読む。";
  const original = tab.url();
  try {
    await configure(false, { fieldTemplates: { Front: template("{expression} sentence"), Back: template("{sentence}<br>{url-plain}"), Audio: template("") } });
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    // {url-plain} is the page's whole address, query and fragment included (#435).
    const address = await tab.evaluate(() => {
      history.replaceState(null, "", "?chapter=56&view=1#scene");
      return location.href;
    });
    const point = await tab.evaluate(line => {
      const main = document.createElement("main");
      main.id = "hooked-lines";
      main.style.cssText = "position:fixed;left:600px;top:40px;width:640px;display:flex;flex-direction:column;font:26px/1.6 serif;background:#fff";
      const paragraph = text => {
        const p = document.createElement("p");
        p.style.cssText = "margin:8px 0;padding:16px 8px;border:2px solid transparent";
        p.textContent = text;
        return p;
      };
      const milestone = document.createElement("div");
      milestone.style.cssText = "display:flex;justify-content:center;margin:8px 0;padding:8px;font-size:12px;border-top:2px dashed #888;border-bottom:2px dashed #888";
      milestone.innerHTML = '<div style="display:flex;align-items:center"><span>Milestone 1000 (1024)</span></div>';
      const hooked = paragraph(line);
      hooked.id = "hooked-line";
      main.append("\n", paragraph("一行目のテキストだ。"), "\n", paragraph("二行目で漢字を書いた。"), "\n", milestone, hooked, "\n");
      document.body.append(main);
      const node = hooked.firstChild;
      const range = document.createRange();
      range.setStart(node, line.indexOf("読"));
      range.setEnd(node, line.indexOf("読") + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width * 0.3, y: rect.top + rect.height / 2 };
    }, line);
    const shown = await hoverForPopup(tab, popup, "#hooked-line", { point, accept: state => state.plain.includes("読む") });
    const highlight = await tab.evaluate(name => {
      const ranges = [...(CSS.highlights.get(name) ?? [])];
      return { text: ranges.map(range => range.toString()).join(""),
        inLine: ranges.every(range => range.startContainer === document.getElementById("hooked-line").firstChild) };
    }, HIGHLIGHT_NAME);
    const ready = await settled(state => state?.controls.some(control => !control.hidden && !control.disabled));
    const addsBefore = calls.filter(call => call.action === "addNote").length;
    const focused = await popup.focusAnki();
    await tab.keyboard.press("Enter");
    const saved = await settled(state => state?.controls.some(control => control.state === "success"));
    const note = [...notes.values()].at(-1);
    check("a note mined from a texthooker line carries that one line as its sentence and its full page address, and highlights only the word",
      shown !== null && highlight.text === "読む" && highlight.inLine
        && ready.controls[0].action === "add" && focused
        && saved.controls[0].state === "success"
        && calls.filter(call => call.action === "addNote").length === addsBefore + 1
        && note.Front === "読む sentence"
        && address.endsWith("/?chapter=56&view=1#scene")
        && note.Back === `三行目で本を<b>読む</b>。<br>${address.replaceAll("&", "&amp;")}`,
      JSON.stringify({ shown: shown?.plain, highlight, ready: ready.controls[0], focused, saved: saved.controls[0], address, note }));

    // Issue #430: a selection's note takes the sentence a hover would, so text
    // hidden inside the selection stays out of the sentence and its cloze.
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await tab.evaluate(() => {
      const selected = document.createElement("p");
      selected.innerHTML = '「どうも、あり<span style="display:none">隠し</span>がとう。」と言った。';
      document.getElementById("hooked-lines").append(selected);
      getSelection().setBaseAndExtent(selected.firstChild, 5, selected.lastChild, 3);
    });
    const selection = await popup.waitForVisible(10_000, state => state.plain.includes("ありがとう"));
    await settled(state => state?.controls.some(control => !control.hidden && !control.disabled));
    const selectionFocused = await popup.focusAnki();
    await tab.keyboard.press("Enter");
    await settled(state => state?.controls.some(control => control.state === "success"));
    const selectionNote = [...notes.values()].at(-1);
    check("a note mined from a selection takes the hover's sentence without the hidden text inside it",
      selection !== null && selectionFocused && selectionNote.Front === "ありがとう sentence"
        && selectionNote.Back === `どうも、<b>ありがとう</b>。<br>${address.replaceAll("&", "&amp;")}`,
      JSON.stringify({ shown: selection?.plain, selectionFocused, selectionNote }));
  } finally {
    await tab.keyboard.press("Escape");
    await tab.evaluate(original => {
      document.getElementById("hooked-lines")?.remove();
      history.replaceState(null, "", original);
    }, original);
  }
}

describe("Anki mining", () => {
  step("Anki submission", async () => {
    await checkAnkiSubmission(page, browser, tab, popup);
    await hover("#verb");
  });
});
