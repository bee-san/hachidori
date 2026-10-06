// SPDX-License-Identifier: GPL-3.0-or-later
//
// Word highlighting end to end (#520, phase 3): the real extension in Chrome,
// on a long novel-like page whose text is one block of <br>-separated lines.
//
//   - load to first marks and to settled marks, and how many ranges are kept;
//   - after scrolling a viewport, the time until the newly shown line is marked;
//   - hover latency, from the pointer's mousemove to the popup showing the
//     word, on an idle page and right after each scroll, while the page's new
//     lines are being segmented;
//   - main-thread long tasks over the run.
//
// Variants, each in fresh profiles: `main` (an extension directory without word
// highlighting, e.g. extracted from origin/main), `off` and `on` (this
// checkout with the switch off and on). AnkiConnect is a local fake whose
// index marks two of the hover words, so status is available and nothing
// reaches a real Anki.
//
//   HACHIDORI_WORD_TERM_ZIP=jitendex.zip [HACHIDORI_WORD_FREQ_ZIP=freq.zip] \
//   HACHIDORI_WORD_MAIN_EXTENSION=/tmp/main/extension \
//     node benchmark/word-highlights.mjs /tmp/word-highlight-results

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { resolve } from "node:path";
import { answerAnkiConnect } from "../test/anki-connect-fake.mjs";
import { REFERENCE_LINES } from "../test/segmentation-reference.mjs";
import "../extension/reader-options.js";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "test/tmp/word-highlights");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const chromeBuild = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8")).config.chrome;
const chrome = process.env.HACHIDORI_CHROME
  || resolve(root, `test/tmp/browsers/chrome/linux-${chromeBuild}/chrome-linux64/chrome`);
const archives = [process.env.HACHIDORI_WORD_TERM_ZIP, process.env.HACHIDORI_WORD_FREQ_ZIP].filter(Boolean);
if (archives.length === 0) throw new Error("HACHIDORI_WORD_TERM_ZIP names the term dictionary to segment with");
const variants = [
  ...(process.env.HACHIDORI_WORD_MAIN_EXTENSION ? [{ name: "main", extension: process.env.HACHIDORI_WORD_MAIN_EXTENSION }] : []),
  { name: "off", extension: resolve(root, "extension"), enabled: false },
  { name: "on", extension: resolve(root, "extension"), enabled: true },
];
const SESSIONS = Number(process.env.HACHIDORI_WORD_SESSIONS ?? 3);
const HOVERS = Number(process.env.HACHIDORI_WORD_HOVERS ?? 20);
const LINES = Number(process.env.HACHIDORI_WORD_LINES ?? 2000);
const TARGETS = ["地震", "天気"];

// Distinct lines from the reference sentences, numbered in kanji so no two
// sentences share a segmentation.
const DIGITS = "〇一二三四五六七八九";
const numeral = value => [...String(value)].map(digit => DIGITS[digit]).join("");
const lines = Array.from({ length: LINES }, (_, index) => {
  const first = REFERENCE_LINES[index % REFERENCE_LINES.length].text.replace(/[。！？]$/u, "");
  const second = REFERENCE_LINES[Math.floor(index / REFERENCE_LINES.length) % REFERENCE_LINES.length].text;
  return `${first}、その${numeral(index)}。${second}`;
});
const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
body { font: 22px/1.8 serif; margin: 0; padding: 110px 40px 40px; }
#targets { position: fixed; inset: 0 0 auto 0; height: 70px; padding: 10px 40px; background: #fff; font-size: 32px; }
</style><script>
window.__longTasks = [];
new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__longTasks.push(entry.duration); })
  .observe({ type: "longtask", buffered: true });
