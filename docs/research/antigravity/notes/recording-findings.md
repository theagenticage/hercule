# #1282 recording findings (agy 1.5.15, Linux, Google AI Pro, Gemini 4 Neon)

Line numbers are lines of `/tmp/hercule-1282/rec/<name>.jsonl`. "in" = sent by agy.
Pretty printer: `analysis/show.ts <file>`. Normalizer run: `analysis/run-normalizer.ts` (output: `analysis/normalizer-output.txt`). Form check: `analysis/forms.ts`.

NOT RECORDED at all (scenario script exists, no .jsonl): background-command, failed-turn-network, subagent-approval. No recording has output with no prompt open, a subagent, a web search, an edit outside the workspace, an MCP tool or a compaction.

## 3.3 Images
- image-prompt:7 sent `{type:"image", mimeType:"image/png", data}` (32x32 red PNG) + text. Reply (:11) `agent_message_chunk "Red"`, :13 `end_turn`. The model saw the image. Confirmed. `initialize` reply: `promptCapabilities.image: true`.

## 4 ResumeTranscriptMissing
- resume:34: `session/resume` of a made-up id -> JSON-RPC error `{"code":-32603,"message":"Failed to read session 00000000-...; retry, or load it with session/load"}`. Matches `isConversationMissing` (agy.ts:324). The wording says "retry", so a transient read failure looks the same; nothing separates them.

