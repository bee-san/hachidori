// Reproduction: Hachidori (unpacked, pinned Chrome for Testing) on the asbplayer web app.
// Usage: node /tmp/asb/repro-webapp.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

const ROOT = "/local/home/skerraut/.herdr/worktrees/hachidori/issue330-asbplayer-compat";
const EXTENSION = process.env.HD_EXTENSION || resolve(ROOT, "extension");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
const CHROME = resolve(ROOT, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome");
const PUPPETEER = resolve(ROOT, "test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const OUT = process.env.HD_OUT || "/tmp/asb/out";
const PROFILE = "/tmp/asb/profile-webapp";
const APP_URL = process.env.ASB_APP_URL || "https://app.asbplayer.dev/";
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const log = [];
const say = (...parts) => { const line = parts.join(" "); console.log(line); log.push(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SRT = `1
00:00:00,500 --> 00:00:04,500
食べたかった

2
00:00:04,600 --> 00:00:08,500
漢字を読む

3
00:00:08,600 --> 00:00:12,000
食べたかった
`;
writeFileSync("/tmp/asb/sample.srt", SRT);

const puppeteer = await import(pathToFileURL(PUPPETEER).href);
const launch = puppeteer.default?.launch ? puppeteer.default : puppeteer;

// A tiny local page: control (plain page) + a fixture that mimics a video page
// whose player div goes fullscreen (what the asbplayer extension overlay does on
// YouTube/Netflix: the subtitle container is re-parented into the fullscreen
// element, element-overlay.ts:_findFullscreenParentElement).
const CONTROL_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>control</title>
<style>body{font:32px/2 serif;padding:80px}</style></head>
<body><p><span id="verb">食べたかった</span></p></body></html>`;
const server = createServer((req, res) => {
  if (req.url.startsWith("/sample.webm")) {
    if (!existsSync("/tmp/asb/sample.webm")) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "video/webm" });
    res.end(readFileSync("/tmp/asb/sample.webm"));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(CONTROL_HTML);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const localUrl = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch.launch({
  executablePath: CHROME,
  enableExtensions: true,
  headless: true,
  userDataDir: PROFILE,
  defaultViewport: { width: 1400, height: 900 },
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-audio-output",
    "--autoplay-policy=no-user-gesture-required", "--disable-popup-blocking",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const diagnostics = [];
const watchPage = (page, tag) => {
  page.on("console", (m) => diagnostics.push(`[${tag}] ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => diagnostics.push(`[${tag}] pageerror: ${e.message}`));
};

const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 30_000 });
const extensionId = new URL(swTarget.url()).host;
say(`extension id: ${extensionId}; chrome ${await browser.version()}`);

// Import the fixture dictionary through the offscreen engine (same path as chrome-e2e installMediaArchive).
const settings = await browser.newPage();
watchPage(settings, "settings");
await settings.goto(`chrome-extension://${extensionId}/settings.html`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 600; i += 1) {
  const status = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }).catch((e) => ({ ok: false, error: String(e) })));
  if (status?.ok && status.ready && !status.loading) break;
  await sleep(100);
}
await settings.evaluate(async (base64) => {
  const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "application/zip" }));
  const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: "repro-import", blobUrl, fileName: "hachidori-fixture.zip" });
  if (!reply.ok) throw new Error(reply.error);
  return reply.generation;
}, readFileSync(FIXTURE).toString("base64"));
for (let i = 0; i < 200; i += 1) {
  const status = await settings.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
  if (status.ok && status.ready && !status.loading) break;
  await sleep(50);
}
await settings.evaluate(async () => {
  const { options } = await chrome.storage.local.get("options");
  const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
    baseRevision: options?.revision ?? 0, options: { hoverEnabled: true, lookupMode: "hover" } });
  if (!reply.ok) throw new Error(reply.error);
});
say("options: lookupMode=hover (default is activationSticky: hold Shift while hovering)");
const dictionaries = await settings.evaluate(() => chrome.storage.local.get("dictionaryState"));
say(`dictionaries installed: ${JSON.stringify((dictionaries.dictionaryState?.dictionaries ?? []).map((d) => d.title))}`);

