/*
 * Saved-page setup and a local HTML file.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./media.mjs";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { pathToFileURL } from "node:url";
import { buildRecommendedZip } from "../make-fixture.mjs";
import { startupUrl } from "./first-run.mjs";
import { check, PROFILE, step } from "./harness.mjs";
import { hoverForPopup, popupReader } from "./popup-reader.mjs";
import {
  browser,
  installMediaArchive,
  page,
  PAGE_HTML,
  RECOMMENDED_DICTIONARIES,
} from "./session.mjs";

// Run last: Chrome reloads the extension when its native file switch changes,
// closing every extension page and invalidating the suite's earlier handles.
async function checkStartupFileAccess(settings, browser, startupUrl) {
  const detailsUrl = `chrome://extensions/?id=${new URL(startupUrl).host}`;
  const settingsUrl = new URL("settings.html", startupUrl).href;
  await installMediaArchive(settings, buildRecommendedZip(RECOMMENDED_DICTIONARIES[0]));
  const resumeState = await settings.evaluate(async () => {
    const { setupState, options } = await chrome.storage.local.get(["setupState", "options"]);
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { hoverEnabled: true, lookupMode: "hover",
        anki: { ...globalThis.HDReaderOptions.normaliseOptions(options).anki, model: "" } } });
    if (!reply.ok) throw new Error(reply.error);
    const state = { ...setupState, revision: setupState.revision + 1, stage: "practice", completedAt: null };
    await chrome.storage.local.set({ setupState: state });
    return state;
  });
  let startup = await browser.newPage();
  await startup.goto(startupUrl, { waitUntil: "domcontentloaded" });
  const readPrompt = () => ({
    status: document.getElementById("local-file-status")?.textContent ?? "",
    open: document.getElementById("local-file-open")?.checkVisibility() === true,
    skip: document.getElementById("local-file-skip")?.checkVisibility() === true,
    instruction: document.getElementById("local-file-instruction")?.textContent ?? "",
    finish: document.getElementById("setup-finish")?.disabled === false,
    settings: document.querySelector('a[href="settings.html"]')?.checkVisibility() === true,
  });
  const fileAllowed = page => page.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
  const waitClosed = page => new Promise(resolveClosed => {
    const timer = setTimeout(() => { page.off("close", onClose); resolveClosed(false); }, 10_000);
    const onClose = () => { clearTimeout(timer); resolveClosed(true); };
    page.once("close", onClose);
  });
  const openSettings = async details => {
    await details.bringToFront();
    // The row is disabled briefly while Chrome reloads the extension.
    await details.waitForFunction(() => document.querySelector("extensions-manager")?.shadowRoot
      .querySelector("extensions-detail-view")?.shadowRoot.querySelector("#extensionsOptions")?.disabled === false);
    const [target] = await Promise.all([
      browser.waitForTarget(target => target.type() === "page" && target.url() === settingsUrl, { timeout: 10_000 }),
      details.$eval("pierce/#extensionsOptions", control => control.click()),
    ]);
    return target.page();
  };
  const resume = async details => {
    const page = await openSettings(details);
    await page.waitForSelector("#setup-resume", { visible: true });
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#setup-resume")]);
    await page.waitForSelector("#setup-finish");
    return page;
  };
  const toggleSelector = "pierce/#allow-on-file-urls";
  const toggle = async (details, enabled) => {
    await details.bringToFront();
    await details.waitForSelector(toggleSelector);
    const changes = await details.$eval(toggleSelector, (row, checked) => row.checked !== checked, enabled);
    if (!changes) return false;
    const closed = waitClosed(startup);
    await details.$eval(toggleSelector, row => row.shadowRoot.querySelector("#crToggle").click());
    if (!await closed) throw new Error("Chrome did not close setup during the native file-access reload.");
    startup = await resume(details);
    await startup.waitForFunction(async expected => await chrome.extension.isAllowedFileSchemeAccess() === expected,
      { timeout: 10_000 }, enabled);
    return true;
  };
  await startup.bringToFront();
  await startup.waitForFunction(() => document.getElementById("local-file-open")?.checkVisibility()
    || document.getElementById("local-file-status")?.textContent === "Local-file lookups enabled");
  const initial = await startup.evaluate(readPrompt);
  const initiallyAllowed = await fileAllowed(startup);
  // Unpacked extensions initially have file access. Use Chrome's real controls
  // to establish the disabled scenario, then test setup's own details shortcut.
  const preparation = await browser.newPage();
  try {
    await preparation.goto(detailsUrl, { waitUntil: "domcontentloaded" });
    // --load-extension initially bypasses Developer mode, but the native file
    // switch reloads it as unpacked. Match a normal Load unpacked installation.
    await preparation.waitForSelector("pierce/#devMode");
    await preparation.$eval("pierce/#devMode", control => { if (!control.checked) control.click(); });
    await toggle(preparation, false);
    await startup.bringToFront();
    await startup.waitForSelector("#local-file-open", { visible: true });
  } finally { await preparation.close(); }
  const before = await startup.evaluate(readPrompt);
  const disabledBefore = await fileAllowed(startup);
  const [detailsTarget] = await Promise.all([
    browser.waitForTarget(target => target.type() === "page" && target.url() === detailsUrl, { timeout: 10_000 }),
    startup.click("#local-file-open"),
  ]);
  const details = await detailsTarget.page();
  let local = null;
  let afterReturn, enabled, afterReload, localResult, skipped, completed;
  let enabledReload, disabledReload, statePreserved, finishedClosed;
  const localPath = resolve(PROFILE, "setup-saved-page.html");
  try {
    await details.waitForSelector(toggleSelector);
    await startup.bringToFront();
    await startup.waitForFunction(() => document.visibilityState === "visible");
    afterReturn = await startup.evaluate(readPrompt);
    enabledReload = await toggle(details, true);
    await startup.bringToFront();
    await startup.waitForFunction(() => document.getElementById("local-file-status")?.textContent === "Local-file lookups enabled");
    enabled = await startup.evaluate(readPrompt);
    statePreserved = await startup.evaluate(async expected =>
      JSON.stringify((await chrome.storage.local.get("setupState")).setupState) === JSON.stringify(expected), resumeState);
    await startup.reload({ waitUntil: "domcontentloaded" });
    await startup.waitForFunction(() => document.getElementById("local-file-status")?.textContent === "Local-file lookups enabled");
    afterReload = await startup.evaluate(readPrompt);
    writeFileSync(localPath, PAGE_HTML.replace("食べたかった", "辞書"));
    local = await browser.newPage();
    await local.goto(pathToFileURL(localPath).href, { waitUntil: "domcontentloaded" });
    const popup = await popupReader(local);
    localResult = await hoverForPopup(local, popup, "#verb");
    await local.close();
    local = null;
    disabledReload = await toggle(details, false);
    await startup.bringToFront();
    await startup.waitForSelector("#local-file-skip", { visible: true });
    await startup.focus("#local-file-skip");
    await startup.keyboard.press("Enter");
    skipped = await startup.evaluate(readPrompt);
    const closed = waitClosed(startup);
    await startup.click("#setup-finish");
    finishedClosed = await closed;
    const finishedSettings = await openSettings(details);
    await finishedSettings.waitForSelector("#setup-resume", { hidden: true });
    completed = await finishedSettings.evaluate(async () => ({
      state: (await chrome.storage.local.get("setupState")).setupState,
      allowed: await chrome.extension.isAllowedFileSchemeAccess(),
      resumeHidden: document.getElementById("setup-resume")?.hidden === true,
    }));
  } finally {
    if (local) await local.close();
    await details.close();
    rmSync(localPath, { force: true });
  }
  check("saved-page setup rechecks Chrome file access and a local HTML file uses the real reader",
    (initiallyAllowed ? initial.status === "Local-file lookups enabled" && !initial.open && !initial.skip : initial.open && initial.skip)
      && disabledBefore === false && before.open && before.skip && before.finish && before.settings
      && afterReturn.open && afterReturn.skip && !afterReturn.status.includes("enabled")
      && afterReturn.instruction.includes("Allow access to file URLs")
      && enabledReload && disabledReload && statePreserved
      && enabled.status === "Local-file lookups enabled" && !enabled.open && !enabled.skip
      && afterReload.status === "Local-file lookups enabled" && afterReload.finish && afterReload.settings
      && localResult?.plain.includes("辞書") && localResult.text.includes(`${RECOMMENDED_DICTIONARIES[0].title} term fixture`)
      && skipped.open === false && skipped.skip === false && skipped.finish && skipped.settings
      && finishedClosed && completed.allowed === false && completed.resumeHidden
      && completed.state.stage === "complete" && typeof completed.state.completedAt === "string",
    JSON.stringify({ initiallyAllowed, initial, disabledBefore, before, detailsUrl, afterReturn, enabledReload, disabledReload,
      statePreserved, enabled, afterReload, localResult, skipped, finishedClosed, completed }));
}

describe("saved pages", () => {
  step("saved-page setup", async () => {
    await checkStartupFileAccess(page, browser, startupUrl);
  });
});
