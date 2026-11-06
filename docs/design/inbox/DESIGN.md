# The Inbox: design

Where everything out there that concerns a person lands, before they take it on. This is the second full design: it starts again from sketch A, with the founder's notes on the first. Every example is invented. `desktop.html` is the working window and `index.html` walks through the reasoning. The motion is in `MOTION.md`.

The Inbox builds on the primitives shared with Work: `SHARED.md` and `system/primitives.css` on `prototype/overview-hifi`, copied here as `vendor/primitives.css`. Nothing in that file is redefined. What the Inbox adds is in `css/tokens.css`, listed at the end of this document.

## The rules

1. **Two shapes, two weights.** Lasting work lies wide in rich cards. Small requests lie in a narrow column of compact cards. The shape of a card says how much attention it deserves, with no label to read.
2. **Everything is visible, and the page scrolls.** Nothing is folded to save room. A count never has to say how much is hiding.
3. **A stack needs a reason you can see.** Only things directly linked by a confirmed claim sit together, and every part is there to read.
4. **Things stay where they are.** A signal never moves a card. A card someone holds keeps its place until your next visit. Only your own move changes what is under the pointer.
5. **One current card.** The pointer and the keys share one current thing, and every move moves on to the next that waits.
6. **Clean first.** The display face is the logo's alone. Counts are small and quiet. Colour lives on status shapes, and the theme speaks through restraint.
7. **No view knows a system.** Everything comes from a table a kind declares and the relations a plugin reports. A check in `tools/check.mjs` fails if a view names one.

## The page

```
┌ pill: Inbox  Cards  Intake ┐ [Group by Place] [Filter]                          ?
 Hercule noticed                        Hercule, over the edge   Requests 14  [Oldest first]
 ┌───────────────────────────────────────────────────────┐    ┌───────────────────────┐
 │ noticed         noticed          noticed              │    │ title              5d │
 └───────────────────────────────────────────────────────┘    │ Juno · storefront-web │
 Ongoing  8 waiting                                           └───────────────────────┘
 ┌───────────────────────────────────────────────────────┐    ┌───────────────────────┐
 │ Payment retries  At risk         ▬▬▬▭▭ 4 of 9  14 Nov │    │ title              5d │
 │ A checkout that never drops a basket · Shop           │    │ ⊖ Felix asked again   │
 ├───────────────────────────────────────────────────────┤    └───────────────────────┘
 │ ◐ In Review   Title                               ID  │    ┌───────────────────────┐
 │               Milestone, date · what happened         │    │ …                     │
 │               [mark] Linked title                 1d  │    └───────────────────────┘
 │                      What it asks  ⊗ what happened    │     With someone else  15
 └───────────────────────────────────────────────────────┘
```

The wide side takes what is left and the narrow column is 320px, 32px apart, 32px from the window's edges. Below 1100px the column moves above the work. What Hercule noticed opens the wide side, so requests start at the very top of the page and the asymmetry shows at once.

| Side | Title | Holds | Order |
|---|---|---|---|
| Top | none | What Hercule noticed, on one card he hands you | As noticed |
| Wide | **Ongoing** | Lasting work: tickets, errors, orders, as rows on the surface of each place | Places in trouble first, then by date. In a place, what has a part asking comes first |
| Narrow | **Requests** | Small things asked of you: review requests that stand alone, mail, mentions | Oldest first, or mine first, or by place |

The small numbers add up: `Requests 14` and `Ongoing 8 waiting` make the 22 in the sidebar.

**Group by** and **Filter** are the same plain tools Work has, on the top bar. Group by offers `Place`, the usual home of each kind, then every kind of place above what lies there, by the name its kind declares, then status. Filter offers whose it is, then every place on the page. An active filter is a chip that can be removed. External hierarchy is context for grouping and filtering, and nothing more.

**Mine and others.** Requests are mostly other people's. Something of yours says `yours` beside its place, and Filter shows only yours or only theirs. Your own pull requests nearly always ride on a ticket, so they are on the wide side, marked `Yours`.

What Hercule noticed lies on one card of the page's own stock, with ink words and `--h-rest`. He stands behind its top edge at the right with his paws on it, the same blue head with the hat that Work draws. So it reads as a colleague handing you something, and it needs no label.

## The stack

There is one stack left, and it has a reason: **a thing and what is directly linked to it.** Each linked thing is a row set in under its lead's title, so it reads as riding on it.

