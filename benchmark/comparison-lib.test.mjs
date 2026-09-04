// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComparisonSummary,
  lookupSemanticSignature,
  makeComparisonSchedule,
  normalizeComparisonConfig,
  renderComparisonCsv,
  renderComparisonMarkdown,
  renderComparisonReadme,
  selectedComparisonQueries,
  validateComparisonRows,
} from "./comparison-lib.mjs";
import { sha256Canonical } from "./lib.mjs";

function config() {
  return normalizeComparisonConfig({
    engines: [
      { id: "hachidori", label: "Hachidori", kind: "hachidori" },
      {
        id: "yomitan",
        label: "Yomitan",
        kind: "yomitan",
        version: "26.7.29.0",
        extensionArchive: "/inputs/yomitan.zip",
        expectedSha256: "1".repeat(64),
      },
      {
        id: "jl",
        label: "JL",
        kind: "jl",
        version: "4.3.0",
        source: "/sources/jl",
        expectedCommit: "2".repeat(40),
      },
    ],
    corpora: [
      { id: "jitendex", archive: "/inputs/jitendex.zip", queryIds: ["hit", "miss"] },
      { id: "pixiv-light", archive: "/inputs/pixiv.zip", queryIds: ["hit", "miss"] },
    ],
    queries: [
      { id: "hit", text: "食べる", expect: "hit", expectedExpression: "食べる" },
      { id: "miss", text: "🫠🫨🪼", expect: "miss" },
    ],
    warmups: 1,
    samples: 1,
    lookupPasses: 2,
    seed: 7,
  }, "/repo/benchmark");
}

function fixture() {
  const normalized = config();
  normalized.corpora = normalized.corpora.map((corpus, index) => ({
    ...corpus,
    archiveSha256: String(index + 3).repeat(64),
    archiveBytes: 1000 + index,
  }));
  const engines = normalized.engines.map((engine) => {
    const pinned = engine.kind === "hachidori"
      ? { ...engine, commit: "a".repeat(40) }
      : engine.kind === "yomitan"
        ? { ...engine, archiveSha256: "1".repeat(64) }
        : { ...engine, commit: "2".repeat(40) };
    return { ...pinned, identitySha256: sha256Canonical(pinned) };
  });
  const schedule = makeComparisonSchedule(
    engines.map((engine) => engine.id),
    normalized.corpora.map((corpus) => corpus.id),
    normalized,
  );
  const definition = { schemaVersion: 1, config: normalized, engines, schedule };
  const definitionHash = sha256Canonical(definition);
  const evidenceFor = (engine) => {
    if (engine.kind === "hachidori") return {
      verified: true,
      adapter: "hachidori-browser-extension",
      importPath: "settings.html#dictionary-import-file-input",
      lookupPath: "chrome.runtime.sendMessage:hd_lookup",
      threaded: true,
      storageBackend: "opfs",
      persistenceRestartVerified: true,
      artifactSnapshotVerified: true,
      extensionId: "a".repeat(32),
    };
    if (engine.kind === "yomitan") return {
      verified: true,
      adapter: "yomitan-browser-extension",
      manifestVersion: "26.7.29.0",
      importPath: "settings.html#dictionary-import-file-input",
      lookupPath: "chrome.runtime.sendMessage:termsFind",
      installedDictionaryCount: 1,
      enabledDictionaryCount: 1,
      importTransitionObserved: true,
      dictionaryInfo: [{}],
      extensionId: "b".repeat(32),
    };
    return {
      verified: true,
      adapter: "jl-core",
      assembly: "JL.Core, Version=4.3.0.0, Culture=neutral, PublicKeyToken=null",
      sourceCommit: "2".repeat(40),
      loadPath: "JL.Core.Dicts.DictUtils.LoadDictionaries",
      lookupPath: "JL.Core.Lookup.LookupUtils.LookupText",
      dictionaryActive: true,
      dictionaryReady: true,
      cleanupVerified: true,
      moduleVersionId: "12345678-1234-1234-1234-123456789abc",
    };
  };
  const rows = schedule.map((item) => {
    const engine = engines.find((entry) => entry.id === item.engine);
    const corpus = normalized.corpora.find((entry) => entry.id === item.corpus);
    const queries = selectedComparisonQueries(normalized, item.corpus);
    const details = queries.map((query, index) => ({
      queryId: query.id,
      text: query.text,
      latencyMs: index + 1,
      resultCount: query.expect === "hit" ? 1 : 0,
      expressions: query.expect === "hit" ? ["食べる"] : [],
      responseSha256: sha256Canonical({ engine: item.engine, corpus: item.corpus, query: query.id }),
    }));
    const semanticSha256 = lookupSemanticSignature(details);
    const dataset = (index) => ({
      ...(index === undefined ? {} : { index }),
      wallMs: details.reduce((total, detail) => total + detail.latencyMs, 0) + 1,
      details: structuredClone(details),
      semanticSha256,
    });
    const first = details.find((detail) => detail.resultCount > 0);
    return {
      schemaVersion: 1,
      ...item,
      attempt: 0,
      valid: true,
      runDefinitionSha256: definitionHash,
      engineIdentitySha256: engine.identitySha256,
      archiveSha256: corpus.archiveSha256,
      archiveBytes: corpus.archiveBytes,
      archiveObservedBeforeSha256: corpus.archiveSha256,
      archiveObservedBeforeBytes: corpus.archiveBytes,
      archiveObservedAfterSha256: corpus.archiveSha256,
      archiveObservedAfterBytes: corpus.archiveBytes,
      processExitVerified: true,
      metrics: { importUsableWallMs: item.warmup ? 9999 : 1000 + item.order, importCoreWallMs: 900 },
      firstLookup: structuredClone(first),
      lookup: {
        warmupExcluded: true,
        queryIds: queries.map((query) => query.id),
        queryFixtureSha256: sha256Canonical(queries),
        semanticSha256,
        warmup: dataset(),
        passes: [dataset(0), dataset(1)],
      },
      productionEvidence: evidenceFor(engine),
    };
  });
  return { normalized, schedule, definition, rows };
}

