// SPDX-License-Identifier: GPL-3.0-or-later
// Static, local sample data; the view itself is the production popup renderer.
(function () {
  "use strict";
  const shadow = document.getElementById("preview-host").attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "render/reader.css";
  const popup = document.createElement("div");
  popup.className = "gsm-hoshidicts-popup";
  shadow.append(stylesheet, popup);
  const source = document.getElementById("preview-source");
  const candidate = { query: "食べる", sentence: source.textContent,
    sourceElements: [source], matchOffset: source.textContent.indexOf("食べる") };
  let options;
  let state;
  let sample;
  let sampleKey;
  let updateKey;
  let imageSources = null;
  let kanjiCharacter = null;
  let termView;
  let selectedDictionaryTab = null;
  let sampleMedia = null;

  function positionPopup() {
    const position = HDPopup.calculatePopupPosition(source.getBoundingClientRect(),
      { width: 560, height: 420 }, { width: innerWidth, height: innerHeight });
    for (const key of ["left", "top", "width", "height"]) popup.style[key] = `${position[key]}px`;
    view.setToolbarPosition(position.placement === "above" ? "bottom" : "top");
  }

  const view = HDPopup.createPopupView({ document, window, popup,
    appendExpressionRuby: HDGlossary.appendExpressionRuby,
    appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
    appendStructuredImage: HDGlossary.appendStructuredImage,
    parseTagList: HDGlossary.parseTagList,
    getPopupColumns: () => options.popupColumns,
    positionPopup, sourceHighlightEnabled: true,
    onKanjiClick(character) {
      termView = { ...view.captureTermView(), selectedDictionaryTab };
      kanjiCharacter = character;
      renderSample();
    },
    onAddCustomEntry() { throw new Error("This is a preview. Notes are not saved."); },
  });

  function createSample() {
    const enabled = state.dictionaries.filter(entry => entry.enabled);
    const definitions = enabled.filter(entry => entry.termCount > 0);
    const first = definitions[0]?.title || "Sample dictionary";
    const preferred = definitions.find(entry => entry.title === options.compactDefinitionSummaryDictionary)?.title;
    const second = preferred && preferred !== first ? preferred : definitions[1]?.title || "Sample usage";
    const pitch = enabled.find(entry => entry.title === options.pitchAccentFuriganaDictionary && entry.pitchCount > 0)?.title
      || enabled.find(entry => entry.pitchCount > 0)?.title || "Sample pitch";
    const glossary = (dictionary, items) => ({ dictionary, glossary: JSON.stringify(items), definitionTags: "v1 vt", termTags: "common" });
    const results = [{ matched: "食べる", deinflected: "食べる", trace: [], preprocessorSteps: 0,
      term: { expression: "食べる", reading: "たべる", rules: "v1", score: 0,
        glossaries: [
          glossary(first, ["to eat", "to live on (e.g. a salary)", "to have a meal"]),
          glossary(second, [{ type: "structured-content", content: [
            { tag: "p", content: "朝ごはんを食べる。 — To eat breakfast." },
            { tag: "img", path: "sample-meal.svg", width: 160, height: 80, title: "A bowl of rice and chopsticks" },
            { tag: "details", content: [{ tag: "summary", content: "Usage note" },
              { tag: "p", content: "食べる is an ichidan verb. Its polite form is 食べます。" }] },
          ] }]),
        ],
        frequencies: [
          { dictionary: "Sample ranks", frequencies: [{ value: 120, displayValue: "120" }, { value: 240, displayValue: "240" }] },
          { dictionary: "Sample corpus", frequencies: [{ value: 18240, displayValue: "18,240" }] },
        ],
        pitches: [{ dictionary: pitch, pitches: [{ position: 2, pattern: "LHL", nasal: [], devoice: [] }], transcriptions: ["ta̠be̞ɾɯ̟ᵝ"] }],
      } }];
    return { results, dictionaryPresentation: [
      { title: "Sample ranks", frequencyMode: "rank-based" },
      { title: "Sample corpus", frequencyMode: "occurrence-based" }, ...enabled,
    ] };
  }

  function context() {
    return { ...HDPopup.metadataOptions(options),
      showCompactDefinitionSummary: options.showCompactDefinitionSummary,
      compactDefinitionSummaryCount: options.compactDefinitionSummaryCount,
      compactDefinitionSummaryDictionary: options.compactDefinitionSummaryDictionary,
      dictionaryPresentation: sample.dictionaryPresentation,
      dictionaryTabGroups: state.groups.map(group => ({ ...group, dictionaries: group.dictionaryIds
        .map(id => state.dictionaries.find(entry => entry.id === id && entry.enabled)?.title).filter(Boolean) })),
      popupImageSources: imageSources,
      async resolveMedia(request) {
        const dictionary = imageSources === null ? request.dictionary : imageSources[0];
        if (!dictionary) throw new Error("No enabled image source in this selection.");
        request.onResolvedSource?.(dictionary);
        sampleMedia ??= fetch("sample-meal.svg").then(response => response.blob()).then(blob => URL.createObjectURL(blob));
        return sampleMedia;
      },
    };
  }

  function renderSample() {
    if (kanjiCharacter) {
      view.renderKanji({ character: kanjiCharacter, entries: [{ dictionary: "Sample kanji",
        onyomi: "ショク ジキ", kunyomi: "た.べる く.う", tags: "常用", definitions: ["eat", "food"],
        stats: [{ name: "strokes", value: "9" }, { name: "grade", value: "2" }],
      }] }, candidate, { ...context(), onBack() {
        kanjiCharacter = null;
        renderSample();
      } });
    } else {
      view.renderResults(sample.results, candidate, { ...context(),
        onDictionaryTabSelected(selection) { selectedDictionaryTab = selection; },
        selectedDictionaryTab: termView?.selectedDictionaryTab, expandAll: termView?.expandAll,
        restoreScrollTop: termView?.restoreScrollTop, restoreDisclosures: termView?.disclosures?.states,
      });
      termView = null;
    }
  }

  window.HDDesignPreview = { update(nextOptions, nextState) {
    const key = JSON.stringify([HDPopup.metadataOptions(nextOptions), nextOptions.popupColumns,
      nextOptions.showCompactDefinitionSummary, nextOptions.compactDefinitionSummaryCount,
      nextOptions.compactDefinitionSummaryDictionary, nextOptions.popupImageSource, nextState.revision]);
    if (key === updateKey) return;
    updateKey = key;
    options = { ...nextOptions };
    state = nextState;
    const nextSources = HDReaderOptions.resolvePopupImageSources(options.popupImageSource, state.dictionaries, state.groups);
    if (JSON.stringify(nextSources) !== JSON.stringify(imageSources)) imageSources = nextSources;
    const nextSample = createSample();
    const nextSampleKey = JSON.stringify(nextSample.results);
    sample = nextSample;
    if (sampleKey !== nextSampleKey) {
      sampleKey = nextSampleKey;
      renderSample();
    } else view.updateDictionaryPresentation(context());
    view.scheduleMasonry();
  } };
  stylesheet.addEventListener("load", () => view.scheduleMasonry());
  window.addEventListener("pagehide", () => view.destroy(), { once: true });
}());
