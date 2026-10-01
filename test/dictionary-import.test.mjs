// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REVISION_COMPONENTS,
  MAX_REVISION_COMPONENT_LENGTH,
  MAX_REVISION_LENGTH,
  compareDictionaryRevisions,
  dictionaryImportMatches,
  mdxImportNotes,
} from "../extension/dictionary-import.js";
import {
  BoundedIndexWriter,
  MAX_PREFLIGHT_INDEX_BYTES,
  readDictionaryArchiveIdentity,
} from "../extension/dictionary-import-archive.js";
import {
  buildMisdeclaredOversizedIndexZip,
  buildTitledZip,
} from "./make-fixture.mjs";

test("bounded numeric revision comparison handles higher, same, lower, and uncomparable values", () => {
  assert.equal(compareDictionaryRevisions("2026.09.05.1", "2026.09.05"), "higher");
  assert.equal(compareDictionaryRevisions("2.0.0", "0002"), "same");
  assert.equal(compareDictionaryRevisions("9.99", "10"), "lower");
  for (const value of [null, "", "v2", "2-beta", "２", "1..2"]) {
    assert.equal(compareDictionaryRevisions(value, "1"), "uncomparable");
  }
  assert.equal(
    compareDictionaryRevisions(
      Array(MAX_REVISION_COMPONENTS + 1).fill("1").join("."),
      "1",
    ),
    "uncomparable",
  );
  assert.equal(
    compareDictionaryRevisions(`${"1".repeat(MAX_REVISION_COMPONENT_LENGTH + 1)}`, "1"),
    "uncomparable",
  );
  assert.equal(
    compareDictionaryRevisions("1".repeat(MAX_REVISION_LENGTH + 1), "1"),
    "uncomparable",
  );
});

test("MDX import notes word each non-zero loss count, singular or plural, in a fixed order", () => {
  assert.deepEqual(mdxImportNotes({
    skippedRecordCount: 1,
    unresolvedRedirectCount: 1,
    missingResourceCount: 1,
    unreadableResourceCount: 1,
  }), [
    "1 definition record could not be read and was skipped. "
      + "The imported dictionary is incomplete; try another copy of the .mdx file.",
    "1 redirect alias could not be resolved. "
      + "These aliases may not appear in search results; their target definitions may still be available.",
    "1 referenced resource was not included. Choose the .mdx together with all of its .mdd files "
      + "to include available images and styles. This does not count missing definitions.",
    "1 resource in the .mdd files could not be read. "
      + "Some images or styles are missing. Check that every .mdd belongs to this dictionary and is complete.",
  ]);
  assert.deepEqual(mdxImportNotes({
    unreadableResourceCount: 3,
    missingResourceCount: 1200,
    unresolvedRedirectCount: 2,
    skippedRecordCount: 4,
  }, new Intl.NumberFormat("en-US")).map(note => note.slice(0, note.indexOf("."))), [
    "4 definition records could not be read and were skipped",
    "2 redirect aliases could not be resolved",
    "1,200 referenced resources were not included",
    "3 resources in the ",
  ]);
  // A Yomitan ZIP reports zeros, and an older engine reply has no counts.
  for (const report of [{
    skippedRecordCount: 0, unresolvedRedirectCount: 0, missingResourceCount: 0, unreadableResourceCount: 0,
  }, { termCount: 8 }, {}, null, { missingResourceCount: -1 }, { missingResourceCount: "2" }]) {
    assert.deepEqual(mdxImportNotes(report), []);
  }
});

test("interactive matching prefers exact canonical titles and keeps byte-distinct titles separate", () => {
  const dictionaries = [
    { id: "exact", title: "Café", indexUrl: "https://example.invalid/shared.json" },
    { id: "decomposed", title: "Cafe\u0301", indexUrl: "https://example.invalid/other.json" },
    { id: "source", title: "Renamed source", indexUrl: "https://example.invalid/shared.json" },
  ];
  assert.deepEqual(
    dictionaryImportMatches({
      title: "Café", revision: "2", indexUrl: "https://example.invalid/shared.json", downloadUrl: null,
    }, dictionaries).map(match => [match.dictionary.id, match.kind]),
    [["exact", "title"]],
  );
  assert.deepEqual(
    dictionaryImportMatches({
      title: "New publisher title", revision: "2", indexUrl: "https://example.invalid/shared.json", downloadUrl: null,
    }, dictionaries).map(match => [match.dictionary.id, match.kind]),
    [["exact", "source"], ["source", "source"]],
  );
  assert.deepEqual(
    dictionaryImportMatches({
      title: "Cafe\u0301", revision: "2", indexUrl: null, downloadUrl: null,
    }, dictionaries).map(match => match.dictionary.id),
    ["decomposed"],
  );
});

test("preflight reads exact versioned Yomitan identity without importing banks", async () => {
  const identity = await readDictionaryArchiveIdentity(new Blob([buildTitledZip("Versioned", {
    revision: "2026.09.17.2",
    indexUrl: "https://example.invalid/versioned/index.json",
    downloadUrl: "https://example.invalid/versioned/archive.zip",
    rawTermBank: "{this bank is deliberately corrupt",
  })]));
  assert.deepEqual(identity, {
    title: "Versioned",
    revision: "2026.09.17.2",
    indexUrl: "https://example.invalid/versioned/index.json",
    downloadUrl: "https://example.invalid/versioned/archive.zip",
  });
});

test("preflight rejects both declared and actually extracted index data above its hard byte bound", async () => {
  const declared = new Blob([buildTitledZip("Oversized", {
    indexOverrides: { padding: "x".repeat(MAX_PREFLIGHT_INDEX_BYTES + 1) },
  })]);
  await assert.rejects(readDictionaryArchiveIdentity(declared), /exceeds 1048576 bytes/u);

  const misdeclared = new Blob([
    buildMisdeclaredOversizedIndexZip(MAX_PREFLIGHT_INDEX_BYTES + 1, 1024),
  ]);
  // zip.js itself can reject the false declared size before delivering all
  // output. The writer used by the read path independently enforces actual
  // chunks, so extraction remains bounded even without that library check.
  await assert.rejects(
    readDictionaryArchiveIdentity(misdeclared),
    /(?:exceeds 1048576 bytes|Invalid uncompressed size)/u,
  );
  const writer = new BoundedIndexWriter(4);
  writer.writeUint8Array(new Uint8Array([1, 2, 3]));
  assert.throws(
    () => writer.writeUint8Array(new Uint8Array([4, 5])),
    /exceeds 4 bytes/u,
  );
});