// Popup reader through CDP (the popup lives in a shadow root under <hachidori-host>).
async function popupState(page) {
  return page.evaluate(() => {
    const host = document.querySelector("hachidori-host");
    if (!host) return { host: false };
    const popup = host.shadowRoot?.querySelector(".gsm-hoshidicts-popup[data-hoshidicts-depth='0']");
    if (!popup) return { host: true, popup: false };
    const rect = popup.getBoundingClientRect();
    const stripped = popup.cloneNode(true);
    for (const rt of stripped.querySelectorAll("rt, rp")) rt.remove();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const topmost = popup.hidden ? null : document.elementFromPoint(center.x, center.y);
    return {
      host: true, popup: true, hidden: popup.hidden, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      text: (stripped.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
      topmostAtCenter: topmost ? `${topmost.localName}${topmost.id ? "#" + topmost.id : ""}${topmost.className ? "." + String(topmost.className).split(" ")[0] : ""}` : null,
      fullscreenElement: document.fullscreenElement ? document.fullscreenElement.localName + (document.fullscreenElement.id ? "#" + document.fullscreenElement.id : "") : null,
    };
  });
}
async function hoverAndWait(page, x, y, { expectVisible = true, timeout = 2500 } = {}) {
  await page.mouse.move(2, 2);
  await sleep(60);
  await page.mouse.move(x, y);
  const deadline = Date.now() + timeout;
  let state;
  for (;;) {
    state = await popupState(page);
    if (state.popup && !state.hidden) break;
    if (Date.now() >= deadline) break;
    await sleep(60);
  }
  return state;
}

// ---- 0. control: a plain page --------------------------------------------------------
const control = await browser.newPage();
watchPage(control, "control");
await control.goto(localUrl, { waitUntil: "load" });
await sleep(600);
{
  const box = await (await control.$("#verb")).boundingBox();
  const state = await hoverAndWait(control, box.x + 12, box.y + box.height / 2);
  say(`CONTROL plain page popup visible: ${state.popup && !state.hidden} text="${state.text}"`);
  await control.screenshot({ path: `${OUT}/00-control-plain-page.png` });
}

// ---- 1. generate a small WebM in the browser (no ffmpeg on this host) ----------------------
if (!existsSync("/tmp/asb/sample.webm")) {
  const gen = await browser.newPage();
  const base64 = await gen.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    document.body.append(canvas);
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(15);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => { recorder.onstop = r; });
    recorder.start(200);
    const start = performance.now();
    await new Promise((r) => {
      const tick = () => {
        const t = (performance.now() - start) / 1000;
        ctx.fillStyle = `hsl(${(t * 30) % 360} 60% 35%)`;
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#fff"; ctx.font = "48px sans-serif";
        ctx.fillText(`t=${t.toFixed(1)}s`, 200, 200);
        if (t < 14) requestAnimationFrame(tick); else r();
      };
      tick();
    });
    recorder.stop();
    await done;
    const blob = new Blob(chunks, { type: "video/webm" });
    const buffer = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  });
  writeFileSync("/tmp/asb/sample.webm", Buffer.from(base64, "base64"));
  await gen.close();
}
say(`sample.webm bytes: ${readFileSync("/tmp/asb/sample.webm").length}`);

