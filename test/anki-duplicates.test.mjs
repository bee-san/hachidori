// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { ankiNoteOptions, ankiBrowseQuery, ankiNoteIdsQuery, overwriteAnkiFields, checkAnkiDuplicate, explainAnkiRefusal,
  findAnkiDuplicateNotes, validateAnkiNote, canonicalAnkiFields } from "../extension/anki-duplicates.js";
import { renderAnkiTemplate } from "../extension/anki-templates.js";

const config = patch => ({ ...globalThis.HDReaderOptions.normaliseOptions({}).anki,
  model: "Basic", deck: "Japanese::Words", ...patch });
const note = patch => ({ deckName: "Japanese::Words", modelName: "Basic", fields: { Front: "猫", Back: "cat" },
  options: ankiNoteOptions(config()), tags: ["hachidori"], ...patch });

test("duplicate options keep Anki's race guard on the configured type while the index owns broad scopes", () => {
  assert.deepEqual(ankiNoteOptions(config()), { allowDuplicate: false, duplicateScope: "collection",
    duplicateScopeOptions: { deckName: null, checkChildren: false, checkAllModels: false } });
  assert.deepEqual(ankiNoteOptions(config({ duplicateScope: "deck" })),
    { allowDuplicate: false, duplicateScope: "deck",
      duplicateScopeOptions: { deckName: "Japanese::Words", checkChildren: true, checkAllModels: false } });
  assert.equal(ankiNoteOptions(config({ duplicateScope: "all" })).duplicateScopeOptions.checkAllModels, false);
  assert.equal(ankiNoteOptions(config({ duplicateBehavior: "overwrite" })).allowDuplicate, false);
  assert.equal(ankiNoteOptions(config({ duplicateBehavior: "new" })).allowDuplicate, true);
});

test("browse searches encode literal HTML and neutralize Anki query syntax", () => {
  assert.equal(ankiBrowseQuery('猫<&"*_:\\'), '"猫&lt;&amp;\\"\\*\\_\\:\\\\"');
  assert.equal(ankiNoteIdsQuery([7, 3, 7]), "nid:7,3");
  assert.throws(() => ankiNoteIdsQuery([]), /note IDs/u);
});

test("all overwrite modes preserve empty values and defer audio-only fields until enrichment", () => {
  const modes = globalThis.HDReaderOptions.ANKI_OVERWRITE_MODES;
  const templates = Object.fromEntries(modes.map(mode => [mode, { value: "{expression}", overwriteMode: mode }]));
  templates.Audio = { value: "{AUDIO}<br>{audio}", overwriteMode: "overwrite" };
  templates.Disabled = { value: "", overwriteMode: "overwrite" };
  const existing = Object.fromEntries([...modes, "Audio", "Disabled"].map(field => [field, "old"]));
  const incoming = Object.fromEntries(modes.map(field => [field, "new"]));
  assert.deepEqual(overwriteAnkiFields(incoming, existing, templates), { coalesce: "old", "coalesce-new": "new",
    skip: "old", append: "oldnew", prepend: "newold", overwrite: "new", Disabled: "" });
  assert.equal(overwriteAnkiFields({ coalesce: "new" }, { coalesce: "" }, templates).coalesce, "new");
  assert.equal(overwriteAnkiFields({}, existing, templates)["coalesce-new"], "old");
});

test("preflight retains cloze fields while distinguishing duplicates from invalid notes", async () => {
  const calls = [];
  let result = [{ canAdd: false, error: "cannot create note because it is a duplicate" }];
  const invoke = async (action, params) => { calls.push({ action, params }); return result; };
  const value = note({ fields: { Front: "猫", Back: "{{c1::cat}}" }, audio: [{ url: "https://example.com/audio" }] });
  const duplicate = await checkAnkiDuplicate(invoke, value, config());
  assert.deepEqual(duplicate, { duplicate: true, addable: false, error: result[0].error });
  assert.equal(calls[0].action, "canAddNotesWithErrorDetail");
  assert.deepEqual(calls[0].params.notes[0].fields, value.fields);
  assert.equal(Object.hasOwn(calls[0].params.notes[0], "audio"), false);
  assert.equal(calls[0].params.notes[0].options.allowDuplicate, false);
  result = [{ canAdd: false, error: "cannot create note because it is empty" }];
  assert.equal((await checkAnkiDuplicate(invoke, value, config())).duplicate, false);
  result = [];
  await assert.rejects(checkAnkiDuplicate(invoke, value, config()), /invalid duplicate/u);
  result = [{ canAdd: true, error: null }];
  assert.deepEqual(await validateAnkiNote(invoke, value), { addable: true, error: null });
  assert.equal(calls.at(-1).params.notes[0].options.allowDuplicate, true);
});

