// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { prepareFirefoxExtension } from "../scripts/prepare-firefox.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TOOLING = resolve(ROOT, "test/tooling");
const FIREFOX = process.env.HACHIDORI_FIREFOX;
const IDLE_MS = Number(process.env.HACHIDORI_FIREFOX_IDLE_MS ?? 31_000);
const require = createRequire(resolve(TOOLING, "package.json"));
const tooling = JSON.parse(await readFile(resolve(TOOLING, "package.json"), "utf8"));
const { start: startGeckodriver } = await import(pathToFileURL(require.resolve("geckodriver")).href);

if (!FIREFOX) throw new Error("Set HACHIDORI_FIREFOX or run this suite through test/run.mjs.");
if (!Number.isFinite(IDLE_MS) || IDLE_MS < 0) throw new Error("HACHIDORI_FIREFOX_IDLE_MS must be nonnegative.");

const sleep = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function main() {
  const extension = process.env.HACHIDORI_FIREFOX_EXTENSION
    ? resolve(process.env.HACHIDORI_FIREFOX_EXTENSION)
    : await prepareFirefoxExtension();
  const fixture = (await readFile(resolve(ROOT, "test/fixtures/hachidori-fixture.zip"))).toString("base64");
  const port = await freePort();
  const driver = await startGeckodriver({
    port,
    geckoDriverVersion: tooling.config.geckodriver,
    cacheDir: resolve(ROOT, "test/tmp/geckodriver"),
    log: "error",
    spawnOpts: { stdio: ["ignore", "pipe", "pipe"] },
  });
  let driverOutput = "";
  driver.stdout.on("data", chunk => { driverOutput += chunk; });
  driver.stderr.on("data", chunk => { driverOutput += chunk; });
  let sessionId = "";
  let passed = false;

  async function request(path, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || payload.value?.error) {
      throw new Error(`${method} ${path}: ${JSON.stringify(payload)}`);
    }
    return payload.value;
  }

  async function waitForDriver() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        if ((await request("/status")).ready) return;
      } catch {
        // The process has not opened its HTTP port yet.
      }
      await sleep(100);
    }
    throw new Error("geckodriver did not start.");
  }

  async function setContext(context) {
    await request(`/session/${sessionId}/moz/context`, "POST", { context });
  }

  async function execute(script, args = [], asynchronous = false) {
    return request(
      `/session/${sessionId}/execute/${asynchronous ? "async" : "sync"}`,
      "POST",
      { script, args },
    );
  }

  async function navigateInitial(path) {
    await setContext("chrome");
    let details = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      details = await execute(`
        const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
        const policy = ExtensionParent.WebExtensionPolicy.getByID("hachidori@bee-san");
        return {
          active: policy?.active === true,
          backgroundRunning: ExtensionParent.DebugUtils.isBackgroundScriptRunning("hachidori@bee-san"),
          manifestWarnings: ExtensionParent.DebugUtils.getExtensionManifestWarnings("hachidori@bee-san"),
          url: policy?.getURL(arguments[0]),
        };
      `, [path]);
      if (details.active && details.url) break;
      await sleep(100);
    }
    assert.equal(details.active, true);
    assert.notEqual(details.backgroundRunning, false);
    assert.deepEqual(details.manifestWarnings, []);
    assert.match(details.url, /^moz-extension:\/\/[^/]+\/settings\.html$/u);
    await execute(`
      const windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
      const securityManager = Cc["@mozilla.org/scriptsecuritymanager;1"].getService(Ci.nsIScriptSecurityManager);
      const io = Cc["@mozilla.org/network/io-service;1"].getService(Ci.nsIIOService);
      const browserWindow = windowMediator.getMostRecentWindow("navigator:browser");
      browserWindow.gBrowser.selectedBrowser.loadURI(io.newURI(arguments[0]), {
        triggeringPrincipal: securityManager.getSystemPrincipal(),
      });
    `, [details.url]);
    await setContext("content");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const url = await request(`/session/${sessionId}/url`);
      if (url === details.url) {
        const state = await execute("return document.readyState;");
        if (state === "complete") return details.url;
      }
      await sleep(100);
    }
    throw new Error(`Firefox did not load ${path}.`);
  }

  async function navigate(path) {
    await execute("location.href = browser.runtime.getURL(arguments[0]);", [path]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const url = await request(`/session/${sessionId}/url`);
      if (url.endsWith(`/${path}`) && await execute("return document.readyState;") === "complete") return url;
      await sleep(100);
    }
    throw new Error(`Firefox did not navigate to ${path}.`);
  }

  async function sendRuntime(message) {
    const result = await execute(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage(arguments[0]).then(
        value => done({ transportOk: true, value }),
        error => done({ transportOk: false, error: String(error) }),
      );
    `, [message], true);
    if (!result.transportOk) throw new Error(result.error);
    return result.value;
  }

  async function engineStatus(requestId) {
    return sendRuntime({ target: "hoshidicts-offscreen", type: "hd_status", requestId });
  }

  try {
    await waitForDriver();
    const session = await request("/session", "POST", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          "moz:firefoxOptions": {
            binary: FIREFOX,
            args: ["-headless", "-remote-allow-system-access"],
            prefs: {
              "browser.shell.checkDefaultBrowser": false,
              "browser.startup.page": 0,
              "xpinstall.signatures.required": false,
            },
          },
        },
      },
    });
    sessionId = session.sessionId;
    assert.ok(Number(session.capabilities.browserVersion.split(".")[0]) >= 153);
    await request(`/session/${sessionId}/timeouts`, "POST", {
      implicit: 0,
      pageLoad: 30_000,
      script: 120_000,
    });
    assert.equal(
      await request(`/session/${sessionId}/moz/addon/install`, "POST", {
        path: extension,
        temporary: true,
      }),
      "hachidori@bee-san",
    );

    const settingsUrl = await navigateInitial("settings.html");
    let host = null;
    let engine = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      host = await sendRuntime({ target: "hachidori-firefox-host", type: "hd_firefox_host_status" });
      engine = await engineStatus(`firefox-ready-${attempt}`);
      if (host?.ready && engine?.ready && !engine.loading) break;
      await sleep(100);
    }
    assert.equal(host?.ready, true);
    assert.equal(host.extensionId, "hachidori@bee-san");
    assert.equal(host.details.instanceId, host.instanceId);
    assert.match(host.instanceId, /^[0-9a-f-]{36}$/u);
    assert.equal(host.backgroundUrl, new URL("firefox-background.html", settingsUrl).href);
    assert.equal(host.offscreenUrl, new URL("offscreen.html", settingsUrl).href);
    assert.equal(engine?.ready, true);
    assert.ok(["idbfs", "opfs"].includes(engine.storageBackend));
    assert.equal(engine.threaded, engine.storageBackend === "opfs");

    const settings = await execute(`
      const mediaOption = document.querySelector('#settings-section option[value="media"]');
      const mediaNavigation = document.querySelector('.settings-nav a[href="#media"]').closest(".nav-item");
      return {
        mediaSectionUnavailable: document.getElementById("media").dataset.settingsUnavailable,
        mediaSectionHidden: document.getElementById("media").hidden,
        mediaNavigationHidden: mediaNavigation.hidden,
        mediaOptionHidden: mediaOption.hidden,
        mediaOptionDisabled: mediaOption.disabled,
        audioHelpVisible: !document.getElementById("audio-mining-help").hidden,
        audioHelp: document.getElementById("audio-mining-help").textContent.trim(),
      };
    `);
    assert.deepEqual(settings, {
      mediaSectionUnavailable: "true",
      mediaSectionHidden: true,
      mediaNavigationHidden: true,
      mediaOptionHidden: true,
      mediaOptionDisabled: true,
      audioHelpVisible: true,
      audioHelp:
        "Firefox can play browser speech, but Hachidori does not record it into Anki. Add a downloadable pronunciation source to fill {audio} fields.",
    });

    const capture = await sendRuntime({
      target: "hachidori-capture",
      type: "hd_capture_status",
      requestId: "firefox-capture-closed",
    });
    assert.equal(capture.ok, false);
    assert.match(capture.error, /unavailable in Firefox/u);

    const imported = await execute(`
      const done = arguments[arguments.length - 1];
      const binary = atob(arguments[0]);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      browser.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_import",
        requestId: "firefox-fixture-import",
        blobUrl,
        fileName: "hachidori-fixture.zip",
      }).then(
        value => { URL.revokeObjectURL(blobUrl); done(value); },
        error => { URL.revokeObjectURL(blobUrl); done({ ok: false, error: String(error) }); },
      );
    `, [fixture], true);
    assert.equal(imported.ok, true, imported.error);
    assert.equal(imported.report?.success, true, imported.report?.error);
    assert.equal(imported.report?.title, "hachidori-fixture");

    const lookup = await sendRuntime({
      target: "hoshidicts-offscreen",
      type: "hd_lookup",
      requestId: "firefox-fixture-lookup",
      text: "食べました",
      maxResults: 32,
      scanLength: 16,
    });
    assert.equal(lookup.ok, true, lookup.error);
    assert.ok(lookup.results.some(result => result.term?.expression === "食べる"));

    const beforeIdle = await engineStatus("firefox-before-idle");
    await sleep(IDLE_MS);
    const hostAfterIdle = await sendRuntime({
      target: "hachidori-firefox-host",
      type: "hd_firefox_host_status",
    });
    const afterIdle = await engineStatus("firefox-after-idle");
    assert.equal(hostAfterIdle.ready, true);
    assert.equal(hostAfterIdle.instanceId, host.instanceId);
    assert.equal(afterIdle.ready, true);
    assert.equal(afterIdle.generation, beforeIdle.generation);
    assert.equal(afterIdle.storageBackend, beforeIdle.storageBackend);

    const toolbarUrl = await navigate("toolbar.html");
    const toolbar = await execute(`
      const record = document.getElementById("record-screen");
      return { hidden: record.hidden, disabled: record.disabled };
    `);
    assert.deepEqual(toolbar, { hidden: true, disabled: true });

    console.log(
      `Firefox ${session.capabilities.browserVersion}: temporary install from ${extension},`
        + ` ${engine.storageBackend} import/lookup,`
        + ` ${IDLE_MS} ms idle continuity, capture fail-closed, and hidden media UI passed.`
        + ` Settings: ${settingsUrl}; toolbar: ${toolbarUrl}`,
    );
    passed = true;
  } finally {
    if (sessionId) await request(`/session/${sessionId}`, "DELETE").catch(() => {});
    driver.kill("SIGTERM");
    if (driver.exitCode === null) await new Promise(resolveExit => driver.once("exit", resolveExit));
    if (!passed && driverOutput.trim()) console.error(driverOutput.trim());
  }
}

await main();
