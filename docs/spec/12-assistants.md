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

A Conversation is one continuous exchange with one assistant inside one platform container. One platform container = one conversation. The container table, pinned by [Channel contribution interface and conversation ingress](https://github.com/rogierpennink/hydra/issues/39):

| Channel | Container | Conversation | Container key (section 3) |
|---|---|---|---|
| Discord | guild channel (text, announcement) | one conversation | `group: [guild, channel]` |
| Discord | thread, forum post | its own conversation, distinct from the parent channel's | `group: [guild, channel, thread]` |
| Discord | DM | one conversation | `dm: [user]` |
| Slack | thread | one conversation | `group: [channel, thread]` |
| Slack | DM (`im`) | one conversation, top-level | `dm: [user]` |
| Slack | group DM (`mpim`) | one conversation, mention-gated like any group | `group: [channel]` |
| Web | web chat | one conversation | no channel (section 9) |

Rules:

- **A top-level Slack channel message is not a container.** When one mentions the assistant, the Slack plugin keys it as the root of the thread it is about to start (`thread_ts = ts`): the assistant replies in a thread under the message, and that thread is a fresh conversation. Every top-level mention therefore opens a new conversation; one busy channel never becomes one endless session. Unaddressed top-level lines are stored as context against the channel itself (`group: [channel]`, section 4.3) so a new thread's first wake can see what preceded it.
- Threads inside a Slack DM follow the general thread rule (their own conversation); they are rare and one rule is better than two.
- The container mapping is the plugin's, not the core's: the core only ever sees `{kind, path}`. Reversing the Slack choice later (the channel itself as a conversation, replies top-level) is a plugin-local change that adds a `[channel]` container, leaves existing thread conversations valid and touches no core code; it could become a per-connection setting.
- Each conversation has its own session lineage (section 5). Conversations are never merged; there is no "main session" that collapses all DMs (the OpenClaw default, rejected in ADR 0014). A new conversation is a new lineage with memory injected fresh, so twenty open Slack threads are twenty conversations; how many of their sessions are live at once is the runtime's concern ([Assistant runtime](https://github.com/rogierpennink/hydra/issues/40)).
- Continuity across conversations comes from assistant-scoped memory and transcript recall, never from moving or swapping sessions. Cross-surface continuation ("carry on what we discussed in Slack") is recall: the assistant summarizes from memory and transcript search and continues in the current session.
- A conversation holds exactly one live session at a time (the current incarnation); predecessors remain readable as ordinary session history.

**Conversation messages.** The core keeps every message it observes in a bound container - owner lines, third-party lines, bot lines, the assistant's own replies, and notification sink posts - as **conversation messages**, one core-owned table keyed by container ([./04-state-store.md](./04-state-store.md)). That table is the conversation view in the web app, the source of the context delivered at wake (section 4.3), and the record of what was said. It is **not** the event log: a chat message is input to an assistant, not an external fact for triggers ([ADR 0023](../adr/0023-chat-messages-are-conversation-input-not-events.md)); nothing enters the pipeline of [./08-events-and-connections.md](./08-events-and-connections.md). Containers with no matching binding are not stored at all. Retention is a `retention.conversations` setting; its default is owned by [Operations details](https://github.com/rogierpennink/hydra/issues/44).

## 3. Channel bindings

A Channel Binding maps part of a channel Connection to exactly one assistant. Binding = `connection + scope -> assistant`.

- **Connection**: a channel-plugin Connection (a Discord bot, a Slack app), core-owned as any Connection ([./08-events-and-connections.md](./08-events-and-connections.md)).
- **Scope** is a prefix of a container key: `{ kind: "group" | "dm", path: string[] }`. The empty path names everything of that kind on the connection.
- **Resolution**: a message's container matches every binding whose `kind` equals its own and whose `path` is a prefix of its own; the **longest prefix wins**. One binding per `(connection, kind, path)`, so there are no ties. A container with no matching binding is ignored: nothing wakes, nothing is stored.
- **Matching runs in the core** with no plugin code, against the scope model the plugin declared in the catalog (section 11.1), so bindings validate and render even while the plugin is disabled.
- A binding is how channels reach an assistant, not what makes it one: an assistant with no bindings is still a full assistant reachable in the web app.
- Access control (who may command) is a separate layer from binding (section 4); binding answers only "which assistant answers here".

The levels, outermost first, and the specificity they give:

| Channel | `group` levels | `dm` levels | Notes |
|---|---|---|---|
| Discord | `guild > channel > thread` | `user` | one bot Connection may sit in several guilds |
| Slack | `channel > thread` | `user` | one Slack Connection is one workspace, so there is no workspace level |

Worked example, one Discord Connection:

| Binding scope | Written as | Assistant |
|---|---|---|
| all DMs | `dm: []` | Personal |
| whole guild Acme | `group: [Acme]` | Work |
| channel #infra in Acme | `group: [Acme, infra]` | Ops |
| thread incident-42 in #infra | `group: [Acme, infra, incident-42]` | Incident |

A message in thread incident-42 has container `group: [Acme, infra, incident-42]`; three bindings match and the longest wins (Incident). A message in #general matches only `[Acme]` (Work); a new thread in #infra with no binding of its own falls to Ops. Paths hold platform ids; the display names shown in the binding editor are captured at pick time and never matched on.

Prior art for the route record and specificity ordering (OpenClaw `bindings`, Hermes `profile_routes`, Letta `(channel, accountId, chatId, threadId) -> (agentId, conversationId)`): `research/assistant-systems.md`, section 3. The plugin-supplied `matches(container, scope)` alternative was rejected: bindings could not be validated against a disabled plugin, and every platform would reinvent prefix matching.

## 4. Identity, wake rules and context

### 4.1 Platform identities

A **Platform Identity** is one person's account on one chat platform, recorded on the user, with a role. The list lives in Settings > Identities and is global across Connections of that channel: it describes a person, not a bot token, so adding a second Discord bot does not change who you are.

| Field | Content |
|---|---|
| `channel` | the channel contribution id (`discord`, `slack`) |
| `identityKey` | the platform's stable id in the format the plugin owns: Discord user id; Slack `<teamId>:<userId>` (Slack user ids are per workspace) |
| `label` | display name, presentation only |
| `role` | `owner` or `trusted` |
| `pairedAt` | when it was claimed |

Roles:

- **owner** - the user. Messages are instructions; a click on a bound action delivered to a channel executes as `user` ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4); memory is written from the owner's perspective. Several owner identities are one person on several platforms.
- **trusted** - may command the assistant: messages are instructions, not context. A trusted click on a bound action is refused with an ephemeral "only the owner can decide", because bound actions run under the owner's full parity. Trusted is a role on an identity, not a Hydra user; when multi-user arrives, roles attach to users and this record widens rather than restructures.
- Everyone else is a third party: context in groups (section 4.3), ignored in DMs.

