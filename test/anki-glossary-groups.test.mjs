// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnkiFields } from "../extension/anki-values.js";
import { ankiTemplateErrors } from "../extension/anki-templates.js";
import "../extension/reader-options.js";

const row = dictionary => ({ dictionary, glossary: '["definition"]', definitionTags: "", termTags: "" });
const request = patch => ({ term: { expression: "猫", reading: "ねこ", rules: "", frequencies: [], pitches: [],
  glossaries: [row("Bilingual"), row("Mono B"), row("Mono A"), row("Mono A")] },
  trace: [], sentence: "猫だ。", matchOffset: 0, matched: "猫", dictionaryAliases: {},
  dictionaryIds: { Bilingual: "bi", "Mono B": "b", "Mono A": "a" }, frequencyDictionaries: [],
  glossaryGroups: [{ id: "mono", dictionaryIds: ["a", "b"] }, { id: "bi", dictionaryIds: ["bi"] }],
  monolingualGroupId: "mono", bilingualGroupId: "bi", glossarySelectionFallback: "first-brief", ...patch });
const fields = async (source, value) => buildAnkiFields(source, { Back: { value, overwriteMode: "coalesce" } }, {
  definition: options => JSON.stringify(options),
});

test("group glossary markers use group order, constrain selection and retain an exact selected row", async () => {
  const marker = "{glossary-selection-group-mono}";
  assert.deepEqual(ankiTemplateErrors(marker), []);
  assert.deepEqual(JSON.parse((await fields(request(), marker)).Back), {
    selectedOnly: true, selection: { dictionary: "Mono A", index: 0 }, brief: true,
  });
  const selection = { dictionary: "Mono A", index: 1,
    ranges: [{ path: ["glossary", 0], start: 0, end: 3 }] };
  assert.deepEqual(JSON.parse((await fields(request({ glossarySelection: selection }), marker)).Back), {
    selectedOnly: true, selection, brief: true,
  });
  assert.deepEqual(JSON.parse((await fields(request({ glossarySelection: { dictionary: "Bilingual", index: 0 } }), marker)).Back), {
    selectedOnly: true, selection: { dictionary: "Mono A", index: 0 }, brief: true,
  });
});

test("named mono/bilingual markers use explicit Template groups and never leak across missing groups", async () => {
  const result = await fields(request({ glossarySelectionFallback: "first" }),
    "{monolingual-definition}|{bilingual-definition}");
  const [mono, bi] = result.Back.split("|").map(JSON.parse);
  assert.deepEqual(mono, { selectedOnly: true, selection: { dictionary: "Mono A", index: 0 }, brief: false });
  assert.deepEqual(bi, { selectedOnly: true, selection: { dictionary: "Bilingual", index: 0 }, brief: false });
  for (const patch of [{ monolingualGroupId: "" }, { glossaryGroups: [] },
    { glossaryGroups: [{ id: "mono", dictionaryIds: ["missing"] }] }]) {
    assert.equal((await fields(request(patch), "{monolingual-definition}")).Back, "");
  }
  assert.equal((await fields(request(), "{glossary-selection-group-deleted}")).Back, "");
});

test("Anki group choices normalize, reject invalid writes and preserve legacy Template records", () => {
  const options = globalThis.HDReaderOptions;
  const legacy = structuredClone(options.DEFAULT_OPTIONS.anki);
  for (const value of [legacy, ...legacy.templates]) {
    delete value.glossarySelectionFallback;
    delete value.monolingualGroupId;
    delete value.bilingualGroupId;
  }
  assert.doesNotThrow(() => options.validateOptionsPatch({ anki: legacy }));
  const normal = options.normaliseAnki(legacy);
  assert.equal(normal.glossarySelectionFallback, "first-brief");
  assert.equal(normal.monolingualGroupId, "");
  assert.equal(normal.bilingualGroupId, "");
  normal.templates[0].monolingualGroupId = "mono";
  normal.templates[0].bilingualGroupId = "bi";
  normal.templates[0].glossarySelectionFallback = "first";
  const edited = options.normaliseAnki({ url: normal.url, apiKey: normal.apiKey, templates: normal.templates });
  assert.doesNotThrow(() => options.validateOptionsPatch({ anki: edited }));
  assert.equal(options.ankiTemplateConfig(edited).monolingualGroupId, "mono");
  edited.templates[0].glossarySelectionFallback = "all-dictionaries";
  assert.throws(() => options.validateOptionsPatch({ anki: edited }), /anki/iu);
});
