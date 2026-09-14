// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { enrichAnkiNote } from "../extension/anki-enrichment.js";
const template = (value, overwriteMode = "overwrite") => ({ value, overwriteMode });

function fixture() {
  const updates = [], uploads = [];
  let fields = { front: "猫", back: "oldnew", audio: "" };
  let downloads = 0;
  const context = { request: {}, config: { audioSources: [{ id: "a", type: "custom", enabled: true, url: "https://audio.test/%w", voice: "" }] }, noteId: 12,
    resolved: { templates: { Front: template("{expression}"), Back: template("new{audio}", "append"), Audio: template("{audio}") } },
    existingFields: { front: "猫", back: "old", audio: "" }, appliedFields: { front: "猫", back: "oldnew" },
    resources: { media: [], audioPrepared: false },
    invoke: async (action, params) => {
      if (action === "storeMediaFile") { uploads.push(params); return params.filename; }
      if (action === "notesInfo") return [{ noteId: 12, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])) }];
      if (action === "updateNoteFields") { updates.push(params.note.fields); fields = { ...fields, ...params.note.fields }; return null; }
      throw new Error(`Unexpected ${action}`);
    },
  };
  const dependencies = {
    audio: async () => { downloads++; return { filename: "chosen.wav", data: "YXVkaW8=" }; },
    render: async (request, templates, audio) => ({ fields: Object.fromEntries(Object.keys(templates).map(key =>
      [key, templates[key].value.replace("{audio}", audio)])), media: [] }),
    media: () => assert.fail("No dictionary image should be fetched"),
  };
  return { context, dependencies, updates, uploads, get downloads() { return downloads; }, edit(patch) { fields = { ...fields, ...patch }; } };
}

test("audio enrichment applies overwrite modes once from original fields with authoritative field spelling", async () => {
  const f = fixture();
  assert.deepEqual(await enrichAnkiNote(f.context, f.dependencies), []);
  assert.deepEqual(f.updates, [{ back: "oldnew[sound:chosen.wav]", audio: "[sound:chosen.wav]" }]);
  assert.equal(f.downloads, 1);
  assert.equal(f.uploads[0].deleteExisting, false);
});

test("a late external edit is preserved while other audio fields can still enrich", async () => {
  const f = fixture();
  f.dependencies.audio = async () => { f.edit({ back: "external edit" }); return { filename: "chosen.wav", data: "YXVkaW8=" }; };
  const warnings = await enrichAnkiNote(f.context, f.dependencies);
  assert.match(warnings.join(" "), /back.*changed in Anki/u);
  assert.deepEqual(f.updates, [{ audio: "[sound:chosen.wav]" }]);
});

test("preserved audio fields skip downloading and a checked first-field audio plan is never rediscovered", async () => {
  const f = fixture();
  f.context.resolved.templates.Back.overwriteMode = "skip";
  f.context.resolved.templates.Audio.overwriteMode = "coalesce";
  f.context.existingFields.audio = "existing";
  assert.deepEqual(await enrichAnkiNote(f.context, f.dependencies), []);
  assert.equal(f.downloads, 0);
  assert.deepEqual(f.updates, []);
  f.context.resolved.templates.Audio.overwriteMode = "overwrite";
  f.context.resources.audioPrepared = true;
  f.context.resources.audio = { filename: "checked.wav", data: "YXVkaW8=" };
  f.edit({ audio: "existing" });
  assert.deepEqual(await enrichAnkiNote(f.context, f.dependencies), []);
  assert.equal(f.downloads, 0);
  assert.equal(f.uploads[0].filename, "checked.wav");
});

test("with no enabled audio source the pronunciation fields stay empty without a warning", async () => {
  const f = fixture();
  f.context.config.audioSources = [];
  assert.deepEqual(await enrichAnkiNote(f.context, f.dependencies), []);
  assert.equal(f.downloads, 0);
  assert.deepEqual(f.updates, []);
});

test("a renamed media upload warns without changing the checked first-field identity", async () => {
  const f = fixture();
  const invoke = f.context.invoke;
  f.context.invoke = (action, params) => action === "storeMediaFile" ? "renamed.wav" : invoke(action, params);
  assert.match((await enrichAnkiNote(f.context, f.dependencies)).join(" "), /different filename/u);
  assert.deepEqual(f.updates, []);
});
