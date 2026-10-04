# Intake, direction B: The Line

Intake is the head of a production line. Four stages read left to right on desktop and web, top to
bottom on the phone: **Came in** (one tap per Connection) → **Your call** (the open decisions) →
**Moving** (the runs earlier answers started) → **Shipped** (what reached the world, each with a
trace back to its events). The flow meter at the top of the stages holds the counts:
212 in → 9 for you → 4 moving → 3 shipped.

## States and URLs

Paths are relative to this folder. Every state works with `?theme=dark` added.

| URL | What it shows |
|---|---|
| `desktop/intake.html` | Today, 09:41. The line, with the lead decision open |
| `desktop/intake.html?state=swarm` | 10x. The line split into topic lanes; each lane's decisions become a pile of counts |
| `desktop/intake.html?state=trace` | The trace of "Discount codes ignore letter case" in the right-hand drawer |
| `desktop/intake.html#triage-summary` | The triage's one-paragraph summary, opened from the bar |
| `web/intake.html` (same three states and the hash) | The same line under the web bar. The trace drawer shows its own URL: `/intake?since=2026-09-28T18:20&trace=task-dc41` |
| `mobile/intake.html` (same three states and the hash) | The vertical line. `?state=trace` is a sheet; in `?state=swarm` the piles sit at `#piles` |

## Components

All of these live in `intake.css`. None of them restyles a system.css class on its own. A few
rules place a system part inside a component (for example `.bound-action > .btn` fills its
column). Three rules touch `.m-ans` itself, and all three are listed under Departures:
`.m-ans:disabled` adds a missing state, and `.m-ans span b` / `.m-ans span code` keep the names in
a describe line at the line's size (system.css draws any `b` in an answer at 15px).

| Class | What it is | system.css parts reused |
|---|---|---|
| `.triage-status`, `.triage-summary` | The last triage in the bar (face, time, next run) and its summary panel, opened by `#triage-summary` | `.glass`, `.btn--sm`, Triage face |
| `.line`, `.line-stage`, `.flow-stage`, `.flow-arrow`, `.deco-num` | The four stages as one grid; each head is a count and a word, with an arrow on the rule between stages | `.section-h`, display numerals |
| `.taps`, `.tap`, `.tap-pipe`, `.tap-dot`, `.tap--listening`, `.tap--held`, `.valve` | Came in: one tap per Connection with its count. A new Connection has a dashed pipe ("listening"). A tripped breaker is a closed valve with the paused mark | brand marks, `data-mark="paused"` |
| `.src-x` | The fallback mark for a system with no brand mark (Hetzner), copied verbatim from the brief | none |
| `.receipt-rows`, `.receipt-row`, `.receipt-item` | What triage made of the 212 events, read down the stage; every count opens its events | `.section-h`, `.count` |
| `.tier-h`, `.attention-pulse` | A tier label (Now, Back from the line, Needs a call, Today, When you can), and the page's one pulsing dot | `.section-h`, `.count`, `.dot--fail` |
| `.decision`, `.decision--lead`, `.decision--back`, `.decision-meta`, `.made-from` | One decision: head, meta, answers. The lead is the only card. A run's request back from the line has a marigold left rule | `.card`, `.chip`, `.bars`, `.proj` |
| `.bound-action`, `.bound-action--opens`, `.producer-description`, `.unanswered-note` | The answer ledger: one row per answer, the row is the button; label column 176px wide (fits "Resume and discard the 34"), then the describe line, then fine print. Covers all four states: core, plugin, navigation only (external icon, "Opens ..."), cannot be taken (disabled) | `.btn`, `.btn--accent`, `.btn--quiet`, `.btn--sm` |
| `.drag-handle`, `.workflow-dock` | Desktop only: drag a decision onto a workflow at the foot of Moving to start it. Beside the buttons, never instead of them | faces |
| `.line-run`, `.line-run-attached` | A run in Moving: face, name, workflow and time, and the events attached this morning | faces, brand marks, `.you-ink` |
| `.shipped-item`, `.trace-line` | A shipped item and its trace in one line: source marks with counts → lead time | brand marks |
| `.trace-drawer`, `.lead-time`, `.lead-time-split`, `.trace-span`, `.trace-step` | The trace: lead time split by stage (four segments that add up to 4h 50m), then one row per step from the first Intercom message to the merge | `.glass`, `.icon-btn`, `kbd` |
| `.topic-lanes`, `.topic-lane`, `.lane-taps`, `.pile`, `.pile-counts`, `.decision--pile` | Swarm: one row per topic under the same stage columns. A pile is a topic's decisions as counts by tier at fixed x, and "Open all N" | `.btn--sm`, faces |
| `.flow-meter` | Phone: the meter as four counts in a row, each a link to its stage | display numerals |
| `.vstage`, `.vstage-h`, `.taps--inline` | Phone: one stage, its heading row, and taps wrapped as mark and count | `.count` |
| `.vdecision`, `.vdecision--back`, `.made-from--inline`, `.m-ans-icon` | Phone: a decision with big answers. `.m-ans-icon` boxes an answer's icon at 32px, the width of a face, so every label starts at the same x | `.m-answers`, `.m-ans`, `.m-ans--accent`, `.m-ans--quiet` |
| `.vdecision-row`, `.pile-total` | Phone: a decision (or a swarm pile) as one row that opens it | brand marks, `.bars` |
| `.live-activity`, `.island-activity`, `.face-stack` | Phone: the Live Activity following one run along the four stages, its compact form in the Dynamic Island, and the other runs as stacked faces | `.card`, faces |
| `.trace-sheet`, `.sheet-scrim` | Phone: the trace as a sheet at the large detent over a dimmed page | `.sheet` |