test("legacy duplicate checks fall back only for the documented unsupported action", async () => {
  const calls = [];
  const invoke = async (action, params) => {
    calls.push(action);
    if (action === "canAddNotesWithErrorDetail") throw new Error("unsupported action");
    return [params.notes[0].options.allowDuplicate];
  };
  assert.equal((await checkAnkiDuplicate(invoke, note(), config())).duplicate, true);
  assert.deepEqual(calls, ["canAddNotesWithErrorDetail", "canAddNotes", "canAddNotes"]);
  await assert.rejects(checkAnkiDuplicate(async () => { throw new Error("offline"); }, note(), config()), /offline/u);
});

test("duplicate discovery keeps Anki order but requires the configured model and authoritative card deck scope", async () => {
  const calls = [];
  const invoke = async (action, params) => {
    calls.push({ action, params });
    if (action === "modelNamesAndIds") return { Basic: 123 };
    if (action === "findNotes") return [9, 8, 7, 6];
    if (action === "notesInfo") return [
      { noteId: 6, modelName: "Basic", fields: { Front: { value: "猫" } }, cards: [60] },
      { noteId: 7, modelName: "Basic", fields: { Front: { value: "猫" } }, cards: [70] },
      { noteId: 8, modelName: "Basic", fields: { Front: { value: "猫" } }, cards: [80] },
      { noteId: 9, modelName: "Other", fields: { Front: { value: "猫" } }, cards: [90] },
    ];
    return [{ note: 6, deckName: "Japanese::Words" }, { note: 7, deckName: "Japanese::Words::Child" },
      { note: 8, deckName: "Outside" }, { note: 9, deckName: "Japanese::Words" }];
  };
  const scoped = await findAnkiDuplicateNotes(invoke, note(), "Front", config({ duplicateScope: "deck" }));
  assert.deepEqual(scoped, [
    { noteId: 7, modelName: "Basic", fields: { Front: "猫" } },
    { noteId: 6, modelName: "Basic", fields: { Front: "猫" } },
  ]);
  assert.deepEqual(calls.map(call => call.action), ["modelNamesAndIds", "findNotes", "notesInfo", "cardsInfo"]);
  assert.equal(calls[1].params.query, '"dupe:123,猫"');
  assert.deepEqual((await findAnkiDuplicateNotes(invoke, note(), "Front", config())).map(match => match.noteId), [8, 7, 6]);
});

test("duplicate discovery uses Anki's exact stripped-HTML duplicate identity, not case-insensitive field search", async () => {
  for (const text of ["dog", "犬", 'literal *_,:"\\']) {
    const query = `"dupe:123,${text.replace(/[\\"]/gu, "\\$&")}"`;
    const invoke = async (action, params) => {
      if (action === "modelNamesAndIds") return { Basic: 123 };
      if (action === "findNotes") {
        assert.equal(params.query, query);
        return [2];
      }
      return [{ noteId: 2, modelName: "Basic", fields: { Front: { value: `<b>${text}</b>` } } }];
    };
    const [target] = await findAnkiDuplicateNotes(invoke, note({ fields: { Front: text } }), "Front", config());
    assert.equal(target.noteId, 2);
    assert.equal(target.fields.Front, `<b>${text}</b>`);
  }
});

test("overwriting a note whose note type lost a mapped field names that field and the note's fields", () => {
  const templates = { Front: { value: "{expression}", overwriteMode: "overwrite" }, Extra: { value: "{reading}", overwriteMode: "overwrite" } };
  assert.throws(() => canonicalAnkiFields({ Front: "猫", Extra: "ねこ" }, templates, { Front: "old", Back: "old" }),
    /^Error: Anki's note has no field “Extra” to overwrite; its fields are “Front”, “Back”\. The note type's fields changed\. Refresh fields in Anki Settings before overwriting this note\.$/u);
});

