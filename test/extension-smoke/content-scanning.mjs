/*
 * The content script's scanning and selections.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { CUSTOM_DICTIONARY_TITLE } from "../../extension/custom-dictionary.js";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
import { genericPackage } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function selectionLanguageCase() {
  const outcomes = [];
  for (const onlyScanJapaneseText of [true, false]) {
    for (const query of ["hello", "hello world", "https://example.test", "食べる", "hello食べる"]) {
      const harness = await createHarness(undefined, { options: { onlyScanJapaneseText } });
      const window = harness.popup.ownerDocument.defaultView;
      // The following Japanese text must not make an English selection scannable.
      harness.anchor.textContent = query + "食べる";
      const selection = window.getSelection();
      selection.setBaseAndExtent(harness.anchor.firstChild, 0, harness.anchor.firstChild, query.length);
      const exact = harness.driver.resolveSelectedLookupCandidate();
      const scan = harness.driver.resolveSelectionScanCandidate();
      window.document.dispatchEvent(new window.Event("selectionchange"));
      const lookup = harness.take("hd_lookup");
      const allowed = !onlyScanJapaneseText || query.includes("食");
      if (lookup) harness.reply(lookup, { dictionaryCount: 1, results: [harness.term(query)] });
      await harness.settle();
      outcomes.push({ query, onlyScanJapaneseText, passed: Boolean(exact) === allowed
        && Boolean(scan) === allowed && Boolean(lookup) === allowed
        && harness.driver.snapshot().popupHidden === !allowed });
      harness.close();
    }
  }
  return { "both selection resolvers apply the Japanese gate to the selected text":
    outcomes.every(value => value.passed) || outcomes };
}

async function selectionNoticeCase() {
  const outcomes = [];
  for (const showNoResultNotice of [true, false]) {
    for (const dictionaryCount of [0, 1]) {
      const harness = await createHarness(undefined, { options: { showNoResultNotice } });
      const window = harness.popup.ownerDocument.defaultView;
      harness.anchor.textContent = "ぬるぽがっ";
      window.getSelection().selectAllChildren(harness.anchor);
      window.document.dispatchEvent(new window.Event("selectionchange"));
      const lookup = harness.take("hd_lookup");
      if (lookup) harness.reply(lookup, { dictionaryCount, results: [] });
      await harness.settle();
      const visible = dictionaryCount === 0 || showNoResultNotice;
      const missed = lookup !== null && harness.driver.snapshot().popupHidden === !visible
        && (!visible || (harness.render()?.kind === "notice"
          && harness.render().value.startsWith(dictionaryCount === 0
            ? "No dictionaries loaded." : "No definition found.")));
      // The miss keeps the unchanged selection, shown or hidden; a new selection looks up.
      harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
      const retained = harness.take("hd_lookup") === null;
      harness.anchor.textContent = "食べる";
      window.getSelection().selectAllChildren(harness.anchor);
      window.document.dispatchEvent(new window.Event("selectionchange"));
      const next = harness.take("hd_lookup");
      if (next) harness.reply(next, { dictionaryCount: 1, results: [harness.term("食べる")] });
      await harness.settle();
      outcomes.push({ showNoResultNotice, dictionaryCount, missed, retained,
        passed: missed && retained && next?.request.text === "食べる"
          && harness.render()?.kind === "terms" && !harness.driver.snapshot().popupHidden });
      harness.close();
    }
  }
  return { "selection miss notices are optional while the no-dictionaries notice stays visible":
    outcomes.every(value => value.passed) || outcomes };
}

// Issue #358: with the personal dictionary off, selections behave as in
// Yomitan; only the explicit keybinds look them up.
async function personalDictionaryOffCase() {
  const harness = await createHarness(undefined, { options: { personalDictionaryEnabled: false } });
  const window = harness.popup.ownerDocument.defaultView;
  const { document } = window;
  const selection = window.getSelection();
  const changed = () => document.dispatchEvent(new window.Event("selectionchange"));
  const mouse = (type, init = {}) => harness.anchor.dispatchEvent(new window.MouseEvent(type,
    { bubbles: true, button: 0, clientX: 200, clientY: 200, ...init }));
  const shift = type => document.dispatchEvent(new window.KeyboardEvent(type,
    { bubbles: true, code: "ShiftLeft", key: "Shift", shiftKey: type === "keydown" }));
  const scanSelected = () => harness.runtimeMessage({ target: "hachidori-reader", type: "hd_reader_command",
    action: "scanSelectedText" });
  const hidden = () => harness.driver.snapshot().popupHidden;
  const pencil = () => harness.popup.getRootNode().host.dataset.hoshidictsNoteButton;
  const off = { scanLength: 9, personalDictionaryEnabled: false,
    kanjiClickDictionary: { title: "Generic", kind: "term" } };
  const other = document.body.appendChild(document.createElement("span"));
  const result = {};

  // Hover mode: a selection change, a drag release and pointer motion away
  // from the text never look the selection up.
  harness.emitOptions({ ...off, lookupMode: "hover" });
  const automatic = [];
  for (const text of ["食べる", "日本語の文です"]) {
    other.textContent = text;
    selection.selectAllChildren(other);
    changed();
    mouse("mousedown");
    selection.selectAllChildren(other);
    mouse("mouseup");
    harness.driver.setScanCandidate(null);
    harness.driver.scanPointer({ target: document.body, clientX: 5, clientY: 5 });
    await harness.settle();
    automatic.push(harness.take("hd_lookup") === null && hidden());
  }
  // Both activation modes: the key held while the selection changes.
  for (const lookupMode of ["activation", "activationSticky"]) {
    harness.emitOptions({ ...off, lookupMode, activationKey: "Shift" });
    shift("keydown");
    mouse("mousedown", { shiftKey: true });
    selection.selectAllChildren(other);
    changed();
    mouse("mouseup", { shiftKey: true });
    shift("keyup");
    await harness.settle();
    automatic.push(harness.take("hd_lookup") === null && hidden());
  }
  harness.emitOptions({ ...off, lookupMode: "hover" });

  // The pointer over highlighted text gets an ordinary scan-length lookup.
  selection.selectAllChildren(harness.anchor);
  changed();
  const quietSelection = harness.take("hd_lookup") === null;
  harness.driver.setScanCandidate(harness.candidate);
  harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
  const pointer = harness.take("hd_lookup");
  if (pointer) harness.reply(pointer, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
  await harness.settle();
  result.pointer = quietSelection && pointer?.request.text === harness.candidate.query
    && pointer.request.scanLength === 9 && pointer.request.options?.personalDictionary === false
    && harness.render()?.kind === "terms" && !hidden() && pencil() === "hidden";
  harness.callbacks().onKanjiClick("食", null, null, null);
  const kanji = harness.take("hd_lookup_dictionary");
  result.kanji = kanji?.request.options?.personalDictionary === false;
  if (kanji) harness.reply(kanji, { dictionaryCount: 1, results: [] });
  await harness.settle();
  harness.driver.hide();

  // Scan selected text stays exact. Its miss closes without a notice and
  // leaves the pointer free; a changed selection releases its hit.
  scanSelected();
  const explicitMiss = harness.take("hd_lookup");
  if (explicitMiss) harness.reply(explicitMiss, { dictionaryCount: 1, results: [] });
  await harness.settle();
  const noticeFree = hidden() && harness.renders.every(render => render.kind !== "notice");
  harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
  const afterMiss = harness.take("hd_lookup");
  if (afterMiss) harness.reply(afterMiss, { dictionaryCount: 1, results: [] });
  await harness.settle();
  scanSelected();
  const explicitHit = harness.take("hd_lookup");
  if (explicitHit) harness.reply(explicitHit, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
  await harness.settle();
  const shown = !hidden();
  selection.selectAllChildren(other);
  changed();
  result.explicit = explicitMiss?.request.text === harness.candidate.query
    && explicitMiss.request.scanLength === Array.from(harness.candidate.query).length
    && noticeFree && afterMiss?.request.scanLength === 9
    && explicitHit?.request.text === harness.candidate.query && shown && hidden()
    && harness.take("hd_lookup") === null;

  // The setup notice drops its pencil sentence.
  selection.selectAllChildren(harness.anchor);
  changed();
  scanSelected();
  const empty = harness.take("hd_lookup");
  if (empty) harness.reply(empty, { dictionaryCount: 0, results: [] });
  await harness.settle();
  result.setupNotice = harness.render()?.kind === "notice"
    && harness.render().value === "No dictionaries loaded. Import a Yomitan .zip in Settings.";

  // Turning it back on restores exact selection lookups, the notice and the pencil.
  harness.driver.hide();
  harness.emitOptions({ ...off, lookupMode: "hover", personalDictionaryEnabled: true });
  other.textContent = "ぬるぽがっ";
  selection.selectAllChildren(other);
  changed();
  const restored = harness.take("hd_lookup");
  if (restored) harness.reply(restored, { dictionaryCount: 1, results: [] });
  await harness.settle();
  result.restored = restored?.request.text === "ぬるぽがっ" && restored.request.scanLength === 5
    && restored.request.options?.personalDictionary === true && pencil() === undefined
    && harness.render()?.kind === "notice"
    && harness.render().value === "No definition found. Add your own with the pencil.";
  harness.close();
  return {
    "with the personal dictionary off, selections, drag releases and activation-key selections never look up":
      automatic.every(Boolean) || automatic,
    "with the personal dictionary off, the pointer ignores live selections, the pencil hides and lookups carry the flag":
      (result.pointer && result.kanji) || result,
    "with the personal dictionary off, Scan selected text stays exact and its miss closes without retaining the selection":
      result.explicit || result,
    "with the personal dictionary off, the setup notice has no pencil and turning it on restores selection notices":
      (result.setupNotice && result.restored) || result,
  };
}

async function selectionEditingCase() {
  const outcomes = [];
  for (const tag of ["button", "span", "contents", "restored", "restored-child"]) {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    harness.anchor.textContent = "食";
    const control = window.document.createElement(tag === "button" ? "button" : "span");
    control.textContent = "べ";
    control.style.visibility = "visible";
    control.getClientRects = () => tag === "contents" ? [] : [{}];
    window.Range.prototype.getClientRects = () => [{}];
    if (tag !== "button") {
      control.setAttribute("contenteditable", "true");
      Object.defineProperty(control, "isContentEditable", { value: true });
      if (tag === "contents") control.style.display = "contents";
    }
    if (tag === "restored-child") {
      control.style.visibility = "hidden";
      const child = window.document.createElement("b");
      child.style.visibility = "visible";
      child.textContent = "べ";
      child.getClientRects = () => [{}];
      control.append(child);
    }
    let editingNode = control;
    if (tag === "restored") {
      editingNode = window.document.createElement("span");
      editingNode.style.visibility = "hidden";
      editingNode.append(control);
    }
    harness.anchor.append(editingNode, window.document.createTextNode("た"));
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const selected = harness.take("hd_lookup");
    if (selected) harness.reply(selected, { dictionaryCount: 1, results: [] });
    await harness.settle();
    harness.driver.setScanCandidate(harness.candidate);
    harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
    const fallback = harness.take("hd_lookup");
    outcomes.push(selected === null && fallback === null);
    if (fallback) harness.reply(fallback, { dictionaryCount: 1, results: [] });
    await harness.settle();
    harness.close();
  }
  return { "selections spanning editing controls are ignored without falling back to pointer prefixes":
    outcomes.every(Boolean) || outcomes };
}

async function popupSelectionCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  window.getSelection().selectAllChildren(harness.anchor);
  window.document.dispatchEvent(new window.Event("selectionchange"));
  const request = harness.take("hd_lookup");
  if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
  await harness.settle();
  const current = harness.driver.viewRequest();
  const text = window.document.createTextNode("Selected glossary text");
  harness.popup.append(text);
  const range = window.document.createRange();
  range.selectNodeContents(text);
  // jsdom cannot select closed-shadow text. Chrome exposes these real endpoints.
  const originalSelection = window.getSelection;
  window.getSelection = () => ({
    anchorNode: text, focusNode: text, isCollapsed: false, rangeCount: 1,
    getRangeAt: () => range, toString: () => range.toString(),
  });
  window.document.dispatchEvent(new window.Event("selectionchange"));
  const retained = current !== null && harness.driver.viewRequest() === current
    && !harness.driver.snapshot().popupHidden && harness.take("hd_lookup") === null;
  window.getSelection = originalSelection;
  harness.close();
  return { "selecting popup glossary text preserves the current page-selection view": retained };
}

async function selectionInvalidationCase() {
  const outcomes = [];
  for (const [reason, phase] of ["dictionary", "options"].flatMap((reason) =>
    ["pending", "miss", "hit"].map((phase) => [reason, phase]))) {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const first = harness.take("hd_lookup");
    const exactResults = [harness.term(harness.candidate.query)];
    if (phase !== "pending" && first) {
      harness.reply(first, { dictionaryCount: 1, results: phase === "hit" ? exactResults : [] });
      await harness.settle();
    }
    harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
    const unchangedRetained = harness.take("hd_lookup") === null;
    if (reason === "dictionary") harness.emitState(harness.state(2, "New dictionary generation"));
    else harness.emitOptions({ lookupMode: "hover", maxResults: 5 });
    if (phase === "pending" && first) harness.reply(first, { dictionaryCount: 1, results: exactResults });
    await harness.settle();
    const oldRejected = phase !== "pending"
      || (harness.renders.length === 0 && harness.driver.snapshot().popupHidden);
    harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
    const retry = harness.take("hd_lookup");
    if (retry) harness.reply(retry, { dictionaryCount: 1, results: exactResults });
    await harness.settle();
    outcomes.push(unchangedRetained && oldRejected && retry?.request.text === harness.candidate.query
      && (reason !== "options" || retry?.request.maxResults === 5)
      && harness.render()?.results[0].matched === harness.candidate.query
      && !harness.driver.snapshot().popupHidden);
    harness.close();
  }
  return { "pending selections and resolved hits or misses retry only after dictionary or result-option invalidation":
    outcomes.every(Boolean) || outcomes };
}

async function selectionDescriptorCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const query = harness.candidate.query;
  const exactResults = [harness.term("食"), { ...harness.term("食べる"), matched: query }];
  harness.emitOptions({
    lookupMode: "hover",
    scanLength: 1,
    kanjiClickDictionary: { title: "Generic", kind: "term" },
  });
  window.getSelection().selectAllChildren(harness.anchor);
  window.document.dispatchEvent(new window.Event("selectionchange"));
  const first = harness.take("hd_lookup");
  if (first) harness.reply(first, { dictionaryCount: 1, results: exactResults });
  await harness.settle();
  const original = harness.driver.viewRequest();
  async function noteRefresh(revision, generation, results, eventFirst, depth = 0) {
    harness.edit(true, depth);
    window.getSelection().removeAllRanges();
    const append = harness.callbacks(depth).onAddCustomEntry({ term: "食べる", reading: "たべる", definition: "eat" });
    const mutation = harness.take("hd_custom_append");
    const state = harness.state(revision, "Saved Note");
    if (eventFirst) harness.emitState(state);
    if (mutation) harness.reply(mutation, { generation, document: { revision }, state });
    await harness.settle();
    const refresh = harness.take("hd_lookup");
    if (refresh) harness.reply(refresh, { generation, dictionaryCount: 2, results });
    await append;
    await harness.settle();
    window.getSelection().selectAllChildren(harness.anchor);
    return refresh;
  }
  const selectedRefresh = await noteRefresh(2, 2, exactResults, true);
  const selectedKept = selectedRefresh?.request.text === query && selectedRefresh.request.scanLength === 3
    && harness.driver.viewRequest() === original && original?.exactSelection === true
    && harness.render()?.results.length === 1;
  const clicked = harness.driver.showKanji("食");
  const kanji = harness.take("hd_lookup_dictionary");
  if (kanji) harness.reply(kanji, { generation: 3, results: [harness.term("食")] });
  await clicked;
  window.getSelection().removeAllRanges();
  const back = harness.render()?.context.onBack?.();
  const backRequest = harness.take("hd_lookup");
  if (backRequest) harness.reply(backRequest, { generation: 3, dictionaryCount: 2, results: exactResults });
  await back;
  window.getSelection().selectAllChildren(harness.anchor);
  const backKept = backRequest?.request.text === query && backRequest.request.scanLength === 3
    && harness.driver.viewRequest() === original && harness.render()?.results.length === 1;
  const link = harness.internalLink({ query: "別の語", primaryReading: "べつ" });
  const linked = harness.take("hd_lookup");
  if (linked) harness.reply(linked, { generation: 3, dictionaryCount: 2,
    results: [harness.term("別"), harness.term("別の語")] });
  await link;
  const linkedDescriptor = harness.driver.viewRequest(1);
  const linkKept = linked?.request.text === "別の語" && linked.request.options.primaryReading === "べつ"
    && linked.request.scanLength === 3 && linkedDescriptor?.exactSelection === false
    && harness.render(1)?.results[0].matched === "別の語"
    && harness.driver.viewRequest() === original && harness.driver.snapshot().activeHighlightText === query;
  const linkedRefresh = await noteRefresh(3, 3, [harness.term("別の語")], false, 1);
  harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
  const linkedRefreshKept = linkedRefresh?.request.text === "別の語"
    && linkedRefresh.request.options.primaryReading === "べつ"
    && harness.driver.viewRequest(1) === linkedDescriptor && harness.render(1)?.results[0].matched === "別の語"
    && harness.driver.viewRequest() === original && harness.driver.snapshot().activeHighlightText === query
    && harness.take("hd_lookup") === null;
  harness.close();
  return { "Note and kanji Back preserve exact selection descriptors while linked queries retain their own matching mode":
    selectedKept && backKept && linkKept && linkedRefreshKept
      || { selectedKept, backKept, linkKept, linkedRefreshKept } };
}

async function selectionRecoveryCase() {
  const recovered = [];
  let tabSwitchKept = false;
  for (const reason of ["Escape", "disable", "frame focus", "dictionary-state", "tab switch"]) {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const first = harness.take("hd_lookup");
    if (first) harness.reply(first, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
    await harness.settle();
    if (reason === "Escape") harness.driver.onKeyDown({ key: "Escape", code: "Escape", stopPropagation() {} });
    else if (reason === "disable") {
      harness.emitOptions({ hoverEnabled: false, lookupMode: "hover" });
      harness.emitOptions({ hoverEnabled: true, lookupMode: "hover" });
    } else if (reason === "frame focus" || reason === "tab switch") {
      // Focus moving into one of the page's frames dismisses; leaving the tab does not (#432).
      window.document.hasFocus = () => reason === "frame focus";
      harness.driver.onWindowBlur();
    } else harness.emitState(harness.state(2, "Changed dictionaries"));
    harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
    harness.driver.scanPointer({ target: harness.anchor, clientX: 200, clientY: 200 });
    const retry = harness.take("hd_lookup");
    if (reason === "tab switch") tabSwitchKept = first !== null && retry === null && !harness.driver.snapshot().popupHidden;
    else recovered.push(retry?.request.text === harness.candidate.query);
    if (retry) harness.reply(retry, { dictionaryCount: 1, results: [] });
    await harness.settle();
    harness.close();
  }
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const settings = { lookupMode: "activation", activationKey: "K", scanLength: 1, onlyScanJapaneseText: true };
  harness.emitOptions(settings);
  window.document.dispatchEvent(new window.KeyboardEvent(
    "keydown",
    { key: "k", code: "KeyK", bubbles: true },
  ));
  window.getSelection().selectAllChildren(harness.anchor);
  window.document.dispatchEvent(new window.Event("selectionchange"));
  const selected = harness.take("hd_lookup");
  harness.emitOptions({ ...settings, onlyScanJapaneseText: false });
  window.document.dispatchEvent(new window.KeyboardEvent("keyup", { key: "k", code: "KeyK" }));
  harness.driver.setScanCandidate({ ...harness.candidate, query: "別の語" });
  harness.driver.onMouseMove({ target: harness.anchor, clientX: 200, clientY: 200 });
  if (selected) harness.reply(selected, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
  await harness.settle();
  const retained = selected !== null && !harness.driver.snapshot().popupHidden && harness.take("hd_lookup") === null;
  harness.close();
  return {
    "dismissed selections can be looked up again after Escape, enablement, a frame-focus blur and dictionary changes":
      recovered.every(Boolean) || recovered,
    "a tab-switch blur keeps a selection's popup without looking it up again": tabSwitchKept,
    "an explicit selection survives automatic scanning policy changes, key release and pointer motion": retained,
  };
}

async function selectionActivationCase() {
  const modifiers = [
    ["Shift", "shiftKey"],
    ["Control", "ctrlKey"],
    ["Alt", "altKey"],
    ["Meta", "metaKey"],
  ];
  const flags = held => Object.fromEntries(
    modifiers.map(([key, property]) => [property, held.includes(key)]),
  );

  async function select(harness, held = []) {
    const window = harness.popup.ownerDocument.defaultView;
    const active = [];
    harness.driver.hide();
    window.getSelection().removeAllRanges();
    window.document.dispatchEvent(new window.Event("selectionchange"));
    for (const key of held) {
      active.push(key);
      window.document.dispatchEvent(new window.KeyboardEvent(
        "keydown",
        { bubbles: true, code: `${key}Left`, key, ...flags(active) },
      ));
    }
    harness.anchor.dispatchEvent(new window.MouseEvent(
      "mousedown",
      { bubbles: true, button: 0, clientX: 200, clientY: 200, ...flags(active) },
    ));
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    harness.anchor.dispatchEvent(new window.MouseEvent(
      "mouseup",
      { bubbles: true, button: 0, clientX: 200, clientY: 200, ...flags(active) },
    ));
    const request = harness.take("hd_lookup");
    for (const key of held.toReversed()) {
      active.splice(active.indexOf(key), 1);
      window.document.dispatchEvent(new window.KeyboardEvent(
        "keyup",
        { bubbles: true, code: `${key}Left`, key, ...flags(active) },
      ));
    }
    if (request) harness.reply(request, {
      dictionaryCount: 1,
      results: [harness.term(harness.candidate.query)],
    });
    await harness.settle();
    const snapshot = harness.driver.snapshot();
    return {
      allowed: request?.request.text === harness.candidate.query
        && !snapshot.popupHidden
        && snapshot.activeHighlightText === harness.candidate.query
        && harness.render()?.kind === "terms",
      blocked: request === null && snapshot.popupHidden
        && snapshot.activeHighlightText === "",
    };
  }

  const hover = await createHarness();
  let hoverAllowed = false;
  try {
    hover.emitOptions({ lookupMode: "hover", activationKey: "Shift" });
    hoverAllowed = (await select(hover)).allowed;
  } finally {
    hover.close();
  }

  const results = [];
  for (const lookupMode of ["activation", "activationSticky"]) {
    for (let index = 0; index < modifiers.length; index += 1) {
      const activationKey = modifiers[index][0];
      const mismatch = modifiers[(index + 1) % modifiers.length][0];
      const extra = modifiers[(index + 2) % modifiers.length][0];
      const harness = await createHarness();
      try {
        harness.emitOptions({ lookupMode, activationKey });
        results.push({
          activationKey,
          lookupMode,
          plain: (await select(harness)).blocked,
          mismatch: (await select(harness, [mismatch])).blocked,
          matching: (await select(harness, [activationKey])).allowed,
          combined: (await select(harness, [activationKey, extra])).allowed,
        });
      } finally {
        harness.close();
      }
    }
  }

  const explicit = await createHarness();
  let explicitAllowed = false;
  try {
    const window = explicit.popup.ownerDocument.defaultView;
    explicit.emitOptions({ lookupMode: "activation", activationKey: "Shift" });
    window.getSelection().selectAllChildren(explicit.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const automatic = explicit.take("hd_lookup");
    explicit.runtimeMessage({
      target: "hachidori-reader",
      type: "hd_reader_command",
      action: "scanSelectedText",
    });
    const request = explicit.take("hd_lookup");
    if (request) {
      explicit.reply(request, {
        dictionaryCount: 1,
        results: [explicit.term(explicit.candidate.query)],
      });
    }
    await explicit.settle();
    explicitAllowed = automatic === null && request?.request.text === explicit.candidate.query
      && !explicit.driver.snapshot().popupHidden;
  } finally {
    explicit.close();
  }

  return {
    "automatic selections follow hover and both activation modes for every modifier":
      hoverAllowed && results.every(result =>
        result.plain && result.mismatch && result.matching && result.combined)
        || { hoverAllowed, results },
    "explicit selected-text commands still bypass the automatic selection gate": explicitAllowed,
  };
}

async function selectedTextCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const selection = window.getSelection();
  harness.anchor.innerHTML = '食べ<span hidden>隠し</span>た';
  selection.selectAllChildren(harness.anchor);
  let visible = "食べた";
  let materializations = 0;
  // jsdom uses raw Range text here; the Chrome suite verifies rendered text.
  Object.defineProperty(selection, "toString", { configurable: true, value: () => {
    materializations += 1;
    return visible;
  } });
  window.document.dispatchEvent(new window.Event("selectionchange"));
  const first = harness.take("hd_lookup");
  if (first) harness.reply(first, { dictionaryCount: 1, results: [harness.term(visible)] });
  await harness.settle();
  const selectedText = first?.request.text === visible
    && harness.driver.viewRequest()?.highlightText === "食べ隠した";
  harness.anchor.firstChild.replaceData(1, 1, "ん");
  visible = "食んた";
  materializations = 0;
  for (let index = 0; index < 4; index += 1) {
    harness.driver.onMouseMove({ target: harness.anchor, clientX: 200 + index, clientY: 200 });
  }
  const throttled = materializations === 0;
  await harness.settle();
  const changed = harness.take("hd_lookup");
  const changedText = changed?.request.text === visible;
  if (changed) harness.reply(changed, { dictionaryCount: 1, results: [] });
  await harness.settle();
  harness.close();
  return { "selection lookup uses visible text, raw highlight offsets and text-aware unchanged detection":
    selectedText && changedText && throttled };
}

async function selectionCancellationCase() {
  const outcomes = [];
  for (const reason of ["Escape", "scroll", "window-exit", "collapse", "disable", "replace", "mutate"]) {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const selection = window.getSelection();
    const changed = () => window.document.dispatchEvent(new window.Event("selectionchange"));
    selection.selectAllChildren(harness.anchor);
    changed();
    const first = harness.take("hd_lookup");
    let replacement = null;
    if (reason === "Escape") harness.driver.onKeyDown({ key: "Escape", code: "Escape" });
    else if (reason === "scroll") harness.driver.onScroll();
    else if (reason === "window-exit") harness.driver.onMouseOut({ relatedTarget: null });
    else if (reason === "disable") harness.emitOptions({ hoverEnabled: false });
    else if (reason === "mutate") harness.anchor.firstChild.replaceData(1, 1, "ん");
    else if (reason === "collapse") {
      selection.removeAllRanges();
      changed();
    } else {
      selection.setBaseAndExtent(harness.anchor.firstChild, 0, harness.anchor.firstChild, 1);
      changed();
      replacement = harness.take("hd_lookup");
    }
    if (first) harness.reply(first, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
    await harness.settle();
    outcomes.push(first !== null && harness.driver.snapshot().popupHidden
      && harness.renders.length === 0 && (reason !== "replace" || replacement !== null));
    if (reason === "mutate") {
      changed();
      replacement = harness.take("hd_lookup");
      outcomes.push(replacement?.request.text === "食んた");
    }
    if (replacement) harness.reply(replacement, { dictionaryCount: 1, results: [] });
    await harness.settle();
    harness.close();
  }
  return { "pending selections cannot reopen after dismissal, replacement or selected-text mutation":
    outcomes.every(Boolean) || outcomes };
}

async function exactSelectionCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const document = window.document;
  const selection = window.getSelection();
  harness.emitOptions({ lookupMode: "activation", activationKey: "K", scanLength: 1 });
  const key = (type) => window.document.dispatchEvent(new window.KeyboardEvent(
    type,
    { key: "k", code: "KeyK", bubbles: true },
  ));
  const mouse = (type) => harness.anchor.dispatchEvent(new window.MouseEvent(type, {
    bubbles: true, button: 0, clientX: 200, clientY: 200,
  }));
  const changed = () => document.dispatchEvent(new window.Event("selectionchange"));
  const selectText = (text) => {
    key("keydown");
    mouse("mousedown");
    harness.anchor.textContent = text;
    selection.selectAllChildren(harness.anchor);
    changed();
    mouse("mouseup");
    key("keyup");
    changed();
    return harness.take("hd_lookup");
  };
  harness.anchor.innerHTML = '<b style="display:inline"> 食べ</b><i style="display:inline">たかった </i>';
  key("keydown");
  mouse("mousedown");
  selection.setBaseAndExtent(harness.anchor.lastChild.firstChild, 4, harness.anchor.firstChild.firstChild, 1);
  changed();
  harness.driver.onMouseMove({ target: harness.anchor, clientX: 200, clientY: 200, buttons: 1 });
  await harness.settle();
  const dragQuiet = harness.take("hd_lookup") === null;
  mouse("mouseup");
  key("keyup");
  changed();
  const exact = harness.take("hd_lookup");
  const query = "食べたかった";
  if (exact) harness.reply(exact, { dictionaryCount: 1, results: [
    harness.term("食べ"), { ...harness.term("食べる"), matched: query },
  ] });
  await harness.settle();
  const rendered = harness.render();
  const exactResult = dragQuiet && exact?.request.text === query
    && exact.request.scanLength === Array.from(query).length
    && harness.take("hd_lookup") === null && rendered?.results.length === 1
    && rendered.results[0].term.expression === "食べる"
    && rendered.candidate.query === query
    && rendered.candidate.sentence === "食べたかった"
    && rendered.candidate.matchOffset === 0
    && rendered.candidate.sourceText === " 食べたかった "
    && rendered.candidate.sourceOffset === 1
    && rendered.candidate.sourceElements.map((node) => node.textContent).join("") === rendered.candidate.sourceText;
  harness.emitOptions({ lookupMode: "activation", activationKey: "K", scanLength: 1, onlyScanJapaneseText: false });
  const raw = " hello\n world ";
  const rawRequest = selectText(raw);
  if (rawRequest) harness.reply(rawRequest, { dictionaryCount: 1, results: [] });
  await harness.settle();
  const long = "あ".repeat(70);
  const longRequest = selectText(long);
  if (longRequest) harness.reply(longRequest, { dictionaryCount: 1, results: [harness.term(long.slice(0, 64))] });
  await harness.settle();
  const exactBound = rawRequest?.request.text === raw && longRequest?.request.text === long
    && longRequest.request.scanLength === 64 && !harness.driver.snapshot().popupHidden
    && harness.render()?.kind === "notice" && harness.render().candidate.query === long;
  harness.close();
  return {
    "matching activation preserves exact reverse inline selection context while rejecting prefix results": exactResult,
    "explicit selections preserve whitespace and full queries beyond the engine scan window": exactBound,
  };
}

// Issue #430: an exact selection's sentence -- the Anki sentence, the Note
// prefill and a custom link's %s -- is read as a hover over its first
// selected glyph reads one: across inline elements and glyph boxes, without
// furigana, scripts or hidden text, and only to the edge of that glyph's
// block. The highlight keeps the coordinates of the selection's anchor.
async function selectionSentenceCase() {
  // jsdom's selection text keeps the newline of a gap between paragraphs,
  // which Chrome's leaves out, so the gap case needs the Japanese-only gate off.
  const harness = await createHarness(undefined, { options: { onlyScanJapaneseText: false } });
  const window = harness.popup.ownerDocument.defaultView;
  const document = window.document;
  const page = document.createElement("div");
  document.body.append(page);
  const summary = (candidate) => candidate && {
    query: candidate.query, sentence: candidate.sentence, matchOffset: candidate.matchOffset,
    sourceText: candidate.sourceText, sourceOffset: candidate.sourceOffset, rawSelectionText: candidate.rawSelectionText,
  };
  const select = (html, boundaries) => {
    page.innerHTML = html;
    window.getSelection().setBaseAndExtent(...boundaries());
    return summary(harness.driver.resolveSelectedLookupCandidate());
  };
  const text = (selector) => page.querySelector(selector).firstChild;
  // GameSentenceMiner's overlay: a positioned <p> per OCR block, a positioned
  // flex box per glyph and a "\n" separator between blocks.
  const glyphBox = (glyph) => `<span style="position:absolute;display:flex">${glyph}</span>`;
  const block = (line) => `<p style="position:absolute;left:0;top:0;margin:0">${Array.from(line, glyphBox).join("")}</p>`;
  const glyph = (index, offset) => page.querySelectorAll("p")[index].children[offset].firstChild;
  const separator = '<span style="position:absolute">\n</span>';
  const outcomes = {
    inline: [select("<p>昨日、<span>食べたかった</span>。とてもおいしかった。</p>",
      () => [text("span"), 0, text("span"), 3]),
      { query: "食べた", sentence: "昨日、食べたかった。", matchOffset: 3, sourceText: "食べたかった", sourceOffset: 0,
        rawSelectionText: "食べた" }],
    ruby: [select("<p>彼は<ruby>漢字<rt>かんじ</rt></ruby>を読む。</p>", () => [text("ruby"), 0, text("ruby"), 2]),
      { query: "漢字", sentence: "彼は漢字を読む。", matchOffset: 2, sourceText: "漢字かんじ", sourceOffset: 0,
        rawSelectionText: "漢字" }],
    oneGlyph: [select(block("昨日、食べる & 飲む？") + separator + block("ありがとう"),
      () => [glyph(0, 3), 0, glyph(0, 3), 1]),
      { query: "食", sentence: "昨日、食べる & 飲む？", matchOffset: 3, sourceText: "食", sourceOffset: 0,
        rawSelectionText: "食" }],
    // The page's own script and hidden text sit in the element that holds
    // both blocks, as GameSentenceMiner's inline script sits in <body>.
    crossBlock: [select(`${block("太郎")}${separator}${block("食べたかった")}${separator}${block("ありがとう")}`
      + '<script>window.overlay = "食べ物";</script><span style="display:none">隠し文字</span>',
      () => [glyph(1, 3), 0, glyph(2, 1), 1]),
      { query: "かった\nあり", sentence: "食べたかった", matchOffset: 3,
        sourceText: '太郎\n食べたかった\nありがとうwindow.overlay = "食べ物";隠し文字', sourceOffset: 6,
        rawSelectionText: "かった\nあり" }],
    // A selection dragged in from the gap between paragraphs starts at the
    // paragraph's first glyph.
    fromGap: [select("<p>一つ目の文。</p>\n<p>二つ目に食べたかった。</p>",
      () => [page.childNodes[1], 0, page.lastChild.firstChild, 6]),
      { query: "\n二つ目に食べ", sentence: "二つ目に食べたかった。", matchOffset: 0,
        sourceText: "一つ目の文。\n二つ目に食べたかった。", sourceOffset: 6, rawSelectionText: "\n二つ目に食べ" }],
    // Selected text the scan never reads, as an inline SVG's, has no sentence.
    svgOnly: [select("<p><svg><text>日本語</text></svg>。</p>", () => [page.firstChild, 0, page.firstChild.lastChild, 0]),
      { query: "日本語", sentence: "", matchOffset: 0, sourceText: "日本語。", sourceOffset: 0, rawSelectionText: "日本語" }],
  };
  const mismatched = Object.entries(outcomes)
    .filter(([, [actual, expected]]) => JSON.stringify(actual) !== JSON.stringify(expected))
    .map(([name, [actual]]) => ({ name, actual }));

  // The engine's reply keeps the selection where its sentence put it.
  page.innerHTML = "<p>昨日、<span>食べたかった</span>。とてもおいしかった。</p>";
  window.getSelection().setBaseAndExtent(text("span"), 0, text("span"), 3);
  document.dispatchEvent(new window.Event("selectionchange"));
  const lookup = harness.take("hd_lookup");
  if (lookup) harness.reply(lookup, { dictionaryCount: 1, results: [{ ...harness.term("食べる"), matched: "食べた" }] });
  await harness.settle();
  const rendered = summary(harness.render()?.candidate);
  const replied = lookup?.request.text === "食べた" && JSON.stringify(rendered) === JSON.stringify(outcomes.inline[1]);
  harness.close();
  return {
    "an exact selection's sentence is read like a hover over its first glyph, while its highlight keeps the anchor":
      (mismatched.length === 0 && replied) || { mismatched, rendered },
  };
}

async function selectedWordEditorCase() {
  const outcomes = [];
  for (const [dictionaryCount, eventFirst] of [[0, true], [1, false]]) {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const query = harness.candidate.query;
    window.getSelection().selectAllChildren(harness.anchor);
    window.document.dispatchEvent(new window.Event("selectionchange"));
    const lookup = harness.take("hd_lookup");
    if (lookup) harness.reply(lookup, { dictionaryCount, results: [] });
    await harness.settle();
    const original = harness.driver.viewRequest();
    const editableMiss = !harness.driver.snapshot().popupHidden
      && harness.render()?.kind === "notice" && harness.render().candidate.query === query;
    harness.edit(true);
    window.getSelection().removeAllRanges();
    const entry = { term: query, reading: "たべた", definition: "My own meaning" };
    const append = harness.callbacks().onAddCustomEntry(entry);
    const mutation = harness.take("hd_custom_append");
    const state = harness.state(2, "New personal definition");
    if (eventFirst) harness.emitState(state);
    if (mutation) harness.reply(mutation, { generation: 3, document: { revision: 1 }, state });
    await harness.settle();
    const refresh = harness.take("hd_lookup");
    if (refresh) harness.reply(refresh, { generation: 3, dictionaryCount: 1,
      results: [harness.term(query, CUSTOM_DICTIONARY_TITLE)] });
    await append;
    await harness.settle();
    if (!eventFirst) harness.emitState(state);
    outcomes.push(editableMiss && original?.exactSelection === true
      && mutation?.request.entry.term === query && refresh?.request.text === query
      && harness.driver.viewRequest() === original && harness.render()?.kind === "terms"
      && harness.render().results[0].term.glossaries[0].dictionary === CUSTOM_DICTIONARY_TITLE
      && harness.sent.filter(({ type }) => type === "hd_custom_append").length === 1
      && !harness.driver.snapshot().popupHidden && harness.take("hd_lookup") === null);
    harness.close();
  }
  return { "selected missing words remain editable and refresh after one personal save with zero or existing dictionaries":
    outcomes.every(Boolean) || outcomes };
}

async function releasedSelectionDragCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const pointer = { target: harness.anchor, clientX: 200, clientY: 200, buttons: 1 };
  harness.driver.onMouseDown({ ...pointer, button: 0 });
  window.getSelection().selectAllChildren(harness.anchor);
  window.document.dispatchEvent(new window.Event("selectionchange"));
  harness.driver.onMouseOut({ relatedTarget: null });
  harness.driver.onMouseMove(pointer);
  await harness.settle();
  const held = harness.take("hd_lookup") === null;
  // The primary button was released outside the document: no mouseup arrives.
  harness.driver.onMouseMove({ ...pointer, buttons: 0 });
  await harness.settle();
  const recovered = harness.take("hd_lookup");
  if (recovered) harness.reply(recovered, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
  await harness.settle();
  const visible = !harness.driver.snapshot().popupHidden;
  harness.close();
  return { "selection drags remain quiet while held and recover on re-entry after an outside release":
    held && recovered?.request.text === harness.candidate.query && visible };
}

// The engine finds dictionary keys longer than the scan length only if it is
// handed enough text: each package row carries the longest key its long-key
// index lists, and the reader collects that many code points plus eight for
// an inflected ending while still requesting options.scanLength.
async function longKeyWindowCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  window.Range.prototype.getClientRects = () => [{ left: 0, top: 0, right: 20, bottom: 20 }];
  const document = window.document;
  const block = document.createElement("p");
  block.style.display = "block";
  block.textContent = "\u3042".repeat(300);
  document.body.append(block);
  document.elementFromPoint = () => block;
  const scan = () => {
    const range = document.createRange();
    range.setStart(block.firstChild, 0);
    range.collapse(true);
    document.caretRangeFromPoint = () => range;
    return harness.driver.resolveCandidate(0, 0);
  };
  const state = (rows) => ({ schemaVersion: 1, revision: 0, groups: [], dictionaries: rows });
  let revision = 1;
  const emit = (rows) => harness.emitState({ ...state(rows), revision: ++revision });
  const base = genericPackage({ favorite: true });
  const length = (candidate) => Array.from(candidate?.query ?? "").length;

  const plain = length(scan());
  emit([{ ...base, longKeyLength: 37 }]);
  const withLongKeys = length(scan());
  emit([{ ...base, longKeyLength: 37, enabled: false }, genericPackage({ id: "other", title: "Other" })]);
  const disabledLongKeys = length(scan());
  emit([{ ...base, longKeyLength: 37 }, genericPackage({ id: "longer", title: "Longer", longKeyLength: 250 })]);
  const capped = length(scan());
  emit([{ ...base, longKeyLength: 37, termCount: 0, frequencyCount: 3 }]);
  const frequencyOnly = length(scan());
  emit([{ ...base, longKeyLength: 1 }]);
  const shorterThanScan = length(scan());

  emit([{ ...base, longKeyLength: 37 }]);
  harness.driver.onMouseMove({ target: block, clientX: 10, clientY: 10 });
  await harness.settle();
  const request = harness.take("hd_lookup");
  harness.close();
  return { "the reader hands the engine the longest indexed key plus eight while requesting its own scan length":
    plain === 9 && withLongKeys === 45 && disabledLongKeys === 9 && capped === 256 && frequencyOnly === 9
      && shorterThanScan === 9 && request?.request.scanLength === 9 && Array.from(request?.request.text ?? "").length === 45
      || { plain, withLongKeys, disabledLongKeys, capped, frequencyOnly, shorterThanScan, request: request?.request && { scanLength: request.request.scanLength, textLength: Array.from(request.request.text).length } } };
}

async function hoverGlyphCase() {
  const harness = await createHarness();
  const { ownerDocument: document } = harness.popup;
  const window = document.defaultView;
  const label = document.createElement("a");
  label.textContent = "𠮷食べた";
  const cover = document.createElement("div");
  document.body.append(label, cover);
  let offset = 0;
  document.caretRangeFromPoint = () => {
    const range = document.createRange();
    range.setStart(label.firstChild, offset);
    range.collapse(true);
    return range;
  };
  document.elementFromPoint = () => label;
  const probes = [];
  window.Range.prototype.getClientRects = function () {
    probes.push(this.toString());
    return [{ left: 10, right: 30, top: 10, bottom: 30 }];
  };
  const scan = (x, y) => harness.driver.resolveCandidate(x, y);
  const inside = scan(15, 20)?.query === label.textContent;
  const padding = scan(15, 50) === null;
  const slack = scan(8.5, 20)?.query === label.textContent && scan(7, 20) === null;
  document.elementFromPoint = () => cover;
  const covered = scan(15, 20) === null;
  document.elementFromPoint = () => document.body;
  const ancestor = scan(15, 20)?.query === label.textContent;
  document.elementFromPoint = () => label;
  offset = 2; // Right half of a supplementary glyph: caret is after both code units.
  const supplementary = scan(25, 20)?.query === label.textContent && probes.includes("𠮷");
  offset = label.textContent.length;
  const end = scan(50, 50) === null;
  harness.close();
  return {
    "hover requires the pointed glyph within two pixels and rejects occluding elements":
      (inside && padding && slack && covered && ancestor && end)
      || { inside, padding, slack, covered, ancestor, end },
    "hover in the trailing half of a supplementary glyph starts at its complete code point": supplementary,
  };
}

// Google Docs paints text to <canvas>; with the flag script set it also draws
// `.kix-canvas-tile-content svg>g>rect` annotations carrying each text run in
// aria-label. The reader turns the hovered rect into an invisible SVG <text>
// imposter and scans that, as Yomitan's google-docs-util does.
function buildDocsTile(document, runs) {
  const SVG = "http://www.w3.org/2000/svg";
  const tile = document.createElement("div");
  tile.className = "kix-canvas-tile-content";
  const canvas = document.createElement("canvas");
  const svg = document.createElementNS(SVG, "svg");
  const group = document.createElementNS(SVG, "g");
  const rects = runs.map((run, index) => {
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("aria-label", run);
    rect.setAttribute("x", "100");
    rect.setAttribute("y", String(20 + index * 40));
    rect.setAttribute("transform", "matrix(1,0,0,1,0,0)");
    rect.setAttribute("data-font-css", "400 14px Arial");
    group.append(rect);
    return rect;
  });
  svg.append(group);
  tile.append(canvas, svg);
  document.body.append(tile);
  return { tile, canvas, svg, group, rects };
}

async function googleDocsCase() {
  const { DEFAULT_OPTIONS } = globalThis.HDReaderOptions;
  const on = { ...DEFAULT_OPTIONS.experimental, googleDocs: true };
  const off = { ...DEFAULT_OPTIONS.experimental };
  const harness = await createHarness(undefined, {
    url: "https://docs.google.com/document/d/example/edit",
  });
  const { ownerDocument: document } = harness.popup;
  const window = document.defaultView;
  const run = "犬と一緒に公園を散歩する。";
  const { canvas, group, rects: [rect, other] } = buildDocsTile(document, [run, "彼女は毎朝六時に起きて、"]);
  // Ten CSS pixels per character from x=100; each imposter inherits its rect's row.
  window.Range.prototype.getClientRects = function () {
    const row = Number.parseFloat(this.startContainer.parentElement?.getAttribute?.("y") ?? "20");
    return [{ left: 100 + this.startOffset * 10, right: 100 + this.endOffset * 10, top: row, bottom: row + 20 }];
  };
  const probeStyle = () => [...document.querySelectorAll("style")]
    .find(style => style.textContent.includes("kix-canvas-tile-content"));
  // Docs' tiles are only hit-testable while the reader's probe style is enabled.
  let probed = 0;
  let rectUnderPointer = rect;
  document.elementFromPoint = () => {
    const style = probeStyle();
    if (style && style.disabled === false) {
      probed += 1;
      return rectUnderPointer;
    }
    return canvas;
  };
  document.caretRangeFromPoint = () => null;
  const imposters = () => [...group.querySelectorAll("text")];
  const scan = (x, y) => harness.driver.resolveCandidate(x, y);
  const flag = (experimental) => harness.emitOptions({ lookupMode: "hover", scanLength: 9, experimental });

  // Default: the flag is off, so Docs behaves as before and nothing is injected.
  const flagOff = scan(185, 30);
  const nothingInjected = probeStyle() === undefined && imposters().length === 0 && probed === 0;

  flag(on);
  const candidate = scan(185, 30); // Over 散, the ninth character.
  const first = candidate?.scanEntries?.[0];
  const imposter = imposters()[0];
  const resolved = candidate?.query === "散歩する。" && candidate.sentence === run && candidate.matchOffset === 8
    && candidate.sourceText === run && candidate.sourceOffset === 8 && first?.node === imposter?.firstChild
    && candidate.anchor === imposter && candidate.anchorRange.toString() === "散" && candidate.vertical === false
    && imposter.getAttribute("x") === "100" && imposter.getAttribute("y") === "20"
    && imposter.style.getPropertyPriority("opacity") === "important" && probed === 1
    && probeStyle().disabled === true;
  const again = scan(195, 30); // 歩: same run, so the anchor node is shared.
  const shared = again !== null && imposter !== undefined && again.anchor === imposter
    && again.scanEntries[0].node === imposter.firstChild
    && again.query === "歩する。" && imposters().length === 1;
  rectUnderPointer = other;
  const moved = scan(105, 70);
  const replaced = moved?.query === "彼女は毎朝六時に起" && moved.sentence === "彼女は毎朝六時に起きて、"
    && imposters().length === 1 && imposters()[0] !== imposter && moved.anchor === imposters()[0];
  rectUnderPointer = null;
  const margin = scan(5, 5);
  const nothingElse = margin === null && imposters().length === 1;

  rectUnderPointer = rect;
  harness.driver.onMouseMove({ target: canvas, clientX: 185, clientY: 30 });
  await harness.settle();
  const request = harness.take("hd_lookup");
  const lookedUp = request?.request.text === "散歩する。";

  flag(off);
  const flagOffAgain = scan(185, 30);
  const released = imposters().length === 0 && probeStyle() === undefined;
  harness.close();

  // The same tile on another host is canvas as before, flag or no flag.
  const elsewhere = await createHarness(undefined, { options: { experimental: on } });
  const elsewhereDocument = elsewhere.popup.ownerDocument;
  const built = buildDocsTile(elsewhereDocument, [run]);
  elsewhereDocument.elementFromPoint = () => built.rects[0];
  elsewhereDocument.caretRangeFromPoint = () => null;
  const otherHost = elsewhere.driver.resolveCandidate(185, 30) === null
    && elsewhereDocument.querySelector("style") === null && built.group.querySelector("text") === null;
  elsewhere.close();

  return {
    "Google Docs annotation rects scan through an SVG imposter while the flag is on":
      resolved && shared && replaced && nothingElse && lookedUp
      || { candidate: candidate && { query: candidate.query, sentence: candidate.sentence, matchOffset: candidate.matchOffset },
        resolved, shared, replaced, nothingElse, lookedUp, probed },
    "the Docs path is inert while its flag is off and on other hosts":
      flagOff === null && nothingInjected && flagOffAgain === null && released && otherHost
      || { flagOff, nothingInjected, flagOffAgain, released, otherHost },
  };
}

// An <input> or <textarea> keeps its value in user-agent shadow DOM, so the
// reader scans an invisible imposter laid over the hovered field (#425).
async function textFieldCase() {
  const harness = await createHarness();
  harness.emitOptions({ lookupMode: "hover", scanLength: 9 });
  const { ownerDocument: document } = harness.popup;
  const window = document.defaultView;
  // Ten CSS pixels per character from x=100, one 20-pixel row per line from y=20.
  window.Range.prototype.getClientRects = function () {
    const rects = [];
    let lineStart = 0;
    for (const [row, line] of (this.startContainer.nodeValue ?? "").split("\n").entries()) {
      const start = Math.max(this.startOffset, lineStart);
      const end = Math.min(this.endOffset, lineStart + line.length);
      if (end > start) {
        rects.push({ left: 100 + (start - lineStart) * 10, right: 100 + (end - lineStart) * 10,
          top: 20 + row * 20, bottom: 40 + row * 20 });
      }
      lineStart += line.length + 1;
    }
    return rects;
  };
  // Every field's border box starts at (90, 10); an input's text starts after
  // its ten-pixel padding, a textarea's at its padding box.
  const field = (tag, value, { type, rows = 1, style = "" } = {}) => {
    const element = document.createElement(tag);
    if (type) element.type = type;
    element.setAttribute("style", tag === "input" ? `padding:0 10px;${style}` : style);
    element.value = value;
    const height = 20 + rows * 20;
    element.getBoundingClientRect = () => ({ left: 90, top: 10, right: 400, bottom: 10 + height, width: 310, height });
    for (const [name, metric] of Object.entries({ clientLeft: 0, clientTop: 0, clientWidth: 310, clientHeight: height })) {
      Object.defineProperty(element, name, { configurable: true, value: metric });
    }
    return element;
  };
  const plain = field("input", "外に行く");
  const search = field("input", "食べたかった。次の文", { type: "search" });
  // jsdom reports the longhand of a textarea's pre-wrap only when it is declared.
  const area = field("textarea", "一行目の文。\n二行目に食べたかった言葉\n三行目", { rows: 3, style: "white-space-collapse:preserve" });
  const password = field("input", "外に行く", { type: "password" });
  const masked = field("input", "外に行く");
  const empty = field("input", "");
  const paragraph = document.createElement("p");
  paragraph.textContent = "食べ";
  document.body.append(plain, search, area, password, masked, empty, paragraph);
  // jsdom drops -webkit-text-security, which Chrome reports for a masked field.
  const computedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element, pseudo) => {
    const style = computedStyle(element, pseudo);
    return element === masked ? new Proxy(style, {
      get: (target, key) => key === "getPropertyValue"
        ? (name) => (name === "-webkit-text-security" ? "disc" : target.getPropertyValue(name))
        : Reflect.get(target, key),
    }) : style;
  };
  let pointed = plain;
  document.elementFromPoint = () => pointed;
  document.caretRangeFromPoint = () => null;
  const scan = (element, x, y = 30) => {
    pointed = element;
    return harness.driver.resolveCandidate(x, y);
  };
  const imposters = () => [...document.body.children].filter((child) => child.getAttribute("aria-hidden") === "true");
  const summary = (candidate) => candidate && { query: candidate.query, sentence: candidate.sentence, matchOffset: candidate.matchOffset };

  const first = scan(plain, 105); // 外
  const imposter = first?.anchor;
  const [container] = imposters();
  const resolved = first?.query === "外に行く" && first.sentence === "外に行く" && first.matchOffset === 0
    && imposter?.localName === "div" && imposter.textContent === plain.value && imposter.parentElement === container
    && first.scanEntries[0].node === imposter.firstChild && first.sourceElements[0] === imposter.firstChild
    && first.anchorRange.toString() === "外" && first.vertical === false
    && container.style.getPropertyValue("opacity") === "0" && container.style.getPropertyPriority("opacity") === "important"
    && imposter.style.getPropertyValue("white-space") === "pre" && imposter.style.getPropertyValue("pointer-events") === "none";
  const next = scan(plain, 118); // に, in the same imposter
  const shared = next?.query === "に行く" && next.matchOffset === 1 && next.anchor === imposter && imposters().length === 1;
  const searched = scan(search, 105);
  const searchField = searched?.query === "食べたかった。次の" && searched.sentence === "食べたかった。"
    && searched.matchOffset === 0 && searched.anchor !== imposter && !imposter.isConnected && imposters().length === 1;
  const line = scan(area, 145, 50); // 食 on the second line
  const textarea = line?.query === "食べたかった言葉" && line.sentence === "二行目に食べたかった言葉" && line.matchOffset === 4
    && line.anchor.textContent === area.value && imposters().length === 1;
  const before = scan(plain, 105)?.anchor;
  plain.value = "外に出る";
  const changed = scan(plain, 105);
  const rebuilt = changed?.query === "外に出る" && changed.anchor !== before && before?.isConnected === false
    && imposters().length === 1;
  const refused = { padding: scan(plain, 95), pastText: scan(plain, 380), password: scan(password, 105),
    masked: scan(masked, 105), empty: scan(empty, 105) };
  const nothing = Object.values(refused).every((candidate) => candidate === null);

  // The imposter follows the body's last paragraph, and a page scan stops before it.
  scan(plain, 105);
  const paragraphRange = document.createRange();
  paragraphRange.setStart(paragraph.firstChild, 0);
  paragraphRange.collapse(true);
  document.caretRangeFromPoint = () => paragraphRange;
  const page = scan(paragraph, 105);
  const pageStops = page?.query === "食べ" && imposters().length === 1
    && paragraph.compareDocumentPosition(imposters()[0]) === window.Node.DOCUMENT_POSITION_FOLLOWING;
  document.caretRangeFromPoint = () => null;

  // Moves within one glyph share the pending lookup; the imposter stays while
  // it anchors the popup and goes when the popup closes.
  const lookups = () => harness.pending.filter(({ request }) => request.type === "hd_lookup").length;
  pointed = plain;
  harness.driver.onMouseMove({ target: plain, clientX: 105, clientY: 30, buttons: 0 });
  await harness.settle();
  harness.driver.onMouseMove({ target: plain, clientX: 108, clientY: 31, buttons: 0 });
  await harness.settle();
  const deduped = lookups() === 1;
  const request = harness.take("hd_lookup");
  harness.reply(request, { dictionaryCount: 1, results: [harness.term("外")] });
  await harness.settle();
  const shown = request?.request.text === "外に出る" && harness.driver.snapshot().popupHidden === false;
  pointed = paragraph;
  harness.driver.onMouseMove({ target: paragraph, clientX: 300, clientY: 30, buttons: 0 });
  await new Promise((resolveWait) => window.setTimeout(resolveWait, 10));
  const anchoring = imposters().length === 1 && harness.driver.snapshot().popupHidden === false;
  harness.driver.hide();
  const hidden = imposters().length === 0;
  // Without a popup it goes as soon as the pointer leaves its field.
  pointed = plain;
  harness.driver.onMouseMove({ target: plain, clientX: 105, clientY: 30, buttons: 0 });
  await harness.settle();
  const pending = imposters().length === 1 && lookups() === 1;
  pointed = paragraph;
  harness.driver.onMouseMove({ target: paragraph, clientX: 300, clientY: 30, buttons: 0 });
  await harness.settle();
  const left = imposters().length === 0;
  harness.close();
  return {
    "text inputs and textareas scan their value through one imposter laid over the hovered field":
      resolved && shared && searchField && textarea && rebuilt
      || { first: summary(first), next: summary(next), searched: summary(searched), line: summary(line),
        changed: summary(changed), resolved, shared, searchField, textarea, rebuilt },
    "padding, password, masked and empty fields are not read and page scans never reach the imposter":
      nothing && pageStops || { refused: Object.fromEntries(Object.entries(refused).map(([key, value]) => [key, summary(value)])),
        page: summary(page) },
    "a field's imposter shares its pending lookup and is removed when the popup closes or the pointer leaves":
      deduped && shown && anchoring && hidden && pending && left
      || { deduped, shown, anchoring, hidden, pending, left },
  };
}

async function scanExtractionCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const document = window.document;
  const block = document.createElement("p");
  block.style.display = "block";
  document.body.append(block);
  const scan = (node, offset = 0) => {
    document.elementFromPoint = () => node.parentElement;
    window.Range.prototype.getClientRects = function () {
      return this.startOffset === offset ? [{ left: 0, top: 0, right: 1, bottom: 1 }] : [];
    };
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    document.caretRangeFromPoint = () => range;
    return harness.driver.resolveCandidate(0, 0);
  };
  block.innerHTML = '<b style="display:inline">食</b><i style="display:inline">べたかった</i>。';
  const inline = scan(block.firstChild.firstChild);
  const crossedInline = inline?.query === "食べたかった。" && inline.sentence === "食べたかった。"
    && inline.sourceElements.map((element) => element.textContent).join("") === inline.sourceText;
  block.textContent = "hello world";
  const japaneseOnly = scan(block.firstChild) === null;
  harness.emitOptions({ onlyScanJapaneseText: false });
  const unrestricted = scan(block.firstChild)?.query === "hello world";
  harness.emitOptions({ onlyScanJapaneseText: true });
  const gatedAgain = scan(block.firstChild) === null;
  const mixedNumerals = [];
  for (const text of ["第1", "第１", "第一", "第1扉", "第１扉", "第一扉", "3月", "３月", "第1。", "第１、"]) {
    block.textContent = text;
    const fromJapanese = scan(block.firstChild);
    const fromNumeral = scan(block.firstChild, 1);
    const suffix = text.slice(1);
    mixedNumerals.push(fromJapanese?.query === text
      && (/[一扉月]/u.test(suffix) ? fromNumeral?.query === suffix : fromNumeral === null));
  }
  const rejected = ["123", "１２３", "hello", "hello 日本語", "1。日本語"].every((text) => {
    block.textContent = text;
    return scan(block.firstChild) === null;
  });
  const controls = [];
  for (const tag of ["button", "select", "textarea", "input", "span"]) {
    block.innerHTML = '<b style="display:inline">食</b>';
    const control = document.createElement(tag);
    control.style.display = "inline";
    control.getClientRects = () => [{}];
    control.textContent = "べたかった";
    if (tag === "span") {
      control.setAttribute("contenteditable", "true");
      // jsdom lacks this browser property; Chrome exercises actual inheritance.
      Object.defineProperty(control, "isContentEditable", { value: true });
    }
    block.append(control, document.createTextNode("語"));
    // A textarea's value is read through its imposter; the other controls stay unread.
    const direct = scan(control.firstChild);
    controls.push((tag === "textarea" ? direct?.query === "べたかった" : direct === null)
      && scan(block.firstChild.firstChild)?.query === "食");
    control.style.display = "none";
    controls.push(scan(block.firstChild.firstChild)?.query === "食語");
  }
  block.innerHTML = '食<span style="display:inline;visibility:hidden">隠し<b style="display:inline;visibility:visible">べ</b></span>た';
  const restored = block.querySelector("b");
  const restoredProse = scan(block.firstChild)?.query === "食べた" && scan(restored.firstChild)?.query === "べた";
  block.querySelector("span").style.display = "block";
  // Layout never ends a scan: Yomitan's layout-unaware default reads on.
  const restoredBlock = scan(block.firstChild)?.query === "食べた";
  block.querySelector("span").style.display = "inline";
  for (const editor of [block.querySelector("span"), restored]) {
    editor.setAttribute("contenteditable", "true");
    Object.defineProperty(editor, "isContentEditable", { configurable: true, value: true });
    restored.getClientRects = () => [{}];
    controls.push(scan(block.firstChild)?.query === "食");
    editor.removeAttribute("contenteditable");
    delete editor.isContentEditable;
  }
  // An OCR overlay boxes every glyph in its own positioned span and separates
  // blocks with a "\n" span, the DOM the GameSentenceMiner overlay builds.
  block.remove();
  const glyphBlock = (text, vertical = false) => {
    const container = document.createElement("p");
    container.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%";
    for (const glyph of text) {
      const box = document.createElement("span");
      box.style.cssText = `position:absolute;display:flex;left:1%;top:2%${vertical ? ";writing-mode:vertical-rl" : ""}`;
      box.textContent = glyph;
      container.append(box);
    }
    return container;
  };
  const firstText = "俺は気になる事があって、放送塔へ足を運んだ。";
  const firstBlock = glyphBlock(firstText);
  const separators = [0, 1].map(() => {
    const separator = document.createElement("span");
    separator.style.position = "absolute";
    separator.textContent = "\n";
    return separator;
  });
  const secondBlock = glyphBlock("「あ、やっぱり……」", true);
  document.body.append(separators[0], firstBlock, separators[1], secondBlock);
  const glyphSpan = firstBlock.children[2];
  const boxed = scan(glyphSpan.firstChild);
  const { scanLength } = window.HDReaderOptions.DEFAULT_OPTIONS;
  const boxedFirst = boxed?.query === Array.from(firstText).slice(2, 2 + scanLength).join("") && boxed.matchOffset === 2
    && boxed.sentence === firstText && boxed.sourceOffset === 2 && boxed.anchor === glyphSpan
    && boxed.sourceElements.every((node) => node.nodeType === 3 && firstBlock.contains(node))
    && boxed.sourceElements.map((node) => node.textContent).join("") === boxed.sourceText
    && boxed.sourceText === firstText
    && boxed.vertical === false;
  const boxedSecond = scan(secondBlock.children[1].firstChild);
  // The flex glyph boxes are one line; the quotes around it are not part of its sentence.
  const boxedNext = boxedSecond?.query === "あ、やっぱり……」" && boxedSecond.sentence === "あ、やっぱり……"
    && boxedSecond.matchOffset === 0 && boxedSecond.sourceText === "「あ、やっぱり……」"
    && boxedSecond.sourceOffset === 1 && boxedSecond.vertical === true;
  firstBlock.remove();
  secondBlock.remove();
  for (const separator of separators) separator.remove();
  harness.close();
  return {
    "pointer scans cross ordinary inline text and apply the live Japanese-only preference":
      crossedInline && japaneseOnly && unrestricted && gatedAgain && restoredProse && restoredBlock,
    "Japanese-only scanning accepts mixed numeral compounds from Japanese or numeral characters":
      (mixedNumerals.every(Boolean) && rejected) || { mixedNumerals, rejected },
    "editing controls and contenteditable text stop forward pointer scanning, and only a textarea's value scans directly":
      controls.every(Boolean) || controls,
    "pointer scans cross positioned per-glyph boxes and take the sentence from the block's text nodes":
      (boxedFirst && boxedNext) || { boxed: boxed && { ...boxed, anchor: null, anchorRange: null, scanEntries: null, sourceElements: boxed.sourceElements.length },
        boxedSecond: boxedSecond && { query: boxedSecond.query, sentence: boxedSecond.sentence, matchOffset: boxedSecond.matchOffset, vertical: boxedSecond.vertical } },
  };
}

// Yomitan's sentence around the match (issue #292): a texthooker line, one
// sentence out of several in a text node, and the refinement to the matched
// word once the engine has answered.
async function sentenceBoundaryCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const document = window.document;
  const scan = (node, offset = 0) => {
    document.elementFromPoint = () => node.parentElement;
    window.Range.prototype.getClientRects = function () {
      return this.startOffset === offset ? [{ left: 0, top: 0, right: 1, bottom: 1 }] : [];
    };
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    document.caretRangeFromPoint = () => range;
    return harness.driver.resolveCandidate(0, 0);
  };
  const summary = (candidate) => candidate && {
    sentence: candidate.sentence, matchOffset: candidate.matchOffset,
    sourceText: candidate.sourceText, sourceOffset: candidate.sourceOffset,
  };
  // texthooker-ui (PR #79): every hooked line is a <p> followed by a "\n" text
  // node inside a flex <main>; a milestone <div> sits between two lines with
  // no whitespace node before the next <p>.
  const main = document.createElement("main");
  main.style.cssText = "display:flex;flex-direction:column";
  main.innerHTML = '\n<p>一行目の文</p>\n<p id="hooked">二行目に食べたかった言葉</p>\n'
    + '<div style="display:flex"><div style="display:flex"><span>Milestone 1000 (1024)</span></div></div>'
    + '<p id="after">三行目の文</p>\n';
  document.body.append(main);
  const hooked = summary(scan(document.getElementById("hooked").firstChild, 4));
  const hookedLine = JSON.stringify(hooked) === JSON.stringify({
    sentence: "二行目に食べたかった言葉", matchOffset: 4, sourceText: "二行目に食べたかった言葉", sourceOffset: 4,
  });
  const after = summary(scan(document.getElementById("after").firstChild));
  const afterMilestone = JSON.stringify(after) === JSON.stringify({
    sentence: "三行目の文", matchOffset: 0, sourceText: "三行目の文", sourceOffset: 0,
  });
  main.remove();

  const block = document.createElement("div");
  block.textContent = "一つ目の文だ。二つ目に食べたかった。三つ目の文だ。";
  document.body.append(block);
  const middle = summary(scan(block.firstChild, 11));
  const middleSentence = JSON.stringify(middle) === JSON.stringify({
    sentence: "二つ目に食べたかった。", matchOffset: 4, sourceText: block.textContent, sourceOffset: 11,
  });
  // A source line wrap inside a paragraph renders as one line, so it becomes
  // spaces inside the sentence rather than its end; a preserved line break
  // ends it. jsdom reports the longhand only when it is declared.
  block.innerHTML = "<span>一つ目の文だ。二つ目に食べ\n  たかった。三つ目の文だ。</span>";
  const wrapped = summary(scan(block.firstChild.firstChild, 11));
  const wrappedSentence = wrapped?.sentence === "二つ目に食べ   たかった。" && wrapped.matchOffset === 4
    && wrapped.sourceText === block.textContent;
  block.firstChild.style.setProperty("white-space-collapse", "preserve");
  const preserved = summary(scan(block.firstChild.firstChild, 11));
  const preservedSentence = preserved?.sentence === "二つ目に食べ" && preserved.matchOffset === 4;
  block.remove();

  // The reply extends the match from the hovered glyph to the matched word:
  // the dots of U.S.A. are not sentence terminators once it is the match.
  harness.emitOptions({ onlyScanJapaneseText: false });
  const paragraph = document.createElement("p");
  paragraph.textContent = "The U.S.A. is big. Yes.";
  document.body.append(paragraph);
  const candidate = scan(paragraph.firstChild, 4);
  const provisional = summary(candidate);
  const operation = harness.driver.runLookup(candidate);
  const request = harness.take("hd_lookup");
  if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term("U.S.A.")] });
  await operation;
  await harness.settle();
  const rendered = harness.render();
  const refined = provisional?.sentence === "The U." && provisional.matchOffset === 4
    && request?.request.text.startsWith("U.S.A. is big.") && rendered?.kind === "terms"
    && rendered.candidate.sentence === "The U.S.A. is big." && rendered.candidate.matchOffset === 4
    && rendered.candidate.sourceText === paragraph.textContent && rendered.candidate.sourceOffset === 4;
  paragraph.remove();
  harness.close();
  return {
    "a texthooker line is its own sentence, whether a newline node or only a block edge separates it from its neighbours":
      (hookedLine && afterMilestone) || { hooked, after },
    "one sentence of a text node is cut at its terminators while collapsed line wraps stay inside it":
      (middleSentence && wrappedSentence && preservedSentence) || { middle, wrapped, preserved },
    "the engine reply refines the sentence around the whole matched word":
      refined || { provisional, request: request?.request.text, rendered: summary(rendered?.candidate) },
  };
}

async function autofocusedSearchCase() {
  const outcomes = [];
  for (const lookupMode of ["hover", "activation"]) {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const document = window.document;
    const search = document.createElement("input");
    search.autofocus = true;
    const example = document.createElement("p");
    example.style.display = "block";
    example.innerHTML = 'Text reading assistance: <a style="display:inline" href="/search/example">'
      + '昨日すき焼きを<span style="display:inline">食べました</span></a>';
    document.body.append(search, example);
    const link = example.querySelector("a");
    document.elementFromPoint = () => link;
    window.Range.prototype.getClientRects = () => [{ left: 190, top: 190, right: 210, bottom: 210 }];
    const range = document.createRange();
    range.setStart(link.firstChild, 0);
    range.collapse(true);
    document.caretRangeFromPoint = () => range;
    harness.emitOptions({ lookupMode, activationKey: "Shift", scanLength: 32 });
    search.focus();
    harness.driver.onMouseMove({ target: link, clientX: 200, clientY: 200 });
    await harness.settle();
    let request = harness.take("hd_lookup");
    let gated = true;
    const key = new window.KeyboardEvent("keydown", {
      key: "Shift", code: "ShiftLeft", shiftKey: true, bubbles: true, cancelable: true,
    });
    if (lookupMode === "activation") {
      gated = request === null;
      search.dispatchEvent(key);
      await harness.settle();
      request = harness.take("hd_lookup");
    }
    outcomes.push(gated && request?.request.text === "昨日すき焼きを食べました"
      && document.activeElement === search && !key.defaultPrevented);
    harness.close();
  }
  return { "autofocused search fields allow hover and stationary modifier lookup of inline Japanese links":
    outcomes.every(Boolean) || outcomes };
}

async function matchedAnchorCase() {
  const harness = await createHarness();
  try {
    const initial = harness.candidate.anchorRange.toString();
    await harness.initialLookup();
    return {
      "term lookup expands popup placement from the hovered glyph to the complete matched word":
        initial === "\u98df" && harness.candidate.anchorRange.toString() === "\u98df\u3079\u305f",
    };
  } finally {
    harness.close();
  }
}

async function popupWheelCase() {
  const harness = await createHarness();
  try {
    await harness.initialLookup();
    const window = harness.popup.ownerDocument.defaultView;
    let pageWheels = 0;
    window.document.body.addEventListener("wheel", () => { pageWheels += 1; });
    const wheel = () => {
      const event = new window.WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true, composed: true });
      harness.popup.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const unscrollableHeld = wheel();
    Object.defineProperties(harness.popup, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    harness.popup.style.overflowY = "auto";
    const scrollableNative = !wheel();
    Object.defineProperty(harness.popup, "scrollTop", { value: 400 });
    const edgeHeld = wheel();
    return {
      "popup wheel never reaches the page and cannot chain past a pane with no room left":
        pageWheels === 0 && unscrollableHeld && scrollableNative && edgeHeld,
    };
  } finally {
    harness.close();
  }
}

async function movedMatchEndpointCase() {
  const harness = await createHarness();
  try {
    const first = harness.anchor.firstChild;
    const last = first.splitText(1);
    harness.candidate.scanEntries = [
      { node: first, offset: 0, sourceLength: 1, text: first.nodeValue },
      { node: last, offset: 0, sourceLength: 2, text: last.nodeValue },
    ];
    const originalRange = harness.candidate.anchorRange;
    const operation = harness.driver.runLookup(harness.candidate);
    const request = harness.take("hd_lookup");
    harness.anchor.ownerDocument.body.append(last);
    harness.reply(request, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
    await operation;
    return {
      "text moved outside the source during lookup keeps the original popup anchor":
        harness.candidate.anchorRange === originalRange && originalRange.toString() === "\u98df",
    };
  } finally {
    harness.close();
  }
}

async function focusedEditingCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const input = window.document.createElement("input");
  window.document.body.append(input);
  harness.driver.setScanCandidate(harness.candidate);
  harness.emitOptions({ lookupMode: "activation", activationKey: "K" });
  const pointer = { target: harness.anchor, clientX: 200, clientY: 200 };
  harness.driver.onMouseMove(pointer);
  input.focus();
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true }));
  harness.driver.onMouseMove(pointer);
  await harness.settle();
  const whileEditing = harness.take("hd_lookup");
  if (whileEditing) harness.reply(whileEditing, {}, false);
  await harness.settle();
  input.blur();
  harness.emitOptions({ lookupMode: "hover", onlyScanJapaneseText: false });
  harness.driver.setScanCandidate({ ...harness.candidate, query: "hello" });
  harness.driver.scanPointer(pointer);
  const beforeGate = harness.take("hd_lookup");
  harness.emitOptions({ lookupMode: "hover", onlyScanJapaneseText: true });
  if (beforeGate) harness.reply(beforeGate, { dictionaryCount: 1, results: [harness.term("hello")] });
  await harness.settle();
  const obsoleteRejected = harness.driver.snapshot().popupHidden;
  harness.close();
  return {
    "focused editing suppresses stationary activation and Japanese gating cancels prior pending scans":
      whileEditing === null && beforeGate !== null && obsoleteRejected,
  };
}

async function shadowEditingCase() {
  const outcomes = [];
  for (const tag of ["input", "div"]) {
    const harness = await createHarness();
    const window = harness.popup.ownerDocument.defaultView;
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const innerHost = window.document.createElement("div");
    host.attachShadow({ mode: "open" }).append(innerHost);
    const editor = window.document.createElement(tag);
    editor.tabIndex = 0;
    if (tag === "div") {
      editor.setAttribute("contenteditable", "true");
      Object.defineProperty(editor, "isContentEditable", { value: true });
    }
    innerHost.attachShadow({ mode: "open" }).append(editor);
    harness.driver.setScanCandidate(harness.candidate);
    const pointer = { target: harness.anchor, clientX: 200, clientY: 200 };
    harness.emitOptions({ lookupMode: "activation", activationKey: "K" });
    harness.driver.onMouseMove(pointer);
    editor.focus();
    editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true, composed: true }));
    await harness.settle();
    const typing = harness.take("hd_lookup");
    if (typing) harness.reply(typing, {}, false);
    editor.blur();
    harness.emitOptions({ lookupMode: "hover" });
    harness.driver.onMouseMove(pointer);
    editor.focus();
    await harness.settle();
    const delayed = harness.take("hd_lookup");
    if (delayed) harness.reply(delayed, {}, false);
    editor.blur();
    harness.driver.scanPointer(pointer);
    const pending = harness.take("hd_lookup");
    editor.focus();
    if (pending) harness.reply(pending, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
    await harness.settle();
    outcomes.push(typing === null && delayed === null && pending !== null && harness.driver.snapshot().popupHidden);
    harness.close();
  }
  return { "nested open-shadow editors suppress activation and cancel delayed and pending candidate work":
    outcomes.every(Boolean) || outcomes };
}

async function pendingScanCase() {
  const harness = await createHarness();
  const window = harness.popup.ownerDocument.defaultView;
  const scan = (candidate) => {
    harness.driver.setScanCandidate(candidate);
    harness.driver.scanPointer({ target: window.document.body, clientX: 200, clientY: 200 });
  };
  scan(harness.candidate);
  const first = harness.take("hd_lookup");
  scan(harness.candidate);
  const duplicate = harness.take("hd_lookup");
  const otherAnchor = window.document.createElement("span");
  otherAnchor.textContent = harness.candidate.query;
  window.document.body.append(otherAnchor);
  const other = {
    ...harness.candidate,
    anchor: otherAnchor,
    sourceElements: [otherAnchor],
    scanEntries: [{ ...harness.candidate.scanEntries[0], node: otherAnchor.firstChild }],
  };
  scan(other);
  const newer = harness.take("hd_lookup");
  for (const request of [first, duplicate].filter(Boolean)) {
    harness.reply(request, { dictionaryCount: 1, results: [harness.term("old node")] });
  }
  await harness.settle();
  scan(other);
  const lateDuplicate = harness.take("hd_lookup");
  for (const request of [newer, lateDuplicate].filter(Boolean)) harness.reply(request, {}, false);
  await harness.settle();
  scan(other);
  const retry = harness.take("hd_lookup");
  if (retry) harness.reply(retry, { dictionaryCount: 1, results: [harness.term(other.query)] });
  await harness.settle();
  scan(other);
  const renderedDuplicate = harness.take("hd_lookup");
  const passed = first !== null && newer !== null && retry !== null
    && duplicate === null && lateDuplicate === null && renderedDuplicate === null
    && !harness.driver.snapshot().popupHidden;
  harness.close();
  return { "pending pointer candidates deduplicate by node and query without losing retries or newer ownership": passed };
}

async function definitionTextLookupCase() {
  function focusDisclosure(harness) {
    const document = harness.popup.ownerDocument;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Dictionary explanation";
    details.append(summary);
    harness.popup.append(details);
    summary.focus();
    return harness.popup.getRootNode().activeElement === summary;
  }

  function appendGlossary(harness, text, depth = 0) {
    const document = harness.popup.ownerDocument;
    const glossary = document.createElement("div");
    glossary.className = "gsm-hoshidicts-glossary-content";
    glossary.append(document.createTextNode("説明："));
    const term = document.createElement("span");
    term.textContent = text;
    glossary.append(term, document.createTextNode("です。"));
    harness.driver.popupAt(depth).querySelector(".gsm-hoshidicts-definitions").append(glossary);
    return { glossary, term, textNode: term.firstChild };
  }

  const hover = await createHarness();
  try {
    await hover.initialLookup();
    const parent = hover.driver.viewRequest();
    const first = appendGlossary(hover, "食用語");
    const focusedDisclosure = focusDisclosure(hover);
    const caretCalls = [];
    hover.popup.ownerDocument.caretPositionFromPoint = (_x, _y, options) => {
      caretCalls.push(options);
      return { offsetNode: first.textNode, offset: 0 };
    };
    const pointer = { clientX: 120, clientY: 80, target: first.term };
    hover.driver.onPopupMouseMove(pointer);
    await hover.settle();
    const request = hover.take("hd_lookup");
    if (request) hover.reply(request, { dictionaryCount: 1, results: [hover.term("食用語")] });
    await hover.settle();
    const childRequest = hover.driver.viewRequest(1);
    const nativeCaret = request?.request.text.startsWith("食用語")
      && request.request.scanLength === 9
      && caretCalls[0]?.shadowRoots?.[0] === first.glossary.getRootNode();
    const childContext = childRequest?.candidate;
    const context = childContext?.sourceDepth === 0
      && childContext.sentence === "説明：食用語です。"
      && childContext.matchOffset === 3
      && childContext.sourceElements?.[0] === first.glossary;
    const parentRetained = hover.driver.viewRequest() === parent
      && !hover.driver.snapshot().popupHidden
      && !hover.driver.snapshot(1).popupHidden;

    hover.driver.onPopupMouseMove(pointer);
    await hover.settle();
    const deduplicated = hover.take("hd_lookup") === null;

    const missing = appendGlossary(hover, "未登録語");
    hover.popup.ownerDocument.caretPositionFromPoint = () => ({
      offsetNode: missing.textNode,
      offset: 0,
    });
    hover.driver.onPopupMouseMove({ ...pointer, target: missing.term });
    await hover.settle();
    const miss = hover.take("hd_lookup");
    if (miss) hover.reply(miss, { dictionaryCount: 1, results: [] });
    await hover.settle();
    const missPreservedParent = miss?.request.text.startsWith("未登録語")
      && hover.driver.viewRequest() === parent
      && !hover.driver.snapshot().popupHidden
      && hover.driver.snapshot(1).popupHidden;

    hover.emitOptions({ popupNestingMaxDepth: 0 });
    hover.driver.onPopupMouseMove(pointer);
    await hover.settle();
    const depthLimited = hover.take("hd_lookup") === null && !hover.driver.popupAt(1);

    hover.emitOptions({ popupNestingMaxDepth: 1 });
    const chrome = hover.popup.ownerDocument.createElement("button");
    chrome.textContent = "食用語";
    hover.driver.popupAt(0).append(chrome);
    hover.popup.ownerDocument.caretPositionFromPoint = () => ({
      offsetNode: chrome.firstChild,
      offset: 0,
    });
    hover.driver.onPopupMouseMove({ ...pointer, target: chrome });
    await hover.settle();
    const glossaryOnly = hover.take("hd_lookup") === null;

    const internal = hover.popup.ownerDocument.createElement("a");
    internal.dataset.hoshidictsQuery = "食用語";
    internal.textContent = "食用語";
    first.glossary.append(internal);
    const linked = hover.render().context.onInternalLink({
      anchor: internal,
      query: "食用語",
    });
    const linkedRequest = hover.take("hd_lookup");
    if (linkedRequest) hover.reply(linkedRequest, {
      dictionaryCount: 1,
      results: [hover.term("食用語")],
    });
    await linked;
    hover.popup.ownerDocument.caretPositionFromPoint = () => ({
      offsetNode: internal.firstChild,
      offset: 0,
    });
    hover.driver.popupAt(0).dispatchEvent(
      new hover.popup.ownerDocument.defaultView.MouseEvent("mouseenter"),
    );
    hover.driver.onPopupMouseMove({ ...pointer, target: internal });
    await new Promise(resolve => setTimeout(resolve, 300));
    const explicitLink = hover.driver.resolveDefinitionCandidate(120, 80) === null
      && hover.take("hd_lookup") === null
      && !hover.driver.snapshot(1).popupHidden;

    const boundaryGlossary = hover.popup.ownerDocument.createElement("div");
    boundaryGlossary.className = "gsm-hoshidicts-glossary-content";
    const boundaryText = hover.popup.ownerDocument.createTextNode("食");
    const boundaryLink = hover.popup.ownerDocument.createElement("a");
    boundaryLink.dataset.hoshidictsQuery = "用語";
    boundaryLink.textContent = "用語";
    boundaryGlossary.append(boundaryText, boundaryLink);
    hover.driver.popupAt(0).querySelector(".gsm-hoshidicts-definitions")
      .append(boundaryGlossary);
    hover.popup.ownerDocument.caretPositionFromPoint = () => ({
      offsetNode: boundaryText,
      offset: 0,
    });
    const linkBoundary = hover.driver.resolveDefinitionCandidate(120, 80)?.query === "食";

    async function definitionLookup(onlyScanJapaneseText, text) {
      const language = await createHarness(
        { title: "Generic", kind: "term" },
        { options: { onlyScanJapaneseText } },
      );
      try {
        await language.initialLookup();
        const latin = appendGlossary(language, text);
        language.popup.ownerDocument.caretPositionFromPoint = () => ({
          offsetNode: latin.textNode,
          offset: 0,
        });
        language.driver.onPopupMouseMove({
          clientX: 120,
          clientY: 80,
          target: latin.term,
        });
        await language.settle();
        const lookup = language.take("hd_lookup");
        if (lookup) language.reply(lookup, { dictionaryCount: 1, results: [] });
        await language.settle();
        return lookup?.request.text ?? null;
      } finally {
        language.close();
      }
    }
    const japaneseOnly = await definitionLookup(true, "hello ") === null;
    const unrestrictedText = await definitionLookup(false, "hello ");
    const mixedNumeral = (await definitionLookup(true, "第1"))?.startsWith("第1です") === true;
    const firstDetails = {
      context,
      deduplicated,
      depthLimited,
      explicitLink,
      focusedDisclosure,
      glossaryOnly,
      japaneseOnly,
      mixedNumeral,
      linkBoundary,
      missPreservedParent,
      nativeCaret,
      parentRetained,
      unrestricted: unrestrictedText?.startsWith("hello") === true,
    };
    const firstResult = Object.values(firstDetails).every((value) => value === true);

    const activation = await createHarness();
    try {
      activation.emitOptions({
        activationKey: "Shift",
        lookupMode: "activation",
        popupNestingMaxDepth: 1,
      });
      activation.popup.ownerDocument.dispatchEvent(
        new activation.popup.ownerDocument.defaultView.KeyboardEvent("keydown", {
          bubbles: true,
          code: "ShiftLeft",
          key: "Shift",
          shiftKey: true,
        }),
      );
      const selection = activation.popup.ownerDocument.defaultView.getSelection();
      selection.selectAllChildren(activation.anchor);
      activation.popup.ownerDocument.dispatchEvent(
        new activation.popup.ownerDocument.defaultView.Event("selectionchange"),
      );
      const root = activation.take("hd_lookup");
      activation.popup.ownerDocument.dispatchEvent(
        new activation.popup.ownerDocument.defaultView.KeyboardEvent("keyup", {
          bubbles: true,
          code: "ShiftLeft",
          key: "Shift",
        }),
      );
      if (root) activation.reply(root, {
        dictionaryCount: 1,
        results: [activation.term(activation.candidate.query)],
      });
      await activation.settle();
      const definition = appendGlossary(activation, "食用語");
      const focusedActivationDisclosure = focusDisclosure(activation);
      activation.popup.ownerDocument.caretPositionFromPoint = () => ({
        offsetNode: definition.textNode,
        offset: 0,
      });
      const definitionPointer = {
        clientX: 120,
        clientY: 80,
        target: definition.term,
      };
      activation.driver.onPopupMouseMove(definitionPointer);
      await activation.settle();
      const gated = activation.take("hd_lookup") === null;
      activation.popup.ownerDocument.dispatchEvent(
        new activation.popup.ownerDocument.defaultView.KeyboardEvent("keydown", {
          bubbles: true,
          code: "ShiftLeft",
          key: "Shift",
          shiftKey: true,
        }),
      );
      await activation.settle();
      const stationary = activation.take("hd_lookup");
      if (stationary) activation.reply(stationary, { dictionaryCount: 1, results: [] });
      await activation.settle();
      return {
        "definition text uses native closed-shadow caret scanning and preserves its parent popup":
          firstResult || firstDetails,
        "definition text inherits Japanese gating, depth limits and stationary activation":
          focusedActivationDisclosure && gated && stationary?.request.text.startsWith("食用語"),
        ...await definitionTriggerCases(),
      };
    } finally {
      activation.close();
    }
  } finally {
    hover.close();
  }

  // Issue #355: a Hover reader can make definition text wait for the
  // activation key or a click while page lookups stay key-free.
  async function definitionTriggerCases() {
    // The harness's stored lookup settings, so a live edit changes only the trigger.
    const stored = { lookupMode: "hover", maxResults: 7, scanLength: 9,
      frequencyDictionary: "Frequency A", frequencyOrder: "descending",
      kanjiClickDictionary: { title: "Generic", kind: "term" } };
    async function open(definitionLookupMode) {
      const harness = await createHarness(undefined, { options: { definitionLookupMode } });
      await harness.initialLookup();
      const word = appendGlossary(harness, "食用語");
      const document = harness.popup.ownerDocument;
      const window = document.defaultView;
      document.caretPositionFromPoint = () => ({ offsetNode: word.textNode, offset: 0 });
      return {
        harness, word, window,
        pointer: { clientX: 120, clientY: 80, target: word.term },
        shift: (type) => document.dispatchEvent(new window.KeyboardEvent(type, {
          bubbles: true, code: "ShiftLeft", key: "Shift", shiftKey: type === "keydown",
        })),
        click(target, [x, y], [releaseX, releaseY] = [x, y]) {
          target.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }));
          target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0, clientX: releaseX, clientY: releaseY }));
        },
        lookups: () => harness.pending.filter(({ request }) => request.type === "hd_lookup").length,
      };
    }
    const results = {};

    const keyed = await open("activation");
    try {
      const { harness } = keyed;
      harness.driver.onPopupMouseMove(keyed.pointer);
      await harness.settle();
      const keyless = keyed.lookups() === 0 && !harness.driver.popupAt(1);
      keyed.shift("keydown");
      await harness.settle();
      const sent = keyed.lookups();
      const stationary = harness.take("hd_lookup");
      if (stationary) harness.reply(stationary, { dictionaryCount: 1, results: [harness.term("食用語")] });
      await harness.settle();
      const opened = sent === 1 && stationary?.request.text.startsWith("食用語") === true
        && !harness.driver.snapshot(1).popupHidden;
      keyed.shift("keyup");
      harness.driver.onPopupMouseMove(keyed.pointer);
      await harness.settle();
      const released = keyed.lookups() === 0 && !harness.driver.snapshot(1).popupHidden;
      harness.driver.hide();
      harness.driver.setScanCandidate(harness.candidate);
      harness.driver.onMouseMove({ clientX: 300, clientY: 300, target: harness.anchor });
      await harness.settle();
      const page = harness.take("hd_lookup")?.request.text === harness.candidate.query;
      results["definition text can require the activation key in Hover mode"] =
        keyless && opened && released && page || { keyless, sent, opened, released, page };
    } finally { keyed.harness.close(); }

    const clicked = await open("click");
    try {
      const { harness, word, window } = clicked;
      harness.driver.onPopupMouseMove(clicked.pointer);
      harness.driver.onPopupMouseMove({ ...clicked.pointer, shiftKey: true });
      clicked.shift("keydown");
      await harness.settle();
      clicked.shift("keyup");
      const hoverless = clicked.lookups() === 0 && !harness.driver.popupAt(1);
      clicked.click(word.term, [120, 80]);
      await harness.settle();
      const request = harness.take("hd_lookup");
      // Moving over the parent does not cancel a click child that is still loading.
      harness.driver.onPopupMouseMove({ ...clicked.pointer, target: word.glossary });
      await harness.settle();
      if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term("食用語")] });
      await harness.settle();
      const opened = request?.request.text.startsWith("食用語") === true && !harness.driver.snapshot(1).popupHidden
        && harness.driver.viewRequest(1)?.candidate.sourceDepth === 0;
      clicked.click(word.term, [110, 80], [120, 80]);
      await harness.settle();
      const dragged = clicked.lookups() === 0 && !harness.driver.popupAt(1);
      const root = harness.popup.getRootNode();
      root.getSelection = () => ({ isCollapsed: false, anchorNode: word.textNode });
      clicked.click(word.term, [120, 80]);
      delete root.getSelection;
      await harness.settle();
      const selected = clicked.lookups() === 0;
      // A disclosure keeps its own click, even over Japanese text.
      const details = window.document.createElement("details");
      const summary = window.document.createElement("summary");
      summary.textContent = "食用語";
      details.append(summary);
      word.glossary.append(details);
      window.document.caretPositionFromPoint = () => ({ offsetNode: summary.firstChild, offset: 0 });
      clicked.click(summary, [120, 80]);
      await harness.settle();
      const disclosure = clicked.lookups() === 0;
      // A dictionary link still routes through its own handler, exactly once.
      const link = window.document.createElement("a");
      link.dataset.hoshidictsQuery = "食用語";
      link.textContent = "食用語";
      word.glossary.append(link);
      let linkClicks = 0;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        linkClicks += 1;
        harness.render().context.onInternalLink({ anchor: link, query: "食用語" });
      });
      clicked.click(link, [120, 80]);
      await harness.settle();
      const linkSent = clicked.lookups();
      const linkRequest = harness.take("hd_lookup");
      if (linkRequest) harness.reply(linkRequest, { dictionaryCount: 1, results: [harness.term("食用語")] });
      await harness.settle();
      const linked = linkClicks === 1 && linkSent === 1 && linkRequest?.request.text === "食用語"
        && !harness.driver.snapshot(1).popupHidden;
      window.document.caretPositionFromPoint = () => ({ offsetNode: word.textNode, offset: 0 });
      harness.emitOptions({ ...stored, definitionLookupMode: "click", popupNestingMaxDepth: 0 });
      clicked.click(word.term, [120, 80]);
      await harness.settle();
      const depthLimited = clicked.lookups() === 0 && !harness.driver.popupAt(1);
      results["definition text can open child popups on click only"] =
        hoverless && opened && dragged && selected && disclosure && linked && depthLimited
        || { hoverless, opened, dragged, selected, disclosure, linked, depthLimited };
    } finally { clicked.harness.close(); }

    const live = await open("inherit");
    try {
      const { harness } = live;
      harness.driver.onPopupMouseMove(live.pointer);
      await harness.settle();
      const request = harness.take("hd_lookup");
      const pending = request !== null && harness.driver.snapshot(1).popupHidden;
      harness.emitOptions({ ...stored, definitionLookupMode: "click" });
      const cancelled = !harness.driver.popupAt(1);
      if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term("食用語")] });
      await harness.settle();
      results["changing the child popup trigger cancels a pending definition hover"] =
        pending && cancelled && !harness.driver.popupAt(1) || { pending, cancelled };
    } finally { live.harness.close(); }
    return results;
  }
}

describe("content script: scanning and selections", () => {
  test("scanning and selections", async () => {
    const noteContent = await contentNoteStage({
      scanning: async () => ({ ...await pendingScanCase(), ...await definitionTextLookupCase(), ...await scanExtractionCase(), ...await sentenceBoundaryCase(), ...await longKeyWindowCase(), ...await hoverGlyphCase(), ...await googleDocsCase(), ...await textFieldCase(), ...await matchedAnchorCase(), ...await popupWheelCase(), ...await movedMatchEndpointCase(),
        ...await autofocusedSearchCase(), ...await focusedEditingCase(), ...await shadowEditingCase(),
        ...await exactSelectionCase(), ...await selectionSentenceCase(), ...await selectedWordEditorCase(), ...await selectionActivationCase(),
        ...await selectionCancellationCase(), ...await selectionRecoveryCase(),
        ...await releasedSelectionDragCase(),
        ...await selectedTextCase(), ...await selectionDescriptorCase(), ...await selectionInvalidationCase(),
        ...await selectionLanguageCase(), ...await selectionNoticeCase(), ...await personalDictionaryOffCase(),
        ...await selectionEditingCase(), ...await popupSelectionCase() }),
    });
    for (const [name, passed] of Object.entries(noteContent?.scanning ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });
});
