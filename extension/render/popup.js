/*
 * Hoshidicts popup view.
 *
 * Keeps rendering and source highlighting out of the content script's pointer
 * and messaging state machine. Ported from GameSentenceMiner PR #549
 * (GSM_Overlay/features/hoshidicts/popup.js) with its Anki mining and audio
 * surfaces removed. Popup structure is adapted from Hoshi Reader:
 * https://github.com/Manhhao/Hoshi-Reader/tree/c31c9d0ce376ff83bf6a91d908bf9f8e0fb4947b/Features/Popup
 *
 * Copyright (C) 2026 Manhhao
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.HDPopup = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const DEFAULT_INITIAL_RESULT_COUNT = 1;
  const DEFAULT_MAX_METADATA_TAGS = 12;
  const DEFAULT_HIGHLIGHT_NAME = "gsm-hoshidicts-match";
  const MASONRY_GAP_PX = 8;
  const DEFINITION_BLUR_STATES = new Set(["pending", "blurred"]);
  const DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT = 3;
  const MIN_COMPACT_DEFINITION_SUMMARY_COUNT = 1;
  const MAX_COMPACT_DEFINITION_SUMMARY_COUNT = 6;
  const COMPACT_DEFINITION_MAX_CHARACTERS = 240;
  const COMPACT_DEFINITION_MAX_NODES = 512;
  const COMPACT_DEFINITION_MAX_DEPTH = 16;
  const COMPACT_DEFINITION_BLOCK_TAGS = new Set([
    "article",
    "blockquote",
    "br",
    "dd",
    "div",
    "dt",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "p",
    "section",
    "td",
    "th",
    "tr",
  ]);
  const COMPACT_DEFINITION_IGNORED_TAGS = new Set([
    "audio",
    "canvas",
    "iframe",
    "img",
    "rt",
    "script",
    "style",
    "svg",
    "video",
  ]);
  const DICTIONARY_DISPLAY_ALIASES = new Map([
    ["Jitendex.org", "Jitendex"],
  ]);
  const DICTIONARY_DECORATION_PATTERN =
    /\s+(?:\[([^\]]+)\]|\(([^()]*)\))\s*$/u;
  const DICTIONARY_DATE_DECORATION_PATTERN =
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/u;
  const DICTIONARY_VERSION_DECORATION_PATTERN =
    /^(?:(?:version|ver(?:sion)?|v|revision|rev|release)\s*[:#.-]?\s*)?v?\d+(?:\.\d+)+(?:[-+][0-9a-z.-]+)?$/iu;
  const DICTIONARY_LABELED_REVISION_PATTERN =
    /^(?:version|ver(?:sion)?|v|revision|rev|release)\s*[:#.-]?\s*v?\d+(?:\.\d+)*(?:[-+][0-9a-z.-]+)?$/iu;

  const DEINFLECTION_STRINGS = new Map([
    ["en", {
      steps: "Deinflection steps",
      summary: (matched, deinflected) => `Why this matched: ${matched} became ${deinflected}`,
    }],
    ["ja", {
      steps: "活用解除の手順",
      summary: (matched, deinflected) => `一致した理由: ${matched} から ${deinflected} に戻しました`,
    }],
    ["uk", {
      steps: "Кроки відновлення словникової форми",
      summary: (matched, deinflected) => `Чому це збіглося: ${matched} перетворено на ${deinflected}`,
    }],
  ]);

  function deinflectionSteps(result) {
    return Array.isArray(result.trace)
      ? result.trace.filter((step) => typeof step?.name === "string" && step.name.length > 0)
      : [];
  }

  function buildDeinflectionDisclosure(documentRef, result, locale) {
    const { matched, deinflected } = result;
    if (typeof matched !== "string" || !matched
        || typeof deinflected !== "string" || !deinflected || matched === deinflected) return null;
    const steps = deinflectionSteps(result);
    if (steps.length === 0) return null;

    const strings = DEINFLECTION_STRINGS.get(locale.toLowerCase().split("-")[0])
      ?? DEINFLECTION_STRINGS.get("en");
    const details = documentRef.createElement("details");
    details.className = "gsm-hoshidicts-deinflection";
    const summary = documentRef.createElement("summary");
    summary.setAttribute("aria-label", strings.summary(matched, deinflected));
    const path = documentRef.createElement("span");
    path.className = "gsm-hoshidicts-deinflection-path";
    for (const [index, endpoint] of [matched, deinflected].entries()) {
      if (index > 0) {
        const arrow = documentRef.createElement("span");
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = " → ";
        path.appendChild(arrow);
      }
      const value = documentRef.createElement("span");
      value.className = "gsm-hoshidicts-deinflection-endpoint";
      value.textContent = endpoint;
      path.appendChild(value);
    }
    summary.appendChild(path);
    const list = documentRef.createElement("ol");
    list.className = "gsm-hoshidicts-deinflection-steps";
    list.setAttribute("aria-label", strings.steps);
    for (const step of steps) {
      const item = documentRef.createElement("li");
      const name = documentRef.createElement("span");
      name.className = "gsm-hoshidicts-deinflection-step-name";
      name.textContent = step.name;
      item.appendChild(name);
      if (typeof step.description === "string" && step.description) {
        const description = documentRef.createElement("span");
        description.className = "gsm-hoshidicts-deinflection-step-description";
        description.textContent = step.description;
        item.appendChild(description);
      }
      list.appendChild(item);
    }
    details.append(summary, list);
    return details;
  }

  function isDictionaryDecoration(value) {
    const decoration = String(value || "").trim();
    return DICTIONARY_DATE_DECORATION_PATTERN.test(decoration) ||
      DICTIONARY_VERSION_DECORATION_PATTERN.test(decoration) ||
      DICTIONARY_LABELED_REVISION_PATTERN.test(decoration);
  }

  function cleanDictionaryDisplayName(value) {
    const canonicalName = String(value || "").trim();
    let displayName = canonicalName;
    while (displayName) {
      const suffix = DICTIONARY_DECORATION_PATTERN.exec(displayName);
      const decoration = suffix && (suffix[1] ?? suffix[2]);
      if (!suffix || !isDictionaryDecoration(decoration)) {
        break;
      }
      displayName = displayName.slice(0, suffix.index).trimEnd();
    }
    displayName = DICTIONARY_DISPLAY_ALIASES.get(displayName) || displayName;
    return displayName || canonicalName;
  }

  function createDictionaryDisplayNames(dictionaries, presentation = []) {
    const aliases = new Map();
    for (const entry of presentation) {
      const title = typeof entry?.title === "string" ? entry.title : "";
      const displayName = typeof entry?.displayName === "string"
        ? entry.displayName.trim()
        : "";
      if (title && displayName && !aliases.has(title)) {
        aliases.set(title, displayName);
      }
    }
    const uniqueDictionaries = [...new Set(dictionaries)];
    const cleanedNames = new Map();
    const counts = new Map();
    for (const dictionary of uniqueDictionaries) {
      const cleanedName = cleanDictionaryDisplayName(dictionary);
      cleanedNames.set(dictionary, cleanedName);
      const preferredName = aliases.get(dictionary) || cleanedName;
      counts.set(preferredName, (counts.get(preferredName) || 0) + 1);
    }
    const candidates = new Map();
    const candidateCounts = new Map();
    for (const dictionary of uniqueDictionaries) {
      const alias = aliases.get(dictionary);
      const cleanedName = cleanedNames.get(dictionary);
      const preferredName = alias || cleanedName;
      const candidate = counts.get(preferredName) === 1
        ? preferredName
        : alias
          ? `${alias} (${cleanedName})`
          : dictionary;
      candidates.set(dictionary, candidate);
      candidateCounts.set(candidate, (candidateCounts.get(candidate) || 0) + 1);
    }
    const displayNames = new Map();
    const usedNames = new Set();
    for (const dictionary of uniqueDictionaries) {
      const alias = aliases.get(dictionary);
      let displayName = candidates.get(dictionary);
      if (candidateCounts.get(displayName) > 1 && alias) {
        displayName = `${alias} (${dictionary})`;
      }
      if (usedNames.has(displayName)) {
        const baseName = `${displayName} — ${dictionary}`;
        displayName = baseName;
        let suffix = 2;
        while (usedNames.has(displayName)) {
          displayName = `${baseName} ${suffix}`;
          suffix += 1;
        }
      }
      usedNames.add(displayName);
      displayNames.set(dictionary, displayName);
    }
    return displayNames;
  }

  function createTag(documentRef, text, description, kind) {
    const tag = documentRef.createElement("span");
    tag.className = `gsm-hoshidicts-tag gsm-hoshidicts-tag-${kind}`;
    tag.textContent = text;
    if (description) {
      tag.title = description;
    }
    return tag;
  }

  function formatCompactFrequencyNumber(value) {
    const absoluteValue = Math.abs(value);
    const units = [
      { minimum: 1_000_000_000, suffix: "b" },
      { minimum: 1_000_000, suffix: "m" },
      { minimum: 1_000, suffix: "k" },
    ];
    const unit = units.find(({ minimum }) => absoluteValue >= minimum);
    if (!unit) {
      return String(value);
    }
    const roundedValue = Math.round((value / unit.minimum) * 10) / 10;
    return `${roundedValue}${unit.suffix}`;
  }

  const JITEN_KANA_FREQUENCY_MARKER = "㋕";

  function isKanaFrequency(frequency) {
    return typeof frequency.displayValue === "string"
      && frequency.displayValue.trim().endsWith(JITEN_KANA_FREQUENCY_MARKER);
  }

  function formatFrequencyValue(frequency) {
    if (typeof frequency.displayValue === "string") {
      const displayValue = frequency.displayValue.trim();
      if (!displayValue) {
        return null;
      }
      const numericText = isKanaFrequency(frequency)
        ? displayValue.slice(0, -JITEN_KANA_FREQUENCY_MARKER.length)
        : displayValue;
      const numericDisplayValue = Number(numericText.replaceAll(",", ""));
      if (!Number.isFinite(numericDisplayValue) || numericDisplayValue !== frequency.value) {
        return displayValue;
      }
      if (isKanaFrequency(frequency)) {
        return `${formatCompactFrequencyNumber(frequency.value)}${JITEN_KANA_FREQUENCY_MARKER}`;
      }
    }
    return formatCompactFrequencyNumber(frequency.value);
  }

  function frequencyNumberForAverage(frequency) {
    if (typeof frequency.displayValue === "string") {
      const match = /^\d+/u.exec(frequency.displayValue);
      if (match) {
        const value = Number.parseInt(match[0], 10);
        if (value > 0) return value;
      }
    }
    return Number.isFinite(frequency.value) && frequency.value > 0
      ? frequency.value
      : null;
  }

  function createFrequencyTag(
    documentRef,
    group,
    dictionaryDisplayName,
    frequencies,
    showDictionaryName = true
  ) {
    const tag = createTag(documentRef, "", group.dictionary, "frequency");
    tag.dataset.dictionary = group.dictionary;

    if (showDictionaryName) {
      const source = documentRef.createElement("span");
      source.className = "gsm-hoshidicts-frequency-source";
      source.textContent = dictionaryDisplayName;
      tag.appendChild(source);
    }

    const body = documentRef.createElement("span");
    body.className = "gsm-hoshidicts-frequency-body";
    tag.appendChild(body);

    const values = documentRef.createElement("span");
    values.className = "gsm-hoshidicts-frequency-values";
    body.appendChild(values);
    frequencies.forEach(({ display, frequency }, index) => {
      if (index > 0) {
        values.append(" · ");
      }
      const value = documentRef.createElement("span");
      value.className = "gsm-hoshidicts-frequency-value";
      value.dataset.frequency = String(frequency.value);
      value.textContent = display;
      if (display !== String(frequency.value)) {
        value.title = String(frequency.value);
      }
      values.appendChild(value);
    });

    const frequencyLabel = frequencies
      .map(({ display }) => display)
      .join(", ");
    tag.setAttribute(
      "aria-label",
      showDictionaryName ? `${group.dictionary}: ${frequencyLabel}` : frequencyLabel
    );
    return tag;
  }

  function createFrequencyTags(
    documentRef,
    result,
    dictionaryPresentation,
    maximumTags,
    averageFrequency = false,
    showFrequencyDictionaryNames = true
  ) {
    if (averageFrequency) {
      const frequencies = [];
      for (const group of result.term.frequencies) {
        for (const frequency of group.frequencies) {
          const value = frequencyNumberForAverage(frequency);
          if (value !== null) {
            frequencies.push(value);
            break;
          }
        }
      }
      if (frequencies.length === 0) return [];
      const value = Math.floor(
        frequencies.length /
          frequencies.reduce((total, frequency) => total + 1 / frequency, 0)
      );
      const frequency = { value, displayValue: null };
      return [
        createFrequencyTag(
          documentRef,
          { dictionary: "Frequency" },
          "Frequency:",
          [{ display: formatCompactFrequencyNumber(value), frequency }],
          showFrequencyDictionaryNames
        ),
      ];
    }
    const tags = [];
    const seen = new Set();
    const dictionaryDisplayNames = createDictionaryDisplayNames(
      result.term.frequencies.map(({ dictionary }) => dictionary),
      dictionaryPresentation
    );
    for (const group of result.term.frequencies) {
      const frequencies = [];
      const seenFrequencies = new Set();
      for (const frequency of group.frequencies) {
        const display = formatFrequencyValue(frequency);
        if (display === null) {
          continue;
        }
        const key = JSON.stringify([frequency.value, display]);
        if (!seenFrequencies.has(key)) {
          seenFrequencies.add(key);
          frequencies.push({ display, frequency });
        }
      }
      frequencies.sort((left, right) =>
        Number(isKanaFrequency(right.frequency))
        - Number(isKanaFrequency(left.frequency))
      );
      const key = JSON.stringify([
        group.dictionary,
        frequencies.map(({ display, frequency }) => [frequency.value, display]),
      ]);
      if (
        frequencies.length > 0 &&
        !seen.has(key) &&
        tags.length < maximumTags
      ) {
        seen.add(key);
        tags.push(createFrequencyTag(
          documentRef,
          group,
          dictionaryDisplayNames.get(group.dictionary) || group.dictionary,
          frequencies,
          showFrequencyDictionaryNames
        ));
      }
    }
    return tags;
  }

  function createPitchTag(
    documentRef,
    group,
    dictionaryDisplayName,
    pitch,
    reading
  ) {
    const bodyText = [
      `${reading ? `${reading} ` : ""}[${pitch.position}]`,
      pitch.pattern,
    ].filter(Boolean).join(" ");
    const description = [
      group.dictionary,
      pitch.pattern ? `Pattern ${pitch.pattern}` : "",
      ...group.transcriptions,
    ].filter(Boolean).join(" · ");
    const tag = createTag(documentRef, "", description, "pitch");
    tag.dataset.dictionary = group.dictionary;

    const source = documentRef.createElement("span");
    source.className = "gsm-hoshidicts-pitch-source";
    source.textContent = dictionaryDisplayName;
    tag.appendChild(source);

    const body = documentRef.createElement("span");
    body.className = "gsm-hoshidicts-pitch-body";
    body.textContent = bodyText;
    tag.appendChild(body);
    tag.setAttribute(
      "aria-label",
      `${group.dictionary}: ${bodyText}`
    );
    return tag;
  }

  function formatLookupCount(label, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    return `${label} ${value} ${value === 1 ? "time" : "times"}`;
  }

  function createSourceHighlighter(windowRef, documentRef, highlightName) {
    const matches = new Map();
    let highlightedSourceElements = new Set();

    function clearRenderedHighlight() {
      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      if (highlights && typeof highlights.delete === "function") {
        highlights.delete(highlightName);
      }
      for (const element of highlightedSourceElements) {
        element.classList.remove("gsm-hoshidicts-source-match");
      }
      highlightedSourceElements = new Set();
    }

    function createMatchRanges(candidate, matchedText) {
      const matchLength = typeof matchedText === "string" ? matchedText.length : 0;
      if (matchLength <= 0 || !Array.isArray(candidate.sourceElements)) {
        return null;
      }
      const startOffset = Math.max(0, candidate.matchOffset);
      const endOffset = Math.min(candidate.sentence.length, startOffset + matchLength);
      if (endOffset <= startOffset) {
        return null;
      }

      const sourceElements = candidate.sourceElements;
      if (
        sourceElements.some(
          (element) => !(element instanceof windowRef.Element) || !element.isConnected
        ) ||
        sourceElements.map((element) => element.textContent || "").join("") !==
          candidate.sentence
      ) {
        return null;
      }
      const showText = windowRef.NodeFilter ? windowRef.NodeFilter.SHOW_TEXT : 4;
      const ranges = [];
      const rangedSourceElements = new Set();
      let elementStart = 0;
      for (const element of sourceElements) {
        const elementEnd = elementStart + (element.textContent || "").length;
        if (elementEnd <= startOffset || elementStart >= endOffset) {
          elementStart = elementEnd;
          continue;
        }
        const textNodes = [];
        const walker = documentRef.createTreeWalker(element, showText);
        let node = walker.nextNode();
        while (node) {
          textNodes.push(node);
          node = walker.nextNode();
        }

        function findBoundary(offset, preferFollowingNode) {
          let consumed = 0;
          for (let index = 0; index < textNodes.length; index += 1) {
            const textNode = textNodes[index];
            const length = (textNode.nodeValue || "").length;
            const nodeEnd = consumed + length;
            if (
              offset < nodeEnd ||
              (
                offset === nodeEnd &&
                (!preferFollowingNode || index === textNodes.length - 1)
              )
            ) {
              return {
                node: textNode,
                offset: Math.max(0, Math.min(length, offset - consumed)),
              };
            }
            consumed = nodeEnd;
          }
          return null;
        }

        const localStart = Math.max(0, startOffset - elementStart);
        const localEnd = Math.min(elementEnd, endOffset) - elementStart;
        const start = findBoundary(localStart, true);
        const end = findBoundary(localEnd, false);
        if (start && end) {
          try {
            const range = documentRef.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            ranges.push(range);
            rangedSourceElements.add(element);
          } catch {
            // The class fallback below handles invalid ranges.
          }
        }
        elementStart = elementEnd;
      }
      return {
        ranges,
        rangedSourceElements,
        sourceElements,
        startOffset,
        endOffset,
      };
    }

    function applyElementFallback(match, skippedElements = new Set()) {
      let elementStart = 0;
      for (const element of match.sourceElements) {
        const elementEnd = elementStart + (element.textContent || "").length;
        if (
          !skippedElements.has(element) &&
          elementEnd > match.startOffset &&
          elementStart < match.endOffset
        ) {
          element.classList.add("gsm-hoshidicts-source-match");
          highlightedSourceElements.add(element);
        }
        elementStart = elementEnd;
      }
    }

    function render() {
      clearRenderedHighlight();
      const highlights = windowRef.CSS && windowRef.CSS.highlights;
      const HighlightImpl = windowRef.Highlight;
      const canUseRanges = Boolean(
        highlights && typeof highlights.set === "function" && HighlightImpl
      );
      const ranges = [];
      for (const { candidate, matchedText } of matches.values()) {
        const match = createMatchRanges(candidate, matchedText);
        if (!match) {
          continue;
        }
        if (canUseRanges && match.ranges.length > 0) {
          ranges.push(...match.ranges);
          applyElementFallback(match, match.rangedSourceElements);
        } else {
          applyElementFallback(match);
        }
      }
      if (canUseRanges && ranges.length > 0) {
        try {
          highlights.set(highlightName, new HighlightImpl(...ranges));
        } catch {
          for (const { candidate, matchedText } of matches.values()) {
            const match = createMatchRanges(candidate, matchedText);
            if (match) {
              applyElementFallback(match);
            }
          }
        }
      }
    }

    function applyFor(key, candidate, matchedText) {
      matches.set(key, { candidate, matchedText });
      render();
    }

    function clearFor(key) {
      if (matches.delete(key)) {
        render();
      }
    }

    return {
      apply(candidate, matchedText) {
        applyFor("default", candidate, matchedText);
      },
      clear() {
        clearFor("default");
      },
      scope(key) {
        return {
          apply(candidate, matchedText) {
            applyFor(key, candidate, matchedText);
          },
          clear() {
            clearFor(key);
          },
        };
      },
      clearAll() {
        matches.clear();
        clearRenderedHighlight();
      },
    };
  }

  function collectGlossaryDictionaries(results) {
    const dictionaries = [];
    const seen = new Set();
    for (const result of results) {
      for (const glossary of result.term.glossaries) {
        if (!seen.has(glossary.dictionary)) {
          seen.add(glossary.dictionary);
          dictionaries.push(glossary.dictionary);
        }
      }
    }
    return dictionaries;
  }

  function normaliseDictionaryTab(value) {
    if (typeof value?.dictionary === "string") return { dictionary: value.dictionary };
    if (typeof value?.groupId === "string") return { groupId: value.groupId };
    return value?.favourites === true ? { favourites: true } : null;
  }

  function dictionaryTabKey(selection) {
    if (typeof selection?.dictionary === "string") return `dictionary:${selection.dictionary}`;
    if (typeof selection?.groupId === "string") return `group:${selection.groupId}`;
    return selection?.favourites === true ? "favourites" : "all";
  }

  function sameTabMembers(left, right, dictionaries) {
    return dictionaries.every(dictionary => (left.size === 0 || left.has(dictionary))
      === (right.size === 0 || right.has(dictionary)));
  }

  function updateLabel(element, label) {
    if (element.textContent === label) return false;
    element.textContent = label;
    return true;
  }

  function createDictionaryTabs(dictionaries, renderContext) {
    const presentation = Array.isArray(renderContext.dictionaryPresentation)
      ? renderContext.dictionaryPresentation : [];
    const groups = Array.isArray(renderContext.dictionaryTabGroups)
      ? renderContext.dictionaryTabGroups : [];
    const dictionaryDisplayNames = createDictionaryDisplayNames(dictionaries, presentation);
    const available = new Set(dictionaries);
    const favourites = presentation
      .filter(({ favorite, title }) => favorite === true && available.has(title))
      .map(({ title }) => title);
    const usedLabels = new Set();
    function tab(label, title, selection, members, qualifier) {
      let uniqueLabel = label;
      let suffix = 1;
      while (usedLabels.has(uniqueLabel)) {
        uniqueLabel = `${label} (${qualifier}${suffix === 1 ? "" : ` ${suffix}`})`;
        suffix += 1;
      }
      usedLabels.add(uniqueLabel);
      return {
        key: dictionaryTabKey(selection), label: uniqueLabel, title,
        ...selection, dictionaries: new Set(members),
      };
    }
    const tabs = [
      tab("All", "All dictionaries", null, [], "tab"),
      ...dictionaries.map((dictionary) => tab(
        dictionaryDisplayNames.get(dictionary) || dictionary,
        dictionary, { dictionary }, [dictionary], "dictionary",
      )),
    ];
    if (favourites.length > 0) {
      tabs.push(tab("Favourites", "Favourite dictionaries", { favourites: true }, favourites, "tab"));
    }
    for (const group of groups) {
      const members = Array.isArray(group.dictionaries)
        ? group.dictionaries.filter((title) => available.has(title)) : [];
      if (members.length > 0) {
        tabs.push(tab(group.name, `Tab group: ${group.name}`, { groupId: group.id }, members, "group"));
      }
    }
    return { tabs, dictionaryDisplayNames };
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function parseCompactDefinitionValue(rawGlossary) {
    if (typeof rawGlossary !== "string" || !rawGlossary) {
      return null;
    }
    try {
      return JSON.parse(rawGlossary);
    } catch {
      return rawGlossary;
    }
  }

  function getCompactDefinitionMarker(value) {
    return isRecord(value?.data) && typeof value.data.content === "string"
      ? value.data.content.trim().toLowerCase()
      : "";
  }

  function isIgnoredCompactDefinitionSection(value) {
    const marker = getCompactDefinitionMarker(value);
    return marker && marker !== "glossary" && (
      marker.startsWith("part-of-speech") ||
      marker === "source" || marker.startsWith("source-") ||
      marker === "attribution" || marker.startsWith("attribution-") ||
      marker === "example" || marker === "examples" ||
      marker.startsWith("example-") ||
      marker === "form" || marker === "forms" ||
      marker.startsWith("forms-")
    );
  }

  function normalizeCompactDefinitionText(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
  }

  function isCompactDefinitionBlock(value) {
    return isRecord(value) && COMPACT_DEFINITION_BLOCK_TAGS.has(
      String(value.tag || "").toLowerCase()
    );
  }

  function collectCompactDefinitionText(value, state, depth = 0) {
    if (
      state.nodes >= COMPACT_DEFINITION_MAX_NODES ||
      depth > COMPACT_DEFINITION_MAX_DEPTH
    ) {
      return "";
    }
    state.nodes += 1;
    if (typeof value === "string" || typeof value === "number" ||
        typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      let text = "";
      let previousWasBlock = false;
      for (const child of value) {
        if (state.nodes >= COMPACT_DEFINITION_MAX_NODES) break;
        const childText = collectCompactDefinitionText(child, state, depth + 1);
        if (!childText) continue;
        const childIsBlock = isCompactDefinitionBlock(child);
        if (text && (previousWasBlock || childIsBlock)) {
          text += " ";
        }
        text += childText;
        previousWasBlock = childIsBlock;
      }
      return text;
    }
    if (!isRecord(value) || isIgnoredCompactDefinitionSection(value)) {
      return "";
    }
    const tag = typeof value.tag === "string" ? value.tag.toLowerCase() : "";
    if (COMPACT_DEFINITION_IGNORED_TAGS.has(tag) || value.type === "image") {
      return "";
    }
    if (value.type === "text" && Object.prototype.hasOwnProperty.call(value, "text")) {
      return collectCompactDefinitionText(value.text, state, depth + 1);
    }
    return Object.prototype.hasOwnProperty.call(value, "content")
      ? collectCompactDefinitionText(value.content, state, depth + 1)
      : "";
  }

  function findCompactDefinitionNodes(value, predicate, state, depth = 0) {
    if (
      state.nodes >= COMPACT_DEFINITION_MAX_NODES ||
      depth > COMPACT_DEFINITION_MAX_DEPTH
    ) {
      return [];
    }
    state.nodes += 1;
    if (Array.isArray(value)) {
      const matches = [];
      for (const child of value) {
        matches.push(...findCompactDefinitionNodes(
          child,
          predicate,
          state,
          depth + 1
        ));
        if (state.nodes >= COMPACT_DEFINITION_MAX_NODES) break;
      }
      return matches;
    }
    if (!isRecord(value) || isIgnoredCompactDefinitionSection(value)) {
      return [];
    }
    if (predicate(value)) {
      return [value];
    }
    return Object.prototype.hasOwnProperty.call(value, "content")
      ? findCompactDefinitionNodes(value.content, predicate, state, depth + 1)
      : [];
  }

  function isCompactDefinitionList(value) {
    const tag = String(value.tag || "").toLowerCase();
    return tag === "ul" || tag === "ol";
  }

  /** Block nodes with no block descendants: the smallest sense-sized chunks. */
  function findCompactDefinitionLeafBlocks(root) {
    return findCompactDefinitionNodes(
      root,
      (value) => COMPACT_DEFINITION_BLOCK_TAGS.has(
        String(value.tag || "").toLowerCase()
      ) && findCompactDefinitionNodes(
        value.content,
        (child) => COMPACT_DEFINITION_BLOCK_TAGS.has(
          String(child.tag || "").toLowerCase()
        ),
        { nodes: 0 }
      ).length === 0,
      { nodes: 0 }
    );
  }

  function compactDefinitionItemsFromNodes(nodes) {
    const items = [];
    let inspected = 0;
    for (const node of nodes) {
      if (inspected >= COMPACT_DEFINITION_MAX_NODES) break;
      inspected += 1;
      const text = normalizeCompactDefinitionText(
        collectCompactDefinitionText(node, { nodes: 0 })
      );
      for (const item of text.split(/\s*\u2022\s*/u)) {
        if (item) items.push(item);
      }
    }
    return items;
  }

  function compactDefinitionItemsFromList(list) {
    const rawChildren = Array.isArray(list.content)
      ? list.content
      : [list.content];
    const children = rawChildren.slice(0, COMPACT_DEFINITION_MAX_NODES);
    const listItems = [];
    for (const child of children) {
      if (isRecord(child) && String(child.tag || "").toLowerCase() === "li") {
        listItems.push(child);
      }
    }
    return compactDefinitionItemsFromNodes(
      listItems.length > 0 ? listItems : children
    );
  }

  function compactDefinitionItemsFromMarkedNode(node) {
    const tag = String(node.tag || "").toLowerCase();
    if (tag === "ul" || tag === "ol") {
      return compactDefinitionItemsFromList(node);
    }
    const nestedLists = findCompactDefinitionNodes(
      node.content,
      isCompactDefinitionList,
      { nodes: 0 }
    );
    if (nestedLists.length > 0) {
      return nestedLists.flatMap(compactDefinitionItemsFromList);
    }
    const leafBlocks = findCompactDefinitionLeafBlocks(node.content);
    return leafBlocks.length > 0
      ? compactDefinitionItemsFromNodes(leafBlocks)
      : compactDefinitionItemsFromNodes([node]);
  }

  function extractCompactDefinitionItems(parsed) {
    if (parsed === null) return [];

    const glossaryNodes = findCompactDefinitionNodes(
      parsed,
      (value) => getCompactDefinitionMarker(value) === "glossary",
      { nodes: 0 }
    );
    if (glossaryNodes.length > 0) {
      return glossaryNodes.flatMap(compactDefinitionItemsFromMarkedNode);
    }

    const semanticLists = findCompactDefinitionNodes(
      parsed,
      isCompactDefinitionList,
      { nodes: 0 }
    );
    for (const list of semanticLists) {
      const items = compactDefinitionItemsFromList(list);
      if (items.length > 0) return items;
    }

    const leafBlocks = findCompactDefinitionLeafBlocks(parsed);
    if (leafBlocks.length > 0) {
      return compactDefinitionItemsFromNodes(leafBlocks);
    }

    if (Array.isArray(parsed)) {
      const items = compactDefinitionItemsFromNodes(parsed);
      if (items.length > 0) return items;
    }
    return compactDefinitionItemsFromNodes([parsed]);
  }

  // null means no visible content; false means text or another non-image lead.
  // Stop at that first meaningful token, not at an image later in a definition.
  function leadingCompactDefinitionImage(value, state, depth = 0) {
    if (state.nodes >= COMPACT_DEFINITION_MAX_NODES || depth > COMPACT_DEFINITION_MAX_DEPTH) return false;
    state.nodes += 1;
    if (Array.isArray(value)) {
      for (const child of value) {
        const leading = leadingCompactDefinitionImage(child, state, depth + 1);
        if (leading !== null) return leading;
      }
      return null;
    }
    if (!isRecord(value)) return value != null && String(value).trim() ? false : null;
    if (isIgnoredCompactDefinitionSection(value)) return null;
    if (value.type === "structured-content" || value.type === "text") {
      const content = value.type === "text" && Object.hasOwn(value, "text") ? value.text : value.content;
      return leadingCompactDefinitionImage(content, state, depth + 1);
    }
    const tag = String(value.tag || "").toLowerCase();
    if (value.type === "image" || tag === "img") return value;
    if (COMPACT_DEFINITION_IGNORED_TAGS.has(tag)) return null;
    return leadingCompactDefinitionImage(value.content, state, depth + 1);
  }

  function extractCompactDefinitionSummary(
    glossaries,
    preferredDictionary = null,
    maximumItems = DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT
  ) {
    const itemLimit = Number.isInteger(maximumItems) &&
      maximumItems >= MIN_COMPACT_DEFINITION_SUMMARY_COUNT &&
      maximumItems <= MAX_COMPACT_DEFINITION_SUMMARY_COUNT
      ? maximumItems
      : DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT;
    const byDictionary = new Map();
    for (const glossary of Array.isArray(glossaries) ? glossaries : []) {
      if (!byDictionary.has(glossary.dictionary)) {
        byDictionary.set(glossary.dictionary, []);
      }
      byDictionary.get(glossary.dictionary).push(glossary.glossary);
    }
    const dictionaries = [...byDictionary.keys()];
    if (preferredDictionary !== null && byDictionary.has(preferredDictionary)) {
      dictionaries.splice(dictionaries.indexOf(preferredDictionary), 1);
      dictionaries.unshift(preferredDictionary);
    }
    for (const dictionary of dictionaries) {
      const rawGlossaries = byDictionary.get(dictionary);
      const items = [];
      const seen = new Set();
      let characterCount = 0;
      let leading = null;
      for (const rawGlossary of rawGlossaries) {
        const parsed = parseCompactDefinitionValue(rawGlossary);
        if (leading === null) leading = leadingCompactDefinitionImage(parsed, { nodes: 0 });
        for (const rawItem of extractCompactDefinitionItems(parsed)) {
          if (items.length >= itemLimit) break;
          const item = normalizeCompactDefinitionText(rawItem);
          if (!item || seen.has(item)) continue;
          const codePoints = Array.from(item);
          const remaining = COMPACT_DEFINITION_MAX_CHARACTERS - characterCount;
          if (remaining <= 0) break;
          const bounded = codePoints.length <= remaining
            ? item
            : remaining === 1
              ? "\u2026"
              : `${codePoints.slice(0, remaining - 1).join("")}\u2026`;
          items.push(bounded);
          seen.add(item);
          characterCount += Array.from(bounded).length;
          if (bounded !== item) break;
        }
        if (
          items.length >= itemLimit ||
          characterCount >= COMPACT_DEFINITION_MAX_CHARACTERS
        ) {
          break;
        }
      }
      if (items.length > 0) return { dictionary, items, image: leading || null };
    }
    return null;
  }

  function calculatePopupPosition(anchorRect, popupSize, viewport, { gap = 4, padding = 6, vertical = false } = {}) {
    const width = Math.min(popupSize.width, Math.max(1, viewport.width - padding * 2));
    const height = Math.min(popupSize.height, Math.max(1, viewport.height - padding * 2));
    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(value, maximum));
    let left;
    let top;
    let placement;
    if (vertical) {
      const spaceRight = viewport.width - anchorRect.right - gap;
      const spaceLeft = anchorRect.left - gap;
      left = spaceRight >= width || spaceRight >= spaceLeft
        ? anchorRect.right + gap
        : anchorRect.left - gap - width;
      top = anchorRect.top;
      placement = "beside";
    } else {
      const spaceBelow = Math.max(0, viewport.height - padding - anchorRect.bottom - gap);
      const spaceAbove = Math.max(0, anchorRect.top - gap - padding);
      const placeAbove = spaceAbove >= height || (spaceBelow < height && spaceAbove >= spaceBelow);
      top = placeAbove ? anchorRect.top - gap - height : anchorRect.bottom + gap;
      left = anchorRect.left;
      placement = placeAbove ? "above" : "below";
    }
    return {
      height,
      left: clamp(Math.round(left), padding, viewport.width - width - padding),
      placement,
      top: clamp(Math.round(top), padding, viewport.height - height - padding),
      width,
    };
  }

  function createPopupView(options) {
    const documentRef = options.document;
    const windowRef = options.window;
    const popup = options.popup;
    const appendExpressionRuby = options.appendExpressionRuby;
    const appendTextOnlyGlossary = options.appendTextOnlyGlossary;
    const appendStructuredImage = options.appendStructuredImage;
    const parseTagList = options.parseTagList;
    const positionPopup = options.positionPopup;
    // LookupKanji carries onyomi/kunyomi/tags as space-separated strings, but a
    // caller that already normalized them hands over arrays. Accept both.
    const tokenList = (value) =>
      Array.isArray(value) ? value : parseTagList(value);
    const getPopupColumns = typeof options.getPopupColumns === "function"
      ? options.getPopupColumns
      : () => 1;
    const onKanjiClick = typeof options.onKanjiClick === "function"
      ? options.onKanjiClick
      : () => {};
    const onAddCustomEntry = typeof options.onAddCustomEntry === "function"
      ? options.onAddCustomEntry
      : async () => {};
    const onNoteEditingChange = typeof options.onNoteEditingChange === "function"
      ? options.onNoteEditingChange
      : () => {};
    const onBeforeResultsRendered =
      typeof options.onBeforeResultsRendered === "function"
        ? options.onBeforeResultsRendered
        : () => {};
    const onResultsRendered = typeof options.onResultsRendered === "function"
      ? options.onResultsRendered
      : () => {};
    const onResultsExpanded = typeof options.onResultsExpanded === "function"
      ? options.onResultsExpanded
      : () => {};
    const idPrefix = typeof options.idPrefix === "string" && options.idPrefix
      ? options.idPrefix
      : "gsm-hoshidicts";
    const initialResultCount = Number.isInteger(options.initialResultCount)
      ? Math.max(1, options.initialResultCount)
      : DEFAULT_INITIAL_RESULT_COUNT;
    const maxMetadataTags = Number.isInteger(options.maxMetadataTags)
      ? Math.max(1, options.maxMetadataTags)
      : DEFAULT_MAX_METADATA_TAGS;
    const sourceHighlighter = options.sourceHighlighter || createSourceHighlighter(
      windowRef,
      documentRef,
      options.highlightName || DEFAULT_HIGHLIGHT_NAME
    );
    let definitionBlurState = "revealed";
    let sourceHighlightEnabled = options.sourceHighlightEnabled === true;
    let currentSourceHighlight = null;
    let toolbarPosition = options.toolbarPosition === "bottom" ? "bottom" : "top";
    let currentToolbar = null;
    let currentNoteControls = null;
    let renderRevision = 0;
    let currentResultPanel = null;
    let currentPresentationUpdate = null;
    let pendingPresentation = null;
    let imagePreview = null;
    let masonryFrame = null;
    const masonryObserver = typeof windowRef.ResizeObserver === "function"
      ? new windowRef.ResizeObserver(() => scheduleMasonry())
      : null;
    popup.dataset.toolbarPosition = toolbarPosition;

    function hideImagePreview(owner = null) {
      if (!imagePreview || (owner && imagePreview.owner !== owner)) return;
      imagePreview.element?.remove();
      imagePreview = null;
    }

    function positionImagePreview(anchorRect = imagePreview.image.getBoundingClientRect()) {
      const preview = imagePreview.element;
      const position = calculatePopupPosition(anchorRect, preview.getBoundingClientRect(), {
        width: windowRef.innerWidth, height: windowRef.innerHeight,
      }, { gap: 8, padding: 8, vertical: true });
      preview.style.left = `${position.left}px`;
      preview.style.top = `${position.top}px`;
    }

    function refreshImagePreview(link, image) {
      // Image completion resumes only the most recent interaction. It must
      // not steal another image's focus or revive a dismissed pending preview.
      if (imagePreview?.owner !== link) return;
      const source = image.currentSrc || image.src;
      if (image.hidden || !source) return;
      if (imagePreview.source === source) return;
      imagePreview.element?.remove();
      const preview = documentRef.createElement("div");
      preview.className = "gsm-hoshidicts-image-hover-preview";
      preview.setAttribute("aria-hidden", "true");
      preview.dataset.appearance = link.dataset.appearance;
      preview.dataset.imageRendering = link.dataset.imageRendering;
      const expanded = documentRef.createElement("img");
      expanded.src = source;
      expanded.alt = image.alt;
      expanded.decoding = "async";
      expanded.draggable = false;
      preview.appendChild(expanded);
      // A sibling in the same shadow root retains the palette while escaping
      // the glossary card's paint containment and the popup's scroll clipping.
      popup.parentNode.appendChild(preview);
      imagePreview.source = source;
      imagePreview.element = preview;
      positionImagePreview();
    }

    function requestImagePreview(link, image) {
      if (imagePreview?.owner !== link) {
        hideImagePreview();
        imagePreview = { owner: link, image, source: null, element: null };
      }
      refreshImagePreview(link, image);
    }

    const onPopupScroll = () => {
      if (!imagePreview) return;
      const { owner, image, element } = imagePreview;
      if (owner.getRootNode().activeElement !== owner || !element) {
        hideImagePreview();
        return;
      }
      const anchorRect = image.getBoundingClientRect();
      const bounds = popup.getBoundingClientRect();
      if (anchorRect.bottom <= bounds.top || anchorRect.top >= bounds.bottom
          || anchorRect.right <= bounds.left || anchorRect.left >= bounds.right) {
        hideImagePreview();
        return;
      }
      // Native keyboard focus may scroll its image into view after focus.
      // Retain that focused preview while closing ordinary hover previews.
      positionImagePreview(anchorRect);
    };
    popup.addEventListener("scroll", onPopupScroll, true);

    function resetMasonry(grid) {
      grid.classList.remove("gsm-hoshidicts-glossary-grid-masonry");
      grid.style.height = "";
      for (const card of grid.children) {
        card.style.width = "";
        card.style.transform = "";
        card.style.visibility = "";
      }
    }

    function layoutMasonry() {
      const requestedColumns = Math.max(1, Math.trunc(getPopupColumns()));
      for (const grid of popup.querySelectorAll(".gsm-hoshidicts-glossary-grid")) {
        const cards = Array.from(grid.children);
        const columns = Math.min(requestedColumns, cards.length);
        if (columns <= 1 || grid.clientWidth <= 0) {
          resetMasonry(grid);
          continue;
        }
        grid.classList.add("gsm-hoshidicts-glossary-grid-masonry");
        const columnWidth =
          (grid.clientWidth - MASONRY_GAP_PX * (columns - 1)) / columns;
        for (const card of cards) card.style.width = `${columnWidth}px`;
        // Measure after every width is set, before placement writes begin.
        const cardHeights = cards.map(card => card.offsetHeight);
        const columnHeights = Array.from({ length: columns }, () => 0);
        cards.forEach((card, index) => {
          const column = columnHeights.indexOf(Math.min(...columnHeights));
          const x = column * (columnWidth + MASONRY_GAP_PX);
          const y = columnHeights[column];
          card.style.transform = `translate(${x}px, ${y}px)`;
          card.style.visibility = "visible";
          columnHeights[column] += cardHeights[index] + MASONRY_GAP_PX;
        });
        grid.style.height = `${Math.max(...columnHeights) - MASONRY_GAP_PX}px`;
      }
    }

    function scheduleMasonry() {
      if (options.queueMasonry) {
        options.queueMasonry(layoutMasonry);
        return;
      }
      if (masonryFrame !== null) {
        return;
      }
      masonryFrame = windowRef.requestAnimationFrame(() => {
        masonryFrame = null;
        layoutMasonry();
        positionPopup();
      });
    }

    const onWindowResize = () => {
      hideImagePreview();
      scheduleMasonry();
    };
    windowRef.addEventListener("resize", onWindowResize);

    function applyToolbarLayout() {
      if (!currentToolbar) {
        return;
      }
      const noteForm = currentNoteControls?.form ?? null;
      // Only touch the DOM when the toolbar is not already in the desired
      // place. A no-op reposition must never detach a focused control, which
      // throws in jsdom and reorders under focus.
      if (toolbarPosition === "bottom") {
        if (
          popup.lastElementChild !== currentToolbar
          || (noteForm && currentToolbar.previousElementSibling !== noteForm)
        ) {
          if (noteForm) popup.append(noteForm, currentToolbar);
          else popup.append(currentToolbar);
        }
      } else if (
        popup.firstElementChild !== currentToolbar
        || (noteForm && currentToolbar.nextElementSibling !== noteForm)
      ) {
        if (noteForm) popup.prepend(currentToolbar, noteForm);
        else popup.prepend(currentToolbar);
      }
    }

    function setRenderedToolbar(toolbar) {
      currentToolbar = toolbar;
      applyToolbarLayout();
    }

    function setToolbarPosition(value) {
      toolbarPosition = value === "bottom" ? "bottom" : "top";
      popup.dataset.toolbarPosition = toolbarPosition;
      applyToolbarLayout();
      return toolbarPosition;
    }

    function applyDefinitionBlurState(element) {
      if (DEFINITION_BLUR_STATES.has(definitionBlurState)) {
        element.dataset.definitionBlurState = definitionBlurState;
      } else {
        delete element.dataset.definitionBlurState;
      }
    }

    function setDefinitionBlurState(state) {
      definitionBlurState = DEFINITION_BLUR_STATES.has(state) ? state : "revealed";
      if (definitionBlurState === "revealed") {
        delete popup.dataset.definitionBlurState;
      } else {
        popup.dataset.definitionBlurState = definitionBlurState;
      }
      for (const definitions of popup.querySelectorAll(".gsm-hoshidicts-definitions")) {
        applyDefinitionBlurState(definitions);
      }
      return definitionBlurState;
    }

    function clear(preserveViewControls = false) {
      currentPresentationUpdate = null;
      pendingPresentation = null;
      hideImagePreview();
      renderRevision += 1;
      currentResultPanel = null;
      if (!preserveViewControls) {
        currentNoteControls?.close(false);
        currentNoteControls = null;
      }
      sourceHighlighter.clear();
      currentSourceHighlight = null;
      currentToolbar = null;
      masonryObserver?.disconnect();
      const retainedForm = currentNoteControls?.form;
      if (retainedForm?.parentNode === popup) {
        // Keep the live form mounted: detaching it loses focus and selection.
        for (const child of [...popup.childNodes]) {
          if (child !== retainedForm) child.remove();
        }
      } else {
        popup.replaceChildren();
      }
      // A hidden retirement needs no layout; the next visible render resets it.
      if (!popup.hidden && !preserveViewControls) popup.scrollTop = 0;
      setDefinitionBlurState("revealed");
    }

    function mountResultChrome(toolbar, content) {
      const form = currentNoteControls?.form;
      if (form?.parentNode === popup) {
        if (toolbarPosition === "bottom") {
          popup.prepend(content);
          popup.append(toolbar);
        } else {
          popup.prepend(toolbar);
          popup.append(content);
        }
      } else {
        popup.append(toolbar, content);
      }
      setRenderedToolbar(toolbar);
    }

    function retainedFocus(preserveViewControls) {
      if (!preserveViewControls) return null;
      const focused = popup.getRootNode().activeElement;
      if (!popup.contains(focused)) return null;
      if (focused.matches('[role="tab"]')) return '[role="tab"][aria-selected="true"]';
      if (focused.matches(".gsm-hoshidicts-kanji-back")) return ".gsm-hoshidicts-kanji-back";
      return focused;
    }

    function restoreRetainedFocus(focused) {
      const control = typeof focused === "string" ? popup.querySelector(focused) : focused;
      if (!control || !popup.contains(control)) return;
      if (popup.getRootNode().activeElement !== control) control.focus();
      control.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }

    function canProjectPresentation() {
      const form = currentNoteControls?.form;
      if (form && (!form.hidden || form.getAttribute("aria-busy") === "true")) return false;
      if (options.canProjectDictionaryPresentation?.() === false) return false;
      const focused = popup.getRootNode().activeElement;
      return !popup.contains(focused) || focused.matches('[role="tab"]')
        || currentNoteControls?.actions.contains(focused);
    }

    function flushDictionaryPresentation() {
      if (!pendingPresentation || !currentPresentationUpdate) return;
      const pending = pendingPresentation;
      if (currentPresentationUpdate(pending) && pendingPresentation === pending) pendingPresentation = null;
    }

    function onPresentationFocusOut() {
      if (pendingPresentation) windowRef.queueMicrotask(flushDictionaryPresentation);
    }
    popup.addEventListener("focusout", onPresentationFocusOut);

    function runRenderAction(isCurrent, renderContext, action) {
      if (!isCurrent()) return;
      try {
        return action();
      } catch (error) {
        if (!isCurrent()) return;
        clear();
        renderContext.onRenderError?.(error);
      }
    }

    function ownsResultPanel(panel, renderContext) {
      return currentResultPanel === panel && renderContext.isCurrentRequest?.() !== false;
    }

    function ownsDisplayedPanel(panel, renderContext) {
      const isCurrent = renderContext.isCurrentView || renderContext.isCurrentRequest;
      return currentResultPanel === panel && isCurrent?.() !== false;
    }

    function createNoteControls(readPrefill) {
      if (currentNoteControls) {
        currentNoteControls.setPrefillReader(readPrefill);
        return currentNoteControls;
      }
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "gsm-hoshidicts-note-button";
      button.title = "Add to custom dictionary";
      button.setAttribute("aria-label", "Add to custom dictionary");
      button.setAttribute("aria-expanded", "false");

      const icon = documentRef.createElement("span");
      icon.className = "gsm-hoshidicts-note-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "+";
      button.appendChild(icon);

      const actions = documentRef.createElement("div");
      actions.className = "gsm-hoshidicts-entry-actions";
      actions.appendChild(button);

      let editor = null;
      button.addEventListener("click", () => {
        if (!editor) {
          editor = createNoteForm(button, () => readPrefill());
          applyToolbarLayout();
        }
        if (editor.form.hidden) editor.open();
        else editor.close();
      });
      return {
        actions,
        button,
        close: (restoreFocus) => editor?.close(restoreFocus) ?? false,
        setPrefillReader(value) { readPrefill = value; },
        get form() { return editor?.form ?? null; },
      };
    }

    function createNoteForm(button, readPrefill) {
      const form = documentRef.createElement("form");
      form.className = "gsm-hoshidicts-note-form";
      form.id = `${idPrefix}-note-form`;
      form.hidden = true;
      button.setAttribute("aria-controls", form.id);

      function createField(labelText, name, multiline = false) {
        const label = documentRef.createElement("label");
        label.className = "gsm-hoshidicts-note-field";
        const labelValue = documentRef.createElement("span");
        labelValue.textContent = labelText;
        const control = multiline
          ? documentRef.createElement("textarea")
          : documentRef.createElement("input");
        control.id = `${idPrefix}-note-${name}`;
        control.name = name;
        control.className = `gsm-hoshidicts-note-${name}`;
        control.required = true;
        if (!multiline) control.autocomplete = "off";
        label.htmlFor = control.id;
        label.append(labelValue, control);
        form.appendChild(label);
        return control;
      }

      const term = createField("Term", "term");
      const reading = createField("Reading", "reading");
      const definition = createField("Definition", "definition", true);
      const error = documentRef.createElement("div");
      error.className = "gsm-hoshidicts-note-error";
      error.setAttribute("role", "alert");
      error.hidden = true;
      form.appendChild(error);

      const formActions = documentRef.createElement("div");
      formActions.className = "gsm-hoshidicts-note-actions";
      const cancel = documentRef.createElement("button");
      cancel.type = "button";
      cancel.className = "gsm-hoshidicts-note-cancel";
      cancel.textContent = "Cancel";
      const save = documentRef.createElement("button");
      save.type = "submit";
      save.className = "gsm-hoshidicts-note-save";
      save.textContent = "Save";
      formActions.append(cancel, save);
      form.appendChild(formActions);

      let editing = false;
      let pending = false;

      function setPending(value) {
        pending = value;
        form.setAttribute("aria-busy", String(pending));
        save.textContent = pending ? "Saving…" : "Save";
        for (const control of [term, reading, definition, cancel, save]) {
          control.disabled = pending;
        }
        button.disabled = pending;
      }

      function close(restoreFocus = true) {
        if (form.hidden) return false;
        form.hidden = true;
        button.setAttribute("aria-expanded", "false");
        error.hidden = true;
        error.textContent = "";
        if (editing) {
          editing = false;
          onNoteEditingChange(false);
        }
        if (restoreFocus && button.isConnected) button.focus();
        positionPopup();
        flushDictionaryPresentation();
        return true;
      }

      function open() {
        const prefill = readPrefill() || {};
        term.value = String(prefill.term || "");
        reading.value = String(prefill.reading || "");
        definition.value = String(prefill.definition || "");
        error.hidden = true;
        error.textContent = "";
        form.hidden = false;
        button.setAttribute("aria-expanded", "true");
        if (!editing) {
          editing = true;
          onNoteEditingChange(true);
        }
        positionPopup();
        popup.scrollTop = toolbarPosition === "bottom" ? popup.scrollHeight : 0;
        term.focus();
        term.select();
      }

      cancel.addEventListener("click", () => close());
      form.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && close()) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (pending) return;
        const entry = {
          term: term.value,
          reading: reading.value,
          definition: definition.value,
        };
        if (Object.values(entry).some((value) => value.trim() === "")) {
          error.textContent = "Complete the term, reading, and definition.";
          error.hidden = false;
          positionPopup();
          return;
        }
        error.hidden = true;
        error.textContent = "";
        setPending(true);
        let saved = false;
        try {
          await onAddCustomEntry(entry);
          saved = true;
        } catch (appendError) {
          error.textContent = typeof appendError?.message === "string"
            ? appendError.message
            : String(appendError);
          error.hidden = false;
          positionPopup();
        } finally {
          setPending(false);
        }
        if (saved) close();
      });

      return { close, open, form };
    }

    function setSourceHighlightEnabled(enabled) {
      sourceHighlightEnabled = enabled === true;
      if (!sourceHighlightEnabled) {
        sourceHighlighter.clear();
      } else if (currentSourceHighlight) {
        sourceHighlighter.apply(
          currentSourceHighlight.candidate,
          currentSourceHighlight.matchedText
        );
      }
      return sourceHighlightEnabled;
    }

    function setLookupStats(element, payload) {
      const seen = formatLookupCount("Seen", payload && payload.seenCount);
      const lookedUp = formatLookupCount(
        "Looked up",
        payload && payload.lookupCount
      );
      const segments = [seen, lookedUp].filter(Boolean);
      element.textContent = segments.join(" · ");
      element.hidden = segments.length === 0;
      if (!element.hidden) {
        positionPopup();
      }
    }

    // Not named `chrome`: this runs in the content script's isolated world, where
    // that identifier is the extension API.
    function createResultChrome(primaryHeader, metadataStrip = null) {
      const wrapper = documentRef.createElement("div");
      wrapper.className = "gsm-hoshidicts-result-chrome";
      wrapper.appendChild(primaryHeader);
      if (metadataStrip) {
        wrapper.appendChild(metadataStrip);
      }
      return wrapper;
    }

    // `candidate` is unused now that the notice carries no per-term controls,
    // but the content script calls renderNotice with the same arguments it
    // passes to renderResults.
    function renderNotice(message, candidate) {
      clear();
      const notice = documentRef.createElement("div");
      notice.className = "gsm-hoshidicts-lookup-notice";
      notice.setAttribute("role", "status");
      notice.textContent = message;
      popup.appendChild(notice);
    }

    function appendMetadata(
      entry,
      result,
      dictionaryPresentation = [],
      {
        includeFrequency = true,
        includePitch = true,
        averageFrequency = false,
        showFrequencyDictionaryNames = true,
      } = {}
    ) {
      const frequencyRow = documentRef.createElement("div");
      frequencyRow.className =
        "gsm-hoshidicts-metadata gsm-hoshidicts-frequency-metadata";
      const pitchRow = documentRef.createElement("div");
      pitchRow.className =
        "gsm-hoshidicts-metadata gsm-hoshidicts-pitch-metadata";
      const seen = new Set();
      let count = 0;
      const pitchDictionaryDisplayNames = createDictionaryDisplayNames(
        result.term.pitches.map(({ dictionary }) => dictionary),
        dictionaryPresentation
      );
      if (includeFrequency) {
        const frequencyTags = createFrequencyTags(
          documentRef,
          result,
          dictionaryPresentation,
          maxMetadataTags,
          averageFrequency,
          showFrequencyDictionaryNames
        );
        frequencyRow.append(...frequencyTags);
        count += frequencyTags.length;
      }
      if (includePitch) {
        for (const group of result.term.pitches) {
          for (const pitch of group.pitches) {
            const reading = String(
              result.term.reading || result.term.expression || ""
            ).trim();
            const key = JSON.stringify([
              group.dictionary,
              reading,
              pitch.position,
              pitch.pattern,
            ]);
            if (!seen.has(key) && count < maxMetadataTags) {
              seen.add(key);
              pitchRow.appendChild(createPitchTag(
                documentRef,
                group,
                pitchDictionaryDisplayNames.get(group.dictionary) || group.dictionary,
                pitch,
                reading
              ));
              count += 1;
            }
          }
        }
      }
      if (frequencyRow.childNodes.length > 0) {
        entry.appendChild(frequencyRow);
      }
      if (pitchRow.childNodes.length > 0) {
        entry.appendChild(pitchRow);
      }
    }

    function collectGrammarMetadata(result) {
      const metadata = [];
      const seen = new Set();
      const append = (text, description, kind) => {
        const value = String(text || "").trim();
        if (!value || seen.has(value)) {
          return;
        }
        seen.add(value);
        metadata.push({ description, kind, text: value });
      };
      for (const step of deinflectionSteps(result)) {
        append(step.name, step.description, "deinflection");
      }
      for (const tag of [
        ...parseTagList(result.term.rules),
        ...result.term.glossaries.flatMap((glossary) =>
          parseTagList(glossary.termTags)
        ),
      ]) {
        append(tag, "", "term");
      }
      return metadata;
    }

    function renderPrimaryMetadataCapsule(
      capsule,
      result,
      dictionaryPresentation,
      hideGrammarTags,
      averageFrequency,
      showFrequencyDictionaryNames
    ) {
      capsule.replaceChildren();
      const frequencyTags = createFrequencyTags(
        documentRef,
        result,
        dictionaryPresentation,
        maxMetadataTags,
        averageFrequency,
        showFrequencyDictionaryNames
      );
      if (frequencyTags.length > 0) {
        const frequencies = documentRef.createElement("span");
        frequencies.className = "gsm-hoshidicts-primary-frequencies";
        frequencies.append(...frequencyTags);
        capsule.appendChild(frequencies);
      }
      if (!hideGrammarTags) {
        const grammarMetadata = collectGrammarMetadata(result);
        if (grammarMetadata.length > 0) {
          const grammar = documentRef.createElement("span");
          grammar.className = "gsm-hoshidicts-primary-grammar";
          for (const item of grammarMetadata) {
            const tag = documentRef.createElement("span");
            tag.className =
              `gsm-hoshidicts-primary-grammar-tag ` +
              `gsm-hoshidicts-primary-grammar-tag-${item.kind}`;
            tag.textContent = item.text;
            if (item.description) {
              tag.title = item.description;
            }
            grammar.appendChild(tag);
          }
          capsule.appendChild(grammar);
        }
      }
      capsule.hidden = capsule.childNodes.length === 0;
    }

    function updateMetadataStripVisibility(strip, tabList, capsule) {
      strip.hidden = !tabList && capsule.hidden;
    }

    function updateCompactSummary(headword, result, context, media) {
      const previous = headword.querySelector(".gsm-hoshidicts-compact-definition-summary");
      if (previous) {
        const imageLink = previous.querySelector(".gloss-image-link");
        if (imageLink) hideImagePreview(imageLink);
        previous.remove();
      }
      if (context.showCompactDefinitionSummary !== true) return Boolean(previous);
      const compact = extractCompactDefinitionSummary(result.term.glossaries,
        context.compactDefinitionSummaryDictionary, context.compactDefinitionSummaryCount);
      if (!compact) return Boolean(previous);
      const summary = documentRef.createElement("div");
      summary.className = "gsm-hoshidicts-compact-definition-summary";
      summary.dataset.hoshidictsDictionary = compact.dictionary;
      // Establish ownership before synchronous media admission. Replacing this
      // summary retires its consumer without retiring the complete card's one.
      headword.querySelector(".gsm-hoshidicts-expression").after(summary);
      if (compact.image) {
        const thumbnail = documentRef.createElement("span");
        thumbnail.className = "gsm-hoshidicts-compact-definition-image";
        summary.appendChild(thumbnail);
        appendStructuredImage(documentRef, thumbnail, { ...compact.image,
          preferredWidth: 36, preferredHeight: 36, sizeUnits: "px" }, {
          isCurrent: () => headword.contains(summary) && media.isCurrent(),
          onLayoutChange: media.onLayoutChange,
          requestImagePreview, refreshImagePreview, hideImagePreview,
          resolveMedia: typeof media.resolveMedia === "function"
            ? query => media.resolveMedia({ ...query, dictionary: compact.dictionary, generation: media.generation })
            : null,
        });
        if (!thumbnail.hasChildNodes()) thumbnail.remove();
      }
      const items = documentRef.createElement("ul");
      items.className = "gsm-hoshidicts-compact-definition-items";
      for (const item of compact.items) {
        const li = documentRef.createElement("li");
        li.textContent = item;
        items.appendChild(li);
      }
      summary.appendChild(items);
      return true;
    }

    function createEntryHeader(
      result,
      candidate,
      {
        element = null,
        primary = false,
        showCompactDefinitionSummary = false,
        compactDefinitionSummaryCount =
          DEFAULT_COMPACT_DEFINITION_SUMMARY_COUNT,
        compactDefinitionSummaryDictionary = null,
        summaryMedia = null,
        showPitchAccentFurigana = true,
        pitchAccentFuriganaDictionary = null,
        onBack = null,
        noteControls = null,
        onDeinflectionToggle = null,
      } = {}
    ) {
      const header = element || documentRef.createElement("header");
      header.className = primary
        ? "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header"
        : "gsm-hoshidicts-entry-header";
      header.replaceChildren();

      const headword = documentRef.createElement("div");
      headword.className = "gsm-hoshidicts-headword";
      const expression = documentRef.createElement("span");
      expression.className = "gsm-hoshidicts-expression";
      const expressionText = String(result.term.expression || "").trim();
      const readingText = String(result.term.reading || "").trim();
      appendExpressionRuby(
        documentRef,
        expression,
        expressionText,
        readingText,
        (character, sourceLink) => onKanjiClick(character, result, candidate, sourceLink),
        {
          enabled: showPitchAccentFurigana,
          groups: result.term.pitches,
          dictionary: pitchAccentFuriganaDictionary,
        }
      );
      expression.setAttribute(
        "aria-label",
        readingText && readingText !== expressionText
          ? `${expressionText}, ${readingText}`
          : expressionText
      );
      headword.appendChild(expression);
      if (showCompactDefinitionSummary === true) {
        updateCompactSummary(headword, result, { showCompactDefinitionSummary,
          compactDefinitionSummaryCount, compactDefinitionSummaryDictionary }, summaryMedia);
      }
      const deinflection = buildDeinflectionDisclosure(documentRef, result, windowRef.navigator.language);
      if (deinflection) {
        deinflection.addEventListener("toggle", onDeinflectionToggle);
        headword.appendChild(deinflection);
      }
      if (primary && typeof onBack === "function") {
        const navigation = documentRef.createElement("div");
        navigation.className = "gsm-hoshidicts-kanji-navigation";
        const back = documentRef.createElement("button");
        back.type = "button";
        back.className = "gsm-hoshidicts-kanji-back";
        back.textContent = "Back";
        back.setAttribute("aria-label", "Back to previous results");
        back.addEventListener("click", onBack);
        navigation.append(back, headword);
        header.appendChild(navigation);
      } else {
        header.appendChild(headword);
      }
      if (primary && noteControls) {
        header.appendChild(noteControls.actions);
      }
      return { element: header };
    }

    function projectResults(results, dictionaries) {
      if (dictionaries.size === 0) {
        return results;
      }
      const projected = [];
      for (const result of results) {
        const glossaries = result.term.glossaries.filter(
          (glossary) => dictionaries.has(glossary.dictionary)
        );
        if (glossaries.length === 0) {
          continue;
        }
        projected.push({
          ...result,
          term: {
            ...result.term,
            glossaries,
          },
        });
      }
      return projected;
    }

    function renderResultPanel(
      panel,
      results,
      candidate,
      renderContext,
      {
        dictionaryDisplayNames,
        metadataStrip,
        primaryHeader,
        primaryMetadataCapsule,
        tabList,
      } = {}
    ) {
      const revision = ++renderRevision;
      const isCurrent = () => revision === renderRevision && ownsResultPanel(panel, renderContext);
      const isCurrentLink = () => revision === renderRevision && ownsDisplayedPanel(panel, renderContext);
      const positionIfCurrent = () => { if (isCurrent()) positionPopup(); };
      const summaryMedia = { isCurrent, generation: renderContext.generation,
        resolveMedia: renderContext.resolveMedia, onLayoutChange: positionIfCurrent };
      hideImagePreview();
      panel.replaceChildren();
      const deferredGlossaryFills = [];
      let lookupStats = null;
      let expanded = renderContext.expandAll === true;

      function appendResult(result, resultIndex) {
        const entry = documentRef.createElement("article");
        entry.className = "gsm-hoshidicts-entry";
        entry.dataset.expression = result.term.expression;

        const renderedHeader = createEntryHeader(result, candidate, {
          element: resultIndex === 0 ? primaryHeader : null,
          primary: resultIndex === 0,
          showCompactDefinitionSummary:
            renderContext.showCompactDefinitionSummary === true,
          compactDefinitionSummaryCount:
            renderContext.compactDefinitionSummaryCount,
          compactDefinitionSummaryDictionary:
            typeof renderContext.compactDefinitionSummaryDictionary === "string"
              ? renderContext.compactDefinitionSummaryDictionary
              : null,
          summaryMedia,
          showPitchAccentFurigana:
            renderContext.showPitchAccentFurigana !== false,
          pitchAccentFuriganaDictionary:
            typeof renderContext.pitchAccentFuriganaDictionary === "string"
              ? renderContext.pitchAccentFuriganaDictionary
              : null,
          onBack: resultIndex === 0 ? renderContext.onBack : null,
          noteControls: resultIndex === 0 ? renderContext.noteControls : null,
          onDeinflectionToggle: positionIfCurrent,
        });
        if (resultIndex !== 0) {
          entry.appendChild(renderedHeader.element);
        }

        if (resultIndex === 0 && renderContext.showLookupCounts === true) {
          lookupStats = documentRef.createElement("div");
          lookupStats.className = "gsm-hoshidicts-lookup-stats";
          lookupStats.setAttribute("role", "status");
          lookupStats.setAttribute("aria-live", "polite");
          lookupStats.hidden = true;
          entry.appendChild(lookupStats);
        }

        if (resultIndex === 0 && primaryMetadataCapsule) {
          renderPrimaryMetadataCapsule(
            primaryMetadataCapsule,
            result,
            Array.isArray(renderContext.dictionaryPresentation)
              ? renderContext.dictionaryPresentation
              : [],
            renderContext.hidePopupGrammarTags !== false,
            renderContext.averageFrequency === true,
            renderContext.showFrequencyDictionaryNames !== false
          );
          if (metadataStrip) {
            updateMetadataStripVisibility(
              metadataStrip,
              tabList,
              primaryMetadataCapsule
            );
          }
        }

        appendMetadata(
          entry,
          result,
          Array.isArray(renderContext.dictionaryPresentation)
            ? renderContext.dictionaryPresentation
            : [],
          {
            includeFrequency: resultIndex !== 0,
            includePitch: renderContext.showPitchAccentBadge === true,
            averageFrequency: renderContext.averageFrequency === true,
            showFrequencyDictionaryNames:
              renderContext.showFrequencyDictionaryNames !== false,
          }
        );

        if (
          resultIndex !== 0 &&
          renderContext.hidePopupGrammarTags === false
        ) {
          const tagRow = documentRef.createElement("div");
          tagRow.className = "gsm-hoshidicts-tags";
          for (const item of collectGrammarMetadata(result)) {
            tagRow.appendChild(createTag(
              documentRef,
              item.text,
              item.description,
              item.kind
            ));
          }
          if (tagRow.childNodes.length > 0) {
            entry.appendChild(tagRow);
          }
        }

        const groupedGlossaries = new Map();
        for (const glossary of result.term.glossaries) {
          if (!groupedGlossaries.has(glossary.dictionary)) {
            groupedGlossaries.set(glossary.dictionary, []);
          }
          groupedGlossaries.get(glossary.dictionary).push(glossary);
        }
        const glossaryGrid = documentRef.createElement("div");
        glossaryGrid.className = "gsm-hoshidicts-glossary-grid";
        for (const [dictionary, glossaries] of groupedGlossaries) {
          const details = documentRef.createElement("details");
          details.className = "gsm-hoshidicts-glossary-card";
          details.open = true;
          details.addEventListener("toggle", scheduleMasonry);
          const summary = documentRef.createElement("summary");
          summary.textContent = dictionaryDisplayNames?.get(dictionary) || dictionary;
          summary.title = dictionary;
          summary.setAttribute("aria-label", dictionary);
          details.appendChild(summary);
          const definitions = documentRef.createElement("ol");
          definitions.className = "gsm-hoshidicts-definitions";
          if (glossaries.length === 1) {
            definitions.classList.add("gsm-hoshidicts-definitions-single");
          }
          applyDefinitionBlurState(definitions);
          for (const glossary of glossaries) {
            const definition = documentRef.createElement("li");
            const definitionTags = parseTagList(glossary.definitionTags);
            if (definitionTags.length > 0) {
              const definitionTagRow = documentRef.createElement("div");
              definitionTagRow.className = "gsm-hoshidicts-definition-tags";
              for (const tag of definitionTags) {
                definitionTagRow.appendChild(
                  createTag(documentRef, tag, "", "definition")
                );
              }
              definition.appendChild(definitionTagRow);
            }
            const content = documentRef.createElement("div");
            content.className = "gsm-hoshidicts-glossary-content";
            content.dataset.hoshidictsDictionary = dictionary;
            const fillContent = () => appendTextOnlyGlossary(
              documentRef,
              content,
              glossary.glossary,
              {
                dictionary,
                generation: renderContext.generation,
                isCurrent,
                isCurrentLink,
                onExternalLink: renderContext.onExternalLink,
                onInternalLink: renderContext.onInternalLink,
                onLayoutChange: positionIfCurrent,
                requestImagePreview,
                refreshImagePreview,
                hideImagePreview,
                resolveMedia: renderContext.resolveMedia,
              }
            );
            // Glossary bodies are most of a render. Only the first entry is
            // visible in the popup, so fill the rest after it has painted.
            if (resultIndex === 0) {
              fillContent();
            } else {
              deferredGlossaryFills.push(fillContent);
            }
            definition.appendChild(content);
            definitions.appendChild(definition);
          }
          details.appendChild(definitions);
          glossaryGrid.appendChild(details);
        }
        entry.appendChild(glossaryGrid);
        // Fixed-width masonry cards cannot signal a change to their container.
        masonryObserver?.observe(glossaryGrid);
        for (const card of glossaryGrid.children) {
          masonryObserver?.observe(card);
        }
        scheduleMasonry();
        panel.appendChild(entry);
      }

      // Fills the queued glossaries on the next task, once the first entry has
      // had a chance to paint. Fills inline without a timer available.
      function flushDeferredGlossaries() {
        if (deferredGlossaryFills.length === 0) {
          return;
        }
        const fills = deferredGlossaryFills.splice(0);
        const run = () => {
          for (const fill of fills) {
            if (!isCurrent()) return;
            fill();
          }
          positionIfCurrent();
        };
        if (typeof windowRef.setTimeout === "function") {
          windowRef.setTimeout(() => runRenderAction(isCurrent, renderContext, run), 0);
        } else {
          run();
        }
      }

      const visibleCount = renderContext.expandAll === true ? results.length : initialResultCount;
      results.slice(0, visibleCount).forEach(appendResult);
      flushDeferredGlossaries();

      if (results.length > visibleCount) {
        const showMore = documentRef.createElement("button");
        showMore.type = "button";
        showMore.className = "gsm-hoshidicts-show-more";
        showMore.textContent = `Show ${results.length - visibleCount} more`;
        showMore.addEventListener("click", () => runRenderAction(
          () => ownsDisplayedPanel(panel, renderContext), renderContext, () => {
          if (!isCurrent()) {
            onBeforeResultsRendered({ expandAll: true });
            return;
          }
          showMore.remove();
          expanded = true;
          results.slice(visibleCount).forEach((result, resultIndex) => {
            appendResult(result, resultIndex + visibleCount);
          });
          flushDeferredGlossaries();
          onResultsExpanded();
          positionPopup();
        }));
        panel.appendChild(showMore);
      }

      currentSourceHighlight = {
        candidate,
        matchedText: results[0].matched || results[0].term.expression,
      };
      if (sourceHighlightEnabled) {
        sourceHighlighter.apply(
          currentSourceHighlight.candidate,
          currentSourceHighlight.matchedText
        );
      }
      function updateMetadataLabels(container, result) {
        let changed = false;
        for (const [kind, groups] of [["frequency", result.term.frequencies], ["pitch", result.term.pitches]]) {
          if (kind === "frequency" && renderContext.averageFrequency === true) continue;
          const names = createDictionaryDisplayNames(groups.map(({ dictionary }) => dictionary), renderContext.dictionaryPresentation);
          for (const source of container.querySelectorAll(`.gsm-hoshidicts-${kind}-source`)) {
            const dictionary = source.parentNode.dataset.dictionary;
            changed = updateLabel(source, names.get(dictionary) || dictionary) || changed;
          }
        }
        return changed;
      }

      return { lookupStats,
        isExpanded: () => expanded,
        updateDictionaryPresentation(context, names, summaryChanged) {
          summaryChanged &&= isCurrent();
          Object.assign(renderContext, context);
          dictionaryDisplayNames = names;
          let changed = updateMetadataLabels(primaryMetadataCapsule, results[0]);
          if (summaryChanged) {
            changed = updateCompactSummary(primaryHeader.querySelector(".gsm-hoshidicts-headword"),
              results[0], renderContext, summaryMedia) || changed;
          }
          const entries = panel.querySelectorAll(":scope > .gsm-hoshidicts-entry");
          entries.forEach((entry, index) => {
            if (index > 0 && summaryChanged) {
              changed = updateCompactSummary(entry.querySelector(".gsm-hoshidicts-headword"),
                results[index], renderContext, summaryMedia) || changed;
            }
            for (const row of entry.querySelectorAll(":scope > .gsm-hoshidicts-metadata")) {
              changed = updateMetadataLabels(row, results[index]) || changed;
            }
            for (const summary of entry.querySelectorAll(":scope > .gsm-hoshidicts-glossary-grid > details > summary")) {
              changed = updateLabel(summary, names.get(summary.title) || summary.title) || changed;
            }
          });
          return changed;
        },
      };
    }

    function renderKanji(kanji, candidate, renderOptions = {}) {
      renderOptions = { ...renderOptions };
      const focused = retainedFocus(renderOptions.preserveViewControls);
      clear(renderOptions.preserveViewControls);
      const dictionaries = [...new Set(kanji.entries.map(({ dictionary }) => dictionary))];
      let { tabs, dictionaryDisplayNames } = createDictionaryTabs(dictionaries, renderOptions);
      const requestedKey = dictionaryTabKey(renderOptions.selectedDictionaryTab);
      let selected = tabs.find((tab) => tab.key === requestedKey) || tabs[0];
      renderOptions.onDictionaryTabSelected?.(normaliseDictionaryTab(selected));
      const noteControls = createNoteControls(() => ({
        term: kanji.character,
        reading: "",
        definition: "",
      }));
      currentNoteControls = noteControls;
      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      const navigation = documentRef.createElement("div");
      navigation.className = "gsm-hoshidicts-kanji-navigation";
      if (typeof renderOptions.onBack === "function") {
        const back = documentRef.createElement("button");
        back.type = "button";
        back.className = "gsm-hoshidicts-kanji-back";
        back.textContent = "Back";
        back.setAttribute("aria-label", "Back to previous results");
        back.addEventListener("click", renderOptions.onBack);
        navigation.appendChild(back);
      }
      const glyph = documentRef.createElement("div");
      glyph.className = "gsm-hoshidicts-kanji-glyph";
      glyph.textContent = kanji.character;
      navigation.appendChild(glyph);
      primaryHeader.append(navigation, noteControls.actions);
      const toolbar = createResultChrome(primaryHeader);

      function renderEntries() {
        const entries = documentRef.createDocumentFragment();

        for (const kanjiEntry of kanji.entries) {
          if (selected.dictionaries.size > 0 && !selected.dictionaries.has(kanjiEntry.dictionary)) continue;
          const entry = documentRef.createElement("article");
          entry.className = "gsm-hoshidicts-kanji-entry";
          entry.dataset.dictionary = kanjiEntry.dictionary;

          const dictionary = documentRef.createElement("h3");
          dictionary.className = "gsm-hoshidicts-kanji-dictionary";
          dictionary.textContent = dictionaryDisplayNames.get(
            kanjiEntry.dictionary
          ) || kanjiEntry.dictionary;
          dictionary.title = kanjiEntry.dictionary;
          dictionary.setAttribute("aria-label", kanjiEntry.dictionary);
          entry.appendChild(dictionary);

          const kanjiTags = tokenList(kanjiEntry.tags);
          if (kanjiTags.length > 0) {
            const tags = documentRef.createElement("div");
            tags.className = "gsm-hoshidicts-tags";
            for (const tag of kanjiTags) {
              tags.appendChild(createTag(documentRef, tag, "", "term"));
            }
            entry.appendChild(tags);
          }

          const readings = documentRef.createElement("div");
          readings.className = "gsm-hoshidicts-kanji-readings";
          for (const [label, values] of [
            ["On", tokenList(kanjiEntry.onyomi)],
            ["Kun", tokenList(kanjiEntry.kunyomi)],
          ]) {
            if (values.length === 0) continue;
            const group = documentRef.createElement("div");
            group.className = "gsm-hoshidicts-kanji-reading-group";
            const heading = documentRef.createElement("strong");
            heading.textContent = label;
            group.appendChild(heading);
            const value = documentRef.createElement("span");
            value.textContent = values.join(" · ");
            group.appendChild(value);
            readings.appendChild(group);
          }
          if (readings.childNodes.length > 0) entry.appendChild(readings);

          if (kanjiEntry.definitions.length > 0) {
            const meaningsHeading = documentRef.createElement("h4");
            meaningsHeading.textContent = "Meanings";
            entry.appendChild(meaningsHeading);
            const meanings = documentRef.createElement("ol");
            meanings.className = "gsm-hoshidicts-kanji-meanings";
            for (const meaning of kanjiEntry.definitions) {
              const item = documentRef.createElement("li");
              item.textContent = meaning;
              meanings.appendChild(item);
            }
            entry.appendChild(meanings);
          }

          if (kanjiEntry.stats.length > 0) {
            const details = documentRef.createElement("details");
            details.className = "gsm-hoshidicts-kanji-stats";
            const summary = documentRef.createElement("summary");
            summary.textContent = "Details";
            details.appendChild(summary);
            const list = documentRef.createElement("dl");
            for (const stat of kanjiEntry.stats) {
              const name = documentRef.createElement("dt");
              name.textContent = stat.name;
              const value = documentRef.createElement("dd");
              value.textContent = stat.value;
              list.append(name, value);
            }
            details.appendChild(list);
            entry.appendChild(details);
          }
          entries.appendChild(entry);
        }
        return entries;
      }

      mountResultChrome(toolbar, renderEntries());
      const ownsKanji = () => currentToolbar === toolbar && renderOptions.isCurrentView?.() !== false;
      currentPresentationUpdate = (context) => runRenderAction(ownsKanji, renderOptions, () => {
        const next = createDictionaryTabs(dictionaries, context);
        const nextSelected = next.tabs.find(tab => tab.key === selected.key) || next.tabs[0];
        const sameMembers = sameTabMembers(selected.dictionaries, nextSelected.dictionaries, dictionaries);
        if (!sameMembers && (renderOptions.isCurrentRequest?.() === false || !canProjectPresentation())) return false;
        Object.assign(renderOptions, context);
        dictionaryDisplayNames = next.dictionaryDisplayNames;
        if (selected.key !== nextSelected.key) renderOptions.onDictionaryTabSelected?.(normaliseDictionaryTab(nextSelected));
        selected = nextSelected;
        let changed = false;
        if (sameMembers) {
          for (const heading of popup.querySelectorAll(":scope > .gsm-hoshidicts-kanji-entry > h3")) {
            changed = updateLabel(heading, dictionaryDisplayNames.get(heading.title) || heading.title) || changed;
          }
        } else {
          for (const entry of popup.querySelectorAll(":scope > .gsm-hoshidicts-kanji-entry")) entry.remove();
          if (toolbarPosition === "bottom") popup.prepend(renderEntries());
          else popup.append(renderEntries());
          changed = true;
        }
        if (changed) scheduleMasonry();
        return true;
      });

      if (sourceHighlightEnabled) {
        sourceHighlighter.apply(
          candidate,
          renderOptions.highlightText || kanji.character
        );
      }
      if (focused) {
        positionPopup();
        restoreRetainedFocus(focused);
      }
    }

    function renderResults(results, candidate, renderContext = {}) {
      renderContext = { ...renderContext };
      const focused = retainedFocus(renderContext.preserveViewControls);
      clear(renderContext.preserveViewControls);
      setDefinitionBlurState(renderContext.definitionBlurState);
      const dictionaries = collectGlossaryDictionaries(results);
      let { tabs: tabDescriptors, dictionaryDisplayNames } = createDictionaryTabs(dictionaries, renderContext);
      const tabList = tabDescriptors.length > 1
        ? documentRef.createElement("div")
        : null;
      if (tabList) {
        tabList.className = "gsm-hoshidicts-tab-list";
        tabList.setAttribute("role", "tablist");
        tabList.setAttribute("aria-label", "Dictionaries");
        tabList.setAttribute("aria-orientation", "horizontal");
      }
      const metadataStrip = documentRef.createElement("div");
      metadataStrip.className = "gsm-hoshidicts-metadata-strip";
      metadataStrip.hidden = true;
      if (tabList) {
        metadataStrip.appendChild(tabList);
      }
      const primaryMetadataCapsule = documentRef.createElement("div");
      primaryMetadataCapsule.className =
        "gsm-hoshidicts-primary-metadata-capsule";
      primaryMetadataCapsule.hidden = true;
      primaryMetadataCapsule.setAttribute("role", "group");
      primaryMetadataCapsule.setAttribute("aria-label", "Entry metadata");
      metadataStrip.appendChild(primaryMetadataCapsule);
      const panel = documentRef.createElement("div");
      currentResultPanel = panel;
      const ownsView = () => ownsResultPanel(panel, renderContext);
      panel.id = `${idPrefix}-tab-panel`;
      panel.className = "gsm-hoshidicts-tab-panel";
      if (tabList) {
        panel.setAttribute("role", "tabpanel");
      }

      const primaryHeader = documentRef.createElement("header");
      primaryHeader.className =
        "gsm-hoshidicts-entry-header gsm-hoshidicts-primary-header";
      let projectedPrimary = null;
      const noteControls = createNoteControls(() => ({
        term: projectedPrimary?.term?.expression || "",
        reading: projectedPrimary?.term?.reading || "",
        definition: "",
      }));
      currentNoteControls = noteControls;
      const toolbar = createResultChrome(primaryHeader, metadataStrip);
      mountResultChrome(toolbar, panel);

      let tabButtons = [];
      let nextTabId = 0;
      const requestedKey = dictionaryTabKey(renderContext.selectedDictionaryTab);
      const requestedTabIndex = tabDescriptors.findIndex((descriptor) => descriptor.key === requestedKey);
      let focusedIndex = Math.max(0, requestedTabIndex);
      let selectedIndex = focusedIndex;
      let hasRendered = false;
      let rendered = null;

      function updateTabState() {
        tabButtons.forEach((button, buttonIndex) => {
          const selected = buttonIndex === selectedIndex;
          button.setAttribute("aria-selected", String(selected));
          button.tabIndex = buttonIndex === focusedIndex ? 0 : -1;
        });
        const selectedButton = tabButtons[selectedIndex];
        if (selectedButton) {
          panel.setAttribute("aria-labelledby", selectedButton.id);
        } else {
          panel.removeAttribute("aria-labelledby");
        }
      }

      function activateTab(index, focusButton = false) {
        const tablessAllView = tabButtons.length === 0 && index === 0;
        if (!tablessAllView && (index < 0 || index >= tabButtons.length)) {
          return;
        }
        const previousIndex = selectedIndex;
        focusedIndex = index;
        selectedIndex = index;
        updateTabState();
        const button = tabButtons[index];
        if (focusButton && button) {
          button.focus();
        }
        const selectionChanged = previousIndex !== selectedIndex;
        if ((!hasRendered || selectionChanged)
            && typeof renderContext.onDictionaryTabSelected === "function") {
          const descriptor = tabDescriptors[selectedIndex];
          renderContext.onDictionaryTabSelected(normaliseDictionaryTab(descriptor));
        }
        if (hasRendered && !selectionChanged) {
          if (!ownsView()) {
            onBeforeResultsRendered();
            return;
          }
          if (
            button && !popup.hidden
            && typeof button.scrollIntoView === "function"
          ) {
            button.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
          return;
        }
        if (hasRendered) {
          if (onBeforeResultsRendered() === false) return;
        }
        if (hasRendered || !renderContext.preserveViewControls) popup.scrollTop = 0;
        renderProjection(!hasRendered && renderContext.expandAll === true);
        if (hasRendered) {
          onResultsRendered(rendered);
        }
        hasRendered = true;
        positionPopup();
      }

      function renderProjection(expandAll) {
        if (hasRendered) masonryObserver?.disconnect();
        const selectedDictionaries = tabDescriptors[selectedIndex].dictionaries;
        const projectedResults = projectResults(results, selectedDictionaries);
        projectedPrimary = projectedResults[0] || null;
        rendered = renderResultPanel(
          panel,
          projectedResults,
          candidate,
          {
            ...renderContext,
            noteControls,
            expandAll,
            // Lookup statistics describe the first unfiltered result. Keep the
            // line on the All tab so a dictionary projection cannot attach the
            // original term's count to a different expression.
            showLookupCounts:
              selectedDictionaries.size === 0
              && renderContext.showLookupCounts === true,
          },
          {
            dictionaryDisplayNames,
            metadataStrip,
            primaryHeader,
            primaryMetadataCapsule,
            tabList,
          }
        );
      }

      function activateTabFromEvent(index, focusButton = false) {
        runRenderAction(() => ownsDisplayedPanel(panel, renderContext), renderContext, () => activateTab(index, focusButton));
      }

      function createTabButton(descriptor) {
        const button = documentRef.createElement("button");
        button.type = "button";
        button.id = `${idPrefix}-tab-${nextTabId++}`;
        button.className = "gsm-hoshidicts-tab";
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", panel.id);
        if (descriptor.groupId) button.dataset.groupId = descriptor.groupId;
        if (descriptor.dictionary) {
          button.dataset.dictionary = descriptor.dictionary;
        }
        if (descriptor.favourites) button.dataset.favourites = "true";
        button.addEventListener("click", () => activateTabFromEvent(tabButtons.indexOf(button)));
        button.addEventListener("keydown", (event) => {
          const index = tabButtons.indexOf(button);
          if (index < 0) return;
          let nextIndex = null;
          if (event.key === "ArrowRight") {
            nextIndex = (index + 1) % tabButtons.length;
          } else if (event.key === "ArrowLeft") {
            nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = tabButtons.length - 1;
          }
          if (nextIndex !== null) {
            event.preventDefault();
            event.stopPropagation();
            activateTabFromEvent(nextIndex, true);
          }
        });
        return button;
      }

      function syncTabButtons(previousDescriptors = []) {
        if (!tabList) return false;
        const previous = new Map(previousDescriptors.map((descriptor, index) => [descriptor.key, tabButtons[index]]));
        const focused = popup.getRootNode().activeElement;
        const focusedKey = previousDescriptors[tabButtons.indexOf(focused)]?.key;
        let changed = false;
        tabButtons = tabDescriptors.map(descriptor => {
          const button = previous.get(descriptor.key) || createTabButton(descriptor);
          changed = updateLabel(button, descriptor.label) || changed;
          button.title = descriptor.title;
          button.setAttribute("aria-label", descriptor.title);
          previous.delete(descriptor.key);
          return button;
        });
        for (const button of previous.values()) { button.remove(); changed = true; }
        // Move the other buttons around the focused one, never detach it.
        let next = null;
        for (let index = tabButtons.length - 1; index >= 0; index -= 1) {
          const button = tabButtons[index];
          if (button !== focused && (button.parentNode !== tabList || button.nextSibling !== next)) {
            tabList.insertBefore(button, next);
            changed = true;
          }
          next = button;
        }
        focusedIndex = focusedKey ? tabDescriptors.findIndex(tab => tab.key === focusedKey) : selectedIndex;
        if (focusedIndex < 0) focusedIndex = selectedIndex;
        if (hasRendered) updateTabState();
        if (focusedKey && !tabButtons.includes(focused)) tabButtons[focusedIndex]?.focus();
        return changed;
      }
      syncTabButtons();

      tabList?.addEventListener("wheel", (event) => {
        if (
          Math.abs(event.deltaY) > Math.abs(event.deltaX)
          && tabList.scrollWidth > tabList.clientWidth
        ) {
          const maximumScrollLeft = tabList.scrollWidth - tabList.clientWidth;
          const nextScrollLeft = Math.max(
            0,
            Math.min(maximumScrollLeft, tabList.scrollLeft + event.deltaY)
          );
          if (nextScrollLeft !== tabList.scrollLeft) {
            tabList.scrollLeft = nextScrollLeft;
            event.preventDefault();
          }
        }
      }, { passive: false });

      activateTab(selectedIndex);
      currentPresentationUpdate = (context) => runRenderAction(
        () => ownsDisplayedPanel(panel, renderContext), renderContext, () => {
          const summaryChanged = ["showCompactDefinitionSummary", "compactDefinitionSummaryCount", "compactDefinitionSummaryDictionary"]
            .some(key => Object.hasOwn(context, key) && context[key] !== renderContext[key]);
          // Unlike local body projection, a summary may update with an open
          // Note or child. It still needs the connected request boundary before
          // parsing or admitting media; that boundary may retire this view.
          if (summaryChanged && ownsView() && options.canUpdateCompactSummary?.() === false) return true;
          const next = createDictionaryTabs(dictionaries, context);
          const previous = tabDescriptors;
          const selectedKey = previous[selectedIndex].key;
          let index = next.tabs.findIndex(tab => tab.key === selectedKey);
          if (index < 0) index = 0;
          const sameMembers = sameTabMembers(previous[selectedIndex].dictionaries, next.tabs[index].dictionaries, dictionaries);
          if (!sameMembers && (!ownsView() || !canProjectPresentation())) return false;
          Object.assign(renderContext, context);
          tabDescriptors = next.tabs;
          dictionaryDisplayNames = next.dictionaryDisplayNames;
          selectedIndex = index;
          let changed = syncTabButtons(previous);
          if (selectedKey !== tabDescriptors[index].key) {
            renderContext.onDictionaryTabSelected?.(normaliseDictionaryTab(tabDescriptors[index]));
          }
          if (sameMembers) changed = rendered.updateDictionaryPresentation(context, dictionaryDisplayNames, summaryChanged) || changed;
          else {
            const focused = retainedFocus(true);
            renderProjection(rendered.isExpanded());
            if (focused && typeof focused !== "string") {
              positionPopup();
              restoreRetainedFocus(focused);
            }
            changed = true;
          }
          if (changed) scheduleMasonry();
          return true;
        });
      restoreRetainedFocus(focused);
      return rendered;
    }

    return {
      clear,
      hideImagePreview,
      closeNoteForm() {
        return currentNoteControls?.close() === true;
      },
      renderNotice,
      renderResults,
      renderKanji,
      setDefinitionBlurState,
      setLookupStats,
      setSourceHighlightEnabled,
      setToolbarPosition,
      scheduleMasonry,
      updateDictionaryPresentation(context) {
        if (!currentPresentationUpdate) return;
        pendingPresentation = context;
        flushDictionaryPresentation();
      },
      flushDictionaryPresentation,
      destroy() {
        currentPresentationUpdate = null;
        pendingPresentation = null;
        hideImagePreview();
        renderRevision += 1;
        currentResultPanel = null;
        options.cancelMasonry?.(layoutMasonry);
        if (masonryFrame !== null) {
          windowRef.cancelAnimationFrame(masonryFrame);
          masonryFrame = null;
        }
        masonryObserver?.disconnect();
        windowRef.removeEventListener("resize", onWindowResize);
        popup.removeEventListener("scroll", onPopupScroll, true);
        popup.removeEventListener("focusout", onPresentationFocusOut);
      },
    };
  }

  return {
    calculatePopupPosition,
    createDictionaryDisplayNames,
    createFrequencyTags,
    createPitchTag,
    createPopupView,
    createSourceHighlighter,
    createTag,
    normaliseDictionaryTab,
    extractCompactDefinitionSummary,
    formatCompactFrequencyNumber,
    formatFrequencyValue,
  };
}));
