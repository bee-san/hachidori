/*
 * The content script's activation keys and buttons, scan delays, departures and keybinds.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
import { check, test } from "./harness.mjs";

async function activationCase() {
  const result = {};
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const fire = (delay) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    if (!entry) return false;
    timers.delete(entry[0]);
    entry[1].callback();
    return true;
  };
  const key = (type, value, code, extra = {}) => window.document.dispatchEvent(
    new window.KeyboardEvent(type, { key: value, code, bubbles: true, ...extra }),
  );
  const move = (target = window.document.body, extra = {}) => harness.driver.onMouseMove({
    clientX: 200, clientY: 200, target, ...extra,
  });
  const settings = { lookupMode: "activation", activationKey: "Shift", popupHideDelayMs: 250 };
  harness.emitOptions(settings);
  harness.driver.setScanCandidate(harness.candidate);
  move();
  fire(0);
  const gated = harness.take("hd_lookup") === null;
  key("keydown", "Shift", "ShiftLeft", { shiftKey: true });
  const immediate = harness.take("hd_lookup") === null && [...timers.values()].some((timer) => timer.delay === 0);
  key("keyup", "Shift", "ShiftLeft");
  const cancelledTimer = !fire(0);
  key("keydown", "Shift", "ShiftLeft", { shiftKey: true });
  fire(0);
  const pending = harness.take("hd_lookup");
  key("keyup", "Shift", "ShiftLeft");
  if (pending) harness.reply(pending, { dictionaryCount: 1, results: [harness.term("released")] });
  await harness.settle();
  result["activation release cancels immediate scans and a first pending reply without pointer motion"] =
    gated && immediate && cancelledTimer && pending !== null && harness.driver.snapshot().popupHidden;

  harness.emitOptions({ ...settings, lookupMode: "activationSticky" });
  key("keydown", "Shift", "ShiftLeft", { shiftKey: true });
  fire(0);
  const sticky = harness.take("hd_lookup");
  key("keyup", "Shift", "ShiftLeft");
  if (sticky) harness.reply(sticky, { dictionaryCount: 1, results: [harness.term("sticky")] });
  await harness.settle();
  harness.driver.setScanCandidate(null);
  move();
  fire(0);
  key("keydown", "Shift", "ShiftLeft", { shiftKey: true });
  fire(0);
  key("keyup", "Shift", "ShiftLeft");
  harness.driver.onMouseOut({ relatedTarget: null });
  const stayed = sticky !== null && !harness.driver.hideTimerPending() && !harness.driver.snapshot().popupHidden;
  harness.driver.onMouseDown({ target: window.document.body, clientX: 200, clientY: 200 });
  result["sticky activation keeps the popup through key release and pointer departure until a click"] =
    stayed && harness.driver.snapshot().popupHidden;
  harness.driver.onWindowBlur();
  harness.driver.setScanCandidate(harness.candidate);
  move();

  harness.emitOptions({ ...settings, activationKey: "/" });
  key("keydown", "/", "Slash");
  key("keydown", "/", "Slash", { repeat: true });
  const oneTimer = [...timers.values()].filter((timer) => timer.delay === 0).length === 1;
  fire(0);
  const printable = harness.take("hd_lookup");
  key("keyup", "?", "Slash", { shiftKey: true });
  if (printable) harness.reply(printable, { dictionaryCount: 1, results: [harness.term("released punctuation")] });
  await harness.settle();
  result["configured printable activation keys release by physical code and ignore repeats"] =
    oneTimer && printable !== null && harness.driver.snapshot().popupHidden;

  harness.emitOptions({ ...settings, activationKey: "Escape" });
  key("keydown", "Escape", "Escape");
  key("keydown", "Escape", "Escape", { repeat: true });
  fire(0);
  const escaped = harness.take("hd_lookup");
  if (escaped) harness.reply(escaped, { dictionaryCount: 1, results: [harness.term("Escape key")] });
  await harness.settle();
  key("keydown", "Escape", "Escape", { repeat: true });
  const escapeRepeatRetained = !harness.driver.snapshot().popupHidden;
  harness.edit(true);
  harness.setCloseNext(true);
  key("keydown", "Escape", "Escape");
  key("keydown", "Escape", "Escape", { repeat: true });
  const noteRepeatRetained = !harness.driver.snapshot().popupHidden && !harness.driver.snapshot().noteEditing;
  key("keyup", "Escape", "Escape");
  key("keydown", "Escape", "Escape");
  const escapeDismissed = harness.driver.snapshot().popupHidden;
  key("keyup", "Escape", "Escape");
  key("keydown", "Escape", "Escape");
  window.getSelection().selectAllChildren(harness.anchor);
  window.document.dispatchEvent(new window.Event("selectionchange"));
  const selectedMiss = harness.take("hd_lookup");
  key("keyup", "Escape", "Escape");
  if (selectedMiss) harness.reply(selectedMiss, { dictionaryCount: 1, results: [] });
  await harness.settle();
  key("keydown", "Escape", "Escape");
  const missTimer = fire(0);
  const unexpectedRetry = harness.take("hd_lookup");
  if (unexpectedRetry) harness.reply(unexpectedRetry, { dictionaryCount: 1, results: [] });
  await harness.settle();
  result["Escape activation respects Note dismissal, retained selection misses and auto-repeat"] =
    escaped !== null && escapeRepeatRetained && noteRepeatRetained && escapeDismissed
    && selectedMiss !== null && !missTimer && unexpectedRetry === null;
  key("keyup", "Escape", "Escape");
  window.getSelection().removeAllRanges();
  window.document.dispatchEvent(new window.Event("selectionchange"));

  const departures = [];
  // A blur below leaves the tab, which only cancels unfinished work (#432).
  window.document.hasFocus = () => false;
  for (const reason of ["no-candidate", "window-exit", "blur", "Escape", "click", "scroll"]) {
    harness.emitOptions({ ...settings, lookupMode: "hover" });
    harness.driver.setScanCandidate(harness.candidate);
    move();
    fire(0);
    const departed = harness.take("hd_lookup");
    if (reason === "no-candidate") {
      harness.driver.setScanCandidate(null);
      move();
      fire(0);
    } else if (reason === "window-exit") harness.driver.onMouseOut({ relatedTarget: null });
    else if (reason === "blur") harness.driver.onWindowBlur();
    else if (reason === "Escape") key("keydown", "Escape", "Escape");
    else if (reason === "scroll") harness.driver.onScroll();
    else harness.driver.onMouseDown({ target: window.document.body, clientX: 200, clientY: 200 });
    if (departed) harness.reply(departed, { dictionaryCount: 1, results: [harness.term(reason)] });
    await harness.settle();
    departures.push(departed !== null && harness.driver.snapshot().popupHidden);
    harness.driver.onWindowBlur();
  }
  result["pointer departure, click, Escape, blur and scroll cancel the first pending popup"] =
    departures.every(Boolean) || departures;

  harness.emitOptions({ ...settings, lookupMode: "hover" });
  await harness.initialLookup();
  harness.driver.setScanCandidate(null);
  move();
  fire(0);
  const transferDelay = harness.driver.hideTimerPending() && !harness.driver.snapshot().popupHidden
    && [...timers.values()].some((timer) => timer.delay === 250);
  move(harness.popup.getRootNode().host);
  const transferred = !harness.driver.hideTimerPending();
  fire(0);
  harness.edit(true);
  move();
  fire(0);
  const draftProtected = !harness.driver.hideTimerPending() && !harness.driver.snapshot().popupHidden;
  harness.edit(false);
  harness.emitOptions({ ...settings, lookupMode: "hover", popupHideDelayMs: 0 });
  const retainedViewCurrent = harness.render().context.isCurrentRequest();
  move();
  fire(0);
  fire(0);
  result["configured transfer delays preserve popup entry and Note editing and allow immediate hide"] =
    transferDelay && transferred && draftProtected && retainedViewCurrent && harness.driver.snapshot().popupHidden
      || { transferDelay, transferred, draftProtected, retainedViewCurrent, hidden: harness.driver.snapshot().popupHidden };

  harness.emitOptions({ ...settings, lookupMode: "hover" });
  await harness.initialLookup();
  const oldViewContext = harness.render().context;
  harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
  move();
  fire(0);
  const supersededPointer = harness.take("hd_lookup");
  const oldViewRetired = !harness.driver.snapshot().popupHidden && harness.popup.inert
    && !oldViewContext.isCurrentRequest() && !oldViewContext.isCurrentView()
    && harness.driver.viewRequest() === null;
  const rendersBeforeNote = harness.renders.length;
  harness.driver.setScanCandidate(null);
  move();
  fire(0);
  if (supersededPointer) harness.reply(supersededPointer, { dictionaryCount: 1, results: [harness.term("late pointer")] });
  await harness.settle();
  const cancelledReplacement = harness.driver.snapshot().popupHidden && harness.renders.length === rendersBeforeNote;
  await harness.initialLookup();
  harness.edit(true);
  harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
  move();
  fire(0);
  result["a new pointer candidate retains an inert old view while an open Note prevents replacement"] =
    supersededPointer !== null && oldViewRetired && cancelledReplacement
      && harness.driver.snapshot().noteEditing && harness.render().context.isCurrentRequest()
      && harness.take("hd_lookup") === null && !harness.driver.snapshot().popupHidden;
  harness.edit(false);

  harness.driver.setScanCandidate({ ...harness.candidate, query: "settings race" });
  move();
  fire(0);
  const settingsLookup = harness.take("hd_lookup");
  harness.emitOptions({ ...settings, lookupMode: "hover", maxResults: 4 });
  harness.reply(settingsLookup, { dictionaryCount: 1, results: [harness.term("obsolete settings")] });
  await harness.settle();
  result["settings invalidate a pending replacement without stranding an inert visible view"] =
    harness.driver.snapshot().popupHidden;
  await harness.initialLookup();

  const focusedControl = window.document.createElement("button");
  focusedControl.textContent = "Back";
  harness.popup.append(focusedControl);
  focusedControl.focus();
  move();
  fire(0);
  const focusedRequest = harness.take("hd_lookup");
  const focusKept = harness.popup.getRootNode().activeElement === focusedControl;
  const focusedVisible = !harness.driver.snapshot().popupHidden;
  if (focusedRequest) harness.reply(focusedRequest, { dictionaryCount: 1, results: [harness.term("incidental pointer")] });
  await harness.settle();
  result["keyboard-focused popup controls suppress incidental pointer replacements"] =
    focusedRequest === null && focusKept && focusedVisible && harness.render().context.isCurrentRequest();
  focusedControl.blur();

  harness.driver.setScanCandidate(harness.candidate);
  move();
  harness.emitOptions({ ...settings, hoverEnabled: false });
  const disabledTimer = !fire(0);
  move();
  fire(0);
  const disabledScan = harness.take("hd_lookup") === null;
  harness.emitOptions({ ...settings, lookupMode: "hover" });
  const disabledPending = harness.driver.runLookup(harness.candidate);
  const disabledRequest = harness.take("hd_lookup");
  harness.emitOptions({ ...settings, hoverEnabled: false });
  harness.reply(disabledRequest, { dictionaryCount: 1, results: [harness.term("disabled while pending")] });
  await disabledPending;
  const disabledReply = harness.driver.snapshot().popupHidden;
  harness.emitOptions({ ...settings, lookupMode: "hover" });
  await harness.initialLookup();
  harness.edit(true);
  const append = harness.callbacks().onAddCustomEntry({ term: "食べた", reading: "たべた", definition: "ate" });
  const appendRequest = harness.take("hd_custom_append");
  harness.emitOptions({ ...settings, hoverEnabled: false });
  const closedDraft = harness.driver.snapshot().popupHidden;
  harness.reply(appendRequest, { document: { revision: 2 }, state: harness.state(2, "saved while disabled") });
  await append;
  await harness.settle();
  result["master disable stops scans and closes drafts without cancelling or refreshing a committed Note"] =
    disabledTimer && disabledScan && disabledReply && closedDraft && harness.driver.snapshot().popupHidden
      && harness.take("hd_lookup") === null;
  harness.close();
  return result;
}

// Issues #502 and #503 drive these with controlled timers: `flush` runs one
// task's zero-delay timers, `fire` the single timer with a dwell's delay.
function dwellClock(window) {
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  window.clearTimeout = (id) => timers.delete(id);
  const ids = (delay) => [...timers].filter(([, timer]) => timer.delay === delay).map(([id]) => id);
  const run = (id) => {
    const { callback } = timers.get(id);
    timers.delete(id);
    callback();
  };
  return {
    ids,
    flush() { for (const id of ids(0)) if (timers.has(id)) run(id); },
    fire(delay) {
      const [id] = ids(delay);
      if (id === undefined) return false;
      run(id);
      return true;
    },
  };
}

// Issue #502: with No key, a lookup waits until the pointer has rested on
// one word for the scan delay. The dwell belongs to the word, so moving
// within it never postpones it; leaving it, or anything that cancels pointer
// work, ends it without a lookup. Deliberate input never waits.
async function scanDelayCase() {
  const result = {};
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const clock = dwellClock(window);
  const settings = { lookupMode: "hover", scanDelayMs: 220 };
  const word = (query) => ({ ...harness.candidate, query });
  // Every scan resolves a fresh candidate, as the page scanner does.
  const hover = (candidate, clientX = 200) => {
    harness.driver.setScanCandidate(candidate && { ...candidate });
    harness.driver.onMouseMove({ clientX, clientY: 200, target: window.document.body });
    clock.flush();
  };
  const sent = (type) => harness.sent.filter((request) => request.type === type).length;
  try {
    harness.emitOptions(settings);
    for (const query of ["食べた", "読む", "漢字"]) hover(word(query));
    const crossed = sent("hd_lookup") === 0 && clock.ids(220).length === 1;
    const [dwell] = clock.ids(220);
    hover(word("漢字"), 203);
    const kept = clock.ids(220).length === 1 && clock.ids(220)[0] === dwell && sent("hd_lookup") === 0;
    clock.fire(220);
    const rested = harness.take("hd_lookup");
    const once = rested?.request.text === "漢字" && sent("hd_lookup") === 1 && clock.ids(220).length === 0;
    if (rested) harness.reply(rested, { dictionaryCount: 1, results: [harness.term("漢字")] });
    await harness.settle();
    hover(word("漢字"), 205);
    const shown = !harness.driver.snapshot().popupHidden && sent("hd_lookup") === 1 && clock.ids(220).length === 0;
    result["No key lookups wait for the pointer to rest: crossing words sends none and resting on one sends one"] =
      crossed && kept && once && shown || { crossed, kept, once, shown };

    hover(word("読む"));
    const [first] = clock.ids(220);
    hover(word("漢字"));
    const returned = clock.ids(220).length === 0;
    hover(word("読む"));
    const restarted = clock.ids(220).length === 1 && clock.ids(220)[0] !== first;
    hover(null);
    const left = clock.ids(220).length === 0;
    result["changing or leaving the word restarts or cancels its dwell, even by way of the shown word"] =
      first !== undefined && returned && restarted && left && sent("hd_lookup") === 1
      || { first, returned, restarted, left };

    const lookups = sent("hd_lookup");
    const recorded = sent("hd_lookup_stats_record");
    const cancellations = {};
    for (const [reason, cancel] of Object.entries({
      scroll: () => harness.driver.onScroll(),
      "window exit": () => harness.driver.onMouseOut({ relatedTarget: null }),
      "Escape over a popup": () => window.document.dispatchEvent(new window.KeyboardEvent("keydown",
        { key: "Escape", code: "Escape", bubbles: true })),
      "Escape before a popup": () => window.document.dispatchEvent(new window.KeyboardEvent("keydown",
        { key: "Escape", code: "Escape", bubbles: true })),
      "page press": () => harness.driver.onMouseDown({ button: 0, clientX: 200, clientY: 200,
        target: window.document.body }),
      "key mode": () => harness.emitOptions({ ...settings, lookupMode: "activationSticky" }),
    })) {
      harness.emitOptions(settings);
      hover(word("読む"));
      const armed = clock.ids(220).length === 1;
      cancel();
      cancellations[reason] = armed && !clock.fire(220);
    }
    result["scroll, window exit, Escape, a page press and a key mode change cancel a dwell without a lookup or count"] =
      Object.values(cancellations).every(Boolean) && sent("hd_lookup") === lookups
        && sent("hd_lookup_stats_record") === recorded || cancellations;

    harness.emitOptions(settings);
    hover(word("読む"));
    harness.emitOptions({ ...settings, scanDelayMs: 330 });
    clock.flush();
    const rearmed = clock.ids(220).length === 0 && clock.ids(330).length === 1;
    clock.fire(330);
    const edited = harness.take("hd_lookup");
    harness.emitOptions({ ...settings, scanDelayMs: 0 });
    hover(word("食べた"));
    const immediate = harness.take("hd_lookup");
    harness.emitOptions({ ...settings, lookupMode: "activation", activationKey: "Shift" });
    hover(word("漢字"));
    const gated = sent("hd_lookup") === lookups + 2;
    window.document.dispatchEvent(new window.KeyboardEvent("keydown",
      { key: "Shift", code: "ShiftLeft", shiftKey: true, bubbles: true }));
    clock.flush();
    const keyed = harness.take("hd_lookup");
    window.document.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", bubbles: true }));
    result["an edited delay restarts the dwell, while 0 and a held activation key look up at once"] =
      rearmed && edited?.request.text === "読む" && immediate?.request.text === "食べた" && gated
        && keyed?.request.text === "漢字" && clock.ids(220).length === 0
      || { rearmed, edited: edited?.request.text, immediate: immediate?.request.text, gated, keyed: keyed?.request.text };

    harness.emitOptions(settings);
    // A regression can leave lookups unanswered; the next reply must be the Note view's.
    harness.pending.splice(0);
    await harness.initialLookup();
    hover(word("読む"));
    const armedBeforeNote = clock.ids(220).length === 1;
    harness.edit(true);
    hover(word("漢字"));
    const drafting = harness.driver.snapshot();
    result["opening a Note cancels a dwell and keeps the draft's popup through later hovers"] =
      armedBeforeNote && clock.ids(220).length === 0 && drafting.noteEditing && !drafting.popupHidden
        && harness.take("hd_lookup") === null || { armedBeforeNote, drafting };
    harness.edit(false);

    hover(word("読む"));
    const armedBeforeTeardown = clock.ids(220).length === 1;
    harness.driver.teardown();
    result["teardown cancels a dwell"] = armedBeforeTeardown && !clock.fire(220) && harness.take("hd_lookup") === null;
  } finally {
    harness.close();
  }
  return result;
}

// Issue #503: definitions may wait on their own delay while page lookups
// stay immediate. Same as page delay (null) follows later page edits, a
// custom 0 is immediate, and links and clicks never wait. Each move in a
// pane reaches the page's capture listener first, as it does in Chrome.
async function definitionScanDelayCase() {
  const result = {};
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const document = window.document;
  const clock = dwellClock(window);
  const host = harness.popup.getRootNode().host;
  const settings = { lookupMode: "hover", scanDelayMs: 0, definitionScanDelayMs: 330, popupNestingMaxDepth: 2 };
  function glossary(text, depth = 0) {
    const content = document.createElement("div");
    content.className = "gsm-hoshidicts-glossary-content";
    const term = document.createElement("span");
    term.textContent = text;
    content.append(document.createTextNode("説明："), term, document.createTextNode("です。"));
    harness.driver.popupAt(depth).querySelector(".gsm-hoshidicts-definitions").append(content);
    return term;
  }
  function point(term, depth = 0, clientX = 120) {
    document.caretPositionFromPoint = () => ({ offsetNode: term.firstChild, offset: 0 });
    harness.driver.onMouseMove({ clientX, clientY: 80, target: host });
    harness.driver.onPopupMouseMove({ clientX, clientY: 80, target: term }, depth);
    clock.flush();
  }
  const lookups = () => harness.sent.filter((request) => request.type === "hd_lookup").length;
  const answer = async (request, expression) => {
    if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term(expression)] });
    await harness.settle();
  };
  try {
    harness.emitOptions(settings);
    harness.driver.setScanCandidate(harness.candidate);
    harness.driver.onMouseMove({ clientX: 300, clientY: 300, target: harness.anchor });
    clock.flush();
    const page = harness.take("hd_lookup");
    await answer(page, harness.candidate.query);
    const word = glossary("食用語");
    point(word);
    const waiting = lookups() === 1 && clock.ids(330).length === 1;
    const [dwell] = clock.ids(330);
    point(word, 0, 123);
    const kept = clock.ids(330).length === 1 && clock.ids(330)[0] === dwell && lookups() === 1;
    clock.fire(330);
    const child = harness.take("hd_lookup");
    await answer(child, "食用語");
    result["page lookups stay immediate while definition text waits for its own delay"] =
      page?.request.text === harness.candidate.query && waiting && kept
        && child?.request.text.startsWith("食用語") === true && !harness.driver.snapshot(1).popupHidden
      || { page: page?.request.text, waiting, kept, child: child?.request.text };

    const nested = glossary("用語集", 1);
    point(nested, 1);
    const nestedWaiting = clock.ids(330).length === 1 && lookups() === 2;
    clock.fire(330);
    const grandchild = harness.take("hd_lookup");
    await answer(grandchild, "用語集");
    point(glossary("最深部", 2), 2);
    result["the definition delay holds at depth two and the depth limit still stops scanning"] =
      nestedWaiting && grandchild?.request.text.startsWith("用語集") === true
        && !harness.driver.snapshot(2).popupHidden && clock.ids(330).length === 0 && lookups() === 3
      || { nestedWaiting, grandchild: grandchild?.request.text, lookups: lookups() };

    const inheriting = glossary("別用語");
    harness.emitOptions({ ...settings, scanDelayMs: 220, definitionScanDelayMs: null });
    point(inheriting);
    const inherited = clock.ids(220).length === 1;
    harness.emitOptions({ ...settings, scanDelayMs: 110, definitionScanDelayMs: null });
    clock.flush();
    const followed = clock.ids(220).length === 0 && clock.ids(110).length === 1;
    harness.emitOptions({ ...settings, scanDelayMs: 110, definitionScanDelayMs: 0 });
    clock.flush();
    const custom = harness.take("hd_lookup");
    result["Same as page delay follows later page edits and a custom 0 looks up at once"] =
      inherited && followed && custom?.request.text.startsWith("別用語") === true && clock.ids(110).length === 0
      || { inherited, followed, custom: custom?.request.text };
    await answer(custom, "別用語");

    harness.emitOptions(settings);
    const link = document.createElement("a");
    link.textContent = "辞書";
    word.parentElement.append(link);
    void harness.render().context.onInternalLink({ anchor: link, query: "辞書" });
    const linked = harness.take("hd_lookup");
    await answer(linked, "辞書");
    harness.emitOptions({ ...settings, definitionLookupMode: "click" });
    document.caretPositionFromPoint = () => ({ offsetNode: word.firstChild, offset: 0 });
    for (const type of ["mousedown", "click"]) {
      word.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, clientX: 120, clientY: 80 }));
    }
    const clicked = harness.take("hd_lookup");
    await answer(clicked, "食用語");
    harness.emitOptions({ ...settings, definitionLookupMode: "activation" });
    const held = glossary("熟語");
    point(held);
    const gated = clock.ids(330).length === 0 && harness.take("hd_lookup") === null;
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true, bubbles: true }));
    clock.flush();
    const keyed = harness.take("hd_lookup");
    document.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", bubbles: true }));
    await answer(keyed, "熟語");
    result["dictionary links, clicked words and a held activation key open their child at once"] =
      linked?.request.text === "辞書" && clicked?.request.text.startsWith("食用語") === true && gated
        && keyed?.request.text.startsWith("熟語") === true && clock.ids(330).length === 0
      || { linked: linked?.request.text, clicked: clicked?.request.text, gated, keyed: keyed?.request.text };

    const cancellations = {};
    for (const [reason, cancel] of Object.entries({
      "leaving the pane": () => harness.driver.popupAt(0).dispatchEvent(new window.MouseEvent("mouseleave")),
      "Note editing": () => { harness.edit(true); harness.edit(false); },
      "key mode": () => harness.emitOptions({ ...settings, definitionLookupMode: "activation" }),
      // Back and Note refreshes redraw the definitions under a resting pointer.
      "a redrawn word": () => {
        const redrawn = glossary("語彙");
        document.caretPositionFromPoint = () => ({ offsetNode: redrawn.firstChild, offset: 0 });
      },
      "an ancestor press": () => harness.driver.popupAt(0).dispatchEvent(
        new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 120, clientY: 80 })),
    })) {
      harness.emitOptions(settings);
      point(glossary("語彙"));
      const armed = clock.ids(330).length === 1;
      const before = lookups();
      cancel();
      clock.fire(330);
      cancellations[reason] = armed && lookups() === before && clock.ids(330).length === 0;
    }
    result["leaving the pane, Note editing, a key mode change, a redraw and an ancestor press cancel a definition dwell"] =
      Object.values(cancellations).every(Boolean) || cancellations;
  } finally {
    harness.close();
  }
  return result;
}

// Issue #363: Yomitan's "Hide popup on cursor exit" in the default sticky
// mode. The popup hides once the pointer has been inside it and left, after
// the option's own delay, unless a draft, an audio menu or a resize keeps it.
async function cursorExitCase() {
  const harness = await createHarness();
  const { driver } = harness;
  const window = harness.popup.ownerDocument.defaultView;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  window.clearTimeout = (id) => timers.delete(id);
  const fire = (delay) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    if (!entry) return false;
    timers.delete(entry[0]);
    entry[1].callback();
    return true;
  };
  const page = window.document.body;
  const shown = () => !driver.snapshot().popupHidden;
  const enter = () => harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
  const leave = (relatedTarget = page) => harness.popup.dispatchEvent(new window.MouseEvent("mouseleave", { relatedTarget }));
  const pageMove = () => driver.onMouseMove({ target: page, clientX: 900, clientY: 700, buttons: 0 });
  // The pointer enters the popup and leaves it for the page.
  const exit = () => { enter(); leave(); pageMove(); };
  const shift = (type) => window.document.dispatchEvent(new window.KeyboardEvent(type,
    { key: "Shift", code: "ShiftLeft", shiftKey: type === "keydown", bubbles: true }));
  const settings = { lookupMode: "activationSticky", hidePopupOnCursorExit: true, hidePopupOnCursorExitDelayMs: 500 };
  try {
    harness.emitOptions(settings);
    await harness.initialLookup();
    pageMove();
    leave();
    driver.onMouseOut({ relatedTarget: null });
    const neverEntered = shown() && !driver.cursorExitTimerPending();
    exit();
    const delayed = [...timers.values()].some((timer) => timer.delay === 500);
    const leftPage = delayed && fire(500) && !shown();
    await harness.initialLookup();
    exit();
    enter();
    const reentered = !driver.cursorExitTimerPending() && shown();
    leave(null);
    driver.onMouseOut({ relatedTarget: null });
    const leftWindow = fire(500) && !shown();

    // A new lookup replaces the popup; the old timer cannot hide it.
    await harness.initialLookup();
    exit();
    driver.setScanCandidate({ ...harness.candidate, query: "新しい" });
    shift("keydown");
    fire(0);
    const replacement = harness.take("hd_lookup");
    shift("keyup");
    const replacing = replacement !== null && !driver.cursorExitTimerPending();
    if (replacement) harness.reply(replacement, { dictionaryCount: 1, results: [harness.term("新しい")] });
    await harness.settle();
    const replaced = replacing && shown();
    // Scanning the popup's own word again keeps it.
    exit();
    shift("keydown");
    fire(0);
    shift("keyup");
    const ownWord = harness.take("hd_lookup") === null && !driver.cursorExitTimerPending() && shown();

    harness.edit(true);
    exit();
    const draftKept = fire(500) && shown() && driver.snapshot().noteEditing;
    harness.edit(false);
    const audioButton = harness.popup.querySelector(".gsm-hoshidicts-audio-button");
    audioButton.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const menu = harness.popup.querySelector(".gsm-hoshidicts-audio-choices");
    exit();
    const menuKept = menu !== null && fire(500) && shown();
    // Closing the menu refocuses its button, like the focus a mouse click
    // leaves on a popup button; that focus does not keep the popup.
    menu?.querySelector(".gsm-hoshidicts-audio-menu-close").click();
    const buttonFocused = harness.popup.getRootNode().activeElement === audioButton;
    exit();
    const buttonHidden = buttonFocused && fire(500) && !shown();
    await harness.initialLookup();
    const handle = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }),
      setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
    enter();
    harness.callbacks().onResizeStart({ button: 0, pointerId: 1, clientX: 0, clientY: 0, currentTarget: handle,
      preventDefault() {} });
    leave();
    const resizeKept = !driver.cursorExitTimerPending();
    harness.callbacks().onResizeEnd();

    // Live edits: a new delay restarts a pending exit; switching off stops it.
    exit();
    harness.emitOptions({ ...settings, hidePopupOnCursorExitDelayMs: 250 });
    const restarted = !fire(500) && [...timers.values()].some((timer) => timer.delay === 250);
    harness.emitOptions({ ...settings, hidePopupOnCursorExit: false });
    const stopped = restarted && !driver.cursorExitTimerPending() && shown();
    exit();
    const off = stopped && !driver.cursorExitTimerPending() && shown();
    return {
      "hide popup on cursor exit hides a sticky popup the pointer left, after its own delay, and keeps one never entered":
        (neverEntered && leftPage && reentered && leftWindow && replaced && ownWord)
        || { neverEntered, leftPage, reentered, leftWindow, replaced, ownWord },
      "hide popup on cursor exit spares drafts, audio menus and resizing but not a mouse-focused button, and applies live":
        (draftKept && menuKept && buttonHidden && resizeKept && off)
        || { draftKept, menuKept, buttonHidden, resizeKept, restarted, stopped, off },
    };
  } finally {
    harness.close();
  }
}

// Issue #403: an overlay host toggles click-through and hands focus to the
// game as the pointer crosses OCR text, which reaches the reader as window
// blur and a window-exit mouseout. Neither is the reader leaving the page.
async function overlayDepartureCase() {
  const harness = await createHarness();
  const { driver } = harness;
  const window = harness.popup.ownerDocument.defaultView;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  window.clearTimeout = (id) => timers.delete(id);
  const fire = (delay) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    if (!entry) return false;
    timers.delete(entry[0]);
    entry[1].callback();
    return true;
  };
  const shown = () => !driver.snapshot().popupHidden;
  const events = () => harness.popupEvents.splice(0);
  const mouse = (type, init = {}, target = harness.anchor) => target.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, clientX: 200, clientY: 200, ...init }));
  const escape = () => window.document.dispatchEvent(new window.KeyboardEvent("keydown",
    { key: "Escape", code: "Escape", bubbles: true }));
  const answer = async () => {
    const lookup = harness.take("hd_lookup");
    if (lookup) harness.reply(lookup, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
    await harness.settle();
    return lookup;
  };
  const base = { popupHideDelayMs: 250, hidePopupOnCursorExit: false };
  const result = {};
  try {
    await harness.settle();
    driver.setOverlayMode(true);
    driver.setScanCandidate(harness.candidate);

    const kept = {};
    for (const lookupMode of ["hover", "activation", "activationSticky"]) {
      harness.emitOptions({ ...base, lookupMode });
      await harness.initialLookup();
      events();
      window.dispatchEvent(new window.Event("blur"));
      driver.onMouseOut({ relatedTarget: null });
      const noTimer = !fire(250) && !driver.hideTimerPending();
      const survived = shown() && noTimer && events().length === 0;
      escape();
      kept[lookupMode] = survived && !shown();
    }
    result["overlay blur and window-exit keep a rendered popup in every lookup mode until Escape"] =
      Object.values(kept).every(Boolean) || kept;

    // A pending hover scan is still cancelled by the window-exit mouseout.
    harness.emitOptions({ ...base, lookupMode: "hover" });
    mouse("mousemove", { buttons: 0 });
    driver.onMouseOut({ relatedTarget: null });
    const scanCancelled = !fire(0) && harness.take("hd_lookup") === null;
    // Outside click and a new lookup still close or replace it.
    await harness.initialLookup();
    const page = window.document.body;
    mouse("mousedown", { button: 0, buttons: 1, clientX: 900, clientY: 700 }, page);
    mouse("mouseup", { button: 0, buttons: 0, clientX: 900, clientY: 700 }, page);
    await harness.settle();
    const clickClosed = !shown();
    await harness.initialLookup();
    driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
    mouse("mousemove", { buttons: 0, clientX: 220 });
    fire(0);
    const replaced = (await answer())?.request.text === "別の語" && shown();
    escape();
    driver.setScanCandidate(harness.candidate);
    result["overlay window-exit cancels a pending scan; outside click and a new lookup still dismiss"] =
      (scanCancelled && clickClosed && replaced) || { scanCancelled, clickClosed, replaced };

    // A selection drag keeps the host window across a host-caused blur.
    events();
    mouse("mousedown", { button: 0, buttons: 1 });
    const claimed = events();
    window.dispatchEvent(new window.Event("blur"));
    const dragKept = driver.selectionDragging() && events().length === 0;
    mouse("mouseup", { button: 0, buttons: 0 });
    await harness.settle();
    while (harness.take("hd_lookup")) { /* The release's own lookup is not under test. */ }
    escape();
    events();

    // So does a held scan button, which keeps scanning after the blur.
    harness.emitOptions({ ...base, lookupMode: "activation", activationKey: "MouseMiddle" });
    mouse("mousedown", { button: 1, buttons: 4 });
    fire(0);
    const pressed = await answer();
    events();
    window.dispatchEvent(new window.Event("blur"));
    const buttonKept = shown() && events().length === 0;
    driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
    mouse("mousemove", { buttons: 4, clientX: 230 });
    fire(0);
    const stillScanning = (await answer())?.request.text === "別の語";
    mouse("mouseup", { button: 1, buttons: 0 });
    result["overlay blur keeps a selection drag and a held scan button without publishing popup-hidden"] =
      (JSON.stringify(claimed) === '["shown"]' && dragKept && pressed !== null && buttonKept && stillScanning)
      || { claimed, dragKept, pressed: pressed !== null, buttonKept, stillScanning };
  } finally {
    harness.close();
  }
  return result;
}

