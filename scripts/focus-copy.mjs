// Scratch (auditor, round b): in real Chrome with the extension loaded, a status leaves the error tone
// while its Copy error details button is keyboard-focused, mouse-focused, or not focused.
// Settings: the polled engine status ("Cannot reach the engine" -> "Ready"), with hd_status failing
// until the test lets it through. Startup: the recommended-install status ("X could not be installed"
// -> "Y installed in ..."), with hd_setup_install answered by a fake run and progress events sent
// through the real runtime messaging from the service worker.
// usage: HACHIDORI_CHROME=<chrome> node focus-copy.mjs <worktree> <profile dir> <tooling dir>
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const [worktree, profile, tooling] = process.argv.slice(2).map((path) => resolve(path));
const EXTENSION = resolve(worktree, "extension");
const require = createRequire(resolve(tooling, "package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME,
  enableExtensions: true,
  headless: true,
  userDataDir: profile,
  defaultViewport: { width: 1280, height: 640 },
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const results = {};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Runs before the page's own scripts on every load of a patched page.
function patchRuntime() {
  if (!globalThis.chrome?.runtime?.sendMessage) return;
  window.__audit = { failStatus: true, run: null };
  const runtime = chrome.runtime;
  const original = runtime.sendMessage.bind(runtime);
  const patched = (message, ...rest) => {
    if (message?.type === "hd_status" && location.pathname === "/settings.html" && window.__audit.failStatus) {
      return Promise.reject(new Error("induced: the extension's service worker did not reply"));
    }
    if (message?.type === "hd_setup_install" && window.__audit.run !== null) {
      return Promise.resolve({ ok: true, ...structuredClone(window.__audit.run) });
    }
    return original(message, ...rest);
  };
  try { runtime.sendMessage = patched; } catch { /* defined below */ }
  if (runtime.sendMessage !== patched) {
    Object.defineProperty(runtime, "sendMessage", { value: patched, configurable: true, writable: true });
  }
}

// Where focus is and how it looks, plus the page's scroll positions.
function readFocus() {
  const active = document.activeElement;
  const describe = (node) => node === null ? null
    : node === document.body ? "body"
      : `${node.localName}${node.id ? `#${node.id}` : ""}${node.classList.contains("copy-error-details") ? ".copy-error-details" : ""}`
        + (node.localName === "a" ? `(${node.textContent.trim().slice(0, 30)})` : "");
  const style = active ? getComputedStyle(active) : null;
  const scrollers = [document.scrollingElement, ...document.querySelectorAll("aside, main, .page, .setup-card")]
    .filter(Boolean).map((node) => `${node.localName}${node.id ? `#${node.id}` : ""}:${Math.round(node.scrollTop)}`);
  return {
    active: describe(active),
    focusVisible: active?.matches(":focus-visible") ?? false,
    outline: style ? `${style.outlineStyle} ${style.outlineWidth}` : null,
    tabindex: active?.getAttribute("tabindex") ?? null,
    copyHidden: [...document.querySelectorAll("button.copy-error-details")].map((button) => button.hidden),
    scroll: scrollers.join(" "),
  };
}

// Is the focused element inside the viewport and its scrolling rail? Saves a clip around it.
async function shoot(page, name) {
  const box = await page.evaluate(() => {
    const active = document.activeElement;
    const rect = active.getBoundingClientRect();
    const rail = active.closest("aside")?.getBoundingClientRect() ?? null;
    const style = getComputedStyle(active);
    window.__auditRect = { rect: [rect.x, rect.y, rect.width, rect.height].map(Math.round), innerHeight: window.innerHeight,
      position: style.position, clipPath: style.clipPath, width: style.width, height: style.height, text: active.textContent.trim() };
    return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height,
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth,
      inRail: rail === null || (rect.top >= rail.top && rect.bottom <= rail.bottom) };
  });
  if (process.env.AUDIT_SHOTS) {
    const pad = 28;
    await page.screenshot({ path: `${process.env.AUDIT_SHOTS}/${name}.png`,
      clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } });
  }
  if (process.env.AUDIT_SHOTS) await page.screenshot({ path: `${process.env.AUDIT_SHOTS}/${name}-viewport.png` });
  return { inViewport: box.inViewport, inRail: box.inRail, ...(await page.evaluate(() => window.__auditRect)) };
}

async function tabTo(page, predicate, { shift = false, limit = 80 } = {}) {
  for (let presses = 0; presses < limit; presses += 1) {
    if (await page.evaluate(predicate)) return presses;
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    if (shift) await page.keyboard.up("Shift");
  }
  throw new Error(`could not reach the control with ${limit} Tab presses`);
}

// The AX node Chrome exposes for an element (what a screen reader is told on focus).
async function axNode(page, selector) {
  const cdp = await page.createCDPSession();
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    const node = nodes[0];
    const property = (name) => node.properties?.find((entry) => entry.name === name)?.value?.value;
    return { role: node.role?.value, name: node.name?.value ?? "", live: property("live"), focusable: property("focusable"),
      focused: property("focused"), ignored: node.ignored };
  } finally {
    await cdp.detach();
  }
}

