// Parity audit probe for #644: the same lookups in a web page popup and in the
// search page's docked result, with identical options. Not part of the repo.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.argv[2];
const OUT = process.argv[3] ?? "/tmp/hachi644/audit";
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const EXTENSION = process.env.PROBE_EXTENSION ?? join(REPO, "extension");
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>reading</title></head>
<body style="font-size:24px;padding:40px"><p id="verb">食べたかった</p><p id="kanji">漢字</p><p id="read">読む</p></body></html>`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644a-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const results = {};
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  // Allow User Scripts, as a user does on chrome://extensions.
  const ext = await browser.newPage();
  await ext.goto(`chrome://extensions/?id=${id}`);
  await ext.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }), id);
  await ext.close();
  await sleep(2000);
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  for (const p of await browser.pages()) if (p.url().includes("startup.html")) await p.close();
  const fixture = readFileSync(join(REPO, "test/fixtures/hachidori-fixture.zip")).toString("base64");
  const imported = await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `audit-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(e => ({ ok: false, error: String(e) }));
      if (reply?.ok) return reply;
      await new Promise(r => setTimeout(r, 1000));
      if (attempt === 19) return reply;
    }
  }, fixture);
  log("import:", JSON.stringify(imported).slice(0, 200));
  const writeOptions = patch => settings.evaluate(async patch => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: patch });
      if (reply.ok) return reply;
    }
    throw new Error("options write failed");
  }, patch);
  const script = "document.documentElement.dataset.hdUserScript = 'ran'; setInterval(() => { const root = document.querySelector('hachidori-host')?.shadowRoot; const p = root?.querySelector('.gsm-hoshidicts-popup'); if (p) p.dataset.hdUserScript = 'seen'; }, 50);";
  await writeOptions({ hoverEnabled: true, lookupMode: "hover", customPopupJavascript: script,
    customPopupCss: ".gsm-hoshidicts-popup { outline: 3px solid rgb(255, 0, 0); }" });
  await sleep(500);
  log("registered user scripts:", JSON.stringify(await (await (browser.targets().filter(t => t.type() === "service_worker" && t.url().includes(id)).at(-1)).worker()).evaluate(() => chrome.userScripts.getScripts())).slice(0, 200));

  // Popup facts, from the open shadow root (Custom JavaScript opens it).
  const facts = target => target.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const root = host?.shadowRoot;
    const popup = root?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return { open: false, mode: root?.mode ?? null };
    const style = getComputedStyle(popup);
    const norm = popup.innerHTML.replace(/\s(id|for|aria-controls|aria-labelledby|aria-describedby|aria-owns|aria-activedescendant)="[^"]*"/g, "")
      .replace(/hoshidicts-\d+/g, "hoshidicts-N");
    return {
      open: true, mode: root.mode, theme: host.dataset.hoshidictsTheme, renderer: host.dataset.hoshidictsRenderer,
      hostStyle: host.getAttribute("style"), popupStyleAttr: popup.getAttribute("style"),
      computed: { outline: style.outlineColor + " " + style.outlineWidth, opacity: style.opacity, zoom: style.zoom,
        fontSize: style.fontSize, width: style.width, height: style.height, transform: style.transform },
      dataset: { ...popup.dataset }, toolbar: popup.dataset.toolbarPosition ?? null,
      userScriptPage: document.documentElement.dataset.hdUserScript ?? null,
      counts: Object.fromEntries([
        ["audio", ".gsm-hoshidicts-audio-button"], ["anki", ".gsm-hoshidicts-anki-button, [class*=anki]"],
        ["note", ".gsm-hoshidicts-note-button"], ["pitch", ".pronunciation, [class*=pitch]"], ["ruby", "ruby"],
        ["freq", "[class*=frequency]"], ["cards", ".gsm-hoshidicts-glossary-card"], ["tabs", "[role=tab]"],
        ["kanjiLinks", "[data-hoshidicts-kanji], .gsm-hoshidicts-kanji-link, a[data-kanji]"], ["resize", ".gsm-hoshidicts-resize-handle"],
        ["count", "[class*=lookup-count], [class*=lookup-stat]"], ["ipa", "[class*=ipa]"], ["close", ".gsm-hoshidicts-popup-close"],
      ].map(([k, s]) => [k, popup.querySelectorAll(s).length])),
      highlights: typeof CSS !== "undefined" && CSS.highlights ? [...CSS.highlights.keys()].map(k => [k, CSS.highlights.get(k).size]) : null,
      html: norm,
    };
  });

  const web = await browser.newPage();
  await web.setViewport({ width: 960, height: 760 });
  await web.goto(pageUrl, { waitUntil: "load" });
  await sleep(800);
  const openWeb = async (selector = "#verb") => {
    await web.bringToFront();
    await web.mouse.move(5, 5);
    await sleep(150);
    const point = await web.evaluate(sel => {
      const node = document.querySelector(sel).firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, selector);
    await web.mouse.move(point.x - 2, point.y);
    await web.mouse.move(point.x, point.y, { steps: 3 });
    for (let i = 0; i < 100; i += 1) { const f = await facts(web); if (f.open && f.html.length > 200) return f; await sleep(100); }
    return facts(web);
  };

  const searchTab = await browser.newPage();
  await searchTab.setViewport({ width: 960, height: 760 });
  const pageErrors = [];
  searchTab.on("pageerror", e => pageErrors.push(e.message));
  searchTab.on("console", m => { if (m.type() === "error" || m.type() === "warn") pageErrors.push(`${m.type()}: ${m.text()}`); });
  await searchTab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await sleep(500);
  const frameOf = () => searchTab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? searchTab.mainFrame();
  const search = new Proxy({}, { get: (_, key) => {
    if (["screenshot", "bringToFront", "keyboard", "mouse", "url"].includes(key)) return typeof searchTab[key] === "function" ? searchTab[key].bind(searchTab) : searchTab[key];
    const frame = frameOf();
    return typeof frame[key] === "function" ? frame[key].bind(frame) : frame[key];
  } });
  log("search frame:", frameOf().url());
  await search.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  const openSearch = async (text = "食べたかった") => {
    await search.bringToFront();
    await search.focus("#search-input");
    await search.$eval("#search-input", (box, value) => { box.value = value; }, text);
    await search.keyboard.press("Enter");
    for (let i = 0; i < 100; i += 1) { const f = await facts(search); if (f.open && f.html.length > 200) return f; await sleep(100); }
    return facts(search);
  };

  const scenarios = [
    ["defaults", {}],
    ["scale150-opacity70", { popupScalePercent: 150, popupOpacityPercent: 70 }],
    ["toolbar-bottom", { popupToolbarPosition: "bottom" }],
    ["columns2", { popupColumns: 2 }],
    ["theme-dracula", { popupTheme: "dracula" }],
    ["theme-jl", { popupTheme: "jl" }],
    ["theme-nazeka", { popupTheme: "nazeka" }],
    ["theme-plain", { popupTheme: "plain" }],
    ["theme-bee", { popupTheme: "bee" }],
    ["theme-crystal-blue", { popupTheme: "crystal", popupThemeVariant: "blue" }],
    ["glossary-compact", { glossaryLayoutMode: "compact", showCompactDefinitionSummary: true, compactDefinitionSummaryCount: 2, hidePopupGrammarTags: true }],
    ["pitch-overline-graph", { pitchAccentFuriganaStyle: "overline", showPitchAccentGraph: true, showPitchAccentColors: true, showPitchAccentBadge: false, showPitchAccentDictionaryNames: false, showPitchAccentText: false }],
    ["frequency-average", { averageFrequency: true, showFrequencyTagsWithAverage: true, showFrequencyDictionaryNames: true, compactFrequencyNumbers: true }],
    ["no-audio-no-counts", { showPopupAudioButton: false, showLookupCounts: false }],
    ["custom-buttons", { customButtons: [{ id: "b1", type: "link", label: "Jisho", url: "https://jisho.org/search/%s" }] }],
  ];
  for (const [name, patch] of scenarios) {
    await writeOptions({ popupScalePercent: 100, popupOpacityPercent: 100, popupToolbarPosition: "top", popupColumns: 1, popupTheme: "default", popupThemeVariant: "auto", glossaryLayoutMode: "default", showCompactDefinitionSummary: false, hidePopupGrammarTags: false, pitchAccentFuriganaStyle: "contour", showPitchAccentGraph: false, showPitchAccentColors: false, showPitchAccentBadge: true, showPitchAccentDictionaryNames: true, showPitchAccentText: true, averageFrequency: false, showFrequencyTagsWithAverage: false, showFrequencyDictionaryNames: false, compactFrequencyNumbers: false, showPopupAudioButton: true, showLookupCounts: true, customButtons: [], ...patch });
    await sleep(700);
    await web.bringToFront();
    await web.mouse.move(5, 5);
    await web.keyboard.press("Escape");
    await sleep(200);
    const w = await openWeb();
    const s = await openSearch();
    const same = w.html === s.html;
    results[name] = { same, web: { ...w, html: w.html?.length }, search: { ...s, html: s.html?.length } };
    writeFileSync(join(OUT, `${name}-web.html`), w.html ?? "");
    writeFileSync(join(OUT, `${name}-search.html`), s.html ?? "");
    await web.screenshot({ path: join(OUT, `${name}-web.png`) });
    await search.screenshot({ path: join(OUT, `${name}-search.png`) });
    log(`== ${name}: html same=${same} web=${w.html?.length} search=${s.html?.length}`);
    for (const key of ["mode", "theme", "renderer", "toolbar", "userScriptPage"]) if (w[key] !== s[key]) log(`   ${key}: web=${w[key]} search=${s[key]}`);
    for (const key of Object.keys(w.computed ?? {})) if (w.computed[key] !== s.computed?.[key]) log(`   computed.${key}: web=${w.computed[key]} search=${s.computed?.[key]}`);
    for (const key of Object.keys(w.counts ?? {})) if (w.counts[key] !== s.counts?.[key]) log(`   count.${key}: web=${w.counts[key]} search=${s.counts?.[key]}`);
    const dk = new Set([...Object.keys(w.dataset ?? {}), ...Object.keys(s.dataset ?? {})]);
    for (const key of dk) if (w.dataset?.[key] !== s.dataset?.[key]) log(`   dataset.${key}: web=${w.dataset?.[key]} search=${s.dataset?.[key]}`);
    log(`   web user script: page=${w.userScriptPage} popup=${w.dataset?.hdUserScript}; search: page=${s.userScriptPage} popup=${s.dataset?.hdUserScript}`);
  }
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
  log("search page errors:", JSON.stringify(pageErrors.slice(0, 10)));

  // Browser shortcuts: the worker sends reader commands with tabs.sendMessage.
  await writeOptions({ popupScalePercent: 100, popupOpacityPercent: 100, popupTheme: "default", popupColumns: 1, popupToolbarPosition: "top" });
  await sleep(500);
  const tabIdOf = async url => settings.evaluate(async url => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
    if (contexts[0]) return contexts[0].tabId;
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, url);
  const command = (tabId, action) => settings.evaluate(async (tabId, action) => {
    try {
      await chrome.tabs.sendMessage(tabId, { target: "hachidori-reader", type: "hd_reader_command", action });
      return "delivered";
    } catch (error) { return `ERROR ${error.message}`; }
  }, tabId, action);
  await web.bringToFront();
  const w1 = await openWeb();
  const webTab = await tabIdOf(pageUrl);
  log("web reader command close:", await command(webTab, "close"));
  await sleep(400);
  log("web popup open after close command:", (await facts(web)).open);
  const s1 = await openSearch();
  const searchTabId = await tabIdOf(`chrome-extension://${id}/search.html`);
  log("search reader command nextEntry:", await command(searchTabId, "nextEntry"), "tab", searchTabId, "open before", s1.open);
} finally {
  await browser.close();
  server.close();
}
