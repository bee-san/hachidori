/*
 * The popup's Note form, and Settings: autosave, the Design preview,
 * keybinds, Firefox's shortcut manager, Custom JavaScript through Firefox's
 * optional userScripts permission, and Get debug info.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./reader.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { check, step } from "./harness.mjs";
import { tab } from "./reader.mjs";
import {
  browser, clickInPopup, dismissPopup, downloadedFiles, downloadsDirectory, evaluateJson, hoverForPopup, inPopup, openPage,
  page, readPopup, readStorage, reloadPage, serverUrl, showSettingsSection, sleep, tabUrls, waitFor, writeOptions,
  activate,
} from "./session.mjs";

const NOTE_DEFINITION = "to eat — a personal note from Firefox";

describe("notes", () => {
  step("the Note form", async () => {
    await hoverForPopup(tab, "#verb");
    await clickInPopup(tab, ".gsm-hoshidicts-note-button");
    const opened = await waitFor(() => inPopup(tab, `root => {
      const form = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"] .gsm-hoshidicts-note-form');
      return form && !form.hidden ? { term: form.elements.namedItem("term")?.value, reading: form.elements.namedItem("reading")?.value } : false;
    }`));
    await inPopup(tab, `(root, definition) => {
      const form = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"] .gsm-hoshidicts-note-form');
      const control = form.elements.namedItem("definition");
      control.value = definition;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit();
      return true;
    }`, NOTE_DEFINITION);
    const saved = await waitFor(async () => {
      const { customDictionarySource } = await readStorage(page, ["customDictionarySource"]);
      return customDictionarySource?.text?.includes(`食べる, たべる, ${NOTE_DEFINITION}`) ? customDictionarySource : false;
    }, { timeout: 60_000 });
    const refreshed = await waitFor(async () => {
      const shown = await readPopup(tab);
      return shown?.plain.includes(NOTE_DEFINITION) ? shown : false;
    }, { timeout: 30_000 });
    check("the Note form appends a personal entry and the popup shows it",
      opened?.term === "食べる" && opened.reading === "たべる" && saved !== null && refreshed !== null,
      JSON.stringify({ opened, saved, refreshed: refreshed?.plain }));
    await dismissPopup(tab);
  });
});

describe("settings", () => {
  step("autosave, Design and keybinds", async () => {
    // 食べたかった has three results until Maximum results says one.
    const moreThanOne = shown => /Show \d+ more/u.test(shown?.plain ?? "") || (shown?.entries ?? 0) > 1;
    const baseline = await hoverForPopup(tab, "#verb");
    await dismissPopup(tab);
    await activate(page);
    await showSettingsSection(page, "lookup");
    await page.evaluate(() => {
      const input = document.getElementById("opt-max-results");
      input.value = "1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const saved = await waitFor(() => page.evaluate(() => document.getElementById("options-status")?.textContent === "Saved." || false),
      { timeout: 10_000 });
    const stored = (await readStorage(page, ["options"])).options;
    await activate(tab);
    await hoverForPopup(tab, "#verb");
    await sleep(1000);
    const one = await readPopup(tab);
    check("Settings autosaves a Reading option and the reader follows it",
      moreThanOne(baseline) && saved === true && stored?.maxResults === 1 && one?.headword === "食べる" && !moreThanOne(one),
      JSON.stringify({ baseline: baseline?.entries, saved, maxResults: stored?.maxResults, entries: one?.entries, text: one?.plain }));
    await dismissPopup(tab);
    await writeOptions(page, { maxResults: 32 });

    await activate(page);
    await showSettingsSection(page, "design");
    // The preview is a same-origin frame of Settings.
    const preview = await waitFor(() => page.evaluate(() => {
      const popup = document.getElementById("design-preview")?.contentDocument?.getElementById("preview-host")
        ?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
      return popup?.textContent.includes("食べる") ? popup.textContent.slice(0, 120) : false;
    }), { timeout: 20_000 });
    check("the Design preview renders its sample popup", typeof preview === "string", JSON.stringify(preview));

    await showSettingsSection(page, "keybinds");
    const keybinds = await evaluateJson(page, () => JSON.stringify({
      rows: document.querySelectorAll("#keybind-list > *").length,
      defaults: HDReaderOptions.DEFAULT_OPTIONS.keybinds.length,
    }));
    check("Keybinds list Yomitan's default keybinds", keybinds.rows === keybinds.defaults && keybinds.defaults > 0,
      JSON.stringify(keybinds));

    const shortcuts = await waitFor(() => evaluateJson(page, async () => {
      const commands = await chrome.commands.getAll();
      const rows = document.querySelectorAll("#browser-shortcut-list li").length;
      return JSON.stringify(rows === commands.length ? {
        rows, commands: commands.length, declared: Object.keys(chrome.runtime.getManifest().commands).length,
        help: document.getElementById("browser-shortcuts-help").textContent,
        button: document.getElementById("browser-shortcuts-open").textContent,
      } : null);
    }), { timeout: 10_000 });
    const tabsBefore = await tabUrls();
    await page.evaluate(() => document.getElementById("browser-shortcuts-open").click());
    const opened = await waitFor(async () => {
      const urls = await tabUrls();
      return urls.find(url => url.startsWith("about:addons")) ?? false;
    }, { timeout: 10_000 });
    check("browser shortcuts list Firefox's commands and open Firefox's shortcut manager",
      shortcuts?.commands === shortcuts?.declared && shortcuts.help.startsWith("Firefox runs these") && shortcuts.button === "Change in Firefox"
        && !tabsBefore.some(url => url.startsWith("about:addons")) && opened !== null,
      JSON.stringify({ shortcuts, opened }));
    for (const candidate of await browser.pages()) {
      if ((await candidate.evaluate(() => location.href).catch(() => "")).startsWith("about:addons")) await candidate.close();
    }
  });

  step("Custom JavaScript and debug info", async () => {
    await activate(page);
    await showSettingsSection(page, "design");
    await page.evaluate(() => {
      for (let node = document.getElementById("custom-javascript"); node; node = node.parentElement) {
        if (node.tagName === "DETAILS") node.open = true;
      }
      document.getElementById("custom-javascript-allow").scrollIntoView({ block: "center" });
    });
    const before = await page.evaluate(() => ({ allowHidden: document.getElementById("custom-javascript-allow-row").hidden,
      text: document.getElementById("custom-javascript-permission").textContent }));
    // Firefox grants an optional permission only to a request made while it
    // handles the user's click, so the button is clicked with the real mouse.
    const point = await page.evaluate(() => {
      const rect = document.getElementById("custom-javascript-allow").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
    const granted = await waitFor(() => page.evaluate(async () => (await chrome.permissions.contains({ permissions: ["userScripts"] }))
      && document.getElementById("custom-javascript-allow-row").hidden || false), { timeout: 10_000 });
    await page.evaluate(() => {
      const editor = document.getElementById("opt-custom-popup-javascript");
      editor.value = "document.documentElement.dataset.hachidoriUserScript = 'ran';";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(async () => (await readStorage(page, ["options"])).options?.customPopupJavascript?.includes("hachidoriUserScript") || false);
    const reader = await openPage(`${serverUrl}/?user-script`);
    const ran = await waitFor(() => reader.evaluate(() => document.documentElement.dataset.hachidoriUserScript === "ran" || false),
      { timeout: 10_000 });
    check("Custom JavaScript runs on pages once Firefox grants user scripts",
      before.allowHidden === false && before.text.startsWith("Firefox asks") && granted === true && ran === true,
      JSON.stringify({ before, granted, ran }));
    await reader.close();
    await writeOptions(page, { customPopupJavascript: "" });
    await reloadPage(page);

    await activate(page);
    await showSettingsSection(page, "advanced");
    const existing = new Set(downloadedFiles());
    await page.evaluate(() => document.getElementById("debug-info-download").click());
    const file = await waitFor(async () => downloadedFiles().find(name => !existing.has(name) && name.endsWith(".json")) ?? false,
      { timeout: 30_000 });
    await sleep(500);
    let report = null;
    try {
      report = file ? JSON.parse(readFileSync(resolve(downloadsDirectory(), file), "utf8")) : null;
    } catch (error) {
      report = { error: String(error) };
    }
    check("Get debug info reports Firefox and its IndexedDB engine",
      /Firefox\/\d+/u.test(report?.browser?.userAgent ?? "") && report.engine?.status?.storageBackend === "idbfs"
        && report.extension?.manifest?.browser_specific_settings?.gecko?.id === "hachidori@bee-san",
      JSON.stringify({ file, userAgent: report?.browser?.userAgent, status: report?.engine?.status, error: report?.error }));
  });
});
