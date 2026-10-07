/*
 * Shared reader option ranges and the options transport.
 *
 * Part of the extension smoke suite (test/extension-smoke.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe } from "node:test";
import { EXTENSION } from "./fakes.mjs";
import { check, fail, section, test } from "./harness.mjs";

// The shared reader range must agree with the HTML inputs and the independent
// engine request boundary, so persisted settings cannot request fewer results
// in one runtime context than another.
const OPTION_RANGES = [
  [
    "maxResults",
    [
      ["reader-options.js", /maxResults:\s*\[(\d+),\s*(\d+)\]/u],
      ["settings.html", /id="opt-max-results"[^>]*?min="(\d+)"[^>]*?max="(\d+)"/u],
      ["engine-service.js", /clampInt\(\s*message\.maxResults,\s*(\d+),\s*(\d+)/u],
    ],
  ],
  [
    "scanLength",
    [
      ["reader-options.js", /scanLength:\s*\[(\d+),\s*(\d+)\]/u],
      ["settings.html", /id="opt-scan-length"[^>]*?min="(\d+)"[^>]*?max="(\d+)"/u],
      ["engine-service.js", /clampInt\(\s*message\.scanLength,\s*(\d+),\s*(\d+)/u],
    ],
  ],
];

function checkOptionRanges() {
  for (const [option, layers] of OPTION_RANGES) {
    const ranges = [];
    for (const [file, pattern] of layers) {
      const found = pattern.exec(readFileSync(resolve(EXTENSION, file), "utf8"));
      if (found === null) {
        fail(
          `${file} declares a ${option} range`,
          `nothing matched ${pattern}; if the clamp moved, move this check with it`,
        );
        continue;
      }
      ranges.push(`${file} ${found[1]}..${found[2]}`);
    }
    check(
      `every layer clamps ${option} to the same range`,
      new Set(ranges.map((range) => range.split(" ")[1])).size === 1,
      ranges.join("\n"),
    );
  }
}

describe("reader options", () => {
  test("option ranges match the HTML inputs and the engine bounds", async () => {
    section("option ranges");
    checkOptionRanges();
  });
});
