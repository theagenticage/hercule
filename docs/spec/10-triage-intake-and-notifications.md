# Triage, Intake and Notifications

Hydra has no triage engine. Deciding what matters is an ordinary workflow: a CEL trigger filter is the rules layer, a cheap agent step with a structured-output schema is the judgment layer, and graph edges route the verdict ([ADR 0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)). The core contributes only mechanics: per-trigger spawn bounds with breaker semantics, five built-in workflow actions, and one persisted Notification record that the core alone routes to dumb delivery sinks ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)). Intake - the formation boundary where external signals become prepared work - and check-in - monitoring delegated work - are both built entirely on these primitives (Tasks, Notifications, Runs, the public API). This document pins the pattern, the recommended topology, the verdict, the bounds, the built-in actions, the Notification record with its router, sinks and bound actions, and the model-level requirements the Intake and check-in views impose. The views themselves belong to [./14-web-app.md](./14-web-app.md).

## 1. Triage is a workflow pattern

A triage workflow is built from the same blocks as every other workflow ([./07-workflows.md](./07-workflows.md)). Three layers:

| Layer | Block | What it decides |
|---|---|---|
| Rules | CEL filter on a start trigger | Which raw events enter at all ("label is `ready-for-agent`", "sender not in newsletter list"). Cheap, deterministic. |
| Judgment | Agent step with an output schema | What the event means: verdict, priority, grouping, related tasks, suggested next step. The prompt is user-editable; the schema is the contract with the graph. |
| Routing | Edge conditions over `steps.<id>.output.*` | Where the verdict goes: create a proposal, attach to an existing task, notify, ignore. |

Consequences the implementer relies on:

- There is no core triage component, no triage workflow type, and no triage configuration. The core cannot tell a triage workflow from any other workflow and never tries to.
- "What matters" lives in an editable prompt and an editable filter, never in engine settings.
- Review and correction in v1 is reading the run record and editing the prompt or filter. Every triage decision is an ordinary Run: input event, verdict, route taken (see [Section 3](#3-the-triage-verdict)). No separate audit is needed.
- Escalation when the agent is unsure is an explicit verdict value in the output enum. The graph routes it to a `notify` step and the run ends. The human acts out-of-band (tells an assistant to proceed, starts a workflow manually, edits the task). There is no waiting-for-human machinery in v1; the human-gate step is post-v1 and the unsure-case UX is the evidence for whether it earns its return.

## 2. Recommended topology

Convention plus shipped default workflows, never enforced. Nothing stops a user wiring expensive work directly to raw events; the protection is the convention, the defaults and the spawn bounds.

```
external events ──▶ triage workflow(s) ──▶ Tasks ──▶ work workflow(s)
(GitHub, Gmail,     CEL filter            buffer    trigger on task.created /
 cron, manual)      guard (task.query)              task.updated
                    agent verdict
                    task.create / task.update / notify
```

- Triage workflows are the only doorway between raw external events and expensive work. They trigger on external events and search, create and update Tasks.
- Work workflows trigger on the task platform events `task.created` and `task.updated` (payload = changed fields with old and new values; CEL covers "status became X" via `event.changes.status.new == "in-progress"`; there are no finer-grained task event kinds). Event shapes are pinned in [./09-tasks.md](./09-tasks.md).
- Tasks are the buffer. Triage never starts a work run directly; it leaves a Task, and the Task's platform event starts work. This is what lets the user see, edit, group and cancel prepared work before money is spent.
- Provenance-only appends also fire `task.updated`, so shipped defaults MUST demonstrate field-filtering (`has(event.changes.status)`) so work workflows do not re-fire on enrichment.

### 2.1 Task interaction - three mechanisms

1. **Agent-driven (the general case).** The triage agent searches, reads, creates and updates Tasks in-session through the `hydra` CLI (`hydra task search | read | create | update`, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md)), deciding its own queries. Semantic grouping across heterogeneous signals cannot be pre-authored; the agent iterates FTS queries over title and description plus structured filters. No vectors.
2. **Built-in actions `task.create` / `task.update`** for agent-less graphs ("every cron tick, file a task").
3. **Built-in action `task.query`** - declarative, exact-identity matching only: provenance external refs (`github:issue:owner/repo#42`, `gmail:thread:<id>`), labels, status, project. Never content matching.

### 2.2 The guard-before-agent pattern

The `task.query` guard runs before the agent step. A duplicate signal (any open task already carrying the event's external ref) routes straight to `task.update` (append provenance, optionally edit description) for pennies; only genuinely new signals reach the agent. This is what makes generous spawn bounds affordable.

```
trigger(github.issue.*)
  └─▶ guard: task.query { refs: [inputs.ref], status: ["open","in-progress"] }
        ├─ edge [size(steps.guard.output.tasks) > 0] ─▶ task.update { taskId: steps.guard.output.tasks[0].id, provenance: +eventId }
        └─ edge [size(steps.guard.output.tasks) == 0] ─▶ agent: triage (output schema = verdict)
              ├─ [verdict == "proposal"] ─▶ task.create {labels: ["proposed", topic], ...} ─▶ notify {decision, actions}
              ├─ [verdict == "attach"]   ─▶ task.update {taskId: relatedTasks[0], provenance: +ref}
              ├─ [verdict == "fyi"]      ─▶ notify {informational}
              ├─ [verdict == "unsure"]   ─▶ notify {decision: "needs a call"}
              └─ [verdict == "ignore"]   ─▶ (end)
```

`task.query` treats "any open task with this ref" as the duplicate signal; there is no uniqueness constraint on refs across tasks ([ADR 0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)). Honest scope note: v1 sources (GitHub and Gmail polling) are modest-volume; the guard earns its keep fully when post-v1 webhook sources land.

**Open:** the exact roster of shipped default workflows (which triage workflows ship per v1 source, and whether the check-in/Intake defaults include a cron-driven brief) is not pinned by any ticket; only "shipped defaults exist and demonstrate the patterns above" is.

## 3. The triage verdict

The agent step declares an output schema; the runner drives the provider to a schema-conforming final result (native structured output on Claude and Codex, `submit_result` tool on pi - mechanics in [./06-providers.md](./06-providers.md)). The verdict is the full contract between agent and graph: prompts persuade, schemas route ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)).

