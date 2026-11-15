// Opening the search page (#610) as Yomitan's backend opens its own
// (yomidevs/yomitan@d3c54c1 ext/js/background/backend.js,
// _onCommandOpenSearchPage, _onCommandOpenSearchPageCurrentTab and
// _getOrCreateSearchPopup): a search page that is already open comes to the
// front instead of a second one opening. The browser shortcuts and the
// toolbar menu's Search button share it.
// SPDX-License-Identifier: GPL-3.0-or-later
import "./reader-options.js";

export const SEARCH_PAGE = "search.html";
// The search page's own document, the frame search.html holds (#644).
export const SEARCH_FRAME = "search-frame.html";

// Yomitan's popup window is 400 × 250 by default (popupWindow in
// ext/data/schemas/options-schema.json). Reading → Search page sets its size
// (#656), 600 × 640 by default, which has room for the search box and a popup
// of Design's default size.
async function searchWindow(api) {
  const { options } = await api.storage.local.get("options");
  const { searchWindowWidthPx: width, searchWindowHeightPx: height } = globalThis.HDReaderOptions.normaliseOptions(options);
  return { type: "popup", width, height };
}

// The page brought forward focuses its box and selects the box's text, so the
// next keystroke replaces the last query (#768): search-shell.js hands the
// message to its frame as an Escape. A page still starting has no listener
// yet, and focuses its empty box itself as it starts.
export const FOCUS_SEARCH_BOX = "hachidori-search-focus";

async function bringForward(api, { tabId, windowId }) {
  await api.tabs.update(tabId, { active: true });
  await api.windows.update(windowId, { focused: true });
  await api.runtime.sendMessage({ target: FOCUS_SEARCH_BOX, tabId }).catch(() => {});
}

// `mode` is Yomitan's: "existingOrNewTab" (Open the search page in a new tab),
// "existingOrCurrentTab" (in the current tab, `tab`) or "popup" (Open the
// popup window). Only a search page in a popup window answers "popup", and
// any search page answers the other two, as Yomitan's predicates do.
export async function openSearchPage(api, mode, tab = null) {
  const url = api.runtime.getURL(SEARCH_PAGE);
  // Tabs hide extension-page URLs, so the open search pages are found as the
  // extension's own documents.
  const pages = await api.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  if (mode === "popup") {
    for (const page of pages) {
      if ((await api.windows.get(page.windowId)).type === "popup") return bringForward(api, page);
    }
    return api.windows.create({ url, ...await searchWindow(api) });
  }
  if (pages.length > 0) return bringForward(api, pages[0]);
  if (mode === "existingOrCurrentTab" && Number.isInteger(tab?.id)) return api.tabs.update(tab.id, { url });
  return api.tabs.create({ url });
}