## Departures

**Departs from the pinned Intake semantics ("separate views"), spec 10 §Post-v1, spec 14 §The Intake
view and spec 01 §V1 scope: out of scope, because the direction merges Intake and Check-in into one spine.** The
brief asks for this. What it costs:

- **Intake reads run records.** Spec 10 §8: "Intake reads Tasks, Notifications and Events - never
  run outputs". Moving needs run state, Shipped needs a merged pull request or a sent reply, and the
  trace needs a time for every step from event to merge. No record holds the trace today; it would
  be derived by joining Events, the Task, the Notification's answer, the run, and the pull request.
- **Approvals enter Intake.** "Publish payments-api 2.15.0 to npm?" is raised by the core for a
  running session. Today it belongs to Check-in; here it comes "back from the line".
- **One marker instead of two.** `lastChecked.intake` and `lastChecked.checkin` would collapse
  into one, or the page would show two different "since" times.
- **The line shows only work that went through Intake.** It shows 4 of the 16 live sessions.
  The other 12 (for example, sessions started by hand in a thread) still need Check-in, so a full
  merge must decide where they go.

**Departs from the pinned semantics in five smaller places:**

- Came in sits first, on the left, not at the foot of the page. The line reads from source to
  outcome.
- One pulsing dot, on the Now label only. The pinned semantics put one on the label, the burning
  card and its topic tab; the brief allows at most one.
- Other decisions show their answers in place instead of condensed rows (desktop and web). The
  lever is "answering moves work", and the brief asks for aligned answers. On the phone they are
  condensed rows.
- The lead card has no proactive note ("I can also draft a reply ...") and no "Open the full
  picture" link: the title opens the dossier in the same drawer as the trace (not drawn).
- The last triage is in the bar, not a line closing the page, because it sits beside "Triage now".

**Departs from spec 10 §7.4 (Bound actions):**

- **Navigation-only answers** ("Review first", "Edit the trigger") have no place in the stored
  bound action. It would need a `url` field and a kind that the core describes as "Opens ...".
