import { readFileSync } from "node:fs";

const template = readFileSync(new URL("../ISSUE_TEMPLATE/feature_request.md", import.meta.url), "utf8");
const requiredSections = [...template.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
const acknowledgement = template.match(/^- \[ \] (.+)$/m)[1];
const normalise = (text) => text.trim().replace(/\s+/gu, " ").toLowerCase();

function parseIssue(body) {
  const sections = new Map();
  let section;
  let fence;
  let acknowledged = false;
  const text = (body ?? "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?(?:-->|$)/g, "");

  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      } else {
        section?.push(line);
      }
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,2})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) {
      section = undefined;
      if (heading[1] === "##") {
        const name = normalise(heading[2]);
        if (!sections.has(name)) sections.set(name, []);
        section = sections.get(name);
      }
      continue;
    }

    const checkbox = line.match(/^ {0,3}[-*][ \t]+\[([ xX])\][ \t]+(.+?)\s*$/);
    if (checkbox && normalise(checkbox[2]) === normalise(acknowledgement)) {
      acknowledged ||= checkbox[1].toLowerCase() === "x";
    } else {
      section?.push(line);
    }
  }
  return { sections, acknowledged };
}

export function validateIssueBody(body) {
  const { sections, acknowledged } = parseIssue(body);
  const problems = requiredSections
    .filter((heading) => !sections.get(normalise(heading))?.join("\n").trim())
    .map((heading) => `Fill in the "${heading}" section.`);
  if (!acknowledged) problems.push("Check the acknowledgement from the issue template.");
  return problems;
}

export async function enforceIssueTemplate({ github, context }) {
  const parameters = { ...context.repo, issue_number: context.issue.number };
  // Issue events can queue while the author is editing; validate the current body.
  const { data: issue } = await github.rest.issues.get(parameters);
  if (issue.state !== "open") return;

  const problems = validateIssueBody(issue.body);
  if (!problems.length) return;

  const templateUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/main/.github/ISSUE_TEMPLATE/feature_request.md?plain=1`;
  await github.rest.issues.createComment({
    ...parameters,
    body: [
      "Closing this issue because it does not follow the issue template:",
      problems.map((problem) => `- ${problem}`).join("\n"),
      `Please edit this issue using the [issue template](${templateUrl}), complete every section, and check the acknowledgement. Then ask for it to be reopened.`,
    ].join("\n\n"),
  });
  await github.rest.issues.update({ ...parameters, state: "closed", state_reason: "not_planned" });
}
