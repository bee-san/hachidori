/*
 * The search page's docked reader (#610): the root popup fills the page's
 * results area and stays there until a lookup replaces it.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
import { check, test } from "./harness.mjs";

const DOCK = { left: 12, top: 140, width: 800, height: 500 };

// What reaches the page after the reader's own handlers: the search page
// focuses its box on an Escape the reader leaves alone.
function pageEvents(window) {
  const seen = [];
  window.addEventListener("keydown", (event) => { seen.push(event.key); });
  return seen;
}

function press(window, target) {
  for (const type of ["mousedown", "mouseup"]) {
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, buttons: type === "mousedown" ? 1 : 0,
      clientX: 900, clientY: 700 }));
  }
}

function escape(window) {
  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
}

// The queued lookup, answered; null when none was sent, so a missing request
// fails its own named check rather than the block.
async function answer(harness, results, ok = true) {
  const request = harness.take("hd_lookup");
  if (request === null) return null;
  harness.reply(request, ok ? { dictionaryCount: 1, results } : { error: "the engine went away" }, ok);
  await harness.settle();
  return request.request;
}

async function dockedCase() {
  const outcomes = {};
  const harness = await createHarness(undefined, { dock: DOCK });
  const { anchor, driver, popup } = harness;
  const window = popup.ownerDocument.defaultView;
  const placed = () => ["left", "top", "width", "height"].every(key => popup.style[key] === `${DOCK[key]}px`);
  const seen = pageEvents(window);
  try {
    outcomes["the docked root popup has no resize grip, as its size is the search page's"] =
      harness.callbacks().onResizeStart === null;

    const searching = driver.search(anchor.firstChild);
    // A dictionary change while the first search is out does not drop it, nor
    // does Escape, which goes on to the page: the reply is the search's result.
    escape(window);
    harness.emitState(harness.state(2));
    const searched = await answer(harness, [harness.term(anchor.textContent)]);
    await searching;
    outcomes["a search looks its text up from the first character and fills the results area, through Escape and a dictionary change while it is out"] =
      searched?.text === anchor.textContent && !popup.hidden && placed() && harness.render().kind === "terms"
        && harness.take("hd_lookup") === null;
    outcomes["the docked popup's host sits in the results area"] =
      harness.dockElement.contains(window.document.querySelector("hachidori-host"));

    // A pasted line's opening bracket is no word; the lookup starts after it.
    const line = window.document.createElement("p");
    line.textContent = "「食べた」";
    window.document.body.append(line);
    const bracketed = driver.search(line.firstChild);
    const bracketedSearch = await answer(harness, [harness.term("食べた")]);
    await bracketed;
    const ellipsis = window.document.createElement("p");
    ellipsis.textContent = "…";
    window.document.body.append(ellipsis);
    const punctuationOnly = driver.search(ellipsis.firstChild);
    const punctuationSearch = await answer(harness, []);
    await punctuationOnly;
    outcomes["a search skips a line's opening brackets and spaces, and looks up punctuation alone as it is"] =
      bracketedSearch?.text.startsWith("食べた") === true && punctuationSearch?.text === "…";
    // A scan runs on into following text, so the anchor's lookups below must not see these.
    line.remove();
    ellipsis.remove();

    const anchorSearch = driver.search(anchor.firstChild);
    await answer(harness, [harness.term(anchor.textContent)]);
    await anchorSearch;

    press(window, harness.dockElement);
    escape(window);
    outcomes["a press outside it and Escape keep the docked result, and Escape goes on to the page"] =
      !popup.hidden && placed() && seen.join() === "Escape,Escape";

    const opened = harness.internalLink({ query: "読む" });
    await answer(harness, [harness.term("読む")]);
    await opened;
    const childOpen = driver.popupAt(1) && !driver.popupAt(1).hidden;
    escape(window);
    const childClosed = !driver.popupAt(1);
    escape(window);
    outcomes["Escape closes a child popup of the docked result first, then goes on to the page"] =
      childOpen && childClosed && !popup.hidden && seen.join() === "Escape,Escape,Escape";

    const pending = driver.search(anchor.firstChild);
    driver.onScroll();
    const rendered = harness.renders.length;
    await answer(harness, [harness.term(anchor.textContent)]);
    await pending;
    outcomes["a pending search survives the pointer and scroll cancelling scans"] =
      !popup.hidden && harness.renders.length === rendered + 1;

    const missing = driver.search(anchor.firstChild);
    await answer(harness, []);
    await missing;
    outcomes["a search that finds nothing says so in the results area"] = !popup.hidden && placed()
      && harness.render().kind === "notice" && harness.render().value === "No definition found. Add your own with the pencil.";

    const failing = driver.search(anchor.firstChild);
    await answer(harness, [], false);
    await failing;
    outcomes["a search that fails for an unclassified reason says so in the results area"] = !popup.hidden && placed()
      && harness.render().kind === "failure" && harness.render().value.title === "The lookup failed.";

    harness.emitState(harness.state(3));
    const refreshed = await answer(harness, [harness.term(anchor.textContent)]);
    outcomes["a dictionary change looks the docked result up again instead of closing it"] =
      refreshed?.text === anchor.textContent && !popup.hidden && harness.render().kind === "terms";

    const english = window.document.createElement("p");
    english.textContent = "eat";
    window.document.body.append(english);
    const records = () => harness.sent.filter(request => request.type === "hd_lookup_stats_record").length;
    const recorded = records();
    // Every other option goes back to its default, maxResults among them (7 → 32).
    harness.emitOptions({ hoverEnabled: false, onlyScanJapaneseText: true });
    const refreshedWithOptions = await answer(harness, [harness.term(anchor.textContent)]);
    outcomes["a lookup option change looks the docked result up again with the new options without counting it again"] =
      refreshedWithOptions?.maxResults === 32 && records() === recorded && !popup.hidden;
    const typed = driver.search(english.firstChild);
    const englishSearch = await answer(harness, []);
    await typed;
    outcomes["a search works while lookups are off and looks up text that is not Japanese"] =
      englishSearch?.text === "eat" && !popup.hidden && harness.render().value === "No definition found. Add your own with the pencil.";

    // A Note draft holds an option change's refresh until the form closes.
    harness.edit(true);
    harness.emitOptions({ maxResults: 11 });
    const heldDuringDraft = harness.take("hd_lookup") === null;
    harness.edit(false);
    const afterDraft = await answer(harness, []);
    outcomes["an option change during a Note draft looks the docked result up again once the draft closes"] =
      heldDuringDraft && afterDraft?.maxResults === 11 && afterDraft.text === "eat" && !popup.hidden;
  } finally {
    harness.close();
  }
  return outcomes;
}

// The same steps without a dock: the popup over a page closes as before.
async function undockedCase() {
  const harness = await createHarness();
  const { anchor, driver, popup } = harness;
  const window = popup.ownerDocument.defaultView;
  const seen = pageEvents(window);
  try {
    await harness.initialLookup();
    const resizable = typeof harness.callbacks().onResizeStart === "function";
    escape(window);
    const escaped = popup.hidden && seen.length === 0;
    await harness.initialLookup();
    press(window, window.document.body);
    const pressed = popup.hidden;
    const unanswered = driver.search(anchor.firstChild);
    const sent = harness.take("hd_lookup") !== null;
    return { resizable, escaped, pressed, searchedWithoutDock: sent || (await unanswered) !== false };
  } finally {
    harness.close();
  }
}

describe("content search page", () => {
  test("docked search results", async () => {
    const stage = await contentNoteStage({ docked: dockedCase, undocked: undockedCase });
    check("the content harness loaded", stage !== null, "jsdom is unavailable");
    for (const [name, passed] of Object.entries(stage?.docked ?? {})) check(name, passed === true, JSON.stringify(passed));
    const undocked = stage?.undocked;
    check("without a dock the popup keeps its resize grip, Escape and an outside press close it, and search does nothing",
      undocked?.resizable && undocked.escaped && undocked.pressed && !undocked.searchedWithoutDock, JSON.stringify(undocked));
  });
});
