# Antigravity (`agy`) session files, steering and failed turns: research for #1283

Evidence behind the design of #1283 (Hercule reads `agy`'s own session files). Everything here was recorded on 2026-11-26 on a Linux x64 test machine with `agy` 1.5.15, with the model `gemini-4-neon-high`, one Google account.

Layout:

- `recordings/<scenario>.jsonl`: the ACP recording. The first line is a setup note, then one `{ t, direction, message }` object per JSON-RPC message, and the recorder's own notes (`message.note`, direction `out`). `t` is milliseconds since the recorder started. The copies in `packages/acp/src/recordings/` have a first line in the shape of the earlier recordings; here it is as the recorder wrote it.
- `recordings/<scenario>.files.jsonl`: the file watch, on the same clock. The recorder polled the `.system_generated` folder of the conversation, and of every subagent found in `subagents/*.json`, every 100 ms, and wrote one line per change: `{ t, path, event: created | grew | rewritten | deleted, size, newLines? }`. So a `t` here has up to 100 ms of delay compared with the moment `agy` wrote the file.
- `recordings/<scenario>.brain/<conversation id>/`: the final `.system_generated` tree of every conversation of the scenario (`logs/`, `messages/`, `steps/`, `subagents/`, `tasks/`). Strings of 200+ characters without spaces were replaced with `<long>` by the recorder.
- `recordings/<scenario>.hook.log` (`subagent-approval-watch`, `subagent-read-outside`, `subagent-mcp-accept-edits`): what the logging pre-tool hook received (epoch ms, then the raw hook input). Recording `t` = epoch ms - the "recorder started at epoch ms" of the recorder's own note (`subagent-approval-watch` 1795727553786, `subagent-read-outside` 1795732142309, `subagent-mcp-accept-edits` 1795732259353).
- `recordings/subagent-mcp-accept-edits.mcp.jsonl`: what the MCP stand-in server (`recorder/mcp-lib.ts`) received, one line per HTTP request, with its epoch ms in `t`.
- `recorder/`: the scripts. `lib1283.ts`, `mcp-lib.ts` and `scenarios/s1` to `s7` are the 2026-11-26 additions to the recorder of #1282 (`research/antigravity-sessions-1282`, `docs/research/antigravity/sessions-recorder/`), which holds `agy-session.ts`, `proxy.ts` and the rest. `timeline.ts` prints a recording, `files.ts` prints a file watch, `tok.ts` runs the token check, `steps.ts` and `payload.ts` read a conversation database (read-only, on a copy), `bin-grep.ts`, `bin-ctx.ts` and `bin-bytes.ts` search the `agy` binary, `hook.sh`, `hook-ro.sh` and `hook-mcp.sh` are the logging hooks of `s5`, `s6` and `s7`.
- Reading a path like `/tmp/hercule-1283/...` in a file: that was the scratch folder of the run. `agy` workspaces were under `/var/tmp/hercule-1283-work/` (not under `/tmp`, where `agy` writes without asking).

Scrubbed before publishing: the machine's user name (`<user>`), host name (`<host>`) and non-loopback IP addresses (`<ip>`); nothing needed replacing in these files (the two scenarios added later included), a search for them found none. No string of 80 or more characters without spaces is left except file paths. No `ya29.` token is present. No OAuth token or email address is present. The `oauth-personal` and `api-key` words are names of sign-in methods in the `initialize` reply.

In the `recordings/` copies the conversation ids are the real ones. `<id8>` below means the first eight characters.

## Scenarios

