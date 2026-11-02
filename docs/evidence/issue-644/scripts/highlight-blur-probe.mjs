// Word highlighting and click-to-reveal definition blur, on a web page and on
// the search page, for #644's parity table. The popups are read through CDP
// (test/chrome-popup-root.mjs), so the closed roots (#651) stay closed. Words
// get their status from a fake AnkiConnect with no notes, so each is unknown.
//   HACHIDORI_CHROME=… node highlight-blur-probe.mjs <checkout> [extension dir]
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, EXTENSION = join(REPO, "extension")] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const { answerAnkiConnect } = await import(join(REPO, "test/anki-connect-fake.mjs"));
const { popupRoot } = await import(join(REPO, "test/chrome-popup-root.mjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (request, response) => {
  if (request.method === "POST" || request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "*");
    if (request.method === "OPTIONS") { response.end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = await answerAnkiConnect(JSON.parse(body), async (action, params) => {
      if (action === "version") return 6;
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "modelFieldNames") return ["Front", "Back"];
      if (action === "getMediaFilesNames") return [];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      if (["findNotes", "notesInfo"].includes(action)) return [];
      return null;
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reply));
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"></head>
<body style="font-size:24px;padding:40px"><p id="verb">食べたかった</p><p id="kanji">漢字を読む</p></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644hb-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const out = {};
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  for (const page of await browser.pages()) if (page.url().includes("startup.html")) await page.close();
  const fixture = readFileSync(join(REPO, "test/fixtures/hachidori-fixture.zip")).toString("base64");
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `hb-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(() => null);
      if (reply?.ok) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }, fixture);
  await settings.evaluate(async base => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { hoverEnabled: true, lookupMode: "hover",
        wordHighlightEnabled: true, wordHighlightUnknown: true,
        definitionBlurCountEnabled: true, definitionBlurDirection: "atLeast", definitionBlurThreshold: 1, definitionBlurReveal: "click",
        anki: { ...HDReaderOptions.normaliseOptions({}).anki, url: base, model: "Basic",
          fieldTemplates: { Front: { value: "{expression}", overwriteMode: "overwrite" },
            Back: { value: "{glossary}", overwriteMode: "overwrite" } } } } });
    if (!reply.ok) throw new Error(reply.error);
  }, base);
  await sleep(800);

  // The highlight ranges a document holds, by name, with the text they cover.
  const highlights = (frame, selector) => frame.evaluate(selector => Object.fromEntries([...CSS.highlights.entries()]
    .map(([name, highlight]) => [name, [...highlight].filter(range => document.querySelector(selector)?.contains(range.startContainer))
      .map((range) => {
        const live = document.createRange();
        live.setStart(range.startContainer, range.startOffset);
        live.setEnd(range.endContainer, range.endOffset);
        return live.toString();
      })]).filter(([, texts]) => texts.length > 0)), selector);
  // The root popup's blur state and the centre of its definitions, through CDP.
  const blurFacts = root => root.evaluate(shadow => {
    const popup = shadow.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    const definitions = popup?.querySelector(".gsm-hoshidicts-definitions");
    const rect = definitions?.getBoundingClientRect();
    return popup && !popup.hidden ? { blur: popup.dataset.definitionBlurState ?? "revealed",
      point: rect ? { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + Math.min(rect.height / 2, 20) } : null } : null;
  });
  const waitBlur = async (root, accept, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const facts = await blurFacts(root).catch(() => null);
      if (facts && accept(facts)) return facts;
      if (Date.now() > deadline) return facts;
      await sleep(100);
    }
  };
  // Blurred on the second lookup, still blurred after a hover, revealed by a click.
  const blurCheck = async (target, root, open) => {
    await open();
    await sleep(600);
    await open();
    const shown = await waitBlur(root, facts => facts.blur === "blurred");
    if (!shown?.point) return { shown };
    await target.mouse.move(shown.point.x, shown.point.y, { steps: 3 });
    await sleep(1200);
    const hovered = await blurFacts(root);
    await target.mouse.click(shown.point.x, shown.point.y);
    const clicked = await waitBlur(root, facts => facts.blur === "revealed", 3000);
    return { second: shown.blur, afterHover: hovered?.blur, afterClick: clicked?.blur };
  };

  const web = await browser.newPage();
  await web.setViewport({ width: 960, height: 760 });
  await web.goto(`${base}/`, { waitUntil: "load" });
  await sleep(2500);
  out.webHighlights = await highlights(web.mainFrame(), "body");
  const hoverWeb = async () => {
    await web.mouse.move(5, 5);
    await web.keyboard.press("Escape");
    await sleep(300);
    const point = await web.evaluate(() => {
      const node = document.getElementById("verb").firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await web.mouse.move(point.x - 2, point.y);
    await web.mouse.move(point.x, point.y, { steps: 3 });
    await sleep(900);
  };
  out.webBlur = await blurCheck(web, popupRoot(web), hoverWeb);

  const tab = await browser.newPage();
  await tab.setViewport({ width: 960, height: 760 });
  await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  let doc = null;
  for (let i = 0; i < 200 && !doc; i += 1) {
    doc = tab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? null;
    if (!doc) await sleep(25);
  }
  await doc.waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  const searchFor = async text => {
    await doc.focus("#search-input");
    await doc.$eval("#search-input", (box, value) => { box.value = value; }, text);
    await tab.keyboard.press("Enter");
    await sleep(900);
  };
  out.searchBlur = await blurCheck(tab, popupRoot(tab, doc.url()), () => searchFor("食べたかった"));
  await searchFor("漢字を読む");
  await sleep(2500);
  out.searchHighlights = await highlights(doc, "#search-query");
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
  server.close();
}
