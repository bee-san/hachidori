/*
 * Every read path and the error paths through the real engine.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./engine-library.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe } from "node:test";
import { buildTitledZip, imagePreviewFixture, makePng } from "../make-fixture.mjs";
import {
  engineService,
  formerArchiveByteLimit,
  idb,
  observedEngine,
  request,
  storage,
  storedDictionaryState,
  zip,
} from "./engine.mjs";
import { createDeclaredLengthURL, createObjectURL, FIXTURE_TITLE, HERE } from "./fakes.mjs";
import { check, equal, section, step } from "./harness.mjs";

// Values that more than one step uses; the step that creates each one assigns it.
let lookup, first, fixtureTags, kanji, originalCcall, media, mediaMessage, largeMediaRemoved;

describe("engine: lookups and errors", () => {
  step("lookup, kanji, styles, media", async () => {
    section("lookup, kanji, styles, media");
    lookup = await request("hd_lookup", {
      text: "食べたかった",
      maxResults: 32,
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    check("hd_lookup succeeds", lookup.ok === true, JSON.stringify(lookup.error));
    equal("hd_lookup_result payload keys", Object.keys(lookup).sort(), [
      "dictionaryCount",
      "error",
      "generation",
      "ok",
      "requestId",
      "results",
      "type",
    ]);
    check("hd_lookup returns results", lookup.results.length > 0, JSON.stringify(lookup.results));
    first = lookup.results[0];
    equal("the deinflection trace survives the round trip", [
      first.matched,
      first.deinflected,
      first.trace.map((step) => step.name),
    ], ["食べたかった", "食べる", ["-た", "-たい"]]);
    check(
      "glossary stays a raw structured-content string",
      typeof first.term.glossaries[0].glossary === "string" &&
        first.term.glossaries[0].glossary.startsWith("["),
      JSON.stringify(first.term.glossaries[0]),
    );
    check("frequencies came through", first.term.frequencies.length > 0, JSON.stringify(first.term.frequencies));
    check("pitches came through", first.term.pitches.length > 0, JSON.stringify(first.term.pitches));
    fixtureTags = [
      ["vt", [{ name: "vt", category: "expression", order: 0, score: 0, notes: "transitive verb" }]],
      ["col", [{ name: "col", category: "dictionary", order: 0, score: 0, notes: "colloquial" }]],
    ];
    equal("each glossary carries its dictionary's tag-bank tags beside definitionTags",
      first.term.glossaries.filter(({ dictionary }) => dictionary === FIXTURE_TITLE)
        .map(({ definitionTags, tags }) => [definitionTags, tags]),
      fixtureTags);
  });

  step("hd_lookup_dictionary, no-match counts and hd_kanji", async () => {
    const selectedLookup = await request("hd_lookup_dictionary", {
      dictionary: FIXTURE_TITLE,
      text: "食べたかった",
      maxResults: 1,
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    check(
      "hd_lookup_dictionary returns only the selected enabled term dictionary",
      selectedLookup.ok === true
        && selectedLookup.results.length === 1
        && selectedLookup.results[0].term.glossaries.every(({ dictionary }) => dictionary === FIXTURE_TITLE)
        && JSON.stringify(selectedLookup.results[0].term.glossaries.map(({ definitionTags, tags }) => [definitionTags, tags]))
          === JSON.stringify(fixtureTags),
      JSON.stringify(selectedLookup),
    );
    const missingSelectedLookup = await request("hd_lookup_dictionary", {
      dictionary: "not imported",
      text: "食",
    });
    equal(
      "hd_lookup_dictionary refuses a title that is not enabled and stored",
      [missingSelectedLookup.ok, missingSelectedLookup.results, missingSelectedLookup.dictionaryCount],
      [true, [], 4],
    );

    // content.js renders "no dictionaries imported" on dictionaryCount 0, so an
    // ordinary no-match must not report 0 the way the engine's error fallback does.
    const noMatch = await request("hd_lookup", {
      text: "zzz",
      maxResults: 32,
      scanLength: 16,
      options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
    });
    equal(
      "a no-match lookup still reports the real dictionaryCount",
      [noMatch.ok, noMatch.results, noMatch.dictionaryCount],
      [true, [], 4],
    );

    kanji = await request("hd_kanji", { character: "食" });
    check("hd_kanji returns a LookupKanji", kanji.ok === true && kanji.kanji?.character === "食", JSON.stringify(kanji));
    check(
      "kanji onyomi/kunyomi/tags are strings, as contract B says",
      ["onyomi", "kunyomi", "tags"].every((key) => typeof kanji.kanji.entries[0][key] === "string"),
      JSON.stringify(kanji.kanji.entries[0]),
    );
    const missingKanji = await request("hd_kanji", { character: "鰷" });
    equal("an unmatched kanji maps to null", [missingKanji.ok, missingKanji.kanji], [true, null]);
  });

  step("lookup inputs and replies are bounded", async () => {
    const invalidLookupRequests = [
      { type: "hd_lookup", text: "食\0べる" },
      { type: "hd_lookup_dictionary", dictionary: FIXTURE_TITLE, text: "食\0べる" },
      { type: "hd_kanji", character: "食\0" },
      { type: "hd_lookup", text: "あ".repeat(1366) },
      { type: "hd_lookup", text: "食", options: { primaryReading: "あ".repeat(1366) } },
      { type: "hd_lookup", text: "食", options: { frequencyDictionary: "あ".repeat(1366) } },
    ];
    const invalidLookupReplies = [];
    for (const message of invalidLookupRequests) {
      invalidLookupReplies.push(await engineService.handleEngineMessage({ ...message, requestId: "bounded-input" }));
    }
    check(
      "lookup inputs reject oversized UTF-8 and C-string NUL without truncation",
      invalidLookupReplies.every((reply) => reply.ok === false
        && reply.requestId === "bounded-input"
        && /4096-byte|NUL/u.test(reply.error)
        && (reply.kanji === null || reply.results?.length === 0)),
      JSON.stringify(invalidLookupReplies),
    );

    originalCcall = observedEngine.ccall;
    const lookupNativeNames = new Set(["hdw_lookup", "hdw_lookup_dictionary", "hdw_kanji"]);
    let injectedLookupJson = "null";
    let injectedLookupError = "";
    observedEngine.ccall = (name, ...args) => {
      if (lookupNativeNames.has(name)) return injectedLookupJson;
      if (name === "hdw_last_error") return injectedLookupError;
      return originalCcall(name, ...args);
    };
    try {
      const malformedReplies = [];
      for (const type of ["hd_lookup", "hd_lookup_dictionary", "hd_kanji"]) {
        for (const json of ["null", "{}", '{"results":[],"dictionaryCount":"4"}', '{"character":"食","entries":{}}']) {
          injectedLookupJson = json;
          malformedReplies.push(await engineService.handleEngineMessage({
            type, requestId: "malformed", dictionary: FIXTURE_TITLE, text: "食", character: "食",
          }));
        }
      }
      check(
        "malformed native lookup shapes fail instead of becoming successful misses",
        malformedReplies.every((reply) => reply.ok === false && /malformed/u.test(reply.error)),
        JSON.stringify(malformedReplies),
      );

      const responseLimit = 32 * 1024 * 1024;
      for (const [type, nativeValue, field] of [
        ["hd_lookup", { results: [first], dictionaryCount: 4 }, "results"],
        ["hd_lookup_dictionary", { results: [first], dictionaryCount: 4 }, "results"],
        ["hd_kanji", kanji.kanji, "kanji"],
      ]) {
        injectedLookupJson = JSON.stringify(nativeValue);
        const message = { type, dictionary: FIXTURE_TITLE, text: "食", character: "食", requestId: "" };
        const smallReply = await engineService.handleEngineMessage(message);
        // A long multibyte correlation ID makes the complete public envelope
        // cross the limit even though the native JSON itself is small.
        const remaining = responseLimit - Buffer.byteLength(JSON.stringify(smallReply));
        const exactId = "あ".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
        const exact = await engineService.handleEngineMessage({ ...message, requestId: exactId });
        const over = await engineService.handleEngineMessage({ ...message, requestId: exactId + "x" });
        check(
          `${type} accepts exactly 32 MiB and rejects one extra envelope byte`,
          exact.ok === true && Buffer.byteLength(JSON.stringify(exact)) === responseLimit
            && JSON.stringify(exact[field]) === JSON.stringify(smallReply[field])
            && over.ok === false && /32 MiB/u.test(over.error)
            && over.requestId === exactId + "x"
            && Buffer.byteLength(JSON.stringify(over)) <= responseLimit,
          JSON.stringify({ exactOk: exact.ok, overOk: over.ok, error: over.error }),
        );
      }
      injectedLookupJson = JSON.stringify({ results: [], dictionaryCount: 4 });
      const invalidId = await engineService.handleEngineMessage({ type: "hd_lookup", text: "食", requestId: {} });
      const oversizedId = await engineService.handleEngineMessage({
        type: "hd_lookup", text: "食", requestId: "x".repeat(responseLimit),
      });
      check(
        "lookup correlation IDs fail closed when invalid or unable to fit an error reply",
        invalidId.ok === false && invalidId.requestId === null
          && oversizedId.ok === false && oversizedId.requestId === null
          && Buffer.byteLength(JSON.stringify(oversizedId)) <= responseLimit,
        JSON.stringify({ invalidOk: invalidId.ok, oversizedOk: oversizedId.ok }),
      );
      const genericErrorFrame = { ...oversizedId, requestId: "" };
      const errorId = "x".repeat(responseLimit - Buffer.byteLength(JSON.stringify(genericErrorFrame)));
      injectedLookupError = "long native failure ".repeat(20);
      const correlatedFailure = await engineService.handleEngineMessage({
        type: "hd_lookup", text: "食", requestId: errorId,
      });
      check(
        "an oversized native error retains correlation when the bounded error frame fits",
        correlatedFailure.ok === false && correlatedFailure.requestId === errorId
          && correlatedFailure.error === genericErrorFrame.error
          && Buffer.byteLength(JSON.stringify(correlatedFailure)) === responseLimit,
        JSON.stringify({ ok: correlatedFailure.ok, idRetained: correlatedFailure.requestId === errorId }),
      );
    } finally {
      observedEngine.ccall = originalCcall;
    }
    const afterBoundedFailure = await request("hd_lookup", { text: "食べる" });
    check(
      "a healthy lookup after boundary errors keeps its generation and complete result",
      afterBoundedFailure.ok === true && afterBoundedFailure.generation === lookup.generation
        && afterBoundedFailure.results[0]?.term.expression === "食べる",
      JSON.stringify(afterBoundedFailure.error),
    );
  });

  step("hd_styles and hd_media", async () => {
    const styles = await request("hd_styles");
    check(
      "hd_styles returns the dictionary's CSS",
      styles.ok === true && styles.styles.length === 1 && styles.styles[0].dictionary === FIXTURE_TITLE,
      JSON.stringify(styles),
    );

    media = await request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: "media/kanji.png" });
    check(
      "hd_media returns a data: URL glossary.js will accept",
      media.ok === true && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(media.dataUrl ?? ""),
      JSON.stringify(media.dataUrl?.slice(0, 48)),
    );
    const absentMedia = await request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: "media/nope.png" });
    equal("absent media is dataUrl null, not an error", [absentMedia.ok, absentMedia.dataUrl], [true, null]);

    const mediaDictionaryBoundary = "あ".repeat(341) + "x";
    const mediaPathBoundary = "media/" + "あ".repeat(1363) + "x";
    const exactMediaReferences = await Promise.all([
      request("hd_media", { generation: lookup.generation, dictionary: mediaDictionaryBoundary, path: "media/kanji.png" }),
      request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: mediaPathBoundary }),
    ]);
    const invalidMediaReferences = await Promise.all([
      request("hd_media", { generation: lookup.generation, dictionary: mediaDictionaryBoundary + "x", path: "media/kanji.png" }),
      request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: mediaPathBoundary + "x" }),
      request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE + "\0suffix", path: "media/kanji.png" }),
      request("hd_media", { generation: lookup.generation, dictionary: FIXTURE_TITLE, path: "media/kanji.png\0suffix" }),
    ]);
    check("media references use exact UTF-8 bounds and never truncate embedded NUL",
      Buffer.byteLength(mediaDictionaryBoundary) === 1024 && Buffer.byteLength(mediaPathBoundary) === 4096
        && exactMediaReferences.every((reply) => reply.ok === true && reply.dataUrl === null)
        && invalidMediaReferences.every((reply) => reply.ok === false && reply.dataUrl === null),
      JSON.stringify({ exact: exactMediaReferences.map(({ ok }) => ok), invalid: invalidMediaReferences.map(({ ok, error }) => ({ ok, error })) }));

    const mediaFrameLimit = 6 * 1024 * 1024;
    mediaMessage = { type: "hd_media", generation: lookup.generation, dictionary: FIXTURE_TITLE, path: "media/kanji.png", requestId: "" };
    const smallMediaFrame = await engineService.handleEngineMessage(mediaMessage);
    const mediaIdBytes = mediaFrameLimit - Buffer.byteLength(JSON.stringify(smallMediaFrame));
    const exactMediaId = "あ".repeat(Math.floor(mediaIdBytes / 3)) + "x".repeat(mediaIdBytes % 3);
    const exactMediaFrame = await engineService.handleEngineMessage({ ...mediaMessage, requestId: exactMediaId });
    const excessiveMediaFrame = await engineService.handleEngineMessage({ ...mediaMessage, requestId: exactMediaId + "x" });
    check("media accepts exactly 6 MiB and rejects one extra complete frame byte",
      exactMediaFrame.ok === true && Buffer.byteLength(JSON.stringify(exactMediaFrame)) === mediaFrameLimit
        && exactMediaFrame.dataUrl === smallMediaFrame.dataUrl
        && excessiveMediaFrame.ok === false && excessiveMediaFrame.dataUrl === null
        && excessiveMediaFrame.requestId === exactMediaId + "x"
        && /6 MiB/u.test(excessiveMediaFrame.error)
        && Buffer.byteLength(JSON.stringify(excessiveMediaFrame)) <= mediaFrameLimit,
      JSON.stringify({ exact: exactMediaFrame.ok, excessive: excessiveMediaFrame.ok, error: excessiveMediaFrame.error }));
    const invalidMediaId = await engineService.handleEngineMessage({ ...mediaMessage, requestId: {} });
    const impossibleMediaId = await engineService.handleEngineMessage({ ...mediaMessage, requestId: "x".repeat(mediaFrameLimit) });
    check("invalid or impossible media correlation IDs receive bounded null-ID errors",
      [invalidMediaId, impossibleMediaId].every((reply) => reply.ok === false && reply.requestId === null
        && reply.dataUrl === null && Buffer.byteLength(JSON.stringify(reply)) <= mediaFrameLimit),
      JSON.stringify({ invalid: invalidMediaId.ok, impossible: impossibleMediaId.ok }));
  });

  step("media imports stay uncapped while oversized fetches fail", async () => {
    const largeMediaTitle = "bounded-media-fixture";
    const largeMediaBytes = Buffer.alloc(4 * 1024 * 1024);
    makePng().copy(largeMediaBytes);
    const largeMediaArchive = buildTitledZip(largeMediaTitle, { mediaEntries: [
      ["media/exact.png", largeMediaBytes],
      ["media/over.png", Buffer.concat([largeMediaBytes, Buffer.from([0])])],
    ] });
    const largeMediaImport = await request("hd_import", {
      blobUrl: createObjectURL(largeMediaArchive), fileName: "bounded-media.zip",
    });
    const exactNativeMedia = await request("hd_media", { generation: largeMediaImport.generation, dictionary: largeMediaTitle, path: "media/exact.png" });
    const overNativeMedia = await request("hd_media", { generation: largeMediaImport.generation, dictionary: largeMediaTitle, path: "media/over.png" });
    const healthyMediaAfterError = await request("hd_media", { generation: largeMediaImport.generation, dictionary: FIXTURE_TITLE, path: "media/kanji.png" });
    largeMediaRemoved = await request("hd_remove", { title: largeMediaTitle });
    check("media imports stay uncapped while oversized native fetches propagate real errors",
      largeMediaImport.ok === true && largeMediaImport.report.mediaCount === 2
        && exactNativeMedia.ok === true
        && Buffer.from(exactNativeMedia.dataUrl?.split(",")[1] ?? "", "base64").equals(largeMediaBytes)
        && overNativeMedia.ok === false && overNativeMedia.dataUrl === null && /media/u.test(overNativeMedia.error)
        && healthyMediaAfterError.ok === true && healthyMediaAfterError.dataUrl === media.dataUrl
        && largeMediaRemoved.ok === true,
      JSON.stringify({ imported: largeMediaImport.ok, exact: exactNativeMedia.ok, over: overNativeMedia.ok,
        error: overNativeMedia.error, healthy: healthyMediaAfterError.ok, removed: largeMediaRemoved.ok }));
  });

  step("media paths resolve their decomposed and percent-encoded spellings", async () => {
    // Issue #260: a macOS-built archive stores media names decomposed (NFD)
    // while the term bank spells them composed, and some converters
    // percent-encode the path. The engine compares bytes, so the worker tries
    // those equivalents before reporting the file missing.
    const spellingTitle = "media-spelling-fixture";
    const composed = "がぞう";
    const spellingSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
    const spellingArchive = buildTitledZip(spellingTitle, { mediaEntries: [
      [`media/${composed.normalize("NFD")}.svg`, spellingSvg],
      [`media/${composed}.png`, makePng()],
    ] });
    const spellingImport = await request("hd_import", { blobUrl: createObjectURL(spellingArchive), fileName: "media-spelling.zip" });
    const spellingMedia = await Promise.all([
      request("hd_media", { generation: spellingImport.generation, dictionary: spellingTitle, path: `media/${composed}.svg` }),
      request("hd_media", { generation: spellingImport.generation, dictionary: spellingTitle, path: `media/${encodeURIComponent(composed)}.png` }),
      request("hd_media", { generation: spellingImport.generation, dictionary: spellingTitle, path: `media/${composed.normalize("NFD")}.png` }),
      request("hd_media", { generation: spellingImport.generation, dictionary: spellingTitle, path: `media/${composed}.gif` }),
    ]);
    const spellingRemoved = await request("hd_remove", { title: spellingTitle });
    check("media paths resolve their decomposed and percent-encoded spellings of the same archive entry",
      spellingImport.ok === true && spellingImport.report.mediaCount === 2
        && spellingMedia[0].ok && spellingMedia[0].dataUrl === `data:image/svg+xml;base64,${spellingSvg.toString("base64")}`
        && spellingMedia[1].ok && spellingMedia[1].dataUrl?.startsWith("data:image/png;base64,")
        && spellingMedia[2].ok && spellingMedia[2].dataUrl === spellingMedia[1].dataUrl
        && spellingMedia[3].ok && spellingMedia[3].dataUrl === null
        && spellingRemoved.ok === true,
      JSON.stringify({ imported: spellingImport.ok, count: spellingImport.report?.mediaCount,
        replies: spellingMedia.map(reply => [reply.ok, reply.dataUrl?.slice(0, 30) ?? null]) }));

    let nativeMediaCalls = 0;
    observedEngine.ccall = (name, ...args) => {
      if (name === "hdw_media") nativeMediaCalls += 1;
      return originalCcall(name, ...args);
    };
    try {
      const reload = engineService.handleEngineMessage({ type: "hd_reload", requestId: "media-reload" });
      const staleMedia = engineService.handleEngineMessage({
        ...mediaMessage, generation: largeMediaRemoved.generation, requestId: "stale-media",
      });
      const [reloadedMedia, stale] = await Promise.all([reload, staleMedia]);
      const invalid = await Promise.all([undefined, -1, 1.5, "1"].map((generation) =>
        engineService.handleEngineMessage({ ...mediaMessage, generation })));
      const callsBeforeCurrent = nativeMediaCalls;
      const current = await engineService.handleEngineMessage({
        ...mediaMessage, generation: reloadedMedia.generation,
      });
      check("queued media rejects stale or invalid generations before native extraction",
        reloadedMedia.ok && stale.ok === false && /generation/u.test(stale.error)
          && invalid.every((reply) => !reply.ok && reply.dataUrl === null)
          && callsBeforeCurrent === 0 && nativeMediaCalls === 1
          && current.ok && current.generation === reloadedMedia.generation && current.dataUrl === media.dataUrl,
        JSON.stringify({ stale: stale.ok, invalid: invalid.map(({ ok }) => ok), callsBeforeCurrent,
          nativeMediaCalls, current: current.ok }));
    } finally {
      observedEngine.ccall = originalCcall;
    }
  });

  step("error paths", async () => {
    section("error paths");
    const bogus = await request("hd_bogus");
    equal("an unknown type is answered, not dropped", [bogus.type, bogus.ok], ["hd_bogus_result", false]);
    check("the unknown-type reply names the type", /hd_bogus/u.test(bogus.error ?? ""), JSON.stringify(bogus.error));

    const badImport = await request("hd_import", {
      blobUrl: createObjectURL(new Uint8Array(await readFile(resolve(HERE, "fixtures/not-a-zip.txt")))),
      fileName: "not-a-zip.txt",
    });
    check("importing a non-zip fails cleanly", badImport.ok === false, JSON.stringify(badImport));
    check("the failed import still carries a report", badImport.report?.success === false, JSON.stringify(badImport.report));
    const afterBadImport = await request("hd_status");
    equal(
      "a failed import restores the previously loaded set",
      [afterBadImport.ready, afterBadImport.dictionaryCount],
      [true, 4],
    );

    const noBlob = await request("hd_import", { blobUrl: "", fileName: "x.zip" });
    check("an import with no blob URL is rejected, not thrown", noBlob.ok === false, JSON.stringify(noBlob));

    const declaredLength = await request("hd_import", {
      blobUrl: createDeclaredLengthURL(formerArchiveByteLimit + 1, zip),
      fileName: "huge.zip",
    });
    equal(
      "a valid archive with a declared length above the former cap imports successfully",
      [declaredLength.ok, declaredLength.report?.title, declaredLength.report?.termCount],
      [true, FIXTURE_TITLE, 6],
    );

    const afterDeclaredLength = await request("hd_status");
    equal(
      "a failed empty import restores the previously loaded set",
      [afterDeclaredLength.ready, afterDeclaredLength.dictionaryCount],
      [true, 4],
    );

    const stateBeforeRejectedReimport = await storedDictionaryState();
    const generationRowsBeforeRejectedReimport = idb.keys("/dicts")
      .filter((path) => path.startsWith("/dicts/.hdw-generation-"))
      .sort();
    storage.failNextSet("injected reimport state CAS failure");
    const rejectedReimport = await request("hd_import", {
      blobUrl: createObjectURL(buildTitledZip(FIXTURE_TITLE)),
      fileName: "rejected-reimport.zip",
    });
    const stateAfterRejectedReimport = await storedDictionaryState();
    const statusAfterRejectedReimport = await request("hd_status");
    const mediaAfterRejectedReimport = await request("hd_media", {
      generation: statusAfterRejectedReimport.generation,
      dictionary: FIXTURE_TITLE,
      path: "media/kanji.png",
    });
    const generationRowsAfterRejectedReimport = idb.keys("/dicts")
      .filter((path) => path.startsWith("/dicts/.hdw-generation-"))
      .sort();
    equal(
      "a failed reimport state CAS preserves the prior stored path and data",
      [
        rejectedReimport.ok,
        stateAfterRejectedReimport,
        statusAfterRejectedReimport.dictionaryCount,
        mediaAfterRejectedReimport.dataUrl,
        generationRowsAfterRejectedReimport,
      ],
      [
        false,
        stateBeforeRejectedReimport,
        4,
        media.dataUrl,
        generationRowsBeforeRejectedReimport,
      ],
    );
  });

  step("real WASM imports AVIF and SVG", async () => {
    // Restore the fixture so this deliberately failing regression does not turn
    // the existing renderer and removal checks into unrelated follow-on failures.
    await request("hd_import", {
      blobUrl: createObjectURL(zip),
      fileName: "restore-after-rejected-reimport.zip",
    });

    const previewFixture = imagePreviewFixture();
    const previewImport = await request("hd_import", {
      blobUrl: createObjectURL(previewFixture.archive), fileName: "image-preview.zip",
    });
    const previewMedia = [];
    for (const image of previewFixture.images) {
      const reply = await request("hd_media", {
        dictionary: previewFixture.title, generation: previewImport.generation, path: image.path,
      });
      previewMedia.push(reply.ok && reply.dataUrl === `data:${image.type};base64,${image.bytes.toString("base64")}`);
    }
    check("real WASM imports AVIF and SVG and returns their exact bytes with the correct MIME types",
      previewImport.ok && previewMedia.every(Boolean), JSON.stringify(previewMedia));
    await request("hd_remove", { title: previewFixture.title });
  });
});

export { kanji, lookup, media };
