#!/usr/bin/env node
// Lint and package the unsigned Firefox temporary-install XPI.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile, readdir, rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_FIREFOX_EXTENSION,
  prepareFirefoxExtension,
} from "./prepare-firefox.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = resolve(ROOT, "test/tooling");
const DEFAULT_ARTIFACTS = resolve(ROOT, "test/tmp/firefox-artifacts");

function outputArgument(arguments_) {
  if (arguments_.length === 0) return DEFAULT_ARTIFACTS;
  if (arguments_.length !== 2 || arguments_[0] !== "--output-dir" || arguments_[1] === "") {
    throw new Error("usage: node scripts/package-firefox.mjs [--output-dir <path>]");
  }
  return resolve(arguments_[1]);
}

async function webExtBin() {
  const packagePath = resolve(TOOLING, "node_modules/web-ext/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const entry = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.["web-ext"];
  if (typeof entry !== "string") throw new Error("The pinned web-ext executable is unavailable. Run npm ci --prefix test/tooling.");
  return resolve(dirname(packagePath), entry);
}

function run(command, arguments_) {
  const result = spawnSync(process.execPath, [command, ...arguments_], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`web-ext exited with status ${result.status}`);
}

export async function packageFirefoxExtension(output = DEFAULT_ARTIFACTS) {
  const source = await prepareFirefoxExtension(DEFAULT_FIREFOX_EXTENSION);
  await rm(output, { recursive: true, force: true });
  const executable = await webExtBin();
  run(executable, ["lint", "--source-dir", source]);
  run(executable, [
    "build",
    "--source-dir", source,
    "--artifacts-dir", output,
    "--overwrite-dest",
  ]);
  const zipFiles = (await readdir(output)).filter(name => name.endsWith(".zip"));
  if (zipFiles.length !== 1) {
    throw new Error(`Expected one Firefox package, found ${zipFiles.length}.`);
  }
  const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
  const xpi = resolve(output, `hachidori-${manifest.version}-firefox-unsigned.xpi`);
  await rename(resolve(output, zipFiles[0]), xpi);
  console.log(xpi);
  return xpi;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await packageFirefoxExtension(outputArgument(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
