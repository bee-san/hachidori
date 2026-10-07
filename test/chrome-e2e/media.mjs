/*
 * Lookup bounds, deep structured content and dictionary media.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./memory.mjs";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe } from "node:test";
import {
  buildTitledZip,
  gaijiSizingFixture,
  imagePreviewFixture,
  imageSizingFixture,
  makePng,
  monochromeImageFixture,
  structuredContentDeepFixture,
} from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import { hoverForPopup } from "./popup-reader.mjs";
import { popup2, tab2 } from "./restart.mjs";
import {
  browser,
  installMediaArchive,
  installMediaReplyProbe,
  page,
  restoreMediaReplyProbe,
  showSettingsSection,
} from "./session.mjs";

async function mediaOwnershipChrome({ browser, page, tab, popup }) {
  const title = "owned-media-fixture";
  const oldBytes = makePng();
  const newBytes = Buffer.concat([oldBytes, Buffer.from([1])]);
  const archive = (bytes) => buildTitledZip(title, { terms: [
    ["画像", "がぞう", "", "", 0, ["surrounding image definition", {
      type: "structured-content", content: {
        tag: "img", path: "media/owned.png", width: 16, height: 16, alt: "Owned dictionary image",
      },
    }], 1, ""],
  ], mediaEntries: [["media/owned.png", bytes]] });
  const install = (bytes) => installMediaArchive(page, archive(bytes));
  const worker = await installMediaReplyProbe(browser, page);
  async function waitForImage(predicate) {
    const deadline = Date.now() + 10_000;
    do {
      const state = await popup.state();
      if (predicate(state)) return state;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    } while (Date.now() < deadline);
    throw new Error("owned media image did not reach its expected state");
  }
  async function rehover() {
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    return hoverForPopup(tab, popup, "#verb");
  }
  try {
    const firstGeneration = await install(oldBytes);
    await tab.evaluate(() => { document.getElementById("verb").textContent = "画像"; });
    await rehover();
    await worker.evaluate(async () => {
      const deadline = Date.now() + 10_000;
      while (globalThis.__ownedMediaProbe.held.length === 0) {
        if (Date.now() >= deadline) throw new Error("real media reply was not held");
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
      }
    });
    const held = await popup.state();
    const nextGeneration = await install(newBytes);
    await rehover();
    const expectedUrl = `data:image/png;base64,${newBytes.toString("base64")}`;
    await waitForImage((state) => state?.images[0] === expectedUrl && state.imageStates[0]?.width === 16);
    await worker.evaluate(() => globalThis.__ownedMediaProbe.held.shift()());
    await rehover();
    const current = await waitForImage((state) => state?.images[0] === expectedUrl
      && state.imageStates[0]?.width === 16);
    const count = await worker.evaluate(() => globalThis.__ownedMediaProbe.count);
    check("a late real media reply cannot replace a current generation image",
      firstGeneration !== nextGeneration && held.images[0] === "" && count === 2
        && current.plain.includes("surrounding image definition"),
      JSON.stringify({ firstGeneration, nextGeneration, held: held.images, count, current: current.imageStates }));

    await install(newBytes);
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.failNext = true; });
    await rehover();
    const failedImage = await waitForImage((state) => state?.imageStates[0]?.state === "load-error");
    if (process.env.HACHIDORI_MEDIA_FAILURE_SCREENSHOT) {
      await tab.screenshot({ path: process.env.HACHIDORI_MEDIA_FAILURE_SCREENSHOT });
    }
    await rehover();
    const retried = await waitForImage((state) => state?.images[0] === expectedUrl
      && state.imageStates[0]?.width === 16);
    const afterRetry = await worker.evaluate(() => globalThis.__ownedMediaProbe.count);
    check("failed media exposes its failure state and text while a later hover retries",
      failedImage.plain.includes("surrounding image definition")
        && failedImage.imageStates[0].label.includes("Owned dictionary image")
        && failedImage.imageStates[0].errorVisible
        && retried.imageStates[0].state === "loaded" && afterRetry === count + 2,
      JSON.stringify({ failed: failedImage.imageStates, retried: retried.imageStates, count, afterRetry }));
  } finally {
    await restoreMediaReplyProbe(worker);
  }
}

async function boundedMediaChrome({ browser, page, tab, popup }) {
  const png = makePng();
  const paths = Array.from({ length: 12 }, (_, index) => `media/burst-${index}.png`);
  const archive = buildTitledZip("bounded-media-queue-fixture", {
    terms: [["並列画像", "へいれつがぞう", "", "", 0, [{
      type: "structured-content", content: paths.flatMap((path) => [
        { tag: "img", path, width: 16, height: 16 },
        { tag: "img", path, width: 16, height: 16 },
      ]),
    }], 1, ""]],
    mediaEntries: paths.map((path) => [path, png]),
  });
  await installMediaArchive(page, archive);
  const worker = await installMediaReplyProbe(browser, page);
  try {
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdAll = true; });
    await tab.evaluate(() => { document.getElementById("verb").textContent = "並列画像"; });
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await hoverForPopup(tab, popup, "#verb");
    const held = await worker.evaluate(async () => {
      const probe = globalThis.__ownedMediaProbe;
      const deadline = Date.now() + 3000;
      while (probe.held.length < 4) {
        if (Date.now() >= deadline) throw new Error("browser media burst never dispatched four jobs");
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
      }
      return { count: probe.count, active: probe.active, maxActive: probe.maxActive };
    });
    const before = await popup.state();
    check("media cache deduplicates and bounds a real browser image burst",
      before.images.length === 24 && before.images.every((url) => url === "")
        && held.count === 4 && held.active === 4 && held.maxActive === 4,
      JSON.stringify({ images: before.images.length, held }));

    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await worker.evaluate(async () => {
      const probe = globalThis.__ownedMediaProbe;
      probe.holdAll = false;
      for (const release of probe.held.splice(0)) release();
      // Let delivered callbacks settle before a new view can claim queued work.
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
    });
    const afterHide = await worker.evaluate(() => globalThis.__ownedMediaProbe.count);
    await hoverForPopup(tab, popup, "#verb");
    const expected = `data:image/png;base64,${png.toString("base64")}`;
    const deadline = Date.now() + 10_000;
    let restored;
    do {
      restored = await popup.state();
      if (restored?.images.length === 24 && restored.images.every((url) => url === expected)
          && restored.imageStates.every((image) => image.width === 16)) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    } while (Date.now() < deadline);
    const after = await worker.evaluate(() => ({
      count: globalThis.__ownedMediaProbe.count, maxActive: globalThis.__ownedMediaProbe.maxActive,
    }));
    check("obsolete queued images never dispatch while started images stay reusable",
      afterHide === 4 && after.count === 12 && after.maxActive === 4
        && restored.images.length === 24 && restored.images.every((url) => url === expected)
        && restored.imageStates.every((image) => image.width === 16),
      JSON.stringify({ afterHide, after, images: restored.imageStates }));
  } finally {
    await restoreMediaReplyProbe(worker);
  }
}

async function imagePreviewChrome({ browser, page, tab, popup }) {
  const fixture = imagePreviewFixture();
  await installMediaArchive(page, fixture.archive);
  const worker = await installMediaReplyProbe(browser, page);
  const expected = [...fixture.images, fixture.images[1]];
  async function waitForPreview(predicate, index = 0, retry = null) {
    const deadline = Date.now() + 6000;
    let state;
    do {
      state = await popup.imagePreview(index);
      if (predicate(state)) return state;
      await retry?.();
      await new Promise(done => setTimeout(done, 25));
    } while (Date.now() < deadline);
    throw new Error(`Image preview did not reach its expected state: ${JSON.stringify(state)}`);
  }
  // Hover previews open on mouseenter. A single move can land while the popup
  // is still re-rendering, so the pointer then rests inside the new image
  // without ever entering it; nudge it until the browser re-hit-tests.
  let nudges = 0;
  const hoverInline = (rect) => tab.mouse.move(
    rect.left + rect.width / 2 + (nudges++ % 2), rect.top + rect.height / 2);
  const hoverForPreview = async (index, width) => {
    const rect = (await popup.imagePreview(index)).sourceRect;
    await hoverInline(rect);
    return waitForPreview(state => state?.preview?.width === width, index,
      async () => hoverInline((await popup.imagePreview(index))?.sourceRect ?? rect));
  };
  try {
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNext = false; });
    await tab.evaluate(query => { document.getElementById("verb").textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await hoverForPopup(tab, popup, "#verb");
    const decoded = await waitForPreview(state => state?.images.length === expected.length
      && state.images.every((image, index) => image.width === expected[index].width && image.height === expected[index].height));
    const requestCount = () => worker.evaluate(() => globalThis.__ownedMediaProbe.count);
    const initialCount = await requestCount();
    const hovered = await hoverForPreview(0, fixture.images[0].width);
    const inline = hovered.sourceRect;
    await tab.mouse.move(1, 1);
    const left = await waitForPreview(state => state?.preview === null);
    await popup.imagePreview(0, "focus");
    await tab.keyboard.press("Tab");
    const focused = await waitForPreview(state => state?.focusedImage === 1 && state.preview?.width === fixture.images[1].width, 1);
    const focusRect = focused.sourceRect;
    await tab.mouse.move(focusRect.left + focusRect.width / 2, focusRect.top + focusRect.height / 2);
    await tab.mouse.move(1, 1);
    const focusSurvivedLeave = (await popup.imagePreview(1))?.preview?.source === focused.preview.source;
    await tab.mouse.move(focusRect.left + focusRect.width / 2, focusRect.top + focusRect.height / 2);
    const hoverSurvivedBlur = (await popup.imagePreview(1, "blur"))?.preview?.source === focused.preview.source;
    await tab.mouse.move(1, 1);
    const bothLeftClosed = (await popup.imagePreview(1))?.preview === null;
    await popup.imagePreview(1, "focus");
    const viewport = tab.viewport();
    const fits = ({ rect }) => rect.left >= 8 && rect.top >= 8
      && rect.right <= viewport.width - 8 && rect.bottom <= viewport.height - 8;
    await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const reduced = await waitForPreview(state => state?.preview?.animation === "none", 1);
    if (process.env.HACHIDORI_IMAGE_PREVIEW_SCREENSHOT) {
      mkdirSync(dirname(process.env.HACHIDORI_IMAGE_PREVIEW_SCREENSHOT), { recursive: true });
      await tab.screenshot({ path: process.env.HACHIDORI_IMAGE_PREVIEW_SCREENSHOT });
    }
    check("dictionary AVIF and SVG decode through real WASM without extra preview fetches",
      decoded.images.every((image, index) => image.source === `data:${expected[index].type};base64,${expected[index].bytes.toString("base64")}`)
        && hovered.preview.source === decoded.images[0].source && focused.preview.source === decoded.images[1].source
        && initialCount === 2 && await requestCount() === 2,
      JSON.stringify({ images: decoded.images.map(({ width, height }) => ({ width, height })), initialCount }));
    check("image hover and keyboard previews stay larger, viewport-clamped and motion-aware",
      hovered.preview.rect.width > inline.width && hovered.preview.rect.height > inline.height
        && fits(hovered.preview) && fits(focused.preview) && focused.preview.sibling
        && focused.preview.hiddenFromAccessibility === "true" && focused.preview.pointerEvents === "none"
        && focusSurvivedLeave && hoverSurvivedBlur && bothLeftClosed
        && focused.preview.animation === "gsm-hoshidicts-image-emerge" && reduced.preview.animation === "none"
        && focused.preview.background !== "rgba(0, 0, 0, 0)" && left.preview === null,
      JSON.stringify({ hoverRect: hovered.preview.rect, focusRect: focused.preview.rect, animation: focused.preview.animation,
        focusSurvivedLeave, hoverSurvivedBlur, bothLeftClosed }));

    await popup.imagePreview(1, "blur");
    const blurred = await waitForPreview(state => state?.preview === null);
    await popup.imagePreview(2, "focus");
    // Focusing below the fold causes a native scroll after focus. The preview
    // must survive that event and follow the now-visible keyboard owner.
    await new Promise(done => setTimeout(done, 100));
    const scrolledFocus = await popup.imagePreview(2);
    await popup.imagePreview(2, "blur");
    await popup.imagePreview(2, "mouseenter");
    await popup.imagePreview(2, "scroll");
    const hoverScrollClosed = await waitForPreview(state => state?.preview === null);
    await popup.imagePreview(2, "focus");
    await worker.evaluate(() => { globalThis.__ownedMediaProbe.holdNextLookup = true; });
    // A linked child retains this parent's render/media owner. Use same-level
    // kanji navigation to exercise invalidation while its replacement is held.
    const navigationClicked = await popup.click(".gsm-hoshidicts-kanji-link");
    if (!navigationClicked) throw new Error(`Navigation link disappeared while focusing images: ${JSON.stringify({
      scrolledFocus, hoverScrollClosed, current: await popup.state(),
    })}`);
    await worker.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (globalThis.__ownedMediaProbe.heldLookups.length === 0) {
        if (Date.now() >= deadline) throw new Error("navigation lookup never reached the held reply");
        await new Promise(done => setTimeout(done, 25));
      }
    });
    const pending = await popup.imagePreview(2, "mouseenter");
    check("image previews close on leave, blur, scrolling and pending navigation",
      blurred.preview === null && scrolledFocus.scrollTop > 0 && scrolledFocus.focusedImage === 2
        && scrolledFocus.preview?.source === decoded.images[2].source && fits(scrolledFocus.preview)
        && hoverScrollClosed.images.length === 3 && hoverScrollClosed.preview === null
        && pending.images.length === 3 && pending.preview === null,
      JSON.stringify({ scrolledFocus: { scrollTop: scrolledFocus.scrollTop, focused: scrolledFocus.focusedImage,
        previewRect: scrolledFocus.preview?.rect }, pendingPreview: pending.preview }));
    await worker.evaluate(() => { for (const release of globalThis.__ownedMediaProbe.heldLookups.splice(0)) release(); });
  } finally {
    await tab.emulateMediaFeatures([]);
    await restoreMediaReplyProbe(worker);
  }
}

async function imageSizingChrome({ page, tab, popup }) {
  const fixture = imageSizingFixture();
  await installMediaArchive(page, fixture.archive);
  await tab.evaluate(query => { document.getElementById("verb").textContent = query; }, fixture.query);
  await tab.bringToFront();
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  await hoverForPopup(tab, popup, "#verb");
  const deadline = Date.now() + 6000;
  let state;
  do {
    state = await popup.imagePreview();
    if (state?.images.length === fixture.cases.length && state.images.every(image => image.width === 16)) break;
    await new Promise(done => setTimeout(done, 25));
  } while (Date.now() < deadline);
  const expectedSource = `data:image/png;base64,${fixture.bytes.toString("base64")}`;
  check("dictionary image sizing preserves ordinary geometry and enforces its existing aspect bound",
    state?.images.length === fixture.cases.length && state.images.every((image, index) => {
      const expected = fixture.cases[index];
      const units = expected.dimensions.sizeUnits === "em" ? "em" : "px";
      const { display } = image;
      const maximumWidth = expected.width * (units === "em" ? display.fontSize : 1);
      return image.source === expectedSource && image.width === 16 && image.height === 16
        && display.inlineWidth.endsWith(units)
        // CSSOM rounds the recovered fractional width to 0.202402px.
        && Math.abs(Number.parseFloat(display.inlineWidth) - expected.width) < 1e-6
        && display.width <= maximumWidth + 1 / 64
        && (index >= 7 || Math.abs(display.width - maximumWidth) <= 1 / 64)
        && Math.abs(display.height - display.width * expected.padding / 100) <= 1 / 32;
    }), JSON.stringify(state?.images.map(({ display }) => display)));
}

function popupTheme(page) {
  return page.evaluate(async () => (await chrome.storage.local.get("options")).options?.popupTheme ?? "default");
}

function setPopupTheme(page, theme) {
  return page.evaluate(async nextTheme => {
    const { options } = await chrome.storage.local.get("options");
    if ((options?.popupTheme ?? "default") === nextTheme) return;
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      requestId: `popup-theme-${nextTheme}`,
      baseRevision: options?.revision ?? 0,
      options: { popupTheme: nextTheme },
    });
    if (!reply.ok) throw new Error(reply.error);
  }, theme);
}

async function gaijiSizingChrome({ page, tab, popup }) {
  const fixture = gaijiSizingFixture();
  const originalTheme = await popupTheme(page);
  const setTheme = theme => setPopupTheme(page, theme);
  try {
    await setTheme("dark");
    await installMediaArchive(page, fixture.archive);
    await tab.evaluate(query => { document.getElementById("verb").textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await hoverForPopup(tab, popup, "#verb");
    const deadline = Date.now() + 6000;
    let state;
    do {
      state = await popup.imagePreview();
      if (state?.theme === "dark"
          && state.images.length === fixture.cases.length
          && state.images.every(image => image.width > 0 && image.height > 0)) break;
      await new Promise(done => setTimeout(done, 25));
    } while (Date.now() < deadline);
    const expectedSources = {
      [fixture.path]: `data:image/png;base64,${fixture.bytes.toString("base64")}`,
      [fixture.svgPath]: `data:image/svg+xml;base64,${fixture.svgBytes.toString("base64")}`,
      [fixture.widePath]: `data:image/svg+xml;base64,${fixture.wideBytes.toString("base64")}`,
    };
    // Yomitan's .gloss-image-link has no margin, so a gaiji leaves no gap in its word.
    // The dictionary's img margin/padding must not move the image layer out
    // of its clipping container (#423).
    const sameRect = (a, b) => ["x", "y", "width", "height"].every(key => Math.abs(a[key] - b[key]) <= 1 / 64);
    check("Meikyo-compatible gaiji use natural inline geometry and dictionary CSS hooks without overflow",
      state?.theme === "dark" && state.images.length === fixture.cases.length
        && state.images.every((image, index) => {
          const expected = fixture.cases[index];
          return image.source === expectedSources[expected.path ?? fixture.path]
            && image.linkClasses.includes("gloss-sc-a")
            && image.imageClasses.includes("gloss-sc-img")
            && image.structuredData["data-sc-class"] === "gaiji"
            && image.structuredData["data-sc-glyph"] === "bs-arrow"
            && !Object.hasOwn(image.structuredData, "data-sc-unsafe key")
            && image.filter !== "none"
            && image.margin === "0px"
            && image.display.inlineWidth === (expected.inlineWidth ?? `${image.width}px`)
            && Math.abs(image.display.width - expected.width) <= 1 / 64
            && Math.abs(image.display.height - expected.height) <= 1 / 64
            && sameRect(image.imageRect, image.display.rect)
            && image.overflow?.clientWidth > 0
            && image.overflow.scrollWidth <= image.overflow.clientWidth + 1;
        }), JSON.stringify(state));
    check("dictionary CSS hides a converter head tail through a Japanese-keyed data attribute",
      state?.hiddenHeads?.length === 1
        && state.hiddenHeads[0].display === "none"
        && state.hiddenHeads[0].text === fixture.hiddenHeadText,
      JSON.stringify(state?.hiddenHeads));
  } finally {
    await setTheme(originalTheme);
  }
}

// The colour a screenshot of the reading tab shows at CSS-pixel points. The
// PNG is decoded in the page so the device pixel ratio needs no bookkeeping.
async function samplePixels(tab, points) {
  const png = await tab.screenshot({ encoding: "base64" });
  return tab.evaluate(async ({ png, points }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / window.innerWidth;
    return points.map(({ x, y }) => [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)]);
  }, { png, points });
}

// A black-on-transparent SVG tagged `appearance: "monochrome"` (a stroke-order
// strip, a headword glyph) is drawn in the palette text colour, so it stays
// visible on the default dark palette and darkens again on a light one. The
// same glyph tagged `auto` keeps its own black.
async function monochromeImageChrome({ page, tab, popup }) {
  const fixture = monochromeImageFixture();
  await installMediaArchive(page, fixture.archive);
  const originalTheme = await popupTheme(page);
  const centre = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  const rgb = colour => colour?.match(/\d+/gu)?.slice(0, 3).map(Number) ?? null;
  const near = (pixel, colour) => Array.isArray(pixel) && Array.isArray(colour)
    && pixel.every((channel, index) => Math.abs(channel - colour[index]) <= 3);
  const render = async theme => {
    await setPopupTheme(page, theme);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await hoverForPopup(tab, popup, "#verb");
    const deadline = Date.now() + 6000;
    let state;
    do {
      state = await popup.imagePreview();
      if (state?.theme === theme && state.images.length === fixture.cases.length
          && state.images.every(image => image.width === 100 && image.height === 100)) break;
      await new Promise(done => setTimeout(done, 25));
    } while (Date.now() < deadline);
    const [monochrome, auto] = await samplePixels(tab, state.images.map(image => centre(image.display.rect)));
    return { theme: state.theme, textColor: rgb(state.textColor), monochrome, auto };
  };
  let dark;
  let preview;
  let light;
  try {
    await tab.evaluate(query => { document.getElementById("verb").textContent = query; }, fixture.query);
    dark = await render("default");
    // The preview emerges through an opacity animation; sample it fully opaque.
    await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const inline = (await popup.imagePreview(0)).sourceRect;
    let nudges = 0;
    const deadline = Date.now() + 6000;
    let state;
    do {
      await tab.mouse.move(inline.left + inline.width / 2 + (nudges++ % 2), inline.top + inline.height / 2);
      state = await popup.imagePreview(0);
      if (state?.preview?.width === 100) break;
      await new Promise(done => setTimeout(done, 25));
    } while (Date.now() < deadline);
    const [pixel] = await samplePixels(tab, [centre(state.preview.rect)]);
    preview = { appearance: state.preview.appearance, pixel };
    if (process.env.HACHIDORI_MONOCHROME_IMAGE_SCREENSHOT) {
      mkdirSync(dirname(process.env.HACHIDORI_MONOCHROME_IMAGE_SCREENSHOT), { recursive: true });
      await tab.screenshot({ path: process.env.HACHIDORI_MONOCHROME_IMAGE_SCREENSHOT });
    }
    await tab.mouse.move(1, 1);
    light = await render("solarized-light");
  } finally {
    await tab.emulateMediaFeatures([]);
    await setPopupTheme(page, originalTheme);
  }
  check("monochrome dictionary images paint in the palette text colour in the card and its preview",
    dark?.theme === "default" && near(dark.monochrome, dark.textColor) && near(dark.auto, [0, 0, 0])
      && preview?.appearance === "monochrome" && near(preview.pixel, dark.textColor)
      && light?.theme === "solarized-light" && near(light.monochrome, light.textColor) && near(light.auto, [0, 0, 0])
      // The two palettes disagree about the text colour, so one hard-coded tint cannot pass both.
      && !near(dark.textColor, light.textColor),
    JSON.stringify({ dark, preview, light }));
}

// Values that more than one step uses; the step that creates each one assigns it.
let boundedTitle, exactMediaBytes, boundedPackage;

describe("bounds and media", () => {
  step("lookup bounds", async () => {
    boundedTitle = "bounded-response-fixture";
    let deepGlossary = "private-depth-leaf-must-not-be-logged";
    for (let depth = 0; depth < 1000; depth += 1) deepGlossary = { type: "text", text: deepGlossary };
    let nodeGlossaryContent = Array.from({ length: 1_048_575 }, () => null);
    nodeGlossaryContent.push("private-node-leaf-must-not-be-logged");
    exactMediaBytes = Buffer.alloc(4 * 1024 * 1024);
    makePng().copy(exactMediaBytes);
    const boundedArchive = buildTitledZip(boundedTitle, { terms: [
      ["限界", "げんかい", "", "", 0, ["x".repeat(8 * 1024 * 1024 - 3)], 1, ""],
      ["速度", "そくど", "", "", 0, ["healthy bounded lookup"], 2, ""],
      ["深度", "しんど", "", "", 0, [deepGlossary], 3, ""],
      ["節点", "せってん", "", "", 0, [{
        type: "structured-content",
        content: nodeGlossaryContent,
      }], 4, ""],
    ], mediaEntries: [
      ["media/exact.png", exactMediaBytes],
      ["media/over.png", Buffer.concat([exactMediaBytes, Buffer.from([0])])],
    ] });
    nodeGlossaryContent = null;
    await showSettingsSection(page, "add-dictionaries");
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "bounded-response.zip", { type: "application/zip" }));
      const input = document.getElementById("import-file");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, boundedArchive.toString("base64"));
    boundedPackage = await page.waitForFunction(async (title) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.title === title);
      return dictionary && status.ok && status.ready && !status.loading ? dictionary : false;
    }, { timeout: 90_000, polling: 100 }, boundedTitle).then(handle => handle.jsonValue());
    const boundedReplies = await page.evaluate(async (dictionary) => {
      const request = (type, fields) => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type, requestId: `bounded-${type}`, ...fields,
      });
      const before = await request("hd_status", {});
      const global = await request("hd_lookup", { text: "限界" });
      const selected = await request("hd_lookup_dictionary", { dictionary, text: "限界" });
      const nul = await request("hd_kanji", { character: "食\0" });
      const healthy = await request("hd_lookup", { text: "速度" });
      const after = await request("hd_status", {});
      return { before, global, selected, nul, healthy, after };
    }, boundedTitle);
    check(
      "real-WASM lookup bounds fail one request without poisoning the OPFS engine",
      [boundedReplies.global, boundedReplies.selected].every((reply) => reply.ok === false
        && reply.results?.length === 0 && /glossary/u.test(reply.error))
        && boundedReplies.nul.ok === false && /NUL/u.test(boundedReplies.nul.error)
        && boundedReplies.healthy.ok === true
        && boundedReplies.healthy.results[0]?.term.expression === "速度"
        && boundedReplies.before.generation === boundedReplies.after.generation
        && boundedReplies.after.ready === true && boundedReplies.after.storageBackend === "opfs",
      JSON.stringify(boundedReplies),
    );
    await tab2.evaluate(() => {
      document.getElementById("verb").textContent = "速度";
      const oversized = document.getElementById("kanjiword");
      oversized.textContent = "限界";
      // Keep this target outside the healthy word's popup hit area.
      oversized.style.cssText = "position:fixed;left:800px;top:32px";
    });
    const boundedPopupBefore = await hoverForPopup(tab2, popup2, "#verb");
    await tab2.mouse.move(2, 2);
    const oversizedWord = await tab2.$("#kanjiword");
    const oversizedBox = await oversizedWord.boundingBox();
    await tab2.mouse.move(oversizedBox.x + 5, oversizedBox.y + oversizedBox.height / 2);
    const boundedPopupHidden = await popup2.waitForHidden();
    const boundedPopupAfter = await hoverForPopup(tab2, popup2, "#verb");
    check(
      "an oversized hover clears the previous popup and the next healthy hover recovers",
      boundedPopupBefore?.plain?.includes("healthy bounded lookup")
        && boundedPopupHidden
        && boundedPopupAfter?.plain?.includes("healthy bounded lookup"),
      JSON.stringify({ before: boundedPopupBefore?.plain, hidden: boundedPopupHidden, after: boundedPopupAfter?.plain }),
    );
  });

  step("deep structured content", async () => {
    const renderFailureLogs = [];
    const onRenderConsole = (message) => {
      if (!message.text().includes("omitted dictionary definition after render failure")) return;
      renderFailureLogs.push((async () => {
        const args = await Promise.all(message.args().map(async (handle) => {
          try {
            return await handle.evaluate((value) => {
              if (value && typeof value === "object"
                  && typeof value.message === "string" && typeof value.stack === "string") {
                return {
                  code: value.code,
                  definitionIndex: value.definitionIndex,
                  dictionaryId: value.dictionaryId,
                  dictionaryTitle: value.dictionaryTitle,
                  entryIndex: value.entryIndex,
                  message: value.message,
                  name: value.name,
                  originalStack: value.originalStack,
                  stack: value.stack,
                  termExpression: value.termExpression,
                  termReading: value.termReading,
                  cause: value.cause ? {
                    actual: value.cause.structuredContentActual,
                    kind: value.cause.structuredContentLimitKind,
                    limit: value.cause.structuredContentLimit,
                    location: value.cause.structuredContentLocation,
                    message: value.cause.message,
                    name: value.cause.name,
                    stack: value.cause.stack,
                  } : null,
                };
              }
              return { value: String(value) };
            });
          } catch (error) {
            return { evaluationError: String(error) };
          }
        }));
        return { args, text: message.text(), type: message.type() };
      })());
    };
    tab2.on("console", onRenderConsole);
    const rendered = async (term, accept) => {
      await tab2.evaluate((text) => { document.getElementById("kanjiword").textContent = text; }, term);
      const value = await hoverForPopup(tab2, popup2, "#kanjiword", { accept });
      const recovered = await hoverForPopup(tab2, popup2, "#verb", {
        accept: state => !state.failure && state.plain.includes("healthy bounded lookup"),
      });
      return { value, recovered };
    };
    const deepRender = await rendered("深度",
      state => !state.failure && state.plain.includes("private-depth-leaf-must-not-be-logged"));
    const nodeRender = await rendered("節点",
      state => !state.failure && state.plain.startsWith("節点"));
    tab2.off("console", onRenderConsole);
    const renderFailures = await Promise.all(renderFailureLogs);
    const logged = renderFailures.length === 1 && renderFailures.every((failure) => {
      const contextual = failure.args[1];
      return failure.type === "warn"
        && failure.text.length < 4096
        && contextual?.code === "dictionary-structured-content-limit"
        && contextual.dictionaryTitle === boundedTitle
        && contextual.dictionaryId === boundedPackage.id
        && contextual.entryIndex === 0 && contextual.definitionIndex === 0
        && contextual.stack.includes("structuredContentRenderError")
        && contextual.originalStack === contextual.cause?.stack
        && contextual.cause?.stack.includes("appendStructuredValue")
        && contextual.cause?.kind === "node count"
        && contextual.cause?.actual === 1_048_577
        && contextual.cause?.limit === 1_048_576
        && contextual.cause?.location === "glossary[0].content[1048574]"
        && !JSON.stringify(failure).includes("private-node-leaf");
    });
    check(
      "deep structured content renders while node-limit failures omit only their definition",
      deepRender.value?.plain?.includes("private-depth-leaf-must-not-be-logged")
        && !deepRender.value?.failure
        && nodeRender.value && !nodeRender.value.failure
        && nodeRender.value.plain.includes(boundedTitle)
        && !nodeRender.value.plain.includes("private-node-leaf")
        && logged
        && deepRender.recovered?.plain?.includes("healthy bounded lookup")
        && nodeRender.recovered?.plain?.includes("healthy bounded lookup"),
      JSON.stringify({ boundedPackage, renderFailures, deepRender, nodeRender }),
    );
  });

  step("a 大辞泉-shaped entry", async () => {
    // The reported の/何事 failure (#287): a 大辞泉-shaped entry nested beyond the
    // former depth limit renders, and its compact summary shows real text.
    const deepFixture = structuredContentDeepFixture();
    const writeOptions = (patch) => page.evaluate(async (patch) => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options.revision, options: patch });
      if (!reply.ok) throw new Error(reply.error);
      return options;
    }, patch);
    // An automatic backup may take the engine's mutation lock after any of these
    // state changes, failing lookups meanwhile: mutate and hover only while idle.
    const deepEngineIdle = (installed) => page.waitForFunction(async (title, installed) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return (dictionaryState?.dictionaries ?? []).some((entry) => entry.title === title) === installed
        && status?.ok && status.ready && !status.loading;
    }, { timeout: 90_000, polling: 250 }, deepFixture.title, installed);
    const optionsBeforeSummary = await writeOptions({ showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3 });
    await deepEngineIdle(false);
    await installMediaArchive(page, deepFixture.archive());
    await tab2.evaluate((text) => { document.getElementById("kanjiword").textContent = text; }, deepFixture.query);
    let deepEntry = null;
    let deepSummaries = [];
    for (let attempt = 0; attempt < 6 && deepSummaries.length === 0; attempt += 1) {
      await deepEngineIdle(true);
      deepEntry = await hoverForPopup(tab2, popup2, "#kanjiword", { attempts: 4,
        accept: state => !state.failure && state.plain.includes(deepFixture.leaf) });
      if (deepEntry) deepSummaries = await popup2.compactSummaries();
    }
    check(
      "a 大辞泉-shaped entry nested beyond the former depth limit renders with a real compact summary",
      deepEntry?.plain?.includes(deepFixture.leaf) && !deepEntry.failure
        && deepEntry.plain.includes(deepFixture.title)
        && deepSummaries.length === 1 && deepSummaries[0].dictionary === deepFixture.title
        && JSON.stringify(deepSummaries[0].items) === JSON.stringify(deepFixture.summary),
      JSON.stringify({ plain: deepEntry?.plain, failure: deepEntry?.failure, deepSummaries, expected: deepFixture.summary }),
    );
    await tab2.mouse.move(2, 2);
    await popup2.waitForHidden();
    await writeOptions({ showCompactDefinitionSummary: optionsBeforeSummary.showCompactDefinitionSummary,
      compactDefinitionSummaryCount: optionsBeforeSummary.compactDefinitionSummaryCount });
    await page.evaluate(async (title) => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_remove",
          requestId: `deep-remove-${crypto.randomUUID()}`, title });
        if (reply?.ok || Date.now() >= deadline) return reply;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }, deepFixture.title);
    await deepEngineIdle(false);
  });

  step("large media", async () => {
    const mediaEvidence = await page.evaluate(async (dictionary) => {
      const request = (type, fields) => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type, requestId: `bounded-media-${type}`, ...fields,
      });
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const installed = dictionaryState.dictionaries.find((entry) => entry.title === dictionary);
      const before = await request("hd_status", {});
      const generation = before.generation;
      const exact = await request("hd_media", { generation, dictionary, path: "media/exact.png" });
      const bytes = Uint8Array.from(atob(exact.dataUrl?.split(",")[1] ?? ""), (character) => character.charCodeAt(0));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0")).join("");
      const over = await request("hd_media", { generation, dictionary, path: "media/over.png" });
      const nul = await request("hd_media", { generation, dictionary, path: "media/exact.png\0suffix" });
      const absent = await request("hd_media", { generation, dictionary, path: "media/absent.png" });
      const healthy = await request("hd_lookup", { text: "速度" });
      const after = await request("hd_status", {});
      return { mediaCount: installed?.mediaCount, before, exactOk: exact.ok, bytes: bytes.length, digest,
        over: { ok: over.ok, error: over.error, empty: over.dataUrl === null },
        nul: { ok: nul.ok, error: nul.error, empty: nul.dataUrl === null }, absent, healthy, after };
    }, boundedTitle);
    check(
      "large media imports through OPFS while oversized and malformed fetches fail without poisoning the engine",
      mediaEvidence.mediaCount === 2 && mediaEvidence.exactOk && mediaEvidence.bytes === exactMediaBytes.length
        && mediaEvidence.digest === createHash("sha256").update(exactMediaBytes).digest("hex")
        && mediaEvidence.over.ok === false && mediaEvidence.over.empty && /media/u.test(mediaEvidence.over.error)
        && mediaEvidence.nul.ok === false && mediaEvidence.nul.empty && /NUL/u.test(mediaEvidence.nul.error)
        && mediaEvidence.absent.ok === true && mediaEvidence.absent.dataUrl === null
        && mediaEvidence.healthy.ok === true && mediaEvidence.healthy.results[0]?.term.expression === "速度"
        && mediaEvidence.after.ready && mediaEvidence.after.storageBackend === "opfs"
        && mediaEvidence.before.generation === mediaEvidence.after.generation,
      JSON.stringify(mediaEvidence),
    );
  });

  step("media ownership", async () => {
    await mediaOwnershipChrome({ browser, page, tab: tab2, popup: popup2 });
  });

  step("bounded media", async () => {
    await boundedMediaChrome({ browser, page, tab: tab2, popup: popup2 });
  });

  step("image previews", async () => {
    await imagePreviewChrome({ browser, page, tab: tab2, popup: popup2 });
  });

  step("image sizing", async () => {
    await imageSizingChrome({ page, tab: tab2, popup: popup2 });
  });

  step("gaiji sizing", async () => {
    await gaijiSizingChrome({ page, tab: tab2, popup: popup2 });
  });

  step("monochrome images", async () => {
    await monochromeImageChrome({ page, tab: tab2, popup: popup2 });
  });
});
