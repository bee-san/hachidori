// SPDX-License-Identifier: GPL-3.0-or-later
// Uses the production worker, gateway, live index queries and persistent
// duplicate cache, rather than a mock index that always returns fresh IDs.
import assert from "node:assert/strict";
import test from "node:test";
import { ankiRequestFixture } from "./anki-request-fixture.mjs";

for (const identity of ["{expression}", "word:{expression}"]) {
  for (const duplicateBehavior of ["prevent", "overwrite"]) {
    test(`Add → delete → preflight and browse (${identity}, ${duplicateBehavior})`, async () => {
      const f = ankiRequestFixture();
      f.options.anki = globalThis.HDReaderOptions.normaliseAnki({ ...f.options.anki, duplicateBehavior,
        fieldTemplates: { Front: { value: identity, overwriteMode: "overwrite" },
          Back: { value: "cat", overwriteMode: "overwrite" } } });
      const request = await f.request();
      assert.equal((await f.service.preflight(request)).canAdd, true);
      const added = await f.service.submit(request);
      assert.equal(added.state, "added");
      assert.equal((await f.service.preflight(request)).state, "duplicate");
      assert.equal(f.notes.delete(added.noteId), true, "delete only the disposable fake-Anki note");
      assert.deepEqual(await f.gateway.invoke("notesInfo", { notes: [added.noteId] }), [{}],
        "the missing-note response matches AnkiConnect's real placeholder shape");
      const checked = await f.service.preflight(request);
      assert.equal(checked.canAdd, true, "deleted notes cannot block another Add or retain an overwrite target");
      assert.notEqual(checked.action, "overwrite");
      const browsed = await f.service.browse({ expression: "猫", noteIds: [added.noteId], configKey: request.configKey });
      assert.deepEqual(browsed, { opened: false, noteIds: [], repaired: true });
      assert.equal(f.calls.some(call => call.action === "guiBrowse"), false,
        "a missing note resets View instead of opening an empty Anki browser");
      const replaced = await f.service.submit(request);
      assert.equal(replaced.state, "added");
      assert.notEqual(replaced.noteId, added.noteId);
      assert.equal(f.calls.some(call => call.action === "updateNoteFields" && call.params.note.id === added.noteId), false);
    });
  }
}
