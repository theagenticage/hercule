# Case File - Rogier's Tuesday

PROTOTYPE. A walk through Tuesday 29 September 2026 with Case File.

**09:02.** Sentry assigns Rogier "Checkout fails for EU cards with 3-D Secure". He hands it to a
thread and goes on. Between 09:05 and 09:35 he hands off five more: Pieter's trailing-space codes to
Fix bug, the failing VAT snapshot on #1300 to Fix bug, Marta's review of #1294 to Review PR, Marta
Visser's invoice mail to Draft reply, and Jonas's question on PAY-212 to Investigate, with a note:
"Jonas has a call with his finance team at 11." Each one leaves Intake, as before. Each one now also
opens a case.

**09:41.** He opens Cases from the sidebar; its row says 4. The list is grouped by what each case
asks of him. On top, under Needs you, the 3-D Secure thread: "Run git push?". The trail shows the
alert, his handoff, five short notes ("Found it: `requires_action` is treated as a failure"), and
the question right under them. Allow once. Five seconds later the case lands: draft pull request #1303, +48 −12.

Under Working, Refunds for partial captures is typing: "Writing a failing test for a refund after a
partial capture…". Twelve seconds later it lands, and a toast says so. The finding is two sentences
and a one-line diff at `refund.ts:88`, with "High confidence" and one doubt set apart: "I did not
call Stripe's test mode." Reply on PAY-212. Jonas has his answer an hour before his call. Marta's
review of #1294 reads "Approve, with 2 comments", sure of itself. S, Enter: posted.

**09:43.** Marta's invoice case carries a marigold dot. He presses J, and the letter is right
there, "Dear Ms. Visser", with "Medium confidence" under it and the two things the agent guessed:
the legal name ("Ltd") and the attachment, still in Marta's name. Nothing was sent. He presses B and
types: "It's Brightline B.V. (KvK 81234567). First names, short. Reissue it as INV-2291-R in Stripe
and attach that." The trail grows a fork: "You sent it back 09:43", his note pinned, attempt 2
working beneath it.

Four seconds later it asks, in the trail: "Void INV-2291 and create INV-2291-R for Brightline B.V.
in Stripe · live?" Allow once. Six seconds later attempt 2 lands. He presses C: the two letters side
by side, "Dear Ms. Visser" struck through, "Hi Marta" added, INV-2291.pdf struck, INV-2291-R.pdf
added. Keep this one. S, Enter: sent.

**09:46.** Pieter's case. He had opened it at 09:33 and got distracted; it waited without a dot.
The pull request is two lines, and the cause is a link: "#1287 Discount codes ignore letter case.
You signed it off yesterday, 19:12." He clicks it and sees yesterday's case, the change he approved,
with "Later: Codes with a trailing space are rejected" at its end. He goes back and merges #1302,
then sends the drafted reply to Pieter, both from the ledger, each with its describe line.

**09:48.** Failed: Show VAT per line. The trail says where it stopped and why: CI runs in UTC, and
the fix needs `.github/workflows/test.yml`, which the run may not edit. B, "You may edit
.github/workflows/test.yml", ⌘↩. Ten seconds later: 2 commits on #1300, 27 checks passed, and the
line "Pushed with your grant: Fix bug may push to the pull request it was handed".

**10:15.** Marta Visser replies "Perfect, thanks Rogier!" and the invoice case closes by itself,
"Closed by Gmail". At 11:02 Marta merges #1294 and the review case closes. At 14:30 Pieter writes
"Works now, thanks!" in #acceptance; that case closes too. He saw none of it happen, and did not need
to.

**18:10.** Before he leaves, the Cases row reads 1: the backup findings, landed at 09:42, medium
confidence, "measured on a copy". He hands the fix to Fix bug from the ledger.

What he did not do today: open Workflows to find a run, scroll a transcript for a draft, open Gmail
to check Drafts, explain the invoice twice, or wonder whether the VAT fix ever finished.

After a month, the cases read like a ledger of trust: Review PR, 14 of 14 signed off as they came,
and he stops opening those until they ask.
