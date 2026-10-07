/*
 * Recommended dictionaries in Settings and the offscreen engine they install into.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./settings.mjs";
import { describe } from "node:test";
import { buildRecommendedZip } from "../make-fixture.mjs";
import { check, report, step } from "./harness.mjs";
import {
  browser,
  page,
  RECOMMENDED_DICTIONARIES,
  server,
  setupArchives,
  showSettingsSection,
} from "./session.mjs";

const RECOMMENDED_LINKS = RECOMMENDED_DICTIONARIES.map(({ name, publisherUrl }) => [name, publisherUrl]);

// Values that more than one step uses; the step that creates each one assigns it.
let recommendedRequests, releaseRecommended;

describe("recommended dictionaries", () => {
  step("recommended dictionaries on a desktop page", async () => {
    await showSettingsSection(page, "add-dictionaries");

    await page.waitForFunction((expectedCount) =>
      document.querySelectorAll("#recommended-dictionary-list > li").length === expectedCount
        && document.getElementById("recommended-starter")?.hidden === false,
    { timeout: 90_000, polling: 100 }, RECOMMENDED_DICTIONARIES.length).catch(() => {});
    await page.setViewport({ width: 960, height: 900 });
    const desktopRecommendations = await page.evaluate(() => {
      const list = document.querySelector(".recommended-dictionary-list");
      const items = list ? [...list.children] : [];
      return {
        columns: list ? getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
        links: [...document.querySelectorAll("a.recommended-dictionary-link")].map(anchor => [
          anchor.textContent.trim(),
          anchor.href,
          anchor.target,
          anchor.rel,
        ]),
        rects: items.map(item => {
          const rect = item.getBoundingClientRect();
          return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
        }),
      };
    });
    const desktopLinks = desktopRecommendations.links.map(([name, url]) => [name, url]);
    check(
      "settings page renders exactly five safe recommended dictionary links",
      JSON.stringify(desktopLinks) === JSON.stringify(RECOMMENDED_LINKS)
        && desktopRecommendations.links.every(([, , target, rel]) =>
          target === "_blank" && rel.split(/\s+/u).includes("noopener") && rel.split(/\s+/u).includes("noreferrer")),
      JSON.stringify(desktopRecommendations.links),
    );
    const desktopRects = desktopRecommendations.rects;
    check(
      "recommended dictionaries form a readable list on desktop",
      desktopRecommendations.columns === 1
        && desktopRects.length === RECOMMENDED_LINKS.length
        && desktopRects.every((rect, index) => rect.right > rect.left
          && (index === 0 || rect.top >= desktopRects[index - 1].bottom)),
      JSON.stringify(desktopRecommendations),
    );
  });

  step("recommended dictionaries on a narrow page", async () => {
    await page.setViewport({ width: 480, height: 900 });
    const narrowRecommendations = await page.evaluate(() => {
      const list = document.querySelector(".recommended-dictionary-list");
      const items = list ? [...list.children] : [];
      const listRect = list?.getBoundingClientRect();
      return {
        columns: list ? getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
        documentWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        list: listRect ? { left: listRect.left, right: listRect.right } : null,
        rects: items.map(item => {
          const rect = item.getBoundingClientRect();
          return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
        }),
      };
    });
    check(
      "recommended dictionaries stack without overflow on narrow screens",
      narrowRecommendations.columns === 1
        && narrowRecommendations.rects.length === RECOMMENDED_LINKS.length
        && narrowRecommendations.scrollWidth <= narrowRecommendations.documentWidth
        && narrowRecommendations.rects.every((rect, index, rects) =>
          rect.left >= narrowRecommendations.list.left - 1
            && rect.right <= narrowRecommendations.list.right + 1
            && (index === 0 || rect.top >= rects[index - 1].bottom)),
      JSON.stringify(narrowRecommendations),
    );
    await page.setViewport({ width: 800, height: 600 });
  });

  step("the offscreen document compiles the wasm", async () => {
    // The offscreen document is where the wasm is compiled. If the CSP forbids it,
    // or chrome.offscreen misbehaves, the engine never reaches a ready state and
    // this is the assertion that catches it.
    let statusText = "";
    const ready = await page.waitForFunction(() => {
      const el = document.getElementById("engine-status");
      const t = (el?.textContent || "").toLowerCase();
      return t.includes("ready") || t.includes("no dictionaries") || t.includes("error") || t.includes("fail")
        ? t : false;
    }, { timeout: 90_000, polling: 500 }).then(h => h.jsonValue()).catch(() => null);
    statusText = ready || "(never settled)";
    const engineUp = !!ready && !ready.includes("error") && !ready.includes("fail");
    check("offscreen document compiles the wasm under the extension CSP", engineUp,
      `#engine-status settled on: ${statusText}`);

    const threadPrerequisites = await page.evaluate(() => ({
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
    }));
    check("extension pages expose pthread prerequisites",
      threadPrerequisites.crossOriginIsolated && threadPrerequisites.sharedArrayBuffer,
      `thread prerequisites: ${JSON.stringify(threadPrerequisites)}`);

    const offscreenExists = await page.evaluate(async () =>
      (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length);
    check("chrome.offscreen.createDocument produced exactly one offscreen document",
      offscreenExists === 1, `getContexts returned ${offscreenExists}`);

    if (!engineUp) {
      await browser.close();
      server.close();
      return report();
    }

    if (process.env.HACHIDORI_SETTINGS_SCREENSHOT) {
      const importCard = await page.$('section[aria-labelledby="import-heading"]');
      await importCard.screenshot({ path: process.env.HACHIDORI_SETTINGS_SCREENSHOT });
    }
  });

  step("a Settings-started batch survives a reload", async () => {
    recommendedRequests = [];
    const recommendedAttempts = new Map();
    const heldRecommended = new Promise(resolveHeld => { releaseRecommended = resolveHeld; });
    const recommendedRoutes = new Map(RECOMMENDED_DICTIONARIES.map(entry => [entry.downloadUrl, {
      requests: 0,
      async respond() {
        const attempt = (recommendedAttempts.get(entry.sourceId) ?? 0) + 1;
        recommendedAttempts.set(entry.sourceId, attempt);
        recommendedRequests.push(entry.sourceId);
        if (entry.sourceId === "jitendex" && attempt === 1) await heldRecommended;
        return entry.sourceId === "jmnedict" && attempt === 1
          ? { status: 503, contentType: "text/plain", body: "mocked publisher failure" }
          : { status: 200, contentType: "application/zip", body: buildRecommendedZip(entry) };
      },
    }]));
    setupArchives.routes = recommendedRoutes;

    await page.click("#install-recommended");
    await page.waitForFunction(() => document.getElementById("import-state")?.textContent.includes("You can close this page."));
    const beforeReload = await page.evaluate(() => chrome.runtime.sendMessage({
      target: "hachidori-setup", type: "hd_setup_install", sourceIds: [], requestId: "observe-settings-run",
    }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("import-state")?.textContent.includes("You can close this page."));
    const afterReload = await page.evaluate(() => chrome.runtime.sendMessage({
      target: "hachidori-setup", type: "hd_setup_install", sourceIds: [], requestId: "observe-settings-run-after-reload",
    }));
    check("a Settings-started recommended batch survives reloading its page without duplicate downloads",
      beforeReload.ok && beforeReload.runId === afterReload.runId && !afterReload.finished
        && recommendedAttempts.get("jitendex") === 1, JSON.stringify({ beforeReload, afterReload, recommendedRequests }));
  });

  step("the installer continues after a mocked download failure", async () => {
    if (process.env.HACHIDORI_RECOMMENDED_SCREENSHOT) {
      await page.setViewport({ width: 1280, height: 1000 });
      await page.screenshot({ path: process.env.HACHIDORI_RECOMMENDED_SCREENSHOT });
      await page.setViewport({ width: 800, height: 600 });
    }
    releaseRecommended();
    // The count is derived from the catalogue and passed IN: this predicate runs in
    // the page, where the Node-side catalogue does not exist, and a hardcoded count
    // would silently stop settling the moment a source is added.
    const recommendedFirstState = await page.waitForFunction((total) => {
      const text = document.getElementById("import-state")?.textContent?.trim() ?? "";
      return text.startsWith(`Finished ${total} of ${total} recommended dictionaries`) ? text : false;
    }, { timeout: 120_000, polling: 100 }, RECOMMENDED_DICTIONARIES.length)
      .then((handle) => handle.jsonValue()).catch(() => "(never settled)");
    const recommendedFirst = await page.evaluate(() => ({
      state: document.getElementById("import-state")?.textContent?.trim() ?? "",
      sharedRows: document.querySelector("#import-progress .setup-dictionary-list")
        ?.getAttribute("aria-label") === "Dictionary import progress",
      starterHidden: document.getElementById("recommended-starter")?.hidden,
      retryHidden: document.getElementById("recommended-retry")?.hidden,
      localInputVisible: document.getElementById("import-file")?.closest(".file-button")?.hidden !== true,
      outcomes: [...document.querySelectorAll("#import-progress .setup-dictionary")].map((item) => ({
        text: item.querySelector(".setup-dictionary-status")?.textContent?.trim() ?? "",
        error: item.querySelector(".setup-dictionary-status")?.classList.contains("is-error") === true,
      })),
    }));
    const recommendedFirstStorage = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
    const firstRecommendedPackages = recommendedFirstStorage.dictionaryState?.dictionaries ?? [];
    check(
      "the recommended installer continues after a mocked download failure",
      recommendedFirstState === `Finished ${RECOMMENDED_DICTIONARIES.length} of `
        + `${RECOMMENDED_DICTIONARIES.length} recommended dictionaries`
        + ` — ${RECOMMENDED_DICTIONARIES.length - 1} imported, 1 failed.`
        && JSON.stringify(recommendedRequests) === JSON.stringify(
          RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId),
        )
        && recommendedFirst.sharedRows === true
        && recommendedFirst.starterHidden === false
        && recommendedFirst.retryHidden === false
        && recommendedFirst.localInputVisible === true
        && recommendedFirst.outcomes.length === RECOMMENDED_DICTIONARIES.length
        // Only jmnedict's download is mocked to fail; every other source imports.
        && JSON.stringify(recommendedFirst.outcomes.map(({ error }) => error))
          === JSON.stringify(RECOMMENDED_DICTIONARIES.map(({ sourceId }) => sourceId === "jmnedict"))
        && recommendedFirst.outcomes.every(({ text, error }) => error ? text.includes("HTTP 503") : /\d+(?:\.\d)? seconds/u.test(text))
        && firstRecommendedPackages.length === RECOMMENDED_DICTIONARIES.length - 1
        && firstRecommendedPackages.every((dictionary) => {
          const entry = RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === dictionary.sourceId);
          return entry
            && dictionary.title === entry.title
            && dictionary.revision === entry.revision
            && dictionary.isUpdatable === (entry.indexUrl !== null)
            && dictionary.indexUrl === entry.indexUrl
            && dictionary.downloadUrl === entry.downloadUrl;
        }),
      `${recommendedFirstState}; UI: ${JSON.stringify(recommendedFirst)}; requests: ${JSON.stringify(recommendedRequests)};`
        + ` state: ${JSON.stringify(recommendedFirstStorage.dictionaryState)}`,
    );
  });

  step("missing dictionaries stay available after a reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    // Everything but the source whose download was mocked to fail is in the library.
    const installedAfterFailure = RECOMMENDED_DICTIONARIES.length - 1;
    const reloadedRecommended = await page.waitForFunction((expected) => {
      const rows = document.querySelectorAll("#dict-list .dict-row").length;
      return rows === expected ? {
        rows,
        starterHidden: document.getElementById("recommended-starter")?.hidden,
        retryHidden: document.getElementById("recommended-retry")?.hidden,
        localInputVisible: document.getElementById("import-file")?.closest(".file-button")?.hidden !== true,
      } : false;
    }, { timeout: 90_000, polling: 100 }, installedAfterFailure)
      .then((handle) => handle.jsonValue()).catch(() => null);
    check(
      "missing recommended dictionaries stay available after a settings reload",
      reloadedRecommended?.rows === installedAfterFailure
        && reloadedRecommended.starterHidden === false
        && reloadedRecommended.retryHidden === false
        && reloadedRecommended.localInputVisible === true,
      JSON.stringify(reloadedRecommended),
    );
  });

  step("Retry downloads only the missing dictionary", async () => {
    const requestsBeforeRetry = recommendedRequests.length;
    await page.click("#retry-recommended");
    const recommendedRetryState = await page.waitForFunction(() => {
      const text = document.getElementById("import-state")?.textContent?.trim() ?? "";
      return text.startsWith("Finished 1 of 1 recommended dictionary") ? text : false;
    }, { timeout: 120_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => "(never settled)");
    const recommendedRetry = await page.evaluate(() => ({
      outcomes: [...document.querySelectorAll("#import-progress .setup-dictionary")].map((item) => ({
        name: item.querySelector(".setup-dictionary-name")?.textContent?.trim() ?? "",
        text: item.querySelector(".setup-dictionary-status")?.textContent?.trim() ?? "",
      })),
      retryHidden: document.getElementById("recommended-retry")?.hidden,
      state: document.getElementById("import-state")?.textContent?.trim() ?? "",
    }));
    const recommendedRetryStorage = await page.evaluate(() => chrome.storage.local.get("dictionaryState"));
    const allRecommendedPackages = recommendedRetryStorage.dictionaryState?.dictionaries ?? [];
    check(
      "recommended retry downloads only the missing trusted dictionary",
      recommendedRetryState === "Finished 1 of 1 recommended dictionary — 1 imported, 0 failed."
        && JSON.stringify(recommendedRequests.slice(requestsBeforeRetry)) === JSON.stringify(["jmnedict"])
        && recommendedRetry.outcomes.length === 1
        && recommendedRetry.outcomes[0].name
          === RECOMMENDED_DICTIONARIES.find(({ sourceId }) => sourceId === "jmnedict").name
        && /^Installed in \d+(?:\.\d)? seconds$/u.test(recommendedRetry.outcomes[0].text)
        && recommendedRetry.retryHidden === true
        && allRecommendedPackages.length === RECOMMENDED_DICTIONARIES.length
        && RECOMMENDED_DICTIONARIES.every((entry) => allRecommendedPackages.some((dictionary) =>
          dictionary.sourceId === entry.sourceId
            && dictionary.title === entry.title
            && dictionary.revision === entry.revision
            && dictionary.indexUrl === entry.indexUrl
            && dictionary.downloadUrl === entry.downloadUrl)),
      `${recommendedRetryState}; UI: ${JSON.stringify(recommendedRetry)}; requests: ${JSON.stringify(recommendedRequests)};`
        + ` state: ${JSON.stringify(recommendedRetryStorage.dictionaryState)}`,
    );

    if (process.env.HACHIDORI_LIBRARY_SCREENSHOT) {
      await showSettingsSection(page, "dictionaries");
      await page.setViewport({ width: 1280, height: 1100 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: process.env.HACHIDORI_LIBRARY_SCREENSHOT });
      if (process.env.HACHIDORI_LIBRARY_DARK_SCREENSHOT) {
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
        await page.screenshot({ path: process.env.HACHIDORI_LIBRARY_DARK_SCREENSHOT });
      }
      await page.emulateMediaFeatures([]);
      await page.setViewport({ width: 800, height: 600 });
    }

    for (const { title } of RECOMMENDED_DICTIONARIES) {
      const removed = await page.evaluate((dictionaryTitle) => chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_remove",
        requestId: `e2e-remove-recommended-${dictionaryTitle}`,
        title: dictionaryTitle,
      }), title);
      if (removed?.ok !== true) {
        throw new Error(`could not clear mocked recommended dictionary ${title}: ${JSON.stringify(removed)}`);
      }
    }
    await page.waitForFunction(async () => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      return dictionaryState?.dictionaries?.length === 0
        && document.getElementById("recommended-starter")?.hidden === false;
    }, { timeout: 90_000, polling: 100 });
    setupArchives.routes = null;
  });
});