The verdict content is a property of the shipped default triage workflow, not of the core. Ticket 21 (requirement 4) pins the field list the Intake surface consumes: **verdict, priority, confidence, grouping, related tasks, suggested step**. Everything else in the block below - the enum values, the confidence range, the `topic` and `summary` fields, and `relatedTasks` as task ids - is the shipped default's proposal, to be settled when that workflow is written:

```ts
// Shipped-default proposal. Pinned: the six field names. Proposed: enum values, ranges, topic, summary.
interface TriageVerdict {
  verdict: "proposal" | "attach" | "fyi" | "ignore" | "unsure";  // proposed values; "unsure" is the pinned escalation case
  priority?: "urgent" | "high" | "normal" | "low";   // the Task priority enum; written to Task.priority on create
  confidence: number;                                 // proposed 0..1
  grouping?: string;                                  // why these signals belong together
  relatedTasks: string[];                             // proposed: task ids the agent found (the proactive link)
  suggestedStep?: {                                   // becomes the first bound action of the decision Notification
    label: string;                                    // "Start Bugfix", "Merge dev bumps"
    operation: BoundOperation;                        // see Section 7.4
  };
  topic?: string;                                     // proposed: label; defaults to the connection's topic
  summary?: string;                                   // proposed: one-line gist for the condensed row
}
```

Rules:

