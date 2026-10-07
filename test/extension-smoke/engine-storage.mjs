/*
 * Isolated imports, paged dictionaries and blob-backed IDBFS.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./engine-restart.mjs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { buildNotAZip, buildTitledZip } from "../make-fixture.mjs";
import { trainedExpression } from "./engine-restart.mjs";
import { createHoshidicts, idb, offscreenChrome, storedDictionaryState } from "./engine.mjs";
import { createObjectURL, EXTENSION, ownedGenerationRoot } from "./fakes.mjs";
import { check, section, step } from "./harness.mjs";

/* --------------------------------------------------- paged dictionaries stage */

// Dictionaries whose entries are read from disk on demand (docs/memory.md):
// Low memory mode's worker pages every package (engine-worker-runtime.js
// passes pagedDictionaries), and any worker retries a package that does not
// fit in the heap paged before it reports it. The heap limit is simulated at
// the ABI, where hdw_add_dict fails the way bindings.cpp reports a refused
// memory.grow.
async function pagedDictionariesStage({ createHoshidicts, offscreenChrome, storedDictionaryState, trainedExpression }) {
  section("paged dictionaries: Low memory mode, and a package that does not fit");
  const startService = async (tag, options = {}) => {
    const service = await import(
      `file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}?${tag}`
    );
    const engine = { adds: [], refuse: () => false, refusal: null };
    service.configureEngineService(
      (message) => offscreenChrome.runtime.sendMessage(message),
      {
        createHoshidicts: async (...args) => {
          const module = await createHoshidicts(...args);
          const ccall = module.ccall.bind(module);
          module.ccall = (name, returnType, argumentTypes, argumentValues) => {
            if (name === "hdw_last_error" && engine.refusal !== null) return engine.refusal;
            engine.refusal = null;
            if (name === "hdw_add_dict") {
              const [path, kind, paged] = argumentValues;
              engine.adds.push({ path, kind, paged });
              if (engine.refuse(path, paged)) {
                engine.refusal = `not enough memory to load term dictionary: ${path}`;
                return 0;
              }
            }
            return ccall(name, returnType, argumentTypes, argumentValues);
          };
          return module;
        },
        storageBackend: "idbfs",
        lowRam: true,
        ...options,
      },
    );
    let counter = 0;
    engine.request = (type, fields = {}) => {
      counter += 1;
      return service.handleEngineMessage({ type, requestId: `${tag}-${counter}`, ...fields });
    };
    service.startEngine();
    const deadline = Date.now() + 30000;
    let status = await engine.request("hd_status");
    while (!(status.ok && status.ready && !status.loading) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 25));
      status = await engine.request("hd_status");
    }
    engine.status = status;
    return engine;
  };
  const resultsOf = async (engine, text) => JSON.stringify((await engine.request("hd_lookup", { text })).results);

  const mapped = await startService("mapped-dictionaries");
  const paged = await startService("paged-dictionaries", { threaded: true, pagedDictionaries: true });
  const pagedMemory = await paged.request("hd_memory");
  const words = [trainedExpression, "食べたかった", "漢字", "ありがとう"];
  const parity = [];
  for (const word of words) parity.push([await resultsOf(mapped, word), await resultsOf(paged, word)]);
  const afterLookups = await paged.request("hd_memory");
  check(
    "Low memory mode's worker pages every package and answers as the mapped one does",
    paged.status.pagedDictionaries === true && paged.status.lowMemory === true
      && mapped.status.pagedDictionaries === false
      && paged.adds.length > 0 && paged.adds.every((add) => add.paged === 1)
      && mapped.adds.every((add) => add.paged === 0)
      && paged.status.dictionaryCount === mapped.status.dictionaryCount
      && pagedMemory.dictionaries.length > 0 && pagedMemory.dictionaries.every((row) => row.paged === true)
      && parity.every(([expected, actual]) => actual === expected)
      && parity.some(([expected]) => expected !== "[]")
      && afterLookups.pageCacheBytes > 0,
    JSON.stringify({ status: paged.status, pagedMemory, afterLookups: afterLookups.pageCacheBytes, parity }),
  );
  const mappedMemory = await mapped.request("hd_memory");
  check(
    "a paged package's share leaves out its entries",
    pagedMemory.dictionaries.every((row) => {
      const full = mappedMemory.dictionaries.find((entry) => entry.path === row.path);
      return full !== undefined && full.paged === false && row.bytes < full.bytes;
    }),
    JSON.stringify({ pagedMemory, mappedMemory }),
  );

  // A package that does not fit loads paged; the rest stay mapped.
  const title = "paged-fallback";
  const oversized = (path) => path.endsWith(`/${title}`);
  mapped.refuse = (path, pagedAdd) => oversized(path) && pagedAdd === 0;
  mapped.adds.length = 0;
  const imported = await mapped.request("hd_import", {
    blobUrl: createObjectURL(buildTitledZip(title, {
      terms: [["溢れる", "あふれる", "", "v1", 0, ["to overflow"], 1, ""]],
    })),
    fileName: `${title}.zip`,
  });
  const fallbackStatus = await mapped.request("hd_status");
  const fallbackMemory = await mapped.request("hd_memory");
  const fallbackLookup = await mapped.request("hd_lookup", { text: "溢れた" });
  const fallbackAdds = mapped.adds.filter((add) => oversized(add.path));
  check(
    "a package the heap cannot hold is retried with its entries read from disk",
    imported.ok === true && imported.report?.success === true
      && fallbackAdds.length === 2 && fallbackAdds[0].paged === 0 && fallbackAdds[1].paged === 1
      && fallbackStatus.failedDictionaries.length === 0
      && fallbackStatus.pagedDictionaries === false
      && fallbackMemory.dictionaries.find((row) => row.title === title)?.paged === true
      && fallbackMemory.dictionaries.filter((row) => row.title !== title).every((row) => row.paged === false)
      && fallbackLookup.results.some((result) => result.term?.expression === "溢れる"),
    JSON.stringify({ imported, fallbackAdds, fallbackStatus, fallbackMemory, fallbackLookup }),
  );

  // When not even the index fits, the package is reported and the rest load.
  mapped.refuse = oversized;
  mapped.adds.length = 0;
  const stored = await storedDictionaryState();
  const disabled = await mapped.request("hd_apply_state", {
    baseRevision: stored.revision,
    dictionaries: stored.dictionaries.map((entry) => (entry.title === title ? { ...entry, enabled: false } : entry)),
  });
  const reenabled = await mapped.request("hd_apply_state", {
    baseRevision: disabled.state.revision,
    dictionaries: stored.dictionaries,
  });
  const failedStatus = await mapped.request("hd_status");
  const failedPackage = stored.dictionaries.find((entry) => entry.title === title);
  check(
    "a package that fails paged too is reported with the memory error while the others load",
    disabled.ok === true && reenabled.ok === true
      && mapped.adds.filter((add) => oversized(add.path)).every((add) => add.paged === 1)
      && failedStatus.failedDictionaries.length === 1
      && failedStatus.failedDictionaries[0].id === failedPackage?.id
      && failedStatus.failedDictionaries[0].error.includes("not enough memory to load")
      && (await mapped.request("hd_lookup", { text: trainedExpression })).results.length > 0,
    JSON.stringify({ disabled, reenabled, failedStatus, adds: mapped.adds }),
  );

  mapped.refuse = () => false;
  const removed = await mapped.request("hd_remove", { id: failedPackage?.id, title });
  check(
    "the paged fallback package is removed cleanly",
    removed.ok === true
      && !(await storedDictionaryState()).dictionaries.some((entry) => entry.title === title)
      && (await mapped.request("hd_status")).failedDictionaries.length === 0,
    JSON.stringify(removed),
  );

  // A disabled package is validated with its entries read on demand, in both
  // the startup and the incremental load, and enabling it then uses the active
  // policy rather than the validation one.
  const quiet = "disabled-validation";
  const isQuiet = (path) => path.endsWith(`/${quiet}`);
  const quietZip = (gloss) => createObjectURL(buildTitledZip(quiet, {
    terms: [["静寂", "せいじゃく", "", "", 0, [gloss], 1, ""]],
  }));
  await mapped.request("hd_import", { blobUrl: quietZip("silence"), fileName: `${quiet}.zip` });
  const withQuiet = await storedDictionaryState();
  await mapped.request("hd_apply_state", {
    baseRevision: withQuiet.revision,
    dictionaries: withQuiet.dictionaries.map((entry) => (entry.title === quiet ? { ...entry, enabled: false } : entry)),
  });
  const restarted = await startService("disabled-validation-startup");
  const startupAdds = restarted.adds.filter((add) => isQuiet(add.path));
  const startupMemory = await restarted.request("hd_memory");
  const disabledState = await storedDictionaryState();
  restarted.adds.length = 0;
  const enabledQuiet = await restarted.request("hd_apply_state", {
    baseRevision: disabledState.revision,
    dictionaries: disabledState.dictionaries.map((entry) => (entry.title === quiet ? { ...entry, enabled: true } : entry)),
  });
  const enableAdds = restarted.adds.filter((add) => isQuiet(add.path));
  const enabledMemory = await restarted.request("hd_memory");
  const enabledLookup = await restarted.request("hd_lookup", { text: "静寂" });
  check(
    "startup validates a disabled package paged, drops it, and enabling it maps its entries",
    restarted.status.lastLoadPath === "full" && startupAdds.length > 0 && startupAdds.every((add) => add.paged === 1)
      && restarted.adds.length === enableAdds.length
      && !startupMemory.dictionaries.some((row) => row.title === quiet)
      && startupMemory.dictionaries.every((row) => row.paged === false)
      && enabledQuiet.ok === true && enableAdds.length > 0 && enableAdds.every((add) => add.paged === 0)
      && enabledMemory.dictionaries.find((row) => row.title === quiet)?.paged === false
      && enabledLookup.results.some((result) => result.term?.glossaries?.some((glossary) =>
        JSON.stringify(glossary).includes("silence"))),
    JSON.stringify({ status: restarted.status, startupAdds, startupMemory, enabledQuiet, enableAdds, enabledMemory }),
  );

  // An in-engine reimport rebuilds the set; the disabled package's new
  // generation is validated paged there too.
  const reenabledState = await storedDictionaryState();
  await restarted.request("hd_apply_state", {
    baseRevision: reenabledState.revision,
    dictionaries: reenabledState.dictionaries.map((entry) => (entry.title === quiet ? { ...entry, enabled: false } : entry)),
  });
  restarted.adds.length = 0;
  const reimported = await restarted.request("hd_import", { blobUrl: quietZip("stillness"), fileName: `${quiet}.zip` });
  const reimportStatus = await restarted.request("hd_status");
  const reimportAdds = restarted.adds.filter((add) => isQuiet(add.path));
  const reimportState = await storedDictionaryState();
  const reimportMemory = await restarted.request("hd_memory");
  check(
    "a full rebuild validates a disabled package's new generation paged and leaves it unloaded",
    reimported.ok === true && reimportStatus.lastLoadPath === "full"
      && reimportState.dictionaries.find((entry) => entry.title === quiet)?.enabled === false
      && reimportAdds.length > 0 && reimportAdds.every((add) => add.paged === 1)
      && !reimportMemory.dictionaries.some((row) => row.title === quiet)
      && reimportStatus.failedDictionaries.length === 0,
    JSON.stringify({ reimported, reimportStatus, reimportAdds, reimportMemory }),
  );
}

