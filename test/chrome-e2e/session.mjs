/*
 * The browser session every step shares, and its first steps.
 *
 * The real-Chrome suite is one scenario in one browser profile. Every file in
 * test/chrome-e2e/ imports the file before it, so a file run on its own runs the
 * steps before it first. This one launches Chrome with the unpacked extension and
 * serves the reading pages; its after hook closes them and reports every check.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { after, describe } from "node:test";
import { pathToFileURL } from "node:url";
import {
  RECOMMENDED_DICTIONARIES as RECOMMENDED_CATALOGUE,
} from "../../extension/recommended-dictionaries.js";
import { answerAnkiConnect } from "../anki-connect-fake.mjs";
import { buildRecommendedZip, GENERIC_KANJI_TITLE } from "../make-fixture.mjs";
import {
  check,
  diagnostics,
  EXTENSION,
  failed,
  fatal,
  HERE,
  HIGHLIGHT_NAME,
  PROFILE,
  report,
  step,
} from "./harness.mjs";

const FIXTURE = resolve(HERE, "fixtures/hachidori-fixture.zip");
const GENERIC_KANJI_FIXTURE = resolve(HERE, "fixtures/hachidori-generic-kanji-fixture.zip");
const GENERIC_KANJI_SELECTION = { title: GENERIC_KANJI_TITLE, kind: "term" };
const FIXTURE_KANJI_SELECTION = { title: "hachidori-fixture", kind: "kanji" };
const FIXTURE_TERM_SELECTION = { title: "hachidori-fixture", kind: "term" };
const GENERIC_KANJI_SELECTION_VALUE = JSON.stringify(GENERIC_KANJI_SELECTION);
const FIXTURE_KANJI_SELECTION_VALUE = JSON.stringify(FIXTURE_KANJI_SELECTION);
const FIXTURE_TERM_SELECTION_VALUE = JSON.stringify(FIXTURE_TERM_SELECTION);
const FIXTURE_ID = "921c9971654f69cd1ad6d0e2f89b990c";
const GENERIC_KANJI_ID = "6b513edb59015829bb5bb3e91e41d357";
const FIXTURE_ALIAS = "Fixture Alias";
const MANAGED_INDEX_URL = "https://example.test/hachidori-fixture-index.json";
const MANAGED_DOWNLOAD_URL = "https://example.test/hachidori-fixture.zip";
const GENERIC_MANAGED_INDEX_URL = "https://example.test/generic-kanji-index.json";
const GENERIC_MANAGED_DOWNLOAD_URL = "https://example.test/generic-kanji.zip";
const MANAGED_UPDATE_ALARM = "hachidori-managed-dictionary-updates";
const CUSTOM_SETTINGS_SOURCE = "# Personal Japanese notes\n\u6c17\u306b\u306a\u308b, \u304d\u306b\u306a\u308b, to catch one's attention\n";
const CUSTOM_TERM_NOTE_DEFINITION = "to eat — personal usage note";
const CUSTOM_KANJI_NOTE_DEFINITION = "food; eating — kanji note";
const GENERATION_ROOT_PATTERN = /^\/dicts\/\.hdw-generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");

function ownedGenerationRoot(path, title) {
  const suffix = `/${title}`;
  const root = typeof path === "string" && path.endsWith(suffix)
    ? path.slice(0, -suffix.length)
    : "";
  return GENERATION_ROOT_PATTERN.test(root) ? root : "";
}

function opfsPath(path) {
  return path.slice("/dicts/".length);
}

function generationExists(paths, dictionaryPath) {
  const relative = opfsPath(dictionaryPath);
  return [".hoshidicts_5", ".hoshidicts_6", ".hoshidicts_3", ".hoshidicts_4"]
    .some((marker) => paths.includes(`${relative}/${marker}`));
}

function generationIsAbsent(paths, generationRoot) {
  const relative = opfsPath(generationRoot);
  return !paths.some((path) => path === relative || path.startsWith(`${relative}/`));
}

async function waitForGenerationAbsent(page, generationRoot) {
  const directory = opfsPath(generationRoot);
  return page.waitForFunction(async (name) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getDirectoryHandle(name);
      return false;
    } catch (error) {
      return error?.name === "NotFoundError";
    }
  }, { timeout: 15_000, polling: 100 }, directory).then(() => true).catch(() => false);
}

function cachedChrome() {
  const root = resolve(CACHE, "hachidori-browsers/chrome");
  if (!existsSync(root)) return "";
  const suffixes = process.platform === "linux"
    ? [["chrome-linux64", "chrome"]]
    : process.platform === "darwin"
      ? [
          ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
          ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ]
      : process.platform === "win32"
        ? [["chrome-win64", "chrome.exe"], ["chrome-win32", "chrome.exe"]]
        : [];
  const builds = readdirSync(root).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }));
  for (const build of builds) {
    for (const suffix of suffixes) {
      const candidate = resolve(root, build, ...suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function installedChrome() {
  const candidates = process.platform === "linux"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [resolve(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe")]
        : [];
  return candidates.find(existsSync) || "";
}

const CHROME = process.env.HACHIDORI_CHROME
  || process.env.CHROME_BIN
  || cachedChrome()
  || installedChrome();
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");

const RECOMMENDED_FIXTURE_METADATA = {
  jitendex: {
    title: "Jitendex.org [2026-08-11]",
    revision: "2026.08.11.0",
    capabilities: ["term", "media"],
  },
  jmnedict: {
    title: "JMnedict [2026-09-04]",
    revision: "JMnedict.2026-09-04",
    capabilities: ["term"],
  },
  "bees-ultimate-kanji-dictionary": {
    title: "Bee's Ultimate Kanji Dictionary",
    revision: "2026.09.02",
    capabilities: ["term", "freq", "media"],
  },
  jiten: { title: "Jiten", revision: "Jiten 26-09-02", capabilities: ["freq"] },
  "bees-ultimate-grammar-dictionary": {
    title: "Bee's Ultimate Grammar Dictionary",
    revision: "2026.09.10",
    capabilities: ["term"],
  },
};
const RECOMMENDED_DICTIONARIES = RECOMMENDED_CATALOGUE.map((entry) => ({
  ...entry,
  ...RECOMMENDED_FIXTURE_METADATA[entry.sourceId],
}));
const WORDS_PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>hachidori word highlights</title>
<style>
  body { font: 32px/2 serif; padding: 40px; background: #ffffff; color: #1a1a1a; }
  #far { margin-top: 4000px; }
</style></head>
<body>
  <p id="line"><span id="words-verb"><ruby>食<rt>た</rt></ruby>べたかった</span>。<span>漢字</span>を読む</p>
  <p id="far">ありがとう</p>
</body></html>`;

async function interceptFetches(target, routes, label) {
  const session = await target.createCDPSession();
  session.on("Fetch.requestPaused", (event) => {
    void (async () => {
      const route = routes.get(event.request.url);
      if (!route) {
        await session.send("Fetch.continueRequest", { requestId: event.requestId });
        return;
      }
      route.requests += 1;
      // A route may also refuse the connection, which is how a local service
      // this suite does not own is kept out of a check's outcome.
      if (route.fail) {
        await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: route.fail });
        return;
      }
      const response = route.respond ? await route.respond(event.request) : route;
      const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
      await session.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: response.status,
        responseHeaders: [
          { name: "Access-Control-Allow-Origin", value: "*" },
          { name: "Content-Type", value: response.contentType },
          { name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
        body: body.toString("base64"),
      });
    })().catch(async (error) => {
      diagnostics.push(`[${label} mock] ${error?.stack ?? error}`);
      await session.send("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "Failed",
      }).catch(() => {});
    });
  });
  await session.send("Fetch.enable", {
    patterns: [...routes.keys()].map((urlPattern) => ({ urlPattern, requestStage: "Request" })),
  });
  return session;
}

async function waitForCdpTargetGone(session, targetId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { targetInfos } = await session.send("Target.getTargets");
    if (!targetInfos.some((target) => target.targetId === targetId)) {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

function waitForRunningServiceWorker(session, scriptUrl, timeout = 30_000) {
  return new Promise((resolveWorker) => {
    const timer = setTimeout(() => {
      session.off("ServiceWorker.workerVersionUpdated", onVersionUpdated);
      resolveWorker(null);
    }, timeout);
    const onVersionUpdated = ({ versions }) => {
      const worker = versions.find((version) =>
        version.scriptURL === scriptUrl && version.runningStatus === "running");
      if (worker === undefined) {
        return;
      }
      clearTimeout(timer);
      session.off("ServiceWorker.workerVersionUpdated", onVersionUpdated);
      resolveWorker(worker);
    };
    session.on("ServiceWorker.workerVersionUpdated", onVersionUpdated);
  });
}

async function activeExtensionWorker(browser, page, label, timeout = 10_000) {
  const scriptUrl = await page.evaluate(() => chrome.runtime.getURL("background.js"));
  const serviceWorkerCdp = await page.createCDPSession();
  try {
    await serviceWorkerCdp.send("ServiceWorker.enable");
    await serviceWorkerCdp.send("ServiceWorker.startWorker", {
      scopeURL: new URL(".", scriptUrl).href,
    });
  } finally {
    await serviceWorkerCdp.detach();
  }
  await page.evaluate(() => {
    void chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_state_read",
      requestId: "e2e-wake-service-worker",
    }).catch(() => {});
  });
  const deadline = Date.now() + timeout;
  const bounded = async (promise, milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        promise.catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  while (Date.now() < deadline) {
    const targets = browser.targets().filter(
      (candidate) => candidate.type() === "service_worker" && candidate.url() === scriptUrl,
    ).reverse();
    for (const target of targets) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const session = await bounded(target.createCDPSession(), Math.min(1_000, remaining));
      if (session === null) continue;
      const responsive = await bounded((async () => {
        await session.send("Runtime.enable");
        const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
          expression: "true",
          awaitPromise: true,
          returnByValue: true,
        });
        return exceptionDetails === undefined && result.value === true;
      })(), Math.min(1_000, deadline - Date.now()));
      if (responsive !== true) {
        await session.detach().catch(() => {});
        continue;
      }
      return {
        async evaluate(pageFunction, ...args) {
          const serializedArgs = args.map((argument) => {
            if (argument === undefined) return "undefined";
            const value = JSON.stringify(argument);
            if (value === undefined) throw new Error(`${label} could not serialize an evaluation argument`);
            return value;
          }).join(",");
          const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
            expression: `(${pageFunction.toString()})(${serializedArgs})`,
            awaitPromise: true,
            returnByValue: true,
          });
          if (exceptionDetails !== undefined) {
            throw new Error(exceptionDetails.exception?.description
              ?? exceptionDetails.text ?? `${label} service-worker evaluation failed`);
          }
          return result.value;
        },
        detach() {
          return session.detach().catch(() => {});
        },
      };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`${label} service-worker target did not become active`);
}

async function listOpfsPaths(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const paths = [];
    const walk = async (directory, prefix) => {
      for await (const [name, handle] of directory.entries()) {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        paths.push(path);
        if (handle.kind === "directory") await walk(handle, path);
      }
    };
    await walk(root, "");
    return paths.sort();
  });
}

// The ordinary-webpage fixture. Startup exercises its narrow internal-page
// exception separately, and the saved-page check serves this prose from file://
// after verifying Chrome's per-extension file-access switch.
const PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>hachidori e2e</title>
<style>
  body { font: 32px/2 serif; padding: 80px; }
  span { display: inline-block; }
</style></head>
<body>
  <p><span id="verb">食べたかった</span></p>
  <p><span id="duplicate">食食</span></p>
  <p><span id="kanjiword">漢字</span></p>
  <p><span id="latin">hello world</span></p>
  <p><ruby id="rubyword">漢字<rt>かんじ</rt></ruby></p>
</body></html>`;

async function installMediaArchive(page, archive) {
  return page.evaluate(async (base64) => {
    const blobUrl = URL.createObjectURL(new Blob([
      Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
    ], { type: "application/zip" }));
    try {
      const reply = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen", type: "hd_import", requestId: "owned-media-import",
        blobUrl, fileName: "owned-media.zip",
      });
      if (!reply.ok) throw new Error(reply.error);
      return reply.generation;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, archive.toString("base64"));
}

async function installMediaReplyProbe(browser, page) {
  const worker = await activeExtensionWorker(browser, page, "media reply probe");
  // Let the real offscreen/WASM operation finish, then delay only delivery of
  // its reply. Other messages and the mutation queue remain production paths.
  await worker.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    const probe = { original, held: [], heldLookups: [], lookups: [], requests: [], holdNextLookup: false,
      holdNext: true, holdAll: false, failNext: false,
      count: 0, active: 0, maxActive: 0 };
    globalThis.__ownedMediaProbe = probe;
    chrome.runtime.sendMessage = function (message, ...args) {
      const response = original.call(this, message, ...args);
      if (message.relayed && message.type === "hd_lookup") probe.lookups.push(message);
      if (message.relayed && ["hd_lookup", "hd_lookup_dictionary", "hd_kanji", "hd_media", "hd_styles"].includes(message.type)) {
        probe.requests.push(message);
      }
      if (message.relayed && ["hd_lookup", "hd_lookup_dictionary", "hd_kanji"].includes(message.type) && probe.holdNextLookup) {
        probe.holdNextLookup = false;
        return response.then(reply => new Promise(resolveReply => {
          probe.heldLookups.push(() => resolveReply(reply));
        }));
      }
      if (!message.relayed || message.type !== "hd_media") return response;
      probe.count += 1;
      probe.active += 1;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      const hold = probe.holdNext || probe.holdAll;
      const fail = probe.failNext;
      probe.holdNext = false;
      probe.failNext = false;
      return response.then((reply) => {
        if (hold) return new Promise((resolveReply) => {
          probe.held.push(() => resolveReply(reply));
        });
        return fail ? { ...reply, ok: false, dataUrl: null, error: "injected transient media failure" } : reply;
      }).finally(() => { probe.active -= 1; });
    };
  });
  return worker;
}

async function restoreMediaReplyProbe(worker) {
  try {
    await worker.evaluate(() => {
      const probe = globalThis.__ownedMediaProbe;
      chrome.runtime.sendMessage = probe.original;
      for (const release of probe.held) release();
      for (const release of probe.heldLookups) release();
      delete globalThis.__ownedMediaProbe;
    });
  } finally {
    await worker.detach?.();
  }
}

async function showSettingsSection(page, id) {
  // Do not foreground the tab here: reader activation tests deliberately keep
  // their popup focused while changing a visible Settings view in another tab.
  await page.evaluate(section => {
    const picker = document.getElementById("settings-section");
    if (picker.checkVisibility()) {
      picker.value = section;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    } else document.querySelector(`.settings-nav a[href="#${section}"], .section-tabs a[href="#${section}"]`).click();
  }, id);
  await page.waitForFunction((sectionId) => {
    const visible = [...document.querySelectorAll("main > section")].filter((section) => !section.hidden);
    // Dictionaries and Reading show their views as tabs under one rail link.
    const allTabs = [...document.querySelectorAll(".section-tabs")];
    const ownTabs = allTabs.find((tabs) => tabs.querySelector(`a[href="#${sectionId}"]`));
    const primaryHash = ownTabs?.querySelector("a").hash ?? `#${sectionId}`;
    const tabContext = allTabs.every((tabs) => (tabs === ownTabs && !tabs.hidden
      ? tabs.querySelector('[aria-current="page"]')?.hash === `#${sectionId}`
      : tabs.hidden));
    return visible.length === 1 && visible[0].id === sectionId
      && document.querySelector('.settings-nav [aria-current="page"]')?.hash === primaryHash
      && tabContext;
  }, {}, id);
}

async function openDictionaryDetails(page, id) {
  await showSettingsSection(page, "dictionaries");
  const selector = `.dict-row[data-dictionary-id="${id}"] .dict-details`;
  if (!await page.$eval(selector, (details) => details.open)) {
    await page.bringToFront();
    await page.click(`${selector} > summary`);
  }
  await page.waitForFunction((detailsSelector) => document.querySelector(detailsSelector)?.open, {}, selector);
}

async function setDictionaryEnabledInSettings(page, title, enabled) {
  await showSettingsSection(page, "dictionaries");
  const started = await page.evaluate(async ({ dictionaryTitle, nextEnabled }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const row = [...document.querySelectorAll("#dict-list .dict-row")].find((candidate) =>
      candidate.querySelector(".dict-display-name")?.placeholder === dictionaryTitle);
    const checkbox = row?.querySelector(".dict-enabled");
    const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.title === dictionaryTitle);
    if (!(checkbox instanceof HTMLInputElement) || !dictionary) {
      return { error: "dictionary row or state was missing" };
    }
    if (checkbox.checked === nextEnabled || dictionary.enabled === nextEnabled) {
      return { error: "dictionary was not in the expected starting state" };
    }
    const baseRevision = dictionaryState.revision;
    checkbox.click();
    return { baseRevision };
  }, { dictionaryTitle: title, nextEnabled: enabled });
  if (!Number.isInteger(started?.baseRevision)) {
    return started;
  }
  const settled = await page.waitForFunction(async ({ baseRevision, dictionaryTitle, nextEnabled }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.title === dictionaryTitle);
    const row = [...document.querySelectorAll("#dict-list .dict-row")].find((candidate) =>
      candidate.querySelector(".dict-display-name")?.placeholder === dictionaryTitle);
    const checkbox = row?.querySelector(".dict-enabled");
    return dictionaryState?.revision > baseRevision
      && dictionary?.enabled === nextEnabled
      && checkbox?.checked === nextEnabled
      && checkbox.disabled === false
      ? { id: dictionary.id, revision: dictionaryState.revision }
      : false;
  }, { timeout: 15_000, polling: 100 }, {
    baseRevision: started.baseRevision,
    dictionaryTitle: title,
    nextEnabled: enabled,
  }).then((handle) => handle.jsonValue()).catch(() => null);
  return { ...started, settled };
}

async function setDictionaryAliasInSettings(page, title, alias) {
  const id = await page.evaluate(async (dictionaryTitle) =>
    (await chrome.storage.local.get("dictionaryState")).dictionaryState.dictionaries
      .find((entry) => entry.title === dictionaryTitle)?.id, title);
  if (!id) return { error: "dictionary state was missing" };
  await openDictionaryDetails(page, id);
  const started = await page.evaluate(async ({ dictionaryTitle, nextAlias }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const row = [...document.querySelectorAll("#dict-list .dict-row")].find((candidate) =>
      candidate.querySelector(".dict-display-name")?.placeholder === dictionaryTitle);
    const input = row?.querySelector(".dict-display-name");
    if (!(input instanceof HTMLInputElement)) {
      return { error: "dictionary row was missing" };
    }
    const baseRevision = dictionaryState.revision;
    input.value = nextAlias;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { baseRevision };
  }, { dictionaryTitle: title, nextAlias: alias });
  if (!Number.isInteger(started?.baseRevision)) {
    return started;
  }
  const settled = await page.waitForFunction(async ({ baseRevision, dictionaryTitle, nextAlias }) => {
    const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
    const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.title === dictionaryTitle);
    const row = [...document.querySelectorAll(".dict-row")].find((entry) => entry.dataset.dictionaryId === dictionary?.id);
    return dictionaryState?.revision > baseRevision && dictionary?.displayName === nextAlias
      && row?.querySelector(".dict-details").open
      && row.querySelector(".dict-display-name").checkVisibility()
      && row.querySelector(".dict-display-name").value === nextAlias
      ? { id: dictionary.id, revision: dictionaryState.revision }
      : false;
  }, { timeout: 15_000, polling: 100 }, {
    baseRevision: started.baseRevision,
    dictionaryTitle: title,
    nextAlias: alias,
  }).then((handle) => handle.jsonValue()).catch(() => null);
  return { ...started, settled };
}

function makeAudioWav() {
  // A genuine one-second PCM clip, decoded and completed by native Chrome.
  const samples = 8000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(i % 2 ? 100 : -100, 44 + i * 2);
  return wav;
}

async function readSettingsControls(settings, ids) {
  return settings.evaluate((names) => Object.fromEntries(names.map((id) => {
    const input = document.getElementById(id);
    return [id, input.type === "checkbox" ? input.checked : input.value];
  })), ids);
}

async function editSettingsControls(settings, values) {
  const section = await settings.evaluate(id => {
    const owner = document.getElementById(id).closest("section");
    return { id: owner.id, hidden: owner.hidden };
  }, Object.keys(values)[0]);
  // Re-clicking the active navigation tab would itself blur a focused preview.
  if (section.hidden) await showSettingsSection(settings, section.id);
  await settings.evaluate((changes) => {
    for (const [id, value] of Object.entries(changes)) {
      const input = document.getElementById(id);
      for (let parent = input.closest("details"); parent; parent = parent.parentElement.closest("details")) parent.open = true;
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, values);
  await settings.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.",
    { polling: 100, timeout: 10_000 });
}

async function updateSettingsControls(settings, values) {
  const current = await readSettingsControls(settings, Object.keys(values));
  const changed = Object.fromEntries(Object.entries(values).filter(([id, value]) => current[id] !== value));
  if (Object.keys(changed).length > 0) await editSettingsControls(settings, changed);
}

async function readLookupStatistics(settings) {
  return settings.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-worker",
    type: "hd_lookup_stats_read",
    term: "食べる",
    reading: "たべる",
  })).catch(error => ({ error: String(error) }));
}

// The word highlighting check's AnkiConnect, served by this suite's own page
// server: the service worker mines through it and the offscreen document's
// index refresh reads it, so no real Anki is involved.
const WORD_HIGHLIGHT_ANKI_PATH = "/anki-connect";
let wordHighlightAnki = null;

async function answerWordHighlightAnki(request, response) {
  let body = "";
  for await (const chunk of request) body += chunk;
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
  try {
    if (!wordHighlightAnki) throw new Error("no word highlighting check is running");
    const reply = await answerAnkiConnect(JSON.parse(body), wordHighlightAnki);
    response.writeHead(200, headers);
    response.end(JSON.stringify(reply));
  } catch (error) {
    diagnostics.push(`[word-highlight anki] ${error?.stack ?? error}`);
    response.writeHead(500, headers);
    response.end(JSON.stringify({ result: null, error: String(error) }));
  }
}

async function readVisualNovelScene(page, sourceSelector) {
  return page.evaluate(async (selector, highlightName) => {
    const scene = document.querySelector(".vn-scene");
    const dialogue = scene?.querySelector(".vn-dialogue");
    const source = document.querySelector(selector);
    if (!scene || !dialogue || !source) return null;
    const imageUrl = getComputedStyle(scene, "::before").backgroundImage.match(/url\(["']?([^"')]+)["']?\)/u)?.[1];
    const image = new Image();
    image.src = imageUrl ?? "";
    await image.decode().catch(() => {});
    const range = document.createRange();
    range.selectNodeContents(source);
    const sourceRects = [...range.getClientRects()];
    const dialogueRect = dialogue.getBoundingClientRect();
    const next = scene.querySelector(".vn-next");
    const nextRect = next?.getBoundingClientRect();
    return {
      backgroundLoaded: Array.from({ length: 6 }, (_, index) =>
        new URL(`assets/preview-background${index === 0 ? "" : `-${index + 1}`}.webp`, location.href).href).includes(imageUrl)
        && image.naturalWidth === 1672 && image.naturalHeight === 672,
      nextVisible: next?.tagName === "BUTTON" && next.type === "button" && next.tabIndex >= 0
        && next.getAttribute("aria-label") === "Next background" && nextRect.width > 0 && nextRect.height > 0
        && next.contains(document.elementFromPoint(nextRect.x + nextRect.width / 2, nextRect.y + nextRect.height / 2)),
      dialogueVisible: dialogueRect.width > 0 && dialogueRect.height > 0
        && getComputedStyle(dialogue).visibility === "visible" && dialogue.querySelector(".vn-speaker")?.textContent.trim().length > 0,
      sourceAccessible: sourceRects.length > 0 && sourceRects.every(rect => rect.width > 0 && rect.height > 0
        && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        && source.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))),
      highlighted: [...(CSS.highlights.get(highlightName) ?? [])]
        .filter(match => source.contains(match.startContainer) && source.contains(match.endContainer))
        .map(match => match.toString()).join(""),
      sourceTop: range.getBoundingClientRect().top,
      dialogueTop: dialogueRect.top,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  }, sourceSelector, HIGHLIGHT_NAME);
}

async function cycleVisualNovelScene(page, sourceSelector, alsoClick = false) {
  const before = await page.evaluateHandle(selector => {
    const scene = document.querySelector(".vn-scene");
    const source = document.querySelector(selector);
    return { scene, source, text: source.firstChild, textContent: source.textContent, background: getComputedStyle(scene, "::before").backgroundImage };
  }, sourceSelector);
  try {
    const next = await page.$(".vn-next");
    const cycled = () => page.evaluate(snapshot => {
      const background = getComputedStyle(snapshot.scene, "::before").backgroundImage;
      const changed = background !== snapshot.background;
      snapshot.background = background;
      return document.activeElement === snapshot.scene.querySelector(".vn-next") && changed
        && snapshot.source.isConnected && snapshot.source.firstChild === snapshot.text
        && snapshot.source.textContent === snapshot.textContent;
    }, before);
    await next.press("Enter");
    const keyboard = await cycled();
    if (!alsoClick) return keyboard;
    await next.click();
    return await cycled() && keyboard;
  } finally { await before.dispose(); }
}

// Values that more than one step uses; the step that creates each one assigns it.
let launch, server, pageUrl, launchArgs, setupArchives, watchedServiceWorkers, browser,
  extensionId, settingsUrl, page;

function setWordHighlightAnki(value) {
  wordHighlightAnki = value;
}

function setBrowser(value) {
  browser = value;
}

function setPage(value) {
  page = value;
}

// Nothing else can see inside the offscreen document: puppeteer reports it as a
// background_page, it has no console anyone reads, and a boot failure there is
// silent. Every failure in this file that is not a rendering failure shows up
// here first, so the CDP session is permanent rather than a debugging aid.
async function watchOffscreen(target) {
  if (!target.url().endsWith("offscreen.html")) return;
  try {
    const cdp = await target.createCDPSession();
    await cdp.send("Runtime.enable");
    const flatten = args => (args || [])
      .map(a => a.value ?? a.description ?? a.unserializableValue ?? JSON.stringify(a.preview ?? null))
      .join(" ");
    cdp.on("Runtime.consoleAPICalled", e => diagnostics.push(`[offscreen] ${e.type}: ${flatten(e.args)}`));
    cdp.on("Runtime.exceptionThrown", e => diagnostics.push(
      `[offscreen] exception: ${e.exceptionDetails?.exception?.description
        ?? e.exceptionDetails?.text ?? "(no detail)"}`));
  } catch (e) {
    diagnostics.push(`[offscreen] could not attach: ${e?.message ?? e}`);
  }
}

async function interceptSetupArchives(target) {
  if (!setupArchives.enabled || !target.url().endsWith("offscreen.html") || setupArchives.attached.has(target)) return;
  setupArchives.attached.add(target);
  try {
    const session = await target.createCDPSession();
    setupArchives.sessions.push(session);
    session.on("Fetch.requestPaused", (event) => {
      void (async () => {
        const route = setupArchives.routes?.get(event.request.url);
        if (!route) {
          await session.send("Fetch.continueRequest", { requestId: event.requestId });
          return;
        }
        route.requests += 1;
        const response = route.respond ? await route.respond(event.request) : route;
        const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
        const responseHeaders = [
          { name: "Access-Control-Allow-Origin", value: "*" },
          { name: "Content-Type", value: response.contentType },
          { name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ];
        if (response.contentLength !== false) {
          responseHeaders.push({ name: "Content-Length", value: String(body.length) });
        }
        await session.send("Fetch.fulfillRequest", {
          requestId: event.requestId,
          responseCode: response.status,
          responseHeaders,
          body: body.toString("base64"),
        });
      })().catch(async (error) => {
        diagnostics.push(`[setup archive mock] ${error?.stack ?? error}`);
        await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" }).catch(() => {});
      });
    });
    await session.send("Fetch.enable", {
      patterns: [
        ...setupArchives.fixtures.keys(),
        MANAGED_DOWNLOAD_URL,
        GENERIC_MANAGED_DOWNLOAD_URL,
      ].map((urlPattern) => ({ urlPattern, requestStage: "Request" })),
    });
  } catch (error) {
    diagnostics.push(`[setup archive mock] could not attach: ${error?.message ?? error}`);
  }
}

function watch(browser) {
  browser.on("targetcreated", async target => {
    watchOffscreen(target);
    void interceptSetupArchives(target);
    try {
      const worker = await target.worker?.();
      worker?.on?.("console", m => diagnostics.push(`[sw] ${m.text()}`));
      if (worker && target.type() === "service_worker") {
        watchedServiceWorkers.set(target, worker);
      }
    } catch { /* not a worker target */ }
  });
  // The offscreen target is created with an empty URL and named afterwards.
  browser.on("targetchanged", target => { void interceptSetupArchives(target); });
  browser.on("targetdestroyed", target => watchedServiceWorkers.delete(target));
  // The offscreen document is created from onInstalled, which can win the race
  // against the listener above.
  for (const target of browser.targets()) {
    watchOffscreen(target);
    void interceptSetupArchives(target);
  }
}