- **Plugin actions** ("Merge all 4", `github/pr.merge`) and **`trigger.resume`** are shown as
  bindable. The amendment of 2026-09-28 says neither is bindable yet (#85, #87).
- **Describe lines are in the third person** ("Starts **Fix bug** ..."), as the brief writes them.
  The built describer (`apps/controller/src/daemon/notifications/describer.ts`) writes the
  imperative ("Start a run of Fix bug with ...").
- **"Allow once"**, as CONTENT.md and Crew Bureau 2 label it. The contract's label is "Allow"
  (`packages/contract/src/approval-answers.ts`). Only Allow once and Deny are shown, not all four
  approval answers.

**Departs from the brief:**

- The Unsure answer **"Both"** is dropped. A Task has at most one project, so "Both" cannot be one
  `task.update`.
- **Swarm topic counts** count every decision in the topic, not only proposals. The brief's
  numbers (Checkout 19, Infrastructure 14, Customers 17, Releases 7) are the proposals; they appear
  as the tier counts in each pile (now + today + when you can). The tabs read 27 / 19 / 28 / 15
  (plus 5 in no topic = 94 = 90 for you + 4 back from the line), and each "Open all N" matches its
  tab. Today's tabs read 3 / 2 / 3 / 1 the same way, with the breaker in no topic.
  On the phone the lead sits in Now above the piles, so the piles leave it out: Checkout reads 26
  ("2 more burning") and "By topic" reads 93, one less than the desktop's 27 and 94.
- **Chat buttons carry the label only**, not "label · describe line": the pairs go in the message
  body, because chat buttons cut long text. See "One decision as one chat message".

**Departs from Crew Bureau 2:**

- `.m-ans` has no disabled state, so `intake.css` adds one for "Close all 9": the label and icon
  dim; the "Cannot be taken: ..." line stays readable.
- In a describe line inside `.m-ans`, names are `b` and `code`, which system.css draws at the
  answer label's 15px. `intake.css` keeps them at the line's 12px, in ink, as the desktop ledger does.
- The desktop sidebar's "Waiting on you" list is drawn by `crew.js`. It shows "Fix 3-D Secure
  checkout · Run git push?", although the brief sets the page before that thread was started. The
  page cannot change it without editing `crew-bureau-2/`.

**Phone-only choices:**

- Only Now, Back from the line and Needs a call show answers in place. Today and When you can are
  rows that open the decision, because of the thumb budget and because a describe line may never be
  cut short.
- Made from is one line of marks and facts, without Connection names; the decision view names them.
- The held note is shortened to "GitHub: 34 held".

## Animation cost on desktop

The desktop page sets `data-motion="off"`, so the prototype is fully still.

| Animation | Built as | Cost |
|---|---|---|
| Now dot | Drawn still on desktop. Spec 17 rule 2 allows one continuous animation, the working face beside a running turn, and Intake has no open thread | none |
| Working faces in Moving | Drawn still on desktop, for the same rule | none |
| Tap dot (one event arrives) | One 6px HTML span, `transform` and `opacity`, 320ms, once per event; off with Reduce motion | Compositor only: about 20 frames at 60 Hz per event. Today that is one event every 4 minutes. At 10x it is about 22 a minute, so the build should show at most one dot per tap every 2 seconds, and none while the window is hidden. Not measured; record it in spec 17 §Performance before building |
| Answer row hover | `background` transition, `--dur-1`, on a user action | paint only, once |
| Trace drawer and triage summary | `.glass`, only while open | spec 17's measurement: glass at 0.4 vs 0 adds about 3 GPU and 3 renderer wakeups a second |

On web and mobile the Now dot pulses (`opacity`, 2.4s, infinite) and working faces type.

## One decision as one chat message

The lead decision in Slack, at 09:41:

```
Now · webshop · Checkout · first seen 08:52
Checkout fails for EU cards with 3-D Secure
Since deploy #1289, card payments that need 3-D Secure fail at checkout for EU customers.
Made from: Sentry 412 errors, 188 users · Gmail 3 customer emails · PostHog -18% conversion, EU only · GitHub deploy #1289

Start Fix bug · Starts Fix bug on webshop with task Checkout fails for EU cards with 3-D Secure
    Claude Code · Opus 5.5 · studio-mac
Accept · Removes label proposed from Task Checkout fails for EU cards with 3-D Secure
    This is work; it stays in the backlog.
Dismiss · Sets status to cancelled on Task Checkout fails for EU cards with 3-D Secure

[ Start Fix bug ]  [ Accept ]  [ Dismiss ]        Open in Hercule →
```

The "label · describe line" pairs go in the message body, and the buttons carry the label only.
Discord limits a button label to 80 characters and Slack to 75, and the first pair here is 94
characters, so "label · describe line" on the button itself would be cut short.

When it is answered anywhere, every copy is edited to:

```
Checkout fails for EU cards with 3-D Secure
✓ Start Fix bug - decided on the desktop · now Moving: Fix bug on webshop →
```

On the phone app, the run an answer starts can be followed as a Live Activity, as the mockup does
for "Cart total rounding on discounts".

## Counts (default state)

Measured with `docs/design/shared/count-intake.mjs`; "in view" leaves out what an inner pane has scrolled away.

| Page | Buttons in view | Words in view | Buttons / words on the page | Decisions answerable without scrolling |
|---|---|---|---|---|
| Desktop 1440x900 | 9 | 407 | 43 / 842 | 2 of 10: the lead and the approval |
| Web 1280x800 | 8 | 362 | 44 / 833 | 2 of 10 |
| Mobile 390x844 | 4 | 135 | 15 / 496 | 1: the lead, all three answers in the thumb zone |

Compared with the brief's baseline (desktop 13 buttons and 348 words in view, 3 of 9 answerable;
phone 3 buttons and 133 words), the line shows fewer buttons but more words: Came in, Moving and
Shipped take the room that more answers would. The receipt keeps its words low: "3 FYI" is one row
that opens its events, and the one example under a count is the Hetzner event, which shows the
fallback mark (its full text, "invoice for September, via Gmail", is in the events list).

## Guesses

- The trace of #1287: the Intercom and Sentry times (14:22, 14:40, 14:51), triage at 15:00, the
  answer at 18:21, the pull request at 18:43. They add up to the brief's 4h 50m.
- The lead time of payments-api v2.14.0 is 9m, the length of its Ship release run; the brief gives
  no event for it.
- The timeline of the reply to Pieter is reduced to its total, 1h 05m.
- The swarm numbers beyond the brief: taps (Sentry 1,300, GitHub 380, Gmail 170, Stripe 120,
  Intercom 90), 40 moving, 3 paused, 30 shipped, the per-topic piles, and the medians.
