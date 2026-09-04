// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { normalizeConfig, sha256Canonical } from "./lib.mjs";

const RUNNER = resolve(import.meta.dirname, "run.mjs");

test("benchmark runner documents its reproducible inputs and output", () => {
  const result = spawnSync(process.execPath, [RUNNER, "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--config/);
  assert.match(result.stdout, /--output/);
  assert.match(result.stdout, /fresh Chrome profiles/i);
  assert.match(result.stdout, /close Chrome.*fresh Chrome process/is);
  assert.match(result.stdout, /jitendex-pixiv-light\.json/);
  assert.match(result.stdout, /raw\.jsonl/);
});

test("benchmark defaults follow the current account cache", () => {
  const root = mkdtempSync(join(tmpdir(), "hachidori-portable-browser-"));
  try {
    const cache = join(root, "cache");
    const chrome = join(
      cache,
      "hachidori-browsers",
      "chrome",
      "linux-999.0.0.0",
      "chrome-linux64",
      "chrome",
    );
    const puppeteerRoot = join(cache, "hachidori-e2e", "node_modules", "puppeteer-core");
    const puppeteer = join(puppeteerRoot, "lib", "puppeteer", "puppeteer-core.js");
    const archive = join(root, "dict.zip");
    const config = join(root, "config.json");
    const output = join(root, "output");

    mkdirSync(resolve(chrome, ".."), { recursive: true });
    mkdirSync(resolve(puppeteer, ".."), { recursive: true });
    writeFileSync(chrome, "#!/bin/sh\nexit 0\n");
    chmodSync(chrome, 0o755);
    writeFileSync(
      join(puppeteerRoot, "package.json"),
      JSON.stringify({ name: "puppeteer-core", version: "1.0.0" }),
    );
    writeFileSync(puppeteer, "export const launch = true;\n");
    writeFileSync(archive, "archive bytes");
    writeFileSync(config, JSON.stringify({
      corpora: [{ id: "tiny", archive: "dict.zip" }],
      queries: [{ id: "word", text: "食べる", expect: "hit" }],
      warmups: 0,
      samples: 1,
    }));

    const environment = {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CACHE_HOME: cache,
    };
    delete environment.HACHIDORI_CHROME;
    delete environment.HACHIDORI_PUPPETEER;
    delete environment.CHROME_BIN;
    const result = spawnSync(process.execPath, [
      RUNNER,
      "--config", config,
      "--output", output,
      "--dry-run",
    ], { encoding: "utf8", env: environment });

    assert.equal(result.status, 0, result.stderr);
    const definition = JSON.parse(readFileSync(join(output, "run-definition.json"), "utf8"));
    assert.equal(definition.runtime.chromePath, chrome);
    assert.equal(definition.runtime.puppeteerPath, puppeteer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser harness defaults do not name a developer home directory", () => {
  for (const relativePath of ["run.mjs", "../test/chrome-fallback.mjs"]) {
    const source = readFileSync(resolve(import.meta.dirname, relativePath), "utf8");
    assert.doesNotMatch(source, /\/home\/skerraut\//, relativePath);
  }
});

test("standard suite pins Jitendex and Pixiv Light as separate import cells", () => {
  const suitePath = resolve(import.meta.dirname, "jitendex-pixiv-light.json");
  const raw = JSON.parse(readFileSync(suitePath, "utf8"));
  const config = normalizeConfig(raw, import.meta.dirname, { HACHIDORI_BENCH_DATA: "/bench-data" });

  assert.deepEqual(config.corpora.map((corpus) => corpus.id), ["jitendex", "pixiv-light"]);
  assert.deepEqual(config.corpora.map((corpus) => corpus.archive), [
    "/bench-data/jitendex-yomitan-2026.08.11.0.zip",
    "/bench-data/PixivLight_2026-08-16.zip",
  ]);
  assert.deepEqual(config.corpora.map((corpus) => corpus.expectedSha256), [
    "8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc",
    "50049358e0045c7e97b2916e0eaece7e2ae2ffe89b527ddacbda7641842d6f05",
  ]);
  assert.deepEqual(config.corpora.map((corpus) => corpus.expectedReport.termCount), [435448, 710819]);
  assert.ok(config.corpora.every((corpus) => corpus.expectedDictionaryCount === 1));
  assert.equal(config.warmups, 1);
  assert.equal(config.samples, 5);
  for (const corpus of config.corpora) {
    const selected = config.queries.filter((query) => corpus.queryIds.includes(query.id));
    assert.ok(selected.some((query) => (query.expectByCorpus?.[corpus.id] ?? query.expect) === "hit"));
    assert.ok(selected.some((query) => (query.expectByCorpus?.[corpus.id] ?? query.expect) === "miss"));
  }
});

test("dry run pins config, archive hash, revision, and deterministic schedule without Chrome", () => {
  const root = mkdtempSync(join(tmpdir(), "hdw-bench-runner-"));
  try {
    const archive = join(root, "dict.zip");
    const config = join(root, "config.json");
    const output = join(root, "output");
    writeFileSync(archive, "archive bytes");
    writeFileSync(config, JSON.stringify({
      corpora: [{ id: "tiny", archive: "dict.zip" }],
      queries: [{ id: "word", text: "食べる", expect: "hit" }],
      warmups: 1,
      samples: 2,
    }));

    const result = spawnSync(process.execPath, [
      RUNNER,
      "--config", config,
      "--output", output,
      "--dry-run",
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const definition = JSON.parse(readFileSync(join(output, "run-definition.json"), "utf8"));
    const schedule = JSON.parse(readFileSync(join(output, "schedule.json"), "utf8"));
    assert.equal(definition.config.corpora[0].archiveBytes, 13);
    assert.equal(definition.config.corpora[0].sourceArchive, archive);
    assert.notEqual(definition.config.corpora[0].archive, archive);
    assert.equal(readFileSync(definition.config.corpora[0].archive, "utf8"), "archive bytes");
    assert.match(definition.config.corpora[0].archive, /output[/\\]inputs[/\\][0-9a-f]{64}\.zip$/);
    assert.match(definition.config.corpora[0].archiveSha256, /^[0-9a-f]{64}$/);
    assert.match(definition.revision.repositoryCommit, /^[0-9a-f]{40}$/);
    assert.match(definition.revision.extensionContentSha256, /^[0-9a-f]{64}$/);
    assert.match(definition.revision.hoshidictsContentSha256, /^[0-9a-f]{64}$/);
    assert.match(definition.runtime.chromeExecutableSha256, /^[0-9a-f]{64}$/);
    assert.match(definition.runtime.nodeExecutableSha256, /^[0-9a-f]{64}$/);
    assert.match(definition.runtime.puppeteerTreeSha256, /^[0-9a-f]{64}$/);
    assert.equal(definition.hostIdentity.hostname, definition.hostAtPreparation.hostname);
    assert.equal(schedule.length, 3);
    assert.match(result.stdout, /dry run complete/i);

    const resumed = spawnSync(process.execPath, [
      RUNNER,
      "--config", config,
      "--output", output,
      "--dry-run",
    ], { encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(output, "run-definition.json"), "utf8")),
      definition,
    );

    const inputSnapshotsBefore = readdirSync(join(output, "inputs")).sort();
    writeFileSync(archive, "changed archive bytes");
    const sourceChanged = spawnSync(process.execPath, [
      RUNNER,
      "--config", config,
      "--output", output,
      "--dry-run",
    ], { encoding: "utf8" });
    assert.equal(sourceChanged.status, 2);
    assert.match(sourceChanged.stderr, /different benchmark definition|SHA-256 mismatch|changed identity/i);
    assert.equal(readFileSync(definition.config.corpora[0].archive, "utf8"), "archive bytes");
    assert.deepEqual(readdirSync(join(output, "inputs")).sort(), inputSnapshotsBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume rejects changed Puppeteer bytes at the same path", () => {
  const root = mkdtempSync(join(tmpdir(), "hdw-bench-provenance-"));
  try {
    const archive = join(root, "dict.zip");
    const config = join(root, "config.json");
    const output = join(root, "output");
    const packageRoot = join(root, "puppeteer-core");
    const entry = join(packageRoot, "entry.mjs");
    mkdirSync(packageRoot);
    writeFileSync(archive, "archive bytes");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "puppeteer-core", version: "1.0.0" }));
    writeFileSync(entry, "export const launch = true;\n");
    writeFileSync(config, JSON.stringify({
      corpora: [{ id: "tiny", archive: "dict.zip" }],
      queries: [{ id: "word", text: "食べる", expect: "hit" }],
      warmups: 0,
      samples: 1,
    }));
    const environment = { ...process.env, HACHIDORI_PUPPETEER: entry };
    const first = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output, "--dry-run",
    ], { encoding: "utf8", env: environment });
    assert.equal(first.status, 0, first.stderr);

    writeFileSync(entry, "export const launch = false;\n");
    const resumed = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output, "--dry-run",
    ], { encoding: "utf8", env: environment });
    assert.equal(resumed.status, 2);
    assert.match(resumed.stderr, /different benchmark definition|executable inputs/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed resume preserves completion provenance and checksums", () => {
  const root = mkdtempSync(join(tmpdir(), "hdw-bench-resume-"));
  try {
    const archive = join(root, "dict.zip");
    const config = join(root, "config.json");
    const output = join(root, "output");
    writeFileSync(archive, "archive bytes");
    writeFileSync(config, JSON.stringify({
      corpora: [{
        id: "expected-failure",
        archive: "dict.zip",
        expectedFailureIncludes: "synthetic failure",
      }],
      queries: [{ id: "word", text: "食べる", expect: "hit" }],
      warmups: 0,
      samples: 1,
    }));

    const dryRun = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output, "--dry-run",
    ], { encoding: "utf8" });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const definition = JSON.parse(readFileSync(join(output, "run-definition.json"), "utf8"));
    const [scheduled] = JSON.parse(readFileSync(join(output, "schedule.json"), "utf8"));
    const syntheticProfile = join(output, "runs", `${scheduled.runId}-attempt-00`, "profile");
    mkdirSync(syntheticProfile, { recursive: true });
    writeFileSync(join(output, "raw.jsonl"), `${JSON.stringify({
      ...scheduled,
      schemaVersion: 1,
      attempt: 0,
      valid: true,
      runDefinitionSha256: sha256Canonical(definition),
      outcome: "expected-failure",
      failurePhase: "import",
      failureOrigin: "extension",
      archiveSha256: definition.config.corpora[0].archiveSha256,
      archiveBytes: definition.config.corpora[0].archiveBytes,
      archiveObservedBeforeSha256: definition.config.corpora[0].archiveSha256,
      archiveObservedBeforeBytes: definition.config.corpora[0].archiveBytes,
      archiveObservedAfterSha256: definition.config.corpora[0].archiveSha256,
      archiveObservedAfterBytes: definition.config.corpora[0].archiveBytes,
      shutdownVerified: true,
      profileRetained: true,
      profile: syntheticProfile,
      expectedFailureIncludes: "synthetic failure",
      observedError: "observed synthetic failure",
      importRequestId: "synthetic-import-request",
      importResponse: {
        type: "hd_import_result",
        requestId: "synthetic-import-request",
        ok: false,
        error: "observed synthetic failure",
        generation: 0,
      },
    })}\n`);

    const first = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output,
    ], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstSummary = readFileSync(join(output, "summary.json"), "utf8");
    const firstChecksums = readFileSync(join(output, "SHA256SUMS"), "utf8");
    const schedulePath = join(output, "schedule.json");
    const scheduleBytes = readFileSync(schedulePath);
    const scheduleMtimeNs = statSync(schedulePath, { bigint: true }).mtimeNs;
    const snapshotPath = definition.config.corpora[0].archive;
    const snapshotBytes = readFileSync(snapshotPath);

    const resumed = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output,
    ], { encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /skip sample-00-00-expected-failure/);
    assert.equal(readFileSync(join(output, "summary.json"), "utf8"), firstSummary);
    assert.equal(readFileSync(join(output, "SHA256SUMS"), "utf8"), firstChecksums);
    assert.equal(statSync(schedulePath, { bigint: true }).mtimeNs, scheduleMtimeNs);

    rmSync(syntheticProfile, { recursive: true, force: true });
    const missingProfileRejected = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output,
    ], { encoding: "utf8" });
    assert.equal(missingProfileRejected.status, 2);
    assert.match(missingProfileRejected.stderr, /retained diagnostic profile is missing/i);
    mkdirSync(syntheticProfile, { recursive: true });

    writeFileSync(schedulePath, "corrupt schedule\n");
    const scheduleRejected = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output,
    ], { encoding: "utf8" });
    assert.equal(scheduleRejected.status, 2);
    assert.equal(readFileSync(schedulePath, "utf8"), "corrupt schedule\n");
    writeFileSync(schedulePath, scheduleBytes);

    unlinkSync(snapshotPath);
    const missingSnapshotRejected = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output,
    ], { encoding: "utf8" });
    assert.equal(missingSnapshotRejected.status, 2);
    assert.equal(existsSync(snapshotPath), false);
    writeFileSync(snapshotPath, snapshotBytes);
    chmodSync(snapshotPath, 0o444);

    writeFileSync(join(output, "SHA256SUMS"), `${firstChecksums}${"0".repeat(64)}  extra.txt\n`);
    const extraChecksumRejected = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output,
    ], { encoding: "utf8" });
    assert.equal(extraChecksumRejected.status, 2);
    assert.match(extraChecksumRejected.stderr, /checksum manifest/i);
    writeFileSync(join(output, "SHA256SUMS"), firstChecksums);

    const firstChecksumLine = firstChecksums.split("\n")[0];
    writeFileSync(join(output, "SHA256SUMS"), `${firstChecksums}${firstChecksumLine}\n`);
    const duplicateChecksumRejected = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output,
    ], { encoding: "utf8" });
    assert.equal(duplicateChecksumRejected.status, 2);
    assert.match(duplicateChecksumRejected.stderr, /duplicate checksum/i);
    writeFileSync(join(output, "SHA256SUMS"), firstChecksums);

    const altered = JSON.parse(firstSummary);
    altered.metadata.mode = "altered";
    writeFileSync(join(output, "summary.json"), `${JSON.stringify(altered, null, 2)}\n`);
    const rejected = spawnSync(process.execPath, [
      RUNNER, "--config", config, "--output", output,
    ], { encoding: "utf8" });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /checksum|stale or altered completed deliverables/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
