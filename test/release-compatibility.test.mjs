import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

import {
  chromeVersion,
  compareVersions,
  validateReleaseContract,
} from "../scripts/check-release.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const manifest = JSON.parse(read("extension/manifest.json"));
const tooling = JSON.parse(read("test/tooling/package.json"));

test("manifest, minimum Chrome, current Chrome and release tag share one contract", () => {
  assert.deepEqual(validateReleaseContract(manifest, tooling, `v${manifest.version}`), {
    version: manifest.version,
    expectedTag: `v${manifest.version}`,
    minimumChrome: "128.0.6613.137",
    currentChrome: "152.0.7977.75",
  });
  assert.equal(
    compareVersions(
      chromeVersion(tooling.config.chrome, "current"),
      chromeVersion(tooling.config.minimumChrome, "minimum"),
    ),
    1,
  );
});

test("release validation rejects browser drift and a tag that does not match the manifest", () => {
  assert.throws(
    () => validateReleaseContract(manifest, {
      config: { ...tooling.config, minimumChrome: "127.0.0.1" },
    }),
    /does not match the manifest minimum/u,
  );
  assert.throws(
    () => validateReleaseContract(manifest, {
      config: { ...tooling.config, chrome: "127.0.0.1" },
    }),
    /current Chrome test build is older/u,
  );
  assert.throws(
    () => validateReleaseContract(manifest, tooling, "v9.9.9"),
    /must be v0\.1\.0/u,
  );
});

test("CI checks both supported-browser edges and packages every release candidate", () => {
  const runtime = read(".github/workflows/runtime-tests.yml");
  assert.match(runtime, /name: chrome-e2e \(Chrome minimum\)/u);
  assert.match(runtime, /config\.minimumChrome/u);
  assert.match(runtime, /node test\/run\.mjs chrome-e2e/u);
  assert.match(runtime, /name: Release package/u);
  assert.match(runtime, /python3 scripts\/package-store\.py/u);
  assert.match(runtime, /sha256sum -c/u);
});

test("tag and manual release runs verify and publish the checksummed package pair", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /tags: \['v\*'\]/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /node scripts\/check-release\.mjs --tag/u);
  assert.match(workflow, /python3 scripts\/package-store\.py/u);
  assert.match(workflow, /sha256sum -c/u);
  assert.match(workflow, /gh release create/u);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
});

test("public compatibility copy agrees with the tested manifest minimum", () => {
  assert.match(read("README.md"), /Chrome-128%2B/u);
  assert.match(read("extension/README.md"), /Chrome 128 or newer/u);
  assert.doesNotMatch(read("docs/chrome-web-store.md"), /Chrome 118 minimum/u);
});