**Pairing.** Settings > Identities > Add: choose the role (and a label) and the web app shows a one-time code (single use, expires in ten minutes). The person sends the code as a DM to any Hydra bot on that platform; the core matches pending codes against inbound DM text before any wake or ignore rule, records the identity, and replies through the same channel ("Paired as owner"). The same mechanism claims the user's own second platform and a colleague's identity; identities are listed and revoked on the same screen. Pairing at connection setup doubles as proof that the bot can see DMs at all. Prior art: pairing codes plus allowlists in all four researched systems (`research/assistant-systems.md`, sections 3 and 4); none of them separates an owner from other allowed people because none has owner-executed actions.

**Unknown DM senders are silently ignored**, never stored and never answered. A "not paired" reply would invite code guessing on a bot that sits in shared guilds; a self-hosted assistant has no reason to talk to strangers.

**Trusted identities share the assistant's memory** by construction: a trusted person's DM is their own conversation with the same assistant, and its memory holds facts about the owner. Granting trusted is granting that. Stated as a limit in [./13-security.md](./13-security.md) section 10.

### 4.2 Wake rules

Who wakes the assistant:

- **DMs are always-on** for owner and trusted identities: every DM line is a turn.
- **Shared containers are mention-gated.** In a group container the assistant wakes only when mentioned by an owner or trusted identity. An **explicit mention** is the platform's own mention of the bot user (`@Hydra` on Discord, `<@bot>` on Slack); the plugin reports it as a fact. **Implicit mentions** count: a reply to one of the assistant's messages (reported by the plugin), and any line in a container the assistant has already spoken in (known to the core from the conversation messages). Name patterns in text ("hydra, ...") are not mentions in v1; see Post-v1 - they are wanted, not rejected.
- **Bots never wake an assistant**, mention or not: the plugin marks `sender.isBot` and the assistant's own messages `isSelf`, and neither can be paired as an identity. This is the ack-loop guard (Hermes ignores bot-to-bot for the same reason) and it costs nothing, because no bot can command anyway.
- A wake delivers the message as the next turn (or queued input on a busy session, section 5.1) of the conversation's live session, prefixed with the sender's display name and role.
- **Third-party lines are context, never instructions.** Messages from identities that are neither owner nor trusted are delivered wrapped in explicit data-not-instructions markers (the taint markers of [./13-security.md](./13-security.md)).

