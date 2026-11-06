# Design: Overview and Work

The place where a person sees all their work. It is the view opened every morning. Open `index.html` for the story, `desktop.html` for the real thing. Everything here is invented: Northwind Market and everyone in it are made up.

## The idea in five lines

1. **An open desk.** No boxes. Lanes and stages are space, type and one double rule. Every lane opens, one row each, so the first screen is proper cards.
2. **Height means whose move it is.** A card that wants you stands. A card someone else holds lies flat. A blocked card is pressed in. A landed card is an outline.
3. **The top edge shows who holds it.** A signal tab, a colleague's head, a person's tab, or nothing.
4. **A horizontal line means a plan.** A plan is a wire with one bead per piece, on the same stage axis as the cards. Folding a whole board to wires is the score: something you ask for, never the default.
5. **The first sentence is the filter.**

## Directions explored

Three real sketches on the same 69 Tasks, in `sketches/` (`index.html?d=a|b|c`):

| Sketch | Idea | Verdict |
|---|---|---|
| A. Open desk | No trays. Lanes as space. Plans inside their lane | The quietest. Chosen as the ground |
| B. Drawers | Projects as trays, with a folded front of beads | Too boxy, and the opposite of "remove until it hurts". Its folded front became the fold grammar |
| C. Horizon and slips | All plans as a band on top, thin slips below | The band was lovely, but it split a project's plans from its work, and slips were the tiny cells that were rejected |

## The Overview

### Layout

- The window is the app's: 272px sidebar, main pane with a floating glass pill at 10px from the top and 14px from the left.
- The pill reads **Overview**, then the view tabs. The selected tab sits on a puck that slides. At the right end, 36px glass buttons for Find and Display. They hide in the Office, which has no use for them.
- The sidebar's Work section reads: Overview, Inbox, Workflows, Discussions, Wiki. Overview replaces The office. Intake leaves the sidebar and sits behind Inbox, the way the Office sits behind Overview. That was settled with the Inbox session.
- Rows in Waiting on you point at their card: hover lights it, click opens it.

### Keys

⌘1 Office, ⌘2 Work, and later ⌘3, ⌘4, ⌘5.

### Later views

The switcher is built for five tabs. Each is an icon and a word, so five read as naturally as two, and two do not look empty. `?later=1` shows them, with a sketch of each on the same Tasks: List (a title, a muted line, a mark), One surface (a place per Task, with blockers as structure) and Tracks (a calendar).

## The Work view

### Anatomy at 1440 by 900

| Part | Measure |
|---|---|
| Top of canvas to the sentence | 66px, under the glass pill |
| Left and right margin | 32px. Everything on the page starts on this one left edge |
| Canvas maximum width | 1480px, centred, so cards stay card-shaped on a large window |
| The sentence | 26/32 medium, tracking -0.022em. Numbers in ink with a 2px marigold underline |
| The second line | 12/16, in the gap above the rule. Hidden at rest: it shows on approach to the sentence, under a lens and offline, and moves nothing when it does |
| Sentence to stage rule | 28px |
| Stage rule | 34px tall, ending in a double rule in `--rule-ink`: 2px over 1px, 5px in all, the same rule as the Inbox's stacks |
| Stage count | Limelight 20px, in `--count-ink`, first in the heading, gone at zero, so the names keep the page's left edge |
| Stage name | 11px bold, 0.09em tracking, uppercase |
| Columns | four at 1fr and Landed at 0.72fr, 14px apart: 222px and 160px at 1440; 188px and 135px at 1280. Minimum 168px and 120px; below that the board scrolls sideways, so summaries never clip at high zoom |
| Lane name | 15/20 bold, 28px row. "18 want you" beside it in `--muted`, "Show all 41" on hover. No project mark: a name is enough, and ten tints would mean nothing |
| Space after a lane | 26px. A folded lane has 22px from name to wire and 32px to the next name, so a name clearly owns its wire |
| Plans | under the lane's cards, 20px below them, so the cards come first |
| Plan | 20px name row, 13/18 medium, then a 14px wire, 2px to the next plan |
| Card | 88px tall, 12px corner, padding 10/12 |
| Pile | same height as a card, with 1 to 3 sheets showing 3px each below it |
| Row gap | 22px, which leaves room for what stands behind the top edge |

The stage rule sticks under the top pill while the board scrolls. At rest the stages are only alignment: no column lines. While carrying a card, the target column shows a faint aisle.

A first visit opens every lane at one row: a short scroll, and every project shows proper cards. The whole board at one row is about 1.3 screens. Folding lanes to wires was tried as the default and rejected: it hid 61 of 70 Tasks behind dots, which is the tiny cells he said no to.

### The sentence

