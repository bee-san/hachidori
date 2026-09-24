// Evidence for issue #334 ("RPG Dialogue" theme proposal): screenshots of the REAL
// popup (content script + imported dictionaries) in the pinned Chrome for Testing,
// default theme vs vendor/themes/rpg-dialogue (theme.css + theme.js). Not part of
// the test suite. Needs the worktree-only theme host from
// docs/evidence/issue-330/theme-store/nazeka-js/host-prototype.patch.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> \
//   HACHIDORI_DICTS=/tmp/hachidori-dicts node capture-rpg-dialogue.mjs
//
// HACHIDORI_DICTS may hold jitendex-yomitan.zip, KANJIDIC_english.zip and
// kanjium_pitch_accents.zip (downloaded, never committed); the fixture is always imported.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));

const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const DICTS = process.env.HACHIDORI_DICTS || "";
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const ARCHIVES = [resolve(ROOT, "test/fixtures/hachidori-fixture.zip"),
  ...["jitendex-yomitan.zip", "KANJIDIC_english.zip", "kanjium_pitch_accents.zip"]
    .map(name => resolve(DICTS, name)).filter(path => DICTS && existsSync(path))];
const PROFILE = resolve(OUT, "profile");
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

// A visual-novel-like reading page: dark stage, white 30 px text.
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>rpg-dialogue evidence</title>
<style>
  html,body{margin:0;min-height:100%}
  body{font:30px/2.1 "Noto Sans CJK JP",sans-serif;padding:48px 72px;color:#f2f2f2;
    background:radial-gradient(ellipse at 30% 10%,#3b2a5a 0%,#151228 45%,#080812 100%)}
  p{margin:0 0 .4em} span{display:inline-block}
</style></head><body>
<p>「朝ごはんを<span id="verb">食べたかった</span>んだけど、寝坊した。」</p>
<p>「じゃあ、みんなで声を<span id="long">上げる</span>しかないね。」</p>
</body></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE_HTML);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const report = { chrome: null, extensionVersion: JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version,
  archives: ARCHIVES.map(path => path.split("/").pop()), shots: {}, hookTimings: null };
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
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
  const started = Date.now();
  await (await settings.$("#import-file")).uploadFile(...ARCHIVES);
  report.importState = await settings.waitForFunction(count => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith(`Finished ${count} of ${count} archive`) ? text : false;
  }, { timeout: 600_000, polling: 500 }, ARCHIVES.length).then(h => h.jsonValue());
  report.importSeconds = (Date.now() - started) / 1000;
  report.importDetail = await settings.evaluate(() => [...document.querySelectorAll("#import-progress .setup-dictionary")]
    .map(row => `${row.querySelector(".setup-dictionary-name")?.textContent} :: ${row.querySelector(".setup-dictionary-status")?.textContent}`));
  console.error(`[import] ${report.importState} (${report.importSeconds.toFixed(1)} s)`);
  if (!report.importState.includes(`${ARCHIVES.length} imported`)) throw new Error(`import failed: ${report.importState}`);

  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
    return reply.options.revision;
  }, patch);
  // Plain hover opens the popup; the reader's own count of lookups is on so the
  // theme's status strip can show it.
  await writeOptions({ lookupMode: "hover", popupOpacityPercent: 100, showLookupCounts: true });

  // ---- the reading page ----
  const tab = await browser.newPage();
  tab.on("console", message => { if (!/^hachidori theme/.test(message.text())) console.error(`[tab console ${message.type()}] ${message.text()}`); });
  tab.on("pageerror", error => console.error(`[tab pageerror] ${error.message}`));
  await tab.setViewport({ width: 1000, height: 760, deviceScaleFactor: 2 });
  const cdp = await tab.createCDPSession();
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
  await cdp.send("Runtime.enable");
  await tab.goto(PAGE_URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));

  // Read the theme host's onRender timing tap from the content script's isolated world.
  async function hookTimings() {
    for (const context of contexts) {
      const value = await cdp.send("Runtime.evaluate", { contextId: context.id, returnByValue: true,
        expression: "typeof __hdThemeHook === 'undefined' ? null : JSON.stringify(__hdThemeHook)" }).catch(() => null);
      if (value?.result?.value) return JSON.parse(value.result.value);
    }
    return null;
  }

  const shadowState = () => tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    const rect = popup.getBoundingClientRect();
    const css = node => (node ? getComputedStyle(node) : null);
    const window_ = popup.querySelector(".gsm-hoshidicts-content-scroll");
    const current = popup.querySelector("li[data-rpg-current], .gsm-hoshidicts-kanji-entry[data-rpg-current]");
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      term: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      kanji: popup.querySelectorAll(".gsm-hoshidicts-kanji-entry").length,
      rpg: !!popup.querySelector(".rpg-plate"),
      chromeHidden: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      theme: host.dataset.hoshidictsTheme,
      sheets: host.shadowRoot.adoptedStyleSheets.length,
      popupBackground: css(popup).backgroundColor,
      windowBackground: css(window_)?.backgroundImage.slice(0, 60),
      textColor: css(popup.querySelector(".gsm-hoshidicts-glossary-content") || popup).color,
      textSize: css(popup.querySelector(".gsm-hoshidicts-glossary-content") || popup).fontSize,
      name: popup.querySelector(".rpg-name")?.textContent ?? null,
      nameColor: css(popup.querySelector(".rpg-name"))?.color ?? null,
      reading: popup.querySelector(".rpg-reading")?.textContent ?? null,
      pitch: popup.querySelector(".rpg-pitch")?.getAttribute("aria-label") ?? null,
      counter: popup.querySelector(".rpg-counter")?.getAttribute("aria-label") ?? null,
      footerState: popup.querySelector(".rpg-footer")?.dataset.rpgState ?? null,
      location: popup.querySelector(".rpg-location")?.textContent ?? null,
      typedChars: popup.querySelectorAll("[data-rpg-current] .rpg-ch").length,
      visibleChars: [...popup.querySelectorAll("[data-rpg-current] .rpg-ch")].filter(span => getComputedStyle(span).visibility === "visible").length,
      commands: [...popup.querySelectorAll(".rpg-cmd:not([hidden])")].map(button =>
        `${button.textContent}${button.getAttribute("aria-disabled") === "true" ? " (disabled)" : ""}`),
      focused: host.shadowRoot.activeElement?.className ?? null,
      focusedText: host.shadowRoot.activeElement?.textContent?.slice(0, 20) ?? null,
      pageText: current?.textContent.replace(/\s+/g, " ").trim().slice(0, 200) ?? null,
      stats: [...popup.querySelectorAll(".rpg-stat")].map(row => row.getAttribute("aria-label")),
      lookups: popup.querySelector(".gsm-hoshidicts-lookup-stats")?.textContent ?? null,
      textSample: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  });
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await shadowState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) throw new Error(`popup state never satisfied: ${JSON.stringify(state)}`);
      await new Promise(r => setTimeout(r, 120));
    }
  };
  const settle = (ms = 350) => tab.evaluate(ms => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ms)))), ms);

  async function hover(id, expect) {
    const box = await (await tab.$(`#${id}`)).boundingBox();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await tab.mouse.move(2, 2);
      await new Promise(r => setTimeout(r, 150));
      await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
      try { return await waitFor(expect, 2000); } catch (error) { console.error(`[hover ${id} attempt ${attempt}] ${error.message.slice(0, 300)}`); }
    }
    throw new Error(`no popup after hovering #${id}`);
  }
  async function closePopup() {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 700));
  }
  const pointOf = selector => tab.evaluate(selector => {
    const host = document.querySelector("hachidori-host");
    const node = host.shadowRoot.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, selector);
  async function clickIn(selector) {
    const point = await pointOf(selector);
    if (!point) throw new Error(`nothing to click for ${selector}`);
    await tab.mouse.move(point.x, point.y);
    await tab.mouse.click(point.x, point.y);
  }
  // The ▼ blinks (CSS animation); hold every blink at its visible phase while
  // the picture is taken so the evidence is deterministic, then let it run.
  const holdBlink = hold => tab.evaluate(hold => {
    const host = document.querySelector("hachidori-host");
    for (const animation of host?.shadowRoot?.getAnimations?.() ?? []) {
      if (animation.animationName !== "rpg-blink") continue;
      if (hold) { animation.currentTime = 100; animation.pause(); } else animation.play();
    }
  }, hold);
  async function shot(name, { pad = 28, extra = 0 } = {}) {
    await settle();
    await holdBlink(true);
    const fresh = await shadowState();
    const clip = { x: Math.max(0, fresh.rect.x - pad), y: Math.max(0, fresh.rect.y - pad - extra),
      width: Math.min(1000 - Math.max(0, fresh.rect.x - pad), fresh.rect.width + pad * 2),
      height: Math.min(760 - Math.max(0, fresh.rect.y - pad - extra), fresh.rect.height + pad * 2 + extra) };
    // captureBeyondViewport would override the device metrics and the hover popup would hide.
    await tab.screenshot({ path: resolve(OUT, `${name}.png`), clip, captureBeyondViewport: false });
    await holdBlink(false);
    report.shots[name] = fresh;
    console.error(`[shot] ${name} ${fresh.rect.width}x${Math.round(fresh.rect.height)} counter=${fresh.counter} footer=${fresh.footerState}`);
    return fresh;
  }

  // ---- default theme (a fresh install is AUTO → light in headless Chrome) ----
  await hover("verb", s => s.term > 0);
  await shot("default-term");
  await clickIn(".gsm-hoshidicts-kanji-link");
  await waitFor(s => s.kanji > 0);
  await shot("default-kanji");
  await closePopup();
  await hover("long", s => s.term > 0);
  await shot("default-long");
  await closePopup();

  // ---- RPG Dialogue ----
  await writeOptions({ popupTheme: "rpg-dialogue" });
  await tab.waitForFunction(() => document.querySelector("hachidori-host")?.dataset.hoshidictsTheme === "rpg-dialogue", { timeout: 15_000 });
  await new Promise(r => setTimeout(r, 800)); // theme.js import + CSS adoption

  // 1. the term window right after the hover: page 1 typed out, ▼ blinking
  await hover("verb", s => s.term > 0 && s.rpg);
  await waitFor(s => s.footerState === "ready" || s.footerState === "end", 8000);
  await shot("rpg-term");

  // 2. Space advances to the next sense (the tap focuses the ▼ button first)
  await clickIn(".rpg-status"); // a tap anywhere on the window (here the status strip) advances
  await waitFor(s => (s.counter || "").startsWith("Page 2"), 5000);
  await waitFor(s => s.footerState !== "typing", 8000);
  await shot("rpg-term-page2");
  // Keyboard path: focus ▼ (what Tab does) and press Space
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".rpg-next").focus());
  await tab.keyboard.press("Space");
  await waitFor(s => (s.counter || "").startsWith("Page 3"), 5000);
  await waitFor(s => s.footerState !== "typing", 8000);
  await shot("rpg-term-page3");

  // 3. hovering a word inside the typed text opens a nested lookup: a second,
  //    smaller message window (depth 1) in the same theme
  const nestedPoint = await tab.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host.shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const span = [...popup.querySelectorAll("li[data-rpg-current] .rpg-ch")].find(node => node.textContent === "果");
    if (!span) return null;
    const rect = span.getBoundingClientRect();
    return rect.width > 0 ? { x: rect.x + rect.width * 0.3, y: rect.y + rect.height / 2 } : null;
  });
  if (nestedPoint) {
    // The reader pauses hover lookups while the popup holds keyboard focus (so
    // a keyboard user is not interrupted); the Space press above left ▼
    // focused. A mouse user's next click on the page text drops that focus.
    await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.activeElement?.blur());
    await tab.mouse.move(nestedPoint.x - 40, nestedPoint.y - 30);
    await new Promise(r => setTimeout(r, 200));
    await tab.mouse.move(nestedPoint.x, nestedPoint.y, { steps: 6 });
    await new Promise(r => setTimeout(r, 200));
    await tab.mouse.move(nestedPoint.x + 1, nestedPoint.y);
    const child = await tab.waitForFunction(() => {
      const host = document.querySelector("hachidori-host");
      const popup = host.shadowRoot.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="1"]');
      if (!popup || popup.hidden || !popup.querySelector(".rpg-plate")) return false;
      const footer = popup.querySelector(".rpg-footer");
      if (footer?.dataset.rpgState === "typing") return false;
      const rect = popup.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, name: popup.querySelector(".rpg-name")?.textContent };
    }, { timeout: 15_000, polling: 150 }).then(handle => handle.jsonValue());
    report.shots["rpg-nested"] = { child, parent: await shadowState() };
    await settle();
    await holdBlink(true);
    const parentRect = report.shots["rpg-nested"].parent.rect;
    const left = Math.max(0, Math.min(parentRect.x, child.x) - 28);
    const top = Math.max(0, Math.min(parentRect.y, child.y) - 28);
    const right = Math.min(1000, Math.max(parentRect.x + parentRect.width, child.x + child.width) + 28);
    const bottom = Math.min(760, Math.max(parentRect.y + parentRect.height, child.y + child.height) + 28);
    await tab.screenshot({ path: resolve(OUT, "rpg-nested.png"), captureBeyondViewport: false,
      clip: { x: left, y: top, width: right - left, height: bottom - top } });
    await holdBlink(false);
    console.error(`[shot] rpg-nested child ${child.name} ${child.width}x${Math.round(child.height)}`);
    // leave the child: back to the parent's text, then Escape closes the child only
    await tab.keyboard.press("Escape");
    await new Promise(r => setTimeout(r, 500));
  }
  await tab.evaluate(() => document.querySelector("hachidori-host").shadowRoot.querySelector(".rpg-next").focus());
  await waitFor(s => s.term > 0 && s.rpg && s.focused === "rpg-next", 5000);

  // 4. ↓ moves to the command window: the ▶ hand lands on the first command
  await tab.keyboard.press("ArrowDown");
  await waitFor(s => s.focused === "rpg-cmd", 3000);
  await tab.keyboard.press("ArrowDown");
  await shot("rpg-menu");
  report.shots["rpg-menu"].hookTimingsSoFar = (await hookTimings())?.length ?? null;

  // 5. the kanji view: an item window; the plate's 食 forwards to the reader's kanji button
  await clickIn('.rpg-kanji');
  await waitFor(s => s.kanji > 0 && s.rpg, 10_000);
  await waitFor(s => s.footerState !== "typing", 8000);
  await shot("rpg-kanji");
  if ((report.shots["rpg-kanji"].counter || "").includes("of 2")) {
    await tab.keyboard.press("ArrowUp"); // from もどる up to the ▼ button
    await tab.keyboard.press("Space");
    await waitFor(s => (s.counter || "").startsWith("Page 2"), 5000);
    await waitFor(s => s.footerState !== "typing", 8000);
    await shot("rpg-kanji-page2");
  }
  // もどる → Back re-renders the term view and the hook runs again
  await clickIn('.rpg-cmd[data-cmd="back"]');
  report.shots["rpg-back"] = await waitFor(s => s.term > 0 && s.rpg, 10_000);
  await closePopup();

  // 6. a long multi-sense entry: sample the typewriter's pace, then a tap skips
  //    the rest of the typing (the RPG convention) and the counter shows how many pages there are
  await hover("long", s => s.term > 0 && s.rpg);
  const pace = [];
  const t0 = Date.now();
  for (let i = 0; i < 6; i += 1) {
    await new Promise(r => setTimeout(r, 250));
    const s = await shadowState();
    pace.push({ ms: Date.now() - t0, visible: s.visibleChars, total: s.typedChars, state: s.footerState });
  }
  report.typingPace = pace;
  await clickIn(".rpg-status"); // a tap anywhere on the window (here the status strip) advances
  await waitFor(s => s.footerState !== "typing", 8000);
  await new Promise(r => setTimeout(r, 900)); // progressive entries arrive → counter settles
  await shot("rpg-long");
  await closePopup();

  // 7. mid-typewriter frame: the user's Custom CSS layer slows the tick to 140 ms
  await writeOptions({ customPopupCss: ':host([data-hoshidicts-theme="rpg-dialogue"]) .gsm-hoshidicts-popup { --theme-rpg-tick: 140ms; }' });
  await new Promise(r => setTimeout(r, 600));
  await hover("long", s => s.term > 0 && s.rpg && s.footerState === "typing");
  await new Promise(r => setTimeout(r, 1500));
  await shot("rpg-typing");
  await closePopup();
  await writeOptions({ customPopupCss: "" });

  // 8. reduced motion: text is complete at once, nothing blinks
  await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await new Promise(r => setTimeout(r, 300));
  await hover("verb", s => s.term > 0 && s.rpg);
  await shot("rpg-reduced-motion");
  await closePopup();
  await tab.emulateMediaFeatures([]);

  report.hookTimings = await hookTimings();
} finally {
  await browser.close();
  server.close();
}
const timings = report.hookTimings || [];
if (timings.length) {
  const sorted = timings.map(t => t.elapsed).sort((a, b) => a - b);
  const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  report.hookSummary = { calls: sorted.length, medianMs: q(0.5), p95Ms: q(0.95), maxMs: sorted.at(-1),
    byKind: Object.fromEntries(["term", "kanji"].map(kind => [kind, timings.filter(t => t.kind === kind).length])) };
}
writeFileSync(resolve(OUT, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, hookTimings: undefined }, null, 2));
