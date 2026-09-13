/*
 * Two real Chromes and the relay that stands in for GameSentenceMiner: one
 * shares itself, the other links to it, looks words up through it, edits shared
 * settings, survives the host closing and reopening, and unlinks again.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTOM_DICTIONARY_ID, CUSTOM_DICTIONARY_SOURCE_KEY, CUSTOM_DICTIONARY_TITLE } from "../extension/custom-dictionary.js";
import { startSharingRelayServer } from "./sharing-relay-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
// A test-only port keeps a developer's own GameSentenceMiner on the default port out of the way.
const PORT = Number(process.env.HACHIDORI_SHARING_PORT) || 18771;
const ADDRESS = `ws://127.0.0.1:${PORT}/link`;
const CUSTOM_SOURCE = "共有語, きょうゆうご, saved through the link\n";
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
// Set to a directory to save the documentation screenshots from this real run.
const SCREENSHOTS = process.env.HACHIDORI_SHARING_SCREENSHOTS || "";

function scratchPath(value, prefix) {
  const resolved = resolve(value);
  const relativePath = relative(resolve(tmpdir()), resolved);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
    || dirname(relativePath) !== "." || !basename(relativePath).startsWith(prefix)) {
    throw new Error(`${value} is not a dedicated ${prefix}* scratch path directly under ${tmpdir()}`);
  }
  return resolved;
}

const HOST_PROFILE = scratchPath(process.env.HACHIDORI_SHARING_HOST_PROFILE || `${tmpdir()}/hachidori-sharing-host-${process.pid}`, "hachidori-sharing-host-");
const CLIENT_PROFILE = scratchPath(process.env.HACHIDORI_SHARING_CLIENT_PROFILE || `${tmpdir()}/hachidori-sharing-client-${process.pid}`, "hachidori-sharing-client-");

function cachedChrome() {
  const suffixes = process.platform === "linux" ? [["chrome-linux64", "chrome"]]
    : process.platform === "darwin"
      ? [["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]]
      : process.platform === "win32" ? [["chrome-win64", "chrome.exe"], ["chrome-win32", "chrome.exe"]] : [];
  for (const name of ["hachidori-browsers", "hdw-browsers"]) {
    const root = resolve(CACHE, name, "chrome");
    if (!existsSync(root)) continue;
    const builds = readdirSync(root).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const build of builds) {
      for (const suffix of suffixes) {
        const candidate = resolve(root, build, ...suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return "";
}

function installedChrome() {
  const candidates = process.platform === "linux"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32" ? [resolve(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe")] : [];
  return candidates.find(existsSync) || "";
}

const CHROME = process.env.HACHIDORI_CHROME || process.env.CHROME_BIN || cachedChrome() || installedChrome();
const PUPPETEER_CANDIDATES = ["hachidori-e2e", "hdw-e2e"].map((name) =>
  resolve(CACHE, name, "node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js"));
const PUPPETEER = process.env.HACHIDORI_PUPPETEER || PUPPETEER_CANDIDATES.find(existsSync) || PUPPETEER_CANDIDATES[0];
const puppeteer = await import(`file://${PUPPETEER}`);

const CHECKS = [
  "the host imports the fixture and shares through the relay on the chosen port",
  "the linked browser finds the host, mirrors its dictionary state and looks a word up through it",
  "an options edit made on the linked browser is committed by the host and pushed back",
  "a personal dictionary save made on the linked browser lands in the host's source and answers lookups",
  "closing the host fails linked lookups, and relaunching it reconnects the linked browser by itself",
  "unlinking restores the linked browser's own empty state",
];
const results = [];
const diagnostics = [];

function fatal(message) {
  console.error(`FATAL ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function check(name, ok, detail = "") {
  if (!CHECKS.includes(name)) fatal(`unknown check "${name}"`);
  if (results.some((entry) => entry.name === name)) fatal(`check("${name}") ran twice`);
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n       ${detail}`}`);
}

function launch(profile) {
  return puppeteer.launch({
    executablePath: CHROME,
    userDataDir: profile,
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
  });
}

async function extensionId(browser) {
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker" && candidate.url().startsWith("chrome-extension://"),
    { timeout: 30_000 },
  );
  return new URL(target.url()).host;
}

async function openSettings(browser, id, label, section) {
  const page = await browser.newPage();
  page.on("console", (message) => diagnostics.push(`[${label}] ${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`[${label}] pageerror: ${error.message}`));
  await page.goto(`chrome-extension://${id}/settings.html#${section}`, { waitUntil: "domcontentloaded" });
  // A fresh install opens its startup page too; clicks only reach the active tab.
  await page.bringToFront();
  return page;
}

async function showSection(page, section) {
  await page.evaluate((hash) => { window.location.hash = hash; }, section);
  await page.waitForFunction((id) => document.getElementById(id)?.hidden === false, { timeout: 10_000, polling: 100 }, section);
}

// Runtime messages sent from an extension page reach that browser's own service
// worker; on the linked browser they are forwarded to the host.
function message(page, target, type, fields = {}) {
  return page.evaluate((request) => chrome.runtime.sendMessage(request),
    { target, type, requestId: `sharing-suite-${type}`, ...fields });
}

function sharingStatus(page) {
  return message(page, "hachidori-sharing", "hd_sharing_status");
}

function lookup(page, text = "食べたかった") {
  return message(page, "hoshidicts-offscreen", "hd_lookup", { text, maxResults: 32, scanLength: 16, options: {} });
}

function stored(page, keys) {
  return page.evaluate((list) => chrome.storage.local.get(list), keys);
}

async function until(predicate, what, timeoutMs = 30_000, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

async function importFixture(page) {
  await showSection(page, "add-dictionaries");
  await page.waitForSelector("#import-file", { visible: true });
  // A fresh profile's Settings page migrates dictionary state first; that
  // mutation holds the engine lock an early import would be refused by.
  await until(async () => {
    const status = await message(page, "hoshidicts-offscreen", "hd_status");
    return status?.ok && status.ready && !status.loading ? status : null;
  }, "the host engine to become idle", 60_000);
  await (await page.$("#import-file")).uploadFile(FIXTURE);
  const deadline = Date.now() + 120_000;
  let importState = "";
  while (importState !== "Finished 1 of 1 archive — 1 imported, 0 failed.") {
    if (Date.now() > deadline) throw new Error(`the fixture import did not finish: ${JSON.stringify(importState)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    importState = await page.evaluate(() => (document.querySelector("#import-state")?.textContent || "").trim());
  }
}

// Sharing is on by default on the standard port; the suite moves it to the
// test relay's port through the same message the switch sends.
async function enableSharing(page) {
  const reply = await message(page, "hachidori-sharing", "hd_sharing_host_enable", { port: PORT });
  if (!reply?.ok) throw new Error(`sharing could not be enabled: ${reply?.error}`);
  const connected = await until(async () => {
    const current = await sharingStatus(page);
    return current?.sharing?.connected ? current.sharing : null;
  }, "the host to connect to the relay", 30_000);
  await showSection(page, "sharing");
  await page.waitForFunction((port) => document.getElementById("sharing-status")?.textContent === `Sharing through GameSentenceMiner on port ${port}.`,
    { timeout: 15_000, polling: 100 }, PORT);
  return connected;
}

async function screenshot(page, name) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 2 });
  await showSection(page, "sharing");
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const clip = await page.evaluate(() => {
    const rect = document.getElementById("sharing").getBoundingClientRect();
    return { x: Math.max(0, rect.left - 12 + window.scrollX), y: Math.max(0, rect.top - 12 + window.scrollY), width: rect.width + 24, height: rect.height + 24 };
  });
  await page.screenshot({ path: resolve(SCREENSHOTS, name), clip });
}

function report(hostBrowser, clientBrowser) {
  const failed = results.filter((entry) => !entry.ok);
  for (const name of CHECKS) {
    if (!results.some((entry) => entry.name === name)) {
      results.push({ name, ok: false, detail: "check never ran" });
      failed.push(results.at(-1));
      console.log(`FAIL ${name}\n       check never ran`);
    }
  }
  console.log(`\n${results.length - failed.length}/${CHECKS.length} checks passed`);
  if (failed.length > 0) {
    console.log(`profiles kept for inspection: ${HOST_PROFILE} ${CLIENT_PROFILE}`);
    console.log("\nfailures:");
    for (const entry of failed) console.log(`  - ${entry.name}\n      ${entry.detail}`);
    console.log("\ndiagnostics:");
    for (const line of diagnostics) console.log(`  ${line}`);
    process.exitCode = 1;
  } else {
    for (const path of [HOST_PROFILE, CLIENT_PROFILE]) rmSync(path, { recursive: true, force: true });
  }
  void hostBrowser;
  void clientBrowser;
}

if (!existsSync(CHROME)) fatal(`Chrome not found; set HACHIDORI_CHROME (tried ${CHROME || "nothing"})`);
if (!existsSync(FIXTURE)) fatal(`missing ${FIXTURE}; run node test/make-fixture.mjs first`);
for (const path of [HOST_PROFILE, CLIENT_PROFILE]) rmSync(path, { recursive: true, force: true });
const relay = await startSharingRelayServer({ port: PORT });
console.log(`     relay listening on 127.0.0.1:${relay.port}`);

let hostBrowser = null;
let clientBrowser = null;
try {
  hostBrowser = await launch(HOST_PROFILE);
  const hostId = await extensionId(hostBrowser);
  console.log(`     host extension id: ${hostId}`);
  let hostPage = await openSettings(hostBrowser, hostId, "host", "add-dictionaries");
  await importFixture(hostPage);
  const hostSharing = await enableSharing(hostPage);
  const hostState = await stored(hostPage, ["dictionaryState", "options"]);
  check("the host imports the fixture and shares through the relay on the chosen port",
    hostSharing.enabled === true && hostSharing.connected === true && hostSharing.port === PORT && hostSharing.address === ADDRESS
      && hostSharing.error === null && relay.relay.hasHost
      && hostState.dictionaryState?.dictionaries?.some((dictionary) => dictionary.title === "hachidori-fixture") === true,
    JSON.stringify({ hostSharing, dictionaries: hostState.dictionaryState?.dictionaries?.map((entry) => entry.title) }));

  clientBrowser = await launch(CLIENT_PROFILE);
  const clientId = await extensionId(clientBrowser);
  console.log(`     client extension id: ${clientId}`);
  let clientPage = await openSettings(clientBrowser, clientId, "client", "sharing");
  await clientPage.waitForFunction(() => !document.getElementById("sharing-host-enabled").disabled, { timeout: 15_000, polling: 100 });
  // A fresh browser install shares by default, and a host cannot also link; the
  // client turns its own sharing off first, as a person would.
  const clientOff = await message(clientPage, "hachidori-sharing", "hd_sharing_host_disable");
  if (clientOff?.ok !== true) throw new Error(`client sharing could not be turned off: ${clientOff?.error}`);
  await clientPage.waitForFunction(() => !document.getElementById("sharing-client").disabled, { timeout: 15_000, polling: 100 });
  const probe = await message(clientPage, "hachidori-sharing", "hd_sharing_client_probe", { address: ADDRESS });
  const before = await stored(clientPage, ["dictionaryState"]);
  await clientPage.$eval("#sharing-client-address", (input, address) => { input.value = address; }, ADDRESS);
  await clientPage.bringToFront();
  await Promise.all([
    clientPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    clientPage.click("#sharing-client-link"),
  ]);
  const linked = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.connected ? reply.sharing.client : null;
  }, "the linked browser to connect", 30_000);
  const mirror = await stored(clientPage, ["dictionaryState", "options", "sharingLocalState", "sharing"]);
  const hostAfterLink = await stored(hostPage, ["dictionaryState", "options"]);
  const linkedLookup = await lookup(clientPage);
  const hostClients = (await sharingStatus(hostPage)).sharing.clients;
  await screenshot(hostPage, "sharing-settings.png");
  await screenshot(clientPage, "sharing-linked.png");
  check("the linked browser finds the host, mirrors its dictionary state and looks a word up through it",
    probe?.ok === true && probe.address === ADDRESS && probe.host?.dictionaryCount === hostState.dictionaryState.dictionaries.length
      && linked.address === ADDRESS && linked.host?.dictionaryCount === hostState.dictionaryState.dictionaries.length
      && JSON.stringify(mirror.dictionaryState) === JSON.stringify(hostAfterLink.dictionaryState)
      && JSON.stringify(mirror.options) === JSON.stringify(hostAfterLink.options)
      // A fresh profile's Settings page commits an empty library of its own; that is what is kept aside.
      && JSON.stringify(mirror.sharingLocalState?.dictionaryState ?? null) === JSON.stringify(before.dictionaryState ?? null)
      && mirror.sharing?.client?.address === ADDRESS
      && linkedLookup?.ok === true && linkedLookup.results?.[0]?.deinflected === "食べる"
      && hostClients.length === 1,
    JSON.stringify({ probe, linked, linkedLookup: { ok: linkedLookup?.ok, error: linkedLookup?.error, first: linkedLookup?.results?.[0]?.deinflected },
      own: before.dictionaryState ?? null, kept: mirror.sharingLocalState?.dictionaryState ?? null,
      mirrorRevision: mirror.dictionaryState?.revision, hostRevision: hostAfterLink.dictionaryState?.revision, hostClients }));

  const baseRevision = mirror.options?.revision ?? 0;
  const written = await message(clientPage, "hoshidicts-worker", "hd_options_write", { baseRevision, options: { scanLength: 7 } });
  const hostOptions = await until(async () => {
    const value = (await stored(hostPage, ["options"])).options;
    return value?.scanLength === 7 ? value : null;
  }, "the host to commit the linked browser's options edit", 15_000);
  const mirroredOptions = await until(async () => {
    const value = (await stored(clientPage, ["options"])).options;
    return value?.scanLength === 7 ? value : null;
  }, "the host's options batch to reach the linked browser", 15_000);
  check("an options edit made on the linked browser is committed by the host and pushed back",
    written?.ok === true && written.options?.scanLength === 7 && written.options.revision === baseRevision + 1
      && hostOptions.revision === written.options.revision && mirroredOptions.revision === written.options.revision,
    JSON.stringify({ written, hostOptions, mirroredOptions }));

  const saved = await message(clientPage, "hoshidicts-offscreen", "hd_custom_save", { baseDocumentRevision: 0, text: CUSTOM_SOURCE });
  const hostSource = await until(async () => {
    const value = (await stored(hostPage, [CUSTOM_DICTIONARY_SOURCE_KEY, "dictionaryState"]));
    return value[CUSTOM_DICTIONARY_SOURCE_KEY]?.text === CUSTOM_SOURCE ? value : null;
  }, "the host to store the linked browser's personal source", 60_000);
  const customLookup = await message(clientPage, "hoshidicts-offscreen", "hd_lookup_dictionary", { dictionary: CUSTOM_DICTIONARY_TITLE, text: "共有語" });
  const mirroredSource = await until(async () => {
    const value = (await stored(clientPage, [CUSTOM_DICTIONARY_SOURCE_KEY])) [CUSTOM_DICTIONARY_SOURCE_KEY];
    return value?.text === CUSTOM_SOURCE ? value : null;
  }, "the personal source to reach the linked browser", 15_000);
  check("a personal dictionary save made on the linked browser lands in the host's source and answers lookups",
    saved?.ok === true && hostSource.dictionaryState?.dictionaries?.[0]?.id === CUSTOM_DICTIONARY_ID
      && customLookup?.ok === true && (customLookup.results?.length ?? 0) > 0
      && mirroredSource.revision === hostSource[CUSTOM_DICTIONARY_SOURCE_KEY].revision,
    JSON.stringify({ saved: { ok: saved?.ok, error: saved?.error }, customLookup: { ok: customLookup?.ok, count: customLookup?.results?.length, error: customLookup?.error } }));

  await hostBrowser.close();
  hostBrowser = null;
  await until(async () => (relay.relay.hasHost ? null : true), "the relay to drop the closed host", 15_000);
  const unreachable = await until(async () => {
    const reply = await lookup(clientPage);
    return reply?.ok === false ? reply : null;
  }, "linked lookups to fail after the host closed", 30_000, 500);
  hostBrowser = await launch(HOST_PROFILE);
  const relaunchedId = await extensionId(hostBrowser);
  hostPage = await openSettings(hostBrowser, relaunchedId, "host-again", "sharing");
  const reconnected = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.connected ? reply.sharing.client : null;
  }, "the linked browser to reconnect after the host relaunched", 60_000, 500);
  const recovered = await lookup(clientPage);
  check("closing the host fails linked lookups, and relaunching it reconnects the linked browser by itself",
    unreachable.error === "The linked Hachidori is not reachable." && relaunchedId === hostId
      && reconnected.address === ADDRESS && recovered?.ok === true && recovered.results?.[0]?.deinflected === "食べる",
    JSON.stringify({ unreachable: { ok: unreachable?.ok, error: unreachable?.error }, reconnected, recovered: { ok: recovered?.ok, error: recovered?.error } }));

  await showSection(clientPage, "sharing");
  await clientPage.waitForFunction(() => document.getElementById("sharing-client-unlink")?.hidden === false, { timeout: 15_000, polling: 100 });
  await clientPage.bringToFront();
  await Promise.all([
    clientPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    clientPage.click("#sharing-client-unlink"),
  ]);
  const afterUnlink = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.linked === false ? reply.sharing.client : null;
  }, "the linked browser to unlink", 15_000);
  const ownState = await stored(clientPage, ["dictionaryState", "options", "sharingLocalState", "sharing", CUSTOM_DICTIONARY_SOURCE_KEY]);
  const ownLookup = await lookup(clientPage);
  check("unlinking restores the linked browser's own empty state",
    afterUnlink.linked === false
      && JSON.stringify(ownState.dictionaryState?.dictionaries ?? null) === JSON.stringify(before.dictionaryState?.dictionaries ?? null)
      && ownState.sharingLocalState === undefined
      && ownState[CUSTOM_DICTIONARY_SOURCE_KEY] === undefined && ownState.sharing?.client === null
      && ownState.options?.revision > (mirroredOptions.revision ?? 0)
      && ownLookup?.ok === true && (ownLookup.results?.length ?? 0) === 0,
    JSON.stringify({ afterUnlink, keys: Object.keys(ownState), ownOptions: ownState.options, ownLookup: { ok: ownLookup?.ok, count: ownLookup?.results?.length, error: ownLookup?.error } }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await hostBrowser?.close().catch(() => {});
  await clientBrowser?.close().catch(() => {});
  await relay.close();
  report(hostBrowser, clientBrowser);
}
