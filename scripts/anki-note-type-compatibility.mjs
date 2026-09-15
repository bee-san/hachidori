// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../extension/reader-options.js";
import {
  ANKI_TEMPLATE_MARKERS,
  ankiPresetCoreMapped,
  ankiTemplateMarkerNames,
  applyAnkiPreset,
} from "../extension/anki-templates.js";

export const contracts = JSON.parse(readFileSync(
  new URL("../test/data/anki-note-types/contracts.json", import.meta.url), "utf8",
));

const availableMarkers = new Set(ANKI_TEMPLATE_MARKERS);
const baseConfig = () => globalThis.HDReaderOptions.normaliseOptions({}).anki;

export function checkModel(contract, model, mapper = applyAnkiPreset) {
  assert.ok(contract.modelNames.includes(model.name), `${contract.id}: unreviewed model name ${model.name}`);
  assert.equal(new Set(model.fields).size, model.fields.length, `${contract.id}: duplicate field`);
  assert.deepEqual(model.fields, Object.keys(contract.expected),
    `${contract.id}: upstream fields or their order changed; review additions, removals, renames and intentional blanks`);
  const mapped = mapper(baseConfig(), model.fields, contract.family);
  assert.deepEqual(Object.keys(mapped.fieldTemplates), model.fields, `${contract.id}: missing or reordered output fields`);
  assert.equal(mapped.fieldTemplates[model.fields[0]].value, "{expression}",
    `${contract.id}: first field is not the word identifier`);
  assert.equal(ankiPresetCoreMapped(mapped.fieldTemplates, contract.family), true,
    `${contract.id}: the package core no longer qualifies for automatic setup`);
  for (const [name, expected] of Object.entries(contract.expected)) {
    const template = mapped.fieldTemplates[name];
    for (const marker of ankiTemplateMarkerNames(template.value)) {
      assert.ok(availableMarkers.has(marker), `${contract.id}.${name}: unsupported marker ${marker}`);
    }
    assert.deepEqual(template, { value: expected, overwriteMode: "coalesce" },
      `${contract.id}.${name}: incorrect field mapping or overwrite mode`);
  }
  return mapped.fieldTemplates;
}

export function checkReport(report) {
  assert.equal(report.results.length, contracts.length, "Missing or extra upstream results");
  assert.equal(new Set(report.results.map(({ id }) => id)).size, contracts.length, "Duplicate result IDs");
  const failures = [];
  for (const contract of contracts) {
    try {
      const result = report.results.find(({ id }) => id === contract.id);
      assert.ok(result, `${contract.id}: result is missing`);
      assert.equal(result.status, "downloaded", `${contract.id}: ${result.error ?? "package was not downloaded"}`);
      assert.ok(Array.isArray(result.models), `${contract.id}: model list is missing`);
      const models = result.models.filter(({ name }) => contract.modelNames.includes(name));
      assert.equal(models.length, 1,
        `${contract.id}: expected exactly one matching note type; found ${result.models.map(({ name }) => name).join(", ")}`);
      checkModel(contract, models[0]);
      console.log(`PASS ${contract.id}: ${result.revision}, ${models[0].fields.length} fields, sha256:${result.sha256}`);
    } catch (error) {
      failures.push(error);
      console.error(String(error));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} upstream mapping contracts failed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3,
    "Usage: node scripts/anki-note-type-compatibility.mjs <download-report.json>");
  checkReport(JSON.parse(readFileSync(process.argv[2], "utf8")));
}
