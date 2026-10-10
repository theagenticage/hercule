# Intake, direction D: Asks

> **Superseded 2026-10-10 ([#395](https://github.com/theagenticage/hercule/issues/395)).** These notes
> are kept as history. The model they led to is written in
> [spec 10 §9](../../../spec/10-triage-intake-and-notifications.md#9-signals), the desktop screen in
> [spec 17 §Intake](../../../spec/17-desktop-app.md#intake), and the decision in
> [ADR 0040](../../../adr/0040-intake-holds-signals-notifications-are-hercules-own-messages.md). Where
> these notes disagree with those documents, the documents win: an "ask" is now a **Signal**, and a
> signal is its own record, not a Notification.

Intake is the running list of what other people and systems ask of you, and you work through it
all day. Someone requests your review, mentions you with a question, tags you in a thread about
something you merged: each of these is one item, and each can be answered from where it sits,
often with a reply. Triage still runs, at most hourly, and its findings sit under the asks and
read quieter. Every kind of ask comes from a plugin, so two people with different plugins see two
different Intakes.

The goal is inbox zero. Four views sit over the same records: **To do** (what waits on you),
**Later** (what you snoozed), **Done** (what left the list, and how), and **Everything** (every
event your sources sent, with what came of it).

Only the desktop page is built. The first three directions (Deck, The Line, Standing Orders) assumed Intake is
triage only; this one does not.

## Open it

Paths are relative to this folder. `?theme=` works as on every Crew Bureau page.

| URL | What it shows |
|---|---|
| `desktop/intake.html` | Rogier, with Sentry, GitHub, Linear and Slack. 1 burning item, 5 asks, 3 triage findings. The Slack thread is open |
| `desktop/intake.html?user=noor` | Noor, with PagerDuty, Gmail, Google Calendar, GitHub and Intercom. 1 page, 4 asks, 2 triage findings. The calendar invitation is open |
| `...?mode=later`, `done`, `everything` | Opens a view other than To do |
| `...?filter=<source>` or `triage` | Opens a tab: `github`, `slack`, `gmail` and so on. The tabs filter all four views |
| `...?mode=everything&stamp=stopped` | The threads you stopped, above the events they stopped |
| `...?list=empty` | Inbox zero: every To do item already answered |
| `...?pane=closed` | The list at full width, with no item open beside it |
| `...?ask=<id>` | Opens one record, in the view it lives in. Rogier: `alert`, `changes`, `review`, `checks`, `linear`, `slack`, `backup`, `deps`, `android`; Later `l-1296`, `l-pay219`; Done `d-1293`, `d-pay209`, `d-flaky`, `d-releases`, `d-1282`, `d-pay200`, `d-1286`, `d-tokens`, `d-1288`. Noor: `page`, `email`, `invite`, `deploy`, `intercom`, `webhooks`, `cert`; Later `n-offsite`, `n-contract`; Done `n-call`, `n-refund`, `n-sync`, `n-disk`, `n-deploy`, `n-board`, `n-infra88`. An event is `ev-<ask id>` for the event that raised an ask |
| `...?state=xray` | Labels every part with who provides it: blue for a plugin, violet for the core. `⇧X` toggles it |
| `...?bar=off` | Hides the prototype switcher, for screenshots |

Keys:

- `J` and `K` move. `X` checks the row, and `⇧J` and `⇧K` check the rows on the way.
- `↩` opens the item when the pane is closed, and takes the suggested answer when it is open.
- `R` opens the reply, `⌘↩` sends it. `E` marks done. `H` opens the snooze menu, then `1` to `5`
  picks when. `U` unsnoozes. `M` stops asking. `O` opens the item on its own system. With rows
  checked, `E`, `H` and `U` act on all of them.
- `Esc` lets go of one thing at a time: the snooze menu, then the checks, then the pane.
- `⇧X` toggles the labels.

Every change offers Undo.

Known limit: the sidebar is shared with every Crew Bureau page, so Noor's page still shows
Rogier's threads and name there.

## What an ask is

An **ask** is a decision Notification that a plugin raises straight from one of its own events,
when that event says a person or a system wants something from you. No agent reads it first: the
rule is in the plugin's code and it fires at once.

Example: GitHub's Notifications feed reports `review_requested` for `rogier` on payments-api
#1294. The GitHub plugin's ask kind `github/review-requested` matches it. The core creates one
decision Notification with Marta as the asker, the change and the description as its body, and
Approve, Comment, Review with an agent and Done as its answers. When Rogier approves on GitHub
instead, the next poll sees his review and the ask leaves Intake.

An ask is not a new record. It is a Notification with a plugin's kind, a body made of blocks, and
Bound Actions as answers. That keeps the rule from spec 01: "If the Intake surface ever forces a
new core concept, that is a design smell to escalate, not a feature to add."

| | Ask | Triage finding | Agent request |
|---|---|---|---|
| Raised by | a plugin, from one event, at once | triage, from a batch of events, at most hourly | an agent in a session |
| Shown in | Intake, under Asks (or Now) | Intake, under From triage | Check-in |
| Example | Marta requests your review | 3 nights of backup timeouts become a Proposal | "Run git push?" |
| Leaves when | it is answered here or on its own system | you answer it | the agent gets its answer |

## The page

- **The bar.** One tab per plugin that has something open, with its mark and count, then
  Triage. A plugin with nothing open has no tab. On the right, when triage last ran and when it
  runs next.
- **Now.** Only while something burns: an alert assigned to you, a page while you are on call.
  It is pinned above the asks with a red dot and states what is being done about it
  ("Fixing in a thread", "Escalates at 11:23").
- **Asks.** Oldest first. Each row: the system's mark, the title, then who asked, the kind of ask
  and where. On the right, the age, and a marigold "waiting" when a person is blocked on you.
- **From triage.** The same rows, quieter, with how many events the last batch read.
- **Back from a snooze.** An ask whose snooze ran out goes to the top of its section with
  "Back" in marigold, and its open item says when you snoozed it.
- **The foot.** "7 cleared today. 3 of them left on their own: answered elsewhere or withdrawn.
  See Done." The number goes up as you answer.
- **Inbox zero.** When To do is empty, the list itself shows it, and the pane closes: a brass
  sunburst behind Hercule, "Inbox zero", "Nothing waits on you. The rest of the morning is
  yours.", how many you cleared today in the big number face, and one quiet pill per source
  with its count (each opens Done on that tab). Last, when the list fills again: "2 snoozed,
  back today 14:00 and Monday 09:00 · triage runs at 12:00". It celebrates when you reach it or
  open the page on it: the rays draw outward, Hercule springs in, the words rise. Switching back
  to To do shows it at once.
- **The open item.** Kind, place and "Open on GitHub"; the title; who asked and when; the blocks;
  the answers as a ledger; when the item leaves your list; which plugin raised it and from which
  event; the keys.

When the suggested answer is a reply (the Linear question, the Slack thread, the email), its
composer is open at the top of the answers, ready to type in. A reply further down the ledger
turns into its composer when clicked.

### Working the list

The list works like a mail inbox: the common moves happen on the row, the details in the pane.
None of it shows at rest, so the list reads exactly as it did.

- **Row controls.** Point at a row, or tab into it, and two quiet icons cover its age at the
  right end: Snooze (Unsnooze in Later) and Done. A triage finding gets only Snooze, because it
  has no Done: it needs its own answer. A Now item and a row in Done get none. The icons sit on
  the row's own fill, so the text under them fades out instead of showing through. Stop asking
  and the plugin's answers never appear on a row: they need their describe line.
- **Checks.** Pointing at a row also shows a checkbox over its mark. `X`, `⌘`-click and
  `⇧`-click check rows, as in Mail and Finder. Checked rows keep the selected fill.
- **The bulk bar.** While rows are checked, a bar takes the toast's place: "3 selected · Snooze
  `H` · Done `E` · ×". It offers Snooze and Done only (Unsnooze in Later), never an answer: an
  answer is about one ask. Done shows when at least one checked row has it; triage findings stay
  ("Marked 1 done. Kept 2 from triage"), and the button's tooltip says so beforehand.
- **The pane closes.** The button at the right end of the bar, or `Esc`, closes it; `↩` or a
  click on a row opens it. Closed, the list takes the full width, with rows capped at 960px so a
  row still reads as one line. Everything gains the most: its long event titles fit whole. The
  page still opens with the pane open.
- **Motion.** The pane slides by its own width while the list grows on the same curve, so the
  two edges meet at every frame. A row that leaves fades out where it was (120ms), then the rows
  below slide up into its place (320ms, ease-out). A row that comes back with Undo fades in once
  the others have made room. A new toast rises once the list has settled; a toast already there
  moves with the list and changes its words in place. Reaching inbox zero, the last row and the
  toast fade out together, the pane closes, and the toast rises again under the zero once the list
  has finished widening. Only a change to the list on screen moves:
  switching views, tabs or the search redraws at once. With reduced motion, nothing moves.

### Later, Done and Everything

- **Later** lists what you snoozed, by when it comes back ("Back today", "Back Monday"). A
  snoozed ask stays open: if Marta's review request is answered on GitHub while it is snoozed,
  it goes straight to Done. Unsnooze puts it back on To do now.
- **Done** lists what left your list, newest first, each with how: "Approved #1293", "Handed to
  Fix bug", "Answered in Linear", "Withdrawn". The open item shows the outcome in place of the
  answers, with the reply you sent and the resolution as the core stores it: "Resolution
  `decided` by `user` from `web`". There is no "put it back": a resolved Notification is final
  (ADR 0027), and Undo covers a slip.
- **Everything** is every event your sources sent, newest first, each with its stamp and what
  it led to: "→ ask · on your To do list", "→ Nightly backup job timing out on ops-db ·
  proposal", "no action · Not yours, and nobody asked you". Opening an event shows its body,
  what came of it, and a way to the ask or Proposal it led to. Every ask links back to its event
  with "See the event". A search field and a stamp menu narrow the list; a source tab narrows it
  to that source.

The tabs are the sources with ask kinds, then Triage. A source that only feeds triage (Grafana,
Cron and Intercom for Rogier; Stripe and Cron for Noor) has no tab: its events show under All
and Triage.

### Snooze

`H` opens a menu above the Snooze row: In 1 hour, This afternoon, Tomorrow, Monday, Pick a
time. It is only for you. The ask stays open, its system is not told, and nothing about the
Notification changes. Now items cannot be snoozed: they burn.

### Stop asking (delayed until much later)

Rogier: delayed until much later, but kept in the design so the shape is known.

Stop asking says "asks about this thread stop here, unless someone names you". It is offered
only on an ask about a thread: a pull request, a Slack thread, a Linear issue, an email thread.
Not on a page, an invitation, a deployment approval or a triage finding.

- **Keyed on the thread ref**, the one the plugin already declares: `github:pr:rogier/webshop#1298`,
  `slack:thread:C05K2ACC9/1790931120.441900`, `linear:issue:PAY-212`.
- **Blocks only the kinds that do not name you.** `slack/group-mentioned`,
  `github/team-review-requested` and `github/checks-failed` stop. `slack/mentioned`,
  `github/review-requested`, `github/changes-requested` (it is your pull request),
  `linear/mentioned` and `intercom/assigned` still get through: when someone names you, you hear
  it. The plugin declares which of its kinds name you.
- **Keeps its dates.** A stop has `since`, and `until` once you choose Ask me again, so the events
  it stopped stay stamped "stopped" after it ends.
- **Tells nobody.** Slack still notifies you; the describe line says so: "Stops asks about
  **#frontend · Dark mode tokens** here, unless someone names you. Slack still notifies you".
- **Takes the ask off your list too**, as Done would. The stopped threads are listed above the
  stopped events in Everything, each with Ask me again.

## What a plugin contributes

Ask kinds are a new facet of the **event source** contribution, not a fifth extension point. The
plugin that ingests the events is the one that knows what in them is an ask. Spec 05 allows new
contribution facets to be added without a breaking change.

| Facet | What the plugin declares | Rogier's example | Noor's example |
|---|---|---|---|
| Ask kind | An id, a label, and the rule that turns one of its events into an ask | `github/review-requested`, "Review request", from `github.notification` with reason `review_requested` | `calendar/invited`, "Invitation", from `calendar.event.invited` with your answer still open |
| You | The shape of an identity on that system, so "mentions you" can be checked. The user records the value, as with a Platform Identity today | `rogier` on GitHub, `@rogier` in Slack | `noor@acme.dev`, `noor-d` on GitHub |
| Who, what, where | The asker, the title, the place, and the refs the core matches against your work | Marta · "Retry Stripe webhooks…" · payments-api #1294 | Sanne · "Q4 roadmap review" · Tuesday 14:00 |
| Urgency | Whether the kind burns (Now), and whether a person is blocked (waiting) | A Sentry alert rule that names you burns | A PagerDuty page while on call burns, with its escalation time |
| Blocks | Which blocks to fill, and with what | `change` and `words` for a review request | `when` for an invitation |
| Answers | Its own actions as answers, which one is suggested, and which workflows to offer | Approve (`github/pr.review`), Comment… | Accept (`calendar/event.respond`), Decline… with a note |
| Leaves when | The event on its own system that answers the ask | A review by you on #1294 | Your answer to the invitation |
| Mark | The system's monochrome mark, for the tab and the rows | GitHub, Linear, Slack, Sentry | PagerDuty, Gmail, Calendar, Intercom |

The same GitHub plugin raises different asks for the two of them: review requests, changes
requested and failed checks for Rogier; deployment approvals for Noor, who protects the
production environment. What a person sees follows from the plugins they installed and from who
they are on each system.

### Blocks: the core draws them, the plugin fills them

A plugin never ships markup. It picks from a fixed palette and fills it with data, so every
plugin's ask looks like it belongs, and the desktop app, the web app and a chat message can each
draw the same body their own way.

| Block | Filled by | Shows | Used in |
|---|---|---|---|
| `words` | plugin | One message, with who and when | PR description, Linear question, email |
| `thread` | plugin | Several messages. The one that mentions you has a marigold rule | Slack thread, review comments, Intercom |
| `change` | plugin | Files, `+` and `−`, the branches or tags, the checks | Review request, deployment approval |
| `checks` | plugin | One row per check, with the log excerpt under a failed one | Failed checks on your PR |
| `when` | plugin | The hours around an event, with what else is on and any overlap | Calendar invitation |
| `signal` | plugin | One big number and what it counts | Sentry alert, PagerDuty page |
| `fields` | plugin | A few facts in a row | Linear status and cycle, incident and escalation |
| Your work | core | The Task or thread the ask is about, matched by refs | The Slack thread links to #1287, the Sentry alert to the thread fixing it |
| Note | core | One line about what triage added to an open item | The Sentry alert |
| Gist and sources | core | What triage wrote, and the events it used | Every triage finding |

### Answers

| Shape | What a click does | Example | Provided by |
|---|---|---|---|
| Act | Runs one plugin action with frozen input | Approve, Re-run, Acknowledge, Accept, Merge 4 | plugin action |
| Reply | Runs one plugin action with one typed field | Reply in the thread, Comment…, Decline… with a note | plugin action |
| Hand to an agent | Starts a workflow with the ask as its input (`run.start`) | Start "Fix bug", Start "Review PR", Start "Draft reply" | core |
| Done | Takes it off your list. The other system is not told | Done | core |
| Snooze | Hides it until a time you pick. Not an answer: the ask stays open | Snooze… | core, yours only |
| Stop asking | Takes it off your list and stops asks about its thread that do not name you | Stop asking | core, yours only (delayed) |
| Open | Goes to the item on its own system. Not an answer | Open on GitHub | plugin (the URL) |

The core writes every describe line from the frozen operation, as today: "Approves pull request
**#1294** in **rogier/payments-api** as **rogier**". The plugin does not write it. Each item
has at most one suggested answer, in the accent color. Triage's Unsure has none: its choices are
equal. Snooze and Stop asking sit in a second, quieter ledger under the answers, because they
are about you, not about the ask.

## Triage on this page

Triage runs at most hourly and acts on a batch, so by the time it runs, anything that burns has
usually been on the list for a while. It never raises such a thing again. When its batch touches
an open item, the item says so in one line: "Triage at 11:00 added 38 events and 3 customer
emails to this. It did not raise it again." This builds on triage's first duty, which already
sets aside events whose refs an open Task carries (spec 10 §2.2).

Its findings (Proposal, Offer, Unsure) keep their answers from spec 10 and sit under the asks,
quieter: regular weight, dimmed marks, the Triage face in the header of the open item.

## Departures

### In the spec, but not built yet

This design depends on them.

- **The `notifications` capability** (spec 05 §5 and §11, spec 10 §7.2): how a plugin creates
  a Notification at all.
- **The reasons in `github.notification`** (spec 08 §5.1, `review_requested`, `mention`, `assign`):
  the event the GitHub asks start from.
- **The fast lane** (spec 10, Post-v1): an event trigger for mentions and assignments.
  Asks replace it: they need no workflow, because no agent step is involved.
- **Plugin actions as answers** (spec 16 §A, open: "No plugin action is on the list of operations
  an answer may run"). Every Act and Reply answer here is a plugin action.

### Needs a spec change

- **Intake's definition.** CONTEXT.md defines Intake as triaged signals "before they spawn tasks
  or reach the user", and spec 10 §8 lists Intake's members by Notification kind, all from triage
  or the core. Asks are neither. This is Rogier's call; CONTEXT.md is not edited here.
- **Typed text as an answer.** Spec 10 §7.4: "Free-text answers are not a button: the user opens
  the session and types." A Reply answer is one plugin action with one typed field. The core
  still writes its describe line, so the user still sees exactly what the click does.
- **Plugin kinds that resolve when answered elsewhere.** Spec 10 §7.7 has only the core resolve
  its own kinds. ADR 0027 states the principle ("wherever"), so this extends it rather than
  breaks it: the plugin declares the event that answers its ask.
- **Who you are on each system.** No Connection field holds it (spec 08 §8). Spec 12 §4.1
  already records a Platform Identity on the user, for chat platforms only. Widening it to every
  system (GitHub login, Linear user, email address) would cover this.
- **Marks shipped by plugins.** The design language fixes the set of system marks (GitHub,
  Gmail, Sentry, Tailscale, Hetzner, Dependabot, cron, Hercule). Linear, Slack, PagerDuty,
  Calendar and Intercom need one each.
- **Two spellings for one kind.** An ask kind is a contribution, so ADR 0034 names it
  `github/review-requested`. A Notification kind is dotted (`triage.proposal`). The Notification
  an ask raises must carry one of the two; spec 10 §7.1 or ADR 0034 has to say which.
- **Snooze.** Spec 10 §7.1 has no snooze, and §7.7 says notifications have "no expiry concept".
  Snooze is a per-user fact beside the Notification ("hidden until 14:00"), modelled like a mute
  (§7.2): the record does not change, so resolution stays the only way off the list for good.
  §7.1 or §7.2 needs a line for it, and a core operation with its CLI row (spec 11 §6.3).
- **The stop list.** A new per-user record (thread ref, since, until), two core operations (stop,
  and ask again) with their CLI rows, and a rule in the core that drops an ask whose kind does
  not name you when its thread ref is stopped. Ask kinds need a "names you" flag.
- **Two new stamps.** Spec 10 §3 stamps events by what they led to, first match wins. Asks add
  "→ ask" and "stopped", and both go first: an event that raised an ask, or hit a stopped
  thread, never reaches triage.
- **Searching events.** The events API has no text filter. Everything's search needs one.

- **Row controls on hover.** The design language (#50) says a decision's answers have "nothing
  behind hover". Snooze and Done on a row show only on hover or focus, and the row's Done drops
  its describe line ("Takes it off your list. Linear is not told") to a tooltip. They are core
  operations every ask has, each with its key, and the ledger in the pane stays the full path
  with every describe line. Rogier's call: allow it with a "list rows excepted" line in the
  design language, or keep the list free of controls.

### Agreed amendments

Both contradicted a rule; Rogier chose to change the rule.

- **ADR 0023 allows a Slack event source.** The ADR says "Chat messages are conversation input,
  not events". Slack stays a channel, and a Slack event source beside it raises asks from
  threads that mention you. ADR 0023 needs the amendment.
- **The design language allows the split.** It says "Detail lives in a drawer, never a page or
  a permanent split". Rogier: the split is right here, it will be used more (a thread beside its
  files and diffs), and drawers may go away altogether. The design language needs the
  amendment.

## Open questions

1. **Waiting on others.** Should Intake also show what you are waiting for, such as your own PR
   that nobody has reviewed yet? It is the other half of a to-do list, but it is not an ask.
2. **Work an agent does before you look.** A drafted reply or a first review, ready when you open
   the item. Spec 10 §8 says Intake reads Tasks, Notifications and Events, never run outputs, so
   this needs a rule for where the draft lives.
3. **Agent requests.** They stay in Check-in. Should Intake show a one-line pointer to them, or
   is the sidebar's "Waiting on you" enough?
4. **Bulk in v1.** Row controls cost little and save a trip to the pane for the two most common
   moves. Bulk is a bigger surface: three ways to check, a bar, mixed selections. Asks leave on
   their own when answered elsewhere, so the list rarely grows long enough to need it.
   Recommendation: row controls in v1, bulk after it, when real lists show it is needed.
5. **How far back Everything goes.** It reads the events the controller keeps. If events are
   pruned, Done keeps its records longer than Everything keeps their events, and "See the event"
   needs a state for an event that is gone.

Settled: no cross-item warnings. The core does not tie one ask to another (Noor's deployment
approval no longer warns about the open page on the same service); people keep that picture
themselves.
