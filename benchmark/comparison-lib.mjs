// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  canonicalJson,
  normalizeConfig,
  orderQueries,
  sha256Canonical,
  summarizeValues,
} from "./lib.mjs";

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireHash(value, label) {
  const hash = requireString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${label} must be a SHA-256 hash`);
  return hash;
}

function finite(value, label, { positive = false, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)
    || value < (positive ? Number.EPSILON : 0) || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} is not a valid ${integer ? "integer" : "number"}`);
  }
  return value;
}

function expandPath(value, baseDirectory, environment, label) {
  const expanded = requireString(value, label).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name) => {
      const replacement = environment[name];
      if (typeof replacement !== "string" || replacement === "") {
        throw new Error(`${label} environment variable ${name} is not set`);
      }
      return replacement;
    },
  );
  return resolve(baseDirectory, expanded);
}

export function normalizeComparisonConfig(raw, baseDirectory, environment = process.env) {
  requireObject(raw, "config");
  if (!Array.isArray(raw.engines) || raw.engines.length === 0) {
    throw new Error("config needs at least one engine");
  }
  const common = normalizeConfig(raw, baseDirectory, environment);
  const ids = new Set();
  const kinds = new Set();
  const engines = raw.engines.map((entry, index) => {
    requireObject(entry, `engine ${index}`);
    const id = requireString(entry.id, `engine ${index} id`);
    const label = requireString(entry.label, `engine ${id} label`);
    const kind = requireString(entry.kind, `engine ${id} kind`);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`engine ${id} has an invalid id`);
    if (ids.has(id)) throw new Error(`duplicate engine id ${id}`);
    if (kinds.has(kind)) throw new Error(`duplicate engine kind ${kind}`);
    if (!["hachidori", "yomitan", "jl"].includes(kind)) throw new Error(`engine ${id} has unsupported kind ${kind}`);
    ids.add(id);
    kinds.add(kind);
    if (kind === "hachidori") return { id, label, kind };
    if (kind === "yomitan") {
      return {
        id,
        label,
        kind,
        version: requireString(entry.version, `engine ${id} version`),
        extensionArchive: expandPath(entry.extensionArchive, baseDirectory, environment, `engine ${id} extensionArchive`),
        expectedSha256: requireHash(entry.expectedSha256, `engine ${id} expectedSha256`),
      };
    }
    const expectedCommit = requireString(entry.expectedCommit, `engine ${id} expectedCommit`).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error(`engine ${id} expectedCommit must be a Git commit`);
    return {
      id,
      label,
      kind,
      version: requireString(entry.version, `engine ${id} version`),
      source: expandPath(entry.source, baseDirectory, environment, `engine ${id} source`),
      expectedCommit,
    };
  });
  for (const required of ["hachidori", "yomitan", "jl"]) {
    if (!kinds.has(required)) throw new Error(`comparison config is missing the ${required} engine`);
  }
  return { ...common, engines };
}

function scheduleKey(seed, cell) {
  return createHash("sha256")
    .update(`comparison-schedule-v1\u0000${seed}\u0000${cell.engine}\u0000${cell.corpus}`)
    .digest("hex");
}

export function makeComparisonSchedule(engineIds, corpusIds, { warmups, samples, seed }) {
  const cells = engineIds.flatMap((engine) => corpusIds.map((corpus) => ({ engine, corpus })))
    .sort((left, right) => scheduleKey(seed, left).localeCompare(scheduleKey(seed, right))
      || left.engine.localeCompare(right.engine) || left.corpus.localeCompare(right.corpus));
  const schedule = [];
  for (let round = 0; round < warmups + samples; round += 1) {
    const warmup = round < warmups;
    const iteration = warmup ? round : round - warmups;
    cells.forEach((_, order) => {
      const cell = cells[(order + round) % cells.length];
      schedule.push({
        ...cell,
        warmup,
        round,
        iteration,
        order,
        runId: `${warmup ? "warmup" : "sample"}-${String(iteration).padStart(2, "0")}-${String(order).padStart(2, "0")}-${cell.engine}-${cell.corpus}`,
      });
    });
  }
  return schedule;
}

export function selectedComparisonQueries(config, corpusId) {
  const corpus = config.corpora.find((entry) => entry.id === corpusId);
  if (!corpus) throw new Error(`unknown corpus ${corpusId}`);
  const queryById = new Map(config.queries.map((query) => [query.id, query]));
  const selected = corpus.queryIds
    ? corpus.queryIds.map((queryId) => queryById.get(queryId))
    : config.queries;
  return orderQueries(selected, { seed: config.seed, corpus: corpus.id });
}

