// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64, encodeBase64 } from "../extension/base64.js";

const legacyEncode = (bytes) => globalThis.btoa(String.fromCharCode(...bytes));
const legacyDecode = (text) => Uint8Array.from(globalThis.atob(text), (c) => c.codePointAt(0));

test("encodeBase64 matches btoa for every byte value and odd lengths", () => {
  for (const length of [0, 1, 2, 3, 4, 255, 256, 257, 70_000]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) bytes[i] = (i * 131 + 7) & 0xff;
    assert.equal(encodeBase64(bytes), legacyEncode(bytes));
    assert.equal(encodeBase64(bytes.buffer.slice(0, length)), legacyEncode(bytes));
  }
});

test("decodeBase64 matches atob and round-trips", () => {
  for (const length of [0, 1, 2, 3, 4, 255, 256, 257, 70_000]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) bytes[i] = (i * 197 + 3) & 0xff;
    const text = legacyEncode(bytes);
    assert.deepEqual(decodeBase64(text), legacyDecode(text));
    assert.deepEqual(decodeBase64(encodeBase64(bytes)), bytes);
  }
});

test("decodeBase64 rejects what atob rejects", () => {
  assert.throws(() => decodeBase64("not base64!"));
});

test("the injected window functions are used when the native API is absent", () => {
  let calls = 0;
  const fake = { btoa: (s) => { calls += 1; return globalThis.btoa(s); }, atob: (s) => { calls += 1; return globalThis.atob(s); } };
  const bytes = new Uint8Array([1, 2, 3]);
  const text = encodeBase64(bytes, { btoa: fake.btoa });
  assert.deepEqual(decodeBase64(text, { atob: fake.atob }), bytes);
  if (typeof Uint8Array.prototype.toBase64 !== "function") assert.equal(calls, 2);
});
