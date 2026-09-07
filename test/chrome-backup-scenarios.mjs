import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openBackupArchive } from "../extension/backup-archive.js";

export const BACKUP_CHROME_CHECKS = [
  "Settings exports a complete ZIP through Chrome downloads and releases its engine-owned URL",
  "backup preview preserves the working generation and refuses a concurrent Settings edit",
  "confirmed restore atomically replaces browser generations and retains the complete saved state",
  "corrupt backup preparation preserves the working browser state and leaves no fresh generations",
  "closing Settings during backup preparation cancels staged generations without waiting for its reply",
];

export async function backupChromeScenarios({ browser, page, directory, check = (name, ok, detail) => assert.ok(ok, `${name}: ${detail}`) }) {
  mkdirSync(directory, { recursive: true });
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
  const read = () => page.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_backup_read" });
    if (!reply.ok) throw new Error(reply.error);
    return reply.snapshot;
  });
  const status = () => page.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" }));
  const roots = async () => page.evaluate(async backend => {
    if (backend === "opfs") {
      const names = [];
      for await (const name of (await navigator.storage.getDirectory()).keys()) {
        if (name.startsWith(".hdw-generation-")) names.push(name);
      }
      return names.sort();
    }
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open("/dicts");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction("FILE_DATA", "readonly");
        const keys = transaction.objectStore("FILE_DATA").getAllKeys();
        keys.onerror = () => reject(keys.error);
        keys.onsuccess = () => resolve([...new Set(keys.result.map(path => String(path).split("/")[2])
          .filter(name => name?.startsWith(".hdw-generation-")))].sort());
        transaction.oncomplete = () => database.close();
      };
    });
  }, (await status()).storageBackend);
  const choose = async path => {
    await (await page.$("#backup-file")).uploadFile(path);
    await page.waitForFunction(() => !document.getElementById("backup-preview").hidden
      || document.getElementById("backup-status").classList.contains("is-error"), { timeout: 120_000 });
  };
  const confirm = async () => {
    await page.click("#backup-confirm");
    await page.click("#backup-restore");
    await page.waitForFunction(() => !document.getElementById("backup-export").disabled, { timeout: 120_000 });
  };
  await page.click('.settings-nav a[href="#backup"]');
  await page.waitForSelector("#backup-export", { visible: true });
  const before = await read();
  await page.click("#backup-export");
  await page.waitForFunction(() => {
    const status = document.getElementById("backup-status");
    return /Download started|cancelled/u.test(status.textContent) || status.classList.contains("is-error");
  }, { timeout: 120_000 });
  assert.match(await page.$eval("#backup-status", element => element.textContent), /Download started/u);
  const downloaded = await page.waitForFunction(async () => {
    const [entry] = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 });
    const tracked = (await chrome.storage.session.get("backupDownloads")).backupDownloads ?? {};
    return entry?.state === "complete" && Object.keys(tracked).length === 0 ? entry : false;
  }, { timeout: 30_000 }).then(handle => handle.jsonValue());
  const bytes = readFileSync(downloaded.filename);
  const parsed = await openBackupArchive(new Blob([bytes]));
  check(BACKUP_CHROME_CHECKS[0], JSON.stringify(parsed.snapshot) === JSON.stringify(before)
    && parsed.files.some(file => file.path.endsWith("/media.bin")), JSON.stringify({ size: bytes.length, files: parsed.files.length }));

  const generation = (await status()).generation;
  await choose(downloaded.filename);
  assert.equal(await page.$eval("#backup-preview", element => element.hidden), false);
  assert.equal(await page.$eval("#backup-restore", element => element.disabled), true);
  assert.equal((await status()).generation, generation);
  assert.deepEqual(await read(), before);
  await page.evaluate(async () => {
    const { options = { revision: 0 } } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { scanLength: options.scanLength === 17 ? 18 : 17 } });
    if (!reply.ok) throw new Error(reply.error);
  });
  const edited = await read();
  await confirm();
  const refusal = await page.$eval("#backup-status", element => element.textContent);
  check(BACKUP_CHROME_CHECKS[1], /changed since/u.test(refusal) && JSON.stringify(await read()) === JSON.stringify(edited), refusal);

  await choose(downloaded.filename);
  assert.equal(await page.$eval("#backup-preview", element => element.hidden), false);
  if (process.env.HACHIDORI_BACKUP_SCREENSHOT) {
    await page.setViewport({ width: 1200, height: 900 });
    await page.screenshot({ path: process.env.HACHIDORI_BACKUP_SCREENSHOT, fullPage: true });
  }
  await confirm();
  const restored = await read();
  const notice = await page.$eval("#backup-status", element => element.textContent);
  const revisions = Object.keys(restored).every(key => restored[key].revision === edited[key].revision + 1);
  const comparable = snapshot => Object.fromEntries(Object.entries(snapshot).map(([key, value]) => {
    const { revision, ...rest } = value;
    if (key === "state") rest.dictionaries = rest.dictionaries.map(({ path, ...dictionary }) => dictionary);
    return [key, rest];
  }));
  const paths = restored.state.dictionaries.every((entry, index) => entry.path !== before.state.dictionaries[index].path);
  const lookup = await page.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "食べたかった" }));
  check(BACKUP_CHROME_CHECKS[2], /Restored successfully/u.test(notice) && revisions && paths
    && JSON.stringify(comparable(restored)) === JSON.stringify(comparable(before))
    && lookup.ok && lookup.results.length > 0, JSON.stringify({ notice, revisions, paths, lookupOk: lookup.ok }));

  // Flip a payload byte without changing the ZIP checksum or manifest.
  const corrupt = Buffer.from(bytes);
  const signature = Buffer.from("{\"format\":\"hachidori-backup\"");
  const offset = corrupt.indexOf(signature);
  assert.ok(offset >= 0);
  corrupt[offset + 2] ^= 1;
  const corruptPath = resolve(directory, "corrupt-backup.zip");
  writeFileSync(corruptPath, corrupt);
  const stableGeneration = (await status()).generation;
  const stableRoots = await roots();
  await choose(corruptPath);
  const failure = await page.$eval("#backup-status", element => element.textContent);
  const native = await page.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "食べたかった" }));
  check(BACKUP_CHROME_CHECKS[3], /signature|CRC/iu.test(failure)
    && JSON.stringify(await read()) === JSON.stringify(restored)
    && (await status()).generation === stableGeneration && native.ok && native.results.length > 0
    && JSON.stringify(await roots()) === JSON.stringify(stableRoots), failure);

  const leaving = await browser.newPage();
  const workerTarget = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith(`chrome-extension://${new URL(page.url()).host}/`));
  const worker = await workerTarget.worker();
  try {
    await leaving.goto(page.url());
    await leaving.waitForFunction(() => document.getElementById("engine-status")?.textContent.includes("Ready")
      && !document.getElementById("backup-export").disabled);
    await worker.evaluate(() => {
      const original = chrome.storage.local.get.bind(chrome.storage.local);
      let reached;
      globalThis.backupStagingReached = new Promise(resolve => { reached = resolve; });
      globalThis.releaseBackupStaging = () => { chrome.storage.local.get = original; };
      chrome.storage.local.get = query => {
        if (Array.isArray(query) && query.length === 3 && query.includes("dictionaryState") && query.includes("dictionaries")) {
          chrome.storage.local.get = original;
          reached();
          return new Promise(resolve => {
            globalThis.releaseBackupStaging = async () => resolve(await original(query));
          });
        }
        return original(query);
      };
    });
    await (await leaving.$("#backup-file")).uploadFile(downloaded.filename);
    // Preparation has written/validated fresh files and is restoring the live
    // loaded set, but Settings does not yet know the engine's reply.
    await worker.evaluate(() => globalThis.backupStagingReached);
    leaving.on("dialog", dialog => dialog.accept());
    const closed = new Promise(resolve => leaving.once("close", resolve));
    await leaving.close({ runBeforeUnload: true });
    await closed;
    await worker.evaluate(() => globalThis.releaseBackupStaging());
    await page.waitForFunction(async () => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return reply.ok && reply.ready && !reply.loading;
    }, { timeout: 120_000 }).catch(async error => {
      throw new Error(`${error.message}; backup cleanup status: ${JSON.stringify(await status())}`, { cause: error });
    });
    const cleanupDeadline = Date.now() + 10_000;
    let closingRoots = await roots();
    while (JSON.stringify(closingRoots) !== JSON.stringify(stableRoots) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      closingRoots = await roots();
    }
    check(BACKUP_CHROME_CHECKS[4], JSON.stringify(closingRoots) === JSON.stringify(stableRoots)
      && JSON.stringify(await read()) === JSON.stringify(restored) && (await status()).generation === stableGeneration);
  } finally {
    await worker.evaluate(() => {
      globalThis.releaseBackupStaging?.();
      delete globalThis.releaseBackupStaging;
      delete globalThis.backupStagingReached;
    });
    if (!leaving.isClosed()) await leaving.close();
  }
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  await cdp.detach();
  return restored;
}
