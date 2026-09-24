// Evidence for issue #334 ("Nazeka (JS) prototype"): screenshots of the REAL
// popup (content script + fixture dictionary) in the pinned Chrome for Testing,
// default theme vs the vendor/themes/nazeka prototype. Not part of the suite.
// A fake AnkiConnect (test/anki-connect-fake.mjs, the chrome-e2e handler set)
// listens on 127.0.0.1:8765 and an Anki note type is configured, so the Anki
// (mine) button is part of both captures.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> node capture-nazeka-js.mjs
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const PROFILE = "/tmp/nazeka-js-profile";
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>nazeka evidence</title>
<style>body{font:32px/2 "Noto Sans CJK JP",serif;padding:56px 80px;background:#f4efe6;color:#222} span{display:inline-block}</style>
</head><body><p>朝ごはんを<span id="verb">食べたかった</span>。</p></body></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

// Fake AnkiConnect on the default URL: the same actions chrome-e2e.mjs answers.
const { answerAnkiConnect } = await import(pathToFileURL(resolve(ROOT, "test/anki-connect-fake.mjs")).href);
const notes = new Map();
const ankiCalls = [];
const anki = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", async () => {
    const reply = await answerAnkiConnect(JSON.parse(body || "{}"), async (action, params) => {
      ankiCalls.push(action);
      if (action === "version") return 6;
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "modelFieldNames") return ["Front", "Back", "Audio"];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      if (action === "addNote") { const id = notes.size + 1; notes.set(id, params.note.fields); return id; }
      if (action === "findNotes") return [];
      if (action === "notesInfo") return [];
      if (action === "getMediaFilesNames") return [];
      if (action === "storeMediaFile") return params.filename;
      if (action === "guiBrowse") return [];
      throw new Error(`Unexpected Anki action ${action}`);
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
});
await new Promise(done => anki.listen(8765, "127.0.0.1", done));