- **Stored on the run.** The run record already persists every step's output ([./07-workflows.md](./07-workflows.md)); the verdict is the triage agent step's output on that record. No new field. The Task created or updated by the run carries a provenance entry `{runId}` pointing back, so the proposal detail reaches the verdict by task -> provenance -> run -> step output.
- **Surfaced in the proposal detail** as the triage verdict block (the trust surface): verdict, priority, confidence, grouping, related tasks, suggested step.
- **Stamped on every event.** The Intake events view stamps each event on a connection with what triage made of it. The stamp is derived, never stored on the event: no effect row for the event = ignored by filter; effect row `held` = held by a tripped breaker (Section 5); effect row with a run = that run's verdict (or the guard path taken when the run never reached the agent, which reads as attached).
- Output schemas are linted at workflow validation against the common strict subset (Codex's `additionalProperties: false` plus all-properties-required is the binding constraint, ticket 28), regardless of which provider the step runs on ([./07-workflows.md](./07-workflows.md) owns the rule). The shipped triage schema is written to that subset.

**Open:** which step's output on a run *is* the verdict for display purposes. The run record stores outputs per step id; the Intake detail needs a convention (a fixed step id such as `triage`, or a marker on the agent step) to pick the right one. No ticket pins it.

**Conflict:** the events-view stamp vocabulary differs between sources: design-language.md lists "→ proposal, unsure, FYI, ignored, filed, held" while the receipt line in the same section reads "6 proposals · 2 routed · 1 attached · 3 FYI · 198 ignored". Whether "filed" and "routed" are one verdict value or two, and how they map onto the enum above, must be settled when the shipped schema is written.

## 4. Proposal and Topic

Both are vocabulary over existing primitives, not entities ([../../CONTEXT.md](../../CONTEXT.md)).

**Proposal** = a Task labelled `proposed` (plus a topic label) together with its pending go/no-go decision Notification. Enrichment is the task description (markdown). Grouping and "made from" are provenance entries (`{eventId}` per source event, `{ref}` per external ref). The proactive link is a provenance `{ref}` or the verdict's `relatedTasks` pointing at an existing task. The suggested step is the first bound action of the decision Notification (Section 7.4). The user's answers are accept, park, dismiss.

**Open:** the effect of each answer on the Task is not pinned. Accept clearly executes the suggested step's bound operation and resolves the Notification; whether it also removes the `proposed` label, and what park and dismiss do to `labels` and `status` (dismiss = `cancelled` is the obvious reading), is a shipped-workflow convention still to be written.

**Topic** = a label. Each Connection files into one default topic chosen at setup (Connections are labelable - [./08-events-and-connections.md](./08-events-and-connections.md)); triage labels a proposal with the connection's topic unless the content says otherwise (a Tailscale notice on the personal mailbox is `ops`). Topics are user-defined and user-ordered; the ordering is a presentation setting, never domain state. Tabs show every topic in use. Topic is never a status.

**Open:** where the user's topic ordering is stored (a settings record keyed by label name is the minimum) is not pinned.

## 5. Spawn bounds and breaker semantics

The v1 core bound set is spawn bounds only.

- A **Spawn Bound** is a start trigger's limit on how many runs it may spawn per window: `spawnBound: { maxRuns, windowSeconds }` on the trigger ([./07-workflows.md](./07-workflows.md)). Default about 30 runs per hour; configurable per trigger; the default is editable in Settings > Bounds ([./14-web-app.md](./14-web-app.md)). Signal triggers do not spawn runs and carry no bound (07 §2.5).
- **Breaker semantics** on exceeding the bound, in one transaction of the matcher ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)):
  1. The trigger's `state` becomes `paused`. No further runs spawn from it.
  2. Every matched event from then on is recorded as a **held** effect row (trigger id + event id, the same UNIQUE constraint as pending-run rows). Held events are visible: in the trigger's detail, in check-in, and in the Intake events view stamped `held`. Never a silent drop; never blind queueing.
  3. The core produces a **breaker-tripped Notification** (a decision) naming the trigger, the count of held events and the window.
  4. The user resumes with one click, optionally discarding the backlog. Two bound actions: **Resume** and **Resume and discard backlog**. A tripped breaker is itself the review moment: the user sees what almost spawned and fixes the filter. Consolidated mechanics (the tickets pin only the two choices): Resume sets the trigger back to `active` and turns held rows into pending-run rows in arrival order; discard marks the held rows discarded and keeps them in the event log.
- New sources baseline at "now" and never emit history (stampede guard on the ingest side, [./08-events-and-connections.md](./08-events-and-connections.md)); spawn bounds are the dispatch-side guard.

**Verify at build time:** whether spawning the held backlog on Resume counts against the bound again (re-tripping immediately if the backlog exceeds it) or drains unbounded. The tickets say only "resumes with one click".

**Open:** the window shape (fixed window vs sliding window over `windowSeconds`) is not pinned; "~30 runs/hour" is the only figure.

Ruled out as core bounds, on the record:

| Candidate | Why not |
|---|---|
| Global concurrent-run cap | Redundant: per-runner `maxConcurrentSessions` already queues excess at placement ([./03-controller-and-runners.md](./03-controller-and-runners.md)). |
| Spend caps | Unenforceable: subscription-auth providers report no reliable per-run cost. V1 displays cost, never gates on it. |
| Quiet hours | Pausing a workflow covers it. |
| Action allowlists / approval gates | Live with access modes ([./06-providers.md](./06-providers.md)) and permission profiles ([./13-security.md](./13-security.md)), not with triage. |

