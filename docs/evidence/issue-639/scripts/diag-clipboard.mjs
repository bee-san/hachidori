// Diagnostic for #639 (not committed): where a large clipboard's time goes.
// node /tmp/hachi-639/diag-clipboard.mjs <repo>
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repo = resolve(process.argv[2]);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { config } = JSON.parse(readFileSync(resolve(repo, "test/tooling/package.json"), "utf8"));
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(repo, `test/tmp/browsers/chrome/linux-${config.chrome}/chrome-linux64/chrome`);
const EXTENSION = "/tmp/hachi-639/diag-ext";
const PROFILE = `/tmp/hachi-639/diag-profile-${process.pid}`;
rmSync(EXTENSION, { recursive: true, force: true });
cpSync(resolve(repo, "extension"), EXTENSION, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"));
delete manifest.optional_permissions;
manifest.permissions.push("clipboardRead");
writeFileSync(resolve(EXTENSION, "manifest.json"), JSON.stringify(manifest, null, 2));
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><meta charset="utf-8"><textarea id="t"></textarea><button id="copy">Copy</button>
    <script>document.getElementById("copy").onclick = () => { const t = document.getElementById("t"); t.select();
      window.copied = document.execCommand("copy"); };</script>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: PROFILE, enableExtensions: true,
  protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const web = await browser.newPage();
  await web.goto(`http://127.0.0.1:${server.address().port}/`);
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  // One read makes the offscreen document exist.
  await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status", requestId: "d" }));
  const offscreenTarget = await browser.waitForTarget(t => t.url().endsWith("/offscreen.html"), { timeout: 30_000 });
  const cdp = await offscreenTarget.createCDPSession();
  const inOffscreen = async expression => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const sentence = "昨日は友達と一緒に駅前の新しい喫茶店へ行って、美味しいケーキを食べたかったのですが、";
  const results = [];
  for (const length of (process.env.DIAG_LENGTHS ?? "1000,10000,100000,300000,1000000").split(",").map(Number)) {
    const text = sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
    await web.bringToFront();
    await web.$eval("#t", (t, value) => { t.value = value; }, text);
    await web.click("#copy");
    // In the offscreen document: the production reader, then variants of its text area.
    const timing = await inOffscreen(`(async () => {
      const { readClipboardText } = await import("./search-clipboard.js");
      const time = async run => { const start = performance.now(); const value = await run(); return [+(performance.now() - start).toFixed(1), value.length]; };
      const out = {};
      out.production = await time(() => readClipboardText({ document, navigator, firefox: false }));
      out.productionAgain = await time(() => readClipboardText({ document, navigator, firefox: false }));
      const variant = style => time(() => {
        const target = document.body.appendChild(document.createElement("textarea"));
        Object.assign(target.style, style);
        try { target.focus(); document.execCommand("paste"); return target.value; } finally { target.remove(); }
      });
      return out;
    })()`);
    // The worker round trip from Settings (refused), to time messaging without the paste.
    results.push({ length, offscreenMs: timing });
    console.error(JSON.stringify(results.at(-1)));
  }
  console.log(JSON.stringify({ chrome: await browser.version(), offscreen: results }, null, 2));
} finally {
  await browser.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
