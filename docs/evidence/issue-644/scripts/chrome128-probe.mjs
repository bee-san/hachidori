import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const EXTENSION = join(REPO, "extension");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644c128-")),
  args: ["--no-sandbox", "--disable-gpu", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  console.log("version:", await browser.version());
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  let probe = null;
  const workerScripts = async () => {
    if (probe) await probe.close();
    probe = await browser.newPage();
    await probe.goto(`chrome-extension://${id}/toolbar.html`, { waitUntil: "load" });
    return probe.evaluate(async () => { try { return JSON.stringify((await chrome.userScripts.getScripts()).map(s => s.id)); } catch (e) { return `ERR ${e.message}`; } });
  };
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  const write = code => settings.evaluate(async code => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options?.revision ?? 0, options: { customPopupJavascript: code } });
    return reply.ok;
  }, code);
  console.log("write:", await write("document.documentElement.dataset.customScript = 'ran';"));
  await sleep(500);
  console.log("before dev mode:", await workerScripts());
  const ext = await browser.newPage();
  await ext.goto("chrome://extensions/");
  console.log("profile config:", JSON.stringify(await ext.evaluate(async () => { const c = await chrome.developerPrivate.getProfileConfiguration(); return { inDeveloperMode: c.inDeveloperMode }; })));
  const toggled = await ext.evaluate(async id => {
    try { await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true }); return "per-extension ok"; }
    catch (e) { return `per-extension ERR ${e.message}`; }
  }, id);
  console.log("toggle:", toggled);
  await ext.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await sleep(1500);
  console.log("after dev mode on:", await workerScripts(), "workers:", browser.targets().filter(t => t.type() === "service_worker").length);
  console.log("write again:", await write("document.documentElement.dataset.customScript = 'ran';\n"));
  await sleep(800);
  console.log("after write:", await workerScripts());
  const search = await browser.newPage();
  const errors = [];
  search.on("console", m => { if (["error", "warn"].includes(m.type())) errors.push(m.text()); });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await sleep(1500);
  const frame = search.frames().find(f => f.url().endsWith("/search-frame.html"));
  console.log("frame:", frame?.url(), JSON.stringify(await frame?.evaluate(() => ({ ready: !document.getElementById("search-submit").disabled, script: document.documentElement.dataset.customScript ?? null, origin: self.origin }))));
  console.log("errors:", JSON.stringify(errors));
  await ext.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: false }));
} finally { await browser.close(); }
