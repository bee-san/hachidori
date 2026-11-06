// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { ankiRequestFixture } from "./anki-request-fixture.mjs";
import { AnkiConnectError, answerAnkiConnect } from "./anki-connect-fake.mjs";
import { AnkiTransportError } from "../extension/anki.js";

test("native media in the Anki fake keeps the parent request's authentication", async () => {
  const calls = [];
  const reply = await answerAnkiConnect({ version: 6, action: "addNote", key: "fixture-key", params: { note: {
    fields: { Front: "猫", Picture: "" }, picture: [{ filename: "scene.jpg", data: "YQ==", fields: ["Picture"] }],
  } } }, (action, params, request) => {
    assert.equal(request?.key, "fixture-key");
    calls.push(action);
    if (action === "storeMediaFile") return params.filename;
    assert.equal(params.note.fields.Picture, '<img src="scene.jpg">');
    return 1;
  });
  assert.deepEqual(reply, { result: 1, error: null });
  assert.deepEqual(calls, ["storeMediaFile", "addNote"]);
});

test("normal mining uses one lightweight duplicate request and one add with native media", async t => {
  for (const audio of [false, true]) for (const screenshot of [false, true]) {
    await t.test(`audio=${audio}, screenshot=${screenshot}`, async () => {
      const f = ankiRequestFixture({ audio, screenshot });
      const request = await f.request(); // Initial note-type discovery is separate.
      f.calls.length = 0;
      const [ready] = await f.service.preflightMany([request]);
      assert.equal(ready.canAdd, true);
      assert.deepEqual(f.calls.map(call => call.action), ["canAddNotesWithErrorDetail"]);
      assert.deepEqual(f.calls[0].params.notes[0].fields, { Front: "猫" });
      assert.deepEqual(f.renders, [], "preflight does not start offscreen rendering");
      assert.deepEqual(f.engineCalls, [], "preflight does not wake the dictionary engine");
      f.calls.length = 0;
      if (screenshot) request.screenshot = await f.capture();
      const result = await f.service.submit(request);
      assert.equal(result.state, "added");
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(f.calls.map(call => call.action), ["addNote"]);
      const fields = f.notes.get(result.noteId);
      assert.equal(fields.Front, "猫");
      assert.equal(fields.Back, "cat");
      assert.equal(fields.Audio, audio ? `[sound:${f.audioFilename}]` : "");
      assert.equal(fields.Picture, screenshot ? `<img src="${request.screenshot.filename}">` : "");
      assert.equal(f.files.size, Number(audio) + Number(screenshot));
      f.calls.length = 0;
      await f.service.status();
      assert.equal(f.calls.length, 0, "successful adds keep the configuration metadata");
    });
  }
});

test("native preflight keeps authored clozes, batches entries, and resolves duplicate IDs only when browsing", async () => {
  const f = ankiRequestFixture();
  f.options.anki.fieldTemplates.Back.value = "{{c1::{sentence}}}";
  const first = await f.request();
  const second = { ...first, term: { ...first.term, expression: "犬" } };
  f.calls.length = 0;
  await f.service.preflightMany([first, second]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params.notes.length, 2);
  assert.deepEqual(Object.keys(f.calls[0].params.notes[0].fields), ["Front", "Back"]);
  assert.match(f.calls[0].params.notes[0].fields.Back, /\{\{c1::/u);
  f.notes.set(73, { Front: "猫", Back: "external note" });
  f.calls.length = 0;
  const duplicate = await f.service.preflight(first);
  assert.equal(duplicate.state, "duplicate");
  assert.equal(duplicate.canAdd, false);
  assert.deepEqual(duplicate.noteIds, []);
  assert.equal(f.calls.length, 1);
  const viewed = await f.service.browse({ expression: "猫", configKey: first.configKey });
  assert.deepEqual(viewed.noteIds, [73]);
  assert.equal(viewed.opened, true);
});

test("a duplicate arriving after preflight is rejected by addNote, without retrying a mutation", async () => {
  const f = ankiRequestFixture({ screenshot: true });
  const request = await f.request();
  assert.equal((await f.service.preflight(request)).canAdd, true);
  f.notes.set(73, { Front: "猫", Back: "external note" });
  request.screenshot = await f.capture();
  f.calls.length = 0;
  const result = await f.service.submit(request);
  assert.equal(result.state, "duplicate");
  assert.deepEqual(result.noteIds, [73]);
  assert.equal(f.notes.size, 1);
  assert.equal(f.files.has(request.screenshot.filename), false, "a definitive duplicate releases its captured media");
  assert.equal(f.calls.filter(call => call.action === "addNote").length, 1);
});

test("mixed media templates retain their exact markup with one upload batch and one add", async () => {
  const f = ankiRequestFixture({ audio: true, screenshot: true });
  f.options.anki.fieldTemplates.Picture.value = '<div class="scene">{screenshot}{audio}</div>';
  const request = await f.request();
  request.screenshot = await f.capture();
  f.calls.length = 0;
  const result = await f.service.submit(request);
  assert.equal(result.state, "added");
  assert.deepEqual(f.calls.map(call => call.action), ["multi", "addNote"]);
  assert.equal(f.notes.get(result.noteId).Picture,
    `<div class="scene"><img src="${request.screenshot.filename}">[sound:${f.audioFilename}]</div>`);
  assert.equal(f.files.size, 2);
});

test("native attachments keep text when media storage fails", async () => {
  const f = ankiRequestFixture({ screenshot: true });
  const request = await f.request();
  request.screenshot = await f.capture();
  f.failMedia(new AnkiConnectError("media folder is read-only"));
  const result = await f.service.submit(request);
  assert.equal(result.state, "added");
  assert.equal(f.notes.get(result.noteId).Front, "猫");
  assert.equal(f.notes.get(result.noteId).Picture, "media folder is read-only");
  assert.equal(f.files.size, 0);
});

test("a failed duplicate check refreshes cached metadata on the next attempt", async () => {
  const f = ankiRequestFixture();
  const request = await f.request();
  const invoke = f.gateway.invoke;
  f.gateway.invoke = async (...args) => {
    if (args[0] === "canAddNotesWithErrorDetail") throw new AnkiTransportError("Anki disconnected", { dispatched: true });
    return invoke(...args);
  };
  const [reply] = await f.service.preflightMany([request]);
  assert.equal(reply.state, "error");
  f.gateway.invoke = invoke;
  f.calls.length = 0;
  await f.service.status();
  assert.equal(f.calls[0].action, "multi", "reconnect discovers the current note type");
});

test("lost add acknowledgements stay uncertain and never delete media or retry the note", async () => {
  const f = ankiRequestFixture({ screenshot: true });
  const request = await f.request();
  request.screenshot = await f.capture();
  const invoke = f.gateway.invoke;
  f.gateway.invoke = async (...args) => {
    const result = await invoke(...args);
    if (args[0] === "addNote") throw new AnkiTransportError("reply lost", { dispatched: true });
    return result;
  };
  f.calls.length = 0;
  const result = await f.service.submit(request);
  assert.equal(result.state, "uncertain");
  assert.equal(f.notes.size, 1);
  assert.equal(f.files.has(request.screenshot.filename), true);
  assert.deepEqual(f.calls.map(call => call.action), ["addNote"]);
});
