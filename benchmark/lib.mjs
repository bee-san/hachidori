// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";
import { resolve } from "node:path";

function sortForCanonicalJson(value) {
  if (value === undefined) throw new Error("canonical JSON does not support undefined");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonical JSON does not support non-finite numbers");
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical JSON supports only plain objects");
    }
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortForCanonicalJson(value[key])]),
    );
  }
  if (!["boolean", "number"].includes(typeof value) && value !== null) {
    throw new Error(`canonical JSON does not support ${typeof value}`);
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function lookupEvidenceSignature(details) {
  return sha256Canonical(details.map((detail) => ({
    queryId: detail.queryId,
    text: detail.text,
    responseType: detail.responseType,
    responseOk: detail.responseOk,
    responseError: detail.responseError,
    resultCount: detail.resultCount,
    expressions: detail.expressions,
    responseBytes: detail.responseBytes,
    responseSha256: detail.responseSha256,
  })));
}

function expectedFor(query, key, corpus) {
  const byCorpus = query[`${key}ByCorpus`];
  if (byCorpus && Object.prototype.hasOwnProperty.call(byCorpus, corpus)) {
    return byCorpus[corpus];
  }
  return query[key];
}

export function orderQueries(queries, { seed, corpus }) {
  const order = (left, right) => {
    const key = (query) => createHash("sha256")
      .update(`lookup-order-v1\u0000${seed}\u0000${corpus}\u0000${query.id}`)
      .digest("hex");
    return key(left).localeCompare(key(right)) || left.id.localeCompare(right.id);
  };
  const hits = queries.filter((query) => expectedFor(query, "expect", corpus) === "hit").sort(order);
  const misses = queries.filter((query) => expectedFor(query, "expect", corpus) === "miss").sort(order);
  const other = queries.filter((query) => !["hit", "miss"].includes(expectedFor(query, "expect", corpus))).sort(order);
  const mixed = [];
  for (let index = 0; index < Math.max(hits.length, misses.length); index += 1) {
    if (index < hits.length) mixed.push(hits[index]);
    if (index < misses.length) mixed.push(misses[index]);
  }
  return [...mixed, ...other];
}

export function validateStoredDictionaries(rows, report, expectedCount) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`storage has ${rows?.length ?? "no"} logical dictionary packages, expected 1`);
  }
  const expectedCapabilities = [
    report.termCount,
    report.frequencyCount,
    report.pitchCount,
    report.kanjiCount,
  ].filter((count) => count > 0).length;
  if (expectedCapabilities !== expectedCount) {
    throw new Error(`stored package has ${expectedCapabilities} capabilities, expected ${expectedCount}`);
  }
  const row = rows[0];
  const suffix = `/${report.title}`;
  const root = typeof row?.path === "string" && row.path.endsWith(suffix)
    ? row.path.slice(0, -suffix.length)
    : "";
  const generationRoot = /^\/dicts\/\.hdw-generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const countKeys = ["termCount", "frequencyCount", "pitchCount", "kanjiCount", "mediaCount"];
  if (!row || !/^[0-9a-f]{32}$/u.test(row.id) || row.title !== report.title
    || row.enabled !== true || !generationRoot.test(root)
    || countKeys.some((key) => row[key] !== report[key])) {
    throw new Error("stored dictionary has an invalid logical dictionary package contract");
  }
  return [{
    id: row.id,
    title: row.title,
    path: row.path,
    enabled: row.enabled,
    ...Object.fromEntries(countKeys.map((key) => [key, row[key]])),
  }];
}

export function analyzeLookupPass(queries, observations, corpus, expectedDictionaryCount) {
  if (!Array.isArray(queries) || !Array.isArray(observations) || queries.length !== observations.length) {
    throw new Error(`lookup observation count mismatch: expected ${queries?.length ?? 0}, got ${observations?.length ?? 0}`);
  }

  const details = [];
  const responseEvidence = {};
  const expectationMismatches = [];
  const latenciesMs = [];
  let hitCount = 0;
  let generation = null;

  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const observation = observations[index];
    if (observation.queryId !== query.id) {
      throw new Error(`lookup observation ${index} is for ${JSON.stringify(observation.queryId)}, expected ${JSON.stringify(query.id)}`);
    }
    const latencyMs = Number(observation.latencyMs);
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new Error(`lookup ${query.id} has invalid latency ${observation.latencyMs}`);
    }
    const reply = observation.reply;
    if (!reply || reply.ok !== true || !Array.isArray(reply.results)) {
      throw new Error(`lookup ${query.id} failed: ${reply?.error ?? "invalid response"}`);
    }
    if (reply.type !== "hd_lookup_result") {
      throw new Error(`lookup ${query.id} has invalid response type ${JSON.stringify(reply.type)}`);
    }
    if (observation.requestId !== undefined && reply.requestId !== observation.requestId) {
      throw new Error(`lookup ${query.id} response requestId does not match`);
    }
    if (reply.error !== null) throw new Error(`lookup ${query.id} returned an unexpected error field`);
    if (!Number.isInteger(reply.generation) || reply.generation < 0) {
      throw new Error(`lookup ${query.id} has invalid generation ${reply.generation}`);
    }
    if (generation === null) generation = reply.generation;
    else if (generation !== reply.generation) throw new Error("lookup engine generation changed within a pass");
    if (expectedDictionaryCount !== undefined && reply.dictionaryCount !== expectedDictionaryCount) {
      throw new Error(`lookup ${query.id} dictionary count ${reply.dictionaryCount}, expected ${expectedDictionaryCount}`);
    }

    const hit = reply.results.length > 0;
    if (hit) hitCount += 1;
    latenciesMs.push(latencyMs);

    const expect = expectedFor(query, "expect", corpus);
    if ((expect === "hit" && !hit) || (expect === "miss" && hit)) {
      expectationMismatches.push({ queryId: query.id, expected: expect, resultCount: reply.results.length });
    }
    const expectedExpression = expectedFor(query, "expectedExpression", corpus);
    const expressions = reply.results
      .map((result) => result?.term?.expression)
      .filter((value) => typeof value === "string");
    if (expectedExpression !== undefined && !expressions.includes(expectedExpression)) {
      expectationMismatches.push({ queryId: query.id, expectedExpression, expressions: [...new Set(expressions)].sort() });
    }

    const response = {
      ok: true,
      error: reply.error ?? null,
      dictionaryCount: reply.dictionaryCount,
      results: reply.results,
    };
    const responseSha256 = sha256Canonical(response);
    const responseBytes = Buffer.byteLength(canonicalJson(response), "utf8");
    responseEvidence[responseSha256] = response;
    details.push({
      queryId: query.id,
      text: query.text,
      requestId: reply.requestId,
      responseType: reply.type,
      responseOk: reply.ok,
      responseError: reply.error,
      latencyMs,
      resultCount: reply.results.length,
      expressions: [...new Set(expressions)].sort(),
      responseBytes,
      responseSha256,
    });
  }

  return {
    signature: lookupEvidenceSignature(details),
    generation,
    hitCount,
    missCount: queries.length - hitCount,
    expectationMismatches,
    latenciesMs,
    details,
    responseEvidence,
  };
}

function authenticImportFailureResponse(response, requestId = response?.requestId) {
  return Boolean(response && typeof response === "object" && !Array.isArray(response)
    && response.type === "hd_import_result"
    && typeof requestId === "string" && requestId !== ""
    && response.requestId === requestId
    && response.ok === false
    && typeof response.error === "string" && response.error !== ""
    && (response.report === undefined
      || (response.report && typeof response.report === "object" && response.report.success === false)));
}

