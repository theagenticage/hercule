# Overview and scope

Hercule is a self-hosted agent orchestration platform: one always-on controller, any number of runners that host agent sessions, workflows that turn external events into agent work, and assistants that talk to the user on chat channels and remember across conversations. This document is the front door of the v1 spec. It states what Hercule is, the decisions every other document builds on, the three deployment roles, how one event travels through the system, and exactly what v1 ships and does not ship. Everything below is normative; subsystem detail lives in the owning document, linked at each stage.

## What Hercule is

Hercule orchestrates agents doing work on the user's behalf. Agents are configured identities (prompt, provider, capabilities) owned by the controller. They do their work in sessions on runners, driven by interactive coding harnesses (Claude Code, Codex, pi) behind provider adapters. Work enters the system as events (a GitHub issue labelled, a mail received, a cron tick, a manual trigger), is triaged and shaped by agents before the user sees it, and is executed by workflows: stored, editable definitions of triggers, steps, and routing. Between the user and the agents sits one public API; the web app, the `hercule` CLI, and the agents themselves are all clients of it.

Hercule is the successor to old agentick (Python). Old agentick is a quarry for ideas, never a constraint. Its product name is Hercule; "agentick" and "agentick-next" are retired labels (see [CONTEXT.md](../../CONTEXT.md)).

## Identity features of v1

These five features define v1. A build that lacks one of them is not v1.

1. **Controller/runner split.** One controller holds all state and makes every orchestration decision; runners on other machines host sessions and workspaces. [03-controller-and-runners.md](./03-controller-and-runners.md).
2. **Event-triggered workflows.** External and platform events start runs and resume live runs through one persisted pipeline. [08-events-and-connections.md](./08-events-and-connections.md), [07-workflows.md](./07-workflows.md).
3. **Workflows as stored definitions.** A workflow is a named, editable definition in the controller database; each run freezes its own execution plan, so edits never touch in-flight runs ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md)). [07-workflows.md](./07-workflows.md).
4. **Assistants with memory, bound to channels.** An assistant is an agent with persistent, assistant-scoped memory, reachable through Discord and Slack bindings and the web app. [12-assistants.md](./12-assistants.md).
5. **Agents can operate everything the user can.** Agents ride the public API through the `hercule` CLI with a session token; parity with the user is the ceiling, bounded by permission profiles. [11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md), [13-security.md](./13-security.md).

Ticket #15 adds a sixth, named **Intake**: the quality of agent prep-work before signals reach the user (triaging, grouping, enriching, proactively making connections the user would not make) is the product's value center. Intake ships built entirely on primitives: Tasks, Notifications, and runs driven through the public API. If the Intake surface ever forces a new core concept, that is a design smell to escalate, not a feature to add. [10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md), [14-web-app.md](./14-web-app.md).

## Standing decisions

These decisions predate the design tickets. They are fixed context for the whole spec and are not reopened by any subsystem document.

