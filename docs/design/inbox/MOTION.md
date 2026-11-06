# The Inbox: motion

The language is shared with Work: `MOTION.md` and `SHARED.md` on `prototype/overview-hifi`. The Inbox uses the same kernel (`vendor/motion.js`, copied as it is), the same springs and the same duration tokens, and adds no spring of its own. `js/motion-extras.js` adds what the kernel does not do: CSS `linear()` curves built from the same springs, one-shot Web Animations, and a token's flight.

## What the Inbox adds to the shared principles

1. **The Inbox is still at rest.** The only thing that moves on its own is a working colleague's paws. Everything else moves because something happened.
2. **Nothing moves under the pointer by itself.** The card you are on responds, and its neighbours do not. A new card waits until the pointer leaves its stack. Only your own move changes what is under the pointer.
3. **The cause shows first.** A signal is seen arriving before the card reacts to it. A Task is seen leaving for Work.
4. **A card keeps its place through every change of state.** Hand-off, signal and peek all happen where the card lies.

## Tokens

Durations, from `vendor/primitives.css`: `--m-press` 80ms, `--m-quick` 140ms, `--m-base` 220ms, `--m-slow` 360ms, `--m-long` 560ms. Curves: `--m-ease`, `--m-ease-in`, `--m-ease-both`.

| Spring | k / c | Used in the Inbox for |
|---|---|---|
| `hand` | 632 / 43 | Everything under your hand or answering it: cards taking new places, a sentence rolling in, the knock of a landing, a head rising, paws on the edge |
| `travel` | 305 / 31 | Crossing the screen because you asked: a card opening, a tray, the rail, a carried card going home |
| `self` | 90 / 19 | Moving by itself: a new card arriving |

## Every transition

### Hover and peek

| Part | Trigger | Motion |
|---|---|---|
| Actions | Pointer enters a card | Fade in over `--m-quick`, in the place of the wait. The title gives way with an ellipsis, so no word is cut |
| Height | The same | The sheet's shadow goes to `--h-hover` over `--m-quick`. Nothing moves |
| Peek | 260ms of rest on a strip, or at once if a peek is already showing | The card rises above those in front of it and its height grows from its strip to its whole face over `--m-base`. Its shadow goes to `--h-carry` |
| Peek near the foot | A peek would pass the stack's foot | The card lifts by the difference on `hand` |
| Peek ends | Pointer leaves the stack, after 140ms | The height closes over `--m-base`, then the card returns to its place in the order |

Sweeping the pointer down a stack switches the peek at once from card to card: a riffle with no neighbour moving.

### A signal landing

A signal is the one moment the Inbox lets itself be noticed. Total: about 900ms, with the card's change at 210ms.

| Time | Part | Motion |
|---|---|---|
| 0 | The drop | A 7px dot in the tone of the news appears 40px above the card's line and falls onto the line on a falling curve, 210ms, squashing a little on contact |
| 210ms | The card | Takes a knock: 2px down on `hand`, and back on `hand` |
| 210ms | The old sentence | Rolls up 12px and fades, 160ms, in its own place |
| 250ms | The new sentence | Rolls up from 12px below on `hand` |
| 370ms | The count | Ticks up from 6px below, 260ms |
| 210ms | The rim | A hairline and a 3px glow in the tone of the news, in at 14% of 1100ms and fading out |
| After | The new mark | A 6px marigold dot stays before the sentence until the pointer or the keyboard reaches the card, so news that arrived unseen can still be found |

The card never changes place, and its neighbours do not move. A signal on a card folded in a pile knocks the pile instead.

### Handing off: the colleague takes the card's weight

One click, one chain: hand, weight, flight, receipt. The cause always comes before the effect.

| Time | Part | Motion |
|---|---|---|
| 0 | The count | The sidebar's digit rolls by 4px, 260ms: the card has left your hands |
| 0 | The colleague | The head rises 26px from behind the top edge on `hand`, while the card still stands |
| 130ms | The paws | Come up onto the edge on `hand`, then type six strokes and rest |
| 170ms | The card | Only now gives up its weight: it sinks 1.5px on `hand`, and its stock and shadow go flat over `--m-base`. The sheet itself survives, so the change is a real transition |
| 170ms | The sentence | Rolls to "Agent review has it" |
| 170ms | The mark | The card's own mark lifts off and flies along an arc to Overview's icon, 420 to 760ms by distance, shrinking to 55%. A dimmer mark stays behind |
| On arrival | Overview | Its icon dips 1.5px on `hand`, and a wash of the accent fades over 640ms: something received it |