// Issue #432: as in Yomitan, leaving the tab, the window or the browser is
// not a dismissal in a browser tab either. jsdom's hasFocus() follows its
// last focused element, so each blur says whether focus stayed in the page.
async function browserDepartureCase() {
  const harness = await createHarness();
  const { driver } = harness;
  const window = harness.popup.ownerDocument.defaultView;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  window.clearTimeout = (id) => timers.delete(id);
  const fire = (delay) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    if (!entry) return false;
    timers.delete(entry[0]);
    entry[1].callback();
    return true;
  };
  const shown = () => !driver.snapshot().popupHidden;
  const editing = () => driver.snapshot().noteEditing;
  const events = () => harness.popupEvents.splice(0);
  const escape = () => window.document.dispatchEvent(new window.KeyboardEvent("keydown",
    { key: "Escape", code: "Escape", bubbles: true }));
  const blur = (focusInPage) => {
    window.document.hasFocus = () => focusInPage;
    window.dispatchEvent(new window.Event("blur"));
  };
  const result = {};
  try {
    await harness.settle();
    const kept = {};
    for (const lookupMode of ["hover", "activation", "activationSticky"]) {
      harness.emitOptions({ popupHideDelayMs: 250, hidePopupOnCursorExit: false, lookupMode });
      for (const draft of [false, true]) {
        await harness.initialLookup();
        if (draft) harness.edit(true);
        events();
        // Another tab, window or application takes focus and the pointer leaves the window.
        blur(false);
        driver.onMouseOut({ relatedTarget: null });
        const survived = shown() && editing() === draft && !fire(250) && !driver.hideTimerPending()
          && events().length === 0;
        // Escape closes the Note first, then the popup.
        harness.setCloseNext(draft);
        escape();
        const noteFirst = !draft || (shown() && !editing());
        if (draft) escape();
        kept[draft ? `${lookupMode} with a Note draft` : lookupMode] = survived && noteFirst && !shown();
      }
    }
    result["leaving the tab or the window keeps a popup and its Note draft in every lookup mode until Escape"] =
      Object.values(kept).every(Boolean) || kept;

    // Focus moving into one of the page's own frames is a click outside the popup.
    await harness.initialLookup();
    harness.edit(true);
    events();
    blur(true);
    const published = events();
    result["a blur that moves focus into one of the page's frames still closes the popup"] =
      (!shown() && !editing() && JSON.stringify(published) === '["hidden"]')
      || { shown: shown(), editing: editing(), published };
  } finally {
    harness.close();
  }
  return result;
}

