# Design: Overview and Work

The place where a person sees all their work. It is the view opened every morning. Open `index.html` for the story, `desktop.html` for the real thing. Everything here is invented: Northwind Market and everyone in it are made up.

## The idea in five lines

1. **An open desk.** No boxes. Lanes and stages are space, type and one brass line.
2. **Height means whose move it is.** A card that wants you stands. A card someone else holds lies flat. A blocked card is pressed in. A landed card is an outline.
3. **The top edge shows who holds it.** A signal tab, a colleague's head, a person's tab, or nothing.
4. **Anything folded is a wire with beads,** on the same stage axis as the cards.
5. **The first sentence is the filter.**

## Directions explored

Three real sketches on the same 69 Tasks, in `sketches/` (`index.html?d=a|b|c`):

| Sketch | Idea | Verdict |
|---|---|---|
| A. Open desk | No trays. Lanes as space. Plans inside their lane | The quietest. Chosen as the ground |
| B. Drawers | Projects as trays, with a folded front of beads | Too boxy, and the opposite of "remove until it hurts". Its folded front became the fold grammar |
| C. Horizon and slips | All plans as a band on top, thin slips below | The band was lovely, but it split a project's plans from its work, and slips were the tiny cells Rogier rejected |

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
| Left and right margin | 32px |
| Canvas maximum width | 1480px, centred, so cards stay card-shaped on a large window |
| The sentence | 20/28 medium, tracking -0.016em |
| The second line | 12/16, 5px below |
| Sentence to stage rule | 20px |
| Stage rule | 30px tall, 1px brass line at 68%, fading to 26% at the right end |
| Stage name | 11px bold, 0.09em tracking, uppercase |
| Stage count | Limelight 16px, in `--numeral` |
| Columns | four at 1fr and Landed at 0.72fr, 14px apart: 222px and 160px at 1440; 188px and 135px at 1280 |
| Lane name | 14/20 bold, 28px row, 9px rotated-square inlay in the project's tint |
| Space after a lane | 26px, or 12px when folded |
| Plan | 18px name row and a 16px wire, 8px apart from the next plan |
| Card | 96px tall, 12px corner, padding 10/12/8 |
| Row gap | 16px, which leaves room for what stands behind the top edge |
| Pile | 62px tall, plus 4px per sheet |

The stage rule sticks under the top pill while the board scrolls. At rest the stages are only alignment: no column lines. While carrying a card, the target column shows a faint aisle.

### The sentence

It counts what wants you, and each phrase is a lens. Hovering lights what it counts; pressing keeps it. `Q` quick calls, `R` real thinking, `S` stalled, `A` agents, Esc clears.

One sentence uses one kind of number: words up to twelve, digits when either count is larger.

Blocked work is counted but is not a lens, because there is nothing to act on.

### The card

```
          [tab or head stands behind this edge]
┌─────────────────────────────┐
│ Title, 13/18 medium, ink    │
│ up to two lines             │  three lines shared by title and summary
│ Summary, 12/16, muted       │
│                             │
│ Quick call       [mark]  5d │  foot: 11/16, faint
└─────────────────────────────┘
```

All cards are one height. Title and summary share a clamp of three lines, so a long title takes room from the summary, and a new summary can never move a neighbour.

The foot says what it needs in a word or two, the provenance mark (12px, `--faint`, only if it has an outside source), and the age.

**The age** darkens as a thing that wants you waits: `--faint`, `--muted` from 7 days, `--you-ink` at weight 500 from 14 days. Only for what wants you: an agent's age means nothing.

### Card states

| State | How it reads |
|---|---|
| Standing (wants you) | `--stock`, `--h-stand`, a marigold tab, ink title |
| Flat (someone else) | `--stock-flat`, `--h-flat`, a head or person tab, softer title |
| Pressed (blocked) | `--stock-press`, `--h-press`, no holder, muted title, foot reads "Waits on *blocker*" |
| Etched (landed) | transparent, `--h-etch`, regular weight faint title |
| Hover | standing rises to `--h-hover`; flat comes up to `--h-stand`. After 160ms the summary becomes the question, in `--you-ink` |
| Focused | a 2px `--focus` ring, 2px out. The question shows, as on hover |
| Dragging | `--stock`, `--h-carry`, scale 1.035, leaning. A dent stays behind |
| Selected | a 1.5px ink ring and a check in the top-left corner |
| Stalled | the age in `--you-ink`. Wear, when on, adds more |
| Blocked, on hover | a thin brass line draws to the blocker, which lights |
| Running agent | a head behind the top edge, paws on the edge, typing |
| Agent asks you | the head with a raised marigold palm; the card stands |
| Summary pending | "Writing a summary" in `--faint`, pulsing slowly |
| Offline | tabs and heads lose colour; a line in the sentence area says since when |

### The top edge

One slot, 14px from the right edge, drawn behind the sheet. The tab is 14 by 9 for a quick call and 30 by 9 for real thinking. A head is 30px wide, cropped below the mouth, with two 7 by 5 paws on the edge in front of the sheet.

### `blockedBy`

A blocked card is pressed into the desk. Its tab is gone because nobody can move it. Its foot names the blocker. When the blocker lands, the card rises by itself. Hover draws the link.

