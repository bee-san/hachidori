// SPDX-License-Identifier: GPL-3.0-or-later
//
// Go to next/previous entry on Alt+ArrowDown/ArrowUp (#597), end to end: the
// real extension in Chrome, the keys sent through CDP's Input domain, and the
// popup's scroll pane read in the page on every animation frame.
//
//   - single presses: with Alt held, ArrowDown is tapped ten entries down, one
//     at a time, then ArrowUp back to the first;
//   - held: ArrowDown from the first entry, then ArrowUp from ten entries
//     down, each held for 1.5 s with an operating system's auto-repeat: a
//     500 ms delay, then a keydown with `repeat` set every 33 ms.
//
// A keydown's latency runs from its timestamp to the end of the main thread's
// work for the first frame after its handlers ran, when that frame shows the
// pane at another entry. Event Timing's durations (to the next paint; Chrome
// reports 16 ms and over) are kept beside it. The keys carry `isSystemKey`, as
// Alt combinations do on Windows and Linux, so an unhandled one scrolls nothing.
// macOS does not mark Option+ArrowDown, and Blink pages an unhandled one down,
// so a last hold of ArrowDown from the first entry goes without it and records
// how far the page scrolled (`heldMacOS`). Every variant gets a fresh profile
// each round, in alternating order.
//
//   git archive origin/main extension | tar -x -C /tmp/main
//   HACHIDORI_KEYBIND_ARCHIVE=/path/to/jitendex-yomitan.zip \
//     node benchmark/entry-keybind.mjs /tmp/entry-keybind main=/tmp/main/extension branch=extension

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, loadavg, tmpdir } from "node:os";
import { resolve } from "node:path";
import { summarizeValues } from "./lib.mjs";
import { directoryContentSha256 } from "./system.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const chromeBuild = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8")).config.chrome;
const chrome = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${chromeBuild}/chrome-linux64/chrome`);
const [outputPath = "test/tmp/entry-keybind", ...variantArguments] = process.argv.slice(2);
const output = resolve(outputPath);
const variants = (variantArguments.length ? variantArguments : ["branch=extension"]).map(argument => {
  const [name, path] = argument.split("=");
  return { name, extension: resolve(path) };
});
const archive = process.env.HACHIDORI_KEYBIND_ARCHIVE;
if (!archive) throw new Error("HACHIDORI_KEYBIND_ARCHIVE names the term dictionary to look the word up in");
const ROUNDS = Number(process.env.HACHIDORI_KEYBIND_ROUNDS ?? 5);
const WORD = process.env.HACHIDORI_KEYBIND_WORD ?? "きかん";
const STEPS = 10;
const HOLD = { delayMs: 500, intervalMs: 33, repeats: 31 };
const OPTIONS = { lookupMode: "hover", ...JSON.parse(process.env.HACHIDORI_KEYBIND_OPTIONS || "{}") };
// A directory for each variant's screenshot after the first round's held ArrowDown.
const SCREENSHOTS = process.env.HACHIDORI_KEYBIND_SCREENSHOTS;
const PAGE = `<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0;min-height:400vh">
<p id="word" style="font:32px serif;margin:60px">${WORD}</p></body></html>`;

// The page's own world: the pane is in the content script's open shadow root.
function probe() {
  const keys = [], frames = [], timings = [];
  const pane = () => document.querySelector("hachidori-host")?.shadowRoot
    ?.querySelector(".gsm-hoshidicts-popup:not([hidden]) .gsm-hoshidicts-content-scroll");
  const moves = event => event.altKey && ["ArrowDown", "ArrowUp"].includes(event.code);
  // Capture on the window runs before the content script's capture on the
  // document; the bubbling listener runs after it.
  addEventListener("keydown", event => {
    if (moves(event)) keys.push({ code: event.code, repeat: event.repeat, timeStamp: event.timeStamp, start: performance.now() });
  }, true);
  addEventListener("keydown", event => {
    const key = keys.at(-1);
    if (moves(event) && key?.timeStamp === event.timeStamp) {
      Object.assign(key, { end: performance.now(), prevented: event.defaultPrevented });
    }
  });
  // The task after an animation frame's callbacks starts once that frame's
  // style, layout and paint are done. Messages arrive in order.
  const channel = new MessageChannel(), rendering = [];
  channel.port1.onmessage = () => { rendering.shift().rendered = performance.now(); };
  const frame = time => {
    const scroll = pane();
    const sample = { time, at: performance.now(), top: scroll ? Math.round(scroll.scrollTop) : null,
      shown: scroll?.parentElement.querySelector("[data-shown-result]")?.dataset.shownResult ?? "0" };
    frames.push(sample);
    rendering.push(sample);
    channel.port2.postMessage(null);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.name === "keydown") timings.push({ startTime: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: "event", durationThreshold: 16 });
  window.__keybindProbe = {
    pane,
    take: () => ({ keys: keys.splice(0), frames: frames.splice(0), timings: timings.splice(0) }),
  };
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
const summary = values => values.length ? summarizeValues(values) : { n: 0 };

// Each keydown against the frames sampled around it: the state before it, the
// first frame after its handlers and whether that frame shows the pane moved.
function analyse({ keys, frames, timings }) {
  return keys.map(key => {
    const before = frames.findLast(frame => frame.at < key.start);
    const after = frames.find(frame => frame.at > key.end && frame.rendered !== undefined);
    const moved = Boolean(before && after) && (after.top !== before.top || after.shown !== before.shown);
    const timing = timings.find(entry => Math.abs(entry.startTime - key.timeStamp) < 1);
    // Where a move's time goes: waiting for the main thread, the keydown's
    // handlers, waiting for the next frame and that frame's rendering.
    return { ...key, moved, top: after?.top ?? null, shown: after?.shown ?? null,
      queueMs: key.start - key.timeStamp, handlerMs: key.end - key.start,
      waitMs: moved ? after.at - key.end : null, renderMs: moved ? after.rendered - after.at : null,
      frameMs: moved ? after.rendered - key.timeStamp : null, eventTimingMs: timing?.duration ?? null };
  });
}

async function session(variant, origin, index) {
  const profile = mkdtempSync(resolve(tmpdir(), "hachidori-keybind-bench-"));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true,
    userDataDir: profile, protocolTimeout: 600_000,
    args: [`--disable-extensions-except=${variant.extension}`, `--load-extension=${variant.extension}`,
      "--disable-gpu", "--disable-dev-shm-usage", ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX ? ["--no-sandbox"] : [])] });
  try {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker"
      && target.url().endsWith("/background.js"));
    const settings = await browser.newPage();
    settings.setDefaultTimeout(600_000);
    await settings.goto(`chrome-extension://${new URL(worker.url()).host}/settings.html#advanced`);
    await settings.waitForFunction(async () => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return status.ok && status.ready && !status.loading;
    }, { polling: 200 });
    await settings.evaluate(async url => {
      const blobUrl = URL.createObjectURL(await (await fetch(url)).blob());
      try {
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
          requestId: "keybind-bench", blobUrl, fileName: "dictionary.zip" });
        if (!reply.ok) throw new Error(reply.error);
      } finally { URL.revokeObjectURL(blobUrl); }
    }, `${origin}/archive`);
    await settings.evaluate(async patch => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: patch });
      if (!reply.ok) throw new Error(reply.error);
    }, OPTIONS);
    // The first-run tab and Settings stay out of the measured page's way.
    for (const page of await browser.pages()) if (page !== settings) await page.close();

    const tab = await browser.newPage();
    await settings.close();
    await tab.setViewport({ width: 1280, height: 900 });
    await tab.evaluateOnNewDocument(probe);
    await tab.goto(`${origin}/page`, { waitUntil: "load" });
    await tab.bringToFront();
    const cdp = await tab.createCDPSession();
    const point = await tab.$eval("#word", node => {
      const range = document.createRange();
      range.setStart(node.firstChild, 0);
      range.setEnd(node.firstChild, 1);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width * 0.3, y: box.y + box.height / 2 };
    });
    await tab.mouse.move(point.x, point.y + 200);
    await tab.mouse.move(point.x, point.y);
    // Every result rendered, with nothing left behind Show more.
    await tab.waitForFunction(() => {
      const scroll = window.__keybindProbe.pane();
      return scroll && !scroll.querySelector(".gsm-hoshidicts-show-more")
        && scroll.querySelectorAll(":scope > .gsm-hoshidicts-tab-panel > .gsm-hoshidicts-entry").length > 1;
    }, { timeout: 60_000, polling: 100 });
    await sleep(1500);
    // Where each entry lands: entry 0 at the top, a later entry's own header
    // under the pinned one (#488).
    const pane = await tab.evaluate(() => {
      const scroll = window.__keybindProbe.pane();
      const origin = scroll.getBoundingClientRect().top - scroll.scrollTop;
      return { maxScroll: scroll.scrollHeight - scroll.clientHeight,
        offsets: [...scroll.querySelectorAll(":scope > .gsm-hoshidicts-tab-panel > .gsm-hoshidicts-entry")]
          .map((entry, index) => Math.round((index === 0 ? entry.getBoundingClientRect().top
            : entry.querySelector(":scope > .gsm-hoshidicts-entry-header").getBoundingClientRect().bottom) - origin)) };
    });
    const reachable = pane.offsets.filter(offset => offset <= pane.maxScroll + 1).length;
    const steps = Math.min(STEPS, reachable - 1);
    assert.ok(steps >= 3, `the pane reaches only ${reachable} entries`);

    const KEYS = {
      Alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, location: 1 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
      Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    };
    const send = (type, name, extra = {}) => cdp.send("Input.dispatchKeyEvent",
      { type, modifiers: 1, isSystemKey: true, ...KEYS[name], ...extra });
    const tap = async (name, gapMs = 100) => {
      await send("rawKeyDown", name);
      await sleep(gapMs);
      await send("keyUp", name);
      await sleep(gapMs);
    };
    const take = () => tab.evaluate(() => window.__keybindProbe.take());
    // Clears the probe, then leaves it a few frames to read the pane from.
    const reset = async () => { await take(); await sleep(100); };
    const result = { variant: variant.name, chrome: await browser.version(), entries: pane.offsets.length, pane, reachable,
      steps };

    await send("rawKeyDown", "Alt");
    await reset();
    for (let step = 0; step < steps; step += 1) await tap("ArrowDown");
    for (let step = 0; step < steps; step += 1) await tap("ArrowUp");
    await sleep(200);
    result.single = analyse(await take());
    const expected = [...Array.from({ length: steps }, (_, step) => step + 1),
      ...Array.from({ length: steps }, (_, step) => steps - step - 1)];
    // The first entry scrolls the pane to its very top.
    const expectedTop = entry => entry === 0 ? 0 : Math.min(pane.offsets[entry], pane.maxScroll);
    result.singleCorrect = result.single.length === expected.length && result.single.every((key, index) =>
      key.moved && key.prevented && Math.abs(key.top - expectedTop(expected[index])) <= 1);

    async function hold(name, extra = {}) {
      const pageBefore = await tab.evaluate(() => scrollY);
      const pending = [send("rawKeyDown", name, extra)];
      const start = performance.now();
      for (let repeat = 0; repeat < HOLD.repeats; repeat += 1) {
        await sleep(start + HOLD.delayMs + repeat * HOLD.intervalMs - performance.now());
        pending.push(send("rawKeyDown", name, { autoRepeat: true, ...extra }));
      }
      await sleep(start + HOLD.delayMs + HOLD.repeats * HOLD.intervalMs - performance.now());
      pending.push(send("keyUp", name, extra));
      await Promise.all(pending);
      await sleep(300);
      const keys = analyse(await take());
      return { keys, ...await tab.evaluate(before => ({ finalTop: window.__keybindProbe.pane()?.scrollTop ?? null,
        pageScrolled: Math.round(scrollY - before) }), pageBefore) };
    }
    await tap("Home");
    await sleep(300);
    await reset();
    result.heldDown = await hold("ArrowDown");
    if (SCREENSHOTS && index === 0) {
      mkdirSync(SCREENSHOTS, { recursive: true });
      await tab.screenshot({ path: resolve(SCREENSHOTS, `${variant.name}-held-down.png`) });
    }
    // Back ten entries down with single presses, then hold Up.
    await tap("Home");
    for (let step = 0; step < steps; step += 1) await tap("ArrowDown");
    await sleep(300);
    await reset();
    result.heldUp = await hold("ArrowUp");
    // Last, as it may scroll the page: Option+ArrowDown is no system key on
    // macOS, where Blink pages an unhandled one down.
    await tap("Home");
    await sleep(300);
    await reset();
    result.heldMacOS = await hold("ArrowDown", { isSystemKey: false });
    await send("keyUp", "Alt", { modifiers: 0 });
    return result;
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const server = createServer((request, response) => {
  if (request.url === "/archive") {
    response.writeHead(200, { "content-type": "application/zip" });
    response.end(readFileSync(archive));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
mkdirSync(output, { recursive: true });
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const archiveBytes = readFileSync(archive);
writeFileSync(resolve(output, "definition.json"), JSON.stringify({
  revision, node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, load: loadavg(),
  chromeExecutable: chrome, rounds: ROUNDS, word: WORD, steps: STEPS, hold: HOLD, options: OPTIONS,
  archive: { path: archive, bytes: archiveBytes.length, sha256: createHash("sha256").update(archiveBytes).digest("hex") },
  variants: variants.map(variant => ({ ...variant, sha256: directoryContentSha256(variant.extension) })),
  harnessSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
}, null, 2));
const rows = [];
try {
  for (let index = 0; index < ROUNDS; index += 1) {
    for (const variant of index % 2 ? [...variants].reverse() : variants) {
      const row = { round: index, ...await session(variant, origin, index) };
      rows.push(row);
      writeFileSync(resolve(output, "raw.json"), JSON.stringify(rows, null, 2));
      const held = name => ({ moved: row[name].keys.filter(key => key.moved).length,
        prevented: row[name].keys.filter(key => key.prevented).length, events: row[name].keys.length,
        pageScrolled: row[name].pageScrolled });
      const { median, p95 } = summary(row.single.map(key => key.frameMs).filter(ms => ms !== null));
      console.log(JSON.stringify({ round: index, variant: variant.name, steps: row.steps, singleCorrect: row.singleCorrect,
        singleFrameMs: { median, p95 }, heldDown: held("heldDown"), heldUp: held("heldUp"), heldMacOS: held("heldMacOS") }));
    }
  }
} finally {
  await new Promise(done => server.close(done));
}

// Pooled over every round of a variant.
const report = Object.fromEntries(variants.map(({ name }) => {
  const own = rows.filter(row => row.variant === name);
  const single = code => own.flatMap(row => row.single).filter(key => key.code === code);
  const held = field => {
    const all = own.map(row => row[field].keys);
    return {
      eventsPerHold: summary(all.map(list => list.length)),
      preventedPerHold: summary(all.map(list => list.filter(key => key.prevented).length)),
      // Entries the pane moved through while the key was held.
      movesPerHold: summary(all.map(list => list.filter(key => key.moved).length)),
      repeatFrameMs: summary(all.flat().filter(key => key.moved && key.repeat).map(key => key.frameMs)),
      handlerMs: summary(all.flat().map(key => key.handlerMs)),
      pageScrolled: summary(own.map(row => row[field].pageScrolled)),
    };
  };
  return [name, {
    rounds: own.length, singleCorrect: own.every(row => row.singleCorrect), steps: own.map(row => row.steps),
    single: Object.fromEntries(["ArrowDown", "ArrowUp"].map(code => [code, {
      frameMs: summary(single(code).map(key => key.frameMs).filter(ms => ms !== null)),
      eventTimingMs: summary(single(code).map(key => key.eventTimingMs).filter(ms => ms !== null)),
      ...Object.fromEntries(["queueMs", "handlerMs", "waitMs", "renderMs"].map(field =>
        [field, summary(single(code).map(key => key[field]).filter(ms => ms !== null))])),
      prevented: single(code).filter(key => key.prevented).length, events: single(code).length,
    }])),
    heldDown: held("heldDown"),
    heldUp: held("heldUp"),
    heldMacOS: held("heldMacOS"),
  }];
}));
writeFileSync(resolve(output, "summary.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
