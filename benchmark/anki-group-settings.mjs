// SPDX-License-Identifier: GPL-3.0-or-later
// Production Settings controller work; jsdom does not measure browser layout.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";

const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const root = resolve(argument("--source", "."));
const runs = Number(argument("--runs", 20));
const iterations = 25;
const require = createRequire(resolve(import.meta.dirname, "../test/tooling/package.json"));
const { JSDOM } = require("jsdom");
const { createAnkiSettingsController } = await import(pathToFileURL(resolve(root, "extension/anki-settings.js")));
const dom = new JSDOM(readFileSync(resolve(root, "extension/settings.html"), "utf8"), { runScripts: "outside-only" });
try {
  const { window } = dom;
  window.document.getElementById("anki").hidden = false;
  window.eval(readFileSync(resolve(root, "extension/reader-options.js"), "utf8"));
  const fields = Array.from({ length: 50 }, (_, index) => `Field ${index + 1}`);
  const config = window.HDReaderOptions.normaliseAnki({ model: "Basic", fieldTemplates: Object.fromEntries(fields.map(field =>
    [field, { value: "{expression}", overwriteMode: "coalesce" }])) });
  const groups = Array.from({ length: 20 }, (_, index) => ({ id: `group-${index}`, name: `Group ${index}`, dictionaryIds: [] }));
  const controller = createAnkiSettingsController({ document: window.document, readConfig: () => config,
    editConfig() {}, readGroups: () => groups,
    send: async () => ({ ok: true, connected: true, decks: ["Default"], models: ["Basic"], model: "Basic", fields, errors: [] }),
  });
  controller.render();
  await new Promise(done => setImmediate(done));
  for (let index = 0; index < 25; index++) controller.render();
  const samples = [];
  for (let sample = 0; sample < runs; sample++) {
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) controller.render();
    samples.push((performance.now() - start) / iterations);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(JSON.stringify({ revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version, cpu: cpus()[0].model, fields: fields.length, groups: groups.length, runs, iterations,
    boundary: "Unchanged production Settings controller render per call; excludes discovery, initial DOM construction and browser layout",
    medianMs: sorted[Math.ceil(runs / 2) - 1], p95Ms: sorted[Math.ceil(runs * 0.95) - 1], samples }, null, 2));
} finally { dom.window.close(); }
