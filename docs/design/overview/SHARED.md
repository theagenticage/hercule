# Shared primitives: Work and Inbox

Owned by the Overview session. Inbox builds on these so the two feel like one product. Everything here lives in `system/primitives.css` on `prototype/overview-hifi`. Copy that file, or link it; do not redefine its tokens. If a value looks wrong on an Inbox card, say so in the Discussion and we settle it by what looks best.

## The one idea

**A card's height above the desk says something.** Only cards have height. Lanes, columns and sections are not boxes: they are space and type.

| Height | Token | Means | Fill |
|---|---|---|---|
| Standing | `--h-stand` | wants you | `--stock` |
| Hover | `--h-hover` | under the pointer | `--stock` |
| Carried | `--h-carry` | in your hand | `--stock` |
| Flat | `--h-flat` | someone else holds it | `--stock-flat` |
| Pressed | `--h-press` | cannot move yet | `--stock-press` |
| Etched | `--h-etch` | finished | transparent |

For the Inbox: a card that needs you stands. A card you are only following lies flat. Height is never decoration.

## The desk

`--desk` is the ground under cards. It is one tone below the app's `--surface`, so a card reads as an object lying on something. Use it as the background of the whole scrolling area.

## The top edge

The top edge of a card is one slot. What stands behind it tells who has the next move, before a word is read, the way a metal signal tab did on a card in a 1930s card file:

- a marigold tab: you. Short for a quick call, long for real thinking
- a colleague's head, cut off by the card: an agent
- a grey tab with an initial: a person
- nothing: nobody

Markup: `<article class="card"><span class="card-holder">…</span><i class="card-stock"></i>…words…</article>`. The sheet is its own element so it can hide the lower part of what stands behind it.

## Type roles

| Role | Token | Value |
|---|---|---|
| Page sentence | `--type-lead` | 18/24, bold |
| Lane or section name | `--type-lane` | 14/20, bold |
| Card title | `--type-card` | 13/18, medium |
| Card summary | `--type-summary` | 12/16, regular, `--muted` |
| Card meta (age, need) | `--type-meta` | 11/16, regular, `--faint`, tabular figures |

Inter throughout, as the app sets it. Monospace is for code only.

## Space and shape

- 4px grid. Card padding 10px top, 12px sides, 8px bottom (`--card-pad-*`).
- Card corner `--card-r` 12px. Anything nested inside a card uses `--card-r-inner` 8px, so corners nest.
- Work's cards are all one height, `--card-h` 96px: title and summary share one clamp of three lines, so a new summary never moves a neighbour. The Inbox may vary height by kind, but keep the 12px corner, the padding and the type.
- Space between cards: `--card-gap` 14px. It leaves room for what stands behind the top edge.

## Colour

The book's doctrine holds. Colour means who. `--you` marigold is only ever for something addressed to you, at tab, dot and word size. Provenance marks are `currentColor`, in `--faint` at rest.

## Motion tokens

| Token | Value | Use |
|---|---|---|
| `--m-press` | 80ms | press feedback |
| `--m-quick` | 140ms | hover, small fades |
| `--m-base` | 220ms | height changes, reveals |
| `--m-slow` | 360ms | things crossing a short distance |
| `--m-long` | 560ms | things moving by themselves |
| `--m-ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | the default |
| `--m-ease-both` | `cubic-bezier(0.6, 0, 0.2, 1)` | moves with no cause on screen |
| `--m-settle` | a `linear()` spring | a touch of overshoot |

Springs, as stiffness / damping at mass 1, in `js/motion.js`:

| Name | k / c | Feel |
|---|---|---|
| `carry` | 900 / 48 | follows the pointer, a hair behind |
| `glide` | 420 / 36 | neighbours moving aside |
| `drop` | 520 / 30 | settling into a slot, slight overshoot |
| `return` | 300 / 30 | going home after a cancel |
| `open` | 260 / 28 | a card opening into its details |
| `fan` | 340 / 26 | a pile opening |
| `fold` | 300 / 32 | a lane or plan folding |
| `bump` | 900 / 28 | a small acknowledgement |

Rules: motion explains cause. Everything is interruptible. Transform and opacity only. Nothing moves under the pointer by itself. Reduced motion swaps movement for a short fade, it does not just cut.
