# Hercule

Ubiquitous language for Hercule, a self-hosted agent orchestration platform. This glossary is the vocabulary the v1 spec is written in.

## Language

### Product

**Hercule**:
The product. A controller-plus-runners platform that orchestrates agents doing work on the user's behalf.
_Avoid_: agentick, agentick-next

**Operation**:
One named thing the public API can do (`task.create`, `session.spawn`), the same name in the contract, the HTTP route table and the built-in workflow action. The `hercule` CLI spells it for a terminal (`hercule task list`) and names it in `--help`.
_Avoid_: endpoint, command (bare), method

**Subscription Target**:
What a session-held subscription waits on: a run, a session, an External Ref, or a Permission Request. The shorthand an agent types (`run:r_3`). A run-held subscription's target is the signal trigger it serves, which no session can register.
_Avoid_: filter, topic

### Work

**Task**:
A unit of human intent: a described piece of work someone wants done. Work-type-agnostic; a task is not itself an execution.
_Avoid_: ticket, issue (reserved for external trackers)

**Provenance**:
A task's append-only record of what created or touched it: entries pointing at events, runs, and external refs. What lets a duplicate signal find its existing task.
_Avoid_: history, audit trail (reserved for the event log)

**External Ref**:
A fully-qualified canonical identifier for a thing outside Hercule (`github:issue:owner/repo#42`, `gmail:thread:<id>`). The plugin defining the type owns canonicalization; the connection an event arrived through is not part of the identity. Not unique across tasks.
_Avoid_: link, URL (a ref is an identity, not a location)

