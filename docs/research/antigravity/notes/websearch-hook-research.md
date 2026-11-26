# Can a home hook make agy's `search_web` ask or deny? (agy 1.5.15, Linux, home neon)
Recordings: /tmp/hercule-1282/rec6/t8-*.jsonl (first line = setup note). Scenario: recorder/scenarios/t8-websearch.ts. Workspace /var/tmp/hercule-1282-work/..., private TMPDIR, hooks file `<home>/config/hooks.json` (absent before, removed after; config dir diff against backup/config-ws6 clean). Prompt: "Use your web search tool to search for: hercule hook test". Hook = `sh script` that appends stdin to a file and prints `{"decision":"X","reason":"hook test X"}`; matcher "search_web".

## Docs (https://antigravity.google/docs/hooks, fetched)
- Locations: workspace `.agents/hooks.json`, global `~/.gemini/config/hooks.json`, plugin. Events SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop. Handler: type "command", command, timeout (default 30 s).
- Matcher: a regex tested on the tool name; ""/"*" = all; `run_command|view_file`; `browser_.*`.
- Tool list includes `search_web` (args `query`, optional `domain`), `read_url_content`, `run_command`, `view_file`, `write_to_file`...
- PreToolUse input fields: toolCall{name,args}, stepIdx, conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName, lastUserInput.
- Decisions: allow, auto_approve, deny, ask ("respects Always Allow"), force_ask ("always prompts, ignoring cached permissions"), deny_unless_prior_grant. Optional reason, overwrite (merged into args), permissionOverrides.
- Exit codes: not documented.

## What the hook receives for search_web (rec6/t8-capture-default.jsonl, hook output file)
{"artifactDirectoryPath":".../brain/<id>","conversationId":"<id>","cwd":"/var/tmp/hercule-1282-work/t8-capture-default","hookEventName":"PreToolUse","lastUserInput":"Use your web search tool to search for: hercule hook test","modelName":"gemini-4-neon-high","stepIdx":2,"toolCall":{"args":{"query":"hercule hook test"},"id":"call_...","name":"search_web"},"transcriptPath":".../transcript_full.jsonl","workspacePaths":["/var/tmp/hercule-1282-work/t8-capture-default"]}
So search_web IS visible, by name, with its query. Real input also has `cwd` and `hookEventName` (not in docs). Same input in full access (t8-capture-full).

## Results (all `default` mode unless noted; every hook ran exactly once)
| hook decision | permission requests | search ran | model said |
|---|---|---|---|
| allow (capture) | 0 | yes | summary of results (t8-capture-default) |
| deny | 0 | NO, tool_call_update status failed | "blocked by a pre-tool hook: `tool call denied by pre-tool hook: hook test deny`" (t8-deny-default) |
| ask | 0 | yes, completed | summary (t8-ask-default) |
| force_ask | 0 | yes, completed | summary (t8-force_ask-default) |
| deny, full access (--dangerously-skip-permissions) | 0 | NO, failed | "denied by pre-tool hook" (t8-deny-full) |
| allow capture, full access | 0 | yes | hook ran, input as above (t8-capture-full) |

Control that ask-type decisions work at all: `force_ask` with matcher run_command, FULL ACCESS, prompt "run echo hi": 1 permission request ("echo hi") even in full access (t8-force_ask-full). Same hook with matcher view_file, default: the read failed (file did not exist) so it proves nothing about reads.

## Conclusions
1. Ask: NO. `ask` and `force_ask` do not make search_web ask (0 requests, search ran). They do work for run_command (even in full access), so the decision is honoured where the tool has a permission step. Inference (not proven): search_web has no permission step to force.
2. Deny: YES, in default and in full access. The tool call fails, the model gets "tool call denied by pre-tool hook: <reason>" and tells the user. The reason string is passed through to the model.
3. A hook sees the tool name (`toolCall.name` = "search_web") and `toolCall.args.query`.
4. Hook runs in full access too (capture-full, deny-full).
5. Caveats: hooks are code in the Harness Home; hook files are read live (trust-research item 1); a workspace `.agents/hooks.json` can also add hooks but cannot undo a deny from the home as far as untested (not tested: two hooks, one allow one deny). Home hooks apply to every session using that home, including another engineer's concurrent run against the same home (lasted seconds here).
