# Provider signals for "how far along" and "where in the code"

Research for the overview design team, 2026-10-26. Question: from what Claude Code (Agent SDK),
Codex (`codex app-server`) and pi actually emit, can Hercule (1) estimate how far along a session
is and (2) say where in the code it works?

Versions checked: the ones Hercule pins. Claude Agent SDK 0.3.263 (`apps/runner/package.json`;
latest is 0.3.310), Codex app-server 0.154.0 (generated types in
`apps/runner/src/providers/codex/generated/`; latest is 0.164.0), pi-coding-agent 1.2.0
(`apps/runner/src/providers/pi/edited-path.ts`; latest is 1.4.0).

Sources, in order of trust:

1. Type definitions the runner compiles against: Claude `sdk.d.ts` / `sdk-tools.d.ts` in
   `@anthropic-ai/claude-agent-sdk@0.3.263` ([unpkg](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.263/sdk-tools.d.ts)),
   the Codex types generated from 0.154.0, and pi source at its release tags.
2. Vendor docs and changelogs (links below).
3. Earlier research branches: `origin/research/claude-agent-sdk`, `codex-app-server`, `pi-sdk`,
   `structured-output`, `provider-portability`, plus `docs/research/codex-subagent-usage.md`.
4. **Local evidence.** I counted tool usage in this runner's own provider homes
   (`~/.local/share/hercule/runner/9f6dd658f457452b/providers/*`): 496 Claude sessions, 188 Codex
   rollouts and 16 pi sessions. I counted tool names and flags only, never content. The scripts
   are in `/tmp/ovtools/scripts/`.

---

## 0. What Hercule already does with these signals

This matters because the design does not start from zero.

- The runner normalizes every provider into one set of item kinds
  ([spec 06 §6.3](docs/spec/06-providers.md in the repo)): `command_execution`, `file_change`,
  `file_read {path}`, `file_search {pattern?, path?}`, `tool_call`, `subagent`, `plan`,
  `reasoning`, `assistant_message`, `context_compaction`, `error`.
  - Each item's `detail` holds only a small set of fields: the command text, the paths, the
    pattern.
  - Everything else is kept in `raw`, the untouched vendor payload. `raw` holds the exit code,
    `cwd`, duration, Codex `commandActions` and Claude `gitOperation`. It is dropped only when an
    event is too large for one frame.
- `client-core/src/threads/work-summary.ts` already builds lines like "ran 3 commands, edited 2
  files" from those kinds.
- **The runner already makes edited paths repo-relative** ([spec 19 §4.1](docs/spec/19-agent-coordination.md in the repo)).
  - Every `file_change` `item.completed` with status `completed` carries
    `editedFiles: { resourceId, path }[]`. `path` is relative to the checkout root and
    `/`-separated. It is resolved against the session cwd with realpath, and the longest
    containing checkout wins.
  - Edits made by shell commands are attributed through a git-based watch (`FilesEdited` frames).
    That watch is best effort.
  - The controller stores these as Edit rows, one per session, repository and path. Spec 19 says
    "No operation reads the rows" today.
- Things Hercule currently **drops or does not map**:
  - Claude `TodoWrite` and `TaskCreate`/`TaskUpdate` become plain `tool_call` items. Only
    `ExitPlanMode` maps to `plan`.
  - **Codex `turn/plan/updated` is dropped.** It falls into the `default: return []` case in
    `codex/normalize.ts`. Spec 06 §6.3 says `plan` comes from the "Codex `plan` item +
    `turn/plan/updated`", so the code does not match the spec.
  - Codex `turn/diff/updated` is dropped on purpose (spec 06 §6.7).
  - Claude `tool_use_summary`, `task_progress`, `task_updated` and `tool_progress` are trimmed
    (spec 06 §6.7).
  - Codex `agentMessage.phase` (`commentary` or `final_answer`) is kept only in `raw`.
  - Codex reasoning: the `reasoning_text` stream uses raw reasoning when the model sends it, and
    the summary otherwise.

---

## 1. Plans and todos

### Claude Code / Agent SDK