1. **Which leads.** The lasting thing leads, so a transient thing rides on what it belongs to: a pull request rides on its ticket. Among equals the most pressing leads, measured against the patience its kind declares. A pull request that stands alone stays in the column.
2. **Where it sits.** With its lead. A ticket stays under its project even when a part is urgent, and the part says so on its own row: what it asks, its wait, and its moves. The urgency never moves the ticket out of its project, because its place is what makes it readable.
3. **How a signal shows.** It lands on the part's row: the drop, the rim, the new words. The row keeps its place, and the lead never changes under you. In a block, a card with a part asking comes first on the next visit.
4. **What joins.** Only a direct link that the source reports or a person made. A reference found in text is a hint under the card, `Mentions OPS-47`, until someone confirms it. Sharing a repository or a project never joins anything. A chain A to B to C joins only what touches the lead, so a stack never pulls in a neighbourhood.
5. **Top and stack are different.** A click on the card opens the card. A click on a row opens that row's thing. Every row is always there, so there is nothing to expand.
6. **A row you cannot see.** A link can point at something you have no access to. Its row says `A Sentry issue you cannot open`, with a lock and no title.

## How things relate

Two relations, and neither knows a system. `js/relations.js` is the whole of it.

**Part of** points upward and is a graph, not a chain. A thing can have many parents, a team is one path among others, and a project can sit in two initiatives. Nothing is ever shown as if it had one parent: a card in two projects shows under each, the second as a plain pointer, and it is counted once. The head of a place lists everything it is in turn part of. The card details list every place above a thing, by the name its kind gives that level.

**Linked** is between peers, and every link says who claims it:

| Claim | Example | Joins cards | Shown |
|---|---|---|---|
| `source` | The ticket reports the pull request | Yes | On hover: `Linear reports this` |
| `person` | You or a colleague linked them | Yes | On hover: `Noa linked this`, and it can be removed |
| `text` | `#6263` mentions `OPS-47` in its description | No, a hint | `Mentions OPS-47` under the card, and the evidence in the details, with `Link` |

A person links two things three ways: `Link them` on a hint, the search in the card details, or carrying one card onto another. Each is one move with one Undo, and the source is never told. What Hercule noticed is his own kind, and stays apart from all of this.

A place is an ordinary entity that nothing has made a card of. It has a title, a state, and progress **only if the source reports it**. The page never works progress out from the cards it can see, because those are only what concerns you. Opening a place shows the bigger picture: what it says about itself, how it stands, what is above it, its history, and what in it concerns you.

## Card anatomy

A place is one surface with Work's 12px corner and `--h-rest`. Its work lies on it as rows. A request is a small card of its own. Type: place 16/22 semibold, status 13/20 medium, row title 14/20 medium, request title 13/18 medium, summary 12/16, meta 11/16.

```
 a row, on the surface of its place             a request
 ┌───────────────────────────────────────────┐  ┌───────────────────────────────┐
 │ ◐ In Review   Title                    ID │  │ [mark] Title, up to        5d │
 │               Milestone, date · Tessa     │  │        two lines              │
 │               commented 1d                │  │        Juno · storefront-web  │
 │               [mark] Linked title      1d │  └───────────────────────────────┘
 │                      What it asks ⊗ news  │
 └───────────────────────────────────────────┘
```

| Slot | Declared by | Rule |
|---|---|---|
| Mark | `plugin` | In `--mark-ink`, or in the hue the plugin declares. Every logo has one strength. A row leaves it out when the place above it already shows it |
| Status | `status` | First and in a fixed place on a row, because on lasting work it is the point: a shape and a word in ink. On a request, a shape only when it is not the usual state |
| Title | The entity | Two lines at most, all of it when open |
| Sentence | `reasons`, `person` | The latest signal, as a human sentence with the person in it, and how long ago. On a request the usual one needs only a name, because the column's title says what they are. A lasting thing that has only been assigned says nothing |
| Wait | `pace`, `patience` | On what has a clock. Ink and weight only, measured against patience: `--wait-fresh`, `--wait-recent`, `--wait-due`, `--wait-over` |
| Place | `section`, `home` | On a row, the next places below the one it is shown under, such as its milestone, on every path. On a request, its home |
| Identifier | `identifier` | Quiet at the end of a row. On a request it waits for the open card |
| Facts | `facts` | On the place line. Priority bars wait for the open card |

People are words on a card. A monogram is kept for you, and faces are for colleagues.

### What a card shows when

| State | Shows |
|---|---|
| At rest | Its words, and on a row what rides on it |
| Hover | The moves, each with its name: `[face] Agent review`, `Take it`, a close. On a row they take the end of the first line. On a request they take the end of the second, and its words end with an ellipsis. With several workflows, `Hand to…`. A linked row that asks something shows the same moves |
| Open | Everything: status, where it sits, the timeline of signals with linked things woven in, the links, the moves |

## The table a plugin declares

Every kind is one table in `js/kinds.js`. Places are kinds too. Here are four side by side, and this is the agnostic test: nothing else in the Inbox needs to know these names.

