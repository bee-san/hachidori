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
  browser, characterPoint, clickInPopup, dismissPopup, downloadedFiles, downloadsDirectory, evaluateJson, GECKO_ID, hoverForPopup, inPopup, openPage,
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

  step("User scripts and debug info", async () => {
    await activate(page);
    await showSettingsSection(page, "user-scripts");
    await page.evaluate(() => document.getElementById("custom-javascript-allow").scrollIntoView({ block: "center" }));
    const before = await page.evaluate(() => ({ allowHidden: document.getElementById("custom-javascript-allow-row").hidden,
      text: document.getElementById("custom-javascript-permission").textContent }));
    // The script is saved before Firefox grants user scripts, so it runs only
    // once background.js applies it on the grant. It also marks the popup with
    // the mode of the root its host.shadowRoot returns. It is typed into the
    // code editor in place of the example a new script starts from.
    await page.evaluate(() => {
      document.getElementById("user-script-add").click();
      document.getElementById("user-script-name").value = "Firefox check";
    });
    const javascript = '.user-script-part .cm-editor[data-language="javascript"] .cm-content';
    await waitFor(() => page.evaluate(selector => document.querySelector(selector) !== null || false, javascript));
    await page.click(javascript);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.type(["document.documentElement.dataset.hachidoriUserScript = 'ran';",
      "setInterval(() => {",
      "const root = document.querySelector('hachidori-host')?.shadowRoot;",
      "const popup = root?.querySelector('.gsm-hoshidicts-popup');",
      "if (popup) popup.dataset.customScript = root.mode;",
      "}, 50);"].join("\n"));
    // The code's colours, fitted to the palette (code-editor.js): the string
    // differs from the plain text and both keep 4.5:1 on the editor.
    const editor = await page.evaluate((selector) => {
      const content = document.querySelector(selector);
      const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      const luminance = (colour) => {
        canvas.clearRect(0, 0, 1, 1);
        canvas.fillStyle = colour;
        canvas.fillRect(0, 0, 1, 1);
        const channels = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3)
          .map(value => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4));
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const background = luminance(getComputedStyle(content.closest(".cm-editor")).backgroundColor);
      const contrast = colour => Math.round((Math.max(luminance(colour), background) + 0.05)
        / (Math.min(luminance(colour), background) + 0.05) * 100) / 100;
      const text = getComputedStyle(content).color;
      const string = [...content.querySelectorAll("span")].find(span => span.textContent === "'ran'");
      return { text, string: string && getComputedStyle(string).color, textContrast: contrast(text),
        stringContrast: string ? contrast(getComputedStyle(string).color) : 0 };
    }, javascript);
    await page.evaluate(() => document.getElementById("user-script-submit").click());
    await waitFor(async () => (await readStorage(page, ["options"])).options?.userScripts
      ?.some(script => script.javascript.includes("hachidoriUserScript")) || false);
    const early = await openPage(`${serverUrl}/?user-script-before`);
    await sleep(1_000);
    const ranBefore = await early.evaluate(() => document.documentElement.dataset.hachidoriUserScript ?? null);
    await early.close();
    await activate(page);
    // Firefox grants an optional permission only to a request made while it
    // handles the user's click, so the button is clicked with the real mouse.
    const point = await page.evaluate(() => {
      const rect = document.getElementById("custom-javascript-allow").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
    const granted = await waitFor(() => page.evaluate(async () => (await chrome.permissions.contains({ permissions: ["userScripts"] }))
      && document.getElementById("custom-javascript-allow-row").hidden || false), { timeout: 10_000 });
    // background.js registers the saved script when it sees the grant; a page
    // that loads before the registration runs without it, as in any browser.
    const registered = granted && await waitFor(() => page.evaluate(async () =>
      (await chrome.userScripts.getScripts({ ids: ["hachidori-custom-javascript"] })).length === 1 || false), { timeout: 10_000 });
    const reader = await openPage(`${serverUrl}/?user-script`);
    const ran = await waitFor(() => reader.evaluate(() => document.documentElement.dataset.hachidoriUserScript === "ran" || false),
      { timeout: 10_000 });
    check("Firefox edits a user script in the code editor, its code coloured and readable",
      editor.string !== undefined && editor.string !== editor.text && editor.textContrast >= 4.5 && editor.stringContrast >= 4.5,
      JSON.stringify(editor));
    check("A user script's JavaScript runs on pages once Firefox grants user scripts",
      before.allowHidden === false && before.text.startsWith("Firefox asks") && ranBefore === null && granted === true && ran === true,
      JSON.stringify({ before, ranBefore, granted, registered, ran }));
    // The saved script reaches the popup through host.shadowRoot, while the
    // page, and so Dark Reader, still sees no root (#645).
    const shown = await hoverForPopup(reader, "#verb");
    const reached = shown && await waitFor(() => inPopup(reader, `root => ({ mode: root.mode,
      exposed: root.host.shadowRoot !== null,
      marker: root.querySelector(".gsm-hoshidicts-popup")?.dataset.customScript ?? null })`)
      .then(state => (state?.marker ? state : null)), { timeout: 10_000 });
    check("A user script reaches the popup through host.shadowRoot while the page sees no root",
      reached?.marker === "closed" && reached.mode === "closed" && reached.exposed === false,
      JSON.stringify({ shown: Boolean(shown), reached }));
    await reader.evaluate(src => {
      const frame = document.createElement("iframe");
      frame.id = "script-frame";
      frame.src = src;
      frame.style.cssText = "width: 760px; height: 420px; border: 0";
      document.body.prepend(frame);
    }, `${serverUrl}/frame`);
    const frame = await (await reader.$("#script-frame")).contentFrame();
    await frame.waitForSelector("#frame-verb");
    const frameRan = await waitFor(() => frame.evaluate(() => document.documentElement.dataset.hachidoriUserScript === "ran"));
    const offset = await reader.evaluate(() => {
      const rect = document.getElementById("script-frame").getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    });
    const framePoint = await characterPoint(frame, "#frame-verb", 0);
    let frameShown = null;
    await reader.keyboard.down("Shift");
    try {
      for (let attempt = 0; attempt < 30 && frameShown === null; attempt += 1) {
        await reader.mouse.move(offset.x + framePoint.x + (attempt % 2), offset.y + framePoint.y);
        await sleep(150);
        frameShown = await readPopup(frame);
      }
    } finally {
      await reader.keyboard.up("Shift");
    }
    const frameReached = frameShown && await waitFor(() => inPopup(frame, `root => ({ mode: root.mode,
      exposed: root.host.shadowRoot !== null,
      marker: root.querySelector(".gsm-hoshidicts-popup")?.dataset.customScript ?? null })`)
      .then(state => state?.marker ? state : null));
    check("A user script runs in a chat frame and reaches its closed popup while the page sees no root",
      frameRan === true && frameReached?.marker === "closed" && frameReached.mode === "closed" && frameReached.exposed === false,
      JSON.stringify({ frameRan, shown: Boolean(frameShown), reached: frameReached }));
    await reader.close();
    await writeOptions(page, { userScripts: [] });
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
        && report.extension?.manifest?.browser_specific_settings?.gecko?.id === GECKO_ID,
      JSON.stringify({ file, userAgent: report?.browser?.userAgent, status: report?.engine?.status, error: report?.error }));
  });
});
