# Design: Overview and Work

The place where a person sees all their work. It is the view opened every morning. Open `index.html` for the story, `desktop.html` for the real thing. Everything here is invented: Northwind Market and everyone in it are made up.

## The idea in five lines

1. **Clean first.** One UI face, one hairline, real cards. The theme shows through restraint, not ornament. Counts are small and useful, and never the page's voice.
2. **A card is a stage and a sheet.** Every card is the same sheet. Most cards have nothing more to say. Nobody's "move" is drawn, because most cards have none.
3. **Normal controls.** Group by, Filter, Find, Add. Everybody knows them, and more ways of grouping will need them anyway.
4. **Lanes and initiatives cannot be confused.** A lane is a label or a band. An initiative is a coloured line with a flag. Only initiatives are lines.
5. **The outside world is a graph, not a ladder.** A thing can be part of several things. Group by and Filter read whatever the sources report, and no view knows any source by name.

## Directions explored

The first round, three sketches on the same 69 Tasks, in `sketches/` (`index.html?d=a|b|c`):

| Sketch | Idea | Verdict |
|---|---|---|
| A. Open desk | No trays. Lanes as space. Plans inside their lane | The quietest. Chosen as the ground |
| B. Drawers | Projects as trays, with a folded front of beads | Too boxy |
| C. Horizon and slips | All plans as a band on top, thin slips below | The band was lovely, and it is back as "On top". The slips were the tiny cells that were rejected |

The founder's notes led to three tries at telling a lane from an initiative. All three give lanes a heavier type role and a mark of their own, and give initiatives a coloured flag and line.

| Treatment | Idea | Verdict |
|---|---|---|
| Bands | A lane's head is a full-width strip, and all under it belongs to it | Kept, and the default. The strongest separation, and cards stay wide. A label sits above each line, so initiatives take a little more height |
| Side labels | A left column holds every row's name, as in the lo-fi. Stages start to its right | Kept. Rows read like rows, and an initiative is one line tall. Costs 210px of card width |
| Surfaces | Each lane is a soft panel with its cards inside | Cut. It reads well, but it nests sheet on panel on desk, and bands do the same job with less |

Both kept treatments, and both places for initiatives, switch in the Display menu on the same data. The default is bands with initiatives on top: the initiatives are the lo-fi the founder liked, and bands keep cards at their full width, which is the clean card he liked too. Below 1320px of window, side labels cannot spare their column, so lanes become bands.

## The Overview

### Layout

- The window is the app's: 272px sidebar, and a main pane with one toolbar row 10px from the top, 14px from the sides.
- From the left: the glass pill (**Overview**, then the view tabs, with the selected tab on a puck that slides), Group by, Filter and any filter chips. At the right end: Find, Display, and Add. All are 36px glass, and the toolbar hides in the Office, which has no use for it.
- The sidebar's Work section reads: Overview, Inbox, Workflows, Discussions, Wiki. Overview replaces The office. Intake leaves the sidebar and sits behind Inbox, the way the Office sits behind Overview.
- Rows in Waiting on you point at their card: hover lights it, click opens it. That section stays exactly as it is in the app.

### Keys

⌘1 Office, ⌘2 Work, and later ⌘3, ⌘4, ⌘5.

### Later views

The switcher is built for five tabs. Each is a word, with no icon, so five read as naturally as two, and two do not look empty. `?later=1` shows them, with a sketch of each on the same Tasks: List (a title, a muted line, a mark), One surface (a place per Task, with blockers as structure) and Tracks (a calendar).

## The Work view

### Anatomy at 1440 by 900

| Part | Measure |
|---|---|
| Toolbar | 36px, 10px from the top. It stays while the board scrolls |
| Stage headers | 32px, UI type 12/16 medium in ink, the count beside it in `--faint`, over one 1px `--divider`. They stick under the toolbar on solid `--desk`, so no card shows through while the board scrolls |
| Left and right margin | 32px. Everything on the page starts on this one left edge |
| Canvas maximum width | 1480px, centred, so cards stay card-shaped on a large window |
| Label column | 0 with bands, 210px with side labels |
| Columns | four at 1fr and Landed at 0.72fr, 14px apart. Minimum 150px and 112px; below that the board scrolls sideways |
| Lane name | 14/20 bold, with a chevron, a small folder in `--muted` and a count of its Tasks in `--faint`. Colour stays with initiatives |
| Between lanes | a 36px band in `--band` with bands; one 1px `--divider` with side labels |
| Initiative row | a 22px name row over an 18px line with bands; 40px with side labels |
| Card | 88px tall at least, 12px corner, padding 10/12 |
| Row gap | 20px, which leaves room for a colleague's head behind the top edge |

