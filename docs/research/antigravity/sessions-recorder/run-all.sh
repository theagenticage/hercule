#!/usr/bin/env bash
# Usage: run-all.sh <home> <outDir>. Runs every scenario in sequence and prints the summaries.
set -u
home=${1:?home}; out=${2:?outDir}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
for f in "$here"/scenarios/*.ts; do
  bun "$f" "$home" "$out" 2>&1 | tail -n 1
done
