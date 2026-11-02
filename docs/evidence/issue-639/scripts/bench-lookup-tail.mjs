// Ad-hoc measurement for #639 (not committed): hd_lookup latency from Settings,
// 5 s back to back per phase, in three interleaved rounds of
//   none     no search page open,
//   polling  a search page whose Clipboard monitor reads an unchanged
//            1,000-character clipboard every 250 ms,
//   stalled  a search page open whose monitor's first read never returns,
// each search page fresh and closed after its phase.
// BENCH_CLIP_LEN=<chars> node bench-lookup-tail.mjs <repo> [--main]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repo = resolve(process.argv[2]);
const MAIN = process.argv.includes("--main");
const LEN = Number(process.env.BENCH_CLIP_LEN || 1000);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { buildFixtureZip } = await import(resolve(repo, "test/make-fixture.mjs"));
const { config } = JSON.parse(readFileSync(resolve(repo, "test/tooling/package.json"), "utf8"));
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(repo, `test/tmp/browsers/chrome/linux-${config.chrome}/chrome-linux64/chrome`);
const EXTENSION = "/tmp/hachi-639/bench-lookup-tail-ext";
const PROFILE = `/tmp/hachi-639/bench-lookup-tail-profile-${process.pid}`;
rmSync(EXTENSION, { recursive: true, force: true });
cpSync(resolve(repo, "extension"), EXTENSION, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"));
delete manifest.optional_permissions;
if (!MAIN) manifest.permissions.push("clipboardRead");
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
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, median: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), p99: +at(0.99).toFixed(3),
    p999: +at(0.999).toFixed(3), max: +sorted.at(-1).toFixed(3), over10: sorted.filter(v => v > 10).length,
    over50: sorted.filter(v => v > 50).length, over100: sorted.filter(v => v > 100).length,
    sum: +sorted.reduce((a, b) => a + b, 0).toFixed(1) };
};
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  settings.on("console", message => { if (message.type() === "warn") console.error("[settings]", message.text()); });
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const imported = await settings.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: "bench", blobUrl,
      fileName: "fixture.zip" });
  }, buildFixtureZip().toString("base64"));
  if (!imported?.ok) throw new Error(JSON.stringify(imported));
  const web = await browser.newPage();
  await web.goto(`http://127.0.0.1:${server.address().port}/`);
  const sentence = "昨日は友達と一緒に駅前の新しい喫茶店へ行って、美味しいケーキを食べたかったのですが、";
  await web.$eval("#t", (t, value) => { t.value = value; }, sentence.repeat(Math.ceil(LEN / sentence.length) + 1).slice(0, LEN));
  await web.click("#copy");
  if (!await web.evaluate(() => window.copied)) throw new Error("copy failed");
  const lookups = phase => settings.evaluate(async (duration, label) => {
    const odd = [];
    const once = async index => {
      const start = performance.now();
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup",
        requestId: `bench-${index}`, text: "食べたかった" });
      if (!reply?.ok) {
        odd.push({ index, at: Math.round(performance.now()), reply: reply === undefined ? "undefined" : reply });
        return null;
      }
      return performance.now() - start;
    };
    for (let index = 0; index < 50; index += 1) await once(index);
    const times = [];
    const end = performance.now() + duration;
    while (performance.now() < end) {
      const time = await once(times.length);
      if (time !== null) times.push(time);
    }
    if (odd.length) console.warn("odd replies in", label, JSON.stringify(odd.slice(0, 5)), odd.length);
    globalThis.oddReplies = (globalThis.oddReplies ?? 0) + odd.length;
    return times;
  }, 5000, phase);
  const openSearch = async stalled => {
    const search = await browser.newPage();
    await search.setViewport({ width: 960, height: 760 });
    if (stalled) {
      await search.evaluateOnNewDocument(() => {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = function (message, ...rest) {
          if (message?.type === "hd_clipboard_read") return new Promise(() => {});
          return send.call(this, message, ...rest);
        };
      });
    }
    await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
    await search.waitForFunction(main => !document.getElementById("search-submit").disabled
      && (main || document.getElementById("search-clipboard").checked), { polling: 50, timeout: 30_000 }, MAIN);
    return search;
  };
  const rounds = [];
  for (let round = 0; round < 3; round += 1) {
    const result = {};
    await web.bringToFront();
    result.none = stats(await lookups(`round ${round} none`));
    let search = await openSearch(false);
    result.polling = stats(await lookups(`round ${round} polling`));
    await search.close();
    rounds.push(result);
    console.error(new Date().toISOString(), JSON.stringify(result));
  }
  console.log(JSON.stringify({ chrome: await browser.version(), oddReplies: await settings.evaluate(() => globalThis.oddReplies ?? 0),
    rounds }, null, 1));
} finally {
  await browser.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
