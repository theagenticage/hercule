#!/usr/bin/env bash
# Captures what the Amp CLI really prints, for docs/research/amp-orbs.md section 11.
#
# It makes a handful of small Amp threads in a throwaway Git repository and
# saves each stream to a file, so the event mapping of an Amp harness can be
# written against real lines instead of the documented ones.
#
# Before running: install the Amp CLI and sign in (`amp login`). Every thread
# is created private and is listed at the end, so it can be deleted.
# It costs a little Amp inference. It starts no orb.
#
# Usage:
#   capture-streams.sh local    # tier 1: turns in the local CLI
#   capture-streams.sh runner   # tier 2: the same account's runner as the remote executor
#
# The captures go to ./amp-captures/ in the folder the script is started from.
# Read them before sharing them: they hold what the agent read and wrote in
# the throwaway repository, and nothing else.
set -u

tier="${1:-}"
case "$tier" in local | runner) ;; *)
  echo "usage: $0 local|runner" >&2
  exit 2
  ;;
esac
command -v amp >/dev/null || {
  echo "The Amp CLI is not on PATH. Install it and run 'amp login' first." >&2
  exit 2
}

out="$PWD/amp-captures"
mkdir -p "$out"
repo="$(mktemp -d "${TMPDIR:-/tmp}/amp-capture-repo.XXXXXX")"
threads="$out/threads.txt"
: >"$threads"
common=(--visibility private --no-archive-after-execute)

git -C "$repo" init -q
printf '# Capture repository\n\nOne line.\nTwo lines.\n' >"$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" -c user.name=capture -c user.email=capture@example.invalid commit -q -m "start"

# Prints the thread id a capture names, read from its first line that has one.
read_thread_id() {
  python3 -I -c '
import json, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        row = json.loads(line)
    except ValueError:
        continue
    if isinstance(row, dict) and row.get("session_id"):
        print(row["session_id"])
        break
' "$1"
}

# Runs one amp command in the repository. Saves stdout, stderr, the exit status
# and the seconds it took under the given name. Stdin is whatever the caller gave.
capture() {
  local name="$1"
  shift
  local started=$SECONDS
  echo "== $name: amp $*"
  (cd "$repo" && amp "$@") >"$out/$name.jsonl" 2>"$out/$name.stderr"
  echo "exit=$? seconds=$((SECONDS - started))" >"$out/$name.status"
  cat "$out/$name.status"
  local id
  id="$(read_thread_id "$out/$name.jsonl")"
  [ -n "$id" ] && echo "$name $id" >>"$threads"
}

if [ "$tier" = local ]; then
  capture 01-plain -x "Reply with the word ok and nothing else." \
    --stream-json --stream-json-thinking "${common[@]}" </dev/null

  # A command and a file edit, with Amp's default permissions. Whether this is
  # refused, asked about or allowed without a terminal is one of the questions.
  capture 02-tools-default -x "Create a file notes.txt that holds the word hello, then run 'ls -la' and tell me what you see." \
    --stream-json "${common[@]}" </dev/null

  capture 03-tools-allow-all -x "Append a third line to README.md, then run 'git status --short' and show its output." \
    --stream-json --dangerously-allow-all "${common[@]}" </dev/null

  capture 04-subagent -x "Use a subagent to count the lines of README.md, and report only the number." \
    --stream-json --dangerously-allow-all "${common[@]}" </dev/null

  first="$(read_thread_id "$out/01-plain.jsonl")"
  if [ -n "$first" ]; then
    (cd "$repo" && amp threads continue "$first" -x "Which word did you reply with before?" --stream-json) \
      >"$out/05-continue.jsonl" 2>"$out/05-continue.stderr" </dev/null
    echo "exit=$?" >"$out/05-continue.status"
    (cd "$repo" && amp threads export "$first") >"$out/06-export.json" 2>"$out/06-export.stderr" </dev/null
    (cd "$repo" && amp threads usage "$first") >"$out/07-usage.txt" 2>&1 </dev/null
  else
    echo "No thread id in 01-plain.jsonl, so the continue, export and usage captures were skipped." >&2
  fi

  # Two messages on stdin: a task, and eight seconds later a steer. Stdin is
  # then held open for a minute, because closing it may end the process.
  {
    printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Run the command: sleep 20. Then reply with the word first."}]}}'
    sleep 8
    printf '%s\n' '{"type":"user","steer":true,"message":{"role":"user","content":[{"type":"text","text":"Change of plan: reply with the word steered instead."}]}}'
    sleep 60
  } | capture 08-steer -x --stream-json --stream-json-input --dangerously-allow-all "${common[@]}"

  capture 09-bad-mode -x "Reply with ok." --stream-json --mode no-such-mode "${common[@]}" </dev/null
fi

if [ "$tier" = runner ]; then
  runner_id="hercule-capture-$$"
  (cd "$repo" && exec amp --no-tui --runner-id "$runner_id") >"$out/runner.log" 2>&1 </dev/null &
  runner_pid=$!
  trap 'kill "$runner_pid" 2>/dev/null' EXIT
  echo "Started a runner as $runner_id (pid $runner_pid); waiting 15 seconds for it to register."
  sleep 15

  capture 11-runner-plain -x "Print the working directory with pwd and reply with it." \
    --stream-json --executor "runner:$runner_id" "${common[@]}" </dev/null

  # Does a turn outlive the process that streams it? Start a turn that takes a
  # minute, stop only the streaming process after 15 seconds, then look for
  # the file the turn writes at its end.
  (cd "$repo" && exec amp -x "Run the command: sleep 45. Then create a file survived.txt that holds the word yes." \
    --stream-json --executor "runner:$runner_id" "${common[@]}") \
    >"$out/12-runner-killed.jsonl" 2>"$out/12-runner-killed.stderr" </dev/null &
  stream_pid=$!
  sleep 15
  kill "$stream_pid" 2>/dev/null
  wait "$stream_pid" 2>/dev/null
  echo "Stopped the streaming process; waiting 60 seconds for the turn to end on the runner."
  sleep 60
  if [ -f "$repo/survived.txt" ]; then
    echo "turn survived: survived.txt exists" | tee "$out/12-runner-killed.status"
  else
    echo "turn did not finish: no survived.txt" | tee "$out/12-runner-killed.status"
  fi
  killed="$(read_thread_id "$out/12-runner-killed.jsonl")"
  if [ -n "$killed" ]; then
    echo "12-runner-killed $killed" >>"$threads"
    (cd "$repo" && amp threads export "$killed") >"$out/13-runner-killed-export.json" 2>"$out/13-runner-killed-export.stderr" </dev/null
    # A follow-up on a thread that runs remotely. -ox is how the docs say a
    # message reaches a thread's own remote executor.
    (cd "$repo" && amp threads continue "$killed" -ox "Does survived.txt exist? Answer yes or no." --stream-json) \
      >"$out/14-runner-continue.jsonl" 2>"$out/14-runner-continue.stderr" </dev/null
    echo "exit=$?" >"$out/14-runner-continue.status"
  fi

  kill "$runner_pid" 2>/dev/null
  wait "$runner_pid" 2>/dev/null
  trap - EXIT
fi

echo
echo "Captures are in $out"
echo "Threads made (name, id), all private. Delete each with: amp threads delete <id>"
cat "$threads"
echo "The throwaway repository is $repo; delete it when you are done."
