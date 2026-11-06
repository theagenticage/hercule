# Motion language: Overview and Work

Things should feel good to use. Motion here is not decoration: it says where a thing came from, where it went and what caused it.

The engine is `js/motion.js`. It is about 300 lines with no dependencies. Everything below is built on it and runs in `desktop.html`. To judge motion by eye, add `?slow=6` to the address: every spring runs six times slower.

## Principles

1. **Motion explains cause.** If nothing caused it, it does not move. If something outside the app caused it, the cause shows first.
2. **The same thing never teleports.** A card, its bead or count, and its open details are one object. Between any two states, the object is seen travelling. This holds across a night's sleep: the morning replay plays what changed.
3. **Measure what is on screen.** A change always starts from where a thing looks right now, with the speed it has right now. Reversing halfway is therefore not a special case: it is one more change.
4. **You are faster than the world.** Things you move answer in one frame and settle in about 300ms. Things that move by themselves are slow and unhurried, about one second, with no overshoot.
5. **Weight is honest.** A carried card leans into its motion, and a press dents. Overshoot appears only where something lands. Nothing bounces for fun.
6. **Quiet at rest.** Only one thing on the desk moves at rest: the paws of a working colleague, in short bursts with long pauses, as a person types. No shimmer, no pulsing, no looping attention.
7. **Reduced motion is a design, not a switch-off.** Movement becomes a short fade, in the same order, so the cause is still told.

## Tokens

### Durations and curves (CSS, in `system/primitives.css`)

