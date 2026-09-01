# Providers

A provider wraps one interactive coding harness (Claude Code via the Agent SDK, Codex via `codex app-server`, pi via its RPC mode) behind two surfaces: a **ProviderDefinition** on the controller (static self-description, registered by the provider plugin) and a **ProviderAdapter** on the runner (execution: probe plus five session methods, one normalized event stream). The controller authors a `SessionSpec` that names ids, never paths; the runner resolves it and drives the adapter; the adapter normalizes vendor traffic into one event vocabulary at the runner, with a tagged raw passthrough. Degradation is declared, never silent: per-mode and per-feature support are pure facts on the definition, and the controller substitutes an unsupported access mode by a hardcoded, strictly downward fallback before the session starts. Rationale lives in [ADR 0007](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md).

## 1. Shape

| Surface | Where | Registered by | Owns |
|---|---|---|---|
| ProviderDefinition | controller | provider plugin, into the `provider` extension point ([./05-plugins.md](./05-plugins.md)) | identity, config schema, declared capabilities |
| ProviderAdapter | runner | built-in runner code in v1, written plugin-shaped (one narrow interface per provider, no cross-provider leakage); lifted into the plugin post-v1 | probing, session execution, event normalization |

A **provider instance** is a definition plus decoded config (t3-code's driver/instance split). The instance id, not the provider id, is the routing key everywhere: snapshots, session specs, placement. `supportsMultipleInstances` providers get multi-account by config-dir isolation (one login per instance).

**Default instances exist from first run** (resolved 2026-09-01, [Web app details](https://github.com/rogierpennink/hydra/issues/45)): the controller creates one provider instance per shipped provider plugin (Claude Code, Codex, pi) with default config - subscription auth, no overrides - named after the provider, so the first-session onboarding ([./14-web-app.md](./14-web-app.md) §Onboarding) can offer "Log in to Claude Code" without the user ever meeting the instance concept; a second instance appears only when they want a second account.

The runner never sees Hydra domain state and the controller never sees runner paths ([./03-controller-and-runners.md](./03-controller-and-runners.md), ADR 0002). Provider-native session state (transcripts, thread rollouts, session trees) lives on the runner's disk; the controller's normalized per-session stream ([./04-state-store.md](./04-state-store.md)) is the observable record.

## 2. ProviderDefinition and declared capabilities

```ts
interface ProviderDefinition {
  id: string                                  // "claude-code" | "codex" | "pi"
  displayName: string
  supportsMultipleInstances: boolean          // multi-account via config-dir isolation
  configSchema: JsonSchema                    // per-instance logical settings: env, model defaults - never paths (§2.1)
  defaultConfig(): unknown
  declared: DeclaredCapabilities              // static facts of the pinned adapter version
}

interface DeclaredCapabilities {
  steering: "native" | "unsupported"          // unsupported degrades to queue
  fork: "native" | "unsupported"
  modelSwitch: "in-session" | "new-session"
  accessModes: Record<AccessMode, "native" | "unsupported">
  mcpPassthrough: "native" | "unsupported"    // pi: verify at build time
  disallowedTools: "native" | "unsupported"   // Claude disallowedTools, pi excludeTools; Codex unsupported
  structuredOutput: "supported" | "unsupported"
}

type AccessMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access"
```

Rules:

- Every value is a pure fact about the pinned adapter version. No value expresses a fallback; what an unsupported mode falls back to is controller policy (section 8.4). The earlier `asks-instead` value is withdrawn.
- `steering: "unsupported"` means input sent to a busy session is queued by the controller instead (section 5); it never fails.
- `structuredOutput` is declared per [structured output research](https://github.com/rogierpennink/hydra/issues/28): the mechanism differs per harness (section 7) but the graph sees one capability. A harness with no mechanism declares `unsupported`; the controller then rejects agent steps that declare an output schema on that provider at plan validation, never emulating with a closing prompt.
- The UI derives every affordance from declared facts plus policy, never from the provider name.

Declared values for the three v1 providers:

| Capability | Claude Code | Codex | pi |
|---|---|---|---|
| `steering` | native (stream-append into the running `query()`) | native (`turn/steer`) | native (`steer()`) |
| `fork` | native (`resume` + `forkSession: true`) | native (`thread/fork`) | native (`fork()`) |
| `modelSwitch` | in-session (`setModel()`) | in-session (per-turn `model` override on `turn/start`) | in-session (RPC `set_model`) |
| `accessModes` | all four native | all four native | approval-required, auto-accept-edits, full-access native; `auto` unsupported |
| `mcpPassthrough` | native (`mcpServers` option) | native (MCP servers, `mcpToolCall` items) | verify at build time (below) |
| `structuredOutput` | supported (native `outputFormat`) | supported (native `outputSchema`) | supported (adapter-owned `submit_result` tool) |

**Verify at build time:** pi `mcpPassthrough` - the taxonomy matrix records no MCP support in pi; declare `unsupported` unless the pinned version has it.

pi's `auto` is unsupported because `auto` means a harness-side reviewer judges routine actions; parking (section 8.2) fixes pi's approval mechanics but gives it no reviewer.

### 2.1 Instance config

`configSchema` covers, per instance, **logical settings only**: extra environment for the spawned process (API keys, `ANTHROPIC_BASE_URL`-style routing, `CLAUDE_CODE_USE_BEDROCK=1`), model defaults, and provider-specific options. It never holds paths. The runner derives both paths itself: the provider home is `<storage dir>/providers/<instanceId>/` under the runner's material state ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)), and the binary is the runner-installed harness ([15 §12](./15-packaging-and-operations.md)); both reach the adapter on `ProviderRunnerContext` (section 4). Per-runner path overrides ("use my own `claude`") are post-v1. This resolves ticket 12's "binary path, config dir" wording against the no-runner-paths rule (ADR 0005): those two were the runner's to resolve all along (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)).

Instance config is validated against `configSchema` and stored on the controller; the runner receives the instance's config with each probe and session request. Secret-valued entries are `provider-instance`-owned rows in the secrets table ([./13-security.md](./13-security.md)): the controller decrypts them and sends them inline with each probe or session request over the runner WebSocket; they are held in memory for the operation and never land on runner disk (the same posture as git credentials, 13 §9). They are never logged and never returned by the API.

## 3. Capability snapshots

```ts
interface CapabilitySnapshot {
  instanceId: string; runnerId: string; probedAt: string
  declared: DeclaredCapabilities              // copied from the definition
  harnessVersion: string | null               // probed: claude --version, initialize.userAgent
  auth: { status: "ok" | "unauthenticated" | "error"
          identity?: string; planLabel?: string; backend?: string }
  models: ModelDescriptor[]
}

interface ModelDescriptor {
  slug: string; name: string
  isDefault?: boolean; isLegacy?: boolean
  options: OptionDescriptor[]                 // select | boolean, with per-model choices and defaults
}

interface OptionDescriptor {                  // field names beyond kind/choices/default are not pinned
  id: string                                  // well-known ids below, or provider-specific
  label: string
  kind: "select" | "boolean"
  choices?: { value: string; label: string }[]
  default: string | boolean
}
```

### 3.1 Scope and cadence

- **Scope is instance x runner.** Harness binaries live on runners with potentially different versions, so catalogs, auth and capabilities differ per runner. The controller stores one snapshot per (instance, runner) in its DB. Harness version skew across the fleet is a surfaced fact, not an error (the hook for later fleet-managed harness updates).
- **The composer resolves the snapshot against the placement target.** Switching the target runner in the composer triggers an on-demand probe of that runner; the cached snapshot is shown meanwhile.
- **Cadence** (copied from t3-code): a background interval, demand-gated (probe only while something is watching), on instance config change, and on placement change.
- The probe runs on the runner through `ProviderAdapter.probe(config)`; the runner reports the `ProbeResult` as a runner fact over the runner protocol ([./03-controller-and-runners.md](./03-controller-and-runners.md)); the controller stamps `instanceId`, `runnerId`, `probedAt` and copies `declared` from the definition to form the snapshot.

### 3.2 Probing is side-effect-free

Discovery never creates, resumes, or mutates a provider conversation, and never reads credential files. Per provider:

| Provider | Probe |
|---|---|
| Claude Code | a throwaway SDK `query()` with a prompt that never yields (`persistSession: false`, hooks disabled, MCP stripped, bounded timeout) reads the init message: account identity, subscription/plan label, `apiProvider` (first-party vs Bedrock etc.), CLI version. No API call is made. |
| Codex | `initialize` (user-agent carries the version) + `account/read` + `model/list` over a probe-only app-server process |
| pi | `pi auth check --provider <id> --json` per configured upstream provider; `pi --version` for the harness version |

`auth.status` is `unauthenticated` when the harness reports no usable login, `error` when the probe itself failed (binary missing, protocol error), `ok` otherwise. A provider instance with `auth.status !== "ok"` on a runner is filtered out of placement for that runner ([./03-controller-and-runners.md](./03-controller-and-runners.md)).

### 3.3 Catalog policy

Probe-first, curated overlay where introspection falls short:

- **Codex**: models, reasoning efforts and service tiers come fully probed from `model/list`.
- **Claude Code**: the catalog is curated (option descriptors cannot be probed) but gated by the probed CLI version, t3-code style: an entry is offered only when the runner's CLI is new enough.
- **pi**: models come from RPC `get_available_models` for the authenticated upstream providers, treated as probed.
- **Custom-model entries** are the user's escape hatch on every provider: a user-typed slug with no descriptor, rendered generically.

**Well-known option ids** are documented conventions, not an enum: `effort`, `thinking`, `contextWindow`, `fastMode`. The composer renders dedicated controls for them and workflows can reference them portably across providers; unknown ids render generically from the descriptor. Reasoning effort is a per-model `effort` option: probed per model for Codex, curated per model for Claude.

## 4. ProviderAdapter

```ts
interface ProviderAdapter {
  providerId: string
  probe(config: InstanceConfig): Promise<ProbeResult>
  startSession(spec: SessionSpec, ctx: ProviderRunnerContext): Promise<SessionBinding>
  sendInput(sessionId: string, input: TurnInput): Promise<SendResult>
  interrupt(sessionId: string): Promise<void>
  respondToRequest(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>
  stopSession(sessionId: string): Promise<void>
  listSessions(): Promise<SessionBinding[]>   // reconciliation after runner restart
  events: AsyncIterable<ProviderEvent>        // the one output channel
}

interface SessionSpec {                       // controller-authored - carries ids, never paths
  instanceId: string
  workspaceId: string | null                  // null = workspace-less session
  modelSelection: { model: string; options: Record<string, string | boolean> }
  accessMode: AccessMode                      // always a mode the target provider declares native
  systemPrompt?: string
  mcpServers?: McpServerConfig[]              // the decided passthrough field (#11)
  disallowedTools?: string[]                  // harness tool families to remove, Hydra vocabulary (rules below); copied from the Agent
  continue?: { nativeSessionId: string; mode: "resume" | "fork" }
  outputSchema?: JsonSchema                   // structured result contract, section 7
}

interface ProviderRunnerContext {             // the facts the runner resolved for this session on this machine
  cwd: string | null                          // workspace or scratch dir; null only as the controller-side "no workspace" marker (§9.1)
  env: Record<string, string>                 // session env: HYDRA_*, GH_TOKEN, GIT_CONFIG_*, PATH prepend (§9.3)
  home: string                                // this instance's provider home on this runner (CLAUDE_CONFIG_DIR / CODEX_HOME / PI_CODING_AGENT_DIR)
  binary: string                              // resolved harness binary path on this runner (§11)
}

interface SendResult { turnId: string; delivery: "opened" | "steered" }

interface SessionBinding {
  sessionId: string                           // Hydra session id
  nativeSessionId: string                     // Claude session id | Codex thread id | pi session file id
  instanceId: string
}

type ApprovalDecision = "allow" | "allow_always" | "deny" | "cancel"
```

Rules:

- **No merged spec type.** `startSession` takes the controller-authored `SessionSpec` byte-for-byte (auditable, storable, comparable) plus a `ProviderRunnerContext` holding exactly the facts the runner resolved: cwd, session env, provider home, binary. Nothing here ever moves to `SessionSpec`. (Renamed from ticket 12's `RunnerContext`, 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43): the old name read as "facts about the runner", which it is not.)
- **Ids in, paths out.** The runner's session supervisor resolves `workspaceId` to a path and hands the adapter the context. The adapter never sees workspace ids; the controller never sees paths (runner paths are runner-owned opaque facts, ADR 0005).
- `accessMode` on the spec is post-fallback (section 8.4); adapters carry no fallback logic and may reject a mode they do not declare native as a programming error.
- `mcpServers` is the per-session MCP-config passthrough decided in [plugin architecture](https://github.com/rogierpennink/hydra/issues/11): it carries self-injection and, later, plugin-contributed MCP tools. In v1 hydra-as-a-tool is the `hydra` CLI, not MCP ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)), so v1 core passes nothing here by default.
- `disallowedTools` names harness tool *families* in a small Hydra vocabulary (`edit`, `write`, `shell`, `web`, ...); the adapter owns the mapping to its harness's tool names and declares `disallowedTools: native | unsupported` in its capabilities. Unsupported is honest, not silent: the controller passes the field anyway, the adapter ignores it, and the UI shows "not enforced on <provider>" from the snapshot. The value is the Agent's `disallowedTools` copied at spawn ([./02-domain-model.md](./02-domain-model.md) rule 9); assistants default to `["edit"]` ([./12-assistants.md](./12-assistants.md) section 7). Resolved 2026-09-01, [Domain model residue](https://github.com/rogierpennink/hydra/issues/46).
- `outputSchema` carries the agent step's declared schema ([./07-workflows.md](./07-workflows.md)); the adapter applies it by the provider's mechanism (section 7).
- **Deliberately absent:** `readThread` / `rollbackThread` (return with the checkpoint/revert feature; fork covers branching), a separate steer method, any queue surface, a mode-switch method.

**Open:** `TurnInput` is pinned only as "the user input for one turn" (text). Whether it carries attachments or images in v1 is not decided.

The session environment rides `ctx.env` (resolved 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)). The adapter builds the spawned process environment as: the runner's base env, then the instance config env, then `ctx.env` - Hydra-owned keys always win, so instance config can never override `HYDRA_SESSION` or the git credential material.

### 4.1 Session identity and binding

The Hydra session id and the provider-native id are separate concepts joined explicitly by `SessionBinding`. `startSession` returns the binding once the native id is known (Claude: init message; Codex: `thread/started`; pi: session file created). The controller stores `nativeSessionId` on the Session record ([./02-domain-model.md](./02-domain-model.md)) and passes it back in `continue` for resume and fork.

- A session is pinned to the runner where it starts (ADR 0002). Resume and fork target the same runner and the same instance.
- `listSessions()` enumerates the adapter's live and resumable sessions after a runner restart; the runner reconciles them against the controller's Session records over the runner protocol. Sessions the runner cannot account for are marked exited with `reason: "runner_restart"`.
- If a runner dies unrecoverably, its sessions' resumability dies with it; history survives in the controller's normalized stream. Accepted v1 trade.
- Codex allows only one app-server process to hold a thread open for writing (`-32600` on a second `thread/resume`). The process topology is not pinned; the suggested topology is one app-server process per instance per runner, with thread ownership serialized through it.

**Session status** (consolidated from pinned lifecycle facts, not pinned by a ticket; [./02-domain-model.md](./02-domain-model.md) mirrors it):

```ts
type SessionStatus = "queued" | "starting" | "idle" | "busy" | "exited"
// derived, not stored: resumable = exited && the session's runner still holds its native state
```

`queued` = placement accepted, runner full or unreachable; `starting` = `startSession` sent, no `session.started` yet; `idle` = no running turn; `busy` = a turn is running (including while parked on an open request); `exited` = `session.exited` received or the runner reported it gone. `session.exited.reason` values are the spec's vocabulary: `stopped` (via `stopSession`), `process_exit`, `idle_unload` (Codex `thread/closed`), `runner_restart`, `crash`.

### 4.2 Lifecycle

1. Controller resolves placement, fallback access mode, model selection, and mints the session token; sends `startSession` to the runner with the spec.
2. Runner resolves `cwd`: the workspace path, or `cwd: null` for a workspace-less session. Codex alone gets a runner-provisioned scratch directory instead of `null`, because `thread/start` needs one (section 9.1); that directory is not a Workspace. The runner prepares the session environment and calls the adapter.
3. Adapter spawns or attaches the harness, emits `session.started`, returns the binding.
4. Turns proceed via `sendInput`; approvals via `request.opened` / `respondToRequest`; `interrupt` ends the running turn with `state: "interrupted"`.
5. `stopSession` ends the harness process cleanly; `session.exited { reason }` is the last event. The runner tears down ephemeral workspaces per [./03-controller-and-runners.md](./03-controller-and-runners.md).

No wall-clock timeout exists in any harness; the runner's session supervisor owns deadlines and recycling. There are no per-session CPU or memory caps in v1 ([./03-controller-and-runners.md](./03-controller-and-runners.md)).

## 5. Steering and queued input

Steering is implicit in `sendInput`: a busy session steers (input folds into the running turn), an idle session opens a new turn. `SendResult.delivery` reports which happened and is the only authority; consumers never infer steering from event order. A steered input appears in the stream as `item user_message { steered: true }` inside the running turn.

Vendor mechanisms: Claude appends to the streaming input of the live `query()`; Codex calls `turn/steer` with `expectedTurnId`; pi calls `steer()`. When Codex rejects `turn/steer` because the turn just ended, the adapter opens a new turn with the same input and reports `opened` - input is delivered unconditionally, never bounced. If `turn/steer` proves flaky, t3-code's approach (queue a `turn/start` and relabel it) is the documented fallback.

**The input queue is controller-owned domain state.** When the user or a workflow sends input to a busy session and steering is not wanted (or the provider declares `steering: "unsupported"`), the controller stores Queued Input and flushes it with `sendInput` on `turn.completed`. Queued input is editable and cancelable until flushed; subscription deliveries to sessions arrive this way ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)). Vendor-native queues (Codex follow-up `turn/start`, pi `followUp()`) go unused: they are process-local and uneditable. The cost is sub-second flush latency over the runner WebSocket, riding the ordinary seq/ack + outbox protocol.

## 6. Normalized event taxonomy

Normalization happens at the runner, closest to the vendor protocol. Every event carries the base fields; every event may carry `raw` (the untouched vendor payload tagged with its source, e.g. `claude.sdk.message`, `codex.app-server.notification`, `pi.session.event`). Enums are open for consumers: unknown kinds render generically, never crash.

```ts
interface ProviderEventBase {
  eventId: string; sessionId: string; at: string
  turnId?: string; itemId?: string; requestId?: string
  providerRefs?: Record<string, string>       // native ids (thread id, item id, tool_use id ...)
  raw?: { source: string; payload: unknown }
}
```

### 6.1 Session

- `session.started`
- `session.exited { reason }` - `reason` vocabulary in section 4.1 (`stopped`, `process_exit`, `idle_unload`, `runner_restart`, `crash`).

### 6.2 Turn

- `turn.started { model? }`
- `turn.completed { state: "completed" | "failed" | "interrupted", usage?, costUsd?, error?, structuredResult? }`

A turn is the user-visible episode: from user input until the agent goes idle. It contains any number of model calls and tool executions. Bracketing per provider:

| Provider | Turn id | Start | End |
|---|---|---|---|
| Claude Code | adapter-minted | adapter emits at `sendInput` | the one `result` message per turn (authoritative); `session_state_changed { idle }` is secondary confirmation only |
| Codex | native `turn/started` id | `turn/started` | `turn/completed { status }` |
| pi | adapter-minted | `agent_start` | **`agent_settled`** (not `agent_end`: `agent_end` fires once per low-level run and carries `willRetry`; auto-retry, overflow-compaction re-prompts and queued follow-ups continue the episode past it). pi's `turn_start/turn_end` is one LLM round-trip and maps to item grouping. Intermediate `agent_end { willRetry: true }` becomes at most a `runtime.warning`. |

State mapping: `interrupted` <- Codex `interrupted`, Claude abort terminal reasons, pi `aborted`; `failed` <- Claude `error_*` result subtypes, Codex `failed`, pi `stopReason: "error"`. **Synthetic turns** are opened for unsolicited output outside any user turn (Claude task notifications trailing a result).

### 6.3 Items

`item.started`, `item.updated`, `item.completed { status: "completed" | "failed" | "declined" }`, each with `kind` and a kind-specific `detail`:

| Kind | Meaning | Notes |
|---|---|---|
| `user_message { steered?: true }` | user input | `steered` set from `SendResult`, never inferred |
| `assistant_message` | assistant text | |
| `reasoning` | thinking / reasoning | |
| `command_execution` | shell command | Claude: `Bash`/`Shell` tool-name inference; pi: `bash` tool |
| `file_change` | edit / write / patch | Claude: `Edit`/`Write`/`Patch` inference |
| `tool_call { kind: "mcp" \| "native" }` | any other tool | MCP detected by `mcp__server__tool` naming on Claude, `mcpToolCall` on Codex |
| `web_search` | web search | Codex native item; tool-name inference on Claude; absent on pi (degrades to `tool_call`) |
| `subagent` | delegated agent | Claude `Agent` tool_use + task notifications (children attributed by `parent_tool_use_id`); Codex `collabToolCall`; absent on pi |
| `plan` | plan / todo state | Claude `ExitPlanMode`; Codex `plan` item + `turn/plan/updated`; absent on pi |
| `context_compaction` | harness compacted context | Claude `compact_boundary`; Codex `contextCompaction`; pi `compaction_start/end` |
| `error` | mid-turn error item | Codex `error` notification with `codexErrorInfo`; Claude assistant `error`; pi `stopReason: "error"` |
| `unknown` | forward-compat catch-all | review mode, image generation and every unmapped vendor item land here with `raw` |

Item ids are native where they exist (Codex item id; Claude `tool_use` id / `message.id`; pi `toolCallId`) and adapter-minted otherwise. `status: "declined"` is native only on Codex; elsewhere the adapter derives it from its own approval bookkeeping (it resolved the request, so it knows). Tool arguments land complete on `item.updated` / `item.completed`; there is no argument-streaming kind.

### 6.4 Streaming

`content.delta { itemId, streamKind: "assistant_text" | "reasoning_text" | "command_output", delta }`

- Deltas are append-only text per (item, streamKind). Where the vendor sends cumulative snapshots (pi `tool_execution_update.partialResult`), the adapter diffs by common prefix before emitting.
- `command_output` deltas exist only where the harness streams them (Codex `outputDelta`, pi); on Claude the output arrives whole on `item.completed`. Degradation, not distortion.
- **Reasoning-summary precedence rule**: where a vendor streams raw and summarized reasoning as separate channels (Codex `item/reasoning/textDelta` and `summaryTextDelta`), the adapter picks one channel per reasoning item, raw preferred, and emits it as `reasoning_text`; the unpicked channel stays raw-only. No fourth stream kind (`reasoning_summary_text` remains an additive option later).
- The store coalesces deltas in memory and flushes at message/turn boundaries; nothing is persisted per token ([./04-state-store.md](./04-state-store.md)). Watched sessions receive an ephemeral token-delta passthrough ([./14-web-app.md](./14-web-app.md)).

### 6.5 Requests (approvals and user input)

- `request.opened { kind, detail }` with kind `command_approval` | `file_change_approval` | `file_read_approval` | `tool_approval` | `user_input`
- `request.resolved { decision: ApprovalDecision }`

`file_read_approval` renders as a path list, not a diff or a command (native in Codex `item/fileRead/requestApproval`). `user_input` carries structured questions in `detail` (Claude `AskUserQuestion`, Codex `item/tool/requestUserInput`); it resolves with the answers, and the taxonomy needs no separate user-input event pair.

`ApprovalDecision` scope semantics: `allow` = this call only; `allow_always` = the vendor's for-session persistence (Codex `acceptForSession`, Claude `updatedPermissions`, pi: the adapter's hook remembers the rule for the session); `deny` = refuse with a reason the model sees; `cancel` = refuse and end the turn. The four values and their vendor mappings are pinned; that `cancel` ends the turn is the spec's consolidated reading of the vendors' `cancel` options. Vendor exotics (Codex execpolicy / network amendments) are not offered; the chosen native option is recorded in `raw` / `providerRefs`.

A request stays open until `respondToRequest`; the controller surfaces it as a Notification and in the session view ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). `interrupt` on a session with an open request resolves it as `cancel` (spec's consolidated semantics; follows from the park-and-resume abort caveat in section 8.2).

### 6.6 Usage and ops

- `session.usage.updated { ... }` - a token snapshot: cumulative input / cached input / output / reasoning tokens and, where the harness exposes it, current context usage against the model's window (Claude `context_usage`, Codex `thread/tokenUsage/updated`, pi `message_end.usage`). Cadence differs per harness; the snapshot shape absorbs that. Context usage is what the assistant rotation threshold reads (section 9.2).
- `runtime.warning` - retries (Claude `api_retry`, pi `auto_retry_*`), model rerouting or drift mid-turn, mirror errors.
- `runtime.error { class }` - Codex `codexErrorInfo` is the reference class enum (`ContextWindowExceeded`, `UsageLimitExceeded`, `Unauthorized`, `SandboxError`, ...); other adapters map to the same classes where they can, else `unknown`.

**Open:** the exact field set of the `session.usage.updated` snapshot is not pinned beyond "token snapshot plus context usage".

### 6.7 Trimmed on purpose

Auth, account, rate-limit and MCP-status events are snapshot material (section 3), not session events; rate-limit pushes arriving mid-session lag the probe cadence, accepted for v1. `turn.aborted`, `turn.diff.updated` (diffs come from workspace checkpoints), hooks, realtime audio, files-persisted, and vendor-specific items (review mode, image generation) are dropped; all are additive later via new kinds or `raw`. Claude's long informational tail (`tool_use_summary`, `prompt_suggestion`, 20+ system subtypes) is whitelisted-in and raw-logged otherwise.

## 7. Structured output

An agent step may declare an output schema; the graph routes on the schema-conforming result ([./07-workflows.md](./07-workflows.md), ADR 0008). The runner obtains it by the provider's native-enough mechanism; a closing prompt with parse-and-retry is never used.

| Provider | Mechanism | Result location | Failure signal |
|---|---|---|---|
| Claude Code | `outputFormat: { type: "json_schema", schema }` on `query()`; SDK validates and re-prompts | `structured_output` on the final `result` message | `subtype: "error_max_structured_output_retries"`, or `success` with no `structured_output` (treated as failure per SDK docs) |
| Codex | `outputSchema` on `turn/start` (stable, not experimental-gated); enforced server-side as strict constrained decoding | text of the turn's final `agentMessage` item | turn `failed`, or turn completed with a final item that is not an `agentMessage` (missing output; the adapter may retry with a fresh `turn/start`, default once) |
| pi | `submit_result` tool registered by the Hydra extension file (section 10.3): Typebox parameters = output schema, `terminate: true`, `constrainedSampling: { type: "json_schema", strict: "prefer" }`; pi validates args and feeds violations back to the model | the tool's captured args (carried on `tool_execution_end`; a trailing assistant message is ignored) | agent settled without calling the tool: adapter re-prompts ("You must call submit_result with ...") a bounded number of times (default 2 retries, the research's example figure), then schema-failure |

Normalized outcome, carried as `structuredResult` on `turn.completed` when the session has an `outputSchema`:

```ts
type StructuredResult =
  | { outcome: "ok"; value: unknown }
  | { outcome: "schema-failure"; reason: string }   // validation/retries exhausted, tool never called
// ordinary run failure = turn.completed { state: "failed" } with no structuredResult
```

The runner re-validates `value` against the declared schema before routing, on every provider (cheap, catches harness regressions, one uniform error surface). Schemas are linted at workflow validation ([./07-workflows.md](./07-workflows.md)) against the common strict subset, regardless of which provider the step runs on: OpenAI's strict subset is the binding constraint (`additionalProperties: false`, all properties required), within JSON Schema draft-07 (Claude) and pi-ai's strict-transform subset (no `$ref`, `oneOf`, `patternProperties`). pi string enums compile to `StringEnum`, not unions of literals.

`outputSchema` lives on `SessionSpec` only, and the adapter applies it to **every turn** of that session by the provider's mechanism (Codex re-sends it on each `turn/start`, Claude on each `query()`, pi's extension registers the tool at session start). `TurnInput` never carries it. This works because a session belongs to exactly one agent step and the schema is that step's: iterations re-enter the same session and each yields its own `structuredResult` ([Workflow execution semantics](https://github.com/rogierpennink/hydra/issues/36)).

## 8. Access modes

`AccessMode` is the session-level permission axis the adapter enforces, ordered `approval-required < auto-accept-edits < auto < full-access`. Meaning: approval-required asks for every side-effecting action; auto-accept-edits allows file edits, asks for the rest; auto lets a harness-side reviewer judge routine actions; full-access allows everything.

### 8.1 Mapping table (normative)

| Hydra mode | Claude Code | Codex | pi |
|---|---|---|---|
| approval-required | SDK default mode + `canUseTool` parks -> `request.opened`, resumes on decision | `approvalPolicy: "untrusted"` + `sandbox: "read-only"`; approvals arrive as server-to-client requests | `tool_call` handler parks -> `request.opened`, resumes on decision (native park-and-resume) |
| auto-accept-edits | `permissionMode: "acceptEdits"` | `approvalPolicy: "on-request"` + `sandbox: "workspace-write"` | handler allows edit/write tools, parks the rest |
| auto | `permissionMode: "auto"` (native) | `approvalsReviewer: "auto_review"` (native) | unsupported (falls back, section 8.4) |
| full-access | `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` | `approvalPolicy: "never"` + `sandbox: "danger-full-access"` | handler allows all |

Claude and pi are park-and-resume providers: the approval seam is an awaited callback (`canUseTool`; pi's `tool_call` extension handler, awaited with no timeout, verified in source at v0.84.x) that the adapter does not return from until `respondToRequest` arrives; `undefined` / allow lets the call execute as-is, deny returns a reason the model sees. Codex is the RPC-approval provider: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/fileRead/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request` and `item/permissions/requestApproval` are server-to-client JSON-RPC requests the adapter MUST answer or the turn hangs; each maps to a `request.opened` and is answered from the decision (`accept` / `acceptForSession` / `decline` / `cancel`).

The earlier pi degradation (deny-with-reason and retry after approval) is withdrawn.

### 8.2 Park-and-resume build caveats

From `research/pi-approval-parking.md` (branch `research/pi-approval-parking`), binding for the pi adapter and analogous for Claude:

- **Race the parked decision against `ctx.signal`.** pi's `abort()` only flips the AbortController; the loop checks it after the handler resolves. The handler returns promptly on abort so `interrupt` passes through a parked approval.
- **A park serializes the tool batch**: preflights run sequentially and sibling calls wait for all preflights. Same shape as Claude; accepted.
- **Handler exceptions deny fail-safe**: wrap the wait so an IPC failure produces a clear deny reason, never a silent allow.
- **No contractual guarantee** (pre-1.0): pin the pi version and ship a regression test asserting that a pending `tool_call` handler delays execution.
- **The park is bridged in-band over RPC**: the Hydra extension's `tool_call` handler blocks on `ctx.ui`, which RPC mode surfaces as an `extension_ui_request` on stdout; the adapter answers with `extension_ui_response` when `respondToRequest` arrives. No side channel.
- While parked no LLM connection is held open; the turn stays active; `tool_execution_start` has already fired, so the UI overlays "awaiting approval" on the started item.
- On Claude, `canUseTool` is reached only when the pipeline falls through to a prompt; auto-approved tools never hit it. That is the intended behaviour for the mapped modes. A `PreToolUse` hook is the seam if every call must be observed.

### 8.3 Codex sandbox caveats

Sandboxing is enforced by Codex (Seatbelt on macOS, bubblewrap on Linux; WSL1 unsupported). `thread/shellCommand` and `process/spawn` bypass it entirely; the adapter never calls them. `thread/start` with `workspace-write` marks the cwd trusted in the instance's `config.toml`; with `CODEX_HOME` isolated per instance (section 9) this touches no user config.

### 8.4 Fallback policy

- The definition declares support per mode; the controller resolves any unsupported mode to a supported one **before session start**. `SessionSpec.accessMode` therefore always names a natively supported mode and adapters carry no fallback logic.
- The fallback chain is **hardcoded in v1**, not configurable, and **strictly downward** on `approval-required < auto-accept-edits < auto < full-access`: the substitute is the nearest less-permissive supported mode. Shipped result: `auto -> auto-accept-edits` (auto always allows edits, so ask-everything was overly punitive). If no equal-or-less-permissive supported mode exists, session start fails with a clear error. Guardrail owned by [./13-security.md](./13-security.md).
- The UI keeps every mode selectable and annotates the substitution from declaration plus policy ("runs as auto-accept-edits on this provider"). The Session record stores both `requestedAccessMode` and the effective `accessMode` ([./02-domain-model.md](./02-domain-model.md)); the fallback chain is stated in ADR 0007 and the glossary ([../../CONTEXT.md](../../CONTEXT.md)) as amended.

## 9. Provider-home isolation and compaction control

### 9.1 Per-instance isolated provider homes

Every provider instance has its own isolated provider home (one instance = one login = one home; never per session), and every session runs inside its instance's home, so user-global instructions, skills, packages and memory never leak into Hydra sessions (constraint from the [memory-interface prototype](https://github.com/rogierpennink/hydra/issues/31): Codex picked up `~/.codex/AGENTS.md` and pi discovered `~/.claude/skills` until isolated). The handed knobs are the config-dir variables, `--setting-sources project`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; the rest of the table are spec additions supported by the research:

**Open:** isolation also keeps the user's own skills, subagents and instructions (`~/.claude/{skills,agents,CLAUDE.md}`, `~/.codex/AGENTS.md`, pi's skill directories) out of every session, which is right for assistant sessions and wrong for the Thread the user starts by hand ([./02-domain-model.md](./02-domain-model.md)) expecting exactly that material. Which session kinds see it, and whether v1 links the user's directories per runner or Hydra owns that knowledge per Agent, is [User knowledge in Hydra sessions](https://github.com/rogierpennink/hydra/issues/52)'s.

| Provider | Isolation |
|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` per instance (never `HOME`: relocating `HOME` breaks the macOS Keychain lookup and the CLI reports "Not logged in"); `settingSources: ["project"]` (the SDK equivalent of `--setting-sources project`) so only the workspace's own `.claude/` loads, plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (auto memory loads regardless of setting sources); `strictMcpConfig: true` so only `SessionSpec.mcpServers` apply. The `env` option replaces the subprocess environment: spread the runner's base env, then session env. |
| Codex | `CODEX_HOME` per instance; the app-server process is started with it. |
| pi | `PI_CODING_AGENT_DIR` per instance; launched with `--no-extensions --no-skills --no-prompt-templates --no-themes --no-approve` so nothing in the agent dir or the project's `.pi/` loads (arbitrary TS, supply-chain surface); the Hydra extension alone is passed explicitly with `-e`, which loads even under `--no-extensions`. |

The instance's config dir is also where the vendor login lives, which is why the home is per instance on every provider.

**Every workspace-less session gets an empty scratch cwd, and context-file loading is off.** "`cwd: null`" would mean `process.cwd()` on every harness (Claude Agent SDK and pi both default to it), and both read instruction files from there: pi loads `AGENTS.md` / `CLAUDE.md` from the cwd, every parent directory and `~/.pi/agent/`; the Claude SDK loads the cwd's `CLAUDE.md` whenever `settingSources` includes `project`. So a workspace-less session could silently pick up a file from the runner's install directory. Rule ([Assistant runtime](https://github.com/rogierpennink/hydra/issues/40)): the runner provisions an **empty scratch directory** (not a Workspace) as cwd for every workspace-less session on every harness, and the adapter disables context-file discovery - Claude `settingSources: []`, pi `--no-context-files`. Codex has no system-prompt parameter and takes instructions only as `AGENTS.md` in the cwd, so the Codex adapter materializes `systemPrompt` into `AGENTS.md` in *its* scratch directory; no other harness can see that directory, so nothing is duplicated. `ProviderRunnerContext.cwd` is therefore never `null` in practice; the type keeps `null` for "no workspace" semantics at the controller.

**Verify at build time:** whether the Codex app-server protocol (`thread/start` `personality`, per-turn params, or a developer-instructions field) offers a proper system-prompt channel; if it does, prefer it and keep the scratch cwd only because `thread/start` requires one.

### 9.2 Compaction control

For assistant sessions ([./12-assistants.md](./12-assistants.md)) provider-native auto-compaction is disabled and Hydra rotates at its own context threshold:

| Provider | Disable auto-compaction |
|---|---|
| Claude Code | `DISABLE_COMPACT=1` in the session env (the `--autocompact` flag equivalent) |
| Codex | `model_auto_compact_token_limit` set out of reach via the instance's `config.toml` in `CODEX_HOME` |
| pi | RPC `set_auto_compaction: false` at session start |

The adapter reports context usage through `session.usage.updated`; the controller compares it against the rotation threshold (`min(0.7 x window, 200k tokens)` by default, checked after every `turn.completed`). Rotation itself (one flush turn on the dying session, then a fresh session with core memory and topic index injected) is the assistant subsystem's contract ([./12-assistants.md](./12-assistants.md)). Sessions of agents that are not assistants keep native compaction on; `context_compaction` items make it visible.

**Memory injection mapping (pinned).** The controller composes `SessionSpec.systemPrompt` for an assistant session as: the agent's `systemPrompt` (persona), the hydra-as-a-tool skill (section 9.3), then a `## Memory (core)` section and a `## Memory topics` index, volatile content last. It lands in the harness's system-prompt channel on every provider:

| Provider | Channel |
|---|---|
| Claude Code | the SDK's `systemPrompt` option (a plain string, not the preset-plus-append form, so nothing of the CLI's default prompt leaks in) |
| Codex | `AGENTS.md` in the session's scratch cwd (section 9.1), Codex's only instruction channel |
| pi | the session's system prompt parameter |

