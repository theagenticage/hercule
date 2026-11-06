# Shared primitives: Work and Inbox

Owned by the Overview session. Inbox builds on these so the two feel like one product. Everything here lives in `system/primitives.css` on `prototype/overview-hifi`. Copy that file, or link it; do not redefine its tokens. If a value looks wrong on an Inbox card, say so in the Discussion and we settle it by what looks best.

## The one idea

**Clean first.** One UI face, one hairline, real cards. Theme through restraint, not ornament. The display face is for the logo and nowhere else. No hero numbers: counts are small, quiet and useful. No double rule.

**Every card is the same sheet.** Height says nothing. A card lifts only while it is in your hand. Most cards have a stage and nothing more to say, and nobody's move is drawn.

| Shadow | Token | When | Fill |
|---|---|---|---|
| Rest | `--h-rest` | every card | `--stock` |
| Hover | `--h-hover` | under the pointer | `--stock` |
| Carried | `--h-carry` | in your hand | `--stock-carry` |

A blocked card goes quiet: `--stock-flat`, a hairline, words in `--word-press`. A landed card is only words. On dark desks a shadow says little, so the sheet has a lit top edge and `--stock-sheen`.

## The desk

`--desk` is the ground under cards. Use it as the background of the whole scrolling area.

## The top edge

Only a live Thread stands behind the top edge: a colleague's head, cut off by the card, with paws on the edge. Most cards have nothing there. The marigold tab and the person's monogram are gone: they said whose move it was. A person at the source is a 16px monogram beside the age.

Markup: `<div class="card"><i class="card-stock"></i><span class="card-body"><span class="card-holder">…</span>…words…</span></div>`. The sheet is its own element so it can hide the lower part of what stands behind it. Only `.card-body` redraws.

## Wants you

It has one meaning: a Thread on the Task has an open question. Approvals, signals, summaries and inferred moves do not set it. Threads should rarely ask, so it is a small mark on the rare card: the head's raised marigold palm, and the question as the second line in `--you-ink`. No dedicated place, no count, no lens, no headline. Filter has "Has a question". The sidebar's Waiting on you stays as it is. A page must look complete with none.

## Type roles

| Role | Token | Value |
|---|---|---|
| Lane or section name | `--type-lane` | 14/20, bold |
| Card title | `--type-card` | 13/18, medium |
| Card summary | `--type-summary` | 12/16, regular, `--muted`, about six words |
| Card meta (age) | `--type-meta` | 11/16, regular, `--faint`, tabular figures |
| Stage heading | none | 12/16 medium in ink, its count beside it in `--faint` |

Inter throughout, as the app sets it. Monospace is for code only.

## Controls

Normal, familiar and quiet. In `css/toolbar.css`: `.tool`, 36px on the same glass as the pill, with words at 13 medium; `.chip`, a removable filter; `.menu--tool`, one menu with `.menu-pick` rows, `.menu-box` checkboxes and a Back row for a facet's values. Add is the one filled button, in `--answer`.

## Relations

One way of drawing the outside graph on both pages. `part of` is a graph: a thing can have many parents, so a list shows every path, each once, and never one parent as if it were the only one. A row is the source's mark, the title, and what it says about itself: kind, state, and progress only when the source reports it, as a 4px bar in ink at 55% and "4 of 9". A direct confirmed link is a row. A reference found in text is a weaker row, and it never groups. A link you cannot open shows its source and kind with a lock, and no title. Who claims a link shows on hover or focus only. Only a direct confirmed link makes a stack.

## Space and shape

- 4px grid. Card padding 10px top and bottom, 12px sides (`--card-pad-*`).
- Card corner `--card-r` 12px. Anything nested inside a card uses `--card-r-inner` 8px, so corners nest.
- Work's cards are all one height, `--card-h` 88px: three lines of words, with the age at the bottom right, so a new summary never moves a neighbour. The Inbox may vary height by kind, but keep the 12px corner, the padding and the type.
- Space between cards: `--card-gap` 20px. It leaves room for a head behind the top edge.

## Colour

