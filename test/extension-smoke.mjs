/*
 * Drives the extension's own JavaScript against the real wasm engine.
 *
 * node-smoke.mjs proves the C ABI; this proves the layer above it: that
 * background.js relays, that offscreen.js answers every message type in
 * contract C with the documented reply shape, and that the engine's contract-B
 * JSON survives a trip through the ported renderer.
 *
 * Nothing here is a browser. The fakes cover only the Chrome surface the
 * extension actually touches, so this catches typo'd message names, wrong reply
 * shapes, unhandled rejections and renderer/engine field mismatches -- not
 * Chrome's own acceptance of the manifest, offscreen documents, IndexedDB or
 * MV3 CSP.
 *
 * Each feature is one file in test/extension-smoke/; this file runs all of them
 * in one process, in this order. Run one file on its own with
 * `node test/extension-smoke/<file>.mjs`, or select blocks by name with
 * `node --test-name-pattern=<regex> test/extension-smoke.mjs`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./extension-smoke/reader-options.mjs";
import "./extension-smoke/background.mjs";
import "./extension-smoke/sharing.mjs";
import "./extension-smoke/anki.mjs";
import "./extension-smoke/backup.mjs";
import "./extension-smoke/netflix.mjs";
import "./extension-smoke/updates.mjs";
import "./extension-smoke/lookup-stats.mjs";
import "./extension-smoke/audio.mjs";
import "./extension-smoke/custom-dictionary.mjs";
import "./extension-smoke/recommended.mjs";
import "./extension-smoke/engine.mjs";
import "./extension-smoke/engine-replacement.mjs";
import "./extension-smoke/engine-updates.mjs";
import "./extension-smoke/engine-library.mjs";
import "./extension-smoke/engine-lookup.mjs";
import "./extension-smoke/renderer.mjs";
import "./extension-smoke/settings.mjs";
import "./extension-smoke/library.mjs";
import "./extension-smoke/startup.mjs";
import "./extension-smoke/design.mjs";
import "./extension-smoke/source-highlight.mjs";
import "./extension-smoke/content.mjs";
import "./extension-smoke/content-popup.mjs";
import "./extension-smoke/content-blur.mjs";
import "./extension-smoke/content-scanning.mjs";
import "./extension-smoke/content-activation.mjs";
import "./extension-smoke/content-nested.mjs";
import "./extension-smoke/content-notes.mjs";
import "./extension-smoke/engine-restart.mjs";
import "./extension-smoke/engine-storage.mjs";
