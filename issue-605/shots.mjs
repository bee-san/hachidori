// Evidence script for hachidori #605 (kept on the assets branch, not in the PR):
// popup headwords in real Chrome, looked up through the real engine worker, for
// a small fixture dictionary written for this test. Usage:
//   HACHIDORI_CHROME=... HACHIDORI_PUPPETEER=.../puppeteer-core/lib/esm/puppeteer/puppeteer-core.js \
//     node shots.mjs <checkout> <outdir> <plain|pitch>
// Writes <outdir>/<mode>-<n>.png (one headword per file) and <mode>.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, out, mode = "plain"] = process.argv.slice(2);
const root = resolve(checkout);
mkdirSync(out, { recursive: true });
const { buildTitledZip } = await import(pathToFileURL(join(root, "test/make-fixture.mjs")).href);
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;

const WORDS = [
  ["二十四時間", "にじゅうよじかん", "twenty-four hours; around the clock"],
  ["一生懸命", "いっしょうけんめい", "with all one's might"],
  ["自転車", "じてんしゃ", "bicycle"],
  ["世界中", "せかいじゅう", "all over the world"],
  ["植木", "うえき", "garden plant"],
  ["命の恩人", "いのちのおんじん", "someone who saved one's life"],
  ["好き嫌い", "すききらい", "likes and dislikes"],
  ["今日", "きょう", "today"],
  ["日本語", "にほんご", "the Japanese language"],
];
// Pitch positions for the pitch run only: fixture data to draw the contour,
// not a claim about the words' accents.
const PITCH = { 二十四時間: 5, 一生懸命: 5, 自転車: 2, 好き嫌い: 2, 今日: 1 };
const words = mode === "pitch" ? WORDS.filter(([expression]) => Object.hasOwn(PITCH, expression)) : WORDS;
const archive = buildTitledZip("furigana-605-fixture", {
  terms: words.map(([expression, reading, gloss], index) => [expression, reading, "", "", 0, [gloss], index + 1, ""]),
  termMeta: mode === "pitch"
    ? words.map(([expression, reading]) => [expression, "pitch", { reading, pitches: [{ position: PITCH[expression] }] }])
    : [],
});

const page = `<!doctype html><meta charset="utf-8"><title>#605</title>
<style>body{font:28px sans-serif;margin:40px} p{margin:0 0 520px}</style>
${words.map(([expression], index) => `<p><span id="w${index}">${expression}</span></p>`).join("\n")}`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const profile = mkdtempSync(join(tmpdir(), "hachi605-shots-"));
const extension = join(root, "extension");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true,
  headless: true, userDataDir: profile, defaultViewport: { width: 900, height: 700, deviceScaleFactor: 1 },
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--force-device-scale-factor=1",
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const results = [];
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"), { timeout: 60_000 });
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  const imported = await settings.evaluate(async (base64) => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))],
      { type: "application/zip" }));
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: "shots", blobUrl, fileName: "furigana-605.zip" }).catch(error => ({ ok: false, error: String(error) }));
      if (reply?.ok) return reply;
      await new Promise(done => setTimeout(done, 1000));
    }
    return { ok: false };
  }, archive.toString("base64"));
  if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported)}`);
  const tab = await browser.newPage();
  await tab.goto(pageUrl, { waitUntil: "load" });
  const cdp = await tab.createCDPSession();
  await cdp.send("DOM.enable");
  // The headword element of the visible popup, through the shadow root.
  const headword = async (expression) => {
    const { root: document } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    let found = null;
    const walk = node => {
      const attributes = node.attributes ?? [];
      for (let index = 0; index < attributes.length; index += 2) {
        if (attributes[index] === "class" && attributes[index + 1].split(" ").includes("gsm-hoshidicts-expression")) found = node;
      }
      for (const shadow of node.shadowRoots ?? []) walk(shadow);
      for (const child of node.children ?? []) walk(child);
    };
    walk(document);
    if (!found) return null;
    const { object } = await cdp.send("DOM.resolveNode", { nodeId: found.nodeId });
    const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
      functionDeclaration: `function () {
        const plain = this.cloneNode(true);
        for (const rt of plain.querySelectorAll("rt")) rt.remove();
        const box = this.getBoundingClientRect();
        return { plain: plain.textContent, text: this.textContent, rubies: this.querySelectorAll("ruby").length,
          html: this.innerHTML.replace(/<button[^>]*>/g, "<button>"),
          box: { x: box.x, y: box.y, width: box.width, height: box.height } };
      }` });
    lastSeen = result.value?.plain;
    return result.value?.plain === expression ? result.value : null;
  };
  let lastSeen = null;
  for (const [index, [expression]] of words.entries()) {
    const target = await (await tab.$(`#w${index}`)).boundingBox();
    await tab.evaluate(y => window.scrollTo(0, y), Math.max(0, target.y + (await tab.evaluate(() => scrollY)) - 60));
    const box = await (await tab.$(`#w${index}`)).boundingBox();
    let state = null;
    for (let attempt = 0; attempt < 20 && state === null; attempt += 1) {
      // Reading's default activation: hold Shift to scan.
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + 6, box.y + box.height / 2);
      await tab.keyboard.down("Shift");
      await tab.mouse.move(box.x + 7, box.y + box.height / 2);
      for (let wait = 0; wait < 15 && state === null; wait += 1) {
        await new Promise(done => setTimeout(done, 100));
        state = await headword(expression);
      }
      await tab.keyboard.up("Shift");
    }
    if (state === null) throw new Error(`no popup for ${expression}; last headword seen: ${lastSeen}`);
    await new Promise(done => setTimeout(done, 400));
    state = await headword(expression);
    // The headword's own box, which holds its ruby, with a small margin.
    const pad = 6;
    const scroll = await tab.evaluate(() => ({ x: scrollX, y: scrollY }));
    const clip = { x: Math.max(0, state.box.x - pad) + scroll.x, y: Math.max(0, state.box.y - 3) + scroll.y,
      width: Math.ceil(state.box.width + 2 * pad), height: Math.ceil(state.box.height + 3 + pad) };
    const file = join(out, `${mode}-${index}.png`);
    await tab.screenshot({ path: file, clip });
    results.push({ expression, file, rubies: state.rubies, text: state.text, html: state.html });
    await tab.mouse.move(2, 2);
    await tab.keyboard.press("Escape");
    await new Promise(done => setTimeout(done, 300));
  }
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
writeFileSync(join(out, `${mode}.json`), `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify(results.map(({ expression, rubies, text }) => ({ expression, rubies, text }))));
