// SPDX-License-Identifier: GPL-3.0-or-later
// Production Settings click -> DOM / durable engine reply / first ranked lookup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromeArguments, closeBrowserVerified } from "./browser.mjs";
import { appendJsonlDurable, directoryContentSha256, hostSnapshot, sha256File } from "./system.mjs";
import { buildTitledZip } from "../test/make-fixture.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const root = resolve(argument("root", fileURLToPath(new URL("..", import.meta.url))));
const output = resolve(argument("output", "benchmark/results/dictionary-reorder"));
const revision = argument("revision", null);
const samples = Number(argument("samples", "3"));
const moves = Number(argument("moves", "10"));
const counts = argument("counts", "10,50,150").split(",").map(Number);
const lowMemory = argument("low-memory", "false") === "true";
const expectedPath = argument("expect-path", null);
const chromePath = process.env.HACHIDORI_CHROME || "/usr/bin/chromium";
const puppeteerPath = process.env.HACHIDORI_PUPPETEER
  || resolve(homedir(), ".cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const puppeteer = await import(pathToFileURL(puppeteerPath).href);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url)));
const query = fixture.queries.find(entry => entry.id === "exact");
const archives = Array.from({ length: Math.max(...counts) }, (_, index) => {
  const title = `reorder-${String(index + 1).padStart(3, "0")}`;
  return { title, bytes: buildTitledZip(title) };
});
mkdirSync(output, { recursive: true });
// A source snapshot keeps a comparison in this worktree independent of later
// edits, and can benchmark a settled base without checking out another branch.
const source = revision === null ? root : resolve(output, "source");
if (revision !== null) {
  mkdirSync(source, { recursive: true });
  const archive = execFileSync("git", ["archive", revision, "extension"], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", source], { input: archive });
}
const archiveDirectory = resolve(output, "archives");
mkdirSync(archiveDirectory, { recursive: true });
for (const archive of archives) {
  archive.path = resolve(archiveDirectory, `${archive.title}.zip`);
  writeFileSync(archive.path, archive.bytes);
}
const definition = {
  revision: git("rev-parse", revision ?? "HEAD"), worktreeStatus: revision === null ? git("status", "--short") : "",
  extensionSha256: directoryContentSha256(resolve(source, "extension")),
  node: process.version, chrome: execFileSync(chromePath, ["--version"], { encoding: "utf8" }).trim(),
  host: hostSnapshot(), counts, samples, moves, lowMemory,
  archives: archives.map(({ title, path, bytes }) => ({ title, bytes: bytes.length, sha256: sha256File(path) })),
  limitations: "Small six-term fixture clones; Settings orchestration and native order, not large dictionary I/O. "
    + "DOM mutation is not paint. Clicks invoke the actual DOM button handler; timings exclude CDP. "
    + "Click-to-reply includes debounce; send-to-reply excludes it. Reply timings exclude subsequent Settings renders. "
    + "First lookup starts after the reply and must use the new order; its latency includes only rendering on that critical path, not final UI settlement.",
};
writeFileSync(resolve(output, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`);

async function measureMove(page, index) {
  return page.evaluate(async ({ index, query }) => {
    const list = document.getElementById("dict-list");
    const rows = [...list.children];
    const row = rows[index % 2 ? 0 : 1];
    const button = row.querySelector(index % 2 ? ".dict-down" : ".dict-up");
    const id = row.dataset.dictionaryId;
    const rank = index % 2 ? "2" : "1";
    const beforeIds = rows.map(entry => entry.dataset.dictionaryId);
    [beforeIds[0], beforeIds[1]] = [beforeIds[1], beforeIds[0]];
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let started;
    let sent;
    let replied;
    let resolveReply;
    const replyPromise = new Promise(done => { resolveReply = done; });
    chrome.runtime.sendMessage = (...args) => {
      if (args[0]?.type !== "hd_apply_state") return original(...args);
      sent = performance.now();
      const result = original(...args);
      result.then(reply => { replied = performance.now(); resolveReply(reply); });
      return result;
    };
    const domPromise = new Promise(done => {
      const observer = new MutationObserver(() => {
        const moved = [...list.children].find(entry => entry.dataset.dictionaryId === id);
        if (moved?.querySelector(".dict-rank").textContent !== rank
          || list.children[Number(rank) - 1] !== moved) return;
        observer.disconnect();
        done(performance.now());
      });
      observer.observe(list, { childList: true, subtree: true, characterData: true });
    });
    button.focus();
    started = performance.now();
    button.click();
    const [domAt, reply] = await Promise.all([domPromise, replyPromise]);
    chrome.runtime.sendMessage = original;
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    const lookupStart = performance.now();
    const lookup = await original({ target: "hoshidicts-offscreen", type: "hd_lookup", text: query.text });
    const lookupAt = performance.now();
    const status = await original({ target: "hoshidicts-offscreen", type: "hd_status" });
    const stored = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
    // The fixture has two senses of 食べる in each package.
    const expectedTitles = stored.dictionaries.flatMap(entry => [entry.title, entry.title]);
    const actualTitles = lookup.results?.[0]?.term.glossaries.map(entry => entry.dictionary);
    if (!lookup.ok || lookup.results[0]?.term.expression !== query.expectedExpression
      || JSON.stringify(actualTitles) !== JSON.stringify(expectedTitles)) {
      throw new Error(`lookup rank mismatch: ${JSON.stringify({ actualTitles, expectedTitles, lookup })}`);
    }
    if (JSON.stringify(stored.dictionaries.map(entry => entry.id)) !== JSON.stringify(beforeIds)) {
      throw new Error("persisted order did not follow the click");
    }
    return { clickToDomMs: domAt - started, clickToReplyMs: replied - started,
      sendToReplyMs: replied - sent, clickToLookupMs: lookupAt - started, lookupMs: lookupAt - lookupStart,
      domBeforeReply: domAt < replied, path: status.lastLoadPath ?? "unreported-baseline",
      generation: status.generation, storageBackend: status.storageBackend, threaded: status.threaded };
  }, { index, query });
}

async function sample(iteration) {
  const profile = mkdtempSync(resolve(tmpdir(), "hachidori-reorder-"));
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, protocolTimeout: 600_000,
    args: chromeArguments({ runtime: { extensionPath: resolve(source, "extension") } }, { allowNoSandbox: true }) });
  try {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker"
      && target.url().startsWith("chrome-extension://"));
    const id = new URL(worker.url()).host;
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(`chrome-extension://${id}/settings.html#add-dictionaries`);
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById("engine-status").textContent.startsWith("Ready"));
    for (const other of await browser.pages()) {
      if (other !== page && other.url().includes("startup.html")) await other.close();
    }
    if (lowMemory) {
      const reply = await page.evaluate(async () => {
        const { options } = await chrome.storage.local.get("options");
        return chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
          baseRevision: options?.revision ?? 0, options: { lowMemoryMode: true } });
      });
      assert.equal(reply.ok, true, JSON.stringify(reply));
      await page.waitForFunction(async () => {
        const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
        return status.ok && status.ready && !status.loading && status.lowMemory;
      });
    }
    let installed = 0;
    for (const count of counts) {
      await page.evaluate(() => { location.hash = "add-dictionaries"; });
      await (await page.$("#import-file")).uploadFile(...archives.slice(installed, count).map(entry => entry.path));
      await page.waitForFunction(count => document.getElementById("import-state").textContent
        === `Finished ${count} of ${count} archives — ${count} imported, 0 failed.`,
      { timeout: 600_000, polling: 100 }, count - installed);
      installed = count;
      if (lowMemory) {
        // Exclude the import's necessary recycle from reorder measurements.
        await page.waitForFunction(async count => {
          const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
          return status.ok && status.ready && !status.loading && status.lowMemory
            && status.dictionaryCount === count && status.generation === 1;
        }, { timeout: 60_000, polling: 100 }, count);
      }
      await page.evaluate(() => { location.hash = "dictionaries"; });
      await page.waitForFunction(count => document.querySelectorAll("#dict-list .dict-row").length === count, {}, count);
      await measureMove(page, 0); // excluded warmup, restored by the second move
      await measureMove(page, 1);
      for (let move = 0; move < moves; move++) {
        const result = await measureMove(page, move);
        assert.equal(result.storageBackend, "opfs");
        assert.equal(result.threaded, true);
        if (expectedPath !== null) assert.equal(result.path, expectedPath);
        appendJsonlDurable(resolve(output, "raw.jsonl"), { revision: definition.revision, iteration, count, move, lowMemory, phase: "move", ...result });
      }
      if (lowMemory) {
        const deferred = await page.evaluate(async query => {
          const request = (type, fields = {}) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type, ...fields });
          const before = await request("hd_status");
          const started = performance.now();
          await new Promise(done => setTimeout(done, 2500));
          let after = await request("hd_status");
          while (!after.ready || after.loading) {
            await new Promise(done => setTimeout(done, 100));
            after = await request("hd_status");
          }
          const lookup = await request("hd_lookup", { text: query.text });
          const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
          const titles = dictionaryState.dictionaries.flatMap(entry => [entry.title, entry.title]);
          if (!lookup.ok || lookup.results[0]?.term.expression !== query.expectedExpression
            || JSON.stringify(lookup.results[0].term.glossaries.map(entry => entry.dictionary)) !== JSON.stringify(titles)) {
            throw new Error("the lookup after the recycle window did not retain the saved order");
          }
          return { beforeGeneration: before.generation, afterGeneration: after.generation,
            recycled: after.generation !== before.generation, idleToLookupMs: performance.now() - started };
        }, query);
        if (expectedPath === "order-only") assert.equal(deferred.recycled, false, "order-only work must not schedule a deferred rebuild");
        appendJsonlDurable(resolve(output, "raw.jsonl"), { revision: definition.revision, iteration, count, lowMemory, phase: "idle", ...deferred });
      }
      console.log(`sample ${iteration}: ${count} dictionaries, ${moves} moves`);
      if (iteration === 1) await page.screenshot({ path: resolve(output, `library-${count}.png`) });
    }
  } finally {
    await closeBrowserVerified(browser);
    rmSync(profile, { recursive: true, force: true });
  }
}

for (let iteration = 1; iteration <= samples; iteration++) await sample(iteration);
console.log(`Raw timings and environment: ${output}`);
