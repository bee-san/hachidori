// SPDX-License-Identifier: GPL-3.0-or-later
// Production gateway, duplicate index and mining worker with an in-memory
// AnkiConnect. Optional per-request delay models transport, not Anki's CPU.
import "../extension/reader-options.js";
import { createAnkiGateway } from "../extension/anki.js";
import { createAnkiWorkerService } from "../extension/anki-worker.js";
import { createAnkiDuplicateIndex } from "../extension/anki-index-cache.js";
import { lookupAnkiIndex, lookupAnkiIndexMany } from "../extension/anki-index.js";
import { buildAnkiFields } from "../extension/anki-values.js";
import { answerAnkiConnect, AnkiConnectError } from "./anki-connect-fake.mjs";

export function ankiRequestFixture({ audio = false, screenshot = false, delay = 0 } = {}) {
  const template = value => ({ value, overwriteMode: "overwrite" });
  const options = globalThis.HDReaderOptions.normaliseOptions({ anki: {
    model: "Basic", deck: "Default", captureScreenshot: screenshot,
    fieldTemplates: { Front: template("{expression}"), Back: template("cat"),
      Audio: template(audio ? "{audio}" : ""), Picture: template("{screenshot}"),
      SentenceFurigana: template("{sentence-furigana}") },
  } });
  const calls = [], renders = [], engineCalls = [], notes = new Map(), files = new Map();
  const audioFilename = `hachidori_${"c".repeat(64)}.wav`;
  let state, mediaError, nextNoteId = 1;
  const handle = async (action, params) => {
    switch (action) {
      case "deckNames": return ["Default"];
      case "modelNames": return ["Basic"];
      case "modelNamesAndIds": return { Basic: 1 };
      case "modelFieldNames": return Object.keys(options.anki.fieldTemplates);
      case "findNotes": {
        if (params.query.includes("is:review")) return [];
        if (params.query.startsWith("nid:")) return params.query.slice(4).split(",").map(Number).filter(id => notes.has(id));
        return [...notes].filter(([, fields]) => params.query.includes(`:${fields.Front}\"`)
          || params.query === `"dupe:1,${fields.Front.replace(/[\\"]/gu, String.raw`\$&`)}"`).map(([id]) => id);
      }
      case "canAddNotesWithErrorDetail": return params.notes.map(note => {
        const duplicate = !note.options.allowDuplicate && [...notes.values()].some(fields => fields.Front === note.fields.Front);
        return { canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null };
      });
      case "addNote": {
        const note = params.note;
        if (!note.options.allowDuplicate && [...notes.values()].some(fields => fields.Front === note.fields.Front)) {
          throw new AnkiConnectError("cannot create note because it is a duplicate");
        }
        const id = nextNoteId++;
        notes.set(id, { ...note.fields });
        return id;
      }
      // AnkiConnect notesInfo preserves positions with {} for deleted IDs.
      case "notesInfo": return params.notes.map(noteId => notes.has(noteId) ? ({ noteId, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(notes.get(noteId)).map(([key, value]) => [key, { value }])) }) : {});
      case "getMediaFilesNames": return files.has(params.pattern) ? [params.pattern] : [];
      case "storeMediaFile":
        if (mediaError) throw mediaError;
        files.set(params.filename, params.data); return params.filename;
      case "deleteMediaFile": files.delete(params.filename); return null;
      case "updateNoteFields": Object.assign(notes.get(params.note.id), params.note.fields); return null;
      case "guiBrowse": return [];
      default: throw new Error(`Unexpected Anki action: ${action}`);
    }
  };
  const gateway = createAnkiGateway({ fetch: async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push(structuredClone(request));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return { ok: true, json: () => answerAnkiConnect(request, handle) };
  } });
  const duplicateIndex = createAnkiDuplicateIndex({
    fetchRows: async () => [],
    lookupLive: (source, word, invoke) => lookupAnkiIndex(invoke, source, word),
    lookupLiveMany: (source, words, invoke) => lookupAnkiIndexMany(invoke, source, words),
    readOptions: async () => options, readState: async () => structuredClone(state),
    async updateState(update) {
      const next = await update({ options, state: structuredClone(state) });
      if (next !== undefined) state = structuredClone(next);
      return structuredClone(state);
    },
    alarms: { async get() {}, async clear() {}, async create() {} },
    reportError(error) { throw error; },
  });
  const service = createAnkiWorkerService({ gateway, duplicateIndex,
    readOptions: async () => options, readDictionaries: async () => [],
    engine: async message => {
      engineCalls.push(message.type);
      return message.type === "hd_segment" ? { segments: [{ spans: [] }, { spans: [] }] }
        : { generation: 3, ready: true, loading: false };
    },
    offscreen: async message => {
      if (message.type === "hd_anki_audio") return { filename: audioFilename, data: "YQ==" };
      renders.push(Object.keys(message.templates));
      return { fields: await buildAnkiFields(message.request, message.templates, { audio: message.audio }), media: [] };
    },
  });
  return { service, gateway, duplicateIndex, calls, renders, engineCalls, notes, files, options, audioFilename,
    failMedia(error) { mediaError = error; },
    capture: () => service.screenshot(async () => "data:image/jpeg;base64,YQ=="),
    async request(expression = "猫") {
      return { term: { expression, reading: "ねこ", glossaries: [], frequencies: [], pitches: [] },
        generation: 3, sentence: expression, matched: expression, matchOffset: 0,
        configKey: (await service.status()).configKey };
    },
  };
}
