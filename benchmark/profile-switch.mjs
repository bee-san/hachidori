#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Profile switch (docs/languages.md 19): a Japanese and an English profile
// with one dictionary each; the toolbar switches the active profile and a real
// pointer hover then opens the popup in the new profile. Each switch records
// the click (toolbar page clock), when the reading page's content script saw
// `languageSelection` change (a storage listener added after content.js's
// own), and the hover after it with benchmark/hover-popup-probe.js: input to
// first and complete result, the hd_lookup round trip and the theme's
// synchronous render time. Every hover starts
// from a hidden popup (Escape), so the first hover after a switch compares
// with the other hovers in the same profile on equal terms.
//
//   node benchmark/profile-switch.mjs <output.json> --archive ja=jitendex.zip --archive en=kty-en-en.zip \
//     [--words ja=食べる,漢字 --words en=house,running] [--sessions 3] [--switches 20] [--hovers 3]
//   HACHIDORI_BENCH_REPO=<checkout> measures another checkout's extension.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.env.HACHIDORI_BENCH_REPO ?? join(import.meta.dirname, ".."));
const OUTPUT = resolve(process.argv[2]);
const values = name => process.argv.flatMap((value, index) => (process.argv[index - 1] === `--${name}` ? [value] : []));
const pairs = name => new Map(values(name).map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
const ARCHIVES = pairs("archive");
const WORDS = new Map([["ja", "食べる,漢字"], ["en", "house,running"], ...pairs("words")].map(([code, list]) => [code, list.split(",")]));
const SESSIONS = Number(values("sessions")[0] ?? 3);
const SWITCHES = Number(values("switches")[0] ?? 20);
const HOVERS = Number(values("hovers")[0] ?? 3);
assert.ok(ARCHIVES.has("ja") && ARCHIVES.has("en"), "--archive ja=… and --archive en=…");
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const probe = readFileSync(new URL("./hover-popup-probe.js", import.meta.url), "utf8");
// hover-popup.mjs's reader options, so the hovers are comparable with its own.
const SETTINGS = { hoverEnabled: true, lookupMode: "hover", popupNestingMaxDepth: 2, popupWidthPx: 520, popupHeightPx: 500,
  popupColumns: 1, maxResults: 32, definitionBlurCountEnabled: false, showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 3 };
// One word per paragraph, with white space between them, so an English scan
// does not run into the next word.
const spans = [...WORDS].flatMap(([code, words]) => words.map((word, index) => `<p><span id="${code}${index}">${word}</span></p>`)).join("\n");
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8"><style>body{font:32px sans-serif;margin:60px}p{margin:0 0 40px}</style>${spans}`);
});
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

