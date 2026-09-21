// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { verifyFirefoxPackage, zipEntries } from "../scripts/verify-firefox-package.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const { excludedFiles } = JSON.parse(await readFile(resolve(ROOT, "scripts/firefox-package.json"), "utf8"));
const firefoxManifest = JSON.parse(await readFile(resolve(ROOT, "extension/manifest.firefox.json"), "utf8"));
const REQUIRED = ["LICENSE", "SOURCE.json", "SOURCE.txt", "privacy.md", "THIRD_PARTY_NOTICES.md"];

// A minimal deterministic ZIP writer: the shape package-store.py emits.
function zip(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const data = store ? raw : deflateRawSync(raw, { level: 9 });
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(store ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function goodPackage(overrides = {}) {
  return {
    "manifest.json": JSON.stringify(firefoxManifest),
    "background.js": "// shared",
    "firefox-background.html": "<!doctype html>",
    ...Object.fromEntries(REQUIRED.map(name => [name, name])),
    ...overrides,
  };
}

test("the release XPI must carry the MV2 manifest, the release files, and no Chrome-only file", () => {
  const options = { excludedFiles, chromeVersion: firefoxManifest.version };
  for (const store of [false, true]) {
    const entries = zipEntries(zip(goodPackage(), { store }));
    assert.equal(verifyFirefoxPackage(entries, options).version, firefoxManifest.version);
    assert.equal(entries.get("background.js")().toString(), "// shared");
  }
  assert.throws(() => verifyFirefoxPackage(zipEntries(zip(goodPackage({ "capture.js": "" }))), options),
    /Chrome-only files: capture\.js/u);
  assert.throws(() => verifyFirefoxPackage(zipEntries(zip(goodPackage({ "vendor/avif-encoder.wasm": "" }))), options),
    /Chrome-only files: vendor\/avif-encoder\.wasm/u);
  assert.throws(() => verifyFirefoxPackage(zipEntries(zip(goodPackage({ "manifest.firefox.json": "{}" }))), options),
    /still contains manifest\.firefox\.json/u);
  assert.throws(() => verifyFirefoxPackage(zipEntries(zip(goodPackage({
    "manifest.json": JSON.stringify({ ...firefoxManifest, manifest_version: 3 }),
  }))), options), /not manifest_version 2/u);
  assert.throws(() => verifyFirefoxPackage(zipEntries(zip(goodPackage({
    "manifest.json": JSON.stringify({ ...firefoxManifest, version: "0.0.1" }),
  }))), options), /does not match the Chrome manifest/u);
  const missing = goodPackage();
  delete missing["SOURCE.txt"];
  assert.throws(() => verifyFirefoxPackage(zipEntries(zip(missing)), options), /lacks SOURCE\.txt/u);
  assert.throws(() => zipEntries(Buffer.from("not a zip")), /not a ZIP archive/u);
});

test("the excluded-file list names only Chrome capture and recording files that exist", async () => {
  assert.deepEqual(excludedFiles, [...excludedFiles].sort(), "sorted for review");
  assert.equal(new Set(excludedFiles).size, excludedFiles.length);
  for (const name of excludedFiles) {
    await assert.doesNotReject(readFile(resolve(ROOT, "extension", name)), name);
    assert.match(name, /^(?:capture|avif-sequence|vendor\/avif-encoder)/u, name);
  }
  const packager = await readFile(resolve(ROOT, "scripts/package-store.py"), "utf8");
  assert.match(packager, /scripts\/firefox-package\.json/u);
  assert.match(packager, /-firefox-unsigned\.xpi/u);
  const prepare = await readFile(resolve(ROOT, "scripts/prepare-firefox.mjs"), "utf8");
  assert.match(prepare, /scripts\/firefox-package\.json/u);
});
