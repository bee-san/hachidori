// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  boundResponseFailure,
  responseFits,
  responseLimitError,
} from "../extension/response-limits.js";

test("captured assets use the dedicated 6 MiB serialized response boundary", () => {
  const limit = 6 * 1024 * 1024;
  const reply = {
    type: "hd_capture_asset_result",
    requestId: "capture-asset",
    ok: true,
    error: null,
    filename: "hachidori-abc123.avif",
    data: "",
  };
  const emptyBytes = new TextEncoder().encode(JSON.stringify(reply)).byteLength;
  reply.data = "A".repeat(limit - emptyBytes);
  assert.equal(responseFits(reply), true);
  reply.data += "A";
  assert.equal(responseFits(reply), false);
  const bounded = boundResponseFailure(reply);
  assert.equal(bounded.ok, true);
  assert.equal(bounded.error, responseLimitError("hd_capture_asset_result"));
  assert.equal(bounded.requestId, null);
});
