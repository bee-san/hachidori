// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import {
  extensionDocumentUrl,
  isExactExtensionSender,
  selectExtensionApi,
} from "../extension/browser-api.js";

const api = (scheme = "chrome-extension:", id = "test-id") => ({
  runtime: {
    id,
    getURL(path) {
      return `${scheme}//extension/${path}`;
    },
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
