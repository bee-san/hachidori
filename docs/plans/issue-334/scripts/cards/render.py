#!/usr/bin/env python3
"""Render the #334 card data into the plan package and issue fragments."""
import os
import re
import sys
from functools import lru_cache

HERE = os.path.dirname(os.path.abspath(__file__))
g = {}
for f in ("cards.py", "cards2.py", "cards3.py"):
    exec(open(os.path.join(HERE, f), encoding="utf-8").read(), g)
CARDS, PHASES, C, L = g["CARDS"], g["PHASES"], g["C"], g["L"]
BY = {c["id"]: c for c in CARDS}
PKG = sys.argv[1]
OUT = sys.argv[2]
PLAN_TREE = "https://github.com/bee-san/hachidori/tree/plan/issue-334/docs/plans/issue-334"
PLAN_BLOB = "https://github.com/bee-san/hachidori/blob/plan/issue-334/docs/plans/issue-334"
DUR = {"S": 1, "M": 3, "L": 7, "XL": 15, "—": 0}
PHASE_NAME = dict(PHASES)


def cell(text):
    return str(text).replace("|", "\\|").replace("\n", " ")


def src_links(c):
    out = []
    for s in c["src"]:
        out.append("original body" if s == "body" else C(s))
    return ", ".join(out)


def branch(c):
    words = re.sub(r"[`\"'()]", "", c["title"]).lower()
    words = re.sub(r"[^a-z0-9]+", "-", words).strip("-").split("-")
    stop = {"the", "a", "and", "of", "in", "into", "as", "its", "own", "for", "to", "not", "with"}
    words = [w for w in words if w and w not in stop][:4]
    return f"theme/{c['id']}-{'-'.join(words)}"


def blocks(cid):
    return [c["id"] for c in CARDS if cid in c["deps"]]


@lru_cache(None)
def finish(cid):
    c = BY[cid]
    return max([finish(d) for d in c["deps"]] or [0]) + DUR[c["size"]]


def start(cid):
    return max([finish(d) for d in BY[cid]["deps"]] or [0])


def deps_text(c):
    return ", ".join(c["deps"]) if c["deps"] else "—"


# ------------------------------------------------------------------ tasks/T-xx.md
def task_md(c):
    lines = [f"# {c['id']} — {c['title']}", ""]
    rows = [
        ("Initial column", c["col"]),
        ("Phase", PHASE_NAME[c["phase"]]),
        ("Owner type", c["owner"]),
        ("Size", c["size"] + ("  (S ≈ 1 day · M ≈ 2–4 days · L ≈ 1–2 weeks)" if c["size"] != "—" else "")),
        ("Repository", c["repo"]),
        ("Blocked by", ", ".join(f"[{d}]({d}.md)" for d in c["deps"]) or "—"),
        ("Blocks", ", ".join(f"[{d}]({d}.md)" for d in blocks(c["id"])) or "—"),
        ("Hotspot locks", ", ".join(f"`lock:{x}`" for x in c["locks"]) or "—"),
        ("Branch", f"`{branch(c)}`" if c["col"] != "Done" else "—"),
        ("Sources", src_links(c) or "—"),
    ]
    lines += ["| Field | Value |", "| --- | --- |"] + [f"| {k} | {cell(v)} |" for k, v in rows] + [""]
    lines += ["## Goal", "", c["goal"], ""]
    if c["files"]:
        lines += ["## Files (ownership boundary)", ""]
        for kind, path, what in c["files"]:
            lines.append(f"- **{kind}** {path}" + (f" — {what}" if what else ""))
        lines.append("")
    if c["steps"]:
        lines += ["## Steps", ""] + [f"- [ ] {s}" for s in c["steps"]] + [""]
    lines += ["## Tests and validation", ""] + [f"- {t}" for t in c["tests"]] + [""]
    lines += ["AGENTS.md validation applies on top (make-fixture + extension-smoke for runtime/renderer changes; chrome-e2e for manifest, content-script or visible popup changes; benchmarks for runtime-speed changes). Report every command and its exact outcome in the PR." if c["repo"] == "hachidori" and c["col"] != "Done" else "", ""]
    lines += ["## Acceptance criteria", ""] + [f"- [ ] {a}" for a in c["accept"]] + [""]
    if c["notes"]:
        lines += ["## Notes", ""] + [f"- {n}" for n in c["notes"]] + [""]
    lines += ["---", "Part of [#334](https://github.com/bee-san/hachidori/issues/334) · [kanban](../kanban.md) · [contract](../renderer-api.md) · [parallel plan](../parallel-plan.md)", ""]
    return "\n".join(x for x in lines if x is not None)


