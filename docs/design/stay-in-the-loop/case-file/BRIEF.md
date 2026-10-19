# Case File - design brief

PROTOTYPE. One of four directions for "stay in the loop". The shared brief is `../BRIEF.md`.

## Problem and lever

A handoff today is a door that closes: the signal leaves To do at the click, and the work behind it
lives in a run page, a transcript and the source, three places Rogier has to hunt through. He has no
single thing to look at that says "this is what you asked for, this is what came of it, and this is
what it needs from you".

**Lever: every handoff opens a case Rogier can follow, and rewind.** A case is one vertical trail of
the work's whole life, from what came in to what the world did with the result.

## Principles

1. **One object per handoff.** The case, not the run, not the signal. It outlives both: it holds
   every attempt, Rogier's verdict and the source's end.
2. **The trail is about intent and result, never execution.** The agent's own one-line notes, the
   result drawn by its kind, how sure it is. Tool calls fold behind the transcript's divider; the
   graph stays on the run page, one click away.
3. **Open at the current station, scroll up to rewind.** A case opens where it waits on Rogier: the
   question, the result, the verdict. What came before is above it, folded to one line each.
4. **The shape of the story is always visible.** Stations still to come are drawn faintly on a
   dotted rail, so a working case already shows where its result, his verdict and the end will go.
5. **Nothing outward without his click, and the trail says so.** Every outward answer is a ledger
   row with its describe line. Anything the agent did on its own names the grant that allowed it.

## Who and when

- **Between things, curious:** the sidebar's Cases row shows how many cases wait on him. J and K
  walk the list; the trail tells the story in five seconds.
- **When a case asks:** a question mid-run (H6's git push, attempt 2's Stripe question) is answered
  in the trail, where it happens, with the notes that led to it right above.
- **When it lands:** the result is drawn as what it is (a review, a pull request, a letter,
  findings), with the agent's confidence and doubts set apart, and the verdict ledger under it.
- **When he dislikes it:** Send back adds an attempt with his note pinned at its head; Compare puts
  the attempts side by side, word by word.
- **Later, for trust:** a closed case keeps the whole story. H2's cause links to yesterday's case
  for #1287, and that case links forward to today's regression.

## Key interactions

| Key | Does |
|---|---|
| `J` `K`, `↓` `↑` | next or previous case (bundles too, at 10x) |
| `[` `]` | previous or next attempt |
| `S` | puts focus on the suggested answer, its row highlighted; `↩` presses it. Never answers in one press |
| `B` | Send back (on a failed case: Try again), opens the note box; `⌘↩` sends it |
| `T` | Take over: opens the run's thread, the case closes as "Taken over" |
| `C` | Compare attempts (once two have landed) |
| `O` | opens the signal on its source |
| `Esc` | closes compare, the note box, or the focused answer |

A landed case counts as seen after it has been open for 2 seconds, so walking the list with J and K
does not clear every dot.

## States, mapped to the shared lifecycle

| Shared state | In Case File |
|---|---|
| Handed | the "You handed it to Review PR" station; the case appears under **Working** |
| Working | working face (the only looping animation, open case only), live notes with an ellipsis, a ticking age; group **Working** |
| Needs you | `waiting` mark, marigold question panel with the ledger inside the run station; group **Needs you** (marigold) |
| Landed | `done` face, marigold unseen dot on the row and a "New" chip on the Landed station; group **Awaiting your verdict** |
| Seen | the same, without the dot |
| Signed off | the "Signed off" chip on the verdict station; group **Signed off** while it waits on the source, then **Closed today** |
| Sent back | the attempt ends with "You sent it back" and the note; the case returns to **Working** as attempt 2 |
| Taken over | "Taken over" on the verdict; group **Closed today** |
| Undone | the "Undo: dismisses your review on #1294" link under a verdict; the case returns to **Awaiting your verdict** |
| Failed | `failed` face and mark, the reason ruled in tomato, what was left behind, then "Your call": Try again with a note, Take over, Let it go |
| Closed by the source | "In the world" lists the source's events after the verdict; the ending one closes the case ("Closed by GitHub at 09:30") |
| Empty | one calm line, a ghost row, and the six stations as a ghost trail |
| Swarm | the list bundles a colleague's cases of one kind into one row: 38 handoffs in 13 rows. A bundle opens a batch page, with one verdict for all 4 reviews |

## What it deliberately does not do

- It is not a run log: no step list, no graph, no transcript. "Open run" and "Open thread" lead there.
- It does not put anything back on Intake's To do. Intake still ends at the click.
- It adds no new state mark and no notification. The sidebar row's count is the only ambient signal.
- It does not let the agent close a case. Only the source's end, or Rogier's "Close it now", does.

## What changes in the spec

- **A new record, the Case** (spec 10 §9.6 stays true). Intake's job still ends at the click; the
  click now also creates a Case, keyed by the signal: `{ signalId, seenAt, verdict { actionId, at,
  actor }, closedAt, closedBy (eventId or user) }`. Everything else is read: the runs, their
  results, the events. Cost: one table, one live topic (`case`), and a new route.
