# Round Trip: Tuesday 29 September

PROTOTYPE. A walk through Rogier's day with this direction.

**09:02.** Sentry burns: checkout fails for EU cards with 3-D Secure. Rogier starts a thread on it
from Now. The row leaves To do and a peach face appears under the list, in Out with agents,
typing.

**09:05 to 09:35.** He hands off and moves on. Pieter's
trailing-space bug goes to Fix bug. The failed checks on #1300 go to Fix bug too. Marta's review
request goes to Review PR. Marta Visser's mail about INV-2291 goes to Draft reply. Jonas's
question on PAY-212 goes to Investigate, and he starts Investigate on the backup Task triage
proposed. Each row drops into Out with agents. Nothing asks him to wait.

**09:20 to 09:27.** Results come back while he is still handing off. Nothing interrupts him: each lands on To
do beside Sanne's review, with the colleague's face and a marigold dot.

**09:41.** Coffee. He opens Intake and reads the list as he reads any list:

- Review PR: *approve, 2 comments*.
- Draft reply: *a draft reply in Gmail*, dot.
- Fix bug: *failed, may not edit test.yml*, dot.
- Fix bug: *draft PR #1302, +14 −3*. He opened it at 09:33 and got pulled away, so it has no dot.

Under the list, the 3-D Secure thread is in marigold: "Run `git push -u origin
fix/3ds-eu-cards`?" He presses Allow once right there. The face goes back to typing.

He opens the review. On top, **You asked**: Marta's own words about Stripe's three days of
retries. Under it, what Review PR did: approve, two comments, "Read all 4 files and ran the
tests: 18 passed", high confidence. He presses `↩`, `↩`: the review is on GitHub, signed off,
and the next row opens.

At 09:41:12 a row lifts out of Out with agents into the list: Jonas's answer. Stripe allows the
refund; `createRefund` defaults to the authorised €120. "I did not call Stripe's test mode", in
marigold. The reply box opens with the answer drafted. He trims a word and presses `⌘↩`.

Then Marta's draft. "Medium confidence", says the colleague, and it says why: it guessed "Ltd" and attached
the old invoice. The letter opens "Dear Ms. Visser". They are on first names. He presses `B`,
clicks the chip "Legal name: guessed Ltd", and writes: "It's Brightline B.V. (KvK 81234567).
First names, short. Reissue it as INV-2291-R in Stripe and attach that." `⌘↩`. The row turns into
Attempt 2 and drops under the list. Four seconds later it asks, in marigold: "Void INV-2291 and
create INV-2291-R for Brightline B.V. in Stripe · live?" Allow once. Six seconds later it is back
with "What changed since attempt 1": Brightline Ltd → Brightline B.V., Dear Ms. Visser → Hi Marta,
INV-2291.pdf → INV-2291-R.pdf. Send reply.

The failure is next, and it is plain: the snapshot only differs on CI, and the fix needs
`test.yml`, which the run may not touch. `B`, the chip "May edit .github/workflows/test.yml",
`⌘↩`. Ten seconds later: pushed to #1300, checks pass. He signs it off.

Last, #1302. Under the cause sits a small line: "You signed off #1287 yesterday at 19:12". His
own sign-off caused the regression. He merges #1302 and sends the reply Fix bug drafted to Pieter.

It is 09:48. To do holds Sanne's review and two triage findings.

**What he did not do.** He did not open Workflows to find five runs. He did not scroll a
transcript for a draft, check Gmail's Drafts, or explain Marta's invoice again in a new thread.
He did not find out at lunch that #1300's fix had failed at 09:26.

**Late morning.** The backup findings land with medium confidence: dump `events` in parallel,
38 minutes on a copy. He hands
the findings on to Fix bug; that trip comes back after lunch.

**18:30.** Before closing the laptop he looks at Done. Every trip is one line: "Handed to Draft
reply → sent back once → signed off, sent to Marta". The 3-D Secure thread reads "Started a
thread on it → signed off, merged #1305".

After a month, handing off stops feeling like throwing work over a wall: everything he sends out
comes back to the list he already empties every day.
