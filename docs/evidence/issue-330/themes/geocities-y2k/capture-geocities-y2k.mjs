// Evidence for issue #334 ("Theme proposal: Geocities Y2K"): screenshots of the
// REAL popup (content script + fixture dictionaries) in the pinned Chrome for
// Testing, default theme vs vendor/themes/geocities-y2k. Not part of the suite.
//
//   HACHIDORI_ROOT=<worktree with host-prototype.patch applied> EVIDENCE_OUT=<dir> \
//     node capture-geocities-y2k.mjs
//
// The extension is copied to a temp dir with one line of the prototype host
// changed: every onRender duration is logged, not only those over 8 ms, so the
// hook cost can be recorded (evidence.json → hookTimingsMs). Nothing else differs.
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = process.env.HACHIDORI_CHROME
  ?? resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const { buildTitledZip } = await import(pathToFileURL(resolve(ROOT, "test/make-fixture.mjs")).href);
const { answerAnkiConnect } = await import(pathToFileURL(resolve(ROOT, "test/anki-connect-fake.mjs")).href);

// A copy of the extension whose host logs every hook duration.
const WORK = mkdtempSync(resolve(tmpdir(), "y2k-capture-"));
const EXTENSION = resolve(WORK, "extension");
cpSync(resolve(ROOT, "extension"), EXTENSION, { recursive: true });
const contentPath = resolve(EXTENSION, "content.js");
const content = readFileSync(contentPath, "utf8");
const marker = "if (elapsed > 8) console.debug(`hachidori theme ${theme.slug}: onRender took ${elapsed.toFixed(1)} ms`);";
if (!content.includes(marker)) throw new Error("host-prototype.patch not applied to HACHIDORI_ROOT");
writeFileSync(contentPath, content.replace(marker,
  "console.debug(`hachidori theme ${theme.slug}: onRender took ${elapsed.toFixed(3)} ms`);"));
const PROFILE = resolve(WORK, "profile");
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

// A second dictionary: a long multi-sense card for 食べる (one of them with no
// gloss → 工事中), so the popup has two dictionaries (tabs) and a long entry.
const SECOND_TITLE = "Homepage Glossary";
const secondDictionary = buildTitledZip(SECOND_TITLE, { terms: [
  ["食べる", "たべる", "v1 vt", "v1", 200, ["to eat", "to have (a meal)"], 1, ""],
  ["食べる", "たべる", "v1 vt", "", 190, ["to live on (e.g. a salary); to make a living from"], 1, ""],
  ["食べる", "たべる", "v1 vt col", "", 180, ["to eat up (one's savings); to consume (time or money)"], 1, ""],
  ["食べる", "たべる", "v1 vt", "", 170, ["to take (a hit, a punch); to be on the receiving end of"], 1, ""],
  ["食べる", "たべる", "v1 vi", "", 160, [""], 1, ""],                            // no gloss: 工事中
  ["食べる", "たべる", "exp", "", 150, ["(in 「食べていく」) to get by; to survive"], 1, ""],
  ["読む", "よむ", "v5m vt", "v5", 60, ["to read", "to recite (a poem)", "to interpret (a situation)"], 4, ""],
] });
const secondPath = resolve(WORK, "homepage-glossary.zip");
writeFileSync(secondPath, secondDictionary);

// One-second PCM clip for the BGM button, served locally.
function makeWav() {
  const samples = 24000;                       // three seconds at 8 kHz
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(i % 2 ? 100 : -100, 44 + i * 2);
  return wav;
}
const WAV = makeWav();