| | GitHub | Linear | Sentry | Quayside (invented) |
|---|---|---|---|---|
| Kind | `pull-request` | `issue` | `issue` | `purchase-order` |
| Noun | Pull request | Issue | Error | Purchase order |
| Card | `compact` | `rich` | `rich` | `rich` |
| Pace, patience | fast, 24h | slow, 14 days | fast, 12h | slow, 5 days |
| Identifier | `#{number}` | `{key}` | `{key}` | `{key}` |
| Person, owner | author, author | assignee, assignee | none, assignee | none, assignee |
| Status | Open, Checks failed, Changes requested, Approved, Draft, Merged | Triage, Backlog, Todo, In Progress, In Review, Done | Unresolved, Came back, Resolved | Waiting for sign-off, Held at the quay |
| Facts | diff, files | priority, | events, shoppers | amount, due |
| Part of (`home` first) | Repository | Project, Milestone, Team, Initiative through its project | Project | Delivery round, Site through its round |
| Section | none | Milestone | none | none |
| Place status | none | On track, At risk, Off track | none | Receiving |
| Place progress | none | when reported | none | when reported |
| Links it reports | to tickets, in text | attachments to pull requests | to tickets | none: only a person links it |

```js
'linear/issue': {
  card: 'rich',            // rich, compact: how much room it deserves
  noun: 'Issue',
  plugin: { name: 'Linear', mark: 'linear', hue: 277 },
  pace: 'slow',            // fast has a clock; slow does not
  patience: 336,           // hours before a wait counts as due
  identifier: '{key}',
  person: 'assignee',      // a field, or null
  owner: 'assignee',       // the field that says it is yours
  home: 'linear/project',  // the kind of place it is usually grouped under
  section: 'linear/milestone', // the level shown on the card, below its home
  status: { started: { shape: 'half', tone: 'active', word: 'In Progress' } },
  facts: [{ field: 'priority', form: 'bars' }],
  reasons: { moved: { say: 'Moved to {value}', tone: 'plain' } },
  workflows: { assigned: ['Draft a change', 'Build it with a second opinion'] },
}
```

A plugin reports its relations as data, each one a claim: `{ from, rel: 'part-of', to, claim: { type: 'source' } }` and `{ from, rel: 'linked', to, claim: { type: 'text', by: 'GitHub', evidence: 'the description of #6263' } }`.

| Field | Fixed set |
|---|---|
| Shape | `ring` open, `dashed` not real yet, `quarter` `half` `most` under way, `fork` a proposed change, `join` merged, `check` finished, `cross` failed or refused, `hold` waits for a change, `alert` burning |
| Tone | `quiet`, `active`, `you`, `good`, `bad` |
| Card | `rich`, `compact` |
| Fact form | `delta`, `count`, `word`, `date`, `money`, `bars` |
| Reason tone | `plain`, `you`, `good`, `bad` |
| Claim | `source`, `person`, `text` |

### Room to grow

Customization grows by adding to these sets, never by a kind drawing itself. The card has no branch on a kind's id, and it should stay that way.

- A new fact form, such as `duration`, added to the core and open to every kind.
- A plugin may declare a stream, so like things from one source, such as dependency updates, become one group with an obvious reason.

## The moves

| Move | Pointer | Key | What happens |
|---|---|---|---|
| Hand to an agent | The workflow by name on hover; the rail while carrying | H, then 1 to 3 with several | One workflow: at once. Several: a small menu, each with a face, a name and a line. The colleague rises over the top edge, the card lies flat, the sentence rolls to "Agent review has it", and its mark flies to Overview |
| Take it on myself | `Take it` | T | Creates a Task with no run. The marigold tab stands behind the top edge |
| Dismiss | The close | E | The card steps aside and the next rises into its place, so the same click at the same spot dismisses the next, for as long as the pointer stays there. Plugins are not told |
| Undo | The undo line, at the foot of the window | ⌘Z | As far back as you like, from any view. A hand-off plays backwards, and the line says the run stops |
| Open | Click a card, a row or a place's head | Space, Enter | Opens where it lies. Esc folds it back. Focus goes to the sheet, not to a move, so Enter never starts an agent. J and K walk to the next thing in the same place, and a place or a link inside the sheet walks there |
| Link | `Link them` on a hint; the search in the details; carry a card onto another | | One move, one Undo. A person's link can be removed from the details |
| See its Task | On Work | G | Goes through to the Task on Work |
| Carry | Drag | | Lifting a card raises the rail. Over another card, letting go links them. Esc or letting go elsewhere sends it home |
| Move | | Arrows, J and K | Arrows follow the page, by where things lie. J and K read through it |
| Group, order | Two plain menus | | They rearrange what is there, and change no number |

Moves refuse with a reason where they do not apply: a held card says who has it, and G with no Task says so. An open menu owns the keyboard. A held key never runs through the page.

A card with a Task stays where it is for the rest of the visit. On the next visit it has settled under `With someone else`, at the foot of the column, which opens in place.

## States