Taking it on yourself is the same with a marigold tab in place of the head.

**Undo plays it backwards.** The mark flies home from Overview, the card stands up, the sentence rolls back, the colleague sinks on `travel`, and the count ticks on arrival.

**From the open card,** the card folds home first, and the chain starts as it lands, so the move plays on the card where it lies.

### Dismiss and undo

| Part | Motion |
|---|---|
| The card | Moves 14px to the right and fades on `travel`: a small gesture of putting it aside |
| The next card | Rises into its place at once on `hand`, with the rest of the stack behind it, nearest first, 14ms apart: a ripple, not a block. Its close is now under the pointer |
| The last card | The sunrise follows at 320ms |
| Undo | The stack parts on `hand`, and the card comes back from 14px on `travel` |

### Opening and closing a card

The sheet is one object on one number, from 0 where the card lies to 1 where it stands open, driven by `Motion.value` on `travel`. Reversing is therefore free: Esc at any moment sends the same number home from where it is.

| Part | Motion |
|---|---|
| The sheet | Grows from the visible part of the card with its shadow, its corner staying put. A sheet changing shape is the one thing a transform cannot do, so its size is set per frame |
| The title and mark | The same objects: they grow from where they lay, by transform, on the same number |
| The rest | Meta, signals, facts and rows rise 6px and fade in, 240ms, 20ms apart from 70ms |
| The veil | Fades over `--m-slow`, and is taken away when it has gone |
| Walking | J and K keep the sheet where it stands. The words change with a 160ms rise of 8px in the direction of travel, and the height follows |
| Closing | The same number going home. The rest fades in 100ms. Near home the card comes back under the sheet, and the sheet dissolves into it over 80ms. Focus returns to the card; the ring returns only for the keyboard |

### Carrying a card

| Part | Motion |
|---|---|
| Lift | After 6px of travel a ghost comes up at 103% with `--h-carry`, growing from the strip to the whole card, and its place stays open |
| Carry | The ghost follows the pointer one to one. Only its scale and its lean, up to 3.5 degrees, ride `hand` |
| The rail | Rises on `travel` |
| Near a target | Within 96px the target swells to 116%, and the card is pulled towards it, shrinking to 62% |
| Drop on a target | The target pulses once and the rail holds for 340ms, so the choice is seen to land. The card goes home on `travel`, and the chain runs there: one object, one place |
| Cancel | Esc, or letting go elsewhere: the ghost goes home on `travel` and the card takes over with no blink |

### Arrivals and piles

| Moment | Motion |
|---|---|
| A new card | Joins at the end of its stack: comes down 20px and fades in on `self`, because nothing you did caused it, with the same rim as a landing. Neighbours make room on `hand` |
| A tray opens | The pile takes a knock, and the visible cards travel out of it to their cells on `travel`, 18ms apart, capped at 180ms |
| A tray closes | The same cards travel back into the pile |
| A pile on hover | Its edges part by 1 and 3px over `--m-base` |

### The empty Inbox

When the last card leaves: the horizon draws outward over 700ms, the numeral rises through it from below, clipped by the horizon, over 1400ms on `cubic-bezier(.3,0,.2,1)`, the rays draw from the middle outward from 420ms, 26ms apart, and the words fade up at 900ms. It plays once. If the last card was handed on, the page waits 1.5 seconds for the chain to play out, and then settles.

### Loading

The real cards are laid out at once from what the last visit knew, with their words held back. When words arrive the bars go in 120ms, and words, marks and figures fade in over 240ms, stack by stack: 60ms per stack and 14ms per row, so nothing shifts.

## Reduced motion

Movement becomes a short fade, in the same order, so the cause is still told.

| Moment | With reduced motion |
|---|---|
| A signal | No drop, no knock. The line changes, and the rim fades over 900ms |
| A hand-off | The head and the flat card appear at once. No mark flies, but Overview's row fades, 400ms, so it still says where the Task went |
| Opening | The card appears at once, and the veil fades |
| Carrying | The ghost follows the pointer with no lean, and the rail only fades |
| The sunrise | Drawn at once |
| Paws | Still |
