# Pocket Watch - design brief

PROTOTYPE. One of four directions for "stay in the loop" (see `../BRIEF.md`). Open `index.html`.

## The problem, in this direction's terms

Rogier hands work off so he can keep coding. Today the follow-through costs him a hunt through
Intake › Done, Workflows, a run, a transcript and Gmail. The fix is not a better place to look.
The fix is to not need to look. The Mac already has edges built for this - the menu bar,
notifications, the dock, a global hotkey - and each handoff should use them only as much as
Rogier allowed when he handed it off.

**Lever:** know without looking - a watch in the menu bar shows every handoff at a glance, and
each handoff carries a small contract, "Tell me", that says when it may interrupt him.

## Principles

1. **The contract is set at the handoff, by Rogier.** When it lands, If it needs me, or the
   Roundup. The default comes from trust, and the UI says why ("14 of 14 signed off as they came").
2. **The watch is always honest; interruptions are rationed.** The menu bar shows every state at
   once. A notification only comes when the contract allows it.
3. **The main window is optional.** Read, sign off, send back, try again and answer a Request from
   the watch's case or from a notification. Only Take over opens Hercule.
4. **Landed is not signed off.** A result keeps its marigold notch until Rogier gives a verdict.
5. **Proposing is not doing.** Nothing outward happens without a click. A notification offers
   an outward answer only when the agent says it is sure; otherwise it offers Open.

## Who and when

- **09:00 to 09:40, triage in Intake.** Each Hand to an agent gets its "Tell me" (keys 1 2 3).
- **Coding, 09:40 on.** The editor stays in front. The watch fills; a banner comes only for the
  handoffs he asked to hear about.
- **Between two commits.** ⌥Space, J J ↩, read the result, ↩ signs it off. Esc, back to the editor.
- **12:30.** One roundup notification gathers what was held back.

## Key interactions

