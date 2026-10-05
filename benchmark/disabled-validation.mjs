// SPDX-License-Identifier: GPL-3.0-or-later
//
// Disabled-dictionary validation: imports the archives into a fresh Chrome
// profile, disables the packages whose titles start with --disable, restarts
// Chrome on the retained profile and records the restart-to-ready time and the
// engine heap (which keeps the startup validation's high-water mark), then
// re-enables them and records the in-place load. See docs/memory.md.
//
//   node benchmark/disabled-validation.mjs --archive /path/to/jitendex.zip \
//     --archive /path/to/pixiv.zip --disable Pixiv --text 食べる \
//     --samples 3 --output benchmark/results/disabled-validation.json

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = resolve(REPO, "extension");
const CHROME = process.env.HACHIDORI_CHROME;
const PUPPETEER = process.env.HACHIDORI_PUPPETEER;

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const ARCHIVES = process.argv.flatMap((value, index) => (process.argv[index - 1] === "--archive" ? [resolve(value)] : []));
const DISABLE = argument("disable", null);
const TEXT = argument("text", "食べる");
const SAMPLES = Number(argument("samples", "3"));
const OUTPUT = resolve(argument("output", resolve(REPO, "benchmark/results/disabled-validation.json")));

async function sample(puppeteer, index) {
  const profile = `/tmp/hachidori-disabled-validation-${process.pid}-${index}`;
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  let browser = null;
  let page = null;
  async function launch() {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: true, userDataDir: profile,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30_000 });
    for (const open of await browser.pages()) if (open.url().includes("startup.html")) await open.close();
    page = await browser.newPage();
    await page.goto(`chrome-extension://${new URL(target.url()).host}/settings.html#advanced`, { waitUntil: "domcontentloaded" });
  }
  const engine = (type, fields = {}) => page.evaluate((type, fields) => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen", type, requestId: `bench-${type}-${Math.random()}`, ...fields,
  }), type, fields);
  const waitReady = (count) => page.waitForFunction(async (count) => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status?.ok && status.ready && !status.loading && status.dictionaryCount >= count ? status : false;
  }, { timeout: 600_000, polling: 50 }, count).then((handle) => handle.jsonValue());
  const state = () => page.evaluate(async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState);
  const lookupHash = async () => {
    const reply = await engine("hd_lookup", { text: TEXT });
    return { count: reply.results?.length ?? 0, json: JSON.stringify(reply.results ?? []).length };
  };
  try {
    await launch();
    await waitReady(0);
    await (await page.$("#import-file")).uploadFile(...ARCHIVES);
    await page.waitForFunction(async (count) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return dictionaryState?.dictionaries?.length === count && status?.ok && status.ready && !status.loading;
    }, { timeout: 600_000, polling: 100 }, ARCHIVES.length);
    const all = await state();
    const disabledTitles = all.dictionaries.filter((entry) => entry.title.startsWith(DISABLE)).map((entry) => entry.title);
    if (disabledTitles.length === 0) throw new Error(`no imported title starts with ${DISABLE}`);
    const disabled = await engine("hd_apply_state", { baseRevision: all.revision,
      dictionaries: all.dictionaries.map((entry) => (disabledTitles.includes(entry.title) ? { ...entry, enabled: false } : entry)) });
    if (!disabled.ok) throw new Error(`disable failed: ${JSON.stringify(disabled)}`);
    const enabledLookup = await lookupHash();
    await browser.close();
    // Fresh Chrome process on the retained profile: startup validates the
    // disabled packages before the enabled set is published.
    const restartStarted = performance.now();
    await launch();
    const restored = await waitReady(1);
    const restartMs = performance.now() - restartStarted;
    const afterRestart = await engine("hd_memory");
    const restoredLookup = await lookupHash();
    const current = await state();
    const enableStarted = performance.now();
    const enabled = await engine("hd_apply_state", { baseRevision: current.revision,
      dictionaries: current.dictionaries.map((entry) => ({ ...entry, enabled: true })) });
    const enableMs = performance.now() - enableStarted;
    const afterEnable = await engine("hd_memory");
    const enabledStatus = await engine("hd_status");
    return {
      disabledTitles, restartMs, lastLoadPath: restored.lastLoadPath, failedDictionaries: restored.failedDictionaries,
      heapAfterRestart: afterRestart.heapBytes,
      loadedAfterRestart: afterRestart.dictionaries.map(({ title, bytes, paged }) => ({ title, bytes, paged })),
      lookupParity: JSON.stringify(enabledLookup) === JSON.stringify(restoredLookup), restoredLookup,
      enableOk: enabled.ok === true, enableMs, enableLoadPath: enabledStatus.lastLoadPath,
      heapAfterEnable: afterEnable.heapBytes,
      loadedAfterEnable: afterEnable.dictionaries.map(({ title, bytes, paged }) => ({ title, bytes, paged })),
    };
  } finally {
    await browser?.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const mb = (bytes) => `${(bytes / 1_048_576).toFixed(0)} MB`;

async function main() {
  if (!CHROME || !existsSync(CHROME)) throw new Error("set HACHIDORI_CHROME");
  if (!PUPPETEER || !existsSync(PUPPETEER)) throw new Error("set HACHIDORI_PUPPETEER");
  if (ARCHIVES.length === 0 || DISABLE === null) throw new Error("pass --archive and --disable");
  const module = await import(pathToFileURL(PUPPETEER).href);
  const puppeteer = module.default?.launch ? module.default : module;
  const rows = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const row = await sample(puppeteer, index);
    rows.push(row);
    console.log(`#${index + 1}: restart ${row.restartMs.toFixed(0)} ms heap ${mb(row.heapAfterRestart)} (${row.lastLoadPath});`
      + ` enable ${row.enableMs.toFixed(0)} ms heap ${mb(row.heapAfterEnable)}; parity ${row.lookupParity}`);
  }
  const result = {
    revision: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(),
    chromeVersion: execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(), node: process.version,
    archives: ARCHIVES, disable: DISABLE, text: TEXT, recordedAt: new Date().toISOString(), rows,
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nwrote ${OUTPUT}`);
}

await main();
