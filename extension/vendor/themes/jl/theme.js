// Direct popup renderer following JL's popup: one block per result and
// dictionary, JL's wrapping header line, dictionary tabs and JL's defaults.
// Layout, text formats and default values adapted from rampaa/JL, Apache-2.0
// (see ATTRIBUTION.md and LICENSE.Apache-2.0). No JL source is copied.
// Hachidori integration: GPL-3.0-or-later.
// SPDX-License-Identifier: GPL-3.0-or-later
const HAN = /\p{Script=Han}/u;
// JL brackets a JMdict sense's word classes apart from its other tags. Yomitan
// data has one tag string, so JMdict's part-of-speech codes pick the group.
const WORD_CLASS = /^(?:adj-\w+|adv(?:-to)?|aux(?:-adj|-v)?|conj|cop|ctr|exp|int|n(?:-adv|-pr|-pref|-suf|-t)?|num|pn|pref|prt|suf|unc|v-unspec|v[1-5][\w-]*|v[iknrtz]|vs(?:-[cis])?)$/u;
function tagGroups(value) {
  // Yomitan separates tags with spaces; a no-break space stays inside a tag.
  const tags = String(value || "").split(" ").filter(Boolean);
  return [tags.filter(tag => WORD_CLASS.test(tag)), tags.filter(tag => !WORD_CLASS.test(tag))];
}
const brackets = groups => groups.filter(tags => tags.length).map(tags => `[${tags.join(", ")}]`).join(" ");
// JL shows one frequency per dictionary.
const frequencyValue = ({ frequencies: [first] }) => first.displayValue || String(first.value);
const kanjiTokens = value => Array.isArray(value) ? value : String(value || "").split(/\s+/u).filter(Boolean);

