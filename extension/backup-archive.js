// Hachidori's own stored ZIP64 format; loaded only for explicit backup work.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from "./vendor/zip.js";

const MANIFEST = "hachidori-backup.json";
const ZIP_OPTIONS = {
  useWebWorkers: false,
  level: 0,
  zip64: true,
  extendedTimestamp: false,
  lastModDate: new Date(1980, 0, 1),
};

export function assertBackupPath(path) {
  if (typeof path !== "string" || /[\\\u0000-\u001f\u007f]/u.test(path)
      || path.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid backup file path: ${String(path)}`);
  }
}

function assertPayloadPath(path) {
  assertBackupPath(path);
  if (!/^dictionaries\/(?:0|[1-9][0-9]*)\/.+/u.test(path)) {
    throw new Error(`Unexpected backup payload path: ${path}`);
  }
}

function assertFileList(files) {
  if (!Array.isArray(files)) throw new Error("The backup has no file list.");
  const paths = new Set();
  for (const file of files) {
    assertPayloadPath(file?.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid backup file size.");
    if (paths.has(file.path)) throw new Error(`Duplicate backup file: ${file.path}`);
    paths.add(file.path);
  }
  for (const path of paths) {
    const components = path.split("/");
    components.pop();
    while (components.length > 0) {
      if (paths.has(components.join("/"))) throw new Error(`Backup file is also a directory: ${path}`);
      components.pop();
    }
  }
}

export async function createBackupArchive(snapshot, files, createdAt = new Date().toISOString()) {
  const entries = files.map(({ path, data }) => ({ path, size: data.size }));
  assertFileList(entries);
  const manifest = { format: "hachidori-backup", version: 1, createdAt, snapshot, files: entries };
  const writer = new ZipWriter(new BlobWriter("application/zip"), ZIP_OPTIONS);
  await writer.add(MANIFEST, new BlobReader(new Blob([JSON.stringify(manifest)])));
  for (const file of files) await writer.add(file.path, new BlobReader(file.data));
  return writer.close();
}

function assertRegularEntry(entry) {
  assertBackupPath(entry.filename);
  const kind = entry.unixMode === undefined ? 0 : entry.unixMode & 0o170000;
  if (entry.directory || entry.symlink || (kind !== 0 && kind !== 0o100000)) {
    throw new Error(`The backup entry is not a regular file: ${entry.filename}`);
  }
  if (entry.encrypted || entry.compressionMethod !== 0) {
    throw new Error("Hachidori backups contain only unencrypted, stored ZIP entries.");
  }
}

function readEntry(entry) {
  return entry.getData(new BlobWriter(), {
    useWebWorkers: false, checkSignature: true, checkOverlappingEntry: true, checkAmbiguity: true,
  });
}

export async function openBackupArchive(blob) {
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false, checkAmbiguity: true });
  try {
    const entries = await reader.getEntries();
    const byPath = new Map();
    for (const entry of entries) {
      assertRegularEntry(entry);
      if (byPath.has(entry.filename)) throw new Error(`Duplicate backup file: ${entry.filename}`);
      byPath.set(entry.filename, entry);
    }
    const manifestEntry = byPath.get(MANIFEST);
    if (!manifestEntry) throw new Error("The selected archive is not a Hachidori backup.");
    const manifest = JSON.parse(await (await readEntry(manifestEntry)).text());
    if (manifest?.format !== "hachidori-backup" || manifest.version !== 1
        || typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
      throw new Error("The selected archive is not a supported Hachidori backup.");
    }
    assertFileList(manifest.files);
    if (entries.length !== manifest.files.length + 1) throw new Error("The backup contains unlisted or missing files.");
    const files = [];
    for (const file of manifest.files) {
      const entry = byPath.get(file.path);
      if (!entry) throw new Error(`The backup is missing ${file.path}`);
      if (entry.uncompressedSize !== file.size) throw new Error(`Incorrect backup file size: ${file.path}`);
      const data = await readEntry(entry);
      if (data.size !== file.size) throw new Error(`Incorrect extracted backup file size: ${file.path}`);
      files.push({ path: file.path, data });
    }
    return { snapshot: manifest.snapshot, createdAt: manifest.createdAt, files };
  } finally {
    await reader.close();
  }
}
