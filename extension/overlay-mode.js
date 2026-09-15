// Hosts that embed Hachidori in an overlay, such as the GSM overlay, set this to true in their copy.
// SPDX-License-Identifier: GPL-3.0-or-later

import { BROWSER_KIND, IS_FIREFOX } from "./browser-api.js";

export const OVERLAY_MODE = false;
export const HOST_BROWSER = OVERLAY_MODE ? "electron" : BROWSER_KIND;

// Electron's extension host deliberately exposes less of Chrome than a normal
// browser window, and Firefox deliberately omits Chrome's recording stack.
// Keep every host-owned capability in one place so shared settings cannot make
// an unavailable control live again.
export const HOST_CAPABILITIES = Object.freeze({
  backupExport: !OVERLAY_MODE,
  browserShortcuts: !OVERLAY_MODE,
  customLinks: !OVERLAY_MODE,
  localFileAccessPrompt: !OVERLAY_MODE,
  mediaCapture: !OVERLAY_MODE && !IS_FIREFOX,
});

export const MINING_CAPABILITIES = Object.freeze({
  screenshot: !OVERLAY_MODE,
  browserSpeech: !OVERLAY_MODE && !IS_FIREFOX,
});
