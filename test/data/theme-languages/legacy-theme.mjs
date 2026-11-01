// A theme written before languages existed, for the fallback tests of
// docs/languages.md 11.4: it uses the content hooks of the version 2
// contract (docs/themes/README.md) and nothing of 11.1, as a theme from
// elsewhere might. Test data only; it is never bundled.
// SPDX-License-Identifier: GPL-3.0-or-later
function createView(options) {
  const { document, popup, components } = options;
  const scroll = document.createElement("div");
  popup.append(scroll);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  function clear() { scroll.replaceChildren(); }
  function renderResults(results, candidate) {
    clear();
    for (const result of results) {
      const entry = node("article", "gsm-hoshidicts-entry legacy-entry");
      const expression = node("span", "gsm-hoshidicts-expression");
      for (const character of result.term.expression) {
        if (!/\p{Script=Han}/u.test(character)) {
          expression.append(character);
          continue;
        }
        const link = node("button", "gsm-hoshidicts-kanji-link", character);
        link.type = "button";
        link.addEventListener("click", event => options.onKanjiClick?.(character, result, candidate, event.currentTarget));
        expression.append(link);
      }
      const steps = components.deinflectionSteps(result);
      entry.append(expression, node("span", "legacy-trail", steps.length ? ` ～${steps.map(step => step.name).join("→")}` : ""));
      for (const [dictionary, rows] of Map.groupBy(result.term.glossaries, row => row.dictionary)) {
        const block = node("div", "legacy-block");
        block.dataset.dictionary = dictionary;
        const definitions = node("div", "gsm-hoshidicts-definitions");
        definitions.append(node("div", "legacy-label", dictionary),
          ...rows.map(row => node("div", "gsm-hoshidicts-glossary-content", components.glossaryToPlainText(row.glossary))));
        block.append(definitions);
        entry.append(block);
      }
      scroll.append(entry);
    }
    options.onResultsRendered?.({ audioButtons: [], miningActions: [], lookupStats: null });
  }
  function renderNotice(message) { clear(); scroll.append(node("div", "gsm-hoshidicts-lookup-notice", message)); }
  return {
    scrollElement: scroll, clear, renderResults, renderNotice,
    renderKanji(kanji) { clear(); scroll.append(node("div", "gsm-hoshidicts-expression", kanji.character)); },
    renderLookupFailure(state) { clear(); scroll.append(node("div", "gsm-hoshidicts-lookup-failure", state.title)); },
    captureTermView: () => ({}), currentEntryIndex: () => 0, focusEntry: () => false,
    setDefinitionBlurState() {}, setSourceHighlightEnabled() {}, updateDictionaryPresentation() {},
    destroy() { clear(); popup.replaceChildren(); },
  };
}
export default { schema: 2, slug: "legacy", contentMode: "text", createView };
