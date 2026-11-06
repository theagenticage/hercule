# The Inbox: motion

The language is shared with Work: `MOTION.md` and `SHARED.md` on `prototype/overview-hifi`. The Inbox uses the same kernel (`vendor/motion.js`, copied as it is), the same springs and the same duration tokens, and adds no spring of its own. `js/motion-extras.js` adds what the kernel does not do: CSS `linear()` curves built from the same springs, one-shot Web Animations, and a token's flight.

## What the Inbox adds to the shared principles

1. **The Inbox is still at rest.** Nothing moves on its own. Everything moves because something happened.
2. **Nothing moves under the pointer by itself.** The card you are on responds, and its neighbours do not. New things join at the end, so they push nothing you are reading. Only your own move changes what is under the pointer.
3. **The cause shows first.** A signal is seen arriving before the card reacts to it. A Task is seen leaving for Work.
4. **A card keeps its place through every change of state.** A hand-off and a signal happen where the card lies, and so does a signal on a linked row.

## Tokens

Durations, from `vendor/primitives.css`: `--m-press` 80ms, `--m-quick` 140ms, `--m-base` 220ms, `--m-slow` 360ms, `--m-long` 560ms. Curves: `--m-ease`, `--m-ease-in`, `--m-ease-both`.

| Spring | k / c | Used in the Inbox for |
|---|---|---|
| `hand` | 632 / 43 | Everything under your hand or answering it: cards taking new places, a sentence rolling in, the knock of a landing, a head rising, paws on the edge |
| `travel` | 305 / 31 | Crossing the screen because you asked: a card opening, the rail, a carried card going home |
| `self` | 90 / 19 | Moving by itself: a new card arriving |

## Every transition

### Hover and peek

There is no peek any more: every card is whole. The heading stays because other documents cite it.

| Part | Trigger | Motion |
|---|---|---|
| Actions | Pointer enters a row, a request or an asking linked row | Fade in over `--m-quick`, at the end of a line. On a row they lie over the end of the first line on a soft fade, so no height changes. On a request and a linked row the words end with an ellipsis before them |
| Surface | The same | A row takes a faint fill. A request rises from its quiet fill to the stock with `--h-hover`, over `--m-quick`. Nothing moves |
| Who claims a link | Pointer on a link row in the details | The claim fades in over `--m-quick` |

### A signal landing

A signal is the one moment the Inbox lets itself be noticed, with the card's change at 280ms.

| Time | Part | Motion |
|---|---|---|
| 0 | The drop | A 7px dot in the tone of the news appears 24px above the card and falls onto its line over 280ms, stretching as it goes, and flattens on contact for 60ms |
| 280ms | The card | Takes a knock: an impulse of 145 on `hand`, so it peaks at 2px about 60ms after contact and comes back by itself |
| 280ms | The sentences | Old and new roll together on one `hand` curve, 16px apart, both clipped by the line, so they never show at once |
| 440ms | The count | Ticks up from 6px below, 260ms |
| 280ms | The rim | A 1.5px inner rim in the tone of the news, at the card's own corner, in at 14% of 1100ms and fading out, so the whole moment ends at about 1400ms |
| After | The new mark | A 6px marigold dot stays before the sentence until the pointer or the keyboard reaches the card, so news that arrived unseen can still be found |

The card never changes place, and its neighbours do not move. A signal on something riding on a card plays the same moment on its row: the drop falls on the row's line, and at contact the row's words rise into place and its rim lights. The lead never changes under you, even if the part now asks more than it did.

### Handing off: the colleague takes the card's weight

One click, one chain: hand, weight, flight, receipt. The cause always comes before the effect.

| Time | Part | Motion |
|---|---|---|
| 0 | The count | The sidebar's digit rolls by 4px, 260ms: the card has left your hands |
| 0 | The colleague | The wait goes, and the colleague rises 22px on `hand` into its place at the end of the first line. Rows have no free edge, so this is the same on a row and on a request |
| 170ms | The colleague | Takes the weight: an impulse of 150 on `hand` dips it, and it recovers |
| 170ms | The sentence | Rolls to "Agent review has it" |
| 170ms | The mark | The card's own mark lifts off and flies along an arc to Overview's icon, 420 to 760ms by distance, shrinking to 55%. A dimmer mark stays behind |
| On arrival | Overview | The mark stays solid until contact. Then the icon takes the same small knock, and a wash of the accent fades over 640ms: something received it |

Taking it on yourself is the same with your monogram.

**Undo plays it backwards.** The mark flies home from Overview in 240ms, growing back to its size, so the page answers at once. On arrival the card stands up with an upward impulse, the sentence rolls back, the colleague sinks away on `travel`, and the count ticks. The flight is short, so the page answers at once.

**From the open card, by pointer,** the card folds home first, and the chain starts as it lands, so the move plays on the card where it lies. **By keys,** the sheet walks on to the next card and the chain plays behind it: the keys are for rhythm.

### The rhythm of a stack

Nothing is dealt or folded any more. The rhythm is the page closing up and things joining.

