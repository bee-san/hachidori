// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

test("AUTO popup appearance follows live browser preference and removes its listener", () => {
  const dom = new JSDOM('<div id="host"></div>', { runScripts: "outside-only" });
  let dark = false;
  const listeners = new Set();
  dom.window.matchMedia = () => ({
    get matches() { return dark; },
    addEventListener(type, listener) { if (type === "change") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "change") listeners.delete(listener); },
  });
  dom.window.eval(readFileSync(new URL("../extension/render/popup.js", import.meta.url), "utf8"));
  const host = dom.window.document.getElementById("host");
  const appearance = dom.window.HDPopup.createPopupAppearance(host);
  const update = popupTheme => appearance.update({
    popupTheme, popupWidthPx: 560, popupHeightPx: 420, popupScalePercent: 100,
    popupOpacityPercent: 85, showPopupAudioButton: true,
  });

  update("auto");
  assert.equal(host.dataset.hoshidictsTheme, "light");
  dark = true;
  for (const listener of listeners) listener();
  assert.equal(host.dataset.hoshidictsTheme, "dark");
  update("dracula");
  dark = false;
  for (const listener of listeners) listener();
  assert.equal(host.dataset.hoshidictsTheme, "dracula");
  appearance.destroy();
  assert.equal(listeners.size, 0);
  dom.window.close();
});
