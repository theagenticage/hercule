"""Summarizes the result rows `bench.ts` wrote.

Usage: python3 -I summarize.py <results.jsonl>... [--json out.json]

Prints one table per harness and model: a row per arm with how many runs
passed and the median of each measure, then the same split per task. With
`--json`, also writes the numbers to a file for the charts.

A later row for the same (harness, model, arm, task, rep) replaces an earlier
one, so a task that was run again after a fix to its check counts once.
"""

import json
import statistics
import sys

args = sys.argv[1:]
out = None
if "--json" in args:
    at = args.index("--json")
    out = args[at + 1]
    del args[at : at + 2]

rows = {}
for path in args:
    for line in open(path):
        if not line.strip():
            continue
        row = json.loads(line)
        row.setdefault("harness", "claude")
        rows[(row["harness"], row["model"], row["arm"], row["task"], row["rep"])] = row
rows = list(rows.values())

# The two number tasks were first checked too strictly: a reply that showed its
# sum before the answer failed. Grade them again from the stored reply, by its
# last number, which is what `bench.ts` does now.
import re

EXPECTED = {"count": "3", "aggregate": "7"}
for row in rows:
    if row["task"] in EXPECTED:
        numbers = re.findall(r"\d+", row["reply"])
        row["pass"] = bool(numbers) and numbers[-1] == EXPECTED[row["task"]]

MEASURES = [
    ("requests", "requests"),
    ("firstContext", "first ctx"),
    ("inputTotal", "input tok"),
    ("outputTotal", "output tok"),
    ("toolCalls", "tool calls"),
    ("lookupCalls", "lookups"),
    ("toolErrors", "tool errs"),
    ("wallMs", "wall ms"),
]


def median(values):
    return statistics.median(values) if values else 0


def summarize(group):
    return {
        "n": len(group),
        "passed": sum(1 for row in group if row["pass"]),
        **{key: median([row[key] for row in group]) for key, _ in MEASURES},
        "costUsd": median([row["costUsd"] for row in group]),
    }


def print_table(title, keyed):
    print(f"\n{title}")
    header = f"{'':24}{'pass':>8}" + "".join(f"{label:>12}" for _, label in MEASURES)
    print(header)
    for name, group in keyed:
        s = summarize(group)
        print(
            f"{name:24}{str(s['passed']) + '/' + str(s['n']):>8}"
            + "".join(f"{s[key]:>12.0f}" for key, _ in MEASURES)
        )


result = {}
for harness, model in sorted({(row["harness"], row["model"]) for row in rows}):
    mine = [row for row in rows if row["harness"] == harness and row["model"] == model]
    arms = sorted({row["arm"] for row in mine})
    tasks = sorted({row["task"] for row in mine})
    print_table(
        f"== {harness} / {model}: every task",
        [(arm, [row for row in mine if row["arm"] == arm]) for arm in arms],
    )
    for task in tasks:
        print_table(
            f"-- {harness} / {model}: {task}",
            [(arm, [row for row in mine if row["arm"] == arm and row["task"] == task]) for arm in arms],
        )
    failures = [row for row in mine if not row["pass"]]
    if failures:
        print(f"\nfailures in {harness} / {model}:")
        for row in failures:
            print(f"  {row['arm']:11} {row['task']:11} #{row['rep']}: {row['why'][:200]}")
    result[f"{harness}/{model}"] = {
        "arms": {arm: summarize([row for row in mine if row["arm"] == arm]) for arm in arms},
        "tasks": {
            task: {
                arm: summarize([row for row in mine if row["arm"] == arm and row["task"] == task])
                for arm in arms
            }
            for task in tasks
        },
    }

if out is not None:
    json.dump(result, open(out, "w"), indent=1)
