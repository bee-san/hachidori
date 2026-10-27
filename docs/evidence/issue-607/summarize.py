import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1])]
for name in rows[0]["rows"]:
    print(name)
    for which in ("main", "branch"):
        runs = [row["rows"][name] for row in rows if row["label"].startswith(which)]
        medians = " / ".join(f"{run['median']:.2f}" for run in runs)
        p95 = " / ".join(f"{run['p95']:.1f}" for run in runs)
        print(f"  {which:6} accents={runs[0].get('accents')} n={runs[0]['n']} median={medians} p95={p95}")
