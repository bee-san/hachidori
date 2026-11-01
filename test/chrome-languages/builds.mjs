/*
 * The builds the language suites run in real Chrome: copies of extension/
 * whose language registry holds Japanese and some of the fixture packs of
 * test/data/languages/ (written by scripts/sync-languages.mjs's generator), and
 * the released Hachidori that test/chrome-backup-release.mjs pins, a build
 * from before profiles. Not a test on its own.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { languageFiles } from "../../scripts/sync-languages.mjs";
import { BlobReader, Uint8ArrayWriter, ZipReader } from "../../extension/vendor/zip.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
const [RELEASE_VERSION, RELEASE_COMMIT, RELEASE_SHA256] = (process.env.HACHIDORI_BACKUP_RELEASE
  || "0.3.2 4745397e8188 39af65baa6a823bb1cd83adb12d3239651b9b4930ded1cceb1fcff1468feaaf9").split(/\s+/u);
const RELEASE_ASSET = `hachidori-${RELEASE_VERSION}-${RELEASE_COMMIT}-chrome.zip`;

// A pack only one build has: the English fixture pack under another code.
function writeVariantPack(directory, { code, name, iso639_3: iso }) {
  const source = resolve(ROOT, "test/data/languages/en");
  mkdirSync(directory, { recursive: true });
  const pack = JSON.parse(readFileSync(join(source, "language.json"), "utf8"));
  Object.assign(pack, { code, bcp47: code, iso639_3: iso, name, nativeName: name });
  writeFileSync(join(directory, "language.json"), `${JSON.stringify(pack, null, 2)}\n`);
  cpSync(join(source, "transforms.json"), join(directory, "transforms.json"));
}

/**
 * A copy of extension/ under `scratch` whose registry holds Japanese and the
 * fixture packs `codes`; `variants` adds packs made from the English fixture
 * under other codes ({ code, name, iso639_3 }).
 */
export async function extensionWith(scratch, name, codes, variants = []) {
  const directory = join(scratch, name);
  cpSync(resolve(ROOT, "extension"), directory, { recursive: true });
  const packs = join(scratch, `${name}-packs`);
  mkdirSync(join(packs, "languages"), { recursive: true });
  symlinkSync(resolve(ROOT, "third_party/hoshidicts/tools"), join(packs, "tools"));
  symlinkSync(resolve(ROOT, "third_party/hoshidicts/languages/ja"), join(packs, "languages/ja"));
  for (const code of codes) symlinkSync(resolve(ROOT, `test/data/languages/${code}`), join(packs, `languages/${code}`));
  for (const variant of variants) writeVariantPack(join(packs, `languages/${variant.code}`), variant);
  const output = join(directory, "vendor/languages");
  rmSync(output, { recursive: true, force: true });
  for (const [path, text] of await languageFiles({ hoshidicts: packs, commit: `chrome-languages-${name}` })) {
    mkdirSync(dirname(join(output, path)), { recursive: true });
    writeFileSync(join(output, path), text);
  }
  return directory;
}

/**
 * The released Chrome build, unpacked under `scratch`: a local copy
 * (HACHIDORI_BACKUP_RELEASE_ZIP), the cache, or GitHub, checked against the
 * pinned SHA-256.
 */
export async function releasedExtension(scratch) {
  const local = process.env.HACHIDORI_BACKUP_RELEASE_ZIP;
  let zip;
  if (local) zip = readFileSync(local);
  else {
    const cached = resolve(CACHE, "hachidori-backup-release", RELEASE_ASSET);
    if (!existsSync(cached)) {
      const url = `https://github.com/bee-san/hachidori/releases/download/${RELEASE_VERSION}/${RELEASE_ASSET}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
    }
    zip = readFileSync(cached);
  }
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== RELEASE_SHA256) throw new Error(`${RELEASE_ASSET} has SHA-256 ${actual}, not the pinned ${RELEASE_SHA256}`);
  const directory = join(scratch, `hachidori-${RELEASE_VERSION}`);
  if (existsSync(directory)) return directory;
  const reader = new ZipReader(new BlobReader(new Blob([zip])), { useWebWorkers: false });
  try {
    for (const entry of await reader.getEntries()) {
      const path = join(directory, entry.filename);
      mkdirSync(entry.directory ? path : dirname(path), { recursive: true });
      if (!entry.directory) writeFileSync(path, await entry.getData(new Uint8ArrayWriter()));
    }
  } finally {
    await reader.close();
  }
  return directory;
}

export const RELEASE = { version: RELEASE_VERSION };

/**
 * One Chrome with one extension. `page(path)` opens an extension page;
 * `message` sends a runtime message from the first page it opened and
 * `storage` reads chrome.storage.local in the service worker. `ready()`
 * waits for an idle engine.
 */
export async function launchExtension(puppeteer, { chrome, scratch, name, extension, errors = [] }) {
  const browser = await puppeteer.launch({ executablePath: chrome, enableExtensions: true, userDataDir: join(scratch, `${name}-profile`),
    headless: true, protocolTimeout: 120_000,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--disable-gpu",
      "--disable-dev-shm-usage", ...(process.env.HACHIDORI_ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])] });
  const workerTarget = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().endsWith("/background.js"), { timeout: 30_000 });
  const id = new URL(workerTarget.url()).host;
  const worker = await workerTarget.worker();
  let messenger = null;
  let counter = 0;
  const installation = {
    browser, id, worker, name,
    async page(path) {
      const page = await browser.newPage();
      page.on("pageerror", error => errors.push(`[${name} ${path}] ${error.message}`));
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`chrome-extension://${id}/${path}`, { waitUntil: "load" });
      messenger ??= page;
      return page;
    },
    message: fields => messenger.evaluate(value => chrome.runtime.sendMessage(value),
      { requestId: `${name}-${++counter}`, ...fields }),
    storage: keys => worker.evaluate(wanted => chrome.storage.local.get(wanted), keys),
    async ready() {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const status = await installation.message({ target: "hoshidicts-offscreen", type: "hd_status" });
        if (status?.ok && status.ready && !status.loading) return status;
        if (Date.now() > deadline) throw new Error(`${name}'s engine did not become idle: ${JSON.stringify(status)}`);
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
    },
    // An archive imported from bytes, as Settings' import does with a chosen file.
    async importArchive(bytes, fileName, profileId) {
      const page = await installation.page("settings.html#add-dictionaries");
      const reply = await page.evaluate(async ({ base64, file, profile, requestId }) => {
        const data = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
        try {
          return await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId,
            blobUrl, fileName: file, ...(profile === null ? {} : { profileId: profile }) });
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }, { base64: Buffer.from(bytes).toString("base64"), file: fileName, profile: profileId ?? null, requestId: `${name}-${++counter}` });
      await page.close();
      if (reply?.ok !== true) throw new Error(`${name} could not import ${fileName}: ${JSON.stringify(reply)}`);
      return reply;
    },
  };
  await installation.page("settings.html#backup");
  // A fresh profile migrates its dictionary state first, under the engine's lock.
  await installation.ready();
  return installation;
}
