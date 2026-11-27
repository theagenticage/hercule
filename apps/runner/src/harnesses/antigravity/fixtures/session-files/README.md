# Session files of `agy`, as fixtures

The files `agy` wrote under `<home>/antigravity-acp/brain/<conversation id>/.system_generated/` in five real runs. They are test input for the reader of `agy`'s session files. Nothing here is edited: each file is byte for byte what `agy` wrote, except that the recorder replaced strings of 200 or more characters without spaces with `<long>` (the `stepPayload` of a steer message).

- `agy` version: 1.5.15 (Linux x64).
- Recorded: 2026-11-26, with the Antigravity model `gemini-4-neon-high`.
- Kept per conversation: `logs/transcript.jsonl`, `subagents/*.json`, `messages/*.json`. Left out: `messages/read.json`, `messages/undelivered/`, `logs/transcript_full.jsonl`, `logs/chunks/`, `steps/`, `tasks/`.
- Each scenario has an ACP recording of the same run in `packages/acp/src/recordings/<scenario>.jsonl`. The ids below are the conversation ids, which are also the ACP `sessionId` of the root.
- The recordings, the file watches (what changed when) and the complete trees are on the branch `research/antigravity-session-files-1283`, under `docs/research/antigravity-session-files/`.

## `subagent-full`

Recording: `subagent-full.jsonl`. Full access. One prompt asks the model to start one subagent (role "File Writer") that runs `echo SUBMARK > sub.txt` and reports back.

- Root: `86a5c11a-cc0d-4231-b6a7-4df5e51875e0`. Has `subagents/e4553827-....json` (the link to the child) and `messages/c48c8f8a-....json` (the child's report to the root).
- Child: `e4553827-0073-42e6-bc63-8e9619a7d435`. Has `messages/f9780bc4-....json` (the root's launch message, sender is the root's id). Its transcript starts with a `SYSTEM_MESSAGE` and ends with a `PLANNER_RESPONSE` that has no tool calls.

Shows: a complete parent and child, the launch message, the child's report, `state` that stays `SUBAGENT_STATE_ALIVE`, and the model and token fields of a child's steps.

## `steer-visible`

Recording: `steer-visible.jsonl`. Full access. Prompt 1 runs `sleep 12` and replies ALPHA. Prompt 2 ("also add BRAVO at the very end") is sent 2 s after the command started, without waiting for prompt 1's reply.

- Root: `ebb87d3d-504b-4182-b783-46f41f68afbe`. No children.
- `messages/3baf06a2-....json` is the steer (sender `user`), written 47 ms after prompt 2. `messages/6a6b382a-....json` is the background task's finish notice (sender `<root>/task-2`, a task and not a conversation).

Shows: a steer as a `USER_INPUT` step in the middle of a turn (after a `GENERIC` step that is still `RUNNING`), and a message file whose sender is a task.

## `steer-during-request`

Recording: `steer-during-request.jsonl`. Approval required. Prompt 1 runs `echo REQMARK > req.txt`. While the permission request is open, prompt 2 is sent and `agy` refuses it at once (`-32603`). Three seconds later the request is allowed.

- Root: `a34a3bc9-c038-4422-af22-325e8213ee1e`. No children, no messages.

Shows: a refused prompt leaves no trace in the transcript. It has one `USER_INPUT` only, and no step for the word BRAVO.

## `failed-turn-network-watch`

Recording: `failed-turn-network-watch.jsonl`. Full access, behind the recorder's proxy. Prompt: read three files one by one. The proxy is cut at the first tool call; `agy` then ends the prompt with `end_turn` and an `agent executor error` message.

- Root: `477ee040-ba82-4617-be32-127b707158be`. No children.

Shows: a failed turn. The transcript stays as it was before the failure (a `PLANNER_RESPONSE` and one tool result): it never gets a step for the error, not even after 60 s of watching.

## `subagent-approval-watch`

Recording: `subagent-approval-watch.jsonl` (the pre-tool hook log is `subagent-approval-watch.hook.log` on the research branch). Approval required, with a logging pre-tool hook. The prompt asks a subagent to run `echo hi > sub.txt`. The child's `run_command` needs an approval that nobody can give, so the turn hangs until the recording sends `session/cancel` after 70 s.

- Root: `d88dcaa6-637b-40a5-9346-6c0d3ffd1603`. Has `subagents/53814e0e-....json`. Its `messages/2fe6fcb0-....json` is `agy`'s notice, sent by `system` after the cancel, that all subagents were stopped.
- Child: `53814e0e-a5c1-4d5a-8a7f-a9c4c143df6e`. Has `messages/d123c8e9-....json` (the root's launch message). Its transcript ends with the `PLANNER_RESPONSE` that calls `run_command`; the result never comes.

Shows: a child that is stuck on an approval. Neither transcript changes between the last model step and the cancel.
