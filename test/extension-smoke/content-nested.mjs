/*
 * The content script's media ownership and nested popups.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
import { genericPackage } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function inheritedTabsCase() {
  const outcomes = [];
  for (const kind of ["term", "kanji"]) {
    for (const selection of [{ dictionary: "Generic" }, { groupId: "study" }, { favourites: true }]) {
      const harness = await createHarness({ title: "Generic", kind }, { options: { scanLength: 2 } });
      await harness.initialLookup();
      const dictionaries = harness.driver.snapshot().dictionaries;
      const memberId = dictionaries[0].id;
      harness.emitState({ revision: 2, dictionaries,
        groups: [{ id: "study", name: "Study", dictionaryIds: [memberId, "missing", memberId] }] });
      harness.render().context.onDictionaryTabSelected(selection);
      const parent = harness.driver.viewRequest();
      const operation = harness.internalLink({ query: "child", primaryReading: "reading" });
      const pending = harness.take("hd_lookup");
      harness.emitState({ revision: 3, dictionaries,
        groups: [{ id: "study", name: "Latest group", dictionaryIds: [memberId] }] });
      harness.emitState({ revision: 2, dictionaries, groups: [] });
      harness.reply(pending, { dictionaryCount: 1, results: [harness.term("ch"), harness.term("child")] });
      await operation;
      const child = harness.driver.viewRequest(1);
      const childContext = harness.render(1).context;
      const sameSelection = (value) => JSON.stringify(value) === JSON.stringify(selection);
      const unfiltered = childContext.selectedDictionaryTab === null
        && child.selectedDictionaryTab === null && sameSelection(parent.selectedDictionaryTab)
        && pending.request.scanLength === 5
        && harness.render(1).results.length === 1 && harness.render(1).results[0].matched === "child"
        && JSON.stringify(childContext.dictionaryTabGroups) === JSON.stringify([
          { id: "study", name: "Latest group", dictionaries: ["Generic"] },
        ]);
      childContext.onDictionaryTabSelected(selection);
      const clicked = harness.callbacks(1).onKanjiClick("食");
      const request = harness.take(kind === "term" ? "hd_lookup_dictionary" : "hd_kanji");
      harness.reply(request, kind === "term"
        ? { dictionaryCount: 1, results: [harness.term("食")] }
        : { kanji: { character: "食", entries: [{ dictionary: "Generic" }] } });
      await clicked;
      const clickedRequest = harness.driver.viewRequest(1);
      const clickedContext = harness.render(1).context;
      const copied = sameSelection(clickedContext.selectedDictionaryTab)
        && clickedRequest.selectedDictionaryTab !== child.selectedDictionaryTab;
      clickedContext.onDictionaryTabSelected?.(null);
      const independent = clickedRequest.selectedDictionaryTab === null
        && sameSelection(child.selectedDictionaryTab) && sameSelection(parent.selectedDictionaryTab);
      const beforeBack = harness.sent.length;
      await clickedContext.onBack();
      outcomes.push(unfiltered && copied && independent && harness.sent.length === beforeBack
        && harness.driver.viewRequest(1) === child && sameSelection(harness.render(1).context.selectedDictionaryTab));
      harness.close();
    }
  }
  return { "internal links show all dictionaries while clicked-kanji and Back retain independently selected tabs": outcomes.every(Boolean) };
}

async function nestedLevelsCase() {
  const harness = await createHarness();
  await harness.initialLookup();
  const parent = harness.driver.viewRequest();
  const parentContext = harness.render().context;
  const open = async (query, depth = 0) => {
    const operation = harness.internalLink({ query, primaryReading: "reading" }, depth);
    const request = harness.take("hd_lookup");
    if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term(query)] });
    await operation;
    return request;
  };
  await open("child");
  const child = harness.driver.viewRequest(1);
  const childAnchor = child.candidate.anchor;
  const childPopup = harness.driver.popupAt(1);
  let ancestorLayouts = 0;
  const anchorRect = harness.anchor.getBoundingClientRect.bind(harness.anchor);
  harness.anchor.getBoundingClientRect = () => { ancestorLayouts += 1; return anchorRect(); };
  harness.callbacks(1).positionPopup();
  harness.popup.dispatchEvent(new harness.anchor.ownerDocument.defaultView.Event("scroll"));
  const layoutStartsAtOwner = ancestorLayouts === 0;
  const childRect = { left: Number.parseFloat(childPopup.style.left), top: Number.parseFloat(childPopup.style.top),
    width: Number.parseFloat(childPopup.style.width), height: Number.parseFloat(childPopup.style.height) };
  const positioned = Object.values(childRect).every(Number.isFinite)
    && childRect.left >= 6 && childRect.top >= 6
    && childRect.left + childRect.width <= harness.anchor.ownerDocument.defaultView.innerWidth - 6
    && childRect.top + childRect.height <= harness.anchor.ownerDocument.defaultView.innerHeight - 6;
  const childContext = harness.render(1).context;
  const count = harness.sent.length;
  await parentContext.onInternalLink({ query: "child", primaryReading: "reading", anchor: childAnchor });
  const deduped = harness.sent.length === count && harness.driver.viewRequest(1) === child;
  const close = harness.anchor.ownerDocument.createElement("button");
  close.className = "gsm-hoshidicts-popup-close";
  childPopup.append(close);
  await parentContext.onInternalLink({
    query: "child", primaryReading: "reading", anchor: childAnchor, focusChild: true,
  });
  const reusedChildFocused = childAnchor.getRootNode().activeElement === close;
  await open("grandchild", 1);
  const grandchildContext = harness.render(2).context;
  await open("great-grandchild", 2);
  harness.edit(true, 3);
  let pruneThrew = false;
  try { harness.callbacks(1).onBeforeResultsRendered(); } catch { pruneThrew = true; }
  const prunedOnlyBelow = !harness.driver.popupAt(2) && harness.driver.viewRequest(1) === child
    && parentContext.isCurrentRequest() && childContext.isCurrentRequest() && !grandchildContext.isCurrentRequest() && !pruneThrew;
  const clicked = harness.callbacks(1).onKanjiClick("食");
  const kanjiRequest = harness.take("hd_lookup_dictionary");
  harness.reply(kanjiRequest, { dictionaryCount: 1, results: [harness.term("食")] });
  await clicked;
  const relink = parentContext.onInternalLink({ query: "child", primaryReading: "reading", anchor: childAnchor });
  const relinkRequest = harness.take("hd_lookup");
  if (relinkRequest) harness.reply(relinkRequest, { dictionaryCount: 1, results: [harness.term("child")] });
  await relink;
  const reactivated = relinkRequest?.request.text === "child" && harness.driver.viewRequest(1)?.kind === "term";
  const currentChild = harness.driver.viewRequest(1);
  const clickedAgain = harness.callbacks(1).onKanjiClick("食");
  harness.reply(harness.take("hd_lookup_dictionary"), { dictionaryCount: 1, results: [harness.term("食")] });
  await clickedAgain;
  await harness.render(1).context.onBack();
  const childBack = harness.driver.viewRequest(1) === currentChild && harness.driver.viewRequest() === parent;
  harness.driver.popupAt(1).tabIndex = -1;
  harness.driver.popupAt(1).focus();
  await harness.render(1).context.onClose();
  const returned = !harness.driver.popupAt(1) && harness.driver.viewRequest() === parent
    && childAnchor.getRootNode().activeElement === childAnchor;
  ancestorLayouts = 0;
  harness.popup.dispatchEvent(new harness.anchor.ownerDocument.defaultView.Event("scroll"));
  const rootOnlyScroll = ancestorLayouts === 0;
  harness.emitOptions({ popupNestingMaxDepth: 0 });
  const disabled = await open("disabled") === null && !harness.driver.popupAt(1);
  harness.emitOptions({ popupNestingMaxDepth: 2 });
  await open("one");
  await open("two", 1);
  const limited = await open("three", 2) === null && !harness.driver.popupAt(3);
  harness.emitOptions({ popupNestingMaxDepth: 1 });
  const lowered = !harness.driver.popupAt(2) && !harness.driver.snapshot(1).popupHidden
    && harness.driver.viewRequest() === parent;
  const window = harness.anchor.ownerDocument.defaultView;
  window.innerWidth = 12;
  harness.callbacks(1).positionPopup();
  const shrunk = !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden;
  const noViewport = await open("no viewport") === null && !harness.driver.popupAt(1);
  harness.close();
  return {
    "linked levels preserve independent Back and render owners, deduplicate, and prune only descendants":
      deduped && reusedChildFocused && prunedOnlyBelow && reactivated && childBack && returned,
    "child popup depth is live and child geometry is clamped to the viewport": positioned && layoutStartsAtOwner && rootOnlyScroll
      && disabled && limited && lowered && shrunk && noViewport,
  };
}

async function livePresentationCase() {
  const harness = await createHarness();
  const checks = [];
  const name = "presentation-only state adopts newest labels without invalidating requests or pending child anchors";
  try {
    await harness.initialLookup();
    const request = harness.driver.viewRequest();
    const render = harness.render();
    const snapshot = harness.driver.snapshot();
    const presentation = { schemaVersion: 1, revision: 2,
      dictionaries: snapshot.dictionaries.map(dictionary => ({ ...dictionary, displayName: "Live alias", favorite: false })),
      groups: [{ id: "live", name: "Live group", dictionaryIds: [snapshot.dictionaries[0].id] }],
    };
    const sent = harness.sent.length;
    harness.emitState(presentation);
    checks.push(harness.render() === render && harness.driver.viewRequest() === request && render.context.isCurrentRequest()
      && !harness.driver.snapshot().popupHidden && harness.sent.length === sent
      && harness.presentations().at(-1)?.dictionaryPresentation[0].displayName === "Live alias"
      && harness.presentations().at(-1)?.dictionaryTabGroups[0].dictionaries[0] === "Generic");
    harness.emitState(presentation);
    harness.emitState({ ...presentation, revision: 1 });
    checks.push(harness.presentations().length === 1);
    const child = harness.internalLink({ query: "pending child" });
    const pending = harness.take("hd_lookup");
    if (!pending) return { [name]: false };
    const anchor = harness.popup.lastElementChild;
    harness.emitState({ ...presentation, revision: 3, groups: [] });
    checks.push(harness.driver.popupAt(1)?.hidden === true && anchor.isConnected && render.context.isCurrentRequest()
      && harness.callbacks().canProjectDictionaryPresentation?.() === false);
    harness.reply(pending, { dictionaryCount: 1, results: [harness.term("pending child")] });
    await child;
    checks.push(harness.render(1).context.dictionaryTabGroups.length === 0 && !harness.driver.snapshot(1).popupHidden);
    const flushes = harness.presentationFlushes();
    harness.render(1).context.onClose();
    checks.push(!harness.driver.popupAt(1) && harness.callbacks().canProjectDictionaryPresentation?.() === true
      && harness.presentationFlushes() > flushes);
    const resizeChild = harness.internalLink({ query: "resize child" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("resize child")] });
    await resizeChild;
    harness.emitState({ ...presentation, revision: 4 });
    const beforeResizeFlush = harness.presentationFlushes();
    Object.defineProperty(harness.popup.ownerDocument.defaultView, "innerWidth", { configurable: true, value: 10 });
    harness.callbacks().positionPopup();
    await harness.settle();
    checks.push(!harness.driver.popupAt(1) && harness.presentationFlushes() > beforeResizeFlush);
    harness.edit(true);
    harness.emitState({ ...presentation, revision: 5 });
    checks.push(harness.callbacks().canProjectDictionaryPresentation?.() === false && render.context.isCurrentRequest());
    harness.edit(false);
    const updates = harness.presentations().length;
    harness.emitState({ ...presentation, revision: 6, groups: [] }, { revision: 99, maxResults: 99 });
    checks.push(harness.presentations().length === updates && !render.context.isCurrentRequest());

    for (const update of ["contents", "alias", "options", "metadata", "mode"]) {
      const combined = await createHarness();
      try {
        await combined.initialLookup();
        const current = combined.render().context;
        const options = { revision: 1, frequencyDictionary: "Frequency A", frequencyOrder: "descending",
          kanjiClickDictionary: { title: "Generic", kind: "term" }, maxResults: 7, scanLength: 9,
          showCompactDefinitionSummary: update !== "metadata", averageFrequency: true,
          showFrequencyDictionaryNames: false, compactFrequencyNumbers: true, showPitchAccentFurigana: false,
          pitchAccentFuriganaDictionary: "Preferred pitch", pitchAccentFuriganaStyle: "overline", showPitchAccentBadge: false,
          showPitchAccentDictionaryNames: false, showPitchAccentText: false, showPitchAccentPosition: false,
          showPitchAccentGraph: true, hidePopupGrammarTags: true };
        const before = combined.sent.length;
        if (update === "options" || update === "metadata") combined.emitOptions(options);
        else combined.emitState({ schemaVersion: 1, revision: 2, groups: [],
          dictionaries: combined.driver.snapshot().dictionaries.map(dictionary => ({ ...dictionary,
            ...(update === "contents" ? { path: "/dicts/replacement/Generic", revision: "replacement" }
              : update === "mode" ? { frequencyMode: "rank-based" } : { displayName: "Combined alias" }),
          })),
        }, update === "mode" ? undefined : options);
        if (update === "contents") {
          checks.push(combined.presentations().length === 0 && !current.isCurrentRequest()
            && combined.driver.snapshot().popupHidden);
        } else {
          const presentations = combined.presentations();
          checks.push(presentations.length === 1 && current.isCurrentRequest() && !combined.driver.snapshot().popupHidden
            && combined.sent.length === before
            && (update === "mode"
              ? presentations[0].dictionaryPresentation[0].frequencyMode === "rank-based"
              : presentations[0].showCompactDefinitionSummary === options.showCompactDefinitionSummary
                && Object.entries(combined.popup.ownerDocument.defaultView.HDPopup.metadataOptions(options))
                  .every(([key, value]) => presentations[0][key] === value))
            && (update !== "alias" || presentations[0].dictionaryPresentation[0].displayName === "Combined alias"));
        }
      } finally { combined.driver.teardown(); combined.close(); }
    }

    for (const update of ["membership", "summary"]) {
      const detached = await createHarness();
      try {
        const installed = detached.driver.snapshot().dictionaries;
        const state = { schemaVersion: 1, revision: 2,
          dictionaries: [...installed, genericPackage({ id: "other-id", title: "Other", path: "/dicts/Other" })],
          groups: [{ id: "g", name: "Group", dictionaryIds: [installed[0].id] }],
        };
        detached.emitState(state);
        await detached.initialLookup();
        detached.render().context.onDictionaryTabSelected({ groupId: "g" });
        // A placed root outlives its page source (#402), so the detached
        // ancestor is a child pane whose link text leaves the root.
        const parentOperation = detached.internalLink({ query: "orphan parent" });
        const parentResult = detached.term("orphan parent");
        Object.assign(parentResult.term, { frequencies: [], pitches: [] });
        detached.reply(detached.take("hd_lookup"), { dictionaryCount: 1, results: [parentResult] });
        await parentOperation;
        const parentPopup = detached.driver.popupAt(1);
        const parentSource = detached.driver.viewRequest(1).candidate.anchor;
        const operation = detached.internalLink({ query: "orphan child" }, 1);
        const result = detached.term("orphan child");
        Object.assign(result.term, { frequencies: [], pitches: [] });
        if (update === "summary") result.term.glossaries[0].glossary = JSON.stringify([
          { type: "image", path: "leading.png" }, "child definition",
        ]);
        result.term.glossaries.push({ dictionary: "Other", glossary: "other definition" });
        detached.reply(detached.take("hd_lookup"), { dictionaryCount: 2, results: [result] });
        await operation;
        const childRender = detached.render(2);
        const childPopup = detached.driver.popupAt(2);
        const callbacks = detached.callbacks(2);
        const fills = [];
        let allowed = null;
        let permissionChecks = 0;
        let summaryImages = 0;
        const view = detached.createLayoutView({ ...callbacks,
          appendTextOnlyGlossary(_document, _container, _glossary, context) { fills.push(context.dictionary); },
          appendStructuredImage() { summaryImages += 1; },
          canUpdateCompactSummary() {
            permissionChecks += 1;
            allowed = callbacks.canUpdateCompactSummary?.();
            return allowed;
          },
          canProjectDictionaryPresentation() {
            permissionChecks += 1;
            allowed = callbacks.canProjectDictionaryPresentation();
            return allowed;
          },
        });
        childRender.context.onDictionaryTabSelected({ groupId: "g" });
        view.renderResults(childRender.results, childRender.candidate,
          { ...childRender.context, selectedDictionaryTab: { groupId: "g" } });
        const beforeFills = fills.length;
        detached.anchor.remove();
        parentSource.remove();
        const connectedChildSource = childRender.candidate.anchor.isConnected;
        if (update === "membership") {
          detached.emitState({ ...state, revision: 3,
            groups: [{ id: "g", name: "Group", dictionaryIds: ["other-id"] }],
          });
        } else {
          detached.emitOptions({ frequencyDictionary: "Frequency A", frequencyOrder: "descending",
            kanjiClickDictionary: { title: "Generic", kind: "term" }, maxResults: 7, scanLength: 9,
            showCompactDefinitionSummary: true });
        }
        // The content harness records this storage delivery; run it through
        // the attached real renderer and its actual content owner predicate.
        const delivered = detached.presentations(2).at(-1);
        view.updateDictionaryPresentation(delivered);
        checks.push(beforeFills === 1 && connectedChildSource && allowed === false
          && !detached.driver.snapshot().popupHidden && !detached.driver.popupAt(1)
          && parentPopup.hidden && childPopup.hidden && fills.length === beforeFills && summaryImages === 0);
        const checked = permissionChecks;
        view.flushDictionaryPresentation();
        view.updateDictionaryPresentation(delivered);
        checks.push(permissionChecks === checked && fills.length === beforeFills);
      } finally { detached.driver.teardown(); detached.close(); }
    }

    const detachedRoot = await createHarness();
    try {
      await detachedRoot.initialLookup();
      detachedRoot.anchor.remove();
      checks.push(detachedRoot.callbacks().canProjectDictionaryPresentation() === true
        && !detachedRoot.driver.snapshot().popupHidden);
    } finally { detachedRoot.driver.teardown(); detachedRoot.close(); }
    return { [name]: checks.every(Boolean) || checks };
  } finally { harness.close(); }
}

async function nestedResizeCase() {
  const harness = await createHarness();
  const window = harness.anchor.ownerDocument.defaultView;
  const views = [];
  const frames = new Map();
  const observers = [];
  let nextFrame = 0;
  let layouts = 0;
  let popupReads = 0;
  let rootReads = 0;
  let rootPlacements = 0;
  let queueDuringLayout = false;
  const initialMasonryReads = [];
  let recordMasonryReads = true;
  const frame = () => {
    for (const [id, callback] of [...frames]) {
      if (!frames.delete(id)) continue;
      callback();
    }
  };
  try {
    await harness.initialLookup();
    for (let depth = 0; depth < 3; depth += 1) {
      const operation = harness.internalLink({ query: `level-${depth + 1}` }, depth);
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term(`level-${depth + 1}`)] });
      await operation;
    }
    window.innerWidth = 2400;
    window.innerHeight = 700;
    window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
    window.cancelAnimationFrame = id => frames.delete(id);
    window.ResizeObserver = class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() {}
    };
    const rootRect = harness.anchor.getBoundingClientRect.bind(harness.anchor);
    harness.anchor.getBoundingClientRect = () => { rootReads += 1; return rootRect(); };
    // The root is re-placed from the rect it opened at, never re-measured (#402).
    const rootStyle = harness.driver.popupAt(0).style;
    Object.defineProperty(rootStyle, "left", { configurable: true,
      get() { return this.getPropertyValue("left"); },
      set(value) { rootPlacements += 1; this.setProperty("left", value); } });
    for (let depth = 0; depth < 4; depth += 1) {
      const popup = harness.driver.popupAt(depth);
      popup.getBoundingClientRect = () => {
        popupReads += 1;
        const left = Number.parseFloat(popup.style.left);
        const top = Number.parseFloat(popup.style.top);
        const width = Number.parseFloat(popup.style.width);
        const height = Number.parseFloat(popup.style.height);
        return { left, top, width, height, right: left + width, bottom: top + height };
      };
      const grid = window.document.createElement("div");
      grid.className = "gsm-hoshidicts-glossary-grid";
      // No stylesheet here: masonry reads the grid gap reader.css would give it.
      grid.style.columnGap = "8px";
      grid.append(window.document.createElement("div"), window.document.createElement("div"));
      for (const card of grid.children) {
        Object.defineProperty(card, "offsetHeight", { get() {
          if (recordMasonryReads) initialMasonryReads.push({
            widths: [...grid.children].map(child => child.style.width),
            transforms: [...grid.children].map(child => child.style.transform),
          });
          return 0;
        } });
      }
      Object.defineProperty(grid, "clientWidth", { get: () => Number.parseFloat(popup.style.width) });
      popup.append(grid);
      // Real per-view resize/masonry callbacks, bound to the real content
      // owners; the request harness continues to own only lookup replies.
      views.push(harness.createLayoutView({ ...harness.callbacks(depth),
        getPopupColumns() {
          layouts += 1;
          if (depth === 0 && queueDuringLayout) {
            queueDuringLayout = false;
            views[0].scheduleMasonry();
          }
          return 2;
        } }));
    }
    window.dispatchEvent(new window.Event("resize"));
    const oneBatch = frames.size === 1 && layouts === 0;
    frame();
    recordMasonryReads = false;
    // Placement measures each child's source text, never the panes themselves.
    const resize = layouts === 4 && rootReads === 0 && rootPlacements === 1 && popupReads === 0 && frames.size === 0
      && initialMasonryReads.length === 8 && initialMasonryReads.every(read =>
        read.widths.every(width => width !== "" && width === read.widths[0])
        && read.transforms.every(transform => transform === ""))
      && [0, 1, 2, 3].every(depth => {
        const popup = harness.driver.popupAt(depth);
        return Number.parseFloat(popup.style.left) >= 6
          && Number.parseFloat(popup.style.left) + Number.parseFloat(popup.style.width) <= 2394
          && popup.querySelector(".gsm-hoshidicts-glossary-grid").style.height !== "";
      });
    window.innerWidth = 500;
    window.dispatchEvent(new window.Event("resize"));
    frame();
    layouts = 0; rootReads = 0; rootPlacements = 0; popupReads = 0;
    observers.forEach(observer => observer.callback());
    frame();
    const observerFollowup = layouts === 4 && rootReads === 0 && rootPlacements === 1 && popupReads === 0 && frames.size === 0
      && [0, 1, 2, 3].every(depth => {
        const popup = harness.driver.popupAt(depth);
        const card = popup.querySelector(".gsm-hoshidicts-glossary-grid").firstElementChild;
        return Number.parseFloat(popup.style.width) === 488 && Number.parseFloat(card.style.width) === 240;
      });

    // A queued root resize still places the surviving chain after a child
    // retires; a queued retired child cannot target its depth replacement.
    const childCallbacks = harness.callbacks(1);
    views[0].scheduleMasonry();
    harness.emitOptions({ popupNestingMaxDepth: 0 });
    rootReads = 0; rootPlacements = 0; popupReads = 0;
    frame();
    const rootSurvivesPrune = rootReads === 0 && rootPlacements === 1 && popupReads === 0;
    childCallbacks.queueMasonry(() => { layouts += 1; });
    const retiredIgnored = frames.size === 0;
    rootReads = 0; rootPlacements = 0; layouts = 0;
    views[0].scheduleMasonry();
    views[0].scheduleMasonry();
    frame();
    const rootSameFrame = layouts === 1 && rootReads === 0 && rootPlacements === 1 && frames.size === 0;

    // Work queued while a batch runs belongs to the next frame, not this
    // snapshot. The native observer-width followup is checked separately.
    layouts = 0; rootReads = 0; rootPlacements = 0;
    queueDuringLayout = true;
    views[0].scheduleMasonry();
    frame();
    const nextBatchQueued = layouts === 1 && rootReads === 0 && rootPlacements === 1 && frames.size === 1;
    frame();
    const nextBatchCompleted = layouts === 2 && rootReads === 0 && rootPlacements === 2 && frames.size === 0;

    harness.emitOptions({ popupNestingMaxDepth: 1 });
    const child = harness.internalLink({ query: "replacement" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("replacement")] });
    await child;
    const retiring = harness.callbacks(1);
    const retiringView = harness.createLayoutView(retiring);
    views.push(retiringView);
    retiringView.scheduleMasonry();
    const childQueued = frames.size === 1;
    harness.render(1).context.onClose();
    const retiredCancelled = frames.size === 0;
    const replacement = harness.internalLink({ query: "same depth" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("same depth")] });
    await replacement;
    retiring.queueMasonry(() => { layouts += 1; });
    const replacementUntouched = frames.size === 0;
    let childLayouts = 0;
    const replacementView = harness.createLayoutView({ ...harness.callbacks(1),
      getPopupColumns() { childLayouts += 1; return 2; } });
    views.push(replacementView);
    layouts = 0; rootReads = 0; rootPlacements = 0;
    views[0].scheduleMasonry();
    replacementView.scheduleMasonry();
    replacementView.destroy();
    frame();
    const liveDestroyPreservesRoot = childLayouts === 0 && layouts === 1
      && rootReads === 0 && rootPlacements === 1 && frames.size === 0;
    const soleView = harness.createLayoutView(harness.callbacks(1));
    views.push(soleView);
    soleView.scheduleMasonry();
    soleView.destroy();
    const liveDestroyCancelsFrame = frames.size === 0;
    views[0].scheduleMasonry();
    harness.driver.onKeyDown({ key: "Escape", code: "Escape", repeat: false, stopPropagation() {} });
    // First Escape closes the unfocused child; the next dismisses the root.
    harness.driver.onKeyDown({ key: "Escape", code: "Escape", repeat: false, stopPropagation() {} });
    const hiddenCancelled = frames.size === 0;
    await harness.initialLookup();
    const next = harness.internalLink({ query: "teardown" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("teardown")] });
    await next;
    views[0].scheduleMasonry();
    harness.driver.teardown();
    const teardownCancelled = frames.size === 0;
    return { "viewport and observer layout place a popup chain linearly and retire queued owners":
      oneBatch && resize && observerFollowup && rootSurvivesPrune && retiredIgnored && rootSameFrame
      && nextBatchQueued && nextBatchCompleted && liveDestroyPreservesRoot && liveDestroyCancelsFrame
      && childQueued && retiredCancelled && replacementUntouched && hiddenCancelled && teardownCancelled };
  } finally {
    views.forEach(view => view.destroy());
    harness.close();
  }
}

async function columnPreferenceCase() {
  const harness = await createHarness();
  try {
    // Use one complete default option snapshot before starting either
    // request, so the later event changes columns alone.
    harness.emitOptions({});
    await harness.initialLookup();
    const linked = harness.internalLink({ query: "columns child" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("columns child")] });
    await linked;
    harness.edit(true, 1);
    const panes = [0, 1].map(depth => ({
      popup: harness.driver.popupAt(depth), request: harness.driver.viewRequest(depth),
      context: harness.render(depth).context,
    }));
    const defaultColumns = [0, 1].every(depth => harness.callbacks(depth).getPopupColumns() === 1);
    const sentBefore = harness.sent.length;
    harness.emitOptions({ popupColumns: 4 });
    harness.emitOptions({ popupColumns: 4 });
    const columns =
      defaultColumns && harness.sent.length === sentBefore && harness.driver.snapshot(1).noteEditing
      && panes.every(({ popup, request, context }, depth) =>
        harness.callbacks(depth).getPopupColumns() === 4 && harness.stats(depth).layoutSchedules === 1
        && harness.driver.popupAt(depth) === popup && !popup.hidden
        && harness.driver.viewRequest(depth) === request && context.isCurrentRequest());
    harness.emitOptions({ popupColumns: 4, popupWidthPx: 640, popupHeightPx: 500 });
    const resized = panes.every(({ popup }, depth) => popup.style.width === "640px"
      && popup.style.height === "500px" && harness.stats(depth).layoutWidth === "640px"
      && harness.stats(depth).layoutSchedules === 2);
    let toolbar = true;
    for (const edge of ["bottom", "top", "auto"]) {
      harness.emitOptions({ popupColumns: 4, popupWidthPx: 640, popupHeightPx: 500, popupToolbarPosition: edge });
      toolbar &&= panes.every(({ popup }, depth) => popup.dataset.toolbarPosition === (edge === "auto" ? "top" : edge)
        && harness.stats(depth).layoutSchedules === 2);
    }
    const colour = { popupColumns: 4, popupWidthPx: 640, popupHeightPx: 500,
      popupTheme: "miku", popupOpacityPercent: 0, sourceHighlightEnabled: false };
    harness.emitOptions(colour);
    const host = panes[0].popup.getRootNode().host;
    const results = { "live column preferences relayout each visible owner without lookup, retirement or Note loss": columns,
      "live toolbar overrides update root and child without lookup, masonry or Note loss": toolbar
        && harness.sent.length === sentBefore && harness.driver.snapshot(1).noteEditing,
      "live geometry precedes masonry while colour and highlight edits preserve every request and Note":
        resized && host.dataset.hoshidictsTheme === "miku"
        && host.style.getPropertyValue("--gsm-hoshidicts-popup-opacity") === "0%"
        && harness.sent.length === sentBefore && harness.driver.snapshot(1).noteEditing
        && panes.every(({ request, context }, depth) => harness.stats(depth).layoutSchedules === 2
          && harness.stats(depth).highlightEnabled === false && harness.driver.viewRequest(depth) === request
          && context.isCurrentRequest()) };
    // Compact glossaries is CSS on the host: each visible owner relayouts at
    // once, with no lookup, render or Note loss.
    const rendersBefore = harness.renders.length;
    harness.emitOptions({ ...colour, glossaryLayoutMode: "compact" });
    const compact = host.dataset.hoshidictsGlossaryLayout === "compact"
      && panes.every((_, depth) => harness.stats(depth).layoutSchedules === 3);
    harness.emitOptions({ ...colour, glossaryLayoutMode: "default" });
    results["live glossary layout relayouts each visible owner without lookup, rendering or Note loss"] = compact
      && host.dataset.hoshidictsGlossaryLayout === undefined
      && panes.every(({ request, context }, depth) => harness.stats(depth).layoutSchedules === 4
        && harness.driver.viewRequest(depth) === request && context.isCurrentRequest())
      && harness.renders.length === rendersBefore && harness.sent.length === sentBefore
      && harness.driver.snapshot(1).noteEditing;
    harness.emitOptions({ popupToolbarPosition: "bottom" });
    harness.emitOptions({ popupToolbarPosition: "auto", hoverEnabled: false });
    results["live toolbar overrides update root and child without lookup, masonry or Note loss"] &&=
      panes[0].popup.hidden && panes[0].popup.dataset.toolbarPosition === "top";
    return results;
  } finally { harness.close(); }
}

async function nestedPointerCase() {
  const harness = await createHarness();
  const window = harness.anchor.ownerDocument.defaultView;
  await harness.initialLookup();
  const child = harness.internalLink({ query: "child" });
  harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
  await child;
  harness.popup.getBoundingClientRect = () => ({ left: 10, right: 110, top: 10, bottom: 110 });
  harness.driver.popupAt(1).getBoundingClientRect = () => ({ left: 114, right: 214, top: 60, bottom: 160 });
  const corridor = harness.driver.pointInsidePopup(112, 90) && !harness.driver.pointInsidePopup(50, 150);
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  window.clearTimeout = (id) => timers.delete(id);
  const fire = (delay) => {
    const entry = [...timers].find(([, value]) => value.delay === delay);
    if (!entry) return false;
    timers.delete(entry[0]);
    entry[1].callback();
    return true;
  };
  harness.driver.popupAt(1).dispatchEvent(new window.MouseEvent("mouseenter"));
  harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
  const originalChild = harness.driver.viewRequest(1);
  const beforeReactivation = harness.sent.length;
  await harness.render().context.onInternalLink({ query: "child", primaryReading: "", anchor: originalChild.candidate.anchor });
  fire(160);
  const reactivated = harness.driver.viewRequest(1) === originalChild && harness.sent.length === beforeReactivation;
  harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
  const pruneScheduled = fire(160);
  const parentReturn = pruneScheduled && !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden;
  const second = harness.internalLink({ query: "child again" });
  harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child again")] });
  await second;
  harness.edit(true, 1);
  harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
  fire(160);
  const draftRetained = harness.driver.snapshot(1).noteEditing && !harness.driver.snapshot(1).popupHidden;
  harness.edit(false, 1);
  harness.driver.setScanCandidate({ ...harness.candidate, query: "new page word" });
  harness.driver.onMouseMove({ target: harness.popup.getRootNode().host, clientX: 10, clientY: 10, buttons: 0 });
  harness.driver.onMouseMove({ target: harness.anchor, clientX: 900, clientY: 700, buttons: 0 });
  fire(50);
  const beforeGrace = harness.take("hd_lookup") === null;
  fire(80);
  fire(50);
  const lookup = harness.take("hd_lookup");
  if (lookup) harness.reply(lookup, { dictionaryCount: 1, results: [harness.term("new page word")] });
  await harness.settle();
  harness.close();
  return { "ancestor pointer return prunes descendants but preserves drafts and a stationary departure resumes scanning":
    corridor && reactivated && parentReturn && draftRetained && beforeGrace && lookup?.request.text === "new page word" };
}

// Issue #360: in activationSticky, the default, pointer movement never prunes
// a rendered child, as in Yomitan without "Hide popup on cursor exit". Hover
// keeps the pointer-return prune above; a parent press still closes a child.
async function nestedStickyCase() {
  const harness = await createHarness(undefined, { options: { lookupMode: "activationSticky" } });
  const window = harness.anchor.ownerDocument.defaultView;
  try {
    await harness.initialLookup();
    const child = harness.internalLink({ query: "child" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
    await child;
    const timers = new Map();
    let nextTimer = 0;
    window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
    window.clearTimeout = (id) => timers.delete(id);
    const fire = (delay) => {
      const entry = [...timers].find(([, value]) => value.delay === delay);
      if (!entry) return false;
      timers.delete(entry[0]);
      entry[1].callback();
      return true;
    };
    // Each step must leave no hide-delay prune behind and the child open.
    const kept = [];
    const keeps = (step) => kept.push(!fire(160) && Boolean(harness.driver.popupAt(1))
      && !harness.driver.snapshot(1).popupHidden ? true : step);
    harness.driver.popupAt(1).dispatchEvent(new window.MouseEvent("mouseenter"));
    harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
    keeps("parent entry");
    // Shift over non-text in the parent is an empty definition scan.
    harness.driver.onPopupMouseMove({ target: harness.popup, clientX: 5, clientY: 5, shiftKey: true, buttons: 0 }, 0);
    fire(0);
    keeps("empty scan");
    const plainLink = window.document.createElement("a");
    plainLink.href = "https://example.test/";
    harness.popup.append(plainLink);
    harness.driver.onPopupMouseMove({ target: plainLink, clientX: 5, clientY: 5, buttons: 0 }, 0);
    keeps("non-dictionary link");
    harness.driver.onMouseMove({ target: harness.anchor, clientX: 900, clientY: 700, buttons: 0 });
    fire(80);
    keeps("page departure");
    harness.popup.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const pressed = !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden;
    // Escape still closes the deepest pane first.
    const reopened = harness.internalLink({ query: "child again" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child again")] });
    await reopened;
    harness.driver.onKeyDown({ key: "Escape", code: "Escape", repeat: false, preventDefault() {}, stopPropagation() {} });
    const escaped = !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden;
    // Issue #432: leaving the window before the chain's transfer check runs,
    // or leaving the tab, keeps the chain as well.
    const departing = harness.internalLink({ query: "child once more" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child once more")] });
    await departing;
    harness.popup.dispatchEvent(new window.MouseEvent("mouseenter"));
    harness.driver.onMouseMove({ target: harness.anchor, clientX: 900, clientY: 700, buttons: 0 });
    harness.driver.onMouseOut({ relatedTarget: null });
    fire(80);
    keeps("window departure");
    window.document.hasFocus = () => false;
    window.dispatchEvent(new window.Event("blur"));
    keeps("tab switch");
    return { "sticky lookups keep a rendered child through parent entry, empty scans, plain links, page and window departure and a tab switch until a parent press or Escape":
      kept.every((value) => value === true) && pressed && escaped || { kept, pressed, escaped } };
  } finally { harness.close(); }
}

// Issue #363: with "Hide popup on cursor exit" on, returning to an ancestor
// prunes its descendants after the option's delay in sticky mode too. Pane
// to pane and a rest in the corridor between panes are no exit; leaving the
// chain for the page or an iframe hides all of it.
async function nestedCursorExitCase() {
  const harness = await createHarness();
  const { driver } = harness;
  const window = harness.anchor.ownerDocument.defaultView;
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
  const pane = (depth) => driver.popupAt(depth);
  const enter = (depth) => pane(depth).dispatchEvent(new window.MouseEvent("mouseenter"));
  const leave = (depth, relatedTarget) => pane(depth).dispatchEvent(new window.MouseEvent("mouseleave", { relatedTarget }));
  const pageMove = (clientX, clientY) => driver.onMouseMove({ target: page, clientX, clientY, buttons: 0 });
  // The pointer rests in the root, whose link opens the child beside it.
  const openChild = async () => {
    await harness.initialLookup();
    enter(0);
    const operation = harness.internalLink({ query: "child" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
    await operation;
    pane(0).getBoundingClientRect = () => ({ left: 10, right: 110, top: 10, bottom: 110 });
    pane(1).getBoundingClientRect = () => ({ left: 114, right: 214, top: 60, bottom: 160 });
  };
  try {
    // A maximal Hide delay: only the option's 300 ms can prune or hide here.
    harness.emitOptions({ lookupMode: "activationSticky", popupHideDelayMs: 5000,
      hidePopupOnCursorExit: true, hidePopupOnCursorExitDelayMs: 300 });
    await openChild();
    leave(0, pane(1));
    enter(1);
    const paneToPane = !driver.cursorExitTimerPending();
    leave(1, pane(0));
    enter(0);
    const pruning = !driver.cursorExitTimerPending() && [...timers.values()].some((timer) => timer.delay === 300);
    const returned = paneToPane && pruning && fire(300) && !pane(1) && !driver.snapshot().popupHidden;

    await openChild();
    leave(0, page);
    pageMove(112, 90);
    fire(80);
    const corridor = fire(300) && Boolean(pane(1)) && !driver.snapshot().popupHidden;
    pageMove(50, 150);
    fire(80);
    const leftCorridor = corridor && fire(300) && driver.snapshot().popupHidden && !pane(1);

    // The document sees no move once the pointer is in an iframe; its last
    // position inside the child is not a corridor.
    await openChild();
    leave(0, pane(1));
    enter(1);
    driver.onPopupMouseMove({ target: pane(1), clientX: 150, clientY: 100, buttons: 0 }, 1);
    const frame = window.document.createElement("iframe");
    page.append(frame);
    leave(1, frame);
    const iframe = fire(300) && driver.snapshot().popupHidden && !pane(1);
    return { "hide popup on cursor exit prunes children on return in sticky mode and hides the chain it leaves":
      (returned && leftCorridor && iframe) || { paneToPane, pruning, returned, corridor, leftCorridor, iframe } };
  } finally {
    harness.close();
  }
}

// Issue #299: a child opens beside its own source text, like Yomitan, not
// beside its parent's box. The placement loop reads no pane rectangles.
async function nestedPlacementCase() {
  const harness = await createHarness();
  const window = harness.anchor.ownerDocument.defaultView;
  try {
    await harness.initialLookup();
    const open = async (query, depth) => {
      const operation = harness.internalLink({ query }, depth);
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term(query)] });
      await operation;
      return harness.driver.viewRequest(depth + 1).candidate.anchor;
    };
    const childLink = await open("child", 0);
    const grandchildLink = await open("grandchild", 1);
    const box = (left, top, width, height) => () => ({ left, top, right: left + width, bottom: top + height, width, height });
    let paneReads = 0;
    for (const depth of [0, 1, 2]) {
      harness.driver.popupAt(depth).getBoundingClientRect = () => { paneReads += 1; return box(0, 0, 0, 0)(); };
    }
    const geometry = (depth) => {
      const popup = harness.driver.popupAt(depth);
      return { left: Number.parseFloat(popup.style.left), top: Number.parseFloat(popup.style.top),
        width: Number.parseFloat(popup.style.width), height: Number.parseFloat(popup.style.height),
        toolbar: popup.dataset.toolbarPosition };
    };
    const same = (actual, expected) => Object.entries(expected).every(([key, value]) => actual[key] === value);
    // Room below the word: the child hangs from the word's line, left aligned,
    // and its Automatic toolbar sits at the top, nearest the word.
    childLink.getBoundingClientRect = box(300, 200, 40, 20);
    grandchildLink.getBoundingClientRect = box(330, 700, 40, 20);
    harness.callbacks(0).positionPopup();
    const below = same(geometry(1), { left: 300, top: 224, width: 560, height: 420, toolbar: "top" });
    // No room below the grandchild's word: it rises above that word instead,
    // still measured from its own link rather than the child's pane.
    const above = same(geometry(2), { left: 330, top: 276, width: 560, height: 420, toolbar: "bottom" });
    // The viewport clamps the left edge without moving the vertical anchor.
    childLink.getBoundingClientRect = box(900, 200, 40, 20);
    harness.callbacks(1).positionPopup();
    const clamped = same(geometry(1), { left: 458, top: 224 });
    const noPaneReads = paneReads === 0;
    // A pane whose word fits on neither side takes the roomier side and is
    // shortened to its room (issue #360); a preferred edge overrides the
    // automatic toolbar.
    harness.emitOptions({ popupToolbarPosition: "bottom" });
    childLink.getBoundingClientRect = box(300, 200, 40, 20);
    harness.callbacks(1).positionPopup();
    const explicitToolbar = same(geometry(1), { left: 300, top: 224, toolbar: "bottom" });
    harness.emitOptions({ popupToolbarPosition: "auto" });
    window.innerHeight = 500;
    childLink.getBoundingClientRect = box(300, 260, 40, 20);
    harness.callbacks(1).positionPopup();
    const roomier = same(geometry(1), { left: 300, top: 6, height: 250, toolbar: "bottom" });
    window.innerHeight = 768;
    // Scale and zoom convert the word's page rectangle into popup pixels.
    harness.emitOptions({ popupToolbarPosition: "auto", popupScalePercent: 50 });
    harness.callbacks(1).positionPopup();
    const scaled = same(geometry(1), { left: 600, top: 564, width: 560, height: 420 });
    // The reported 800x900 panes in a 1920x945 window fit on neither side of
    // a definition line: each child hangs from its link, shortened, instead
    // of being clamped over it at full height.
    harness.emitOptions({ popupWidthPx: 800, popupHeightPx: 900 });
    window.innerWidth = 1920;
    window.innerHeight = 945;
    childLink.getBoundingClientRect = box(760, 126, 36, 22);
    harness.callbacks(1).positionPopup();
    const largeBelow = same(geometry(1), { left: 760, top: 152, width: 800, height: 787, toolbar: "top" });
    childLink.getBoundingClientRect = box(760, 700, 36, 22);
    harness.callbacks(1).positionPopup();
    const largeAbove = same(geometry(1), { left: 760, top: 6, width: 800, height: 690, toolbar: "bottom" });
    return { "child popups anchor to their own source text below or above it, shortened rather than covering it, and read no pane rectangles":
      below && above && clamped && noPaneReads && explicitToolbar && roomier && scaled && largeBelow && largeAbove
      || { below, above, clamped, noPaneReads, explicitToolbar, roomier, scaled, largeBelow, largeAbove } };
  } finally { harness.close(); }
}

// Issue #299: a primary press in an ancestor retires its descendants at once,
// even focused ones, without waiting for the hover-hide delay. Drafts stay
// protected, and a press on a link keeps that link's own child for its click.
async function nestedClickCase() {
  const harness = await createHarness();
  const window = harness.anchor.ownerDocument.defaultView;
  const timers = new Map();
  let nextTimer = 0;
  try {
    await harness.initialLookup();
    const parent = harness.driver.viewRequest();
    const open = async (query, depth) => {
      const operation = harness.internalLink({ query }, depth);
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term(query)] });
      await operation;
      return harness.driver.viewRequest(depth + 1);
    };
    const press = (target, init = {}) => target.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, ...init }));
    window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
    window.clearTimeout = (id) => timers.delete(id);
    const child = await open("child", 0);
    await open("grandchild", 1);
    const grandchildPopup = harness.driver.popupAt(2);
    grandchildPopup.tabIndex = -1;
    grandchildPopup.focus();
    const sent = harness.sent.length;
    press(harness.driver.popupAt(1));
    const childPress = !harness.driver.popupAt(2) && grandchildPopup.hidden && grandchildPopup.isConnected === false
      && harness.driver.viewRequest(1) === child && !harness.driver.snapshot(1).popupHidden
      && harness.driver.viewRequest() === parent && harness.sent.length === sent
      && harness.popup.getRootNode().activeElement !== child.candidate.anchor;
    await open("grandchild again", 1);
    press(harness.popup, { button: 2 });
    const secondaryIgnored = Boolean(harness.driver.popupAt(2)) && Boolean(harness.driver.popupAt(1));
    // A pending definition scan cannot reopen what the press dismissed.
    harness.driver.onPopupMouseMove({ target: harness.popup, clientX: 20, clientY: 20, buttons: 0 }, 0);
    const scanArmed = [...timers.values()].some((timer) => timer.delay === 0);
    press(harness.popup);
    const rootPress = !harness.driver.popupAt(1) && !harness.driver.popupAt(2) && !harness.driver.snapshot().popupHidden
      && harness.driver.viewRequest() === parent && scanArmed && ![...timers.values()].some((timer) => timer.delay === 0);
    // A press on an internal link keeps that link's own child for the click
    // to reuse or replace, and retires only the branch below it.
    const linked = await open("linked", 0);
    await open("below linked", 1);
    const anchor = linked.candidate.anchor;
    anchor.dataset.hoshidictsQuery = "linked";
    press(anchor);
    const linkPress = harness.driver.viewRequest(1) === linked && !harness.driver.snapshot(1).popupHidden
      && !harness.driver.popupAt(2);
    // A draft or pending append protects descendants from an ancestor press.
    harness.edit(true, 1);
    press(harness.popup);
    const draftRetained = harness.driver.viewRequest(1) === linked && harness.driver.snapshot(1).noteEditing;
    harness.edit(false, 1);
    press(harness.popup);
    const closedDraftDismissed = !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden;
    // A late reply for a child pending at the press cannot revive it.
    const pending = harness.internalLink({ query: "late" });
    const request = harness.take("hd_lookup");
    press(harness.popup);
    const pendingPruned = !harness.driver.popupAt(1);
    harness.reply(request, { dictionaryCount: 1, results: [harness.term("late")] });
    await pending;
    const lateIgnored = !harness.driver.popupAt(1) && harness.driver.viewRequest() === parent && !harness.driver.snapshot().popupHidden;
    return { "an ancestor press dismisses focused, hovered and pending descendants at once while drafts and link presses are left alone":
      childPress && secondaryIgnored && rootPress && linkPress && draftRetained && closedDraftDismissed && pendingPruned && lateIgnored
      || { childPress, secondaryIgnored, rootPress, linkPress, draftRetained, closedDraftDismissed, pendingPruned, lateIgnored } };
  } finally { harness.close(); }
}

// Issue #504: an open pronunciation chooser is its pane's interaction. A
// child pane that would cover it closes unless a draft protects it, and
// definition scans wait until the chooser closes.
async function audioChooserPaneCase() {
  const harness = await createHarness();
  const window = harness.anchor.ownerDocument.defaultView;
  const timers = new Map();
  let nextTimer = 0;
  let caretCalls = 0;
  try {
    await harness.initialLookup();
    const child = harness.internalLink({ query: "child" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
    await child;
    const button = harness.popup.querySelector(".gsm-hoshidicts-audio-button");
    const choose = () => button.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const menu = () => harness.popup.querySelector(".gsm-hoshidicts-audio-choices");
    const closeMenu = () => menu().querySelector(".gsm-hoshidicts-audio-menu-close").click();
    harness.edit(true, 1);
    choose();
    const draftKept = Boolean(menu()) && Boolean(harness.driver.popupAt(1));
    closeMenu();
    harness.edit(false, 1);
    choose();
    const childClosed = Boolean(menu()) && !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden;
    // Hit testing is where a definition scan starts; count it.
    window.document.caretPositionFromPoint = () => { caretCalls += 1; return null; };
    window.setTimeout = (callback) => { timers.set(++nextTimer, callback); return nextTimer; };
    window.clearTimeout = (id) => timers.delete(id);
    const scan = () => {
      timers.clear();
      harness.driver.onPopupMouseMove({ target: harness.popup, clientX: 20, clientY: 20, buttons: 0 }, 0);
      for (const callback of [...timers.values()]) callback();
    };
    scan();
    const held = childClosed && caretCalls === 0 && harness.take("hd_lookup") === null;
    closeMenu();
    scan();
    const resumed = held && caretCalls > 0;
    return { "an open pronunciation chooser closes the child pane over it unless a draft holds it, and pauses definition scans":
      (draftKept && resumed) || { draftKept, childClosed, held, resumed, caretCalls } };
  } finally { harness.close(); }
}

async function nestedNotesCase() {
  const outcomes = [];
  for (const navigation of ["close", "navigate", "back", "lower"]) {
    const harness = await createHarness();
    await harness.initialLookup();
    const rootRequest = harness.driver.viewRequest();
    const originalContext = harness.render().context;
    const child = harness.internalLink({ query: "child" });
    harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
    await child;
    const source = harness.driver.viewRequest(1).candidate.anchor;
    harness.edit(true);
    harness.edit(true, 1);
    const append = harness.callbacks().onAddCustomEntry({ term: "parent", reading: "", definition: "saved" });
    const mutation = harness.take("hd_custom_append");
    harness.emitState(harness.state(2, "event first"));
    harness.reply(mutation, { state: harness.state(2, "event first") });
    await append;
    const deferred = harness.take("hd_lookup") === null && source.isConnected
      && harness.driver.snapshot().noteEditing && harness.driver.snapshot(1).noteEditing
      && !originalContext.isCurrentRequest();
    if (navigation === "navigate") {
      const clicked = harness.callbacks().onKanjiClick("食");
      harness.reply(harness.take("hd_lookup_dictionary"), { generation: 3, dictionaryCount: 1, results: [harness.term("食")] });
      await clicked;
      harness.edit(true);
      harness.edit(false);
      outcomes.push(deferred && !harness.driver.snapshot().popupHidden
        && harness.driver.viewRequest()?.kind === "kanji" && !harness.driver.popupAt(1)
        && harness.take("hd_lookup") === null);
    } else {
      harness.edit(false);
      const retained = source.isConnected && harness.driver.snapshot(1).noteEditing;
      if (navigation === "back") harness.render(1).context.onClose();
      else if (navigation === "lower") harness.emitOptions({ popupNestingMaxDepth: 0 });
      else harness.edit(false, 1);
      const refresh = harness.take("hd_lookup");
      if (refresh) harness.reply(refresh, { generation: 3, dictionaryCount: 1, results: [harness.term("parent")] });
      await harness.settle();
      outcomes.push(deferred && retained && refresh?.request.text === rootRequest.payload.text
        && !harness.driver.popupAt(1) && !harness.driver.snapshot().popupHidden);
    }
    harness.close();
  }
  for (const failedRefresh of [false, true]) {
    const concurrent = await createHarness();
    await concurrent.initialLookup();
    const rootRequest = concurrent.driver.viewRequest();
    const linked = concurrent.internalLink({ query: "child", primaryReading: "reading" });
    concurrent.reply(concurrent.take("hd_lookup"), { dictionaryCount: 1, results: [concurrent.term("child")] });
    await linked;
    const childRequest = concurrent.driver.viewRequest(1);
    concurrent.edit(true);
    concurrent.edit(true, 1);
    const parentAppend = concurrent.callbacks().onAddCustomEntry({ term: "parent", reading: "", definition: "first" });
    const parentMutation = concurrent.take("hd_custom_append");
    const childAppend = concurrent.callbacks(1).onAddCustomEntry({ term: "child", reading: "reading", definition: "second" });
    const childMutation = concurrent.take("hd_custom_append");
    concurrent.emitState(concurrent.state(3, "newest"));
    concurrent.reply(childMutation, { state: concurrent.state(3, "newest") });
    await childAppend;
    const childRefresh = concurrent.take("hd_lookup");
    concurrent.reply(parentMutation, { state: concurrent.state(2, "older reply") });
    await parentAppend;
    concurrent.emitState(concurrent.state(2, "older event"));
    const retainedWhileHeld = concurrent.driver.snapshot().dictionaryStateRevision === 3
      && concurrent.driver.snapshot().dictionaries[0].displayName === "newest"
      && concurrent.driver.viewRequest() === rootRequest && concurrent.driver.viewRequest(1) === childRequest
      && childRequest.candidate.anchor.isConnected && concurrent.take("hd_lookup") === null;
    concurrent.setStylesGeneration(3);
    if (childRefresh) concurrent.reply(childRefresh, { generation: 3, dictionaryCount: 1, results: [concurrent.term("child")] }, !failedRefresh);
    await concurrent.settle();
    const parentRefresh = concurrent.take("hd_lookup");
    if (parentRefresh) concurrent.reply(parentRefresh, { generation: 3, dictionaryCount: 1, results: [concurrent.term("parent")] });
    await concurrent.settle();
    outcomes.push(retainedWhileHeld && childRefresh?.request.text === "child"
      && childRefresh.request.options.primaryReading === "reading" && parentRefresh?.request.text === rootRequest.payload.text
      && concurrent.driver.viewRequest() === rootRequest && !concurrent.driver.popupAt(1)
      && concurrent.sent.filter(request => request.type === "hd_custom_append").length === 2
      && concurrent.take("hd_lookup") === null);
    concurrent.close();
  }

  const retired = await createHarness();
  await retired.initialLookup();
  const first = retired.internalLink({ query: "old child" });
  retired.reply(retired.take("hd_lookup"), { dictionaryCount: 1, results: [retired.term("old child")] });
  await first;
  retired.edit(true, 1);
  const saving = retired.callbacks(1).onAddCustomEntry({ term: "old child", reading: "", definition: "saved after pruning" });
  const mutation = retired.take("hd_custom_append");
  retired.callbacks().onBeforeResultsRendered();
  const replacement = retired.internalLink({ query: "new child" });
  retired.reply(retired.take("hd_lookup"), { dictionaryCount: 1, results: [retired.term("new child")] });
  await replacement;
  const replacementRequest = retired.driver.viewRequest(1);
  retired.edit(true, 1);
  retired.reply(mutation, { state: retired.state(2, "committed retired append") });
  await saving;
  outcomes.push(retired.driver.snapshot().dictionaryStateRevision === 2
    && retired.driver.viewRequest(1) === replacementRequest && retired.driver.snapshot(1).noteEditing
    && retired.take("hd_lookup") === null);
  retired.close();
  return { "parent Note replay waits for a child draft and accepted explicit navigation consumes obsolete deferred state": outcomes.every(Boolean) };
}

async function nestedReplyRaceCase() {
  const harness = await createHarness();
  await harness.initialLookup();
  const first = harness.internalLink({ query: "old child" });
  const oldRequest = harness.take("hd_lookup");
  harness.callbacks().onBeforeResultsRendered();
  const next = harness.internalLink({ query: "new child" });
  harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("new child")] });
  await next;
  const current = harness.driver.viewRequest(1);
  const currentPopup = harness.driver.popupAt(1);
  const before = harness.sent.length;
  harness.reply(oldRequest, { generation: 99, dictionaryCount: 1, results: [harness.term("old child")] });
  await first;
  const retiredIgnored = harness.driver.viewRequest(1) === current && harness.driver.popupAt(1) === currentPopup
    && harness.driver.snapshot().currentGeneration === 2 && harness.sent.length === before;
  harness.close();
  const detached = await createHarness();
  await detached.initialLookup();
  const detachedParent = detached.internalLink({ query: "detached parent" });
  detached.reply(detached.take("hd_lookup"), { dictionaryCount: 1, results: [detached.term("detached parent")] });
  await detachedParent;
  const pendingChild = detached.internalLink({ query: "detached ancestor" }, 1);
  const held = detached.take("hd_lookup");
  // A placed root outlives its page source (#402); a child's source inside
  // its parent pane still retires that child and its pending descendant.
  detached.anchor.remove();
  detached.driver.viewRequest(1).candidate.anchor.remove();
  detached.reply(held, { generation: 99, dictionaryCount: 1, results: [detached.term("must not render")] });
  await pendingChild;
  const detachedIgnored = detached.driver.snapshot().currentGeneration === 2 && detached.renders.length === 2
    && !detached.driver.snapshot().popupHidden && !detached.driver.popupAt(1);
  detached.close();
  const optionsRace = await createHarness();
  await optionsRace.initialLookup();
  const obsolete = optionsRace.internalLink({ query: "same pending child", primaryReading: "reading" });
  const obsoleteRequest = optionsRace.take("hd_lookup");
  const obsoletePopup = optionsRace.driver.popupAt(1);
  const anchor = optionsRace.popup.lastElementChild;
  optionsRace.emitOptions({ maxResults: 4 });
  const retry = optionsRace.render().context.onInternalLink({
    anchor, query: "same pending child", primaryReading: "reading",
  });
  const retryRequest = optionsRace.take("hd_lookup");
  const replacementPopup = optionsRace.driver.popupAt(1);
  optionsRace.reply(obsoleteRequest, { generation: 99, dictionaryCount: 1, results: [optionsRace.term("obsolete")] });
  await obsolete;
  const obsoletePendingIgnored = optionsRace.renders.length === 1
    && optionsRace.driver.snapshot().currentGeneration === 2;
  if (retryRequest) optionsRace.reply(retryRequest, {
    dictionaryCount: 1, results: [optionsRace.term("same pending child")],
  });
  await retry;
  const invalidatedPendingRetried = retryRequest?.request.maxResults === 4
    && obsoletePopup === replacementPopup && obsoletePendingIgnored
    && optionsRace.driver.viewRequest(1)?.payload.options.primaryReading === "reading"
    && optionsRace.render(1).context.isCurrentRequest();
  optionsRace.close();
  const savingChild = await createHarness();
  await savingChild.initialLookup();
  const opened = savingChild.internalLink({ query: "old child" });
  savingChild.reply(savingChild.take("hd_lookup"), { dictionaryCount: 1, results: [savingChild.term("old child")] });
  await opened;
  const shell = savingChild.driver.popupAt(1);
  savingChild.edit(true, 1);
  const saved = savingChild.callbacks(1).onAddCustomEntry({ term: "old child", reading: "", definition: "saved" });
  const append = savingChild.take("hd_custom_append");
  const replaced = savingChild.internalLink({ query: "new child" });
  const replacementLookup = savingChild.take("hd_lookup");
  const retiredNote = !savingChild.driver.snapshot(1).noteEditing && savingChild.driver.viewRequest(1) === null;
  savingChild.reply(append, { state: { schemaVersion: 1, revision: 0, dictionaries: [] } });
  await saved;
  const noOldReplay = savingChild.take("hd_lookup") === null;
  savingChild.reply(replacementLookup, { dictionaryCount: 1, results: [savingChild.term("new child")] });
  await replaced;
  const savedChildReused = retiredNote && noOldReplay && shell === savingChild.driver.popupAt(1)
    && savingChild.driver.viewRequest(1)?.payload.text === "new child";
  savingChild.close();
  const closingChild = await createHarness();
  await closingChild.initialLookup();
  const oldChild = closingChild.internalLink({ query: "old child" });
  closingChild.reply(closingChild.take("hd_lookup"), { dictionaryCount: 1, results: [closingChild.term("old child")] });
  await oldChild;
  closingChild.edit(true, 1);
  closingChild.setCloseNext(true, 1);
  const closingShell = closingChild.driver.popupAt(1);
  const closingReplacement = closingChild.internalLink({ query: "new child" });
  const closingReply = closingChild.take("hd_lookup");
  closingChild.driver.onKeyDown(new closingShell.ownerDocument.defaultView.KeyboardEvent("keydown", {
    key: "Escape", code: "Escape", bubbles: true, cancelable: true,
  }));
  closingChild.reply(closingReply, { dictionaryCount: 1, results: [closingChild.term("new child")] });
  await closingReplacement;
  const pendingChildDismissed = !closingShell.isConnected && !closingChild.driver.popupAt(1);
  closingChild.close();
  const movingAnchor = await createHarness();
  await movingAnchor.initialLookup();
  const newAnchor = movingAnchor.anchor.cloneNode(true);
  movingAnchor.anchor.ownerDocument.body.append(newAnchor);
  const nextRange = newAnchor.ownerDocument.createRange();
  nextRange.selectNodeContents(newAnchor);
  const nextCandidate = { ...movingAnchor.candidate, anchor: newAnchor, anchorRange: nextRange,
    sourceElements: [newAnchor], scanEntries: movingAnchor.candidate.scanEntries.map(entry =>
      ({ ...entry, node: newAnchor.firstChild })), query: "new anchor" };
  const nextLookup = movingAnchor.driver.runLookup(nextCandidate);
  const nextReply = movingAnchor.take("hd_lookup");
  movingAnchor.anchor.remove();
  movingAnchor.callbacks().positionPopup();
  movingAnchor.reply(nextReply, { dictionaryCount: 1, results: [movingAnchor.term("new anchor")] });
  await nextLookup;
  const stalePositionIgnored = !movingAnchor.driver.snapshot().popupHidden
    && movingAnchor.driver.viewRequest()?.payload.text === "new anchor";
  movingAnchor.close();
  const generations = [];
  for (const generation of [3, 1]) {
    const race = await createHarness();
    await race.initialLookup();
    const parent = race.driver.viewRequest();
    const child = race.internalLink({ query: "new generation" });
    const childRequest = race.take("hd_lookup");
    const kanji = race.callbacks().onKanjiClick("食");
    const parentRequest = race.take("hd_lookup_dictionary");
    race.setStylesGeneration(generation);
    race.reply(childRequest, { generation, dictionaryCount: 1, results: [race.term("new generation")] });
    await child;
    race.reply(parentRequest, { generation: 2, dictionaryCount: 1, results: [race.term("obsolete parent")] });
    await kanji;
    await race.settle();
    generations.push(race.driver.snapshot().currentGeneration === generation
      && race.driver.viewRequest() === parent && race.driver.viewRequest(1)?.payload.text === "new generation"
      && race.render(1).context.isCurrentRequest() && race.driver.snapshot().styleGeneration === generation);
    race.close();
  }
  return { "retired child replies and older parent replies cannot replace a new level or roll back engine generation":
    retiredIgnored && detachedIgnored && invalidatedPendingRetried && savedChildReused
      && pendingChildDismissed && stalePositionIgnored && generations.every(Boolean) };
}

async function retainedParentNavigationCase() {
  const harness = await createHarness();
  await harness.initialLookup();
  const parentRequest = harness.driver.viewRequest();
  const parentContext = harness.render().context;
  const child = harness.internalLink({ query: "child", primaryReading: "reading" });
  harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("child")] });
  await child;
  harness.edit(true, 1);
  const append = harness.callbacks(1).onAddCustomEntry({ term: "child", reading: "reading", definition: "saved" });
  harness.emitState(harness.state(2, "child saved"));
  harness.reply(harness.take("hd_custom_append"), { state: harness.state(2, "child saved") });
  await append;
  harness.setStylesGeneration(3);
  harness.reply(harness.take("hd_lookup"), { generation: 3, dictionaryCount: 1, results: [harness.term("child")] });
  await harness.settle();
  const retained = !parentContext.isCurrentRequest() && parentContext.isCurrentView?.() === true;
  const next = harness.internalLink({ query: "another child", primaryReading: "another reading" });
  const linked = harness.take("hd_lookup");
  if (linked) harness.reply(linked, { generation: 3, dictionaryCount: 1, results: [harness.term("another child")] });
  await next;
  parentContext.onDictionaryTabSelected({ dictionary: "Generic" });
  const delegated = harness.callbacks().onBeforeResultsRendered() === false;
  const replay = harness.take("hd_lookup");
  if (replay) harness.reply(replay, { generation: 3, dictionaryCount: 1, results: [harness.term("parent refreshed")] });
  await harness.settle();
  const fresh = harness.driver.viewRequest() === parentRequest
    && harness.render().context.selectedDictionaryTab?.dictionary === "Generic"
    && harness.render().context.isCurrentRequest() && !harness.driver.popupAt(1);
  harness.callbacks().onBeforeResultsRendered();
  const currentTabLocal = harness.take("hd_lookup") === null;
  harness.close();

  async function retainedReplay(kind = "term") {
    const owner = await createHarness();
    await owner.initialLookup();
    if (kind === "clicked-term") {
      const clicked = owner.callbacks().onKanjiClick("食");
      owner.reply(owner.take("hd_lookup_dictionary"), { dictionaryCount: 1, results: [owner.term("食")] });
      await clicked;
    }
    const request = owner.driver.viewRequest();
    const context = owner.render().context;
    const linked = owner.internalLink({ query: "generation child", primaryReading: "reading" });
    owner.setStylesGeneration(3);
    owner.reply(owner.take("hd_lookup"), { generation: 3, dictionaryCount: 1, results: [owner.term("generation child")] });
    await linked;
    return { owner, request, context, type: kind === "clicked-term" ? "hd_lookup_dictionary" : "hd_lookup" };
  }

  const protectedReplays = [];
  for (const [kind, noteTiming, outcome] of [
    ["term", "before", "hit"],
    ["term", "during", "failure"],
    ["term", "during", "miss"],
    ["term", "during", "empty-library"],
    ["clicked-term", "during", "hit"],
  ]) {
    const { owner, request, context, type } = await retainedReplay(kind);
    try {
      if (noteTiming === "before") owner.edit(true);
      context.onDictionaryTabSelected({ dictionary: "Generic" });
      owner.callbacks().onBeforeResultsRendered();
      const held = owner.take(type);
      if (!held) { protectedReplays.push(false); continue; }
      if (noteTiming === "during") owner.edit(true);
      const visible = owner.render();
      const before = owner.sent.filter(message => message.type === type).length;
      // Repeated input shares the held exact descriptor, but keeps the latest
      // projection/expansion intent for the eventual current response.
      context.onDictionaryTabSelected(null);
      owner.callbacks().onBeforeResultsRendered({ expandAll: true });
      context.onDictionaryTabSelected({ dictionary: "Generic" });
      owner.callbacks().onBeforeResultsRendered();
      const expandAll = kind === "clicked-term";
      if (expandAll) owner.callbacks().onBeforeResultsRendered({ expandAll: true });
      const shared = owner.sent.filter(message => message.type === type).length === before;
      owner.reply(held, outcome === "failure" ? { error: "held replay failure" } : {
        generation: 3, dictionaryCount: outcome === "empty-library" ? 0 : 1,
        results: outcome === "hit" ? [owner.term("fresh projection")] : [],
      }, outcome !== "failure");
      await owner.settle();
      const rendered = owner.render();
      const protectedNote = owner.driver.snapshot().noteEditing && !owner.driver.snapshot().popupHidden
        && owner.driver.viewRequest() === request;
      const refreshed = outcome === "hit"
        ? rendered !== visible && rendered.context.preserveViewControls === true
          && rendered.context.expandAll === expandAll
          && rendered.context.selectedDictionaryTab?.dictionary === "Generic"
        : rendered === visible && context.isCurrentView() && !context.isCurrentRequest();
      let normalBack = true;
      if (kind === "clicked-term") {
        const back = rendered.context.onBack();
        const restoring = owner.take("hd_lookup");
        if (restoring) owner.reply(restoring, { generation: 3, dictionaryCount: 1, results: [owner.term(owner.candidate.query)] });
        await back;
        normalBack = Boolean(restoring) && owner.render().context.preserveViewControls !== true
          && owner.render().context.expandAll !== true && !owner.driver.snapshot().noteEditing;
      }
      protectedReplays.push(shared && protectedNote && refreshed && normalBack);
    } finally { owner.close(); }
  }

  // A live internal anchor is insufficient when its ancestor's source was
  // detached during a protected failed replay. A placed root outlives its
  // page source (#402), so the detached ancestor is a child pane.
  const detached = await createHarness();
  let detachedProtectedReply;
  try {
    await detached.initialLookup();
    const child = detached.internalLink({ query: "retained child" });
    detached.reply(detached.take("hd_lookup"), { dictionaryCount: 1, results: [detached.term("retained child")] });
    await child;
    const middle = detached.internalLink({ query: "retained middle" }, 1);
    detached.reply(detached.take("hd_lookup"), { dictionaryCount: 1, results: [detached.term("retained middle")] });
    await middle;
    const grandchild = detached.internalLink({ query: "new generation" }, 2);
    detached.setStylesGeneration(3);
    detached.reply(detached.take("hd_lookup"), { generation: 3, dictionaryCount: 1, results: [detached.term("new generation")] });
    await grandchild;
    detached.edit(true, 2);
    detached.callbacks(2).onBeforeResultsRendered();
    const failed = detached.take("hd_lookup");
    const source = detached.driver.viewRequest(2).candidate.anchor;
    detached.anchor.remove();
    detached.driver.viewRequest(1).candidate.anchor.remove();
    const ownAnchorStillConnected = source.isConnected;
    if (failed) detached.reply(failed, { error: "detached ancestor" }, false);
    await detached.settle();
    detachedProtectedReply = Boolean(failed) && ownAnchorStillConnected
      && !detached.driver.snapshot().popupHidden && !detached.driver.popupAt(1);
  } finally { detached.close(); }

  // Sharing expires with its token: a child accepting another generation
  // cannot make the next displayed action join the obsolete held replay.
  const changed = await retainedReplay();
  let generationEndsSharing;
  try {
    changed.owner.callbacks().onBeforeResultsRendered();
    const oldReplay = changed.owner.take("hd_lookup");
    const newerChild = changed.owner.internalLink({ query: "next generation" });
    const childRequest = changed.owner.take("hd_lookup");
    changed.owner.setStylesGeneration(4);
    if (childRequest) changed.owner.reply(childRequest, { generation: 4, dictionaryCount: 1, results: [changed.owner.term("next generation")] });
    await newerChild;
    changed.context.onDictionaryTabSelected({ dictionary: "Generic" });
    changed.owner.callbacks().onBeforeResultsRendered({ expandAll: true });
    const newReplay = changed.owner.take("hd_lookup");
    if (newReplay) changed.owner.reply(newReplay, { generation: 4, dictionaryCount: 1, results: [changed.owner.term("latest parent")] });
    await changed.owner.settle();
    const latest = changed.owner.render();
    if (oldReplay) changed.owner.reply(oldReplay, { generation: 3, dictionaryCount: 1, results: [changed.owner.term("obsolete parent")] });
    await changed.owner.settle();
    generationEndsSharing = Boolean(oldReplay && childRequest && newReplay)
      && changed.owner.render() === latest && latest.results[0].term.expression === "latest parent"
      && latest.context.expandAll === true && changed.owner.driver.snapshot().currentGeneration === 4;
  } finally { changed.owner.close(); }

  return { "retained parent navigation stays usable while stale tabs replay current dictionaries without reviving old resources":
    retained && linked?.request.text === "another child" && linked.request.options.primaryReading === "another reading"
    && delegated && replay?.request.text === parentRequest.payload.text && fresh && currentTabLocal
    && protectedReplays.every(Boolean) && detachedProtectedReply && generationEndsSharing };
}

async function mediaOwnershipCase() {
  const result = {};
  const url = "data:image/png;base64,YQ==";
  const load = (harness, context = harness.render().context) => context.resolveMedia({
    dictionary: "Generic", generation: context.generation, path: "media/owned.png",
    isCurrent: context.isCurrentRequest,
  }).catch(() => null);
  const finish = (harness, dataUrl = url, ok = true) => {
    const request = harness.take("hd_media");
    if (request) harness.reply(request, { dataUrl, generation: harness.render().context.generation }, ok);
    return request;
  };

  const late = await createHarness();
  await late.initialLookup();
  const old = load(late);
  const oldRequest = late.take("hd_media");
  late.setStylesGeneration(3);
  await late.initialLookup(3);
  const current = load(late);
  const currentRequest = finish(late);
  await current;
  late.reply(oldRequest, { dataUrl: url, generation: 2 });
  await old;
  const generationStayedCurrent = late.driver.snapshot().currentGeneration === 3;
  const cached = load(late);
  const unexpected = finish(late);
  await cached;
  late.setStylesGeneration(1);
  await late.initialLookup(1);
  result["late media cannot roll back generation or evict a newer cached image"] = generationStayedCurrent
    && oldRequest.request.generation === 2 && currentRequest?.request.generation === 3
    && !unexpected && late.driver.snapshot().currentGeneration === 1;
  late.close();

  const shared = await createHarness();
  await shared.initialLookup();
  const oldContext = shared.render().context;
  const first = load(shared);
  await shared.initialLookup();
  const second = load(shared);
  const staleSubscriber = load(shared, oldContext);
  finish(shared);
  const values = await Promise.all([first, second, staleSubscriber]);
  const third = load(shared);
  const redundant = finish(shared);
  await third;
  result["a current view adopts one pending media fetch without a stale subscriber stealing ownership"] =
    values[1] === url && values[2] === null && !redundant
    && shared.sent.filter(({ type }) => type === "hd_media").length === 1;
  shared.close();

  const replaced = await createHarness();
  await replaced.initialLookup();
  const abandoned = load(replaced);
  const abandonedRequest = replaced.take("hd_media");
  replaced.emitState(replaced.state(2, "replaced"));
  await replaced.initialLookup();
  const replacement = load(replaced);
  const replacementRequest = replaced.take("hd_media");
  replaced.reply(abandonedRequest, { dataUrl: "data:image/png;base64,b2xk" });
  await abandoned;
  const joinReplacement = load(replaced);
  const extra = finish(replaced);
  if (replacementRequest) replaced.reply(replacementRequest, { dataUrl: url });
  const replacementValues = await Promise.all([replacement, joinReplacement]);
  result["dictionary invalidation prevents old same-generation jobs from poisoning or deleting replacements"] =
    Boolean(replacementRequest) && !extra && replacementValues.every((value) => value === url);
  replaced.close();

  const retries = [];
  for (const ok of [false, true]) {
    const harness = await createHarness();
    await harness.initialLookup();
    const failed = load(harness);
    finish(harness, null, ok);
    await failed;
    await harness.initialLookup();
    const retry = load(harness);
    const retried = finish(harness);
    const value = await retry;
    await harness.initialLookup();
    const reused = load(harness);
    const refetched = finish(harness);
    await reused;
    retries.push(Boolean(retried) && value === url && !refetched);
    harness.close();
  }
  result["failed and missing media retry while successful images survive repeat hovers"] = retries.every(Boolean);

  const hidden = await createHarness();
  await hidden.initialLookup();
  const hiddenFetch = load(hidden);
  hidden.popup.ownerDocument.dispatchEvent(new hidden.popup.ownerDocument.defaultView.KeyboardEvent(
    "keydown", { bubbles: true, cancelable: true, key: "Escape", code: "Escape" },
  ));
  finish(hidden);
  await hiddenFetch;
  await hidden.initialLookup();
  const afterHidden = load(hidden);
  const hiddenRefetch = finish(hidden);
  const hiddenValue = await afterHidden;
  result["valid media completed while hidden stays reusable without touching an obsolete view"] =
    !hiddenRefetch && hiddenValue === url;
  hidden.close();

  const presentation = await createHarness();
  await presentation.initialLookup();
  const firstImage = load(presentation);
  finish(presentation);
  await firstImage;
  const stylesBefore = presentation.sent.filter(({ type }) => type === "hd_styles").length;
  presentation.emitState({
    revision: 2,
    dictionaries: presentation.driver.snapshot().dictionaries.map((dictionary) => ({
      ...dictionary, displayName: "New alias", favorite: !dictionary.favorite,
    })),
  });
  await presentation.initialLookup();
  const afterPresentation = load(presentation);
  const presentationRefetch = finish(presentation);
  await afterPresentation;
  result["alias and favorite changes preserve successful media and styles without re-fetching"] =
    !presentationRefetch && presentation.sent.filter(({ type }) => type === "hd_styles").length === stylesBefore;
  presentation.close();

  const styles = await createHarness();
  await styles.initialLookup(3);
  await styles.settle();
  result["a mismatched style reply cannot adopt generation and remains retryable"] =
    styles.driver.snapshot().currentGeneration === 3 && styles.driver.snapshot().styleGeneration === -1;
  styles.close();
  for (const ok of [false, true]) {
    const reused = await createHarness();
    reused.setHoldStyles();
    await reused.initialLookup();
    const obsoleteStyles = reused.take("hd_styles");
    reused.emitState(reused.state(2, "new dictionary state"));
    await reused.initialLookup();
    const newStyles = reused.take("hd_styles");
    reused.reply(obsoleteStyles, { styles: ["obsolete"] }, ok);
    await reused.settle();
    const oldIgnored = reused.appliedStyles.length === 0 && reused.driver.snapshot().styleGeneration === 2;
    reused.reply(newStyles, { styles: ["current"] });
    await reused.settle();
    result["a mismatched style reply cannot adopt generation and remains retryable"] &&=
      oldIgnored && reused.appliedStyles.length === 1 && reused.appliedStyles[0].styles[0] === "current";
    reused.close();
  }

  const back = await createHarness();
  await back.initialLookup();
  const clicked = back.callbacks().onKanjiClick("食", null, null, null);
  back.setStylesGeneration(3);
  back.reply(back.take("hd_lookup_dictionary"), {
    generation: 3, dictionaryCount: 1, results: [back.term("clicked newer")],
  });
  await clicked;
  const restoring = back.render().context.onBack();
  const refresh = back.take("hd_lookup");
  if (refresh) back.reply(refresh, {
    generation: 3, dictionaryCount: 1, results: [back.term("refreshed Back")],
  });
  await restoring;
  result["Back refreshes an old result snapshot before requesting current-generation media"] =
    Boolean(refresh) && back.render().results[0].term.expression === "refreshed Back"
      && back.render().context.generation === 3;
  back.close();
  return result;
}

async function imageSourceRoutingCase() {
  const harness = await createHarness();
  const results = {};
  const url = "data:image/png;base64,Yg==";
  const otherUrl = "data:image/png;base64,Yw==";
  const sourceOptions = {
    frequencyDictionary: "Frequency A", frequencyOrder: "descending",
    kanjiClickDictionary: { title: "Generic", kind: "term" }, maxResults: 7,
    modifier: "none", scanLength: 9,
  };
  const select = (popupImageSource) => harness.emitOptions({ ...sourceOptions, popupImageSource });
  const inventory = {
    revision: 2,
    dictionaries: [...harness.driver.snapshot().dictionaries,
      genericPackage({ id: "image-b", title: "Images:B", path: "/dicts/images-b", termCount: 0 }),
      genericPackage({ id: "image-c", title: "Images:C", path: "/dicts/images-c", termCount: 0 }),
      genericPackage({ id: "image-off", title: "Images:Disabled", path: "/dicts/images-off", enabled: false }),
    ],
    groups: [{ id: "image-order", name: "Images", dictionaryIds: ["image-b", "image-c"] }],
  };
  harness.emitState(inventory);
  let inventoryRevision = inventory.revision;
  const changeInventory = (patch) => harness.emitState({ ...inventory, ...patch, revision: ++inventoryRevision });
  await harness.initialLookup();
  const context = harness.render().context;
  const descriptor = harness.driver.viewRequest();
  const renderCount = harness.renders.length;
  const sources = [];
  const load = (path, owns = () => true) => context.resolveMedia({
    dictionary: "Generic", generation: context.generation, path,
    isCurrent: () => owns() && context.isCurrentRequest(),
    onResolvedSource: (title) => sources.push({ path, title }),
  }).catch(() => null);
  const finish = (dataUrl = url) => {
    const request = harness.take("hd_media");
    if (request) harness.reply(request, { dataUrl });
    return request?.request;
  };
  try {
    select({ kind: "dictionary", title: "Images:B" });
    const explicit = load("explicit.png");
    const explicitRequest = finish();
    results["explicit image sources resolve another dictionary's path without changing its text or lookup owner"] =
      await explicit === url && explicitRequest?.dictionary === "Images:B"
      && sources.at(-1)?.title === "Images:B"
      && harness.driver.viewRequest() === descriptor && context.isCurrentRequest()
      && harness.renders.length === renderCount && harness.driver.snapshot().currentGeneration === 2;

    select({ kind: "tabGroup", id: "image-order" });
    const firstPath = load("group-x.png");
    const firstCandidate = finish(null);
    await harness.settle();
    const fallback = finish(otherUrl);
    const firstValue = await firstPath;
    const secondPath = load("group-y.png");
    const secondCandidate = finish();
    const secondValue = await secondPath;
    const exhausted = load("absent.png");
    finish(null);
    await harness.settle();
    finish(null);
    const exhaustedValue = await exhausted;
    const beforeUnavailable = harness.sent.length;
    const unavailableValues = [];
    for (const source of [{ kind: "tabGroup", id: "removed-group" },
      { kind: "dictionary", title: "Removed" }, { kind: "dictionary", title: "Images:Disabled" }]) {
      select(source);
      const unavailable = load("unavailable.png");
      finish();
      unavailableValues.push(await unavailable);
    }
    results["image groups fall through separately for each path and unavailable or exhausted sources fail normally"] =
      firstCandidate?.dictionary === "Images:B" && fallback?.dictionary === "Images:C"
      && firstValue === otherUrl && secondCandidate?.dictionary === "Images:B" && secondValue === url
      && exhaustedValue === null && unavailableValues.every(value => value === null) && harness.sent.length === beforeUnavailable;

    select({ kind: "tabGroup", id: "image-order" });
    let ownsFirst = true;
    const beforeShared = harness.sent.length;
    const first = load("shared-route.png", () => ownsFirst);
    const second = load("shared-route.png");
    ownsFirst = false;
    const sharedFirst = finish(null);
    await harness.settle();
    const sharedFallback = finish(otherUrl);
    const sharedValues = await Promise.all([first, second]);
    results["routed media shares pending candidates without a retired consumer publishing provenance or cancelling its peer"] =
      sharedFirst?.dictionary === "Images:B" && sharedFallback?.dictionary === "Images:C"
      && sharedValues[0] === null && sharedValues[1] === otherUrl
      && harness.sent.length === beforeShared + 2
      && sources.filter(({ path }) => path === "shared-route.png").length === 1;

    const stale = [];
    for (const successful of [false, true, "group-reorder", "automatic"]) {
      select(successful === "automatic" ? null : { kind: "tabGroup", id: "image-order" });
      const path = `obsolete-${successful}.png`;
      const operation = load(path);
      const request = harness.take("hd_media");
      const beforeChange = harness.sent.length;
      if (successful === "group-reorder") {
        changeInventory({ groups: [{ ...inventory.groups[0], dictionaryIds: ["image-c", "image-b"] }] });
      } else select({ kind: "dictionary", title: "Images:C" });
      harness.reply(request, { dataUrl: successful ? url : null });
      await harness.settle();
      finish();
      stale.push(await operation === null && harness.sent.length === beforeChange
        && !sources.some(item => item.path === path));
    }
    results["changing the effective image route stops stale success and further fallback without invalidating the lookup"] =
      stale.every(Boolean) && context.isCurrentRequest() && harness.driver.viewRequest() === descriptor;

    changeInventory({});
    select({ kind: "tabGroup", id: "image-order" });
    const pendingAlias = load("alias.png");
    const aliasRequest = harness.take("hd_media");
    const beforeAlias = harness.sent.length;
    changeInventory({ dictionaries: inventory.dictionaries.map(dictionary =>
      dictionary.id === "image-b" ? { ...dictionary, displayName: "Picture book" } : dictionary),
      groups: [{ ...inventory.groups[0], name: "Renamed pictures" }],
    });
    harness.reply(aliasRequest, { dataUrl: url });
    const aliasValue = await pendingAlias;
    const cachedAlias = await load("alias.png");
    results["image-source aliases retain pending ownership and cached bytes without additional content requests"] =
      aliasValue === url && cachedAlias === url && sources.at(-1)?.title === "Images:B"
      && harness.sent.length === beforeAlias && context.isCurrentRequest()
      && harness.driver.viewRequest() === descriptor && harness.renders.length === renderCount;
    const callbackFailure = context.resolveMedia({
      dictionary: "Generic", generation: context.generation, path: "alias.png",
      isCurrent: context.isCurrentRequest,
      onResolvedSource() { throw new Error("provenance callback failed"); },
    }).catch(error => error.message);
    await harness.settle();
    finish();
    results["image provenance callback errors do not trigger another supplier lookup"] =
      await callbackFailure === "provenance callback failed" && harness.sent.length === beforeAlias;
    return results;
  } finally { harness.close(); }
}

async function previewInvalidationCase() {
  const cases = [];
  for (const kind of ["term", "clicked-term", "kanji", "options", "dictionary-note"]) {
    const harness = await createHarness({ title: "Generic", kind: kind === "kanji" ? "kanji" : "term" });
    await harness.initialLookup();
    const previous = harness.render().context;
    const before = harness.stats().previewDismissals;
    let operation;
    if (kind === "term") operation = harness.driver.runLookup(harness.candidate);
    else if (kind === "clicked-term" || kind === "kanji") operation = harness.callbacks().onKanjiClick("食");
    else if (kind === "options") harness.emitOptions({ maxResults: 9 });
    else {
      harness.edit(true);
      harness.emitState(harness.state(2, "new dictionary state"));
    }
    const dismissedBeforeReply = harness.stats().previewDismissals === before + 1
      && previous.isCurrentRequest() === false;
    const retainedDraft = kind !== "dictionary-note" || !harness.driver.snapshot().popupHidden;
    const request = harness.take(kind === "term" ? "hd_lookup" : kind === "kanji" ? "hd_kanji" : "hd_lookup_dictionary");
    if (request) harness.reply(request, { dictionaryCount: 1, results: [harness.term("食")],
      kanji: { character: "食", entries: [{ dictionary: "Generic" }] } });
    await operation;
    cases.push(dismissedBeforeReply && retainedDraft);
    harness.close();
  }
  const focused = await createHarness();
  await focused.initialLookup();
  const link = focused.popup.ownerDocument.createElement("a");
  link.href = "#";
  link.textContent = "Keyboard image owner";
  focused.popup.appendChild(link);
  focused.driver.scheduleHide();
  const pendingBeforeFocus = focused.driver.hideTimerPending();
  link.focus();
  const focusCancelledHide = !focused.driver.hideTimerPending();
  focused.driver.scheduleHide();
  const stayedUnscheduled = !focused.driver.hideTimerPending();
  link.blur();
  await focused.settle();
  const leavingRearmed = focused.driver.hideTimerPending();
  await new Promise(done => setTimeout(done, 180));
  const hiddenAfterBlur = focused.driver.snapshot().popupHidden;
  await focused.initialLookup();
  link.focus();
  link.blur();
  focused.popup.replaceChildren();
  await focused.settle();
  const replacementDidNotScheduleHide = !focused.driver.hideTimerPending();
  focused.close();
  return {
    "new term or kanji requests and settings invalidation dismiss previews before their replies": cases.every(Boolean),
    "popup keyboard focus cancels hover dismissal and leaving focus rearms it": pendingBeforeFocus
      && focusCancelledHide && stayedUnscheduled && leavingRearmed && hiddenAfterBlur,
    "replacing focused popup content does not schedule dismissal of its refreshed view": replacementDidNotScheduleHide,
  };
}

async function boundedMediaCase() {
  const result = {};
  const url = "data:image/png;base64,YQ==";
  const load = (harness, path) => {
    const context = harness.render().context;
    return context.resolveMedia({
      dictionary: "Generic", generation: context.generation, path,
      isCurrent: context.isCurrentRequest,
    }).catch(() => null);
  };
  const count = (harness) => harness.sent.filter(({ type }) => type === "hd_media").length;
  const reply = (harness, request, dataUrl = url) => harness.reply(request, { dataUrl });
  async function drain(harness) {
    for (;;) {
      const request = harness.take("hd_media");
      if (!request) return;
      reply(harness, request);
      await harness.settle();
    }
  }
  async function fetch(harness, path, dataUrl = url) {
    const operation = load(harness, path);
    const request = harness.take("hd_media");
    if (request) reply(harness, request, dataUrl);
    return { value: await operation, fetched: request !== null };
  }

  const capacity = await createHarness();
  await capacity.initialLookup();
  const jobs = Array.from({ length: 132 }, (_, index) => load(capacity, `capacity-${index}.png`));
  const deduped = load(capacity, "capacity-0.png");
  const firstDispatch = count(capacity);
  reply(capacity, capacity.take("hd_media"));
  await capacity.settle();
  const nextDispatch = count(capacity);
  await drain(capacity);
  const values = await Promise.all(jobs);
  result["media admits 128 total jobs, dispatches four, and deduplicates even at capacity"] =
    firstDispatch === 4 && nextDispatch === 5 && count(capacity) === 128
      && values.slice(0, 128).every((value) => value === url)
      && values.slice(128).every((value) => value === null) && await deduped === url;
  capacity.close();

  const timeout = await createHarness();
  await timeout.initialLookup();
  const clock = timeout.installMediaClock();
  const timedJobs = Array.from({ length: 6 }, (_, index) => load(timeout, `timeout-${index}.png`));
  const firstTimers = clock.size();
  const expiredRequest = timeout.take("hd_media");
  const expired = clock.expireFirst();
  await timeout.settle();
  const dispatchedAfterTimeout = count(timeout);
  const timersAfterTimeout = clock.size();
  reply(timeout, expiredRequest);
  await timeout.settle();
  const dispatchedAfterLateReply = count(timeout);
  const retry = load(timeout, "timeout-0.png");
  await drain(timeout);
  const timedValues = await Promise.all(timedJobs);
  result["media timeout starts at dispatch and a late reply cannot free capacity twice or poison retry"] =
    firstTimers === 4 && expired && dispatchedAfterTimeout === 5 && timersAfterTimeout === 4
      && dispatchedAfterLateReply === 5 && timedValues[0] === null
      && await retry === url && count(timeout) === 7 && clock.size() === 0;
  timeout.close();

  const superseded = await createHarness();
  await superseded.initialLookup();
  const obsolete = Array.from({ length: 128 }, (_, index) => load(superseded, `old-${index}.png`));
  await superseded.initialLookup();
  const reattached = load(superseded, "old-4.png");
  const fresh = load(superseded, "fresh.png");
  await drain(superseded);
  const oldValues = await Promise.all(obsolete);
  const startedCache = await fetch(superseded, "old-0.png");
  result["new views reattach matching queued media and prune obsolete work before capacity rejection"] =
    count(superseded) === 6 && oldValues.every((value) => value === null)
      && await reattached === url && await fresh === url && !startedCache.fetched && startedCache.value === url;
  superseded.close();

  const shared = await createHarness();
  await shared.initialLookup();
  const occupied = Array.from({ length: 4 }, (_, index) => load(shared, `occupied-${index}.png`));
  const parent = load(shared, "shared.png");
  let childCurrent = true;
  const child = shared.render().context.resolveMedia({
    dictionary: "Generic", generation: 2, path: "shared.png", isCurrent: () => childCurrent,
  }).catch(() => null);
  childCurrent = false;
  await drain(shared);
  await Promise.all(occupied);
  result["a retired child cannot cancel queued media still owned by its parent"] =
    await parent === url && await child === null && count(shared) === 5;
  shared.close();

  const invalidations = [];
  for (const kind of ["dictionary", "teardown"]) {
    const harness = await createHarness();
    await harness.initialLookup();
    const timers = harness.installMediaClock();
    let settled = 0;
    const pending = Array.from({ length: 8 }, (_, index) => load(harness, `invalidated-${index}.png`)
      .then((value) => { settled += 1; return value; }));
    if (kind === "teardown") harness.driver.teardown();
    else harness.emitState(harness.state(2, "new generation"));
    await harness.settle();
    const settledImmediately = settled === 8 && timers.size() === 0;
    await drain(harness);
    const rejected = (await Promise.all(pending)).every((value) => value === null);
    invalidations.push(settledImmediately && rejected && count(harness) === 4);
    harness.close();
  }
  result["resource invalidation and teardown settle all media without dispatching obsolete queued work"] =
    invalidations.every(Boolean);

  const entries = await createHarness();
  await entries.initialLookup();
  for (let index = 0; index < 64; index += 1) await fetch(entries, `entry-${index}.png`);
  const exactEntries = await fetch(entries, "entry-0.png");
  await fetch(entries, "entry-64.png");
  const promoted = await fetch(entries, "entry-0.png");
  const evicted = await fetch(entries, "entry-1.png");
  result["media LRU accepts exactly 64 entries and promotes hits before evicting the oldest"] =
    !exactEntries.fetched && !promoted.fetched && evicted.fetched && count(entries) === 66;
  entries.close();

  const bytes = await createHarness();
  await bytes.initialLookup();
  const largeUrl = `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024).toString("base64")}`;
  for (let index = 0; index < 4; index += 1) await fetch(bytes, `bytes-${index}.png`, largeUrl);
  const exactBytes = await fetch(bytes, "bytes-0.png", largeUrl);
  await fetch(bytes, "one-byte.png");
  const promotedBytes = await fetch(bytes, "bytes-0.png", largeUrl);
  const evictedBytes = await fetch(bytes, "bytes-1.png", largeUrl);
  bytes.emitState(bytes.state(2, "new generation"));
  await bytes.initialLookup();
  for (let index = 0; index < 4; index += 1) await fetch(bytes, `reset-${index}.png`, largeUrl);
  const afterClear = await fetch(bytes, "reset-0.png", largeUrl);
  result["media LRU measures decoded bytes, accepts exactly 16 MiB, and resets accounting on invalidation"] =
    !exactBytes.fetched && !promotedBytes.fetched && evictedBytes.fetched && !afterClear.fetched;
  bytes.close();
  return result;
}

describe("content script: nested popups and media", () => {
  test("media ownership and nested popups", async () => {
    const noteContent = await contentNoteStage({
      mediaOwnership: async () => ({ ...await mediaOwnershipCase(), ...await imageSourceRoutingCase(), ...await boundedMediaCase(), ...await previewInvalidationCase(),
        ...await nestedLevelsCase(), ...await livePresentationCase(), ...await inheritedTabsCase(), ...await nestedResizeCase(), ...await columnPreferenceCase(), ...await nestedNotesCase(), ...await nestedPointerCase(), ...await nestedStickyCase(), ...await nestedCursorExitCase(), ...await nestedPlacementCase(), ...await nestedClickCase(), ...await audioChooserPaneCase(), ...await nestedReplyRaceCase(),
        ...await retainedParentNavigationCase() }),
    });
    for (const [name, passed] of Object.entries(noteContent?.mediaOwnership ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });
});
