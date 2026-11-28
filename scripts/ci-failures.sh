#!/usr/bin/env bash
# Prints the failed steps of a pull request's CI runs, with the end of each step's log.
#
# Usage: scripts/ci-failures.sh <pr-number> [log-lines]
#
# It works while a run is still going: `gh run view --log-failed` prints nothing
# until the whole run ends, but a job that has failed already has its log and its
# failed step. It reads the runs of the pull request's latest commit only.
# `log-lines` is how many lines to print from the end of each failed step (default 60).
# Needs `gh` signed in to the repository.

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ! $1 =~ ^[0-9]+$ ]]; then
  echo "usage: scripts/ci-failures.sh <pr-number> [log-lines]" >&2
  exit 2
fi
pr=$1
log_lines=${2:-60}

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
echo "PR #$pr at ${sha:0:9}"

# One line per workflow run on this commit: id, name, status, conclusion, attempt, url.
runs=$(gh api "repos/$repo/actions/runs?head_sha=$sha" --paginate \
  --jq '.workflow_runs[] | [.id, .name, .status, (.conclusion // "-"), .run_attempt, .html_url] | @tsv')
if [[ -z $runs ]]; then
  echo "No workflow runs for this commit. A pull request that changes only Markdown gets no CI run."
  exit 0
fi

found=0
while IFS=$'\t' read -r run_id name status conclusion attempt url; do
  echo
  echo "== $name: $status/$conclusion, attempt $attempt - $url"

  # One line per failed step: job id, job name, step name, step start, step end.
  failed=$(gh api "repos/$repo/actions/runs/$run_id/jobs?filter=latest" --paginate \
    --jq '.jobs[] | . as $job | .steps[] | select(.conclusion == "failure")
          | [$job.id, $job.name, .name, .started_at, .completed_at] | @tsv')
  if [[ -z $failed ]]; then
    echo "no failed step"
    continue
  fi

  while IFS=$'\t' read -r job_id job_name step_name started completed; do
    found=1
    echo
    echo "-- job '$job_name', step '$step_name'"
    # Every log line starts with a timestamp. The step's lines are the ones from its
    # start to the "##[error]" line that closes a failed step. The times are whole
    # seconds, so the end time alone would also catch the first lines of the next step.
    gh api --allow-escape-sequences "repos/$repo/actions/jobs/$job_id/logs" \
      | awk -v from="${started%Z}" -v to="${completed%Z}" \
          '{ t = substr($0, 1, 19); if (t >= from && t <= to) print; if (index($0, "##[error]")) exit }' \
      | sed -E 's/^[^ ]+ //; s/\x1b\[[0-9;]*[A-Za-z]//g' \
      | tail -n "$log_lines"
  done <<<"$failed"
done <<<"$runs"

if [[ $found -eq 0 ]]; then
  echo
  echo "No failed step in any run so far."
fi
