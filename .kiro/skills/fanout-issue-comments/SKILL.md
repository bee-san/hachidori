---
name: fanout-issue-comments
description: Turn every comment on a scratchpad GitHub issue into its own fully-planned issue by spawning one herdr-managed kiro-cli agent per comment, then monitor them to completion. Use when bee-san dumps several ideas as comments on one issue (e.g. "issues10" #330) and wants each promoted to a standalone, template-compliant issue with an implementation plan.
---

# Fan out a scratchpad issue's comments into standalone issues

You are the monitoring agent. You do not write the issues yourself. You spawn
one worker agent per comment, each in its own git worktree and herdr
workspace, then watch them until every one prints `DONE: <url>` and every
resulting issue survives the template bot.

Input: `$ARGUMENTS` — the scratchpad issue URL or number, optionally followed
by overrides such as `--model claude-fable-5.1 --effort max` (defaults below).

## 0. Preconditions (check, do not assume)

```sh
gh auth status                      # must be logged in as the repo owner
herdr status                        # server: running
kiro-cli chat --list-models | grep -i fable   # confirm the model id exists
git -C <clone-on-main> fetch origin && git -C <clone-on-main> pull --ff-only
```

Use a clone that is on `main` with no local changes as the worktree base.
Never use a clone that is mid-feature.

## 1. Read the comments

```sh
gh api repos/bee-san/hachidori/issues/<n> --jq '{title,state,comments}'
gh api repos/bee-san/hachidori/issues/<n>/comments --paginate \
  --jq '.[] | "=== COMMENT \(.id) by \(.user.login) ===\n\(.body)\n"'
```

- Skip comments by `github-actions[bot]` and any comment that is only a
  reaction or "+1".
- Each remaining comment becomes exactly one worker. Give it a short kebab
  slug (`kanji-split-crash`, `theme-store`, …).
- The originating comment URL is
  `https://github.com/bee-san/hachidori/issues/<n>#issuecomment-<id>`.
  Every worker must link it on the first line of its `## Problem`.

## 2. Read the template enforcement before briefing anyone

The bot in `.github/workflows/issue-template.yml` +
`.github/scripts/issue-template.mjs` closes issues that do not follow
`.github/ISSUE_TEMPLATE/feature_request.md`, and re-checks on every edit.
Required headings today: `## Problem`, `## Expected behavior`,
`## Environment`, `## Evidence`, `## Benefit to the creator`,
`## Proposed solution and alternatives`. Read `test/issue-template.test.mjs`
to learn what the checker accepts, and put that knowledge in the brief.

Quality reference: `gh issue view 322` — every code claim cites `path:line`,
every runtime claim was reproduced.

## 3. Write the briefs

Create `/tmp/fanout-<n>/prompts/_common.md` once and one
`/tmp/fanout-<n>/prompts/<slug>.md` per comment. Concatenate them per worker.

`_common.md` MUST contain:

- The mission (one comment → one issue), and that the worker has an
  unlimited token budget and should be exhaustive.
- Hard rules: deliverable is ONE `gh issue create`; no PRs, no code pushes,
  no commits to main; evidence branches only (`evidence/issue-<n>-<slug>`,
  screenshots under `docs/evidence/issue-<n>/<slug>/`, linked via
  `raw.githubusercontent.com`).
- The template-bot rule: read the workflow, script, template and test first;
  fill every heading; delete HTML comment placeholders; "Not applicable" needs
  a sentence of justification; after creating, sleep ~90 s, then
  `gh issue view <k> --json state,comments`; if closed, `gh issue edit`,
  `gh issue reopen`, re-verify, loop until it sticks.
- A mandatory `## Implementation plan` section after the template sections:
  phased steps naming files/functions, tests with paths and assertions,
  acceptance-criteria checklist, risks/open questions/out-of-scope, S/M/L/XL
  per phase.
- Title rules (< 80 chars, no prefix), label list (run
  `gh api repos/bee-san/hachidori/labels --jq '.[].name'`), inclusive
  language, write body to `ISSUE_BODY.md` first and never `git add` it.
- Finish protocol: print exactly `DONE: <issue url>` or
  `BLOCKED: <reason>` as the final line, and nothing else that matches.

Each `<slug>.md` MUST contain: the comment URL, the comment quoted verbatim,
the intended labels, and a numbered "mandatory investigation" list that is
specific to that comment (which files to read, what to reproduce, what to
compare against — Yomitan, Nazeka, Rikaikun, asbplayer, etc. — what
screenshots to take). Be prescriptive; vague briefs produce vague issues.
When a comment asks for a fix ("fix this error"), the deliverable is still an
issue: require root cause, history of earlier attempts (`git log -S`,
`gh pr list --search`), a failing reproduction pasted verbatim, and the plan.

## 4. Spawn

One worktree + one herdr workspace + one agent per slug:

```sh
BASE=<clone-on-main>; N=<n>; P=/tmp/fanout-$N/prompts
for slug in <slugs>; do
  cat "$P/_common.md" "$P/$slug.md" > "$P/$slug.full.md"
  wt=$(herdr worktree create --cwd "$BASE" --branch "issue$N/$slug" \
        --base origin/main --label "$N:$slug" --no-focus --json)
  ws=$(echo "$wt" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["workspace"]["workspace_id"])')
  path=$(echo "$wt" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["worktree"]["path"])')
  herdr agent start "$N-$slug" --workspace "$ws" --cwd "$path" --no-focus -- \
    kiro-cli chat --agent yolo --model claude-fable-5.1 --effort max \
      --trust-all-tools "$(cat "$P/$slug.full.md")"
done
```

Defaults: `--model claude-fable-5.1 --effort max` ("fable max 5.1"). The
`yolo` agent config denies `git push` to main and other destructive commands
but allows pushing feature/evidence branches.

`--trust-all-tools` shows an interactive acceptance prompt. About 20 s after
spawning, read each pane; if it shows "Yes, I accept", send Down then Enter:

```sh
herdr agent send "$N-$slug" $'\x1b[B'; sleep 0.3; herdr agent send "$N-$slug" $'\r'
```

Confirm each pane then shows `Kiro is working` and the status line reads
`yolo · claude-fable-5.1 · max`.

## 5. Monitor (this is your whole job until they finish)

Poll every 3–5 minutes. For each worker:

```sh
herdr agent list                                  # agent_status per worker
herdr agent read "$N-$slug" --lines 40            # tail of the pane
herdr agent wait "$N-$slug" --status idle --timeout 300000
```

Intervene, do not just watch:

- Pane shows a permission/confirmation prompt → answer it with
  `herdr agent send`.
- Worker went `idle` without printing `DONE:`/`BLOCKED:` → read the tail;
  if it stopped to ask a question, answer via
  `herdr agent send "$N-$slug" "<answer>"` then `herdr agent send "$N-$slug" $'\r'`.
  If it summarised and stopped early, send: "You have not printed DONE. Verify
  the issue is still open after the bot check, then print DONE: <url>."
- Worker printed `BLOCKED:` → read why; unblock if you can (download a
  dictionary for it, give it a path, answer a question) and resend; escalate
  to the user only if the blocker is genuinely external.
- Worker is thrashing on the same error → send a one-line redirect.
- Worker is about to do something outside its remit (opening a PR, pushing to
  main, editing another worktree) → send "Stop. The deliverable is the issue
  only." immediately.

Keep a ledger in `/tmp/fanout-<n>/ledger.md`: slug, workspace id, status,
issue URL, last-seen problem. Update it on every poll.

## 6. Verify independently — do not trust `DONE:`

For every reported URL:

```sh
gh issue view <k> --json state,title,labels,body,comments \
  --jq '{state,title,labels:[.labels[].name],bot:[.comments[]|select(.author.login=="github-actions")|.body[0:80]],len:(.body|length)}'
```

Check: state is OPEN; no bot comment; body contains all six template
headings plus `## Implementation plan`; first `## Problem` line links the
originating comment; labels applied; embedded evidence URLs return 200
(`curl -sI <raw url> | head -1`). Spot-read each body for `path:line`
citations. If anything is off, send the worker a precise correction and wait
again; do not fix the issue body yourself unless the worker has died.

## 7. Close out

- Comment on the scratchpad issue with a checklist mapping each comment to
  its new issue:
  ```sh
  gh issue comment <n> --body-file /tmp/fanout-<n>/summary.md
  ```
- Remove worktrees whose worker has finished and whose branch has nothing
  pushed: `herdr worktree remove --workspace <ws>` (evidence branches stay).
- Report to the user: one line per issue (URL + title), any that are BLOCKED
  and why, and anything that needs bee-san's human review (accessibility
  issues must not auto-merge — say so explicitly).

## Notes

- One comment can legitimately become one issue that covers several
  deliverables (e.g. a CSS fix + an AGENTS.md policy + a screenshot audit).
  Do not split a comment into multiple issues unless the user asks.
- Evidence hosting: `gh` cannot upload images; the `evidence/…` branch +
  raw URL pattern is the only supported route. Workers must push nothing else
  on those branches.
- If a worker needs a Yomitan dictionary, it may download one into a temp
  dir; it must not commit dictionary data.
