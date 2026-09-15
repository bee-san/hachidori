#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildComparisonSummary,
  makeComparisonSchedule,
  normalizeComparisonConfig,
  renderComparisonCsv,
  renderComparisonMarkdown,
  validateComparisonRows,
} from "./comparison-lib.mjs";
import { runHachidoriSample } from "./hachidori.mjs";
import { buildJlAdapter, runJlSample } from "./jl.mjs";
import { canonicalJson, sha256Canonical } from "./lib.mjs";
import {
  acquireFileLock,
  appendJsonlDurable,
  assertFileIdentity,
  createContentAddressedSnapshot,
  directoryContentSha256,
  hostSnapshot,
  readJsonlRecoveringTail,
  sha256File,
} from "./system.mjs";
import { runYomitanSample } from "./yomitan.mjs";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "..");
const EXTENSION = resolve(REPO, "extension");
const HOSHIDICTS = resolve(REPO, "third_party", "hoshidicts");
const DEFAULT_CONFIG = resolve(HERE, "comparison.json");
const DEFAULT_OUTPUT = resolve(HERE, "results", "comparison");

function die(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { config: DEFAULT_CONFIG, output: DEFAULT_OUTPUT, maxRuns: Infinity, overrides: {} };
  const values = new Map([
    ["--config", "config"],
    ["--output", "output"],
    ["--max-runs", "maxRuns"],
    ["--warmups", "warmups"],
    ["--samples", "samples"],
    ["--lookup-passes", "lookupPasses"],
    ["--timeout-ms", "timeoutMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--keep-profiles") options.overrides.keepProfiles = true;
    else if (argument === "--headed") options.overrides.headless = false;
    else if (argument === "--allow-no-sandbox") options.overrides.allowNoSandbox = true;
    else if (values.has(argument)) {
      if (index + 1 >= argv.length) die(`${argument} needs a value`);
      const key = values.get(argument);
      const value = argv[++index];
      if (["config", "output"].includes(key)) options[key] = value;
      else if (key === "maxRuns") options.maxRuns = Number(value);
      else options.overrides[key] = Number(value);
    } else die(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (!Number.isInteger(options.maxRuns) && options.maxRuns !== Infinity) die("--max-runs must be an integer");
  if (options.maxRuns < 0) die("--max-runs cannot be negative");
  return options;
}

function usage() {
  return `Usage: node benchmark/compare.mjs [options]\n\n`
    + `Options:\n`
    + `  --config PATH          comparison config (default: benchmark/comparison.json)\n`
    + `  --output DIR           durable output directory (default: benchmark/results/comparison)\n`
    + `  --warmups N            override outer warmups per engine/corpus cell\n`
    + `  --samples N            override measured samples per engine/corpus cell\n`
    + `  --lookup-passes N      override measured lookup passes per fresh state\n`
    + `  --timeout-ms N         override per-run timeout\n`
    + `  --max-runs N           stop after N pending runs, leaving resumable evidence\n`
    + `  --dry-run              pin and verify all inputs without running cells\n`
    + `  --allow-no-sandbox     pass --no-sandbox to Chrome\n`
    + `  --headed               run Chrome with a visible window\n`
    + `  --keep-profiles        retain successful browser profiles\n`;
}

export function command(executable, args, { cwd = REPO, environment = process.env, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${result.status ?? result.signal}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.replace(/[\r\n]+$/, "");
}

function git(path, ...args) {
  return command("git", ["-C", path, ...args]);
}

function firstExisting(paths, label) {
  const value = paths.find((path) => path && existsSync(path));
  if (!value) throw new Error(`${label} was not found; set the documented environment variable`);
  return resolve(value);
}

function chromePath() {
  return firstExisting([
    process.env.HACHIDORI_CHROME,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    resolve(homedir(), ".cache", "hachidori-browsers", "chrome", "linux-152.0.7977.75", "chrome-linux64", "chrome"),
    resolve(homedir(), ".cache", "hdw-browsers", "chrome", "linux-152.0.7977.75", "chrome-linux64", "chrome"),
  ], "Chrome");
}

function puppeteerPath() {
  return firstExisting([
    process.env.HACHIDORI_PUPPETEER,
    resolve(homedir(), ".cache", "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js"),
    resolve(homedir(), ".cache", "hdw-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js"),
  ], "puppeteer-core entry point");
}

function dotnetPath() {
  return firstExisting([
    process.env.HACHIDORI_DOTNET,
    resolve(homedir(), ".dotnet", "dotnet"),
    "/usr/bin/dotnet",
  ], "dotnet");
}

function packageRoot(entryPath, expectedName) {
  let current = dirname(entryPath);
  for (;;) {
    const packagePath = resolve(current, "package.json");
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      if (packageJson.name === expectedName) return { path: current, version: packageJson.version ?? null };
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`could not locate ${expectedName} from ${entryPath}`);
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

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, "w", 0o644);
  try {
    const buffer = Buffer.from(content);
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function writeJson(path, value) {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function safeExtractZip(archive, destination) {
  const entries = command("unzip", ["-Z1", archive], { cwd: HERE }).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error(`${archive} has no ZIP entries`);
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      || segments.includes("..") || normalized.includes("\u0000")) {
      throw new Error(`${archive} contains unsafe entry ${JSON.stringify(entry)}`);
    }
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  command("unzip", ["-q", archive, "-d", destination], { cwd: HERE });
  return entries.length;
}

function pinEngine(base) {
  const pinned = structuredClone(base);
  pinned.identitySha256 = sha256Canonical(pinned);
  return pinned;
}

function assertCleanPinnedSource(path, expectedCommit, label) {
  const commit = git(path, "rev-parse", "HEAD");
  if (commit !== expectedCommit) throw new Error(`${label} is at ${commit}, expected ${expectedCommit}`);
  const status = git(path, "status", "--short", "--untracked-files=all");
  if (status !== "") throw new Error(`${label} must be clean:\n${status}`);
  return { commit, tree: git(path, "rev-parse", "HEAD^{tree}"), status };
}

function sourceConfigHash(config) {
  return sha256Canonical(config);
}

function repositorySourceSha256(prefix) {
  const files = git(REPO, "ls-files", "-co", "--exclude-standard", "--", prefix)
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  if (files.length === 0) throw new Error(`${prefix} has no source files`);
  return sha256Canonical(files.map((path) => ({ path, sha256: sha256File(resolve(REPO, path)) })));
}

async function createDefinition(requestedConfig, configPath, output) {
  mkdirSync(output, { recursive: true });
  const inputDirectory = resolve(output, "inputs");
  const runtimeDirectory = resolve(output, "runtime");
  mkdirSync(inputDirectory, { recursive: true });
  mkdirSync(runtimeDirectory, { recursive: true });

  const config = structuredClone(requestedConfig);
  for (const corpus of config.corpora) {
    const sourceArchive = corpus.archive;
    const snapshot = createContentAddressedSnapshot(sourceArchive, inputDirectory);
    if (snapshot.sha256 !== corpus.expectedSha256) {
      throw new Error(`${corpus.id} SHA-256 ${snapshot.sha256}, expected ${corpus.expectedSha256}`);
    }
    corpus.sourceArchive = sourceArchive;
    corpus.archive = snapshot.path;
    corpus.archiveSha256 = snapshot.sha256;
    corpus.archiveBytes = snapshot.bytes;
  }

  const chrome = chromePath();
  const puppeteer = puppeteerPath();
  const puppeteerPackage = packageRoot(puppeteer, "puppeteer-core");
  const dotnet = dotnetPath();
  const hachidoriConfig = config.engines.find((engine) => engine.kind === "hachidori");
  const yomitanConfig = config.engines.find((engine) => engine.kind === "yomitan");
  const jlConfig = config.engines.find((engine) => engine.kind === "jl");

  const yomitanSnapshot = createContentAddressedSnapshot(yomitanConfig.extensionArchive, inputDirectory);
  if (yomitanSnapshot.sha256 !== yomitanConfig.expectedSha256) {
    throw new Error(`Yomitan SHA-256 ${yomitanSnapshot.sha256}, expected ${yomitanConfig.expectedSha256}`);
  }
  const yomitanExtensionPath = resolve(runtimeDirectory, `yomitan-${yomitanConfig.version}-${yomitanSnapshot.sha256.slice(0, 12)}`);
  const yomitanEntryCount = safeExtractZip(yomitanSnapshot.path, yomitanExtensionPath);
  const yomitanManifest = JSON.parse(readFileSync(resolve(yomitanExtensionPath, "manifest.json"), "utf8"));
  if (yomitanManifest.version !== yomitanConfig.version) {
    throw new Error(`Yomitan artifact version ${yomitanManifest.version}, expected ${yomitanConfig.version}`);
  }

  const jlSource = assertCleanPinnedSource(jlConfig.source, jlConfig.expectedCommit, "JL source");
  const jlAdapterDirectory = resolve(runtimeDirectory, "jl-adapter");
  const jlAdapter = await buildJlAdapter({
    dotnetPath: dotnet,
    sourcePath: jlConfig.source,
    outputPath: jlAdapterDirectory,
    timeoutMs: config.timeoutMs,
  });

  const repositoryCommit = git(REPO, "rev-parse", "HEAD");
  const repositoryStatus = git(REPO, "status", "--short", "--untracked-files=all");
  const hoshidictsCommit = git(HOSHIDICTS, "rev-parse", "HEAD");
  const hoshidictsStatus = git(HOSHIDICTS, "status", "--short", "--untracked-files=all");
  const hachidoriRevision = {
    repositoryCommit,
    extensionTree: git(REPO, "rev-parse", "HEAD:extension"),
    extensionContentSha256: directoryContentSha256(EXTENSION),
    benchmarkSourceSha256: repositorySourceSha256("benchmark"),
    hoshidictsCommit,
    hoshidictsContentSha256: directoryContentSha256(HOSHIDICTS, { exclude: [".git"] }),
    worktreeStatus: repositoryStatus,
    hoshidictsStatus,
  };

  const engines = [
    pinEngine({
      id: hachidoriConfig.id,
      label: hachidoriConfig.label,
      kind: hachidoriConfig.kind,
      commit: repositoryCommit,
      revision: hachidoriRevision,
      extensionContentSha256: hachidoriRevision.extensionContentSha256,
    }),
    pinEngine({
      id: yomitanConfig.id,
      label: yomitanConfig.label,
      kind: yomitanConfig.kind,
      version: yomitanConfig.version,
      archiveSha256: yomitanSnapshot.sha256,
      archiveBytes: yomitanSnapshot.bytes,
      extensionContentSha256: directoryContentSha256(yomitanExtensionPath),
      extensionEntryCount: yomitanEntryCount,
      manifestVersion: yomitanManifest.version,
      manifestVersionName: yomitanManifest.version_name ?? null,
    }),
    pinEngine({
      id: jlConfig.id,
      label: jlConfig.label,
      kind: jlConfig.kind,
      version: jlConfig.version,
      commit: jlSource.commit,
      tree: jlSource.tree,
      adapterSha256: jlAdapter.adapterSha256,
      coreSha256: jlAdapter.coreSha256,
    }),
  ];
  const schedule = makeComparisonSchedule(
    engines.map((engine) => engine.id),
    config.corpora.map((corpus) => corpus.id),
    config,
  );
  const hostAtPreparation = hostSnapshot();
  return {
    schemaVersion: 1,
    benchmark: "Hachidori cross-engine comparison",
    createdUtc: new Date().toISOString(),
    sourceConfigPath: configPath,
    sourceConfigIdentity: {
      bytes: statSync(configPath).size,
      sha256: sha256File(configPath),
      normalizedSha256: sourceConfigHash(requestedConfig),
    },
    config,
    configSha256: sha256Canonical(config),
    engines,
    schedule,
    runtime: {
      nodeVersion: process.version,
      nodeExecutablePath: process.execPath,
      nodeExecutableSha256: sha256File(process.execPath),
      chromePath: chrome,
      chromeVersion: command(chrome, ["--version"]),
      chromeSha256: sha256File(chrome),
      puppeteerPath: puppeteer,
      puppeteerPackageRoot: puppeteerPackage.path,
      puppeteerVersion: puppeteerPackage.version,
      puppeteerPackageSha256: directoryContentSha256(puppeteerPackage.path),
      dotnetPath: dotnet,
      dotnetVersion: command(dotnet, ["--version"]),
      dotnetSha256: sha256File(dotnet),
      linuxClockTicksPerSecond: Number(command("getconf", ["CLK_TCK"])),
      hachidoriExtensionPath: EXTENSION,
      yomitanArchivePath: yomitanSnapshot.path,
      yomitanExtensionPath,
      jlSourcePath: jlConfig.source,
      jlAdapterDirectory,
      jlAdapterPath: jlAdapter.adapterPath,
      jlAdapterSha256: jlAdapter.adapterSha256,
      jlCorePath: jlAdapter.corePath,
      jlCoreSha256: jlAdapter.coreSha256,
    },
    hostIdentity: stableHostIdentity(hostAtPreparation),
    hostAtPreparation,
  };
}

function comparePinned(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} changed after benchmark preparation`);
}

function assertPinnedExecution(definition) {
  assertFileIdentity(definition.sourceConfigPath, definition.sourceConfigIdentity);
  for (const corpus of definition.config.corpora) {
    const identity = { bytes: corpus.archiveBytes, sha256: corpus.archiveSha256 };
    assertFileIdentity(corpus.archive, identity);
    assertFileIdentity(corpus.sourceArchive, identity);
  }
  const yomitan = definition.engines.find((engine) => engine.kind === "yomitan");
  assertFileIdentity(definition.runtime.yomitanArchivePath, {
    bytes: yomitan.archiveBytes,
    sha256: yomitan.archiveSha256,
  });
  comparePinned(directoryContentSha256(definition.runtime.yomitanExtensionPath), yomitan.extensionContentSha256, "Yomitan extension");

  const hachidori = definition.engines.find((engine) => engine.kind === "hachidori");
  comparePinned(git(REPO, "rev-parse", "HEAD"), hachidori.commit, "Hachidori commit");
  comparePinned(git(REPO, "status", "--short", "--untracked-files=all"), hachidori.revision.worktreeStatus, "Hachidori worktree");
  comparePinned(directoryContentSha256(EXTENSION), hachidori.extensionContentSha256, "Hachidori extension");
  comparePinned(repositorySourceSha256("benchmark"), hachidori.revision.benchmarkSourceSha256, "benchmark source");
  comparePinned(git(HOSHIDICTS, "rev-parse", "HEAD"), hachidori.revision.hoshidictsCommit, "hoshidicts commit");
  comparePinned(git(HOSHIDICTS, "status", "--short", "--untracked-files=all"), hachidori.revision.hoshidictsStatus, "hoshidicts worktree");
  comparePinned(directoryContentSha256(HOSHIDICTS, { exclude: [".git"] }), hachidori.revision.hoshidictsContentSha256, "hoshidicts source");

  const jl = definition.engines.find((engine) => engine.kind === "jl");
  comparePinned(git(definition.runtime.jlSourcePath, "rev-parse", "HEAD"), jl.commit, "JL commit");
  comparePinned(git(definition.runtime.jlSourcePath, "status", "--short", "--untracked-files=all"), "", "JL worktree");
  assertFileIdentity(definition.runtime.jlAdapterPath, {
    bytes: statSync(definition.runtime.jlAdapterPath).size,
    sha256: definition.runtime.jlAdapterSha256,
  });
  assertFileIdentity(definition.runtime.jlCorePath, {
    bytes: statSync(definition.runtime.jlCorePath).size,
    sha256: definition.runtime.jlCoreSha256,
  });
  assertFileIdentity(definition.runtime.chromePath, {
    bytes: statSync(definition.runtime.chromePath).size,
    sha256: definition.runtime.chromeSha256,
  });
  assertFileIdentity(definition.runtime.nodeExecutablePath, {
    bytes: statSync(definition.runtime.nodeExecutablePath).size,
    sha256: definition.runtime.nodeExecutableSha256,
  });
  assertFileIdentity(definition.runtime.dotnetPath, {
    bytes: statSync(definition.runtime.dotnetPath).size,
    sha256: definition.runtime.dotnetSha256,
  });
  comparePinned(directoryContentSha256(definition.runtime.puppeteerPackageRoot), definition.runtime.puppeteerPackageSha256, "puppeteer-core");
  comparePinned(canonicalJson(stableHostIdentity(hostSnapshot())), canonicalJson(definition.hostIdentity), "stable host identity");
}

function verifyChecksums(output) {
  const checksumPath = resolve(output, "SHA256SUMS");
  if (!existsSync(checksumPath)) throw new Error(`${checksumPath} is missing`);
  const lines = readFileSync(checksumPath, "utf8").trimEnd().split("\n");
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match || seen.has(match[2])) throw new Error(`${checksumPath} is malformed`);
    seen.add(match[2]);
    comparePinned(sha256File(resolve(output, match[2])), match[1], match[2]);
  }
}

async function prepare(options) {
  const configPath = resolve(options.config);
  const output = resolve(options.output);
  const location = relative(HERE, output);
  if (location === "" || (!location.startsWith("..") && location !== "results" && !location.startsWith("results/"))) {
    throw new Error("output inside benchmark/ must be under benchmark/results/");
  }
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const requestedConfig = normalizeComparisonConfig({ ...rawConfig, ...options.overrides }, dirname(configPath));
  const requestedSchedule = makeComparisonSchedule(
    requestedConfig.engines.map((engine) => engine.id),
    requestedConfig.corpora.map((corpus) => corpus.id),
    requestedConfig,
  );
  const definitionPath = resolve(output, "run-definition.json");
  const schedulePath = resolve(output, "schedule.json");
  if (existsSync(definitionPath)) {
    if (!existsSync(schedulePath)) throw new Error(`${output} is missing schedule.json`);
    const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
    const schedule = JSON.parse(readFileSync(schedulePath, "utf8"));
    if (definition.sourceConfigIdentity.normalizedSha256 !== sourceConfigHash(requestedConfig)
      || canonicalJson(schedule) !== canonicalJson(definition.schedule)
      || canonicalJson(schedule) !== canonicalJson(requestedSchedule)) {
      throw new Error(`${definitionPath} belongs to a different comparison; choose a new output directory`);
    }
    assertPinnedExecution(definition);
    if (existsSync(resolve(output, "summary.json"))) verifyChecksums(output);
    return { configPath, output, config: definition.config, schedule, definition };
  }
  const definition = await createDefinition(requestedConfig, configPath, output);
  writeJson(schedulePath, definition.schedule);
  writeJson(definitionPath, definition);
  assertPinnedExecution(definition);
  return { configPath, output, config: definition.config, schedule: definition.schedule, definition };
}

function withinOutput(path, output) {
  const location = relative(output, path);
  return location !== "" && location !== ".." && !location.startsWith("../")
    && !location.startsWith("..\\") && !location.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(location);
}

function cleanupCompletedProfiles(rows, output, keepProfiles) {
  if (keepProfiles) return;
  for (const row of rows) {
    if (row.valid !== true || typeof row.profilePath !== "string") continue;
    if (!withinOutput(row.profilePath, output)) throw new Error(`refusing to remove profile outside output: ${row.profilePath}`);
    rmSync(row.profilePath, { recursive: true, force: true });
    if (existsSync(row.profilePath)) throw new Error(`could not remove completed profile ${row.profilePath}`);
  }
}

function failedRow(item, definition, corpus, before, error) {
  return {
    schemaVersion: 1,
    ...item,
    valid: false,
    runDefinitionSha256: sha256Canonical(definition),
    engineIdentitySha256: definition.engines.find((engine) => engine.id === item.engine).identitySha256,
    archiveSha256: corpus.archiveSha256,
    archiveBytes: corpus.archiveBytes,
    archiveObservedBeforeSha256: before?.sha256 ?? null,
    archiveObservedBeforeBytes: before?.bytes ?? null,
    error: error?.stack || error?.message || String(error),
    benchmarkContext: error?.benchmarkContext ?? null,
    endedUtc: new Date().toISOString(),
  };
}

async function execute(prepared, options) {
  const { config, schedule, definition, output } = prepared;
  assertPinnedExecution(definition);
  const rawPath = resolve(output, "raw.jsonl");
  const readRows = () => readJsonlRecoveringTail(rawPath, {
    onTailRecovered: ({ discardedBytes }) => process.stderr.write(`warning: discarded ${discardedBytes} incomplete raw bytes\n`),
  });
  const existing = readRows();
  const selected = validateComparisonRows(existing, schedule, definition, { allowMissing: true });
  cleanupCompletedProfiles(selected, output, config.keepProfiles);
  const completed = new Set(selected.filter((row) => row.valid === true).map((row) => row.runId));
  const nextAttempt = new Map(schedule.map((item) => {
    const attempts = existing.filter((row) => row.runId === item.runId).map((row) => row.attempt);
    return [item.runId, attempts.length === 0 ? 0 : Math.max(...attempts) + 1];
  }));
  const corpusById = new Map(config.corpora.map((corpus) => [corpus.id, corpus]));
  const engineById = new Map(definition.engines.map((engine) => [engine.id, engine]));
  const puppeteer = await import(pathToFileURL(definition.runtime.puppeteerPath).href);
  const launch = puppeteer.default?.launch ? puppeteer.default : puppeteer;
  let executed = 0;
  for (const scheduled of schedule) {
    if (completed.has(scheduled.runId)) {
      process.stdout.write(`skip ${scheduled.runId}\n`);
      continue;
    }
    if (executed >= options.maxRuns) break;
    const item = { ...scheduled, attempt: nextAttempt.get(scheduled.runId) };
    const corpus = corpusById.get(item.corpus);
    const engine = engineById.get(item.engine);
    process.stdout.write(`run  ${item.runId} attempt ${item.attempt}\n`);
    let before = null;
    try {
      assertPinnedExecution(definition);
      before = assertFileIdentity(corpus.archive, { bytes: corpus.archiveBytes, sha256: corpus.archiveSha256 });
      const adapterResult = engine.kind === "hachidori"
        ? await runHachidoriSample({ item, corpus, config, definition, output, launch })
        : engine.kind === "yomitan"
          ? await runYomitanSample({ item, corpus, config, definition, output, launch })
          : await runJlSample({ item, corpus, config, definition, output });
      const after = assertFileIdentity(corpus.archive, { bytes: corpus.archiveBytes, sha256: corpus.archiveSha256 });
      const row = {
        schemaVersion: 1,
        ...item,
        valid: true,
        runDefinitionSha256: sha256Canonical(definition),
        engineIdentitySha256: engine.identitySha256,
        archiveSha256: corpus.archiveSha256,
        archiveBytes: corpus.archiveBytes,
        archiveObservedBeforeSha256: before.sha256,
        archiveObservedBeforeBytes: before.bytes,
        archiveObservedAfterSha256: after.sha256,
        archiveObservedAfterBytes: after.bytes,
        stateDisposition: config.keepProfiles ? "retained" : "deleted-after-persistence",
        ...adapterResult,
      };
      validateComparisonRows([...readRows(), row], schedule, definition, { allowMissing: true });
      appendJsonlDurable(rawPath, row);
      cleanupCompletedProfiles([row], output, config.keepProfiles);
      completed.add(item.runId);
      executed += 1;
      process.stdout.write(`ok   ${item.runId} import=${row.metrics.importUsableWallMs.toFixed(1)}ms\n`);
    } catch (error) {
      const row = failedRow(item, definition, corpus, before, error);
      appendJsonlDurable(rawPath, row);
      process.stderr.write(`${row.error}\n`);
      throw new Error(`${item.runId} failed; diagnostics and a resumable failure row were retained`);
    }
  }
  const current = readRows();
  const validated = validateComparisonRows(current, schedule, definition, { allowMissing: true });
  const validCount = validated.filter((row) => row.valid === true).length;
  if (validCount !== schedule.length) {
    process.stdout.write(`incomplete ${validCount}/${schedule.length} validated runs; rerun the same command to resume\n`);
    return null;
  }
  const finalRows = validateComparisonRows(current, schedule, definition);
  assertPinnedExecution(definition);
  return writeDeliverables(prepared, finalRows, current.length);
}

function artifactNames(prepared) {
  const inputNames = [...new Set([
    ...prepared.config.corpora.map((corpus) => relative(prepared.output, corpus.archive)),
    relative(prepared.output, prepared.definition.runtime.yomitanArchivePath),
  ])].sort();
  return [
    "run-definition.json",
    "schedule.json",
    "raw.jsonl",
    "summary.json",
    "results.csv",
    "report.md",
    "validation.json",
    ...inputNames,
  ];
}

function writeDeliverables(prepared, rows, rawAttemptCount) {
  const runDefinitionSha256 = sha256Canonical(prepared.definition);
  const summaryPath = resolve(prepared.output, "summary.json");
  const existing = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null;
  const completedUtc = existing?.metadata?.completedUtc ?? new Date().toISOString();
  const metadata = {
    mode: "balanced-production-path",
    runDefinitionSha256,
    rawEvidenceSha256: sha256File(resolve(prepared.output, "raw.jsonl")),
    createdUtc: prepared.definition.createdUtc,
    completedUtc,
    revisions: Object.fromEntries(prepared.definition.engines.map((engine) => [engine.id, engine])),
    runtime: {
      nodeVersion: prepared.definition.runtime.nodeVersion,
      chromeVersion: prepared.definition.runtime.chromeVersion,
      puppeteerVersion: prepared.definition.runtime.puppeteerVersion,
      dotnetVersion: prepared.definition.runtime.dotnetVersion,
    },
    hostAtPreparation: prepared.definition.hostAtPreparation,
    hostAtCompletion: existing?.metadata?.hostAtCompletion ?? hostSnapshot(),
  };
  const summary = buildComparisonSummary(rows, prepared.definition, metadata);
  const validation = {
    status: "pass",
    runDefinitionSha256,
    scheduledRuns: prepared.schedule.length,
    rawAttemptCount,
    selectedValidRuns: rows.length,
    warmupRuns: rows.filter((row) => row.warmup).length,
    measuredRuns: rows.filter((row) => !row.warmup).length,
    productionPathsVerified: true,
    archiveIdentityVerifiedBeforeAndAfterEveryRun: true,
    lookupSemanticsStableWithinAndAcrossSamples: true,
    warmupsExcludedFromAggregates: true,
  };
  const csv = renderComparisonCsv(summary);
  const report = renderComparisonMarkdown(summary);
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(summary)
      || readFileSync(resolve(prepared.output, "results.csv"), "utf8") !== csv
      || readFileSync(resolve(prepared.output, "report.md"), "utf8") !== report
      || canonicalJson(JSON.parse(readFileSync(resolve(prepared.output, "validation.json"), "utf8"))) !== canonicalJson(validation)) {
      throw new Error("completed deliverables were altered");
    }
    verifyChecksums(prepared.output);
    return { summary, reportPath: resolve(prepared.output, "report.md") };
  }
  writeJson(summaryPath, summary);
  writeAtomic(resolve(prepared.output, "results.csv"), csv);
  writeAtomic(resolve(prepared.output, "report.md"), report);
  writeJson(resolve(prepared.output, "validation.json"), validation);
  const names = artifactNames(prepared);
  writeAtomic(resolve(prepared.output, "SHA256SUMS"), `${names.map((name) => `${sha256File(resolve(prepared.output, name))}  ${name}`).join("\n")}\n`);
  return { summary, reportPath: resolve(prepared.output, "report.md") };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  mkdirSync(resolve(options.output), { recursive: true });
  const release = acquireFileLock(resolve(options.output, ".lock"), {
    pid: process.pid,
    createdUtc: new Date().toISOString(),
    argv: process.argv,
  });
  try {
    const prepared = await prepare(options);
    process.stdout.write(`definition ${sha256Canonical(prepared.definition)}\n`);
    process.stdout.write(`schedule   ${prepared.schedule.length} balanced runs\n`);
    if (options.dryRun) process.stdout.write("dry-run verified all pinned inputs and runtimes\n");
    else {
      const result = await execute(prepared, options);
      if (result) process.stdout.write(`complete ${result.reportPath}\n`);
    }
  } catch (error) {
    die(error?.stack || error?.message || String(error));
  } finally {
    release();
  }
}
