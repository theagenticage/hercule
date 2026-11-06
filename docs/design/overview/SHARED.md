# Shared primitives: Work and Inbox

Owned by the Overview session. Inbox builds on these so the two feel like one product. Everything here lives in `system/primitives.css` on `prototype/overview-hifi`. Copy that file, or link it; do not redefine its tokens. If a value looks wrong on an Inbox card, say so in the Discussion and we settle it by what looks best.

## The one idea

**A card's height above the desk says something.** Only cards have height. Lanes, columns and sections are not boxes: they are space and type.

| Height | Token | Means | Fill |
|---|---|---|---|
| Standing | `--h-stand` | wants you | `--stock` |
| Hover | `--h-hover` | under the pointer | `--stock` |
| Carried | `--h-carry` | in your hand | `--stock` |
| Flat | none | someone else holds it | `--stock-flat`, no rim |
| Pressed | `--h-press` | cannot move yet | `--stock-press` |
| Etched | none | finished | none: only words |

For the Inbox: a card that needs you stands. A card you are only following lies flat. Height is never decoration.

## The desk

`--desk` is the ground under cards. It is one tone below the app's `--surface`, so a card reads as an object lying on something. Use it as the background of the whole scrolling area.

## The top edge

The top edge of a card is one slot. What stands behind it tells who has the next move, before a word is read, the way a metal signal tab did on a card in a 1930s card file:

- a marigold tab: you. Short for a quick call, long for real thinking. 18 or 40px wide, 9px showing. With a number on it, it counts everything there that wants you
- a colleague's head, cut off by the card: an agent
- a round monogram: a person
- nothing: nobody

Markup: `<div class="card"><i class="card-stock"></i><span class="card-body"><span class="card-holder">…</span>…words…</span></div>`. The sheet is its own element so it can hide the lower part of what stands behind it, and it stays the same element for the card's whole life, so a change of height can animate. Only `.card-body` redraws.

## Type roles

| Role | Token | Value |
|---|---|---|
| Page sentence | `--type-lead` | 26/32, medium (Work only; the Inbox has none) |
| Lane or section name | `--type-lane` | 15/20, bold |
| Card title | `--type-card` | 13/18, medium |
| Card summary | `--type-summary` | 12/16, regular, `--muted`, about six words |
| Card meta (age, need) | `--type-meta` | 11/16, regular, `--faint`, tabular figures |

Inter throughout, as the app sets it. Monospace is for code only.

Words follow height. On a dark desk what lies lower is written dimmer, so a flat card never outshines a standing one: `--word-flat`, `--word-flat-2`, `--word-press`.

## Space and shape

- 4px grid. Card padding 10px top and bottom, 12px sides (`--card-pad-*`).
- Card corner `--card-r` 12px. Anything nested inside a card uses `--card-r-inner` 8px, so corners nest.
- Work's cards are all one height, `--card-h` 88px: three lines of words, with the age alone at the bottom right, so a new summary never moves a neighbour. The Inbox may vary height by kind, but keep the 12px corner, the padding and the type.
- Space between cards: `--card-gap` 22px. It leaves room for what stands behind the top edge.

## Colour

The book's doctrine holds. Colour means who. On Work, marigold appears only on tabs and as the underline of the sentence's numbers, and `--you-ink` on a question while it is read. Ages and counts are neutral, so marigold stays a signal. A colleague's head rests at 62% saturation for the same reason.

## Motion tokens

