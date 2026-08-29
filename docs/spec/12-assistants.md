# Assistants

An Assistant is an Agent with persistent Memory and Channel Bindings, oriented toward delegating work rather than doing it. It talks to the user inside Conversations, each backed by a lineage of finite Sessions that rotate through distillation into memory ([ADR 0014](../adr/0014-assistants-remember-through-distilled-memory-not-merged-sessions.md)). Memory is two tiers of assistant-scoped markdown held by the controller and reached only through `hydra memory` operations on the public API ([ADR 0020](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)). This document pins the assistant record, conversations, bindings, wake rules, rotation, memory, the default permission profile, proactivity (unprompted speech, heartbeat), web chat, lifecycle, and what the Discord and Slack channel plugins must provide.

## 1. Assistant

An Assistant is a specialization of Agent, not a separate concept ([../../CONTEXT.md](../../CONTEXT.md)). It is:

- an Agent (controller-owned identity: prompt, provider, permission profile - see [./02-domain-model.md](./02-domain-model.md)),
- plus zero or more Channel Bindings (section 3),
- plus one Memory (section 6),
- plus one Heartbeat (section 8.2).

Rules:

- Several assistants may exist. One default assistant is created at first-run setup ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- There is no persona machinery. A different persona is a different assistant with its own memory. Memory is never shared between assistants (two writers corrupt one memory; rationale in ADR 0014).
- An assistant's default permission profile is the shipped `assistant` profile (section 7). It is loosenable per assistant.
- The web app reaches an assistant directly, without any channel, as a conversation of its own (section 9).

**Open:** the Assistant record's field list beyond agent fields, bindings, memory and heartbeat (for example display name used for mention matching in groups) is not pinned; [./02-domain-model.md](./02-domain-model.md) owns the entity definition.

## 2. Conversations

A Conversation is one continuous exchange with one assistant inside one platform container. One platform container = one conversation:

| Container | Conversation |
|---|---|
| Discord channel | one conversation |
| Discord DM | one conversation |
| Slack thread | one conversation |
| Web chat | one conversation |

- Each conversation has its own session lineage (section 5). Conversations are never merged; there is no "main session" that collapses all DMs (the OpenClaw default, rejected in ADR 0014).
- Continuity across conversations comes from assistant-scoped memory and transcript recall, never from moving or swapping sessions. Cross-surface continuation ("carry on what we discussed in Slack") is recall: the assistant summarizes from memory and transcript search and continues in the current session.
- A conversation holds exactly one live session at a time (the current incarnation). The Conversation record that links to it is the spec's consolidation of the generational model (ADR 0014), not a ticket-pinned entity; predecessors remain readable as ordinary session history.

**Open:** the exact container facts that key a Slack conversation (a top-level Slack channel message that is not in a thread, Slack DMs) are not pinned beyond "Slack thread". The Slack channel contribution must state the container key (see section 11). Field research keys are in `research/assistant-systems.md` (branch `research/assistant-systems`), section 2.

## 3. Channel bindings

A Channel Binding maps part of a channel Connection to exactly one assistant. Binding = `connection + scope -> assistant`.