## 6. Built-in workflow actions

Five built-in actions ship in the core: `workflow.run`, `notify`, `task.create`, `task.update`, `task.query`. Their parameters, outputs and general notes are the catalogue in [./07-workflows.md](./07-workflows.md) §8; each is a thin call into the same service layer the public API exposes ([ADR 0013](../adr/0013-agents-operate-hydra-through-the-public-api.md)). Triage-specific notes only:

- `workflow.run` is fire-and-forget: it starts a run of another workflow and returns `{ runId }` without waiting or routing on the child's output (that is the post-v1 sub-workflow step). It is what a bound action "Start Bugfix" and the scheduled-tasks one-step shortcut both reduce to.
- `notify` produces the Notification record of Section 7.1 with `producer = { type: "run", runId, stepId }`; the step's bound actions are the run's proposal to the user (Section 7.4).
- `task.create` from a triage graph carries `{eventId}` provenance for every source event and `{ref}` for every external ref, so "made from" is complete without a later enrichment pass.
- `task.update` is how the guard path attaches a duplicate signal: append provenance, optionally edit the description. Every call fires one `task.updated` event, provenance-only appends included.
- `task.query` matches by exact identity only (provenance refs, labels, status, project); graphs route on `size(steps.<id>.output.tasks)`. The structured filter shape (single value vs list per field, and-only vs or) is Open in [./09-tasks.md](./09-tasks.md) and must be the same shape `hydra task search` uses.

An action failing fails the run; actions never redirect ([./07-workflows.md](./07-workflows.md)).

**Open:** the actor stamped on mutations performed by built-in actions (a run has no session and no user present; the actor enum is `user | session:<id>`). Owned by the Open in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) §3.1; nothing pins a run-scoped actor.

## 7. Notifications

### 7.1 The record

One persisted, core-owned Notification record. No plugin, channel, or workflow keeps its own notification list. The field set below consolidates what the decisions require; names are provisional until the contract package is written.

```ts
interface Notification {
  id: string;
  kind: string;                 // dotted producer-namespaced kind: "core.breaker-tripped", "core.run-failed",
                                // "core.permission-request", "core.update-available", "workflow.notify",
                                // "plugin.gmail.token-expiring", ...
  title: string;
  body?: string;                // markdown; may link Tasks, Runs, Sessions by id
  producer: { type: "core" } | { type: "run"; runId: string; stepId: string }
          | { type: "plugin"; pluginId: string } | { type: "session"; sessionId: string };
  subject?: EntityRef[];        // what it is about: task / run / session / trigger / connection ids
  eventId?: string;             // the pipeline event this notification derives from, if any
  actions: BoundAction[];       // empty for informational; non-empty makes it a decision (Section 7.4)
  createdAt: string;
  readAt?: string;
  resolvedAt?: string;          // set when a bound action executes
  resolution?: { actionId: string; actor: Actor };   // producer withdrawal is Open below; no expiry concept exists
}
```

- A notification with `actions` is a **decision**; without, it is **informational** (FYI). Needs-you in check-in and "Needs a call" in Intake are the unresolved decisions; the notification center shows everything. Same records, two surfaces; no double bookkeeping.
- Decisions are phrased as questions; the actions are the answers ([../design-language.md](../design-language.md), Monitoring semantics).
- `producer` is what producer-side muting keys on (Section 7.3).

**Open:** the notification's status axis. The record above uses `readAt` / `resolvedAt` timestamps rather than an enum. The glossary rule of one fixed status axis per entity applies; whether that axis is `open -> resolved` with read as a separate flag, or something else, is not pinned.

**Open:** whether a producer can withdraw or update a notification it created (e.g. the breaker resets, the plugin token was refreshed). ADR 0012 pins creation and delivery only.

### 7.2 Producers

| Producer | Path | Examples |
|---|---|---|
| Core internals | direct service call | breaker tripped, run failed, runner unreachable, update available ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)), permission request (Section 7.6) |
| Workflow `notify` step | built-in action (Section 6) | triage decisions, FYI lines, "needs a call" |
| Plugins | requestable `notifications` plugin capability ([./05-plugins.md](./05-plugins.md)) | Gmail OAuth token expiring |
| Sessions | `hydra notify` public-API op under the `notifications` grant | an assistant, or an agent step's session, raising something for the user |