It counts what wants you, and each phrase is a lens. A hover of 140ms lights what it counts; pressing keeps it. `Q` quick calls, `R` real thinking, `S` stalled, `A` agents, Esc clears. Blocked work is counted but is not a lens, because there is nothing to act on.

The three counts a person sees mean different things, on purpose. The sidebar's Waiting on you counts sessions with an open question, right now. The Inbox counts outside things that concern you. The sentence counts Tasks whose next move is yours.

### The morning's walk

`N` opens the first thing that wants you, in reading order, and walks on with the details open: "4 of 23" in the pane's head. It goes through piles and folded lanes, lighting where each thing sits. Answering moves on by itself. A lens narrows the walk: press `R`, then `N`, and you walk only what needs real thinking. This is the path for a person sitting down with coffee: read, answer, next.

### The card

```
              [tab or head stands behind this edge]
┌──────────────────────────────┐
│ Title, 13/18 medium, ink,    │  title: up to two lines
│ up to two lines              │
│ Summary, 12/16, muted        │  summary: about six words, 2px below the title
│                      [m]  5d │  age and mark alone at the bottom right
└──────────────────────────────┘
```

All cards are one height. There is no word for who holds it: the tab or head already says so. Title and summary share three lines: a two-line title leaves the summary one line, with an ellipsis if it must. A new summary can never move a neighbour.

**The summary is a design constraint on the writer.** About six words: "Three designs, depots worried." It says where the Task stands, not what happened in detail. That limit is what keeps a board of these from becoming a wall of text, so the model call that writes summaries must be held to it.

Words at the card's hover: after 160ms the summary becomes the need and the question, in place: "Real thinking. Which depot should try it first?"

**The age** darkens as a thing that wants you waits: `--faint`, then `--muted` from 7 days, then ink at weight 500 from 14. Only for what wants you and can be acted on: an agent's age means nothing, and a blocked card's age is not your fault.

**The provenance mark** is 13px, `--muted`, only for an outside source, beside the age.

**Words follow height.** On a dark desk, pale words on an unlit card outshine a lit one, so what lies lower is written dimmer (`--word-flat`, `--word-flat-2`, `--word-press`), and full ink returns on approach. Every step stays above 4.5:1.

### Card states

| State | How it reads |
|---|---|
| Standing (wants you) | `--stock`, `--h-stand`, a marigold tab, ink title. On dark desks shadows say little, so a standing card has a material: a warm stock per theme, a lit top edge and a sheen falling from above (`--stock-sheen`) |
| Flat (someone else) | `--stock-flat`, no rim, no shadow, a head or person tab, words in `--word-flat` |
| Pressed (blocked) | `--stock-press`, `--h-press`, no holder, words in `--word-press`, summary reads "Waits on *blocker*" |
| Etched (landed) | only words: no sheet, faint regular title, set on the column's left edge under the stage name |
| Hover | standing rises to `--h-hover`; flat comes up to `--h-stand`. After 160ms the summary becomes the question, in `--you-ink`. Heads return to full colour |
| Focused | a 2px `--focus` ring, 2px out. The question shows, as on hover |
| Dragging | lifts 3%, `--h-carry` and `--stock-carry` crossfade in on the same spring. A slot stays behind |
| Selected | a 1.5px ink ring and a check in the top-left corner |
| Stalled | the age in ink at weight 500. Wear, when on, adds more. Under a lens it can be seen at once |
| Blocked, on hover | stays down; a thin brass line draws to the blocker through the gaps, and the blocker lights |
| Running agent | a head behind the top edge, paws on the edge, typing in short bursts. Heads rest at 62% saturation, so they never outshout a tab |
| Agent asks you | the head with a raised marigold palm; the card stands |
| Summary pending | "Writing a summary", in `--faint` |
| Offline | tabs, heads and beads lose colour; a line under the sentence says since when; moved cards show a clock until they sync |

### The top edge

One slot, 14px from the right edge, drawn behind the sheet. The tab shows 9px above the edge, 18px wide for a quick call and 40px for real thinking. On a light desk it takes a 1px `--you-ink` ring, so it reaches 5:1. A head is 30px wide, cropped below the mouth, with two 7 by 5 paws on the edge in front of the sheet. A person is an 18px round monogram in `--faint`, so it can never be read as a key. Heads and paws are the same everywhere: on piles, on the open sheet and on the first-run card.

### `blockedBy`

A blocked card is pressed into the desk. Its tab is gone because nobody can move it. It does not rise on hover and it asks nothing, because there is nothing to do yet. Its summary names the blocker. When the blocker lands, the card rises by itself. Hover draws a thin brass line to the blocker, through the gaps between cards, so it never crosses anyone's words.

### Wear

