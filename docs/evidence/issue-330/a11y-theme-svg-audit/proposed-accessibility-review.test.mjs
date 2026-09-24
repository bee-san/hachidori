// Quick self-check of the proposed gate against PR #329's real file list and
// review state (fetched with gh), plus the pure decision rules.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { accessibilityReview, affectsAccessibility, humanApproved, ACCESSIBILITY_LABEL, HUMAN_REVIEWED_LABEL } from "./accessibility-review.mjs";

const files329 = JSON.parse(execFileSync("gh", ["api", "repos/bee-san/hachidori/pulls/329/files"], { encoding: "utf8" }));
const reviews329 = JSON.parse(execFileSync("gh", ["api", "repos/bee-san/hachidori/pulls/329/reviews"], { encoding: "utf8" }));
const pull329 = JSON.parse(execFileSync("gh", ["api", "repos/bee-san/hachidori/pulls/329"], { encoding: "utf8" }));

test("PR #329 (reader.css + popup.js) is accessibility-affecting by path", () => {
  const decision = affectsAccessibility({ files: files329, labels: [] });
  assert.equal(decision.affected, true);
  assert.match(decision.reason, /reader\.css|popup\.js/u);
});

test("PR #329 had no human approval at its head SHA and no human-reviewed label", () => {
  const verdict = humanApproved({ owner: "bee-san", headSha: pull329.head.sha, reviews: reviews329, labels: pull329.labels.map(l => l.name) });
  assert.equal(reviews329.length, 0);
  assert.equal(verdict.approved, false);
});

test("a docs-only change is not accessibility-affecting, even when the prose mentions contrast", () => {
  assert.equal(affectsAccessibility({ files: [{ filename: "docs/architecture.md", patch: "+Some prose about contrast and focus order" }], labels: [] }).affected, false);
  assert.equal(affectsAccessibility({ files: [{ filename: "docs/architecture.md", patch: "+Some prose about zstd training" }], labels: [] }).affected, false);
});

test("a background.js change that adds aria attributes is caught by the token rule", () => {
  const d = affectsAccessibility({ files: [{ filename: "extension/background.js", patch: "+  element.setAttribute(\"aria-live\", \"polite\");" }], labels: [] });
  assert.equal(d.affected, true);
});

test("the label alone marks a PR as accessibility-affecting", () => {
  assert.equal(affectsAccessibility({ files: [], labels: [ACCESSIBILITY_LABEL] }).affected, true);
});

test("the gate passes on an owner APPROVED review for the exact head, or on the human-reviewed label", () => {
  const reviews = [{ state: "APPROVED", user: { login: "bee-san" }, commit_id: "abc", html_url: "u" }];
  assert.equal(humanApproved({ owner: "bee-san", headSha: "abc", reviews, labels: [] }).approved, true);
  assert.equal(humanApproved({ owner: "bee-san", headSha: "def", reviews, labels: [] }).approved, false, "stale approval on an older commit does not count");
  assert.equal(humanApproved({ owner: "bee-san", headSha: "def", reviews: [], labels: [HUMAN_REVIEWED_LABEL] }).approved, true);
});

test("the wrapper fails the check for #329-shaped input and adds the label", async () => {
  const writes = [];
  let failed = null;
  const context = { repo: { owner: "bee-san", repo: "hachidori" }, payload: { pull_request: { number: 329, head: { sha: pull329.head.sha }, labels: [] } } };
  const github = {
    paginate: async (fn) => fn(),
    rest: { pulls: { listFiles: async () => files329, listReviews: async () => reviews329 }, issues: { addLabels: async (request) => { writes.push(request); } } },
  };
  await accessibilityReview({ github, context, core: { info() {}, setFailed(message) { failed = message; } } });
  assert.deepEqual(writes.map(w => w.labels), [[ACCESSIBILITY_LABEL]]);
  assert.match(failed, /affects accessibility/u);
});
