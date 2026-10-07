/*
 * The content script's Notes: callbacks, refreshes and editing guards.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
import { check, test } from "./harness.mjs";

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

describe("content script: Notes", () => {
  test("Note callbacks replay requests with newer state", async () => {
    const noteContent = await contentNoteStage({
      eventFirst: async () => (await eventFirstCase()),
      replyFirst: async () => (await replyFirstCase()),
    });
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
  });

  test("Note refresh keeps clicked-kanji intent and Back", async () => {
    const noteContent = await contentNoteStage({
      kanji: async () => (await kanjiCase()),
      termKanji: async () => (await termKanjiCase(false)),
    });
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
  });

  test("a successful append survives a failed refresh", async () => {
    const noteContent = await contentNoteStage({
      refreshFailure: async () => (await refreshFailureCase()),
    });
    check(
      "a successful Note append cannot become retryable when lookup refresh fails",
      noteContent?.refreshFailure?.resolved === true
        && noteContent.refreshFailure.appendCount === 1
        && noteContent.refreshFailure.refreshCount === 1,
      JSON.stringify(noteContent?.refreshFailure),
    );
  });

  test("Note refresh of replaced and detached views", async () => {
    const noteContent = await contentNoteStage({
      detached: async () => (await detachedCase()),
      detachedDuringRefresh: async () => (await detachedDuringRefreshCase()),
      replaced: async () => (await termKanjiCase(true)),
    });
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
  });

  test("Note editing guards", async () => {
    const noteContent = await contentNoteStage({
      deferredInvalidation: async () => (await deferredInvalidationCase()),
      guards: async () => (await guardCase()),
    });
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
