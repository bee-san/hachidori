// SPDX-License-Identifier: GPL-3.0-or-later
//
// A Japanese-only engine start loads no profile code (docs/languages.md 5):
// the engine worker's modules import registry.js, reader-options.js and
// profile-state.js only when records with profiles are read or a request
// needs them. Each test file runs in its own process, so nothing else has set
// the globals those scripts set.
import assert from "node:assert/strict";
import { test } from "node:test";

test("the engine worker loads the profile code only for a request that needs it", async () => {
  await import("../extension/engine-worker-runtime.js");
  const { handleEngineMessage } = await import("../extension/engine-service.js");
  assert.equal(globalThis.HDReaderOptions, undefined, "the static module graph loads reader-options.js");
  assert.equal(globalThis.HDLanguages, undefined, "the static module graph loads registry.js");

  // An engine that has not started refuses every request, after loading what
  // the request needs.
  const lookup = await handleEngineMessage({ type: "hd_lookup", requestId: "lookup", text: "食べる" });
  assert.equal(lookup.errorCode, "engine-starting");
  assert.equal(globalThis.HDReaderOptions, undefined, "a Japanese lookup loads the profile code");

  const added = await handleEngineMessage({ type: "hd_profile_add", requestId: "add", language: "en", copyFrom: "ja" });
  assert.equal(added.errorCode, "engine-starting");
  assert.equal(typeof globalThis.HDReaderOptions?.projectOptions, "function");
  assert.equal(typeof globalThis.HDLanguages?.get, "function");
});
