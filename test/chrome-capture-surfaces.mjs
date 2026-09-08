// SPDX-License-Identifier: GPL-3.0-or-later
// Optional Linux/X11 checks. Use an isolated Xvfb display, never a personal desktop.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const display = process.env.HACHIDORI_CAPTURE_TEST_DISPLAY;
assert.match(display || "", /^:[1-9]\d*$/u, "Set HACHIDORI_CAPTURE_TEST_DISPLAY to an isolated Xvfb display (not :0).");
const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(resolve(tmpdir(), "hachidori-surfaces-"));
const environment = { ...process.env, DISPLAY: display, SDL_VIDEODRIVER: "x11",
  XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "" };
const puppeteerPath = process.env.HACHIDORI_PUPPETEER
  || resolve(homedir(), ".cache/hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath));
const TITLE = "Hachidori synthetic application capture";
const delay = ms => new Promise(done => setTimeout(done, ms));
const xdotool = (...args) => execFileSync("xdotool", args, { env: environment, encoding: "utf8" }).trim();
const checks = ["application window is selected and missing audio is reported", "window resize reaches the recorder",
  "minimize and restore preserve or explicitly stop the source", "closing the captured application stops and clears history",
  "entire monitor is accepted and explicit Stop clears it"];
const passed = new Set();
const results = { display, checks, temporary };
let browser;
let application;
let manager;

async function waitForWindow() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return xdotool("search", "--name", `^${TITLE}$`).split("\n")[0]; }
    catch { await delay(100); }
  }
  throw new Error("The synthetic ffplay application window did not appear.");
}

async function startBrowser(surface) {
  browser = await puppeteer.launch({
    executablePath: process.env.HACHIDORI_CHROME || "/usr/bin/chromium", headless: false,
    userDataDir: resolve(temporary, `profile-${surface}`), env: environment,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--ozone-platform=x11", "--disable-features=WebRtcPipeWireCapturer",
      "--autoplay-policy=no-user-gesture-required",
      `--disable-extensions-except=${resolve(root, "extension")}`, `--load-extension=${resolve(root, "extension")}`,
      "--enable-usermedia-screen-capturing", surface === "window"
        ? `--auto-select-desktop-capture-source=${TITLE}` : "--auto-select-screen-capture-source"],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  results.browser = await browser.version();
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().endsWith("/background.js"));
  const id = new URL(worker.url()).hostname;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`);
  await settings.evaluate(async () => {
    const options = HDReaderOptions.normaliseOptions({ mediaCapture: {
      enabled: true, includeAnimation: true, includeCapturedAudio: true,
    } });
    await chrome.storage.local.set({ options });
  });
  await settings.close();
  const controls = await browser.newPage();
  await controls.goto(`chrome-extension://${id}/capture.html`);
  await controls.bringToFront();
  await controls.waitForFunction(() => !document.getElementById("capture-start").disabled);
  await controls.click("#capture-start");
  try {
    await controls.waitForFunction(async () => {
      const reply = await chrome.runtime.sendMessage({ target: "hachidori-capture", type: "hd_capture_status" });
      return reply.state === "recording" && reply.history.frameCount >= 3;
    }, { timeout: 20_000 });
  } catch (error) {
    results.startupFailure = await controls.evaluate(() => chrome.runtime.sendMessage({ target: "hachidori-capture", type: "hd_capture_status" }));
    console.log(JSON.stringify(results.startupFailure));
    throw error;
  }
  const host = await browser.waitForTarget(target => target.url() === `chrome-extension://${id}/offscreen.html`);
  const client = await host.createCDPSession();
  const dimensions = async () => {
    const reply = await client.send("Runtime.evaluate", { expression: `(() => {
      const video = document.querySelector("video");
      return {width: video.videoWidth, height: video.videoHeight, audioTracks: video.srcObject.getAudioTracks().length};
    })()`, returnByValue: true });
    return reply.result.value;
  };
  const status = () => controls.evaluate(() => chrome.runtime.sendMessage({ target: "hachidori-capture", type: "hd_capture_status" }));
  return { controls, dimensions, status };
}

