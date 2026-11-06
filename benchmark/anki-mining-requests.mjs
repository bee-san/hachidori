// SPDX-License-Identifier: GPL-3.0-or-later
// Compare production mining services against the same isolated fake endpoint.
// --source selects a checkout with test/anki-request-fixture.mjs copied into it.
// This measures injected transport cost and local JS, not a real Anki profile,
// browser capture/rendering, dictionary reads or audio-provider download time.
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
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const results = [];
for (const [audio, screenshot] of [[false, false], [false, true], [true, true]]) {
  const samples = [];
  for (let run = -2; run < runs; run++) {
    const f = ankiRequestFixture({ audio, screenshot, delay });
    const request = await f.request(); // Exclude one-time metadata discovery.
    f.calls.length = 0;
    const start = performance.now();
    const [ready] = await f.service.preflightMany([request]);
    const checked = performance.now();
    if (!ready.canAdd) throw new Error("Fixture note is not addable");
    const duplicateRequests = f.calls.length;
    f.calls.length = 0;
    if (screenshot) request.screenshot = await f.capture();
    const added = await f.service.submit(request);
    if (added.state !== "added" || added.warnings.length) throw new Error(JSON.stringify(added));
    if (run >= 0) samples.push({ duplicateMs: checked - start, addMs: performance.now() - checked,
      duplicateRequests, addRequests: f.calls.length });
  }
  results.push({ audio, screenshot, samples,
    duplicateMedianMs: percentile(samples.map(sample => sample.duplicateMs), 0.5),
    duplicateP95Ms: percentile(samples.map(sample => sample.duplicateMs), 0.95),
    addMedianMs: percentile(samples.map(sample => sample.addMs), 0.5),
    addP95Ms: percentile(samples.map(sample => sample.addMs), 0.95),
  });
}
console.log(JSON.stringify({ commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  node: process.version, os: `${platform()}/${arch()}`, cpu: cpus()[0]?.model, runs, delay,
  input: "one new word, model scope, no dictionary images; fresh index per sample; metadata discovery excluded",
  results }, null, 2));