// Issue #357: a held mouse button scans as a held key does. Its capture-phase
// press claims an overlay host's window, and it cancels only the native
// actions that would act on the same press.
async function activationButtonCase() {
  const result = {};
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const { document } = window;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const fire = (delay) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    if (!entry) return false;
    timers.delete(entry[0]);
    entry[1].callback();
    return true;
  };
  // Real events through the reader's document listeners; the caller reads
  // defaultPrevented from the returned event.
  const mouse = (type, init = {}, target = harness.anchor) => {
    const event = new window.MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: 200, clientY: 200, ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  const press = (button, buttons, target) => mouse("mousedown", { button, buttons }, target);
  const release = (button, target) => mouse("mouseup", { button, buttons: 0 }, target);
  const events = () => harness.popupEvents.splice(0);
  const answer = async (query) => {
    const lookup = harness.take("hd_lookup");
    if (lookup) harness.reply(lookup, { dictionaryCount: 1, results: [harness.term(query)] });
    await harness.settle();
    return lookup;
  };
  const reset = (settings) => {
    harness.emitOptions({ popupHideDelayMs: 250, ...settings });
    // Blur releases the scan input; leaving the tab no longer closes the popup (#432).
    harness.driver.onWindowBlur();
    harness.driver.hide();
    while (harness.take("hd_lookup")) { /* A reset drops unanswered lookups. */ }
    harness.driver.setScanCandidate(harness.candidate);
    events();
  };
  try {
    let wordClick = null;
    for (const lookupMode of ["activation", "activationSticky"]) {
      reset({ lookupMode, activationKey: "MouseMiddle" });
      mouse("mousemove", { buttons: 0 });
      fire(0);
      const gated = harness.take("hd_lookup") === null;
      let atBubble = null;
      const observe = (event) => { atBubble = { events: [...harness.popupEvents], prevented: event.defaultPrevented }; };
      document.addEventListener("mousedown", observe);
      press(1, 4);
      document.removeEventListener("mousedown", observe);
      fire(0);
      const first = await answer("食べる");
      const opened = !harness.driver.snapshot().popupHidden;
      harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
      mouse("mousemove", { buttons: 4, clientX: 220 });
      fire(0);
      const moved = await answer("別の語");
      const released = release(1);
      wordClick = mouse("auxclick", { button: 1 });
      const keptAtRelease = !harness.driver.snapshot().popupHidden;
      const hidTimer = fire(250);
      const closed = lookupMode === "activation"
        ? hidTimer && harness.driver.snapshot().popupHidden
        : !hidTimer && !harness.driver.snapshot().popupHidden;
      const published = events();
      result[`a held middle button scans in ${lookupMode} mode and its release follows the mode`] =
        (gated && JSON.stringify(atBubble) === JSON.stringify({ events: ["shown"], prevented: true })
          && first !== null && opened && moved !== null && !released.defaultPrevented && keptAtRelease && closed
          && JSON.stringify(published) === JSON.stringify(lookupMode === "activation" ? ["shown", "hidden"] : ["shown"]))
        || { gated, atBubble, first: first !== null, opened, moved: moved !== null,
          releasePrevented: released.defaultPrevented, keptAtRelease, hidTimer, closed, published };
    }

    reset({ lookupMode: "activation", activationKey: "MouseMiddle" });
    harness.driver.setScanCandidate(null);
    const emptyPress = press(1, 4);
    const claimed = events();
    fire(0);
    const noLookup = harness.take("hd_lookup") === null;
    mouse("mousemove", { buttons: 0, clientX: 210 });
    const unclaimed = events();
    release(1);
    const emptyClick = mouse("auxclick", { button: 1 });
    result["a lost release ends a button's activation at the next move and releases the host window"] =
      (JSON.stringify(claimed) === '["shown"]' && noLookup && JSON.stringify(unclaimed) === '["hidden"]'
        && events().length === 0) || { claimed, noLookup, unclaimed };
    result["a scan press cancels autoscroll over text and a new tab only for a word it looks up"] =
      (emptyPress.defaultPrevented && !emptyClick.defaultPrevented && wordClick?.defaultPrevented === true)
      || { emptyPress: emptyPress.defaultPrevented, emptyClick: emptyClick.defaultPrevented,
        wordClick: wordClick?.defaultPrevented };

    reset({ lookupMode: "activationSticky", activationKey: "MouseBack" });
    const backPress = press(3, 8);
    fire(0);
    const backLookup = await answer("食べる");
    const backRelease = release(3);
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    harness.driver.setScanCandidate(null);
    const fieldPress = press(3, 8, field);
    const fieldRelease = release(3, field);
    harness.driver.setScanCandidate(harness.candidate);
    harness.driver.hide();
    press(3, 8);
    fire(0);
    const besideEditor = await answer("食べた");
    release(3);
    field.remove();
    result["a Back scan press looks up beside a focused editor without navigating over text"] =
      (backPress.defaultPrevented && backLookup !== null && backRelease.defaultPrevented
        && !fieldPress.defaultPrevented && !fieldRelease.defaultPrevented && besideEditor !== null)
      || { backPress: backPress.defaultPrevented, backLookup: backLookup !== null,
        backRelease: backRelease.defaultPrevented, fieldPress: fieldPress.defaultPrevented,
        fieldRelease: fieldRelease.defaultPrevented, besideEditor: besideEditor !== null };

    reset({ lookupMode: "activationSticky", activationKey: "MouseMiddle" });
    press(1, 4);
    fire(0);
    await answer("食べた");
    release(1);
    mouse("auxclick", { button: 1 });
    const glossary = document.createElement("div");
    glossary.className = "gsm-hoshidicts-glossary-content";
    const definition = document.createElement("span");
    definition.textContent = "食用語";
    const link = document.createElement("a");
    link.href = "https://example.test/entry";
    link.textContent = "entry";
    glossary.append(definition, link);
    harness.driver.popupAt(0).querySelector(".gsm-hoshidicts-definitions").append(glossary);
    document.caretPositionFromPoint = () => ({ offsetNode: definition.firstChild, offset: 0 });
    harness.driver.onPopupMouseMove({ clientX: 120, clientY: 80, target: definition });
    fire(0);
    const definitionGated = harness.take("hd_lookup") === null;
    const definitionPress = press(1, 4, definition);
    fire(0);
    const child = await answer("食用語");
    const childOpened = !harness.driver.snapshot(1).popupHidden;
    release(1, definition);
    const definitionClick = mouse("auxclick", { button: 1 }, definition);
    harness.driver.onPopupMouseMove({ clientX: 120, clientY: 80, target: link });
    const linkPress = press(1, 4, link);
    const linkScan = fire(0);
    release(1, link);
    const linkClick = mouse("auxclick", { button: 1 }, link);
    result["a held scan button looks up popup definitions and leaves a popup link its middle click"] =
      (definitionGated && definitionPress.defaultPrevented && child?.request.text.startsWith("食用語")
        && childOpened && definitionClick.defaultPrevented
        && !linkPress.defaultPrevented && !linkScan && !linkClick.defaultPrevented)
      || { definitionGated, definitionPress: definitionPress.defaultPrevented, child: child?.request.text,
        childOpened, definitionClick: definitionClick.defaultPrevented, linkPress: linkPress.defaultPrevented,
        linkScan, linkClick: linkClick.defaultPrevented };

    const ordinary = [];
    for (const settings of [{ lookupMode: "hover", activationKey: "MouseMiddle" },
      { lookupMode: "activation", activationKey: "Shift" }]) {
      reset(settings);
      await harness.initialLookup();
      events();
      const middle = press(1, 4);
      const up = release(1);
      const click = mouse("auxclick", { button: 1 });
      ordinary.push((!middle.defaultPrevented && !up.defaultPrevented && !click.defaultPrevented
        && harness.driver.snapshot().popupHidden && JSON.stringify(events()) === '["hidden"]')
        || { settings, middle: middle.defaultPrevented, up: up.defaultPrevented, click: click.defaultPrevented,
          hidden: harness.driver.snapshot().popupHidden });
    }
    result["hover mode and keyboard activation keep a middle press closing the popup without cancelling it"] =
      ordinary.every((value) => value === true) || ordinary;

    // Issue #355's Child popups wait for the scan button as for a key: in No
    // key mode only a press over a popup's definitions is a scan press, and
    // with Click none is.
    const addDefinition = () => {
      const words = document.createElement("div");
      words.className = "gsm-hoshidicts-glossary-content";
      const word = document.createElement("span");
      word.textContent = "食用語";
      words.append(word);
      harness.driver.popupAt(0).querySelector(".gsm-hoshidicts-definitions").append(words);
      document.caretPositionFromPoint = () => ({ offsetNode: word.firstChild, offset: 0 });
      harness.driver.onPopupMouseMove({ clientX: 120, clientY: 80, target: word });
      return word;
    };
    reset({ lookupMode: "hover", activationKey: "MouseMiddle", definitionLookupMode: "activation" });
    mouse("mousemove", { buttons: 0 });
    fire(0);
    const pageHover = await answer("食べた");
    const heldWord = addDefinition();
    fire(0);
    const childGated = harness.take("hd_lookup") === null;
    const childPress = press(1, 4, heldWord);
    fire(0);
    const heldChild = await answer("食用語");
    release(1, heldWord);
    const childClick = mouse("auxclick", { button: 1 }, heldWord);
    const pagePress = press(1, 4);
    release(1);
    const pageClick = mouse("auxclick", { button: 1 });
    const pageClosed = harness.driver.snapshot().popupHidden;
    events();
    const idlePress = press(1, 4);
    release(1);
    fire(0);
    const idle = { prevented: idlePress.defaultPrevented, events: events(), lookup: harness.take("hd_lookup") };
    reset({ lookupMode: "activationSticky", activationKey: "MouseMiddle", definitionLookupMode: "click" });
    press(1, 4);
    fire(0);
    await answer("食べた");
    release(1);
    mouse("auxclick", { button: 1 });
    const clickWord = addDefinition();
    const clickPress = press(1, 4, clickWord);
    fire(0);
    const clickLookup = harness.take("hd_lookup");
    release(1, clickWord);
    result["child popups set to hold the key wait for a scan button in No key mode, and Click ignores it"] =
      (pageHover !== null && childGated && childPress.defaultPrevented && heldChild?.request.text.startsWith("食用語")
        && childClick.defaultPrevented && !pagePress.defaultPrevented && !pageClick.defaultPrevented && pageClosed
        && !idle.prevented && idle.events.length === 0 && idle.lookup === null
        && !clickPress.defaultPrevented && clickLookup === null)
      || { pageHover: pageHover !== null, childGated, childPress: childPress.defaultPrevented,
        heldChild: heldChild?.request.text, childClick: childClick.defaultPrevented,
        pagePress: pagePress.defaultPrevented, pageClick: pageClick.defaultPrevented, pageClosed,
        idle: { ...idle, lookup: idle.lookup !== null }, clickPress: clickPress.defaultPrevented,
        clickLookup: clickLookup !== null };
  } finally {
    harness.close();
  }
  return result;
}

