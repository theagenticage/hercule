# The Inbox: design

Where everything out there that concerns a person lands, before they take it on. Every example is invented. `desktop.html` is the working window and `index.html` walks through the reasoning. The motion is in `MOTION.md`.

The Inbox builds on the primitives shared with Work: `SHARED.md` and `system/primitives.css` on `prototype/overview-hifi`, copied here as `vendor/primitives.css`. Nothing in that file is redefined. What the Inbox adds is in `css/tokens.css`, listed at the end of this document.

## The rules

1. **The Inbox never scrolls.** The page is one screen at any volume. The tray, which you open on purpose, is the only thing that scrolls.
2. **A stack has a fixed depth, and its cards share it.** With room each card is whole. With less room cards overlap. With too little they fold into piles. There is no compact mode.
3. **Things stay where they are.** A signal never moves a card. Order is oldest first, so a new card joins at the end. A card someone holds keeps its place until your next visit. Filtering dims, it never reflows.
4. **Nothing moves under the pointer.** Hover and peek raise one card over the others. No neighbour moves. A dismissed card keeps its place while the pointer is near.
5. **What is usual says nothing.** A stack's heading says why most cards are in it. A healthy state draws no shape. Only what differs gets words and colour.
6. **One card, one table.** `js/card.js` has no branch on a kind. A kind only fills in the table below.

## The page

```
┌ pill: Inbox  Cards  Intake 214 ┐  Juno has waited longest. ...          marks
├──────────────┬──────────────┬──────────────┤
│ plaque       │ plaque       │ plaque       │   Noticed: 72px, up to three
├──────────────┼──────────────┼──────────────┤
│ To review 12 │ To answer 4  │ On the shelf │
│ whole card   │ whole card   │  Returns 4   │
│ strip        │ strip        │  whole card  │
│ strip        │ To finish 6  │  strip       │
│ ...          │ whole card   │  Shop 5  ... │
│              │ strip ...    │              │
│ 1 on Work    │ 13 with rev. │              │   foot: what settled
└──────────────┴──────────────┴──────────────┘
```

Three equal columns, 20px apart, 32px from the window's edges. The plaques share the columns, so there is one vertical grid on the whole page. The page's fixed heights at 1440x900: bar 56, plaques 72 + 20, stack heading 30.

| Was | Now | Where | Behaviour |
|---|---|---|---|
| Triage | **Noticed** | Plaques across the top | Hercule's own. Lacquer. One short reason. Three at most |
| Fast | **On the clock**: To review, To answer, To finish | Columns one and two | Oldest first. The wait leads. Named for your next move |
| Slow | **On the shelf** | Column three | No clock. Grouped by project. Tighter |

A kind maps how an entity concerns you to a stack, in its `stacks` field: `reviewRequested` to To review, `opened` to To finish. The set of stacks belongs to the core.

## The stack