/* --------------------------------------------------- blob-backed IDBFS stage */

// In a worker, IDBFS files persisted as Blobs stay Blobs in the MEMFS mirror:
// restoration, reads, mmap and unload read only the ranges they need, and an
// import's arrays are released once its persistence has completed. Node has no
// FileReaderSync, so this stage supplies a synchronous Blob and reader and
// counts what is read through them.
async function blobBackedIdbfsStage({ createHoshidicts, offscreenChrome, storedDictionaryState, idb }) {
  section("blob-backed IDBFS: Blob records stay Blobs and are read by range");
  const NativeBlob = globalThis.Blob;
  const reads = [];
  class SyncBlob extends NativeBlob {
    constructor(parts = [], options) {
      super(parts, options);
      const chunks = parts.map((part) => (part instanceof SyncBlob ? part.bytes
        : ArrayBuffer.isView(part) ? new Uint8Array(part.buffer, part.byteOffset, part.byteLength)
          : typeof part === "string" ? new TextEncoder().encode(part) : new Uint8Array(part)));
      this.bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        this.bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    slice(start = 0, end = this.bytes.byteLength) {
      return new SyncBlob([this.bytes.subarray(start, end)]);
    }
  }
  globalThis.Blob = SyncBlob;
  globalThis.FileReaderSync = class {
    readAsArrayBuffer(blob) {
      reads.push(blob.bytes.byteLength);
      return blob.bytes.slice().buffer;
    }
  };
  const services = [];
  const startService = async (tag, options = {}) => {
    const service = await import(
      `file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}?blob-${tag}`
    );
    const handle = { module: null };
    service.configureEngineService(
      (message) => offscreenChrome.runtime.sendMessage(message),
      {
        createHoshidicts: async (...args) => {
          handle.module = await createHoshidicts(...args);
          return handle.module;
        },
        storageBackend: "idbfs",
        lowRam: true,
        ...options,
      },
    );
    let counter = 0;
    handle.request = (type, fields = {}) => {
      counter += 1;
      return service.handleEngineMessage({ type, requestId: `blob-${tag}-${counter}`, ...fields });
    };
    service.startEngine();
    const deadline = Date.now() + 30000;
    let status = await handle.request("hd_status");
    while (!(status.ok && status.ready && !status.loading) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 25));
      status = await handle.request("hd_status");
    }
    handle.status = status;
    services.push(handle);
    return handle;
  };
  const node = (handle, path) => handle.module.FS.lookupPath(path).node;
  try {
    // Pseudo-random glosses, so blobs.bin stays above the 1 MiB Blob threshold.
    let seed = 7;
    const noise = () => Array.from({ length: 320 }, () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return String.fromCharCode(97 + (seed % 26));
    }).join("");
    const title = "blob-backed-idbfs";
    const terms = Array.from({ length: 16000 }, (_, index) =>
      [`語${index}`, `ご${index}`, "", "", 0, [index === 0 ? "first word" : noise()], index, ""]);
    const writer = await startService("writer");
    const imported = await writer.request("hd_import", {
      blobUrl: createObjectURL(buildTitledZip(title, { terms })), fileName: `${title}.zip`,
    });
    const record = (await storedDictionaryState()).dictionaries.find((entry) => entry.title === title);
    const blobsPath = `${record?.path}/blobs.bin`;
    const written = node(writer, blobsPath);
    const writerLookup = JSON.stringify((await writer.request("hd_lookup", { text: "語0" })).results);
    check(
      "a persisted import releases its large arrays for the stored Blobs",
      imported.ok === true && written.blob instanceof SyncBlob && written.contents === null
        && written.usedBytes === written.blob.size && written.usedBytes > 1024 * 1024
        && writerLookup.includes("first word"),
      JSON.stringify({ imported, size: written.usedBytes, blob: written.blob?.constructor?.name }),
    );

    reads.length = 0;
    const restored = await startService("restored");
    const restoredNode = node(restored, blobsPath);
    const restoredLookup = JSON.stringify((await restored.request("hd_lookup", { text: "語0" })).results);
    const restoredMemory = await restored.request("hd_memory");
    check(
      "restoring IDBFS backs large files with their Blobs while mapped lookups stay identical",
      restored.status.ready === true && restoredNode.blob instanceof SyncBlob && restoredNode.contents === null
        && restoredLookup === writerLookup
        && restoredMemory.dictionaries.find((row) => row.title === title)?.paged === false
        && reads.every((bytes) => bytes <= 8 * 1024 * 1024),
      JSON.stringify({ status: restored.status, reads: reads.length, restoredMemory }),
    );

    reads.length = 0;
    const paged = await startService("paged", { pagedDictionaries: true });
    const pagedLookup = JSON.stringify((await paged.request("hd_lookup", { text: "語0" })).results);
    const pagedNode = node(paged, blobsPath);
    check(
      "paged reads of a Blob-backed file read pages, not the file",
      pagedLookup === writerLookup && pagedNode.blob instanceof SyncBlob
        && reads.length > 0 && Math.max(...reads) < pagedNode.usedBytes / 4,
      JSON.stringify({ reads, size: pagedNode.usedBytes }),
    );

    // Unloading a read-only mapping must not write it back.
    const readBefore = reads.reduce((sum, bytes) => sum + bytes, 0);
    const state = await storedDictionaryState();
    const unloaded = await restored.request("hd_apply_state", {
      baseRevision: state.revision,
      dictionaries: state.dictionaries.map((entry) => (entry.title === title ? { ...entry, enabled: false } : entry)),
    });
    check(
      "unloading a mapped Blob-backed package leaves its file a Blob",
      unloaded.ok === true && node(restored, blobsPath).blob instanceof SyncBlob
        && node(restored, blobsPath).contents === null
        && !(await restored.request("hd_memory")).dictionaries.some((row) => row.title === title)
        && reads.reduce((sum, bytes) => sum + bytes, 0) - readBefore < node(restored, blobsPath).usedBytes,
      JSON.stringify({ unloaded, readBefore, after: reads.reduce((sum, bytes) => sum + bytes, 0) }),
    );

    // A write reads the file into an array first and changes only what it writes.
    const FS = paged.module.FS;
    const scratch = `${record.path}/scratch.bin`;
    FS.writeFile(scratch, new Uint8Array(2 * 1024 * 1024).fill(5));
    FS.utime(scratch, 1, 1);
    paged.module.FS.filesystems.IDBFS.storeLocalEntry(`${scratch}.copy`,
      { mode: FS.stat(scratch).mode, timestamp: new Date(2), contents: new SyncBlob([FS.readFile(scratch)]) }, () => {});
    const copy = node(paged, `${scratch}.copy`);
    const lazyBefore = copy.blob instanceof SyncBlob;
    const stream = FS.open(`${scratch}.copy`, "r+");
    FS.write(stream, new Uint8Array([9, 9]), 0, 2, 10);
    FS.close(stream);
    const after = FS.readFile(`${scratch}.copy`);
    FS.truncate(`${scratch}.copy`, 0);
    check(
      "writing to a Blob-backed file materializes it and keeps the rest of its bytes",
      lazyBefore && copy.blob === undefined && after.byteLength === 2 * 1024 * 1024
        && after[9] === 5 && after[10] === 9 && after[11] === 9 && after[12] === 5
        && FS.stat(`${scratch}.copy`).size === 0,
      JSON.stringify({ lazyBefore, size: after.byteLength }),
    );
    FS.unlink(`${scratch}.copy`);
    FS.unlink(scratch);

    const reenabled = await storedDictionaryState();
    await restored.request("hd_apply_state", { baseRevision: reenabled.revision,
      dictionaries: reenabled.dictionaries.map((entry) => ({ ...entry, enabled: entry.title === title ? true : entry.enabled })) });
    const removed = await restored.request("hd_remove", { id: record.id, title });
    check(
      "a Blob-backed package is removed from IndexedDB with its files",
      removed.ok === true && !idb.keys("/dicts").some((key) => key.startsWith(record.path)),
      JSON.stringify({ removed }),
    );
  } finally {
    globalThis.Blob = NativeBlob;
    delete globalThis.FileReaderSync;
  }
}

