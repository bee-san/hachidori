/*
 * The search page (#610) in Firefox: the popup window that the Open the popup
 * window shortcut and the toolbar menu's Search open through search-window.js,
 * at the size Settings sets, a typed word's lookup docked under the search
 * box, its clipboard monitor (#639), whose switch asks Firefox for the
 * clipboardRead permission, Custom JavaScript there (#644), and its click
 * lookups and Anki Template switch (#656). The page itself is search-frame.html, the
 * frame search.html holds, so each read of it goes to that frame.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./settings.mjs";
import { describe } from "node:test";
import { check, step } from "./harness.mjs";
import {
  activate, bidiSession, browser, characterPoint, childFrame, evaluateInChrome, evaluateJson, extensionUrl, findPage,
  openExtensionPage, page, readPopup, readStorage, reloadPage, sleep, waitFor, writeOptions,
} from "./session.mjs";

// The open search pages, from the extension's own documents as search-window.js finds them.
const searchPages = () => evaluateJson(page, async url => JSON.stringify(await Promise.all((await chrome.runtime.getContexts({
  contextTypes: ["TAB"], documentUrls: [url] })).map(async ({ tabId, windowId }) => {
  const window = await chrome.windows.get(windowId);
  return { tabId, windowId, type: window.type, size: [window.width, window.height] };
}))), extensionUrl("search.html"));

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
    // Reading → Search page sets the window's size (#656).
    await writeOptions(page, { searchWindowWidthPx: 520, searchWindowHeightPx: 480 });
    const opened = await openSearchPage("popup");
    const first = await waitFor(async () => {
      const pages = await searchPages();
      return pages.some(entry => entry.type === "popup") ? pages : false;
    }, { timeout: 15_000 });
    await writeOptions(page, { searchWindowWidthPx: 600, searchWindowHeightPx: 640 });
    // A second request brings the open search page forward instead of opening another.
    await openSearchPage("popup");
    const second = await searchPages();
    check("the popup window opens one search page and brings it forward instead of opening another",
      opened?.type === "popup" && first?.length === 1 && JSON.stringify(second) === JSON.stringify(first),
      JSON.stringify({ opened, first, second }));
    check("the popup window opens at the size set in Reading → Search page",
      JSON.stringify(first?.[0]?.size) === "[520,480]", JSON.stringify(first));

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
    // the docked result through the popup's open root. Firefox has sandboxed
    // extension pages from 154; before, the frame is an ordinary extension
    // page, where it cannot run.
    const sandboxes = Number(/(\d+)\./u.exec(await browser.version())[1]) >= 154;
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
    const sandboxed = await scripted.evaluate(() => self.origin === "null");
    await scripted.evaluate(() => {
      document.getElementById("search-input").value = "食べる";
      document.getElementById("search-form").requestSubmit();
    });
    const result = await waitFor(async () => (await readPopup(scripted))?.headword ?? false, { timeout: 20_000 });
    const marks = await waitFor(() => scripted.evaluate(() => {
      const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
      return { page: document.documentElement.dataset.customScript ?? null, popup: popup?.dataset.customScript ?? null };
    }).then(found => (found.popup === "reached" || !sandboxes ? found : false)), { timeout: 5_000 });
    await writeOptions(page, { customPopupJavascript: "" });
    check("Custom JavaScript runs on the search page from Firefox 154, reaching the docked result, once Firefox grants user scripts",
      registered === true && result === "食べる" && sandboxed === sandboxes
        && (sandboxes ? marks?.page === "ran" && marks.popup === "reached" : marks?.page === null && marks.popup === null),
      JSON.stringify({ registered, result, sandboxes, sandboxed, marks }));
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
    // The switch and the monitor are search.html's, the box and the reader its frame's (#644).
    const search = await openExtensionPage("search.html");
    const frame = await searchFrame(search);
    const state = async () => {
      const box = await frame.evaluate(() => ({ ready: !document.getElementById("search-submit").disabled,
        query: document.getElementById("search-query").hidden ? null : document.getElementById("search-query").textContent }));
      const monitor = await evaluateJson(search, async () => JSON.stringify({
        enabled: !document.getElementById("search-clipboard").disabled,
        on: document.getElementById("search-clipboard").checked,
        granted: await chrome.permissions.contains({ permissions: ["clipboardRead"] }),
      }));
      return { ready: box.ready && monitor.enabled, on: monitor.on, granted: monitor.granted, query: box.query };
    };
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
    // The click hands focus back to the frame, where the reader's keys work (#644).
    const handedBack = await waitFor(() => frame.evaluate(() => document.hasFocus() || false), { timeout: 5_000 });
    const baseline = await readTwice("食べたかった");
    const before = await state();
    check("the search page's Clipboard monitor is off until it is switched on, which grants Hachidori clipboardRead",
      off?.on === false && off.granted === false && on?.on === true && handedBack === true && baseline === true
        && before.query === null,
      JSON.stringify({ off, on, handedBack, baseline, before }));

    await copy("読む");
    const shown = await waitFor(async () => {
      const popup = await readPopup(frame);
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

  // Reading → Search page → Look up words with a click and the Anki Template
  // switch (#656), with the reader in Firefox's frame and the switch in search.html.
  step("the search page's click lookups and Anki Template switch", async () => {
    const before = await evaluateJson(page, async () => JSON.stringify(globalThis.HDReaderOptions
      .normaliseOptions((await chrome.storage.local.get("options")).options)));
    const original = before.anki;
    const twoTemplates = await evaluateJson(page, json => {
      const anki = JSON.parse(json);
      return JSON.stringify(globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
        templates: [anki.templates[0], { ...anki.templates[0], id: "e2e-words", name: "Words" }] }));
    }, JSON.stringify(original));
    // Page lookups wait for the activation key, which nothing here holds.
    await writeOptions(page, { searchClickLookup: true, lookupMode: "activationSticky", anki: twoTemplates });
    const search = await openExtensionPage("search.html");
    let evidence;
    try {
      const frame = await searchFrame(search);
      await waitFor(() => frame.evaluate(() => !document.getElementById("search-submit").disabled || false), { timeout: 30_000 });
      await frame.evaluate(() => {
        document.getElementById("search-input").value = "漢字を読む";
        document.getElementById("search-form").requestSubmit();
      });
      const searched = await waitFor(async () => ((await readPopup(frame))?.headword === "漢字" ? true : false),
        { timeout: 20_000 });
      // 読 is the query's fourth character; the frame fills the page.
      const point = await characterPoint(frame, "#search-query", 3);
      await search.mouse.click(point.x, point.y);
      const clicked = await waitFor(async () => {
        const popup = await readPopup(frame);
        return popup?.headword === "読む" ? popup : false;
      }, { timeout: 20_000 });
      const shown = await waitFor(() => search.evaluate(() => !document.getElementById("search-template").hidden || false),
        { timeout: 10_000 });
      await search.select("#search-template", "e2e-words");
      const chosen = await waitFor(async () => {
        const { templates } = (await readStorage(page, ["options"])).options.anki;
        const copy = await frame.evaluate(() => document.querySelector("select.search-template").value);
        return templates[0].id === "e2e-words" && copy === "e2e-words" ? templates.map(({ id }) => id) : false;
      }, { timeout: 10_000 });
      evidence = { searched, clicked: clicked?.plain?.slice(0, 60) ?? null, shown, chosen };
    } finally {
      await writeOptions(page, { searchClickLookup: before.searchClickLookup, lookupMode: before.lookupMode, anki: original });
      await search.close();
      await activate(page);
    }
    check("a click on a word of the search page's query shows its results once Look up words with a click is on",
      evidence.searched === true && evidence.clicked?.includes("to read"), JSON.stringify(evidence));
    check("the search page's Anki Template switch makes the chosen Template the built-in one, and the frame's copy follows",
      evidence.shown === true && JSON.stringify(evidence.chosen) === JSON.stringify(["e2e-words", original.templates[0].id]),
      JSON.stringify(evidence));
  });

  // The search page's line history (docs/search-history.md): its lines, the
  // box's walk, the searched text's cursor and an earlier line, and the API
  // user scripts use.
  step("the search page's history and its keys", async () => {
    // Off by default: Settings → Advanced → Search history.
    await writeOptions(page, { searchHistoryEnabled: true });
    const search = await activate(await openExtensionPage("search.html"));
    let frame = await searchFrame(search);
    const ready = target => waitFor(() => target.evaluate(() => !document.getElementById("search-submit").disabled || false),
      { timeout: 30_000 });
    await ready(frame);
    const searchFor = text => frame.evaluate((value) => {
      const box = document.getElementById("search-input");
      box.value = value;
      box.form.requestSubmit();
    }, text);
    const state = () => frame.evaluate(() => {
      const element = id => document.getElementById(id);
      const [cursor] = CSS.highlights.get("hd-search-cursor") ?? [];
      return { value: element("search-input").value, focused: document.activeElement?.id ?? null,
        query: element("search-query").hidden ? null : element("search-query").textContent,
        before: element("search-before").hidden ? null : element("search-before").dataset.text,
        after: element("search-after").hidden ? null : element("search-after").dataset.text,
        where: element("search-where").hidden ? null : element("search-where").textContent,
        cursor: cursor ? { at: cursor.startOffset, text: cursor.toString() } : null };
    });
    const until = predicate => waitFor(async () => {
      const current = await state();
      return predicate(current) ? current : false;
    }, { timeout: 15_000 });
    const lines = () => frame.evaluate(() => globalThis.HDSearchHistory.list());

    const before = await lines();
    await searchFor("漢字");
    await until(current => current.query === "漢字");
    await searchFor("ありがとう");
    await until(current => current.query === "ありがとう");
    const kept = await waitFor(async () => {
      const all = await lines();
      return all.length === before.length + 2 ? all : false;
    }, { timeout: 15_000 });
    await frame.evaluate(() => {
      const box = document.getElementById("search-input");
      box.focus();
      box.value = "下書き";
      box.setSelectionRange(3, 3);
    });
    const walked = [];
    for (const key of ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown"]) {
      const previous = (await state()).value;
      await search.keyboard.press(key);
      walked.push((await until(current => current.value !== previous)).value);
    }
    check("the search page keeps each line it searches, and Up and Down in its box walk them back to the draft",
      JSON.stringify(kept?.slice(-2).map(({ text, source, page: window }) => [text, source, window]))
        === JSON.stringify([["漢字", "typed", "tab"], ["ありがとう", "typed", "tab"]])
        && JSON.stringify(walked) === JSON.stringify(["ありがとう", "漢字", "ありがとう", "下書き"]),
      JSON.stringify({ before: before.length, kept: kept?.map(line => line.text), walked }));

    await searchFor("漢字読むありがとう");
    const opened = await until(current => current.query === "漢字読むありがとう" && current.cursor?.text === "漢字");
    await search.keyboard.press("ArrowRight");
    const moved = await until(current => current.cursor?.at === 2 && current.cursor.text === "読む");
    const looked = await waitFor(async () => ((await readPopup(frame))?.headword === "読む" ? "読む" : false), { timeout: 15_000 });
    await search.keyboard.press("ArrowUp");
    const earlier = await until(current => current.where !== null);
    check("in the searched text Right moves the cursor to the next word and looks it up, and Up past its top row shows the earlier line between its neighbours",
      opened.focused === "search-query" && moved !== false && looked === "読む" && earlier.query === "ありがとう"
        && earlier.before === "漢字" && earlier.after === "漢字読むありがとう"
        && earlier.where === "Earlier line -1 · ▲ earlier · ▼ later",
      JSON.stringify({ opened, moved, looked, earlier }));

    // HDSearchHistory, the page's API for user scripts (docs/search-history.md):
    // it lists the lines the page kept, edits one and looks a word up in a
    // text node of the script's own.
    const [first] = await lines();
    const api = await frame.evaluate(async (id) => {
      const history = globalThis.HDSearchHistory;
      const edited = await history.edit(id, "漢字を読む");
      const own = document.createElement("p");
      own.lang = "ja";
      own.textContent = "ありがとう";
      document.body.append(own);
      const matched = await history.lookUp(own.firstChild, 0);
      own.remove();
      return JSON.stringify({ enabled: history.enabled, edited: edited?.text ?? null, matched,
        listed: (await history.list()).map(line => line.text) });
    }, first.id);
    const used = JSON.parse(api);
    await writeOptions(page, { searchHistoryEnabled: false });
    check("HDSearchHistory, the search page's API for user scripts, lists the kept lines, edits one and looks a word up",
      used.enabled === true && used.edited === "漢字を読む" && used.matched === 5 && used.listed[0] === "漢字を読む",
      JSON.stringify(used));
    await search.close();
    await activate(page);
  });
});
