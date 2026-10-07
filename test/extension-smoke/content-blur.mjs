/*
 * The content script's lookup counts and definition blur.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe } from "node:test";
import { contentNoteStage, createHarness } from "./content-harness.mjs";
import { genericPackage } from "./fakes.mjs";
import { check, test } from "./harness.mjs";

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

describe("content script: lookup counts and blur", () => {
  test("lookup statistics", async () => {
    const noteContent = await contentNoteStage({
      lookupStatistics: async () => ({ ...await lookupStatisticsCase(), ...await lookupStatisticsRaceCase() }),
    });
    for (const [name, passed] of Object.entries(noteContent?.lookupStatistics ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });

  test("definition blur", async () => {
    const noteContent = await contentNoteStage({
      definitionBlur: async () => ({ ...await definitionBlurCase(), ...await ankiMaturityBlurCase(),
        ...await frequencyDefinitionBlurCase() }),
    });
    for (const [name, passed] of Object.entries(noteContent?.definitionBlur ?? {})) {
      check(name, passed === true, JSON.stringify(passed));
    }
  });
});
