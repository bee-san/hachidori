// SPDX-License-Identifier: GPL-3.0-or-later
//
// The preload test/profiles-golden-record.mjs's capture was made with: it gives
// every realm (Node's own, vm contexts and jsdom windows) a recorder,
// `globalThis.__hdCaptureOptions(fn, value)`, that appends the JSON of value to
// $HD_CAPTURE_FILE. The recorded run added one line to the top of
// normaliseOptions and of projectStoredOptions in extension/reader-options.js,
//   globalThis.__hdCaptureOptions?.("normaliseOptions", value);
// and ran, with NODE_OPTIONS="--import=<this file>",
//   node test/run.mjs node && node test/run.mjs smoke
// The line was then removed again; no committed file calls the recorder.
import { appendFileSync } from "node:fs";
import module from "node:module";
import vm from "node:vm";

const file = process.env.HD_CAPTURE_FILE;
const suite = process.env.HD_CAPTURE_SUITE ?? "";

function capture(fn, value) {
  let json;
  try {
    json = value === undefined ? "__undefined__" : JSON.stringify(value);
  } catch {
    return;
  }
  if (json === undefined) return;
  try {
    appendFileSync(file, `${JSON.stringify({ fn, suite, json })}\n`);
  } catch {
    // Capture is best effort.
  }
}

globalThis.__hdCaptureOptions = capture;

function equip(target) {
  if (target && (typeof target === "object" || typeof target === "function")) {
    try {
      Object.defineProperty(target, "__hdCaptureOptions", { value: capture, configurable: true, writable: true });
    } catch {
      // A frozen sandbox cannot be equipped.
    }
  }
}

const { createContext, runInNewContext } = vm;
vm.createContext = function patchedCreateContext(sandbox, ...rest) {
  if (sandbox !== vm.constants.DONT_CONTEXTIFY) {
    equip(sandbox);
    if (sandbox && typeof sandbox.globalThis === "object") equip(sandbox.globalThis);
  }
  const context = createContext.call(this, sandbox, ...rest);
  equip(context);
  return context;
};
vm.runInNewContext = function patchedRunInNewContext(code, sandbox, ...rest) {
  if (sandbox === undefined) sandbox = {};
  if (sandbox && typeof sandbox === "object") {
    equip(sandbox);
    if (typeof sandbox.globalThis === "object") equip(sandbox.globalThis);
  }
  return runInNewContext.call(this, code, sandbox, ...rest);
};
module.syncBuiltinESMExports();