const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>geocities-y2k evidence</title>
<style>body{font:32px/2 "Noto Sans CJK JP",serif;padding:56px 80px;background:#f4efe6;color:#222} span{display:inline-block}</style>
</head><body><p>朝ごはんを<span id="verb">食べたかった</span>。本を<span id="read">読む</span>。</p></body></html>`;
const server = createServer((request, response) => {
  if (request.url === "/audio.json") {
    response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    response.end(JSON.stringify({ type: "audioSourceList", audioSources: [{ url: `${origin}/bgm.wav`, name: "BGM" }] }));
    return;
  }
  if (request.url === "/bgm.wav") {
    response.writeHead(200, { "content-type": "audio/wav", "access-control-allow-origin": "*" });
    response.end(WAV);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const PAGE_URL = `${origin}/`;

const report = { chrome: null, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  shots: {}, hookTimingsMs: [], consoleErrors: [], ankiCalls: [] };
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
      cdp.on("Runtime.consoleAPICalled", e => {
        const line = `[${target.type()} ${e.type}] ${(e.args || []).map(a => a.value ?? a.description ?? "").join(" ")}`;
        console.error(line);
        if (e.type === "error") report.consoleErrors.push(line);
      });
      cdp.on("Runtime.exceptionThrown", e => {
        const line = `[${target.type()} exception] ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`;
        console.error(line);
        report.consoleErrors.push(line);
      });
    } catch (error) { console.error(`[watch] ${error.message}`); }
  });

  // ---- fake AnkiConnect on the service worker, so the 書き込む button exists ----
  const notes = new Map();
  const ankiSession = await worker.createCDPSession();
  ankiSession.on("Fetch.requestPaused", event => {
    void (async () => {
      const request = JSON.parse(event.request.postData);
      const reply = await answerAnkiConnect(request, async (action, params) => {
        report.ankiCalls.push(action);
        switch (action) {
          case "deckNames": return ["Default"];
          case "modelNames": return ["Basic"];
          case "modelNamesAndIds": return { Basic: 1 };
          case "modelFieldNames": return ["Front", "Back"];
          case "canAddNotesWithErrorDetail": return params.notes.map(note => {
            const duplicate = [...notes.values()].some(fields => fields.Front === note.fields.Front);
            return { canAdd: !duplicate, error: duplicate ? "cannot create note because it is a duplicate" : null };
          });
          case "addNote": { const id = notes.size + 1; notes.set(id, params.note.fields); return id; }
          case "findNotes": return /is:review/u.test(params.query) ? [] : [...notes.keys()];
          case "notesInfo": return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
            fields: Object.fromEntries(Object.entries(notes.get(noteId) ?? {}).map(([field, value]) => [field, { value }])) }));
          case "updateNoteFields": return null;
          case "getMediaFilesNames": return [];
          case "storeMediaFile": return params.filename;
          case "guiBrowse": return [...notes.keys()];
          default: console.error(`[anki fake] unexpected action ${action}`); return null;
        }
      });
      await ankiSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Content-Type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(reply)).toString("base64") });
    })().catch(async error => {
      console.error(`[anki fake] ${error.stack}`);
      await ankiSession.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }).catch(() => {});
    });
  });
  await ankiSession.send("Fetch.enable", { patterns: [{ urlPattern: "http://127.0.0.1:8765/", requestStage: "Request" }] });

  // ---- import both dictionaries through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  await (await settings.$("#import-file")).uploadFile(FIXTURE, secondPath);
  report.importState = await settings.waitForFunction(() => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith("Finished 2 of 2 archives") ? text : false;
  }, { timeout: 120_000, polling: 500 }).then(h => h.jsonValue());
  console.error(`[import] ${report.importState}`);
  if (!report.importState.includes("2 imported")) throw new Error(`import failed: ${report.importState}`);
  // Favourite the second dictionary: the reader shows dictionary tabs for
  // favourites and groups, and the theme turns those tabs into リンク集 buttons.
  report.favourite = await settings.evaluate(async title => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_cas",
      baseRevision: dictionaryState.revision, groups: dictionaryState.groups,
      dictionaries: dictionaryState.dictionaries.map(d => (d.title === title ? { ...d, favorite: true } : d)) });
    if (!reply.ok) throw new Error(reply.error);
    return reply.state.dictionaries.map(d => `${d.title}:${d.favorite === true}`);
  }, SECOND_TITLE);
  console.error(`[favourite] ${JSON.stringify(report.favourite)}`);

  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  // Plain hover, opaque popup, an Anki model so the mine button renders, a local BGM source.
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100,
    audioSources: [{ id: "bgm", type: "custom", url: `${origin}/bgm.wav`, enabled: true, voice: "" }], audioAutoplay: false });
  await settings.evaluate(async origin => {
    const { options } = await chrome.storage.local.get("options");
    const template = value => ({ value, overwriteMode: "overwrite" });
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options.revision,
      options: { anki: { ...HDReaderOptions.normaliseOptions({}).anki, model: "Basic",
        fieldTemplates: { Front: template("{expression}"), Back: template("{glossary}") } } } });
    if (!reply.ok) throw new Error(reply.error);
  }, origin);

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.on("console", message => {
    const line = `[tab console ${message.type()}] ${message.text()}`;
    console.error(line);
    const timing = /hachidori theme geocities-y2k: onRender took ([\d.]+) ms/u.exec(message.text());
    if (timing) report.hookTimingsMs.push(Number(timing[1]));
    if (message.type() === "error" || message.type() === "warn") report.consoleErrors.push(line);
  });
  tab.on("pageerror", error => { console.error(`[tab pageerror] ${error.message}`); report.consoleErrors.push(error.message); });
  await tab.setViewport({ width: 1000, height: 780, deviceScaleFactor: 2 });
  const tabCdp = await tab.createCDPSession();
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));

  const popupState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const style = node => (node ? getComputedStyle(node) : null);
    const expression = popup.querySelector(".gsm-hoshidicts-expression");
    const gloss = popup.querySelector(".gsm-hoshidicts-glossary-content");
    const counter = popup.querySelector(".y2k-counter");
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      y2k: !!popup.querySelector(".y2k-page"),
      chromeHidden: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      background: style(popup).backgroundColor,
      headwordSize: style(expression)?.fontSize, headwordColor: style(expression)?.color,
      glossSize: style(gloss)?.fontSize, glossColor: style(gloss)?.color,
      glossBackground: gloss ? style(gloss.closest(".gsm-hoshidicts-glossary-card") || gloss).backgroundColor : null,
      counterState: counter?.dataset.state ?? null,
      counterMood: counter?.querySelector(".y2k-counter-mood")?.textContent ?? null,
      reels: [...popup.querySelectorAll(".y2k-reel")].map(reel => reel.className.replace(/.*y2k-d(\d).*/u, "$1")).join(""),
      visit: popup.querySelector(".y2k-page")?.dataset.visit ?? null,
      kaomoji: popup.querySelector(".y2k-kaomoji")?.textContent ?? null,
      hitokoto: popup.querySelector(".y2k-hitokoto-text")?.textContent ?? null,
      marquee: popup.querySelector(".y2k-marquee-track")?.textContent ?? null,
      profileRows: [...popup.querySelectorAll(".y2k-th")].map(th => th.textContent),
      links: [...popup.querySelectorAll(".y2k-links .gsm-hoshidicts-tab, .y2k-links .y2k-banner")].map(b => `${b.textContent}${b.getAttribute("aria-selected") === "true" ? "*" : ""}`),
      guestbook: [...popup.querySelectorAll(".y2k-guestbook button")].map(b => `${b.className.split(" ")[0]}[${b.dataset.state ?? ""}]`),
      construction: popup.querySelectorAll(".gsm-hoshidicts-glossary-content:empty").length,
      stickers: [...popup.querySelectorAll(".y2k-sticker")].map(s => s.textContent),
      bullets: [...popup.querySelectorAll(".y2k-bullets li")].map(s => s.textContent),
      webring: popup.querySelector(".y2k-ring-label")?.textContent ?? null,
      sparkles: popup.querySelectorAll(".y2k-sparkle").length,
      mine: (popup.querySelector(".y2k-guestbook .gsm-hoshidicts-mine-button") || popup.querySelector(".gsm-hoshidicts-mine-button"))?.dataset.state ?? null,
      audio: (popup.querySelector(".y2k-guestbook .gsm-hoshidicts-audio-button") || popup.querySelector(".gsm-hoshidicts-audio-button"))?.dataset.state ?? null,
      feedback: (() => { const f = popup.querySelector(".gsm-hoshidicts-mining-feedback"); return f && !f.hidden ? f.textContent.trim() : null; })(),
      scrollHeight: popup.querySelector(".gsm-hoshidicts-content-scroll")?.scrollHeight,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  });
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popupState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)}`);
      await new Promise(r => setTimeout(r, 100));
    }
  };
  const settle = (ms = 400) => tab.evaluate(ms => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ms)))), ms);

  async function hover(id, expect) {
    const box = await (await tab.$(`#${id}`)).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
      try { return await waitFor(expect, 1500); } catch (error) { console.error(`[hover attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering #${id}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 700));
  }
  const inPopup = selector => tab.evaluate(selector => {
    const host = document.querySelector("hachidori-host");
    const node = [...host.shadowRoot.querySelectorAll(selector)].find(n => n.getBoundingClientRect().width > 0);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);
  async function clickIn(selector) {
    const point = await inPopup(selector);
    if (!point) throw new Error(`${selector} not visible`);
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
  }
  async function clickKanji(character, expect) {
    const locate = () => tab.evaluate(character => {
      const host = document.querySelector("hachidori-host");
      const links = [...host.shadowRoot.querySelectorAll(".gsm-hoshidicts-kanji-link")];
      const link = links.find(b => b.textContent === character && b.getBoundingClientRect().width > 0);
      if (!link) return { links: links.map(b => `${b.textContent}@${b.getBoundingClientRect().width}`) };
      const rect = link.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, character);
    let point = null;
    for (let attempt = 0; attempt < 50 && !point; attempt += 1) {
      const found = await locate();
      if (found.x !== undefined) point = found;
      else { if (attempt % 10 === 9) console.error(`[kanji link] ${JSON.stringify(found)} popup=${JSON.stringify(await popupState())?.slice(0, 200)}`); await new Promise(r => setTimeout(r, 200)); }
    }
    if (!point) throw new Error(`kanji link ${character} not found`);
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
    return waitFor(expect);
  }
  async function shot(name, { settleMs = 400 } = {}) {
    await settle(settleMs);
    const fresh = await popupState();
    const pad = 24;
    const clip = { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad),
      width: Math.min(1000 - Math.max(0, fresh.rect.x - pad), fresh.rect.width + pad * 2),
      height: Math.min(780 - Math.max(0, fresh.rect.y - pad), fresh.rect.height + pad * 2) };
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip, captureBeyondViewport: false });
    report.shots[name] = fresh;
    console.error(`[shot] ${name} ${JSON.stringify({ rect: fresh.rect, counter: fresh.counterState, reels: fresh.reels })}`);
    return fresh;
  }
  const scrollContent = top => tab.evaluate(top => {
    const scroll = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-content-scroll");
    scroll.scrollTop = top;
  }, top);

  // ---- default theme ----
  await hover("verb", s => s.term > 0);
  await waitFor(s => s.mine !== null && s.mine !== "checking", 4_000).catch(() => {});
  await shot("default-term");
  if (!(await popupState())) await hover("verb", s => s.term > 0);
  await clickKanji("食", s => s.kanji > 0);
  await shot("default-kanji");
  await closePopup();

  // ---- geocities-y2k ----
  await writeOptions({ popupTheme: "geocities-y2k" });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "geocities-y2k", { timeout: 15_000 });
  // First visit of 食べたかった under the theme: the counter is armed, then rolls to the count.
  await hover("verb", s => s.term > 0 && s.y2k);
  report.shots["y2k-term-immediate"] = await popupState();
  await waitFor(s => s.counterState === "counted" && s.mine !== null && s.mine !== "checking", 10_000).catch(() => {});
  await shot("y2k-term", { settleMs: 2200 });
  await scrollContent(10_000);
  await shot("y2k-term-scrolled");
  await scrollContent(0);
  // Sparkle trail: sweep the pointer across the popup, then screenshot within the 700 ms fade.
  const rect = report.shots["y2k-term"].rect;
  for (let step = 0; step <= 10; step += 1) {
    await tab.mouse.move(rect.x + 30 + step * ((rect.width - 60) / 10), rect.y + 120 + Math.sin(step / 1.6) * 40);
    await new Promise(r => setTimeout(r, 25));
  }
  await shot("y2k-sparkles", { settleMs: 0 });
  await new Promise(r => setTimeout(r, 900));
  // Keyboard: Tab into the guestbook and show the dotted focus rectangle.
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".y2k-guestbook .gsm-hoshidicts-audio-button")?.focus());
  await tab.keyboard.press("Tab");
  report.shots["y2k-focus-target"] = await tab.evaluate(() => {
    const active = document.querySelector("hachidori-host").shadowRoot.activeElement;
    return active ? `${active.tagName.toLowerCase()}.${active.className}` : null;
  });
  await shot("y2k-keyboard-focus", { settleMs: 150 });
  // BGM: play the local clip; the button reports playing and the kaomoji dances.
  await clickIn(".y2k-guestbook .gsm-hoshidicts-audio-button");
  const audioTrace = [];
  let playing = null;
  for (let i = 0; i < 160 && !playing; i += 1) {
    const state = await popupState();
    const status = await tab.evaluate(() => {
      const root = document.querySelector("hachidori-host").shadowRoot;
      const button = root.querySelector(".y2k-guestbook .gsm-hoshidicts-audio-button");
      return `${root.querySelector(".gsm-hoshidicts-audio-status")?.textContent ?? ""}|hidden=${button?.hidden}|disabled=${button?.disabled}|busy=${button?.getAttribute("aria-busy")}`;
    });
    if (audioTrace.at(-1) !== `${state?.audio}|${status}`) audioTrace.push(`${state?.audio}|${status}`);
    if (state?.audio === "playing") playing = state;
    else await new Promise(r => setTimeout(r, 50));
  }
  report.audioTrace = audioTrace;
  console.error(`[bgm] trace ${JSON.stringify(audioTrace)}`);
  if (playing) await shot("y2k-bgm-playing", { settleMs: 120 });
  await new Promise(r => setTimeout(r, 3200));
  // Guestbook: 書き込む sends the note through the fake AnkiConnect.
  if (report.shots["y2k-term"].mine === "ready") {
    await clickIn(".y2k-guestbook .gsm-hoshidicts-mine-button");
    await waitFor(s => ["success", "view-existing", "error"].includes(s.mine), 10_000).catch(() => {});
    await shot("y2k-guestbook-written");
  }
  // リンク集: the second dictionary's tab filters the definitions.
  await clickIn(`.y2k-links .gsm-hoshidicts-tab[data-dictionary="${SECOND_TITLE}"]`);
  await waitFor(s => s.links.some(link => link.startsWith(SECOND_TITLE) && link.endsWith("*")), 5_000);
  await shot("y2k-tab-second-dictionary", { settleMs: 2200 });
  // Back to All (the lookup count lives on the All tab), then 今日の漢字.
  await clickIn(".y2k-links .gsm-hoshidicts-tab:not([data-dictionary])");
  await waitFor(s => s.links.some(link => link === "All*"), 5_000);
  await clickKanji("食", s => s.kanji > 0 && s.y2k);
  await shot("y2k-kanji");
  // Back re-renders the term view: the count is already known, so the reels roll at once.
  await clickIn(".y2k-guestbook .gsm-hoshidicts-kanji-back");
  await waitFor(s => s.term > 0 && s.y2k);
  await shot("y2k-back", { settleMs: 250 });
  await closePopup();

  // Second visit: the counter says 2 and the caption changes; no NEW! badge.
  await hover("verb", s => s.term > 0 && s.y2k);
  await waitFor(s => s.counterState === "counted", 6_000).catch(() => {});
  await shot("y2k-term-revisit", { settleMs: 2200 });
  await closePopup();

  // 読む: a different part of speech text, one dictionary card in the second dictionary too.
  await hover("read", s => s.term > 0 && s.y2k);
  await waitFor(s => s.counterState === "counted", 6_000).catch(() => {});
  await shot("y2k-term-yomu", { settleMs: 2200 });
  await closePopup();

  // Reduced motion: the marquee stands still, no sparkles, reels do not roll.
  await tabCdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await hover("verb", s => s.term > 0 && s.y2k);
  await waitFor(s => s.counterState === "counted", 6_000).catch(() => {});
  for (let step = 0; step <= 6; step += 1) {
    await tab.mouse.move(rect.x + 40 + step * 40, rect.y + 140);
    await new Promise(r => setTimeout(r, 25));
  }
  await shot("y2k-reduced-motion", { settleMs: 100 });
  report.shots["y2k-reduced-motion"].marqueeAnimation = await tab.evaluate(() => {
    const track = document.querySelector("hachidori-host").shadowRoot.querySelector(".y2k-marquee-track");
    return { animationName: getComputedStyle(track).animationName, sparkleDisplay: getComputedStyle(document.querySelector("hachidori-host").shadowRoot.querySelector(".y2k-sparkle") || track).display };
  });
  await closePopup();
  await tabCdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] });

  // Narrow popup: the sidebar drops under the main column (container query).
  await writeOptions({ popupWidthPx: 380 });
  await new Promise(r => setTimeout(r, 400));
  await hover("verb", s => s.term > 0 && s.y2k);
  await waitFor(s => s.counterState === "counted", 6_000).catch(() => {});
  await shot("y2k-narrow", { settleMs: 2200 });
  await closePopup();
  await writeOptions({ popupWidthPx: 560 });

  // Contrast measurements: the colours the eye actually meets, from computed styles.
  await hover("verb", s => s.term > 0 && s.y2k);
  await waitFor(s => s.counterState === "counted", 6_000).catch(() => {});
  report.colours = await tab.evaluate(() => {
    const root = document.querySelector("hachidori-host").shadowRoot;
    const pick = (selector, property = "color") => { const n = root.querySelector(selector); return n ? getComputedStyle(n)[property] : null; };
    return {
      gloss: [pick(".gsm-hoshidicts-glossary-content"), pick(".gsm-hoshidicts-glossary-card", "backgroundColor")],
      headword: [pick(".y2k-name .gsm-hoshidicts-expression"), pick(".y2k-name", "backgroundColor")],
      furigana: [pick(".y2k-name rt"), pick(".y2k-name", "backgroundColor")],
      tableHeader: [pick(".y2k-th"), pick(".y2k-th", "backgroundColor")],
      reading: [pick(".y2k-reading"), pick(".y2k-reading", "backgroundColor")],
      marquee: [pick(".y2k-marquee"), "rgb(255, 243, 176)"],
      marqueeWord: [pick(".y2k-marquee-word"), "rgb(255, 243, 176)"],
      kaomoji: [pick(".y2k-kaomoji"), pick(".y2k-hitokoto", "backgroundColor")],
      hitokoto: [pick(".y2k-hitokoto-text"), pick(".y2k-hitokoto", "backgroundColor")],
      counterMood: [pick(".y2k-counter-mood"), pick(".y2k-counter", "backgroundColor")],
      counterLine: [pick(".y2k-counter-line"), pick(".y2k-counter", "backgroundColor")],
      reel: [pick(".y2k-reel"), "rgb(0, 0, 0)"],
      tab: [pick(".y2k-links .gsm-hoshidicts-tab:not([aria-selected='true'])"), "rgb(228, 215, 247)"],
      tabSelected: [pick(".y2k-links .gsm-hoshidicts-tab[aria-selected='true']"), "rgb(106, 0, 80)"],
      guestbookButton: [pick(".y2k-guestbook .gsm-hoshidicts-note-button"), pick(".y2k-guestbook .gsm-hoshidicts-note-button", "backgroundColor")],
      footer: [pick(".y2k-footer"), "rgb(243, 233, 255)"],
      cardTitle: [pick(".gsm-hoshidicts-glossary-card-title"), "rgb(228, 215, 247)"],
      definitionTag: [pick(".gsm-hoshidicts-tag-definition"), pick(".gsm-hoshidicts-tag-definition", "backgroundColor")],
      newBadge: ["rgb(255, 255, 255)", "rgb(200, 16, 46)"],
      construction: ["rgb(0, 0, 0)", "rgb(255, 248, 220)"],
      constructionNote: ["rgb(90, 74, 0)", "rgb(255, 255, 255)"],
      headingStops: ["#c00000", "#9e5000", "#7a6a00", "#007a33", "#0044cc", "#6a00a8"].map(stop => [stop, "rgb(250, 245, 255)"]),
      link: [pick(".y2k-td .gsm-hoshidicts-deinflection > summary"), "rgb(255, 255, 255)"],
    };
  });
  await closePopup();
} finally {
  await browser.close();
  server.close();
  rmSync(WORK, { recursive: true, force: true });
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ chrome: report.chrome, shots: Object.keys(report.shots), hookTimingsMs: report.hookTimingsMs,
  consoleErrors: report.consoleErrors, importState: report.importState }, null, 2));
