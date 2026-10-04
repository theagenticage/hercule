# Intake, direction C: Standing Orders

Every answer Rogier gives can become a standing order. "Always do this" turns one answer into a
start trigger he writes himself. The next time the same kind of thing comes in, it is done for him
and reported afterwards. Intake shows two things side by side:

- the exceptions: the decisions no order covers, by tier;
- what each order did while he was away, with its bound.

One number carries the lever: **38 handled for you this week · 9 by you this week**. The lever
counts the week, because since 18:20 Rogier answered nothing himself, and "0 by you" would show no
lever at all. Each label says "this week" itself, so it never reads as the "since 18:20" of the
head above it; that marker belongs to the run lines of the orders under it.

## States and URLs

Paths are relative to this folder. Every state also works with `theme=dark`
(`?theme=dark`, or `?state=swarm&theme=dark`).

| URL | What it shows |
|---|---|
| `desktop/intake.html` | 10 decisions in five tiers on the left. On the right, "While you were away": the lever, the 5 orders with what each did since 18:20 and its bound, and two starter orders for the new Linear Connection |
| `desktop/intake.html?state=swarm` | 10 times the events (2,120). Still 7 decisions. The orders grow instead: 6 orders plus "9 more orders", lever 1,186 against 41, and a "Handled 57" line that says which orders answered which proposals. Shows the "cannot be taken" answer (Close 9 duplicate issues) |
| `desktop/intake.html?state=make` | The "Always do this" editor floating over the page, opened from the Merge 4 row. The row stays marked |
| `web/intake.html` (and `?state=swarm`) | The same page under the web bar |
| `web/intake.html?state=make` | The editor at full width: Event Selector, workflow and bound on the left, the match preview on the right (31 events, 10 listed, 6 flagged). A copy-link button shares the editor with its filter and preview |
| `mobile/intake.html` | The digest first (lever, one line per order), then the exceptions. The urgent proposal is the one card |
| `mobile/intake.html?state=swarm` | Digest with 6 orders and "9 more"; 7 decisions; "Handled 57" |
| `mobile/intake.html?state=make` | "Always do this" as a bottom sheet over the dimmed page |

The orders list is both the brief's "While you were away" and its "Orders" shelf: each order shows
what it did (one line per run), its runs this week, overrides and its bound. An order is shown by
what it did; its configuration appears only in the editor, so the page does not become a
settings page.

## Components

All of these are in `intake.css`. None of them restyles a system.css class. Some selectors place
or size a system part inside one of these components, such as `.m-strip > .btn` filling its
column. One adds a state system.css lacks: `.answer-blocked` is the disabled look of a `.btn`.