function expectedFor(query, key, corpus) {
  return Object.prototype.hasOwnProperty.call(query[`${key}ByCorpus`] ?? {}, corpus)
    ? query[`${key}ByCorpus`][corpus]
    : query[key];
}

function normalizedExpressions(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} expressions are invalid`);
  }
  const normalized = [...new Set(value)].sort();
  if (canonicalJson(value) !== canonicalJson(normalized)) {
    throw new Error(`${label} expressions must be sorted and unique`);
  }
  return normalized;
}

export function lookupSemanticSignature(details) {
  return sha256Canonical(details.map((detail) => ({
    queryId: detail.queryId,
    text: detail.text,
    resultCount: detail.resultCount,
    expressions: detail.expressions,
    responseSha256: detail.responseSha256,
  })));
}

function validateLookupDataset(dataset, queries, engine, corpus, label, expectedIndex) {
  requireObject(dataset, label);
  finite(dataset.wallMs, `${label} wallMs`, { positive: true });
  if (expectedIndex !== undefined && dataset.index !== expectedIndex) {
    throw new Error(`${label} index ${dataset.index}, expected ${expectedIndex}`);
  }
  if (!Array.isArray(dataset.details) || dataset.details.length !== queries.length) {
    throw new Error(`${label} does not contain exactly ${queries.length} query details`);
  }
  let latencyTotal = 0;
  dataset.details.forEach((detail, index) => {
    requireObject(detail, `${label} detail ${index}`);
    const query = queries[index];
    if (detail.queryId !== query.id || detail.text !== query.text) {
      throw new Error(`${label} detail ${index} does not match query ${query.id}`);
    }
    finite(detail.latencyMs, `${label} ${query.id} latencyMs`);
    finite(detail.resultCount, `${label} ${query.id} resultCount`, { integer: true });
    normalizedExpressions(detail.expressions, `${label} ${query.id}`);
    requireHash(detail.responseSha256, `${label} ${query.id} responseSha256`);
    latencyTotal += detail.latencyMs;
    const expectation = expectedFor(query, "expect", corpus);
    if ((expectation === "hit" && detail.resultCount === 0)
      || (expectation === "miss" && detail.resultCount !== 0)) {
      throw new Error(`${engine}/${corpus} ${query.id} violates its ${expectation} expectation`);
    }
    const expectedExpression = expectedFor(query, "expectedExpression", corpus);
    if (expectedExpression !== undefined && !detail.expressions.includes(expectedExpression)) {
      throw new Error(`${engine}/${corpus} ${query.id} is missing ${JSON.stringify(expectedExpression)}`);
    }
  });
  if (dataset.wallMs + 0.001 < latencyTotal) {
    throw new Error(`${label} wallMs is shorter than its sequential query measurements`);
  }
  const signature = lookupSemanticSignature(dataset.details);
  if (dataset.semanticSha256 !== signature) throw new Error(`${label} semantic signature does not match its evidence`);
  return signature;
}

function validateFirstLookup(first, queries, engine, corpus, label) {
  requireObject(first, label);
  finite(first.latencyMs, `${label} latencyMs`);
  const query = queries.find((entry) => entry.id === first.queryId);
  if (!query || expectedFor(query, "expect", corpus) !== "hit") {
    throw new Error(`${label} did not use a pinned hit query`);
  }
  finite(first.resultCount, `${label} resultCount`, { integer: true });
  if (first.resultCount === 0) throw new Error(`${label} returned no results`);
  normalizedExpressions(first.expressions, label);
  requireHash(first.responseSha256, `${label} responseSha256`);
  const expectedExpression = expectedFor(query, "expectedExpression", corpus);
  if (expectedExpression !== undefined && !first.expressions.includes(expectedExpression)) {
    throw new Error(`${engine}/${corpus} first lookup is missing ${JSON.stringify(expectedExpression)}`);
  }
}

function validateProductionEvidence(row, engineDefinition) {
  const evidence = requireObject(row.productionEvidence, `${row.runId} productionEvidence`);
  if (evidence.verified !== true) throw new Error(`${row.runId} production path is not verified`);
  if (engineDefinition.kind === "hachidori") {
    if (evidence.adapter !== "hachidori-browser-extension"
      || evidence.importPath !== "settings.html#dictionary-import-file-input"
      || evidence.lookupPath !== "chrome.runtime.sendMessage:hd_lookup"
      || evidence.threaded !== true || evidence.storageBackend !== "opfs"
      || evidence.persistenceRestartVerified !== true
      || evidence.artifactSnapshotVerified !== true
      || !/^[a-p]{32}$/.test(evidence.extensionId ?? "")) {
      throw new Error(`${row.runId} Hachidori production evidence is invalid`);
    }
    return sha256Canonical({
      adapter: evidence.adapter,
      extensionId: evidence.extensionId,
      threaded: evidence.threaded,
      storageBackend: evidence.storageBackend,
    });
  } else if (engineDefinition.kind === "yomitan") {
    if (evidence.adapter !== "yomitan-browser-extension"
      || evidence.manifestVersion !== engineDefinition.version
      || evidence.importPath !== "settings.html#dictionary-import-file-input"
      || evidence.lookupPath !== "chrome.runtime.sendMessage:termsFind"
      || evidence.installedDictionaryCount !== 1
      || evidence.enabledDictionaryCount !== 1
      || evidence.importTransitionObserved !== true
      || !Array.isArray(evidence.dictionaryInfo) || evidence.dictionaryInfo.length !== 1
      || !/^[a-p]{32}$/.test(evidence.extensionId ?? "")) {
      throw new Error(`${row.runId} Yomitan production evidence is invalid`);
    }
    return sha256Canonical({
      adapter: evidence.adapter,
      extensionId: evidence.extensionId,
      manifestVersion: evidence.manifestVersion,
    });
  }
  const assembly = requireString(evidence.assembly, `${row.runId} JL assembly`);
  if (evidence.adapter !== "jl-core"
    || evidence.sourceCommit !== engineDefinition.commit
    || evidence.loadPath !== "JL.Core.Dicts.DictUtils.LoadDictionaries"
    || evidence.lookupPath !== "JL.Core.Lookup.LookupUtils.LookupText"
    || evidence.dictionaryActive !== true || evidence.dictionaryReady !== true
    || evidence.cleanupVerified !== true
    || !/^[0-9a-f-]{36}$/i.test(evidence.moduleVersionId ?? "")) {
    throw new Error(`${row.runId} JL production evidence is invalid`);
  }
  return sha256Canonical({
    adapter: evidence.adapter,
    assembly,
    moduleVersionId: evidence.moduleVersionId,
    sourceCommit: evidence.sourceCommit,
  });
}

function validateSuccessfulRow(row, item, definition, baselines) {
  const config = definition.config;
  const corpus = config.corpora.find((entry) => entry.id === row.corpus);
  const engine = definition.engines.find((entry) => entry.id === row.engine);
  if (!corpus || !engine) throw new Error(`${row.runId} references an unknown cell`);
  if (row.schemaVersion !== 1 || row.runDefinitionSha256 !== sha256Canonical(definition)) {
    throw new Error(`${row.runId} does not match the pinned run definition`);
  }
  for (const key of ["runId", "engine", "corpus", "warmup", "round", "iteration", "order"]) {
    if (row[key] !== item[key]) throw new Error(`${row.runId} does not match schedule field ${key}`);
  }
  const expectedEngineIdentity = sha256Canonical(Object.fromEntries(
    Object.entries(engine).filter(([key]) => key !== "identitySha256"),
  ));
  if (engine.identitySha256 !== expectedEngineIdentity || row.engineIdentitySha256 !== engine.identitySha256) {
    throw new Error(`${row.runId} engine identity is inconsistent`);
  }
  if (row.archiveSha256 !== corpus.archiveSha256 || row.archiveBytes !== corpus.archiveBytes
    || row.archiveObservedBeforeSha256 !== corpus.archiveSha256
    || row.archiveObservedAfterSha256 !== corpus.archiveSha256
    || row.archiveObservedBeforeBytes !== corpus.archiveBytes
    || row.archiveObservedAfterBytes !== corpus.archiveBytes) {
    throw new Error(`${row.runId} archive identity is inconsistent`);
  }
  if (row.processExitVerified !== true) throw new Error(`${row.runId} process exit was not verified`);
  const metrics = requireObject(row.metrics, `${row.runId} metrics`);
  finite(metrics.importUsableWallMs, `${row.runId} importUsableWallMs`, { positive: true });
  if (metrics.importCoreWallMs !== undefined && metrics.importCoreWallMs !== null) {
    finite(metrics.importCoreWallMs, `${row.runId} importCoreWallMs`, { positive: true });
    if (metrics.importCoreWallMs > metrics.importUsableWallMs) {
      throw new Error(`${row.runId} core import exceeds import-to-usable timing`);
    }
  }
  const queries = selectedComparisonQueries(config, row.corpus);
  if (row.lookup?.warmupExcluded !== true
    || row.lookup.queryFixtureSha256 !== sha256Canonical(queries)
    || canonicalJson(row.lookup.queryIds) !== canonicalJson(queries.map((query) => query.id))) {
    throw new Error(`${row.runId} lookup fixture evidence is invalid`);
  }
  const warmSignature = validateLookupDataset(
    row.lookup.warmup,
    queries,
    row.engine,
    row.corpus,
    `${row.runId} lookup warmup`,
    undefined,
  );
  if (!Array.isArray(row.lookup.passes) || row.lookup.passes.length !== config.lookupPasses) {
    throw new Error(`${row.runId} measured lookup pass count is invalid`);
  }
  row.lookup.passes.forEach((pass, index) => {
    const signature = validateLookupDataset(
      pass,
      queries,
      row.engine,
      row.corpus,
      `${row.runId} lookup pass ${index}`,
      index,
    );
    if (signature !== warmSignature) throw new Error(`${row.runId} lookup semantics drift within the sample`);
  });
  if (row.lookup.semanticSha256 !== warmSignature) throw new Error(`${row.runId} lookup signature is inconsistent`);
  validateFirstLookup(row.firstLookup, queries, row.engine, row.corpus, `${row.runId} first lookup`);
  if (metrics.importUsableWallMs < row.firstLookup.latencyMs) {
    throw new Error(`${row.runId} import-to-usable timing excludes its first lookup`);
  }
  const productionSignature = validateProductionEvidence(row, engine);
  const productionKey = `production\u0000${row.engine}`;
  if (!baselines.has(productionKey)) baselines.set(productionKey, productionSignature);
  else if (baselines.get(productionKey) !== productionSignature) {
    throw new Error(`${row.engine} production identity drifted across samples`);
  }
  const baselineKey = `${row.engine}\u0000${row.corpus}`;
  if (!baselines.has(baselineKey)) baselines.set(baselineKey, warmSignature);
  else if (baselines.get(baselineKey) !== warmSignature) {
    throw new Error(`${row.engine}/${row.corpus} lookup semantics drift across samples`);
  }
}

export function validateComparisonRows(rows, schedule, definition, { allowMissing = false } = {}) {
  if (!Array.isArray(rows)) throw new Error("raw rows must be an array");
  if (canonicalJson(schedule) !== canonicalJson(definition.schedule)) {
    throw new Error("schedule does not match the pinned run definition");
  }
  const scheduled = new Map(schedule.map((item) => [item.runId, item]));
  const attempts = new Map();
  const seenAttempts = new Set();
  for (const row of rows) {
    const item = scheduled.get(row?.runId);
    if (!item) throw new Error(`unexpected run ${row?.runId}`);
    finite(row.attempt, `${row.runId} attempt`, { integer: true });
    const key = `${row.runId}\u0000${row.attempt}`;
    if (seenAttempts.has(key)) throw new Error(`duplicate run attempt ${row.runId}#${row.attempt}`);
    seenAttempts.add(key);
    if (!attempts.has(row.runId)) attempts.set(row.runId, []);
    attempts.get(row.runId).push(row);
  }
  const latest = new Map();
  for (const [runId, entries] of attempts) {
    entries.sort((left, right) => left.attempt - right.attempt);
    entries.forEach((entry, index) => {
      if (entry.attempt !== index) throw new Error(`${runId} attempts must be contiguous from zero`);
      if (index < entries.length - 1 && entry.valid === true) {
        throw new Error(`${runId} has an attempt after a validated result`);
      }
    });
    latest.set(runId, entries.at(-1));
  }
  const baselines = new Map();
  const selected = [];
  for (const item of schedule) {
    const row = latest.get(item.runId);
    if (!row) {
      if (allowMissing) continue;
      throw new Error(`missing run ${item.runId}`);
    }
    selected.push(row);
    if (row.valid !== true) {
      if (allowMissing) continue;
      throw new Error(`invalid run ${item.runId}: ${row.error ?? "no detail"}`);
    }
    validateSuccessfulRow(row, item, definition, baselines);
  }
  return selected;
}

