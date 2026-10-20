# Tracking: the drawing

The pixel reference for Tracking, the tray docked at the foot of Intake's To do that follows the work the user handed to agents until they mark it done ([spec 17 §Intake](../../spec/17-desktop-app.md#intake), [ADR 0046](../../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md), map [#797](https://github.com/theagenticage/hercule/issues/797)). Drawn in the design session [#800](https://github.com/theagenticage/hercule/issues/800) on Round Trip, from the branch [`prototype/stay-in-the-loop`](https://github.com/theagenticage/hercule/tree/prototype/stay-in-the-loop/docs/design/stay-in-the-loop).

Where this drawing and spec 17 disagree, spec 17 decides.

Open `index.html` in a browser. It is drawn on the book's tokens and system (`../crew-bureau-2/`) and on the Intake drawing's stylesheet (`../intake-directions/asks/asks.css`), which the app's Intake is a port of. To do shows what the app draws today (Now, Signals, the foot), with Tracking docked under it. Round Trip's look, its tray, its faces, its motion and its pane are kept; what changed is the model, which is the plan's (#797): finished and failed work stays in Tracking until the user marks it done, and never comes back to To do as a new signal.

## States by URL

Add `&theme=orient-express` for dark, and `&bar=off` to hide the drawing's bar.

| URL | Shows |
|---|---|
| `index.html` | 09:41. Tracking holds seven Tasks: four wait on the user, and three fold into one row of faces. Rate-limit the public API is open, Finished |
| `?state=needs-you` | Upgrade the Stripe SDK: Implement asks to run `git push`, a Request answered in the tray or the pane |
| `?state=needs-you-signal` | Refunds for partial captures (PAY-212): checks failed on the agent's PR #1302, an open signal that names the Task. The signal's row in Signals wears Implement's face |
| `?state=failed` | Nightly backup: Investigate failed, permission denied on ops-db |
| `?state=working` | Lowercase SKUs: Fix bug is working. The tray is unfolded and scrolls inside its cap |
| `?state=stopped` | Move invoices to the new PDF renderer: the user stopped Implement |
| `?state=done` | Done: each handed-off signal shows its own leg. PAY-205 had two handoffs, so two rows, two legs |
| `?state=empty` | Nothing handed off: the tray is one line that says what it is for |
| `?state=zero` | Inbox zero while two rows still work: they do not wait on the user, so To do is at zero |
| `?state=load` | Ten times the load: 60 signals and 18 Tracking rows, 7 of them waiting. The tray keeps to its cap and scrolls |

The bar also plays the motion: **A run finishes** (Lowercase SKUs turns Finished; it waits while the pointer is on the list), **Hand off** (the trailing-space signal lifts out of Signals and flies into Tracking) and **Mark done** (Rate-limit the public API leaves).

## The tray

- **Where:** docked under To do's list, like an activity bar: Round Trip's "Out with agents", renamed. It is a separate place from the signals, so the list stays about what sources ask, and the tray about the work out with agents.
- **The cap:** the tray never takes more than 40% of the list's column. It draws at most five rows; past that, its Working and Stopped rows fold into one row of their faces ("2 working · 1 stopped", with the count per workflow under it). A click on that row, or on the head's chevron, unfolds them, and the tray scrolls inside its cap. The rows that wait on the user never fold.
- **The head:** "TRACKING" and the number of rows, and on the right "4 wait on you" in marigold. That number is what Tracking adds to the To do count: 7 signals and 4 waiting rows make 11.
- **The order:** Needs you, Failed, Finished, then Working, then Stopped; inside a state, the oldest handoff first.
- **Empty:** the head and one line, "Hand a signal to an agent, and follow it here until you mark it done."
- **Tabs:** the tray is To do's, not a tab's. It shows the same rows on every tab, so it never moves when the user switches. Its waiting rows count in the global To do count and in All's count; a plugin's tab counts its own signals only. A Task can have legs from several sources (PAY-212: Linear, then GitHub), so it has no one tab to count on.

## The row

As Round Trip's: the face of the agent that has the work, in its pose (working, waiting, done, failed, idle for stopped), the Task's title, and one line.

