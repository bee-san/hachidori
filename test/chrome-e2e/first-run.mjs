/*
 * First-run setup from the startup page, practice and Remove all.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./session.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { check, diagnostics, EXTENSION, step } from "./harness.mjs";
import { popupReader } from "./popup-reader.mjs";
import {
  browser,
  cycleVisualNovelScene,
  extensionId,
  interceptFetches,
  page,
  readVisualNovelScene,
  RECOMMENDED_DICTIONARIES,
  settingsUrl,
  setupArchives,
  showSettingsSection,
} from "./session.mjs";

// Every assertion this run makes, named up front. The denominator is this list,
// not the number of checks that happened to execute: a suite that skips an
// assertion under a regression prints "23/24 passed" and reads like success.
// The reader as the manifest injects it into a page, minus `reader-options.js`,
// which the startup page's own module already provides. Read from the manifest
// so a reordered or extended reader cannot pass against a stale copy.
const READER_SCRIPTS = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8"))
  .content_scripts[0].js.filter((src) => src !== "reader-options.js");

async function hoverPracticeCharacter(startup, index) {
  const point = await startup.evaluate((at) => {
    const source = document.getElementById("setup-practice-word");
    source?.scrollIntoView({ block: "nearest" });
    const text = source?.firstChild;
    if (!text) return null;
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, index);
  if (point === null) return;
  await startup.mouse.move(2, 2);
  await startup.mouse.move(point.x, point.y);
}

// A fresh install looks up while Shift is held, and the popup outlives its release.
async function holdShiftOverPracticeCharacter(startup, index, popup) {
  await startup.keyboard.down("Shift");
  try {
    await hoverPracticeCharacter(startup, index);
    return await popup.waitForVisible();
  } finally {
    await startup.keyboard.up("Shift");
  }
}

async function checkStartupPractice(startup, browser, startupUrl) {
  // Native skip navigation can precede startup.js's click handler. Reload that
  // exact URL so a fresh reader must accept the fragment, not an earlier reader
  // that was already running at the bare URL.
  await startup.goto(`${startupUrl}#setup-heading`);
  const hydrationProbe = await startup.evaluateOnNewDocument(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = (keys, callback) => {
      if (typeof callback !== "function") return get(keys);
      return get(keys, stored => {
        window.completeReaderStorage = () => { chrome.storage.local.get = get; callback(stored); };
      });
    };
  });
  await startup.reload({ waitUntil: "networkidle0" });
  await startup.removeScriptToEvaluateOnNewDocument(hydrationProbe.identifier);
  await startup.bringToFront();
  await startup.waitForFunction(() => typeof window.completeReaderStorage === "function");
  const waitingForStorage = await startup.evaluate(() => document.getElementById("setup-practice-lookup").disabled
    && getSelection().toString() === "");
  await startup.evaluate(() => { window.completeReaderStorage(); delete window.completeReaderStorage; });
  check("startup practice waits for reader storage before its automatic lookup", waitingForStorage);
  await startup.waitForSelector("#setup-practice-lookup:not([disabled])");
  const popup = await popupReader(startup);
  const automatic = await popup.waitForVisible();
  const automaticallySelected = await startup.evaluate(() => getSelection().toString());
  await startup.focus("#setup-heading");
  if (process.env.HACHIDORI_STARTUP_LOOKUP_SCREENSHOT) {
    await startup.screenshot({ path: process.env.HACHIDORI_STARTUP_LOOKUP_SCREENSHOT });
  }
  await startup.keyboard.press("Escape");
  const automaticEscaped = await popup.waitForHidden();
  await startup.evaluate(() => new Promise(resolveSelection => {
    document.addEventListener("selectionchange", () => {
      requestAnimationFrame(resolveSelection);
    }, { once: true });
    getSelection().removeAllRanges();
  }));
  // The visible control remains keyboard-operable after the automatic example.
  let keyboardReached = false;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await startup.keyboard.press("Tab");
    keyboardReached = await startup.evaluate(() => document.activeElement?.id === "setup-practice-lookup");
    if (keyboardReached) break;
  }
  if (!keyboardReached) throw new Error("The practice lookup control was not reachable through the tab order.");
  await startup.keyboard.press("Enter");
  const selected = await popup.waitForVisible();
  const screenshot = await startup.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ target: "hachidori-anki", type: "hd_anki_screenshot",
      requestId: "startup-screenshot", request: {} });
    if (reply.ok) await chrome.runtime.sendMessage({ target: "hachidori-anki", type: "hd_anki_screenshot_discard",
      requestId: "startup-screenshot-discard", request: { token: reply.token } });
    return reply;
  });
  check("startup screenshot capture resolves its own live extension document",
    screenshot.ok === true && /^hachidori-screenshot-[0-9a-f-]{36}\.jpg$/u.test(screenshot.filename ?? ""),
    JSON.stringify(screenshot));
  const originalOpacity = await startup.evaluate(async () => {
    window.__practiceScene = document.getElementById("setup-practice-scene");
    window.__practiceRender = { events: 0, detached: false };
    window.__practiceObserver = new MutationObserver(records => {
      window.__practiceRender.events += records.length;
      for (const record of records) {
        if ([...record.removedNodes].some(node => node.contains(window.__practiceScene))) window.__practiceRender.detached = true;
      }
    });
    window.__practiceObserver.observe(document.getElementById("setup-body"), { childList: true });
    const { options } = await chrome.storage.local.get("options");
    const opacity = options.popupOpacityPercent ?? 85;
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { popupOpacityPercent: opacity === 85 ? 90 : 85 } });
    if (!reply.ok) throw new Error(reply.error);
    return opacity;
  });
  await startup.waitForFunction(() => window.__practiceRender.events > 0);
  const source = await startup.evaluate(() => ({
    url: location.href,
    selected: getSelection().toString(),
    text: document.getElementById("setup-practice-text")?.textContent,
    sameScene: document.getElementById("setup-practice-scene") === window.__practiceScene,
    detached: window.__practiceRender.detached,
    readerScripts: [...document.scripts].filter(script => script.src.endsWith("/content.js")).length,
    finish: document.getElementById("setup-finish")?.disabled === false,
    settings: document.querySelector('a[href="settings.html"]') !== null,
  }));
  await startup.keyboard.press("Escape");
  const escaped = await popup.waitForHidden();
  await startup.evaluate(() => getSelection().removeAllRanges());
  // The two-character word may wrap; its aggregate span box includes other
  // text between the end of one line and the beginning of the next.
  const hovered = await holdShiftOverPracticeCharacter(startup, 0, popup);
  const genuine = state => state?.plain.includes("辞書")
    && state.text.includes(`${RECOMMENDED_DICTIONARIES[0].title} term fixture`);
  check("startup practice immediately demonstrates the installed dictionaries and retains keyboard and hover lookup",
    genuine(automatic) && automaticallySelected === "辞書" && automaticEscaped
      && keyboardReached && genuine(hovered) && escaped
      && source.url === `${startupUrl}#setup-heading`
      && source.selected === "辞書" && source.text.includes("辞書") && source.sameScene && !source.detached
      && source.readerScripts === 1 && source.finish && source.settings,
    JSON.stringify({ automatic, automaticallySelected, automaticEscaped, keyboardReached, selected, hovered, source, escaped }));
  await startup.keyboard.press("Escape");
  await popup.waitForHidden();
  await startup.mouse.move(2, 2);
  await startup.evaluate(async popupOpacityPercent => {
    window.__practiceObserver.disconnect();
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { popupOpacityPercent } });
    if (!reply.ok) throw new Error(reply.error);
  }, originalOpacity);

  // These pages do not normally load content.js. Inject the production script
  // list explicitly so this checks its URL boundary, not just missing scripts.
  const scriptPaths = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).content_scripts[0].js;
  const restricted = [];
  const excluded = ["settings.html", "design-preview.html", "startup.html?reader-boundary",
    "startup.html?reader-boundary#setup-heading", "startup.html#other-heading"];
  for (const relative of excluded) {
    const internal = await browser.newPage();
    try {
      await internal.goto(new URL(relative, startupUrl).href, { waitUntil: "networkidle0" });
      await internal.evaluate(() => {
        window.__practiceLookupRequests = 0;
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = function (...args) {
          if (args[0]?.type === "hd_lookup") window.__practiceLookupRequests += 1;
          return send.apply(this, args);
        };
      });
      for (const script of scriptPaths) await internal.addScriptTag({ url: new URL(script, startupUrl).href });
      await internal.evaluate(() => {
        const prose = document.createElement("p");
        prose.textContent = "辞書";
        document.body.append(prose);
        getSelection().selectAllChildren(prose);
      });
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
      restricted.push(await internal.evaluate(() => ({
        url: location.href,
        requests: window.__practiceLookupRequests,
        hosts: document.querySelectorAll("hachidori-host").length,
        scripts: [...document.scripts].filter(script => script.src.endsWith("/content.js")).length,
      })));
    } finally { await internal.close(); }
  }
  check("the startup reader exception keeps Settings and the static preview excluded",
    restricted.length === excluded.length && restricted.every(result => result.requests === 0 && result.hosts === 0 && result.scripts >= 1),
    JSON.stringify(restricted));
  // Later lifecycle checks identify the setup tab by its original bare URL.
  await startup.evaluate(url => history.replaceState(null, "", url), startupUrl);
}

// Values that more than one step uses; the step that creates each one assigns it.
let startupUrl, startupTabs, startup, readStartup, clickStartupControl, waitStartup,
  editedPreference, afterRun, ankiRefused, ankiOffline, retried, successShownAt, practiceReached,
  headingLog, painted, ankiStage, settledAnki, completedSetup, setupRequestsAfterSetup;

describe("first-run setup", () => {
  step("a clean profile offers one recommended install beside local import", async () => {
    // ---------------------------------------------------------- first-run setup
    // chrome.runtime.onInstalled fired with reason "install" for this clean
    // profile, so the extension itself opened startup.html. Downloads and Anki
    // discovery wait for the user's informed Start setup action.
    await showSettingsSection(page, "add-dictionaries");
    // Settings renders the starter card once its first dictionary-state read answers.
    await page.waitForFunction(() => document.getElementById("recommended-starter")?.hidden === false,
      { timeout: 90_000, polling: 100 }).catch(() => {});
    const cleanInstaller = await page.evaluate(() => ({
      starterHidden: document.getElementById("recommended-starter")?.hidden,
      installText: document.getElementById("install-recommended")?.textContent?.trim() ?? "",
      retryHidden: document.getElementById("recommended-retry")?.hidden,
      localInputVisible: document.getElementById("import-file")?.checkVisibility() === true,
      dictionaryManagementVisible: document.getElementById("dict-list")?.closest(".card")?.hidden !== true,
    }));
    check(
      "a clean profile shows one recommended install action beside local import",
      cleanInstaller.starterHidden === false
        && cleanInstaller.installText === "Install recommended"
        && cleanInstaller.retryHidden === true
        && cleanInstaller.localInputVisible === true
        && cleanInstaller.dictionaryManagementVisible === false,
      JSON.stringify(cleanInstaller),
    );
  });

  step("a fresh install waits for Start setup", async () => {
    startupUrl = `chrome-extension://${extensionId}/startup.html`;
    startupTabs = () => browser.targets().filter((target) =>
      target.type() === "page" && target.url() === startupUrl).length;
    const startupTarget = await browser.waitForTarget((target) =>
      target.type() === "page" && target.url() === startupUrl, { timeout: 30_000 }).catch(() => null);
    startup = startupTarget === null ? null : await startupTarget.page();
    const watchStartup = (target) => {
      target.on("console", (m) => diagnostics.push(`[startup] ${m.type()}: ${m.text()}`));
      target.on("pageerror", (e) => diagnostics.push(`[startup] pageerror: ${e.message}`));
    };
    if (startup) watchStartup(startup);
    readStartup = () => ({
      title: document.title,
      heading: document.getElementById("setup-heading")?.textContent ?? "",
      currentStep: document.querySelector('.setup-step[aria-current="step"]')?.dataset.stage ?? null,
      steps: [...document.querySelectorAll(".setup-step")].map((step) => step.textContent.trim().replace(/^\d\s*/u, "")),
      done: document.querySelectorAll(".setup-step.is-done").length,
      rows: [...document.querySelectorAll(".setup-dictionary")].map((row) => [row.dataset.sourceId,
        row.querySelector(".setup-dictionary-status")?.textContent ?? "",
        row.querySelector(".setup-track:not([hidden])")?.classList.contains("is-determinate") ?? null,
        row.querySelector(".setup-track:not([hidden])")?.getAttribute("aria-valuenow") ?? row.querySelector(".setup-track:not([hidden])")?.getAttribute("aria-valuetext") ?? null]),
      importLink: document.querySelector('#setup-body a[href="settings.html#add-dictionaries"]') !== null,
      settingsLink: document.querySelector('a[href="settings.html"]') !== null,
      actions: [...document.querySelectorAll("#setup-actions button")].map((control) => [control.id, control.textContent]),
      status: document.getElementById("setup-status")?.textContent ?? "",
      countdown: document.getElementById("setup-countdown-label")?.textContent ?? null,
      focused: document.activeElement?.id ?? "",
      tagline: document.querySelector(".startup-tagline")?.textContent ?? "",
      credit: document.querySelector(".startup-footer p")?.textContent?.replace(/\s+/gu, " ").trim() ?? "",
      creditLinks: [...document.querySelectorAll(".startup-footer p a")].map(link => [link.textContent, link.href]),
      star: {
        text: document.querySelector(".startup-star-link")?.textContent?.replace(/\s+/gu, " ").trim() ?? "",
        href: document.querySelector(".startup-star-link")?.href ?? "",
        visible: document.querySelector(".startup-star-link")?.checkVisibility() === true,
      },
      privacy: document.querySelector('a[href*="privacy"]') !== null,
      theme: document.documentElement.dataset.hoshidictsTheme,
      background: getComputedStyle(document.body).backgroundColor,
      cardBackground: getComputedStyle(document.getElementById("setup-card")).backgroundColor,
    });
    // The startup page re-renders its controls on every storage change and
    // progress event. Click inside the page so a handle resolved before a
    // re-render cannot go stale, keeping the user-clickable requirement
    // Puppeteer's handle click would have enforced.
    clickStartupControl = (id) => startup.evaluate((controlId) => {
      const control = document.getElementById(controlId);
      if (!control || control.disabled || !control.checkVisibility()) throw new Error(`#${controlId} is not user-clickable`);
      control.click();
    }, id);
    // Extension pages forbid eval, so the page state is read with a plain
    // evaluate and awaited from here rather than through a stringified predicate.
    waitStartup = async (predicate, timeout) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const state = await startup.evaluate(readStartup).catch(() => null);
        if (state !== null && predicate(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    };
    const welcome = startup === null ? null
      : await waitStartup((state) => state.actions.some(([id]) => id === "setup-start"), 30_000);
    const automaticBeforeStart = {};
    if (startup !== null) {
      for (const scheme of ["light", "dark"]) {
        await page.bringToFront();
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        let settingsState;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          settingsState = await page.evaluate(async () => {
            const stored = await chrome.storage.local.get(["options", "setupState"]);
            return { page: location.pathname, theme: document.documentElement.dataset.hoshidictsTheme,
              storedTheme: stored.options?.popupTheme, optionsRevision: stored.options?.revision,
              setupStage: stored.setupState?.stage, setupRevision: stored.setupState?.revision };
          });
          if (settingsState.theme === scheme && settingsState.storedTheme === "auto") break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await startup.bringToFront();
        await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        let startupState;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          startupState = await startup.evaluate(async () => {
            const stored = await chrome.storage.local.get("options");
            return { page: location.pathname, theme: document.documentElement.dataset.hoshidictsTheme,
              storedTheme: stored.options?.popupTheme, optionsRevision: stored.options?.revision,
              startVisible: document.getElementById("setup-start")?.checkVisibility() === true };
          });
          if (startupState.theme === scheme && startupState.storedTheme === "auto") break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        automaticBeforeStart[scheme] = { settings: settingsState, startup: startupState };
      }
      await page.bringToFront();
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await page.waitForFunction(() => document.documentElement.dataset.hoshidictsTheme === "light");
      await startup.bringToFront();
      await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    }
    const refusedBeforeStart = startup === null ? null : await startup.evaluate(async () => ({
      anki: await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_setup_anki", requestId: "before-start-anki" }),
      dictionaries: await chrome.runtime.sendMessage({ target: "hachidori-setup", type: "hd_setup_install",
        sourceIds: ["jitendex"], requestId: "before-start-dictionaries" }),
      setup: (await chrome.storage.local.get("setupState")).setupState,
      privacy: document.querySelector('a[href*="privacy"]') !== null,
    }));
    check("a fresh install uses AUTO in startup and Settings before Start setup and waits for work",
      startupTabs() === 1 && welcome?.rows.length === 0 && refusedBeforeStart?.setup.stage === "welcome"
        && refusedBeforeStart.setup.revision === 1 && !refusedBeforeStart.privacy && !welcome.privacy
        && ["light", "dark"].every(scheme => {
          const proof = automaticBeforeStart[scheme];
          return proof?.settings.page === "/settings.html" && proof.settings.theme === scheme
            && proof.settings.storedTheme === "auto" && proof.settings.optionsRevision === 1
            && proof.settings.setupStage === "welcome" && proof.settings.setupRevision === 1
            && proof.startup.page === "/startup.html" && proof.startup.theme === scheme
            && proof.startup.storedTheme === "auto" && proof.startup.optionsRevision === 1
            && proof.startup.startVisible;
        })
        && welcome.tagline === "Blazing fast, feature rich Japanese dictionary by Bee"
        && welcome.credit === "Made by Bee · bee-san on GitHub · skerritt.blog"
        && JSON.stringify(welcome.creditLinks) === JSON.stringify([
          ["bee-san on GitHub", "https://github.com/bee-san"],
          ["skerritt.blog", "https://skerritt.blog/"],
        ])
        && welcome.star.text === "Star Hachidori on GitHub"
        && welcome.star.href === "https://github.com/bee-san/hachidori" && welcome.star.visible
        && refusedBeforeStart.anki.error === "Start setup before checking Anki."
        && refusedBeforeStart.dictionaries.error === "Start setup before downloading dictionaries."
        && setupArchives.requests.length === 0,
      JSON.stringify({ welcome, automaticBeforeStart, refusedBeforeStart, requests: setupArchives.requests }));
    if (startup && (process.env.HACHIDORI_STARTUP_SCREENSHOT || process.env.HACHIDORI_STARTUP_DARK_SCREENSHOT)) {
      await startup.setViewport({ width: 900, height: 820 });
      for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await startup.screenshot({ path });
      }
      await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    }
  });

  step("Start setup begins automatic installation", async () => {
    if (startup !== null) await clickStartupControl("setup-start");
    // After the click, the held request means Jitendex sits in Downloading.
    const startupShell = startup === null ? null
      : await waitStartup((state) => state.rows[0]?.[1]?.startsWith("Downloading"), 120_000);
    let skippedToSetup = null;
    if (startup) {
      await startup.bringToFront();
      await startup.focus(".skip-link");
      await startup.keyboard.press("Enter");
      skippedToSetup = await startup.evaluate(() => ({ url: location.href, focused: document.activeElement?.id }));
    }
    // The row turns to Downloading when the import is dispatched; the archive
    // request itself follows once the engine has validated the request.
    for (let attempt = 0; attempt < 200 && setupArchives.requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const settingsPalette = await page.evaluate(() => ({
      theme: document.documentElement.dataset.hoshidictsTheme,
      base100: getComputedStyle(document.documentElement)
        .getPropertyValue("--hoshidicts-palette-base-100").trim(),
      base200: getComputedStyle(document.documentElement)
        .getPropertyValue("--hoshidicts-palette-base-200").trim(),
      accent: getComputedStyle(document.documentElement)
        .getPropertyValue("--accent").trim(),
      borderStrong: getComputedStyle(document.documentElement)
        .getPropertyValue("--border-strong").trim(),
      textDim: getComputedStyle(document.documentElement)
        .getPropertyValue("--text-dim").trim(),
      background: getComputedStyle(document.body).backgroundColor,
      surface: getComputedStyle(document.querySelector(".page")).backgroundColor,
    }));
    const firstInstallStorage = await page.evaluate(async () => {
      const stored = await chrome.storage.local.get(["setupState", "options", "dictionaryState"]);
      return { ...stored, effective: globalThis.HDReaderOptions.normaliseOptions(stored.options) };
    });
    const seededOptions = firstInstallStorage.options ?? {};
    const effective = firstInstallStorage.effective ?? {};
    const seededInSettings = await page.waitForFunction(() =>
      document.getElementById("opt-compact-summary")?.checked === true
        && document.getElementById("opt-summary-count")?.value === "2",
    { timeout: 30_000, polling: 100 }).then(() => true).catch(() => false);
    check(
      "Start setup begins automatic dictionary installation with first-install preferences",
      startupTabs() === 1 && seededInSettings
        && skippedToSetup?.url === startupUrl && skippedToSetup.focused === "setup-heading"
        && startupShell?.title === "Set up Hachidori"
        && startupShell.heading === "Installing default dictionaries…"
        && startupShell.currentStep === "dictionaries" && startupShell.done === 0
        && JSON.stringify(startupShell.steps) === JSON.stringify(["Dictionaries", "Anki Optional", "Try it"])
        && JSON.stringify(startupShell.rows) === JSON.stringify([
          ["jitendex", "Downloading… 0 KB", false, "Downloading… 0 KB"],
          ["jmnedict", "Waiting", null, null],
          ["bees-ultimate-kanji-dictionary", "Waiting", null, null],
          ["jiten", "Waiting", null, null],
          ["bees-ultimate-grammar-dictionary", "Waiting", null, null],
        ])
        && startupShell.importLink && startupShell.settingsLink && startupShell.actions.length === 0
        && startupShell.status === "Installing default dictionaries…"
        && startupShell.background !== "rgba(0, 0, 0, 0)"
        && startupShell.cardBackground !== "rgba(0, 0, 0, 0)"
        && settingsPalette.theme === "light"
        && [settingsPalette.base100, settingsPalette.base200, settingsPalette.accent,
          settingsPalette.borderStrong, settingsPalette.textDim].every(Boolean)
        && settingsPalette.background !== "rgba(0, 0, 0, 0)"
        && settingsPalette.surface !== "rgba(0, 0, 0, 0)"
        && firstInstallStorage.setupState?.stage === "dictionaries"
        && firstInstallStorage.setupState.revision === 2
        && firstInstallStorage.setupState.completedAt === null
        && JSON.stringify(firstInstallStorage.setupState.dictionaries?.outcomes) === "{}"
        && firstInstallStorage.setupState.dictionaries.totalSeconds === null
        && firstInstallStorage.setupState.dictionaries.continued === false
        && JSON.stringify(firstInstallStorage.setupState.dictionaries.selectionsApplied) === "[]"
        && (firstInstallStorage.dictionaryState?.dictionaries?.length ?? 0) === 0
        && JSON.stringify(Object.keys(seededOptions).sort()) === JSON.stringify(
          ["compactDefinitionSummaryCount", "popupTheme", "revision", "showCompactDefinitionSummary"],
        )
        && seededOptions.popupTheme === "auto"
        && seededOptions.showCompactDefinitionSummary === true && seededOptions.compactDefinitionSummaryCount === 2
        && seededOptions.revision === 1
        && effective.popupTheme === "auto" && effective.popupOpacityPercent === 85
        && effective.audioAutoplay === false
        && JSON.stringify(effective.audioSources?.map((source) => [source.type, source.enabled]))
          === JSON.stringify([["text-to-speech-reading", true]])
        && JSON.stringify(setupArchives.requests) === JSON.stringify(["jitendex"]),
      JSON.stringify({ startupTabs: startupTabs(), skippedToSetup, seededInSettings, startupShell, settingsPalette, firstInstallStorage, requests: setupArchives.requests }),
    );
  });

  step("Settings offers Resume setup while setup is incomplete", async () => {
    const resumeVisible = await page.evaluate(() => {
      const link = document.getElementById("setup-resume");
      return {
        hidden: link?.hidden, visible: link?.checkVisibility() === true, href: link?.href ?? "",
        insideNavigation: link?.closest(".settings-nav") !== null, text: link?.textContent?.trim() ?? "",
      };
    });
    check(
      "Settings shows Resume setup while first-run setup is incomplete",
      resumeVisible.hidden === false && resumeVisible.visible && resumeVisible.href === startupUrl
        && !resumeVisible.insideNavigation && resumeVisible.text === "Resume setup",
      JSON.stringify(resumeVisible),
    );
  });

  step("a reconnecting startup page rejoins the running installer", async () => {
    // The user turns the seeded compact summary off through the revisioned options
    // write Settings uses; the edit must be the value that persists, and the
    // remaining assertions keep their historical popup layout. The Design view is
    // left unopened so its lazy-preview assertion below still starts cold.
    editedPreference = await page.evaluate(async () => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        requestId: "first-run-edit", baseRevision: options.revision, options: { showCompactDefinitionSummary: false } });
      return reply.ok ? reply.options : { error: reply.error };
    });

    // A reconnecting page rejoins the same run: the held request is still the only one.
    let reconnected = null;
    if (startup !== null) {
      await startup.reload({ waitUntil: "domcontentloaded" });
      reconnected = await waitStartup((state) => state.rows[0]?.[1]?.startsWith("Downloading"), 30_000);
    }
    const setupStateWhileHeld = await page.evaluate(async () => (await chrome.storage.local.get("setupState")).setupState);
    check(
      "a reconnecting startup page rejoins the running installer whose held download stays indeterminate",
      reconnected?.heading === "Installing default dictionaries…"
        && JSON.stringify(reconnected.rows[0]) === JSON.stringify(["jitendex", "Downloading… 0 KB", false, "Downloading… 0 KB"])
        && reconnected.rows.slice(1).every((row) => row[1] === "Waiting")
        && JSON.stringify(setupArchives.requests) === JSON.stringify(["jitendex"])
        && JSON.stringify(setupStateWhileHeld?.dictionaries?.outcomes) === JSON.stringify({})
        && startupTabs() === 1,
      JSON.stringify({ reconnected, requests: setupArchives.requests, setupStateWhileHeld }),
    );
  });

  step("the installer continues after a mocked failure", async () => {
    // Release the held archive: Jitendex and Jiten arrive with a declared length,
    // Bee's without one, and jmnedict's publisher fails once. The installer's
    // broadcasts are recorded in the page so phase order does not depend on
    // polling luck; the polled rows still show what the user saw.
    if (startup !== null) {
      await startup.evaluate(() => {
        window.__setupEvents = [];
        chrome.runtime.onMessage.addListener((message) => {
          if (message?.target === "hachidori-setup-events") window.__setupEvents.push(message);
        });
        // Every render of the rows, not only the ones a poll happens to catch.
        window.__rowLog = [];
        const rows = () => [...document.querySelectorAll(".setup-dictionary")].map((row) => [row.dataset.sourceId,
          row.querySelector(".setup-dictionary-status")?.textContent ?? "",
          row.querySelector(".setup-track:not([hidden])")?.classList.contains("is-determinate") ?? null,
          row.querySelector(".setup-track:not([hidden])")?.getAttribute("aria-valuenow") ?? row.querySelector(".setup-track:not([hidden])")?.getAttribute("aria-valuetext") ?? null]);
        new MutationObserver(() => window.__rowLog.push(rows())).observe(document.getElementById("setup-body"), { childList: true, subtree: true, characterData: true });
      });
    }
    setupArchives.release();
    const phases = [];
    const runOutcome = startup === null ? null : await (async () => {
      const deadline = Date.now() + 120_000;
      let last = null;
      while (Date.now() < deadline) {
        const state = await startup.evaluate(readStartup).catch(() => null);
        if (state !== null) {
          const key = JSON.stringify(state.rows);
          if (phases.at(-1)?.key !== key) phases.push({ key, rows: state.rows, heading: state.heading, status: state.status });
          last = state;
          if (state.heading.startsWith("Some dictionaries")) return state;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return last;
    })();
    const rowLog = startup === null ? [] : await startup.evaluate(() => window.__rowLog ?? []);
    const seenPhase = (sourceId, predicate) => rowLog.some((rows) => rows.some((row) => row[0] === sourceId && predicate(row)));
    const setupEvents = startup === null ? [] : await startup.evaluate(() => window.__setupEvents ?? []);
    const entryEvents = (sourceId) => setupEvents.map((event) => event.entries.find((entry) => entry.sourceId === sourceId)).filter(Boolean);
    const phaseOrder = (sourceId) => [...new Set(entryEvents(sourceId).map((entry) => entry.phase))];
    const jitendexBytes = setupArchives.fixtures.get(RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "jitendex").downloadUrl).body.length;
    afterRun = await page.evaluate(async () => chrome.storage.local.get(["setupState", "options", "dictionaryState"]));
    const runOutcomes = afterRun.setupState?.dictionaries?.outcomes ?? {};
    const installedTitles = (afterRun.dictionaryState?.dictionaries ?? []).map((dictionary) => [dictionary.sourceId, dictionary.title]).sort();
    check(
      "the automatic installer continues after a mocked failure through real download and installation phases",
      runOutcome?.heading === "Some dictionaries could not be installed"
        && JSON.stringify(runOutcome.rows.map((row) => [row[0], row[1].replace(/\d+(\.\d+)? seconds/u, "N seconds")])) === JSON.stringify([
          ["jitendex", "Installed in N seconds"],
          ["jmnedict", "Failed: JMnedict.zip: reading the archive failed. could not read JMnedict.zip: HTTP 503"],
          ["bees-ultimate-kanji-dictionary", "Installed in N seconds"],
          ["jiten", "Installed in N seconds"],
          ["bees-ultimate-grammar-dictionary", "Installed in N seconds"],
        ])
        && JSON.stringify(runOutcome.actions) === JSON.stringify([["setup-retry", "Retry missing dictionaries"], ["setup-continue", "Continue setup"]])
        && runOutcome.countdown === null && runOutcome.importLink
        // Each installed entry moved waiting → downloading → installing → installed in order (Jitendex was
        // already downloading when recording began); the declared length made Jitendex's download
        // comparable while Bee's stayed indeterminate.
        && JSON.stringify(phaseOrder("jitendex")) === JSON.stringify(["downloading", "installing", "installed"])
        && JSON.stringify(phaseOrder("bees-ultimate-kanji-dictionary")) === JSON.stringify(["waiting", "downloading", "installing", "installed"])
        && JSON.stringify(phaseOrder("jmnedict")) === JSON.stringify(["waiting", "downloading", "failed"])
        && entryEvents("jitendex").filter((entry) => entry.phase === "downloading").every((entry) => entry.totalBytes === null || entry.totalBytes === jitendexBytes)
        && entryEvents("jitendex").some((entry) => entry.phase === "downloading" && entry.totalBytes === jitendexBytes && entry.receivedBytes === jitendexBytes)
        && entryEvents("bees-ultimate-kanji-dictionary").every((entry) => entry.totalBytes === null)
        && entryEvents("bees-ultimate-kanji-dictionary").some((entry) => entry.phase === "downloading" && entry.receivedBytes > 0)
        // The rows the user saw: a determinate percentage for Jitendex, received bytes only for Bee's.
        && seenPhase("jitendex", (row) => row[2] === true && /\(\d+%\)$/u.test(row[1]))
        && !seenPhase("bees-ultimate-kanji-dictionary", (row) => row[2] === true)
        && seenPhase("bees-ultimate-kanji-dictionary", (row) => /^Downloading… [\d.]+ (KB|MB)$/u.test(row[1]) && row[3] === row[1])
        && JSON.stringify(setupArchives.requests) === JSON.stringify(RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId))
        && ["jitendex", "bees-ultimate-kanji-dictionary", "jiten", "bees-ultimate-grammar-dictionary"].every((sourceId) => runOutcomes[sourceId]?.status === "installed" && runOutcomes[sourceId].seconds > 0)
        && runOutcomes.jmnedict?.status === "failed" && runOutcomes.jmnedict.error === "JMnedict.zip: reading the archive failed. could not read JMnedict.zip: HTTP 503"
        && afterRun.setupState.dictionaries.totalSeconds > 0 && afterRun.setupState.dictionaries.continued === false
        && afterRun.setupState.stage === "dictionaries"
        && JSON.stringify(installedTitles) === JSON.stringify(RECOMMENDED_DICTIONARIES.filter(({ sourceId }) => sourceId !== "jmnedict")
          .map(({ sourceId, title }) => [sourceId, title]).sort())
        && startupTabs() === 1,
      JSON.stringify({ runOutcome, rowLog, phases: phases.map(({ rows, status }) => [rows, status]), afterRun, requests: setupArchives.requests,
        phaseOrders: RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId).map(phaseOrder), events: setupEvents.length }),
    );
  });

  step("Retry installs only the missing dictionary", async () => {
    // Settings keeps the catalogue and the missing-only retry available during partial setup.
    const settingsAfterRun = await page.evaluate(() => ({
      starterHidden: document.getElementById("recommended-starter")?.hidden,
      retryHidden: document.getElementById("recommended-retry")?.hidden,
    }));
    const jitendexTitle = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "jitendex").title;
    const beesTitle = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "bees-ultimate-kanji-dictionary").title;
    // The first-run Anki check begins immediately after the retry completes, so
    // refuse it before releasing that transition. A real Anki or another suite's
    // mock server on this port cannot decide the outcome.
    ankiRefused = { requests: 0, fail: "ConnectionRefused" };
    ankiOffline = await interceptFetches(
      await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().endsWith("/background.js")),
      new Map([["http://127.0.0.1:8765/", ankiRefused]]), "anki offline");
    retried = null;
    successShownAt = 0;
    if (startup !== null) {
      await startup.bringToFront();
      // Dictionary success and both Anki headings are transient. Record every
      // painted state before Retry rather than relying on polling luck.
      await startup.evaluate(() => {
        window.__headingLog = [];
        window.__dictionarySuccessLog = [];
        const record = () => {
          const text = document.getElementById("setup-heading")?.textContent ?? "";
          if (window.__headingLog.at(-1)?.text !== text) {
            window.__headingLog.push({
              text,
              at: Date.now(),
              focused: document.activeElement?.id ?? "",
              step: document.querySelector('.setup-step[aria-current="step"]')?.dataset.stage ?? null,
              done: document.querySelectorAll(".setup-step.is-done").length,
              actions: [...document.querySelectorAll("#setup-actions button")].map((control) => control.id),
              outcome: document.querySelector(".setup-anki-outcome")?.dataset.status ?? null,
              ankiLink: document.querySelector('#setup-body a[href="settings.html#anki"]') !== null,
              countdown: document.getElementById("setup-countdown-label")?.textContent ?? null,
            });
          }
          if (text.startsWith("All dictionaries installed")) {
            const state = {
              at: Date.now(),
              heading: text,
              rows: [...document.querySelectorAll(".setup-dictionary")].map((row) => [
                row.dataset.sourceId,
                row.querySelector(".setup-dictionary-status")?.textContent ?? "",
              ]),
              actions: [...document.querySelectorAll("#setup-actions button")].map((control) => [control.id, control.textContent]),
              countdown: document.getElementById("setup-countdown-label")?.textContent ?? null,
              importLink: document.querySelector('#setup-body a[href="settings.html#add-dictionaries"]') !== null,
            };
            const signature = JSON.stringify([state.heading, state.rows, state.actions, state.countdown, state.importLink]);
            if (window.__dictionarySuccessLog.at(-1)?.signature !== signature) {
              window.__dictionarySuccessLog.push({ ...state, signature });
            }
          }
        };
        record();
        new MutationObserver(record).observe(document.getElementById("setup-card"),
          { childList: true, subtree: true, characterData: true });
      });
      await clickStartupControl("setup-retry");
      retried = await startup.waitForFunction(() => window.__dictionarySuccessLog?.at(-1) ?? false,
        { timeout: 60_000, polling: 20 }).then((handle) => handle.jsonValue()).catch(() => null);
      successShownAt = retried?.at ?? 0;
    }
    const afterRetry = await page.evaluate(async () => chrome.storage.local.get(["setupState", "options", "dictionaryState"]));
    const retryOutcomes = afterRetry.setupState?.dictionaries?.outcomes ?? {};
    check(
      "Retry installs only the missing dictionary and the committed entries settle their selections once",
      settingsAfterRun.starterHidden === false && settingsAfterRun.retryHidden === false
        // Everything after the first pass over the whole catalogue: only the source
        // that failed is requested again.
        && JSON.stringify(setupArchives.requests.slice(RECOMMENDED_DICTIONARIES.length))
          === JSON.stringify(["jmnedict"])
        && retried?.heading === `All dictionaries installed in ${afterRetry.setupState.dictionaries.totalSeconds < 10
          ? afterRetry.setupState.dictionaries.totalSeconds.toFixed(1) : Math.round(afterRetry.setupState.dictionaries.totalSeconds)} seconds`
        && retried.rows.every((row) => /^Installed in \d+(\.\d+)? seconds$/u.test(row[1]))
        && retried.actions.length === 0 && retried.importLink && retried.countdown === null
        && retryOutcomes.jmnedict?.status === "installed" && retryOutcomes.jmnedict.seconds > 0
        && retryOutcomes.jitendex?.status === "installed"
        && afterRetry.setupState.dictionaries.totalSeconds > afterRun.setupState.dictionaries.totalSeconds
        && JSON.stringify(afterRetry.setupState.dictionaries.selectionsApplied) === JSON.stringify(["jitendex", "bees-ultimate-kanji-dictionary"])
        && afterRetry.options.compactDefinitionSummaryDictionary === jitendexTitle
        && afterRetry.options.kanjiClickDictionary?.title === beesTitle && afterRetry.options.kanjiClickDictionary.kind === "term"
        && afterRetry.options.showCompactDefinitionSummary === false
        && (afterRetry.dictionaryState?.dictionaries ?? []).length === RECOMMENDED_DICTIONARIES.length,
      JSON.stringify({ settingsAfterRun, retried, afterRetry, requests: setupArchives.requests }),
    );
  });

  step("the all-installed result advances to the Anki check", async () => {
    practiceReached = null;
    if (startup !== null) {
      // The final step waits for Finish. Wait for its asynchronous reader load to
      // complete the automatic selection too, rather than sampling the heading
      // focus from the first practice render.
      practiceReached = await startup.waitForFunction(() => document.getElementById("setup-practice-instruction")?.textContent.startsWith("Try looking up a word below.")
        && document.activeElement?.id === "setup-practice-text"
        && getSelection().toString() === "辞書"
        ? { at: Date.now(), focused: document.activeElement?.id ?? "",
          currentStep: document.querySelector('.setup-step[aria-current="step"]')?.dataset.stage ?? null,
          done: document.querySelectorAll(".setup-step.is-done").length,
          body: document.getElementById("setup-body")?.textContent ?? "",
          outcome: document.querySelector(".setup-anki-outcome")?.dataset.status ?? null,
          outcomeText: document.querySelector(".setup-anki-outcome")?.textContent ?? "",
          outcomeLink: document.querySelector('.setup-anki-outcome a[href="https://apps.ankiweb.net/"]') !== null,
          status: document.getElementById("setup-status")?.textContent ?? "",
          actions: [...document.querySelectorAll("#setup-actions button")].map((control) => control.id) } : false,
      { timeout: 30_000, polling: 50 }).then((handle) => handle.jsonValue()).catch(() => null);
    }
    headingLog = startup === null ? [] : await startup.evaluate(() => window.__headingLog ?? []);
    painted = (text) => headingLog.find((entry) => entry.text === text) ?? null;
    const checkingAnki = painted("Finding your Anki setup…");
    ankiStage = await page.evaluate(async () => (await chrome.storage.local.get("setupState")).setupState);
    check(
      "the all-installed result advances immediately before setup checks for Anki",
      retried?.countdown === null && retried.actions.length === 0
        && checkingAnki !== null && checkingAnki.at - successShownAt >= 0 && checkingAnki.at - successShownAt < 1500
        && checkingAnki.focused === "setup-heading" && checkingAnki.step === "anki" && checkingAnki.done === 1
        && JSON.stringify(checkingAnki.actions) === JSON.stringify(["setup-continue"])
        && ankiStage?.dictionaries.continued === false,
      JSON.stringify({ retried, checkingAnki, successShownAt, headingLog, ankiStage }),
    );
  });

  step("startup practice", async () => {
    // Nothing answers AnkiConnect on this host, so the ordinary absence is
    // recorded once, held long enough to read, then setup continues.
    settledAnki = painted("Could not find Anki");
    if (startup && (process.env.HACHIDORI_STARTUP_READY_SCREENSHOT || process.env.HACHIDORI_STARTUP_READY_DARK_SCREENSHOT)) {
      await startup.setViewport({ width: 1200, height: 1000 });
      for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_READY_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_READY_DARK_SCREENSHOT]]) {
        if (!path) continue;
        await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await startup.screenshot({ path, fullPage: true });
      }
      await startup.emulateMediaFeatures([]);
    }

    if (startup) await checkStartupPractice(startup, browser, startupUrl);
  });

  step("the practice scene looks a word up through the real reader", async () => {
    // The dictionary-dependent selections were applied once; the user now returns
    // both to Automatic, and lookups to plain hover, so the remaining assertions
    // keep their historical options.
    await page.evaluate(async () => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        requestId: "first-run-reset", baseRevision: options.revision,
        options: { compactDefinitionSummaryDictionary: "", kanjiClickDictionary: "", lookupMode: "hover" } });
      if (!reply.ok) throw new Error(reply.error);
    });

    // The final step runs the real reader on the startup page: its own packaged
    // scripts, the dictionaries this setup just installed, the ordinary runtime
    // lookup and the same closed-shadow popup a webpage gets.
    let exercise = null;
    if (startup !== null) {
      await startup.bringToFront();
      await startup.setViewport({ width: 320, height: 900 });
      await startup.$eval("#setup-practice-scene", scene => scene.scrollIntoView({ block: "center" }));
      await startup.waitForFunction(() => {
        const next = document.querySelector(".vn-next");
        const rect = next?.getBoundingClientRect();
        return rect?.width > 0 && rect.height > 0
          && next.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }, { timeout: 6000, polling: 50 });
      const narrowScene = await readVisualNovelScene(startup, "#setup-practice-text");
      const cycled = await cycleVisualNovelScene(startup, "#setup-practice-text", true);
      await startup.setViewport({ width: 1200, height: 1000 });
      const startupPopup = await popupReader(startup);
      const injected = await startup.waitForFunction(() => {
        const sources = [...document.querySelectorAll("script[data-setup-reader]")].map((script) => script.getAttribute("src"));
        return sources.includes("content.js") ? sources : false;
      }, { timeout: 30_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => null);
      // Reuse the reviewed scene's dictionary word, aiming at its own rectangle.
      await startup.keyboard.press("Escape");
      await startup.evaluate(() => window.getSelection().removeAllRanges());
      let looked = null;
      const startedLookup = Date.now();
      for (let attempt = 0; attempt < 12 && looked === null; attempt += 1) {
        await hoverPracticeCharacter(startup, 0);
        looked = await startupPopup.waitForVisible(2000);
      }
      // Chrome reports no Resource Timing for extension-scheme subresources, so
      // what the step costs is measured where it is visible: the hover that answers.
      console.log(`     practice lookup answered in ${Date.now() - startedLookup} ms`);
      const scene = await readVisualNovelScene(startup, "#setup-practice-word");
      const popupRect = looked === null ? null : (await startupPopup.nested())?.rect;
      if (looked !== null && (process.env.HACHIDORI_STARTUP_PRACTICE_SCREENSHOT || process.env.HACHIDORI_STARTUP_PRACTICE_DARK_SCREENSHOT)) {
        await startup.setViewport({ width: 1200, height: 1000 });
        for (const [scheme, path] of [["light", process.env.HACHIDORI_STARTUP_PRACTICE_SCREENSHOT], ["dark", process.env.HACHIDORI_STARTUP_PRACTICE_DARK_SCREENSHOT]]) {
          if (!path) continue;
          await startup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
          await hoverPracticeCharacter(startup, 0);
          await startupPopup.waitForVisible(2000);
          await startup.screenshot({ path, fullPage: true });
        }
        await startup.emulateMediaFeatures([]);
      }
      await startup.mouse.move(2, 2);
      const hidden = looked === null ? null : await startupPopup.waitForHidden(6000);
      const idleScene = await readVisualNovelScene(startup, "#setup-practice-word");
      exercise = { injected, looked, hidden, scene, narrowScene, idleScene, popupRect, cycled };
    }
    const jitendexFixtureTitle = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "jitendex").title;
    check(
      "the practice visual novel scene fits narrow screens and looks a word up through the real reader and installed dictionaries",
      JSON.stringify(exercise?.injected) === JSON.stringify(READER_SCRIPTS)
        && exercise.looked !== null && exercise.looked.plain.includes("辞書")
        && exercise.looked.text.includes(`${jitendexFixtureTitle} term fixture`)
        && exercise.hidden === true && exercise.cycled
        && exercise.narrowScene.nextVisible && exercise.idleScene.nextVisible
        && [exercise.scene, exercise.narrowScene].every(scene => scene?.backgroundLoaded && scene.dialogueVisible
          && scene.sourceAccessible && !scene.overflow)
        && exercise.scene.highlighted === "辞書" && exercise.popupRect?.bottom <= exercise.scene.sourceTop
        && exercise.popupRect.top < exercise.scene.dialogueTop,
      JSON.stringify(exercise),
    );
  });

  step("an absent Anki settles and setup finishes", async () => {
    let closedTab = null;
    if (startup !== null) {
      await startup.bringToFront();
      const startupClosed = new Promise((resolveClosed) => {
        const onDestroyed = (target) => {
          if (target.url() === startupUrl) { browser.off("targetdestroyed", onDestroyed); resolveClosed(true); }
        };
        browser.on("targetdestroyed", onDestroyed);
        setTimeout(() => { browser.off("targetdestroyed", onDestroyed); resolveClosed(false); }, 15_000);
      });
      await clickStartupControl("setup-finish");
      closedTab = await startupClosed;
    }
    completedSetup = await page.waitForFunction(async () => {
      const { setupState } = await chrome.storage.local.get("setupState");
      return setupState?.stage === "complete" && document.getElementById("setup-resume")?.hidden === true
        ? setupState : false;
    }, { timeout: 10_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => null);
    check(
      "an absent Anki settles by itself and the startup page finishes setup, closes its tab and hides Resume setup",
      settledAnki !== null && settledAnki.step === "anki" && settledAnki.done === 1
        && settledAnki.outcome === "unavailable"
        && JSON.stringify(settledAnki.actions) === JSON.stringify(["setup-continue", "setup-pause"])
        && settledAnki.countdown === "Continuing to practice in 3 seconds"
        // Exactly one AnkiConnect attempt, and the absence is not asked about twice.
        && ankiRefused.requests === 1
        && ankiStage?.anki?.status === "unavailable" && ankiStage.anki.model === null && ankiStage.anki.deck === null
        && ankiStage.anki.detail.includes("Open Anki with the AnkiConnect add-on")
        // The outcome moved setup on by itself; the automatic demonstration
        // selects the sample text and keeps the outcome readable on the final step.
        && practiceReached?.focused === "setup-practice-text" && practiceReached.currentStep === "practice"
        && practiceReached.at - settledAnki.at >= 2800
        && practiceReached.done === 2 && practiceReached.status === "You’re ready."
        && practiceReached.outcome === "unavailable" && practiceReached.outcomeLink
        && practiceReached.outcomeText === "Could not find Anki. If you want to make flashcards out of words, I suggest Anki!"
        && practiceReached.body.includes("Try looking up a word below.")
        && practiceReached.body.includes("踏切の向こうから蝉の声が響く。")
        && JSON.stringify(practiceReached.actions) === JSON.stringify(["setup-finish"])
        && closedTab === true && startupTabs() === 0
        && typeof completedSetup?.completedAt === "string" && completedSetup.anki?.status === "unavailable"
        && JSON.stringify(Object.keys(completedSetup.dictionaries.outcomes).sort()) === JSON.stringify(RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId).sort())
        && editedPreference?.showCompactDefinitionSummary === false && editedPreference.revision === 2,
      JSON.stringify({ settledAnki, practiceReached, headingLog, completedSetup, editedPreference, closedTab,
        ankiRequests: ankiRefused.requests, startupTabs: startupTabs() }),
    );
    await ankiOffline.detach().catch(() => {});
    await page.bringToFront();
  });

  step("the reader refuses to run on Settings", async () => {
    // Only the startup page may run the reader. Loading the very same scripts into
    // Settings must leave it inert, so no internal page starts scanning text.
    const guarded = await (async () => {
      const other = await browser.newPage();
      try {
        await other.goto(settingsUrl, { waitUntil: "domcontentloaded" });
        const loaded = await other.evaluate(async (scripts) => {
          const sample = document.createElement("p");
          sample.id = "e2e-japanese";
          sample.style.cssText = "font: 32px/2 serif; padding: 40px";
          sample.textContent = "食べる";
          document.body.prepend(sample);
          for (const src of scripts) {
            await new Promise((resolve, reject) => {
              const script = document.createElement("script");
              script.src = src;
              script.addEventListener("load", () => { resolve(); });
              script.addEventListener("error", () => { reject(new Error(`${src} did not load`)); });
              document.head.appendChild(script);
            });
          }
          return true;
        }, READER_SCRIPTS).catch((error) => `${error?.message ?? error}`);
        const box = await (await other.$("#e2e-japanese")).boundingBox();
        await other.mouse.move(2, 2);
        await other.mouse.move(box.x + 20, box.y + box.height / 2);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return {
          loaded,
          popupHost: await other.evaluate(() => document.querySelector("hachidori-host") !== null),
          rendererLoaded: await other.evaluate(() => typeof window.HDPopup === "object"),
        };
      } finally {
        await other.close().catch(() => {});
      }
    })();
    check(
      "the reader refuses to run on Settings even when its own scripts are loaded there",
      guarded.loaded === true && guarded.rendererLoaded === true && guarded.popupHost === false,
      JSON.stringify(guarded),
    );
  });

  step("Remove all imported dictionaries", async () => {
    // Clear the mocked catalogue packages so the Settings installer below starts
    // from the same clean library it always did: first through Settings → Library →
    // Remove all imported dictionaries, with one package disabled and the others
    // hidden by a search. The setup mock stays attached so no later run can reach
    // the network, but must not answer Settings' own fetches.
    await page.bringToFront();
    await showSettingsSection(page, "dictionaries");
    const setupInstalled = await page.evaluate(async () =>
      (await chrome.storage.local.get("dictionaryState")).dictionaryState?.dictionaries ?? []);
    const disabledSetupId = setupInstalled[1]?.id;
    await page.evaluate((id) => {
      const enabled = document.querySelector(`.dict-row[data-dictionary-id="${id}"] .dict-enabled`);
      enabled.checked = false;
      enabled.dispatchEvent(new Event("change", { bubbles: true }));
    }, disabledSetupId);
    await page.waitForFunction(async (id) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      return dictionaryState?.dictionaries?.find(entry => entry.id === id)?.enabled === false
        && !document.getElementById("library-remove-all").disabled;
    }, { timeout: 30_000, polling: 100 }, disabledSetupId).catch(() => {});
    await page.evaluate((title) => {
      const search = document.getElementById("dict-search");
      search.value = title;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }, setupInstalled[0]?.title);
    const searchVisibleRows = await page.$$eval("#dict-list .dict-row", rows => rows.length);
    let removeAllDialog = null;
    const acceptRemoveAll = async (dialog) => { removeAllDialog = dialog.message(); await dialog.accept(); };
    page.on("dialog", acceptRemoveAll);
    await page.click("#library-remove-all");
    const removeAllOutcome = await page.waitForFunction(() => {
      const status = document.getElementById("library-reset-status");
      return status.classList.contains("is-ready") || status.classList.contains("is-error") ? status.textContent : false;
    }, { timeout: 120_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(error => `no outcome: ${error.message}`);
    page.off("dialog", acceptRemoveAll);
    const afterRemoveAll = await page.evaluate(async () =>
      (await chrome.storage.local.get("dictionaryState")).dictionaryState?.dictionaries?.map(entry => entry.title) ?? null);
    check(
      "Remove all imported dictionaries clears disabled and search-hidden packages through the real engine after one confirmation",
      setupInstalled.length === RECOMMENDED_DICTIONARIES.length
        && searchVisibleRows > 0 && searchVisibleRows < setupInstalled.length
        && removeAllDialog?.startsWith(`Remove ${setupInstalled.length} imported dictionaries?`)
        && removeAllDialog.includes("including disabled ones and any the search hides")
        && removeAllOutcome === `Removed ${setupInstalled.length} dictionaries.`
        && afterRemoveAll?.length === 0,
      JSON.stringify({ setupInstalled: setupInstalled.map(({ title, enabled }) => ({ title, enabled })),
        searchVisibleRows, removeAllDialog, removeAllOutcome, afterRemoveAll }),
    );
    await page.evaluate(() => {
      const search = document.getElementById("dict-search");
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Whatever that check left behind is removed directly, so a failure there
    // cannot change the starting library of the checks below.
    for (const { title } of RECOMMENDED_DICTIONARIES) {
      const removed = await page.evaluate((dictionaryTitle) => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_remove",
        requestId: `e2e-remove-setup-${dictionaryTitle}`,
        title: dictionaryTitle,
      }), title);
      if (removed?.ok !== true) {
        throw new Error(`could not clear the setup-installed dictionary ${title}: ${JSON.stringify(removed)}`);
      }
    }
    await page.waitForFunction(async () => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      return dictionaryState?.dictionaries?.length === 0
        && document.getElementById("recommended-starter")?.hidden === false;
    }, { timeout: 90_000, polling: 100 });
    setupRequestsAfterSetup = setupArchives.requests.length;
    setupArchives.routes = null;
  });
});

export { completedSetup, setupRequestsAfterSetup, startupTabs, startupUrl };
