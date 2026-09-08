import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { enforceIssueTemplate, validateIssueBody } from "../.github/scripts/issue-template.mjs";

const template = readFileSync(new URL("../.github/ISSUE_TEMPLATE/feature_request.md", import.meta.url), "utf8");
const acknowledgement = template.match(/^- \[ \] (.+)$/m)[1];
const answers = {
  "Problem": "I lose my place in a visual novel when checking an unfamiliar word.",
  "Benefit to the creator": "Keeping the current sentence visible would let the creator return to reading immediately.",
  "Proposed solution and alternatives": "Keep the sentence visible in the existing popup; opening a second window interrupts reading.",
};
const complete = Object.entries(answers).map(([heading, answer]) => `## ${heading}\n\n${answer}`).join("\n\n")
  + `\n\n- [x] ${acknowledgement}\n`;
const missingAnswer = (heading) => `Fill in the "${heading}" section.`;

test("completed issues accept normal Markdown answers, CRLF, and uppercase checkbox marks", () => {
  assert.deepEqual(validateIssueBody(complete), []);
  assert.deepEqual(validateIssueBody(complete.replace(/\n/g, "\r\n").replace("[x]", "[X]")), []);
  assert.deepEqual(validateIssueBody(complete.replace(answers.Problem, "```text\nExample from the visual novel.\n```")), []);
});

test("empty bodies and an untouched template cannot satisfy the required answers", () => {
  for (const body of [null, "", template, template.replace("[ ]", "[x]")]) {
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

test("the exact acknowledgement must be checked and does not count as a solution", () => {
  for (const body of [complete.replace("[x]", "[ ]"), complete.replace(acknowledgement, "I have read this issue.")]) {
    assert.deepEqual(validateIssueBody(body), ["Check the acknowledgement from the issue template."]);
  }
  assert.deepEqual(validateIssueBody(complete.replace(answers["Proposed solution and alternatives"], "")),
    [missingAnswer("Proposed solution and alternatives")]);
});

test("quoted templates in comments or code blocks do not supply headings or acknowledgement", () => {
  for (const body of [`<!--\n${complete}\n-->`, `\`\`\`markdown\n${complete}\`\`\``, `~~~~\n${complete}~~~~`]) {
    assert.equal(validateIssueBody(body).length, 4);
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
  const client = issueClient({ state: "open", body: complete.replace(answers["Benefit to the creator"], "") });
  await enforceIssueTemplate(client);
  assert.equal(client.writes.length, 2);
  assert.equal(client.writes[0].action, "comment");
  assert.ok(client.writes[0].body.includes(missingAnswer("Benefit to the creator")));
  assert.ok(client.writes[0].body.includes(".github/ISSUE_TEMPLATE/feature_request.md"));
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