| State | Line |
|---|---|
| Needs you, a Request | the question, in marigold: "Run `git push -u origin chore/stripe-sdk-14`?", with Allow once, Always allow and Deny under it in three fixed slots |
| Needs you, a signal | "Checks failed on #1302", in marigold |
| Failed | "*Investigate* failed · permission denied on ops-db", in marigold |
| Finished | "*Review PR* finished", in green: see Finished, below |
| Working | "*Fix bug* · Writing a failing test for a lowercase SKU": the agent's latest message |
| Working, on a subscription | "*Implement* · waiting for checks on #1311" |
| Stopped | "*Implement* · stopped by you" |

The workflow's name is in its colleague's hue; the time on the right is how long the row has been in its state, in marigold and bold when the row waits on the user. Mark done shows on hover over Finished, Failed and Stopped rows only: on Working and Needs you it would leave a run going.

**Finished is green.** It waits on the user and counts toward To do, like Needs you and Failed, but it is good news: the agent is done and the work only needs a tick. So it is drawn in the book's green for what passed (`--ok`), where the rows that need something are marigold. Four treatments are drawn, switched with `?finished=`: `soft` (default), a green wash, `--ok-tint` at about half strength; `tint`, the full tint; `edge`, the wash with a straight, soft green edge at the row's left, the row square on that side, as the subagent view's brief card draws its edge; and `mark`, a green check by the time. #800 asked for Finished in marigold; Rogier changed that in the session.

**Groups.** The rows that wait on the user come first, Needs you, then Failed, then Finished; a 6px space; then Working and Stopped. Needs you leads because an agent or a source is blocked on the user; Finished comes last of the three because nothing is blocked.

**Faces on signals.** A signal about a tracked Task, such as the checks that failed on the agent's PR, is led by that agent's face in Signals, and its source's mark moves to the start of its second line, as Round Trip drew what came back. A face on a row says at a glance that an agent has worked on it. Done does the same for every handed-off signal.

## Focus: telling the list and Tracking apart

At ten times the load, two lists of the same rows on the same surface are hard to tell apart, and each competes for the eye while the user works in the other. The brief for the variants:

- **Separation at a glance,** from material, space and axis, before any word is read.
- **Focus follows attention:** the region the user works in leads; the other steps back but stays legible.
- **Calm:** opacity and transform only; nothing jumps under the pointer.
- **Nothing that counts hides:** what waits on the user stays visible in every variant.

The variants, switched with `?focus=` or with ← and →:

| Variant | The idea | Cost |
|---|---|---|
| `shelf` (default) | Tracking sits on its own surface, inset from the column with 8px above it and rounded corners. The surface is a 4% wash of ink over the page, so it shades a little in light and lifts a little in dark (`--sunken` read as a hole in dark) | none |
| `spotlight` | The same surface as the list, with more room above it. While the user works in Tracking (a tracked row is open, or the tray is unfolded), the list fades to 40%; the pointer on the list brings it back | one opacity transition on entering or leaving Tracking |
| `drawer` | A raised sheet over the bottom of the list, in three sizes: **minimized** to one summary row (the count, the faces of the agents whose work waits, "4 wait on you"; `&drawer=min`), **open** (what waits on the user and one row of faces, at most 40%), and **unfolded** (every row, at most 62%), with the list dimmed behind it. A click on the head minimizes or opens it; the row of faces unfolds it. A handoff into a minimized drawer flies to its head | one transform when the sheet changes size, one opacity transition for the dim |
| `desk` | Tracking minimized to one summary row; opening it brings up a large dialog over the list and the pane, with its own list and detail, so the two never share the column | one opacity and scale transition on opening and closing |
| `takeover` | Either Intake or Tracking, never both. Folded, Tracking sits at the foot of the list: its head ("TRACKING 7", "4 wait on you", "Show all ⌃") over the two rows that changed last, newest first, so a handoff has a visible place to land and the eye something to click. Opening it (a click on the head, or `T`) lets Tracking cover the whole list column under the title bar's hairline: every row, grouped by state under the state's mark, the open one in the pane. At its foot, a row sums up the signals and goes back. While Tracking is open, J and K walk only its rows; Esc steps back through the pane, the selection, then Tracking (`&takeover=open` opens it at load). How it opens is explored with `&motion=`: `rise`, a 240ms rise with a slight spring and the rows cascading in 16ms apart; `unfold`, the rows fanning up out of the foot, nearest first; `depth`, Intake scaling back as it fades while Tracking comes forward, in 200ms. Each closes the other way, quicker | transform and opacity only: one animation for the sheet, plus one per row on screen for rise and unfold, within 450ms; none with Reduce motion |

