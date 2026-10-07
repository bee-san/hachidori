/*
 * Nested lookups from definitions and internal links.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./popup.mjs";
import { describe } from "node:test";
import { nestedLinksFixture } from "../make-fixture.mjs";
import { check, HIGHLIGHT_NAME, step } from "./harness.mjs";
import { forceSourceFallback, hoverForPopup, popupReader } from "./popup-reader.mjs";
import { popup, tab } from "./reader.mjs";
import {
  browser,
  installMediaArchive,
  installMediaReplyProbe,
  page,
  restoreMediaReplyProbe,
} from "./session.mjs";

async function checkNestedLinks(settings, tab, popup, browser) {
  async function waitForPopupState(reader, predicate) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = await reader.state();
      if (reader.visible(state) && predicate(state)) return state;
      if (Date.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const fixture = nestedLinksFixture();
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  const originalStyle = await tab.$eval("#verb", element => element.getAttribute("style"));
  const originalOptions = await settings.evaluate(async () => (await chrome.storage.local.get("options")).options);
  const originalViewport = tab.viewport();
  const child = await popupReader(tab, 1);
  const grandchild = await popupReader(tab, 2);
  const writeOptions = (patch) => settings.evaluate(async (optionsPatch) => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: optionsPatch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  const setDepth = (value) => writeOptions({ popupNestingMaxDepth: value });
  const moveToDefinition = async (hit) => {
    if (!hit?.rect) return false;
    await tab.mouse.move(hit.rect.x + hit.rect.width / 2, hit.rect.y + hit.rect.height / 2);
    return true;
  };
  const bounded = (value) => value && value.rect.width > 0 && value.rect.height > 0
    && value.rect.left >= 5 && value.rect.top >= 5
    && value.rect.right <= value.viewport.width - 5 && value.rect.bottom <= value.viewport.height - 5;
  // Yomitan-style placement: left aligned with the source rectangle (clamped
  // to the viewport), hanging below it or rising above it by the popup gap.
  // A pane the viewport had to clamp vertically touches an edge instead.
  const anchoredTo = (rect, anchor, viewport, scale = 1) => {
    if (!rect || !anchor || !viewport) return { ok: false, rect, anchor };
    const near = (a, b) => Math.abs(a - b) <= 1.5;
    const gap = 4 * scale, padding = 6 * scale;
    const leftAligned = near(rect.left, Math.max(padding, Math.min(anchor.left, viewport.width - rect.width - padding)));
    const below = near(rect.top, anchor.bottom + gap);
    const above = near(rect.bottom, anchor.top - gap);
    const clamped = near(rect.top, padding) || near(rect.bottom, viewport.height - padding);
    return { ok: leftAligned && (below || above || clamped), leftAligned, below, above, clamped };
  };
  const toolbarPreference = originalOptions.popupToolbarPosition ?? "auto";
  const toolbarFollows = (layout, anchored) => Boolean(layout) && (toolbarPreference !== "auto"
    ? layout.toolbar === toolbarPreference
    : anchored.below ? layout.toolbar === "top"
      : anchored.above ? layout.toolbar === "bottom" : ["top", "bottom"].includes(layout.toolbar));
  const inside = (rect, point) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  const pointOutside = (rect, cover) => [
    { x: rect.left + 8, y: rect.top + 8 }, { x: rect.left + 8, y: rect.bottom - 8 },
    { x: rect.right - 8, y: rect.top + 8 }, { x: rect.right - 8, y: rect.bottom - 8 },
  ].find(point => !inside(cover, point)) ?? { x: rect.left + 8, y: rect.top + 8, covered: true };
  let definitionEvidence;
  let triggerEvidence;
  let evidence;
  let clickEvidence;
  let stickyEvidence;
  const highlights = () => tab.evaluate(name => Array.from(CSS.highlights.get(name) ?? [], range => range.toString()), HIGHLIGHT_NAME);
  async function until(read, predicate, label) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now() >= deadline) return { timedOut: label, value };
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  // Issue #299 with a real mouse: children hang from their source text and a
  // primary click in an ancestor retires descendants at once. The hide delay
  // is raised to its maximum so no timer can explain a dismissal here.
  async function nestedClickScenario() {
    const evidence = {};
    const sizes = { popupWidthPx: originalOptions.popupWidthPx ?? 560, popupHeightPx: originalOptions.popupHeightPx ?? 420,
      popupScalePercent: originalOptions.popupScalePercent ?? 100 };
    let worker = null;
    const openChild = async () => {
      const source = await popup.nested("focus-link");
      await tab.keyboard.press("Enter");
      const state = await waitForPopupState(child, value => value.plain.includes(fixture.child));
      return { source, state, layout: await child.nested() };
    };
    const openGrandchild = async () => {
      const source = await child.nested("focus-link");
      await tab.keyboard.press("Enter");
      const state = await waitForPopupState(grandchild, value => value.plain.includes(fixture.grandchild));
      return { source, state, layout: await grandchild.nested() };
    };
    const depths = async () => (await popup.nested())?.depths;
    // Click the first glyph of plain glossary text; report whether a
    // descendant pane covered that point so a miss stays diagnosable.
    const clickText = async (reader, text) => {
      const hit = await reader.definitionTextRect(text);
      if (!hit) return { text: null };
      const point = { x: hit.rect.x + hit.rect.width / 2, y: hit.rect.y + hit.rect.height / 2 };
      const covers = [];
      for (const pane of reader === popup ? [child, grandchild] : [grandchild]) covers.push((await pane.nested())?.rect);
      await tab.mouse.click(point.x, point.y);
      return { text: hit.text, covered: covers.some(rect => rect && inside(rect, point)) };
    };
    try {
      await setDepth(2);
      await writeOptions({ popupHideDelayMs: 5000, onlyScanJapaneseText: true });
      const chainChild = await openChild();
      const chainGrandchild = await openGrandchild();
      evidence.chain = { rootLink: chainChild.source.linkRect, child: chainChild.layout,
        childLink: chainGrandchild.source.linkRect, grandchild: chainGrandchild.layout,
        grandchildFocused: chainGrandchild.state?.focusedClass ?? "", highlights: await highlights() };
      // The parent's content scroll moves the grandchild with its link.
      await writeOptions({ popupWidthPx: 280, popupHeightPx: 200 });
      const shrunkChild = await until(() => child.nested(), value => value?.rect.width === 280, "shrunk child");
      const unscrolledLink = shrunkChild.linkRect;
      const scrolled = await child.dictionaryTabs("scroll", 40);
      const scrolledChild = await child.nested();
      const followed = await until(() => grandchild.nested(),
        value => anchoredTo(value?.rect, scrolledChild.linkRect, value?.viewport).ok, "grandchild follows parent scroll");
      evidence.scroll = { scrollTop: scrolled?.scrollTop, unscrolledLink, scrolledLink: scrolledChild.linkRect, grandchild: followed };
      // Popup scale converts the source rectangle once for every pane.
      await writeOptions({ popupScalePercent: 75 });
      const scaledChild = await until(() => child.nested(), value => value?.rect.width === 210, "scaled child");
      evidence.scaled = { rootLink: (await popup.nested())?.linkRect, child: scaledChild,
        grandchild: await until(() => grandchild.nested(), value => value?.rect.width === 210, "scaled grandchild") };
      await writeOptions(sizes);
      await until(() => child.nested(), value => value?.rect.width === sizes.popupWidthPx, "restored child size");
      // 1. A click on plain text in the child retires the focused grandchild
      //    at once and keeps the child and root.
      const childClick = await clickText(child, "The referenced entry.");
      evidence.childClick = { ...childClick, grandchild: await grandchild.state(), child: await child.state(),
        root: await popup.state(), depths: await depths(), highlights: await highlights() };
      // 2. A hover-opened grandchild and its parent both fall to a root click.
      const hoverSource = await child.definitionTextRect(fixture.grandchild);
      await moveToDefinition(hoverSource);
      const hoverGrandchild = await waitForPopupState(grandchild, value => value.plain.includes(fixture.grandchild));
      const hoverLayout = await grandchild.nested();
      const rootBefore = await popup.state();
      const rootClick = await clickText(popup, "A linked definition.");
      evidence.rootClick = { ...rootClick, hoverGrandchild: Boolean(hoverGrandchild), hoverSource: hoverSource?.rect, hoverLayout,
        depths: await depths(), child: await child.state(), grandchild: await grandchild.state(),
        root: await popup.state(), rootBefore, highlights: await highlights() };
      // 3. An open child draft protects it from the root click; Escape closes
      //    the form first, after which the same click dismisses the child.
      await openChild();
      await child.click(".gsm-hoshidicts-note-button");
      const draft = await child.writeNote({ definition: "draft survives a parent click" });
      const draftClick = await clickText(popup, "A linked definition.");
      evidence.draftClick = { ...draftClick, draft, child: await child.state(), depths: await depths() };
      await tab.keyboard.press("Escape");
      evidence.formClosed = await child.state();
      const closedClick = await clickText(popup, "A linked definition.");
      evidence.closedDraftClick = { ...closedClick, depths: await depths(), child: await child.state() };
      // 4. A grandchild lookup still pending at the click cannot reopen it.
      worker = await installMediaReplyProbe(browser, settings);
      await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
      await openChild();
      await child.nested("blur");
      await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
      await moveToDefinition(await child.definitionTextRect(fixture.grandchild));
      const held = await worker.evaluate(async () => {
        const deadline = Date.now() + 10_000;
        while (!globalThis.__ownedMediaProbe.heldLookups.length) {
          if (Date.now() >= deadline) return false;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return true;
      });
      const heldDepths = await depths();
      const pendingClick = await clickText(popup, "A linked definition.");
      const dismissedDepths = await depths();
      await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.heldLookups.splice(0)) release(); });
      await settle(500);
      evidence.pending = { ...pendingClick, held, heldDepths, dismissedDepths, afterRelease: await depths(),
        grandchild: await grandchild.state(), child: await child.state(), root: await popup.state() };
      // 5. A real click on the child's link keeps its same-query grandchild
      //    without another lookup: a link press leaves that link's own child
      //    to the click, which reuses it. (The grandchild never covers the
      //    link it hangs from; the root's link may sit under a deeper pane.)
      await openChild();
      const linkGrandchild = await openGrandchild();
      const lookupsBefore = await worker.evaluate(() => globalThis.__ownedMediaProbe.lookups.length);
      const linkPoint = linkGrandchild.source.linkPoint;
      await tab.mouse.click(linkPoint.x, linkPoint.y);
      await settle(300);
      evidence.linkClick = { depths: await depths(), grandchild: await grandchild.state(),
        covered: Boolean(linkGrandchild.layout?.rect && inside(linkGrandchild.layout.rect, linkPoint)),
        lookups: (await worker.evaluate(() => globalThis.__ownedMediaProbe.lookups.length)) - lookupsBefore };
      return evidence;
    } finally {
      if (worker) await restoreMediaReplyProbe(worker);
      await writeOptions({ ...sizes, popupHideDelayMs: originalOptions.popupHideDelayMs ?? 160,
        onlyScanJapaneseText: originalOptions.onlyScanJapaneseText ?? true });
    }
  }
  // Issue #360 with a real mouse, at the reported 800x900 panes in a 1920x945
  // window: a child that fits on neither side of its link hangs from it,
  // shortened, and the default activationSticky mode keeps it through the
  // pointer's return to the parent until a primary click there. The pointer
  // ends back at `restorePoint` before Hover mode resumes.
  async function stickyLargeChildScenario(restorePoint) {
    const evidence = {};
    const viewport = tab.viewport();
    await writeOptions({ lookupMode: "activationSticky", popupWidthPx: 800, popupHeightPx: 900 });
    try {
      await tab.setViewport({ width: 1920, height: 945 });
      const root = evidence.root = await until(() => popup.nested(),
        value => value?.rect.width === 800 && value.viewport.height === 945, "large sticky root");
      if (!root?.linkPoint) return evidence;
      await tab.mouse.click(root.linkPoint.x, root.linkPoint.y);
      evidence.opened = Boolean(await waitForPopupState(child, value => value.plain.includes(fixture.child)));
      const layout = evidence.layout = await child.nested();
      const text = await popup.definitionTextRect("A linked definition.");
      if (!layout || !text) return evidence;
      const point = { x: text.rect.x + text.rect.width / 2, y: text.rect.y + text.rect.height / 2 };
      evidence.point = { ...point, covered: inside(layout.rect, point) };
      await tab.mouse.move(layout.rect.right - 8, layout.rect.bottom - 8);
      await tab.mouse.move(point.x, point.y);
      await settle(400);
      evidence.kept = child.visible(await child.state());
      await tab.mouse.click(point.x, point.y);
      evidence.pressed = await child.waitForHidden();
      evidence.rootKept = popup.visible(await popup.state());
      return evidence;
    } finally {
      await writeOptions({ popupWidthPx: originalOptions.popupWidthPx ?? 560, popupHeightPx: originalOptions.popupHeightPx ?? 420 });
      await tab.setViewport(viewport);
      if (restorePoint) await tab.mouse.move(restorePoint.x, restorePoint.y);
      await writeOptions({ lookupMode: originalOptions.lookupMode ?? "hover" });
    }
  }
  await installMediaArchive(settings, fixture.archive);
  try {
    await setDepth(2);
    await writeOptions({ lookupMode: "hover", definitionLookupMode: "inherit" });
    await tab.setViewport({ width: 1880, height: 960 });
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    const definitionSource = await popup.definitionTextRect(fixture.child);
    const definitionFocus = await popup.nested("focus-link");
    await moveToDefinition(definitionSource);
    const definitionChild = await waitForPopupState(child,
      state => state.plain.includes(fixture.child));
    const definitionParent = await popup.state();
    const definitionChildLayout = await child.nested();
    // The focused ancestor deliberately stayed focused while its definition
    // opened a child. Escape must now target the deepest pane, not that ancestor.
    await popup.nested("blur");
    const definitionClose = definitionChild?.closeControl;
    const definitionClosed = await child.click(".gsm-hoshidicts-popup-close") && await child.waitForHidden();
    if (definitionClosed) {
      await moveToDefinition(definitionSource);
      await waitForPopupState(child, state => state.plain.includes(fixture.child));
    }
    const definitionGrandchildSource = await child.definitionTextRect(fixture.grandchild);
    await moveToDefinition(definitionGrandchildSource);
    const definitionGrandchild = await waitForPopupState(grandchild,
      state => state.plain.includes(fixture.grandchild));
    const definitionChain = await grandchild.nested();
    const definitionHighlights = await tab.evaluate(name =>
      [...(CSS.highlights.get(name) || [])].map(range => range.toString()), HIGHLIGHT_NAME);
    if (definitionGrandchild) {
      await tab.keyboard.press("Escape");
      await grandchild.waitForHidden();
    }
    if (definitionChild) {
      await tab.keyboard.press("Escape");
      await child.waitForHidden();
    }

    const missingSource = await popup.definitionTextRect(fixture.missing);
    await moveToDefinition(missingSource);
    await new Promise(resolve => setTimeout(resolve, 800));
    const missingParent = await popup.state();
    const missingChild = await child.state();

    await setDepth(0);
    await moveToDefinition(definitionSource);
    await new Promise(resolve => setTimeout(resolve, 500));
    const depthDisabledChild = await child.state();
    await setDepth(2);

    await writeOptions({ lookupMode: "activation", activationKey: "Shift" });
    const activationFocus = await popup.nested("focus-link");
    await moveToDefinition(definitionSource);
    await new Promise(resolve => setTimeout(resolve, 500));
    const activationGated = !child.visible(await child.state());
    let activationChild;
    await tab.keyboard.down("Shift");
    try {
      activationChild = await waitForPopupState(child,
        state => state.plain.includes(fixture.child));
    } finally {
      await tab.keyboard.up("Shift");
    }
    await popup.nested("blur");
    if (activationChild) {
      await tab.keyboard.press("Escape");
      await child.waitForHidden();
    }
    await popup.nested("focus-link");
    await writeOptions({
      activationKey: originalOptions.activationKey ?? "Shift",
      lookupMode: originalOptions.lookupMode ?? "hover",
    });
    // Issue #355 with the real mouse and keyboard while the page stays on
    // Hover: sweeping, resting and wheeling over definitions opens nothing
    // until the key is held or, in Click mode, a word is clicked.
    const centre = hit => ({ x: hit.rect.x + hit.rect.width / 2, y: hit.rect.y + hit.rect.height / 2 });
    triggerEvidence = {};
    await writeOptions({ lookupMode: "hover", activationKey: "Shift", definitionLookupMode: "activation" });
    await popup.nested("blur");
    const sweep = [await popup.definitionTextRect("A linked definition."), await popup.definitionTextRect(fixture.child),
      await popup.definitionTextRect(fixture.missing)];
    triggerEvidence.sweep = sweep.map(hit => hit?.text ?? null);
    if (sweep.every(Boolean)) {
      await tab.mouse.move(centre(sweep[0]).x, centre(sweep[0]).y);
      for (const hit of sweep.slice(1)) await tab.mouse.move(centre(hit).x, centre(hit).y, { steps: 12 });
      await tab.mouse.wheel({ deltaY: 240 });
      await tab.mouse.wheel({ deltaY: -240 });
      await moveToDefinition(await popup.definitionTextRect(fixture.child));
      await settle(500);
    }
    triggerEvidence.keySwept = await child.state();
    await tab.keyboard.down("Shift");
    try {
      triggerEvidence.keyChild = await waitForPopupState(child, state => state.plain.includes(fixture.child));
    } finally {
      await tab.keyboard.up("Shift");
    }
    await settle(300);
    triggerEvidence.keyReleased = await child.state();
    if (child.visible(triggerEvidence.keyReleased)) {
      await tab.keyboard.press("Escape");
      await child.waitForHidden();
    }
    await writeOptions({ definitionLookupMode: "click" });
    const clickSource = await popup.definitionTextRect(fixture.child);
    await moveToDefinition(clickSource);
    await tab.keyboard.down("Shift");
    await settle(400);
    await tab.keyboard.up("Shift");
    triggerEvidence.clickHovered = await child.state();
    if (clickSource) await tab.mouse.click(centre(clickSource).x, centre(clickSource).y);
    triggerEvidence.clickChild = await waitForPopupState(child, state => state.plain.includes(fixture.child));
    const clickLayout = await child.nested();
    triggerEvidence.clickPlacement = anchoredTo(clickLayout?.rect, clickSource?.rect, clickLayout?.viewport);
    if (triggerEvidence.clickChild) {
      await tab.keyboard.press("Escape");
      await child.waitForHidden();
    }
    const dragStart = await popup.definitionTextRect("A linked definition.");
    if (dragStart && clickSource) {
      // Press near the glyph's edge, as the page drags do: a synthetic press
      // at a glyph's midpoint did not start a selection in headless Chrome.
      await tab.mouse.move(dragStart.rect.x + 1, centre(dragStart).y);
      await tab.mouse.down();
      try {
        await tab.mouse.move(centre(clickSource).x, centre(clickSource).y, { steps: 8 });
      } finally {
        await tab.mouse.up();
      }
      await settle(500);
    }
    triggerEvidence.dragged = await child.state();
    triggerEvidence.dragSelection = await tab.evaluate(() => {
      const selection = document.querySelector("hachidori-host")?.shadowRoot?.getSelection?.();
      const text = selection?.toString() ?? "";
      selection?.removeAllRanges();
      window.getSelection().removeAllRanges();
      return text;
    });
    await popup.nested("focus-link");
    await writeOptions({ definitionLookupMode: originalOptions.definitionLookupMode ?? "inherit",
      lookupMode: originalOptions.lookupMode ?? "hover" });
    definitionEvidence = {
      activationChild,
      activationFocus,
      activationGated,
      definitionChain,
      definitionChild,
      definitionChildLayout,
      definitionClose,
      definitionClosed,
      definitionFocus,
      definitionGrandchild,
      definitionGrandchildSource,
      definitionHighlights,
      definitionParent,
      definitionSource,
      depthDisabledChild,
      missingChild,
      missingParent,
      missingSource,
    };
    const linkParent = await popup.state();
    const linkSourceHighlights = await highlights();
    if (!popup.visible(linkParent) || !linkParent.plain.includes(fixture.query)
        || JSON.stringify(linkSourceHighlights) !== JSON.stringify([fixture.query])) {
      throw new Error(`Nested link setup lost its parent source: ${JSON.stringify({ linkParent, linkSourceHighlights })}`);
    }
    await tab.evaluate(name => {
      window.__sourceAncestorRanges = [...CSS.highlights.get(name)];
    }, HIGHLIGHT_NAME);
    await popup.nested("remember");
    const source = await popup.nested("focus-link");
    await tab.mouse.click(source.linkPoint.x, source.linkPoint.y);
    const mouseChild = await child.waitForVisible();
    const mousePosition = await child.nested();
    let childHoverRetained = false;
    let returnPoint = null;
    if (mousePosition) {
      await popup.nested("blur");
      // A child now overlaps its parent below the source link, so the pointer
      // enters it directly; resting inside it must outlast the hide delay.
      await tab.mouse.move(mousePosition.rect.right - 8, mousePosition.rect.bottom - 8);
      await new Promise(resolve => setTimeout(resolve, 300));
      childHoverRetained = child.visible(await child.state());
      returnPoint = pointOutside(source.rect, mousePosition.rect);
      await tab.mouse.move(returnPoint.x, returnPoint.y);
    }
    const pointerReturn = await child.waitForHidden();
    // Issue #363: with Hide popup on cursor exit on, the same return closes
    // the child in sticky mode too, after the option's delay rather than the
    // raised Hide delay.
    let stickyReturn = null;
    if (mousePosition && !returnPoint.covered) {
      await writeOptions({ lookupMode: "activationSticky", popupHideDelayMs: 5000,
        hidePopupOnCursorExit: true, hidePopupOnCursorExitDelayMs: 300 });
      await tab.mouse.click(source.linkPoint.x, source.linkPoint.y);
      const reopened = await child.waitForVisible();
      const stickyPosition = await child.nested();
      await popup.nested("blur");
      await tab.mouse.move(stickyPosition.rect.right - 8, stickyPosition.rect.bottom - 8);
      await settle(500);
      const retainedInside = child.visible(await child.state());
      const back = pointOutside(source.rect, stickyPosition.rect);
      await tab.mouse.move(back.x, back.y);
      stickyReturn = { reopened: reopened !== null, retainedInside, back, hidden: await child.waitForHidden(2500) };
      await writeOptions({ lookupMode: originalOptions.lookupMode ?? "hover",
        popupHideDelayMs: originalOptions.popupHideDelayMs ?? 160, hidePopupOnCursorExit: false,
        hidePopupOnCursorExitDelayMs: originalOptions.hidePopupOnCursorExitDelayMs ?? 160 });
    }
    stickyEvidence = await stickyLargeChildScenario(returnPoint);
    await writeOptions({ lookupMode: "hover", definitionLookupMode: "inherit" });
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    const first = await waitForPopupState(child, state => state.plain.includes(fixture.child)
      && state.imageStates.length === 1 && state.imageStates[0].width === 16);
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    const repeatedKeyboardFocus = (await child.state()).focusedClass;
    const existingGrandchild = await grandchild.state();
    if (grandchild.visible(existingGrandchild)) {
      await grandchild.click(".gsm-hoshidicts-popup-close");
      await grandchild.waitForHidden();
      await popup.nested("focus-link");
      await tab.keyboard.press("Enter");
    }
    const focusedDefinitionSource = await child.definitionTextRect(fixture.grandchild);
    await moveToDefinition(focusedDefinitionSource);
    const focusedPointerGrandchild = await waitForPopupState(grandchild,
      state => state.plain.includes(fixture.grandchild));
    const focusedPointerChild = await child.state();
    const focusedPointerClosed = grandchild.visible(focusedPointerGrandchild)
      && await grandchild.click(".gsm-hoshidicts-popup-close") && await grandchild.waitForHidden();
    const chain = await child.nested();
    await child.click(".gsm-hoshidicts-note-button");
    const draft = await child.writeNote({ definition: "child draft survives parent Note" });
    await popup.click(".gsm-hoshidicts-note-button");
    await popup.writeNote({ definition: "independent parent draft" });
    const parentDraft = await popup.state();
    const childDraft = await child.state();
    await tab.keyboard.press("Escape");
    const parentClosed = await popup.state();
    const childStillEditing = await child.state();
    await tab.keyboard.press("Escape");
    const secondSource = await child.nested("focus-link");
    await tab.keyboard.press("Enter");
    const second = await waitForPopupState(grandchild, state => state.plain.includes(fixture.grandchild)
      && state.imageStates.length === 1 && state.imageStates[0].width === 16);
    const fullChain = await grandchild.nested();
    const fullHighlights = await tab.evaluate(name => {
      const ranges = [...(CSS.highlights.get(name) || [])];
      const rootRetained = ranges[0] === window.__sourceAncestorRanges[0];
      window.__sourceAncestorRanges = ranges;
      return { rootRetained, texts: ranges.map(range => range.toString()) };
    }, HIGHLIGHT_NAME);
    await grandchild.nested("focus-link");
    await tab.keyboard.press("Enter");
    const limited = await grandchild.nested();
    if (process.env.HACHIDORI_NESTED_SCREENSHOT) {
      await tab.screenshot({ path: process.env.HACHIDORI_NESTED_SCREENSHOT });
    }
    await tab.setViewport({ width: 520, height: 740 });
    await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const narrowRoot = await popup.nested();
    const narrowChild = await child.nested();
    const narrow = await grandchild.nested();
    await tab.setViewport({ width: 1880, height: 960 });
    await setDepth(1);
    const lowered = await grandchild.waitForHidden();
    await child.click(".gsm-hoshidicts-kanji-link");
    const kanji = await waitForPopupState(child, state => state.hasBack && !state.plain.includes("The referenced entry."));
    await child.click(".gsm-hoshidicts-kanji-back");
    const back = await waitForPopupState(child, state => state.plain.includes("The referenced entry."));
    const returnedWithClose = await child.click(".gsm-hoshidicts-popup-close");
    if (!returnedWithClose) await child.click(".gsm-hoshidicts-kanji-back");
    const returned = await child.waitForHidden();
    const retained = await popup.nested();
    const ancestorHighlight = await tab.evaluate(name => {
      const ranges = [...(CSS.highlights.get(name) || [])];
      const same = ranges.length === 1 && ranges[0] === window.__sourceAncestorRanges[0];
      delete window.__sourceAncestorRanges;
      return { same, text: ranges[0]?.toString() };
    }, HIGHLIGHT_NAME);
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    await child.waitForVisible();
    const linkRects = await tab.evaluate(name => Array.from([...CSS.highlights.get(name)][1]
      .getClientRects(), rect => rect.toJSON()), HIGHLIGHT_NAME);
    const restoreHighlight = await forceSourceFallback(tab, settings);
    let fallback;
    try {
      const before = await popup.sourcePaint("remember");
      await child.sourcePaint("cover-parent");
      await tab.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const covered = await popup.sourcePaint();
      await child.click(".gsm-hoshidicts-popup-close");
      await child.waitForHidden();
      await tab.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const after = await popup.sourcePaint("forget");
      fallback = { before, covered, after, linkRects };
    } finally { await restoreHighlight(); }
    check("nested source highlights retain ancestor ownership when children close in native and fallback modes",
      fullHighlights.rootRetained && fullHighlights.texts.length === 3
        && fullHighlights.texts.every(Boolean) && ancestorHighlight.same && ancestorHighlight.text === fixture.query
        && fallback.before.groups === 2 && fallback.before.ownerRects[1].length > 0
        && fallback.before.ownerRects[1].every(rect => linkRects.some(source => rect.left >= source.left - 1
          && rect.right <= source.right + 1 && rect.top >= source.top - 1 && rect.bottom <= source.bottom + 1))
        && fallback.covered.ownerRects[0].length === 0
        && fallback.after.groups === 1 && fallback.after.sameOwner && fallback.after.ownerRects[0].length > 0,
      JSON.stringify({ fullHighlights, ancestorHighlight, fallback }));
    clickEvidence = await nestedClickScenario();
    await setDepth(0);
    await popup.nested("focus-link");
    await tab.keyboard.press("Enter");
    const disabled = await popup.nested();
    const refreshedControls = await checkRetainedLinkControls(browser, settings, tab, popup, child, fixture, setDepth);
    evidence = { source, mouseChild, mousePosition, childHoverRetained, returnPoint, pointerReturn, stickyReturn, first, repeatedKeyboardFocus,
      focusedDefinitionSource, focusedPointerChild, focusedPointerGrandchild, focusedPointerClosed, chain, draft, parentDraft, childDraft, parentClosed, childStillEditing,
      secondSource, second, fullChain, limited, narrowRoot, narrowChild, narrow, lowered, kanji, back, returnedWithClose, returned, retained, disabled, refreshedControls };
  } finally {
    await writeOptions({
      activationKey: originalOptions.activationKey ?? "Shift",
      lookupMode: originalOptions.lookupMode ?? "hover",
      definitionLookupMode: originalOptions.definitionLookupMode ?? "inherit",
      popupNestingMaxDepth: originalOptions.popupNestingMaxDepth ?? 10,
    });
    const removed = await settings.evaluate(title => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_remove", title,
    }), fixture.title);
    if (!removed.ok) throw new Error(removed.error);
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
    await tab.$eval("#verb", (element, style) => {
      if (style === null) element.removeAttribute("style"); else element.setAttribute("style", style);
    }, originalStyle);
    await tab.setViewport(originalViewport);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
  }
  check("plain definition text opens nested child lookups with native hover, activation, miss and depth behavior",
    definitionEvidence.definitionSource?.text === fixture.child[0]
      && definitionEvidence.definitionFocus?.linkFocused
      && definitionEvidence.definitionChild?.plain.includes(fixture.child)
      && definitionEvidence.definitionParent?.plain.includes(fixture.query)
      && bounded(definitionEvidence.definitionChildLayout)
      && definitionEvidence.definitionGrandchildSource?.text === fixture.grandchild[0]
      && definitionEvidence.definitionGrandchild?.plain.includes(fixture.grandchild)
      && bounded(definitionEvidence.definitionChain)
      && JSON.stringify(definitionEvidence.definitionChain.depths) === "[0,1,2]"
      && definitionEvidence.definitionHighlights.includes(fixture.query)
      && definitionEvidence.definitionHighlights.includes(fixture.child)
      && definitionEvidence.definitionHighlights.includes(fixture.grandchild)
      && definitionEvidence.missingSource?.text === fixture.missing[0]
      && definitionEvidence.missingParent?.plain.includes(fixture.query)
      && !child.visible(definitionEvidence.missingChild)
      && !child.visible(definitionEvidence.depthDisabledChild)
      && definitionEvidence.activationGated
      && definitionEvidence.activationFocus?.linkFocused
      && definitionEvidence.activationChild?.plain.includes(fixture.child),
    JSON.stringify(definitionEvidence));
  check("definition text can wait for the activation key or a click in Hover mode",
    JSON.stringify(triggerEvidence.sweep) === JSON.stringify(["A", fixture.child[0], fixture.missing[0]])
      && !child.visible(triggerEvidence.keySwept)
      && triggerEvidence.keyChild?.plain.includes(fixture.child) && child.visible(triggerEvidence.keyReleased)
      && !child.visible(triggerEvidence.clickHovered)
      && triggerEvidence.clickChild?.plain.includes(fixture.child)
      && triggerEvidence.clickPlacement.ok && (triggerEvidence.clickPlacement.below || triggerEvidence.clickPlacement.above)
      && !child.visible(triggerEvidence.dragged) && triggerEvidence.dragSelection.length > 0,
    JSON.stringify(triggerEvidence));
  check("nested definition lookups use an accessible close control that dismisses the child popup",
    definitionEvidence.definitionClose?.label === "Close lookup"
      && definitionEvidence.definitionClose.text === ""
      && definitionEvidence.definitionClosed, JSON.stringify(definitionEvidence));
  check("nested kanji navigation keeps Back and restores the term lookup close control",
    evidence.kanji?.hasBack && evidence.kanji.closeControl === null
      && evidence.back?.closeControl?.label === "Close lookup"
      && !evidence.back.hasBack && evidence.returnedWithClose && evidence.returned,
    JSON.stringify({ kanji: evidence.kanji, back: evidence.back, returned: evidence.returned }));
  check("repeated keyboard activation returns focus to an existing child lookup close control",
    evidence.repeatedKeyboardFocus.includes("gsm-hoshidicts-popup-close"),
    JSON.stringify({ focusedClass: evidence.repeatedKeyboardFocus }));
  check("focused popup controls allow inherited definition pointer lookups",
    evidence.focusedDefinitionSource?.text === fixture.grandchild[0]
      && evidence.focusedPointerChild?.plain.includes(fixture.child)
      && evidence.focusedPointerGrandchild?.plain.includes(fixture.grandchild)
      && grandchild.visible(evidence.focusedPointerGrandchild) && evidence.focusedPointerClosed,
    JSON.stringify({ source: evidence.focusedDefinitionSource, child: evidence.focusedPointerChild,
      grandchild: evidence.focusedPointerGrandchild, closed: evidence.focusedPointerClosed }));
  check("internal links open a positioned popup chain with level-local Note and Back and live depth limits",
    evidence.source.query === fixture.child && evidence.source.reading === fixture.reading
      && evidence.mouseChild !== null && evidence.childHoverRetained && !evidence.returnPoint?.covered && evidence.pointerReturn
      && evidence.first?.plain.includes(fixture.child) && bounded(evidence.chain)
      && evidence.chain.sameParent && evidence.chain.sameAnchor && evidence.chain.imagesReady
      && evidence.draft?.term === fixture.child && evidence.draft.reading === fixture.reading
      && evidence.parentDraft.noteDefinition === "independent parent draft"
      && evidence.childDraft.noteDefinition === "child draft survives parent Note"
      && !evidence.parentClosed.noteOpen && evidence.childStillEditing.noteOpen
      && evidence.second?.plain.includes(fixture.grandchild) && bounded(evidence.fullChain)
      && JSON.stringify(evidence.limited.depths) === "[0,1,2]"
      && bounded(evidence.narrow)
      && evidence.lowered && evidence.kanji && evidence.back && evidence.returned
      && evidence.retained.sameParent && evidence.retained.sameAnchor && evidence.retained.imagesReady
      && JSON.stringify(evidence.disabled.depths) === "[0]"
      && evidence.refreshedControls.every(value => value === true), JSON.stringify(evidence));
  check("hide popup on cursor exit closes a sticky child after its own delay once the pointer returns to the parent",
    evidence.stickyReturn?.reopened && evidence.stickyReturn.retainedInside && !evidence.stickyReturn.back.covered
      && evidence.stickyReturn.hidden, JSON.stringify(evidence.stickyReturn));
  const placement = {
    hoverChild: anchoredTo(definitionEvidence.definitionChildLayout?.rect, definitionEvidence.definitionSource?.rect,
      definitionEvidence.definitionChildLayout?.viewport),
    hoverGrandchild: anchoredTo(definitionEvidence.definitionChain?.rect, definitionEvidence.definitionGrandchildSource?.rect,
      definitionEvidence.definitionChain?.viewport),
    mouseChild: anchoredTo(evidence.mousePosition?.rect, evidence.source.linkRect, evidence.mousePosition?.viewport),
    keyboardChild: anchoredTo(evidence.chain?.rect, evidence.source.linkRect, evidence.chain?.viewport),
    keyboardGrandchild: anchoredTo(evidence.fullChain?.rect, evidence.secondSource?.linkRect, evidence.fullChain?.viewport),
    scenarioChild: anchoredTo(clickEvidence.chain?.child?.rect, clickEvidence.chain?.rootLink, clickEvidence.chain?.child?.viewport),
    scenarioGrandchild: anchoredTo(clickEvidence.chain?.grandchild?.rect, clickEvidence.chain?.childLink, clickEvidence.chain?.grandchild?.viewport),
    scrolledGrandchild: anchoredTo(clickEvidence.scroll?.grandchild?.rect, clickEvidence.scroll?.scrolledLink, clickEvidence.scroll?.grandchild?.viewport),
    scaledChild: anchoredTo(clickEvidence.scaled?.child?.rect, clickEvidence.scaled?.rootLink, clickEvidence.scaled?.child?.viewport, 0.75),
    scaledGrandchild: anchoredTo(clickEvidence.scaled?.grandchild?.rect, clickEvidence.scaled?.child?.linkRect,
      clickEvidence.scaled?.grandchild?.viewport, 0.75),
    narrowChild: anchoredTo(evidence.narrowChild?.rect, evidence.narrowRoot?.linkRect, evidence.narrowChild?.viewport),
    narrowGrandchild: anchoredTo(evidence.narrow?.rect, evidence.narrowChild?.linkRect, evidence.narrow?.viewport),
  };
  const beside = anchored => anchored.ok && (anchored.below || anchored.above);
  check("linked and hovered children open beside their source text and follow parent scroll, popup scale and narrow viewports",
    beside(placement.hoverChild) && toolbarFollows(definitionEvidence.definitionChildLayout, placement.hoverChild)
      && beside(placement.hoverGrandchild) && beside(placement.mouseChild) && toolbarFollows(evidence.mousePosition, placement.mouseChild)
      && beside(placement.keyboardChild) && beside(placement.keyboardGrandchild)
      && beside(placement.scenarioChild) && toolbarFollows(clickEvidence.chain?.child, placement.scenarioChild)
      && beside(placement.scenarioGrandchild) && toolbarFollows(clickEvidence.chain?.grandchild, placement.scenarioGrandchild)
      && clickEvidence.scroll?.scrollTop >= 20
      && clickEvidence.scroll.scrolledLink.top <= clickEvidence.scroll.unscrolledLink.top - 20
      && placement.scrolledGrandchild.ok && placement.scaledChild.ok && placement.scaledGrandchild.ok
      && clickEvidence.scaled?.child?.rect.width === 210 && clickEvidence.scaled?.grandchild?.rect.width === 210
      && placement.narrowChild.ok && placement.narrowGrandchild.ok && bounded(evidence.narrowChild) && bounded(evidence.narrow),
    JSON.stringify({ placement, hover: { source: definitionEvidence.definitionSource, child: definitionEvidence.definitionChildLayout,
      grandchildSource: definitionEvidence.definitionGrandchildSource, grandchild: definitionEvidence.definitionChain },
    mouse: { link: evidence.source.linkRect, child: evidence.mousePosition }, chain: clickEvidence.chain, scroll: clickEvidence.scroll,
    scaled: clickEvidence.scaled, narrow: { root: evidence.narrowRoot, child: evidence.narrowChild, grandchild: evidence.narrow } }));
  const large = stickyEvidence ?? {};
  const largeLink = large.root?.linkRect;
  const largeAnchored = anchoredTo(large.layout?.rect, largeLink, large.layout?.viewport);
  check("a child too tall for either side of its link hangs from it shortened, and sticky lookups keep it through a return to its parent until a parent click",
    large.opened && large.layout?.rect.width === 800 && large.layout.rect.height < 900 && bounded(large.layout)
      && beside(largeAnchored) && (large.layout.rect.top >= largeLink.bottom || large.layout.rect.bottom <= largeLink.top)
      && large.point && !large.point.covered && large.kept && large.pressed && large.rootKept,
    JSON.stringify({ ...large, anchored: largeAnchored }));
  // A keyboard-opened child highlights its source link text, so the retained
  // set is the chain's first two highlights rather than the child's query.
  const highlightsOf = texts => JSON.stringify(texts);
  check("a primary click in an ancestor popup dismisses focused, hovered and pending descendants at once while keeping the ancestor and protected drafts",
    clickEvidence.chain?.grandchildFocused.includes("gsm-hoshidicts-popup-close")
      && clickEvidence.chain.highlights.length === 3 && clickEvidence.chain.highlights[0] === fixture.query
      && clickEvidence.childClick?.text === "T" && !clickEvidence.childClick.covered
      && !grandchild.visible(clickEvidence.childClick.grandchild) && child.visible(clickEvidence.childClick.child)
      && clickEvidence.childClick.child.plain.includes(fixture.child) && clickEvidence.childClick.root?.plain.includes(fixture.query)
      && JSON.stringify(clickEvidence.childClick.depths) === "[0,1]"
      && highlightsOf(clickEvidence.childClick.highlights) === highlightsOf(clickEvidence.chain.highlights.slice(0, 2))
      && clickEvidence.rootClick?.hoverGrandchild && clickEvidence.rootClick.text === "A" && !clickEvidence.rootClick.covered
      && JSON.stringify(clickEvidence.rootClick.depths) === "[0]"
      && !child.visible(clickEvidence.rootClick.child) && !grandchild.visible(clickEvidence.rootClick.grandchild)
      && clickEvidence.rootClick.root?.plain === clickEvidence.rootClick.rootBefore?.plain
      && highlightsOf(clickEvidence.rootClick.highlights) === highlightsOf([fixture.query])
      && clickEvidence.draftClick?.draft?.term === fixture.child && !clickEvidence.draftClick.covered
      && clickEvidence.draftClick.child?.noteOpen && clickEvidence.draftClick.child.noteDefinition === "draft survives a parent click"
      && JSON.stringify(clickEvidence.draftClick.depths) === "[0,1]"
      && child.visible(clickEvidence.formClosed) && !clickEvidence.formClosed.noteOpen
      && JSON.stringify(clickEvidence.closedDraftClick?.depths) === "[0]" && !child.visible(clickEvidence.closedDraftClick.child)
      && clickEvidence.pending?.held && JSON.stringify(clickEvidence.pending.heldDepths) === "[0,1]"
      && JSON.stringify(clickEvidence.pending.dismissedDepths) === "[0]" && JSON.stringify(clickEvidence.pending.afterRelease) === "[0]"
      && !grandchild.visible(clickEvidence.pending.grandchild) && !child.visible(clickEvidence.pending.child)
      && clickEvidence.pending.root?.plain.includes(fixture.query)
      && JSON.stringify(clickEvidence.linkClick?.depths) === "[0,1,2]" && !clickEvidence.linkClick.covered
      && clickEvidence.linkClick.grandchild?.plain.includes(fixture.grandchild)
      && clickEvidence.linkClick.lookups === 0,
    JSON.stringify(clickEvidence));
}

async function checkRetainedLinkControls(browser, settings, tab, popup, child, fixture, setDepth) {
  const favorite = await settings.evaluate(async (title) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_apply_state",
      baseRevision: dictionaryState.revision,
      dictionaries: dictionaryState.dictionaries.map(dictionary => dictionary.title === title
        ? { ...dictionary, favorite: true } : dictionary) });
  }, fixture.title);
  if (!favorite.ok) throw new Error(favorite.error);
  const worker = await installMediaReplyProbe(browser, settings);
  const evidence = [];
  const hold = () => worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
  const waitHeld = () => worker.evaluate(async () => {
    const deadline = Date.now() + 10_000;
    while (!globalThis.__ownedMediaProbe.heldLookups.length) {
      if (Date.now() >= deadline) throw new Error("retained view replay never reached its held reply");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  const release = () => worker.evaluate(() => {
    for (const resume of globalThis.__ownedMediaProbe.heldLookups.splice(0)) resume();
  });
  async function refreshed() {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await popup.retainedControls();
      if (value?.replaced || Date.now() >= deadline) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  try {
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await setDepth(1);
    for (const position of ["top", "bottom"]) {
      await tab.keyboard.press("Escape");
      await tab.setViewport({ width: 900, height: 420 });
      await tab.$eval("#verb", (element, position) => {
        element.style.cssText = 'position:fixed;left:20px;' + (position === 'top' ? 'top:10px' : 'bottom:10px');
      }, position);
      await tab.bringToFront();
      await hoverForPopup(tab, popup, "#verb");
      if (position === "top") {
        await popup.click(".gsm-hoshidicts-note-button");
        await popup.writeNote({ definition: "retained draft before replay" });
      } else {
        await popup.nested("focus-link");
        await tab.keyboard.press("Enter");
        await child.waitForVisible();
        await child.click(".gsm-hoshidicts-note-button");
      }
      await installMediaArchive(settings, fixture.archive);
      await hold();
      await popup.retainedControls("focus-tab");
      await tab.keyboard.press("ArrowRight");
      await waitHeld();
      if (position === "bottom") {
        await popup.click(".gsm-hoshidicts-note-button");
        await popup.writeNote({ definition: "retained draft during replay" });
      }
      const before = await popup.retainedControls("remember");
      await release();
      const after = await refreshed();
      evidence.push(after?.toolbar === position && after.sameForm && after.mounted
        && after.inputFocused && after.inputReachable && after.draft === before.draft
        && JSON.stringify(after.selection) === "[2,7]" || { position, before, after });
      await installMediaArchive(settings, fixture.archive);
      await hold();
      await popup.retainedControls("remember-panel");
      await popup.retainedControls("focus-tab");
      await tab.keyboard.press("ArrowLeft");
      await waitHeld();
      await release();
      const keyboard = await refreshed();
      const keyboardRetained = keyboard?.sameForm && keyboard.tabFocused
        && keyboard.inputReachable && keyboard.draft === before.draft
        && (keyboard.mounted || keyboard.replaced);
      evidence.push(keyboardRetained || { position, phase: "keyboard", before, after: keyboard });
      await tab.keyboard.press("Escape");
      await tab.keyboard.press("Escape");
    }
    return evidence;
  } finally {
    await restoreMediaReplyProbe(worker);
  }
}

describe("nested lookups", () => {
  step("nested links", async () => {
    await checkNestedLinks(page, tab, popup, browser);
  });
});
