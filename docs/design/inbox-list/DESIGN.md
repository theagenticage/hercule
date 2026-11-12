# The Inbox list: design

The hi-fi drawing of the new Inbox for #1120, from the map #1119. It replaces the Inbox drawn on `prototype/inbox-hifi`. Once Rogier signs it off it is the pixel reference spec 17 §Inbox points to.

- `desktop.html` is the working window, in the app's real sidebar, tokens and six themes. Every state opens by URL: `desktop.html?scene=pr&theme=nile`. The scenes are listed in `js/scenes.js`.
- `index.html` walks through the reasoning, with live frames and every capture.
- `MOTION.md` is the motion.
- `tools/check.mjs` drives the flows and fails on any page error. `tools/capture.mjs` captures every state in every theme into `screens/`.

Every person, company and repository is invented, in the Northwind Market world. The repository is public.

## What the best inboxes taught us

Before drawing, five inboxes people love were studied for what makes them work: Superhuman, Linear's inbox, HEY, Shortwave and Things. These are the principles taken, each with where it shows here.

1. **Speed is the feature** (Superhuman). Every common move is one key, and a move answers at once. After a move, the row that takes the place of the one you handled becomes current, so the same key handles the next. Every move has an undo, so nothing asks "are you sure?".
2. **Rows built to scan** (Linear, Superhuman). Each slot of a row is in a fixed place: what it is and why it is here on the left, how long it has waited and where it lives on the right. The eye runs down columns instead of reading sentences.
3. **Colour is information** (Linear). Colour sits on source marks, status glyphs, project health and the triage accent, and nowhere else. Surfaces stay neutral.
4. **Fixed lists, declared, not built** (Things' Today and Upcoming, Superhuman's split inbox). The rail lists saved queries the core and plugins declare. Nobody builds folders or rules.
5. **The list holds still** (Things keeps a finished to-do in place until you leave; HEY marks what is new). New arrivals wait behind a bar until you ask for them.
6. **Group by what is really related** (Linear groups notifications per issue). A group is things linked by a source or a person, never a guess.
7. **The machine proposes, the person decides** (HEY's explicit decisions, against Shortwave's automatic bundles). Hercule's Proposals and link suggestions are visible at the top, one key from yes or no, and nothing is grouped until a person or a source says so.
8. **Keys are learnt where they are used** (Superhuman's hints, Linear's tooltips). Every button shows its key. `?` lists them all.
9. **Density for scanning, air for reading** (Superhuman's reading pane). The list is tight, 52px rows. The pane has 24px sides and 20px leading.
10. **Finishing is quiet** (Things' small check). The empty Inbox is the app's small sunrise, drawn once.

And the ones rejected:

- **Bold for unread** (every mail app). The question here is "who waits on me?", not "have I seen it?". Weight is kept for titles and for waits that are overdue.
- **A snippet of the body in each row** (Gmail, Superhuman). With mixed sources a snippet is noise. A row says the ask instead: "Mei asked for your review".
- **An avatar on every row** (Linear). The source's mark and the person's name already say it. Faces are for colleagues: agents and Hercule.
- **Separate destinations by kind** (HEY's Imbox, Feed and Paper Trail). Saved queries sit in one rail, and one thing can be in several.
- **A screener for new senders** (HEY). The sources are the user's own accounts. The prototype had one, and the map dropped it.
- **Automatic bundles** (Shortwave). Hercule only suggests a link.
- **Celebration pictures at zero** (Superhuman). The app's own sunrise, small and once.
- **Swipes, snooze and reminders.** Not in the map.

## The page

```
 sidebar 272 │ rail 240        │ list                                   │ pane 420 (360 to 640)
             │ [Inbox|Intake]  │ [ ⌕ Search, or type a field…        / ]│                       [?]
             ├─────────────────┼────────────────────────────────────────┼───────────────────────────
             │ ◷ Someone waits…│ Someone waits on me 19   Longest… Narrow│ ▣ GitHub · Pull request · …
             │ ♙ Mine          │ ┌────────────────────────────────────┐ │ Title, in full    #6244
             │ ◉ Updates       │ │▣ Title of the thing              5d│ │ ✕ Checks failing · Mei …
             │ ☺ With Hercule  │ │○ Ruth asks you           Finance   │ │ ┌ Omar mentioned you  2h ┐
             │ ▭ Everything    │ └────────────────────────────────────┘ │ │ the message, the answers│
             │ ▣ Review reque… │  …                                     │ └─────────────────────────┘
             │ ✦ Triage      2 │                                        │ ┌ Mei asked for your rev ›┐
             │ PINNED          │                                        │ blocks: change, checks, …
             │ BROWSE          │                                        │ Linked · What happened
             │ ▣ Linear 14   ⌄ │                                        ├───────────────────────────
             │   Projects …    │                                        │ Start a thread N  Take on T …
```

- **The bar** is a subgrid of the three columns: the pill sits over the rail, the search over the list, and the keys button over the pane. The pill reads `Inbox | Intake`, as Work's reads `Overview | Office | Work`, because Intake stays a tab until #1048.
- **The rail** is 240px on the page's ground, with a divider. The list is on the same ground. **The pane** is on `--surface`, a step lighter in the light themes and a step lifted in the dark ones, because it is for reading.
- **The pane resizes** from 360 to 640px by its edge (drag, or focus it and use the arrows; a double click springs it back to 420). The rail does not resize.
- **Under 1330px** the rail folds into a menu in the bar ("Someone waits on me ▾") that holds the same rail. The pane never takes so much that the list gets less than 400px: its widest is the main area less the rail and 400.

## The rail

| Group | What | Rule |
|---|---|---|
| Saved queries | The core's five, then the plugins' two, with no heading | Each has an icon (core) or its plugin's mark, its name and a count. 1 to 7 pick them, and the key shows over the count under the pointer and on focus |
| Triage | Proposals and Hercule's link suggestions | Its own entry under the saved queries. Its count is words in the triage accent, not a disc: a disc is the sidebar's "Waiting on you". 8 picks it |
| Pinned | Browse values the user starred (`inbox.pins`) | The mark of the value's source, its name, and its account when the source has several |
| Browse | Each source's structure, from the facets its plugin declares | Sources fold (`inbox.browseFolded`). A source with several accounts lists each account, and its facets under it |

- Rows are 30px (values 28px), the icon column 16px, the name 34px from the row's edge, counts at the end in tabular figures. Groups are told apart by 12px of space, and Pinned and Browse by the sidebar's own eyebrows.
- A value with nothing of yours yet (every Linear project is listed) is faint and has no count.
- Project health sits in the icon column: a check, a mark or a cross in a ring, in green, an orange of its own (hue 48) and tomato, so it reads in grey too. Its word is in the tooltip.
- The star to pin a value is a button of its own beside the value, shown on hover and on focus over the count. P pins the focused value.
- A source's fold chevron takes its mark's place under the pointer and on focus, so every count stays in one column. An account sits under its source like a value, in muted 13px; facet labels are small labels at the icon column, over their values.
- **The rail is one Tab stop.** The current entry takes it; ↑ ↓ Home End move inside, → ← fold a source, ↩ picks. Picking puts the focus in the list. F6 moves between the search, the rail, the list and the pane.
- A click on a value adds the same clause the search bar would. The list head then shows the value with its source's mark, and its account when there is one.

## The list

A row is two lines in 52px: 18 and 16 with 2 between and 8 above and below. Text size steps grow each line.

```
 ┌──────────────────────────────────────────────────────────────────┐
 │ [mark]  Title of the thing, medium, one line, cut at the end   5d│   wait: ink and weight only
 │ [glyph] Mei asked for your review  +1          storefront-web #6244│   where: place and identifier
 └──────────────────────────────────────────────────────────────────┘
   16px column: the two coloured shapes, one over the other
```

| Slot | From | Rule |
|---|---|---|
| Mark | The plugin's mark and hue | In the source's hue at the theme's mark strength, or in ink when the plugin declares none |
| Title | The thing | The one medium weight in the row. One line, cut at the end; the pane shows all of it |
| Time | What the list is ordered by | In a "Longest waiting first" list, the wait of the oldest open ask, against the patience of its kind: `fresh` and `recent` faint, `due` muted medium, `over` ink semibold; a thing that asks nothing has no time there. In a "Newest first" list, when it last changed, faint, and only an overdue wait shows instead. A group shows the time of the member that placed it, so the column always reads in order |
| Glyph | The kind's status: a shape and a tone | The shape is one of the core's set. The tone is the source's hue, quiet, good or bad. A kind with no status leaves the slot empty |
| Reason | The newest open ask, or what changed | The person's name in ink, the rest muted: "**Mei** asked for your review". `+1` says how many more asks there are. A thing that asks nothing says its status, its fact and its context, faint |
| Where | The kind's `place` field and its identifier | Faint, at most 46% of the line, cut first. Beside a long identifier the place is left to the pane rather than cut to a stub. Identifiers are set in proportional figures, so `PO-2291` keeps its tight hyphen |
| Who has it | A Task's holder | A colleague's face, or your monogram, takes the wait's place |

- **Current row**: a puck under the list with the `--selected` fill and a short 2px edge on its left, so it is told by shape too. Rows move into it; it does not move with them. With the keyboard, a 2px focus ring inside the row.
- **Hover**: the `--hover` fill, and the row's moves at its right end, over the wait and the place on their own ground: Start a thread, Take on, the hand-off's face, Dismiss. Each tooltip names its key. Over the mark, the mark makes way for a tick.
- **Selected (X)**: the tick stays, filled in ink. X on a group picks the members the list's query holds, ⇧X the whole group, and the group then shows the tick in its chevron's place. ⌘A picks what the list shows. The fill stays for the current row alone.
- **Quiet**: a row that asks nothing has its reason faint.

The list head says what the list is, its count, the saved query's order in words, and **Narrow**. The order belongs to the saved query ("Longest waiting first", "Newest first"), so there is no sort control.

## Groups

Every set of things linked to each other, by a source or a person, is one group (decisions 9 to 11).

- **Closed**: one row. A chevron in the mark column, the group's label as the title, the longest wait among what asks. The second line has a link glyph, the most pressing ask with `+n` for the others, and on the right the marks of its sources and its count of things.
- **Open**: its members hang under it on a hairline from the chevron, indented to the title, each a full row. Members that do not answer the current query are drawn quieter, so the group stays whole and the query still reads.
- **Large**: a group of more than seven shows five and a row "Show 9 more in this group". The pane lists every member.
- **Its label** is its most lasting thing's title, the oldest on a tie (`lasting` in the kind's declaration). Nobody renames it.
- **Where it stands**: where its most pressing member would stand in the saved query's order. A group is shown when any member answers the query.
- **Counts count things**, never groups.

## Triage

Proposals and Hercule's link suggestions have their own rail entry, and the first three stand at the top of "Someone waits on me", over a hairline. More than three leave a row "8 more in Triage ›" that opens the entry.

- **A Proposal row**: the face of the agent that made it in the mark column, its title, and "**Proposal** Triage made it from 3 things" with the things' marks on the right. Its pane says why, lists the things, and names the Task it makes. T accepts, N accepts and starts a thread, E dismisses.
- **A link suggestion row**: Hercule's face, the pair as its title ("#6251 and SHOP-150", so no thing's title shows twice on the screen), and "**Link?**" with Hercule's reason, and the pair's marks on the right. Its pane asks "Do these belong together?", says why, and shows the pair. L links them, as the user's own links. E says "Not related", and Hercule never suggests the pair again.
- The words "Proposal" and "Link?" are in the triage accent, marigold, the app's colour for what is addressed to you. Nothing else in the list is marigold.

## The pane

Top to bottom, each part only when it has something:

1. **Where it is from**: the mark, "GitHub · Pull request · storefront-web", and the account when the source has several. On the right, an icon button to open it at its source and the pane's menu.
2. **The title**, in full, 18/24 semibold, with its identifier faint after it. It wraps with `text-wrap: pretty`, so the identifier never sits alone.
3. **The meta line**: the status glyph and word, who and when, and the declared facts.
4. **Who has it**, when a Task holds it: the face or monogram, the Task, and "Go to the Task G".
5. **One section per open signal**, the others folded to one line (decision 16). The one unfolded first is the ask the saved query is about (in Review requests, the review request), else the newest. The current ask, the one ↩ answers, has an ink edge; only its suggested answer is filled and carries ↩. `[` and `]` change the current ask while the focus stays in the list. Each section has a marigold dot, who asks what, and when; its own blocks (the message that mentions you, with the app's marigold rule); its answers, with the plugin's suggested answer filled and `↩` on it; Done, quiet, at the end; and under them the describe line of the answer under the pointer or the focus. An answer with a field opens its reply box inside the section.
6. **The plugin's blocks**: text, messages, change, checks, fields, trend and code, at most eight. A type the app does not know draws "This part can't be shown here."
7. **Linked**: what it is linked to, each with who claims it ("Linear reports this", "You linked this") and, for a person's link, Unlink on hover.
8. **What happened**: the timeline, newest first.
9. **The footer**: the core's moves, each with its key. Thread (N), Take on (T), the hand-off (H: the workflow's face, and from 460px its name), then Link (L) and Dismiss (E) as icon buttons at the end. Under 400px each move is an icon, with its name and key in the tooltip. The selection's pane uses the same words. No move is filled: the one filled button on the pane is the suggested answer of the open ask. The ⋯ menu opens the thing at its source (O) and sets the pane's width (Narrow, Default, Wide), for anyone who cannot drag the edge.

The pane of a group lists its members (each walks to the member), then how they are linked, each pair with its claim. Its footer has Start a thread on all, Take on, Link and Dismiss. It has no hand-off (decision 14), and H says why in the undo line.

## Moves and keys

| Key | Move | On a group | On a selection |
|---|---|---|---|
| J K, ↓ ↑ | Next and previous row | | ⇧J ⇧K select a range from the anchor, and shrink it back |
| X | Select, or unselect | Every member | ⇧-click a range, ⌘-click one, ⌘A all |
| ↩ | The open section's suggested answer; with none, the focus goes to its first answer | Unfolds it | |
| [ ] | The previous and next ask in the pane | | |
| Space, ⇧Space | Scroll the pane | | |
| O | Open it at its source | | |
| → ← | | Unfold and fold; ← on a member goes to its group | |
| L | Link to…: a search for the thing to link it to | Link another thing to the group | Links them all |
| N | Start a thread | On all of it, named after the group | On all of them |
| T | Take on: one Task | One Task, named after the group | One Task |
| H | Hand off: at once with one workflow, the menu with several | Refuses, with the reason | Refuses, with the reason |
| E | Dismiss | The whole group, one undo | All of them, one undo |
| G | Go to its Task | | |
| / | Search; F narrows | | |
| 1 to 7, 8 | Saved queries, Triage | | |
| . | Show what is new | | |
| ⌘Z | Undo | | |
| ? | The keys | | |
| Esc | Step back: the keys sheet, the selection, the search | | |

- **Drag a row onto another** to link them. The row under the carried one lights in the focus colour. Letting go elsewhere, or Esc, sends it home.
- **Single keys belong to the list and the pane.** In the rail, the bar, the keys sheet or a menu they do nothing (WCAG 2.1.4), so speech input and a stray key never act on a row nobody is looking at. `/` and `?` reach from anywhere outside a field; Esc goes back to the list. The app's Settings would offer to turn single-key moves off.
- **↩ on a focused button is that button's.** Only in the list does ↩ mean the suggested answer.
- **On triage rows** the keys keep their meaning: T accepts, N accepts and starts a thread, E dismisses or says "Not related", L links a suggestion. Any other key says which keys the row takes. A selection always wins over the current row.
- **An open menu owns the keyboard**: ↑ ↓ move, ↩ picks, Esc closes and gives the focus back, Tab leaves. The dialog is modal: the page behind it is inert.
- **Moves refuse with a reason** in the undo line: hand-off on a group, G with no Task, L with nothing to link.
- **The hand-off menu** is spec 17's HandToMenu, unchanged: faces, names, the line that says what a pick ends and leaves, 1 to 3, the account, and the workflows that cannot take it, dimmed, with their reasons.

## Starting a thread

N opens the app's glass dialog around the real composer of the new-thread screen (decision 18).

- **The header** is the Task's name, editable, defaulting to the group's label or the thing's title, and "A new Task on Work, with a thread on it".
- **The starters** sit above the composer as chips: Investigate, Fix, Draft a reply, Summarise, Your own words. A starter writes the message. Typing makes it "Your own words". The first is Draft a reply when everything is a conversation, otherwise Investigate.
- **The things** are chips inside the composer, each removable, because they travel as prompt attachments (decision 20).
- **The defaults** come only from evidence (decision 19). The lip shows the project and the workspace, and a line under it says why: "**webshop** because #6244 is in storefront-web, one of webshop's repositories." Each pick opens a popover with its reason. Profile and access follow the project.
- **No evidence**: the lip says "Choose a project" in the marigold of what asks you, the profile and access wait greyed, and Send waits; ⌘↩ opens the project menu. The menu also offers "No project: no code, no checkout", a choice of its own: the lip then says "No project · No checkout" and the agent works with the user's own profile and asks before it edits.
- **Popovers** (the reasons, the project menu) open on the page, never inside the dialog, so nothing clips them; they take the arrows, ↩ and Esc.
- **Nothing typed is lost**: closing keeps the words for those things, and N opens them again. The dialog is modal, and Tab stays inside it.
- **⌘↩ starts it.** The dialog becomes the thread's first moments: your message, the things as live cards (an error's count ticks while you watch), "Context sent with it" folded with its line count, and the agent reading each thing with `hercule entity read`, then its first sentence. "Open the thread ↩" and "Back to the Inbox Esc". The things leave the list behind it.