| Scenario | Mode | What it asked | Conversations (root; children) |
|---|---|---|---|
| `subagent-full` | full access | "Use invoke_subagent to start one subagent with the Role 'File Writer'. Its task: run `echo SUBMARK > sub.txt`, then report back. When it has reported back, reply DONE." | `86a5c11a`; `e4553827` |
| `steer-visible` | full access | Prompt 1: "Run `sleep 12`, then reply ALPHA." Prompt 2, sent 2 s after the command started and without waiting for prompt 1's reply: "Also, at the very end of your reply, add the single word BRAVO." | `ebb87d3d` |
| `steer-during-request` | approval required | Prompt 1: "Run `echo REQMARK > req.txt`." The permission request is left open; prompt 2 ("Also reply with the word BRAVO.") is sent while it is open; 3 s later the request is allowed. | `a34a3bc9` |
| `failed-turn-network-watch` | full access, behind the recorder's proxy | Read `one.txt`, `two.txt`, `three.txt` one by one and summarise. The proxy is cut at the first tool call. The recorder then kept `agy` running (60 s) with the watch on. | `477ee040` |
| `subagent-approval-watch` | approval required, logging pre-tool hook | "Use a subagent for this: the subagent must run `echo hi > sub.txt` with its command tool, and then write `sub2.txt` containing hi with its file tool. Say DONE when finished." `session/cancel` is sent 70 s after the child's last transcript line. | `d88dcaa6`; `53814e0e` |
| `subagent-read-outside` | approval required, logging pre-tool hook | "Use invoke_subagent to start one subagent with the Role 'Reader'. Its task: read the file /var/tmp/hercule-1283-outside/note.txt with its read_file tool and report the file's content back to you. When it has reported, reply with that content." The file is outside the workspace. No cancel. | `ac0e56eb`; `c0c1ec17` |
| `subagent-mcp-accept-edits` | accept-edits (set with `session/set_mode`), logging pre-tool hook, one MCP server `tools` (a stand-in at 127.0.0.1) | "Use invoke_subagent to start one subagent with the Role 'Caller'. Its task: call the MCP tool whoami once and report what it returned. When it has reported, reply with that." `session/cancel` is sent 90 s after the child's last transcript line. | `f45f3f94`; `6244eb0f` |

## Questions

1. Does `agy` write its session files live, and in what way (append, rewrite)?
2. When does a subagent show up in the files, and what does its link file say?
3. How does a subagent's turn end in its transcript?
4. Are the token fields in the transcript the same numbers as the usage `agy` gives over ACP?
5. What does `agy` do with a prompt sent while a turn runs (steering), and how does the sender see it?
6. What does `agy` do with a prompt sent while a permission request is open?
7. How does a turn that ends on a provider error look, over ACP and in the files?
8. What happens in a subagent whose command needs an approval, and what does the hook see?
9. What happens when a subagent reads a file outside the workspace, in a mode that asks?
10. What happens when a subagent calls an MCP tool in accept-edits mode?
11. How does `agy` write the notice of a failed turn?

## Findings

Times are recording `t` in ms. "File" times come from the watch and may be up to 100 ms late.

### 1. Files are appended live, one complete line per finished step, and not rewritten (`subagent-full`, all five)

- In every scenario the transcript files only `created` once and then `grew`. No `.jsonl` was ever `rewritten`, and no watch line saw a partial last line. Each `newLines` holds whole JSON lines.
- The root transcript of `subagent-full`: step 0 (`USER_INPUT`) at t=2597, step 1 (`PLANNER_RESPONSE`, the `invoke_subagent` call) at 9012, step 2 (`GENERIC`, the tool result) at 10015, step 3 at 13824, step 5 (`DONE`) at 29298. A line appears when its step is done: step 1 is written about 65 ms after the ACP `tool_call` for it started (8947), and the result (step 2) about 70 ms after the `tool_call_update` `completed` (9948).
- The files lag the ACP messages by 0 to 100 ms. The last agent text of `subagent-full` (`DONE`) arrived over ACP at 29218 and its `PLANNER_RESPONSE` line was seen at 29298. In `steer-visible`, the reply of prompt 2 is at 41394 and the last transcript line at 41473. In `steer-during-request` the reply is at 24236 and the last line at 24296. In `subagent-approval-watch` the ACP text is at 15554 and the line at 15607. So when a prompt reply arrives, the transcript can still lack the last step for a moment (the watch cannot tell below its 100 ms step).
- A step is not updated afterwards. In `steer-visible`, step 2 (the `sleep 12`, sent to the background) stays `RUNNING` in the file. The end of the task came as a message file (`messages/6a6b382a...json`, sender `<root>/task-2`, t=19275) and as a later `SYSTEM_MESSAGE` step (step 5, t=36651).
- Only `messages/read.json` was ever `rewritten` (`steer-visible`, t=36651: a second id added). `messages/undelivered/<id>` is an empty marker file, created with the message and deleted when it was delivered.