os.makedirs(os.path.join(PKG, "tasks"), exist_ok=True)
for c in CARDS:
    open(os.path.join(PKG, "tasks", f"{c['id']}.md"), "w", encoding="utf-8").write(task_md(c))

# ------------------------------------------------------------------ kanban tables
COLS = ["Done", "Ready", "In progress", "Review", "Backlog"]


def board(link_prefix=None, compact_backlog=True, acceptance=True):
    out = []
    for col in COLS:
        cards = [c for c in CARDS if c["col"] == col]
        out.append(f"#### {col} ({len(cards)})")
        out.append("")
        if not cards:
            what = {"In progress": "Empty. A card moves here when an agent claims it (assignee + `in-progress` label + draft PR).",
                    "Review": "Empty. A card moves here when its PR is ready for review with green CI on the exact head."}[col]
            out += [what, ""]
            continue
        core = [c for c in cards if c["phase"] < 6] if compact_backlog else cards
        back = [c for c in cards if c["phase"] == 6] if compact_backlog else []
        if core:
            head = "| ID | Card | Owner | Blocked by | Size |" + (" Acceptance |" if acceptance else "")
            sep = "| --- | --- | --- | --- | --- |" + (" --- |" if acceptance else "")
            out += [head, sep]
            for c in core:
                idt = f"[{c['id']}]({link_prefix}/{c['id']}.md)" if link_prefix else c["id"]
                row = f"| {idt} | {cell(c['title'])} | {cell(c['owner'])} | {deps_text(c)} | {c['size']} |"
                if acceptance:
                    row += f" {cell(c['short'])} |"
                out.append(row)
            out.append("")
        if back:
            out.append("Backlog: API extensions and the ten community proposals as renderers. Each follows the same contract and gates, and the proposals need bee-san's approval to be included.")
            out.append("")
            out += ["| ID | Card | Owner | Blocked by | Size |", "| --- | --- | --- | --- | --- |"]
            for c in back:
                idt = f"[{c['id']}]({link_prefix}/{c['id']}.md)" if link_prefix else c["id"]
                out.append(f"| {idt} | {cell(c['title'])} | {cell(c['owner'])} | {deps_text(c)} | {c['size']} |")
            out.append("")
    return "\n".join(out)


def mermaid():
    out = ["```mermaid", "flowchart LR"]
    for c in CARDS:
        if c["phase"] == 6:
            continue
        label = c["title"].replace('"', "'").replace("`", "")
        if len(label) > 34:
            label = label[:33] + "…"
        out.append(f'  {c["id"].replace("-", "")}["{c["id"]} {label}"]')
    for c in CARDS:
        if c["phase"] == 6:
            continue
        for d in c["deps"]:
            out.append(f'  {d.replace("-", "")} --> {c["id"].replace("-", "")}')
    out.append("```")
    return "\n".join(out)


def critical_path():
    core = [c["id"] for c in CARDS if c["phase"] < 6]
    end = max(core, key=finish)
    path = [end]
    while BY[path[-1]]["deps"]:
        path.append(max(BY[path[-1]]["deps"], key=finish))
    return list(reversed(path)), finish(end)


def waves():
    core = [c["id"] for c in CARDS if c["phase"] < 6 and c["col"] != "Done"]
    w = {}
    for i in core:
        w.setdefault(start(i), []).append(i)
    return [(k, w[k]) for k in sorted(w)]


path, days = critical_path()
open(os.path.join(OUT, "critical-path.txt"), "w").write(" → ".join(path) + f"\n{days}\n")
open(os.path.join(OUT, "waves.md"), "w", encoding="utf-8").write(
    "\n".join(f"| day {k} | {', '.join(v)} |" for k, v in waves()) + "\n")