- **Attempts are runs linked to the case, with a note.** Send back starts a new run of the same
  workflow with the same signal input plus a reserved optional input, `note`. It is not a Re-run
  (CONTEXT.md: a Re-run reuses the resolved inputs and takes no note). The run carries
  `attemptOf: <runId>`. The same `note` input lets Hand to an agent take an optional note (H4), which
  spec 10 §9.4 does not allow today: only the signal input is filled.
- **Results become blocks.** A run that ends a case returns typed result blocks, reusing spec 10
  §9.5's palette and growing it: `reviewDraft`, `pullRequest`, `mailDraft`, `findings`, and
  `confidence { level, why, unsure[] }`. The verdict's answers are Bound Actions frozen with the
  result, as a signal's are (ADR 0022).
- **Undo is declared, never guessed.** A plugin action may name an `undo` operation (`pr.review` →
  dismiss, `message.reply` in Slack → delete). With none, the verdict says "Sent mail can't be taken
  back".
- **Closed by the source reuses ends on the source** (spec 10 §9.6). The ingest already matches
  events to open signals by thread; after the verdict it also matches the case's refs: the signal's
  thread and every ref the run produced (#1302 is not in Pieter's Slack thread). Each plugin kind
  declares its case ends (pull request merged or closed, the asker replies, Sentry resolved). Risk:
  a reply that is not an end ("thanks, one more thing") would close it; the user can reopen.
- **A failed run surfaces on desktop v1.** `core.run-failed` still goes to Check-in; the case shows
  the failure too, because Check-in is post-v1 on desktop.
- **The grant line.** When a run acted outward under a grant without a click (H2's draft pull
  request, H5's push), the core writes the line that names the grant.
- **The Hercule face gains a Cases row** under Intake, its count in marigold: cases that need him
  plus cases awaiting his verdict. Waiting on you's "From runs" also lists a case's question.

## New design tokens

| Token | Value | Why |
|---|---|---|
| `--cf-list-w` | 352px | the case list keeps a face, a two-line title and the trail glyph, and leaves the open case the width its result needs |
| `--cf-rail` | 32px | every station's node is this wide, and the rail's line runs down its middle |
| `--cf-col` | 680px | a letter, a diff and the verdict ledger fit without wrapping their key lines |

Everything else is Crew Bureau 2: `.card`, `.ans`, `.chip`, `.seg`, `.worked`, marks and faces.

## Motion, and what it costs on desktop

All one-shot motion is `transform` and `opacity` on HTML elements, at most `--dur-3`, and stops with
Reduce motion.

| Motion | When | Cost |
|---|---|---|
| The working face's paws | only the open case's live run, while it works | the one continuous animation the spec allows, the same as the open thread's |
| A note arrives | each new note in the open case | one element, `--dur-2` |
| A row changes group | a landing, a question, a close | one row, `--dur-2`, rows on screen only |
| The Landed station appears, and the pane follows it | the open case lands | one element, `--dur-3`, then a compositor scroll |
| The case opens | J, K or a click | the column, 4px rise and fade, `--dur-2` |
| The toast | a case not open lands or asks | `--dur-2` in, one 5-second timer |
| Ages and elapsed time | while on screen and visible | the shared age clock (rule 4), no timer of its own |
| Seen | 2 seconds after a landed case opens | one one-shot timer |

Faces in the list and marks everywhere stand still. Nothing pulses.

## Effort to build for real

- **Core:** the Case table and `case` topic; the `note` input and `attemptOf`; result blocks and
  confidence; declared undo; case ends matched on the case's refs; the grant line. **L.**
- **client-core:** `groupCasesByWhatTheyAsk`, `describeCaseRow`, `buildTrail` (stations, folding,
  the current station), `diffAttemptWords`, `bundleCases` for the swarm, each with tests. **M.**
- **Renderer:** the `/cases` route as its own chunk, a virtualized list, the trail, the result
  blocks, compare, the Cases row and its count. **L.**
- **Overall: XL.** Riskiest part: honest typed results. The trail is only as good as what the
  agent returns: a real review draft, a real confidence with its doubts. Agents that return prose
  leave a case with nothing to draw. Second: matching the source's end on refs the run created.

## URLs

From `index.html` (add `&theme=orient-express` for dark, `&bar=off` to hide the prototype bar):

- default: the top case, H6 needing a git push
- `?state=working` H4 live · `?state=landed` H1 unseen · `?state=seen` H2 with the #1287 cause
- `?state=redo` H3 with the send-back note typed · `?state=attempt2` attempt 2 asking about Stripe
- `?state=compare` attempts 1 and 2 side by side
- `?state=failed` H5 · `?state=retry` H5 with the note typed
- `?state=closed` H1 signed off and closed by GitHub
- `?state=empty` · `?state=swarm`
- `?case=y1` yesterday's #1287, linking forward to today's regression
