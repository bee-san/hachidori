/*
 * Low memory mode, the RAM default and entry and hash storage.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./restart.mjs";
import { describe } from "node:test";
import { buildTitledZip } from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import { opfsPath, page, showSettingsSection } from "./session.mjs";

// File sizes of one dictionary directory, read from OPFS by the page. A File
// snapshot takes no lock, so this works while the engine holds the files open.
async function opfsFileSizes(page, dictionaryPath) {
  return page.evaluate(async (relative) => {
    let directory = await navigator.storage.getDirectory();
    for (const name of relative.split("/")) directory = await directory.getDirectoryHandle(name);
    const sizes = {};
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "file") sizes[name] = (await handle.getFile()).size;
    }
    return sizes;
  }, opfsPath(dictionaryPath));
}

// Values that more than one step uses; the step that creates each one assigns it.
let lowMemoryTitle, engineRequest, waitForRecycle, lowMemoryHeapBeforeImport, lowMemoryImported,
  recycledAfterImport, afterRecycle, lowMemorySizes, indexBytes, fullPoolStatus, fullPoolOptions,
  fullPoolLookup, fullPoolMemory;

describe("memory", () => {
  step("low memory mode recycles the worker", async () => {
    // ---- Low memory mode (docs/memory.md). The option replaces the engine worker
    // once it has been idle, so the import high-water mark that linear memory
    // never gives back is reclaimed; a recycled worker publishes generations from
    // zero again, which is how a restart shows up here. The low-memory worker is
    // the only place the strict two-thread pool is exercised in a browser.
    lowMemoryTitle = "low-memory-fixture";
    engineRequest = (type, fields = {}) => page.evaluate((type, fields) => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type, requestId: `e2e-low-memory-${type}`, ...fields,
    }), type, fields);
    // A recycled worker reports the mode it was created with, and publishes its
    // generations from zero again.
    waitForRecycle = (lowMemory, generation) => page.waitForFunction(async (expected, previous) => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return status?.ok && status.ready && !status.loading && status.lowMemory === expected
        && (previous === null || status.generation < previous) ? status : false;
    }, { timeout: 30_000, polling: 250 }, lowMemory, generation).then((handle) => handle.jsonValue());
    await showSettingsSection(page, "advanced");
    // The extension total arrives on its own once the browser has measured the
    // offscreen document and its workers; the engine heap is counted once, not
    // once per engine thread as the raw measurement reports it.
    const extensionTotal = await page.waitForFunction(async () => {
      const text = document.getElementById("memory-extension-total").textContent;
      if (!/^Extension total: [\d.]+ (KB|MB|GB) \([\d.]+ (KB|MB|GB) outside the engine heap\)$/u.test(text)) return false;
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_memory_total", requestId: "e2e-memory-total" });
      return { text, reply };
    }, { timeout: 90_000, polling: 250 }).then((handle) => handle.jsonValue()).catch(() => null);
    const lowMemoryBefore = await page.evaluate(async () => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status", requestId: "e2e-lm-status" });
      const memory = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_memory", requestId: "e2e-lm-memory" });
      await new Promise((done) => setTimeout(done, 50));
      const total = document.getElementById("memory-total").textContent;
      const available = !document.getElementById("low-memory-mode").hidden;
      const toggle = document.getElementById("opt-low-memory-mode");
      const wasChecked = toggle.checked;
      toggle.click();
      return { status, memory, total, available, wasChecked };
    });
    const lowMemoryStatus = await waitForRecycle(true, null).catch(() => null);
    lowMemoryHeapBeforeImport = lowMemoryStatus === null ? null : (await engineRequest("hd_memory")).heapBytes;
    const lowMemoryOptions = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
    check(
      "low memory mode recycles the engine worker and reports memory in Settings",
      lowMemoryBefore.available && !lowMemoryBefore.wasChecked
        && lowMemoryBefore.status.lowMemory === false
        && lowMemoryBefore.memory.ok === true && Number.isInteger(lowMemoryBefore.memory.heapBytes)
        && lowMemoryBefore.memory.dictionaries.length === 0
        && /^Engine memory: [\d.]+ (KB|MB|GB) across 0 dictionaries$/u.test(lowMemoryBefore.total)
        && extensionTotal?.reply.ok === true && Number.isFinite(extensionTotal.reply.bytes)
        && extensionTotal.reply.heapBytes === lowMemoryBefore.memory.heapBytes
        && extensionTotal.reply.bytes >= extensionTotal.reply.heapBytes
        && lowMemoryBefore.status.pagedDictionaries === true
        && lowMemoryBefore.status.dictionaryEntryStorage === "auto"
        && lowMemoryOptions?.lowMemoryMode === true
        && lowMemoryStatus?.threaded === true && lowMemoryStatus.storageBackend === "opfs"
        && lowMemoryStatus.pagedDictionaries === true,
      JSON.stringify({ before: lowMemoryBefore, extensionTotal, after: lowMemoryStatus, lowMemoryMode: lowMemoryOptions?.lowMemoryMode }),
    );
  });

  step("low memory mode imports", async () => {
    await showSettingsSection(page, "add-dictionaries");
    await page.evaluate((base64, name) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: "application/zip" }));
      const input = document.getElementById("import-file");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, buildTitledZip(lowMemoryTitle).toString("base64"), `${lowMemoryTitle}.zip`);
    lowMemoryImported = await page.waitForFunction(async (title) => {
      const { dictionaryState } = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      const dictionary = dictionaryState?.dictionaries?.find((entry) => entry.title === title);
      if (!dictionary || !status?.ok || !status.ready || status.loading) return false;
      const memory = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_memory" });
      return { dictionary, status, memory };
    }, { timeout: 90_000, polling: 100 }, lowMemoryTitle).then((handle) => handle.jsonValue()).catch(() => null);
    recycledAfterImport = lowMemoryImported
      ? await waitForRecycle(true, lowMemoryImported.status.generation).catch(() => null) : null;
    afterRecycle = null;
    if (recycledAfterImport) {
      afterRecycle = await page.evaluate(async () => ({
        memory: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_memory", requestId: "e2e-lm-memory-2" }),
        lookup: await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "e2e-lm-lookup", text: "食べる" }),
      }));
      // Opening a row's Details asks for its In memory line; showing Advanced asks for the total.
      await showSettingsSection(page, "dictionaries");
      await page.evaluate((title) => {
        const row = [...document.querySelectorAll(".dict-row")].find((entry) => entry.querySelector(".dict-title").textContent === title);
        row.querySelector(".dict-details-toggle").click();
      }, lowMemoryTitle);
      afterRecycle.rowMemory = await page.waitForFunction((title) => {
        const row = [...document.querySelectorAll(".dict-row")].find((entry) => entry.querySelector(".dict-title").textContent === title);
        const text = row?.querySelector(".dict-memory")?.textContent ?? "";
        return text.includes("\u2248") ? text : false;
      }, { timeout: 10_000, polling: 100 }, lowMemoryTitle).then((handle) => handle.jsonValue()).catch(() => null);
      await showSettingsSection(page, "advanced");
      afterRecycle.total = await page.waitForFunction(() => {
        const text = document.getElementById("memory-total").textContent;
        return /across 1 dictionary$/u.test(text) ? text : false;
      }, { timeout: 10_000, polling: 100 }).then((handle) => handle.jsonValue()).catch(() => null);
    }
    check(
      "low memory mode imports single-threaded and recycles the import high-water mark",
      lowMemoryImported?.memory.ok === true
        && lowMemoryImported.memory.dictionaries.length === 1
        && lowMemoryImported.memory.dictionaries[0].id === lowMemoryImported.dictionary.id
        && lowMemoryImported.memory.dictionaries[0].bytes > 0
        && recycledAfterImport?.threaded === true && recycledAfterImport.dictionaryCount === 1
        && afterRecycle?.memory.ok === true
        // The import ran in the terminated import worker: the engine's heap did
        // not take the import's high-water mark (an in-engine import grows it by
        // well over 16 MiB), and the recycle has nothing of it left to give back.
        && lowMemoryImported.memory.heapBytes < lowMemoryHeapBeforeImport + 16 * 1024 * 1024
        && afterRecycle.memory.heapBytes <= lowMemoryImported.memory.heapBytes
        && afterRecycle.memory.dictionaries[0]?.bytes === lowMemoryImported.memory.dictionaries[0].bytes
        && afterRecycle.lookup.ok === true && afterRecycle.lookup.results[0]?.term.expression === "食べる"
        && /^In memory: \u2248 [\d.]+ (KB|MB|GB) \(entries read from disk\)$/u.test(afterRecycle.rowMemory ?? "")
        && /across 1 dictionary$/u.test(afterRecycle.total ?? ""),
      JSON.stringify({ heapBeforeImport: lowMemoryHeapBeforeImport, imported: lowMemoryImported, recycled: recycledAfterImport, afterRecycle }),
    );
  });

  step("low memory mode heap", async () => {
    // The heap holds the index files once; entries (blobs.bin) are read from
    // OPFS as lookups need them and kept in the bounded page cache.
    lowMemorySizes = lowMemoryImported
      ? await opfsFileSizes(page, lowMemoryImported.dictionary.path).catch(() => null) : null;
    indexBytes = lowMemorySizes === null ? null
      : ["hash.table", "bloom.filter", "media.idx", "scan.idx", "dict.zstd"]
        .reduce((sum, name) => sum + (lowMemorySizes[name] ?? 0), 0);
    check(
      "low memory mode keeps only each dictionary's index in the heap",
      recycledAfterImport?.pagedDictionaries === true
        && indexBytes > 0 && lowMemorySizes["blobs.bin"] > 0
        && afterRecycle?.memory.dictionaries[0]?.paged === true
        && afterRecycle.memory.dictionaries[0].bytes === indexBytes
        && afterRecycle.memory.pageCacheBytes > 0
        && afterRecycle.memory.pageCacheBytes <= 32 * 1024 * 1024,
      JSON.stringify({ sizes: lowMemorySizes, indexBytes, memory: afterRecycle?.memory, status: recycledAfterImport }),
    );
  });

  step("turning low memory mode off", async () => {
    await page.evaluate(() => document.getElementById("opt-low-memory-mode").click());
    fullPoolStatus = recycledAfterImport ? await waitForRecycle(false, null).catch(() => null) : null;
    fullPoolOptions = await page.evaluate(async () => (await chrome.storage.local.get("options")).options);
    fullPoolLookup = await engineRequest("hd_lookup", { text: "食べる" });
    fullPoolMemory = await engineRequest("hd_memory");
    check(
      "turning low memory mode off restarts the full-pool worker",
      fullPoolOptions?.lowMemoryMode === false
        && fullPoolStatus?.threaded === true && fullPoolStatus.dictionaryCount === 1
        && fullPoolStatus.pagedDictionaries === true
        && fullPoolLookup.ok === true && fullPoolLookup.results[0]?.term.expression === "食べる"
        && fullPoolMemory.dictionaries[0]?.paged === true
        && fullPoolMemory.dictionaries[0].bytes === indexBytes,
      JSON.stringify({ status: fullPoolStatus, lookup: fullPoolLookup, memory: fullPoolMemory, lowMemoryMode: fullPoolOptions?.lowMemoryMode }),
    );
  });

  step("Use less ram by default", async () => {
    check("Use less ram by default applies a 65 MiB hash budget with the full import pool",
      fullPoolStatus?.lowMemory === false && fullPoolStatus.useLessRamByDefault === true
        && fullPoolStatus.hashIndexStorage === "budget" && fullPoolStatus.residentHashBudgetBytes === 65 * 1024 * 1024
        && fullPoolMemory.residentHashBudgetBytes === fullPoolStatus.residentHashBudgetBytes
        && fullPoolOptions.useLessRamByDefault === true
        && await page.$eval("#opt-use-less-ram-by-default", input => input.checked && !input.disabled),
      JSON.stringify({ status: fullPoolStatus, memory: fullPoolMemory }));
    const waitForRamDefault = expected => page.waitForFunction(async expected => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return status?.ok && status.ready && !status.loading && status.useLessRamByDefault === expected ? status : false;
    }, { timeout: 30_000, polling: 250 }, expected).then(handle => handle.jsonValue());
    await page.evaluate(() => document.getElementById("opt-use-less-ram-by-default").click());
    const fullRamStatus = await waitForRamDefault(false);
    const fullRamLookup = await engineRequest("hd_lookup", { text: "食べる" });
    await page.evaluate(() => document.getElementById("opt-use-less-ram-by-default").click());
    const lessRamStatus = await waitForRamDefault(true);
    const lessRamLookup = await engineRequest("hd_lookup", { text: "食べる" });
    await page.reload();
    await page.waitForFunction(() => document.getElementById("opt-use-less-ram-by-default").checked);
    check("changing the RAM default restarts the idle engine and preserves lookups and entry storage",
      fullRamStatus.lowMemory === false && fullRamStatus.hashIndexStorage === "resident"
        && fullRamStatus.residentHashBudgetBytes === null && fullRamStatus.pagedDictionaries === true
        && lessRamStatus.lowMemory === false && lessRamStatus.hashIndexStorage === "budget"
        && lessRamStatus.residentHashBudgetBytes === 65 * 1024 * 1024 && lessRamStatus.pagedDictionaries === true
        && JSON.stringify(fullRamLookup.results) === JSON.stringify(fullPoolLookup.results)
        && JSON.stringify(lessRamLookup.results) === JSON.stringify(fullPoolLookup.results),
      JSON.stringify({ fullRamStatus, lessRamStatus }));
  });

  step("entry and hash storage", async () => {
    await page.select("#opt-dictionary-entry-storage", "resident");
    const residentStatus = await page.waitForFunction(async () => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return status?.ok && status.ready && !status.loading && status.dictionaryEntryStorage === "resident" ? status : false;
    }, { timeout: 30_000, polling: 250 }).then(handle => handle.jsonValue()).catch(() => null);
    const residentLookup = await engineRequest("hd_lookup", { text: "食べる" });
    const residentMemory = await engineRequest("hd_memory");
    check(
      "resident entry storage restores mapped entries independently of low memory mode",
      residentStatus?.lowMemory === false && residentStatus.pagedDictionaries === false
        && residentMemory.dictionaries[0]?.paged === false && residentMemory.pageCacheBytes === 0
        && residentMemory.dictionaries[0].bytes === indexBytes + lowMemorySizes["blobs.bin"]
        && residentLookup.ok === true && JSON.stringify(residentLookup.results) === JSON.stringify(fullPoolLookup.results),
      JSON.stringify({ status: residentStatus, memory: residentMemory, lookup: residentLookup }),
    );
    await page.select("#opt-dictionary-index-storage", "paged");
    const pagedHashStatus = await page.waitForFunction(async () => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return status?.ready && !status.loading && status.dictionaryIndexStorage === "paged" ? status : false;
    }, { timeout: 30_000, polling: 250 }).then(handle => handle.jsonValue());
    const pagedHashLookup = await engineRequest("hd_lookup", { text: "食べる" });
    const pagedHashMemory = await engineRequest("hd_memory");
    check("paged hash storage uses the shared cache independently of entry residency",
      pagedHashStatus.hashIndexStorage === "paged" && pagedHashStatus.packageCount === 1
        && pagedHashStatus.registeredKindCount === 1
        && pagedHashMemory.dictionaries[0].paged === false
        && pagedHashMemory.dictionaries[0].hashIndexStorage === "paged"
        && pagedHashMemory.dictionaries[0].residentHashBytes === 0
        && pagedHashMemory.indexes.bytes > 0 && pagedHashMemory.entries.bytes === 0
        && pagedHashMemory.pageCacheBytes === pagedHashMemory.indexes.bytes
        && JSON.stringify(pagedHashLookup.results) === JSON.stringify(residentLookup.results),
      JSON.stringify({ status: pagedHashStatus, memory: pagedHashMemory }));
    await page.select("#opt-dictionary-index-storage", "resident");
    await page.waitForFunction(async () => {
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return status?.ready && !status.loading && status.dictionaryIndexStorage === "resident";
    }, { timeout: 30_000, polling: 250 });
    const residentHashMemory = await engineRequest("hd_memory");
    check("resident hash storage returns after an idle policy restart",
      residentHashMemory.dictionaries[0].residentHashBytes === residentHashMemory.dictionaries[0].hashBytes
        && residentHashMemory.dictionaries[0].hashIndexStorage === "resident"
        && residentHashMemory.pageCacheBytes === 0,
      JSON.stringify({ before: residentMemory, after: residentHashMemory }));
    await engineRequest("hd_remove", { title: lowMemoryTitle });
    await page.waitForFunction(async () => {
      const stored = await chrome.storage.local.get("dictionaryState");
      const status = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_status" });
      return (stored.dictionaryState?.dictionaries ?? []).length === 0 && status?.ok && status.ready && !status.loading;
    }, { timeout: 90_000, polling: 250 });
  });
});
