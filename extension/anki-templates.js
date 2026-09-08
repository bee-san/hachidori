// SPDX-License-Identifier: GPL-3.0-or-later
import "./reader-options.js";

const { ANKI_FIELDS } = globalThis.HDReaderOptions;
const CORE_MARKERS = ["expression", "reading", "furigana", "furigana-plain", "dictionary", "dictionary-alias",
  "definition", "glossary", "glossary-brief", "glossary-no-dictionary", "glossary-plain", "glossary-plain-no-dictionary",
  "glossary-first", "glossary-first-brief", "glossary-first-no-dictionary", "main-definition", "jpmn-primary-definition",
  "conjugation", "part-of-speech", "phonetic-transcriptions", "tags", "popup-selection-text", "search-query", "document-title",
  "sentence", "sentence-furigana", "sentence-furigana-plain", "cloze-prefix", "cloze-body", "cloze-suffix",
  "frequency", "frequencies", "frequency-harmonic-rank", "frequency-harmonic-occurrence", "frequency-average-rank",
  "frequency-average-occurrence", "pitch", "pitch-position", "pitch-accent-positions", "pitch-categories",
  "pitch-accent-categories", "audio", "capture-animation", "capture-audio", "screenshot"];
export const ANKI_TEMPLATE_MARKERS = CORE_MARKERS;
const MARKER_ALIASES = new Map([["pitch-accent", "pitch"], ["pitch-accents", "pitch"],
  ["pitch-accent-graphs", "pitch"], ["pitch-accent-graphs-jj", "pitch"]]);
const MARKERS = new Set([...CORE_MARKERS, ...MARKER_ALIASES.keys()]);
const DYNAMIC_PREFIXES = ["single-glossary-", "single-frequency-"];
const MARKER_PATTERN = /\{([^{}]+)\}/gu;
const BREAK_PATTERN = /<br\s*\/?>/giu;
const genericAliases = {
  expression: ["Expression", "Word", "Term", "Front"], reading: ["Reading", "Word Reading", "WordReading", "Kana"],
  definition: ["Definition", "Definitions", "Meaning", "Glossary"], sentence: ["Sentence", "Context", "Example Sentence"],
  frequency: ["Frequency", "Frequencies"], pitch: ["Pitch Accent", "PitchAccent", "Pitch", "Accent"],
  audio: ["WordAudio", "PronunciationAudio", "Pronunciation", "Audio"],
  captureAnimation: ["Capture Animation", "CaptureAnimation", "Sentence Animation", "SentenceAnimation"],
  captureAudio: ["Capture Audio", "CaptureAudio", "Sentence Audio", "SentenceAudio"],
};
// Kiku table from GSM PR #549. Lapis uses this same field shape, verified against
// donkuri/lapis f4eb29bd build/anki_fields.yaml; non-mining fields stay blank.
const KIKU = {
  Expression: "{expression}", ExpressionFurigana: "{furigana-plain}", ExpressionReading: "{reading}", ExpressionAudio: "{audio}",
  Picture: "{screenshot}",
  SelectionText: "{popup-selection-text}", MainDefinition: "{main-definition}", Glossary: "{glossary}",
  Sentence: "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}", SentenceFurigana: "{sentence-furigana-plain}",
  PitchPosition: "{pitch-accent-positions}", PitchCategories: "{pitch-accent-categories}", Frequency: "{frequencies}",
  FreqSort: "{frequency-harmonic-rank}", MiscInfo: "{document-title}",
};
const KIKU_SLOTS = { ExpressionFurigana: "expression-furigana", ExpressionReading: "reading", ExpressionAudio: "audio",
  SelectionText: "selection-text", MainDefinition: "main-definition", SentenceFurigana: "sentence-furigana",
  PitchPosition: "pitch", PitchCategories: "pitch-categories", FreqSort: "frequency-sort", MiscInfo: "document-title" };
// BrenoAqua/Senren 21ede8fb docs/yomitan.md. Its timestamp-specific primary
// dictionary example becomes the currently projected main definition, as in GSM.
const SENREN = {
  word: "{expression}", reading: "{reading}", sentence: KIKU.Sentence, sentenceFurigana: "{sentence-furigana-plain}",
  selectionText: "{popup-selection-text}", definition: "{main-definition}", wordAudio: "{audio}", glossary: "{glossary}",
  pitchAccents: "{pitch}", pitchPositions: "{pitch-accent-positions}", pitchCategories: "{pitch-accent-categories}",
  frequencies: "{frequencies}", freqSort: "{frequency-harmonic-rank}", miscInfo: "{document-title}",
  picture: "{screenshot}",
};
const fieldKey = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const knownMarker = value => MARKERS.has(value) || DYNAMIC_PREFIXES.some(prefix => value.startsWith(prefix) && value.length > prefix.length);
const blankTemplate = () => ({ value: "", overwriteMode: "coalesce" });
const semanticMarker = semantic => ({ captureAnimation: "capture-animation", captureAudio: "capture-audio" })[semantic] ?? semantic;

export const escapeAnkiHtml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

