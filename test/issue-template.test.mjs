import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { enforceIssueTemplate, validateIssueBody } from "../.github/scripts/issue-template.mjs";

const template = readFileSync(new URL("../.github/ISSUE_TEMPLATE/feature_request.md", import.meta.url), "utf8");
const answers = {
  "What is your problem?": "I lose my place in a visual novel when checking an unfamiliar word.",
  "Debug log": "Debug info file attached.",
  "Why is it a problem?": "I have to find the sentence again before I can continue reading.",
  "What is your ideal solution?": "Keep the sentence visible while the popup is open.",
};
const requiredHeadings = Object.keys(answers);
const complete = Object.entries(answers).map(([heading, answer]) => `## ${heading}\n\n${answer}`).join("\n\n") + "\n";
const missingAnswer = (heading) => `Fill in the "${heading}" section.`;

test("feature request template omits the opinionated preamble and acknowledgement checkbox", () => {
  assert.doesNotMatch(template, /^Hachidori is \[opinionated\]/m);
  assert.doesNotMatch(template, /^- \[[ xX]\]/m);
});

test("template asks only the four simple questions and explains how to get a debug log", () => {
  const headings = [...template.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, requiredHeadings);
  assert.match(template, /Settings → Advanced → Troubleshooting → Get debug info/);
});

test("completed issues do not require an acknowledgement checkbox", () => {
  const body = Object.entries(answers).map(([heading, answer]) => `## ${heading}\n\n${answer}`).join("\n\n");
  assert.deepEqual(validateIssueBody(body), []);
});

test("completed issues accept normal Markdown answers and CRLF", () => {
  assert.deepEqual(validateIssueBody(complete), []);
  assert.deepEqual(validateIssueBody(complete.replace(/\n/g, "\r\n")), []);
  assert.deepEqual(validateIssueBody(complete.replace(answers["What is your problem?"], "```text\nExample from the visual novel.\n```")), []);
});

test("empty bodies and an untouched template cannot satisfy the required answers", () => {
  for (const body of [null, "", template]) {
    const problems = validateIssueBody(body);
    for (const heading of Object.keys(answers)) assert.ok(problems.includes(missingAnswer(heading)));
  }
});

test("each missing, blank, or comment-only section is reported by name", () => {
  for (const [heading, answer] of Object.entries(answers)) {
    for (const replacement of ["", "   ", "<!-- Please provide a real answer. -->"]) {
      assert.deepEqual(validateIssueBody(complete.replace(answer, replacement)), [missingAnswer(heading)]);
    }
    const withoutHeading = complete.replace(`## ${heading}\n\n${answer}`, answer);
    assert.deepEqual(validateIssueBody(withoutHeading), [missingAnswer(heading)]);
  }
});

test("quoted templates in comments or code blocks do not supply headings", () => {
  for (const body of [`<!--\n${complete}\n-->`, `\`\`\`markdown\n${complete}\`\`\``, `~~~~\n${complete}~~~~`]) {
    assert.equal(validateIssueBody(body).length, requiredHeadings.length);
  }
});

function issueClient(issue, eventIssue = issue) {
  const writes = [];
  const parameters = { owner: "bee-san", repo: "hachidori", issue_number: 123 };
  return {
    writes,
    context: { repo: { owner: parameters.owner, repo: parameters.repo }, issue: { number: parameters.issue_number }, payload: { issue: eventIssue } },
    github: { rest: { issues: {
      get: async (request) => { assert.deepEqual(request, parameters); return { data: issue }; },
      createComment: async (request) => { writes.push({ action: "comment", ...request }); },
      update: async (request) => { writes.push({ action: "update", ...request }); Object.assign(issue, request); },
    } } },
  };
}

test("an incomplete open issue gets a specific explanation and closes as not planned", async () => {
  const client = issueClient({ state: "open", body: complete.replace(answers["Why is it a problem?"], "") });
  await enforceIssueTemplate(client);
  assert.equal(client.writes.length, 2);
  assert.equal(client.writes[0].action, "comment");
  assert.ok(client.writes[0].body.includes(missingAnswer("Why is it a problem?")));
  assert.ok(client.writes[0].body.includes(".github/ISSUE_TEMPLATE/feature_request.md"));
  assert.doesNotMatch(client.writes[0].body, /acknowledgement/i);
  assert.deepEqual(client.writes[1], {
    action: "update", owner: "bee-san", repo: "hachidori", issue_number: 123,
    state: "closed", state_reason: "not_planned",
  });
  await enforceIssueTemplate(client);
  assert.equal(client.writes.length, 2, "a repeated event does not comment on an already closed issue");
});

test("enforcement fetches current text so a corrected issue is kept open despite a stale event", async () => {
  const client = issueClient({ state: "open", body: complete }, { state: "open", body: "" });
  await enforceIssueTemplate(client);
  assert.deepEqual(client.writes, []);
});

test("editing an already closed issue does not post another comment or reopen it", async () => {
  for (const body of ["", complete]) {
    const client = issueClient({ state: "closed", body });
    await enforceIssueTemplate(client);
    assert.deepEqual(client.writes, []);
  }
});