// ---- 2. asbplayer web app ---------------------------------------------------------------
const app = await browser.newPage();
watchPage(app, "asbplayer-app");
await app.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60_000 });
say(`asbplayer app loaded: ${app.url()} title="${await app.title()}"`);
await sleep(1500);
const fileInput = await app.$("input[type=file]");
if (!fileInput) throw new Error("no file input on the asbplayer app page");
await fileInput.uploadFile("/tmp/asb/sample.webm", "/tmp/asb/sample.srt");
say("uploaded sample.webm + sample.srt through the hidden <input type=file>");
// Wait for the subtitle list and the video iframe.
await app.waitForFunction(() => document.querySelectorAll("td.asb-subtitles, .asb-subtitles").length > 0, { timeout: 30_000 });
await sleep(1500);
const frames = app.frames().map((f) => ({ url: f.url(), name: f.name(), parent: !!f.parentFrame() }));
say(`frames in the app page: ${JSON.stringify(frames)}`);
const hachidoriInFrames = [];
for (const frame of app.frames()) {
  try {
    const has = await frame.evaluate(() => ({ HDPopup: typeof globalThis.HDPopup, host: !!document.querySelector("hachidori-host"), fullscreenElement: document.fullscreenElement?.localName ?? null }));
    hachidoriInFrames.push({ url: frame.url().slice(0, 120), ...has });
  } catch (e) { hachidoriInFrames.push({ url: frame.url().slice(0, 120), error: e.message }); }
}
say(`Hachidori content script presence per frame: ${JSON.stringify(hachidoriInFrames)}`);
const domInfo = await app.evaluate(() => {
  const cell = document.querySelector("td.asb-subtitles");
  const span = cell?.querySelector("span[data-track]");
  return { cellHtml: cell?.outerHTML.slice(0, 400), spanText: span?.textContent, iframe: document.querySelector("iframe[title='asbplayer']")?.outerHTML.slice(0, 300) };
});
say(`subtitle list DOM: ${JSON.stringify(domInfo)}`);
await app.screenshot({ path: `${OUT}/10-asbplayer-app-loaded.png` });

// 2a. hover the first subtitle in the SUBTITLE LIST (top frame)
{
  const target = await app.evaluateHandle(() => [...document.querySelectorAll("td.asb-subtitles span[data-track]")].find((s) => s.textContent.includes("食べたかった")));
  const box = await target.boundingBox();
  say(`subtitle list cell for 食べたかった at ${JSON.stringify(box)}`);
  const state = await hoverAndWait(app, box.x + 10, box.y + box.height / 2);
  say(`A. SUBTITLE LIST (top frame) popup visible: ${state.popup && !state.hidden} text="${state.text}" rect=${JSON.stringify(state.rect)}`);
  await app.screenshot({ path: `${OUT}/11-asbplayer-subtitle-list-hover.png` });
  await app.mouse.move(2, 2);
  await sleep(1200);
}

