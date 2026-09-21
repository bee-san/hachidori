#!/usr/bin/env node
// Confirm a release XPI carries the reviewed MV2 manifest and no Chrome-only file.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

function fail(message) {
  throw new Error(message);
}

// Deterministic archives from package-store.py have no ZIP64 records or comments.
export function zipEntries(buffer) {
  const end = buffer.length - 22;
  if (end < 0 || buffer.readUInt32LE(end) !== END_OF_CENTRAL_DIRECTORY) fail("not a ZIP archive");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) fail("damaged central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) fail(`damaged local header for ${name}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, () => {
      if (method === 8) return inflateRawSync(data);
      if (method === 0) return data;
      return fail(`unsupported compression for ${name}`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function verifyFirefoxPackage(entries, { excludedFiles, chromeVersion }) {
  const manifestEntry = entries.get("manifest.json") ?? fail("the XPI has no manifest.json");
  const manifest = JSON.parse(manifestEntry().toString("utf8"));
  if (manifest.manifest_version !== 2) fail("the XPI manifest is not manifest_version 2");
  if (manifest.background?.page !== "firefox-background.html") fail("the XPI manifest does not use the Firefox background page");
  if (manifest.browser_specific_settings?.gecko?.id !== "hachidori@bee-san") fail("the XPI manifest has the wrong gecko id");
  if (chromeVersion !== undefined && manifest.version !== chromeVersion) {
    fail(`the XPI version ${manifest.version} does not match the Chrome manifest ${chromeVersion}`);
  }
  if (entries.has("manifest.firefox.json")) fail("the XPI still contains manifest.firefox.json");
  const leaked = excludedFiles.filter(name => entries.has(name));
  if (leaked.length > 0) fail(`the XPI contains Chrome-only files: ${leaked.join(", ")}`);
  for (const name of ["LICENSE", "SOURCE.json", "SOURCE.txt", "privacy.md", "THIRD_PARTY_NOTICES.md"]) {
    if (!entries.has(name)) fail(`the XPI lacks ${name}`);
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [path, ...rest] = process.argv.slice(2);
    if (!path || rest.length > 0) fail("usage: node scripts/verify-firefox-package.mjs <xpi>");
    const [archive, packageJson, chromeManifest] = await Promise.all([
      readFile(resolve(path)),
      readFile(resolve(ROOT, "scripts/firefox-package.json"), "utf8"),
      readFile(resolve(ROOT, "extension/manifest.json"), "utf8"),
    ]);
    const manifest = verifyFirefoxPackage(zipEntries(archive), {
      excludedFiles: JSON.parse(packageJson).excludedFiles,
      chromeVersion: JSON.parse(chromeManifest).version,
    });
    console.log(`${path}: Firefox ${manifest.version}, manifest_version ${manifest.manifest_version}, no Chrome-only files`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
