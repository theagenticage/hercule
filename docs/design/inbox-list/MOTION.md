# The Inbox list: motion

The language is the app's, shared with Work and the earlier Inbox drawing: the same kernel (`vendor/motion.js`, copied as it is), the same three springs and the same duration tokens. `vendor/motion-extras.js` adds CSS curves built from the springs, one-shot Web Animations and a mark's flight. Nothing here adds a spring.

| Spring | k / c | Used for |
|---|---|---|
| `hand` | 632 / 43 | Everything under your hand or answering it: rows closing up, a group folding, a knock, the pane's edge |
| `travel` | 305 / 31 | Crossing the screen because you asked: a thing flying into its group, a dismissed row sliding aside, the dialog arriving, arrivals you asked to see |
| `self` | 90 / 19 | Moving by itself: the "N new" bar coming down |

Durations from the app: `--m-quick` 140ms, `--m-base` 220ms, `--m-slow` 360ms. Opacity never rides a spring when it sits over words: it is a short fade of its own, so nothing reads through anything.

## The principles

1. **The list is still at rest.** No shimmer while loading, no pulse on what is new, no idle timer.
2. **Your move answers in the same frame.** The current row, the pane and the counts change at once. The data changes first, and motion only shows what already happened, so a second key never waits for the first motion.
3. **The cause shows first.** A leaving row fades before the rows after it close up. A colleague takes a handed row before it leaves. A mark flies to Work.
4. **One object, one place.** A thing that moves between a row and a group flies there as itself, mark onto mark, and its new row appears as it lands. A card dropped on another row is the card that flies.
5. **Never words over words.** Leaving copies lie under the list. Rows that cross each other carry the list's ground while they move.
6. **The highlight stays where your eyes are.** The current row's fill is a puck under the list: when a row leaves, the next row slides into it and the puck does not move.
7. **Reduced motion keeps the order.** Movement becomes an instant change or a short fade, in the same sequence.

## Every transition

### Walking the list (J, K)

| Part | Motion |
|---|---|
| The puck | Jumps to the new current row in the same frame. It has a short 2px edge on its left, so the row is told by shape as well as by fill |
| The pane | Swaps in the same frame, with no fade: it is the answer to the key, and a held J must never blank it |
| The scroll | Moves only when the current row would leave the list, by the least distance |

### A row leaving (dismiss, take on, an answer that ends the last ask)

| Time | Part | Motion |
|---|---|---|
| 0 | The data | Changes; the puck stays where it is, under the row that will take the place |
| 0 | The row's copy | Lies in a layer under the list. It fades out in 110ms; on dismiss it also slides 28px aside on `travel` |
| 70ms | The rows after it | Close up on `hand`, from where they were, into the puck. By then the copy is almost gone |

Undo plays it back: the row returns from 28px aside on `travel`, the others part on `hand`.

### Linking, by L or by drag

| Time | Part | Motion |
|---|---|---|
| 0 | The data | The links are written; the group opens and becomes current |
| 0 | Each linked thing | Its old row is lifted onto the flight layer with the carried shadow, takes its new row's width, and flies on `travel` so its mark and title land on the member row's mark and title. The member row appears as the copy lands |
| 0 | The group's row | Appears in place from 98.5% on `hand`, over the rows around it |
| 0 | Rows that change order | Carry the list's ground while they cross, and the current row carries its own fill while the puck waits |
| ~420ms | Rest | The group is open and current |

**By drag**: a press that moves 6px lifts a copy at 102%, and its shadow grows in over 160ms. The row's place stays, at 32%. The copy follows the pointer one to one and leans up to 2.5° with its speed; held still for 90ms it stands up straight. The row under it lights with a 1.5px focus ring. **Letting go on it hands the carried copy itself to the link**, so it flies from under the pointer, with its tilt and speed, into the group. Esc, or letting go elsewhere, sends it home on `travel` with the speed the hand gave it.

Undo flies each member back to its own row the same way.

### Hand-off

