/*
 * The content script: stale kanji replies.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
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
  window.eval(readFileSync(resolve(EXTENSION, "content-dictionaries.js"), "utf8"));
  window.eval(readFileSync(resolve(EXTENSION, "content-scan.js"), "utf8"));
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
});