| Moment | Motion |
|---|---|
| A card leaves | The cards after it close up on `hand`, so the next card's close comes under the pointer |
| Two things are linked | The part leaves its place, the card it joins grows its tucked sheet, and everything between closes up on `hand`, in one movement. Undo plays the same way back |
| A change of grouping or order | Everything travels to its new place on `hand`, each card by the shortest path |

### Dismiss and undo

| Part | Motion |
|---|---|
| The card | A copy moves 14px to the right and fades on `travel`: a small gesture of putting it aside |
| The next card | Rises into its place at once on `hand`, with the rest behind it. Its close is now under the pointer |
| The last card | The sunrise follows at 320ms |
| Undo | The page parts on `hand`, and the card comes back from 14px on `travel` |

### Opening and closing a card

The sheet is one object on one number, from 0 where the card lies to 1 where it stands open, driven by `Motion.value` on `travel`. Reversing is therefore free: Esc at any moment sends the same number home from where it is.

| Part | Motion |
|---|---|
| The sheet | Grows from the visible part of the card with its shadow, its corner staying put, its radius going from 12 to 14. A sheet changing shape is the one thing a transform cannot do, so its size is set per frame |
| The title and mark | The same objects: they grow from where they lay, by transform, on the same number |
| The rest | Meta, facts and rows rise 6px and fade in, 240ms, 18ms apart, once the sheet's number passes 0.8, so they follow the spring and not a clock, and nothing prints over the title or the latest line wherever the card lay |
| The timeline | Fades in over 200ms at the same moment, so no words cross on the way |
| The moves | Take no pointer for the first 420ms, so the second click of a double click never starts an agent |
| The veil | A flat veil, no blur. Fades over `--m-slow`, and is taken away when it has gone |
| Walking | J and K keep the sheet where it stands, as does a click on a place or a link inside it. The words change with a 160ms rise of 8px in the direction of travel, and the height follows |
| Closing | The same number going home, from wherever it is. Asked to open again on the way, it turns round with its speed. The rest goes at once, so the latest line crosses nothing. At 0.02 the card comes back under the sheet, and the sheet dissolves into it over 80ms. Focus returns to the card; the ring returns only for the keyboard |

### Carrying a card

| Part | Motion |
|---|---|
| Lift | After 6px of travel a ghost comes up at 103% with `--h-carry`, and its place stays open |
| Over another card | That card's edge lights in the accent. Letting go links the two: the ghost shrinks into its lower edge and fades |
| Carry | The ghost follows the pointer one to one. Only its scale and its lean, up to 3.5 degrees, ride `hand` |
| The rail | Rises on `travel`, its targets fading up 28ms apart |
| Near a target | Within 96px the target swells to 116%, and the card is pulled towards it on a smooth ramp, shrinking to 62% |
| Drop on a target | The target pulses once and the rail holds for 340ms, so the choice is seen to land. The card goes home on `travel`, keeping the speed of the throw, and the chain starts 200ms in, as it comes in to land: one object, one place. A card dropped on Dismiss leaves from the rail |
| Cancel | Esc, or letting go elsewhere: the ghost goes home on `travel` and the card takes over with no blink |

### Arrivals and piles

There are no piles any more. The heading stays because other documents cite it.

| Moment | Motion |
|---|---|
| A new card | Joins its side: it comes down 20px and fades in on `self`, because nothing you did caused it, and the rim lights 200ms in. Neighbours make room on `hand` |
| With someone else opens | Its cards appear in place, under the title, and the page simply gets longer |

### Hercule notices something

A new thing takes a free column of the noticed card, and Hercule looks up over the edge, an impulse of -130 on `hand`. It is the only time he moves. The card's row stays when nothing is noticed, so nothing shifts under a resting pointer: when the last thing leaves, the card fades over 300ms and the page holds still, and when something comes back it fades up over 220ms.

### The empty Inbox

When the last request leaves, a small sunrise rises in the column, because lasting work never ends. Anything arriving takes it away. When nothing at all is left, the page is the sunrise.

When the last card leaves: the horizon draws outward over 700ms, Hercule's head rises through it from below, cut off by the horizon, over 1400ms on `cubic-bezier(.3,0,.2,1)`, the rays draw from the middle outward from 420ms, 26ms apart, and the words fade up at 900ms. It plays once. If the last card was handed on, the page waits 1.5 seconds for the chain to play out, and then settles.

### Loading

The real cards are laid out at once from what the last visit knew, measured with their words, and then the words are held back. When they arrive they fade in over 240ms with marks and figures, block by block: 60ms per block and 14ms per card, so nothing shifts.

## Reduced motion

Movement becomes a short fade, in the same order, so the cause is still told.

| Moment | With reduced motion |
|---|---|
| A signal | No drop, no knock. The line changes, and the rim fades over 900ms |
| A hand-off | The head and the flat card appear at once. No mark flies, but Overview's row fades, 400ms, so it still says where the Task went |
| Opening | The card appears at once, and the veil fades |
| Carrying | The ghost follows the pointer with no lean, and the rail only fades |
| The sunrise | Drawn at once |