/* ------------------------------------------------------- isolated import stage */

// The direct-OPFS runtime imports through a second engine instance while this
// one keeps answering (engine-service.js runIsolatedImportTransaction). The
// isolated importer here is the real importDictionaryArchive on this engine's
// own filesystem, which is what a second instance on the same OPFS root
// amounts to; a hold before the native import stands in for its duration.
async function isolatedImportStage({ createHoshidicts, offscreenChrome, storedDictionaryState, idb, trainedExpression }) {
  section("isolated import: lookups keep answering, the generation swaps in place");
  const service = await import(
    `file://${resolve(EXTENSION, "engine-service.js").replace(/\\/gu, "/")}?isolated`
  );
  let stageEngine = null;
  const native = { resets: 0, adds: 0, removes: 0, reorders: 0, imports: 0 };
  const addModes = [];
  const progress = [];
  let hold = null;
  let importerFailure = null;
  let memoryFailures = 0;
  const memoryAttempts = [];
  let failedRoot = null;
  let conflictCas = false;
  let casConflicts = 0;
  const isolatedImport = async (request) => {
    if (hold !== null) await hold;
    if (memoryFailures > 0) {
      memoryFailures -= 1;
      memoryAttempts.push(request.lowRam);
      failedRoot = request.generationRoot;
      stageEngine.FS.mkdirTree(`${failedRoot}/partial`);
      stageEngine.FS.writeFile(`${failedRoot}/partial/blobs.bin`, new Uint8Array(16));
      // The real worker owns and detaches these bytes, even when it fails.
      structuredClone(request.archive, { transfer: [request.archive.buffer] });
      throw new Error("std::bad_alloc");
    }
    if (memoryAttempts.length > 0) memoryAttempts.push(request.lowRam);
    if (importerFailure !== null) {
      // A worker that died mid-import leaves whatever it had written.
      failedRoot = request.generationRoot;
      stageEngine.FS.mkdirTree(`${request.generationRoot}/partial`);
      stageEngine.FS.writeFile(`${request.generationRoot}/partial/blobs.bin`, new Uint8Array(16));
      throw importerFailure;
    }
    return service.importDictionaryArchive(stageEngine, request.archive, request.generationRoot,
      request.lowRam, request.fileName, request.expectedArchiveBytes, { resources: request.resources, backend: "opfs" });
  };
  service.configureEngineService(
    async (message) => {
      if (message.type === "hd_state_cas" && conflictCas) {
        casConflicts += 1;
        const current = await offscreenChrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_state_read" });
        return { ok: false, conflict: true, error: "injected commit conflict", state: current.state };
      }
      return offscreenChrome.runtime.sendMessage(message);
    },
    {
      createHoshidicts: async (...args) => {
        const module = await createHoshidicts(...args);
        stageEngine = module;
        const ccall = module.ccall.bind(module);
        module.ccall = (name, returnType, argumentTypes, argumentValues) => {
          const result = ccall(name, returnType, argumentTypes, argumentValues);
          if (name === "hdw_reset") native.resets += 1;
          else if (name === "hdw_add_dict" && result) {
            native.adds += 1;
            addModes.push({ path: argumentValues[0], paged: argumentValues[2] });
          }
          else if (name === "hdw_remove_dict" && result) native.removes += 1;
          else if (name === "hdw_set_dict_order" && result) native.reorders += 1;
          else if (name === "hdw_import") native.imports += 1;
          return result;
        };
        return module;
      },
      storageBackend: "idbfs",
      lowRam: false,
      reportProgress: (event) => progress.push(structuredClone(event)),
      isolatedImport,
    },
  );
  let counter = 0;
  const request = (type, fields = {}) => {
    counter += 1;
    return service.handleEngineMessage({ type, requestId: `isolated-${counter}`, ...fields });
  };
  service.startEngine();
  let status = await request("hd_status");
  const deadline = Date.now() + 30000;
  while (!(status.ok && status.ready && !status.loading) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
    status = await request("hd_status");
  }
  const loadedCount = status.dictionaryCount;
  const snapshot = () => ({ ...native });
  const generationRoots = () => idb.keys("/dicts").filter((path) => /^\/dicts\/\.hdw-generation-[^/]+$/u.test(path));
  const memoryRow = async (title) => (await request("hd_memory")).dictionaries.filter((entry) => entry.title === title);
  const title = "isolated-update-target";
  const query = "更新語";
  const archive = (revision) => new Uint8Array(buildTitledZip(title, {
    revision: `rev-${revision}`,
    terms: [[query, "こうしんご", "", "", 0, [`revision ${revision}`], 1, ""]],
  }));
  const revisionOf = (lookup) => lookup.results?.[0]?.term?.glossaries
    ?.map((entry) => entry.glossary).join("\n").match(/"revision (\d+)"/u)?.[1] ?? null;

  // First install: the new package is added beside the loaded set.
  const beforeInstall = snapshot();
  const install = await request("hd_import", { blobUrl: createObjectURL(archive(1)), fileName: `${title}.zip` });
  const installedState = await storedDictionaryState();
  const installedPackage = installedState.dictionaries.find((entry) => entry.title === title);
  const afterInstall = snapshot();
  check(
    "an isolated first install adds the new generation without resetting or reloading the loaded set",
    install.ok === true && install.report?.success === true && native.imports === beforeInstall.imports + 1
      && installedPackage?.revision === "rev-1" && ownedGenerationRoot(installedPackage.path, title) !== ""
      && afterInstall.resets === beforeInstall.resets && afterInstall.removes === beforeInstall.removes
      && afterInstall.adds === beforeInstall.adds + 1 && afterInstall.reorders === beforeInstall.reorders + 1
      && (await request("hd_status")).dictionaryCount === loadedCount + 1
      && revisionOf(await request("hd_lookup", { text: query })) === "1"
      && progress.filter((event) => event.phase === "installing").every((event) => event.fallback === undefined),
    JSON.stringify({ install, installedPackage, beforeInstall, afterInstall, progress }),
  );

  // Update: while the isolated importer works, both the replaced package and
  // the others answer from the committed generations.
  const release = Promise.withResolvers();
  hold = release.promise;
  const generationBefore = (await request("hd_status")).generation;
  const beforeUpdate = snapshot();
  const rootsBefore = generationRoots();
  const update = request("hd_import", { blobUrl: createObjectURL(archive(2)), fileName: `${title}.zip` });
  await new Promise((done) => setTimeout(done, 50));
  const statusDuring = await request("hd_status");
  const duringTarget = await request("hd_lookup", { text: query });
  const duringOther = await request("hd_lookup", { text: trainedExpression });
  const nativeDuring = snapshot();
  hold = null;
  release.resolve();
  const updated = await update;
  const updatedState = await storedDictionaryState();
  const updatedPackage = updatedState.dictionaries.find((entry) => entry.title === title);
  const afterUpdate = snapshot();
  const afterLookup = await request("hd_lookup", { text: query });
  const rootsAfter = generationRoots();
  const oldRoot = ownedGenerationRoot(installedPackage.path, title);
  const newRoot = ownedGenerationRoot(updatedPackage?.path, title);
  check(
    "lookups during an isolated update answer from the old generation, then the new one swaps in without a reset",
    statusDuring.loading === true && statusDuring.generation === generationBefore
      && duringTarget.ok === true && revisionOf(duringTarget) === "1" && duringTarget.generation === generationBefore
      && duringOther.ok === true && duringOther.results.some((result) => result.term?.expression === trainedExpression)
      && JSON.stringify(nativeDuring) === JSON.stringify(beforeUpdate)
      && updated.ok === true && updatedPackage?.id === installedPackage.id && updatedPackage.revision === "rev-2"
      && newRoot !== "" && newRoot !== oldRoot
      && afterUpdate.resets === beforeUpdate.resets && afterUpdate.imports === beforeUpdate.imports + 1
      && afterUpdate.removes === beforeUpdate.removes + 1 && afterUpdate.adds === beforeUpdate.adds + 1
      && afterUpdate.reorders === beforeUpdate.reorders + 1
      && afterLookup.generation === generationBefore + 1 && revisionOf(afterLookup) === "2"
      && (await request("hd_status")).dictionaryCount === loadedCount + 1
      && updatedState.dictionaries.filter((entry) => entry.id === installedPackage.id).length === 1
      && (await memoryRow(title)).map((entry) => entry.path).join() === updatedPackage.path
      && rootsBefore.includes(oldRoot) && !rootsAfter.includes(oldRoot) && rootsAfter.includes(newRoot),
    JSON.stringify({ statusDuring, duringTarget: revisionOf(duringTarget), duringOther: duringOther.ok, nativeDuring, beforeUpdate,
      afterUpdate, updated, updatedPackage, rootsBefore, rootsAfter, afterLookup: revisionOf(afterLookup) }),
  );

  // The importer fails: nothing in the engine changes and its debris is removed.
  const beforeFailure = snapshot();
  const generationBeforeFailure = (await request("hd_status")).generation;
  importerFailure = new Error("injected import worker failure");
  const failedImport = await request("hd_import", { blobUrl: createObjectURL(archive(3)), fileName: `${title}.zip` });
  importerFailure = null;
  const brokenReport = await request("hd_import", { blobUrl: createObjectURL(new Uint8Array(buildNotAZip())), fileName: "broken.zip" });
  const afterFailure = snapshot();
  const stateAfterFailure = await storedDictionaryState();
  check(
    "a failed isolated import leaves the engine untouched and removes its generation root",
    failedImport.ok === false && failedImport.error.includes("injected import worker failure")
      && brokenReport.ok === false && brokenReport.report?.success === false
      // The broken archive reached the native importer; the loaded set did not move.
      && JSON.stringify(afterFailure) === JSON.stringify({ ...beforeFailure, imports: beforeFailure.imports + 1 })
      && (await request("hd_status")).generation === generationBeforeFailure
      && revisionOf(await request("hd_lookup", { text: query })) === "2"
      && JSON.stringify(stateAfterFailure) === JSON.stringify(updatedState)
      && JSON.stringify(generationRoots()) === JSON.stringify(rootsAfter)
      && failedRoot !== null && !stageEngine.FS.analyzePath(failedRoot).exists,
    JSON.stringify({ failedImport, brokenReport, beforeFailure, afterFailure, failedRoot, roots: generationRoots() }),
  );

  // The commit conflicts: the new package is unloaded again, the old one kept.
  conflictCas = true;
  const beforeConflict = snapshot();
  const conflicted = await request("hd_import", { blobUrl: createObjectURL(archive(3)), fileName: `${title}.zip` });
  conflictCas = false;
  const afterConflict = snapshot();
  const stateAfterConflict = await storedDictionaryState();
  const conflictLookup = await request("hd_lookup", { text: query });
  check(
    "an isolated update whose commit conflicts unloads the new generation and keeps the committed one",
    conflicted.ok === false && conflicted.error.includes("injected commit conflict") && casConflicts === 3
      && JSON.stringify(stateAfterConflict) === JSON.stringify(updatedState)
      && afterConflict.resets === beforeConflict.resets
      && afterConflict.removes === beforeConflict.removes + 2 && afterConflict.adds === beforeConflict.adds + 2
      && conflictLookup.ok === true && revisionOf(conflictLookup) === "2"
      && (await memoryRow(title)).map((entry) => entry.path).join() === updatedPackage.path
      && JSON.stringify(generationRoots()) === JSON.stringify(rootsAfter)
      && (await request("hd_status")).ok === true,
    JSON.stringify({ conflicted, casConflicts, beforeConflict, afterConflict, conflictLookup: revisionOf(conflictLookup), roots: generationRoots() }),
  );

  memoryFailures = 1;
  const beforeRetry = snapshot();
  const generationBeforeRetry = (await request("hd_status")).generation;
  const recovered = await request("hd_import", { blobUrl: createObjectURL(archive(3)), fileName: "Pixiv.zip" });
  const recoveredState = await storedDictionaryState();
  const rootsAfterRetry = generationRoots();
  check(
    "an isolated memory failure restages detached bytes and retries once before publishing one generation",
    recovered.ok === true && memoryAttempts.join() === "false,true"
      && snapshot().resets === beforeRetry.resets
      && snapshot().imports === beforeRetry.imports + 1
      && recoveredState.revision === updatedState.revision + 1
      && revisionOf(await request("hd_lookup", { text: query })) === "3"
      && (await request("hd_status")).generation === generationBeforeRetry + 1
      && !stageEngine.FS.analyzePath(failedRoot).exists
      && progress.some(event => event.phase === "installing" && event.retry === true),
    JSON.stringify({ recovered, memoryAttempts, beforeRetry, after: snapshot(), recoveredState, rootsAfterRetry }),
  );
  memoryAttempts.length = 0;
  memoryFailures = 2;
  const exhausted = await request("hd_import", { blobUrl: createObjectURL(archive(3)), fileName: "Pixiv.zip" });
  check(
    "a repeated memory failure stops after one retry with useful errors and keeps the committed dictionary",
    exhausted.ok === false && exhausted.errorCode === "import-memory"
      && /Pixiv\.zip.*reduced memory/u.test(exhausted.error)
      && exhausted.report?.error === exhausted.error
      && memoryAttempts.join() === "false,true"
      && JSON.stringify(await storedDictionaryState()) === JSON.stringify(recoveredState)
      && JSON.stringify(generationRoots()) === JSON.stringify(rootsAfterRetry)
      && revisionOf(await request("hd_lookup", { text: query })) === "3",
    JSON.stringify({ exhausted, memoryAttempts, roots: generationRoots() }),
  );

  // Updating a disabled package publishes a generation this session never
  // loaded; the in-place path validates it with entries read on demand.
  const enabledState = await storedDictionaryState();
  const disabledTarget = await request("hd_apply_state", {
    baseRevision: enabledState.revision,
    dictionaries: enabledState.dictionaries.map((entry) => (entry.title === title ? { ...entry, enabled: false } : entry)),
  });
  const beforeDisabledUpdate = snapshot();
  addModes.length = 0;
  const disabledUpdate = await request("hd_import", { blobUrl: createObjectURL(archive(4)), fileName: `${title}.zip` });
  const disabledUpdateStatus = await request("hd_status");
  const disabledUpdatePackage = (await storedDictionaryState()).dictionaries.find((entry) => entry.title === title);
  const validationAdds = addModes.filter((add) => add.path === disabledUpdatePackage?.path);
  check(
    "an in-place load validates a disabled package's new generation paged without a reset and leaves it unloaded",
    disabledTarget.ok === true && disabledUpdate.ok === true
      && disabledUpdateStatus.lastLoadPath === "incremental"
      && snapshot().resets === beforeDisabledUpdate.resets
      && disabledUpdatePackage?.enabled === false && disabledUpdatePackage.path !== updatedPackage.path
      && validationAdds.length > 0 && validationAdds.every((add) => add.paged === 1)
      && (await memoryRow(title)).length === 0
      && disabledUpdateStatus.failedDictionaries.length === 0,
    JSON.stringify({ disabledTarget, disabledUpdate, disabledUpdateStatus, validationAdds, addModes }),
  );
  await request("hd_remove", { id: installedPackage.id, title });

  // A Yomitan title is any string; MarvNC's "Nico/Pixiv" (#512) lives in the
  // folder hoshidicts' folder_name gives it, and every later step finds it
  // there again by its title.
  const slashTitle = "Nico/Pixiv";
  const slashQuery = "題名語";
  const slashArchive = new Uint8Array(buildTitledZip(slashTitle, {
    terms: [[slashQuery, "だいめいご", "", "", 0, ["slash title"], 1, ""]],
  }));
  const slashInstall = await request("hd_import", { blobUrl: createObjectURL(slashArchive), fileName: "[Other] Nico-Pixiv.zip" });
  const slashPackage = (await storedDictionaryState()).dictionaries.find((entry) => entry.title === slashTitle);
  const slashLookup = await request("hd_lookup", { text: slashQuery });
  const slashReload = await request("hd_reload");
  const slashAfterReload = await request("hd_lookup", { text: slashQuery });
  check(
    "a title with a slash installs into its own folder, answers lookups by its title and survives a reload",
    slashInstall.ok === true && slashInstall.report?.title === slashTitle
      && /^\/dicts\/\.hdw-generation-[^/]+\/Nico_Pixiv #c747f3db$/u.test(slashPackage?.path ?? "")
      && slashLookup.results?.[0]?.term?.glossaries?.some((entry) => entry.dictionary === slashTitle)
      && slashReload.ok !== false
      && slashAfterReload.results?.[0]?.term?.glossaries?.some((entry) => entry.dictionary === slashTitle)
      && (await request("hd_status")).failedDictionaries.length === 0,
    JSON.stringify({ slashInstall, slashPackage, slashLookup, slashAfterReload }),
  );
  const slashRemoval = await request("hd_remove", { id: slashPackage?.id, title: slashTitle });
  check(
    "a title with a slash can be removed with its files",
    slashRemoval.ok !== false
      && !(await storedDictionaryState()).dictionaries.some((entry) => entry.title === slashTitle)
      && !stageEngine.FS.analyzePath(slashPackage?.path ?? "/missing").exists
      && (await request("hd_lookup", { text: slashQuery })).results.length === 0,
    JSON.stringify({ slashRemoval, path: slashPackage?.path }),
  );
}

describe("engine: isolated, paged and blob-backed storage", () => {
  step("isolated import", async () => {
    await isolatedImportStage({ createHoshidicts, offscreenChrome, storedDictionaryState, idb, trainedExpression });
  });

  step("paged dictionaries", async () => {
    await pagedDictionariesStage({ createHoshidicts, offscreenChrome, storedDictionaryState, trainedExpression });
  });

  step("blob-backed IDBFS", async () => {
    await blobBackedIdbfsStage({ createHoshidicts, offscreenChrome, storedDictionaryState, idb });
  });
});
