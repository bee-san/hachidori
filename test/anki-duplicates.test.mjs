// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";
import { ankiNoteOptions, ankiBrowseQuery, overwriteAnkiFields, checkAnkiDuplicate,
  findAnkiOverwriteTarget } from "../extension/anki-duplicates.js";

const config = patch => ({ ...globalThis.HDReaderOptions.normaliseOptions({}).anki,
  model: "Basic", deck: "Japanese::Words", ...patch });
const note = patch => ({ deckName: "Japanese::Words", modelName: "Basic", fields: { Front: "猫", Back: "cat" },
  options: ankiNoteOptions(config()), tags: ["hachidori"], ...patch });

test("duplicate options distinguish exact deck, root descendants, all models and disabled checking", () => {
  assert.deepEqual(ankiNoteOptions(config()), { allowDuplicate: false, duplicateScope: "collection",
    duplicateScopeOptions: { deckName: null, checkChildren: false, checkAllModels: false } });
  assert.deepEqual(ankiNoteOptions(config({ duplicateScope: "deck-root", duplicateScopeCheckAllModels: true })),
    { allowDuplicate: false, duplicateScope: "deck", duplicateScopeOptions: { deckName: "Japanese", checkChildren: true, checkAllModels: true } });
  assert.equal(ankiNoteOptions(config({ duplicateScope: "deck" })).duplicateScopeOptions.checkChildren, false);
  for (const patch of [{ duplicateBehavior: "new" }, { duplicateBehavior: "overwrite" }, { checkForDuplicates: false }]) {
    assert.equal(ankiNoteOptions(config(patch)).allowDuplicate, true);
  }
});

test("browse searches encode literal HTML and neutralize Anki query syntax", () => {
  assert.equal(ankiBrowseQuery('猫<&"*_:\\'), '"猫&lt;&amp;\\"\\*\\_\\:\\\\"');
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

test("preflight checks only the actual first field, distinguishes duplicates from invalid notes and bypasses disabled checks", async () => {
  const calls = [];
  let result = [{ canAdd: false, error: "cannot create note because it is a duplicate" }];
  const invoke = async (action, params) => { calls.push({ action, params }); return result; };
  const value = note();
  const duplicate = await checkAnkiDuplicate(invoke, value, "Back", config());
  assert.deepEqual(duplicate, { duplicate: true, addable: false, error: result[0].error });
  assert.equal(calls[0].action, "canAddNotesWithErrorDetail");
  assert.deepEqual(calls[0].params.notes[0].fields, { Back: "cat" });
  assert.equal(calls[0].params.notes[0].options.allowDuplicate, false);
  result = [{ canAdd: false, error: "cannot create note because it is empty" }];
  assert.equal((await checkAnkiDuplicate(invoke, value, "Front", config())).duplicate, false);
  result = [];
  await assert.rejects(checkAnkiDuplicate(invoke, value, "Front", config()), /invalid duplicate/u);
  const before = calls.length;
  assert.deepEqual(await checkAnkiDuplicate(invoke, value, "Front", config({ checkForDuplicates: false })),
    { duplicate: false, addable: true, error: null });
  assert.equal(calls.length, before);
});

test("legacy duplicate checks fall back only for the documented unsupported action", async () => {
  const calls = [];
  const invoke = async (action, params) => {
    calls.push(action);
    if (action === "canAddNotesWithErrorDetail") throw new Error("unsupported action");
    return [params.notes[0].options.allowDuplicate];
  };
  assert.equal((await checkAnkiDuplicate(invoke, note(), "Front", config())).duplicate, true);
  assert.deepEqual(calls, ["canAddNotesWithErrorDetail", "canAddNotes", "canAddNotes"]);
  await assert.rejects(checkAnkiDuplicate(async () => { throw new Error("offline"); }, note(), "Front", config()), /offline/u);
});

test("overwrite target retains Anki order but requires the same model and authoritative card deck scope", async () => {
  const calls = [];
  const invoke = async (action, params) => {
    calls.push({ action, params });
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
  const exact = await findAnkiOverwriteTarget(invoke, note(), "Front", config({ duplicateScope: "deck", duplicateScopeCheckAllModels: true }));
  assert.deepEqual(exact, { noteId: 6, fields: { Front: "猫" } });
  assert.deepEqual(calls.map(call => call.action), ["findNotes", "notesInfo", "cardsInfo"]);
  assert.match(calls[0].params.query, /deck:Japanese\\:\\:Words/u);
  assert.equal((await findAnkiOverwriteTarget(invoke, note(), "Front", config({ duplicateScope: "deck-root" }))).noteId, 7);
  assert.equal((await findAnkiOverwriteTarget(invoke, note(), "Front", config())).noteId, 8);
});
