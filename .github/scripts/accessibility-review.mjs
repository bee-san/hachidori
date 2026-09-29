// SPDX-License-Identifier: GPL-3.0-or-later

export const ACCESSIBILITY_LABEL = "accessibility";
export const HUMAN_REVIEWED_LABEL = "human-reviewed";

const ACCESSIBILITY_PATHS = [
  /^extension\/.*\.css$/u,
  /^extension\/(?:reader-options|settings-theme|settings-dom|content)\.js$/u,
  /^extension\/design-preview\.(?:js|html)$/u,
  /^extension\/render\/(?:glossary|popup)\.js$/u,
];
const ACCESSIBILITY_PATCH_TOKENS = /(?:aria-[a-z]+|role=|tabindex|\.focus\(|:focus|prefers-color-scheme|prefers-reduced-motion|prefers-contrast|forced-colors|forced-color-adjust|color-scheme|--hoshidicts-palette|--text-color|contrast|font-size|animation|transition|outline|visibility|@keyframes)/iu;

export function affectsAccessibility({ files, labels }) {
  if (labels.includes(ACCESSIBILITY_LABEL)) return { affected: true, reason: `label "${ACCESSIBILITY_LABEL}"` };
  for (const file of files) {
    if (ACCESSIBILITY_PATHS.some(pattern => pattern.test(file.filename) || pattern.test(file.previous_filename ?? ""))) {
      return { affected: true, reason: `path ${file.filename}` };
    }
  }
  for (const file of files) {
    if (/\.(?:md|txt)$/iu.test(file.filename)) continue;
    const added = (file.patch ?? "").split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"));
    const hit = added.find(line => ACCESSIBILITY_PATCH_TOKENS.test(line));
    if (hit) return { affected: true, reason: `${file.filename} adds ${JSON.stringify(hit.slice(1, 80).trim())}` };
  }
  return { affected: false, reason: null };
}

export function humanApproved({ owner, headSha, reviews, labels }) {
  if (labels.includes(HUMAN_REVIEWED_LABEL)) return { approved: true, how: `label "${HUMAN_REVIEWED_LABEL}"` };
  const latest = reviews.filter(review => review.user?.login === owner && review.commit_id === headSha).at(-1);
  return latest?.state === "APPROVED"
    ? { approved: true, how: `review ${latest.html_url}` }
    : { approved: false, how: null };
}

export async function accessibilityReview({ github, context, core }) {
  const number = context.payload.pull_request.number;
  const parameters = { ...context.repo, pull_number: number };
  // Review and label events can be queued behind a new push. Read the current head.
  const { data: pull } = await github.rest.pulls.get(parameters);
  const files = await github.paginate(github.rest.pulls.listFiles, { ...parameters, per_page: 100 });
  let labels = pull.labels.map(label => label.name);
  const decision = affectsAccessibility({ files, labels });
  if (decision.affected && !labels.includes(ACCESSIBILITY_LABEL)) {
    await github.rest.issues.addLabels({ ...context.repo, issue_number: number, labels: [ACCESSIBILITY_LABEL] });
    labels = [...labels, ACCESSIBILITY_LABEL];
  }
  const reviews = decision.affected
    ? await github.paginate(github.rest.pulls.listReviews, { ...parameters, per_page: 100 })
    : [];
  const verdict = humanApproved({ owner: context.repo.owner, headSha: pull.head.sha, reviews, labels });
  const passed = !decision.affected || verdict.approved;
  const summary = !decision.affected
    ? "No accessibility-affecting change detected."
    : passed
      ? `Accessibility change (${decision.reason}); human review present: ${verdict.how}.`
      : `Accessibility change (${decision.reason}). @${context.repo.owner} must review and merge this pull request. An approving review of head ${pull.head.sha.slice(0, 7)} or the owner-applied "${HUMAN_REVIEWED_LABEL}" label clears this check.`;
  const name = "Accessibility review";
  const { data: existing } = await github.rest.checks.listForRef({
    ...context.repo, ref: pull.head.sha, check_name: name, per_page: 100,
  });
  const external_id = `accessibility-review-pr-${number}`;
  const check = existing.check_runs.find(run => run.name === name && run.external_id === external_id);
  const result = {
    ...context.repo, status: "completed", conclusion: passed ? "success" : "failure",
    output: { title: passed ? "Accessibility review passed" : "Human accessibility review required", summary },
  };
  if (check) await github.rest.checks.update({ ...result, check_run_id: check.id });
  else await github.rest.checks.create({ ...result, name, head_sha: pull.head.sha, external_id });
  core.info(summary);
}
