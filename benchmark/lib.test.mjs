// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeLookupPass,
  buildSummary,
  canonicalJson,
  makeSchedule,
  matchesExpectedFailure,
  normalizeConfig,
  orderQueries,
  renderCsv,
  renderMarkdown,
  sha256Canonical,
  summarizeValues,
  validateRows,
} from "./lib.mjs";

test("makeSchedule is deterministic and balances every corpus within each round", () => {
  const first = makeSchedule(["jitendex", "pixiv-light", "kanji"], {
    warmups: 1,
    samples: 2,
    seed: 20260902,
  });
  const second = makeSchedule(["jitendex", "pixiv-light", "kanji"], {
    warmups: 1,
    samples: 2,
    seed: 20260902,
  });

  assert.deepEqual(first, second);
  assert.equal(first.length, 9);
  for (const round of [0, 1, 2]) {
    const rows = first.filter((row) => row.round === round);
    assert.deepEqual(rows.map((row) => row.corpus).sort(), ["jitendex", "kanji", "pixiv-light"]);
    assert.deepEqual(rows.map((row) => row.order).sort(), [0, 1, 2]);
    assert.equal(new Set(rows.map((row) => row.runId)).size, 3);
  }
  assert.equal(first.filter((row) => row.warmup).length, 3);
  assert.equal(first.filter((row) => !row.warmup).length, 6);
  for (const corpus of ["jitendex", "pixiv-light", "kanji"]) {
    const positions = first.filter((row) => row.corpus === corpus).map((row) => row.order);
    assert.deepEqual(positions.sort(), [0, 1, 2]);
  }
});

test("orderQueries deterministically interleaves hits and misses", () => {
  const queries = [
    { id: "h1", expect: "hit" },
    { id: "h2", expectByCorpus: { corpus: "hit" } },
    { id: "h3", expect: "hit" },
    { id: "m1", expect: "miss" },
    { id: "m2", expectByCorpus: { corpus: "miss" } },
    { id: "m3", expect: "miss" },
  ];
  const first = orderQueries(queries, { seed: 42, corpus: "corpus" });
  const second = orderQueries([...queries].reverse(), { seed: 42, corpus: "corpus" });
  assert.deepEqual(first.map((query) => query.id), second.map((query) => query.id));
  assert.deepEqual(first.map((query) => query.expectByCorpus?.corpus ?? query.expect), [
    "hit", "miss", "hit", "miss", "hit", "miss",
  ]);
});

test("summarizeValues reports raw samples and interpolated percentiles", () => {
  assert.deepEqual(summarizeValues([10, 40, 20, 30]), {
    n: 4,
    min: 10,
    p25: 17.5,
    median: 25,
    p75: 32.5,
    p95: 38.5,
    max: 40,
    samples: [10, 20, 30, 40],
  });
  assert.throws(() => summarizeValues([]), /empty sample/i);
  assert.throws(() => summarizeValues([1, null]), /finite number/i);
  assert.throws(() => summarizeValues([1, "2"]), /finite number/i);
});

test("canonical JSON and its hash ignore object insertion order", () => {
  const left = { z: [3, { b: 2, a: "食" }], a: true };
  const right = { a: true, z: [3, { a: "食", b: 2 }] };

  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256Canonical(left), sha256Canonical(right));
  assert.match(sha256Canonical(left), /^[0-9a-f]{64}$/);
  assert.notEqual(canonicalJson({ text: "e\u0301\r\nline" }), canonicalJson({ text: "é\nline" }));
  assert.notEqual(sha256Canonical({ text: "海" }), sha256Canonical({ text: "海" }));
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/i);
  assert.throws(() => canonicalJson({ value: undefined }), /undefined/i);
});

