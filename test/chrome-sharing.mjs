/*
 * Two real Chromes and the Anki add-on's relay: one imports dictionaries,
 * hands out the add-on and shares itself; the other's startup page offers
 * that Hachidori and links with one click, looks words up through it, edits
 * shared settings, survives the host closing and reopening, unlinks, and
 * links again through this computer's own network address.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ANKI_ADDON_FILES, ANKI_ADDON_FILE_NAME } from "../extension/anki-addon.js";
import { CUSTOM_DICTIONARY_ID, CUSTOM_DICTIONARY_SOURCE_KEY, CUSTOM_DICTIONARY_TITLE } from "../extension/custom-dictionary.js";
import { BlobReader, TextWriter, ZipReader } from "../extension/vendor/zip.js";
import { startAnkiRelayServer } from "./anki-relay-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = resolve(ROOT, "extension");
const FIXTURE = resolve(ROOT, "test/fixtures/hachidori-fixture.zip");
// A test-only port keeps a developer's own Anki relay on the default port out of the way.
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
  "the host's Sharing page saves the Anki add-on as a valid archive while Anki is not yet connected",
  "the host imports the fixture and shares through Anki's relay on the chosen port",
  "the second browser's startup page offers the shared Hachidori, and one click links it and completes setup",
  "an options edit made on the linked browser is committed by the host and pushed back",
  "a personal dictionary save made on the linked browser lands in the host's source and answers lookups",
  "closing the host fails linked lookups, and relaunching it reconnects the linked browser by itself",
  "unlinking restores the linked browser's own empty state",
  "sharing with other computers lets the second browser link through this computer's network address, and turning it off disconnects it",
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

function watch(page, label) {
  page.on("console", (message) => diagnostics.push(`[${label}] ${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`[${label}] pageerror: ${error.message}`));
}

async function openSettings(browser, id, label, section) {
  const page = await browser.newPage();
  watch(page, label);
  await page.goto(`chrome-extension://${id}/settings.html#${section}`, { waitUntil: "domcontentloaded" });
  // A fresh install opens its startup page too; clicks only reach the active tab.
  await page.bringToFront();
  return page;
}

// The page a fresh install opens by itself.
async function startupPage(browser, id, label) {
  const url = `chrome-extension://${id}/startup.html`;
  const target = await browser.waitForTarget((candidate) => candidate.type() === "page" && candidate.url() === url, { timeout: 30_000 });
  const page = await target.page();
  watch(page, label);
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

function statusText(page) {
  return page.evaluate(() => document.getElementById("sharing-status")?.textContent ?? "");
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
  await page.waitForFunction((text) => document.getElementById("sharing-status")?.textContent === text,
    { timeout: 15_000, polling: 100 }, "Sharing through Anki.");
  return connected;
}

// The add-on the Sharing page hands out, saved into the host profile.
async function downloadAddon(page) {
  const downloads = resolve(HOST_PROFILE, "downloads");
  mkdirSync(downloads, { recursive: true });
  const session = await page.createCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  await showSection(page, "sharing");
  await page.waitForFunction(() => document.getElementById("sharing-addon")?.hidden === false && !document.getElementById("sharing-addon-download").disabled,
    { timeout: 15_000, polling: 100 });
  await page.bringToFront();
  await page.click("#sharing-addon-download");
  const bytes = await until(async () => {
    const file = resolve(downloads, ANKI_ADDON_FILE_NAME);
    if (!existsSync(file) || readdirSync(downloads).some((name) => name.endsWith(".crdownload"))) return null;
    return readFileSync(file);
  }, "the add-on download to finish", 30_000);
  await page.waitForFunction(() => document.getElementById("sharing-status")?.textContent.startsWith("Saved hachidori-relay.ankiaddon"), { timeout: 10_000, polling: 100 });
  const status = await statusText(page);
  await session.detach();
  const archive = new ZipReader(new BlobReader(new Blob([bytes])));
  const entries = await archive.getEntries();
  const manifestEntry = entries.find((entry) => entry.filename === "manifest.json");
  const manifest = manifestEntry ? JSON.parse(await manifestEntry.getData(new TextWriter())) : null;
  await archive.close();
  return { size: bytes.length, files: entries.map((entry) => entry.filename), manifest, status };
}

async function screenshot(page, name, { section = "sharing", element = "sharing" } = {}) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 2 });
  if (section !== null) await showSection(page, section);
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const clip = await page.evaluate((id) => {
    const rect = document.getElementById(id).getBoundingClientRect();
    return { x: Math.max(0, rect.left - 12 + window.scrollX), y: Math.max(0, rect.top - 12 + window.scrollY), width: rect.width + 24, height: rect.height + 24 };
  }, element);
  await page.screenshot({ path: resolve(SCREENSHOTS, name), clip });
}

function report() {
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
}

if (!existsSync(CHROME)) fatal(`Chrome not found; set HACHIDORI_CHROME (tried ${CHROME || "nothing"})`);
if (!existsSync(FIXTURE)) fatal(`missing ${FIXTURE}; run node test/make-fixture.mjs first`);
for (const path of [HOST_PROFILE, CLIENT_PROFILE]) rmSync(path, { recursive: true, force: true });
const relay = await startAnkiRelayServer({ port: PORT });
console.log(`     relay listening on 127.0.0.1:${relay.port}`);
const EXTENSION_VERSION = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version;

let hostBrowser = null;
let clientBrowser = null;
try {
  hostBrowser = await launch(HOST_PROFILE);
  const hostId = await extensionId(hostBrowser);
  console.log(`     host extension id: ${hostId}`);
  let hostPage = await openSettings(hostBrowser, hostId, "host", "add-dictionaries");
  await importFixture(hostPage);

  // Until Anki carries the connection the page offers the add-on; the host is still trying the default port.
  const addon = await downloadAddon(hostPage);
  check(CHECKS[0],
    addon.files.join(",") === ANKI_ADDON_FILES.join(",") && addon.manifest?.package === "hachidori-relay"
      && addon.manifest.human_version === EXTENSION_VERSION && Number.isInteger(addon.manifest.mod) && addon.size > 1000
      && addon.status === "Saved hachidori-relay.ankiaddon to your downloads. Double-click it to install it in Anki, then restart Anki.",
    JSON.stringify(addon));

  const hostSharing = await enableSharing(hostPage);
  const hostState = await stored(hostPage, ["dictionaryState", "options"]);
  check(CHECKS[1],
    hostSharing.enabled === true && hostSharing.connected === true && hostSharing.port === PORT && hostSharing.error === null
      && hostSharing.dictionaries === 1 && hostSharing.network?.enabled === false && hostSharing.network.active === false
      && hostState.dictionaryState?.dictionaries?.some((dictionary) => dictionary.title === "hachidori-fixture") === true,
    JSON.stringify({ hostSharing, dictionaries: hostState.dictionaryState?.dictionaries?.map((entry) => entry.title) }));

  clientBrowser = await launch(CLIENT_PROFILE);
  const clientId = await extensionId(clientBrowser);
  console.log(`     client extension id: ${clientId}`);
  // A fresh install opens its startup page, whose look around this computer
  // uses the port under Advanced; the suite moves that to the relay's port, as
  // a person on a changed port would have, and lets the page look again.
  const startup = await startupPage(clientBrowser, clientId, "client-startup");
  const clientPort = await message(startup, "hachidori-sharing", "hd_sharing_host_enable", { port: PORT });
  if (clientPort?.ok !== true) throw new Error(`the client port could not be set: ${clientPort?.error}`);
  await startup.reload({ waitUntil: "domcontentloaded" });
  await startup.waitForSelector("#setup-use-shared", { timeout: 15_000 });
  const offer = await startup.evaluate(() => ({
    body: document.getElementById("setup-body").textContent, button: document.getElementById("setup-use-shared").textContent,
  }));
  const probe = await message(startup, "hachidori-sharing", "hd_sharing_client_probe", { address: "" });
  const before = await stored(startup, ["dictionaryState"]);
  await screenshot(startup, "sharing-startup.png", { section: null, element: "setup-card" });
  await startup.bringToFront();
  await startup.click("#setup-use-shared");
  await startup.waitForFunction(() => document.getElementById("setup-heading")?.textContent === "Setup is complete.", { timeout: 30_000, polling: 100 });
  const linked = await until(async () => {
    const reply = await sharingStatus(startup);
    return reply?.sharing?.client?.connected ? reply.sharing : null;
  }, "the linked browser to connect", 30_000);
  const setup = await stored(startup, ["setupState"]);
  let clientPage = await openSettings(clientBrowser, clientId, "client", "sharing");
  const mirror = await stored(clientPage, ["dictionaryState", "options", "sharingLocalState", "sharing"]);
  const hostAfterLink = await stored(hostPage, ["dictionaryState", "options"]);
  const linkedLookup = await lookup(clientPage);
  const hostClients = (await sharingStatus(hostPage)).sharing.clients;
  await screenshot(hostPage, "sharing-settings.png");
  await screenshot(clientPage, "sharing-linked.png");
  const hostName = probe?.host?.name;
  check(CHECKS[2],
    probe?.ok === true && probe.display === "this computer" && typeof hostName === "string" && hostName !== ""
      && probe.host.dictionaryCount === hostState.dictionaryState.dictionaries.length
      && offer.body.includes(`${hostName} on this computer already has Hachidori set up, with 1 dictionary.`)
      && offer.button === `Use the Hachidori in ${hostName}`
      && setup.setupState?.stage === "complete"
      && linked.enabled === false && linked.client.address === ADDRESS && linked.client.display === "this computer"
      && linked.client.host?.name === hostName && linked.client.host.dictionaryCount === hostState.dictionaryState.dictionaries.length
      && JSON.stringify(mirror.dictionaryState) === JSON.stringify(hostAfterLink.dictionaryState)
      && JSON.stringify(mirror.options) === JSON.stringify(hostAfterLink.options)
      // The fresh browser's own library, empty whether or not its engine had committed it yet, is what is kept aside.
      && (mirror.sharingLocalState?.dictionaryState?.dictionaries ?? []).length === 0 && (before.dictionaryState?.dictionaries ?? []).length === 0
      && mirror.sharing?.client?.address === ADDRESS && mirror.sharing?.host?.enabled === false
      && linkedLookup?.ok === true && linkedLookup.results?.[0]?.deinflected === "食べる"
      && hostClients.length === 1 && hostClients[0].local === true && hostClients[0].name === hostName,
    JSON.stringify({ probe, offer, setup: setup.setupState?.stage, linked, linkedLookup: { ok: linkedLookup?.ok, error: linkedLookup?.error, first: linkedLookup?.results?.[0]?.deinflected },
      own: before.dictionaryState ?? null, kept: mirror.sharingLocalState?.dictionaryState ?? null, sharing: mirror.sharing,
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
  check(CHECKS[3],
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
  check(CHECKS[4],
    saved?.ok === true && hostSource.dictionaryState?.dictionaries?.[0]?.id === CUSTOM_DICTIONARY_ID
      && customLookup?.ok === true && (customLookup.results?.length ?? 0) > 0
      && mirroredSource.revision === hostSource[CUSTOM_DICTIONARY_SOURCE_KEY].revision,
    JSON.stringify({ saved: { ok: saved?.ok, error: saved?.error }, customLookup: { ok: customLookup?.ok, count: customLookup?.results?.length, error: customLookup?.error } }));

  await hostBrowser.close();
  hostBrowser = null;
  // The relay closes the linked browser's socket once it notices the host is gone.
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
  check(CHECKS[5],
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
  check(CHECKS[6],
    afterUnlink.linked === false
      && (ownState.dictionaryState?.dictionaries ?? []).length === 0
      && ownState.sharingLocalState === undefined
      && ownState[CUSTOM_DICTIONARY_SOURCE_KEY] === undefined && ownState.sharing?.client === null
      && ownState.options?.revision > (mirroredOptions.revision ?? 0)
      && ownLookup?.ok === true && (ownLookup.results?.length ?? 0) === 0,
    JSON.stringify({ afterUnlink, keys: Object.keys(ownState), ownOptions: ownState.options, ownLookup: { ok: ownLookup?.ok, count: ownLookup?.results?.length, error: ownLookup?.error } }));

  // Other computers: the host asks the relay for the network, and the second
  // browser links through this computer's own network address, as a laptop would.
  const networkOn = await message(hostPage, "hachidori-sharing", "hd_sharing_host_enable", { port: PORT, network: true });
  const hostNetwork = await until(async () => {
    const reply = await sharingStatus(hostPage);
    return reply?.sharing?.network?.active && reply.sharing.network.addresses.length > 0 ? reply.sharing.network : null;
  }, "the relay to open the network and report an address (this machine needs one beyond loopback)", 15_000);
  await showSection(hostPage, "sharing");
  await hostPage.waitForFunction((count) => document.querySelectorAll("#sharing-host-address-list code").length === count, { timeout: 10_000, polling: 100 }, hostNetwork.addresses.length);
  const shown = await hostPage.evaluate(() => ({
    status: document.getElementById("sharing-status").textContent,
    addresses: [...document.querySelectorAll("#sharing-host-address-list code")].map((node) => node.textContent),
  }));
  const remoteAddress = hostNetwork.addresses[0].address;
  const remote = `${remoteAddress}:${PORT}`;
  await showSection(clientPage, "sharing");
  await clientPage.waitForFunction(() => document.getElementById("sharing-client-link")?.hidden === false && !document.getElementById("sharing-client-link").disabled, { timeout: 15_000, polling: 100 });
  await clientPage.$eval("#sharing-client-address", (input, value) => { input.value = value; }, remote);
  await clientPage.bringToFront();
  await Promise.all([
    clientPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    clientPage.click("#sharing-client-link"),
  ]);
  const remoteLinked = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.connected ? reply.sharing.client : null;
  }, "the browser to link through the network address", 30_000);
  const remoteLookup = await lookup(clientPage);
  const remoteClients = (await sharingStatus(hostPage)).sharing.clients;
  const hostDictionaries = (await stored(hostPage, ["dictionaryState"])).dictionaryState.dictionaries.length;
  await clientPage.waitForFunction(() => document.getElementById("sharing-status")?.textContent.startsWith("Using the Hachidori in"), { timeout: 15_000, polling: 100 });
  const remoteStatus = await statusText(clientPage);
  const networkOff = await message(hostPage, "hachidori-sharing", "hd_sharing_host_enable", { port: PORT, network: false });
  const dropped = await until(async () => {
    const reply = await sharingStatus(clientPage);
    return reply?.sharing?.client?.connected === false ? reply.sharing.client : null;
  }, "the network link to drop when the host stops sharing on the network", 15_000);
  const hostAfterOff = await until(async () => {
    const reply = await sharingStatus(hostPage);
    return reply?.sharing?.network?.active === false && reply.sharing.clients.length === 0 ? reply.sharing : null;
  }, "the relay to close the network", 15_000);
  const cleanup = await message(clientPage, "hachidori-sharing", "hd_sharing_client_unlink");
  // The relay must have survived the swap back: this computer still finds the host through it.
  const stillThere = await message(clientPage, "hachidori-sharing", "hd_sharing_client_probe", { address: "" });
  check(CHECKS[7],
    networkOn?.ok === true && hostNetwork.enabled === true
      && shown.status === "Sharing through Anki, on this computer and the network."
      && shown.addresses.join(",") === hostNetwork.addresses.map((entry) => entry.address).join(",")
      && remoteLinked.address === `ws://${remoteAddress}:${PORT}/link` && remoteLinked.display === remote
      && remoteLookup?.ok === true && remoteLookup.results?.[0]?.deinflected === "食べる"
      && remoteClients.length === 1 && remoteClients[0].local === false && remoteClients[0].address === remoteAddress
      && remoteStatus === `Using the Hachidori in ${hostName} at ${remote} (${hostDictionaries} dictionaries).`
      && networkOff?.ok === true && dropped.linked === true && hostAfterOff.network.active === false && hostAfterOff.connected === true
      && cleanup?.ok === true && stillThere?.ok === true && relay.exitCode === null,
    JSON.stringify({ networkOn: networkOn?.ok, hostNetwork, shown, remoteLinked, remoteLookup: { ok: remoteLookup?.ok, error: remoteLookup?.error, first: remoteLookup?.results?.[0]?.deinflected },
      remoteClients, remoteStatus, networkOff: networkOff?.ok, dropped, hostAfterOff: { network: hostAfterOff.network, connected: hostAfterOff.connected, clients: hostAfterOff.clients.length },
      cleanup: cleanup?.ok, stillThere: stillThere?.ok, relayExit: relay.exitCode }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await hostBrowser?.close().catch(() => {});
  await clientBrowser?.close().catch(() => {});
  await relay.close();
  report();
}
