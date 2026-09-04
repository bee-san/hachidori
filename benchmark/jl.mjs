// SPDX-License-Identifier: GPL-3.0-or-later

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { lookupSemanticSignature, selectedComparisonQueries } from "./comparison-lib.mjs";
import { sha256Canonical } from "./lib.mjs";
import { hostSnapshot, sha256File, startProcessSampler } from "./system.mjs";

function runProcess(executable, args, { cwd, environment = process.env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const limit = 16 * 1024 * 1024;
    const append = (current, chunk, stream) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > limit) {
        child.kill("SIGKILL");
        throw new Error(`${stream} exceeded ${limit} bytes`);
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk, "stdout"); } catch (error) { reject(error); }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk, "stderr"); } catch (error) { reject(error); }
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${executable} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, pid: child.pid });
    });
  });
}

function runProcessSampled(executable, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!Number.isInteger(child.pid)) {
      reject(new Error("JL process did not start"));
      return;
    }
    const sampler = startProcessSampler(child.pid);
    let stdout = "";
    let stderr = "";
    const limit = 16 * 1024 * 1024;
    let settled = false;
    let timer = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      try { sampler.stop(); } catch {}
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > limit) fail(new Error(`JL stdout exceeded ${limit} bytes`));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > limit) fail(new Error(`JL stderr exceeded ${limit} bytes`));
    });
    child.once("error", fail);
    timer = setTimeout(() => fail(new Error(`JL timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let resources;
      try { resources = sampler.stop(); } catch (error) { return reject(error); }
      resolvePromise({ code, signal, stdout, stderr, resources, pid: child.pid });
    });
  });
}

export async function buildJlAdapter({ dotnetPath, sourcePath, outputPath, timeoutMs }) {
  rmSync(outputPath, { recursive: true, force: true });
  mkdirSync(outputPath, { recursive: true });
  const project = resolve(import.meta.dirname, "jl", "JLBenchmark.csproj");
  const result = await runProcess(dotnetPath, [
    "build",
    project,
    "-c", "Release",
    "-o", outputPath,
    "--nologo",
    "-p:NuGetAudit=false",
    "-p:RunAnalyzers=false",
    "-p:TreatWarningsAsErrors=false",
  ], {
    cwd: import.meta.dirname,
    timeoutMs,
    environment: { ...process.env, JLSource: sourcePath },
  });
  if (result.code !== 0) {
    throw new Error(`JL adapter build failed (${result.code ?? result.signal}):\n${result.stdout}\n${result.stderr}`);
  }
  const adapterPath = resolve(outputPath, "JL.Core.Tests.dll");
  const corePath = resolve(outputPath, "JL.Core.dll");
  if (!existsSync(adapterPath) || !existsSync(corePath)) throw new Error("JL adapter build did not produce the expected assemblies");
  return {
    adapterPath,
    adapterSha256: sha256File(adapterPath),
    corePath,
    coreSha256: sha256File(corePath),
    buildStdoutSha256: sha256Canonical(result.stdout),
    buildStderrSha256: sha256Canonical(result.stderr),
  };
}

function normalizeDetail(detail) {
  const expressions = [...new Set(detail.expressions)].sort();
  return {
    queryId: detail.queryId,
    text: detail.text,
    latencyMs: detail.latencyMs,
    resultCount: detail.resultCount,
    expressions,
    responseSha256: sha256Canonical({ resultCount: detail.resultCount, expressions }),
  };
}

function normalizeDataset(dataset) {
  const details = dataset.details.map(normalizeDetail);
  return {
    ...(dataset.index === null || dataset.index === undefined ? {} : { index: dataset.index }),
    wallMs: dataset.wallMs,
    details,
    semanticSha256: lookupSemanticSignature(details),
  };
}

function expectedFor(query, key, corpus) {
  return Object.prototype.hasOwnProperty.call(query[`${key}ByCorpus`] ?? {}, corpus)
    ? query[`${key}ByCorpus`][corpus]
    : query[key];
}

export async function runJlSample({ item, corpus, config, definition, output }) {
  const runDirectory = resolve(output, "runs", `${item.runId}-attempt-${String(item.attempt ?? 0).padStart(2, "0")}`);
  rmSync(runDirectory, { recursive: true, force: true });
  mkdirSync(runDirectory, { recursive: true });
  const queries = selectedComparisonQueries(config, corpus.id);
  const firstHit = queries.find((query) => expectedFor(query, "expect", corpus.id) === "hit"
    && typeof expectedFor(query, "expectedExpression", corpus.id) === "string");
  if (!firstHit) throw new Error(`${corpus.id} has no pinned first-hit query`);
  const engine = definition.engines.find((entry) => entry.id === item.engine);
  const payload = {
    archive: corpus.archive,
    workDirectory: resolve(runDirectory, "state"),
    corpus: corpus.id,
    expectedTitle: corpus.expectedReport.title,
    sourceCommit: engine.commit,
    firstHitQueryId: firstHit.id,
    firstHitExpectedExpression: expectedFor(firstHit, "expectedExpression", corpus.id),
    lookupPasses: config.lookupPasses,
    queries: queries.map(({ id, text }) => ({ id, text })),
  };
  const inputPath = resolve(runDirectory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(payload)}\n`);
  const startedUtc = new Date().toISOString();
  const hostStart = hostSnapshot();
  const processResult = await runProcessSampled(
    definition.runtime.dotnetPath,
    [definition.runtime.jlAdapterPath, inputPath],
    {
      cwd: definition.runtime.jlAdapterDirectory,
      timeoutMs: config.timeoutMs,
    },
  );
  writeFileSync(resolve(runDirectory, "stdout.log"), processResult.stdout);
  writeFileSync(resolve(runDirectory, "stderr.log"), processResult.stderr);
  if (processResult.code !== 0) {
    const error = new Error(`JL adapter failed (${processResult.code ?? processResult.signal}): ${processResult.stderr || processResult.stdout}`);
    error.benchmarkContext = {
      runDirectory,
      stdoutSha256: sha256Canonical(processResult.stdout),
      stderrSha256: sha256Canonical(processResult.stderr),
      startedUtc,
      endedUtc: new Date().toISOString(),
      hostStart,
      hostEnd: hostSnapshot(),
    };
    throw error;
  }
  const marker = processResult.stdout.split(/\r?\n/).findLast((line) => line.startsWith("HACHIDORI_JL_RESULT="));
  if (!marker) throw new Error("JL adapter did not emit a result marker");
  const raw = JSON.parse(marker.slice("HACHIDORI_JL_RESULT=".length));
  if (raw.cleanupVerified !== true) throw new Error("JL adapter did not verify state cleanup");
  const warmup = normalizeDataset(raw.warmup);
  const passes = raw.passes.map(normalizeDataset);
  if (passes.some((pass) => pass.semanticSha256 !== warmup.semanticSha256)) {
    throw new Error("JL lookup semantics changed after warmup");
  }
  return {
    metrics: {
      importUsableWallMs: raw.importUsableWallMs,
      importCoreWallMs: raw.importCoreWallMs,
    },
    firstLookup: normalizeDetail(raw.firstLookup),
    lookup: {
      warmupExcluded: true,
      queryIds: queries.map((query) => query.id),
      queryFixtureSha256: sha256Canonical(queries),
      semanticSha256: warmup.semanticSha256,
      warmup,
      passes,
    },
    productionEvidence: {
      verified: true,
      adapter: "jl-core",
      sourceCommit: raw.evidence.sourceCommit,
      assembly: raw.evidence.assembly,
      moduleVersionId: raw.evidence.moduleVersionId,
      loadPath: raw.evidence.loadPath,
      lookupPath: raw.evidence.lookupPath,
      dictionaryActive: raw.evidence.dictionaryActive,
      dictionaryReady: raw.evidence.dictionaryReady,
      dictionarySize: raw.evidence.dictionarySize,
      databaseBytes: raw.evidence.databaseBytes,
      dictionaryTitle: raw.evidence.dictionaryTitle,
      cleanupVerified: raw.cleanupVerified,
    },
    resources: processResult.resources,
    processExitVerified: processResult.code === 0 && processResult.signal === null,
    diagnostics: {
      stdoutSha256: sha256Canonical(processResult.stdout),
      stderrSha256: sha256Canonical(processResult.stderr),
      pid: processResult.pid,
    },
    hostStart,
    hostEnd: hostSnapshot(),
    startedUtc,
    endedUtc: new Date().toISOString(),
  };
}
