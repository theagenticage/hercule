# The Inbox: motion

The language is shared with Work: `MOTION.md` and `SHARED.md` on `prototype/overview-hifi`. The Inbox uses the same kernel (`vendor/motion.js`, copied as it is), the same springs and the same duration tokens, and adds no spring of its own. `js/motion-extras.js` adds what the kernel does not do: CSS `linear()` curves built from the same springs, one-shot Web Animations, and a token's flight.

## What the Inbox adds to the shared principles

1. **The Inbox is still at rest.** The only thing that moves on its own is a working colleague's paws. Everything else moves because something happened.
2. **Nothing moves under the pointer by itself.** The card you are on responds. Its neighbours do not. A dismissed card's place stays open until the pointer leaves.
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
| 0 | The drop | A 7px dot in the tone of the news appears 40px above the line and falls to the card on a falling curve, 210ms, squashing a little on contact |
| 210ms | The card | Takes a knock: 2px down and to 99.6% on `hand`, and back on `hand` |
| 210ms | The old sentence | Rolls up 14px and fades, 240ms, `--m-ease-in` |
| 290ms | The new sentence | Rolls up from 14px below on `hand` |
| 370ms | The count | Ticks up from 6px below, 260ms |
| 210ms | The rim | A hairline and a 3px glow in the tone of the news, in at 14% of 1100ms and fading out |
| After | The new mark | A 6px marigold dot stays before the sentence until the pointer or the keyboard reaches the card, so news that arrived unseen can still be found |

The card never changes place, and its neighbours do not move.

### Handing off

| Time | Part | Motion |
|---|---|---|
| 0 | The card | Lies flat: stock and shadow change over `--m-long`. The sentence rolls to "Agent review has it" |
| 90ms | The colleague | The head rises 26px from behind the top edge on `hand` |
| 120ms | The token | A 24px token of the card's mark flies along an arc to Overview, 420 to 760ms by distance, shrinking to 55% |
| 300ms | The paws | Come up onto the edge on `hand`, then type |
| On arrival | Overview's row | A wash of the accent fades over 640ms |
| | The sidebar's count | The digit rolls by 4px, 260ms |

Taking it on yourself is the same with a marigold tab in place of the head.

### Dismiss and undo

| Part | Motion |
|---|---|
| The card | Fades over `--m-base`. Its place stays open |
| The hole | Closes when the pointer leaves the page, or after 2.6 seconds: neighbours move on `hand` |
| Undo, hole still open | The card fades back into its place |
| Undo, hole closed | The neighbours part on `hand` and the card fades in |

### Opening and closing a card

| Part | Motion |
|---|---|
| The sheet | Unfolds from the strip by a `clip-path` inset on the `travel` curve, its top left corner staying put |
| The title | The same object: it grows from where it lay, by transform, on the `travel` curve |
| The rest | Signals, facts and rows rise 6px and fade in, 240ms, 22ms apart from 60ms |
| The veil | Fades over `--m-slow` |
| Closing | The sheet folds back in 200ms, `--m-ease-both`. Focus returns to the card |

### Carrying a card

| Part | Motion |
|---|---|
| Lift | After 6px of travel a ghost of the whole card comes up at 103% with `--h-carry`, and its place stays open |
| Carry | The ghost follows the pointer one to one. Only its scale and its lean, up to 3.5 degrees, ride `hand` |
| The rail | Rises on `travel` |
| Near a target | Within 96px the target swells to 116%, and the card is pulled towards it, shrinking to 62% |
| Drop on a target | The ghost folds into the target in 220ms, the target pulses once, then the move runs as above |
| Cancel | Esc, or letting go elsewhere: the ghost goes home on `travel` |

### Arrivals and piles

| Moment | Motion |
|---|---|
| A new card | Joins at the end of its stack: rises 18px and fades in on `self`, because nothing you did caused it. Neighbours make room on `hand` |
| A tray opens | The panel grows from the pile on `travel`, cells follow 18ms apart, capped at 12 |
| A pile on hover | Its edges part by 1 and 3px over `--m-base` |

### The empty Inbox

When the last card leaves: the horizon draws outward over 700ms, the numeral rises through it over 1100ms, the rays draw from the middle outward, 26ms apart, and the words fade up at 620ms. It plays once.

### Loading

The real cards are laid out at once with their words held back. When words arrive they fade in over 240ms, 14ms apart, capped at 24 cards, so nothing shifts.

## Reduced motion

Movement becomes a short fade, in the same order, so the cause is still told.

| Moment | With reduced motion |
|---|---|
| A signal | No drop, no knock. The line changes, and the rim shows at full strength for a moment |
| A hand-off | The card goes flat, the head is in place, no token flies. The toast says what happened |
| Opening | The card appears at once |
| Carrying | The ghost follows the pointer exactly, with no lean |
| The sunrise | Drawn at once |
| Paws | Still |
