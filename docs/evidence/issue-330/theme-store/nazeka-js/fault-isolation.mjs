// Evidence for issue #334: error isolation of the theme JS host. Temporarily
// replaces vendor/themes/nazeka/theme.js with a module whose onRender throws,
// loads the extension, imports the fixture, activates the theme and hovers.
// Expected: the popup still renders (CSS layer applied), the host logs exactly
// one "onRender threw" warning and never calls the hook again on this page.
//
//   HACHIDORI_ROOT=<worktree> EVIDENCE_OUT=<dir> node fault-isolation.mjs
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [resolve(homedir(), ".cache/hachidori-e2e")] }));
const ROOT = process.env.HACHIDORI_ROOT;
const OUT = process.env.EVIDENCE_OUT;
const CHROME = resolve(homedir(), ".cache/hachidori-browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const EXTENSION = resolve(ROOT, "extension");
const THEME_JS = resolve(EXTENSION, "vendor/themes/nazeka/theme.js");
const BACKUP = `${THEME_JS}.bak`;
const PROFILE = "/tmp/nazeka-fault-profile";
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const FAULTY = `export default { schema: 1, slug: "nazeka", onRender(view, api) {
  api.hide(view.chrome);                       // partial work before the fault
  throw new TypeError("deliberate theme fault for the isolation check");
} };\n`;

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>body{font:32px/2 serif;padding:56px 80px}span{display:inline-block}</style><p>朝ごはんを<span id="verb">食べたかった</span>。</p></html>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));

copyFileSync(THEME_JS, BACKUP);
writeFileSync(THEME_JS, FAULTY);
const report = { warnings: [], hookCalls: 0 };
const browser = await puppeteer.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=en-GB"],
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html#add-dictionaries`, { waitUntil: "load" });
  await settings.waitForSelector("#import-file", { timeout: 20_000 });
  await settings.waitForFunction(async () => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    return (dictionaryState?.dictionaries?.length ?? 0) === 0 && document.getElementById("recommended-starter")?.hidden === false;
  }, { timeout: 90_000, polling: 200 });
  await new Promise(r => setTimeout(r, 1500));
  await (await settings.$("#import-file")).uploadFile(resolve(ROOT, "test/fixtures/hachidori-fixture.zip"));
  report.importState = await settings.waitForFunction(() => {
    const text = (document.getElementById("import-state")?.textContent || "").trim();
    return text.startsWith("Finished 1 of 1 archive") ? text : false;
  }, { timeout: 120_000, polling: 500 }).then(h => h.jsonValue());
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: { lookupMode: "hover", popupTheme: "nazeka" } });
    if (!reply.ok) throw new Error(reply.error);
  });

  const tab = await browser.newPage();
  // Content scripts log from an isolated world; read every context through CDP.
  const cdp = await tab.createCDPSession();
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.consoleAPICalled", event => {
    if (event.type !== "warning") return;
    report.warnings.push((event.args || []).map(a => a.value ?? a.description ?? "").join(" "));
  });
  await tab.setViewport({ width: 1000, height: 760 });
  await tab.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 1500));
  const state = () => tab.evaluate(() => {
    const popup = document.querySelector("hachidori-host")?.shadowRoot?.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
    if (!popup || popup.hidden) return null;
    return { entries: popup.querySelectorAll(".gsm-hoshidicts-entry").length,
      chromeHidden: popup.querySelector(":scope > .gsm-hoshidicts-result-chrome")?.hidden === true,
      nazekaHead: !!popup.querySelector(".nazeka-head"),
      background: getComputedStyle(popup).backgroundColor,
      glossSize: getComputedStyle(popup.querySelector(".gsm-hoshidicts-glossary-content") || popup).fontSize,
      text: popup.textContent.replace(/\s+/g, " ").trim().slice(0, 80) };
  });
  const box = await (await tab.$("#verb")).boundingBox();
  let seen = null;
  for (let attempt = 0; attempt < 12 && !seen; attempt += 1) {
    await tab.mouse.move(2, 2);
    await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !seen) {
      const current = await state();
      if (current?.entries > 0) seen = current;
      else await new Promise(r => setTimeout(r, 150));
    }
  }
  report.firstRender = seen;
  // Re-render twice more (Escape, hover again): the hook must stay switched off, no new warnings.
  for (let i = 0; i < 2; i += 1) {
    await tab.keyboard.press("Escape");
    await tab.mouse.move(2, 2);
    await new Promise(r => setTimeout(r, 500));
    await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
    await new Promise(r => setTimeout(r, 1200));
  }
  report.laterRender = await state();
  await tab.screenshot({ path: resolve(OUT, "fault-isolation.png"), clip: { x: 200, y: 100, width: 660, height: 520 } });
} finally {
  await browser.close();
  server.close();
  copyFileSync(BACKUP, THEME_JS);
  rmSync(BACKUP);
}
report.verdict = {
  popupRendered: (report.firstRender?.entries ?? 0) > 0 && (report.laterRender?.entries ?? 0) > 0,
  cssStillApplied: report.firstRender?.glossSize === "13px",
  exactlyOneWarning: report.warnings.filter(w => w.includes("onRender threw")).length === 1,
  hookSwitchedOff: report.laterRender?.chromeHidden === false && report.laterRender?.nazekaHead === false,
};
writeFileSync(resolve(OUT, "fault-isolation.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