The first three producers are ticket 15's list. The fourth follows from the `notifications` grant in the shipped assistant profile and the `notify` verb in the shipped worker profile ([./13-security.md](./13-security.md)): a session holding that grant produces through the same op as the built-in action. All four land in the same record through the same service-layer operation. Producer-side muting - silencing a chatty plugin or workflow - is distinct from sink-side delivery toggles (ticket 15); the consolidated reading is a filter keyed on `producer`, which is why `producer` is on the record.

**Open:** the muting mechanism: whether muted notifications are still recorded (and merely not delivered) or dropped at the producer. "Silence" in the tickets reads as not-delivered; the record is cheap, so recording-but-not-delivering keeps the audit intact - not pinned.

### 7.3 Router and sinks

Delivery is **core-push, never plugin-claim**.

- The core router runs on notification creation. The in-app notification center always records (it is the web app's live topic over the same table - a dumb sink like any other, [./14-web-app.md](./14-web-app.md)). The router alone decides fan-out to delivery sinks.
- A **sink** is a channel contribution (Discord, Slack - [./12-assistants.md](./12-assistants.md)) that optionally implements notification delivery. It rides the existing channel extension point; the fixed v1 set of four extension points stays intact. Sinks are dumb: they render and send what the router hands them and exercise no judgment about what deserves delivery.
- The user toggles delivery **per channel connection**. V1 routing policy is **deliver-to-all-enabled**; duplicates are the user's explicit configuration, visible and self-fixable. No priority-order first-success routing (a failed first hop would silently swallow the notification).
- Outbound delivery leaves the database through outbox rows with retry, at-least-once ([./04-state-store.md](./04-state-store.md)).
- A second delivery path bypassing the router is forbidden, even where convenient.

The sink contract:

```ts
interface NotificationSink {
  deliver(notification: Notification, connection: ConnectionRef): Promise<void>;  // throws = retry via outbox
  // Additive growth reserved (post-v1): deviceClass, presence(), receipts. A sink reporting nothing
  // is treated as always-available.
}
```

Because routing lives only in the core, presence-aware routing ("desktop idle, send to phone") lands post-v1 as a router upgrade touching no plugin.

**Open:** what a channel sink renders for a decision notification. Bound actions execute in the web app (Section 7.4); whether a Discord/Slack delivery carries a deep link to the in-app notification only, or also native buttons wired back to the same operation, is not pinned. The minimum is the link.

**Open:** whether the assistant's own conversation on a bound channel is a valid sink target (the notification appears as the assistant speaking) or whether channel sinks post as the Hydra bot outside any conversation. Ticket 17's double-fire rule (Section 7.5) suggests the two must stay distinguishable.

### 7.4 Bound actions

A decision Notification's actions carry a **bound operation**: "Start Bugfix" = run workflow X with task Y; "Merge dev bumps" = `github.merge` on PRs 113, 114, 115; "Allow" = answer approval request R in session S; "Resume" = un-pause trigger T. Pinned by ticket 21 (requirement 3): actions bind an operation; the actor is the user clicking; the operation was authored by an agent (or by the core); the spec must say how an action's operation is declared, executed and authorised. Nothing beyond that is pinned. What follows is the spec's consolidated proposal for declaration and execution, built on ADR 0013's one-contract rule; authorisation stays Open.

```ts
// Consolidated proposal (ticket 21 handoff), not pinned by a ticket.
interface BoundAction {
  id: string;
  label: string;                       // the answer text: "Start Bugfix", "Allow", "Resume and discard"
  operation: BoundOperation;
  primary?: boolean;                   // at most one per notification; rendered as the quiet primary answer (design language)
}

interface BoundOperation {
  op: string;                          // a public-API contract operation name: "workflows.run", "tasks.update",
                                       // "sessions.respondToRequest", "triggers.resume", "github.merge" (plugin action)
  input: unknown;                      // validated against the op's Zod input schema at notification creation
}
```

- **Declared** at notification creation as a contract operation plus its input, frozen with the record. The input is validated against the op's input schema when the notification is created, so a malformed action fails the producer, never the user's click. Only operations in the public contract (including plugin-contributed workflow actions invoked through it) can be bound; there is no free-form code.
- **Executed** when the user decides: the web app calls one op, `notifications.act { notificationId, actionId }` (the "decide" op in [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) §2), and the service layer executes the frozen operation. The mutation is stamped `actor: user`; the resulting event log entry carries the notification id and its `producer`, so audit shows both who decided and who authored. Executing an action resolves the notification; a resolved notification's actions are inert (one-shot).
- **Authorised** as the user at execution time: the user has full parity, so no grant check fails at click time. Whether the authoring side is also bounded is the Open below.

**Open:** whether authoring is also bounded - that is, whether the operation must have been within the authoring agent's permission profile at creation time (a session on the worker profile, which lacks `workflows.run`, could otherwise route around its profile by proposing "Start workflow X" for the user to click). The trust model in [./13-security.md](./13-security.md) is written for the agent as actor; the delegated-click case is not settled. The conservative reading is that creation validates the operation against the producer's profile as if the producer were executing it; the permissive reading is that the click is the user's informed decision.

**Open:** how the operation is rendered so the click is informed. The Intake detail shows the suggested step's label and the verdict; whether the web app also shows the concrete op and input ("workflows.run bugfix with task #118") before execution is a [./14-web-app.md](./14-web-app.md) question with a security consequence.

**Open:** whether a bound operation can be executed from a channel sink (Section 7.3), and if so how the click is authenticated as the user (the owner's configured platform identity, as for assistant commands in [./12-assistants.md](./12-assistants.md)).

### 7.5 Assistants and double-firing

Assistants may speak unprompted in the conversation that holds the relevant subscription ([./12-assistants.md](./12-assistants.md)). Rule from ticket 17, keeping ADR 0012's single-path promise: **if an assistant is holding a subscription on the thing, the assistant speaks and no core notification fires; core notifications cover what no assistant is holding.**

That rule is pinned; the mechanism is not. The consolidated proposal is that the core router, before creating a notification that derives from a pipeline event, checks for a live session subscription held by an assistant session whose correlation matches the same event; if one exists, the event reaches that session as queued input and the notification is not delivered. Everything below the rule is provisional.

**Open:** the no-double-fire mechanism: what counts as "holding" (a live assistant-held subscription matching the event; whether a task-level subscription covers run-level events under that task); which producers the rule covers (core internals only, or also a `notify` step inside a run the assistant delegated - ticket 17 says "core notification" without defining it); and whether suppression means no record at all or a record marked read and not delivered. [./12-assistants.md](./12-assistants.md) links here rather than holding its own Open.

### 7.6 Permission requests

The `permissions.request` op (granted to every profile) creates a **Permission Request** notification: a decision whose bound actions are *this session only*, *add to profile*, and deny, each bound to the corresponding grant operation. The agent learns the outcome through its subscription and retries; there is no blocking wait. Session tool-approval requests in `approval-required` access mode (`request.opened` in the normalized event taxonomy) surface the same way: a decision notification whose actions are the four values of `ApprovalDecision` - `allow` (this call only), `allow_always` (for the session), `deny` (refuse with a reason the model sees), `cancel` (refuse and end the turn) - each bound to `sessions.respondToRequest` ([./06-providers.md](./06-providers.md) owns the decision type). Grant semantics, profiles and the audit event kinds are in [./13-security.md](./13-security.md).

**Open:** whether an approval request answered directly in the session view (rather than through the notification) resolves the notification automatically. The notification's operation has already executed by another path; the record must not stay pending.

## 8. Intake and check-in: model-level requirements

The screens, their anatomy and their visual semantics are pinned in [../design-language.md](../design-language.md) (Intake semantics, Monitoring semantics) and specified in [./14-web-app.md](./14-web-app.md). This section lists only what the model must provide. Both views are pure clients of the public API; if either ever forces a new core concept, that is a design smell to escalate.

Intake (forward-looking: prepared work, go/no-go):

- **Proposals** are queryable: Tasks with label `proposed`, joined to their pending decision Notification (by `subject` task id), with `priority` for the Now / Today / When you can tiers. "Needs a call" = unresolved decision Notifications of the unsure and breaker-tripped kinds; it is verdict-based, never priority-based.
- **Made from**: every proposal's provenance entries resolve to their source events; every event carries a `system` (Sentry arrives through Gmail; the mark shows the system, the connection is the suffix) and a `url` ("Open in Gmail / GitHub / Sentry"). `system` is writable after ingest because recognising the system inside an email is enrichment ([./08-events-and-connections.md](./08-events-and-connections.md)).
- **Topic tabs**: Connection default topic label + Task topic label (Section 4).
- **Verdict block**: the stored step output reached through provenance (Section 3).
- **Events view per connection**: the event log filtered by connection since a point in time, joined to the effect rows and their runs to derive the per-event stamp (Section 3), filterable by stamp; held events listed (Section 5).
- **Headline and receipt counts** ("212 events → 6 proposals · 2 routed · 1 attached · 3 FYI · 198 ignored") are aggregates over the same join.
- **History** on the proposal detail = the actor-stamped event log entries for the task.

**Open:** "since you last checked" needs a per-user last-checked marker for Intake (and the check-in equivalent). No ticket pins where it lives or what advances it (opening the view, or an explicit "caught up" action).

Check-in (backward-looking: delegated work):

- **Needs-you** = unresolved decision Notifications (Section 7.1). Decision cards need FROM (the strand: task / run / session with its domain noun, priority, provenance), WHY (body) and AGENT (session id) - all present on the record via `subject`, `body` and `producer`.
- **Provenance-first attention** (started-by-you > standing workflow > routine schedule, task priority breaks ties) is derivable from the run record's trigger (ticket 20); the spec's derivation is: manual run = started by you; event start trigger = standing; cron start trigger = routine. No new fields.
- **Strands** are Tasks, standing Workflows and one-off Runs; runs, sessions and steps hang off them by the existing links. Routine workflows aggregate to one row from `run.completed` / `run.failed` per workflow.
- **Pulse rail** lines (fleet / assistants / intake) are counts from runners, assistant sessions and the Intake aggregates above.
- Assistants are ambient presence, never work strands: assistant sessions are excluded from strand queries.

## Post-v1

- Human-gate step (waiting-for-human inside a run); v1 keeps the unsure verdict -> `notify` -> run ends pattern as the evidence for whether it returns.
- Feedback-driven triage learning (verdict thumbs up/down feeding assistant memory); v1 keeps every verdict on the run record so the feedback has something to attach to.
- Presence-aware notification routing (device class, presence, receipts); v1 keeps all routing in the core router and the sink contract additive.
- Webhook event sources; v1 keeps the guard-before-agent pattern and spawn bounds, which are what make high-volume sources safe.
- Sub-workflow steps that wait and route on the child's output; v1 ships fire-and-forget `workflow.run` only.
- Merging Intake and check-in into one spine; a post-dogfooding question, both views stay separate in v1.
- Producer-side muting UI beyond a per-producer toggle; v1 keeps `producer` on the record so finer muting is a filter change.

## Sources

Tickets:

- Triage engine & user-set bounds - https://github.com/rogierpennink/hydra/issues/15
- Prototype: the check-in view - https://github.com/rogierpennink/hydra/issues/20
- Assemble the v1 spec (comments: Intake handoffs) - https://github.com/rogierpennink/hydra/issues/21
- Assistant design: memory, identity, channel binding - https://github.com/rogierpennink/hydra/issues/17
- Task model: shape, status axis, lifecycle, provenance - https://github.com/rogierpennink/hydra/issues/29
- Prototype: the Intake view - https://github.com/rogierpennink/hydra/issues/30
- Workflow model: recipes, triggers, human gates - https://github.com/rogierpennink/hydra/issues/13
- Event & trigger ingress design - https://github.com/rogierpennink/hydra/issues/14
- Agent-operates-system surface - https://github.com/rogierpennink/hydra/issues/16
- Security & secrets model - https://github.com/rogierpennink/hydra/issues/18
- Research: structured output across provider harnesses - https://github.com/rogierpennink/hydra/issues/28

ADRs:

- [ADR 0008 - Workflow graphs route on declared outputs](../adr/0008-workflow-graphs-route-on-declared-outputs.md)
- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0011 - Triage is a workflow pattern inside core-enforced bounds](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)
- [ADR 0012 - Notifications are core-routed; sinks are dumb](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)
- [ADR 0013 - Agents operate Hydra through the public API](../adr/0013-agents-operate-hydra-through-the-public-api.md)
- [ADR 0019 - The task model is thin; workflows own task semantics](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)

Design language: [../design-language.md](../design-language.md) (Intake semantics, Monitoring semantics). Glossary: [../../CONTEXT.md](../../CONTEXT.md) (Intake, Proposal, Topic, Spawn Bound, Notification, Provenance, External Ref).