export function matchesExpectedFailure(expectedFailureIncludes, error) {
  if (error?.benchmarkUnexpectedSuccess === true
    || error?.benchmarkFailure?.phase !== "import"
    || error?.benchmarkFailure?.origin !== "extension") return false;
  const response = error.benchmarkFailure.response;
  const message = error?.message ?? String(error);
  return authenticImportFailureResponse(response)
    && typeof expectedFailureIncludes === "string"
    && expectedFailureIncludes !== ""
    && message.includes(expectedFailureIncludes)
    && message.includes(response.error);
}

function requireFinite(value, label, { integer = false, positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < (positive ? Number.EPSILON : 0)
    || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} metric is invalid: ${JSON.stringify(value)}`);
  }
}

function validateLookupDetails(
  details,
  queries,
  corpus,
  label,
  requestIds,
  responseEvidence,
  usedResponseHashes,
  expectedDictionaryCount,
) {
  if (!Array.isArray(details) || details.length !== queries.length) {
    throw new Error(`${label} details count does not match the query fixture`);
  }
  if (!responseEvidence || typeof responseEvidence !== "object" || Array.isArray(responseEvidence)) {
    throw new Error(`${label} response evidence registry is missing`);
  }
  details.forEach((detail, index) => {
    const query = queries[index];
    if (detail?.queryId !== query.id || detail.text !== query.text) {
      throw new Error(`${label} detail ${index} does not match query ${query.id}`);
    }
    if (typeof detail.requestId !== "string" || detail.requestId === ""
      || detail.responseType !== "hd_lookup_result"
      || detail.responseOk !== true
      || detail.responseError !== null) {
      throw new Error(`${label} ${query.id} response envelope is invalid`);
    }
    if (requestIds.has(detail.requestId)) {
      throw new Error(`${label} ${query.id} reuses request ID ${detail.requestId}`);
    }
    requestIds.add(detail.requestId);
    requireFinite(detail.latencyMs, `${label} ${query.id} latency`);
    requireFinite(detail.resultCount, `${label} ${query.id} result count`, { integer: true });
    requireFinite(detail.responseBytes, `${label} ${query.id} response bytes`, { integer: true });
    if (!Array.isArray(detail.expressions) || detail.expressions.some((value) => typeof value !== "string")) {
      throw new Error(`${label} ${query.id} expressions are invalid`);
    }
    if (!/^[0-9a-f]{64}$/.test(detail.responseSha256 ?? "")) {
      throw new Error(`${label} ${query.id} response signature is invalid`);
    }
    const response = Object.prototype.hasOwnProperty.call(responseEvidence, detail.responseSha256)
      ? responseEvidence[detail.responseSha256]
      : null;
    if (!response || sha256Canonical(response) !== detail.responseSha256
      || Buffer.byteLength(canonicalJson(response), "utf8") !== detail.responseBytes) {
      throw new Error(`${label} ${query.id} response body does not match its retained evidence`);
    }
    if (response.ok !== detail.responseOk || response.error !== detail.responseError
      || response.dictionaryCount !== expectedDictionaryCount || !Array.isArray(response.results)
      || response.results.length !== detail.resultCount) {
      throw new Error(`${label} ${query.id} response body conflicts with its envelope evidence`);
    }
    const responseExpressions = [...new Set(response.results
      .map((result) => result?.term?.expression)
      .filter((value) => typeof value === "string"))].sort();
    if (canonicalJson(responseExpressions) !== canonicalJson(detail.expressions)) {
      throw new Error(`${label} ${query.id} response expressions conflict with its retained body`);
    }
    usedResponseHashes.add(detail.responseSha256);
    const expectation = expectedFor(query, "expect", corpus);
    if ((expectation === "hit" && detail.resultCount === 0)
      || (expectation === "miss" && detail.resultCount !== 0)) {
      throw new Error(`${label} ${query.id} result count violates its expectation`);
    }
    const expectedExpression = expectedFor(query, "expectedExpression", corpus);
    if (expectedExpression !== undefined && !detail.expressions.includes(expectedExpression)) {
      throw new Error(`${label} ${query.id} is missing expected expression ${JSON.stringify(expectedExpression)}`);
    }
  });
  return lookupEvidenceSignature(details);
}

function validateResponseEvidenceCoverage(responseEvidence, usedResponseHashes, label) {
  const retained = Object.keys(responseEvidence).sort();
  const used = [...usedResponseHashes].sort();
  if (canonicalJson(retained) !== canonicalJson(used)) {
    throw new Error(`${label} response evidence registry contains missing or unreferenced bodies`);
  }
}

function validateLookupDataset(
  dataset,
  queries,
  corpus,
  label,
  expectedIndex,
  requestIds,
  responseEvidence,
  usedResponseHashes,
  expectedDictionaryCount,
) {
  if (!dataset || typeof dataset !== "object") throw new Error(`${label} is missing`);
  requireFinite(dataset.wallMs, `${label} wall`);
  if (expectedIndex !== undefined && dataset.index !== expectedIndex) {
    throw new Error(`${label} index ${dataset.index}, expected ${expectedIndex}`);
  }
  if (!Array.isArray(dataset.latenciesMs) || dataset.latenciesMs.length !== queries.length) {
    throw new Error(`${label} latency count does not match the query fixture`);
  }
  dataset.latenciesMs.forEach((latency, index) => {
    requireFinite(latency, `${label} latency ${index}`);
    if (latency !== dataset.details?.[index]?.latencyMs) {
      throw new Error(`${label} latency ${index} does not match its detail`);
    }
  });
  const signature = validateLookupDetails(
    dataset.details,
    queries,
    corpus,
    label,
    requestIds,
    responseEvidence,
    usedResponseHashes,
    expectedDictionaryCount,
  );
  if (dataset.signature !== signature) throw new Error(`${label} signature does not match its evidence`);
  return signature;
}

function validateLookupPhase(phase, queries, corpus, lookupPasses, label, requestIds, expectedDictionaryCount) {
  if (!phase || typeof phase !== "object") throw new Error(`${label} lookup phase is missing`);
  requireFinite(phase.generation, `${label} generation`, { integer: true });
  if (!Array.isArray(phase.passes) || phase.passes.length !== lookupPasses) {
    throw new Error(`${label} measured pass count does not match the run definition`);
  }
  const usedResponseHashes = new Set();
  const validateDataset = (dataset, datasetLabel, expectedIndex) => validateLookupDataset(
    dataset,
    queries,
    corpus,
    datasetLabel,
    expectedIndex,
    requestIds,
    phase.responseEvidence,
    usedResponseHashes,
    expectedDictionaryCount,
  );
  const warmSignature = validateDataset(phase.warmup, `${label} warmup`, undefined);
  if (phase.signature !== warmSignature) throw new Error(`${label} phase signature does not match its warmup`);
  phase.passes.forEach((pass, index) => {
    const signature = validateDataset(pass, `${label} pass ${index}`, index);
    if (signature !== warmSignature) throw new Error(`${label} pass ${index} signature drift`);
  });
  validateResponseEvidenceCoverage(phase.responseEvidence, usedResponseHashes, label);
  const hits = phase.warmup.details.filter((detail) => detail.resultCount > 0).length;
  if (phase.hitCount !== hits || phase.missCount !== queries.length - hits) {
    throw new Error(`${label} hit/miss counts do not match lookup evidence`);
  }
  return warmSignature;
}

function validateFirstLookup(first, query, corpus, label, requestIds, expectedDictionaryCount) {
  if (!first || typeof first !== "object") throw new Error(`${label} first lookup is missing`);
  requireFinite(first.wallMs, `${label} first lookup wall`);
  requireFinite(first.completedAtMs, `${label} first lookup completion`);
  requireFinite(first.latencyMs, `${label} first lookup latency`);
  requireFinite(first.generation, `${label} first lookup generation`, { integer: true });
  if (first.latencyMs !== first.detail?.latencyMs) {
    throw new Error(`${label} first lookup latency does not match its detail`);
  }
  const usedResponseHashes = new Set();
  const signature = validateLookupDetails(
    [first.detail],
    [query],
    corpus,
    `${label} first lookup`,
    requestIds,
    first.responseEvidence,
    usedResponseHashes,
    expectedDictionaryCount,
  );
  validateResponseEvidenceCoverage(first.responseEvidence, usedResponseHashes, `${label} first lookup`);
  if (first.signature !== signature) throw new Error(`${label} first lookup signature does not match its evidence`);
  return signature;
}

function validateStatus(status, expectedDictionaryCount, label, requestIds) {
  if (!status || status.type !== "hd_status_result" || status.ok !== true || status.error !== null
    || status.ready !== true || status.loading !== false
    || status.dictionaryCount !== expectedDictionaryCount) {
    throw new Error(`${label} status response is invalid`);
  }
  requireFinite(status.generation, `${label} generation`, { integer: true });
  if (typeof status.requestId !== "string" || status.requestId === "" || requestIds.has(status.requestId)) {
    throw new Error(`${label} status request ID is invalid or reused`);
  }
  requestIds.add(status.requestId);
}

function selectedQueries(definition, corpus) {
  const queryById = new Map(definition.config.queries.map((query) => [query.id, query]));
  const selected = corpus.queryIds
    ? corpus.queryIds.map((queryId) => queryById.get(queryId))
    : definition.config.queries;
  return orderQueries(selected, { seed: definition.config.seed, corpus: corpus.id });
}

export function validateRows(rows, schedule, definition = null, { allowMissing = false } = {}) {
  const scheduleById = new Map(schedule.map((item) => [item.runId, item]));
  const byId = new Map();
  const attemptsById = new Map();
  const attemptKeys = new Set();
  for (const row of rows) {
    const item = scheduleById.get(row.runId);
    if (!item) throw new Error(`unexpected run ${row.runId}`);
    const attempt = definition ? row.attempt : (row.attempt ?? 0);
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new Error(`run ${row.runId} has invalid attempt ${JSON.stringify(row.attempt)}`);
    }
    const attemptKey = `${row.runId}\u0000${attempt}`;
    if (attemptKeys.has(attemptKey)) throw new Error(`duplicate run attempt ${row.runId}#${attempt}`);
    attemptKeys.add(attemptKey);
    for (const key of ["runId", "corpus", "warmup", "round", "iteration", "order"]) {
      if (row[key] !== item[key]) throw new Error(`run ${item.runId} does not match its schedule ${key}`);
    }
    if (!attemptsById.has(row.runId)) attemptsById.set(row.runId, []);
    attemptsById.get(row.runId).push({ attempt, row });
    if (!byId.has(row.runId) || attempt > (byId.get(row.runId).attempt ?? 0)) byId.set(row.runId, row);
  }
  for (const [runId, entries] of attemptsById) {
    entries.sort((left, right) => left.attempt - right.attempt);
    entries.forEach((entry, index) => {
      if (entry.attempt !== index) throw new Error(`${runId}: attempts must be contiguous from attempt 0`);
      if (index < entries.length - 1 && entry.row.valid === true) {
        throw new Error(`${runId}: an attempt exists after validated attempt ${entry.attempt}`);
      }
    });
  }

  if (definition && canonicalJson(schedule) !== canonicalJson(definition.schedule)) {
    throw new Error("schedule does not match the pinned run definition");
  }
  const definitionHash = definition ? sha256Canonical(definition) : null;
  const corpusById = definition
    ? new Map(definition.config.corpora.map((corpus) => [corpus.id, corpus]))
    : null;
  if (definition) {
    for (const row of rows) {
      const corpus = corpusById.get(row.corpus);
      if (row.schemaVersion !== 1 || row.runDefinitionSha256 !== definitionHash) {
        throw new Error(`${row.corpus}: row does not match the pinned run definition`);
      }
      if (!corpus || row.archiveSha256 !== corpus.archiveSha256 || row.archiveBytes !== corpus.archiveBytes) {
        throw new Error(`${row.corpus}: archive evidence does not match the run definition`);
      }
    }
  }
  const baselines = new Map();
  const compare = (corpus, label, value) => {
    if (typeof value !== "string" || value === "") throw new Error(`${corpus}: missing ${label} signature`);
    const key = `${corpus}\u0000${label}`;
    if (!baselines.has(key)) baselines.set(key, value);
    else if (baselines.get(key) !== value) throw new Error(`${corpus}: ${label} signature drift`);
  };

  for (const item of schedule) {
    const row = byId.get(item.runId);
    if (!row) {
      if (allowMissing) continue;
      throw new Error(`missing run ${item.runId}`);
    }
    if (row.valid !== true) {
      if (allowMissing) continue;
      throw new Error(`invalid run ${item.runId}: ${row.error ?? "no detail"}`);
    }
    compare(row.corpus, "archive", row.archiveSha256);
    const outcome = row.outcome ?? "success";
    compare(row.corpus, "outcome", outcome);

    if (!definition) {
      if (outcome === "expected-failure") {
        if (row.shutdownVerified !== true) {
          throw new Error(`${row.corpus}: browser shutdown was not verified`);
        }
        if (row.failurePhase !== "import" || row.failureOrigin !== "extension"
          || !authenticImportFailureResponse(row.importResponse, row.importRequestId)
          || typeof row.observedError !== "string"
          || !row.observedError.includes(row.importResponse.error)) {
          throw new Error(`${row.corpus}: expected-failure import response evidence is invalid`);
        }
        if (typeof row.expectedFailureIncludes !== "string" || row.expectedFailureIncludes === ""
          || typeof row.observedError !== "string"
          || !row.observedError.includes(row.expectedFailureIncludes)) {
          throw new Error(`${row.corpus}: expected-failure contract did not match`);
        }
        compare(row.corpus, "expected failure", row.expectedFailureIncludes);
        compare(row.corpus, "observed failure", row.observedError);
        continue;
      }
      if (outcome !== "success") throw new Error(`${row.corpus}: unknown outcome ${outcome}`);
      compare(row.corpus, "import report", row.importReportSignature);
      compare(row.corpus, "query fixture", row.lookupQueryFixtureSha256);
      if (row.lookup?.postImport?.signature !== row.lookup?.postRestart?.signature) {
        throw new Error(`${row.corpus}: lookup correctness changed across restart`);
      }
      compare(row.corpus, "postImport", row.lookup?.postImport?.signature);
      compare(row.corpus, "postRestart", row.lookup?.postRestart?.signature);
      continue;
    }

    if (row.schemaVersion !== 1 || row.runDefinitionSha256 !== definitionHash) {
      throw new Error(`${row.corpus}: row does not match the pinned run definition`);
    }
    const corpus = corpusById.get(row.corpus);
    if (!corpus) throw new Error(`${row.corpus}: corpus is absent from the run definition`);
    if (row.archiveSha256 !== corpus.archiveSha256 || row.archiveBytes !== corpus.archiveBytes) {
      throw new Error(`${row.corpus}: archive evidence does not match the run definition`);
    }
    if (row.archiveObservedBeforeSha256 !== corpus.archiveSha256
      || row.archiveObservedBeforeBytes !== corpus.archiveBytes
      || row.archiveObservedAfterSha256 !== corpus.archiveSha256
      || row.archiveObservedAfterBytes !== corpus.archiveBytes) {
      throw new Error(`${row.corpus}: observed archive bytes changed around the measured import`);
    }
    if (row.shutdownVerified !== true) {
      throw new Error(`${row.corpus}: browser shutdown was not verified`);
    }

    if (outcome === "expected-failure") {
      if (!corpus.expectedFailureIncludes
        || row.expectedFailureIncludes !== corpus.expectedFailureIncludes
        || row.failurePhase !== "import"
        || row.failureOrigin !== "extension"
        || !authenticImportFailureResponse(row.importResponse, row.importRequestId)
        || row.profileRetained !== true
        || typeof row.profile !== "string" || row.profile === ""
        || typeof row.observedError !== "string"
        || !row.observedError.includes(row.importResponse.error)
        || !row.observedError.includes(corpus.expectedFailureIncludes)
        || row.metrics !== undefined
        || row.lookup !== undefined) {
        throw new Error(`${row.corpus}: expected-failure contract did not match the pinned import failure`);
      }
      compare(row.corpus, "expected failure", row.expectedFailureIncludes);
      continue;
    }
    if (outcome !== "success" || corpus.expectedFailureIncludes) {
      throw new Error(`${row.corpus}: outcome does not match the run definition`);
    }
    const retainsSuccessfulProfiles = definition.config.keepProfiles === true;
    if (typeof row.profilePath !== "string" || row.profilePath === ""
      || (retainsSuccessfulProfiles
        ? row.profileRetained !== true || row.profileDisposition !== "retained"
        : row.profileRetained !== null || row.profileDisposition !== "delete-after-persistence")) {
      throw new Error(`${row.corpus}: successful profile disposition is inconsistent with the run definition`);
    }

    if (!row.importReport || typeof row.importReport !== "object" || Array.isArray(row.importReport)) {
      throw new Error(`${row.corpus}: import report is missing or invalid`);
    }
    if (row.importReport.success !== true || row.importReport.error !== ""
      || typeof row.importReport.title !== "string" || row.importReport.title === "") {
      throw new Error(`${row.corpus}: import report does not describe a successful import`);
    }
    if (row.importReportSignature !== sha256Canonical(row.importReport)) {
      throw new Error(`${row.corpus}: import report signature does not match its report`);
    }
    if (!row.importResponse || row.importResponse.type !== "hd_import_result"
      || row.importResponse.requestId !== row.importRequestId
      || row.importResponse.ok !== true || row.importResponse.error !== null
      || canonicalJson(row.importResponse.report) !== canonicalJson(row.importReport)) {
      throw new Error(`${row.corpus}: import response envelope does not match retained import evidence`);
    }
    for (const [key, expected] of Object.entries(corpus.expectedReport ?? {})) {
      if (row.importReport?.[key] !== expected) {
        throw new Error(`${row.corpus}: import report ${key} does not match the run definition`);
      }
    }
    compare(row.corpus, "import report", row.importReportSignature);

    const queries = selectedQueries(definition, corpus);
    if (canonicalJson(row.lookupQueryIds) !== canonicalJson(queries.map((query) => query.id))
      || row.lookupQueryFixtureSha256 !== sha256Canonical(queries)) {
      throw new Error(`${row.corpus}: query fixture does not match the run definition`);
    }
    compare(row.corpus, "query fixture", row.lookupQueryFixtureSha256);

    const metricNames = [
      "initialLaunchWallMs", "initialReadyWallMs", "importUsableWallMs", "importWallMs",
      "importMessageWallMs", "importPeakRssBytes", "importPeakProcessCount",
      "importProcessTreeCpuTicks", "importRssSampleIntervalMs", "importRssSamples",
      "postImportReadyWaitMs", "firstLookupAfterImportMs", "restartLaunchWallMs",
      "restartReadyWallMs", "restartUsableWallMs", "restoreReadyWaitMs",
      "restorePeakRssBytes", "restorePeakProcessCount", "restoreProcessTreeCpuTicks",
      "restoreRssSampleIntervalMs", "restoreRssSamples", "firstLookupAfterRestartMs",
    ];
    const integerMetricNames = new Set([
      "importPeakRssBytes", "importPeakProcessCount", "importProcessTreeCpuTicks",
      "importRssSampleIntervalMs", "importRssSamples", "restorePeakRssBytes",
      "restorePeakProcessCount", "restoreProcessTreeCpuTicks", "restoreRssSampleIntervalMs",
      "restoreRssSamples",
    ]);
    for (const name of metricNames) {
      requireFinite(row.metrics?.[name], `${row.corpus} ${name}`, { integer: integerMetricNames.has(name) });
      if (row.metrics[name] < 0
        || (name !== "importProcessTreeCpuTicks" && name !== "restoreProcessTreeCpuTicks"
          && integerMetricNames.has(name) && row.metrics[name] === 0)) {
        throw new Error(`${row.corpus} ${name} metric is outside its valid range`);
      }
    }
    if (row.metrics.importUsableWallMs < row.metrics.importWallMs
      || row.metrics.importWallMs < row.metrics.importMessageWallMs
      || row.metrics.restartUsableWallMs < row.metrics.restartReadyWallMs) {
      throw new Error(`${row.corpus}: timing metric boundaries are inconsistent`);
    }

    const importTiming = row.timingEvidence?.importPagePerformanceNow;
    const restartTiming = row.timingEvidence?.restartHostPerformanceNow;
    const importTimingNames = [
      "userStartMs", "messageStartMs", "messageEndMs", "uiEndMs", "firstLookupCompletedMs",
    ];
    const restartTimingNames = ["startedMs", "readyMs", "firstLookupCompletedMs"];
    for (const name of importTimingNames) {
      requireFinite(importTiming?.[name], `${row.corpus} import timing evidence ${name}`);
    }
    for (const name of restartTimingNames) {
      requireFinite(restartTiming?.[name], `${row.corpus} restart timing evidence ${name}`);
    }
    if (!(importTiming.userStartMs <= importTiming.messageStartMs
      && importTiming.messageStartMs <= importTiming.messageEndMs
      && importTiming.messageEndMs <= importTiming.uiEndMs
      && importTiming.uiEndMs <= importTiming.firstLookupCompletedMs)
      || !(restartTiming.startedMs <= restartTiming.readyMs
        && restartTiming.readyMs <= restartTiming.firstLookupCompletedMs)) {
      throw new Error(`${row.corpus}: timing evidence endpoints are inconsistent`);
    }
    const derivedTimings = {
      importMessageWallMs: importTiming.messageEndMs - importTiming.messageStartMs,
      importWallMs: importTiming.uiEndMs - importTiming.userStartMs,
      importUsableWallMs: importTiming.firstLookupCompletedMs - importTiming.userStartMs,
      restartReadyWallMs: restartTiming.readyMs - restartTiming.startedMs,
      restartUsableWallMs: restartTiming.firstLookupCompletedMs - restartTiming.startedMs,
    };
    for (const [name, derived] of Object.entries(derivedTimings)) {
      if (row.metrics[name] !== derived) {
        throw new Error(`${row.corpus}: ${name} does not match retained timing evidence`);
      }
    }
    if (row.firstLookup?.postImport?.completedAtMs !== importTiming.firstLookupCompletedMs
      || importTiming.firstLookupCompletedMs - importTiming.uiEndMs < row.metrics.firstLookupAfterImportMs
      || restartTiming.firstLookupCompletedMs - restartTiming.readyMs < row.metrics.firstLookupAfterRestartMs) {
      throw new Error(`${row.corpus}: first lookup metric does not fit retained timing evidence`);
    }
    if (!/^[a-p]{32}$/.test(row.extensionId)) {
      throw new Error(`${row.corpus}: extension ID evidence is invalid`);
    }
    const expectedOrigin = `chrome-extension://${row.extensionId}`;
    for (const [label, usage] of [["post-import storage", row.storageAfterImport], ["post-restart storage", row.storage]]) {
      requireFinite(usage?.logicalBytes, `${row.corpus} ${label} logical bytes`, { integer: true, positive: true });
      requireFinite(usage?.usageBytes, `${row.corpus} ${label} quota usage bytes`, { integer: true, positive: true });
      requireFinite(usage?.quotaBytes, `${row.corpus} ${label} quota bytes`, { integer: true, positive: true });
      requireFinite(usage?.fileCount, `${row.corpus} ${label} file count`, { integer: true, positive: true });
      if (usage?.backend !== "opfs" || usage?.origin !== expectedOrigin || !Array.isArray(usage.files)
        || usage.files.length !== usage.fileCount || usage.usageBytes < usage.logicalBytes
        || usage.quotaBytes < usage.usageBytes) {
        throw new Error(`${row.corpus}: ${label} OPFS evidence is invalid`);
      }
      const paths = new Set();
      let logicalBytes = 0;
      for (const file of usage.files) {
        if (typeof file?.path !== "string" || file.path === "" || paths.has(file.path)
          || !Number.isInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
          throw new Error(`${row.corpus}: ${label} OPFS file evidence is invalid`);
        }
        paths.add(file.path);
        logicalBytes += file.bytes;
      }
      if (logicalBytes !== usage.logicalBytes
        || canonicalJson([...paths]) !== canonicalJson([...paths].sort())) {
        throw new Error(`${row.corpus}: ${label} OPFS manifest is inconsistent`);
      }
    }
    if (canonicalJson(row.storageAfterImport.files) !== canonicalJson(row.storage.files)) {
      throw new Error(`${row.corpus}: durable OPFS contents changed across restart`);
    }

    for (const key of ["termCount", "metaCount", "frequencyCount", "pitchCount", "kanjiCount", "mediaCount"]) {
      requireFinite(row.importReport[key], `${row.corpus}: importReport.${key}`, { integer: true });
      if (row.importReport[key] < 0) throw new Error(`${row.corpus}: importReport.${key} must be non-negative`);
    }
    const expectedCount = Number.isInteger(corpus.expectedDictionaryCount)
      ? corpus.expectedDictionaryCount
      : ["termCount", "frequencyCount", "pitchCount", "kanjiCount"]
        .filter((key) => row.importReport?.[key] > 0).length || 1;
    if (row.dictionaryCount !== expectedCount) {
      throw new Error(`${row.corpus}: dictionary count evidence is inconsistent`);
    }
    validateStoredDictionaries(row.storedDictionaries, row.importReport, expectedCount);

    const requestIds = new Set();
    const postImportSignature = validateLookupPhase(
      row.lookup?.postImport,
      queries,
      row.corpus,
      definition.config.lookupPasses,
      `${row.corpus} post-import`,
      requestIds,
      expectedCount,
    );
    const postRestartSignature = validateLookupPhase(
      row.lookup?.postRestart,
      queries,
      row.corpus,
      definition.config.lookupPasses,
      `${row.corpus} post-restart`,
      requestIds,
      expectedCount,
    );
    if (postImportSignature !== postRestartSignature) {
      throw new Error(`${row.corpus}: lookup correctness changed across restart`);
    }
    compare(row.corpus, "postImport", postImportSignature);
    compare(row.corpus, "postRestart", postRestartSignature);

    const firstQuery = queries.find((query) => expectedFor(query, "expect", row.corpus) === "hit");
    if (!firstQuery) throw new Error(`${row.corpus}: first lookup query is absent`);
    const firstImportSignature = validateFirstLookup(
      row.firstLookup?.postImport,
      firstQuery,
      row.corpus,
      `${row.corpus} post-import`,
      requestIds,
      expectedCount,
    );
    const firstRestartSignature = validateFirstLookup(
      row.firstLookup?.postRestart,
      firstQuery,
      row.corpus,
      `${row.corpus} post-restart`,
      requestIds,
      expectedCount,
    );
    if (firstImportSignature !== firstRestartSignature) {
      throw new Error(`${row.corpus}: first lookup correctness changed across restart`);
    }
    if (row.metrics.firstLookupAfterImportMs !== row.firstLookup.postImport.latencyMs
      || row.metrics.firstLookupAfterRestartMs !== row.firstLookup.postRestart.latencyMs) {
      throw new Error(`${row.corpus}: first lookup metrics do not match retained first-lookup evidence`);
    }
    compare(row.corpus, "first lookup", firstImportSignature);

    const statuses = row.lifecycle ?? {};
    validateStatus(statuses.initialStatus, 0, `${row.corpus} initial`, requestIds);
    validateStatus(statuses.afterImportStatus, expectedCount, `${row.corpus} post-import`, requestIds);
    validateStatus(statuses.restoredStatus, expectedCount, `${row.corpus} restored`, requestIds);
    if (typeof row.importRequestId !== "string" || row.importRequestId === ""
      || requestIds.has(row.importRequestId)) {
      throw new Error(`${row.corpus}: import request ID is invalid or reused`);
    }
    requestIds.add(row.importRequestId);
    if (row.importResponse.generation !== statuses.afterImportStatus.generation
      || row.firstLookup.postImport.generation !== statuses.afterImportStatus.generation
      || row.firstLookup.postRestart.generation !== statuses.restoredStatus.generation
      || row.lookup.postImport.generation !== statuses.afterImportStatus.generation
      || row.lookup.postRestart.generation !== statuses.restoredStatus.generation) {
      throw new Error(`${row.corpus}: lifecycle generation evidence is inconsistent`);
    }

    if (definition.config.idleCheckMs > 0) {
      const idle = row.idle;
      if (!idle || idle.timeoutMs !== definition.config.idleCheckMs
        || idle.serviceWorkerTerminationObserved !== true) {
        throw new Error(`${row.corpus}: idle lifecycle evidence is missing`);
      }
      for (const [name, value] of [
        ["serviceWorkerIdleWaitMs", idle.serviceWorkerIdleWaitMs],
        ["coldStatusWallMs", idle.coldStatusWallMs],
        ["lookupWallMs", idle.lookupWallMs],
      ]) requireFinite(value, `${row.corpus} ${name}`);
      if (idle.serviceWorkerIdleWaitMs > idle.timeoutMs
        || !Array.isArray(idle.offscreenContextIdsBefore)
        || !Array.isArray(idle.offscreenContextIdsAfter)
        || idle.offscreenContextIdsBefore.length !== 1
        || idle.offscreenContextIdsAfter.length !== 1
        || typeof idle.offscreenContextIdsBefore[0] !== "string"
        || idle.offscreenContextIdsBefore[0] === ""
        || typeof idle.offscreenContextIdsAfter[0] !== "string"
        || idle.offscreenContextIdsAfter[0] === ""
        || idle.offscreenContextIdsBefore[0] !== idle.offscreenContextIdsAfter[0]
        || idle.offscreenContextsBefore !== 1
        || idle.offscreenContextsAfter !== 1) {
        throw new Error(`${row.corpus}: offscreen identity changed during idle lifecycle check`);
      }
      validateStatus(idle.statusBefore, expectedCount, `${row.corpus} pre-idle`, requestIds);
      validateStatus(idle.statusAfter, expectedCount, `${row.corpus} post-idle`, requestIds);
      const idleResponseHashes = new Set();
      const idleSignature = validateLookupDataset(
        idle.lookup,
        queries,
        row.corpus,
        `${row.corpus} post-idle lookup`,
        undefined,
        requestIds,
        idle.lookup?.responseEvidence,
        idleResponseHashes,
        expectedCount,
      );
      validateResponseEvidenceCoverage(
        idle.lookup.responseEvidence,
        idleResponseHashes,
        `${row.corpus} post-idle lookup`,
      );
      if (idle.lookupGeneration !== idle.statusAfter.generation
        || idle.generationBefore !== idle.statusBefore.generation
        || idle.generationAfter !== idle.statusAfter.generation
        || idle.generationBefore !== idle.generationAfter
        || idle.lookupWallMs !== idle.lookup.wallMs
        || idle.lookupSignature !== idleSignature
        || idleSignature !== postRestartSignature) {
        throw new Error(`${row.corpus}: engine continuity changed during idle lifecycle check`);
      }
    } else if (row.idle !== null) {
      throw new Error(`${row.corpus}: unexpected idle lifecycle evidence`);
    }
  }
  const selectedRows = schedule.map((item) => byId.get(item.runId)).filter(Boolean);
  if (!allowMissing && selectedRows.length !== schedule.length) {
    throw new Error(`unexpected benchmark row count: ${selectedRows.length}, expected ${schedule.length}`);
  }
  return selectedRows;
}

