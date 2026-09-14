// Hosts that embed Hachidori in an overlay, such as the GSM overlay, set this to true in their copy.
// SPDX-License-Identifier: GPL-3.0-or-later

export const OVERLAY_MODE = false;

export const MINING_CAPABILITIES = Object.freeze({
  screenshot: !OVERLAY_MODE,
  browserSpeech: !OVERLAY_MODE,
});
