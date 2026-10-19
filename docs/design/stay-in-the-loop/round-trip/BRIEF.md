# Round Trip

PROTOTYPE. One of four directions for "Stay in the loop" (`../BRIEF.md`).

## The problem, in this direction's terms

A handoff is a trip with only one leg. Rogier presses Hand to Draft reply, the signal leaves To
do, and nothing ever comes back to the place he sent it from. The result exists, but it sits in a
run page, a transcript and Gmail's Drafts folder, and a failure sits nowhere he looks. Intake is
where he decides what happens to work, so Intake is where the work should come back.

**The lever:** every handoff comes back to Intake as a new signal, next to the others, until
Rogier signs it off.

## Principles

1. **Close the loop where it opened.** What comes back lands on To do, the list he already works
   through, not in a second list he has to remember to check.
2. **A new move, not the old one reopened.** The original signal still leaves at the click. The
   result is a new signal that asks a new move: look at what came back.
3. **What you asked, beside what it did.** The pane pairs his request with the result, so he
   judges the result without hunting for the context.
4. **The agent says what it is unsure of.** Confidence decides whether an answer is suggested,
   and every doubt becomes a one-click note when he sends the work back.
5. **Runs are not signals.** Work still out sits quietly under the list. It speaks up only when
   it needs him.

## Who and when

- **09:00 to 09:35, handing off.** Each handoff drops its row into Out with agents. He keeps
  going; nothing asks him to wait.
- **The coffee moment.** He sits back and the list tells him what came back: a face, what it
  brought, a dot if he has not seen it.
- **Mid-run questions.** "Run git push?" or "Void INV-2291 in Stripe?" waits in marigold in Out
  with agents, answerable where it stands.
- **The evening.** Done reads as a log of trips: "Handed to Draft reply → sent back once →
  signed off, sent to Marta".

## Key interactions

| Key | Does |
|---|---|
| `J` / `K` | moves down the list and on into Out with agents |
| `↩` | opens the item and puts focus on its suggested answer; a second `↩` presses it |
| `S` | signs off a result (Let it go on a failed one) |
| `B` | sends a result back (Try again with a note on a failed one): opens "What should change?" with chips from the agent's doubts |
| `T` | takes over: the run's thread opens and Rogier goes on himself |
| `E` | Done on a plain signal |
| `R` | the reply box, when the signal has one |
| `⌘↩` | sends the note or the reply |
| `O` | opens the run in Workflows |
| `Esc` | steps back: the box, then the pane, then the selection |

- **Send back** opens a box in the pane. Chips come from the agent's own doubts ("Legal name:
  guessed Ltd"). `⌘↩` sends. The row turns into a working row in place ("Attempt 2"), then drops
  into Out with agents.
- **A Request mid-run** ("Run git push?") is answered from the tray (Allow once, Always allow, Deny in fixed
  slots) or from the pane, where each answer has its describe line.
- **Edit** sits on the draft itself (the review comments, the letter), not in the ledger.
- **Attempt 2** shows "What changed since attempt 1" as pairs (Brightline Ltd → Brightline B.V.)
  and, on request, both letters side by side.

## States

| State (shared brief §3) | How it reads here |
|---|---|
| Handed | the row leaves To do and drops into Out with agents |
| Working | a row in Out with agents: still `working` face, one line of narration, elapsed time |
| Needs you | that row in marigold, the question, answers in place; also in Waiting on you |
| Landed | a result row on To do: the colleague's face in `done`, the source's mark, a marigold unseen dot |
| Seen | the same row without the dot |
| Signed off | the result leaves To do; Done shows the trip, "signed off" |
| Sent back | the result leaves To do and Attempt 2 works in Out with agents; Done says "sent back once" |
| Taken over | the result leaves; the run's thread opens; Done says "taken over" |
| Undone | Discard draft, Close the PR, Revert the commit: answers in danger ink, where the result allows |
| Failed | a result row with the `failed` face; the pane leads with the reason in a tomato rule, then Try again with a note |
| Empty | "Nothing handed off today." and a faded sample of a run in Out with agents |
| Swarm | results of one workflow fold into one row ("4 reviews back"); working runs fold into one row of faces; questions always show |

## What it deliberately does not do

- It does not list runs as signals or count them on To do. Out with agents is a read-only window
  on runs started from Intake, plus their questions.
- It does not replace Workflows. "Open the run" goes there for steps, transcript and timeline.
- It does not reopen the original signal. Spec 10 §9.6 holds.
- It does not notify. A landing is a quiet arrival, as a new signal is; nothing reaches the dock
  badge except questions, as today.
- It does not animate faces. Working faces are drawn still, as spec 17 rule 2 asks of lists.

## What changes in the spec

1. **A fifth core kind, `result`, raised by the core itself.** Not by `signal.raise` and not by a
   workflow. Contradicts spec 10 §9.3, which has four core kinds and raises them through
   `signal.raise`. The core raises a result when work Rogier handed off ends:
   - a run started by Hand to an agent;
   - a run he started on a Task that a signal created (H7);
   - a thread he started from a signal (H6), when its turn ends without a question.
   Runs a trigger starts never come back here. Origin gains `{ type: "run", runId, sessionId?,
   tripId, attempt }`, where `tripId` is the first signal's id.
2. **What `signal.act` answers on a result:**
   - **Sign off**: the core's `done`, labelled for this kind; outcome "Signed off".
   - **The result's own outward actions** (Post review, Merge #1302, Send reply): plugin actions
     the run's output proposes, frozen into the result as Bound Actions. Taking one signs off too.
   - **Send back**: a new core action binding a new operation, `run.tryAgain { runId, note }`. It
     takes typed text, which contradicts spec 10 §9.4 ("only a plugin action takes a `field` in
     v1"). Outcome "Sent back".
   - **Take over**: a new core action that hands the run's session to Rogier as a Thread.
   - **Undo**: plugin actions the run's output declares as its reversal (delete the draft, close
     the PR, revert the commit).
   - **Edit** changes a frozen action's input before the click. That bends spec 10 §9.1 ("what
     the user saw is what they answered"); the edited input is shown in the describe line.