Off by default. Display menu, or `W`. Neglected work ages from 6 days to 30: the stock takes up to 18% of an old paper colour, and the title loses up to 20% of its strength. Agents' cards and landed cards never wear. Moving a card clears its age. (A tilt was tried and cut: at 1x it read as a rendering bug.)

### One row, and stacks

At rest a lane shows one row. Per stage, one real card lies on top: the oldest that wants you, otherwise the oldest. What lies behind it shows as sheets under that same card, with `+3` beside the age. If something behind it wants you, a small marigold tab with that count stands beside its own tab.

- The top card stays the same for the visit. Under a lens, a card that matches comes to the top, so a lens never lights an empty row.
- `+3`, or `E`, fans out what lies behind.
- Clicking the lane's name shows all of it, up to three rows and piles. Clicking again goes back to one row. The cards come out from under the top card, and go back the same way.
- A card dropped on a stack lands on top. The top card slips down 6px to take it, and nothing else moves: a lane at one row never changes height.
- A card leaving a stack shows the next one, already there underneath. There is no hole to hold.
- An arrival on a stack rises on top for a moment, so it is seen, then slides underneath, and only `+3` changes.
- A lane whose Tasks all sit in one plan shows that plan's band, not a name and a hole. Bands follow the same one-row rule.

### Plans

The name row: a chevron on hover, the name, a bullet graph, "7 of 12". The wire: a hairline across all stages, darker between the first and last bead.

**The bullet graph** is 40 by 4: landed in `--muted`, in motion at 42% of that, the rest empty. "7 of 12 landed" shows on hover.

**Beads** have three forms, nothing to decode: ink round for a quick call, ink long for real thinking, and one faint ring for everything else. They are not marigold at rest, so marigold stays rare; under a lens the matching beads take a marigold ring. Past ten in a cell they condense into tally marks, 3 by 10. Click one to open it, or drag it along its wire to change its stage. Clicking the wire itself opens the plan.

Opened, the plan's wire becomes a band of cards, on a faint inlay between two hairlines, with the same cells and piles as a lane.

### Lanes

Lanes keep their order. A folded lane is a name row and a wire holding all its Tasks. Nothing auto-unfolds. A lane with no project is named "No project" and sits last.

### Piles

When a lane shows all its rows, a pile is a stream of similar work (Reviews, Pull requests, Tickets) or the overflow of a cell ("3 more"). It follows the card's rules: the same height, the same top edge. One tab counts what in it wants you, and one head shows agents are on it. Its words are only a name, a count and one short line. Landed is the quietest of all: "2 this week", with no sheet.

Rules:

- A cell shows at most three rows, plus a fourth when only one card is over. Past that, the rest wait in "more". A lane has the same height at 60 Tasks as at 300.
- Three or more of a kind fold. Landed folds from two. Two streams beside two or more cards share one pile, "Reviews and PRs", so they do not need a fourth row.
- **A pile keeps its identity and its place for the visit.** A card leaving can only take something away. It can never split a pile or grow a lane. Regrouping happens on the next visit.
- Cards already showing stay. What arrives waits in the last row, so an arrival never swallows the card you are looking at.
- A card you just put down stays a card, on the row you chose, until the next visit. Nothing is pushed out to make room for it.

Clicking a pile fans it open on the desk's own stage columns, on a desk dimmed 98%, what wants you first, scrolling inside itself past the window's height. Cards in a fan are real: open, drag out, Done. Dragging one out folds the rest back.

### The details pane

A sheet 468px wide, 14px from the right, from 66px down to 14px from the bottom. 16px corner, `--h-carry`, floating over the board rather than splitting it: a split would squeeze five columns and move every card.

From the top: crumbs (project, plan) with "4 of 23" during a walk, title at 20/26, the stage path (click a stage to move there), where it stands at 14/21, Next move (who, the question in `--you-ink`, answers with the suggested one rimmed in `--accent`, and a line to say something else), What is left, Blocked by and Blocks, Threads, Linked. The foot holds Done, Start a thread and Merge on the left, and Drop alone at the right, far from Done.

Answering sends it: the card lies down, a line offers Undo, and a walk moves on. Start a thread asks what the thread should do, on one line, before anything starts. Inside the pane, Esc goes back to the Task you came from, then closes. The question is the page's second voice, at 17/24 bold in ink. Answers are compact chips: the suggested one filled in `--answer`, the rest rimmed. The chips come from the question itself where they can, and a Task that needs real thinking offers a thread instead. `--answer` is each theme's `--accent`, except Nile, whose accent is cream: there it stays green, so "the one suggested answer" means the same in every theme.

### Selecting and bulk moves

`X` or ⌘-click marks a card. A quiet bar offers Done, Drop and Clear. Dragging any selected card carries them all, and they land in order at the slot. One Undo puts them all back.