## 6.2 Turns, provider failure, output with no prompt open
- failed-turn-network, background-command: not recorded.
- Every prompt reply was `end_turn` or `cancelled`. No error replies, no `refusal`/`max_tokens`.
- No update ever arrived with no prompt open (every file's updates sit between a `session/prompt` and its reply; resume:22-23 come after the resume reply, see 6.7).
- `usage_update` is sent after the last message chunk and before the reply (e.g. deny-followup:24-25), so the text item closes there.

## 6.3 Items
Tool names and kinds seen (all files):
- `run_command` kind `execute`; `read_file` `read`; `edit_file` `edit`; `write_file` `edit`; `ask_question` `other`. Nothing else.
- Search, list, fetch, delete: search-list-fetch-delete:7 asked for them explicitly. agy used ONE `run_command` (:13, grep + ls + curl + rm in one shell line) and three `read_file` (:16-21). Thought (:11): "Available tools lack direct search, listing, and fetching utilities", and the message (:24) says "No dedicated file search, directory list, URL fetch, or file delete tools are available". So: no `grep_search`, `list_dir`, `read_url_content`, delete tool seen. A web search (`search_web`) is not recorded. Our table entries for them stay unconfirmed; `run_command` is how all four happen. The whole sequence ran unasked (full-access).
- Non-zero exit (nonzero-exit:13): `tool_call_update` status `completed` (not `failed`), `rawOutput: {"output":"Created At...Command exited with code 2.\n\nCommand output:\nls: cannot access '/does-not-exist': No such file or directory\r\n","exit_code":2}`. So a failed command is item status `completed` with `exitCode: 2`; our normalizer does this (detail has `exitCode:2`). The model then says "failed with exit code 2". A `failed` status only came with a deny or a cancel.
- Empty output: two-requests:17 header only, no "Command output:", our parser gives exitCode 0 and no content (checked).
- File tools (basic-allow:13-20): `read_file` completed with no content and no rawOutput (only `locations`); `edit_file`/`write_file` completed with `rawOutput:{}` and a `diff` content (`oldText`/`newText`). Matches the table.
- In `default` mode `read_file`, `edit_file` and `write_file` inside the workspace ran with NO permission request (basic-allow: only the `ls` at :24 asked). See 8.1.
- The status `pending` `tool_call_update` comes right before every Request and an `in_progress` one right after the reply (deny-followup:13,16). The normalizer draws nothing for them. Good.
- ask_question: `tool_call` kind `other`, name `ask_question`, `rawInput.questions[]` of `{is_multi_select, options:[...], question}` (question-variants:13). Normalizer: `tool_call` of kind native, completes `completed` also when the form was declined (:44).

## 6.5 Requests
### Approval options
- 14 `session/request_permission` in all recordings, every one with exactly `[{optionId:"allow", kind:"allow_once"},{optionId:"deny", kind:"reject_once"}]` (e.g. deny-followup:14). No `allow_always`. Nothing written to a file was checked either: `allow_always` still unverified.
- Request id is a string, `"jetski-acp-front:4"`; the reply must use it as is.

### Deny follow-up
- deny-followup (`reject_once`/`deny`): reply at :15, then :16-17 item `failed` (`rawOutput:{"output":""}`), :18 prompt reply `end_turn` 1 ms later, no model text, no model call (usage 8810/80 = same call as before the tool). Follow-up prompt (:20) in the same session: thought "Execution blocked by tool denial ...", message ":22 The `run_command` call to run `touch denied.txt` was denied, so the file was not created. Let me know if you'd like to approve running the command ...", `end_turn` (:25). Did not retry the command. Sound.
- deny-cancelled-followup (outcome `cancelled`): the same. :15 reply, :17 `failed` with rawOutput as TEXT: "permission check failed for unsandboxed \"touch denied.txt\": user denied permission to run command ... Do not attempt to circumvent this denial ...", :18 `end_turn`, :25 follow-up replies sensibly ("Permission to run `touch denied.txt` was denied ... Let me know how you would like to proceed.").
- Both variants identical in behaviour; `cancelled` also gives the model a denial text in the tool result, `reject_once` gives an empty output. CONFIRMED: the follow-up design works, no need to make `deny` behave like `cancel`. The adapter's `end_turn` + follow-up rule matches exactly (the prompt returned within 1-3 ms).
- The first prompt's usage does not include the follow-up (separate replies, per-prompt usage); turn usage is the sum (normalizer: 8810+2257 input).

### session/cancel while a Request is open (cancel-during-permission)
- :14 Request arrives (t=8025). :16 we send `session/cancel` WITHOUT answering (same ms). :17-18 agy sends `tool_call_update` in_progress then `failed` (`rawOutput:{"output":""}`) (t=8026). :19 reply `cancelled` (t=8027, usage 8807/79). The prompt ends 2 ms after the cancel, without waiting for our answer to the Request.
- :22 we answer the Request with `{outcome:"cancelled"}` 3 s later (t=11026): agy sends nothing back, no error, no update. A late answer is silently accepted/ignored. File ends there.
- Not recorded: answering first, then cancelling (the race); a Request arriving during an interrupt; sending `cancel` on an idle session.
- Implication: after `session/cancel`, the adapter must not wait for the Request answer; it can send its answer anyway, harmless.

### Two Requests
- two-requests: asked for two commands "in parallel". Never open at once (script saw max open = 1). :14 Request 1 (t=9125), held 5 s, :15 answered (t=14126), :17 item 1 completed, :18 the second `tool_call` only starts now (t=14133), :20 Request 2 (id `...:5`), :21 answered, :23 completed. agy runs calls strictly one after the other here; a Request never waits behind another one.

### Questions (question-variants)
- Advertised `elicitation: {form: {}}`. Request `elicitation/create`, params `{sessionId, toolCallId, mode:"form", message, requestedSchema}`; message "The agent has 2 questions." / "The agent has a question."
- Single choice (:28): `q1: {type:"string", title, oneOf:[{const:"1",title:"Red"},{const:"2",...},{const:"3",...}]}` plus `q1_other: {type:"string", title:"Other", description:"Optional free-form answer to: <question>"}`. Consts are the 1-based index as a string. No `required`.
- Several questions, one multi-select (:15): `q1` as above, `q1_other`, then `q2: {type:"array", title, items:{anyOf:[{const:"1",title:"Dark mode"},...]}}` (NOT `enum`, NOT `oneOf`), then `q2_other` (string). One form holds all questions and one `_other` per question.
- Our `readQuestionForm` returns `undefined` for the :15 form (verified with `analysis/forms.ts`): `field.type !== "string"`. The adapter would answer `cancel` with a warning for ANY form that has a multi-select. NEEDS CODE: read `type:"array"` + `items.anyOf` as `multiSelect: true` and reply an array of consts, e.g. `{q2:["1","3"]}`. The array reply itself is NOT recorded: the replies were `{q1:"1"}` only.
- Replies and what the model received:
  - `{q1:"1"}` only (:16, q2 left out): model said Banner colour `Red` and features `User Skipped` (:19-20). So the const is translated to the label, and an unanswered question is "User Skipped". No error. Confirms the "no `qN_other` beside it" case is fine.
  - `{q1_other:"Purple"}` only (:29): model received `Purple` (:32). Confirms a typed answer with no `qN` is fine.
  - `{action:"decline"}` (:42): tool call goes `in_progress` then `completed` (:43-44), model said `User Skipped` (:46), turn `end_turn`. A decline does not end the turn and does not fail the call.
  - Not recorded: `q1` and `q1_other` together (spec already says it reads as both), a multi-select answer, `action:"cancel"`, questions in full-access, `required` in a schema.

## 6.6 Usage
- Every prompt reply has `usage {inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens}`, the cancelled ones too (interrupt-running:17, cancel-during-permission:19).
- The reply covers all model calls of that prompt added up. two-requests:29: 11213 + 286 + 6763 = 18262 = 8991 + 9271 (the `used` of its two `usage_update`s). `totalTokens` = input + output + cachedRead; `thoughtTokens` is inside `outputTokens` (question-variants:22: 4402+474+13786 = 18662, thought 355 not added). `cachedWriteTokens` always 0. Matches `addPromptUsage`.
- `usage_update {used, size}`: `size` always 1048576 (51 of 51). `used` is the context size at the last model call (single-call turns: equals the reply's totalTokens, e.g. deny-followup:24-25, 9195). The first prompt of a process starts with `used:0` (e.g. deny-followup:9), later prompts do not. Max seen 11287.
- Resume: counts start again (resume:27: 2093+70+6961 = 9124 = `used`); the old process's tokens are not repeated. No `usage_update` at all before the first prompt of a resumed process.
- A subagent's tokens: not recorded. Compaction: not recorded (context never above 11.3k of 1.05M).

## 6.7 Update and request table
- `sessionUpdate` values seen: `available_commands_update`, `usage_update`, `session_info_update`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `current_mode_update`, `config_option_update`. All are in the table. NOTHING new. No `user_message_chunk`, no `plan`.
- Requests seen: `session/request_permission`, `elicitation/create`. Nothing new.
- `/plan` (modes:23): the prompt text "/plan" got `agent_message_chunk` "Planning mode is active. What task or feature would you like to plan?" and `end_turn`; NO `current_mode_update` and no `config_option_update` followed (script: mode change seen=false). The model claims plan mode while ACP never reports it. Whether agy's mode changed inside is not visible. Risk: the session may now be in plan mode (no edits) with our access mode check (8.1) unaware.
- Resume replay: see 10.5; nothing replayed.
- `config_option_update` also comes without a request for it, repeated and stale (see 10.5, modes:15,18,19).

## 8.1 Modes
- `session/new` reply: `modes.currentModeId:"default"`, `availableModes`: `default`, `accept-edits`, `plan`. No `auto` (also not in configOptions `mode`). Matches the spec change.
- modes:7-9: `set_mode accept-edits` reply `{}` (:8), THEN `current_mode_update` (:9), same ms. Same for `plan` (:11-12) and `default` (:16-17). sandbox-accept-edits:8-10: reply `{}`, the next `session/prompt` is already sent (:9), `current_mode_update` comes after it (:10, same ms), then `config_option_update` (:11). So the update came after the reply in all 4 uses here, never before. Waiting up to 5 s is right, and the adapter must wait for it before sending the prompt (it must not send the first prompt first like the script did).
- Nothing runs before the mode is checked in these files (no tool call before the first `set_mode`). Mode on resume: the resume reply has `modes.currentModeId:"default"` (resume:20) and the `mode` configOption `default`, so the reply proves it, as for `new`. Whether a non-default mode persists across a resume was not tried (the session was in `default`).
- Permission behaviour:
  - `default` (basic-allow, sandbox-default): asks for every `run_command` (4 of 4 in sandbox-default), does NOT ask for `read_file`, `edit_file`, `write_file` inside the workspace (basic-allow:13-20, one request only, for `ls`). That means Approval Required on Antigravity does not hold file edits. The mode description says "Ask before edits and commands, per your permission settings". Needs a decision: either note it in 8.1 or see if a setting makes edits ask.
  - `accept-edits` (sandbox-accept-edits): asks for every command (4 of 4). Edits outside the workspace: not tried.
  - full-access (`FULL_ACCESS` flags: sandbox-full, nonzero-exit, interrupt-running, search-list-fetch-delete): zero requests, also for `rm` and curl. Questions in full-access not recorded.
  - Web search / URL read in `default`: not recorded (fetch was via `curl` in a command, which asks). Permission rules in workspace/home: not recorded. `auto`: not offered.
- agy changing its own mode: nothing seen, except the `/plan` case above (silent).

## 10.5 Sandbox, models, interrupts, resume
### Sandbox (sandbox-default / accept-edits / full)
- Same results in all three modes, no `BypassSandbox`: curl `http://<ip>:4937/api/v1/` -> 404 (reachable), `https://api.github.com` -> 200, `git ls-remote github.com/octocat/Hello-World HEAD` -> a hash, `echo $SSH_CONNECTION` -> `127.0.0.1 0 127.0.0.1 0`. Network works. Default and accept-edits asked once per command (4 + 4); full asked nothing. So on Linux with this account the sandbox did not block the network. (The macOS recording that did differ is not reproduced.) `hercule`/`gh` themselves were not run, only curl and git.
### Model switch (model-switch)
- `set_config_option model gemini-4-carbon` (:7): the REPLY (:8) is `{configOptions:[...]}` with `model.currentValue:"gemini-4-carbon"`. `thought_level low` (:9) reply (:11) `currentValue:"low"`. The adapter can read the reply. The ids differ by form: config option values are families (`gemini-4-carbon`, `thought_level` separate), while `availableModels`/`currentModelId` are `<family>-<level>` (`gemini-4-neon-high`).
- `config_option_update` also comes, but late and one step behind: :10 (sent after our thought_level request) still shows `thought_level: high`; :13 (after the failing request) shows `low`. Do not use it as proof; use the reply.
- Switching changes the offered levels: `thought_level` options after switching to carbon have no `xhigh` (:8) while neon had it (:6).
- Effect: the model said "Gemini 4 Carbon" (:22) when asked its name. Unknown model: error -32602 `Unknown model ID: no-such-model-123` (:14), session fine.
### Interrupt of a running command (interrupt-running)
- Full-access, `sleep 30 && echo done` (WaitMsBeforeAsync 10000, NotificationTimeoutSeconds 60). :13 tool_call in_progress, :15 `session/cancel`, :16 `failed` update (`rawOutput:{"output":""}`) 1 ms later, :17 reply `cancelled` 2 ms later. So cancel completes the call as `failed` at once, no wait. Whether the `sleep` process died: not checked. Background command: not recorded (the model did not background it in 10 s; the call stayed `in_progress` only until the cancel).
### Resume (resume)
- Reply to `session/resume` (:20) has the same keys as `session/new`: `sessionId`, `models` (list + `currentModelId`), `modes`, `configOptions` (model, thought_level, mode), `_meta.antigravity.tier`. So everything the start reads from `new` is there.
- Replay: nothing before the reply. After the reply only `available_commands_update` (:22) and `session_info_update` (:23, title "Remember The Number 7"), no `user_message_chunk`, no message or tool chunks, no `usage_update`. The "everything before the reply is replay" comment in agy.ts:122 holds trivially (there is no replay), and the two updates that do arrive come after the reply; both are dropped by the table.
- The conversation survived: B answered "**7**, and the secret word is **PELICAN**" (:25). The system prompt was in `_meta` on both `new` (:5) and `resume` (:19) with the SAME text, so this cannot tell whether a resume applies the text or agy kept it from session A. Test needed: resume with a different or an added word.
- Process A (new) accepted `_meta.antigravity.systemPrompt.append`; the secret word was not asked in A itself.
- Resume of a gone session: see section 4.

## 6.6/13.6 Subagents, 12 5.1 compaction
- Not recorded.

## Normalizer run (all 16 recordings)
Every `item.started` completed, no turn left open, no `unknown` item, no wrong item kind. Detail:
- `run_command` -> `command_execution`, `read_file` -> `file_read`, `edit_file`/`write_file` -> `file_change`, `ask_question` -> `tool_call` (native). Request kind of every `run_command` request: `command_approval` with the command.
- Deny (both variants) -> item `declined`; cancel-during-permission -> item `failed` in a turn that closes `interrupted` (only because my script did not call `markDeclined`; the adapter's interrupt does). interrupt-running (no Request): the cancelled command item is `failed`, in an `interrupted` turn.
- Non-zero exit -> `completed`, `exitCode 2` in detail.
- Usage: per-turn sums and the process running sum match the replies.
Problems / things to look at:
1. Multi-select form (question-variants:15) is unreadable for `readQuestionForm` (code gap, see 6.5).
2. An interrupted command shows `failed`, not something that says it was stopped (agy sends `failed`). Only a declined Request makes it `declined`. Probably fine, but a user sees "failed" for their own interrupt.
3. A declined `ask_question` completes as `completed` (agy says `completed`), though the answer was "User Skipped".
4. `/plan` silently changes nothing the adapter can see (6.7).
