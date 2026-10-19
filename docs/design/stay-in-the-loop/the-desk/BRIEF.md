# The Desk - design brief

PROTOTYPE. One of four directions for "stay in the loop". Open `index.html` (1440x900).

## Problem, and the lever

Rogier hands a signal to an agent and the signal leaves Intake at the click. The result comes back
nowhere: it sits in a run's page, a transcript, a Gmail draft. Finding out costs a hunt per handoff,
and a failed run tells nobody. The fix must not swap the hunt for a stream of pings: five handoffs a
morning would become five interruptions.

**Lever: results land on your desk, and you sign them off when you sit down.** Batching, made
physical in the Office's own language.

## Principles

1. **Pull, not push.** A landed result waits in the in-tray. Only a Request from running work (an
   approval such as "Run git push?") rings the bell.
2. **The paper is the result.** The draft is a letter on letterhead, the pull request a memo with its
   diff, findings a short report, each sealed with the colleague's confidence (HIGH or MEDIUM) and
   what it wasn't sure about pinned on top. No hunting through a transcript.
3. **Every press says what it does first.** Every answer is a ledger row (button, the core's describe
   line, key) in the same columns. Anything that acts outside Hercule needs ⌘↩; a plain key never
   sends anything.
4. **Signed off is a state you can see.** The out-tray holds today's; the trust ledger holds 30 days.
5. **Trust is earned and written down.** After 15 unchanged sign-offs in a row, Hercule offers to stop
   asking, says what that is underneath, and waits for the click.

## Who and when

Rogier, at moments he picks: after a focus block, before lunch, at the end of the day. He opens
Office › Your desk (sidebar row, or Sit down on the floor), clears the tray by keyboard, gets up.
The bell is the one thing that reaches him between those moments.

## Key interactions

| Key | Does |
|---|---|
| J / K | Next / previous folder in the in-tray; opening marks it seen |
| ⌘↩ | The suggested answer: post, merge, send or hand on, and sign off. Its describe line is on screen; holding ⌘ marks the row |
| S | Sign off, nothing sent (on a failed folder: Let it go) |
| B | Send back (Try again with a note on a failed one): a note slip clips to the folder, ⌘↩ sends |
| T | Take over: the run's thread is Rogier's from here |
| E | Edit first: the draft's words become editable; signing off then counts as changed |
| Space | Turns the folder over: the signal as Rogier was asked, and its trail |
| D | On a 2nd draft: changes from the 1st, word by word |
| N | Answer the bell (focus moves into its card) |
| Esc | Steps back: bell, slip, edit, flip, filed folder, then to the floor |

