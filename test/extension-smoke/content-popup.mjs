/*
 * The content script's popup: visibility, fullscreen hosts, clicked kanji, links and failures.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { buildAnkiFields } from "../../extension/anki-values.js";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
import { genericPackage } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

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

describe("content script: popup", () => {
  test("popup visibility events", async () => {
    const noteContent = await contentNoteStage({
      popupVisibility: async () => (await popupVisibilityCase()),
    });
    check(
      "the root popup publishes one shown/hidden event for each visibility transition",
      noteContent?.popupVisibility === true,
      JSON.stringify(noteContent?.popupVisibility),
    );
  });

  test("fullscreen hosts", async () => {
    const noteContent = await contentNoteStage({
      fullscreenHost: async () => (await fullscreenHostCase()),
    });
    for (const [name, passed] of Object.entries(noteContent?.fullscreenHost ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });

  test("clicked-kanji navigation and groups", async () => {
    const noteContent = await contentNoteStage({
      kanjiNavigation: async () => ({ ...await kanjiNavigationCase(), ...await kanjiGroupCase() }),
    });
    for (const [name, passed] of Object.entries(noteContent?.kanjiNavigation ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });

  test("external links", async () => {
    const noteContent = await contentNoteStage({
      externalLinks: async () => (await externalLinksCase()),
    });
    check("content routes external links to the worker without retrying or changing the current Note view",
      noteContent?.externalLinks === true, JSON.stringify(noteContent?.externalLinks));
  });

  test("render failures", async () => {
    const noteContent = await contentNoteStage({
      renderFailure: async () => (await renderFailureCase()),
    });
    check(
      "only the current render failure clears the content popup",
      noteContent?.renderFailure === true,
      JSON.stringify(noteContent?.renderFailure),
    );
  });

  test("lookup failures", async () => {
    const noteContent = await contentNoteStage({
      lookupFailures: async () => (await lookupFailureCase()),
    });
    for (const [name, passed] of Object.entries(noteContent?.lookupFailures ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });

  test("option revisions", async () => {
    const noteContent = await contentNoteStage({});
    check(
      "content readers ignore older and repeated option revisions before their next lookup",
      noteContent?.newestOnlyOptions === true,
      JSON.stringify(noteContent?.newestOnlyOptions),
    );
  });
});