### 4.3 Stored context and what the assistant sees

The conversation messages table stores everything (section 2). What is *delivered* is only what the assistant has not seen:

- At each wake in a group container the assistant receives, before the waking line, the **unseen lines** of that container since its last turn there - third-party lines, trusted lines that did not mention it, bot lines, and notification sink posts - oldest first, **capped at the last 50** (OpenClaw's bound; no age cap, one rule). Older unseen lines are dropped from delivery, not from the table.
- The assistant's **own replies are excluded** from delivery: they are already in its transcript. This is dedup, not a cut - in a DM every line is a turn, the transcript holds both sides in order, and the unseen set is empty.
- On a conversation's **first wake**, a new group conversation also receives the last 50 lines of its parent container (the Slack channel a thread was opened in; the Discord channel a thread hangs off), so "did you see what was said above?" works.
- Delivered lines carry sender name and role; non-owner, non-trusted and bot lines carry the data-not-instructions markers.
- **Notification sink posts** in a bound container (section 11.6) are stored with `origin: notification` and delivered as one data line naming the notification, its title, its answers and whether it is resolved, so "yes, retry that one" in a DM works: the assistant can read the record through `notification.read` and tell the user to decide, or propose the same action back. A sink post is never a turn, never the assistant speaking, and never wakes anything - which keeps it distinguishable for the no-double-fire rule (section 8.1).
- Whether unseen context carries to the successor session across a rotation is owned by [Assistant runtime](https://github.com/rogierpennink/hydra/issues/40).

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
**Open:** whether unseen group context (section 4.3) is carried to the successor is not pinned.

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

The web app reaches an assistant with no channel Connection involved. A web chat is a conversation like any other: its own session lineage, the same memory, the same rotation contract. It appears under the Sessions screen as assistant chat ([./14-web-app.md](./14-web-app.md)).

**Same machinery.** The core's conversation service is channel-agnostic, and web chat is a **built-in, connection-less channel** on it: it produces the same inbound message shape (sender = the owner, always-on), takes the same `send`, and drives the same activity hook, with no Connection, no binding and no plugin. One conversation service serves three channels in v1 (web, Discord, Slack); the web one is core-internal. This is the cheapest proof that the channel interface of section 11 is not Discord-shaped, and it keeps wake, rotation, memory injection and context delivery in one place.

**Open:** whether an assistant has exactly one web-chat conversation or the user may open several is not pinned ([Assistant runtime](https://github.com/rogierpennink/hydra/issues/40)).

## 10. Lifecycle

- **Create**: an assistant is an agent plus bindings, memory (seeded `core`) and heartbeat. Creating the default assistant is part of first-run onboarding ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)).
- **Pause**: there is no paused state in v1. Pausing is removing bindings (and, to silence it fully, turning off the heartbeat).
- **Delete**: confirmed action; deletes memory and bindings; transcripts survive as session history (section 6.6).

## 11. Channel plugins: Discord and Slack

Channels are contributions into the `channel` extension point ([./05-plugins.md](./05-plugins.md)); Discord and Slack are the two v1 channel plugins, built in-process as plugins. The contract below is pinned by [Channel contribution interface and conversation ingress](https://github.com/rogierpennink/hydra/issues/39); platform facts were verified against the Discord and Slack developer documentation on 2026-08-30 (`research/channel-platform-facts.md`, branch `research/channel-platform-facts`).

### 11.1 The channel contribution interface

Declared in `register()` through `host.channels.register(contribution)`; the core drives `open()` once per enabled Connection of the contribution's type after the plugin's `activate()`, and `close()` on disable, deactivate or Connection removal. Everything crossing the boundary is plain data except the hooks themselves ([./05-plugins.md](./05-plugins.md) section 3).

```ts
interface ChannelContribution {
  id: string                                   // "discord" | "slack"; what bindings, identities and sinks name
  connectionType: string                       // the Connection type it services (section 11.5)
  scopeModel: { group: string[]; dm: string[] }   // container levels, outermost first (section 3)
  identityKeyFormat: string                    // human-readable, shown in Settings > Identities
  open(connection: ConnectionRef, host: ChannelHost): Promise<ChannelHandle>
}

// Runtime surface of the `channels` capability: what the plugin calls.
interface ChannelHost {
  message(m: InboundMessage): void             // every observed message in every container the bot can see
  click(c: ActionClick): Promise<ClickOutcome> // interactive sinks only (section 11.6)
  status(s: { state: "connected" | "degraded" | "disconnected"; detail?: string }): void
}

// What the core calls on a live connection.
interface ChannelHandle {
  send(container: ContainerRef, m: OutboundMessage): Promise<{ platformMessageId: string }>
  activity(container: ContainerRef, state: "working" | "idle", about?: { platformMessageId: string }): Promise<void>
  sink?: NotificationSink                      // section 11.6; both v1 channels implement it
  close(): Promise<void>
}

interface ContainerRef {
  connectionId: string
  kind: "group" | "dm"
  path: string[]                               // one platform id per declared level; a thread's path includes its parents
  labels?: string[]                            // display names at observation time; presentation only, never matched on
}

interface InboundMessage {
  container: ContainerRef
  platformMessageId: string
  sender: { identityKey: string; displayName: string; isBot: boolean; isSelf: boolean }
  text: string                                 // platform markup already normalized to markdown by the plugin
  attachments: { name: string; url: string; mimeType?: string }[]
  mention: { explicit: boolean; replyToSelf: boolean }   // "assistant already active here" is core-known
  replyTo?: string                             // platformMessageId
  sentAt: string
  raw: unknown                                 // vendor payload passthrough, never read by the core
}

interface OutboundMessage {
  markdown: string
  replyTo?: string                             // platformMessageId, where the platform has replies
  origin: { type: "assistant"; conversationId: string } | { type: "notification"; notificationId: string }
}
```

Division of labour, in one line each:

- **Plugin**: platform transport, container keying, mention and reply facts, bot/self flags, identity-key formatting, markup conversion both ways, splitting, activity rendering, button rendering and click decoding.
- **Core**: binding resolution, pairing, wake rules, context storage and delivery, turns and queued input, reply mode, outbox and retry, notification routing, click authentication and execution.

The plugin never sees bindings, identities, roles, wake decisions or the conversation table; the core never sees a platform API.

### 11.2 Ingress: conversation messages, not Events

Inbound chat messages do not enter the persisted event pipeline of [./08-events-and-connections.md](./08-events-and-connections.md). `host.message()` hands each observed message to the conversation service, which drops it if its container has no binding, otherwise stores it as a conversation message (section 2) and applies the wake rules (section 4.2). Rationale in [ADR 0023](../adr/0023-chat-messages-are-conversation-input-not-events.md): chat is input to an assistant, not an external fact for triggers; the session transcript already records what the assistant was told; and a busy channel would otherwise put hundreds of trigger-matched, TTL-pruned events a day into the log to find two mentions. If chat-triggered workflows are ever wanted, the additive path is a core-emitted platform event on wake, never the raw stream.

### 11.3 Outbound delivery

- **Reply mode** is a per-assistant setting, `reply: "turn-end" | "segments"`, default `turn-end`. `turn-end` sends the turn's final assistant text once; `segments` sends each completed assistant text segment as it lands (between tool calls). Streaming edits are not offered: both platforms rate-limit edits and the transcript already holds the detail. The setting exists so both can be tried during dogfooding.
- **Outbox**: every `send` and every sink delivery leaves the core through outbox rows with retry, at-least-once ([./04-state-store.md](./04-state-store.md)); the plugin's `platformMessageId` is stored on the conversation message.
- **Formatting**: the core hands markdown, the plugin renders it. Discord renders markdown natively in bot-authored content, masked links included. Slack uses the `markdown` block (real markdown: bold, links, headings, lists, tables, code; 12,000 characters per payload), so there is no markdown-to-mrkdwn converter. Inbound, the plugin normalizes platform markup to markdown (Slack `<@U..>` to `@name`, `<url|text>` to a link).
- **Splitting**: the plugin splits a long reply at paragraph, then line, boundaries under the platform limit (Discord 2,000 characters per message; Slack kept under 4,000 per message, well inside the 40,000 truncation point), reopening a code fence it had to cut. Sequence is preserved by sending in order through one outbox consumer per connection.
- **Threads**: Slack replies always carry `thread_ts` (the container *is* the thread); Discord replies are top-level in the container, with `replyTo` used only when the core is answering a specific message.
- **Activity**: the core calls `activity(container, "working")` when a turn starts and `"idle"` when it ends (in `segments` mode the indicator stays on between segments). Discord: the typing endpoint, re-sent every eight seconds while working (it expires after ten). Slack: an 👀 reaction on the triggering message, swapped for ✅ at idle; the plugin needs `reactions:write`. Slack's Agents feature (`agents.sessions.setStatus`, a real "is typing..." in ordinary channel threads) is **not** enabled: it turns every DM into a thread, adds setup steps and blocks workspace guests, for an indicator a reaction covers.
- **Attachments** arrive as links only: the model sees "attached: screenshot.png <url>". No bytes are fetched. The `attachments` field is on the interface from day one so image input is an additive upgrade (Post-v1).

### 11.4 Platform facts pinned

Discord:

- Gateway intents: `GUILDS` (also carries thread create/update/delete/list-sync), `GUILD_MESSAGES`, `DIRECT_MESSAGES`, `MESSAGE_CONTENT`. The last is privileged; below 10,000 unique users it is a toggle in the Developer Portal, no review. Without it content is delivered only for DMs and explicit mentions, so reply-to-assistant detection needs it. No reactions intent; `INTERACTION_CREATE` needs no intent. Gateway API v9 or later for thread events.
- Reply detection: message type 19 with `message_reference` / `referenced_message`; reply-to-self when the referenced author is the bot user. Thread detection: channel types 10/11/12 with `parent_id`; the plugin keeps a thread map from `GUILD_CREATE.threads` and `THREAD_*` events. Container: `[guild, channel]` for a guild channel, `[guild, parent, thread]` for a thread or forum post, `dm: [user]` for a DM.
- DMs: the bot receives DMs from users sharing a guild; a bot cannot be in group DMs. Sink delivery to a DM opens it lazily (`POST /users/@me/channels`) using the owner's identity key.
- Limits: 2,000 characters of content; buttons: action row type 1, button type 2, `custom_id` up to 100 characters, label up to 80, five per row, five rows.
- Interactions arrive over the gateway when no Interactions Endpoint URL is set (the two are mutually exclusive); they must be acknowledged within three seconds.

Slack:

- **Two tokens**: a bot token (`xoxb-`) for the Web API and an app-level token (`xapp-`, scope `connections:write`) for Socket Mode. Socket Mode apps cannot be listed in the public Marketplace, which is irrelevant here.
- Event subscriptions: `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`. `app_mention` does not fire in DMs; DMs are read from `message.im`, which is fine because DMs are always-on. Thread replies arrive as ordinary message events. The bot must be a member of a channel to see it.
- Bot token scopes: `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `im:write`, `chat:write`, `users:read`, `reactions:write`.
- Detection: `thread_ts` present means in a thread (`thread_ts == ts` is the root); `channel_type` `im` / `mpim`; a `bot_id` marks bot-authored messages; the plugin learns its own ids from `auth.test`. Identity key `<teamId>:<userId>` (Enterprise Grid ids span workspaces; keying on both is safe either way).
- Limits: keep messages under 4,000 characters (truncation at 40,000); 50 blocks; `markdown` block 12,000 cumulative; button text 75, `action_id` 255, `value` 2,000; roughly one message per second per channel.
- Replies in thread: `chat.postMessage` with `thread_ts` = the root's `ts`. Interactive clicks arrive as Socket Mode `interactive` envelopes (`block_actions`) carrying `user.id`, `user.team_id`, `channel.id`, the message and a `response_url`; acknowledge the envelope immediately.

### 11.5 Connections and setup

- Discord: one pasted bot token, validated with `GET /users/@me`. Slack: bot token plus app-level token, validated with `auth.test` and `apps.connections.open`. The Slack connection type's credential therefore has two fields; "paste a token" in [./08-events-and-connections.md](./08-events-and-connections.md) reads "paste the tokens" for Slack.
- The plugin's setup flow shows the checklist the platform side needs (Discord: the four intents to enable, the invite URL with `bot` scope and send/read/thread permissions; Slack: Socket Mode on, the event subscriptions and scopes above, install to workspace) and ends with the pairing step of section 4.1 for the owner's identity. The setup-flow contribution shape is owned by [Plugin contribution interfaces](https://github.com/rogierpennink/hydra/issues/41).
- A Discord Connection may be in several guilds; a Slack Connection is one workspace. Both surface `status()` into the Connection's status axis ([./08-events-and-connections.md](./08-events-and-connections.md)).

### 11.6 Notification sinks

Both v1 channels implement the sink facet with `interactive: true`. The contract, extended here from [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.3:

```ts
interface NotificationSink {
  interactive: boolean
  deliver(n: Notification, target: ContainerRef): Promise<DeliveryRef>              // throws = retry via outbox
  resolved(n: Notification, target: ContainerRef, ref: DeliveryRef): Promise<void>  // edit in place: answers off, outcome line
}
interface DeliveryRef { platformMessageId: string }

interface ActionClick {
  notificationId: string
  actionId: string
  connectionId: string
  container: ContainerRef
  platformMessageId: string
  sender: { identityKey: string; displayName: string }
}
type ClickOutcome =
  | { kind: "executed"; describe: string }        // the core-rendered describe line, for the edited message
  | { kind: "refused" }                           // sender is not an owner identity
  | { kind: "already-decided"; describe: string }
  | { kind: "failed"; message: string }           // the operation's error; the notification stays unresolved
```

- **Target**: enabling delivery on a channel Connection asks for a **notification container** - a channel or the owner's DM - stored on the Connection; the default offer is the owner's DM once an owner identity on that channel is paired. The target may coincide with a bound conversation's container; the post is still the sink's, never the assistant speaking, and is stored as a conversation message with `origin: notification` (section 4.3). This resolves the sink-target question of [./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.3: an assistant's conversation is a valid *container* for a sink, but a sink post is not an assistant message.
- **Rendering**: title in bold, the body as markdown, then for each answer its label, the producer's description and the core-rendered describe line ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4), then one button per answer carrying the label only (Discord message components; Slack Block Kit `actions`), and a deep link to the in-app record. Informational notifications render without buttons.
- **Clicks**: Discord `INTERACTION_CREATE` type 3 with `custom_id = hydra:<notificationId>:<actionId>` (fits 100 characters), acknowledged at once with a deferred update (type 6); Slack `block_actions` with `action_id = hydra:<actionId>` and `value = <notificationId>`, envelope acknowledged at once. The plugin then calls `host.click()` with the sender's identity key and renders the outcome: `executed` and `already-decided` edit the message through `resolved()`-style rendering; `refused` posts an ephemeral "only the owner can decide"; `failed` posts the error ephemerally and leaves the buttons in place for a retry or another answer.
- **Resolution fan-out**: with deliver-to-all-enabled one decision can sit in Discord, Slack and the web app. The core stores each sink's `DeliveryRef` and, on resolution from anywhere, calls `resolved()` on every sink that delivered: buttons removed, one line "✓ *Start Bugfix* - decided in the web app". If the edit fails the buttons go stale and the pinned "already decided" reply is the safety net.
- Authentication and execution stay in the core ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) section 7.4): the plugin reports a click, it never decides.

## Post-v1

- **Binding-preserving paused state** - deferred, not rejected: re-establishing bindings is real work (Discord bot setup). V1 keeps pausing = remove bindings; a later paused flag adds a state without changing bindings.
- **Cross-assistant recall** as a feature - arrives as agent-to-agent communication ("go ask the triage assistant what we discussed"), never shared memory. V1 keeps memory strictly assistant-scoped so this stays additive; transcripts are already readable by any `session.read` holder, which is a permission fact, not a recall feature.
- **Memory version history** - retrofit is additive (a history table beside the live document); see the reconsideration flag in section 6.4.
- **Journal tier + dream pass** - tested and not adopted (journal entries duplicated in-turn writes, every dream pass cost a run, on 1-7 turn conversations). Standing assumption: in-turn recording degrades in long conversations; if dogfooding shows facts going unrecorded, the design and harness (`prototype/memory-interface`, `--journal 1`) restart from evidence.
- **Read-only memory materialization on runners** - a pure read convenience for native grep, addable later without touching the write path; v1 keeps the API as the only write seam.
- **Feedback-driven triage learning** - user ratings of triage verdicts feeding assistant memory ([./10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md)); a future memory consumer.
- **Third chat channel** (Signal / Telegram / WhatsApp, not committed) - the plugin that proves the channel interface for real.
- **Name-pattern mentions** ("hydra, ..." or the assistant's display name in text, OpenClaw's `mentionPatterns`) - **wanted**, on the record as a strong desire; v1 wakes on platform mentions only because name patterns misfire in groups and every platform has a real mention. Lands as an extra `mention` fact from the plugin plus a per-assistant pattern list, touching no other rule.
- **Image and file input from chat** - v1 delivers attachment links only; fetching bytes with the bot token and handing them to the session as image input needs artifact storage and per-harness image plumbing. The `attachments` field is already on the inbound shape.
- **Slack Agents feature** (native "is typing..." status, streaming replies via `chat.startStream`) - not enabled in v1 (turns every DM into a thread); a plugin-local upgrade if the reaction indicator proves too quiet.
- **Reply top-level in Slack channels** - the channel itself as a conversation instead of a thread per mention; a plugin-local `[channel]` container behind a per-connection setting, touching no core code (section 2).
- **Per-scope trusted identities** (trusted only in this channel) - v1 roles are global per identity; scoping is a column on the identity record.
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
- [Channel contribution interface and conversation ingress (Discord, Slack)](https://github.com/rogierpennink/hydra/issues/39)
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
- [ADR 0023 - Chat messages are conversation input, not events](../adr/0023-chat-messages-are-conversation-input-not-events.md)

Research:

- `research/assistant-systems.md` (branch `research/assistant-systems`) - OpenClaw, Hermes, nanobot, Letta Code field study
- `research/connection-setup-ux.md` (branch `research/connection-setup-ux`) - bot-token paste for Slack/Discord
- `research/channel-platform-facts.md` (branch `research/channel-platform-facts`) - Discord intents, Slack Socket Mode tokens and scopes, limits, click delivery, verified 2026-08-30
