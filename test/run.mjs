// Run the existing suites with the lockfile's test tooling and pinned Chrome and Firefox.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = resolve(ROOT, "test/tooling");
const OUTPUT = resolve(ROOT, "test/tmp/ci");
const CACHE = resolve(ROOT, "test/tmp/browsers");
// scripts/build-firefox.py writes the Firefox build of extension/ here, unless
// HACHIDORI_FIREFOX_EXTENSION names another unpacked build to test.
const FIREFOX_EXTENSION = process.env.HACHIDORI_FIREFOX_EXTENSION || resolve(ROOT, "test/tmp/firefox-extension");
const require = createRequire(resolve(TOOLING, "package.json"));
const { config } = JSON.parse(readFileSync(resolve(TOOLING, "package.json"), "utf8"));
const { Browser, computeExecutablePath, install } = await import(require.resolve("@puppeteer/browsers"));
const chromeBuild = process.env.HACHIDORI_CHROME_BUILD || config.chrome;
const firefoxBuild = process.env.HACHIDORI_FIREFOX_BUILD || config.firefox;
const env = {
  ...process.env,
  HACHIDORI_JSDOM: process.env.HACHIDORI_JSDOM || TOOLING,
  HACHIDORI_PUPPETEER: process.env.HACHIDORI_PUPPETEER || require.resolve("puppeteer-core"),
  HACHIDORI_CHROME: process.env.HACHIDORI_CHROME
    || computeExecutablePath({ cacheDir: CACHE, browser: Browser.CHROME, buildId: chromeBuild }),
  HACHIDORI_FIREFOX: process.env.HACHIDORI_FIREFOX
    || computeExecutablePath({ cacheDir: CACHE, browser: Browser.FIREFOX, buildId: firefoxBuild }),
  HACHIDORI_FIREFOX_EXTENSION: FIREFOX_EXTENSION,
};

