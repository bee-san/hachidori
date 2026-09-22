// Run the existing suites with the lockfile's test tooling and pinned Chrome.
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
};

async function run(name, args, overrides = {}) {
  const prefix = Object.entries(overrides).map(([key, value]) => `${key}=${JSON.stringify(value)} `).join("");
  const command = `${prefix}node ${args.join(" ")}`;
  console.log(`\n$ ${command}`);
  const log = createWriteStream(resolve(OUTPUT, `${name}.log`));
  log.write(`$ ${command}\n`);
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
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
    await run("threaded-bridge", ["test/threaded-bridge-smoke.mjs"]);
    await run("extension-smoke", ["test/extension-smoke.mjs"]);
  } else if (suite === "firefox-smoke") {
    await run("fixture", ["test/make-fixture.mjs"]);
    await run("firefox-smoke", ["test/firefox-smoke.mjs"]);
  } else if (["chrome-e2e", "chrome-sharing", "chrome-fallback", "chrome-overlay"].includes(suite)) {
    await run("fixture", ["test/make-fixture.mjs"]);
    await run(suite, [`test/${suite}.mjs`], {
      HACHIDORI_DEINFLECTION_SCREENSHOT: process.env.HACHIDORI_DEINFLECTION_SCREENSHOT || resolve(OUTPUT, "deinflection.png"),
      HACHIDORI_SETTINGS_THEME_FILMSTRIP: process.env.HACHIDORI_SETTINGS_THEME_FILMSTRIP || resolve(OUTPUT, "settings-theme-first-frame.png"),
      HACHIDORI_SHARING_SCREENSHOTS: process.env.HACHIDORI_SHARING_SCREENSHOTS || resolve(OUTPUT, "sharing"),
    });
    if (suite === "chrome-e2e") await run("chrome-popup-scale", ["test/chrome-popup-scale.mjs"]);
  } else {
    throw new Error(
      "Choose node, smoke, firefox-smoke, chrome-e2e, chrome-sharing, chrome-fallback,"
        + " chrome-overlay, install-chrome or install-firefox.",
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
