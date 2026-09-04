import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { crc32 } from "node:zlib";

import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_TITLE,
  appendCustomDictionaryEntry,
  buildCustomDictionaryZip,
  customDictionarySemanticRevision,
  parseCustomDictionary,
  serializeCustomDictionaryEntry,
} from "../extension/custom-dictionary.js";

test("custom source preserves ordered duplicates and reports every malformed line", () => {
  const source = [
    "\ufeff# personal entries",
    "",
    "# another comment",
    "   # indented comment",
    " \u98df\u3079\u308b , \u305f\u3079\u308b , first, with, commas ",
    "\u98df\u3079\u308b,\u305f\u3079\u308b,first, with, commas",
    "missing commas",
    "one,comma",
    ",reading,definition",
    "term,,definition",
    "term,reading,",
    "escaped,\u3048\u3059\u3051\u30fc\u3077,line 1\\nline 2",
    "literal,\u308a\u3066\u3089\u308b,line 1\\\\nline 2",
  ].join("\r\n");

  const parsed = parseCustomDictionary(source);
  assert.deepEqual(parsed.entries, [
    { term: "\u98df\u3079\u308b", reading: "\u305f\u3079\u308b", definition: "first, with, commas" },
    { term: "\u98df\u3079\u308b", reading: "\u305f\u3079\u308b", definition: "first, with, commas" },
    { term: "escaped", reading: "\u3048\u3059\u3051\u30fc\u3077", definition: "line 1\nline 2" },
    { term: "literal", reading: "\u308a\u3066\u3089\u308b", definition: "line 1\\nline 2" },
  ]);
  assert.deepEqual(parsed.errors.map(({ lineNumber, reason }) => [lineNumber, reason]), [
    [7, "expected two commas"],
    [8, "expected two commas"],
    [9, "term is empty"],
    [10, "reading is empty"],
    [11, "definition is empty"],
  ]);
  assert.equal(source.startsWith("\ufeff#"), true, "parsing must not mutate the source document");
});

test("custom entry serialization is the exact inverse of definition escapes", () => {
  const cases = [
    ["newline", "line 1\nline 2", "line 1\nline 2"],
    ["line ending normalization", "a\r\nb\rc", "a\nb\nc"],
    ["literal backslash n", "literal \\n marker", "literal \\n marker"],
    ["two backslashes before n", "two \\\\n markers", "two \\\\n markers"],
    ["backslash then newline", `slash ${"\\"}\nnext`, `slash ${"\\"}\nnext`],
    ["unknown escape", "unknown \\q", "unknown \\q"],
    ["trailing backslash", "trail \\ ", "trail \\"],
  ];

  for (const [label, definition, expected] of cases) {
    const serialized = serializeCustomDictionaryEntry({
      term: " \u8a9e ",
      reading: " \u3054 ",
      definition,
    });
    assert.deepEqual(
      parseCustomDictionary(serialized).entries,
      [{ term: "\u8a9e", reading: "\u3054", definition: expected }],
      label,
    );
  }

  assert.equal(
    serializeCustomDictionaryEntry({
      term: "\u98df\u3079\u308b",
      reading: "\u305f\u3079\u308b",
      definition: "first\nsecond\\nthird, fourth",
    }),
    "\u98df\u3079\u308b, \u305f\u3079\u308b, first\\nsecond\\\\nthird, fourth",
  );

  const long = {
    term: "\u9577".repeat(5_000),
    reading: "\u306a".repeat(3_000),
    definition: "definition ".repeat(3_000).trim(),
  };
  assert.deepEqual(parseCustomDictionary(serializeCustomDictionaryEntry(long)).entries, [long]);

  for (const entry of [
    { term: "", reading: "a", definition: "b" },
    { term: "# comment", reading: "a", definition: "b" },
    { term: "a,b", reading: "a", definition: "b" },
    { term: "a\nb", reading: "a", definition: "b" },
    { term: "a", reading: "", definition: "b" },
    { term: "a", reading: "b,c", definition: "d" },
    { term: "a", reading: "b\nc", definition: "d" },
    { term: "a", reading: "b", definition: "" },
  ]) {
    assert.throws(() => serializeCustomDictionaryEntry(entry), TypeError);
  }
});

test("custom append preserves the source newline convention", () => {
  const entry = { term: "new", reading: "\u306b\u3085\u30fc", definition: "line 1\nline 2" };
  const row = "new, \u306b\u3085\u30fc, line 1\\nline 2";

  assert.equal(appendCustomDictionaryEntry("", entry), `${row}\n`);
  assert.equal(appendCustomDictionaryEntry("a, b, c", entry), `a, b, c\n${row}\n`);
  assert.equal(appendCustomDictionaryEntry("a, b, c\n", entry), `a, b, c\n${row}\n`);
  assert.equal(appendCustomDictionaryEntry("a, b, c\r\n", entry), `a, b, c\r\n${row}\r\n`);
  assert.equal(
    appendCustomDictionaryEntry("a, b, c\nb, c, d\r\n", entry),
    `a, b, c\nb, c, d\r\n${row}\r\n`,
  );
});

