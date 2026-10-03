# How Claude Code exposes subagents to the Agent SDK

Research for [#346](https://github.com/theagenticage/hercule/issues/346), part of the map [#345](https://github.com/theagenticage/hercule/issues/345). Written 2026-10-03.

## Versions and sources

- **SDK types**: `@anthropic-ai/claude-agent-sdk` **0.3.263**, the version pinned in `apps/runner/package.json`. Its `manifest.json` names the bundled CLI as 2.1.263. Line numbers below (`sdk.d.ts:N`) are from that package's `sdk.d.ts` and `sdk-tools.d.ts`. Where it matters, the latest SDK (0.3.288, fetched the same day) is compared.
- **Docs**: [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents), [Create custom subagents](https://code.claude.com/docs/en/sub-agents), and [Environment variables](https://code.claude.com/docs/en/env-vars).
- **CLI**: the installed `claude` **2.1.288**. Hercule runs the user's installed binary (`pathToClaudeCodeExecutable: binary`, `claude-code.ts:543`), not the CLI bundled with the SDK, so the CLI version on a runner can differ from the pinned SDK. The pinned package has no platform binary installed here, so 2.1.263 was not run.
- **Observed**: five probe runs against CLI 2.1.288, described under [Method](#method). A claim marked *observed* was seen on the wire in those runs. A claim marked *unverified* has no primary source and was not observed.

## The short version

- Every frame produced inside a subagent carries `parent_tool_use_id` = the id of the `Agent` `tool_use` block that started that subagent. That is the key for building the tree.
- One subagent has two ids: the `Agent` `tool_use` id (on frames) and the **agent id** (`task_id` in `task_*` messages, `agentID` in `canUseTool`, the transcript file name, the `stopTask` argument, the `SendMessage` target). `task_started` links the two.
- By default the host sees only a subagent's prompt, its tool calls and its tool results, and only for depth-1 subagents. `forwardSubagentText: true` adds the subagent's text and thinking and the frames of nested subagents. Subagent `stream_event` deltas never arrived in any run.
- `canUseTool` names the asking subagent through `agentID`, at every depth.
- A host can stop one subagent (`stopTask`). It cannot message or steer one directly. Only the main model can, by calling its `SendMessage` tool.
- Limits: depth 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), 20 running at once (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). The per-session total cap was removed in 2.1.224.

## Identifier map

| What | Where it appears | Example (observed) |
|---|---|---|
| `Agent` tool_use id | the parent's `tool_use` block id; `parent_tool_use_id` on every frame from inside the subagent; `task_*.tool_use_id`; the `tool_result` that ends a foreground subagent | `toolu_01626ABmfrmqSuY6p7z4RbdB` |
| agent id | `task_*.task_id`; `agentId: <id>` in the Agent tool result text; `canUseTool` `options.agentID`; `SDKPermissionDeniedMessage.agent_id`; hook input `agent_id`; transcript `subagents/agent-<id>.jsonl`; `stopTask(<id>)`; `SendMessage` `to:` | `acc5f22912463b884` |
| parent agent id | `parent_agent_id` on `SessionMessage` from `getSubagentMessages` (`sdk.d.ts:5531`); `parentAgentId` in `agent-<id>.meta.json` | depth-2's meta names depth-1's agent id |

For a subagent, `task_id` and the agent id are the same string (observed: the `task_id` in `task_started` equalled the `agentId` in the tool result, the `agentID` in `canUseTool`, and the transcript file name in every run). Other task types (`local_bash`, Monitor) have `task_id`s of a different shape (`bresy0kl9`) and no transcript.

## 1. Which messages carry `parent_tool_use_id`, and what identifies a subagent

**Types.** `parent_tool_use_id: string | null` is on:

- `SDKAssistantMessage` (`sdk.d.ts:3318` onward). The field's doc says it is non-null when the message was produced inside a subagent started by that `tool_use`.
- `SDKUserMessage` and `SDKUserMessageReplay`.
- `SDKPartialAssistantMessage`, the `stream_event` (`sdk.d.ts:4826`).
- `SDKToolProgressMessage`.
- `SessionMessage`, read back from a transcript (`sdk.d.ts:5519`).

Assistant and user frames from a subagent may also carry `subagent_type` and `task_description` (observed on every subagent frame). The `system` `task_*` messages do not carry `parent_tool_use_id`. They carry `task_id` and `tool_use_id` instead.

The docs say the same: "Messages from within a subagent's context include a `parent_tool_use_id` field" ([SDK subagents, Detect subagent invocation](https://code.claude.com/docs/en/agent-sdk/subagents#detect-subagent-invocation)). They also note the tool is named `Agent` in `tool_use` blocks but `Task` in the `system:init` tool list, and was `Task` in `tool_use` blocks before 2.1.63.

**What reaches the host by default.** The option `forwardSubagentText` (`sdk.d.ts:1732`, CLI flag `--forward-subagent-text`, env `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`, needs CLI 2.1.211+) decides it. Its doc: "By default, only tool_use/tool_result blocks from subagents are emitted (enough for a heartbeat counter). When true, the full subagent conversation is forwarded so consumers can render a nested transcript."

Observed, with `includePartialMessages: true`:

| Frame from a subagent | Default | `forwardSubagentText: true` |
|---|---|---|
| its first `user` frame (the prompt it was given) | yes | yes |
| `assistant` frames with `tool_use` | yes, depth 1 only | yes, every depth |
| `user` frames with `tool_result` | yes, depth 1 only | yes, every depth |
| `assistant` frames with text or thinking | no | yes, as whole messages |
| `stream_event` deltas | no | no |

Three things here are not in the option's doc text:

- The subagent's prompt arrives as a `user` frame even by default. A reader must not mistake it for a user message.
- By default, a depth-2 subagent's tool calls do not arrive at all. Only its `task_*` messages and its permission requests do.
- No `stream_event` ever carried a non-null `parent_tool_use_id`, in any run. The type allows it, but on 2.1.288 a subagent's text arrives only as complete `assistant` messages. A host cannot show a subagent's text token by token.

## 2. Nesting: a subagent that spawns its own

**Limits.** A subagent can call `Agent` itself, up to `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` layers (see section 7). At the limit, the CLI refuses the call with "Subagent nesting limit reached (depth N of M)" (CLI 2.1.288 source), and the subagent does the work itself ([SDK subagents, Cap subagent depth](https://code.claude.com/docs/en/agent-sdk/subagents#cap-subagent-depth-concurrency-and-spend)).

**How it shows up (observed, sonnet, forwarding on and off):**

1. The main loop emits `tool_use` `Agent` id **A** (`parent_tool_use_id: null`).
2. `task_started` `{task_id: a1, tool_use_id: A, spawn_depth: 1}`.
3. Inside the depth-1 subagent: `tool_use` `Agent` id **B**, with `parent_tool_use_id: A`.
4. `task_started` `{task_id: a2, tool_use_id: B, spawn_depth: 2}`.
5. Depth-2 frames carry `parent_tool_use_id: B` (only with forwarding on).
6. The depth-2 result arrives as a `tool_result` for **B** with `parent_tool_use_id: A`, then the depth-1 result arrives as a `tool_result` for **A** with `parent_tool_use_id: null`.

So the tree can be built from the stream alone: a frame's `parent_tool_use_id` names its subagent's `Agent` block, and that block's own frame has a `parent_tool_use_id` naming the level above. This works even by default, because the depth-1 subagent's `Agent` `tool_use` frame is forwarded. `task_started.spawn_depth` gives the depth directly (`sdk.d.ts:5278`: "1 for a top-level spawn, N+1 when spawned from inside a depth-N agent"). On the wire there is no parent agent id. On disk there is (`parentAgentId` in the meta file, `parent_agent_id` from `getSubagentMessages`).

**In the SDK and `-p`, a nested background subagent reports to the main conversation.** From [sub-agents](https://code.claude.com/docs/en/sub-agents): in non-interactive runs the launching subagent doesn't wait, so a nested background subagent that finishes after its parent reports to the main conversation instead.

## 3. Background subagents and the `task_*` messages

**When a subagent runs in the background.** The `Agent` tool's `run_in_background` input decides. "Subagents run in the background by default", and Claude passes `run_in_background: false` when it needs the result first ([SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents#programmatic-definition-recommended)). `AgentDefinition.background: true` forces it. `CLAUDE_AUTO_BACKGROUND_TASKS` moves a foreground subagent to the background after about two minutes, and the host can do the same with `query.backgroundTasks(toolUseId?)` (`sdk.d.ts:2941`). `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` turns it off ([env-vars](https://code.claude.com/docs/en/env-vars)). Background subagents get a restricted tool set ([sub-agents, available tools](https://code.claude.com/docs/en/sub-agents)).

A background launch returns at once with a `tool_result` ("Async agent launched successfully", with the `agentId` and an output file). The subagent's frames then keep arriving with `parent_tool_use_id` set, **after the main turn's `result`** (observed). When the subagent ends, the main model is told and runs a new turn on its own, with its own `assistant` frames and `result` (observed). Nothing the user sent starts that turn.

**The messages** (all `type: "system"`; observed fields match the types):

| Message | Carries | Notes |
|---|---|---|
| `task_started` (`sdk.d.ts:5261`) | `task_id`, `tool_use_id?`, `description`, `subagent_type?`, `is_backgrounded?`, `spawn_depth?`, `task_type?` (`local_agent`, `local_bash`, `local_workflow`, `mcp_task`, ...), `workflow_name?`, `prompt?`, `skip_transcript?`, `ambient?` | Sent for foreground subagents too, with `is_backgrounded: false`. 2.1.288 also sends `owned_by_subagent: true` for a shell task a subagent starts. That field is in neither the 0.3.263 nor the 0.3.288 types (observed only). |
| `task_progress` (`sdk.d.ts:5236`) | `task_id`, `tool_use_id?`, `description`, `subagent_type?`, `usage {total_tokens, tool_uses, duration_ms}`, `last_tool_name?`, `summary?` | Sent per tool round. `description` changes to the current activity ("Writing /tmp/...", "Running sleep 25"). `summary` is filled only with `agentProgressSummaries: true` (`sdk.d.ts:1920`), which forks the subagent about every 30 seconds to write one. |
| `task_updated` (`sdk.d.ts:5297`) | `task_id`, `patch {status?, description?, end_time?, total_paused_ms?, error?, is_backgrounded?}` | `status` is `pending`, `running`, `completed`, `failed`, `killed` or `paused`. |
| `task_notification` (`sdk.d.ts:5210`) | `task_id`, `tool_use_id?`, `status` (`completed`, `failed`, `stopped`), `output_file`, `summary`, `usage?`, `resource_links?`, `skip_transcript?`, `ambient?` | The end of a task. For a subagent, `summary` is its final report and `output_file` is a symlink to its transcript (observed). |
| `background_tasks_changed` (`sdk.d.ts:3398`) | the full list of running background tasks `{task_id, task_type, description, ambient?}` | Replaces the previous list each time, so the latest one is the truth. Foreground subagents are not in it. |

`tool_progress` (`SDKToolProgressMessage`) also carries `parent_tool_use_id`, `task_id?`, `subagent_type?` and `subagent_retry?` (agent id, attempt, retry delay, error), so a host can show that a subagent is retrying an API error.

## 4. Where a subagent's transcript lives, and whether it can be read or resumed alone

**Path.** `<config dir>/projects/<encoded cwd>/<sessionId>/subagents/agent-<agentId>.jsonl` ([sub-agents, resume subagents](https://code.claude.com/docs/en/sub-agents); `listSubagents` doc in `sdk.d.ts:1047`). The config dir is `~/.claude`, or `CLAUDE_CONFIG_DIR` when set. All depths share one flat `subagents/` folder (observed).

Observed details the docs do not mention:

- Each transcript has a sidecar `agent-<agentId>.meta.json`: `agentType`, `description`, `toolUseId`, `parentAgentId` (nested only), `spawnDepth`, `requestShape` (`foreground`), `requestNonInteractive`.
- Every line has `isSidechain: true`, `agentId`, and the parent `sessionId`. The first line is the prompt, with `parentUuid: null`.
- `task_notification.output_file` (under `/tmp/claude-<uid>/.../tasks/<id>.output`) is a symlink to that transcript.

**Reading one alone.** Yes. `listSubagents(sessionId, {dir?})` returns the agent ids. `getSubagentMessages(sessionId, agentId, {dir?, limit?, offset?})` (`sdk.d.ts:834`) returns its messages as `SessionMessage`s, following `parentUuid`. `getSessionInfo` returns nothing for a sidechain. `deleteSession` removes the `subagents/` folder too. A `SessionStore` stores them under the subkey `subagents/agent-<id>`. Subagent transcripts are not touched by main-conversation compaction, can compact on their own, and are deleted after `cleanupPeriodDays` (default 30) ([sub-agents](https://code.claude.com/docs/en/sub-agents)).

**Resuming one alone.** No. There is no API that starts a subagent from its transcript. A subagent is resumed only inside its session: resume the session (`resume: sessionId`) and ask the main model to continue that agent, which it does with `SendMessage` to the agent id ([SDK subagents, Resume subagents](https://code.claude.com/docs/en/agent-sdk/subagents#resume-subagents)). The resumed subagent keeps its id and full history, and shows as running again in the `task_*` messages ([sub-agents](https://code.claude.com/docs/en/sub-agents)). The built-in `Explore` and `Plan` agents return no agent id and cannot be resumed.

## 5. Permission prompts from a subagent

A subagent's permission request goes to the same `canUseTool` callback as the main loop's. It says which agent asked:

- `options.agentID` (`sdk.d.ts:250`): "If running within the context of a sub-agent, the sub-agent's ID". It is absent for the main loop.
- `options.toolUseID` is the id of the subagent's own `tool_use` block, not the `Agent` block.

Observed: a depth-1 `Write` arrived with `agentID` = the depth-1 `task_id`. A depth-2 `Write` arrived with `agentID` = the depth-2 `task_id`. With forwarding off, that depth-2 request names a `toolUseID` that never appears on the stream, because depth-2 frames are not forwarded. Only `agentID` and the `task_*` messages tie the request to anything the host has seen.

The same id appears on the wire request (`can_use_tool` with `agent_id?`, `sdk.d.ts:4203`), on `SDKPermissionDeniedMessage.agent_id` (`sdk.d.ts:4855`: "Mirrors can_use_tool for host-side routing"), and on hook input (`agent_id`, `agent_type`). `decision_reason_type` can be `asyncAgent`. The docs add that a background subagent's prompt surfaces in the main session and names the subagent, and that a grant lasting for the session applies to the whole session, not just that subagent ([sub-agents](https://code.claude.com/docs/en/sub-agents)). That part is from the docs only (unverified here).

Several subagents can ask at the same time. Each request is a separate `canUseTool` call with its own `agentID`.

## 6. Control: stop, message, steer

**Stop one subagent: yes.** `query.stopTask(taskId)` (`sdk.d.ts:2926`, control request `stop_task`) with the agent id. Observed sequence for a running background subagent:

1. `task_updated` `{status: "killed"}`.
2. `task_notification` `{status: "stopped"}`, whose `summary` is only the task description.
3. Background shell tasks the subagent started are killed too, each with its own `task_updated` and `task_notification`.
4. The subagent's transcript gets a rejected `tool_result` and "[Request interrupted by user for tool use]", forwarded with its `parent_tool_use_id`.
5. The main model is told and runs a turn on its own, with `assistant` frames and a `result`.

A subagent stopped this way does not resume on its own, and `SendMessage` to it is refused ([sub-agents](https://code.claude.com/docs/en/sub-agents)). The model's `TaskStop` tool does the same from inside the session and also accepts a named agent's name (`sdk-tools.d.ts`, `TaskStopInput`).

`query.interrupt()` stops the main turn. It also kills running background tasks unless the host declared `perTaskStopAffordance: true` (`sdk.d.ts:1672`), in which case an interrupt spares them and the host is expected to offer a per-task stop. The first client to attach decides. This is from the types only (unverified here).

**Message or steer one subagent: not from the host.** There is no control request for it in 0.3.263 or in 0.3.288. The full list of control subtypes was checked. The interrupt receipt's doc says "subagent-addressed messages are out of scope" (`sdk.d.ts`, `SDKControlInterruptResponse`).

Observed: a host `user` message with `parent_tool_use_id` set to a running subagent's `Agent` id went to the **main** model, not the subagent. The main model then called `SendMessage` itself, and the tool answered "Message queued for delivery to `<agent id>` at its next tool round." So the only route is through the main model:

- `SendMessage({to: <agent id or name>, ...})` reaches a running subagent at its next tool round, or resumes a finished one. The `Agent` tool's `name` input "Makes it addressable via SendMessage({to: name}) while running" (`sdk-tools.d.ts`, `AgentInput`). `SendMessage`'s own input is not in the SDK's tool types.
- A subagent inside a long tool call sees the message only when that call ends.

**How the CLI lets the user type to a subagent.** The interactive CLI shows running subagents in a panel below the prompt. Selecting one opens its transcript, and "follow-up messages typed there go to that agent". Ctrl+Enter delivers early (2.1.286+), and `x` stops it ([sub-agents](https://code.claude.com/docs/en/sub-agents)). This is UI inside the CLI process. Nothing in the SDK exposes it. That the CLI uses the same "next tool round" queue as `SendMessage` is likely but **unverified**.

## 7. Spawn limits

From [env-vars](https://code.claude.com/docs/en/env-vars) and the [SDK subagents caps table](https://code.claude.com/docs/en/agent-sdk/subagents#cap-subagent-depth-concurrency-and-spend), checked against the CLI 2.1.288 source:

| Variable | Default | Notes |
|---|---|---|
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | **3** | Needs 2.1.217+. Integer, at least 1. `1` stops subagents from spawning their own. Earlier defaults: 1 in 2.1.217-218, fixed at 5 in 2.1.172-2.1.216. In 2.1.288 the default of 3 can also be changed by a server-side feature flag when the variable is not set. |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | **20** | Needs 2.1.217+. Counts every running subagent. At the limit the `Agent` call returns "Concurrent subagent limit reached" as its `tool_result`, until one ends. Sessions with ultracode active are never refused. |
| `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` | none | Removed in 2.1.224 and now does nothing (it was 200). There is no total-per-session cap. |
| `maxBudgetUsd` (query option) | no limit | Counts subagent spend. At the cap: no new subagents ("Budget limit reached"), running background subagents are stopped, and the query ends with `error_max_budget_usd`. |

Related: `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` (default 600000) for a stalled background subagent, `CLAUDE_CODE_FORK_SUBAGENT` (fork mode, off in the SDK unless set to 1), and `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`. The TypeScript SDK's `env` option replaces the subprocess environment, so these must be set in it.

## What this means for Hercule's adapter today

Files: `apps/runner/src/providers/claude-code.ts` and `claude-code-normalize.ts`. This research changes neither. The fixes belong to [#343](https://github.com/theagenticage/hercule/issues/343) and the tickets under [#345](https://github.com/theagenticage/hercule/issues/345).

- **Options** (`claude-code.ts:531-570`): `includePartialMessages: true` (558), `permissionMode` from the Access Mode, and `canUseTool` except in full access. No `forwardSubagentText`, `perTaskStopAffordance`, `agentProgressSummaries`, or subagent limits are set. Today the host therefore sees only depth-1 tool calls, and an interrupt kills background subagents.
- **Environment** (`claude-code.ts:274-280`): `buildEnv` spreads `ctx.env` and sets `CLAUDE_CONFIG_DIR: ctx.home`. Two effects:
  - Transcripts live under `<ctx.home>/projects/.../subagents/`, not `~/.claude`.
  - A `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` or `CLAUDE_CODE_MAX_*` value in the runner's environment reaches the CLI unchanged.
- **#343's premise needs a check.** #343 says a subagent's text leaks into the parent's reply. On 2.1.288 with default options, a subagent's text never reaches the host, so it cannot leak. What does reach `onAssistant` and `onUser` (`normalize.ts:400`, `463`) is the subagent's prompt (as a `user` frame) and its `tool_use` and `tool_result` frames, all flattened into the parent turn because both functions ignore `parent_tool_use_id`. The text leak would happen if `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` is set in the runner's environment, or on another CLI version. That is worth checking on the machine where #343 was seen.
- **Streaming map** (`normalize.ts:64`, used from `713`): `streams` is keyed by `parent_tool_use_id` so subagents can stream at the same time as the main loop. On 2.1.288 no subagent `stream_event` arrives, so only the `""` key is ever used.
- **Trimmed messages** (`normalize.ts:134-162`): all `task_*`, `background_tasks_changed` and `tool_progress` are dropped. These are the only source of `spawn_depth`, the agent id, background status, progress and the end of a background subagent. Spec 06 section 6.3 says the `subagent` item is built from "Claude `Agent` tool_use + task notifications", while section 6.7 trims those notifications. The two sections disagree and need correcting.
- **Background frames arrive between turns.** A background subagent's frames come after the main `result`, and its end starts a main turn the user did not ask for. Spec 06 section 6.2 already treats that turn as a synthetic turn. The subagent frames before it need a place too.
- **Permissions** (`claude-code.ts:698-802`): the item id is `options.toolUseID` (745) and `options.agentID` is ignored, so a card cannot say which subagent asked. Only one request can be open at a time. A second one is denied with "another approval is still waiting for the user; ask again after it is answered" (723). Parallel and background subagents asking at once will hit this, and each denied subagent has to retry.
- **Input and control**: `sendInput` always sends `parent_tool_use_id: null` (994). That is right, since a non-null value does not route to a subagent anyway. `interrupt` calls `stream.interrupt()` (1013). `stopTask` is never used, though it is the one per-subagent control the SDK has.

## Open and unverified

- Behaviour of the CLI bundled with SDK 0.3.263 (2.1.263). Every observation is from 2.1.288.
- Whether any CLI version streams subagent `stream_event` deltas. The type allows it; none were seen.
- The effect of `perTaskStopAffordance` on interrupt. From the types only.
- Background subagent permission prompts naming the subagent in the interactive CLI. From the docs only. Over the SDK, `agentID` was observed for foreground subagents only.
- How the interactive CLI delivers typed follow-ups to a subagent. Likely the same queue as `SendMessage`; not verified.

## Method

All runs used CLI 2.1.288 in a scratch folder, with the user's own `~/.claude` config (not Hercule's), and `includePartialMessages` / `--include-partial-messages` on.

1. `claude -p --model haiku --output-format stream-json --include-partial-messages --verbose --allowedTools Agent`, with a prompt asking for one foreground `general-purpose` subagent that writes a sentence and a word. Run once without and once with `--forward-subagent-text`.
2. SDK 0.3.263 `query()` with `pathToClaudeCodeExecutable` set to the installed `claude`, `permissionMode: "default"`, `allowedTools: ["Agent"]`, and a `canUseTool` that logs `toolName`, `toolUseID` and `agentID` and allows. The prompt asked for a subagent that spawns a subagent that uses `Write` (which needs permission). Run on sonnet without and with `forwardSubagentText`. Haiku did not nest, so the nested runs used sonnet.
3. SDK 0.3.263 `query()` in streaming-input mode with `forwardSubagentText: true`: one background subagent. Five seconds after `task_started`, the host pushed a `user` message with `parent_tool_use_id` set to the subagent's `Agent` id. Ten seconds later it called `stopTask(task_id)`.

After each run, the transcripts and meta files under `~/.claude/projects/<scratch>/<session>/subagents/` were read, as was the `output_file` symlink.
