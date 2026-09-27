# Fixture content - identical in every design

PROTOTYPE. Every design shows this same world, so Rogier compares designs, not content. Use the
names, numbers and wording below. You may add small details that fit (a timestamp, a file, a line
of transcript), but never contradict these facts, and keep numbers consistent across your pages.

"Now" is **Tuesday 29 September 2026, 09:41**. The user is **Rogier** (avatar: initial "R").

## The world

**Projects** (each has a color in your system if your doctrine uses project color):

| Project | Repo | What it is |
|---|---|---|
| webshop | github.com/rogier/webshop | the storefront and checkout |
| payments-api | github.com/rogier/payments-api | the payment service behind checkout |
| ops | github.com/rogier/ops | infrastructure, backups, certs |

**Runners (machines)** - the Fleet:

| Runner | Kind | State | Capacity |
|---|---|---|---|
| studio-mac | Rogier's desktop, local | online | 5 of 6 sessions |
| build-box-1 | Linux server | online | 8 of 8 - at cap |
| build-box-2 | Linux server | online | 3 of 8 |

**Providers**: Claude Code (Anthropic account "rogier@personal", models Opus 5.5, Sonnet 5, Haiku
4.5), Codex (OpenAI account "work", models gpt-5.4, gpt-5.4-mini), pi (local, model "qwen3-coder
30b" via llama.cpp on studio-mac).

**Connections** (event sources and channels), with their volume over the last 24h:

| Connection | Kind | Default Topic | 24h events | Health |
|---|---|---|---|---|
| GitHub · rogier | event source | Releases | 312 | healthy |
| Gmail · rogier@personal | event source | Customers | 188 | healthy |
| Sentry · webshop-prod | event source | Checkout | 1,406 | healthy |
| PostHog · webshop | event source | Checkout | 96 | healthy |
| Intercom · support | event source | Customers | 61 | healthy |
| Grafana · ops | event source | Infrastructure | 44 | healthy |
| Stripe · live | event source | Checkout | 209 | healthy |
| Cron · schedules | event source | - | 102 | healthy |
| Slack · acme-hq | channel | - | - | healthy |
| Discord · community | channel | - | - | reconnecting (since 09:12) |
| Web chat | channel (built in) | - | - | healthy |

Totals: **2,418 events in 24h**. Since Rogier last checked (yesterday 18:20): **212 events**.

**Topics**: All · Checkout · Infrastructure · Customers · Releases (plus "Manage topics").

**Workflows**: Fix bug · Draft reply · Investigate · Label new issues · Ship release · Nightly
backup check.

## Intake (as of 09:41)

Last triage **09:00** (took 42s), next **11:00**. Since you last checked: 212 events.

Headline counts: **1 burning · 6 proposals · 2 need a call · 3 FYI · 198 handled quietly**.

Receipt line: `212 events → 6 proposals · 1 attached · 2 offers · 3 FYI · 2 unsure · 198 no action`.

### Now (burning)

**Lead proposal - "Checkout fails for EU cards with 3-D Secure"** · Topic Checkout · priority
urgent (4 of 4 bars) · project webshop · first seen 08:52.

- Made from:
  - Sentry · webshop-prod - `PaymentError: authentication_required` - 412 events, 188 users
  - Gmail · rogier@personal - 3 customer emails ("Card declined at checkout", "Can't pay with my
    Rabobank card", "Payment keeps failing")
  - PostHog · webshop - checkout conversion **-18% since 14:10 yesterday** (EU only)
  - GitHub · rogier/webshop - deploy **#1289** at 14:02 yesterday ("Upgrade Stripe SDK to v14")
- Gist: *Since deploy #1289, card payments that need 3-D Secure fail at checkout for EU customers.
  The new Stripe SDK returns `requires_action`, and `handlePaymentResult` treats it as a failure.*
- Suggested: **Start "Fix bug"** on webshop (Claude Code · Opus 5.5 · studio-mac).
- Answers (the ledger): **Start "Fix bug"** - "Starts Fix bug on webshop in a new worktree" ·
  **Accept** - "Adds it to the backlog as a Task" · **Dismiss** - "Closes the Proposal".
- Proactive note: "I can also draft a reply to the 3 customers once the fix ships."

### Needs a call (triage could not decide)

1. **Unsure - "App is slow on Android"** · Intercom · support · 7 conversations since Sunday ·
   "I can't tell which project this belongs to." Answers: **webshop** · **payments-api** ·
   **Both** · **Not work**.
2. **Breaker tripped - "Label new issues" held 34 events** · GitHub · rogier · the workflow's Spawn
   Bound (20 per hour) tripped at 08:14 after a bot opened 34 issues. Answers: **Keep held** ·
   **Release all 34** · **Raise bound to 50/h**.

### Today

3. **Proposal - "Nightly backup job timing out on ops-db"** · Grafana · ops + Cron · priority high
   (3 bars) · Topic Infrastructure · "3 nights in a row; the job hits its 2h limit at 04:00." ·
   suggested → **Start "Investigate"**.
4. **Offer - "Draft a reply to Marta at Brightline"** · Gmail · Customers · "Asks for invoice
   INV-2291 in the company name, not hers." Answers: **Draft reply** · **Not now**.
5. **Proposal - "Stripe webhook retries rising"** · Stripe · live + Sentry · priority medium (2
   bars) · payments-api · suggested → **Start "Investigate"**.
6. **Offer - "Merge 4 dependency bumps"** · GitHub · rogier · "All green, patch versions only."
   Answers: **Merge all 4** · **Review first**.

### When you can

7. **Proposal - "SSL certificate for status.acme.dev expires in 12 days"** · Cron · schedules ·
   ops · priority low (1 bar) · suggested → **Start "Fix bug"**.
8. **Proposal - "Add iDEAL as a payment method"** · Intercom · support (5 requests) · webshop ·
   priority low · suggested → **Accept**.

Attached (1): 2 new Sentry events attached to the existing Task "Cart total rounding on
discounts".

### FYI (3)

- Release **v2.14.0** of payments-api was published (GitHub).
- PostHog: sign-ups up **+9%** week over week.
- Stripe: payout of **€18,240** arrives Thursday.

### What came in (since yesterday 18:20)

| Connection | Events | Became |
|---|---|---|
| Sentry · webshop-prod | 131 | 1 proposal, 1 attached |
| GitHub · rogier | 38 | 1 offer, 34 held |
| Gmail · rogier@personal | 17 | 1 proposal, 1 offer |
| Stripe · live | 12 | 1 proposal, 1 FYI |
| Intercom · support | 9 | 1 unsure, 1 proposal |
| PostHog · webshop | 3 | part of the lead proposal, 1 FYI |
| Grafana · ops | 2 | 1 proposal |

Event stamps (for a per-connection event list): → task · offer · FYI · unsure · known · held ·
pending triage · no action.

### At 10x (for your scale story)

140 live sessions across 9 runners, 31,000 events a day, 60 proposals a morning, 14 workflows,
4 assistants. Show how your design holds, never with a longer list.

## Sessions right now

23 live sessions: **8 working · 3 waiting on Rogier · 12 idle**. Runners: studio-mac 5,
build-box-1 8 (at cap), build-box-2 3. Use these in lists, the office and the menu bar:

| Session | Kind | Project | State | Detail |
|---|---|---|---|---|
| Fix 3-D Secure checkout for EU cards | Thread | webshop | **waiting on you** - approve `git push` | Claude Code · Opus 5.5 · studio-mac |
| Investigate backup timeouts | Run (Investigate) | ops | working 6m | Codex · gpt-5.4 · build-box-1 |
| Label new issues | Run | webshop | paused - bound tripped | build-box-1 |
| Refactor cart totals | Thread | webshop | working 22m | Claude Code · Sonnet 5 · build-box-1 |
| Add iDEAL research | Thread | payments-api | idle 1h | Codex · gpt-5.4 · build-box-2 |
| Webhook retry backoff | Run (Fix bug) | payments-api | working 3m | Claude Code · Opus 5.5 · build-box-1 |
| Migrate ops dashboards | Thread | ops | **waiting on you** - question "Keep the old Grafana folder?" | pi · qwen3-coder · studio-mac |
| Ship release v2.15 | Run (Ship release) | payments-api | **waiting on you** - approval "Publish to npm" | build-box-2 |
| Ada | Assistant | - | working (heartbeat) | Claude Code · Sonnet 5 |
| Milo | Assistant | - | idle | Slack #ops |
| Juno | Assistant | - | asleep | Discord (reconnecting) |

## The active session (Session page)

Title: **Fix 3-D Secure checkout for EU cards** · project **webshop** · Thread · started 09:02 from
the lead Proposal (link back to it) · branch `fix/3ds-eu-cards` from `main` · workspace: its own
worktree · machine **studio-mac** · provider **Claude Code** · account rogier@personal · model
**Opus 5.5** · effort high · access mode **auto-accept edits**. Sibling threads in this workspace:
"Refactor cart totals".

Transcript (compress or extend, but keep the substance):

1. **Rogier** (09:02): "Checkout fails for EU cards that need 3-D Secure since deploy #1289. Find
   the cause and fix it. Add a test that reproduces it first."
2. Divider: **Worked for 2m 14s ›** (collapsed tool calls: read 6 files, ran 1 command).
3. **Agent**: "Found it. Since Stripe SDK v14, `confirmPayment` returns `status:
   'requires_action'` for cards that need 3-D Secure. `handlePaymentResult` in
   `src/checkout/payment.ts` only handles `succeeded` and treats everything else as a failure, so we
   show "Card declined" instead of opening the 3-D Secure modal." Followed by a short code block:

   ```ts
   if (result.status === "requires_action") {
     return openThreeDSModal(result.clientSecret);
   }
   ```

4. **Agent**: "I wrote a failing test first, then the fix." Divider **Worked for 4m 51s ›**.
5. Changed-files card: **3 changed files +48 -12** · `src/checkout/payment.ts +21 -9` ·
   `src/checkout/payment.test.ts +19 -0` · `src/checkout/3ds-modal.tsx +8 -3` · Show files · Open
   diff. Test result: **✓ 24 passed** (`pnpm test checkout`).
6. **Agent**: "Tests pass. Ready to push the branch and open a pull request."
7. **Request (permission dock on the composer)**: "Run `git push -u origin fix/3ds-eu-cards`?" -
   answers **Allow once** · **Always allow git push** · **Deny**. The dock sits on top of the
   composer card like a lip (see spec 14).
8. Queued Input row: "Also check the Apple Pay path" · queued · runs next · Steer · Cancel.

The session is **waiting on you** (the Request). Earlier turns can scroll off the top.

Empty state (session-empty, a Draft Thread): project **webshop**, heading "What should the agent do
in webshop?", one line: "It gets its own worktree of webshop, on a new branch from main." Composer
empty with placeholder "Say what you want done…", model pill Claude Code · Opus 5.5, access mode
auto-accept edits, lip: `New worktree · from main · studio-mac`. Offer a few starting points drawn
from real context (e.g. from Intake: "Fix: Checkout fails for EU cards", "Investigate: Stripe
webhook retries") without turning it into a text wall.

## Assistants

| Assistant | Role | Presence | Channels | Provider |
|---|---|---|---|---|
| **Ada** | personal assistant | working (heartbeat at 09:00) | Web chat, Slack DM | Claude Code · Sonnet 5 |
| **Milo** | ops assistant | idle | Slack #ops | Codex · gpt-5.4 |
| **Juno** | support assistant | asleep (idle unload) | Discord #support (reconnecting) | Claude Code · Haiku 4.5 |

**Ada's Conversation** (Assistant page), recent:

- 07:00, 08:00: heartbeat turns that found nothing ("NO_REPLY") - shown collapsed, e.g. "2 quiet
  check-ins".
- 09:00 heartbeat, Ada: "Morning Rogier. Triage found one urgent thing: EU card payments that need
  3-D Secure have failed since yesterday's deploy. You started a fix at 09:02; it's waiting on your
  OK to push. Also: Marta at Brightline wants her invoice in the company name - I can draft that."
- Rogier (09:20): "Remind me Friday to renew the SSL cert for ops."
- Ada: "Done. Reminder set for Friday 2 October, 09:00: renew the SSL cert for ops." (a Reminder
  chip/card)
- A **Notice** (yesterday 22:14, system line, not Ada's voice): "Ada was interrupted: her turn
  failed: provider timeout after 120s. Your last message was kept." (Notices come in two kinds:
  "interrupted" and "can't be reached".)
- Rogier (09:38): "What's the status of the backup job?"
- Ada (working, streaming): "Milo started an investigation at 09:35 on build-box-1. So far: the
  backup job's `pg_dump` has been slower each night since the table `events` passed 40 GB…"

Ada's record (settings-assistants): name Ada · personal assistant · Claude Code · Sonnet 5 ·
access mode full access · disallowed tools: edit · reply mode: turn-end (alternative: segments) ·
Heartbeat: every 1 h between 07:00 and 23:00 → Web chat · Rotation: at 70% of context or 200k
tokens, and daily at 04:00; "Start fresh" · Channel bindings: Web chat (always), Slack · acme-hq ·
DM with Rogier.

**Memory**: core note **1,284 of 4,000** characters; **7 topics** (of 24), each up to 12,000
characters with a one-line gist:

| Topic | Gist | Size |
|---|---|---|
| work-style | Prefers short answers; decides fast; hates long preambles | 1.2k |
| webshop | Stripe checkout, EU customers mostly NL/DE; deploys on weekdays only | 3.4k |
| payments-api | Owns webhooks + payouts; v2.x; publish via npm | 2.1k |
| ops | Backups nightly 04:00 to B2; certs on status.acme.dev | 1.8k |
| customers | Marta @ Brightline (invoices), Jonas @ Kiteworks (API limits) | 2.7k |
| family | School run Tue/Thu; no meetings before 09:30 | 0.6k |
| reading | Wants summaries of the weekly Rust + Postgres newsletters | 0.9k |

Core note begins: "Rogier runs Acme alone with agents. Projects: webshop, payments-api, ops. Be
brief. Never deploy on Fridays. Customers write in English, Dutch and German…"

**Reminders**: Fri 2 Oct 09:00 "Renew the SSL cert for ops" · every Monday 08:30 "Weekly revenue
summary" · Thu 1 Oct 16:00 "Call the accountant".

## Notifications (for lock screen, menu bar, native notifications)

- **Request** · Fix 3-D Secure checkout · "Run `git push -u origin fix/3ds-eu-cards`?" · Allow
  once · Deny
- **Proposal** · "Checkout fails for EU cards with 3-D Secure" · Start "Fix bug" · Dismiss
- **Request** · Ship release v2.15 · "Publish payments-api 2.15.0 to npm?" · Allow once · Deny
- **Question** · Migrate ops dashboards · "Keep the old Grafana folder?" · Keep · Delete
- **Ada** · "Morning Rogier. One urgent thing…" · Reply
- Live Activity: "Fix 3-D Secure checkout · waiting on you · 3 files +48 -12"

## Settings domains (for navigation)

Profile · Appearance · Threads · Assistants · Connections · Providers · Machines (runners) ·
Identities · Permission profiles · Secrets · Bounds · Plugins · System.

Appearance holds the theme picker, accent (if you have one), density, font size, reduce motion /
transparency, and the Marks toggle (show source-system marks on rows).

Providers (web/settings-providers): the three providers above, each with account, models, default
effort, which machines have it installed (Claude Code: studio-mac, build-box-1, build-box-2; Codex:
build-box-1, build-box-2; pi: studio-mac only), default access mode, and a usage glance (e.g.
Claude Code: 61% of the 5-hour window used, resets 11:00).