function createView(options) {
  const { document, popup, components } = options;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const button = (className, text, callback) => {
    const element = node("button", className, text);
    element.type = "button";
    element.addEventListener("click", callback);
    return element;
  };
  const header = node("div", "jl-header");
  // JL's title row carries the x; the dictionary tabs sit below it.
  const nav = node("div", "jl-nav");
  const tabs = node("div", "jl-tabs");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Dictionaries");
  header.append(nav, tabs);
  const scroll = node("div", "jl-scroll");
  popup.append(header, scroll);
  if (options.onResizeStart) {
    const resize = node("div", "gsm-hoshidicts-resize-handle");
    resize.title = "Resize popup";
    resize.addEventListener("pointerdown", options.onResizeStart);
    resize.addEventListener("pointermove", options.onResizeMove);
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) resize.addEventListener(event, options.onResizeEnd);
    popup.append(resize);
  }
  const highlighter = options.sourceHighlighter;
  let highlightEnabled = options.sourceHighlightEnabled;
  let activeSource, entries = [], bindings = [], selected = 0, labels = [], frequencies = [], tab = null, onTabSelected = null;
  const shown = () => entries.filter(entry => !entry.hidden);

  function clear() {
    tabs.replaceChildren(); nav.replaceChildren(); scroll.replaceChildren();
    entries = []; bindings = []; labels = []; frequencies = []; selected = 0; tab = null; onTabSelected = null; activeSource = null;
    highlighter?.clear();
  }
  function finish(candidate, matched, context) {
    activeSource = { candidate, matched };
    if (highlightEnabled) highlighter?.apply(candidate, matched);
    setDefinitionBlurState(context.definitionBlurState ?? "revealed");
    options.positionPopup();
    if (context.restoreScrollTop) scroll.scrollTop = context.restoreScrollTop;
  }
  function navigation(context) {
    if (context.onClose) {
      const close = button("gsm-hoshidicts-popup-close", "x", context.onClose);
      close.title = "Close";
      close.setAttribute("aria-label", "Close");
      nav.append(close);
    } else if (context.onBack) nav.append(button("gsm-hoshidicts-kanji-back", "Back", context.onBack));
  }
  function setDefinitionBlurState(state) { scroll.dataset.definitionBlur = state; }
  function dictionaryLabel(dictionary) {
    const label = node("span", "jl-dictionary", dictionary);
    label.dataset.dictionary = dictionary;
    labels.push(label);
    return label;
  }
  function updateDictionaryPresentation(context) {
    const names = new Map((context.dictionaryPresentation ?? []).map(item => [item.title, item.displayName || item.title]));
    const name = dictionary => names.get(dictionary) || dictionary;
    for (const label of labels) label.textContent = name(label.dataset.dictionary);
    // JL: "#rank" with one frequency dictionary, "Name: rank, …" with several.
    for (const { element, groups } of frequencies) {
      element.textContent = groups.length === 1 ? `#${frequencyValue(groups[0])}`
        : groups.map(group => `${name(group.dictionary)}: ${frequencyValue(group)}`).join(", ");
    }
  }

  // The first pitch accent that fits the text, preferring Design's pitch dictionary.
  function pitchMorae(text, groups, preferred) {
    const ordered = [...groups.filter(group => group.dictionary === preferred),
      ...groups.filter(group => group.dictionary !== preferred)];
    for (const group of ordered) {
      for (const pitch of group.pitches) {
        const morae = components.buildPitchAccentMorae(text, components.pitchAccentPositions(pitch));
        if (morae) return morae;
      }
    }
    return null;
  }
  // JL's marker: a line over high morae and under low ones, joined where the pitch changes.
  function appendMorae(parent, morae) {
    for (const mora of morae) {
      const span = node("span", "jl-mora", mora.text);
      span.dataset.pitch = mora.level;
      if (mora.transition) span.dataset.transition = mora.transition;
      parent.append(span);
    }
  }
  function spelling(result, candidate, morae) {
    const element = node("span", "gsm-hoshidicts-expression jl-spelling");
    if (morae) appendMorae(element, morae);
    else for (const character of result.term.expression) {
      element.append(HAN.test(character)
        ? button("gsm-hoshidicts-kanji-link", character, event => options.onKanjiClick?.(character, result, candidate, event.currentTarget))
        : document.createTextNode(character));
    }
    return element;
  }
  // JL's order: spelling, reading, audio, deconjugation, frequencies, dictionary, Anki.
  function topLine(result, dictionary, candidate, context) {
    const term = result.term;
    const line = node("div", "jl-top");
    const reading = term.reading && term.reading !== term.expression ? term.reading : "";
    // Without a reading JL marks the spelling itself, which only works for kana.
    const pitchText = reading || (HAN.test(term.expression) ? "" : term.expression);
    const morae = pitchText && context.showPitchAccentFurigana !== false
      ? pitchMorae(pitchText, term.pitches ?? [], context.pitchAccentFuriganaDictionary) : null;
    line.append(spelling(result, candidate, reading ? null : morae));
    if (reading) {
      const element = node("span", "jl-reading", morae ? null : reading);
      if (morae) appendMorae(element, morae);
      line.append(element);
    }
    const audio = components.createAudioControl(document, term.expression);
    line.append(audio.element);
    const steps = components.deinflectionSteps(result);
    const matched = result.matched || "";
    const process = steps.length ? `～${steps.map(step => step.name).join("→")}` : "";
    // JL shows the matched text, then any deconjugation, unless it is just the word.
    if (process || (matched && matched !== term.expression && matched !== term.reading)) {
      line.append(node("span", "jl-deconj", [matched, process].filter(Boolean).join(" ")));
    }
    const groups = (term.frequencies ?? []).filter(group => group.frequencies.length);
    if (groups.length) {
      const element = node("span", "jl-frequency");
      frequencies.push({ element, groups });
      line.append(element);
    }
    const actions = node("div", "gsm-hoshidicts-entry-actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Entry actions");
    line.append(dictionaryLabel(dictionary), actions);
    return { line, audio, actions };
  }
  // JL joins one sense's glosses with "; ". Structured rows keep the text layout.
  function rowText(glossary) {
    let value;
    try { value = JSON.parse(glossary); } catch { return glossary; }
    return Array.isArray(value) && value.every(item => typeof item === "string")
      ? value.join("; ").trim() : components.glossaryToPlainText(value);
  }
  // JL's JMdict layout: a tag group every row shares leads on its own line, then numbered rows.
  function definitionText(rows) {
    const items = rows.map(row => ({ groups: tagGroups(row.definitionTags), text: rowText(row.glossary) }));
    if (items.length === 1) return [brackets(items[0].groups), items[0].text].filter(Boolean).join(" ");
    const shared = items[0].groups.map((tags, group) => tags.length > 0
      && items.every(item => item.groups[group].join(" ") === tags.join(" ")));
    const lines = items.map((item, index) => {
      const own = brackets(item.groups.map((tags, group) => shared[group] ? [] : tags));
      return `${index + 1}. ${own ? `${own} ` : ""}${item.text}`;
    });
    const common = brackets(items[0].groups.filter((_, group) => shared[group]));
    return (common ? [common, ...lines] : lines).join("\n");
  }
  function appendBlock(result, dictionary, rows, candidate, context) {
    // Actions on a block mine and play only its own dictionary, as in JL.
    const projected = rows.length === result.term.glossaries.length ? result
      : { ...result, term: { ...result.term, glossaries: rows } };
    const entry = node("article", "gsm-hoshidicts-entry jl-entry");
    entry.tabIndex = -1;
    entry.dataset.dictionary = dictionary;
    const index = entries.length;
    entry.addEventListener("click", () => { selected = index; });
    const { line, audio, actions } = topLine(result, dictionary, candidate, context);
    const definitions = node("div", "gsm-hoshidicts-definitions");
    definitions.append(node("div", "gsm-hoshidicts-glossary-content", definitionText(rows)));
    const feedback = node("div", "gsm-hoshidicts-anki-feedback");
    feedback.hidden = true;
    entry.append(line, definitions, feedback);
    entries.push(entry);
    bindings.push({ audio: { button: audio.button, result: projected }, mining: { actions, feedback, result: projected } });
    scroll.append(entry);
  }
  // Like Default's tabs, core binds only the blocks the selected tab shows, so
  // keybinds and autoplay follow the tab.
  function shownBindings() {
    const bound = bindings.filter((_, index) => !entries[index].hidden);
    return { audioButtons: bound.map(item => item.audio), miningActions: bound.map(item => item.mining) };
  }
  // Tabs only hide blocks, so switching needs no render.
  function selectTab(dictionary, notify) {
    tab = dictionary;
    for (const element of tabs.children) element.setAttribute("aria-pressed", String((element.dataset.dictionary ?? null) === dictionary));
    for (const entry of entries) entry.hidden = dictionary !== null && entry.dataset.dictionary !== dictionary;
    selected = Math.max(0, entries.findIndex(entry => !entry.hidden));
    scroll.scrollTop = 0;
    if (!notify) return;
    onTabSelected?.(dictionary === null ? null : { dictionary });
    options.onResultsExpanded?.(shownBindings());
  }
  function renderTabs(dictionaries, context) {
    const all = button("jl-tab", "All", () => selectTab(null, true));
    all.title = "All dictionaries";
    tabs.append(all);
    for (const dictionary of dictionaries) {
      const element = button("jl-tab", dictionary, () => selectTab(dictionary, true));
      element.dataset.dictionary = dictionary;
      element.title = dictionary;
      labels.push(element);
      tabs.append(element);
    }
    const requested = context.selectedDictionaryTab?.dictionary;
    selectTab(dictionaries.includes(requested) ? requested : null, false);
  }

  function renderResults(results, candidate, context = {}) {
    clear();
    onTabSelected = context.onDictionaryTabSelected;
    const found = [];
    for (const result of results) {
      for (const [dictionary, rows] of Map.groupBy(result.term.glossaries, glossary => glossary.dictionary)) {
        if (!found.includes(dictionary)) found.push(dictionary);
        appendBlock(result, dictionary, rows, candidate, context);
      }
    }
    // Tabs follow the dictionary order in Settings, like JL's priority order.
    const order = (context.dictionaryPresentation ?? []).map(item => item.title);
    renderTabs([...order.filter(title => found.includes(title)), ...found.filter(title => !order.includes(title))], context);
    navigation(context);
    updateDictionaryPresentation(context);
    finish(candidate, results[0]?.matched || candidate?.query, context);
    options.onResultsRendered?.({ ...shownBindings(), lookupStats: null });
  }
  // JL's kanji text: meanings, then labelled readings and statistics.
  function renderKanji(kanji, candidate, context = {}) {
    clear();
    navigation(context);
    for (const entry of kanji.entries) {
      const lines = [components.glossaryToPlainText(entry.definitions)];
      for (const [label, value] of [["On", entry.onyomi], ["Kun", entry.kunyomi]]) {
        const readings = kanjiTokens(value);
        if (readings.length) lines.push(`${label}: ${readings.join("、")}`);
      }
      if (entry.stats?.length) lines.push("Statistics:", ...entry.stats.map(stat => `${stat.name}: ${stat.value}`));
      const block = node("article", "jl-entry jl-kanji");
      const line = node("div", "jl-top");
      line.append(node("span", "jl-spelling", kanji.character), dictionaryLabel(entry.dictionary));
      block.append(line, node("div", "jl-kanji-text", lines.filter(Boolean).join("\n")));
      scroll.append(block);
    }
    updateDictionaryPresentation(context);
    finish(candidate, context.highlightText || kanji.character, context);
  }
  function renderNotice(message, candidate, context = {}) {
    clear(); navigation(context);
    const notice = node("div", "gsm-hoshidicts-lookup-notice", message);
    notice.setAttribute("role", "status"); scroll.append(notice);
    finish(candidate, candidate?.query, context);
  }
  function renderLookupFailure(state, { preserveView = false } = {}) {
    if (!preserveView) clear();
    scroll.querySelector(".gsm-hoshidicts-lookup-failure")?.remove();
    const failure = node("div", "gsm-hoshidicts-lookup-failure", `${state.title}: ${state.detail}`);
    failure.setAttribute("role", "alert");
    if (state.onAction) failure.append(button("", state.actionLabel, state.onAction));
    scroll.append(failure); options.positionPopup();
    return failure;
  }
  return {
    scrollElement: scroll, clear, renderResults, renderKanji, renderNotice, renderLookupFailure,
    captureTermView: () => ({ expandAll: true, restoreScrollTop: scroll.scrollTop,
      selectedDictionaryTab: tab === null ? null : { dictionary: tab } }),
    currentEntryIndex: () => Math.max(0, shown().indexOf(entries[selected])),
    focusEntry(target) {
      const visible = shown();
      if (!visible.length) return false;
      let position = Math.max(0, visible.indexOf(entries[selected]));
      if (target.dictionary) {
        const found = components.findDifferentDictionary(visible, position, Math.sign(target.dictionary), scroll,
          entry => [entry], entry => entry.dataset.dictionary);
        if (!found) return false;
        position = found.index;
      } else {
        let next = position + target.offset;
        if (target === "first") next = 0;
        else if (target === "last") next = visible.length - 1;
        position = Math.max(0, Math.min(visible.length - 1, next));
      }
      selected = entries.indexOf(visible[position]);
      const scale = components.popupCoordinateScale(options.getPageZoom?.() ?? 1, options.getPopupScalePercent?.() ?? 100);
      const top = position === 0 ? 0
        : (visible[position].getBoundingClientRect().top - scroll.getBoundingClientRect().top) * scale + scroll.scrollTop;
      scroll.scrollTo({ top, behavior: "instant" });
      return true;
    },
    setDefinitionBlurState, updateDictionaryPresentation,
    setSourceHighlightEnabled(enabled) {
      highlightEnabled = enabled;
      if (!enabled) highlighter?.clear();
      else if (activeSource) highlighter?.apply(activeSource.candidate, activeSource.matched);
    },
    destroy() { clear(); popup.replaceChildren(); },
  };
}
export default { schema: 2, slug: "jl", contentMode: "text", createView };
