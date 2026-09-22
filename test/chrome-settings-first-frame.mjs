// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SETTINGS_FIRST_FRAME_THEME_CHECK = "Settings paints its first visible frame in the saved theme instead of the browser preference";

// The first paint of Settings used to follow the browser's colour preference
// until settings.js had read the saved theme (#296). A settled-state read
// cannot see that, so every animation frame from document creation is
// recorded by a script registered before any page script runs, and the
// painted frames come from a CDP screencast started before navigation.
const FRAME_PROBE = () => {
  if (window !== window.top) return;
  const record = { origin: performance.now(), attributeSets: [], frames: [] };
  globalThis.__hachidoriFirstFrame = record;
  new MutationObserver(() => {
    record.attributeSets.push({ t: performance.now() - record.origin,
      value: document.documentElement?.getAttribute("data-hoshidicts-theme") ?? null });
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-hoshidicts-theme"] });
  const tick = () => {
    const root = document.documentElement;
    record.frames.push({
      t: performance.now() - record.origin,
      readyState: document.readyState,
      theme: root?.getAttribute("data-hoshidicts-theme") ?? null,
      pending: root?.hasAttribute("data-hoshidicts-theme-pending") ?? null,
      bodyVisibility: document.body ? getComputedStyle(document.body).visibility : null,
      bodyBackground: document.body ? getComputedStyle(document.body).backgroundColor : null,
    });
    if (record.frames.length < 60) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

// Storage faults for the bootstrap read. `hold` parks every read until the
// page calls releaseThemeStorage(); `fail` rejects the first read only, so
// settings.js still adopts the saved options afterwards.
const STORAGE_FAULT = ({ hold, fail }) => {
  if (window !== window.top) return;
  const get = chrome.storage.local.get.bind(chrome.storage.local);
  const released = new Promise(resolve => { globalThis.releaseThemeStorage = resolve; });
  let first = true;
  chrome.storage.local.get = async (...args) => {
    const mine = first;
    first = false;
    if (hold) await released;
    if (fail && mine) throw new Error("e2e: storage unavailable for the theme bootstrap");
    return get(...args);
  };
};

const SCENARIOS = [
  { name: "light under a dark preference", theme: "light", scheme: "dark", expected: "light" },
  { name: "default under a light preference", theme: "default", scheme: "light", expected: "default" },
  { name: "auto under a dark preference", theme: "auto", scheme: "dark", expected: "dark" },
  { name: "miku under a light preference", theme: "miku", scheme: "light", expected: "miku" },
  { name: "light under a dark preference, read held", theme: "light", scheme: "dark", expected: "light", hold: true },
  { name: "light under a dark preference, read failed", theme: "light", scheme: "dark", expected: "light", fail: true },
];
const VIEWPORT = { width: 1100, height: 700 };
// Pixels that only ever show page background: the sidebar's left gutter (body
// --bg) and the main column's right padding (.page --surface), top and middle,
// inside the reserved scrollbar gutter.
const SAMPLE_POINTS = [[4, 40], [4, 420], [1070, 40], [1070, 420]];
const TRANSPARENT = "rgba(0, 0, 0, 0)";

function sameColor(a, b, tolerance = 1) {
  return a.every((part, index) => Math.abs(part - b[index]) <= tolerance);
}

function frameLabel(frame) {
  if (frame.beforeFirstPaint) return "before first paint";
  if (frame.blank) return "browser canvas";
  return frame.themed ? "saved theme" : "browser preference";
}

export async function checkSettingsFirstFrameTheme(browser, settingsUrl, check, filmstripPath) {
  const helper = await browser.newPage();
  const evidence = { scenarios: [] };
  const writeTheme = theme => helper.evaluate(async nextTheme => {
    const { options } = await chrome.storage.local.get("options");
    if ((options?.popupTheme ?? "default") === nextTheme) return;
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      requestId: `first-frame-theme-${nextTheme}`, baseRevision: options?.revision ?? 0, options: { popupTheme: nextTheme } });
    if (!reply.ok) throw new Error(reply.error);
  }, theme);
  // Decode the screencast PNGs with the browser and sample the gutter pixels.
  const sampleFrames = frames => helper.evaluate(async (encoded, points, viewport) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const samples = [];
    for (const data of encoded) {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = `data:image/png;base64,${data}`; });
      canvas.width = image.width;
      canvas.height = image.height;
      context.drawImage(image, 0, 0);
      const scale = image.width / viewport.width;
      samples.push(points.map(([x, y]) => [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)]));
    }
    return samples;
  }, frames.map(frame => frame.data), SAMPLE_POINTS, VIEWPORT);
  const filmstrips = [];
  try {
    await helper.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    const originalTheme = await helper.evaluate(async () => (await chrome.storage.local.get("options")).options?.popupTheme ?? "default");
    for (const scenario of SCENARIOS) {
      await writeTheme(scenario.theme);
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        await page.setViewport(VIEWPORT);
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scenario.scheme }]);
        if (scenario.hold || scenario.fail) {
          await page.evaluateOnNewDocument(STORAGE_FAULT, { hold: scenario.hold === true, fail: scenario.fail === true });
        }
        await page.evaluateOnNewDocument(FRAME_PROBE);
        const cdp = await page.createCDPSession();
        const frames = [];
        cdp.on("Page.screencastFrame", event => {
          frames.push({ data: event.data, timestamp: event.metadata.timestamp });
          cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
        });
        await cdp.send("Page.enable");
        await cdp.send("Page.startScreencast", { format: "png", maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
        await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
        const readProbe = () => page.evaluate(() => ({ ...globalThis.__hachidoriFirstFrame, timeOrigin: performance.timeOrigin,
          firstPaint: performance.getEntriesByName("first-paint")[0]?.startTime ?? null,
          theme: document.documentElement.dataset.hoshidictsTheme ?? null,
          pending: document.documentElement.hasAttribute("data-hoshidicts-theme-pending"),
          bodyVisibility: getComputedStyle(document.body).visibility,
          bodyBackground: getComputedStyle(document.body).backgroundColor }));
        let held = null;
        if (scenario.hold) {
          // Several frames with the read parked: nothing of the interface may show.
          await page.waitForFunction(() => globalThis.__hachidoriFirstFrame.frames.length >= 6, { polling: 16, timeout: 10_000 });
          held = await readProbe();
          held.frameCount = frames.length;
          await page.evaluate(() => globalThis.releaseThemeStorage());
        }
        // Settled: the bootstrap has released the page and settings.js has
        // applied the saved options through applyPageTheme() as well. A build
        // that never gets there fails the check below instead of the run.
        const settledInTime = await page.waitForFunction(writes => document.documentElement.hasAttribute("data-hoshidicts-theme")
          && !document.documentElement.hasAttribute("data-hoshidicts-theme-pending")
          && globalThis.__hachidoriFirstFrame.attributeSets.length >= writes
          && globalThis.__hachidoriFirstFrame.frames.length >= 12, { polling: 16, timeout: 10_000 }, scenario.fail ? 1 : 2)
          .then(() => true, () => false);
        await cdp.send("Page.stopScreencast");
        const settled = await readProbe();
        const samples = await sampleFrames(frames);
        const reference = samples.at(-1);
        const painted = frames.map((frame, index) => {
          const at = Math.round(frame.timestamp * 1000 - settled.timeOrigin);
          return {
            at, samples: samples[index],
            // Frames before this document's first paint show the previous page
            // or the browser's default canvas, never this interface.
            beforeFirstPaint: settled.firstPaint !== null && at < settled.firstPaint - 5,
            // A uniform frame is the browser's own canvas before the interface paints.
            blank: samples[index].every(sample => sameColor(sample, samples[index][0])),
            themed: samples[index].every((sample, point) => sameColor(sample, reference[point])),
          };
        });
        const rafFrames = settled.frames.map(frame => ({ ...frame, t: Math.round(frame.t + settled.origin) }));
        // A frame without a body yet cannot show anything either.
        const hidden = frame => frame.bodyVisibility === null
          || (frame.bodyVisibility === "hidden" && frame.bodyBackground === TRANSPARENT);
        const shown = frame => frame.bodyVisibility === "visible" && frame.bodyBackground !== TRANSPARENT;
        const result = {
          name: scenario.name, expected: scenario.expected, settledInTime,
          settledTheme: settled.theme, settledPending: settled.pending, settledVisible: shown(settled),
          referenceDistinct: reference !== undefined && !sameColor(reference[0], reference[2]),
          firstAttribute: settled.attributeSets[0]?.value ?? null,
          firstPaint: settled.firstPaint === null ? null : Math.round(settled.firstPaint),
          pendingFramesHidden: rafFrames.filter(frame => frame.pending).every(hidden),
          releasedFramesThemed: rafFrames.filter(frame => !frame.pending).every(frame => frame.theme === scenario.expected),
          releasedFrameSeen: rafFrames.some(frame => !frame.pending),
          paintedFramesClean: painted.every(frame => frame.beforeFirstPaint || frame.blank || frame.themed),
          themedFrameSeen: painted.some(frame => frame.themed && !frame.blank),
          rafFrames: rafFrames.slice(0, 8).map(({ t, theme, pending, bodyVisibility, readyState }) => [t, theme, pending, bodyVisibility, readyState]),
          attributeSets: settled.attributeSets.slice(0, 4).map(({ t, value }) => [Math.round(t + settled.origin), value]),
          painted: painted.map(frame => [frame.at, frameLabel(frame), frame.samples[0], frame.samples[2]]),
        };
        if (held) {
          result.held = {
            pending: held.pending, theme: held.theme, attributeSets: held.attributeSets.length,
            frames: held.frames.length, frameCount: held.frameCount,
            allHidden: held.frames.every(frame => frame.pending && hidden(frame)),
            allBlank: painted.slice(0, held.frameCount).every(frame => frame.beforeFirstPaint || frame.blank),
          };
        }
        if (scenario.fail) {
          // The failed read releases the page to the browser preference at once
          // rather than leaving it blank; settings.js then adopts the saved theme.
          result.releasedFramesThemed = rafFrames.every(frame => !frame.pending && (frame.bodyVisibility === null || shown(frame)))
            && rafFrames.some(shown);
          result.paintedFramesClean = true;
        }
        evidence.scenarios.push(result);
        if (filmstripPath && !scenario.hold && !scenario.fail) filmstrips.push({ label: scenario.name, frames, painted });
      } finally {
        await page.close();
      }
    }
    await writeTheme(originalTheme);
    if (filmstripPath) {
      mkdirSync(dirname(filmstripPath), { recursive: true });
      const png = await helper.evaluate(async strips => {
        const width = 260;
        const height = Math.round(width * 700 / 1100);
        const columns = Math.max(...strips.map(strip => strip.frames.length));
        const canvas = document.createElement("canvas");
        canvas.width = 150 + columns * (width + 10);
        canvas.height = strips.length * (height + 30) + 10;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#000000";
        context.font = "13px system-ui, sans-serif";
        for (const [row, strip] of strips.entries()) {
          const top = 10 + row * (height + 30);
          context.fillText(strip.label, 6, top + height / 2, 140);
          for (const [column, frame] of strip.frames.entries()) {
            const image = new Image();
            await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = `data:image/png;base64,${frame}`; });
            const left = 150 + column * (width + 10);
            context.drawImage(image, left, top, width, height);
            context.strokeStyle = "#888888";
            context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
            context.fillText(strip.captions[column], left, top + height + 16);
          }
        }
        return canvas.toDataURL("image/png").split(",")[1];
      }, filmstrips.map(strip => ({ label: strip.label, frames: strip.frames.map(frame => frame.data),
        captions: strip.painted.map(frame => `+${frame.at} ms: ${frameLabel(frame)}`) })));
      writeFileSync(filmstripPath, Buffer.from(png, "base64"));
    }
  } finally {
    await helper.close();
  }
  check(SETTINGS_FIRST_FRAME_THEME_CHECK,
    evidence.scenarios.length === SCENARIOS.length && evidence.scenarios.every(scenario =>
      scenario.settledInTime && scenario.settledTheme === scenario.expected && !scenario.settledPending && scenario.settledVisible
        && scenario.referenceDistinct && scenario.firstAttribute === scenario.expected
        && scenario.pendingFramesHidden && scenario.releasedFramesThemed && scenario.releasedFrameSeen
        && scenario.paintedFramesClean && scenario.themedFrameSeen
        && (!scenario.held || (scenario.held.pending && scenario.held.theme === null && scenario.held.attributeSets === 0
          && scenario.held.frames >= 6 && scenario.held.allHidden && scenario.held.allBlank))),
    JSON.stringify(evidence));
}