async function keybindCase() {
  const result = {};
  const press = (harness, code, key, init = {}) => {
    const window = harness.popup.ownerDocument.defaultView;
    const event = new window.KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...init });
    window.document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const defaults = await createHarness();
  try {
    const window = defaults.popup.ownerDocument.defaultView;
    await defaults.initialLookup();
    const moved = [["ArrowDown", "ArrowDown"], ["PageUp", "PageUp"], ["Home", "Home"], ["End", "End"]]
      .map(([code, key]) => press(defaults, code, key, { altKey: true }));
    const unmodified = press(defaults, "ArrowDown", "ArrowDown");
    const actions = window.document.createElement("div");
    const mine = window.document.createElement("button");
    mine.className = "gsm-hoshidicts-mine-button";
    mine.dataset.action = "add";
    actions.append(mine);
    defaults.popup.append(actions);
    let mined = 0;
    mine.addEventListener("click", () => { mined += 1; });
    const audioButton = defaults.popup.querySelector(".gsm-hoshidicts-audio-button");
    defaults.callbacks().onResultsRendered({ audioButtons: [{ button: audioButton, result: defaults.render().results[0] }],
      miningActions: [{ actions, feedback: null, result: defaults.render().results[0] }] });
    const added = press(defaults, "KeyE", "e", { altKey: true });
    // View notes only presses the Anki button while it opens Anki, never while it adds.
    const viewedAdd = press(defaults, "KeyV", "v", { altKey: true });
    const played = press(defaults, "KeyP", "p", { altKey: true }) && defaults.take("hd_audio_play") !== null;
    const command = action => defaults.runtimeMessage({ target: "hachidori-reader", type: "hd_reader_command", action });
    command("nextEntry");
    command("addNote");
    command("addNote");
    const commandFocus = JSON.stringify(defaults.entryFocus().slice(4)) === JSON.stringify([{ offset: 1 }]);
    command("close");
    const commandClosed = defaults.driver.snapshot().popupHidden;
    result["browser shortcut commands run popup keybind actions"] =
      (commandFocus && mined === 3 && commandClosed) || { focus: defaults.entryFocus(), mined, commandClosed };
    await defaults.initialLookup();
    const escaped = press(defaults, "Escape", "Escape") === false && defaults.driver.snapshot().popupHidden;
    result["default keybinds navigate entries, mine, play and close through Yomitan's keys"] =
      (JSON.stringify(defaults.entryFocus().slice(0, 4)) === JSON.stringify([{ offset: 1 }, { offset: -3 }, "first", "last"])
        && moved.every(Boolean) && !unmodified && added && mined >= 1 && !viewedAdd && played && escaped)
      || { focus: defaults.entryFocus(), moved, unmodified, added, mined, viewedAdd, played, escaped };
  } finally {
    defaults.close();
  }

  const bind = (action, key, modifiers, scopes = ["popup"], extra = {}) =>
    ({ action, argument: "", key, modifiers, scopes, enabled: true, ...extra });
  const custom = await createHarness(undefined, { options: { keybinds: [
    bind("close", "KeyQ", ["alt"]),
    bind("firstEntry", "KeyJ", []),
    bind("lastEntry", "KeyK", [], ["popup"], { enabled: false }),
    bind("toggleOption", "KeyT", ["alt", "shift"], ["web"], { argument: "showLookupCounts" }),
    bind("scanSelectedText", "KeyS", ["alt"], ["web"]),
    bind("scanTextAtSelection", "KeyD", ["alt"], ["web"]),
  ] } });
  try {
    const window = custom.popup.ownerDocument.defaultView;
    await custom.initialLookup();
    const escapeUnbound = !press(custom, "Escape", "Escape") && !custom.driver.snapshot().popupHidden;
    const input = window.document.createElement("input");
    window.document.body.append(input);
    input.focus();
    const typed = !press(custom, "KeyJ", "j") && custom.entryFocus().length === 0;
    input.blur();
    const bare = press(custom, "KeyJ", "j") && custom.entryFocus().length === 1;
    const disabled = !press(custom, "KeyK", "k") && custom.entryFocus().length === 1;
    const toggled = press(custom, "KeyT", "T", { altKey: true, shiftKey: true });
    const write = custom.take("hd_options_write");
    press(custom, "KeyQ", "q", { altKey: true });
    const closed = custom.driver.snapshot().popupHidden;
    const popupScoped = !press(custom, "KeyJ", "j") && custom.entryFocus().length === 1;
    const selection = window.getSelection();
    selection.selectAllChildren(custom.anchor);
    const scanned = press(custom, "KeyS", "s", { altKey: true });
    const exact = custom.take("hd_lookup");
    if (exact) custom.reply(exact, { dictionaryCount: 1, results: [custom.term("食べた")] });
    await custom.settle();
    selection.setBaseAndExtent(custom.anchor.firstChild, 1, custom.anchor.firstChild, 2);
    const scannedAt = press(custom, "KeyD", "d", { altKey: true });
    const expanded = custom.take("hd_lookup");
    if (expanded) custom.reply(expanded, { dictionaryCount: 1, results: [custom.term("べた")] });
    await custom.settle();
    custom.driver.onMouseMove({ target: custom.anchor, clientX: 20, clientY: 20 });
    await custom.settle();
    const retained = custom.take("hd_lookup") === null && !custom.driver.snapshot().popupHidden;
    result["custom keybinds follow scope, enablement, text fields, option writes and selection scans"] =
      (escapeUnbound && typed && bare && disabled && toggled && write?.request.target === "hoshidicts-worker"
        && write.request.options.showLookupCounts === false && Number.isInteger(write.request.baseRevision)
        && closed && popupScoped && scanned && exact?.request.text === "食べた"
        && scannedAt && expanded?.request.text === "べた" && retained)
      || { escapeUnbound, typed, bare, disabled, toggled, write: write?.request, closed, popupScoped, scanned,
        exact: exact?.request.text, scannedAt, expanded: expanded?.request.text, retained };
  } finally {
    custom.close();
  }
  return result;
}

