// SPDX-License-Identifier: GPL-3.0-or-later
// Issue #610: the search page opens as Yomitan's does, bringing an open one
// forward instead of opening a second.
import assert from "node:assert/strict";
import test from "node:test";
import { openSearchPage, SEARCH_PAGE } from "../extension/search-window.js";

const PAGE_URL = "chrome-extension://hachidori/search.html";

function browser({ pages = [], windowTypes = {}, options } = {}) {
  const calls = [];
  const api = {
    runtime: {
      getURL: path => `chrome-extension://hachidori/${path}`,
      async getContexts(filter) { calls.push(["getContexts", filter]); return pages; },
    },
    storage: { local: { async get(keys) { calls.push(["storage.get", keys]); return options === undefined ? {} : { options }; } } },
    tabs: {
      async create(properties) { calls.push(["tabs.create", properties]); },
      async update(tabId, properties) { calls.push(["tabs.update", tabId, properties]); },
    },
    windows: {
      async get(windowId) { return { id: windowId, type: windowTypes[windowId] ?? "normal" }; },
      async create(properties) { calls.push(["windows.create", properties]); },
      async update(windowId, properties) { calls.push(["windows.update", windowId, properties]); },
    },
  };
  return { api, calls };
}

const lookedUp = ["getContexts", { contextTypes: ["TAB"], documentUrls: [PAGE_URL] }];

test("a new-tab or current-tab search opens one search page and brings an open one forward", async () => {
  assert.equal(SEARCH_PAGE, "search.html");
  const fresh = browser();
  await openSearchPage(fresh.api, "existingOrNewTab", { id: 3 });
  assert.deepEqual(fresh.calls, [lookedUp, ["tabs.create", { url: PAGE_URL }]]);

  const here = browser();
  await openSearchPage(here.api, "existingOrCurrentTab", { id: 3 });
  assert.deepEqual(here.calls, [lookedUp, ["tabs.update", 3, { url: PAGE_URL }]]);

  const noTab = browser();
  await openSearchPage(noTab.api, "existingOrCurrentTab");
  assert.deepEqual(noTab.calls, [lookedUp, ["tabs.create", { url: PAGE_URL }]], "a shortcut with no tab opens a new one");

  // Any open search page answers, the popup window's included, as Yomitan's
  // PAGE_URL predicate matches it.
  for (const mode of ["existingOrNewTab", "existingOrCurrentTab"]) {
    const open = browser({ pages: [{ tabId: 7, windowId: 2 }], windowTypes: { 2: "popup" } });
    await openSearchPage(open.api, mode, { id: 3 });
    assert.deepEqual(open.calls, [lookedUp, ["tabs.update", 7, { active: true }], ["windows.update", 2, { focused: true }]],
      mode);
  }
});

test("the popup window shortcut reuses only a search page in a popup window", async () => {
  const tabOnly = browser({ pages: [{ tabId: 7, windowId: 2 }] });
  await openSearchPage(tabOnly.api, "popup");
  // Reading → Search page's popup window size (#656), 600 × 640 until set.
  assert.deepEqual(tabOnly.calls, [lookedUp, ["storage.get", "options"],
    ["windows.create", { url: PAGE_URL, type: "popup", width: 600, height: 640 }]]);

  const popup = browser({ pages: [{ tabId: 7, windowId: 2 }, { tabId: 8, windowId: 5 }], windowTypes: { 5: "popup" } });
  await openSearchPage(popup.api, "popup");
  assert.deepEqual(popup.calls, [lookedUp, ["tabs.update", 8, { active: true }], ["windows.update", 5, { focused: true }]]);
});

test("the popup window opens at the size Reading → Search page sets", async () => {
  const sized = browser({ options: { revision: 4, searchWindowWidthPx: 900, searchWindowHeightPx: 300 } });
  await openSearchPage(sized.api, "popup");
  assert.deepEqual(sized.calls.at(-1), ["windows.create", { url: PAGE_URL, type: "popup", width: 900, height: 300 }]);

  // Stored values outside the setting's range open the nearest size it allows.
  const clamped = browser({ options: { searchWindowWidthPx: 20, searchWindowHeightPx: 2147483647 } });
  await openSearchPage(clamped.api, "popup");
  assert.deepEqual(clamped.calls.at(-1), ["windows.create", { url: PAGE_URL, type: "popup", width: 200, height: 16384 }]);

  // Only a new popup window reads the size.
  const tab = browser({ options: { searchWindowWidthPx: 900 } });
  await openSearchPage(tab.api, "existingOrNewTab");
  assert.ok(tab.calls.every(([call]) => call !== "storage.get"));
});
