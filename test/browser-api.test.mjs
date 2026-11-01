// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedBackgroundUrl,
  extensionDocumentUrl,
  isExactExtensionSender,
  isFirefox,
  selectExtensionApi,
} from "../extension/browser-api.js";

const api = (scheme = "chrome-extension:", id = "test-id", background = { service_worker: "background.js", type: "module" }) => ({
  runtime: {
    id,
    getURL(path) {
      return `${scheme}//extension/${path}`;
    },
    getManifest: () => ({ background }),
  },
});

test("module contexts use the Chrome extension API", () => {
  const chrome = api();
  assert.equal(selectExtensionApi({ chrome }), chrome);
  assert.equal(selectExtensionApi({}), null);
});

test("exact extension senders derive from runtime URLs", () => {
  const chrome = api();
  assert.equal(extensionDocumentUrl("offscreen.html", chrome), "chrome-extension://extension/offscreen.html");
  assert.equal(isExactExtensionSender({
    id: "test-id",
    url: "chrome-extension://extension/offscreen.html",
  }, "offscreen.html", chrome, { tab: false }), true);
  assert.equal(isExactExtensionSender({
    id: "test-id",
    url: "chrome-extension://extension/offscreen.html",
    tab: { id: 3 },
  }, "offscreen.html", chrome, { tab: false }), false);
  assert.equal(isExactExtensionSender({
    id: "other",
    url: "chrome-extension://extension/offscreen.html",
  }, "offscreen.html", chrome), false);
});

test("the background sender is Chrome's service worker or Firefox's background page", () => {
  assert.equal(expectedBackgroundUrl(api()), "chrome-extension://extension/background.js");
  // Firefox's runtime.getManifest() gives the page as an absolute URL and the worker as null.
  assert.equal(expectedBackgroundUrl(api("moz-extension:", "test-id",
    { page: "moz-extension://extension/background.html", service_worker: null })),
  "moz-extension://extension/background.html");
  // A host without a manifest reader still names the worker's script.
  assert.equal(expectedBackgroundUrl({ runtime: { getURL: path => `chrome-extension://host/${path}` } }),
    "chrome-extension://host/background.js");
});

test("Firefox is the browser that serves extension pages from moz-extension URLs", () => {
  assert.equal(isFirefox(api("moz-extension:")), true);
  assert.equal(isFirefox(api()), false);
  assert.equal(isFirefox({ runtime: {} }), false);
  assert.equal(isFirefox(null), false);
});
