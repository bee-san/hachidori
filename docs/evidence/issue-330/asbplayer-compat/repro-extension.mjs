// Reproduction: Hachidori + the asbplayer browser extension (built from the clone) on a
// local video page. Usage: node /tmp/asb/repro-extension.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

const ROOT = "/local/home/skerraut/.herdr/worktrees/hachidori/issue330-asbplayer-compat";
const EXTENSION = process.env.HD_EXTENSION || resolve(ROOT, "extension");
const ASB_EXTENSION = "/tmp/asb/asbplayer/extension/.output/chrome-mv3";
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const CHROME = resolve(ROOT, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const PUPPETEER = resolve(ROOT, "test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const OUT = process.env.HD_OUT || "/tmp/asb/out";
const PROFILE = "/tmp/asb/profile-extension";
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const log = [];
const say = (...parts) => { const line = parts.join(" "); console.log(line); log.push(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>video page</title>
<style>
  body { margin: 0; background: #111; color: #ddd; font: 16px sans-serif; }
  #player { position: relative; width: 960px; height: 540px; margin: 40px auto 0; background: #000; }
  video { width: 100%; height: 100%; display: block; }
  #controls { width: 960px; margin: 12px auto; }
  #prose { width: 960px; margin: 12px auto; font-size: 28px; }
</style></head>
<body>
  <div id="player"><video id="v" src="/sample.webm" preload="auto"></video></div>
  <div id="controls"><button id="fs">Player fullscreen</button> <button id="fsdoc">Document fullscreen</button> <button id="exitfs">Exit fullscreen</button></div>
  <p id="prose">ページ本文: <span id="verb">食べたかった</span></p>
  <script>
    document.getElementById("fs").onclick = () => document.getElementById("player").requestFullscreen();
    document.getElementById("fsdoc").onclick = () => document.documentElement.requestFullscreen();
    document.getElementById("exitfs").onclick = () => document.exitFullscreen();
  </script>
</body></html>`;
const SRT = readFileSync("/tmp/asb/sample.srt", "utf8");
const server = createServer((req, res) => {
  if (req.url.startsWith("/sample.webm")) { res.writeHead(200, { "content-type": "video/webm" }); res.end(readFileSync("/tmp/asb/sample.webm")); return; }
  if (req.url.startsWith("/sample.srt")) { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(SRT); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE_HTML);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const puppeteer = await import(pathToFileURL(PUPPETEER).href);
const launch = puppeteer.default?.launch ? puppeteer.default : puppeteer;
const browser = await launch.launch({
  executablePath: CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE,
  defaultViewport: { width: 1280, height: 800 },
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output", "--autoplay-policy=no-user-gesture-required",
    `--disable-extensions-except=${EXTENSION},${ASB_EXTENSION}`, `--load-extension=${EXTENSION},${ASB_EXTENSION}`],
});
const diagnostics = [];
const watchPage = (page, tag) => {
  page.on("console", (m) => diagnostics.push(`[${tag}] ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => diagnostics.push(`[${tag}] pageerror: ${e.message}`));
};

// Identify both extensions.
await sleep(1500);
const workers = browser.targets().filter((t) => t.type() === "service_worker");
let hachidoriId, asbId;
for (const worker of workers) {
  const id = new URL(worker.url()).host;
  if (worker.url().endsWith("/background.js")) {
    // both are background.js: distinguish by manifest name through a page
    const probe = await browser.newPage();
    await probe.goto(`chrome-extension://${id}/manifest.json`).catch(() => {});
    const text = await probe.evaluate(() => document.body.innerText).catch(() => "");
    await probe.close();
    if (text.includes("Hachidori")) hachidoriId = id; else asbId = id;
  }
}
say(`Hachidori id: ${hachidoriId}; asbplayer id: ${asbId}; chrome ${await browser.version()}`);

// Import the fixture into Hachidori and use plain hover mode.
const settings = await browser.newPage();
watchPage(settings, "hachidori-settings");
await settings.goto(`chrome-extension://${hachidoriId}/settings.html`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 600; i += 1) {
  const status = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }).catch((e) => ({ ok: false, error: String(e) })));
  if (status?.ok && status.ready && !status.loading) break;
  await sleep(100);
}
await settings.evaluate(async (base64) => {
  const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "application/zip" }));
  const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: "repro-import", blobUrl, fileName: "hachidori-fixture.zip" });
  if (!reply.ok) throw new Error(reply.error);
}, readFileSync(FIXTURE).toString("base64"));
for (let i = 0; i < 200; i += 1) {
  const status = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
  if (status.ok && status.ready && !status.loading) break;
  await sleep(50);
}
await settings.evaluate(async () => {
  const { options } = await chrome.storage.local.get("options");
  const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: options?.revision ?? 0, options: { hoverEnabled: true, lookupMode: "hover" } });
  if (!reply.ok) throw new Error(reply.error);
});
say("Hachidori: fixture imported, lookupMode=hover");

// Close asbplayer's first-run tab if it opened.
for (const t of browser.targets()) if (t.type() === "page" && t.url().includes("ftue-ui")) (await t.page())?.close().catch(() => {});

