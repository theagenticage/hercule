# Tasks

A Task is a unit of human intent: a described piece of work someone wants done. It is a thin row - title, markdown description, one fixed status axis, a priority, bare-string labels, an optional project, and an append-only provenance list. The core stores tasks, emits `task.created` / `task.updated` platform events, and answers exact-identity and full-text queries. It never decides when a task is in progress or done; every task semantic beyond the row (what "done" means, when to close, what a label signifies) belongs to workflows and their shipped defaults ([ADR 0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)). Tasks are the buffer between triage and work: triage workflows create and update them, work workflows trigger on their platform events ([ADR 0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md), [./10](./10-triage-intake-and-notifications.md)).

## The Task row

```ts
type TaskStatus = 'open' | 'in-progress' | 'done' | 'cancelled';
type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';

interface ProvenanceEntry {
  ref?: string;      // External Ref in canonical form, e.g. "github:issue:owner/repo#42"
  eventId?: number;  // id of an event in the event log (./08); integer log position (./04)
  runId?: string;    // id of a Run (./07)
  at: string;        // timestamp of the append
  actor: Actor;      // "user" | "session:<id>" (./11)
}

interface Task {
  id: string;
  title: string;
  description: string;        // markdown
  status: TaskStatus;
  priority: TaskPriority;     // default "normal"
  labels: string[];
  projectId?: string;         // at most one Project (./02)
  provenance: ProvenanceEntry[];  // append-only
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  deletedAt?: string;         // soft delete (see Delete); read answers not_found, query excludes
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | id | Assigned by the core. |
| `title` | string | Required. |
| `description` | string | Markdown. Enrichment (by triage agents or the user) edits this field; there is no comment thread. |
| `status` | enum | `open`, `in-progress`, `done`, `cancelled`. See [Status axis](#status-axis-and-lifecycle). |
| `priority` | enum | `urgent`, `high`, `normal`, `low`. Defaults to `normal`. |
| `labels` | string[] | Bare strings, flat namespace. See [Labels](#labels). |
| `projectId` | id? | Optional link to one Project. |
| `provenance` | ProvenanceEntry[] | Append-only. See [Provenance](#provenance-and-external-refs). |
| `createdAt`, `updatedAt` | timestamp | Maintained by the core. |
| `statusChangedAt` | timestamp | Maintained by the core. Consolidated reading (ticket 29 names the field only): set on create and updated only when `status` changes. |
| `deletedAt` | timestamp? | Set by `task.delete`. A deleted task answers `not_found` on `task.read` and is excluded from `task.query` and search. See [Delete](#delete). |

There is no assignee, no subtask, no task-to-task dependency, and no comment thread (see [Not in v1](#not-in-v1)).

Ids are UUIDv7 like every Hercule-owned entity; format, storage and the short form are owned by [./04](./04-state-store.md).

## Status axis and lifecycle

The status axis is fixed: `open -> in-progress -> done`, plus `cancelled`. There are no user-definable domain states. ~~Triage-ish states ("proposed", "needs a call") are labels or notification verdicts, never statuses.~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395), [#392](https://github.com/theagenticage/hercule/issues/392).)* What triage prepares is never a Task status: a proposal is a `proposal` Signal, and no Task exists until the user presses Accept ([./10](./10-triage-intake-and-notifications.md#93-core-kinds-and-signalraise)).

Rules:

- **Any-to-any transitions.** The core enforces no state machine. `done -> open`, `cancelled -> in-progress`, and every other pair are legal.
- **No core auto-transitions.** The core never changes a task's status on its own. A run starting, succeeding, or failing does not move the task. Status changes only through an explicit `task.update` (API operation or built-in action).
- **No completion gating.** The core never refuses a status change because some condition (open PR, running session) is unmet.
- `cancelled` means "decided not to do". Deleting means "should never have existed" (see [Delete](#delete)).

Rationale: a run-to-task link is optional under the all-links-optional work triangle ([./02](./02-domain-model.md)), so core auto-transitions would make that optional link load-bearing; and every semantic a richer task engine would hard-code is already expressible as an editable workflow ([ADR 0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)).

### "Done means the PR is merged" is a workflow convention

The shipped coding workflows implement it; the core knows nothing about PRs. The mechanics, using primitives owned by [./07](./07-workflows.md) and [./08](./08-events-and-connections.md):

1. A work workflow starts on a task platform event (for example `task.updated` with `event.changes.status.new == "in-progress"`, or `task.created` carrying a conventional label).
2. Its agent step does the work and opens the PR.
3. The same run holds a **signal trigger** correlated to the PR-merged event (the runtime instantiation of that trigger is a Subscription held by the run). The run waits for it; the controller keeps no waiting-for-human machinery, only the subscription.
4. The run's final step is the built-in action `task.update` with `status = done`.

One run represents the work start to finish. Because v1 GitHub ingress polls, the merge signal lands with roughly one poll interval of latency, which is acceptable.

Accepted cost: nothing marks a task done when its run succeeds unless a workflow says so. Shipped defaults MUST demonstrate the pattern.

## Priority

One field, fixed enum `urgent` / `high` / `normal` / `low`, default `normal`. Consolidated reading of "optional, default normal": the field may be omitted on create, and a stored task always holds one of the four values.

The user and agents write the same field through the same `task.update` operation. There is no separate "suggested priority" field: because every mutation is stamped with its actor on the event envelope ([./08](./08-events-and-connections.md), [./11](./11-public-api-and-agent-surface.md)), the log already tells who set which priority when. Priority is not a status and does not affect transitions.

Rendering (bars and weight, never color) is pinned in [../design-language.md](../design-language.md) ("Importance"); ~~the Intake tiers Now / Today / When you can are a presentation of this field ([./14](./14-web-app.md)).~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395), [#392](https://github.com/theagenticage/hercule/issues/392).)* A Signal carries the same priority values; on Intake, `urgent` shows as Now and `high` as a small mark ([./17](./17-desktop-app.md#intake)).

## Labels

- Labels are bare strings in one flat namespace. A label exists from the moment a task carries it; there is no label registry entity and no create-label operation.
- The core blesses no label. Shipped workflows may rely on conventional ones.
- Colors, descriptions, and orderings for labels are presentation-layer concerns of the web app ([./14](./14-web-app.md)); the core stores none of them.
- `labels` is an array field: `task.update` takes `addLabels?` and `removeLabels?` and never a whole `labels` array, and `task.updated` reports `{added, removed}` for it. The user and a triage agent write the same task, and a whole-array replace would silently undo whichever of them wrote first; a label named on both lists stays on the task and is reported as neither.

~~Two conventional labels are load-bearing for Intake ([./10](./10-triage-intake-and-notifications.md)):~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395), [#392](https://github.com/theagenticage/hercule/issues/392).)* One label convention remains ([./10](./10-triage-intake-and-notifications.md)):

- ~~**`proposed`** - a Task carrying `proposed` together with its pending go/no-go Notification is a Proposal, the unit Intake presents. Proposal is vocabulary, not an entity.~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* The `proposed` label is retired. A Proposal is a `proposal` Signal ([./10](./10-triage-intake-and-notifications.md#93-core-kinds-and-signalraise)).
- **Topic labels** - a Topic is a label that groups Intake (for example `code`, `business`, `personal`, `ops`). ~~Each Connection files its events into one default topic chosen at setup~~ A Connection may carry a topic its events file into, and may have none ([./08](./08-events-and-connections.md)); triage labels a proposal with the connection's topic, when it has one, unless the content says otherwise *(amended 2026-10-02, [#323](https://github.com/theagenticage/hercule/issues/323))*. Topics are user-defined and user-ordered; the ordering is presentation state, not a task field.

Which labels a triage workflow sets~~, and when `proposed` is removed,~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* is owned by [./10](./10-triage-intake-and-notifications.md).

## Provenance and External Refs

Provenance is a task's append-only record of what created or touched it. Each entry is `{ref?, eventId?, runId?, at, actor}`; every field except `at` and `actor` is optional, and an entry may carry any combination (an event that was the trigger, the run that enriched the task, a ref the triage agent recognised inside an email). Entries are never edited or removed; a deleted task is soft-deleted, so its entries stay with the row (see [Delete](#delete)).

Provenance is what lets a ~~duplicate signal~~ later event about the same thing *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* find its existing task, and what the Intake "made from" line and the proactive "related to task X" link are rendered from.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* A task that a run's `task.create` step creates always records its run: the core adds the entry `{ runId }` after the entries the step's params give, unless one of those already names the run. The entry is the core's own, so it does not count toward the limit on how many entries one request may add. A run's `task.update` step adds no such entry, because the run did not create the task ([./07-workflows.md](./07-workflows.md) section 8).

### External Ref canonical form

An External Ref is a fully-qualified canonical identifier for a thing outside Hercule. Examples: `github:issue:owner/repo#42`, `gmail:thread:<id>`, `sentry:issue:123`.