- **Clean-slate TypeScript codebase.** Controller, runner, and plugins are one language in one repository. The controller and runner are written on Effect 4, with Effect Schema as the contract language ([ADR 0031](../adr/0031-the-backend-is-written-on-effect.md), 2026-09-02); the web app stays outside Effect ([./14-web-app.md](./14-web-app.md)). Old agentick is a quarry for ideas, never a constraint, and never a data source: v1 starts empty (see [out of scope](#v1-scope-out-of-scope)).
- **Providers wrap interactive harnesses.** The v1 providers are Claude Code (via the Agent SDK), Codex (via the app server), and pi (via the pi.dev SDK). A provider is only this; integrations such as GitHub are event sources, not providers.
- **No repo-local config.** The controller's state is the single source of truth. A repository is one kind of workspace material and holds no Hercule configuration. This is the mistake that held back old agentick and it is not repeated.
- **Single-user v1.** There is one user. No tenancy machinery is built, but no decision may make a later user concept a rewrite. The concrete guard: every mutation is stamped with an actor (`user` or `session:<id>`) that is widened, never restructured, when multi-user arrives.
- **Plugin architecture is the structuring principle.** Channels, event sources, providers, and workflow actions are built internally as plugins in v1. Dynamic third-party loading comes later; v1 proves the plugin API by dogfooding. [05-plugins.md](./05-plugins.md).
- **Work-type-agnostic domain model.** A Task is human intent, never coupled to code. Only coding features are built in v1. [02-domain-model.md](./02-domain-model.md).
- **Channels v1: Discord and Slack. Event sources v1: GitHub, Gmail, cron, manual.**
- **API-first core.** The web app is the primary surface and is built desktop-shell-ready (a desktop app is high priority later). A thin ops CLI is the same binary as the agent-facing `hercule` CLI, under a user credential.
- **Follow t3-code heavily for third-party provider integration.** t3-code (pingdotgg/t3code) drives the Agent SDK with Claude subscription auth in practice and is the prior art for the provider abstraction (thin adapter, large normalized event union with raw passthrough). It offers no prior art for the controller/runner split; its remote model is connection-only. Findings: `research/t3code.md` (branch `research/t3code`). Where the spec deviates from t3-code it says so (for example, never silently substituting an access mode; see [06-providers.md](./06-providers.md)).
- **Intake is a v1 identity feature** (see above).

## Deployment roles

Hercule has three roles. All three ship in one self-contained binary behind subcommands, with CI-enforced mode isolation ([ADR 0018](../adr/0018-hercule-ships-as-one-self-contained-binary.md)); see [15-packaging-and-operations.md](./15-packaging-and-operations.md).

**Controller.** The always-on brain. It holds all durable domain state in one SQLite database ([ADR 0004](../adr/0004-controller-state-lives-in-one-sqlite-database.md)), receives every event, matches triggers, interprets execution plans, places sessions, routes notifications, serves the public API and the web app bundle, and loads all plugins (plugins are controller-only in v1). Orchestration never leaves the controller ([ADR 0002](../adr/0002-orchestration-stays-on-the-controller.md)). The controller has a stable logical identity that survives being moved to another machine ([ADR 0005](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)). It needs no public endpoint; the supported perimeter is a LAN or tailnet ([13-security.md](./13-security.md)).

**Runner.** A daemon on a machine that executes sessions on the controller's behalf. It dials the controller over one persistent WebSocket, accepts no inbound connections from the controller (its only listener is a loopback `GET /identity` used by clients to resolve the "local" alias), and keeps a disk-backed outbox so a disconnect loses nothing. A runner owns material state only: workspace files, provider-native session data, its outbox. Sessions run as bare processes, no containers ([ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)). The default install starts an ordinary local runner, auto-joined at first boot, through no special code path. Provider CLIs are installed and logged in per runner; tokens are never distributed. [03-controller-and-runners.md](./03-controller-and-runners.md).

**Clients.** Everything that talks to the controller through the public API: the web app (a static SPA served by the controller, [ADR 0017](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)), the `hercule` CLI (as an ops tool under a user API key, or inside a session under a session token), and agents themselves ([ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md)). Plugins run in-process on the controller and reach the same service layer only through the `public-api` plugin capability. Nothing is reachable in-process that HTTP cannot reach. [11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md), [14-web-app.md](./14-web-app.md).

## Architecture at a glance

The walk below follows one GitHub issue from the outside world to the user's check-in. Each stage names the document that owns it. The path is the recommended topology (triage as the only doorway between raw events and expensive work); it is a shipped default and convention, never enforced by the core.

**1. Ingest.** The GitHub event-source plugin polls the watched repositories of one Connection (a core-owned link to one external account, [ADR 0010](../adr/0010-external-accounts-are-core-owned-connections.md)) and sees a new issue labelled `ready-for-agent`. It normalizes the fact into one event envelope, stamped with its connection, a `system`, and a `url`, and emits it through a host-API capability. The core alone persists it. Cron ticks, manual synthetic events, and platform events (`run.completed`, `run.failed`, `task.created`, `task.updated`) enter the same pipeline from core emitters ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)). Owner: [08-events-and-connections.md](./08-events-and-connections.md). Plugin mechanics: [05-plugins.md](./05-plugins.md). Persistence: [04-state-store.md](./04-state-store.md).

**2. Match.** A durable-cursor consumer evaluates every enabled start trigger and every live subscription against the event, using CEL conditions, and writes effect rows (a pending run, a signal delivery, a queued session input) in one transaction. The triage workflow's start trigger matches. Its spawn bound is checked here: if the trigger has exceeded its per-window limit, the trigger trips into paused, the event is held visibly, and the user is notified; nothing is dropped silently. Owner: [08-events-and-connections.md](./08-events-and-connections.md); spawn-bound breaker semantics: [10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md).

