#!/usr/bin/env bash
# Usage: run-all.sh. Runs every scenario in sequence and prints one summary line per scenario.
# Environment: AGY_BINARY, HARNESS_HOME (a signed-in Harness Home), REC_ROOT (work folders, not under /tmp), OUT_DIR (recordings).
set -u
here=$(cd "$(dirname "$0")" && pwd)
for f in "$here"/scenarios/[a-z]*.ts; do
  echo "== $(basename "$f" .ts)"
  timeout 900 bun "$f" 2>&1 | tail -n 1
done
