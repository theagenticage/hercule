# The Inbox: motion

The language is shared with Work: `MOTION.md` and `SHARED.md` on `prototype/overview-hifi`. The Inbox uses the same kernel (`vendor/motion.js`, copied as it is), the same springs and the same duration tokens, and adds no spring of its own. `js/motion-extras.js` adds what the kernel does not do: CSS `linear()` curves built from the same springs, one-shot Web Animations, and a token's flight.

## What the Inbox adds to the shared principles

1. **The Inbox is still at rest.** Nothing moves on its own. Everything moves because something happened.
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
| Actions | Pointer enters a card | Fade in over `--m-quick`, at the end of the second line. The sentence ends with an ellipsis 6px before them, so no word is cut |
| Height | The same | The sheet's shadow goes to `--h-hover` over `--m-quick`. Nothing moves |
| Peek | 260ms of rest on a strip | The card rises above those in front of it and its height grows from its strip to its whole face over `--m-base`. Its shadow goes to `--h-carry`. The foot row waits 170ms for the sheet to grow round it. A strip the edge would reach hides its words, so no line is cut and none reads as the peek's own |
| Hand-over | A peek is showing and the pointer reaches another card | The peek moves after 70ms of rest, or 220ms if the pointer is still moving fast, so a quick exit does not ripple through the stack |
| Peek ends | Pointer leaves the stack, after 140ms | The height closes over `--m-base`, then the card returns to its place in the order |

### A signal landing

A signal is the one moment the Inbox lets itself be noticed, with the card's change at 280ms.

| Time | Part | Motion |
|---|---|---|
| 0 | The drop | A 7px dot in the tone of the news appears 24px above the card and falls onto its line over 280ms, stretching as it goes, and flattens on contact for 60ms |
| 280ms | The card | Takes a knock: an impulse of 145 on `hand`, so it peaks at 2px about 60ms after contact and comes back by itself |
| 280ms | The sentences | Old and new roll together on one `hand` curve, 16px apart, both clipped by the line, so they never show at once |
| 440ms | The count | Ticks up from 6px below, 260ms |
| 280ms | The rim | A 1.5px inner rim in the tone of the news, on the strip that can be seen, at the card's own corner, in at 14% of 1100ms and fading out, so the whole moment ends at about 1400ms |
| After | The new mark | A 6px marigold dot stays before the sentence until the pointer or the keyboard reaches the card, so news that arrived unseen can still be found |

The card never changes place, and its neighbours do not move. A signal on a card folded in a pile plays the same moment on the pile: the drop falls on its facts, and at contact the pile takes the knock, its facts roll and its rim lights. It keeps a dot, and shows the worst inside, until it is opened. In an open tray nothing falls across the cards: the card there changes its words and lights its rim.

### Handing off: the colleague takes the card's weight

One click, one chain: hand, weight, flight, receipt. The cause always comes before the effect.

| Time | Part | Motion |
|---|---|---|
| 0 | The count | The sidebar's digit rolls by 4px, 260ms: the card has left your hands |
| 0 | The colleague | The wait goes, and the colleague rises 26px on `hand` while the card still stands: over the top edge of a whole card, with its paws coming onto the edge at 30ms, or into the wait's place on a strip |
| 170ms | The card | Only now gives up its weight: one impulse of 110 on `hand` sinks it 1.5px, and the same impulse of 150 dips the colleague, who recovers. The shadow goes flat over `--m-quick`, the stock over `--m-long`. The sheet survives the redraw, so the change is a real transition |
| 170ms | The sentence | Rolls to "Agent review has it" |
| 170ms | The mark | The card's own mark lifts off and flies along an arc to Overview's icon, 420 to 760ms by distance, shrinking to 55%. A dimmer mark stays behind |
| On arrival | Overview | The mark stays solid until contact. Then the icon takes the same small knock, and a wash of the accent fades over 640ms: something received it |

Taking it on yourself is the same with the marigold tab on a whole card, and your monogram on a strip.

**Undo plays it backwards.** The mark flies home from Overview in 240ms, growing back to its size, so the page answers at once. On arrival the card stands up with an upward impulse, the sentence rolls back, the colleague sinks away on `travel`, and the count ticks.

**From the open card, by pointer,** the card folds home first, and the chain starts as it lands, so the move plays on the card where it lies. **By keys,** the sheet walks on to the next card and the chain plays behind it: the keys are for rhythm.

### The rhythm of a stack

This is the page's main rhythm, so it must feel like a stack of cards being worked through, not a list reflowing.

| Moment | Motion |
|---|---|
| A card comes out of the pile | It starts behind the pile, solid, and rises out of it to its place on `hand`, as the last step of the ripple. The pile gives a little, an impulse of -60, and its count rolls by 5px over 240ms |
| A strip steps up to lead | It rises into place while its title grows from 13 to 15px by transform, on `hand`, and the foot row comes up 6px and fades in, 240ms from 100ms |
| A card goes back to the pile, on Undo | The same, backwards: it sinks behind the pile on `hand`, and only then leaves the page |
| The pile runs out | Its sheets and body fade on `hand`, and what it held rises from behind it |
| A stack turns over | When nothing in view waits, 620ms after the last hand-off of a run the held cards settle down 8px and fade on `hand`, its count rolls, and 240ms later, once they have gone, the pile deals the next few. The ring comes back only when the dealt card has landed. A key pressed in that gap turns the stack at once, so none is lost |

