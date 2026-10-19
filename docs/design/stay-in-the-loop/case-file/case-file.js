// PROTOTYPE - Case File: every handoff opens a case, and the case is one trail of the work's life.
//
// The page holds the morning's cases (the shared brief's H1 to H7, and two from yesterday), runs a
// small simulation of the clock so cases land while the reviewer watches, and draws two things:
// the list of cases, grouped by what each asks of Rogier, and the open case as a trail of
// stations. Every case is plain data below; render() draws the page from it whole, and a set of
// keys remembers what was already on screen, so only new things play their one-shot motion.
(function () {
  "use strict";

  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  if (params.get("bar") === "off") root.setAttribute("data-bar-off", "");
  var STATE = root.dataset.state || "";

  /* ------------------------------------------------------------------ time */

  // The page opens at Tuesday 29 September 2026, 09:41:00. sim.t counts seconds from then.
  var START = 9 * 3600 + 41 * 60;
  var sim = { t: 0, playing: true };

  /** Returns a clock time "09:41" for seconds since midnight. */
  function formatClock(sec) {
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  /** Returns the simulated time now, in seconds since midnight. */
  function nowSec() {
    return START + sim.t;
  }
  /** Parses "09:12" to seconds since midnight. */
  function parseClock(text) {
    var p = text.split(":");
    return Number(p[0]) * 3600 + Number(p[1]) * 60;
  }
  /** Returns a duration as the transcript writes it: "42s", "7m 40s", "1h 4m". */
  function formatDuration(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 60) return seconds + "s";
    var m = Math.floor(seconds / 60);
    if (m < 60) return m + "m " + (seconds % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  /** Returns an age as a list writes it: "now", "12m", "2h". */
  function formatAge(seconds) {
    if (seconds < 60) return "now";
    var m = Math.floor(seconds / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h";
  }

  /* ------------------------------------------------------------------ small markup helpers */

  function face(name, pose, size) {
    return Crew.face(name, { pose: pose, size: size || 28 });
  }
  /** Returns a colleague's name in its own hue's ink. */
  function whoName(name) {
    return '<span class="who-ink" style="--hue:var(--hue-' + Crew.lookFor(name).hue + ')">' + name + "</span>";
  }
  function icon(name, size) {
    return Crew.icon(name, size || 16);
  }
  function brand(name, size) {
    // Triage is a colleague, not a system, so its proposals carry its face as their mark.
    if (name === "triage") return Crew.face("Triage", { pose: "idle", size: (size || 14) + 4 });
    return Crew.brand(name, size || 14);
  }
  function sourceName(brandName) {
    return { github: "GitHub", gmail: "Gmail", slack: "Slack", linear: "Linear", sentry: "Sentry", grafana: "Grafana", triage: "Hercule", stripe: "Stripe" }[brandName];
  }

  /* ------------------------------------------------------------------ the cases */

  // A case joins the signal, the handoff, each attempt's run, Rogier's verdict and what the
  // source showed afterwards. Attempts hold the run: its notes, its question, its result and the
  // answers it offers. A script is the simulation's future for an attempt: entries run "after"
  // that many seconds from the attempt's start, or from the moment Rogier answered its question.
  function buildCases() {
    return [
      {
        id: "h6",
        title: "Checkout fails for EU cards with 3-D Secure",
        colleague: "Fix 3-D Secure checkout for EU cards",
        isThread: true,
        project: ["webshop", "webshop"],
        source: {
          brand: "sentry",
          kind: "Alert assigned to you",
          who: "Sentry",
          at: "08:52",
          where: "webshop-prod",
          quote: '<div class="quote-head"><b>CardError: 3-D Secure authentication required</b></div><p>Checkout fails for EU cards with 3-D Secure. Every failing card is issued in the EU, and every one returned <code>requires_action</code>.</p>',
          facts: ["<span>412 events</span>", "<span>188 users</span>", "<span>first seen 08:52</span>"],
          made: "1 alert from Sentry · webshop-prod",
        },
        handed: { at: "09:02", note: null, how: "Claude Code · Opus 5.5 · studio-mac" },
        phase: "needs",
        attempts: [
          {
            start: "09:02",
            notes: [
              ["09:02", "Read the Sentry issue: 412 events, all on EU cards"],
              ["09:08", "Found it: <code>requires_action</code> is treated as a failure"],
              ["09:19", "Wrote a failing test, then the fix"],
              ["09:27", "Ran <code>pnpm test checkout</code>: 24 passed"],
              ["09:31", "Ready to push <code>fix/3ds-eu-cards</code> and open a pull request"],
            ],
            worked: "29m",
            tools: ["edited 3 files <span class=\"plus\">+48</span> <span class=\"minus\">−12</span>", "ran <code>pnpm test checkout</code>"],
            askedAt: "09:31",
            request: {
              q: 'Run <code>git push -u origin fix/3ds-eu-cards</code>?',
              short: "Run git push?",
              answers: [
                { label: "Allow once", kind: "accent", does: "allow", desc: "Pushes the branch this one time" },
                { label: "Always allow git push", does: "allow", desc: "Adds a Grant for <b>git push</b> in <b>webshop</b>" },
                { label: "Deny", kind: "quiet", does: "deny", desc: "Tells the agent no; the branch stays local" },
              ],
            },
            afterAllow: [
              { after: 2, note: "Pushed <code>fix/3ds-eu-cards</code>" },
              { after: 3, live: "Opening a draft pull request" },
              { after: 5, note: "Opened draft pull request #1303" },
              { after: 5, land: true },
            ],
            result: {
              type: "pr",
              gist: "Draft PR #1303 · +48 −12",
              number: "#1303",
              prTitle: "Fix 3-D Secure checkout for EU cards",
              repo: "rogier/webshop",
              branch: "fix/3ds-eu-cards",
              files: 3,
              plus: 48,
              minus: 12,
              checks: "24 passed",
              draft: true,
              diff: { file: "src/checkout/payment.ts", lines: [[" ", "if (result.status === \"requires_action\") {"], ["-", "  return fail(result);"], ["+", "  return openThreeDSModal(result.clientSecret);"], [" ", "}"]] },
            },
            sure: { level: 3, why: "Reproduced the decline with Stripe's 3-D Secure test card first.", unsure: [] },
            actions: [
              { label: "Ready for review", kind: "accent", key: "S", does: "sign", desc: "Marks draft <b>#1303</b> ready for review in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", chip: "Ready for review", record: "Marked #1303 ready for review", undo: "Turns #1303 back into a draft" },
              { label: "Send back", key: "B", does: "sendback", desc: "Asks the thread for another try, with your note" },
              { label: "Close the PR", kind: "danger", does: "discard", desc: "Closes <b>#1303</b> and deletes its branch", chip: "Closed", record: "Closed #1303" },
            ],
          },
        ],
        worldWait: "Closes when Sentry marks the alert resolved",
        worldPlan: [
          { after: 6, brand: "github", html: "<b>Marta</b> approved #1303" },
          { after: 12, brand: "sentry", html: "Sentry marked the alert <b>resolved</b>", end: true },
        ],
      },
      {
        id: "h1",
        title: "Retry Stripe webhooks with backoff",
        colleague: "Review PR",
        project: ["payments-api", "payments"],
        source: {
          brand: "github",
          kind: "Review requested",
          who: "Marta",
          at: "09:04",
          where: "rogier/payments-api #1294",
          quote: '<div class="quote-head"><b>Marta</b><span>09:04</span></div><p>Adds backoff to webhook retries, so a slow endpoint stops getting hammered. Could you take a look before Thursday\'s deploy?</p>',
          facts: [
            "<span>" + icon("branch", 14) + '<code>feat/webhook-backoff</code> → <code>main</code></span>',
            '<span>4 files <span class="plus">+112</span> <span class="minus">−18</span></span>',
            "<span>3 commits</span>",
            "<span>18 checks passed</span>",
          ],
          made: "1 event from GitHub · review requested",
        },
        handed: { at: "09:12", note: null, how: "Claude Code · Sonnet 5 · build-box-2", trust: [14, 14, "14 of 14 signed off as they came"] },
        phase: "landed",
        seen: false,
        attempts: [
          {
            start: "09:12",
            notes: [
              ["09:12", "Read #1294 and its 3 commits"],
              ["09:14", "Read <code>src/webhooks/retry.ts</code> and its test"],
              ["09:16", "Checked that idempotency keys survive a retry"],
              ["09:18", "Ran the tests: 18 passed"],
              ["09:20", "Drafted the review: approve, with 2 comments"],
            ],
            worked: "7m 40s",
            tools: ["read 4 files", "ran <code>pnpm test webhooks</code>"],
            landedAt: "09:20",
            result: {
              type: "review",
              gist: "Draft review · Approve, 2 comments",
              verdict: "Approve, with 2 comments",
              summary: "Exponential backoff with full jitter, base 2s, cap 30m. Idempotency keys survive retries, so a retry never double-books a payout. Safe to merge once the cap is configurable.",
              comments: [
                { path: "src/webhooks/retry.ts", line: 42, text: "The 30-minute cap is hard-coded. Stripe retries for 3 days; read <code>WEBHOOK_RETRY_CAP_MS</code> so ops can raise it." },
                { path: "src/webhooks/retry.test.ts", text: "No test covers the jitter. A seeded random would make <code>computeDelay</code> testable." },
              ],
            },
            sure: { level: 3, why: "Read all 4 files and ran the tests: 18 passed.", unsure: [] },
            actions: [
              { label: "Post review", kind: "accent", key: "S", does: "sign", desc: "Posts an approving review with <b>2 comments</b> on <b>#1294</b> in <b>rogier/payments-api</b> as <b>GitHub · rogier</b>", chip: "Posted", record: "Posted the review on #1294", undo: "Dismisses your review on #1294" },
              { label: "Edit first", does: "edit", desc: "Opens the draft in Review PR's thread, to change it before it is posted" },
              { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 2 of <b>Review PR</b> with your note" },
              { label: "Discard draft", kind: "danger", does: "discard", desc: "Deletes the draft review. Nothing is posted", chip: "Deleted", record: "Discarded the draft review" },
            ],
          },
        ],
        worldWait: "Closes when #1294 merges or closes",
        worldPlan: [
          { after: 4, brand: "github", html: "<b>Marta</b> read your review and pushed 1 commit" },
          { after: 9, brand: "github", html: "<b>Marta</b> merged #1294 into <code>main</code>", end: true },
        ],
      },
      {
        id: "h3",
        title: "Invoice INV-2291 in the company name",
        colleague: "Draft reply",
        project: null,
        source: {
          brand: "gmail",
          kind: "Mail",
          who: "Marta Visser",
          org: "Brightline",
          at: "08:41",
          where: "rogier@personal",
          quote: '<div class="quote-head"><b>Marta Visser</b><span>Brightline · 08:41</span></div><p>Hi Rogier, could you reissue INV-2291 in the company name instead of mine? Our finance team needs it for the books. Thanks, Marta</p>',
          facts: [],
          made: "1 mail from Marta Visser",
        },
        handed: { at: "09:20", note: null, how: "Claude Code · Haiku 4.5 · build-box-2", trust: [17, 20, "17 of 20 signed off as they came · 2 sent back · 1 taken over"] },
        phase: "landed",
        seen: false,
        attempts: [
          {
            start: "09:20",
            notes: [
              ["09:20", "Read Marta's mail and 6 earlier mails with Brightline"],
              ["09:21", "Found INV-2291 in Gmail, made out to Marta Visser"],
              ["09:22", "Drafted the reply and saved it in Gmail Drafts"],
            ],
            worked: "2m 10s",
            tools: ["searched Gmail for Brightline", "read 7 mails", "saved 1 draft"],
            landedAt: "09:22",
            result: {
              type: "mail",
              gist: "Reply drafted in Gmail",
              to: "Marta Visser",
              subject: "Re: Invoice INV-2291 in the company name",
              body: [
                "Dear Ms. Visser,",
                "Thank you for reaching out regarding invoice INV-2291. We would be happy to accommodate your request. Please find the reissued invoice made out to Brightline Ltd attached to this email.",
                "Should you have any further questions, please do not hesitate to contact us.",
                "Kind regards,\nRogier Pennink\nAcme",
              ],
              unsureWord: "Ltd",
              attachment: ["INV-2291.pdf", "48 KB"],
              saved: "Saved in Gmail Drafts",
            },
            sure: {
              level: 2,
              why: "Some of it is a guess.",
              unsure: ["I couldn't find Brightline's legal name in earlier mail, so I guessed \"Ltd\".", "I attached the existing invoice, still in Marta's name: I can't create invoices."],
            },
            actions: [
              { label: "Send reply", kind: "accent", key: "S", does: "sign", desc: "Sends the reply to <b>Marta Visser</b> from <b>Gmail · rogier@personal</b> with <b>INV-2291.pdf</b>", chip: "Sent", record: "Sent the reply to Marta Visser", undo: null },
              { label: "Edit first", does: "edit", desc: "Opens the draft in Gmail, to change it before it is sent" },
              { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 2 of <b>Draft reply</b> with your note" },
              { label: "Discard draft", kind: "danger", does: "discard", desc: "Deletes the draft from Gmail Drafts. Nothing is sent", chip: "Deleted", record: "Discarded the draft" },
            ],
          },
        ],
        // What Send back starts: attempt 2, which asks before it touches Stripe.
        next: {
          script: [
            { after: 0, live: "Reading your note" },
            { after: 1, note: "Read your note: Brightline B.V., KvK 81234567" },
            { after: 2, live: "Finding INV-2291 in Stripe · live" },
            { after: 4, note: "Found INV-2291 in Stripe · live, €1,450.00, paid" },
            { after: 4, ask: true },
          ],
          request: {
            q: "Void <b>INV-2291</b> and create <b>INV-2291-R</b> for <b>Brightline B.V.</b> in <b>Stripe · live</b>?",
            short: "Void INV-2291 in Stripe?",
            answers: [
              { label: "Allow once", kind: "accent", does: "allow", desc: "Voids INV-2291 and creates INV-2291-R in <b>Stripe · live</b>, this one time" },
              { label: "Deny", kind: "quiet", does: "deny", desc: "Tells the agent no; nothing changes in Stripe" },
            ],
          },
          afterAllow: [
            { after: 1, note: "Voided INV-2291 in Stripe · live" },
            { after: 3, note: "Created INV-2291-R for Brightline B.V." },
            { after: 4, live: "Rewriting the reply: first names, short" },
            { after: 6, note: "Saved the new reply in Gmail Drafts, with INV-2291-R.pdf" },
            { after: 6, land: true },
          ],
          tools: ["read your note", "voided 1 invoice in Stripe", "created 1 invoice in Stripe", "saved 1 draft"],
          result: {
            type: "mail",
            gist: "Reply drafted · INV-2291-R",
            to: "Marta Visser",
            subject: "Re: Invoice INV-2291 in the company name",
            body: ["Hi Marta,", "Done: attached is INV-2291-R, made out to Brightline B.V. (KvK 81234567). I voided the original INV-2291, so your finance team can book this one.", "Best,\nRogier"],
            attachment: ["INV-2291-R.pdf", "49 KB"],
            saved: "Saved in Gmail Drafts",
          },
          sure: { level: 3, why: "Used the legal name and KvK number from your note. INV-2291-R is in Stripe.", unsure: [] },
          actions: [
            { label: "Send reply", kind: "accent", key: "S", does: "sign", desc: "Sends the reply to <b>Marta Visser</b> from <b>Gmail · rogier@personal</b> with <b>INV-2291-R.pdf</b>", chip: "Sent", record: "Sent the reply to Marta Visser", undo: null },
            { label: "Edit first", does: "edit", desc: "Opens the draft in Gmail, to change it before it is sent" },
            { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 3 of <b>Draft reply</b> with your note" },
            { label: "Discard draft", kind: "danger", does: "discard", desc: "Deletes the draft from Gmail Drafts. Nothing is sent", chip: "Deleted", record: "Discarded the draft" },
          ],
        },
        sendBackHint: "It's Brightline B.V. (KvK 81234567). First names, short. Reissue it as INV-2291-R in Stripe and attach that.",
        worldWait: "Closes when Marta answers",
        worldPlan: [{ after: 8, brand: "gmail", html: "<b>Marta Visser</b> replied: \"Perfect, thanks Rogier!\"", end: true }],
      },
      {
        id: "h2",
        title: "Codes with a trailing space are rejected",
        colleague: "Fix bug",
        project: ["webshop", "webshop"],
        source: {
          brand: "slack",
          kind: "Tagged in a thread",
          who: "Pieter",
          at: "08:58",
          where: "#acceptance",
          quote: '<div class="quote-head"><b>Pieter</b><span>08:58</span></div><p><span class="at">@rogier</span> codes with a trailing space are rejected now. "SUMMER10 " fails, and it worked before. Customers paste them from emails.</p>',
          facts: [],
          made: "1 message from Slack · #acceptance",
        },
        handed: { at: "09:05", note: null, how: "Claude Code · Opus 5.5 · studio-mac", trust: [9, 12, "9 of 12 signed off as they came · 2 sent back · 1 failed"] },
        phase: "landed",
        seen: true,
        seenAt: "09:33",
        attempts: [
          {
            start: "09:05",
            notes: [
              ["09:05", "Reproduced it: <code>\"SUMMER10 \"</code> is rejected"],
              ["09:09", "Wrote a failing test with <code>\"SUMMER10 \"</code>"],
              ["09:14", "Found the cause: #1287 dropped <code>code.trim()</code> in <code>normalizeCode</code>"],
              ["09:19", "Fixed <code>normalizeCode</code> and ran every check: 26 passed"],
              ["09:26", "Opened draft pull request #1302 and drafted a reply to Pieter"],
            ],
            worked: "22m",
            tools: ["edited 2 files", "ran <code>pnpm test discounts</code>", "opened 1 draft pull request"],
            landedAt: "09:27",
            result: {
              type: "pr",
              gist: "Draft PR #1302 · +14 −3",
              number: "#1302",
              prTitle: "Trim discount codes before lookup",
              repo: "rogier/webshop",
              branch: "fix/trim-discount-codes",
              files: 2,
              plus: 14,
              minus: 3,
              checks: "26 passed",
              draft: true,
              grant: "Opened as a draft, which <a href=\"#\">your Fix bug profile</a> allows without asking",
              diff: { file: "src/discounts/normalize.ts", lines: [[" ", "export function normalizeCode(code: string) {"], ["-", "  return code.toLowerCase();"], ["+", "  return code.trim().toLowerCase();"], [" ", "}"]] },
              cause: { caseId: "y1", ref: "#1287", title: "Discount codes ignore letter case", line: "You signed it off yesterday, 19:12. It replaced <code>code.trim()</code> with <code>code.toLowerCase()</code>." },
              reply: { to: "Pieter", where: "#acceptance", text: "Fixed in #1302. It reaches acceptance with the next deploy." },
            },
            sure: { level: 3, why: "Reproduced it with a failing test first.", unsure: [] },
            actions: [
              { label: "Merge #1302", kind: "accent", key: "S", does: "sign", desc: "Squash-merges <b>#1302</b> into <b>main</b> in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", chip: "Merged", record: "Merged #1302", undo: "Opens a pull request that reverts #1302" },
              { label: "Reply to Pieter", does: "also", desc: "Replies in the <b>#acceptance</b> thread as <b>Slack · rogier</b>", record: "Replied to Pieter in #acceptance" },
              { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 2 of <b>Fix bug</b> with your note" },
              { label: "Close the PR", kind: "danger", does: "discard", desc: "Closes <b>#1302</b> and deletes its branch. Pieter is not told", chip: "Closed", record: "Closed #1302" },
            ],
          },
        ],
        worldWait: "Closes when Pieter answers in the thread",
        worldPlan: [
          { after: 5, brand: "github", html: "#1302 reached acceptance with deploy <code>a41f9c2</code>" },
          { after: 11, brand: "slack", html: "<b>Pieter</b> replied: \"Works now, thanks!\"", end: true },
        ],
      },
      {
        id: "h4",
        title: "Refunds for partial captures",
        colleague: "Investigate",
        project: ["payments-api", "payments"],
        source: {
          brand: "linear",
          kind: "Question for you",
          who: "Jonas",
          org: "Kiteworks",
          at: "09:29",
          where: "PAY-212",
          quote: '<div class="quote-head"><b>Jonas</b><span>Kiteworks · 09:29</span></div><p>Can we refund a partially captured payment? We captured €80 of a €120 authorisation and the refund call fails.</p>',
          facts: [],
          made: "1 issue from Linear · PAY-212",
        },
        handed: { at: "09:33", note: "Jonas has a call with his finance team at 11. An answer before then helps.", how: "Codex · gpt-5.4 · build-box-1", trust: [6, 6, "6 of 6 signed off as they came"] },
        phase: "working",
        attempts: [
          {
            start: "09:33",
            notes: [
              ["09:33", "Read PAY-212 and its 3 comments"],
              ["09:35", "Searched payments-api for partial captures: 6 places"],
              ["09:37", "Read <code>src/refunds/refund.ts</code>"],
              ["09:39", "Ran <code>pnpm test refunds</code>: 31 passed"],
            ],
            live: "Writing a failing test for a refund after a partial capture",
            tools: ["read 9 files", "ran <code>pnpm test refunds</code>"],
            script: [
              { after: 6, note: "The test fails: Stripe returns <code>amount_too_large</code>" },
              { after: 7, live: "Writing up the findings" },
              { after: 12, land: true },
            ],
            result: {
              type: "findings",
              gist: "Findings · a one-line fix",
              html: "<p>Yes, Stripe allows it. <code>createRefund</code> defaults <code>amount</code> to <code>payment.amountAuthorized</code> when no amount is given. For a partial capture that is €120, more than the €80 captured, so Stripe returns <code>amount_too_large</code>.</p><p>Passing an explicit amount works today; the fix is one line at <code>src/refunds/refund.ts:88</code>.</p>",
              diff: { file: "src/refunds/refund.ts:88", lines: [["-", "  amount: amount ?? payment.amountAuthorized,"], ["+", "  amount: amount ?? payment.amountCaptured,"]] },
            },
            sure: { level: 3, why: "Reproduced the cause with a failing test.", unsure: ["I did not call Stripe's test mode."] },
            actions: [
              { label: "Reply on PAY-212", kind: "accent", key: "S", does: "sign", desc: "Posts the answer on <b>PAY-212</b> as <b>Linear · rogier</b>", record: "Replied on PAY-212", undo: "Deletes your comment on PAY-212" },
              { label: "Hand to Fix bug", does: "hand", desc: "Starts <b>Fix bug</b> on <b>payments-api</b> with these findings", record: "Handed the fix to Fix bug" },
              { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 2 of <b>Investigate</b> with your note" },
            ],
          },
        ],
        worldWait: "Closes when Jonas answers on PAY-212",
        worldPlan: [{ after: 8, brand: "linear", html: "<b>Jonas</b> replied on PAY-212: \"Works with an explicit amount, thanks!\"", end: true }],
      },
      {
        id: "h7",
        title: "Nightly backup job timing out on ops-db",
        colleague: "Investigate",
        project: ["ops", "ops"],
        source: {
          brand: "triage",
          kind: "Proposal, accepted 09:05",
          who: "Triage",
          at: "09:00",
          where: "a Task in ops",
          quote: '<div class="quote-head"><b>Triage</b><span>09:00</span></div><p>The nightly backup job hit its 2-hour limit 3 nights in a row. ops-db has grown 30% since August.</p>',
          facts: [],
          made: "3 events from Cron · schedules",
        },
        handed: { at: "09:35", note: null, how: "Codex · gpt-5.4 · build-box-1", trust: [6, 6, "6 of 6 signed off as they came"], started: true },
        phase: "working",
        attempts: [
          {
            start: "09:35",
            notes: [
              ["09:35", "Read the backup job's logs for the last 3 nights"],
              ["09:37", "<code>pg_dump</code> of <code>events</code> (41 GB) takes 1h 52m; the job's limit is 2h"],
              ["09:39", "Restored last night's snapshot to a copy on build-box-1"],
            ],
            live: "Timing <code>pg_dump --jobs 4</code> on the copy",
            tools: ["read 3 logs", "ran <code>pg_dump</code> twice on a copy"],
            script: [
              { after: 30, note: "<code>--jobs 4</code> took 38m on the copy" },
              { after: 32, live: "Writing up the findings" },
              { after: 40, land: true },
            ],
            result: {
              type: "findings",
              gist: "Findings · two ways out",
              html: "<p>Dump <code>events</code> in parallel with <code>--jobs 4</code>: 38m on a copy, well inside the 2h limit.</p><p>Or drop the 90-day-old partitions the sweep already ignores, which takes <code>events</code> from 41 GB to 9 GB.</p>",
            },
            sure: { level: 2, why: "The timings are real, but from a copy.", unsure: ["Measured on a copy, not on ops-db: the real run shares its disk with live traffic."] },
            actions: [
              { label: "Sign off", kind: "accent", key: "S", does: "sign", desc: "Adds the findings to the Task <b>Nightly backup job timing out</b>. Nothing is sent", record: "Signed off the findings" },
              { label: "Hand to Fix bug", does: "hand", desc: "Starts <b>Fix bug</b> on <b>ops</b> to switch the job to <code>--jobs 4</code>", record: "Handed the fix to Fix bug" },
              { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 2 of <b>Investigate</b> with your note" },
            ],
          },
        ],
        closesAtSignOff: "No source to wait for: the findings are on the Task",
      },
      {
        id: "h5",
        title: "Show VAT per line on invoices",
        colleague: "Fix bug",
        project: ["webshop", "webshop"],
        source: {
          brand: "github",
          kind: "Checks failed on your PR",
          who: "GitHub Actions",
          at: "09:07",
          where: "rogier/webshop #1300",
          quote: '<div class="quote-head"><b><code>test (ubuntu)</code></b><span>failed · 09:07</span></div><p><code>invoice.snap.ts › renders VAT per line</code>: Snapshot mismatch: <code>"29-09-2026 00:00"</code> vs <code>"28-09-2026 22:00"</code></p>',
          facts: ["<span>1 failed</span>", "<span>26 passed</span>"],
          made: "1 event from GitHub · checks failed",
        },
        handed: { at: "09:08", note: null, how: "Claude Code · Sonnet 5 · build-box-1", trust: [9, 12, "9 of 12 signed off as they came · 2 sent back · 1 failed"] },
        phase: "failed",
        attempts: [
          {
            start: "09:08",
            notes: [
              ["09:08", "Ran <code>invoice.snap.ts</code> here: it passes"],
              ["09:13", "Tried 3 fixes to the snapshot; each one fails only on CI"],
              ["09:24", "Found it: CI runs in UTC, and the test formats dates in local time"],
            ],
            worked: "18m",
            tools: ["ran <code>pnpm test invoice</code> 4 times", "committed 1 change"],
            failedAt: "09:26",
            failure: {
              why: "Gave up after 3 tries. The snapshot differs only on CI: the runner's time zone is UTC and the test formats dates in local time. Pinning the zone needs a change to <code>.github/workflows/test.yml</code>, which this run may not edit.",
              left: ["<span>" + icon("branch", 14) + "<code>fix/invoice-snapshot-tz</code></span>", "<span>1 commit, not pushed</span>", "<span>" + icon("server", 14) + "build-box-1</span>"],
            },
            actions: [
              { label: "Try again with a note", kind: "accent", key: "S", does: "retry", desc: "Starts attempt 2 of <b>Fix bug</b> on the same branch, with your note" },
              { label: "Take over", key: "T", does: "take", desc: "Opens the run's thread on <b>fix/invoice-snapshot-tz</b>, to go on by hand" },
              { label: "Let it go", kind: "quiet", does: "letgo", desc: "Closes the case. The branch stays on build-box-1", record: "Let it go" },
            ],
          },
        ],
        next: {
          script: [
            { after: 0, live: "Reading your note" },
            { after: 1, note: "Read your note: may edit <code>.github/workflows/test.yml</code>" },
            { after: 3, note: "Set <code>TZ: Europe/Amsterdam</code> for the test job" },
            { after: 5, note: "Pushed 2 commits to #1300" },
            { after: 6, live: "Waiting for the checks on #1300" },
            { after: 10, note: "Checks re-ran on #1300: 27 passed" },
            { after: 10, land: true },
          ],
          tools: ["edited 2 files", "pushed 2 commits", "watched 27 checks"],
          result: {
            type: "pr",
            gist: "2 commits on #1300 · checks pass",
            number: "#1300",
            prTitle: "Show VAT per line on invoices",
            repo: "rogier/webshop",
            branch: "feat/vat-per-line",
            pushed: "2 commits pushed",
            plus: 4,
            minus: 1,
            files: 2,
            checks: "27 passed",
            grant: "Pushed with <a href=\"#\">your grant</a>: Fix bug may push to the pull request it was handed",
            diff: { file: ".github/workflows/test.yml", lines: [[" ", "  test:"], [" ", "    runs-on: ubuntu-latest"], ["+", "    env:"], ["+", "      TZ: Europe/Amsterdam"]] },
          },
          sure: { level: 3, why: "The checks pass on CI, where they failed.", unsure: [] },
          actions: [
            { label: "Sign off", kind: "accent", key: "S", does: "sign", desc: "Marks the case signed off. <b>#1300</b> already has the commits", record: "Signed off" },
            { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 3 of <b>Fix bug</b> with your note" },
            { label: "Undo the push", kind: "danger", does: "discard", desc: "Reverts the 2 commits on <b>#1300</b>", record: "Reverted the 2 commits on #1300" },
          ],
        },
        sendBackHint: "You may edit .github/workflows/test.yml",
        worldWait: "Closes when #1300 merges",
        worldPlan: [],
      },
      {
        id: "y1",
        title: "Discount codes ignore letter case",
        colleague: "Fix bug",
        project: ["webshop", "webshop"],
        yesterday: true,
        source: {
          brand: "github",
          kind: "Issue assigned to you",
          who: "Sanne",
          at: "Mon 18:31",
          where: "rogier/webshop #1281",
          quote: '<div class="quote-head"><b>Sanne</b><span>Mon 18:31</span></div><p>"summer10" is rejected, "SUMMER10" works. Customers type codes in lower case.</p>',
          facts: [],
          made: "1 event from GitHub · issue assigned",
        },
        handed: { at: "Mon 18:40", note: null, how: "Claude Code · Opus 5.5 · studio-mac" },
        phase: "closed",
        attempts: [
          {
            start: "18:40",
            notes: [["18:44", "Found it: codes are compared as typed"], ["18:58", "Lower-cased codes in <code>normalizeCode</code>; 25 checks passed"], ["19:02", "Opened draft pull request #1287"]],
            worked: "22m",
            tools: ["edited 2 files", "opened 1 draft pull request"],
            landedAt: "Mon 19:02",
            result: {
              type: "pr",
              gist: "PR #1287 · merged",
              number: "#1287",
              prTitle: "Discount codes ignore letter case",
              repo: "rogier/webshop",
              branch: "fix/discount-case",
              files: 2,
              plus: 9,
              minus: 2,
              checks: "25 passed",
              draft: false,
              diff: { file: "src/discounts/normalize.ts", lines: [["-", "  return code.trim();"], ["+", "  return code.toLowerCase();"]] },
            },
            sure: { level: 3, why: "Reproduced it with a failing test first.", unsure: [] },
            actions: [],
          },
        ],
        verdict: { label: "Merged #1287", at: "Mon 19:12", kind: "sign", chip: "Merged", attempt: 0 },
        world: [
          { at: "Mon 19:12", brand: "github", html: "#1287 merged into <code>main</code>", end: true },
          { at: "10:40", brand: "github", html: "#1287 reached acceptance" },
        ],
        closedLine: "Closed by GitHub: #1287 merged",
        later: { caseId: "h2", title: "Codes with a trailing space are rejected", line: "Pieter, today 08:58. Fix bug traced it back to this change." },
      },
      {
        id: "y2",
        title: "Wholesale order for Bakkerij Smit",
        colleague: "Draft reply",
        project: null,
        yesterday: true,
        source: {
          brand: "gmail",
          kind: "Mail",
          who: "Pieter",
          org: "Bakkerij Smit",
          at: "Mon 18:12",
          where: "rogier@personal",
          quote: '<div class="quote-head"><b>Pieter</b><span>Bakkerij Smit · Mon 18:12</span></div><p>Can we move Thursday\'s wholesale order to Friday morning? The oven is out until then.</p>',
          facts: [],
          made: "1 mail from Pieter",
        },
        handed: { at: "Mon 18:40", note: null, how: "Claude Code · Haiku 4.5 · build-box-2" },
        phase: "closed",
        attempts: [
          {
            start: "18:40",
            notes: [["18:41", "Read Pieter's mail and the order in the webshop"], ["18:42", "Drafted the reply and saved it in Gmail Drafts"]],
            worked: "2m",
            tools: ["read 2 mails", "saved 1 draft"],
            landedAt: "Mon 18:42",
            result: {
              type: "mail",
              gist: "Reply sent",
              to: "Pieter",
              subject: "Re: Wholesale order",
              body: ["Hi Pieter,", "No problem: the order now goes out Friday at 07:00. Good luck with the oven!", "Rogier"],
              attachment: null,
              saved: "Sent",
            },
            sure: { level: 3, why: "The order and its new date are in the webshop.", unsure: [] },
            actions: [],
          },
        ],
        verdict: { label: "Sent the reply to Pieter", at: "Mon 18:44", kind: "sign", attempt: 0 },
        world: [{ at: "Mon 18:44", brand: "gmail", html: "Reply sent to <b>Pieter</b>", end: true }],
        closedLine: "Closed by Gmail: the reply went out",
      },
    ];
  }

  /* ------------------------------------------------------------------ the swarm: ten times today */

  /** Returns a small case for the swarm: one note, a short result and the plain answers. */
  function buildSmallCase(o) {
    return {
      id: o.id,
      title: o.title,
      colleague: o.colleague,
      isThread: !!o.isThread,
      project: o.project || null,
      source: { brand: o.brand, kind: o.kind, who: o.who, at: o.at, where: o.where, quote: '<div class="quote-head"><b>' + o.who + "</b><span>" + o.at + "</span></div><p>" + o.ask + "</p>", facts: [], made: "1 event from " + sourceName(o.brand) },
      handed: { at: o.handed, note: null, how: o.how || "Claude Code · Sonnet 5 · build-box-2" },
      phase: o.phase,
      seen: false,
      attempts: [
        {
          start: o.handed,
          notes: o.notes || [[o.handed, "Read the " + o.kind.toLowerCase()]],
          live: o.phase === "working" ? o.live : null,
          worked: o.worked || "6m",
          tools: [],
          landedAt: o.landed,
          failedAt: o.failedAt,
          failure: o.failure ? { why: o.failure, left: [] } : null,
          askedAt: o.askedAt,
          request: o.request,
          result: o.result,
          sure: o.sure || { level: 3, why: "Checked against the source.", unsure: [] },
          actions: o.actions || [
            { label: "Sign off", kind: "accent", key: "S", does: "sign", desc: "Marks the result signed off", record: "Signed off" },
            { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 2 with your note" },
          ],
        },
      ],
      worldWait: o.worldWait || "Closes when the source shows the end",
      worldPlan: [],
      verdict: o.verdict,
      closedLine: o.closedLine,
    };
  }

  function review(id, title, repo, who, comments, at) {
    return buildSmallCase({
      id: id,
      title: title,
      colleague: "Review PR",
      brand: "github",
      kind: "Review requested",
      who: who,
      at: at,
      where: repo,
      ask: "Could you take a look?",
      handed: at,
      landed: at,
      phase: "landed",
      result: { type: "review", gist: "Draft review · Approve" + (comments ? ", " + comments + (comments === 1 ? " comment" : " comments") : ""), verdict: comments ? "Approve, with " + comments + (comments === 1 ? " comment" : " comments") : "Approve", summary: "Small and well tested. Safe to merge.", comments: [] },
      actions: [
        { label: "Post review", kind: "accent", key: "S", does: "sign", desc: "Posts an approving review on <b>" + repo + "</b> as <b>GitHub · rogier</b>", record: "Posted the review" },
        { label: "Send back", key: "B", does: "sendback", desc: "Starts attempt 2 of <b>Review PR</b> with your note" },
      ],
    });
  }

  function working(id, title, colleague, brand, who, handed, live) {
    return buildSmallCase({ id: id, title: title, colleague: colleague, brand: brand, kind: "Signal", who: who, at: handed, where: "", ask: title, handed: handed, phase: "working", live: live });
  }

  /** Returns the swarm's cases and how the list bundles them. */
  function buildSwarm(base) {
    var byId = {};
    base.forEach(function (c) {
      byId[c.id] = c;
    });
    var cases = [
      byId.h6,
      buildSmallCase({
        id: "s-grafana",
        title: "Migrate ops dashboards",
        colleague: "Migrate ops dashboards",
        isThread: true,
        project: ["ops", "ops"],
        brand: "grafana",
        kind: "Alert",
        who: "Grafana",
        at: "08:20",
        where: "ops",
        ask: "Dashboards still on Grafana 9 stop loading on Friday.",
        handed: "08:30",
        phase: "needs",
        askedAt: "09:22",
        request: { q: "Keep the old Grafana folder?", short: "Keep the old Grafana folder?", answers: [{ label: "Keep it", kind: "accent", does: "allow", desc: "Leaves <b>Legacy</b> in place" }, { label: "Delete it", kind: "quiet", does: "deny", desc: "Deletes the 14 old dashboards" }] },
      }),
      byId.h1,
      review("s-r2", "Bump stripe-node to 14.2", "rogier/payments-api #1296", "Marta", 0, "09:18"),
      review("s-r3", "Cache the shipping rates", "rogier/webshop #1299", "Sanne", 1, "09:24"),
      review("s-r4", "Log idempotency key on retry", "rogier/payments-api #1297", "Jonas", 2, "09:30"),
      byId.h3,
      buildSmallCase({ id: "s-d2", title: "Late delivery to Utrecht", colleague: "Draft reply", brand: "gmail", kind: "Mail", who: "Noor de Wit", at: "08:50", where: "rogier@personal", ask: "Our order hasn't arrived.", handed: "09:10", landed: "09:12", phase: "landed", result: { type: "findings", gist: "Reply drafted in Gmail", html: "<p>Drafted an apology with the new delivery date, Thursday.</p>" } }),
      buildSmallCase({ id: "s-d3", title: "Question about the API rate limit", colleague: "Draft reply", brand: "intercom", kind: "Conversation", who: "Lars", at: "08:55", where: "support", ask: "What is the rate limit?", handed: "09:14", landed: "09:16", phase: "landed", result: { type: "findings", gist: "Reply drafted in Intercom", html: "<p>Drafted a reply: 100 requests a minute, with a link to the docs.</p>" } }),
      byId.h2,
      byId.h7,
      byId.h5,
      buildSmallCase({ id: "s-f2", title: "Label new issues for webshop", colleague: "Label new issues", brand: "github", kind: "Issues opened", who: "GitHub", at: "09:00", where: "rogier/webshop", ask: "4 new issues.", handed: "09:00", failedAt: "09:03", phase: "failed", failure: "GitHub's rate limit was reached after 2 of 4 issues." }),
      buildSmallCase({ id: "s-f3", title: "Payout report for September", colleague: "Investigate", brand: "stripe", kind: "Payout", who: "Stripe", at: "08:40", where: "Stripe · live", ask: "Payout po_1Q8 is late.", handed: "08:45", failedAt: "09:15", phase: "failed", failure: "Stripe · live refused the read: the key lacks <code>payouts.read</code>." }),
    ];
    return {
      cases: cases,
      groups: [
        { key: "needs", label: "Needs you", you: true, total: 2, rows: [{ caseId: "h6" }, { caseId: "s-grafana" }] },
        {
          key: "verdict",
          label: "Awaiting your verdict",
          total: 9,
          rows: [
            { bundle: "reviews", colleague: "Review PR", title: "4 reviews, all approve", sub: "all sure · 14 of 14 signed off as they came", caseIds: ["h1", "s-r2", "s-r3", "s-r4"], unseen: true, age: "11m" },
            { bundle: "replies", colleague: "Draft reply", title: "3 replies drafted", sub: "1 unsure of a name", caseIds: ["h3", "s-d2", "s-d3"], unseen: true, age: "19m" },
            { caseId: "h2" },
            { caseId: "h7" },
          ],
        },
        {
          key: "working",
          label: "Working",
          total: 14,
          rows: [
            { bundle: "fix", colleague: "Fix bug", title: "6 at work", sub: "longest 34m · on webshop and payments-api", members: 6, age: "34m" },
            { bundle: "investigate", colleague: "Investigate", title: "5 at work", sub: "Refunds for partial captures, and 4 more", caseIds: ["h4"], members: 5, age: "8m" },
            { bundle: "drafts", colleague: "Draft reply", title: "3 at work", sub: "Marta, Jonas and Lars", members: 3, age: "2m" },
          ],
        },
        { key: "failed", label: "Failed", total: 3, rows: [{ caseId: "h5" }, { caseId: "s-f2" }, { caseId: "s-f3" }] },
        { key: "signed", label: "Signed off today", total: 10, rows: [{ bundle: "signed", colleague: "Review PR", title: "10 signed off", sub: "7 closed by their source · 3 waiting on it", members: 10, age: "" }] },
      ],
    };
  }

  /* ------------------------------------------------------------------ state */

  var cases = [];
  var byId = {};
  var swarm = null;
  var openId = null;
  var openBundle = null;
  var compareOpen = false;
  var events = [];
  var rendered = new Set();
  var animate = false;
  var seenTimer = null;
  var focusAnswer = false;

  function reset() {
    cases = buildCases();
    byId = {};
    cases.forEach(function (c) {
      byId[c.id] = c;
      c.attempts.forEach(function (a, i) {
        a.n = i + 1;
        a.startSec = parseClock(a.start);
        if (!a.state) a.state = c.phase === "working" ? "working" : c.phase === "needs" ? "needs" : c.phase === "failed" ? "failed" : "landed";
      });
      c.active = c.attempts.length - 1;
      c.world = c.world || [];
    });
    events = [];
    sim.t = 0;
    compareOpen = false;
    openBundle = null;
    // The two working runs go on from where 09:41 finds them.
    ["h4", "h7"].forEach(function (id) {
      var c = byId[id];
      scheduleScript(c, c.attempts[0], c.attempts[0].script, 0);
    });
    if (STATE === "empty") {
      cases = [];
      byId = {};
      events = [];
    }
    swarm = STATE === "swarm" ? buildSwarm(cases) : null;
    if (swarm) {
      swarm.cases.forEach(function (c) {
        if (byId[c.id]) return;
        byId[c.id] = c;
        c.attempts.forEach(function (a, i) {
          a.n = i + 1;
          a.startSec = parseClock(a.start);
          a.state = c.phase === "needs" ? "needs" : c.phase === "failed" ? "failed" : c.phase === "working" ? "working" : "landed";
        });
        c.active = 0;
        c.world = c.world || [];
      });
    }
    applyPresetState();
    rendered = new Set();
    animate = false;
    render();
    animate = true;
  }

  /** Sets up the URL's ?state= by playing Rogier's moves at earlier simulated times. */
  function applyPresetState() {
    var pick = params.get("case");
    if (STATE === "working") openId = "h4";
    else if (STATE === "landed") openId = "h1";
    else if (STATE === "seen") openId = "h2";
    else if (STATE === "failed") openId = "h5";
    else if (STATE === "redo") {
      openId = "h3";
      byId.h3.seen = true;
      byId.h3.composer = { text: byId.h3.sendBackHint };
    } else if (STATE === "retry") {
      openId = "h5";
      byId.h5.composer = { text: byId.h5.sendBackHint };
    } else if (STATE === "attempt2") {
      openId = "h3";
      byId.h3.seen = true;
      startAttempt(byId.h3, byId.h3.sendBackHint, -70);
      flushDue(false);
    } else if (STATE === "compare") {
      openId = "h3";
      byId.h3.seen = true;
      startAttempt(byId.h3, byId.h3.sendBackHint, -140);
      flushDue(false);
      answerRequest(byId.h3, "allow", -120);
      flushDue(false);
      byId.h3.seen = true;
      compareOpen = true;
    } else if (STATE === "closed") {
      openId = "h1";
      byId.h1.seen = true;
      takeAction(byId.h1, byId.h1.attempts[0].actions[0], -1200, 60);
      flushDue(false);
    } else if (STATE === "swarm") {
      openBundle = "reviews";
      openId = null;
    }
    if (pick && byId[pick]) {
      openId = pick;
      openBundle = null;
    }
    if (!openId && !openBundle) {
      var first = orderedCaseIds()[0];
      openId = first || null;
    }
  }

  /* ------------------------------------------------------------------ the simulation */

  /** Queues a function to run at simulated second `at`. Major events are the ones Next jumps to. */
  function schedule(at, fn, major) {
    events.push({ at: at, fn: fn, major: !!major });
    events.sort(function (a, b) {
      return a.at - b.at;
    });
  }

  /** Runs every queued event whose time has come, then draws the page when asked to. */
  function flushDue(draw) {
    var ran = false;
    while (events.length && events[0].at <= sim.t) {
      events.shift().fn();
      ran = true;
    }
    if (ran && draw !== false) render();
  }

  /** Queues an attempt's script, counted from simulated second `from`. */
  function scheduleScript(c, a, script, from) {
    (script || []).forEach(function (step) {
      var at = from + step.after;
      schedule(
        at,
        function () {
          var stamp = formatClock(START + at);
          if (step.note) {
            a.notes.push([stamp, step.note]);
            a.live = null;
          }
          if (step.live) a.live = step.live;
          if (step.ask) {
            a.state = "needs";
            a.askedAt = stamp;
            a.live = null;
            c.phase = "needs";
            if (c.id !== openId) showToast(c, "asks you something");
          }
          if (step.land) {
            a.state = "landed";
            a.landedAt = stamp;
            a.live = null;
            a.worked = formatDuration(START + at - a.startSec);
            c.phase = "landed";
            c.seen = c.id === openId;
            if (c.id !== openId) showToast(c, "landed");
          }
        },
        !!(step.land || step.ask),
      );
    });
  }

  /** Starts the next attempt with Rogier's note, at simulated second `from`. */
  function startAttempt(c, note, from) {
    if (from === undefined) from = sim.t;
    var prev = c.attempts[c.attempts.length - 1];
    prev.state = prev.state === "failed" ? "failed" : "sent-back";
    prev.sentBackAt = formatClock(START + from);
    // A case with its own next attempt plays that once; any other send back replays the result.
    var t = c.next && !c.nextUsed ? c.next : buildRepeat(prev);
    c.nextUsed = true;
    var a = {
      n: c.attempts.length + 1,
      start: formatClock(START + from),
      startSec: START + from,
      note: note,
      notes: [],
      live: null,
      tools: t.tools,
      request: t.request,
      afterAllow: t.afterAllow,
      result: t.result,
      sure: t.sure,
      actions: t.actions,
      state: "working",
    };
    c.attempts.push(a);
    c.active = c.attempts.length - 1;
    c.phase = "working";
    c.composer = null;
    compareOpen = false;
    scheduleScript(c, a, t.script, from);
    flushDue(false);
  }

  /** Returns a plain next attempt: it reads the note and lands the same kind of result again. */
  function buildRepeat(prev) {
    return {
      script: [
        { after: 0, live: "Reading your note" },
        { after: 2, note: "Read your note" },
        { after: 3, live: "Working your note in" },
        { after: 7, note: "Worked your note in" },
        { after: 7, land: true },
      ],
      tools: ["read your note"].concat(prev.tools || []),
      result: prev.result,
      sure: prev.sure,
      actions: prev.actions.filter(function (x) {
        return x.does !== "retry" && x.does !== "letgo";
      }),
    };
  }

  /** Answers the open attempt's question, at simulated second `at`. */
  function answerRequest(c, does, at) {
    if (at === undefined) at = sim.t;
    var a = c.attempts[c.attempts.length - 1];
    var stamp = formatClock(START + at);
    a.answered = { does: does, at: stamp };
    if (does === "allow") {
      a.state = "working";
      c.phase = "working";
      scheduleScript(c, a, a.afterAllow, at);
    } else {
      a.state = "failed";
      a.failedAt = stamp;
      a.failure = { why: "Stopped at your Deny. Nothing changed; the run needs this step to go on.", left: [] };
      a.actions = [
        { label: "Send back", kind: "accent", key: "B", does: c.next ? "retry" : "sendback", desc: "Starts another attempt with your note" },
        { label: "Take over", key: "T", does: "take", desc: "Opens the run's thread, to go on by hand" },
        { label: "Let it go", kind: "quiet", does: "letgo", desc: "Closes the case", record: "Let it go" },
      ];
      c.phase = "failed";
    }
  }

  /** Takes one of the attempt's answers, at simulated second `at`. */
  function takeAction(c, action, at, worldScale) {
    if (at === undefined) at = sim.t;
    var stamp = formatClock(START + at);
    var does = action.does;
    if (does === "sendback" || does === "retry") {
      c.composer = { text: "", fresh: true };
      return;
    }
    if (does === "edit") {
      toast(action.label + " opens the draft where it lives. The case stays here, waiting for your verdict.");
      return;
    }
    if (does === "also") {
      c.also = c.also || [];
      c.also.push({ label: action.record, at: stamp });
      toast(action.record + ".");
      return;
    }
    c.composer = null;
    c.verdict = { label: action.record || action.label, at: stamp, undo: action.undo, kind: does, chip: action.chip, attempt: c.active };
    if (does === "sign" || does === "hand") {
      c.phase = "signed";
      if (c.closesAtSignOff) {
        c.phase = "closed";
        c.closedLine = c.closesAtSignOff;
      } else {
        (c.worldPlan || []).forEach(function (w) {
          var wAt = at + w.after * (worldScale || 1);
          schedule(
            wAt,
            function () {
              if (c.phase !== "signed") return;
              c.world.push({ at: formatClock(START + wAt), brand: w.brand, html: w.html, end: w.end });
              if (w.end) {
                c.phase = "closed";
                c.closedLine = "Closed by " + sourceName(w.brand) + " at " + formatClock(START + wAt);
                if (c.id !== openId) showToast(c, "closed by " + sourceName(w.brand));
              }
            },
            true,
          );
        });
      }
    } else if (does === "take") {
      c.phase = "closed";
      c.closedLine = "Taken over: you go on in the thread";
      c.verdict.label = "You took over";
    } else {
      c.phase = "closed";
      c.closedLine = does === "letgo" ? "Let go. Nothing was sent" : "Closed at your call. Nothing was sent";
    }
  }

  function undoVerdict(c) {
    c.phase = "landed";
    c.seen = true;
    c.world = [];
    var undo = c.verdict.undo;
    c.verdict = null;
    c.closedLine = null;
    // Drops the world's queued events for this case: their guard sees the phase is no longer signed.
    toast("Undone. " + undo + ".");
  }

  /* ------------------------------------------------------------------ reading the cases */

  var GROUPS = [
    { key: "needs", label: "Needs you", you: true },
    { key: "verdict", label: "Awaiting your verdict" },
    { key: "working", label: "Working" },
    { key: "failed", label: "Failed" },
    { key: "signed", label: "Signed off" },
    { key: "closed", label: "Closed today" },
    { key: "yesterday", label: "Yesterday" },
  ];

  /** Returns the group a case belongs in: what it asks of Rogier now. */
  function groupOf(c) {
    if (c.yesterday) return "yesterday";
    return { needs: "needs", landed: "verdict", working: "working", failed: "failed", signed: "signed", closed: "closed" }[c.phase];
  }

  /** Returns the cases of one group in the order the list draws them. */
  function casesIn(key) {
    var list = cases.filter(function (c) {
      return groupOf(c) === key;
    });
    if (key === "verdict")
      list.sort(function (a, b) {
        return Number(a.seen) - Number(b.seen) || (b.attempts[b.active].landedAt || "").localeCompare(a.attempts[a.active].landedAt || "");
      });
    return list;
  }

  function orderedCaseIds() {
    if (swarm) {
      var ids = [];
      swarm.groups.forEach(function (g) {
        g.rows.forEach(function (r) {
          ids.push(r.bundle ? "bundle:" + r.bundle : r.caseId);
        });
      });
      return ids;
    }
    var out = [];
    GROUPS.forEach(function (g) {
      casesIn(g.key).forEach(function (c) {
        out.push(c.id);
      });
    });
    return out;
  }

  function lastAttempt(c) {
    return c.attempts[c.attempts.length - 1];
  }

  /** Returns the pose of a case's colleague: what its last attempt is doing. */
  function poseOf(c) {
    return { needs: "waiting", working: "working", landed: "done", failed: "failed", signed: "done", closed: "idle" }[c.phase] || "idle";
  }

  /** Returns how far the story has got, for the trail glyph: one class per station. */
  function glyphOf(c) {
    var past = { working: 2, needs: 2, landed: 4, failed: 2, signed: 5, closed: 6 }[c.phase];
    var cls = [];
    for (var i = 0; i < 6; i++) {
      if (i < past) cls.push("is-past");
      else if (i === past) cls.push(c.phase === "needs" || c.phase === "landed" ? "is-you" : c.phase === "failed" ? "is-fail" : "is-now");
      else cls.push("");
    }
    return '<span class="glyph" aria-hidden="true">' + cls.map(function (k) {
      return '<i class="' + k + '"></i>';
    }).join("") + "</span>";
  }

  /** Returns the seconds since the moment a row's age counts from. */
  function ageFrom(c) {
    var a = lastAttempt(c);
    if (c.phase === "needs") return parseClock(a.askedAt);
    if (c.phase === "working") return a.startSec;
    if (c.phase === "landed") return parseClock(a.landedAt);
    if (c.phase === "failed") return parseClock(a.failedAt);
    return null;
  }

  /** Returns the row's second line: what the case says about itself now. */
  function rowLine(c) {
    var a = lastAttempt(c);
    var mark = brand(c.source.brand, 12);
    if (c.phase === "needs") return '<span class="cf-row-sub is-you">' + Crew.mark("waiting", 12) + "<span>" + a.request.short + "</span></span>";
    if (c.phase === "failed") return '<span class="cf-row-sub is-fail">' + Crew.mark("failed", 12) + "<span>" + (a.answered ? "Stopped at your Deny" : stripTags(a.failure.why).split(".")[0]) + "</span></span>";
    if (c.phase === "working") return '<span class="cf-row-sub">' + mark + "<span>" + c.colleague + " · " + stripTags(a.live || (a.notes.length ? a.notes[a.notes.length - 1][1] : "Starting")) + "</span></span>";
    if (c.phase === "landed") return '<span class="cf-row-sub">' + mark + "<span>" + (a.n > 1 ? "Attempt " + a.n + " · " : "") + a.result.gist + "</span></span>";
    if (c.phase === "signed") return '<span class="cf-row-sub">' + mark + "<span>" + c.worldWait + "</span></span>";
    return '<span class="cf-row-sub">' + mark + "<span>" + (c.closedLine || c.verdict.label) + "</span></span>";
  }

  function stripTags(html) {
    return html.replace(/<[^>]+>/g, "");
  }

  /** Returns " is-new" the first time a key is drawn after the page settled, so it plays its motion once. */
  function fresh(key, cls) {
    if (rendered.has(key)) return "";
    rendered.add(key);
    return animate ? " " + (cls || "is-new") : "";
  }

  /* ------------------------------------------------------------------ the list */

  function renderRow(c) {
    var from = ageFrom(c);
    var age = from === null ? (c.verdict ? c.verdict.at.replace(/ \d\d:\d\d$/, "") : "") : '<span data-age="' + from + '">' + formatAge(nowSec() - from) + "</span>";
    var unseen = c.phase === "landed" && !c.seen ? '<i class="cf-unseen" title="Not seen yet"></i>' : "";
    return (
      '<button class="cf-row' + (c.id === openId ? " is-on" : "") + (c.phase === "closed" ? " is-closed" : "") + fresh("row:" + c.id + ":" + groupOf(c), "is-arriving") + '" data-open="' + c.id + '">' +
      '<span class="cf-row-face">' + face(c.colleague, poseOf(c), 28) + "</span>" +
      '<span class="cf-row-text"><span class="cf-row-title">' + c.title + "</span>" + rowLine(c) + "</span>" +
      '<span class="cf-row-end"><span class="cf-row-age">' + unseen + age + "</span>" + glyphOf(c) + "</span></button>"
    );
  }

  function renderBundleRow(r) {
    var members = r.members || r.caseIds.length;
    var faces = '<span class="stack">' + [0, 1, 2].slice(0, Math.min(3, members)).map(function () {
      return face(r.colleague, r.bundle === "signed" ? "idle" : r.bundle === "reviews" || r.bundle === "replies" ? "done" : "working", 24);
    }).join("") + "</span>";
    var unseen = r.unseen ? '<i class="cf-unseen" title="Not seen yet"></i>' : "";
    return (
      '<button class="cf-row cf-row--bundle' + (openBundle === r.bundle ? " is-on" : "") + '" data-bundle="' + r.bundle + '">' +
      '<span class="cf-row-face">' + faces + "</span>" +
      '<span class="cf-row-text"><span class="cf-row-title">' + whoName(r.colleague) + " · " + r.title + '</span><span class="cf-row-sub"><span>' + r.sub + "</span></span></span>" +
      '<span class="cf-row-end"><span class="cf-row-age">' + unseen + r.age + "</span></span></button>"
    );
  }

  function renderList() {
    var el = document.querySelector("[data-cf-list]");
    if (!cases.length) {
      el.innerHTML =
        '<div class="cf-empty"><p>Nothing handed off today.</p>' +
        '<div class="cf-ghost" aria-hidden="true">' +
        '<div class="cf-group">Awaiting your verdict</div>' +
        '<div class="cf-row"><span class="cf-row-face">' + face("Draft reply", "done", 28) + '</span><span class="cf-row-text"><span class="cf-row-title">A signal you handed to an agent</span><span class="cf-row-sub">' + brand("gmail", 12) + "<span>What it made for you</span></span></span>" +
        '<span class="cf-row-end"><span class="cf-row-age"><i class="cf-unseen"></i>2m</span><span class="glyph"><i class="is-past"></i><i class="is-past"></i><i class="is-past"></i><i class="is-past"></i><i class="is-you"></i><i></i></span></span></div>' +
        "</div></div>";
      return;
    }
    if (swarm) {
      el.innerHTML = swarm.groups.map(function (g) {
        return (
          '<h2 class="cf-group' + (g.you ? " cf-group--you" : "") + '"><span>' + g.label + '</span><b class="count' + (g.you ? " count--you" : "") + '">' + g.total + "</b></h2>" +
          '<div class="cf-rows">' + g.rows.map(function (r) {
            return r.bundle ? renderBundleRow(r) : renderRow(byId[r.caseId]);
          }).join("") + "</div>"
        );
      }).join("") + '<p class="cf-foot">38 handoffs today in 13 rows: a colleague\'s cases of one kind share a row.</p>';
      return;
    }
    el.innerHTML = GROUPS.map(function (g) {
      var list = casesIn(g.key);
      if (!list.length) return "";
      return (
        '<h2 class="cf-group' + (g.you ? " cf-group--you" : "") + '"><span>' + g.label + '</span><b class="count' + (g.you ? " count--you" : "") + '">' + list.length + "</b></h2>" +
        '<div class="cf-rows">' + list.map(renderRow).join("") + "</div>"
      );
    }).join("");
  }

  /* ------------------------------------------------------------------ the open case */

  function renderHead(c) {
    var openRun = c.isThread
      ? '<a class="btn btn--quiet" href="../../crew-bureau-2/desktop/session-active.html">' + icon("threads", 14) + "Open thread</a>"
      : '<a class="btn btn--quiet" href="../../crew-bureau-2/desktop/run.html" title="The run\'s graph, steps and transcripts">' + icon("runs", 14) + "Open run</a>";
    var attempts = "";
    if (c.attempts.length > 1) {
      attempts =
        '<div class="ch-attempts"><span class="seg" role="group" aria-label="Attempts">' +
        c.attempts.map(function (x, i) {
          var word = { "sent-back": "sent back", working: "working", needs: "needs you", landed: "landed", failed: "failed", dropped: "not kept" }[x.state] || x.state;
          return '<button type="button" data-attempt="' + i + '" aria-pressed="' + (!compareOpen && i === c.active) + '">' + markOrSpace(x, 12) + "Attempt " + x.n + " <small>" + word + "</small></button>";
        }).join("") +
        '</span><button class="btn btn--sm' + (compareOpen ? " is-on" : "") + '" data-compare' + (canCompare(c) ? "" : ' aria-disabled="true" title="Compare opens once attempt ' + c.attempts.length + ' lands"') + ">" + icon("diff", 14) + "Compare <kbd>C</kbd></button></div>";
    }
    return (
      '<div class="ch-kind"><span class="src">' + brand(c.source.brand, 14) + sourceName(c.source.brand) + "</span><span>·</span><span>" + c.source.kind + '</span><span class="spacer"></span>' +
      openRun +
      (c.source.brand === "triage" ? "" : '<button class="btn btn--quiet" data-open-source>' + icon("external", 14) + "Open on " + sourceName(c.source.brand) + "</button>") +
      "</div>" +
      '<h1 class="ch-title">' + c.title + "</h1>" +
      '<p class="ch-asked"><span>' + c.source.who + (c.source.org ? " at " + c.source.org : "") + " · " + c.source.at + (c.source.where ? " · " + c.source.where : "") + "</span>" +
      (c.project ? '<span class="proj proj--' + c.project[1] + '">' + c.project[0] + "</span>" : "") +
      "</p>" +
      attempts
    );
  }

  /** Returns an attempt's state mark, or an empty slot of its size for an attempt that was superseded. */
  function markOrSpace(a, size) {
    var m = attemptMark(a);
    return m ? Crew.mark(m, size) : '<span class="mark-space" style="width:' + size + 'px"></span>';
  }

  function attemptMark(a) {
    return { working: "working", needs: "waiting", landed: "done", failed: "failed" }[a.state] || null;
  }

  function canCompare(c) {
    var withResults = c.attempts.filter(function (a) {
      return a.result && (a.state === "landed" || a.state === "sent-back" || a.state === "dropped");
    });
    return withResults.length >= 2 && withResults.every(function (a) {
      return a.result && a.result.type === "mail";
    });
  }

  /** Returns one station of the trail. */
  function station(o) {
    return (
      '<section class="st' + (o.future ? " is-future" : "") + (o.key ? fresh(o.key) : "") + '"' + (o.current ? " data-current" : "") + (o.answers ? " data-answers" : "") + ">" +
      '<div class="st-node' + (o.nodeClass ? " " + o.nodeClass : "") + '">' + o.node + "</div>" +
      '<div class="st-body"><h3 class="st-h">' + o.head + "</h3>" + (o.body || "") + "</div></section>"
    );
  }

  /** Returns what came in. Once the run has landed, the message folds to one line: the result matters now. */
  function cameIn(c) {
    var s = c.source;
    var folded = c.phase !== "working" && c.phase !== "needs" && !c.cameInOpen;
    if (folded) {
      return station({
        node: brand(s.brand, 16),
        head: "Came in <time>" + s.at + "</time>",
        body: '<button type="button" class="fold-line" data-unfold>' + "<b>" + s.who + "</b><span>" + stripTags(s.quote.replace(/^.*?<p>/, "<p>")) + "</span>" + icon("chev-d", 12) + "</button>",
      });
    }
    return station({
      node: brand(s.brand, 16),
      head: "Came in <time>" + s.at + "</time>",
      body:
        '<div class="quote">' + s.quote + "</div>" +
        (s.facts.length ? '<p class="facts">' + s.facts.join("") + "</p>" : "") +
        '<p class="made-from">Made from <b>' + s.made + "</b></p>",
    });
  }

  function handedOff(c) {
    var h = c.handed;
    var trust = "";
    if (h.trust) {
      trust = '<span class="sep">·</span><span title="' + c.colleague + ', last 30 days">' + h.trust[2] + "</span>";
    }
    return station({
      node: Crew.you(28),
      nodeClass: "st-node--bare",
      head: (h.started ? "You started " : "You handed it to ") + whoName(c.colleague) + " <time>" + h.at + "</time>",
      body:
        '<p class="who-line"><span>' + h.how + "</span>" + trust + "</p>" +
        (h.note ? '<div class="note">' + Crew.you(20) + "<span>" + h.note + "</span></div>" : ""),
    });
  }

  function notesList(c, a, live) {
    return (
      '<ol class="notes">' +
      a.notes.map(function (n, i) {
        return '<li class="' + fresh(c.id + ":a" + a.n + ":n" + i).trim() + '"><time>' + n[0] + "</time><span>" + n[1] + "</span></li>";
      }).join("") +
      (live && a.live ? '<li class="is-live' + fresh(c.id + ":a" + a.n + ":live:" + a.live) + '"><time>' + formatClock(nowSec()) + "</time><span>" + a.live + "…</span></li>" : "") +
      "</ol>"
    );
  }

  function workedLine(c, a, label) {
    var open = c.toolsOpen === a.n;
    return (
      '<div class="worked' + (open ? " is-open" : "") + '"><button type="button" data-tools="' + a.n + '">' + label + icon("chev-r", 12) + "</button></div>" +
      (open ? '<ul class="tools">' + a.tools.map(function (t) {
        return "<li>" + t + "</li>";
      }).join("") + "</ul>" : "")
    );
  }

  /** Returns the run's station: the colleague's notes, live while it works, folded once it landed. */
  function run(c, a, isOpen) {
    var pose = { working: "working", needs: "waiting", landed: "done", "sent-back": "idle", dropped: "idle", failed: "failed" }[a.state];
    var live = a.state === "working";
    var head, body;
    if (live) {
      head = whoName(c.colleague) + ' <span class="st-elapsed">is working</span><span class="spacer"></span><span class="st-when" data-since="' + a.startSec + '">' + formatDuration(nowSec() - a.startSec) + "</span>";
      body = notesList(c, a, true) + workedLine(c, a, "<b>Tool calls</b>");
    } else if (a.state === "needs") {
      head = whoName(c.colleague) + ' <span class="st-h-you">asks you</span><span class="spacer"></span><span class="st-when">since ' + a.askedAt + ' · <span data-age="' + parseClock(a.askedAt) + '">' + formatAge(nowSec() - parseClock(a.askedAt)) + "</span></span>";
      body =
        notesList(c, a, false) +
        '<div class="ask' + fresh(c.id + ":a" + a.n + ":ask") + '"><p class="ask-q">' + a.request.q + '</p><div class="ledger">' +
        a.request.answers.map(function (x, i) {
          return answerRow(x, "data-answer=\"" + i + "\"", i === 0 && focusAnswer);
        }).join("") +
        "</div></div>";
    } else if (a.state === "failed") {
      head = whoName(c.colleague) + ' <span class="st-h-fail">stopped</span><span class="spacer"></span><span class="st-when">' + a.failedAt + " · after " + (a.worked || formatDuration(parseClock(a.failedAt) - a.startSec)) + "</span>";
      body =
        notesList(c, a, false) +
        '<div class="stopped">' + a.failure.why + "</div>" +
        (a.failure.left.length ? '<p class="left-behind">' + a.failure.left.join("") + "</p>" : "");
    } else {
      // Landed: the notes fold into one line, because the result is what matters now.
      var opened = c.notesOpen === a.n;
      head = whoName(c.colleague) + ' <span class="st-elapsed">worked ' + a.worked + "</span>";
      body = opened
        ? notesList(c, a, false) + workedLine(c, a, "Worked for <b>" + a.worked + "</b>")
        : '<button type="button" class="notes-fold" data-notes="' + a.n + '">' + a.notes.length + " notes · " + stripTags(a.tools.join(" · ")) + icon("chev-r", 12) + "</button>";
    }
    return station({
      current: c.attempts[c.active] === a && (a.state === "needs" || a.state === "failed" || a.state === "working"),
      node: face(c.colleague, pose, 32),
      nodeClass: "st-node--bare" + (live && isOpen ? " st-node--live" : ""),
      head: head,
      body: body,
    });
  }

  function answerRow(x, attr, focused) {
    var cls = x.kind === "accent" ? "btn btn--accent" : x.kind === "danger" ? "btn btn--danger" : x.kind === "quiet" ? "btn btn--quiet" : "btn";
    return (
      '<div class="ans' + (focused ? " is-focus" : "") + '"><button type="button" class="' + cls + '" ' + attr + (focused ? " data-focus-me" : "") + ">" + x.label + "</button>" +
      '<span class="ans-desc">' + x.desc + "</span>" + (x.key ? "<kbd>" + x.key + "</kbd>" : "<span></span>") + "</div>"
    );
  }

  function sureBlock(s) {
    if (!s) return "";
    var word = ["", "Low", "Medium", "High"][s.level];
    return (
      '<div class="sure"><span class="sure-level"><span class="sure-steps" data-level="' + s.level + '"><i></i><i></i><i></i></span>' + word + " confidence</span>" +
      '<span class="sure-why">' + s.why + "</span>" +
      (s.unsure.length ? '<ul class="unsure">' + s.unsure.map(function (u) {
        return "<li>" + icon("question", 14) + "<span>" + u + "</span></li>";
      }).join("") + "</ul>" : "") +
      "</div>"
    );
  }

  /** Returns the paragraphs of a letter as HTML, marking the word the colleague was unsure of. */
  function letterParagraphs(body, unsureWord) {
    return body.map(function (p) {
      var html = p.replace(/\n/g, "<br />");
      if (unsureWord) html = html.replace(unsureWord, '<span class="unsure-word" title="A guess">' + unsureWord + "</span>");
      return "<p>" + html + "</p>";
    }).join("");
  }

  function prCard(r, chip) {
    var head =
      '<div class="res-h">' + brand("github", 16) + "<b>" + r.number + "</b><span>" + r.prTitle + '</span><span class="spacer"></span>' +
      (chip ? '<span class="chip">' + chip + "</span>" : "") + "</div>";
    var facts =
      '<div class="res-sec"><p class="facts">' +
      "<span>" + icon("branch", 14) + "<code>" + r.branch + "</code></span>" +
      (r.pushed ? "<span>" + r.pushed + "</span>" : "") +
      "<span>" + r.files + ' files <span class="plus">+' + r.plus + '</span> <span class="minus">−' + r.minus + "</span></span>" +
      '<span class="ok-ink">' + icon("check", 14) + r.checks + "</span></p></div>";
    var diff = r.diff
      ? '<pre class="diff"><div class="diff-file">' + r.diff.file + "</div>" + r.diff.lines.map(function (l) {
          return '<span class="' + (l[0] === "+" ? "is-add" : l[0] === "-" ? "is-del" : "") + '">' + l[0] + " " + l[1].replace(/</g, "&lt;") + "</span>";
        }).join("") + "</pre>"
      : "";
    var cause = r.cause
      ? '<div class="res-sec"><span class="res-label">Cause</span>' +
        '<button type="button" class="link-case" data-open="' + r.cause.caseId + '">' + face("Fix bug", "idle", 24) +
        '<span class="link-case-text"><b>' + r.cause.ref + " " + r.cause.title + "</b><small>" + r.cause.line + "</small></span>" + icon("chev-r", 14) + "</button></div>"
      : "";
    var reply = r.reply
      ? '<div class="res-sec"><span class="res-label">Also drafted, not sent</span><div class="quote" style="margin:0"><div class="quote-head">' + brand("slack", 12) + "<b>Reply to " + r.reply.to + "</b><span>" + r.reply.where + "</span></div><p>" + r.reply.text + "</p></div></div>"
      : "";
    var grant = r.grant ? '<div class="res-sec"><p class="grant">' + icon("shield", 14) + "<span>" + r.grant + "</span></p></div>" : "";
    return head + facts + diff + cause + reply + grant;
  }

  /** Returns the word on a result's chip: what the verdict did to it, once given, or its state before. */
  function chipFor(c, a, before) {
    if (c.verdict && c.verdict.attempt === c.attempts.indexOf(a) && c.verdict.chip) return c.verdict.chip;
    return before;
  }

  function resultCard(c, a) {
    var r = a.result;
    var inner = "";
    if (r.type === "review") {
      inner =
        '<div class="res-h">' + icon("eye", 16) + "<b>Draft review</b><span>" + r.verdict + '</span><span class="spacer"></span><span class="chip">' + chipFor(c, a, "Not posted") + "</span></div>" +
        '<div class="res-sec"><p>' + r.summary + "</p></div>" +
        r.comments.map(function (m) {
          return '<div class="rc">' + icon("file", 14) + '<code class="rc-path">' + m.path + (m.line ? ":" + m.line : "") + "</code><p>" + m.text + "</p></div>";
        }).join("");
    } else if (r.type === "pr") {
      inner = prCard(r, chipFor(c, a, r.draft ? "Draft" : ""));
    } else if (r.type === "mail") {
      inner =
        '<div class="res-h">' + brand("gmail", 16) + "<b>Reply</b><span>" + r.subject + '</span><span class="spacer"></span><span class="chip">' + chipFor(c, a, r.saved) + "</span></div>" +
        '<p class="letter-env">To <b>' + r.to + "</b> · from Gmail · rogier@personal</p>" +
        '<div class="letter-body">' + letterParagraphs(r.body, r.unsureWord) +
        (r.attachment ? '<p><span class="attach">' + icon("file", 14) + r.attachment[0] + " <small>" + r.attachment[1] + "</small></span></p>" : "") +
        "</div>";
    } else {
      inner = '<div class="res-h">' + icon("search", 16) + "<b>Findings</b></div>" + '<div class="res-sec">' + r.html + "</div>" + (r.diff ? '<pre class="diff"><div class="diff-file">' + r.diff.file + "</div>" + r.diff.lines.map(function (l) {
        return '<span class="' + (l[0] === "+" ? "is-add" : "is-del") + '">' + l[0] + " " + l[1] + "</span>";
      }).join("") + "</pre>" : "");
    }
    return '<div class="card res">' + inner + "</div>" + sureBlock(a.sure);
  }

  function landed(c, a) {
    return station({
      current: !c.verdict && !c.composer,
      key: c.id + ":a" + a.n + ":landed",
      node: Crew.mark("done", 16),
      nodeClass: "st-node--ok",
      head: "Landed <time>" + a.landedAt + "</time>" + (c.phase === "landed" && !c.seen ? '<span class="spacer"></span><span class="chip chip--you">New</span>' : ""),
      body: resultCard(c, a),
    });
  }

  function composer(c, a) {
    var failed = a.state === "failed";
    var nextN = c.attempts.length + 1;
    return (
      '<div class="card sendback"><textarea data-note placeholder="What should change? It goes to ' + c.colleague + ' as the head of attempt ' + nextN + '." rows="3">' + (c.composer.text || "") + "</textarea>" +
      '<div class="sendback-row"><span class="sendback-desc">Starts attempt <b>' + nextN + "</b> of <b>" + c.colleague + "</b>" + (failed ? " on the same branch" : ". Attempt " + a.n + " stays, to compare") + "</span>" +
      '<button type="button" class="btn btn--quiet btn--sm" data-cancel-note>Cancel</button><button type="button" class="btn btn--accent btn--sm" data-send-note>' + (failed ? "Try again" : "Send back") + " <kbd>⌘↩</kbd></button></div></div>"
    );
  }

  /** Returns the verdict station: the ledger while it waits on Rogier, then what he decided. */
  function verdictStation(c, a) {
    if (c.verdict) {
      var v = c.verdict;
      var undo = v.undo && c.phase !== "closed" ? '<button type="button" class="verdict-undo" data-undo>Undo: ' + v.undo.charAt(0).toLowerCase() + v.undo.slice(1) + "</button>" : "";
      var also = (c.also || []).map(function (x) {
        return '<p class="verdict-fine">' + x.label + " · " + x.at + "</p>";
      }).join("");
      var never = v.kind === "sign" && v.undo === null ? '<p class="verdict-fine">Sent mail can\'t be taken back.</p>' : "";
      var remaining = (a.actions || []).filter(function (x) {
        return x.does === "also" && !(c.also || []).some(function (y) {
          return y.label === x.record;
        });
      });
      return station({
        key: c.id + ":verdict",
        node: Crew.you(28),
        nodeClass: "st-node--bare",
        head: "Your verdict <time>" + v.at + "</time>",
        body:
          '<p class="verdict"><span class="chip' + (v.kind === "sign" || v.kind === "hand" ? " chip--ok" : "") + '">' + (v.kind === "sign" ? icon("check", 12) + "Signed off" : v.kind === "hand" ? icon("arrow", 12) + "Handed on" : v.kind === "take" ? "Taken over" : "Let go") + "</span><span>" + v.label + "</span>" + undo + "</p>" +
          also + never +
          (remaining.length && c.phase !== "closed" ? '<div class="ledger">' + remaining.map(function (x) {
            return answerRow(x, 'data-action="' + a.actions.indexOf(x) + '"');
          }).join("") + "</div>" : ""),
      });
    }
    var waiting = a.state === "landed" || a.state === "failed";
    if (!waiting) return station({ future: true, node: icon("user", 14), head: "Your verdict" });
    var body = c.composer
      ? composer(c, a)
      : '<div class="ledger">' + a.actions.map(function (x, i) {
          return answerRow(x, 'data-action="' + i + '"', focusAnswer && x.kind === "accent");
        }).join("") + "</div>";
    return station({
      answers: true,
      current: !!c.composer,
      key: c.id + ":a" + a.n + ":verdict",
      node: Crew.you(28),
      nodeClass: "st-node--bare",
      head: (a.state === "failed" ? "Your call" : "Your verdict") + ' <span class="st-h-you">waits on you</span>',
      body: body,
    });
  }

  function worldStation(c) {
    var src = sourceName(c.source.brand);
    if (c.phase === "closed" && !c.world.length) {
      return station({
        current: true,
        answers: true,
        node: Crew.mark("done", 16),
        nodeClass: "st-node--ok",
        head: "Closed",
        body: '<p class="st-meta">' + c.closedLine + "</p>",
      });
    }
    if (!c.world.length && c.phase !== "signed") {
      return station({ future: true, node: brand(c.source.brand, 14), head: "In the world", body: c.worldWait ? '<p class="st-meta">' + c.worldWait + "</p>" : "" });
    }
    var items = c.world.map(function (w, i) {
      return '<li class="' + (w.end ? "is-end" : "") + fresh(c.id + ":w" + i) + '">' + brand(w.brand, 14) + "<span>" + w.html + "</span><time>" + w.at + "</time></li>";
    }).join("");
    var tail =
      c.phase === "closed"
        ? '<p class="closed-line' + fresh(c.id + ":closed") + '">' + Crew.mark("done", 14) + "<span>" + c.closedLine + "</span></p>"
        : '<p class="closed-line">' + Crew.mark("working", 14) + "<span>" + c.worldWait + '</span><span class="spacer"></span><button type="button" class="verdict-undo" data-close-case>Close it now</button></p>';
    var later = c.later
      ? '<button type="button" class="link-case" data-open="' + c.later.caseId + '">' + face("Fix bug", "done", 24) + '<span class="link-case-text"><b>Later: ' + c.later.title + "</b><small>" + c.later.line + "</small></span>" + icon("chev-r", 14) + "</button>"
      : "";
    return station({
      current: true,
      answers: true,
      node: brand(c.source.brand, 16),
      head: "In the world <span class=\"st-when\">as " + src + " shows it</span>",
      body: '<ul class="world">' + items + "</ul>" + tail + later,
    });
  }

  /** Returns the station that ends an attempt Rogier sent back, and links to the next one. */
  function sentBackStation(c, a) {
    var next = c.attempts[a.n];
    return station({
      node: Crew.you(28),
      nodeClass: "st-node--bare",
      head: "You " + (a.state === "failed" ? "tried again" : "sent it back") + " <time>" + a.sentBackAt + '</time><span class="spacer"></span><button type="button" class="st-link" data-attempt="' + a.n + '">Attempt ' + next.n + " ›</button>",
      body: '<div class="note">' + Crew.you(20) + "<span>" + next.note + "</span></div>",
    });
  }

  /** Returns attempt 1's place in a later attempt's trail: one line, with the way back. */
  function earlierAttempt(c, a) {
    return station({
      node: face(c.colleague, "idle", 32),
      nodeClass: "st-node--bare",
      head: whoName(c.colleague) + ' <span class="st-elapsed">attempt ' + a.n + "</span><span class=\"spacer\"></span><button type=\"button\" class=\"st-link\" data-attempt=\"" + (a.n - 1) + '">Show <kbd>[</kbd></button>',
      body: '<p class="st-meta">' + (a.state === "failed" ? "Stopped " + a.failedAt + ". " + stripTags(a.failure.why).split(".")[0] : "Landed " + a.landedAt + " · " + a.result.gist) + "</p>",
    });
  }

  function trail(c) {
    var a = c.attempts[c.active];
    var parts = [cameIn(c), handedOff(c)];
    // Earlier attempts fold to one line each, each followed by Rogier's note that ended it.
    for (var i = 0; i < c.active; i++) {
      parts.push(earlierAttempt(c, c.attempts[i]));
      parts.push(
        station({
          node: Crew.you(28),
          nodeClass: "st-node--bare",
          head: "You " + (c.attempts[i].state === "failed" ? "tried again" : "sent it back") + " <time>" + c.attempts[i].sentBackAt + "</time>",
          body: '<div class="note">' + Crew.you(20) + "<span>" + c.attempts[i + 1].note + "</span></div>",
        }),
      );
    }
    parts.push(run(c, a, c.id === openId));
    var resultState = a.state === "landed" || a.state === "sent-back" || a.state === "dropped";
    if (resultState) parts.push(landed(c, a));
    else if (a.state !== "failed") parts.push(station({ future: true, node: icon("check", 14), head: "Lands", body: "" }));
    if (a.state === "dropped") {
      parts.push(station({ node: Crew.you(28), nodeClass: "st-node--bare", head: "Not kept", body: '<p class="st-meta">You kept attempt ' + (c.attempts.filter(function (x) { return x.state === "landed"; })[0] || { n: "?" }).n + ". This draft was deleted.</p>" }));
    } else if (a.state === "sent-back") {
      parts.push(sentBackStation(c, a));
    } else if (a.state === "failed" && c.active < c.attempts.length - 1) {
      parts.push(sentBackStation(c, a));
    } else {
      parts.push(verdictStation(c, a));
      parts.push(worldStation(c));
    }
    // A station before one still to come draws its line dotted.
    var html = parts.join("");
    return '<div class="trail">' + markBeforeFuture(html) + "</div>";
  }

  /** Marks each station that sits just before a station still to come, so its line is dotted. */
  function markBeforeFuture(html) {
    var box = document.createElement("div");
    box.innerHTML = html;
    var sts = box.querySelectorAll(":scope > .st");
    for (var i = 0; i < sts.length - 1; i++) {
      if (sts[i + 1].classList.contains("is-future")) sts[i].classList.add("is-before-future");
    }
    return box.innerHTML;
  }

  /* ------------------------------------------------------------------ compare attempts */

  /** Splits text into words and whitespace, keeping paragraph and line breaks as their own tokens. */
  function tokenize(paragraphs) {
    var out = [];
    paragraphs.forEach(function (p, i) {
      if (i) out.push("¶");
      p.split(/(\n)/).forEach(function (part) {
        if (part === "\n") out.push("↵");
        else
          part.split(/\s+/).filter(Boolean).forEach(function (w) {
            out.push(w);
          });
      });
    });
    return out;
  }

  /** Returns the word diff of two letters as two HTML strings, by the longest common subsequence. */
  function diffWords(aParas, bParas) {
    var a = tokenize(aParas);
    var b = tokenize(bParas);
    var n = a.length;
    var m = b.length;
    var dp = [];
    for (var i = 0; i <= n; i++) {
      dp.push(new Array(m + 1).fill(0));
    }
    for (i = n - 1; i >= 0; i--)
      for (var j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var left = [];
    var right = [];
    i = 0;
    j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        left.push(["=", a[i]]);
        right.push(["=", b[j]]);
        i++;
        j++;
      } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
        right.push(["+", b[j]]);
        j++;
      } else {
        left.push(["-", a[i]]);
        i++;
      }
    }
    return [joinTokens(left, "del"), joinTokens(right, "ins")];
  }

  /** Joins diff tokens into paragraphs, wrapping runs of changed words in one mark. */
  function joinTokens(tokens, tag) {
    var html = "<p>";
    var run = [];
    var first = true;
    function flush() {
      if (!run.length) return;
      html += (first ? "" : " ") + "<" + tag + ' class="wd">' + run.join(" ") + "</" + tag + ">";
      first = false;
      run = [];
    }
    tokens.forEach(function (t) {
      var word = t[1];
      if (word === "¶" || word === "↵") {
        flush();
        html += word === "¶" ? "</p><p>" : "<br />";
        first = true;
        return;
      }
      if (t[0] === "=") {
        flush();
        html += (first ? "" : " ") + word;
        first = false;
      } else run.push(word);
    });
    flush();
    return html + "</p>";
  }

  function compareView(c) {
    var landedAttempts = c.attempts.filter(function (x) {
      return x.result && (x.state === "landed" || x.state === "sent-back" || x.state === "dropped");
    });
    var a = landedAttempts[landedAttempts.length - 2];
    var b = landedAttempts[landedAttempts.length - 1];
    var d = diffWords(a.result.body, b.result.body);
    function col(x, html, attach, cls) {
      var latest = x === b;
      return (
        '<div class="compare-col"><h3 class="compare-h">' + markOrSpace(x, 14) + "Attempt " + x.n + " <small>landed " + x.landedAt + '</small><span class="spacer"></span>' +
        '<button type="button" class="btn btn--sm' + (latest ? " btn--accent" : "") + '" data-keep="' + (x.n - 1) + '">Keep this one</button></h3>' +
        '<div class="card res"><div class="letter-body">' + html + '<p><span class="attach ' + cls + '">' + icon("file", 14) + attach + "</span></p></div></div>" +
        sureBlock(x.sure) +
        "</div>"
      );
    }
    return (
      '<div class="compare">' +
      '<div class="compare-note note">' + Crew.you(20) + "<span>" + b.note + "</span></div>" +
      col(a, d[0], a.result.attachment[0], "is-del") +
      col(b, d[1], b.result.attachment[0], "is-add") +
      '<p class="compare-foot">Keeping one deletes the other draft from Gmail Drafts. Nothing is sent until your verdict.</p>' +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ a bundle's page */

  function renderBundle(key) {
    var r = null;
    swarm.groups.forEach(function (g) {
      g.rows.forEach(function (x) {
        if (x.bundle === key) r = x;
      });
    });
    var members = (r.caseIds || []).map(function (id) {
      return byId[id];
    });
    var rows = members.map(function (c) {
      var a = lastAttempt(c);
      var unseen = c.phase === "landed" && !c.seen;
      return (
        '<button type="button" class="bundle-row" data-open="' + c.id + '">' + brand(c.source.brand, 16) + face(c.colleague, poseOf(c), 24) +
        '<span class="cf-row-text"><b>' + c.title + "</b><small>" + c.source.where + " · " + (a.result ? a.result.gist : stripTags(a.live || "")) + "</small></span>" +
        '<span class="bundle-end">' + (a.sure && a.result ? '<span class="sure-steps" data-level="' + a.sure.level + '"><i></i><i></i><i></i></span>' : "") + (unseen ? '<i class="cf-unseen"></i>' : "") + (a.landedAt || a.start) + "</span></button>"
      );
    }).join("");
    var ledger = "";
    if (key === "reviews") {
      ledger =
        '<div class="bundle-ledger"><h3 class="st-h">Your verdict on all 4 <span class="st-h-you">waits on you</span></h3><div class="ledger">' +
        answerRow({ label: "Post all 4 reviews", kind: "accent", key: "S", desc: "Posts <b>4</b> approving reviews with <b>5 comments</b> in <b>rogier/payments-api</b> and <b>rogier/webshop</b> as <b>GitHub · rogier</b>" }, "data-bulk") +
        answerRow({ label: "One by one", desc: "Opens the first review; <b>J</b> moves to the next" }, 'data-open="h1"') +
        "</div></div>";
    } else if (r.members && r.members > members.length && members.length) {
      rows += '<p class="st-meta" style="margin-top:12px">and ' + (r.members - members.length) + " more at work. Each opens on its own once it lands or asks you something.</p>";
    } else if (!members.length) {
      rows = '<p class="st-meta" style="margin-top:16px">' + r.sub + ". Each opens on its own once it lands or asks you something.</p>";
    }
    return [
      '<div class="ch-kind"><span class="src">' + face(r.colleague, "idle", 16) + r.colleague + "</span><span>·</span><span>" + (r.caseIds ? r.caseIds.length : r.members) + " cases</span></div>" +
      '<h1 class="ch-title">' + r.title.charAt(0).toUpperCase() + r.title.slice(1) + "</h1>" +
      '<p class="ch-asked"><span>' + r.sub + "</span></p>",
      '<div class="bundle-rows">' + rows + "</div>" + ledger,
    ];
  }

  /* ------------------------------------------------------------------ the pane */

  var lastPaneKey = null;
  var lastCurrentKey = "";

  function renderPane() {
    var el = document.querySelector("[data-cf-pane]");
    var scroller = el.querySelector(".cf-scroll");
    var keep = scroller ? scroller.scrollTop : 0;
    var typing = document.activeElement && document.activeElement.matches("[data-note]");
    var caret = typing ? document.activeElement.selectionStart : 0;
    var paneKey = openBundle ? "bundle:" + openBundle : openId ? openId + ":" + (openId && byId[openId] ? byId[openId].active : "") + ":" + compareOpen : "none";
    var opening = paneKey !== lastPaneKey;
    if (opening) {
      // A case opened now draws still: only what changes while it is open plays its motion.
      animate = false;
    }
    var keys = '<div class="cf-keys"><span><kbd>J</kbd><kbd>K</kbd>cases</span><span><kbd>[</kbd><kbd>]</kbd>attempts</span><span><kbd>S</kbd>sign off</span><span><kbd>B</kbd>send back</span><span><kbd>T</kbd>take over</span><span><kbd>C</kbd>compare</span><span><kbd>O</kbd>open on the source</span></div>';
    if (!cases.length) {
      el.innerHTML =
        '<div class="cf-pane-empty"><div class="ghost-trail" aria-label="What a case holds">' +
        ["Came in", "Handed off", "Working", "Lands", "Your verdict", "In the world"].map(function (label, i) {
          return '<section class="st"><div class="st-node">' + icon(["intake", "user", "agent", "check", "eye", "globe"][i], 14) + '</div><div class="st-body"><h3 class="st-h">' + label + "</h3></div></section>";
        }).join("") +
        '</div><p>Hand a signal to an agent from <a href="../../intake-directions/asks/desktop/intake.html">Intake</a>, and its case opens here.</p></div>';
      lastPaneKey = paneKey;
      animate = true;
      return;
    }
    var head = "";
    var body = "";
    if (openBundle) {
      var parts = renderBundle(openBundle);
      head = parts[0];
      body = parts[1];
    } else if (openId) {
      var c = byId[openId];
      head = renderHead(c);
      body = compareOpen ? compareView(c) : trail(c);
    }
    var moving = opening && lastPaneKey !== null ? " is-opening" : "";
    el.innerHTML =
      '<div class="cf-scroll"><header class="ch"><div class="cf-col' + moving + '">' + head + "</div></header>" +
      '<div class="cf-col' + moving + '">' + body + "</div></div>" + keys;
    Crew.drawPlaceholders(el);
    var scroll = el.querySelector(".cf-scroll");
    // When the open case moves on to a new station, such as a landing, the pane follows it there.
    var cur = scroll.querySelector("[data-current]");
    var curKey = cur ? paneKey + ":" + Array.prototype.indexOf.call(cur.parentNode.children, cur) + ":" + cur.querySelector(".st-h").textContent.slice(0, 12) : "";
    if (opening) scrollToCurrent(scroll);
    else {
      scroll.scrollTop = keep;
      if (curKey && curKey !== lastCurrentKey && !typing) followCurrent(scroll);
    }
    lastCurrentKey = curKey;
    scroll.addEventListener(
      "scroll",
      function () {
        scroll.classList.toggle("is-scrolled", scroll.scrollTop > 0);
      },
      { passive: true },
    );
    scroll.classList.toggle("is-scrolled", scroll.scrollTop > 0);
    if (typing || (opening && openId && byId[openId] && byId[openId].composer)) {
      var t = el.querySelector("[data-note]");
      if (t) {
        t.focus();
        var at = typing ? caret : t.value.length;
        t.setSelectionRange(at, at);
      }
    }
    var f = el.querySelector("[data-focus-me]");
    if (f) {
      f.focus({ preventScroll: true });
      f.closest(".st, .ask").scrollIntoView({ block: "nearest" });
    }
    var note = el.querySelector("[data-note]");
    if (note && !typing && !opening && byId[openId].composer.fresh) {
      byId[openId].composer.fresh = false;
      note.focus({ preventScroll: true });
      note.closest(".sendback").scrollIntoView({ block: "nearest" });
    }
    lastPaneKey = paneKey;
    animate = true;
  }

  /**
   * Opens a case at its current station: the question, the result or the verdict. When the trail
   * above it would push the answers out of view, the pane scrolls so the station sits just under
   * the head, and scrolling up rewinds the story.
   */
  function scrollToCurrent(scroll) {
    var cur = scroll.querySelector("[data-current]");
    var head = scroll.querySelector(".ch");
    if (!cur || !head) return;
    // The answers are the ledger that waits on Rogier; the scroll brings their end into view, but
    // never past the current station's top.
    var answers = scroll.querySelector("[data-answers]") || cur;
    // Measured from the boxes on screen: offsetTop would count from the column while it plays
    // its opening motion, because a transformed element holds its children's offsets.
    var origin = scroll.getBoundingClientRect().top - scroll.scrollTop;
    var top = cur.getBoundingClientRect().top - origin - head.offsetHeight - 8;
    var need = answers.getBoundingClientRect().bottom - origin - scroll.clientHeight + 24;
    if (need > 0) scroll.scrollTop = Math.min(top, need);
  }

  /** Scrolls the open case to its new current station, smoothly, as far as scrollToCurrent would. */
  function followCurrent(scroll) {
    var from = scroll.scrollTop;
    scrollToCurrent(scroll);
    var to = scroll.scrollTop;
    if (to <= from) {
      scroll.scrollTop = from;
      return;
    }
    scroll.scrollTop = from;
    scroll.scrollTo({ top: to, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  /* ------------------------------------------------------------------ the shell around the screen */

  function renderSummary() {
    var sum = document.querySelector("[data-cf-sum]");
    var trust = document.querySelector("[data-cf-trust]");
    if (swarm) {
      sum.innerHTML = '<b>38</b> handoffs today · <b class="you-ink">2</b> need you · <b class="you-ink">9</b> to sign off';
      trust.innerHTML = "Last 30 days: <b>431 of 468</b> signed off as they came";
      return;
    }
    var today = cases.filter(function (c) {
      return !c.yesterday;
    });
    if (!today.length) {
      sum.textContent = "No handoffs today";
      trust.innerHTML = "Last 30 days: <b>46 of 52</b> signed off as they came";
      return;
    }
    var needs = casesIn("needs").length;
    var verdict = casesIn("verdict").length;
    sum.innerHTML =
      "<b>" + today.length + "</b> handoffs today" +
      (needs ? ' · <b class="you-ink">' + needs + "</b> " + (needs === 1 ? "needs" : "need") + " you" : "") +
      (verdict ? ' · <b class="you-ink">' + verdict + "</b> to sign off" : "");
    trust.innerHTML = "Last 30 days: <b>46 of 52</b> signed off as they came";
  }

  /** Adds the Cases row to the sidebar's Hercule face, and points its links at the book's pages. */
  function setUpSidebar() {
    var side = document.querySelector(".side");
    if (!side) return;
    side.dataset.tab = "hercule";
    side.querySelectorAll("[role=tab]").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.tab === "hercule"));
    });
    side.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href");
      if (href && href !== "#" && href.indexOf("/") === -1) a.setAttribute("href", "../../crew-bureau-2/desktop/" + href);
    });
    var intake = side.querySelector('a.nav-row[href$="intake.html"]');
    var row = document.createElement("a");
    row.className = "nav-row is-on";
    row.href = "index.html";
    row.setAttribute("aria-current", "page");
    row.innerHTML = icon("file") + '<span>Cases</span><b class="count count--you" data-cases-count></b>';
    intake.after(row);
  }

  /** Keeps the sidebar honest: the Cases count, and the waiting rows that the open cases change. */
  function renderSidebar() {
    var count = document.querySelector("[data-cases-count]");
    if (!count) return;
    var n = swarm ? 11 : casesIn("needs").length + casesIn("verdict").length;
    count.textContent = n ? String(n) : "";
    count.hidden = !n;
    // H6's thread waits on Rogier in the sidebar too; answering it here takes the row away there.
    var side = document.querySelector(".side");
    var h6 = byId.h6;
    side.querySelectorAll(".side-row--wait").forEach(function (r) {
      if (r.textContent.indexOf("Fix 3-D Secure checkout") !== -1) r.hidden = !!h6 && h6.phase !== "needs";
    });
    var h3 = byId.h3;
    var asking = h3 && h3.phase === "needs";
    var extra = side.querySelector("[data-cf-wait]");
    if (asking && !extra) {
      var sec = side.querySelector(".side-sec--you");
      sec.insertAdjacentHTML(
        "beforeend",
        '<h4 class="side-sub" data-cf-wait-h>From runs</h4><a class="side-row side-row--wait" href="#" data-cf-wait data-open-case="h3"><span class="side-lead">' + Crew.mark("waiting") + '</span><span class="side-text"><span class="side-name">Draft reply · draft</span><span class="side-ask">Void INV-2291 in Stripe?</span></span></a>',
      );
    } else if (!asking && extra) {
      extra.remove();
      side.querySelector("[data-cf-wait-h]").remove();
    }
    var visible = Array.prototype.filter.call(side.querySelectorAll(".side-row--wait"), function (r) {
      return !r.hidden;
    }).length;
    var badge = side.querySelector(".side-sec--you .count--you");
    if (badge && !swarm) badge.textContent = String(visible);
  }

  function render() {
    renderSummary();
    renderList();
    renderPane();
    renderSidebar();
    Crew.drawPlaceholders(document.querySelector("[data-cf-list]"));
    updateClockLabels();
    watchSeen();
  }

  /** Counts a landed case as seen once it has been open for two seconds, so J and K through the list clears no dots. */
  function watchSeen() {
    clearTimeout(seenTimer);
    var c = openId && byId[openId];
    if (!c || c.phase !== "landed" || c.seen) return;
    seenTimer = setTimeout(function () {
      c.seen = true;
      renderList();
      renderSummary();
      var chip = document.querySelector(".st .chip--you");
      if (chip) chip.remove();
    }, 2000);
  }

  /* ------------------------------------------------------------------ the toast */

  var toastTimer = null;

  function toast(html, caseId) {
    var el = document.querySelector("[data-cf-toast]");
    el.innerHTML = '<span class="cf-toast-text">' + html + "</span>" + (caseId ? '<button class="btn btn--sm" data-open="' + caseId + '">Open</button>' : "");
    el.hidden = false;
    el.classList.remove("is-new");
    void el.offsetWidth;
    el.classList.add("is-new");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, 5000);
  }

  function showToast(c, what) {
    if (!animate) return;
    toast(face(c.colleague, poseOf(c), 18) + " <b>" + c.colleague + "</b> " + what + ": " + c.title, c.id);
    var f = document.querySelector("[data-cf-toast] .cr");
    if (f) f.style.verticalAlign = "-4px";
  }

  /* ------------------------------------------------------------------ the clock */

  function updateClockLabels() {
    var now = nowSec();
    document.querySelectorAll("[data-since]").forEach(function (el) {
      el.textContent = formatDuration(now - Number(el.dataset.since));
    });
    document.querySelectorAll("[data-age]").forEach(function (el) {
      el.textContent = formatAge(now - Number(el.dataset.age));
    });
    var clock = document.querySelector("[data-proto-clock]");
    var s = START + sim.t;
    clock.textContent = formatClock(s) + ":" + String(s % 60).padStart(2, "0");
  }

  setInterval(function () {
    if (!sim.playing) return;
    sim.t++;
    flushDue();
    updateClockLabels();
  }, 1000);

  /* ------------------------------------------------------------------ moving around */

  function openCase(id) {
    if (id && id.indexOf("bundle:") === 0) {
      openBundle = id.slice(7);
      openId = null;
    } else {
      openId = id;
      openBundle = null;
    }
    compareOpen = false;
    focusAnswer = false;
    render();
    var on = document.querySelector(".cf-row.is-on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }

  function moveCase(step) {
    var ids = orderedCaseIds();
    var at = ids.indexOf(openBundle ? "bundle:" + openBundle : openId);
    var next = ids[Math.max(0, Math.min(ids.length - 1, at + step))];
    if (next) openCase(next);
  }

  function moveAttempt(step) {
    var c = openId && byId[openId];
    if (!c || c.attempts.length < 2) return;
    compareOpen = false;
    c.active = Math.max(0, Math.min(c.attempts.length - 1, c.active + step));
    render();
  }

  function currentAttempt() {
    var c = openId && byId[openId];
    return c ? c.attempts[c.active] : null;
  }

  function findAction(does) {
    var a = currentAttempt();
    if (!a || !a.actions) return -1;
    for (var i = 0; i < a.actions.length; i++) if (a.actions[i].does === does) return i;
    return -1;
  }

  function sendNote() {
    var c = byId[openId];
    var text = document.querySelector("[data-note]").value.trim();
    if (!text) {
      document.querySelector("[data-note]").focus();
      return;
    }
    startAttempt(c, text.replace(/</g, "&lt;"));
    render();
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("button, a");
    if (!t) return;
    if (t.matches("[data-open]")) {
      e.preventDefault();
      openCase(t.dataset.open);
      return;
    }
    if (t.matches("[data-open-case]")) {
      e.preventDefault();
      openCase(t.dataset.openCase);
      return;
    }
    if (t.matches("[data-bundle]")) return openCase("bundle:" + t.dataset.bundle);
    var c = openId && byId[openId];
    if (t.matches("[data-attempt]") && c) {
      compareOpen = false;
      c.active = Number(t.dataset.attempt);
      return render();
    }
    if (t.matches("[data-compare]") && c) {
      if (t.getAttribute("aria-disabled") === "true") return;
      compareOpen = !compareOpen;
      return render();
    }
    if (t.matches("[data-keep]") && c) {
      var keep = Number(t.dataset.keep);
      c.attempts.forEach(function (x, i) {
        if (i === keep) x.state = "landed";
        else if (x.result && x.state !== "failed") x.state = "dropped";
      });
      c.active = keep;
      // The kept attempt's answers become the case's again.
      c.phase = "landed";
      compareOpen = false;
      toast("Kept attempt " + (keep + 1) + ". The other draft is deleted from Gmail Drafts.");
      return render();
    }
    if (t.matches("[data-answer]") && c) {
      var x = lastAttempt(c).request.answers[Number(t.dataset.answer)];
      answerRequest(c, x.does);
      focusAnswer = false;
      return render();
    }
    if (t.matches("[data-action]") && c) {
      takeAction(c, c.attempts[c.active].actions[Number(t.dataset.action)]);
      focusAnswer = false;
      return render();
    }
    if (t.matches("[data-send-note]")) return sendNote();
    if (t.matches("[data-cancel-note]") && c) {
      c.composer = null;
      return render();
    }
    if (t.matches("[data-undo]") && c) {
      undoVerdict(c);
      return render();
    }
    if (t.matches("[data-close-case]") && c) {
      c.phase = "closed";
      c.closedLine = "Closed by you at " + formatClock(nowSec());
      return render();
    }
    if (t.matches("[data-tools]") && c) {
      c.toolsOpen = c.toolsOpen === Number(t.dataset.tools) ? null : Number(t.dataset.tools);
      return render();
    }
    if (t.matches("[data-unfold]") && c) {
      c.cameInOpen = true;
      return render();
    }
    if (t.matches("[data-notes]") && c) {
      c.notesOpen = Number(t.dataset.notes);
      return render();
    }
    if (t.matches("[data-open-source]") && c) {
      toast("Opens " + c.source.where + " on " + sourceName(c.source.brand) + ", in the default browser.");
      return;
    }
    if (t.matches("[data-bulk]")) {
      toast("Posted 4 reviews. Each case is signed off and waits for its pull request to merge.");
      return;
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target.matches("[data-note]") && openId) byId[openId].composer.text = e.target.value;
  });

  document.addEventListener("keydown", function (e) {
    var inField = e.target.matches("textarea, input, select");
    if (inField) {
      if (e.target.matches("[data-note]") && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendNote();
      } else if (e.key === "Escape" && e.target.matches("[data-note]")) {
        byId[openId].composer = null;
        render();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var c = openId && byId[openId];
    var key = e.key;
    // A letter key here is a command; it must not also type into the field it opens.
    if (/^[a-z[\]]$/.test(key)) e.preventDefault();
    if (key === "j" || key === "ArrowDown") {
      e.preventDefault();
      moveCase(1);
    } else if (key === "k" || key === "ArrowUp") {
      e.preventDefault();
      moveCase(-1);
    } else if (key === "[") moveAttempt(-1);
    else if (key === "]") moveAttempt(1);
    else if (key === "s" && c) {
      // S never answers in one press: it puts focus on the suggested answer, and Enter presses it.
      focusAnswer = true;
      render();
    } else if (key === "b" && c) {
      var i = findAction("sendback");
      if (i === -1) i = findAction("retry");
      if (i !== -1) {
        takeAction(c, c.attempts[c.active].actions[i]);
        render();
      }
    } else if (key === "t" && c) {
      var tk = findAction("take");
      if (tk !== -1) {
        takeAction(c, c.attempts[c.active].actions[tk]);
        render();
      } else toast("Take over opens the run's thread. " + c.colleague + " stops, and the case is yours.");
    } else if (key === "c" && c) {
      if (canCompare(c)) {
        compareOpen = !compareOpen;
        render();
      } else toast(c.attempts.length > 1 ? "Compare opens once attempt " + c.attempts.length + " lands." : "This case has one attempt.");
    } else if (key === "o" && c) toast("Opens " + c.source.where + " on " + sourceName(c.source.brand) + ", in the default browser.");
    else if (key === "Escape") {
      if (compareOpen) {
        compareOpen = false;
        render();
      } else if (focusAnswer) {
        focusAnswer = false;
        render();
      } else if (document.activeElement) document.activeElement.blur();
    }
  });

  /* ------------------------------------------------------------------ the prototype bar */

  function setUpProtoBar() {
    var play = document.querySelector("[data-proto-play]");
    play.addEventListener("click", function () {
      sim.playing = !sim.playing;
      play.innerHTML = icon(sim.playing ? "pause" : "play", 14);
      play.title = sim.playing ? "Pause the simulation" : "Play the simulation";
    });
    document.querySelector("[data-proto-next]").addEventListener("click", function () {
      var next = events.find(function (x) {
        return x.major;
      });
      if (!next) return toast("Nothing else is due. Send something back, or answer a question, to start more.");
      sim.t = Math.max(sim.t, next.at);
      flushDue();
      updateClockLabels();
    });
    document.querySelector("[data-proto-reset]").addEventListener("click", function () {
      lastPaneKey = null;
      openId = null;
      reset();
    });
    var pick = document.querySelector("[data-proto-state]");
    pick.value = STATE;
    pick.addEventListener("change", function () {
      var url = new URL(location.href);
      if (pick.value) url.searchParams.set("state", pick.value);
      else url.searchParams.delete("state");
      url.searchParams.delete("case");
      location.href = url.toString();
    });
    document.querySelector("[data-proto-theme]").addEventListener("click", function () {
      root.dataset.theme = root.dataset.theme === "orient-express" ? "whitehaven" : "orient-express";
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    setUpSidebar();
    setUpProtoBar();
    reset();
  });
})();