| Token | Value | Use |
|---|---|---|
| `--m-press` | 80ms | press feedback |
| `--m-quick` | 140ms | hover, small fades |
| `--m-base` | 220ms | height changes, reveals |
| `--m-slow` | 360ms | things crossing a short distance |
| `--m-long` | 560ms | one-off moments |
| `--m-ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | the default |
| `--m-ease-both` | `cubic-bezier(0.6, 0, 0.2, 1)` | moves with no cause on screen |
| `--m-settle` | a `linear()` spring | a touch of overshoot on a CSS transition |

Springs, in `js/motion.js`. Which one follows from one question: who caused this?

| Name | k / c | Who caused it |
|---|---|---|
| `hand` | 632 / 43 | you, directly: under your hand, or answering it at once |
| `travel` | 305 / 31 | you, asking: something crossing the screen |
| `self` | 90 / 19 | nobody here: a thing moving by itself |

Overshoot is never built in. It appears only where a thing lands with the speed of the hand.

API: `Motion.body(el).to({x, y, s, r, o, l}, "hand", {delay, done})`, `.set(values)`, `.follow(x, y)`, `Motion.flip(els, mutate, {spring, stagger})`, `Motion.value(start, onChange).to(goal, "travel")`, `Motion.ghost(el, layer)`, `Motion.isReduced()`.

Rules: motion explains cause. Everything is interruptible, because every change starts from what is on screen. Transform and opacity only. Nothing moves under the pointer by itself: a pointer parked on a thing means someone is reading it. Reduced motion swaps movement for a short fade, it does not just cut.

## Settled with the Inbox session

**One window.** Both open on Whitehaven, the app's real default, and cross-page links carry `?theme=`. One sidebar fixture: Overview, Inbox, Workflows, Discussions, Wiki, then Fleet, Connections. Waiting on you shows two rows. The Inbox count is a plain grey `<b class="count">22</b>`, with one 6px marigold dot before it when something is new. The foot reads `16 working · 2 waiting · 2 idle`, and the user is Noa. `.count` is plain, as in the app; `.count--you` is marigold and means addressed to you.

**Intake** leaves the sidebar and sits behind the Inbox, as the Office sits behind the Overview. No icons in the pill's tabs. One 36px glass button style at the right end, `.icon-pill`.

**One primary colour.** `--answer` and `--answer-fg`, on both pages. Nile keeps green through that token, because its `--accent` is cream.

**One heading.** Counts come first and are Deco numerals in `--count-ink`, over a double rule in `--rule-ink` (2px over 1px, 5px tall): `13 EXPLORING`, `12 TO REVIEW`. 20px on Work, which has a sentence above it. 36px on the Inbox, which has no sentence, so its numerals carry the voice.

**One material.** On dark desks standing cards have a warm stock per theme, a lit top edge at 13% white and `--stock-sheen`. The Inbox inherits it.

**One figure.** Hercule is the real head over an edge. On the Inbox he stands behind the top edge of what he noticed, a wide card of the page's own stock, not a plate. When all is clear, a sunrise: on Work the stage rule is its horizon.

**Open surfaces.** Title 20/26, corner 16, one key style. Work's opens over the board; the Inbox's docks in place. Both for good reasons.

**Pile grammar.** Count, then what in it wants you, then how fresh. On Work a pile is a real card with sheets and `+3`, and one tab whose number counts what there wants you. In the Inbox the pile's face reads `8 more  ⊗ 2  newest 2h`, with a 20px Deco numeral and a dot while it holds news.

**Keys.** The current card follows pointer and keys, on both. An arrow key takes over from a resting pointer until the pointer moves.

**Marks.** On Work a mark is secondary: 13px, `--muted`. In the Inbox a mark is the identity: 20px, in ink at 84%, or in a plugin's hue through the theme-owned `--mark-l` and `--mark-c`. Solid marks are drawn at 90% size, so a heavy logo and a line logo look the same size. Every logo has one strength.

**The colleague.** A whole card keeps head and paws behind the top edge, at the right. An Inbox strip has no free edge, so there the colleague stands where the wait was, in the working pose. Use `Crew.peek`, `.card-head` and `.card-paws`, so a hand-off in the Inbox and a head on Work are the same object.

**Ages and waits.** On Work ages are neutral, because a Task's age is not the point of the card. In the Inbox an overdue wait stays marigold: the wait is the point there. The two pages are never on screen together.

**Inbox page.** Three clock stacks stand side by side, each a lead, two strips and a pile, with the shelf in a row under them, one card per project. The gap under a stage heading is 18px there, so a colleague's head clears the rule. The top bar's right end sits 14px from the window on both pages, so its button never jumps between them.

**Inbox tokens.** `--h-stack` and the stock variants stay in the Inbox's own tokens file. `js/motion-extras.js` on the Inbox adds `curve`, `animate`, `fly` and `knock` on top of the kernel, with no new springs.