test("semantic revision depends only on the ordered valid entries", async () => {
  const left = parseCustomDictionary([
    "# source A",
    " \u98df\u3079\u308b , \u305f\u3079\u308b , to eat ",
    "broken",
    "\u8d70\u308b,\u306f\u3057\u308b,to run",
  ].join("\n")).entries;
  const right = parseCustomDictionary([
    "\u98df\u3079\u308b, \u305f\u3079\u308b, to eat",
    "",
    "# source B",
    "\u8d70\u308b, \u306f\u3057\u308b, to run",
  ].join("\r\n")).entries;
  const expected = createHash("sha256").update(JSON.stringify(left), "utf8").digest("hex");

  assert.equal(await customDictionarySemanticRevision(left), expected);
  assert.equal(await customDictionarySemanticRevision(right), expected);
  assert.match(expected, /^[0-9a-f]{64}$/u);
  assert.notEqual(
    await customDictionarySemanticRevision([...left].reverse()),
    expected,
  );
  assert.notEqual(
    await customDictionarySemanticRevision([...left, left[0]]),
    expected,
  );
});

function readClassicZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decode = new TextDecoder();
  const eocdOffset = bytes.byteLength - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint16(eocdOffset + 4, true), 0);
  assert.equal(view.getUint16(eocdOffset + 6, true), 0);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  assert.equal(diskEntries, entryCount);
  assert.equal(view.getUint16(eocdOffset + 20, true), 0);
  assert.equal(centralOffset + centralSize, eocdOffset);

  const files = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint16(offset + 4, true), 20);
    assert.equal(view.getUint16(offset + 6, true), 20);
    assert.equal(view.getUint16(offset + 8, true), 0x0800);
    assert.equal(view.getUint16(offset + 10, true), 0);
    assert.equal(view.getUint16(offset + 12, true), 0);
    assert.equal(view.getUint16(offset + 14, true), 0x21);
    const expectedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true);
    const extraSize = view.getUint16(offset + 30, true);
    const commentSize = view.getUint16(offset + 32, true);
    assert.equal(compressedSize, size);
    assert.equal(extraSize, 0);
    assert.equal(commentSize, 0);
    assert.equal(view.getUint16(offset + 34, true), 0);
    assert.equal(view.getUint16(offset + 36, true), 0);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decode.decode(bytes.subarray(offset + 46, offset + 46 + nameSize));

    assert.equal(view.getUint32(localOffset, true), 0x04034b50);
    assert.equal(view.getUint16(localOffset + 4, true), 20);
    assert.equal(view.getUint16(localOffset + 6, true), 0x0800);
    assert.equal(view.getUint16(localOffset + 8, true), 0);
    assert.equal(view.getUint16(localOffset + 10, true), 0);
    assert.equal(view.getUint16(localOffset + 12, true), 0x21);
    assert.equal(view.getUint32(localOffset + 14, true), expectedCrc);
    assert.equal(view.getUint32(localOffset + 18, true), size);
    assert.equal(view.getUint32(localOffset + 22, true), size);
    assert.equal(view.getUint16(localOffset + 26, true), nameSize);
    assert.equal(view.getUint16(localOffset + 28, true), 0);
    assert.equal(
      decode.decode(bytes.subarray(localOffset + 30, localOffset + 30 + nameSize)),
      name,
    );
    const dataStart = localOffset + 30 + nameSize;
    const data = bytes.subarray(dataStart, dataStart + size);
    assert.equal(crc32(data) >>> 0, expectedCrc, `${name} CRC`);
    files.set(name, JSON.parse(decode.decode(data)));
    offset += 46 + nameSize;
  }
  assert.equal(offset, eocdOffset);
  return files;
}

test("custom builder emits a deterministic format-3 ZIP in 1000-row banks", async () => {
  const entries = Array.from({ length: 1_001 }, (_, index) => ({
    term: index === 0 ? "\u591a\u8a00\u8a9e" : index === 1 ? "duplicate" : `term-${index}`,
    reading: index === 0 ? "\u305f\u3052\u3093\u3054" : `reading-${index}`,
    definition: index === 0
      ? "first line\nsecond line"
      : index === 1 || index === 2
        ? `duplicate definition ${index}`
        : `definition ${index}`,
  }));
  entries[2] = { ...entries[1], definition: "duplicate definition 2" };
  const revision = await customDictionarySemanticRevision(entries);
  const first = buildCustomDictionaryZip(entries, revision);
  const second = buildCustomDictionaryZip(entries, revision);

  assert.ok(first instanceof Uint8Array);
  assert.deepEqual(first, second);
  const files = readClassicZip(first);
  assert.deepEqual([...files.keys()], ["index.json", "term_bank_1.json", "term_bank_2.json"]);
  assert.deepEqual(files.get("index.json"), {
    title: CUSTOM_DICTIONARY_TITLE,
    format: 3,
    revision,
    sequenced: true,
    author: "Hachidori",
    description: "Personal entries managed by Hachidori",
    sourceLanguage: "ja",
    targetLanguage: "en",
  });
  const firstBank = files.get("term_bank_1.json");
  const secondBank = files.get("term_bank_2.json");
  assert.equal(firstBank.length, 1_000);
  assert.equal(secondBank.length, 1);
  assert.deepEqual(firstBank[0], ["\u591a\u8a00\u8a9e", "\u305f\u3052\u3093\u3054", "", "", 0, ["first line\nsecond line"], 1, ""]);
  assert.deepEqual(firstBank[1], ["duplicate", "reading-1", "", "", 0, ["duplicate definition 1"], 2, ""]);
  assert.deepEqual(firstBank[2], ["duplicate", "reading-1", "", "", 0, ["duplicate definition 2"], 3, ""]);
  assert.deepEqual(secondBank[0], ["term-1000", "reading-1000", "", "", 0, ["definition 1000"], 1_001, ""]);
  assert.notEqual(CUSTOM_DICTIONARY_ID, CUSTOM_DICTIONARY_TITLE);
  assert.throws(() => buildCustomDictionaryZip([], revision), /at least one entry/u);
});
