/*
 * Hover scanning, popup hosting, and offscreen-engine messaging for
 * Hachidori.
 *
 * Rendering lives in render/popup.js and render/glossary.js (ported from
 * GameSentenceMiner PR #549); this file only produces the
 * {sentence, matchOffset, sourceElements} candidates those modules consume and
 * drives the request/reply state machine.
 *
 * Copyright (C) 2026 Manhhao
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function () {
  "use strict";

  const TARGET = "hoshidicts-offscreen";
  const HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  const READER_STYLESHEET = "render/reader.css";
  const HOST_TAG = "hachidori-host";

  const { DEFAULT_OPTIONS, clampOption, normaliseActivationKey, normaliseOptions: normalizeOptions } = globalThis.HDReaderOptions;
  const MODIFIER_PROPERTIES = new Map([
    ["Shift", "shiftKey"],
    ["Control", "ctrlKey"],
    ["Alt", "altKey"],
    ["Meta", "metaKey"],
  ]);

  const POPUP_WIDTH_PX = 560;
  const POPUP_HEIGHT_PX = 420;
  const POPUP_GAP_PX = 4;
  const POPUP_PADDING_PX = 6;
  const MAX_MEDIA_CACHE_BYTES = 16 * 1024 * 1024;
  const MAX_MEDIA_CACHE_ENTRIES = 64;
  const MAX_MEDIA_CONCURRENT_REQUESTS = 4;
  const MAX_MEDIA_PENDING_REQUESTS = 128;
  const MEDIA_REQUEST_TIMEOUT_MS = 4000;
  // Range.toString() over the whole sentence runs on every hover, so the
  // container the offsets are relative to has to stay sentence-sized even on
  // pages that put an entire chapter in one element.
  const MAX_SENTENCE_LENGTH = 4096;

  // Same character set PR #549 gates lookups on: kana, halfwidth katakana, CJK
  // ideographs (including ext-A and ext-B), and the iteration/repeat marks.
  const JAPANESE_TOKEN_PATTERN =
    /^[々-〇〻぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ\u{20000}-\u{2fa1f}]+$/u;
  const JAPANESE_CHARACTER_PATTERN =
    /[々-〇〻぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ\u{20000}-\u{2fa1f}]/u;
  const TOKEN_BOUNDARY_PATTERN = /[\p{White_Space}\p{Punctuation}\p{Symbol}]/u;
  const COLLAPSIBLE_WHITESPACE_PATTERN = /[\t\n\r\f ]/u;
  const SEGMENT_BREAK_PATTERN = /[\n\r]/u;
  // Deliberately narrow: "receiving end does not exist" also fires while the
  // service worker is still waking up, and tearing down on that would kill the
  // content script over a transient race.
  const INVALIDATED_MESSAGE_PATTERN = /context invalidated/iu;

  // Text in these never belongs to the running prose: script and style hold
  // source, rt/rp hold reading annotations that must not splice into the
  // scanned string, and form controls hold values rather than page text.
  const OPAQUE_TAGS = new Set([
    "audio",
    "canvas",
    "embed",
    "head",
    "iframe",
    "math",
    "noscript",
    "object",
    "option",
    "optgroup",
    "rp",
    "rt",
    "script",
    "select",
    "style",
    "svg",
    "template",
    "textarea",
    "title",
    "video",
  ]);
  const EDITING_TAGS = new Set(["button", "input", "select", "textarea"]);
  const EDITING_SELECTOR = [...EDITING_TAGS, "[contenteditable]"].join(",");
  // `display` values that keep text flowing inline, so the scan may cross them.
  const INLINE_DISPLAY_PATTERN = /^(?:inline|ruby|contents)/u;
  const PRESERVED_WHITESPACE = new Set([
    "pre",
    "pre-wrap",
    "pre-line",
    "break-spaces",
  ]);

  if (
    location.protocol === "chrome-extension:" ||
    typeof document.createTreeWalker !== "function"
  ) {
    return;
  }

  let disposed = false;
  let options = { ...DEFAULT_OPTIONS };
  let dictionaries = [];
  let nextRequestId = 0;
  let currentGeneration = -1;

  const rootLevel = createLevelState(0);
  const levels = [rootLevel];
  let nextLevelId = 0;

  function createLevelState(depth) {
    return {
      depth, popup: null, view: null, highlighter: null, retired: false,
      activeCandidate: null, activeSignature: null, activeHighlightText: "",
      activeTermRender: null, currentViewRequest: null, noteEditing: false,
      pendingCustomAppends: 0, deferredDictionaryInvalidationRevision: -1,
      deferredRefresh: null, lookupToken: 0, pendingLink: null,
    };
  }

  let host = null;
  let shadow = null;
  let highlighter = null;
  let uiPromise = null;

  let styleGeneration = -1;
  let styleRequest = null;
  const mediaCache = new Map();
  const pendingMedia = new Map();
  let mediaCacheBytes = 0;
  let activeMediaRequests = 0;
  let mediaQueue = [];

  let lastPointer = null;
  let scanTimer = null;
  let hideTimer = null;
  let transferTimer = null;
  let descendantTimer = null;
  let pointerLevel = null;
  let pointerInPopup = false;
  let activationPressed = false;
  let activationCode = null;
  let pendingCandidateLookup = null;
  let selectionDragActive = false;
  let activeSelectionCandidate = null;

  let optionsStorageRevision = -1;
  let dictionaryStateRevision = -1;

  function extensionAlive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function nonnegativeCount(value) {
    const count = Math.trunc(Number(value));
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function normalizeDictionaryState(stored) {
    const state = stored && typeof stored === "object" ? stored : {};
    const rows = Array.isArray(state.dictionaries) ? state.dictionaries : [];
    const normalized = rows.flatMap((entry) => {
      const title = typeof entry?.title === "string" ? entry.title : "";
      if (!title) {
        return [];
      }
      return [{
        id: typeof entry.id === "string" ? entry.id : "",
        title,
        displayName: typeof entry.displayName === "string" && entry.displayName.trim() !== ""
          ? entry.displayName.trim()
          : null,
        path: typeof entry.path === "string" ? entry.path : "",
        revision: typeof entry.revision === "string" ? entry.revision : "",
        enabled: entry.enabled !== false,
        favorite: entry.favorite === true,
        termCount: nonnegativeCount(entry.termCount),
        frequencyCount: nonnegativeCount(entry.frequencyCount),
        pitchCount: nonnegativeCount(entry.pitchCount),
        kanjiCount: nonnegativeCount(entry.kanjiCount),
      }];
    });
    return {
      revision: Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
      dictionaries: normalized,
    };
  }

  function sameDictionaries(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function sameDictionaryContents(left, right) {
    const contents = (entries) => entries.map(({ displayName, favorite, ...dictionary }) => dictionary);
    return left === right || sameDictionaries(contents(left), contents(right));
  }

  function hasCapability(dictionary, kind) {
    if (kind === "freq") return dictionary.frequencyCount > 0;
    if (kind === "pitch") return dictionary.pitchCount > 0;
    if (kind === "kanji") return dictionary.kanjiCount > 0;
    if (dictionary.termCount > 0) return true;
    return dictionary.frequencyCount === 0 && dictionary.pitchCount === 0 && dictionary.kanjiCount === 0;
  }

  function dictionaryPresentation() {
    return dictionaries
      .filter((entry) => entry.enabled !== false)
      .map((entry) => ({
        title: entry.title,
        favorite: entry.favorite,
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
      }));
  }

  function selectedKanjiDictionaryCapability() {
    const selection = options.kanjiClickDictionary;
    const title = typeof selection === "string" ? selection : selection?.title;
    if (typeof title !== "string" || title === "") {
      return null;
    }
    const selected = dictionaries.find((entry) => entry.title === title && entry.enabled !== false);
    if (!selected) {
      return null;
    }
    const requestedKind = typeof selection === "object" ? selection.kind : "";
    const kind = requestedKind === ""
      ? hasCapability(selected, "kanji") ? "kanji" : "term"
      : requestedKind;
    if (!hasCapability(selected, kind)) {
      return null;
    }
    return { kind, title };
  }

  function projectResultsToDictionary(results, title) {
    const projected = [];
    for (const result of results) {
      const glossaries = Array.isArray(result?.term?.glossaries)
        ? result.term.glossaries.filter((glossary) => glossary && glossary.dictionary === title)
        : [];
      if (glossaries.length > 0) {
        projected.push({
          ...result,
          term: { ...result.term, glossaries },
        });
      }
    }
    return projected;
  }

  function isJapaneseToken(text) {
    const token = text.split(TOKEN_BOUNDARY_PATTERN, 1)[0];
    return token.length > 0 && JAPANESE_TOKEN_PATTERN.test(token);
  }

  function computedStyleFor(element, styleCache) {
    let style = styleCache.get(element);
    if (!style) {
      style = window.getComputedStyle(element);
      styleCache.set(element, style);
    }
    return style;
  }

  function isHiddenElement(element, styleCache) {
    const style = computedStyleFor(element, styleCache);
    return style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse";
  }

  function isBlockDisplay(element, styleCache) {
    return !INLINE_DISPLAY_PATTERN.test(
      computedStyleFor(element, styleCache).display
    );
  }

  function preservesWhitespace(element, styleCache) {
    if (!element) {
      return false;
    }
    const style = computedStyleFor(element, styleCache);
    const collapse = style.whiteSpaceCollapse;
    if (typeof collapse === "string" && collapse) {
      return collapse !== "collapse";
    }
    return PRESERVED_WHITESPACE.has(style.whiteSpace);
  }

  function isOurNode(node) {
    if (!host) {
      return false;
    }
    // The popup lives in a closed shadow root, so a caret or event inside it is
    // retargeted to the host; a node whose root is not the page document also
    // means "not page text" (user-agent shadow DOM of <input>, page shadow DOM).
    return node === host || (node.nodeType === Node.ELEMENT_NODE
      ? host.contains(node)
      : host.contains(node.parentNode));
  }

  /**
   * Both caret APIs return the nearest caret *boundary*, so a pointer in the
   * right half of a glyph reports the offset after it and the scan would start
   * one character late -- pointing straight at 食 in 食べたかった would look up
   * べたかった. Step back onto the preceding character when the pointer is
   * actually inside its box.
   */
  function alignToCharacter(range, clientX, clientY) {
    const node = range.startContainer;
    const offset = range.startOffset;
    if (!range.collapsed || offset === 0 || node.nodeType !== Node.TEXT_NODE) {
      return range;
    }
    const probe = document.createRange();
    try {
      probe.setStart(node, offset - 1);
      probe.setEnd(node, offset);
    } catch {
      return range;
    }
    for (const rect of probe.getClientRects()) {
      if (
        clientX >= rect.left && clientX <= rect.right &&
        clientY >= rect.top && clientY <= rect.bottom
      ) {
        range.setStart(node, offset - 1);
        range.collapse(true);
        return range;
      }
    }
    return range;
  }

  function caretRangeAt(clientX, clientY) {
    if (typeof document.caretRangeFromPoint === "function") {
      const range = document.caretRangeFromPoint(clientX, clientY);
      return range === null ? null : alignToCharacter(range, clientX, clientY);
    }
    if (typeof document.caretPositionFromPoint === "function") {
      const position = document.caretPositionFromPoint(clientX, clientY);
      if (!position) {
        return null;
      }
      const range = document.createRange();
      try {
        range.setStart(position.offsetNode, position.offset);
        range.setEnd(position.offsetNode, position.offset);
      } catch {
        return null;
      }
      return alignToCharacter(range, clientX, clientY);
    }
    return null;
  }

  function isEditingElement(element) {
    return element?.isContentEditable === true || EDITING_TAGS.has(element?.localName);
  }

  function pageEditorFocused() {
    for (let focused = document.activeElement; focused; focused = focused.shadowRoot?.activeElement) {
      if (isEditingElement(focused)) return true;
    }
    return false;
  }

  function isScannableElement(element, styleCache) {
    if (!element || element.getRootNode() !== document || isOurNode(element) || isHiddenElement(element, styleCache)) {
      return false;
    }
    for (let current = element; current; current = current.parentElement) {
      if (isEditingElement(current) || OPAQUE_TAGS.has(current.localName)
          || computedStyleFor(current, styleCache).display === "none") {
        return false;
      }
    }
    return true;
  }

  function isScannableTextNode(node, styleCache) {
    return node?.nodeType === Node.TEXT_NODE && isScannableElement(node.parentElement, styleCache);
  }

  /**
   * Nearest block-level ancestor, shrunk to the largest descendant that still
   * fits MAX_SENTENCE_LENGTH. This element is both the walk root and the
   * coordinate space `sentence`/`matchOffset` are expressed in, so
   * `sourceElements.map(textContent).join("") === sentence` holds by
   * construction, which is what createSourceHighlighter requires.
   */
  function resolveScanContainer(textNode, styleCache) {
    let block = null;
    for (
      let element = textNode.parentElement;
      element && element !== document.documentElement;
      element = element.parentElement
    ) {
      if (isBlockDisplay(element, styleCache)) {
        block = element;
        break;
      }
    }
    if (!block) {
      block = textNode.parentElement;
    }
    if (!block) {
      return null;
    }
    let scoped = textNode.parentElement;
    while (scoped !== block) {
      const parent = scoped.parentElement;
      if (!parent || (parent.textContent || "").length > MAX_SENTENCE_LENGTH) {
        break;
      }
      scoped = parent;
    }
    return scoped;
  }

  function pushCollapsedSpace(entries, node, offset, sourceLength, segmentBreak) {
    const previous = entries[entries.length - 1];
    if (previous && previous.collapsed) {
      // A run split across text nodes ("<span>食べ </span><span> ます</span>")
      // is still one collapsed space in the rendered line.
      previous.segmentBreak = previous.segmentBreak || segmentBreak;
      return;
    }
    entries.push({
      collapsed: true,
      node,
      offset,
      segmentBreak,
      sourceLength,
      text: " ",
    });
  }

  /** Appends `node`'s characters from `from` onward; false stops the walk. */
  function appendTextNode(entries, node, from, budget, styleCache) {
    const raw = node.nodeValue || "";
    const preserve = preservesWhitespace(node.parentElement, styleCache);
    let index = from;
    while (index < raw.length && entries.length < budget) {
      const character = String.fromCodePoint(raw.codePointAt(index));
      if (preserve) {
        if (SEGMENT_BREAK_PATTERN.test(character)) {
          return false;
        }
      } else if (COLLAPSIBLE_WHITESPACE_PATTERN.test(character)) {
        let end = index;
        let segmentBreak = false;
        while (
          end < raw.length &&
          COLLAPSIBLE_WHITESPACE_PATTERN.test(raw[end])
        ) {
          segmentBreak = segmentBreak || SEGMENT_BREAK_PATTERN.test(raw[end]);
          end += 1;
        }
        pushCollapsedSpace(entries, node, index, end - index, segmentBreak);
        index = end;
        continue;
      }
      entries.push({
        collapsed: false,
        node,
        offset: index,
        segmentBreak: false,
        sourceLength: character.length,
        text: character,
      });
      index += character.length;
    }
    return true;
  }

  function dropCjkSegmentBreaks(entries) {
    for (let index = entries.length - 1; index >= 1; index -= 1) {
      const entry = entries[index];
      const next = entries[index + 1];
      if (!entry.collapsed || !entry.segmentBreak || !next) {
        continue;
      }
      // CSS drops a segment break between two wide characters instead of
      // turning it into a space, so a source-wrapped 「日本\n語」 renders as
      // 日本語 and has to be scanned that way.
      if (
        JAPANESE_CHARACTER_PATTERN.test(entries[index - 1].text) &&
        JAPANESE_CHARACTER_PATTERN.test(next.text)
      ) {
        entries.splice(index, 1);
      }
    }
  }

  function collectScanEntries(startNode, startOffset, container, scanLength, styleCache) {
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return isHiddenElement(node.parentElement, styleCache) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
          }
          const editing = isEditingElement(node);
          if (
            (!editing && OPAQUE_TAGS.has(node.localName)) ||
            isOurNode(node) ||
            computedStyleFor(node, styleCache).display === "none"
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          if (editing) return hasVisibleContent(node, styleCache) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          // Visible controls and block elements are boundaries; ordinary inline
          // elements are skipped, including hidden wrappers whose descendants
          // may restore visibility. Hidden blocks still occupy layout space.
          return node.localName === "br" || isBlockDisplay(node, styleCache)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      }
    );
    walker.currentNode = startNode;

    const entries = [];
    // Collapsing and segment-break removal can only shorten the scan, so
    // over-collect and trim once the string is final.
    const budget = scanLength * 3 + 32;
    let node = startNode;
    let offset = startOffset;
    while (node && node.nodeType === Node.TEXT_NODE && entries.length < budget) {
      if (!appendTextNode(entries, node, offset, budget, styleCache)) {
        break;
      }
      offset = 0;
      node = walker.nextNode();
    }
    dropCjkSegmentBreaks(entries);
    return entries.slice(0, scanLength);
  }

  function rangeOffsetWithin(container, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(container);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  /**
   * Builds a candidate for the caret at (clientX, clientY), or null when there
   * is nothing Japanese to look up there.
   */
  function resolveCandidate(clientX, clientY) {
    const styleCache = new Map();
    const caretRange = caretRangeAt(clientX, clientY);
    if (!caretRange) {
      return null;
    }
    const startNode = caretRange.startContainer;
    if (!isScannableTextNode(startNode, styleCache)) {
      return null;
    }
    const container = resolveScanContainer(startNode, styleCache);
    if (!container || !container.contains(startNode)) {
      return null;
    }
    const entries = collectScanEntries(
      startNode,
      Math.min(caretRange.startOffset, (startNode.nodeValue || "").length),
      container,
      options.scanLength,
      styleCache
    );
    if (entries.length === 0) {
      return null;
    }
    const query = entries.map((entry) => entry.text).join("");
    if (options.onlyScanJapaneseText && !isJapaneseToken(query)) {
      return null;
    }

    const first = entries[0];
    let matchOffset;
    let anchorRange;
    try {
      matchOffset = rangeOffsetWithin(container, first.node, first.offset);
      anchorRange = document.createRange();
      anchorRange.setStart(first.node, first.offset);
      anchorRange.setEnd(
        first.node,
        Math.min(
          (first.node.nodeValue || "").length,
          first.offset + first.sourceLength
        )
      );
    } catch {
      return null;
    }
    return {
      anchor: container,
      anchorRange,
      matchOffset,
      query,
      scanEntries: entries,
      sentence: container.textContent || "",
      sourceDepth: -1,
      sourceElements: [container],
      vertical: computedStyleFor(container, styleCache)
        .writingMode.startsWith("vertical"),
    };
  }

  function selectionBoundaryElement(node) {
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function hasVisibleContent(element, styleCache) {
    if (computedStyleFor(element, styleCache).display === "none") return false;
    const visible = !isHiddenElement(element, styleCache);
    if (visible && element.getClientRects().length > 0) return true;
    for (const child of element.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && hasVisibleContent(child, styleCache)) return true;
      if (visible && child.nodeType === Node.TEXT_NODE) {
        // A display:contents editor has no box, but its editable text still does.
        const range = document.createRange();
        range.selectNodeContents(child);
        if (range.getClientRects().length > 0) return true;
      }
    }
    return false;
  }

  function resolveSelectedLookupCandidate(selection = window.getSelection()) {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const styleCache = new Map();
    if (!isScannableElement(selectionBoundaryElement(range.startContainer), styleCache)
        || !isScannableElement(selectionBoundaryElement(range.endContainer), styleCache)) return null;
    const query = selection.toString();
    if (!query.trim()) return null;
    const scanContainer = range.startContainer.nodeType === Node.TEXT_NODE
      ? resolveScanContainer(range.startContainer, styleCache) : null;
    const anchor = scanContainer?.contains(range.endContainer)
      ? scanContainer : selectionBoundaryElement(range.commonAncestorContainer);
    for (const control of anchor.querySelectorAll(EDITING_SELECTOR)) {
      if (isEditingElement(control) && range.intersectsNode(control)
          && hasVisibleContent(control, styleCache)) return null;
    }
    return {
      anchor,
      anchorRange: range.cloneRange(),
      exactSelection: true,
      matchOffset: rangeOffsetWithin(anchor, range.startContainer, range.startOffset),
      query,
      rawSelectionText: range.toString(),
      sentence: anchor.textContent || "",
      sourceDepth: -1,
      sourceElements: [anchor],
      vertical: computedStyleFor(anchor, styleCache).writingMode.startsWith("vertical"),
    };
  }

  function candidateStart(candidate) {
    if (candidate.linkAnchor) return { node: candidate.anchor, offset: 0 };
    return candidate.exactSelection === true
      ? { node: candidate.anchorRange.startContainer, offset: candidate.anchorRange.startOffset }
      : candidate.scanEntries[0];
  }

  function candidateSignature(candidate) {
    const first = candidateStart(candidate);
    return `${candidate.exactSelection === true}\u001f${first.offset}\u001f${candidate.matchOffset}\u001f${candidate.query}`;
  }

  function sameAnchorNode(candidate, other) {
    return Boolean(other) &&
      other.anchor === candidate.anchor &&
      candidateStart(other).node === candidateStart(candidate).node;
  }

  /**
   * Translates a matched length in scan coordinates into the raw substring of
   * `candidate.sentence` that covers it. createSourceHighlighter measures the
   * highlight as `matchedText.length` from `candidate.matchOffset` inside
   * `sentence`, and `sentence` still carries the rt text and uncollapsed
   * whitespace the scan dropped -- so the engine's own `matched` string is the
   * wrong length whenever the word crosses ruby or a line wrap.
   */
  function rawMatchedText(candidate, matched) {
    if (candidate.linkAnchor) return candidate.sentence;
    if (candidate.exactSelection === true) return candidate.rawSelectionText;
    const wanted = typeof matched === "string" ? matched.length : 0;
    if (wanted <= 0) {
      return "";
    }
    let consumed = 0;
    let last = null;
    for (const entry of candidate.scanEntries) {
      if (consumed >= wanted) {
        break;
      }
      consumed += entry.text.length;
      last = entry;
    }
    if (!last) {
      return "";
    }
    try {
      const end = rangeOffsetWithin(
        candidate.anchor,
        last.node,
        Math.min(
          (last.node.nodeValue || "").length,
          last.offset + last.sourceLength
        )
      );
      if (end > candidate.matchOffset) {
        return candidate.sentence.slice(candidate.matchOffset, end);
      }
    } catch {
      // Fall through to the engine's own string.
    }
    return matched;
  }

  function teardown(reason) {
    if (disposed) {
      return;
    }
    disposed = true;
    clearDictionaryResources();
    window.clearTimeout(scanTimer);
    window.clearTimeout(hideTimer);
    clearTransferTimer();
    clearDescendantTimer();
    scanTimer = null;
    hideTimer = null;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("focusin", onPageFocusIn, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("blur", onWindowBlur);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // The context is already gone; the listener died with it.
    }
    try {
      highlighter?.clearAll();
      for (const level of levels) level.view?.destroy();
    } catch {
      // Teardown is best effort.
    }
    host?.remove();
    host = null;
    shadow = null;
    rootLevel.popup = null;
    rootLevel.view = null;
    highlighter = null;
    rootLevel.activeCandidate = null;
    rootLevel.activeTermRender = null;
    rootLevel.currentViewRequest = null;
    rootLevel.noteEditing = false;
    if (reason) {
      console.debug(`hachidori: content script stopped (${reason})`);
    }
  }

  function discardUi() {
    clearDictionaryResources();
    try {
      highlighter?.clearAll();
      for (const level of levels) level.view?.destroy();
    } catch {
      // Best effort: the point is only to leave nothing half-built behind.
    }
    host?.remove();
    host = null;
    shadow = null;
    rootLevel.popup = null;
    rootLevel.view = null;
    highlighter = null;
    rootLevel.activeCandidate = null;
    rootLevel.activeSignature = null;
    rootLevel.activeTermRender = null;
    rootLevel.currentViewRequest = null;
    rootLevel.noteEditing = false;
  }

  function clearDictionaryResources() {
    mediaCache.clear();
    mediaCacheBytes = 0;
    mediaQueue = [];
    for (const job of [...pendingMedia.values()]) {
      finishMediaJob(job, new Error("obsolete media request"));
    }
    styleGeneration = -1;
    styleRequest = null;
  }

  function noteGeneration(generation, owner = rootLevel) {
    if (!Number.isFinite(generation) || generation === currentGeneration) {
      return;
    }
    currentGeneration = generation;
    clearDictionaryResources();
    // Generation is an engine incarnation, not a monotonic storage revision.
    // Invalidate other in-flight owners even when a restarted engine returns 1.
    for (const level of levels) {
      if (level !== owner) level.lookupToken += 1;
    }
  }

  function sendRequest(type, payload, target = TARGET) {
    return new Promise((resolve, reject) => {
      if (disposed || !extensionAlive()) {
        teardown("context-invalidated");
        reject(new Error("extension context invalidated"));
        return;
      }
      const requestId = `${type.replace(/^hd_/u, "")}-${nextRequestId += 1}`;
      const request = { ...payload, requestId, target, type };
      try {
        chrome.runtime.sendMessage(request, (reply) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            const message = lastError.message || "sendMessage failed";
            if (INVALIDATED_MESSAGE_PATTERN.test(message)) {
              teardown("context-invalidated");
            }
            reject(new Error(message));
            return;
          }
          if (
            !reply ||
            reply.type !== `${type}_result` ||
            reply.requestId !== requestId
          ) {
            reject(new Error(`unexpected reply for ${type}`));
            return;
          }
          if (reply.ok !== true) {
            reject(new Error(reply.error || `${type} failed`));
            return;
          }
          resolve(reply);
        });
      } catch (error) {
        teardown("context-invalidated");
        reject(error);
      }
    });
  }

  function cacheMedia(key, url) {
    // The engine produces base64 data URLs. Count decoded bytes without
    // decoding or copying the payload merely to maintain the cache budget.
    const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
    const byteLength = (url.length - url.indexOf(",") - 1) / 4 * 3 - padding;
    mediaCache.set(key, { url, byteLength });
    mediaCacheBytes += byteLength;
    while (mediaCache.size > MAX_MEDIA_CACHE_ENTRIES || mediaCacheBytes > MAX_MEDIA_CACHE_BYTES) {
      const oldestKey = mediaCache.keys().next().value;
      mediaCacheBytes -= mediaCache.get(oldestKey).byteLength;
      // These are data URLs, not revocable Blob URLs. Drop our reference;
      // an image already rendered from it retains its independent DOM owner.
      mediaCache.delete(oldestKey);
    }
  }

  function finishMediaJob(job, error, url) {
    if (job.settled) return;
    job.settled = true;
    if (job.timer !== null) window.clearTimeout(job.timer);
    if (pendingMedia.get(job.key) === job) pendingMedia.delete(job.key);
    if (job.active) {
      job.active = false;
      activeMediaRequests -= 1;
    }
    if (error) job.reject(error);
    else job.resolve(url);
  }

  function pruneMediaQueue() {
    mediaQueue = mediaQueue.filter((job) => {
      if (job.consumers.some((isCurrent) => isCurrent())) return true;
      finishMediaJob(job, new Error("obsolete media request"));
      return false;
    });
  }

  async function dispatchMedia(job) {
    try {
      const reply = await sendRequest("hd_media", job.payload);
      if (job.settled) return;
      if (pendingMedia.get(job.key) !== job || job.payload.generation !== currentGeneration
          || reply.generation !== job.payload.generation) {
        throw new Error("obsolete media reply");
      }
      if (typeof reply.dataUrl !== "string") throw new Error("dictionary image is unavailable");
      // Started resource fetches may finish while hidden; image callbacks
      // separately check their current view before touching DOM.
      cacheMedia(job.key, reply.dataUrl);
      finishMediaJob(job, null, reply.dataUrl);
    } catch (error) {
      finishMediaJob(job, error);
    } finally {
      pumpMediaQueue();
    }
  }

  function pumpMediaQueue() {
    while (mediaQueue.length > 0 && activeMediaRequests < MAX_MEDIA_CONCURRENT_REQUESTS) {
      const job = mediaQueue.shift();
      if (!job.consumers.some((isCurrent) => isCurrent())) {
        finishMediaJob(job, new Error("obsolete media request"));
        continue;
      }
      job.active = true;
      activeMediaRequests += 1;
      job.timer = window.setTimeout(() => {
        finishMediaJob(job, new Error("dictionary image request timed out"));
        pumpMediaQueue();
      }, MEDIA_REQUEST_TIMEOUT_MS);
      void dispatchMedia(job);
    }
  }

  function resolveMedia({ dictionary, generation, path, isCurrent }) {
    if (!isCurrent() || generation !== currentGeneration) {
      return Promise.reject(new Error("obsolete media request"));
    }
    const key = `${generation}\u0000${dictionary}\u0000${path}`;
    const cached = mediaCache.get(key);
    if (cached) {
      mediaCache.delete(key);
      mediaCache.set(key, cached);
      return Promise.resolve(cached.url);
    }
    const pending = pendingMedia.get(key);
    if (pending) {
      pending.consumers.push(isCurrent);
      return pending.promise;
    }
    if (pendingMedia.size >= MAX_MEDIA_PENDING_REQUESTS) pruneMediaQueue();
    if (pendingMedia.size >= MAX_MEDIA_PENDING_REQUESTS) {
      return Promise.reject(new Error("dictionary image queue is full"));
    }
    const job = { key, consumers: [isCurrent], payload: { dictionary, generation, path },
      active: false, settled: false, timer: null };
    job.promise = new Promise((resolveJob, rejectJob) => {
      job.resolve = resolveJob;
      job.reject = rejectJob;
    });
    pendingMedia.set(key, job);
    mediaQueue.push(job);
    pumpMediaQueue();
    return job.promise;
  }

  function ensureDictionaryStyles(generation) {
    if (!shadow || generation === styleGeneration) {
      return;
    }
    styleGeneration = generation;
    const request = {};
    styleRequest = request;
    sendRequest("hd_styles", {}).then((reply) => {
      if (disposed || !shadow || styleRequest !== request) {
        return;
      }
      if (reply.generation !== generation) throw new Error("obsolete dictionary styles");
      window.HDGlossary.applyDictionaryStyles(
        document,
        shadow,
        generation,
        Array.isArray(reply.styles) ? reply.styles : []
      );
    }).catch(() => {
      // Dictionary CSS is cosmetic; a failure must not block the lookup that
      // asked for it. Retry on the next render without resetting a newer job.
      if (styleRequest === request) {
        styleGeneration = -1;
        styleRequest = null;
      }
    });
  }

  function calculatePopupPosition(anchorRect, viewport, vertical) {
    return window.HDPopup.calculatePopupPosition(anchorRect, {
      width: POPUP_WIDTH_PX, height: POPUP_HEIGHT_PX,
    }, viewport, { gap: POPUP_GAP_PX, padding: POPUP_PADDING_PX, vertical });
  }

  function anchorRectFor(candidate) {
    if (candidate.anchorRange) {
      try {
        const rect = candidate.anchorRange.getBoundingClientRect();
        if (rect && Number.isFinite(rect.left) && (rect.width > 0 || rect.height > 0)) {
          return rect;
        }
      } catch {
        // The range's nodes moved; fall back to the container box.
      }
    }
    return candidate.anchor.getBoundingClientRect();
  }

  function anchorConnected(candidate) {
    return Boolean(candidate) &&
      candidate.anchor.isConnected &&
      candidateStart(candidate).node.isConnected &&
      (candidate.exactSelection !== true || (
        !candidate.anchorRange.collapsed
        && candidate.anchor.contains(candidate.anchorRange.startContainer)
        && candidate.anchor.contains(candidate.anchorRange.endContainer)
      ));
  }

  function requestCanRender(token, candidate, level = rootLevel) {
    if (disposed || level.retired || token !== level.lookupToken || !level.popup) return false;
    if (retireDetachedAncestor(level)) return false;
    // Initial selections still own the live page selection; Note/Back replays
    // intentionally use their stored descriptor even after focus collapses it.
    if (!anchorConnected(candidate) || (level === rootLevel && pendingCandidateLookup?.token === token
        && candidate.exactSelection === true && !selectionIsUnchanged(candidate))) {
      hide(level);
      return false;
    }
    return true;
  }

  function retireDetachedAncestor(level) {
    for (let depth = 0; depth < level.depth; depth += 1) {
      const ancestor = levels[depth];
      if (!anchorConnected(ancestor.activeCandidate)) {
        hide(ancestor);
        return true;
      }
    }
    return false;
  }

  function handleLookupFailure(token, error, level = rootLevel) {
    if (!disposed && !level.retired && token === level.lookupToken) {
      console.debug("hachidori: lookup failed", error);
      hide(level);
    }
    return false;
  }

  function positionPopup(fromLevel = rootLevel) {
    if (fromLevel.retired || !rootLevel.popup || rootLevel.popup.hidden || !rootLevel.activeCandidate) {
      return;
    }
    if (retireDetachedAncestor(fromLevel)) return;
    if (!anchorConnected(rootLevel.activeCandidate)) {
      hide();
      return;
    }
    if (fromLevel === rootLevel) {
      const position = calculatePopupPosition(
        anchorRectFor(rootLevel.activeCandidate),
        { height: window.innerHeight, width: window.innerWidth },
        rootLevel.activeCandidate.vertical
      );
      // The toolbar sits on the edge nearest the word being read.
      if (position.placement !== "beside") {
        const desired = position.placement === "above" ? "bottom" : "top";
        if (rootLevel.popup.dataset.toolbarPosition !== desired) {
          rootLevel.view.setToolbarPosition(desired);
        }
      }
      rootLevel.popup.style.left = `${position.left}px`;
      rootLevel.popup.style.top = `${position.top}px`;
      rootLevel.popup.style.width = `${position.width}px`;
      rootLevel.popup.style.height = `${position.height}px`;
    }
    if (levels.length === 1) return;
    if (window.innerWidth <= POPUP_PADDING_PX * 2 || window.innerHeight <= POPUP_PADDING_PX * 2) {
      pruneLevels(1);
      return;
    }
    const startDepth = Math.max(1, fromLevel.depth);
    let parentRect = levels[startDepth - 1].popup.getBoundingClientRect();
    for (const level of levels.slice(startDepth)) {
      if (level.popup.hidden) break;
      if (!anchorConnected(level.activeCandidate)) {
        hide(level);
        break;
      }
      const anchorRect = anchorRectFor(level.activeCandidate);
      const width = Math.min(POPUP_WIDTH_PX, window.innerWidth - POPUP_PADDING_PX * 2);
      const height = Math.min(POPUP_HEIGHT_PX, window.innerHeight - POPUP_PADDING_PX * 2);
      const rightRoom = window.innerWidth - parentRect.right - POPUP_GAP_PX - POPUP_PADDING_PX;
      const leftRoom = parentRect.left - POPUP_GAP_PX - POPUP_PADDING_PX;
      const preferredLeft = rightRoom >= width || rightRoom >= leftRoom
        ? parentRect.right + POPUP_GAP_PX
        : parentRect.left - width - POPUP_GAP_PX;
      const left = Math.max(POPUP_PADDING_PX, Math.min(preferredLeft, window.innerWidth - width - POPUP_PADDING_PX));
      const top = Math.max(POPUP_PADDING_PX, Math.min(anchorRect.top, window.innerHeight - height - POPUP_PADDING_PX));
      level.popup.style.left = `${left}px`;
      level.popup.style.top = `${top}px`;
      level.popup.style.width = `${width}px`;
      level.popup.style.height = `${height}px`;
      // Each parent box is read once, after its own placement, not once per
      // ancestor for every descendant. Narrow viewports may overlap panes.
      parentRect = level.popup.getBoundingClientRect();
    }
  }

  async function readerStyleSheet() {
    const response = await fetch(chrome.runtime.getURL(READER_STYLESHEET));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      return { sheet, text };
    } catch {
      // A constructed sheet is preferred (one parse shared by every frame), but
      // a plain <style> in the shadow root renders the same rules.
      return { sheet: null, text };
    }
  }

  function buildUi(styles) {
    host = document.createElement(HOST_TAG);
    // Inline !important is the only declaration a page cannot override, and the
    // host must stay a zero-sized, non-interactive fixed anchor whatever the
    // page's CSS says. `all: initial` also stops inherited page typography from
    // reaching the shadow tree.
    host.style.cssText = [
      "all: initial !important",
      "position: fixed !important",
      "top: 0 !important",
      "left: 0 !important",
      "width: 0 !important",
      "height: 0 !important",
      "pointer-events: none !important",
      "z-index: 2147483647 !important",
    ].join("; ");
    shadow = host.attachShadow({ mode: "closed" });
    if (styles.sheet) {
      shadow.adoptedStyleSheets = [styles.sheet];
    } else {
      const fallback = document.createElement("style");
      fallback.textContent = styles.text;
      shadow.appendChild(fallback);
    }

    document.body.appendChild(host);

    highlighter = window.HDPopup.createSourceHighlighter(
      window,
      document,
      HIGHLIGHT_NAME
    );
    buildLevelUi(rootLevel);
  }

  function buildLevelUi(level) {
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.dataset.hoshidictsDepth = String(level.depth);
    popup.hidden = true;
    popup.addEventListener("focusin", () => {
      cancelCandidateScan();
      clearHideTimer();
    });
    popup.addEventListener("focusout", onPopupFocusOut);
    popup.addEventListener("scroll", () => positionPopup(level), { passive: true });
    popup.addEventListener("mouseenter", () => onPopupEnter(level));
    shadow.appendChild(popup);
    level.popup = popup;
    level.highlighter = highlighter.scope(level);
    level.view = window.HDPopup.createPopupView({
      appendExpressionRuby: window.HDGlossary.appendExpressionRuby,
      appendTextOnlyGlossary: window.HDGlossary.appendTextOnlyGlossary,
      document,
      getPopupColumns: () => 1,
      highlightName: HIGHLIGHT_NAME,
      idPrefix: level === rootLevel ? "hoshidicts" : `hoshidicts-${nextLevelId += 1}`,
      onAddCustomEntry: (entry) => appendCustomEntry(entry, level),
      onKanjiClick: (character, result, candidate, link) => showKanji(character, result, candidate, link, level),
      onNoteEditingChange: (editing) => onNoteEditingChange(editing, level),
      onBeforeResultsRendered: () => pruneLevels(level.depth + 1),
      parseTagList: window.HDGlossary.parseTagList,
      popup,
      positionPopup: () => positionPopup(level),
      sourceHighlighter: level.highlighter,
      sourceHighlightEnabled: true,
      toolbarPosition: "top",
      window,
    });
  }

  function ensureUi() {
    if (!uiPromise) {
      uiPromise = (async () => {
        if (!document.body || !window.HDPopup || !window.HDGlossary) {
          throw new Error("render modules or document body unavailable");
        }
        let styles;
        try {
          styles = await readerStyleSheet();
        } catch (error) {
          throw new Error(`could not load ${READER_STYLESHEET}: ${error.message}`);
        }
        if (disposed) {
          throw new Error("torn down");
        }
        buildUi(styles);
      })().catch((error) => {
        console.warn("hachidori: popup unavailable", error);
        // The next hover retries, so a half-built host must not stay in the page
        // and must not leave `view` null behind a non-null `popup`.
        discardUi();
        uiPromise = null;
        throw error;
      });
    }
    return uiPromise;
  }

  function show(candidate, level = rootLevel) {
    level.activeCandidate = candidate;
    level.activeSignature = candidateSignature(candidate);
    if (!host.isConnected && document.body) {
      // A single-page app that swapped out document.body took the host with it.
      document.body.appendChild(host);
    }
    level.popup.hidden = false;
    level.popup.scrollTop = 0;
  }

  function pruneLevels(depth, restoreFocus = true) {
    const source = levels[depth]?.activeCandidate?.anchor;
    const removed = levels.splice(Math.max(1, depth));
    clearDescendantTimer();
    const focused = removed.some((level) => level.popup?.contains(shadow?.activeElement));
    for (const level of removed.reverse()) {
      level.retired = true;
      level.lookupToken += 1;
      level.popup.hidden = true;
      level.view?.clear();
      level.view?.destroy();
      level.popup?.remove();
    }
    if (restoreFocus && focused && source?.isConnected) source.focus({ preventScroll: true });
    if (levels.length === 1) clearTransferTimer();
  }

  function hide(level = rootLevel) {
    if (level !== rootLevel) {
      if (!level.retired) pruneLevels(level.depth);
      return;
    }
    clearScanTimer();
    selectionDragActive = false;
    activeSelectionCandidate = null;
    pendingCandidateLookup = null;
    clearHideTimer();
    clearTransferTimer();
    pointerLevel = null;
    pruneLevels(1, false);
    rootLevel.activeCandidate = null;
    rootLevel.activeSignature = null;
    rootLevel.activeHighlightText = "";
    rootLevel.activeTermRender = null;
    rootLevel.currentViewRequest = null;
    rootLevel.noteEditing = false;
    rootLevel.deferredDictionaryInvalidationRevision = -1;
    rootLevel.deferredRefresh = null;
    rootLevel.lookupToken += 1;
    if (!rootLevel.popup) {
      return;
    }
    rootLevel.popup.hidden = true;
    rootLevel.view.clear();
    highlighter.clearAll();
  }

  function clearHideTimer() {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function clearTransferTimer() {
    if (transferTimer !== null) window.clearTimeout(transferTimer);
    transferTimer = null;
  }

  function scheduleTransferCheck() {
    clearTransferTimer();
    transferTimer = window.setTimeout(() => {
      transferTimer = null;
      if (lastPointer && (isOurNode(lastPointer.target)
          || pointInsidePopup(lastPointer.clientX, lastPointer.clientY))) {
        pointerInPopup = true;
        clearHideTimer();
      } else if (lastPointer) scanPointer(lastPointer);
      else scheduleHide();
    }, 80);
  }

  function clearDescendantTimer() {
    if (descendantTimer !== null) window.clearTimeout(descendantTimer);
    descendantTimer = null;
  }

  function onPopupEnter(level) {
    if (level.retired) return;
    pointerLevel = level;
    pointerInPopup = true;
    clearTransferTimer();
    clearHideTimer();
    clearDescendantTimer();
    const depth = level.depth + 1;
    if (depth >= levels.length) return;
    const prune = () => {
      descendantTimer = null;
      if (!hasProtectedNote(depth) && (!pointerLevel || pointerLevel.depth < depth)
          && !levels.slice(depth).some((child) => child.popup.contains(shadow.activeElement))) pruneLevels(depth);
    };
    if (options.popupHideDelayMs === 0) prune();
    else descendantTimer = window.setTimeout(prune, options.popupHideDelayMs);
  }

  function popupHasFocus() {
    return levels.some((level) => level.popup?.contains(shadow?.activeElement));
  }

  function hasProtectedNote(fromDepth = 0) {
    for (let index = fromDepth; index < levels.length; index += 1) {
      if (levels[index].noteEditing || levels[index].pendingCustomAppends > 0) return true;
    }
    return false;
  }

  function onPopupFocusOut(event) {
    const target = event.target;
    window.queueMicrotask(() => {
      // A redraw can remove the focused Note form. That is not departure
      // from the refreshed popup; wait until removal/focus transfer settles.
      if (target.isConnected && levels.some((level) => level.popup?.contains(target))) scheduleHide();
    });
  }

  function scheduleHide() {
    if (disposed || hasProtectedNote() || !rootLevel.popup || rootLevel.popup.hidden
        || popupHasFocus() || hideTimer !== null || transferTimer !== null) {
      return;
    }
    // The gap between the word and the popup is dead space; give the pointer
    // time to cross it so the popup stays reachable and selectable.
    const dismiss = () => {
      hideTimer = null;
      if (!hasProtectedNote() && !pointerInPopup && !popupHasFocus()) {
        hide();
      }
    };
    if (options.popupHideDelayMs === 0) dismiss();
    else hideTimer = window.setTimeout(dismiss, options.popupHideDelayMs);
  }

  function renderContextFor(level = rootLevel) {
    return {
      averageFrequency: false,
      definitionBlurState: "revealed",
      dictionaryPresentation: dictionaryPresentation(),
      dictionaryTabGroups: [],
      generation: currentGeneration,
      hidePopupGrammarTags: false,
      onExternalLink({ url, active }) {
        // A lost reply may follow a successful open, so never retry navigation.
        void sendRequest("hd_open_external", { url, active }, "hoshidicts-worker").catch((error) => {
          console.debug("hachidori: external link could not be opened", error);
        });
      },
      onInternalLink: (link) => onInternalLink(link, level),
      resolveMedia,
      showCompactDefinitionSummary: false,
      showFrequencyDictionaryNames: true,
      showPitchAccentBadge: true,
      showPitchAccentFurigana: true,
    };
  }

  function focusPopupControl(selector, level = rootLevel) {
    const control = level.popup?.querySelector(selector);
    if (typeof control?.focus !== "function") {
      return;
    }
    try {
      control.focus({ preventScroll: true });
    } catch {
      control.focus();
    }
  }

  function kanjiLinkFocusTarget(sourceLink, character, level = rootLevel) {
    const links = level.popup?.querySelectorAll(".gsm-hoshidicts-kanji-link");
    const index = links ? Array.prototype.indexOf.call(links, sourceLink) : -1;
    return { character, index };
  }

  function focusKanjiLink(focusTarget, level = rootLevel) {
    const links = level.popup?.querySelectorAll(".gsm-hoshidicts-kanji-link");
    if (!links || links.length === 0) {
      return;
    }
    const character = typeof focusTarget === "object" ? focusTarget?.character : focusTarget;
    let target = links[0];
    const index = Number.isInteger(focusTarget?.index) ? focusTarget.index : -1;
    if (index >= 0 && index < links.length && links[index].textContent === character) {
      target = links[index];
    } else if (typeof character === "string" && character !== "") {
      for (const link of links) {
        if (link.textContent === character) {
          target = link;
          break;
        }
      }
    }
    if (typeof target?.focus !== "function") {
      return;
    }
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }

  async function restoreTermRender(previous, focusTarget, level = rootLevel) {
    if (previous.generation !== currentGeneration || !sameDictionaryContents(previous.dictionaries, dictionaries)) {
      const restoring = executeViewRequest(previous.request, level);
      const token = level.lookupToken;
      if (await restoring && token === level.lookupToken && level.currentViewRequest === previous.request) {
        focusKanjiLink(focusTarget, level);
      }
      return;
    }
    level.lookupToken += 1;
    renderTerms(
      previous.results,
      previous.candidate,
      previous.matchedText,
      previous.renderOptions,
      previous.request,
      level,
    );
    focusKanjiLink(focusTarget, level);
  }

  function normalizedDictionaryTab(value) {
    if (typeof value?.dictionary === "string") {
      return { dictionary: value.dictionary };
    }
    if (typeof value?.groupId === "string") {
      return { groupId: value.groupId };
    }
    return null;
  }

  function backRenderOptions(request, level = rootLevel) {
    return request?.previous
      ? { onBack: () => restoreTermRender(request.previous, request.returnFocus, level) }
      : level === rootLevel ? {} : { onBack: () => hide(level) };
  }

  function renderTerms(
    results,
    candidate,
    matchedText,
    renderOptions = {},
    request,
    level = rootLevel,
  ) {
    request ??= level.currentViewRequest;
    level.deferredRefresh = null;
    level.deferredDictionaryInvalidationRevision = -1;
    pruneLevels(level.depth + 1);
    const token = level.lookupToken;
    level.currentViewRequest = request ?? null;
    level.activeTermRender = {
      candidate,
      dictionaries,
      generation: currentGeneration,
      matchedText,
      renderOptions,
      request: level.currentViewRequest,
      results,
      token,
    };
    try {
      level.view.renderResults(results, candidate, {
        ...renderContextFor(level),
        ...renderOptions,
        isCurrentRequest: () => !disposed && !level.retired && token === level.lookupToken,
        onRenderError(error) { handleLookupFailure(token, error, level); },
        selectedDictionaryTab: level.currentViewRequest?.selectedDictionaryTab ?? null,
        onDictionaryTabSelected(selection) {
          if (request) request.selectedDictionaryTab = normalizedDictionaryTab(selection);
        },
      });
    } catch (error) {
      // A malformed result must cost one hover, not the whole content script.
      console.warn("hachidori: could not render results", error);
      hide(level);
      return;
    }
    level.activeHighlightText = matchedText;
    if (matchedText) {
      // renderResults already applied the engine's `matched` string; re-apply
      // with the raw-sentence span so ruby and wrapped lines highlight exactly
      // the characters the reader sees.
      (level.highlighter || highlighter).apply(candidate, matchedText);
    }
    ensureDictionaryStyles(currentGeneration);
    positionPopup(level);
    if (typeof renderOptions.onBack === "function"
        && (level === rootLevel || request?.previous || level.focusLinkedBack)) {
      focusPopupControl(".gsm-hoshidicts-kanji-back", level);
    }
  }

  async function executeTermRequest(request, level = rootLevel) {
    const token = (level.lookupToken += 1);
    level.view?.hideImagePreview();
    let reply;
    try {
      // The first hover pays for the popup host and the stylesheet fetch; run
      // them alongside the lookup instead of ahead of it.
      [, reply] = await Promise.all([
        ensureUi(),
        sendRequest("hd_lookup", request.payload),
      ]);
    } catch (error) {
      return handleLookupFailure(token, error, level);
    }
    // Hover fires far faster than lookups return; anything but the newest reply
    // would repaint a word the pointer already left.
    if (!requestCanRender(token, request.candidate, level)) {
      return;
    }
    noteGeneration(reply.generation, level);
    const results = (Array.isArray(reply.results) ? reply.results : [])
      .filter((result) => result && result.term
        && (!request.exactSelection || result.matched === request.payload.text));
    if (results.length === 0) {
      if (reply.dictionaryCount === 0) {
        show(request.candidate, level);
        level.activeHighlightText = "";
        level.activeTermRender = null;
        level.currentViewRequest = null;
        level.view.renderNotice(
          "No dictionaries loaded. Import a Yomitan .zip from the Hachidori options page.",
          request.candidate
        );
        positionPopup(level);
        return false;
      }
      hide(level);
      // Retain an exact miss so subsequent pointer motion cannot turn it into
      // a prefix lookup. Explicit dismissal or another selection resets it.
      if (request.exactSelection && selectionIsUnchanged(request.candidate)) {
        activeSelectionCandidate = request.candidate;
      }
      return false;
    }
    show(request.candidate, level);
    const matched = results[0].matched || results[0].term.expression;
    if (request.highlightText === undefined) {
      request.highlightText = rawMatchedText(request.candidate, matched);
    }
    renderTerms(
      results,
      request.candidate,
      request.highlightText,
      backRenderOptions(request, level),
      request,
      level,
    );
    return true;
  }

  function runLookup(candidate, overrides = {}, level = rootLevel) {
    const text = typeof overrides.text === "string" ? overrides.text : candidate.query;
    const exactSelection = candidate.exactSelection === true && overrides.text === undefined;
    return executeTermRequest({
      candidate,
      exactSelection,
      highlightText: overrides.keepHighlight === true ? level.activeHighlightText : undefined,
      kind: "term",
      payload: {
        maxResults: options.maxResults,
        options: {
          frequencyDictionary: options.frequencyDictionary,
          frequencyOrder: options.frequencyOrder,
          primaryReading: typeof overrides.primaryReading === "string"
            ? overrides.primaryReading
            : "",
        },
        scanLength: exactSelection ? clampOption("scanLength", Array.from(text).length) : options.scanLength,
        text,
      },
      previous: overrides.previous ?? null,
      returnFocus: overrides.returnFocus ?? null,
      selectedDictionaryTab: null,
    }, level);
  }

  function onInternalLink({ anchor, focusChild = false, primaryReading = "", query }, level = rootLevel) {
    if (level.retired || !level.activeCandidate || !anchor?.isConnected
        || !level.popup.contains(anchor) || !query || level.depth >= options.popupNestingMaxDepth
        || window.innerWidth <= POPUP_PADDING_PX * 2 || window.innerHeight <= POPUP_PADDING_PX * 2) {
      return;
    }
    clearHideTimer();
    clearTransferTimer();
    clearDescendantTimer();
    const existing = levels[level.depth + 1];
    if (existing?.activeCandidate?.anchor === anchor && existing.activeCandidate.query === query
        && existing.primaryReading === primaryReading
        && (existing.pendingLink || (existing.currentViewRequest?.kind === "term"
          && existing.activeTermRender?.token === existing.lookupToken))) {
      if (focusChild) {
        existing.focusLinkedBack = true;
        if (!existing.popup.hidden) focusPopupControl(".gsm-hoshidicts-kanji-back", existing);
      }
      return existing.pendingLink;
    }
    pruneLevels(level.depth + 1, false);
    const child = createLevelState(level.depth + 1);
    levels.push(child);
    buildLevelUi(child);
    child.primaryReading = primaryReading;
    child.focusLinkedBack = focusChild;
    // Link text is an anchor/highlight, never the query's page-scan offsets.
    child.activeCandidate = {
      anchor, linkAnchor: true, query, matchOffset: 0,
      sentence: anchor.textContent || "", sourceElements: [anchor], sourceDepth: level.depth,
      vertical: false,
    };
    child.pendingLink = runLookup(child.activeCandidate, { primaryReading }, child);
    void child.pendingLink.finally(() => { child.pendingLink = null; });
    return child.pendingLink;
  }

  async function executeKanjiRequest(request, level = rootLevel) {
    const { candidate, capability, character } = request;
    const useTermDictionary = capability?.kind === "term";
    const token = (level.lookupToken += 1);
    level.view?.hideImagePreview();
    let reply;
    try {
      reply = useTermDictionary
        ? await sendRequest("hd_lookup_dictionary", request.termPayload)
        : await sendRequest("hd_kanji", request.kanjiPayload);
    } catch (error) {
      return handleLookupFailure(token, error, level);
    }
    if (!requestCanRender(token, candidate, level) || level.popup.hidden) {
      return false;
    }
    noteGeneration(reply.generation, level);
    if (useTermDictionary) {
      const results = projectResultsToDictionary(
        Array.isArray(reply.results) ? reply.results : [],
        capability.title
      );
      if (results.length > 0) {
        renderTerms(
          results,
          candidate,
          request.highlightText,
          backRenderOptions(request, level),
          request,
          level,
        );
        return true;
      }
      try {
        reply = await sendRequest("hd_kanji", request.kanjiPayload);
      } catch (error) {
        return handleLookupFailure(token, error, level);
      }
      if (!requestCanRender(token, candidate, level) || level.popup.hidden) {
        return false;
      }
      noteGeneration(reply.generation, level);
    }
    const kanji = reply.kanji;
    if (!kanji || !Array.isArray(kanji.entries) || kanji.entries.length === 0) {
      return false;
    }
    const entries = capability?.kind === "kanji"
      ? kanji.entries.filter((entry) => entry.dictionary === capability.title)
      : kanji.entries;
    if (entries.length === 0) {
      return false;
    }
    level.currentViewRequest = request;
    level.deferredRefresh = null;
    level.deferredDictionaryInvalidationRevision = -1;
    pruneLevels(level.depth + 1);
    try {
      level.view.renderKanji({ ...kanji, entries }, candidate, {
        dictionaryPresentation: dictionaryPresentation(),
        highlightText: request.highlightText,
        ...backRenderOptions(request, level),
      });
    } catch (error) {
      console.warn("hachidori: could not render kanji", error);
      hide(level);
      return false;
    }
    ensureDictionaryStyles(currentGeneration);
    positionPopup(level);
    focusPopupControl(".gsm-hoshidicts-kanji-back", level);
    return true;
  }

  function showKanji(character, _result, _candidate, sourceLink, level = rootLevel) {
    if (!level.activeCandidate || typeof character !== "string" || !character) {
      return;
    }
    const capability = selectedKanjiDictionaryCapability();
    return executeKanjiRequest({
      candidate: level.activeCandidate,
      capability,
      character,
      highlightText: level.activeHighlightText || character,
      kanjiPayload: { character },
      kind: "kanji",
      previous: level.activeTermRender,
      returnFocus: kanjiLinkFocusTarget(sourceLink, character, level),
      selectedDictionaryTab: null,
      termPayload: capability?.kind === "term"
        ? {
            dictionary: capability.title,
            maxResults: options.maxResults,
            options: {
              frequencyDictionary: options.frequencyDictionary,
              frequencyOrder: options.frequencyOrder,
              primaryReading: "",
            },
            scanLength: 1,
            text: character,
          }
        : null,
    }, level);
  }

  function executeViewRequest(request, level = rootLevel) {
    return request.kind === "kanji"
      ? executeKanjiRequest(request, level)
      : executeTermRequest(request, level);
  }

  async function appendCustomEntry(entry, level = rootLevel) {
    const expectedView = level.currentViewRequest;
    level.pendingCustomAppends += 1;
    try {
      const reply = await sendRequest("hd_custom_append", { entry });
      const adoption = adoptDictionaryState(reply.state);
      if (adoption.dictionaryChanged) invalidateStoredState(true);
      if (
        expectedView !== null
        && !level.retired
        && level.currentViewRequest === expectedView
        && level.popup && !level.popup.hidden
        && anchorConnected(expectedView.candidate)
      ) {
        level.deferredRefresh = expectedView;
      }
      return reply;
    } finally {
      level.pendingCustomAppends -= 1;
      flushDeferredNotes();
    }
  }

  function flushDeferredNotes() {
    for (const level of levels) {
      if (level.pendingCustomAppends > 0 || hasProtectedNote(level.depth + 1)) continue;
      const request = level.deferredRefresh;
      if (request && request === level.currentViewRequest && !level.popup.hidden
          && anchorConnected(request.candidate)) {
        level.deferredRefresh = null;
        level.deferredDictionaryInvalidationRevision = -1;
        // The append has committed. Replay failures must never invite a second
        // append, and a protected descendant must keep its source DOM alive.
        void executeViewRequest(request, level).catch((error) => {
          console.debug("hachidori: Note saved but the lookup could not refresh", error);
        });
        return;
      }
      if (!level.noteEditing && level.deferredDictionaryInvalidationRevision >= 0) {
        hide(level);
        return;
      }
    }
  }

  function clearScanTimer() {
    if (scanTimer !== null) {
      window.clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  function discardPendingCandidate() {
    if (pendingCandidateLookup?.candidate === activeSelectionCandidate) activeSelectionCandidate = null;
    pendingCandidateLookup = null;
  }

  function cancelCandidateScan() {
    clearScanTimer();
    // Retaining a rendered popup during transfer must not invalidate its media
    // or deferred glossary. Only an unfinished candidate loses ownership.
    if (pendingCandidateLookup?.token === rootLevel.lookupToken) rootLevel.lookupToken += 1;
    discardPendingCandidate();
  }

  function lookupCandidate(candidate, signature = candidateSignature(candidate)) {
    const lookup = runLookup(candidate);
    const pending = { token: rootLevel.lookupToken, candidate, signature };
    pendingCandidateLookup = pending;
    void lookup.finally(() => {
      if (pendingCandidateLookup === pending) pendingCandidateLookup = null;
    });
  }

  function activationAllowed() {
    return options.lookupMode === "hover" || activationPressed;
  }

  function updateModifierState(event) {
    const property = MODIFIER_PROPERTIES.get(options.activationKey);
    if (property) activationPressed = event[property] === true;
  }

  function pointInsidePopup(clientX, clientY) {
    const rects = levels.filter((level) => level.popup && !level.popup.hidden)
      .map((level) => level.popup.getBoundingClientRect());
    if (rects.some((rect) => clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom)) return true;
    return rects.slice(1).some((child, index) => {
      const parent = rects[index];
      const top = Math.max(parent.top, child.top) - 4;
      const bottom = Math.min(parent.bottom, child.bottom) + 4;
      const [left, right] = parent.right <= child.left ? [parent.right, child.left]
        : child.right <= parent.left ? [child.right, parent.left] : [1, 0];
      return left <= right && clientX >= left - 2 && clientX <= right + 2
        && clientY >= top && clientY <= bottom;
    });
  }

  function scanPointer(pointer) {
    if (disposed || !extensionAlive()) {
      teardown("context-invalidated");
      return;
    }
    if (!options.hoverEnabled) return;
    if (transferTimer !== null) return;
    if (hasProtectedNote() || popupHasFocus() || pageEditorFocused()) {
      cancelCandidateScan();
      clearHideTimer();
      return;
    }
    if (selectionDragActive || retainSelectedLookup()) return;
    pointerInPopup = isOurNode(pointer.target) ||
      pointInsidePopup(pointer.clientX, pointer.clientY);
    if (pointerInPopup) {
      cancelCandidateScan();
      clearHideTimer();
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      const selected = resolveSelectedLookupCandidate(selection);
      if (selected) startSelectionLookup(selected);
      else {
        cancelCandidateScan();
        scheduleHide();
      }
      return;
    }
    if (!activationAllowed()) {
      cancelCandidateScan();
      scheduleHide();
      return;
    }
    const candidate = resolveCandidate(pointer.clientX, pointer.clientY);
    if (!candidate) {
      cancelCandidateScan();
      scheduleHide();
      return;
    }
    const signature = candidateSignature(candidate);
    if (pendingCandidateLookup?.token === rootLevel.lookupToken
        && pendingCandidateLookup.signature === signature
        && sameAnchorNode(candidate, pendingCandidateLookup.candidate)) {
      clearHideTimer();
      return;
    }
    if (
      rootLevel.popup && !rootLevel.popup.hidden &&
      rootLevel.activeSignature === signature &&
      sameAnchorNode(candidate, rootLevel.activeCandidate)
    ) {
      clearHideTimer();
      return;
    }
    clearHideTimer();
    // A new valid pointer lookup owns this popup. Retire the previous view
    // rather than leave its expired glossary/media and Note controls usable.
    if (rootLevel.popup && !rootLevel.popup.hidden) hide();
    lookupCandidate(candidate, signature);
  }

  function onMouseMove(event) {
    if (disposed || !options.hoverEnabled) {
      return;
    }
    lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
    };
    updateModifierState(event);
    if (selectionDragActive && (event.buttons & 1) === 0) {
      selectionDragActive = false;
      onSelectionChange();
    }
    // Cancel a pending dismissal here rather than waiting for the throttled
    // scan, so the popup stays reachable even with hoverDelayMs turned up. The
    // retargeted event target is enough; the rect test costs a layout and can
    // wait for the scan.
    if (isOurNode(event.target)) {
      pointerInPopup = true;
      clearTransferTimer();
      cancelCandidateScan();
      clearHideTimer();
      return;
    }
    const leavingChain = pointerInPopup && levels.length > 1;
    pointerInPopup = false;
    pointerLevel = null;
    if (leavingChain) scheduleTransferCheck();
    if (hasProtectedNote() || popupHasFocus() || pageEditorFocused()) {
      cancelCandidateScan();
      return;
    }
    if (selectionDragActive) return;
    if (activeSelectionCandidate) {
      clearHideTimer();
      scheduleScan();
      return;
    }
    if (!activationAllowed() && window.getSelection()?.isCollapsed !== false) {
      cancelCandidateScan();
      scheduleHide();
      return;
    }
    scheduleScan();
  }

  function scheduleScan() {
    if (scanTimer !== null) {
      return;
    }
    // Trailing-edge throttle: at most one scan per hoverDelayMs, always at the
    // pointer's latest position.
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      if (lastPointer) {
        scanPointer(lastPointer);
      }
    }, options.hoverDelayMs);
  }

  function onMouseDown(event) {
    if (disposed) {
      return;
    }
    if (!isOurNode(event.target) && !pointInsidePopup(event.clientX, event.clientY)) {
      hide();
      selectionDragActive = event.button === 0 && options.hoverEnabled
        && isScannableElement(selectionBoundaryElement(event.target), new Map());
    }
  }

  function selectionIsUnchanged(candidate = activeSelectionCandidate) {
    if (!candidate) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const previous = candidate.anchorRange;
    return range.startContainer === previous.startContainer && range.startOffset === previous.startOffset
      && range.endContainer === previous.endContainer && range.endOffset === previous.endOffset
      && selection.toString() === candidate.query;
  }

  function startSelectionLookup(candidate) {
    hide();
    activeSelectionCandidate = candidate;
    lookupCandidate(candidate);
  }

  function retainSelectedLookup() {
    if (!activeSelectionCandidate) return false;
    if (!selectionIsUnchanged()) onSelectionChange();
    if (!activeSelectionCandidate) return false;
    clearHideTimer();
    return true;
  }

  function onSelectionChange() {
    if (disposed || !options.hoverEnabled || selectionDragActive || hasProtectedNote()
        || popupHasFocus() || pageEditorFocused() || selectionIsUnchanged()) return;
    const selection = window.getSelection();
    if ([selection?.anchorNode, selection?.focusNode].some((node) =>
      node && (node === host || node.getRootNode() === shadow))) return;
    const candidate = resolveSelectedLookupCandidate(selection);
    if (!candidate && !activeSelectionCandidate) return;
    if (candidate) startSelectionLookup(candidate);
    else hide();
  }

  function onMouseUp(event) {
    if (disposed || event.button !== 0 || !selectionDragActive) return;
    selectionDragActive = false;
    onSelectionChange();
  }

  function onPageFocusIn() {
    if (!disposed && pageEditorFocused()) cancelCandidateScan();
  }

  function onKeyDown(event) {
    if (disposed || event.repeat) {
      return;
    }
    if (event.key === "Escape") {
      if (rootLevel.popup && !rootLevel.popup.hidden) {
        const focused = levels.find((level) => level.popup.contains(shadow.activeElement));
        const editing = focused?.noteEditing ? focused : levels.findLast((level) => level.noteEditing);
        if ((editing || focused || levels.at(-1)).view?.closeNoteForm?.() === true) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.stopPropagation();
        hide(focused || levels.at(-1));
        return;
      }
      const dismissedCandidate = pendingCandidateLookup !== null || activeSelectionCandidate !== null;
      hide();
      if (dismissedCandidate || options.activationKey !== "Escape") return;
    }
    if (!options.hoverEnabled || pageEditorFocused()) return;
    // Pressing the gate key while the pointer is stationary should reveal the
    // word under it without asking the reader to jiggle the mouse.
    const wasPressed = activationPressed;
    updateModifierState(event);
    if (normaliseActivationKey(event.key, null) === options.activationKey) {
      activationPressed = true;
      activationCode = event.code;
    }
    if (!wasPressed && activationPressed && options.lookupMode === "activation"
        && lastPointer && !hasProtectedNote() && !popupHasFocus() && !pointerInPopup
        && !selectionDragActive && !retainSelectedLookup()) {
      scheduleScan();
    }
  }

  function onKeyUp(event) {
    if (disposed) return;
    updateModifierState(event);
    if (!MODIFIER_PROPERTIES.has(options.activationKey)
        && (event.code === activationCode || normaliseActivationKey(event.key, null) === options.activationKey)) {
      activationPressed = false;
    }
    if (!activationPressed) activationCode = null;
    if (options.lookupMode === "activation" && !activationPressed) {
      if (selectionIsUnchanged()) return;
      cancelCandidateScan();
      scheduleHide();
    }
  }

  function onMouseOut(event) {
    // A null relatedTarget on a document-level mouseout means the pointer left
    // the window entirely, which mouseleave cannot report from here: it does not
    // bubble, and a capture listener would fire for every element left.
    if (!disposed && event.relatedTarget === null) {
      lastPointer = null;
      pointerInPopup = false;
      cancelCandidateScan();
      scheduleHide();
    }
  }

  function onWindowBlur() {
    if (!disposed) {
      selectionDragActive = false;
      lastPointer = null;
      activationPressed = false;
      activationCode = null;
      pointerInPopup = false;
      hide();
    }
  }

  function onScroll() {
    cancelCandidateScan();
    rootLevel.view?.hideImagePreview();
    if (disposed || !rootLevel.popup || rootLevel.popup.hidden || !rootLevel.activeCandidate) {
      return;
    }
    if (!anchorConnected(rootLevel.activeCandidate)) {
      hide();
      return;
    }
    const rect = anchorRectFor(rootLevel.activeCandidate);
    if (
      rect.bottom < 0 || rect.top > window.innerHeight ||
      rect.right < 0 || rect.left > window.innerWidth
    ) {
      hide();
      return;
    }
    positionPopup();
  }

  function invalidateStoredState(dictionaryChanged) {
    discardPendingCandidate();
    // A completed selection hit or miss also belongs to the old lookup state.
    // Preserve Note's view ownership through its deferred refresh.
    if (!hasProtectedNote()) activeSelectionCandidate = null;
    for (const level of levels) {
      level.view?.hideImagePreview();
      level.lookupToken += 1;
      if (dictionaryChanged && level.popup && !level.popup.hidden) {
        if (!hasProtectedNote(level.depth)) {
          hide(level);
          return;
        }
        if (level.noteEditing || level.pendingCustomAppends > 0) {
          level.deferredDictionaryInvalidationRevision = dictionaryStateRevision;
        }
      }
    }
  }

  function onNoteEditingChange(editing, level = rootLevel) {
    if (level.retired) return;
    level.noteEditing = editing === true;
    if (level.noteEditing) {
      cancelCandidateScan();
      clearHideTimer();
    } else flushDeferredNotes();
  }

  function adoptDictionaryState(stored) {
    const next = normalizeDictionaryState(stored);
    if (next.revision <= dictionaryStateRevision) {
      return { adopted: false, dictionaryChanged: false };
    }
    const dictionaryChanged = !sameDictionaries(next.dictionaries, dictionaries);
    if (dictionaryChanged && !sameDictionaryContents(next.dictionaries, dictionaries)) clearDictionaryResources();
    dictionaryStateRevision = next.revision;
    dictionaries = next.dictionaries;
    return { adopted: true, dictionaryChanged };
  }

  function onStorageChanged(changes, area) {
    if (disposed || area !== "local") {
      return;
    }
    let changed = false;
    let dictionaryChanged = false;
    if (changes.options) {
      changed = adoptOptions(changes.options.newValue);
    }
    if (changes.dictionaryState) {
      const adoption = adoptDictionaryState(changes.dictionaryState.newValue);
      dictionaryChanged = adoption.dictionaryChanged;
      changed ||= dictionaryChanged;
    }
    if (changed) {
      invalidateStoredState(dictionaryChanged);
    }
  }

  function adoptOptions(stored) {
    const revision = Number.isInteger(stored?.revision) && stored.revision >= 0 ? stored.revision : 0;
    if (revision <= optionsStorageRevision) return false;
    const next = normalizeOptions(stored);
    const lookupChanged = next.scanLength !== options.scanLength || next.maxResults !== options.maxResults
      || next.frequencyDictionary !== options.frequencyDictionary || next.frequencyOrder !== options.frequencyOrder
      || JSON.stringify(next.kanjiClickDictionary) !== JSON.stringify(options.kanjiClickDictionary);
    const activationChanged = next.lookupMode !== options.lookupMode || next.activationKey !== options.activationKey;
    const interactionChanged = activationChanged || next.hoverEnabled !== options.hoverEnabled
      || next.onlyScanJapaneseText !== options.onlyScanJapaneseText;
    const scanDelayChanged = next.hoverDelayMs !== options.hoverDelayMs && scanTimer !== null;
    const hideDelayChanged = next.popupHideDelayMs !== options.popupHideDelayMs && hideTimer !== null;
    if (activationChanged) {
      activationPressed = false;
      activationCode = null;
    }
    optionsStorageRevision = revision;
    options = next;
    if (levels.length > options.popupNestingMaxDepth + 1) pruneLevels(options.popupNestingMaxDepth + 1);
    if (!options.hoverEnabled) {
      selectionDragActive = false;
      lastPointer = null;
      activationPressed = false;
      activationCode = null;
      hide();
    }
    else if (interactionChanged || scanDelayChanged) {
      if (selectionIsUnchanged()) {
        clearScanTimer();
        clearHideTimer();
        return lookupChanged;
      }
      cancelCandidateScan();
      clearHideTimer();
      if (!hasProtectedNote() && !popupHasFocus() && !pointerInPopup) {
        if (!activationAllowed()) scheduleHide();
        else if (lastPointer) scheduleScan();
      }
    } else if (hideDelayChanged) {
      clearHideTimer();
      scheduleHide();
    }
    return lookupChanged;
  }

  function start() {
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
      chrome.storage.local.get({ dictionaryState: null, options: DEFAULT_OPTIONS }, (stored) => {
        if (disposed || chrome.runtime.lastError) {
          return;
        }
        let changed = adoptOptions(stored && stored.options);
        let dictionaryChanged = false;
        const adoption = adoptDictionaryState(stored && stored.dictionaryState);
        dictionaryChanged = adoption.dictionaryChanged;
        changed ||= dictionaryChanged;
        if (changed) {
          invalidateStoredState(dictionaryChanged);
        }
      });
    } catch {
      // Without storage access the defaults are still usable.
    }
    // Capture so a page that stops propagation on its own text still gets
    // scanned; passive so the hot pointer and scroll paths can never delay the
    // page's own scrolling.
    const observe = { capture: true, passive: true };
    document.addEventListener("mousemove", onMouseMove, observe);
    document.addEventListener("mousedown", onMouseDown, observe);
    document.addEventListener("mouseup", onMouseUp, observe);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("focusin", onPageFocusIn, observe);
    document.addEventListener("mouseout", onMouseOut, observe);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("scroll", onScroll, observe);
    window.addEventListener("blur", onWindowBlur);
  }

  start();
}());
