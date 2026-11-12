# 57. A Task's lead reports its stage, and a report is the weakest way to move a card

Date: 2026-11-12

## Status

Accepted by [Work overview: a Task's lead reports its stage (#1113)](https://github.com/theagenticage/hercule/issues/1113), part of [#1026](https://github.com/theagenticage/hercule/issues/1026). Amends [ADR 0053](./0053-a-text-generation-describes-a-task-it-never-moves-one.md), whose last consequence forbids any path to the Task row for what a model says about a Task, and [ADR 0055](./0055-facts-move-cards-through-editable-workflows.md): a Fact that agrees with a reported stage takes over the cause, and Landed now means "finished from the agents' side, waiting for the user". Keeps [ADR 0052](./0052-tasks-have-a-stage-and-threads-join-them.md) true: the core never moves a stage on its own. The rules are in [spec 09](../spec/09-tasks.md#stage-reports), [spec 11](../spec/11-public-api-and-agent-surface.md) and [spec 17](../spec/17-desktop-app.md#a-card-moving-by-itself).

## Context

Facts move a card only where a pull request or a ticket can see the work: In review and Landed. Exploring, Planned and Building are invisible to Facts, and so is all work that is not code. Such a card stays where it started until the user drags it.

An agent can already write a stage with `task.update`, but nothing tells it to, and its write counts as a person's: it overrules every Fact. So an agent's word beats a merged pull request. That is the wrong way round.

## Decision

**The Thread that leads a Task may report the Task's stage. A report moves the card only when nothing stronger has spoken: a Fact beats it, and a person's drag beats a repeat of it.**

- **One voice per Task.** A Task has one lead, stored as `tasks.lead_session_id`. Only a Thread can lead, so a run or an Agent session is always a helper. Only the lead's report is accepted, and a helper is refused with the lead's name. Any Thread can lead, an archived or Done one too.
- **A report carries only a stage.** Questions, failures and live state already show on the card from real rows, and the Task Summary describes the work.
- **The weakest way to move a card.** The lead's last claim is stored per Task, in its own table (`task_stage_reports`), as ADR 0053 asks of anything a model says about a Task. A report whose stage equals that stored claim is a `repeat` and changes nothing, whoever made the claim, so a new lead repeating the old lead's claim does not undo a drag. A Task whose current stage a Fact placed ignores the report, but only while that Fact still holds: it is not voided and something linked to the Task is still open. A stale Fact must not leave the card stuck: if the pull request that put the card in review is closed without merging, or unlinked, and no other linked work is still open, the lead's report moves the card. While a linked pull request is open, the card stays in review. A report of `landed` with something linked still open is ignored.
- **A report is not a person's write.** It leaves the fence alone, so the next Fact still applies. It records its own cause (`stage_cause_session_id`), shown on the card like a Fact's cause. Any other stage write clears that cause.
- **A Fact that agrees takes the cause over.** When a Fact finds the Task at its stage and the cause is a report, the Fact becomes the cause. Otherwise a pull request could open and agree, and the lead's next report could move the card away from In review while it is still open.
- **Landed means finished from the agents' side, waiting for the user.** Done stays the user's sign-off. A report may set Landed when nothing linked is open.
- **Every accepted report is counted.** One audit entry, `task.stageReported`, with the outcome. A call refused for who the caller is carries no entry.
- **Only the lead is told.** The text is built per session at start, so helpers never see it. There is no reminder and no Stop hook.

## Considered options

- **Let every session on the Task report.** Rejected. A helper that finishes its part would move the card. One voice per Task is what makes a report mean something.
- **Let the user choose the lead.** Not done. A lead is found from how Threads join, fork and move, which needs no screen. A choice can be added later.
- **Let a run or an Agent session lead.** Rejected. A review workflow's steps would move a card to In review. A Task worked only by runs has no lead.
- **Treat a report like a person's write.** Rejected. It would overrule every Fact, which is today's problem.
- **Compare the report with the Task's current stage only.** Rejected. After a drag, a lead repeating itself would undo the drag. The stored claim is what makes a repeat visible.
- **Derive stages from session activity.** Rejected. A file being written is not evidence of building: it may be a research note.
- **Remind the lead, or block a turn that ends with no report.** Not done. Every report is counted, so a later ticket can decide whether enforcement is worth its cost.

## Consequences

- A migration adds `tasks.lead_session_id`, `tasks.stage_cause_session_id` and the table `task_stage_reports`, and fills `lead_session_id` for every live Task with its oldest Thread. It rewrites rows, so `e2e/upgrade.test.ts` gets a fixture.
- A new operation `task.reportStage` (grant `task.update`) and its CLI row `hercule task report --stage <stage>`. It cannot be bound by a notification action: it only means something from a session.
- `Task` gains `leadSessionId`. `WorkCard.stageCause` becomes a union of a Fact cause and a report cause.
- ADR 0053's last consequence now reads: a model's background text never reaches the Task row, and a lead's stage report may, under the rules above.
- An agent's plain `task.update --stage` is unchanged. It still counts like a drag, because an agent may be doing what the user told it.
- A report can be wrong. It is the weakest claim, so a Fact or the user corrects it, and `hercule event list --kind task.stageReported` shows how often agents report and what came of it.