`Stacks.layOut` places the items of a stack. An item is a card, a tab (a group's heading) or a pile.

| Level | Shows | Open kinds | Tight kinds |
|---|---|---|---|
| Whole | The whole card | Measured: 76 to 94 | Measured |
| Two | Title, one line | 49 | 44 |
| One | Title | 34 | 32 |
| Pile | A strip with edges under it | 58 | 58 |

1. If every card fits whole, with a gap of 14 (8 when tight), each is whole.
2. Otherwise the first card stays whole, and the rest get two lines, oldest first, until the depth runs out; the newest get one line.
3. One-line strips are only for a small overflow, up to 30% more cards than fit at two lines. Past that a wall of titles is worse than a pile, so the newest fold into at most two piles, by what the kind groups by. The shelf folds whole projects: past what fits, a project is one pile.
4. Like things from one stream, such as dependency updates, fold into one pile at the place of the oldest, at any volume.

Cards in a stack stand like cards in a file drawer. Each later card lies over the one before it, so each card shows its top. `--h-stack` casts its shadow upward onto the card behind.

## Card anatomy

Shared with Work: 12px corner, 8px nested corner, padding 10 top, 12 sides, 8 bottom, title 13/18 medium, summary 12/16, meta 11/16.

```
 10 ┌────────────────────────────────────────────────┐
 18 │ [mark]  Title, up to two lines when whole  [pace]  │
  3 │         (P) Reason sentence  +2           [status] │
  5 │                                                    │
 16 │         #6204  storefront-web    +142 −38  6 files │
  9 └────────────────────────────────────────────────┘
       20px 10px  1fr                            auto
```

| Slot | Declared by | Rule |
|---|---|---|
| Mark | `plugin.mark`, `plugin.hue` | 20px, 17px when tight. In `--mark-ink`, or in the hue the plugin declares through `--mark-l` and `--mark-c`, which belong to the theme |
| Title | The entity | One line in a strip, two when whole or peeking, all of it when open |
| Pace | `pace`, `patience` | A fast kind shows its wait. The ramp is measured against patience, not against a fixed time: `--wait-fresh` under a quarter, `--wait-recent` under one, `--wait-due` under three, `--wait-over` past three. A slow kind has no clock, and its status takes this slot |
| Person | `person`, or the signal's actor | 16px monogram. Faces are for colleagues |
| Reason | `reasons` | The latest signal as one sentence. If it is the stack's usual reason, the line says only who |
| The rest | The entity's signals | `+2` in `--faint` |
| Status | `status` | One shape and a tone. `norm: true` marks the usual state, which draws nothing at rest |
| Identifier | `identifier` | Shown whole and on approach. `#{number}`, `{key}` |
| Context | `context` | `{repo}`, `{team}`, `{supplier}` |
| Facts | `facts` | At most three, each in a fixed form |
| Top edge | Who holds it | As on Work: a colleague's head, a marigold tab, a grey tab with an initial, or nothing |

### What a card shows when

| State | Shows |
|---|---|
| At rest | Mark, title, wait, reason, count; a shape only if it is not usual |
| Hover | The same, and its actions take the place of the wait. After 260ms it peeks |
| Peek or keyboard focus | The whole face, over the cards in front of it. Its lower part takes no pointer, so the strips under it stay reachable |
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
| Shape | `ring` open, `dashed` not real yet, `quarter` `half` `most` under way, `fork` a proposed change, `join` merged, `check` finished, `cross` failed or refused, `alert` burning |
| Tone | `quiet`, `active`, `you`, `good`, `bad` |
| Stock | `bond`, `ledger`, `manila`, `sage`. `lacquer` is Hercule's alone |
| Density | `open`, `tight` |
| Fact form | `delta`, `count`, `word`, `date`, `money`, `bars` |
| Reason tone | `plain`, `you`, `good`, `bad` |

Customization can grow later by adding to these sets. A kind never gets a branch of its own.

## The moves

| Move | Pointer | Key | What happens |
|---|---|---|---|
| Hand to an agent | The faces on hover; the rail while carrying | H, then 1 to 3 with several | One workflow: at once. Several: a small menu, each with a face, a name and a line. The card lies flat, the head rises behind its top edge, the sentence rolls to "Agent review has it", a token flies to Overview |
| Take it on myself | Your monogram | T | Creates a Task with no run. The marigold tab stands behind the top edge |
| Dismiss | The close | E | The card fades and its place stays open until the pointer leaves, or for 2.6 seconds, so a second click lands on the next card. Plugins are not told |
| Undo | The toast | ⌘Z | Puts the card back in its place |
| Open | Click | Space, Enter | Opens where it lies. Esc folds it back |
| See its Task | On Work | G | Goes through to the Task on Work |
| Carry | Drag | | Lifting a card raises the rail. Esc or letting go elsewhere sends it home |
| Move | | Arrows, J and K | Arrows follow the page. J and K read through it |

A card with a Task stays where it is for the rest of the visit. On the next visit it has settled at the foot of its stack, counted in the foot line, as does a card with nothing open.

## States

| State | Design |
|---|---|
| First run | A welcome over the etched shapes of the stacks, with the sources to connect |
| Inbox zero | A sunrise. The numeral is the sun, in the Deco face; brass rays draw outward when the last card leaves |
| An empty stack | One quiet line in its place. The column stays, as a landmark |
| Loading | The real cards with their words held back, from what the last visit knew. Nothing shifts when words arrive |
| Offline | One line in the bar saying what you see and that moves wait |
| A failing source | One line naming it, and what it means for its cards |
| No person, no status | The slot closes up. Sentry has no person, Gmail has no status |
| Very long title | One line in a strip, two when whole, all of it when open |
| Huge counts | Grouped digits with tabular figures |
| 300 cards | The same page: piles, one per project on the shelf |

## Where it lives

Inbox takes Intake's row in the sidebar's Work section. Intake moves behind it, as Office sits behind Overview: the pill reads `Inbox | Cards | Intake`.

The row shows a plain number, not a badge. It counts what has outlasted its patience, plus what Hercule noticed. A signal landing on a card you already have never raises it.

## New in the design system

| Name | What | Where |
|---|---|---|
| Stack | Fixed depth, shared by its cards | `js/stacks.js` |
| Strip | A card seen through the ones in front of it | `css/card.css` |
| Peek | A whole card raised over the others, inert below its strip | `js/pointer.js` |
| Plaque | Hercule's own card | `css/card.css` |
| Lacquer | `--lacquer`, `--lacquer-lit`, `--lacquer-ink`, `--lacquer-sub`, `--lacquer-rim`, `--lacquer-shadow`, per theme | `css/tokens.css` |
| Stock with a hue | `--stock-manila`, `--stock-ledger`, `--stock-sage` | `css/tokens.css` |
| Stacked height | `--h-stack`, `--h-stack-shade` | `css/tokens.css` |
| Mark in a declared hue | `--mark-ink`, `--mark-l`, `--mark-c` | `css/tokens.css` |
| Patience | A kind's sense of time, and the ramp `--wait-*` | `css/tokens.css` |
| Kept hole | A dismissed card's place, kept while the pointer is near | `js/moves.js` |
| The rail | Who can take a carried card | `js/drag.js` |
| Tray | A pile fanned open, the one thing that scrolls | `js/tray.js` |
