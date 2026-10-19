# Stay in the loop - the shared brief for four prototypes

PROTOTYPE. This brief is the shared input for four design directions. Each direction is an
interactive desktop prototype drawn in Crew Bureau 2, with its own design brief and a story. The
book (`index.html` beside this file) compares them and recommends one.

## 1. The problem, in Rogier's words

> When I hand an Intake signal off to an agent, there is zero follow-up. I have to check on
> everything by hand. Even though I handed the work off, I'm still curious about the result and
> want to stay in the loop.

Questions to play with (examples, not limits):

- How do I find out the agent is done? What was its result?
- What if I'm not happy with the result? (Redo with feedback, take over, undo.)
- Is something truly "done" if I haven't seen the result? There is a state between "the agent
  finished" and "I have seen it and accept it".
- In-flight visibility, confidence, interruption cost, batching, trust over time, provenance
  back to the signal it came from.

## 2. Why the gap exists (read this, it is the heart of the problem)

The spec does this on purpose today, and every direction must say how it changes it:

- **Hand to an agent** is an answer on a Signal. It binds `run.start` of a workflow that takes
  the signal as input (spec 10 §9.4). It **resolves the signal at the click**, as `decided`, with
  the outcome line "Handed to *workflow*".
- **A signal leaves To do the moment the user makes their move, and never waits for the work
  behind it to finish** (spec 10 §9.6). So the moment Rogier hands work off, it vanishes from
  Intake.
- What remains: the **Done** view shows the run's state beside "Handed to Fix bug", read-only
  (spec 17 §Views, §The pane). **A failed run never puts the signal back on To do**; its
  `core.run-failed` Notification goes to **Check-in**, and Check-in is **post-v1 on desktop**.
- Mid-run questions (a Request such as "Run git push?") show in the sidebar's
  **Waiting on you**, under "From runs" for runs (spec 17 §"From runs").
- The result itself lives in the run: its page in Workflows (`/workflows/<id>/runs/<id>`), its
  output, and its step sessions' transcripts.

**The status quo, concretely.** Rogier presses "Hand to Draft reply" on Marta's mail. The toast
says "Handed to Draft reply" and the row leaves. Twenty minutes later he wonders. He opens Intake
› Done, finds the row, sees "running" or "completed" in small type, opens Workflows › Draft reply
› the run, opens the step's thread, scrolls the transcript to find the draft, then opens Gmail to
see if it is really in Drafts. If it failed, nothing told him. If he dislikes the draft, there is
no "redo with this note": he starts a new thread and explains everything again. Five handoffs a
morning means five of these hunts.

Contradicting the spec is allowed here; doing it silently is not. Each direction's brief has a
section **"What changes in the spec"**: which rule it bends, why, and what it costs.

## 3. Shared vocabulary for the lifecycle

All four directions model the same lifecycle. A direction may label states differently in its UI,
but its brief must map its words to these:

| State | Meaning | How it reads (no new state marks: the six are `working`, `waiting`, `done`, `failed`, `paused`, `idle`) |
|---|---|---|
| **Handed** | the click on Hand to an agent; the signal leaves To do | (moment, not a lasting state) |
| **Working** | the run is live | `working` mark / working face |
| **Needs you** | the run waits on a Request (an approval or a question) mid-way | `waiting` mark, marigold (`--you`) |
| **Landed** | the run finished; Rogier has not looked yet | `done` mark plus a small marigold "unseen" dot: it waits on you |
| **Seen** | opened, no verdict yet | `done` mark, no dot |
| **Signed off** | Rogier accepts the result; terminal | quiet, `--ok` check at most |
| **Sent back** | redo with Rogier's note; starts attempt 2, back to Working | |
| **Taken over** | Rogier continues in the run's thread himself | |
| **Undone** | the outward effect is reverted where it can be (close the PR, delete the draft) | |
| **Failed** | the run failed | `failed` mark, tomato (`--fail`) |

Words to keep out of the UI: "follow-up" (CONTEXT.md reserves it), "inbox", "dashboard",
"command center", "outcome" for anything but a resolved signal's line, "Done" for anything but
the core's Done answer (that is why the accepted state is **Signed off**). "Handoff" is fine in
prose and in the UI.

## 4. Fixtures: one morning, used by all four

