/*
 * Profiles in real Chrome (docs/profiles.md 9): a Japanese-only installation
 * turns on Experimental features → Profiles, copies its profile in Settings →
 * Profiles, names the copy and gives it a custom button, adds a website rule
 * for the page's host, and a lookup on that page then uses the copy; the
 * default profile, and removing the copy, follow. It saves the section in the
 * light and dark palettes under test/tmp/languages/.
 *
 * Every check is planned, so a check that never runs fails the suite.
 *
 *   node test/run.mjs chrome-languages
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension } from "./builds.mjs";
import { hoverForPopup, popupReader } from "../chrome-e2e/popup-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCREENSHOTS = resolve(ROOT, "test/tmp/languages");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || "";
const PUPPETEER = process.env.HACHIDORI_PUPPETEER
  || resolve(CACHE, "hachidori-e2e", "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
const puppeteer = await import(PUPPETEER.startsWith("/") ? `file://${PUPPETEER}` : PUPPETEER);

const PLANNED = [
  "Profiles is hidden until its switch is on, then offers one profile to copy",
  "Copy makes a named copy of the profile in the same language, which Settings then shows",
  "renaming a copy in the list stores its name, and Settings shows it by name",
  "a website rule added in Profiles makes a lookup on that site use the copy, which the popup names",
  "without a matching rule a lookup uses the default profile, which the list's choice sets",
  "the ja profile stays while it has copies, and removing the copy returns the records to one profile",
];
const results = new Map();
function check(name, ok, detail = "") {
  if (!PLANNED.includes(name)) throw new Error(`unplanned check: ${name}`);
  results.set(name, { ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail}`}`);
}
async function step(name, run) {
  try {
    await run();
  } catch (error) {
    if (!results.has(name)) check(name, false, error?.stack ?? String(error));
    else console.log(`      after ${name}: ${error?.stack ?? error}`);
  }
}
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(probe, { timeout = 15_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await wait(interval);
  }
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Reading</title></head>
  <body style="font: 32px sans-serif; padding: 40px"><p><span id="verb">食べたかった</span></p></body></html>`;

function servePage() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  return new Promise(resolveServer => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

// Settings → Profiles, clipped to the section, in page coordinates (AGENTS.md).
async function screenshot(page, name) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.bringToFront();
  const clip = await page.evaluate(() => {
    const box = document.getElementById("profiles").getBoundingClientRect();
    return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height };
  });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), clip });
}

const BUTTON = "Web search button";

// ---------------------------------------------------------------- the suite

const scratch = mkdtempSync(join(tmpdir(), "hachidori-languages-profiles-"));
const errors = [];
const server = await servePage();
const origin = `http://127.0.0.1:${server.address().port}`;
let installation = null;

try {
  installation = await launchExtension(puppeteer, { chrome: CHROME, scratch, name: "profiles",
    extension: resolve(ROOT, "extension"), errors });
  const { message, storage } = installation;
  await installation.importArchive(readFileSync(resolve(ROOT, "test/fixtures/hachidori-fixture.zip")), "hachidori-fixture.zip");
  const settings = await installation.page("settings.html#profiles");
  const profileRows = () => settings.evaluate(() => [...document.querySelectorAll("#profile-list > li")].map(row => ({
    id: row.dataset.profileId,
    name: row.querySelector(".profile-name")?.value ?? row.querySelector("strong")?.textContent ?? null,
    default: row.querySelector('input[type="radio"]')?.checked ?? null,
    badges: [...row.querySelectorAll(".profile-badge")].map(badge => badge.textContent),
    buttons: [...row.querySelectorAll("button")].map(button => button.textContent),
  })));
  let copyId = null;

  await step(PLANNED[0], async () => {
    const hidden = await settings.evaluate(() => ({ section: location.hash, link: document.querySelector('.settings-nav a[href="#profiles"]')
      .closest(".nav-item").hidden }));
    await settings.evaluate(() => document.getElementById("opt-experimental-profiles").click());
    const shown = await until(async () => {
      await settings.evaluate(() => { location.hash = "#profiles"; });
      return settings.evaluate(() => !document.getElementById("profiles").hidden
        && document.querySelectorAll("#profile-list > li").length === 1);
    });
    const rows = await profileRows();
    check(PLANNED[0], hidden.link && shown && rows.length === 1 && rows[0].id === "ja" && rows[0].name === "Japanese"
      && JSON.stringify(rows[0].buttons) === JSON.stringify(["Copy"]), JSON.stringify({ hidden, shown, rows }));
    await screenshot(settings, "profiles-single-light");
  });

  await step(PLANNED[1], async () => {
    await settings.evaluate(() => [...document.querySelectorAll("#profile-list button")].find(button => button.textContent === "Copy").click());
    const rows = await until(async () => {
      const current = await profileRows();
      return current.length === 2 && current[1].badges.includes("Settings shows") ? current : null;
    }, { timeout: 30_000 });
    const stored = await storage(["options", "dictionaryState"]);
    const copy = stored.options.profiles?.[1];
    copyId = copy?.id ?? null;
    const focused = await settings.evaluate(() => document.activeElement?.classList.contains("profile-name"));
    check(PLANNED[1], Boolean(rows) && copy?.language === "ja" && copy.name === "Japanese copy" && /^p-/u.test(copy.id)
      && JSON.stringify(stored.dictionaryState.profiles[copy.id].dictionaries)
        === JSON.stringify(stored.dictionaryState.profiles.ja.dictionaries) && focused
      && rows[0].default === true && rows[0].badges.includes("Default"),
    JSON.stringify({ rows, copy, focused }));
  });

  await step(PLANNED[2], async () => {
    await settings.evaluate(() => { document.activeElement.select(); });
    await settings.keyboard.type("Video");
    await settings.keyboard.press("Enter");
    const named = await until(async () => (await storage(["options"])).options.profiles?.[1]?.name === "Video");
    const link = await until(() => settings.evaluate(() => document.getElementById("settings-language-link")?.textContent));
    check(PLANNED[2], named && link === "Settings shows Video", JSON.stringify({ named, link, rows: await profileRows() }));
  });

  await step(PLANNED[3], async () => {
    // The copy gets a link button the popup shows, and lookups need no key.
    let stored = await storage(["options"]);
    const button = await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision,
      profileId: copyId, options: { customButtons: [{ id: "video", type: "link", label: BUTTON, url: "https://example.com/{term}" }] } });
    if (button?.ok !== true) throw new Error(`hd_options_write: ${JSON.stringify(button)}`);
    stored = await storage(["options"]);
    const hover = await message({ target: "hoshidicts-worker", type: "hd_options_write", baseRevision: stored.options.revision,
      options: { lookupMode: "hover" } });
    if (hover?.ok !== true) throw new Error(`hd_options_write: ${JSON.stringify(hover)}`);
    // Add a rule for the page's host in Settings.
    await settings.evaluate(() => document.getElementById("profile-rules-add").click());
    await until(() => settings.evaluate(() => document.querySelectorAll("#profile-rules-list > li").length === 1));
    await settings.evaluate(id => {
      const profile = document.getElementById("profile-rules-0-profile");
      profile.value = id;
      profile.dispatchEvent(new Event("change", { bubbles: true }));
    }, copyId);
    await until(async () => (await storage(["languageSelection"])).languageSelection?.rules?.[0]?.profileId === copyId);
    await settings.evaluate(() => {
      const domain = document.querySelector('#profile-rules-list [data-role="value"]');
      domain.value = "127.0.0.1";
      domain.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const rules = await until(async () => {
      const selection = (await storage(["languageSelection"])).languageSelection;
      return selection?.rules?.[0]?.conditions?.[0]?.value === "127.0.0.1" ? selection.rules : null;
    });
    await installation.ready();
    await settings.evaluate(() => document.activeElement?.blur());
    await screenshot(settings, "profiles-light");
    await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await screenshot(settings, "profiles-dark");
    await settings.emulateMediaFeatures([]);
    const reading = await installation.browser.newPage();
    reading.on("pageerror", error => errors.push(`[page] ${error.message}`));
    await reading.setViewport({ width: 1280, height: 720 });
    await reading.goto(`${origin}/`, { waitUntil: "load" });
    const popup = await popupReader(reading);
    const state = await hoverForPopup(reading, popup, "#verb", { accept: current => current.plain.includes(BUTTON), attempts: 20 });
    check(PLANNED[3], Boolean(rules) && Boolean(state) && state.plain.includes("食べる") && state.plain.startsWith("Video"),
      JSON.stringify({ rules, popup: state?.plain?.slice(0, 200) ?? null }));
    await reading.close();
  });

  await step(PLANNED[4], async () => {
    const selection = (await storage(["languageSelection"])).languageSelection;
    const cleared = await message({ target: "hoshidicts-worker", type: "hd_language_selection_write",
      baseRevision: selection.revision, rules: [] });
    if (cleared?.ok !== true) throw new Error(`hd_language_selection_write: ${JSON.stringify(cleared)}`);
    const open = async () => {
      const reading = await installation.browser.newPage();
      await reading.setViewport({ width: 1280, height: 720 });
      await reading.goto(`${origin}/`, { waitUntil: "load" });
      const popup = await popupReader(reading);
      const state = await hoverForPopup(reading, popup, "#verb", { accept: current => current.plain.includes("食べる"), attempts: 20 });
      await reading.close();
      return state?.plain ?? "";
    };
    const japanese = await open();
    // The list's default choice for the copy.
    await settings.evaluate(id => document.querySelector(`#profile-list > li[data-profile-id="${id}"] input[type="radio"]`).click(), copyId);
    const chosen = await until(async () => (await storage(["languageSelection"])).languageSelection?.activeProfileId === copyId);
    const video = await open();
    // The default profile in effect needs no label.
    check(PLANNED[4], !japanese.includes(BUTTON) && japanese.includes("食べる") && chosen && video.includes(BUTTON)
      && !video.startsWith("Video"),
      JSON.stringify({ japanese: japanese.slice(0, 120), chosen, video: video.slice(0, 120) }));
  });

  await step(PLANNED[5], async () => {
    const rows = await profileRows();
    const japanese = rows.find(row => row.id === "ja");
    await settings.evaluate(id => [...document.querySelectorAll(`#profile-list > li[data-profile-id="${id}"] button`)]
      .find(button => button.textContent === "Remove").click(), copyId);
    await settings.evaluate(() => document.getElementById("profile-remove-confirm").click());
    const single = await until(async () => {
      const stored = await storage(["options", "dictionaryState", "languageSelection"]);
      return !Object.hasOwn(stored.options, "profiles") && stored.dictionaryState.schemaVersion === 1
        && stored.languageSelection === undefined ? stored : null;
    }, { timeout: 30_000 });
    const after = await until(async () => {
      const current = await profileRows();
      return current.length === 1 ? current : null;
    });
    check(PLANNED[5], japanese && !japanese.buttons.includes("Remove") && Boolean(single) && after?.[0]?.id === "ja",
      JSON.stringify({ japanese, single: Boolean(single), after }));
  });
} finally {
  await installation?.browser.close().catch(() => {});
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}

const failed = PLANNED.filter(name => results.get(name)?.ok !== true);
for (const name of PLANNED.filter(planned => !results.has(planned))) console.log(`FAIL  ${name}\n      check never ran`);
if (errors.length > 0) console.log(`page errors:\n  ${errors.join("\n  ")}`);
console.log(`\n${PLANNED.length - failed.length}/${PLANNED.length} checks passed; screenshots in ${SCREENSHOTS}`);
process.exitCode = failed.length === 0 ? 0 : 1;
