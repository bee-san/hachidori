/*
 * End-to-end test of the Firefox build in a real Firefox.
 *
 * The Firefox counterpart of test/chrome-e2e.mjs: Firefox installs the
 * build from scripts/build-firefox.py as a temporary add-on, and Puppeteer
 * drives it over WebDriver BiDi. It proves what the Node suites cannot: that
 * Firefox accepts the Firefox manifest, that its background page runs the
 * worker's modules and holds the engine, that the single-thread WebAssembly
 * engine imports and persists dictionaries in IndexedDB, and that the content
 * scripts, Settings, Anki mining, backups and updates work there.
 *
 * The steps live in test/firefox-e2e/, one file per feature, and run in order
 * in one profile. Select steps with `node --test-name-pattern=<regex>`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./firefox-e2e/install.mjs";
import "./firefox-e2e/first-run.mjs";
import "./firefox-e2e/import.mjs";
import "./firefox-e2e/reader.mjs";
import "./firefox-e2e/settings.mjs";
import "./firefox-e2e/anki.mjs";
import "./firefox-e2e/backup.mjs";
import "./firefox-e2e/sharing.mjs";
import "./firefox-e2e/restart.mjs";
import { E2E_PLANNED, markCompleteSuite } from "./firefox-e2e/harness.mjs";

markCompleteSuite(E2E_PLANNED);
