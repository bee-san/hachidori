/*
 * The debug log: errors from before Get debug info was pressed, a reload and
 * a browser crash are in the report, with the actions before them, redacted,
 * and the ring stays within its limits.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./file-access.mjs";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { check, diagnostics, PROFILE, step } from "./harness.mjs";
import { browser, launch, launchArgs, setBrowser, setPage, settingsUrl, showSettingsSection, watch } from "./session.mjs";

const NOT_A_DICTIONARY = "debug-log-not-a-dictionary.zip";
const CRASH_MARKER = "hd_e2e_debug_log_before_crash";
// What the redaction probe passes to console.warn that must not be kept.
const SECRETS = ["hunter2-e2e", "reader:pw", "e2e-bearer-token", "term=", "猫", "食べたかった"];

// Opened after file-access.mjs, which reloads the extension and closes its pages.
async function openSettings(section) {
  const settings = await browser.newPage();
  settings.on("console", message => diagnostics.push(`[debug-log] ${message.type()}: ${message.text()}`));
  await settings.goto(`${settingsUrl}#${section}`, { waitUntil: "domcontentloaded" });
  await settings.bringToFront();
  await settings.waitForFunction(() => document.getElementById("engine-status")?.textContent.startsWith("Ready"),
    { timeout: 120_000, polling: 100 });
  return settings;
}

// Settings → Advanced → Get debug info, as the reader downloads it.
async function downloadDebugInfo(settings, name) {
  const directory = resolve(PROFILE, "debug-info", name);
  mkdirSync(directory, { recursive: true });
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
  try {
    await showSettingsSection(settings, "advanced");
    await settings.click("#debug-info-download");
    await settings.waitForFunction(() => /downloaded|Could not/u.test(document.getElementById("debug-info-status").textContent),
      { timeout: 120_000, polling: 100 });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const file = readdirSync(directory).find(entry => entry.endsWith(".json"));
      if (file) {
        const text = readFileSync(resolve(directory, file), "utf8");
        return { text, report: JSON.parse(text) };
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    throw new Error(`Get debug info saved no file in ${directory}`);
  } finally {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    await cdp.detach();
  }
}

// The actions kept before `entry` in its own session.
const actionsBefore = (report, entry) => report.debugLog.entries
  .filter(item => item.session === entry.session && item.n < entry.n && item.level === "action")
  .map(item => item.message);

let importFailure = null;

describe("debug log", () => {
  step("a Settings button press that fails is in Get debug info after a reload", async () => {
    const settings = await openSettings("add-dictionaries");
    const archive = resolve(PROFILE, NOT_A_DICTIONARY);
    writeFileSync(archive, "not a zip archive");
    await (await settings.$("#import-file")).uploadFile(archive);
    await settings.waitForFunction(() => /Finished 1 of 1/u.test(document.getElementById("import-state").textContent),
      { timeout: 60_000, polling: 100 });

    // Copy error details on the status the reader sees, without a real clipboard.
    const copy = await settings.evaluate(async () => {
      let copied = null;
      Object.defineProperty(navigator, "clipboard", { configurable: true,
        value: { writeText: async (text) => { copied = text; } } });
      const status = document.getElementById("import-state");
      const button = status.nextElementSibling;
      const visible = button?.classList.contains("copy-error-details") && button.checkVisibility();
      button?.focus();
      button?.click();
      for (let attempt = 0; attempt < 50 && button?.textContent !== "Copied"; attempt += 1) {
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      return { visible, label: button?.textContent, describedBy: button?.getAttribute("aria-describedby"),
        focused: document.activeElement === button, status: status.textContent, copied };
    });
    check("Copy error details copies the shown error with the failures and actions before it",
      copy.visible && copy.describedBy === "import-state" && copy.focused && copy.label === "Copied"
        && /^Hachidori \d+\.\d+\.\d+ · settings · session \w+\n.+ · import-state\nFinished 1 of 1 archive — 0 imported, 1 failed\./u.test(copy.copied)
        && copy.copied.includes(`user-error: Failed before import: ${NOT_A_DICTIONARY}: reading dictionary metadata failed.`)
        && /\n {2}\S+ open settings\.html#add-dictionaries\n/u.test(copy.copied)
        && /\n {2}\S+ change #import-file \(1 files\)\n/u.test(copy.copied)
        && /\nBrowser: Mozilla\/5\.0 .+Chrome\//u.test(copy.copied),
      JSON.stringify(copy));

    await settings.reload({ waitUntil: "domcontentloaded" });
    await settings.waitForFunction(() => document.getElementById("engine-status")?.textContent.startsWith("Ready"),
      { timeout: 120_000, polling: 100 });
    const { report } = await downloadDebugInfo(settings, "after-reload");
    importFailure = report.debugLog.entries.find(entry => entry.level === "user-error" && entry.where === "import-progress"
      && entry.message.includes(NOT_A_DICTIONARY)) ?? null;
    const sessions = Object.fromEntries(report.debugLog.sessions.map(session => [session.session, session]));
    const current = report.debugLog.contexts.find(context => context.probe === "settings");
    check("a Settings button press that fails is in Get debug info after Settings reloads, with the actions before it",
      report.schemaVersion === 2
        && importFailure !== null
        && importFailure.message.includes("reading dictionary metadata failed")
        && /dictionary-import-errors\.js:\d+:\d+/u.test(importFailure.stack ?? "")
        && importFailure.version === report.extension.version
        && sessions[importFailure.session]?.live === false
        && sessions[current?.session]?.live === true && current.session !== importFailure.session
        && JSON.stringify(actionsBefore(report, importFailure))
          === JSON.stringify(["open settings.html#add-dictionaries", "change #import-file (1 files)"]),
      JSON.stringify({ importFailure, current, sessions: report.debugLog.sessions }));
    await settings.close();
  });

  step("the debug log redacts what it keeps", async () => {
    const settings = await openSettings("advanced");
    const raw = await settings.evaluate(async () => {
      console.warn("debug-log redaction probe", { anki: { apiKey: "hunter2-e2e" } },
        "GET https://reader:pw@audio.example/clip?term=猫#x", "Authorization: Bearer e2e-bearer-token", "食べたかった");
      await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_debug_log" });
      const { openDebugLogStore } = await import(chrome.runtime.getURL("debug-log.js"));
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const { records } = await openDebugLogStore(indexedDB).read();
        const probe = records.find(record => record.message.startsWith("debug-log redaction probe"));
        if (probe) return probe;
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
      return null;
    });
    const { report } = await downloadDebugInfo(settings, "redaction");
    const kept = JSON.stringify(raw);
    const reported = JSON.stringify(report.debugLog);
    check("the debug log keeps credentials, sign-ins, address queries and Japanese text out of IndexedDB and the report",
      raw !== null && SECRETS.every(secret => !kept.includes(secret) && !reported.includes(secret))
        && raw.message === 'debug-log redaction probe {"anki":{"apiKey":"[redacted]"}}'
          + " GET https://[redacted]@audio.example/clip?[redacted]#[redacted] Authorization: Bearer [redacted] [ja]"
        && reported.includes("debug-log redaction probe"),
      kept);
    await settings.close();
  });

  step("the debug log ring stays within its limits", async () => {
    const settings = await openSettings("advanced");
    const ring = await settings.evaluate(async () => {
      const { DEBUG_LOG_MAX_BYTES, DEBUG_LOG_MAX_ENTRIES, openDebugLogStore } = await import(chrome.runtime.getURL("debug-log.js"));
      const name = "hachidori-debug-log-limit-check";
      const record = (index, padding = "") => {
        const value = { at: new Date(index).toISOString(), session: "limit", n: index, context: "settings", version: null,
          level: "warn", message: `entry ${index}${padding}`, bytes: 0 };
        value.bytes = new TextEncoder().encode(JSON.stringify(value)).length;
        return value;
      };
      const store = openDebugLogStore(indexedDB, { name });
      for (let batch = 0; batch < 26; batch += 1) {
        await store.write(Array.from({ length: 200 }, (_, offset) => ({ record: record(batch * 200 + offset) })));
      }
      const counted = await store.read();
      const padding = "x".repeat(3900);
      for (let batch = 0; batch < 6; batch += 1) {
        await store.write(Array.from({ length: 100 }, (_, offset) => ({ record: record(10_000 + batch * 100 + offset, padding) })));
      }
      const sized = await store.read();
      await new Promise((resolveDelete, rejectDelete) => {
        const deleting = indexedDB.deleteDatabase(name);
        deleting.onsuccess = resolveDelete;
        deleting.onerror = () => rejectDelete(deleting.error);
      });
      const real = await openDebugLogStore(indexedDB).read();
      const sum = records => records.reduce((total, entry) => total + entry.bytes, 0);
      return {
        limits: [DEBUG_LOG_MAX_ENTRIES, DEBUG_LOG_MAX_BYTES],
        counted: { records: counted.records.length, totals: counted.totals, first: counted.records[0].message,
          last: counted.records.at(-1).message },
        sized: { records: sized.records.length, totals: sized.totals, sum: sum(sized.records), last: sized.records.at(-1).message.slice(0, 11) },
        real: { records: real.records.length, totals: real.totals, sum: sum(real.records) },
      };
    });
    check("the debug log ring keeps its newest entries within 5,000 entries and 2 MiB",
      ring.limits[0] === 5000 && ring.limits[1] === 2 * 1024 * 1024
        && ring.counted.records === 5000 && ring.counted.totals.count === 5000
        && ring.counted.first === "entry 200" && ring.counted.last === "entry 5199"
        && ring.sized.totals.bytes <= 2 * 1024 * 1024 && ring.sized.totals.bytes > 2 * 1024 * 1024 - 8192
        && ring.sized.totals.bytes === ring.sized.sum && ring.sized.records === ring.sized.totals.count
        && ring.sized.last === "entry 10599"
        && ring.real.records === ring.real.totals.count && ring.real.totals.bytes === ring.real.sum
        && ring.real.records > 0 && ring.real.records <= 5000,
      JSON.stringify(ring));
    await settings.close();
  });

  step("errors from before a browser crash are in the next session's report", async () => {
    const settings = await openSettings("advanced");
    // A failed reply the service worker records, written to the ring before the crash.
    await settings.evaluate(async (type) => {
      await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type });
      await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_debug_log" });
    }, CRASH_MARKER);
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
    const chromeProcess = browser.process();
    const chromeKilled = new Promise((resolveKilled) => chromeProcess.once("close", resolveKilled));
    chromeProcess.kill("SIGKILL");
    await chromeKilled;
    setBrowser(await launch.launch(launchArgs));
    watch(browser);
    await browser.waitForTarget(target => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
      { timeout: 30_000 }).catch(() => {});
    setPage(await browser.newPage());
    const restarted = await openSettings("advanced");
    const { report } = await downloadDebugInfo(restarted, "after-crash");
    const marker = report.debugLog.entries.find(entry => entry.level === "failed-request" && entry.message.includes(CRASH_MARKER));
    const live = new Set(report.debugLog.contexts.map(context => context.session));
    const kept = report.debugLog.entries.find(entry => importFailure && entry.session === importFailure.session && entry.n === importFailure.n);
    check("errors from before a browser crash are in the next session's Get debug info",
      marker?.context === "service-worker" && !live.has(marker.session)
        && report.debugLog.sessions.some(session => session.session === marker.session && session.live === false)
        && kept?.message === importFailure?.message,
      JSON.stringify({ marker, kept, stored: report.debugLog.stored, contexts: report.debugLog.contexts }));
    await restarted.close();
    rmSync(resolve(PROFILE, "debug-info"), { recursive: true, force: true });
  });
});