"Now" when a page opens: **Tuesday 29 September 2026, 09:41**. The user is **Rogier** (avatar "R").
Projects webshop, payments-api, ops. The world is `../shared/CONTENT.md`; the signals come from the
Intake drawing (`../intake-directions/asks/`). Use these names, numbers and wording; you may add
small details that fit, never contradict them, and keep numbers consistent within your pages.

Workflows that take signals: **Review PR**, **Fix bug**, **Draft reply**, **Investigate**.
Machines: studio-mac, build-box-1, build-box-2. Each colleague's face: `data-face="<workflow
name>"` (crew.js casts Fix bug, Draft reply, Investigate; Review PR gets a hashed look) or the
thread's title for a thread.

### The seven handoffs of this morning

**H1 · Review PR · Landed, unseen**
- Signal: GitHub · Review requested · **Marta** · "Retry Stripe webhooks with backoff" ·
  rogier/payments-api **#1294** · `feat/webhook-backoff` → `main`, 4 files +112 −18, 3 commits,
  18 checks passed.
- Handed **09:12** to **Review PR** (Claude Code · Sonnet 5 · build-box-2). Ran 7m 40s. Landed
  **09:20**.
- Result: a **draft review, not posted**. Verdict: **Approve, with 2 comments**.
  - `src/webhooks/retry.ts:42` - "The 30-minute cap is hard-coded. Stripe retries for 3 days;
    read `WEBHOOK_RETRY_CAP_MS` so ops can raise it."
  - `src/webhooks/retry.test.ts` - "No test covers the jitter. A seeded random would make
    `computeDelay` testable."
  - Summary: "Exponential backoff with full jitter, base 2s, cap 30m. Idempotency keys survive
    retries, so a retry never double-books a payout. Safe to merge once the cap is configurable."
  - Confidence **high**: "Read all 4 files and ran the tests: 18 passed."
- Next actions: **Post review** (`github/pr.review`) - "Posts an approving review with **2
  comments** on **#1294** in **rogier/payments-api** as **GitHub · rogier**" · **Edit first** ·
  **Send back** · **Discard draft**.

**H2 · Fix bug · Seen, no verdict** (opened 09:33, then Rogier got distracted)
- Signal: Slack · Tagged in a thread · **Pieter** · "Codes with a trailing space are rejected" ·
  #acceptance · 08:58: "@rogier codes with a trailing space are rejected now. "SUMMER10 " fails,
  and it worked before. Customers paste them from emails."
- Handed **09:05** to **Fix bug** (Claude Code · Opus 5.5 · studio-mac). Ran 22m. Landed **09:27**.
- Result: draft pull request **#1302 "Trim discount codes before lookup"** in rogier/webshop,
  `fix/trim-discount-codes`, 2 files **+14 −3**, 26 checks passed.
  - Cause: **#1287** "Discount codes ignore letter case" (merged yesterday 19:12, signed off by
    Rogier) replaced `code.trim()` with `code.toLowerCase()` in `normalizeCode`.
  - Fix: `return code.trim().toLowerCase();` plus a test with `"SUMMER10 "`.
  - Also drafted, not sent, a Slack reply to Pieter: "Fixed in #1302. It reaches acceptance with
    the next deploy."
  - Confidence **high**: reproduced with a failing test first.
- Next actions: **Merge #1302** (`github/pr.merge`) - "Squash-merges **#1302** into **main** in
  **rogier/webshop** as **GitHub · rogier**" · **Send the reply to Pieter** (`slack/message.reply`)
  · **Send back** · **Close the PR**.
- Provenance hook worth showing: this regression came from #1287, which Rogier signed off
  yesterday.

**H3 · Draft reply · Landed, unseen - and Rogier is not happy with it** (the redo showcase)
- Signal: Gmail · Mail · **Marta Visser** (Brightline) · "Invoice INV-2291 in the company name" ·
  08:41: "Hi Rogier, could you reissue INV-2291 in the company name instead of mine? Our finance
  team needs it for the books. Thanks, Marta"
- Handed **09:20** to **Draft reply** (Claude Code · Haiku 4.5 · build-box-2). Ran 2m 10s. Landed
  **09:22**.