- **TodoWrite** ([sdk-tools.d.ts](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.263/sdk-tools.d.ts)):
  `{ todos: { content, status: "pending"|"in_progress"|"completed", activeForm }[] }`.
  - Each call carries the whole list.
  - The result (`tool_use_result`) is `{ oldTodos, newTodos }`.
- **Task tools** replaced TodoWrite for SDK sessions in 0.3.142 ("Breaking: Headless and SDK
  sessions now use Task tools ... Tool consumers should accumulate by task ID instead of replacing
  a snapshot list", [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)).
  - `TaskCreate { subject, description, activeForm?, metadata? }` returns `{ task: { id, subject } }`.
    The id appears only in the result, never in the input.
  - `TaskUpdate { taskId, status?: pending|in_progress|completed|deleted, subject?, description?,
    activeForm?, addBlocks?, addBlockedBy?, owner?, metadata? }`.
  - `TaskList` and `TaskGet` read tasks back.
  - The docs warn that the streamed input is "the raw shape the model emitted" (for example `id`
    or `task_id` instead of `taskId`), so read it defensively
    ([todo-tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking)).
  - Scope: the whole session. Tasks accumulate across turns, keyed by id.
- **Big catch: on current models the tools are not there at all.**
  - SDK 0.3.233 says: "Todo/task-tracking tools ... are no longer in the default tool surface on
    Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models".
  - 0.3.268 limits them to Claude 3.x, Opus ≤4.7, Sonnet ≤4.6 and Haiku 4.5.
  - The docs' reason: "Newer models track multi-step work without a written todo list"
    ([tools-reference § Task tool availability](https://code.claude.com/docs/en/tools-reference)).
  - Opt-in: name the tools in `tools`/`allowedTools`, or set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in
    `env`. Hercule's adapter does neither.
  - **Local evidence: 0 TodoWrite/TaskCreate/TaskUpdate calls in 496 Hercule Claude sessions**
    (Opus 5.5: 147 sessions, 91 of them with 10 or more tool calls; Sonnet 5.5: 349).
- When the tools are present, the docs say Claude creates todos for "most multi-step work":
  "three or more distinct actions", user-given lists, long operations. It "may skip todos for very
  short or single-step requests".
- **ExitPlanMode** (plan permission mode only): the input holds the plan markdown, and since
  0.2.76 `planFilePath`. It is a one-off proposal, not a running checklist.
- **Goal**: Claude Code has `ProposeGoal { condition }`, a completion condition such as "all tests
  in test/auth pass", which a separate evaluator checks. It is in the types, but I found no
  sessions using it.

### Codex app-server

- **`update_plan` tool** ([plan_spec.rs](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/plan_spec.rs),
  [plan_tool.rs](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/plan_tool.rs)).
  - Input: `{ explanation?: string, plan: { step, status: pending|in_progress|completed }[] }`.
  - The tool description says "At most one step can be in_progress at a time".
  - It is a todo/checklist tool and is refused in Plan mode.
  - Each call carries the whole plan.
- **Notification `turn/plan/updated`**: `{ threadId, turnId, explanation: string|null, plan:
  { step, status: "pending"|"inProgress"|"completed" }[] }`
  ([README](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md#events):
  "whenever the agent shares or changes its plan").
  - It is tagged with a turn, but the plan lives in the conversation and may be carried into
    later turns.
  - There is no thread-level "current plan" read, so a client keeps the last snapshot itself.
- **`plan` item** `{ id, text }`: Plan-mode turns only (`<proposed_plan>` block, streamed through
  experimental `item/plan/delta`). It is a proposal, not progress.
- **Thread goal** (`thread/goal/set|get|clear`, `thread/goal/updated`): `{ objective, status:
  active|paused|blocked|usageLimited|budgetLimited|complete, tokenBudget, tokensUsed,
  timeUsedSeconds }`. A client sets it; it is not set by default.
- Prompt guidance: the [default instructions](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/prompts/base_instructions/default.md)
  say "Do not use plans for simple or single-step queries", and to keep "exactly one in_progress
  step" with steps of "5-7 words". [gpt_5_codex_prompt.md](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/gpt_5_codex_prompt.md)
  says "Skip using the planning tool for straightforward tasks (roughly the easiest 25%)". Each
  model family has its own prompt.
- **Local evidence: 0 `update_plan` calls in 188 Hercule Codex rollouts** (gpt-6.1-sol, 88 of them
  with 10 or more tool calls). Many were PR reviews. The user's own `~/.codex`: 1 plan in
  9 sessions (gpt-5.4).

### pi

- No plan or todo tool exists. The README says pi "skips features like sub-agents and plan mode"
  ([README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)).
- Only example extensions exist (`examples/extensions/todo.ts`, `plan-mode/`). Hercule loads
  neither.

**So:** no plan arrives by default on any provider with the models Hercule actually runs.
A plan-driven progress bar only works if Hercule opts in. Claude can opt in today (one env var or
`allowedTools` entry, at a context cost Anthropic chose to remove). For Codex, "use update_plan"
can only be added through instructions. A pi plan would need a Hercule-owned tool.

---

## 2. File activity

| | Reads | Searches | Edits | Paths |
|---|---|---|---|---|
| Claude | `Read { file_path, offset?, limit?, pages? }` | `Glob { pattern, path? }`, `Grep { pattern, path?, glob?, type?, output_mode? ... }` (path defaults to cwd) | `Edit { file_path, old_string, new_string, replace_all? }`, `Write { file_path, content }`, `NotebookEdit { notebook_path ... }`. The result `tool_use_result` has `structuredPatch` and `gitDiff { additions, deletions, status: modified\|added }`; Write has `type: create\|update` | `file_path` "must be absolute" (schema); Read: "Claude is instructed to always pass absolute paths" ([tools-reference](https://code.claude.com/docs/en/tools-reference)) |
| Codex | no read tool: reads are shell commands. `commandExecution.commandActions[]` is a best-effort parse: `read {name, path}`, `listFiles {path}`, `search {query, path}`, `unknown` | same, through `commandActions` | `fileChange { changes: { path, kind: add\|delete\|update{move_path}, diff }[], status }`; `turn/diff/updated { diff }` is the aggregated unified diff of the turn after each change | fileChange paths are absolute (33 of 33 locally). `commandActions` paths are mostly **relative to the item's `cwd`** (1,906 relative vs 145 absolute reads). `cwd` uses the executor's native convention |
| pi | `read { path }` | `grep`, `find`, `ls` { pattern?, path? } | `edit { path, edits[] }`, `write { path, content }`; edit `details.diff`, `firstChangedLine` | model-written, "relative or absolute"; pi resolves against cwd, strips `@`, expands `~` (`resolveToCwd`) |

- Hooks: Claude `PostToolUse` gives `tool_name`, `tool_input`, `tool_response`, `duration_ms` and
  `cwd`, plus `agent_id` inside a subagent (`sdk.d.ts`). Hercule already uses `PreToolUse`.
- File checkpointing (`enableFileCheckpointing`) covers only Write, Edit and NotebookEdit in the
  main conversation: not Bash, not subagents
  ([file-checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)). It is for
  undo, not observation.
- **Local reality: shell dominates.**
  - pi (glm-5.3): 3,404 `bash` calls vs 92 `read`, 407 `edit` and 104 `write`.
  - Codex: 4,709 commands, of which about 45% parse as read/search/listFiles.
  - Claude Opus: 3,594 Bash calls.
  - So "files read" from read tools alone undercounts badly on pi. Codex `commandActions` covers
    it; pi needs the same kind of command parsing.
- **Making paths repo-relative:** reuse the runner's `editedFiles` conversion (spec 19 §4.1). For
  reads and searches, resolve against the session cwd (Claude, pi) or the item `cwd` (Codex), take
  the realpath, find the longest containing checkout, and strip its root. That conversion runs in
  the runner, which knows the checkouts. The controller does not know them.

---

## 3. Commands and outcomes

| | Command | Exit code | Duration | cwd | Extra |
|---|---|---|---|---|---|
| Claude `Bash` | `command`, `description` (model-written, 5-10 words), `timeout`, `run_in_background` | **no field.** `is_error` on the tool_result: a non-zero exit is an error, except exit 1 from grep/rg/find/diff/test/`git diff` | `PostToolUse.duration_ms`; `tool_progress.elapsed_time_seconds` while running | not reported per command; `cd` persists between calls | `BashOutput.gitOperation`: `commit {sha, kind, branch}`, `push {branch}`, `branch {merged\|rebased}`, `pr {number, url, action: created\|merged\|...}`; `returnCodeInterpretation`; `interrupted`; `backgroundTaskId` |
| Codex `commandExecution` | `command` (redacted display), `commandActions`, `source` | `exitCode`, `status: completed\|failed\|declined` | `durationMs` | `cwd` | streamed `outputDelta`, `aggregatedOutput` |
| pi `bash` | `command`, `timeout` | `structuredContent.exit_code`; `isError: true` and "Command exited with code N" on non-zero | `wall_time_seconds`; `tool_execution_end.durationMs` | session cwd | `full_output_path` when truncated |

Can a client classify "ran tests: 24 passed", "git commit", "git push" or "gh pr create"?

- **The kind of command: yes, by matching the command text.** All three give the command string.
  Claude adds `gitOperation`, but locally it was present on 17 of 28 successful `gh pr create`,
  16 of 77 `git push` and 1 of 80 `git commit`. Treat it as a bonus, not the source.
- **Pass or fail: often not from the exit code.** 207 of 240 local test commands (86%) were piped,
  190 of them into `tail`, `head` or `grep`, so the exit code is that of `tail`. Only 2 of 240
  were `is_error`. "24 passed / 2 failed" needs a per-runner parse of the output summary (vitest,
  jest, pytest, go test). The output is in `raw`, or in the Codex `aggregatedOutput`.
- **PR URL and number:** from Claude `gitOperation.pr` when present. Otherwise parse the `gh`
  output, which ends in the PR URL.

---

## 4. Turn structure, interrupts, errors, subagents

Hercule already normalizes this ([spec 06 §6.2, §13](docs/spec/06-providers.md in the repo)).

- **Claude.** Hercule opens the turn on input. The turn ends at the one `result` per turn:
  `subtype success|error_*`, `num_turns`, `duration_ms`, `total_cost_usd`.
  - `session_state_changed { idle|running|requires_action }` confirms it.
  - `status { compacting|requesting }`.
  - Interrupt ends the turn with an abort terminal reason.
- **Codex.** `turn/started` and then `turn/completed { turn.status: completed|interrupted|failed,
  error, durationMs }`.
  - `error { error, willRetry }`.
  - `thread/status/changed { active, activeFlags: waitingOnApproval|waitingOnUserInput }`.
  - `turn/interrupt` ends the turn with `interrupted`.
- **pi.** `agent_start` and then `agent_settled { aborted }`; `agent_end { willRetry }` does not
  mark the end.
  - `turn_start`/`turn_end` is one LLM round trip.
  - `auto_retry_start`/`end`, `compaction_start`/`end`
    ([json.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)).
- **Subagents, Claude.** `Agent { description (3-5 words), prompt, subagent_type,
  run_in_background, name }`. The subagent's messages carry `parent_tool_use_id` and `agent_id`.
  - `task_started { description, subagent_type, is_backgrounded, spawn_depth }`.
  - `task_progress { description, last_tool_name, usage { tool_uses, total_tokens, duration_ms },
    summary? }`.
  - `task_notification { status, summary }`
    ([subagents](https://code.claude.com/docs/en/agent-sdk/subagents)).
  - Hercule keeps `task_started` and `task_notification` as the subagent's turn boundaries and
    trims `task_progress`.
- **Subagents, Codex.** V1 `collabAgentToolCall { tool: spawnAgent|sendInput|wait|..., receiverThreadIds,
  prompt, agentsStates }`; V2 `subAgentActivity { kind: started|interacted|interrupted|completed,
  agentThreadId, agentPath }`. Child threads have their own turns. Locally: 700 subAgentActivity
  items and 47 `spawn_agent` calls.
- **Subagents, pi.** None of its own. Hercule's own `subagent` tool appears as `subagent` items.

---

## 5. Cheap one-line "what it is doing" (no extra model call by Hercule)

| Signal | Provider | Free? | Reliability |
|---|---|---|---|
| `activeForm` of the in-progress todo or task ("Running tests") | Claude | yes | only when the task tools are on. Not on current models by default |
| Bash `description` ("Run unit tests") | Claude | yes | present on 66% of Opus 5.5 Bash calls locally, 0.2% on Sonnet 5.5 |
| `Agent.description` (3-5 words) and `task_progress.description` ("Writing outer.txt", "Running perl …", taken from the last tool) | Claude | yes | reliable while a subagent runs (real captures in `claude-code-subagents.fixture.jsonl`) |
| `task_progress.summary` | Claude | needs `agentProgressSummaries: true`; the CLI forks the subagent about every 30s with the same model and cache ("cost is typically minimal") | subagents only; off in Hercule |
| `tool_use_summary { summary, preceding_tool_use_ids }` | Claude | in the types; when it is emitted is undocumented | unknown; Hercule trims it |
| `agentMessage.phase = "commentary"` (preambles before tool calls, "8-10 words" per the prompt) | Codex | yes | 503 commentary vs 768 final locally; the type says "Providers do not emit this consistently" |
| Reasoning summary (`item/reasoning/summaryTextDelta`) | Codex | yes | **empty locally**: 0 of 3,582 reasoning items had a summary on gpt-6.1-sol (encrypted content only) |
| `update_plan.explanation` | Codex | yes | only when a plan exists |
| Last item kind + `detail` (command, path, pattern) | all | yes | always available; this is what work-summary already uses |

---

## 6. Assessment

**(a) Progress indicator.**

- *Reliable:* done/total of a plan, but only where a plan exists. Today that is nowhere by
  default. An honest bar needs Hercule to opt in:
  - Claude: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, at a context cost.
  - Codex: an instruction to use `update_plan`.
  - pi: its own tool.
  - Even then the plan is optional, can be revised mid-run, and is skipped for short tasks.
- Also reliable: turn state (running / waiting on a Request / idle / failed / interrupted),
  elapsed time, tool-call and token counts, and Codex goal `tokensUsed/tokenBudget` if a budget
  is set.
- *Guess:* any percentage without a plan. No provider emits one. Use "elapsed time and step
  count" or "step N of a plan", never a fake percentage.

**(b) Phase (exploring / changing / verifying / shipping).**

- *Reliable enough:* "changing", from `file_change` items with completed status (all providers,
  with paths).
- *Reliable enough:* "shipping", from the command text `git commit|push`, `gh pr create|merge`.
  Claude `gitOperation` confirms it when present.
- *Good:* "exploring", from `file_read`, `file_search` and Codex `commandActions`
  (read/search/listFiles). On pi and Claude it needs the same parse of the bash text, since pi
  reads mostly through bash.
- *Guess:* "verifying". Test or lint commands can be matched by text, but the pass/fail outcome
  needs output parsing, because exit codes are hidden by pipes in 86% of runs. Phases also mix:
  agents edit, test and re-edit, so show the phase of the latest stretch, not of the session.

**(c) Focus path (the folder the session works in).**

- *Reliable:* edited files. The runner already resolves them to `{ resourceId, path }`
  repo-relative (`editedFiles`, Edit rows). The deepest common folder of the recent edits, or the
  folder with the most edits, is solid. It needs a read operation, because no operation reads
  Edit rows today.
- *Weaker:* reads and searches. The paths are available, but Codex's are relative to `cwd`, pi's
  are relative or absolute, and Claude's Glob/Grep often have no path. They still need the same
  repo-relative conversion in the runner. A noisy read of `AGENTS.md` or `package.json` at the
  root can drag the focus to `/`.
- *Guess:* the focus from Claude Bash commands. There is no per-command cwd and `cd` persists.

**Gaps to fix whatever the design is:**

- Codex `turn/plan/updated` is dropped, against spec 06 §6.3.
- Claude task tools stay `tool_call`, and are off anyway on current models.
- `raw` holds the exit code, duration, `commandActions` and `gitOperation`, but `detail` does not.
  A design that uses them should promote them into typed `detail` fields in the adapters, rather
  than have clients read `raw`.