| Class | What it is, and when it appears | System.css parts it reuses |
|---|---|---|
| `.tier`, `.tier-h` (`--now`, `--you`), `.tier--quiet` | A tier: name and count in a 92px gutter, its decisions beside it. Desktop and web. Now is in fail ink, the two tiers that wait on Rogier in you ink | Tokens only |
| `.decision`, `.decision-marks`, `.decision-what`, `.decision-kind` (`--you`) | One decision on one row: source marks, title and priority, kind and context, answers in fixed columns. States: rest, hover, `is-on` (open in the editor). Rows are split by a straight 1px line | `.answers`, `.btn--sm`, `.btn--accent`, `.btn--quiet`, `.bars`, `.proj`, brand marks, faces |
| `.decision--call` | A call (Unsure, Breaker): equal choices under the question, none suggested. Unsure's three choices sit in `.choices`. The breaker's short lines are sentences, so its answers take a ledger, one line each | `.choices`, `.ledger`, `.ans`, `.ans-desc` |
| `.answer-describe` (`--2`, `--3`, `--blocked`) | The short describe line under each answer, in that answer's column. Wraps to two lines, never cut. `--blocked` (why an answer cannot be taken) also takes the row's empty middle slot | The `.answers`, `.choices` and `.m-strip` grids |
| `.answer-blocked` | An answer the core no longer allows: drawn in its slot, disabled | `.btn` |
| `.decision-always` | "Always…" on a row. Hidden at rest, shown on hover or `is-on` (desktop, web); always shown on a phone row | `.btn--sm`, `.btn--quiet` |
| `.decision-card`, `.decision-top`, `.decision-gist`, `.decision-answers`, `.decision-foot`, `.live`, `.ans-fine` | The lead decision, the one card per page: chips, title, gist, made-from, the answer ledger with full describe lines, the producer's description as fine print, and keys, and a foot with "Always do this…" and triage's follow-up offer. `.decision-answers` also lines up the breaker's ledger | `.card`, `.chip--fail`, `.bars`, `.proj`, `.ledger`, `.ans`, `.ans-desc`, `kbd`, `.m-ans` |
| `.made-line` (`--grid`) | Made from on one line: per source system its mark, a count and the Connection. `--grid` puts two entries on a phone line | Brand marks |
| `.orders-h`, `.lever`, `.lever-bar` | The head of the orders list and the lever: handled for you against by you, as two numbers and a split bar | `.section-h`, `.deco-num` |
| `.order`, `.order-h`, `.order-name`, `.order-week` | One order: face, name, scope, runs this week, overrides. `--paused` when its bound tripped (paused face, full red meter) | Faces |
| `.did` | What the order did: one line per run with its mark, the work, a time or duration. Marks: done, working (still), waiting (you ink), failed, paused | `data-mark`, `.mark`, `.you-ink` |
| `.order-foot`, `.order-bound` | The Spawn Bound as a meter and "2 of 10 a day" (or "a schedule, once a night"), then Review, and Undo where it can be undone | `.meter`, `.btn--quiet` |
| `.orders-more` | "9 more orders · 466 runs, none paused" (swarm) | `.stack`, faces |
| `.suggest`, `.suggest-h`, `.suggest-row` | Starter orders for a new Connection (Linear · product). Never active until made | Brand marks, `.btn--sm` |
| `.quiet`, `.quiet-row`, `.receipt` | Quiet facts under the decisions: attached events, FYI, the unknown system, the triage note, chat delivery (phone), the receipt line | Icons, brand marks |
| `.later` | A "later" tag on something post-v1 (the triage note). Never a live control | None |
| `.mark-still` | A working mark at rest: the same glyph, no animation. Desktop and phone | `.mark`, the `m-working` icon |
| `.src-x` | The fallback mark for an unknown system (hetzner) | None |
| `.digest`, `.digest-more` | Phone: one line per order, what it did and its latest state | Faces, `.you-ink` |
| `.decision--stack` | Phone: a decision with what it is on top and its answers on a full-width row under it. The breaker's answers are `.m-answers`, as in the lead card | As `.decision`, `.m-answers`, `.m-ans` |
| `.m-strip` | Phone: answers in three fixed columns (suggested, neutral, quiet), the same on every row. The quiet column is 72px, the narrowest its words allow, so every short line fits two lines | `.btn--lg`, `.btn--accent`, `.btn--quiet` |
| `.m-choices`, `.m-choice` | Phone: Unsure's choices two by two, each with its describe line | `.btn--lg` |
| `.editor`, `.editor-h`, `.editor-sec`, `.editor-act` | The "Always do this" editor: a floating panel on desktop, a wide panel on web, a bottom sheet on the phone | `.glass`, `.sheet`, `.section-h`, `.icon-btn`, `.btn` |
| `.selector` (`--narrow`), `.cond` (`--add`), `.cel` | The Event Selector: Event, From, Where. Each condition in words with a remove mark; the CEL it compiles to in mono (the editor is a detail view). `--narrow` gives the phone's fields more width | `.field`, `.field--select` |
| `.editor-does` | The workflow the order starts and its one step | Faces |
| `.bound-pick` | The Spawn Bound: a slider and "10 a day · then it pauses and asks you" | `.range` |
| `.preview-h`, `.preview`, `.preview-flag`, `.preview-warn` | The match preview: "31 events last week would have matched", the newest of them, the ones that would not be wanted (minor bumps) flagged, and a warning | `.deco-num`, `.num` |
| `.describe` | The core's full describe line of what "make standing" creates, ids in mono | None |
| `.scrim` | Dims the page under the editor | None |

