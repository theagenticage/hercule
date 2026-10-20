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

- **Handing off is an Intake act.** The core's Hand to an agent answers bind `signal.handOff { signalId, workflowId }`, a user-only operation. At the click it:
  - continues the open Task that carries the signal's thread ref, or creates one, `in-progress`, with the signal's title and priority;
  - appends a provenance entry that names the signal and the run;
  - starts the run linked to the Task (`run.taskId`);
  - resolves the signal "Handed to *X*", recording the run.

  `run.start` stays as it is, so a run started any other way has no Task and never shows up in Intake.
- **The Task holds the chain.** Each handoff is one entry in its provenance, with its run. A follow-up is an ordinary signal from a source (checks failed, changes requested, a mention), which finds the Task by its refs, as Your work does. Handing that signal off continues the same Task.
- **The core never moves the Task's status** (ADR 0019). The user's click sets `in-progress`, and the user's tick-off sets `done` or `cancelled`. Between those, the Task stays in progress, and that is the "the agent finished, but I have not looked yet" state. It needs no new status.
- **Tracking** is the section at the bottom of To do that lists these Tasks, each in a state worked out on read from its runs, its sessions' Requests and the open signals that name it: Needs you, Failed, Working, Finished or Stopped. The UI never calls the row a Task.
- **Failures stay Notifications.** A failed run still raises `core.run-failed` for Check-in (ADR 0040). Its Task shows Failed in Tracking as well, so the failure has a lasting place on desktop.

## Considered options

- **Round Trip as drawn: a `result` signal of a new core kind, raised when handed-off work ends.** Rejected. The Task already answers "is this finished", so a second record would say the same thing twice. It also needed a run output contract (structured results, confidence, doubts) that every workflow would have to meet.
- **A run waits for the user's answer, and the user sends work back into it.** Rejected. A run already can wait ([spec 07 §4.3](../spec/07-workflows.md)), but it cannot hold a chain whose follow-ups go to other workflows.
- **Workflows create the Task and raise the follow-up signal.** Rejected, for the coupling described in Context.
- **Runs only: each run records the signal it came from, and Intake lists those runs.** Rejected. The runs of one chain would show as unrelated rows, and nothing would record that the user has accepted the result.
- **"In-progress Tasks with a linked run" as the rule for Tracking.** Rejected for an explicit fact, the provenance entry naming the signal. A stand-in rule would pick up any other path that links a run to a Task.
- **Matching an agent's PR to its Task by the run's branch name.** Rejected. An agent may rename its branch. A PR reaches its Task through the session that made it, once Hercule knows which PR a session's work became.

## Consequences

- `ProvenanceEntry` gains an optional `signalId`, a run gains `taskId`, and a signal's resolution gains `runId`. A re-run keeps its run's `taskId`.
- New operation `signal.handOff`, with its CLI row. `task.query` and `run.query` gain the filters Tracking needs.
- Signals written before this change keep their frozen `run.start` answers, so handing one of them off starts an untracked run. This is accepted, because To do drains within days.
- Intake reads Tasks and runs as well as signals. The desktop app's Tracking section is the first Task UI on desktop.
- The To do count includes the Tracking rows that wait on the user (Needs you, Failed, Finished), so inbox zero stays true.
- Not decided here, and left for later: comparing attempts, choosing when a handoff may interrupt, closing a Task when its source ends (which would be an editable workflow, under ADR 0019), structured results from runs, and agents with their own identity on GitHub.