| State | Design |
|---|---|
| First run | The real page, no dialog. Hercule hands you one line saying what this place is, Ongoing asks for what lasts, Requests asks for what arrives, and the sidebar is empty |
| Inbox zero | A small sunrise, 440px wide. Hercule's head, the same one Work draws, comes up over a brass horizon, and the rays draw outward. "All clear." |
| No requests left | The same sunrise, small, in the column, because lasting work never ends and finishing the requests deserves its moment |
| Loading | The real cards with their words held back, from what the last visit knew. Nothing shifts when words arrive |
| Offline | One line in the bar saying what you see and that moves wait |
| A failing source | One line naming it, and what it means for its cards |
| No person, no status | The slot closes up. Sentry has no person, Gmail has no status |
| Very long title | Two lines on a card, all of it when open |
| Huge counts | Grouped digits with tabular figures |
| 300 cards | The same page, longer. Nothing folds, and it scrolls |

## Where it lives

Inbox takes Intake's row in the sidebar's Work section. Intake moves behind it, as Office sits behind Overview: the pill reads `Inbox | Cards | Intake`, with no count on Intake, because the noisiest number should not sit above a page meant to be calm.

The row shows a plain grey number, not a badge. A signal landing on a card you already have never raises it. Something new while you are elsewhere adds one small dot.

## Tried and dropped

- **The kept hole.** A dismissed card's place stayed open for 2.6 seconds, so nothing moved. In practice the next card's close was 50px away, and rapid dismissing stumbled. The tab rule replaced it.
- **The plate.** A lacquer and brass band across the top, the one object opposite the page. It was the loudest thing in either design, and read as an outage banner. Hercule now hands you a card of the page's own stock.
- **Stepping back repeated logos.** It read as read and unread, on the very thing that was praised.
- **Blur behind a sheet.** It read as stock, and it mirrored text at the edges of a scaled frame. The veil is flat.
- **The page sentence.** "Juno has waited longest" repeated what the lead card already said.
- **Colour on sentences.** Six red lines flattened what red means. Colour moved to the status shape.
- **A monogram on every card.** It repeated the name beside it at 7px.
- **The numeral as the sun.** The Deco zero read as a dark mode toggle. Hercule's head is the sun now.
- **Three separate triage cards.** They read as a row of KPI tiles, and each seemed to belong to the column under it.
- **A heavy logo in full ink on every row.** At 19 rows it was the heaviest thing on the page. Solid marks are now drawn at 90% and in `--mark-ink`.
- **Stage columns.** To review, To answer, To finish. The founder found them arbitrary, and they sorted things by a label nobody needs.
- **The deck of piles.** A lead, strips and a pile with a count, opening into a tray. A pile hid unrelated things behind an unrelated top card, and `11 more` opened a small box that still had to be scrolled. Nothing is folded now: the page scrolls, and the only stack is things that truly belong together.
- **Big numbers and the double brass rule.** They made the page read like a dashboard, and the display face belongs to the logo. Counts are small and quiet, and only where they help.
- **Tinted stock.** Manila for mail, ledger for tickets, sage for orders. The one cream card read as selected, and the logo already says what a thing is.
- **Cards on the wide side.** Rich cards side by side were nearly the size of the compact ones, so the page stayed monotone. One surface per place, with work as rows, made the two shapes really different.
- **Pull requests in the big area.** The first reading of sketch A kept the small transient things wide. The founder corrected it: what he liked was the asymmetry and the two card shapes, and pull requests deserve the small one.
- **Grouping everything connected.** Stacking a whole set of linked things would pull in the neighbourhood. Only direct, confirmed links join.
- **Working out progress from what is on screen.** The cards here are only what concerns you, so any sum from them is wrong. A bar appears only where the source reports one.

## New in the design system

| Name | What | Where |
|---|---|---|
| A row and a request | Two shapes that say how much attention a thing deserves | `css/card.css` |
| The place | One surface: its name, how it stands, reported progress, what it is part of, and its work as rows | `css/inbox.css` |
| A linked row | What rides on a row, set in under its title | `css/card.css` |
| Reported progress | A 4px bar in ink at 55%, only from the source | `css/inbox.css` |
| The hint | A reference found in text, quiet, until a person confirms it | `css/card.css` |
| The noticed card | What Hercule noticed, on the page's own stock, with him over the top edge | `css/card.css` |
| Mark in a declared hue | `--mark-ink`, `--mark-l`, `--mark-c` | `css/tokens.css` |
| Patience | A kind's sense of time, and the ramp `--wait-*` | `css/tokens.css` |
| The veil | `--veil`: flat, with no blur. Paper in the light themes, the scrim in the dark | `css/tokens.css` |
| The drop | What falls onto a card before it reacts to a signal | `js/landing.js` |
| The rail | Who can take a carried card | `js/drag.js` |
