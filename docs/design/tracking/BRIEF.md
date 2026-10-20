# Tracking: the drawing

The pixel reference for Tracking, the section at the foot of Intake's To do that follows the work the user handed to agents until they mark it done ([spec 17 §Intake](../../spec/17-desktop-app.md#intake), [ADR 0046](../../adr/0046-handing-a-signal-off-tracks-the-work-on-a-task.md), map [#797](https://github.com/theagenticage/hercule/issues/797)). Drawn in the design session [#800](https://github.com/theagenticage/hercule/issues/800), from Round Trip on the branch [`prototype/stay-in-the-loop`](https://github.com/theagenticage/hercule/tree/prototype/stay-in-the-loop/docs/design/stay-in-the-loop).

Where this drawing and spec 17 disagree, spec 17 decides.

Open `index.html` in a browser. It is drawn on the book's tokens and system (`../crew-bureau-2/`) and on the Intake drawing's stylesheet (`../intake-directions/asks/asks.css`), which the app's Intake is a port of. To do shows what the app draws today (Now, Signals, the foot) with Tracking added.

## States by URL

Add `&theme=orient-express` for dark, and `&bar=off` to hide the drawing's bar.

| URL | Shows |
|---|---|
| `index.html` | 09:41. Tracking holds seven rows in all five states; Rate-limit the public API is open, Finished |
| `?state=needs-you` | Upgrade the Stripe SDK: Implement asks to run `git push` (a Request) |
| `?state=needs-you-signal` | Refunds for partial captures (PAY-212): checks failed on its PR #1302, an open signal that names the Task. The pane shows Linked work |
| `?state=failed` | Nightly backup: Investigate failed, permission denied on ops-db |
| `?state=working` | Lowercase SKUs: Fix bug is working |
| `?state=stopped` | Move invoices to the new PDF renderer: the user stopped Implement |
| `?state=done` | Done: each handed-off signal shows its own leg. PAY-205 had two handoffs, so two rows, two legs |
| `?state=empty` | Nothing handed off: To do as it is today, with no Tracking section |
| `?state=zero` | Inbox zero while two rows still work: they do not wait on the user, so To do is at zero |
| `?state=load` | Ten times the load: 60 signals, 18 Tracking rows, 7 of them waiting, scrolled to Tracking |

The bar also plays the motion: **A run finishes** (Lowercase SKUs turns Finished; it waits while the pointer is on the list), **Hand off** (the trailing-space signal goes to Fix bug and arrives in Tracking) and **Mark done** (Rate-limit the public API leaves).

## The section

- **Where:** the last section of To do, after Signals, in the same scrolling list. Not a tray docked under the list, as Round Trip had: Tracking's waiting rows count toward To do, so they are items to work through like signals, `J` and `K` walk on into them, and one list has one scroll and one virtualizer. A hairline above the head, as the foot's, sets it apart from the signals. The foot ("7 cleared today") stays at the end, under Tracking.
- **Only while it holds a row,** as Now. Someone who never hands off sees no change. The first handoff shows where it went: the signal leaves, and the row arrives in the new section.
- **The head:** "Tracking", the number of rows, and on the right "4 wait on you" in marigold. The right-hand number is what Tracking adds to the To do count, so the arithmetic is on screen: 7 signals and 4 waiting rows make 11.
- **The order:** Needs you, Failed, Finished, then Working, then Stopped; inside a state, the oldest handoff first. The rows that wait on the user come first, as Back rows lead Signals.

## The row

A Tracking row is a signal row: 52px, two lines, cut with an ellipsis, so it virtualizes and animates as signal rows do.

- **Mark:** the source the work came from, from the Task's first handoff (`linear:…` gives Linear).
- **Title:** the Task's title.
- **Second line:** the state's word, the workflow, then a detail when there is one:
  - "**Needs you** · Implement · asks to run `git push`"
  - "**Needs you** · Implement · checks failed on #1302"
  - "**Failed** · Investigate · permission denied on ops-db"
  - "**Finished** · Review PR"
  - "**Waiting for checks** · Implement · #1311"
  - "**Working** · Fix bug"
  - "**Stopped** · Implement"
