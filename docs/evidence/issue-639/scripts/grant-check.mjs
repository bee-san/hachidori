// Ad-hoc check for #639 (not committed): the Clipboard monitor with
// clipboardRead granted at run time in real Chrome, as a user's click grants it.
// Headless Chrome cannot answer the permission prompt, but Chrome asks only for
// permissions not already in the extension's runtime-granted set
// (PermissionsRequestFunction, chrome/browser/extensions/api/permissions/
// permissions_api.cc). So: install the extension as shipped, seed
// runtime_granted_permissions with clipboardRead in the closed profile, relaunch,
// then use the switch as a user would.
// node /tmp/hachi-639/grant-check.mjs <repo>
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repo = resolve(process.argv[2]);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const EXTENSION = "/tmp/hachi-639/grant-ext";
const PROFILE = `/tmp/hachi-639/grant-profile-${process.pid}`;
rmSync(EXTENSION, { recursive: true, force: true });
cpSync(resolve(repo, "extension"), EXTENSION, { recursive: true });
const shipped = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"));
if (JSON.stringify(shipped.optional_permissions) !== '["clipboardRead"]' || shipped.permissions.includes("clipboardRead")) {
  throw new Error("expected the shipped manifest");
}
const launch = () => puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, userDataDir: PROFILE,
  enableExtensions: true, protocolTimeout: 60_000, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
const extensionId = async browser => new URL((await browser.waitForTarget(t => t.type() === "service_worker"
  && t.url().startsWith("chrome-extension://"), { timeout: 30_000 })).url()).host;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><meta charset="utf-8"><p id="text"></p><button id="copy">Copy</button><script>
    document.getElementById("copy").onclick = () => { const range = document.createRange();
      range.selectNodeContents(document.getElementById("text")); getSelection().removeAllRanges(); getSelection().addRange(range);
      window.copied = document.execCommand("copy"); };</script>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
mkdirSync(PROFILE, { recursive: true });
const result = {};
const log = step => console.error(new Date().toISOString(), step, JSON.stringify(result).slice(0, 400));
let browser = await launch();
try {
  const id = await extensionId(browser);
  result.id = id;
  await new Promise(done => setTimeout(done, 3000));
} finally {
  await browser.close();
}
const prefsPath = resolve(PROFILE, "Default/Preferences");
const prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
const entry = prefs.extensions.settings[result.id];
result.before = { active: entry.active_permissions?.api, granted: entry.granted_permissions?.api,
  runtimeGranted: entry.runtime_granted_permissions?.api ?? null };
entry.runtime_granted_permissions = { api: ["clipboardRead"], explicit_host: [], manifest_permissions: [], scriptable_host: [] };
writeFileSync(prefsPath, JSON.stringify(prefs));
log("seeded");

browser = await launch();
try {
  const id = await extensionId(browser);
  const web = await browser.newPage();
  await web.goto(`http://127.0.0.1:${server.address().port}/`);
  const copy = async text => {
    await web.bringToFront();
    await web.$eval("#text", (element, value) => { element.textContent = value; }, text);
    await web.click("#copy");
    if (!await web.evaluate(() => window.copied)) throw new Error(`copy of ${text} failed`);
  };
  await copy("食べたかった");
  const search = await browser.newPage();
  await search.setViewport({ width: 960, height: 600 });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  await search.waitForFunction(() => !document.getElementById("search-clipboard").disabled, { polling: 50, timeout: 30_000 });
  await search.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    globalThis.reads = [];
    chrome.runtime.sendMessage = function (message, ...rest) {
      const reply = send.call(this, message, ...rest);
      if (message?.type === "hd_clipboard_read") reply.then(answer => globalThis.reads.push(answer?.text ?? null), () => {});
      return reply;
    };
  });
  const state = () => search.evaluate(async () => ({
    on: document.getElementById("search-clipboard").checked,
    granted: await chrome.permissions.contains({ permissions: ["clipboardRead"] }),
    query: document.getElementById("search-query").hidden ? null : document.getElementById("search-query").textContent,
    reads: globalThis.reads.length,
  }));
  const until = (predicate, timeout = 15_000) => search.waitForFunction(predicate, { polling: 50, timeout });
  result.relaunched = await state();
  log("relaunched");
  // The user's click: Chrome grants without a prompt only because clipboardRead is in the runtime-granted set.
  log("clicking on");
  await search.bringToFront();
  await search.click("#search-clipboard");
  log("clicked on");
  await until(() => document.getElementById("search-clipboard").checked, 10_000);
  log("checked");
  // Twice the clipboard's text before the change: the monitor has its baseline.
  await until(() => globalThis.reads.filter(text => text === "食べたかった").length >= 2);
  result.switchedOn = await state();
  log("switchedOn");
  await copy("読む");
  await until(() => !document.getElementById("search-query").hidden && document.getElementById("search-query").textContent === "読む");
  result.searched = await state();
  log("searched");
  await search.bringToFront();
  await search.click("#search-clipboard");
  await search.waitForFunction(async () => !document.getElementById("search-clipboard").checked
    && !await chrome.permissions.contains({ permissions: ["clipboardRead"] }), { polling: 50, timeout: 10_000 });
  const readsWhenOff = (await state()).reads;
  await copy("漢字");
  await new Promise(done => setTimeout(done, 1500));
  result.switchedOff = await state();
  log("switchedOff");
  result.readsAfterOff = result.switchedOff.reads - readsWhenOff;
  // What the worker gives the search page with the permission given back: the paste reads nothing.
  result.readWithoutPermission = await search.evaluate(() => chrome.runtime.sendMessage({ target: "hachidori-clipboard",
    type: "hd_clipboard_read" }));
  // On again: removal kept it granted, so Chrome again does not ask.
  await search.bringToFront();
  await search.click("#search-clipboard");
  await until(() => document.getElementById("search-clipboard").checked, 10_000);
  await copy("食べる");
  await until(() => document.getElementById("search-query").textContent === "食べる");
  result.onAgain = await state();
  log("onAgain");
  result.chrome = await browser.version();
} finally {
  await browser.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 1));
const ok = result.before.runtimeGranted === null && !result.before.active?.includes("clipboardRead")
  && result.relaunched.on === false && result.relaunched.granted === false && result.relaunched.query === null
  && result.switchedOn.granted === true && result.switchedOn.query === null
  && result.searched.query === "読む" && result.switchedOff.on === false && result.switchedOff.granted === false
  && result.switchedOff.query === "読む" && result.readsAfterOff === 0
  && result.readWithoutPermission?.ok === true && result.readWithoutPermission.text === ""
  && result.onAgain.granted === true && result.onAgain.query === "食べる";
console.log(ok ? "PASS" : "FAIL");
process.exitCode = ok ? 0 : 1;