## Search and Narrow

- **The search** takes tokens over declared fields: `team:Checkout events:>1000 waiting:>2d`. Typing a field's name offers the fields; after the colon it offers the values with their counts, or for a number or a duration some thresholds, and any threshold typed works. A finished `field:value` becomes a token on space or ↩; a half-typed field name is never used as free text. Free text matches titles and fields.
- **Leaving it**: ↩ on free text, or ↓ past the last suggestion, goes to the results with the first one current. The first Esc leaves the search and keeps it; Esc in the list then clears it. ⌫ on an empty field removes the last token.
- **Its scope is a token too**: "in Someone waits on me" leads the field while searching. ⌫ or its × widens the search to Everything, keeping the query, and an empty result offers "Search Everything · 2". A group whose hit is one of its members opens.
- The search and Link to… are comboboxes: `aria-expanded`, `aria-activedescendant`, options with `aria-selected`. Result counts are spoken through the page's live region.
- **A token is cross-source** when a field is: `team:Checkout` finds Linear's and Sentry's teams of that name. A Browse value or a Narrow pick adds a token tied to its source, shown with the source's mark.
- **Narrow** lists the facets of what the list holds, by source, and then a facet's values with counts. A pick adds the same token.

## States

| State | Design |
|---|---|
| Loading | The rows' shapes, still: no shimmer, so a slow read costs no frames. Rail counts and the pane are shapes too |
| Empty saved query | A small sunrise, "Nobody waits on you", and a line saying where the rest is |
| All clear | The full sunrise: Hercule's head comes up over the brass horizon. Drawn once |
| Nothing matches | What was searched, and "Clear the search Esc" |
| Offline | One quiet pill in the bar: "Offline · 09:12 · 2 waiting", with the whole sentence in its tooltip. Moves still work and wait in the outbox, so nothing dims, and each undo line says it waits |
| A selection | The pane shows the selection (two or more, or one that is not the current row): what is in it, and Link, Thread, Take on, Dismiss. A small bar at the foot of the list counts it and clears it |
| Under 900px, or 200% zoom | The pane lies over the whole width of the list: ↩ or a click slides it in, Esc or "List" slides it out, and the focus goes back to the row |
| A source that can't be read | A line over the list naming it and what it means, with a way to Connections, and a mark on its row in Browse |
| N new | A solid pill in the list head, beside the count: a marigold dot, "3 new", "Show ." It covers no row, and holds back what arrived until you ask |
| Light day | Five things; the list is short, nothing else changes |
| 2,400 things | The same page; counts in grouped tabular figures; Browse lists five values and "34 more"; triage keeps three at the top |
| Under 1330px | The rail is a menu in the bar ("Someone waits on me ▾") that opens with the focus on the current entry; the list keeps at least 400px; under a 400px pane each move is an icon |
| Nothing current | Empty lists, all clear, nothing matching: the pane steps aside and the list takes the room |