describe("session", () => {
  step("the extension loads and its service worker starts", async () => {
    if (!CHROME || !existsSync(CHROME)) {
      fatal("no Chrome found (set HACHIDORI_CHROME or install it as described in test/README.md)");
    }
    if (!existsSync(PUPPETEER)) fatal(`no puppeteer-core at ${PUPPETEER} (set HACHIDORI_PUPPETEER)`);
    if (!existsSync(resolve(EXTENSION, "vendor/hoshidicts.wasm"))) {
      fatal("extension/vendor/hoshidicts.wasm is missing -- run wasm/build.sh first");
    }
    if (!HIGHLIGHT_NAME) {
      fatal("could not read HIGHLIGHT_NAME out of extension/content.js");
    }
    if (!existsSync(FIXTURE) || !existsSync(GENERIC_KANJI_FIXTURE)) {
      const r = spawnSync(process.execPath, [resolve(HERE, "make-fixture.mjs")], { encoding: "utf8" });
      if (r.status !== 0) fatal(`make-fixture.mjs failed:\n${r.stdout}\n${r.stderr}`);
    }

    // A Windows path has a drive-letter "scheme"; the ESM loader needs a file URL.
    const puppeteer = await import(pathToFileURL(PUPPETEER).href);
    launch = puppeteer.default?.launch ? puppeteer.default : puppeteer;

    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === WORD_HIGHLIGHT_ANKI_PATH) {
        void answerWordHighlightAnki(req, res);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (req.url === "/words") {
        res.end(WORDS_PAGE_HTML);
        return;
      }
      res.end(req.url === "/frame"
        ? '<!doctype html><html lang="ja"><meta charset="utf-8"><body style="font: 32px serif; padding: 40px"><span id="frame-verb">食べたかった</span></body></html>'
        : PAGE_HTML);
    });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    pageUrl = `http://127.0.0.1:${server.address().port}/`;

    // Start from a clean profile so the persistence check below is meaningful: the
    // dictionary must arrive via import, not via a leftover IndexedDB. Only the
    // per-pid default is deleted to get there -- an explicit HACHIDORI_PROFILE may be any
    // directory the reader named, including a real browser profile, and recursively
    // deleting that is not this file's business.
    if (process.env.HACHIDORI_PROFILE) {
      if (existsSync(PROFILE) && readdirSync(PROFILE).length > 0) {
        fatal(`HACHIDORI_PROFILE=${PROFILE} is not empty. Pass 1 has to import the fixture into a`
          + ` clean profile or the restart check proves nothing; remove it yourself and re-run.`);
      }
    } else {
      rmSync(PROFILE, { recursive: true, force: true });
    }
    mkdirSync(PROFILE, { recursive: true });
    console.log(`     profile: ${PROFILE}`);

    launchArgs = {
      executablePath: CHROME,
      enableExtensions: true,
      dumpio: process.env.HACHIDORI_DUMPIO === "1",
      headless: "shell" === process.env.HACHIDORI_HEADLESS ? "shell" : true,
      userDataDir: PROFILE,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        // Chromium's clocked fake output device: native decode/play/ended still
        // run when the host has no audio device. This does not bypass autoplay.
        "--disable-audio-output",
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
      ],
    };

    // The first-run installer downloads the five catalogue archives from inside
    // the offscreen engine, so those fetches are answered on the offscreen target's
    // Fetch domain before the run can start. The first archive is held until the
    // clean-profile checks have run; the second attempt of jmnedict succeeds; Bee's
    // omits Content-Length so its progress must stay indeterminate.
    const SETUP_PADDING_BYTES = 4 * 1024 * 1024;
    setupArchives = {
      enabled: true,
      fixtures: new Map(RECOMMENDED_DICTIONARIES.map((entry) => [entry.downloadUrl, {
        entry, body: buildRecommendedZip({ ...entry, paddingBytes: entry.sourceId === "jmnedict" ? 0 : SETUP_PADDING_BYTES }),
      }])),
      routes: null,
      requests: [],
      attempts: new Map(),
      sessions: [],
      attached: new WeakSet(),
      release: null,
      held: null,
    };
    setupArchives.held = new Promise((resolve) => { setupArchives.release = resolve; });
    setupArchives.routes = new Map([...setupArchives.fixtures].map(([url, fixture]) => [url, {
      requests: 0,
      async respond() {
        const attempt = (setupArchives.attempts.get(fixture.entry.sourceId) ?? 0) + 1;
        setupArchives.attempts.set(fixture.entry.sourceId, attempt);
        setupArchives.requests.push(fixture.entry.sourceId);
        if (fixture.entry.sourceId === "jitendex" && attempt === 1) await setupArchives.held;
        return fixture.entry.sourceId === "jmnedict" && attempt === 1
          ? {
              status: 503,
              contentType: "text/plain",
              body: "mocked publisher failure",
            }
          : {
              status: 200,
              contentType: "application/zip",
              body: fixture.body,
              contentLength: fixture.entry.sourceId !== "bees-ultimate-kanji-dictionary",
            };
      },
    }]));

    watchedServiceWorkers = new Map();

    // ---------------------------------------------------------------- pass 1
    browser = await launch.launch(launchArgs);
    watch(browser);

    let swTarget;
    try {
      swTarget = await browser.waitForTarget(
        t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
        { timeout: 30_000 },
      );
    } catch {
      check("extension loads and its service worker starts", false,
        `no extension service_worker target appeared. targets:\n` +
        browser.targets().map(t => `  ${t.type()} ${t.url()}`).join("\n"));
      await browser.close();
      server.close();
      return report();
    }
    extensionId = new URL(swTarget.url()).host;
    check("extension loads and its service worker starts", !!extensionId,
      `service_worker url: ${swTarget.url()}`);
    console.log(`     extension id: ${extensionId}`);
  });

  step("the manifest and settings page are branded as Hachidori", async () => {
    settingsUrl = `chrome-extension://${extensionId}/settings.html`;

    page = await browser.newPage();
    page.on("console", m => diagnostics.push(`[settings] ${m.type()}: ${m.text()}`));
    page.on("pageerror", e => diagnostics.push(`[settings] pageerror: ${e.message}`));
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });

    const branding = await page.evaluate(() => {
      const manifest = chrome.runtime.getManifest();
      return {
        heading: document.querySelector(".brand-context")?.textContent?.trim() ?? "",
        brand: document.querySelector(".brand span")?.textContent?.trim() ?? "",
        icons: manifest.icons ?? {},
        name: manifest.name,
        shortName: manifest.short_name,
        title: document.title,
      };
    });
    check(
      "manifest and settings page are branded as Hachidori",
      branding.name === "Hachidori"
        && branding.shortName === "Hachidori"
        && branding.title === "Hachidori settings"
        && branding.heading === "Settings"
        && branding.brand === "Hachidori"
        && ["16", "32", "48", "128"].every(
          size => branding.icons[size] === `icons/hachidori-${size}.png`,
        ),
      JSON.stringify(branding),
    );
  });

  step("a fresh profile shares by default once it has dictionaries", async () => {
    await showSettingsSection(page, "sharing");
    const sharing = await page.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const reply = await chrome.runtime.sendMessage({ target: "hachidori-sharing", type: "hd_sharing_status", requestId: "e2e-sharing" });
      const toggle = document.getElementById("sharing-host-enabled");
      for (let attempt = 0; attempt < 50 && toggle.disabled; attempt++) {
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      return {
        optional: manifest.optional_permissions ?? null,
        permissions: manifest.permissions,
        reply,
        visible: !document.getElementById("sharing").hidden,
        toggleDisabled: toggle.disabled,
        toggleChecked: toggle.checked,
        networkDisabled: document.getElementById("sharing-host-network").disabled,
        addonOffered: !document.getElementById("sharing-addon").hidden,
        alarms: (await chrome.alarms.getAll()).map(alarm => alarm.name),
        status: document.getElementById("sharing-status").textContent,
      };
    });
    check(
      "a fresh profile shares by default and waits for dictionaries before it takes the host slot",
      sharing.optional === null
        && !sharing.permissions.includes("nativeMessaging")
        && sharing.reply?.ok === true
        && sharing.reply.sharing?.enabled === true
        && sharing.reply.sharing.connected === false
        && sharing.reply.sharing.dictionaries === 0
        && sharing.reply.sharing.error === null
        && sharing.reply.sharing.port === 8771
        && sharing.reply.sharing.network?.enabled === false
        && sharing.reply.sharing.client?.linked === false
        && sharing.visible
        && sharing.toggleDisabled === false
        && sharing.toggleChecked === true
        && sharing.networkDisabled === false
        && sharing.addonOffered
        && !sharing.alarms.includes("hachidori-sharing-host")
        && sharing.status === "Sharing starts once this Hachidori has dictionaries.",
      JSON.stringify(sharing),
    );
    // Sharing connects, with a watchdog alarm while the relay is away, as soon as
    // this profile has dictionaries; off for the rest of this profile so the
    // update-alarm checks below see only their own alarms.
    const sharingOff = await page.evaluate(() => chrome.runtime.sendMessage({ target: "hachidori-sharing", type: "hd_sharing_host_disable", requestId: "e2e-sharing-off" }));
    if (sharingOff?.ok !== true) throw new Error(`sharing could not be turned off: ${sharingOff?.error}`);
  });

  step("Chrome registers the browser shortcuts that Keybinds lists", async () => {
    await showSettingsSection(page, "keybinds");
    const browserShortcuts = await page.evaluate(async () => {
      const commands = await chrome.commands.getAll();
      const listed = () => [...document.querySelectorAll("#browser-shortcut-list li")].map(item => item.textContent);
      for (let attempt = 0; attempt < 50 && listed().length < commands.length; attempt++) {
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
      return { commands: commands.map(({ name, shortcut }) => ({ name, shortcut })), listed: listed() };
    });
    check(
      "Chrome registers Hachidori's browser shortcuts and Keybinds lists them",
      // Chrome registers the manifest's suggested Alt+Delete and reports it as Alt+Del.
      browserShortcuts.commands.some(({ name, shortcut }) => name === "toggleTextScanning" && shortcut === "Alt+Del")
        && browserShortcuts.commands.some(({ name }) => name === "openSettingsPage")
        && ["addNote", "nextEntry"].every(action => browserShortcuts.commands.some(({ name }) => name === action))
        && browserShortcuts.listed.includes("Turn Japanese lookups on or offAlt+Del")
        && browserShortcuts.listed.includes("Add the current popup entry to AnkiNot set"),
      JSON.stringify(browserShortcuts),
    );
  });
});