### 2. A subagent shows up about one second after the parent's `invoke_subagent` starts; `state` never changes

- `subagent-full`: `tool_call` `in_progress` at 8947, `completed` at 9948, `subagents/e4553827....json` created at 10015 (1068 ms after the call started, 67 ms after it completed), then the child's launch message `messages/f9780bc4....json` and the first line of the child's transcript, both at 10115 (100 ms later).
- `subagent-approval-watch`: call at 7293, completed at 8426, link file at 8469, child launch message and transcript at 8569. Same pattern.
- The link file is `{"conversationId", "subagentDescriptor": {"typeName", "role"}, "state", "spawnStepIndex", "workspaceUris"}`. `state` is `SUBAGENT_STATE_ALIVE` at creation and the file is never rewritten, not even after the child had finished (`subagent-full`, child's last line at 30801) or after the cancel in `subagent-approval-watch`. So `state` says nothing about progress.
- The child's launch message: sender is the parent's conversation id, `renderDetails.messageTitle` is "Message from Parent Agent", `content` is the prompt of the `invoke_subagent` call. The first step of the child's transcript is a `SYSTEM_MESSAGE` that carries it.
- The child's report to the parent is the child's `send_message` tool call (child step 3, file t=24183). The message file in the parent's folder (`messages/c48c8f8a....json`, sender is the child's id) appears at 25185, together with a `SYSTEM_MESSAGE` step in the parent (step 4) and one in the child (step 5). The write of the message file is about a second after the child's step, so the watch can see the call before the message.
- The parent's turn can end before the child's last step: the ACP reply of `subagent-full` is at 30798, the child's last line at 30801.

### 3. A subagent's turn ends at a `PLANNER_RESPONSE` with no tool calls (`subagent-full`)

- The child's steps: 0 `SYSTEM_MESSAGE`, 1 `PLANNER_RESPONSE` (`run_command`), 2 `GENERIC` (result), 3 `PLANNER_RESPONSE` (`send_message`), 4 `GENERIC`, 5 `SYSTEM_MESSAGE`, 6 `PLANNER_RESPONSE` ("Done. Reported completion to the parent agent.", no tool calls, t=30801). Step 3 has a tool call, so it does not end the turn: the child goes on after reporting.
- This is the same rule as `turnEnded` in `agy`'s own monitor (see "agy's own reader of these files"). That code also says the results of a batch of tool calls are logged in call order. These five recordings have only single-call steps, so they do not show the order themselves.
- Every `PLANNER_RESPONSE`, of root and child alike, carries `model`, `input_tokens`, `cache_read_tokens`, `output_tokens` and, in most, `thinking` and `tool_calls`.

### 4. Token fields are exact (token check)

For every prompt, the root's `PLANNER_RESPONSE` `input_tokens`, `cache_read_tokens` and `output_tokens` summed between two `USER_INPUT` steps equal the ACP reply's `usage` (`inputTokens`, `cachedReadTokens`, `outputTokens`) with no difference. `thoughtTokens` is a further field of the reply that the transcript has no counterpart for. Produced with `recorder/tok.ts <recording> <root transcript.jsonl>`:

