// Optional measurements inside the existing two-browser Sharing acceptance run.
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname } from "node:path";
import { summarizeValues } from "./lib.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const summary = values => {
  const { samples, ...statistics } = summarizeValues(values);
  return statistics;
};

export async function measureSharingLookups(page, browser, serverPath, output) {
  const measured = await page.evaluate(async ({ queries, lookup }) => {
    const rows = [], results = {};
    // The fixture's six existing exact/inflected/reading/normalization/miss
    // queries, with ten excluded warmup passes and fifty measured passes.
    for (let pass = -10; pass < 50; pass += 1) {
      for (const query of queries) {
        const start = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup",
          requestId: `sharing-benchmark-${pass}-${query.id}`, text: query.text, ...lookup, options: {} });
        const latencyMs = performance.now() - start;
        if (!reply?.ok || !Array.isArray(reply.results)
            || (query.expect === "miss" ? reply.results.length !== 0 : reply.results[0]?.term?.expression !== query.expectedExpression)) {
          throw new Error(`benchmark lookup ${query.id} failed: ${JSON.stringify(reply)}`);
        }
        const serialized = JSON.stringify(reply.results);
        if (results[query.id] !== undefined && results[query.id] !== serialized) {
          throw new Error(`benchmark lookup ${query.id} changed results`);
        }
        results[query.id] = serialized;
        if (pass >= 0) rows.push({ pass, query: query.id, latencyMs,
          responseBytes: new TextEncoder().encode(JSON.stringify(reply)).length });
      }
    }
    return { rows, results };
  }, { queries: fixture.queries, lookup: fixture.lookup });
  const record = {
    measuredAt: new Date().toISOString(),
    boundary: "linked-page chrome.runtime request through client worker, Python relay, host worker/WASM and reply",
    excludes: "browser launch, dictionary import, warmup, hover delay, popup rendering and CDP evaluation overhead",
    extensionCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    serverPath, serverSha256: sha256(readFileSync(serverPath)),
    fixtureSha256: sha256(readFileSync(new URL("../test/fixtures/hachidori-fixture.zip", import.meta.url))),
    wasmSha256: sha256(readFileSync(new URL("../extension/vendor/hoshidicts-threaded.wasm", import.meta.url))),
    node: process.version, python: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
    chrome: await browser.version(), platform: platform(), arch: arch(), kernel: release(), cpu: cpus()[0]?.model,
    warmupPasses: 10, measuredPasses: 50, queries: fixture.queries,
    resultSignatures: Object.fromEntries(Object.entries(measured.results).map(([query, text]) => [query, sha256(text)])),
    overall: summary(measured.rows.map(row => row.latencyMs)),
    byQuery: Object.fromEntries(fixture.queries.map(query => [query.id,
      summary(measured.rows.filter(row => row.query === query.id).map(row => row.latencyMs))])),
    rows: measured.rows,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  console.log(`     sharing benchmark: ${JSON.stringify(record.overall)}; raw samples: ${output}`);
}