function summarizeOptional(values) {
  return values.every((value) => value !== undefined && value !== null)
    ? summarizeValues(values)
    : null;
}

function summarizeLookupPhase(rows, phase) {
  const phases = rows.map((row) => row.lookup[phase]);
  const passes = phases.flatMap((entry) => entry.passes);
  const latencies = passes.flatMap((entry) => entry.latenciesMs);
  const details = passes.flatMap((entry) => entry.details ?? []);
  const hitLatencies = details.filter((entry) => entry.resultCount > 0).map((entry) => entry.latencyMs);
  const missLatencies = details.filter((entry) => entry.resultCount === 0).map((entry) => entry.latencyMs);
  const responseBytes = details.map((entry) => entry.responseBytes);
  const hitResponseBytes = details.filter((entry) => entry.resultCount > 0).map((entry) => entry.responseBytes);
  const missResponseBytes = details.filter((entry) => entry.resultCount === 0).map((entry) => entry.responseBytes);
  const wallTimes = passes.map((entry) => entry.wallMs);
  const throughputs = passes.map((entry) => entry.latenciesMs.length / (entry.wallMs / 1000));
  return {
    queriesPerPass: passes[0].latenciesMs.length,
    passCount: passes.length,
    hitCount: phases[0].hitCount,
    missCount: phases[0].missCount,
    signature: phases[0].signature,
    requestLatencyMs: summarizeValues(latencies),
    hitRequestLatencyMs: hitLatencies.length > 0 ? summarizeValues(hitLatencies) : null,
    missRequestLatencyMs: missLatencies.length > 0 ? summarizeValues(missLatencies) : null,
    responseBytes: responseBytes.length > 0 ? summarizeOptional(responseBytes) : null,
    hitResponseBytes: hitResponseBytes.length > 0 ? summarizeOptional(hitResponseBytes) : null,
    missResponseBytes: missResponseBytes.length > 0 ? summarizeOptional(missResponseBytes) : null,
    passWallMs: summarizeValues(wallTimes),
    throughputQueriesPerSecond: summarizeValues(throughputs),
  };
}

