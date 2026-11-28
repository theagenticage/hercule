# 56. Initiatives and blockers are thin structure over Tasks

Date: 2026-11-08

## Status

Accepted by [Work overview: the design and its tickets (#1026)](https://github.com/theagenticage/hercule/issues/1026), built by [#1036](https://github.com/theagenticage/hercule/issues/1036). Amends [ADR 0019](./0019-the-task-model-is-thin-workflows-own-task-semantics.md), which rules out task dependencies, and [spec 09](../spec/09-tasks.md#not-in-v1) §Not in v1. Keeps [ADR 0052](./0052-tasks-have-a-stage-and-threads-join-them.md) true: the core never moves a stage on its own. Builds on [ADR 0054](./0054-external-entities-are-durable-records-kept-true-by-polls.md), which keeps an outside initiative apart from this one. The rules are in [spec 02](../spec/02-domain-model.md), [spec 09](../spec/09-tasks.md), [spec 11](../spec/11-public-api-and-agent-surface.md), [spec 14](../spec/14-web-app.md) and [spec 17](../spec/17-desktop-app.md).

## Context

Work shows Tasks as cards. Two things about a pile of cards have no home in the thin Task row:

- **Why a set of Tasks exists.** "Gift card refunds" is a lasting intent that cuts across projects and lives for weeks. A Project groups materials and a lane, a label is a bare string, and neither can carry a colour, a target, a close, or an honest "2 of 8 landed".
- **That one Task waits on another.** The user knows "Ship refund emails" cannot start before "Add a refund button" lands. Today that lives in their head, and the card gives no hint.

ADR 0019 left both out on purpose: "No subtasks, task dependencies, comment threads, or assignee in v1", with grouping done by shared labels, a shared project or provenance refs. The reason was to keep the core work-type-agnostic and to stop it growing a task engine. That reason still holds. The question is whether these two can be added without the core deciding anything.

Outside tools have initiatives too, such as a Linear initiative. Those belong to the source, and their progress is only what the source reports (ADR 0054). They must never be mistaken for the user's own.

## Decision

**An Initiative is the user's own lasting intent, held in a table of its own, and a Task has at most one. A blocker is one stored edge from a Task to the Task it waits on, and the edges always form a DAG. Both are facts the card draws. Neither gates anything.**

- **An Initiative is created and changed only by the user.** Its fields are a name, an intent, an optional target and target date, a hue, an optional project (the lane it draws in) and an optional `closedAt`. Every mutation is user-only, as `signal.handOff` is: a grant alone would let a session make one. The words are "Only the user creates and changes initiatives; a session can add a Task to one that exists." A session with `task.update` may still put a Task on an initiative that exists.
- **A Task has at most one Initiative,** stored as `tasks.initiative_id`. An Initiative may hold Tasks from several projects. A Task is drawn in one place only: on its Initiative's line, or in its lane.
- **Closing keeps membership.** Closing an Initiative sets `closedAt` and leaves every Task's `initiativeId` alone. A Task of a closed Initiative goes back to its lane on screen. Reopening brings the line back. Deleting is soft, and clears `initiativeId` on each of its Tasks in the same transaction.
- **Progress is the Initiative's own truth.** An Initiative is the user's, so its Tasks are the whole count: "2 of 8 landed". Landed counts Tasks at `landed` or `done`. The total leaves out `dropped`. This is the opposite of an outside project, whose progress is only what its source reports.
- **A blocker is one stored direction.** `task_blockers (task_id, blocked_by_task_id, created_at, created_by)`, owned by the tasks domain. "Blocks" is the inverse read of the same rows, never a second relation, so the two can never disagree.
- **The edges are always a DAG, checked in one writer transaction.** `task.addBlocker` looks for a path from the proposed blocker back to the Task with a recursive query over every stored edge, finished ones included, and inserts only if there is none. There is one writer connection, so two requests cannot each pass the check and together close a loop: the second runs after the first has committed. A refusal names the path, as in "Add a refund button already waits on this Task, through *Plan the rollout*." It is `invalid_state` with `details.reason` set to `blocker-cycle`, so a client never matches message text.
- **A finished blocker stops blocking, and the edge stays.** A blocker at `landed`, `done` or `dropped` no longer holds its dependents. The edge is history and stays readable and removable. If the blocker moves back to an earlier stage, it holds them again. The card is a reading of the current stages, never a stored flag.
- **Nothing is gated by a blocker.** The core gates nothing (ADR 0019). A blocked card can be dragged, started, marked Done. "Blocked" is a fact the card draws, like "has a question". A failure outranks it on screen, because the run needs the user either way.
- **A blocker reaches across projects.** The read gives both ends, so a project filter or a folded lane never hides why a card is blocked.
- **Deleting a Task removes its edges** in the same transaction and reports them in `changes.blockedBy.removed`, so a card is never held by a Task nobody can see. Undoing a handoff goes through the same delete, so it cleans too.
- **Merging Tasks moves the edges.** In the merge's one transaction, the source's edges are remapped onto the survivor in both directions, self edges and duplicates are removed, and a cycle across the remapped edges refuses the whole merge with nothing written. Merging two Tasks where one reaches the other through a third closes a loop, and is refused. A read-only `task.checkMerge` runs the same check, so the desktop app can say so before the drop. The survivor keeps its own Initiative; with none, it takes the source's.
- **An outside initiative is an External Entity.** It is only ever a lane or a filter, under its own caption such as "Linear initiative", and filtering by one never sets `initiativeId`.
- **The colour carries no meaning.** The hue comes from a fixed list that keeps away from marigold (something needs you) and tomato (something got hurt). With no hue given, create takes the least used.

## Considered options

- **An Initiative as a label.** Rejected. A label is a bare string created implicitly, so a typo makes a new Initiative and a session could make one. It has no colour, no target, no close and no truthful count.
- **An Initiative as a Project.** Rejected. A Project groups materials and spans Resources, and it is the lane a card sits in. An Initiative cuts across projects. One record doing both would make every Project carry a target and a close, and every lane an optional second meaning.
- **Many Initiatives per Task.** Rejected. A Task would draw in several places, and "2 of 8 landed" would count the same Task twice. One column is also simpler than a join table.
- **Let agents create Initiatives.** Rejected. An Initiative is what the user wants, not what the system finds. Triage already decides what becomes a Task; it does not decide the user's lasting intents.
- **Store both directions of a blocker.** Rejected. Two relations can disagree, and every write would need two rows.
- **Allow cycles and detect them on read.** Rejected. Every reader would need cycle handling, and a cycle would silently hold two cards for ever. One writer makes the check at write time cheap and exact.
- **Delete the edge when the blocker lands.** Rejected. The card would not come back to blocked if the blocker moves back, and the history of what waited on what would be lost.
- **Gate operations on a blocker.** Rejected, as in ADR 0019 and ADR 0052. Refusing a drag, a start or a Done would make the core decide what blocked means, and the user could not override it.
- **Make a Follow-up a kind of blocker.** Not done. A Follow-up is "do this after", not "this waits". It stays outside the glossary's Blocker, and is not built.
- **Build blockers on the relation claims between External Entities.** Rejected. Those claims are what outside sources say about their own things, and the user cannot write them. A blocker is the user's statement about their own Tasks.
- **Let the client check for cycles.** Rejected as the decider. Two clients could each pass. The desktop pre-check is advice; the server's refusal decides.

## Consequences

- New tables `initiatives` and `task_blockers`, and a column `tasks.initiative_id` with an index. The migration `initiatives-and-blockers` only adds, so it needs no upgrade fixture.
- A new domain `initiatives`, which imports `tasks`. `tasks` never imports it back: it checks that an Initiative exists by a plain read of the table, as it does for projects. Deleting an Initiative calls `TaskService.clearInitiative` inside its own transaction.
- A new contract group `initiative`, reusing the `task` grant family (`task.read` to read, `task.update` to write) so there is no grants migration. New task operations `task.addBlocker`, `task.removeBlocker` and `task.checkMerge`. `task.update`, `task.create` and `task.move` take `initiativeId`. `task.updated` reports `changes.initiativeId` and `changes.blockedBy`.
- `WorkCard` gains `initiativeId`, `blockedBy` and `blockedByCount`, counting only blockers that still block. `task.queryBoard` gains `initiativeDoneCounts`, because a Done Task has no card but still counts as landed. `TaskDetail` gains `blockers` and `blocks`, with every edge of any stage.
- A new live topic `initiative`. A blocker change announces `task` for both ends.
- ADR 0019's sentence "No subtasks, task dependencies, ..." now reads: no subtasks, comments or assignee. Task dependencies exist as blockers, and only as a fact the card draws.
- The closed check is narrow on purpose: a write that changes a Task to a closed Initiative fails with `invalid_state`, and an unrelated update of a Task already on a closed Initiative never does.
- A Done Task draws as a ring in the Landed cell of its Initiative's line, so the beads and the count agree and progress never shrinks.
- A hard rule for later work: nothing may use a blocker or an Initiative to refuse an operation, and nothing may create an Initiative except the user.
- Measuring is left to [#1047](https://github.com/theagenticage/hercule/issues/1047), as for the other slices of this map.
