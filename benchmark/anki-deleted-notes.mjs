// SPDX-License-Identifier: GPL-3.0-or-later
// Production custom-identity View path, with transport delay and no real collection.
import { execFileSync } from "node:child_process";
import { cpus, platform, arch } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = resolve(option("--source", "."));
const runs = Number(option("--runs", 20));
const delay = Number(option("--delay-ms", 25));
const { ankiRequestFixture } = await import(pathToFileURL(resolve(root, "test/anki-request-fixture.mjs")));
const samples = [];
for (let index = -2; index < runs; index++) {
  const f = ankiRequestFixture({ delay });
  f.options.anki = globalThis.HDReaderOptions.normaliseAnki({ ...f.options.anki,
    fieldTemplates: { Front: { value: "word:{expression}", overwriteMode: "coalesce" } } });
  const request = await f.request();
  const added = await f.service.submit(request);
  if (added.state !== "added") throw new Error(JSON.stringify(added));
  f.calls.length = 0;
  const start = performance.now();
  const browsed = await f.service.browse({ expression: "猫", configKey: request.configKey, noteIds: [added.noteId] });
  if (!browsed.opened) throw new Error("The live disposable note did not open.");
  if (index >= 0) samples.push({ durationMs: performance.now() - start, requests: f.calls.map(call => call.action) });
}
const percentile = fraction => samples.map(sample => sample.durationMs).sort((a, b) => a - b)[Math.ceil(runs * fraction) - 1];
console.log(JSON.stringify({ commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  node: process.version, os: `${platform()}/${arch()}`, cpu: cpus()[0]?.model, runs, delay,
  input: "one live note with a custom first-field identity; discovery and Add excluded; fresh service per sample",
  medianMs: percentile(0.5), p95Ms: percentile(0.95), samples }, null, 2));