## Colour

Colour is restrained and always means something (#1120 "Colour"). Rogier decides by eye.

| Colour | Where | Why |
|---|---|---|
| A source's hue | Its mark and its status glyphs | Which source, at a glance. The hue is drawn at the theme's `--mark-l` and `--mark-c`, as plugin marks already are, so no plugin is louder than a name. Glyphs are 14% quieter than marks |
| Green, tomato | Project health in Browse; good and bad statuses | The app's meanings |
| Marigold | The triage accent (its words and count, never a disc); the dot of an ask in the pane; "Choose a project" | The app's colour for what is addressed to you |
| An orange of its own | At-risk health | Hue 48, between tomato and marigold, so it reads as neither |
| `--answer` | The one suggested answer | Each theme's accent, green except in Nile, where `--answer` is set apart |

Declared hues in this drawing: Linear 268, Sentry 312, Slack 335, Quayside 196. GitHub and Gmail declare none: they draw in grey at the same mark lightness as the hued marks, so no source is louder than another. Gmail's red would read as a failure.

## Type, space and lines

- **Type**: titles of rows 13/18 medium; reasons and places 12/16; counts and times 12 in tabular figures; the pane's title 18/24 semibold; section heads 12 medium muted; eyebrows the sidebar's 11 uppercase. Three weights only.
- **Space**: the 4px grid. Rows 52px; rail rows 30px; the list's rows inset 12px from its edges with 12px inside; the pane's sides 24px; sections 24 to 28px apart.
- **Radii**: rows 10px; signal sections and blocks the app's `--r-md` and `--r-sm`; menus and the dialog the app's `.pop`.
- **Lines**: the column dividers and section rules are `--divider`; the hairline of an open group is `--line`. Every line is 1px on the pixel grid.

## What a plugin declares

Plain data, never UI (decision 22). Everything on the page comes from `js/kinds.js`; `tools/check.mjs` fails if a view names a source.

| Declaration | Example |
|---|---|
| Source | name, mark, hue, "Open on GitHub" |
| Kind (Card Face) | noun, `identifier` template, `place` field, `context` field, `fact` field, `lasting` rank for a group's label |
| Statuses | per status a word, a shape from the core's set, and a tone |
| Fields | label, plural, token, type (`text`, `person`, `number`, `duration`, `money`); `facet` marks Browse and Narrow ones |
| Browse | per source, its facets in order; `known` for values with nothing of yours; `health` for a value's health |
| Saved queries | a name and a query over declared fields, and its order |
| Signal kinds | the sentence a row says, the answers with their describe lines, and which is suggested |
| Blocks | read when the pane opens: text, messages, change, checks, fields, trend, code |

Shapes: `ring` `dashed` `quarter` `half` `most` `check` `cross` `fork` `draft` `join` `alert` `return` `hold` `dot`. Tones: `source` `quiet` `good` `bad`.

## Calls made, for Rogier

Each is a choice the map left open, made for the best design. Each can be turned around.

1. **Signals before blocks.** The pane draws each open signal's section right under the title, then the plugin's blocks. The map lists blocks first (15, then 16). What asks you comes first, so you can answer without scrolling past a diff.
2. **Rail order**: the core's saved queries, the plugin's, then Triage on its own, then Pinned and Browse. Triage is not a saved query, so it does not sit among them.
3. **No sort control.** The list head says the saved query's order in words.
4. **Triage keeps three rows** at the top of "Someone waits on me", then "N more in Triage". With eleven, triage pushed every thing below the fold.
5. **Large groups** show five members and "Show N more" past seven.
6. **Members that do not answer the query** stay in the open group, drawn quieter.
7. **L on one thing** opens "Link to…", a search over the Inbox. The map says L links the selection; with nothing selected it now still helps.
8. **↩ is the open section's suggested answer**, as on Intake. On a group it unfolds.
9. **Keys**: 1 to 7 for the saved queries, 8 for Triage, `.` for what is new, ⇧J and ⇧K to select while moving.
10. **On triage rows** T accepts a Proposal and N accepts and starts a thread; L links a suggestion and E says "Not related". Same keys, same meanings.
11. **Hand-off on a group or a selection** refuses in the undo line with the reason and what to do instead. No disabled button stands in the footer.
12. **Selecting**: under the pointer the mark makes way for a tick, and a selected row keeps its tick.
13. **Colours**: GitHub and Gmail without a hue; glyphs 14% quieter than marks; health in the app's green, attention and tomato; the triage accent in marigold.
14. **Under 1330px** the rail becomes a menu in the bar, so the list keeps at least 400px.
15. **The pane's link to the source** is an icon button with its words in the tooltip. "Open on GitHub" in words did not fit beside the provenance at 420px.
16. **The pane on `--surface`**, a step off the list's ground.
17. **Faces on triage rows**: the agent that made a Proposal, and Hercule for a link.
18. **The pill reads `Inbox | Intake`**, as Work's pill is three tabs with no title.
19. **The reason for the defaults** is one line under the composer, always shown, and each pick has a popover with its own reason.
20. **No project** stays a choice: the project menu offers "No project: no code, no checkout".
21. **Arrivals** get a marigold wash that fades over 1.6s, because they are new things that ask you.
22. **Answers that act on the source are held for the undo line's eight seconds** before they are sent, as mail apps hold a sent mail. So ⌘Z takes back every move the same way, and ↩ on Approve is never final at once. The line says "Sends in 8s".
23. **Data first, motion after**: a hand-off changes the counts at once and its row leaves when the colleague's mark lands on Work (about 600ms).
24. **The time column follows the list's order**: waits in "Longest waiting first", last change in "Newest first", an overdue wait always.
25. **Single keys only in the list and the pane** (WCAG 2.1.4), with `/` and `?` from anywhere.
26. **More keys**: `[` `]` between asks, Space to scroll the pane, O to open at the source, F to narrow, P to pin, ⌘A, ⇧-click, F6 between regions.
27. **The pane's width without a drag**: Narrow, Default and Wide in its ⋯ menu.
28. **A selection gets the pane**: two or more selected, the pane shows them and what a selection can do.
29. **Unsent words are kept**: closing the dialog keeps what was typed for those things, and N opens it again. A starter replaces your words through the field, so ⌘Z in the field brings them back. The last chip cannot be removed.
30. **Under 900px** (and at 200% zoom) the pane lies over the list.
31. **The focus follows the current row**: after any move from the list or the pane, the new current row takes the focus, and it is always scrolled into view. A move that keeps its place makes the next row in the old order current, even when the handled thing stays elsewhere in the list.
32. **A group that just came under the keys** takes its own, fresh E: an E within 0.6s of the move says the group is there and does nothing.
33. **Answers already sent** say so on ⌘Z: "Already sent to GitHub, so it can't be taken back here."
34. **Arrivals** wait in a pill in the list head, beside the count, where they cover nothing.
35. **The selection bar only counts and clears.** The moves of a selection are in the pane's footer, in the same words; two toolbars with the same moves were one too many, and the bar spilled out of a 400px list.
36. **H moves the current row on at once**, as T does; the hand-off chain plays on the row it left, so a quick E acts on the next thing, never on the one just handed.
37. **Answering keeps the place**: after an answer, the row after it in the old order is current, even when the thing moves elsewhere because another ask stays open.
38. **Offline, answers wait** in the outbox and are not "sent" after eight seconds; ⌘Z can always take them back while they wait.
39. **A search value can hold spaces**: a space ends a value unless a value the field holds goes on past it, so `project:Checkout revamp` and `from:Priya Raman` type out whole, and `team:Checkout bug` still makes a token and free text.
40. **⌫ never removes the scope.** In an empty field ⌫ removes the last token and stops there; the scope token's × searches Everything. A stray ⌫ would otherwise move you to another list.
41. **⌘Z puts back the current row too**: the thing that comes back is current and has the focus again, so a second E acts on it, not on its neighbour.
42. **The undo line waits for you**: it stays while the pointer or the focus is on it, and goes 3s after both leave. It rises over the selection bar, and under 900px over the pane's moves.
43. **Under 900px with the pane open**, J, K and the moves keep the focus in the pane, and F6 treats the list and the pane as one place, whichever shows.
44. **After a move, the next current row stays where your eyes are**: a row that travels away with a re-sorted group is passed over for the next one that stays.
45. **Tokens that do not fit fold into +N whole**, every one if need be; only the scope token shortens with an ellipsis.

## Proposed changes to #1119

The drawing keeps every decision. Four would read better changed:

1. **Decision 15 to 17, the pane's order**: "Where it is from, the title, one section per open signal, then the plugin's blocks, then the core's sections." It is drawn this way (call 1).
2. **Decision 7, "things you handle leave at once"**: "leave as soon as the move's motion ends", so a hand-off can show the colleague taking it before the row goes.
3. **Fog, group size**: settle it as "an open group shows up to seven members; past that five and Show N more; the pane lists all".
4. **Decision 16, answers**: "an answer that acts on the source is held for the undo window before it is sent". This touches `signal.act` (spec 10 §9.4, spec 20): the controller, or the client, waits eight seconds, and ⌘Z cancels. It is what makes ↩ safe as the suggested answer's key.

One for the app, outside #1119: the hand-off menu's account picker (`screens/inbox/hand-account.css`) draws the browser's own select border, which no other control in the app has. The drawing draws it without.

## The critic rounds

Each round reviewed a frozen copy under `/tmp` with four critics working apart: a visual designer, a motion designer who filmed every flow at real speed, an interaction designer who drove it with the keyboard and counted keystrokes, and an accessibility reviewer who measured contrast in all six themes and read the accessibility tree.

**Round one** found 95 issues. What changed because of it:

- **Keyboard**: ↩ on a focused button ran the current row's suggested answer, and on Approve that could not be undone. Single keys acted from the rail. Search had no way out that kept the query, and typed tokens such as `events:>500` did nothing. Narrow and the scope menu did not own the keys. All fixed, and checked in `tools/check.mjs`.
- **Motion**: leaving rows showed words over words; linking flew copies zero distance; a dropped card jumped back to its old place; the "N new" bar pushed the list 36px; the pane blanked on every J; the hand-off sentence rolled through the title; the hand-off changed its data 900ms late; the take-on mark flew from the window's corner. All reworked as MOTION.md says.
- **Visual**: the pane's footer ran off the window; the dialog's popovers were clipped, so "Choose a project" was a dead end; the time column contradicted the list's order; a picked group showed nothing; the triage disc was the loudest thing on screen; GitHub and Gmail marks outweighed the others; at risk read as marigold; the three column heads sat at three heights; identifiers looked spaced out. All fixed.
- **Accessibility**: the list is now a tree with real selection, levels and full row names; folded asks are inert; the dialog is modal; the search and Link to… are comboboxes; the rail is one Tab stop; pins are reachable by keyboard; a live region speaks undo lines, arrivals and result counts; the pane can be resized without a drag; 200% zoom stacks the pane. Every text role already passed AA in all six themes.

**Round two** checked every round-one finding (most fixed, some only partly) and found new ones, mostly where one move changes several things at once and where the width changes:

- **Musts fixed**: unfolding a group showed words over words (now a drawer); a reorder after a hand-off could carry the current row off screen; under 900px and at 200% zoom the pane opened 1px wide; a dropped card read as a rejection (the target lifted over it, the green ring rode home, it landed 4px off); the list had no minimum width; the hand-off face was cut in half; the search's ↩ ignored the highlighted value; the pane could act on a selected thing it was not showing; ⌘Z could "un-send" an answer already sent; focus stayed on a stale row, so keys acted on another; closed groups reported "expanded"; menus acted on their first item wherever the focus was; single keys still acted from the sidebar.
- **Should-fixes taken**: ↩ answers the ask the list is about; only the current ask is filled; `[` `]` keep the focus; ⌘A and X pick what the list shows; the next current row comes from the old order; the scope menu, Tab and Esc behave in every menu and sheet; the rail folds at 1330px; identifiers in the dialog and Link to… lose their spaced hyphens; lines on the 4px grid; the link suggestion names its pair.

**Round three** found the long tail, almost all of it under 1330px or with the list at its 400px minimum: the undo line placed for a rail that was folded away, the pane's width capped at 42% so the edge and the ⋯ menu did nothing, the selection bar spilling out, search tokens cut mid-letter and pushing ? off the bar, the stacked pane leaving a strip of cut rows; and a few keyboard dead ends: the scope menu could not be used by keyboard, the keys sheet let the focus hide under it, a range anchor survived a change of list, and focus fell to the page after a dialog or the selection bar closed. Two real bugs: accepting a suggested link wrote no link, and the current row could end off screen when a group re-sorted. All fixed, each with a check in `tools/check.mjs`.

**Round four** checked round three's list (most fixed) and found what one fix had broken and what moves do at the edges. Fixed:

- **Layout**: tokens that could shrink were never seen to overflow, so they were cut instead of folded; the search hint was chosen before the offline pill took its room; with nothing current, ? was pushed off the window and the search stretched (the list now takes the pane's room and the bar keeps its columns, and the pane fades out); link pairs and the pane's meta line cut words or started a line with "·".
- **Motion**: an accepted suggestion's own row flew into the group and landed on another thing's place (only a thing's own row flies now); the list jumped in one frame on T and on `.` (the scroll is smooth while rows move, and the next current row is one that stays put); ⌘Z showed the returning row's words over the row leaving its place (it lies under the list now, like a drawer).
- **Keyboard**: H then a quick E dismissed a whole group; under 900px J and E sent the focus to a row hidden under the pane, and F6 was stuck; the undo line covered the selection bar's × and, under 900px, the pane's moves; a value with a space broke the search; ⌘Z did not make the restored thing current; the focus jumped off a token's × and fell to the page after `/` Esc or when the undo line went; F6 left the scope menu open; ⌫ and Esc hints that did nothing; the hand-off menu's "Change" could not be reached and did nothing (it is the app's account picker now, a Tab away).

## Tried and dropped

- **Shortening the last token with an ellipsis** when it alone did not fit. At 1024px it read `project: C…`, which says nothing; folding it into +N, with the tokens in its tooltip, says more.
- **Clearing the rows beside the undo line** without moving the scroll padding. The current row could sit under the clear strip after a move; the list's scroll padding now keeps it above.

- **Count and title in one cell.** A group's "14 things" sat after its label and was the first thing cut. It moved to the right of the second line, with the marks.
- **Row columns as one grid.** The right column took the width of the place on line two, so titles were cut early. Each line is its own flex row now.
- **"Open on GitHub" in words** in the pane's head. It cut the provenance at 420px.
- **A marigold "Proposal" chip.** A filled chip was the loudest thing in the list. The word in the triage accent is enough.
- **"Hand-off takes one thing"** as a note in a group's footer. It wrapped to three lines and explained a refusal nobody had asked for.
- **Eleven triage rows at the top** under the extreme load. Capped at three.
- **"Named after PAY-88, its most lasting thing"** under a group's title. It explained the rule, not the group.
- **A selection bar with every move.** It repeated the pane's footer and spilled out of a narrow list. It counts and clears now.
- **A pane capped at 42% under 1330px.** The edge and the ⋯ menu stopped working. The only rule now is that the list keeps 400px.
- **New members fading in over the rows below.** Unfolding now opens like a drawer.
- **The "N new" pill floating over the first row.** It covered the current row's title; it sits in the list head.
- **A selection of one keeping the current row's pane.** The footer acted on the selection while the pane showed another thing.
- **A fade on the pane when walking.** Held J kept it between 0 and 70% opacity. It swaps at once now.
- **Leaving copies over the list.** They showed words over words; they lie under it now.
- **The current row's fill on the row.** It jumped down to the next row and rode back up with it. The puck stays put.
- **Dimming moves offline.** They still worked, and dimmed they failed contrast. They work and wait in an outbox.
- **A marigold disc for the Triage count.** It looked like the sidebar's "Waiting on you".
- **The search menu inside the search field.** A glass field is a backdrop root, so the menu inside it could not blur the list behind it, and the list showed through. The menu lives on the page.

## Running the tools

The tools import Playwright from the repository's own `node_modules`, so run them from a checkout after `pnpm install`:

```
node docs/design/inbox-list/tools/check.mjs
node docs/design/inbox-list/tools/capture.mjs [themes] [states]
node docs/design/inbox-list/tools/sheet.mjs <theme> <out.png> [states]
node docs/design/inbox-list/tools/film.mjs <flow> [theme]
```

On a Linux machine without Chromium's libraries, run them in the desktop container image, on the host's network, with the checkout mounted at the same path:

```
docker run --rm --network host --shm-size=1g --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -v "$PWD:$PWD" -w "$PWD" \
  --entrypoint node <hercule-desktop-linux image> docs/design/inbox-list/tools/check.mjs
```

## Files

| Path | What |
|---|---|
| `js/kinds.js` | What plugins declare: sources, kinds, statuses, fields, Browse, saved queries, signal kinds |
| `js/world.js` | The Northwind world: things, signals, links, triage, the extreme load, arrivals, the two settings |
| `js/model.js` | What the controller works out: saved queries, counts, groups, the list's order, offers |
| `js/draw.js` | Marks, glyphs, faces, times, the sentences a row says |
| `js/rail.js`, `js/list.js`, `js/pane.js` | The three columns |
| `js/bar.js`, `js/menus.js`, `js/dialog.js`, `js/parts.js` | Search and Narrow; the hand-off menu and Link to…; the thread dialog; the undo line, the "N new" bar, the selection bar, empty states, flights, the reply box |
| `js/moves.js`, `js/keys.js`, `js/drag.js` | Every move with its undo; the keys and the pane's edge; linking by drag |
| `js/scenes.js` | Every state by URL |
| `vendor/app.css` | The app's own stylesheets, from a running specimen of main, not edited |
| `vendor/motion.js`, `vendor/motion-extras.js`, `vendor/faces.js` | The shared motion kernel and the Bureau book's faces, as the earlier drawings use them |
