# The Inbox: design

Where everything out there that concerns a person lands, before they take it on. Every example is invented. `desktop.html` is the working window and `index.html` walks through the reasoning. The motion is in `MOTION.md`.

The Inbox builds on the primitives shared with Work: `SHARED.md` and `system/primitives.css` on `prototype/overview-hifi`, copied here as `vendor/primitives.css`. Nothing in that file is redefined. What the Inbox adds is in `css/tokens.css`, listed at the end of this document.

## The rules

1. **The Inbox never scrolls.** The page is one screen at any volume. The tray, which you open on purpose, is the only thing that scrolls.
2. **A stack shows the oldest few, and the rest wait in a pile.** More volume makes a pile thicker and its number larger, and nothing else. The page looks the same at 34 cards and at 300, and there is always desk to see. There is no compact mode.
3. **Things stay where they are.** A signal never moves a card. Order is oldest first, so a new card joins at the end. A card someone holds keeps its place until your next visit. Filtering dims, it never reflows.
4. **Nothing moves under the pointer by itself.** Hover and peek raise one card over the others, and no neighbour moves. A new card waits at the stack's heading while the pointer is in that stack. Only your own move changes what is under the pointer: dismiss a card and the next rises into its place, the way closing a tab brings the next tab under the pointer.
5. **One current card.** The pointer and the keys share one current card, and every move moves on to the next card that waits.
6. **What is usual says nothing.** A stack's heading says why most cards are in it. A healthy state draws no shape. Only what differs gets words and colour.
7. **One card, one table.** `js/card.js` has no branch on a kind. A kind only fills in the table below.

## The page

```
┌ pill: Inbox  Cards  Intake ┐                                         marks  ?
                                                    Hercule, over the edge
┌────────────────────────────────────────────────┐
│ noticed      noticed      noticed              │   the noticed card: 60px
└────────────────────────────────────────────────┘
  12 TO REVIEW      4 TO ANSWER      6 TO FINISH      Deco counts, double brass rule
  lead card         lead card        lead card
  strip             strip            strip
  strip             strip            strip
  pile              strip            pile
  1 on Work                          13 with reviewers  the foot row, shown only under the pointer

  12 ON THE SHELF
  Returns 4     Shop 5     Platform 1     Depots 2      one card per project, side by side
```

Three equal columns, 24px apart, 32px from the window's edges, and what Hercule noticed lies on the same columns, so one grid runs down the page. The three stacks on the clock stand side by side, so their three counts read as one line and add up to the number in the sidebar. They share one depth of at most 360px, whatever they hold, so the shelf under them lies at the same height all day and never moves on its own. Up to three projects keep to the page's columns; four stand four across; more share out over rows of nearly equal length. A heading's count sits in a 44px slot, as wide as a card's mark and gutter with its padding, so labels, titles, tabs and foot lines all start on one line. Under 820px of main width the columns become two, and under 620px one; in a very small window the page scrolls, and no card is ever out of reach. The fixed heights: bar 56, the noticed card 14 + 60 + 18, stack heading 46 + 18, foot row 26. The 18px under a heading is what a colleague's head rises into, so it never touches the rule.

| Was | Now | Where | Behaviour |
|---|---|---|---|
| Triage | **Noticed** | One card across the top, in a row that stays even when nothing is noticed, so the page never shifts | Hercule's own. One short reason each, and the logo of what each combines, with a second as a badge. Up to three, each on its column of the page. A thing keeps its column, so one leaving never moves the others. The card reaches only as far as the last thing on it, so one thing on a light day is one column wide, not a long empty band |
| Fast | **On the clock**: To review, To answer, To finish | One column each | Oldest first. The wait leads. Named for your next move |
| Slow | **On the shelf** | Across the page, under the stacks | No clock. One card per project, at any volume, one step lower than a card that wants you |

A kind maps how an entity concerns you to a stack, in its `stacks` field: `reviewRequested` to To review, `opened` to To finish. The set of stacks belongs to the core.

What Hercule noticed lies on one wide card of the page's own stock, with ink words and `--h-stand`. He stands behind its top edge at the right with his paws on it, exactly as a colleague does on Work. So it reads as a colleague handing you something, never as a system notice, and it needs no label. There is no page sentence: this card and the first card of each stack already say it.

## The stack

