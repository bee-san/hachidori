#!/usr/bin/env node
// Validate both manifests, supported-browser pins, and optional release tag.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MANIFEST_VERSION_COMPONENT = /^(0|[1-9]\d*)$/u;
const MAX_MANIFEST_VERSION_COMPONENT = 65_535;
const FIREFOX_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/u;
const FIREFOX_BUILD = /^stable_((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?)$/u;

function fail(message) {
  throw new Error(message);
}

export function chromeVersion(value, label) {
  const match = CHROME_VERSION.exec(value);
  if (match === null) fail(`${label} must be an exact four-part Chrome version`);
  const components = match.slice(1).map(Number);
  if (!components.every(Number.isSafeInteger)) {
    fail(`${label} contains a version component that is too large`);
  }
  return components;
}

export function firefoxVersion(value, label) {
  const match = FIREFOX_VERSION.exec(value);
  if (match === null) fail(`${label} must be a Firefox version such as 153.0`);
  return match.slice(1).filter(component => component !== undefined).map(Number);
}

export function firefoxBuildVersion(value, label) {
  const match = FIREFOX_BUILD.exec(value ?? "");
  if (match === null) fail(`${label} must be a pinned stable Firefox build such as stable_155.0.1`);
  return firefoxVersion(match[1], label);
}

export function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

// The Firefox XPI ships the same version, and the pinned test Firefox must
// satisfy the manifest's own minimum, or the smoke test proves nothing.
export function validateFirefoxContract(manifest, firefoxManifest, tooling) {
  if (firefoxManifest?.manifest_version !== 2) fail("manifest.firefox.json must stay on manifest_version 2");
  if (firefoxManifest.version !== manifest.version) {
    fail("manifest.firefox.json version does not match manifest.json");
  }
  const gecko = firefoxManifest.browser_specific_settings?.gecko;
  const minimum = firefoxVersion(gecko?.strict_min_version, "gecko.strict_min_version");
  const current = firefoxBuildVersion(tooling?.config?.firefox, "config.firefox");
  if (compareVersions(current, minimum) < 0) {
    fail("the pinned Firefox test build is older than the manifest minimum");
  }
  return { minimumFirefox: gecko.strict_min_version, currentFirefox: tooling.config.firefox };
}

export function validateReleaseContract(manifest, tooling, tag = null, firefoxManifest = null) {
  const versionComponents = String(manifest?.version ?? "").split(".");
  if (versionComponents.length < 1 || versionComponents.length > 4
      || !versionComponents.every((component) =>
        MANIFEST_VERSION_COMPONENT.test(component)
          && Number(component) <= MAX_MANIFEST_VERSION_COMPONENT)) {
    fail("manifest.version is not a Chrome-compatible release version");
  }
  if (!/^(0|[1-9]\d*)$/u.test(manifest?.minimum_chrome_version ?? "")) {
    fail("manifest.minimum_chrome_version must be one Chrome major");
  }
  const minimum = chromeVersion(tooling?.config?.minimumChrome, "config.minimumChrome");
  const current = chromeVersion(tooling?.config?.chrome, "config.chrome");
  if (minimum[0] !== Number(manifest.minimum_chrome_version)) {
    fail("the minimum Chrome test build does not match the manifest minimum");
  }
  if (compareVersions(current, minimum) < 0) {
    fail("the current Chrome test build is older than the minimum build");
  }
  const expectedTag = manifest.version;
  if (tag !== null && tag !== expectedTag) {
    fail(`release tag ${JSON.stringify(tag)} must be ${expectedTag}`);
  }
  return {
    version: manifest.version,
    expectedTag,
    minimumChrome: tooling.config.minimumChrome,
    currentChrome: tooling.config.chrome,
    ...(firefoxManifest === null ? {} : validateFirefoxContract(manifest, firefoxManifest, tooling)),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function commandLineTag(arguments_) {
  if (arguments_.length === 0) return null;
  if (arguments_.length !== 2 || arguments_[0] !== "--tag" || arguments_[1] === "") {
    fail("usage: node scripts/check-release.mjs [--tag <manifest.version>]");
  }
  return arguments_[1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const contract = validateReleaseContract(
      readJson(resolve(ROOT, "extension/manifest.json")),
      readJson(resolve(ROOT, "test/tooling/package.json")),
      commandLineTag(process.argv.slice(2)),
      readJson(resolve(ROOT, "extension/manifest.firefox.json")),
    );
    console.log(
      `Hachidori ${contract.version}: Chrome ${contract.minimumChrome} minimum, `
      + `${contract.currentChrome} current; Firefox ${contract.minimumFirefox} minimum, `
      + `${contract.currentFirefox} current; tag ${contract.expectedTag}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
