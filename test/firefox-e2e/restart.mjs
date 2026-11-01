/*
 * The engine through Firefox's idle limit, a Firefox restart on the same
 * profile, removal, and lookups in local files once Firefox's file permission
 * is on.
 *
 * Part of the real-Firefox suite (test/firefox-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./sharing.mjs";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe } from "node:test";
import { check, step } from "./harness.mjs";
import {
  activate, browser, dictionaryState, engineStatus, evaluateJson, extensionUrl, GECKO_ID, hoverForPopup, installHachidori,
  launchFirefox, listIdbfsPaths, navigate, openPage, ORIGIN, page, PROFILE, readStorage, sendRuntime, serverUrl, setBidi,
  setBrowser, setDownloads, setPage, showSettingsSection, sleep, tabUrls, waitFor,
} from "./session.mjs";

// Firefox suspends an idle event page after this long
// (extensions.background.idle.timeout).
const IDLE_LIMIT_MS = 30_000;

const backgroundContext = target => evaluateJson(target, async () => JSON.stringify((await chrome.runtime.getContexts({}))
  .filter(({ contextType }) => contextType === "BACKGROUND")
  .map(({ contextId, documentUrl }) => ({ contextId, documentUrl }))));

const lookupText = async (target, text) => JSON.stringify((await sendRuntime(target, { target: "hoshidicts-offscreen",
  type: "hd_lookup", requestId: `lookup-${text}`, text })).results ?? []);

// Leaves nothing open that talks to the extension: every tab shows about:blank.
async function closeEverything(target) {
  for (const candidate of await target.pages()) {
    const href = await candidate.evaluate(() => location.href).catch(() => "");
    if (href.startsWith(ORIGIN)) await candidate.evaluate(() => location.replace("about:blank")).catch(() => {});
    else if (href !== "about:blank") await navigate(candidate, "about:blank").catch(() => {});
  }
  return waitFor(async () => (await tabUrls()).every(url => url === "about:blank") || false, { timeout: 10_000 });
}

describe("idle and restart", () => {
  let before = null;

  step("Firefox's idle limit", async () => {
    // The sharing host's retry alarm would wake the page by itself; with it
    // off, only the keep-alive keeps the page running.
    await activate(page);
    await showSettingsSection(page, "sharing");
    await page.evaluate(() => {
      const toggle = document.getElementById("sharing-host-enabled");
      if (toggle.checked) toggle.click();
    });
    await waitFor(async () => (await readStorage(page, ["sharing"])).sharing?.host?.enabled === false || false);
    const status = await engineStatus(page);
    const contexts = await backgroundContext(page);
    const closed = await closeEverything(browser);
    await sleep(IDLE_LIMIT_MS + 15_000);
    await navigate(page, extensionUrl("settings.html"));
    const after = await engineStatus(page);
    const contextsAfter = await backgroundContext(page);
    check("the engine keeps its dictionaries through Firefox's 30-second idle limit",
      closed === true && status?.ready === true && after?.ready === true && after.generation === status.generation
        && after.packageCount === status.packageCount && contexts.length === 2
        && JSON.stringify(contextsAfter) === JSON.stringify(contexts),
      JSON.stringify({ closed, status: [status?.generation, status?.packageCount], after: [after?.generation, after?.packageCount,
        after?.ready], contexts, contextsAfter }));
  });

  step("a Firefox restart", async () => {
    before = {
      state: await dictionaryState(page),
      options: (await readStorage(page, ["options"])).options,
      stats: await sendRuntime(page, { target: "hoshidicts-worker", type: "hd_lookup_stats_read", requestId: "s",
        term: "食べる", reading: "たべる" }),
    };
    await browser.close();
    const relaunched = await launchFirefox(PROFILE);
    setBrowser(relaunched.browser);
    setBidi(relaunched.session);
    setDownloads(relaunched.downloads);
    const id = await installHachidori(relaunched.browser);
    const settings = await openPage(extensionUrl("settings.html"), relaunched.browser);
    setPage(settings);
    // The engine reports ready before it has loaded the stored dictionaries.
    const ready = await waitFor(async () => {
      const status = await engineStatus(settings);
      return status?.ready && !status.loading ? status : false;
    }, { timeout: 120_000 });
    const after = {
      state: await dictionaryState(settings),
      options: (await readStorage(settings, ["options"])).options,
      stats: await sendRuntime(settings, { target: "hoshidicts-worker", type: "hd_lookup_stats_read", requestId: "s",
        term: "食べる", reading: "たべる" }),
    };
    await sleep(500);
    const startup = (await tabUrls()).filter(url => url.startsWith(extensionUrl("startup.html")));
    const paths = await listIdbfsPaths(settings);
    check("dictionaries, settings and counts survive a Firefox restart",
      id === GECKO_ID && ready?.packageCount === before.state.dictionaries.length
        && JSON.stringify(after.state) === JSON.stringify(before.state)
        && after.options?.revision === before.options?.revision && after.options.popupTheme === before.options.popupTheme
        && JSON.stringify(after.stats) === JSON.stringify(before.stats)
        && startup.length === 0
        && before.state.dictionaries.every(entry => paths.some(path => path.startsWith(`${entry.path}/`))),
      JSON.stringify({ ready, before: before.state.dictionaries.map(entry => entry.title), after: after.state?.dictionaries
        .map(entry => entry.title), revisions: [before.options?.revision, after.options?.revision], startup, stats: after.stats }));
    const reader = await openPage(`${serverUrl}/?restart`, relaunched.browser);
    const shown = await hoverForPopup(reader, "#verb");
    check("lookups work after the restart without re-importing", shown?.headword === "食べる" && shown.plain.includes("to eat"),
      JSON.stringify(shown));
    await reader.close();
  });

  step("removing a dictionary", async () => {
    const settings = page;
    await activate(settings);
    await showSettingsSection(settings, "dictionaries");
    const fixture = (await dictionaryState(settings)).dictionaries.find(entry => entry.title === "hachidori-fixture");
    await settings.evaluate(id => {
      window.confirm = () => true;
      const row = document.querySelector(`.dict-row[data-dictionary-id="${id}"]`);
      row.querySelector(".dict-details").open = true;
      row.querySelector(".dict-remove").click();
    }, fixture.id);
    const removed = await waitFor(async () => (await dictionaryState(settings)).dictionaries
      .every(entry => entry.id !== fixture.id) || false, { timeout: 60_000 });
    const gone = await waitFor(async () => {
      const paths = await listIdbfsPaths(settings);
      return paths.some(path => path.startsWith(`${fixture.path}/`)) ? false : paths;
    }, { timeout: 30_000 });
    const lookup = await lookupText(settings, "食べたかった");
    check("removing a dictionary deletes its IndexedDB files and its lookups",
      removed === true && gone !== null && !lookup.includes("to live on (e.g. a salary)"),
      JSON.stringify({ removed, gone: gone?.length, lookup: lookup.slice(0, 300) }));
  });
});

describe("local files", () => {
  step("Firefox's local-file permission", async () => {
    const current = browser;
    const settings = page;
    await activate(settings);
    await showSettingsSection(settings, "lookup");
    const prompt = await waitFor(() => evaluateJson(settings, () => {
      const container = document.getElementById("settings-local-file-access");
      return JSON.stringify(container && !container.hidden ? {
        description: document.getElementById("local-file-description")?.textContent ?? "",
        instruction: document.getElementById("local-file-instruction")?.hidden === false
          ? document.getElementById("local-file-instruction").textContent : "",
        button: document.getElementById("local-file-open") !== null,
      } : null);
    }), { timeout: 10_000 });
    check("Settings says where Firefox's local-file switch is",
      prompt?.description.includes("“Access local files on your computer”") && prompt.instruction.includes("about:addons")
        && prompt.button === false,
      JSON.stringify(prompt));

    // The switch in about:addons → Hachidori → Permissions and data.
    const addons = await openPage("about:addons", current);
    const switched = await evaluateJson(addons, async id => {
      const deadline = Date.now() + 15_000;
      const until = async read => {
        let value = read();
        while (!value && Date.now() < deadline) {
          await new Promise(done => setTimeout(done, 100));
          value = read();
        }
        return value;
      };
      // Hachidori's card in the extension list opens its details, which have
      // a Permissions and data tab.
      (await until(() => document.querySelector(`addon-card[addon-id="${id}"]`)))?.click();
      const card = await until(() => document.querySelector(`addon-card[addon-id="${id}"][expanded]`));
      (await until(() => card?.querySelector('[name="permissions"]')))?.click();
      let toggle = null;
      while (!toggle && Date.now() < deadline) {
        toggle = document.querySelector(`addon-card[addon-id="${id}"] addon-permissions-list moz-toggle[permission-type="file_scheme_access"]`);
        if (!toggle) await new Promise(done => setTimeout(done, 100));
      }
      if (!toggle) {
        return JSON.stringify({ toggle: null, categories: [...document.querySelectorAll("categories-box [viewid]")].map(node => node.getAttribute("viewid")),
          cards: [...document.querySelectorAll("addon-card")].map(node => node.getAttribute("addon-id")),
          tabs: [...(card?.querySelectorAll("[name]") ?? [])].map(node => node.getAttribute("name")),
          url: location.href, body: document.body?.innerHTML.slice(0, 400) });
      }
      const label = toggle.label;
      toggle.click();
      return JSON.stringify({ label, pressed: toggle.pressed });
    }, GECKO_ID);
    const allowed = await waitFor(() => settings.evaluate(() => chrome.extension.isAllowedFileSchemeAccess()), { timeout: 10_000 });
    const file = resolve(tmpdir(), `hachidori-firefox-local-${process.pid}.html`);
    writeFileSync(file, '<!doctype html><html lang="ja"><meta charset="utf-8"><body style="font: 32px serif; padding: 60px">'
      + '<span id="cat">猫</span></body></html>');
    const local = await openPage(pathToFileURL(file).href, current);
    // The fixture was removed above; the restored personal dictionary still has 猫.
    const shown = await hoverForPopup(local, "#cat");
    check("turning on Access local files in about:addons lets the reader run on file: pages",
      switched?.label === "Access local files on your computer" && allowed === true && shown?.plain.includes("personal note") === true,
      JSON.stringify({ switched, allowed, shown: shown?.plain?.slice(0, 120) }));
    await local.close();
    rmSync(file, { force: true });
    await addons.close().catch(() => {});
  });
});