- The plugin that defines the ref type owns canonicalization. Two events about the same external thing MUST produce byte-identical refs.
- The Connection an event arrived through is **not** part of the identity. The same GitHub issue seen through two connections yields one ref.
- Refs are **not unique across tasks.** Several tasks may carry the same ref. The `task.query` guard convention treats "any *open* task with this ref" as ~~the duplicate signal~~ a later event about the same thing, so a closed task does not block a new one for a ~~recurring signal~~ recurring event *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)*.
- A ref is an identity, not a location. The URL used for "Open in <system>" is the event envelope's `url` field ([./08](./08-events-and-connections.md)), not part of provenance.

For systems with no plugin in v1 (Sentry, Tailscale, Hetzner notices arriving through Gmail), the core pins only the **grammar** - `<system>:<kind>:<identity>`, lowercase system, no whitespace - and validates it at write. The gmail plugin's sender rules stamp `system` only ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.2); the **triage agent owns identity extraction**, guided by worked per-system examples in the triage skill and by checking existing refs (`task.query`) before minting one. When a real plugin for such a system lands post-v1, it takes ownership of its prefix; the grammar keeps old refs valid.

### What `task.query` matches

`task.query` performs exact identity matching only: a provenance ref (string equality on the canonical form), labels, status, and `projectId`. It never matches content. An agent's `hercule task search` adds full text on top of the same filters (see [Search](#search)).