| Recording | Prompt | Root steps summed | Transcript in / cache / out | ACP reply in / cached / out (thought) | Stop reason |
|---|---|---|---|---|---|
| `subagent-full` | 1 | 1, 3, 5 | 7319 / 20920 / 666 | 7319 / 20920 / 666 (569) | `end_turn` |
| `steer-visible` | 1 | 1 | 8814 / 0 / 250 | 8814 / 0 / 250 (197) | `end_turn` |
| `steer-visible` | 2 | 4, 6 | 4274 / 16411 / 2045 | 4274 / 16411 / 2045 (2028) | `end_turn` |
| `steer-during-request` | 1 | 1, 3 | 10989 / 6803 / 149 | 10989 / 6803 / 149 (56) | `end_turn` |
| `failed-turn-network-watch` | 1 | 1 | 8835 / 0 / 152 | 8835 / 0 / 152 (108) | `end_turn` |
| `subagent-approval-watch` | 1 | 1, 3 | 4401 / 13927 / 437 | 4401 / 13927 / 437 (250) | `cancelled` |
| `subagent-approval` (#1282, `research/antigravity-sessions-1282`) | 1 | 1, 3, 5 | 13142 / 14560 / 423 | 13142 / 14560 / 423 (257) | `end_turn` |

Seven prompts, seven exact matches, steering and a cancel included. A child's tokens are in no ACP reply: in `subagent-full` the child's steps (in 2069 + 2302 + 2430 and so on) are not part of the reply's 7319. So a child's usage can be read exactly from its own transcript, and only from there.

### 5. Steering works and ends visibly (`steer-visible`)

- t=7194: first `tool_call` (`sleep 12`). t=9194: prompt 2 is written. t=9197: prompt 1 replies `end_turn` with the usage of its one model call (in 8814, out 250). That is 3 ms after the write, while the command still runs.
- Prompt 1 sent no assistant text. Over ACP the text came later, in the turn of prompt 2: "Waiting for `sleep 12` to finish." (36580) and "ALPHA\nBRAVO" (41371), then prompt 2 replies `end_turn` at 41394 with the usage of the remaining model calls (in 4274, out 2045).
- In the files: the steer is written at once as `messages/3baf06a2....json` (t=9241, sender `user`, `priority` high, the content in a `stepPayload`, which the recorder masked). It becomes a `USER_INPUT` step (step 3) only at 17271, together with step 2, about 8 s after the write. So the transcript is a late and incomplete witness of the moment of the steer; the reply of prompt 1 is the earlier and clearer signal.
- So for Hercule: the steer is accepted when the earlier prompt's reply arrives after the steer was written (or the steer's own reply arrives); the turn ends with the reply of the newest prompt. No file is needed for steering.

### 6. A prompt sent while a request is open is refused at once (`steer-during-request`)

- t=15990: `tool_call` for `echo REQMARK > req.txt`; t=15994: the `session/request_permission` request. t=16034: prompt 2 is written; t=16035 (1 ms later): the reply is a JSON-RPC error, code `-32603`, message "Can't add this prompt to session a34a3bc9-...: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again".
- Prompt 1 is not affected. After the allow at 19035 the command runs (completed 19044) and prompt 1 replies `end_turn` at 24236. The transcript has one `USER_INPUT` only: the refused prompt left nothing in the files.

### 7. A provider error ends the turn over ACP, and the transcript never gets it (`failed-turn-network-watch`)

- t=6128: first `tool_call` (`read_file`), the recorder cuts the proxy. t=6131: it completes. t=6140: an `agent_message_chunk` with the text `\n⚠ agent executor error: generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": Service Unavailable\n`. t=6141: the prompt replies `end_turn` (the usage of the one model call that was made). Nothing marks the turn as failed except that text.
- The transcript ends with step 2 (the read result, t=6134). The watch saw no other change in the 60 s the recorder kept `agy` running afterwards (`files.jsonl` has no line after t=6134; the recorder note of t=6141 says it kept `agy` running 60 s).
- The error is in `agy`'s conversation database: read-only on a copy of `conversations/477ee040....db`, the `steps` table has idx 0 (type 14), 1 (15), 2 (132) and 3 (type 17); the payload of step 3 holds the same `agent executor error: ... Service Unavailable` text, and the words "Agent execution terminated due to error." (Not copied here: the payload also holds a stack trace of Google's code.)
- `agent executor error` is a constant string of the `agy` binary (found with `bin-grep.ts`, next to `executor is not idle` and `pre_invocation_hooks`, as `%sagent executor error`), so it is `agy`'s own wording, not text from the model.
- A recorder mistake: the scenario was meant to send `session/cancel` after 90 s without a reply. Because of how it waited, it sent it at t=6141, 1 ms after the reply, so the cancel came after the turn had ended. Its recorded note says "90s passed", which is wrong. The cancel had no visible effect (no reply, no file change).

