/*
 * The search page (#610) in Firefox: the popup window that the Open the popup
 * window shortcut and the toolbar menu's Search open through search-window.js,
 * a typed word's lookup docked under the search box, its clipboard monitor
 * (#639), whose switch asks Firefox for the clipboardRead permission, and
 * Custom JavaScript there (#644). The page itself is search-frame.html, the
 * frame search.html holds, so each read of it goes to that frame.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./settings.mjs";
import { describe } from "node:test";
import { check, step } from "./harness.mjs";
import {
  activate, bidiSession, browser, childFrame, evaluateInChrome, evaluateJson, extensionUrl, findPage,
  openExtensionPage, page, readPopup, reloadPage, sleep, waitFor, writeOptions,
} from "./session.mjs";

// The open search pages, from the extension's own documents as search-window.js finds them.
const searchPages = () => evaluateJson(page, async url => JSON.stringify(await Promise.all((await chrome.runtime.getContexts({
  contextTypes: ["TAB"], documentUrls: [url] })).map(async ({ tabId, windowId }) => ({ tabId, windowId,
  type: (await chrome.windows.get(windowId)).type })))), extensionUrl("search.html"));

// The search page's own document, in search.html's frame.
const searchFrame = target => childFrame(target, "search-frame.html");

// search-window.js's openSearchPage, which the browser shortcuts and the toolbar menu call.
const openSearchPage = mode => evaluateJson(page, async requested => {
  const { openSearchPage: open } = await import(chrome.runtime.getURL("search-window.js"));
  const opened = await open(chrome, requested);
  return JSON.stringify({ type: opened?.type ?? null });
}, mode);

describe("search page", () => {
  step("the search page in a popup window", async () => {
    await activate(page);
    const opened = await openSearchPage("popup");
    const first = await waitFor(async () => {
      const pages = await searchPages();
      return pages.some(entry => entry.type === "popup") ? pages : false;
    }, { timeout: 15_000 });
    // A second request brings the open search page forward instead of opening another.
    await openSearchPage("popup");
    const second = await searchPages();
    check("the popup window opens one search page and brings it forward instead of opening another",
      opened?.type === "popup" && first?.length === 1 && JSON.stringify(second) === JSON.stringify(first),
      JSON.stringify({ opened, first, second }));

    const search = await searchFrame(await findPage("search.html"));
    const ready = await waitFor(() => search.evaluate(() => !document.getElementById("search-submit").disabled || false),
      { timeout: 30_000 });
    // The Firefox Custom JavaScript step in settings.mjs has granted user
    // scripts and cleared its script, so none runs here.
    const unscripted = await search.evaluate(() => document.documentElement.dataset.customScript ?? null);
    await search.evaluate(() => {
      document.getElementById("search-input").value = "食べたかった";
      document.getElementById("search-form").requestSubmit();
    });
    const shown = await waitFor(async () => {
      const popup = await readPopup(search);
      return popup?.headword ? popup : false;
    }, { timeout: 20_000 });
    // The frame's own layout (search.css) applies only if Firefox served it.
    const docked = await search.evaluate(() => document.getElementById("search-results")
      .contains(document.querySelector("hachidori-host")) && getComputedStyle(document.body).display === "flex");
    check("the search page looks up a typed word and docks the reader's popup under its box",
      ready === true && shown?.headword === "食べる" && shown.plain.includes("to eat") && docked === true && unscripted === null,
      JSON.stringify({ ready, headword: shown?.headword, docked, unscripted, plain: shown?.plain?.slice(0, 120) }));

    // The script web pages run, run on the search page too, where it reaches
    // the docked result through the popup's open root.
    await writeOptions(page, { customPopupJavascript: `document.documentElement.dataset.customScript = "ran";
      setInterval(() => {
        const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
        if (popup && !popup.hidden) popup.dataset.customScript = "reached";
      }, 50);` });
    const registered = await waitFor(() => page.evaluate(async () => (await chrome.userScripts.getScripts({
      ids: ["hachidori-custom-javascript"] })).length === 1 || false), { timeout: 10_000 });
    // The page hands the frame the script as it loads.
    const scripted = await searchFrame(await reloadPage(await findPage("search.html")));
    await waitFor(() => scripted.evaluate(() => !document.getElementById("search-submit").disabled || false), { timeout: 30_000 });
    await scripted.evaluate(() => {
      document.getElementById("search-input").value = "食べる";
      document.getElementById("search-form").requestSubmit();
    });
    const marks = await waitFor(() => scripted.evaluate(() => {
      const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
      return popup?.dataset.customScript === "reached"
        ? { page: document.documentElement.dataset.customScript ?? null, popup: popup.dataset.customScript } : false;
    }), { timeout: 20_000 });
    await writeOptions(page, { customPopupJavascript: "" });
    check("Custom JavaScript runs on the search page and reaches the docked result once Firefox grants user scripts",
      registered === true && marks?.page === "ran" && marks.popup === "reached", JSON.stringify({ registered, marks }));
    await evaluateJson(page, async windowId => {
      await chrome.windows.remove(windowId);
      return "null";
    }, first?.[0]?.windowId);
    await activate(page);
  });

  step("the search page's clipboard monitor", async () => {
    // Firefox's own clipboard, as a copy in another program would fill it.
    const copy = text => evaluateInChrome(bidiSession(page), `(text => {
      const { classes: Cc, interfaces: Ci } = Components;
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
      return "copied";
    })(${JSON.stringify(text)})`);
    const search = await openExtensionPage("search.html");
    const state = () => evaluateJson(search, async () => JSON.stringify({
      ready: !document.getElementById("search-submit").disabled && !document.getElementById("search-clipboard").disabled,
      on: document.getElementById("search-clipboard").checked,
      granted: await chrome.permissions.contains({ permissions: ["clipboardRead"] }),
      query: document.getElementById("search-query").hidden ? null : document.getElementById("search-query").textContent,
    }));
    const settled = predicate => waitFor(async () => {
      const current = await state();
      return predicate(current) ? current : false;
    }, { timeout: 15_000 });
    // The monitor's requests, and the texts their replies carry.
    await search.evaluate(() => {
      const send = chrome.runtime.sendMessage;
      globalThis.clipboardReads = { sent: 0, texts: [] };
      chrome.runtime.sendMessage = function (message, ...rest) {
        const reply = send.call(this, message, ...rest);
        if (message?.type === "hd_clipboard_read") {
          globalThis.clipboardReads.sent += 1;
          reply.then(answer => globalThis.clipboardReads.texts.push(answer?.text ?? null), () => {});
        }
        return reply;
      };
    });
    const reads = () => evaluateJson(search, () => JSON.stringify(globalThis.clipboardReads));
    // Once the monitor has read `text` twice, it has acted on the first read.
    const readTwice = text => waitFor(async () => (await reads()).texts.filter(read => read === text).length >= 2,
      { timeout: 15_000 });
    await copy("食べたかった");
    const off = await settled(current => current.ready);
    await search.click("#search-clipboard");
    const on = await settled(current => current.on && current.granted);
    const baseline = await readTwice("食べたかった");
    const before = await state();
    check("the search page's Clipboard monitor is off until it is switched on, which grants Hachidori clipboardRead",
      off?.on === false && off.granted === false && on?.on === true && baseline === true && before.query === null,
      JSON.stringify({ off, on, baseline, before }));

    await copy("読む");
    const shown = await waitFor(async () => {
      const popup = await readPopup(search);
      return popup?.headword === "読む" ? popup : false;
    }, { timeout: 20_000 });
    const searched = await state();
    await search.click("#search-clipboard");
    const stopped = await settled(current => !current.on && !current.granted);
    const sentWhenStopped = (await reads()).sent;
    await copy("漢字");
    // Several of the monitor's 250 ms reads, had it gone on reading.
    await sleep(1500);
    const after = await state();
    const sentAfter = (await reads()).sent;
    check("the clipboard monitor searches Japanese copied in Firefox, and switching it off gives clipboardRead back and stops it",
      shown?.plain.includes("to read") && searched.query === "読む" && stopped?.on === false
        && sentAfter === sentWhenStopped && after.query === "読む",
      JSON.stringify({ headword: shown?.headword, plain: shown?.plain?.slice(0, 80), searched, stopped, sentWhenStopped,
        sentAfter, after }));
    await search.close();
    await activate(page);
  });
});
