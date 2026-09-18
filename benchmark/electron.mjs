// Standalone Electron benchmark: start the host, import archives through the
// real settings page, time lookups, then relaunch on the same profile and time
// restart-to-ready. Requires an Electron binary (HDW_ELECTRON), xvfb-run, and
// puppeteer-core (HDW_PUPPETEER, the path to puppeteer-core.js).
//
//   HDW_ELECTRON=/path/to/electron node benchmark/electron.mjs extension a.zip b.zip
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ELECTRON = process.env.HDW_ELECTRON;
if (!ELECTRON) throw new Error("set HDW_ELECTRON to the Electron binary");
const PUPPETEER = process.env.HDW_PUPPETEER
  || resolve(homedir(), ".cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const puppeteer = (await import(PUPPETEER)).default;
const [EXT, ...ARCHIVES] = process.argv.slice(2);
const PROFILE = process.env.HDW_PROFILE || mkdtempSync(resolve(tmpdir(), "hdw-electron-"));
const RESTARTS = Number(process.env.HDW_RESTARTS || 2);
const WORDS = (process.env.HDW_WORDS || "食べる,東京,日本語,猫,🫠🫨🪼").split(",");
let port = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function launch() {
  const env = { ...process.env, HDW_EXT: resolve(EXT), HDW_PROFILE: PROFILE, HDW_CDP_PORT: String(port++) };
  const proc = spawn("xvfb-run", ["-a", ELECTRON, "--no-sandbox", resolve(HERE, "electron-host")],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const ws = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("Electron did not expose DevTools in time")), 30000);
    const on = (data) => { const m = data.toString().match(/ws:\/\/\S+/); if (m) { clearTimeout(timer); res(m[0]); } };
    proc.stdout.on("data", on); proc.stderr.on("data", on);
  });
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const target = await browser.waitForTarget((t) => t.url().includes("settings.html"), { timeout: 30000 });
  return { proc, browser, page: await target.page() };
}

async function shutdown({ browser, proc }) {
  await browser.disconnect();
  const exited = new Promise((r) => proc.on("exit", r));
  writeFileSync(resolve(PROFILE, "hdw-quit"), "");
  await Promise.race([exited, sleep(15000)]);
  try { process.kill(-proc.pid, "SIGKILL"); } catch {}
  await sleep(500);
}

const send = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);
const status = (page) => send(page, { target: "hoshidicts-offscreen", type: "hd_status", requestId: `st-${Math.random()}` });
async function waitReady(page) {
  let s = null;
  for (let i = 0; i < 600; i++) { s = await status(page).catch(() => null); if (s?.ready && !s.loading) return s; await sleep(100); }
  throw new Error(`engine not ready: ${JSON.stringify(s)}`);
}
// Timed inside the page so the CDP round trip stays out of the number.
const lookup = (page, text, requestId) => page.evaluate(async ({ text, requestId }) => {
  const started = performance.now();
  const reply = await chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen", type: "hd_lookup", requestId, text, maxResults: 32, scanLength: 32,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
  });
  return { ms: performance.now() - started, results: (reply.results ?? []).length };
}, { text, requestId });

let t0 = performance.now();
const first = await launch();
let s = await waitReady(first.page);
console.log(`start->ready ${(performance.now() - t0).toFixed(0)} ms; threaded=${s.threaded} backend=${s.storageBackend} dictionaries=${s.dictionaryCount}`);
await first.page.click('#library-navigation a[href="#add-dictionaries"]').catch(() => {});
await first.page.waitForFunction(() => { const i = document.getElementById("import-file"); return i && !i.disabled; }, { timeout: 20000 });
for (const archive of ARCHIVES) {
  await first.page.evaluate(() => { const e = document.getElementById("import-state"); if (e) e.textContent = ""; });
  const t = performance.now();
  await (await first.page.$("#import-file")).uploadFile(archive);
  await first.page.waitForFunction(() => /Finished/.test(document.getElementById("import-state")?.textContent || ""), { timeout: 300000 });
  console.log(`import ${archive.split("/").pop()} ${(performance.now() - t).toFixed(0)} ms`);
  await waitReady(first.page);
}
const rows = [];
for (let i = 0; i < 12 * WORDS.length; i++) {
  const text = WORDS[i % WORDS.length];
  const reply = await lookup(first.page, text, `lk-${i}`);
  if (i >= 2 * WORDS.length) rows.push({ text, ...reply });
}
for (const w of WORDS) {
  const rs = rows.filter((r) => r.text === w);
  console.log(`lookup ${w.padEnd(8)} ${median(rs.map((r) => r.ms)).toFixed(2)} ms  results ${median(rs.map((r) => r.results))}`);
}
await shutdown(first);
const restarts = [];
for (let i = 0; i < RESTARTS; i++) {
  const t = performance.now();
  const host = await launch();
  s = await waitReady(host.page);
  restarts.push(performance.now() - t);
  if (i === 0) {
    const reply = await lookup(host.page, WORDS[0], "post-restart");
    console.log(`after restart: dictionaries=${s.dictionaryCount} lookup(${WORDS[0]}) results=${reply.results}`);
  }
  await shutdown(host);
}
if (restarts.length) console.log(`restart->ready ${restarts.map((x) => x.toFixed(0)).join(" ")} ms`);
console.log(`profile ${PROFILE}`);
process.exit(0);