- **Connection**: a channel-plugin Connection (a Discord bot, a Slack app), core-owned as any Connection ([./08-events-and-connections.md](./08-events-and-connections.md)).
- **Scope**: the connection's DMs, a named channel, or a named thread. Scopes nest; a binding on a thread is more specific than one on its channel, which is more specific than one on the whole connection's DMs or channels.
- **Resolution**: most specific binding wins. Every inbound container resolves to at most one assistant. A container with no matching binding is ignored (the no-match case is not pinned by any ticket; ignoring is the spec's reading).
- A binding is how channels reach an assistant, not what makes it one: an assistant with no bindings is still a full assistant reachable in the web app.
- Access control (who may command) is a separate layer from binding (section 4); binding answers only "which assistant answers here".

Prior art for the route record and specificity ordering (OpenClaw `bindings`, Hermes `profile_routes`, Letta `(channel, accountId, chatId, threadId) -> (agentId, conversationId)`): `research/assistant-systems.md`, section 3.

**Open:** the concrete scope schema (how a Discord guild vs channel vs thread and a Slack workspace vs channel vs thread are named in a binding, and the specificity order between them) is not pinned; it follows the channel contribution's scope model (section 11).

## 4. Wake rules and identity

Who may command, and when the assistant wakes:

- **DMs are always-on.** Every DM message in a bound DM scope wakes the assistant.
- **Shared channels are mention-gated.** In a group container the assistant wakes only when mentioned. Implicit mentions count as mentions: a reply to one of the assistant's messages, and activity in a thread the assistant is already active in.
- **Unaddressed group messages are stored as bounded context**, not delivered as turns. When the assistant next wakes in that container it sees the recent unaddressed messages as context.
- **Third-party lines are context, never instructions.** Messages from anyone other than the owner are delivered wrapped in explicit data-not-instructions markers (the taint markers of [./13-security.md](./13-security.md)).
- **Only owner identities command.** Single-user v1: the user configures which platform identities are theirs; only messages from those identities are instructions. Everything else is context.

**Open:** the bound on stored unaddressed context (message count or age) is not pinned; OpenClaw uses the last 50 skipped messages (`research/assistant-systems.md`, section 4).
**Open:** where the owner's platform identities are configured (per channel Connection at setup, or one identity list per user) is not pinned. OpenClaw's `identityLinks` (one human's ids across channels -> one canonical peer) is the field-research shape.
**Open:** whether the assistant's own messages, and messages from other bots, are excluded from stored context (Hermes ignores bot-to-bot by default to avoid ack loops) is not pinned.

## 5. Sessions and rotation

A conversation is backed by generational sessions: a lineage of ordinary Sessions, not one everlasting session and not one session per message.

### 5.1 Session properties

- Assistant sessions are ordinary Sessions with the assistant as their agent, no Task, and no Workspace (`workspaceId: null` in the SessionSpec, [./06-providers.md](./06-providers.md)). They are literally workspace-less: nothing is materialized on runner disk for them.
- The session carries a Session Token with the assistant's permission profile ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)); the assistant acts through the `hydra` CLI.
- An assistant session runs inside its provider instance's isolated provider home (one instance = one login = one home), so user-global instructions, skills and packages never leak in ([./06-providers.md](./06-providers.md)).
- Workspace-less cwd: the runner passes `cwd: null` for Claude and pi. Codex alone gets a runner-provisioned scratch directory because `thread/start` needs one and instructions travel as `AGENTS.md`; it is not a Workspace. Details and the verify note live in [./06-providers.md](./06-providers.md).
- **Provider-native auto-compaction is disabled for assistant sessions.** Rotation is the only memory event. The adapter reports context usage (`session.usage.updated`, [./06-providers.md](./06-providers.md)) so the controller can rotate at Hydra's own threshold. Per-provider switches (Claude `DISABLE_COMPACT` / `--autocompact`, pi `compaction.enabled=false`, Codex `model_auto_compact_token_limit`) are listed in [./06-providers.md](./06-providers.md).
- Session-held Subscriptions are delivered as queued input on a turn boundary (rendered text plus structured payload), never as steering by default ([./08-events-and-connections.md](./08-events-and-connections.md)).

### 5.2 Rotation triggers

The controller rotates a conversation's live session when either fires:

1. **Context-size ceiling** (mandatory - agents degrade past a point regardless). Measured from the adapter's context usage reports.
2. **Daily timer.**

**Open:** the ceiling value (absolute tokens or fraction of the model's context window) and the daily timer's time of day and timezone are not pinned. Field defaults: OpenClaw and Hermes reset daily at 04:00 (`research/assistant-systems.md`, section 2).

### 5.3 Rotation contract

Rotation is: distill, then continue fresh. Distillation is part of the contract, never an optional pass.

1. **Flush turn.** The dying session receives one final turn with the standing instruction "record what is durable that is not yet in memory". The assistant writes to memory through the ordinary `hydra memory` ops. This turn is a safety net: in the experiment behind ADR 0020 every fact was already recorded in the turn it was heard, and the flush never rescued anything.
2. **Successor session.** The controller starts a fresh session for the same conversation with only `core` and the topic index injected (section 6.3). The successor does not receive the predecessor's transcript.
3. **Subscriptions migrate.** Every Subscription held by the dying session moves to the successor, so "a subscription dies with its holder" stays true for the conversation's current incarnation.
4. The predecessor session ends and remains as ordinary session history, searchable by transcript recall.

**Open:** rotation while a turn is in flight (the ceiling is crossed mid-turn, or the timer fires while the assistant is mid-delegation) - whether the controller waits for `turn.completed` before the flush turn - is not pinned.
**Open:** whether stored unaddressed group context (section 4) is carried to the successor is not pinned.

## 6. Memory

Memory is an assistant's durable notes: assistant-scoped, agent-maintained, user-visible and editable, hard size bound, held by the controller. No hidden state. No vector store anywhere in v1.

### 6.1 Interface: API-only

Assistants read and write memory exclusively through the public API; the CLI surface is:

```
hydra memory list
hydra memory read <name>
hydra memory search <words>
hydra memory write <name>
hydra memory append <name>
hydra memory delete <name>
```

- Nothing is materialized on runner disk. No memory file exists anywhere an agent could `grep` or `Edit`; `search` is the substitute for grep (ADR 0020).
- The web app edits the same documents through the same operations; there is no second write path ([./14-web-app.md](./14-web-app.md)).
- The CLI offers **one content channel** for `write` and `append`: stdin only. There is no `--content` flag and no `--file` flag (ticket 21 asked for one unambiguous channel and left the pick to the spec; the spec picks stdin). `--help` works at any position on every subcommand and is agent-addressed. Both are CLI rules owned by [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md).
- Memory operations require the `memory` grant family (see [./13-security.md](./13-security.md#61-grant-families)); the shipped `assistant` profile carries it.
- Memory operations are ordinary actor-stamped mutations in the event log ([./04-state-store.md](./04-state-store.md)).

### 6.2 Format: two tiers

This section is the normative owner of the memory tiers and caps; other documents link here.

| Tier | Documents | Cap | Injected at session start | Content |
|---|---|---|---|---|
| `core` | exactly one, seeded at assistant creation | 4,000 chars | always, in full | who the user is, standing preferences, what is live |
| topics | 0 to 24 named documents | 12,000 chars each | index only (name, size, gist) | anything the assistant drills into on demand |

- A topic document has `# <name>` on line 1 and `> <gist>` on line 2. Topic names are free-form.
- The index is generated from the documents (name, size, gist); it is not a document the assistant maintains.
- Caps are in characters, provider-agnostic.

**Open:** validation when a written topic lacks the `# name` / `> gist` header (reject, or derive the header from the op's `<name>` and an empty gist) is not pinned.
**Open:** whether `delete core` is refused (core is seeded and always injected) is not pinned.

### 6.3 Injection

Every assistant session starts with `core` in full and the topic index injected. Topic bodies are fetched on demand with `hydra memory read <name>`. Nothing else from memory is injected.

**Open:** where the injection lands (the `systemPrompt` of the SessionSpec, or the first user turn) is not pinned by any ticket; the per-harness mapping in [./06-providers.md](./06-providers.md) only states that core and the index are injected.

### 6.4 Caps enforced at write

`write` and `append` enforce the caps and the topic count:

- A write that would exceed a document's cap fails, and the error names the current size (for example: `topic "decisions" is 12,009 chars; cap is 12,000`). The assistant consolidates and retries.
- A write that would create a 25th topic fails the same way, naming the count.
- Enforcement lives on this one seam, so overflow is a visible event, never a silent truncation. (In the experiment a Codex write landed at 12,009 chars and was caught here; as a file write it would have passed silently.)

**Open:** memory version history was ruled post-v1, but the same experiment showed a cap-triggered rewrite dropping content: after one cap rejection Codex rewrote a 12,009-char topic to 1,146 chars, losing fifteen unique decisions. [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21) flags this for reconsideration. Version history stays post-v1 by decision (2026-08-28); the cheaper v1-shaped alternative on the record is OpenClaw's shrink guard (reject a write that shrinks a document by more than N% unless confirmed). Neither is pinned for v1; the retrofit of either is additive (a history table beside the live document, or a check on the write seam).

### 6.5 Recall

- `hydra memory search <words>` searches the assistant's own memory documents.
- Transcript recall is `transcript.query { text, assistantId: "me" }` (`hydra transcript query --text "..." --assistant me`): full-text search over the assistant's own conversations (all its sessions, all its conversations), returning passages ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2). It is the same operation any agent with `session.read` uses over any session; `assistantId: "me"` is a filter, not a boundary. No vectors, no embeddings, no LLM summarization in the retrieval path (Hermes ships FTS-only recall; Letta migrated away from vector archival memory: `research/assistant-systems.md`, sections 5 and 6).
- An assistant never reads another assistant's memory (the one scoped grant family in v1, [./13-security.md](./13-security.md) section 6.1). Transcripts are ordinary session history: any session granted `session.read`, the assistant profile included, can read any session's transcript.

### 6.6 Visibility, editing, deletion

- Memory is user-visible and user-editable in the web app through the same ops (section 6.1). There is no hidden memory state.
- Memory dies with its assistant: deleting an assistant deletes its memory. Deletion is a confirmed action. The assistant's transcripts survive as ordinary session history.

### 6.7 Taint and provenance

Distillation runs over conversation content that includes untrusted third-party text (section 4). The security model ([./13-security.md](./13-security.md)) pins:

- Third-party text stays wrapped in explicit data-not-instructions markers through distillation, including the flush turn.
- The flush-turn (distiller) prompt is hardened against treating quoted content as directives.
- A memory write distilled from a tainted conversation carries a one-line provenance marker in the memory document, auditable by the user.
- Hard-excluding third-party content from memory is rejected: it discards the signal shared-channel assistants exist to keep.

**Open:** how the write op knows a write is "distilled from a tainted conversation" (a flag on the op set by the session's conversation state, or inferred from the session) and the exact provenance line format are not pinned.

### 6.8 What delegated sessions see

Sessions the assistant delegates to (agent steps of runs it starts, sessions it spawns) see none of the assistant's memory. Delegation passes only what the assistant itself writes into the Task or the spawned Session's input.

## 7. Acting: delegation via the orchestration surface

Assistants act on the system through the public API like any agent ([ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md)), bounded by the shipped `assistant` permission profile. [./13-security.md](./13-security.md#62-shipped-profiles) is the only normative statement of the profile; in one line: the orchestration surface is granted (tasks, `workflow.run` and `workflow.submit`, `session.spawn` plus steering and reading sessions, subscriptions, notifications, `event.emit`, read on everything that is not a secret, `permission.request`, and the `memory` family for its own memory), while `workflow.write`, `connection.manage`, `infra.write`, the other `write` families, `secret`, `credential`, bulk-destructive operations, Workspaces and direct work tools are withheld. "The sessions it spawned" is the `actor: "me"` filter on `session.query`, a convenience rather than a permission.

- "Delegate, don't do" is enforced by configuration, not by caste: the profile is loosenable per assistant, up to the `unrestricted` profile.
- The assistant writes its own memory through `hydra memory` under the `memory` grant family; a session token's memory operations are pinned to its own assistant ([./13-security.md](./13-security.md#61-grant-families)).
- A denied operation returns a 403 naming the missing grant; the assistant may raise a Permission Request via `permission.request` and learns the outcome through the subscription that operation registers for it ([./13-security.md](./13-security.md#64-escalation-permission-request)).
- Assistant sessions get no Workspace. Workspace-less sessions get `GH_TOKEN` from the user-designated default Connection or no token ([./13-security.md](./13-security.md)).

**Open:** "direct work tools" are denied by the profile at the API layer, but the harness's own tools (shell, file edit) in a workspace-less session are governed by the session's access mode, not by grants. Which access mode assistant sessions run under, and whether harness work tools are additionally disabled for them, is not pinned; [./06-providers.md](./06-providers.md) owns access modes.

## 8. Proactivity

### 8.1 Unprompted speech and the no-double-fire rule

An assistant may speak unprompted in the conversation whose session holds the relevant Subscription. When a subscribed event arrives, it is delivered as queued input (section 5.1); the assistant decides whether and what to say.

No double fire against Notifications ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md), [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)):

- If an assistant is mid-delegation on something (its session holds a subscription covering it), the assistant speaks and no core Notification fires for that occurrence.
- Core Notifications cover what no assistant is holding. This keeps ADR 0012's single-path promise: one occurrence reaches the user once.

The router mechanism (a check for a live assistant-held subscription matching the event before a Notification is created) is proposed in [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md#75-assistants-and-double-firing), which also holds the Open on the precise matching rule.

### 8.2 Heartbeat

A Heartbeat is a scheduled wake of an assistant with a user-editable standing prompt. It is the main mechanism of true proactivity.

- Ships in v1, **default ON** for every assistant.
- Ticket 17 describes it as sugar over a cron trigger delivering queued input: a scheduled wake, not a separate scheduler. The user edits the schedule and the standing prompt per assistant. Where useful ends and annoying begins is left to dogfooding, not spec.

**Open:** the heartbeat has no mechanism in the pipeline as specified. A cron start trigger's only effect is a pending run ([./07-workflows.md](./07-workflows.md), [./08-events-and-connections.md](./08-events-and-connections.md)); queued input is produced only by session-held subscriptions; and no built-in action sends input to a session. Either a built-in `session.send`-style action lands in [./07-workflows.md](./07-workflows.md) (heartbeat = a one-step workflow per assistant with a cron start trigger) or the controller runs the heartbeat as a core scheduler effect that enqueues the standing prompt on the target conversation. The spec does not pick; [./02-domain-model.md](./02-domain-model.md) and [./08-events-and-connections.md](./08-events-and-connections.md) point here.
**Open:** the default cadence, the default standing prompt text, and which conversation the heartbeat wakes (a dedicated heartbeat conversation, the web chat, or the most recently active conversation as nanobot does) are not pinned. OpenClaw measures idle from the last real user interaction so that heartbeats do not keep a session alive; whether a heartbeat turn counts toward the daily rotation timer is likewise not pinned.

## 9. Web chat

The web app reaches an assistant with no channel involved. A web chat is a conversation like any other: its own session lineage, the same memory, the same rotation contract. It appears under the Sessions screen as assistant chat ([./14-web-app.md](./14-web-app.md)).

**Open:** whether an assistant has exactly one web-chat conversation or the user may open several is not pinned.

## 10. Lifecycle

- **Create**: an assistant is an agent plus bindings, memory (seeded `core`) and heartbeat. Creating the default assistant is part of first-run onboarding ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- **Pause**: there is no paused state in v1. Pausing is removing bindings (and, to silence it fully, turning off the heartbeat).
- **Delete**: confirmed action; deletes memory and bindings; transcripts survive as session history (section 6.6).

## 11. Channel plugins: Discord and Slack

Channels are contributions into the `channel` extension point ([./05-plugins.md](./05-plugins.md)); Discord and Slack are the two v1 channel plugins, built in-process as plugins. What the tickets pin about a channel contribution:

- **Connection**: a channel Connection is core-owned (plugin-defined type, label, credentials, status) like any Connection ([./08-events-and-connections.md](./08-events-and-connections.md)). A channel is not an event source: it holds a live platform connection and delivers observed messages to the core, not events into the pipeline. Credentials are a pasted bot token for both Discord and Slack ([./13-security.md](./13-security.md); rationale in `research/connection-setup-ux.md`, branch `research/connection-setup-ux`).
- **Transport**: both connect outbound (Discord gateway, Slack Socket Mode); no public endpoint on the controller ([Research: event ingress options](https://github.com/rogierpennink/hydra/issues/5)).
- **Inbound messages with identity**: each inbound message must carry the platform identity of its author (so the owner-identity check of section 4 can run), the container facts that key the conversation (section 2) and the binding scope (section 3), and whether the assistant was mentioned explicitly or implicitly (reply-to-assistant, assistant-in-thread).
- **Outbound send**: the contribution sends the assistant's reply to a given container.
- **Scope model**: the contribution defines what "DM", "channel" and "thread" mean on its platform. Pinned containers: Discord channel or DM; Slack thread.
- **Notification delivery (optional)**: a channel contribution may implement Notification delivery as a sink; the user toggles it per channel Connection; v1 policy is deliver-to-all-enabled ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)). The sink contract grows additively (device class, presence, receipts) so presence-aware routing can land post-v1 without touching plugins.
- **Host API**: the contribution reaches core through the `channels` plugin capability; breaking changes mint `channels.v2` ([./05-plugins.md](./05-plugins.md)).

**Open:** the TypeScript interface of the channel contribution (inbound message shape, outbound send signature, how it announces its scope model to the binding editor) is not pinned by any ticket. `research/assistant-systems.md` sections 3 and 4 hold the field-research shapes.
**Open:** inbound chat messages are not pipeline Events in this spec (the pinned `source` values in [./08-events-and-connections.md](./08-events-and-connections.md) have no `discord`/`slack`; the channel contribution delivers them to the conversation directly). Whether they should be Events under [ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md) (for audit and for triggers on chat activity) is not pinned; this document owns the question.
**Open:** message formatting (markdown to platform markup), long-reply splitting, and typing indicators are not pinned.
**Open:** the Discord and Slack app permission scopes (intents, OAuth scopes) the bot token must carry are not pinned; they follow from the inbound/outbound requirements above and are settled at build time.

## Post-v1

- **Binding-preserving paused state** - deferred, not rejected: re-establishing bindings is real work (Discord bot setup). V1 keeps pausing = remove bindings; a later paused flag adds a state without changing bindings.
- **Cross-assistant recall** as a feature - arrives as agent-to-agent communication ("go ask the triage assistant what we discussed"), never shared memory. V1 keeps memory strictly assistant-scoped so this stays additive; transcripts are already readable by any `session.read` holder, which is a permission fact, not a recall feature.
- **Memory version history** - retrofit is additive (a history table beside the live document); see the reconsideration flag in section 6.4.
- **Journal tier + dream pass** - tested and not adopted (journal entries duplicated in-turn writes, every dream pass cost a run, on 1-7 turn conversations). Standing assumption: in-turn recording degrades in long conversations; if dogfooding shows facts going unrecorded, the design and harness (`prototype/memory-interface`, `--journal 1`) restart from evidence.
- **Read-only memory materialization on runners** - a pure read convenience for native grep, addable later without touching the write path; v1 keeps the API as the only write seam.
- **Feedback-driven triage learning** - user ratings of triage verdicts feeding assistant memory ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)); a future memory consumer.
- **Third chat channel** (Signal / Telegram / WhatsApp, not committed) - the plugin that proves the channel interface for real.
- **Per-agent git identity** - assistant sessions today get the default Connection's token or none; per-agent identity is a policy addition on unchanged plumbing ([ADR 0016](../adr/0016-git-credentials-derive-from-connections.md)).

## Sources

Tickets:

- [Research: event ingress options](https://github.com/rogierpennink/hydra/issues/5)
- [Domain model & ubiquitous language](https://github.com/rogierpennink/hydra/issues/6)
- [Plugin architecture: API shape, loading, dogfooding](https://github.com/rogierpennink/hydra/issues/11)
- [Event & trigger ingress](https://github.com/rogierpennink/hydra/issues/14)
- [Triage engine & user-set bounds](https://github.com/rogierpennink/hydra/issues/15)
- [Agent-operates-system surface](https://github.com/rogierpennink/hydra/issues/16)
- [Assistant design: memory, identity, channel binding](https://github.com/rogierpennink/hydra/issues/17)
- [Security & secrets model](https://github.com/rogierpennink/hydra/issues/18)
- [Web app architecture: observability-first, desktop-shell-ready](https://github.com/rogierpennink/hydra/issues/19)
- [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21) (comments: memory API ops, CLI content channel, provider-home isolation, compaction rule, version-history flag)
- [Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31)
- [Research: smoothest Connection-setup path](https://github.com/rogierpennink/hydra/issues/32)

ADRs:

- [ADR 0012 - Notifications are core-routed, sinks are dumb](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)
- [ADR 0013 - Agents operate Hydra through the public API](../adr/0013-agents-operate-hydra-through-the-public-api.md)
- [ADR 0014 - Assistants remember through distilled memory, not merged sessions](../adr/0014-assistants-remember-through-distilled-memory-not-merged-sessions.md)
- [ADR 0020 - Assistant memory is reached only through the API](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)

Research:

- `research/assistant-systems.md` (branch `research/assistant-systems`) - OpenClaw, Hermes, nanobot, Letta Code field study
- `research/connection-setup-ux.md` (branch `research/connection-setup-ux`) - bot-token paste for Slack/Discord