async function popupState(page) {
  return page.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    if (!host) return { host: false };
    const popup = host.shadowRoot?.querySelector(".gsm-hoshidicts-popup[data-hoshidicts-depth='0']");
    if (!popup) return { host: true, popup: false };
    const rect = popup.getBoundingClientRect();
    const stripped = popup.cloneNode(true);
    for (const rt of stripped.querySelectorAll("rt, rp")) rt.remove();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const topmost = popup.hidden ? null : document.elementFromPoint(cx, cy);
    const describe = (el) => el ? `${el.localName}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""}` : null;
    return {
      host: true, popup: true, hidden: popup.hidden,
      rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      text: (stripped.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      topmostAtCenter: describe(topmost),
      hostParent: describe(host.parentElement),
      fullscreenElement: describe(document.fullscreenElement),
      hostInsideFullscreen: document.fullscreenElement ? document.fullscreenElement.contains(host) : null,
    };
  });
}
async function hoverAndWait(page, x, y, timeout = 2500) {
  await page.mouse.move(2, 2); await sleep(80); await page.mouse.move(x, y);
  const deadline = Date.now() + timeout;
  let state;
  for (;;) { state = await popupState(page); if (state.popup && !state.hidden) break; if (Date.now() >= deadline) break; await sleep(60); }
  return state;
}
const overlayRect = (page) => page.evaluate(() => {
  const el = document.querySelector(".asbplayer-subtitles, .asbplayer-fullscreen-subtitles");
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const container = el.parentElement;
  const describe = (n) => n ? `${n.localName}${n.id ? "#" + n.id : ""}${n.className ? "." + String(n.className).split(" ")[0] : ""}` : null;
  return { x: b.x, y: b.y, w: b.width, h: b.height, text: el.textContent.trim(), className: el.className, containerClass: container?.className, containerParent: describe(container?.parentElement), html: el.outerHTML.slice(0, 260) };
});
const seek = (page, t) => page.evaluate(async (t) => { const v = document.getElementById("v"); v.currentTime = t; try { await v.play(); } catch {} await new Promise((r) => setTimeout(r, 350)); v.pause(); }, t);