## Relations: project, runs, sessions

- **Project:** at most one per task, via `projectId`. Optional. Project is defined in [./02](./02-domain-model.md). A task keeps its `projectId` when the project is soft-deleted.
- **Runs and sessions:** a task holds no run or session ids. The links live on the run and session side (all links optional, per the work triangle in [./02](./02-domain-model.md)); a task's run list is derived by querying runs that reference it. Provenance may additionally record a `runId` for a run that created or touched the task, but that is a history entry, not the link.

## Platform events

Task mutations emit platform events into the one persisted event pipeline ([./08](./08-events-and-connections.md)). They are the trigger surface for work workflows. The actor of the mutation is carried once, on the event envelope's `actor` field ([./08](./08-events-and-connections.md)); the payloads below do not duplicate it.

*(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81).)* Until this change, `task.created` and `task.updated` were written as audit entries. The event router never evaluates audit entries, so no trigger or subscription could see them. They are platform events now: routed, with the actor still on the envelope and the payloads unchanged, in the same log. `task.deleted` is still written as an audit entry only, so nothing can wait on it yet ([./08](./08-events-and-connections.md) section 2).

**`task.created`** carries a full snapshot:

```ts
interface TaskCreatedPayload {
  task: Task;
}
```

**`task.updated`** carries per-field diffs, so a CEL filter routes without fetch-and-compare:

```ts
interface TaskUpdatedPayload {
  taskId: string;
  changes: {
    // scalar fields: title, description, status, priority, projectId
    [field: string]: { old: unknown; new: unknown };
  } & {
    // array fields: labels, provenance
    labels?: { added: string[]; removed: string[] };
    provenance?: { added: ProvenanceEntry[]; removed: [] };
  };
}
```

Rules:

- One update operation produces exactly one `task.updated` event, however many fields it changed. `changes` contains only fields that changed.
- Scalar fields report `{old, new}`; array fields report `{added, removed}`. Provenance is append-only, so its `removed` is always empty.
- A provenance-only append fires `task.updated` too. Shipped workflow defaults MUST filter on the fields they care about (for example `has(event.changes.status)`) rather than on the bare event kind, and thereby demonstrate field-filtering.
- Example CEL filters: `event.changes.status.new == "done"`, `has(event.changes.status)`, ~~`"proposed" in event.changes.labels.removed`~~ `"ready-for-agent" in event.changes.labels.added` *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): `proposed` is retired.)*. Whether payload fields sit under `event.payload` or are flattened onto `event` follows the envelope rules in [./08](./08-events-and-connections.md) and the CEL context in [./07](./07-workflows.md).

**`task.deleted`** carries the final snapshot, because the row is unreadable afterwards:

```ts
interface TaskDeletedPayload {
  taskId: string;
  snapshot: Task;
}
```

