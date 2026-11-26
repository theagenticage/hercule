# t12: what agy 1.5.15 does with a PreToolUse hook that fails (Linux)

Setup: as t11 (copy of the pinned binary, `--version` 1.5.15; scratch Harness Home with a 0600 copy of the neon login; fake HOME, private TMPDIR, `SSH_CONNECTION`, `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `env -i`; work folders are git repos under /var/tmp). Model: Gemini 3.8 Flash. Home hook `<home>/config/hooks.json`: `{"h":{"PreToolUse":[{"matcher":"write_file|run_command","hooks":[{"type":"command","command":"..."}]}]}}`. Hook script (rec12/hook.sh) logs START/END ms timestamps, reads stdin, then behaves per case. Driver: recorder/scenarios/t12-run.ts (+ t12-session.ts, a copy of t11-session.ts with the binary path changed), launched by rec12/run.sh.
Per case and mode: one agy process, one session, model set to gemini-3.8-flash, mode set; prompt 1 "Use your write_file tool to create the file hello.txt in the working folder with the content: hi. ..." and prompt 2 "Use your run_command tool to run exactly: echo hi. ..." (both ask the model to repeat the tool result verbatim). My client answers every permission request allow_once and counts them.
Raw logs: /tmp/hercule-1282/rec12/ (`<case>-<mode>.jsonl` ACP recording, `.out` summary, `.hook.log` hook start/end, `agylogs/` agy's own log files, token and email scrubbed: checked, 0 leftovers; scratch folder and token copy deleted; nothing written to homes/neon or ~/.hercule).

Facts that hold for ALL failing cases (1-5), both modes, both tools:
- The tool did NOT run (no hello.txt; no command ran).
- NO permission request was sent (0 in all 20 prompts), also in default mode, where the control asks for both tools. So the hook runs before the permission step and a failed hook ends the call before it.
- The ACP update sequence: `tool_call` (in_progress) then `tool_call_update` status `failed`, 2-20 ms later (hook time excluded). `content[0].text` = `rawOutput` = the error text below. The turn then continues: the model gets the error as the tool result, replies, and the prompt ends `end_turn` (no turn failure, no session error).
- The model quoted it as `Encountered error in tool execution: <text>` (this prefix is the model-visible wrapper; the ACP update carries the text without it).
- The failure is a tool failure the model can see and could retry; nothing stops the model from calling again (not tried further).

## Case 1: hook command is a missing file
Facts:
- Tool ran: no. Request: no. Same in default and accept-edits.
- Text: `JSON hook "jsonhook__h_PreToolUse_0_0" failed: command failed: exit status 127, stderr: sh: 1: /var/tmp/hercule-1282-t12/hook/missing.sh: not found` (agy runs the command through `sh -c`, so a missing path is exit 127 with the shell's stderr in the text).
- Time: failed 2-5 ms after the tool_call.
- agy log: the only case with a log line: `command_hook_executor.go:71] JSON hook command stderr: sh: 1: .../missing.sh: not found` (once per call).
Evidence: rec12/c1-default.*, c1-accept-edits.*, agylogs/c1-*.

## Case 2: exit 1 / exit 2, no output
Facts:
- Tool ran: no. Request: no. Both modes, both exit codes.
- Text: `JSON hook "jsonhook__h_PreToolUse_0_0" failed: command failed: exit status 1, stderr: ` (and `exit status 2`). Exit 2 is NOT special (no "blocking error" meaning as in some other tools): same failure, same text but the number.
- Time: 4-20 ms after the tool_call.
- agy log: nothing about the hook (stderr was empty; the stderr line is logged only when stderr has text, as in case 1).
Evidence: rec12/c2a-*, c2b-*.

## Case 3: prints `not json`, exit 0
Facts:
- Tool ran: no. Request: no. Both modes.
- Text: `failed to unmarshal result from hook jsonhook__h_PreToolUse_0_0 via protojson: not json: proto: syntax error (line 1:1): invalid value not` (the output is parsed as protobuf JSON; the text includes the output itself).
- Time: 5-9 ms.
- agy log: nothing.
Evidence: rec12/c3-*.

## Case 4: prints `{"decision":"deny"}`, no reason, exit 0
Facts:
- Tool ran: no. Request: no. Both modes.
- Text: `tool call denied by pre-tool hook:` (with a trailing colon and the empty reason; with a reason it is `...hook: <reason>`, from earlier research). This is the same text as a normal deny, only the reason is empty.
- Time: 6-15 ms.
- agy log: nothing.
Evidence: rec12/c4-*.

## Case 5: hook sleeps longer than the timeout
Facts:
- agy's default hook timeout is 30 s. `sleep 35`: the tool_call update `failed` came 30006-30009 ms after the tool_call, in default and in accept-edits, for write_file and run_command. `sleep 29`: the hook finished (END logged at +29 s), the tool ran normally (default: 1 request each; accept-edits: write 0, run 1 - same as the control), tool_call completed 29020-29040 ms after the tool_call.
- When the timeout passes: the hook process is killed (my script's END line never appears). Text: `JSON hook "jsonhook__h_PreToolUse_0_0" failed: command failed: signal: killed, stderr: `. Tool did not run, no request, model sees that text, turn ends `end_turn`. Whole prompt took 35-45 s of wall time (30 s hook plus model time).
- A `"timeout": <seconds>` field on the hook entry (next to `type` and `command`) works: `"timeout":3` with `sleep 8` was killed 3002-3004 ms after the tool_call, same text. I did not look for other spellings or a maximum.
- agy log: nothing about the hook.
- No orphaned `sleep` process was left running afterwards (checked with pgrep; the `sh` was killed, and the 35 s sleep was not seen later).
Evidence: rec12/c5-35-default.*, c5-35-accept-edits.*, c5-29-default.*, c5-tf3-default.*. The first c5-35-accept-edits and c5-tf3 runs were started in parallel by mistake and shared one hooks.json (all ran the sleep29 hook); I deleted those and re-ran them alone. The c5-29-default hook log shows sleep29 on both calls, so it is valid.

## Case 6: control, prints nothing, exit 0
Facts:
- default: write_file asked (1 request), run_command asked (1 request); both ran. accept-edits: write_file did not ask (0), run_command asked (1); both ran.
- Model saw: `Created file.` (with Created At / Completed At lines) for write_file; `Command exited with code 0.\n\nCommand output:\nhi` for run_command.
- Hook cost: 1-2 ms of hook time (hook START to END in the hook log). Tool completed 9-14 ms after the tool_call (my client answered requests at once).
Evidence: rec12/c6-*.

## Summary
Every hook failure (missing command, exit 1 or 2, bad output, timeout, empty deny) fails closed: the tool does not run, nothing is asked, the model sees an error text. Only the text differs. Empty stdout with exit 0 is a pass. So a hook that crashes cannot open the gate, and cannot make a request appear either.

## Could not measure / not done
- Only Gemini 3.8 Flash; one account; one binary.
- Valid JSON that has the wrong shape (for example `{"decision":"maybe"}`, or extra keys) was not tried (not asked).
- Whether a hook that exits 0 after writing text to stderr only is logged: not tried.
- How agy behaves with a hook failure inside a subagent, or for MCP tools: not tried.
- Maximum value of the `timeout` field and its unit beyond seconds: only 3 tried.
- The "not logged into Antigravity" warnings seen at startup in some agy logs (e.g. c5-35-default) did not stop the turns; not investigated.