The stage headers stick while the board scrolls, and so do lane names, so a long lane never loses its name. At rest the stages are only alignment: no column lines. While carrying a card, the target column shows a faint aisle.

### The toolbar

It replaces the sentence that opened this page. A sentence you had to press to filter was clever, and it explained little. These are the controls everybody knows.

- **Group by** says what it is set to: "Group by Project". The menu lists Project and Initiative, then "From your sources": every kind that a source reports and that declares itself groupable, such as Linear project, Linear team, GitHub repository. Nothing is hard-coded. A new plugin adds rows by reporting data.
- **Filter** opens one menu. State comes first, as plain checkboxes: Has a question, Failed, With an agent, Blocked. Under it are Project, Initiative, Source, then what the sources report. A facet opens its values in the same menu, with a Back row, and a Find box past seven values. Each value shows how many Tasks it would leave.
- **Chips.** What is on sits beside Filter, one chip each, with its caption: "Linear project Returns at the depots". A click removes it. Two or more offer Clear. Esc clears everything.
- **Find** (`/`) narrows the board as you type, and lists the top matches.
- **Display** holds the comparison (Initiatives on top or in lanes; side labels or bands), Wear, Still colleagues, Single-key shortcuts, and Fold everything.
- **Add** is the page's one filled button. See Add to Work.

A filter is a question about Tasks, so it answers with cards. What does not match leaves the page, lanes with nothing left go, and closed initiatives and folded lanes open while it is on. Nothing is lost: turn the filter off and everything is where it was. Values of one facet add up, and facets narrow.

### Grouping and lineage

Group by is the lineage control. "Show me everything that came from this Linear project" is Group by Linear project, or Filter on it.

- A lane for an outside thing shows the source's mark, its title, and what it says about itself: "Linear project · In progress", then a 4px bar and "6 of 14". Words always say whose they are, so a Linear initiative is never mistaken for a Hercule one.
- **Progress shows only when the source reports it.** It is never worked out from the Tasks you can see. Pricing rules reports none, so it shows none.
- **A Task can sit under two lanes.** `part of` is a graph, so a ticket in two projects has a card in each, and that card says "In 2 projects" with their names on hover. The stage headers count Tasks, so nothing is counted twice.
- A last lane holds what has none: "No Linear project".
- Tasks are matched through their own linked things and upward `part of` paths only. A peer's ancestors are not yours.
- Hercule's Initiatives stay separate. An outside initiative is only ever a lane or a filter here, and filtering by one never changes a Task's project or initiative.
- With any grouping but Project, a card shows a small flag in its initiative's colour, so that identity is not lost.

Dragging between lanes changes what you would expect: the project, or the initiative. A lane for an outside thing belongs to the source, so a drop there changes the stage and never the membership.

### The card

```
                       [a colleague's head, only while a Thread is on it]
┌──────────────────────────────┐
│ Title, 13/18 medium, ink,    │  title: up to two lines
│ up to two lines              │
│ Summary, 12/16, muted        │  summary: about six words, 2px below the title
│                  [J] [m]  5d │  who at the source, the mark, the age
└──────────────────────────────┘
```

This is the base: the clean card the founder liked. All cards are one sheet at one height, so a board of them is calm. Title and summary share three lines: a two-line title leaves the summary one line, with an ellipsis if it must. A new summary can never move a neighbour.

**The summary is a design constraint on the writer.** About six words: "Three designs, depots worried." It says where the Task stands. That limit is what keeps a board of these from becoming a wall of text, so the model call that writes summaries must be held to it.

**The age** is neutral: `--faint`, whatever it says. It is a fact, not a warning.

**The provenance mark** is 13px, `--muted`, only for an outside source, beside the age. A person at the source, such as a reviewer, is a 16px monogram beside it.

### Card states

