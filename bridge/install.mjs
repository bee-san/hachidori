#!/usr/bin/env node
/*
 * Registers bridge/hachidori-bridge.mjs as a Chrome native messaging host for
 * one browser profile, or removes that registration again.
 *
 *   node bridge/install.mjs --extension-id <id> [--browser chrome|chromium|chrome-for-testing]
 *                           [--user-data-dir <dir>] [--uninstall]
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "../extension/sharing-protocol.js";

const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(BRIDGE_DIR, "hachidori-bridge.mjs");
const BROWSERS = ["chrome", "chromium", "chrome-for-testing"];

function usage(message) {
  process.stderr.write(`${message ? `${message}\n\n` : ""}Usage: node bridge/install.mjs --extension-id <id> [--browser ${BROWSERS.join("|")}] [--user-data-dir <dir>] [--uninstall]\n`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { ids: [], browser: "chrome", userDataDir: null, uninstall: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) usage(`${argument} needs a value`);
      return argv[index];
    };
    if (argument === "--extension-id") options.ids.push(value());
    else if (argument === "--browser") options.browser = value();
    else if (argument === "--user-data-dir") options.userDataDir = resolve(value());
    else if (argument === "--uninstall") options.uninstall = true;
    else if (argument === "--help" || argument === "-h") usage();
    else usage(`unknown argument ${argument}`);
  }
  if (!BROWSERS.includes(options.browser)) usage(`unknown browser ${options.browser}`);
  if (!options.uninstall && options.ids.length === 0) usage("--extension-id is required; Settings → Sharing shows it");
  return options;
}

function defaultUserDataDir(browser) {
  const home = homedir();
  if (process.platform === "darwin") {
    const support = resolve(home, "Library", "Application Support");
    return { chrome: resolve(support, "Google", "Chrome"), chromium: resolve(support, "Chromium"),
      "chrome-for-testing": resolve(support, "Google", "Chrome for Testing") }[browser];
  }
  const config = process.env.XDG_CONFIG_HOME || resolve(home, ".config");
  return { chrome: resolve(config, "google-chrome"), chromium: resolve(config, "chromium"),
    "chrome-for-testing": resolve(config, "google-chrome-for-testing") }[browser];
}

function registryKey(browser) {
  return `HKCU\\Software\\${browser === "chromium" ? "Chromium" : "Google\\Chrome"}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
}

function writeLauncher() {
  if (process.platform === "win32") {
    const launcher = resolve(BRIDGE_DIR, "hachidori-bridge.cmd");
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${BRIDGE}" %*\r\n`);
    return launcher;
  }
  // Chrome starts native hosts with a minimal environment, so the launcher
  // names the node binary that ran this installer instead of relying on PATH.
  const launcher = resolve(BRIDGE_DIR, "hachidori-bridge.sh");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${BRIDGE}" "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

function manifestPath(options) {
  if (process.platform === "win32") return resolve(BRIDGE_DIR, `${NATIVE_HOST_NAME}.json`);
  return resolve(options.userDataDir ?? defaultUserDataDir(options.browser), "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
}

function install(options) {
  const launcher = writeLauncher();
  const manifest = manifestPath(options);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: "Hachidori sharing bridge",
    path: launcher,
    type: "stdio",
    allowed_origins: options.ids.map(id => `chrome-extension://${id}/`),
  }, null, 2)}\n`);
  process.stdout.write(`wrote ${launcher}\nwrote ${manifest}\n`);
  if (process.platform === "win32") {
    execFileSync("reg", ["add", registryKey(options.browser), "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "inherit" });
    process.stdout.write(`registered ${registryKey(options.browser)}\n`);
  }
}

function uninstall(options) {
  const manifest = manifestPath(options);
  rmSync(manifest, { force: true });
  process.stdout.write(`removed ${manifest}\n`);
  for (const launcher of ["hachidori-bridge.sh", "hachidori-bridge.cmd"]) rmSync(resolve(BRIDGE_DIR, launcher), { force: true });
  if (process.platform === "win32") {
    execFileSync("reg", ["delete", registryKey(options.browser), "/f"], { stdio: "inherit" });
    process.stdout.write(`unregistered ${registryKey(options.browser)}\n`);
  }
}

const options = parseArguments(process.argv.slice(2));
if (options.uninstall) uninstall(options);
else install(options);
