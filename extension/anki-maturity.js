// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiDigest } from "./anki-digest.js";
import { escapeAnkiHtml, resolveAnkiTemplates } from "./anki-templates.js";

// Anki parses these names as operators before considering a field search.
// Treating an identically named field as an operator could match another word.
// https://github.com/ankitects/anki/blob/main/rslib/src/search/parser.rs
const SEARCH_OPERATORS = new Set(["deck", "note", "tag", "card", "flag", "resched", "prop", "added", "edited",
  "introduced", "rated", "is", "did", "mid", "nid", "cid", "re", "nc", "sc", "w", "dupe", "has-cd", "preset"]);
const escapeQuery = value => value.replace(/[\\"*_:]/gu, String.raw`\$&`);
const nameKey = value => value.normalize("NFC").toLowerCase();
const foldAscii = value => value.replace(/[A-Z]/gu, character => character.toLowerCase());

function expressionFields(config) {
  const names = config.fieldTemplates === null ? Object.values(config.fields).filter(Boolean) : Object.keys(config.fieldTemplates);
  const { templates } = resolveAnkiTemplates(config, names);
  return Object.entries(templates).filter(([field, template]) => /^\{expression\}$/iu.test(template.value)
    && !SEARCH_OPERATORS.has(field.toLowerCase())).map(([field]) => field);
}

export async function ankiMaturitySource(config) {
  if (!config.model) return null;
  const url = globalThis.HDReaderOptions.normaliseAnkiConnectUrl(
    config.url === undefined ? globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki.url : config.url
  );
  if (!url) return null;
  const fields = [...new Set(expressionFields(config).map(nameKey))].sort((left, right) => Number(left > right) - Number(left < right));
  if (!fields.length) return null;
  const source = { url, model: config.model, fields, apiKey: config.apiKey };
  return { key: await ankiDigest(new TextEncoder().encode(JSON.stringify(source))), ...source };
}

export function ankiMaturityWordKey(expression) {
  if (typeof expression !== "string" || !expression) return null;
  // Ordinary Anki field search uses SQLite LIKE: fold ASCII only and retain
  // the exact HTML emitted by {expression}. Anki's default text normalization
  // applies NFC to query text, not to existing stored field values.
  // https://github.com/ankitects/anki/blob/main/rslib/src/search/sqlwriter.rs
  return foldAscii(escapeAnkiHtml(expression).normalize("NFC"));
}

export async function fetchAnkiMatureWords(gateway, source) {
  // Mature means a review interval >=21 days. Anki's is:review also includes
  // relearning cards, so exclude is:learn. Deck and mining duplicate policy
  // do not limit knowledge in the configured note type's collection.
  // https://docs.ankiweb.net/getting-started.html#card-states
  // https://docs.ankiweb.net/searching.html#card-state
  const query = `"note:${escapeQuery(source.model)}" is:review -is:learn prop:ivl>=21`;
  const notes = await gateway.invoke("notesInfo", { query }, source.apiKey, 25_000, source.url);
  if (!Array.isArray(notes)) throw new Error("AnkiConnect returned invalid mature note details.");
  const words = new Set();
  for (const note of notes) {
    if (!Number.isSafeInteger(note?.noteId) || note.noteId <= 0 || typeof note.modelName !== "string"
      || nameKey(note.modelName) !== nameKey(source.model)
      || !note.fields || typeof note.fields !== "object" || Array.isArray(note.fields)
      || Object.values(note.fields).some(field => typeof field?.value !== "string")) {
      throw new Error("AnkiConnect returned invalid mature note details.");
    }
    const names = new Map(Object.keys(note.fields).map(field => [nameKey(field), field]));
    if (!names.size) throw new Error("AnkiConnect returned invalid mature note details.");
    for (const field of source.fields) {
      const value = note.fields[names.get(field)]?.value;
      // Do not normalize stored text: legacy NFD fields also fail an ordinary
      // NFC-normalized Anki query and must not become new mature matches.
      if (value) words.add(foldAscii(value));
    }
  }
  return [...words];
}
