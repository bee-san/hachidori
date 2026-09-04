#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const submodulePath = "third_party/hoshidicts";

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
  }).trim();
}

function gitlinkFromHead() {
  const line = git(["ls-tree", "HEAD", submodulePath]);
  const match = line.match(/^\d+ commit ([0-9a-f]{40})\t/);
  assert.ok(match, `HEAD does not record a gitlink for ${submodulePath}`);
  return match[1];
}

function declaredBranch() {
  return git(["config", "-f", ".gitmodules", `submodule.${submodulePath}.branch`]);
}

function containsCommit(remoteBranch, commit) {
  try {
    execFileSync("git", ["-C", submodulePath, "merge-base", "--is-ancestor", commit, remoteBranch], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(String(error && error.message ? error.message : error));
  }
}

const pinnedCommit = gitlinkFromHead();
const branch = declaredBranch();
const submoduleUrl = git(["config", "-f", ".gitmodules", `submodule.${submodulePath}.url`]);

git(["submodule", "update", "--init", submodulePath]);
git(["-C", submodulePath, "fetch", "--quiet", "origin"]);

check("declared submodule url resolves to the runtime engine repository", () => {
  assert.match(submoduleUrl, /hoshidicts(\.git)?$/);
});

check("the .gitmodules tracked branch contains the pinned runtime gitlink", () => {
  const remoteBranch = `origin/${branch}`;
  assert.ok(
    containsCommit(remoteBranch, pinnedCommit),
    `pinned gitlink ${pinnedCommit} is not reachable from the declared tracking ` +
      `branch ${remoteBranch}; 'git submodule update --remote' would regress the ` +
      `runtime submodule identity`,
  );
});

check("the runtime gitlink is the tip of its declared tracking branch", () => {
  const tip = git(["-C", submodulePath, "rev-parse", `origin/${branch}`]);
  assert.equal(
    tip,
    pinnedCommit,
    `declared tracking branch origin/${branch} points at ${tip}, not the pinned ` +
      `runtime gitlink ${pinnedCommit}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
