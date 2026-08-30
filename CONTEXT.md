# Hydra

Ubiquitous language for Hydra, a self-hosted agent orchestration platform. This glossary is the vocabulary the v1 spec is written in.

## Language

### Product

**Hydra**:
The product. A controller-plus-runners platform that orchestrates agents doing work on the user's behalf.
_Avoid_: agentick, agentick-next

**Operation**:
One named thing the public API can do (`task.create`, `session.spawn`), the same name on every surface: the contract, the HTTP route table, the CLI command, and the built-in workflow action.
_Avoid_: endpoint, command (bare), method

**Subscription Target**:
What a session-held subscription waits on: a run, a session, an External Ref, or a Permission Request. The shorthand an agent types (`run:r_3`).
_Avoid_: filter, topic

### Work

**Task**:
A unit of human intent: a described piece of work someone wants done. Work-type-agnostic; a task is not itself an execution.
_Avoid_: ticket, issue (reserved for external trackers)

**Provenance**:
A task's append-only record of what created or touched it: entries pointing at events, runs, and external refs. What lets a duplicate signal find its existing task.
_Avoid_: history, audit trail (reserved for the event log)

**External Ref**:
A fully-qualified canonical identifier for a thing outside Hydra (`github:issue:owner/repo#42`, `gmail:thread:<id>`). The plugin defining the type owns canonicalization; the connection an event arrived through is not part of the identity. Not unique across tasks.
_Avoid_: link, URL (a ref is an identity, not a location)

**Session**:
One conversation with a provider-backed agent, resumable and forkable. Maps onto a Claude Code session or Codex thread. A session can drive work directly (chat-first) and is not required to belong to a task or workspace.
_Avoid_: execution, thread (reserved for provider-native objects)

**Run**:
One execution of an execution plan, usually stamped from a workflow. Nothing else in the system is called a run.
_Avoid_: job, execution, workflow instance

**Execution Plan**:
The executable content a run executes: triggers, graph, actions. Frozen at run start; immutable thereafter. Usually stamped from a workflow, but may be generated ad-hoc by an agent and never stored.
_Avoid_: recipe, definition (for this), workflow instance

**Turn**:
One user-visible episode of a session: from a user input until the agent goes idle. Contains any number of model calls and tool executions; ends by stopping (completed, failed, interrupted), never by replying once.
_Avoid_: exchange, round, iteration