| State | How it reads |
|---|---|
| At rest | `--stock`, `--h-rest`, ink title, `--muted` summary. On dark desks a shadow says little, so the sheet has a lit top edge and a sheen falling from above (`--stock-sheen`) |
| A Thread is working | a head behind the top edge, paws on the edge, typing in short bursts. Heads rest at 62% saturation |
| A Thread has a question | the head raises its marigold palm at full colour, and the question takes the second line in `--you-ink`, with up to two lines of its own. Nothing else changes. See Open questions |
| Failed | the head wears its plaster with its paws off the edge, and the failed mark and "Review PR failed: cause" in ink take the summary's place. It leads its cell. See A failed run |
| Blocked | `--stock-flat`, a hairline, words in `--word-press`, a small lock, and "Waits on *blocker*" |
| Landed | only words: no sheet, faint regular title. Landed opens from "3 landed" |
| Hover | the shadow grows to `--h-hover`. The words never change |
| Focused | a 2px `--focus` ring, 2px out |
| Dragging | lifts 3%, and `--h-carry` and `--stock-carry` crossfade in on the same spring. A slot stays behind |
| Selected | a 1.5px ink ring and a check in the top-left corner |
| Summary pending | "Writing a summary", in `--faint` |
| Offline | heads and beads lose colour; the toolbar says since when; moved cards show a clock until they sync |

### Open questions

"Wants you" has one meaning: a Thread on the Task has an open question. Approvals, signals, summaries and inferred next moves do not set it. Threads should rarely ask, so this is a small mark on the rare card, never a place on the page.

- On the card: the raised palm, and the question as the second line.
- In a folded lane: a 6px marigold dot beside its stage's count.
- On an initiative's line: a marigold bead.
- In Filter: "Has a question".
- In the sidebar: Waiting on you, as the app has it. Those rows and these cards are the same questions.

There is no count on the board, no lane headline, and no walk from one to the next. The Filter menu shows how many each value would leave, as it does for every value, and the sidebar is the app's own. `?scene=quiet` shows the normal case: nothing asks, and the board is complete.

### A failed run

With Tracking gone, this is how a failed agent run reaches you. `?scene=failed` draws one, and "A run fails" in the Prototype tray makes one happen while you watch.

The words are always the step and the cause, in ink: "Review PR failed: the branch changed mid-run." With no known cause they stop at "Review PR failed." Nothing replaces them on the card: not hover, and not a new summary. The summary stays readable in the details.

| Place | What shows |
|---|---|
| Sidebar, Hercule face | A 7px marigold dot at the end of the Overview row, with no number, because the lane says how many. One click on the row opens Work filtered to Failed |
| Sidebar, Threads face | The same dot on the Hercule segment, as a small button of its own with a 26px target. One click on it does the same. A click on the word still only changes the face, so nobody leaves a thread just to glance at the other face |
| The toolbar | Failed is a row in Filter, and a chip while it is on |
| The card | Leads its cell, with the plaster, the failed mark and the words. A title keeps one line, so the words always get two |
| The lane | "1 failed", in ink, folded or not |
| An initiative | Its head says "1 failed" too, because a Task under a closed initiative has no card |
| A line | The bead is the failed mark at 13px, first in its cell, even among tally marks |
| The details | The same words at the top. See The details pane |

Marigold is the dot because something needs you. Tomato is the mark because something got hurt, as in the book. It is the Inbox's `cross` shape in its `bad` tone, so a failure looks the same on both pages.

The rules:

- **It stays until it ends.** Looking at it clears nothing. Try again, Start a thread, Done and Drop end it. Moving the card does not, because a drag does not repair a run. Merging carries the failure to the Task it joins.
- **It outranks everything else about a card.** A failed card shows as a card even in Landed, and even while blocked.
- **The filter lifts itself.** When the last failure ends, the Failed filter goes, because an empty page says nothing. Has a question does the same.
- **Waiting on you does not list it.** That section counts open questions, and a stopped run has none.

### The top edge

Only a live Thread stands behind the top edge. It is 14px from the right, drawn behind the sheet. A head is 30px wide, cropped below the mouth, with two 7 by 5 paws on the edge in front of the sheet. Most cards have nothing here. The marigold tab and the person's monogram that used to share this slot are gone: they said whose move it was, and most cards have no move.

### `blockedBy`

A blocked card goes quiet. Its summary names the blocker, beside a small lock. Hover draws a thin line to the blocker, through the gaps between cards, so it never crosses anyone's words. When the blocker lands, the card comes back by itself.

### Wear

Off by default. Display menu, or `W`. Neglected work ages from 6 days to 30: the stock takes up to 18% of an old paper colour, and the title loses up to 20% of its strength. Agents' cards and landed cards never wear. Moving a card clears its age.

### Rows at rest, and stacks

A cell shows four rows of real cards, in a stable order, so things stay where you left them. A fifth is shown rather than hidden. Past that, a plain "13 more" under the last card opens the rest **in place**: the lanes below make room, and the page scrolls. "Show fewer" closes it. The limit only stops one busy column from pushing every other lane off the screen. It is not there to hide work: if a count has to say how much is waiting, it has grown too big anyway.