### 8. A subagent that needs an approval hangs; the hook sees it first (`subagent-approval-watch`)

- t=7293 to 8426: the parent's `invoke_subagent`. The hook log has two lines. The first, at t=7295, is the parent's `invoke_subagent` (`conversationId` d88dcaa6, `stepIdx` 2). The second, at t=12390, is the child's `run_command` `echo hi > sub.txt` (`conversationId` 53814e0e, `artifactDirectoryPath` the child's folder, `transcriptPath` the child's transcript, `lastUserInput` empty, `stepIdx` 2). It comes 6 ms after the child's `PLANNER_RESPONSE` line (12384). There is no third line: the `write_file` call was never reached.
- No `session/request_permission` reached the client at any time. Over ACP, the last message before the cancel is the parent's text at 15554 ("I have launched a subagent ...", file line at 15607).
- During the hang no file changed: the last change before the cancel is the parent's step 3 at 15607; the child's transcript ends with its `PLANNER_RESPONSE` that calls `run_command` (12384) and never gets the result. Nothing changed up to the cancel at 82811.
- `session/cancel` at 82811 is answered at 82819 with `stopReason` `cancelled` (usage in 4401, out 437), 8 ms later. Then, at 82823, the parent gets `messages/2fe6fcb0....json` (sender `system`, `hideFromUser` true): "[Notice] All your subagents and background tasks have been stopped due to user force cancellation. If you want a subagent to continue working, it needs to be revived by sending it a new message." The child's transcript got no new line.

### 9. A subagent's `read_file` outside the workspace waits for an approval that never reaches the client, and `agy` fails it after 60 s (`subagent-read-outside`)

- t=22946 (hook log, epoch 1795732165255): the hook sees the child's `read_file` (`conversationId` c0c1ec17, `Path` `/var/tmp/hercule-1283-outside/note.txt`, `stepIdx` 2). The mode is "approval required" and the file is outside the workspace.
- No `session/request_permission` reached the client in the whole recording (0 messages).
- t=82981 (60.0 s later): the child's transcript gets step 2 (`GENERIC`) with `status` `ERROR` and the error "permission check failed for read_file \"/var/tmp/hercule-1283-outside/note.txt\": Permission prompt for action 'read_file' on target '/var/tmp/hercule-1283-outside/note.txt' timed out waiting for user response after 60s; the user did not respond, which is not an explicit denial. Do not attempt to circumvent this ...". So `agy` ends the wait by itself; the client was never asked.
- The child then reports the failure to its parent with `send_message` (step 3, t=87508; hook line at t=87455). The parent's turn ends with `end_turn` at 94883, after the text "... the permission check failed: > Permission prompt for action `read_file` on target `/var/tmp/hercule-1283-outside/note.txt` timed out waiting for user response after 60s ...".
- The hook sees this call first (as in finding 8), so a hook can deny it at once. Without a hook, the call fails after 60 s, by `agy` itself, with this text.

### 10. A subagent's MCP call in accept-edits waits and never reaches the server (`subagent-mcp-accept-edits`)

- The recorder started `agy` with one MCP server `tools` and set accept-edits with `session/set_mode` (the reply is `{}`).
- The server saw `server/discover`, `initialize`, `notifications/initialized`, `tools/list` and `notifications/roots/list_changed` (twice), and at the end a `DELETE` of its session. It saw no `tools/call` (`subagent-mcp-accept-edits.mcp.jsonl`, 9 lines).
- t=11697 (hook log): the hook sees the child's call `mcp_tools_whoami` (`conversationId` 6244eb0f, `stepIdx` 2). The child's `PLANNER_RESPONSE` for it is at 11782 (file watch). The child's transcript never gets step 2 or any later line: the child's last line is at 11782, and the recorder waited 90 s after it.
- No `session/request_permission` reached the client (0 messages). There was no timeout and no error: at t=102609 the recorder sent `session/cancel`; the reply is `cancelled` at 102621.
- The hook fired for the parent's `invoke_subagent` (t=7700) and for the child's MCP call.
- So a subagent's MCP call in this mode hangs with no answer and no end; a hook that denies it is the way to end it.