Never the first user turn: memory is standing context, and a synthetic first message would show in the conversation view as a message nobody sent.

**Verify at build time:** the exact knob names above are as observed in the prototype; confirm each against the pinned harness version.

### 9.3 Session environment and skills

The runner injects, per session: `HYDRA_API_URL`, `HYDRA_TOKEN` (the session token; dies with the session), `HYDRA_SESSION=1` (makes the `hydra` CLI refuse file credentials), plus the git credential material (`GH_TOKEN`, `GIT_CONFIG_*`) whose mechanics [./13-security.md](./13-security.md) owns (session token: [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)). The runner makes the `hydra` binary reachable from the session by prepending its own bin directory to `PATH` ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §2), so `which hydra` works and the skill text stays portable. One provider-agnostic skill source describes hydra-as-a-tool; each adapter materializes it into its harness's native form (Claude skill file under the session's project settings, Codex `AGENTS.md` section, pi prompt/skill file) at session start.

## 10. Per-provider build notes

### 10.1 Claude Code (Agent SDK)

- **Surface**: `query()` async generator of typed `SDKMessage` plus the `Query` control object (`interrupt`, `setPermissionMode`, `setModel`, `streamInput`, `getContextUsage`, `close`). One long-lived `query()` per session in streaming-input mode (required for the control methods and for steering); `includePartialMessages: true` for deltas. Session id on the init message and every `result`.
- **Process**: each session is one Claude Code CLI subprocess, about 1 GiB RAM as a starting point, memory growing over long sessions; no built-in timeout, no per-subagent deadline. The runner's supervisor owns deadlines and recycling; `maxConcurrentSessions` derives from RAM (~1 session per 2 GiB, [./03-controller-and-runners.md](./03-controller-and-runners.md)). Subagent caps via `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` / `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and `maxBudgetUsd`.
- **Binary**: `pathToClaudeCodeExecutable` points at the runner-installed `claude` (`ctx.binary`; the SDK spawns it without a shell). The SDK's bundled per-platform CLI packages are excluded from the Hydra build; the installed CLI is floor-pinned to the SDK's own version - SDK 0.3.N pairs with CLI 2.1.N, and newer CLI with older SDK is the supported direction ([ADR 0028](../adr/0028-provider-harnesses-are-runner-installed-executables.md), [./15-packaging-and-operations.md](./15-packaging-and-operations.md) §12).
- **Auth**: delegation only. The CLI holds its own login in the instance's `CLAUDE_CONFIG_DIR` (Linux: `.credentials.json` in that dir; macOS: a Keychain item keyed per config dir - `Claude Code-credentials-<hash of dir>` - so instance logins never collide with each other or with the user's personal login; when the Keychain rejects the write, e.g. locked over SSH, the CLI falls back to `.credentials.json` in the config dir. `HOME` is never overridden). Hydra never reads, extracts, or refreshes vendor tokens. API-key / Bedrock / Vertex routes are instance env (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK=1`, ...), not separate code paths. The read-only probe reads `AccountInfo` (email, subscription type, `apiProvider`) from the init message.

**Risk:** Claude subscription auth. Research #2 (`research/claude-agent-sdk.md`) read Anthropic's Agent SDK policy as forbidding it ("Claude.ai subscription login is not permitted ... Hydra must design around API-key billing"); tickets 22 and 23 and the charting decision accept the t3-code posture (the user's own tool driving the user's own login through the unmodified vendor CLI; the prohibition targets products offering claude.ai login to other users). The decision stands; the risk that Anthropic reads it the other way is on record. API-key / Bedrock / Vertex remain first-class on the same instance config.
- **Resume / fork**: `resume: <id>` (+ `forkSession: true`); transcripts under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/`; same-runner only (the alpha `sessionStore` mirror is not used in v1). `persistSession: false` for probes.
- **Sharp edges**: single-shot `query()` throws after yielding an error result (wrap iteration); `env` replaces the subprocess env; MCP tools need explicit allow rules (`acceptEdits` does not auto-approve them); `AskUserQuestion` and `ExitPlanMode` are intercepted in `canUseTool` and mapped to `user_input` / `plan`.
- **Stability**: 0.x semver, weekly releases version-locked to the CLI, several breaking changes shipped. Pin the exact SDK version; the installed CLI floats above the floor (version policy in [./15-packaging-and-operations.md](./15-packaging-and-operations.md) §12); treat CLI-version-gated behaviour as part of the adapter contract; keep the SDK entirely behind the adapter seam.

### 10.2 Codex (app server)

- **Transport**: spawn `codex app-server` (CLI from npm `@openai/codex` or the static-binary installer), newline-delimited JSON-RPC 2.0 over stdio with the `jsonrpc` field **omitted on the wire**; a thin Hydra-owned codec, not a strict JSON-RPC library. One `initialize` + `initialized` per connection; `capabilities.experimentalApi` stays off - the stable surface keeps deprecated fields for compatibility, the experimental surface promises nothing, and t3code's opting into experimental is prior art to avoid, not follow (pinned, [#43](https://github.com/rogierpennink/hydra/issues/43)). WebSocket transport is explicitly unsupported.
- **Model**: Thread > Turn > Item maps 1:1 onto Session > Turn > Item. `thread/start` (`model`, `cwd`, `approvalPolicy`, `sandbox`, `ephemeral`), `thread/resume`, `thread/fork`, `turn/start` (per-turn `model`, `outputSchema`), `turn/steer`, `turn/interrupt`. Notifications `turn/started` -> `item/started` -> deltas -> `item/completed` -> `turn/completed`; usage via `thread/tokenUsage/updated`. Unknown notifications are ignored for forward compatibility.
- **Approvals**: server-to-client requests (section 8.1); the adapter implements every request handler even where the answer is always decline.
- **Process ownership**: topology unpinned; suggested one app-server process per instance per runner (section 4.1). Single-writer per thread; the server unloads idle unsubscribed threads after 30 minutes and emits `thread/closed` (maps to `session.exited`, resumable).
- **Errors**: `-32001` overload -> retry with exponential backoff and jitter; mid-turn `error` notifications with `codexErrorInfo` feed `runtime.error { class }`.
- **Auth**: ChatGPT OAuth or API key via `account/*`; credentials in `$CODEX_HOME/auth.json` (file store default); tokens auto-refresh. `cli_auth_credentials_store` stays `file` on runners.
- **Stability**: no cross-version protocol guarantee. Pin the CLI release, generate types with `codex app-server generate-ts` for that release, regenerate and re-verify on every upgrade.

### 10.3 pi (standalone binary, RPC mode)

- **Hosting**: pi runs as its own executable - the official standalone Bun-compiled binary, installed per runner ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §12) - one `pi --mode rpc` child process per session, LF-delimited JSONL over stdio. This supersedes the earlier SDK-in-a-child-host consolidation (decided 2026-08-31, [#43](https://github.com/rogierpennink/hydra/issues/43)): an external binary keeps pi independently updatable like the other two harnesses, the RPC protocol is the contract instead of a pre-1.0 TypeScript API, and no pi code compiles into the Hydra binary. Launch: `--mode rpc --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve -e <hydra extension>`, `--session-dir` under the instance home, `--session-id` so Hydra picks the session id up front.
- **The Hydra extension file**: one TypeScript file materialized into the instance home at session start and loaded with `-e` (explicit paths load even under `--no-extensions`; jiti and typebox ship inside pi's binary, so the extension's imports resolve). It carries the two seams RPC lacks: the awaited `tool_call` hook for approvals (section 8.2: parks on `ctx.ui`, bridged as `extension_ui_request` / `extension_ui_response`) and the `submit_result` structured-output tool (`pi.registerTool`, `terminate: true`; section 7).
- **Surface**: `prompt` / `steer` / `follow_up` / `abort`; events `agent_start` .. `agent_settled`, `turn_*`, `message_*` deltas, `tool_execution_*`, compaction and retry events; `set_model`, `set_thinking_level`, `set_auto_compaction`; `get_session_stats` (tokens, cost, context usage). Sessions are tree-structured JSONL files under the instance dir; resume via `--session <id>`, fork via `--fork <id>` or in-process `fork {entryId}`.
- **Absent by design**: subagents, plan mode, MCP (verify). Declared, not emulated.
- **Auth**: multi-provider. The pinned v1 path is API-key auth - z.ai coding plan: provider `zai` (or `zai-coding-cn`), the key a `provider-instance` secret injected as `ZAI_API_KEY`. OAuth logins exist but are TUI-only (`/login`, no headless command); the fleet UI shows the copy-paste command as the fallback ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §12). `auth.json` in the instance dir holds raw vendor tokens (plain file on every OS); Hydra never touches it. Probe: `pi auth check --provider <id> --json`.
- **Stability**: pre-1.0 (0.84.x), repeated RPC breaking changes, no protocol version on the wire (0.84.0 changed `message_update` to deltas, 0.43.0 renamed `branch` to `fork`, 0.32.0 split the queue commands). The tested-max version policy ([./15-packaging-and-operations.md](./15-packaging-and-operations.md) §12) matters most here; gate on `pi --version`, and regression-test the awaited `tool_call` park and `terminate` handling on every bump.

**Verify at build time:** the Hydra extension file against the pinned pi version (`tool_call` hook and `registerTool` API churn), and the strict LF JSONL framing.

## 11. Provider install portability and per-runner login

Installs are one command per provider (all three are self-contained binaries: Claude Code and Codex native, pi Bun-compiled) and are installed at runner join with a floor-pinned version policy ([ADR 0028](../adr/0028-provider-harnesses-are-runner-installed-executables.md), [./15-packaging-and-operations.md](./15-packaging-and-operations.md) §12); credentials are not distributed. Per-runner login is the durable model: refresh-token rotation with reuse detection (documented for Codex, structurally identical in pi, undocumented for Claude) makes two live copies of one credential log each other out. Hydra therefore drives each provider's own headless login on the runner as a post-join step from the fleet UI ([./03-controller-and-runners.md](./03-controller-and-runners.md) §3.3), relaying the device code or login URL to the user's browser. The per-provider login flows are listed in [./15-packaging-and-operations.md](./15-packaging-and-operations.md) section 12. Copying a credential file remains a bootstrap shortcut owned by exactly one runner afterwards. All three vendors permit the user's own account on the user's own machines; prohibitions target sharing with other people. Credential posture: [./13-security.md](./13-security.md). Findings: `research/provider-portability.md` (branch `research/provider-portability`).

## 12. Cost and usage

v1 records, per session, every `session.usage.updated` snapshot and, per turn, `usage` and `costUsd` on `turn.completed` when the harness reports them: Claude `total_cost_usd`, pi `usage.cost.total`; Codex reports token usage but no cost (subscription plans), so `costUsd` is absent there. There is **no rate-table pricing in v1**: Hydra never multiplies tokens by a price list, and unpriced usage stays unpriced. `costUsd` is the slot a later cost dashboard reads; t3-code's transcript-scanning usage subsystem is the reference for that later work.

## Post-v1

- Runner-side provider execution lifted into the provider plugin (v1: built-in, plugin-shaped).
- `readThread` / `rollbackThread` with the checkpoint/revert feature (v1 keeps fork and the normalized stream as the record).
- Plugin-contributed MCP tools through `SessionSpec.mcpServers` (v1 keeps the field).
- Rate-table cost pricing and a cost dashboard (v1 keeps `costUsd` and usage snapshots).
- Cross-runner session resumability via transcript mirroring (v1 pins sessions to their runner).
- Additional stream kinds (`reasoning_summary_text`, tool-argument streaming) and item kinds (review mode, image generation) as open-enum additions.
- Hydra-level OS sandboxing as a probed runner capability (ADR 0003).
- ACP-based adapters (Cursor and similar) need an extension-method seam beyond `sessionUpdate` mapping.
- **Reusing the user's existing local login, and moving logins between runners** - strongly wanted (noted 2026-09-01 by [Web app details](https://github.com/rogierpennink/hydra/issues/45)): adopting the `claude` / `codex` / `pi` login already on the user's laptop instead of a fresh paste-a-code per instance, `claude setup-token` (one year, no rotation to race) as the Claude path, and Hydra shuffling tokens so a new runner needs no login at all; together with the instance-level "use my own binary and my own login" opt-in that skips home isolation (section 2.1 lists the binary half). The blocker to reopen is the refresh-token rotation fact from ticket #23; `setup-token` is why it may be solvable for Claude specifically.

## Sources

Tickets:

- [Provider adapter interface (#12)](https://github.com/rogierpennink/hydra/issues/12), all addenda
- [Research: cross-harness validation matrix (#25)](https://github.com/rogierpennink/hydra/issues/25)
- [Research: pi approval parking (#26)](https://github.com/rogierpennink/hydra/issues/26)
- [Research: structured output across provider harnesses (#28)](https://github.com/rogierpennink/hydra/issues/28)
- [Research: Claude Agent SDK (#2)](https://github.com/rogierpennink/hydra/issues/2)
- [Research: Codex app-server protocol (#3)](https://github.com/rogierpennink/hydra/issues/3)
- [Research: pi.dev SDK (#4)](https://github.com/rogierpennink/hydra/issues/4)
- [Research: t3-code's provider integration (#22)](https://github.com/rogierpennink/hydra/issues/22)
- [Research: portable provider installs & credentials (#23)](https://github.com/rogierpennink/hydra/issues/23)
- [Assemble the v1 spec (#21)](https://github.com/rogierpennink/hydra/issues/21), handed constraints from #31
- [Security & secrets model (#18)](https://github.com/rogierpennink/hydra/issues/18), fallback guardrail
- [Plugin architecture (#11)](https://github.com/rogierpennink/hydra/issues/11), MCP passthrough
- [Agent-operates-system surface (#16)](https://github.com/rogierpennink/hydra/issues/16), session env and skills
- [Controller/runner architecture (#7)](https://github.com/rogierpennink/hydra/issues/7), probed facts and placement
- [Research: Bun compile feasibility (#34)](https://github.com/rogierpennink/hydra/issues/34)
- [Runner substrate details (#43)](https://github.com/rogierpennink/hydra/issues/43): `ProviderRunnerContext`, instance config vs paths, `provider-instance` secrets, pi RPC posture, harness delivery and version policy

ADRs: [0007](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md), [0002](../adr/0002-orchestration-stays-on-the-controller.md), [0003](../adr/0003-sessions-run-as-bare-processes.md), [0018](../adr/0018-hydra-ships-as-one-self-contained-binary.md).

Research: `research/claude-agent-sdk.md` (branch `research/claude-agent-sdk`), `research/codex-app-server.md` (branch `research/codex-app-server`), `research/pi-sdk.md` (branch `research/pi-sdk`), `research/pi-approval-parking.md` (branch `research/pi-approval-parking`), `research/event-taxonomy-matrix.md` (branch `research/event-taxonomy-matrix`), `research/structured-output.md` (branch `research/structured-output`), `research/t3code.md` (branch `research/t3code`), `research/provider-portability.md` (branch `research/provider-portability`), `research/bun-compile.md` (branch `research/bun-compile`).
