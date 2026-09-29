// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import {
  affectsAccessibility, humanApproved, accessibilityReview,
} from "../.github/scripts/accessibility-review.mjs";

test("the review gate recognises visual and interaction changes without flagging prose", () => {
  assert.deepEqual(affectsAccessibility({
    files: [{ filename: "extension/render/reader.css" }], labels: [],
  }), { affected: true, reason: "path extension/render/reader.css" });
  assert.equal(affectsAccessibility({
    files: [{ filename: "docs/architecture.md", patch: "+contrast and focus" }], labels: [],
  }).affected, false);
  assert.equal(affectsAccessibility({
    files: [{ filename: "extension/background.js", patch: "+element.setAttribute('aria-live', 'polite')" }], labels: [],
  }).affected, true);
  assert.equal(affectsAccessibility({ files: [], labels: ["accessibility"] }).affected, true);
});

test("a current owner approval or owner-applied label clears the gate", () => {
  const arguments_ = { owner: "bee-san", headSha: "new", labels: [], reviews: [
    { user: { login: "bee-san" }, state: "APPROVED", commit_id: "old" },
  ] };
  assert.equal(humanApproved(arguments_).approved, false);
  assert.equal(humanApproved({ ...arguments_, reviews: [
    ...arguments_.reviews,
    { user: { login: "bee-san" }, state: "APPROVED", commit_id: "new", html_url: "review-url" },
  ] }).approved, true);
  assert.equal(humanApproved({ ...arguments_, labels: ["human-reviewed"] }).approved, true);
  assert.equal(humanApproved({ ...arguments_, reviews: [
    { user: { login: "bee-san" }, state: "APPROVED", commit_id: "new" },
    { user: { login: "bee-san" }, state: "CHANGES_REQUESTED", commit_id: "new" },
  ] }).approved, false);
});

test("the gate labels a CSS pull request and records a failing check until owner review", async () => {
  const events = [];
  const pull = { number: 329, head: { sha: "a1234567" }, labels: [] };
  let reviews = [];
  let existing = [];
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: pull }), listFiles: () => {}, listReviews: () => {},
      },
      issues: { addLabels: async input => events.push(["label", input.labels]) },
      checks: {
        listForRef: async () => ({ data: { check_runs: existing } }),
        create: async input => events.push(["create", input.conclusion, input.output.summary]),
        update: async input => events.push(["update", input.conclusion, input.output.summary]),
      },
    },
    paginate: async (method) => method === github.rest.pulls.listFiles
      ? [{ filename: "extension/render/reader.css" }] : reviews,
  };
  const context = { repo: { owner: "bee-san", repo: "hachidori" }, payload: { pull_request: pull } };
  const core = { info: () => {} };
  await accessibilityReview({ github, context, core });
  assert.deepEqual(events.map(event => event.slice(0, 2)), [
    ["label", ["accessibility"]], ["create", "failure"],
  ]);
  assert.match(events[1][2], /path extension\/render\/reader\.css/u);

  pull.labels = [{ name: "accessibility" }];
  reviews = [{ user: { login: "bee-san" }, state: "APPROVED", commit_id: pull.head.sha, html_url: "review-url" }];
  existing = [{ id: 12, name: "Accessibility review", external_id: "accessibility-review-pr-329" }];
  await accessibilityReview({ github, context, core });
  assert.deepEqual(events.at(-1).slice(0, 2), ["update", "success"]);
});
