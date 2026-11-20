"""Collects the result rows of several `bench.ts` runs into one file to keep.

Usage: python3 -I collect.py <out.jsonl> <results.jsonl>...

A later row for the same (harness, model, arm, task, rep) replaces an earlier
one, as in `summarize.py`. The reply is cut to 400 characters and each recorded
call to 200, so the file stays small; the measures are kept whole.
"""

import json
import re
import sys

EXPECTED = {"count": "3", "aggregate": "7"}

out, *paths = sys.argv[1:]
rows = {}
for path in paths:
    for line in open(path):
        if not line.strip():
            continue
        row = json.loads(line)
        row.setdefault("harness", "claude")
        # The two number tasks were first checked too strictly; grade them by
        # the last number in the reply, as `bench.ts` does now.
        if row["task"] in EXPECTED:
            numbers = re.findall(r"\d+", row["reply"])
            row["pass"] = bool(numbers) and numbers[-1] == EXPECTED[row["task"]]
            row["why"] = "" if row["pass"] else row["why"]
        row["reply"] = row["reply"][:400]
        row["calls"] = [call[:200] for call in row["calls"]]
        rows[(row["harness"], row["model"], row["arm"], row["task"], row["rep"])] = row
with open(out, "w") as file:
    for key in sorted(rows):
        file.write(json.dumps(rows[key]) + "\n")
print(len(rows), "rows")
