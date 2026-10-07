/*
 * The content script: Notes, scanning, activation, nested popups and media.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { buildAnkiFields } from "../../extension/anki-values.js";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_TITLE,
} from "../../extension/custom-dictionary.js";
import { lookupStatsKey } from "../../extension/lookup-stats.js";
import { EXTENSION, genericPackage, loadJsdom } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

async function staleKanjiResponseStage(invalidation) {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const dom = new JSDOM("<!doctype html><body><span id=anchor>食</span></body>", {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://example.test/",
  });
  const { window } = dom;
  window.eval(readFileSync(resolve(EXTENSION, "render/popup.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "theme-host.js"), "utf8"));
  window.fetch = async () => ({ ok: true, text: async () => "" });
  let storageListener = null;
  let initialStorageCallback = null;
  let pending = null;
  const firstSelection = { title: "Generic", kind: "term" };
  const dictionaryState = {
    schemaVersion: 1,
    revision: 1,
    dictionaries: [genericPackage()],
  };
  window.chrome = {
    runtime: {
      id: "hachidoricontentsmoke",
      lastError: null,
      getURL: (path) => `chrome-extension://hachidoricontentsmoke/${path}`,
      sendMessage(request, callback) {
        pending = { callback, request };
      },
    },
    storage: {
      local: {
        get(defaults, callback) {
          const stored = {
            ...defaults,
            dictionaryState,
            options: { ...defaults.options, kanjiClickDictionary: firstSelection, showLookupCounts: false },
          };
          if (invalidation === "initial-storage") {
            initialStorageCallback = () => callback(stored);
          } else {
            callback(stored);
          }
        },
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        },
        removeListener() {},
      },
    },
  };
  const marker = "  start();\n}());";
  const source = readFileSync(resolve(EXTENSION, "content.js"), "utf8");
  const instrumented = source.replace(marker, `
  globalThis.__hachidoriContentSmoke = {
    setState(candidate, nextPopup, nextView, nextHighlighter) {
      rootLevel.activeCandidate = candidate;
      rootLevel.activeHighlightText = "";
      rootLevel.activeTermRender = { candidate, dictionaries, generation: 0, matchedText: "食べる", renderOptions: {},
        request: { kind: "term", candidate, payload: { text: "食べる" } }, results: [{ term: { expression: "食べる", reading: "たべる" } }] };
      currentGeneration = 0;
      styleGeneration = 0;
      rootLevel.popup = nextPopup;
      rootLevel.view = nextView;
      highlighter = nextHighlighter;
      rootLevel.highlighter = nextHighlighter;
    },
    restore() {
      return restoreTermRender(rootLevel.activeTermRender, { character: "食", index: 0 }, rootLevel);
    },
    showKanji,
  };
  start();
}());`);
  if (instrumented === source) {
    return ["content.js instrumentation marker was not found"];
  }
  window.eval(readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "dictionary-group-state.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "lookup-stats-identity.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "sentence.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "word-status-overrides.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "word-highlights.js"), "utf8"));
  window.eval(instrumented);
  const anchor = window.document.getElementById("anchor");
  const popup = window.document.createElement("div");
  popup.hidden = false;
  window.document.body.appendChild(popup);
  const renders = [];
  window.__hachidoriContentSmoke.setState(
    {
      anchor,
      matchOffset: 0,
      scanEntries: [{ node: anchor.firstChild, offset: 0, sourceLength: 1, text: "食" }],
      vertical: false,
    },
    popup,
    {
      scrollElement: window.document.createElement("div"),
      clear() {},
      hideImagePreview() {},
      updateDictionaryPresentation() {},
      flushDictionaryPresentation() {},
      renderKanji(value) { renders.push(value); },
      renderResults(value) { renders.push(value); },
      setToolbarPosition() {},
    },
    { apply() {}, clear() {}, clearAll() {}, refresh() {}, scope() { return { apply() {}, clear() {}, refresh() {} }; } },
  );
  const lookup = window.__hachidoriContentSmoke.showKanji("食");
  if (invalidation === "storage-change") {
    storageListener({
      options: {
        newValue: { revision: 1, kanjiClickDictionary: { title: "Other", kind: "term" } },
      },
    }, "local");
  } else if (invalidation === "group-storage-change") {
    storageListener({
      dictionaryState: {
        newValue: {
          ...dictionaryState,
          revision: dictionaryState.revision + 1,
          groups: [{ id: "study", name: "Study", dictionaryIds: [] }],
        },
      },
    }, "local");
  } else if (invalidation === "back") {
    window.__hachidoriContentSmoke.restore();
  } else {
    initialStorageCallback();
  }
  const reply = pending.request.type === "hd_kanji"
    ? {
        generation: 0,
        kanji: { character: "食", entries: [{ dictionary: "Native" }] },
        ok: true,
        requestId: pending.request.requestId,
        type: "hd_kanji_result",
      }
    : {
        generation: 0,
        ok: true,
        requestId: pending.request.requestId,
        results: [{ term: { expression: "食", glossaries: [{ dictionary: "Generic" }] } }],
        type: "hd_lookup_dictionary_result",
      };
  pending.callback(reply);
  await lookup;
  const result = { renders, popupHidden: popup.hidden };
  dom.window.close();
  return result;
}

async function contentNoteStage() {
  const jsdom = await loadJsdom();
  if (jsdom === null) {
    return null;
  }
  const { JSDOM } = jsdom;
  const settle = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  async function createHarness(kanjiClickDictionary = { title: "Generic", kind: "term" }, { holdLookupStats = false, options: optionOverrides = {}, deferInitialStorage = false, url = "https://example.test/" } = {}) {
    const dom = new JSDOM(
      "<!doctype html><body><span id=anchor>\u98df\u3079\u305f</span></body>",
      {
        pretendToBeVisual: true,
        runScripts: "outside-only",
        url,
      },
    );
    const { window } = dom;
    const popupEvents = [];
    window.addEventListener("hachidori-popup-shown", () => popupEvents.push("shown"));
    window.addEventListener("hachidori-popup-hidden", () => popupEvents.push("hidden"));
    let storageListener = null;
    let deferredInitialStorage = null;
    const popupRecords = new Map();
    let stylesGeneration = 2;
    let holdStyles = false;
    const appliedStyles = [];
    const pending = [];
    const sent = [];
    const renders = [];
    let lookupStatsRevision = 0;

    function createView(callbacks) {
      callbacks.popup.dataset.toolbarPosition = callbacks.toolbarPosition;
      const record = {
        callbacks, editing: false, closeNext: false, closeCalls: 0,
        clearCount: 0, previewDismissals: 0, layoutSchedules: 0, renders: [], entryFocus: [],
        presentations: [], presentationFlushes: 0,
      };
      function stopEditing() {
        if (!record.editing) return;
        record.editing = false;
        callbacks.onNoteEditingChange(false);
      }
      function recordRender(render) {
        if (render.context?.preserveViewControls !== true) stopEditing();
        record.renders.push(render);
        renders.push(render);
      }
      const view = {
        scrollElement: window.document.createElement("div"),
        captureTermView: () => record.viewport,
        updateDictionaryPresentation(context) { record.presentations.push(context); },
        flushDictionaryPresentation() { record.presentationFlushes += 1; },
        hideImagePreview() { record.previewDismissals += 1; },
        currentEntryIndex: () => 0,
        focusEntry(target) {
          record.entryFocus.push(target);
          return true;
        },
        clear() {
          record.clearCount += 1;
          const wasEditing = record.editing;
          stopEditing();
          if (wasEditing) callbacks.positionPopup();
        },
        closeNoteForm() {
          record.closeCalls += 1;
          if (!record.closeNext) return false;
          record.closeNext = false;
          stopEditing();
          return true;
        },
        destroy() { record.layoutView?.destroy(); },
        scheduleMasonry() {
          record.layoutSchedules += 1;
          record.layoutWidth = callbacks.popup.style.width;
          record.layoutView?.scheduleMasonry();
        },
        setSourceHighlightEnabled(enabled) { record.highlightEnabled = enabled; },
        renderKanji(value, candidate, context) {
          recordRender({ kind: "kanji", value, candidate, context });
          view.setDefinitionBlurState(context.definitionBlurState);
        },
        renderLookupFailure(value, options = {}) {
          recordRender({
            kind: "failure",
            value,
            context: { preserveViewControls: options.preserveView === true },
          });
        },
        renderNotice(value, candidate) {
          recordRender({ kind: "notice", value, candidate, context: {} });
        },
        renderResults(results, candidate, context) {
          recordRender({ kind: "terms", results, candidate, context });
          view.setDefinitionBlurState(context.definitionBlurState);
          for (const stale of callbacks.popup.querySelectorAll(
            ".gsm-hoshidicts-lookup-stats, .gsm-hoshidicts-definitions, .gsm-hoshidicts-audio-button")) stale.remove();
          // Like the production renderer, the slot exists on every All view.
          const lookupStats = window.document.createElement("div");
          lookupStats.className = "gsm-hoshidicts-lookup-stats";
          lookupStats.hidden = true;
          const definitions = window.document.createElement("ol");
          definitions.className = "gsm-hoshidicts-definitions";
          const audioButton = window.document.createElement("button");
          audioButton.className = "gsm-hoshidicts-audio-button";
          callbacks.popup.append(lookupStats, definitions, audioButton);
          callbacks.onResultsRendered({ lookupStats,
            audioButtons: [{ button: audioButton, result: results[0] }], miningActions: [] });
        },
        setDefinitionBlurState(state) {
          record.blurState = ["pending", "blurred"].includes(state) ? state : "revealed";
          callbacks.popup.dataset.definitionBlurState = record.blurState;
          return record.blurState;
        },
        setLookupStats(element, payload, pending = false) { record.lookupStatistics = payload; element.hidden = !payload && !pending; },
        setToolbarPosition(value) { callbacks.popup.dataset.toolbarPosition = value; },
      };
      popupRecords.set(callbacks.popup, record);
      return view;
    }
    // The production splitter: popup.js's kanjiEntryGlossary reads it too.
    window.eval(readFileSync(resolve(EXTENSION, "render/glossary.js"), "utf8"));
    window.HDGlossary = {
      appendExpressionRuby() {},
      appendTextOnlyGlossary() {},
      applyDictionaryStyles(_document, _shadow, generation, styles) {
        appliedStyles.push({ generation, styles });
        return [];
      },
      parseTagList: window.HDGlossary.parseTagList,
    };
    window.eval(readFileSync(resolve(EXTENSION, "render/popup.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "theme-host.js"), "utf8"));
    window.fetch = async () => ({ ok: true, text: async () => "" });
    const createLayoutView = window.HDPopup.createPopupView;
    window.HDPopup = {
      ...window.HDPopup,
      createPopupView: createView,
      createSourceHighlighter() {
        return { apply() {}, clear() {}, clearAll() {}, refresh() {}, scope() { return { apply() {}, clear() {}, refresh() {} }; } };
      },
    };
    const initialState = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [genericPackage({
        favorite: true,
        kanjiCount: kanjiClickDictionary?.kind === "kanji" ? 1 : 0,
      })],
    };
    const runtimeListeners = new Set();
    window.chrome = {
      runtime: {
        id: "hachidoricontnotesmoke",
        onMessage: { addListener(fn) { runtimeListeners.add(fn); }, removeListener(fn) { runtimeListeners.delete(fn); } },
        lastError: null,
        getURL: (path) => `chrome-extension://hachidoricontnotesmoke/${path}`,
        sendMessage(request, callback) {
          sent.push(JSON.parse(JSON.stringify(request)));
          if (request.type === "hd_page_zoom") {
            callback({ ok: true, requestId: request.requestId, type: "hd_page_zoom_result", zoomFactor: 1 });
            return;
          }
          if (!holdLookupStats && ["hd_lookup_stats_record", "hd_lookup_stats_read"].includes(request.type)) {
            callback({ ok: true, requestId: request.requestId, type: `${request.type}_result`,
              descriptor: { generation: "statistics", revision: ++lookupStatsRevision },
              statistics: { term: request.term, reading: request.reading, lookupCount: 1 } });
            return;
          }
          if (request.type === "hd_styles" && !holdStyles) {
            callback({
              generation: stylesGeneration,
              ok: true,
              requestId: request.requestId,
              styles: [],
              type: "hd_styles_result",
            });
            return;
          }
          pending.push({ callback, request });
        },
      },
      storage: {
        local: {
          get(defaults, callback) {
            const deliver = () => callback({
              ...defaults,
              dictionaryState: initialState,
              options: {
                frequencyDictionary: "Frequency A",
                frequencyOrder: "descending",
                kanjiClickDictionary,
                maxResults: 7,
                modifier: "none",
                scanLength: 9,
                ...optionOverrides,
              },
            });
            if (deferInitialStorage) deferredInitialStorage = deliver;
            else deliver();
          },
        },
        onChanged: {
          addListener(listener) { storageListener = listener; },
          removeListener() {},
        },
      },
    };
    const marker = "  start();\n}());";
    const source = readFileSync(resolve(EXTENSION, "content.js"), "utf8");
    const instrumented = source.replace(marker, `
  globalThis.__hachidoriContentNoteSmoke = {
    async install() {
      await themeHost.sync();
      buildUi();
      uiPromise = Promise.resolve();
      currentGeneration = 1;
      styleGeneration = 1;
      return rootLevel.popup;
    },
    popupAt(depth = 0) { return levels[depth]?.popup; },
    hideTimerPending() { return hideTimer !== null; },
    cursorExitTimerPending() { return cursorExitTimer !== null; },
    setOverlayMode(value) { overlayMode = value === true; },
    selectionDragging() { return selectionDragActive; },
    viewRequest(depth = 0) { return levels[depth]?.currentViewRequest; },
    resolveCandidate,
    resolveSelectedLookupCandidate,
    resolveSelectionScanCandidate,
    resolveDefinitionCandidate(clientX, clientY, depth = 0) {
      return resolveDefinitionCandidate(clientX, clientY, levels[depth]);
    },
    setScanCandidate(candidate) { resolveCandidate = () => candidate; },
    onMouseMove,
    onPopupMouseMove(event, depth = 0) {
      return onPopupMouseMove(event, levels[depth]);
    },
    onMouseDown,
    onMouseOut,
    onWindowBlur,
    onScroll,
    onInternalLink,
    pointInsidePopup,
    onKeyDown,
    show,
    hide,
    runLookup,
    executeViewRequest(request, depth = 0, replayOptions = null) {
      return executeViewRequest(request, levels[depth], replayOptions);
    },
    scanPointer,
    scheduleHide,
    showKanji,
    teardown,
    snapshot(depth = 0) {
      const level = levels[depth];
      return {
        currentGeneration,
        styleGeneration,
        dictionaryStateRevision,
        noteEditing: level?.noteEditing === true,
        activeHighlightText: level?.activeHighlightText ?? "",
        dictionaries: dictionaries.map((dictionary) => ({ ...dictionary })),
        popupHidden: !level?.popup || level.popup.hidden === true,
      };
    },
  };
  start();
}());`);
    if (instrumented === source) {
      dom.window.close();
      throw new Error("content.js Note instrumentation marker was not found");
    }
    window.eval(readFileSync(resolve(EXTENSION, "reader-options.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "dictionary-group-state.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "lookup-stats-identity.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "sentence.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "audio-content.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "anki-content.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "word-status-overrides.js"), "utf8"));
    window.eval(readFileSync(resolve(EXTENSION, "word-highlights.js"), "utf8"));
    window.eval(instrumented);
    const driver = window.__hachidoriContentNoteSmoke;
    const popup = await driver.install();
    const popupRecord = (depth = 0) => popupRecords.get(driver.popupAt(depth));
    const anchor = window.document.getElementById("anchor");
    const anchorRange = window.document.createRange();
    anchorRange.setStart(anchor.firstChild, 0);
    anchorRange.setEnd(anchor.firstChild, 1);
    const candidate = {
      anchor,
      anchorRange,
      matchOffset: 0,
      query: "\u98df\u3079\u305f",
      scanEntries: Array.from("\u98df\u3079\u305f", (text, offset) => ({
        node: anchor.firstChild,
        offset,
        sourceLength: text.length,
        text,
      })),
      sentence: "\u98df\u3079\u305f",
      sentenceSource: "\u98df\u3079\u305f",
      sourceElements: [anchor],
      sourceOffset: 0,
      sourceText: "\u98df\u3079\u305f",
      vertical: false,
    };

    function take(type) {
      const index = pending.findIndex(({ request }) => request.type === type);
      return index < 0 ? null : pending.splice(index, 1)[0];
    }

    function reply(item, payload = {}, ok = true) {
      if (item === null) throw new Error("the expected content request was not queued");
      item.callback({
        generation: 2,
        ok,
        requestId: item.request.requestId,
        type: `${item.request.type}_result`,
        ...payload,
      });
    }

    function term(expression, dictionary = "Generic", frequencies = []) {
      return {
        matched: expression,
        term: {
          expression,
          reading: "\u3088\u307f",
          glossaries: [{ dictionary, glossary: "definition" }],
          frequencies,
        },
      };
    }

    function state(revision, displayName) {
      return {
        schemaVersion: 1,
        revision,
        dictionaries: [
          genericPackage({
            displayName,
            favorite: true,
            kanjiCount: kanjiClickDictionary?.kind === "kanji" ? 1 : 0,
          }),
          genericPackage({
            id: CUSTOM_DICTIONARY_ID,
            title: CUSTOM_DICTIONARY_TITLE,
            displayName: null,
            path: `/dicts/custom-${revision}/${CUSTOM_DICTIONARY_TITLE}`,
            revision: `custom-${revision}`,
          }),
        ],
      };
    }

    function emitState(value, nextOptions) {
      storageListener?.({ dictionaryState: { newValue: value },
        ...(nextOptions ? { options: { newValue: nextOptions } } : {}),
      }, "local");
    }

    let emittedOptionsRevision = 0;
    function emitOptions(value) {
      emittedOptionsRevision += 1;
      storageListener?.({ options: { newValue: { revision: emittedOptionsRevision, ...value } } }, "local");
    }

    function requestPayload(request) {
      const { requestId, target, ...payload } = request;
      return payload;
    }

    async function initialLookup(generation = 2) {
      const operation = driver.runLookup(candidate);
      const request = take("hd_lookup");
      reply(request, { generation, dictionaryCount: 1, results: [term(candidate.query)] });
      await operation;
      return request;
    }

    return {
      anchor,
      appliedStyles,
      candidate,
      createLayoutView(callbacks) {
        const view = createLayoutView(callbacks);
        popupRecords.get(callbacks.popup).layoutView = view;
        return view;
      },
      callbacks: (depth = 0) => popupRecord(depth).callbacks,
      close() { dom.window.close(); },
      driver,
      edit(value, depth = 0) {
        const record = popupRecord(depth);
        record.editing = value === true;
        record.callbacks.onNoteEditingChange(record.editing);
      },
      emitOptions,
      emitState,
      runtimeMessage(message) { for (const listener of runtimeListeners) listener(message, {}, () => {}); },
      entryFocus: (depth = 0) => popupRecord(depth).entryFocus,
      emitLookupStats(descriptor, row) { storageListener?.({ lookupStats: { newValue: descriptor },
        ...(row ? { [lookupStatsKey(descriptor, row)]: { newValue: row } } : {}),
      }, "local"); },
      lookupStatistics: (depth = 0) => popupRecord(depth)?.lookupStatistics,
      blurState: (depth = 0) => popupRecord(depth)?.blurState,
      deliverInitialStorage() { deferredInitialStorage?.(); deferredInitialStorage = null; },
      pageTransition(type) {
        const event = new window.Event(type);
        Object.defineProperty(event, "persisted", { value: true });
        window.dispatchEvent(event);
      },
      hoverDefinitions(depth = 0) {
        popupRecord(depth).callbacks.popup.querySelector(".gsm-hoshidicts-definitions")
          .dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
      },
      initialLookup,
      internalLink(link, depth = 0) {
        const record = popupRecord(depth);
        const anchor = window.document.createElement("a");
        anchor.href = "#";
        anchor.textContent = link.query;
        record.callbacks.popup.appendChild(anchor);
        return record.renders.at(-1).context.onInternalLink({ ...link, anchor });
      },
      pending,
      popup,
      popupEvents,
      render: (depth = 0) => popupRecord(depth)?.renders.at(-1),
      setTermViewport(value) { popupRecord().viewport = value; },
      presentations: (depth = 0) => popupRecord(depth)?.presentations,
      presentationFlushes: (depth = 0) => popupRecord(depth)?.presentationFlushes,
      renders,
      reply,
      requestPayload,
      sent,
      settle,
      state,
      stats(depth = 0) {
        const { clearCount, closeCalls, previewDismissals, layoutSchedules, layoutWidth, highlightEnabled } = popupRecord(depth);
        return { clearCount, closeCalls, previewDismissals, layoutSchedules, layoutWidth, highlightEnabled };
      },
      take,
      term,
      setCloseNext(value, depth = 0) { popupRecord(depth).closeNext = value === true; },
      setStylesGeneration(value) { stylesGeneration = value; },
      setHoldStyles() { holdStyles = true; },
      installMediaClock() {
        const timers = new Map();
        const originalSetTimeout = window.setTimeout.bind(window);
        const originalClearTimeout = window.clearTimeout.bind(window);
        let nextTimerId = -1;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay !== 4000) return originalSetTimeout(callback, delay, ...args);
          const id = nextTimerId--;
          timers.set(id, callback);
          return id;
        };
        window.clearTimeout = (id) => {
          if (!timers.delete(id)) originalClearTimeout(id);
        };
        return {
          size: () => timers.size,
          expireFirst() {
            const first = timers.entries().next().value;
            if (!first) return false;
            timers.delete(first[0]);
            first[1]();
            return true;
          },
        };
      },
    };
  }

  const probe = await createHarness();
  const callbacksWired = typeof probe.callbacks()?.onAddCustomEntry === "function"
    && typeof probe.callbacks()?.onNoteEditingChange === "function";
  probe.emitOptions({ revision: 4, maxResults: 50 });
  probe.emitOptions({ revision: 2, maxResults: 2 });
  probe.emitOptions({ revision: 4, maxResults: 3 });
  const newestOnlyOptions = (await probe.initialLookup()).request.maxResults === 50;
  probe.close();
  if (!callbacksWired) return { callbacksWired };

  async function popupVisibilityCase() {
    const harness = await createHarness();
    try {
      harness.driver.show(harness.candidate);
      harness.driver.show(harness.candidate);
      harness.driver.hide();
      harness.driver.hide();
      harness.driver.show(harness.candidate);
      harness.driver.teardown("popup-visibility-test");
      return JSON.stringify(harness.popupEvents) === JSON.stringify(["shown", "hidden", "shown", "hidden"]);
    } finally {
      harness.close();
    }
  }

  async function lookupStatisticsCase() {
    const outcomes = {
      "accepted primary views record once across tabs, expansion, Note refresh and Back": false,
      "internal links and clicked-kanji terms record independently while misses and stale replies do not": false,
      "statistics reject obsolete namespace replies and never retry a failed increment": false,
      "a count on its way keeps its slot until it paints, and a count that will not arrive hides it": false,
    };
    const harness = await createHarness(undefined, { holdLookupStats: true });
    const records = () => harness.sent.filter(request => request.type === "hd_lookup_stats_record");
    const answer = (item, count, generation = "statistics", revision = count) => harness.reply(item, {
      descriptor: { generation, revision }, statistics: { term: item.request.term, reading: item.request.reading, lookupCount: count },
    });
    const lookup = async (expression = "食べる") => {
      const operation = harness.driver.runLookup(harness.candidate);
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term(expression)] });
      await operation;
    };
    const rebind = () => harness.callbacks().onResultsRendered({
      lookupStats: harness.popup.querySelector(".gsm-hoshidicts-lookup-stats"), audioButtons: [], miningActions: [],
    });
    try {
      await lookup();
      const first = harness.take("hd_lookup_stats_record");
      if (!first) return outcomes;
      harness.emitLookupStats({ generation: "statistics", revision: 1 });
      answer(first, 1);
      await harness.settle();
      const canonical = first.request.term === "食べる" && first.request.reading === "よみ"
        && harness.lookupStatistics()?.lookupCount === 1;
      harness.render().context.onDictionaryTabSelected({ dictionary: "Generic" });
      rebind(); rebind();
      harness.edit(true);
      const append = harness.callbacks().onAddCustomEntry({ term: "食べる", reading: "よみ", definition: "eat" });
      harness.reply(harness.take("hd_custom_append"), { document: { revision: 2, text: "", semanticRevision: "two" }, state: harness.state(2, "Note") });
      await harness.settle();
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("食べる")] });
      await append;
      const noteCount = records().length;
      const clicked = harness.driver.showKanji("食");
      harness.reply(harness.take("hd_lookup_dictionary"), { dictionaryCount: 1, results: [harness.term("食")] });
      await clicked;
      const clickedCount = harness.take("hd_lookup_stats_record");
      if (!clickedCount) return outcomes;
      answer(clickedCount, 2);
      await harness.settle();
      await harness.render().context.onBack();
      outcomes[Object.keys(outcomes)[0]] = canonical && noteCount === 1 && records().length === 2
        && harness.lookupStatistics()?.lookupCount === 1;

      const link = harness.internalLink({ query: "内部", primaryReading: "ないぶ" });
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term("内部")] });
      await link;
      const linkedCount = harness.take("hd_lookup_stats_record");
      if (!linkedCount) return outcomes;
      answer(linkedCount, 3);
      await harness.settle();
      const miss = harness.driver.runLookup(harness.candidate);
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [] });
      await miss;
      const stale = harness.driver.runLookup(harness.candidate);
      const oldLookup = harness.take("hd_lookup");
      await lookup("現在");
      const currentCount = harness.take("hd_lookup_stats_record");
      if (!currentCount) return outcomes;
      answer(currentCount, 4);
      harness.reply(oldLookup, { dictionaryCount: 1, results: [harness.term("古い")] });
      await stale;
      outcomes[Object.keys(outcomes)[1]] = clickedCount.request.term === "食" && linkedCount.request.term === "内部" && records().length === 4;

      await lookup("復元");
      const oldCount = harness.take("hd_lookup_stats_record");
      harness.emitLookupStats({ generation: "restored", revision: 10 });
      answer(oldCount, 99, "statistics", 5);
      await harness.settle();
      const restored = harness.take("hd_lookup_stats_read");
      if (!restored) return outcomes;
      answer(restored, 0, "restored", 10);
      await harness.settle();
      const replaced = harness.lookupStatistics()?.lookupCount === 0 && records().length === 5;
      await lookup("失敗");
      const failed = harness.take("hd_lookup_stats_record");
      harness.reply(failed, { error: "lost committed reply" }, false);
      await harness.settle();
      rebind(); rebind();
      outcomes[Object.keys(outcomes)[2]] = replaced && records().length === 6 && !harness.take("hd_lookup_stats_record");
    } finally { harness.close(); }
    return outcomes;
  }

  async function lookupStatisticsRaceCase() {
    const outcomes = {};
    const harness = await createHarness(null, { holdLookupStats: true });
    try {
      await harness.initialLookup();
      const pending = harness.take("hd_lookup_stats_record");
      const row = { term: pending.request.term, reading: pending.request.reading, lookupCount: 2 };
      harness.emitLookupStats({ generation: "statistics", revision: 2 }, row);
      harness.reply(pending, { descriptor: { generation: "statistics", revision: 1 }, statistics: { ...row, lookupCount: 1 } });
      await harness.settle();
      const matchingEventWon = harness.lookupStatistics()?.lookupCount === 2;
      harness.emitLookupStats({ generation: "statistics", revision: 4 }, { ...row, term: "別の言葉", lookupCount: 1 });
      const reads = harness.sent.filter(request => request.type === "hd_lookup_stats_read");
      outcomes["matching row events outrank old count replies without refreshing unrelated terms"] =
        matchingEventWon && harness.lookupStatistics()?.lookupCount === 2 && reads.length === 0;
      harness.emitLookupStats({ generation: "statistics", revision: 3 }, { ...row, lookupCount: 3 });
      outcomes["delayed matching rows survive newer unrelated global revisions"] =
        harness.lookupStatistics()?.lookupCount === 3 && reads.length === 0;
      // Show more rebinds only the newly revealed audio and mining controls.
      harness.callbacks().onResultsExpanded({ audioButtons: [], miningActions: [] });
      harness.emitLookupStats({ generation: "statistics", revision: 5 }, { ...row, lookupCount: 4 });
      outcomes["expanding results keeps the count element for later row events"] =
        harness.lookupStatistics()?.lookupCount === 4 && !harness.popup.querySelector(".gsm-hoshidicts-lookup-stats").hidden;
      harness.edit(true);
      const retainedLine = harness.popup.querySelector(".gsm-hoshidicts-lookup-stats");
      harness.emitState(harness.state(2, "Replacement"));
      harness.emitOptions({ showLookupCounts: false });
      outcomes["turning counts off hides the existing line even in a retained Note view"] =
        retainedLine === harness.popup.querySelector(".gsm-hoshidicts-lookup-stats")
        && retainedLine.hidden;
    } finally { harness.close(); }
    const toggled = await createHarness(null, { holdLookupStats: true });
    try {
      await toggled.initialLookup();
      const pending = toggled.take("hd_lookup_stats_record");
      toggled.emitOptions({ showLookupCounts: false });
      toggled.emitOptions({ showLookupCounts: true });
      toggled.reply(pending, { descriptor: { generation: null, revision: 0 }, statistics: null });
      await toggled.settle();
      const repair = toggled.take("hd_lookup_stats_read");
      if (repair) toggled.reply(repair, { descriptor: { generation: null, revision: 0 },
        statistics: { term: pending.request.term, reading: pending.request.reading, lookupCount: 0 } });
      await toggled.settle();
      outcomes["an Off reply arriving after On repairs with one read and never another increment"] =
        Boolean(repair) && toggled.lookupStatistics()?.lookupCount === 0
        && toggled.sent.filter(request => request.type === "hd_lookup_stats_record").length === 1
        && toggled.sent.filter(request => request.type === "hd_lookup_stats_read").length === 1;
      toggled.emitOptions({ corpusSeenEnabled: true, corpusSeenUrl: "http://127.0.0.1:7275" });
      await toggled.settle();
      outcomes["obsolete external-count options do not refresh the retained local count"] =
        toggled.lookupStatistics()?.lookupCount === 0
        && toggled.sent.filter(request => request.type === "hd_lookup_stats_read").length === 1;
      toggled.emitLookupStats({ generation: "statistics", revision: 1 },
        { term: pending.request.term, reading: pending.request.reading, lookupCount: 1 });
      outcomes["matching row events update the local count without another read"] =
        toggled.lookupStatistics()?.lookupCount === 1
        && toggled.sent.filter(request => request.type === "hd_lookup_stats_read").length === 1;
    } finally { toggled.close(); }
    const hidden = await createHarness(null, { holdLookupStats: true, options: { showLookupCounts: false } });
    try {
      await hidden.initialLookup();
      const slot = () => hidden.popup.querySelector(".gsm-hoshidicts-lookup-stats");
      const offVisit = hidden.take("hd_lookup_stats_record") === null && slot()?.hidden === true;
      const rendersBefore = hidden.renders.length;
      hidden.emitOptions({ showLookupCounts: true });
      const read = hidden.take("hd_lookup_stats_read");
      if (read) hidden.reply(read, { descriptor: { generation: "statistics", revision: 1 },
        statistics: { term: read.request.term, reading: read.request.reading, lookupCount: 4 } });
      await hidden.settle();
      outcomes["enabling counts paints the open popup's hidden slot with one read and no rerender"] =
        offVisit && Boolean(read) && hidden.lookupStatistics()?.lookupCount === 4 && slot()?.hidden === false
        && hidden.take("hd_lookup_stats_record") === null && hidden.renders.length === rendersBefore;
    } finally { hidden.close(); }
    // The slot keeps the count's place from the first render (#486), so its
    // arrival moves nothing; a count that will not arrive takes the place away.
    const kept = await createHarness(null, { holdLookupStats: true });
    try {
      const slot = () => kept.popup.querySelector(".gsm-hoshidicts-lookup-stats");
      const onItsWay = () => slot()?.hidden === false && kept.lookupStatistics() === null;
      await kept.initialLookup();
      const counted = kept.take("hd_lookup_stats_record");
      const keptFirst = onItsWay();
      if (counted) kept.reply(counted, { descriptor: { generation: "statistics", revision: 1 },
        statistics: { term: counted.request.term, reading: counted.request.reading, lookupCount: 3 } });
      await kept.settle();
      const painted = slot()?.hidden === false && kept.lookupStatistics()?.lookupCount === 3;
      await kept.initialLookup();
      const lost = kept.take("hd_lookup_stats_record");
      const keptAgain = onItsWay();
      if (lost) kept.reply(lost, { error: "lost reply" }, false);
      await kept.settle();
      outcomes["a count on its way keeps its slot until it paints, and a count that will not arrive hides it"] =
        (Boolean(counted) && keptFirst && painted && Boolean(lost) && keptAgain && slot()?.hidden === true)
        || { counted: Boolean(counted), keptFirst, painted, lost: Boolean(lost), keptAgain, hidden: slot()?.hidden };
    } finally { kept.close(); }
    return outcomes;
  }

  async function ankiMaturityBlurCase() {
    const outcomes = {};
    const options = { showLookupCounts: false, definitionBlurAnkiMature: true, definitionBlurReveal: "hover",
      audioAutoplay: true, anki: { model: "Mining", fields: { expression: "Expression" } } };
    const harness = await createHarness(null, { holdLookupStats: true, options });
    const plays = () => harness.sent.filter(request => request.type === "hd_audio_play").length;
    const lookup = async expression => {
      const operation = harness.driver.runLookup(harness.candidate);
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term(expression)] });
      await operation;
      return harness.take("hd_anki_maturity");
    };
    try {
      const mature = await lookup("成熟");
      const pending = mature?.request.target === "hachidori-anki" && harness.blurState() === "pending"
        && !harness.sent.some(request => request.type === "hd_lookup_stats_record") && plays() === 0;
      harness.reply(mature, { mature: true });
      await harness.settle();
      const blurred = harness.blurState() === "blurred" && plays() === 0;
      harness.hoverDefinitions();
      harness.callbacks().onBeforeResultsRendered();
      const button = harness.popup.ownerDocument.createElement("button");
      harness.popup.append(button);
      harness.callbacks().onResultsRendered({ lookupStats: harness.popup.querySelector(".gsm-hoshidicts-lookup-stats"),
        audioButtons: [{ button, result: harness.term("成熟") }], miningActions: [] });
      outcomes["Anki maturity blurs without counts, plays the held result on hover reveal and never replays it on rebind"] =
        pending && blurred && harness.blurState() === "revealed" && plays() === 1;

      harness.reply(await lookup("若い"), { mature: false });
      await harness.settle();
      const young = harness.blurState() === "revealed" && plays() === 2;
      harness.reply(await lookup("オフライン"), { error: "Anki unavailable" }, false);
      await harness.settle();
      outcomes["nonmature and unavailable Anki fail open and release autoplay once"] =
        young && harness.blurState() === "revealed" && plays() === 3;

      const stale = await lookup("古い"), current = await lookup("現在");
      harness.reply(stale, { mature: true });
      await harness.settle();
      const untouched = harness.blurState() === "pending" && plays() === 3;
      harness.reply(current, { mature: false });
      await harness.settle();
      outcomes["a retired lookup's Anki result cannot settle the current lookup's blur or autoplay"] =
        untouched && harness.blurState() === "revealed" && plays() === 4;

      const changed = await lookup("設定");
      harness.emitOptions({ ...options, anki: { ...options.anki, model: "Other" } });
      harness.reply(changed, { mature: true });
      await harness.settle();
      outcomes["changing the Anki mapping releases a pending visit and rejects its late mature result"] =
        harness.blurState() === "revealed" && plays() === 5;

      const combined = { ...options, showLookupCounts: true, definitionBlurCountEnabled: true, definitionBlurThreshold: 5 };
      harness.emitOptions(combined);
      const byCount = await lookup("回数");
      const count = harness.take("hd_lookup_stats_record");
      harness.reply(count, { descriptor: { generation: "statistics", revision: 1 },
        statistics: { term: count.request.term, reading: count.request.reading, lookupCount: 5 } });
      await harness.settle();
      const countWins = harness.blurState() === "blurred" && plays() === 5;
      harness.reply(byCount, { mature: false });
      await harness.settle();
      const byAnki = await lookup("暗記");
      const lowCount = harness.take("hd_lookup_stats_record");
      harness.reply(lowCount, { descriptor: { generation: "statistics", revision: 2 },
        statistics: { term: lowCount.request.term, reading: lowCount.request.reading, lookupCount: 1 } });
      await harness.settle();
      const waiting = harness.blurState() === "pending" && plays() === 5;
      harness.reply(byAnki, { mature: true });
      await harness.settle();
      outcomes["either the first count or Anki maturity qualifies without waiting for the other signal"] =
        countWins && waiting && harness.blurState() === "blurred" && plays() === 5;

      const firstCount = await lookup("最初");
      const firstCountRequest = harness.take("hd_lookup_stats_record");
      harness.reply(firstCountRequest, { descriptor: { generation: "statistics", revision: 3 },
        statistics: { term: firstCountRequest.request.term, reading: firstCountRequest.request.reading, lookupCount: 1 } });
      await harness.settle();
      harness.emitLookupStats({ generation: "statistics", revision: 4 },
        { term: firstCountRequest.request.term, reading: firstCountRequest.request.reading, lookupCount: 9 });
      harness.reply(firstCount, { mature: false });
      await harness.settle();
      outcomes["waiting for Anki preserves the first count's autoplay decision despite later row events"] =
        harness.blurState() === "revealed" && plays() === 6;
    } finally { harness.close(); }

    const early = await createHarness(null, { deferInitialStorage: true, options: { ...options,
      frequencyDictionary: "", frequencyOrder: "auto", scanLength: 16, maxResults: 32, kanjiClickDictionary: "" } });
    try {
      // Hydrate dictionary identity separately so the late options do not
      // correctly retire this lookup for an unrelated dictionary/ranking edit.
      early.emitState({ schemaVersion: 1, revision: 1, dictionaries: [genericPackage({ favorite: true })] });
      await early.initialLookup();
      const pending = early.blurState() === "pending" && !early.take("hd_anki_maturity");
      early.deliverInitialStorage();
      await early.settle();
      early.reply(early.take("hd_anki_maturity"), { mature: true });
      await early.settle();
      outcomes["a lookup before initial options waits for its Anki maturity setting"] =
        pending && !!early.driver.viewRequest() && early.blurState() === "blurred"
        && !early.sent.some(request => request.type === "hd_audio_play");
    } finally { early.close(); }

    for (const held of [false, true]) {
      const navigation = await createHarness({ title: "Generic", kind: "kanji" }, { options });
      try {
        await navigation.initialLookup();
        const query = navigation.take("hd_anki_maturity");
        if (!held) { navigation.reply(query, { mature: true }); await navigation.settle(); }
        const showKanji = async () => {
          const operation = navigation.driver.showKanji("食");
          navigation.reply(navigation.take("hd_kanji"), {
            kanji: { character: "食", entries: [{ dictionary: "Generic", meanings: ["eat"] }] } });
          await operation;
        };
        await showKanji();
        await navigation.render().context.onBack();
        const retained = navigation.blurState() === (held ? "pending" : "blurred")
          && !navigation.take("hd_anki_maturity");
        await showKanji();
        navigation.emitOptions({ ...options, kanjiClickDictionary: { title: "Generic", kind: "kanji" },
          anki: { ...options.anki, model: "Other" } });
        if (held) { navigation.reply(query, { mature: true }); await navigation.settle(); }
        await navigation.render().context.onBack();
        outcomes[`Back keeps the visit but rejects ${held ? "pending" : "completed"} Anki evidence after a parked mapping edit`] =
          retained && navigation.blurState() === "revealed" && !navigation.take("hd_anki_maturity");
      } finally { navigation.close(); }
    }
    return outcomes;
  }

  async function frequencyDefinitionBlurCase() {
    const outcomes = {};
    const frequencyGroup = (dictionary, values) => [{
      dictionary,
      frequencies: values.map(value => ({ value, displayValue: `display-${value}` })),
    }];
    const state = (revision, kanji = false) => ({ schemaVersion: 1, revision, dictionaries: [
      genericPackage({ favorite: true, kanjiCount: kanji ? 1 : 0 }),
      genericPackage({ id: "rank", title: "Rank", termCount: 0, frequencyCount: 2, frequencyMode: "rank-based" }),
      genericPackage({ id: "occurrence", title: "Occurrence", termCount: 0, frequencyCount: 2,
        frequencyMode: "occurrence-based" }),
    ] });
    let activeOptions = {
      showLookupCounts: false,
      definitionBlurCountEnabled: false,
      definitionBlurAnkiMature: false,
      definitionBlurFrequencyEnabled: true,
      definitionBlurFrequencyDictionary: "Rank",
      definitionBlurFrequencyOrder: "auto",
      definitionBlurFrequencyThreshold: 120,
      definitionBlurReveal: "hover",
      definitionBlurDelayMs: 1000,
      audioAutoplay: true,
    };
    const harness = await createHarness(null, { holdLookupStats: true, options: activeOptions });
    const plays = () => harness.sent.filter(request => request.type === "hd_audio_play").length;
    const editOptions = patch => {
      activeOptions = { ...activeOptions, ...patch };
      harness.emitOptions(activeOptions);
    };
    const lookup = async (expression, frequencies) => {
      const operation = harness.driver.runLookup(harness.candidate);
      harness.reply(harness.take("hd_lookup"), {
        dictionaryCount: 3,
        results: [harness.term(expression, "Generic", frequencies)],
      });
      await operation;
    };
    try {
      harness.emitState(state(2));
      await lookup("順位", frequencyGroup("Rank", [120, 240]));
      const runtimeTypes = harness.sent.map(request => request.type);
      const immediate = harness.blurState() === "blurred" && harness.render().context.definitionBlurState === "blurred"
        && plays() === 0;
      harness.hoverDefinitions();
      outcomes["a qualifying native rank blurs immediately and introduces no statistics, Anki or frequency request"] =
        immediate && harness.blurState() === "revealed" && plays() === 1
        && !runtimeTypes.some(type => type.startsWith("hd_lookup_stats") || type === "hd_anki_maturity"
          || type.includes("frequency"));

      await lookup("境界外", frequencyGroup("Rank", [121]));
      outcomes["a nonqualifying frequency fails open and releases autoplay without pending evidence"] =
        harness.blurState() === "revealed" && plays() === 2;

      editOptions({ definitionBlurFrequencyDictionary: "Occurrence",
        definitionBlurFrequencyThreshold: 10000 });
      await lookup("出現", frequencyGroup("Occurrence", [9000, 10000]));
      const occurrenceBlurred = harness.blurState() === "blurred" && plays() === 2;
      editOptions({ definitionBlurFrequencyThreshold: 10001 });
      const editedOpen = harness.blurState() === "revealed" && plays() === 3;
      editOptions({ definitionBlurFrequencyThreshold: 10000 });
      await lookup("再判定", frequencyGroup("Occurrence", [9000, 10000]));
      const secondOccurrenceBlurred = harness.blurState() === "blurred" && plays() === 3;
      editOptions({ definitionBlurAnkiMature: true, definitionBlurFrequencyThreshold: 10001 });
      const liveMaturity = harness.take("hd_anki_maturity");
      const waitsForLiveMaturity = Boolean(liveMaturity) && harness.blurState() === "pending";
      harness.reply(liveMaturity, { mature: true });
      await harness.settle();
      const liveMaturityBlurred = harness.blurState() === "blurred" && plays() === 3;
      editOptions({ definitionBlurAnkiMature: false });
      editOptions({ definitionBlurFrequencyThreshold: 1 });
      outcomes["occurrence auto order uses the inclusive maximum and live edits start pending evidence without reblurring a revealed visit"] =
        occurrenceBlurred && editedOpen && secondOccurrenceBlurred && waitsForLiveMaturity
        && liveMaturityBlurred && harness.blurState() === "revealed" && plays() === 4;

      editOptions({
        showLookupCounts: true,
        definitionBlurCountEnabled: true,
        definitionBlurThreshold: 5,
        definitionBlurFrequencyDictionary: "Rank",
        definitionBlurFrequencyThreshold: 100,
      });
      const playsBeforeCount = plays();
      await lookup("併用", frequencyGroup("Rank", [200]));
      const countRequest = harness.take("hd_lookup_stats_record");
      const waitsForCount = Boolean(countRequest) && harness.blurState() === "pending" && plays() === playsBeforeCount;
      harness.reply(countRequest, { descriptor: { generation: "statistics", revision: 1 },
        statistics: { term: countRequest.request.term, reading: countRequest.request.reading, lookupCount: 5 } });
      await harness.settle();
      outcomes["a nonqualifying frequency retains the existing pending count decision and either condition can qualify"] =
        waitsForCount && harness.blurState() === "blurred" && plays() === playsBeforeCount;

      editOptions({
        showLookupCounts: false,
        definitionBlurCountEnabled: false,
        definitionBlurFrequencyDictionary: "Rank",
        definitionBlurFrequencyThreshold: 120,
      });
      await lookup("更新", frequencyGroup("Rank", [120]));
      const lookupRequestsBeforeNote = harness.sent.filter(request => request.type === "hd_lookup").length;
      const ankiRequestsBeforeNote = harness.sent.filter(request => request.type === "hd_anki_maturity").length;
      harness.edit(true);
      const append = harness.callbacks().onAddCustomEntry({ term: "更新", reading: "よみ", definition: "updated" });
      harness.reply(harness.take("hd_custom_append"), {
        document: { revision: 2, text: "", semanticRevision: "two" },
        state: harness.state(3, "Note"),
      });
      await harness.settle();
      const refresh = harness.take("hd_lookup");
      harness.reply(refresh, { dictionaryCount: 3, results: [harness.term("更新")] });
      await append;
      const afterRefresh = harness.blurState() === "blurred"
        && harness.sent.filter(request => request.type === "hd_lookup").length === lookupRequestsBeforeNote + 1;
      harness.render().context.onDictionaryTabSelected({ dictionary: "Generic" });
      harness.callbacks().onResultsRendered({
        lookupStats: harness.popup.querySelector(".gsm-hoshidicts-lookup-stats"),
        audioButtons: [],
        miningActions: [],
      });
      outcomes["Note refresh and dictionary tabs reuse the request's frequency snapshot without a new evidence request"] =
        afterRefresh && harness.blurState() === "blurred"
        && harness.sent.filter(request => request.type === "hd_anki_maturity").length === ankiRequestsBeforeNote;
    } finally { harness.close(); }

    const navigation = await createHarness({ title: "Generic", kind: "kanji" }, {
      holdLookupStats: true,
      options: { ...activeOptions, showLookupCounts: false, definitionBlurCountEnabled: false,
        definitionBlurFrequencyDictionary: "Rank", definitionBlurFrequencyThreshold: 120, audioAutoplay: false },
    });
    try {
      navigation.emitState(state(2, true));
      const operation = navigation.driver.runLookup(navigation.candidate);
      navigation.reply(navigation.take("hd_lookup"), {
        dictionaryCount: 3,
        results: [navigation.term("戻る", "Generic", frequencyGroup("Rank", [120]))],
      });
      await operation;
      const lookups = navigation.sent.filter(request => request.type === "hd_lookup").length;
      const showKanji = navigation.driver.showKanji("食");
      navigation.reply(navigation.take("hd_kanji"), {
        kanji: { character: "食", entries: [{ dictionary: "Generic", meanings: ["eat"] }] },
      });
      await showKanji;
      const nativeRevealed = navigation.blurState() === "revealed";
      await navigation.render().context.onBack();
      outcomes["native kanji stays unblurred and Back restores the same frequency-qualified visit without another lookup"] =
        nativeRevealed && navigation.blurState() === "blurred"
        && navigation.sent.filter(request => request.type === "hd_lookup").length === lookups;
    } finally { navigation.close(); }
    return outcomes;
  }

  async function definitionBlurCase() {
    const outcomes = {};
    const wait = ms => new Promise(done => setTimeout(done, ms));
    const blurOptions = { showLookupCounts: true, definitionBlurCountEnabled: true, definitionBlurDirection: "atLeast",
      definitionBlurThreshold: 5, definitionBlurReveal: "hover", definitionBlurDelayMs: 1000, audioAutoplay: true };
    const harness = await createHarness(null, { holdLookupStats: true, options: blurOptions });
    const plays = () => harness.sent.filter(request => request.type === "hd_audio_play").length;
    const lookup = async expression => {
      const operation = harness.driver.runLookup(harness.candidate);
      harness.reply(harness.take("hd_lookup"), { dictionaryCount: 1, results: [harness.term(expression)] });
      await operation;
      return harness.take("hd_lookup_stats_record");
    };
    const answer = (item, lookupCount, revision = lookupCount) => harness.reply(item, {
      descriptor: { generation: "statistics", revision },
      statistics: { term: item.request.term, reading: item.request.reading, lookupCount },
    });
    try {
      const first = await lookup("五回");
      const held = Boolean(first) && harness.blurState() === "pending" && plays() === 0
        && harness.render().context.definitionBlurState === "pending";
      answer(first, 5);
      await harness.settle();
      outcomes["a qualifying count blurs pending definitions and keeps autoplay held"] =
        held && harness.blurState() === "blurred" && plays() === 0;
      // A dictionary tab rebinds the first result under a new autoplay key.
      const retab = () => {
        const button = harness.popup.ownerDocument.createElement("button");
        harness.popup.append(button);
        harness.callbacks().onResultsRendered({ lookupStats: harness.popup.querySelector(".gsm-hoshidicts-lookup-stats"),
          audioButtons: [{ button, result: harness.term("五回") }], miningActions: [] });
      };
      harness.render().context.onDictionaryTabSelected({ dictionary: "Generic" });
      retab();
      const blurredTabSilent = plays() === 0;
      harness.hoverDefinitions();
      harness.render().context.onDictionaryTabSelected(null);
      retab();
      outcomes["a blurred lookup stays silent across dictionary tabs and a hover reveal plays the current tab once"] =
        blurredTabSilent && plays() === 1;
      harness.hoverDefinitions();
      const revealed = harness.blurState() === "revealed";
      harness.emitLookupStats({ generation: "statistics", revision: 6 },
        { term: first.request.term, reading: first.request.reading, lookupCount: 6 });
      outcomes["hovering definitions reveals and a later count never reblurs or plays again"] =
        revealed && harness.blurState() === "revealed" && plays() === 1;

      const second = await lookup("一回");
      const heldAgain = harness.blurState() === "pending" && plays() === 1;
      answer(second, 1);
      await harness.settle();
      outcomes["a non-qualifying count reveals and releases one held autoplay"] =
        heldAgain && harness.blurState() === "revealed" && plays() === 2;

      const third = await lookup("失敗");
      harness.reply(third, { error: "lost committed reply" }, false);
      await harness.settle();
      outcomes["an unavailable count fails open and releases autoplay"] =
        harness.blurState() === "revealed" && plays() === 3;

      harness.emitOptions({ ...blurOptions, definitionBlurDirection: "below", definitionBlurThreshold: 3 });
      const fourth = await lookup("零回");
      answer(fourth, 0);
      await harness.settle();
      const belowBlurred = harness.blurState() === "blurred" && plays() === 3;
      harness.emitOptions({ ...blurOptions, definitionBlurDirection: "below", definitionBlurThreshold: 3, definitionBlurCountEnabled: false });
      outcomes["Below blurs a zero count and disabling blur reveals and plays the held result"] =
        belowBlurred && harness.blurState() === "revealed" && plays() === 4;

      // A retained view replays the same request while its decision is pending:
      // retiring the level must not spend the held first visit.
      harness.emitOptions({ ...blurOptions });
      const replayed = await lookup("再生");
      harness.callbacks().onBeforeResultsRendered();
      const replayButton = harness.popup.ownerDocument.createElement("button");
      harness.popup.append(replayButton);
      harness.callbacks().onResultsRendered({ lookupStats: harness.popup.querySelector(".gsm-hoshidicts-lookup-stats"),
        audioButtons: [{ button: replayButton, result: harness.term("再生") }], miningActions: [] });
      const replayHeld = plays() === 4;
      answer(replayed, 1, 8);
      await harness.settle();
      outcomes["retiring a held view before its replay keeps the first visit for the decision"] =
        replayHeld && harness.blurState() === "revealed" && plays() === 5;

      // A stale lookup's late count must not settle the current lookup's autoplay.
      const stale = await lookup("古い");
      const current = await lookup("現在");
      answer(stale, 9, 9);
      await harness.settle();
      const currentStillPending = harness.blurState() === "pending" && plays() === 5;
      answer(current, 1, 10);
      await harness.settle();
      outcomes["a stale lookup's late qualifying count leaves the current lookup's autoplay to its own count"] =
        currentStillPending && harness.blurState() === "revealed" && plays() === 6;
    } finally { harness.close(); }

    const timed = await createHarness(undefined, { holdLookupStats: true,
      options: { ...blurOptions, definitionBlurReveal: "timed", audioAutoplay: false } });
    try {
      const shown = Date.now();
      await timed.initialLookup();
      const pending = timed.take("hd_lookup_stats_record");
      timed.reply(pending, { descriptor: { generation: "statistics", revision: 1 },
        statistics: { term: pending.request.term, reading: pending.request.reading, lookupCount: 9 } });
      await timed.settle();
      const blurred = timed.blurState() === "blurred";
      // Navigate away and back: the original deadline continues, not a new one.
      await wait(250);
      const clicked = timed.driver.showKanji("食");
      timed.reply(timed.take("hd_lookup_dictionary"), { dictionaryCount: 1, results: [timed.term("食")] });
      await clicked;
      const kanjiPending = timed.take("hd_lookup_stats_record");
      if (kanjiPending) timed.reply(kanjiPending, { descriptor: { generation: "statistics", revision: 2 },
        statistics: { term: "食", reading: "よみ", lookupCount: 0 } });
      await timed.settle();
      const clickedRevealed = timed.blurState() === "revealed";
      await wait(250);
      await timed.render().context.onBack();
      const backBlurred = timed.blurState() === "blurred";
      await wait(Math.max(0, shown + 1000 - Date.now()) + 300);
      outcomes["timed reveal keeps one deadline from first display across Back"] =
        blurred && clickedRevealed && backBlurred && timed.blurState() === "revealed";
    } finally { timed.close(); }

    // Stored settings arrive after the first lookup: the decision waits for them.
    const early = await createHarness(null, { holdLookupStats: true, deferInitialStorage: true,
      options: { ...blurOptions } });
    try {
      await early.initialLookup();
      const pending = early.take("hd_lookup_stats_record");
      const heldBeforeOptions = early.blurState() === "pending";
      early.reply(pending, { descriptor: { generation: "statistics", revision: 1 },
        statistics: { term: pending.request.term, reading: pending.request.reading, lookupCount: 7 } });
      await early.settle();
      const stillPending = early.blurState() === "pending"
        && early.sent.filter(request => request.type === "hd_audio_play").length === 0;
      early.deliverInitialStorage();
      await early.settle();
      outcomes["a lookup before stored settings arrive waits, then blurs and stays silent"] =
        heldBeforeOptions && stillPending && early.blurState() === "blurred"
        && early.sent.filter(request => request.type === "hd_audio_play").length === 0;
    } finally { early.close(); }

    // A BFCache return re-arms the remaining deadline.
    const cached = await createHarness(null, { holdLookupStats: true,
      options: { ...blurOptions, definitionBlurReveal: "timed", audioAutoplay: false } });
    try {
      const shown = Date.now();
      await cached.initialLookup();
      const pending = cached.take("hd_lookup_stats_record");
      cached.reply(pending, { descriptor: { generation: "statistics", revision: 1 },
        statistics: { term: pending.request.term, reading: pending.request.reading, lookupCount: 9 } });
      await cached.settle();
      cached.pageTransition("pagehide");
      await wait(Math.max(0, shown + 1000 - Date.now()) + 200);
      const frozen = cached.blurState() === "blurred";
      cached.pageTransition("pageshow");
      outcomes["a BFCache return reveals a timed blur whose deadline passed while hidden"] =
        frozen && cached.blurState() === "revealed";
    } finally { cached.close(); }
    return outcomes;
  }

  async function kanjiNavigationCase() {
    const outcomes = {};
    const harness = await createHarness({ title: "Generic", kind: "kanji" });
    try {
      await harness.initialLookup();
      harness.emitState({ schemaVersion: 1, revision: 2, dictionaries: [
        genericPackage({ kanjiCount: 1 }),
        genericPackage({ id: "native-other", title: "Other native", kanjiCount: 1 }),
      ] });
      await harness.initialLookup();
      const other = { dictionary: "Other native", meanings: ["food"] };
      const selected = { dictionary: "Generic", meanings: ["eat"] };
      for (const [name, entries, expected] of [
        ["selected native kanji misses fall back to automatic without another request", [other], [other]],
        ["selected native kanji hits exclude other native sources", [other, selected], [selected]],
      ]) {
        const start = harness.sent.length;
        const operation = harness.driver.showKanji("食");
        harness.reply(harness.take("hd_kanji"), { kanji: { character: "食", entries } });
        await operation;
        outcomes[name] = harness.render().kind === "kanji"
          && JSON.stringify(harness.render().value.entries) === JSON.stringify(expected)
          && harness.sent.slice(start).filter(request => request.type === "hd_kanji").length === 1
          && typeof harness.render().context.onBack === "function";
        if (harness.render().kind === "kanji") await harness.render().context.onBack();
        else await harness.initialLookup();
      }
    } finally { harness.close(); }
    for (const route of [null, { title: "Generic", kind: "term" }]) {
      const harness = await createHarness(route);
      const label = route ? "selected term fallback" : "automatic kanji";
      const request = route ? "hd_lookup_dictionary" : "hd_kanji";
      const hit = () => (route ? { results: [harness.term("食", "Generic")] }
        : { kanji: { character: "食", entries: [{ dictionary: "Generic", meanings: ["eat"] }] } });
      // Issue #432: jsdom's hasFocus() follows its last focused element, so
      // each blur says whether focus moved into one of the page's frames.
      const blur = (focusInPage) => {
        harness.popup.ownerDocument.hasFocus = () => focusInPage;
        harness.driver.onWindowBlur();
      };
      try {
        await harness.initialLookup();
        const navigated = harness.driver.showKanji("食");
        const navigation = harness.take(request);
        blur(false);
        harness.reply(navigation, hit());
        await navigated;
        const rendered = harness.render();
        blur(false);
        outcomes[`${label} navigation keeps its view through tab-switch blurs during and after the request`] =
          !harness.popup.hidden && harness.render() === rendered && rendered.kind === (route ? "terms" : "kanji");
        await harness.initialLookup();
        const closing = harness.driver.showKanji("食");
        const closingRequest = harness.take(request);
        blur(true);
        const closed = harness.popup.hidden;
        harness.reply(closingRequest, hit());
        await closing;
        outcomes[`${label} navigation closes when focus moves into a page frame mid-request`] =
          closed && harness.popup.hidden && harness.take("hd_kanji") === null;
        await harness.initialLookup();
        const operation = harness.driver.showKanji("食");
        if (route) {
          harness.reply(harness.take("hd_lookup_dictionary"), { results: [] });
          await harness.settle();
        }
        harness.reply(harness.take("hd_kanji"), { kanji: { character: "食", entries: [] } });
        await operation;
        outcomes[`${label} terminal miss preserves the old popup`] = !harness.popup.hidden
          && harness.render().kind === "failure"
          && harness.render().value.kind === "kanji"
          && harness.render().value.title === "Kanji lookup failed.";
        await harness.initialLookup();
        const stale = harness.driver.showKanji("食");
        const held = harness.take(request);
        await harness.initialLookup();
        const current = harness.render();
        harness.reply(held, route ? { results: [] } : { kanji: { character: "食", entries: [] } });
        await stale;
        outcomes[`${label} stale miss cannot retire a newer view`] =
          !harness.popup.hidden && harness.render() === current && current.context.isCurrentView();
      } finally { harness.close(); }
    }
    const viewportChecks = [];
    for (const generation of [2, 3]) {
      const harness = await createHarness({ title: "Generic", kind: "kanji" });
      try {
        await harness.initialLookup();
        const previous = harness.driver.viewRequest();
        harness.render().context.onDictionaryTabSelected({ dictionary: "Generic" });
        harness.setTermViewport({ expandAll: true, restoreScrollTop: 80 });
        const operation = harness.driver.showKanji("食");
        harness.reply(harness.take("hd_kanji"), { generation,
          kanji: { character: "食", entries: [{ dictionary: "Generic", meanings: ["eat"] }] } });
        await operation;
        const back = harness.render().context.onBack();
        const refresh = harness.take("hd_lookup");
        if (refresh) harness.reply(refresh, { generation, results: [harness.term(harness.candidate.query)] });
        await back;
        viewportChecks.push(Boolean(refresh) === (generation === 3)
          && harness.driver.viewRequest() === previous
          && harness.render().context.selectedDictionaryTab?.dictionary === "Generic"
          && harness.render().context.expandAll === true && harness.render().context.restoreScrollTop === 80);
      } finally { harness.close(); }
    }
    outcomes["cached and changed-generation Back preserve the exact request, selected tab and saved viewport"] = viewportChecks.every(Boolean);
    return outcomes;
  }

  async function kanjiGroupCase() {
    const outcomes = {};
    const packages = [
      genericPackage({ id: "terms-a", title: "Terms A", path: "/dicts/Terms A" }),
      genericPackage({ id: "native-b", title: "Native B", path: "/dicts/Native B", termCount: 0, kanjiCount: 1 }),
      genericPackage({ id: "terms-c", title: "Terms C", path: "/dicts/Terms C" }),
      genericPackage({ id: "native-d", title: "Native D", path: "/dicts/Native D", termCount: 0, kanjiCount: 1 }),
    ];
    const groupState = (revision, dictionaryIds) => ({ schemaVersion: 1, revision, dictionaries: packages,
      groups: [{ id: "kanji-group", name: "Kanji", dictionaryIds }] });
    const nativeEntry = (dictionary) => ({ dictionary, onyomi: "ショク", kunyomi: "", tags: "", definitions: ["eat"], stats: [] });
    const harness = await createHarness({ kind: "tabGroup", id: "kanji-group" });
    const pendingLookup = (dictionary) => {
      const index = harness.pending.findIndex(({ request }) =>
        request.type === "hd_lookup_dictionary" && request.dictionary === dictionary);
      return index < 0 ? null : harness.pending.splice(index, 1)[0];
    };
    const issued = (start) => harness.sent.slice(start)
      .filter((request) => ["hd_kanji", "hd_lookup_dictionary"].includes(request.type))
      .map((request) => request.dictionary ?? request.type);
    try {
      harness.emitState(groupState(2, ["terms-a", "native-b", "terms-c"]));
      await harness.initialLookup();
      const start = harness.sent.length;
      const clicked = harness.driver.showKanji("食");
      const fanOut = issued(start);
      // Replies land out of group order; the merged view still follows the group,
      // and a native entry outside the group stays out of it.
      harness.reply(pendingLookup("Terms C"), { dictionaryCount: 4, results: [harness.term("食", "Terms C")] });
      harness.reply(harness.take("hd_kanji"), { kanji: { character: "食", entries: [nativeEntry("Native D"), nativeEntry("Native B")] } });
      harness.reply(pendingLookup("Terms A"), { dictionaryCount: 4, results: [harness.term("食", "Terms A")] });
      await clicked;
      const render = harness.render();
      const nativeGlossary = render.kind === "terms" ? JSON.parse(render.results[1]?.term.glossaries[0]?.glossary ?? "null") : null;
      outcomes["a clicked-kanji group asks every member at once and renders merged results as ordered member tabs"] =
        JSON.stringify(fanOut) === JSON.stringify(["hd_kanji", "Terms A", "Terms C"])
        && render.kind === "terms"
        && JSON.stringify(render.results.map((result) => [result.term.expression, result.term.reading,
          result.term.glossaries.map((glossary) => glossary.dictionary)]))
          === JSON.stringify([["食", "よみ", ["Terms A", "Terms C"]], ["食", "", ["Native B"]]])
        && nativeGlossary?.[0]?.type === "structured-content"
        && JSON.stringify(nativeGlossary).includes("ショク") && JSON.stringify(nativeGlossary).includes("eat")
        && JSON.stringify(render.context.dictionaryTabScope) === JSON.stringify(["Terms A", "Native B", "Terms C"])
        && typeof render.context.onBack === "function";
      // The term view mines every card, so a native card carries the engine's
      // complete LookupResult shape (#333) and builds the fields that failed.
      const native = render.kind === "terms" ? JSON.parse(JSON.stringify(render.results[1])) : null;
      const nativeFields = native && await buildAnkiFields(native, Object.fromEntries(["{pitch-accent-categories}",
        "{part-of-speech}", "{tags}", "{conjugation}"].map((value) => [value, { value, overwriteMode: "coalesce" }])),
      { definition: async () => "" }).catch((error) => error.message);
      outcomes["a clicked-kanji group's native card is a complete term result that builds Anki fields"] =
        JSON.stringify(native && { ...native, term: { ...native.term, glossaries: native.term.glossaries
          .map((glossary) => ({ ...glossary, glossary: typeof glossary.glossary })) } })
          === JSON.stringify({ matched: "食", deinflected: "食", trace: [], preprocessorSteps: 0, term: {
            expression: "食", reading: "", rules: "", score: 0, frequencies: [], pitches: [], glossaries: [
              { dictionary: "Native B", glossary: "string", definitionTags: "", termTags: "" }] } })
        && JSON.stringify(nativeFields) === JSON.stringify({ "{pitch-accent-categories}": "", "{part-of-speech}": "Unknown",
          "{tags}": "", "{conjugation}": "" });
      await render.context.onBack();

      // A group that misses everywhere falls back to the automatic native
      // entries the fan-out already returned.
      const missStart = harness.sent.length;
      const missed = harness.driver.showKanji("食");
      harness.reply(pendingLookup("Terms A"), { dictionaryCount: 4, results: [] });
      harness.reply(pendingLookup("Terms C"), { dictionaryCount: 4, results: [] });
      harness.reply(harness.take("hd_kanji"), { kanji: { character: "食", entries: [nativeEntry("Native D")] } });
      await missed;
      outcomes["a clicked-kanji group that misses everywhere falls back to automatic native kanji without another request"] =
        harness.render().kind === "kanji"
        && JSON.stringify(harness.render().value.entries.map((entry) => entry.dictionary)) === JSON.stringify(["Native D"])
        && JSON.stringify(issued(missStart)) === JSON.stringify(["hd_kanji", "Terms A", "Terms C"]);
      await harness.render().context.onBack();

      // A term-only group defers the native fallback until every member misses.
      harness.emitState(groupState(3, ["terms-c", "terms-a"]));
      const termsStart = harness.sent.length;
      const termsOnly = harness.driver.showKanji("食");
      const eager = issued(termsStart);
      harness.reply(pendingLookup("Terms A"), { dictionaryCount: 4, results: [] });
      harness.reply(pendingLookup("Terms C"), { dictionaryCount: 4, results: [] });
      await harness.settle();
      harness.reply(harness.take("hd_kanji"), { kanji: { character: "食", entries: [nativeEntry("Native B")] } });
      await termsOnly;
      outcomes["a term-only clicked-kanji group asks for native kanji only after every member misses"] =
        JSON.stringify(eager) === JSON.stringify(["Terms C", "Terms A"])
        && JSON.stringify(issued(termsStart)) === JSON.stringify(["Terms C", "Terms A", "hd_kanji"])
        && harness.render().kind === "kanji"
        && harness.render().value.entries[0].dictionary === "Native B";
    } finally { harness.close(); }
    return outcomes;
  }

  async function eventFirstCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    const internal = harness.internalLink({
      primaryReading: "\u306a\u3044\u3076\u3054",
      query: "\u5185\u90e8\u8a9e",
    });
    const linked = harness.take("hd_lookup");
    harness.reply(linked, {
      dictionaryCount: 2,
      results: [
        harness.term("\u5185\u90e8\u8a9e"),
        harness.term("\u5185\u90e8\u8a9e", "Projected"),
      ],
    });
    await (internal || harness.settle());
    harness.render(1).context.onDictionaryTabSelected({ dictionary: "Projected" });
    harness.edit(true, 1);
    harness.emitOptions({
      frequencyDictionary: "Different",
      frequencyOrder: "ascending",
      kanjiClickDictionary: "",
      maxResults: 2,
      modifier: "none",
      scanLength: 2,
    });
    const append = harness.callbacks(1).onAddCustomEntry({
      definition: "inside",
      reading: "\u306a\u3044\u3076\u3054",
      term: "\u5185\u90e8\u8a9e",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.emitState(harness.state(3, "event-newer"));
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "reply-older"),
    });
    await harness.settle();
    const refresh = harness.take("hd_lookup");
    const request = harness.requestPayload(refresh.request);
    harness.reply(refresh, {
      dictionaryCount: 2,
      results: [harness.term("\u5185\u90e8\u8a9e", "Projected")],
    });
    await append;
    const snapshot = harness.driver.snapshot(1);
    const result = {
      displayName: snapshot.dictionaries[0]?.displayName,
      popupHidden: snapshot.popupHidden,
      request,
      selectedDictionaryTab: harness.render(1).context.selectedDictionaryTab,
      stateRevision: snapshot.dictionaryStateRevision,
    };
    harness.close();
    return result;
  }

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

  async function replyFirstCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "ate",
      reading: "\u305f\u3079\u305f",
      term: "\u98df\u3079\u305f",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.reply(appendRequest, {
      document: { revision: 4, semanticRevision: "four", text: "" },
      state: harness.state(4, "reply-newer"),
    });
    await harness.settle();
    harness.emitState(harness.state(3, "event-older"));
    const refresh = harness.take("hd_lookup");
    const request = harness.requestPayload(refresh.request);
    harness.reply(refresh, { dictionaryCount: 1, results: [harness.term("\u98df\u3079\u305f")] });
    await append;
    const snapshot = harness.driver.snapshot();
    const result = {
      displayName: snapshot.dictionaries[0]?.displayName,
      request,
      stateRevision: snapshot.dictionaryStateRevision,
    };
    harness.close();
    return result;
  }

  async function termKanjiCase(replaceBeforeReply = false) {
    const harness = await createHarness();
    await harness.initialLookup();
    const clicked = harness.callbacks().onKanjiClick("\u98df", null, null, null);
    const selected = harness.take("hd_lookup_dictionary");
    harness.reply(selected, {
      dictionaryCount: 1,
      results: [harness.term("clicked")],
    });
    await clicked;
    const clickedRender = harness.render();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "food",
      reading: "\u3057\u3087\u304f",
      term: "\u98df",
    });
    const appendRequest = harness.take("hd_custom_append");
    if (replaceBeforeReply) clickedRender.context.onBack();
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "after-note"),
    });
    await harness.settle();
    const refresh = harness.take("hd_lookup_dictionary");
    let request = null;
    if (refresh !== null) {
      request = harness.requestPayload(refresh.request);
      harness.reply(refresh, {
        dictionaryCount: 1,
        results: [harness.term("clicked refreshed")],
      });
    }
    await append;
    const refreshed = harness.render();
    let backExpression = refreshed.results?.[0]?.term?.expression ?? "";
    const hasBack = typeof refreshed.context?.onBack === "function";
    if (!replaceBeforeReply && hasBack) {
      const restoring = refreshed.context.onBack();
      const backLookup = harness.take("hd_lookup");
      harness.reply(backLookup, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
      await restoring;
      backExpression = harness.render().results?.[0]?.term?.expression ?? "";
    }
    const result = {
      backExpression,
      hasBack,
      popupHidden: harness.driver.snapshot().popupHidden,
      refreshCount: refresh === null ? 0 : 1,
      request,
    };
    harness.close();
    return result;
  }

  async function kanjiCase() {
    const harness = await createHarness({ title: "Generic", kind: "kanji" });
    await harness.initialLookup();
    const clicked = harness.callbacks().onKanjiClick("\u98df", null, null, null);
    const selected = harness.take("hd_kanji");
    harness.reply(selected, {
      kanji: {
        character: "\u98df",
        entries: [{ dictionary: "Generic" }, { dictionary: "Other" }],
      },
    });
    await clicked;
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "food",
      reading: "\u3057\u3087\u304f",
      term: "\u98df",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "after-note"),
    });
    await harness.settle();
    const refresh = harness.take("hd_kanji");
    const request = harness.requestPayload(refresh.request);
    harness.reply(refresh, {
      kanji: {
        character: "\u98df",
        entries: [{ dictionary: "Generic" }, { dictionary: "Other" }],
      },
    });
    await append;
    const result = {
      hasBack: typeof harness.render().context?.onBack === "function",
      renderedDictionaries: harness.render().value.entries.map(({ dictionary }) => dictionary),
      request,
    };
    harness.close();
    return result;
  }

  async function refreshFailureCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "ate",
      reading: "\u305f\u3079\u305f",
      term: "\u98df\u3079\u305f",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "after-note"),
    });
    await harness.settle();
    const refresh = harness.take("hd_lookup");
    harness.reply(refresh, { error: "injected refresh failure" }, false);
    let resolved = true;
    try {
      await append;
    } catch {
      resolved = false;
    }
    const result = {
      appendCount: harness.sent.filter(({ type }) => type === "hd_custom_append").length,
      refreshCount: refresh === null ? 0 : 1,
      resolved,
    };
    harness.close();
    return result;
  }

  async function detachedCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.edit(true);
    const append = harness.callbacks().onAddCustomEntry({
      definition: "ate",
      reading: "\u305f\u3079\u305f",
      term: "\u98df\u3079\u305f",
    });
    const appendRequest = harness.take("hd_custom_append");
    harness.anchor.remove();
    harness.reply(appendRequest, {
      document: { revision: 2, semanticRevision: "two", text: "" },
      state: harness.state(2, "after-note"),
    });
    await harness.settle();
    const refresh = harness.take("hd_lookup");
    let resolved = true;
    try {
      await append;
    } catch {
      resolved = false;
    }
    const result = { refreshCount: refresh === null ? 0 : 1, resolved };
    harness.close();
    return result;
  }

  async function detachedDuringRefreshCase() {
    async function run(kind) {
      const nativeKanji = kind === "kanji";
      const harness = await createHarness(nativeKanji
        ? { title: "Generic", kind: "kanji" }
        : undefined);
      await harness.initialLookup();
      if (nativeKanji) {
        const clicked = harness.callbacks().onKanjiClick("\u98df", null, null, null);
        const selected = harness.take("hd_kanji");
        harness.reply(selected, {
          kanji: {
            character: "\u98df",
            entries: [{ dictionary: "Generic" }],
          },
        });
        await clicked;
      }
      harness.edit(true);
      const append = harness.callbacks().onAddCustomEntry({
        definition: nativeKanji ? "food" : "ate",
        reading: nativeKanji ? "\u3057\u3087\u304f" : "\u305f\u3079\u305f",
        term: nativeKanji ? "\u98df" : "\u98df\u3079\u305f",
      });
      const appendRequest = harness.take("hd_custom_append");
      harness.reply(appendRequest, {
        document: { revision: 2, semanticRevision: "two", text: "" },
        state: harness.state(2, "after-note"),
      });
      await harness.settle();
      const refresh = harness.take(nativeKanji ? "hd_kanji" : "hd_lookup");
      const renderCount = harness.renders.length;
      harness.anchor.remove();
      harness.reply(refresh, nativeKanji
        ? {
            kanji: {
              character: "\u98df",
              entries: [{ dictionary: "Generic" }],
            },
          }
        : {
            dictionaryCount: 1,
            results: [harness.term("\u98df\u3079\u305f refreshed")],
          });
      await harness.settle();
      let resolved = true;
      try {
        await append;
      } catch {
        resolved = false;
      }
      const result = {
        popupHidden: harness.driver.snapshot().popupHidden,
        refreshCount: refresh === null ? 0 : 1,
        renderCount: harness.renders.length - renderCount,
        resolved,
      };
      harness.close();
      return result;
    }

    return {
      kanji: await run("kanji"),
      term: await run("term"),
    };
  }

  async function guardCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.driver.scheduleHide();
    const pendingBeforeEditing = harness.driver.hideTimerPending();
    harness.edit(true);
    const pendingWhileEditing = harness.driver.hideTimerPending();
    let caretCalls = 0;
    harness.popup.ownerDocument.caretRangeFromPoint = () => {
      caretCalls += 1;
      return null;
    };
    harness.driver.scanPointer({
      clientX: 200,
      clientY: 200,
      modifierHeld: true,
      target: harness.popup.ownerDocument.body,
    });
    harness.setCloseNext(true);
    harness.popup.ownerDocument.dispatchEvent(new harness.popup.ownerDocument.defaultView.KeyboardEvent(
      "keydown",
      { bubbles: true, cancelable: true, key: "Escape", code: "Escape" },
    ));
    const firstEscapeHidden = harness.driver.snapshot().popupHidden;
    const firstEscapeClears = harness.stats().clearCount;
    harness.popup.ownerDocument.dispatchEvent(new harness.popup.ownerDocument.defaultView.KeyboardEvent(
      "keydown",
      { bubbles: true, cancelable: true, key: "Escape", code: "Escape" },
    ));
    const result = {
      caretCalls,
      closeCalls: harness.stats().closeCalls,
      firstEscapeClears,
      firstEscapeHidden,
      pendingBeforeEditing,
      pendingWhileEditing,
      secondEscapeClears: harness.stats().clearCount,
      secondEscapeHidden: harness.driver.snapshot().popupHidden,
    };
    harness.close();
    return result;
  }

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

  async function fullscreenHostCase() {
    const harness = await createHarness();
    const document = harness.popup.ownerDocument;
    const window = document.defaultView;
    const host = harness.popup.getRootNode().host;
    const player = document.createElement("div");
    player.append(harness.anchor);
    document.body.append(player);
    await harness.initialLookup();
    let fullscreen = player;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
    document.dispatchEvent(new window.Event("fullscreenchange"));
    const mounted = host.parentElement === player && !harness.popup.hidden;
    // Showing after a page moves the host must repair its fullscreen parent.
    document.body.append(host);
    harness.driver.show(harness.candidate);
    const repaired = host.parentElement === player;
    fullscreen = null;
    document.dispatchEvent(new window.Event("fullscreenchange"));
    const restored = host.parentElement === document.body;
    const excluded = [document.documentElement, document.createElement("video"), document.createElement("iframe")];
    const shadowPlayer = document.createElement("div");
    shadowPlayer.attachShadow({ mode: "open" });
    excluded.push(shadowPlayer);
    const fallbacks = excluded.every(element => {
      fullscreen = element;
      document.dispatchEvent(new window.Event("fullscreenchange"));
      return host.parentElement === document.body;
    });
    harness.close();
    return { "fullscreen player hosts the visible popup and returns it to body on exit":
      mounted && repaired && restored && fallbacks };
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

  async function deferredInvalidationCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    harness.edit(true);
    harness.emitState(harness.state(2, "external-change"));
    const visibleWhileEditing = harness.driver.snapshot().popupHidden === false;
    harness.edit(false);
    const hiddenAfterClose = harness.driver.snapshot().popupHidden === true;
    const result = { hiddenAfterClose, visibleWhileEditing };
    harness.close();
    return result;
  }

  async function renderFailureCase() {
    const harness = await createHarness();
    await harness.initialLookup();
    const previousContext = harness.render().context;
    const previous = harness.render().context.onRenderError;
    await harness.initialLookup();
    const currentContext = harness.render().context;
    const current = harness.render().context.onRenderError;
    const requestOwnership = previousContext.isCurrentRequest?.() === false
      && currentContext.isCurrentRequest?.() === true;
    previous?.(new Error("superseded render"));
    const stayedVisible = !harness.driver.snapshot().popupHidden;
    current?.(new Error("current render"));
    const result = typeof previous === "function" && typeof current === "function"
      && requestOwnership
      && stayedVisible && harness.driver.snapshot().popupHidden;
    harness.close();
    return result;
  }

  async function lookupFailureCase() {
    const outcomes = {
      "lookup failures explain updates, disconnections and engine startup failures with a retry": false,
      "a failed same-view refresh retains its definition and open Note until retry succeeds": false,
      "ordinary misses and unrelated errors remain quiet": false,
    };
    const cases = [
      {
        error: "the dictionary engine is busy mutating",
        title: "Dictionary update in progress.",
      },
      {
        code: "sharing-disconnected",
        error: "The linked Hachidori is not reachable.",
        title: "Shared Hachidori is disconnected.",
      },
      {
        code: "engine-start-failed",
        error: "WebAssembly compilation failed",
        title: "Dictionary engine could not start.",
      },
    ];
    const explained = [];
    for (const descriptor of cases) {
      const harness = await createHarness();
      try {
        const lookup = harness.driver.runLookup(harness.candidate);
        harness.reply(harness.take("hd_lookup"), {
          error: descriptor.error,
          errorCode: descriptor.code,
        }, false);
        await lookup;
        const failure = harness.render();
        const visible = failure?.kind === "failure"
          && failure.value?.title === descriptor.title
          && failure.value?.actionLabel === "Try again"
          && harness.driver.snapshot().popupHidden === false;
        const retry = failure?.value?.onAction?.();
        const retryRequest = harness.take("hd_lookup");
        if (retryRequest) {
          harness.reply(retryRequest, { dictionaryCount: 1, results: [harness.term(harness.candidate.query)] });
          await retry;
        }
        explained.push(visible && retryRequest?.request.text === harness.candidate.query
          && harness.render()?.kind === "terms");
      } finally {
        harness.close();
      }
    }
    outcomes[Object.keys(outcomes)[0]] = explained.every(Boolean);

    const retained = await createHarness();
    try {
      await retained.initialLookup();
      const definitions = retained.popup.querySelector(".gsm-hoshidicts-definitions");
      retained.edit(true);
      const refresh = retained.driver.executeViewRequest(
        retained.driver.viewRequest(),
        0,
        { preserveViewControls: true },
      );
      retained.reply(retained.take("hd_lookup"), {
        error: "the dictionary engine is busy mutating",
        errorCode: "engine-mutating",
      }, false);
      await refresh;
      const failure = retained.render();
      const kept = failure?.kind === "failure"
        && failure.context.preserveViewControls === true
        && retained.popup.querySelector(".gsm-hoshidicts-definitions") === definitions
        && retained.driver.snapshot().noteEditing
        && !retained.driver.snapshot().popupHidden;
      const retry = failure?.value?.onAction?.();
      const retryRequest = retained.take("hd_lookup");
      if (retryRequest) {
        retained.reply(retryRequest, {
          dictionaryCount: 1,
          results: [retained.term(retained.candidate.query)],
        });
        await retry;
      }
      outcomes[Object.keys(outcomes)[1]] = kept && retained.render()?.kind === "terms"
        && retained.driver.snapshot().noteEditing;
    } finally {
      retained.close();
    }

    const quietError = await createHarness();
    const quietMiss = await createHarness();
    try {
      const failed = quietError.driver.runLookup(quietError.candidate);
      quietError.reply(quietError.take("hd_lookup"), { error: "an unrelated lookup failure" }, false);
      await failed;
      const unrelatedQuiet = quietError.driver.snapshot().popupHidden
        && quietError.renders.every(render => render.kind !== "failure");
      const missed = quietMiss.driver.runLookup(quietMiss.candidate);
      quietMiss.reply(quietMiss.take("hd_lookup"), { dictionaryCount: 1, results: [] });
      await missed;
      outcomes[Object.keys(outcomes)[2]] = unrelatedQuiet
        && quietMiss.driver.snapshot().popupHidden
        && quietMiss.renders.every(render => render.kind !== "failure");
    } finally {
      quietError.close();
      quietMiss.close();
    }
    return outcomes;
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

  async function externalLinksCase() {
    const harness = await createHarness();
    try {
      await harness.initialLookup();
      harness.edit(true);
      const openLinks = [harness.render().context.onExternalLink, harness.callbacks().onCustomLinkClick];
      if (openLinks.some(open => typeof open !== "function")) return false;
      const before = JSON.stringify({ snapshot: harness.driver.snapshot(), stats: harness.stats() });
      const descriptor = harness.driver.viewRequest();
      const sentBefore = harness.sent.length;
      for (const open of openLinks) for (const kind of ["success", "failure", "lost-reply"]) {
        open({ url: "https://example.test/reference", active: false });
        const item = harness.take("hd_open_external");
        if (item?.request.target !== "hoshidicts-worker" || item.request.active !== false
            || item.request.url !== "https://example.test/reference") return false;
        if (kind === "lost-reply") item.callback(undefined);
        else harness.reply(item, kind === "success" ? { opened: true } : { error: "tab creation failed" }, kind === "success");
        await harness.settle();
      }
      const preserved = harness.sent.length === sentBefore + 6 && harness.pending.length === 0
        && harness.driver.viewRequest() === descriptor
        && JSON.stringify({ snapshot: harness.driver.snapshot(), stats: harness.stats() }) === before;
      harness.driver.teardown();
      openLinks[1]({ url: "https://example.test/stale", active: true });
      return preserved && harness.sent.length === sentBefore + 6;
    } finally { harness.close(); }
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

  return {
    callbacksWired,
    keybinds: { ...await keybindCase(), ...await wheelKeybindCase() },
    popupVisibility: await popupVisibilityCase(),
    fullscreenHost: await fullscreenHostCase(),
    lookupStatistics: { ...await lookupStatisticsCase(), ...await lookupStatisticsRaceCase() },
    definitionBlur: { ...await definitionBlurCase(), ...await ankiMaturityBlurCase(),
      ...await frequencyDefinitionBlurCase() },
    kanjiNavigation: { ...await kanjiNavigationCase(), ...await kanjiGroupCase() },
    externalLinks: await externalLinksCase(),
    scanning: { ...await pendingScanCase(), ...await definitionTextLookupCase(), ...await scanExtractionCase(), ...await sentenceBoundaryCase(), ...await longKeyWindowCase(), ...await hoverGlyphCase(), ...await googleDocsCase(), ...await textFieldCase(), ...await matchedAnchorCase(), ...await popupWheelCase(), ...await movedMatchEndpointCase(),
      ...await autofocusedSearchCase(), ...await focusedEditingCase(), ...await shadowEditingCase(),
      ...await exactSelectionCase(), ...await selectionSentenceCase(), ...await selectedWordEditorCase(), ...await selectionActivationCase(),
      ...await selectionCancellationCase(), ...await selectionRecoveryCase(),
      ...await releasedSelectionDragCase(),
      ...await selectedTextCase(), ...await selectionDescriptorCase(), ...await selectionInvalidationCase(),
      ...await selectionLanguageCase(), ...await selectionNoticeCase(), ...await personalDictionaryOffCase(),
      ...await selectionEditingCase(), ...await popupSelectionCase() },
    activation: { ...await activationCase(), ...await scanDelayCase(), ...await definitionScanDelayCase(),
      ...await cursorExitCase(), ...await activationButtonCase(),
      ...await overlayDepartureCase(), ...await browserDepartureCase() },
    mediaOwnership: { ...await mediaOwnershipCase(), ...await imageSourceRoutingCase(), ...await boundedMediaCase(), ...await previewInvalidationCase(),
      ...await nestedLevelsCase(), ...await livePresentationCase(), ...await inheritedTabsCase(), ...await nestedResizeCase(), ...await columnPreferenceCase(), ...await nestedNotesCase(), ...await nestedPointerCase(), ...await nestedStickyCase(), ...await nestedCursorExitCase(), ...await nestedPlacementCase(), ...await nestedClickCase(), ...await audioChooserPaneCase(), ...await nestedReplyRaceCase(),
      ...await retainedParentNavigationCase() },
    newestOnlyOptions,
    renderFailure: await renderFailureCase(),
    lookupFailures: await lookupFailureCase(),
    deferredInvalidation: await deferredInvalidationCase(),
    detached: await detachedCase(),
    detachedDuringRefresh: await detachedDuringRefreshCase(),
    eventFirst: await eventFirstCase(),
    guards: await guardCase(),
    kanji: await kanjiCase(),
    refreshFailure: await refreshFailureCase(),
    replaced: await termKanjiCase(true),
    replyFirst: await replyFirstCase(),
    termKanji: await termKanjiCase(false),
  };
}

describe("content script", () => {
  test("a stale kanji reply after a storage change", async () => {
    const staleKanjiRenders = await staleKanjiResponseStage("storage-change");
    check(
      "a storage change invalidates an in-flight clicked-kanji lookup",
      Array.isArray(staleKanjiRenders?.renders) && staleKanjiRenders.renders.length === 0,
      JSON.stringify(staleKanjiRenders),
    );
  });

  test("a stale kanji reply after a group-only storage change", async () => {
    const groupOnlyKanjiRenders = await staleKanjiResponseStage("group-storage-change");
    check(
      "a group-only state change leaves an in-flight clicked-kanji lookup alone",
      Array.isArray(groupOnlyKanjiRenders?.renders)
        && groupOnlyKanjiRenders.renders.length === 1
        && groupOnlyKanjiRenders.popupHidden === false,
      JSON.stringify(groupOnlyKanjiRenders),
    );
  });

  test("a stale kanji reply after Back", async () => {
    const staleBackRenders = await staleKanjiResponseStage("back");
    check(
      "Back invalidates an in-flight clicked-kanji lookup",
      Array.isArray(staleBackRenders?.renders) && staleBackRenders.renders.length === 1,
      JSON.stringify(staleBackRenders),
    );
  });

  test("a stale kanji reply before the initial storage read", async () => {
    const staleInitialStorageRenders = await staleKanjiResponseStage("initial-storage");
    check(
      "initial dictionary hydration invalidates the lookup and hides its stale popup",
      Array.isArray(staleInitialStorageRenders?.renders)
        && staleInitialStorageRenders.renders.length === 0
        && staleInitialStorageRenders.popupHidden === true,
      JSON.stringify(staleInitialStorageRenders),
    );
  });

  test("content script Notes, scanning, activation, nested popups and media", async () => {
    const noteContent = await contentNoteStage();
    check(
      "the root popup publishes one shown/hidden event for each visibility transition",
      noteContent?.popupVisibility === true,
      JSON.stringify(noteContent?.popupVisibility),
    );
    for (const [name, passed] of Object.entries(noteContent?.fullscreenHost ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    for (const [name, passed] of Object.entries(noteContent?.lookupStatistics ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    for (const [name, passed] of Object.entries(noteContent?.definitionBlur ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    for (const [name, passed] of Object.entries(noteContent?.kanjiNavigation ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    check("content routes external links to the worker without retrying or changing the current Note view",
      noteContent?.externalLinks === true, JSON.stringify(noteContent?.externalLinks));
    for (const [name, passed] of Object.entries(noteContent?.scanning ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    for (const [name, passed] of Object.entries(noteContent?.activation ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    for (const [name, passed] of Object.entries(noteContent?.keybinds ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    for (const [name, passed] of Object.entries(noteContent?.mediaOwnership ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    check(
      "only the current render failure clears the content popup",
      noteContent?.renderFailure === true,
      JSON.stringify(noteContent?.renderFailure),
    );
    for (const [name, passed] of Object.entries(noteContent?.lookupFailures ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
    check(
      "content readers ignore older and repeated option revisions before their next lookup",
      noteContent?.newestOnlyOptions === true,
      JSON.stringify(noteContent?.newestOnlyOptions),
    );
    check(
      "content Note callbacks replay exact ordinary and internal-link requests with newer state",
      noteContent?.callbacksWired === true
        && noteContent.eventFirst?.request?.type === "hd_lookup"
        && noteContent.eventFirst.request.text === "\u5185\u90e8\u8a9e"
        && noteContent.eventFirst.request.maxResults === 7
        && noteContent.eventFirst.request.scanLength === 3
        && noteContent.eventFirst.request.options?.frequencyDictionary === "Frequency A"
        && noteContent.eventFirst.request.options?.frequencyOrder === "descending"
        && noteContent.eventFirst.request.options?.primaryReading === "\u306a\u3044\u3076\u3054"
        && noteContent.eventFirst.selectedDictionaryTab?.dictionary === "Projected"
        && noteContent.eventFirst.stateRevision === 3
        && noteContent.eventFirst.displayName === "event-newer"
        && noteContent.eventFirst.popupHidden === false
        && noteContent.replyFirst?.request?.type === "hd_lookup"
        && noteContent.replyFirst.request.text === "\u98df\u3079\u305f"
        && noteContent.replyFirst.stateRevision === 4
        && noteContent.replyFirst.displayName === "reply-newer",
      JSON.stringify(noteContent),
    );
    check(
      "content Note refresh preserves clicked-kanji dictionary intent and Back context",
      noteContent?.termKanji?.request?.type === "hd_lookup_dictionary"
        && noteContent.termKanji.request.dictionary === "Generic"
        && noteContent.termKanji.request.text === "\u98df"
        && noteContent.termKanji.request.scanLength === 1
        && noteContent.termKanji.request.maxResults === 7
        && noteContent.termKanji.request.options?.frequencyDictionary === "Frequency A"
        && noteContent.termKanji.request.options?.frequencyOrder === "descending"
        && noteContent.termKanji.hasBack === true
        && noteContent.termKanji.backExpression === "\u98df\u3079\u305f"
        && noteContent.kanji?.request?.type === "hd_kanji"
        && noteContent.kanji.request.character === "\u98df"
        && noteContent.kanji.renderedDictionaries?.join(",") === "Generic"
        && noteContent.kanji.hasBack === true,
      JSON.stringify(noteContent),
    );
    check(
      "a successful Note append cannot become retryable when lookup refresh fails",
      noteContent?.refreshFailure?.resolved === true
        && noteContent.refreshFailure.appendCount === 1
        && noteContent.refreshFailure.refreshCount === 1,
      JSON.stringify(noteContent?.refreshFailure),
    );
    check(
      "Note refresh skips a replaced view but still refreshes a popup whose page source was removed (#402)",
      noteContent?.replaced?.refreshCount === 0
        && noteContent.replaced.backExpression === "\u98df\u3079\u305f"
        && noteContent.replaced.popupHidden === true
        && noteContent.detached?.refreshCount === 1
        && noteContent.detached.resolved === true
        && noteContent.detachedDuringRefresh?.term?.refreshCount === 1
        && noteContent.detachedDuringRefresh.term.renderCount === 1
        && noteContent.detachedDuringRefresh.term.popupHidden === false
        && noteContent.detachedDuringRefresh.term.resolved === true
        && noteContent.detachedDuringRefresh?.kanji?.refreshCount === 1
        && noteContent.detachedDuringRefresh.kanji.renderCount === 1
        && noteContent.detachedDuringRefresh.kanji.popupHidden === false
        && noteContent.detachedDuringRefresh.kanji.resolved === true,
      JSON.stringify({
        replaced: noteContent?.replaced,
        detached: noteContent?.detached,
        detachedDuringRefresh: noteContent?.detachedDuringRefresh,
      }),
    );
    check(
      "Note editing cancels hover dismissal and consumes Escape before popup capture",
      noteContent?.guards?.pendingBeforeEditing === true
        && noteContent.guards.pendingWhileEditing === false
        && noteContent.guards.caretCalls === 0
        && noteContent.guards.firstEscapeHidden === false
        && noteContent.guards.firstEscapeClears === 0
        && noteContent.guards.secondEscapeHidden === true
        && noteContent.guards.secondEscapeClears === 1
        && noteContent.guards.closeCalls === 2
        && noteContent.deferredInvalidation?.visibleWhileEditing === true
        && noteContent.deferredInvalidation.hiddenAfterClose === true,
      JSON.stringify({
        deferredInvalidation: noteContent?.deferredInvalidation,
        guards: noteContent?.guards,
      }),
    );
  });
});