const page = await browser.newPage();
watchPage(page, "video-page");
await page.goto(pageUrl, { waitUntil: "load" });
await page.waitForSelector(".asbplayer-drag-zone-initial", { timeout: 20_000 });
say("asbplayer extension bound to the <video> (drag zone present)");
// Drop the .srt onto asbplayer's drag zone (drag-controller.ts dropListener → Binding.loadSubtitles).
await page.evaluate(async () => {
  const text = await (await fetch("/sample.srt")).text();
  const file = new File([text], "sample.srt", { type: "text/plain" });
  const dt = new DataTransfer(); dt.items.add(file);
  const zone = document.querySelector(".asbplayer-drag-zone-initial");
  zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await page.waitForSelector(".asbplayer-subtitles-container-bottom", { timeout: 20_000 });
say("subtitles loaded into the extension overlay (container present)");
await sleep(1500); // the "loaded" message shows for 1 s
await seek(page, 1.0);
await page.waitForFunction(() => { const el = document.querySelector(".asbplayer-subtitles"); return el && el.textContent.includes("食べたかった") && el.getBoundingClientRect().width > 0; }, { timeout: 15_000 });
let r = await overlayRect(page);
say(`D. non-fullscreen overlay: ${JSON.stringify(r)}`);
let state = await hoverAndWait(page, r.x + 14, r.y + r.h / 2);
say(`D. NON-FULLSCREEN extension overlay popup visible: ${state.popup && !state.hidden} text="${state.text}" rect=${JSON.stringify(state.rect)} topmost=${state.topmostAtCenter}`);
await page.screenshot({ path: `${OUT}/20-extension-overlay-hover.png` });

// D2: cue changes while the popup is open. asbplayer parks the old subtitle <div> in
// div.asbplayer-offscreen (OffscreenDomCache.return), so it stays connected.
await seek(page, 5.0);
await sleep(1200);
const after = await popupState(page);
const parked = await page.evaluate(() => ({ offscreen: [...document.querySelectorAll(".asbplayer-offscreen")].map((off) => { const b = off.getBoundingClientRect(); return { children: off.children.length, text: off.textContent.replace(/\s+/g, " ").trim().slice(0, 60), x: b.x, y: b.y, connected: off.isConnected }; }), showing: document.querySelector(".asbplayer-subtitles")?.textContent.trim() }));
say(`D2. after the cue changed: popup visible=${after.popup && !after.hidden} rect=${JSON.stringify(after.rect)} text="${after.text}"; asbplayer offscreen cache: ${JSON.stringify(parked)}`);
await page.screenshot({ path: `${OUT}/21-extension-overlay-after-cue-change.png` });
// Force a Hachidori reposition (scroll event) and see where the popup goes.
await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
await sleep(500);
const afterScroll = await popupState(page);
say(`D2b. after a scroll event (positionPopup): popup visible=${afterScroll.popup && !afterScroll.hidden} rect=${JSON.stringify(afterScroll.rect)}`);
await page.screenshot({ path: `${OUT}/22-extension-overlay-after-cue-change-reposition.png` });
await page.mouse.move(2, 2); await sleep(1000);

// E0: documentElement fullscreen (what the asbplayer web app does, use-fullscreen.ts:14): body is inside
// the fullscreen element, so a body-mounted host still paints.
await seek(page, 1.0);
await page.click("#fsdoc");
await sleep(1500);
say(`E0. fullscreen state: ${JSON.stringify(await page.evaluate(() => ({ fullscreenElement: document.fullscreenElement?.localName ?? null })))}`);
await page.waitForFunction(() => { const el = document.querySelector(".asbplayer-fullscreen-subtitles, .asbplayer-subtitles"); return el && el.textContent.includes("食べたかった") && el.getBoundingClientRect().width > 0; }, { timeout: 15_000 }).catch(() => say("E0. overlay not found in fullscreen"));
r = await overlayRect(page);
say(`E0. documentElement-fullscreen overlay: ${JSON.stringify(r)}`);
if (r) {
  state = await hoverAndWait(page, r.x + 14, r.y + r.h / 2);
  say(`E0. FULLSCREEN (documentElement) popup: visible=${state.popup && !state.hidden} topmostAtCenter=${state.topmostAtCenter} hostParent=${state.hostParent} hostInsideFullscreen=${state.hostInsideFullscreen}`);
  await page.screenshot({ path: `${OUT}/23a-extension-overlay-document-fullscreen-hover.png` });
}
await page.evaluate(() => document.exitFullscreen().catch(() => {}));
await page.mouse.move(2, 2); await sleep(1200);

// E: player-element fullscreen (what YouTube/Netflix players do).
await seek(page, 1.0);
await page.click("#fs");
await sleep(1500);
const fsInfo = await page.evaluate(() => ({ fullscreenElement: document.fullscreenElement?.id ?? null, innerWidth, innerHeight }));
say(`E. fullscreen state: ${JSON.stringify(fsInfo)}`);
await page.waitForFunction(() => { const el = document.querySelector(".asbplayer-fullscreen-subtitles, .asbplayer-subtitles"); return el && el.textContent.includes("食べたかった") && el.getBoundingClientRect().width > 0; }, { timeout: 15_000 }).catch(() => say("E. overlay not found in fullscreen"));
r = await overlayRect(page);
say(`E. fullscreen overlay: ${JSON.stringify(r)}`);
if (r) {
  state = await hoverAndWait(page, r.x + 14, r.y + r.h / 2);
  say(`E. FULLSCREEN (player div) popup state: popupExists=${state.popup} hidden=${state.hidden} rect=${JSON.stringify(state.rect)} text="${state.text}" topmostAtCenter=${state.topmostAtCenter} hostParent=${state.hostParent} fullscreenElement=${state.fullscreenElement} hostInsideFullscreen=${state.hostInsideFullscreen}`);
  await page.screenshot({ path: `${OUT}/23-extension-overlay-fullscreen-hover.png` });
  // Pixel probe: is anything of the popup painted where it claims to be?
  const probe = await page.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    const popup = host?.shadowRoot?.querySelector(".gsm-hoshidicts-popup[data-hoshidicts-depth='0']");
    const b = popup?.getBoundingClientRect();
    return b ? { x: Math.round(b.left + 20), y: Math.round(b.top + 20) } : null;
  });
  if (probe) {
    const el = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? e.localName + (e.id ? "#" + e.id : "") : null; }, probe);
    say(`E. elementFromPoint inside the popup's box while fullscreen: ${el}`);
  }
}
await page.evaluate(() => document.exitFullscreen().catch(() => {}));
await sleep(800);

// F: control — Hachidori on the same page's ordinary prose while not fullscreen.
const verb = await (await page.$("#verb")).boundingBox();
const fx = verb.x + 12, fy = verb.y + verb.height / 2;
const probeF = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); const r = document.caretRangeFromPoint(x, y); return { element: e ? e.localName + (e.id ? "#" + e.id : "") + (e.className ? "." + String(e.className).split(" ")[0] : "") : null, caret: r ? r.startContainer.nodeName + "@" + r.startOffset : null, fullscreen: document.fullscreenElement?.id ?? null, scrollY, innerHeight }; }, { x: fx, y: fy });
say(`F. probe at verb (${Math.round(fx)},${Math.round(fy)}): ${JSON.stringify(probeF)} box=${JSON.stringify(verb)}`);
state = await hoverAndWait(page, fx, fy, 4000);
say(`F. CONTROL prose on the same page popup visible: ${state.popup && !state.hidden} state=${JSON.stringify(state)}`);
await page.screenshot({ path: `${OUT}/24-extension-page-prose-after-exit-fullscreen.png` });

writeFileSync(`${OUT}/extension-log.txt`, log.join("\n") + "\n\n--- console ---\n" + diagnostics.join("\n") + "\n");
console.log("\n--- console diagnostics ---\n" + diagnostics.join("\n"));
await browser.close();
server.close();