// Yomitan's Alt+wheel entry moves, as Alt+WheelDown/WheelUp keybinds: one
// press per notch, a touchpad's small steps gathered into notches, acting on
// the popup under the pointer and leaving the page nothing to scroll.
async function wheelKeybindCase() {
  const result = {};
  const wheel = (harness, target, deltaY, timeStamp, init = { altKey: true }) => {
    const window = harness.popup.ownerDocument.defaultView;
    const event = new window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, composed: true, ...init });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const defaults = await createHarness();
  try {
    const window = defaults.popup.ownerDocument.defaultView;
    let pageWheels = 0;
    window.document.body.addEventListener("wheel", () => { pageWheels += 1; });
    await defaults.initialLookup();
    const moves = (depth = 0) => defaults.entryFocus(depth).length;
    const notch = wheel(defaults, defaults.popup, 4, 1000) && moves() === 1;
    let swallowed = true;
    for (let step = 1; step < 25; step += 1) swallowed = wheel(defaults, defaults.popup, 4, 1000 + step * 10) && swallowed;
    const gathered = swallowed && moves() === 1;
    const nextNotch = wheel(defaults, defaults.popup, 4, 1250) && moves() === 2;
    const afterPause = wheel(defaults, defaults.popup, 4, 1400) && moves() === 3;
    const reversed = wheel(defaults, defaults.popup, -4, 1410) && moves() === 4;
    const travelled = wheel(defaults, defaults.popup, -300, 1420) && moves() === 7;
    const directions = JSON.stringify(defaults.entryFocus().map(target => target.offset)) === "[1,1,1,-1,-1,-1,-1]";
    wheel(defaults, defaults.popup, 100, 1600, {});
    const zoom = !wheel(defaults, defaults.popup, 100, 1800, { ctrlKey: true });
    const unbound = moves() === 7;
    const link = defaults.internalLink({ query: "child", primaryReading: "reading" });
    defaults.reply(defaults.take("hd_lookup"), { dictionaryCount: 1, results: [defaults.term("child")] });
    await link;
    const child = defaults.driver.popupAt(1);
    const childOnly = Boolean(child) && wheel(defaults, child, 4, 2000) && moves(1) === 1 && moves() === 7;
    const parentOwn = wheel(defaults, defaults.popup, 4, 2010) && moves() === 8 && moves(1) === 1;
    result["Alt+wheel keybinds press once per notch, gather touchpad steps and act on the popup under the pointer"] =
      (notch && gathered && nextNotch && afterPause && reversed && travelled && directions && unbound && zoom
        && childOnly && parentOwn && pageWheels === 0)
      || { notch, gathered, nextNotch, afterPause, reversed, travelled, directions, unbound, zoom, childOnly, parentOwn,
        pageWheels, focus: defaults.entryFocus(), childFocus: child ? defaults.entryFocus(1) : null };
  } finally {
    defaults.close();
  }

  const bind = (action, key, modifiers, extra = {}) =>
    ({ action, argument: "", key, modifiers, scopes: ["popup"], enabled: true, ...extra });
  const custom = await createHarness(undefined, { options: { keybinds: [
    bind("firstEntry", "WheelDown", ["ctrl"]),
    bind("nextEntry", "WheelDown", ["alt"], { argument: "1", enabled: false }),
  ] } });
  try {
    await custom.initialLookup();
    const remapped = wheel(custom, custom.popup, 100, 1000, { ctrlKey: true })
      && JSON.stringify(custom.entryFocus()) === JSON.stringify(["first"]);
    wheel(custom, custom.popup, 100, 1200);
    wheel(custom, custom.popup, -100, 1400);
    const zoom = !wheel(custom, custom.popup, -100, 1600, { ctrlKey: true });
    const unbound = custom.entryFocus().length === 1;
    result["custom wheel keybinds follow their modifiers and enablement, and unbound wheels keep scrolling"] =
      (remapped && zoom && unbound) || { remapped, zoom, unbound, focus: custom.entryFocus() };
  } finally {
    custom.close();
  }
  return result;
}

describe("content script: activation and keybinds", () => {
  test("activation, scan delays and departures", async () => {
    const noteContent = await contentNoteStage({
      activation: async () => ({ ...await activationCase(), ...await scanDelayCase(), ...await definitionScanDelayCase(),
        ...await cursorExitCase(), ...await activationButtonCase(),
        ...await overlayDepartureCase(), ...await browserDepartureCase() }),
    });
    for (const [name, passed] of Object.entries(noteContent?.activation ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });

  test("keybinds", async () => {
    const noteContent = await contentNoteStage({
      keybinds: async () => ({ ...await keybindCase(), ...await wheelKeybindCase() }),
    });
    for (const [name, passed] of Object.entries(noteContent?.keybinds ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });
});