| Time | Part | Motion |
|---|---|---|
| 0 | The data | The thing is handed: the counts change and a second H refuses |
| 0 | The wait | Rolls up out of its slot as the colleague's face rolls in from below, both clipped to the line, on `hand` |
| 170ms | The face | Takes the weight: an impulse of 150 dips it, and it comes back |
| 170ms | The sentence | Rolls up to "Triage errors has it", clipped to its line |
| 170ms | The mark | Flies from the row along an arc to Work in the sidebar, 420 to 760ms by distance |
| On arrival | Work | Takes a small knock and an accent wash that fades over 640ms |
| On arrival | The row | Leaves as above, or moves to its new place when the list still holds it (a held thing stays in "Errors on me", below what waits) |

With several workflows the app's HandToMenu opens first, from 98% and 4px above, over 220ms, and closes in 120ms. ⌘Z during the chain stops it: the row stays, nothing leaves.

### Groups folding

| Part | Motion |
|---|---|
| The chevron | Turns 90° over `--m-base` |
| Members, unfolding | Come down 8px and fade in on `hand`, 18ms apart |
| Members, folding | Their copies fade under the list in 110ms; the rows under the group close up 70ms later |

### A signal section folding in the pane

Its body changes height on `hand` from its measured height, its chevron turns, and nothing else moves except to make room. A folded body is inert.

### The thread dialog

| Time | Part | Motion |
|---|---|---|
| 0 | The scrim | Fades in over 220ms |
| 0 | The dialog | Fades in over 100ms, and rises from 14px at 98% on `travel` |
| 90ms | The things | Each chip comes 6px from the left, 30ms apart |
| Esc | The dialog | Fades over 140ms and sinks 8px to 98.5% on `hand`; the scrim fades over 180ms and holds until it is hidden |

**⌘↩, starting it:** the writing becomes the thread in one step.

| Time | Part | Motion |
|---|---|---|
| 0 | Your message | Rises from where the composer was to the top of the transcript, on `travel` |
| 0 | The dialog's height | Springs on `travel` from the composer's height to the transcript's. Room is kept from the start for the agent's first lines, so the footer never walks |
| 90ms | The live cards, the context line | Fade in over 180ms |
| 500ms | The agent | Each `hercule entity read` line fills its kept place, 260ms apart |
| then | The first sentence | Streams at the agent's own pace |
| 2.4s | A live card | An error's count ticks up: the cards are live references |

### Arrivals: the "N new" bar

| Time | Part | Motion |
|---|---|---|
| 0 | The bar | Floats over the top of the list: it comes down 14px on `self` and fades in over 220ms. The list does not move |
| 0 | The sidebar's count | Ticks up 4px over 260ms |
| `.` | The list | Scrolls to the first new row, which becomes current. The new rows come down 20px on `travel` 220ms later, 40ms apart, with a marigold wash that fades over 1.8s |
| `.` | The bar | Rises 10px and fades on `hand` |

### The pane's edge

Dragged, the width follows the pointer one to one. The arrows step a target by 40px, so quick presses add up and the spring keeps its speed. Home and End go to the widest and the narrowest. A double click springs back to 420. The ⋯ menu sets Narrow, Default or Wide.

### Under 900px

The pane lies over the list and slides in from the right over `--m-base` on ↩ or a click; Esc slides it out and gives the focus back to the row.

### The sunrise

It waits 240ms for the last row to leave. Then the horizon draws outward over 700ms, Hercule's head rises through it over 1400ms, the rays draw from the middle outward from 420ms, and the words fade up at 600ms. It plays once.

## Reduced motion

`prefers-reduced-motion`, or `?motion=reduced`. The `--m-*` durations are zero too, so no transition of the drawing's own moves.

| Moment | With reduced motion |
|---|---|
| A row leaving | Its copy is gone at once; the next row is in place |
| Linking | The group appears, open, at once |
| Hand-off | The face and the sentence change at once, no flight; the row leaves |
| Folding | Members appear or go at once |
| The dialog | Appears and goes at once; the first moments are drawn whole |
| Arrivals | The bar appears; `.` puts the rows in place |
| The sunrise | Drawn at once |

## How it was checked

Every motion was filmed at real speed with `tools/film.mjs`, which records the browser's own screencast frames with their times, and the motion critic tracked each element frame by frame. A slowed clock is never used: it leaves the springs behind the CSS and shows motion that does not happen.
