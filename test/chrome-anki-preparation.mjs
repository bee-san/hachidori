// Real USER_SCRIPT messaging, privileged cross-origin preparation fetch, the
// production reader/Anki pipeline, and Settings in the affected palettes.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { answerAnkiConnect } from "./anki-connect-fake.mjs";
import { buildTitledZip } from "./make-fixture.mjs";
import "../extension/reader-options.js";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const chromeBuild = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8")).config.chrome;
const firefox = process.env.HACHIDORI_PREPARATION_BROWSER === "firefox";
const executablePath = firefox ? process.env.HACHIDORI_FIREFOX
  || resolve(root, "test/tmp/browsers/firefox/linux-stable_159.0/firefox/firefox")
  : process.env.HACHIDORI_CHROME || resolve(root, `test/tmp/browsers/chrome/linux-${chromeBuild}/chrome-linux64/chrome`);
const profile = mkdtempSync(resolve(tmpdir(), "hachidori-preparation-"));
const evidence = resolve(root, `test/tmp/ci/anki-preparation/${firefox ? "firefox" : "chrome"}`);
mkdirSync(evidence, { recursive: true });
const notes = [], external = [];
let failRequest = false;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url === "/prepare") {
    external.push({ body, authorization: req.headers.authorization });
    // Deliberately no Access-Control-Allow-Origin: the user script's ordinary
    // fetch cannot read this second origin. Its preparation request can.
    res.writeHead(failRequest ? 500 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sentence: "猫の例文。" }));
  } else if (req.url === "/anki") {
    const result = await answerAnkiConnect(JSON.parse(body), async (action, params) => {
      if (action === "deckNames") return ["Default"];
      if (action === "modelNames") return ["Basic"];
      if (action === "modelNamesAndIds") return { Basic: 1 };
      if (action === "modelFieldNames") return ["Front", "Back"];
      if (action === "canAddNotesWithErrorDetail") return params.notes.map(() => ({ canAdd: true, error: null }));
      if (action === "findNotes") return [];
      if (action === "addNote") { notes.push(params.note); return notes.length; }
      if (action === "notesInfo") return params.notes.map(noteId => ({ noteId, modelName: "Basic", cards: [],
        fields: Object.fromEntries(Object.entries(notes[noteId - 1].fields).map(([field, value]) => [field, { value }])) }));
      if (action === "guiBrowse") return [];
      throw new Error(`Unexpected Anki operation ${action}`);
    });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><meta charset="utf-8"><title>Preparation example</title><style>body{padding:80px;font:36px sans-serif}</style><span id="word">猫</span>を読む。');
  }
});
let browser;
try {
  await new Promise(done => server.listen(0, "0.0.0.0", done));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  let extension = resolve(root, "extension");
  if (firefox) {
    extension = resolve(profile, "extension");
    const built = spawnSync("python3", [resolve(root, "scripts/build-firefox.py"), "--output-dir", extension], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
  }
  browser = await puppeteer.launch({ browser: firefox ? "firefox" : "chrome", executablePath,
    headless: true, enableExtensions: true, userDataDir: resolve(profile, "browser"),
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({
      "{b39ca224-e554-498d-8d8b-b2a5ad2f7a13}": "5a1d4c2e-8f3b-4e6a-9c7d-0b1e2f3a4b5c" }),
      "extensions.webextOptionalPermissionPrompts": false },
    args: firefox ? [] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"] });
  const diagnostics = [];
  browser.on("targetcreated", async target => { const page = await target.page(); page?.on("pageerror", error => diagnostics.push(error.stack ?? error.message)); });
  let extensionOrigin;
  if (firefox) {
    await browser.installExtension(extension);
    extensionOrigin = "moz-extension://5a1d4c2e-8f3b-4e6a-9c7d-0b1e2f3a4b5c";
  } else {
    const worker = await browser.waitForTarget(target => target.type() === "service_worker" && target.url().endsWith("/background.js"));
    const extensionId = new URL(worker.url()).host;
    extensionOrigin = `chrome-extension://${extensionId}`;
    const extensions = await browser.newPage();
    await extensions.goto("chrome://extensions");
    await extensions.evaluate(async extensionId => {
      await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
      const info = await chrome.developerPrivate.getExtensionInfo(extensionId);
      if (info.userScriptsAccess) await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, userScriptsAccess: true });
    }, extensionId);
    await extensions.close();
  }
  const navigate = async (page, url) => {
    if (!firefox) { await page.goto(url); return; }
    const context = page.mainFrame().browsingContext;
    const expected = new URL(url).href;
    await context.userContext.browser.session.send("browsingContext.navigate", { context: context.id, url: expected, wait: "none" });
    await page.waitForFunction(expected => location.href === expected && document.readyState === "complete", {}, expected);
  };
  const settings = await browser.newPage();
  settings.setDefaultTimeout(60_000);
  await navigate(settings, `${extensionOrigin}/settings.html#user-scripts`);
  if (firefox) {
    await settings.waitForSelector("#custom-javascript-allow");
    await settings.click("#custom-javascript-allow");
    await settings.waitForFunction(async () => chrome.permissions.contains({ permissions: ["userScripts"] }));
  }
  await navigate(settings, `${extensionOrigin}/settings.html#anki`);
  await settings.waitForFunction(async () => {
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
    return reply.ok && reply.ready && !reply.loading;
  });
  const archive = buildTitledZip("Preparation fixture", { terms: [["猫", "ねこ", "", "", 1, ["cat"], 1, ""]] });
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    try {
      const result = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: "preparation-fixture", blobUrl, fileName: "fixture.zip" });
      if (!result.ok) throw new Error(result.error);
    } finally { URL.revokeObjectURL(blobUrl); }
  }, archive.toString("base64"));
  const preparationScript = { scriptId: "examples", handlerId: "prepare" };
  const javascript = `HDAnkiPreparation.register("prepare", async (context, { request }) => {
    const response = await request("http://localhost:${port}/prepare", { method: "POST", headers: { Authorization: "Bearer local-test-credential" }, body: context.term.expression });
    if (!response.ok) throw new Error("private response must not enter diagnostics");
    return { example: (await response.json()).sentence };
  });
  // Test-only observations stay in DOM attributes, so the real popup remains
  // closed to the page while either browser can inspect the action's state.
  const publish = () => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    if (!root) return;
    document.documentElement.dataset.preparationTestState = root.querySelector(".gsm-hoshidicts-mine-button")?.dataset.state ?? "";
    document.documentElement.dataset.preparationTestFeedback = root.querySelector("output")?.textContent ?? "";
  };
  globalThis.addEventListener("hachidori-popup-shown", () => {
    const root = document.querySelector("hachidori-host")?.shadowRoot;
    if (root) new MutationObserver(publish).observe(root, { subtree:true, attributes:true, childList:true, characterData:true });
    publish();
  });
  globalThis.addEventListener("test-preparation-add", () => document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-mine-button")?.click());
  document.documentElement.dataset.preparationTestInstalled = "true";`;
  const writeOptions = patch => settings.evaluate(async encoded => {
    const patch = JSON.parse(encoded);
    const { options } = await chrome.storage.local.get("options");
    const result = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!result.ok) throw new Error(result.error);
  }, JSON.stringify(patch));
  await writeOptions({ hoverEnabled: true, lookupMode: "hover", audioSources: [],
    userScripts: [{ id: "examples", name: "Sentence examples", enabled: true, javascript, css: "" }],
    anki: globalThis.HDReaderOptions.normaliseAnki({ url: `${origin}/anki`, model: "Basic", captureScreenshot: false, duplicateBehavior: "new",
      preparationScript, fieldTemplates: { Front: { value: "{expression}", overwriteMode: "coalesce" },
        Back: { value: "{preparation-example}", overwriteMode: "coalesce" } } }) });
  await settings.waitForFunction(async () => (await chrome.userScripts.getScripts()).some(script => script.id === "hachidori-custom-javascript"));
  const reading = await browser.newPage();
  await reading.setViewport({ width: 1100, height: 800 });
  const show = async () => {
    await navigate(reading, origin);
    await reading.waitForFunction(() => document.documentElement.dataset.preparationTestInstalled === "true");
    const position = await reading.$eval("#word", word => { const rect = word.getBoundingClientRect(); return { x: rect.left + 8, y: rect.top + rect.height / 2 }; });
    await reading.mouse.move(2, 2);
    await reading.mouse.move(position.x, position.y);
    await reading.waitForFunction(() => document.documentElement.dataset.preparationTestState === "ready");
  };
  await show();
  assert.equal(external.length, 0, "hover/readiness must not call the preparation API");
  const registered = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hachidori-anki", type: "hd_anki_preparation_status" }));
  assert.ok(registered.registeredHandlers > 0, JSON.stringify({ registered, diagnostics }));
  await reading.evaluate(() => globalThis.dispatchEvent(new Event("test-preparation-add")));
  await reading.waitForFunction(() => document.documentElement.dataset.preparationTestState === "success");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].fields.Back, "猫の例文。");
  assert.deepEqual(external, [{ body: "猫", authorization: "Bearer local-test-credential" }]);
  failRequest = true;
  await show();
  await reading.evaluate(() => globalThis.dispatchEvent(new Event("test-preparation-add")));
  await reading.waitForFunction(() => document.documentElement.dataset.preparationTestFeedback?.includes("preparation script failed"));
  assert.equal(notes.length, 1, "a failed preparation cannot send a partial note");
  assert.equal(external.length, 2);
  await navigate(settings, `${extensionOrigin}/settings.html?preparation=1#anki`);
  await settings.waitForSelector("#opt-anki-preparation-script");
  await settings.waitForFunction(() => document.querySelector("#opt-anki-preparation-script").value === "examples");
  for (const scheme of ["light", "dark"]) {
    await writeOptions({ popupTheme: scheme });
    await settings.waitForFunction(theme => document.documentElement.dataset.hoshidictsTheme === theme, {}, scheme);
    await settings.setViewport({ width: 1100, height: 850 });
    await settings.$eval("#opt-anki-preparation-script", node => node.closest(".anki-setting-row").scrollIntoView({ block: "center" }));
    await settings.screenshot({ path: resolve(evidence, `settings-${scheme}.png`) });
  }
  const report = await settings.evaluate(async () => {
    const module = await import("./debug-info.js");
    return module.collectDebugInfo({ window, chrome,
      targets: { worker: "hoshidicts-worker", sharing: "hachidori-sharing", anki: "hachidori-anki" },
      send: (type, fields = {}, target = "hoshidicts-offscreen") => chrome.runtime.sendMessage({ target, type, ...fields }) });
  });
  assert.ok(!JSON.stringify(report).includes("local-test-credential"));
  assert.ok(!JSON.stringify(report.debugLog).includes("private response must not enter diagnostics"));
  assert.equal(report.services.ankiPreparation.lastFailure, "script");
  console.log("PASS native USER_SCRIPT preparation, cross-origin fetch, explicit Add, final card, failure without a write, saved Template and light/dark Settings");
  console.log(`Screenshots: ${evidence}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}
