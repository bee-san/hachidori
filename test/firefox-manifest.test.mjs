// SPDX-License-Identifier: GPL-3.0-or-later
// The Firefox build: the manifest scripts/firefox_manifest.py derives from the
// Chrome manifest, the background page that replaces the service worker and
// offscreen document, and scripts/build-firefox.py's copy of extension/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = path => readFileSync(resolve(ROOT, path), "utf8");
const chrome = JSON.parse(read("extension/manifest.json"));
const tooling = JSON.parse(read("test/tooling/package.json"));

function python(source) {
  return execFileSync("python3", ["-c", source], { cwd: resolve(ROOT, "scripts"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const firefox = JSON.parse(python(
  "import json, sys; from firefox_manifest import firefox_manifest;"
  + " print(json.dumps(firefox_manifest(json.load(open('../extension/manifest.json')))))",
));
const [GECKO_ID, FIREFOX_ONLY_FILES] = JSON.parse(python(
  "import json; from firefox_manifest import GECKO_ID, FIREFOX_ONLY_FILES; print(json.dumps([GECKO_ID, FIREFOX_ONLY_FILES]))",
));

function files(directory) {
  return readdirSync(directory, { recursive: true })
    .filter(name => statSync(join(directory, name)).isFile()).map(name => relative(directory, join(directory, name))).sort();
}

test("Firefox runs background.js in an event page and leaves out what Firefox does not implement", () => {
  assert.deepEqual(firefox.background, { page: "background.html" });
  assert.deepEqual(firefox.permissions, chrome.permissions.filter(name => !["offscreen", "tabCapture", "userScripts"].includes(name)));
  // The Chrome manifest's optional permissions stay optional (#639), userScripts after them.
  assert.deepEqual(firefox.optional_permissions, [...chrome.optional_permissions, "userScripts"]);
  assert.deepEqual(chrome.optional_permissions, ["clipboardRead"]);
  for (const key of ["minimum_chrome_version", "cross_origin_embedder_policy", "cross_origin_opener_policy"]) {
    assert.equal(Object.hasOwn(firefox, key), false, key);
  }
  assert.deepEqual(firefox.browser_specific_settings, {
    gecko: { id: "hachidori@bee-san", strict_min_version: "153.0",
      data_collection_permissions: { required: ["websiteContent", "browsingActivity"] } },
  });
  // Everything else is the Chrome manifest's, so commands, content scripts,
  // pages and resources cannot drift between the builds.
  const shared = manifest => Object.fromEntries(Object.entries(manifest).filter(([key]) => ![
    "background", "permissions", "optional_permissions", "browser_specific_settings", "minimum_chrome_version",
    "cross_origin_embedder_policy", "cross_origin_opener_policy", "web_accessible_resources",
  ].includes(key)));
  assert.deepEqual(shared(firefox), shared(chrome));
  assert.deepEqual(firefox.web_accessible_resources.slice(0, -1), chrome.web_accessible_resources);
});

// Firefox serves a sandboxed page (#644) only the stylesheets and modules a web
// page could load; Chrome serves it every file of the extension.
test("Firefox can serve every stylesheet and module the sandboxed search frame loads", () => {
  const accessible = new Set(firefox.web_accessible_resources.filter(entry => entry.matches?.includes("<all_urls>"))
    .flatMap(entry => entry.resources));
  const covered = path => accessible.has(path) || [...accessible].some(pattern => pattern.endsWith("/*")
    && path.startsWith(pattern.slice(0, -1)));
  const loaded = new Set();
  const visit = module => {
    if (loaded.has(module)) return;
    loaded.add(module);
    for (const [, path] of read(`extension/${module}`).matchAll(/^import (?:[^;]*? from )?"\.\/([^"]+)";/gmu)) visit(path);
  };
  assert.deepEqual(chrome.sandbox.pages, ["search-frame.html"]);
  const page = read("extension/search-frame.html");
  for (const [, path] of page.matchAll(/<link rel="stylesheet" href="([^"]+)"/gu)) loaded.add(path);
  for (const [, path] of page.matchAll(/<script type="module" src="([^"]+)"/gu)) visit(path);
  assert.ok(loaded.has("search.js") && loaded.has("debug-log.js") && loaded.has("search.css"), [...loaded].join());
  assert.deepEqual([...loaded].filter(path => !covered(path)), []);
});

// Firefox's content-script window is the page's window, where another content
// script's globalThis.HD* namespace and the extension's chrome are not visible.
test("content scripts read their namespaces and chrome from globalThis, not window", () => {
  const scripts = [...new Set(chrome.content_scripts.flatMap(script => script.js ?? []))];
  assert.ok(scripts.includes("content.js"));
  for (const script of scripts) {
    assert.doesNotMatch(read(`extension/${script}`), /\bwindow\.(?:HD\w+|chrome)\b/u, script);
  }
});

test("the Firefox minimum is the tested minimum Firefox build", () => {
  const version = buildId => /^stable_(\d+\.\d+)$/u.exec(buildId)?.[1];
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, version(tooling.config.minimumFirefox));
  assert.ok(Number.parseFloat(version(tooling.config.firefox)) >= Number.parseFloat(version(tooling.config.minimumFirefox)));
});

test("the transform refuses a Chrome background it would not run", () => {
  const changed = JSON.stringify({ ...chrome, background: { service_worker: "worker.js", type: "module" } });
  assert.throws(() => python(`import json; from firefox_manifest import firefox_manifest; firefox_manifest(json.loads(${JSON.stringify(changed)}))`),
    /background\.html runs/u);
});

test("the background page runs the service worker's script, the keep-alive and the engine frame", () => {
  const page = read("extension/background.html");
  assert.match(page, /<script type="module" src="background\.js"><\/script>/u);
  assert.match(page, /<script type="module" src="event-page\.js"><\/script>/u);
  assert.match(page, /<iframe src="offscreen\.html"[^>]*><\/iframe>/u);
  assert.equal(chrome.background.service_worker, "background.js");
  // Chrome never loads the Firefox-only files, and its ZIP leaves them out.
  assert.deepEqual(FIREFOX_ONLY_FILES, ["background.html", "event-page.js"]);
  assert.equal(JSON.stringify(chrome).includes("background.html") || JSON.stringify(chrome).includes("event-page.js"), false);
  const keepAlive = read("extension/event-page.js");
  const interval = Number(/KEEP_ALIVE_MS = ([\d_]+);/u.exec(keepAlive)?.[1].replaceAll("_", ""));
  // Firefox suspends an event page idle for 30 s (extensions.background.idle.timeout).
  assert.ok(interval > 0 && interval < 30_000, `keep-alive ${interval} ms`);
  assert.match(keepAlive, /chrome\.runtime\.getPlatformInfo\(\)/u);
});

test("build-firefox.py copies extension/ with the Firefox manifest and replaces only its own output", t => {
  const directory = mkdtempSync(join(tmpdir(), "hachidori-firefox-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "build");
  const build = () => execFileSync("python3", [resolve(ROOT, "scripts/build-firefox.py"), "--output-dir", output],
    { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  build();
  assert.deepEqual(files(output), files(resolve(ROOT, "extension")));
  assert.deepEqual(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")), firefox);
  build();
  assert.equal(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")).browser_specific_settings.gecko.id, GECKO_ID);
  const other = join(directory, "other");
  mkdirSync(other);
  writeFileSync(join(other, "notes.txt"), "keep me");
  assert.throws(() => execFileSync("python3", [resolve(ROOT, "scripts/build-firefox.py"), "--output-dir", other],
    { cwd: ROOT, stdio: "pipe" }), /not empty and is not an earlier Firefox build/u);
  assert.equal(readFileSync(join(other, "notes.txt"), "utf8"), "keep me");
});

test("in Firefox the relay waits for the background page, and so its engine frame, to load", async t => {
  // Firefox's background page: no offscreen API, and a document still loading.
  const listeners = [];
  globalThis.chrome = { runtime: { getURL: path => `moz-extension://hachidori/${path}` } };
  globalThis.document = { readyState: "loading" };
  globalThis.addEventListener = (type, listener, options) => listeners.push({ type, listener, options });
  t.after(() => {
    delete globalThis.chrome;
    delete globalThis.document;
    delete globalThis.addEventListener;
  });
  const { ensureChromeOffscreen } = await import("../extension/chrome-offscreen.js");
  let ready = false;
  const waiting = ensureChromeOffscreen("offscreen.html").then(() => { ready = true; });
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(ready, false);
  assert.deepEqual(listeners.map(({ type, options }) => [type, options]), [["load", { once: true }]]);
  listeners[0].listener();
  await waiting;
  assert.equal(ready, true);
  // Once the page has loaded, nothing waits.
  globalThis.document.readyState = "complete";
  await ensureChromeOffscreen("offscreen.html");
  assert.equal(listeners.length, 1);
});
