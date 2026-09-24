// Evidence for issue #334 (theme proposal "tamagotchi-lcd"): screenshots of the
// REAL popup in the pinned Chrome for Testing, default theme vs the
// vendor/themes/tamagotchi-lcd theme (theme.css + theme.js through the
// worktree-only host from host-prototype.patch). Not part of any suite.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> DICTS=<dir with zips> node capture-tamagotchi-lcd.mjs
//
// Dictionaries imported through Settings → Add dictionaries: the repo fixture
// plus JMdict (English), KANJIDIC, JPDB v2.2 frequency and Kanjium pitch
// accents downloaded into $DICTS (never committed). A fake AnkiConnect on
// 127.0.0.1:8765 (test/anki-connect-fake.mjs) makes the B key's mining real;
// a one-second WAV served locally makes the A key's audio real.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));
const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const DICTS = process.env.DICTS;
const { AnkiConnectError, answerAnkiConnect } = await import(resolve(ROOT, "test/anki-connect-fake.mjs"));
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const ARCHIVES = [resolve(ROOT, "test/fixtures/hachidori-fixture.zip"),
  ...["JMdict_english.zip", "KANJIDIC_english.zip", "JPDB_v2.2_Frequency_Kana.zip", "kanjium_pitch_accents.zip"].map(name => resolve(DICTS, name))];
for (const archive of ARCHIVES) if (!existsSync(archive)) throw new Error(`missing ${archive}`);
const PROFILE = "/tmp/tamagotchi-lcd-profile";
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });
const SLUG = "tamagotchi-lcd";