function comparisonCellStats(rows, value) {
  return summarizeValues(rows.map(value));
}

export function buildComparisonSummary(rows, definition, metadata = {}) {
  const measured = rows.filter((row) => !row.warmup && row.valid === true);
  if (measured.length === 0) throw new Error("cannot summarize an empty comparison");
  const engines = {};
  for (const engine of definition.engines) {
    const engineRows = measured.filter((row) => row.engine === engine.id);
    if (engineRows.length === 0) throw new Error(`no measured rows for ${engine.id}`);
    const importByCorpus = {};
    for (const corpus of definition.config.corpora) {
      const cellRows = engineRows.filter((row) => row.corpus === corpus.id);
      if (cellRows.length !== definition.config.samples) {
        throw new Error(`${engine.id}/${corpus.id} has ${cellRows.length} measured rows`);
      }
      importByCorpus[corpus.id] = comparisonCellStats(cellRows, (row) => row.metrics.importUsableWallMs);
    }
    const perRunThroughput = engineRows.map((row) => summarizeValues(row.lookup.passes.map(
      (pass) => pass.details.length / (pass.wallMs / 1000),
    )).median);
    const allPassThroughput = engineRows.flatMap((row) => row.lookup.passes.map(
      (pass) => pass.details.length / (pass.wallMs / 1000),
    ));
    const allLatencies = engineRows.flatMap((row) => row.lookup.passes.flatMap(
      (pass) => pass.details.map((detail) => detail.latencyMs),
    ));
    engines[engine.id] = {
      label: engine.label,
      kind: engine.kind,
      identitySha256: engine.identitySha256,
      measuredRuns: engineRows.length,
      importUsableWallMsByCorpus: importByCorpus,
      lookupThroughputQueriesPerSecond: summarizeValues(perRunThroughput),
      lookupPassThroughputQueriesPerSecond: summarizeValues(allPassThroughput),
      lookupRequestLatencyMs: summarizeValues(allLatencies),
    };
  }
  return {
    schemaVersion: 1,
    benchmark: "Hachidori cross-engine comparison",
    measurementContract: {
      import: "archive handoff through production import, engine-ready validation, and the first correctness-checked hit",
      lookup: "sequential production lookup calls over the pinned corpus-specific query fixture after one excluded warmup pass",
      aggregation: "each independent fresh-profile run contributes its median pass throughput; the engine result is the median of those run medians across both corpora",
      warmupsExcluded: true,
    },
    schedule: {
      seed: definition.config.seed,
      warmupsPerCell: definition.config.warmups,
      measuredSamplesPerCell: definition.config.samples,
      lookupPassesPerRun: definition.config.lookupPasses,
      scheduledRuns: definition.schedule.length,
      measuredRuns: measured.length,
    },
    corpora: Object.fromEntries(definition.config.corpora.map((corpus) => [corpus.id, {
      archiveSha256: corpus.archiveSha256,
      archiveBytes: corpus.archiveBytes,
      queryIds: selectedComparisonQueries(definition.config, corpus.id).map((query) => query.id),
      queryFixtureSha256: sha256Canonical(selectedComparisonQueries(definition.config, corpus.id)),
    }])),
    engines,
    metadata,
  };
}