| Where | What | Keys |
|---|---|---|
| Intake's pane | Hand to an agent opens "Tell me": When it lands · If it needs me · Roundup 12:30 | `1` `2` `3`, `↩` hands off |
| Anywhere | Opens the watch's case, keyboard first | `⌥Space` |
| The case | Move, open a row, then press its suggested answer | `J` `K`, `↩` then `↩` |
| The case | Send back with a note (landed); Try again with a note (failed) | `B`, then `↩` |
| The case | Take over: opens the run's thread in the main window | `T` |
| The case | Change "Tell me" on a working or waiting handoff | `1` `2` `3` |
| The case | Close the open row, then the case | `Esc` |
| Notification | The suggested answer (when sure) or Open; Send back… turns into macOS's reply field | click, `↩` in the field |
| Dock tile | Opens Hercule (here: Intake's pane with Pieter's #1296) | click |

`↩` never answers in one press: the first opens the row so the result is read (spec 17's Intake rule).

## States (mapped to the shared lifecycle)

| Shared state | The watch (menu bar) | The case | Notification |
|---|---|---|---|
| Handed | a new tick pops in at the next place, clockwise from 12 | row under Working | none |
| Working | ink tick that fills against the workflow's usual duration (never full until it lands) | the agent's latest note, elapsed; open: its notes with times, "Tell me" | none |
| Needs you | full marigold tick | Needs you group, opened by default, ledger inline | unless Roundup |
| Landed | marigold notch (dot) | Landed group, marigold unseen dot, one-line result | only When it lands |
| Seen | marigold ring: quieter, still waiting | row without the dot | none |
| Signed off | the place leaves; the others turn to close the gap | "Review posted · signed off", then "N signed off today" | none |
| Sent back | turns back into a working tick | "Attempt 2 · …"; open shows "what changed" when it lands | by contract |
| Taken over | the place leaves | "Taken over · opens in Hercule" | none |
| Undone | the place leaves | "Draft discarded", "Closed #1302" | none |
| Failed | tomato notch | failed mark, the agent's reason, Try again with a note | unless Roundup |
| Empty | 12 faint pips, no ticks | "Nothing out with agents today." and three ghost rows | none |
| Swarm (38) | 12 places as proportions | bundles by workflow: "Review PR · 4 pull requests" with "Post 4 reviews"; "14 working" is one row | 6 today, 23 held |

The case's header keeps the quiet count: "3 interruptions today · 1 held for the 12:30 roundup".

## What it deliberately does not do

- No new screen in the main window, no history list, no list of what was signed off.
- No change to Intake: the signal still leaves To do at the click.
- No change to the dock badge: it still counts agents blocked on you.
- No sound, no automatic action, no new state marks, no looping animation.
- No custom notification windows: every notification is a plain macOS one.

## What changes in the spec

1. **A Handoff record** (spec 10 §9.4). Hand to an agent still resolves the signal at the click
   (§9.6 holds). The click also writes a handoff: `{ signalId, runId | threadId, tellMe, attempts,
   seenAt, verdict, verdictAt }`. `signal.act` takes an optional `tellMe` on a hand-to action.
   The contract is not stored on the run, because a run's plan is frozen and the contract outlives
   attempts. It is not on the signal either, because a resolved signal is immutable. New
   operations, each with a CLI row: `handoff.list`, `markSeen`, `signOff`, `sendBack { note }`,
   `takeOver`, `letGo`, `setTellMe`; a live topic `handoff`. Cost: one table and seven operations.
2. **Send back needs an attempt input** (spec 07 §3). A new run of the same workflow gets
   `attempt: { previousRunId, note }` as an optional core input.
3. **Notifications** (spec 17 §Native behaviour). Today only waiting threads, waiting assistants
   and new Now signals notify, and "From runs" never does. Pocket Watch adds handoff notifications
   gated by "Tell me" (landed, asks, failed) and one roundup notification at set times. A run's
   Request on a handoff then notifies, which contradicts "the notifications do not count them".
   Outward actions from a notification only when the agent is sure.
4. **The menu-bar extra and ⌥Space** are new: spec 17 has neither. The case is a child window
   opened by the main renderer (same process), with native popover vibrancy.
5. **Work while hidden** (Rules 3 and 4): the `handoff` topic stays subscribed while the window is
   hidden, as `session` and `signal` do; one renderer timer for the next roundup, like Intake's
   snooze timer.
6. **Focus:** macOS holds banners during a Focus by itself; Electron cannot read Focus, so the
   roundup says "since 09:00", never "while you were focused".
7. **Check-in:** a failed handoff shows on the watch, so `core.run-failed` in Check-in (post-v1
   on desktop) is no longer the only place a failure surfaces.

## New design tokens

- `--watch-rest`: a tick's empty track, ink at 20%, so "not yet" reads on the menu bar's
  see-through fill in both themes.
- `--case-width: 560px`: with the ledger's buttons at 140px, a describe line takes at most two lines.
- `--watch-bar: 24px`: the square macOS gives a status item at the default menu bar height.

## Motion and what it costs

Every motion plays once, on `transform` and `opacity`, within `--dur-3`. Faces are drawn still,
and the working mark's dots do not pulse. Nothing loops.

| Motion | Cost |
|---|---|
| Notification slides in | none: macOS draws it |
| Watch in the menu bar | none: a Tray image redrawn on each change (about 1 ms on an OffscreenCanvas in the renderer, then `tray.setImage`). No animation in the real menu bar |
| Case opens (200ms) | one compositor layer; native vibrancy instead of CSS blur |
| Big dial: tick pops in, notch turns, places close up (320ms) | transforms on 12 small HTML elements, only while the case is open |
| A row arrives or leaves (320ms / 200ms) | one element |
| Handoff: a dot travels to the watch (320ms) | one element, once |

## Effort to build for real

- **Core (M):** the Handoff record, seven operations with CLI rows, the `handoff` topic, the
  attempt input, trust computed on read from 30 days of handoffs.
- **client-core (S):** grouping, the dial's places, the held count, the default contract.
- **Main and renderer (L):** the Tray image, the case window, the global shortcut, notification
  actions and the reply field, the roundup timer, "Tell me" in Intake's pane.
- **Size: L.**
- **Riskiest part:** the watch in the menu bar. Colour notches mean the image cannot be a
  template image, so it must stay legible on light, dark and tinted menu bars, and be drawn by
  a hidden renderer without waking anything else. Close second: macOS shows notification
  actions only in alert style or on hover, and not at all for an unsigned build.

## URLs

`index.html` plus `?state=` (add `&theme=orient-express`, `&bar=off`):
`open` · `result` · `notify` (09:22, the reply field) · `redo` · `attempt2` · `attempt2-landed` ·
`landed` · `contract` · `failed` · `roundup` · `roundup-open` · `empty` · `swarm`.
With no state the morning plays from 09:41: Investigate lands at about 12s, the backup
investigation at about 40s.
