// Probe: can chrome.userScripts reach the extension's own search.html?
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.argv[2];
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const CHROME = process.env.HACHIDORI_CHROME;
const EXTENSION = join(REPO, "extension");
const profile = mkdtempSync(join(tmpdir(), "hd644-"));
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: profile,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const log = (...a) => console.log(...a);
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  log("extension id", id, "chrome", await browser.version());
  let worker = await sw.worker();
  log("userScripts before toggle:", await worker.evaluate(() => typeof chrome.userScripts));
  // Turn on Allow User Scripts the way chrome://extensions does.
  const ext = await browser.newPage();
  await ext.goto(`chrome://extensions/?id=${id}`);
  const toggled = await ext.evaluate(async id => {
    try {
      await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true });
      return "ok";
    } catch (e) { return String(e); }
  }, id);
  log("toggle:", toggled);
  // The toggle restarts the extension's worker; take whichever worker exists now.
  await new Promise(r => setTimeout(r, 3000));
  const current = browser.targets().filter(t => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${id}`));
  log("workers now:", current.length);
  worker = await current.at(-1).worker();
  log("userScripts after toggle:", await worker.evaluate(() => typeof chrome.userScripts));
  const search = await browser.newPage();
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));
  const results = await worker.evaluate(async (id) => {
    const out = {};
    const attempt = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = "ERROR: " + (e?.message ?? e); } };
    await attempt("getScripts", () => chrome.userScripts.getScripts());
    await attempt("register own-extension pattern", () => chrome.userScripts.register([{ id: "probe-ext", matches: [`chrome-extension://${id}/*`], js: [{ code: "document.documentElement.dataset.probe='registered'" }] }]));
    await attempt("register <all_urls>", () => chrome.userScripts.register([{ id: "probe-all", matches: ["<all_urls>"], js: [{ code: "document.documentElement.dataset.probeAll='yes'" }], runAt: "document_start" }]));
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [chrome.runtime.getURL("search.html")] });
    out.contexts = contexts.map(c => ({ tabId: c.tabId, frameId: c.frameId }));
    if (contexts[0]) {
      await attempt("userScripts.execute USER_SCRIPT", () => chrome.userScripts.execute({ target: { tabId: contexts[0].tabId }, js: [{ code: "document.documentElement.dataset.probeExec='user'; 1" }] }));
      await attempt("userScripts.execute MAIN", () => chrome.userScripts.execute({ target: { tabId: contexts[0].tabId }, world: "MAIN", js: [{ code: "document.documentElement.dataset.probeMain='main'; 2" }] }));
      await attempt("scripting.executeScript", () => chrome.scripting.executeScript({ target: { tabId: contexts[0].tabId }, func: () => { document.documentElement.dataset.probeScripting = "s"; return 3; } }));
    }
    return out;
  }, id);
  log(JSON.stringify(results, null, 2));
  await search.reload({ waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));
  log("search.html dataset after reload:", JSON.stringify(await search.evaluate(() => ({ ...document.documentElement.dataset }))));
  // Control: a web page gets the <all_urls> script.
  const web = await browser.newPage();
  await web.goto("data:text/html,<p>hi</p>").catch(() => {});
  await web.goto("about:blank");
  await web.setContent("<p>x</p>");
  log("about:blank dataset:", JSON.stringify(await web.evaluate(() => ({ ...document.documentElement.dataset }))));
} finally {
  await browser.close();
}