// 2b. hover the subtitle rendered over the VIDEO (inside the same-origin <iframe>)
const videoFrame = app.frames().find((f) => f !== app.mainFrame() && f.url().includes("video="));
if (!videoFrame) { say("B. no video iframe found"); } else {
  await videoFrame.waitForSelector("video", { timeout: 30_000 });
  await videoFrame.evaluate(async () => {
    const video = document.querySelector("video");
    await new Promise((r) => (video.readyState >= 1 ? r() : video.addEventListener("loadedmetadata", r, { once: true })));
    video.currentTime = 1.0;
    try { await video.play(); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    video.pause();
  });
  // Nudge the app clock so the overlay renders the current cue: press space twice in the video frame, or wait.
  const overlayFound = await videoFrame.waitForFunction(() => {
    const el = document.querySelector(".asbplayer-subtitles");
    return el && el.textContent.includes("食べたかった") && el.getBoundingClientRect().width > 0;
  }, { timeout: 15_000 }).then(() => true).catch(() => false);
  say(`B. video overlay cue rendered inside iframe: ${overlayFound}`);
  const overlay = await videoFrame.evaluate(() => {
    const el = document.querySelector(".asbplayer-subtitles");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { html: el.outerHTML.slice(0, 500), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, fullscreen: document.fullscreenElement?.localName ?? null, HDPopup: typeof globalThis.HDPopup, host: !!document.querySelector("hachidori-host") };
  });
  say(`B. overlay DOM in iframe: ${JSON.stringify(overlay)}`);
  const iframeBox = await (await app.$("iframe[title='asbplayer']")).boundingBox();
  if (overlay) {
    const x = iframeBox.x + overlay.rect.x + 12;
    const y = iframeBox.y + overlay.rect.y + overlay.rect.h / 2;
    const state = await hoverAndWait(app, x, y);
    const topCaret = await app.evaluate(({ x, y }) => {
      const r = document.caretRangeFromPoint(x, y);
      const el = document.elementFromPoint(x, y);
      return { caretContainer: r ? r.startContainer.nodeName : null, elementFromPoint: el ? el.localName + (el.title ? `[title=${el.title}]` : "") : null };
    }, { x, y });
    say(`B. VIDEO OVERLAY (in iframe) popup visible in top frame: ${state.popup && !state.hidden}; top-frame caretRangeFromPoint=${JSON.stringify(topCaret)}`);
    const frameState = await popupState(videoFrame);
    say(`B. hachidori-host inside iframe document: ${frameState.host}; popup inside iframe visible: ${frameState.popup && !frameState.hidden} text="${frameState.text ?? ""}" rect=${JSON.stringify(frameState.rect ?? null)}`);
    await app.screenshot({ path: `${OUT}/12-asbplayer-video-iframe-hover.png` });
    await app.mouse.move(2, 2);
  }
}

// 2c. POP OUT: the video opens in its own top-level window
{
  const vf = app.frames().find((f) => f !== app.mainFrame() && f.url().includes("video="));
  const iframeBox2 = await (await app.$("iframe[title='asbplayer']")).boundingBox();
  await app.mouse.move(iframeBox2.x + iframeBox2.width / 2, iframeBox2.y + iframeBox2.height / 2);
  await sleep(500);
  const popOutButton = vf ? await vf.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.title || "").match(/pop ?out/i))) : null;
  let popOut = null;
  if (popOutButton && (await popOutButton.evaluate((b) => !!b))) {
    const visibility = await popOutButton.evaluate((b) => { const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); let el = b, hiddenBy = null; while (el) { const s = getComputedStyle(el); if (s.visibility === "hidden" || s.opacity === "0" || s.display === "none") { hiddenBy = el.localName + "." + String(el.className).split(" ")[0] + ":" + s.visibility + "/" + s.opacity + "/" + s.display; break; } el = el.parentElement; } return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, visibility: cs.visibility, opacity: cs.opacity, hiddenBy, label: b.getAttribute("aria-label") }; });
    say(`C. pop-out button: ${JSON.stringify(visibility)}`);
    const popupPromise = browser.waitForTarget((t) => t.type() === "page" && t.url().includes("popout=true"), { timeout: 15_000 }).catch(() => null);
    await app.mouse.move(iframeBox2.x + iframeBox2.width / 2 + 5, iframeBox2.y + iframeBox2.height / 2 + 5);
    await sleep(300);
    await popOutButton.evaluate((b) => b.click());
    const target = await popupPromise;
    say(`C. targets after click: ${JSON.stringify(browser.targets().filter((t) => t.type() === "page").map((t) => t.url().slice(0, 90)))}`);
    popOut = target ? await target.page() : null;
  } else {
    say("C. no Pop Out button found via aria-label/title; trying the Bar menu");
  }
  if (!popOut) {
    // window.open from a message round-trip loses the activation in headless; open the same URL directly.
    const popOutUrl = vf ? vf.url().replace("popout=false", "popout=true") : null;
    if (popOutUrl) {
      popOut = await browser.newPage();
      await popOut.goto(popOutUrl, { waitUntil: "load", timeout: 30_000 }).catch((e) => say(`C. pop-out navigation failed: ${e.message}`));
      say(`C. opened the pop-out URL directly in a new top-level tab: ${popOutUrl.slice(0, 80)}...`);
    }
  }
  if (!popOut) { say("C. pop-out window did not open"); } else {
    watchPage(popOut, "popout");
    await popOut.setViewport({ width: 1000, height: 600 });
    await popOut.waitForSelector("video", { timeout: 30_000 });
    await sleep(1000);
    await popOut.evaluate(async () => {
      const video = document.querySelector("video");
      await new Promise((r) => (video.readyState >= 1 ? r() : video.addEventListener("loadedmetadata", r, { once: true })));
      video.currentTime = 1.0; try { await video.play(); } catch {} await new Promise((r) => setTimeout(r, 300)); video.pause();
    });
    const found = await popOut.waitForFunction(() => { const el = document.querySelector(".asbplayer-subtitles"); return el && el.textContent.includes("食べたかった") && el.getBoundingClientRect().width > 0; }, { timeout: 15_000 }).then(() => true).catch(() => false);
    say(`C. pop-out window overlay cue rendered: ${found}; HDPopup in pop-out: ${await popOut.evaluate(() => typeof globalThis.HDPopup)}`);
    if (found) {
      const r = await popOut.evaluate(() => { const el = document.querySelector(".asbplayer-subtitles"); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, html: el.outerHTML.slice(0, 300) }; });
      say(`C. pop-out overlay DOM: ${JSON.stringify(r)}`);
      const state = await hoverAndWait(popOut, r.x + 12, r.y + r.h / 2);
      say(`C. POP-OUT window (top frame) popup visible: ${state.popup && !state.hidden} text="${state.text}" rect=${JSON.stringify(state.rect)} topmost=${state.topmostAtCenter}`);
      await popOut.screenshot({ path: `${OUT}/13-asbplayer-popout-hover.png` });
      // Let the cue change (seek to the next cue) while the popup is open: does the popup follow/hide?
      await popOut.evaluate(async () => { const v = document.querySelector("video"); v.currentTime = 5.0; try { await v.play(); } catch {} await new Promise((r) => setTimeout(r, 400)); v.pause(); });
      await sleep(1200);
      const after = await popupState(popOut);
      const anchorInfo = await popOut.evaluate(() => {
        const off = document.querySelector(".asbplayer-offscreen");
        return { offscreenChildren: off ? off.children.length : null, offscreenText: off?.textContent?.replace(/\s+/g, " ").trim().slice(0, 80), showing: document.querySelector(".asbplayer-subtitles")?.textContent?.trim() };
      });
      say(`C2. after cue change: popup visible=${after.popup && !after.hidden} rect=${JSON.stringify(after.rect)} text="${after.text}"; asbplayer offscreen cache: ${JSON.stringify(anchorInfo)}`);
      await popOut.screenshot({ path: `${OUT}/14-asbplayer-popout-after-cue-change.png` });
      // Fullscreen in the web app is documentElement.requestFullscreen (use-fullscreen.ts:14)
      await popOut.mouse.move(2, 2); await sleep(800);
      const fsButton = await popOut.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.title || "").match(/fullscreen/i)));
      const hasFs = await fsButton.evaluate((b) => !!b);
      if (hasFs) {
        await popOut.evaluate(async () => { const v = document.querySelector("video"); v.currentTime = 1.0; try { await v.play(); } catch {} await new Promise((r) => setTimeout(r, 300)); v.pause(); });
        await popOut.mouse.move(500, 300); await sleep(300);
        await fsButton.click();
        await sleep(1500);
        const fsInfo = await popOut.evaluate(() => ({ fullscreenElement: document.fullscreenElement?.localName ?? null, w: innerWidth, h: innerHeight }));
        say(`C3. web-app fullscreen: ${JSON.stringify(fsInfo)}`);
        const r2 = await popOut.evaluate(() => { const el = document.querySelector(".asbplayer-subtitles"); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
        if (r2) {
          const st = await hoverAndWait(popOut, r2.x + 12, r2.y + r2.h / 2);
          say(`C3. fullscreen (documentElement) popup visible: ${st.popup && !st.hidden} topmostAtCenter=${st.topmostAtCenter} fullscreenElement=${st.fullscreenElement}`);
          await popOut.screenshot({ path: `${OUT}/15-asbplayer-popout-fullscreen-hover.png` });
        }
      } else say("C3. no fullscreen button found");
    }
  }
}

writeFileSync(`${OUT}/webapp-log.txt`, log.join("\n") + "\n\n--- console ---\n" + diagnostics.join("\n") + "\n");
console.log("\n--- console diagnostics ---\n" + diagnostics.filter((d) => !d.includes("Download the React DevTools")).join("\n"));
await browser.close();
server.close();
