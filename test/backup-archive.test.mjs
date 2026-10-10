import assert from "node:assert/strict";
import test from "node:test";
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from "../extension/vendor/zip.js";
import { createBackupArchive, openBackupArchive } from "../extension/backup-archive.js";
import { assertBackupSnapshot, prepareBackupSnapshot } from "../extension/backup-state.js";
import { emptyCustomDictionaryDocument } from "../extension/custom-dictionary.js";

const snapshot = { state: { dictionaries: [{ id: "dictionary-id", title: "辞書" }] }, lookupStats: { generation: "archived", revision: 3 } };
const lookupStatsRows = [{ term: "猫", reading: "ねこ", lookupCount: 3, firstLookedUpAt: 100, lastLookedUpAt: 200 }];
const files = [
  { path: "dictionaries/0/index.json", data: new Blob(['{"title":"辞書"}']) },
  { path: "dictionaries/0/media/画像.bin", data: new Blob([new Uint8Array([0, 255, 42])]) },
];
const zipOptions = { useWebWorkers: false, level: 0, extendedTimestamp: false };

// Model a large worker Response(stream).blob() sink cancelling with an
// undefined reason, which zip.js masks with the reported outputSize error.
function failStreamedResponseBlobs(t) {
  t.mock.method(Response.prototype, "blob", async function () {
    const reader = this.body.getReader();
    const parts = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) return new Blob(parts);
      parts.push(value);
      size += value.byteLength;
      if (size > 10 * 1024 * 1024) {
        await reader.cancel();
        throw new TypeError("Failed to fetch");
      }
    }
  });
}

const largeFile = {
  path: "dictionaries/0/media/画像.bin",
  data: new Blob([new Uint8Array(16 * 1024 * 1024).fill(42)]),
};

test("backup exports large files without Response stream-to-blob consumption", async t => {
  failStreamedResponseBlobs(t);
  const archive = await createBackupArchive(snapshot, [largeFile], lookupStatsRows);
  assert.equal(archive.type, "application/zip");
  assert.ok(archive.size > largeFile.data.size);
  const prepared = await openBackupArchive(archive);
  assert.deepEqual(prepared.snapshot, snapshot);
  assert.deepEqual(await prepared.files[0].data.arrayBuffer(), await largeFile.data.arrayBuffer());
});

test("restore reads existing large backups without Response stream-to-blob consumption", async t => {
  // Build through the old writer before injecting the failure, so export and
  // restore cannot pass by agreeing on a new, incompatible representation.
  const writer = new ZipWriter(new BlobWriter(), { ...zipOptions, zip64: true });
  await writer.add("hachidori-backup.json", new BlobReader(new Blob([JSON.stringify({
    format: "hachidori-backup", version: 2, createdAt: "2026-09-07T00:00:00.000Z",
    snapshot, lookupStatsRows, files: [{ path: largeFile.path, size: largeFile.data.size }],
  })])));
  await writer.add(largeFile.path, new BlobReader(largeFile.data));
  const archive = await writer.close();
  failStreamedResponseBlobs(t);
  const prepared = await openBackupArchive(archive);
  // Version 2 predates the words marked as known or ignored.
  assert.deepEqual(prepared.snapshot, { ...snapshot, wordStatusOverrides: { revision: 0, known: [], ignored: [] } });
  assert.deepEqual(prepared.lookupStatsRows, lookupStatsRows);
  assert.equal(prepared.files[0].path, largeFile.path);
  assert.deepEqual(await prepared.files[0].data.arrayBuffer(), await largeFile.data.arrayBuffer());
});

test("backup and restore preserve empty payload files and an empty library", async () => {
  const emptySnapshot = { state: { dictionaries: [] }, lookupStats: { generation: null, revision: 0 } };
  const prepared = await openBackupArchive(await createBackupArchive(emptySnapshot, [], []));
  assert.deepEqual(prepared.snapshot, emptySnapshot);
  assert.deepEqual(prepared.files, []);
  const emptyFile = { path: "dictionaries/0/empty.bin", data: new Blob() };
  const withEmptyFile = await openBackupArchive(await createBackupArchive(snapshot, [emptyFile], lookupStatsRows));
  assert.equal(withEmptyFile.files[0].path, emptyFile.path);
  assert.equal(withEmptyFile.files[0].data.size, 0);
});

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

test("archive versions 1, 2 and 3 restore with incompatible reader settings", async () => {
  const current = {
    state: { schemaVersion: 1, revision: 1, dictionaries: [], groups: [] },
    document: emptyCustomDictionaryDocument(), options: { revision: 3, popupTheme: "light" },
    updates: { revision: 1, schedule: "off", lastCheckedAt: null },
    lookupStats: { generation: "archived", revision: 0 },
  };
  const archive = await createBackupArchive({ ...current, options: { revision: 1, futureOption: true } }, [], []);
  for (const version of [1, 2, 3]) {
    const legacy = await rewrite(archive, async (path, data) => {
      const manifest = JSON.parse(await data.text());
      return { path, data: new Blob([JSON.stringify({ ...manifest, version })]) };
    });
    const archived = await openBackupArchive(legacy);
    const prepared = await prepareBackupSnapshot(current, archived.snapshot);
    assert.match(prepared.warning, /reader settings.*skipped/iu);
    assert.deepEqual(prepared.snapshot.options, current.options);
    await assertBackupSnapshot(prepared.snapshot);
  }
});

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

test("version 1 restores empty statistics, version 2 requires them, and version 3 adds word status overrides", async () => {
  const overrides = { revision: 2, known: ["猫"], ignored: ["さん"] };
  const archive = await createBackupArchive({ ...snapshot, wordStatusOverrides: overrides }, files, lookupStatsRows);
  assert.deepEqual((await openBackupArchive(archive)).snapshot.wordStatusOverrides, overrides);
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
  const version2 = await openBackupArchive(await editManifest(manifest => { manifest.version = 2; }));
  assert.deepEqual(version2.snapshot.wordStatusOverrides, { revision: 0, known: [], ignored: [] });
  assert.deepEqual(version2.lookupStatsRows, lookupStatsRows);
  for (const edit of [manifest => { delete manifest.lookupStatsRows; },
    manifest => { delete manifest.snapshot.lookupStats; }, manifest => { manifest.version = 4; }]) {
    await assert.rejects(openBackupArchive(await editManifest(edit)));
  }
});