const report = { chrome: null, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version, shots: {} };
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  browser.on("targetcreated", async target => {
    if (!target.url().endsWith("offscreen.html") && target.type() !== "service_worker") return;
    try {
      const cdp = await target.createCDPSession();
      await cdp.send("Runtime.enable");
      cdp.on("Runtime.consoleAPICalled", e => console.error(`[${target.type()} ${e.type}] ${(e.args || []).map(a => a.value ?? a.description ?? "").join(" ")}`));
      cdp.on("Runtime.exceptionThrown", e => console.error(`[${target.type()} exception] ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`));
    } catch (error) { console.error(`[watch] ${error.message}`); }
  });

  // ---- import the fixture dictionary through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  // As in chrome-e2e.mjs: wait for the empty-library starter card, i.e. the engine's start-up mutation is over.
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  await (await settings.$("#import-file")).uploadFile(FIXTURE);
  report.importState = await settings.waitForFunction(() => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith("Finished 1 of 1 archive") ? text : false;
  }, { timeout: 120_000, polling: 500 }).then(h => h.jsonValue());
  report.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
  console.error(`[import detail] ${JSON.stringify(report.importDetail)}`);
  if (!report.importState.includes("1 imported")) throw new Error(`fixture import failed: ${report.importState}`);

  // Hover lookups without an activation key, so the capture mirrors a plain hover.
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100 });
  // A configured note type is what makes the Anki button appear (anki-content.js:660).
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const template = value => ({ value, overwriteMode: "overwrite" });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
      options: { anki: { ...HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
        fieldTemplates: { Front: template("{expression}"), Back: template("{glossary}"), Audio: template("") } } } });
    if (!reply.ok) throw new Error(reply.error);
  });

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.on("console", message => console.error(`[tab console ${message.type()}] ${message.text()}`));
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  console.error(`[import] ${report.importState}`);
  await tab.setViewport({ width: 1000, height: 760, deviceScaleFactor: 2 });
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500)); // the host element is created lazily on the first lookup

  const popupState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      nazeka: !!popup.querySelector(".nazeka-original"),
      chromeHidden: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      buttons: [...popup.querySelectorAll("button")].filter(b => b.getClientRects().length > 0)
        .map(b => `${b.className.split(" ").find(c => c.endsWith("-button") || c.endsWith("-back") || c.endsWith("-link")) ?? b.className}:${(b.getAttribute("aria-label") || b.textContent).trim().slice(0, 24)}`),
      mineButton: !!popup.querySelector(".gsm-hoshidicts-mine-button"),
      audioButton: !!popup.querySelector(".gsm-hoshidicts-audio-button"),
      lookedUp: popup.querySelector(".nazeka-original")?.textContent.replace(/\s+/g, " ").trim() ?? null,
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      background: getComputedStyle(popup).backgroundColor,
      headwordSize: getComputedStyle(popup.querySelector(".gsm-hoshidicts-expression") || popup).fontSize,
      headwordColor: getComputedStyle(popup.querySelector(".gsm-hoshidicts-expression") || popup).color,
      readingInline: popup.querySelector(".nazeka-reading")?.textContent ?? null,
      glossSize: getComputedStyle(popup.querySelector(".gsm-hoshidicts-glossary-content") || popup).fontSize,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 240),
    };
  });
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    let last = null;
    for (;;) {
      const state = await popupState();
      if (state && predicate(state)) return state;
      if (state) last = state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)} (last non-null: ${JSON.stringify(last)})`);
      await new Promise(r => setTimeout(r, 200));
    }
  };
  const settle = () => tab.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 350)))));

  async function hoverVerb(expect) {
    const box = await (await tab.$("#verb")).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
      try { return await waitFor(expect, 4000); } catch (error) { console.error(`[hover attempt ${attempt}] ${error.message.slice(0, 400)}`); }
    }
    const debug = await tab.evaluate(() => {
      const host = document.querySelector("hachidori-host");
      return { host: !!host, shadow: !!host?.shadowRoot, children: host?.shadowRoot ? [...host.shadowRoot.children].map(c => `${c.tagName}.${c.className}#hidden=${c.hidden}`) : null };
    });
    throw new Error(`no popup after hovering 食べたかった: ${JSON.stringify(debug)}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 600));
  }
  async function clickKanji(character, expect, termState) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const point = await tab.evaluate(character => {
        const host = document.querySelector("hachidori-host");
        const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
        const link = popup && !popup.hidden && [...popup.querySelectorAll(".gsm-hoshidicts-kanji-link")].find(b => b.textContent === character);
        if (!link) return null;
        const rect = link.getBoundingClientRect();
        return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
      }, character);
      if (!point) { console.error(`[kanji attempt ${attempt}] popup or link missing; hovering again`); await hoverVerb(termState); continue; }
      await tab.mouse.move(point.x, point.y);
      await tab.mouse.click(point.x, point.y);
      try { return await waitFor(expect, 6000); } catch (error) { console.error(`[kanji attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`kanji view for ${character} never rendered`);
  }
  async function shot(name, state) {
    await settle();
    const fresh = await popupState();
    const pad = 28;
    const clip = { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad),
      width: Math.min(1000, fresh.rect.width + pad * 2), height: Math.min(760, fresh.rect.height + pad * 2) };
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip });
    report.shots[name] = fresh;
    return fresh;
  }

  // ---- default theme ----
  const defaultTerm = s => s.term > 0 && s.mineButton;   // the Anki button is bound after the render
  await hoverVerb(defaultTerm);
  await shot("default-term");
  await clickKanji("食", s => s.kanji > 0, defaultTerm);
  await shot("default-kanji");
  await closePopup();

  // ---- nazeka (JS) theme ----
  await writeOptions({ popupTheme: "nazeka" });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "nazeka", { timeout: 15_000 });
  const nazekaTerm = s => s.term > 0 && s.nazeka && s.mineButton;
  await hoverVerb(nazekaTerm);
  await shot("nazeka-term");
  await clickKanji("食", s => s.kanji > 0 && s.chromeHidden, nazekaTerm);
  await shot("nazeka-kanji");
  // Back returns to the term view and the hook runs again on the re-render.
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-kanji-back").click());
  report.shots["nazeka-back"] = await waitFor(s => s.term > 0 && s.nazeka);
  report.shots["nazeka-back"].ankiCallsSoFar = [...new Set(ankiCalls)];
  await closePopup();
} finally {
  await browser.close();
  server.close();
  anki.close();
}
report.ankiCalls = [...new Set(ankiCalls)];
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