**3. Triage run.** The controller stamps a run from the triage workflow, freezing an immutable execution plan and copying the triggering event ([ADR 0001](../adr/0001-runs-freeze-an-execution-plan.md)). Triage is a workflow pattern, not an engine ([ADR 0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)): a `task.query` action first looks for an existing Task by exact provenance ref (`github:issue:owner/repo#42`), so a duplicate signal becomes a cheap `task.update`; otherwise a cheap agent step with a structured-output schema forms a verdict (verdict, priority, confidence, grouping, related tasks, suggested step), and graph edges route on it ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)). The verdict is stored on the run. Owner: [10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md); workflow, step, and routing semantics: [07-workflows.md](./07-workflows.md); structured output per harness: [06-providers.md](./06-providers.md).

**4. Task and Proposal.** The triage agent, working through the `hercule` CLI, creates a Task: a thin row with a fixed status axis `open -> in-progress -> done` plus `cancelled`, labels, optional project, and an append-only provenance pointing at the event and the run ([ADR 0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)). Labelled `proposed` and paired with a pending go/no-go Notification whose actions bind an operation ("Start Bugfix" = start workflow X with task Y), the Task is a Proposal: the unit Intake presents. The `task.created` platform event flows back into the pipeline. Owner: [09-tasks.md](./09-tasks.md) for the Task; [10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) for Proposal, Topic, verdict, and bound actions.

**5. Decision.** The user sees the Proposal in the Intake view (a morning brief framed on "since you last checked", grouped by Topic, with the triage verdict as the trust surface) and accepts it with a quiet action. The bound operation runs as the user (the actor is the user clicking; the operation was authored by an agent). Alternatively a work workflow triggers directly on `task.updated` with no human in the loop. Owner: [14-web-app.md](./14-web-app.md) for the view; [10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md) for the bound-action semantics; [../design-language.md](../design-language.md) for the pinned Intake semantics.

**6. Work run and placement.** The work workflow's run reaches an agent step. The controller places the session: capability filter, then explicit choice, then the default runner, then the local runner; queue if the runner's session cap is full, never spill. It provisions the run's one workspace on that runner (an ephemeral worktree on the run's branch off the resource's bare cache, or the resource's shared primary checkout) and pins the whole run there ([ADR 0002](../adr/0002-orchestration-stays-on-the-controller.md), [ADR 0003](../adr/0003-sessions-run-as-bare-processes.md)). Git credentials for the checkout derive from the Resource's Connection through an on-demand credential helper; identity follows the repo, never the agent ([ADR 0016](../adr/0016-git-credentials-derive-from-connections.md)). Owner: [03-controller-and-runners.md](./03-controller-and-runners.md); credentials: [13-security.md](./13-security.md).

**7. Session on the runner.** The runner-side provider adapter starts a session as a bare process in an isolated provider home, with the access mode already resolved to one the provider supports natively (unsupported modes fall back by hardcoded, strictly downward policy, never silently). The adapter normalizes the harness's output into one event stream with raw passthrough ([ADR 0007](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md)); the controller stores it as an append-only per-session stream, written in the same transaction as the state it accompanies. The runner injects `HERCULE_API_URL`, `HERCULE_TOKEN`, and `HERCULE_SESSION=1` (the marker that blocks fallback to user credentials); the token's subject is the Session row, carries the agent's permission profile, and dies with the session. Through the `hercule` CLI the agent updates its Task, opens a PR, and registers a subscription to that PR's events; every mutation is stamped `actor: session:<id>`. Calls never block; the agent subscribes and ends its turn, and the matching event wakes it as queued input. Owner: [06-providers.md](./06-providers.md) for the adapter; [11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) for the token, CLI, and subscriptions; [13-security.md](./13-security.md) for profiles and escalation; [04-state-store.md](./04-state-store.md) for streams.

