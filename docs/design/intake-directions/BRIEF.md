# Intake, rethought - the brief for three directions

PROTOTYPE. This brief is the shared input for three Intake directions drawn in Crew Bureau 2. Each
direction gets a desktop, a web and a mobile page. The book (`index.html` beside this file)
compares them and argues for one.

## 1. The question

Today's Intake (`../crew-bureau-2/{desktop,web,mobile}/intake.html`) was designed early and only
ported to Crew Bureau. It presents information well, but it does not help Rogier clear his head
and get work *moving*. Measured on the desktop page at 1440x900: 36 buttons on the page, 13 in
view, 507 words (348 in view), 72 numbers in view, and only 3 of the 9 open decisions can be
answered without scrolling. On the phone: 3 buttons and 133 words in view.

Agents are cheap and come in swarms. What is scarce is Rogier's attention and his ability to make
high-impact decisions fast. So each direction answers one question differently:

> **How does Intake turn 212 signals into shipped work while costing Rogier the least attention?**

Each direction pulls one main lever, and its brief names that lever in its first sentence:

| Direction | Folder | Lever |
|---|---|---|
| **Deck** | `deck/` | Speed per decision: one complete decision at a time, answered in one key or one swipe |
| **The Line** | `line/` | Visible consequence: Intake is the head of a production line, and every answer visibly moves work down it |
| **Standing Orders** | `orders/` | Fewer decisions: every answer can become a standing order, so Intake shrinks to the exceptions |

The three must stay **far apart**. If your page starts to look like another direction's, push
back toward your lever.

## 2. What Hercule is (read this before drawing anything)

Hercule is a self-hosted agent orchestration platform for one person, Rogier, who runs a small
company (Acme) alone with agents. One always-on **controller** holds all state; **runners** host
agent sessions; **clients** (desktop app, web app, CLI, chat channels) all use one public API.

Work enters as **events** from **Connections** (GitHub, Gmail, Sentry, Stripe...). A **Triage**
workflow runs every two hours (`0 7-23/2 * * *`; last run 09:00, took 42s, next 11:00). For each
batch it does, in order: set aside known work, enrich, group, act, summarise. Its acts are:

- **Proposal**: a Task labelled `proposed` plus an open decision. "This should be work."
- **Attachment**: new events added to an existing Task's provenance. No decision.
- **Offer**: an immediate action with no Task behind it ("Merge 4 dependency bumps").
- **FYI**: worth knowing, nothing to do.
- **Unsure**: triage could not decide and says why.
- **Nothing**: the event is known or not worth anything ("no action").

Triage **never** starts, merges, replies or deletes. It only proposes. **Proposing is not doing**
(ADR 0022): the user's click authorises the operation. Anything that acts without a click must be
a **start Trigger** the user wrote (an Event Selector plus a Spawn Bound).

**Intake** is the formation boundary where external signals become work, and the view that shows
it. Never call it an inbox, a dashboard or a command center.

### The v1 inventory every direction must support

Read spec 10 §2-3 and §7.4 (`docs/spec/10-triage-intake-and-notifications.md`), ADR 0022, and the
pinned "Intake semantics" in `docs/design-language.md`. In short:

**Decisions.** A decision is a Notification with answers (Bound Actions). Open decisions in
Intake are: Proposals, Offers, Unsure (`triage.unsure`) and Breaker tripped
(`core.breaker-tripped`). "Needs a call" = Unsure + Breaker; it is verdict-based, never
priority-based. Proposals are tiered by priority: Now (urgent) / Today / When you can.

**An answer** (one Bound Action) has:

- a **label** ("Start Fix bug"),
- the core's **describe line**: what clicking does to the system, written by the core, never by
  the producer, never hidden behind hover. Live names and values are set apart in ink ("Starts
  **Fix bug** on **webshop** with task **Checkout fails for EU cards with 3-D Secure**"),
- optionally the producer's **description** as fine print (what the choice means),
- optionally **primary** (at most one per decision; that is the lacquer `--accent` button).

An answer can be in four states, and the answer component must render all four:

1. bound to a core operation (`task.update`, `run.start`, `session.input`,
   `session.respondToApprovalRequest`, soon `trigger.resume`),
2. bound to a **plugin action** (`github/pr.merge`, `gmail/message.reply`), same look, the describe
   line names the Connection it acts as,
3. **navigation only** (no operation; it opens something, e.g. "Review first" opens the 4 pull
   requests; describe line "Opens ...", never "Does nothing"),
4. **cannot be taken**: the stored operation no longer passes the core's check; the describe line
   reads "Cannot be taken: <why>" and the answer is disabled; the other answers still work.

A null-operation answer's describe line is "Does nothing". Leave room for a fourth proposal
answer, **Park**, post-v1 (do not draw it as live; a layout that cannot fit it is wrong).

**Proposal answers** (v1): **Start X** (`run.start`, only when a fitting workflow exists),
**Accept** (`task.update` removes label `proposed`: "this is work, keep it in the backlog";
"not now" means Accept), **Dismiss** (`task.update` status `cancelled`). The spec marks one
primary per decision; triage's suggestion is the primary.

**Made from** is mandatory on every proposal: one entry per source *system* with the system's
monochrome mark, the Connection that carried it as a suffix (in the UI face, never mono). The
mark follows the event's `system`, not the Connection: a Sentry alert that arrived through Gmail
shows the Sentry mark with "via Gmail · rogier@personal".

**Since marker.** Intake is framed on "since you last checked" (yesterday 18:20). Opening the view
advances the marker; the URL pins it (`?since=2026-09-28T18:20`) so a reload or a shared link
shows the same page.

**Receipt.** The counts add up: `212 events → 5 proposals · 1 attached · 2 offers · 3 FYI ·
1 unsure · 34 held · 166 no action`. Every count can open the events behind it.

**Event stamps** (derived, never stored): → task (proposal / attached), offer, FYI, unsure,
known, held, pending triage, no action.

**Topics** are labels, not entities: each Connection files into a default topic; triage labels a
proposal. User-ordered. All · Checkout · Infrastructure · Customers · Releases, plus "Manage
topics".

**Last triage**: time, duration, next run, the triage's one-paragraph summary, and "Triage now".

**Retention.** Events are kept 90 days. Any events surface states that horizon and never
truncates silently.

**Detail** lives in a drawer (or a sheet on mobile), never a full page and never a permanent
master/detail split: the dossier (gist, made-from excerpts with "Open in <system>", the triage's
reasoning, history) and a Connection's events list.

**Delivery off the app.** In v1 the phone surface is a chat channel (Discord, Slack): each
decision is posted as one chat message, one button per answer ("label · describe line"), plus a
link back. When a decision resolves anywhere, every copy is edited to show the outcome ("✓ Start
Fix bug - decided on the desktop"). So every direction's unit of decision must be renderable as
**one chat message**.

### Plugins bring the information in

Channels, event sources, providers and workflow actions are all plugins. Intake must model a
plugin adding new information without anyone redesigning the page:

- A plugin supplies **no** icons and **no** colors. Known systems use the monochrome brand marks
  in `crew-bureau-2/brands.js`; an **unknown system** gets the fallback mark (§5).
- A **new Connection** shows up on its own: "Linear · product, listening since Mon 17:55, nothing
  yet". Never an empty silence.
- A Connection has a status: connected, needs re-authorisation, error, disabled. A broken
  Connection is something Intake must tell Rogier, because a silent source looks like a calm one.
- A plugin action (`github/pr.merge`) appears as an answer like any other; the describe line is
  still the core's.
- Event kinds are dotted (`github.issue.opened`), contributions are qualified (`github/pr.merge`).
  Never show these ids as the main label; they may appear in a describe line or a detail view.

### Post-v1, so the design must have room for it

Draw these only where your direction says so, and label them clearly as later:

- **Park** as a fourth proposal answer.
- **Fast lane**: an event trigger on Triage, so proposals arrive between batches; the view updates
  live instead of every two hours.
- **Feedback learning**: thumbs on proposals feeding the triage's memory ("stop proposing PostHog
  dips under 5%").
- **"Work on task"** shipped workflow; a **human-gate step** inside a run.
- **Merging Intake and Check-in** into one spine (still an open question).
- **Presence routing** (desktop idle, send to phone), **webhook sources**, **per-record read
  state**, finer **muting**, an **archive**, **more than one user**.

### Rejected on the record (do not bring back without saying so)

Narrative morning-brief prose at the top of the page; a time-first ledger as the page; a permanent
master/detail split; a full detail page. If your direction needs one of these, the book must say
so and argue for it.

## 3. Fixtures

Use `../shared/CONTENT.md` exactly: "Now" is Tuesday 29 September 2026, 09:41; the user is
Rogier; the projects, Connections, counts, decisions and wording are all there (sections "The
world", "Intake (as of 09:41)" and "At 10x"). The intake pages show the moment **before** the
3-D Secure thread was started, so the lead Proposal is still open; do not show that thread in any
"moving" list.

### Corrections to CONTENT.md (it predates the spec on these points)

**Breaker answers.** The spec's answers to a tripped breaker are not "Keep held / Release all /
Raise bound". Use:

- **Resume** (`trigger.resume`) - "Resumes **Label new issues**: the **34** held events start runs
  at **20 per hour**, the rest as the window frees up"
- **Resume and discard the 34** (`trigger.resume` with `discardHeld`) - "Resumes **Label new
  issues** and discards the **34** held events"
- **Edit the trigger** (navigation only) - "Opens the trigger of **Label new issues**, where its
  Spawn Bound lives"

Not answering keeps the events held. Say so in one short line, not as a button.

**Offer "Merge 4 dependency bumps"** binds a plugin action:

- **Merge all 4** (`github/pr.merge`, primary) - "Merges **#1301 #1302 #1304 #1305** in
  **rogier/webshop** as **GitHub · rogier**"
- **Review first** (navigation only) - "Opens the 4 pull requests"
- **Dismiss** - "Does nothing"; fine print: "Triage won't offer these again."

**Offer "Draft a reply to Marta at Brightline"**:

- **Draft reply** (primary) - "Starts **Draft reply** with thread **Invoice INV-2291** from
  **Gmail · rogier@personal**"; fine print: "You review the draft before anything is sent."
- **Dismiss** - "Does nothing" (CONTENT.md's "Not now" for an offer is this Dismiss)

**Unsure "App is slow on Android"**: triage created the Task without a project. Answers bind
`task.update`: **webshop** / **payments-api** set the project ("Sets project to
**webshop** on Task **App is slow on Android**"); **Not work** - "Sets status to **cancelled** on
Task **App is slow on Android**". There is no "Both": a Task has at most one project (spec 09).

### Additions (every direction shows each of these somewhere)

- **A new Connection**: "Linear · product", connected Monday 17:55, default topic Releases,
  listening, 0 events yet.
- **An unknown system**: one of the 166 "no action" events came from **hetzner** through Gmail
  (a sender rule): "Hetzner · invoice for September", stamped no action. It gets the fallback mark.
- **A broken Connection**: Discord · community is reconnecting since 09:12 (from CONTENT.md).
  It is a channel, not an event source, so Intake mentions it only where delivery matters (e.g.
  "Phone copies go to Slack; Discord is reconnecting").
- **A "cannot be taken" answer**, in the swarm state: an Offer from the GitHub plugin, "Close 9
  duplicate issues", whose answer **Close all 9** reads "Cannot be taken: the GitHub plugin changed
  this action's inputs at 08:30, after triage proposed it". Its **Dismiss** still works.
- **What is already moving** because of earlier answers (for directions that show it), from the
  sessions list in CONTENT.md, and nothing else:
  - **Cart total rounding on discounts** - Run (Fix bug), webshop, working 14m; 2 new Sentry events
    were attached to its Task this morning.
  - **Draft reply to Jonas at Kiteworks** - Run (Draft reply), payments-api, working 1m.
  - **Ship release v2.15** - Run (Ship release), payments-api, **waiting on you**: "Publish
    payments-api 2.15.0 to npm?" (Allow once · Deny).
  - **Label new issues** - Run, paused because its bound tripped (the breaker above).
- **What shipped since yesterday 18:20** (new; use these, invent no more):
  - **Discount codes ignore letter case** - pull request #1287 merged in rogier/webshop at 19:12,
    from 2 Intercom conversations and a Sentry error; Fix bug ran 22 min. Event to merge: 4h 50m.
  - **payments-api v2.14.0** published at 19:40 (this is the FYI "Release v2.14.0 was
    published"); Ship release ran 9 min.
  - **Reply sent to Pieter at Bakkerij Smit** about a refund at 18:44; Draft reply ran 2 min,
    Rogier approved the draft. Event to sent: 1h 05m.

### At 10x (`?state=swarm`)

140 live sessions across 9 runners, 31,000 events a day, 60 proposals a morning, 14 workflows,
4 assistants. Since yesterday 18:20: 2,120 events. Triage groups alike proposals; your direction
shows how it holds **without a longer list**. The swarm topic counts used so far: Checkout 19,
Infrastructure 14, Customers 17, Releases 7 (57 proposals plus 3 in no topic = 60).

## 4. Rogier's rules (hard)

- **No large italic headers.** No italics for display type at all.
- **Not text-heavy.** Text belongs to content (a gist, an excerpt), not to chrome. Every sentence
  of UI copy must earn its place; prefer a number, a mark or a face over a sentence.
- **No heavy box-in-box.** One level of containment (`.card`). Inside a card, separate with space
  and hairlines, never with another bordered box.
- **Answers line up.** Buttons in a list of decisions sit in the same columns from row to row.
- **No mono in the UI.** Recursive is for code and ids inside describe lines or a detail view
  only.
- **At most six state marks.** Use the existing marks (`working`, `waiting`, `done`, `failed`,
  `paused`, `idle`); invent no new ones.
- **Nothing glows.** The burning item is marked by its position, its bars and its words, plus at
  most one small pulsing dot. No halos, no colored washes that drown the page.
- **Plain words.** No em or en dashes anywhere (use "-"). Never: hydra, agentick, inbox,
  dashboard, persona, lorem ipsum, "rule" for a trigger.
- **Desktop performance** (spec 17): nothing animates unless something is happening; only the
  `working` pose animates; animate `transform` and `opacity` only; a pulsing dot must justify
  itself. Budgets: renderer JS ≤ 250 kB gzipped, 220 MB memory. Say what each animation costs.

## 5. The design system: Crew Bureau 2

Link it; do not fork it. Read `../crew-bureau-2/system.css` and `../crew-bureau-2/crew.js`, and
look at the existing pages before building.

- **Color is who**: 8 hues for agents and assistants. **Marigold `--you`** marks what waits on the
  user, never a button fill. **Lacquer `--accent`** is the one filled suggested button per group.
  **Tomato `--fail`** means hurt. Green `--ok` for done. Project inlays `--proj-webshop`,
  `--proj-payments`, `--proj-ops` (classes `.proj--webshop` etc.).
- **Type**: Bricolage for UI (`--font-ui`); Limelight for deco numerals only (`.deco-num`,
  `--t-num` 26px); Recursive for code only. Sizes `--t-11` to `--t-20`; spacing `--s-1` to `--s-8`
  on a 4px grid.
- **Containment**: `.card`, one level. Glass (`--glass-level`, default 0.4) only on floating
  layers: drawers, sheets, panels, toasts.
- **Buttons**: `.btn` (neutral), `.btn--accent` (one per group), `.btn--quiet`, `.btn--danger`,
  sizes `--sm` 26px and `--lg` 38px. Aligned answer grids: `.answers` (156/104/84px), `.choices`
  (4 x 124px), `.ledger` / `.ans` (156px 1fr auto).
- **Other parts**: `.chip` (`--you`, `--fail`, `--ok`, `--who`), `.src`, `.bars[data-p="1..4"]`,
  `.tabs` / `.tab`, `.seg`, `.section-h`, `kbd`.
- **Faces** (`data-face="Ada" data-pose="working" data-size="28"`), the user (`data-you`), state
  marks (`data-mark="waiting"`), icons (`data-i="clock"`), brand marks (`data-brand="sentry"`).
  Brands: github, gmail, sentry, posthog, intercom, grafana, stripe, slack, discord, anthropic,
  claude, openai, linear, pagerduty, datadog, googlecalendar, plus `pi`, `cron`, `web`.
  `Crew.brand()` throws on an unknown name, so draw the **fallback mark** for an unknown system
  with this exact markup and CSS (the same in all three directions):

  ```html
  <span class="src-x" role="img" aria-label="hetzner">h</span>
  ```

  ```css
  .src-x { display: inline-grid; place-items: center; width: 14px; height: 14px;
    border: 1.5px solid currentColor; border-radius: 4px;
    font: var(--w-bold) 9px/1 var(--font-ui); text-transform: lowercase; }
  ```
- **Shells** (filled by `crew.js`): desktop `<aside data-side="intake">` in `.app` with
  `<main class="main">`; web `<header data-webbar="intake">` in `.web`; mobile `.phone` with
  `<div data-status>`, the page, and `<nav data-tabbar="intake">`. Mobile parts: `.m-nav`,
  `.m-title`, `.m-body`, `.m-lane`, `.m-answers`, `.m-ans` (`--accent`, `--quiet`, `--danger`),
  `.sheet`, `.haptic`.
- **Themes**: whitehaven (= light), styles, orient-express (= dark), nile, end-house. Every page
  must work in light and dark.

## 6. Platforms: play to each one's strengths

- **Desktop** (Electron on macOS, spec 17): always on, keyboard first, a global hotkey, the menu
  bar, native notifications with action buttons, more than one window. Intake on desktop is
  post-v1 in spec 17, so this is the design it will be built from.
- **Web** (1280x800 frame): the URL is the state (deep links to one decision, the `?since`
  marker, topic in the URL), opened from anywhere including another person's laptop, the tab
  title and favicon can carry a count, wide screens, "Open in <system>" links in new tabs.
- **Mobile** (390x844 frame): thumbs, swipes, haptics, the lock screen, Live Activities, 30-second
  glances, one hand, flaky network. In v1 the phone surface is chat; the mobile page is the future
  native or installed app. Show, somewhere in the mobile page or its notes, how one decision looks
  as **one chat message**.

## 7. How to build

Folder: `docs/design/intake-directions/<folder>/{desktop,web,mobile}/intake.html`. Keep the
`/web/` and `/mobile/` path segments: `crew.js` reads them. Page skeleton (paths from a page):

```html
<!doctype html>
<html lang="en" data-theme="whitehaven">
  <head>
    <script src="../../../shared/page.js"></script>
    <link rel="stylesheet" href="../../../crew-bureau-2/tokens.css" />
    <link rel="stylesheet" href="../../../crew-bureau-2/system.css" />
    <link rel="stylesheet" href="../intake.css" />  <!-- the direction's own components, if any -->
    <meta charset="utf-8" />
    <title>Intake · Hercule</title>
  </head>
  <body>
    ...
    <script src="../../../crew-bureau-2/brands.js"></script>
    <script src="../../../crew-bureau-2/crew.js"></script>
  </body>
</html>
```

- **Never edit** anything under `crew-bureau-2/` or `shared/`. A component your direction needs
  goes in `<folder>/intake.css` (shared by its three pages), named for what it is, and must not
  restyle or duplicate a `system.css` class.
- **States** come from `?state=`: `page.js` sets `<html data-state>`. Default = today; `swarm` = 10x;
  plus the special state your direction names. Hide with CSS, e.g.
  `html:not([data-state="swarm"]) .swarm-only { display: none }`.
- **The page never scrolls** at its frame size (1440x900, 1280x800, 390x844): inner panes scroll.
- **No requests leave the machine**: no CDNs, no web fonts beyond `crew-bureau-2/fonts`.
- **No text inside `<i>`**; `<i>` is not for emphasis here.
- **Interaction is welcome but not required.** A small inline script may make keys or swipes work
  (e.g. answering moves to the next decision). Keep it short, and keep every state reachable by URL.
- **Check by eye**, from `docs/design`:
  `node shared/shoot.mjs intake-directions/<folder>/desktop/intake.html?theme=light /tmp/<folder>/desktop-light.png`
  (add `--w 1280 --h 800` for web, `--w 390 --h 844 --scale 2` for mobile; `?theme=dark`,
  `?state=swarm`). It prints page errors. Look at every shot. Fix misaligned buttons, clipped
  text, overflow, box-in-box, and anything that glows.
- **Count**: `node shared/count-intake.mjs intake-directions/<folder>/desktop/intake.html <w> <h>`
  prints buttons and words in view. Report the numbers for each page's default state.

## 8. The three directions

### A. Deck - `deck/`

**Lever: speed per decision.** Intake becomes a deck of complete decisions, dealt one at a time.
Each card holds everything needed to decide (what, why, made from, what each answer does), so Rogier
answers with one key or one swipe and the next card slides in. A morning is "9 decisions, about
2 minutes", and the deck tells him when he is done.

Main elements:

- **The deck strip**: "9 decisions · about 2 min", one pip per decision in order (burning first,
  then needs a call, then the rest), pips filled as they are answered; last triage on the right.
- **The decision card** (the one card in focus): kind and topic, title, one-line gist, made-from
  marks with counts, the answer ledger (label · describe line · fine print · key). The card is the
  whole decision; Space opens the evidence (the dossier drawer: excerpts, "Open in <system>").
- **Up next**: the next two cards peek below or behind, titles only.
- **Batches**: alike decisions arrive as one card ("4 dependency bumps", and at 10x "Accept the 22
  low-priority proposals in Releases") with **Split** to deal them one by one.
- **Moving**: a narrow strip of what the answers just started (the run, its working face, "Undo"
  for 5 seconds: the client holds the answer before sending it).
- **The quiet shelf**: FYI, attached, handled quietly, new Connections; folded, never a card.
- **The clear state**: "Nothing waits on you. Next triage at 11:00." with what moved this morning.
- **Keys**: ↩ primary answer, 1-4 a numbered answer, J/K next and previous, Space evidence, U undo,
  ? help.

Platforms:

- **Desktop**: keyboard first; the deck also lives in a global hotkey panel over any app (show it
  as a panel state or in the notes); the menu bar shows "4 decisions".
- **Web**: every card has its own URL (`/intake/d/<id>`); the tab title reads "(9) Intake"; the
  evidence opens beside the card on wide screens, not as a permanent split.
- **Mobile**: a swipe deck with answers in the thumb zone (right = primary, left = Dismiss, up =
  evidence, the full ledger always visible as buttons too), haptics, a Live Activity "4 decisions
  · about 1 min". One card maps one-to-one to one chat message.

States: default, `swarm` (60 proposals dealt as about 14 cards because triage batches alike
ones), `clear` (the deck is done).

Must not become: a list (only one card has full detail at a time) or The Line (no pipeline board).

### B. The Line - `line/`

**Lever: visible consequence.** Intake becomes the head of a production line. Signals come in on
the left, Rogier's calls sit in the middle, and the work they set moving travels right until it
ships. Every answer visibly moves a piece of work down the line, so Rogier sees momentum and
trusts that answering is worth it.

Main elements:

- **Came in**: one tap per Connection with its count since 18:20 (a plugin's new Connection
  appears as a new tap: "Linear, listening"); the tripped breaker is a closed **valve** on the
  GitHub tap with 34 held.
- **Your call**: the open decisions, tiered (Now, Needs a call, Today, When you can), compact,
  with aligned answers.
- **Moving**: the runs and sessions the earlier answers started, with their working faces; a run
  that needs Rogier (Ship release v2.15) bounces back into Your call in marigold.
- **Shipped**: what reached the world since 18:20, each with a trace back to the events it came
  from ("2 Intercom conversations + 1 Sentry error → #1287 merged, 4h 50m").
- **The flow meter**: 212 in → 9 for you → 4 moving → 3 shipped, and the median lead time.
- **Topic lanes**: the line can be split into one swimlane per topic.
- **Motion**: when one event arrives, one dot travels its tap once. Nothing moves when nothing
  happens. In the prototype, keep the default still.

This direction pulls forward the post-v1 question "merge Intake and Check-in into one spine". Say
so on the page's notes, and say what it costs. It echoes the event-flow idea Rogier liked in the
round-1 Metro design, but stays calm: stages, not a network map; no colored lines per source.

Platforms:

- **Desktop**: a wide board (stages as columns, topics as optional lanes); drag a decision onto
  a workflow to start it (as a gesture beside the buttons, never instead of them).
- **Web**: the same line on a big screen; each shipped item's trace has its own URL.
- **Mobile**: a vertical line (top = came in, bottom = shipped), your calls expanded, the rest
  collapsed to counts; a Live Activity follows one run.

States: default, `swarm` (cells become counts and piles; the meter carries the story), `trace`
(one shipped item's trace from source events to merged pull request, opened in the drawer or a
sheet).

Must not become: a kanban of tasks (the stages are about flow, not task status) or a monitoring
wall.

### C. Standing Orders - `orders/`

**Lever: fewer decisions.** Every answer Rogier gives can become a standing order, so the next time
the same kind of thing comes in, it is done for him and reported afterwards. Intake shrinks to the
exceptions: the things no order covers, the things only he can judge, and the orders that need
attention.

A standing order **is a user-written start Trigger** (Event Selector: event kind, Connection,
filter; or a Schedule) on a workflow, with inputs and a Spawn Bound. The UI may call it a
"standing order" (the direction's name); the editor and the describe line must say what it is
underneath ("Adds a start trigger to **Draft reply**: on **gmail.message.received** from **Gmail ·
rogier@personal** where the sender is a customer and the subject mentions an invoice, at most
**10 per day**"). Never call it a "rule". An order can only start a workflow; it never runs a
bindable family the spec forbids (credentials, secrets, infrastructure, permissions, Connection
management, bulk deletes).

Main elements:

- **While you were away**: what standing orders did since 18:20, grouped by order, with counts and
  a "Review" and an "Undo where possible" per group.
- **Needs you**: the exceptions, few and full-size: the burning Proposal, the two Needs a call,
  the run waiting on you, and whatever no order covers. Each answer offers **Always do this** to
  turn the answer into an order (a sheet with the Event Selector filled in, a match preview "would
  have matched 31 events last week", and the Spawn Bound).
- **Orders**: the shelf of standing orders with fires this week, last fire, overrides, the Spawn
  Bound; a paused order (Label new issues, bound tripped) is flagged.
- **Leverage**: "38 handled for you · 9 by you" this week.
- **Triage notes** (post-v1 feedback learning, labelled as later): "Stop proposing PostHog dips
  under 5%".
- **A new source**: the Linear Connection gets suggested starter orders.

Invent the orders and their overnight results, within these limits: no order may cover anything
that is still an open decision in CONTENT.md (otherwise it would already be handled); the
existing "Label new issues" trigger is one of them; "Draft reply to Jonas at Kiteworks" may be
the work of an order. Keep counts consistent across the three pages.

Platforms:

- **Desktop**: exceptions in the main column, the orders shelf beside it; "Always do this" opens a
  floating editor.
- **Web**: the order editor with its match preview is the web page's strength (wide, shareable,
  "here is what this would have done").
- **Mobile**: the morning digest of what orders did, then the exceptions; "Make it standing" as a
  bottom sheet.

States: default, `swarm` (still about 6 to 9 exceptions: that is the thesis; the digest grows,
not the decisions), `make` (the "Always do this" editor open on the Offer "Merge 4 dependency
bumps", with its match preview).

Must not become: a settings page (orders are shown by what they did, not by their config) or
Deck (decisions are not dealt one at a time).

## 9. What to hand back

1. The three pages, each with its states, light and dark, checked by eye.
2. `<folder>/NOTES.md`, short and in plain words:
   - the states and their URLs,
   - the components the direction adds (class name, what it is, which `system.css` parts it
     reuses),
   - each place the design departs from the spec, an ADR or the pinned Intake semantics, and why,
   - what each animation costs on desktop,
   - how one decision renders as one chat message,
   - the counts (buttons and words in view) for each default page.
3. A short report of anything in this brief you found wrong or had to guess.