- **Marigold:** Needs you, Failed and Finished wait on the user and count toward To do, so their word is `--you-ink`, as everything addressed to the user is in the book. Failed is marigold too, not tomato: what matters on the list is that it waits on the user. Working and Stopped do not wait: their word is ink, their title regular weight and their mark faded, as the quiet rows Intake draws for work that is not the user's.
- **Time:** how long the row has been in its state.
- **The row's control:** Mark done (the Done check), on hover and focus, on Finished, Failed and Stopped only. On Working and Needs you a tick-off would leave a run going. No Snooze and no checkbox: a Task is not snoozed, and bulk acts on signals.

## Tabs and counts

- **Tracking shows on the All tab only.** A plugin's tab filters signals by source. A Task can have legs from several sources (PAY-212: Linear, then GitHub), so it has no one tab, and showing it on each would count it twice.
- **What the plugin tabs miss is already there:** the follow-up that makes a row Needs you is an ordinary signal, and it shows on its own tab (checks failed on #1302 is on GitHub's tab).
- **Counts:** Tracking's waiting rows count in the global To do count (the Hercule segment and Intake's row) and in the All tab's count. A plugin tab counts its own signals only. Example: 7 signals and 4 waiting rows; All shows 11, GitHub 4.

## The pane

Top to bottom: the state and "Tracking"; the title and a sentence about the state; for Needs you, what waits (the Request, or the signal, with the way to it); for Failed, the failure reason; **You asked** (the signal of the first handoff); **Runs**; **What it did** (the last message of the last agent step); **Linked work** (once #807 lands PRs on Tasks); the answers.

| State | Answers (primary first) |
|---|---|
| Working, Needs you | Stop the run, Open the run |
| Finished | **Mark done**, Try again, Cancel, Open the run |
| Failed | **Try again**, Mark done, Cancel, Open the run |
| Stopped | Try again, Mark done, Cancel |

## Done

Each handed-off signal's Done row shows its own leg as its second line, with no folding:

- "Handed to Implement → finished → continued: Fix bug"
- "Handed to Fix bug → tried again once → done"
- "Handed to Review PR → finished", where the Task is still open: the line ends with its Tracking state, in marigold when it waits on the user.

The pane draws the leg as a short trip, one line per step with its time.

## Keys

| Key | Does |
|---|---|
| `J` / `K`, `↓` / `↑` | move down and up, through Now and Signals and on into Tracking |
| `↩` | opens the pane and puts focus on the suggested answer; a second `↩` presses it |
| `E` | marks a Finished, Failed or Stopped row done; nothing on Working or Needs you |
| Esc | closes the pane, then clears the selection |

## New design tokens

None. Marigold (`--you`, `--you-ink`), the state marks and the faces are the book's; the leg's line in Done is `--line`.

## Motion, and what it costs

Every motion is `transform` or `opacity` on an HTML element, plays once, only for rows on screen, and stops with Reduce motion. A change the user did not make waits while the pointer is on the list.

| Motion | How | Cost |
|---|---|---|
| A row changes state (Working → Finished) | its second line fades in over `--dur-2`; when its place changes, it and the rows between slide over `--dur-3` | one opacity animation, plus one transform per row that moves on screen, once per change |
| A row is marked done or cancelled | it fades over `--dur-1`, then the rows below close the gap over `--dur-3` | as Intake's own Done |
| A handoff arrives | the signal leaves as on Done; the new row fades in and drops 6px over `--dur-2`, the rows below make room | as a new signal's arrival |

No loop runs, faces in the list are still, and the row's time reads the shared age clock, once a minute.

## Left out

- Round Trip's `result` signal, Send back with a note, Take over, Undo, the unseen dot and folding rows at load. [`DECISIONS.md`](https://github.com/theagenticage/hercule/blob/prototype/stay-in-the-loop/docs/design/stay-in-the-loop/DECISIONS.md) says why.
- Later, Everything and the triage tab are as Intake has them today, and are not drawn.
