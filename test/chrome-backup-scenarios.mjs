import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openBackupArchive } from "../extension/backup-archive.js";

export const BACKUP_CHROME_CHECKS = [
  "automatic backup list shows two actual relative ages and requires explicit restore confirmation",
  "a corrupt newest automatic backup leaves the valid older browser snapshot restorable in place",
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
  const readPayload = () => page.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_backup_read" });
    if (!reply.ok) throw new Error(reply.error);
    return { snapshot: reply.snapshot, lookupStatsRows: reply.lookupStatsRows };
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
  const waitForBackupSettings = async () => {
    await page.waitForFunction(() => document.getElementById("engine-status")?.textContent.includes("Ready")
      && !document.getElementById("backup-export").disabled, { timeout: 120_000 });
  };

  const automaticPayload = await readPayload();
  const automaticNow = Date.now();
  const automaticStore = {
    schemaVersion: 1,
    backups: [
      {
        id: "browser-recent",
        createdAt: new Date(automaticNow - 3 * 60 * 60_000).toISOString(),
        snapshot: structuredClone(automaticPayload.snapshot),
        lookupStatsRows: structuredClone(automaticPayload.lookupStatsRows),
      },
      {
        id: "browser-older",
        createdAt: new Date(automaticNow - 24 * 60 * 60_000).toISOString(),
        snapshot: structuredClone(automaticPayload.snapshot),
        lookupStatsRows: structuredClone(automaticPayload.lookupStatsRows),
      },
    ],
  };
  await page.evaluate(store => chrome.storage.local.set({ automaticBackups: store }), automaticStore);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForBackupSettings();
  await page.evaluate(() => { location.hash = "#backup"; });
  await page.waitForSelector("#backup-export", { visible: true });
  await page.waitForFunction(() => document.querySelectorAll("#automatic-backup-list .automatic-backup-row").length === 2);
  const automaticRows = await page.$$eval("#automatic-backup-list .automatic-backup-row", rows => rows.map(row => ({
    age: row.querySelector(".automatic-backup-age").textContent,
    action: row.querySelector(".automatic-backup-restore").textContent,
    createdAt: row.querySelector(".automatic-backup-created").dateTime,
  })));
  if (process.env.HACHIDORI_AUTOMATIC_BACKUP_SCREENSHOT) {
    await page.setViewport({ width: 1200, height: 900 });
    await page.screenshot({ path: process.env.HACHIDORI_AUTOMATIC_BACKUP_SCREENSHOT, fullPage: true });
  }

  const backend = (await status()).storageBackend;
  const rawAutomaticStats = await page.evaluate(async ({ backend, roots: retainedRoots }) => {
    if (backend === "opfs") {
      const root = await navigator.storage.getDirectory();
      async function walk(directory) {
        let bytes = 0;
        let files = 0;
        for await (const [, handle] of directory.entries()) {
          if (handle.kind === "directory") {
            const nested = await walk(handle);
            bytes += nested.bytes;
            files += nested.files;
          } else {
            bytes += (await handle.getFile()).size;
            files += 1;
          }
        }
        return { bytes, files };
      }
      let bytes = 0;
      let files = 0;
      for (const name of retainedRoots) {
        const stats = await walk(await root.getDirectoryHandle(name));
        bytes += stats.bytes;
        files += stats.files;
      }
      return { bytes, files };
    }
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open("/dicts");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction("FILE_DATA", "readonly");
        const store = transaction.objectStore("FILE_DATA");
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          let bytes = 0;
          let files = 0;
          for (const [index, key] of keysRequest.result.entries()) {
            if (!retainedRoots.some(root => String(key).startsWith(`/dicts/${root}/`))) continue;
            const contents = valuesRequest.result[index]?.contents;
            if (contents === undefined || contents === null) continue;
            bytes += Number(contents.byteLength ?? contents.length) || 0;
            files += 1;
          }
          database.close();
          resolve({ bytes, files });
        };
      };
    });
  }, {
    backend,
    roots: [...new Set(automaticPayload.snapshot.state.dictionaries.map(dictionary =>
      dictionary.path.split("/")[2]))],
  });
  if (process.env.HACHIDORI_AUTOMATIC_BACKUP_BROWSER_BENCHMARK) {
    const uniqueRoots = new Set(automaticPayload.snapshot.state.dictionaries.map(dictionary =>
      dictionary.path.split("/")[2]));
    writeFileSync(process.env.HACHIDORI_AUTOMATIC_BACKUP_BROWSER_BENCHMARK, `${JSON.stringify({
      backend,
      fixture: automaticPayload.snapshot.state.dictionaries.map(dictionary => ({
        title: dictionary.title,
        revision: dictionary.revision,
        path: dictionary.path,
      })),
      records: automaticStore.backups.length,
      metadataBytes: Buffer.byteLength(JSON.stringify(automaticStore)),
      snapshotRootReferences: uniqueRoots.size * automaticStore.backups.length,
      uniqueRetainedRoots: uniqueRoots.size,
      rawRetainedFiles: rawAutomaticStats.files,
      rawRetainedBytes: rawAutomaticStats.bytes,
      rawBytesIfRootsWereCopiedPerSnapshot: rawAutomaticStats.bytes * automaticStore.backups.length,
      rawBytesAvoidedBySharing: rawAutomaticStats.bytes * (automaticStore.backups.length - 1),
    }, null, 2)}\n`);
  }

  const corruptAutomatic = structuredClone(automaticStore);
  corruptAutomatic.backups[0].snapshot.state.schemaVersion = 99;
  assert.equal(corruptAutomatic.backups[1].snapshot.state.schemaVersion, 1);
  await page.evaluate(store => chrome.storage.local.set({ automaticBackups: store }), corruptAutomatic);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForBackupSettings();
  await page.evaluate(() => { location.hash = "#backup"; });
  await page.waitForFunction(() => document.querySelectorAll("#automatic-backup-list .automatic-backup-row").length === 1
    && /damaged.*valid older/iu.test(document.getElementById("automatic-backup-status").textContent));
  await page.click("#automatic-backup-list .automatic-backup-restore");
  await page.waitForFunction(() => !document.getElementById("backup-preview").hidden
    || document.getElementById("backup-status").classList.contains("is-error"), { timeout: 120_000 });
  const automaticConfirmation = {
    fileName: await page.$eval("#backup-file-name", element => element.textContent),
    restoreDisabled: await page.$eval("#backup-restore", element => element.disabled),
    status: await page.$eval("#automatic-backup-status", element => element.textContent),
  };
  check(BACKUP_CHROME_CHECKS[0],
    automaticRows.length === 2
      && /3 hours ago/u.test(automaticRows[0].age)
      && /Restore from 3 hours ago/u.test(automaticRows[0].action)
      && /1 day ago/u.test(automaticRows[1].age)
      && /Restore from 1 day ago/u.test(automaticRows[1].action)
      && automaticConfirmation.restoreDisabled
      && /Automatic backup from 1 day ago/u.test(automaticConfirmation.fileName),
    JSON.stringify({ automaticRows, automaticConfirmation }));

  const beforeAutomaticRestore = await read();
  const rootsBeforeAutomaticRestore = await roots();
  await confirm();
  const automaticRestored = await read();
  const automaticNotice = await page.$eval("#backup-status", element => element.textContent);
  const automaticRevisions = Object.keys(automaticRestored).every(key =>
    automaticRestored[key].revision === beforeAutomaticRestore[key].revision + 1);
  const automaticLookup = await page.evaluate(() =>
    chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "食べたかった" }));
  check(BACKUP_CHROME_CHECKS[1],
    /Restored successfully/u.test(automaticNotice)
      && /damaged.*valid older/iu.test(automaticConfirmation.status)
      && automaticRevisions
      && JSON.stringify(automaticRestored.state.dictionaries.map(dictionary => dictionary.path))
        === JSON.stringify(automaticPayload.snapshot.state.dictionaries.map(dictionary => dictionary.path))
      && JSON.stringify(await roots()) === JSON.stringify(rootsBeforeAutomaticRestore)
      && automaticLookup.ok && automaticLookup.results.length > 0,
    JSON.stringify({ automaticNotice, automaticRevisions, automaticLookup: automaticLookup.ok }));

  await page.evaluate(() => chrome.storage.local.set({
    automaticBackups: { schemaVersion: 1, backups: [] },
  }));
  await page.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_reload" });
    if (!reply.ok) throw new Error(reply.error);
  });
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
  check(BACKUP_CHROME_CHECKS[2], JSON.stringify(parsed.snapshot) === JSON.stringify(before)
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
  check(BACKUP_CHROME_CHECKS[3], /changed since/u.test(refusal) && JSON.stringify(await read()) === JSON.stringify(edited), refusal);

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
    if (key === "lookupStats") delete rest.generation;
    return [key, rest];
  }));
  const paths = restored.state.dictionaries.every((entry, index) => entry.path !== before.state.dictionaries[index].path);
  const lookup = await page.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", text: "食べたかった" }));
  check(BACKUP_CHROME_CHECKS[4], /Restored successfully/u.test(notice) && revisions && paths
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
  check(BACKUP_CHROME_CHECKS[5], /signature|CRC/iu.test(failure)
    && JSON.stringify(await read()) === JSON.stringify(restored)
    && (await status()).generation === stableGeneration && native.ok && native.results.length > 0
    && JSON.stringify(await roots()) === JSON.stringify(stableRoots), failure);

  const leaving = await browser.newPage();
  const workerTarget = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith(`chrome-extension://${new URL(page.url()).host}/`));
  const workerSession = await workerTarget.createCDPSession();
  await workerSession.send("Runtime.enable");
  const workerEvaluate = async pageFunction => {
    const { result, exceptionDetails } = await workerSession.send("Runtime.evaluate", {
      expression: `(${pageFunction.toString()})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails !== undefined) {
      throw new Error(exceptionDetails.exception?.description
        ?? exceptionDetails.text ?? "backup service-worker evaluation failed");
    }
    return result.value;
  };
  try {
    await leaving.goto(page.url());
    await leaving.waitForFunction(() => document.getElementById("engine-status")?.textContent.includes("Ready")
      && !document.getElementById("backup-export").disabled);
    await workerEvaluate(() => {
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
    await workerEvaluate(() => globalThis.backupStagingReached);
    leaving.on("dialog", dialog => dialog.accept());
    const closed = new Promise(resolve => leaving.once("close", resolve));
    await leaving.close({ runBeforeUnload: true });
    await closed;
    await workerEvaluate(() => globalThis.releaseBackupStaging());
    await page.waitForFunction(async () => {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return reply.ok && reply.ready && !reply.loading;
    }, { timeout: 120_000, polling: 100 }).catch(async error => {
      throw new Error(`${error.message}; backup cleanup status: ${JSON.stringify(await status())}`, { cause: error });
    });
    const cleanupDeadline = Date.now() + 10_000;
    let closingRoots = await roots();
    while (JSON.stringify(closingRoots) !== JSON.stringify(stableRoots) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      closingRoots = await roots();
    }
    const closingSnapshot = await read();
    const closingStatus = await status();
    check(BACKUP_CHROME_CHECKS[6], JSON.stringify(closingRoots) === JSON.stringify(stableRoots)
      && JSON.stringify(closingSnapshot) === JSON.stringify(restored) && closingStatus.generation === stableGeneration,
    JSON.stringify({
      stableRoots,
      closingRoots,
      snapshotMatches: JSON.stringify(closingSnapshot) === JSON.stringify(restored),
      stableGeneration,
      closingGeneration: closingStatus.generation,
    }));
  } finally {
    try {
      await workerEvaluate(() => {
        globalThis.releaseBackupStaging?.();
        delete globalThis.releaseBackupStaging;
        delete globalThis.backupStagingReached;
      });
    } finally {
      await workerSession.detach().catch(() => {});
    }
    if (!leaving.isClosed()) await leaving.close();
  }
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  await cdp.detach();
  return restored;
}