async function run(name, args, overrides = {}, executable = process.execPath) {
  const prefix = Object.entries(overrides).map(([key, value]) => `${key}=${JSON.stringify(value)} `).join("");
  const command = `${prefix}${executable === process.execPath ? "node" : executable} ${args.join(" ")}`;
  console.log(`\n$ ${command}`);
  const log = createWriteStream(resolve(OUTPUT, `${name}.log`));
  log.write(`$ ${command}\n`);
  const child = spawn(executable, args, { cwd: ROOT, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  try {
    const [code, signal] = await once(child, "close");
    if (code !== 0) throw new Error(`${name} failed (${signal || `exit ${code}`}); see test/tmp/ci/${name}.log`);
  } finally {
    log.end();
    await finished(log);
  }
}

// The node:test suites: the spec reporter keeps their logs readable, and the run ends
// once every test has finished even though the code under test leaves timers behind.
const NODE_TEST = ["--test-force-exit", "--test-reporter=spec"];

const buildFirefox = () => process.env.HACHIDORI_FIREFOX_EXTENSION
  || run("firefox-build", ["scripts/build-firefox.py", "--output-dir", FIREFOX_EXTENSION], {}, "python3");

const suite = process.argv[2];
mkdirSync(OUTPUT, { recursive: true });
try {
  if (suite === "install-chrome") {
    const browser = await install({ cacheDir: CACHE, browser: Browser.CHROME, buildId: chromeBuild,
      installDeps: process.argv.includes("--install-deps") });
    console.log(`Chrome ${chromeBuild}: ${browser.executablePath}`);
  } else if (suite === "install-firefox") {
    const browser = await install({ cacheDir: CACHE, browser: Browser.FIREFOX, buildId: firefoxBuild });
    console.log(`Firefox ${firefoxBuild}: ${browser.executablePath}`);
  } else if (suite === "firefox-lint") {
    // addons-linter, the validator addons.mozilla.org runs, through web-ext.
    await buildFirefox();
    const webExt = resolve(TOOLING, "node_modules/web-ext/bin/web-ext.js");
    await run("firefox-lint", [webExt, "lint", "--source-dir", FIREFOX_EXTENSION, "--no-config-discovery"]);
  } else if (suite === "firefox-e2e" || suite === "firefox-large") {
    await run("fixture", ["test/make-fixture.mjs"]);
    await buildFirefox();
    await run(suite, [...NODE_TEST, `test/${suite}.mjs`]);
  } else if (suite === "lint") {
    const eslint = resolve(dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
    await run("lint", [eslint, "--config", "test/tooling/eslint.config.mjs", "."]);
  } else if (suite === "node") {
    const tests = ["test", "benchmark"].flatMap(directory => readdirSync(resolve(ROOT, directory))
      .filter(file => file.endsWith(".test.mjs")).sort().map(file => `${directory}/${file}`));
    await run("fixture", ["test/make-fixture.mjs"]);
    await run("node", ["--test", "--test-concurrency=4", ...tests]);
  } else if (suite === "smoke") {
    await run("fixture", ["test/make-fixture.mjs"]);
    await run("node-threaded", ["test/node-smoke.mjs"]);
    await run("node-threaded-idbfs", ["test/node-smoke.mjs"], { HACHIDORI_WASM_VARIANT: "threaded-idbfs" });
    await run("node-fallback", ["test/node-smoke.mjs"], { HACHIDORI_WASM_VARIANT: "fallback" });
    // The language ABI on every build (docs/languages.md 18).
    await run("node-languages-threaded", ["test/node-smoke-languages.mjs"]);
    await run("node-languages-threaded-idbfs", ["test/node-smoke-languages.mjs"], { HACHIDORI_WASM_VARIANT: "threaded-idbfs" });
    await run("node-languages-fallback", ["test/node-smoke-languages.mjs"], { HACHIDORI_WASM_VARIANT: "fallback" });
    await run("threaded-bridge", ["test/threaded-bridge-smoke.mjs"]);
    await run("extension-smoke", [...NODE_TEST, "test/extension-smoke.mjs"]);
  } else if (["chrome-e2e", "chrome-sharing", "chrome-fallback", "chrome-overlay", "chrome-theme-contrast",
    "chrome-theme-languages"].includes(suite)) {
    await run("fixture", ["test/make-fixture.mjs"]);
    if (suite === "chrome-e2e") await run("chrome-theme-store", ["test/chrome-theme-store.mjs"]);
    await run(suite, [...(suite === "chrome-e2e" ? NODE_TEST : []), `test/${suite}.mjs`], {
      HACHIDORI_DEINFLECTION_SCREENSHOT: process.env.HACHIDORI_DEINFLECTION_SCREENSHOT || resolve(OUTPUT, "deinflection.png"),
      HACHIDORI_SETTINGS_THEME_FILMSTRIP: process.env.HACHIDORI_SETTINGS_THEME_FILMSTRIP || resolve(OUTPUT, "settings-theme-first-frame.png"),
      HACHIDORI_SHARING_SCREENSHOTS: process.env.HACHIDORI_SHARING_SCREENSHOTS || resolve(OUTPUT, "sharing"),
      HACHIDORI_FREQUENCY_SCREENSHOT: process.env.HACHIDORI_FREQUENCY_SCREENSHOT || resolve(OUTPUT, "frequency-inference.png"),
    });
    if (suite === "chrome-e2e") {
      await run("chrome-netflix-subtitle-drag", ["test/chrome-netflix-subtitle-drag.mjs"]);
      await run("chrome-popup-scale", ["test/chrome-popup-scale.mjs"]);
      await run("chrome-bulk-import", ["test/chrome-bulk-import.mjs"]);
    }
  } else if (suite === "chrome-languages") {
    // Languages in real Chrome (docs/languages.md 18); its screenshots go to test/tmp/languages/.
    await run("fixture", ["test/make-fixture.mjs"]);
    await run(suite, [`test/${suite}.mjs`]);
    // Backups and sharing with profiles; the sharing part needs python3 and the
    // pinned add-on (or HACHIDORI_ANKI_ADDON / HACHIDORI_RELAY_SERVER).
    await run("chrome-languages-backup", ["test/chrome-languages/backup.mjs"]);
    await run("chrome-languages-sharing", ["test/chrome-languages/sharing.mjs"]);
  } else if (suite === "chrome-backup-release") {
    // Downloads the previous release from GitHub, so it is run before a release, not on every PR.
    // The released backup is also restored in the Firefox build.
    await buildFirefox();
    await run(suite, [`test/${suite}.mjs`]);
  } else {
    throw new Error(
      "Choose lint, node, smoke, chrome-e2e, chrome-sharing, chrome-fallback,"
        + " chrome-overlay, chrome-theme-contrast, chrome-theme-languages, chrome-languages, chrome-backup-release,"
        + " install-chrome,"
        + " firefox-lint, firefox-e2e, firefox-large or install-firefox.",
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
