/*
 * The search page (#610) in Firefox: the popup window that the Open the popup
 * window shortcut and the toolbar menu's Search open through search-window.js,
 * and a typed word's lookup docked under the search box.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./settings.mjs";
import { describe } from "node:test";
import { check, step } from "./harness.mjs";
import { activate, evaluateJson, extensionUrl, findPage, page, readPopup, waitFor } from "./session.mjs";

// The open search pages, from the extension's own documents as search-window.js finds them.
const searchPages = () => evaluateJson(page, async url => JSON.stringify(await Promise.all((await chrome.runtime.getContexts({
  contextTypes: ["TAB"], documentUrls: [url] })).map(async ({ tabId, windowId }) => ({ tabId, windowId,
  type: (await chrome.windows.get(windowId)).type })))), extensionUrl("search.html"));

// search-window.js's openSearchPage, which the browser shortcuts and the toolbar menu call.
const openSearchPage = mode => evaluateJson(page, async requested => {
  const { openSearchPage: open } = await import(chrome.runtime.getURL("search-window.js"));
  const opened = await open(chrome, requested);
  return JSON.stringify({ type: opened?.type ?? null });
}, mode);

describe("search page", () => {
  step("the search page in a popup window", async () => {
    await activate(page);
    const opened = await openSearchPage("popup");
    const first = await waitFor(async () => {
      const pages = await searchPages();
      return pages.some(entry => entry.type === "popup") ? pages : false;
    }, { timeout: 15_000 });
    // A second request brings the open search page forward instead of opening another.
    await openSearchPage("popup");
    const second = await searchPages();
    check("the popup window opens one search page and brings it forward instead of opening another",
      opened?.type === "popup" && first?.length === 1 && JSON.stringify(second) === JSON.stringify(first),
      JSON.stringify({ opened, first, second }));

    const search = await findPage("search.html");
    const ready = await waitFor(() => search.evaluate(() => !document.getElementById("search-submit").disabled || false),
      { timeout: 30_000 });
    await search.evaluate(() => {
      document.getElementById("search-input").value = "食べたかった";
      document.getElementById("search-form").requestSubmit();
    });
    const shown = await waitFor(async () => {
      const popup = await readPopup(search);
      return popup?.headword ? popup : false;
    }, { timeout: 20_000 });
    const docked = await search.evaluate(() => document.getElementById("search-results")
      .contains(document.querySelector("hachidori-host")));
    check("the search page looks up a typed word and docks the reader's popup under its box",
      ready === true && shown?.headword === "食べる" && shown.plain.includes("to eat") && docked === true,
      JSON.stringify({ ready, headword: shown?.headword, docked, plain: shown?.plain?.slice(0, 120) }));
    await evaluateJson(page, async windowId => {
      await chrome.windows.remove(windowId);
      return "null";
    }, first?.[0]?.windowId);
    await activate(page);
  });
});
