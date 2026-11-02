// Anki and recorded-audio parity probe for the #644 audit. Not part of the repo.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.argv[2];
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const { answerAnkiConnect } = await import(join(REPO, "test/anki-connect-fake.mjs"));
const { makeAudioWav } = await import(join(REPO, "test/make-fixture.mjs"));
const EXTENSION = process.env.PROBE_EXTENSION ?? join(REPO, "extension");
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const notes = new Map(); const calls = []; const files = new Map();
const wav = makeAudioWav();
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/audio/")) {
    response.setHeader("Content-Type", "audio/wav");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end(wav);
    return;
  }
  if (request.method === "POST" || request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "*");
    if (request.method === "OPTIONS") { response.end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const reply = await answerAnkiConnect(JSON.parse(body), async (action, params) => {
      calls.push(action);
      if (action === "version") return 6;
      if (action === "requestPermission") return { permission: "granted", requireApikey: false, version: 6 };
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "modelFieldNames") return ["Front", "Back", "Audio", "Picture"];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(note => ({ canAdd: ![...notes.values()].some(f => f.Front === note.fields.Front), error: null }));
      if (action === "canAddNotes") return params.notes.map(() => true);
      if (action === "addNote") { const id = notes.size + 1; notes.set(id, params.note.fields); return id; }
      if (action === "findNotes") return [];
      if (action === "notesInfo") return [];
      if (action === "getMediaFilesNames") return [];
      if (action === "storeMediaFile") { files.set(params.filename, (params.data ?? "").length); return params.filename; }
      if (action === "guiBrowse") return [];
      if (action === "getDeckConfig" || action === "getProfiles") return null;
      return null;
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reply));
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body style="font-size:24px;padding:40px"><p id="verb">食べたかった</p></body></html>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644d-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  for (const p of await browser.pages()) if (p.url().includes("startup.html")) await p.close();
  const fixture = readFileSync(join(REPO, "test/fixtures/hachidori-fixture.zip")).toString("base64");
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `audit-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(() => null);
      if (reply?.ok) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }, fixture);
  const written = await settings.evaluate(async base => {
    const { options } = await chrome.storage.local.get("options");
    const template = value => ({ value, overwriteMode: "overwrite" });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: {
        hoverEnabled: true, lookupMode: "hover", customPopupJavascript: "/* open */",
        audioSources: [{ id: "wav", type: "custom", url: `${base}/audio/{term}.wav`, enabled: true, voice: "" }],
        anki: { ...HDReaderOptions.normaliseOptions({}).anki, url: base, model: "Basic",
          fieldTemplates: { Front: template("{expression}"), Back: template("{glossary}"), Audio: template("{audio}"), Picture: template("{screenshot}") } } } });
    return reply;
  }, base);
  log("options written:", written?.ok, written?.error ?? "");
  await sleep(800);
  const state = target => target.evaluate(() => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    const popup = root?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const audio = popup?.querySelector(".gsm-hoshidicts-audio-button");
    const anki = popup?.querySelector(".gsm-hoshidicts-mine-button");
    return { open: Boolean(popup && !popup.hidden), audio: audio?.dataset.state ?? "idle", anki: anki ? [anki.className, anki.getAttribute("aria-label"), anki.dataset.state ?? null, anki.disabled] : null };
  });
  const watchAudio = target => target.evaluate(() => new Promise(resolve => {
    const button = document.querySelector("hachidori-host").shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"] .gsm-hoshidicts-audio-button');
    const states = []; const t0 = performance.now();
    const sample = () => states.push([Math.round(performance.now() - t0), button.dataset.state ?? "idle"]);
    const observer = new MutationObserver(sample); observer.observe(button, { attributes: true, attributeFilter: ["data-state"] });
    button.click(); sample();
    setTimeout(() => { observer.disconnect(); sample(); resolve(states); }, 4000);
  }));
  const clickAnki = target => target.evaluate(() => {
    const popup = document.querySelector("hachidori-host").shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const button = popup.querySelector(".gsm-hoshidicts-mine-button");
    button?.click();
    return Boolean(button);
  });
  const web = await browser.newPage();
  await web.setViewport({ width: 960, height: 760 });
  await web.goto(`${base}/`, { waitUntil: "load" });
  await sleep(800);
  const point = await web.evaluate(() => { const r = document.createRange(); const n = document.getElementById("verb").firstChild; r.setStart(n, 0); r.setEnd(n, 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await web.mouse.move(point.x, point.y, { steps: 3 });
  await web.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-audio-button"), { timeout: 10000 });
  const inside = await web.evaluate(() => { const r = document.querySelector("hachidori-host").shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]').getBoundingClientRect(); return { x: r.left + r.width - 40, y: r.top + r.height - 40 }; });
  await web.mouse.move(inside.x, inside.y, { steps: 4 });
  await sleep(1500);
  log("web before:", JSON.stringify(await state(web)));
  log("web audio:", JSON.stringify(await watchAudio(web)));
  log("web anki clicked:", await clickAnki(web)); await sleep(3000);
  log("web after anki:", JSON.stringify(await state(web)), "notes:", notes.size, "files:", JSON.stringify([...files]));
  const searchTab = await browser.newPage();
  await searchTab.setViewport({ width: 960, height: 760 });
  await searchTab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await sleep(500);
  const frameOf = () => searchTab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? searchTab.mainFrame();
  const search = new Proxy({}, { get: (_, key) => {
    if (["screenshot", "bringToFront", "keyboard", "mouse", "url", "setViewport"].includes(key)) return typeof searchTab[key] === "function" ? searchTab[key].bind(searchTab) : searchTab[key];
    const frame = frameOf();
    return typeof frame[key] === "function" ? frame[key].bind(frame) : frame[key];
  } });
  await search.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  await search.focus("#search-input");
  await search.$eval("#search-input", box => { box.value = "食べたかった"; });
  await search.keyboard.press("Enter");
  await search.waitForFunction(() => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-audio-button"), { timeout: 10000 });
  await sleep(1500);
  log("search before:", JSON.stringify(await state(search)));
  log("search audio:", JSON.stringify(await watchAudio(search)));
  // Delete the web note so the search page's add is not a duplicate.
  notes.clear();
  log("search anki clicked:", await clickAnki(search)); await sleep(3000);
  log("search after first click:", JSON.stringify(await state(search)));
  files.clear();
  log("search anki clicked again:", await clickAnki(search)); await sleep(3000);
  log("search after anki:", JSON.stringify(await state(search)), "notes:", notes.size, JSON.stringify([...notes.values()].map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v).slice(0, 60)])))), "files:", JSON.stringify([...files]));
  log("anki calls:", [...new Set(calls)].join(","));
} finally {
  await browser.close();
  server.close();
}
