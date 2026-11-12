// Real-browser CSP, production field renderer and Settings sample preview.
// HACHIDORI_TEMPLATE_BROWSER=firefox runs the same assertions in Firefox.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const firefox = process.env.HACHIDORI_TEMPLATE_BROWSER === "firefox";
const profile = await mkdtemp(join(tmpdir(), "hachidori-handlebars-"));
const browserRoot = process.env.HACHIDORI_BROWSER_ROOT || resolve(root, "test/tmp/browsers");
const executablePath = firefox
  ? process.env.HACHIDORI_FIREFOX || join(browserRoot, "firefox/linux-stable_159.0/firefox/firefox")
  : process.env.HACHIDORI_CHROME || join(browserRoot, "chrome/linux-152.0.7977.75/chrome-linux64/chrome");
let writes = 0;
const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  if (request.method === "OPTIONS") { response.end(); return; }
  if (request.method === "POST") {
    let text = "";
    for await (const chunk of request) text += chunk;
    const value = await answerAnkiConnect(JSON.parse(text), action => {
      if (["addNote", "updateNoteFields", "storeMediaFile"].includes(action)) writes++;
      return ({ version: 6, deckNames: ["Default"], modelNames: ["Basic"], modelNamesAndIds: { Basic: 1 },
        modelFieldNames: ["Front", "Back"], modelTemplates: { Card: { Front: "{{Front}}", Back: "{{Back}}" } },
        findNotes: [], findCards: [], notesInfo: [], cardsInfo: [], canAddNotes: [true],
        canAddNotesWithErrorDetail: [{ canAdd: true }] })[action] ?? [];
    });
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); return;
  }
  if (request.url === "/overlay.html") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Overlay host</title><body></body>"); return; }
  // Overlay hosts serve these same production modules on their own origin.
  const path = request.url === "/" ? "/anki-template-frame.html" : request.url;
  try {
    const file = await readFile(join(root, "extension", path));
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(file);
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}`;
let extension = resolve(root, "extension"), origin;
if (firefox) {
  extension = join(profile, "extension");
  const built = spawnSync("python3", [resolve(root, "scripts/build-firefox.py"), "--output-dir", extension], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  origin = "moz-extension://5a1d4c2e-8f3b-4e6a-9c7d-0b1e2f3a4b5c";
}
const browser = await puppeteer.launch({ browser: firefox ? "firefox" : "chrome", executablePath,
  headless: true, enableExtensions: true, userDataDir: join(profile, "browser"),
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({
    "{b39ca224-e554-498d-8d8b-b2a5ad2f7a13}": "5a1d4c2e-8f3b-4e6a-9c7d-0b1e2f3a4b5c" }) },
  args: firefox ? [] : ["--no-sandbox", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  if (firefox) await browser.installExtension(extension);
  else { const url = new URL((await browser.waitForTarget(t => t.type() === "service_worker")).url()); origin = `${url.protocol}//${url.host}`; }
  const page = await browser.newPage();
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  page.on("pageerror", error => console.error(error.message));
  const navigate = async url => {
    if (!firefox) { await page.goto(url); return; }
    const context = page.mainFrame().browsingContext;
    await context.userContext.browser.session.send("browsingContext.navigate", { context: context.id, url, wait: "none" });
    await page.waitForFunction(expected => location.href === expected && document.readyState === "complete", {}, url);
  };
  await navigate(`${origin}/settings.html#anki`);
  const rendered = await page.evaluate(async () => {
    const { buildAnkiResourceFields } = await import("./anki-resources.js");
    const request = { term: { expression: "食べる", reading: "たべる", rules: "v1", frequencies: [], pitches: [],
      glossaries: [{ dictionary: "Sample", glossary: '["to eat"]', definitionTags: "", termTags: "" }] },
      trace: [], sentence: "食べた。", matched: "食べた", matchOffset: 0, dictionaryIds: {}, dictionaryAliases: {},
      preparation: { example: "A & B" } };
    const fields = { Front: { value: "{{term.expression}}", syntax: "handlebars", overwriteMode: "coalesce" },
      Back: { value: '{{marker "glossary-first"}} / {{preparation.example}}', syntax: "handlebars", overwriteMode: "coalesce" } };
    const output = await buildAnkiResourceFields(request, fields, { document, dictionaryPaths: {}, styles: async () => [] });
    const sandbox = document.querySelector('iframe[title="Anki field template renderer"]');
    let inaccessible = false;
    try { inaccessible = sandbox.contentWindow.document === undefined; } catch { inaccessible = true; }
    return { output, inaccessible, sandbox: sandbox.getAttribute("sandbox") };
  });
  assert.equal(rendered.output.fields.Front, "食べる");
  assert.match(rendered.output.fields.Back, /to eat/u);
  assert.match(rendered.output.fields.Back, /A &amp; B/u);
  assert.equal(rendered.inaccessible, true);
  assert.equal(rendered.sandbox, "allow-scripts");
  // Firefox BiDi does not enumerate this opaque extension child frame.
  if (!firefox) {
    const templateFrame = page.frames().find(frame => frame.url().endsWith("/anki-template-frame.html"));
    assert.equal(await templateFrame.evaluate(() => typeof globalThis.chrome?.runtime?.sendMessage), "undefined",
      "the compiler frame has no extension messaging API");
  }
  await page.evaluate(async url => {
    const options = globalThis.HDReaderOptions.normaliseOptions({ anki: { url, deck: "Default", model: "Basic",
      fieldTemplates: { Front: { value: "{expression}", overwriteMode: "coalesce" },
        Back: { value: '{{marker "glossary-first"}}', syntax: "handlebars", overwriteMode: "coalesce" } } } });
    await chrome.storage.local.set({ options });
  }, serverUrl);
  await navigate(`${origin}/settings.html?handlebars=1#anki`);
  if (!firefox) await page.bringToFront();
  await page.waitForSelector('[data-anki-field="Back"] .anki-template-preview:not([hidden])');
  await page.click('[data-anki-field="Back"] .anki-template-preview');
  await page.waitForFunction(() => document.querySelector('[data-anki-field="Back"] .anki-template-preview-output')?.textContent.includes("to eat"));
  assert.equal(writes, 0, "Preview never mutates Anki or uploads media");
  await page.evaluate(() => {
    const editor = document.querySelector('[data-anki-field="Back"] textarea');
    editor.value = "{{#if term.expression}}";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('[data-anki-field="Back"] .anki-template-error')?.textContent.includes("Parse error"));
  const evidence = process.env.HACHIDORI_TEMPLATE_EVIDENCE;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.hoshidictsTheme = theme; }, theme);
      const controls = await page.$("#anki-templates");
      await controls.screenshot({ path: join(evidence, `handlebars-${firefox ? "firefox" : "chrome"}-${theme}.png`) });
    }
  }
  // Exercise the same sandbox module from a host origin, with no extension API.
  if (!firefox) {
    const overlay = await browser.newPage();
    await overlay.goto(`${serverUrl}/overlay.html`);
    const value = await overlay.evaluate(async () => {
      const { renderHandlebars } = await import("./anki-template-sandbox.js");
      return renderHandlebars(document, "{{term.expression}}", { term: { expression: "host <word>" } }, {});
    });
    assert.equal(value, "host &lt;word&gt;");
  }
  console.log(`PASS: ${firefox ? "Firefox" : "Chrome and overlay-origin"} sandbox, production rich fields, Settings preview/errors, no Anki writes.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
