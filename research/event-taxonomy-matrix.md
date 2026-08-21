# Research: cross-harness validation matrix for the normalized event taxonomy

Resolves [#25](https://github.com/rogierpennink/hydra/issues/25). Validates the tentatively-locked v1 event taxonomy from the [#12 resolution](https://github.com/rogierpennink/hydra/issues/12) against six products. Feeds [#21](https://github.com/rogierpennink/hydra/issues/21) (assemble the v1 spec).

**Verdict up front: the abstraction level is right.** Every hydra event type and item kind has a defensible source or a well-understood adapter inference in all six products, and nothing any product emits forces a new event family. Four concrete amendments (section 8): the pi turn bracket is `agent_start..agent_settled`, not `agent_end`; approval decisions need a scope (`allow` vs `allow-always`) plus `cancel`; add `file_read_approval` as a fifth request kind; define a precedence rule for Codex reasoning-summary deltas.

## 1. Sources

| Product | Source, version |
|---|---|
| t3-code | Local clone (2026-08-20): `packages/contracts/src/providerRuntime.ts` (the ~48-type `ProviderRuntimeEvent` union), adapters in `apps/server/src/provider/Layers/` (Claude, Codex, Cursor, OpenCode, Grok) |
| Claude Agent SDK | Shipped types in `@anthropic-ai/claude-agent-sdk@0.3.238` (`sdk.d.ts`, `sdk-tools.d.ts`) cross-checked against [code.claude.com/docs/en/agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript); prior findings on `research/claude-agent-sdk` |
| Codex app-server | [app-server README at rust-v0.148.0](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md); prior findings on `research/codex-app-server` |
| pi | Source at `earendil-works/pi` HEAD `5cd93f6` (2026-08-20, 0.84.x): `packages/agent/src/types.ts` (AgentEvent), `packages/coding-agent/src/core/agent-session.ts` (AgentSessionEvent), `docs/rpc.md`; prior findings on `research/pi-sdk` |
| Cursor / ACP | ACP v1 schema of record ([agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol), `agent-client-protocol-schema/src/v1/*.rs`), docs at [agentclientprotocol.com](https://agentclientprotocol.com/protocol/v1/prompt-turn); Cursor's first-party [CLI ACP doc](https://cursor.com/docs/cli/acp) incl. its `cursor/*` extensions |
| OpenCode | `sst/opencode` HEAD (2026-08-21, SDK 1.18.19): `packages/sdk/js/src/gen/types.gen.ts` (v1 Event union), `packages/schema/src/*` (v2 vocabulary), [opencode.ai/docs/server](https://opencode.ai/docs/server/) |

Reading key for the matrix cells: **bold** = native counterpart exists (direct mapping); plain = adapter inference (stated); "—" = no native source, adapter synthesizes or the concept is absent from that product.

## 2. Session events

| Hydra | t3-code | Claude Agent SDK | Codex app-server | pi | Cursor (ACP) | OpenCode |
|---|---|---|---|---|---|---|
| `session.started` | **`session.started`** (+ `session.configured`, `thread.started`) | **`system`/`init` message** (session_id, model, tools, MCP statuses) | **`thread/started`** notification after `thread/start`·`resume`·`fork` | — `createAgentSession()` resolving; adapter emits | `session/new` / `session/load` response (sessionId); adapter emits | **`session.created`** event |
| `session.exited { reason }` | **`session.exited`** {reason, recoverable, exitKind} | CLI subprocess exit / generator end; `system`/`worker_shutting_down` as advance notice | **`thread/closed`** (idle unload) or process exit | child host-process exit; adapter emits | process exit or `session/close`; adapter emits | **`server.instance.disposed`** / `session.deleted` |

All six fit. Session start is native or trivially adapter-emitted everywhere; exit is process supervision in the four subprocess-shaped products, which matches hydra's runner-side session supervisor owning the process anyway.

## 3. Turn events

| Hydra | t3-code | Claude Agent SDK | Codex app-server | pi | Cursor (ACP) | OpenCode |
|---|---|---|---|---|---|---|
| `turn.started { model? }` | **`turn.started`** (Codex native id, Claude adapter-minted) | adapter-minted at `sendInput`; per-turn `system`/`init` carries model | **`turn/started`** (native turn id) | **`agent_start`** (episode start; no id — adapter mints) | adapter-minted when issuing `session/prompt` (no native turn id) | adapter-minted at prompt POST; `session.status {busy}` confirms (v2: `session.next.prompted`) |
| `turn.completed { state, usage?, costUsd?, error? }` | **`turn.completed`** {state incl. `cancelled`, stopReason, usage, modelUsage, totalCostUsd} | **`result` message** — "exactly one per turn": subtype success/error_*, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`; `session_state_changed {idle}` as secondary signal | **`turn/completed`** {status: completed·interrupted·failed, error}; usage arrives separately (`thread/tokenUsage/updated`); no cost | **`agent_settled`** (see §5 — NOT `agent_end`); state from last assistant `stopReason` (stop·error·aborted), usage on `message_end` | **`session/prompt` response** `stopReason` (end_turn·max_tokens·max_turn_requests·refusal·cancelled); usage on response is UNSTABLE | **`session.status {idle}`** + assistant `message.updated` with `time.completed`/`finish`; error via `session.error`; cost+tokens on the assistant message |

State mapping: hydra `interrupted` ⇐ Codex `interrupted`, ACP `cancelled`, Claude abort terminal reasons, pi `aborted`, OpenCode `MessageAbortedError`; hydra `failed` ⇐ ACP `refusal`/`max_*`, Claude `error_*` subtypes, others' error paths. t3's extra `cancelled` state collapses into `interrupted` losslessly for hydra's purposes (both mean "ended by intervention"). Synthetic turns for unsolicited output remain necessary only on OpenCode (server can emit session events outside a prompt) and Claude (task notifications after result) — both already planned.

## 4. Item kinds (`item.started|updated|completed`)

| Hydra kind | t3-code | Claude Agent SDK | Codex app-server | pi | Cursor (ACP) | OpenCode |
|---|---|---|---|---|---|---|
| `user_message` | **`user_message`** | **`user` messages** (+ `isReplay` echo) | **`userMessage`** item | **`message_start/end`** role user (steering appears mid-turn) | `user_message_chunk` (replay/load only; adapter assembles) | **`UserMessage`** via `message.updated` |
| `assistant_message` | **`assistant_message`** | **`assistant` messages** — one per completed content block, correlate by `message.id` | **`agentMessage`** item | **`message_*`** role assistant | `agent_message_chunk` — chunks only, **no message/item id in v1**; adapter synthesizes item boundaries (t3 does exactly this) | **text part** of assistant message |
| `reasoning` | **`reasoning`** | **`thinking` blocks** | **`reasoning`** item | `thinking_*` events inside `message_update` | `agent_thought_chunk` (same synthesis) | **reasoning part** |
| `command_execution` | **`command_execution`** | tool name inference (Bash/Shell `tool_use` block) | **`commandExecution`** item | `tool_execution_*` with toolName `bash` | `tool_call` **kind `execute`** | tool part, name inference (`bash`) |
| `file_change` | **`file_change`** | tool name inference (Edit/Write/Patch) | **`fileChange`** item | `tool_execution_*` with edit/write | `tool_call` **kind `edit`/`delete`/`move`** + `diff` content | tool part name inference; also `file.edited`, `patch` part |
| `tool_call {kind: mcp\|native}` | `mcp_tool_call` + `dynamic_tool_call` (split) | `tool_use` blocks; MCP detected by `mcp__server__tool` naming | **`mcpToolCall`** item; client-hosted tools via `item/tool/call` | `tool_execution_*` (custom/native tools; **no MCP support** — #12 already flags verify-at-build) | `tool_call` kinds `other`/`fetch`/`think`…; no MCP distinction (inference or `_meta`) | tool part; MCP by tool-name inference |
| `web_search` | **`web_search`** | `server_tool_use`/`web_search_tool_result` blocks or WebSearch tool name | **`webSearch`** item | — (only if registered as custom tool) | `tool_call` kind `search`/`fetch` (lossy inference) | `websearch` tool part (name inference) |
| `subagent` | `collab_agent_tool_call` + `task.*` event family | **Agent `tool_use`** + `system` task_started/progress/updated/notification, `parent_tool_use_id` attribution | **`collabToolCall`** item + `collabAgent/*` notifications | — (subagents deliberately absent) | — in ACP v1; **Cursor `cursor/task` extension notification** (explore/shell/browser_use/…) | **`task` tool → `subtask` part + child session** (`parentID`); child activity = ordinary events on child sessionID |
| `plan` | **`plan`** item + `turn.plan.updated` + `turn.proposed.*` | **`ExitPlanMode` tool_use** (plan markdown in tool result); TodoWrite-era gone | **`plan`** item + `turn/plan/updated` steps | — (plan mode deliberately absent) | **`plan`** session update (entries, full replace); Cursor also `cursor/create_plan` + `cursor/update_todos` | plan-mode tool part; `todo.updated` event |
| `context_compaction` | **`context_compaction`** | **`system`/`compact_boundary`** (+ `status` compacting) | **`contextCompaction`** item | **`compaction_start/end`** {reason: manual·threshold·overflow} | — stable v1 (compaction_update is UNSTABLE); raw-only until stabilized | **`session.compacted`** + `compaction` part + summary-flagged message |
| `error` | **`error`** | `result` error subtypes, assistant `error` field, `permission_denied` | **`error` notification** with `codexErrorInfo` enum | assistant `stopReason: "error"` + `errorMessage` | — (JSON-RPC errors; `notice` is UNSTABLE) | **`session.error`** (typed error union) |
| `unknown` | **`unknown`** | forward-compat catch-all everywhere — every vocabulary explicitly grows (SDK doc comment, ACP non_exhaustive enums, Codex UNSTABLE notifications, OpenCode v2 migration) | | | | |

Item **status** `completed|failed|declined`: `declined` is native only in Codex (`item/completed` after a declined approval); everywhere else the adapter infers it from its own approval-denial bookkeeping (Claude deny → error tool_result + `permission_denied`; OpenCode reject → tool `error` state; ACP reject → `failed` status). Acceptable: the adapter is the party resolving the request, so it has the information by construction.

Item **ids**: native in Codex (item id), OpenCode (part/call id), pi (toolCallId; message events carry the message), Claude (tool_use id / message.id), ACP (toolCallId only — assistant/reasoning item ids are synthesized, v2 will add MessageId).

## 5. Turn bracketing per harness (special attention #1)

Hydra's definition — turn = user-visible episode, input until agent idle — survives all six, with one correction:

- **Claude**: the `result` message is the documented authoritative bracket ("the CLI emits exactly one result message per turn"); `session_state_changed {state: idle}` is the secondary signal. No native turn id — adapter-minted, as #12 assumed. Informational messages (task notifications) can trail the result → synthetic-turn rule needed, as #12 assumed.
- **Codex**: fully native, `turn/started`..`turn/completed` with real turn ids. The reference implementation of hydra's model.
- **pi — the #12 "verify at build time" item, now verified, with a correction**: pi's `turn_start`/`turn_end` is one LLM round-trip (assistant response + its tool batch) — maps to item grouping, not hydra turns, as #12 guessed. But the episode bracket is **`agent_start`..`agent_settled`, not `agent_end`**: `agent_end` fires once per low-level run and one user submission can produce several runs (auto-retry, overflow-compaction re-prompt, queued follow-ups) — it even carries `willRetry`. `agent_settled` is the documented "will not continue automatically" idle marker (`docs/rpc.md`; `agent-session.ts` `_emitAgentSettled`). Amendment A1.
- **Cursor/ACP**: the `session/prompt` request/response pair brackets the turn; every `session/update` in between belongs to it. No turn id anywhere in the protocol (confirmed against schema, v1 and v2) — adapter-minted. `session/cancel` → response `stopReason: cancelled`.
- **OpenCode**: no first-class turn. Bracket = prompt POST .. `session.status {idle}` (`session.idle` is deprecated in favor of `session.status`); assistant `time.completed` + `finish` confirm at message level. Adapter-minted ids. Note: OpenCode's v2 `session.next.*` family (`prompted`, `step.started/ended`, `text.started/delta/ended`, `tool.called/progress/success/failed`) is converging on exactly hydra's started/delta/completed shape — independent confirmation of the abstraction level.
- **t3-code**: same conclusion reached in production — adapter-minted turn ids for Claude/ACP/OpenCode, native for Codex.

## 6. Approval and request shapes (special attention #2)

| Hydra | t3-code | Claude Agent SDK | Codex app-server | pi | Cursor (ACP) | OpenCode |
|---|---|---|---|---|---|---|
| `request.opened {kind: command_approval}` | **`command_execution_approval`** (+ `exec_command_approval`) | `canUseTool` callback, tool-name classified; adapter parks the promise | **`item/commandExecution/requestApproval`** server→client JSON-RPC request | `tool_call` extension hook on bash (block-or-allow only; parking = #26) | **`session/request_permission`** with `toolCall` kind execute | **`permission.asked`** `permission: "bash"` + patterns |
| `…file_change_approval` | **`file_change_approval`** (+ `apply_patch_approval`) | same, Edit/Write classified | **`item/fileChange/requestApproval`** | hook on edit/write | same, kind edit + diff content | `permission.asked` `"edit"` |
| `…tool_approval` | `dynamic_tool_call` request type | same, other tools | `item/permissions/requestApproval`, MCP elicitation | hook on any tool | same, other kinds | `permission.asked` other types |
| `…user_input` | **`user-input.requested/resolved`** (separate event pair + `tool_user_input`) | **`AskUserQuestion` tool** (1–4 questions, options, multiSelect), intercepted via canUseTool | **`item/tool/requestUserInput`** | — (extension UI protocol in RPC mode) | **Cursor `cursor/ask_question`** extension (blocking) | **`question.asked/replied/rejected`** events |
| (no hydra kind) | **`file_read_approval`** | Read-tool prompts reach canUseTool | **`item/fileRead/requestApproval`** | hook on read | kind `read` permission requests | `permission.asked` `"read"` |
| `request.resolved {decision}` | decision strings incl. `accept`/`acceptForSession`/`decline`/`cancel` | `PermissionResult` allow {updatedInput, updatedPermissions}/deny {message, interrupt?} | decisions: `accept`·`acceptForSession`·`acceptWithExecpolicyAmendment`·`applyNetworkPolicyAmendment`·`decline`·`cancel` | return `{block?, reason?, terminate?}`; mutate input in place | outcome `{selected, optionId}` from agent-offered options (`allow_once`·`allow_always`·`reject_once`·`reject_always`) or `{cancelled}` | POST reply `once`·`always`·`reject` |

Two findings:

1. **Every product except hydra's current draft distinguishes allow-once from allow-for-session/always** (Codex `acceptForSession`, ACP `allow_always`, OpenCode `always`, Claude `updatedPermissions` rule persistence, t3 `acceptForSession`). Hydra's `request.resolved {decision}` and the adapter's `ApprovalDecision` must carry that scope or the adapter cannot express what the user chose. Amendment A2.
2. **File-read approvals are native in three products** (Codex, OpenCode, ACP kind `read`; t3 made it a first-class request type). Hydra's four kinds have no honest home for them — `tool_approval` renders wrong (a read prompt wants a path list, not tool args). Amendment A3.

Also confirmed: folding t3's separate `user-input.requested/resolved` pair into `request.opened {kind: user_input}` loses nothing — every native user-input mechanism (AskUserQuestion, `item/tool/requestUserInput`, `cursor/ask_question`, `question.asked`) is a request/response pair like approvals, and the structured questions ride in `detail`.

## 7. Delta stream kinds (special attention #3)

| Hydra `streamKind` | t3-code | Claude Agent SDK | Codex app-server | pi | Cursor (ACP) | OpenCode |
|---|---|---|---|---|---|---|
| `assistant_text` | **`assistant_text`** | **`stream_event`** → `content_block_delta` `text_delta` (needs `includePartialMessages`) | **`item/agentMessage/delta`** | **`message_update`** `text_delta` | **`agent_message_chunk`** | **`message.part.delta`** (v1 SDK: `part.updated {delta?}`) |
| `reasoning_text` | `reasoning_text` **and** `reasoning_summary_text` (two kinds) | `thinking_delta` (`signature_delta` ignored) | **`item/reasoning/textDelta`** and **`…/summaryTextDelta`** (two channels) | `thinking_delta` | **`agent_thought_chunk`** | reasoning part delta |
| `command_output` | **`command_output`** (+ `file_change_output`) | — no live stdout (`tool_progress` is elapsed-time heartbeat only; output arrives in final tool_result) | **`item/commandExecution/outputDelta`** | `tool_execution_update` `partialResult` — **cumulative snapshot, adapter must diff** | `tool_call_update` content / terminal embeds — collections overwritten, adapter diffs | — v1 (output only at tool completion; v2 adds `tool.progress`) |

Findings: three kinds are the right floor — every product streams assistant text and reasoning; command output streams natively only in Codex/pi/ACP and the others simply produce no `command.output` deltas (acceptable degradation, item.completed carries the output). Two edge decisions:

- **Codex emits raw reasoning and summary reasoning as separate delta channels** and can emit both for one item. Folding both blindly into `reasoning_text` interleaves two texts into one stream. Amendment A4 defines the precedence rule rather than adding a fourth kind.
- **Tool-argument streaming** (Claude `input_json_delta`, ACP `rawInput` updates, OpenCode `pending` state `raw` accumulation, v2 `tool.input.delta`) has no hydra streamKind. t3 dropped it too; args land complete on `item.updated`/`item.completed`. Confirmed fine to omit — additive later as a new streamKind if a UI ever wants live-typing tool args, since `streamKind` is an open enum for consumers.

Coalescing at the store (#9) is unaffected: all six sources produce append-only text per (item, streamKind) once pi's cumulative `partialResult` and OpenCode's snapshot-diffing are handled at the adapter (t3's OpenCode adapter has a proven common-prefix-diff routine for exactly this).

## 8. Usage and ops rows

- `session.usage.updated`: native push in Codex (`thread/tokenUsage/updated`) and ACP (`usage_update` — stable v1, context used/size + cumulative cost); per-turn/per-message in Claude (`result.usage`/`modelUsage`, `context_usage` on assistant messages), pi (`message_end.message.usage` incl. a full cost breakdown), OpenCode (assistant `tokens`/`cost`, per-step on `step-finish` parts). Every product feeds a token snapshot; cadence differs, which a snapshot-shaped event absorbs by design. Confirmed.
- `costUsd` on `turn.completed`: native in Claude (`total_cost_usd`), pi (`usage.cost.total`), OpenCode (`cost`), ACP (`usage_update.cost`); absent in Codex (subscription plans) — matches the field being optional. Confirmed.
- `runtime.warning` / `runtime.error {class}`: sources everywhere — Claude `api_retry`/`mirror_error`/`informational`/`status`, Codex `error` notification with `codexErrorInfo` (a ready-made class enum), pi `auto_retry_*`/`summarization_retry_*`, OpenCode `session.status {retry}`/`session.error`, ACP JSON-RPC errors (+ UNSTABLE `notice`). Confirmed.

## 9. Gap list A — native concepts with no hydra home

Deliberate drops that survive contact (stay dropped, reach them via `raw` if ever needed):

- **Turn diff snapshots** (Codex `turn/diff/updated`, OpenCode `session.diff`, t3 `turn.diff.updated`) — hydra computes diffs from workspace checkpoints instead.
- **Hooks** (Claude `hook_started/progress/response`, t3 `hook.*`) — hydra doesn't surface vendor hooks in v1.
- **Auth/account/rate-limit/MCP-status push events** (Claude `auth_status`/`rate_limit_event`, Codex `account/*`/`account/rateLimits/updated`, t3's five account/MCP event types) — moved to the snapshot path per #12. One caveat worth recording: rate-limit pushes arrive mid-session and the probe cadence will lag them; acceptable for v1 (quota display is a dashboard concern), revisit if quota UX matters.
- **Realtime audio** (t3 `thread.realtime.*`) — t3-specific, no other product has it.
- **Files-persisted / attachment upload** (Claude + t3 `files_persisted`) — t3-specific storage concern.

Genuinely new observations, all absorbable without taxonomy changes:

- **Review mode** (Codex `enteredReviewMode`/`exitedReviewMode` items; t3 promoted them to item types) → hydra `unknown` item kind + raw. Fine until hydra grows a review feature.
- **Image generation/view** (Codex `imageGeneration`/`imageView`, t3 `image_view`) → `unknown` + raw.
- **Mode/model drift events** (ACP `current_mode_update`, Codex model rerouting — t3 `model.rerouted`, Claude `model_refusal_fallback`) → model is stamped on the next `turn.started`; drift mid-turn becomes `runtime.warning`. No dedicated event needed in v1.
- **Slash-command inventories** (ACP `available_commands_update`, Claude `commands_changed`) → capability-snapshot material, not session events.
- **Workspace/environment noise** (OpenCode `file.watcher.updated`, `lsp.*`, `pty.*`, `vcs.branch.updated`; pi `bash_execution_update`) → not session-transcript material; the adapter subscribes narrowly and drops them.
- **Cursor extension traffic** (`cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`, `cursor/task`, `cursor/generate_image`) — not a gap but a design confirmation: an ACP adapter needs an extension-method escape hatch, not just `sessionUpdate` mapping. All five map into existing hydra concepts (user_input request, plan item, plan item update, subagent item, unknown).
- **Claude's long informational tail** (`tool_use_summary`, `prompt_suggestion`, `memory_recall`, `thinking_tokens`, 20+ system subtypes) — the SDK's own doc comment mandates ignoring unknown types; hydra's adapter whitelists what it maps and raw-logs the rest. The `unknown` item kind plus open enums is exactly the right posture.

## 10. Gap list B — hydra concepts with no native source (the inference table)

| Hydra concept | Where inferred, and how |
|---|---|
| Turn ids | Adapter-minted on Claude, pi, ACP, OpenCode (only Codex has them). Confirmed as #12 assumed. |
| `turn.started` as an event | Claude/pi/ACP/OpenCode: emitted by the adapter at dispatch time, not received. Trivial and safe — the adapter is the one dispatching. |
| Assistant/reasoning item boundaries on ACP | v1 streams anonymous chunks; the adapter opens an item on first chunk of a kind and closes it on turn end or kind switch (t3's production approach). v2's MessageId will remove this. |
| `item.status: declined` | Native only in Codex; elsewhere derived from the adapter's own denial bookkeeping. Safe by construction. |
| `user_message {steered: true}` | No product marks steered input in its stream; per #12 the adapter's `sendInput` result is the authority. Validated — no event inference needed anywhere. |
| `web_search` kind | Native item only in Codex; tool-name/kind inference on Claude (server tool blocks), ACP (kind search/fetch), OpenCode; absent on pi. Worst case it degrades to `tool_call` — harmless. |
| `subagent` kind | No source on pi (feature absent — declared capability, fine) and bare ACP (Cursor's extension supplies it). |
| `plan` kind | No source on pi (absent by design). |
| `context_compaction` on ACP | Not in stable v1; raw-only until ACP stabilizes `compaction_update`. |
| `command_output` deltas | No source on Claude and OpenCode v1 — output lands complete on item completion. Degradation, not distortion. |
| `session.exited {reason}` | Process-supervision inference everywhere except OpenCode/Codex which have server-side events. Runner owns the process, so it owns the fact. |

Nothing in this list requires a taxonomy change: every inference is either the adapter reporting its own actions (turn minting, approval outcomes, steering) or a declared capability gap (pi subagents/plan/MCP), both of which #12 already handles via declared capabilities and adapter authority.

## 11. Verdict and amendments

**Confirmed.** The taxonomy sits at the right altitude: it is a strict subset of what t3-code proved in production across the same six-harness spread, every trim (#12's "trimmed from t3's ~48") lands on events that are either vendor-idiosyncratic or snapshot-path material, and OpenCode's own v2 redesign is independently converging on the identical started/delta/completed item shape. No new event families, no removed ones.

Amendments before the #21 spec freeze:

- **A1 — pi turn bracket is `agent_start..agent_settled`.** `agent_end` fires per low-level run; retries, overflow-compaction re-prompts, and queued follow-ups continue the episode past it (`agent_end.willRetry`). `agent_settled` is pi's documented "will not continue automatically" marker and is the `turn.completed` trigger; intermediate `agent_end`s with `willRetry: true` become `runtime.warning` (retry visibility) at most. Replaces #12's "pi's agent_start/end as the bracket".
- **A2 — approval decisions carry scope.** `ApprovalDecision` and `request.resolved {decision}` become `allow | allow_always | deny | cancel` (names bikesheddable; `allow_always` = vendor's for-session/always persistence: Codex `acceptForSession`, ACP `allow_always`, OpenCode `always`, Claude `updatedPermissions`). Without it the adapter cannot express the most common approval UX in five of six products. Vendor-specific exotics (Codex execpolicy/network amendments, ACP's agent-defined option lists) stay adapter-mapped, with the chosen native option recorded in raw/providerRefs.
- **A3 — add `file_read_approval` to request kinds.** Native in Codex (`item/fileRead/requestApproval`), OpenCode (`permission: "read"`), ACP (kind `read`), and first-class in t3. Renders differently from both command and file-change approvals (path/pattern list, no diff). Five kinds total.
- **A4 — reasoning-summary precedence rule (no new streamKind).** Codex streams raw reasoning and summary reasoning as separate channels, potentially both per item. Rule: per reasoning item the adapter picks one channel — raw `textDelta` when present, else `summaryTextDelta` — and emits it as `reasoning_text`; the unpicked channel stays raw-only. Keeps three streamKinds; if a UI later wants both, `reasoning_summary_text` is an additive streamKind (open enum), exactly t3's shape.

Non-normative notes for the spec, no taxonomy change: the ACP adapter needs an extension-method seam (Cursor `cursor/*` is load-bearing for user-input, plan, and subagent mapping); pi/OpenCode/ACP command-output handling must diff cumulative snapshots before emitting deltas; OpenCode's `session.idle` is deprecated — key off `session.status`; the Claude adapter should treat `session_state_changed {idle}` as secondary confirmation of `result`, never primary.