test("an unknown-reason refusal names the cloze rule Anki applied, with its deck, note type, field and deletion", async () => {
  const unknown = "cannot create note for unknown reason";
  // Anki's stock note types (rslib/src/notetype/stock.rs); type 1 is a Cloze type.
  const cloze = { type: 1, flds: [{ name: "Text" }, { name: "Back Extra" }], tmpls: [{ qfmt: "{{cloze:Text}}" }] };
  const basic = { type: 0, flds: [{ name: "Front" }, { name: "Back" }], tmpls: [{ qfmt: "{{Front}}" }] };
  const requests = [];
  const reads = model => async (action, params) => { requests.push({ action, params }); return [model]; };
  // These deletions are literal template text.
  const literal = fields => Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }]));
  const refusal = (model, modelName, fields, templates = literal(fields)) =>
    explainAnkiRefusal(reads(model), note({ modelName, fields }), unknown, templates);
  const context = modelName => `Anki refused the note for deck “Japanese::Words”, note type “${modelName}”`;
  const generic = `${context("Basic")} because of its cloze deletions ({{c1::…}}): a Cloze note type needs one in its cloze field, `
    + "and no other field or note type may have one. Check the field mapping in Anki Settings.";
  // The three cloze states of Anki's own fields_check test (rslib/src/notes/mod.rs).
  const missing = await refusal(cloze, "Cloze", { Text: "no cloze", "Back Extra": "" });
  assert.equal(missing, `${context("Cloze")}: it is a Cloze note type, but its cloze field “Text” has no cloze deletion such as {{c1::…}}. `
    + "Map “Text” to a template that makes one, for example {cloze-prefix}{{c1::{cloze-body}}}{cloze-suffix}, or choose a non-Cloze note type in Anki Settings.");
  assert.deepEqual(requests, [{ action: "findModelsByName", params: { modelNames: ["Cloze"] } }]);
  const misplaced = await refusal(cloze, "Cloze", { Text: "{{c1::foo}}", "Back Extra": "{{c1::non-cloze field}}" });
  assert.equal(misplaced, `${context("Cloze")}: field “Back Extra” contains the cloze deletion “{{c1::non-cloze field}}”, `
    + "but “Cloze” makes cloze cards only from “Text”. Move the deletion to the template of “Text” in Anki Settings.");
  // AnkiConnect assigns a submitted field to the note type's field case-insensitively.
  const notCloze = await refusal(basic, "Basic", { front: "{{c1::foo}}", Back: "" });
  assert.equal(notCloze, `${context("Basic")}: field “Front” contains the cloze deletion “{{c1::foo}}”, but “Basic” is not a Cloze note type. `
    + "Remove the deletion from that field's template in Anki Settings, or choose a Cloze note type.");
  // A deletion that reached the field through a marker's content has no template text to remove.
  const fromContent = await refusal(basic, "Basic", { Front: "猫", Back: "例: {{c1::より}}" },
    { Front: { value: "{expression}" }, Back: { value: "<i>{glossary}</i>{sentence}" } });
  assert.equal(fromContent, `${context("Basic")}: field “Back” contains the cloze deletion “{{c1::より}}”, but “Basic” is not a Cloze note type. `
    + "The deletion comes from the content of {glossary}, {sentence}, not from the field's template. "
    + "Map that field to other content in Anki Settings, or choose a Cloze note type.");
  assert.doesNotMatch(fromContent, /Remove the deletion/u);
  // Rendered through a template, a dictionary's own cloze text is no deletion at all.
  const glossary = renderAnkiTemplate("{glossary}", { glossary: "<li>{{c1::猫}}</li>" });
  assert.equal(await refusal(basic, "Basic", { Front: "猫", Back: glossary }, { Back: { value: "{glossary}" } }), generic);
  // A filter chain still renders the cloze field. Anki finds a template's field case-insensitively
  // and skips a reference inside an HTML comment.
  const chained = { ...cloze, tmpls: [{ qfmt: "<!-- {{cloze:Back Extra}} -->{{#Text}}{{furigana:cloze:text}}{{/Text}}" }] };
  assert.match(await refusal(chained, "Cloze", { Text: "", "Back Extra": "{{c2::x}}" }),
    /: field “Back Extra” contains the cloze deletion “\{\{c2::x\}\}”, but “Cloze” makes cloze cards only from “Text”\./u);
  // Without findModelsByName, or when no rule matches, the cause is still named.
  assert.equal(await explainAnkiRefusal(async () => { throw new Error("AnkiConnect: unsupported action"); }, note(), unknown, {}), generic);
  assert.equal(await refusal(basic, "Basic", { Front: "{{c0::zero}}" }), generic, "cloze number 0 is not a deletion");
  for (const message of [missing, misplaced, notCloze, fromContent, generic]) assert.doesNotMatch(message, /unknown/iu);
  // Other per-note refusals get the gateway's translation; unmatched text is kept.
  const read = requests.length;
  assert.equal(await explainAnkiRefusal(reads(basic), note(), "cannot create note because it is empty", {}),
    "Anki refused the note because its first field is empty. Map the first field to content this result has. "
      + "(AnkiConnect: cannot create note because it is empty)");
  assert.equal(await explainAnkiRefusal(reads(basic), note(), "Anki rejected this note.", {}), "Anki rejected this note.");
  assert.equal(requests.length, read, "only an unknown-reason refusal reads the note type");
});
