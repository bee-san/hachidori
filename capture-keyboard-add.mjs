// Evidence capture for the keyboard-focus fix (kept off the feature branch).
// Loads the real extension from <extensionDir> into Chrome for Testing, imports
// the test fixture, answers AnkiConnect with an in-memory fake on the worker
// and offscreen targets, then per palette hovers 食べたかった, focuses Add with
// the keyboard, presses Enter and captures the reading tab once the note is
// saved (or after 1.5 s if the popup has gone). Run from a Hachidori checkout
// with the locked test tooling, `node test/make-fixture.mjs` done and the
// pinned Chrome installed.
// Usage: node capture-keyboard-add.mjs <extensionDir> <label> <outputDir> [chromeBuild]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [extensionDir, label, outputDir, build = "152.0.7977.75"] = process.argv.slice(2);
const repo = process.cwd(); // a Hachidori checkout
const puppeteer = (await import(pathToFileURL(`${repo}/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`))).default;
const { answerAnkiConnect } = await import(pathToFileURL(`${repo}/test/anki-connect-fake.mjs`));
const { hoverForPopup, popupReader } = await import(pathToFileURL(`${repo}/test/chrome-e2e/popup-reader.mjs`));
mkdirSync(outputDir, { recursive: true });
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

const palettes = [
  { name: "hachidori-dark", theme: "default", scheme: "dark", forced: false },
  { name: "light", theme: "light", scheme: "light", forced: false },
  { name: "high-contrast", theme: "high-contrast", scheme: "dark", forced: false },
  { name: "forced-colors-dark", theme: "default", scheme: "dark", forced: true },
  { name: "forced-colors-light", theme: "default", scheme: "light", forced: true },
];

const server = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><html lang="ja"><body style="font:20px sans-serif;margin:40px">'
    + '<p><span id="verb">食べたかった</span>。</p><p style="height:600px"></p></body></html>');
}).listen(0, "127.0.0.1");
await new Promise(resolveListen => server.once("listening", resolveListen));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), "hd-keyboard-evidence-"));
const browser = await puppeteer.launch({
  executablePath: `${repo}/test/tmp/browsers/chrome/linux-${build}/chrome-linux64/chrome`,
  headless: true, enableExtensions: true, userDataDir: profile, defaultViewport: { width: 900, height: 640 },
  args: [`--disable-extensions-except=${resolve(extensionDir)}`, `--load-extension=${resolve(extensionDir)}`,
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output"],
});
const notes = new Map();
const results = [];
try {
  // AnkiConnect is answered on the worker and offscreen targets, as the suite does.
  async function intercept(target) {
    const session = await target.createCDPSession();
    session.on("Fetch.requestPaused", event => void (async () => {
      const reply = await answerAnkiConnect(JSON.parse(event.request.postData ?? "{}"), async (action, params) => {
        if (action === "deckNames") return ["Default"];
        if (action === "modelNames") return ["Basic"];
        if (action === "modelNamesAndIds") return { Basic: 1 };
        if (action === "modelFieldNames") return ["Front", "Back"];
        if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
        if (action === "addNote") { const id = notes.size + 1; notes.set(id, params.note.fields); return id; }
        if (action === "findNotes") return [];
        if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
          fields: Object.fromEntries(Object.entries(notes.get(noteId) ?? {}).map(([field, value]) => [field, { value }])) }));
        if (action === "getMediaFilesNames") return [];
        if (action === "storeMediaFile") return params.filename;
        if (action === "guiBrowse") return [...notes.keys()];
        return null;
      });
      await session.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }],
        body: Buffer.from(JSON.stringify(reply)).toString("base64") });
    })().catch(() => session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }).catch(() => {})));
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "http://127.0.0.1:8765/*", requestStage: "Request" }] });
    return session;
  }
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  await intercept(worker);
  const settings = await browser.newPage();
  await settings.goto(`${extensionOrigin}/settings.html#add-dictionaries`, { waitUntil: "domcontentloaded" });
  await intercept(await browser.waitForTarget(target => target.url().endsWith("/offscreen.html")));
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const status = await settings.evaluate(() => document.getElementById("engine-status")?.textContent ?? "");
    if (/^Ready/u.test(status.trim())) break;
    if (attempt % 20 === 0) console.log("engine status:", JSON.stringify(status));
    await wait(500);
  }
  console.log("engine ready");
  await (await settings.$("#import-file")).uploadFile(`${repo}/test/fixtures/hachidori-fixture.zip`);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const state = await settings.evaluate(() => document.getElementById("import-state")?.textContent ?? "");
    if (/1 imported/u.test(state)) break;
    if (attempt === 239) throw new Error(`fixture import did not finish: ${state}`);
    await wait(500);
  }
  console.log("fixture imported");
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  await settings.evaluate(async () => {
    const { setupState } = await chrome.storage.local.get("setupState");
    if (setupState?.stage !== "complete") {
      await chrome.storage.local.set({ setupState: { schemaVersion: 1, revision: (setupState?.revision ?? 0) + 1, stage: "complete" } });
    }
  });
  const tab = await browser.newPage();
  await tab.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await tab.bringToFront();
  const popup = await popupReader(tab);
  const cdp = await tab.createCDPSession();
  for (const [index, palette] of palettes.entries()) {
    // A first field of its own makes every Add a new note.
    await writeOptions({ popupTheme: palette.theme, popupHideDelayMs: 160, lookupMode: "hover",
      anki: { ...(await settings.evaluate(() => HDReaderOptions.normaliseOptions({}).anki)), model: "Basic",
        fieldTemplates: { Front: { value: `{expression} ${label} ${index}`, overwriteMode: "overwrite" },
          Back: { value: "{glossary}", overwriteMode: "overwrite" } } } });
    await cdp.send("Emulation.setEmulatedMedia", { features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: palette.scheme },
      ...(palette.forced ? [{ name: "forced-colors", value: "active" }] : []),
    ] });
    await tab.keyboard.press("Escape");
    const shown = await hoverForPopup(tab, popup, "#verb");
    let ready = null;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      const state = await popup.anki();
      if (state?.controls[0] && state.controls[0].state === "ready" && !state.controls[0].disabled) ready = state;
      else await wait(50);
    }
    // The pointer stays outside the popup, where a keyboard user's pointer usually is.
    await tab.mouse.move(2, 2);
    const focused = await popup.focusAnki();
    await tab.keyboard.press("Enter");
    let after = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      after = await popup.anki();
      if (after?.hidden || after?.controls[0]?.state === "success") break;
      await wait(50);
    }
    await wait(400);
    after = await popup.anki();
    const rect = ready?.rect ?? shown?.rect ?? { x: 0, y: 0, width: 900, height: 640 };
    const clip = { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: Math.min(900, rect.width + 16), height: Math.min(640, rect.height + 16) };
    await tab.screenshot({ path: resolve(outputDir, `${label}-${palette.name}.png`), clip });
    results.push({ label, palette: palette.name, focused, popupHidden: after?.hidden ?? null,
      state: after?.controls?.[0]?.state ?? null, actionFocused: after?.controls?.[0]?.focused ?? null,
      output: after?.controls?.[0]?.output ?? null });
  }
  console.log(`Chrome ${await browser.version()}`);
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
writeFileSync(resolve(outputDir, `${label}.json`), JSON.stringify(results, null, 2));
for (const r of results) console.log(`${r.label} ${r.palette}: popupHidden=${r.popupHidden} state=${r.state} actionFocused=${r.actionFocused} output=${JSON.stringify(r.output)}`);
