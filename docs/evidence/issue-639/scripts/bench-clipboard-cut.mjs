// Ad-hoc measurement for #639 (not committed). In one Chrome profile with the
// fixture dictionary and a copy of the extension that holds clipboardRead:
//  1. hd_lookup latency from Settings for 5 s back to back, with no search page
//     open, with a search page polling an unchanged 1,000-character clipboard,
//     and with none again;
//  2. one hd_clipboard_read round trip from the search page, by clipboard size,
//     while the clipboard does not change;
//  3. copy-to-search latency: from a copy in another tab to the search page
//     showing the copied text as its query.
// node bench-clipboard-cut.mjs <repo>: bench-clipboard.mjs for heads whose reads return at most 1,000 characters
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repo = resolve(process.argv[2]);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { buildFixtureZip } = await import(resolve(repo, "test/make-fixture.mjs"));
const { config } = JSON.parse(readFileSync(resolve(repo, "test/tooling/package.json"), "utf8"));
const CHROME = process.env.HACHIDORI_CHROME
  || resolve(repo, `test/tmp/browsers/chrome/linux-${config.chrome}/chrome-linux64/chrome`);
const EXTENSION = "/tmp/hachi-639/bench-ext-cut";
const PROFILE = `/tmp/hachi-639/bench-profile-${process.pid}`;
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
      window.copiedAt = Date.now(); window.copied = document.execCommand("copy"); };</script>`);
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
    max: +sorted.at(-1).toFixed(3) };
};
const log = (...parts) => console.error(new Date().toISOString(), ...parts);
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
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
  const copy = async text => {
    await web.bringToFront();
    await web.$eval("#t", (t, value) => { t.value = value; }, text);
    await web.click("#copy");
    if (!await web.evaluate(() => window.copied)) throw new Error("copy failed");
    return web.evaluate(() => window.copiedAt);
  };
  // Back-to-back hd_lookup round trips from Settings for `ms`, after 50 warm-ups.
  const lookups = ms => settings.evaluate(async duration => {
    const once = async index => {
      const start = performance.now();
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup",
        requestId: `bench-${index}`, text: "食べたかった" });
      // A reply that never came (undefined) also happens on main; it is counted, not timed.
      if (reply === undefined) { globalThis.oddReplies = (globalThis.oddReplies ?? 0) + 1; return null; }
      if (!reply?.ok) throw new Error(JSON.stringify(reply));
      return performance.now() - start;
    };
    for (let index = 0; index < 50; index += 1) await once(index);
    const times = [];
    const end = performance.now() + duration;
    while (performance.now() < end) {
      const time = await once(times.length);
      if (time !== null) times.push(time);
    }
    return times;
  }, ms);
  const sentence = "昨日は友達と一緒に駅前の新しい喫茶店へ行って、美味しいケーキを食べたかったのですが、";
  const line = sentence.repeat(25).slice(0, 1000);
  await copy(line);
  log("lookups, no search page");
  const none1 = stats(await lookups(5000));

  const search = await browser.newPage();
  await search.setViewport({ width: 960, height: 760 });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  await search.waitForFunction(() => document.getElementById("search-clipboard").checked
    && !document.getElementById("search-clipboard").disabled, { polling: 50, timeout: 30_000 });
  await search.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    globalThis.polls = 0;
    chrome.runtime.sendMessage = function (message, ...rest) {
      if (message?.type === "hd_clipboard_read") globalThis.polls += 1;
      return send.call(this, message, ...rest);
    };
  });
  await search.bringToFront();
  log("lookups, search page polling");
  const pollsBefore = await search.evaluate(() => globalThis.polls);
  const polling = stats(await lookups(5000));
  const polls = await search.evaluate(() => globalThis.polls) - pollsBefore;

  // Copy-to-search latency for short lines, each new.
  log("copy to search, short lines");
  const words = ["食べる", "読む", "漢字"];
  const latencies = [];
  for (let index = 0; index < 30; index += 1) {
    const text = `${words[index % words.length]}${index}`;
    const copiedAt = await copy(text);
    await search.bringToFront();
    const shownAt = await search.waitForFunction(value => document.getElementById("search-query").textContent === value
      && Date.now(), { polling: "mutation", timeout: 15_000 }, text).then(handle => handle.jsonValue());
    latencies.push(shownAt - copiedAt);
  }

  // One read's round trip by clipboard size, the clipboard unchanged; and the
  // time a large copy takes to reach the query.
  const reads = {};
  const large = {};
  for (const [label, length, samples] of [["6 chars", 6, 100], ["1,000 chars", 1000, 100], ["100,000 chars", 100_000, 30],
    ["1,000,000 chars", 1_000_000, 10]]) {
    const text = length === 6 ? "食べたかったよ".slice(0, 6) : sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
    log("reads", label);
    const copiedAt = await copy(text);
    await search.bringToFront();
    const shownAt = await search.waitForFunction(value => document.getElementById("search-query").textContent.length === value
      && Date.now(), { polling: 50, timeout: 300_000 }, Math.min(text.length, 1000)).then(handle => handle.jsonValue());
    if (length >= 1000) large[label] = shownAt - copiedAt;
    reads[label] = stats(await search.evaluate(async (expected, count) => {
      const times = [];
      for (let index = 0; index < count + 5; index += 1) {
        const start = performance.now();
        const reply = await chrome.runtime.sendMessage({ target: "hachidori-clipboard", type: "hd_clipboard_read" });
        if (reply?.text?.length !== expected) throw new Error(`read ${reply?.text?.length} of ${expected}`);
        if (index >= 5) times.push(performance.now() - start);
      }
      return times;
    }, Math.min(text.length, 1000), samples));
  }
  await search.close();
  await copy(line);
  log("lookups, no search page again");
  const none2 = stats(await lookups(5000));
  console.log(JSON.stringify({ chrome: await browser.version(), oddReplies: await settings.evaluate(() => globalThis.oddReplies ?? 0),
    lookupMs: { noSearchPage: none1, searchPagePolling: polling, noSearchPageAgain: none2 },
    monitorReadsDuringPollingPhase: polls,
    copyToSearchMs: stats(latencies), largeCopyToQueryMs: large, clipboardReadMs: reads }, null, 2));
} finally {
  await browser.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
