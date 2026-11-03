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
export const DARK_READER_CHECK = "Dark Reader darkens the page without recolouring the popup, with or without Custom JavaScript, "
  + "and saved scripts reach the popup's closed root";
// Saved Custom JavaScript that marks the popup with the mode of the root its
// `host.shadowRoot` returns, as a user's script reaches the popup.
const CUSTOM_JAVASCRIPT = `setInterval(() => {
  const root = document.querySelector("hachidori-host")?.shadowRoot;
  const popup = root?.querySelector(".gsm-hoshidicts-popup");
  if (popup) popup.dataset.customScript = root.mode;
}, 50);`;

// Saved Custom JavaScript runs only while Chrome allows Hachidori's user
// scripts: its Allow User Scripts switch from Chrome 138, developer mode before.
async function allowUserScripts(browser, extensionId, allowed) {
  const extensions = await browser.newPage();
  try {
    await extensions.goto("chrome://extensions");
    await extensions.evaluate(async (extensionId, allowed) => {
      const { userScriptsAccess } = await chrome.developerPrivate.getExtensionInfo(extensionId);
      await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: allowed });
      if (userScriptsAccess) await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, userScriptsAccess: allowed });
    }, extensionId, allowed);
  } finally {
    await extensions.close();
  }
}

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
  const browser = settings.browser();
  const extensionId = new URL(settings.url()).host;
  const tab = await browser.newPage();
  let popup;
  let scriptsAllowed = false;
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
  // Hovers the verb, then darkens the page and compares the popup before and after.
  const compare = async (name, theme) => {
    await darkReader(false);
    await tab.keyboard.press("Escape");
    assert.ok(await hoverForPopup(tab, popup, "#verb"));
    await popupRoot(tab).waitFor((root, theme) => root.host.dataset.hoshidictsTheme === theme, {}, theme);
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
  };
  const loadPage = async () => {
    await tab.addScriptTag({ path: require.resolve("darkreader") });
    await tab.$eval("body", body => { body.style.backgroundColor = "#fff"; body.style.color = "#111"; });
  };
  try {
    await writeOptions({ hoverEnabled: true, lookupMode: "hover", customPopupJavascript: "", definitionBlurCountEnabled: false,
      definitionBlurAnkiMature: false, definitionBlurFrequencyEnabled: false });
    await tab.setViewport({ width: 1280, height: 900 });
    await tab.goto(pageUrl, { waitUntil: "load" });
    popup = await popupReader(tab);
    await loadPage();
    for (const [name, patch] of [
      ["default", { popupTheme: "default", customPopupCss: "" }],
      ["light", { popupTheme: "light", customPopupCss: "" }],
      ["dark", { popupTheme: "dark", customPopupCss: "" }],
      ["high-contrast", { popupTheme: "high-contrast", customPopupCss: "" }],
      ["custom-css", { popupTheme: "default", customPopupCss: ".gsm-hoshidicts-popup { background: #182030; color: #faf0e6; }" }],
    ]) {
      await writeOptions(patch);
      await compare(name, patch.popupTheme);
    }
    // Saved Custom JavaScript (#645): the reported setup, Default with
    // Automatic colours under a dark preference. The script runs in Chrome's
    // user-script world from the next page load and reaches the popup through
    // host.shadowRoot, while the page and Dark Reader still see no root.
    await allowUserScripts(browser, extensionId, true);
    scriptsAllowed = true;
    await writeOptions({ popupTheme: "auto", customPopupCss: "", customPopupJavascript: CUSTOM_JAVASCRIPT });
    // Settings is a background tab, where animation frames do not run.
    await settings.waitForFunction(async code => (await chrome.userScripts.getScripts())
      .some(script => script.js.some(source => source.code === code)), { polling: 100 }, CUSTOM_JAVASCRIPT);
    await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await tab.reload({ waitUntil: "load" });
    await loadPage();
    await compare("custom-javascript", "dark");
    assert.equal(await popupRoot(tab).waitFor(root => root.querySelector(".gsm-hoshidicts-popup").dataset.customScript,
      { timeout: 10_000 }), "closed", "saved Custom JavaScript did not reach the closed root through host.shadowRoot");
  } finally {
    await tab.close();
    await writeOptions(Object.fromEntries(["hoverEnabled", "lookupMode", "popupTheme", "customPopupCss", "customPopupJavascript",
      "definitionBlurCountEnabled", "definitionBlurAnkiMature", "definitionBlurFrequencyEnabled"].map(key => [key, saved[key]])));
    if (scriptsAllowed) {
      // Clearing the code removes the registration while Chrome still allows it.
      if (!saved.customPopupJavascript) {
        await settings.waitForFunction(async () => (await chrome.userScripts.getScripts()).length === 0, { polling: 100 });
      }
      await allowUserScripts(browser, extensionId, false);
    }
  }
}