### Surprises

- The transcript is written 0 to 100 ms after the ACP update (finding 1), and a child can write its last line after the parent's reply (finding 2). A reader that stops at the reply can miss a step.
- A steer reaches the transcript as a `USER_INPUT` about 8 s after it was accepted (finding 5).
- A failed turn leaves no mark in the transcript (finding 7).
- The recorder's `session/cancel` of `failed-turn-network-watch` came 1 ms after the reply, not after 90 s (finding 7).
- A subagent's file read outside the workspace never reaches the client either, but `agy` fails it by itself after 60 s (finding 9); a subagent's MCP call just hangs (finding 10).

## The error notice format

Finding 7 shows the notice `\n⚠ agent executor error: ...\n` in an `agent_message_chunk`. Its frame is a format string of the binary. Run on the `agy` 1.5.15 binary with `bin-bytes.ts <binary> <text>`, which prints 40 bytes before and 60 bytes after every hit:

- the text `end_turn` + line feed + `⚠`: one hit, `...unixgramend_turn\n⚠ %s\nlocationprotocol...`;
- the text line feed + `⚠ %s` + line feed: one hit, at the same place.

So the binary holds the format `"\n⚠ %s\n"` once, right next to `end_turn`: a line feed, the sign, a space, the text, a line feed. That matches finding 7 (`\n⚠ agent executor error: ... Service Unavailable\n`). `STOP_REASON_QUOTA_EXHAUSTED` is a string of the binary (`bin-grep.ts <binary> STOP_REASON_QUOTA_EXHAUSTED`: 2 hits, one next to `STOP_REASON_MAX_TOTAL_TOKENS_EXCEEDED`, one next to a `TrajectoryUsageEntry` type). No recording shows it on the wire, so what an ACP reply carries for a quota failure is not measured.

## agy's own reader of these files

The `agy` 1.5.15 binary (`/tmp/hercule-1283/agy/antigravity`, sha256 starting `7b004d26c3fdea25`) embeds a JavaScript "swarm monitor" (a pane that watches the members of a swarm of agents). It reads the same `transcript.jsonl` files. It was found by searching the binary with `bin-ctx.ts` for the names of its functions. This note describes what that code shows, in our own words, and does not quote it. In short:

- It tails the transcript by byte offset and inode, and holds back a last line that is cut off (torn) until the rest arrives.
- A turn ends at a planner step that has no tool calls.
- An `ERROR_MESSAGE` step is a model error.

What it shows:

- It tails the file and only reads what was appended. A comment above `readTranscriptCached` lists four cases: an exact `mtime`, size and inode match is a cache hit; a small append past the last read offset reads only the new bytes; a cold start or a large append reads the tail from the end; a missing `step_index` falls back to an incremental read or a full read. A changed inode or a smaller file means start again. This agrees with the finding that the files are only appended.
- The turn-end rule: walking back from the newest line, the `GENERIC` steps (tool results) are collected until the newest `PLANNER_RESPONSE` is found. With no tool calls the turn has ended, provided no tool result came after it. With tool calls, the turn has ended only if one of the calls is `swarm_wait` and every call of the batch has a result and the result of `swarm_wait` is `DONE` (a result of the other calls does not matter; a call sent to the background is logged `RUNNING` and does not hold the turn). Any other newest step (a system message, user input, a model error being retried) means mid-turn. A torn last line counts as mid-turn, and the next read settles it. The comments there also say that results are logged in call order.
- An `ERROR_MESSAGE` step is called `modelError` by `agy`: an error of the model call. `stepFailure` also treats a tool step with status `ERROR` as failed, but only after it has stayed the newest step for 60 seconds (the agent normally carries on after one).
- The text of a failed step is tested against a pattern for quota errors. A match is reported as kind `quota`, else `error`. The pattern itself is not copied here; Hercule matches the two quota texts it has recorded.
- This reader sees an error only if an `ERROR_MESSAGE` step is in the transcript. In `failed-turn-network-watch` the transcript got none (finding 7).
