# Tracking: the drawing

The pixel reference for Tracking: the place in Intake's To do where the user follows the work they handed to agents, until they mark it done. See [spec 17 §Intake](../../spec/17-desktop-app.md#intake), [ADR 0046](../../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md) and the map [#797](https://github.com/theagenticage/hercule/issues/797). Drawn with Rogier in the design session [#800](https://github.com/theagenticage/hercule/issues/800), on Round Trip from the branch [`prototype/stay-in-the-loop`](https://github.com/theagenticage/hercule/tree/prototype/stay-in-the-loop/docs/design/stay-in-the-loop).

Where this drawing and spec 17 disagree, spec 17 decides.

Open `index.html` in a browser. It is drawn on the book's tokens and system (`../crew-bureau-2/`), and on the Intake drawing's stylesheet (`../intake-directions/asks/asks.css`), which the app's Intake is a port of. To do shows what the app draws today: Now, Signals and the foot.

Round Trip's look is kept: its faces, its motion, its pane and its trip in Done. What changed is the model, which is the plan's (#797). Finished and failed work stays in Tracking until the user marks it done, and never comes back to To do as a new signal.

## States by URL

Add `&theme=orient-express` for dark, and `&bar=off` to hide the drawing's bar.

| URL | Shows |
|---|---|
| `index.html` | 09:41, Intake. Tracking is folded at the foot of the list. The checks that failed on #1302 are open: a signal about a tracked Task, so its row wears Implement's face |
| `?state=finished` | Tracking opened. Rate-limit the public API is open: Review PR finished, and its Review step's structured output shows as fields |
| `?state=needs-you` | Upgrade the Stripe SDK: Implement asks to run `git push`, a Request answered in the row or in the pane |
| `?state=needs-you-signal` | Refunds for partial captures (PAY-212): checks failed on the agent's PR #1302, an open signal that names the Task. The pane shows a text output, the action step the run ended on, and Linked work |
| `?state=failed` | Nightly backup: Investigate failed, with permission denied on ops-db |
| `?state=working` | Lowercase SKUs: Fix bug is working |
| `?state=stopped` | Move invoices to the new PDF renderer: the user stopped Implement |
| `?state=done` | Done. Each handed-off signal shows its own leg. PAY-205 had two handoffs, so it has two rows and two legs |
| `?state=empty` | Nothing handed off: folded Tracking is its head and one line that says what it is for |
| `?state=zero` | Inbox zero while two rows still work. Those rows do not wait on the user, so To do is at zero |
| `?state=load` | Ten times the load, in Intake: 60 signals |
| `?state=load-tracking` | Ten times the load, in Tracking: 18 rows, 7 of them waiting |

The bar also plays the motion:

- **Finish:** Lowercase SKUs turns Finished and moves into the peek. It waits while the pointer is on the list.
- **Hand off:** the trailing-space signal lifts out of Signals and flies into Tracking.
- **Mark done:** Rate-limit the public API leaves.

## Either Intake or Tracking

The list column shows either Intake or Tracking, never both.

- **Folded,** Tracking lies over the foot of the list. On top is its head: "TRACKING 7", "4 wait on you" and "Show all ⌃". Under the head are the two rows that changed last, newest first. That is where a handoff lands, and it gives the eye something to click. The list keeps room under its last row for it.
- **Opened** (a click on the head, or `T`), Tracking covers the whole column under the title bar's hairline, view switcher included.
  - At the top: "‹ Intake", the title "Tracking 7" and "4 wait on you".
  - Then every row, grouped by state under the state's mark: Needs you, Failed, Finished, Working, Stopped.
  - At the foot: a row that sums up the signals ("SIGNALS 7", the sources' marks, "Back to Intake").
  - The open row is in the pane, as a normal detail pane.
- **Why an either-or:**
  - Two lists of the same rows in one column are hard to tell apart at ten times the load.
  - Opening Tracking says the user is looking at handed-off work and nothing else.
  - So while Tracking is open, `J` and `K` walk only its rows.
- **What waits on the user** is always counted on screen: in the head, "4 wait on you" is what Tracking adds to the To do count (7 signals and 4 waiting rows make 11).
- **Order:** Needs you, Failed, Finished, then Working, then Stopped. Inside a state, the oldest handoff comes first. Needs you leads because an agent or a source is blocked on the user. Finished comes last of the three because nothing is blocked.
- **Empty:** the head and one line: "Hand a signal to an agent, and follow it here until you mark it done."
- **Tabs:** Tracking belongs to To do, not to a tab. It shows the same rows on every tab, so it never moves when the user switches tabs.
  - Its waiting rows count in the global To do count and in the All tab's count.
  - A plugin's tab counts its own signals only.
  - A Task can have legs from several sources (PAY-212: Linear, then GitHub), so it has no one tab to count on.

### Explored in the session, and dropped

The other directions are on the branch [`prototype/tracking-focus`](https://github.com/theagenticage/hercule/tree/prototype/tracking-focus/docs/design/tracking), where `?focus=` switches between shelf, spotlight, drawer, desk and takeover, and `?motion=` between the three ways to open. In and out trays and Blotter are in that branch's history, at commit 238f524b7.

| Direction | Why it was dropped |
|---|---|
| Inline: Tracking as the last section of the list | The first draft. Two lists of the same rows run together, and the faces were missing |
| Shelf: a tray on its own surface | It separates well, but in dark it read as a hole |
| Spotlight: the list fades while the user works in Tracking | It is still one shared column |
| Drawer: a raised sheet in three sizes over the list | It draws too much attention |
| Desk: a dialog over the list and the pane | A modal over a split is one layer more than needed |
| In and out trays: two columns side by side | Too many columns |
| Blotter: Tracking as the pane's resting state | A detail pane that is not a detail pane, which the user reaches only by closing what is open. Takeover keeps its clean overview as an either-or |

Three ways to open Tracking were drawn: rise, unfold and depth. Rogier chose **rise**.

## The row

As Round Trip's: the face of the agent that has the work, in its pose (working, waiting, done, failed, or idle for stopped), the Task's title, and one line.

| State | Line |
|---|---|
| Needs you, a Request | the question, in marigold: "Run `git push -u origin chore/stripe-sdk-14`?", with Allow once, Always allow and Deny under it in three fixed slots |
| Needs you, a signal | "Checks failed on #1302", in marigold |
| Failed | "*Investigate* failed · permission denied on ops-db", in marigold |
| Finished | "*Review PR* finished", in green, on a green wash |
| Working | "*Fix bug* · Writing a failing test for a lowercase SKU": the agent's latest message |
| Working, on a subscription | "*Implement* · waiting for checks on #1311" |
| Stopped | "*Implement* · stopped by you" |

- The workflow's name is in its colleague's hue.
- The time on the right is how long the row has been in its state. It is bold, in marigold or green, when the row waits on the user.
- Mark done shows on hover over Finished, Failed and Stopped rows only. On Working and Needs you it would leave a run going.

**Finished is green.** Finished waits on the user and counts toward To do, like Needs you and Failed. But it is good news: the agent is done, and the work only needs a tick.
- So it is drawn in the book's green for what passed: its line in `--ok`, on a wash of `--ok-tint` at about half strength.
- #800 asked for Finished in marigold; Rogier changed that in the session.
- He compared four treatments: the full tint (too loud), a green check (too quiet), a green edge (too hard), and the wash. He chose the wash.

**Faces on signals.** A signal about a tracked Task, such as the checks that failed on the agent's PR, is led in Signals by that agent's face. Its source's mark moves to the start of its second line, as Round Trip drew what came back. A face on a row says at a glance that an agent has worked on it. Done does the same for every handed-off signal.

## The pane

Round Trip's: one trip, top to bottom, joined by a hairline.

- **The head:** the agent's face and name, the state, and "Open the run". Then the title, followed by when the state began, how long it ran, and the agent's harness, model and runner.
- **You asked:** the signal of the first handoff, with when it was handed to whom.
- **The agent's message:**
  - for Failed, the reason first, in tomato;
  - **What it did:** the output of the run's last agent step, named ("From the step *Review*"), drawn by its shape (below);
  - for Working, the latest step, live, in place of What it did;
  - for a Task with more than one run, its runs as steps;
  - the action step the run ended on, when the workflow did something itself after the agent ("Open a pull request · Opened draft PR #1302");
  - Linked work: the PR and its change line;
  - for a Request, the question and its answers, as Round Trip's run pane has them.
- **The signal that waits,** for Needs you by a signal: a third message in the trip, from the source, with "Open the signal".
- **The answers:**

| State | Answers (primary first) |
|---|---|
| Working, Needs you by a Request | Stop the run |
| Needs you by a signal | Try again, Mark done, Cancel (none suggested: Open the signal is the move) |
| Finished | **Mark done**, Try again, Cancel |
| Failed | **Try again**, Mark done, Cancel |
| Stopped | Try again, Mark done, Cancel |

**What it did, by the output's shape.** A workflow is the user's own, so there is no output contract: the pane draws what the step record holds ([spec 07 §4.3](../../spec/07-workflows.md)).

| The last agent step | Its output | Drawn as |
|---|---|---|
| has no `outputSchema` | `{ text, exitStatus }`, where `text` is the turn's final message | the text, as markdown, cut, with "Read the rest in the thread" (`?state=needs-you-signal`) |
| has an `outputSchema` | the JSON value the schema declares | its top-level fields, one ruled row each, labelled with the schema's `title` or else the property's name. A string, number or boolean shows as it is, a long string cut to two lines; a list shows how many items it holds, an object how many fields. Then "See the whole output in the run" (`?state=finished`) |

"The last message of the last agent step", as #797 and #803 had it, does not work for a step with a schema: on Codex the final message is the JSON itself, and on Claude and pi the last prose message is often narration before the structured result. A run that ends on an action step has no agent message after it at all.

Open the run is in the head on every state, so the list of answers leaves it out, as Round Trip's did.

A Task that is Needs you by a signal has no live run: its agent finished, and a source has since raised a signal about the work, such as checks failing on its PR. So Stop the run, decision 9's answer for Needs you, would stop nothing. The Task gets the answers of its last run's state instead.

## Done

Each handed-off signal's Done row is led by the face of the agent it went to. Its second line is its own leg, with no folding:

- "Handed to Implement → finished → continued: Fix bug"
- "Handed to Fix bug → tried again once → done"
- "Handed to Review PR → finished", where the Task is still open. The line ends with its Tracking state: in marigold when the state is Needs you or Failed, in green when it is Finished.

The pane draws the leg as Round Trip's trip: one line per step, with its time and who took it. Under it: "Go to Tracking", which opens Tracking on the Task while it is open, or "Open the run" once it is closed.

## Keys

| Key | Does |
|---|---|
| `J` / `K`, `↓` / `↑` | moves down and up: through Now and Signals in Intake, through Tracking's rows while Tracking is open |
| `T` | opens and closes Tracking |
| `↩` | opens the pane and puts focus on the suggested answer; a second `↩` presses it |
| `E` | marks a Finished, Failed or Stopped row done; does nothing on Working or Needs you |
| `O` | opens the run |
| Esc | steps back: the pane, then the selection, then Tracking |

## New design tokens

None. Round Trip had two: `--unseen` went with the unseen dot, and `--trip-line` was `--line` under another name.

## Motion, and what it costs

Every motion:
- is `transform` or `opacity` on an HTML element;
- plays once, and only for rows on screen;
- stops with Reduce motion.

A change the user did not make waits while the pointer is on the list column.

| Motion | How | Cost |
|---|---|---|
| Tracking opens | the sheet rises from where folded Tracking stood, in 240ms, with a slight spring (`cubic-bezier(0.3, 1.2, 0.5, 1)`); its head, sections and rows cascade in, 16ms apart from 60ms, each over `--dur-2` | one animation for the sheet, plus one per part on screen (at most 13), done within 450ms |
| Tracking closes | the sheet drops back in 180ms, easing in | one animation |
| A handoff | a lifted copy of the signal's row (`--shadow-2`) flies from Signals to the top of folded Tracking, over `--dur-3`; the rows below in Signals close up | one animation for the copy, plus one transform per row that moves on screen |
| A row changes state (Working → Finished) | its line fades in anew over `--dur-2`; when its place changes, the rows between slide over `--dur-3` | one opacity animation, plus one transform per row that moves |
| A row is marked done or cancelled | it fades over `--dur-1`, then the rows below close the gap over `--dur-3` | as Intake's own Done |
| A Working row's line changes | the new line fades in over `--dur-2` | one opacity animation per new agent message, only for rows on screen. See below |

The Working row's line is the agent's latest message, which the `session` topic already brings. It is the one per-message cost Tracking adds, and slice 1 measures it. Rogier keeps it for now. He is open to dropping it, and showing the workflow name alone, if it proves complex or costly.

No loop runs, faces in lists are still, and the times read the shared age clock once a minute.

## Left out of Round Trip

- The `result` signal, and the row that lifts back into To do. Finished and failed work stays in Tracking.
- Send back with a note, Take over, Undo, Edit, confidence and the structured results. The pane shows the agent's last message instead.
- The unseen dot, and folding results at load. [`DECISIONS.md`](https://github.com/theagenticage/hercule/blob/prototype/stay-in-the-loop/docs/design/stay-in-the-loop/DECISIONS.md) says why.
- Later, Everything and the Triage tab are as Intake has them today, and are not drawn.