### Dismiss and undo

| Part | Motion |
|---|---|
| The card | Moves 14px to the right and fades on `travel`: a small gesture of putting it aside. From a peek it leaves with its whole face |
| The next card | Rises into its place at once on `hand`, with the rest of the stack behind it, nearest first, 14ms apart: a ripple, not a block. Its close is now under the pointer |
| The last card | The sunrise follows at 320ms |
| Undo | The stack parts on `hand`, and the card comes back from 14px on `travel` |

### Opening and closing a card

The sheet is one object on one number, from 0 where the card lies to 1 where it stands open, driven by `Motion.value` on `travel`. Reversing is therefore free: Esc at any moment sends the same number home from where it is.

| Part | Motion |
|---|---|
| The sheet | Grows from the visible part of the card with its shadow, its corner staying put, its radius going from 12 to 14. A sheet changing shape is the one thing a transform cannot do, so its size is set per frame |
| The title, mark and latest line | The same objects: they grow from where they lay, by transform, on the same number |
| The rest | Meta, facts and rows rise 6px and fade in, 240ms, 18ms apart, once the sheet's number passes 0.8, so they follow the spring and not a clock, and nothing prints over the title or the latest line wherever the card lay |
| Older signals | Fade in over 200ms at the same moment |
| A title that wraps | When the title takes more lines in the sheet than on the card, the latest line waits until 0.2 and fades in by 0.45, because the title starts over it |
| The moves | Take no pointer for the first 420ms, so the second click of a double click never starts an agent |
| The veil | A flat veil, no blur. Fades over `--m-slow`, and is taken away when it has gone |
| Walking | J and K keep the sheet where it stands. The words change with a 160ms rise of 8px in the direction of travel, and the height follows |
| Closing | The same number going home, from wherever it is. Asked to open again on the way, it turns round with its speed. The rest goes at once, so the latest line crosses nothing. At 0.02 the card comes back under the sheet, and the sheet dissolves into it over 80ms. Focus returns to the card; the ring returns only for the keyboard |

### Carrying a card

| Part | Motion |
|---|---|
| Lift | After 6px of travel a ghost comes up at 103% with `--h-carry`, growing from the strip to the whole card, and its place stays open |
| Carry | The ghost follows the pointer one to one. Only its scale and its lean, up to 3.5 degrees, ride `hand` |
| The rail | Rises on `travel`, its targets fading up 28ms apart |
| Near a target | Within 96px the target swells to 116%, and the card is pulled towards it on a smooth ramp, shrinking to 62% |
| Drop on a target | The target pulses once and the rail holds for 340ms, so the choice is seen to land. The card goes home on `travel`, keeping the speed of the throw, and the chain starts 200ms in, as it comes in to land: one object, one place. A card dropped on Dismiss leaves from the rail |
| Cancel | Esc, or letting go elsewhere: the ghost goes home on `travel` and the card takes over with no blink |

### Arrivals and piles

| Moment | Motion |
|---|---|
| A new card | Joins at the end of its stack: comes down 20px and fades in on `self`, because nothing you did caused it, and the rim lights 200ms in, once it can be seen. Neighbours make room on `hand`. Into a pile, it lands on the pile: the knock, the count, the rim. While the pointer is in that column it waits at the heading as "1 new", and arrives the same way when the pointer leaves |
| A tray opens | The veil goes first. The pile takes a knock, and the visible cards travel out of it, solid, to their cells on `travel`, 18ms apart, capped at 180ms, unclipped by the panel, which fades up from 80ms |
| A tray closes | The panel goes first, over `--m-quick`, and the same cards travel back into the pile |
| A pile on hover | Its edges part a little over `--m-base`, and it rises to `--h-hover` |

### Hercule notices something

A new thing takes a free column of the noticed card, and Hercule looks up over the edge, an impulse of -130 on `hand`. It is the only time he moves. The card's row stays when nothing is noticed, so nothing shifts under a resting pointer: when the last thing leaves, the card fades over 300ms and the page holds still, and when something comes back it fades up over 220ms.

### The empty Inbox

When the last card leaves: the horizon draws outward over 700ms, Hercule's head rises through it from below, cut off by the horizon, over 1400ms on `cubic-bezier(.3,0,.2,1)`, the rays draw from the middle outward from 420ms, 26ms apart, and the words fade up at 900ms. It plays once. If the last card was handed on, the page waits 1.5 seconds for the chain to play out, and then settles.

### Loading

The real cards are laid out at once from what the last visit knew, measured with their words, and then the words are held back. When they arrive they fade in over 240ms with marks and figures, stack by stack: 60ms per stack and 14ms per row, so nothing shifts.

## Reduced motion

Movement becomes a short fade, in the same order, so the cause is still told.

| Moment | With reduced motion |
|---|---|
| A signal | No drop, no knock. The line changes, and the rim fades over 900ms |
| A hand-off | The head and the flat card appear at once. No mark flies, but Overview's row fades, 400ms, so it still says where the Task went |
| Opening | The card appears at once, and the veil fades |
| Carrying | The ghost follows the pointer with no lean, and the rail only fades |
| The sunrise | Drawn at once |
