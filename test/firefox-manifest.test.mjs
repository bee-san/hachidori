// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

import {
  FIREFOX_EXCLUDED_FILES,
  prepareFirefoxExtension,
} from "../scripts/prepare-firefox.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const readJson = path => readFile(resolve(ROOT, path), "utf8").then(JSON.parse);
const [chromeManifest, firefoxManifest] = await Promise.all([
  readJson("extension/manifest.json"),
  readJson("extension/manifest.firefox.json"),
]);

test("Firefox MV2 manifest preserves every shared Chrome declaration", () => {
  for (const field of ["name", "short_name", "version", "icons", "options_page", "commands"]) {
    assert.deepEqual(firefoxManifest[field], chromeManifest[field], field);
  }
  assert.equal(firefoxManifest.description.replace("Firefox", "Chrome"), chromeManifest.description);
  assert.deepEqual(firefoxManifest.browser_action, chromeManifest.action);
  assert.deepEqual(
    firefoxManifest.permissions,
    [...chromeManifest.permissions.filter(permission => permission !== "offscreen"), ...chromeManifest.host_permissions],
  );
  assert.deepEqual(
    firefoxManifest.content_scripts[0].js,
    chromeManifest.content_scripts[0].js.filter(path => path !== "capture-content.js"),
  );
  assert.deepEqual(firefoxManifest.content_scripts[0].css, chromeManifest.content_scripts[0].css);
  assert.deepEqual(
    firefoxManifest.web_accessible_resources,
    chromeManifest.web_accessible_resources[0].resources,
  );
});

test("Firefox manifest is persistent, stable, desktop-only, and has no capture entry point", () => {
  assert.equal(firefoxManifest.manifest_version, 2);
  assert.deepEqual(firefoxManifest.background, {
    page: "firefox-background.html",
    persistent: true,
  });
  assert.equal(firefoxManifest.browser_action.default_popup, "toolbar.html");
  assert.equal(firefoxManifest.browser_specific_settings.gecko.id, "hachidori@bee-san");
  assert.equal(firefoxManifest.browser_specific_settings.gecko.strict_min_version, "153.0");
  assert.deepEqual(
    firefoxManifest.browser_specific_settings.gecko.data_collection_permissions,
    { required: ["none"] },
  );
  assert.ok(firefoxManifest.permissions.includes("<all_urls>"));
  assert.ok(!firefoxManifest.permissions.includes("offscreen"));
  assert.ok(!firefoxManifest.content_scripts[0].js.includes("capture-content.js"));
  assert.equal(firefoxManifest.cross_origin_embedder_policy, undefined);
  assert.equal(firefoxManifest.cross_origin_opener_policy, undefined);
  assert.equal(firefoxManifest.browser_specific_settings.gecko_android, undefined);
});

test("preparation replaces only the staged manifest", async t => {
  const output = resolve(ROOT, "test/tmp/firefox-manifest-contract");
  t.after(() => rm(output, { recursive: true, force: true }));
  await prepareFirefoxExtension(output);
  assert.deepEqual(JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8")), firefoxManifest);
  await assert.rejects(readFile(resolve(output, "manifest.firefox.json")), /ENOENT/u);
  assert.match(await readFile(resolve(output, "chrome-offscreen.js"), "utf8"), /ensureChromeOffscreen/u);
  for (const path of FIREFOX_EXCLUDED_FILES) {
    await assert.rejects(readFile(resolve(output, path)), /ENOENT/u, path);
  }
  assert.match(await readFile(resolve(output, "media-limits.js"), "utf8"), /MAX_WAV_BYTES/u);
  assert.deepEqual(await readJson("extension/manifest.json"), chromeManifest);
});
