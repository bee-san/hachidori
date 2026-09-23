// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { prepareFirefoxExtension } from "../scripts/prepare-firefox.mjs";
import { AnkiConnectError, answerAnkiConnect } from "./anki-connect-fake.mjs";

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

// One loopback server stands in for AnkiConnect and for a downloadable
// pronunciation source, so the Firefox background page and hidden engine iframe
// prove their outbound network paths without a real Anki or the internet.
function wavBytes(seconds = 0.05, rate = 8000) {
  const frames = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(index / 4) * 8000), 44 + index * 2);
  }
  return buffer;
}

async function startFixtureServer() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const record = { method: request.method, url: request.url, origin: request.headers.origin ?? null, body };
      requests.push(record);
      if (request.method === "POST" && request.url === "/") {
        answerAnkiConnect(JSON.parse(body), (action, params) => {
          record.actions = [...(record.actions ?? []), action];
          if (action === "deckNames") return ["Default", "Mining"];
          if (action === "modelNames") return ["Basic"];
          if (action === "modelFieldNames" && params.modelName === "Basic") return ["Front", "Back"];
          // The duplicate index may refresh as soon as a note type is configured.
          if (action === "findNotes") return [];
          throw new AnkiConnectError(`unexpected ${action}`);
        }).then(reply => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(reply));
        }, error => {
          response.writeHead(500);
          response.end(String(error));
        });
        return;
      }
      if (request.method === "GET" && request.url === "/page") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><meta charset=utf-8><title>Firefox smoke page</title><p lang=ja>食べました。</p>");
        return;
      }
      if (request.method === "GET" && request.url.startsWith("/audio/")) {
        const audio = wavBytes();
        response.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length });
        response.end(audio);
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  };
}