### Keys

| Key | Does |
|---|---|
| N, ⇧N | next and previous thing that wants you, with details open |
| Arrows, HJKL | walk the desk: up and down stay in the column, left and right go to the nearest height in the next column. On a wire they walk its beads |
| [ ] | previous and next lane |
| Return, Space | open |
| ⇧← ⇧→ | move a card a stage |
| 1 to 5 | move a card to a stage |
| D, ⌫ | Done, Drop |
| M | merge: pick with arrows, Return to confirm |
| T | start a thread |
| X | select |
| E | fan out what lies behind a card |
| F, ⇧F | one row or all of this lane, fold everything to the score |
| Q R S A | lenses |
| / | find |
| W | Wear |
| ⌘Z | undo: one gesture at a time, and only yours, never a fact that arrived |
| ? | keys |
| Esc | steps back, one thing at a time |

Single keys work only with focus on the board, never with a modifier, and can be turned off in Display. With the pane open they act on the open Task, and only on it. While carrying, only Esc means anything. Return and Space belong to whatever has focus.

### Accessibility

Measured in all six themes.

- Text passes 4.5:1 everywhere, including pressed and dimmed cards. The tab reaches 5:1 on light desks, through its ring, and 8:1 or more on dark ones.
- The sheets themselves are not 3:1 against the desk, on purpose: a card is identified by its words, and height is a second channel, not the only one.
- A card's name reads in the order a person needs: title, who holds it, stage, summary, question, age.
- One tab stop leads onto the board, and from there the arrows walk it. A wire is one tab stop too.
- The fan is a dialog, and the board is inert behind it. The details are a dialog named by the Task, not modal, because you can keep working beside it.
- Reduced motion swaps movement for fades. A Still colleagues switch in Display stops paws and blinks for anyone, without touching the system setting.
- Cards use a minimum height, so text-spacing overrides grow them instead of clipping.

## Every state

| State | Treatment |
|---|---|
| First run | The sentence says nothing is here yet. A real standing card in Exploring, with Hercule looking over its edge, says where the first Task will land. One filled button: Start a thread |
| Desk clear | A sunrise. The stage rule is the horizon, and Hercule himself comes up over it, with rays, as a sibling of the Inbox's empty page. "The desk is clear." under the rule |
| One card | One card, in its place. No special layout |
| 300 cards | Ten lanes at one row, every one showing real cards. ⇧F folds all of them into the score: ten projects on one screen |
| Loading | The rule and lanes are there at once. Cards show two quiet bars, and words fade in from the top left. No spinners, no shift |
| Partial data | A card with no summary yet says so. A missing age shows nothing |
| Offline | A line says since when. Moves still work, marked with a clock until they sync. Answers say they will send when you are back |
| A move fails | The card goes back, and the line at the foot says why and what to do |
| Stale | Ages keep counting. Nothing else changes |
| Long titles | Two lines, then an ellipsis. The full title is in the details |
| Huge counts | Numbers stay in their place; a pile of 1,204 is a pile |
| No project | A lane called No project, last |
| Zero plans | No plans drawn. No "no plans" message |

## What would change in the design system

**New tokens**, in `system/primitives.css`: `--desk`, `--lamp`, `--numeral`, `--underline`, `--tab-ring`, `--paper`, `--count-ink`, `--rule-ink`, `--stock-sheen`, `--answer`, `--answer-fg`, `--word-flat`, `--word-flat-2`, `--word-press`, `--stock`, `--stock-carry`, `--stock-flat`, `--stock-rim`, `--stock-rim-flat`, `--stock-lit`, `--stock-press`, `--h-stand`, `--h-hover`, `--h-carry`, `--h-flat`, `--h-press`, `--h-etch`, the `--type-*` roles, `--card-*`, the `--m-*` motion tokens.

**New components:** card, top edge (tab, head and paws, monogram), stack, wire and bead, pile, lens sentence, stage rule, the walk, the sunrise.

**Doctrine changes:**

1. *"Brass is ornament only, never text."* Amended: stage and stack counts are brass that can be read, in the Deco face (`--count-ink`), with the double rule under them. Brass still means nothing. Nowhere else.
2. *"Depth is a hairline and a crisp shallow shadow."* Amended for cards on the desk: height carries meaning.
3. *"Motion: interface moves fast and plainly; only characters get a little spring."* Amended: the interface now has three named springs, chosen by who caused the change.
4. *"Color appears only at word and dot scale."* Holds. Marigold on this page is only on tabs and the underline of the sentence's numbers. Ages and lane counts are neutral.
5. *The split* still holds for Intake and the thread. The details pane on Work is an overlay, because a board must not reflow.
