/*
 * End-to-end test in a real Chrome.
 *
 * Everything else in test/ runs the engine under node against fakes. This is the
 * only test that proves the parts node cannot reach: that Chrome accepts the
 * manifest, that the extension_pages CSP actually permits compiling the wasm in
 * the offscreen document, that chrome.offscreen and chrome.runtime.getContexts
 * behave as assumed, that OPFS survives a browser restart, and that a real
 * caretRangeFromPoint hover produces a rendered popup.
 *
 * Chrome and puppeteer-core live outside the repo (see CHROME and PUPPETEER in
 * test/chrome-e2e/session.mjs) so that a checkout does not carry a 290 MB browser.
 *
 * The scenario's steps live in test/chrome-e2e/, one file per feature, and this
 * file runs all of them in order in one browser. Select steps by name with
 * `node --test-name-pattern=<regex> test/chrome-e2e.mjs`: a selected step first
 * runs the earlier steps it depends on.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./chrome-e2e/session.mjs";
import "./chrome-e2e/first-run.mjs";
import "./chrome-e2e/settings.mjs";
import "./chrome-e2e/recommended.mjs";
import "./chrome-e2e/import.mjs";
import "./chrome-e2e/library.mjs";
import "./chrome-e2e/custom-dictionary.mjs";
import "./chrome-e2e/reader.mjs";
import "./chrome-e2e/counts.mjs";
import "./chrome-e2e/popup.mjs";
import "./chrome-e2e/nested.mjs";
import "./chrome-e2e/tabs.mjs";
import "./chrome-e2e/layout.mjs";
import "./chrome-e2e/activation.mjs";
import "./chrome-e2e/metadata.mjs";
import "./chrome-e2e/anki.mjs";
import "./chrome-e2e/kanji.mjs";
import "./chrome-e2e/popup-content.mjs";
import "./chrome-e2e/notes.mjs";
import "./chrome-e2e/updates.mjs";
import "./chrome-e2e/restart.mjs";
import "./chrome-e2e/memory.mjs";
import "./chrome-e2e/media.mjs";
import "./chrome-e2e/file-access.mjs";
import { markCompleteSuite } from "./chrome-e2e/harness.mjs";

markCompleteSuite();