async function main() {
  const fixtureServer = await startFixtureServer();
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

  // Tab URLs as the browser sees them: extension pages hide their URL from
  // tabs.query, and about: pages opened by Firefox itself are invisible to it.
  async function browserTabUrls() {
    await setContext("chrome");
    try {
      return await execute(`
        const windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
        return [...windowMediator.getMostRecentWindow("navigator:browser").gBrowser.tabs]
          .map(tab => tab.linkedBrowser.currentURI.spec);
      `);
    } finally {
      await setContext("content");
    }
  }

  async function closeBrowserTabs(pattern) {
    await setContext("chrome");
    try {
      await execute(`
        const windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
        const { gBrowser } = windowMediator.getMostRecentWindow("navigator:browser");
        const pattern = new RegExp(arguments[0], "u");
        for (const tab of [...gBrowser.tabs]) {
          if (pattern.test(tab.linkedBrowser.currentURI.spec)) gBrowser.removeTab(tab);
        }
      `, [pattern.source]);
    } finally {
      await setContext("content");
    }
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

    // First run: runtime.onInstalled reaches the persistent background page only
    // if background.js registered its listener during synchronous evaluation.
    // The handler seeds setup state and opens the startup reader exactly once.
    const startupTab = /^moz-extension:\/\/[^/]+\/startup\.html$/u;
    let openTabs = [];
    for (let attempt = 0; attempt < 100 && !openTabs.some(url => startupTab.test(url)); attempt += 1) {
      await sleep(100);
      openTabs = await browserTabUrls();
    }
    assert.ok(openTabs.some(url => startupTab.test(url)), `first-run setup did not open startup.html: ${JSON.stringify(openTabs)}`);
    await closeBrowserTabs(startupTab);

    const settingsUrl = await navigateInitial("settings.html");
    const seeded = await execute(`
      const done = arguments[arguments.length - 1];
      browser.storage.local.get("setupState").then(stored => done(stored.setupState?.stage ?? null), error => done(String(error)));
    `, [], true);
    assert.equal(typeof seeded, "string", `first-run setup state was not seeded: ${JSON.stringify(seeded)}`);
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

    // Chrome-only surfaces are hidden, not merely disabled, and Chrome-only
    // APIs are absent from the package rather than failing at call time.
    const parity = await execute(`
      const customJavascript = document.getElementById("custom-javascript");
      const localFile = document.getElementById("settings-local-file-access");
      return {
        customJavascriptHidden: customJavascript.hidden,
        customJavascriptUnavailable: customJavascript.dataset.settingsUnavailable,
        customCssPresent: document.getElementById("opt-custom-popup-css") !== null,
        shortcutsButton: document.getElementById("browser-shortcuts-open").textContent.trim(),
        localFileOpenButton: document.getElementById("local-file-open"),
        localFileInstructionHidden: document.getElementById("local-file-instruction").hidden,
        localFileInstruction: document.getElementById("local-file-instruction").textContent,
        localFileHidden: localFile.hidden,
        downloadsApi: typeof browser.downloads?.download,
        userScriptsApi: typeof browser.userScripts,
        extensionProtocol: new URL(browser.runtime.getURL("")).protocol,
      };
    `);
    assert.deepEqual(parity, {
      customJavascriptHidden: true,
      customJavascriptUnavailable: "true",
      customCssPresent: true,
      shortcutsButton: "Change in Firefox",
      // Firefox 153+ gates file:// behind its own permission and refuses
      // tabs.create("about:addons"), so Settings shows the manual path instead.
      localFileOpenButton: null,
      localFileInstructionHidden: false,
      localFileInstruction: "Open about:addons, choose Hachidori, open the Permissions and data tab,"
        + " turn on “Access local files on your computer”, then return to this tab.",
      localFileHidden: false,
      downloadsApi: "function",
      userScriptsApi: "undefined",
      extensionProtocol: "moz-extension:",
    });

    // Firefox 128+ accepts a MAIN-world registration through browser.scripting
    // in MV2, so the Google Docs flag needs no xray fallback: toggling it in
    // Settings registers and unregisters the flag script.
    await execute(`location.hash = "#advanced";`);
    const docsScripts = () => execute(`
      const done = arguments[arguments.length - 1];
      browser.scripting.getRegisteredContentScripts({ ids: ["hachidori-google-docs"] }).then(done);
    `, [], true);
    const docsRegistered = async (expected) => {
      let scripts = await docsScripts();
      for (let attempt = 0; attempt < 50 && (scripts.length > 0) !== expected; attempt += 1) {
        await sleep(100);
        scripts = await docsScripts();
      }
      return scripts;
    };
    assert.deepEqual(await docsScripts(), []);
    await execute(`document.getElementById("opt-experimental-googleDocs").click();`);
    const docsOn = await docsRegistered(true);
    assert.equal(docsOn.length, 1, "the Google Docs flag script was not registered");
    assert.deepEqual({ matches: docsOn[0].matches, runAt: docsOn[0].runAt, world: docsOn[0].world, allFrames: docsOn[0].allFrames },
      { matches: ["*://docs.google.com/*"], runAt: "document_start", world: "MAIN", allFrames: true });
    assert.ok(docsOn[0].js.some(path => path.endsWith("google-docs-flag.js")), JSON.stringify(docsOn[0].js));
    await execute(`document.getElementById("opt-experimental-googleDocs").click();`);
    assert.deepEqual(await docsRegistered(false), []);

    // The shortcuts button must reach Firefox's Manage Extension Shortcuts
    // view, which lives in about:addons and is only reachable through
    // commands.openShortcutSettings(). Its controller mounts with the section.
    await execute(`location.hash = "#keybinds";`);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await execute(`return document.getElementById("browser-shortcut-list").childElementCount > 0;`)) break;
      await sleep(100);
    }
    await execute(`document.getElementById("browser-shortcuts-open").click();`);
    let tabsAfterShortcuts = [];
    for (let attempt = 0; attempt < 50 && !tabsAfterShortcuts.some(url => url.startsWith("about:addons")); attempt += 1) {
      await sleep(100);
      tabsAfterShortcuts = await browserTabUrls();
    }
    assert.ok(
      tabsAfterShortcuts.some(url => url.startsWith("about:addons")),
      `Change in Firefox did not open the shortcuts manager: ${JSON.stringify(tabsAfterShortcuts)}`,
    );
    await closeBrowserTabs(/^about:addons/u);

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

    // Anki: point the saved configuration at the loopback AnkiConnect and ask
    // the background page for mining readiness. The request must leave the
    // extension with its own moz-extension:// Origin.
    const written = await execute(`
      const done = arguments[arguments.length - 1];
      const [ankiUrl, audioUrl] = arguments;
      browser.storage.local.get("options").then(({ options }) => {
        const template = value => ({ value, overwriteMode: "overwrite" });
        return browser.runtime.sendMessage({
          target: "hoshidicts-worker", type: "hd_options_write", requestId: "firefox-options",
          baseRevision: options?.revision ?? 0,
          options: {
            audioSources: [{ id: "firefox-smoke-audio", type: "custom", enabled: true, url: audioUrl, voice: "" }],
            anki: { ...HDReaderOptions.normaliseOptions({}).anki, url: ankiUrl, model: "Basic", deck: "Default",
              fieldTemplates: { Front: template("{expression}"), Back: template("{glossary}") } },
          },
        });
      }).then(done, error => done({ ok: false, error: String(error) }));
    `, [fixtureServer.origin, `${fixtureServer.origin}/audio/{term}`], true);
    assert.equal(written.ok, true, written.error);
    const ankiStatus = await sendRuntime({ target: "hachidori-anki", type: "hd_anki_status", requestId: "firefox-anki-status" });
    assert.equal(ankiStatus.ok, true, ankiStatus.error);
    assert.equal(ankiStatus.available, true, ankiStatus.error);
    assert.match(ankiStatus.configKey, /^[0-9a-f-]+$/u);
    const ankiRequests = fixtureServer.requests.filter(record => record.url === "/");
    const ankiActions = new Set(ankiRequests.flatMap(record => record.actions ?? []));
    for (const action of ["deckNames", "modelNames", "modelFieldNames"]) {
      assert.ok(ankiActions.has(action), `${action} reached AnkiConnect: ${JSON.stringify([...ankiActions])}`);
    }
    assert.ok(ankiRequests.every(record => record.origin?.startsWith("moz-extension://")),
      `AnkiConnect requests carry the extension origin: ${JSON.stringify(ankiRequests.map(record => record.origin))}`);

    // Pronunciation: the hidden iframe fetches a downloadable source and hands
    // it to a media element. A runner without an audio output device cannot
    // play it; that exact decode/playback error is the only accepted failure.
    const audio = await sendRuntime({
      target: "hachidori-audio",
      type: "hd_audio_test",
      requestId: "firefox-audio-test",
      source: { id: "firefox-smoke-audio", type: "custom", enabled: true, url: `${fixtureServer.origin}/audio/{term}`, voice: "" },
    });
    assert.ok(fixtureServer.requests.some(record => record.url.startsWith("/audio/")), "the audio file was fetched");
    const audioOutcome = audio.ok && audio.status === "success" ? "played" : `not played (${audio.error})`;
    if (audioOutcome !== "played") {
      assert.match(audio.error ?? "", /could not be decoded or played/u, JSON.stringify(audio));
    }

    // Backup: export from the engine, then prepare and restore that archive.
    const exported = await sendRuntime({ target: "hoshidicts-offscreen", type: "hd_backup_export", requestId: "firefox-backup-export" });
    assert.equal(exported.ok, true, exported.error);
    assert.match(exported.blobUrl, /^blob:moz-extension:\/\//u);
    const prepared = await sendRuntime({
      target: "hoshidicts-offscreen", type: "hd_backup_prepare", requestId: "firefox-backup-prepare",
      blobUrl: exported.blobUrl, token: crypto.randomUUID(),
    });
    assert.equal(prepared.ok, true, prepared.error);
    const restored = await sendRuntime({
      target: "hoshidicts-offscreen", type: "hd_backup_restore", requestId: "firefox-backup-restore", token: prepared.token,
    });
    assert.equal(restored.ok, true, restored.error);
    const released = await sendRuntime({
      target: "hoshidicts-offscreen", type: "hd_backup_release", requestId: "firefox-backup-release", blobUrl: exported.blobUrl,
    });
    assert.equal(released.ok, true, released.error);
    const afterRestore = await sendRuntime({
      target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "firefox-after-restore",
      text: "食べました", maxResults: 32, scanLength: 16,
    });
    assert.equal(afterRestore.ok, true, afterRestore.error);
    assert.ok(afterRestore.results.some(result => result.term?.expression === "食べる"), "the restored dictionary answers");

    // Sharing: the host/client state machine answers from the background page.
    const sharing = await sendRuntime({ target: "hachidori-sharing", type: "hd_sharing_status", requestId: "firefox-sharing" });
    assert.equal(sharing.ok, true, sharing.error);
    assert.equal(typeof sharing.sharing?.enabled, "boolean", JSON.stringify(sharing));
    assert.equal(sharing.sharing.client.address, null, "a fresh install is not linked");

    // Content scripts on an ordinary page: the shared Anki script answers the
    // screenshot document probe, and the Chrome-only capture script is absent.
    const contentScripts = await execute(`
      const done = arguments[arguments.length - 1];
      (async () => {
        const tab = await browser.tabs.create({ url: arguments[0], active: false });
        const ask = target => browser.tabs.sendMessage(tab.id, { target, type: target === "hachidori-anki-content" ? "hd_anki_document" : "hd_capture_recover" });
        let anki = null;
        for (let attempt = 0; attempt < 100 && anki?.present !== true; attempt += 1) {
          anki = await ask("hachidori-anki-content").catch(() => null);
          if (anki?.present !== true) await new Promise(resolveWait => setTimeout(resolveWait, 100));
        }
        const capture = await ask("hachidori-capture-content").then(reply => ({ reply }), error => ({ error: String(error) }));
        await browser.tabs.remove(tab.id);
        return { anki, capture };
      })().then(done, error => done({ error: String(error) }));
    `, [`${fixtureServer.origin}/page`], true);
    assert.deepEqual(contentScripts.anki, { present: true }, JSON.stringify(contentScripts));
    assert.equal(contentScripts.capture.reply ?? null, null, `the capture content script must not be injected in Firefox: ${JSON.stringify(contentScripts.capture)}`);

    // Screenshots: the packaged startup reader is the one extension page that
    // may capture itself; Firefox resolves its tab from the sender instead of
    // Chrome's getContexts().
    await navigate("startup.html");
    const screenshot = await sendRuntime({
      target: "hachidori-anki", type: "hd_anki_screenshot", requestId: "firefox-screenshot", request: {},
    });
    assert.equal(screenshot.ok, true, screenshot.error);
    assert.match(screenshot.filename ?? "", /^hachidori-screenshot-[0-9a-f-]{36}\.jpg$/u);
    const discarded = await sendRuntime({
      target: "hachidori-anki", type: "hd_anki_screenshot_discard", requestId: "firefox-screenshot-discard",
      request: { token: screenshot.token },
    });
    assert.equal(discarded.ok, true, discarded.error);
    await navigate("settings.html");

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
      `Firefox ${session.capabilities.browserVersion}: temporary install from ${extension}, first-run setup,`
        + ` ${engine.storageBackend} import/lookup,`
        + ` ${IDLE_MS} ms idle continuity, capture fail-closed, hidden media and custom-JavaScript UI, Google Docs flag script registration,`
        + ` shortcuts manager, local-file instructions,`
        + ` Anki status, pronunciation fetched and ${audioOutcome}, backup round-trip, sharing status and screenshot passed.`
        + ` Settings: ${settingsUrl}; toolbar: ${toolbarUrl}`,
    );
    passed = true;
  } finally {
    await fixtureServer.close();
    if (sessionId) await request(`/session/${sessionId}`, "DELETE").catch(() => {});
    driver.kill("SIGTERM");
    if (driver.exitCode === null) await new Promise(resolveExit => driver.once("exit", resolveExit));
    if (!passed && driverOutput.trim()) console.error(driverOutput.trim());
  }
}

await main();