The book's doctrine holds at word and dot scale. Marigold means a person is needed: a raised palm, a question's words, a small dot. Tomato means something got hurt: the failed mark. Each Hercule Initiative has a colour of its own, as lines, flags and dots, in hues kept away from those two: `--plan-l` and `--plan-c` per theme family, `--plan-hue` per initiative. Ages and counts are neutral. A colleague's head rests at 62% saturation for the same reason.

## Motion tokens

| Token | Value | Use |
|---|---|---|
| `--m-press` | 80ms | press feedback |
| `--m-quick` | 140ms | hover, small fades |
| `--m-base` | 220ms | shadows, reveals |
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

**One window.** Both open on Whitehaven, the app's real default, and cross-page links carry `?theme=`. One sidebar fixture: Overview, Inbox, Workflows, Discussions, Wiki, then Fleet, Connections. Waiting on you shows two rows. The Inbox count is a plain grey `<b class="count">22</b>`. The foot reads `16 working · 2 waiting · 2 idle`, and the user is Noa. `.count` is plain, as in the app; `.count--you` is marigold and means addressed to you.

**Intake** leaves the sidebar and sits behind the Inbox, as the Office sits behind the Overview. No icons in the pill's tabs. One 36px glass button style at the right end, `.icon-pill`.

**One primary colour.** `--answer` and `--answer-fg`, on both pages. Nile keeps green through that token, because its `--accent` is cream.

**One heading.** A stage or section heading is plain UI type with its count small beside it, over one hairline. No numerals as a voice, no double rule.

**One material.** On dark desks cards have a stock per theme, a lit top edge at 13% white and `--stock-sheen`. The Inbox inherits it.

**One figure.** Hercule is the real head over an edge. On the Inbox he stands behind the top edge of what he noticed, a wide card of the page's own stock, not a plate. When all is clear, a sunrise: on Work one hairline is its horizon.

**Open surfaces.** Title 20/26, corner 16, one key style. Work's opens over the board; the Inbox's docks in place. Both for good reasons.

**Stacks.** On Work a stack is a real card with a sheet under it that says its reason, and it exists only for a direct confirmed link. On the Inbox the linked things are rows set in under the lasting thing's title. Only a small thing rides, and on one lead. Two lasting things stay in their own places and show each other as a quiet row.

**Keys.** The current card follows pointer and keys, on both. An arrow key takes over from a resting pointer until the pointer moves.

**Marks.** On Work a mark is secondary: 13px, `--muted`. In the Inbox a mark is identity: 16px in the column at `--muted` strength unless the plugin declares a hue, and left out of a row when the place above it already shows it. Solid marks are drawn at 90% size.

**The colleague.** On Work a whole card keeps head and paws behind the top edge. Inbox rows and requests have no free edge, so there the colleague stands at the end of the first line, in the wait's place. Hercule keeps his head and paws on the card he hands you.

**A failed run.** Failed runs reach you on Work, but the sidebar is shared, so both pages draw the same dot: 7px, `--failed-dot` (`--you` mixed 45% into `--you-ink`, which reaches 3:1 on every sidebar), no number, at the end of the Overview row, and on the Hercule segment in the Threads face. One click opens Work filtered to Failed. The failed mark is the Inbox's `cross` shape in its `bad` tone (`--fail-ink`), so the two pages say failed the same way. The words beside it are ink. DESIGN.md has the rest, under A failed run.

**Ages and waits.** On Work ages are neutral, because a Task's age is not the point of the card. In the Inbox an overdue wait goes to full ink and bold, with no colour: the wait is the point there, and colour is the status shape's job. The two pages are never on screen together.

**Inbox page.** Lasting work lies wide, as rows on one raised surface per place, status first. Requests lie in a narrow 320px column of outlined cards, with no shadow at rest. What Hercule noticed is one card of one-line items over the wide side. Nothing folds, and the page scrolls.

**Inbox tokens.** `--attention-ink` is a status that wants watching, so plugins never reach `--you-ink`. `js/motion-extras.js` adds `curve`, `animate`, `fly` and `knock` on top of the kernel, with no new springs. `--h-stack` and the stock variants are gone.
