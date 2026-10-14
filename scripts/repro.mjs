// Reproduction for bee-san/hachidori#578: import a large batch from Settings and
// record what the service worker relayed to the engine while each import ran.
// Not part of the suite; lives under the ignored test/tmp.
//
// REPRO_MODE=fresh   start the batch as soon as Settings opens (fresh profile)
// REPRO_MODE=settled wait for Settings to settle first
// REPRO_MODE=backup  settled, plus the daily automatic backup comes due mid-batch
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTitledZip } from "../../make-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const EXTENSION = process.env.REPRO_EXTENSION ?? resolve(ROOT, "extension");
const CHROME = process.env.HACHIDORI_CHROME
  ?? resolve(ROOT, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const PUPPETEER = resolve(ROOT, "test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const MODE = process.env.REPRO_MODE ?? "fresh";
const COUNT = Number(process.env.REPRO_COUNT ?? 45);
const LARGE = Number(process.env.REPRO_LARGE ?? 3);
const LARGE_ROWS = Number(process.env.REPRO_LARGE_ROWS ?? 300_000);
const BACKUP_DUE_MS = Number(process.env.REPRO_BACKUP_DUE_MS ?? 1500);
const PROFILE = resolve(HERE, `profile-${process.pid}`);
const ARCHIVES = resolve(HERE, "archives");

function kana(index) {
  const syllables = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
  let value = index;
  let out = "";
  do {
    out += syllables[value % syllables.length];
    value = Math.floor(value / syllables.length);
  } while (value > 0);
  return out;
}

function archive(index, large) {
  const number = String(index + 1).padStart(3, "0");
  const title = large ? `${number}-Large-Frequency` : `${number}-Synthetic`;
  const terms = [[`語${index}`, kana(index), "n", "", 10, [`synthetic definition ${index}`], index + 1, ""]];
  const termMeta = large
    ? Array.from({ length: LARGE_ROWS }, (_, row) => [`語${row}`, "freq", { value: row + 1, displayValue: String(row + 1) }])
    : [[`語${index}`, "freq", { value: index + 1 }]];
  const path = resolve(ARCHIVES, `${title}.zip`);
  writeFileSync(path, buildTitledZip(title, { terms, termMeta, revision: `r${index}` }));
  return path;
}

rmSync(ARCHIVES, { recursive: true, force: true });
mkdirSync(ARCHIVES, { recursive: true });
// Large frequency lists sit in the middle of the batch, as in the report.
const largeFrom = Math.max(0, Math.floor(COUNT * 0.7));
const paths = Array.from({ length: COUNT }, (_, index) => archive(index, index >= largeFrom && index < largeFrom + LARGE));
const seed = archive(900, false);
console.log(`mode ${MODE}: ${paths.length} archives (${LARGE} with ${LARGE_ROWS} frequency rows)`);

const puppeteer = await import(pathToFileURL(PUPPETEER).href);
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.default.launch({
  executablePath: CHROME,
  enableExtensions: true,
  headless: true,
  userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const diagnostics = [];
browser.on("targetcreated", async (target) => {
  if (!target.url().endsWith("offscreen.html")) return;
  const cdp = await target.createCDPSession();
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.consoleAPICalled", (event) => diagnostics.push(`[offscreen ${event.type}] ${event.args.map((a) => a.value ?? a.description).join(" ")}`));
});
const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extensionId = new URL(swTarget.url()).host;
const sw = await swTarget.worker();
sw.on("console", (message) => diagnostics.push(`[sw ${message.type()}] ${message.text()}`));
// Record every engine request the worker relays, with its start and end times.
await sw.evaluate(() => {
  const original = chrome.runtime.sendMessage;
  const log = [];
  globalThis.__relayLog = log;
  const t0 = performance.now();
  chrome.runtime.sendMessage = function (message, ...rest) {
    const result = original.call(this, message, ...rest);
    if (message?.relayed === true && message.target === "hoshidicts-offscreen") {
      const entry = { type: message.type, requestId: message.requestId, start: Math.round(performance.now() - t0) };
      log.push(entry);
      Promise.resolve(result).then((reply) => {
        entry.end = Math.round(performance.now() - t0);
        entry.ok = reply?.ok;
        entry.error = reply?.error ?? null;
      }, (error) => {
        entry.end = Math.round(performance.now() - t0);
        entry.error = String(error);
      });
    }
    return result;
  };
});

const page = await browser.newPage();
page.on("console", (message) => diagnostics.push(`[settings ${message.type()}] ${message.text()}`));
await page.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#import-file");
for (const other of await browser.pages()) if (other !== page && other.url().includes("startup.html")) await other.close();
const input = await page.$("#import-file");

async function runBatch(files) {
  await input.uploadFile(...files);
  await page.waitForFunction((count) => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith(`Finished ${count} of ${count}`) ? text : false;
  }, { timeout: 30 * 60_000, polling: 100 }, files.length);
  return page.evaluate(() => ({
    state: document.getElementById("import-state").textContent.trim(),
    rows: [...document.querySelectorAll("#import-progress .setup-dictionary")].map((row) => ({
      name: row.querySelector(".setup-dictionary-name")?.textContent ?? "",
      text: row.querySelector(".setup-dictionary-status")?.textContent ?? "",
    })),
  }));
}

async function settle() {
  await page.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status", requestId: "repro-settle" });
    return status?.ready === true && status.loading !== true;
  }, { timeout: 60_000, polling: 250 });
}

if (MODE !== "fresh") await settle();
if (MODE === "backup") {
  // One import gives the profile its first automatic backup; age that backup
  // by a day and let the real alarm fire part-way through the batch.
  const seeded = await runBatch([seed]);
  console.log(`seed: ${seeded.state}`);
  await page.waitForFunction(async () => (await chrome.storage.local.get("automaticBackups")).automaticBackups?.backups?.length === 1,
    { timeout: 30_000, polling: 100 });
  await settle();
  await page.evaluate(async (dueMs) => {
    const { automaticBackups } = await chrome.storage.local.get("automaticBackups");
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    automaticBackups.backups = automaticBackups.backups.map((record) => ({ ...record, createdAt: aged }));
    await chrome.storage.local.set({ automaticBackups });
    await chrome.alarms.create("hachidori-automatic-backup", { when: Date.now() + dueMs });
  }, BACKUP_DUE_MS);
}

const started = Date.now();
const result = await runBatch(paths);
const stored = await page.evaluate(() => chrome.storage.local.get(["dictionaryState", "automaticBackups"]));
const relayLog = await sw.evaluate(() => globalThis.__relayLog.filter((entry) => entry.type !== "hd_status" && entry.type !== "hd_memory"));
console.log(`final state after ${((Date.now() - started) / 1000).toFixed(1)} s: ${result.state}`);
const failures = result.rows.filter((row) => !row.text.startsWith("Imported"));
console.log(`failures: ${failures.length}`);
for (const row of failures) console.log(`  ${row.name}: ${row.text}`);
const titles = stored.dictionaryState?.dictionaries?.map((dictionary) => dictionary.title) ?? [];
console.log(`stored dictionaries: ${titles.length} (unique ${new Set(titles).size}); automatic backups: ${stored.automaticBackups?.backups?.length}`);
writeFileSync(resolve(HERE, `relay-log-${MODE}.json`), JSON.stringify(relayLog, null, 1));
writeFileSync(resolve(HERE, `diagnostics-${MODE}.log`), diagnostics.join("\n"));
const mutations = relayLog.filter((entry) => !["hd_lookup", "hd_styles", "hd_state_read"].includes(entry.type));
const busy = mutations.filter((entry) => /busy mutating/u.test(entry.error ?? ""));
console.log(`relayed non-poll requests: ${mutations.length}; refused busy: ${busy.length}`);
for (const entry of busy) {
  const overlapping = mutations.filter((other) => other !== entry && other.start <= entry.start && (other.end ?? Infinity) >= entry.start);
  console.log(`  busy ${entry.type} ${entry.requestId} at ${entry.start} ms; holding the lock: ${overlapping.map((o) => `${o.type} ${o.requestId} [${o.start}-${o.end} ms]`).join(", ")}`);
}
await browser.close();
rmSync(PROFILE, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