try {
  // KWin gets a private bus/config and only manages the supplied test display.
  const configPath = resolve(temporary, "config");
  mkdirSync(configPath);
  writeFileSync(resolve(configPath, "kwinrc"), "[Compositing]\nEnabled=false\n");
  manager = spawn("dbus-run-session", ["--", "kwin_x11", "--no-kactivities"], {
    env: { ...environment, XDG_CONFIG_HOME: configPath }, stdio: "ignore", detached: true,
  });
  await delay(500);
  application = spawn("ffplay", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=30",
    "-an", "-window_title", TITLE], { env: environment, stdio: "ignore" });
  const windowId = await waitForWindow();
  const window = await startBrowser("window");
  results.window = { initial: await window.status(), dimensions: await window.dimensions() };
  assert.equal(results.window.initial.mediaSource.displaySurface, "window");
  assert.equal(results.window.initial.mediaSource.audioAvailable, results.window.dimensions.audioTracks > 0);
  assert.equal(results.window.initial.mediaSource.audioAvailable, false, "this X11 synthetic application has no captured audio track");
  assert.equal(await window.controls.$eval("#audio-history", element => element.textContent), "Source audio unavailable");
  passed.add(checks[0]);

  xdotool("windowsize", windowId, "500", "500");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    results.window.resized = await window.dimensions();
    if (Math.abs(results.window.resized.width - results.window.resized.height) < 80) break;
    await delay(100);
  }
  assert.ok(Math.abs(results.window.resized.width - results.window.resized.height) < 80);
  passed.add(checks[1]);

  xdotool("windowminimize", windowId);
  await delay(700);
  results.window.minimized = await window.status();
  xdotool("windowmap", windowId);
  xdotool("windowactivate", "--sync", windowId);
  await delay(700);
  results.window.restored = await window.status();
  if (results.window.minimized.state === "stopped") {
    assert.equal(results.window.restored.state, "stopped", "a stopped source never silently restarts");
    assert.match(results.window.restored.error, /unavailable|ended/u);
    await window.controls.bringToFront();
    await window.controls.click("#capture-start");
    await window.controls.waitForFunction(() => document.getElementById("capture-state").textContent === "Recording");
  } else {
    assert.equal(results.window.restored.captureSessionId, results.window.initial.captureSessionId);
    assert.ok(results.window.restored.history.frameNewestMs > results.window.minimized.history.frameNewestMs);
  }
  passed.add(checks[2]);
  application.kill("SIGTERM");
  await window.controls.waitForFunction(() => document.getElementById("capture-state").textContent === "Stopped", { timeout: 10_000 });
  results.window.closed = await window.status();
  assert.equal(results.window.closed.history.frameCount, 0);
  assert.match(results.window.closed.error, /ended|unavailable/u);
  passed.add(checks[3]);
  await browser.close(); browser = null;

  const monitor = await startBrowser("monitor");
  results.monitor = { initial: await monitor.status(), dimensions: await monitor.dimensions() };
  assert.equal(results.monitor.initial.mediaSource.displaySurface, "monitor");
  assert.equal(results.monitor.initial.mediaSource.audioAvailable, results.monitor.dimensions.audioTracks > 0);
  await monitor.controls.click("#capture-stop");
  await monitor.controls.waitForFunction(() => document.getElementById("capture-state").textContent === "Stopped");
  results.monitor.stopped = await monitor.status();
  assert.equal(results.monitor.stopped.history.frameCount, 0);
  passed.add(checks[4]);
} finally {
  await browser?.close();
  application?.kill("SIGTERM");
  if (manager?.pid) { try { process.kill(-manager.pid, "SIGTERM"); } catch { /* The test manager may have exited. */ } }
  results.passed = [...passed];
  writeFileSync(resolve(temporary, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${passed.size} passed, ${checks.length - passed.size} failed; evidence ${resolve(temporary, "results.json")}`);
}
assert.equal(passed.size, checks.length);