There are no finer-grained kinds (`task.done`, `task.labelled`); CEL over `changes` covers them.

## Search

One operation, `task.query`, serves every caller: the built-in action in agent-less graphs (the guard-before-agent step), agents deciding their own queries through `hercule task query`, and the web app. Its input is the contract's `TaskFilter` ([./11](./11-public-api-and-agent-surface.md) section 2):

| Field | Matching |
|---|---|
| `refs`, `labels`, `status`, `projectId` | exact identity; `refs` against the canonical External Ref form |
| `text` | SQLite FTS over `title` + `description` only; labels and refs are never reached through FTS |

Within one field the listed values are **any-of**; across fields the filter is **and**; no filters lists every task. No `or` across fields and no negation in v1. Pagination and sorting follow [./11](./11-public-api-and-agent-surface.md) section 1.6.

The FTS5 table is external-content over `tasks` with the tokenizer `unicode61 remove_diacritics 2`, so a search matches regardless of case and diacritics (`cafe` finds `Café`). **Callers pass plain words.** The service splits `text` on whitespace, quotes each token and joins the tokens with `AND` to build the `MATCH` expression; raw FTS5 `MATCH` syntax is never exposed, so `AND OR "(` is four words to search for rather than a syntax error. A text holding no letter or digit matches nothing and is not an error, because the index holds no punctuation either.

