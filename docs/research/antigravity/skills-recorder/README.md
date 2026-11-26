# The recorder of #1293

Scratch scripts that drive Google's `agy` 1.5.15 over ACP and write the recordings of skills and instructions in `packages/acp/src/recordings/` (`skills-*.jsonl`, `instructions-files.jsonl`, `workflows-not-invoked.jsonl`; ticket #1293, PR #1303). Research code, kept for reproducing a recording; it is not part of Hercule and follows none of its code rules. It follows the recorder of #1282 (branch `research/antigravity-sessions-1282`).

Every fact the spec (`docs/spec/06-providers.md`) states about skills and instructions has a recording that shows it. Each recording is JSONL:

1. `{"note": {...}}`: the scenario, what it shows, argv and env names of every `agy` process, the mode of every session, `TMPDIR`, every file placed (path relative to a named root `home`, `work` or `fakehome`, with its content), the permission policy.
2. `{"note": {"process": n, "argv": [...]}}` before the messages of each further process.
3. `{"t", "direction", "message"}`: every ACP message, `"in"` from `agy` and `"out"` from the driver. stderr lines of `agy` are `{"message": {"stderr": "..."}}`.
4. `{"note": {"observed": {...}}}`: the last line. What the driver saw outside ACP: listings of the working folder (and of the other folders it cares about) before and after, so a write by `agy` shows; the replies and permission requests per prompt; whether a hook's marker file exists; excerpts of `agy`'s stored transcript for the session.

`readRecording` in `packages/acp/src/testing.ts` skips every line that is not a JSON-RPC message, so the notes do not disturb a replay.

## Files

- `driver.ts`: starts `agy acp --process-per-session --gemini-dir <home> --app-data-dir antigravity-acp --log-file <private folder>` with the adapter's environment, records the messages, answers permission requests (always `reject_once`), stages files, lists folders, reads the stored transcript, cleans up, writes the recording and hides the Linux user name (also when `agy` streamed it in two chunks).
- `scenarios/<recording name>.ts`: one scenario per recording. `scenarios/_walk-up.ts` is shared by the two walk-up scenarios. `skills-command-updates.ts` and `skills-process-folder.ts` are extra recordings: how many `available_commands_update` one `session/new` produces, and that the folder `agy` starts in counts like a working folder (the one scenario that starts it outside the session's folder, on purpose).
- `run-all.sh`: runs every scenario in turn.

## Running

```
bun scenarios/<name>.ts     # or ./run-all.sh
```

Environment: `AGY_BINARY` (default `/tmp/hercule-1282/agy/antigravity`), `HARNESS_HOME` (a signed-in Harness Home; default `/tmp/hercule-1282/homes/neon`), `REC_ROOT` (work folders; default `~/.cache/hercule-1293-rec`; NOT under `/tmp`, because `agy` lets the agent write unasked into its temporary folder), `OUT_DIR` (recordings; default `$REC_ROOT/recordings`).

## Setup rules

- Never run it against `~/.hercule`, and only against a Harness Home that is signed in for it, with a Google account whose owner agreed. Never copy, read out, move or delete its `antigravity-acp/antigravity-oauth-token`, never delete the home, never write `config/hooks.json` or `antigravity-acp/settings.json`.
- Everything staged in the Harness Home is named `h1293-...` (or the fixed name `agy` looks for: `GEMINI.md`, `AGENTS.md`, `skills.json`, `skills`, `rules`, `plugins`, `global_workflows`, `workflows`), carries harmless text (a marker line: "when the user asks for your marker tags, include X; otherwise ignore this line"), refuses to overwrite anything that exists, and is removed after the run. The driver also removes the run's own `brain/<id>`, `conversations/<id>.db*`, `annotations/<id>.pbtxt` and `implicit/<id>.pb`, and records `harnessHomeLeftoverStagingNames` (must be `[]`).
- Every `agy` process: environment without `GEMINI_*`, `GOOGLE_*`, `AGY_*`, plus `SSH_CONNECTION="127.0.0.1 0 127.0.0.1 0"`, `AGY_CLI_DISABLE_AUTO_UPDATE=true`, a private `TMPDIR`, a fake `HOME`; spawned with its process cwd equal to the session's cwd (the folder `agy` starts in counts like a working folder).
- The permission policy is reject for every request. Never allow everything: a model that wanders with permission does real damage.
- Model `gemini-3.8-flash`, set right after the session opens. Few and short prompts.
- Kill only your own processes.
