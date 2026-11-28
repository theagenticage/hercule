# 53. A Text Generation describes a Task; it never moves one

Date: 2026-11-07

## Status

Accepted by [Work overview: the design and its tickets (#1026)](https://github.com/theagenticage/hercule/issues/1026), built by [#1031](https://github.com/theagenticage/hercule/issues/1031). Uses [ADR 0041](./0041-text-generation-is-one-model-call-on-a-runner.md) for the model call and keeps [ADR 0052](./0052-tasks-have-a-stage-and-threads-join-them.md) true: the core still never moves a Task's stage on its own.

**Amended 2026-11-12 ([#1113](https://github.com/theagenticage/hercule/issues/1113), [ADR 0057](./0057-a-tasks-lead-reports-its-stage-and-a-report-is-the-weakest-way-to-move-a-card.md)):** the last consequence, "no path to the Task row", holds for anything a model writes about a Task in the background. It does not rule out a stage report: the Thread that leads a Task may report its stage, through the same rules as every other writer, and a report is the weakest of them.


## Context

A card on Work shows a line that says what the Task is about and where it stands, such as "Three designs, depots worried." The Task row holds a title and a description the user wrote, and a Thread's transcript holds the real story, so the line has to be written by something that reads the work. A small model can do that after each turn, at a cost the user pays out of their subscription.

Three things make this risky:

- **A model's words are not the user's words.** The card must never look as if the user, or the system, decided something because a model wrote a sentence.
- **Model calls cost money and time.** A board with hundreds of Tasks, and agents that end a turn every few seconds, can make a call per turn per Task.
- **A summary is easy to turn into a decision.** "Looks done" is one field away from `stage: done`. ADR 0019 and ADR 0052 say the core never moves a stage by itself, and that must stay true when the writer is a model.

## Decision

**A Text Generation writes a Task Summary: three short texts that describe the Task. The summary lives in a table of its own, is written by a loop that has its own bounds, and can change nothing but itself.**

- **Its own table.** `task_summaries` holds the three texts (`line`, `standing`, `left`) and the bookkeeping that keeps them current. They are not fields on `tasks`. A summary written through `task.update` would move `updatedAt`, copy its text into `task.updated` events that the log keeps for 90 days, and could start workflows that listen to those events.
- **Never `task.update`.** The writer calls `TaskService.storeSummary`, which writes only `task_summaries`. It writes no `task.updated` event, does not touch `updatedAt`, and marks nothing dirty (that would loop). Its one record is the audit entry `task.summarized`, stamped with the system actor, never routed, and holding ids only, not the text. The write is announced to clients as a derived change, so a burst of summaries reaches the board at the slow pace and does not read it once per summary.
- **A call is `core:tasks` with the purpose `task.summary`,** made through the `TextGeneration` service of ADR 0041 with `whenNoRunner: "fail"`. The model call runs in the controller daemon, outside any transaction, because a domain does not run for the life of the controller and a Text Generation must not run inside a transaction.
- **What marks a Task dirty.** Each cause raises the row's `dirty_revision` in the transaction of the change itself, so a crash loses nothing:
  - a turn of one of the Task's own sessions ends, in any state, even when a queued input starts the next turn at once (a subagent's turn does not count);
  - a Thread's first open question opens, or its last one closes (a session parked on a question ends no turn);
  - a run of the Task ends;
  - the Task's title or description changes, a Thread joins it or leaves it, a Task is merged into it, or it is taken back from `done` or `dropped`.
- **The bounds.**
  - **Pace.** At most one call per Task every 5 minutes (`SUMMARY_MIN_INTERVAL_SECONDS`, 300). The time of the next attempt is written before the call, so a failed call is paced too. A failure waits longer each time it repeats: 5 minutes doubled for each failure in a row, at most 1 hour.
  - **Quiet time.** A Task is picked 30 seconds (`SUMMARY_QUIET_SECONDS`) after its first change since its last summary, so a burst of changes makes one summary.
  - **Concurrency.** At most 2 calls at once (`SUMMARY_CONCURRENCY`), oldest change first. A backlog must not fill the runner's ten Text Generation slots, which Thread titles need too.
  - **Input.** At most 24 KiB (`MAX_SUMMARY_INPUT_BYTES`): the title and description, the newest 4 sessions with the start of their first prompt and the end of their newest assistant text, the newest runs and how they ended, and the open questions as plain text. The largest texts are cut first, so the short facts stay whole. The writer reads a fixed number of statements however long a transcript is.
  - **Output.** Three short fields. The model's output schema has no length limit, because a Text Generation refuses an answer that breaks its schema and a card must not lose its summary to a word count. The writer cuts each text at a word to its bound (`line` 60 characters, `standing` 400, `left` 200) and never refuses an answer for its length.
  - **A quiet board costs nothing.** A Task that is not dirty makes no call. With 20 busy Tasks the most is 4 calls a minute.
- **The Text Generation Model setting governs it, Off included.** There is no setting for summaries. When the setting is Off, or no runner can run a call now (the `unavailableReason` that `controller.read` reports), the loop does nothing and leaves the Tasks dirty. The next wake after the setting changes finds the work still there and catches up. The details pane says "Summaries are off" and links to the setting.
- **The loop sleeps until the first Task is due.** A Task is due 30 seconds after its first change, or at its time of next attempt when that is later. The loop reads that time (one read, no write), sleeps until then, and wakes earlier when a Task is marked. A wake that finds nothing due costs the one read: it resolves no model and claims nothing. A minute is the longest sleep.
- **It survives a restart.** `dirty_at` and the time of the next attempt are rows. A call cut off by a restart is made again after its time passes. Text Generation itself keeps nothing across a restart (ADR 0041).
- **How the writer is kept honest.**
  - The output schema has `line`, `standing` and `left` and nothing else, with no additional properties. It has no stage, no title, no action, and no field that could hold a question or an answer.
  - The answer can reach one place: the summary row of the Task it was made for. It never moves a card.
  - The write is guarded by the row's `dirty_revision`. An answer made from an older state than the Task has now is still stored, and the row stays dirty: the card shows the summary as stale, and the time of next attempt paces the call that refreshes it. Dropping such an answer would leave a Task that changes during every call (a busy Thread whose turns end every minute) without any summary, and a stale summary is better than none. An answer is never stored for a Task that was finished, merged away or deleted in the meantime, it never recreates a deleted row, and it never replaces a summary made from a newer revision.
  - An open question and a failure on a card come from real rows (a Request of a Thread, a run that failed), never from a summary. A summary stays readable beside them.
  - The input is the material to describe, and the instructions say so. A prompt injection in a transcript can at worst make a summary say something wrong. It cannot ask the user a question, answer one, change a stage or start anything.
  - A failed call keeps the last summary and marks it stale. The card draws a stale summary as it draws a fresh one, and the pane notes that newer work exists. It is never drawn as an error.
- **`dirty_at` is the time of the first change, not the last.** The quiet time counts from the first change since the last summary, and later changes raise `dirty_revision` without moving it. A Task that changes every minute is still summarized, 30 seconds after its first change and no more often than every 5 minutes. A quiet time that restarted on each change would starve exactly the Tasks that are worth describing.
- **Finishing and deleting clear the row's `dirty_at`, and merging deletes the source's row.** A finished Task costs no call and is never selected. Taking it back to a live stage marks it dirty. The migration marks nothing: an existing Task gets its first summary at its next turn, not in one burst at the upgrade.

## Considered options

- **Put the three texts on the Task and write them with `task.update`.** Rejected, for the three reasons above: it moves `updatedAt`, it copies model text into events kept for 90 days, and it can start workflows. It would also make the model a writer of the same row the user and workflows write.
- **Let the summary also suggest a stage, or say "done".** Rejected. A suggestion on a card reads as a decision, and ADR 0019 and ADR 0052 keep stage moves with the user and with workflows. A fact that should move a card is a rule a workflow owns.
- **Make the summary an agent session.** Rejected, as in ADR 0041: a session brings a slot, a workspace, tools and a transcript nobody opened.
- **Summarize at every turn end.** Rejected. A busy agent would make a call every few seconds, and the cost has no ceiling.
- **Start the quiet time again at every change.** Rejected: a busy Task would never be summarized.
- **Put the length limits in the output schema.** Rejected: an answer a few characters too long would fail the whole call, and the card would keep the old text or none. Cutting at a word loses a few words instead.
- **Add a setting that turns summaries off.** Rejected. The Text Generation Model setting already says whether the user wants background model calls, and a second switch would give two places to look when summaries are missing.
- **Write summaries when a card is opened.** Rejected: the card needs its line before it is opened, on every Task, and a model call per card read would cost more than one call per change.
- **Keep the text in the audit entry.** Rejected: audit entries are kept, and a summary is derived text that is rewritten. The entry holds ids, so the cost is visible and the text is not copied.

## Consequences

- Every card with a Thread shows a line after its first turn ends, within about a minute when a Text Generation Model can run. Until then it shows the Task's title and "Writing a summary". When no model can run, the card shows the title alone.
- Summaries use the user's subscription in the background (ADR 0041). Each call writes its `textGeneration.completed` or `textGeneration.failed` audit entry, so the cost is visible.
- A summary can be wrong or out of date. The pane says when it was written and that newer work exists. The Task's own words, its Threads and its runs stay one click away, and a summary never replaces them.
- The tasks domain gains a table, a dirty marking that other domains call in their own transactions, and a wake signal. The controller daemon gains one loop, forked beside the other drivers. The loop reads sessions, runs and the Text Generation service, so it lives in the daemon (ADR 0033).
- Merging two Tasks deletes the source's summary and marks the survivor dirty, so the survivor is described again from its new Threads and runs.
- `core:tasks` is a second caller of Text Generation. [ADR 0041](./0041-text-generation-is-one-model-call-on-a-runner.md) carries a dated note for it.
- A later feature that wants a model to say something about a Task follows the same rule: it gets its own table or field, its own bounds, and no path to the Task row.