export function buildSummary(rows, metadata = {}) {
  const measured = rows.filter((row) => !row.warmup && row.valid === true);
  if (measured.length === 0) throw new Error("cannot build a summary without valid measured rows");
  const grouped = new Map();
  for (const row of measured) {
    if (!grouped.has(row.corpus)) grouped.set(row.corpus, []);
    grouped.get(row.corpus).push(row);
  }

  const corpora = {};
  for (const [corpus, corpusRows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const first = corpusRows[0];
    if (corpusRows.every((row) => row.outcome === "expected-failure")) {
      corpora[corpus] = {
        status: "expected-failure",
        sampleCount: corpusRows.length,
        archiveSha256: first.archiveSha256,
        archiveBytes: first.archiveBytes,
        expectedFailureIncludes: first.expectedFailureIncludes,
        observedErrors: corpusRows.map((row) => row.observedError),
      };
      continue;
    }
    corpora[corpus] = {
      status: "success",
      sampleCount: corpusRows.length,
      archiveSha256: first.archiveSha256,
      archiveBytes: first.archiveBytes,
      importReport: first.importReport,
      importReportSignature: first.importReportSignature,
      importUsableWallMs: summarizeValues(corpusRows.map((row) => row.metrics.importUsableWallMs)),
      importWallMs: summarizeValues(corpusRows.map((row) => row.metrics.importWallMs)),
      importMessageWallMs: summarizeValues(corpusRows.map((row) => row.metrics.importMessageWallMs ?? row.metrics.importWallMs)),
      importThroughputTermsPerSecond: summarizeValues(corpusRows.map(
        (row) => row.importReport.termCount / (row.metrics.importUsableWallMs / 1000),
      )),
      restartReadyWallMs: summarizeValues(corpusRows.map((row) => row.metrics.restartReadyWallMs)),
      restartUsableWallMs: summarizeValues(corpusRows.map((row) => row.metrics.restartUsableWallMs)),
      firstLookupAfterImportMs: summarizeValues(corpusRows.map((row) => row.metrics.firstLookupAfterImportMs)),
      firstLookupAfterRestartMs: summarizeValues(corpusRows.map((row) => row.metrics.firstLookupAfterRestartMs)),
      importPeakRssBytes: summarizeValues(corpusRows.map((row) => row.metrics.importPeakRssBytes)),
      importProcessTreeCpuTicks: summarizeOptional(corpusRows.map((row) => row.metrics.importProcessTreeCpuTicks)),
      restorePeakRssBytes: summarizeValues(corpusRows.map((row) => row.metrics.restorePeakRssBytes)),
      restoreProcessTreeCpuTicks: summarizeOptional(corpusRows.map((row) => row.metrics.restoreProcessTreeCpuTicks)),
      durableLogicalBytes: summarizeValues(corpusRows.map((row) => row.storage.logicalBytes)),
      durableUsageBytes: summarizeValues(corpusRows.map((row) => row.storage.usageBytes)),
      durableFileCount: summarizeValues(corpusRows.map((row) => row.storage.fileCount)),
      lookup: {
        postImport: summarizeLookupPhase(corpusRows, "postImport"),
        postRestart: summarizeLookupPhase(corpusRows, "postRestart"),
      },
    };
  }

  return {
    schemaVersion: 1,
    benchmarkMode: metadata.mode ?? "rough-directional",
    measurementContract: {
      import: "settings file selection through direct OPFS persistence, metadata commit, engine reload, and the first correctness-checked hit",
      importUi: "settings file selection to the successful UI state after the hd_import response",
      importMessage: "hd_import chrome.runtime message round trip from settings page",
      firstLookup: "one correctness-checked hd_lookup round trip issued immediately after the full ready predicate, before any lookup warmup",
      lookup: "steady chrome.runtime message round trips through the service worker, offscreen document, and WASM engine after one excluded lookup warmup pass",
      restart: "complete close of the first Chrome process followed by a fresh Chrome process using the retained profile, direct OPFS open, dictionary load, and the first correctness-checked hit",
      restartReady: "fresh Chrome process launch with the retained profile to ready status after direct OPFS open and dictionary load",
      warmupsExcluded: true,
    },
    metadata,
    corpora,
  };
}

function fixed(value, digits = 3) {
  return Number(value).toFixed(digits);
}

function rangeText(stats, divisor = 1, digits = 3) {
  return `${fixed(stats.median / divisor, digits)} [${fixed(stats.min / divisor, digits)}–${fixed(stats.max / divisor, digits)}]`;
}

export function renderMarkdown(summary) {
  const lines = [
    "# Hachidori browser benchmark",
    "",
    "Values are measured-sample medians `[min–max]`; excluded warmups and raw samples are retained in `raw.jsonl`.",
    "",
  ];
  const unsupported = Object.entries(summary.corpora)
    .filter(([, corpus]) => corpus.status === "expected-failure");
  if (unsupported.length > 0) {
    lines.push(
      "## Unsupported workloads",
      "",
      "These production-path imports matched an explicitly pinned failure contract. No performance number is fabricated.",
      "",
      "| Corpus | Observed failure | n |",
      "|---|---|---:|",
    );
    for (const [name, corpus] of unsupported) {
      lines.push(`| ${name} | ${corpus.observedErrors[0].replaceAll("|", "\\|")} | ${corpus.sampleCount} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Import and restoration",
    "",
    "| Corpus | Import → first valid lookup | Terms/s | Full Chrome restart → first valid lookup | Durable OPFS | Peak RSS during import | n |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const [name, corpus] of Object.entries(summary.corpora)) {
    if (corpus.status !== "success") continue;
    lines.push(`| ${name} | ${rangeText(corpus.importUsableWallMs, 1000)} s | ${fixed(corpus.importThroughputTermsPerSecond.median, 0)} | ${rangeText(corpus.restartUsableWallMs, 1000)} s | ${rangeText(corpus.durableLogicalBytes, 2 ** 20, 1)} MiB | ${rangeText(corpus.importPeakRssBytes, 2 ** 20, 1)} MiB | ${corpus.sampleCount} |`);
  }
  const percentilePair = (stats) => stats ? `${fixed(stats.median)} / ${fixed(stats.p95)} ms` : "—";
  lines.push(
    "",
    "## Usable → lookup",
    "",
    "The first-hit metrics are one correctness-checked `hd_lookup` round trip issued immediately after the full ready predicate, before lookup warmup. The steady metrics cover the real `chrome.runtime` round trip after one excluded lookup warmup pass.",
    "",
    "| Corpus | First hit after import p50 / p95 | First hit after full restart p50 / p95 | n |",
    "|---|---:|---:|---:|",
  );
  for (const [name, corpus] of Object.entries(summary.corpora)) {
    if (corpus.status !== "success") continue;
    lines.push(`| ${name} | ${percentilePair(corpus.firstLookupAfterImportMs)} | ${percentilePair(corpus.firstLookupAfterRestartMs)} | ${corpus.sampleCount} |`);
  }
  lines.push(
    "",
    "| Corpus | Phase | Hit p50 / p95 | Miss p50 / p95 | Overall p95 | Throughput | Queries/pass | Passes | Hits / misses |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const [name, corpus] of Object.entries(summary.corpora)) {
    if (corpus.status !== "success") continue;
    for (const [phase, label] of [["postImport", "Post-import steady lookup"], ["postRestart", "Post-restart steady lookup"]]) {
      const lookup = corpus.lookup[phase];
      lines.push(`| ${name} | ${label} | ${percentilePair(lookup.hitRequestLatencyMs)} | ${percentilePair(lookup.missRequestLatencyMs)} | ${fixed(lookup.requestLatencyMs.p95)} ms | ${fixed(lookup.throughputQueriesPerSecond.median, 0)} queries/s | ${lookup.queriesPerPass} | ${lookup.passCount} | ${lookup.hitCount} / ${lookup.missCount} |`);
    }
  }
  lines.push(
    "",
    "## Measurement contract",
    "",
    `- **Import → first valid lookup:** ${summary.measurementContract.import}`,
    `- **Import UI:** ${summary.measurementContract.importUi}`,
    `- **Import message:** ${summary.measurementContract.importMessage}`,
    `- **First lookup once ready:** ${summary.measurementContract.firstLookup}`,
    `- **Steady lookup:** ${summary.measurementContract.lookup}`,
    `- **Full Chrome restart → first valid lookup:** ${summary.measurementContract.restart}`,
    `- **Full Chrome restart → ready:** ${summary.measurementContract.restartReady}`,
    "- Correctness signatures must remain identical across import, restart, and measured passes.",
    "",
    "## Environment",
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

export function renderCsv(summary) {
  const rows = [["corpus", "metric", "unit", "median", "p95", "min", "max", "n"]];
  const add = (corpus, metric, unit, stats) => rows.push([
    corpus, metric, unit, stats.median, stats.p95, stats.min, stats.max, stats.n,
  ]);
  for (const [name, corpus] of Object.entries(summary.corpora)) {
    if (corpus.status === "expected-failure") {
      add(name, "expected_failure", "count", summarizeValues(Array(corpus.sampleCount).fill(1)));
      continue;
    }
    add(name, "import_usable_wall", "ms", corpus.importUsableWallMs);
    add(name, "import_wall", "ms", corpus.importWallMs);
    add(name, "import_message_wall", "ms", corpus.importMessageWallMs);
    add(name, "import_throughput", "terms/s", corpus.importThroughputTermsPerSecond);
    add(name, "restart_usable_wall", "ms", corpus.restartUsableWallMs);
    add(name, "restart_ready_wall", "ms", corpus.restartReadyWallMs);
    add(name, "first_lookup_after_import", "ms", corpus.firstLookupAfterImportMs);
    add(name, "first_lookup_after_restart", "ms", corpus.firstLookupAfterRestartMs);
    add(name, "import_peak_rss", "bytes", corpus.importPeakRssBytes);
    if (corpus.importProcessTreeCpuTicks) add(name, "import_process_tree_cpu", "ticks", corpus.importProcessTreeCpuTicks);
    add(name, "restore_peak_rss", "bytes", corpus.restorePeakRssBytes);
    if (corpus.restoreProcessTreeCpuTicks) add(name, "restore_process_tree_cpu", "ticks", corpus.restoreProcessTreeCpuTicks);
    add(name, "durable_opfs_logical", "bytes", corpus.durableLogicalBytes);
    add(name, "durable_origin_usage", "bytes", corpus.durableUsageBytes);
    add(name, "durable_opfs_files", "files", corpus.durableFileCount);
    for (const phase of ["postImport", "postRestart"]) {
      add(name, `${phase}_request_latency`, "ms", corpus.lookup[phase].requestLatencyMs);
      if (corpus.lookup[phase].hitRequestLatencyMs) {
        add(name, `${phase}_hit_request_latency`, "ms", corpus.lookup[phase].hitRequestLatencyMs);
      }
      if (corpus.lookup[phase].missRequestLatencyMs) {
        add(name, `${phase}_miss_request_latency`, "ms", corpus.lookup[phase].missRequestLatencyMs);
      }
      if (corpus.lookup[phase].responseBytes) {
        add(name, `${phase}_response_payload`, "bytes", corpus.lookup[phase].responseBytes);
      }
      if (corpus.lookup[phase].hitResponseBytes) {
        add(name, `${phase}_hit_response_payload`, "bytes", corpus.lookup[phase].hitResponseBytes);
      }
      if (corpus.lookup[phase].missResponseBytes) {
        add(name, `${phase}_miss_response_payload`, "bytes", corpus.lookup[phase].missResponseBytes);
      }
      add(name, `${phase}_pass_wall`, "ms", corpus.lookup[phase].passWallMs);
      add(name, `${phase}_throughput`, "queries/s", corpus.lookup[phase].throughputQueriesPerSecond);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function positiveInteger(value, fallback, label, { allowZero = false } = {}) {
  const number = value === undefined ? fallback : Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return number;
}

function expandEnvironmentPath(value, environment) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const replacement = environment[name];
    if (typeof replacement !== "string" || replacement === "") {
      throw new Error(`archive path environment variable ${name} is not set`);
    }
    return replacement;
  });
}

export function normalizeConfig(raw, baseDirectory, environment = process.env) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be an object");
  if (!Array.isArray(raw.corpora) || raw.corpora.length === 0) throw new Error("config needs at least one corpus");
  if (!Array.isArray(raw.queries) || raw.queries.length === 0) throw new Error("config needs at least one query");

  const corpusIds = new Set();
  const corpora = raw.corpora.map((corpus, index) => {
    const id = typeof corpus?.id === "string" ? corpus.id.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`corpus ${index} has an invalid id`);
    if (corpusIds.has(id)) throw new Error(`duplicate corpus id ${id}`);
    corpusIds.add(id);
    if (typeof corpus.archive !== "string" || corpus.archive.trim() === "") {
      throw new Error(`corpus ${id} has no archive`);
    }
    if (corpus.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(corpus.expectedSha256)) {
      throw new Error(`corpus ${id} has an invalid expectedSha256`);
    }
    if (corpus.expectedFailureIncludes !== undefined
      && (typeof corpus.expectedFailureIncludes !== "string" || corpus.expectedFailureIncludes === "")) {
      throw new Error(`corpus ${id} has an invalid expectedFailureIncludes`);
    }
    const normalized = {
      ...corpus,
      id,
      archive: resolve(baseDirectory, expandEnvironmentPath(corpus.archive, environment)),
    };
    if (corpus.expectedSha256 !== undefined) {
      normalized.expectedSha256 = corpus.expectedSha256.toLowerCase();
    } else {
      delete normalized.expectedSha256;
    }
    return normalized;
  });

  const queryIds = new Set();
  const queries = raw.queries.map((query, index) => {
    const id = typeof query?.id === "string" ? query.id.trim() : "";
    if (id === "") throw new Error(`query ${index} has no id`);
    if (queryIds.has(id)) throw new Error(`duplicate query id ${id}`);
    queryIds.add(id);
    if (typeof query.text !== "string" || query.text === "") throw new Error(`query ${id} has no text`);
    for (const expectation of [query.expect, ...Object.values(query.expectByCorpus ?? {})]) {
      if (expectation !== undefined && !["hit", "miss", "any"].includes(expectation)) {
        throw new Error(`query ${id} has invalid expectation ${JSON.stringify(expectation)}`);
      }
    }
    return { ...query, id };
  });
  for (const corpus of corpora) {
    if (corpus.queryIds !== undefined) {
      if (!Array.isArray(corpus.queryIds) || corpus.queryIds.length === 0) {
        throw new Error(`corpus ${corpus.id} queryIds must be a non-empty array`);
      }
      const seen = new Set();
      corpus.queryIds = corpus.queryIds.map((queryId) => {
        if (typeof queryId !== "string" || !queryIds.has(queryId)) {
          throw new Error(`corpus ${corpus.id} references unknown query ${JSON.stringify(queryId)}`);
        }
        if (seen.has(queryId)) throw new Error(`corpus ${corpus.id} repeats query ${queryId}`);
        seen.add(queryId);
        return queryId;
      });
    }
    const selected = corpus.queryIds
      ? queries.filter((query) => corpus.queryIds.includes(query.id))
      : queries;
    const hasPositive = selected.some((query) =>
      (query.expectByCorpus?.[corpus.id] ?? query.expect) === "hit");
    if (!corpus.expectedFailureIncludes && !hasPositive) {
      throw new Error(`corpus ${corpus.id} needs at least one expected hit for the usable barrier`);
    }
  }

  return {
    corpora,
    queries,
    warmups: positiveInteger(raw.warmups, 1, "warmups", { allowZero: true }),
    samples: positiveInteger(raw.samples, 3, "samples"),
    lookupPasses: positiveInteger(raw.lookupPasses, 5, "lookupPasses"),
    seed: positiveInteger(raw.seed, 20260902, "seed", { allowZero: true }),
    timeoutMs: positiveInteger(raw.timeoutMs, 10 * 60 * 1000, "timeoutMs"),
    idleCheckMs: positiveInteger(raw.idleCheckMs, 0, "idleCheckMs", { allowZero: true }),
    lookup: {
      maxResults: positiveInteger(raw.lookup?.maxResults, 32, "lookup.maxResults"),
      scanLength: positiveInteger(raw.lookup?.scanLength, 16, "lookup.scanLength"),
      options: raw.lookup?.options && typeof raw.lookup.options === "object" && !Array.isArray(raw.lookup.options)
        ? structuredClone(raw.lookup.options)
        : {},
    },
    keepProfiles: raw.keepProfiles === true,
    allowNoSandbox: raw.allowNoSandbox === true,
    headless: raw.headless !== false,
  };
}

export function makeSchedule(corpora, { warmups, samples, seed }) {
  const base = [...corpora].sort((left, right) => {
    const leftKey = createHash("sha256").update(`schedule-v1\u0000${seed}\u0000${left}`).digest("hex");
    const rightKey = createHash("sha256").update(`schedule-v1\u0000${seed}\u0000${right}`).digest("hex");
    return leftKey.localeCompare(rightKey) || left.localeCompare(right);
  });
  const schedule = [];
  const rounds = Number(warmups) + Number(samples);
  for (let round = 0; round < rounds; round += 1) {
    const warmup = round < warmups;
    const iteration = warmup ? round : round - warmups;
    const rotated = base.map((_, index) => base[(index + round) % base.length]);
    rotated.forEach((corpus, order) => {
      schedule.push({
        corpus,
        warmup,
        round,
        iteration,
        order,
        runId: `${warmup ? "warmup" : "sample"}-${String(iteration).padStart(2, "0")}-${String(order).padStart(2, "0")}-${corpus}`,
      });
    });
  }
  return schedule;
}

function percentile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summarizeValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("cannot summarize an empty sample");
  }
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("sample contains a value that is not a finite number");
  }
  const samples = [...values].sort((left, right) => left - right);
  return {
    n: samples.length,
    min: samples[0],
    p25: percentile(samples, 0.25),
    median: percentile(samples, 0.5),
    p75: percentile(samples, 0.75),
    p95: percentile(samples, 0.95),
    max: samples.at(-1),
    samples,
  };
}
