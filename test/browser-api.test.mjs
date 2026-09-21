// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import {
  browserKind,
  extensionDocumentUrl,
  extensionProtocol,
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

test("promise contexts prefer browser while content scripts may retain chrome", () => {
  const browser = api("moz-extension:");
  const chrome = api();
  assert.equal(selectExtensionApi({ browser, chrome }), browser);
  assert.equal(selectExtensionApi({ chrome }), chrome);
  assert.equal(selectExtensionApi({}), null);
});

test("browser identity and exact extension senders derive from runtime URLs", () => {
  const firefox = api("moz-extension:", "hachidori@bee-san");
  const chrome = api();
  assert.equal(extensionProtocol(firefox), "moz-extension:");
  assert.equal(browserKind(firefox), "firefox");
  assert.equal(browserKind(chrome), "chrome");
  assert.equal(extensionDocumentUrl("offscreen.html", firefox), "moz-extension://extension/offscreen.html");
  assert.equal(isExactExtensionSender({
    id: "hachidori@bee-san",
    url: "moz-extension://extension/offscreen.html",
  }, "offscreen.html", firefox, { tab: false }), true);
  assert.equal(isExactExtensionSender({
    id: "hachidori@bee-san",
    url: "moz-extension://extension/offscreen.html",
    tab: { id: 3 },
  }, "offscreen.html", firefox, { tab: false }), false);
  assert.equal(isExactExtensionSender({
    id: "other",
    url: "moz-extension://extension/offscreen.html",
  }, "offscreen.html", firefox), false);
});
