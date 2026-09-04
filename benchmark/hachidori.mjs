// SPDX-License-Identifier: GPL-3.0-or-later

import { resolve } from "node:path";

import { runBrowserSample } from "./browser.mjs";
import { lookupSemanticSignature, selectedComparisonQueries } from "./comparison-lib.mjs";
import { sha256Canonical } from "./lib.mjs";

function normalizeDetail(detail) {
  const expressions = [...new Set(detail.expressions)].sort();
  return {
    queryId: detail.queryId,
    text: detail.text,
    latencyMs: detail.latencyMs,
    resultCount: detail.resultCount,
    expressions,
    responseSha256: detail.responseSha256,
  };
}

function normalizeDataset(dataset) {
  const details = dataset.details.map(normalizeDetail);
  return {
    ...(dataset.index === undefined ? {} : { index: dataset.index }),
    wallMs: dataset.wallMs,
    details,
    semanticSha256: lookupSemanticSignature(details),
  };
}

export async function runHachidoriSample({ item, corpus, config, definition, output, launch }) {
  const engine = definition.engines.find((entry) => entry.id === item.engine);
  const hachidoriDefinition = {
    schemaVersion: 1,
    config,
    configSha256: definition.configSha256,
    revision: engine.revision,
    runtime: {
      extensionPath: definition.runtime.hachidoriExtensionPath,
      extensionContentSha256: engine.extensionContentSha256,
      chromePath: definition.runtime.chromePath,
      chromeSha256: definition.runtime.chromeSha256,
      puppeteerPath: definition.runtime.puppeteerPath,
      puppeteerPackageSha256: definition.runtime.puppeteerPackageSha256,
    },
    schedule: definition.schedule.filter((entry) => entry.engine === item.engine),
  };
  const nested = await runBrowserSample({
    item,
    corpus,
    config,
    definition: hachidoriDefinition,
    output: resolve(output, "hachidori"),
    launch,
  });
  const queries = selectedComparisonQueries(config, corpus.id);
  const warmup = normalizeDataset(nested.lookup.postImport.warmup);
  const passes = nested.lookup.postImport.passes.map(normalizeDataset);
  if (passes.some((pass) => pass.semanticSha256 !== warmup.semanticSha256)) {
    throw new Error("Hachidori lookup semantics changed after warmup");
  }
  const firstDetail = nested.firstLookup.postImport.detail;
  const firstLookup = {
    queryId: firstDetail.queryId,
    text: firstDetail.text,
    latencyMs: firstDetail.latencyMs,
    resultCount: firstDetail.resultCount,
    expressions: [...new Set(firstDetail.expressions)].sort(),
    responseSha256: firstDetail.responseSha256,
  };
  const status = nested.lifecycle.afterImportStatus;
  return {
    metrics: {
      importUsableWallMs: nested.metrics.importUsableWallMs,
      importCoreWallMs: nested.metrics.importMessageWallMs,
    },
    firstLookup,
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
      adapter: "hachidori-browser-extension",
      extensionId: nested.extensionId,
      importPath: "settings.html#dictionary-import-file-input",
      lookupPath: "chrome.runtime.sendMessage:hd_lookup",
      threaded: status.threaded,
      storageBackend: status.storageBackend,
      persistenceRestartVerified: nested.lifecycle.restoredStatus.dictionaryCount === nested.dictionaryCount,
      dictionaryTitle: nested.importReport.title,
      termCount: nested.importReport.termCount,
      importResponseType: nested.importResponse.type,
      storageManifestSha256: sha256Canonical(nested.storageAfterImport.files),
      persistedBytes: nested.storageAfterImport.logicalBytes,
      artifactSnapshotVerified: sha256Canonical(nested.storageAfterImport.files) === sha256Canonical(nested.storage.files),
    },
    resources: nested.resources,
    profilePath: nested.profilePath,
    processExitVerified: nested.shutdownVerified === true,
    diagnostics: nested.diagnostics,
    hostStart: nested.hostStart,
    hostEnd: nested.hostEnd,
    startedUtc: nested.startedUtc,
    endedUtc: nested.endedUtc,
  };
}
