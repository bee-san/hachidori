// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { ankiRequestFixture } from "./anki-request-fixture.mjs";

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
      assert.deepEqual(f.renders[0], ["Front"], "preflight does not render glossaries, sentence furigana or media");
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