- Nothing important waits out of sight. A card with a question or a failure always shows, even past the fourth row.
- A filter lifts the limit.
- Landed shows as a line, "3 landed", and opens the same way.

**A stack is only for things that truly belong together:** a ticket and the pull requests its source confirms are its own. Only a direct, confirmed link groups, reported by the source or stated by a person. A reference found in text is a hint in the details and never groups. Sharing a repository or an ancestor never stacks anything. So most cells have no stack at all.

- The lead is a card like any other.
- What it holds peeks from under it as a sheet, and the sheet carries the reason in words: "2 pull requests".
- The card opens the card. The sheet opens the stack, in place, with its members as real cards under a thin rail. They are two different things under the pointer, with a chevron on the one that unfolds.
- A stack with a question or a failure inside opens by itself.
- Drag a member out and it is simply a card again. Nothing remembers a stack: it follows from the links and the cell.

### Plans

Called Initiatives on screen. A Hercule Initiative is the user's own intent, with a colour of its own. Hues are chosen away from marigold and tomato, which mean things, at one lightness and chroma per theme family, so they read alike in every theme.

An initiative is a row: chevron, a flag in its colour, its name, and small facts ("Platform · 2 of 8 landed"). An initiative is your own, so its Tasks are its truth: the count and the beads always agree. Its line runs across the stages, bright as far as its last Task, faint to the end of the board. One bead per Task, at its stage, in its colour.

- Filled is open. A ring is landed. A faint ring is blocked. Marigold has a question. The failed mark has failed.
- Past ten in a cell, beads become tally marks.
- Click a bead to open that Task, or drag it along its line to change its stage. Click the row's head to open the initiative in place into cards, with a 2px bar in its colour down the left.

**Two places, switched in Display.** On top: all initiatives together above the lanes, as in the lo-fi, and the lanes below hold what is in no initiative, under "Not in an initiative". The heading folds the whole block, for a day with many. In lanes: each initiative under its project's cards.

Most Tasks have no initiative, and that is normal. The design never collapses into a giant "no initiative" group, except when you ask for it with Group by Initiative.

### Lanes

Lanes keep their order. A lane with no project is named "No project" and sits last. A lane has an icon that says what it is: a folder, an initiative's flag, or a source's mark.

What keeps a lane and an initiative apart, in every state:

| | Lane | Initiative |
|---|---|---|
| Type | 14/20 bold | 13/18 medium, with facts under it |
| Icon | folder or source mark, in `--muted` | a flag in its colour |
| Place | at the margin | indented 14px in a lane |
| Ground | a hairline, or a band | none |
| Folded | one line of counts | a coloured line |

**A folded lane is its head and one line of small counts,** each under its stage, with a dot where something has a question or a failure. There are no beads and no line, so a page of folded lanes reads as a plain table, not a metro map. The head keeps a small flag for each initiative it holds, in colour, so nothing vanishes without a trace. `F` folds the current lane, and ⇧F folds them all. Beads stayed only on initiatives, where the colour and the flag make them mean something.

### Piles

Gone. The founder's note was right: an unrelated top card hid things, and nobody could tell what a pile was. Overflow now opens in place, and a stack means only what a confirmed link says it means. See Rows at rest, and stacks.

### Add to Work

Starting work from this page, because going to the Inbox for "that one extra ticket" would be a shame. That ticket may be one Hercule has never seen, so the sheet's main action reaches the source itself. `A`, the Add button, or the `+` on a lane's head.

A sheet opens at the right, the size of the details pane, and the board stays in view beside it. The board does not scroll while the sheet is open. The row and the line at the foot say where a new Task went.

**New Task** is first: type, Return. A line says where it will land. From a lane for an outside thing it joins the project most of that lane is in, and the line says it shows under "No Linear team" until a source says otherwise.

**From a source** is a segmented control for each source, then the search.

- **The search is as wide as the sheet, and keys go there first.** It says what it reaches: "Search Linear, or paste a link". Results come live from that system through its plugin, not from what Hercule holds. They are headed "From Linear".
- **Words or an identifier** search the selected source. An identifier means nothing without a source, so `WEB-301` only ever searches the tab you are on.
- **A pasted link works from any source.** The plugins recognise their own links, so the tab changes by itself and the line says "Reading this link from GitHub." Nobody has to choose first.
- **The scope is a quiet word in a sentence under the search:** "Searches Web (team) in Linear", or "Searches all of Linear". It is one small select, it is never wider than the search, and a person can always read exactly what is being searched. It holds contexts of that source only, because a source cannot be searched by a Hercule project.
- **It opens on what you were looking at.** From a Linear project's lane, on that project. From a Hercule lane, on the context most of that lane sits under, such as its Linear team or its repository, or on everything when there is none. With a filter on a context, on that context.