Clicking an out-tray row reopens a filed folder read-only, with Undo where the outside world allows
it (Dismiss review, Revert #1302, Delete the answer) and an honest "can't be undone" for a sent mail.
Nothing that was only signed off is lost: Put it back returns it to the tray.

## States (mapped to the shared lifecycle)

| Lifecycle | On the desk |
|---|---|
| Handed | Not drawn here: Intake's click. The colleague appears on the Out board |
| Working | Out board: working face, one live line, time out |
| Needs you | Out board: raised hand, line in marigold. The bell rings once and its card drops in; keyboard focus stays on the folder |
| Landed | A folder on top of the in-tray: `done` mark plus a marigold dot |
| Seen | Same folder, no dot |
| Signed off | Stamped, filed in the out-tray with its outcome line ("Review posted on #1294") |
| Sent back | Leaves with its colleague for the Out board; returns with a "2nd draft" tab |
| Taken over | Filed as "Taken over in its thread" |
| Undone | Out-tray row reopened, Undo taken; the row says what was undone |
| Failed | Folder with a tomato tab and a torn corner; Try again with a note · Take over · Let it go |
| Swarm | The tray bundles: "Review PR · 6, all high confidence" signs off in one ⌘↩; "Failed · 3" opens one by one. 12 results, 5 rows |
| Empty | One calm line on the blotter; dashed outlines show where folders and answers would lie |

## What it deliberately does not do

- No notification per landing, no badge on the dock, no toast when something lands.
- No auto sign-off. Nothing leaves the tray without a key or a click.
- No new state marks: `done`, `failed`, `waiting`, `working` plus the marigold dot.
- Intake is not touched: a handed signal still leaves To do at the click.

## What changes in the spec

- **Spec 10 §9.4 and §9.6 stay true for Intake** (the signal still resolves at the click), but the
  desk takes over what follows. A run started by Hand to an agent gets a **sign-off state**
  (`landed | seen | signedOff | sentBack | takenOver`), actor-stamped. Done's read-only run state
  then reads "Signed off 09:43". Cost: a new field and operations (`run.signOff`, `run.markSeen`),
  each with a CLI row.
- **A failed handed run lands on the desk**, not only as `core.run-failed` in Check-in (post-v1 on
  desktop). This contradicts §9.4's "goes to Check-in" for handed runs; the desk is that Check-in for
  handoffs, so Check-in should not get a second copy.
- **Send back and Try again are Re-runs with a note.** CONTEXT.md's Re-run reuses the ended run's
  inputs; this needs one more input, the note, so a Re-run gains `note?` (and the "2nd draft" is the
  new run, `originalRunId` set). Cost: a contract change and a prompt convention for the note.
- **Next actions are Bound Actions on the result** (ADR 0022 holds): a workflow's output declares
  them, the core writes the describe lines. "Post and sign off" is one bound operation plus the
  sign-off stamp, not two operations.
- **The trust offer is a core-only offer**, like the Ignore Rule offer. It is not a permission grant
  (the shared brief calls it one): underneath it is an edit to the workflow, adding an action step
  `github/pr.review` as GitHub · rogier. Spec 07 says a workflow's action steps run with the user's
  parity and `connection.use` is checked when the workflow is saved, so Rogier's click, saving the
  edit, is the authorisation. Only the core may bind it, because no producer's wording should put a
  standing "act without asking" one click away.
- **The Office (spec 17 §The Office)** draws live sessions only. New: Your Office gets a desk view
  (`/office/desk`); the floor draws a pile on Your desk and a colleague carrying a result there when
  its run lands. The Office already queues Requests at Your desk, so the two read as one place.
- **Vocabulary:** CONTEXT.md lists "folder" under Topic's Avoid. The UI never says folder: it says
  result, in-tray, out-tray. Folder is only the drawing.

## New design tokens

All in `the-desk.css`, set on `:root` so papers inherit finished colours:

| Token | Value | Why |
|---|---|---|
| `--dk-lacquer` | `--room-inlay-2`; dark themes mix in 26% `--room-fabric` | Your desk's lacquer; the plain value vanishes on Orient Express's page |
| `--dk-blotter` | the Office's blotter mix | the surface under the open folder |
| `--dk-leather` | `--room-fabric` | the blotter's corners |
| `--dk-sheet` | `--room-paper`, 6% toward shade in dark | paper that never glares in a dark theme |
| `--dk-manila` | 38% `--room-cork` into paper | folders and filed rows |
| `--dk-tray`, `--dk-tray-floor` | `--room-wood`, and 28% toward shade | the trays' rim and floor |
| `--dk-stamp-ink` | `--accent-ink` | the lacquer stamp |

Papers, folders and labels carry `data-theme="whitehaven"`: their ink stays dark in every theme.

## Motion and what it costs

Every motion is transform and opacity on HTML elements, one shot, at most `--dur-3` a step:

| Motion | Steps | Cost |
|---|---|---|
| Stamp, then the copy flies to the out-tray | 200ms spring, 220ms hold, 320ms | one cloned layer for 0.74s per sign-off; the next folder is drawn underneath at once, so keys never wait |
| A result lands | a small folder flies from the Out board to the tray, 320ms; folders below slide 200ms | per landing, rows on screen only; held while the pointer is over the tray |
| Send back | slip rises 200ms; folder flies to the Out board 320ms | per press |
| Flip | rotateY over 320ms | per Space |
| Bell rings | the bell swings once, card drops 200ms | per Request, rare by design |
| Floor ↔ desk | scale and fade, 320ms | per switch |

Loops: only the working faces on the Out board. Blink and the raised hand's wave are switched off.
In the book they are SVG animations; the app draws the paws in HTML spans (spec 17 rule 2).

## Effort to build for real: L

- **Core:** sign-off state on runs started from a signal, `run.signOff` / `run.markSeen`, Re-run with
  a note, next actions as Bound Actions on a run's output, the core-only trust offer, failed handed
  runs routed to the desk. CLI rows for each.
- **client-core:** the tray's order and bundling (`groupResultsIntoBundles`), the trust streaks, the
  ledger/rack split, the outcome lines.
- **Renderer:** the desk route, the paper renderers per result kind (mail, pull request, review,
  findings), the bell, the floor's pile and carrier.
- **Riskiest part:** the paper renderers. A result must be structured enough to draw as a letter or a
  memo (draft body, diff excerpts, confidence and doubts), which means workflows declare a result
  shape, not free text. Without it the desk degrades to a transcript in a frame.

## URLs

`index.html` · `?state=floor` · `?state=stamp` · `?state=flip` · `?state=redo` · `?state=bell` ·
`?state=draft2` · `?state=failed` · `?state=trust` · `?state=cleared` · `?state=empty` ·
`?state=swarm`. Add `&theme=orient-express` for dark, `&bar=off` to hide the prototype bar.