async function session(index) {
  const directory = mkdtempSync(join(tmpdir(), "hachidori-profile-switch-"));
  const extension = join(directory, "extension");
  cpSync(join(ROOT, "extension"), extension, { recursive: true });
  const contentPath = join(extension, "content.js");
  const marker = "  start();\n}());";
  const content = readFileSync(contentPath, "utf8");
  assert.equal(content.split(marker).length, 2);
  writeFileSync(contentPath, content.replace(marker, `${probe}\n${marker}`));
  const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, enableExtensions: true,
    userDataDir: join(directory, "profile"), protocolTimeout: 300_000,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--disable-gpu", "--disable-dev-shm-usage",
      ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])] });
  const rows = [];
  try {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"));
    const id = new URL(worker.url()).host;
    const settings = await browser.newPage();
    settings.setDefaultTimeout(120_000);
    await settings.evaluateOnNewDocument(() => {
      const original = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function observed(type, listener, options) {
        if (type === "change" && this instanceof HTMLInputElement && this.id === "import-file") globalThis.__benchImportHandler = true;
        return original.call(this, type, listener, options);
      };
    });
    const send = fields => settings.evaluate(value => chrome.runtime.sendMessage({ requestId: `bench-${Date.now()}`, ...value }), fields);
    const importInto = async (archive, count, profileId = null) => {
      await settings.goto(`chrome-extension://${id}/settings.html${profileId ? `?profile=${profileId}` : ""}#add-dictionaries`);
      await settings.waitForFunction(() => globalThis.__benchImportHandler === true, { polling: 50 });
      await (await settings.$("#import-file")).uploadFile(archive);
      await settings.waitForFunction(async (count) => {
        const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
        const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
        return dictionaryState?.dictionaries?.length === count && status?.ok && status.ready && !status.loading;
      }, { polling: 100 }, count);
    };
    await importInto(ARCHIVES.get("ja"), 1);
    const options = (await settings.evaluate(() => chrome.storage.local.get("options"))).options;
    const written = await send({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision, options: SETTINGS });
    assert.ok(written?.ok, JSON.stringify(written));
    // The English profile copies the Japanese profile's settings.
    const added = await send({ target: "hoshidicts-offscreen", type: "hd_profile_add", language: "en", copyFrom: "ja" });
    assert.ok(added?.ok, JSON.stringify(added));
    await importInto(ARCHIVES.get("en"), 2, "en");
    const installed = await settings.evaluate(async () => ({ ...(await chrome.storage.local.get(["options", "dictionaryState", "languageSelection"])),
      status: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }) }));
    const toolbar = await browser.newPage();
    await toolbar.goto(`chrome-extension://${id}/toolbar.html`, { waitUntil: "load" });
    await toolbar.waitForSelector('#language-switcher [data-profile-id="en"]');
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1440, height: 1000 });
    const cdp = await tab.createCDPSession();
    const contexts = [];
    cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
    await cdp.send("Runtime.enable");
    await tab.goto(`http://127.0.0.1:${server.address().port}`);
    await tab.bringToFront();
    let contextId;
    for (let retry = 0; retry < 100 && !contextId; retry += 1) {
      for (const context of contexts) {
        const value = await cdp.send("Runtime.evaluate", { contextId: context.id, expression: "typeof __hoverProbe", returnByValue: true }).catch(() => null);
        if (value?.result.value === "object") contextId = context.id;
      }
      if (!contextId) await wait(50);
    }
    assert.ok(contextId, "content-script probe ready");
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { contextId, expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    // Registered after content.js's listener, so it runs once the reader has
    // adopted the change.
    await evaluate(`globalThis.__switches = []; chrome.storage.onChanged.addListener(changes => {
      if (changes.languageSelection) __switches.push({ at: performance.timeOrigin + performance.now(), id: changes.languageSelection.newValue?.activeProfileId });
    }); performance.timeOrigin`);
    const pointAt = selector => tab.$eval(selector, node => {
      const range = document.createRange();
      range.setStart(node.firstChild, 0);
      range.setEnd(node.firstChild, 1);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width * 0.5, y: box.y + box.height / 2 };
    });
    // Escape hides the popup; then the pointer rests on empty space.
    const hidePopup = async () => {
      await tab.mouse.move(5, 990);
      await tab.keyboard.press("Escape");
      for (let retry = 0; retry < 200; retry += 1) {
        const state = await evaluate("__hoverProbe.state()");
        if (!state[0] || state[0].hidden || !state[0].connected) return;
        await wait(10);
      }
      throw new Error("the popup did not hide");
    };
    const expected = new Map();
    // `hidden`: the popup is already hidden (the switch's first hover).
    const hover = async (code, word, { hidden = false } = {}) => {
      if (!hidden || !expected.has(word)) await hidePopup();
      const selector = `#${code}${WORDS.get(code).indexOf(word)}`;
      // The first hover of each word learns the expression its first result has.
      if (!expected.has(word)) {
        await evaluate(`__hoverProbe.arm(${JSON.stringify("\u0000")}, 0)`);
        const point = await pointAt(selector);
        await tab.mouse.move(point.x, point.y);
        let reply;
        for (let retry = 0; retry < 500 && !reply; retry += 1) {
          reply = (await evaluate("__hoverProbe.read()")).replies.at(-1);
          if (!reply) await wait(10);
        }
        assert.ok(reply?.count > 0, `${word} found nothing`);
        expected.set(word, reply.results[0].term.expression);
        await hidePopup();
      }
      await evaluate(`__hoverProbe.arm(${JSON.stringify(expected.get(word))}, 0)`);
      const point = await pointAt(selector);
      await tab.mouse.move(point.x, point.y);
      let row;
      for (let retry = 0; retry < 1000; retry += 1) {
        row = await evaluate("__hoverProbe.read()");
        if (row.complete !== null) break;
        await wait(5);
      }
      assert.ok(row.complete !== null, `${word}: no complete result in the ${code} profile`);
      const reply = row.replies.at(-1);
      return { word, code, expression: expected.get(word), origin: await evaluate("performance.timeOrigin"), start: row.start,
        firstMs: row.first - row.start, completeMs: row.complete - row.start, lookupMs: reply.received - reply.sent,
        sentMs: reply.sent - row.start, count: reply.count, replies: row.replies.length,
        // The theme's synchronous renderResults calls for this hover.
        renderMs: row.renderer.samples.reduce((sum, sample) => sum + sample.ms, 0), renders: row.renderer.samples.length };
    };
    const choose = id => toolbar.evaluate(wanted => {
      const at = performance.timeOrigin + performance.now();
      document.querySelector(`#language-switcher [data-profile-id="${wanted}"]`).click();
      return at;
    }, id);
    // Warm-up: each word in its own profile once, excluded.
    for (const code of ["en", "ja"]) {
      await choose(code);
      for (let retry = 0; retry < 500 && (await evaluate("__switches.at(-1)?.id")) !== code; retry += 1) await wait(5);
      for (const word of WORDS.get(code)) await hover(code, word);
    }
    for (let round = 0; round < SWITCHES; round += 1) {
      const code = round % 2 === 0 ? "en" : "ja";
      const words = WORDS.get(code);
      const order = Math.floor(round / 2) % 2 === 0 ? words : [...words].reverse();
      await hidePopup();
      const seen = await evaluate("__switches.length");
      const clickAt = await choose(code);
      let adopted = null;
      for (let retry = 0; retry < 2000 && !adopted; retry += 1) {
        adopted = await evaluate(`__switches.length > ${seen} ? __switches.at(-1) : null`);
        if (!adopted) await wait(1);
      }
      assert.equal(adopted?.id, code, "the reader adopted the switch");
      const hovers = [];
      for (let i = 0; i <= HOVERS; i += 1) hovers.push(await hover(code, order[i % order.length], { hidden: i === 0 }));
      const [first] = hovers;
      const row = { session: index, round, to: code, clickToAdoptMs: adopted.at - clickAt,
        clickToFirstPopupMs: first.origin + first.start + first.firstMs - clickAt, hovers };
      rows.push(row);
      console.log(JSON.stringify({ session: index, round, to: code, clickToAdoptMs: row.clickToAdoptMs.toFixed(1),
        clickToFirstPopupMs: row.clickToFirstPopupMs.toFixed(1), first: hovers.map(h => h.firstMs.toFixed(1)).join("/"),
        lookup: hovers.map(h => h.lookupMs.toFixed(2)).join("/"), render: hovers.map(h => h.renderMs.toFixed(1)).join("/") }));
    }
    return { installed: { languages: installed.options.profiles?.map(profile => profile.language),
      dictionaries: installed.dictionaryState.dictionaries.map(row => row.title), status: installed.status }, expected: Object.fromEntries(expected), rows };
  } finally {
    await browser.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}

const result = { harness: "benchmark/profile-switch.mjs", revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  chrome: execFileSync(process.env.HACHIDORI_CHROME, ["--version"], { encoding: "utf8" }).trim(), node: process.version,
  cpu: cpus()[0].model, logicalCpus: cpus().length, loadAtStart: loadavg(), archives: Object.fromEntries(ARCHIVES),
  words: Object.fromEntries(WORDS), settings: SETTINGS, switches: SWITCHES, hovers: HOVERS, sessions: [] };
try {
  for (let index = 0; index < SESSIONS; index += 1) {
    result.sessions.push(await session(index));
    writeFileSync(OUTPUT, `${JSON.stringify({ ...result, loadAtEnd: loadavg() }, null, 2)}\n`);
  }
} finally {
  server.close();
}
console.log(`wrote ${OUTPUT}`);
