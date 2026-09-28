# Triage, Intake and Notifications

Hercule has no triage engine. Deciding what matters is an ordinary workflow ([ADR 0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)): the shipped default is one scheduled **Triage** run a few times a day whose agent reads everything that arrived since the last run, groups it across sources, checks it against existing work, and acts through the public API - creating proposals, attaching signals to tasks, offering quick actions, and saying nothing about the rest. The core contributes only mechanics: per-trigger spawn bounds with breaker semantics, five built-in workflow actions, and one persisted Notification record that the core alone routes to dumb delivery sinks ([ADR 0012](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)). Intake - the formation boundary where external signals become prepared work - and check-in - monitoring delegated work - are both built entirely on these primitives (Tasks, Notifications, Events, Runs, the public API). This document pins the pattern, the shipped Triage workflow and its contract, the bounds, the built-in actions, the Notification record with its lifecycle, router, sinks and bound actions, and the model-level requirements the Intake and check-in views impose. The views themselves belong to [./14-web-app.md](./14-web-app.md).

## 1. Triage is a workflow pattern

A triage workflow is built from the same blocks as every other workflow ([./07-workflows.md](./07-workflows.md)). Two shapes exist; both are ordinary workflows and the core cannot tell either from any other workflow.

| Shape | Trigger | What the agent sees | Where the result lives |
|---|---|---|---|
| **Batch** (shipped default, [Section 2](#2-the-shipped-triage-workflow)) | cron, a few times a day | every event since the last run, across all sources | in what the run *did*: Tasks, Notifications, enrichments |
| **Per-event** (available, not shipped) | an event trigger with a CEL filter | one event | the same: the run acts through the API; optionally a structured output routed by edges |

Consequences the implementer relies on:

- There is no core triage component, no triage workflow type, and no triage configuration. "What matters" lives in an editable prompt (and, for the per-event shape, an editable filter), never in engine settings.
- **Triage acts; it does not report a verdict.** The unit of triage output is a domain entity - a Task, a Notification, an enrichment - written through the same operations any agent uses. Nothing downstream reads a run's step output to learn what triage decided ([Section 8](#8-intake-and-check-in-model-level-requirements)). A per-event workflow *may* still declare an output schema and route on it, as any workflow may ([ADR 0008](../adr/0008-workflow-graphs-route-on-declared-outputs.md)); that is graph plumbing, not the triage record.
- Review and correction in v1 is reading the run record (its summary, its API calls in the event log) and editing the prompt. Every triage decision is an ordinary Run.
- Escalation when the agent is unsure is a decision Notification (`triage.unsure`, Section 2.3) that says what it could not decide. The human acts out-of-band; there is no waiting-for-human machinery in v1.

Why batch is the shipped default (decided by [Notification lifecycle and shipped triage conventions](https://github.com/theagenticage/hercule/issues/42), amending the per-event shape the earlier tickets proposed): a run that sees one event cannot group three Dependabot PRs into "Merge dev bumps", and cannot notice that a Sentry mail is about the PR a run is already working on - and making connections the user would not make is Intake's value center ([./01-overview-and-scope.md](./01-overview-and-scope.md)). Accepted cost: latency up to the cadence (an urgent mail at 09:05 is seen at the 11:00 run). A user who wants a fast lane adds an event trigger on the same workflow (for example `github.notification` with `reason == "mention"`); v1 ships none.

## 2. The shipped Triage workflow

One workflow, **Triage**, created on first run as an ordinary editable workflow, `enabled`, over all event sources. Its prompt has one section per v1 source (GitHub, Gmail) and is user-editable like any prompt; this section is the contract the shipped prompt implements and that a custom triage prompt is expected to honour so Intake keeps working.

### 2.1 Definition

- **Trigger:** one cron start trigger, default `0 7-23/2 * * *` in the user's timezone (every two hours during waking hours), editable like any trigger. The tick carries `previousFiredAt` - when this trigger last actually fired, `null` on the first tick ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.3) - mapped into the workflow's `since` input; `scheduledFor` maps into `until`. Both are frozen on the run, so a re-run replays the exact window.
- **Inputs:** `since?: timestamp`, `until: timestamp`.
- **Workspace:** `none`. Triage never touches a checkout.
- **Steps:** one agent step, `triage`, on the shipped triage agent (a cheap model; `worker` profile, [./13-security.md](./13-security.md)), no output schema. Its final message is the run's output (`{ text, exitStatus }`, [./07-workflows.md](./07-workflows.md) section 6) and is shown on the Intake page as "last triage".
- **Graph:** trigger → `triage` → end. No edges to route: the agent acts.

### 2.2 The contract

**Goal.** Triage exists to take cognitive load off the user. Its baseline is the user reading the raw events themselves; **the user must never be burdened more than that baseline**: every proposal, offer, FYI or question must cost less attention than the events it stands in for, otherwise the right output is nothing. Above the baseline, the more triage connects, groups, enriches and pre-decides, the better.

**Inputs the agent has.** The window (`inputs.since`, `inputs.until`); the events in it (`hercule event query --since --until`, [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2, joined to their effect rows and to the tasks whose provenance already carries their refs); full read access to the system (tasks via `hercule task search`, runs and their live subscriptions, connections and their default topics); and source polling through plugin actions (`github/*`, `gmail/*` under the `connection.use` grant) when an event is not enough - fetch the mail body, read the PR diff. Triage may poll; it is not limited to what the pipeline carried.

**Duties, in order.**

1. **Set aside what is known.** An event whose refs an open Task already carries, or that a live Subscription consumed, belongs to work in flight. Nothing to do unless it changes the picture (a failing check on a PR a run is waiting on is the run's business; a second reviewer asking for changes on a task the user accepted is news).
2. **Enrich** what needs it: `hercule event enrich` sets `system` and `url` for systems that arrive inside another (Sentry, Dependabot, Tailscale inside Gmail) and appends refs the agent extracts ([ADR 0025](../adr/0025-enrichment-re-matches-one-event-idempotently.md)).
3. **Group** the rest into units of work, across sources: three dependency PRs are one unit; a Sentry mail and the GitHub issue it caused are one unit.
4. **Act** on each unit, choosing exactly one of:
   - **Proposal**: a new Task (`hercule task create`) with labels `proposed` and one topic, `priority`, a description holding the why, the grouping and the links, provenance `{eventId}` for every source event and `{ref}` for every external ref - *and* its decision Notification (`triage.proposal`, subject the task, the events in `subject` too) with the answers of Section 2.4.
   - **Attachment**: a provenance append on an existing Task (`hercule task update`), optionally editing its description. The Task's `task.updated` event fires as usual.
   - **Offer**: a decision Notification (`triage.offer`) proposing an immediate action with no Task - "Merge dev bumps" binding `github/pr.merge` over three PRs, "Reply 'approved'" binding `gmail/message.reply` - plus a Dismiss answer.
   - **FYI**: an informational Notification (`triage.fyi`) for what the user should know and need not act on.
   - **Unsure**: a decision Notification (`triage.unsure`) saying what triage could not decide and why, with the answers it can offer.
   - **Nothing.** The default; most events end here.
5. **Summarise**: end with one paragraph - counts, what was grouped, what was left alone and why - as the final message.

**Non-goals.** Triage never starts work, never merges, replies, closes or deletes anything itself, never edits memory. It proposes; the user's click does ([ADR 0022](../adr/0022-proposing-is-not-doing.md)).

### 2.3 Notification kinds triage produces

| Kind | Decision? | Meaning |
|---|---|---|
| `triage.proposal` | yes | go/no-go on a new Task; the Task and this record together are a Proposal (Section 4) |
| `triage.offer` | yes | an immediate action, no Task; answers bind the operation and Dismiss |
| `triage.unsure` | yes | triage could not decide; "Needs a call" in Intake |
| `triage.fyi` | no | worth knowing, nothing to do |

"Needs a call" = open `triage.unsure` plus open `core.breaker-tripped` (Section 5). It is verdict-based, never priority-based.

### 2.4 The answers on a proposal

Bound actions ([Section 7.4](#74-bound-actions)) the triage agent authors, one operation each:

| Answer | Operation | Effect |
|---|---|---|
| **Accept** (primary) | `task.update { labels: -proposed }` | "This is work." The Task becomes an ordinary open task in the backlog and leaves Intake. |
| **Start *X*** | ~~~~`workflow.run`~~ `run.start`~~ `run.start { workflowId, inputs: { taskId, ... } }` | Present only when triage found a fitting workflow. |
| **Dismiss** | `task.update { status: "cancelled" }` | The Task stays, cancelled: the next triage run finds it by ref and does not re-propose it. Never a delete. |

*(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* The table writes the inputs short. As bound, an answer's input is the operation's whole input as one object, with the task's id in it (Section 7.4): Accept is `task.update { taskId, removeLabels: ["proposed"] }`, Start *X* is `run.start { workflowId, inputs: { taskId, ... } }`, and Dismiss is `task.update { taskId, status: "cancelled" }`.

Conventions the answers rely on:

- **Accepting is not starting.** Accept persists the work; starting it is a separate act (a Start answer, a manual run, a session opened on the task). V1 ships no work workflow on purpose - the no-workflow situation is what dogfooding tests first - so a fresh install offers Accept and Dismiss only.
- **A fitting workflow** is one that declares a required `taskId` input (`hercule workflow query`); the agent picks among those by name and description and names it in the answer label.
- **Whoever starts work owns the transition.** A work workflow's first step sets `status: in-progress` and removes `proposed`; work workflows trigger on status changes (`event.changes.status.new == "in-progress"`), never on `task.created`, so a `proposed` task cannot be picked up by accident ([./09-tasks.md](./09-tasks.md)).
- There is no park. "Not now" is Accept: the task waits in the backlog at the priority triage gave it.

### 2.5 Recommended topology

Convention plus the shipped default, never enforced. Nothing stops a user wiring expensive work directly to raw events; the protection is the convention, the default and the spawn bounds.

```
external events ──▶ Triage (cron batch) ──▶ Tasks ──▶ work workflow(s)
(GitHub, Gmail,     read the window        buffer    trigger on task.updated
 cron, manual)      group, enrich, act               status became in-progress
```

- Triage is the only doorway between raw external events and expensive work.
- Tasks are the buffer. Triage never starts a work run; it leaves a Task, and the user's Accept or Start does the rest. This is what lets the user see, edit and cancel prepared work before money is spent.
- Provenance-only appends also fire `task.updated`, so any work workflow MUST filter on the fields it cares about (`has(event.changes.status)`).

### 2.6 Task interaction from a per-event workflow

The batch agent uses the `hercule` CLI for everything. A per-event or agent-less graph has the built-ins instead: `task.create` / `task.update` ("every cron tick, file a task") and `task.query` - declarative, exact-identity matching only (provenance refs, labels, status, project; never content), which enables the **guard-before-agent** pattern: `task.query` on the event's refs, an edge on `size(steps.guard.output.items) > 0` to `task.update`, otherwise the agent step. Duplicate signals attach for pennies; only new ones reach a model. `task.query` treats "any open task with this ref" as the duplicate signal; there is no uniqueness constraint on refs across tasks ([ADR 0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)).

## 3. Events, stamps and the window

Triage leaves no verdict field; what it made of each event is **derived** from the entities it wrote. The Intake events view ([Section 8](#8-intake-and-check-in-model-level-requirements), [./08-events-and-connections.md](./08-events-and-connections.md) section 10) stamps each event by this table, first match wins:

| Stamp | Derived from |
|---|---|
| **→ *task title*** | a Task's provenance carries `{eventId}`; "→ proposal" when that Task was created in the same run and still carries `proposed`, "attached" when the Task existed before |
| **offer** / **FYI** / **unsure** | a Notification of that `triage.*` kind lists the event in `subject` |
| **known · *task or run*** | before the window, the event's refs were already on an open Task's provenance, or a live Subscription consumed it (signal delivery or queued-input effect row) |
| **held** | a held effect row (Section 5) |
| **pending triage** | newer than `until` of the last completed Triage run |
| **no action** | none of the above: a run covered it and left it; the run summary says why |

Headline and receipt counts are aggregates over the same join ("212 events → 6 proposals · 1 attached · 2 offers · 3 FYI · 2 unsure · 198 no action"; the headline may sum the quiet ones as "handled quietly"). This vocabulary replaces the prototypes' "filed" / "routed" / "ignored" / "filtered" ([../design-language.md](../design-language.md), dated note) and is expected to be adjusted by dogfooding; nothing is stored on the event, so renaming a stamp is a view change.

The **window** is the run's frozen `since` / `until`. Events that arrive during a run with a timestamp before `until` are in the *next* window if the run's query did not see them - `previousFiredAt` moves to the tick time, not to the query time, so nothing falls between windows; the same event may then be seen twice, which is harmless because the first run's entities make it "known".

## 4. Proposal and Topic

Both are vocabulary over existing primitives, not entities ([../../CONTEXT.md](../../CONTEXT.md)).

**Proposal** = a Task labelled `proposed` (plus a topic label) together with its open `triage.proposal` Notification, joined by the notification's `subject`. Enrichment is the task description (markdown): the why, the grouping, the links, in prose. "Made from" is the provenance (`{eventId}` per source event, `{ref}` per external ref). The proactive link is a provenance `{ref}` or a link in the description to an existing task. The user's answers are Accept, Start *X* and Dismiss (Section 2.4). A Task still labelled `proposed` whose notification is resolved is not a Proposal and is not shown in Intake - it can only arise when a custom producer resolves the notification without touching the task, and the Tasks screen shows it like any open task.

**Offer** = a `triage.offer` Notification: an action proposed with no Task behind it, decided by its answers alone. An offer the user dismisses leaves no task; triage sees the resolved notification (its events in `subject`) and does not re-offer.

**Topic** = a label. Each Connection files into one default topic chosen at setup (Connections are labelable - [./08-events-and-connections.md](./08-events-and-connections.md)); triage labels a proposal with the connection's topic unless the content says otherwise (a Tailscale notice on the personal mailbox is `ops`). Topics are user-defined and user-ordered; the ordering is a presentation setting, never domain state: it lives in the user settings store as `topics.order: string[]` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2, `settings`). Tabs show every topic in use. Topic is never a status.

## 5. Spawn bounds and breaker semantics

The v1 core bound set is spawn bounds only. A spawn bound is a **rate** (runs per window), not a concurrency cap; concurrency is the per-runner session cap ([./03-controller-and-runners.md](./03-controller-and-runners.md)).

- A **Spawn Bound** is a start trigger's limit on how many runs it may spawn per window: `spawnBound: { maxRuns, windowSeconds }` on the trigger ([./07-workflows.md](./07-workflows.md)). Default 30 runs per 3600 seconds; configurable per trigger; the default is editable in Settings > Bounds ([./14-web-app.md](./14-web-app.md)). Signal triggers do not spawn runs and carry no bound (07 §2.5). The shipped Triage trigger is cron and never approaches its bound; bounds matter for event triggers (work workflows on task events, user-authored fast lanes).
- **Sliding window.** The bound is checked inside the matcher transaction by counting the trigger's `spawned` effect rows with `at > now - windowSeconds`. No counter state, no reset boundary: a fixed window would allow `2 × maxRuns` in two minutes across the boundary.
- **One trigger-effects table.** Every match of a start trigger is one row ~~`(triggerId, eventId, state, runId?, at)`, `UNIQUE(triggerId, eventId)`~~ `(workflowId, triggerId, eventId, state, runId?, at)`, `UNIQUE(workflowId, triggerId, eventId)` (*amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78)*: a trigger id is unique only inside its workflow), with `state: pending | spawned | held | discarded`. The pending-run row and the held row are the same row in different states; the spawner consumes `pending` rows in arrival order and marks them `spawned` with the run id.
- **Breaker semantics** on exceeding the bound, in one transaction of the matcher ([ADR 0009](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)):
  1. The trigger's `status` becomes `paused`. No further runs spawn from it.
  2. Every matched event from then on is recorded `held`. Held events are visible: in the trigger's detail (~~`trigger.read` carries the count, `event.query { triggerId }` lists them~~ *amended 2026-09-23, [#78](https://github.com/theagenticage/hercule/issues/78)*: `trigger.read` is retired, so the count lands with held events ([#87](https://github.com/theagenticage/hercule/issues/87)), and `event.query` lists them by `workflowId` and `triggerId` together; [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2), in check-in, and in the Intake events view stamped `held`. Never a silent drop; never blind queueing.
  3. The core produces a **breaker-tripped Notification** (`core.breaker-tripped`, a decision) naming the trigger, the count of held events and the window.
  4. The user resumes with one click. Two bound actions: **Resume** (`trigger.resume`) and **Resume and discard backlog** (`trigger.resume { discardHeld: true }`). A tripped breaker is itself the review moment: the user sees what almost spawned and fixes the filter. Resuming from the Workflows screen resolves the notification the same way (Section 7.7). *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): `trigger.resume` is not built yet, so it is not yet on the list of operations an answer may run (Section 7.4). [#87](https://github.com/theagenticage/hercule/issues/87), which builds the breaker and `trigger.resume`, adds it to the list, with its describe line.)*
- **Resume mechanics.** Resume sets the trigger `active`; discard first marks its held rows `discarded` (kept in the log). Held rows are **not** exempt from the bound and do **not** re-trip it: they stay `held` with the trigger active, and the spawner promotes them to `pending` in arrival order whenever the sliding window has room, live matches queuing behind them in the same order. The Resume describe line says so ("Resume *GitHub work* - 45 held, 30 per hour, the rest follows as the window frees up"). Draining unbounded would defeat the bound; re-tripping would make the user click 30 at a time for a decision they just took.
- New sources baseline at "now" and never emit history (stampede guard on the ingest side, [./08-events-and-connections.md](./08-events-and-connections.md)); spawn bounds are the dispatch-side guard.

Ruled out as core bounds, on the record:

| Candidate | Why not |
|---|---|
| Global concurrent-run cap | Redundant: per-runner `maxConcurrentSessions` already queues excess at placement ([./03-controller-and-runners.md](./03-controller-and-runners.md)). |
| Spend caps | Unenforceable: subscription-auth providers report no reliable per-run cost. V1 displays cost, never gates on it. |
| Quiet hours | Pausing a workflow covers it. |
| Action allowlists / approval gates | Live with access modes ([./06-providers.md](./06-providers.md)) and permission profiles ([./13-security.md](./13-security.md)), not with triage. |

A trigger whose filter fails raises one `core.trigger-filter-error` Notification per failure streak, on the health flip; mechanism in [./08-events-and-connections.md](./08-events-and-connections.md) section 4. *(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84): `core.trigger-filter-error` arrives with the trigger routing table in [#82](https://github.com/theagenticage/hercule/issues/82). A subscription whose condition fails raises `core.subscription-condition-error` by the same rule.)*

## 6. Built-in workflow actions

Five built-in actions ship in the core: ~~`workflow.run`~~ `run.start`, `notification.create` (the tickets' `notify`), `task.create`, `task.update`, `task.query`. Their parameters, outputs and general notes are the catalogue in [./07-workflows.md](./07-workflows.md) §8; each is a thin call into the same service layer the public API exposes ([ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md)). Triage-specific notes only:

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* `workflow.run` and `workflow.submit` became one operation and one action, `run.start`, with one grant of the same name. Each `workflow.run` in this document is struck and replaced with `run.start`. A sixth built-in action, `wait`, pauses a run and calls no operation ([./07-workflows.md](./07-workflows.md) section 8).

- ~~`workflow.run`~~ `run.start` is fire-and-forget: it starts a run of another workflow and returns `{ runId }` without waiting or routing on the child's output (that is the post-v1 sub-workflow step). It is what a bound action "Start *X*" and the scheduled-tasks one-step shortcut both reduce to.
- `notification.create` produces the Notification record of Section 7.1 with `producer = { type: "run", runId, stepId }`; the step's bound actions are the run's proposal to the user (Section 7.4).
- `task.create` from a triage graph carries `{eventId}` provenance for every source event and `{ref}` for every external ref, so "made from" is complete without a later enrichment pass.
- `task.update` is how the guard path attaches a duplicate signal: append provenance, optionally edit the description. Every call fires one `task.updated` event, provenance-only appends included.
- `task.query` matches by exact identity only (provenance refs, labels, status, project); graphs route on `size(steps.<id>.output.items)`. The same `TaskFilter` shape `hercule task search` uses ([./09-tasks.md](./09-tasks.md)).

An action failing fails the run; actions never redirect ([./07-workflows.md](./07-workflows.md)).

Mutations performed by built-in actions are stamped `run:<runId>` and are ungated ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) §3.1).

## 7. Notifications

### 7.1 The record

One persisted, core-owned Notification record. No plugin, channel, or workflow keeps its own notification list. Names are provisional until the contract package is written.

```ts
interface Notification {
  id: string;
  kind: string;                 // dotted producer-namespaced kind: "core.breaker-tripped", "core.run-failed",
                                // "core.permission-request", "core.update-available", "core.plugin-error",
                                // "core.trigger-filter-error", "triage.proposal", "triage.offer", "triage.fyi",
                                // "triage.unsure", "plugin.gmail.token-expiring", ...
  title: string;
  body?: string;                // markdown; may link Tasks, Runs, Sessions by id; frames the question on a decision
  producer: { type: "core" } | { type: "run"; runId: string; stepId: string }
          | { type: "plugin"; pluginId: string } | { type: "session"; sessionId: string };
  subject?: EntityRef[];        // what it is about: task / run / session / trigger / connection / event ids
  eventId?: string;             // for core notifications derived from exactly one pipeline event (run.failed)
  actions: BoundAction[];       // empty for informational; non-empty makes it a decision (Section 7.4)
  status: "open" | "resolved";  // the one fixed status axis (ADR 0027)
  resolution?: Resolution;      // present iff a decision has been resolved
  createdAt: string;
}

interface Resolution {
  kind: "decided" | "handled" | "withdrawn";
  actionId?: string;            // decided: the answer taken (also when taken outside the notification, Section 7.7)
  actor: Actor;                 // who resolved it: user | core | session:<id> | plugin:<id>
  origin: string;               // where: "web" | "connection:<id>" (a channel click) | "core" | "session:<id>" | "plugin:<id>"
                                // (a different field from a conversation message's origin, which names the message's source)
  conversationId?: string;      // handled: the conversation whose assistant covered it
  reason?: string;              // withdrawn: one line, shown in the center and the sink's edited message
  at: string;
}
```

- A notification with `actions` is a **decision**; without, it is **informational** (FYI). Needs-you in check-in and "Needs a call" in Intake are the `open` decisions; the notification center shows everything. Same records, two surfaces; no double bookkeeping.
- **Status axis** ([ADR 0027](../adr/0027-a-decision-resolves-when-its-question-is-answered-wherever.md)): `open` means "still wants an answer from you". A decision is born `open`; an informational notification is born `resolved` with no `resolution` (there is nothing to answer) and never changes. A decision resolves in exactly one of three ways: **decided** (an answer was taken, here or elsewhere - Section 7.7), **handled** (an assistant covered it - Section 7.5), **withdrawn** (its question stopped existing - Section 7.7). Resolved is terminal; a resolved notification's actions are inert.
- **No read state.** There is no per-record `readAt`: no platform gives the controller a read receipt, so it would only ever record "opened in the web app". Surfaces mark what is new with the per-view "since you last checked" marker (Section 8), the notification center included.
- **Immutable apart from resolution.** Title, body, subject and actions never change after creation; new facts are a new notification. A producer may only *withdraw* (Section 7.7).
- Decisions are phrased as questions; the actions are the answers ([../design-language.md](../design-language.md), Monitoring semantics).
- `producer` is what producer-side muting keys on (Section 7.2).

*(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84).)* The record as built in `@hercule/contract` differs from the sketch above in four places:

- `subject` is always present, possibly empty, and each entry is a typed subject: `{ kind, id }` for a task, run, session, workflow, connection, runner, subscription, plugin or event, and `{ kind: "trigger", workflowId, triggerId }` for a trigger, because a trigger id is unique only inside its workflow ([./08-events-and-connections.md](./08-events-and-connections.md) section 4).
- `eventId` is the event log's integer id.
- `muteKey?: string` holds the mute key the producer resolved to when the notification was created (Section 7.2). It is absent for the core, and for a producer with nothing to mute it by: a run of a sent workflow, or a session that speaks for no assistant.
- `kind` is producer-namespaced as above, and only the core may use `core.*`: `notification.create` refuses such a kind. The core kinds built so far are `core.run-failed`, `core.plugin-error`, `core.runner-unreachable` and `core.subscription-condition-error`. *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): and `core.approval`, the one core decision so far (Section 7.6).)*

~~Bound actions are stored and checked for shape (unique ids, at most one primary). Rendering them and executing them through `notification.act` are [#85](https://github.com/theagenticage/hercule/issues/85).~~ *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* Bound actions are built: checked, rendered and executed as Section 7.4 says. Three more facts about the record:

- A subject may also be a request: `{ kind: "request", sessionId, requestId }`, the approval request a session is parked on (Section 7.6). It names one request, so the core can resolve the decision about that request and leave other decisions about the same session alone.
- When `notification.query` or `notification.read` returns an open decision, each answer carries a `describeLine`, which the core writes when it returns the record (Section 7.4). The answers of a resolved decision carry none, because they can no longer be taken.
- `origin` has one more value, `api`: an answer taken with an API key, such as from the `hercule` CLI. `web` is an answer taken with the web app's login token.

An informational notification may also be born resolved with a `handled` resolution, when an assistant covers what it reports (Section 7.5). The table allows that one resolution on an informational row and refuses every other.

### 7.2 Producers and muting

| Producer | Path | Examples |
|---|---|---|
| Core internals | direct service call | breaker tripped, run failed, runner unreachable, update available ([./15-packaging-and-operations.md](./15-packaging-and-operations.md)), plugin error, trigger filter error, permission request (Section 7.6) |
| Workflow `notification.create` step | built-in action (Section 6) | per-event triage graphs, "PR ready, click to merge" |
| Plugins | requestable `notifications` plugin capability ([./05-plugins.md](./05-plugins.md)) | Gmail OAuth token expiring |
| Sessions | `notification.create` (`hercule notification create`) under the `notification` grant | the shipped Triage agent's proposals, offers, FYIs and questions; an assistant raising something for the user |

All four land in the same record through the same service-layer operation.

**Muting** is a delivery fact, never a record state. The user mutes a producer in the notification center; the mute list lives in the user settings store as `notifications.muted: string[]` with keys `workflow:<id>`, `plugin:<id>`, `assistant:<id>` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2, `settings`). The router resolves each new record's `producer` to one of those keys (a run to its workflow, a session to its assistant when it has one; core is not mutable) and, on a match, **records the notification, lists it in the center, and pushes it to no sink** - the same path as `handled` (Section 7.5). The record's `status` is unaffected: a muted decision is still `open` and still needs-you. Sink-side toggles (delivery per channel Connection, Section 7.3) are a separate control.

*(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84).)* The mute key is resolved once, when the notification is created, and stored on the record as `muteKey` (Section 7.1), so the router and the notification center read it without resolving it again. The router's fan-out to sinks, and so the only place a mute takes effect, is [#99](https://github.com/theagenticage/hercule/issues/99).

*(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84).)* The core producers built so far~~, all informational~~ *(amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): the first four are informational; tool approval, the last, is a decision)*:

- **Run failed** (`core.run-failed`): raised in the transaction that ends a run as `failed`, with the run and its workflow as subjects and the `run.failed` event as `eventId`. The body says which step or edge failed and why.
- **Plugin error** (`core.plugin-error`): raised when a plugin's activation or deactivation fails and the host marks it `errored`. A plugin refused at registration raises none: it never became a plugin the user enabled.
- **Runner unreachable** (`core.runner-unreachable`): raised once per outage, when a runner has stayed `unreachable` for two minutes. A controller sweep checks every 30 seconds and asks the database whether a notification about the runner was created since it was last seen, so it survives a controller restart and needs no timers. It is informational and never withdrawn: a reconnect makes it history, not a wrong question.
- **Subscription condition error** (`core.subscription-condition-error`): see [./08-events-and-connections.md](./08-events-and-connections.md) section 4.
- **Tool approval** (`core.approval`): a decision, raised when a session parks on an approval request and resolved or withdrawn when the request stops waiting (Section 7.6). *(Added 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)*

### 7.3 Router and sinks

Delivery is **core-push, never plugin-claim**.

- The core router runs on notification creation. The in-app notification center always records (it is the web app's live topic over the same table - a dumb sink like any other, [./14-web-app.md](./14-web-app.md)). The router alone decides fan-out to delivery sinks; muted and handled records get no fan-out.
- A **sink** is a channel contribution (Discord, Slack - [./12-assistants.md](./12-assistants.md)) that optionally implements notification delivery. It rides the existing channel extension point; the fixed v1 set of four extension points stays intact. Sinks are dumb: they render and send what the router hands them and exercise no judgment about what deserves delivery.
- The user toggles delivery **per channel connection**. V1 routing policy is **deliver-to-all-enabled**; duplicates are the user's explicit configuration, visible and self-fixable. No priority-order first-success routing (a failed first hop would silently swallow the notification).
- Outbound delivery leaves the database through outbox rows with retry, at-least-once ([./04-state-store.md](./04-state-store.md)).
- A second delivery path bypassing the router is forbidden, even where convenient.

The sink contract:

```ts
interface NotificationSink {
  interactive: boolean;   // true = renders bound actions as native buttons and reports clicks to the core
  deliver(notification: Notification, target: ContainerRef): Promise<DeliveryRef>;   // throws = retry via outbox
  resolved(notification: Notification, target: ContainerRef, ref: DeliveryRef): Promise<void>;  // resolved anywhere: edit in place
  // Additive growth reserved (post-v1): deviceClass, presence(), receipts. A sink reporting nothing
  // is treated as always-available.
}
```

Because routing lives only in the core, presence-aware routing ("desktop idle, send to phone") lands post-v1 as a router upgrade touching no plugin.

**Decision delivery is a sink capability** (pinned by ticket 37). A sink declares `interactive`. A non-interactive sink delivers title, body and a deep link to the in-app record; the decision is taken in the web app. An interactive sink also renders every bound action as a native button - its label plus the core-rendered describe line of Section 7.4 - and reports a click to the core as `{ notificationId, actionId, connection, senderIdentity }`; the core, never the plugin, authenticates and executes it (Section 7.4). Discord (gateway interactions) and Slack (Socket Mode) both deliver clicks outbound-only, so the no-public-endpoint stance of [./08-events-and-connections.md](./08-events-and-connections.md) holds. Payload shapes, click acknowledgement and the message edit on resolution are pinned in [./12-assistants.md](./12-assistants.md) section 11.6; both v1 sinks are interactive.

**Target and resolution** (pinned by [Channel contribution interface](https://github.com/theagenticage/hercule/issues/39)): each channel Connection with delivery enabled names one **notification container** (a channel or the owner's DM; default the owner's DM). That container may coincide with a bound conversation's, but the post is the sink's, never the assistant speaking: it is stored as a conversation message with `origin: notification`, delivered to the assistant as a data line at its next wake, and never wakes anything - so the double-fire rule (Section 7.5) can always tell the two apart. The core stores every sink's `DeliveryRef` and, whenever a decision resolves for any reason (Section 7.1), calls `resolved()` on each sink that delivered so stale buttons are removed and the outcome shown. The edited line is rendered from the `Resolution`: "✓ *Start Bugfix* - decided in the web app" (`decided`, `origin: web`), "✓ *Allow* - decided in Discord" (`origin: connection:<id>`), "handled by *Ada* in #ops" (`handled`), "withdrawn: session ended" (`withdrawn`, `reason`).

### 7.4 Bound actions

A decision Notification's actions are **bound actions**: each is one answer carrying the single contract operation that runs when the user chooses it. "Start Bugfix" = ~~`workflow.run`~~ `run.start` with workflow X and task Y; "Merge dev bumps" = `github/pr.merge` on PRs 113, 114, 115; "Allow" = `session.respond` for request R in session S; "Resume" = `trigger.resume` on trigger T; "Event-sourced" = `session.input` replying to the session that asked. Pinned by ticket 37 ([ADR 0022](../adr/0022-proposing-is-not-doing.md)). The rule in one line: **proposing is not doing - the producer proposes, the user's informed click authorises.** *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): two of these examples cannot be bound yet. "Merge dev bumps" needs plugin actions to be bindable, which they are not yet (see "Bindable operations" below); "Resume" needs `trigger.resume`, which [#87](https://github.com/theagenticage/hercule/issues/87) builds. Both remain what bound actions are for.)*

```ts
interface BoundAction {
  id: string;
  label: string;                       // the answer text: "Start Bugfix", "Allow", "Event-sourced"
  description?: string;                // producer-authored markdown: what choosing this answer means
  operation: BoundOperation | null;    // null = decide and do nothing ("Dismiss", "Neither, I'll come and type")
  primary?: boolean;                   // at most one per notification; the quiet primary answer (design language)
}

interface BoundOperation {             // the same shape `permission.request` carries in `operation`
  op: string;                          // a contract operation id or a plugin action's qualified id: "run.start", "session.input", "github/pr.merge"
  input: unknown;                      // validated against the op's input schema at creation, then frozen
}
```

- **Declared** at creation as a contract operation plus its input, frozen with the record. The input is validated against the op's input schema when the notification is created, so a malformed action fails the producer, never the user's click. *(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84): `notification.create` checks the actions' shape only (Section 7.1). Checking `op` against the operation table and `input` against its schema arrives with [#85](https://github.com/theagenticage/hercule/issues/85), which must also check both again when the user clicks, because a record created before #85 was never checked.)* Only contract operations ~~(including plugin actions invoked through the contract)~~ can be bound; there is no free-form code. *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): built. `notification.create` checks each answer's operation: `op` must be on the list of bindable operations below, and `input` must decode against that operation's schema. A failure is a `validation` error whose path names the answer, such as `actions.0.operation.input`. The record stores the decoded input, so the operation the user takes is exactly the one that was checked. The check runs again when the user takes the answer (see "Executed" below). No plugin action is on the list yet, so the `op` comment in the sketch above ("or a plugin action's qualified id") does not hold for now.)*
- **`me` names the producing session.** *(Added 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* An answer's input may give `sessionId: "me"`. When a session creates the notification, the core replaces `me` with that session's id before the check, so the record stores the real id. This is how an agent question binds `session.input` to its own session. A run's `notification.create` step that uses `me` gets `validation`, because a run is not a session and has no id for `me` to stand for. It is the `me` of [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.4, resolved from the session token, applied to a bound input.
- **A null operation** is an answer that resolves the notification and executes nothing; its describe line reads "Does nothing". Any producer may bind it. It is how an offer gets its Dismiss and an agent question its "Neither".
- **Bindable operations.** ~~The core may bind any operation. For the other producers (`session`, `run`, `plugin`) the operations of the `credential`, `secret`, `infra` and `permission` grant families, `connection.manage` operations, and operations tagged bulk-destructive ([./13-security.md](./13-security.md) section 6.1) are **not bindable**: a one-line rendering cannot make "rotate this secret" or "retire runner X" an informed click, and nothing in Intake or check-in needs them. The contract's operation table carries a `bindable` flag, default true ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2); binding a non-bindable op fails `notification.create` *(amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84): the `bindable` flag and its check arrive with [#85](https://github.com/theagenticage/hercule/issues/85), on creation and on the click, as above)*. The Permission Request's "add to profile" answer is a core-bound `permission.decide`, which is why the core keeps them.~~ *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* A per-operation flag that defaults to true would make every new operation bindable unless its author remembered to say otherwise. So the rule is turned around: an answer may run only an operation on a short, curated list, `BINDABLE_OPERATIONS` in `@hercule/contract`, and the list applies to every producer, the core included. An operation joins the list only when a user would sensibly run it from one click. The list today:
  - `task.update`: change one task, such as accepting or dismissing a proposal (Section 2.4).
  - `run.start`: start a run of a stored workflow, `{ workflowId, inputs? }`. An unstored definition cannot be bound, because an answer holds ids, not documents.
  - `session.input`: send text to a session, which is how an agent question gets its answer.
  - `session.respond`: answer an approval request a session is parked on (Section 7.6). This is the only operation the core binds today.

  *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* Being on the list is not enough for every producer. The user's click runs the answer as the user, so `notification.create` also checks who may bind what, and refuses the rest with `validation`:
  - `session.respond` is the core's alone. The core raises the decision about each approval request itself, with the request's own answers; a session or a run that bound it could put an "Allow" for someone else's command in front of the user. A producer that wants to ask the user something binds `session.input` instead.
  - A session binds `session.input` only to itself, as `me` or its own id, so the user's answer comes back to the session that asked. Bound to another session, the click would make the user send words the user never read to a session the question did not come from.
  - A session in an assistant's conversation binds no `session.input` at all: that session takes input only through `conversation.send` ([./12-assistants.md](./12-assistants.md)), so it asks in the conversation instead.
  - A run binds `session.input` to any session. The user wrote the workflow, so its steps act for the user.

  Each entry's input is the operation's whole input as one object: an id that the HTTP route carries in its path becomes a field (`taskId`, `sessionId`). The built-in workflow actions `task.update` and `run.start` take the same shapes ([./07-workflows.md](./07-workflows.md) section 8). Binding an operation that is not on the list fails `notification.create` with `validation`, and the error lists the operations that are. The reason the old rule gave still holds and is now enforced by a test: a one-line rendering cannot make "rotate this secret" or "retire runner X" an informed click, so the test refuses any entry whose operation needs a grant in the `credential`, `secret`, `infra` or `permission` family, or `connection.manage`. Not on the list yet:
  - `trigger.resume`, for the breaker's Resume answers (Section 5). [#87](https://github.com/theagenticage/hercule/issues/87) builds it and adds it.
  - `permission.decide`, for the Permission Request's answers (Section 7.6). [#86](https://github.com/theagenticage/hercule/issues/86) builds it. Its "add to profile" answer edits a permission profile, which the test above refuses, so #86 must decide how the core binds it ([./16-open-items.md](./16-open-items.md) A).
  - Plugin actions, such as `github/pr.merge` ([./16-open-items.md](./16-open-items.md) A).
- **Not bounded by the producer's profile.** Authoring is *not* checked against the producer's permission profile: a `worker` session that lacks ~~`workflow.run`~~ `run.start` may still propose "Start Bugfix"; only the click runs it, under the user's parity. The conservative reading (validate the operation against the producer's profile at creation) was rejected: the shipped Triage agent runs as `worker` and lacks ~~`workflow.run`~~ `run.start` and `github/pr.merge`, and proposing work it may not do itself is the one thing Intake exists for.
- **Informed click: two lines, two authors.** Each answer renders with its `label`, the producer's `description` when present (what the choice *means* - only the producer knows), and a **core-rendered describe line** (what the click *does* to the system). Every ~~contract~~ bindable *(amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85))* operation declares `describe(input) -> string` ("Run workflow *Bugfix* with task *#118 Fix login timeout*", "Reply *Event-sourced* to session *Design ordering module*"); the core renders it from the frozen input with live names, the producer never supplies or suppresses it, and it is present on every surface that can execute the action (web app, interactive channel sink). The notification's `body` frames the question. A producer cannot mislabel its way past the describe line. Rendering is pinned by [Prototype: rendering bound actions](https://github.com/theagenticage/hercule/issues/50): in the web app every answer is a ledger row - label · describe line · description as fine print ([./14-web-app.md](./14-web-app.md) section The check-in view); on chat sinks one line per answer, "label · describe line", the description as subtext ([./12-assistants.md](./12-assistants.md) section 11.6). *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): only the operations on the bindable list declare a describe line, because no other operation can be bound. The line is a list of parts, each `{ kind: "text" | "marked", text }`, rather than one string, so a surface can set apart from the words around them the live names and the values the answer sends or sets; the web app shows these `marked` parts in ink. The controller daemon writes it, because it reads the current names of the tasks, workflows and sessions an input names, and an entity that no longer exists is named by its id. Each answer of an open decision carries it as `describeLine` when `notification.query` or `notification.read` returns the record. A null operation's line is "Does nothing". A stored answer whose operation no longer passes the check, because the list or a schema changed after the record was created, reads "Cannot be taken: <why>", and taking it fails with `validation`.)* *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85), security.)* The user decides from the describe line, so it shows everything the operation will run, in full: the whole text `session.input` sends, every changed field and value of `task.update` (a new description in full, each provenance entry's ref, event and run), every input of `run.start` with its whole value, every model option `session.input` changes, and every path of a file approval. Nothing is cut short or left out; a surface that runs out of room wraps. A `run.start` input the workflow declares as a Connection is named by the Connection's label. Describe lines are added only for the user: a session or a run reads a notification without them, because they read the current names of entities the caller may not be allowed to read.
- **Executed** when the user decides: `notification.act { notificationId, actionId }` from the web app or from an interactive channel sink (Section 7.3). The service layer executes the frozen operation as actor `user`, full parity, no grant check. The event log entry carries the notification id, its `producer` and, for a channel click, the channel connection, so audit shows who decided, who proposed and where. Success resolves the notification (`resolution = { kind: "decided", actionId, actor: user, origin }`); a resolved notification's actions are inert (one-shot). *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* Built for the web app and the API; channel clicks arrive with the sinks in [#99](https://github.com/theagenticage/hercule/issues/99). As built:
  - Only the user may act. `notification.act` needs `notification.write`, but a session or a run holding that grant is refused with `forbidden`: proposing is not doing, and taking the answer is the user's act.
  - The `hercule` CLI takes an answer with `hercule notification act <id> --action <actionId>`. An answer taken with an API key, as the CLI does, is resolved with `origin: "api"`; one taken with the web app's login token with `origin: "web"`.
  - The audit entry is `notification.decided { notificationId, actionId, op, producer }`, stamped with the actor `user`; where the answer came from is the resolution's `origin`.
  - ~~An operation that only writes the database (`task.update`, `run.start`) commits in the same transaction as the resolution, so the answer is never half taken. `session.input` and `session.respond` send a frame to a runner, and a transaction never waits on one, so the resolution is written after they succeed.~~ Every bindable operation commits in the same transaction as the resolution, so the answer is never half taken. An operation that tells a runner something (`session.input`, `session.respond`) only records it in that transaction; the frame is sent after the commit, and never if the transaction rolls back, so a decision that cannot be resolved (withdrawn meanwhile) sends nothing. `session.respond` resolves the decision itself, with the same answer (Section 7.6); `notification.act` accepts that resolution as its own.
  - A null operation resolves the decision and runs nothing.
  - A decision that is already resolved is refused with `invalid_state`. When two acts on one decision run at the same time, the second waits for the first transaction to end: if the first resolved the decision, the second gets `invalid_state` and runs nothing; if the first failed, the second runs. So a double click never runs two operations.
- **Failure at click.** ~~The frozen input is not revalidated ahead of the click;~~ *(amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): `notification.act` first checks the answer's operation again, against the list and the operation's schema, as `notification.create` did. A failure is a `validation` error and the decision stays open. The list or a schema may have changed since the record was created, and a record created before #85 was never checked. After that check)* the operation runs its own checks when executed (task #118 cancelled since the proposal -> ~~`workflow.run`~~ `run.start` rejects). A failed execution returns the op's error to the clicker, the notification stays **open** with the error shown inline, and the user may retry or choose another answer. Resolution means the user decided *and it happened*.
- **Channel clicks** are authenticated by the owner platform identities of [./12-assistants.md](./12-assistants.md) section 4: an owner's click executes as `user` with `origin: connection:<id>`; a non-owner's click is refused with an ephemeral reply and executes nothing; a click on an already-resolved notification gets an ephemeral "already decided".
- **Agent questions use the same machinery.** An agent asking the user something ("which architecture?") creates a decision notification: it authors title, body, answer labels and descriptions, and each answer binds ~~`session.input { sessionId: <its own>, content: <the answer> }`~~ `session.input { sessionId: "me", text: <the answer> }` *(amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): the field is `text`, and the session names itself as `me`, which the core replaces with its id, as above)*. The click delivers the answer as queued input, picked up on the agent's next turn boundary exactly like a Permission Request outcome; no blocking wait. This works only because proposing is not profile-bounded: the `worker` profile lacks `session.steer`, so the session could not send itself input, but it may propose that the user does. Free-text answers are not a button: the user opens the session and types; a null-operation "Neither" answer lets them say so from the notification. There is no separate question record.

### 7.5 Assistants and double-firing

Assistants may speak unprompted in the conversation that holds the relevant subscription ([./12-assistants.md](./12-assistants.md)). Rule from ticket 17, keeping ADR 0012's single-path promise: **if an assistant is holding a subscription on the thing, the assistant speaks and no core notification fires; core notifications cover what no assistant is holding.**

Mechanism, pinned by [Assistant runtime](https://github.com/theagenticage/hercule/issues/40) and owned by [./12-assistants.md](./12-assistants.md) section 8.1:

- **Holding** = a live session Subscription whose typed target matches the event by the pipeline's ordinary matcher, held by a session with a `conversationId`. Exact match only (run `r_3` covers `r_3`); no task-level target exists in v1.
- **Covered producers**: only core notifications derived from a pipeline event (v1: the `run.failed` notification). `notification.create` steps are the workflow's own message and are never suppressed; breaker trips, permission requests and update notices derive from nothing an assistant can hold.
- **Suppressed = recorded, not pushed.** The router creates the record already `resolved` with `resolution = { kind: "handled", actor: core, origin: "core", conversationId }`, lists it in the notification center as handled by that assistant (linking the conversation), and delivers it to no sink. ADR 0012's "the inbox always records it" holds; single path means one push.

*(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84).)* Not built yet: every `core.run-failed` notification is recorded with no resolution. The table already accepts an informational record born `handled` (Section 7.1). The rule lands with the router in [#99](https://github.com/theagenticage/hercule/issues/99), because it is the router that decides whether a record is pushed; it needs the assistant runtime's live session subscriptions to decide what is held.

### 7.6 Permission requests

The `permission.request` op (granted to every profile) creates a **Permission Request** notification: a decision whose bound actions are *this session only*, *add to profile*, and deny, each bound to `permission.decide` with the corresponding outcome (`session`, `profile`, `deny`). The notification names the grant, the reason and, when given, the operation the agent wanted to make. The agent learns the outcome through the subscription `permission.request` registers for it and retries; there is no blocking wait. Session tool-approval requests ~~in `approval-required` access mode~~ *(amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): every approval request a session parks on, in any access mode, because a mode other than `approval-required` can still ask)* (`request.opened` in the normalized event taxonomy) surface the same way: a decision notification whose actions are the four values of `ApprovalDecision` - `allow` (this call only), `allow_always` (for the session), `deny` (refuse with a reason the model sees), `cancel` (refuse and end the turn) - each bound to `session.respond` ([./06-providers.md](./06-providers.md) owns the decision type). Grant semantics, profiles and the audit event kinds are in [./13-security.md](./13-security.md). Answering either in the session view resolves the notification (Section 7.7).

*(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* Tool approvals are built; Permission Requests are [#86](https://github.com/theagenticage/hercule/issues/86). As built:

- The decision's kind is `core.approval`. It is raised for every approval request (`command_approval`, `file_change_approval`, `file_read_approval`, `tool_approval`) when the session parks on it. Its title names what the harness asks about ("Run `pnpm test`?", "Change src/app.ts?"), and its body shows the whole command, or the paths. The body lists at most twenty paths and counts the rest in a last line, so a long list never runs past the body limit and loses the end of a path's code span.
- Its subjects are the session and the request, `{ kind: "request", sessionId, requestId }`, so the core finds the decision about one request without touching others about the same session.
- Its answers are the decisions the request accepts, in the request's order, at most four: `allow`, `allow-always`, `deny` and `cancel`, each bound to `session.respond { sessionId, requestId, decision }`. An answer id is kebab-case, so the answer `allow-always` sends the decision `allow_always`. A request that cannot keep a rule does not accept `allow_always`, so that answer is not offered. Each answer carries the same label and the same sentence under it (its `description`) as the permission card in the session view, both from `packages/contract/src/approval-answers.ts`. No answer is primary, as on the permission card.
- Answering in the session view (`session.respond`) resolves the decision as `decided`, with the answer whose operation matches, inside the same operation (Section 7.7). A second `session.respond` to a request whose decision is already resolved is refused with `invalid_state`, and nothing is sent to the runner: the session shows the request open until the harness reports it settled, so without this check a second click would send the harness a second answer. Answering in the notification center, or with `hercule notification act`, answers the session through the same `session.respond`.
- When the request stops waiting any other way, the decision is withdrawn: the harness settled it itself, the harness asked something else, the turn ended, the session exited, or the user interrupted the turn or stopped the session. The withdrawal reason says which. A report the runner sends after the session has already ended is recorded but opens no request, so it raises no decision.
- A harness `question` request raises no notification yet: `session.respond` sends a decision, not answers to questions, so no answer could be bound to it ([./16-open-items.md](./16-open-items.md) A).

### 7.7 Answered elsewhere, and withdrawal

**A decision resolves when its question is answered, wherever it is answered; it is withdrawn when its question stops existing** ([ADR 0027](../adr/0027-a-decision-resolves-when-its-question-is-answered-wherever.md)). A record never stays `open` for a question that is already settled, and there is no expiry concept.

Answered elsewhere (`decided`, `actionId` = the answer whose operation matches, `origin` = where it happened):

| Question | Answered outside the notification by | Resolved by the core when |
|---|---|---|
| Tool approval (`session.respond`) | the session view | the request is answered from any surface |
| Permission Request (`permission.decide`) | the session view, Settings > Permission profiles | the request is decided from any surface |
| Breaker tripped (`trigger.resume`) | the Workflows screen, `hercule trigger resume` | the trigger is resumed from any surface |

The core implements this for its own kinds by resolving the notification inside the same service operation that answers the question; nothing polls. Sinks get `resolved()` exactly as for a click.

*(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85).)* The tool approval row is built: `session.respond` resolves the decision about that request as `decided`, with the answer whose operation is the same call, stamped with the actor and origin of the `session.respond` call. The other two rows arrive with [#86](https://github.com/theagenticage/hercule/issues/86) and [#87](https://github.com/theagenticage/hercule/issues/87).

Withdrawn (`withdrawn`, `reason` one line):

- **Core**: the subject is gone - the session ended before its approval was answered, the trigger or workflow was deleted~~, the runner was retired while "unreachable" was open~~. Same hook as above, in the operation that removes the subject. *(Amended 2026-09-28, [#84](https://github.com/theagenticage/hercule/issues/84): runner unreachable is informational (Section 7.2), so there is nothing open to withdraw when the runner is retired. Built so far: deleting a task withdraws the open decisions about it ("task deleted"); deleting a workflow withdraws those about it and about each of its triggers ("workflow deleted"); an update that removes a trigger withdraws those about that trigger ("trigger removed"). The core's withdrawals are stamped with the actor `system` and the origin `core`.)* *(Amended 2026-09-28, [#85](https://github.com/theagenticage/hercule/issues/85): a tool approval's decision is withdrawn when its request stops waiting without an answer from the user: the harness settled it itself, the harness asked something else, the turn ended, the session exited, or the user interrupted the turn or stopped the session. An interrupt answers the request with `cancel` at the harness ([./06-providers.md](./06-providers.md) section 6.5), but the user chose no answer, so the decision is withdrawn rather than decided.)*
- **Plugins**: `withdraw(notificationId, reason)` on the `notifications` capability ([./05-plugins.md](./05-plugins.md) section 11) - "token refreshed", "connection reconnected".
- **Sessions**: `notification.withdraw { notificationId, reason }` (`hercule notification withdraw`) - an agent whose question the user answered by typing in the session withdraws its own question.
- Both non-core producers may withdraw **only notifications they produced** (`producer` match); anything else is refused. Runs cannot withdraw: their notifications are their message to the user, and the run has ended.

Withdrawal is the *only* mutation a producer has; updating a notification in place does not exist.

## 8. Intake and check-in: model-level requirements

The screens, their anatomy and their visual semantics are pinned in [../design-language.md](../design-language.md) (Intake semantics, Monitoring semantics) and specified in [./14-web-app.md](./14-web-app.md). This section lists only what the model must provide. Both views are pure clients of the public API; if either ever forces a new core concept, that is a design smell to escalate.

**Intake reads Tasks, Notifications and Events - never run outputs.** Every proposal, offer, FYI, question and stamp derives from records the triage run wrote through the public API; the run itself contributes only its summary line.

Intake (forward-looking: prepared work, go/no-go):

- **Proposals** are queryable: Tasks with label `proposed`, joined to their open `triage.proposal` Notification (by `subject` task id), with `priority` for the Now / Today / When you can tiers. "Needs a call" = open `triage.unsure` and `core.breaker-tripped` Notifications; it is verdict-based, never priority-based. **Offers** and **FYIs** are open `triage.offer` and `triage.fyi` records.
- **Made from**: every proposal's provenance entries resolve to their source events; every event carries a `system` (Sentry arrives through Gmail; the mark shows the system, the connection is the suffix) and a `url` ("Open in Gmail / GitHub / Sentry"). `system` is writable after ingest because recognising the system inside an email is enrichment ([./08-events-and-connections.md](./08-events-and-connections.md)).
- **Topic tabs**: Connection default topic label + Task topic label; order from `topics.order` in the user settings store (Section 4).
- **Dossier**: Next + answers from the notification's actions; Why + links from the notification body and the task description; Made from from provenance; History = the actor-stamped event log entries for the task. There is no separate verdict block: the notification body *is* the agent's reasoning.
- **Events view per connection**: the event log filtered by connection since the marker, joined to trigger-effect rows, subscription effect rows, task provenance and notification subjects to derive the per-event stamp (Section 3), filterable by stamp; held events listed (Section 5).
- **Headline and receipt counts** are aggregates over the same join; **"last triage"** is the most recent completed Triage run's `until` and summary text.

**"Since you last checked"** is a per-user, per-view marker in the user settings store: `lastChecked.intake`, `lastChecked.checkin`, `lastChecked.notifications` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 2, `settings`). **Opening the view advances it**: the client reads the current marker, pins it as `since` in the view's URL state for the whole visit (a refresh keeps the brief), and writes now as the new marker. A "since ..." control widens the window for that visit without touching the marker. The marker decides only what counts as *new* - the headline's counts, the "new" divider, the default events-view window; every open proposal, decision and strand is shown regardless of age. Timezone for the displayed marker is the user's timezone setting ([./12-assistants.md](./12-assistants.md) section 5.2).

Check-in (backward-looking: delegated work):

- **Needs-you** = `open` decision Notifications (Section 7.1). Decision cards need FROM (the strand: task / run / session with its domain noun, priority, provenance), WHY (body) and AGENT (session id) - all present on the record via `subject`, `body` and `producer`.
- **Provenance-first attention** (started-by-you > standing workflow > routine schedule, task priority breaks ties) is derivable from the run record's trigger (ticket 20); the spec's derivation is: manual run = started by you; event start trigger = standing; cron start trigger = routine. No new fields.
- **Strands** are Tasks, standing Workflows and one-off Runs; runs, sessions and steps hang off them by the existing links. Routine workflows aggregate to one row from `run.completed` / `run.failed` per workflow.
- **Pulse rail** lines (fleet / assistants / intake) are counts from runners, assistant sessions and the Intake aggregates above.
- Assistants are ambient presence, never work strands: assistant sessions are excluded from strand queries.
- The "last check-in" divider is `lastChecked.checkin`, advanced by the same rule as Intake's.

## Post-v1

- A shipped work workflow ("Work on task": `taskId` + repo inputs, first step sets `in-progress` and drops `proposed`, one agent step in an ephemeral workspace, a signal trigger on PR merged sets `done`). Deliberately not shipped: v1 dogfoods the no-workflow situation first; when one ships it needs the workspace resource to come from an input (07 §4.4 names it statically today).
- A shipped fast lane on the Triage workflow (an event trigger for mentions and assignments); v1 keeps the batch only.
- Park as a proposal answer, if dogfooding shows "not now" needs to be distinguishable from "accepted into the backlog".
- Human-gate step (waiting-for-human inside a run); v1 keeps the `triage.unsure` notification pattern as the evidence for whether it returns.
- Feedback-driven triage learning (thumbs up/down on proposals feeding assistant memory); v1 keeps every triage run's summary and every proposal's provenance so the feedback has something to attach to.
- Presence-aware notification routing (device class, presence, receipts); v1 keeps all routing in the core router and the sink contract additive.
- Webhook event sources; v1 keeps spawn bounds and the known-work check, which are what make high-volume sources safe.
- Sub-workflow steps that wait and route on the child's output; v1 ships fire-and-forget ~~`workflow.run`~~ `run.start` only.
- Merging Intake and check-in into one spine; a post-dogfooding question, both views stay separate in v1.
- Producer-side muting UI beyond a per-producer toggle; v1 keeps `producer` on the record so finer muting is a filter change.
- Per-record read state, if the per-view marker proves too coarse; additive (a `readAt` column) and nothing depends on its absence.

## Sources

Tickets:

- Triage engine & user-set bounds - https://github.com/theagenticage/hercule/issues/15
- Prototype: the check-in view - https://github.com/theagenticage/hercule/issues/20
- Assemble the v1 spec (comments: Intake handoffs) - https://github.com/theagenticage/hercule/issues/21
- Assistant design: memory, identity, channel binding - https://github.com/theagenticage/hercule/issues/17
- Task model: shape, status axis, lifecycle, provenance - https://github.com/theagenticage/hercule/issues/29
- Prototype: the Intake view - https://github.com/theagenticage/hercule/issues/30
- Workflow model: recipes, triggers, human gates - https://github.com/theagenticage/hercule/issues/13
- Event & trigger ingress design - https://github.com/theagenticage/hercule/issues/14
- Agent-operates-system surface - https://github.com/theagenticage/hercule/issues/16
- Security & secrets model - https://github.com/theagenticage/hercule/issues/18
- Actors and authorisation beyond sessions - https://github.com/theagenticage/hercule/issues/37
- Channel contribution interface and conversation ingress - https://github.com/theagenticage/hercule/issues/39
- Assistant runtime - https://github.com/theagenticage/hercule/issues/40
- Notification lifecycle and shipped triage conventions - https://github.com/theagenticage/hercule/issues/42

ADRs:

- [ADR 0008 - Workflow graphs route on declared outputs](../adr/0008-workflow-graphs-route-on-declared-outputs.md)
- [ADR 0009 - All events flow through one persisted pipeline](../adr/0009-all-events-flow-through-one-persisted-pipeline.md)
- [ADR 0011 - Triage is a workflow pattern inside core-enforced bounds](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)
- [ADR 0012 - Notifications are core-routed; sinks are dumb](../adr/0012-notifications-are-core-routed-sinks-are-dumb.md)
- [ADR 0013 - Agents operate Hercule through the public API](../adr/0013-agents-operate-hercule-through-the-public-api.md)
- [ADR 0019 - The task model is thin; workflows own task semantics](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)
- [ADR 0022 - Proposing is not doing](../adr/0022-proposing-is-not-doing.md)
- [ADR 0027 - A decision resolves when its question is answered, wherever](../adr/0027-a-decision-resolves-when-its-question-is-answered-wherever.md)

Design language: [../design-language.md](../design-language.md) (Intake semantics, Monitoring semantics). Glossary: [../../CONTEXT.md](../../CONTEXT.md) (Intake, Proposal, Offer, Topic, Spawn Bound, Notification, Bound Action, Provenance, External Ref).