- Attempt 1, saved in Gmail Drafts:

  > Dear Ms. Visser,
  >
  > Thank you for reaching out regarding invoice INV-2291. We would be happy to accommodate your
  > request. Please find the reissued invoice made out to Brightline Ltd attached to this email.
  >
  > Should you have any further questions, please do not hesitate to contact us.
  >
  > Kind regards,
  > Rogier Pennink
  > Acme

  Attachment: `INV-2291.pdf` (the original, still in Marta's name).
  Confidence **medium**, and the agent says why: "I couldn't find Brightline's legal name in
  earlier mail, so I guessed 'Ltd'. I attached the existing invoice; I can't create invoices."
- What is wrong: the legal name is **Brightline B.V.**; the tone is stiff (they are on
  first-name terms); the attachment is the old invoice.
- Rogier sends it back with: "It's Brightline B.V. (KvK 81234567). First names, short. Reissue it
  as INV-2291-R in Stripe and attach that."
- Attempt 2 asks mid-run (**Needs you**): "Void **INV-2291** and create **INV-2291-R** for
  **Brightline B.V.** in **Stripe · live**?" - Allow once · Deny. After Allow, it lands:

  > Hi Marta,
  >
  > Done: attached is INV-2291-R, made out to Brightline B.V. (KvK 81234567). I voided the
  > original INV-2291, so your finance team can book this one.
  >
  > Best,
  > Rogier

  Attachment: `INV-2291-R.pdf`. Confidence **high**.
- Next actions: **Send reply** (`gmail/message.reply`) - "Sends the reply to **Marta Visser**
  from **Gmail · rogier@personal** with **INV-2291-R.pdf**" · **Edit first** · **Send back** ·
  **Discard draft**.

**H4 · Investigate · Working at 09:41, lands during the demo**
- Signal: Linear · Question for you · **Jonas** (Kiteworks) · "Refunds for partial captures" ·
  **PAY-212**: "Can we refund a partially captured payment? We captured €80 of a €120
  authorisation and the refund call fails."
- Handed **09:33** to **Investigate** (Codex · gpt-5.4 · build-box-1).
- Live steps, as the agent's own short notes:
  1. 09:33 Read PAY-212 and its 3 comments
  2. 09:35 Searched payments-api for partial captures: 6 places
  3. 09:37 Read `src/refunds/refund.ts`
  4. 09:39 Ran `pnpm test refunds`: 31 passed
  5. 09:41 Writing a failing test for a refund after a partial capture… (in progress)
- Landed result (findings): "Yes, Stripe allows it. `createRefund` defaults `amount` to
  `payment.amountAuthorized` when no amount is given. For a partial capture that is €120, more than
  the €80 captured, so Stripe returns `amount_too_large`. Passing an explicit amount works today;
  the fix is one line at `src/refunds/refund.ts:88`."
  Confidence **high** for the cause (reproduced with a failing test); "I did not call Stripe's
  test mode."
- Next actions: **Reply on PAY-212** (`linear/comment.create`) - "Posts the answer on **PAY-212**
  as **Linear · rogier**" · **Hand to Fix bug** · **Send back**.

**H5 · Fix bug · Failed** (09:26, the case nobody tells him about today)
- Signal: GitHub · Checks failed on your PR · **GitHub Actions** · "Show VAT per line on
  invoices" · rogier/webshop **#1300** · `test (ubuntu)` failed: `invoice.snap.ts › renders VAT
  per line: Snapshot mismatch: "29-09-2026 00:00" vs "28-09-2026 22:00"`.
- Handed **09:08** to **Fix bug** (Claude Code · Sonnet 5 · build-box-1). **Failed 09:26** after
  18m: "Gave up after 3 tries. The snapshot differs only on CI: the runner's time zone is UTC and
  the test formats dates in local time. Pinning the zone needs a change to
  `.github/workflows/test.yml`, which this run may not edit."
- Partial work: branch `fix/invoice-snapshot-tz`, 1 commit, not pushed.
- Next: **Try again with a note** (e.g. "You may edit .github/workflows/test.yml") · **Take over** ·
  **Let it go**.

**H6 · Thread · Needs you** (the burning one)
- Signal: Sentry · Alert assigned to you (Now) · "Checkout fails for EU cards with 3-D Secure" ·
  webshop-prod · 412 events, 188 users.
- Handed **09:02** to the thread **Fix 3-D Secure checkout for EU cards** (Claude Code · Opus 5.5
  · studio-mac). 3 changed files **+48 −12**, 24 tests passed.
- **Needs you since 09:31**: "Run `git push -u origin fix/3ds-eu-cards`?" - Allow once · Always
  allow git push · Deny.

**H7 · Investigate · Working, lands late in the demo**
- Triage's proposal "Nightly backup job timing out on ops-db", accepted 09:05; Rogier started
  **Investigate** at **09:35** on the new Task (Codex · gpt-5.4 · build-box-1).
- Live: "pg_dump of `events` (41 GB) takes 1h 52m; the job's limit is 2h."
- Lands: "Dump `events` in parallel with `--jobs 4`: 38m on a copy. Or drop the 90-day-old
  partitions the sweep already ignores." Confidence medium: "Measured on a copy, not on ops-db."

### History and trust (for directions that use it)

- Signed off yesterday: **Discount codes ignore letter case** (#1287 merged 19:12; Fix bug ran
  22m) and **Reply sent to Pieter at Bakkerij Smit** (18:44; Draft reply ran 2m).
- Last 30 days: **Review PR** 14 of 14 signed off as they came; **Draft reply** 17 of 20 (2 sent
  back, 1 taken over); **Fix bug** 9 of 12 (2 sent back, 1 failed); **Investigate** 6 of 6.

### At 10x (`?state=swarm`)

140 live sessions, 60 proposals a morning. Today: **38 handoffs**: 9 landed unseen, 14 working, 2
need you, 3 failed, 10 signed off. Show how your design holds **without a longer list**
(grouping, bundling, batching).

### Empty (`?state=empty`)

Nothing handed off today. Say so in one calm line and show what would appear here.

## 5. Simulated time

Each prototype runs a small simulation so the reviewer sees things happen:

- At load the page shows 09:41 as above. H4 lands about 12 seconds in, H7 about 40 seconds in.
- **Send back** on H3 runs attempt 2: about 4s working, then Needs you (the Stripe question);
  after Allow, about 6s working, then it lands.
- **Try again with a note** on H5: about 10s working, then it lands: a commit pushed to #1300, checks
  re-run and pass.
- A small **prototype bar** (fixed, bottom right, clearly not part of the product, hidden by
  `?bar=off`) holds: the simulated clock, play/pause, "Next event" (jumps the simulation to the
  next landing), Reset, a state picker, and a light/dark switch (`whitehaven` / `orient-express`).
- Every state is reachable by URL: `?state=` with at least `empty`, `swarm`, and the special
  states your direction names (for example `redo` with the send-back composer open). `?theme=`
  works through `shared/page.js`.

## 6. Rogier's rules (hard)

- **No large italic headers.** No italics for display type at all.
- **Not text-heavy.** Text belongs to content (a draft, a finding), not to chrome. Prefer a number,
  a mark or a face over a sentence.
- **No heavy box-in-box.** One level of containment (`.card`). Inside, separate with space and
  hairlines.
- **Answers line up.** Buttons in a list sit in the same columns from row to row. Use the ledger
  (`.ans`: label · describe line · key) wherever an answer does something outward; the describe
  line says what the click does, written by the core, with live names in ink.
- **No mono in the UI.** Recursive is for code, diffs, branch names and commands only.
- **At most six state marks.** `working`, `waiting`, `done`, `failed`, `paused`, `idle`. Invent no
  new ones.
- **Nothing glows.** No halos, no colored washes. At most one small pulsing dot, justified.
- **Color = who.** A colleague's hue is its identity, never a state. Marigold `--you` = waits on
  Rogier, never a button fill. Lacquer `--accent` = the one suggested button per group. Tomato
  `--fail` = hurt. `--ok` = passed/added.
- **Plain words.** No em or en dashes anywhere, in UI or in docs (use "-"). Never: hydra,
  agentick, inbox, dashboard, persona, lorem ipsum, "rule" for a trigger.
- **Proposing is not doing** (ADR 0022). An agent prepares; Rogier's click authorises anything
  outward (posting, merging, sending). Anything that acts without a click must be something
  Rogier set up himself, and the UI says so.
- **Desktop performance** (spec 17 §Performance): nothing animates unless something is happening;
  only the `working` pose loops; animate `transform` and `opacity` only; each motion at most
  `--dur-3` per step (a celebration may run longer once). Your brief says what each animation
  costs.
- **Pixel perfection.** Spacing on the 4px grid, aligned columns, no clipped text, no overflow,
  every state checked in light and dark.

## 7. The design system: Crew Bureau 2

Link it; do not fork it. Read `../crew-bureau-2/tokens.css`, `../crew-bureau-2/system.css` (all of
it) and `../crew-bureau-2/crew.js`, and look at `../crew-bureau-2/desktop/*.html` and
`../intake-directions/asks/` (the Intake screen the app is built from) before drawing.

- Faces: `<i data-face="Draft reply" data-pose="working" data-size="28"></i>`; the user
  `<i data-you></i>`; marks `<i data-mark="waiting"></i>`; icons `<i data-i="clock"></i>`; brands
  `<i data-brand="github"></i>` (github, gmail, sentry, slack, linear, stripe, posthog, intercom,
  grafana, discord, anthropic, claude, openai, pagerduty, datadog, googlecalendar; plus `cron`,
  `pi`, `web`). Content you add after load: call `Crew.drawPlaceholders(el)`, or build markup with
  `Crew.face(name, {pose, size})`, `Crew.mark(state)`, `Crew.icon(name)`, `Crew.brand(name)`.
- The desktop shell: `<div class="app"><aside data-side="intake"></aside><main class="main">…</main></div>`
  draws the real sidebar. `data-side` picks the selected row (`intake`, `office`, `workflows`, a
  thread key). The page sets `<html data-intake-count="N">` to change the Intake count.
- Parts: `.card`, `.btn` (`--accent`, `--quiet`, `--danger`, `--sm`, `--lg`), `.ans` ledger,
  `.chip` (`--you`, `--fail`, `--ok`, `--who`), `.src`, `.tabs`/`.tab`, `.seg`, `.section-h`,
  `kbd`, `.pop` (glass popover), `.deco-num` (Limelight numerals), `.icon-btn`, toasts, dialogs.
  Glass only on floating layers.
- **New tokens** go at the top of your own CSS file, each with a one-line comment saying why. List
  them in your brief. Never edit anything under `crew-bureau-2/`, `shared/` or
  `intake-directions/`.

## 8. Where things go

```
docs/design/stay-in-the-loop/
  BRIEF.md                 this file
  index.html               the book (written by the lead designer)
  <slug>/index.html        your prototype, 1440x900 desktop; the page never scrolls, inner panes do
  <slug>/<slug>.css        your components and new tokens
  <slug>/<slug>.js         your interaction and simulation
  <slug>/BRIEF.md          your design brief (section 9)
  <slug>/STORY.md          your story (section 9)
  <slug>/*.html            any extra pages your direction needs (keep it to what earns its place)
```

Page skeleton (paths from `<slug>/index.html`):

```html
<!doctype html>
<html lang="en" data-theme="whitehaven">
  <head>
    <script src="../../shared/page.js"></script>
    <link rel="stylesheet" href="../../crew-bureau-2/tokens.css" />
    <link rel="stylesheet" href="../../crew-bureau-2/system.css" />
    <link rel="stylesheet" href="<slug>.css" />
    <meta charset="utf-8" />
    <title>… · Hercule</title>
  </head>
  <body>
    …
    <script src="../../crew-bureau-2/brands.js"></script>
    <script src="../../crew-bureau-2/crew.js"></script>
    <script src="<slug>.js"></script>
  </body>
</html>
```

No requests leave the machine: no CDNs, no web fonts beyond `crew-bureau-2/fonts`. Plain HTML,
CSS and JS, no build step. No `<i>` with text in it.

## 9. What each direction hands back

1. **The prototype**, interactive, with the simulation, the redo flow (send back with a note, see
   attempt 2), the failed case, the needs-you case, empty and swarm states, keyboard flow, light
   and dark. Checked by eye at 1440x900 in both themes.
2. **`BRIEF.md`**, plain words, short sections:
   - Problem framing (one paragraph, in this direction's terms) and the **lever** in one sentence.
   - Principles (3 to 5).
   - Who and when (the moments in Rogier's day it serves).
   - Key interactions, with keys.
   - States: empty, working, needs you, landed, seen, signed off, sent back, failed, swarm. Map to
     section 3.
   - What it deliberately does **not** do.
   - What changes in the spec (the rules it bends, why, the cost).
   - New design tokens, each with why.
   - Motion and what each animation costs on desktop.
   - Effort to build for real: what is new in the core, client-core, and the renderer; a rough
     size (S, M, L, XL) and the riskiest part.
   - URLs of the states.
3. **`STORY.md`**: a short narrative walk-through of Rogier's real day (Tuesday 29 September,
   from about 09:00 to the evening), 400 to 700 words, concrete, showing why this beats the
   status quo of section 2. Show, don't sell: times, names, what he clicked, what he did not have
   to do. End with one line on what it would feel like after a month.