### Wear

Off by default. Display menu, or `W`. Neglected work ages from 6 days to 30:

- the stock takes up to 18% of an old paper colour,
- the card drifts up to 0.5 degrees out of true, alternating by a hash of its id,
- the title loses up to 20% of its strength.

Agents' cards and landed cards never wear. Moving a card clears its age, so it straightens.

### Plans

The name row: a chevron on hover, the name, a bullet graph, "7 of 12". The wire: a hairline across all stages, darker between the first and last bead.

**The bullet graph** is 40 by 4: landed in `--muted`, in motion at 42% of that, the rest empty.

**Beads** are 8px: marigold filled for a quick call, marigold ring for real thinking, ink for an agent, faint ring for someone else, pale ring for blocked, faint filled for landed. Past ten in a cell they condense into tally marks, 3 by 10.

Opened, the plan's wire becomes a band of cards, on a faint inlay between two hairlines, with the same cells and piles as a lane.

### Lanes

Lanes keep their order. A folded lane is a name row and a wire holding all its Tasks. Nothing auto-unfolds. A lane with no project is named "No project" and sits last.

### Piles

A pile is a stream of similar work (Reviews, Pull requests, Tickets, Landed) or the overflow of a cell ("3 more"). Its flags show how much of it wants you, up to six. Its second line says the same in words, and a stack of up to four small faces shows who is on it.

Rules:

- A cell holds at most three rows. A lane has the same height at 60 Tasks as at 300.
- Three or more of a kind fold. Landed folds from two.
- Overflow goes to "more", on the last row.
- A card you just moved stays out of any pile until the next visit.

Clicking a pile fans it open beside itself on a dimmed desk, up to four columns, scrolling inside itself past the window's height. Cards in a fan are real: open, drag out, merge.

### The details pane

A sheet 468px wide, 14px from the right, from 54px down to 14px from the bottom. 16px corner, `--h-carry`, floating over the board rather than splitting it: a split would squeeze five columns and move every card.

From the top: crumbs (project, plan), title at 20/26, the stage path (click a stage to move there), where it stands at 14/21, Next move (who, the question in `--you-ink`, and answers: the suggested one filled in `--accent`), What is left, Blocked by and Blocks, Threads, Linked. The foot holds Done, Drop, Merge and Start a thread, each with its key.

### Selecting and bulk moves

`X` or ⌘-click marks a card. A quiet bar offers Done, Drop and Clear. Dragging any selected card carries them all.

### Keys

| Key | Does |
|---|---|
| Arrows, HJKL | walk the desk by position |
| Return, Space | open |
| ⇧← ⇧→ | move a card a stage |
| 1 to 5 | move a card to a stage |
| D, ⌫ | Done, Drop |
| M | merge: pick with arrows, Return to confirm |
| T | start a thread |
| X | select |
| F, ⇧F | fold this lane or plan, fold everything |
| Q R S A | lenses |
| / | find |
| W | Wear |
| ⌘Z | undo |
| ? | keys |
| Esc | steps back, one thing at a time |

## Every state

| State | Treatment |
|---|---|
| First run | The sentence says nothing is here yet. An outlined card in Exploring, with Hercule looking over its edge, says where the first Task will land. One filled button: Start a thread |
| Desk clear | "The desk is clear." with what landed this week. Hercule at rest. The stage rule stays, so the place is still the place |
| One card | One card, in its place. No special layout |
| 300 cards | Ten lanes, most folded. ⇧F folds all of them: everything on one screen |
| Loading | The rule and lanes are there at once. Cards show two quiet bars, and words fade in from the top left. No spinners, no shift |
| Partial data | A card with no summary yet says so. A missing age shows nothing |
| Offline | A line says since when. Moves still work and wait to sync |
| A move fails | The card goes back, and the line at the foot says why and what to do |
| Stale | Ages keep counting. Nothing else changes |
| Long titles | Two lines, then an ellipsis. The full title is in the details |
| Huge counts | Numbers stay in their place; a pile of 1,204 is a pile |
| No project | A lane called No project, last |
| Zero plans | No plans drawn. No "no plans" message |

## What would change in the design system

**New tokens**, in `system/primitives.css`: `--desk`, `--lamp`, `--numeral`, `--stock`, `--stock-flat`, `--stock-rim`, `--stock-rim-flat`, `--stock-lit`, `--stock-press`, `--h-stand`, `--h-hover`, `--h-carry`, `--h-flat`, `--h-press`, `--h-etch`, the `--type-*` roles, `--card-*`, the `--m-*` motion tokens.

**New components:** card, top edge (tab, head and paws, person tab), wire and bead, pile, lens sentence, stage rule.

**Doctrine changes:**

1. *"Brass is ornament only, never text."* Amended: the five stage counts on Work are brass, set in the Deco face. Brass still means nothing, and it is too pale for a light desk, so `--numeral` darkens it there. Nowhere else.
2. *"Depth is a hairline and a crisp shallow shadow."* Amended for cards on the desk: height carries meaning.
3. *"Motion: interface moves fast and plainly; only characters get a little spring."* Amended: the interface now has springs, named and restrained.
4. *The split* still holds for Intake and the thread. The details pane on Work is an overlay, because a board must not reflow.