Two directions were drawn and dropped in the session: **In and out trays** (two columns side by side; too many columns) and **Blotter** (Tracking as the pane's resting state; a detail pane that is not a detail pane, reached only by closing what is open). Takeover keeps Blotter's clean overview as an either-or.

## The pane## The pane

Round Trip's: one trip, top to bottom, joined by a hairline.

- **The head:** the agent's face and name, the state, and "Open the run". The title, then when the state began, how long it ran, and the agent's harness, model and runner.
- **You asked:** the signal of the first handoff, with when it was handed to whom.
- **The agent's message:** for Failed, the reason first, in tomato; then the last message of the last agent step, with "Read the rest in the thread"; for Working, the latest step, live; for a Task with more than one run, its runs as steps; Linked work as the PR and its change line; for a Request, the question and its answers, as Round Trip's run pane has them.
- **The signal that waits,** for Needs you by a signal: a third message in the trip, from the source, with "Open the signal".
- **The answers:**

| State | Answers (primary first) |
|---|---|
| Working, Needs you by a Request | Stop the run |
| Needs you by a signal | Try again, Mark done, Cancel (none suggested: Open the signal is the move) |
| Finished | **Mark done**, Try again, Cancel |
| Failed | **Try again**, Mark done, Cancel |
| Stopped | Try again, Mark done, Cancel |

Open the run is in the head on every state, so the ledger leaves it out, as Round Trip's did. A Task that waits on a signal has no live run, so Stop the run is not offered there; it gets the answers of its last run's state.

## Done

Each handed-off signal's Done row is led by the face of the agent it went to, and its second line is its own leg, with no folding:

- "Handed to Implement → finished → continued: Fix bug"
- "Handed to Fix bug → tried again once → done"
- "Handed to Review PR → finished", where the Task is still open: the line ends with its Tracking state, in marigold when it waits on the user.

The pane draws the leg as Round Trip's trip: one line per step, with its time and who took it, then "Go to Tracking" while the Task is open, or "Open the run" once it is closed.

## Keys

| Key | Does |
|---|---|
| `J` / `K`, `↓` / `↑` | move down and up, through Now and Signals and on into Tracking's rows |
| `↩` | opens the pane and puts focus on the suggested answer; a second `↩` presses it |
| `E` | marks a Finished, Failed or Stopped row done; nothing on Working or Needs you |
| `O` | opens the run |
| Esc | closes the pane, then clears the selection |

## New design tokens

None. Round Trip's `--unseen` went with the unseen dot, and its `--trip-line` was `--line` under another name.

## Motion, and what it costs

Every motion is `transform` or `opacity` on an HTML element, plays once, only for rows on screen, and stops with Reduce motion. A change the user did not make waits while the pointer is on the list or the tray.

| Motion | How | Cost |
|---|---|---|
| A handoff: the signal leaves for Tracking | a lifted copy of its row (`--shadow-2`) flies from Signals to its place in the tray over `--dur-3`; the rows below in Signals close up | one compositor animation for the copy, plus one transform per row that moves on screen, once per handoff |
| A row changes state (Working → Finished) | its line fades in anew over `--dur-2`; when its place changes, the rows between slide over `--dur-3` | one opacity animation, plus one transform per row that moves, once per change |
| A row is marked done or cancelled | it fades over `--dur-1`, then the rows below close the gap over `--dur-3` | as Intake's own Done |
| A Working row's line changes | the new line fades in over `--dur-2` | one opacity animation per new agent message, only for rows on screen. The line is the agent's latest message, which the `session` topic already brings; this is the one per-message cost Tracking adds, and slice 1 measures it. Rogier keeps it for now, and is open to dropping it, for the workflow name alone, if it proves complex or costly |

No loop runs, faces in lists are still, and the times read the shared age clock, once a minute.

## Left out of Round Trip

- The `result` signal and the row that lifts back into To do; finished and failed work stays in the tray.
- Send back with a note, Take over, Undo, Edit, confidence and the structured results; the pane shows the agent's last message instead.
- The unseen dot, and folding results at load. [`DECISIONS.md`](https://github.com/theagenticage/hercule/blob/prototype/stay-in-the-loop/docs/design/stay-in-the-loop/DECISIONS.md) says why.
- Later, Everything and the Triage tab are as Intake has them today, and are not drawn.
