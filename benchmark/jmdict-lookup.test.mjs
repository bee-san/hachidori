// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildTitledZip } from "../test/make-fixture.mjs";

const DRIVER = resolve(import.meta.dirname, "jmdict-lookup.mjs");

test("a resumed JMdict run numbers a cell's attempts after the failed ones it keeps", () => {
  const root = mkdtempSync(join(tmpdir(), "hdw-jmdict-resume-"));
  try {
    const dictionary = join(root, "dictionary.zip");
    writeFileSync(dictionary, buildTitledZip("jmdict-resume"));
    // The output already holds an unpacked Yomitan, so the driver only hashes this file.
    const yomitan = join(root, "yomitan-chrome.zip");
    writeFileSync(yomitan, "unused");
    const output = join(root, "output");
    mkdirSync(join(output, "yomitan-extension"), { recursive: true });
    writeFileSync(join(output, "yomitan-extension", "manifest.json"), JSON.stringify({ version: "0.0.0" }));
    // Every attempt fails at launch, so no browser starts and the first cell uses up its attempts.
    const puppeteer = join(root, "puppeteer.mjs");
    writeFileSync(puppeteer, 'export function launch() { throw new Error("no browser in this test"); }\n');
    const env = { ...process.env, HACHIDORI_CHROME: process.execPath, HACHIDORI_PUPPETEER: puppeteer };
    const runDriver = () => spawnSync(process.execPath, [
      DRIVER, "--jmdict", dictionary, "--yomitan", yomitan, "--output", output,
      "--warmups", "0", "--samples", "1", "--passes", "1",
    ], { encoding: "utf8", env });
    const attempts = () => readFileSync(join(output, "failures.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line)).map((entry) => [entry.runId, entry.attempt]);

    assert.notEqual(runDriver().status, 0);
    const [[runId]] = attempts();
    assert.deepEqual(attempts(), Array.from({ length: 6 }, (_, attempt) => [runId, attempt]));
    const firstAttempt = [join(output, "hachidori", "runs"), join(output, "runs")]
      .map((directory) => join(directory, `${runId}-attempt-00`))
      .find((directory) => existsSync(directory));
    assert.ok(firstAttempt, "the first failed attempt left no directory");
    writeFileSync(join(firstAttempt, "kept"), "");

    assert.notEqual(runDriver().status, 0);
    assert.deepEqual(attempts(), Array.from({ length: 12 }, (_, attempt) => [runId, attempt]));
    assert.ok(existsSync(join(firstAttempt, "kept")), "the resumed run reused the first failed attempt's directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