**Before you type**, the list shows suggestions, labelled as exactly that: "Suggestions. Things that concern you, with no Task yet. Search to reach everything else." They sit under a heading per project or repository, with its title and what it says about itself. A thing in two projects is listed once, and says "Also in Pricing rules". Fetched context records are never listed.

**What a result says.** Its identifier, title, where it sits, and the state the source reports. Something Hercule has not seen says "New to Hercule". Something that already has a Task says "On Work", and a click opens it.

**One click adds it,** and so does Return in the search, for the first result. The row turns to a check, shows the stage it went to, and stays exactly where it is, so nothing slides under your pointer. The keys go back to the search, ready for the next one. A line offers Undo. A new Task starts at the stage its source state maps to, as the kind declares: Todo is Planned, In progress is Building.

**Adding something Hercule has not seen** creates its record first, with "following" as its concern, then the Task. The line at the foot says so: "Added to Exploring. Hercule now follows WEB-301." Its Linked row in the details says "Backlog · Following". Choosing a context never creates Tasks for its children. Adding is always one thing at a time.

| State | What shows |
|---|---|
| Searching | "Searching Linear…" over three quiet bars, a moment after typing stops. No spinner |
| No results | "Linear has nothing that matches "toaster"." |
| No results in a scope | "Nothing in Basket rebuild matches "toaster"." and one button: Search all of Linear |
| A link you cannot open | "You cannot open this Linear issue." It exists, your connection has no access, and what to do. A lock, and no title, because none was read. Nothing to add |
| A link to nothing | "Linear found nothing at this link. It may be wrong, or the thing may be gone." |
| A link from elsewhere | "This link is not from a connected source. Hercule can read links from Linear, GitHub, Sentry." |
| Offline | "You are offline, so Linear cannot be searched. Typing only narrows the suggestions." Suggestions still add, and sync when you are back |

Esc clears what is typed, then closes the sheet.

### The details pane

A sheet 468px wide, 14px from the right, from 58px down to 14px from the bottom. 16px corner, `--h-carry`, floating over the board rather than splitting it: a split would squeeze five columns and move every card.

From the top: crumbs (project, initiative), title at 20/26, the stage path (click a stage to move there), where it stands at 14/21, then only if there is one, the open question or the failure, then What is left, Blocked by and Blocks, Threads, Part of, Linked, Mentioned. The foot holds Done, Start a thread and Merge on the left, and Drop alone at the right, far from Done.

**A question** shows the Thread that asks, the question at 17/24 bold, answers as compact chips with the suggested one filled in `--answer`, and a line to say something else. Answering sends it: a line offers Undo, and the sheet closes. A colleague on the Task rides the sheet's top edge, and slides clear of the toolbar as it opens.

**A failure** shows the colleague with the plaster, the card's words with the failed mark in the same voice, then Try again, filled, and Open the run. Return tries again. Done and Drop stay in the foot, where they are on every Task, so the order down the sheet is Try again, Open the run, Done, Drop.

**Part of** lists every ancestor by every path, each once, nearest first, each with its source's mark, its title and what it says about itself: "Linear initiative · Active". No parent is drawn as the only one. A team is one more path, not a rung. Click a row to see all its Tasks: that is Filter, on that context.

**Linked** lists what the Task carries, then its direct links across sources. Who claims a link stays quiet: on hover or focus the state gives way to "Linear reports this" or "Noa linked this". A link to something you cannot open shows the source's kind and "you cannot open", with a lock and no title, because its title was never read.

**Mentioned** holds references found in text, in muted rows, saying so on hover. They are hints. They group nothing and they prove nothing.

Start a thread asks what the thread should do, on one line, before anything starts. Inside the pane, Esc goes back to the Task you came from, then closes.

### Selecting and bulk moves

`X` or ⌘-click marks a card. A quiet bar offers Done, Drop and Clear. Dragging any selected card carries them all, and they land in order at the slot. One Undo puts them all back.

### Keys