`js/stacks.js` holds the rule. An item is a card, a tab (a group's heading) or a pile.

| Item | Shows | Height |
|---|---|---|
| Lead | The whole card, 12px apart from the rest | Measured: about 104 |
| Strip, on the clock | Title and one line | 52 |
| Pile | A 20px Deco count, the word "more", then the worst thing inside and how fresh it is: `8 more  ⊗ 2  newest 2h`. A dot while it holds news. One to three sheets under it by how many it holds. It has the strips' height and no more | 52 |
| Project, on the shelf | Mark, project name, a small count when it holds more than one, and one line: its newest news, otherwise its first title | 74 |

1. A stack on the clock shows the oldest few: a lead, two strips and a pile, or a lead and three strips when only one more would have gone in the pile. Either way the three stacks end on one line. **Its depth is a hard limit, and the pile is the only thing that gives**: in a shorter window a stack gives up a strip until it fits. Everything newer waits in one pile. A pile of one is only a card, so it is never drawn.
2. Every card that joins the page rises out of the pile. Dismiss a card and the stack closes up and deals the next. A card someone holds keeps its place for the visit and still counts against the depth, so handing a card on moves nothing.
3. When nothing in view waits any more, the stack **turns over**: the held cards settle to the foot line and the pile deals the next few. A stack can be worked through to its end by rhythm alone.
4. With three or fewer cards and no pile, each is whole. A light day reads as proper cards with air around them.
5. The shelf has no clock, so nothing there leads and folding is safe: every project is one card, at any volume, and opens into the tray.
6. Like things from one stream, such as dependency updates, fold into one pile that stays in sight wherever it falls, because it is the one thing that can be cleared at a stroke.

Strips stand like cards in a file drawer. Each later card lies over the one before it, so each shows its top, and `--h-stack` casts its shadow upward onto the card behind.

## Card anatomy

Shared with Work: 12px corner, 8px nested corner, padding 10 top, 12 sides, title 13/18 medium, summary 12/16, meta 11/16. One step on from Work: a whole card on the clock has a title of 15/21 and a wait of 14/21, because it is the focal point of its stack.

```
 12 ┌────────────────────────────────────────────────┐
 21 │ [mark]  Title, up to two lines when whole   [pace] │
  5 │         Reason sentence  +2               [status] │
  5 │                                                    │
 16 │         #6204  storefront-web    +142 −38  6 files │
 10 └────────────────────────────────────────────────┘
       22px 10px  1fr                            auto
```

| Slot | Declared by | Rule |
|---|---|---|
| Mark | `plugin.mark`, `plugin.hue`, `plugin.solid` | 20px, 18px when tight, in a 22px rail. In `--mark-ink`, or in the hue the plugin declares through `--mark-l` and `--mark-c`, which belong to the theme. A solid mark is drawn at 90%, so a heavy logo and a line logo look the same size. Every logo has one strength |
| Title | The entity | One line in a strip, two when whole, in full in a peek or open |
| Pace | `pace`, `patience` | A fast kind shows its wait in hours under a day, then days. The ramp is in ink and weight only, measured against patience, not a fixed time: `--wait-fresh` under a quarter, `--wait-recent` under one, `--wait-due` under three, `--wait-over` past three, which is ink and bold. Once someone holds a strip, they stand here: the wait stops mattering to you |
| Reason | `reasons`, `person` | The latest signal as one sentence, with the person in it. If it is the stack's usual reason, the line says only who, in `--recede`. Words stay neutral: colour is the status shape's job |
| The rest | The entity's signals | `+2` in `--faint` |
| Status | `status` | One shape and a tone, the only colour on a card, at the start of the second line, touching its words. `norm: true` marks the usual state, which draws nothing. The right edge holds only the wait |
| Identifier | `identifier` | Shown whole and on approach. `#{number}`, `{key}` |
| Context | `context` | `{repo}`, `{team}`, `{supplier}` |
| Facts | `facts` | At most three, each in a fixed form |

People are words on a card. A monogram is kept for you, and faces are for colleagues.

### What a card shows when

| State | Shows |
|---|---|
| At rest | Mark, title, wait, reason, count; a shape only if it is not usual |
| Hover | The same, and the actions take the end of the second line, each with its name: `[face] Agent review`, `Take it`, a close. With several workflows, `Hand to…`. The title and the wait never move, and a click on a title can never hit an action. The sentence ends before them. A pointer on the actions never starts a peek. After 260ms elsewhere on the card, it peeks. Double clicks are safe: the moves of a new sheet take no pointer for 420ms, and On Work takes none for 400ms after Take it |
| Peek or keyboard focus | The whole face, up to three lines of title, over the cards in front of it. Its lower part takes no pointer, so the strips under it stay reachable |
| Open | Everything: the signals in order, the facts, the moves |

## The table a plugin declares

```js
'github/pull-request': {
  noun: 'Pull request',
  plugin: { name: 'GitHub', mark: 'github', hue: null },
  paper: 'bond',          // bond, ledger, manila, sage
  density: 'open',        // open, tight
  pace: 'fast',           // fast, slow
  patience: 24,           // hours before a wait counts as due
  stacks: { reviewRequested: 'review', mentioned: 'answer', opened: 'finish' },
  identifier: '#{number}',
  context: '{repo}',
  group: 'repo',
  person: 'author',       // a field, or null for a kind with no person
  status: {               // null for a kind with no status
    passing: { shape: 'fork', tone: 'good', word: 'Open, checks passed', norm: true },
    failing: { shape: 'cross', tone: 'bad', word: 'Checks failed' },
  },
  facts: [{ field: 'diff', form: 'delta' }, { field: 'files', form: 'count', unit: 'file' }],
  reasons: {
    reviewRequested: { say: '{person} asked for your review', tone: 'plain' },
    checksFailed: { say: 'Checks failed', tone: 'bad' },
  },
  workflows: { reviewRequested: ['Agent review'], opened: ['Repair the build', 'Build it with a second opinion'] },
}
```

`js/kinds.js` holds six real tables and Hercule's own. **Quayside** is invented: a table and one mark, no code.

| Field | Fixed set |
|---|---|
| Shape | `ring` open, `dashed` not real yet, `quarter` `half` `most` under way, `fork` a proposed change, `join` merged, `check` finished, `cross` failed or refused, `hold` waits for a change, `alert` burning |
| Tone | `quiet`, `active`, `you`, `good`, `bad` |
| Stock | `bond`, `ledger` (a cool grey), `manila`, `sage` |
| Density | `open`, `tight` |
| Fact form | `delta`, `count`, `word`, `date`, `money`, `bars` |
| Reason tone | `plain`, `you`, `good`, `bad` |

### Room to grow

Customization grows by adding to these sets, never by a kind drawing itself. The card has no branch on a kind's id, and it should stay that way. The next hooks, if a real plugin ever needs them:

- A new fact form, such as `duration` or `avatars`, added to the core and open to every kind.
- A `lead` field, for a kind whose person matters more than its title, such as a call from a customer.
- More stock, if a seventh kind cannot be told apart. Each new stock must still read as paper in all six themes.
- A plugin may declare `stream`, so like things fold on their own, as dependency updates do here.

## The moves

| Move | Pointer | Key | What happens |
|---|---|---|---|
| Hand to an agent | The workflow by name on hover; the rail while carrying | H, then 1 to 3 with several | One workflow: at once. Several: a small menu, each with a face, a name and a line. The colleague rises over the top edge, the card lies flat, the sentence rolls to "Agent review has it", and its mark flies to Overview |
| Take it on myself | Your monogram | T | Creates a Task with no run. The marigold tab stands behind the top edge |
| Dismiss | The close | E | The card steps aside and the next rises into its place, so the same click at the same spot dismisses the next, for as long as the pointer stays there. Plugins are not told |
| Undo | The undo line, at the foot of the window under the column where you acted | ⌘Z | As far back as you like, from any view. A hand-off plays backwards, and the line says the run stops |
| Open | Click | Space, Enter | Opens where it lies. Esc folds it back. Focus goes to the sheet, not to a move, so Enter never starts an agent. J and K walk to the next card in the same place |
| See its Task | On Work | G | Goes through to the Task on Work |
| Carry | Drag | | Lifting a card raises the rail. Esc or letting go elsewhere sends it home |
| Move | | Arrows, J and K | Arrows follow the page. J and K read through it. A pile is a stop, and Enter fans it |
| A whole pile | The tray | | Hand all to one workflow, or dismiss all, as one move with one Undo. Past 12 cards the tray can be searched |

Moves refuse with a reason where they do not apply: a held card says who has it, and G with no Task says so. An open menu owns the keyboard. A held key never runs through a stack.

A card with a Task stays where it is for the rest of the visit. On the next visit it has settled at the foot of its stack, counted in the foot line, as does a card with nothing open.

## States

| State | Design |
|---|---|
| First run | The page itself, no dialog. Hercule hands you one line saying what this place is, each stack's first card asks to be connected, with one etched place under it, and the sidebar is empty: nothing running, nothing waiting |
| Inbox zero | A small sunrise, 440px wide. Hercule's head comes up over a brass horizon, and the rays draw outward when the last card leaves. "All clear." |
| An empty stack | One quiet line in its place. The column stays, as a landmark |
| Loading | The real cards with their words held back, from what the last visit knew. Nothing shifts when words arrive |
| Offline | One line in the bar saying what you see and that moves wait |
| A failing source | One line naming it, and what it means for its cards |
| No person, no status | The slot closes up. Sentry has no person, Gmail has no status |
| Very long title | One line in a strip, two when whole, all of it when open |
| Huge counts | Grouped digits with tabular figures |
| 300 cards | The same page with larger numbers: a thicker pile at the foot of each stack on the clock, and the same one card per project on the shelf, three to a row |

## Where it lives

Inbox takes Intake's row in the sidebar's Work section. Intake moves behind it, as Office sits behind Overview: the pill reads `Inbox | Cards | Intake`, with no count on Intake, because the noisiest number should not sit above a page meant to calm.

The row shows a plain grey number, not a badge: the cards on the clock, the sum of the counts on the page, so it can be checked by eye. A signal landing on a card you already have never raises it. Something new while you are elsewhere adds one 6px marigold dot, gone when you come back.

## Tried and dropped

- **Cuts.** A letter's fold and a ticket's notches on whole cards. At full size they read as glitches, and they could not show on a strip, where cards spend most of their time. Mark, stock and density carry the identity.
- **The riffle.** Cards parting under the pointer like a fisheye. It moved targets under the pointer. The peek gives the same reading with nothing moving.
- **The kept hole.** A dismissed card's place stayed open for 2.6 seconds, so nothing moved. In practice the next card's close was 50px away, and rapid dismissing stumbled. The tab rule replaced it.
- **One-line strips.** A critic argued for them, for a denser index. The brief says a card shows its latest reason at rest, so strips keep two lines, and the shelf, where nothing waits, has one.
- **Filling the depth.** Stacks once shared a fixed depth and overlapped more as volume grew. It filled the page: 72 lines of text and no desk in sight. The budget of a few strips and a pile replaced it.
- **The plate.** A lacquer and brass band across the top, the one object opposite the page. It was the loudest thing in either design, and read as an outage banner. Hercule now hands you a card of the page's own stock.
- **A piled number with nothing to say.** "8 more" hid a failed check entirely. A stack may fold things, but it may not hide them.
- **Stepping back repeated logos.** It read as read and unread, on the very thing that was praised.
- **Flat shelf rows.** Twelve identical lines, the design called "a lot of text". One card per project replaced them.
- **The shelf as a third column.** To answer and To finish shared the middle column, which rose 292px above the first and 348px above the third, with empty pockets beside it. With the three clock stacks side by side and the shelf under them, the morning has one clear line of counts and every stack ends together. A critic drew it and it won on sight.
- **Hiding the author on a strip, and the reasons of what Hercule noticed until hover.** A critic asked for both, to halve the words. The founder asked for "pr name, author", and the brief for "one short reason", so both stay.
- **Blur behind a sheet.** It read as stock, and it mirrored text at the edges of a scaled frame. The veil is flat.
- **The page sentence.** "Juno has waited longest" repeated what the lead card already said.
- **Colour on sentences.** Six red lines flattened what red means. Colour moved to the status shape.
- **A monogram on every card.** It repeated the name beside it at 7px.
- **A head behind the top edge, in a stack.** Strips have no free edge, so it read as a render fault. The colleague stands in the wait's place instead. On Work, with air around each card, the top edge stays.
- **The numeral as the sun.** The Deco zero read as a dark mode toggle. Hercule's head is the sun now.
- **Three separate triage cards.** They read as a row of KPI tiles, and each seemed to belong to the column under it.
- **A heavy logo in full ink on every row.** At 19 rows it was the heaviest thing on the page. Solid marks are now drawn at 90% and in `--mark-ink`.

## New in the design system

| Name | What | Where |
|---|---|---|
| Stack | The oldest few, and a pile under them. Its depth is a hard limit | `js/stacks.js` |
| The double rule | A brass bar and a hairline under each heading. `--rule-ink` now lives in the shared primitives | `css/inbox.css` |
| Brass that can be read | `--count-ink`, for the Deco counts, shared with Work | `vendor/primitives.css` |
| Strip | A card seen through the ones in front of it | `css/card.css` |
| Peek | A whole card raised over the others, inert below its strip | `js/pointer.js` |
| The noticed card | What Hercule noticed, on the page's own stock, with him over the top edge | `css/card.css` |
| The stack count | The Deco count at 36px, the page's one voice, in a 44px slot | `css/inbox.css` |
| The foot row | The 26px under a stack, for what settled. It shows only under the pointer or the keyboard: the page says less at rest | `js/app.js` |
| Stock with a hue | `--stock-manila`, `--stock-ledger`, `--stock-sage` | `css/tokens.css` |
| Stacked height | `--h-stack`, `--h-stack-shade`. On dark themes it adds a lit top edge and a stronger upward shadow, so strips stay separate | `css/tokens.css` |
| Mark in a declared hue | `--mark-ink`, `--mark-l`, `--mark-c` | `css/tokens.css` |
| Patience | A kind's sense of time, and the ramp `--wait-*` | `css/tokens.css` |
| Receding text | `--recede`, for what a heading has already said | `css/tokens.css` |
| The veil | `--veil`: flat, with no blur. Paper in the light themes, the scrim in the dark | `css/tokens.css` |
| The drop | What falls onto a card before it reacts to a signal | `js/landing.js` |
| The worst inside | What a pile shows of what it hides: one shape and how many, `readWorst` | `js/app.js` |
| The rail | Who can take a carried card | `js/drag.js` |
| Tray | A pile fanned open, the one thing that scrolls | `js/tray.js` |
