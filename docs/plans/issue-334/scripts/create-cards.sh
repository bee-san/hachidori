#!/usr/bin/env bash
# Bootstrap the #334 kanban on GitHub from docs/plans/issue-334/tasks/*.md.
# Creates labels, one sub-issue per card (T-01…T-79, T-00 is Done and skipped),
# links each as a sub-issue of #334 and adds it to a GitHub Project.
#
# DRY RUN by default: prints every command. Run with APPLY=1 to execute.
# Writes to bee-san/hachidori — run it as the maintainer.
#   APPLY=1 PROJECT_NUMBER=<n> ./create-cards.sh      # PROJECT_NUMBER optional
set -euo pipefail

REPO="bee-san/hachidori"
PARENT=334
PLAN_BLOB="https://github.com/bee-san/hachidori/blob/plan/issue-334/docs/plans/issue-334"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APPLY="${APPLY:-0}"
PROJECT_NUMBER="${PROJECT_NUMBER:-}"

run() {
  if [ "$APPLY" = 1 ]; then "$@"; else printf 'DRY RUN:'; printf ' %q' "$@"; printf '\n'; fi
}

label() { run gh label create "$1" -R "$REPO" --color "$2" --description "$3" --force; }
label theme-store  5319e7 "Issue #334 Theme Store work"
label agent-ready  0e8a16 "All blockers done; an agent may claim it"
label blocked      d93f0b "Waiting on a card in 'Blocked by'"
label in-progress  fbca04 "Claimed by an agent"
label contract     b60205 "Changes the frozen #334 contract (needs bee-san)"
label repo:theme-store  1d76db "Implemented in bee-san/hachidori-theme-store"
for f in content.js render/popup.js render/reader.css render/glossary.js reader-options.js backup-state.js \
         settings.js settings.html settings.css design-preview.js manifest.json benchmark/ audio-content.js anki-content.js; do
  label "lock:$f" c5def5 "Card holding the lock on $f"
done

field() { # field <file> <name>  → value cell of the task table
  sed -n "s/^| $2 | \(.*\) |$/\1/p" "$1" | head -1
}

for file in "$HERE"/tasks/T-*.md; do
  id="$(basename "$file" .md)"
  column="$(field "$file" "Initial column")"
  [ "$column" = "Done" ] && continue
  title="$(head -1 "$file" | sed 's/^# //; s/ — /: /')"
  labels="theme-store"
  [ "$column" = "Ready" ] && labels="$labels,agent-ready" || labels="$labels,blocked"
  [ "$(field "$file" "Repository")" = "hachidori-theme-store" ] && labels="$labels,repo:theme-store"
  for lock in $(field "$file" "Hotspot locks" | grep -o 'lock:[^`]*' || true); do labels="$labels,$lock"; done
  body="$(mktemp)"
  # Relative links (T-11.md, ../kanban.md) become absolute links to the plan branch.
  sed -E "s#\]\((T-[0-9]+)\.md\)#](${PLAN_BLOB}/tasks/\1.md)#g; s#\]\(\.\./([a-z-]+\.md)\)#](${PLAN_BLOB}/\1)#g" "$file" > "$body"
  printf '\n\nPart of #%s. Card file: %s/tasks/%s.md\n' "$PARENT" "$PLAN_BLOB" "$id" >> "$body"
  if [ "$APPLY" = 1 ]; then
    url="$(gh issue create -R "$REPO" --title "$title" --body-file "$body" --label "$labels")"
    number="${url##*/}"
    issue_id="$(gh api "repos/$REPO/issues/$number" --jq .id)"
    gh api --method POST "repos/$REPO/issues/$PARENT/sub_issues" -F sub_issue_id="$issue_id" >/dev/null
    [ -n "$PROJECT_NUMBER" ] && gh project item-add "$PROJECT_NUMBER" --owner bee-san --url "$url" >/dev/null
    echo "$id → $url"
  else
    run gh issue create -R "$REPO" --title "$title" --body-file "$body" --label "$labels"
    echo "DRY RUN: link as sub-issue of #$PARENT; add to project ${PROJECT_NUMBER:-<none>}"
  fi
  rm -f "$body"
done

cat <<'EOF'
Next (in the GitHub UI): create the Project "Theme Store (#334)" if PROJECT_NUMBER was empty
(gh project create --owner bee-san --title "Theme Store (#334)"), rename its Status options to
Backlog / Ready / In progress / Review / Done, add fields Card, Size, Owner type, Phase, Repo,
and enable the built-in workflows (assigned → In progress, PR ready → Review, closed → Done).
EOF
