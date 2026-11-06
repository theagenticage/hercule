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
┌ pill: Inbox  Cards  Intake 214 ┐                                     marks  ?
┌────────────────────────────────────────────────┐
│ crest  noticed   noticed   noticed             │   the plate: 58px
└────────────────────────────────────────────────┘
  12 TO REVIEW      4 TO ANSWER      12 ON THE SHELF   Deco counts, brass rule
  lead card         lead card        Returns 4
                                     row
  strip             strip            row
  strip             strip            Shop 5
  strip             6 TO FINISH      row ...
  pile              lead card
                    strip ...
  1 on Work         13 with reviewers                  the foot row: what settled, and Undo
```

Three columns at 1, 1 and 1.08, 24px apart, 32px from the window's edges. Under 900px of main width the columns become two, and under 620px one. The fixed heights: bar 56, plate 58 + 20, stack heading 34 + 8, foot row 26.

| Was | Now | Where | Behaviour |
|---|---|---|---|
| Triage | **Noticed** | One plate across the top | Hercule's own. One short reason each, and the logo of what each combines, with a second as a badge. Up to three, running along it like a line of engraving, the first a step larger |
| Fast | **On the clock**: To review, To answer, To finish | Columns one and two | Oldest first. The wait leads. Named for your next move |
| Slow | **On the shelf** | Column three | No clock. Grouped by project. Flat rows, one line each |

A kind maps how an entity concerns you to a stack, in its `stacks` field: `reviewRequested` to To review, `opened` to To finish. The set of stacks belongs to the core.

The plate is the one object opposite the page: green-black lacquer on a light desk, walnut in Styles, polished brass on a dark desk. There is no page sentence: the plate and the first card of each stack already say it.

## The stack

`js/stacks.js` holds the rule. An item is a card, a tab (a group's heading) or a pile.

| Item | Shows | Height |
|---|---|---|
| Lead | The whole card, 12px apart from the rest | Measured: about 104 |
| Strip, on the clock | Title and one line | 52 |
| Row, on the shelf | Title, and its key at the end | 34 |
| Row with news | Title and one line | 50 |
| Pile | A Deco count, two lines, one to three sheets under it by how many it holds | 70 |

1. A stack on the clock shows the oldest few that wait: a lead and up to five strips, or three when two stacks share a column. Fewer in a short window. Everything newer waits in one pile. A pile of one is only a card, so it is never drawn.
2. A card someone holds keeps its place for the visit and does not count, so handing cards on never hides others.
3. With few enough cards, each is whole: three on the clock, four on the shelf. A light day reads as proper cards with air around them.
4. The shelf has no clock, so nothing there leads. It lies flat: rows of words on the desk, each standing up as a card when the pointer reaches it. Past what fits, the largest project folds into a pile first, then the next.
5. Like things from one stream, such as dependency updates, fold into one pile at the place of the oldest, at any volume.

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
| Mark | `plugin.mark`, `plugin.hue`, `plugin.solid` | 20px, 18px when tight, in a 22px rail. In `--mark-ink`, or in the hue the plugin declares through `--mark-l` and `--mark-c`, which belong to the theme. A solid mark is drawn at 90%, so a heavy logo and a line logo look the same size |
| Title | The entity | One line in a strip, two when whole, in full in a peek or open |
| Pace | `pace`, `patience` | A fast kind shows its wait, in a ramp measured against patience, not a fixed time: `--wait-fresh` under a quarter, `--wait-recent` under one, `--wait-due` under three, `--wait-over` past three, which is marigold and bold. A slow kind has no clock: its key stands here. Once someone holds the card, they stand here: the wait stops mattering to you |
| Reason | `reasons`, `person` | The latest signal as one sentence, with the person in it. If it is the stack's usual reason, the line says only who, in `--recede`. Words stay neutral: colour is the status shape's job |
| The rest | The entity's signals | `+2` in `--faint` |
| Status | `status` | One shape and a tone, the only colour on a card. `norm: true` marks the usual state, which draws nothing at rest |
| Identifier | `identifier` | Shown whole and on approach. `#{number}`, `{key}` |
| Context | `context` | `{repo}`, `{team}`, `{supplier}` |
| Facts | `facts` | At most three, each in a fixed form |

People are words on a card. A monogram is kept for you, and faces are for colleagues.

### What a card shows when

