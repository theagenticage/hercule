# Research: how Codex exposes collab agents over app-server

Resolves [#347](https://github.com/theagenticage/hercule/issues/347), part of the map [#345](https://github.com/theagenticage/hercule/issues/345) (subagents).

**Question:** what does `codex app-server`, at the release spec 06 pins, expose about collab agents (child threads), and what can a host do to one?

**Primary sources**

- `openai/codex` at tag `rust-v0.154.0` (commit `6b9826e3`), the release spec 06 and the adapter tests pin (`docs/spec/06-providers.md` §6.5 and §10, `apps/runner/src/providers/codex/testing.ts`). Links below point at that tag. `C/` stands for `https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/`.
- The TypeScript types generated from that release, checked in at `apps/runner/src/providers/codex/generated/`. They are the stable surface only (no `experimentalApi`), which is the surface Hercule codes against.
- Official docs: [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [App Server](https://learn.chatgpt.com/docs/app-server) (developers.openai.com/codex/... redirects there). The docs track the current release, not 0.154.0, so they are used only where the source agrees.
- This repo's adapter: `apps/runner/src/providers/codex/adapter.ts` and `normalize.ts`.

Everything below was read from source; nothing was run against a live app-server. Claims the source did not settle are listed in the last section.

## TL;DR

- **Two runtimes, chosen per thread.** Codex has multi-agent **V1** and **V2**, with different tools and different items on the wire. Which one a thread gets is decided by config, then by the model: `features.multi_agent_v2 = true` forces V2, `agents.enabled = false` disables it, otherwise the model catalog's `multiAgentVersion` decides, otherwise the `multi_agent` feature (on by default) gives V1. In the catalog bundled with 0.154.0, `gpt-5.5` and `gpt-5.2` declare nothing (so V1), `gpt-5.6-luna` declares V1, and `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-6-astra` declare V2. A Hercule session can therefore land on either, depending on the Agent's model.
- **Collab agents are on by default** in 0.154.0, and nothing about them needs `experimentalApi`. Hercule's instance-owned `CODEX_HOME` carries no `[agents]` config, so the defaults apply.
- **The parent shows the collab activity as items on its own thread.** V1: `collabAgentToolCall` items (started and completed) for spawn, send input, wait, resume and close, with the child ids in `receiverThreadIds`. V2: `subAgentActivity` items (`started`, `interacted`, `interrupted`, `completed`) with the child id in `agentThreadId`, plus a `collabAgentToolCall` only for `wait`, with empty receivers.
- **A child is a full thread whose events reach the host on their own.** The app-server subscribes every initialized connection to each spawned child. The child's `turn/*`, `item/*`, deltas and token usage arrive with the **child's** `threadId` and the child's own turn ids. No `thread/started` is sent for a child, and no notification carries a parent id or a parent turn id.
- **A child's approvals and questions are ordinary server requests** carrying the child's `threadId` and `turnId`. The child inherits the parent's approval policy, sandbox and cwd. Hercule's error reply today is read by Codex as a failed approval: commands and patches are **denied**, a user-input request gets **empty answers**, and the child's turn carries on.
- **What a host can do to a child:** `thread/read` and `turn/interrupt` work for both runtimes. `turn/start` and `turn/steer` work on a V1 child and are refused for a V2 child (`direct app-server input is not allowed for multi-agent v2 sub-agents`). An unloaded V2 child can be resumed only through its loaded parent.
- **Nesting:** V1 allows `agents.max_depth` levels below the root, default **1**, so no grandchildren by default. V2 has no depth limit, but a child gets the spawn tools only if its model declares V2.

## 1. The fields of `collabAgentToolCall` and `subAgentActivity`

Both are `ThreadItem` variants (generated `v2/ThreadItem.ts`). Both appear on the **parent's** (calling thread's) item stream, with the parent's `threadId` and the parent's current `turnId`.

### `collabAgentToolCall`

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The tool call id. Started and completed share it. |
| `tool` | `spawnAgent` \| `sendInput` \| `resumeAgent` \| `wait` \| `closeAgent` \| `sendMessage` \| `followupTask` \| `interruptAgent` \| `listAgents` | Which collab tool the model called. |
| `status` | `inProgress` \| `completed` \| `failed` \| `interrupted` | `inProgress` on `item/started`. On completion it is `failed` if any target agent ended `errored` or `notFound`, otherwise `completed`. |
| `senderThreadId` | string | The thread that called the tool, which is the parent. |
| `receiverThreadIds` | string[] | The target children. For `spawnAgent` it is empty while in progress and holds the new child's thread id on completion; this is the only place V1 announces a child's id. |
| `prompt` | string \| null | The text sent to the child (spawn and send input only). |
| `model`, `reasoningEffort` | string \| null | Requested on start, effective (read from the child's config) on completion. Spawn only. |
| `agentsStates` | `{ [threadId]: { status, message } }` | Last known state of each target. `status` is one of `pendingInit`, `running`, `interrupted`, `completed`, `errored`, `shutdown`, `notFound`; `message` is the agent's final message or error text when there is one. Empty while in progress. |

What is filled, per tool, in **V1** (from the V1 handlers under `C/core/src/tools/handlers/multi_agents/`, and the history mapping in [`event_mapping.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/src/protocol/event_mapping.rs#L78-L350)):

| Tool (model-facing name) | `item/started` | `item/completed` |
|---|---|---|
| `spawnAgent` (`spawn_agent`) | `receiverThreadIds: []`, `prompt`, requested `model` and `reasoningEffort` | `receiverThreadIds: [child]`, effective `model` and `reasoningEffort`, `agentsStates: { child }` |
| `sendInput` (`send_input`) | `receiverThreadIds: [target]`, `prompt` | `agentsStates: { target }` |
| `wait` (`wait_agent`) | `receiverThreadIds`: the targets | `receiverThreadIds` and `agentsStates` hold only the agents that reached a final state; both are empty on a timeout |
| `closeAgent` (`close_agent`) | `receiverThreadIds: [target]` | `agentsStates: { target }` |
| `resumeAgent` (`resume_agent`) | `receiverThreadIds: [target]` | `agentsStates: { target }` |

In **V2**, only `wait` produces a public `collabAgentToolCall`, and both its started and completed items carry empty `receiverThreadIds` and `agentsStates`. `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent` and `list_agents` are recorded for analytics only; the V2 analytics module says it "Records private collaborator analytics without emitting another public tool item" (`C/core/src/tools/handlers/multi_agents_v2/analytics.rs`). An app-server test asserts that no `collabAgentToolCall` completes during a V2 spawn (`C/app-server/tests/suite/v2/turn_start.rs`). The `sendMessage`, `followupTask`, `interruptAgent` and `listAgents` values of `tool` therefore exist in the type but are not emitted live at 0.154.0.

The core item also carries each receiver's nickname and role (`receiver_agents`), but the v2 protocol item has no such field, so they are dropped on the wire. A host gets a child's nickname and role from `thread/read` instead (section 4).

### `subAgentActivity` (V2 only)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The tool call id, or `subagent-completed-<child turn id>` for `completed`. |
| `kind` | `started` \| `interacted` \| `interrupted` \| `completed` | What happened to the child. |
| `agentThreadId` | string | The child's thread id. In V2 this is the only place a child's id appears on the parent's stream. |
| `agentPath` | string | The child's place in the agent tree, such as `/root/researcher` (`/root/<task_name>`, nested as `/root/a/b`). Segment names are lowercase letters, digits and `_` (`C/protocol/src/agent_path.rs`). |

Each activity is emitted as an `item/started` immediately followed by an `item/completed` ([`emit_sub_agent_activity`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L48-L56)):

- `started`: after a successful `spawn_agent`.
- `interacted`: after a successful `send_message` or `followup_task`.
- `interrupted`: after `interrupt_agent`.
- `completed`: when a child's turn ends with status `completed`. It is injected into the thread that gave the child its task (the parent, unless another agent sent the follow-up), with `turnId` set to **that thread's turn at the time**. That turn may already have ended, so this item can arrive on the parent's `threadId` **after** the parent's `turn/completed`, carrying an old turn id (`C/core/src/agent/control.rs`, `C/core/src/session/mod.rs`). A child that errors or is interrupted produces no `completed` activity.

Nothing a host does to a child directly produces a `subAgentActivity`: `interacted` and `interrupted` come only from the parent's own tools.

### Which tools a thread has

The tools are registered in [`spec_plan.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/spec_plan.rs#L644-L694):

- V1: `spawn_agent`, `send_input`, `wait_agent`, `resume_agent`, `close_agent`.
- V2: `spawn_agent` (with a required `task_name`), `send_message`, `followup_task`, `interrupt_agent`, `list_agents`, and `wait_agent` unless `features.multi_agent_v2.wait_agent_enabled = false` (default `true`, `C/core/src/config/mod.rs`).

The `Model` returned by `model/list` carries `multiAgentVersion: "disabled" | "v1" | "v2" | null` (generated `v2/Model.ts`), so a host can learn which runtime a model brings without hardcoding it. The thread's runtime is fixed at its first turn and then stays with the thread ([`resolve_multi_agent_version`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/session/mod.rs#L468-L484), [`resolve_multi_agent_version_for_model`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/session/mod.rs#L3878-L3890)).

## 2. Which notifications a child emits, and how they relate to the parent

**Every initialized connection is subscribed to every spawned child.** When AgentControl spawns, reloads or resumes a child, core announces the new thread id on a broadcast channel (`ThreadManager::notify_thread_created`, called from `C/core/src/agent/control/spawn.rs`). The app-server's main loop takes each id and attaches a listener for every connection that has finished `initialize` ([`lib.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/lib.rs#L1174-L1199)). The listener is the same one a normal thread gets. The announcement comes before the child's first input, and core buffers events in an unbounded channel, so nothing is lost before the listener attaches.

The child then emits the same notifications a root thread does, each with the **child's own** `threadId`:

- `turn/started`, `turn/completed` with the child's own turn ids.
- `item/started`, `item/completed` for the child's items (messages, reasoning, commands, file changes, tool calls, and its own collab items if it has children).
- The deltas: `item/agentMessage/delta`, reasoning deltas, `item/commandExecution/outputDelta`.
- `thread/tokenUsage/updated` for the child's own usage.
- `thread/status/changed`, which goes to **all** initialized connections (a broadcast, not a thread-scoped send): `idle` when attached, `active` during a turn, `idle` again after it, and `notLoaded` when the child shuts down.

What a child does **not** emit, or what is not on the wire:

- **No `thread/started`.** It is sent only by `thread/start`, `thread/fork` and detached review (`C/app-server/src/request_processors/thread_processor.rs`, `turn_processor.rs`). The first sign of a child is the parent's item (V1 `spawnAgent` completion, V2 `subAgentActivity started`) or a notification with an unknown `threadId`.
- **No parent link in any notification.** No notification type carries `parentThreadId`, `parentTurnId` or `rootTurnId`; in the generated types `parentThreadId` appears only on `Thread` (`v2/Thread.ts`). Core keeps a parent turn id internally but the protocol does not expose it. A child's turns cannot be tied to a specific parent turn by id; the tie is the parent's collab item.
- **The parent does not wait for a child** unless its model calls `wait_agent`. Spawn submits the child's input and returns at once. When the child finishes, V1 injects a notification into the parent's context and V2 sends an inter-agent message; neither starts a new parent turn on its own.

**The parent's turn does not control the child's.** Interrupting the parent's turn does not interrupt its children, and shutting the parent down does not shut them down (`C/core/src/session/handlers.rs`). A child's pending requests are cancelled only by the child's own turn transitions.

**Lifetime.** A thread unloads after `thread_unload_delay` (default 60 s) only when it has no subscribers and no active turn; only that path sends `thread/closed`. Because every connection is subscribed to every child automatically, a child stays loaded until the host sends `thread/unsubscribe` for it or the process exits. V1 `close_agent` shuts the child and its descendants down (status `notLoaded`, no `thread/closed`). V2 has no `close_agent`; at capacity it evicts the least recently used finished child. `thread/archive` and thread delete cascade to spawned descendants.

## 3. A child's approvals and questions

**Same requests, child ids.** A child raises exactly the server requests a root thread does, from the child's own listener in `C/app-server/src/bespoke_event_handling.rs`:

| Child needs | Server request | `threadId` / `turnId` |
|---|---|---|
| Run a command | `item/commandExecution/requestApproval` | the child's |
| Apply a patch | `item/fileChange/requestApproval` | the child's |
| Wider permissions | `item/permissions/requestApproval` | the child's |
| Ask the user | `item/tool/requestUserInput` | the child's |
| MCP elicitation | `mcpServer/elicitation/request` | the child's (turn id optional) |

The request goes to the connections subscribed to the **child**, which is every initialized connection (section 2). Nothing is relayed through the parent, auto-denied, or routed to the parent's thread. If two connections are subscribed, the first reply wins and later replies are dropped. If no connection is subscribed, the request waits until the child's turn changes state. On `thread/resume` a late joiner is sent the pending requests again.

**A host answers a child exactly as it answers the root**: reply to the request id with the same response shapes (`accept`, `acceptForSession`, `decline`, `cancel`, the answers map). The child's `threadId` is what tells the host which agent is asking.

**Inherited policy.** When a child is spawned, Codex copies the parent turn's live approval policy, approvals reviewer, permission profile (sandbox) and cwd onto the child's config, after any role or model override (`C/core/src/tools/handlers/multi_agents_common.rs`). A role cannot change approval or sandbox. The docs say the same: "Subagents inherit your current sandbox policy" and they reapply "the parent turn's live runtime overrides when it spawns a child" ([Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)). So a Hercule Access Mode set on the session applies to every child.

**Questions from a child are rare.** The `request_user_input` tool refuses non-root threads: "request_user_input can only be used by the root thread" ([`request_user_input.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/request_user_input.rs#L69-L73)). The tool is still offered to a child's model, which gets that text back if it calls it. `item/tool/requestUserInput` can still reach a host for a child thread through MCP paths that have no root check (MCP tool-call approval when `tool_call_mcp_elicitation` is off, which it is not by default, and MCP skill-dependency prompts).

**What Hercule's refusal does today.** The adapter answers a child's request with JSON-RPC error `-32600` (section 7). Codex treats an error reply as a failed request, not as a cancellation (a cancellation needs `error.data.reason == "turnTransition"`, `C/app-server/src/server_request_error.rs`):

| Request | What the child gets |
|---|---|
| Command | Denied as "approval request failed"; the item completes `failed` |
| Patch | Denied as "approval request failed" |
| Permissions | An empty grant |
| User input | **Empty answers**, not an error |
| MCP elicitation | Decline |

A denial reaches the model as a rejection it can see, and the child's turn **continues**; nothing hangs and nothing aborts. Today, then, a child in `ask`-style modes quietly loses every action that needs approval, and the user is never told.

## 4. What a host can do to a child directly

The one guard is [`can_accept_direct_input`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/thread_input.rs#L8-L37): it refuses direct input only for a V2 spawned child. All of these work on a child's thread id unless the table says otherwise (`C/app-server/src/request_processors/`):

| Request | V1 child | V2 child |
|---|---|---|
| `thread/read` (with `includeTurns`) | Works; uses the live thread if loaded, else the stored rollout | Same |
| `thread/resume`, child loaded | Attaches to the live thread | Attaches; overrides in the request are ignored |
| `thread/resume`, child unloaded | Cold-resumes as a standalone thread, outside the parent's agent registry | Only through its loaded parent; otherwise fails: "cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it" |
| `turn/start` (send input) | Works | Refused: "direct app-server input is not allowed for multi-agent v2 sub-agents" |
| `turn/steer` | Works | Refused, same error |
| `turn/interrupt` | Works | Works |
| `thread/unsubscribe` | Works | Works |
| `thread/fork` | Works; the fork is a root thread | Same |
| `thread/loaded/list` | Lists children | Same |
| `thread/list` | Hidden by default; pass `sourceKinds: ["subAgentThreadSpawn"]` | Same |

The same V2 refusal applies to thread settings updates, inject items, rollback, compaction, shell command, goals and MCP calls on a child.

A child's **own rollout** is persisted unless the thread is ephemeral, and the parent-to-child edge is stored too.

**Effects on the parent.** A host's `turn/interrupt` on a V2 child sets its status to `interrupted`, which the parent's model sees through `wait_agent` or `list_agents`; no item appears on the parent's stream. A host's `turn/start` on a V1 child is reported to the parent only if the child had not already finished once; V1 sends the parent one completion notice per child.

**How a host identifies a child.** `thread/read` returns a `Thread` (generated `v2/Thread.ts`) with:

- `parentThreadId`: "The ID of the parent thread. This will only be set if this thread is a subagent."
- `source: { subAgent: { thread_spawn: { parent_thread_id, depth, agent_path, agent_nickname, agent_role } } }` (generated `v2/SessionSource.ts`, `SubAgentSource.ts`). `agent_path` is null for a V1 child.
- `agentNickname` (a random name such as a role's nickname candidate) and `agentRole` (`default`, `explorer`, `worker`, or a user-defined role).
- `sessionId`, shared by the threads of one tree in core. `thread/list` returns the child's own id here instead, so do not rely on it.
- `canAcceptDirectInput` is the app-server's own answer to "will `turn/start` work", but it is **experimental** and not in Hercule's generated types. Derive the same thing from `source` plus the runtime instead.

## 5. Nesting

Yes, but with limits that differ by runtime.

- **V1:** a thread at depth `d` gets the collab tools only if `d + 1 <= agents.max_depth`, and `spawn_agent` refuses beyond it with "Agent depth limit reached. Solve the task yourself." The default is **1** ([`DEFAULT_AGENT_MAX_DEPTH`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/config/mod.rs#L244)), so by default a child cannot spawn. Raising `agents.max_depth` allows grandchildren.
- **V2:** no depth check. The root always has the tools; a child has them only if its own model declares V2 in the catalog ([`collab_tools_enabled`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/spec_plan.rs#L647-L660)). Paths nest: `/root/a/b`.
- **Concurrency:** V1 caps spawned threads per session at `agents.max_concurrent_threads_per_session` (alias `max_threads`), default **6**. V2 uses `features.multi_agent_v2.max_concurrent_threads_per_session`, default **4 including the root**, so 3 children ([`config/mod.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/config/mod.rs#L234-L244), [`effective_agent_max_threads`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/config/mod.rs#L1573-L1587)).

A grandchild is reported like a child: its own events arrive under its own `threadId`, and its spawn shows up as a collab item on the **child's** stream, not the root's. A host rebuilds the tree from each item's `senderThreadId` (V1) or from the thread that carried the `subAgentActivity` (V2), or from `parentThreadId` via `thread/read`.

## 6. Config, feature flags, and `experimentalApi`

| Setting | Default at 0.154.0 | Effect |
|---|---|---|
| `features.multi_agent` (legacy key `collab`) | on, stage Stable | Gives V1 when neither config nor model picks a runtime ([`features/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/features/src/lib.rs#L1258-L1269)) |
| `features.multi_agent_v2` (bool or table) | off, stage Stable | Forces V2; its table also sets the V2 thread cap, wait timeouts, `wait_agent_enabled`, tool namespace and hint texts |
| `agents.enabled` | `true` | `false` disables collab tools entirely ([`multi_agent_version_override`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/config/mod.rs#L1544-L1571)) |
| `agents.max_depth` | 1 | V1 nesting limit; ignored by V2 |
| `agents.max_concurrent_threads_per_session` | 6 | V1 thread cap |
| `agents.default_subagent_model`, `agents.default_subagent_reasoning_effort` | unset | Model for a spawn that names none |
| `agents.interrupt_message` | `true` | Records a model-visible message when an agent's turn is interrupted |
| `[agents.<role>]`, `<config>/agents/**/*.toml` | built-in `default`, `explorer`, `worker` | User-defined roles |

These are `config.toml` keys. A host can set them per thread through the `config` map on `thread/start` / `thread/resume` (a stable field), for example `{"agents.enabled": false}`. That this map accepts the `agents.*` keys was not tried.

**`experimentalApi`.** The collab items, `subAgentActivity`, `Thread.parentThreadId`, `agentNickname`, `agentRole`, `source`, the `subAgent*` values of `sourceKinds` and `Model.multiAgentVersion` are all on the stable surface; they are in Hercule's generated types. The only collab-related experimental pieces are:

- `Thread.canAcceptDirectInput` ([`thread_data.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L272-L275)).
- `thread/list` filters `parentThreadId` (direct children) and `ancestorThreadId` (all descendants) ([`thread.rs`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1437-L1445)).
- `multiAgentMode` on `thread/start`, `thread/resume` and settings updates, which is deprecated and ignored.

None is needed: children can be listed with `sourceKinds` and identified with `thread/read`.

## 7. What this means for Hercule's Codex adapter

What the adapter does today, and why:

- **Every child notification is dropped.** `onNotification` (`adapter.ts`, around `readThreadId` / `findThreadSession`) keeps a frame only when its `threadId` is the session's own thread. Children's frames arrive on the same connection (Hercule runs one app-server per session, so children live in that process) and are dropped before `normalize`.
- **Every child request is refused** with `-32600` "no session on this runner is on thread ...", and no warning is emitted. Per section 3, Codex reads that as a denial (or empty answers) and the child carries on. That is a silent substitution of behaviour, which `AGENTS.md` forbids; it is the most urgent thing the build must change.
- **Only the parent's collab items are mapped.** `normalize.ts` maps `collabAgentToolCall` and `subAgentActivity` to the `subagent` kind. `buildDetail` gives `collabAgentToolCall` only `{ name: tool }` and gives `subAgentActivity` no detail at all, so a V2 row has no description. Neither row records which child it is about outside `raw`.
- **A late V2 `completed` activity** arrives on the parent's thread after the parent's `turn/completed`, with the old turn id. The adapter will emit `item.started` and `item.completed` for a turn the session already reported as ended.
- **The children are kept loaded** for the whole app-server lifetime, because the adapter's connection is subscribed to each one and never unsubscribes.
- **`thread/closed` is safe today**: the adapter acts on it only for the session's own thread, so a child's close cannot end the session. Any change that starts accepting child frames must keep that check.

What the build can rely on:

- A child is fully observable without `experimentalApi`: its live stream (by `threadId`), its transcript (`thread/read` with `includeTurns`), and its identity (`parentThreadId`, `source.subAgent.thread_spawn`, `agentNickname`, `agentRole`).
- Requests from a child can be answered like the root's; the child's `threadId` says which subagent is asking.
- `turn/interrupt` stops one child in both runtimes. Sending input to or steering one child works only in V1. V2 children take input only from their parent, so "message a single subagent" is not available for V2 over the app-server.
- The parent link comes from the parent's items (V1 `receiverThreadIds`, V2 `agentThreadId`) as soon as the child exists, and from `thread/read` at any time. There is no parent turn id anywhere on the wire.
- Both runtimes must be handled, because the model decides. `model/list` says which one a model brings.

**Spec 06 correction.** The `subagent` row in spec 06 §6.3 names the Codex source as `collabToolCall`. At 0.154.0 the item is `collabAgentToolCall`, and V2 reports through `subAgentActivity`. The amendment should name both.

## Not verified

- Nothing was run against a live `codex app-server`; every claim is from reading the 0.154.0 source and its tests.
- The live model catalog, fetched from OpenAI at runtime, may differ from the catalog bundled in `C/models-manager/models.json`; which runtime a given model brings should be read from `model/list` at runtime.
- Whether `Thread.canAcceptDirectInput` is stripped from replies to a connection without `experimentalApi`. Outbound stripping is implemented only for command approval requests (`C/app-server/src/transport.rs`). Either way it is not part of the stable surface.
- Whether the `config` map on `thread/start` accepts `agents.*` and `features.*` keys as overrides.
- If the approvals reviewer is set to automatic review (guardian), a child's approvals may be settled by that reviewer without reaching the host. Hercule's Access Modes did not set that reviewer at the time of writing; not traced further.
- Whether a cold-resumed V1 child (outside its parent's registry) still reports its completion to the parent.
- What `thread/fork` of a V2 child does to its multi-agent runtime.
- The JSON casing of `source` is taken from the generated types (`{ "subAgent": { "thread_spawn": { ... } } }`), not from a captured frame.
