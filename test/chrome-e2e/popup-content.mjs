/*
 * The hover highlight, structured content, non-Japanese text and Note drafts.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./kanji.mjs";
import { describe } from "node:test";
import { check, HIGHLIGHT_NAME, step } from "./harness.mjs";
import { highlightSize, hover, popup, tab, verb } from "./reader.mjs";

// Values that more than one step uses; the step that creates each one assigns it.
let hoveredHighlight;

describe("highlights, structured content and Notes", () => {
  step("the hovered word's highlight", async () => {
    // The pointer is still on 食べたかった here, so the extension's own highlight
    // must be registered with at least one range. Asserting CSS.highlights exists
    // would only test Chrome; asserting the extension's name is in it tests the
    // extension.
    hoveredHighlight = await highlightSize();
    check(`the hovered word is highlighted under CSS.highlights["${HIGHLIGHT_NAME}"]`,
      hoveredHighlight >= 1,
      hoveredHighlight === -1
        ? "CSS.highlights is missing entirely"
        : `CSS.highlights.get("${HIGHLIGHT_NAME}") covered ${hoveredHighlight} ranges`);
  });

  step("Escape hides the popup and its highlight", async () => {
    // Both of these are conditioned on the popup having been up in the first
    // place: "it is hidden now" and "the registry is empty now" are true of an
    // extension that never showed anything at all.
    await tab.keyboard.press("Escape");
    const escapeHid = verb !== null && await popup.waitForHidden();
    check("Escape hides the popup", escapeHid,
      `popup shown first: ${verb !== null}, popup state: ${JSON.stringify(await popup.state())}`);
    const dismissedHighlight = await highlightSize();
    check("dismissing the popup clears the extension's highlight",
      hoveredHighlight >= 1 && dismissedHighlight === 0,
      `CSS.highlights.get("${HIGHLIGHT_NAME}") covered ${hoveredHighlight} ranges while hovered`
        + ` and ${dismissedHighlight} after Escape`);
  });

  step("structured content", async () => {
    const sc = await hover("#kanjiword");
    check("hovering 漢字 shows a popup", sc !== null,
      "no .gsm-hoshidicts-popup appeared for 漢字");
    // Text alone cannot tell structured content from prose: a renderer that
    // flattened everything into one text node would satisfy every `includes`
    // below. So each of these names an element.
    const scState = sc ?? { bold: [], lists: [], tables: [], tags: [], text: "" };
    check("structured content renders a bold span element",
      scState.bold.includes("span:Chinese characters"),
      `bold elements: ${JSON.stringify(scState.bold)}\n       popup text: ${scState.text.slice(0, 300)}`);
    // One of the <ul>s belongs to the renderer (one li per sense); the structured
    // content's own list is the one whose two li carry the fixture's items, the
    // second of which is an <em> plus a text node.
    check("structured content renders a ul with its two li",
      scState.lists.filter(li => JSON.stringify(li) ===
        JSON.stringify(["li:kanji", "li:Han characters"])).length === 1,
      `ul contents: ${JSON.stringify(scState.lists)}`);
    check("structured content renders a table with the on and kun rows",
      JSON.stringify(scState.tables) ===
        JSON.stringify([[["th:on", "td:カン"], ["th:kun", "td:あざ"]]]),
      `tables: ${JSON.stringify(scState.tables)}`);

    // hd_media answers asynchronously, so the <img> can arrive a beat after the
    // glossary text it sits in.
    let withImage = scState;
    for (let attempt = 0; attempt < 8; attempt++) {
      if ((withImage.images ?? []).some(src => src.startsWith("data:image/"))) break;
      await new Promise(r => setTimeout(r, 400));
      withImage = (await popup.state()) ?? withImage;
    }
    const src = (withImage.images ?? [])[0] ?? "";
    check("a structured-content image resolves through hd_media to a data: URL",
      src.startsWith("data:image/") && withImage.tags.includes("img"),
      `img src: ${src.slice(0, 80) || "(no img element found)"}`
        + `\n       img elements: ${withImage.tags.filter(tag => tag === "img").length}`);
    if (process.env.HACHIDORI_POPUP_SCREENSHOT) {
      await tab.bringToFront();
      await tab.screenshot({ path: process.env.HACHIDORI_POPUP_SCREENSHOT });
    }
  });

  step("non-Japanese text", async () => {
    // "no popup for latin text" is worth nothing on its own: it passes against an
    // extension whose hover is completely dead. So it is sandwiched between a
    // popup that was on screen the moment before and one that comes back the
    // moment after, from the same hover routine.
    const beforeLatin = await popup.state();
    check("the popup is showing immediately before the non-Japanese hover",
      popup.visible(beforeLatin), `popup state: ${JSON.stringify(beforeLatin)}`);
    // Dismissed first because the popup for 漢字 is tall enough to sit under the
    // #latin paragraph, and a pointer inside the popup keeps it open by design.
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    const latin = await hover("#latin", { attempts: 3 });
    check("hovering non-Japanese text shows no popup",
      popup.visible(beforeLatin) && latin === null,
      `popup shown for 漢字 first: ${popup.visible(beforeLatin)}\n`
        + `       popup state after the latin hover: ${JSON.stringify(latin)}`);
    const control = await hover("#verb");
    check("the same hover shows a popup again after the non-Japanese one",
      control !== null && control.plain.includes("食べる"),
      `popup text: ${control ? control.plain.slice(0, 200) : "(no popup)"}`);
  });

  step("an open Note draft", async () => {
    // Opening the form deliberately suspends the hover-hide path. Escape belongs
    // to the form on its first press and to the popup on its second, even though
    // both live inside a closed shadow root.
    const draftNoteOpened = await popup.click(".gsm-hoshidicts-note-button");
    const draftPrefill = await popup.state();
    const draftValues = await popup.writeNote({ definition: "unsaved hover draft" });
    await tab.mouse.move(2, 2);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
    const preservedDraft = await popup.state();
    await tab.keyboard.press("Escape");
    let afterFirstNoteEscape = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      afterFirstNoteEscape = await popup.state();
      if (popup.visible(afterFirstNoteEscape) && afterFirstNoteEscape?.noteOpen === false) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    await tab.keyboard.press("Escape");
    const noteSecondEscapeHid = await popup.waitForHidden();
    check(
      "an open Note draft survives hover and consumes Escape before popup dismissal",
      draftNoteOpened
        && draftPrefill?.noteOpen === true
        && draftPrefill.noteTerm === "食べる"
        && draftPrefill.noteReading === "たべる"
        && draftPrefill.noteDefinition === ""
        && draftValues?.definition === "unsaved hover draft"
        && popup.visible(preservedDraft)
        && preservedDraft.noteOpen === true
        && preservedDraft.noteDefinition === "unsaved hover draft"
        && popup.visible(afterFirstNoteEscape)
        && afterFirstNoteEscape.noteOpen === false
        && noteSecondEscapeHid,
      JSON.stringify({
        opened: draftNoteOpened,
        prefill: draftPrefill,
        draftValues,
        preservedDraft,
        afterFirstEscape: afterFirstNoteEscape,
        secondEscapeHid: noteSecondEscapeHid,
      }),
    );
  });
});