| Token | Value | Use |
|---|---|---|
| `--m-press` | 80ms | press feedback |
| `--m-quick` | 140ms | hover, small fades, colour |
| `--m-base` | 220ms | height changes, reveals |
| `--m-slow` | 360ms | things crossing a short distance |
| `--m-long` | 560ms | one-off moments, such as a landing glint |
| `--m-ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | the default ease out |
| `--m-ease-in` | `cubic-bezier(0.5, 0, 0.75, 0)` | things leaving for good |
| `--m-ease-both` | `cubic-bezier(0.6, 0, 0.2, 1)` | moves with no cause on screen |
| `--m-settle` | a `linear()` spring | a CSS transition with a touch of overshoot |

### Springs (`Motion.SPRINGS`, stiffness / damping at mass 1)

Three, and the system is the point. Which one to use follows from one question: who caused this?

| Name | k | c | Ratio | Settles in | Use |
|---|---|---|---|---|---|
| `hand` | 632 | 43 | 0.86 | about 260ms | under your hand, or answering it at once: lift, landing, neighbours moving aside, the switcher's puck |
| `travel` | 305 | 31 | 0.89 | about 430ms | crossing the screen because you asked: opening, folding, regrouping, going home after a cancel |
| `self` | 90 | 19 | 1.00 | about 1000ms | moving by itself: a card moved by a fact, an arrival |

Overshoot is never built in. It appears only where a thing lands with the speed of your hand, because the landing starts with the velocity the hand gave it.

Stagger: never by count alone. Cards growing out of beads and counts go 16ms apart, capped at 130ms. A long list never takes longer because it is long.

## Every transition

Each one names its trigger, its parts and its spring. Reversal is free, by principle 3.

### Hover

A card's shadow grows from `--h-rest` to `--h-hover`, in `--m-base`. Nothing moves, and the words never change. A stack's sheet takes the hover tint on its own, so the two targets are told apart before the click.

### Press

The card scales to 0.992 at once. It is a dent, not an animation.

### Carrying a card (the star)

1. **Lift.** Past 5px of movement the card leaves the page for the carry layer. It keeps its exact position. Scale goes to 1.03 on `hand`. Height rises on the same spring: a layer with `--h-carry` crossfades in, driven by the `l` (lift) channel, so the shadow visibly grows. There is no separate lift animation, so nothing delays the hand.
2. **Follow.** Position is one to one: the card is exactly under your finger, with no lag at any speed. Only scale, height and lean ride a spring. It leans at most ±1.2 degrees, from smoothed speed, and stands straight 60ms after you stop, so text is never left tilted.
3. **The stage answers.** The stage's name stays in ink and a faint aisle shows behind the column: at rest the stages are only alignment, so the grid appears only when it is needed.
4. **The slot.** A hollow slot fades in, in `--m-quick`, at the target row. Everything below it moves aside on `hand`, including the lanes below. All of it is FLIP: the slot moves in the DOM, and everything springs from where it was, so nothing jumps.
5. **Land.** On release the card returns to the page from exactly where it looks, and springs to the slot on `hand`, keeping the velocity of your hand. Scale, tilt and lift settle together, so it visibly comes down. The stage counts roll over.
6. **Cancel.** Esc, or a pointer cancel, springs it home on `travel`: same path, no bounce.
7. **Landing in Landed.** A thin ring fades over `--m-long`.

Carrying several cards: the rest of the selection fly in behind the first as a stack on `travel`, each 5px further and 2% smaller, with a count on top. They land with 40ms between them.

### Merging

1. Hold the carried card still over the middle 40% of another for one second, or hold Option for an instant merge. Moving more than 6px starts the wait again, so passing over a card or still deciding where to put it starts nothing. Merging should feel chosen, not stumbled into.
2. The target scales to 1.02 on `hand` and takes a focus ring and a label naming it, "Merge into Serve smaller…", on its top edge.
3. The carried card docks on the target's corner, 10px across and 8px down. It shrinks to 0.96 and tilts 1.6 degrees. The slot closes. Moving away undoes all of it at once.
4. On release, the carried card slides in under the target and fades, on `hand`. 60ms later the target settles from 1.03 to 1 on `hand`, and a thin ring fades over `--m-long`.
5. A line at the foot offers Undo. Undo plays it backwards: the card comes out from under the target.

### Opening in place

"13 more", a stack's sheet, and "3 landed" all do one thing: the cards appear where they belong, under the last one, fading in from 6px up on `travel`, and everything below glides down. Closing sends each card back to the button it came from. Nothing floats over the board, and nothing opens in a box you then scroll.

### Sliding a bead

A bead follows the pointer along its line on `hand`, at 1.5 scale. Near the start of a stage it is pulled toward it by 45% of the distance, like a bead finding a notch. On release it springs to its stage on `hand`.

### Opening a card

One number from 0 to 1 on `travel` drives everything, which is why Esc halfway simply reverses it.

- The sheet interpolates its left, top, width and height from the card to the pane, and its corner from 12px to 16px. It is an empty box, so the layout cost is tiny. This is the only thing on the board not done by transform, because a scaled sheet would distort its corners and shadow.
- The card's words ride on the sheet and fade out by 0.55.
- The pane's words fade in from 0.3 to 0.85, rising 10px. The two overlap, so there is never a blank sheet.
- The pane's words are laid out once, at the final size. The growing sheet reveals them, so a paragraph never rewraps.
- What stands behind the top edge is part of the sheet, so a colleague's head rides along.
- The board dims 34% toward the desk. It never moves.
- The card's place stays as a dent: a faint outline.
- A Task with no card on the desk opens from its bead, its lane's count, or the button that holds it, so the sheet always comes from somewhere.

Choosing another card while the pane is open swaps the words in 200ms. The sheet stays still, and the dent moves.

### Folding a lane or plan

Folding: a copy of each card flies to its count on the lane's line, or to its bead on an initiative's line, on `travel` and shrinks to 0.1, 12ms apart, staying solid until it is small. Lanes below wait 70ms, then glide up on `travel`. Folding everything is one change, however many lanes.

Opening: each card grows from its count or bead from scale 0.1 on `travel`, 16ms apart. Lanes below glide down. Reversing halfway starts each card from the copy still in flight.

### Filtering and regrouping

Both are one change on `travel`. What stays on the page springs from where it was to where it now belongs. What leaves simply goes, with no flight: a filter is not an event in the world. The page returns to its top on a new grouping, because the old scroll position means nothing there. Turning a filter off plays the same thing back.

### A Task arriving

A thread starts, so a Task appears. It waits for a still hand. It rises at the end of its cell: from 12px down and 0.97 scale, with opacity from 0, on `self`. 620ms later its colleague's head comes up from behind the edge on `travel`, and then the paws. A thin ring fades over 3.2 seconds. If it lies past what the cell shows, or under something folded, only the counts change and the toolbar's line says so.

### Add to Work

The sheet slides in 18px on `hand`, and the board stays in view beside it. A search waits 180ms for typing to stop, then quiet bars hold the place until the source answers, with no spinner. Results replace the bars in place, and an answer that a newer search has replaced is thrown away. A pasted link changes the source tab at once. A Task you add fades into its cell on `travel`, and the board does not scroll. The row in the list turns to a check at once, and nothing else in the list moves.

### A card moving by itself

A fact arrives, such as a pull request merging.

1. It waits for a still hand: not while the pointer rests within 120px of it, however long it has been still, because a parked pointer means someone is reading. Not while the pointer is on the move within 280px. Not while dragging. Never longer than 8 seconds.
2. **The cause lands first.** A small label ("PR #6221 merged") rises onto the card on `hand`. It holds for 760ms.
3. The card crosses on `self`, about one second, to the end of its new cell. Heading for Landed, it fades out on the way and goes into the "N landed" line. A card rising into the row it left passes over what stands behind the next card's top edge, never under it.
4. **The dent stays.** Its old place stays open for 1.5 seconds, and closes only when the hand is out of that lane.
5. The stage counts roll over. A quiet line in the toolbar says what happened.

If the card has no place on screen, only its bead and the counts change.

### A run failing

A failure is a fact, so it follows the same rule: it waits until the hand has left the area, or eight seconds at most. Then the card takes the top of its cell on `self`. The colleague's head changes to its plaster, its paws leave the edge, and the toolbar's line says "Review PR failed". The sidebar's dot simply appears. It never pulses, because a moving dot would pull the eye all day.

Try again plays as a hand-off: the head comes up, the paws reach the edge, and nothing around the card moves.

### The morning replay

On opening, the board starts from how you left it and plays each change in turn, 1.5 seconds apart, by the rules above. It takes about six seconds and stops for nobody: you can act while it plays. After it ends, one quiet line stays, with a button to see it again.

### Done and Dropped

Done: the card shrinks into its stage's count on `travel`, and the count rolls down. Dropped: it sinks 12px with a small tilt and fades. Undo plays either one back.

### A hand-off

Starting a thread, or Try again, is one chain, not a cut. The colleague's head rises from behind the edge on `travel`, and its paws reach the edge at 90ms. Undo plays it back.

### Switching views

- The puck slides on `hand`, and its width changes on the same spring.
- **Work to Office:** every head on a visible card that has a desk becomes a travelling face. It flies to its colleague's position in the 3D room on `travel`, 50ms apart, growing to 1.5 scale and fading as it arrives. The desk fades and sinks to 0.985 while the room fades in from 1.025.
- **Office to Work:** the reverse, in the same order.
- The kit loads when the pointer enters the Office tab, so it is usually ready by the click.

### Skeletons

The layout is known before the words are, because cards are one height. Each card shows two quiet bars, and the words fade in from top left to bottom right, 26ms apart. Nothing moves.

## Reduced motion

`prefers-reduced-motion`, or `html[data-motion="reduced"]`, or the Prototype tray.

- Springs jump to their end, except opacity, which fades on `travel`.
- A card moving by itself: the cause label still shows, then the card appears in place with a fade.
- Heads stop typing. Blinks stop.
- The morning replay does not play: the toolbar's line says what changed.

## Performance

- Only `transform` and `opacity` animate, with one stated exception: the opening sheet, an empty box.
- One `requestAnimationFrame` clock runs only while something moves. At rest the page does no work except CSS paw taps.
- `will-change` is set only while a body moves, by the `is-moving` class.
- FLIP measures once before and once after a change, with no reads inside the frame loop.