function fixed(value, digits = 2) {
  return Number(value).toFixed(digits);
}

function range(stats, divisor = 1, digits = 2) {
  return `${fixed(stats.median / divisor, digits)} [${fixed(stats.min / divisor, digits)}–${fixed(stats.max / divisor, digits)}]`;
}

export function renderComparisonReadme(summary, docsPath = "docs/benchmarks.md") {
  const lines = [
    "| Engine | Jitendex import | Pixiv Light import | Lookup speed |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const engine of Object.values(summary.engines)) {
    lines.push(`| ${engine.label} | ${fixed(engine.importUsableWallMsByCorpus.jitendex.median / 1000, 2)} s | ${fixed(engine.importUsableWallMsByCorpus["pixiv-light"].median / 1000, 2)} s | ${fixed(engine.lookupThroughputQueriesPerSecond.median, 0)} lookups/s |`);
  }
  lines.push("", `See the [full benchmark methodology, provenance, and results](${docsPath}).`);
  return `${lines.join("\n")}\n`;
}

export function renderComparisonMarkdown(summary) {
  const lines = [
    "# Cross-engine benchmarks",
    "",
    "Measured-sample values are medians `[min–max]`. The outer warmup for every engine/corpus cell and each adapter's lookup warmup are excluded.",
    "",
    "## Results",
    "",
    renderComparisonReadme(summary).trim(),
    "",
    "| Engine | Corpus | Import → usable | Independent runs |",
    "| --- | --- | ---: | ---: |",
  ];
  for (const engine of Object.values(summary.engines)) {
    for (const corpus of ["jitendex", "pixiv-light"]) {
      const stats = engine.importUsableWallMsByCorpus[corpus];
      lines.push(`| ${engine.label} | ${corpus} | ${range(stats, 1000)} s | ${stats.n} |`);
    }
  }
  lines.push(
    "",
    "| Engine | Lookup run throughput | Pass throughput | Request latency | Independent runs |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  for (const engine of Object.values(summary.engines)) {
    lines.push(`| ${engine.label} | ${range(engine.lookupThroughputQueriesPerSecond, 1, 0)} lookups/s | ${range(engine.lookupPassThroughputQueriesPerSecond, 1, 0)} lookups/s | ${range(engine.lookupRequestLatencyMs)} ms | ${engine.lookupThroughputQueriesPerSecond.n} |`);
  }
  lines.push(
    "",
    "## Measurement contract",
    "",
    `- **Import:** ${summary.measurementContract.import}.`,
    `- **Lookup:** ${summary.measurementContract.lookup}.`,
    `- **Aggregation:** ${summary.measurementContract.aggregation}.`,
    "- Every engine uses a fresh profile or database for every scheduled cell.",
    "- Cells run one at a time in a deterministic rotating schedule so engines do not contend with one another.",
    "- A result is rejected if any scheduled cell is absent, an input hash changes, a production-path proof is missing, or lookup semantics drift.",
    "",
    "## Production paths",
    "",
    "- **Hachidori:** the real Chrome settings file input, `chrome.runtime` service-worker/offscreen bridge, pthread WebAssembly engine, and direct OPFS storage.",
    "- **Yomitan:** the stable Chrome extension's real settings file input and backend `termsFind` action.",
    "- **JL:** release 4.3.0's `JL.Core` methods `DictUtils.LoadDictionaries()` and `LookupUtils.LookupText()`.",
    "",
    "## Inputs",
    "",
    "| Corpus | SHA-256 | Bytes | Ordered queries |",
    "| --- | --- | ---: | --- |",
  );
  for (const [id, corpus] of Object.entries(summary.corpora)) {
    lines.push(`| ${id} | \`${corpus.archiveSha256}\` | ${corpus.archiveBytes} | ${corpus.queryIds.map((id_) => `\`${id_}\``).join(", ")} |`);
  }
  lines.push(
    "",
    "## Schedule and provenance",
    "",
    `- Seed: \`${summary.schedule.seed}\``,
    `- Excluded outer warmups: \`${summary.schedule.warmupsPerCell}\` per engine/corpus cell`,
    `- Measured samples: \`${summary.schedule.measuredSamplesPerCell}\` per engine/corpus cell`,
    `- Measured lookup passes: \`${summary.schedule.lookupPassesPerRun}\` per fresh-profile run`,
    `- Scheduled runs: \`${summary.schedule.scheduledRuns}\``,
    `- Run definition: \`${summary.metadata.runDefinitionSha256}\``,
    "",
    "Raw per-run and per-query measurements, the deterministic schedule, validation record, and checksums accompany the published benchmark artifacts.",
    "",
    "```json",
    JSON.stringify(summary.metadata, null, 2),
    "```",
    "",
  );
  return lines.join("\n");
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderComparisonCsv(summary) {
  const rows = [["engine", "corpus", "metric", "unit", "median", "p95", "min", "max", "n"]];
  const add = (engine, corpus, metric, unit, stats) => rows.push([
    engine, corpus, metric, unit, stats.median, stats.p95, stats.min, stats.max, stats.n,
  ]);
  for (const [id, engine] of Object.entries(summary.engines)) {
    for (const [corpus, stats] of Object.entries(engine.importUsableWallMsByCorpus)) {
      add(id, corpus, "import_usable_wall", "ms", stats);
    }
    add(id, "all", "lookup_run_throughput", "lookups/s", engine.lookupThroughputQueriesPerSecond);
    add(id, "all", "lookup_pass_throughput", "lookups/s", engine.lookupPassThroughputQueriesPerSecond);
    add(id, "all", "lookup_request_latency", "ms", engine.lookupRequestLatencyMs);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}
