// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { dictionaryImportError, isImportMemoryError, nativeImportCall } from "../extension/dictionary-import-errors.js";
import { importDictionaryArchive, streamResponseToFile } from "../extension/engine-service.js";

test("invalid mmap pointers report memory pressure before copy or unmap; cleanup cannot hide it", async () => {
  let unmapped = false;
  const module = { HEAPU8: new Uint8Array(32), FS: {
    open: () => ({ fd: 7 }), ftruncate() {},
    mmap: () => ({ ptr: 0xffff_ffd0, allocated: true }),
    munmap() { unmapped = true; throw new Error("secondary unmap failure"); },
    close() { throw new Error("secondary close failure"); },
  } };
  await assert.rejects(importDictionaryArchive(module, new Uint8Array(128), "/dicts/new", false, "Pixiv.zip"), error => {
    assert.equal(error.errorCode, "import-memory");
    assert.match(error.message, /Pixiv\.zip: staging the archive failed.*128 bytes/u);
    assert.match(error.message, /Low memory mode/u);
    assert.doesNotMatch(error.message, /secondary/u);
    return true;
  });
  assert.equal(unmapped, false);
});

test("writeback failure survives an unmap error and a close error", async () => {
  const primary = new Error("disk write failed");
  const module = { HEAPU8: new Uint8Array(32), FS: {
    open: () => ({ fd: 7 }), ftruncate() {},
    mmap: () => ({ ptr: 4, allocated: true }),
    msync() { throw primary; },
    munmap() { throw new Error("secondary unmap failure"); },
    close() { throw new Error("secondary close failure"); },
  } };
  await assert.rejects(streamResponseToFile(module, new Uint8Array(8), "/archive.zip"), error => error === primary);
});

test("native exceptions are decoded, released, and restore the shadow stack before another call", () => {
  const exception = new WebAssembly.Exception(new WebAssembly.Tag({ parameters: [] }), []);
  let restored = false;
  let released = false;
  const module = {
    stackSave: () => 123,
    stackRestore: value => { assert.equal(value, 123); restored = true; },
    getExceptionMessage: value => { assert.equal(value, exception); return ["std::bad_alloc", "allocation failed"]; },
    decrementExceptionRefcount: value => { assert.equal(value, exception); released = true; },
  };
  assert.throws(() => nativeImportCall(module, () => { throw exception; }), /std::bad_alloc: allocation failed/u);
  assert.ok(restored && released);
  assert.equal(nativeImportCall(module, () => "next import"), "next import");
});

test("import errors distinguish memory, storage, and unknown engine failures with filename and stage", () => {
  for (const error of [new Error("std::bad_alloc"), { errno: 48, message: "FS error" }, new Error("memory access out of bounds")]) {
    const result = dictionaryImportError(error, "Pixiv.zip", "compiling dictionary banks");
    assert.equal(result.errorCode, "import-memory");
    assert.ok(isImportMemoryError(result));
    assert.match(result.message, /Pixiv\.zip: compiling dictionary banks failed/u);
    assert.equal(dictionaryImportError(result, "other.zip", "other stage"), result);
  }
  const full = dictionaryImportError({ name: "QuotaExceededError", message: "Quota exceeded" }, "Pixiv.zip", "saving generated files");
  assert.equal(full.errorCode, "import-storage-full");
  assert.match(full.message, /Free disk space/u);
  assert.equal(isImportMemoryError(full), false);
  assert.match(dictionaryImportError("exception", "Pixiv.zip", "starting the import worker").message, /report this filename and stage/u);
});

test("reduced-memory OPFS import stages input under its uncommitted generation and removes it", async () => {
  const paths = [];
  const deleted = [];
  const module = { FS: {
    mkdirTree: path => paths.push(path),
    open: path => ({ path }), write: (_stream, _data, _offset, length) => length, close() {},
    unlink: path => deleted.push(path), rmdir() {},
  }, ccall(name, _type, _types, args) {
    assert.equal(name, "hdw_import");
    paths.push(args[0]);
    assert.equal(args[2], 1);
    return JSON.stringify({ success: true, title: "Pixiv" });
  } };
  const report = await importDictionaryArchive(module, new Uint8Array(8), "/dicts/new", true, "Pixiv.zip", 8, [], "opfs");
  assert.equal(report.success, true);
  assert.deepEqual(paths, ["/dicts/new", "/dicts/new/.hdw-archive.zip"]);
  assert.deepEqual(deleted, ["/dicts/new/.hdw-archive.zip"]);
});