test("analyzeLookupPass validates expectations and hashes semantics rather than timing metadata", () => {
  const queries = [
    { id: "hit", text: "食べた", expect: "hit", expectedExpression: "食べる" },
    { id: "miss", text: "xyzzy", expect: "miss" },
  ];
  const observations = [
    {
      queryId: "hit",
      requestId: "run-a-0",
      latencyMs: 1.25,
      reply: {
        type: "hd_lookup_result",
        requestId: "run-a-0",
        generation: 2,
        ok: true,
        error: null,
        dictionaryCount: 1,
        results: [{
          matched: "食べた",
          deinflected: "食べる",
          trace: [{ name: "-た", description: "past" }],
          term: { expression: "食べる", reading: "たべる" },
          preprocessorSteps: 0,
        }],
      },
    },
    {
      queryId: "miss",
      requestId: "run-a-1",
      latencyMs: 0.4,
      reply: {
        type: "hd_lookup_result",
        requestId: "run-a-1",
        generation: 2,
        ok: true,
        error: null,
        dictionaryCount: 1,
        results: [],
      },
    },
  ];

  const first = analyzeLookupPass(queries, observations, "fixture", 1);
  const second = analyzeLookupPass(
    queries,
    observations.map((row, index) => ({
      ...row,
      requestId: `other-${index}`,
      latencyMs: row.latencyMs + 99,
      reply: { ...row.reply, requestId: `other-${index}`, generation: 99 },
    })),
    "fixture",
    1,
  );

  assert.equal(first.signature, second.signature);
  assert.equal(first.hitCount, 1);
  assert.equal(first.missCount, 1);
  assert.deepEqual(first.expectationMismatches, []);
  assert.deepEqual(first.latenciesMs, [1.25, 0.4]);
  assert.deepEqual(first.details.map((detail) => ({
    queryId: detail.queryId,
    resultCount: detail.resultCount,
    expressions: detail.expressions,
  })), [
    { queryId: "hit", resultCount: 1, expressions: ["食べる"] },
    { queryId: "miss", resultCount: 0, expressions: [] },
  ]);
  assert.ok(first.details.every((detail) => /^[0-9a-f]{64}$/.test(detail.responseSha256)));
  for (const detail of first.details) {
    const retained = first.responseEvidence[detail.responseSha256];
    assert.equal(sha256Canonical(retained), detail.responseSha256);
    assert.equal(Buffer.byteLength(canonicalJson(retained), "utf8"), detail.responseBytes);
  }
  assert.throws(
    () => analyzeLookupPass(queries, [
      observations[0],
      { ...observations[1], reply: { ...observations[1].reply, dictionaryCount: 0 } },
    ], "fixture", 1),
    /dictionary count/i,
  );
  assert.throws(
    () => analyzeLookupPass(queries, [
      { ...observations[0], reply: { ...observations[0].reply, type: "wrong" } },
      observations[1],
    ], "fixture", 1),
    /response type/i,
  );
});

test("validateRows rejects missing runs, invalid runs, and correctness signature drift", () => {
  const schedule = [
    { runId: "sample-0-a", corpus: "a", warmup: false },
    { runId: "sample-1-a", corpus: "a", warmup: false },
  ];
  const valid = schedule.map((item) => ({
    ...item,
    valid: true,
    archiveSha256: "archive",
    importReportSignature: "report",
    lookupQueryFixtureSha256: "queries",
    lookup: {
      postImport: { signature: "lookup" },
      postRestart: { signature: "lookup" },
    },
  }));

  assert.doesNotThrow(() => validateRows(valid, schedule));
  assert.throws(() => validateRows(valid.slice(0, 1), schedule), /missing run sample-1-a/i);
  assert.throws(() => validateRows([{ ...valid[0], valid: false }, valid[1]], schedule), /invalid run sample-0-a/i);
  assert.throws(
    () => validateRows([valid[0], { ...valid[1], lookupQueryFixtureSha256: "changed" }], schedule),
    /query fixture signature drift/i,
  );
  assert.throws(
    () => validateRows([{
      ...valid[0],
      lookup: { ...valid[0].lookup, postRestart: { signature: "different" } },
    }, valid[1]], schedule),
    /across restart/i,
  );
});

