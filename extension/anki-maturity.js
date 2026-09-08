// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeAnkiHtml, resolveAnkiTemplates } from "./anki-templates.js";

// Anki parses these names as operators before considering a field search.
// Treating an identically named field as an operator could match another word.
// https://github.com/ankitects/anki/blob/main/rslib/src/search/parser.rs
const SEARCH_OPERATORS = new Set(["deck", "note", "tag", "card", "flag", "resched", "prop", "added", "edited",
  "introduced", "rated", "is", "did", "mid", "nid", "cid", "re", "nc", "sc", "w", "dupe", "has-cd", "preset"]);
const escapeQuery = value => value.replace(/[\\"*_:]/gu, String.raw`\$&`);

function expressionFields(config) {
  const names = config.fieldTemplates === null ? Object.values(config.fields).filter(Boolean) : Object.keys(config.fieldTemplates);
  const { templates } = resolveAnkiTemplates(config, names);
  return Object.entries(templates).filter(([field, template]) => /^\{expression\}$/iu.test(template.value)
    && !SEARCH_OPERATORS.has(field.toLowerCase())).map(([field]) => field);
}

export async function findAnkiMatureWord(gateway, config, expression) {
  if (!config.model || typeof expression !== "string" || !expression) return false;
  const fields = expressionFields(config);
  if (!fields.length) return false;
  // Exact field searches match stored HTML, just as the plain {expression}
  // marker exports it. They must never become a substring or regex search.
  const value = escapeQuery(escapeAnkiHtml(expression));
  const terms = fields.map(field => `"${escapeQuery(field)}:${value}"`);
  const expressionQuery = terms.length === 1 ? terms[0] : `(${terms.join(" or ")})`;
  // Mature means a review interval >=21 days. Anki's is:review also includes
  // relearning cards, so exclude is:learn. Deck and mining duplicate policy
  // do not limit knowledge in the configured note type's collection.
  // https://docs.ankiweb.net/getting-started.html#card-states
  // https://docs.ankiweb.net/searching.html#card-state
  const query = `"note:${escapeQuery(config.model)}" ${expressionQuery} is:review -is:learn prop:ivl>=21`;
  const ids = await gateway.invoke("findCards", { query }, config.apiKey);
  return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isSafeInteger(id) && id > 0);
}