**Order.** With `text` the order is relevance (`bm25` ascending) and the walk pages by offset. With `text` and an explicit `sort`, `task.query` fails `validation` naming both: honouring both would pick one of two paging strategies per request, and ignoring the sort would be a silent substitution. ~~Without `text` the order is keyset over `updatedAt`, `createdAt`, `priority` or `status`, default `updatedAt desc`.~~ *(Amended 2026-10-03, [#300](https://github.com/theagenticage/hercule/issues/300).)* Without `text` the order is keyset over one or more of `updatedAt`, `createdAt`, `priority` and `status` ([./11](./11-public-api-and-agent-surface.md) section 1.6), default `updatedAt desc`. `priority` ascends low, normal, high, urgent; `status` ascends open, in-progress, done, cancelled.

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided by [#393](https://github.com/theagenticage/hercule/issues/393).)* Event search is the named exception to relevance order. `event.query` with `text` searches the envelope's `title` and `author` with the same tokenizer, but returns events newest first and pages by keyset, because a user looking for an event remembers roughly when it came ([./04](./04-state-store.md#event-search), [./11](./11-public-api-and-agent-surface.md#event)).

No vector search and no embeddings. The semantic part of triage - grouping heterogeneous ~~signals~~ events *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)*, spotting connections - is the agent iterating its own queries and reading results; that is why agent task search is a hard v1 requirement (ticket #16 handoff).

## Delete

Delete is **soft** (resolved 2026-09-01, [Domain model residue](https://github.com/theagenticage/hercule/issues/46), amending ticket 29's hard delete): `task.delete` sets `deletedAt`; the row and its provenance stay. A deleted task answers `not_found` on `task.read`, is excluded from `task.query` (no include-deleted option in v1) and from search, and emits `task.deleted { taskId, snapshot }` with the final row, since nothing can read it afterwards. The core withdraws open Notifications whose subject is the task ([./10](./10-triage-intake-and-notifications.md)); Runs and Sessions keep their `taskId`. The event log keeps the audit trail of everything that happened before deletion (the event log is the audit log, [./13](./13-security.md)); the events the task referenced stop being protected from pruning ([./04](./04-state-store.md) Retention). Use `cancelled` for work that was decided against; delete only what should never have existed. Pruning deleted tasks outright, with their runs, is post-v1.

Delete is a public-API operation ([./11](./11-public-api-and-agent-surface.md)). The shipped `worker` profile grants task read/create/update and not delete (ticket 18; verb split in [./13](./13-security.md)).

## API operations an agent uses

Task operations are ordinary public-API operations defined in the service layer and contract package, reachable over HTTP and through the `hercule` CLI ([./11](./11-public-api-and-agent-surface.md), [ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md)). Available to any permission profile granting the `task` family; the shipped profiles and their verbs are in [./13](./13-security.md) (both `assistant` and `worker` grant task read/create/update).

| CLI | Operation |
|---|---|
| `hercule task query` | structured filters + FTS, returns matching tasks; no filters lists all |
| `hercule task read <id>` | one task, full row including provenance |
| `hercule task create` | creates a task; emits `task.created` |
| `hercule task update <id>` | changes any writable field, adds/removes labels, appends provenance; emits one `task.updated` |
| `hercule task delete <id>` | soft delete ([Delete](#delete)); grant `task.delete` |

Every mutation is stamped with the calling actor (`user`, `session:<id>`, `run:<id>` or `plugin:<id>`) on the event envelope; a provenance entry appended by the call carries the same actor. All operations return fast; nothing blocks.

~~Notification actions that bind a task operation ("Start Bugfix" = start workflow X with task Y) are owned by [./10](./10-triage-intake-and-notifications.md).~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395), [#391](https://github.com/theagenticage/hercule/issues/391), [#392](https://github.com/theagenticage/hercule/issues/392).)* Bound actions that touch tasks are owned by [./10](./10-triage-intake-and-notifications.md): Accept on a proposal runs `task.create` ([§9.3](./10-triage-intake-and-notifications.md#93-core-kinds-and-signalraise)), and Hand to an agent runs `run.start` with a signal input ([§9.4](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)). "Start *X*" on a proposal is dropped, because the Task does not exist yet.

## Built-in workflow actions on tasks

Three of the ~~five~~ six *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): `signal.screen` joined them.)* built-in actions that are operations act on tasks: `task.create` (agent-less graphs, "every cron tick, file a task"), `task.update` (the closing step of the done-means-merged convention), and `task.query` (exact identity matching; the guard-before-agent pattern that routes ~~duplicate signals~~ later events about the same thing *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* to `task.update` without spawning an agent, [./10](./10-triage-intake-and-notifications.md)). Their parameters and outputs are defined once in [./07](./07-workflows.md#8-built-in-actions). They call the same service layer as the API and so emit the same platform events.

An in-run action step stamps `run:<runId>` and is ungated: the recipe is the user's ([./11](./11-public-api-and-agent-surface.md) section 3.1).

## Presentation over the status axis

Kanban-style groupings, columns, swimlanes~~, and the Intake tiers~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): the Intake tiers are retired.)* are presentation-layer constructs over the fixed axis, priority, and labels. They are explicitly not domain states: the core stores no grouping, and no grouping may introduce a status. Where such groupings live and how they are configured is the web app's concern ([./14](./14-web-app.md)); the domain model provides only `status`, `priority`, `labels`, and `projectId` to group by.

## Not in v1

- **Subtasks** and **task-to-task dependencies** - grouping is expressed by shared labels, a shared project, or provenance refs pointing at another task's ~~signals~~ events *(amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395))*.
- **Comments** - enrichment edits the description or appends provenance.
- **Assignee** - who works a task is visible from the runs and sessions that reference it and from the actor stamps; there is no assignment field.
- **Suggested-priority shadow field** - the actor-stamped event log covers it.

## Post-v1

- Subtasks / dependencies / comments / assignee: additive fields or side tables; nothing in v1 assumes their absence beyond the thin row.
- Webhook event sources make `task.query` guards earn their keep at volume; v1 polling sources are modest-volume ([./08](./08-events-and-connections.md)).
- Multi-user widens `actor` on provenance entries; the field is a string from day one so it widens without restructuring.

## Sources

- [Task model: shape, status axis, lifecycle, provenance](https://github.com/theagenticage/hercule/issues/29)
- [Triage engine & user-set bounds](https://github.com/theagenticage/hercule/issues/15)
- [Agent-operates-system surface](https://github.com/theagenticage/hercule/issues/16)
- [Prototype: the Intake view](https://github.com/theagenticage/hercule/issues/30)
- [Prototype: the check-in view](https://github.com/theagenticage/hercule/issues/20) (priority requirement)
- [Security & secrets model](https://github.com/theagenticage/hercule/issues/18) (task grant family, shipped profiles)
- [ADR 0019 - The task model is thin; workflows own task semantics](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)
- [ADR 0011 - Triage is a workflow pattern inside core-enforced bounds](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md)
- [ADR 0013 - Agents operate Hercule through the public API](../adr/0013-agents-operate-hercule-through-the-public-api.md)
- [Write the Intake changes and the build tickets](https://github.com/theagenticage/hercule/issues/395), deciding tickets #391, #392 and #393
- [ADR 0040 - Intake holds Signals; Notifications are Hercule's own messages](../adr/0040-intake-holds-signals-notifications-are-hercules-own-messages.md)
