// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import {
  describeError, describeErrorMessage, describeErrorMessageOrJson, describeErrorOrJson,
} from "../extension/error-text.js";

// One value for each branch that tells the variants apart. The expected texts
// are what the per-file describe(error) copies these variants replaced
// returned, so changing one changes a log line, status or reply somewhere.
const INPUTS = [
  new Error("boom"),
  new TypeError(""),
  "text",
  "",
  { message: "plain" },
  { message: "" },
  { message: 5 },
  { code: 7 },
  vm.runInNewContext('new Error("elsewhere")'),
  Object.assign(new Error("x"), { message: 42 }),
  null,
  undefined,
  Number.NaN,
];

test("every variant gives an Error's message, its String() when empty, and a string itself", () => {
  for (const describe of [describeError, describeErrorOrJson, describeErrorMessageOrJson, describeErrorMessage]) {
    assert.deepEqual(INPUTS.slice(0, 4).map(value => describe(value)), ["boom", "TypeError", "text", ""], describe.name);
  }
});

test("describeError writes any other value with String()", () => {
  assert.deepEqual(INPUTS.map(value => describeError(value)), [
    "boom", "TypeError", "text", "",
    "[object Object]", "[object Object]", "[object Object]", "[object Object]",
    "Error: elsewhere", 42, "null", "undefined", "NaN",
  ]);
});

test("describeErrorOrJson writes any other value as JSON", () => {
  assert.deepEqual(INPUTS.map(value => describeErrorOrJson(value)), [
    "boom", "TypeError", "text", "",
    '{"message":"plain"}', '{"message":""}', '{"message":5}', '{"code":7}',
    "{}", 42, "null", undefined, "null",
  ]);
});

test("describeErrorMessageOrJson prefers an object's truthy message, then JSON", () => {
  assert.deepEqual(INPUTS.map(value => describeErrorMessageOrJson(value)), [
    "boom", "TypeError", "text", "",
    "plain", '{"message":""}', "5", '{"code":7}',
    "elsewhere", 42, "null", undefined, "null",
  ]);
});

test("describeErrorMessage prefers any non-empty string message, then String()", () => {
  assert.deepEqual(INPUTS.map(value => describeErrorMessage(value)), [
    "boom", "TypeError", "text", "",
    "plain", "[object Object]", "[object Object]", "[object Object]",
    "elsewhere", "Error: 42", "null", "undefined", "NaN",
  ]);
});
