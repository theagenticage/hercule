# 46. Handing a signal off tracks the work on a Task

Date: 2026-10-19

## Status

Accepted. Decided in the map [Tracking: follow handed-off work in Intake (#797)](https://github.com/theagenticage/hercule/issues/797), from the prototypes on the branch [`prototype/stay-in-the-loop`](https://github.com/theagenticage/hercule/tree/prototype/stay-in-the-loop/docs/design/stay-in-the-loop). Its slices write it into specs 02, 07, 09, 10, 11 and 17. Amends [spec 10 §9.4](../spec/10-triage-intake-and-notifications.md#94-actions-done-and-hand-to-an-agent): the core's Hand to an agent answers bind `signal.handOff` in place of `run.start`. Keeps [ADR 0019](./0019-the-task-model-is-thin-workflows-own-task-semantics.md) and [ADR 0040](./0040-intake-holds-signals-notifications-are-hercules-own-messages.md).

## Context

When the user hands an Intake signal to an agent, the signal leaves To do at the click ([spec 10 §9.6](../spec/10-triage-intake-and-notifications.md#96-when-a-signal-leaves)), and nothing comes back. Whether the run finished, what it did, and whether it failed sit on a run page, in a transcript, or in a Check-in the desktop app does not have. The user hands work off and then checks on all of it by hand.

A handoff is often the start of a chain, not one run. A Linear issue goes to Implement; Implement opens a PR; checks fail on the PR, which raises a signal; the user hands that signal to Fix bug. Each step may go to a different workflow, because every workflow that takes a signal's kind is offered on it.

Four designs were prototyped. The one chosen, Round Trip, brought each result back to To do as a new signal. Working that into the model showed where the follow-up must not live:

- **Not on the Signal.** A signal is a snapshot that resolves once (spec 10 §9.1). Giving it a lifecycle (working, landed, attempt 2) breaks that.
- **Not on the run.** One run cannot carry a chain whose steps go to different workflows, so a run that waits for the user's answer solves the wrong problem.
- **Not in the workflows.** A workflow that creates Tasks or raises "come and look" signals has to know how Intake works. A workflow should stay generic: the user can run it by hand, and then nothing about it should show up in Intake.
- **Not in a new record.** A Handoff or Case record would copy what a Task already is.

## Decision

**Handing a signal to an agent puts the work on a Task. Intake tracks that Task until the user ticks it off.**

- **Handing off is ~~an Intake act~~ the user's act on a signal or a card** *(amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034): it can start from a card on the Inbox too, see the amendment below)*. The core's Hand to an agent answers bind `signal.handOff { signalId, workflowId }`, a user-only operation. At the click it:
  - continues the open Task that carries the signal's thread ref, or creates one, `in-progress`, with the signal's title and priority;
  - appends a provenance entry that names the signal and the run;
  - starts the run linked to the Task (`run.taskId`);
  - resolves the signal "Handed to *X*", recording the run.

  `run.start` stays as it is, so a run started any other way ~~has no Task~~ *(amended 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034): except a handoff from a card, which starts its run on a Task too)* and never shows up in Intake.
- **The Task holds the chain.** Each handoff is one entry in its provenance, with its run. A follow-up is an ordinary signal from a source (checks failed, changes requested, a mention), which finds the Task by its refs, as Your work does. Handing that signal off continues the same Task.
- **The core never moves the Task's status** (ADR 0019). The user's click sets `in-progress`, and the user's tick-off sets `done` or `cancelled`. Between those, the Task stays in progress, and that is the "the agent finished, but I have not looked yet" state. It needs no new status. *(Amended 2026-11-07, [ADR 0052](./0052-tasks-have-a-stage-and-threads-join-them.md): a Task has a stage, and the status is read from it. The click sets the stage `building`, and the rule that the core moves nothing else stands.)*
- **Tracking** is the section at the bottom of To do that lists these Tasks, each in a state worked out on read from its runs, its sessions' Requests and the open signals that name it: Needs you, Failed, Working, Finished or Stopped. The UI never calls the row a Task.
- **Failures stay Notifications.** A failed run still raises `core.run-failed` for Check-in (ADR 0040). Its Task shows Failed in Tracking as well, so the failure has a lasting place on desktop.

## Considered options

- **Round Trip as drawn: a `result` signal of a new core kind, raised when handed-off work ends.** Rejected. The Task already answers "is this finished", so a second record would say the same thing twice. It also needed a run output contract (structured results, confidence, doubts) that every workflow would have to meet.
- **A run waits for the user's answer, and the user sends work back into it.** Rejected. A run already can wait ([spec 07 §4.3](../spec/07-workflows.md)), but it cannot hold a chain whose follow-ups go to other workflows.
- **Workflows create the Task and raise the follow-up signal.** Rejected, for the coupling described in Context.
- **Runs only: each run records the signal it came from, and Intake lists those runs.** Rejected. The runs of one chain would show as unrelated rows, and nothing would record that the user has accepted the result.
- **"In-progress Tasks with a linked run" as the rule for Tracking.** Rejected for an explicit fact, the provenance entry naming the signal. A stand-in rule would pick up any other path that links a run to a Task.
- **Matching an agent's PR to its Task by the run's branch name.** Rejected. An agent may rename its branch. A PR reaches its Task through the session that made it, once Hercule knows which PR a session's work became. *(Amended 2026-11-08, [#1035](https://github.com/theagenticage/hercule/issues/1035), [ADR 0055](./0055-facts-move-cards-through-editable-workflows.md): the rejection stands for a name the run was given. A controller step now links a pull request to a Task by the branch the Task's ephemeral checkout really has now, against the pull request's head `(remote, branch)`. It follows a rename, matches on the head's remote and not the target's, and links nothing when two live Tasks share a branch. A person can unlink, and the unlink sticks. Everything else here stands.)*

## Consequences

- `ProvenanceEntry` gains an optional `signalId`, a run gains `taskId`, and a signal's resolution gains `runId`. A re-run keeps its run's `taskId`.
- New operation `signal.handOff`, with its CLI row. `task.query` and `run.query` gain the filters Tracking needs.
- Signals written before this change keep their frozen `run.start` answers, so handing one of them off starts an untracked run. This is accepted, because To do drains within days.
- Intake reads Tasks and runs as well as signals. The desktop app's Tracking section is the first Task UI on desktop.
- The To do count includes the Tracking rows that wait on the user (Needs you, Failed, Finished), so inbox zero stays true.
- Not decided here, and left for later: comparing attempts, choosing when a handoff may interrupt, closing a Task when its source ends (which would be an editable workflow, under ADR 0019), structured results from runs, and agents with their own identity on GitHub.

## Note: which Task a hand-off continues

*(Added 2026-11-07, [#1032](https://github.com/theagenticage/hercule/issues/1032), [ADR 0054](./0054-external-entities-are-durable-records-kept-true-by-polls.md).)* The first bullet of the Decision says a hand-off "continues the open Task that carries the signal's thread ref". The selector was the open Task that was updated most recently (`findTaskToContinue`). That rule changes. A summary, a stage change or any other update could change which Task a ref belongs to, and a card on the Inbox must show one Task for a ref that does not move.

- **The active Task of a ref is the live Task with the oldest link to it,** by `(linked_at, task_id)` in `task_entity_links`. Live means not `done`, not `dropped`, not deleted and not merged. Nothing a Task does later can change the answer.
- **Both users of the rule move together.** The signal's Describe Line and `signal.handOff` call the same function, so the line still names the Task the hand-off continues.
- **Nothing else changes.** A hand-off with no live linked Task still creates one, and the core still never moves the Task's status.

## Amendment: handing off from a card (2026-11-08)

*(Added 2026-11-08, [#1034](https://github.com/theagenticage/hercule/issues/1034), slice 6 of the Work overview map [#1026](https://github.com/theagenticage/hercule/issues/1026), [ADR 0054](./0054-external-entities-are-durable-records-kept-true-by-polls.md).)* The Inbox shows the pull requests and issues that concern the user as cards, with or without a signal on them. The user can hand a card to an agent too, so the Decision above no longer stops at Intake. This amends two lines of it, marked above: "Handing off is an Intake act" and "a run started any other way has no Task".

- **Handing off can start from a card.** `externalEntity.handOff` hands the card's thing to a workflow that declares an `entity` input ([spec 07 §3](../spec/07-workflows.md#3-inputs)). It starts the run on the thing's active Task ([spec 09](../spec/09-tasks.md#entity-links)), or on a new one, and appends a provenance entry `{ ref, runId }`. The entry names no signal, so the Task shows on Work and not in Tracking.
- **The Task still holds the chain.** A follow-up still finds the Task by its ref. Whether the first handoff came from a signal or a card, the next one continues the same Task, and a second workflow on a Task is allowed. Two ways in can reach the same thing, so both refuse a second live run of the same workflow on the Task, and both continue the oldest live link's Task.
- **The core never moves a stage on its own.** A handoff decides `building` only from `exploring` or `planned`. At any other stage, such as `in-review`, the Task is not moved back. The stage is still written as a decision every time, so a later Undo can tell that someone decided after the handoff ([spec 09 §A handoff from a card](../spec/09-tasks.md#a-handoff-from-a-card)).
- **Acting never ends a signal it did not answer.** A handoff from a card ends only the open signals of the kinds its workflow's entity input lists in `answers`. A mention on the same pull request stays open on the card. The ending is the Hand to an agent resolution, "Handed to *X*", with no source action and no Ignore Rule suggestion ([spec 10 §9.6](../spec/10-triage-intake-and-notifications.md#96-when-a-signal-leaves)).
- **A handoff from a card can be taken back, as far as is safe.** Cancelling a run is not a rollback, so the handoff keeps a record of what it did and Undo reverses the Task only while nothing of the run has started and nothing has joined or moved the Task since. Otherwise the run is asked to stop and the Task stays. Signals the handoff ended stay ended.
- **Intake's Hand to an agent and Tracking stay as they are,** and keep working until [#1048](https://github.com/theagenticage/hercule/issues/1048) removes them, on Rogier's word. Until then the same thing can be handed off from both places, under the shared rules above.
- **Not changed:** the Task model stays thin (ADR 0019), workflows stay generic, and failures stay Notifications. A failed run on a Task now also reaches the user from any screen, as a dot on the desktop's sidebar ([spec 17](../spec/17-desktop-app.md#a-failed-run-from-any-screen)).