function evidenceSignature(details) {
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

function strictValidationFixture() {
  const schedule = [{
    runId: "sample-00-00-fixture",
    corpus: "fixture",
    warmup: false,
    round: 0,
    iteration: 0,
    order: 0,
  }];
  const queries = [
    { id: "hit", text: "食べる", expect: "hit", expectedExpression: "食べる" },
    { id: "miss", text: "xyzzy", expect: "miss" },
  ];
  const definition = {
    schemaVersion: 1,
    config: {
      corpora: [{
        id: "fixture",
        archive: "/tmp/fixture.zip",
        archiveSha256: "a".repeat(64),
        archiveBytes: 123,
        expectedReport: { success: true, title: "fixture", termCount: 1 },
        expectedDictionaryCount: 1,
      }],
      queries,
      lookupPasses: 1,
      idleCheckMs: 0,
      seed: 7,
    },
    schedule,
  };
  const ordered = orderQueries(queries, { seed: 7, corpus: "fixture" });
  const responseFor = (query) => ({
    ok: true,
    error: null,
    dictionaryCount: 1,
    results: query.expect === "hit" ? [{ term: { expression: "食べる", reading: "たべる" } }] : [],
  });
  const responseEvidence = Object.fromEntries(ordered.map((query) => {
    const response = responseFor(query);
    return [sha256Canonical(response), response];
  }));
  const makeDetails = (prefix) => ordered.map((query) => {
    const response = responseFor(query);
    return {
      queryId: query.id,
      text: query.text,
      requestId: `${prefix}-${query.id}`,
      responseType: "hd_lookup_result",
      responseOk: true,
      responseError: null,
      latencyMs: query.expect === "hit" ? 1 : 0.5,
      resultCount: response.results.length,
      expressions: response.results.map((result) => result.term.expression),
      responseBytes: Buffer.byteLength(canonicalJson(response), "utf8"),
      responseSha256: sha256Canonical(response),
    };
  });
  const makePhase = (prefix) => {
    const warmDetails = makeDetails(`${prefix}-warm`);
    const passDetails = makeDetails(`${prefix}-pass`);
    const signature = evidenceSignature(warmDetails);
    return {
      signature,
      generation: 1,
      hitCount: 1,
      missCount: 1,
      responseEvidence,
      warmup: {
        wallMs: 2,
        latenciesMs: warmDetails.map((detail) => detail.latencyMs),
        details: warmDetails,
        signature,
      },
      passes: [{
        index: 0,
        wallMs: 2,
        latenciesMs: passDetails.map((detail) => detail.latencyMs),
        details: passDetails,
        signature,
      }],
    };
  };
  const makeFirst = (prefix) => {
    const firstDetail = makeDetails(prefix).find((detail) => detail.resultCount > 0);
    return {
      wallMs: 1,
      completedAtMs: 10,
      latencyMs: firstDetail.latencyMs,
      signature: evidenceSignature([firstDetail]),
      responseEvidence: {
        [firstDetail.responseSha256]: responseEvidence[firstDetail.responseSha256],
      },
      generation: 1,
      detail: firstDetail,
    };
  };
  const importReport = {
    success: true,
    error: "",
    title: "fixture",
    termCount: 1,
    metaCount: 0,
    frequencyCount: 0,
    pitchCount: 0,
    kanjiCount: 0,
    mediaCount: 0,
  };
  const storage = {
    backend: "opfs",
    origin: `chrome-extension://${"a".repeat(32)}`,
    logicalBytes: 50,
    usageBytes: 80,
    quotaBytes: 1000,
    fileCount: 2,
    files: [
      { path: "fixture/.hoshidicts_3", bytes: 2, sha256: "b".repeat(64) },
      { path: "fixture/blobs.bin", bytes: 48, sha256: "c".repeat(64) },
    ],
  };
  const row = {
    schemaVersion: 1,
    attempt: 0,
    ...schedule[0],
    valid: true,
    runDefinitionSha256: sha256Canonical(definition),
    archiveSha256: "a".repeat(64),
    archiveBytes: 123,
    archiveObservedBeforeSha256: "a".repeat(64),
    archiveObservedBeforeBytes: 123,
    archiveObservedAfterSha256: "a".repeat(64),
    archiveObservedAfterBytes: 123,
    shutdownVerified: true,
    extensionId: "a".repeat(32),
    profilePath: "/tmp/fixture-profile",
    profileRetained: null,
    profileDisposition: "delete-after-persistence",
    importReport,
    importReportSignature: sha256Canonical(importReport),
    dictionaryCount: 1,
    storedDictionaries: [{ title: "fixture", path: "/dicts/fixture", kind: "term", enabled: true }],
    lookupQueryIds: ordered.map((query) => query.id),
    lookupQueryFixtureSha256: sha256Canonical(ordered),
    importRequestId: "import-request",
    importResponse: {
      type: "hd_import_result",
      requestId: "import-request",
      ok: true,
      error: null,
      generation: 1,
      report: importReport,
    },
    metrics: {
      initialLaunchWallMs: 1,
      initialReadyWallMs: 2,
      importUsableWallMs: 5,
      importWallMs: 4,
      importMessageWallMs: 3,
      importPeakRssBytes: 100,
      importPeakProcessCount: 2,
      importProcessTreeCpuTicks: 3,
      importRssSampleIntervalMs: 50,
      importRssSamples: 2,
      postImportReadyWaitMs: 1,
      firstLookupAfterImportMs: 1,
      restartLaunchWallMs: 2,
      restartReadyWallMs: 3,
      restartUsableWallMs: 4,
      restoreReadyWaitMs: 1,
      restorePeakRssBytes: 90,
      restorePeakProcessCount: 2,
      restoreProcessTreeCpuTicks: 2,
      restoreRssSampleIntervalMs: 50,
      restoreRssSamples: 2,
      firstLookupAfterRestartMs: 1,
    },
    timingEvidence: {
      importPagePerformanceNow: {
        userStartMs: 5,
        messageStartMs: 5.5,
        messageEndMs: 8.5,
        uiEndMs: 9,
        firstLookupCompletedMs: 10,
      },
      restartHostPerformanceNow: {
        startedMs: 20,
        readyMs: 23,
        firstLookupCompletedMs: 24,
      },
    },
    lookup: { postImport: makePhase("import"), postRestart: makePhase("restart") },
    firstLookup: { postImport: makeFirst("first-import"), postRestart: makeFirst("first-restart") },
    storage: structuredClone(storage),
    storageAfterImport: structuredClone(storage),
    idle: null,
    lifecycle: {
      initialStatus: {
        type: "hd_status_result", requestId: "status-initial", ok: true, error: null,
        generation: 1, dictionaryCount: 0, ready: true, loading: false,
      },
      afterImportStatus: {
        type: "hd_status_result", requestId: "status-import", ok: true, error: null,
        generation: 1, dictionaryCount: 1, ready: true, loading: false,
      },
      restoredStatus: {
        type: "hd_status_result", requestId: "status-restored", ok: true, error: null,
        generation: 1, dictionaryCount: 1, ready: true, loading: false,
      },
    },
  };
  return { schedule, definition, row };
}

test("validateRows binds rows to schedule, definition, internal hashes, and finite metrics", () => {
  const { schedule, definition, row } = strictValidationFixture();
  assert.doesNotThrow(() => validateRows([row], schedule, definition));

  const rejects = [
    [{ ...row, attempt: undefined }, /attempt/i],
    [{ ...row, order: 9 }, /schedule/i],
    [{ ...row, runDefinitionSha256: "d".repeat(64) }, /run definition/i],
    [{ ...row, archiveSha256: "e".repeat(64) }, /archive/i],
    [{ ...row, archiveObservedAfterSha256: "e".repeat(64) }, /observed archive|archive.*changed/i],
    [{ ...row, shutdownVerified: false }, /shutdown/i],
    [{ ...row, profileRetained: false }, /profile disposition/i],
    [{ ...row, extensionId: "" }, /extension ID/i],
    [{ ...row, storage: { ...row.storage, origin: null } }, /OPFS|origin/i],
    [{ ...row, importReport: { ...row.importReport, termCount: 2 } }, /import report/i],
    (() => {
      const changed = structuredClone(row);
      changed.importReport.success = false;
      changed.importReportSignature = sha256Canonical(changed.importReport);
      return [changed, /import report.*success|successful import/i];
    })(),
    [{ ...row, importResponse: { ...row.importResponse, type: "wrong_result" } }, /import response/i],
    [{ ...row, importResponse: { ...row.importResponse, generation: 99 } }, /generation/i],
    [{ ...row, storedDictionaries: [null] }, /stored dictionar|storage dictionary/i],
    [{
      ...row,
      metrics: {
        ...row.metrics,
        firstLookupAfterRestartMs: row.metrics.firstLookupAfterRestartMs + 999,
      },
    }, /first lookup.*metric|metric.*first lookup/i],
    [{ ...row, metrics: { ...row.metrics, firstLookupAfterRestartMs: null } }, /metric/i],
    [{ ...row, metrics: { ...row.metrics, initialLaunchWallMs: -1 } }, /metric/i],
    [{ ...row, metrics: { ...row.metrics, importRssSamples: 1.5 } }, /metric/i],
    [{
      ...row,
      metrics: { ...row.metrics, importUsableWallMs: row.metrics.importUsableWallMs + 100_000 },
    }, /timing evidence/i],
    [{
      ...row,
      metrics: { ...row.metrics, restartReadyWallMs: row.metrics.restartReadyWallMs + 100_000 },
    }, /timing/i],
    [{
      ...row,
      metrics: { ...row.metrics, restartUsableWallMs: row.metrics.restartUsableWallMs + 100_000 },
    }, /timing evidence/i],
    [{
      ...row,
      timingEvidence: {
        ...row.timingEvidence,
        restartHostPerformanceNow: {
          ...row.timingEvidence.restartHostPerformanceNow,
          readyMs: Number.NaN,
        },
      },
    }, /timing evidence/i],
    [{
      ...row,
      firstLookup: {
        ...row.firstLookup,
        postRestart: { ...row.firstLookup.postRestart, signature: "f".repeat(64) },
      },
    }, /first lookup/i],
    [{
      ...row,
      lookup: {
        ...row.lookup,
        postImport: {
          ...row.lookup.postImport,
          warmup: {
            ...row.lookup.postImport.warmup,
            details: row.lookup.postImport.warmup.details.map((detail, index) =>
              index === 0 ? { ...detail, responseSha256: "0".repeat(64) } : detail),
          },
        },
      },
    }, /response body|response signature/i],
    (() => {
      const changed = structuredClone(row);
      const hash = Object.keys(changed.lookup.postImport.responseEvidence)
        .find((key) => changed.lookup.postImport.responseEvidence[key].results.length > 0);
      changed.lookup.postImport.responseEvidence[hash].results = [];
      return [changed, /response body/i];
    })(),
    [{
      ...row,
      firstLookup: {
        ...row.firstLookup,
        postImport: {
          ...row.firstLookup.postImport,
          detail: { ...row.firstLookup.postImport.detail, responseType: "wrong_result" },
        },
      },
    }, /response envelope/i],
    [{
      ...row,
      lifecycle: {
        ...row.lifecycle,
        restoredStatus: { ...row.lifecycle.restoredStatus, ready: false },
      },
    }, /status response/i],
  ];
  for (const [changed, pattern] of rejects) {
    assert.throws(() => validateRows([changed], schedule, definition), pattern);
  }
});

test("validateRows selects the latest explicit attempt and rejects duplicate attempt numbers", () => {
  const { schedule, definition, row } = strictValidationFixture();
  const failedAttempt = {
    ...row,
    attempt: 0,
    valid: false,
    outcome: "failure",
    error: "transient failure",
  };
  const successfulRetry = { ...row, attempt: 1 };
  assert.deepEqual(validateRows([failedAttempt, successfulRetry], schedule, definition), [successfulRetry]);
  assert.throws(
    () => validateRows([successfulRetry, { ...successfulRetry }], schedule, definition),
    /duplicate.*attempt/i,
  );
  assert.throws(
    () => validateRows([{ ...successfulRetry, attempt: 2 }], schedule, definition),
    /contiguous|attempt 0/i,
  );
  assert.throws(
    () => validateRows([{ ...row, attempt: 0 }, { ...failedAttempt, attempt: 1 }], schedule, definition),
    /after.*validated|validated.*attempt/i,
  );
});

test("expected import failures are validated and reported without fabricating performance", () => {
  assert.equal(matchesExpectedFailure("too large", new Error("request too large")), false);
  const productionFailure = new Error("request too large");
  productionFailure.benchmarkFailure = {
    phase: "import",
    origin: "extension",
    response: {
      type: "hd_import_result",
      requestId: "import-failure-request",
      ok: false,
      error: "request too large",
      report: { success: false },
    },
  };
  assert.equal(matchesExpectedFailure("too large", productionFailure), true);
  const ungroundedFailure = new Error("request too large");
  ungroundedFailure.benchmarkFailure = { phase: "import", origin: "extension" };
  assert.equal(matchesExpectedFailure("too large", ungroundedFailure), false);
  const laterFailure = new Error("request too large");
  laterFailure.benchmarkFailure = { phase: "lookup", origin: "extension" };
  assert.equal(matchesExpectedFailure("too large", laterFailure), false);
  const unexpectedSuccess = new Error("expected failure 'too large', but the run succeeded");
  unexpectedSuccess.benchmarkUnexpectedSuccess = true;
  assert.equal(matchesExpectedFailure("too large", unexpectedSuccess), false);
  const schedule = [{ runId: "sample-0-pixiv", corpus: "pixiv-light", warmup: false }];
  const rows = [{
    ...schedule[0],
    valid: true,
    outcome: "expected-failure",
    shutdownVerified: true,
    archiveSha256: "pixiv-archive",
    observedError: "serialized request exceeds browser limit",
    expectedFailureIncludes: "exceeds browser limit",
    failurePhase: "import",
    failureOrigin: "extension",
    importRequestId: "import-failure-request",
    importResponse: {
      type: "hd_import_result",
      requestId: "import-failure-request",
      ok: false,
      error: "serialized request exceeds browser limit",
      generation: 0,
    },
  }];
  assert.doesNotThrow(() => validateRows(rows, schedule));
  assert.throws(() => validateRows([{ ...rows[0], shutdownVerified: false }], schedule), /shutdown/i);
  assert.throws(() => validateRows([{
    ...rows[0],
    importResponse: { ...rows[0].importResponse, type: "wrong_result" },
  }], schedule), /expected-failure.*response|import failure response/i);
  const summary = buildSummary(rows, { mode: "rough" });
  assert.equal(summary.corpora["pixiv-light"].status, "expected-failure");
  assert.equal(summary.corpora["pixiv-light"].sampleCount, 1);
  assert.match(renderMarkdown(summary), /Unsupported workloads/);
  assert.match(renderMarkdown(summary), /serialized request exceeds browser limit/);
  assert.match(renderCsv(summary), /pixiv-light,expected_failure,count,1,/);
});

test("buildSummary excludes warmups and reports import, restore, and lookup distributions", () => {
  const phase = (signature, passWallMs, latenciesMs) => ({
    signature,
    hitCount: 1,
    missCount: 1,
    passes: [{
      wallMs: passWallMs,
      latenciesMs,
      details: latenciesMs.map((latencyMs, index) => ({
        latencyMs,
        resultCount: index === 0 ? 1 : 0,
      })),
    }],
  });
  const row = (runId, warmup, importWallMs, restartReadyWallMs, lookupWallMs) => ({
    runId,
    corpus: "fixture",
    warmup,
    valid: true,
    archiveSha256: "archive",
    archiveBytes: 1000,
    importReportSignature: "report",
    importReport: { title: "fixture", termCount: 100, mediaCount: 2 },
    metrics: {
      importUsableWallMs: importWallMs + 100,
      importWallMs,
      importMessageWallMs: importWallMs - 100,
      restartReadyWallMs,
      restartUsableWallMs: restartReadyWallMs + 10,
      firstLookupAfterImportMs: 1,
      firstLookupAfterRestartMs: 2,
      importPeakRssBytes: 1000,
      restorePeakRssBytes: 800,
    },
    storage: { logicalBytes: 600, usageBytes: 1024, fileCount: 4 },
    lookup: {
      postImport: phase("lookup", lookupWallMs, [1, 3]),
      postRestart: phase("lookup", lookupWallMs + 2, [2, 4]),
    },
  });
  const rows = [
    row("warmup", true, 999, 999, 999),
    row("sample-0", false, 1000, 50, 10),
    row("sample-1", false, 2000, 70, 20),
  ];

  const summary = buildSummary(rows, { commit: "abc", mode: "rough" });
  const fixture = summary.corpora.fixture;

  assert.equal(summary.metadata.commit, "abc");
  assert.equal(fixture.sampleCount, 2);
  assert.equal(fixture.importUsableWallMs.median, 1600);
  assert.equal(fixture.importWallMs.median, 1500);
  assert.equal(fixture.importMessageWallMs.median, 1400);
  assert.equal(fixture.importThroughputTermsPerSecond.median, 69.26406926406926);
  assert.equal(fixture.restartReadyWallMs.median, 60);
  assert.equal(fixture.restartUsableWallMs.median, 70);
  assert.equal(fixture.firstLookupAfterImportMs.median, 1);
  assert.equal(fixture.firstLookupAfterRestartMs.median, 2);
  assert.deepEqual(fixture.lookup.postImport.requestLatencyMs.samples, [1, 1, 3, 3]);
  assert.equal(fixture.lookup.postImport.hitRequestLatencyMs.median, 1);
  assert.equal(fixture.lookup.postImport.missRequestLatencyMs.median, 3);
  assert.equal(fixture.lookup.postImport.throughputQueriesPerSecond.median, 150);
  assert.equal(fixture.lookup.postRestart.requestLatencyMs.median, 3);
  const markdown = renderMarkdown(summary);
  assert.match(markdown, /# Hachidori browser benchmark/);
  assert.match(markdown, /\| fixture \| 1\.600 \[1\.100–2\.100\] s \|/);
  assert.match(markdown, /Full Chrome restart → first valid lookup/);
  assert.match(markdown, /## Usable → lookup/);
  assert.match(markdown, /First hit after import/);
  assert.match(markdown, /Post-restart steady lookup/);
  const csv = renderCsv(summary);
  assert.match(csv, /^corpus,metric,unit,median,p95,min,max,n/m);
  assert.match(csv, /fixture,import_usable_wall,ms,1600,/);
  assert.match(csv, /fixture,import_wall,ms,1500,/);
  assert.match(csv, /fixture,first_lookup_after_import,ms,1,/);
});

test("normalizeConfig resolves archives and applies benchmark defaults", () => {
  const config = normalizeConfig({
    corpora: [{ id: "fixture", archive: "../test/fixture.zip", queryIds: ["hit"] }],
    queries: [
      { id: "hit", text: "食べる", expect: "hit" },
      { id: "miss", text: "xyzzy", expect: "miss" },
    ],
    lookup: {
      maxResults: 48,
      scanLength: 24,
      options: { frequencyOrder: "ascending" },
    },
  }, "/repo/benchmark");

  assert.equal(config.corpora[0].archive, "/repo/test/fixture.zip");
  assert.equal(Object.hasOwn(config.corpora[0], "expectedSha256"), false);
  assert.equal(config.warmups, 1);
  assert.equal(config.samples, 3);
  assert.equal(config.lookupPasses, 5);
  assert.equal(config.seed, 20260902);
  assert.equal(config.allowNoSandbox, false);
  assert.equal(config.timeoutMs, 10 * 60 * 1000);
  assert.equal(config.idleCheckMs, 0);
  assert.deepEqual(config.corpora[0].queryIds, ["hit"]);
  assert.deepEqual(config.lookup, {
    maxResults: 48,
    scanLength: 24,
    options: { frequencyOrder: "ascending" },
  });
  assert.throws(
    () => normalizeConfig({
      corpora: [{ id: "same", archive: "a.zip" }, { id: "same", archive: "b.zip" }],
      queries: [{ id: "q", text: "x" }],
    }, "/tmp"),
    /duplicate corpus id/i,
  );
});

test("normalizeConfig expands archive environment variables and rejects missing values", () => {
  const raw = {
    corpora: [{ id: "fixture", archive: "${HACHIDORI_BENCH_DATA}/dict.zip" }],
    queries: [{ id: "hit", text: "食べる", expect: "hit" }],
  };

  const config = normalizeConfig(raw, "/repo/benchmark", {
    HACHIDORI_BENCH_DATA: "/corpora",
  });
  assert.equal(config.corpora[0].archive, "/corpora/dict.zip");
  assert.throws(
    () => normalizeConfig(raw, "/repo/benchmark", {}),
    /HACHIDORI_BENCH_DATA.*not set/i,
  );
});
