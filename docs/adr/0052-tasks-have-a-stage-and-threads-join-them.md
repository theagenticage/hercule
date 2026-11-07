# 52. Tasks have a stage, and Threads join them

Date: 2026-11-07

## Status

Accepted by [Work overview: the design and its tickets (#1026)](https://github.com/theagenticage/hercule/issues/1026), built first by [#1029](https://github.com/theagenticage/hercule/issues/1029). Amends [ADR 0019](./0019-the-task-model-is-thin-workflows-own-task-semantics.md), which gave a Task one four-value `status` and said the core never decides when a Task moves.

## Context

The Work overview shows Tasks as cards in columns. Four statuses are too coarse for that: `in-progress` cannot tell a Task being built from one waiting for review or one already merged. The overview also needs every Thread to sit on a card, and today a Thread belongs to no Task unless a handoff made one.

ADR 0019 is right that the core should not run a state machine. It does not say how finely a Task's position may be recorded, and it does not forbid the core from creating a Task.

`status` cannot simply be replaced. Its values are stored outside the `tasks` table: in workflow YAML, in frozen run plans, in open bound answers and in old event payloads. A run that sends an unknown field fails when its step's input decodes. Dropping the column also means rebuilding `tasks`, because a generated sort rank reads it and `task_provenance` has a foreign key to the table.

## Decision

**A Task has a `stage`, a fixed list of seven values. `status` stays and becomes a coarse reading of the stage. Every Thread joins a Task when it is written.**

- **Stage.** `exploring`, `planned`, `building`, `in-review`, `landed`, `done`, `dropped`. Any stage can follow any other. The list is fixed: users do not define stages.
- **The core still never moves a stage on its own.** A `task.update`, by the user, an agent or a workflow, is the only way a stage changes. There is one exception: the core creates a Task for a Thread that has none to join, at `exploring`. That is creating a row, not deciding that work has progressed.
- **Status is a reading.** It is worked out from the stage (`exploring` and `planned` give `open`, `building`, `in-review` and `landed` give `in-progress`, `done` gives `done`, `dropped` gives `cancelled`) and is written only from the stage. It stays because "is it finished?" is still a useful question for `task.query` and for CEL, and because everything that stored a status keeps working.
- **A legacy status write keeps working.** `task.update { status }` picks a stage only when the status does not already match the current one, so `in-progress` sent to a Task at `in-review` changes nothing. Sending `stage` and `status` together is refused.
- **`task.updated` reports both.** `changes.status` appears whenever the coarse status changes, so a stored trigger on `event.payload.changes.status` fires as before. `changes.stage` appears for every stage change.
- **A Thread always has a Task.** When a session is written, it takes the first of: the Task the caller named, the Task of the session that started it (or of the session it forks), the live Task of its workspace, a new Task. An Agent's session joins a Task when it can and never creates one. An Assistant's session never has one. A run step's session takes its run's Task.
- **A workspace has a Task only if it is ephemeral.** The link is an explicit row (`task_workspaces`) written when a session joins a Task in an ephemeral workspace. It is never "the latest session in this workspace".
- **A main workspace has no Task.** A main workspace is long-lived and shared by whatever runs in it. Two Threads that ran in the same one are not the same piece of work, so sharing it says nothing. A Thread in a main workspace still joins a Task it names, or its caller's, or gets a new one.

The exact rules, and what happens to Threads that already exist, are in [spec 09](../spec/09-tasks.md).

## Considered options

- **Replace `status` with `stage`.** Rejected: stored workflows, frozen plans, open answers and old events would stop working, and `tasks` would need a rebuild. A coarse reading costs one derived value and keeps all of them.
- **Let the user define stages.** Rejected: workflows and clients need a closed set to write against, and the coarse reading needs a known mapping. Presentation can still group differently.
- **Move stages automatically when a session or run starts, ends or merges.** Rejected, as in ADR 0019: it would make the optional links between Task, run and session load-bearing. The core only creates the Task. Facts that move a stage later belong to workflows.
- **Join a Task by "the most recent session in this workspace".** Rejected: it is a guess that changes as sessions come and go. An explicit row says which Task a workspace belongs to, and a finished Task releases it.
- **Give a main workspace a Task like an ephemeral one.** Rejected, as above: the only thing two Threads in a main workspace share is the folder.
- **Create Tasks for Agent sessions too.** Rejected: an implementer's reviewer belongs on the implementer's card. A card of its own would show a helper as a piece of work.

## Consequences

- Every Task row has a `stage` and a `stageChangedAt`. `status` is never written by hand.
- Every new Thread creates a `task.created` event unless it joins a Task. A bare `task.created` trigger now fires once per Thread, so a workflow that listens to it must filter. No shipped workflow does.
- A Thread started on a finished Task is refused when it names that Task, and gets a new Task when the Task was only inferred. Starting new work on a finished Task is a contradiction the caller should hear about; inferring one is not a request, so it falls through.
- Reusing a folder after its Task is Done starts a new Task, because the old link points at a finished Task.
- Taking a Done Thread off Done can create a Task too, when the Thread has none or its Task is finished. A matched event can do that with no request behind it, so that Task is stamped with the system actor.
- A harness resume is not a join. A Thread that was never marked Done keeps its Task, whatever stage the Task is at.
- The tasks domain gains the rule that decides a session's Task. It takes plain values (ids, the session's title and project, the workspace's id) and reads the workspace's kind from the database, as the tasks repository reads `projects`. The sessions domain depends on tasks: `sessions.create` runs the rule inside its transaction, and reopening a Thread calls it. All Task writes stay in the tasks domain. The tasks domain reaches sessions only through a port.
- Threads that exist at the upgrade and are not Done or Archived get Tasks in the migration, with no events, so no workflow starts for them.
- Removing `status` altogether stays possible later. It is a separate decision, and needs the stored values to be rewritten first.

## Note: what a card shows, and who decides it

*(Added 2026-11-07, [#1030](https://github.com/theagenticage/hercule/issues/1030); the direction of [#823](https://github.com/theagenticage/hercule/issues/823).)* Work draws a Task as a card. Three facts about the card come from sessions and runs, not from the Task row: a Thread has an open question, the Task has a failed run, and a session is working on it. This note settles who works them out. It changes nothing above.

- **The controller decides what a card shows.** It works the three facts out from real rows, in one place, and sends them on the card. A client does not join sessions, requests and runs to guess them. That is the end of the client-side joins #823 describes.
- **"Wants you" means a Thread's open question, and nothing else.** A Thread of the Task has an open Request of kind `question`, asked by its own agent or by a subagent inside the Thread. An approval, a Permission Request, a signal, a summary, a finished run and a question in a session of kind `agent` or `run` do not set it. They keep the surfaces they already have. One meaning means a card can carry it, a filter can count it, and the user is never asked to tell two kinds of "waiting" apart.
- **Clients keep only the words.** A client chooses how a fact reads, such as the question on the card's second line or "*Review PR* failed: *cause*", and nothing about whether the fact is true.
- **The three facts are independent.** A card can show all of them, and there is no precedence between them and no combined field.

The exact rules are in [spec 09](../spec/09-tasks.md#the-board), and how the desktop app draws them is in [spec 17](../spec/17-desktop-app.md#work).
