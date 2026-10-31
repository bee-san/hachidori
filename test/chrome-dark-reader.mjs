// Dark Reader's real dynamic-theme engine on a page using the real extension.
// The API build traverses the same open shadow roots as its browser extension.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { hoverForPopup, popupReader } from "./chrome-e2e/popup-reader.mjs";
import { popupRoot } from "./chrome-popup-root.mjs";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
export const DARK_READER_CHECK = "Dark Reader darkens the page without recolouring normal popups and custom scripts retain DOM access";

// A tab of its own: Dark Reader patches the page's prototypes, and the suite's
// reading tab keeps its open popup for the steps after this one.
export async function checkDarkReader(settings, pageUrl) {
  const saved = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const writeOptions = options => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, options);
  const output = resolve("test/tmp/ci");
  await mkdir(output, { recursive: true });
  const tab = await settings.browser().newPage();
  const darkReader = enabled => tab.evaluate(enabled => {
    if (enabled) window.DarkReader.enable({ brightness: 100, contrast: 100 });
    else window.DarkReader.disable();
  }, enabled);
  const paint = () => popupRoot(tab).evaluate(async root => {
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const selectors = [".gsm-hoshidicts-popup", ".gsm-hoshidicts-glossary-card",
      ".gsm-hoshidicts-expression", ".gsm-hoshidicts-note-icon"];
    return { mode: root.mode, exposed: root.host.shadowRoot !== null,
      overrides: root.querySelectorAll(".darkreader").length,
      colours: selectors.map(selector => {
        const element = root.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        return [style.color, style.backgroundColor, style.borderColor];
      }) };
  });
  try {
    await writeOptions({ hoverEnabled: true, lookupMode: "hover", customPopupJavascript: "", definitionBlurCountEnabled: false,
      definitionBlurAnkiMature: false, definitionBlurFrequencyEnabled: false });
    await tab.setViewport({ width: 1280, height: 900 });
    await tab.goto(pageUrl, { waitUntil: "load" });
    const popup = await popupReader(tab);
    await tab.addScriptTag({ path: require.resolve("darkreader") });
    await tab.$eval("body", body => { body.style.backgroundColor = "#fff"; body.style.color = "#111"; });
    for (const [name, patch] of [
      ["default", { popupTheme: "default", customPopupCss: "" }],
      ["light", { popupTheme: "light", customPopupCss: "" }],
      ["dark", { popupTheme: "dark", customPopupCss: "" }],
      ["high-contrast", { popupTheme: "high-contrast", customPopupCss: "" }],
      ["custom-css", { popupTheme: "default", customPopupCss: ".gsm-hoshidicts-popup { background: #182030; color: #faf0e6; }" }],
    ]) {
      await darkReader(false);
      await writeOptions(patch);
      await tab.keyboard.press("Escape");
      assert.ok(await hoverForPopup(tab, popup, "#verb"));
      await popupRoot(tab).waitFor((root, theme) => root.host.dataset.hoshidictsTheme === theme, {}, patch.popupTheme);
      const before = await paint();
      assert.equal(before.mode, "closed");
      assert.equal(before.exposed, false);
      const pageBackground = await tab.$eval("body", body => getComputedStyle(body).backgroundColor);
      await tab.screenshot({ path: resolve(output, `dark-reader-${name}-before.png`) });
      await darkReader(true);
      await tab.waitForFunction(background => getComputedStyle(document.body).backgroundColor !== background, {}, pageBackground);
      const after = await paint();
      assert.deepEqual(after, before, `${name}: popup palette changed under Dark Reader`);
      await tab.screenshot({ path: resolve(output, `dark-reader-${name}-after.png`) });
      console.log(`PASS Dark Reader: ${name}, page darkened, popup colours unchanged`);
    }
    // Open DOM remains an explicit compatibility path for saved Custom
    // JavaScript, from the next page load.
    await writeOptions({ customPopupJavascript: "/* popup customisation */" });
    await tab.reload({ waitUntil: "load" });
    assert.ok(await hoverForPopup(tab, popup, "#verb"));
    assert.equal(await tab.evaluate(() => {
      const root = document.querySelector("hachidori-host")?.shadowRoot;
      const panel = root?.querySelector(".gsm-hoshidicts-popup");
      if (!panel) return false;
      panel.dataset.customScript = "works";
      return root.mode === "open" && panel.dataset.customScript === "works";
    }), true);
  } finally {
    await tab.close();
    await writeOptions(Object.fromEntries(["hoverEnabled", "lookupMode", "popupTheme", "customPopupCss", "customPopupJavascript",
      "definitionBlurCountEnabled", "definitionBlurAnkiMature", "definitionBlurFrequencyEnabled"].map(key => [key, saved[key]])));
  }
}
