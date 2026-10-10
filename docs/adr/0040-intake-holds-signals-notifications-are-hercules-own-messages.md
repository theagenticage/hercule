# 40. Intake holds Signals; Notifications are Hercule's own messages

Date: 2026-10-10

## Status

Accepted by [Write the Intake changes and the build tickets (#395)](https://github.com/theagenticage/hercule/issues/395) and the map [Intake v1: from the Asks prototype to a buildable spec (#380)](https://github.com/theagenticage/hercule/issues/380). Decided in [#384](https://github.com/theagenticage/hercule/issues/384), [#388](https://github.com/theagenticage/hercule/issues/388), [#389](https://github.com/theagenticage/hercule/issues/389), [#391](https://github.com/theagenticage/hercule/issues/391) and [#392](https://github.com/theagenticage/hercule/issues/392). Supersedes the Proposal as "a Task labelled `proposed` plus its decision Notification" in specs 02, 09 and 10, and the triage Notification kinds (`triage.proposal`, `triage.offer`, `triage.unsure`, `triage.fyi`). Amends [ADR 0011](./0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md) (plugin rules and the Screener), [ADR 0022](./0022-proposing-is-not-doing.md) (bound actions also sit on Signals), [ADR 0023](./0023-chat-messages-are-conversation-input-not-events.md) (a Slack event source may sit beside the Slack channel), [ADR 0027](./0027-a-decision-resolves-when-its-question-is-answered-wherever.md) (snooze on Signals only) and [ADR 0034](./0034-a-catalog-contribution-is-identified-by-its-qualified-id.md) (signal kinds are qualified). Keeps [ADR 0012](./0012-notifications-are-core-routed-sinks-are-dumb.md): Notifications are still routed by the core, and Signals are not delivered to chat sinks in v1.

## Context

Intake was specified as a morning brief built only on primitives: triage read the events since its last run and turned what mattered into Tasks labelled `proposed`, each with a decision Notification asking the user to accept it. Spec 01 named one guard on that design: if Intake ever forced a new core concept, that was a design smell to escalate.

The Asks prototype (`docs/design/intake-directions/asks/`) showed what the user works through all day is not triage's findings. It is the steady stream of things other people and systems ask of them: a review request, a mention with a question, a mail that waits on a reply. Each is one item, answered from where it sits, and the goal is inbox zero. Building that on Notifications ran into four problems:

- **Two kinds of attention in one record.** A Notification is Hercule telling the user about itself: a run failed, a breaker tripped, a session waits on an approval. A review request from Marta is not about Hercule. Mixing them meant Check-in and Intake both had to filter one table by kind, and a count on either could disagree with the other.
- **A different lifecycle.** A signal ends when its source shows the move was made (the review landed on GitHub), and the user may snooze it. A Notification resolves when its question is answered, has a `handled` resolution for assistants, and is never snoozed.
- **Work existed before the user said yes.** A proposal was a real Task from the moment triage wrote it. Dismissing it meant cancelling a Task the user never wanted, and every work workflow had to guard on the `proposed` label.
- **Plugins would write Notifications.** Raising a review request straight from an event meant a plugin, or the Screener's session, creating Notifications of a plugin's kind, through rules the producer table was never shaped for.

## Decision

**A Signal is its own record, never a Notification. Intake reads Signals, Tasks and Events. Notifications are Hercule's own messages about itself, shown in Check-in, and never shown on Intake.**

- **One record for everything put in front of the user on Intake.** A plugin declares its signal kinds; the core raises a plugin's signals from its events and ends them when the source shows the move was made. Core kinds (`proposal`, `offer`, `unsure`, `fyi`) are raised by any actor holding `signal.write` through `signal.raise`, the shipped Triage workflow among them. A signal is on the user's list only while a move is asked of them.
- **Signal first.** A proposal is a `proposal` Signal. No Task exists until the user presses Accept, which runs `task.create`. Nothing an agent prepares exists as work until the user says yes.
- **A plugin rule reports, it does not judge.** A kind's rule answers `yes`, `no` or `undecided` from what the source itself says (you were asked for a review). Where the source says nothing certain, a shipped, editable workflow, the Screener, decides. Judgment about relevance lives only in workflows the user can read and edit.
- **Notifications keep their role.** Run failures, breakers, permission requests, build failures (`core.signal-build-failed`) and anything else Hercule reports about itself stay Notifications, routed by the core to Check-in and to sinks as before.
- **Bound Actions sit on both.** A decision Notification and a Signal both carry Bound Actions under the same rule: laying one out does nothing, only the user's pick runs it. Each operation lists where it may be bound in `usableIn`.

The model is written in [spec 10 §9](../spec/10-triage-intake-and-notifications.md#9-signals); the storage in [spec 04](../spec/04-state-store.md#event-log-as-audit-log-and-retention).

## Considered options

- **A Signal as a decision Notification of a plugin's kind** (the Asks notes' starting point). Rejected for the four problems in Context.
- **A Proposal as a Task labelled `proposed` plus its Notification** (spec 10 as of [#42](https://github.com/theagenticage/hercule/issues/42)). Rejected: a Task is work the user has agreed to, and a label convention every work workflow had to guard on was easy to get wrong.
- **Plugins judging relevance in their own code** (a newsletter filter inside the Gmail plugin). Rejected, as [ADR 0011](./0011-triage-is-a-workflow-pattern-inside-core-enforced-bounds.md) rejects judgment in core code: a hidden heuristic the user cannot read or change.
- **Intake built only on primitives.** Kept as the default stance and reversed here on purpose: spec 01's design-smell guard did its job, the question was escalated, and these tickets decided a new core record is warranted.

## Consequences

- New tables: signals, snoozes, Ignore Rules and their catches, and screenings ([spec 04](../spec/04-state-store.md#what-is-in-the-store-and-what-is-not)). A Signal keeps the events it names alive under the retention rule.
- New operation families `signal` and `ignoreRule`, with the grants `signal.read` and `signal.write` ([spec 11](../spec/11-public-api-and-agent-surface.md#signal), [spec 13](../spec/13-security.md#61-grant-families)).
- The curated list of bindable operations is replaced by `usableIn` on each operation.
- Check-in and Intake never filter one table by kind, so their counts cannot disagree.
- The triage Notification kinds, the `proposed` label, "Needs a call" and Intake's "since you last checked" are retired.
- Intake is no longer built only on primitives. A future surface that wants its own record must still make the case this ADR made.