export function ankiFieldNames(fields) {
  return new Map(fields.map(field => [field.toLowerCase(), field]));
}

export function ankiTemplateMarkerNames(template) {
  return [...template.matchAll(MARKER_PATTERN)].map(match => {
    const name = match[1].toLowerCase();
    return MARKER_ALIASES.get(name) ?? name;
  });
}

export function ankiCaptureRequirements(templates) {
  const markers = new Set(Object.values(templates).flatMap(template => ankiTemplateMarkerNames(template.value)));
  return {
    includeAnimation: markers.has("capture-animation"),
    includeAudio: markers.has("capture-audio"),
    includeScreenshot: markers.has("screenshot"),
  };
}

export function ankiTemplateErrors(template) {
  return [...new Set([...template.matchAll(MARKER_PATTERN)].filter(match => !knownMarker(match[1].toLowerCase()))
    .map(match => `Unknown marker: ${match[0]}`))];
}

export function isAnkiAudioOnlyTemplate(template) {
  let hasAudio = false;
  const rest = template.replace(MARKER_PATTERN, (match, name) => {
    if (name.toLowerCase() !== "audio") return match;
    hasAudio = true;
    return "";
  }).replace(BREAK_PATTERN, "");
  return hasAudio && !rest.trim();
}

export function renderAnkiTemplate(template, values) {
  const errors = ankiTemplateErrors(template);
  if (errors.length) throw new Error(errors.join("\n"));
  return template.split(BREAK_PATTERN).flatMap(segment => {
    const markers = [...segment.matchAll(MARKER_PATTERN)];
    const rendered = segment.replace(MARKER_PATTERN, (_, name) => {
      const key = name.toLowerCase();
      return values[key] ?? values[MARKER_ALIASES.get(key)] ?? "";
    });
    return markers.length && !rendered.trim() ? [] : [rendered];
  }).join("<br>");
}

function basicTemplates(config, fields) {
  const canonical = ankiFieldNames(fields);
  const rows = new Map(fields.map(field => [field, blankTemplate()]));
  const errors = [];
  for (const semantic of ANKI_FIELDS) {
    const name = config.fields[semantic];
    if (!name) continue;
    const field = canonical.get(name.toLowerCase());
    if (!field) { errors.push(`Mapped field “${name}” is unavailable.`); continue; }
    const row = rows.get(field);
    const marker = semantic === "pitch" && field.toLowerCase() === "pitchposition" ? "pitch-position"
      : semanticMarker(semantic);
    row.value += `${row.value ? "<br>" : ""}{${marker}}`;
  }
  return { templates: Object.fromEntries(rows), staleFields: [], errors };
}

// The core a mined card needs: the expression, its reading, the sentence and a
// definition body. A note type that only shares a family name maps fewer than
// these, so first-run detection can tell a real setup from a namesake.
export function ankiPresetCoreMapped(fieldTemplates) {
  const values = new Set(Object.values(fieldTemplates).map(template => template.value));
  return values.has(KIKU.Expression) && values.has(KIKU.ExpressionReading)
    && (values.has(KIKU.MainDefinition) || values.has(KIKU.Glossary))
    && values.has(KIKU.Sentence);
}

export function resolveAnkiTemplates(config, fields) {
  if (config.fieldTemplates === null) return basicTemplates(config, fields);
  const saved = config.fieldTemplates;
  const folded = new Map();
  for (const name of Object.keys(saved)) {
    if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), name);
  }
  const used = new Set();
  const templates = Object.fromEntries(fields.map(field => {
    const name = Object.hasOwn(saved, field) ? field : folded.get(field.toLowerCase());
    if (name === undefined) return [field, blankTemplate()];
    used.add(name);
    return [field, { ...saved[name] }];
  }));
  const staleFields = Object.keys(saved).filter(field => !used.has(field));
  const errors = staleFields.map(field => `Template field “${field}” is unavailable.`);
  for (const [field, template] of Object.entries(templates)) {
    errors.push(...ankiTemplateErrors(template.value).map(error => `${field}: ${error}`));
  }
  return { templates, staleFields, errors };
}

export function applyAnkiPreset(config, fields, preset) {
  const table = preset === "senren" ? SENREN : KIKU;
  const suggestions = new Map();
  if (preset === "automatic") {
    for (const [semantic, aliases] of Object.entries(genericAliases)) {
      for (const alias of aliases) suggestions.set(fieldKey(alias), { slot: semantic, value: `{${semanticMarker(semantic)}}` });
    }
  }
  for (const [field, value] of Object.entries(table)) suggestions.set(fieldKey(field), {
    slot: table === KIKU ? KIKU_SLOTS[field] ?? field.toLowerCase() : fieldKey(field), value,
  });
  const used = new Set();
  const fieldTemplates = Object.fromEntries(fields.map(field => {
    const suggestion = suggestions.get(fieldKey(field));
    const template = blankTemplate();
    if (suggestion && !used.has(suggestion.slot)) {
      used.add(suggestion.slot);
      template.value = suggestion.value;
    }
    return [field, template];
  }));
  return { ...config, fieldTemplates };
}
