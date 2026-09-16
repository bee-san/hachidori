#!/usr/bin/env node
// Assemble the reviewed Firefox manifest with the shared extension sources.
// SPDX-License-Identifier: GPL-3.0-or-later

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "extension");
export const DEFAULT_FIREFOX_EXTENSION = resolve(ROOT, "test/tmp/firefox-extension");
export const FIREFOX_EXCLUDED_FILES = Object.freeze([
  "avif-sequence.js",
  "capture-audio-worklet.js",
  "capture-buffer.js",
  "capture-content.js",
  "capture-encoder-client.js",
  "capture-encoder-worker.js",
  "capture-frame-client.js",
  "capture-frame-worker.js",
  "capture-host.js",
  "capture-session.js",
  "capture-speech.js",
  "capture-timeline.js",
  "capture.css",
  "capture.html",
  "capture.js",
  "vendor/avif-encoder.mjs",
  "vendor/avif-encoder.wasm",
]);

function outputArgument(arguments_) {
  if (arguments_.length === 0) return DEFAULT_FIREFOX_EXTENSION;
  if (arguments_.length !== 2 || arguments_[0] !== "--output-dir" || arguments_[1] === "") {
    throw new Error("usage: node scripts/prepare-firefox.mjs [--output-dir <path>]");
  }
  return resolve(arguments_[1]);
}

export async function prepareFirefoxExtension(output = DEFAULT_FIREFOX_EXTENSION) {
  if (output === SOURCE || SOURCE.startsWith(`${output}/`)) {
    throw new Error("The Firefox output directory must not contain extension/.");
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(SOURCE, output, { recursive: true });
  const firefoxManifest = await readFile(resolve(SOURCE, "manifest.firefox.json"), "utf8");
  await writeFile(resolve(output, "manifest.json"), firefoxManifest);
  await rm(resolve(output, "manifest.firefox.json"));
  await Promise.all(FIREFOX_EXCLUDED_FILES.map(path => rm(resolve(output, path))));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const output = await prepareFirefoxExtension(outputArgument(process.argv.slice(2)));
    console.log(output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
