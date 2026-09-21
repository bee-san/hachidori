import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATIC_BACKUP_INTERVAL_MS,
  automaticBackupStore,
  automaticBackupDue,
  automaticBackupJsonBytes,
  emptyAutomaticBackupStore,
  formatAutomaticBackupAge,
  newestAutomaticBackupTime,
  nextAutomaticBackupTime,
  replaceAutomaticBackup,
  validAutomaticBackups,
} from "../extension/backup-automatic.js";
import { emptyCustomDictionaryDocument } from "../extension/custom-dictionary.js";
import { emptyLookupStats } from "../extension/lookup-stats.js";

function snapshot(path = "/dicts/.hdw-generation-00000000-0000-4000-8000-000000000000/Fixture") {
  return {
    state: {
      schemaVersion: 1,
      revision: 1,
      dictionaries: path === null ? [] : [{
        id: "fixture-id",
        title: "Fixture",
        revision: "1",
        path,
        enabled: true,
        favorite: false,
        displayName: null,
        termCount: 1,
        frequencyCount: 0,
        pitchCount: 0,
        kanjiCount: 0,
        mediaCount: 0,
        isUpdatable: false,
        indexUrl: null,
        downloadUrl: null,
        lastUpdateCheck: null,
      }],
      groups: [],
    },
    options: { revision: 1 },
    document: emptyCustomDictionaryDocument(),
    updates: { revision: 1, schedule: "off", lastCheckedAt: null },
    lookupStats: emptyLookupStats(),
  };
}

function record(id, createdAt, overrides = {}) {
  return {
    id,
    createdAt,
    snapshot: snapshot(),
    lookupStatsRows: [],
    ...overrides,
  };
}

test("automatic backup storage initializes as v1 and rejects unsupported future schemas", () => {
  assert.deepEqual(automaticBackupStore(undefined), { schemaVersion: 1, backups: [] });
  assert.throws(() => automaticBackupStore({ schemaVersion: 2, backups: [] }), /unsupported schema/u);
});

test("automatic backup cadence handles time progression and backward or forward clock changes", async () => {
  const start = Date.parse("2026-09-18T12:00:00.000Z");
  const empty = emptyAutomaticBackupStore();
  assert.equal(automaticBackupDue(empty, start), true);
  assert.equal(nextAutomaticBackupTime(empty, start), start);
  const first = await replaceAutomaticBackup(empty, record("first", new Date(start).toISOString()), 2);
  assert.equal(newestAutomaticBackupTime(first), start);
  assert.equal(automaticBackupDue(first, start + AUTOMATIC_BACKUP_INTERVAL_MS - 1), false);
  assert.equal(automaticBackupDue(first, start + AUTOMATIC_BACKUP_INTERVAL_MS), true);
  assert.equal(automaticBackupDue(first, start - 7 * AUTOMATIC_BACKUP_INTERVAL_MS), false);
  assert.equal(automaticBackupDue(first, start + 30 * AUTOMATIC_BACKUP_INTERVAL_MS), true);
  const forward = start + 30 * AUTOMATIC_BACKUP_INTERVAL_MS;
  const second = await replaceAutomaticBackup(first, record("second", new Date(forward).toISOString()), 2);
  assert.equal(automaticBackupDue(second, forward), false);
  assert.equal(automaticBackupDue(second, start), false);
});

test("replacement retains the newest payloads up to the limit and shares unchanged dictionary paths", async () => {
  const day = AUTOMATIC_BACKUP_INTERVAL_MS;
  const start = Date.parse("2026-09-16T12:00:00.000Z");
  let store = emptyAutomaticBackupStore();
  for (const [index, id] of ["old", "middle", "new"].entries()) {
    store = await replaceAutomaticBackup(store, record(id, new Date(start + index * day).toISOString()), 2);
  }
  assert.deepEqual(store.backups.map(entry => entry.id), ["new", "middle"]);
  assert.equal(new Set(store.backups.flatMap(entry =>
    entry.snapshot.state.dictionaries.map(dictionary => dictionary.path))).size, 1);
  assert.ok(automaticBackupJsonBytes(store) > 0);
});

test("the retention limit keeps that many daily snapshots and a lowered limit prunes on the next snapshot", async () => {
  const day = AUTOMATIC_BACKUP_INTERVAL_MS;
  const start = Date.parse("2026-09-10T12:00:00.000Z");
  let store = emptyAutomaticBackupStore();
  for (let index = 0; index < 6; index += 1) {
    store = await replaceAutomaticBackup(store, record(`day-${index}`, new Date(start + index * day).toISOString()), 5);
  }
  assert.deepEqual(store.backups.map(entry => entry.id), ["day-5", "day-4", "day-3", "day-2", "day-1"]);
  // Lowering the option does not touch the index until the next snapshot is written.
  const lowered = await replaceAutomaticBackup(store, record("day-6", new Date(start + 6 * day).toISOString()), 1);
  assert.deepEqual(lowered.backups.map(entry => entry.id), ["day-6"]);
});

test("a corrupt newest record does not hide a valid older backup or reset its cadence", async () => {
  const start = Date.parse("2026-09-17T12:00:00.000Z");
  const older = record("older", new Date(start).toISOString());
  const corrupt = record("newest", new Date(start + AUTOMATIC_BACKUP_INTERVAL_MS).toISOString(), {
    snapshot: { ...snapshot(), state: { schemaVersion: 99, revision: 2, dictionaries: [], groups: [] } },
  });
  const store = { schemaVersion: 1, backups: [corrupt, older] };
  const valid = await validAutomaticBackups(store);
  assert.deepEqual(valid.backups.map(entry => entry.id), ["older"]);
  assert.equal(valid.corruptCount, 1);
  assert.equal(newestAutomaticBackupTime(store), start + AUTOMATIC_BACKUP_INTERVAL_MS);
  assert.equal(automaticBackupDue(store, start + 2 * AUTOMATIC_BACKUP_INTERVAL_MS - 1), false);
  assert.equal(automaticBackupDue(store, start + 2 * AUTOMATIC_BACKUP_INTERVAL_MS), true);
});

test("relative ages report actual past and future wall-clock differences", () => {
  const now = Date.parse("2026-09-18T12:00:00.000Z");
  assert.equal(formatAutomaticBackupAge("2026-09-18T09:00:00.000Z", now, "en"), "3 hours ago");
  assert.equal(formatAutomaticBackupAge("2026-09-17T12:00:00.000Z", now, "en"), "1 day ago");
  assert.equal(formatAutomaticBackupAge("2026-09-18T14:00:00.000Z", now, "en"), "in 2 hours");
  assert.equal(formatAutomaticBackupAge("2026-09-18T11:59:30.000Z", now, "en"), "less than a minute ago");
});
