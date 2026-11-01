// SPDX-License-Identifier: GPL-3.0-or-later
//
// The language registry (docs/languages.md 9.1 and 18): extension/vendor/
// languages/ is what scripts/sync-languages.mjs makes of the submodule's
// packs, its class fields and display transforms are expanded by hoshidicts'
// tools/lib/classes.mjs and agree with each pack's engine expectation table,
// registry-reader.js fits its budget, the host blocks are valid, and both
// scripts load as classic scripts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import {
  HOSHIDICTS, READER_BUDGET_BYTES, committedLanguageFiles, languageFiles, packCodes, personalDictionary,
} from "../scripts/sync-languages.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { ClassSet, rangesOfSource } = await import(pathToFileURL(join(HOSHIDICTS, "tools/lib/classes.mjs")).href);

// A hoshidicts tree of its own around the tools' fixture pack, so the
// expansion is checked whatever packs the submodule has.
const fixtureRoot = mkdtempSync(join(tmpdir(), "hachidori-language-packs-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
cpSync(join(HOSHIDICTS, "tools/lib/classes.mjs"), join(fixtureRoot, "tools/lib/classes.mjs"), { recursive: true });
cpSync(join(HOSHIDICTS, "tools/test/fixtures/languages/xx"), join(fixtureRoot, "languages/xx"), { recursive: true });
cpSync(join(HOSHIDICTS, "languages/_template"), join(fixtureRoot, "languages/_template"), { recursive: true });
// Hachidori's Arabic fixture pack has a display setting.
cpSync(join(ROOT, "test/data/languages/ar"), join(fixtureRoot, "languages/ar"), { recursive: true });

// The registry a script sets, with its descriptors copied into this realm.
function loadRegistry(source, globals = {}) {
  const context = { ...globals };
  vm.runInNewContext(source, context);
  const registry = context.HDLanguages;
  if (registry === globals.HDLanguages) return registry;
  return { version: registry.version, codes: [...registry.codes],
    get: code => (registry.get(code) === null ? null : JSON.parse(JSON.stringify(registry.get(code)))) };
}

test("extension/vendor/languages/ is what the submodule gives", async () => {
  const expected = await languageFiles();
  const committed = committedLanguageFiles();
  assert.deepEqual([...committed.keys()].sort(), [...expected.keys()].sort(),
    "run node scripts/sync-languages.mjs and commit extension/vendor/languages/");
  for (const [path, text] of expected) assert.equal(committed.get(path), text, `${path} is stale`);
  for (const code of packCodes()) {
    assert.equal(committed.get(`${code}/language.json`), readFileSync(join(HOSHIDICTS, "languages", code, "language.json"), "utf8"));
  }
});

test("registry-reader.js stays within its budget for every pack together", () => {
  const reader = readFileSync(join(ROOT, "extension/vendor/languages/registry-reader.js"));
  assert.ok(reader.byteLength <= READER_BUDGET_BYTES, `${reader.byteLength} bytes`);
  assert.equal(READER_BUDGET_BYTES, 64 * 1024);
});

test("both scripts load as classic scripts; the reader's copy leaves a fuller registry in place", () => {
  const registry = loadRegistry(readFileSync(join(ROOT, "extension/vendor/languages/registry.js"), "utf8"));
  assert.equal(registry.version, 1);
  assert.deepEqual([...registry.codes], packCodes());
  assert.equal(registry.get("zz"), null);
  const fuller = { version: 1, codes: ["fuller"], get: () => null };
  const kept = loadRegistry(readFileSync(join(ROOT, "extension/vendor/languages/registry-reader.js"), "utf8"),
    { HDLanguages: fuller });
  assert.equal(kept, fuller);
});

test("class fields and display transforms are expanded by hoshidicts' classes.mjs", async () => {
  const files = await languageFiles({ hoshidicts: fixtureRoot, commit: "fixture" });
  assert.deepEqual([...files.keys()].sort(), ["ar/language.json", "ar/transforms.json", "registry-reader.js", "registry.js",
    "xx/language.json", "xx/transforms.json"], "packs are directories without a leading _");
  const arabic = loadRegistry(files.get("registry-reader.js")).get("ar");
  assert.deepEqual(arabic.settings, [{ id: "vowelMarks", type: "enum", default: "show",
    effect: { display: { fields: ["expression", "reading"], when: "hide", transform: "stripVowelMarks" } } }]);
  assert.deepEqual(arabic.presentation.displayTransforms.stripVowelMarks,
    [{ strip: new ClassSet(JSON.parse(files.get("ar/language.json")).classes).source("{harakat}") }]);
  const pack = JSON.parse(files.get("xx/language.json"));
  const classes = new ClassSet(pack.classes);
  const entry = loadRegistry(files.get("registry.js")).get("xx");
  const readerEntry = loadRegistry(files.get("registry-reader.js")).get("xx");
  for (const descriptor of [entry, readerEntry]) {
    assert.equal(descriptor.text.pattern, classes.source(pack.text.pattern));
    assert.equal(descriptor.text.wordCharacters, classes.source(pack.text.wordCharacters));
    // Every {name} is expanded; \p{...} general categories stay.
    assert.doesNotMatch(`${descriptor.text.pattern}${descriptor.text.wordCharacters}`, /(?<!\\p)\{[A-Za-z_]\w*\}/u,
      "no class reference is left");
    assert.equal(descriptor.code, "xx");
    assert.equal(descriptor.direction, pack.direction);
    assert.deepEqual(descriptor.capabilities.readings, pack.capabilities.readings);
    for (const [name, steps] of Object.entries(pack.presentation.displayTransforms ?? {})) {
      assert.deepEqual(descriptor.presentation.displayTransforms[name], classes.expandSteps(steps));
    }
  }
  // The engine's expectation table agrees with the expanded patterns.
  const expectations = JSON.parse(readFileSync(join(fixtureRoot, "languages/xx/tests/classes.json"), "utf8"));
  assert.deepEqual(rangesOfSource(entry.text.pattern), expectations.fields["text.pattern"]);
  assert.deepEqual(rangesOfSource(entry.text.wordCharacters), expectations.fields["text.wordCharacters"]);
  assert.deepEqual(entry.personalDictionary, personalDictionary(pack));
  assert.equal(Object.hasOwn(readerEntry, "personalDictionary"), false, "the reader's copy holds only what the reader uses");
  assert.ok(readerEntry.settings.every(setting => setting.effect?.display !== undefined || setting.effect?.capability !== undefined));
  for (const setting of readerEntry.settings) assert.deepEqual(Object.keys(setting).sort(), ["default", "effect", "id", "type"]);
});

test("every shipped pack's classes agree with its engine expectation table and its host block is valid", () => {
  const registry = loadRegistry(readFileSync(join(ROOT, "extension/vendor/languages/registry.js"), "utf8"));
  const families = new Set(["kiku", "lapis", "senren"]);
  for (const code of registry.codes) {
    const descriptor = registry.get(code);
    const table = join(HOSHIDICTS, "languages", code, "tests/classes.json");
    if (existsSync(table)) {
      const expectations = JSON.parse(readFileSync(table, "utf8"));
      assert.deepEqual(rangesOfSource(descriptor.text.pattern), expectations.fields["text.pattern"], `${code} text.pattern`);
    }
    assert.match(descriptor.host.ttsLanguage, /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/u, `${code} ttsLanguage`);
    assert.equal(typeof descriptor.host.audioLanguage, "string", `${code} audioLanguage`);
    assert.ok(descriptor.host.anki.noteTypeFamilies.every(family => families.has(family)), `${code} note-type families`);
    assert.equal(typeof descriptor.host.sample.warmup, "string", `${code} warm-up sample`);
    assert.ok(["ltr", "rtl"].includes(descriptor.direction), `${code} direction`);
  }
});

test("a pack's personal dictionary id is the first 32 hexadecimal digits of SHA-256", () => {
  assert.deepEqual(personalDictionary({ code: "ja", name: "Japanese" }),
    { id: "e4c2e20a1a964b6cbd4ae3f87643c1f0", title: "Hachidori Custom Dictionary" });
  const english = personalDictionary({ code: "en", name: "English" });
  assert.equal(english.id, createHash("sha256").update("hachidori-custom-dictionary:en").digest("hex").slice(0, 32));
  assert.equal(english.title, "Hachidori Custom Dictionary (English)");
});
