// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ANKI_ADDON_FILES, ANKI_ADDON_FILE_NAME, buildAnkiAddon } from "../extension/anki-addon.js";
import { BlobReader, TextWriter, ZipReader } from "../extension/vendor/zip.js";

const read = name => readFileSync(new URL(`../extension/anki-relay/${name}`, import.meta.url), "utf8");

test("the add-on archive holds the add-on's files, with the manifest versioned, and Python reads it back", async (t) => {
  const built = await buildAnkiAddon(read, { version: "0.1.0", now: 1_757_000_000_500 });
  const reader = new ZipReader(new BlobReader(built));
  const entries = await reader.getEntries();
  assert.deepEqual(entries.map(entry => entry.filename), ANKI_ADDON_FILES);
  for (const entry of entries) {
    const text = await entry.getData(new TextWriter());
    if (entry.filename !== "manifest.json") {
      assert.equal(text, read(entry.filename), entry.filename);
      continue;
    }
    const manifest = JSON.parse(text);
    assert.equal(manifest.package, "hachidori-relay");
    assert.equal(manifest.name, "Hachidori Relay");
    assert.equal(manifest.human_version, "0.1.0");
    assert.equal(manifest.mod, 1_757_000_000);
  }
  await reader.close();

  const again = await buildAnkiAddon(read, { version: "0.1.0", now: 1_757_000_000_500 });
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), new Uint8Array(await built.arrayBuffer()), "the same sources give the same bytes");

  // Anki extracts the file with Python's zipfile; so does this.
  const directory = mkdtempSync(join(tmpdir(), "hachidori-addon-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, ANKI_ADDON_FILE_NAME);
  writeFileSync(file, new Uint8Array(await built.arrayBuffer()));
  const listed = execFileSync("python3", ["-c", [
    "import json, sys, zipfile",
    "archive = zipfile.ZipFile(sys.argv[1])",
    "assert archive.testzip() is None",
    "print(json.dumps([archive.namelist(), json.loads(archive.read('manifest.json'))['package']]))",
  ].join("\n"), file], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(listed), [ANKI_ADDON_FILES, "hachidori-relay"]);
});