try {
  const sw = await browser.waitForTarget((target) => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"), { timeout: 30_000 });
  const id = new URL(sw.url()).host;
  // The extension opens its own startup page on install; close it so only the patched page runs setup.
  const opened = await browser.waitForTarget((target) => target.type() === "page" && target.url().endsWith("/startup.html"),
    { timeout: 15_000 }).catch(() => null);
  if (opened) await (await opened.page()).close();

  // ------------------------------------------------------------------ Settings: engine status
  const settings = await browser.newPage();
  if (process.env.PRSWEEP_SCHEME) await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: process.env.PRSWEEP_SCHEME }]);
  await settings.evaluateOnNewDocument(patchRuntime);
  const settingsUrl = `chrome-extension://${id}/settings.html#lookup`;
  const engineError = async () => {
    await settings.goto("about:blank");
    await settings.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await settings.waitForFunction(() => document.getElementById("engine-status")?.textContent.startsWith("Cannot reach the engine")
      && document.querySelector("aside button.copy-error-details")?.hidden === false, { timeout: 30_000, polling: 50 });
    await settings.evaluate(() => { document.scrollingElement.scrollTop = 300; });
  };
  const engineClears = async () => {
    await settings.evaluate(() => { window.__audit.failStatus = false; });
    // The status retries every 5 s while it cannot reach the engine.
    await settings.waitForFunction(() => document.getElementById("engine-status")?.textContent.trim().startsWith("Ready"),
      { timeout: 30_000, polling: 20 });
    await sleep(150);
  };
  const isCopy = () => document.activeElement?.classList.contains("copy-error-details") === true;

  await engineError();
  const presses = await tabTo(settings, isCopy);
  const keyboardBefore = await settings.evaluate(readFocus);
  await engineClears();
  const keyboardAfter = await settings.evaluate(readFocus);
  const ax = keyboardAfter.active === "output#engine-status" ? await axNode(settings, "#engine-status") : null;
  keyboardAfter.visible = await shoot(settings, "settings-keyboard-after");
  await settings.keyboard.press("Tab");
  const nextTab = await settings.evaluate(readFocus);
  results.settingsKeyboard = { presses, before: keyboardBefore, after: keyboardAfter, ax, nextTab: nextTab.active };
  await engineError();
  await tabTo(settings, isCopy);
  await engineClears();
  await settings.keyboard.down("Shift");
  await settings.keyboard.press("Tab");
  await settings.keyboard.up("Shift");
  results.settingsKeyboard.shiftTab = (await settings.evaluate(readFocus)).active;

  await engineError();
  await settings.click("aside button.copy-error-details");
  const mouseBefore = await settings.evaluate(readFocus);
  await engineClears();
  results.settingsMouse = { before: mouseBefore, after: await settings.evaluate(readFocus) };

  await engineError();
  await tabTo(settings, () => document.activeElement?.classList.contains("privacy-link") === true);
  const otherBefore = await settings.evaluate(readFocus);
  await engineClears();
  results.settingsOtherControl = { before: otherBefore, after: await settings.evaluate(readFocus) };

  await engineError();
  await settings.evaluate(() => document.activeElement?.blur());
  const noneBefore = await settings.evaluate(readFocus);
  await engineClears();
  results.settingsUnfocused = { before: noneBefore, after: await settings.evaluate(readFocus) };
  await settings.close();

  // ------------------------------------------------------------------ Startup: setup status
  const startup = await browser.newPage();
  if (process.env.PRSWEEP_SCHEME) await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: process.env.PRSWEEP_SCHEME }]);
  await startup.evaluateOnNewDocument(patchRuntime);
  await startup.goto(`chrome-extension://${id}/startup.html`, { waitUntil: "domcontentloaded" });
  await startup.waitForFunction(() => document.getElementById("setup-start") !== null, { timeout: 30_000, polling: 50 });
  const SOURCES = ["jitendex", "jmnedict", "bees-ultimate-kanji-dictionary", "jiten", "bees-ultimate-grammar-dictionary"];
  let sequence = 0;
  const phases = Object.fromEntries(SOURCES.map((sourceId) => [sourceId, { phase: "queued" }]));
  const snapshot = () => ({ runId: "audit-run", sequence, finished: false,
    entries: SOURCES.map((sourceId) => ({ sourceId, ...phases[sourceId] })) });
  // One more progress event, through the real runtime messaging the installer uses.
  const progress = async (sourceId, entry) => {
    phases[sourceId] = entry;
    sequence += 1;
    const message = { target: "hachidori-setup-events", type: "hd_setup_progress", ...snapshot() };
    await startup.evaluate((run) => { window.__audit.run = run; }, snapshot());
    const worker = await sw.worker();
    await worker.evaluate((event) => chrome.runtime.sendMessage(event).catch(() => {}), message);
    await sleep(300);
  };
  phases.jitendex = { phase: "failed", error: "induced publisher failure" };
  sequence = 1;
  await startup.evaluate((run) => { window.__audit.run = run; }, snapshot());
  await startup.evaluate(() => document.getElementById("setup-start").click());
  await startup.waitForFunction(() => document.getElementById("setup-status")?.classList.contains("is-error")
    && document.querySelector("#setup-card button.copy-error-details")?.hidden === false, { timeout: 30_000, polling: 50 });
  const startupStatus = () => document.getElementById("setup-status").textContent;

  await tabTo(startup, isCopy);
  const startupKeyboardBefore = { ...(await startup.evaluate(readFocus)), status: await startup.evaluate(startupStatus) };
  await progress("jmnedict", { phase: "installed", seconds: 1.5 });
  const startupKeyboardAfter = { ...(await startup.evaluate(readFocus)), status: await startup.evaluate(startupStatus) };
  const startupAx = startupKeyboardAfter.active === "output#setup-status" ? await axNode(startup, "#setup-status") : null;
  startupKeyboardAfter.visible = await shoot(startup, "startup-keyboard-after");
  await startup.keyboard.press("Tab");
  results.startupKeyboard = { before: startupKeyboardBefore, after: startupKeyboardAfter, ax: startupAx,
    nextTab: (await startup.evaluate(readFocus)).active };

  await progress("bees-ultimate-kanji-dictionary", { phase: "failed", error: "induced archive failure" });
  await startup.click("#setup-card button.copy-error-details");
  const startupMouseBefore = { ...(await startup.evaluate(readFocus)), status: await startup.evaluate(startupStatus) };
  await progress("jiten", { phase: "installed", seconds: 2.5 });
  results.startupMouse = { before: startupMouseBefore,
    after: { ...(await startup.evaluate(readFocus)), status: await startup.evaluate(startupStatus),
      visible: await shoot(startup, "startup-mouse-after") } };

  await progress("bees-ultimate-grammar-dictionary", { phase: "failed", error: "induced import failure" });
  await tabTo(startup, () => document.activeElement?.getAttribute("href") === "settings.html#add-dictionaries", { shift: true });
  const startupOtherBefore = await startup.evaluate(readFocus);
  await progress("bees-ultimate-kanji-dictionary", { phase: "installed", seconds: 3.5 });
  results.startupOtherControl = { before: startupOtherBefore, after: await startup.evaluate(readFocus),
    status: await startup.evaluate(startupStatus) };

  await progress("jmnedict", { phase: "failed", error: "induced second failure" });
  await startup.evaluate(() => document.activeElement?.blur());
  const startupNoneBefore = { ...(await startup.evaluate(readFocus)), status: await startup.evaluate(startupStatus) };
  await progress("jiten", { phase: "already-installed" });
  results.startupUnfocused = { before: startupNoneBefore, after: await startup.evaluate(readFocus),
    status: await startup.evaluate(startupStatus) };
  results.chrome = await browser.version();
} finally {
  await browser.close();
}
for (const [name, value] of Object.entries(results)) console.log(name, JSON.stringify(value));
