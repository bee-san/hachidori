/*
 * Languages in a real Firefox (docs/languages.md 18): one profile switch and
 * one English and one Arabic lookup in the Firefox build.
 *
 * The build under test is a copy of the Firefox build whose language registry
 * holds the Japanese pack and the English and Arabic fixture packs of
 * test/data/languages/, whatever packs the build ships: test/run.mjs writes it
 * to test/tmp/firefox-languages/ with chrome-languages/builds.mjs and passes it
 * as HACHIDORI_FIREFOX_EXTENSION.
 *
 * Built like test/firefox-e2e.mjs, whose session and fixed-denominator
 * harness it uses: Firefox installs the build as a temporary add-on and
 * Puppeteer drives it over WebDriver BiDi. The first run chooses English,
 * Settings adds Arabic, each profile imports its fixture dictionary
 * (make-language-fixtures.mjs), and the reader looks up an inflected English
 * word, then, after the toolbar switches to Arabic, a word with its article
 * on a right-to-left page. Screenshots of both lookups go to
 * test/tmp/languages/firefox/.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { after, describe } from "node:test";
import { ARABIC, ENGLISH, buildLanguageFixtureZip } from "./make-language-fixtures.mjs";
import { check, markCompleteSuite, step } from "./firefox-e2e/harness.mjs";
import {
  activate, engineStatus, evaluateJson, findPage, GECKO_ID, HERE, hoverForPopup, importArchives, inPopup, navigate,
  openExtensionPage, openPage, page, readStorage, reloadPage, startSession, waitFor,
} from "./firefox-e2e/session.mjs";

const PLANNED = [
  "Firefox runs the Firefox build, whose first run offers English and Arabic",
  "English chosen at first run and Arabic added in Settings are two profiles, each with its own dictionary",
  "an English hover in the middle of an inflected word finds its lemma",
  "the toolbar switches the active language to Arabic and the badge names it",
  "an Arabic hover on a right-to-left page finds the word with its article",
  "the Arabic popup is an English left-to-right interface and its trail reads the matched form first",
];

const SCREENSHOTS = resolve(HERE, "tmp/languages/firefox");
const MATCHED = "\u0627\u0644\u0643\u062A\u0627\u0628"; // الكتاب
const LEMMA = "\u0643\u062A\u0627\u0628"; // كتاب

const PAGES = {
  "/english.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>English</title></head>
    <body style="font: 32px sans-serif; padding: 60px; margin: 0"><p id="sample">She was running late.</p></body></html>`,
  "/arabic.html": `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Arabic</title></head>
    <body style="font: 32px sans-serif; padding: 60px; margin: 0"><p id="sample">${MATCHED} \u062C\u062F\u064A\u062F.</p></body></html>`,
};
const pages = await new Promise(resolveServer => {
  const created = createServer((request, response) => {
    const body = PAGES[new URL(request.url, "http://127.0.0.1").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(body ?? "not found");
  });
  created.listen(0, "127.0.0.1", () => resolveServer(created));
});
after(() => pages.close());
const origin = `http://127.0.0.1:${pages.address().port}`;

const languagesOf = options => (options?.profiles ?? []).map(profile => profile.language);
const editedProfile = () => page.evaluate(() => document.getElementById("settings-language-select")?.value ?? "");

// Imports a fixture dictionary through Settings and resolves with its package
// id once the package is in profile `code`'s list. Settings keeps the last
// import's summary line, so the stored record says when this one is done.
async function importInto(code, fixture) {
  await importArchives(page, [{ name: fixture.file, bytes: buildLanguageFixtureZip(fixture) }]);
  return waitFor(async () => {
    const { dictionaryState: state } = await readStorage(page, ["dictionaryState"]);
    const row = state?.dictionaries?.find(entry => entry.title === fixture.title);
    return row && state.profiles?.[code]?.dictionaries?.some(entry => entry.id === row.id) ? row.id : false;
  }, { timeout: 60_000 });
}

async function screenshot(target, name) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await target.screenshot({ path: resolve(SCREENSHOTS, `${name}.png`) });
}

let tab = null;

describe("firefox languages", () => {
  step("Firefox loads the Firefox build", async () => {
    const installedId = await startSession();
    const status = await waitFor(async () => {
      const reply = await engineStatus(page);
      return reply?.ready ? reply : false;
    }, { timeout: 60_000 });
    const startup = await findPage("startup.html");
    const menu = await waitFor(() => startup.evaluate(() => {
      const select = document.getElementById("setup-language-select");
      return select ? [...select.options].map(option => option.value).join(",") : false;
    }), { timeout: 30_000 });
    check(PLANNED[0], installedId === GECKO_ID && status?.ready === true
      && menu?.split(",")[0] === "ja" && menu.split(",").includes("en") && menu.split(",").includes("ar"),
    JSON.stringify({ installedId, status, menu }));
  });

  step("English at first run, Arabic from Settings", async () => {
    const startup = await findPage("startup.html");
    // In one task, so no render comes between the choice and the click.
    await startup.evaluate(() => {
      const select = document.getElementById("setup-language-select");
      select.value = "en";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("setup-manual").click();
    });
    const firstRun = await waitFor(async () => {
      const stored = await readStorage(page, ["options", "setupState"]);
      return stored.setupState?.stage === "practice" ? stored : false;
    }, { timeout: 30_000 });
    await startup.close();
    // Settings opened before the choice; reloaded, it edits the English profile.
    await reloadPage(page);
    await waitFor(async () => (await editedProfile()) === "en");
    const english = await importInto("en", ENGLISH);
    await page.evaluate(() => document.getElementById("settings-language-manage").click());
    await waitFor(() => page.evaluate(() => document.querySelector('[aria-label="Add Arabic"]') !== null));
    await page.evaluate(() => document.querySelector('[aria-label="Add Arabic"]').click());
    const edited = await waitFor(async () => ((await editedProfile()) === "ar" ? "ar" : false), { timeout: 60_000 });
    await page.evaluate(() => document.getElementById("settings-language-dialog").close());
    const arabic = await importInto("ar", ARABIC);
    const stored = await readStorage(page, ["options", "dictionaryState", "languageSelection"]);
    const titleOf = id => stored.dictionaryState?.dictionaries?.find(row => row.id === id)?.title;
    const own = code => (stored.dictionaryState?.profiles?.[code]?.dictionaries ?? []).map(entry => titleOf(entry.id));
    check(PLANNED[1], JSON.stringify(languagesOf(firstRun?.options)) === JSON.stringify(["en"])
      && english !== null && edited === "ar" && arabic !== null
      && JSON.stringify(languagesOf(stored.options)) === JSON.stringify(["en", "ar"])
      && JSON.stringify(own("en")) === JSON.stringify([ENGLISH.title]) && JSON.stringify(own("ar")) === JSON.stringify([ARABIC.title])
      && stored.languageSelection?.activeProfileId === "en",
    JSON.stringify({ firstRun: languagesOf(firstRun?.options), english, edited, arabic, profiles: languagesOf(stored.options),
      en: own("en"), ar: own("ar"), selection: stored.languageSelection }));
  });

  step("an English lookup", async () => {
    tab = await openPage(`${origin}/english.html`);
    // The second n of "running".
    const shown = await hoverForPopup(tab, "#sample", { index: 10 });
    if (shown) await screenshot(tab, "lookup-english");
    check(PLANNED[2], shown?.headword === "run" && shown.plain.includes("to move swiftly on foot"), JSON.stringify(shown));
  });

  step("the toolbar switches to Arabic", async () => {
    const toolbar = await openExtensionPage("toolbar.html");
    const arabic = '#language-switcher [data-profile-id="ar"]';
    await waitFor(() => toolbar.evaluate(selector => document.querySelector(selector) !== null, arabic));
    await toolbar.evaluate(selector => document.querySelector(selector).click(), arabic);
    const active = await waitFor(async () => {
      const id = (await readStorage(page, ["languageSelection"])).languageSelection?.activeProfileId;
      return id === "ar" ? id : false;
    });
    const choices = await evaluateJson(toolbar, () => JSON.stringify([...document.querySelectorAll("#language-switcher [role=radio]")]
      .map(button => [button.dataset.profileId, button.getAttribute("aria-checked")])));
    const badge = await page.evaluate(() => chrome.action.getBadgeText({}));
    await toolbar.close();
    check(PLANNED[3], active === "ar" && JSON.stringify(choices) === JSON.stringify([["en", "false"], ["ar", "true"]])
      && badge === "AR", JSON.stringify({ active, choices, badge }));
  });

  step("an Arabic lookup", async () => {
    await activate(tab);
    await navigate(tab, `${origin}/arabic.html`);
    // The fourth letter of الكتاب, on a right-to-left page.
    const shown = await hoverForPopup(tab, "#sample", { index: 3 });
    if (shown) await screenshot(tab, "lookup-arabic");
    check(PLANNED[4], shown?.headword === LEMMA && shown.plain.includes("book"), JSON.stringify(shown));
    // 10.1: the popup is English and left to right on this page; its
    // headword is Arabic; the trail row reads matched form → lemma left to
    // right, its endpoints isolated.
    const layout = await inPopup(tab, `root => {
      const popup = root.querySelector('.gsm-hoshidicts-popup[data-hoshidicts-depth="0"]');
      if (!popup || popup.hidden) return null;
      const view = popup.ownerDocument.defaultView;
      const headword = popup.querySelector(".gsm-hoshidicts-expression");
      const path = popup.querySelector(".gsm-hoshidicts-deinflection-path");
      return {
        dir: popup.getAttribute("dir"), lang: popup.getAttribute("lang"), direction: view.getComputedStyle(popup).direction,
        headword: [headword?.getAttribute("lang") ?? null, headword?.getAttribute("dir") ?? null],
        row: path ? view.getComputedStyle(path).direction : null,
        parts: [...(path?.children ?? [])].map(part => {
          const box = part.getBoundingClientRect();
          return { text: part.textContent, left: Math.round(box.left * 10) / 10, right: Math.round(box.right * 10) / 10,
            isolate: view.getComputedStyle(part).unicodeBidi === "isolate" };
        }),
      };
    }`);
    const parts = layout?.parts ?? [];
    check(PLANNED[5], layout?.dir === "ltr" && layout.lang === "en" && layout.direction === "ltr"
      && JSON.stringify(layout.headword) === JSON.stringify(["ar", "rtl"]) && layout.row === "ltr"
      && parts.length === 3 && parts[0].text === MATCHED && parts[2].text === LEMMA && parts[0].isolate && parts[2].isolate
      && parts.every((part, index) => index === 0 || parts[index - 1].right <= part.left + 1),
    JSON.stringify(layout));
  });
});

markCompleteSuite(PLANNED);
