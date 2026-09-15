// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { command } from "./compare.mjs";

test("command preserves dirty status leading columns for identity and resume checks", () => {
  const root = mkdtempSync(join(tmpdir(), "hachidori-status-"));
  try {
    command("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "original\n");
    command("git", ["add", "tracked.txt"], { cwd: root });
    command("git", ["-c", "user.name=Benchmark Test", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    writeFileSync(join(root, "untracked.txt"), "new\n");

    const frozenStatus = command("git", ["status", "--short", "--untracked-files=all"], { cwd: root });
    assert.equal(frozenStatus, " M tracked.txt\n?? untracked.txt");
    assert.equal(command("git", ["status", "--short", "--untracked-files=all"], { cwd: root }), frozenStatus);

    writeFileSync(join(root, "second-untracked.txt"), "newer\n");
    assert.notEqual(command("git", ["status", "--short", "--untracked-files=all"], { cwd: root }), frozenStatus);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
