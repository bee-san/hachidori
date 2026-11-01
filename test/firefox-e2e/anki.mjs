/*
 * Pronunciation audio, and Anki: Settings discovery, mining a note with a page
 * screenshot to a fake AnkiConnect, View in Anki and word highlighting.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./settings.mjs";
import { describe } from "node:test";
import { AnkiConnectError, answerAnkiConnect } from "../anki-connect-fake.mjs";
import { check, step } from "./harness.mjs";
import { tab } from "./reader.mjs";
import {
  anki, ANKI_PATH, clickInPopup, dismissPopup, evaluateJson, hoverForPopup, inPopup, makeAudioWav, openPage, page,
  readStorage, reloadPage, servedAudio, serverUrl, showSettingsSection, sleep, waitFor, writeOptions,
  activate,
} from "./session.mjs";

const notes = new Map();
const files = new Map();
const calls = [];

// The values a search names: Anki's dupe: identity, or every "front:…" term.
function queryExpressions(query) {
  const duplicate = /^"dupe:1,(.*)"$/u.exec(query);
  const values = duplicate ? [duplicate[1]] : [...query.matchAll(/"front:((?:\\.|[^"])*)"/giu)].map(match => match[1]);
  return values.map(value => value.replace(/\\(.)/gu, "$1"));
}

anki.handle = request => answerAnkiConnect(request, async (action, params) => {
  calls.push({ action, params });
  if (action === "deckNames") return ["Default"];
  if (action === "modelNames") return ["Basic"];
  if (action === "modelNamesAndIds") return { Basic: 1 };
  if (action === "modelFieldNames") return ["Front", "Back", "Picture"];
  if (action === "canAddNotesWithErrorDetail") {
    return params.notes.map(note => {
      const duplicate = [...notes.values()].some(fields => fields.Front === note.fields.Front);
      return { canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null };
    });
  }
  if (action === "addNote") {
    const noteId = notes.size + 1;
    notes.set(noteId, params.note.fields);
    return noteId;
  }
  if (action === "findNotes") {
    // Nothing is scheduled, so no note is mature.
    if (params.query.endsWith(" is:review -is:learn prop:ivl>=21")) return [];
    const expressions = queryExpressions(params.query);
    return [...notes].filter(([, fields]) => expressions.length === 0 || expressions.includes(fields.Front)).map(([noteId]) => noteId);
  }
  if (action === "notesInfo") {
    return params.notes.filter(noteId => notes.has(noteId)).map(noteId => ({ noteId, modelName: "Basic", cards: [noteId],
      fields: Object.fromEntries(Object.entries(notes.get(noteId)).map(([field, value], order) => [field, { value, order }])) }));
  }
  if (action === "getMediaFilesNames") return files.has(params.pattern) ? [params.pattern] : [];
  if (action === "storeMediaFile") {
    files.set(params.filename, params.data);
    return params.filename;
  }
  if (action === "deleteMediaFile") {
    files.delete(params.filename);
    return null;
  }
  if (action === "guiBrowse") return [...notes.keys()];
  throw new AnkiConnectError(`unsupported action ${action}`);
});

const mineButton = target => inPopup(target, `root => {
  const button = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"] .gsm-hoshidicts-mine-button');
  return button && button.getClientRects().length > 0 ? { state: button.dataset.state ?? "", action: button.dataset.action ?? "" } : null;
}`);

describe("audio and Anki", () => {
  step("pronunciation audio", async () => {
    servedAudio.set("/audio/taberu.wav", { requests: 0, body: makeAudioWav() });
    await writeOptions(page, { audioSources: [{ id: "firefox-audio", type: "custom", url: `${serverUrl}/audio/taberu.wav`,
      enabled: true, voice: "" }], audioAutoplay: false });
    await hoverForPopup(tab, "#verb");
    await clickInPopup(tab, ".gsm-hoshidicts-audio-button");
    const states = [];
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const state = await inPopup(tab, `root => root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"] .gsm-hoshidicts-audio-button')
        ?.dataset.state ?? "idle"`);
      if (states.at(-1) !== state) states.push(state);
      if (states.includes("playing") && state === "idle") break;
      await sleep(25);
    }
    check("pronunciation audio plays from a URL source",
      servedAudio.get("/audio/taberu.wav").requests > 0 && states.includes("playing") && states.at(-1) === "idle",
      JSON.stringify({ requests: servedAudio.get("/audio/taberu.wav").requests, states }));
    await dismissPopup(tab);
  });

  step("Anki settings and mining", async () => {
    await activate(page);
    await showSettingsSection(page, "anki");
    await page.evaluate(url => {
      const input = document.getElementById("opt-anki-url");
      input.value = url;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, `${serverUrl}${ANKI_PATH}`);
    const discovered = await waitFor(() => evaluateJson(page, () => {
      const options = select => [...document.getElementById(select).options].map(option => option.value);
      const decks = options("opt-anki-deck");
      const models = options("opt-anki-model");
      return JSON.stringify(decks.includes("Default") && models.includes("Basic") ? { decks, models } : null);
    }), { timeout: 20_000 });
    check("Anki settings list AnkiConnect's decks and note types", discovered !== null,
      JSON.stringify({ discovered, calls: calls.map(call => call.action) }));

    const defaults = await evaluateJson(page, () => JSON.stringify(HDReaderOptions.normaliseOptions({}).anki));
    const template = value => ({ value, overwriteMode: "overwrite" });
    await writeOptions(page, { anki: { ...defaults, url: `${serverUrl}${ANKI_PATH}`, deck: "Default", model: "Basic",
      captureScreenshot: true,
      fieldTemplates: { Front: template("{expression}"), Back: template("{glossary}"), Picture: template("{screenshot}") } } });
    await activate(tab);
    await hoverForPopup(tab, "#verb");
    const ready = await waitFor(async () => (await mineButton(tab))?.state === "ready" || false, { timeout: 20_000 });
    await clickInPopup(tab, ".gsm-hoshidicts-mine-button");
    const added = await waitFor(async () => (notes.size > 0 ? [...notes.values()][0] : false), { timeout: 30_000 });
    const picture = /<img src="(hachidori-screenshot-[0-9a-f-]+\.jpg)">/u.exec(added?.Picture ?? "")?.[1];
    check("Add to Anki creates a note with the configured fields and a page screenshot",
      ready === true && added?.Front === "食べる" && added.Back.includes("to eat") && picture !== undefined
        && files.get(picture)?.startsWith("/9j/") === true,
      JSON.stringify({ ready, added, picture, stored: [...files.keys()] }));
    const view = await waitFor(async () => {
      const button = await mineButton(tab);
      return button?.action === "view" ? button : false;
    }, { timeout: 15_000 });
    const browsed = calls.filter(call => call.action === "guiBrowse").length;
    await clickInPopup(tab, ".gsm-hoshidicts-mine-button");
    const opened = await waitFor(async () => calls.filter(call => call.action === "guiBrowse").length > browsed || false,
      { timeout: 10_000 });
    check("the added note turns the button into View in Anki", view !== null && opened === true,
      JSON.stringify({ view, guiBrowse: calls.filter(call => call.action === "guiBrowse") }));
    await dismissPopup(tab);
  });

  step("word highlighting", async () => {
    await writeOptions(page, { wordHighlightEnabled: true });
    const reader = await openPage(`${serverUrl}/?highlights`);
    const marks = () => evaluateJson(reader, () => JSON.stringify(Object.fromEntries(["unknown", "learning", "known"]
      .map(status => [status, [...(CSS.highlights.get(`hd-word-${status}`) ?? [])]
        .map(range => range.startContainer.data.slice(range.startOffset, range.endOffset))]))));
    const marked = await waitFor(async () => {
      const current = await marks();
      return current.learning.some(text => text.startsWith("食べ")) && current.unknown.includes("漢字") ? current : false;
    }, { timeout: 30_000 });
    check("word highlighting marks words by their Anki status", marked !== null,
      JSON.stringify({ marked: marked ?? await marks(), options: (await readStorage(page, ["options"])).options?.wordHighlightEnabled }));
    await writeOptions(page, { wordHighlightEnabled: false });
    await reader.close();
    // Settings kept drafts of the controls this file edited; a fresh page has none.
    await reloadPage(page);
  });
});
