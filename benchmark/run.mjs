#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

import {
  buildSummary,
  canonicalJson,
  makeSchedule,
  matchesExpectedFailure,
  normalizeConfig,
  renderCsv,
  renderMarkdown,
  sha256Canonical,
  validateRows,
} from "./lib.mjs";
import { runBrowserSample } from "./browser.mjs";
import {
  acquireFileLock,
  appendJsonlDurable,
  assertFileIdentity,
  createContentAddressedSnapshot,
  directoryContentSha256,
  hostSnapshot,
  persistThenCleanup,
  readJsonlRecoveringTail,
  sha256File,
} from "./system.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EXTENSION = resolve(REPO, "extension");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");

function cachedChrome() {
  const suffixes = process.platform === "linux"
    ? [["chrome-linux64", "chrome"]]
    : process.platform === "darwin"
      ? [
          ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
          ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ]
      : process.platform === "win32"
        ? [["chrome-win64", "chrome.exe"], ["chrome-win32", "chrome.exe"]]
        : [];
  for (const name of ["hachidori-browsers", "hdw-browsers"]) {
    const root = resolve(CACHE, name, "chrome");
    if (!existsSync(root)) continue;
    const builds = readdirSync(root).sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }));
    for (const build of builds) {
      for (const suffix of suffixes) {
        const candidate = resolve(root, build, ...suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return "";
}

function installedChrome() {
  const candidates = process.platform === "linux"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [resolve(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe")]
        : [];
  return candidates.find(existsSync) || "";
}

const DEFAULT_CHROME = process.env.CHROME_BIN || cachedChrome() || installedChrome();
const PUPPETEER_CANDIDATES = ["hachidori-e2e", "hdw-e2e"].map((name) =>
  resolve(CACHE, name, "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js"));
const DEFAULT_PUPPETEER = PUPPETEER_CANDIDATES.find(existsSync) || PUPPETEER_CANDIDATES[0];

const HELP = `Hachidori browser benchmark

Usage:
  node benchmark/run.mjs --config <config.json> --output <directory> [options]

Required:
  --config PATH       corpora, query fixtures, correctness expectations, and defaults
  --output PATH       new or resumable output directory; raw rows go to raw.jsonl

Overrides:
  --warmups N         excluded warmup runs per corpus
  --samples N         measured runs per corpus
  --lookup-passes N   measured query passes after import and restart
  --idle-check-ms N   max wait for actual service-worker termination, then cold lookup
  --timeout-ms N      timeout for each browser operation
  --keep-profiles     retain successful profiles (failed profiles are always retained)
  --allow-no-sandbox  trusted inputs only: launch Chrome without its sandbox
  --headed            run a visible browser instead of headless Chrome
  --dry-run           validate and pin inputs without launching Chrome
  --help              show this help

Standard Jitendex + Pixiv Light suite:
  HACHIDORI_BENCH_DATA=/path/to/archives node benchmark/run.mjs \\
    --config benchmark/jitendex-pixiv-light.json --output benchmark/results/standard

All samples use fresh Chrome profiles and import through settings.html's real
file input. They then close Chrome completely, launch a fresh Chrome process on
the retained profile, restore direct OPFS state without re-importing, and verify
a first valid lookup. First-ready and steady lookup round trips traverse the
service worker, offscreen document, and WASM engine. The runner appends every
completed sample to raw.jsonl immediately and writes summary.json, results.csv,
report.md, and SHA256SUMS after validation.
`;

function die(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const result = { overrides: {} };
  const values = new Map([
    ["--config", "config"],
    ["--output", "output"],
    ["--warmups", "warmups"],
    ["--samples", "samples"],
    ["--lookup-passes", "lookupPasses"],
    ["--idle-check-ms", "idleCheckMs"],
    ["--timeout-ms", "timeoutMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--keep-profiles") result.overrides.keepProfiles = true;
    else if (argument === "--allow-no-sandbox") result.overrides.allowNoSandbox = true;
    else if (argument === "--headed") result.overrides.headless = false;
    else if (values.has(argument)) {
      if (index + 1 >= argv.length) die(`${argument} needs a value`);
      const value = argv[++index];
      const key = values.get(argument);
      if (key === "config" || key === "output") result[key] = value;
      else result.overrides[key] = Number(value);
    } else {
      die(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  return result;
}

function command(...arguments_) {
  const result = spawnSync(arguments_[0], arguments_.slice(1), {
    cwd: REPO,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packageRoot(entryPath, expectedName) {
  let current = dirname(entryPath);
  for (;;) {
    const manifest = resolve(current, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === expectedName) return { path: current, version: parsed.version ?? null };
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`could not locate ${expectedName} package root from ${entryPath}`);
    current = parent;
  }
}

function stableHostIdentity(snapshot) {
  return {
    hostname: snapshot.hostname,
    platform: snapshot.platform,
    release: snapshot.release,
    cpuCount: snapshot.cpuCount,
    cpuModels: snapshot.cpuModels,
    totalMemoryBytes: snapshot.totalMemoryBytes,
  };
}

function pinDefinition(config, schedule) {
  const chromePath = resolve(process.env.HACHIDORI_CHROME || DEFAULT_CHROME);
  const puppeteerPath = resolve(process.env.HACHIDORI_PUPPETEER || DEFAULT_PUPPETEER);
  const puppeteer = packageRoot(puppeteerPath, "puppeteer-core");
  const hoshidictsPath = resolve(REPO, "third_party/hoshidicts");
  const hostAtPreparation = hostSnapshot();
  return {
    schemaVersion: 1,
    config,
    schedule,
    revision: {
      repositoryCommit: command("git", "rev-parse", "HEAD"),
      extensionTree: command("git", "rev-parse", "HEAD:extension"),
      extensionContentSha256: directoryContentSha256(EXTENSION),
      benchmarkTreeSha256: directoryContentSha256(HERE, { exclude: ["results"] }),
      hoshidictsCommit: command("git", "-C", hoshidictsPath, "rev-parse", "HEAD"),
      hoshidictsContentSha256: directoryContentSha256(hoshidictsPath, { exclude: [".git"] }),
      worktreeStatus: command("git", "status", "--short"),
    },
    runtime: {
      node: process.version,
      nodeExecutablePath: process.execPath,
      nodeExecutableSha256: sha256File(process.execPath),
      linuxClockTicksPerSecond: Number(command("getconf", "CLK_TCK")),
      chromePath,
      chromeVersion: existsSync(chromePath) ? command(chromePath, "--version") : null,
      chromeExecutableSha256: existsSync(chromePath) ? sha256File(chromePath) : null,
      puppeteerPath,
      puppeteerPackageRoot: puppeteer.path,
      puppeteerVersion: puppeteer.version,
      puppeteerTreeSha256: directoryContentSha256(puppeteer.path),
      extensionPath: EXTENSION,
    },
    hostIdentity: stableHostIdentity(hostAtPreparation),
    hostAtPreparation,
  };
}

function stableDefinition(value) {
  const copy = structuredClone(value);
  delete copy.hostAtPreparation;
  return canonicalJson(copy);
}

function assertPinnedExecution(definition) {
  for (const corpus of definition.config.corpora) {
    assertFileIdentity(corpus.archive, { bytes: corpus.archiveBytes, sha256: corpus.archiveSha256 });
  }
  const current = pinDefinition(definition.config, definition.schedule);
  if (stableDefinition(current) !== stableDefinition(definition)) {
    throw new Error("executable inputs or stable host identity changed after benchmark preparation");
  }
}

function artifactChecksumNames(output, config) {
  const archiveSnapshotNames = [...new Set(config.corpora.map((corpus) =>
    relative(output, corpus.archive)))].sort();
  return [
    "run-definition.json",
    "schedule.json",
    "raw.jsonl",
    "summary.json",
    "results.csv",
    "report.md",
    "validation.json",
    ...archiveSnapshotNames,
  ];
}

function sourceConfig(config) {
  const copy = structuredClone(config);
  for (const corpus of copy.corpora) {
    if (corpus.sourceArchive) corpus.archive = corpus.sourceArchive;
    delete corpus.sourceArchive;
    delete corpus.archiveBytes;
    delete corpus.archiveSha256;
  }
  return copy;
}

function prepare(options) {
  if (!options.config) throw new Error("--config is required");
  if (!options.output) throw new Error("--output is required");
  const configPath = resolve(options.config);
  const output = resolve(options.output);
  const outputWithinBenchmark = relative(HERE, output);
  if (outputWithinBenchmark === ""
    || (!outputWithinBenchmark.startsWith("..")
      && outputWithinBenchmark !== "results"
      && !outputWithinBenchmark.startsWith("results/"))) {
    throw new Error("output inside benchmark/ must be under benchmark/results/ so source hashing excludes generated files");
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${configPath}: ${error.message}`);
  }
  const config = normalizeConfig({ ...raw, ...options.overrides }, dirname(configPath));
  const definitionPath = resolve(output, "run-definition.json");
  const summaryPath = resolve(output, "summary.json");
  if (existsSync(summaryPath)) {
    if (!existsSync(definitionPath) || !existsSync(resolve(output, "schedule.json"))) {
      throw new Error(`${output} is missing pinned files from a completed benchmark`);
    }
    const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
    const schedule = JSON.parse(readFileSync(resolve(output, "schedule.json"), "utf8"));
    const requestedSchedule = makeSchedule(config.corpora.map((corpus) => corpus.id), config);
    if (canonicalJson(sourceConfig(definition.config)) !== canonicalJson(config)
      || canonicalJson(definition.schedule) !== canonicalJson(schedule)
      || canonicalJson(requestedSchedule) !== canonicalJson(schedule)) {
      throw new Error(`${definitionPath} belongs to a different benchmark definition; choose a new output directory`);
    }
    verifyChecksumFile(output, artifactChecksumNames(output, definition.config));
    assertPinnedExecution(definition);
    return { configPath, output, config: definition.config, schedule, definition, completed: true };
  }
  if (existsSync(definitionPath)) {
    const schedulePath = resolve(output, "schedule.json");
    if (!existsSync(schedulePath)) {
      throw new Error(`${output} is missing its pinned schedule`);
    }
    const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
    const schedule = JSON.parse(readFileSync(schedulePath, "utf8"));
    const requestedSchedule = makeSchedule(config.corpora.map((corpus) => corpus.id), config);
    if (canonicalJson(sourceConfig(definition.config)) !== canonicalJson(config)
      || canonicalJson(definition.schedule) !== canonicalJson(schedule)
      || canonicalJson(requestedSchedule) !== canonicalJson(schedule)) {
      throw new Error(`${definitionPath} belongs to a different benchmark definition; choose a new output directory`);
    }
    for (let index = 0; index < config.corpora.length; index += 1) {
      const requestedCorpus = config.corpora[index];
      const pinnedCorpus = definition.config.corpora[index];
      assertFileIdentity(requestedCorpus.archive, {
        bytes: pinnedCorpus.archiveBytes,
        sha256: pinnedCorpus.archiveSha256,
      });
    }
    assertPinnedExecution(definition);
    return { configPath, output, config: definition.config, schedule, definition };
  }
  const schedule = makeSchedule(config.corpora.map((corpus) => corpus.id), config);
  const schedulePath = resolve(output, "schedule.json");
  if (existsSync(schedulePath)) {
    const existingSchedule = JSON.parse(readFileSync(schedulePath, "utf8"));
    if (canonicalJson(existingSchedule) !== canonicalJson(schedule)) {
      throw new Error(`${schedulePath} does not match the requested benchmark schedule`);
    }
  }
  const snapshots = resolve(output, "inputs");
  for (const corpus of config.corpora) {
    if (!existsSync(corpus.archive) || !statSync(corpus.archive).isFile()) {
      throw new Error(`${corpus.id}: archive not found: ${corpus.archive}`);
    }
    const sourceArchive = corpus.archive;
    const snapshot = createContentAddressedSnapshot(sourceArchive, snapshots);
    corpus.sourceArchive = sourceArchive;
    corpus.archive = snapshot.path;
    corpus.archiveBytes = snapshot.bytes;
    corpus.archiveSha256 = snapshot.sha256;
    if (corpus.expectedSha256 && corpus.expectedSha256 !== corpus.archiveSha256) {
      throw new Error(`${corpus.id}: archive SHA-256 mismatch; expected ${corpus.expectedSha256}, got ${corpus.archiveSha256}`);
    }
  }
  const definition = pinDefinition(config, schedule);
  if (!existsSync(schedulePath)) writeJson(schedulePath, schedule);
  writeJson(definitionPath, definition);
  return { configPath, output, config, schedule, definition };
}

function verifyChecksumFile(output, names) {
  const checksumPath = resolve(output, "SHA256SUMS");
  if (!existsSync(checksumPath)) throw new Error(`${checksumPath} is missing from a completed benchmark`);
  const expected = new Map();
  for (const line of readFileSync(checksumPath, "utf8").trimEnd().split("\n")) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`${checksumPath} contains an invalid line`);
    if (expected.has(match[2])) throw new Error(`${checksumPath} contains duplicate checksum entry ${match[2]}`);
    expected.set(match[2], match[1]);
  }
  const required = new Set(names);
  if (expected.size !== required.size || [...expected.keys()].some((name) => !required.has(name))) {
    throw new Error(`${checksumPath} checksum manifest does not exactly match the completed artifact set`);
  }
  for (const name of names) {
    if (expected.get(name) !== sha256File(resolve(output, name))) {
      throw new Error(`${name} does not match the completed benchmark checksum`);
    }
  }
}

function writeDeliverables(prepared, rows, rawAttemptCount = rows.length) {
  const summaryPath = resolve(prepared.output, "summary.json");
  const runDefinitionSha256 = sha256Canonical(prepared.definition);
  const existingSummary = existsSync(summaryPath)
    ? JSON.parse(readFileSync(summaryPath, "utf8"))
    : null;
  if (existingSummary && (existingSummary.metadata?.runDefinitionSha256 !== runDefinitionSha256
    || !existingSummary.metadata?.hostAtCompletion)) {
    throw new Error(`${summaryPath} does not match the pinned run definition`);
  }
  const hostAtCompletion = existingSummary?.metadata.hostAtCompletion ?? hostSnapshot();
  const metadata = {
    mode: "rough-directional",
    revisions: prepared.definition.revision,
    runtime: prepared.definition.runtime,
    hostAtPreparation: prepared.definition.hostAtPreparation,
    hostAtCompletion,
    schedule: {
      seed: prepared.config.seed,
      warmupsPerCorpus: prepared.config.warmups,
      measuredSamplesPerCorpus: prepared.config.samples,
      lookupPassesPerPhasePerSample: prepared.config.lookupPasses,
      queryRegistryCount: prepared.config.queries.length,
      queryCountByCorpus: Object.fromEntries(prepared.config.corpora.map((corpus) => [
        corpus.id,
        corpus.queryIds?.length ?? prepared.config.queries.length,
      ])),
      idleCheckMs: prepared.config.idleCheckMs,
    },
    runDefinitionSha256,
  };
  const summary = buildSummary(rows, metadata);
  const csvPath = resolve(prepared.output, "results.csv");
  const reportPath = resolve(prepared.output, "report.md");
  const validationPath = resolve(prepared.output, "validation.json");
  const renderedCsv = renderCsv(summary);
  const renderedReport = renderMarkdown(summary);
  const validation = {
    status: "pass",
    scheduledRuns: prepared.schedule.length,
    rawAttemptCount,
    measuredRuns: rows.filter((row) => !row.warmup).length,
    warmupRuns: rows.filter((row) => row.warmup).length,
    successfulRuns: rows.filter((row) => (row.outcome ?? "success") === "success").length,
    expectedFailureRuns: rows.filter((row) => row.outcome === "expected-failure").length,
    correctness: "successful cells have stable import/query/lookup signatures across samples and restart; expected-failure cells matched their pinned production-path failure",
  };
  const checksumNames = artifactChecksumNames(prepared.output, prepared.config);
  if (existingSummary) {
    if (canonicalJson(existingSummary) !== canonicalJson(summary)
      || readFileSync(csvPath, "utf8") !== renderedCsv
      || readFileSync(reportPath, "utf8") !== renderedReport
      || canonicalJson(JSON.parse(readFileSync(validationPath, "utf8"))) !== canonicalJson(validation)) {
      throw new Error(`${prepared.output} has stale or altered completed deliverables`);
    }
    verifyChecksumFile(prepared.output, checksumNames);
    return { summary, reportPath };
  }
  writeJson(summaryPath, summary);
  writeFileSync(csvPath, renderedCsv);
  writeFileSync(reportPath, renderedReport);
  writeJson(validationPath, validation);
  writeFileSync(resolve(prepared.output, "SHA256SUMS"), checksumNames
    .map((name) => `${sha256File(resolve(prepared.output, name))}  ${name}`)
    .join("\n") + "\n");
  return { summary, reportPath };
}

async function execute(prepared) {
  const { config, schedule, definition, output } = prepared;
  assertPinnedExecution(definition);
  for (const [label, path] of [
    ["Chrome", definition.runtime.chromePath],
    ["puppeteer-core", definition.runtime.puppeteerPath],
    ["extension WASM", resolve(EXTENSION, "vendor/hoshidicts.wasm")],
  ]) {
    if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  }
  const puppeteer = await import(definition.runtime.puppeteerPath);
  const launch = puppeteer.default?.launch ? puppeteer.default : puppeteer;
  const rawPath = resolve(output, "raw.jsonl");
  const readRows = () => readJsonlRecoveringTail(rawPath, {
    onTailRecovered: ({ discardedBytes }) => {
      process.stderr.write(`warning: discarded ${discardedBytes} bytes from an incomplete final raw.jsonl record\n`);
    },
  });
  const existing = readRows();
  const selectedExisting = validateRows(existing, schedule, definition, { allowMissing: true });
  const completed = new Set(selectedExisting.filter((row) => row.valid === true).map((row) => row.runId));
  const nextAttemptByRun = new Map(schedule.map((item) => {
    const attempts = existing
      .filter((row) => row.runId === item.runId)
      .map((row) => row.attempt ?? 0);
    return [item.runId, attempts.length > 0 ? Math.max(...attempts) + 1 : 0];
  }));
  const corpusById = new Map(config.corpora.map((corpus) => [corpus.id, corpus]));

  for (const scheduledItem of schedule) {
    if (completed.has(scheduledItem.runId)) {
      process.stdout.write(`skip ${scheduledItem.runId} (validated attempt already in raw.jsonl)\n`);
      continue;
    }
    const item = { ...scheduledItem, attempt: nextAttemptByRun.get(scheduledItem.runId) };
    process.stdout.write(`run  ${item.runId} attempt ${item.attempt} ...\n`);
    const corpus = corpusById.get(item.corpus);
    const expectedArchive = { bytes: corpus.archiveBytes, sha256: corpus.archiveSha256 };
    let archiveBefore = null;
    let archiveAfter = null;
    let browserRow = null;
    try {
      archiveBefore = assertFileIdentity(corpus.archive, expectedArchive);
      browserRow = await runBrowserSample({ item, corpus, config, definition, output, launch });
      const row = browserRow;
      archiveAfter = assertFileIdentity(corpus.archive, expectedArchive);
      Object.assign(row, {
        archiveObservedBeforeSha256: archiveBefore.sha256,
        archiveObservedBeforeBytes: archiveBefore.bytes,
        archiveObservedAfterSha256: archiveAfter.sha256,
        archiveObservedAfterBytes: archiveAfter.bytes,
      });
      if (corpus.expectedFailureIncludes) {
        const error = new Error(`expected failure containing ${JSON.stringify(corpus.expectedFailureIncludes)}, but the run succeeded`);
        error.benchmarkUnexpectedSuccess = true;
        error.benchmarkContext = {
          runDirectory: dirname(row.profilePath),
          profile: row.profilePath,
          profileRetained: row.profileRetained,
          diagnostics: row.diagnostics,
        };
        throw error;
      }
      const removeSuccessfulProfile = !config.keepProfiles;
      row.profileRetained = config.keepProfiles ? true : null;
      row.profileDisposition = removeSuccessfulProfile ? "delete-after-persistence" : "retained";
      persistThenCleanup({
        persist: () => appendJsonlDurable(rawPath, canonicalJson(row)),
        cleanup: removeSuccessfulProfile
          ? () => rmSync(row.profilePath, { recursive: true, force: true })
          : null,
        onCleanupError: (cleanupError) => process.stderr.write(
          `WARN ${item.runId} attempt ${item.attempt}: result is durable, but profile cleanup failed: ${cleanupError.message || String(cleanupError)}\n`
          + `profile remains at: ${row.profilePath}\n`,
        ),
      });
      completed.add(item.runId);
      const requestMedian = [...row.lookup.postRestart.passes.flatMap((pass) => pass.latenciesMs)]
        .sort((left, right) => left - right)[Math.floor(
          row.lookup.postRestart.passes.flatMap((pass) => pass.latenciesMs).length / 2,
        )];
      process.stdout.write(
        `ok   ${item.runId} attempt ${item.attempt}: import->first-hit ${(row.metrics.importUsableWallMs / 1000).toFixed(3)} s, `
        + `full-restart->first-hit ${(row.metrics.restartUsableWallMs / 1000).toFixed(3)} s, `
        + `first-ready lookup ${row.metrics.firstLookupAfterRestartMs.toFixed(3)} ms, `
        + `steady lookup ~${requestMedian.toFixed(3)} ms\n`,
      );
    } catch (error) {
      try {
        archiveAfter = assertFileIdentity(corpus.archive, expectedArchive);
      } catch (archiveError) {
        archiveError.benchmarkFailure = { phase: "archive", origin: "harness" };
        archiveError.benchmarkContext = error.benchmarkContext ?? (browserRow ? {
          runDirectory: dirname(browserRow.profilePath),
          profile: browserRow.profilePath,
          profileRetained: true,
          shutdownVerified: browserRow.shutdownVerified,
          diagnostics: browserRow.diagnostics,
          hostStart: browserRow.hostStart,
          hostEnd: browserRow.hostEnd,
          startedUtc: browserRow.startedUtc,
          endedUtc: browserRow.endedUtc,
        } : undefined);
        error = archiveError;
      }
      if (!error.benchmarkContext && browserRow) {
        error.benchmarkContext = {
          runDirectory: dirname(browserRow.profilePath),
          profile: browserRow.profilePath,
          profileRetained: existsSync(browserRow.profilePath),
          shutdownVerified: browserRow.shutdownVerified,
          diagnostics: browserRow.diagnostics,
          hostStart: browserRow.hostStart,
          hostEnd: browserRow.hostEnd,
          startedUtc: browserRow.startedUtc,
          endedUtc: browserRow.endedUtc,
        };
      }
      const context = error.benchmarkContext ?? {};
      const observedError = error.message || String(error);
      const expectedFailure = matchesExpectedFailure(corpus.expectedFailureIncludes, error);
      const failure = {
        schemaVersion: 1,
        ...item,
        valid: Boolean(expectedFailure),
        runDefinitionSha256: sha256Canonical(definition),
        outcome: expectedFailure ? "expected-failure" : "failure",
        failurePhase: error.benchmarkFailure?.phase ?? null,
        failureOrigin: error.benchmarkFailure?.origin ?? null,
        archiveSha256: corpus.archiveSha256,
        archiveBytes: corpus.archiveBytes,
        archiveObservedBeforeSha256: archiveBefore?.sha256 ?? null,
        archiveObservedBeforeBytes: archiveBefore?.bytes ?? null,
        archiveObservedAfterSha256: archiveAfter?.sha256 ?? null,
        archiveObservedAfterBytes: archiveAfter?.bytes ?? null,
        shutdownVerified: context.shutdownVerified === true,
        error: expectedFailure ? null : observedError,
        observedError,
        expectedFailureIncludes: expectedFailure ? corpus.expectedFailureIncludes : null,
        ...(error.benchmarkFailure?.response ? {
          importRequestId: error.benchmarkFailure.response.requestId,
          importResponse: error.benchmarkFailure.response,
        } : {}),
        stack: error.stack || String(error),
        ...context,
      };
      if (!expectedFailure) {
        process.stderr.write(`FAIL ${item.runId} attempt ${item.attempt}: ${failure.error}\nprofile kept: ${context.profile ?? "unknown"}\n`);
      }
      appendJsonlDurable(rawPath, canonicalJson(failure));
      completed.add(item.runId);
      if (expectedFailure) {
        process.stdout.write(`ok   ${item.runId} attempt ${item.attempt}: matched expected failure: ${observedError}\n`);
      }
    }
  }

  assertPinnedExecution(definition);
  const allRows = readRows();
  const rows = validateRows(allRows, schedule, definition);
  for (const row of allRows) {
    const retainedProfile = typeof row.profile === "string" ? row.profile : row.profilePath;
    if (row.profileRetained === true
      && (typeof retainedProfile !== "string" || retainedProfile === "" || !existsSync(retainedProfile))) {
      throw new Error(`${row.runId} attempt ${row.attempt}: retained diagnostic profile is missing`);
    }
  }
  const { reportPath } = writeDeliverables(prepared, rows, allRows.length);
  process.stdout.write(`\nbenchmark complete: ${reportPath}\n`);
  process.stdout.write(readFileSync(reportPath, "utf8"));
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

let prepared;
let releaseLock;
try {
  if (!options.config) throw new Error("--config is required");
  if (!options.output) throw new Error("--output is required");
  const earlyOutput = resolve(options.output);
  mkdirSync(earlyOutput, { recursive: true });
  releaseLock = acquireFileLock(resolve(earlyOutput, ".benchmark.lock"), {
    pid: process.pid,
    hostname: hostSnapshot().hostname,
    startedUtc: new Date().toISOString(),
  });
  prepared = prepare(options);
  if (options.dryRun) {
    process.stdout.write(`dry run complete: ${prepared.output}\n`);
  } else {
    await execute(prepared);
  }
} catch (error) {
  process.stderr.write(`error: ${error.stack || error.message || String(error)}\n`);
  process.exitCode = 2;
} finally {
  if (releaseLock) releaseLock();
}
