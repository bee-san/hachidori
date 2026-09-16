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
    /must be v0\.1\.1/u,
  );
  assert.throws(
    () => validateReleaseContract({ ...manifest, version: "0.65536.0" }, tooling),
    /not a Chrome-compatible release version/u,
  );
  assert.throws(
    () => validateReleaseContract({ ...manifest, version: "0.01.0" }, tooling),
    /not a Chrome-compatible release version/u,
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
  assert.match(runtime, /name: Firefox draft smoke and package/u);
  assert.match(runtime, /npm --prefix test\/tooling run install:firefox/u);
  assert.match(runtime, /npm --prefix test\/tooling run test:firefox/u);
  assert.match(runtime, /npm --prefix test\/tooling run package:firefox/u);
  assert.match(runtime, /name: firefox-draft-unsigned-xpi/u);
});

test("tag and manual release runs verify and publish the checksummed package pair", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /tags: \['v\*'\]/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /publish:[\s\S]*type: boolean[\s\S]*default: false/u);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /node scripts\/check-release\.mjs --tag/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.match(workflow, /python3 scripts\/package-store\.py/u);
  assert.match(workflow, /sha256sum -c/u);
  assert.match(workflow, /outputs:[\s\S]*release_tag:[\s\S]*release_commit:/u);
  assert.match(workflow, /publish:\n[\s\S]*if: github\.event_name == 'push' \|\| inputs\.publish/u);
  assert.match(workflow, /publish:[\s\S]*needs: package[\s\S]*permissions:\n      contents: write/u);
  assert.match(workflow, /gh release create/u);
  assert.match(workflow, /gh release upload[\s\S]*--clobber/u);
  assert.match(workflow, /Release tag \$RELEASE_TAG points to \$tag_commit/u);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/u);
  assert.match(
    workflow,
    /chrome-web-store:[\s\S]*if: github\.event_name == 'push' \|\| inputs\.publish[\s\S]*needs: \[package, publish\]/u,
  );
  assert.match(workflow, /secrets\.CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON/u);
  assert.match(workflow, /vars\.CHROME_WEBSTORE_PUBLISHER_ID/u);
  assert.match(workflow, /vars\.CHROME_WEBSTORE_EXTENSION_ID/u);
  assert.match(workflow, /node scripts\/chrome-web-store\.mjs/u);
  assert.match(workflow, /--publish-type DEFAULT_PUBLISH/u);
});

test("public compatibility copy agrees with the tested manifest minimum", () => {
  assert.match(read("README.md"), /Chrome-128%2B/u);
  assert.match(read("extension/README.md"), /Chrome 128 or newer/u);
  assert.doesNotMatch(read("docs/chrome-web-store.md"), /Chrome 118 minimum/u);
});