**Steering**:
Delivering user input into a session's running turn, folding it into that turn instead of opening a new one.
_Avoid_: interrupt (that's stopping a turn), inject

**Queued Input**:
User input held by the controller for delivery when the session's running turn completes. Editable and cancelable until delivered.
_Avoid_: follow-up (provider-native term), pending message

### Actors

**Agent**:
A configured identity that does work: prompt, provider, capabilities. Owned by the controller, not by any repo.
_Avoid_: persona, worker (as a noun)

**Assistant**:
An agent with persistent memory, oriented toward delegating work rather than doing it. Reachable through channel bindings and directly in the web app; a specialization of agent, not a separate concept. Different personas are different assistants, never one assistant with per-channel variants.
_Avoid_: persona

**Actor**:
Who performed an operation against the API: the user, a session, a run's built-in action step, or a plugin. Stamped on every mutation; widened, never restructured, when multi-user arrives.
_Avoid_: principal, subject

**Permission Profile**:
The named bundle of operation grants attached to an agent, bounding what its sessions may do through the API. Parity with the user is the ceiling, not the default.
_Avoid_: role, scope set

**Session Token**:
The credential minted per session whose subject is that Session: injected into the session's environment by the runner, carrying the agent's permission profile, dead when the session ends.
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
_Avoid_: allowlist entry, member, user (reserved for the future Hydra user concept)

**Master Key**:
The per-machine key that encrypts secret values in the controller database; held in the OS keychain and never leaves its machine, even during promotion.
_Avoid_: root key, database key

### Assistants

**Channel Binding**:
A rule mapping part of a channel connection (all its DMs, or a nested place: a server, a channel, a thread) to exactly one assistant; the most specific binding wins. How channels reach an assistant, not what makes it one.
_Avoid_: registration, route (bare)

**Conversation**:
One continuous exchange with an assistant inside one platform container: a Discord channel, thread or DM, a Slack thread or DM, a web chat. Each conversation has its own session lineage and is never merged with another; continuity across conversations comes from memory and recall. Its messages are conversation input, never events.
_Avoid_: chat, thread (reserved for provider-native objects)

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
_Avoid_: cron job (reserved for workflow triggers), scheduled task

**Reminder**:
A one-shot scheduled wake an assistant sets on itself (or the user sets for it), delivered back into the conversation that created it, so the assistant can act or speak at that time.
_Avoid_: timer, alarm

### Organization

**Project**:
A grouping of related work and its materials. May span multiple resources (repos, folders, mailboxes); not bound to a single git repo.
_Avoid_: workspace (as a grouping term)

**Resource**:
A durable external thing a project works with: a git repo, a folder, a mailbox. A vocabulary term, not a promise of a common code interface.
_Avoid_: source, asset, material

**Workspace**:
A provisioned working area on a runner in which sessions do their work, containing zero or more checkouts. Two kinds: a **primary** workspace (exactly one checkout; at most one per resource per runner; long-lived and shared, the resource's main checkout) and **ephemeral** workspaces (provisioned for one run, disposed after; zero checkouts makes a scratch workspace, several makes a multi-repo workspace). A run has exactly one workspace, shared by all its agent steps. A session may also run with no workspace at all.
_Avoid_: worktree (reserved for the git mechanism), playground

**Checkout**:
One working copy of a single resource inside a workspace. In v1 only git repos are checkout-able.

### Infrastructure

**Controller**:
The always-on brain: holds all state, receives events, schedules work. The single source of truth; repos hold no Hydra config.

**Runner**:
A daemon on a machine that executes sessions on the controller's behalf.

**Fleet**:
All runners enrolled with a controller, viewed as a collective.

**Runner Capability**:
A fact about a runner used for placement: a probed toolchain or a user-applied label.
_Avoid_: bare "capability" where the kind isn't obvious

**Promotion**:
Moving the controller to another machine by migrating its state bundle. A migration, never a live handoff; the old controller ends up sealed.
_Avoid_: failover, handoff

**Sealed**:
The end state of a controller that has been promoted away: it refuses to serve and answers callers with a signed pointer to the controller's new address.

**Data Root**:
The single directory holding everything the controller durably owns (database, packed secrets, future blobs). The unit that promotion moves; nothing in it references its own absolute location.

**Hydra Home**:
The one directory holding everything Hydra keeps on a machine: the Data Root, runner material state, logs, backups, and bootstrap config. `~/.hydra` by default. The Data Root moves with promotion; the rest of the home is machine-bound.
_Avoid_: install dir, config dir

**Provider**:
An adapter wrapping an interactive coding harness (Claude Code, Codex, pi). Only this; integrations like GitHub are event sources, not providers.
_Avoid_: harness (for the adapter itself), integration

**Provider Definition**:
A provider's static self-description: identity, config schema, declared capabilities. What a provider plugin registers; distinct from the running adapter.

**Access Mode**:
The session-level permission axis a provider adapter enforces: approval-required, auto-accept-edits, auto, or full-access. A fixed vocabulary; per-provider support is declared, and a mode a provider lacks is substituted before the session starts by a hardcoded fallback chain that only ever moves to a less permissive mode, never silently.
_Avoid_: permission mode (vendor term), runtime mode

**Capability Snapshot**:
The merged declared-plus-probed facts about a provider instance on a specific runner: auth state, harness version, model catalog. What UI affordances derive from; never obtained by creating or mutating a provider conversation.
_Avoid_: provider status

**Channel**:
A chat surface Hydra speaks through (Discord, Slack).

**Live Topic**:
A named stream a connected client watches over its live connection: a session transcript, the event feed, notifications. A client viewing concern only; not a Subscription, which is a domain claim on events held by a run or session.
_Avoid_: subscription (reserved for the domain concept)

### Extension

**Plugin**:
A self-contained unit of functionality that extends Hydra by requesting plugin capabilities and registering contributions. The structuring principle of v1: channels, event sources, providers, and workflow actions are all built as plugins.
_Avoid_: extension, addon, integration

**Extension Point**:
A typed slot plugins contribute into. The v1 set is fixed: provider, channel, event source, workflow action. Plugins cannot define new extension points.
_Avoid_: hook

**Contribution**:
A named thing a plugin provides into an extension point, referenced by id across the system: a workflow step names an action contribution, an assistant binds to a channel contribution. Registered in code, never listed in the manifest.

**Plugin Capability**:
A named slice of the host API a plugin requests in its manifest and is granted at load, scope-style. What a plugin may *call*, as opposed to a contribution, which is what it *provides*.
_Avoid_: bare "capability" where the kind isn't obvious; scope, permission

**Host API**:
The surface a plugin programs against: capability-sliced services handed to the plugin at load. A plugin never reaches controller internals directly.

**Manifest**:
A plugin's static self-description: identity, host API version, requested plugin capabilities, config schema. Deliberately coarse; contributions are not in it.

### Automation

**Connection**:
A core-owned, named link to one external account: a plugin-defined type plus label, credentials, and status (e.g. `gmail`/"work"). Event ingest runs per connection, every event is stamped with its connection, and outbound actions name the connection they act as.
_Avoid_: account (reserved for a future Hydra user concept), instance

**Event Source**:
An origin of external events. GitHub and Gmail are event-source plugins in v1; cron, manual, and platform events are emitted by the core into the same pipeline.
_Avoid_: integration, provider

**Platform Event**:
An event emitted by the controller itself rather than an external source (`run.completed`, `run.failed`, `task.created`, `task.updated`). Flows through the same pipeline as external events.
_Avoid_: internal event, system event

**Event**:
A fact that happened, emitted by an event source ("issue #42 was labelled ready-for-agent").

**Workflow**:
A named, stored, editable source of execution plans. Owns its triggers; can be as small as one trigger plus one action. Editing a workflow never affects in-flight runs.
_Avoid_: recipe

**Trigger**:
A workflow's rule for when events enter it. Two kinds: a start trigger (static condition, spawns a new run) and a signal trigger (condition shape plus correlation key; a source node of the graph that fires its outgoing edges each time a matching event reaches the live run). Lives inside the workflow, not as a standalone routing entity.
_Avoid_: rule, hook

**Step**:
One node of an execution plan's graph. Two kinds in v1: an action step (invokes a plugin-contributed workflow action) and an agent step (drives a session and may declare an output schema for the graph to route on). A step may be re-entered; each entry is an **iteration**.
_Avoid_: stage, job

**Join**:
How a step with several incoming edges behaves: an *any* join runs a new iteration for every incoming edge that fires (the default); an *all* join runs once, when every incoming edge has fired or can no longer fire.
_Avoid_: gateway, barrier (for the any case)

**Skip**:
A step not run because its author-written condition was false. A skipped step has no output; the steps after it are written to expect that.
_Avoid_: bypass

**Terminal Step**:
A step whose completion completes the run, ending whatever else is still running or waiting.
_Avoid_: end node, exit

**Subscription**:
A live, correlated claim on future events, held by a run or a session ("deliver events about PR #87 to me"). The runtime instantiation of a signal trigger, or registered directly by a session. Dies with its holder.
_Avoid_: watch, listener

**Spawn Bound**:
A trigger's limit on how many runs it may spawn per window. Exceeding it trips the trigger into a paused state with its matched events held visibly for user review; never a silent drop.
_Avoid_: rate limit (bare), throttle

**Notification**:
A persisted message from Hydra to its user ("run failed", "trigger paused", "agent needs a decision"). Produced by the core, by workflow notify steps, or by plugins; always recorded centrally, with delivery through channels decided by the core, never claimed by plugins.
_Avoid_: alert, ping

**Bound Action**:
One answer on a decision Notification, carrying the single frozen operation that runs as the user when chosen. Proposed by whoever produced the notification (an agent, a run, a plugin, the core); authorised only by the user's informed choice, never by the proposer's own permissions.
_Avoid_: button (as the domain term), callback, quick action

**Intake**:
The formation boundary where external signals become work: signals are triaged, grouped, and enriched by agents before they spawn tasks or reach the user, so decisions are made on prepared, high-value material rather than raw input. Also the name of the view that presents it (confirmed by ticket #30).
_Avoid_: command center, inbox, dashboard

**Proposal**:
A task the agents prepared and are asking the user to accept, park, or dismiss: a Task labelled `proposed` together with its pending go/no-go Notification. The unit Intake presents; a vocabulary term, not a separate entity.
_Avoid_: suggestion, recommendation, candidate

**Topic**:
A label that groups Intake: each Connection files its events into one default topic, and triage labels a proposal with a topic (the connection's, unless the content says otherwise). User-defined and ordered; a label, never a domain state.
_Avoid_: category, area, folder
