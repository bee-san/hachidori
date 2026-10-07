/*
 * The content-script harness: a jsdom page running the instrumented content.js.
 *
 * contentNoteStage() loads jsdom and probes the Note callbacks once, then runs only the
 * cases a test asks for, so each test reads the same result object the stage returned.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_TITLE,
} from "../../extension/custom-dictionary.js";
import { lookupStatsKey } from "../../extension/lookup-stats.js";
import { EXTENSION, genericPackage, loadJsdom } from "./fakes.mjs";

let JSDOM;

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

// The stage's shared start runs once: jsdom, then the probe of the Note callbacks and of
// option revisions. Each test passes the cases it checks and gets the stage's result
// object with those cases in it.
let prelude = null;
async function contentNoteStage(cases) {
  prelude ??= (async () => {
    const jsdom = await loadJsdom();
    if (jsdom === null) {
      return null;
    }
    ({ JSDOM } = jsdom);
    const probe = await createHarness();
    const callbacksWired = typeof probe.callbacks()?.onAddCustomEntry === "function"
      && typeof probe.callbacks()?.onNoteEditingChange === "function";
    probe.emitOptions({ revision: 4, maxResults: 50 });
    probe.emitOptions({ revision: 2, maxResults: 2 });
    probe.emitOptions({ revision: 4, maxResults: 3 });
    const newestOnlyOptions = (await probe.initialLookup()).request.maxResults === 50;
    probe.close();
    return { callbacksWired, newestOnlyOptions };
  })();
  const shared = await prelude;
  if (shared === null) return null;
  const { callbacksWired, newestOnlyOptions } = shared;
  if (!callbacksWired) return { callbacksWired };
  const result = { callbacksWired, newestOnlyOptions };
  for (const [key, run] of Object.entries(cases)) result[key] = await run();
  return result;
}

export {
  contentNoteStage,
  createHarness,
};