Page-local CSS, layout only: `.triage-at` on all three pages; `.away`, `.list`, `.m-lead` on the
phone; `.editor-cols`, `.editor-tools` on the web.

## Where "Always do this" is offered

- On Proposals and Offers: in the lead card's foot, on a desktop or web row while hovered, focused
  or open, and on every phone row.
- That one button opens the editor on the suggested answer (the primary), so "Always do this:
  Merge all 4". The other answers are made standing from the editor's Do section, which would
  hold a select of the decision's answers. Not drawn. That is how the swarm's "Add to backlog"
  (from Accept) and its Dismiss order (from Dismiss) were made.
- Not on:
  - approvals: "always allow" would be a permission grant, which belongs in a permission profile
    (spec 13), not in a start trigger;
  - breaker answers: they act on a trigger that already exists;
  - Unsure: there is no answer to repeat. "Not work, every time" is a triage note, which is later;
  - an answer that cannot be taken.
- The editor can answer the decision and make the order in one go ("Merge all 4 and make
  standing"), or only answer it ("Merge all 4 only").
- Undo shows only where the work can be undone: labels (Label new issues) and Task status (Add to
  backlog). Merges, sent replies and published releases get Review only.
- No order covers an open decision. The scopes are drawn so: Fix bug covers "webshop, not urgent"
  (swarm: "Checkout, not urgent"), Draft reply covers Intercom only, and the swarm's Add to
  backlog covers "low priority". That last order is why the "When you can" tier is gone in swarm.

## Departures

- **Departs from CONTEXT.md because "standing order" is not a CONTEXT.md word.** Underneath it is
  exactly a start Trigger (Event Selector or Schedule, inputs, Spawn Bound) on a workflow. The
  editor's subtitle and the describe line say "start trigger". If this direction is chosen,
  CONTEXT.md gets the word, or the UI says "start trigger" everywhere.
- **Departs from spec 10 §2.5 ("Tasks are the buffer"; triage is the only doorway) because an order
  acts without a click, which is its point.**
  - An order made from a Proposal's Start answer listens on `task.created` for proposed Tasks in
    its scope (project, priority, topic). Its workflow's first step removes `proposed` and sets
    the status to in progress. §2.4 says work workflows never trigger on `task.created`; this
    one does on purpose, narrowed by its filter and its bound.
  - An order made from Accept or Dismiss starts a one-step workflow that runs `task.update`, the
    same operation the answer binds. An order can only start a workflow, so it carries the
    workflow's name: the swarm order is "Add to backlog", not "Accept".
  - An order made from an Offer (Merge 4, Draft reply, Label new issues) listens to raw events and
    skips triage. §2.5 calls its topology a convention, never enforced; the Spawn Bound is the
    guard.
- **Needs an addition to spec 10 §7.7 because its "answered elsewhere" table covers only the core's
  own kinds.** When an order takes a proposed Task, triage's Proposal about that Task stays open,
  and Intake would ask about something already done. A Proposal must resolve when its Task stops
  being proposed, whoever changed it. In the same way, triage must not offer an Offer for an event
  an order already started a run for (the trigger-effects table has that row).
- **Departs from spec 10 §7.4 (one describe line per answer, shown in full) because a row has 84
  to 156px per answer.** Rows show a short describe line, which the core derives by a rule. See
  "Proposed spec change" below.
- **Departs from spec 10 §8 (approvals are Check-in's Needs-you; the two views stay separate in
  v1) because the npm approval sits in Intake under Waiting on you.** The page asks for every
  answer the user owes in one place. If this direction is chosen without merging the views, the
  tier goes and the approval stays in Check-in.
- **Departs from spec 10 §5 ("Resume and discard backlog") because the label must fit a 156px
  ledger button.** It reads "Resume, discard", with "Resumes and discards the 34 held events"
  beside it.
- **Departs from Crew Bureau 2 (a section head above each list) because the tier name sits in a
  gutter on the left.** That saves a line per tier and keeps every tier's answers in the same
  columns. The phone keeps Crew Bureau 2's `.m-lane`.
- **Departs from the brief's "each answer offers Always do this" because some answers must not
  repeat** (see the list above).
- **Departs from the brief's Made from (Connection suffix on every entry) on the phone because the
  suffixes do not fit 350px.** The phone shows mark and count; the Connection is in the detail
  sheet.
- **Departs from the producer's answer labels on phone rows because three answers share 350px.** A
  Start answer shows the workflow's face and name ("Investigate"), not 'Start "Investigate"'. The
  phone's lead card keeps the full label. The stored label is unchanged, so the short describe
  line is the same as on desktop: "Starts on ops".
- **The phone leaves out** the topic tabs and triage's follow-up offer ("I can draft a reply to the
  3 customers once the fix ships"). Its editor sheet lists 2 preview rows instead of 10, hides the
  CEL, and shows "+ condition" as an icon.
- **Mono in the lead card's gist** (`requires_action`, `handlePaymentResult`), inherited from Crew
  Bureau 2. The brief allows mono in describe lines and detail views. The lead card is the
  decision's detail, and both are code identifiers, so they stay.
- **Room for Park.** A row's `.answers` grid (system.css) has three columns. Park would be a fourth
  column of 84px taken from the title's width, as `.choices` already holds four. The lead card's
  ledger takes it as a fourth line. On the phone, `.m-strip` would become two by two, like
  `.m-choices`. Park is not drawn.

## Proposed spec change: short describe lines (spec 10 §7.4)

Spec 10 §7.4 gives each answer one describe line, shown in full wherever the answer can be taken.
A row in Intake has 84 to 156px under each button. Rather than short copy written by hand, the
core derives a short line by this rule:

> A **short describe line** is the core's describe line for the same frozen input, with the names
> the row already shows removed, together with the words that introduce them ("with Task", "on
> Task", "of"). Those names are:
>
> - each entity in the notification's `subject`: the Task of a Proposal or of Unsure, the trigger
>   of a tripped breaker, the session of an approval, the email thread or the pull requests of an
>   Offer. A list is replaced by its count, not removed;
> - the workflow, when the answer's label already names it in quotes (`Start "Fix bug"`).
>
> Everything else stays: every value the answer sends or sets, the project, the Connection it
> acts as, counts. A line with nothing to remove is shown whole. A short line never uses the
> producer's description. It starts with a capital, like the full line, wraps, and is never cut.

Where each form appears:

- Rows on desktop, web and phone, and the buttons of a chat message: the short line.
- The lead card, the chat message body and the editor: the full line, with the producer's
  description as fine print under it (in a chat body, after it on the same line).
- When a short line does not fit two lines under its button, the answers take a ledger, one line
  each: the breaker (`.ledger` on desktop and web, `.m-answers` on the phone). The "cannot be
  taken" line also takes the row's empty middle slot.

| Answer | Full line | Short line |
|---|---|---|
| Start "Fix bug" | Starts **Fix bug** on **webshop** with Task **Checkout fails for EU cards with 3-D Secure** | Starts on **webshop** |
| Accept | Removes label **proposed** from Task **Checkout fails for EU cards with 3-D Secure** | Removes label **proposed** |
| Dismiss (Proposal) | Sets status to **cancelled** on Task **Checkout fails for EU cards with 3-D Secure** | Sets status to **cancelled** |
| webshop (Unsure) | Sets project to **webshop** on Task **App is slow on Android** | Sets project to **webshop** |
| Resume | Resumes **Label new issues**: the **34** held events start runs at **20 per hour**, the rest as the window frees up | Resumes, and the **34** held events start runs at **20 per hour**, the rest as the window frees up |
| Resume, discard | Resumes **Label new issues** and discards the **34** held events | Resumes and discards the **34** held events |
| Edit the trigger | Opens the trigger of **Label new issues**, where its Spawn Bound lives | Opens the trigger, where its Spawn Bound lives |
| Allow once | Allows **npm publish** once for session **Ship release v2.15** | Allows **npm publish** once |
| Deny | Denies **npm publish** for session **Ship release v2.15** | Denies **npm publish** |
| Draft reply | Starts **Draft reply** with thread **Invoice INV-2291** from **Gmail · rogier@personal** | Starts **Draft reply** from **Gmail · rogier@personal** |
| Merge all 4 | Merges **#1301 #1302 #1304 #1305** in **rogier/webshop** as **GitHub · rogier** | Merges **4** in **rogier/webshop** as **GitHub · rogier** |
| Review first | Opens the 4 pull requests (see below) | Opens the 4 pull requests |
| Dismiss (Offer) | Does nothing | Does nothing |
| Close all 9 (swarm) | Cannot be taken: the GitHub plugin changed this action's inputs at 08:30, after triage proposed it | The same line, whole |

"Review first" binds no operation: the surface opens the pull requests on GitHub. Spec 10 §7.4 would
write "Does nothing" for it, which is true of the system but tells Rogier nothing. This direction
lets a link answer's line name what it opens. That is a second, smaller spec change.

The fine print in the lead card: "Fix it now; the cause is known." (Start), "This is work; it
stays in the backlog." (Accept), "Not work, or not worth doing." (Dismiss).

Three points the rule settles that the review left open:

- **The workflow name goes only when the label quotes it.** The review's rule removes "the
  workflow in the button label", but its own Draft reply example keeps the name. "Draft reply" is
  the workflow's bare name used as a verb, and "starts from Gmail · rogier@personal" would not say
  what starts. Quotes are a mark the core can check.
- **Subjects beyond the Task.** The review names the decision's subject Task; its Draft reply and
  Merge examples also drop the thread and the pull requests. So the rule keys on the whole
  `subject` list, which every notification carries, typed. This assumes triage puts an Offer's
  thread and pull requests into its `subject`.
- **The approval's full line is a guess**: "for session **Ship release v2.15**" follows the
  spec's own example for `session.input` ("Reply ... to session ...").

## What animates on desktop, and what it costs

The desktop page sets `data-motion="off"`. `intake.css` has no animation and no transition.

| What | When | Cost |
|---|---|---|
| Nothing | Idle: no decision arriving, no pointer moving | A still page: no timers, no animation frames. Spec 17 measured a still page at 6 GPU and 0 renderer wakeups a second |
| Working runs (Fix bug, Draft reply) | While they run | None. Their marks are drawn still (`.mark-still`); spec 17 allows one continuous animation, and it belongs to the open thread, not to a list |
| Faces (orders, Triage, the lead's foot) | Always | None. Drawn still in their pose; `data-motion="off"` stops the blink |
| Durations ("14m", "1m") | Once a minute | One text change; spec 17 allows a time label to change |
| Row hover | The pointer enters a row | System.css's 120ms background fade on the button under the pointer. The row background and "Always…" switch in one frame. Paint of one row |
| The editor opens (make) | A click on "Always…" | Shown in one frame in this prototype. If it animates: opacity and a 4px translate of the panel, 320ms at most (`--dur-3`), on an HTML element, so it runs on the compositor |
| Meters and the lever bar | A count changes | Snap; no animation |

The phone draws working marks still as well, to spare the battery. Web and phone keep Crew
Bureau 2's face blink.

## One decision as one chat message

A decision is one message with one button per answer. Slack and Discord cap a button label at
about 75 to 80 characters, and the full describe line of "Merge all 4" is longer than that. So the
button carries the label and the short describe line, and the message body lists the full lines.
The message shows the decision's title, as a row does, so the same rule applies (see "Proposed
spec change" above).

```
[GitHub] Merge 4 dependency bumps
Offer · webshop · patch, green · from GitHub · rogier

Merge all 4: Merges #1301 #1302 #1304 #1305 in rogier/webshop as GitHub · rogier
Review first: Opens the 4 pull requests
Dismiss: Does nothing. Triage won't offer these again.

[ Merge all 4 · Merges 4 in rogier/webshop as GitHub · rogier ]   (primary)
[ Review first · Opens the 4 pull requests ]                       (a link)
[ Dismiss · Does nothing ]
[ Always do this… ]                                                (a link)
Open in Hercule
```

When the decision resolves anywhere, every copy is edited to one line:

```
✓ Merge all 4 · decided on the desktop at 09:44 · 4 merged
✓ Merge all 4 · decided on the web at 09:44 · and made standing: Merge dependency bumps, at most 10 a day
```

"Always do this" can be offered in chat, but only as a link. It opens the editor on the web (the
same editor the web page shows, with its URL), or the sheet in the phone app. It cannot be an
answer:

- Making an order is two operations (a workflow and its start trigger), not the one operation an
  answer binds, and neither is on the list of operations an answer may run (spec 10 §7.4).
- The informed part of the click is the match preview and the bound, and a chat button has room
  for neither.

Chat delivery shows up in Intake only where it matters: on the phone, under Also, "Copies go to
Slack · Discord is reconnecting since 09:12". Desktop and web leave it out.

## Counts

Buttons and words are counted inside the page, without the shell (sidebar, web bar, tab bar), with
`docs/design/shared/count-intake.mjs`. "Answerable" means the decision's answer buttons and their describe lines
are fully in view without scrolling.

| Page | Buttons in view | Words in view | Decisions answerable without scrolling |
|---|---|---|---|
| Desktop 1440x900 | 26 | 490 | 5 of 10 |
| Web 1280x800 | 18 | 420 | 3 of 10 (4 by buttons alone: the approval's lines fall below the fold) |
| Phone 390x844 | 3 | 140 | 0 of 10 (the digest comes first, by design) |
| Desktop, swarm | 26 | 495 | 5 of 7 |
| Web, swarm | 19 | 424 | 3 of 7 |
| Phone, swarm | 2 | 119 | 0 of 7 |

Before the short describe rule, the default pages counted 33, 24 and 4 buttons and 8, 5 and 1
answerable decisions. The rule costs height: most short lines now wrap to two lines, the breaker's
lines are sentences and take a ledger, and the lead card carries full lines and fine print.

For comparison, Crew Bureau 2's Intake: desktop 13 buttons and 348 words, phone 3 and 133. The
desktop has more buttons because every decision on screen can be answered where it stands, and
each order has its own Review.

## Wrong, guessed or in conflict

- **crew.js shows a thread "Fix 3-D Secure checkout" waiting**, while the Proposal to start that
  fix is still open.
- **Label new issues** is a paused run in CONTENT.md, but a breaker pauses the trigger (spec 10
  §5). It is drawn as a paused order with 34 held.
- **The brief's describe example** (Draft reply on Gmail when the subject mentions an invoice)
  would cover Marta's open Offer. The Draft reply order is scoped to Intercom instead.
- **The receipt has no bucket for what orders did.** Pieter's and Jonas's messages and the Fix bug
  Tasks are not visible in "212 events → ...". A real receipt would add "N started by orders".
- **A filter cannot tell a patch bump from a minor one**: the GitHub event carries no update type.
  The preview flags the 6 minor bumps and says so. Either the GitHub plugin adds the field, or the
  order merges minor bumps too.
- **Not built yet**: plugin actions as answers (so "Merge all 4" itself), Spawn Bounds, the
  breaker, held events, `discardHeld` and `trigger.resume` (#87). The paused order, the breaker
  decision and every bound meter depend on them.
- **Swarm numbers are invented, but they add up**: 1,186 runs is the 6 orders plus the 466 of the
  other 9; Handled 57 is 17 + 33 + 4 + 3; the receipt sums to 2,120.
- **The editor's subtitle is shorter on the phone** ("A start trigger you write. It runs without
  asking.") than on desktop and web, to fit the sheet.
- **The "bound" glyph is a weak icon for "Always".** Phone rows show the text only.
- **An order's run count mixes time frames, as the lever did.** "Fix bug · 3 runs" is the week,
  but the head of the list says "since 18:20" and the lines under it are since 18:20. Not changed
  in this round.
