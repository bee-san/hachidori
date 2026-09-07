import assert from "node:assert/strict";
import test from "node:test";
import { assertBackupSnapshot, backupRevisions, restoredBackupSnapshot } from "../extension/backup-state.js";
import { emptyCustomDictionaryDocument } from "../extension/custom-dictionary.js";

const snapshot = () => ({
  state: { schemaVersion: 1, revision: 8, dictionaries: [], groups: [] },
  document: emptyCustomDictionaryDocument(),
  options: { revision: 21, popupTheme: "dark" },
  updates: { revision: 4, schedule: "daily", lastCheckedAt: null },
});

test("complete restore advances each local revision and replaces absent/default settings", async () => {
  const current = snapshot();
  const archived = snapshot();
  archived.options = { revision: 0 };
  archived.updates = { revision: 0, schedule: "off", lastCheckedAt: null };
  archived.state.revision = 0;
  await assertBackupSnapshot(archived);
  const restored = restoredBackupSnapshot(current, archived, []);
  assert.deepEqual(backupRevisions(restored), { state: 9, options: 22, document: 1, updates: 5 });
  assert.deepEqual(restored.options, { revision: 22 });
  assert.equal(restored.updates.schedule, "off");
  await assertBackupSnapshot(restored);
});

test("restore validation rejects malformed state, settings and inconsistent custom source", async () => {
  const edits = [
    value => { value.state.schemaVersion = 2; },
    value => { delete value.state.revision; },
    value => { value.options = { revision: 0, popupWidthPx: -1 }; },
    value => { value.options.unknown = true; },
    value => { value.updates.schedule = "sometimes"; },
    value => { value.document.text = "猫,ねこ,cat"; },
    value => { value.state.groups = [{ id: "x", name: "All", dictionaryIds: [] }]; },
  ];
  for (const edit of edits) {
    const value = snapshot();
    edit(value);
    await assert.rejects(assertBackupSnapshot(value));
  }
});