</script></head><body>
<div id="targets">${TARGETS.map((word, index) => `<span id="t${index}">${word}</span>`).join("　")}</div>
<div id="novel">${lines.join("<br>\n")}</div>
</body></html>`;

const cards = new Map([[1, TARGETS[0]], [2, TARGETS[1]]]);
const server = createServer(async (request, response) => {
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = await answerAnkiConnect(JSON.parse(body), async (action, params) => {
      if (action === "findNotes") return params.query.endsWith("prop:ivl>=21") ? [2] : [...cards.keys()];
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [noteId],
        fields: { Front: { value: cards.get(noteId), order: 0 } } }));
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelFieldNames") return ["Front", "Back"];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      if (action === "findCards") return [];
      throw new Error(`Unexpected Anki action ${action}`);
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
    return;
  }
  if (request.url.startsWith("/archive/")) {
    response.writeHead(200, { "content-type": "application/zip" });
    response.end(readFileSync(archives[Number(request.url.slice("/archive/".length))]));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE);
});

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] : null;
};
const summary = values => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: percentile(values, 100) });

async function session(variant, origin) {
  const profile = mkdtempSync(resolve(tmpdir(), "hachidori-word-bench-"));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, enableExtensions: true, userDataDir: profile,
    args: [`--disable-extensions-except=${variant.extension}`, `--load-extension=${variant.extension}`,
      "--disable-gpu", "--disable-dev-shm-usage", ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX ? ["--no-sandbox"] : [])] });
  try {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
    const settings = await browser.newPage();
    settings.setDefaultTimeout(300_000);
    await settings.goto(`chrome-extension://${new URL(worker.url()).host}/settings.html#advanced`);
    await settings.waitForFunction(async () => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return status.ok && status.ready && !status.loading;
    }, { polling: 200 });
    for (const [index] of archives.entries()) {
      await settings.evaluate(async url => {
        const blobUrl = URL.createObjectURL(await (await fetch(url)).blob());
        try {
          const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
            requestId: "word-bench", blobUrl, fileName: "dictionary.zip" });
          if (!reply.ok) throw new Error(reply.error);
        } finally { URL.revokeObjectURL(blobUrl); }
      }, `${origin}/archive/${index}`);
    }
    const options = globalThis.HDReaderOptions.normaliseOptions({});
    await settings.evaluate(async patch => {
      const { options: stored } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: stored?.revision ?? 0, options: patch });
      if (!reply.ok) throw new Error(reply.error);
    }, { hoverEnabled: true, lookupMode: "hover", showLookupCounts: false,
      anki: { ...options.anki, url: `${origin}/anki`, model: "Basic", fields: { ...options.anki.fields, expression: "Front" } },
      ...(variant.enabled === undefined ? {} : { experimental: { ...options.experimental, wordHighlighting: variant.enabled },
        wordHighlightEnabled: variant.enabled }) });
    // The index's first refresh, so word status is available before the page opens.
    await settings.waitForFunction(async () => Array.isArray((await chrome.runtime.sendMessage({ target: "hachidori-anki",
      type: "hd_anki_word_status", requestId: "word-bench", request: { headwords: [] } })).statuses), { polling: 200 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${origin}/novel`, { waitUntil: "load" });
    const result = { variant: variant.name, hoversIdle: [], hoversBusy: [], reveals: [] };
    if (variant.enabled) {
      // Settled once the count has not changed for a second.
      let first = null, settled = null, last = -1, since = 0;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const [count, now] = await page.evaluate(async () => [["unknown", "learning", "known"]
          .reduce((total, status) => total + (CSS.highlights.get(`hd-word-${status}`)?.size ?? 0), 0), performance.now()]);
        if (count > 0 && first === null) first = now;
        if (count !== last) { last = count; since = now; settled = now; }
        if (count > 0 && now - since >= 1000) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      Object.assign(result, { firstMarkMs: first, settledMs: settled, ranges: last });
    }
    // One hover: Escape closes the last popup and the pointer leaves for blank
    // header space, then enters the word; the latency runs from its mousemove
    // to the popup showing the word.
    const hover = async index => {
      await page.mouse.move(1200, 30);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => {
        const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
        return !popup || popup.hidden;
      }, { polling: 20, timeout: 5000 });
      const box = await (await page.$(`#t${index}`)).boundingBox();
      await page.evaluate(word => {
        window.__hovered = new Promise(resolveShown => {
          let moved = null;
          document.addEventListener("mousemove", event => { moved ??= event.timeStamp; }, { capture: true, once: true });
          const observer = new MutationObserver(() => {
            const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
            if (moved !== null && popup && !popup.hidden && popup.textContent.includes(word)) {
              observer.disconnect();
              resolveShown(performance.now() - moved);
            }
          });
          const watch = () => {
            const host = document.querySelector("hachidori-host");
            if (host) observer.observe(host.shadowRoot, { subtree: true, childList: true, attributes: true, characterData: true });
            else requestAnimationFrame(watch);
          };
          watch();
        });
      }, TARGETS[index]);
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
      return page.evaluate(() => Promise.race([window.__hovered,
        new Promise((_, reject) => setTimeout(() => reject(new Error("no popup")), 10_000))]));
    };
    for (let index = 0; index < 3; index += 1) await hover(index % 2);
    for (let index = 0; index < HOVERS; index += 1) result.hoversIdle.push(await hover(index % 2));
    for (let index = 0; index < HOVERS; index += 1) {
      // A viewport of new text, then at once the hover, while it is segmented.
      // Meanwhile each frame looks for a mark on the line now in the middle.
      await page.evaluate(watchMarks => {
        window.scrollBy(0, innerHeight * 0.9);
        const from = performance.now();
        const node = document.caretRangeFromPoint(innerWidth / 2, innerHeight * 0.6)?.startContainer;
        window.__revealed = !watchMarks || node?.nodeType !== 3 ? Promise.resolve(null) : new Promise(resolveReveal => {
          const check = () => {
            if (["unknown", "learning", "known"].some(status =>
              [...(CSS.highlights.get(`hd-word-${status}`) ?? [])].some(range => range.startContainer === node))) {
              resolveReveal(performance.now() - from);
            } else requestAnimationFrame(check);
          };
          check();
        });
      }, variant.enabled === true);
      result.hoversBusy.push(await hover(index % 2));
      const revealed = await page.evaluate(() => window.__revealed);
      if (revealed !== null) result.reveals.push(revealed);
    }
    result.longTasks = await page.evaluate(() => ({ count: window.__longTasks.length,
      totalMs: Math.round(window.__longTasks.reduce((sum, value) => sum + value, 0)),
      maxMs: Math.round(Math.max(0, ...window.__longTasks)) }));
    // The ranges kept once the page has scrolled far from where it started.
    if (variant.enabled) result.rangesAfterScroll = await page.evaluate(() => ["unknown", "learning", "known"]
      .reduce((total, status) => total + (CSS.highlights.get(`hd-word-${status}`)?.size ?? 0), 0));
    return result;
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

mkdirSync(output, { recursive: true });
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const runs = [];
try {
  // Variants alternate within every round, so load drift reaches each alike.
  for (let round = 0; round < SESSIONS; round += 1) {
    for (const variant of round % 2 ? [...variants].reverse() : variants) {
      const run = await session(variant, origin);
      runs.push(run);
      console.log(`${variant.name} session ${round + 1}: ${JSON.stringify({ first: run.firstMarkMs, settled: run.settledMs,
        ranges: run.ranges, idle: summary(run.hoversIdle).p50, busy: summary(run.hoversBusy).p50, longTasks: run.longTasks })}`);
    }
  }
} finally {
  server.close();
}
const report = { chrome: chromeBuild, node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length,
  load: loadavg(), archives, lines: LINES, sessions: SESSIONS, hovers: HOVERS,
  variants: Object.fromEntries(variants.map(({ name }) => {
    const own = runs.filter(run => run.variant === name);
    const pool = key => own.flatMap(run => run[key]);
    return [name, { hoverIdleMs: summary(pool("hoversIdle")), hoverBusyMs: summary(pool("hoversBusy")),
      revealMs: summary(pool("reveals")), firstMarkMs: own.map(run => run.firstMarkMs ?? null),
      settledMs: own.map(run => run.settledMs ?? null), ranges: own.map(run => run.ranges ?? null),
      rangesAfterScroll: own.map(run => run.rangesAfterScroll ?? null),
      longTasks: own.map(run => run.longTasks) }];
  })), runs };
writeFileSync(resolve(output, "word-highlights.json"), JSON.stringify(report, null, 2));
const ms = value => (value === null || value === undefined ? "–" : `${value.toFixed(1)} ms`);
for (const [name, variant] of Object.entries(report.variants)) {
  console.log(`${name.padEnd(4)} hover idle p50 ${ms(variant.hoverIdleMs.p50)} p95 ${ms(variant.hoverIdleMs.p95)}`
    + ` · after scroll p50 ${ms(variant.hoverBusyMs.p50)} p95 ${ms(variant.hoverBusyMs.p95)}`
    + (name === "on" ? ` · reveal p50 ${ms(variant.revealMs.p50)} p95 ${ms(variant.revealMs.p95)}`
      + ` · first mark ${variant.firstMarkMs.map(ms).join(", ")} · settled ${variant.settledMs.map(ms).join(", ")}`
      + ` · ranges ${variant.ranges.join(", ")} then ${variant.rangesAfterScroll.join(", ")}` : "")
    + ` · long tasks ${variant.longTasks.map(task => `${task.count}/${task.totalMs} ms`).join(", ")}`);
}
console.log(`Results: ${resolve(output, "word-highlights.json")}`);
