import assert from "node:assert/strict";
import test from "node:test";
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from "../extension/vendor/zip.js";
import { createBackupArchive, openBackupArchive } from "../extension/backup-archive.js";
import { assertBackupSnapshot } from "../extension/backup-state.js";
import { emptyCustomDictionaryDocument } from "../extension/custom-dictionary.js";

const snapshot = { state: { dictionaries: [{ id: "dictionary-id", title: "辞書" }] }, lookupStats: { generation: "archived", revision: 3 } };
const lookupStatsRows = [{ term: "猫", reading: "ねこ", lookupCount: 3, firstLookedUpAt: 100, lastLookedUpAt: 200 }];
const files = [
  { path: "dictionaries/0/index.json", data: new Blob(['{"title":"辞書"}']) },
  { path: "dictionaries/0/media/画像.bin", data: new Blob([new Uint8Array([0, 255, 42])]) },
];
const zipOptions = { useWebWorkers: false, level: 0, extendedTimestamp: false };

test("backup ZIP64 preserves snapshot, UTF-8 paths and binary files", async () => {
  const archive = await createBackupArchive(snapshot, files, lookupStatsRows, "2026-09-07T00:00:00.000Z");
  const prepared = await openBackupArchive(archive);
  assert.deepEqual(prepared.snapshot, snapshot);
  assert.deepEqual(prepared.lookupStatsRows, lookupStatsRows);
  assert.equal(prepared.createdAt, "2026-09-07T00:00:00.000Z");
  assert.deepEqual(prepared.files.map(file => file.path), files.map(file => file.path));
  for (const [index, file] of prepared.files.entries()) {
    assert.deepEqual(await file.data.arrayBuffer(), await files[index].data.arrayBuffer());
  }
  const reader = new ZipReader(new BlobReader(archive), zipOptions);
  const entries = await reader.getEntries();
  assert.ok(entries.every(entry => entry.zip64 && entry.compressionMethod === 0));
  await reader.close();
});

test("older backups discard retired corpus options and preserve standalone reader settings", async () => {
  const archived = {
    state: { schemaVersion: 1, revision: 8, dictionaries: [], groups: [] },
    document: emptyCustomDictionaryDocument(),
    options: { revision: 21, popupTheme: "dark", showLookupCounts: true,
      corpusSeenEnabled: true, corpusSeenUrl: "http://127.0.0.1:55000" },
    updates: { revision: 4, schedule: "daily", lastCheckedAt: null },
    lookupStats: { generation: "archived", revision: 3 },
  };
  const prepared = await openBackupArchive(await createBackupArchive(archived, [], lookupStatsRows));
  assert.deepEqual(prepared.snapshot.options, { revision: 21, popupTheme: "dark", showLookupCounts: true });
  assert.deepEqual(prepared.lookupStatsRows, lookupStatsRows);
  await assertBackupSnapshot(prepared.snapshot);
  prepared.snapshot.options.unknown = true;
  await assert.rejects(assertBackupSnapshot(prepared.snapshot));
});

async function rewrite(archive, change) {
  const reader = new ZipReader(new BlobReader(archive), zipOptions);
  const writer = new ZipWriter(new BlobWriter(), zipOptions);
  for (const entry of await reader.getEntries()) {
    const edited = await change(entry.filename, await entry.getData(new BlobWriter()));
    if (edited) await writer.add(edited.path, new BlobReader(edited.data), edited.options);
  }
  await reader.close();
  return writer.close();
}

test("backup validation rejects missing, unlisted, unsafe and non-file payloads", async () => {
  const archive = await createBackupArchive(snapshot, files, lookupStatsRows);
  const target = files[1].path;
  for (const replacement of [null, "dictionaries/0/extra.bin", "dictionaries/0/../escape", "dictionaries/0\\escape"]) {
    const malformed = await rewrite(archive, (path, data) => path === target
      ? replacement && { path: replacement, data }
      : { path, data });
    await assert.rejects(openBackupArchive(malformed));
  }
  const symlink = await rewrite(archive, (path, data) => ({
    path, data, ...(path === target ? { options: { unixMode: 0o120777 } } : {}),
  }));
  await assert.rejects(openBackupArchive(symlink), /regular file/u);
});

test("backup validation checks file CRC and the exact declared sizes", async () => {
  const archive = await createBackupArchive(snapshot, files, lookupStatsRows);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const marker = new TextEncoder().encode('{"title":"辞書"}');
  const offset = bytes.findIndex((_, start) => marker.every((value, index) => bytes[start + index] === value));
  assert.ok(offset >= 0);
  bytes[offset + 2] ^= 1;
  await assert.rejects(openBackupArchive(new Blob([bytes])), /signature|CRC/iu);
  const wrongSize = await rewrite(archive, async (path, data) => {
    if (path !== "hachidori-backup.json") return { path, data };
    const manifest = JSON.parse(await data.text());
    manifest.files[0].size += 1;
    return { path, data: new Blob([JSON.stringify(manifest)]) };
  });
  await assert.rejects(openBackupArchive(wrongSize), /size/u);
});

test("version 1 restores empty statistics while version 2 requires its complete statistics payload", async () => {
  const archive = await createBackupArchive(snapshot, files, lookupStatsRows);
  const editManifest = change => rewrite(archive, async (path, data) => {
    if (path !== "hachidori-backup.json") return { path, data };
    const manifest = JSON.parse(await data.text());
    change(manifest);
    return { path, data: new Blob([JSON.stringify(manifest)]) };
  });
  const old = await openBackupArchive(await editManifest(manifest => {
    manifest.version = 1;
    delete manifest.lookupStatsRows;
    delete manifest.snapshot.lookupStats;
  }));
  assert.deepEqual(old.lookupStatsRows, []);
  assert.deepEqual(old.snapshot.lookupStats, { generation: null, revision: 0 });
  for (const edit of [manifest => { delete manifest.lookupStatsRows; },
    manifest => { delete manifest.snapshot.lookupStats; }, manifest => { manifest.version = 3; }]) {
    await assert.rejects(openBackupArchive(await editManifest(edit)));
  }
});
