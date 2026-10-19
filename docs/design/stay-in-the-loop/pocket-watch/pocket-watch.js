// PROTOTYPE - Pocket Watch: the watch in the menu bar, its case, the notifications each handoff's
// contract allows, the handoff contract itself, and a small simulation of Tuesday morning.
// Every handoff has a timeline of entries ({ at, s } where s is working, needs, landed or failed).
// The clock moves forward and each entry is entered once, in time order; entering one may raise a
// notification, as the handoff's "Tell me" contract allows. ?state= jumps to a moment.
(function () {
  "use strict";

  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  if (params.get("bar") === "off") root.setAttribute("data-bar-off", "");
  var STATE = root.dataset.state || "";

  // One simulated minute passes every ten real seconds.
  var MINUTES_PER_SECOND = 0.1;
  var FRAME_MS = 250;
  var NBH = "‑";

  /** Converts "09:41" or "09:41:12" to minutes since midnight. */
  function toMinutes(text) {
    var p = text.split(":");
    return Number(p[0]) * 60 + Number(p[1]) + (p[2] ? Number(p[2]) / 60 : 0);
  }
  /** Formats minutes since midnight as "09:41". */
  function formatClock(minutes) {
    var h = Math.floor(minutes / 60);
    var m = Math.floor(minutes % 60);
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  /** Formats a span of minutes as "40s", "8m" or "1h 4m". */
  function formatSpan(minutes) {
    if (minutes < 1) return Math.max(1, Math.round(minutes * 60)) + "s";
    var m = Math.floor(minutes);
    return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }
  /** Escapes a note for HTML and draws the parts it marks with backticks as code. */
  function noteHtml(text) {
    return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ------------------------------------------------------------------ the contract */

  // "Tell me": when a handoff may interrupt Rogier. The roundup collects the rest.
  var TELL = {
    lands: { label: "When it lands", icon: "bell", key: "1", means: "A notification the moment it lands, asks or fails" },
    needs: { label: "If it needs me", icon: "question", key: "2", means: "Silent when it lands; a notification only if it asks or fails" },
    roundup: { label: "Roundup 12:30", icon: "clock", key: "3", means: "Nothing interrupts you; it waits for the 12:30 roundup" },
  };
  var TELL_ORDER = ["lands", "needs", "roundup"];
  var ROUNDUP_AT = toMinutes("12:30");

  // The last 30 days per workflow: signed off as they came, of all runs. They choose the default.
  var TRUST = {
    "Review PR": { ok: 14, of: 14, tell: "roundup" },
    "Draft reply": { ok: 17, of: 20, tell: "lands" },
    "Fix bug": { ok: 9, of: 12, tell: "needs" },
    Investigate: { ok: 6, of: 6, tell: "roundup" },
  };
  // How long a run of each workflow usually takes, in minutes. A tick fills against it.
  var TYPICAL = { "Review PR": 8, "Fix bug": 20, "Draft reply": 3, Investigate: 10 };

  /** Checks whether entering a phase may raise a notification under the handoff's contract. */
  function contractAllowsNotice(tell, phase) {
    if (phase === "landed") return tell === "lands";
    if (phase === "needs" || phase === "failed") return tell !== "roundup";
    return false;
  }

  /* ------------------------------------------------------------------ the morning */

  function ans(label, desc, key, go, kind) {
    return { label: label, desc: desc, key: key || "", go: go, kind: kind || "" };
  }

  var SEND_BACK = function (h) {
    openComposer(h, "sendback");
  };
  var TAKE_OVER = function (h) {
    settle(h, "takenOver", "Taken over · opens in Hercule");
    say("Hercule opens at the run's thread (not drawn)");
  };

  var H3_NOTE = "It's Brightline B.V. (KvK 81234567). First names, short. Reissue it as INV-2291-R in Stripe and attach that.";
  var H5_NOTE = "You may edit .github/workflows/test.yml";

  var H3_ATTEMPT_2 = {
    preview: "Hi Marta, Done: attached is INV-2291-R…",
    noteBody: "Changed: Brightline B.V. (KvK 81234567), first names, INV-2291-R.pdf attached.\nHi Marta, Done: attached is INV-2291-R, made out to Brightline B.V.…",
    sure: { ok: true, text: "Sure. Stripe made INV-2291-R and voided INV-2291." },
    html:
      '<ul class="w-changed"><li><span>Brightline B.V. (KvK 81234567), was <s>Brightline Ltd</s></span></li><li><span>First names, 4 lines, was 7</span></li><li><span>INV-2291-R.pdf, made in Stripe · live, was <s>INV-2291.pdf</s></span></li></ul>' +
      '<blockquote class="w-quote"><p>Hi Marta,</p><p>Done: attached is INV-2291-R, made out to Brightline B.V. (KvK 81234567). I voided the original INV-2291, so your finance team can book this one.</p><p>Best,<br />Rogier</p></blockquote>' +
      '<span class="w-attach">' + Crew.icon("file", 13) + "<code>INV-2291-R.pdf</code></span>",
    answers: [
      ans("Send reply", "Sends the reply to <b>Marta Visser</b> from <b>Gmail · rogier@personal</b> with <b>INV-2291-R.pdf</b>", "↩", function (h) { settle(h, "signedOff", "Sent to Marta · signed off"); }),
      ans("Edit first", "Opens the draft in Hercule, to change it before it goes", "E", function () { say("Opens the draft in Hercule (not drawn)"); }),
      ans("Send back…", "Starts attempt 3 with your note. The draft stays in Gmail until then", "B", SEND_BACK),
      ans("Discard draft", "Deletes the draft from Gmail Drafts. Stripe keeps INV-2291-R", "⌫", function (h) { settle(h, "undone", "Draft discarded"); }, "danger"),
    ],
  };

  var H5_TRIED_AGAIN = {
    preview: "Pushed a commit to #1300 · 26 checks passed",
    noteBody: "Pushed a commit to #1300 that pins TZ in test.yml. Checks re-ran: 26 passed.",
    sure: { ok: true, text: "Sure. The snapshot now matches on CI and on studio-mac." },
    html: '<p>Pinned <code class="w-code">TZ: Europe/Amsterdam</code> in <code class="w-code">.github/workflows/test.yml</code>, as your note allowed, and pushed it to <b>#1300</b>. The checks re-ran: 26 passed.</p>',
    answers: [
      ans("Sign off", "Keeps the commit on <b>#1300</b>. Nothing else is sent", "↩", function (h) { settle(h, "signedOff", "Signed off"); }),
      ans("Send back…", "Starts attempt 3 with your note", "B", SEND_BACK),
      ans("Revert the commit", "Pushes a revert of the commit to <b>fix/invoice-snapshot-tz</b>", "⌫", function (h) { settle(h, "undone", "Commit reverted"); }, "danger"),
    ],
  };

  /** Returns the seven handoffs of Tuesday morning, fresh, with their timelines from the fixtures. */
  function morning() {
    return [
      {
        id: "h6",
        thread: true,
        who: "Fix 3-D Secure checkout for EU cards",
        name: "Fix 3" + NBH + "D Secure checkout for EU cards",
        src: "sentry",
        signal: "Checkout fails for EU cards with 3" + NBH + "D Secure",
        noteSub: "Checkout fails for EU cards",
        from: "webshop-prod · 412 events",
        handed: toMinutes("09:02"),
        tell: "needs",
        runner: "studio-mac",
        timeline: [
          { at: toMinutes("09:02"), s: "working", note: "Reproducing the 3" + NBH + "D Secure failure with an EU test card" },
          { at: toMinutes("09:19"), s: "working", note: "Fixed the redirect after the challenge in `payment.ts`: 24 tests passed" },
          {
            at: toMinutes("09:31"),
            s: "needs",
            ask: {
              q: "Run <code>git push -u origin fix/3ds-eu-cards</code>?",
              short: "Run <code>git push</code>?",
              plain: "Run git push -u origin fix/3ds-eu-cards?",
              facts: "3 changed files <span class=\"plus\">+48</span> <span class=\"minus\">−12</span> · 24 tests passed",
              answers: [
                ans("Allow once", "Pushes the branch; asks again next time", "↩", function (h) { resume(h, "Pushed `fix/3ds-eu-cards`; opening a draft pull request"); }),
                ans("Always allow git push", "Adds a Grant for this thread", "⌘↩", function (h) { resume(h, "Pushed `fix/3ds-eu-cards`; opening a draft pull request"); }),
                ans("Deny", "The agent stops and asks what next", "⌫", function (h) { resume(h, "Stopped before pushing; writing up what it needs instead"); }, "quiet"),
              ],
            },
          },
        ],
      },
      {
        id: "h2",
        ran: "22m",
        wf: "Fix bug",
        src: "slack",
        signal: "Codes with a trailing space are rejected",
        noteSub: "Pieter · Codes with a trailing space",
        from: "Pieter · #acceptance",
        handed: toMinutes("09:05"),
        tell: "needs",
        runner: "studio-mac",
        timeline: [
          { at: toMinutes("09:05"), s: "working", note: 'Reproducing with "SUMMER10 "' },
          {
            at: toMinutes("09:27"),
            s: "landed",
            res: {
              preview: "Draft PR #1302 · Trim discount codes before lookup",
              noteBody: "Draft PR #1302 trims codes before lookup.\nSure: reproduced it with a failing test first.",
              sure: { ok: true, text: "Sure. Reproduced it with a failing test first." },
              html:
                '<p><b>#1302 Trim discount codes before lookup</b> · <span class="plus">+14</span> <span class="minus">−3</span> · 26 checks passed</p>' +
                '<p class="muted">Caused by <b class="you-ink">#1287</b>, which you signed off yesterday: <code class="w-code">normalizeCode</code> lost its <code class="w-code">trim()</code>. Now <code class="w-code">return code.trim().toLowerCase();</code> with a test for <code class="w-code">"SUMMER10 "</code>.</p>' +
                '<p class="muted">Also drafted for Pieter: "Fixed in #1302. It reaches acceptance with the next deploy."</p>',
              answers: [
                ans("Merge #1302", "Squash-merges <b>#1302</b> into <b>main</b> in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", "↩", function (h) { settle(h, "signedOff", "Merged #1302 · signed off"); }),
                ans("Reply to Pieter", "Sends the drafted reply in the <b>#acceptance</b> thread as <b>Slack · rogier</b>", "R", null, "sub"),
                ans("Send back…", "Starts attempt 2 with your note. #1302 stays a draft until then", "B", SEND_BACK),
                ans("Close the PR", "Closes <b>#1302</b> and deletes <b>fix/trim-discount-codes</b>", "⌫", function (h) { settle(h, "undone", "Closed #1302"); }, "danger"),
              ],
            },
          },
          { at: toMinutes("09:33"), seen: true },
        ],
      },
      {
        id: "h5",
        ran: "18m",
        wf: "Fix bug",
        src: "github",
        signal: "Show VAT per line on invoices",
        noteSub: "webshop #1300 · Show VAT per line",
        from: "GitHub Actions · webshop #1300",
        handed: toMinutes("09:08"),
        tell: "needs",
        runner: "build-box-1",
        timeline: [
          { at: toMinutes("09:08"), s: "working", note: "Reading the snapshot mismatch in `invoice.snap.ts`" },
          {
            at: toMinutes("09:26"),
            s: "failed",
            res: {
              preview: "Gave up after 3 tries: CI runs in UTC",
              noteBody: "Gave up after 3 tries. CI runs in UTC; pinning the zone needs test.yml, which this run may not edit.",
              html:
                "<p>Gave up after 3 tries. The snapshot differs only on CI: the runner's time zone is UTC and the test formats dates in local time. Pinning the zone needs a change to <code class=\"w-code\">.github/workflows/test.yml</code>, which this run may not edit.</p>" +
                '<p class="w-attach">' + Crew.icon("branch", 13) + '<code>fix/invoice-snapshot-tz</code> · 1 commit, not pushed</p>',
              answers: [
                ans("Try again with a note…", "Starts attempt 2 from <b>fix/invoice-snapshot-tz</b> with your note", "↩", function (h) { openComposer(h, "tryAgain"); }),
                ans("Take over", "Opens the run's thread in Hercule. It is yours from here", "T", TAKE_OVER),
                ans("Let it go", "Takes it off the watch. The branch stays, not pushed", "⌫", function (h) { settle(h, "letGo", "Let go"); }, "quiet"),
              ],
            },
          },
        ],
      },
      {
        id: "h1",
        ran: "7m 40s",
        wf: "Review PR",
        src: "github",
        signal: "Retry Stripe webhooks with backoff",
        noteSub: "Marta · payments-api #1294",
        from: "Marta · payments-api #1294",
        handed: toMinutes("09:12"),
        tell: "roundup",
        runner: "build-box-2",
        timeline: [
          { at: toMinutes("09:12"), s: "working", note: "Reading `src/webhooks/retry.ts`" },
          {
            at: toMinutes("09:20"),
            s: "landed",
            res: {
              preview: "Approve, with 2 comments · not posted",
              noteBody: "Approve, with 2 comments. Safe to merge once the cap is configurable.\nSure: read all 4 files, 18 tests passed.",
              sure: { ok: true, text: "Sure. Read all 4 files and ran the tests: 18 passed." },
              html:
                '<p class="w-verdict">Approve, with 2 comments</p>' +
                '<ul class="w-comments"><li><code>src/webhooks/retry.ts:42</code><span>The 30-minute cap is hard-coded. Stripe retries for 3 days; read <code class="w-code">WEBHOOK_RETRY_CAP_MS</code> so ops can raise it.</span></li>' +
                '<li><code>src/webhooks/retry.test.ts</code><span>No test covers the jitter. A seeded random would make <code class="w-code">computeDelay</code> testable.</span></li></ul>',
              answers: [
                ans("Post review", "Posts an approving review with <b>2 comments</b> on <b>#1294</b> in <b>rogier/payments-api</b> as <b>GitHub · rogier</b>", "↩", function (h) { settle(h, "signedOff", "Review posted · signed off"); }),
                ans("Edit first", "Opens the draft review in Hercule, to change it before it is posted", "E", function () { say("Opens the draft review in Hercule (not drawn)"); }),
                ans("Send back…", "Starts attempt 2 with your note", "B", SEND_BACK),
                ans("Discard draft", "Deletes the draft review. Nothing was posted", "⌫", function (h) { settle(h, "undone", "Draft review discarded"); }, "danger"),
              ],
            },
          },
        ],
      },
      {
        id: "h3",
        ran: "2m 10s",
        wf: "Draft reply",
        src: "gmail",
        signal: "Invoice INV-2291 in the company name",
        noteSub: "Marta Visser · Invoice INV-2291",
        from: "Marta Visser · Brightline",
        handed: toMinutes("09:20"),
        tell: "lands",
        runner: "build-box-2",
        timeline: [
          { at: toMinutes("09:20"), s: "working", note: "Reading Marta's mail and earlier mail from Brightline" },
          {
            at: toMinutes("09:22"),
            s: "landed",
            res: {
              preview: "Dear Ms. Visser, Thank you for reaching out regarding…",
              noteBody: "Dear Ms. Visser, Thank you for reaching out regarding invoice INV-2291…\nNot sure: guessed the legal name, Brightline Ltd.",
              sure: { ok: false, text: "Not sure. I couldn't find Brightline's legal name in earlier mail, so I guessed 'Ltd'. I attached the existing invoice; I can't create invoices." },
              html:
                '<blockquote class="w-quote"><p>Dear Ms. Visser,</p><p>Thank you for reaching out regarding invoice INV-2291. We would be happy to accommodate your request. Please find the reissued invoice made out to Brightline Ltd attached to this email.</p><p>Should you have any further questions, please do not hesitate to contact us.</p><p>Kind regards,<br />Rogier Pennink<br />Acme</p></blockquote>' +
                '<span class="w-attach">' + Crew.icon("file", 13) + "<code>INV-2291.pdf</code> · the original, still in Marta's name</span>",
              answers: [
                ans("Send reply", "Sends the reply to <b>Marta Visser</b> from <b>Gmail · rogier@personal</b> with <b>INV-2291.pdf</b>", "↩", function (h) { settle(h, "signedOff", "Sent to Marta · signed off"); }),
                ans("Edit first", "Opens the draft in Hercule, to change it before it goes", "E", function () { say("Opens the draft in Hercule (not drawn)"); }),
                ans("Send back…", "Starts attempt 2 with your note. The draft stays in Gmail until then", "B", SEND_BACK),
                ans("Discard draft", "Deletes the draft from Gmail Drafts", "⌫", function (h) { settle(h, "undone", "Draft discarded"); }, "danger"),
              ],
            },
          },
        ],
        // Attempt 2 is scripted: a Request about Stripe, then the reply Rogier wanted.
        sendBack: function (h, now) {
          h.timeline.push(
            { at: now, s: "working", newAttempt: true, note: "Reading your note; looking up Brightline B.V. in the KvK register" },
            {
              at: now + 0.4,
              s: "needs",
              ask: {
                q: "Void <b>INV-2291</b> and create <b>INV-2291-R</b> for <b>Brightline B.V.</b> in <b>Stripe · live</b>?",
                short: "Void INV-2291 and create INV-2291-R in Stripe?",
                plain: "Void INV-2291 and create INV-2291-R for Brightline B.V. in Stripe · live?",
                facts: "Stripe · live · invoice for €1,840.00",
                answers: [
                  ans("Allow once", "Voids <b>INV-2291</b> and creates <b>INV-2291-R</b> in <b>Stripe · live</b>", "↩", function (x) {
                    var t = clock.now;
                    x.timeline.push({ at: t, s: "working", note: "Made INV-2291-R in Stripe; writing the reply" }, { at: t + 0.6, s: "landed", res: H3_ATTEMPT_2 });
                    afterChange();
                  }),
                  ans("Deny", "Nothing changes in Stripe. The agent writes the reply without a new invoice", "⌫", function (x) {
                    var t = clock.now;
                    x.timeline.push({ at: t, s: "working", note: "Writing the reply without a new invoice" }, { at: t + 0.6, s: "landed", res: H3_ATTEMPT_2 });
                    afterChange();
                  }, "quiet"),
                ],
              },
            },
          );
        },
      },
      {
        id: "h4",
        wf: "Investigate",
        src: "linear",
        signal: "Refunds for partial captures",
        noteSub: "Jonas · Refunds for partial captures",
        from: "Jonas · Kiteworks · PAY-212",
        handed: toMinutes("09:33"),
        tell: "lands",
        runner: "build-box-1",
        timeline: [
          { at: toMinutes("09:33"), s: "working", note: "Read PAY-212 and its 3 comments" },
          { at: toMinutes("09:35"), s: "working", note: "Searched payments-api for partial captures: 6 places" },
          { at: toMinutes("09:37"), s: "working", note: "Read `src/refunds/refund.ts`" },
          { at: toMinutes("09:39"), s: "working", note: "Ran `pnpm test refunds`: 31 passed" },
          { at: toMinutes("09:41"), s: "working", note: "Writing a failing test for a refund after a partial capture…" },
          {
            at: toMinutes("09:42:12"),
            s: "landed",
            res: {
              preview: "Yes, Stripe allows it · a one-line fix at refund.ts:88",
              noteBody: "Yes, Stripe allows it. createRefund asks for the €120 authorised, not the €80 captured: a one-line fix at refund.ts:88.\nSure: reproduced it with a failing test.",
              sure: { ok: true, text: "Sure of the cause: reproduced it with a failing test. I did not call Stripe's test mode." },
              html: '<p>Yes, Stripe allows it. <code class="w-code">createRefund</code> defaults <code class="w-code">amount</code> to <code class="w-code">payment.amountAuthorized</code> when no amount is given. For a partial capture that is €120, more than the €80 captured, so Stripe returns <code class="w-code">amount_too_large</code>. Passing an explicit amount works today; the fix is one line at <code class="w-code">src/refunds/refund.ts:88</code>.</p>',
              answers: [
                ans("Reply on PAY-212", "Posts the answer on <b>PAY-212</b> as <b>Linear · rogier</b>", "↩", function (h) { settle(h, "signedOff", "Answered on PAY-212 · signed off"); }),
                ans("Hand to Fix bug", "Starts <b>Fix bug</b> on <b>payments-api</b> with these findings", "F", function (h) {
                  settle(h, "signedOff", "Handed to Fix bug · signed off");
                  handOff({ wf: "Fix bug", src: "linear", signal: "Refunds for partial captures", noteSub: "Jonas · Refunds for partial captures", from: "Investigate's findings · PAY-212", runner: "build-box-2", note: "Writing the fix at `src/refunds/refund.ts:88`" });
                }),
                ans("Send back…", "Starts attempt 2 with your note", "B", SEND_BACK),
              ],
            },
          },
        ],
      },
      {
        id: "h7",
        wf: "Investigate",
        src: "tasks",
        signal: "Nightly backup job timing out on ops-db",
        noteSub: "ops · Nightly backup job",
        from: "Triage's proposal · ops",
        handed: toMinutes("09:35"),
        tell: "roundup",
        runner: "build-box-1",
        timeline: [
          { at: toMinutes("09:35"), s: "working", note: "Reading the backup job's logs for the last 3 nights" },
          { at: toMinutes("09:39"), s: "working", note: "`pg_dump` of `events` (41 GB) takes 1h 52m; the job's limit is 2h" },
          { at: toMinutes("09:43"), s: "working", note: "Trying `pg_dump --jobs 4` on a copy of `events`…" },
          {
            at: toMinutes("09:45"),
            s: "landed",
            res: {
              preview: "Dump <code>events</code> with <code>--jobs 4</code>: 38m on a copy",
              noteBody: "Dump events in parallel with --jobs 4: 38m on a copy. Or drop the 90-day-old partitions.\nNot sure: measured on a copy, not on ops-db.",
              sure: { ok: false, text: "Not sure. Measured on a copy, not on ops-db." },
              html: '<p>Dump <code class="w-code">events</code> in parallel with <code class="w-code">--jobs 4</code>: 38m on a copy. Or drop the 90-day-old partitions the sweep already ignores.</p>',
              answers: [
                ans("Sign off", "Keeps the findings on the Task <b>Nightly backup job timing out</b>. Nothing is sent", "↩", function (h) { settle(h, "signedOff", "Signed off"); }),
                ans("Send back…", "Starts attempt 2 with your note", "B", SEND_BACK),
              ],
            },
          },
        ],
      },
    ];
  }

  /* ------------------------------------------------------------------ state */

  var clock = { now: toMinutes("09:41"), playing: STATE === "", lastMinute: -1 };
  var handoffs = [];
  var roundups = [{ at: ROUNDUP_AT, entered: false }];
  var view = {
    caseOpen: false,
    mode: "click", // click, keys or roundup
    sel: null,
    open: null,
    composer: null, // { id, kind: sendback | tryAgain, text }
    fresh: null,
    order: [],
  };
  var counts = { interruptions: 0 };
  var signed = []; // faces of what was signed off today
  var silent = true; // while true, entering an entry raises no notification (the past)
  var ready = false; // while false, the watch draws without motion

  function byId(id) {
    for (var i = 0; i < handoffs.length; i++) if (handoffs[i].id === id) return handoffs[i];
    return null;
  }
  function faceName(h) {
    return h.thread ? h.who : h.wf;
  }
  /** Returns the handoffs on the watch now: handed, and with no verdict yet. */
  function onWatch() {
    return handoffs
      .filter(function (h) {
        return h.handed <= clock.now && !h.verdict && h.cur;
      })
      .sort(function (a, b) {
        return a.handed - b.handed;
      });
  }
  function phaseOf(h) {
    return h.cur ? h.cur.s : "working";
  }
  /** Returns the minutes since the current attempt started. */
  function attemptAge(h) {
    return clock.now - h.attemptStart;
  }
  /** Returns how far a working run has come, 0 to 0.9, against its workflow's usual duration. A thread has none, so it shows half. */
  function progressOf(h) {
    if (h.thread) return 0.5;
    return Math.max(0.12, Math.min(0.9, attemptAge(h) / (TYPICAL[h.wf] || 10)));
  }
  /** Counts the handoffs that landed or failed, unseen, with no notification: they wait for the roundup. */
  function heldCount() {
    return onWatch().filter(function (h) {
      var s = phaseOf(h);
      return (s === "landed" || s === "failed") && !h.seen && !h.notified;
    }).length;
  }

  /* ------------------------------------------------------------------ the simulation */

  /** Enters one timeline entry: moves the handoff to its phase and raises what its contract allows. */
  function enter(h, e) {
    e.entered = true;
    if (e.seen) {
      h.seen = true;
      return;
    }
    if (!h.cur || e.newAttempt) h.attemptStart = e.at;
    h.cur = e;
    if (e.res) h.res = e.res;
    if (e.ask) h.ask = e.ask;
    if (e.s === "landed" || e.s === "failed" || e.s === "needs") {
      h.seen = false;
      h.notified = false;
      if (contractAllowsNotice(h.tell, e.s)) {
        if (view.caseOpen && !silent) {
          // He is looking at it: the row changes in place and nothing interrupts him.
          view.fresh = h.id;
        } else {
          h.notified = true;
          counts.interruptions++;
          if (!silent) showNote(buildNote(h));
        }
      } else if (view.caseOpen && !silent) {
        view.fresh = h.id;
      }
    }
  }

  function enterRoundup(r) {
    r.entered = true;
    var waiting = onWatch().filter(function (h) {
      var s = phaseOf(h);
      return (s === "landed" || s === "failed") && !h.seen;
    });
    waiting.forEach(function (h) {
      h.notified = true;
    });
    counts.interruptions++;
    if (!silent && waiting.length) showNote(buildRoundupNote(waiting));
  }

  /** Enters every entry whose time has come, across all handoffs, in time order. */
  function processEntries() {
    var due = [];
    handoffs.forEach(function (h) {
      if (h.handed > clock.now) return;
      h.timeline.forEach(function (e) {
        if (!e.entered && e.at <= clock.now) due.push({ h: h, e: e });
      });
    });
    roundups.forEach(function (r) {
      if (!r.entered && r.at <= clock.now) due.push({ r: r, e: r });
    });
    due.sort(function (a, b) {
      return a.e.at - b.e.at;
    });
    due.forEach(function (d) {
      if (d.r) enterRoundup(d.r);
      else enter(d.h, d.e);
    });
    return due.length > 0;
  }

  /** Returns the time of the next entry still to come, or null. */
  function nextEventAt() {
    var next = null;
    handoffs.forEach(function (h) {
      h.timeline.forEach(function (e) {
        if (!e.entered && (next === null || e.at < next)) next = e.at;
      });
    });
    roundups.forEach(function (r) {
      if (!r.entered && (next === null || r.at < next)) next = r.at;
    });
    return next;
  }

  /** Moves the clock to a time and enters what is due, then draws what changed. */
  function advanceTo(minutes) {
    clock.now = minutes;
    var changed = processEntries();
    var minute = Math.floor(clock.now);
    if (changed) {
      drawAll();
    } else if (minute !== clock.lastMinute) {
      drawClock();
      drawWatches();
      updateRowTimes();
    } else {
      drawWatches();
    }
    clock.lastMinute = minute;
  }

  function frame() {
    if (!clock.playing) return;
    advanceTo(clock.now + (FRAME_MS / 1000) * MINUTES_PER_SECOND);
  }

  /** Called after an answer changes a handoff's timeline: enters what is due now and redraws. */
  function afterChange() {
    processEntries();
    drawAll();
  }

  /* ------------------------------------------------------------------ answers */

  /** Ends a handoff with a verdict. Its row shows what happened for a moment, then leaves. */
  function settle(h, verdict, did) {
    h.verdict = verdict;
    h.leaving = did;
    if (verdict === "signedOff") signed.push(faceName(h));
    removeNoteFor(h.id);
    if (view.composer && view.composer.id === h.id) view.composer = null;
    if (view.open === h.id) view.open = null;
    drawAll();
    setTimeout(function () {
      var row = document.querySelector('[data-row="' + h.id + '"]');
      if (row) row.classList.add("is-leaving");
    }, 1100);
    setTimeout(function () {
      h.leaving = null;
      if (view.sel === h.id) view.sel = null;
      drawCase();
    }, 1300);
  }

  /** Sends a run back to work after its Request was answered. */
  function resume(h, note) {
    h.timeline.push({ at: clock.now, s: "working", note: note });
    removeNoteFor(h.id);
    afterChange();
  }

  /** Starts the next attempt with Rogier's note. Draft reply's attempt 2 is scripted; others follow the note. */
  function sendBack(h, note) {
    h.attempt = (h.attempt || 1) + 1;
    removeNoteFor(h.id);
    view.composer = null;
    view.open = null;
    if (h.sendBack) {
      h.sendBack(h, clock.now);
    } else {
      var base = h.res;
      var res = {
        preview: "Attempt " + h.attempt + " · " + base.preview,
        noteBody: "Followed your note: " + note,
        sure: base.sure,
        html: '<ul class="w-changed"><li><span>Followed your note: "' + escapeHtml(note) + '"</span></li></ul>' + base.html,
        answers: base.answers,
      };
      h.timeline.push({ at: clock.now, s: "working", newAttempt: true, note: "Working on your note" }, { at: clock.now + 1, s: "landed", res: res });
    }
    afterChange();
  }

  /** Starts a failed run again with a note: about ten seconds of work, then it lands. */
  function tryAgain(h, note) {
    h.attempt = (h.attempt || 1) + 1;
    removeNoteFor(h.id);
    view.composer = null;
    view.open = null;
    h.timeline.push(
      { at: clock.now, s: "working", newAttempt: true, note: 'Your note: "' + note + '"' },
      { at: clock.now + 0.4, s: "working", note: "Pinned `TZ` in `test.yml`; checks re-running on #1300" },
      { at: clock.now + 1, s: "landed", res: H5_TRIED_AGAIN },
    );
    afterChange();
  }

  /** Creates a new handoff that starts working now, with the default contract from its workflow's trust. */
  function handOff(spec) {
    var id = "h" + (handoffs.length + 1) + "-" + Math.round(clock.now * 60);
    var h = {
      id: id,
      wf: spec.wf,
      src: spec.src,
      signal: spec.signal,
      noteSub: spec.noteSub,
      from: spec.from,
      handed: clock.now,
      tell: spec.tell || TRUST[spec.wf].tell,
      runner: spec.runner,
      timeline: [{ at: clock.now, s: "working", note: spec.note }].concat(spec.later || []),
    };
    handoffs.push(h);
    processEntries();
    return h;
  }

  function openComposer(h, kind) {
    view.sel = h.id;
    view.open = h.id;
    h.seen = true;
    view.composer = { id: h.id, kind: kind, text: kind === "tryAgain" ? H5_NOTE : h.id === "h3" ? H3_NOTE : "" };
    if (!view.caseOpen) openCase("keys", h.id);
    else drawAll();
    focusComposer();
  }

  function focusComposer() {
    var area = document.querySelector(".w-note");
    if (area) {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }
  }

  function submitComposer() {
    var c = view.composer;
    if (!c) return;
    var h = byId(c.id);
    var text = c.text.trim();
    if (!text) return;
    if (c.kind === "tryAgain") tryAgain(h, text);
    else sendBack(h, text);
  }

  /** Returns the answers of a handoff in its current phase. */
  function answersOf(h) {
    var s = phaseOf(h);
    if (s === "needs") return h.ask.answers;
    if (s === "landed" || s === "failed") return h.res.answers;
    return [ans(h.thread ? "Open the thread" : "Take over", h.thread ? "Opens the thread in Hercule" : "Opens the run's thread in Hercule. The run stops; it is yours from here", "T", h.thread ? function () { say("Hercule opens at the thread (not drawn)"); } : TAKE_OVER, "plain")];
  }

  function pressAnswer(h, index) {
    var a = answersOf(h)[index];
    if (!a) return;
    if (a.kind === "sub") {
      h.subDone = h.subDone || {};
      h.subDone[index] = true;
      drawCase();
      return;
    }
    if (a.go) a.go(h);
  }

  /* ------------------------------------------------------------------ the watch */

  /** Returns the watch's places: one per handoff on the watch, in the order they were handed. */
  function watchPlaces() {
    if (STATE === "swarm") return SWARM.places;
    return onWatch().map(function (h) {
      var s = phaseOf(h);
      var kind = s === "landed" ? (h.seen ? "seen" : "landed") : s;
      return { id: h.id, kind: kind, p: s === "working" ? progressOf(h) : 1, label: (h.thread ? h.name : h.wf + ": " + h.signal) };
    });
  }

  /** Draws the watch's places into a dial, keeping each place's element so a change moves smoothly. */
  function drawWatch(el, places, big) {
    if (!el.querySelector(".watch-pip")) {
      var pips = "";
      for (var n = 0; n < 12; n++) pips += '<span class="watch-pip" style="--i:' + n + '"><i></i></span>';
      el.insertAdjacentHTML("afterbegin", pips);
    }
    var keep = {};
    places.slice(0, 12).forEach(function (place, i) {
      keep[place.id] = true;
      var slot = el.querySelector('[data-slot="' + place.id + '"]');
      if (!slot) {
        slot = document.createElement("span");
        slot.className = "watch-slot";
        slot.dataset.slot = place.id;
        slot.innerHTML = "<i></i>" + (big ? '<button aria-label="' + escapeHtml(place.label) + '"></button>' : "");
        if (ready) slot.classList.add("is-in");
        el.appendChild(slot);
      }
      var was = slot.dataset.kind;
      if (ready && was && was !== place.kind && place.kind !== "working" && place.kind !== "seen") {
        slot.classList.remove("is-turned");
        void slot.offsetWidth;
        slot.classList.add("is-turned");
      }
      slot.dataset.kind = place.kind;
      slot.className = slot.className.replace(/\bis-(working|needs|landed|seen|failed)\b/g, "").trim() + " is-" + place.kind;
      slot.style.setProperty("--i", i);
      slot.style.setProperty("--p", place.p.toFixed(3));
    });
    el.querySelectorAll(".watch-slot").forEach(function (slot) {
      if (!keep[slot.dataset.slot]) slot.remove();
    });
    // A taken place hides its pip, so a seen ring shows the dial's ground through it.
    el.querySelectorAll(".watch-pip").forEach(function (pip, n) {
      pip.hidden = n < Math.min(12, places.length);
    });
  }

  function drawWatches() {
    var places = watchPlaces();
    drawWatch(document.querySelector('[data-watch="bar"]'), places, false);
    drawWatch(document.querySelector('[data-watch="big"]'), places, true);
    var btn = document.querySelector("[data-watch-btn]");
    btn.setAttribute("aria-label", watchSummary(places));
    btn.title = watchSummary(places);
  }

  /** Returns what the watch shows, in words, for its tooltip and its accessible name. */
  function watchSummary(places) {
    var n = { working: 0, needs: 0, landed: 0, seen: 0, failed: 0 };
    places.forEach(function (p) {
      n[p.kind]++;
    });
    if (!places.length) return "Hercule: nothing out with agents";
    var parts = [];
    if (n.needs) parts.push(n.needs + " needs you");
    if (n.landed) parts.push(n.landed + " landed");
    if (n.failed) parts.push(n.failed + " failed");
    if (n.working) parts.push(n.working + " working");
    return "Hercule: " + parts.join(", ");
  }

  /* ------------------------------------------------------------------ the case */

  function caseEl() {
    return document.querySelector("[data-case]");
  }

  function openCase(mode, focusId) {
    view.caseOpen = true;
    view.mode = mode;
    view.keys = mode === "keys";
    clearNotes();
    var visible = onWatch();
    var needing = visible.filter(function (h) {
      return phaseOf(h) === "needs";
    })[0];
    if (focusId) {
      view.sel = focusId;
      view.open = focusId;
      var h = byId(focusId);
      if (h && phaseOf(h) !== "working") h.seen = true;
    } else if (mode === "roundup") {
      var firstLanded = visible.filter(function (x) {
        return phaseOf(x) === "landed" && !x.seen;
      })[0];
      view.sel = firstLanded ? firstLanded.id : null;
      view.open = null;
    } else if (needing) {
      view.sel = needing.id;
      view.open = needing.id;
    } else {
      view.sel = visible.length ? visible[0].id : null;
      view.open = null;
    }
    var el = caseEl();
    el.hidden = false;
    el.classList.remove("is-in");
    if (ready) {
      void el.offsetWidth;
      el.classList.add("is-in");
    }
    document.querySelector("[data-watch-btn]").setAttribute("aria-expanded", "true");
    drawAll();
    scrollToOpen();
  }

  function closeCase() {
    view.caseOpen = false;
    view.composer = null;
    caseEl().hidden = true;
    document.querySelector("[data-watch-btn]").setAttribute("aria-expanded", "false");
    drawWatches();
  }

  function toggleRow(id) {
    var h = byId(id);
    view.sel = id;
    if (view.open === id) {
      view.open = null;
      if (view.composer && view.composer.id === id) view.composer = null;
    } else {
      view.open = id;
      if (h && phaseOf(h) !== "working") h.seen = true;
    }
    drawAll();
    scrollToOpen();
  }

  /** Scrolls the open or selected row into view. A row taller than the list starts at the list's top. */
  function scrollToOpen() {
    var row = document.querySelector(".w-row.is-open") || document.querySelector(".w-row.is-sel");
    if (!row) return;
    var list = document.querySelector("[data-case-list]");
    row.scrollIntoView({ block: row.offsetHeight > list.clientHeight - 40 ? "start" : "nearest" });
  }

  /** Returns the right edge of a row: a time and a mark in a fixed slot. */
  function rowEnd(h) {
    var s = phaseOf(h);
    if (h.leaving) return '<span class="w-end"><span class="w-slot">' + (h.verdict === "signedOff" ? Crew.mark("done") : "") + "</span></span>";
    if (s === "working") return '<span class="w-end" data-age="' + h.id + '">' + formatSpan(attemptAge(h)) + '<span class="w-slot"></span></span>';
    if (s === "needs") return '<span class="w-end is-you" data-age="' + h.id + '">' + formatSpan(clock.now - h.cur.at) + '<span class="w-slot">' + Crew.mark("waiting") + "</span></span>";
    var at = formatClock(h.cur.at);
    if (s === "failed") return '<span class="w-end">' + at + '<span class="w-slot">' + Crew.mark("failed") + "</span></span>";
    return '<span class="w-end">' + at + '<span class="w-slot">' + (h.seen ? "" : '<i class="w-unseen" title="Not seen yet"></i>') + "</span></span>";
  }

  function sourceMark(src) {
    return src === "tasks" ? Crew.icon("tasks", 13) : Crew.brand(src, 13);
  }

  /** Returns a handoff's row: its face, who and what, one live line, its end, and its open part. */
  function rowHtml(h) {
    var s = phaseOf(h);
    var pose = { working: "working", needs: "waiting", landed: "done", failed: "failed" }[s];
    if (h.leaving) pose = "done";
    var look = Crew.lookFor(faceName(h));
    var l1 = h.thread
      ? '<b class="is-thread">' + h.name + "</b>"
      : "<b>" + h.wf + "</b>" + sourceMark(h.src) + "<span>" + h.signal + "</span>";
    var l2;
    var isOpen = view.open === h.id && !h.leaving;
    if (h.leaving) l2 = '<span class="w-l2">' + h.leaving + "</span>";
    else if (isOpen && s !== "needs") l2 = "";
    else if (s === "working") l2 = '<span class="w-l2">' + noteHtml(h.cur.note) + "</span>";
    else if (s === "needs") l2 = '<span class="w-l2 is-you is-ask">' + (view.open === h.id ? h.ask.q : h.ask.short) + "</span>";
    else if (s === "failed") l2 = '<span class="w-l2 is-fail">' + h.res.preview + "</span>";
    else l2 = '<span class="w-l2">' + (h.attempt > 1 ? "Attempt " + h.attempt + " · " : "") + h.res.preview + "</span>";
    var cls = "w-row" + (isOpen ? " is-open" : view.sel === h.id && view.keys ? " is-sel" : "") + (l2 ? "" : " is-solo") + (view.fresh === h.id ? " is-new" : "");
    return (
      '<div class="' + cls + '" data-row="' + h.id + '" style="--hue:var(--hue-' + look.hue + ')">' +
      Crew.face(faceName(h), { pose: pose, size: 32 }) +
      '<div class="w-what"><span class="w-l1">' + l1 + "</span>" + l2 + "</div>" +
      rowEnd(h) +
      (isOpen ? openHtml(h) : "") +
      "</div>"
    );
  }

  function tellHtml(h) {
    return (
      '<div class="tell"><span class="tell-h">Tell me</span><span class="seg seg--tell" role="radiogroup" aria-label="Tell me">' +
      TELL_ORDER.map(function (key) {
        var t = TELL[key];
        return '<button role="radio" data-tell-row="' + h.id + '" data-tell="' + key + '" aria-pressed="' + (h.tell === key) + '">' + Crew.icon(t.icon, 13) + t.label + "<kbd>" + t.key + "</kbd></button>";
      }).join("") +
      "</span></div>"
    );
  }

  function provenanceHtml(h) {
    var s = phaseOf(h);
    var ended = s === "landed" || s === "failed";
    var ran = ended ? " · ran " + (h.attempt === 1 && h.ran ? h.ran : formatSpan(h.cur.at - h.attemptStart)) : "";
    return (
      '<div class="w-prov">' + sourceMark(h.src) + "<span>" + h.from + " · handed " + formatClock(h.handed) + ran + " · " + h.runner + (h.attempt > 1 ? " · attempt " + h.attempt : "") + "</span></div>"
    );
  }

  function ledgerHtml(h) {
    return (
      '<div class="ledger">' +
      answersOf(h)
        .map(function (a, i) {
          var cls = "btn btn--sm" + (i === 0 && a.kind !== "plain" ? " btn--accent" : a.kind === "quiet" ? " btn--quiet" : a.kind === "danger" ? " btn--danger" : "");
          var done = h.subDone && h.subDone[i];
          return (
            '<div class="ans' + (done ? " is-done" : "") + '"><button class="' + cls + '" data-answer="' + h.id + ":" + i + '"' + (done ? " disabled" : "") + ">" + (done ? "Sent" : a.label) + '</button><span class="ans-desc">' + a.desc + "</span>" + (a.key ? "<kbd>" + a.key + "</kbd>" : "<span></span>") + "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function composerHtml(h) {
    var c = view.composer;
    var tryingAgain = c.kind === "tryAgain";
    var next = (h.attempt || 1) + 1;
    return (
      '<div class="w-compose">' +
      '<label class="w-compose-h" for="w-note">' + (tryingAgain ? "Try again with a note" : "Send back with a note") + " · attempt " + next + "</label>" +
      '<textarea class="field w-note" id="w-note" rows="2" placeholder="What should change?">' + escapeHtml(c.text) + "</textarea>" +
      '<div class="ledger"><div class="ans"><button class="btn btn--sm btn--accent" data-compose-send>' + (tryingAgain ? "Try again" : "Send back") + '</button><span class="ans-desc">Starts attempt ' + next + " of <b>" + h.wf + "</b> with your note. " + (tryingAgain ? "It picks up from the branch it left" : "This result stays until the new one lands") + "</span><kbd>↩</kbd></div>" +
      '<div class="ans"><button class="btn btn--sm btn--quiet" data-compose-cancel>Cancel</button><span class="ans-desc">Keeps this result as it is</span><kbd>esc</kbd></div></div>' +
      "</div>"
    );
  }

  /** Returns what an opened row shows: the result or the Request, the contract, and the answers. */
  function openHtml(h) {
    var s = phaseOf(h);
    var body = "";
    if (s === "needs") {
      body = '<p class="w-prov"><span>' + h.ask.facts + "</span></p>";
    } else if (s === "working") {
      body =
        '<dl class="w-steps">' +
        h.timeline
          .filter(function (e) {
            return e.s === "working" && e.entered && e.at >= h.attemptStart;
          })
          .map(function (e, i, all) {
            return "<dt>" + formatClock(e.at) + '</dt><dd class="' + (i === all.length - 1 ? "is-now" : "") + '">' + noteHtml(e.note) + "</dd>";
          })
          .join("") +
        "</dl>" +
        tellHtml(h);
    } else {
      body = h.res.html + (h.res.sure ? '<p class="w-sure">' + Crew.icon(h.res.sure.ok ? "check" : "question", 13) + "<span>" + h.res.sure.text.replace(/^((?:Not sure|Sure)[^.:]*[.:])/, "<b>$1</b>") + "</span></p>" : "");
    }
    var answers = view.composer && view.composer.id === h.id ? composerHtml(h) : ledgerHtml(h);
    return '<div class="w-open">' + body + provenanceHtml(h) + answers + "</div>";
  }

  function headingHtml(label, n, you) {
    return '<h3 class="w-h">' + label + '<b class="count' + (you ? " count--you" : "") + '">' + n + "</b></h3>";
  }

  function drawCase() {
    if (!view.caseOpen) return;
    var list = document.querySelector("[data-case-list]");
    var scroll = list.scrollTop;
    var composerFocused = document.activeElement && document.activeElement.classList.contains("w-note");
    drawCaseHeader();
    if (STATE === "swarm") {
      list.innerHTML = swarmHtml();
      Crew.drawPlaceholders(list);
      return;
    }
    var visible = onWatch().concat(
      handoffs.filter(function (h) {
        return h.leaving;
      }),
    );
    if (!visible.length && STATE === "empty") {
      list.innerHTML = emptyHtml();
      Crew.drawPlaceholders(list);
      return;
    }
    var needs = [];
    var landed = [];
    var working = [];
    visible.forEach(function (h) {
      var s = phaseOf(h);
      if (s === "needs") needs.push(h);
      else if (s === "working") working.push(h);
      else landed.push(h);
    });
    // Landed and failed, oldest first. Seeing a row never moves it.
    landed.sort(function (a, b) {
      return a.cur.at - b.cur.at;
    });
    var html = "";
    view.order = [];
    function group(label, rows, you) {
      if (!rows.length) return;
      html += headingHtml(label, rows.length, you);
      rows.forEach(function (h) {
        view.order.push(h.id);
        html += rowHtml(h);
      });
    }
    group("Needs you", needs, true);
    group("Landed", landed, false);
    group("Working", working, false);
    if (signed.length) {
      html += '<div class="w-signed">' + Crew.icon("check", 14) + "<span><b>" + signed.length + "</b> signed off today</span></div>";
    }
    list.innerHTML = html;
    list.scrollTop = scroll;
    view.fresh = null;
    if (composerFocused || (view.composer && view.mode !== "click")) focusComposer();
  }

  function drawCaseHeader() {
    var title = document.querySelector("[data-case-title]");
    var sub = document.querySelector("[data-case-sub]");
    var count = document.querySelector("[data-case-count]");
    if (STATE === "swarm") {
      title.textContent = "Out with agents";
      sub.innerHTML = "<b>6</b> interruptions today · <b>23</b> held for the 12:30 roundup";
      count.innerHTML = '<span class="deco-num">38</span>today';
      return;
    }
    var held = heldCount();
    var total = handoffs.filter(function (h) {
      return h.handed <= clock.now;
    }).length;
    if (view.mode === "roundup") {
      var waiting = onWatch().filter(function (h) {
        return phaseOf(h) === "landed" && !h.seen;
      }).length;
      var failed = onWatch().filter(function (h) {
        return phaseOf(h) === "failed";
      }).length;
      title.textContent = "Roundup · 12:30";
      sub.innerHTML = "<b>" + waiting + "</b> landed and <b>" + failed + "</b> failed since the 09:00 roundup";
    } else {
      title.textContent = "Out with agents";
      sub.innerHTML =
        (counts.interruptions ? "<b>" + counts.interruptions + "</b> " + (counts.interruptions === 1 ? "interruption" : "interruptions") + " today · " : "No interruptions today · ") +
        (held ? "<b>" + held + "</b> held for the 12:30 roundup" : clock.now < ROUNDUP_AT ? "next roundup 12:30" : "next roundup 17:30");
    }
    count.innerHTML = total ? '<span class="deco-num">' + total + "</span>today" : "";
  }

  /** Updates the ages on rows in place, once a simulated minute, so the case is not drawn again. */
  function updateRowTimes() {
    document.querySelectorAll("[data-age]").forEach(function (el) {
      var h = byId(el.dataset.age);
      if (!h || !h.cur) return;
      var span = phaseOf(h) === "needs" ? clock.now - h.cur.at : attemptAge(h);
      el.firstChild.nodeValue = formatSpan(span);
    });
    drawCaseHeader();
  }

  function emptyHtml() {
    return (
      '<div class="w-empty"><b>Nothing out with agents today.</b><span>Hand a signal to an agent and it waits here until you sign it off.</span>' +
      '<div class="w-ghosts" aria-hidden="true">' +
      '<div class="w-ghost"><i></i><span><b>Needs you</b>A Request from a run, answered here</span><span class="w-end"><span class="w-slot">' + Crew.mark("waiting") + "</span></span></div>" +
      '<div class="w-ghost"><i></i><span><b>Landed</b>The result, with Sign off and Send back</span><span class="w-end"><span class="w-slot"><i class="w-unseen"></i></span></span></div>' +
      '<div class="w-ghost"><i></i><span><b>Working</b>What the agent is doing, in its own words</span><span class="w-end"><span class="w-slot">' + Crew.mark("working") + "</span></span></div>" +
      "</div></div>"
    );
  }

  /* ------------------------------------------------------------------ at 10x */

  // 38 handoffs today: 9 landed unseen, 14 working, 2 need you, 3 failed, 10 signed off. The case
  // bundles by workflow, so the list is as long as on an ordinary morning.
  var SWARM = {
    places: (function () {
      var kinds = ["needs", "landed", "working", "landed", "working", "failed", "working", "landed", "working", "landed", "working", "working"];
      return kinds.map(function (k, i) {
        return { id: "s" + i, kind: k, p: k === "working" ? 0.25 + ((i * 37) % 60) / 100 : 1, label: k };
      });
    })(),
  };

  function swarmHtml() {
    function row(id, faces, pose, l1, l2, l2cls, end, open) {
      var look = Crew.lookFor(faces[0]);
      var face = faces.length > 1 ? '<span class="stack">' + faces.slice(0, 2).map(function (f) { return Crew.face(f, { pose: pose, size: 24 }); }).join("") + "</span>" : Crew.face(faces[0], { pose: pose, size: 32 });
      return (
        '<div class="w-row' + (open ? " is-open" : "") + '" data-swarm-row="' + id + '" style="--hue:var(--hue-' + look.hue + ')">' + face +
        '<div class="w-what"><span class="w-l1">' + l1 + '</span><span class="w-l2' + (l2cls ? " " + l2cls : "") + '">' + l2 + "</span></div>" + end + (open || "") + "</div>"
      );
    }
    var openReview =
      view.open === "s-review"
        ? '<div class="w-open"><ul class="w-sub">' +
          '<li><span><b>#1294</b> Retry Stripe webhooks with backoff · Approve, 2 comments</span><small>09:20</small></li>' +
          '<li><span><b>#1296</b> Lazy-load product images · Approve</span><small>09:52</small></li>' +
          '<li><span><b>#1305</b> Bump stripe-node to 17.2 · Approve</span><small>10:04</small></li>' +
          '<li><span><b>#88</b> ops: rotate staging secrets weekly · Approve, 4 comments</span><small>10:11</small></li></ul>' +
          '<p class="w-sure">' + Crew.icon("check", 13) + "<span><b>Sure,</b> all 4: read every file and ran the tests.</span></p>" +
          '<div class="ledger"><div class="ans"><button class="btn btn--sm btn--accent">Post 4 reviews</button><span class="ans-desc">Posts 4 approving reviews with <b>6 comments</b> as <b>GitHub · rogier</b></span><kbd>↩</kbd></div>' +
          '<div class="ans"><button class="btn btn--sm">One at a time</button><span class="ans-desc">Opens each review here, oldest first</span><kbd>O</kbd></div>' +
          '<div class="ans"><button class="btn btn--sm btn--quiet">Leave for 12:30</button><span class="ans-desc">They wait for the roundup</span><kbd>esc</kbd></div></div></div>'
        : "";
    var end = function (text, mark, you) {
      return '<span class="w-end' + (you ? " is-you" : "") + '">' + text + '<span class="w-slot">' + (mark === "unseen" ? '<i class="w-unseen"></i>' : mark ? Crew.mark(mark) : "") + "</span></span>";
    };
    return (
      headingHtml("Needs you", 2, true) +
      row("s-3ds", ["Fix 3-D Secure checkout for EU cards"], "waiting", '<b class="is-thread">Fix 3' + NBH + "D Secure checkout for EU cards</b>", "Run <code>git push</code>?", "is-you", end("10m", "waiting", true)) +
      row("s-mig", ["Fix bug"], "waiting", "<b>Fix bug</b>" + Crew.brand("sentry", 13) + "<span>Orders stuck in pending after refund</span>", "Run <code>pnpm db:migrate</code> on staging-db?", "is-you", end("3m", "waiting", true)) +
      headingHtml("Landed", 12, false) +
      row("s-review", ["Review PR"], "done", "<b>Review PR</b><span>4 pull requests</span>", "All approve · 6 comments · all sure", "", end("10:11", "unseen"), openReview) +
      row("s-draft", ["Draft reply", "Draft reply"], "done", "<b>Draft reply</b><span>3 replies</span>", "Marta Visser, Jonas, Sanne · 1 not sure", "", end("10:20", "unseen")) +
      row("s-fix", ["Fix bug"], "done", "<b>Fix bug</b>" + Crew.brand("slack", 13) + "<span>Codes with a trailing space are rejected</span>", "Draft PR #1302 · Trim discount codes before lookup", "", end("09:27", "unseen")) +
      row("s-inv", ["Investigate"], "done", "<b>Investigate</b>" + Crew.brand("linear", 13) + "<span>Refunds for partial captures</span>", "Yes, Stripe allows it · a one-line fix at refund.ts:88", "", end("09:42", "unseen")) +
      row("s-failed", ["Fix bug", "Investigate"], "failed", "<b>3 failed</b><span>Fix bug ×2, Investigate</span>", "Show VAT per line on invoices, and 2 more", "is-fail", end("10:02", "failed")) +
      headingHtml("Working", 14, false) +
      row("s-work", ["Investigate", "Fix bug"], "working", "<b>14 working</b><span>Fix bug ×6, Review PR ×4, Investigate ×3, Draft reply</span>", "Next to land: Review PR on #1307, in about 2m", "", end("", "")) +
      '<div class="w-signed">' + Crew.icon("check", 14) + "<span><b>10</b> signed off today</span></div>"
    );
  }

  /* ------------------------------------------------------------------ notifications */

  function notesEl() {
    return document.querySelector("[data-notes]");
  }

  /** Returns a notification for a handoff's current phase, as macOS would show it. */
  function buildNote(h) {
    var s = phaseOf(h);
    var name = h.thread ? h.name : h.wf;
    var attempt = h.attempt > 1 ? " · attempt " + h.attempt : "";
    if (s === "needs") {
      return {
        id: h.id,
        title: name + " needs you",
        sub: h.attempt > 1 ? "Attempt " + h.attempt + " · " + h.noteSub.split(" · ")[0] : h.noteSub,
        body: h.ask.plain,
        face: { name: faceName(h), pose: "waiting" },
        acts: [{ label: h.ask.answers[0].label, accent: true, run: function () { pressAnswer(h, 0); } }, { label: h.ask.answers[h.ask.answers.length - 1].label, run: function () { pressAnswer(h, h.ask.answers.length - 1); } }],
      };
    }
    if (s === "failed") {
      return {
        id: h.id,
        title: name + " failed",
        sub: h.noteSub,
        body: h.res.noteBody,
        face: { name: faceName(h), pose: "failed" },
        acts: [{ label: "Try again with a note…", reply: "tryAgain" }, { label: "Open", run: function () { openCase("keys", h.id); } }],
      };
    }
    // Landed. An outward answer is offered from the notification only when the agent is sure.
    var sure = h.res.sure && h.res.sure.ok;
    return {
      id: h.id,
      title: name + " landed" + attempt,
      sub: h.noteSub,
      body: h.res.noteBody,
      face: { name: faceName(h), pose: "done" },
      acts: [sure ? { label: h.res.answers[0].label, accent: true, run: function () { pressAnswer(h, 0); } } : { label: "Open", run: function () { openCase("keys", h.id); } }, { label: "Send back…", reply: "sendback" }],
    };
  }

  function buildRoundupNote(waiting) {
    var landed = waiting.filter(function (h) {
      return phaseOf(h) === "landed";
    });
    var failed = waiting.filter(function (h) {
      return phaseOf(h) === "failed";
    });
    var names = {};
    landed.forEach(function (h) {
      var n = h.thread ? "a thread" : h.wf;
      names[n] = (names[n] || 0) + 1;
    });
    var list = Object.keys(names).map(function (n) {
      return names[n] > 1 ? names[n] + " " + n + " runs" : n;
    });
    var listText = list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0] || "";
    return {
      id: "roundup",
      title: "Roundup · 12:30",
      sub: landed.length + " landed" + (failed.length ? ", " + failed.length + " failed" : "") + " since 09:00",
      body: (listText ? listText + " landed. " : "") + (failed.length ? failed[0].wf + " gave up on " + failed[0].noteSub.split(" · ")[0] + "." : ""),
      faces: landed.slice(0, 3).map(faceName),
      acts: [{ label: "Open roundup", accent: true, run: function () { openCase("roundup"); } }, { label: "At 17:30", run: function () { say("The roundup waits until 17:30"); } }],
    };
  }

  /** Shows a notification at the top of the stack. A newer one for the same handoff replaces the older. */
  function showNote(note) {
    removeNoteFor(note.id, true);
    var el = document.createElement("div");
    el.className = "note" + (ready ? " is-in" : "");
    el.dataset.note = note.id;
    var face = note.faces ? '<span class="stack">' + note.faces.slice(0, 2).map(function (f) { return Crew.face(f, { pose: "done", size: 30 }); }).join("") + "</span>" : Crew.face(note.face.name, { pose: note.face.pose, size: 36 });
    el.innerHTML =
      '<button class="note-x" aria-label="Close">' + Crew.icon("close", 10) + "</button>" +
      '<span class="app-icon" data-theme="whitehaven">' + Crew.logo(28) + "</span>" +
      '<div class="note-top"><b>' + escapeHtml(note.title) + "</b><small>now</small></div>" +
      '<div class="note-sub">' + escapeHtml(note.sub) + "</div>" +
      '<div class="note-body">' + escapeHtml(note.body).replace(/\n/g, "<br />") + "</div>" +
      face +
      '<div class="note-acts">' +
      note.acts.map(function (a, i) {
        return '<button class="btn' + (a.accent ? " btn--accent" : "") + '" data-note-act="' + i + '">' + escapeHtml(a.label) + "</button>";
      }).join("") +
      "</div>";
    el._note = note;
    notesEl().prepend(el);
  }

  /** Turns a notification's actions into macOS's text reply field, for a note that starts the next attempt. */
  function openNoteReply(el, kind, text) {
    var note = el._note;
    var acts = el.querySelector(".note-acts");
    var reply = document.createElement("form");
    reply.className = "note-reply";
    reply.innerHTML = '<input placeholder="' + (kind === "tryAgain" ? "Try again with a note…" : "What should change?") + '" aria-label="Note" /><button class="send" title="Send back"><i></i></button>';
    reply.querySelector(".send").innerHTML = Crew.icon("send", 13);
    acts.replaceWith(reply);
    var input = reply.querySelector("input");
    input.value = text || "";
    input.focus();
    reply.addEventListener("submit", function (e) {
      e.preventDefault();
      var h = byId(note.id);
      if (!h || !input.value.trim()) return;
      if (kind === "tryAgain") tryAgain(h, input.value.trim());
      else sendBack(h, input.value.trim());
    });
  }

  function removeNoteFor(id, now) {
    var el = notesEl().querySelector('[data-note="' + id + '"]');
    if (!el) return;
    if (now || !ready) {
      el.remove();
      return;
    }
    el.classList.add("is-out");
    setTimeout(function () {
      el.remove();
    }, 200);
  }

  function clearNotes() {
    notesEl().querySelectorAll(".note").forEach(function (el) {
      removeNoteFor(el.dataset.note);
    });
  }

  /* ------------------------------------------------------------------ the handoff */

  var intake = { tell: TRUST["Review PR"].tell, handed: false };

  function intakeEl() {
    return document.querySelector("[data-intake-win]");
  }

  function openIntake() {
    if (intake.handed) {
      say("Hercule's window opens (not drawn)");
      return;
    }
    closeCase();
    intakeEl().hidden = false;
    drawTellPick();
  }

  function drawTellPick() {
    var pick = document.querySelector("[data-tell-pick]");
    pick.querySelectorAll("[data-tell]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.tell === intake.tell));
    });
    var why = pick.querySelector(".tell-why span");
    why.innerHTML = intake.tell === TRUST["Review PR"].tell ? "<b>14 of 14</b> signed off as they came, so the roundup is enough" : TELL[intake.tell].means;
  }

  /** Hands Pieter's review request to Review PR with the chosen contract; the handoff drops into the watch. */
  function handIntake() {
    if (intake.handed) return;
    intake.handed = true;
    var win = intakeEl();
    var from = document.querySelector("[data-hand-btn]").getBoundingClientRect();
    var to = document.querySelector('[data-watch="bar"]').getBoundingClientRect();
    var t = clock.now;
    handOff({
      wf: "Review PR",
      src: "github",
      signal: "Lazy-load product images",
      noteSub: "Pieter · webshop #1296",
      from: "Pieter · webshop #1296",
      runner: "build-box-2",
      tell: intake.tell,
      note: "Reading `src/catalog/ProductImage.tsx`",
      later: [
        { at: t + 0.8, s: "working", note: "Measured the product page: 2.1 MB before, 640 KB after" },
        {
          at: t + 2,
          s: "landed",
          res: {
            preview: "Approve, no comments · not posted",
            noteBody: "Approve, no comments. The product page drops from 2.1 MB to 640 KB.\nSure: read all 4 files, 31 tests passed.",
            sure: { ok: true, text: "Sure. Read all 4 files and ran the tests: 31 passed." },
            html: '<p class="w-verdict">Approve, no comments</p><p class="muted">Images below the fold load when they scroll into view. Measured the product page: 2.1 MB before, 640 KB after.</p>',
            answers: [
              ans("Post review", "Posts an approving review on <b>#1296</b> in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", "↩", function (h) { settle(h, "signedOff", "Review posted · signed off"); }),
              ans("Send back…", "Starts attempt 2 with your note", "B", SEND_BACK),
              ans("Discard draft", "Deletes the draft review. Nothing was posted", "⌫", function (h) { settle(h, "undone", "Draft review discarded"); }, "danger"),
            ],
          },
        },
      ],
    });
    win.classList.add("is-out");
    setTimeout(function () {
      win.hidden = true;
      win.classList.remove("is-out");
    }, 320);
    var dot = document.createElement("span");
    dot.className = "fly";
    dot.style.left = from.left + 24 + "px";
    dot.style.top = from.top + from.height / 2 + "px";
    document.querySelector(".desk").appendChild(dot);
    var dx = to.left + to.width / 2 - (from.left + 24);
    var dy = to.top + to.height / 2 - (from.top + from.height / 2);
    var motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? null
      : dot.animate([{ transform: "translate(0, 0) scale(1)", opacity: 1 }, { transform: "translate(" + dx + "px, " + dy + "px) scale(0.5)", opacity: 0.2 }], { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    function land() {
      dot.remove();
      drawAll();
    }
    if (motion) motion.onfinish = land;
    else land();
  }

  /* ------------------------------------------------------------------ drawing */

  function drawClock() {
    var text = formatClock(clock.now);
    document.querySelector("[data-clock]").textContent = text;
    document.querySelector("[data-proto-clock]").textContent = text;
  }

  function drawDock() {
    // The badge keeps spec 17's meaning: threads and assistants blocked on you. Migrate ops dashboards also waits.
    var h6 = byId("h6");
    var n = STATE === "swarm" ? 30 : 1 + (h6 && !h6.verdict && phaseOf(h6) === "needs" ? 1 : 0);
    var badge = document.querySelector("[data-dock-badge]");
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  function drawAll() {
    drawClock();
    drawWatches();
    drawCase();
    drawDock();
  }

  var sayTimer = null;
  /** Shows a short line over the prototype bar for something the prototype does not draw. */
  function say(text) {
    var el = document.querySelector("[data-proto-say]");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(function () {
      el.hidden = true;
    }, 2600);
  }

  /* ------------------------------------------------------------------ input */

  function moveSelection(step) {
    if (!view.order.length) return;
    var i = view.order.indexOf(view.sel);
    i = Math.max(0, Math.min(view.order.length - 1, i + step));
    view.sel = view.order[i];
    if (view.open && view.open !== view.sel && !(view.composer && view.composer.id === view.open)) view.open = null;
    drawCase();
    scrollToOpen();
  }

  function onKey(e) {
    if (e.altKey && e.code === "Space") {
      e.preventDefault();
      if (view.caseOpen) closeCase();
      else openCase("keys");
      return;
    }
    var typing = e.target.matches && e.target.matches("input, textarea, select");
    if (!intakeEl().hidden) {
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        intake.tell = TELL_ORDER[Number(e.key) - 1];
        drawTellPick();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handIntake();
      } else if (e.key === "Escape") {
        intakeEl().hidden = true;
      }
      return;
    }
    if (typing) {
      if (e.target.classList.contains("w-note")) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submitComposer();
        } else if (e.key === "Escape") {
          view.composer = null;
          drawCase();
        }
      } else if (e.key === "Escape") {
        e.target.blur();
      }
      return;
    }
    if (!view.caseOpen) return;
    var h = view.sel && byId(view.sel);
    var key = e.key.toLowerCase();
    view.keys = true;
    if (key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!h) return;
      // The first ↩ opens the row so its result is read; only the second presses its suggested answer.
      if (view.open !== h.id) toggleRow(h.id);
      else if (answersOf(h)[0].kind !== "plain") pressAnswer(h, 0);
    } else if (key === "b" && h) {
      var s = phaseOf(h);
      if (s === "landed") openComposer(h, "sendback");
      else if (s === "failed") openComposer(h, "tryAgain");
    } else if (key === "t" && h && !h.thread) {
      TAKE_OVER(h);
    } else if ((e.key === "1" || e.key === "2" || e.key === "3") && h && (phaseOf(h) === "working" || phaseOf(h) === "needs")) {
      h.tell = TELL_ORDER[Number(e.key) - 1];
      drawCase();
    } else if (e.key === "Escape") {
      if (view.open) {
        view.open = null;
        drawCase();
      } else closeCase();
    }
  }

  function onClick(e) {
    var t = e.target;
    if (t.closest("[data-watch-btn]")) {
      if (view.caseOpen) closeCase();
      else openCase("click");
      return;
    }
    var slotBtn = t.closest(".watch--big .watch-slot > button");
    if (slotBtn) {
      var id = slotBtn.parentElement.dataset.slot;
      if (byId(id)) toggleRow(id);
      return;
    }
    var answer = t.closest("[data-answer]");
    if (answer) {
      var parts = answer.dataset.answer.split(":");
      pressAnswer(byId(parts[0]), Number(parts[1]));
      return;
    }
    var tellBtn = t.closest("[data-tell-row]");
    if (tellBtn) {
      byId(tellBtn.dataset.tellRow).tell = tellBtn.dataset.tell;
      drawCase();
      return;
    }
    if (t.closest("[data-compose-send]")) {
      submitComposer();
      return;
    }
    if (t.closest("[data-compose-cancel]")) {
      view.composer = null;
      drawCase();
      return;
    }
    var swarmRow = t.closest("[data-swarm-row]");
    if (swarmRow) {
      view.open = view.open === swarmRow.dataset.swarmRow ? null : swarmRow.dataset.swarmRow;
      drawCase();
      return;
    }
    var row = t.closest("[data-row]");
    if (row && !t.closest(".w-open")) {
      toggleRow(row.dataset.row);
      return;
    }
    var noteEl = t.closest(".note");
    if (noteEl) {
      var note = noteEl._note;
      if (t.closest(".note-x")) {
        removeNoteFor(note.id);
        return;
      }
      var act = t.closest("[data-note-act]");
      if (act) {
        var a = note.acts[Number(act.dataset.noteAct)];
        if (a.reply) openNoteReply(noteEl, a.reply);
        else {
          removeNoteFor(note.id);
          a.run();
        }
        return;
      }
      if (t.closest(".note-reply")) return;
      removeNoteFor(note.id);
      if (note.id === "roundup") openCase("roundup");
      else if (byId(note.id)) openCase("keys", note.id);
      return;
    }
    var tellPick = t.closest("[data-tell-pick] [data-tell]");
    if (tellPick) {
      intake.tell = tellPick.dataset.tell;
      drawTellPick();
      return;
    }
    if (t.closest("[data-hand-btn]")) {
      handIntake();
      return;
    }
    if (t.closest("[data-dock-hercule]")) {
      openIntake();
      return;
    }
    // A click outside the case closes it, as a menu closes.
    if (view.caseOpen && !t.closest("[data-case]") && !t.closest("[data-proto]")) closeCase();
  }

  function onInput(e) {
    if (e.target.classList.contains("w-note") && view.composer) view.composer.text = e.target.value;
  }

  /* ------------------------------------------------------------------ the prototype bar */

  function wireProto() {
    var play = document.querySelector("[data-proto-play]");
    function drawPlay() {
      play.innerHTML = Crew.icon(clock.playing ? "pause" : "play", 14);
      play.title = clock.playing ? "Pause" : "Play";
    }
    drawPlay();
    play.addEventListener("click", function () {
      clock.playing = !clock.playing;
      drawPlay();
    });
    document.querySelector("[data-proto-next]").addEventListener("click", function () {
      var next = nextEventAt();
      if (next !== null) advanceTo(next + 0.001);
    });
    document.querySelector("[data-proto-reset]").addEventListener("click", function () {
      var url = new URL(location.href);
      url.searchParams.delete("state");
      location.href = url.toString();
    });
    var pick = document.querySelector("[data-proto-state]");
    pick.value = STATE;
    pick.addEventListener("change", function () {
      var url = new URL(location.href);
      if (pick.value) url.searchParams.set("state", pick.value);
      else url.searchParams.delete("state");
      location.href = url.toString();
    });
    var current = root.dataset.theme === "orient-express" || root.dataset.theme === "dark" ? "orient-express" : "whitehaven";
    document.querySelectorAll("[data-theme-pick]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.themePick === current));
      b.addEventListener("click", function () {
        root.dataset.theme = b.dataset.themePick;
        document.querySelectorAll("[data-theme-pick]").forEach(function (x) {
          x.setAttribute("aria-pressed", String(x === b));
        });
      });
    });
  }

  /* ------------------------------------------------------------------ states */

  /** Runs the morning silently up to a time: the past raises no notification. */
  function pastUntil(minutes) {
    silent = true;
    clock.now = minutes;
    processEntries();
  }

  /** Moves to the next entry and lets it raise its notification, as it would live. */
  function liveToNext() {
    silent = false;
    var next = nextEventAt();
    if (next !== null) {
      clock.now = next + 0.001;
      processEntries();
    }
  }

  function setUp() {
    handoffs = STATE === "empty" || STATE === "swarm" ? [] : morning();
    handoffs.forEach(function (h) {
      h.attempt = 1;
    });
    var start = toMinutes("09:41");
    switch (STATE) {
      case "notify":
        pastUntil(toMinutes("09:21:59"));
        liveToNext();
        break;
      case "attempt2":
        pastUntil(start);
        silent = false;
        sendBack(byId("h3"), H3_NOTE);
        liveToNext();
        break;
      case "attempt2-landed":
        pastUntil(start);
        silent = false;
        sendBack(byId("h3"), H3_NOTE);
        liveToNext();
        removeNoteFor("h3", true);
        pressAnswer(byId("h3"), 0);
        liveToNext();
        break;
      case "landed":
        pastUntil(start);
        liveToNext();
        break;
      case "roundup":
      case "roundup-open":
        pastUntil(start);
        resume(byId("h6"), "Pushed `fix/3ds-eu-cards`; watching CI on the draft pull request");
        pastUntil(ROUNDUP_AT - 0.01);
        silent = false;
        clock.now = ROUNDUP_AT;
        processEntries();
        break;
      default:
        pastUntil(start);
    }
    silent = false;
  }

  function boot() {
    setUp();
    wireProto();
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    drawAll();
    switch (STATE) {
      case "open":
      case "empty":
        openCase("click");
        break;
      case "swarm":
        view.open = "s-review";
        openCase("click");
        view.open = "s-review";
        drawCase();
        break;
      case "result":
        openCase("keys", "h1");
        break;
      case "redo":
        openCase("keys", "h3");
        openComposer(byId("h3"), "sendback");
        break;
      case "failed":
        openCase("keys", "h5");
        openComposer(byId("h5"), "tryAgain");
        break;
      case "notify":
        var noteEl = notesEl().querySelector('[data-note="h3"]');
        if (noteEl) openNoteReply(noteEl, "sendback", H3_NOTE);
        break;
      case "contract":
        openIntake();
        break;
      case "roundup-open":
        clearNotes();
        openCase("roundup");
        break;
    }
    ready = true;
    clock.lastMinute = Math.floor(clock.now);
    setInterval(frame, FRAME_MS);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