// The run's last statements used to close the browser and the page server, then
// report. They now run however the steps end.
after(async () => {
  try {
    await browser?.close().catch(() => {});
    server?.close();
    report(false);
  } finally {
    // As the former script did, exit once everything has run even if a handle lingers;
    // this timer cannot keep the process alive on its own.
    setTimeout(() => process.exit(failed ? 1 : 0), 1000).unref();
  }
});

export {
  activeExtensionWorker, browser, CUSTOM_KANJI_NOTE_DEFINITION, CUSTOM_SETTINGS_SOURCE,
  CUSTOM_TERM_NOTE_DEFINITION, cycleVisualNovelScene, editSettingsControls, extensionId, FIXTURE,
  FIXTURE_ALIAS, FIXTURE_ID, FIXTURE_KANJI_SELECTION, FIXTURE_KANJI_SELECTION_VALUE,
  FIXTURE_TERM_SELECTION, FIXTURE_TERM_SELECTION_VALUE, generationExists, generationIsAbsent,
  GENERIC_KANJI_FIXTURE, GENERIC_KANJI_ID, GENERIC_KANJI_SELECTION, GENERIC_KANJI_SELECTION_VALUE,
  GENERIC_MANAGED_DOWNLOAD_URL, GENERIC_MANAGED_INDEX_URL, installMediaArchive,
  installMediaReplyProbe, interceptFetches, launch, launchArgs, listOpfsPaths, makeAudioWav,
  MANAGED_DOWNLOAD_URL, MANAGED_INDEX_URL, MANAGED_UPDATE_ALARM, openDictionaryDetails, opfsPath,
  ownedGenerationRoot, page, PAGE_HTML, pageUrl, readLookupStatistics, readSettingsControls,
  readVisualNovelScene, RECOMMENDED_DICTIONARIES, restoreMediaReplyProbe, server, setBrowser,
  setDictionaryAliasInSettings, setDictionaryEnabledInSettings, setPage, settingsUrl,
  setupArchives, setWordHighlightAnki, showSettingsSection, updateSettingsControls,
  waitForCdpTargetGone, waitForGenerationAbsent, waitForRunningServiceWorker, watch,
  watchedServiceWorkers, WORD_HIGHLIGHT_ANKI_PATH,
};
