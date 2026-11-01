/*
 * A large dictionary in a real Firefox: the full Pixiv dictionary (387 MB,
 * 776,724 terms) imported from Settings into the single-thread IndexedDB
 * engine, looked up, then looked up again after Firefox restarts on the same
 * profile.
 *
 * The archive is the one benchmark/pixiv-full.json pins, read from
 * HACHIDORI_BENCH_DATA and checked against its SHA-256. Timings are written to
 * test/tmp/ci/firefox-large.json (or HACHIDORI_FIREFOX_LARGE_OUTPUT).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe } from "node:test";
import { check, fatal, markCompleteSuite, step } from "./firefox-e2e/harness.mjs";
import {
  browser, dictionaryState, engineStatus, extensionUrl, HERE, hoverForPopup, importArchives, installHachidori,
  launchFirefox, openPage, page, PROFILE, sendRuntime, servedFiles, serverUrl, setBidi, setBrowser, setDownloads, setPage,
  startSession, waitFor,
} from "./firefox-e2e/session.mjs";

const CONFIG = JSON.parse(readFileSync(resolve(HERE, "../benchmark/pixiv-full.json"), "utf8"));
const [CORPUS] = CONFIG.corpora;
const ARCHIVE = CORPUS.archive.replace("${HACHIDORI_BENCH_DATA}", process.env.HACHIDORI_BENCH_DATA ?? "");
const OUTPUT = process.env.HACHIDORI_FIREFOX_LARGE_OUTPUT || resolve(HERE, "tmp/ci/firefox-large.json");
const PLANNED = [
  "the full Pixiv archive imports through Settings with every term",
  "Pixiv lookups hit and miss as the benchmark expects",
  "a hover on a page shows the Pixiv entry",
  "Pixiv answers lookups after Firefox restarts without re-importing",
];
const timings = {};

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// Each query's outcome as the benchmark config names it.
async function queryOutcomes(target) {
  const outcomes = [];
  for (const query of CONFIG.queries) {
    const started = performance.now();
    const reply = await sendRuntime(target, { target: "hoshidicts-offscreen", type: "hd_lookup", requestId: `large-${query.id}`,
      text: query.text });
    const expressions = (reply.results ?? []).map(result => result.term?.expression);
    outcomes.push({ id: query.id, ms: Math.round(performance.now() - started),
      ok: query.expect === "hit" ? reply.ok && expressions.includes(query.expectedExpression) : reply.ok && expressions.length === 0 });
  }
  return outcomes;
}

describe("large dictionaries", () => {
  step("the full Pixiv archive", async () => {
    if (!process.env.HACHIDORI_BENCH_DATA || !existsSync(ARCHIVE)) {
      fatal(`no Pixiv archive at ${ARCHIVE} (set HACHIDORI_BENCH_DATA to the directory benchmark/pixiv-full.json names)`);
    }
    const digest = await sha256(ARCHIVE);
    if (digest !== CORPUS.expectedSha256) fatal(`${ARCHIVE} has SHA-256 ${digest}, not ${CORPUS.expectedSha256}`);
    await startSession();
    await waitFor(async () => (await engineStatus(page))?.ready || false, { timeout: 60_000 });
    servedFiles.set("/archives/pixiv.zip", ARCHIVE);
    const started = performance.now();
    const state = await importArchives(page, [{ name: ARCHIVE.split("/").at(-1), url: `${serverUrl}/archives/pixiv.zip` }]);
    timings.importMs = Math.round(performance.now() - started);
    const installed = (await dictionaryState(page))?.dictionaries?.[0];
    const expected = CORPUS.expectedReport;
    check("the full Pixiv archive imports through Settings with every term",
      state === "Finished 1 of 1 archive — 1 imported, 0 failed." && installed?.title === expected.title
        && installed.termCount === expected.termCount && installed.mediaCount === expected.mediaCount,
      JSON.stringify({ state, installed, timings }));
    const outcomes = await queryOutcomes(page);
    timings.lookups = outcomes;
    check("Pixiv lookups hit and miss as the benchmark expects", outcomes.every(outcome => outcome.ok), JSON.stringify(outcomes));
  });

  step("a hover and a restart", async () => {
    const reader = await openPage(`${serverUrl}/?large`);
    await reader.evaluate(() => {
      document.body.insertAdjacentHTML("afterbegin", '<p><span id="pixiv">ピクシブのイラスト</span></p>');
    });
    const shown = await hoverForPopup(reader, "#pixiv");
    check("a hover on a page shows the Pixiv entry", shown?.plain.includes("ピクシブ") && shown.text.includes("Pixiv"),
      JSON.stringify(shown?.plain?.slice(0, 200)));
    await reader.close();

    const before = await dictionaryState(page);
    await browser.close();
    const started = performance.now();
    const relaunched = await launchFirefox(PROFILE);
    setBrowser(relaunched.browser);
    setBidi(relaunched.session);
    setDownloads(relaunched.downloads);
    await installHachidori(relaunched.browser);
    setPage(await openPage(extensionUrl("settings.html"), relaunched.browser));
    // The engine reports ready before it has loaded the stored dictionaries.
    const ready = await waitFor(async () => {
      const status = await engineStatus(page);
      return status?.ready && !status.loading ? status : false;
    }, { timeout: 300_000, interval: 250 });
    timings.restartToReadyMs = Math.round(performance.now() - started);
    const outcomes = await queryOutcomes(page);
    timings.lookupsAfterRestart = outcomes;
    check("Pixiv answers lookups after Firefox restarts without re-importing",
      ready?.packageCount === 1 && JSON.stringify(await dictionaryState(page)) === JSON.stringify(before)
        && outcomes.every(outcome => outcome.ok),
      JSON.stringify({ ready, outcomes, timings }));
    const firefox = await page.evaluate(() => navigator.userAgent);
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify({ firefox, archive: ARCHIVE.split("/").at(-1), sha256: CORPUS.expectedSha256,
      storageBackend: ready?.storageBackend, threaded: ready?.threaded, ...timings }, null, 2)}\n`);
    console.log(`timings: ${OUTPUT}`);
  });
});

markCompleteSuite(PLANNED);