| Key | Does |
|---|---|
| Arrows, HJKL | walk the board: up and down stay in the column, left and right go to the nearest height in the next column. On a line they walk its beads |
| [ ] | previous and next lane |
| Return, Space | open |
| ⇧← ⇧→ | move a card a stage |
| 1 to 5 | move a card to a stage |
| D, ⌫ | Done, Drop |
| M | merge: pick with arrows, Return to confirm |
| T | start a thread |
| A | Add to Work |
| X | select |
| F, ⇧F | fold this lane or initiative, fold every lane |
| / | find |
| W | Wear |
| ⌘Z | undo: one gesture at a time, and only yours, never a fact that arrived |
| ? | keys |
| Esc | steps back, one thing at a time |

Single keys work only with focus on the board, never with a modifier, and can be turned off in Display.

### Accessibility

Measured in all six themes.

- Text passes 4.5:1, including blocked cards. Initiative lines and beads reach 3:1 against the desk. Colour is never the only signal: a flag, a name and a place carry the same thing, and a failure has a shape and the word.
- A card's name reads in the order a person needs: title, what it asks or what broke, stage, summary, age.
- Lane and initiative heads are buttons in the tab order. One tab stop leads onto the cards, and from there the arrows walk them. A line is one tab stop too.
- Group by and Filter are menus with radio and checkbox roles. Chips are buttons that say what they remove.
- A stack's sheet and "13 more" are buttons that say whether they are open.
- The sidebar's dot names itself to a screen reader.
- The details are a dialog named by the Task, not modal, because you can keep working beside it.
- Reduced motion swaps movement for fades. A Still colleagues switch in Display stops paws and blinks for anyone, without touching the system setting.
- Cards use a minimum height, so text-spacing overrides grow them instead of clipping.

## Every state

| State | Treatment |
|---|---|
| Nothing asks | The normal case: a complete board with no marks, and the sidebar's Waiting on you gone. `?scene=quiet` |
| First run | A short line says nothing is here yet. A dashed card in Exploring, with Hercule looking over its edge, says where the first Task will land. One filled button: Start a thread |
| Desk clear | A sunrise over one hairline, with Hercule coming up over it, and "All clear." under it. The stage names stay out of the way |
| One card | One card, in its place. No special layout |
| 300 cards | Ten lanes, every one showing real cards, and the page scrolls. ⇧F folds them to ten plain rows |
| Loading | The headers and lanes are there at once. Cards show two quiet bars, and words fade in from the top left. No spinners, no shift |
| Partial data | A card with no summary yet says so. An outside thing with only an id and a title shows only those |
| Offline | A quiet line in the toolbar says since when. Moves still work, marked with a clock until they sync. Answers say they will send when you are back |
| A move fails | The card goes back, and the line at the foot says why and what to do |
| A run failed | A marigold dot in the sidebar, "1 failed" on the lane, the card at the top of its cell, and Try again in the details. See A failed run |
| A filter finds nothing | "No Tasks match this filter." The chips stay, so the way out is in view |
| Stale | Ages keep counting. Nothing else changes |
| Long titles | Two lines, then an ellipsis. The full title is in the details |
| No project | A lane called No project, last |
| Zero initiatives | Nothing drawn. No "no initiatives" message |

## What would change in the design system

**New tokens**, in `system/primitives.css`: `--desk`, `--paper`, `--answer`, `--answer-fg`, `--word-press`, `--stock`, `--stock-carry`, `--stock-sheen`, `--stock-flat`, `--stock-rim`, `--stock-rim-flat`, `--stock-lit`, `--h-rest`, `--h-hover`, `--h-carry`, `--plan-l`, `--plan-c`, `--plan-soft-a`, the `--type-*` roles and the `--m-*` motion tokens. In `css/overview.css`: `--failed-dot`.

**New components:** card, stack, cell overflow, lane (side label and band), initiative row with its line and beads, toolbar with chips, Group by and Filter menus, Add to Work, the failed mark, the sidebar's failed dot.

**Doctrine changes:**

1. *"Brass is ornament only, never text."* Brass is simply gone from Work. The display face is for the logo and nowhere else.
2. *"Depth is a hairline and a crisp shallow shadow."* Holds. A card lifts only in your hand.
3. *"Motion: interface moves fast and plainly; only characters get a little spring."* Amended: the interface has three named springs, chosen by who caused the change.
4. *"Color appears only at word and dot scale."* Holds. Marigold on this page is a palm, a question's words, and a dot. Initiative colours are lines, flags and dots. The failed mark is the one tomato. Ages and counts are neutral.
5. *The split* still holds for Intake and the thread. The details pane and Add to Work are overlays, because a board must not reflow.