**8. Completion and notification.** The PR-merged event resumes the run through its signal trigger; the run closes the Task (done-means-PR-merged is a shipped-workflow convention, not a core rule) and reaches a terminal state, emitting `run.completed`. A run failure produces a Notification: one core-owned persisted record, routed by the core to every enabled sink (the web app's notification center always; Discord and Slack channel connections when toggled on). Sinks are dumb ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)). Owner: [10-triage-intake-and-notifications.md](./10-triage-intake-and-notifications.md); channel delivery behaviour: [12-assistants.md](./12-assistants.md).

**9. Check-in.** The user opens the check-in view: a backward-looking monitor where each row is a strand (a task, a standing workflow, a one-off run), attention is ordered by provenance (you > standing > routine) and age, decisions are questions with quiet-button answers, and needs-you and notifications are the same record stream on two surfaces. An assistant bound to a Discord channel and subscribed to the run's events may also speak unprompted, without double-firing with the notification. Owner: [14-web-app.md](./14-web-app.md); assistant behaviour: [12-assistants.md](./12-assistants.md).

Two concerns cut across every stage. Security (perimeter, secrets under a keychain-held master key per [ADR 0015](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md), user auth, permission profiles, taint) is [13-security.md](./13-security.md). Installation, Hercule Home, service supervision, migrations, upgrade, and backups are [15-packaging-and-operations.md](./15-packaging-and-operations.md).

## V1 scope: what ships

| Area | V1 |
|---|---|
| Roles | Controller, runner, clients; one binary, Linux and macOS runners, no Windows |
| Providers | Claude Code (Agent SDK), Codex (app server), pi (pi.dev SDK); each pinned to an exact harness release behind its adapter |
| Channels | Discord, Slack (as channel plugins) |
| Event sources | GitHub (watched-repo polling: issue and PR lifecycle plus notifications), Gmail (history.list polling); cron, manual, and platform events from the core |
| Workflows | Declarative definitions, start and signal triggers, action and agent steps, CEL conditions, bounded cycles, structured agent output, whole-run re-run |
| Triage and Intake | Triage as shipped workflow defaults; per-trigger spawn bounds with breaker semantics; Tasks, Proposals, Topics; Notifications with bound actions |
| Assistants | Several assistants, channel bindings, generational sessions with rotation, two-tier bounded memory reached only through the API, heartbeat on by default |
| Agent surface | `hercule` CLI over the public HTTP API with session tokens and permission profiles (three shipped profiles: assistant, worker, unrestricted) |
| Surfaces | Web app (static SPA, desktop-shell-ready) and the `hercule` CLI (ops and agent use) |
| State | One SQLite database; event log as audit log; daily backups |
| Security | LAN/tailnet perimeter; per-value encrypted secrets; password login plus revocable API keys |
| Operations | `hercule service install` (systemd/launchd), zero-ceremony first run with a one-time setup URL, migrations on boot, `hercule upgrade`, controller promotion |

The domain model is work-type-agnostic, but only coding features are specified and built. Workspaces are git-only; mailboxes and folders never produce workspaces.

## V1 scope: out of scope

Every item below is ruled beyond the v1 destination. It returns only if the destination is redrawn. Where v1 keeps a constraint so the item can land later, the constraint is stated.

### Platform and fleet

- **Dynamic third-party plugin loading.** V1 proves the plugin API by dogfooding internal features; external loading (isolation, versioning, marketplace) is a later effort.
- **Runner-side plugin loading.** V1 plugins load controller-only; runner-side provider execution is built-in but plugin-shaped, lifted once three real providers have taught the hooks (ticket #11).
- **Fleet auto-discovery and push-install** (LAN/tailnet scanning, one-click runner install from the fleet UI). Ruled post-v1 by ticket #7; v1 protects it with a fully programmatic join exchange and a reserved "Add machine" spot showing the join command.
- **Native OS sandboxing** (macOS Seatbelt, Linux Landlock; containers a far-remoter option). Ruled post-v1 by ticket #8; returns as a probed runner capability behind the existing capability negotiation.
- **Import from old agentick.** Nothing is imported: not tasks, sessions, workflows, agent definitions, prompts, or environments. V1 starts empty and the user re-adds repositories by hand through onboarding. A `.agentick/` directory in a repository is another product's convention; Hercule ignores it exactly as it ignores any other tool's folder, with no detection and no warning. Ruled by ticket #47.
- **Hercule-managed toolchains and an Environment concept** (named toolchain plus setup bundles, old agentick's environments reborn). Post-v1; v1 treats toolchains as machine facts surfaced as runner capabilities.
- **Folder-resource workspaces.** No versioning story for non-git materials yet; v1 workspaces are git-only, mailboxes never produce workspaces. Ruled by ticket #8.
- **Artifact storage** (sessions producing artifacts held by the controller). Not in v1. Constraint pinned by ticket #10 for when it lands: artifact and blob storage must live inside the controller Data Root and move with the promotion bundle; streaming or resumable transfer is the escape hatch if volume hurts.
- **Multi-user / team support.** Single user in v1; the actor stamp is the kept seam.
- **Desktop app.** High priority later; v1 only obliges the web app to be desktop-shell-ready (framework-agnostic `client-core` plus shared `ui` package, no domain logic in components).
- **Non-coding work features.** The domain model stays work-type-agnostic, but no non-coding features are specified or built in v1.

### Plugins and extension points

- **UI-contribution extension point** (plugins shipping web, desktop, or mobile UI). Ruled post-v1 by ticket #11: the design is not nailed and it would have to span three surfaces.
- **Agent-tools extension point** (plugin-contributed MCP servers or skills for sessions). Deferred by ticket #11: no v1 consumer, since hercule-as-a-tool ships built-in (runner CLI plus skill); the session spec keeps per-session MCP config passthrough so the point lands later without redesign. First concrete consumer identified by ticket #14: mid-session mailbox queries (v1: Gmail action steps plus MCP passthrough).
- **Hercule MCP server** (the public API exposed to sessions as typed MCP tools, t3-code-style self-injection). Ruled post-v1 by ticket #16: v1 delivery is the `hercule` CLI only (one artifact, no per-adapter wiring). High on the revisit list; the MCP passthrough keeps the door open.

### Events, channels, and triggers

- **Webhook ingress core service** (plugins request it by capability; unlocks GitHub push, commit, and Actions triggers). Ruled post-v1 by ticket #14; on the record as strongly desired and non-negotiable post-v1. V1 GitHub coverage is watched-repo polling: "on push to main" is not a v1 trigger.
- **Gmail Pub/Sub pull ingress** (second-level latency upgrade). Ruled post-v1 by ticket #14; v1 polls history.list and the plugin interface stays push-agnostic.
- **Third chat channel** (Signal, Telegram, or WhatsApp; not committed to which). A later channel plugin that will prove the interface for real.
- **Calendar event source.** Adds OAuth surface without stressing the event-source interface differently than Gmail.

### Workflows

- **Human-gate workflow step.** Ruled post-v1 by ticket #13: unclear what question a workflow can pose upfront (an agent mid-session should just ask the user); v1 covers the human moment with run-failure notifications plus re-run. Returns post-dogfooding.
- **Workflow conveniences: sub-workflow steps, graduation ("save as workflow"), per-workflow concurrency controls, automatic retries, partial re-run.** Ruled post-v1 by ticket #13: each needs a dogfooding-proven need before its design is credible; graduation especially is what dogfooding should establish.

### Triage, bounds, and notifications

- **Spend caps and quiet hours as core bounds.** Ruled out by ticket #15: per-run cost is unreliable under subscription auth (v1 displays cost where reported, never gates on it); quiet hours are covered by pausing workflows.
- **Presence-aware notification routing** ("desktop idle -> send to phone"). Ruled post-v1 by ticket #15; the core-push router ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)) keeps routing central, so it lands as a router upgrade touching no plugin; the sink contract grows additively (device class, presence, receipts).
- **Feedback-driven triage learning** (rating or correcting verdicts feeding assistant memory). Ruled post-v1 by ticket #15; v1 review is run records plus editing prompts and filters; noted to ticket #17 as a future memory consumer.

### Assistants and memory

- **Cross-assistant recall / agent-to-agent communication.** Ruled post-v1 by ticket #17: recalling what happened with another assistant arrives as agents talking to each other ("go ask the triage assistant"), never as shared memory or transcripts.
- **Assistant paused state** (binding-preserving). Ruled post-v1 by ticket #17; deferred, not rejected: re-establishing bindings is real work (Discord bot setup), so a paused state that keeps them is credible later. V1 pausing = remove bindings.
- **Assistant memory version history.** Ruled post-v1 by ticket #17: unclear it would ever be perused; the retrofit is additive (a history table beside the live document). Ticket #31 later saw cap-triggered rewrites drop content (Codex pruned fifteen unique decisions after one rejection) and flagged it for reconsideration; see [12-assistants.md](./12-assistants.md).
- **Journal tier plus dream pass for assistant memory** (cheap append-only notes curated by a scheduled agent pass). Tested and not adopted by ticket #31: agents record in-turn anyway, journal entries duplicated topics, every dream pass cost a run. Returns if dogfooding shows facts going unrecorded; the design and harness (`--journal 1`) are kept on the ticket.
- **Read-only memory materialization on runners** (memory as files for native grep, writes still via API). Ruled post-v1 by ticket #31: no measured ergonomic gain over API reads; a pure read convenience addable later without touching the write path.

### Web app

- **Bespoke per-workflow-type UIs** (for example a scheduled-tasks view over cron-triggered workflows). Ruled post-v1 by ticket #19: the v1 screen inventory is fixed without them; ticket #14 confirmed the blocks suffice (a scheduled-task form is sugar over a one-step cron-triggered workflow).
- **Visual drag-and-drop workflow authoring.** Ruled post-v1 by ticket #19; v1 edits workflows as schema-validated structured text with a read-only auto-laid-out DAG preview, ringfenced so a visual editor can replace the module's internals later.
- **Web Push notifications.** Ruled post-v1 by ticket #19: service workers need a secure context the plain-HTTP LAN default does not give; v1 web = in-app notification center, push beyond that is what channels are for; native desktop notifications arrive with the desktop app.
- **Merging Intake and check-in into one spine.** Ruled post-dogfooding by ticket #30: two views in v1; only usage will show what gets used.
- **Narrative morning-brief prose** (an agent-written summary opening the Intake page). Tried and not adopted by ticket #30; if wanted later it is an assistant or cron workflow posting to a channel, not an Intake feature.

### Not yet specified

Four items are neither in nor out; they sharpen with dogfooding and are tracked in [16-open-items.md](./16-open-items.md): a presentation layer over task status (kanban-style groupings, explicitly not domain states); platform-auto subscription detection (explicit subscription is the v1 primitive); execution-plan snapshot dedup and GC (content-hash dedup is the known escape hatch); Task and Project pruning (both soft-delete in v1 and events live as long as a live Task refers to them, so the log's real bound is task retention).

## How this spec is organised

The spec is sixteen documents under `docs/spec/`, one per subsystem, listed with what each owns in [README.md](./README.md). Read them in number order for a first pass; each document is self-contained enough to build from, and states any constraint a neighbour handed to it. Open questions, verify-at-build-time notes, and post-v1 items from every document are collected in [16-open-items.md](./16-open-items.md).

The vocabulary is [CONTEXT.md](../../CONTEXT.md). Every document uses its terms exactly and respects its "Avoid" lists. The visual language for all UI is [design-language.md](../design-language.md).

Rationale lives in the ADRs, not in the spec documents. All twenty:

- [ADR 0001 - Runs freeze an execution plan instead of versioning workflows](../adr/0001-runs-freeze-an-execution-plan.md)
- [ADR 0002 - Orchestration stays on the controller; runners host sessions and workspaces](../adr/0002-orchestration-stays-on-the-controller.md)
- [ADR 0003 - Sessions run as bare processes on runners](../adr/0003-sessions-run-as-bare-processes.md)
- [ADR 0004 - Controller state is plain relational rows in one SQLite database](../adr/0004-controller-state-lives-in-one-sqlite-database.md)
- [ADR 0005 - Promotion is migration behind a stable controller identity](../adr/0005-promotion-is-migration-behind-a-stable-controller-identity.md)
- [ADR 0006 - Plugins request capability scopes in a manifest and register contributions in code](../adr/0006-plugins-request-capabilities-and-register-contributions-in-code.md)
- [ADR 0007 - Provider adapter is a thin interface behind a normalized event stream](../adr/0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md)
- [ADR 0008 - Workflow graphs route on declared outputs; cycles are bounded by capped edges](../adr/0008-workflow-graphs-route-on-declared-outputs.md)
- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0010 - External accounts are core-owned Connections](../adr/0010-external-accounts-are-core-owned-connections.md)
- [ADR 0011 - Triage is a workflow pattern inside core-enforced bounds](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)
- [ADR 0012 - Notifications are core-routed; sinks are dumb](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)
- [ADR 0013 - Agents operate Hercule through the public API, behind one contract with two transports](../adr/0013-agents-operate-hercule-through-the-public-api.md)
- [ADR 0014 - Assistants remember through distilled memory, not merged sessions](../adr/0014-assistants-remember-through-distilled-memory-not-merged-sessions.md)
- [ADR 0015 - Secrets are encrypted per-value under a keychain-held master key](../adr/0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md)
- [ADR 0016 - Git credentials derive from Connections, delivered on demand](../adr/0016-git-credentials-derive-from-connections.md)
- [ADR 0017 - The web app is a static pure client of the public API, with a subscriptions-only live overlay](../adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)
- [ADR 0018 - Hercule ships as one self-contained binary, supervised by the OS, living in one home directory](../adr/0018-hercule-ships-as-one-self-contained-binary.md)
- [ADR 0019 - The task model is thin; workflows own task semantics](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)
- [ADR 0020 - Assistant memory is reached only through the API](../adr/0020-assistant-memory-is-reached-only-through-the-api.md)
- [ADR 0021 - One operation vocabulary, coarse grants, explicit routes](../adr/0021-one-operation-vocabulary-coarse-grants-explicit-routes.md)
- [ADR 0022 - Proposing is not doing](../adr/0022-proposing-is-not-doing.md)

Research findings (facts about third-party systems) live on `research/*` branches under `research/` and are cited from the subsystem documents that use them.

## Post-v1

The full ruled-out list is the "Out of scope" section above. The items that v1 keeps a concrete constraint for, so they land later without a rewrite:

- Multi-user: the actor stamp on every mutation is widened, never restructured.
- Fleet auto-discovery and push-install: the join exchange is fully programmatic.
- Native OS sandboxing: arrives as a probed runner capability behind capability negotiation.
- Artifact storage: must live inside the Data Root and move with promotion.
- Agent-tools extension point and Hercule MCP server: the session spec keeps per-session MCP passthrough.
- Presence-aware routing: the sink contract grows additively.
- Visual workflow authoring: the editor module is ringfenced.
- Desktop app: `client-core` and `ui` packages carry no domain logic in components.

## Sources

Tickets:

- [Domain model & ubiquitous language](https://github.com/rogierpennink/hydra/issues/6)
- [Controller/runner architecture: registration, placement, scheduling](https://github.com/rogierpennink/hydra/issues/7)
- [Runner execution substrate](https://github.com/rogierpennink/hydra/issues/8)
- [Controller promotion & portability](https://github.com/rogierpennink/hydra/issues/10)
- [Plugin architecture: API shape, loading, dogfooding](https://github.com/rogierpennink/hydra/issues/11)
- [Workflow model: recipes, triggers, human gates](https://github.com/rogierpennink/hydra/issues/13)
- [Event & trigger ingress design](https://github.com/rogierpennink/hydra/issues/14)
- [Triage engine & user-set bounds](https://github.com/rogierpennink/hydra/issues/15)
- [Agent-operates-system surface](https://github.com/rogierpennink/hydra/issues/16)
- [Assistant design: memory, identity, channel binding](https://github.com/rogierpennink/hydra/issues/17)
- [Security & secrets model](https://github.com/rogierpennink/hydra/issues/18)
- [Web app architecture: observability-first, desktop-shell-ready](https://github.com/rogierpennink/hydra/issues/19)
- [Prototype: the check-in view](https://github.com/rogierpennink/hydra/issues/20)
- [Assemble the v1 spec](https://github.com/rogierpennink/hydra/issues/21)
- [Research: t3-code's provider integration and remote support](https://github.com/rogierpennink/hydra/issues/22)
- [Controller packaging & install story](https://github.com/rogierpennink/hydra/issues/24)
- [Task model: shape, status axis, lifecycle, provenance](https://github.com/rogierpennink/hydra/issues/29)
- [Prototype: the Intake view](https://github.com/rogierpennink/hydra/issues/30)
- [Prototype: assistant memory interface](https://github.com/rogierpennink/hydra/issues/31)
- The wayfinder map, issue #1 (Destination, Notes, Decisions so far, Out of scope): https://github.com/rogierpennink/hydra/issues/1

ADRs: 0001 through 0021, listed above.
