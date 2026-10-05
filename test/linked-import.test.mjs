// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { decodeBase64 } from "../extension/base64.js";
import { createUploadHost, uploadDictionary, uploadImportDecision } from "../extension/linked-import.js";

const IDENTITY = { title: "SubMiner Characters", revision: "2", indexUrl: null, downloadUrl: null };
const INSTALLED = {
  id: "characters-id", title: "SubMiner Characters", path: "/dicts/g1/SubMiner Characters", revision: "1",
  indexUrl: null, downloadUrl: null, isUpdatable: false,
};

function fixture({ chunkBytes = 4, importReplies = [] } = {}) {
  const stored = new Map();
  const discarded = [];
  const timers = new Map();
  let nextTimer = 0;
  let nextToken = 0;
  const imports = [];
  const host = createUploadHost({
    store: {
      append: async (token, data, byteLength) => {
        const bytes = decodeBase64(data);
        assert.equal(bytes.byteLength, byteLength);
        stored.set(token, [...stored.get(token) ?? [], ...bytes]);
      },
      discard: (token) => { discarded.push(token); stored.delete(token); },
    },
    importUpload: async (token, request) => {
      imports.push({ bytes: stored.get(token), ...request });
      if (importReplies.length > 0) return importReplies.shift();
      return { type: "hd_import_result", ok: true, report: { success: true, title: IDENTITY.title } };
    },
    chunkBytes, idleMs: 1000,
    randomToken: () => `token-${++nextToken}`,
    setTimer: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  return { host, stored, discarded, imports, expire: () => { for (const callback of [...timers.values()]) callback(); } };
}

const base64 = text => Buffer.from(text).toString("base64");

test("a complete upload imports the reassembled bytes with the sender's replace choice", async () => {
  const { host, imports, discarded } = fixture();
  const { token, chunkBytes } = host.begin({ fileName: "characters.zip", size: 6, replace: true }, "remote:a");
  assert.equal(chunkBytes, 4);
  assert.deepEqual(await host.chunk({ token, offset: 0, data: base64("PK\u0003\u0004") }, "remote:a"), { received: 4 });
  assert.deepEqual(await host.chunk({ token, offset: 4, data: base64("zz") }, "remote:a"), { received: 6 });
  const reply = await host.commit({ token }, "remote:a");
  assert.equal(reply.report.success, true);
  assert.deepEqual(imports, [{ bytes: [...Buffer.from("PK\u0003\u0004zz")], fileName: "characters.zip", replace: true }]);
  assert.deepEqual(discarded, [token]);
  assert.equal(host.size(), 0);
});

test("uploads reject empty, MDX and unnamed archives at begin", () => {
  const { host } = fixture();
  assert.throws(() => host.begin({ fileName: "empty.zip", size: 0, replace: false }, "local"), /empty/u);
  assert.throws(() => host.begin({ fileName: "Dict.mdx", size: 4, replace: false }, "local"), /MDX/u);
  assert.throws(() => host.begin({ fileName: "../a.zip", size: 4, replace: false }, "local"), /file name/u);
  assert.equal(host.size(), 0);
});

test("an out-of-order, oversized or foreign chunk ends the upload", async () => {
  const { host, discarded } = fixture();
  const first = host.begin({ fileName: "a.zip", size: 8, replace: true }, "remote:a");
  await assert.rejects(host.chunk({ token: first.token, offset: 4, data: base64("abcd") }, "remote:a"), /expected byte 0/u);
  const second = host.begin({ fileName: "a.zip", size: 3, replace: true }, "remote:a");
  await assert.rejects(host.chunk({ token: second.token, offset: 0, data: base64("abcd") }, "remote:a"), /announced size/u);
  const third = host.begin({ fileName: "a.zip", size: 4, replace: true }, "remote:a");
  await assert.rejects(host.chunk({ token: third.token, offset: 0, data: base64("abcd") }, "remote:b"), /no longer open/u);
  await assert.rejects(host.commit({ token: third.token }, "remote:a"), /after 0 of 4 bytes/u);
  assert.deepEqual(discarded, [first.token, second.token, third.token]);
});

test("abort, the idle timeout and a disconnect drop held uploads", async () => {
  const { host, discarded, expire } = fixture();
  const aborted = host.begin({ fileName: "a.zip", size: 4, replace: true }, "remote:a");
  assert.deepEqual(host.abort({ token: aborted.token }, "remote:a"), {});
  const idle = host.begin({ fileName: "b.zip", size: 4, replace: true }, "remote:a");
  expire();
  await assert.rejects(host.chunk({ token: idle.token, offset: 0, data: base64("abcd") }, "remote:a"), /no longer open/u);
  const gone = host.begin({ fileName: "c.zip", size: 4, replace: true }, "remote:b");
  const kept = host.begin({ fileName: "d.zip", size: 4, replace: true }, "local");
  host.dropWhere(owner => owner === "remote:b");
  assert.deepEqual(discarded, [aborted.token, idle.token, gone.token]);
  assert.equal(host.size(), 1);
  host.dropWhere(owner => owner !== "local");
  assert.equal(host.size(), 1, kept.token);
});

test("replace picks the installed dictionary with that title; otherwise the upload installs beside it", () => {
  const target = { ...INSTALLED, sourceId: null };
  assert.deepEqual(uploadImportDecision(IDENTITY, [INSTALLED], true),
    { action: "replace", identity: IDENTITY, matchKind: "title", target });
  assert.deepEqual(uploadImportDecision(IDENTITY, [INSTALLED], false),
    { action: "separate", identity: IDENTITY, matchKind: "title", target });
  assert.deepEqual(uploadImportDecision(IDENTITY, [], true),
    { action: "install", identity: IDENTITY, matchKind: null, target: null });
});

test("the sender slices a Blob into ordered chunks and aborts after a refusal", async () => {
  const { host, imports } = fixture({ chunkBytes: 3 });
  const send = async (type, fields) => {
    try {
      const method = { hd_import_begin: "begin", hd_import_chunk: "chunk", hd_import_commit: "commit", hd_import_abort: "abort" }[type];
      return { ok: true, ...await host[method](fields, "remote:a") };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  const reply = await uploadDictionary({ blob: new Blob(["abcdefg"]), fileName: "a.zip", replace: false, send });
  assert.equal(reply.ok, true);
  assert.deepEqual(imports.map(entry => Buffer.from(entry.bytes).toString()), ["abcdefg"]);

  const sent = [];
  await assert.rejects(uploadDictionary({ blob: new Blob(["abcd"]), fileName: "a.zip", replace: true,
    send: async (type, fields) => {
      sent.push(type);
      if (type === "hd_import_begin") return { ok: true, token: "t", chunkBytes: 2 };
      if (type === "hd_import_chunk") return { ok: false, error: "refused" };
      return { ok: true };
    } }), { message: "refused" });
  assert.deepEqual(sent, ["hd_import_begin", "hd_import_chunk", "hd_import_abort"]);
});

test("a commit refused while the engine is busy keeps the upload for another commit", async () => {
  const busy = { type: "hd_import_result", ok: false, error: "the dictionary engine is busy mutating", errorCode: "engine-mutating" };
  const { host, imports, discarded } = fixture({ importReplies: [busy] });
  const { token } = host.begin({ fileName: "characters.zip", size: 2, replace: true }, "remote:a");
  await host.chunk({ token, offset: 0, data: base64("PK") }, "remote:a");
  assert.equal((await host.commit({ token }, "remote:a")).errorCode, "engine-mutating");
  assert.deepEqual(discarded, []);
  assert.equal((await host.commit({ token }, "remote:a")).report.success, true);
  assert.deepEqual(imports.map(entry => entry.bytes), [[...Buffer.from("PK")], [...Buffer.from("PK")]]);
  assert.deepEqual(discarded, [token]);
  assert.equal(host.size(), 0);
});