kanban = ["# Kanban board", "",
          "Columns follow GitHub Projects: **Backlog → Ready → In progress → Review → Done**. A card is *Ready* when everything in \"Blocked by\" is Done. Size: S ≈ 1 day, M ≈ 2–4 days, L ≈ 1–2 weeks. Full cards: [tasks/](tasks/). How agents claim and ship cards: [parallel-plan.md](parallel-plan.md#5-agent-protocol).", "",
          f"Critical path (sizes as working days, unlimited agents): **{' → '.join(path)}**, about {days} working days.", "",
          board(link_prefix="tasks"), "",
          "## Dependency graph (phases 0–5)", "", mermaid(), ""]
open(os.path.join(PKG, "kanban.md"), "w", encoding="utf-8").write("\n".join(kanban))

# ------------------------------------------------------------------ body fragments
open(os.path.join(OUT, "body-kanban.md"), "w", encoding="utf-8").write(board())


def phase_checklists():
    out = []
    for num, name in PHASES:
        cards = [c for c in CARDS if c["phase"] == num]
        out.append(f"#### {name}")
        out.append("")
        if num == 6:
            out.append("- [ ] " + " · ".join(f"**{c['id']}** {c['title']}" for c in cards))
            out.append("")
            continue
        for c in cards:
            links = [p for (_, p, _) in c["files"] if p.startswith("[")][:3]
            if not links:
                links = [p for (_, p, _) in c["files"]][:2]
            mark = "x" if c["col"] == "Done" else " "
            out.append(f"- [{mark}] **{c['id']}** {c['title']} — " + ", ".join(links))
        out.append("")
    return "\n".join(out)


open(os.path.join(OUT, "body-phases.md"), "w", encoding="utf-8").write(phase_checklists())


# ------------------------------------------------------------------ overflow comments (full cards)
def comment_card(c):
    lines = [f"### {c['id']} — {c['title']}",
             f"**Owner** {c['owner']} · **Size** {c['size']} · **Repo** {c['repo']} · **Blocked by** {deps_text(c)} · **Blocks** {', '.join(blocks(c['id'])) or '—'}"
             + (f" · **Locks** {', '.join('`' + x + '`' for x in c['locks'])}" if c["locks"] else "")
             + (f" · **Branch** `{branch(c)}`" if c["col"] != "Done" else "")
             + (f" · **From** {src_links(c)}" if c["src"] else ""),
             "", c["goal"], ""]
    if c["files"]:
        lines += ["Files: " + "; ".join(f"{k} {p}" + (f" ({w})" if w else "") for k, p, w in c["files"]), ""]
    if c["steps"]:
        lines += [f"- [ ] {s}" for s in c["steps"]] + [""]
    lines += ["Tests: " + "; ".join(c["tests"]), ""]
    lines += ["Acceptance:"] + [f"- [ ] {a}" for a in c["accept"]] + [""]
    if c["notes"]:
        lines += ["Notes: " + " ".join(c["notes"]), ""]
    return "\n".join(lines)


GROUPS = [("1/3", "Phases 0–1 (decisions, contracts, spikes; core seams)", [0, 1]),
          ("2/3", "Phases 2–3 (hachidori-theme-store repository and CI; renderers)", [2, 3]),
          ("3/3", "Phases 4–6 (Settings and Theme Store; vendoring, acceptance, release; backlog)", [4, 5, 6])]
for tag, title, phases in GROUPS:
    body = [f"## #334 plan — task cards {tag}: {title}", "",
            f"Overflow from the issue body, which has the core plan and the kanban board. Every card here is also a file in [{'docs/plans/issue-334/tasks/'}]({PLAN_TREE}/tasks) on branch `plan/issue-334` ([zip](https://github.com/bee-san/hachidori/blob/plan/issue-334/docs/plans/issue-334.zip)). Line links point at `main` and were verified at 7ff01b1. They drift as main moves, so resolve them by symbol name if they no longer match.",
            ""]
    for c in CARDS:
        if c["phase"] in phases:
            body.append(comment_card(c))
    text = "\n".join(body)
    fname = os.path.join(OUT, f"comment-cards-{tag.replace('/', 'of')}.md")
    open(fname, "w", encoding="utf-8").write(text)
    print(fname, len(text))
print("tasks:", len(CARDS), "critical path:", " → ".join(path), days)