| State | Shows |
|---|---|
| At rest | Mark, title, wait, reason, count; a shape only if it is not usual |
| Hover | The same, and three small actions take the place of the wait, at the far right, so a click on a title can never hit one: the workflow's face, your monogram, a close. Each says its name when the pointer is on it. After 260ms the card peeks |
| Peek or keyboard focus | The whole face, over the cards in front of it, ending on the edge of a strip. Its lower part takes no pointer, so the strips under it stay reachable |
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
| Stock | `bond`, `ledger` (a cool grey), `manila`, `sage`. The plate is Hercule's alone |
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
| Hand to an agent | The faces on hover; the rail while carrying | H, then 1 to 3 with several | One workflow: at once. Several: a small menu, each with a face, a name and a line. The card lies flat, the head rises behind its top edge, the sentence rolls to "Agent review has it", a token flies to Overview |
| Take it on myself | Your monogram | T | Creates a Task with no run. The marigold tab stands behind the top edge |
| Dismiss | The close | E | The card steps aside and the next rises into its place, so the same click at the same spot dismisses the next. Plugins are not told |
| Undo | The undo line, in the foot of the column where you acted | ⌘Z | As far back as you like, from any view. A hand-off plays backwards, and the line says the run stops |
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
| First run | The page itself, no dialog. The plate says what this place is, and each stack's first card asks to be connected, with etched places under it |
| Inbox zero | A small sunrise, 440px wide. Hercule's head comes up over a brass horizon, and the rays draw outward when the last card leaves. "All clear." |
| An empty stack | One quiet line in its place. The column stays, as a landmark |
| Loading | The real cards with their words held back, from what the last visit knew. Nothing shifts when words arrive |
| Offline | One line in the bar saying what you see and that moves wait |
| A failing source | One line naming it, and what it means for its cards |
| No person, no status | The slot closes up. Sentry has no person, Gmail has no status |
| Very long title | One line in a strip, two when whole, all of it when open |
| Huge counts | Grouped digits with tabular figures |
| 300 cards | The same page with larger numbers: a thick pile at the foot of each stack on the clock, one pile per project on the shelf |

## Where it lives

Inbox takes Intake's row in the sidebar's Work section. Intake moves behind it, as Office sits behind Overview: the pill reads `Inbox | Cards | Intake`.

The row shows a plain grey number, not a badge. It counts what has outlasted its patience, plus what Hercule noticed. A signal landing on a card you already have never raises it. Something new while you are elsewhere adds one 6px marigold dot, gone when you come back.

## Tried and dropped

- **Cuts.** A letter's fold and a ticket's notches on whole cards. At full size they read as glitches, and they could not show on a strip, where cards spend most of their time. Mark, stock and density carry the identity.
- **The riffle.** Cards parting under the pointer like a fisheye. It moved targets under the pointer. The peek gives the same reading with nothing moving.
- **The kept hole.** A dismissed card's place stayed open for 2.6 seconds, so nothing moved. In practice the next card's close was 50px away, and rapid dismissing stumbled. The tab rule replaced it.
- **Filling the depth.** Stacks once shared a fixed depth and overlapped more as volume grew. It filled the page: 72 lines of text and no desk in sight. The budget of a few strips and a pile replaced it.
- **The page sentence.** "Juno has waited longest" repeated what the lead card and the plate already said.
- **Colour on sentences.** Six red lines flattened what red means. Colour moved to the status shape.
- **A monogram on every card.** It repeated the name beside it at 7px.
- **A head behind the top edge, in a stack.** Strips have no free edge, so it read as a render fault. The colleague stands in the wait's place instead. On Work, with air around each card, the top edge stays.
- **The numeral as the sun.** The Deco zero read as a dark mode toggle. Hercule's head is the sun now.
- **Three separate triage cards.** They read as a row of KPI tiles, and each seemed to belong to the column under it.
- **A heavy logo in full ink on every row.** At 19 rows it was the heaviest thing on the page. Solid marks are now drawn at 90% and in `--mark-ink`.

## New in the design system

| Name | What | Where |
|---|---|---|
| Stack | The oldest few, and a pile under them | `js/stacks.js` |
| Strip | A card seen through the ones in front of it | `css/card.css` |
| Peek | A whole card raised over the others, inert below its strip | `js/pointer.js` |
| The plate | One band with what Hercule noticed on it, the one object opposite the page: `--plate`, `--plate-lit`, `--plate-ink`, `--plate-sub`, `--plate-rim`, `--plate-shadow`, per theme | `css/tokens.css`, `css/card.css` |
| The stack count | The Deco count at 26px, the one place the Deco face speaks on the page, on Work's brass rule | `css/inbox.css` |
| The foot row | The last 26px of every column, for what settled and for Undo, so neither ever covers a card | `js/app.js` |
| Stock with a hue | `--stock-manila`, `--stock-ledger`, `--stock-sage` | `css/tokens.css` |
| Stacked height | `--h-stack`, `--h-stack-shade` | `css/tokens.css` |
| Mark in a declared hue | `--mark-ink`, `--mark-l`, `--mark-c` | `css/tokens.css` |
| Patience | A kind's sense of time, and the ramp `--wait-*` | `css/tokens.css` |
| Receding text | `--recede`, for what a heading has already said | `css/tokens.css` |
| The veil | `--veil`: paper in the light themes, the scrim in the dark | `css/tokens.css` |
| The drop | What falls onto a card before it reacts to a signal | `js/landing.js` |
| The rail | Who can take a carried card | `js/drag.js` |
| Tray | A pile fanned open, the one thing that scrolls | `js/tray.js` |
