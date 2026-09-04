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

  const DEFAULT_OPTIONS = {
    scanLength: 16,
    maxResults: 32,
    modifier: "none",
    hoverDelayMs: 50,
    kanjiClickDictionary: "",
    frequencyDictionary: "",
    frequencyOrder: "auto",
  };
  const MODIFIER_PROPERTIES = new Map([
    ["shift", "shiftKey"],
    ["ctrl", "ctrlKey"],
    ["alt", "altKey"],
  ]);
  const FREQUENCY_ORDERS = new Set([
    "auto",
    "ascending",
    "descending",
    "disabled",
  ]);
  const KANJI_SELECTION_KINDS = new Set(["term", "kanji"]);

  const POPUP_WIDTH_PX = 560;
  const POPUP_HEIGHT_PX = 420;
  const POPUP_GAP_PX = 4;
  const POPUP_PADDING_PX = 6;
  const HIDE_DELAY_MS = 160;
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

  let host = null;
  let shadow = null;
  let popup = null;
  let view = null;
  let highlighter = null;
  let uiPromise = null;

  let styleGeneration = -1;
  const mediaCache = new Map();

  let lastPointer = null;
  let scanTimer = null;
  let hideTimer = null;
  let pointerInPopup = false;

  let activeCandidate = null;
  let activeSignature = null;
  let activeHighlightText = "";
  let activeTermRender = null;
  let lookupToken = 0;
  let optionsStorageRevision = 0;
  let dictionaryStateRevision = -1;

  function extensionAlive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
  }

  function normalizeKanjiSelection(value) {
    if (
      value
      && typeof value === "object"
      && typeof value.title === "string"
      && value.title !== ""
      && KANJI_SELECTION_KINDS.has(value.kind)
    ) {
      return { title: value.title, kind: value.kind };
    }
    return typeof value === "string" ? value : "";
  }

  function normalizeOptions(stored) {
    const source = stored && typeof stored === "object" ? stored : {};
    return {
      scanLength: clampInteger(source.scanLength, 1, 64, DEFAULT_OPTIONS.scanLength),
      // 1..256 is the range settings.html offers, settings.js persists and
      // offscreen.js accepts; a narrower clamp here would silently shrink the
      // result set the user asked for.
      maxResults: clampInteger(source.maxResults, 1, 256, DEFAULT_OPTIONS.maxResults),
      modifier: MODIFIER_PROPERTIES.has(source.modifier) ? source.modifier : "none",
      hoverDelayMs: clampInteger(
        source.hoverDelayMs,
        0,
        2000,
        DEFAULT_OPTIONS.hoverDelayMs
      ),
      frequencyDictionary: typeof source.frequencyDictionary === "string"
        ? source.frequencyDictionary
        : "",
      kanjiClickDictionary: normalizeKanjiSelection(source.kanjiClickDictionary),
      frequencyOrder: FREQUENCY_ORDERS.has(source.frequencyOrder)
        ? source.frequencyOrder
        : "auto",
    };
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
        title,
        displayName: typeof entry.displayName === "string" && entry.displayName.trim() !== ""
          ? entry.displayName.trim()
          : null,
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

  function isScannableTextNode(node, styleCache) {
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement) {
      return false;
    }
    if (node.getRootNode() !== document || isOurNode(node)) {
      return false;
    }
    for (
      let element = node.parentElement;
      element;
      element = element.parentElement
    ) {
      if (OPAQUE_TAGS.has(element.localName) || isHiddenElement(element, styleCache)) {
        return false;
      }
    }
    return true;
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
            return NodeFilter.FILTER_ACCEPT;
          }
          if (
            OPAQUE_TAGS.has(node.localName) ||
            isOurNode(node) ||
            isHiddenElement(node, styleCache)
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          // Accepted elements are boundaries the loop below stops on; inline
          // ones are skipped so their text keeps flowing into the scan.
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
    if (!isJapaneseToken(query)) {
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

  function candidateSignature(candidate) {
    const first = candidate.scanEntries[0];
    return `${first.offset}\u001f${candidate.matchOffset}\u001f${candidate.query}`;
  }

  function sameAnchorNode(candidate, other) {
    return Boolean(other) &&
      other.anchor === candidate.anchor &&
      other.scanEntries[0].node === candidate.scanEntries[0].node;
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
    window.clearTimeout(scanTimer);
    window.clearTimeout(hideTimer);
    scanTimer = null;
    hideTimer = null;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
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
      view?.destroy();
    } catch {
      // Teardown is best effort.
    }
    host?.remove();
    host = null;
    shadow = null;
    popup = null;
    view = null;
    highlighter = null;
    activeCandidate = null;
    activeTermRender = null;
    if (reason) {
      console.debug(`hachidori: content script stopped (${reason})`);
    }
  }

  function discardUi() {
    try {
      highlighter?.clearAll();
      view?.destroy();
    } catch {
      // Best effort: the point is only to leave nothing half-built behind.
    }
    host?.remove();
    host = null;
    shadow = null;
    popup = null;
    view = null;
    highlighter = null;
    styleGeneration = -1;
    activeCandidate = null;
    activeSignature = null;
    activeTermRender = null;
  }

  function noteGeneration(generation) {
    if (!Number.isFinite(generation) || generation === currentGeneration) {
      return;
    }
    currentGeneration = generation;
    mediaCache.clear();
    styleGeneration = -1;
  }

  function sendRequest(type, payload) {
    return new Promise((resolve, reject) => {
      if (disposed || !extensionAlive()) {
        teardown("context-invalidated");
        reject(new Error("extension context invalidated"));
        return;
      }
      const requestId = `${type.replace(/^hd_/u, "")}-${nextRequestId += 1}`;
      const request = { ...payload, requestId, target: TARGET, type };
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
            // Only a successful reply's generation is the engine's; background.js
            // stamps 0 on a relay failure, and trusting that would drop the media
            // cache and re-fetch the styles for nothing.
            reject(new Error(reply.error || `${type} failed`));
            return;
          }
          noteGeneration(reply.generation);
          resolve(reply);
        });
      } catch (error) {
        teardown("context-invalidated");
        reject(error);
      }
    });
  }

  function resolveMedia({ dictionary, generation, path }) {
    const key = `${generation}\u0000${dictionary}\u0000${path}`;
    let pending = mediaCache.get(key);
    if (!pending) {
      pending = sendRequest("hd_media", { dictionary, path })
        .then((reply) => (
          reply.generation === generation && typeof reply.dataUrl === "string"
            ? reply.dataUrl
            : null
        ))
        .catch(() => null);
      mediaCache.set(key, pending);
    }
    return pending;
  }

  function ensureDictionaryStyles(generation) {
    if (!shadow || generation === styleGeneration) {
      return;
    }
    styleGeneration = generation;
    sendRequest("hd_styles", {}).then((reply) => {
      if (disposed || !shadow || styleGeneration !== generation) {
        return;
      }
      window.HDGlossary.applyDictionaryStyles(
        document,
        shadow,
        generation,
        Array.isArray(reply.styles) ? reply.styles : []
      );
    }).catch(() => {
      // Dictionary CSS is cosmetic; a failure must not block the lookup that
      // asked for it. Retry on the next generation change.
      if (styleGeneration === generation) {
        styleGeneration = -1;
      }
    });
  }

  function calculatePopupPosition(anchorRect, viewport, vertical) {
    const width = Math.min(
      POPUP_WIDTH_PX,
      Math.max(1, viewport.width - POPUP_PADDING_PX * 2)
    );
    const height = Math.min(
      POPUP_HEIGHT_PX,
      Math.max(1, viewport.height - POPUP_PADDING_PX * 2)
    );
    const clamp = (value, minimum, maximum) =>
      Math.max(minimum, Math.min(value, maximum));

    let left;
    let top;
    let placement;
    if (vertical) {
      const spaceRight = viewport.width - anchorRect.right - POPUP_GAP_PX;
      const spaceLeft = anchorRect.left - POPUP_GAP_PX;
      left = spaceRight >= width || spaceRight >= spaceLeft
        ? anchorRect.right + POPUP_GAP_PX
        : anchorRect.left - POPUP_GAP_PX - width;
      top = anchorRect.top;
      placement = "beside";
    } else {
      const spaceBelow = Math.max(
        0,
        viewport.height - POPUP_PADDING_PX - anchorRect.bottom - POPUP_GAP_PX
      );
      const spaceAbove = Math.max(
        0,
        anchorRect.top - POPUP_GAP_PX - POPUP_PADDING_PX
      );
      const placeAbove = spaceAbove >= height ||
        (spaceBelow < height && spaceAbove >= spaceBelow);
      top = placeAbove
        ? anchorRect.top - POPUP_GAP_PX - height
        : anchorRect.bottom + POPUP_GAP_PX;
      left = anchorRect.left;
      placement = placeAbove ? "above" : "below";
    }
    return {
      height,
      left: Math.round(
        clamp(left, POPUP_PADDING_PX, viewport.width - width - POPUP_PADDING_PX)
      ),
      placement,
      top: Math.round(
        clamp(top, POPUP_PADDING_PX, viewport.height - height - POPUP_PADDING_PX)
      ),
      width,
    };
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
      candidate.scanEntries[0].node.isConnected;
  }

  function positionPopup() {
    if (!popup || popup.hidden || !activeCandidate) {
      return;
    }
    if (!anchorConnected(activeCandidate)) {
      hide();
      return;
    }
    const position = calculatePopupPosition(
      anchorRectFor(activeCandidate),
      { height: window.innerHeight, width: window.innerWidth },
      activeCandidate.vertical
    );
    // bpwhelan asked for this in the PR #549 review: the toolbar sits on the
    // edge nearest the word, so it never covers the text being read.
    if (position.placement !== "beside") {
      const desired = position.placement === "above" ? "bottom" : "top";
      if (popup.dataset.toolbarPosition !== desired) {
        view.setToolbarPosition(desired);
      }
    }
    popup.style.left = `${position.left}px`;
    popup.style.top = `${position.top}px`;
    popup.style.width = `${position.width}px`;
    popup.style.height = `${position.height}px`;
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

    popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.dataset.hoshidictsDepth = "0";
    popup.hidden = true;
    shadow.appendChild(popup);
    document.body.appendChild(host);

    highlighter = window.HDPopup.createSourceHighlighter(
      window,
      document,
      HIGHLIGHT_NAME
    );
    view = window.HDPopup.createPopupView({
      appendExpressionRuby: window.HDGlossary.appendExpressionRuby,
      appendTextOnlyGlossary: window.HDGlossary.appendTextOnlyGlossary,
      document,
      getPopupColumns: () => 1,
      highlightName: HIGHLIGHT_NAME,
      idPrefix: "hoshidicts",
      onKanjiClick: showKanji,
      parseTagList: window.HDGlossary.parseTagList,
      popup,
      positionPopup,
      sourceHighlighter: highlighter,
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

  function show(candidate) {
    activeCandidate = candidate;
    activeSignature = candidateSignature(candidate);
    if (!host.isConnected && document.body) {
      // A single-page app that swapped out document.body took the host with it.
      document.body.appendChild(host);
    }
    popup.hidden = false;
    popup.scrollTop = 0;
  }

  function hide() {
    clearHideTimer();
    activeCandidate = null;
    activeSignature = null;
    activeHighlightText = "";
    activeTermRender = null;
    lookupToken += 1;
    if (!popup) {
      return;
    }
    popup.hidden = true;
    view.clear();
    highlighter.clearAll();
  }

  function clearHideTimer() {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide() {
    if (!popup || popup.hidden || hideTimer !== null) {
      return;
    }
    // The gap between the word and the popup is dead space; give the pointer
    // time to cross it so the popup stays reachable and selectable.
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      if (!pointerInPopup) {
        hide();
      }
    }, HIDE_DELAY_MS);
  }

  function renderContextFor() {
    return {
      averageFrequency: false,
      definitionBlurState: "revealed",
      dictionaryPresentation: dictionaryPresentation(),
      dictionaryTabGroups: [],
      generation: currentGeneration,
      hidePopupGrammarTags: false,
      onInternalLink,
      resolveMedia,
      showCompactDefinitionSummary: false,
      showFrequencyDictionaryNames: true,
      showPitchAccentBadge: true,
      showPitchAccentFurigana: true,
    };
  }

  function focusPopupControl(selector) {
    const control = shadow?.querySelector(selector);
    if (typeof control?.focus !== "function") {
      return;
    }
    try {
      control.focus({ preventScroll: true });
    } catch {
      control.focus();
    }
  }

  function kanjiLinkFocusTarget(sourceLink, character) {
    const links = shadow?.querySelectorAll(".gsm-hoshidicts-kanji-link");
    const index = links ? Array.prototype.indexOf.call(links, sourceLink) : -1;
    return { character, index };
  }

  function focusKanjiLink(focusTarget) {
    const links = shadow?.querySelectorAll(".gsm-hoshidicts-kanji-link");
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

  function restoreTermRender(previous, focusTarget) {
    lookupToken += 1;
    renderTerms(
      previous.results,
      previous.candidate,
      previous.matchedText,
      previous.renderOptions,
    );
    focusKanjiLink(focusTarget);
  }

  function renderTerms(results, candidate, matchedText, renderOptions = {}) {
    activeTermRender = { candidate, matchedText, renderOptions, results };
    try {
      view.renderResults(results, candidate, {
        ...renderContextFor(),
        ...renderOptions,
      });
    } catch (error) {
      // A malformed result must cost one hover, not the whole content script.
      console.warn("hachidori: could not render results", error);
      hide();
      return;
    }
    activeHighlightText = matchedText;
    if (matchedText) {
      // renderResults already applied the engine's `matched` string; re-apply
      // with the raw-sentence span so ruby and wrapped lines highlight exactly
      // the characters the reader sees.
      highlighter.apply(candidate, matchedText);
    }
    ensureDictionaryStyles(currentGeneration);
    positionPopup();
    if (typeof renderOptions.onBack === "function") {
      focusPopupControl(".gsm-hoshidicts-kanji-back");
    }
  }

  async function runLookup(candidate, overrides = {}) {
    const token = (lookupToken += 1);
    const text = typeof overrides.text === "string" ? overrides.text : candidate.query;
    let reply;
    try {
      // The first hover pays for the popup host and the stylesheet fetch; run
      // them alongside the lookup instead of ahead of it.
      [, reply] = await Promise.all([
        ensureUi(),
        sendRequest("hd_lookup", {
          maxResults: options.maxResults,
          options: {
            frequencyDictionary: options.frequencyDictionary,
            frequencyOrder: options.frequencyOrder,
            primaryReading: typeof overrides.primaryReading === "string"
              ? overrides.primaryReading
              : "",
          },
          scanLength: options.scanLength,
          text,
        }),
      ]);
    } catch (error) {
      if (!disposed && token === lookupToken) {
        console.debug("hachidori: lookup failed", error);
      }
      return;
    }
    // Hover fires far faster than lookups return; anything but the newest reply
    // would repaint a word the pointer already left.
    if (disposed || token !== lookupToken || !popup) {
      return;
    }
    const results = (Array.isArray(reply.results) ? reply.results : [])
      .filter((result) => result && result.term);
    if (results.length === 0) {
      if (reply.dictionaryCount === 0) {
        show(candidate);
        activeHighlightText = "";
        activeTermRender = null;
        view.renderNotice(
          "No dictionaries loaded. Import a Yomitan .zip from the Hachidori options page.",
          candidate
        );
        positionPopup();
        return;
      }
      hide();
      return;
    }
    show(candidate);
    const matched = results[0].matched || results[0].term.expression;
    renderTerms(
      results,
      candidate,
      overrides.keepHighlight === true
        ? activeHighlightText
        : rawMatchedText(candidate, matched)
    );
  }

  function onInternalLink({ primaryReading, query }) {
    if (!activeCandidate || typeof query !== "string" || !query) {
      return;
    }
    // The link's query is not page text, so the source highlight stays where
    // the reader's pointer put it.
    runLookup(activeCandidate, {
      keepHighlight: true,
      primaryReading: typeof primaryReading === "string" ? primaryReading : "",
      text: query,
    });
  }

  async function showKanji(character, _result, _candidate, sourceLink) {
    if (!activeCandidate || typeof character !== "string" || !character) {
      return;
    }
    const candidate = activeCandidate;
    const previous = activeTermRender;
    const highlightText = activeHighlightText;
    const returnFocus = kanjiLinkFocusTarget(sourceLink, character);
    const capability = selectedKanjiDictionaryCapability();
    const useTermDictionary = capability?.kind === "term";
    const token = (lookupToken += 1);
    let reply;
    try {
      reply = useTermDictionary
        ? await sendRequest("hd_lookup_dictionary", {
            dictionary: capability.title,
            maxResults: options.maxResults,
            options: {
              frequencyDictionary: options.frequencyDictionary,
              frequencyOrder: options.frequencyOrder,
              primaryReading: "",
            },
            scanLength: 1,
            text: character,
          })
        : await sendRequest("hd_kanji", { character });
    } catch (error) {
      console.debug("hachidori: kanji lookup failed", error);
      return;
    }
    if (disposed || token !== lookupToken || !popup || popup.hidden) {
      return;
    }
    if (useTermDictionary) {
      const results = projectResultsToDictionary(
        Array.isArray(reply.results) ? reply.results : [],
        capability.title
      );
      if (results.length > 0) {
        renderTerms(results, candidate, highlightText || character, {
          onBack: previous
            ? () => restoreTermRender(previous, returnFocus)
            : undefined,
        });
        return;
      }
      try {
        reply = await sendRequest("hd_kanji", { character });
      } catch (error) {
        console.debug("hachidori: fallback kanji lookup failed", error);
        return;
      }
      if (disposed || token !== lookupToken || !popup || popup.hidden) {
        return;
      }
    }
    const kanji = reply.kanji;
    if (!kanji || !Array.isArray(kanji.entries) || kanji.entries.length === 0) {
      return;
    }
    const entries = capability?.kind === "kanji"
      ? kanji.entries.filter((entry) => entry.dictionary === capability.title)
      : kanji.entries;
    if (entries.length === 0) {
      return;
    }
    try {
      view.renderKanji({ ...kanji, entries }, candidate, {
        dictionaryPresentation: dictionaryPresentation(),
        highlightText: highlightText || character,
        onBack: previous
          ? () => restoreTermRender(previous, returnFocus)
          : undefined,
      });
    } catch (error) {
      console.warn("hachidori: could not render kanji", error);
      hide();
      return;
    }
    ensureDictionaryStyles(currentGeneration);
    positionPopup();
    focusPopupControl(".gsm-hoshidicts-kanji-back");
  }

  function modifierHeld(event) {
    const property = MODIFIER_PROPERTIES.get(options.modifier);
    return !property || event[property] === true;
  }

  function pointInsidePopup(clientX, clientY) {
    if (!popup || popup.hidden) {
      return false;
    }
    const rect = popup.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;
  }

  function scanPointer(pointer) {
    if (disposed || !extensionAlive()) {
      teardown("context-invalidated");
      return;
    }
    pointerInPopup = isOurNode(pointer.target) ||
      pointInsidePopup(pointer.clientX, pointer.clientY);
    if (pointerInPopup) {
      clearHideTimer();
      return;
    }
    if (!pointer.modifierHeld) {
      scheduleHide();
      return;
    }
    const candidate = resolveCandidate(pointer.clientX, pointer.clientY);
    if (!candidate) {
      scheduleHide();
      return;
    }
    if (
      popup && !popup.hidden &&
      activeSignature === candidateSignature(candidate) &&
      sameAnchorNode(candidate, activeCandidate)
    ) {
      clearHideTimer();
      return;
    }
    clearHideTimer();
    runLookup(candidate);
  }

  function onMouseMove(event) {
    if (disposed) {
      return;
    }
    lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      modifierHeld: modifierHeld(event),
      target: event.target,
    };
    // Cancel a pending dismissal here rather than waiting for the throttled
    // scan, so the popup stays reachable even with hoverDelayMs turned up. The
    // retargeted event target is enough; the rect test costs a layout and can
    // wait for the scan.
    if (isOurNode(event.target)) {
      pointerInPopup = true;
      clearHideTimer();
    }
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
    if (disposed || popup === null || popup.hidden) {
      return;
    }
    if (!isOurNode(event.target) && !pointInsidePopup(event.clientX, event.clientY)) {
      hide();
    }
  }

  function onKeyDown(event) {
    if (disposed) {
      return;
    }
    if (event.key === "Escape") {
      if (popup && !popup.hidden) {
        event.stopPropagation();
        hide();
      }
      return;
    }
    // Pressing the gate key while the pointer is stationary should reveal the
    // word under it without asking the reader to jiggle the mouse.
    const property = MODIFIER_PROPERTIES.get(options.modifier);
    if (property && event[property] === true && lastPointer && !lastPointer.modifierHeld) {
      lastPointer = { ...lastPointer, modifierHeld: true };
      scanPointer(lastPointer);
    }
  }

  function onMouseOut(event) {
    // A null relatedTarget on a document-level mouseout means the pointer left
    // the window entirely, which mouseleave cannot report from here: it does not
    // bubble, and a capture listener would fire for every element left.
    if (!disposed && event.relatedTarget === null) {
      scheduleHide();
    }
  }

  function onWindowBlur() {
    if (!disposed) {
      hide();
    }
  }

  function onScroll() {
    if (disposed || !popup || popup.hidden || !activeCandidate) {
      return;
    }
    if (!anchorConnected(activeCandidate)) {
      hide();
      return;
    }
    const rect = anchorRectFor(activeCandidate);
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
    if (dictionaryChanged && popup && !popup.hidden) {
      hide();
    } else {
      lookupToken += 1;
    }
  }

  function onStorageChanged(changes, area) {
    if (disposed || area !== "local") {
      return;
    }
    let changed = false;
    let dictionaryChanged = false;
    if (changes.options) {
      optionsStorageRevision += 1;
      const next = normalizeOptions(changes.options.newValue);
      changed ||= JSON.stringify(next) !== JSON.stringify(options);
      options = next;
    }
    if (changes.dictionaryState) {
      const next = normalizeDictionaryState(changes.dictionaryState.newValue);
      if (next.revision > dictionaryStateRevision) {
        dictionaryStateRevision = next.revision;
        dictionaryChanged = true;
        changed = true;
        dictionaries = next.dictionaries;
      }
    }
    if (changed) {
      invalidateStoredState(dictionaryChanged);
    }
  }

  function start() {
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
      const requestedOptionsRevision = optionsStorageRevision;
      const requestedDictionaryStateRevision = dictionaryStateRevision;
      chrome.storage.local.get({ dictionaryState: null, options: DEFAULT_OPTIONS }, (stored) => {
        if (disposed || chrome.runtime.lastError) {
          return;
        }
        let changed = false;
        let dictionaryChanged = false;
        if (optionsStorageRevision === requestedOptionsRevision) {
          const next = normalizeOptions(stored && stored.options);
          changed ||= JSON.stringify(next) !== JSON.stringify(options);
          options = next;
        }
        if (dictionaryStateRevision === requestedDictionaryStateRevision) {
          const next = normalizeDictionaryState(stored && stored.dictionaryState);
          dictionaryStateRevision = next.revision;
          dictionaryChanged = JSON.stringify(next.dictionaries) !== JSON.stringify(dictionaries);
          changed ||= dictionaryChanged;
          dictionaries = next.dictionaries;
        }
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
    document.addEventListener("mouseout", onMouseOut, observe);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, observe);
    window.addEventListener("blur", onWindowBlur);
  }

  start();
}());
