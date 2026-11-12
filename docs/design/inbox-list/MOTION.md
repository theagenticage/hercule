# The Inbox list: motion

The language is the app's, shared with Work and the earlier Inbox drawing: the same kernel (`vendor/motion.js`, copied as it is), the same three springs and the same duration tokens. `vendor/motion-extras.js` adds CSS curves built from the springs, one-shot Web Animations and a mark's flight. Nothing here adds a spring.

| Spring | k / c | Used for |
|---|---|---|
| `hand` | 632 / 43 | Everything under your hand or answering it: rows closing up, a group folding, a row taking a knock, the pane's edge springing |
| `travel` | 305 / 31 | Crossing the screen because you asked: a thing flying into its group, a dismissed row sliding away, the dialog arriving |
| `self` | 90 / 19 | Moving by itself: arrivals, and the "N new" bar |

Durations from the app: `--m-quick` 140ms, `--m-base` 220ms, `--m-slow` 360ms.

## The principles

1. **The list is still at rest.** Nothing moves on its own: no shimmer while loading, no pulse on what is new, no idle timer. The "N new" bar is the one thing that arrives by itself, and it does not push the list.
2. **Your move answers at once.** Keys move the current row in the next frame. A move changes the data first and draws the change in motion, so a second key never waits for the first motion to end.
3. **The cause shows first.** A colleague takes a handed row before it leaves; a mark flies to Work; a thing flies into its group.
4. **One object, one place.** A thing that moves between a row and a group flies there as itself: its old row is lifted off the page and lands where the new one is, and the new one appears as it lands.
5. **Motion never hides text behind text.** A row on its way carries the list's ground under it, so nothing reads through it.
6. **Reduced motion keeps the order.** Movement becomes a short fade or an instant change, in the same sequence.

## Every transition

### Walking the list

| Part | Motion |
|---|---|
| The current row | Its fill moves in the same frame as the key. No transition: the eye must not wait for it |
| The pane | Its words rise 6px and fade in over 160ms on `--m-ease`, from below when walking down, from above when walking up. Its scroll is kept when the same thing is redrawn |
| The row in view | Scrolls only when the current row would leave the list, by the least distance |

### A row leaving (dismiss, take on, an answer that ends the last ask)

| Time | Part | Motion |
|---|---|---|
| 0 | The row | A copy is lifted onto the flight layer; on dismiss it slides 14px right and fades on `travel`. On take on and hand-off it fades and shrinks to 98.5% |
| 0 | The rows after it | Close up on `hand` from where they were, so the next row's line comes under the pointer and the key |
| 0 | The current row | Becomes the row that took the place, so the same key handles it |

Undo plays it back: the row returns from 14px on `travel`, and the rows part on `hand`.

### Linking, by L or by drag

| Time | Part | Motion |
|---|---|---|
| 0 | The data | The links are written, the group is worked out, and it is opened |
| 0 | Each linked thing | Its old row is lifted onto the flight layer with the carried shadow (`--h-carry`) and flies on `travel` to its member row in the group. The member row stays hidden until the copy lands, then takes over with no blink |
| 0 | The group's row | Appears in place, from 98.5% and transparent, on `hand` |
| 0 | Everything between | Closes up or parts on `hand` |
| ~360ms | Rest | The group is open and current |

Undo is the same, the other way: each member flies back to its own row.

**By drag**: a press that moves 6px lifts a copy of the row at 102% with the carried shadow; the row's place stays, at 32%. The copy follows the pointer one to one and leans up to 2.5° with its speed on `hand`. The row under it lights with a 1.5px focus ring and a 10% wash. Letting go on it links them as above. Esc, or letting go elsewhere, sends the copy home on `travel` with the speed it had.

### Hand-off

| Time | Part | Motion |
|---|---|---|
| 0 | The wait | Gives way to the colleague's face, which rises 22px into the wait's place on `hand` |
| 170ms | The face | Takes the weight: an impulse of 150 on `hand` dips it, and it comes back |
| 170ms | The sentence | Rolls up to "Triage errors has it", the old and the new on one curve, clipped by the line |
| 170ms | The mark | Flies from the row along an arc to Work in the sidebar, 420 to 760ms by distance, shrinking to 55% |
| On arrival | Work | Takes a small knock, and an accent wash fades over 640ms |
| 900ms | The row | Leaves, as above: the colleague has it, so it no longer waits on you |

With several workflows the menu opens first, from 98% and 4px above, over 220ms (the app's own HandToMenu). Undo brings the row back; nothing plays backwards that did not happen.

### Groups folding

| Part | Motion |
|---|---|
| The chevron | Turns 90° over `--m-base` |
| Members, unfolding | Come down 8px and fade in on `hand`, 18ms apart from the top |
| Members, folding | Fade on `hand` where they are, and the rows under the group close up |
| Show N more | The new members come in the same way |

### A signal section folding in the pane

The section's body changes height on `hand` from its measured height, and its chevron turns. Others do not move except to make room.

### The thread dialog

| Time | Part | Motion |
|---|---|---|
| 0 | The scrim | Fades in over 220ms |
| 0 | The dialog | Rises from 14px below at 98% on `travel`, and fades in |
| 90ms | The things | Each chip comes 6px from the left and fades in, 30ms apart |
| Esc | The dialog | Sinks 8px to 98.5% on `hand` and fades; the scrim fades over 160ms; the focus goes back to where it was |

**⌘↩, starting it:**

| Time | Part | Motion |
|---|---|---|
| 0 | The writing | Fades up 6px over 120ms |
| 120ms | Your message | Rises 90px from where the composer was, on `travel`, with the things as live cards under it |
| 120ms | The list behind | The things leave it, as for a take on |
| 620ms | The agent | Each `hercule entity read` line rises 4px and fades in, 260ms apart |
| then | The first sentence | Streams in at the agent's own pace, three characters every 28ms |
| 2.4s | A live card | An error's event count ticks up 4px: the cards are live references |

### Arrivals: the "N new" bar

| Time | Part | Motion |
|---|---|---|
| 0 | The bar | Comes down 14px and fades in on `self`, because nothing you did caused it. The list does not move |
| 0 | The sidebar's count | Ticks up 4px over 260ms |
| Show | The list | Scrolls to the top if needed, then the new rows come down 20px on `self`, 40ms apart, and keep a marigold wash that fades over 1.6s |
| Show | The bar | Rises 10px and fades on `hand` |

### The pane's edge

The width follows the pointer one to one while dragged; the edge's line lights. The arrows step 40px, and Home and End go to the widest and the narrowest, each on `hand`. A double click springs back to 420px.

### The sunrise

When the last thing leaves: the horizon draws outward over 700ms, Hercule's head rises through it over 1400ms, the rays draw from the middle outward from 420ms, 26ms apart, and the words fade up at 900ms. It plays once.

## Reduced motion

`prefers-reduced-motion`, or `?motion=reduced` in the drawing.

| Moment | With reduced motion |
|---|---|
| A row leaving | Gone at once; the next row is current |
| Linking | The group appears, open, at once |
| Hand-off | The colleague and the sentence change at once, no flight, and the row leaves |
| Folding | Members appear or go at once; the chevron still turns |
| The dialog | Appears and goes at once; the first moments are drawn whole |
| Arrivals | The bar appears; Show puts the rows in place |
| The sunrise | Drawn at once |

## How it was checked

Every motion here was filmed at real speed with `tools/film.mjs`, which records the browser's own screencast frames with their times. A slowed clock is never used: it leaves the springs behind the CSS and shows motion that does not happen.
