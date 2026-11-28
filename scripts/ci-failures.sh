#!/usr/bin/env bash
# Prints the failed steps of a pull request's latest CI runs, with the end of each step's log.
#
# Usage: scripts/ci-failures.sh <pr-number>
#
# It works while a run is still going. `gh run view --log-failed` prints nothing
# until the whole run ends, but a job that has failed already has its failed step
# and its log. Needs the GitHub CLI (`gh`), signed in to this repository.

set -euo pipefail

if ! command -v gh >/dev/null; then
  echo "ci-failures.sh needs the GitHub CLI (gh), signed in: https://cli.github.com" >&2
  exit 127
fi
if [[ $# -ne 1 || ! $1 =~ ^[0-9]+$ ]]; then
  echo "usage: scripts/ci-failures.sh <pr-number>" >&2
  exit 2
fi
pr=$1
log_lines=60

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
echo "PR #$pr at ${sha:0:9}"

# The newest run of each workflow, for pull requests only, on the latest commit. The run's
# own list of pull requests is empty in this repository, so it cannot be used to filter.
# Columns: workflow id, run number, run id, name, status, conclusion, attempt, url.
runs=$(gh api "repos/$repo/actions/runs?head_sha=$sha&event=pull_request" --paginate \
  --jq ".workflow_runs[]
        | [.workflow_id, .run_number, .id, .name, .status, (.conclusion // \"-\"), .run_attempt, .html_url] | @tsv" \
  | sort -t$'\t' -k1,1n -k2,2nr | awk -F'\t' '!seen[$1]++')
if [[ -z $runs ]]; then
  echo "No workflow runs for this pull request's latest commit."
  exit 0
fi

found=0
while IFS=$'\t' read -r _ _ run_id name status conclusion attempt url; do
  echo
  echo "== $name: $status/$conclusion, attempt $attempt - $url"

  # Asking for this attempt, not "the latest", so a rerun that starts now cannot mix in.
  # Columns: job id, job name, job url, step number, step name.
  failed=$(gh api "repos/$repo/actions/runs/$run_id/attempts/$attempt/jobs" --paginate \
    --jq '.jobs[] | . as $job | .steps[] | select(.conclusion == "failure")
          | [$job.id, $job.name, $job.html_url, .number, .name] | @tsv')

  while IFS=$'\t' read -r job_id job_name job_url step_number step_name; do
    [[ -n $job_id ]] || continue
    found=1
    echo
    echo "-- job '$job_name', step '$step_name'"
    # A log can be gone or not ready yet. Say so and go on to the next failed step.
    if ! log=$(gh api --allow-escape-sequences "repos/$repo/actions/jobs/$job_id/steps/$step_number/logs"); then
      echo "log not available, see $job_url"
      continue
    fi
    # A log is text from the pull request's own code, so it must not drive the terminal:
    # remove colour codes, then every other control character except tab and newline.
    printf '%s\n' "$log" \
      | sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g; s/^[0-9T:.Z-]+ //' \
      | tr -d '\000-\010\013-\037\177' \
      | tail -n "$log_lines"
  done <<<"$failed"
done <<<"$runs"

if [[ $found -eq 0 ]]; then
  echo
  echo "No failed step so far."
fi
