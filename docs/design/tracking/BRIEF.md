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

*(Amended 2026-10-20, [#801](https://github.com/theagenticage/hercule/issues/801).)* Slice 1 does not build three of these lines as drawn. The agent's latest message is not available: no field, read or push carries it, and the `session` topic does not bring it. The Working row reads "*Fix bug* · working" until a follow-up ticket adds a server-kept field for it. A Stopped row reads "*Implement* · stopped", because a run summary does not say who cancelled the run. A Working row that only waits on signal triggers reads "*Implement* · waiting for checks_passed", with the awaited trigger ids, because "waiting for checks on #1311" needs the run's plan and inputs, which the summary does not carry.

*(Amended 2026-10-21, [#802](https://github.com/theagenticage/hercule/issues/802).)* Slice 2 builds Needs you, and the app knowingly differs from the drawing in two places:
- A Needs you row by a Request shows the question in plain text ("Run git push?"), not the command in monospace, and has no Allow once, Always allow or Deny under it. Those answers wait for the pane ticket [#803](https://github.com/theagenticage/hercule/issues/803) or a follow-up. The user opens the thread to answer.
- A Needs you row by a signal reads "*Kind* on *place*", with the signal's own place: "Checks failed on payments-api #1302", not "Checks failed on #1302". The place is the one the signal carries, and the app does not shorten it.

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
  - for a Task with more than one run, or whose newest run is live, its runs as steps (a single run that has ended draws none);
  - the action step the run ended on, when the workflow did something itself after the agent ("Open a pull request · Opened draft PR #1302"), only for a newest run that completed;
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

**What it did, by the output's shape.** A workflow is the user's own, so there is no output contract: the pane draws what the step record holds ([spec 07 §4.3](../../spec/07-workflows.md)). Most workflows give their agent steps an `outputSchema`, so a structured value is the common case. A step without one, such as a workflow of a single agent step that just reports back, falls back to the agent's final message.

| The last agent step | Its output | Drawn as |
|---|---|---|
| has an `outputSchema` (the common case) | the JSON value the schema declares | its top-level fields, one ruled row each, labelled with the schema's `title` or else the property's name. A string, number or boolean shows as it is, a long string cut to two lines; a list shows how many items it holds, an object how many fields. Then "See the whole output in the run" (`?state=finished`) |
| has no `outputSchema` (the fallback) | `{ text, exitStatus }`, where `text` is the turn's final message | the text, as markdown, cut, with "Read the rest in the thread" (`?state=needs-you-signal`) |

The agent's last message alone, as #797 and #803 first had it, is not enough for a step with a schema: on Codex the final message is the JSON itself, and on Claude and pi the last prose message is often narration before the structured result. A run that ends on an action step has no agent message after it at all.

Open the run is in the head on every state, so the list of answers leaves it out, as Round Trip's did.

A Task that is Needs you by a signal has no live run: its agent finished, and a source has since raised a signal about the work, such as checks failing on its PR. So Stop the run, decision 9's answer for Needs you, would stop nothing. The Task gets the answers of its last run's state instead.

*(Amended 2026-10-21, [#803](https://github.com/theagenticage/hercule/issues/803).)* Slice 3 builds the pane, and the app knowingly differs from the drawing in these places:
- The head's standing line has no harness, model or runner. No read carries them. The line is "Finished at 09:20 after 8m", "Failed at 09:26 after 6m", "Stopped at 08:47", "Started at 09:33 · 8m so far" or "Waiting on you since 09:33".
- A Stopped row never says "by you". No field says who stopped the run.
- What it did shows on every row that is not Working, when its run is the Task's newest run, whether or not that run has ended: a Needs you row that waits on a Request of a live newest run shows the output of the run's last completed agent step, as the `?state=needs-you` drawing does, as context for the question. The action step the run ended on never shows for a live run, because the controller sets it for a completed run only. A row that names an older run shows neither.
- The action step the run ended on shows the step's name only. No record keeps a summary of what an action step did, so there is no "Opened draft PR #1302".
- A Request's Allow once, Always allow and Deny are not in the pane. The card has "Open the thread", where the thread's own answers are.
- There is no foot line ("Leaves Tracking when...") and no fine print under the answers, as Intake's own pane has none.
- A missing value in a field of the output reads "none".
- Try again is built ([#804](https://github.com/theagenticage/hercule/issues/804)), with the order and the suggestion in the table above. Linked work is not drawn until [#807](https://github.com/theagenticage/hercule/issues/807), and the pane draws no placeholder for it.
- Mark done follows one rule: it is an answer, and `E` presses it, when no run of the Task is live and the row does not wait on a Request. So a Needs you row that waits on a signal has Mark done and Cancel while its agent has finished, with none suggested, as the table above has it. A Failed row suggests Try again and a Stopped row suggests nothing, so `↩` never marks a failure done. The row's own Mark done control on hover follows the same rule.
- Cancel sets the Task `cancelled`, which takes the row off Tracking as Mark done does.
- Stop the run keeps the run's workspace, and the pane asks nothing. The row stays in Tracking as Stopped.
- A failed Stop shows its error under its button, and a failed Mark done or Cancel shows it in the toast's place.

## Done

Each handed-off signal's Done row is led by the face of the agent it went to. Its second line is its own leg, with no folding:

- "Handed to Implement → finished → continued: Fix bug"
- "Handed to Fix bug → tried again once → done"
- "Handed to Review PR → finished", where the Task is still open. The line ends with its Tracking state: in marigold when the state is Needs you or Failed, in green when it is Finished.

The pane draws the leg as Round Trip's trip: one line per step, with its time and who took it. Under it: "Go to Tracking", which opens Tracking on the Task while it is open, or "Open the run" once it is closed.

*(Amended 2026-10-22, [#805](https://github.com/theagenticage/hercule/issues/805).)* Slice 5 builds Done's trip, and the app knowingly differs from the drawing in these places:
- The pane has no "This handoff" step timeline and no foot line ("Each signal you hand off shows its own leg ..."). It draws the trip in the outcome instead (see below). The reads hold no actor for a stop or a tick-off, and the ticket asks for the line and where opening it goes. A later ticket can add the timeline.
- A Working row that only waits on a signal trigger ends its line with "working", not "waiting for checks" (the drawing's d-checkout). The leg and the Tracking rows do not carry the awaited trigger, and slice 1 already draws that row's line as "waiting for *ids*" in Tracking.
- "Go to Tracking" shows whenever the Task is in progress and has a row in Tracking, for every leg of it, the earlier ones too. "Open the run" shows once the Task is done or cancelled, or has no row, and opens the leg's newest run. Opening Tracking from Done shows To do.
- A Tracking row ends a trip only when it is for the leg's Task, its newest handoff is this leg's, the leg has no next, its newest run is the leg's newest run in the same state, and its live runs are exactly the leg's live runs. When another leg of the Task has a live run, the live runs differ, so the line ends the same way. Otherwise the line ends on the leg's own standing, uncoloured, because Done and Tracking were read at different moments.
- The pane's differences from the drawing:
  - The pane's outcome block is one block: label "What you did", the trip as its bold-then-regular headline ("Handed to Fix bug → tried again once → done"), the moment line, then the button in the text column. The drawing has the trip in the subtitle under the title and the timeline below it.
  - The pane's header line reads "GitHub · Checks failed" / "<asker> asks in <place> · <time>" (the app's own pane header, same as To do), not the drawing's "GitHub · webshop #1291" with the trip as subtitle.
  - The Split checkout row reads "working" where the drawing says "waiting for checks", as the second difference above says.
  - Investigate's face (the Nightly backup row) is the app's own face for that workflow id, not the drawing's.
  - The section heading counts its rows: "Today 10" (the app's existing count chip).
  - The app's pane foot also lists "Esc close"; the drawing's foot has no Esc entry. The app's foot is the same on every pane.
  - Window chrome, sidebar contents and counts differ (the specimen's own sidebar fixture). The Done list's rows beyond the first three have the same text and faces as the drawing.

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

The Working row's line is the agent's latest message. *(Amended 2026-10-20, [#801](https://github.com/theagenticage/hercule/issues/801): the `session` topic does not bring it, as this brief first said, and no field carries it. Slice 1 does not build the line, so it adds no per-message cost; a follow-up ticket adds the field and measures the cost.)* It is the one per-message cost Tracking would add. Rogier keeps it for now. He is open to dropping it, and showing the workflow name alone, if it proves complex or costly.

No loop runs, faces in lists are still, and the times read the shared age clock once a minute.

## Left out of Round Trip

- The `result` signal, and the row that lifts back into To do. Finished and failed work stays in Tracking.
- Send back with a note, Take over, Undo, Edit, confidence and the structured results. The pane shows the agent's last message instead.
- The unseen dot, and folding results at load. [`DECISIONS.md`](https://github.com/theagenticage/hercule/blob/prototype/stay-in-the-loop/docs/design/stay-in-the-loop/DECISIONS.md) says why.
- Later, Everything and the Triage tab are as Intake has them today, and are not drawn.
