// SPDX-License-Identifier: GPL-3.0-or-later
// Advanced → User scripts → Script Store (script-store.js): the catalogue of
// bee-san/hachidori-scripts and installing from it, on settings.html's markup.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import "../extension/reader-options.js";
import { createScriptStore, parseCatalogue, SCRIPT_STORE_CATALOGUE } from "../extension/script-store.js";

const require = createRequire(new URL("./tooling/package.json", import.meta.url));
const { JSDOM } = require("jsdom");
const html = await readFile(new URL("../extension/settings.html", import.meta.url), "utf8");
const start = html.lastIndexOf("<section", html.indexOf('id="user-scripts"'));
const section = html.slice(start, html.indexOf("</section>", start) + "</section>".length);

const entry = (slug, fields = {}) => ({ slug, name: `Name ${slug}`, description: "What it does.", author: "someone",
  version: "1.0.0", license: "MIT", javascript: "window.a = 1;", css: "", ...fields });

test("the catalogue reads as the repository's tools write it, and anything else is refused whole", () => {
  const scripts = [entry("texthooker"), entry("compact-popup", { javascript: "", css: "p {}" })];
  assert.deepEqual(parseCatalogue({ schema: 1, scripts }), scripts);
  assert.deepEqual(parseCatalogue({ schema: 1, scripts: [{ ...entry("a"), extra: true }] }), [entry("a")]);
  for (const value of [null, [], { schema: 2, scripts }, { schema: 1 }, { schema: 1, scripts: {} }]) {
    assert.throws(() => parseCatalogue(value), /format this version of Hachidori cannot read/u);
  }
  for (const bad of [entry("Bad_Slug"), entry("a-"), { ...entry("a"), name: "" }, { ...entry("a"), name: "a\nb" },
    { ...entry("a"), version: 1 }, { ...entry("a"), css: null }, entry("a", { javascript: " ", css: "" })]) {
    assert.throws(() => parseCatalogue({ schema: 1, scripts: [bad] }), /package this version of Hachidori cannot read/u);
  }
  assert.throws(() => parseCatalogue({ schema: 1, scripts: [entry("a"), entry("a")] }), /cannot read/u);
});

function open({ scripts = [], respond }) {
  const { window } = new JSDOM(`<!doctype html><body><main>${section}</main></body>`);
  const { document } = window;
  document.getElementById("user-scripts").hidden = false;
  const requests = [];
  let stored = scripts;
  let next = 0;
  const store = createScriptStore({ document, readScripts: () => stored, saveScripts: (value) => { stored = value; },
    createId: () => `id-${next += 1}`,
    fetch: async (url, init) => { requests.push([url, init]); return respond(); } });
  store.render();
  const el = id => document.getElementById(id);
  const check = async () => {
    el("script-store-check").click();
    for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  };
  const row = slug => [...el("script-store-list").children].find(item => item.dataset.slug === slug);
  return { document, el, check, row, requests, store, stored: () => stored };
}

const reply = value => ({ ok: true, status: 200, json: async () => value });

test("Check for scripts asks GitHub once per press, then Install, Installed and Update follow the stored packages", async () => {
  let catalogue = { schema: 1, scripts: [entry("texthooker"), entry("compact-popup", { javascript: "", css: "p {}" })] };
  const page = open({ scripts: [{ id: "own", name: "Mine", enabled: true, javascript: "1;", css: "" }],
    respond: () => reply(catalogue) });
  assert.equal(page.requests.length, 0, "nothing is fetched before Check for scripts");
  assert.equal(page.el("script-store-list").children.length, 0);
  await page.check();
  assert.deepEqual(page.requests, [[SCRIPT_STORE_CATALOGUE, { cache: "no-store" }]]);
  assert.equal(page.el("script-store-status").textContent, "2 scripts are in the Script Store.");
  assert.equal(page.row("texthooker").querySelector(".script-store-name").textContent, "Name texthooker");
  assert.match(page.row("compact-popup").querySelector(".script-store-details").textContent,
    /^CSS · version 1\.0\.0 · someone · MIT · Source$/u);
  assert.equal(page.row("texthooker").querySelector("a").href,
    "https://github.com/bee-san/hachidori-scripts/tree/main/scripts/texthooker");
  page.row("texthooker").querySelector("button").click();
  assert.deepEqual(page.stored()[1], { id: "id-1", name: "Name texthooker", enabled: true, javascript: "window.a = 1;", css: "",
    store: { slug: "texthooker", version: "1.0.0" } });
  assert.equal(page.row("texthooker").querySelector(".script-store-installed").textContent, "Installed");
  assert.equal(page.el("script-store-status").textContent, "Installed Name texthooker. It runs on the pages you open or reload.");
  assert.equal(page.document.activeElement, page.row("texthooker").querySelector("a"));
  // A newer version replaces the package's parts and keeps its switch and place.
  page.stored()[1] = { ...page.stored()[1], enabled: false };
  catalogue = { schema: 1, scripts: [entry("texthooker", { version: "1.1.0", javascript: "window.b = 2;", css: "q {}" })] };
  await page.check();
  const update = page.row("texthooker").querySelector("button");
  assert.equal(update.textContent, "Update to 1.1.0");
  assert.equal(update.className, "primary-button", "an update is the list's one filled button");
  update.click();
  assert.deepEqual(page.stored().map(script => script.id), ["own", "id-1"]);
  assert.deepEqual(page.stored()[1], { id: "id-1", name: "Name texthooker", enabled: false, javascript: "window.b = 2;", css: "q {}",
    store: { slug: "texthooker", version: "1.1.0" } });
  assert.equal(page.el("script-store-status").textContent, "Updated Name texthooker to version 1.1.0.");
  // Deleting it in Your scripts offers Install again.
  page.stored().splice(1, 1);
  page.store.render();
  assert.equal(page.row("texthooker").querySelector("button").textContent, "Install");
});

test("a failed check says why and keeps the button usable", async () => {
  const failed = open({ respond: () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await failed.check();
  assert.equal(failed.el("script-store-status").textContent,
    "Could not check the Script Store: GitHub answered HTTP 503. Check your connection, then try again.");
  assert.match(failed.el("script-store-status").className, /is-error/u);
  assert.equal(failed.el("script-store-check").disabled, false);
  const garbled = open({ respond: () => reply({ schema: 9 }) });
  await garbled.check();
  assert.match(garbled.el("script-store-status").textContent, /its list is in a format this version of Hachidori cannot read/u);
});

test("an installed package keeps its Script Store slug and version through the options", () => {
  const { normaliseOptions, validateOptionsPatch } = globalThis.HDReaderOptions;
  const installed = { id: "a", name: "a", enabled: true, javascript: "1;", css: "", store: { slug: "a", version: "1.0.0" } };
  assert.deepEqual(validateOptionsPatch({ userScripts: [installed] }), { userScripts: [installed] });
  for (const bad of [{ ...installed, store: { slug: "" , version: "1" } }, { ...installed, store: { ...installed.store, extra: 1 } },
    { ...installed, extra: 1 }]) {
    assert.throws(() => validateOptionsPatch({ userScripts: [bad] }), /invalid reader option/u);
  }
  const { store, ...own } = installed;
  assert.equal(store.slug, "a");
  assert.deepEqual(normaliseOptions({ userScripts: [{ ...installed, store: "texthooker" }] }).userScripts, [own]);
});
