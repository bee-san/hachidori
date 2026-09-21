#!/usr/bin/env node
// Lint the prepared Firefox extension with the pinned web-ext.
// scripts/package-store.py builds the release XPI from the same file list.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_FIREFOX_EXTENSION,
  prepareFirefoxExtension,
} from "./prepare-firefox.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLING = resolve(ROOT, "test/tooling");

async function webExtBin() {
  const packagePath = resolve(TOOLING, "node_modules/web-ext/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const entry = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.["web-ext"];
  if (typeof entry !== "string") throw new Error("The pinned web-ext executable is unavailable. Run npm ci --prefix test/tooling.");
  return resolve(dirname(packagePath), entry);
}

export async function lintFirefoxExtension(output = DEFAULT_FIREFOX_EXTENSION) {
  const source = await prepareFirefoxExtension(output);
  const result = spawnSync(process.execPath, [await webExtBin(), "lint", "--source-dir", source], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`web-ext lint exited with status ${result.status}`);
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error("usage: node scripts/lint-firefox.mjs");
    await lintFirefoxExtension();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