// ---- local servers: the reading page + a WAV, and a fake AnkiConnect ----
function makeWav() {
  const samples = 8000 * 4, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(i % 2 ? 100 : -100, 44 + i * 2);
  return wav;
}
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>tamagotchi-lcd evidence</title>
<style>body{font:30px/2.1 "Noto Sans CJK JP",serif;padding:40px 70px;background:#f4efe6;color:#222;max-width:820px} span{display:inline-block}</style>
</head><body><p>朝ごはんを<span id="verb">食べたかった</span>。壁に絵を<span id="long">掛ける</span>。<span id="w3">図書館</span>で本を<span id="w4">読む</span>。</p>
<p><span id="w5">昨日</span>は<span id="w6">友達</span>と<span id="w7">映画</span>を見た。</p></body></html>`;
const wav = makeWav();
const server = createServer((request, response) => {
  if (request.url.startsWith("/audio")) {
    response.writeHead(200, { "content-type": "audio/wav", "access-control-allow-origin": "*" });
    response.end(wav);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;
const AUDIO_URL = `${PAGE_URL}audio?term={term}&reading={reading}`;

const notes = new Map(), ankiCalls = [];
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
      if (action === "modelFieldNames") return ["Front", "Back"];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(note => {
        const duplicate = [...notes.values()].some(fields => fields.Front === note.fields.Front);
        return { canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null };
      });
      if (action === "addNote") { const id = notes.size + 1; notes.set(id, params.note.fields); return id; }
      if (action === "findNotes") {
        if (params.query.endsWith(" is:review -is:learn prop:ivl>=21")) return [];
        const front = /front:((?:\\.|[^"])*)"/iu.exec(params.query)?.[1]?.replace(/\\(.)/gu, "$1");
        return [...notes].filter(([, fields]) => front === undefined || fields.Front === front).map(([id]) => id);
      }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(notes.get(noteId) ?? {}).map(([field, value]) => [field, { value }])) }));
      if (action === "getMediaFilesNames") return [];
      if (action === "storeMediaFile") return params.filename;
      if (action === "guiBrowse") return [...notes.keys()];
      if (action === "updateNoteFields") return null;
      throw new AnkiConnectError(`unsupported action ${action}`);
    });
    response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    response.end(JSON.stringify(reply));
  });
});
await new Promise(done => anki.listen(8765, "127.0.0.1", done));

const report = { chrome: null, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version, shots: {}, checks: {} };
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE, protocolTimeout: 90_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;

  // ---- import the dictionaries through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  const importStarted = Date.now();
  await (await settings.$("#import-file")).uploadFile(...ARCHIVES);
  report.importState = await settings.waitForFunction(count => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith(`Finished ${count} of ${count} archive`) ? text : false;
  }, { timeout: 600_000, polling: 500 }, ARCHIVES.length).then(h => h.jsonValue());
  report.importMs = Date.now() - importStarted;
  report.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
  console.error(`[import] ${report.importState} in ${report.importMs} ms`, JSON.stringify(report.importDetail));
  if (!report.importState.includes(`${ARCHIVES.length} imported`)) throw new Error(`import failed: ${report.importState}`);

  const step = label => console.error(`[step ${new Date().toISOString().slice(11, 19)}] ${label}`);
  const writeOptions = patch => (step(`options ${JSON.stringify(patch).slice(0, 80)}`), settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch));
  const ankiDefaults = await settings.evaluate(() => HDReaderOptions.normaliseOptions({}).anki);
  const template = value => ({ value, overwriteMode: "overwrite" });
  // Hover lookups, real audio from the local WAV, Anki through the fake AnkiConnect.
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100, hoverDelayMs: 0, audioAutoplay: false,
    audioSources: [{ id: "tama-wav", type: "custom", url: AUDIO_URL, enabled: true, voice: "" }],
    anki: { ...ankiDefaults, model: "Basic", fieldTemplates: { Front: template("{expression}"), Back: template("{glossary}") } } });

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.on("console", message => { if (!/Autofocus|Content-Security/u.test(message.text())) console.error(`[tab ${message.type()}] ${message.text()}`); });
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  await tab.setViewport({ width: 1100, height: 820, deviceScaleFactor: 2 });
  const worlds = await tab.createCDPSession();
  const contexts = [];
  worlds.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
  await worlds.send("Runtime.enable");
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));
  // The content script's isolated world holds window.__hdThemeHookTimings (worktree host patch).
  const hookTimings = async () => {
    for (const context of contexts) {
      const value = await worlds.send("Runtime.evaluate", { contextId: context.id, returnByValue: true,
        expression: "JSON.stringify(window.__hdThemeHookTimings || null)" }).catch(() => null);
      const parsed = value?.result?.value ? JSON.parse(value.result.value) : null;
      if (parsed) return parsed;
    }
    return null;
  };

  const popupState = () => tab.evaluate(slug => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const scroller = popup.querySelector(".gsm-hoshidicts-content-scroll");
    const style = node => node ? getComputedStyle(node) : null;
    const mine = popup.querySelector(".gsm-hoshidicts-mine-button");
    const audio = popup.querySelector(".gsm-hoshidicts-audio-button");
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      theme: host.dataset.hoshidictsTheme, themed: !!popup.querySelector(".tama-deck"),
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      background: style(popup).backgroundColor,
      headword: popup.querySelector(".gsm-hoshidicts-result-chrome .gsm-hoshidicts-expression")?.getAttribute("aria-label") ?? null,
      headwordSize: style(popup.querySelector(".gsm-hoshidicts-expression"))?.fontSize ?? null,
      glossSize: style(popup.querySelector(".gsm-hoshidicts-glossary-content"))?.fontSize ?? null,
      inkColor: style(popup.querySelector(".gsm-hoshidicts-glossary-content"))?.color ?? null,
      paper: style(popup).getPropertyValue("--tama-paper").trim() || null,
      scroll: scroller ? { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight } : null,
      fed: popup.querySelector(".tama-fed")?.textContent ?? null,
      hearts: popup.querySelectorAll(".tama-heart[data-lit]").length,
      atEnd: scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 : null,
      keyCFace: popup.querySelector(".tama-key-page") ? getComputedStyle(popup.querySelector(".tama-key-page")).visibility === "visible" ? "page" : popup.querySelector(".tama-key-else .tama-key-hint")?.textContent : null,
      mood: popup.querySelector(".tama-pet")?.dataset.mood ?? null,
      hover: popup.matches(":hover"),
      walk: popup.querySelector(".tama-pet") ? getComputedStyle(popup.querySelector(".tama-pet")).animationPlayState : null,
      petLeft: popup.querySelector(".tama-pet") ? getComputedStyle(popup.querySelector(".tama-pet")).left : null,
      react: popup.querySelector(".tama-pet")?.dataset.react ?? null,
      stage: popup.querySelector(".tama-pet")?.dataset.stage ?? null,
      mineState: mine?.dataset.state ?? (mine ? "none" : "absent"),
      audioState: audio?.dataset.state ?? (audio ? "idle" : "absent"),
      bitmapDots: (getComputedStyle(popup).getPropertyValue("--theme-kanji-bitmap").match(/px/gu) || []).length / 2,
      toast: popup.querySelector(".tama-toast")?.textContent ?? null,
      lookupStats: popup.querySelector(".gsm-hoshidicts-lookup-stats")?.textContent ?? null,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  }, SLUG);
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popupState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)}`);
      await new Promise(r => setTimeout(r, 150));
    }
  };
  const settle = (ms = 400) => tab.evaluate(ms => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ms)))), ms);
  async function hover(id, expect) {
    step(`hover ${id}`);
    const box = await (await tab.$(`#${id}`)).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(5, 5);
      await new Promise(r => setTimeout(r, 120));
      const point = { x: box.x + Math.min(18, box.width * 0.15), y: box.y + box.height / 2 };
      await tab.mouse.move(point.x, point.y);
      try {
        const state = await waitFor(expect, 2500);
        // Chrome keeps the popup's :hover from the frame it appeared in until the
        // pointer moves again; one pixel inside the word refreshes it.
        await tab.mouse.move(point.x + 1, point.y);
        return state;
      } catch (error) { console.error(`[hover ${id} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering #${id}`);
  }
  async function closePopup() {
    step("close");
    await tab.keyboard.press("Escape");
    await tab.mouse.move(5, 5);
    await new Promise(r => setTimeout(r, 500));
  }
  // Clicks inside the shadow root by centre point (so the real pointer path runs).
  const pointOf = selector => tab.evaluate(selector => {
    const node = document.querySelector("hachidori-host").shadowRoot.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, selector);
  async function clickIn(selector) {
    const point = await pointOf(selector);
    if (!point) throw new Error(`nothing to click for ${selector}`);
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
    return point;
  }
  async function clickKanji(character, expect, reopen = null) {
    // A hover popup can hide behind a screenshot; re-hover its word if it did.
    if (reopen && !(await popupState())) await hover(reopen, s => s.term > 0);
    const point = await tab.waitForFunction(character => {
      const link = [...document.querySelector("hachidori-host").shadowRoot.querySelectorAll(".gsm-hoshidicts-kanji-link")].find(b => b.textContent === character);
      const rect = link?.getBoundingClientRect();
      return rect?.width ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : false;
    }, { timeout: 10_000, polling: 100 }, character).then(handle => handle.jsonValue()).catch(async error => {
      const debug = await tab.evaluate(() => {
        const root = document.querySelector("hachidori-host")?.shadowRoot;
        const popup = root?.querySelector(".gsm-hoshidicts-popup");
        return { hidden: popup?.hidden, links: [...(root?.querySelectorAll(".gsm-hoshidicts-kanji-link") ?? [])].map(b => `${b.textContent}@${JSON.stringify(b.getBoundingClientRect())}`),
          text: popup?.textContent.replace(/\s+/g, " ").slice(0, 200) };
      });
      throw new Error(`${error.message}: ${JSON.stringify(debug)}`);
    });
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
    return waitFor(expect);
  }
  async function shot(name, { pad = 30 } = {}) {
    await settle();
    const fresh = await popupState();
    const clip = { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad),
      width: Math.min(1100, fresh.rect.width + pad * 2), height: Math.min(820, fresh.rect.height + pad * 2) };
    await tab.screenshot({ captureBeyondViewport: false, path: resolve(OUT, `${name}.png`), clip });
    report.shots[name] = fresh;
    console.error(`[shot] ${name} ${JSON.stringify({ rect: fresh.rect, keyC: fresh.keyCFace, atEnd: fresh.atEnd, fed: fresh.fed, mood: fresh.mood, react: fresh.react, mine: fresh.mineState, audio: fresh.audioState })}`);
    return fresh;
  }

  // ---- default theme ----
  await hover("verb", s => s.term > 0);
  await shot("default-term");
  await clickKanji("食", s => s.kanji > 0, "verb");
  await shot("default-kanji");
  await closePopup();
  await hover("long", s => s.term > 0);
  await shot("default-long");
  await closePopup();

  // ---- the theme, at the reader's default 560 × 420 ----
  await writeOptions({ popupTheme: SLUG });
  await tab.waitForFunction(slug => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === slug, { timeout: 15_000 }, SLUG);
  await hover("verb", s => s.term > 0 && s.themed);
  await shot("theme-term-560x420");
  await closePopup();

  // ---- the theme's suggested size (theme.yaml options) for the rest ----
  await writeOptions({ popupWidthPx: 520, popupHeightPx: 560, popupOpacityPercent: 88 });
  await new Promise(r => setTimeout(r, 400));
  const term = await hover("verb", s => s.term > 0 && s.themed);
  report.checks.termView = term;
  await shot("theme-term");
  // Deck hover and keyboard focus states. The pointer stays on the shell so the
  // hover popup does not close while the keyboard is used.
  const parkMouse = async () => { const { rect } = await popupState(); await tab.mouse.move(rect.x + 18, rect.y + rect.height / 2); };
  const keyA = await pointOf(".tama-key-a");
  await tab.mouse.move(keyA.x, keyA.y);
  await shot("theme-key-hover");
  await parkMouse();
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".tama-key-b").focus());
  await tab.keyboard.press("Tab");         // focus-visible on C via the keyboard
  await tab.keyboard.down("Shift"); await tab.keyboard.press("Tab"); await tab.keyboard.up("Shift");
  await shot("theme-key-focus");
  // A: audio. The local WAV is real, so the button reaches data-state=playing.
  await clickIn(".tama-key-a");
  report.checks.audio = await waitFor(s => s.audioState === "playing" || s.audioState === "error", 8000);
  await tab.screenshot({ captureBeyondViewport: false, path: resolve(OUT, "theme-audio-playing.png"), clip: { x: Math.max(0, term.rect.x - 30), y: Math.max(0, term.rect.y - 30), width: term.rect.width + 60, height: term.rect.height + 60 } });
  report.shots["theme-audio-playing"] = await popupState();
  await new Promise(r => setTimeout(r, 4500));
  // Kanji view from the headword, with the 24-dot bitmap.
  const kanji = await clickKanji("食", s => s.kanji > 0 && s.themed, "verb");
  report.checks.kanjiView = kanji;
  await shot("theme-kanji");
  // C pages the kanji view to its end, then turns into Back.
  for (let presses = 0; presses < 6 && (await popupState()).atEnd === false; presses += 1) {
    await clickIn(".tama-key-c");
    await new Promise(r => setTimeout(r, 700));
  }
  report.checks.kanjiEnd = await waitFor(s => s.atEnd === true && s.keyCFace === "back", 3000);
  await shot("theme-kanji-end");
  await clickIn(".tama-key-c");
  report.checks.backViaC = await waitFor(s => s.term > 0 && s.themed);
  await closePopup();

  // ---- three moments of the walk cycle, floor only. Keyboard focus on a key
  // keeps the popup open while the pointer leaves it (hover pauses the walk). ----
  await hover("verb", s => s.term > 0 && s.themed);
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".tama-key-c").focus());
  await tab.mouse.move(5, 5);
  await new Promise(r => setTimeout(r, 900));
  for (let frame = 0; frame < 3; frame += 1) {
    const box = await tab.evaluate(() => {
      const rect = document.querySelector("hachidori-host").shadowRoot.querySelector(".tama-floor").getBoundingClientRect();
      return { x: rect.x, y: rect.y - 6, width: rect.width, height: rect.height + 6 };
    });
    await tab.screenshot({ captureBeyondViewport: false, path: resolve(OUT, `theme-walk-${frame}.png`), clip: box });
    report.checks[`walk${frame}`] = await popupState();
    console.error(`[walk ${frame}] ${JSON.stringify({ hover: report.checks[`walk${frame}`].hover, walk: report.checks[`walk${frame}`].walk, left: report.checks[`walk${frame}`].petLeft })}`);
    await new Promise(r => setTimeout(r, 1300));
  }
  await closePopup();

  // ---- a long multi-sense entry: pager ----
  const long = await hover("long", s => s.term > 0 && s.themed);
  report.checks.longPage1 = long;
  await shot("theme-long-page1");
  await clickIn(".tama-key-c");
  await new Promise(r => setTimeout(r, 700));
  report.checks.longPage2 = await popupState();
  await shot("theme-long-page2");
  await closePopup();

  // ---- feeding: B mines through the fake AnkiConnect, Tango eats ----
  await hover("w3", s => s.term > 0 && s.themed && s.mineState !== "absent" && s.mineState !== "checking");
  await shot("theme-before-feed");
  await clickIn(".tama-key-b");
  report.checks.feedMining = await waitFor(s => ["mining", "success", "view-existing"].includes(s.mineState), 15_000);
  // Catch a chomp frame while the reaction plays.
  try { await waitFor(s => s.react === "fed", 6000); } catch (error) { console.error(`[feed] no react: ${error.message.slice(0, 200)}`); }
  await new Promise(r => setTimeout(r, 350));
  await shot("theme-feeding");
  await new Promise(r => setTimeout(r, 2000));
  report.checks.afterFeed = await waitFor(s => s.fed === "FED 01", 8000);
  await shot("theme-after-feed");
  await closePopup();
  // Two more words: the leaf stage.
  for (const id of ["w4", "w5"]) {
    await hover(id, s => s.term > 0 && s.themed && !["absent", "checking"].includes(s.mineState));
    await clickIn(".tama-key-b");
    await waitFor(s => ["success", "view-existing"].includes(s.mineState), 15_000);
    await new Promise(r => setTimeout(r, 3600));
    await closePopup();
  }
  await hover("w6", s => s.term > 0 && s.themed && !["absent", "checking"].includes(s.mineState));
  report.checks.stage2 = await popupState();
  await shot("theme-stage2");
  await closePopup();

  // ---- sleepy: the same word looked up again and again ----
  for (let i = 0; i < 6; i += 1) { await hover("w7", s => s.term > 0 && s.themed); await closePopup(); }
  report.checks.sleepy = await hover("w7", s => s.term > 0 && s.themed && s.mood !== "awake");
  await shot("theme-sleepy");
  await closePopup();

  // ---- B without Anki: the key is dim and says so ----
  await writeOptions({ anki: { ...ankiDefaults } });
  await new Promise(r => setTimeout(r, 500));
  await hover("verb", s => s.term > 0 && s.themed && s.mineState === "absent");
  await clickIn(".tama-key-b");
  report.checks.noAnki = await waitFor(s => s.toast === "NO ANKI", 3000);
  await shot("theme-no-anki");
  await closePopup();

  // ---- reduced motion: still frames, no walk ----
  const cdp = await tab.createCDPSession();
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await hover("verb", s => s.term > 0 && s.themed);
  report.checks.reducedMotion = await tab.evaluate(() => {
    const root = document.querySelector("hachidori-host").shadowRoot;
    const pet = root.querySelector(".tama-pet"), sprite = root.querySelector(".tama-sprite");
    return { petAnimation: getComputedStyle(pet).animationName, spriteAnimation: getComputedStyle(sprite).animationName,
      scrollBehavior: getComputedStyle(root.querySelector(".gsm-hoshidicts-content-scroll")).scrollBehavior };
  });
  await shot("theme-reduced-motion");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await closePopup();

  // ---- contrast of the palette as rendered ----
  await hover("verb", s => s.term > 0 && s.themed);
  report.checks.colours = await tab.evaluate(() => {
    const root = document.querySelector("hachidori-host").shadowRoot;
    const popup = root.querySelector(".gsm-hoshidicts-popup");
    const colour = (selector, property = "color") => { const node = root.querySelector(selector); return node ? getComputedStyle(node)[property] : null; };
    return {
      paper: getComputedStyle(popup).getPropertyValue("--tama-paper").trim(),
      ink: colour(".gsm-hoshidicts-glossary-content"),
      inkSoft: colour(".tama-reading"),
      tabSelectedBg: colour('.gsm-hoshidicts-tab[aria-selected="true"]', "backgroundColor"),
      tabSelectedText: colour('.gsm-hoshidicts-tab[aria-selected="true"]'),
      shell: getComputedStyle(popup).getPropertyValue("--tama-shell").trim(),
      print: colour(".tama-key"),
    };
  });
  report.hookTimings = await hookTimings();
  await closePopup();
  report.ankiCalls = ankiCalls;
  report.notes = [...notes.values()];
} finally {
  await browser.close();
  server.close();
  anki.close();
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ importState: report.importState, importMs: report.importMs, shots: Object.keys(report.shots), notes: report.notes?.length }, null, 2));