**Session**:
One run of a provider-backed agent: its process, context and transcript, resumable and forkable. When its process has exited and its transcript is still on its runner it is resumed in place, under its own id, by the next input; forking mints a new session. Maps onto a Claude Code session, a Codex thread or a pi session. A session copies its configuration from an Agent at spawn and never reads through it afterwards, or has no Agent at all and is a Thread. Not required to belong to a task or workspace.
_Avoid_: execution, chat, conversation (reserved for an assistant's exchange in one channel container); "new session on resume", "continue to resume", "exited = unrecoverable" (an exited session whose transcript is still on its runner is resumed in place, under its own id, by the next input)

**Thread**:
A session the user starts and drives by hand, with no Agent behind it: nothing outlives it, nothing about it is named or reusable. The bare word always means this; a Codex thread or a Slack thread is always qualified.
_Avoid_: interactive session, chat-first session, chat (reserved for a possible non-agentic conversation surface)

**Subagent**:
An agent a session's harness delegated work to while the session runs. It works inside that session's process and settings, has turns and a transcript of its own within the session's, and may start subagents of its own. It is not a Session: it is never resumed or forked on its own, and it does not outlive its session's process.
_Avoid_: task (Task is a unit of human intent, not Claude Code's word for a subagent), child session, sub-session, collab agent, child agent

**User Material**:
The user's own knowledge and configuration from a local harness installation - skills, subagent definitions, instructions, commands, settings. Seen live by Threads on the controller's local runner; never seen by assistant sessions or workflow steps. UI copy may say "personal config".
_Avoid_: user config (ambiguous with instance config), user knowledge, dotfiles

**Run**:
One execution of an execution plan, usually stamped from a workflow. Nothing else in the system is called a run.
_Avoid_: job, execution, workflow instance

**Pinned (Run)**:
A run is pinned to one runner and one workspace when its first Workspace Step starts. Every later Workspace Step of the run goes there. Retiring that runner fails the run.
_Avoid_: bound, assigned, sticky

**Execution Plan**:
The executable content a run executes: triggers, graph, actions. Frozen at run start; immutable thereafter. Usually stamped from a workflow, but may be generated ad-hoc by an agent and never stored.
_Avoid_: recipe, definition (for this), workflow instance

**Re-run**:
A new run started from a run that has ended, with the ended run's resolved inputs. The ended run is the new run's original run, and the new run names it in `originalRunId`. Always the whole run, in one of two modes: Re-stamp or Replay. The ended run is never changed or resumed.
_Avoid_: retry (nothing in a run is retried; a re-run starts over from the entry steps), resume, "re-run failed steps" (partial re-run is post-v1)

**Re-stamp**:
The default Re-run mode: the new run's plan is stamped from the workflow as it is stored now, so a fix made since takes effect. A run with no stored workflow, because its workflow was sent with `run.start` or has been deleted since, cannot be re-stamped, only replayed.
_Avoid_: refresh, rebuild

**Replay**:
The Re-run mode that starts the ended run's frozen Execution Plan again. The new run is meant to do what the ended one was meant to do; its agents and the outside world may still answer differently.
_Avoid_: re-execute; bare "replay" for a live topic or a runner outbox catching up after a reconnect (say cursor replay, outbox replay)

**Run Executor**:
The port through which the runs domain hands a run's execution to be carried out apart from the request that started it, and stops it when the run is cancelled. The runs domain describes the run's execution as an effect and never decides where it runs; the controller daemon implements the port with one fiber per run. "The run's execution" is that effect, never a name for the run itself.
_Avoid_: the run's scheduler (the Scheduler is the core component that fires `cron.tick` and scheduled wakes)

**Turn**:
One user-visible episode of a session's own agent or of one of its subagents: from an input (the user's, or for a subagent its parent agent's) until that agent goes idle. Contains any number of model calls and tool executions; ends by stopping (completed, failed, interrupted), never by replying once. A session's status follows its own agent's turns only.
_Avoid_: exchange, round, iteration

**Token Usage**:
The tokens an agent's model calls have used over a session's whole life. It only grows: compaction does not lower it. A session's covers its own agent and every subagent; a subagent's covers itself alone.
_Avoid_: context usage, context fill (how full the model's window is right now, which drops on compaction), cost (money, not tokens)

**Request**:
A provider-held question that one agent of a session - its own agent or one of its subagents - is parked on until an answer arrives. A session can have several open at once, each from its own asker and each answered on its own, in any order; they are surfaced on the card docked on the thread's composer. A request is one of two different things. An **approval** (`command_approval`, `file_change_approval`, `file_read_approval`, `tool_approval`) names what would be run and is resolved by `session.respondToApprovalRequest` with one of the four `ApprovalDecision` values - allow / allow always / deny / cancel - and never by free text. Every approval a session waits on also raises a decision Notification whose Bound Actions are those same answers, so it can be answered from the notification center too. A **question** (kind `question`) carries one to many structured questions (chip, prose, options, whether several may be chosen) and is resolved by `session.respondToQuestion` with answers, each either one or more of the offered options or a custom string the user types. A question takes no decision: to turn it down, the user stops the asking agent's turn. Only the rendering is alike.
_Avoid_: user input (the old name for the `question` kind), permission request (reserved for grant escalation), approval prompt, tool prompt

**Steering**:
Delivering user input into a session's running turn, folding it into that turn instead of opening a new one. A guarantee every session gives: where the provider cannot steer natively, the running turn is interrupted and the input is sent as the next turn. An owner's message to a busy assistant is steered without being asked.
_Avoid_: interrupt (that's stopping a turn), inject

**Queued Input**:
User input held by the controller for delivery when the session's running turn completes. Editable and cancelable until delivered, except on an assistant's conversation session, whose inputs are the owner's messages and go in unchanged. A conversation's session keeps its queued input through any exit and is resumed for it. An agent step's session keeps its step prompt through an exit that is no fault of the session (an idle unload, a runner restart) and is resumed for it. Any other session, a Thread included, has it cancelled at any exit.
_Avoid_: follow-up (provider-native term), pending message

**Draft Thread**:
A thread the user is still composing: it does not exist on the controller yet, and its config and first message are held by the client until the first submission starts it.
_Avoid_: new-thread mode, create form, pending thread

**Active Thread**:
A thread that exists as a Session on the controller, whatever its status. Everything a draft could set is fixed except the model and its options.
_Avoid_: existing thread, materialized thread, live thread

**Thread Config**:
What a thread runs with: provider instance, model and its options, access mode, runner, permission profile, workspace, checkout and branch. Set by the draft at start.
_Avoid_: settings (reserved for the settings store), spec (reserved for the session spec), setup

**Message Draft**:
The unsent content the composer holds for one thread: text today, attachments and context later. One per thread, draft or active.
_Avoid_: prompt (the first message as the spawn carries it), composer state

**Submission**:
What the composer hands the system when the user sends: the message draft plus every config pick made since the last submission. On a draft thread it starts the thread; on an active thread it is one input, the picks applied to the session before the input is stored.
_Avoid_: send, payload, message (bare)

### Actors

**Agent**:
A named, reusable configuration and identity for work: prompt, provider instance, permission profile and session defaults. Supplies values to a session at spawn; the session never reads through it afterwards. Owned by the controller, not by any repo.
_Avoid_: persona, worker (as a noun)

**Assistant**:
An agent with persistent memory, oriented toward delegating work rather than doing it. Reachable through channel bindings and directly in the web app; a specialization of agent, not a separate concept. Different personas are different assistants, never one assistant with per-channel variants.
_Avoid_: persona

**Actor**:
Who performed an operation against the API: the user, a session, a run's built-in action step, or a plugin. Stamped on every mutation; widened, never restructured, when multi-user arrives.
_Avoid_: principal, subject

**Permission Profile**:
The named bundle of operation grants attached to an agent and copied onto each of its sessions (a thread takes the user's thread default), bounding what the session may do through the API. Parity with the user is the ceiling, not the default.
_Avoid_: role, scope set

**Session Token**:
The credential minted per session whose subject is that Session: injected into the session's environment by the runner, carrying the session's permission profile, dead when the session ends.
_Avoid_: API key (reserved for user credentials), auth session

**API Key**:
A long-lived user credential: an opaque revocable token minted via login, used by the ops CLI and scripts. Always the user's identity, never an agent's.
_Avoid_: personal access token, service token

**Grant**:
One operation-family permission inside a permission profile, written family-dot-verb (`task.delete`, `infra.write`); the unit a 403 names and an escalation asks for. Families are coarser than the operations they cover.
_Avoid_: scope, right

**Permission Request**:
An agent's ask for a grant its profile lacks, optionally naming the operation it wanted to make, surfaced as a notification the user approves for the session, bakes into the profile, or denies.
_Avoid_: escalation (as a noun for the record), override

**Platform Identity**:
One person's account on one chat platform, recorded with a role: an owner (the user; may command an assistant and decide bound actions) or a trusted person (may command, never decides). Claimed by a pairing code; anyone without one is context in groups and ignored in DMs.
_Avoid_: allowlist entry, member, user (reserved for the future Hercule user concept)

**Master Key**:
The per-machine key that encrypts secret values in the controller database; held in the OS keychain and never leaves its machine, even during promotion.
_Avoid_: root key, database key

### Assistants

**Channel Binding**:
A rule mapping part of a channel connection (all its DMs, or a nested place: a server, a channel, a thread) to exactly one assistant; the most specific binding wins. How channels reach an assistant, not what makes it one.
_Avoid_: registration, route (bare)

**Conversation**:
One continuous exchange with an assistant inside one platform container: a Discord channel, thread or DM, a Slack thread or DM, or the assistant's one conversation on the web channel. Each conversation has its own session lineage and is never merged with another; continuity across conversations comes from memory and recall. The lineage is derived, not stored: it is the sessions that carry the conversation's id, and the current session is the newest of them. Its messages are conversation input, never events.
_Avoid_: chat, thread (reserved for provider-native objects)

**Conversation Message**:
One line of a conversation, stored in order with its sender's role and label: what the owner said, the assistant's reply, or a notice. A reply or a notice links to the session that wrote it. The owner's words reach the assistant only as a conversation message, so the conversation is the record of what was said; channels add third-party and bot lines. Input to an assistant, never an event.
_Avoid_: chat message, event, input (bare; a Queued Input is the session-side delivery of an owner's message)

**Notice**:
A conversation message the system writes in one of two forms: "<name> was interrupted: <reason>" when the session exits while a turn runs, or when a turn fails or is stopped while the session lives; and "<name> can't be reached: <why>" when a message cannot be delivered, because no session could take it, the session holding it cannot be resumed, or the crash-loop guard holds that session. No other event writes one. It lives in the conversation it explains and is read there. Not a Notification: it is never recorded centrally, never delivered through other channels, and never carries a decision.
_Avoid_: notification (Hercule's central message to its user), error message, alert

**Idle Unload**:
Stopping the process of a session after it has sat idle for a while: an assistant's conversation session after `session.idleUnloadMinutes` (15 by default), and an agent step's session after five seconds, so a finished step frees its runner slot for the run's next step. The wait starts when the session starts, and again each time a turn ends. Until [#431](https://github.com/theagenticage/hercule/issues/431) makes a session start carry its first input, a resumed step session whose prompt takes longer than five seconds to arrive unloads before its turn, and its step fails. A Thread is never unloaded. The session exits with reason `idle_unload`, and the next input resumes it in place under its own id. An assistant's conversation session keeps any input still waiting, as it does at every exit. An agent step's session keeps only its waiting step prompt, unless the crash-loop guard holds the session. That makes the idle unload a special exit for it: any exit other than an idle unload or a runner restart cancels the step prompt and fails the step. Frees the machine without changing anything the session remembers, but ends any background process the session started, such as a dev server; not a rotation. It writes no notice, because no turn runs at an idle unload. An assistant's owner sees the assistant as "asleep", the presence word for an exited conversation session the next message resumes; that is a word on screen, not a name for the unload.
_Avoid_: sleep (as the name of the unload), hibernate, suspend, rotation

**Rotation**:
Retiring a conversation's live session by distilling what matters into memory and continuing the conversation in a fresh session. Triggered by context size, a daily timer, or the user asking to start fresh; never mid-turn; distillation is part of the contract, not an optional step. Distinct from a session's process merely stopping while idle and resuming later, which changes nothing the assistant remembers.
_Avoid_: reset, compaction (reserved for provider-native context handling)

**Memory**:
An assistant's durable notes: assistant-scoped, maintained by the assistant itself, visible and editable by the user, bounded in size, never shared between assistants. Two tiers: a single **core** note (always present in every session; what the assistant knows about the user, as opposed to the persona the user wrote for it) and named **topic** notes (each with a one-line gist, listed by name and gist, opened on demand). A note written while the assistant could see third-party messages carries a provenance mark the user can review.
_Avoid_: knowledge base, brain, journal

**Heartbeat**:
An assistant's standing recurring scheduled wake with a user-editable prompt, letting it check on things and act unprompted. On by default; the main mechanism of true proactivity. A heartbeat that finds nothing to say stays silent.
_Avoid_: poll

**Scheduled Wake**:
Waking an assistant at a time rather than on an event: a prompt delivered into one of its conversations by the scheduler. Two kinds: the recurring heartbeat and one-shot reminders. Never a run, never an event.
_Avoid_: cron job (a workflow's cron trigger is the thing that fires on a cron schedule), scheduled task

**Reminder**:
A one-shot scheduled wake an assistant sets on itself (or the user sets for it), delivered back into the conversation that created it, so the assistant can act or speak at that time.
_Avoid_: timer, alarm

### Organization

**Project**:
A grouping of related work and its materials, purely a way to organise information inside Hercule: no behaviour, no defaults. May span multiple resources (repos, folders, mailboxes), and a resource may belong to several projects; not bound to a single git repo.
_Avoid_: workspace (as a grouping term)

**Resource**:
A durable external thing a project works with: a git repo, a folder, a mailbox. A vocabulary term, not a promise of a common code interface.
_Avoid_: source, asset, material

**Canonical remote**:
The identity of a repo resource: `host/owner/repo`, lowercased, with the scheme, the user, the port and a `.git` suffix taken off, so `git@github.com:Acme/Web.git` and `https://GitHub.com/acme/web` are one repository. A second resource on a canonical remote one already holds is a conflict, and it is what a machine's credential request is matched against.
_Avoid_: URL, origin, clone URL (for the identity; those are spellings of it)

**Workspace**:
A provisioned working area on a runner in which sessions do their work, containing zero or more checkouts. Two kinds: a **primary** workspace (exactly one checkout; at most one per resource per runner; long-lived and shared) and **ephemeral** workspaces (provisioned for one run, disposed after; zero checkouts makes a scratch workspace, several makes a multi-repo workspace). A run has exactly one workspace, shared by all its agent steps. A session may also run with no workspace at all.

The user-facing word for a primary is **main workspace**: `primary` is the kind in code, on the wire and in the database, and "main workspace" is what every label, menu row, help text and sentence a person reads calls it. It is always Hercule's own clone under the runner's storage - Hercule never takes over a folder the user already has.
_Avoid_: worktree (reserved for the git mechanism), playground; current checkout, shared checkout, main checkout (all three named the primary before; "main workspace" replaced them), adopt (adopting a folder in place is not built)

**Workspace Lease**:
A holder's use of a workspace - a session or a run - recorded on the workspace when the holder opens or joins it. It is active until the holder releases it. At release the holder picks how long the workspace is kept, and that time is fixed then. The sweep deletes an ephemeral workspace once no lease is active and every lease's kept-until time has passed.
_Avoid_: claim (a Subscription is a claim), pin (a run is pinned to a runner), reference count

**Checkout**:
One working copy of a single resource inside a workspace. In v1 only git repos are checkout-able.

**`.workspaceinclude`**:
A file in a repo listing untracked paths, one relative path per line with `#` comments, that a fresh checkout takes from the resource's primary workspace on the same machine. An existing vendor convention Hercule reads, never Hercule configuration stored in a repo; whether it is read at all is a flag on the resource.
_Avoid_: include file, copy list

### Infrastructure

**Controller**:
The always-on brain: holds all state, receives events, schedules work. The single source of truth; repos hold no Hercule config.

**Controller Daemon**:
The layer above the controller's domains (`apps/controller/src/daemon/`). Domains decide *what* happens; the controller daemon decides *where and how* it runs. It owns the wire to runners (it is the only module that sends frames to runners, and the only one that handles what they report, passing each result to the domain that owns it; the providers domain and `runner.refreshFacts` are the last exceptions, tracked in [#209](https://github.com/theagenticage/hercule/issues/209)), the fibers and process lifetime behind the ports domains declare, the ports that break a cycle between two domains, the drivers that run for the life of the controller, and boot. It holds a domain's orchestration only as the last resort for breaking a cycle in the domain graph. In prose it is always the **controller daemon**, never bare "daemon".
_Avoid_: "daemon" alone (that is a runner process), orchestrator, god service

**Runner**:
A daemon on a machine that executes sessions on the controller's behalf. Bare "daemon" means this process; the layer inside the controller is always the **Controller Daemon**.
_Avoid_: bare "daemon" for the controller daemon

**Reserved**:
A runner flag: a reserved runner hosts only work explicitly placed on it (named by the user or a workflow, resolved by the "local" alias, or following a workspace already there); placement fallback never chooses it. For personal machines that should never catch scheduled work.
_Avoid_: unreliable, personal (as a state name)

**Fleet**:
All runners enrolled with a controller, viewed as a collective.

**Runner Connections**:
The controller's live wiring to the fleet (`apps/controller/src/runners/connections.ts`): the volatile map of which runner is reachable through which socket, the queues that carry what machines report and what this domain changes itself (session traffic, fleet traffic), the stream of arrivals, and the outbound `tell` and `asked` over a connection. Addresses, envelopes, mailboxes - nothing durable here. Not the registry: the durable list of runners with their facts and status is the runners table behind `RunnerService`. The controller daemon is the only reader of what it carries in and the only sender of what it carries out (the providers domain and `runner.refreshFacts` are the last exceptions, tracked in [#209](https://github.com/theagenticage/hercule/issues/209)).
_Avoid_: presence (the old name), registry

**Runner Capability**:
A fact about a runner used for placement: a probed toolchain or a user-applied label.
_Avoid_: bare "capability" where the kind isn't obvious

**Runner Facts**:
The probed facts a runner self-reports about itself: OS and architecture, RAM, toolchains, and which provider CLIs are on PATH. Reported at hello, refreshed hourly with a report only on change, and refreshed unconditionally on demand via `runner.refreshFacts`.
_Avoid_: re-probe

**Promotion**:
Moving the controller to another machine by migrating its state bundle. A migration, never a live handoff; the old controller ends up sealed.
_Avoid_: failover, handoff

**Sealed**:
The end state of a controller that has been promoted away: it refuses to serve and answers callers with a signed pointer to the controller's new address.

**Data Root**:
The single directory holding everything the controller durably owns (database, packed secrets, future blobs). The unit that promotion moves; nothing in it references its own absolute location.

**Hercule Home**:
The one directory holding everything Hercule keeps on a machine: the Data Root, runner material state, logs, backups, and bootstrap config. `~/.hercule` by default. The Data Root moves with promotion; the rest of the home is machine-bound.
_Avoid_: install dir, config dir

**Service Unit**:
The one unit per machine that the OS supervisor keeps running: a launchd LaunchAgent on macOS, a systemd user unit on Linux. It runs `hercule serve` on the controller's machine and `hercule runner` on a runner-only machine, with the machine's Hercule Home. `hercule service` installs and manages it; `hercule runner join` installs it for a runner. The controller's local runner is the controller's child process and has no Service Unit of its own.
_Avoid_: daemon (that is a runner process), LaunchAgent or systemd unit as the general term, service file, supervisor (that is launchd or systemd)

**Provider**:
An adapter wrapping an interactive coding harness (Claude Code, Codex, pi). Only this; integrations like GitHub are event sources, not providers.
_Avoid_: harness (for the adapter itself), integration

**Provider Definition**:
A provider's static self-description: identity, config schema, declared capabilities. What a provider plugin registers; distinct from the running adapter.

**Provider Instance**:
One account of a provider: a row carrying the config that provider runs under, with its own isolated provider home on every runner and its own vendor login. The instance id, never the provider id, is what placement, snapshots and the composer route on, because one provider can hold several accounts. The controller opens one per registered provider at boot.
_Avoid_: provider account, provider config (for the row), profile

**Secret Field**:
A config field a provider definition marks secret: its value is never part of the instance's config but a Secret owned by the provider instance, entered through a masked input, hidden on every read, and decrypted only as a frame to a runner is built. Spelled `secret()` and `secretFields` in the plugin host, `ProviderSecretField`/`secretFields` in the contract, and `InstanceSecrets` in the protocol, which is the one place the values themselves travel.
_Avoid_: API key field, pi key, credential field

**Access Mode**:
The session-level permission axis a provider adapter enforces: approval-required, auto-accept-edits, auto, or full-access. A fixed vocabulary; per-provider support is declared, and a mode a provider lacks is substituted before the session starts by a hardcoded fallback chain that only ever moves to a less permissive mode, never silently.
_Avoid_: permission mode (vendor term), runtime mode

**Capability Snapshot**:
The merged declared-plus-probed facts about a provider instance on a specific runner: auth state, harness version, model catalog. What UI affordances derive from; never obtained by creating or mutating a provider conversation.
_Avoid_: provider status

**Channel**:
A chat surface Hercule speaks through (Discord, Slack). The web channel is the built-in one: the web app's own conversation with an assistant, with no Connection or plugin behind it.

**Live Topic**:
A named stream a connected client watches over its live connection: a session transcript, the event feed, notifications. A client viewing concern only; not a Subscription, which is a domain claim on events held by a run or session.
_Avoid_: subscription (reserved for the domain concept)

### Extension

**Plugin**:
A self-contained unit of functionality that extends Hercule by requesting plugin capabilities and registering contributions. The structuring principle of v1: channels, event sources, providers, and workflow actions are all built as plugins.
_Avoid_: extension, addon, integration

**Extension Point**:
A typed slot plugins contribute into. The v1 set is fixed: provider, channel, event source, workflow action. Plugins cannot define new extension points.
_Avoid_: hook

**Contribution**:
A named thing a plugin provides into an extension point, referenced by its qualified id across the system: a workflow step names an action contribution, an assistant binds to a channel contribution. Registered in code, never listed in the manifest.

**Qualified Id**:
The identity of a catalog contribution: `<pluginId>/<word>`, where the plugin declares the bare word and the host prefixes its plugin id (`github/github`, `github/pr.merge`, `discord/discord`). Unique by construction, so two plugins may declare the same word; never parsed to find the owner. Not an event kind (`github.issue.opened`) and not an operation (`task.create`), which are namespaced their own way.
_Avoid_: namespaced id, fully-qualified id (reserved for External Ref), type (bare)

**Plugin Capability**:
A named slice of the host API a plugin requests in its manifest and is granted at load, scope-style. What a plugin may *call*, as opposed to a contribution, which is what it *provides*.
_Avoid_: bare "capability" where the kind isn't obvious; scope, permission

**Host API**:
The surface a plugin programs against: capability-sliced services handed to the plugin at load. A plugin never reaches controller internals directly.

**Manifest**:
A plugin's static self-description: identity, host API version, requested plugin capabilities, config schema. Deliberately coarse; contributions are not in it.

### Automation

**Connection**:
A core-owned, named link to one external account: a plugin-defined type, by its qualified id, plus label (the external account's name unless the user names it, at setup or later), credentials, and status (e.g. `gmail/gmail`/"work"). Event ingest runs per connection, every event is stamped with its connection, and outbound actions name the connection they act as.
_Avoid_: account (reserved for a future Hercule user concept), instance

**Event Source**:
An origin of external events. GitHub and Gmail are event-source plugins in v1; cron, manual, and platform events are emitted by the core into the same pipeline.
_Avoid_: integration, provider

**Platform Event**:
An event emitted by the controller itself rather than an external source (`run.completed`, `run.failed`, `run.cancelled`, `task.created`, `task.updated`). Flows through the same pipeline as external events and is routed like them, so triggers and subscriptions can wait on it. An audit entry sits in the same log but is never routed, and is not a platform event.
_Avoid_: internal event, system event

**Core Kind**:
An event kind the core declares rather than a plugin: `cron.tick`, which the Scheduler emits for cron triggers, and the kinds of the Platform Events. A trigger on a core kind names no Connection, because its events arrive through none. No trigger names `cron.tick`: a cron trigger writes a Schedule instead, and each tick reaches only the cron trigger it was emitted for. No plugin can declare a kind with the name of a core kind.
_Avoid_: built-in kind, system kind, internal kind

**Event**:
A fact that happened, emitted by an event source ("issue #42 was labelled ready-for-agent").

**Feed**:
A named poll cadence an event-source contribution declares (`notifications`, `repos`, `checks`): the plugin declares the numbers, the core runs one timer per connection per feed. A push-driven source declares none.
_Avoid_: poller, loop

**Enrichment**:
Post-ingest amendment of an event's `system`, `url`, or `refs` (append-only) by a sender rule or the triage agent. Gives the Event Router one more idempotent look at that event; never re-delivers to consumers that already fired.
_Avoid_: editing events, reprocessing

**Event Router**:
The one consumer of the event log. It walks the events past its own durable cursor, tests each one against every routing table, and calls the table's write for every route whose condition holds. It carries nothing to anyone: a delivery reads the rows a table wrote. One consumer and one cursor, so a restart re-delivers nothing and drops nothing.
_Avoid_: matcher, dispatcher, event bus

**Routing Table**:
The routes one kind of destination owns: one per live session-held subscription, one per live run-held subscription, or one per active start trigger of an enabled workflow. Prepared inside the routing transaction, so a subscription created or cancelled while a pass runs is wholly before it or wholly after it.

**Delivery**:
The downstream consumer of one kind of row. It reads its own rows, whoever wrote them, and acts on the ones that can act now; idempotent, so a crash between a write and its delivery loses nothing.

**Matched Input**:
The Queued Input the Event Router writes for a holder session when a route's condition holds, marked with the subscription and the event. Unique per that pair, so a second pass over the same event writes nothing.
_Avoid_: wake-up (keep that word for the one a restart lost, in text a person reads)

**Trigger Effect**:
One start trigger's match on one event, holding the inputs the trigger mapped from it. The Event Router writes it `pending`; a delivery starts its run later, in a transaction of its own, and marks it `spawned` with the run's id, or `discarded` when its event was pruned, or its trigger paused or its workflow disabled, before then, or when its start died of a bug. So a routing pass only writes rows and never waits on a run. Unique per trigger and event, so a second pass over the same event writes nothing.
_Avoid_: pending run (the run does not exist until the effect is delivered)

**Expression**:
A CEL source stored on a subscription or a trigger and evaluated against one event, or against a run's inputs and steps, answering whether it matches or producing a value. Checked when it is saved, and evaluated against the context it is handed and nothing else. `condition` is the stored field on a subscription; the concept is an expression.
_Avoid_: rule, predicate string

**Workflow**:
A named, stored, editable source of execution plans. Owns its triggers; can be as small as one trigger plus one action. Editing a workflow never affects in-flight runs.
_Avoid_: recipe

**Trigger**:
A workflow's rule for when events enter it. Two kinds: a start trigger (static condition, spawns a new run) and a signal trigger (condition shape plus correlation key; a source node of the graph that fires its outgoing edges each time a matching event reaches the live run). What a trigger fires on is its `on`: an Event Selector, or for a start trigger a Schedule. A start trigger whose `on` is a Schedule is a **cron trigger**. Lives inside the workflow, not as a standalone routing entity.
_Avoid_: rule, hook

**Event Selector**:
The `on` of a trigger that fires on events: an event kind, the Connection selection (a Connection id or `any`, absent for a core kind), and an optional filter expression over `event`. Every signal trigger has one; a start trigger has one or a Schedule.
_Avoid_: trigger source, source (an Event Source is where an event comes from; the selector says which events a trigger accepts)

**Schedule**:
The `on` of a cron trigger: a five-field cron expression and an optional timezone, the user's timezone setting when absent. It has no filter, because the cron expression already sets when it fires. When it comes due, the Scheduler appends a `cron.tick` event through the one pipeline, and that event starts the run.
_Avoid_: cron job, timer, `cron.tick` trigger (no trigger names `cron.tick`)

**Step**:
One node of an execution plan's graph. Two kinds in v1: an action step (calls a Workflow Action) and an agent step (drives a session and may declare an output schema for the graph to route on). A step may be re-entered; each entry is an **iteration**.
_Avoid_: stage, job

**Iteration**:
One entry of a run into a step, numbered 1, 2, 3 in the order the run came to it. A loop, or an *any* join whose edges fire more than once, gives a step several iterations. Each iteration has its own step record, and `steps.<id>` in an expression reads the latest one that finished.
_Avoid_: retry (a run never retries a step), turn (a turn belongs to a session)

**Step Record**:
What one step, or one signal trigger, did in one iteration of a run: its status, times, output or error. Created `pending`, then `running` and `completed`, `failed` or `cancelled`, or `skipped`. Its status only moves forward: a step that runs again gets a new record. A signal trigger's record is written `pending` by the Event Router when an event matches, and the run marks it `completed` as it fires the trigger's edges.
_Avoid_: step run, step instance

**Workflow Action**:
What an action step calls: one piece of work with a declared input and output, in the action catalog. A plugin declares one under a bare word and it is named by its qualified id (`github/pr.merge`); the core declares the Built-in Actions. A step writes the action's input as `params`, and the action's answer is the step's output. A step cannot name the action of a plugin that does not run.
_Avoid_: action (bare, where a Bound Action could be meant), tool, command, task (reserved for Task)

**Built-in Action**:
A Workflow Action the core declares: an operation of the public API, with the operation's id (`task.create`), an input drawn from the operation's input, and the operation's output, so a step reaches nothing that an API request cannot. Owned by `core` in the catalog and never disabled.
_Avoid_: core action, native action, system action

**Controller Action**:
A Workflow Action that runs on the controller, with the run's context. Every plugin action is one, and so is every Built-in Action that is an operation.
_Avoid_: server action, local action

**Workspace Action**:
A Workflow Action that runs on the run's runner, in the run's workspace, such as `git.commit`. Built into the runner in v1; the controller keeps its catalog entry. It runs commands as argument lists, never as shell strings.
_Avoid_: runner action, remote action, exec

**Workspace Step**:
A step whose work happens on the run's runner: an action step that calls a Workspace Action, or an agent step, whose session runs there. The run is pinned to its runner when its first workspace step starts, and the runner reports how each workspace step ended.
_Avoid_: remote step, runner step

**Step Key**:
The triple `(runId, stepId, iteration)` that names one iteration of a step. Every delivery of a Workspace Step and of its outcome is idempotent by it, so either side can send it again after a restart. An agent step's prompt is the exception: it is sent at most once, because a second turn could repeat what the first one did, and the controller asks for the step's result instead.
_Avoid_: step id (bare, which names the step, not the iteration)

**Entry Step**:
A step where a run begins: a step with `entry: true`, or a step that no edge leads into. A run starts every entry step. A step that only a signal trigger leads into is not one, because it waits for its signal. A workflow in which an edge leads into every step needs `entry: true` on the step where a run begins.
_Avoid_: start step, root step, first step

**Join**:
How a step with several incoming edges behaves: an *any* join runs a new iteration for every incoming edge that fires (the default); an *all* join runs once, when no incoming edge can fire any more and at least one has fired.
_Avoid_: gateway, barrier (for the any case)

**Skip**:
A step not run because its author-written condition was false when its step record would have started; the record ends `skipped`. A skipped step has no output, and its outgoing edges are evaluated as if it had completed, so the steps after it are written to expect that.
_Avoid_: bypass

**Terminal Step**:
A step whose completion completes the run, ending whatever else is still running or waiting. Its output is the run's output. A skipped terminal step does not end the run.
_Avoid_: end node, exit

**Subscription**:
A live, correlated claim on future events, held by a run or a session ("deliver events about PR #87 to me"). The runtime instantiation of a signal trigger, or registered directly by a session. Dies with its holder.
_Avoid_: watch, listener

**Spawn Bound**:
A trigger's limit on how many runs it may spawn per window. Exceeding it trips the trigger into a paused state with its matched events held visibly for user review; never a silent drop.
_Avoid_: rate limit (bare), throttle

**Notification**:
A persisted message from Hercule to its user ("run failed", "trigger paused", "agent needs a decision"). Produced by the core, by workflow notify steps, by sessions, or by plugins; always recorded centrally, with delivery through channels decided by the core, never claimed by plugins. A decision stays open until its question is answered, wherever that happens, and is withdrawn when the question stops existing; nothing else about it ever changes.
_Avoid_: alert, ping, notice (a conversation message saying an assistant could not answer)

**Bound Action**:
One answer on a decision Notification, carrying the single frozen operation that runs as the user when chosen. Proposed by whoever produced the notification (an agent, a run, a plugin, the core); authorised only by the user's informed choice, never by the proposer's own permissions. The operation is one on a short curated list of bindable operations, or none at all; beside its label, every answer shows a **Describe Line**.
_Avoid_: button (as the domain term), callback, quick action

**Describe Line**:
The line the core writes under a Bound Action to say what taking it does to the system ("Start a run of *Bugfix*", "Send *continue* to session *Design ordering module*"), built from the frozen operation with the current names of what it acts on. The producer never writes, changes or hides it; that is what makes the user's choice an informed one.
_Avoid_: summary, preview, action description (the producer's own `description` of what an answer means)

**Intake**:
The formation boundary where external signals become work: signals are triaged, grouped, and enriched by agents before they spawn tasks or reach the user, so decisions are made on prepared, high-value material rather than raw input. Also the name of the view that presents it (confirmed by ticket #30).
_Avoid_: command center, inbox, dashboard

**Proposal**:
A task the agents prepared and are asking the user to accept or dismiss: a Task labelled `proposed` together with its open go/no-go Notification. Accepting means "this is work" and leaves the task in the backlog; starting it is a separate act. The unit Intake presents; a vocabulary term, not a separate entity.
_Avoid_: suggestion, recommendation, candidate

**Offer**:
An immediate action triage proposes with no task behind it ("merge these three dependency bumps"): a decision Notification whose answers carry the action and a dismiss. Decided by its answers alone; leaves nothing when dismissed.
_Avoid_: quick fix, shortcut, suggestion

**Topic**:
A label that groups Intake: a Connection may carry a topic its events file into, and triage labels a proposal with a topic (the connection's when it has one, unless the content says otherwise). A new Connection starts with none. User-defined and ordered; a label, never a domain state.
_Avoid_: category, area, folder

### Office

**Office**:
The view that shows the user's sessions as characters at work in one 3D place: each session at a desk in a room, queuing at the user's desk while it has an open Request. One view, whatever its Office Map makes it look like.
_Avoid_: virtual office, floor view, scene

**Office Map**:
The description an Office is built from: its fixed rooms and their furniture, what a wing and a room stand for, and the named rule by which the place grows as sessions arrive. A bureau, a tower and a cave are different office maps of the same Office; inside the Office the UI says "map".
_Avoid_: map (bare, outside the Office), level, floor plan, layout, variant
