# Tasks

A Task is a unit of human intent: a described piece of work someone wants done. It is a thin row - title, markdown description, one fixed stage axis with a coarse status read from it, a priority, bare-string labels, an optional project, and an append-only provenance list. The core stores tasks, emits `task.created` / `task.updated` platform events, and answers exact-identity and full-text queries. It creates a Task for every Thread that has none to join (see [Threads and their Tasks](#threads-and-their-tasks)). Beyond that it never decides when a task is in progress or done; every task semantic beyond the row (what "done" means, when to close, what a label signifies) belongs to workflows and their shipped defaults ([ADR 0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md), amended by [ADR 0052](../adr/0052-tasks-have-a-stage-and-threads-join-them.md)). Tasks are the buffer between triage and work: triage workflows create and update them, work workflows trigger on their platform events ([ADR 0011](../adr/0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md), [./10](./10-triage-intake-and-notifications.md)).

## The Task row

```ts
type TaskStage = 'exploring' | 'planned' | 'building' | 'in-review' | 'landed' | 'done' | 'dropped';
type TaskStatus = 'open' | 'in-progress' | 'done' | 'cancelled';  // a reading of the stage
type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';

interface ProvenanceEntry {
  ref?: string;      // External Ref in canonical form, e.g. "github:issue:owner/repo#42"
  signalId?: string; // id of an Intake signal handed to an agent (./10 section 9.4)
  eventId?: number;  // id of an event in the event log (./08); integer log position (./04)
  runId?: string;    // id of a Run (./07)
  at: string;        // timestamp of the append
  actor: Actor;      // "user" | "session:<id>" (./11)
}

interface Task {
  id: string;
  title: string;
  description: string;        // markdown
  stage: TaskStage;
  status: TaskStatus;         // worked out from stage, never set on its own
  priority: TaskPriority;     // default "normal"
  labels: string[];
  projectId?: string;         // at most one Project (./02)
  provenance: ProvenanceEntry[];  // append-only
  createdAt: string;
  updatedAt: string;
  stageChangedAt: string;
  statusChangedAt: string;
  deletedAt?: string;         // soft delete (see Delete); read answers not_found, query excludes
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | id | Assigned by the core. |
| `title` | string | Required. |
| `description` | string | Markdown. Enrichment (by triage agents or the user) edits this field; there is no comment thread. |
| `stage` | enum | `exploring`, `planned`, `building`, `in-review`, `landed`, `done`, `dropped`. The truth about where the Task stands. See [Stage](#stage). |
| `status` | enum | `open`, `in-progress`, `done`, `cancelled`. A coarse reading of `stage`. See [Status is a reading of the stage](#status-axis-and-lifecycle). |
| `priority` | enum | `urgent`, `high`, `normal`, `low`. Defaults to `normal`. |
| `labels` | string[] | Bare strings, flat namespace. See [Labels](#labels). |
| `projectId` | id? | Optional link to one Project. |
| `provenance` | ProvenanceEntry[] | Append-only. See [Provenance](#provenance-and-external-refs). |
| `createdAt`, `updatedAt` | timestamp | Maintained by the core. |
| `stageChangedAt` | timestamp | Maintained by the core. Set on create and updated only when `stage` changes. |
| `statusChangedAt` | timestamp | Maintained by the core. Consolidated reading (ticket 29 names the field only): set on create and updated only when `status` changes. A stage change inside one status (`building` to `in-review`) does not move it. |
| `deletedAt` | timestamp? | Set by `task.delete`. A deleted task answers `not_found` on `task.read` and is excluded from `task.query` and search. See [Delete](#delete). |

There is no assignee, no subtask, no task-to-task dependency, and no comment thread (see [Not in v1](#not-in-v1)).

Ids are UUIDv7 like every Hercule-owned entity; format, storage and the short form are owned by [./04](./04-state-store.md).

## Stage

*(Added 2026-11-07, [#1029](https://github.com/theagenticage/hercule/issues/1029), [ADR 0052](../adr/0052-tasks-have-a-stage-and-threads-join-them.md).)* A Task's stage says where it stands. There are seven, in this order:

| Stage | Reads as | Status |
|---|---|---|
| `exploring` | being worked out, nothing settled yet. Every Task the core makes for a Thread starts here | `open` |
| `planned` | decided and not started. A Task someone files starts here | `open` |
| `building` | being built | `in-progress` |
| `in-review` | built and waiting for review | `in-progress` |
| `landed` | merged or shipped and not yet closed | `in-progress` |
| `done` | finished. An end | `done` |
| `dropped` | decided against. An end | `cancelled` |

Rules:

- **The list is fixed.** Users and workflows define no stage of their own. A client may group or colour stages as it likes ([Presentation over the stage](#presentation-over-the-stage)), but never adds one.
- **Any-to-any.** The core enforces no order. `done -> exploring` is legal, and so is `exploring -> landed`. The core refuses no stage change because some condition is unmet.
- **The core never moves a stage on its own.** A run starting, succeeding or failing, a session starting or ending, a PR merging: none of them moves the stage. A stage changes only through an explicit `task.update` (API operation or built-in action). One exception: the core creates a Task, at `exploring`, for a Thread that has none to join ([Threads and their Tasks](#threads-and-their-tasks)). Creating the row does not decide that any work has progressed.
- **Where a new Task starts.** `task.create` takes an optional `stage`, default `planned`. A Task made for a Thread starts at `exploring`. A Task that `signal.handOff` creates starts at `building` (below, [Provenance](#provenance-and-external-refs)).
- **`stageChangedAt`** moves only when `stage` changes.
- A stage names a position and nothing more. What it means for the work, and which fact moves a Task into it, is for workflows, as "done means the PR is merged" is below.

## Status axis and lifecycle

The status axis is fixed: `open -> in-progress -> done`, plus `cancelled`. There are no user-definable domain states, and the stages above are not an exception: they are a fixed list too. ~~Triage-ish states ("proposed", "needs a call") are labels or notification verdicts, never statuses.~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395), [#392](https://github.com/theagenticage/hercule/issues/392).)* What triage prepares is never a Task status: a proposal is a `proposal` Signal, and no Task exists until the user presses Accept ([./10](./10-triage-intake-and-notifications.md#93-core-kinds-and-signalraise)).

*(Amended 2026-11-07, [#1029](https://github.com/theagenticage/hercule/issues/1029), [ADR 0052](../adr/0052-tasks-have-a-stage-and-threads-join-them.md).)* **Status is a reading of the stage.** The core works it out from `stage` and writes it only from there, in the same write:

| `stage` | `status` |
|---|---|
| `exploring`, `planned` | `open` |
| `building`, `in-review`, `landed` | `in-progress` |
| `done` | `done` |
| `dropped` | `cancelled` |

`status` stays because its values live outside the `tasks` table: in stored workflow definitions, in frozen run plans, in open bound answers and in old event payloads. A run that sends a field its action does not know fails when the step's input decodes, so those must keep working. "Is it finished?" is also still a useful question for `task.query` and for CEL. Nothing rewrites stored definitions, CEL, frozen plans or old events.

**The legacy write.** `task.update { status }` is still valid. The core turns it into a stage:

- When the status already matches the current stage's reading, the stage does not change. `status: in-progress` sent to a Task at `in-review` leaves it at `in-review`; it never moves it back to `building`.
- Otherwise `open` gives `planned`, `in-progress` gives `building`, `done` gives `done` and `cancelled` gives `dropped`.

`task.update` with both `stage` and `status` fails `validation`. The message tells the caller to send `stage`, because the two can disagree and the stage is the exact word.

**`task.updated` reports both.** `changes.status` appears whenever the coarse status changes, so a trigger on `event.payload.changes.status` fires as it did before stages existed. `changes.stage` appears for every stage change. Moving a Task from `building` to `in-review` reports `changes.stage` only, because its status stays `in-progress`.

Rules for both:

- **Any-to-any transitions.** The core enforces no state machine. `done -> open`, `cancelled -> in-progress`, and every other pair are legal.
- **No core auto-transitions.** The core never changes a task's stage or status on its own. A run starting, succeeding, or failing does not move the task. A stage, and so a status, changes only through an explicit `task.update` (API operation or built-in action). The one thing the core does by itself is create a Task for a Thread ([Threads and their Tasks](#threads-and-their-tasks)).
- **No completion gating.** The core never refuses a stage or status change because some condition (open PR, running session) is unmet.
- `cancelled` (stage `dropped`) means "decided not to do". Deleting means "should never have existed" (see [Delete](#delete)).

Rationale: a run-to-task link is optional under the all-links-optional work triangle ([./02](./02-domain-model.md)), so core auto-transitions would make that optional link load-bearing; and every semantic a richer task engine would hard-code is already expressible as an editable workflow ([ADR 0019](../adr/0019-the-task-model-is-thin-workflows-own-task-semantics.md)).

### "Done means the PR is merged" is a workflow convention

The shipped coding workflows implement it; the core knows nothing about PRs. The mechanics, using primitives owned by [./07](./07-workflows.md) and [./08](./08-events-and-connections.md):

1. A work workflow starts on a task platform event (for example `task.updated` with `event.payload.changes.status.new == "in-progress"`, or `task.created` carrying a conventional label).
2. Its agent step does the work and opens the PR.
3. The same run holds a **signal trigger** correlated to the PR-merged event (the runtime instantiation of that trigger is a Subscription held by the run). The run waits for it; the controller keeps no waiting-for-human machinery, only the subscription.
4. The run's final step is the built-in action `task.update` with `status = done` (or `stage = done`; `status = done` still works and gives the same stage).

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

Provenance is a task's append-only record of what created or touched it. Each entry is `{ref?, eventId?, signalId?, runId?, at, actor}`; every field except `at` and `actor` is optional, and an entry may carry any combination (an event that was the trigger, the run that enriched the task, a ref the triage agent recognised inside an email). Entries are never edited or removed; a deleted task is soft-deleted, so its entries stay with the row (see [Delete](#delete)).

Provenance is what lets a ~~duplicate signal~~ later event about the same thing *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* find its existing task, and what the Intake "made from" line and the proactive "related to task X" link are rendered from.

*(Amended 2026-09-24, [#79](https://github.com/theagenticage/hercule/issues/79).)* A task that a run's `task.create` step creates always records its run: the core adds the entry `{ runId }` after the entries the step's params give, unless one of those already names the run. The entry is the core's own, so it does not count toward the limit on how many entries one request may add. A run's `task.update` step adds no such entry, because the run did not create the task ([./07-workflows.md](./07-workflows.md) section 8).

*(Added 2026-10-20, [#801](https://github.com/theagenticage/hercule/issues/801), [ADR 0046](../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md).)* An entry may carry `signalId`: the Intake signal the user handed to an agent. `signal.handOff` appends it together with the `runId` of the run it started and, when the signal has them, the `ref` (the signal's thread ref) and the `eventId` (the signal's origin event), stamped `user` ([./10](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)). So an entry with a `signalId` is the explicit fact "this Task was handed off from that signal", and each handoff is one entry. Intake's Tracking lists the Tasks that have such an entry ([./17](./17-desktop-app.md#intake)). Only `signal.handOff` writes `signalId`; no other path does. It writes through one narrow, user-only path of the tasks domain: a new Task is created at stage `building` (status `in-progress`) with its entry in one write (one `task.created` event that carries the entry), and an existing Task gets the entry and the status `in-progress` in one update (one `task.updated`), as a legacy status write: a Task already `in-progress` keeps its stage, and any other goes to `building`. `task.create` and `task.update` refuse an entry with a `signalId`. A ref in the entry is what lets a later signal about the same thing find the Task, so handing that signal off continues it. The entries that name a signal are indexed by Task and time (`task_provenance_handoff`), so `task.query` finds the Tasks with a handoff entry in one read, and Tracking reads a Task's newest handoffs without reading the older ones. Tracking itself reads `task.queryTracking` ([./11](./11-public-api-and-agent-surface.md#task)): the in-progress Tasks with a handoff entry, each with its newest handoffs (at most 10) and its newest run and newest live run.

### External Ref canonical form

An External Ref is a fully-qualified canonical identifier for a thing outside Hercule. Examples: `github:issue:owner/repo#42`, `gmail:thread:<id>`, `sentry:issue:123`.

- The plugin that defines the ref type owns canonicalization. Two events about the same external thing MUST produce byte-identical refs.
- The Connection an event arrived through is **not** part of the identity. The same GitHub issue seen through two connections yields one ref.
- Refs are **not unique across tasks.** Several tasks may carry the same ref. The `task.query` guard convention treats "any *open* task with this ref" as ~~the duplicate signal~~ a later event about the same thing, so a closed task does not block a new one for a ~~recurring signal~~ recurring event *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)*.
- A ref is an identity, not a location. The URL used for "Open in <system>" is the event envelope's `url` field ([./08](./08-events-and-connections.md)), not part of provenance.

For systems with no plugin in v1 (Sentry, Tailscale, Hetzner notices arriving through Gmail), the core pins only the **grammar** - `<system>:<kind>:<identity>`, lowercase system, no whitespace - and validates it at write. The gmail plugin's sender rules stamp `system` only ([./08-events-and-connections.md](./08-events-and-connections.md) section 5.2); the **triage agent owns identity extraction**, guided by worked per-system examples in the triage skill and by checking existing refs (`task.query`) before minting one. When a real plugin for such a system lands post-v1, it takes ownership of its prefix; the grammar keeps old refs valid.

### What `task.query` matches

`task.query` performs exact identity matching only: a provenance ref (string equality on the canonical form), labels, stage, status, `projectId`, and *(added 2026-10-20, [#801](https://github.com/theagenticage/hercule/issues/801))* whether the Task has a handoff entry (a provenance entry with a `signalId`). It never matches content. An agent's `hercule task search` adds full text on top of the same filters (see [Search](#search)).

## Relations: project, runs, sessions

- **Project:** at most one per task, via `projectId`. Optional. Project is defined in [./02](./02-domain-model.md). A task keeps its `projectId` when the project is soft-deleted.
- **Runs and sessions:** a task holds no run or session ids. The links live on the run and session side (all links optional for runs and for Agents' sessions, per the work triangle in [./02](./02-domain-model.md); a Thread always has one, see [Threads and their Tasks](#threads-and-their-tasks)); a task's run list is derived by querying runs that reference it, and its session list by querying sessions with `taskId`. Provenance may additionally record a `runId` for a run that created or touched the task, but that is a history entry, not the link.
  - *(Amended 2026-10-20, [#801](https://github.com/theagenticage/hercule/issues/801).)* A run links to its Task by `taskId` ([./07-workflows.md](./07-workflows.md)). Only a handoff sets it, so the Tasks that have runs are the handed-off ones. A task's runs are `run.query` with `taskIds`; Tracking reads them that way and works out each Task's state from them.

## Entity links

*(Added 2026-11-07, [#1032](https://github.com/theagenticage/hercule/issues/1032); [ADR 0054](../adr/0054-external-entities-are-durable-records-kept-true-by-polls.md).)* A Task relates to outside things through links. The things themselves are External Entities ([./20-external-entities.md](./20-external-entities.md)). Provenance stays the append-only history, and the link is the relation.

```sql
task_entity_links (task_id, ref, linked_at, linked_by, following INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (task_id, ref))  -- index on (ref, linked_at, task_id)
```

- **It keys on the ref,** not on an entity id. So the tasks domain imports nothing of External Entities, and a link outlives the pruning of its entity.
- **One Task may link many refs, and one ref may be linked by many Tasks** over time. A ref stays non-unique across Tasks.
- **Who writes a link.** `insertTask` and `updateTask` write a link for each provenance entry with a `ref`, in the same transaction, so a hand-off and an agent's `--ref` both link. `externalEntity.takeOn` and `externalEntity.addToWork` write one too, through two user-only `TaskService` methods: one creates a Task linked to a ref inside the caller's transaction, and one deletes a Task only when it is untouched since it was created ([./20-external-entities.md](./20-external-entities.md#9-operations)). A link has `linked_at` and `linked_by` (an actor). `following` is set by `addToWork` only.
- **The backfill.** The migration creates a link for each provenance entry with a `ref` of every Task that is not deleted. The oldest entry of each (Task, ref) pair gives `linked_at` and `linked_by`.
- **The active Task of a ref** is the live Task with the lowest `(linked_at, task_id)`: not `done`, not `dropped`, not deleted and not merged. It is the oldest, so a summary or any other update can never change the answer. One tasks-domain query holds the rule, and everything that needs "the Task of this ref" uses it:
  - Intake's hand-off. The signal's Describe Line and `signal.handOff` both name the active Task of the signal's thread ref and continue it. This replaces the rule "the open Task updated most recently" ([ADR 0046](../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md)).
  - An entity's `taskId`, its side on the Inbox, the Inbox count and the Add sheet's "on Work" mark.
- **Merging, summaries and the details pane** arrive with [#1031](https://github.com/theagenticage/hercule/issues/1031), a slice that can land before or after this one. Whichever lands second writes these rules into its own change, and they are stated here so both agree:
  - `task.merge` moves the links of the merged Task to the survivor without duplicates. When both Tasks link a ref, one link stays, with the older `linked_at`, and `following` if either had it.
  - Every writer of a link resolves a merged Task id to its survivor at its final write. `undoTakeOn` reads the Task by its own id and refuses a merged one. A merged Task is not live.
  - The summary's input gains each linked entity's kind, identifier, title, status and lifecycle. A link added or removed, or a change to a linked entity's title, status or lifecycle, marks the Task's summary dirty in the same transaction. `TaskDetail` carries `entities`, `places` and `edges`.
- **The board.** A `WorkCard` carries `entityMarks` and `contextRefs`, and `task.queryBoard` carries `places`, `edges`, `groupings` and `contextComplete` ([./20-external-entities.md](./20-external-entities.md#11-works-context)). A Task is matched to a place through its own links and upward `part of` only. Filtering or grouping by an outside place never sets a Task's `projectId` or `initiativeId`.

## Threads and their Tasks

*(Added 2026-11-07, [#1029](https://github.com/theagenticage/hercule/issues/1029), [ADR 0052](../adr/0052-tasks-have-a-stage-and-threads-join-them.md).)* Every Thread belongs to one Task, so the Work overview can show every Thread on a card. The link is the Session's `taskId` ([./02](./02-domain-model.md)). An Agent's session joins a Task when it can, so a reviewer lands on the card of the implementer it reviews. An Assistant's session never has one.

### Which Task a session gets

When the controller writes a session, it gives the session a Task. It takes the first source that gives one:

| # | Source | Thread | Agent's session | Run step session | Assistant session |
|---|---|---|---|---|---|
| 1 | The `taskId` named in the spawn | yes | yes | | |
| 2 | The caller's Task (the `session:<id>` that spawned it), or a fork's parent's Task | yes | yes | | |
| 3 | The live Task of its workspace (below) | yes | yes | | |
| 4 | A new Task | yes | never | | |
| | Its run's `taskId` | | | yes | |
| | Nothing | | | | always |

Rules:

- **A Thread always ends up with a Task.** An Agent's session never creates one: it takes row 1, 2 or 3 and otherwise has none.
- **A live Task** is one that is not deleted and whose stage is not `done` or `dropped`.
- **Row 1 is explicit, so it can be refused.** A `taskId` that names no Task, or a deleted one, fails `not_found`. A Task at `done` or `dropped` fails `invalid_state`, and the message tells the caller to reopen the Task or start without it. Starting new work on a finished Task is a contradiction, and the caller should hear about it.
- **Rows 2 and 3 are implicit, so they never refuse.** They give a live Task or nothing. A caller or a fork's parent whose Task is finished, deleted or missing gives nothing, and the next row decides. This one rule serves spawn, fork and reopen.
- **A run step's session takes its run's `taskId` as it is,** even when that Task is finished, and the run may have none. It does not go through rows 1 to 4 and does not write `task_workspaces`. A Thread that step starts can then inherit the Task by row 2. A fork of a run step's session is an Agent's session, not a run step, so it follows rows 2 and 3.
- **A new Task** (row 4) takes the session's title, stage `exploring`, priority `normal` and the session's project, when that project still exists. A fork can carry a project that was deleted, and a Task cannot name one, so the project is left out then. A Task's title is never empty, so a session with a blank title gets a Task titled `Untitled thread`.
- **The actor.** The Task made for a Thread is stamped with the actor behind the spawn or the reopen, and `task.created` fires for it ([Platform events](#platform-events)). When a matched event wakes the Thread (below), no request is behind it, so that actor is the system.
- **No grant is checked.** Starting a Thread was already allowed by `session.spawn`, and the Task follows from it.
- **The rule belongs to the tasks domain.** The rule and every write to a Task stay in the tasks domain (`TaskService.joinSession` and `rejoinThread`); the sessions domain only calls it. The rule takes plain values: the ids the spawn named, the session's kind, title and project, and its workspace's id. It reads the workspace's kind from the database, as the tasks domain reads `projects` to check a project id.
- **It is atomic.** The session store (`sessions.create`) runs the rule inside its transaction, just before it writes the session. So the Task is chosen in the same transaction as the session's write and the check that stops a retried call from placing a second session ([./11](./11-public-api-and-agent-surface.md) section 2, "Retrying a call"). A retried spawn makes no second Task. Writes are serial, so two first Threads started at once in one workspace run one after the other, and the second finds the first's row.
- **A join adds no provenance entry.** The link lives on the session, as links do ([Relations](#relations-project-runs-sessions)).

### A workspace's Task

A workspace's Task is an explicit row, never "the most recent session in this workspace". The `task_workspaces` table, owned by the tasks domain, holds `workspace_id` (the primary key), `task_id` and `joined_at`. Both ids are plain values, with no foreign key.

- **Reading (row 3).** The row's Task is accepted only when it is live. A row that points at a finished or deleted Task is ignored and then replaced by the next session that joins a Task, so reusing a folder after its Task is Done starts a new Task.
- **Writing.** A row is written when a session joins a Task in an ephemeral workspace and the workspace has no row with a live Task. Keeping a Task is not joining: a Thread taken off Done that keeps its live Task writes no row.
- **A main workspace never gets a row.** The row is written only when the workspace's kind is ephemeral, and the tasks domain reads that kind itself when it writes the row; a main workspace therefore has no row to read either. It is long-lived and shared by whatever runs in it, so sharing one says nothing about being the same work. This limits the inference only: rows 1 and 2 still apply, so a Thread in a main workspace gets row 1, 2 or 4. A workspace-less session has no row to read either.

### Taking a Thread off Done

When a Done Thread is taken off Done, by `session.reopen` or by a new input, and it has no live Task (none, a finished one or a deleted one), it runs rows 3 and 4. Coming back after the user closed the Task is new work, so it joins a live Task of its workspace or gets a new one. A Thread whose Task is still live keeps it, and that writes no `task_workspaces` row, because keeping is not joining.

A new input can take a Thread off Done with no request behind it, when a session subscription's matched event wakes it ([./11](./11-public-api-and-agent-surface.md) section 7). The Task made then is stamped with the system actor, as the rule above says.

### A resume is not a join

An exited Thread that is not Done and is resumed in place by its next input keeps its `taskId`, whatever stage its Task is at. So a Thread that was never marked Done stays on a finished Task.

### The Task's title follows the Thread's

A Thread's title may be replaced once by a generated one ([./02](./02-domain-model.md), the Session's `title`). The Task made for that Thread takes the generated title too, so the card does not keep the cut-short one. It changes only when all of these hold:

- the Task is the one made for this Thread (row 4), not one the Thread joined, because a joined Task's title is not this Thread's to change;
- the Thread still belongs to that Task when the generated title arrives;
- the Task is live; and
- the Task's title still equals the cut-short title, so a title the user renamed is left alone.

The rename is an ordinary Task update, stamped with the system actor because it runs after the request has finished. It happens in the same transaction as the Thread's own title change, so a failed rename leaves both titles as they were. The cut-short title to compare with is the Thread's title just before that change, because a Thread's title changes only through the generated title.

### Threads that exist at the upgrade

The migration that adds `taskId` to sessions gives the Threads that are neither Done nor Archived a Task, so the board is not empty after the upgrade:

- Threads in the same ephemeral workspace share one new Task, and a `task_workspaces` row records it. A Thread in a main workspace, or with no workspace, gets a Task of its own.
- The Task takes its title, project and timestamps from the oldest Thread of its group, with stage `exploring` and priority `normal`. A blank title becomes `Untitled thread`.
- The Agent sessions of those Threads that are not archived join the same Task, and run step sessions take their run's `taskId` where the run has one.
- Done and Archived Threads stay without a Task. Reopening one joins by the rules above.
- The migration emits no events, so no workflow starts for an old Thread and the event log gains no false `task.created`.

## The board

*(Added 2026-11-07, [#1030](https://github.com/theagenticage/hercule/issues/1030).)* Work draws every unfinished Task as a card: a Task at one of the five stages from `exploring` to `landed`, not deleted. `done` and `dropped` are ends, and the board has no column for them.

**A cell and `boardRank`.** A cell is one project and one stage (a Task with no project is in the "No project" lane). The Task has a `boardRank`, a string that orders its cell: compare it as a string, and never show it. It is a fractional index, so a move normally writes one row: `chooseRankBetween(before, after)` returns a rank strictly between two others, and a cell whose ranks grow too long is spread again inside the move that needs it. The rules:

- A Task that arrives by itself (a new Task, a Thread that makes one) goes last in its cell, so nothing the user is looking at moves.
- A stage change by anything but `task.move` (`task.update`, a workflow) also puts the Task last in its new cell.
- `task.move` is the one operation that picks a place. It writes the stage, the project and the rank in one `task.updated`, so `changes.boardRank` is reported beside `changes.stage` and `changes.projectId`. A move inside a column reports `changes.boardRank` alone, so a trigger on `changes.stage` or `changes.status` does not see it.
- The board reads in order of project, then stage, then `boardRank`. Nothing on Work sorts by recent activity, and a card stays where the user left it.

**What a card shows.** Three facts, each worked out on the controller from real rows. They are independent: a card can hold all three, there is no precedence between them, and no field combines them.

- **`openQuestion`, the one meaning of "wants you".** A session of the Task with kind `thread` has an open Request of kind `question`, asked by the Thread's own agent or by a subagent inside the Thread, parked or async. With several, the session opened first wins, then the first question in its open Requests. The card holds the session, the Request and the first question's text, cut to `MAX_CARD_QUESTION` (300 characters).
- **`failure`.** The Task's stored failed run is set. It stays until it ends and is never hidden by an open question or a live session.
- **`workingSessionId`.** A session of the Task, of any kind, is `queued`, `starting` or `busy`.

Nothing else sets `openQuestion`. An approval, a Permission Request, a signal, a summary, a finished run, and a question in a session of kind `agent` or `run` leave it unset. They keep the surfaces they already have. A finished or stopped run is not a state of the card.

`openSessionId` is the session a click opens: the Thread with the open question, else the Task's newest session. It is for navigation only, never the destination of an answer.

Reads and moves: `task.queryBoard` and `task.move` ([./11](./11-public-api-and-agent-surface.md#task)).

## Platform events

Task mutations emit platform events into the one persisted event pipeline ([./08](./08-events-and-connections.md)). They are the trigger surface for work workflows. The actor of the mutation is carried once, on the event envelope's `actor` field ([./08](./08-events-and-connections.md)); the payloads below do not duplicate it.

*(Amended 2026-09-27, [#81](https://github.com/theagenticage/hercule/issues/81).)* Until this change, `task.created` and `task.updated` were written as audit entries. The event router never evaluates audit entries, so no trigger or subscription could see them. They are platform events now: routed, with the actor still on the envelope and the payloads unchanged, in the same log. `task.deleted` is still written as an audit entry only, so nothing can wait on it yet ([./08](./08-events-and-connections.md) section 2).

**`task.created`** carries a full snapshot, the stage included:

```ts
interface TaskCreatedPayload {
  task: Task;
}
```

*(Added 2026-11-07, [#1029](https://github.com/theagenticage/hercule/issues/1029).)* `task.created` fires for every Task the core makes for a Thread too, so it fires once per Thread that starts a Task of its own. A trigger on a bare `task.created` therefore starts a run for each new Thread. A workflow that listens to it MUST filter on what it cares about (a label, a project, the actor on the envelope). No shipped workflow listens to `task.created`. The title of a Task made for a Thread comes from the Thread's prompt, so it is untrusted text: a workflow must treat `event.payload.task.title` as data, and never as an instruction to follow.

**`task.updated`** carries per-field diffs, so a CEL filter routes without fetch-and-compare:

```ts
interface TaskUpdatedPayload {
  taskId: string;
  changes: {
    // scalar fields: title, description, stage, status, priority, projectId, boardRank
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
- A provenance-only append fires `task.updated` too. Shipped workflow defaults MUST filter on the fields they care about (for example `has(event.payload.changes.status)`) rather than on the bare event kind, and thereby demonstrate field-filtering.
- *(Added 2026-11-07, [#1029](https://github.com/theagenticage/hercule/issues/1029).)* `changes.stage` appears for every stage change, and `changes.status` whenever the coarse status changes ([Status axis and lifecycle](#status-axis-and-lifecycle)). A change of stage inside one status reports `changes.stage` alone.
- Example CEL filters: `event.payload.changes.status.new == "done"`, `has(event.payload.changes.status)`, `event.payload.changes.stage.new == "in-review"`, ~~`"proposed" in event.changes.labels.removed`~~ `"ready-for-agent" in event.payload.changes.labels.added` *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): `proposed` is retired.)*. The payload sits under `event.payload` in the CEL context, so a change to a Task is read at `event.payload.changes` ([./08](./08-events-and-connections.md) and the CEL context in [./07](./07-workflows.md)).

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
| `refs`, `labels`, `stage`, `status`, `projectId` | exact identity; `refs` against the canonical External Ref form |
| `handedOff` | *(Added 2026-10-20, [#801](https://github.com/theagenticage/hercule/issues/801).)* A boolean. `true` keeps the Tasks that have a provenance entry with a `signalId`; `false` keeps the Tasks that have none. Absent, it filters nothing |
| `text` | SQLite FTS over `title` + `description` only; labels and refs are never reached through FTS |

Within one field the listed values are **any-of**; across fields the filter is **and**; no filters lists every task. No `or` across fields and no negation in v1. Pagination and sorting follow [./11](./11-public-api-and-agent-surface.md) section 1.6.

The FTS5 table is external-content over `tasks` with the tokenizer `unicode61 remove_diacritics 2`, so a search matches regardless of case and diacritics (`cafe` finds `Café`). **Callers pass plain words.** The service splits `text` on whitespace, quotes each token and joins the tokens with `AND` to build the `MATCH` expression; raw FTS5 `MATCH` syntax is never exposed, so `AND OR "(` is four words to search for rather than a syntax error. A text holding no letter or digit matches nothing and is not an error, because the index holds no punctuation either.

**Order.** With `text` the order is relevance (`bm25` ascending) and the walk pages by offset. With `text` and an explicit `sort`, `task.query` fails `validation` naming both: honouring both would pick one of two paging strategies per request, and ignoring the sort would be a silent substitution. ~~Without `text` the order is keyset over `updatedAt`, `createdAt`, `priority` or `status`, default `updatedAt desc`.~~ *(Amended 2026-10-03, [#300](https://github.com/theagenticage/hercule/issues/300).)* Without `text` the order is keyset over one or more of `updatedAt`, `createdAt`, `priority` and `status` ([./11](./11-public-api-and-agent-surface.md) section 1.6), default `updatedAt desc`. `priority` ascends low, normal, high, urgent; `status` ascends open, in-progress, done, cancelled.

*(Added 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395); decided by [#393](https://github.com/theagenticage/hercule/issues/393).)* Event search is the named exception to relevance order. `event.query` with `text` searches the envelope's `title` and `author` with the same tokenizer, but returns events newest first and pages by keyset, because a user looking for an event remembers roughly when it came ([./04](./04-state-store.md#event-search), [./11](./11-public-api-and-agent-surface.md#event)).

No vector search and no embeddings. The semantic part of triage - grouping heterogeneous ~~signals~~ events *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)*, spotting connections - is the agent iterating its own queries and reading results; that is why agent task search is a hard v1 requirement (ticket #16 handoff).

## Delete

Delete is **soft** (resolved 2026-09-01, [Domain model residue](https://github.com/theagenticage/hercule/issues/46), amending ticket 29's hard delete): `task.delete` sets `deletedAt`; the row and its provenance stay. A deleted task answers `not_found` on `task.read`, is excluded from `task.query` (no include-deleted option in v1) and from search, and emits `task.deleted { taskId, snapshot }` with the final row, since nothing can read it afterwards. The core withdraws open Notifications whose subject is the task ([./10](./10-triage-intake-and-notifications.md)); Runs and Sessions keep their `taskId`. A deleted Task is never joined again: the join rules skip it ([Threads and their Tasks](#threads-and-their-tasks)). The event log keeps the audit trail of everything that happened before deletion (the event log is the audit log, [./13](./13-security.md)); the events the task referenced stop being protected from pruning ([./04](./04-state-store.md) Retention). Use `cancelled` for work that was decided against; delete only what should never have existed. Pruning deleted tasks outright, with their runs, is post-v1.

Delete is a public-API operation ([./11](./11-public-api-and-agent-surface.md)). The shipped `worker` profile grants task read/create/update and not delete (ticket 18; verb split in [./13](./13-security.md)).

## API operations an agent uses

Task operations are ordinary public-API operations defined in the service layer and contract package, reachable over HTTP and through the `hercule` CLI ([./11](./11-public-api-and-agent-surface.md), [ADR 0013](../adr/0013-agents-operate-hercule-through-the-public-api.md)). Available to any permission profile granting the `task` family; the shipped profiles and their verbs are in [./13](./13-security.md) (both `assistant` and `worker` grant task read/create/update).

| CLI | Operation |
|---|---|
| `hercule task query` | structured filters + FTS, returns matching tasks; no filters lists all |
| `hercule task read <id>` | one task, full row including provenance |
| `hercule task create` | creates a task; emits `task.created` |
| `hercule task update <id>` | changes any writable field, adds/removes labels, appends provenance; emits one `task.updated` |
| `hercule task board` | every unfinished Task as a card for Work ([The board](#the-board)); needs `task.read`, `session.read` and `run.read` |
| `hercule task move <id>` | moves a Task to a stage, a project or a place in its cell; grant `task.update`; emits one `task.updated` |
| `hercule task delete <id>` | soft delete ([Delete](#delete)); grant `task.delete` |

Every mutation is stamped with the calling actor (`user`, `session:<id>`, `run:<id>` or `plugin:<id>`) on the event envelope; a provenance entry appended by the call carries the same actor. All operations return fast; nothing blocks.

~~Notification actions that bind a task operation ("Start Bugfix" = start workflow X with task Y) are owned by [./10](./10-triage-intake-and-notifications.md).~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395), [#391](https://github.com/theagenticage/hercule/issues/391), [#392](https://github.com/theagenticage/hercule/issues/392).)* Bound actions that touch tasks are owned by [./10](./10-triage-intake-and-notifications.md): Accept on a proposal runs `task.create` ([§9.3](./10-triage-intake-and-notifications.md#93-core-kinds-and-signalraise)), and Hand to an agent runs `run.start` with a signal input ([§9.4](./10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent)). "Start *X*" on a proposal is dropped, because the Task does not exist yet.

## Built-in workflow actions on tasks

Three of the ~~five~~ six *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): `signal.screen` joined them.)* built-in actions that are operations act on tasks: `task.create` (agent-less graphs, "every cron tick, file a task"), `task.update` (the closing step of the done-means-merged convention), and `task.query` (exact identity matching; the guard-before-agent pattern that routes ~~duplicate signals~~ later events about the same thing *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395).)* to `task.update` without spawning an agent, [./10](./10-triage-intake-and-notifications.md)). Their parameters and outputs are defined once in [./07](./07-workflows.md#8-built-in-actions). They call the same service layer as the API and so emit the same platform events.

An in-run action step stamps `run:<runId>` and is ungated: the recipe is the user's ([./11](./11-public-api-and-agent-surface.md) section 3.1).

## Presentation over the stage

Kanban-style groupings, columns, swimlanes~~, and the Intake tiers~~ *(Amended 2026-10-10, [#395](https://github.com/theagenticage/hercule/issues/395): the Intake tiers are retired.)* are presentation-layer constructs over the fixed stage axis, priority, and labels. *(Amended 2026-11-07, [#1029](https://github.com/theagenticage/hercule/issues/1029).)* The stages are the natural columns of a board, since a stage is the Task's position. A grouping is still not a domain state: the core stores no grouping, and no grouping may introduce a stage or a status. Where such groupings live and how they are configured is the client's concern ([./14](./14-web-app.md), [./17](./17-desktop-app.md)); the domain model provides only `stage`, `status`, `priority`, `labels`, and `projectId` to group by.

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
- [ADR 0052 - Tasks have a stage, and Threads join them](../adr/0052-tasks-have-a-stage-and-threads-join-them.md)
- [ADR 0040 - Intake holds Signals; Notifications are Hercule's own messages](../adr/0040-intake-holds-signals-notifications-are-hercules-own-messages.md)
