// Evidence for issue #334 ("Learner Focus" theme proposal): screenshots of the
// REAL popup (content script + real dictionaries) in the pinned Chrome for
// Testing, default theme vs vendor/themes/learner-focus. Not part of the suite.
//
//   HACHIDORI_ROOT=<worktree with host-prototype.patch applied> \
//   EVIDENCE_OUT=<dir> DICTS=<zip,zip,…> node capture-learner-focus.mjs
//
// Dictionaries used for the proposal (downloaded into a temp dir, never
// committed): Jitendex, Bee's Ultimate Kanji Dictionary, Jiten frequency,
// Kanjium Pitch Accents, KANJIDIC (yomidevs/jmdict-yomitan release).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const DICTS = (process.env.DICTS || "").split(",").filter(Boolean);
const PROFILE = "/tmp/learner-focus-profile";
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

// A reading page in the spirit of a visual-novel text hooker: one paragraph,
// large type. The words the capture hovers are wrapped so they can be found.
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>learner-focus evidence</title>
<style>
  body { margin: 0; min-height: 100vh; background: #efe9dd; color: #2a2620; font: 30px/2.1 "Noto Sans CJK JP", serif; }
  main { padding: 48px 72px 0; }
  p { margin: 0 0 12px; }
  span { display: inline-block; }
  #bottom-line { position: absolute; left: 72px; top: 700px; }
</style></head><body><main>
<p>昨日は<span id="w-library">図書館</span>で朝ごはんを<span id="w-verb">食べたかった</span>けど、閉まっていた。</p>
<p>仕方なくコートを壁に<span id="w-kakeru">掛けて</span>、<span id="w-quiet">静かに</span>本を読んだ。</p>
<p id="bottom-line">帰り道、雨が<span id="w-bottom">降り始めた</span>。</p>
</main></body></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const report = {
  chrome: null,
  extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  dictionaries: DICTS.map(path => path.split("/").pop()),
  shots: {},
};
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE, protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
try {
  report.chrome = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 120_000 });
  const extensionId = new URL(worker.url()).host;

  // ---- import the dictionaries through Settings → Add dictionaries ----
  const settings = await browser.newPage();
  settings.setDefaultTimeout(120_000);
  settings.setDefaultNavigationTimeout(120_000);
  await settings.setViewport({ width: 1200, height: 900 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  await settings.waitForFunction(async () => {
    const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return status.ok && status.ready && !status.loading;
  }, { timeout: 120_000, polling: 300 });
  await new Promise(r => setTimeout(r, 1500));
  const importStarted = Date.now();
  await (await settings.$("#import-file")).uploadFile(...DICTS);
  report.importState = await settings.waitForFunction(count => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith(`Finished ${count} of ${count} archive`) ? text : false;
  }, { timeout: 600_000, polling: 500 }, DICTS.length).then(h => h.jsonValue());
  report.importSeconds = (Date.now() - importStarted) / 1000;
  report.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
  console.error(`[import] ${report.importState} (${report.importSeconds.toFixed(1)} s)`);
  if (!report.importState.includes(`${DICTS.length} imported`)) throw new Error(`import failed: ${report.importState}`);

  let tab = null;
  const writeOptions = async patch => {
    await settings.bringToFront();
    const revision = await settings.evaluate(async patch => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: patch });
      if (!reply.ok) throw new Error(reply.error);
      return reply.options.revision;
    }, patch);
    if (tab) await tab.bringToFront();
    return revision;
  };
  // Hover lookups without an activation key, opaque popup, otherwise defaults.
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100, popupTheme: "default" });

  // ---- the reading page ----
  tab = await browser.newPage();
  tab.setDefaultTimeout(60_000);
  tab.setDefaultNavigationTimeout(120_000);
  tab.on("console", message => { if (message.type() !== "debug") console.error(`[tab console ${message.type()}] ${message.text()}`); });
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  await tab.setViewport({ width: 1100, height: 820, deviceScaleFactor: 2 });
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));

  const popupState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const visible = node => node && !node.hidden && !node.classList.contains("lf-collapsed") && node.getBoundingClientRect().height > 0;
    const parts = [popup.querySelector(":scope > .gsm-hoshidicts-result-chrome"), popup.querySelector(":scope > .gsm-hoshidicts-content-scroll"),
      popup.querySelector(":scope > .gsm-hoshidicts-note-form")].filter(visible).map(rect);
    const card = parts.length ? {
      x: Math.min(...parts.map(p => p.x)), y: Math.min(...parts.map(p => p.y)),
      right: Math.max(...parts.map(p => p.x + p.width)), bottom: Math.max(...parts.map(p => p.y + p.height)) } : null;
    const style = node => node ? getComputedStyle(node) : null;
    const expression = popup.querySelector(".gsm-hoshidicts-primary-header .gsm-hoshidicts-expression");
    return {
      frame: rect(popup),
      card: card ? { x: card.x, y: card.y, width: card.right - card.x, height: card.bottom - card.y } : null,
      theme: host.dataset.hoshidictsTheme,
      toolbar: popup.dataset.toolbarPosition,
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      layer: popup.querySelector(".lf-rail-step[aria-current]")?.textContent ?? (popup.querySelector(".lf-known") ? "known" : null),
      focusGloss: popup.querySelector(".lf-gloss")?.textContent ?? null,
      reading: popup.querySelector(".lf-morae")?.getAttribute("aria-label") ?? null,
      morae: [...popup.querySelectorAll(".lf-reading .lf-mora")].map(m => `${m.textContent}:${m.dataset.level ?? "-"}${m.dataset.transition ? "/" + m.dataset.transition : ""}`),
      accent: popup.querySelector(".lf-accent")?.textContent ?? null,
      pos: [...popup.querySelectorAll(".lf-pos-chip")].map(c => c.textContent),
      lookupCount: popup.querySelector(".gsm-hoshidicts-lookup-stats")?.textContent ?? null,
      session: popup.querySelector(".lf-session")?.textContent ?? null,
      kanjiRows: [...popup.querySelectorAll(".lf-kanji-row")].map(row => [...row.children].map(c => c.textContent).join(" | ")),
      kanjiStats: [...popup.querySelectorAll(".lf-stat")].map(c => c.textContent),
      crumb: popup.querySelector(".lf-crumb")?.textContent ?? null,
      chromeCollapsed: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.classList.contains("lf-collapsed") ?? null,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      background: style(popup).backgroundColor,
      cardBackground: style(popup.querySelector(":scope > .gsm-hoshidicts-content-scroll")).backgroundColor,
      headwordSize: expression ? style(expression).fontSize : null,
      glossSize: style(popup.querySelector(".lf-gloss") || popup.querySelector(".gsm-hoshidicts-glossary-content") || popup).fontSize,
      blurState: popup.dataset.definitionBlurState ?? null,
      activeInPopup: host.shadowRoot.activeElement ? `${host.shadowRoot.activeElement.tagName}.${host.shadowRoot.activeElement.className}` : null,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  });
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await popupState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)}`);
      await new Promise(r => setTimeout(r, 150));
    }
  };
  const settle = (ms = 420) => tab.evaluate(ms => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ms)))), ms);

  async function hover(id, expect) {
    lastHovered = id;
    const box = await (await tab.$(`#${id}`)).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.12, box.y + box.height / 2);
      try { return await waitFor(expect, 3000); } catch (error) { console.error(`[hover ${id} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering #${id}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 700));
  }
  // Click an element inside the popup by selector (+ optional text), with the real mouse.
  let lastHovered = null;
  async function clickIn(selector, textMatch = null) {
    const find = () => tab.evaluate((selector, textMatch) => {
      const host = document.querySelector("hachidori-host");
      const nodes = [...(host?.shadowRoot?.querySelectorAll(selector) ?? [])];
      const node = textMatch
        ? nodes.find(n => n.textContent.includes(textMatch) || (n.getAttribute("aria-label") || "").includes(textMatch))
        : nodes[0];
      if (!node) return { found: false, count: nodes.length };
      const rect = node.getBoundingClientRect();
      return rect.width > 0 ? { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : { found: false, zero: true };
    }, selector, textMatch);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const point = await find();
      if (point.found) {
        await tab.mouse.move(point.x, point.y);
        await tab.mouse.click(point.x, point.y);
        return;
      }
      if (attempt === 10 && lastHovered) {
        console.error(`[clickIn ${selector} ${textMatch ?? ""}] not visible (${JSON.stringify(point)}), state ${JSON.stringify(await popupState())?.slice(0, 200)}; re-hovering #${lastHovered}`);
        const box = await (await tab.$(`#${lastHovered}`)).boundingBox();
        await tab.mouse.move(box.x + box.width * 0.12, box.y + box.height / 2);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`clickIn: ${selector} ${textMatch ?? ""} never became clickable`);
  }
  async function shot(name, { anchor = null, extra = {}, pad = 24, wait = 420 } = {}) {
    await settle(wait);
    const state = await popupState();
    const card = state.card ?? state.frame;
    let x = card.x, y = card.y, right = card.x + card.width, bottom = card.y + card.height;
    if (anchor) {
      const a = await (await tab.$(`#${anchor}`)).boundingBox();
      x = Math.min(x, a.x); y = Math.min(y, a.y); right = Math.max(right, a.x + a.width); bottom = Math.max(bottom, a.y + a.height);
    }
    const clip = { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: Math.min(1100, right - x + pad * 2), height: Math.min(820, bottom - y + pad * 2) };
    // captureBeyondViewport resizes the viewport, which the reader treats as a window change; keep the viewport as is.
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip, captureBeyondViewport: false });
    report.shots[name] = { ...state, ...extra, clip };
    writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2)); // incremental: a crash leaves a consistent report
    console.error(`[shot ${new Date().toISOString().slice(11, 19)}] ${name} card ${card.width}×${card.height} layer=${state.layer}`);
    return state;
  }

  // ================= default theme (baseline for the side-by-side) =================
  await hover("w-verb", s => s.term > 0);
  await shot("default-term", { anchor: "w-verb" });
  await clickIn(".gsm-hoshidicts-kanji-link", "食");
  await waitFor(s => s.kanji > 0);
  await shot("default-kanji");
  await closePopup();

  // ================= learner-focus =================
  await writeOptions({ popupTheme: "learner-focus" });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "learner-focus", { timeout: 15_000 });

  // Definition blur (Settings → Reading): the theme's copies blur with the definitions.
  await writeOptions({ definitionBlurEnabled: true, definitionBlurThreshold: 1, definitionBlurDelayMs: 60_000, definitionBlurReveal: "timed" });
  await new Promise(r => setTimeout(r, 500));
  await hover("w-quiet", s => s.term > 0 && s.layer === "Focus" && s.blurState !== null);
  await shot("lf-blur", { anchor: "w-quiet", wait: 700 });
  await closePopup();
  await writeOptions({ definitionBlurEnabled: false });
  await new Promise(r => setTimeout(r, 500));

  // Layer 0: focus. The hook runs again as the reader appends the shorter matches.
  await hover("w-verb", s => s.term > 0 && s.layer === "Focus");
  await shot("lf-0-focus", { anchor: "w-verb", wait: 700 });

  // Layers 1–4 by clicking the "2 …" button (the click moves focus into the popup).
  await clickIn(".lf-btn-more");
  await shot("lf-1-senses", { anchor: "w-verb" });
  await clickIn(".lf-btn-more");
  await shot("lf-2-details", { anchor: "w-verb" });
  await clickIn(".lf-btn-more");
  await shot("lf-3-dictionaries", { anchor: "w-verb" });
  await clickIn(".lf-btn-more");
  await shot("lf-4-kanji", { anchor: "w-verb" });
  // Kanji view from the kanji table row, then Back keeps the layer.
  await clickIn(".lf-rail-step", "Kanji");
  await settle(300);
  await clickIn(".lf-kanji-row");
  await waitFor(s => s.kanji > 0);
  await shot("lf-kanji-view");
  await clickIn(".gsm-hoshidicts-kanji-back");
  const afterBack = await waitFor(s => s.term > 0 && s.layer === "Kanji");
  report.shots["lf-back-keeps-layer"] = { layer: afterBack.layer, kanjiRows: afterBack.kanjiRows };

  // Keyboard: focus is inside the popup after the clicks; 0 = focus, 2 = next, 1 = knew it.
  await tab.keyboard.press("0");
  await waitFor(s => s.layer === "Focus");
  await tab.keyboard.press("2");
  const viaKey = await waitFor(s => s.layer === "Senses");
  report.shots["lf-keys"] = { after0: "Focus", after2: viaKey.layer, activeInPopup: viaKey.activeInPopup };
  await tab.keyboard.press("1");
  await shot("lf-known-just-marked", { anchor: "w-verb" });
  await closePopup();

  // Memory within the page: hovering the same word again renders the known line at once.
  await hover("w-verb", s => s.term > 0 && s.layer === "known");
  await shot("lf-known-again", { anchor: "w-verb" });
  await closePopup();

  // A long entry: 掛ける has dozens of senses; layer 1 keeps the footer in view.
  await hover("w-kakeru", s => s.term > 0 && s.layer === "Focus");
  await shot("lf-long-0-focus", { anchor: "w-kakeru", wait: 700 });
  await clickIn(".lf-btn-more");
  await shot("lf-long-1-senses", { anchor: "w-kakeru" });
  report.shots["lf-long-1-senses"].senseCount = await tab.evaluate(() =>
    document.querySelector("hachidori-host").shadowRoot.querySelectorAll('.gsm-hoshidicts-entry:first-of-type [data-sc-content="sense"]').length);
  await clickIn(".lf-btn-more");
  await shot("lf-long-2-details", { anchor: "w-kakeru" });
  await closePopup();

  // Three kanji: the table shows what the results already contain (図) and
  // where a kanji lookup API would fill the rest (書, 館).
  await hover("w-library", s => s.term > 0 && s.layer === "Focus");
  await shot("lf-library-0-focus", { anchor: "w-library", wait: 700 });
  await clickIn(".lf-rail-step", "Kanji");
  await shot("lf-library-4-kanji", { anchor: "w-library" });
  await closePopup();

  // Placed above the word (toolbar bottom): the card hugs the word from above.
  await hover("w-bottom", s => s.term > 0 && s.layer === "Focus");
  await shot("lf-above-word", { anchor: "w-bottom", wait: 700 });
  await closePopup();

  // Session counter after several words.
  await hover("w-quiet", s => s.term > 0 && s.layer === "Focus");
  await shot("lf-session-counter", { anchor: "w-quiet", wait: 700 });
  await closePopup();

} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ chrome: report.chrome, shots: Object.keys(report.shots) }, null, 2));