3. **Suggestion follows confidence.** The core marks the outward action primary only when the run
   reports high confidence; when nothing outward is left, Sign off is primary. That is a third
   exception to "the core's actions are never primary" (spec 10 §9.4).
4. **A failed run comes back.** Spec 10 §9.4's "a failed run never puts the signal back on To do"
   still holds to the letter: the original stays resolved. But a new signal appears, and the
   `core.run-failed` Notification for these runs becomes redundant; the core raises the result
   instead.
5. **Done's read-only run state becomes partly redundant.** Spec 17 §The pane shows the run's
   state beside "Handed to *workflow*". Here Done shows the whole trip in one line, worked out on
   read from the trip's signals, and lists results inside their trip, as it already folds
   replaced signals.
6. **Intake reads runs.** Out with agents needs a read of live runs started from Intake and the
   `run` topic while Intake is open (spec 17 §What the screen reads), and answers its Requests
   in place (the same operation as the Requests dock).
7. **Tabs.** A result shows under its original signal's plugin tab. Spec 17 §Tabs puts core
   signals under All only.
8. **The run's output becomes a contract.** To draw a review, a pull request, a letter or
   findings, a workflow's output declares a type, proposed actions, reversals, confidence, what
   it checked and what it doubts. New block types (`review`, `letter`, `findings`, `changes`)
   fit spec 10 §9.5's open union.
9. **At ten times the load, one answer acts on several results** ("Post 3 approvals"). Spec 17
   §Row controls says an answer is about one signal and the bulk bar offers only Snooze and Done.
10. **"Back" is taken.** Spec 17 uses "Back" for a snooze that ran out. The shared brief's "Back
    from Draft reply" would collide with it on a row, so rows say "Draft reply · what it brought"
    and the kind is "Result"; "Back at 09:22" appears only in the pane's sentence.

## New design tokens

| Token | Value | Why |
|---|---|---|
| `--unseen` | `var(--you)` | the dot on a result nobody opened: it waits on Rogier, so it is marigold, and the name says so where it is used |
| `--trip-line` | `var(--line)` | the hairline from "You asked" to the colleague's face, and down the trip in Done; a shade above `--line-soft` so it reads beside the raised letter |

## Motion, and what it costs

Every motion is `transform` or `opacity` on an HTML element, plays once, only for rows on screen,
and stops with Reduce motion. While the pointer is on the list, arrivals and departures wait.

| Motion | Duration | Cost |
|---|---|---|
| A result lands: a copy of its row lifts out of Out with agents to its place in Signals, with `--shadow-2`; rows below make room | `--dur-3` | one compositor animation per moving row, once per landing |
| Send back: the row turns into a working row in place, then drops into Out with agents | a hold of `--dur-3`, then `--dur-3` | two steps, 640ms, under the 800ms a user-caused chain may take |
| A result leaves (signed off, sent): it fades where it was, then the gap closes | `--dur-1`, then `--dur-3` | as spec 17's own departures |
| The unseen dot goes when the result is opened | `--dur-1` | one opacity animation |
| A new narration line fades in | `--dur-2` | one opacity animation per reported step, only for rows on screen |

No loop runs. Faces are still. Elapsed times and ages read the shared age clock, once a minute.

## Effort to build for real

- **Core (L):** the `result` kind and its origin; raising on run end for handed-off work; trips
  (`tripId` on every signal of a trip); `run.tryAgain` with a note and the previous attempt; Take
  over; the workflow output contract (type, proposed actions, reversals, confidence, doubts);
  dropping `core.run-failed` for these runs.
- **client-core (M):** the trip chain line, Out with agents' model (which runs, which questions),
  folding at load, the suggested answer from confidence, the "What changed" pairs.
- **Renderer (M):** result rows, the tray (virtualized), result panes per output type, the Send
  back box with chips, the list-to-tray motion.
- **Overall: L.**
- **Riskiest part:** the output contract. Everything rich here (the letter, the comments, the
  confidence, the doubts, the undo) depends on each workflow returning a structured result, and
  on agents reporting their doubts honestly. A workflow that returns free text falls back to its
  final message, and the pane loses most of its value.

## States by URL

All from `round-trip/index.html`; add `&theme=orient-express` for dark and `&bar=off` to hide the
prototype bar.

| URL | Shows |
|---|---|
| `index.html` | 09:41, live: the review result open; Jonas's findings land at 09:41:12, the backup findings at 09:41:40 |
| `?state=pr` | seen, no verdict: draft PR #1302, with "You signed off #1287 yesterday" |
| `?state=landed` | Jonas's findings just landed, open |
| `?state=inflight` | Investigate still working, its steps live |
| `?state=needs-you` | the 3-D Secure thread asks "Run git push?" |
| `?state=redo` | the Send back box on Marta's draft, the note written |
| `?state=attempt2-needs` | attempt 2 asks to void INV-2291 in Stripe |
| `?state=attempt2-landed` | attempt 2 back, with what changed |
| `?state=failed` | Fix bug failed on #1300 |
| `?state=again-landed` | attempt 2 pushed a fix, checks pass |
| `?state=done` | Done, the whole trip of Marta's invoice |
| `?state=empty` | nothing handed off today |
| `?state=swarm` | ten times the load: folded results, folded runs, two questions |
