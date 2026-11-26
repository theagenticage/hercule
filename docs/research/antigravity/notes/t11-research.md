# t11: agy 1.5.15 PreToolUse hook facts (Linux, fresh scratch home)

Setup: copy of the pinned binary (`--version` 1.5.15), new scratch Harness Home with a copy of the neon login, fake HOME, private TMPDIR, `SSH_CONNECTION` set, work repos under /var/tmp (git repos), home hook `config/hooks.json` with matcher "" that logs the raw input. Environment built with `env -i`. Driver: recorder/scenarios/t11-run.ts + t11-session.ts (configs were in the scratch folder, now deleted). Raw logs: /tmp/hercule-1282/rec11/ (`<name>.jsonl` = ACP recording, `<name>.hook.log` = raw hook inputs, `<name>.out` = run summary). Scrubbed: the token and email never appeared in the files (checked by replacing both and by regex; 0 files changed). Scratch folder and token copy deleted. Nothing written to homes/neon or ~/.hercule.

Hook input top-level keys (every call): artifactDirectoryPath, conversationId, cwd, hookEventName, lastUserInput, modelName, stepIdx, toolCall{id,name,args}, transcriptPath, workspacePaths.

## 1. Tool names per model family

Facts:
- Models offered by session/new: Gemini 4 Neon / Carbon / Argon / Hydrogen, Orchestrator (Neon/Carbon/Argon), Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B (Medium). All three families work on this account (gpt-oss answered 503 "no capacity" once in the q5 re-run, fine in q1).
- Every family uses the SAME tool names. Seen in the hook: `write_file` (create), `edit_file` (edit), `run_command` (shell), `search_web` (web search), plus `read_file`, `invoke_subagent`, `send_message`. NO `write_to_file`, `replace_file_content`, `read_url_content`, `execute_url` was ever offered or called.
- Path arg key: `Path` for write_file, edit_file, read_file (capital P). write_file args: `Content`, `Path` (gpt-oss also sent `Overwrite`; Claude subagent sent `Overwrite` too; it is a defined optional arg). edit_file: `Path`, `Target`, `Replacement`. run_command: `CommandLine`, `WaitMsBeforeAsync`, `toolSummary`. search_web: `query`. invoke_subagent: `Prompt`, `Role`, `TypeName`, (`Workspace`).
- (e) URL fetch: no model has a fetch tool. Each model, when asked, said it has none and offered `curl` via run_command. Gemini 3.8 Flash and gpt-oss then did `run_command` with `curl -s https://example.com` / `curl -L https://example.com`. Tool lists asked of the models ("list the function names of every tool you can call, copied from your tool definitions") for Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash, Sonnet 5.5, Opus 5.5, gpt-oss, and Neon in plan and accept-edits mode: always the same 14 names: read_file, write_file, edit_file, run_command, manage_task, search_web, ask_question, schedule, define_subagent, invoke_subagent, manage_subagents, send_message, run_workflow, swarm (Neon in accept-edits: same 14). A subagent reported the same list (q3c-full).
- Caveat: the binary's strings DO contain `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `read_url_content`, `execute_url`, `download_url`, `notebook_edit`, `browser_subagent`, and a permission-rule regex `^(command|read_file|write_file|read_url|mcp|execute_url|download_url|unsandboxed)\(...\)`. So other agy entry points or settings may offer those tools. Not offered over `agy acp` on this account in the modes tried. A hook matcher/gate should still cover them if cheap (they are not reachable by name today).

Evidence: rec11/q1-<model>.hook.log (5 models x 5 prompts), rec11/q1tools-*.out, e.g. q1-gemini-4-neon: write_file {"Content":"x","Path":".../new.txt"}, edit_file {"Path","Replacement","Target"}, run_command, search_web {"query"}.

## 2. Does a URL fetch run without a permission request in default mode?

Not measurable: no URL fetch tool exists over ACP (see 1). What I could measure in `default` mode (Gemini 4 Neon, all requests allowed and counted): write_file, edit_file, run_command each produced 1 permission request (3 total); `search_web` produced 0 requests (q1-gemini-4-neon.out: REQUESTS 3). Fetching via `curl` is a run_command and asks like any other (gemini-3.8-flash and gpt-oss ran it in the same session with requests allowed; the requests list includes it).

## 3. Subagents