test("comparison schedule rotates every engine/corpus cell through every position", () => {
  const normalized = config();
  const schedule = makeComparisonSchedule(
    normalized.engines.map((engine) => engine.id),
    normalized.corpora.map((corpus) => corpus.id),
    { ...normalized, samples: 5 },
  );
  assert.equal(schedule.length, 36);
  for (let round = 0; round < 6; round += 1) {
    const rows = schedule.filter((entry) => entry.round === round);
    assert.equal(rows.length, 6);
    assert.equal(new Set(rows.map((entry) => `${entry.engine}/${entry.corpus}`)).size, 6);
  }
  for (const engine of normalized.engines) {
    for (const corpus of normalized.corpora) {
      const positions = schedule
        .filter((entry) => entry.engine === engine.id && entry.corpus === corpus.id)
        .map((entry) => entry.order)
        .sort((left, right) => left - right);
      assert.deepEqual(positions, [0, 1, 2, 3, 4, 5]);
    }
  }
});

test("comparison config requires the three production engines and resolves paths", () => {
  const normalized = config();
  assert.deepEqual(normalized.engines.map((engine) => engine.kind), ["hachidori", "yomitan", "jl"]);
  assert.equal(normalized.engines[1].extensionArchive, "/inputs/yomitan.zip");
  assert.equal(normalized.engines[2].source, "/sources/jl");
  assert.throws(
    () => normalizeComparisonConfig({
      engines: [{ id: "hachidori", label: "Hachidori", kind: "hachidori" }],
      corpora: [{ id: "a", archive: "a.zip" }],
      queries: [{ id: "q", text: "x", expect: "hit" }],
    }, "/tmp"),
    /missing the yomitan engine/i,
  );
});

test("comparison validation binds all raw evidence and fails closed", () => {
  const { schedule, definition, rows } = fixture();
  assert.equal(validateComparisonRows(rows, schedule, definition).length, 12);
  assert.throws(() => validateComparisonRows(rows.slice(1), schedule, definition), /missing run/i);

  const changedArchive = structuredClone(rows);
  changedArchive[0].archiveObservedAfterSha256 = "f".repeat(64);
  assert.throws(() => validateComparisonRows(changedArchive, schedule, definition), /archive identity/i);

  const changedPath = structuredClone(rows);
  changedPath.find((row) => row.engine === "yomitan").productionEvidence.lookupPath = "synthetic";
  assert.throws(() => validateComparisonRows(changedPath, schedule, definition), /production evidence/i);

  const changedLookup = structuredClone(rows);
  changedLookup[0].lookup.passes[0].details[0].resultCount = 0;
  assert.throws(() => validateComparisonRows(changedLookup, schedule, definition), /expectation|signature/i);

  const failed = structuredClone(rows);
  failed[0] = { ...failed[0], valid: false, error: "adapter failed" };
  assert.doesNotThrow(() => validateComparisonRows(failed, schedule, definition, { allowMissing: true }));
  assert.throws(() => validateComparisonRows(failed, schedule, definition), /invalid run/i);
});

test("comparison summary excludes warmups and emits the requested three-row table", () => {
  const { schedule, definition, rows } = fixture();
  const selected = validateComparisonRows(rows, schedule, definition);
  const summary = buildComparisonSummary(selected, definition, { runDefinitionSha256: sha256Canonical(definition) });
  assert.equal(summary.schedule.measuredRuns, 6);
  assert.equal(summary.engines.hachidori.importUsableWallMsByCorpus.jitendex.n, 1);
  assert.ok(summary.engines.hachidori.importUsableWallMsByCorpus.jitendex.median < 2000);
  const readme = renderComparisonReadme(summary);
  assert.match(readme, /\| Hachidori \|/);
  assert.match(readme, /\| Yomitan \|/);
  assert.match(readme, /\| JL \|/);
  assert.equal(readme.split("\n").filter((line) => /^\| (Hachidori|Yomitan|JL) \|/.test(line)).length, 3);
  assert.match(readme, /full benchmark methodology/);
  assert.match(renderComparisonMarkdown(summary), /Production paths/);
  assert.match(renderComparisonCsv(summary), /^engine,corpus,metric,unit,median,p95,min,max,n/m);
});
