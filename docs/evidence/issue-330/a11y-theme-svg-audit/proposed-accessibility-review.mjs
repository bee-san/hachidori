// Accessibility review gate. Mirrors .github/scripts/issue-template.mjs: pure
// decision functions plus one thin GitHub wrapper, so `node --test` can pin
// the rules without a GitHub client.
// SPDX-License-Identifier: GPL-3.0-or-later

export const ACCESSIBILITY_LABEL = "accessibility";
export const HUMAN_REVIEWED_LABEL = "human-reviewed";

// Files whose every change is presentation or interaction the maintainer must
// see rendered: palettes and popup styling, the palette registry, the theme
// resolvers, icon masks, the structured-content image renderer and the
// popup's appearance/preview/keyboard code.
export const ACCESSIBILITY_PATHS = [
  /^extension\/.*\.css$/u,
  /^extension\/reader-options\.js$/u,
  /^extension\/settings-theme\.js$/u,
  /^extension\/settings-dom\.js$/u,
  /^extension\/design-preview\.(?:js|html)$/u,
  /^extension\/render\/glossary\.js$/u,
  /^extension\/render\/popup\.js$/u,
  /^extension\/content\.js$/u,
];

// A diff hunk that touches these tokens changes how something looks, is
// navigated, or is announced, whichever file it lives in.
export const ACCESSIBILITY_PATCH_TOKENS = /(?:aria-[a-z]+|role=|tabindex|\.focus\(|:focus|prefers-color-scheme|prefers-reduced-motion|prefers-contrast|forced-colors|forced-color-adjust|color-scheme|--hoshidicts-palette|--text-color|contrast|font-size|animation|transition|outline|visibility|@keyframes)/iu;

export function affectsAccessibility({ files, labels }) {
  if (labels.includes(ACCESSIBILITY_LABEL)) return { affected: true, reason: `label "${ACCESSIBILITY_LABEL}"` };
  for (const file of files) {
    if (ACCESSIBILITY_PATHS.some((pattern) => pattern.test(file.filename))) {
      return { affected: true, reason: `path ${file.filename}` };
    }
  }
  for (const file of files) {
    // Prose may discuss contrast or focus without changing the product.
    if (/\.(?:md|txt)$/iu.test(file.filename)) continue;
    const added = (file.patch ?? "").split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    const hit = added.find((line) => ACCESSIBILITY_PATCH_TOKENS.test(line));
    if (hit) return { affected: true, reason: `${file.filename} adds ${JSON.stringify(hit.slice(1, 80).trim())}` };
  }
  return { affected: false, reason: null };
}

// The gate passes only on an APPROVED review by the repository owner for the
// exact head commit, or on the `human-reviewed` label, which AGENTS.md forbids
// the agent from adding. The label is the interim path while the agent shares
// the maintainer's GitHub identity (GitHub refuses self-approval).
export function humanApproved({ owner, headSha, reviews, labels }) {
  if (labels.includes(HUMAN_REVIEWED_LABEL)) return { approved: true, how: `label "${HUMAN_REVIEWED_LABEL}"` };
  const review = reviews.find((candidate) => candidate.state === "APPROVED"
    && candidate.user?.login === owner && candidate.commit_id === headSha);
  if (review) return { approved: true, how: `review ${review.html_url}` };
  return { approved: false, how: null };
}

export async function accessibilityReview({ github, context, core }) {
  const pull = context.payload.pull_request;
  const parameters = { ...context.repo, pull_number: pull.number };
  const files = await github.paginate(github.rest.pulls.listFiles, { ...parameters, per_page: 100 });
  const labels = pull.labels.map((label) => label.name);
  const decision = affectsAccessibility({ files, labels });
  if (!decision.affected) {
    core.info("No accessibility-affecting change detected.");
    return;
  }
  if (!labels.includes(ACCESSIBILITY_LABEL)) {
    // A fork's pull_request token cannot write labels; the failing check still gates.
    try {
      await github.rest.issues.addLabels({ ...context.repo, issue_number: pull.number, labels: [ACCESSIBILITY_LABEL] });
    } catch (error) {
      core.warning(`Could not add the ${ACCESSIBILITY_LABEL} label: ${error.message}`);
    }
  }
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...parameters, per_page: 100 });
  const verdict = humanApproved({ owner: context.repo.owner, headSha: pull.head.sha, reviews, labels });
  if (verdict.approved) {
    core.info(`Accessibility-affecting (${decision.reason}); human review present: ${verdict.how}.`);
    return;
  }
  core.setFailed([
    `This pull request affects accessibility (${decision.reason}).`,
    `It must be reviewed and merged by @${context.repo.owner} in the GitHub UI, not by the agent's merge protocol.`,
    `The check turns green after an approving review of ${pull.head.sha.slice(0, 7)} by @${context.repo.owner}`,
    `or after @${context.repo.owner} adds the "${HUMAN_REVIEWED_LABEL}" label.`,
  ].join(" "));
}