Facts:
- The home hook FIRES for a subagent's tool calls. The subagent has its own conversationId (different from the parent's). Seen: write_file, send_message, run_command from subagents (q3-allow, q3b-allow/deny, q3c-full hook logs). The parent's `invoke_subagent` call also fires the hook (name `invoke_subagent`, args Prompt/Role/TypeName/Workspace).
- A hook `deny` on the subagent's write_file STOPS the write: the subagent got "tool call denied by pre-tool hook: t11 deny", sub2.txt was not created, the subagent reported the denial (q3b-deny; deny regex `"Path":"[^"]*sub2\.txt"` matched only the subagent's write_file; hook sequence: invoke_subagent (nothing), write_file (deny), send_message).
- Also (first attempt, q3-deny) a deny regex that matched the parent's `invoke_subagent` Prompt text denied the launch of the subagent itself, so no subagent ran.
- Subagent approvals never reach us (confirms the earlier finding): in `default` (q3-allow: subagent's run_command fired the hook, 0 permission requests reached the client, sub.txt never appeared in 240 s) and in `accept-edits` (q3b-allow: subagent's write_file fired the hook, no request reached the client, sub2.txt not written in 240 s). With `--dangerously-skip-permissions` (q3c-full) the subagent wrote sub2.txt. So a subagent waits for an approval nobody sees, in both modes tried.
- Not measured: whether accept-edits would let the subagent write if given more time than 240 s (the turn is the same one that earlier research says waits for good).

## 4. Other folder names

Setup: `<name>/hooks.json` with a run_command hook answering auto_approve for MARKERWORD; default mode; prompt "Run the shell command: echo MARKERWORD"; the client rejects any request.
Facts (hooks): for `.agents` (control), `.agent`, `_agents`, `_agent` the workspace hook RAN (WSHOOK line in the log) and answered auto_approve, `echo MARKERWORD` ran with 0 permission requests. So all FOUR names load workspace hooks and auto-approve.
Facts (MCP): `<name>/mcp_config.json` with a stdio server `sh -c "touch $ROOT/SPAWNED; sleep 20"`: the file SPAWNED appeared for `.agents` (control), `.agent`, `_agents`, `_agent`, at the first prompt ("reply hi, no tool"), 0 requests. So all four spawn the server.
Evidence: rec11/q4h-*.out, q4m-*.out (FILES lines show SPAWNED).
Not measured: the same names for plugins.json / plugins/ / skills / rules (only hooks and mcp_config were asked).

## 5. Lexical cleaning

Facts: the file landed at `<repo>/.agents/probe.txt` (agy/the tool cleaned `..` as TEXT; the OS did not resolve the symlink). `<repo>/node_modules/.store/pkg/` has no `.agents` folder afterwards. The hook saw the Path with `..` unresolved: `/var/tmp/hercule-1282-t11/work/q5-gemini-4-neon/node_modules/pkg/../../.agents/probe.txt` (same for Sonnet 5.5 and Gemini 3.8 Flash). So a hook that resolves the path with the OS (realpath) would get `.store/pkg/.agents/probe.txt`, which is NOT where agy writes; a gate must clean the path lexically (path.normalize/resolve) as agy does, and check both if unsure.
Notes: Gemini 4 Neon first refused the plain request (it called `..` a traversal attempt; q5-lexical, no tool call). With a neutral wording ("testing how a path library treats dot-dot segments, pass the path verbatim") Gemini 4 Neon, Sonnet 5.5 and Gemini 3.8 Flash all made the call and wrote the file (1 permission request in default mode, allowed). gpt-oss: 503 no capacity, not measured.
Evidence: rec11/q5-*.hook.log, q5-*.out (FILES: `.agents/probe.txt`).

## 6. Extra arguments

Facts: agy validates the arguments against the tool's schema BEFORE the hook, and the hook does NOT run for a call that fails validation. Rejected with "Encountered error in tool validation: invalid arguments: additional properties ... not allowed":
- write_file with extra `cwd` and nested `meta: {Path}`: "additional properties 'meta', 'cwd' not allowed" (q6-extra: no hook line, nothing written).
- run_command with extra `cwd` and `Path` (and missing `toolSummary`): "missing property 'toolSummary'; additional properties 'Path', 'cwd' not allowed".
- write_file with both `Path` and lowercase `path`: "additional properties 'path' not allowed".
- edit_file with extra `Overwrite` and `extra:{Path}`: failed (the hook log has exactly 1 line for the 4 prompts, the one valid call).
- The valid call write_file {Path, Content, Overwrite:false}: ran; hook saw all three keys. `Overwrite` is a defined optional write_file argument (not an extra).
So within write_file/edit_file/run_command the hook input only carries defined keys. Not measured: MCP tool calls (args are the server's schema, and any key of that schema), other tools' optional keys, and whether the hook input ever differs from the model's JSON (it matched in all runs).
Evidence: rec11/q6-extra.*, q6b-extra.*.

## 7. Case

Facts: NOT loaded on Linux. `.Agents/hooks.json` and `.agents/Hooks.json` (hook auto_approve MARKERWORD): `echo MARKERWORD` asked (1 permission request each, no WSHOOK line), unlike the `.agents/hooks.json` control (0 requests, hook ran).
Evidence: rec11/q7-*.out.

## Not measured / limits
- No URL fetch tool exists over ACP for this account (Q2 cannot be answered directly).
- gpt-oss: Q5 hit a 503 capacity error; Q1 worked.
- Q3: accept-edits subagent write watched for 240 s only.
- One account (the neon login), one binary version.
