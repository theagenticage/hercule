// PROTOTYPE - Round Trip: every handoff comes back to Intake.
//
// The model, in four records:
//   - a signal: what a source asks of Rogier (a review request, a mail). Hand to an agent resolves
//     it at the click, as spec 10 §9.6 says, and starts a run;
//   - a run: the work out with an agent. It lives under the list, in "Out with agents", while it
//     works or waits on Rogier. It is not a signal and asks nothing, except when it waits;
//   - a result: a new signal the core raises when that run ends, landed or failed. It sits on To do
//     beside the others until Rogier signs off, acts on it, sends it back or takes over;
//   - a trip: the chain from the first signal through every attempt, which Done shows as one line.
//
// The page runs a small simulation on a clock that starts at 09:41:00. The prototype bar at the
// bottom right plays, pauses, jumps to the next event, resets and picks a state.
(function () {
  "use strict";

  var root = document.documentElement;
  var STATE = root.dataset.state || "";
  var SWARM = STATE === "swarm";
  var EMPTY = STATE === "empty";
  if (new URLSearchParams(location.search).get("bar") === "off") root.dataset.barOff = "";

  /* ------------------------------------------------------------------ time */

  // The page opens at 09:41:00 on Tuesday 29 September 2026. sim.t counts seconds since then.
  var START = 9 * 3600 + 41 * 60;
  var sim = { t: 0, playing: true, queue: [], fast: false };

  function now() {
    return START + sim.t;
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** Returns a time of day, given in seconds since midnight, as "09:41". */
  function formatClock(sec) {
    sec = Math.floor(sec);
    return pad(Math.floor(sec / 3600)) + ":" + pad(Math.floor((sec % 3600) / 60));
  }

  /** Returns a time of day with its seconds, as "09:41:07", for the prototype bar. */
  function formatClockSeconds(sec) {
    sec = Math.floor(sec);
    return formatClock(sec) + ":" + pad(sec % 60);
  }

  /** Parses "09:12" into seconds since midnight. */
  function parseClock(text) {
    var p = text.split(":");
    return Number(p[0]) * 3600 + Number(p[1]) * 60;
  }

  /** Returns how long something took: "40s", "7m 40s", "22m" or "1h 4m". Seconds show only under ten minutes. */
  function formatSpan(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60);
    if (m >= 60) return Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
    var s = sec % 60;
    return m + "m" + (m < 10 && s ? " " + s + "s" : "");
  }

  /** Returns an age to the minute, as a row shows it: "now", "8m" or "1h". */
  function formatAge(sec) {
    var m = Math.floor(Math.max(0, sec) / 60);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h";
  }

  /* ------------------------------------------------------------------ small builders */

  function hue(name) {
    return "--hue:var(--hue-" + Crew.lookFor(name).hue + ")";
  }

  /** Returns a colleague's name in its own hue. A thread is labelled "Thread" but keeps its own hue. */
  function who(name, label) {
    return '<span class="who-ink" style="' + hue(name) + '">' + (label || name) + "</span>";
  }

  function face(name, pose, size) {
    return Crew.face(name, { pose: pose || "idle", size: size || 22 });
  }

  // A source a signal came from: its mark in the row and the pane, its name in sentences.
  var SOURCES = {
    github: { name: "GitHub", mark: "github" },
    gmail: { name: "Gmail", mark: "gmail" },
    slack: { name: "Slack", mark: "slack" },
    linear: { name: "Linear", mark: "linear" },
    sentry: { name: "Sentry", mark: "sentry" },
    grafana: { name: "Grafana", mark: "grafana" },
    intercom: { name: "Intercom", mark: "intercom" },
    stripe: { name: "Stripe", mark: "stripe" },
    task: { name: "Task", icon: "tasks" },
  };

  function sourceMark(src, size) {
    var s = SOURCES[src];
    return s.icon ? Crew.icon(s.icon, size || 14) : Crew.brand(s.mark, size || 14);
  }

  // An answer on a signal. `key` says what a click does:
  //   act       a plugin action, run as Rogier (Post review, Merge #1302, Send reply)
  //   reply     a plugin action with one typed field; it opens a box first
  //   hand      Hand to an agent: starts a workflow with the signal as input
  //   signoff   the core's Done on a result: accepted, nothing sent
  //   sendback  starts the next attempt with Rogier's note; it opens a box first
  //   takeover  Rogier continues in the run's thread himself
  //   undo      a plugin action that reverts what the run did outside (close the PR, delete the draft)
  //   edit      opens the draft to change it before the action that sends it
  //   done      the core's Done on a plain signal
  //   dismiss   declines a triage finding
  //   allow, always, deny   the answers to a question a run asks mid-way
  function answer(key, label, describe, more) {
    var a = { key: key, label: label, describe: describe };
    for (var k in more) a[k] = more[k];
    if (!a.kbd) a.kbd = { signoff: "S", sendback: "B", takeover: "T", done: "E" }[key] || "";
    if (key === "signoff" || key === "done" || key === "dismiss" || key === "deny") a.quiet = !a.accent;
    if (key === "undo") a.danger = true;
    return a;
  }

  /* ------------------------------------------------------------------ the world */

  var WORKERS = {
    "Review PR": "Claude Code · Sonnet 5 · build-box-2",
    "Fix bug": "Claude Code · Opus 5.5 · studio-mac",
    "Fix bug (H5)": "Claude Code · Sonnet 5 · build-box-1",
    "Draft reply": "Claude Code · Haiku 4.5 · build-box-2",
    Investigate: "Codex · gpt-5.4 · build-box-1",
    thread: "Claude Code · Opus 5.5 · studio-mac",
  };

  var records = []; // signals: plain, from triage, and results
  var runs = []; // work out with agents
  var trips = {}; // id → { orig, wf, moves: [{ at, who, pose, text }] }
  var doneBefore = []; // signals resolved before the page opened that started no trip

  /** Adds a move to a trip's chain: who did what, when. Done draws the chain. */
  function logMove(tripId, who, pose, text, at) {
    trips[tripId].moves.push({ at: at === undefined ? now() : at, who: who, pose: pose, text: text });
  }

  // The seven handoffs of the morning, as the shared brief has them.
  var ORIGINALS = {
    h1: {
      src: "github",
      who: "Marta",
      kind: "review request",
      place: "payments-api #1294",
      title: "Retry Stripe webhooks with backoff",
      at: "09:02",
      words: "Stripe retries a failed webhook for three days, but we drop it after the first 500. This adds a queue with exponential backoff and a dead-letter table.",
    },
    h2: {
      src: "slack",
      who: "Pieter",
      kind: "tagged in a thread",
      place: "#acceptance",
      title: "Codes with a trailing space are rejected",
      at: "08:58",
      words: '<span class="b-at">@rogier</span> codes with a trailing space are rejected now. "SUMMER10 " fails, and it worked before. Customers paste them from emails.',
    },
    h3: {
      src: "gmail",
      who: "Marta Visser",
      kind: "mail",
      place: "Brightline",
      title: "Invoice INV-2291 in the company name",
      at: "08:41",
      words: "Hi Rogier, could you reissue INV-2291 in the company name instead of mine? Our finance team needs it for the books. Thanks, Marta",
    },
    h4: {
      src: "linear",
      who: "Jonas",
      kind: "question for you",
      place: "PAY-212",
      title: "Refunds for partial captures",
      at: "09:24",
      words: "Can we refund a partially captured payment? We captured €80 of a €120 authorisation and the refund call fails.",
    },
    h5: {
      src: "github",
      who: "GitHub Actions",
      kind: "checks failed on your PR",
      place: "webshop #1300",
      title: "Show VAT per line on invoices",
      at: "08:49",
      words: '<code>test (ubuntu)</code> failed on invoice.snap.ts, renders VAT per line: "29-09-2026 00:00" vs "28-09-2026 22:00".',
    },
    h6: {
      src: "sentry",
      who: "Sentry",
      kind: "alert for you",
      place: "webshop-prod",
      title: "Checkout fails for EU cards with 3-D Secure",
      at: "08:52",
      words: "412 events, 188 users since deploy #1289.",
    },
    h7: {
      src: "task",
      who: "Triage",
      kind: "proposal you accepted at 09:05",
      place: "ops",
      title: "Nightly backup job timing out on ops-db",
      at: "09:05",
      words: "The ops-db backup has run past its limit three nights in a row. The database grew 40% since August, and the job still copies it in one pass.",
    },
  };

  function startTrip(id, wf, handedAt, verb) {
    trips[id] = { id: id, orig: ORIGINALS[id] || records.filter(function (r) { return r.id === id; })[0].orig, wf: wf, moves: [] };
    logMove(id, "you", "", verb || "Handed to " + wf, handedAt);
  }

  /* ---------- results: what each run brings back ---------- */

  function resultH1() {
    return {
      id: "h1",
      type: "result",
      wf: "Review PR",
      worker: WORKERS["Review PR"],
      attempt: 1,
      landedAt: parseClock("09:20"),
      ran: 460,
      sub: "approve, 2 comments",
      confidence: "high",
      checked: ["Read all 4 files and ran the tests: 18 passed."],
      doubts: [],
      result: {
        type: "review",
        verdict: "Approve, with 2 comments",
        state: "Draft, not posted",
        change: { files: 4, plus: 112, minus: 18, from: "feat/webhook-backoff", to: "main", commits: 3, checks: "18 checks passed" },
        summary:
          "Exponential backoff with full jitter, base 2s, cap 30m. Idempotency keys survive retries, so a retry never double-books a payout. Safe to merge once the cap is configurable.",
        comments: [
          { at: "src/webhooks/retry.ts:42", text: "The 30-minute cap is hard-coded. Stripe retries for 3 days; read <code>WEBHOOK_RETRY_CAP_MS</code> so ops can raise it." },
          { at: "src/webhooks/retry.test.ts", text: "No test covers the jitter. A seeded random would make <code>computeDelay</code> testable." },
        ],
      },
      answers: [
        answer("act", "Post review", "Posts an approving review with <b>2 comments</b> on <b>#1294</b> in <b>rogier/payments-api</b> as <b>GitHub · rogier</b>", {
          accent: true,
          kbd: "↩",
          did: "Posted the review on #1294",
          end: "signed off, review posted",
        }),
        answer("edit", "Edit first", "Opens the comments here, so you change them before the review posts"),
        sendBack("Review PR"),
        takeOver("Review PR", "build-box-2"),
        answer("signoff", "Sign off", "Takes it off your list. Nothing is posted", { did: "Signed off", end: "signed off" }),
        answer("undo", "Discard draft", "Deletes the draft review. Nothing was posted", { did: "Discarded the draft review", end: "draft discarded" }),
      ],
    };
  }

  function resultH2() {
    return {
      id: "h2",
      type: "result",
      wf: "Fix bug",
      worker: WORKERS["Fix bug"],
      attempt: 1,
      landedAt: parseClock("09:27"),
      ran: 22 * 60,
      seenAt: parseClock("09:33"),
      sub: "draft PR #1302 · <span class=\"plus\">+14</span> <span class=\"minus\">−3</span>",
      confidence: "high",
      checked: ["Reproduced it with a failing test first."],
      doubts: [],
      result: {
        type: "pr",
        number: 1302,
        title: "Trim discount codes before lookup",
        change: { files: 2, plus: 14, minus: 3, from: "fix/trim-discount-codes", to: "main", checks: "26 checks passed" },
        cause:
          '<b>#1287</b> "Discount codes ignore letter case" replaced <code>code.trim()</code> with <code>code.toLowerCase()</code> in <code>normalizeCode</code>.',
        hook: "You signed off #1287 yesterday at 19:12",
        diff: [
          ["minus", "return code.toLowerCase();"],
          ["plus", "return code.trim().toLowerCase();"],
        ],
        reply: { to: "Pieter", where: "#acceptance", text: "Fixed in #1302. It reaches acceptance with the next deploy." },
      },
      answers: [
        answer("act", "Merge #1302", "Squash-merges <b>#1302</b> into <b>main</b> in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", {
          accent: true,
          kbd: "↩",
          did: "Merged #1302",
          end: "signed off, merged #1302",
        }),
        answer("act", "Reply to Pieter", "Posts the drafted reply in the <b>#acceptance</b> thread as <b>Slack · @rogier</b>", {
          did: "Replied to Pieter",
          end: "signed off, replied to Pieter",
        }),
        sendBack("Fix bug"),
        takeOver("Fix bug", "studio-mac"),
        answer("signoff", "Sign off", "Takes it off your list. Nothing is merged or sent", { did: "Signed off", end: "signed off" }),
        answer("undo", "Close the PR", "Closes draft <b>#1302</b> and deletes <b>fix/trim-discount-codes</b>", { did: "Closed #1302", end: "closed #1302" }),
      ],
    };
  }

  var LETTER_1 = [
    "Dear Ms. Visser,",
    "Thank you for reaching out regarding invoice INV-2291. We would be happy to accommodate your request. Please find the reissued invoice made out to Brightline Ltd attached to this email.",
    "Should you have any further questions, please do not hesitate to contact us.",
    "Kind regards,\nRogier Pennink\nAcme",
  ];
  var LETTER_2 = [
    "Hi Marta,",
    "Done: attached is INV-2291-R, made out to Brightline B.V. (KvK 81234567). I voided the original INV-2291, so your finance team can book this one.",
    "Best,\nRogier",
  ];
  var NOTE_H3 = "It's Brightline B.V. (KvK 81234567). First names, short. Reissue it as INV-2291-R in Stripe and attach that.";
  var NOTE_H5 = "You may edit .github/workflows/test.yml.";

  function resultH3() {
    return {
      id: "h3",
      type: "result",
      wf: "Draft reply",
      worker: WORKERS["Draft reply"],
      attempt: 1,
      landedAt: parseClock("09:22"),
      ran: 130,
      sub: "a draft reply in Gmail",
      confidence: "medium",
      checked: [],
      doubts: ["I couldn't find Brightline's legal name in earlier mail, so I guessed \"Ltd\".", "I attached the existing invoice. I can't create invoices."],
      chips: [
        { label: "Legal name: guessed Ltd", insert: "Legal name: " },
        { label: "Attached the old invoice", insert: "Attachment: " },
      ],
      result: {
        type: "letter",
        to: "Marta Visser",
        subject: "Re: Invoice INV-2291 in the company name",
        body: LETTER_1,
        attachment: { name: "INV-2291.pdf", note: "the original, still in Marta's name" },
        saved: "Saved in Gmail Drafts",
      },
      answers: letterAnswers(false),
    };
  }

  // The answers on a mail draft. Nothing is suggested while the agent itself doubts the draft.
  function letterAnswers(sure) {
    return [
      answer(
        "act",
        "Send reply",
        "Sends the reply to <b>Marta Visser</b> from <b>Gmail · rogier@personal</b> with <b>" + (sure ? "INV-2291-R.pdf" : "INV-2291.pdf") + "</b>",
        { accent: sure, kbd: sure ? "↩" : "", did: "Sent the reply to Marta Visser", end: "signed off, sent to Marta" },
      ),
      answer("edit", "Edit first", "Opens the draft here, so you change it before it sends"),
      sendBack("Draft reply"),
      takeOver("Draft reply", "build-box-2"),
      answer("signoff", "Sign off", "Takes it off your list. The draft stays in Gmail", { did: "Signed off", end: "signed off" }),
      answer("undo", "Discard draft", "Deletes the draft from <b>Gmail · rogier@personal</b>. Nothing was sent", { did: "Discarded the draft", end: "draft discarded" }),
    ];
  }

  function resultH3Second(sentBackAt) {
    var r = resultH3();
    r.attempt = 2;
    r.landedAt = now();
    r.ran = now() - sentBackAt;
    r.sub = "reply with INV-2291-R.pdf";
    r.confidence = "high";
    r.checked = ["Used the name and KvK number from your note.", "Voided INV-2291 and created INV-2291-R in Stripe, as you allowed at " + formatClock(trips.h3.allowedAt || now()) + "."];
    r.doubts = [];
    r.chips = [];
    r.result = {
      type: "letter",
      to: "Marta Visser",
      subject: "Re: Invoice INV-2291 in the company name",
      body: LETTER_2,
      before: LETTER_1,
      changes: [
        ["Brightline Ltd", "Brightline B.V. (KvK 81234567)"],
        ["Dear Ms. Visser", "Hi Marta"],
        ["INV-2291.pdf", "INV-2291-R.pdf"],
        ["8 lines", "4 lines"],
      ],
      attachment: { name: "INV-2291-R.pdf" },
      saved: "Saved in Gmail Drafts, in place of attempt 1",
      outside: "Changed in <b>Stripe · live</b>: voided <b>INV-2291</b>, created <b>INV-2291-R</b>. A void can't be undone.",
    };
    r.answers = letterAnswers(true);
    return r;
  }

  function resultH4() {
    return {
      id: "h4",
      type: "result",
      wf: "Investigate",
      worker: WORKERS.Investigate,
      attempt: 1,
      landedAt: now(),
      ran: now() - parseClock("09:33"),
      sub: "yes, pass an explicit amount",
      confidence: "high",
      checked: ["Reproduced the cause with a failing test."],
      doubts: ["I did not call Stripe's test mode."],
      chips: [{ label: "Did not call Stripe's test mode", insert: "Stripe test mode: " }],
      result: {
        type: "findings",
        answer:
          "Yes, Stripe allows it. <code>createRefund</code> defaults <code>amount</code> to <code>payment.amountAuthorized</code> when no amount is given. For a partial capture that is €120, more than the €80 captured, so Stripe returns <code>amount_too_large</code>.",
        fix: "Passing an explicit amount works today; the fix is one line at <code>src/refunds/refund.ts:88</code>.",
        replyDraft:
          "Yes. Pass the captured amount explicitly for now: createRefund defaults to the authorised €120, which Stripe refuses with amount_too_large. We'll fix the default in refund.ts.",
      },
      answers: [
        answer("reply", "Reply on PAY-212", "Posts the answer on <b>PAY-212</b> as <b>Linear · rogier</b>", {
          accent: true,
          kbd: "↩",
          did: "Replied on PAY-212",
          end: "signed off, replied on PAY-212",
          placeholder: "Your answer to Jonas…",
        }),
        answer("hand", "Hand to Fix bug", "Starts <b>Fix bug</b> on <b>payments-api</b> with these findings and <b>PAY-212</b>", {
          face: "Fix bug",
          fine: WORKERS["Fix bug"],
          wf: "Fix bug",
          did: "Handed to Fix bug",
        }),
        sendBack("Investigate"),
        takeOver("Investigate", "build-box-1"),
        answer("signoff", "Sign off", "Takes it off your list. Nothing is posted", { did: "Signed off", end: "signed off" }),
      ],
    };
  }

  function resultH5() {
    return {
      id: "h5",
      type: "result",
      wf: "Fix bug",
      worker: WORKERS["Fix bug (H5)"],
      attempt: 1,
      failed: true,
      landedAt: parseClock("09:26"),
      ran: 18 * 60,
      sub: '<span class="fail-ink">failed</span> · may not edit test.yml',
      checked: [],
      doubts: [],
      chips: [{ label: "May edit .github/workflows/test.yml", insert: NOTE_H5 }],
      result: {
        type: "failed",
        reason:
          "Gave up after 3 tries. The snapshot differs only on CI: the runner's time zone is UTC and the test formats dates in local time. Pinning the zone needs a change to <code>.github/workflows/test.yml</code>, which this run may not edit.",
        partial: { branch: "fix/invoice-snapshot-tz", commits: 1, pushed: false },
      },
      answers: [
        answer("sendback", "Try again with a note…", "Starts attempt 2 of <b>Fix bug</b> with your note, attempt 1 and its branch", {
          accent: true,
          kbd: "B",
          fine: WORKERS["Fix bug (H5)"],
        }),
        takeOver("Fix bug", "build-box-1", "Opens the run's thread on <b>build-box-1</b>, with <b>fix/invoice-snapshot-tz</b> checked out"),
        answer("signoff", "Let it go", "Takes it off your list. The branch stays on <b>build-box-1</b>", { kbd: "S", did: "Let it go", end: "let go" }),
      ],
    };
  }

  function resultH5Second(sentBackAt) {
    return {
      id: "h5",
      type: "result",
      wf: "Fix bug",
      worker: WORKERS["Fix bug (H5)"],
      attempt: 2,
      landedAt: now(),
      ran: now() - sentBackAt,
      sub: "pushed a fix, checks pass",
      confidence: "high",
      checked: ["The failing check passed on CI: 19 of 19."],
      doubts: [],
      result: {
        type: "pushed",
        text: "Pinned <code>TZ=Europe/Amsterdam</code> in <code>.github/workflows/test.yml</code> and pushed it to #1300. The snapshot now matches on CI.",
        change: { files: 2, plus: 6, minus: 2, from: "fix/invoice-snapshot-tz", to: "show-vat-per-line", checks: "19 checks passed" },
        rule: "Fix bug may push to the branches of your own pull requests. You set that up in Workflows › Fix bug.",
      },
      answers: [
        answer("signoff", "Sign off", "Takes it off your list. The commit stays on <b>#1300</b>", { accent: true, kbd: "↩", did: "Signed off", end: "signed off, fixed on #1300" }),
        sendBack("Fix bug"),
        takeOver("Fix bug", "build-box-1"),
        answer("undo", "Revert the commit", "Pushes a commit to <b>#1300</b> that reverts <b>a3f9c1e</b>", { did: "Reverted a3f9c1e", end: "reverted" }),
      ],
    };
  }

  function resultH7() {
    return {
      id: "h7",
      type: "result",
      wf: "Investigate",
      worker: WORKERS.Investigate,
      attempt: 1,
      landedAt: now(),
      ran: now() - parseClock("09:35"),
      sub: "dump in parallel: 38m",
      confidence: "medium",
      checked: ["Timed both on a copy of ops-db."],
      doubts: ["Measured on a copy, not on ops-db."],
      chips: [{ label: "Measured on a copy", insert: "On ops-db itself: " }],
      result: {
        type: "findings",
        answer:
          "<code>pg_dump</code> of <code>events</code> (41 GB) takes 1h 52m; the job's limit is 2h. Dump <code>events</code> in parallel with <code>--jobs 4</code>: 38m on a copy. Or drop the 90-day-old partitions the sweep already ignores.",
      },
      answers: [
        answer("hand", "Hand to Fix bug", "Starts <b>Fix bug</b> on <b>ops</b> with these findings and the Task", {
          face: "Fix bug",
          fine: WORKERS["Fix bug"],
          wf: "Fix bug",
          did: "Handed to Fix bug",
        }),
        sendBack("Investigate"),
        takeOver("Investigate", "build-box-1"),
        answer("signoff", "Sign off", "Takes it off your list. The Task stays open", { did: "Signed off", end: "signed off" }),
      ],
    };
  }

  function result1298(startedAt) {
    return {
      id: "s1298",
      type: "result",
      wf: "Fix bug",
      worker: WORKERS["Fix bug"],
      attempt: 1,
      landedAt: now(),
      ran: now() - startedAt,
      sub: "pushed 2 commits to #1298",
      confidence: "high",
      checked: ["Answered both of Sanne's comments; 31 tests pass."],
      doubts: [],
      result: {
        type: "pushed",
        text: "Reads the banner flag from the CMS entry only, and caches the entry for 60 seconds. Both of Sanne's comments are answered in the commits.",
        change: { files: 3, plus: 41, minus: 17, from: "promo-banner-cms", to: "main", checks: "22 checks passed" },
        rule: "Fix bug may push to the branches of your own pull requests. You set that up in Workflows › Fix bug.",
      },
      answers: [
        answer("act", "Ask Sanne again", "Re-requests a review from <b>Sanne</b> on <b>#1298</b> in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", {
          accent: true,
          kbd: "↩",
          did: "Asked Sanne to review #1298 again",
          end: "signed off, review re-requested",
        }),
        sendBack("Fix bug"),
        takeOver("Fix bug", "studio-mac"),
        answer("signoff", "Sign off", "Takes it off your list. Nothing is sent", { did: "Signed off", end: "signed off" }),
        answer("undo", "Revert both", "Pushes a commit to <b>#1298</b> that reverts the 2 commits", { did: "Reverted both commits", end: "reverted" }),
      ],
    };
  }

  function resultThreadStopped() {
    return {
      id: "h6",
      type: "result",
      wf: "Fix 3-D Secure checkout for EU cards",
      thread: true,
      worker: WORKERS.thread,
      attempt: 1,
      landedAt: now(),
      ran: now() - parseClock("09:02"),
      sub: "stopped before pushing",
      confidence: "high",
      checked: ["3 changed files, 24 tests pass."],
      doubts: [],
      result: { type: "findings", answer: "You said no to <code>git push</code>, so the fix stays on <code>fix/3ds-eu-cards</code> on studio-mac, not pushed: 3 files <span class=\"plus\">+48</span> <span class=\"minus\">−12</span>." },
      answers: [takeOver("the thread", "studio-mac", "Opens the thread, where the branch waits", true), answer("signoff", "Sign off", "Takes it off your list. The branch stays local", { did: "Signed off", end: "signed off" })],
    };
  }

  function sendBack(wf) {
    return answer("sendback", "Send back…", "Starts the next attempt of <b>" + wf + "</b> with your note and this result");
  }

  function takeOver(wf, machine, describe, accent) {
    return answer("takeover", "Take over", describe || "Opens the run's thread on <b>" + machine + "</b>, so you go on yourself", {
      accent: !!accent,
      kbd: accent ? "↩" : "T",
      did: "Took over " + wf,
      end: "taken over",
    });
  }

  /* ---------- runs: the work out with agents ---------- */

  function runH4() {
    return {
      id: "h4",
      wf: "Investigate",
      worker: WORKERS.Investigate,
      startedAt: parseClock("09:33"),
      attempt: 1,
      state: "working",
      steps: [
        [parseClock("09:33"), "Read PAY-212 and its 3 comments"],
        [parseClock("09:35"), "Searched payments-api for partial captures: 6 places"],
        [parseClock("09:37"), "Read <code>src/refunds/refund.ts</code>"],
        [parseClock("09:39"), "Ran <code>pnpm test refunds</code>: 31 passed"],
        [parseClock("09:41"), "Writing a failing test for a refund after a partial capture"],
      ],
    };
  }

  function runH7() {
    return {
      id: "h7",
      wf: "Investigate",
      worker: WORKERS.Investigate,
      startedAt: parseClock("09:35"),
      attempt: 1,
      state: "working",
      startedBy: "Started by you on the Task",
      steps: [
        [parseClock("09:35"), "Read the Task and its 3 sources"],
        [parseClock("09:36"), "Read the nightly-backup job in ops"],
        [parseClock("09:38"), "Restored last night's dump to a copy of ops-db"],
        [parseClock("09:40"), "<code>pg_dump</code> of <code>events</code> (41 GB) takes 1h 52m; the job's limit is 2h"],
      ],
    };
  }

  function runH6() {
    return {
      id: "h6",
      wf: "Fix 3-D Secure checkout for EU cards",
      thread: true,
      worker: WORKERS.thread,
      startedAt: parseClock("09:02"),
      attempt: 1,
      state: "waiting",
      waitingSince: parseClock("09:31"),
      steps: [
        [parseClock("09:02"), "Read the Sentry issue and deploy #1289"],
        [parseClock("09:14"), "Wrote a failing test for <code>requires_action</code>"],
        [parseClock("09:27"), "Fixed <code>handlePaymentResult</code>: 3 files <span class=\"plus\">+48</span> <span class=\"minus\">−12</span>, 24 tests passed"],
      ],
      question: {
        text: "Run <code>git push -u origin fix/3ds-eu-cards</code>?",
        answers: [
          answer("allow", "Allow once", "Pushes the branch this one time", { accent: true, kbd: "↩" }),
          answer("always", "Always allow git push", "Adds a Grant for <b>git push</b> in <b>webshop</b>"),
          answer("deny", "Deny", "Tells the agent no; the branch stays local"),
        ],
      },
    };
  }

  /* ---------- plain signals, from the Intake drawing ---------- */

  function plainSignals() {
    return [
      {
        id: "s1298",
        type: "signal",
        src: "github",
        kind: "Changes requested",
        title: "Move the promo banner to the CMS",
        who: "Sanne",
        place: "webshop #1298",
        at: parseClock("08:20"),
        asked: "Sanne reviewed your pull request at 08:20.",
        orig: {
          src: "github",
          who: "Sanne",
          kind: "changes requested",
          place: "webshop #1298",
          title: "Move the promo banner to the CMS",
          at: "08:20",
          words: "<code>banner.tsx:42</code> This still reads the old flag. Read it from the CMS entry too, or the banner shows twice. <code>cms.ts:18</code> Cache this. It runs on every page view.",
        },
        blocks: [
          {
            type: "thread",
            messages: [
              { who: "Sanne", at: "src/promo/banner.tsx:42", file: true, text: "This still reads the old flag. Read it from the CMS entry too, or the banner shows twice." },
              { who: "Sanne", at: "src/promo/cms.ts:18", file: true, text: "Cache this. It runs on every page view." },
            ],
          },
        ],
        answers: [
          answer("hand", "Hand to Fix bug", "Starts <b>Fix bug</b> on <b>webshop</b> with pull request <b>#1298</b> and its <b>2</b> review comments", {
            face: "Fix bug",
            fine: WORKERS["Fix bug"],
            wf: "Fix bug",
            accent: true,
            kbd: "↩",
            did: "Handed to Fix bug",
          }),
          answer("reply", "Reply…", "Posts your reply to the review on <b>#1298</b> as <b>GitHub · rogier</b>", {
            kbd: "R",
            did: "Replied to Sanne",
            placeholder: "Reply to Sanne's review…",
          }),
          answer("done", "Done", "Takes it off your list. GitHub is not told", { did: "Done, nothing sent" }),
        ],
        leaves: "Leaves your list when you push to #1298 or reply to the review, here or on GitHub.",
      },
      {
        id: "deps",
        type: "triage",
        src: "github",
        kind: "Offer",
        title: "Merge 4 dependency bumps",
        line: "Offer · webshop · all green, patch versions",
        at: parseClock("09:00"),
        asked: "Triage offered this at 09:00.",
        blocks: [
          { type: "gist", text: "Four Dependabot pull requests with patch versions only. Every check passed, and none touches checkout." },
          { type: "sources", rows: [{ src: "github", text: "<b>4</b> pull requests · #1290, #1291, #1295, #1297" }] },
        ],
        answers: [
          answer("act", "Merge 4", "Merges pull requests <b>#1290</b>, <b>#1291</b>, <b>#1295</b> and <b>#1297</b> in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", {
            accent: true,
            kbd: "↩",
            did: "Merged 4 pull requests",
          }),
          answer("dismiss", "Dismiss", "Does nothing", { did: "Dismissed" }),
        ],
        leaves: "Leaves your list when you answer it.",
      },
      {
        id: "android",
        type: "triage",
        src: "intercom",
        kind: "Unsure",
        title: "App is slow on Android",
        line: "Unsure · which project? · 7 conversations",
        at: parseClock("09:00"),
        asked: "Triage could not tell which project this belongs to.",
        blocks: [
          { type: "gist", text: "Seven customers say the app is slow on Android since Sunday. Both the webshop and payments-api shipped that day." },
          { type: "sources", rows: [{ src: "intercom", text: "<b>7</b> conversations since Sunday" }] },
        ],
        answers: [
          answer("choice", "webshop", "Creates the Task in <b>webshop</b>", { did: "Task in webshop" }),
          answer("choice", "payments-api", "Creates the Task in <b>payments-api</b>", { did: "Task in payments-api" }),
          answer("choice", "Not work", "Takes it off your list. No Task", { did: "Not work" }),
        ],
        leaves: "Leaves your list when you answer it.",
      },
    ];
  }

  var LATER = [
    { id: "l1296", src: "github", title: "Lazy-load product images", sub: "Pieter · review request · webshop #1296", until: "14:00" },
    { id: "l219", src: "linear", title: "Payout report rounds per line", sub: "Jonas · question for you · PAY-219", until: "Mon 09:00" },
  ];

  var EVENTS = [
    ["09:41", "linear", "Jonas commented on PAY-212", "known to Investigate"],
    ["09:33", "linear", "Jonas mentioned you on PAY-212", "→ signal · handed to Investigate"],
    ["09:31", "github", "Checks passed on #1294", "known to Review PR"],
    ["09:20", "gmail", "Marta Visser: Invoice INV-2291 in the company name", "→ signal · handed to Draft reply"],
    ["09:12", "github", "Marta requested your review on #1294", "→ signal · handed to Review PR"],
    ["09:00", "github", "4 Dependabot pull requests opened", "→ signal · on your To do list"],
    ["08:58", "slack", "Pieter mentioned you in #acceptance", "→ signal · handed to Fix bug"],
    ["08:52", "sentry", "Alert rule fired on WEBSHOP-3DS", "→ signal · fixing in a thread"],
    ["08:49", "github", "Checks failed on #1300", "→ signal · handed to Fix bug"],
    ["08:20", "github", "Sanne requested changes on #1298", "→ signal · on your To do list"],
  ];

  /** Fills the morning as it stands at 09:41: four results back, three runs out, three plain signals. */
  function seedMorning() {
    records = EMPTY ? [] : [resultH1(), resultH2(), resultH3(), resultH5()];
    records = records.concat(plainSignals());
    runs = EMPTY ? [] : [runH6(), runH4(), runH7()];
    if (!EMPTY) {
      startTrip("h1", "Review PR", parseClock("09:12"));
      logMove("h1", "Review PR", "done", "Back: a draft review, approve with 2 comments", parseClock("09:20"));
      startTrip("h2", "Fix bug", parseClock("09:05"));
      logMove("h2", "Fix bug", "done", "Back: draft PR #1302", parseClock("09:27"));
      logMove("h2", "you", "", "Opened it", parseClock("09:33"));
      startTrip("h3", "Draft reply", parseClock("09:20"));
      logMove("h3", "Draft reply", "done", "Back: a draft reply in Gmail, medium confidence", parseClock("09:22"));
      startTrip("h5", "Fix bug", parseClock("09:08"));
      logMove("h5", "Fix bug", "failed", "Failed: may not edit test.yml", parseClock("09:26"));
      startTrip("h4", "Investigate", parseClock("09:33"));
      startTrip("h6", "Fix 3-D Secure checkout for EU cards", parseClock("09:02"), "Started a thread on it");
      logMove("h6", "Fix 3-D Secure checkout for EU cards", "waiting", "Asked: run git push?", parseClock("09:31"));
      startTrip("h7", "Investigate", parseClock("09:35"), "Started Investigate on the Task");
      records.forEach(function (r) {
        if (r.type === "result") r.seen = !!r.seenAt;
      });
    }
    doneBefore = [
      { id: "d-sku", src: "github", title: "Lowercase SKUs in search", place: "webshop #1284", sub: "Done, nothing sent", at: "08:50", day: "today" },
      {
        id: "d-1287",
        src: "github",
        title: "Discount codes ignore letter case",
        place: "webshop #1287",
        sub: "Handed to Fix bug → signed off, merged #1287",
        at: "19:12",
        day: "yesterday",
        moves: [
          ["18:50", "you", "", "Handed to Fix bug"],
          ["19:12", "Fix bug", "done", "Back: draft PR #1287, high confidence"],
          ["19:12", "you", "", "Merged #1287 · signed off"],
        ],
      },
      {
        id: "d-smit",
        src: "gmail",
        title: "Reply to Pieter at Bakkerij Smit",
        place: "Bakkerij Smit",
        sub: "Handed to Draft reply → signed off, sent to Pieter",
        at: "18:44",
        day: "yesterday",
        moves: [
          ["18:40", "you", "", "Handed to Draft reply"],
          ["18:42", "Draft reply", "done", "Back: a draft reply, high confidence"],
          ["18:44", "you", "", "Sent the reply to Pieter · signed off"],
        ],
      },
    ];
    // H4 and H7 report as they go, then land: H4 about 12 seconds in, H7 about 40.
    schedule(6, function () {
      step("h4", "The test fails: Stripe returns <code>amount_too_large</code>");
    });
    schedule(12, function () {
      land("h4", resultH4(), "Back: an answer for Jonas, high confidence");
    });
    schedule(20, function () {
      step("h7", "Trying <code>pg_dump --jobs 4</code> on the copy");
    });
    schedule(32, function () {
      step("h7", "Parallel dump of <code>events</code> took 38m");
    });
    schedule(40, function () {
      land("h7", resultH7(), "Back: findings, medium confidence");
    });
  }

  /* ---------- at ten times the load ---------- */

  // 38 handoffs today: 9 landed unseen, 14 working, 2 need you, 3 failed, 10 signed off.
  function seedSwarm() {
    var reviews = ["Retry Stripe webhooks with backoff", "Rate-limit the public API", "Split checkout into steps", "Move invoices to the new PDF renderer"];
    var fixes = ["Codes with a trailing space are rejected", "Cart total off by a cent with two discounts", "Search drops accents"];
    var fixFails = ["Show VAT per line on invoices", "Flaky test in payouts"];
    records = [
      bundle("b-review", "Review PR", "github", reviews, [], "3 approve · 1 asks for changes", parseClock("09:20")),
      bundle("b-fix", "Fix bug", "github", fixes, fixFails, "3 draft PRs · 2 failed", parseClock("09:27")),
      bundle("b-draft", "Draft reply", "gmail", ["Invoice INV-2291 in the company name", "Refund for order 88213"], [], "2 drafts in Gmail", parseClock("09:31")),
      {
        id: "x-inv",
        type: "result",
        wf: "Investigate",
        worker: WORKERS.Investigate,
        attempt: 1,
        failed: true,
        landedAt: parseClock("09:36"),
        ran: 900,
        sub: '<span class="fail-ink">failed</span> · ops-db refused the connection',
        orig: { src: "grafana", who: "Grafana", kind: "alert", place: "ops", title: "Disk on build-box-2 above 90%", at: "09:10", words: "Disk usage 91% on /var/lib/docker." },
        result: { type: "failed", reason: "Could not reach build-box-2 over SSH after 3 tries: connection refused. Nothing changed.", partial: null },
        checked: [],
        doubts: [],
        chips: [],
        answers: resultH5().answers,
      },
    ];
    var fresh = [
      ["github", "Move the promo banner to the CMS", "Sanne · changes requested · webshop #1298", "08:20"],
      ["linear", "Settle the refund API shape", "Jonas · question for you · PAY-214", "08:44"],
      ["slack", "Is the iDEAL flow live on staging?", "Noor · tagged in a thread · #payments", "09:03"],
      ["github", "Add a dark mode to the order emails", "Marta · review request · webshop #1308", "09:14"],
      ["gmail", "Quote for 40 extra seats", "Brightline · mail · sales", "09:22"],
      ["sentry", "TypeError in cart drawer", "Sentry · alert for you · webshop-prod", "09:29"],
      ["linear", "Payout report rounds per line", "Jonas · question for you · PAY-219", "09:33"],
      ["github", "Bump Node to 24 in CI", "Pieter · review request · ops #88", "09:38"],
    ];
    fresh.forEach(function (f, i) {
      records.push({ id: "f" + i, type: "signal", src: f[0], title: f[1], line: f[2], at: parseClock(f[3]), blocks: [], answers: [], asked: "", fake: true });
    });
    records.push({ id: "f-more", type: "more", title: "68 more signals", at: parseClock("09:40") });
    plainSignals()
      .filter(function (s) {
        return s.type === "triage";
      })
      .forEach(function (s) {
        records.push(s);
      });
    records.forEach(function (r) {
      if (r.type === "result") {
        r.seen = false;
        trips[r.id] = { id: r.id, orig: r.orig || { src: r.src || "github", title: r.title, who: "", kind: "", place: "" }, wf: r.wf, moves: [] };
      }
    });
    runs = [runH6(), swarmQuestion()];
    runs.push({ id: "w-stack", wf: "", stack: ["Investigate", "Fix bug", "Review PR", "Draft reply", "Investigate"], working: 14, state: "working", steps: [] });
    doneBefore = [];
  }

  function bundle(id, wf, src, landed, failed, sub, at) {
    var members = landed
      .map(function (t) {
        return { title: t, failed: false };
      })
      .concat(
        failed.map(function (t) {
          return { title: t, failed: true };
        }),
      );
    var r = {
      id: id,
      type: "result",
      bundle: members,
      wf: wf,
      worker: WORKERS[wf] || "",
      attempt: 1,
      landedAt: at,
      ran: 0,
      src: src,
      failed: false,
      partFailed: failed.length,
      title: members.length + " " + { "Review PR": "reviews", "Fix bug": "fixes", "Draft reply": "drafts" }[wf] + " back",
      sub: sub,
      orig: { src: src, title: wf + " · " + members.length + " back", who: "", kind: "", place: "" },
      checked: [],
      doubts: [],
      chips: [],
      result: { type: "bundle" },
      answers: bundleAnswers(wf, landed.length, failed.length),
    };
    return r;
  }

  function bundleAnswers(wf, landed, failed) {
    if (wf === "Review PR")
      return [
        answer("act", "Post 3 approvals", "Posts approving reviews on <b>#1294</b>, <b>#1305</b> and <b>#1311</b> as <b>GitHub · rogier</b>, with their comments", {
          accent: true,
          kbd: "↩",
          did: "Posted 3 approvals",
          end: "signed off",
        }),
        answer("signoff", "Sign off all 4", "Takes all 4 off your list. Nothing is posted", { did: "Signed off 4", end: "signed off" }),
      ];
    if (wf === "Fix bug")
      return [
        answer("signoff", "Sign off the 3 PRs", "Takes the 3 draft PRs off your list. Nothing is merged", { did: "Signed off 3", end: "signed off" }),
        answer("sendback", "Try the 2 failed again…", "Starts attempt 2 of both failed runs with one note", { kbd: "B" }),
      ];
    return [answer("signoff", "Sign off both", "Takes both off your list. The drafts stay in Gmail", { did: "Signed off 2", end: "signed off" })];
  }

  function swarmQuestion() {
    return {
      id: "w-q2",
      wf: "Draft reply",
      worker: WORKERS["Draft reply"],
      startedAt: parseClock("09:25"),
      attempt: 1,
      state: "waiting",
      waitingSince: parseClock("09:38"),
      title: "Refund for order 88213",
      orig: { src: "gmail", who: "Daan de Wit", kind: "mail", place: "support", title: "Refund for order 88213", words: "The jacket arrived torn. Can I get my money back?" },
      steps: [[parseClock("09:25"), "Read the order and the 2 mails"]],
      question: {
        text: "Refund <b>€64.90</b> on order <b>88213</b> in <b>Stripe · live</b>?",
        answers: [answer("allow", "Allow once", "Refunds the charge this one time", { accent: true, kbd: "↩" }), answer("deny", "Deny", "Tells the agent no; it drafts without a refund")],
      },
    };
  }

  /* ------------------------------------------------------------------ the page's state */

  var view = "todo";
  var tab = "all";
  var selected = null; // the id of the open record or run
  var paneOpen = true;
  var compose = null; // { id, kind: "sendback" | "reply", text }
  var editing = null; // the id of a result whose draft is open for changes
  var showDiff = false;
  var trayOpen = true;
  var toast = null;
  var toastTimer = null;
  var pointerOnList = false;
  var held = [];

  function findRecord(id) {
    return records.filter(function (r) {
      return r.id === id;
    })[0];
  }

  function findRun(id) {
    return runs.filter(function (r) {
      return r.id === id;
    })[0];
  }

  function isOpen(r) {
    return r.status !== "resolved" && r.type !== "more";
  }

  function origOf(r) {
    return r.orig || (trips[r.id] && trips[r.id].orig) || ORIGINALS[r.id];
  }

  /** Returns the Intake tab a record shows under: its source's, triage's, or none beyond All. */
  function tabOf(r) {
    if (r.type === "triage") return "triage";
    if (r.type === "result") return origOf(r).src;
    return r.src;
  }

  function listTodo() {
    return records.filter(function (r) {
      return (isOpen(r) || r.type === "more") && (tab === "all" || tabOf(r) === tab);
    });
  }

  function countTodo(t) {
    if (SWARM && !t) return 90;
    return records.filter(function (r) {
      return isOpen(r) && (!t || tabOf(r) === t);
    }).length;
  }

  function sortAt(r) {
    return r.type === "result" ? r.landedAt : r.at;
  }

  /* ------------------------------------------------------------------ the bar */

  var TABS = [
    ["github", "GitHub"],
    ["gmail", "Gmail"],
    ["linear", "Linear"],
    ["slack", "Slack"],
    ["sentry", "Sentry"],
  ];

  function renderTabs() {
    var html = tabButton("all", "All", countTodo());
    TABS.forEach(function (t) {
      html += tabButton(t[0], Crew.brand(t[0], 14) + t[1], SWARM ? "" : countTodo(t[0]));
    });
    html += tabButton("triage", Crew.face("Triage", { size: 18 }) + "Triage", countTodo("triage"));
    document.querySelector("[data-tabs]").innerHTML = html;
    document.querySelector("[data-triage]").innerHTML =
      Crew.face("Triage", { size: 20 }) + "<span>Triage ran at <b>09:00</b> · next at 10:00</span>";
  }

  function tabButton(key, label, count) {
    return '<a class="tab' + (tab === key ? " is-on" : "") + '" href="#" data-tab-key="' + key + '">' + label + (count ? " <small>" + count + "</small>" : "") + "</a>";
  }

  function renderHead() {
    var later = LATER.length;
    document.querySelector("[data-head]").innerHTML =
      '<div class="seg asks-modes" role="group" aria-label="View">' +
      modeButton("todo", "To do", countTodo()) +
      modeButton("later", "Later", later) +
      modeButton("done", "Done") +
      modeButton("everything", "Everything") +
      "</div>";
  }

  function modeButton(key, label, count) {
    return '<button data-mode="' + key + '" aria-pressed="' + (view === key) + '">' + label + (count ? "<small>" + count + "</small>" : "") + "</button>";
  }

  /* ------------------------------------------------------------------ the list */

  function renderList() {
    var el = document.querySelector("[data-list]");
    var html = view === "todo" ? buildTodo() : view === "later" ? buildLater() : view === "done" ? buildDone() : buildEverything();
    if (toast) html += '<div class="asks-toast" data-toast-serial="' + toast.serial + '"><span class="asks-toast-text">' + toast.text + "</span></div>";
    el.innerHTML = html;
  }

  function buildTodo() {
    var shown = listTodo().sort(function (a, b) {
      return sortAt(a) - sortAt(b);
    });
    var now_ = shown.filter(function (r) {
      return r.priority === "urgent";
    });
    var signals = shown.filter(function (r) {
      return r.type !== "triage" && r.priority !== "urgent";
    });
    var triage = shown.filter(function (r) {
      return r.type === "triage";
    });
    var html = "";
    if (now_.length) html += section("Now", now_, "now");
    if (signals.length) html += section("Signals", signals, "signals");
    if (triage.length) html += section("From triage", triage, "triage", '<span class="asks-sec-right">7 events at 09:00</span>');
    if (!shown.length) html += '<p class="asks-empty">Nothing waits on you.</p>';
    var cleared = listDone().filter(function (d) {
      return d.day === "today";
    }).length;
    html += '<p class="asks-cleared">' + cleared + ' cleared today. <a href="#" data-mode="done">See Done</a></p>';
    return html;
  }

  function section(label, rows, key, right) {
    var count = key === "signals" && SWARM ? 88 : rows.length;
    return (
      '<h2 class="section-h asks-sec">' +
      (key === "now" ? '<span class="dot dot--fail"></span>' + label : label + ' <span class="count">' + count + "</span>") +
      (right || "") +
      "</h2>" +
      '<div class="asks-rows' +
      (key === "triage" ? " asks-rows--quiet" : "") +
      '">' +
      rows.map(row).join("") +
      "</div>"
    );
  }

  /** Returns a To do row: a plain signal reads as the Intake drawing has it; a result leads with the colleague's face. */
  function row(r) {
    if (r.type === "more") return '<p class="rt-more">' + r.title + " · oldest first</p>";
    var on = r.id === selected ? " is-on" : "";
    if (r.type !== "result") {
      var sub = r.line || r.who + " · " + r.kind.toLowerCase() + " · " + r.place;
      return (
        '<div class="ask-item' + on + '" data-key="' + r.id + '">' +
        '<button class="ask-row" data-id="' + r.id + '">' +
        '<span class="ask-mark">' + sourceMark(r.src, 16) + "</span>" +
        '<span class="ask-text"><span class="ask-title">' + r.title + '</span><span class="ask-sub">' + sub + "</span></span>" +
        '<span class="ask-end"><time class="ask-age">' + (r.type === "triage" ? formatClock(r.at) : formatAge(now() - r.at)) + "</time></span>" +
        "</button></div>"
      );
    }
    var orig = origOf(r);
    var pose = r.pose || (r.failed ? "failed" : "done");
    var lead = r.bundle ? bundleFaces(r) : face(r.wf, pose, 24);
    var attempt = r.attempt > 1 ? '<span class="rt-attempt">Attempt ' + r.attempt + "</span> · " : "";
    return (
      '<div class="ask-item rt-item' + on + (r.seen ? "" : " is-unseen") + '" data-key="' + r.id + '">' +
      '<button class="ask-row rt-row" data-id="' + r.id + '">' +
      '<span class="ask-mark rt-lead">' + lead + "</span>" +
      '<span class="ask-text"><span class="ask-title">' + (r.bundle ? r.title : orig.title) + "</span>" +
      '<span class="ask-sub rt-sub"><span class="rt-src">' + sourceMark(orig.src, 12) + "</span>" + attempt + who(r.wf, r.thread ? "Thread" : "") + " · " + r.sub + "</span></span>" +
      '<span class="ask-end"><time class="ask-age" title="' + (r.failed ? "Failed at " : "Back at ") + formatClock(r.landedAt) + '">' + formatAge(now() - r.landedAt) + "</time>" + (r.seen ? "" : '<i class="rt-unseen" title="Not seen yet"></i>') + "</span>" +
      "</button></div>"
    );
  }

  function bundleFaces(r) {
    return face(r.wf, r.partFailed ? "failed" : "done", 24);
  }

  function buildLater() {
    return (
      '<h2 class="section-h asks-sec">Back today</h2><div class="asks-rows">' +
      LATER.map(function (l) {
        return (
          '<div class="ask-item" data-key="' + l.id + '"><div class="ask-row rt-static">' +
          '<span class="ask-mark">' + sourceMark(l.src, 16) + "</span>" +
          '<span class="ask-text"><span class="ask-title">' + l.title + '</span><span class="ask-sub">' + l.sub + "</span></span>" +
          '<span class="ask-end"><span class="ask-until">' + Crew.icon("alarm", 12) + l.until + "</span></span></div></div>"
        );
      }).join("") +
      "</div>"
    );
  }

  /** Returns what Done lists: one row per trip, its chain in one line, then the plain answers. */
  function listDone() {
    var rows = [];
    Object.keys(trips).forEach(function (id) {
      var t = trips[id];
      if (!t.moves.length) return;
      rows.push({ id: "trip-" + id, trip: id, src: t.orig.src, title: t.orig.title, sub: describeChain(id), at: formatClock(t.moves[0].at), sortAt: t.moves[t.moves.length - 1].at, day: "today" });
    });
    records.forEach(function (r) {
      if (r.status === "resolved" && r.type !== "result" && !trips[r.id])
        rows.push({ id: "rec-" + r.id, src: r.src, title: r.title, sub: r.outcome, at: formatClock(r.resolvedAt), sortAt: r.resolvedAt, day: "today" });
    });
    rows.sort(function (a, b) {
      return b.sortAt - a.sortAt;
    });
    return rows.concat(doneBefore);
  }

  /** Returns a trip's chain in one line: "Handed to Draft reply → sent back once → signed off, sent to Marta". */
  function describeChain(id) {
    var t = trips[id];
    var parts = [t.moves[0].text];
    var backs = t.sentBack || 0;
    if (backs) parts.push(backs === 1 ? "sent back once" : "sent back " + backs + " times");
    var run = findRun(id);
    var rec = findRecord(id);
    if (t.end) parts.push(t.end);
    else if (run) parts.push(run.state === "waiting" ? '<span class="you-ink">needs you</span>' : "working");
    else if (rec && rec.type === "result" && isOpen(rec))
      parts.push(rec.failed ? '<span class="fail-ink">failed</span> ' + formatClock(rec.landedAt) + ", on To do" : "back " + formatClock(rec.landedAt) + ", on To do");
    return parts.join(" → ");
  }

  function buildDone() {
    var rows = listDone();
    var html = "";
    ["today", "yesterday"].forEach(function (day) {
      var list = rows.filter(function (d) {
        return d.day === day;
      });
      if (!list.length) return;
      html += '<h2 class="section-h asks-sec">' + (day === "today" ? "Today" : "Yesterday") + "</h2>";
      html +=
        '<div class="asks-rows asks-rows--quiet">' +
        list
          .map(function (d) {
            var mark = sourceMark(d.src, 16);
            return (
              '<div class="ask-item' + (selected === d.id ? " is-on" : "") + '" data-key="' + d.id + '">' +
              '<button class="ask-row" data-id="' + d.id + '">' +
              '<span class="ask-mark">' + mark + "</span>" +
              '<span class="ask-text"><span class="ask-title">' + d.title + '</span><span class="ask-sub">' + d.sub + "</span></span>" +
              '<span class="ask-end"><time class="ask-age">' + d.at + "</time></span></button></div>"
            );
          })
          .join("") +
        "</div>";
    });
    return html;
  }

  function buildEverything() {
    return (
      '<h2 class="section-h asks-sec">Today</h2><div class="asks-rows asks-rows--quiet">' +
      EVENTS.map(function (e) {
        return (
          '<div class="ask-item"><div class="ask-row rt-static">' +
          '<span class="ask-mark">' + sourceMark(e[1], 16) + "</span>" +
          '<span class="ask-text"><span class="ask-title">' + e[2] + '</span><span class="ask-sub">' + e[3] + "</span></span>" +
          '<span class="ask-end"><time class="ask-age">' + e[0] + "</time></span></div></div>"
        );
      }).join("") +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ out with agents */

  function renderTray() {
    var el = document.querySelector("[data-tray]");
    var waiting = runs.filter(function (r) {
      return r.state === "waiting";
    });
    var total = SWARM ? 16 : runs.length;
    var head =
      '<h2 class="rt-tray-h"><button class="rt-tray-toggle" data-tray-toggle aria-expanded="' + trayOpen + '">' +
      "<span>Out with agents</span>" +
      (total ? '<b class="count">' + total + "</b>" : "") +
      Crew.icon(trayOpen ? "chev-d" : "chev-r", 12) +
      "</button>" +
      (waiting.length ? '<span class="rt-tray-sum you-ink">' + Crew.mark("waiting", 12) + (SWARM ? 2 : waiting.length) + " need" + (waiting.length === 1 && !SWARM ? "s" : "") + " you</span>" : "") +
      "</h2>";
    if (!runs.length) {
      el.innerHTML =
        head +
        '<p class="rt-tray-empty">' +
        (EMPTY ? "Nothing handed off today." : "Nothing out with agents right now.") +
        "</p>" +
        (EMPTY ? emptyGhost() : "");
      return;
    }
    var shown = trayOpen
      ? runs
      : runs.filter(function (r) {
          return r.state === "waiting";
        });
    el.innerHTML =
      head +
      '<div class="rt-runs">' +
      shown.map(trayRow).join("") +
      (!trayOpen && shown.length < runs.length ? '<p class="rt-tray-folded">' + facesOf(runs.filter(function (r) { return r.state !== "waiting"; })) + "</p>" : "") +
      "</div>";
  }

  // A faded example of a run, so an empty morning shows what will wait here while an agent works.
  function emptyGhost() {
    return (
      '<div class="rt-ghost-row" aria-hidden="true">' +
      face("Fix bug", "working", 22) +
      '<span class="rt-run-text"><span class="rt-run-title">The next signal you hand to an agent</span><span class="rt-run-sub">' + who("Fix bug") + " · what it is doing, as it reports it</span></span>" +
      '<span class="rt-run-end">2m</span></div>' +
      '<p class="rt-tray-note">When it ends, what it brings back lands on To do as a new signal.</p>'
    );
  }

  function facesOf(list) {
    return (
      '<span class="stack">' +
      list
        .slice(0, 4)
        .map(function (r) {
          return face(r.wf, "working", 20);
        })
        .join("") +
      "</span><span>" +
      list.length +
      " working</span>"
    );
  }

  function trayRow(r) {
    if (r.stack) {
      return (
        '<div class="rt-run-item" data-key="' + r.id + '"><div class="rt-run rt-run--stack">' +
        '<span class="stack">' +
        r.stack
          .map(function (n) {
            return face(n, "working", 22);
          })
          .join("") +
        '</span><span class="rt-run-text"><span class="rt-run-title">' + r.working + ' working</span><span class="rt-run-sub">Review PR 5 · Fix bug 4 · Investigate 3 · Draft reply 2</span></span></div></div>'
      );
    }
    var orig = origOf(r);
    var title = r.title || orig.title;
    var last = r.steps.length ? r.steps[r.steps.length - 1][1] : "";
    var waiting = r.state === "waiting";
    var sub = waiting ? r.question.text : last;
    var end = formatAge(now() - (waiting ? r.waitingSince : r.startedAt));
    return (
      '<div class="rt-run-item' + (selected === r.id ? " is-on" : "") + (waiting ? " is-you" : "") + '" data-key="' + r.id + '">' +
      '<button class="rt-run" data-run="' + r.id + '">' +
      face(r.wf, waiting ? "waiting" : "working", 22) +
      '<span class="rt-run-text"><span class="rt-run-title">' + (r.attempt > 1 ? '<span class="rt-attempt">Attempt ' + r.attempt + "</span> · " : "") + title + "</span>" +
      '<span class="rt-run-sub" data-narration="' + r.id + '">' + (waiting ? "" : who(r.wf, r.thread ? "Thread" : "") + " · ") + sub + "</span></span>" +
      '<span class="rt-run-end' + (waiting ? " you-ink" : "") + '">' + end + "</span></button>" +
      (waiting ? '<div class="rt-run-ans">' + r.question.answers.map(function (a, i) { return questionButton(r, a, i); }).join("") + "</div>" : "") +
      "</div>"
    );
  }

  // A run's question, answered in the tray: its answers in three fixed slots, suggested, second
  // and quiet, so they line up from row to row. Each describe line is in the button's tooltip
  // here and in full in the pane's ledger, one click away.
  function questionButton(r, a, i) {
    var cls = "btn btn--sm" + (a.accent ? " btn--accent" : "") + (a.quiet ? " btn--quiet" : "");
    var slot = a.accent ? 1 : a.quiet ? 3 : 2;
    return '<button class="' + cls + '" style="grid-column:' + slot + '" data-question="' + r.id + '" data-q="' + i + '" title="' + stripTags(a.describe) + '">' + a.label + "</button>";
  }

  /* ------------------------------------------------------------------ the pane */

  function renderPane() {
    var split = document.querySelector("[data-split]");
    var el = document.querySelector("[data-rt-pane]");
    var open = paneOpen && !!selected && (view === "todo" || view === "done");
    split.classList.toggle("is-wide", !open);
    var btn = document.querySelector("[data-pane-toggle]");
    btn.setAttribute("aria-pressed", String(open));
    if (!open) {
      el.innerHTML = "";
      return;
    }
    var html;
    if (view === "done") html = buildDonePane(selected);
    else {
      var run = findRun(selected);
      var rec = findRecord(selected);
      if (run && (!rec || !isOpen(rec))) html = buildRunPane(run);
      else if (rec && rec.type === "result") html = rec.bundle ? buildBundlePane(rec) : buildResultPane(rec);
      else if (rec) html = buildSignalPane(rec);
      else html = "";
    }
    el.innerHTML = html;
    var input = el.querySelector("[data-compose-input]");
    if (input && compose && document.activeElement !== input) {
      input.value = compose.text;
      if (!isFramed()) input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      // The box opens at the foot of the pane, so the pane scrolls until the whole box shows.
      el.scrollTop = el.scrollHeight;
    }
  }

  function isFramed() {
    return window.top !== window;
  }

  /* ---------- a result: you asked, it did, and your verdict ---------- */

  function buildResultPane(r) {
    var orig = origOf(r);
    var trip = trips[r.id];
    var pose = r.failed ? "failed" : "done";
    var wfName = r.thread ? "Thread" : r.wf;
    return (
      '<div class="ad rt-pane">' +
      '<header class="ad-head"><div class="ad-kind">' +
      '<span class="src">' + face(r.wf, pose, 18) + wfName + "</span><span>·</span><span>" + (r.failed ? '<span class="fail-ink">Failed</span>' : "Result") + "</span>" +
      (r.attempt > 1 ? '<span class="chip rt-chip-attempt">Attempt ' + r.attempt + "</span>" : "") +
      '<span class="spacer"></span><button class="btn btn--quiet btn--sm" data-open-run>Open the run' + Crew.icon("external", 13) + "</button></div>" +
      '<h2 class="ad-title">' + orig.title + "</h2>" +
      '<p class="ad-asked">' + (r.failed ? "Failed at " : "Back at ") + formatClock(r.landedAt) + " after " + formatSpan(r.ran) + " · " + r.worker + "</p></header>" +
      '<div class="rt-trip">' +
      youAsked(r, orig, trip) +
      itDid(r, pose) +
      "</div>" +
      verdict(r) +
      '<footer class="ad-foot"><p class="ad-leaves">' + Crew.icon("check", 14) + "Leaves your list when you sign off, act on it, send it back or take over.</p>" +
      '<p class="ad-raised">Raised by Hercule when the ' + (r.thread ? "thread's turn" : wfName + " run") + " ended · <code>result</code> · <a href=\"#\" data-goto-done=\"" + r.id + '">See the trip</a></p></footer>' +
      "</div>" +
      keysFor(r)
    );
  }

  function youAsked(r, orig, trip) {
    var handed = trip ? trip.moves[0] : null;
    var notes = (trip && trip.notes) || [];
    return (
      '<div class="msg rt-msg rt-msg--you">' +
      '<span class="rt-av">' + Crew.you(28) + "</span>" +
      '<div class="rt-msg-body">' +
      '<div class="msg-name rt-name">You asked <small>' + (handed ? formatClock(handed.at) : "") + (handed ? " · " + lowerFirst(handed.text) : "") + "</small></div>" +
      '<div class="rt-orig">' +
      '<div class="rt-orig-h"><span class="rt-orig-src">' + sourceMark(orig.src, 13) + "</span><b>" + orig.who + "</b> · " + orig.kind + " · " + orig.place + "</div>" +
      '<p class="rt-orig-q">' + orig.words + "</p></div>" +
      notes
        .map(function (n) {
          return '<div class="rt-note"><span class="rt-note-h">Sent back at ' + formatClock(n.at) + "</span><p>" + escapeHtml(n.text) + "</p></div>";
        })
        .join("") +
      "</div></div>"
    );
  }

  function lowerFirst(text) {
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function itDid(r, pose) {
    var conf = r.failed
      ? ""
      : r.confidence === "high"
        ? '<span class="rt-conf">' + Crew.icon("shield", 13) + "High confidence</span>"
        : '<span class="rt-conf rt-conf--you">' + Crew.icon("question", 13) + "Medium confidence</span>";
    return (
      '<div class="msg rt-msg rt-msg--did">' +
      '<span class="rt-av">' + face(r.wf, pose, 28) + "</span>" +
      '<div class="rt-msg-body">' +
      '<div class="msg-name rt-name" style="' + hue(r.wf) + '">' + (r.thread ? "Thread" : r.wf) + " <small>" + (r.failed ? "failed " : "back ") + formatClock(r.landedAt) + "</small>" + conf + "</div>" +
      drawResult(r) +
      proof(r) +
      "</div></div>"
    );
  }

  /** Returns the result drawn by its type: a review, a pull request, a letter, findings, a push or a failure. */
  function drawResult(r) {
    var x = r.result;
    var edit = editing === r.id ? ' contenteditable="true" spellcheck="false"' : "";
    switch (x.type) {
      case "review":
        return (
          '<div class="rt-verdict">' + Crew.mark("done", 14) + "<b>" + x.verdict + '</b><span class="chip">' + x.state + "</span>" + editButton(r) + "</div>" +
          '<p class="rt-text">' + x.summary + "</p>" +
          '<div class="rt-comments' + (edit ? " is-editing" : "") + '">' +
          x.comments
            .map(function (c) {
              return '<div class="rt-comment"><span class="mono rt-comment-at">' + c.at + '</span><p' + edit + ">" + c.text + "</p></div>";
            })
            .join("") +
          "</div>"
        );
      case "pr":
        return (
          '<div class="rt-verdict">' + Crew.brand("github", 14) + "<b>#" + x.number + " " + x.title + '</b><span class="chip">Draft</span></div>' +
          changeLine(x.change) +
          '<p class="rt-text"><span class="rt-label">Cause</span>' + x.cause + "</p>" +
          '<a href="#" class="rt-hook" data-goto-done="d-1287">' + Crew.mark("done", 14) + "<span>" + x.hook + "</span>" + Crew.icon("chev-r", 12) + "</a>" +
          '<pre class="rt-diff mono">' +
          x.diff
            .map(function (d) {
              return '<span class="' + d[0] + '">' + (d[0] === "plus" ? "+ " : "− ") + d[1] + "</span>";
            })
            .join("\n") +
          "</pre>" +
          '<div class="rt-also"><span class="rt-label">Also drafted, not sent</span><div class="rt-also-msg">' + Crew.brand("slack", 13) + "<span>Reply to " + x.reply.to + " in " + x.reply.where + ": " + x.reply.text + "</span></div></div>"
        );
      case "letter":
        return letter(r, x, edit);
      case "findings":
        return '<p class="rt-text rt-answer">' + x.answer + "</p>" + (x.fix ? '<p class="rt-text"><span class="rt-label">The fix</span>' + x.fix + "</p>" : "");
      case "pushed":
        return '<p class="rt-text">' + x.text + "</p>" + changeLine(x.change) + '<p class="rt-rule">' + Crew.icon("shield", 13) + "<span>" + x.rule + "</span></p>";
      case "failed":
        return (
          '<p class="rt-text rt-fail">' + x.reason + "</p>" +
          (x.partial
            ? '<div class="rt-partial">' + Crew.icon("branch", 14) + '<span class="mono">' + x.partial.branch + "</span><span>· " + x.partial.commits + " commit · not pushed</span></div>"
            : "")
        );
    }
    return "";
  }

  /** Returns the quiet Edit button a draft carries, or "" when the result has nothing to edit. */
  function editButton(r) {
    var i = r.answers
      .map(function (a) {
        return a.key;
      })
      .indexOf("edit");
    if (i < 0) return "";
    return '<button class="btn btn--quiet btn--sm rt-edit" data-answer="' + i + '">' + Crew.icon("compose", 13) + (editing === r.id ? "Done editing" : "Edit") + "</button>";
  }

  function changeLine(c) {
    return (
      '<div class="b-change rt-change">' +
      '<span class="b-change-files">' + Crew.icon("diff", 14) + c.files + " files</span>" +
      '<span class="plus">+' + c.plus + '</span><span class="minus">−' + c.minus + "</span>" +
      '<span class="b-change-ref">' + Crew.icon("branch", 14) + '<span class="mono">' + c.from + "</span>" + Crew.icon("arrow", 12) + '<span class="mono">' + c.to + "</span></span>" +
      '<span class="b-change-checks">' + Crew.mark("done", 14) + c.checks + "</span></div>"
    );
  }

  // A mail draft drawn as the letter it is: who it goes to, the subject, the body and the file.
  // Attempt 2 adds what changed since attempt 1, as pairs, and on request both letters side by side.
  function letter(r, x, edit) {
    // Compared, the two attempts sit side by side: a rewrite reads better whole than as a word diff,
    // and the pairs above already name each change.
    var body =
      showDiff && x.before
        ? '<div class="rt-compare"><div class="rt-compare-was"><span class="rt-label">Attempt 1</span>' + x.before.map(paragraph).join("") + "</div>" +
          '<div><span class="rt-label">Attempt 2</span>' + x.body.map(paragraph).join("") + "</div></div>"
        : x.body.map(paragraph).join("");
    return (
      (x.changes
        ? '<div class="rt-changed"><div class="rt-changed-h"><span class="rt-label">What changed since attempt 1</span>' +
          '<button class="btn btn--quiet btn--sm" data-toggle-diff>' + (showDiff ? "Hide attempt 1" : "Compare with attempt 1") + "</button></div>" +
          '<ul class="rt-pairs">' +
          x.changes
            .map(function (p) {
              return '<li><span class="rt-was">' + p[0] + "</span>" + Crew.icon("arrow", 12) + '<span class="rt-now">' + p[1] + "</span></li>";
            })
            .join("") +
          "</ul></div>"
        : "") +
      '<article class="card rt-letter' + (edit ? " is-editing" : "") + '">' +
      '<dl class="rt-letter-head"><div><dt>To</dt><dd>' + x.to + "</dd></div><div><dt>Subject</dt><dd>" + x.subject + "</dd></div></dl>" +
      '<div class="rt-letter-body"' + edit + ">" + body + "</div>" +
      '<div class="rt-letter-foot"><span class="rt-file">' + Crew.icon("file", 14) + "<span>" + x.attachment.name + "</span></span>" +
      (x.attachment.note ? '<span class="rt-file-note">' + x.attachment.note + "</span>" : "") +
      '<span class="spacer"></span><span class="rt-saved">' + Crew.brand("gmail", 12) + x.saved + "</span>" + editButton(r) + "</div>" +
      "</article>" +
      (x.outside ? '<p class="rt-rule">' + Crew.brand("stripe", 13) + "<span>" + x.outside + "</span></p>" : "")
    );
  }

  function paragraph(text) {
    return "<p>" + text.replace(/\n/g, "<br>") + "</p>";
  }

  // What the agent checked, and what it was not sure about. Doubts are in marigold: each waits on
  // Rogier to read it, and each becomes a quick note when he sends the work back.
  function proof(r) {
    if (!r.checked.length && !r.doubts.length) return "";
    return (
      '<ul class="rt-proof">' +
      r.checked
        .map(function (c) {
          return '<li class="rt-proof-ok">' + Crew.icon("check", 14) + "<span>" + c + "</span></li>";
        })
        .join("") +
      r.doubts
        .map(function (d) {
          return '<li class="rt-proof-doubt">' + Crew.icon("question", 14) + "<span>" + d + "</span></li>";
        })
        .join("") +
      "</ul>"
    );
  }

  /** Returns the verdict: the answers as a ledger, or the box for a note when Rogier sends it back or replies. */
  function verdict(r) {
    if (compose && compose.id === r.id) return '<div class="ad-answers">' + composer(r) + "</div>";
    // Edit sits on the draft itself, so the ledger keeps only the answers that decide something.
    var answers = r.answers.map(function (a, i) {
      return a.key === "edit" ? "" : ledgerRow(a, i);
    });
    return '<div class="ad-answers"><div class="ledger">' + answers.join("") + "</div></div>";
  }

  function ledgerRow(a, i) {
    var cls = "btn" + (a.accent ? " btn--accent" : "") + (a.quiet ? " btn--quiet" : "") + (a.danger ? " btn--danger" : "");
    return (
      '<div class="ans" data-ans-row="' + i + '">' +
      '<button class="' + cls + '" data-answer="' + i + '">' + (a.face ? Crew.face(a.face, { size: 18 }) : "") + a.label + "</button>" +
      '<span class="ans-desc">' + a.describe + (a.fine ? '<span class="ad-fine">' + a.fine + "</span>" : "") + "</span>" +
      (a.kbd ? "<kbd>" + a.kbd + "</kbd>" : "<span></span>") +
      "</div>"
    );
  }

  function composer(r) {
    var sendingBack = compose.kind === "sendback";
    var a = r.answers[compose.answer];
    var wf = r.thread ? "the thread" : r.wf;
    var chips = sendingBack && r.chips && r.chips.length
      ? '<div class="rt-chips"><span class="rt-chips-h">From what it flagged</span>' +
        r.chips
          .map(function (c, i) {
            return '<button class="chip chip--you rt-chip" data-chip="' + i + '">' + Crew.icon("plus", 12) + c.label + "</button>";
          })
          .join("") +
        "</div>"
      : "";
    var describe = sendingBack
      ? "Starts attempt " + (r.attempt + 1) + " of <b>" + wf + "</b> with your note, " + (r.failed ? "attempt " + r.attempt + " and its branch" : "this result and its draft") + '<span class="ad-fine">' + r.worker + "</span>"
      : a.describe;
    return (
      '<div class="ad-compose card rt-compose">' +
      '<div class="rt-compose-h"><b>' + (sendingBack ? (r.failed ? "Try again with a note" : "Send back to " + wf) : a.label) + "</b>" +
      (sendingBack ? '<span class="rt-compose-sub">attempt ' + (r.attempt + 1) + "</span>" : "") + "</div>" +
      chips +
      '<textarea class="ad-compose-input" data-compose-input rows="3" placeholder="' + (sendingBack ? "What should change?" : a.placeholder) + '"></textarea>' +
      '<div class="ad-compose-row"><span class="ad-compose-desc">' + describe + "</span>" +
      '<button class="btn btn--quiet btn--sm" data-compose-cancel>Cancel <kbd>esc</kbd></button>' +
      '<button class="btn btn--sm btn--accent" data-compose-send>' + (sendingBack ? (r.failed ? "Try again" : "Send back") : "Post") + " <kbd>⌘↩</kbd></button></div></div>"
    );
  }

  function keysFor(r) {
    var keys = "<span><kbd>J</kbd><kbd>K</kbd> move</span>";
    var accent = r.answers.filter(function (a) {
      return a.accent;
    })[0];
    if (accent) keys += "<span><kbd>↩</kbd> " + lowerFirst(accent.label.replace("…", "")) + "</span>";
    if (r.type === "result") {
      var signoff = r.answers.filter(function (a) {
        return a.key === "signoff";
      })[0];
      if (signoff && !signoff.accent) keys += "<span><kbd>S</kbd> " + lowerFirst(signoff.label) + "</span>";
      if (has(r, "sendback") && !(accent && accent.key === "sendback")) keys += "<span><kbd>B</kbd> send back</span>";
      if (has(r, "takeover")) keys += "<span><kbd>T</kbd> take over</span>";
      keys += "<span><kbd>O</kbd> open the run</span>";
    } else {
      if (has(r, "reply")) keys += "<span><kbd>R</kbd> reply</span>";
      if (has(r, "done")) keys += "<span><kbd>E</kbd> done</span>";
    }
    return '<div class="ad-keys">' + keys + "</div>";
  }

  function has(r, key) {
    return r.answers.some(function (a) {
      return a.key === key;
    });
  }

  /* ---------- a run that is still out: read-only, except its question ---------- */

  function buildRunPane(run) {
    var orig = origOf(run);
    var trip = trips[run.id];
    var waiting = run.state === "waiting";
    var wfName = run.thread ? "Thread" : run.wf;
    return (
      '<div class="ad rt-pane">' +
      '<header class="ad-head"><div class="ad-kind">' +
      '<span class="src">' + face(run.wf, waiting ? "waiting" : "working", 18) + wfName + "</span><span>·</span><span>" + (waiting ? '<span class="you-ink">Needs you</span>' : "Working") + "</span>" +
      (run.attempt > 1 ? '<span class="chip rt-chip-attempt">Attempt ' + run.attempt + "</span>" : "") +
      '<span class="spacer"></span><button class="btn btn--quiet btn--sm" data-open-run>Open the ' + (run.thread ? "thread" : "run") + Crew.icon("external", 13) + "</button></div>" +
      '<h2 class="ad-title">' + (run.title || orig.title) + "</h2>" +
      '<p class="ad-asked">' + (run.attempt > 1 ? "Sent back at " : "Started at ") + formatClock(run.startedAt) + " · " + (now() - run.startedAt < 60 ? "just now" : formatAge(now() - run.startedAt) + " so far") + " · " + run.worker + "</p></header>" +
      '<div class="rt-trip">' +
      youAsked(run, orig, trip) +
      '<div class="msg rt-msg rt-msg--did">' +
      '<span class="rt-av">' + face(run.wf, waiting ? "waiting" : "working", 28) + "</span>" +
      '<div class="rt-msg-body">' +
      '<div class="msg-name rt-name" style="' + hue(run.wf) + '">' + wfName + " <small>" + (waiting ? "waiting on you since " + formatClock(run.waitingSince) : "working") + "</small></div>" +
      '<ol class="rt-steps">' +
      run.steps
        .map(function (s, i) {
          var live = i === run.steps.length - 1 && !waiting;
          return '<li class="' + (live ? "is-live" : "") + '"><time>' + formatClock(s[0]) + "</time>" + (live ? Crew.mark("working", 14) : '<span class="rt-step-dot"></span>') + "<span>" + s[1] + "</span></li>";
        })
        .join("") +
      "</ol>" +
      (waiting
        ? '<div class="rt-ask">' +
          '<p class="rt-ask-q">' + Crew.mark("waiting", 14) + "<span>" + run.question.text + "</span></p>" +
          '<div class="ledger">' +
          run.question.answers
            .map(function (a, i) {
              var cls = "btn" + (a.accent ? " btn--accent" : "") + (a.quiet ? " btn--quiet" : "");
              return '<div class="ans"><button class="' + cls + '" data-question="' + run.id + '" data-q="' + i + '">' + a.label + '</button><span class="ans-desc">' + a.describe + "</span>" + (a.kbd ? "<kbd>" + a.kbd + "</kbd>" : "<span></span>") + "</div>";
            })
            .join("") +
          "</div></div>"
        : "") +
      "</div></div></div>" +
      '<footer class="ad-foot"><p class="ad-leaves">' + Crew.icon("clock", 14) + "Not a signal yet. When it ends, what it brings back lands on To do.</p></footer>" +
      "</div>" +
      '<div class="ad-keys"><span><kbd>J</kbd><kbd>K</kbd> move</span>' + (waiting ? "<span><kbd>↩</kbd> allow once</span>" : "") + "<span><kbd>O</kbd> open the " + (run.thread ? "thread" : "run") + "</span></div>"
    );
  }

  /* ---------- at ten times the load: one row for many results ---------- */

  function buildBundlePane(r) {
    return (
      '<div class="ad rt-pane">' +
      '<header class="ad-head"><div class="ad-kind"><span class="src">' + face(r.wf, "done", 18) + r.wf + "</span><span>·</span><span>" + r.bundle.length + " results</span></div>" +
      '<h2 class="ad-title">' + r.bundle.length + " back from " + r.wf + "</h2>" +
      '<p class="ad-asked">Landed since 09:12 · ' + r.sub + "</p></header>" +
      '<ul class="rt-bundle">' +
      r.bundle
        .map(function (m, i) {
          var verdict = r.wf === "Review PR" ? (i === 3 ? "Asks for changes, 1 comment" : "Approve" + (i === 0 ? ", 2 comments" : "")) : m.failed ? "Failed" : r.wf === "Fix bug" ? "Draft PR, checks pass" : "Draft in Gmail";
          return (
            '<li class="rt-bundle-row">' + Crew.mark(m.failed ? "failed" : "done", 14) +
            '<span class="rt-bundle-text"><b>' + m.title + "</b><span" + (m.failed ? ' class="fail-ink"' : "") + ">" + verdict + "</span></span>" +
            '<button class="btn btn--quiet btn--sm">Open</button></li>'
          );
        })
        .join("") +
      "</ul>" +
      '<div class="ad-answers"><div class="ledger">' + r.answers.map(ledgerRow).join("") + "</div></div>" +
      '<footer class="ad-foot"><p class="ad-leaves">' + Crew.icon("check", 14) + "Results from one workflow fold into one row once three land unseen. Each still leaves on its own.</p></footer>" +
      "</div>" +
      '<div class="ad-keys"><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>↩</kbd> ' + lowerFirst(r.answers[0].label) + "</span></div>"
    );
  }

  /* ---------- a plain signal, drawn as the Intake drawing draws it ---------- */

  function buildSignalPane(r) {
    if (r.fake) return '<div class="ad rt-pane"><p class="asks-empty">This prototype draws the rows of this morning at ten times the load, not their panes.</p></div>';
    var system = SOURCES[r.src].name;
    var isTriage = r.type === "triage";
    var html =
      '<div class="ad rt-pane">' +
      '<header class="ad-head"><div class="ad-kind"><span class="src">' + (isTriage ? Crew.face("Triage", { size: 18 }) : sourceMark(r.src, 14)) + r.kind + "</span>" +
      (r.place ? "<span>·</span><span>" + r.place + "</span>" : "") +
      '<span class="spacer"></span>' + (isTriage ? "" : '<button class="btn btn--quiet btn--sm">Open on ' + system + Crew.icon("external", 13) + "</button>") + "</div>" +
      '<h2 class="ad-title">' + r.title + "</h2><p class=\"ad-asked\">" + r.asked + "</p></header>" +
      '<div class="ad-blocks">' + r.blocks.map(block).join("") + "</div>";
    if (compose && compose.id === r.id) html += '<div class="ad-answers">' + composer(r) + "</div>";
    else if (r.answers[0] && r.answers[0].key === "choice")
      html +=
        '<div class="ad-answers"><div class="ad-choices">' +
        r.answers
          .map(function (a, i) {
            return '<div class="ad-choice"><button class="btn" data-answer="' + i + '">' + a.label + '</button><span class="ans-desc">' + a.describe + "</span></div>";
          })
          .join("") +
        "</div></div>";
    else html += '<div class="ad-answers"><div class="ledger">' + r.answers.map(ledgerRow).join("") + "</div></div>";
    html +=
      '<footer class="ad-foot"><p class="ad-leaves">' + Crew.icon("check", 14) + r.leaves + "</p>" +
      (r.answers.some(function (a) { return a.key === "hand"; }) ? '<p class="ad-raised">Hand it to an agent, and what it brings back lands here.</p>' : "") +
      "</footer></div>" +
      keysFor(r);
    return html;
  }

  function block(b) {
    if (b.type === "thread")
      return (
        '<div class="b-thread">' +
        b.messages
          .map(function (m) {
            return '<div class="b-msg"><div class="b-msg-head"><b>' + m.who + '</b><span class="mono">' + m.at + "</span></div><p>" + m.text + "</p></div>";
          })
          .join("") +
        "</div>"
      );
    if (b.type === "gist") return '<p class="b-gist">' + b.text + "</p>";
    if (b.type === "sources")
      return (
        '<ul class="b-sources">' +
        b.rows
          .map(function (s) {
            return "<li>" + sourceMark(s.src, 14) + "<span>" + s.text + "</span></li>";
          })
          .join("") +
        "</ul>"
      );
    return "";
  }

  /* ---------- Done: the trip as one chain ---------- */

  function buildDonePane(id) {
    var d = listDone().filter(function (x) {
      return x.id === id;
    })[0];
    if (!d) return "";
    var t = d.trip ? trips[d.trip] : null;
    var moves = t
      ? t.moves
      : (d.moves || []).map(function (m) {
          return { at: parseClock(m[0]), who: m[1], pose: m[2], text: m[3] };
        });
    var src = t ? t.orig.src : d.src;
    if (!moves.length) {
      return (
        '<div class="ad rt-pane"><header class="ad-head"><div class="ad-kind"><span class="src">' + sourceMark(src, 14) + SOURCES[src].name + "</span><span>·</span><span>" + d.place + "</span></div>" +
        '<h2 class="ad-title">' + d.title + '</h2><p class="ad-asked">' + d.sub + " at " + d.at + "</p></header></div>" +
        '<div class="ad-keys"><span><kbd>J</kbd><kbd>K</kbd> move</span></div>'
      );
    }
    return (
      '<div class="ad rt-pane">' +
      '<header class="ad-head"><div class="ad-kind"><span class="src">' + sourceMark(src, 14) + SOURCES[src].name + "</span><span>·</span><span>" + (t ? t.orig.place : d.place) + "</span></div>" +
      '<h2 class="ad-title">' + d.title + "</h2>" +
      '<p class="ad-asked">' + d.sub + "</p></header>" +
      '<h3 class="rt-label rt-chain-h">The trip' + (d.day === "yesterday" ? ", yesterday" : "") + "</h3>" +
      '<ol class="rt-chain">' +
      moves
        .map(function (m) {
          var lead = m.who === "you" ? Crew.you(20) : face(m.who, m.pose, 20);
          return '<li><time>' + formatClock(m.at) + "</time>" + lead + "<span>" + m.text + "</span></li>";
        })
        .join("") +
      "</ol>" +
      '<footer class="ad-foot"><p class="ad-leaves">' + Crew.icon("check", 14) + "Done keeps the trip whole: the first signal, every attempt and your verdict.</p></footer>" +
      "</div>" +
      '<div class="ad-keys"><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>O</kbd> open the run</span></div>'
    );
  }

  /* ------------------------------------------------------------------ the sidebar */

  // The sidebar is crew.js's. The prototype keeps its two numbers true: Intake's To do count, and
  // Waiting on you, which gains and loses the questions runs ask.
  function syncSidebar() {
    var count = document.querySelector('.nav-row[href="intake.html"] .count');
    if (count) count.textContent = String(countTodo());
    var sec = document.querySelector(".side-sec--you");
    if (!sec) return;
    var h6 = findRun("h6");
    sec.querySelectorAll(".side-row--wait").forEach(function (row) {
      var name = row.querySelector(".side-name").textContent;
      if (name === "Fix 3-D Secure checkout" && (!h6 || h6.state !== "waiting") && !SWARM) row.remove();
    });
    var a2 = findRun("h3");
    var extra = sec.querySelector("[data-rt-wait]");
    if (a2 && a2.state === "waiting" && !extra) {
      sec.querySelector(".side-h").insertAdjacentHTML(
        "afterend",
        '<a class="side-row side-row--wait" href="#" data-rt-wait>' + face("Draft reply", "waiting", 24) + '<span class="side-text"><span class="side-name">Draft reply · INV-2291</span><span class="side-ask">Void INV-2291 in Stripe?</span></span></a>',
      );
    } else if (extra && (!a2 || a2.state !== "waiting")) extra.remove();
    var n = sec.querySelectorAll(".side-row--wait").length;
    var c = sec.querySelector(".side-h .count");
    if (c && !SWARM) c.textContent = String(n);
  }

  /* ------------------------------------------------------------------ rendering and motion */

  var DUR_1 = 120;
  var DUR_2 = 200;
  var DUR_3 = 320;
  var EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

  function motionAllowed() {
    return !sim.fast && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Records where every row of the list and the tray is now, so the next render can move them from there. */
  function snapshot() {
    var map = {};
    document.querySelectorAll("[data-list] [data-key], [data-tray] [data-key]").forEach(function (el) {
      map[el.dataset.key] = {
        rect: el.getBoundingClientRect(),
        tray: !!el.closest("[data-tray]"),
        clone: el.cloneNode(true),
        unseen: el.classList.contains("is-unseen"),
        narration: (el.querySelector("[data-narration]") || {}).innerHTML,
      };
    });
    return map;
  }

  /**
   * Moves each row from where it was to where it is now, on transform and opacity only:
   *   - a row that left fades out where it was, over --dur-1, and the rows below close up after it;
   *   - a row that moved between the list and the tray flies there as a copy, over --dur-3;
   *   - a row that is new fades in and drops 6px into place, over --dur-2;
   *   - a result that was opened loses its unseen dot over --dur-1;
   *   - a run's new narration line fades in over --dur-1.
   */
  function animateFrom(before) {
    if (!before || !motionAllowed()) return;
    var fly = document.querySelector("[data-fly]");
    var box = fly.getBoundingClientRect();
    var after = {};
    document.querySelectorAll("[data-list] [data-key], [data-tray] [data-key]").forEach(function (el) {
      after[el.dataset.key] = el;
    });
    var leaving = Object.keys(before).filter(function (k) {
      return !after[k];
    });
    leaving.forEach(function (k) {
      var b = before[k];
      var ghost = placeGhost(fly, box, b.clone, b.rect);
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR_1, easing: "linear", fill: "forwards" }).onfinish = function () {
        ghost.remove();
      };
    });
    var delay = leaving.length ? DUR_1 : 0;
    Object.keys(after).forEach(function (k) {
      var el = after[k];
      var b = before[k];
      var a = el.getBoundingClientRect();
      var inTray = !!el.closest("[data-tray]");
      if (!b) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: DUR_2, easing: EASE, delay: delay, fill: "backwards" },
        );
        return;
      }
      if (b.tray !== inTray) {
        var ghost = placeGhost(fly, box, el.cloneNode(true), b.rect, a.width);
        ghost.classList.add("rt-ghost--lift");
        el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: DUR_3 + delay });
        ghost.animate([{ transform: "none" }, { transform: "translate(" + (a.left - b.rect.left) + "px," + (a.top - b.rect.top) + "px)" }], {
          duration: DUR_3,
          easing: EASE,
          delay: delay,
          fill: "both",
        }).onfinish = function () {
          ghost.remove();
        };
        return;
      }
      var dy = b.rect.top - a.top;
      if (Math.abs(dy) > 0.5) el.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: DUR_3, easing: EASE, delay: delay, fill: "backwards" });
      if (b.unseen && !el.classList.contains("is-unseen")) {
        var end = el.querySelector(".ask-end");
        if (end) {
          end.insertAdjacentHTML("beforeend", '<i class="rt-unseen rt-unseen--leaving"></i>');
          var dot = end.lastChild;
          dot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR_1, fill: "forwards" }).onfinish = function () {
            dot.remove();
          };
        }
      }
      var nar = el.querySelector("[data-narration]");
      if (nar && b.narration !== undefined && b.narration !== nar.innerHTML) nar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR_2, easing: "linear" });
    });
  }

  function placeGhost(fly, box, node, rect, width) {
    node.classList.add("rt-ghost");
    node.removeAttribute("data-key");
    node.style.left = rect.left - box.left + "px";
    node.style.top = rect.top - box.top + "px";
    node.style.width = (width || rect.width) + "px";
    fly.appendChild(node);
    return node;
  }

  /** Draws the whole screen again; with motion, every row moves from where it was. */
  function render(opts) {
    opts = opts || {};
    var before = opts.still ? null : snapshot();
    renderTabs();
    renderHead();
    renderList();
    renderTray();
    if (opts.pane !== false) renderPane();
    syncSidebar();
    renderProto();
    animateFrom(before);
  }

  /* ------------------------------------------------------------------ the simulation */

  function schedule(at, fn) {
    sim.queue.push({ at: at, fn: fn });
    sim.queue.sort(function (a, b) {
      return a.at - b.at;
    });
  }

  function scheduleIn(seconds, fn) {
    schedule(sim.t + seconds, fn);
  }

  /** Runs every event that is due. A landing waits while the pointer is on the list, so nothing moves under it. */
  function runDue() {
    while (sim.queue.length && sim.queue[0].at <= sim.t + 1e-6) {
      var ev = sim.queue.shift();
      ev.fn();
    }
  }

  var shownMinute = Math.floor(START / 60);

  // Ages and elapsed times move once a minute. A row in flight is a copy, so the redraw waits
  // until it has landed: drawing the list again mid-flight would show the real row too early.
  function tick() {
    if (sim.playing) {
      sim.t += 0.25;
      runDue();
    }
    var minute = Math.floor(now() / 60);
    if (minute !== shownMinute && !document.querySelector("[data-fly]").children.length) {
      shownMinute = minute;
      render({ pane: !compose });
    } else renderProto();
  }

  /** Jumps the clock to the next scheduled event and runs it; each event draws what it changed. */
  function nextEvent() {
    if (!sim.queue.length) return;
    sim.t = Math.max(sim.t, sim.queue[0].at);
    runDue();
    renderProto();
  }

  /** Adds a line to a run's narration, as the agent reports it. */
  function step(id, text) {
    var run = findRun(id);
    if (!run) return;
    run.steps.push([now(), text]);
    render({ pane: selected === id && !compose });
  }

  /** Lands a run: it leaves Out with agents and its result arrives on To do as a new, unseen signal. */
  function land(id, result, move) {
    whenListIsFree(function () {
      runs = runs.filter(function (r) {
        return r.id !== id;
      });
      // A result that lands while its run is open in the pane is seen as it lands.
      result.seen = selected === id && paneOpen && view === "todo";
      records = records.filter(function (r) {
        return r.id !== id || r.type !== "result";
      });
      records.push(result);
      logMove(id, result.thread ? result.wf : result.wf, result.failed ? "failed" : "done", move || "Back");
      render({ pane: selected === id });
    });
  }

  function whenListIsFree(fn) {
    if (pointerOnList && !sim.fast) held.push(fn);
    else fn();
  }

  /* ------------------------------------------------------------------ moves */

  function showToast(text) {
    toast = { text: text, serial: Date.now() };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast = null;
      renderList();
    }, 5000);
  }

  /** Opens a record or a run in the pane. Opening a result marks it seen. */
  function select(id, focusAnswer) {
    selected = id;
    compose = null;
    editing = null;
    showDiff = false;
    var rec = findRecord(id);
    if (rec && rec.type === "result" && !rec.seen && isOpen(rec)) {
      rec.seen = true;
      rec.seenAt = now();
    }
    paneOpen = true;
    render();
    keepInView(id);
    if (focusAnswer) focusSuggested();
  }

  function keepInView(id) {
    var el = document.querySelector('[data-key="' + id + '"]');
    if (el && el.closest("[data-list]")) el.scrollIntoView({ block: "nearest" });
  }

  function focusSuggested() {
    var btn = document.querySelector("[data-rt-pane] .ans .btn--accent") || document.querySelector("[data-rt-pane] .ans [data-answer]");
    if (btn && !isFramed()) btn.focus();
  }

  /** Returns the ids of every row J and K step through: the list's, then the tray's. */
  function listOrder() {
    return Array.prototype.map.call(document.querySelectorAll("[data-list] [data-id], [data-tray] [data-run]"), function (el) {
      return el.dataset.id || el.dataset.run;
    });
  }

  function move(stepBy) {
    var order = listOrder();
    if (!order.length) return;
    var i = order.indexOf(selected);
    var next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + stepBy))];
    select(next);
  }

  /** Resolves a record with an outcome line, logs it on its trip, and opens the next row. */
  function resolve(rec, outcome, end) {
    var order = listOrder();
    var i = order.indexOf(rec.id);
    rec.status = "resolved";
    rec.outcome = outcome;
    rec.resolvedAt = now();
    if (trips[rec.id] && end) {
      trips[rec.id].end = end;
      logMove(rec.id, "you", "", outcome);
    }
    compose = null;
    editing = null;
    var rest = order.filter(function (id) {
      return id !== rec.id;
    });
    selected = rest[Math.min(i, rest.length - 1)] || null;
    var next = findRecord(selected);
    if (next && next.type === "result" && isOpen(next)) next.seen = true;
  }

  function takeAnswer(rec, i) {
    var a = rec.answers[i];
    if (!a) return;
    if (a.key === "sendback" || a.key === "reply") {
      compose = { id: rec.id, kind: a.key, answer: i, text: a.key === "reply" && rec.result && rec.result.replyDraft ? rec.result.replyDraft : "" };
      render();
      return;
    }
    if (a.key === "edit") {
      editing = editing === rec.id ? null : rec.id;
      render();
      return;
    }
    if (a.key === "hand") {
      handOff(rec, a);
      return;
    }
    resolve(rec, a.did || a.label, a.end || a.did);
    showToast(a.did + (rec.type === "result" && a.key !== "signoff" && a.key !== "takeover" ? ". Signed off" : ""));
    render();
  }

  /** Hands a signal, or a result, to a workflow: the row turns into a working row, then drops into Out with agents. */
  function handOff(rec, a) {
    var id = rec.id;
    var isResult = rec.type === "result";
    var orig = isResult ? origOf(rec) : rec.orig;
    if (isResult) {
      // A result handed on starts a new trip of its own, from the findings.
      id = rec.id + "-fix";
      ORIGINALS[id] = { src: orig.src, who: rec.wf, kind: "findings", place: orig.place, title: orig.title, at: formatClock(rec.landedAt), words: stripTags(rec.result.answer || "") };
      resolve(rec, "Handed to " + a.wf, "handed to " + a.wf);
    } else {
      resolve(rec, "Handed to " + a.wf);
      ORIGINALS[id] = orig;
    }
    startTrip(id, a.wf, now());
    var run = { id: id, wf: a.wf, worker: WORKERS[a.wf], startedAt: now(), attempt: 1, state: "working", steps: [[now(), "Reading " + (isResult ? "the findings" : "Sanne's 2 comments")]] };
    runs.push(run);
    selected = id;
    showToast(a.did);
    render();
    if (id === "s1298") {
      scheduleIn(4, function () {
        step(id, "Reading the flag in <code>src/promo/banner.tsx</code>");
      });
      scheduleIn(9, function () {
        step(id, "Cached the CMS entry; 31 tests pass");
      });
      scheduleIn(14, function () {
        land(id, result1298(run.startedAt), "Back: 2 commits pushed to #1298");
      });
    } else {
      scheduleIn(5, function () {
        step(id, "Writing a failing test first");
      });
    }
  }

  function stripTags(html) {
    return html.replace(/<[^>]+>/g, "");
  }

  /** Sends a result back with Rogier's note: the next attempt starts and drops into Out with agents. */
  function sendBackWith(rec, note) {
    var id = rec.id;
    var trip = trips[id];
    trip.sentBack = (trip.sentBack || 0) + 1;
    trip.notes = (trip.notes || []).concat([{ at: now(), text: note }]);
    logMove(id, "you", "", "Sent back: “" + escapeHtml(note) + "”");
    var attempt = rec.attempt + 1;
    var sentAt = now();
    var run = { id: id, wf: rec.wf, worker: rec.worker, startedAt: sentAt, attempt: attempt, state: "working", steps: [[sentAt, "Reading attempt " + rec.attempt + " and your note"]] };
    // First the row turns into a working row where it stands, then it drops into the tray.
    rec.status = "resolved";
    rec.outcome = "Sent back";
    compose = null;
    selected = id;
    var stand = {
      id: id,
      type: "result",
      wf: rec.wf,
      landedAt: rec.landedAt,
      attempt: attempt,
      seen: true,
      sub: "sending your note",
      pose: "working",
      orig: origOf(rec),
    };
    var holder = findIndex(rec);
    records.splice(holder, 1, stand);
    render({ pane: false });
    function dropIntoTray() {
      records = records.filter(function (r) {
        return r !== stand;
      });
      records.push(rec);
      runs.push(run);
      render();
    }
    if (motionAllowed()) setTimeout(dropIntoTray, DUR_3);
    else dropIntoTray();
    showToast("Sent back to " + rec.wf + ". Attempt " + attempt + " started");
    if (id === "h3") {
      scheduleIn(2, function () {
        step(id, "Looking up Brightline B.V. in Stripe");
      });
      scheduleIn(4, function () {
        var r = findRun(id);
        if (!r) return;
        r.state = "waiting";
        r.waitingSince = now();
        r.question = {
          text: "Void <b>INV-2291</b> and create <b>INV-2291-R</b> for <b>Brightline B.V.</b> in <b>Stripe · live</b>?",
          answers: [
            answer("allow", "Allow once", "Voids <b>INV-2291</b> and creates <b>INV-2291-R</b> in <b>Stripe · live</b>", { accent: true, kbd: "↩" }),
            answer("deny", "Deny", "Tells the agent no; attempt 1's draft stays"),
          ],
        };
        logMove(id, "Draft reply", "waiting", "Asked: void INV-2291 and create INV-2291-R in Stripe · live?");
        render({ pane: selected === id && !compose });
      });
    } else if (id === "h5") {
      scheduleIn(3, function () {
        step(id, "Pinned <code>TZ=Europe/Amsterdam</code> in <code>test.yml</code>");
      });
      scheduleIn(6, function () {
        step(id, "Pushed 1 commit to #1300 · checks running");
      });
      scheduleIn(10, function () {
        land(id, resultH5Second(sentAt), "Back: attempt 2 pushed a fix, checks pass");
      });
    } else {
      scheduleIn(4, function () {
        step(id, "Working through your note");
      });
      scheduleIn(9, function () {
        var again = JSON.parse(JSON.stringify(rec));
        again.answers = rec.answers;
        again.attempt = attempt;
        again.landedAt = now();
        again.ran = now() - sentAt;
        again.status = undefined;
        again.sub = "with your note";
        land(id, again, "Back: attempt " + attempt);
      });
    }
  }

  function findIndex(rec) {
    return records.indexOf(rec);
  }

  /** Answers the question a run asks mid-way, from the tray or the pane. */
  function answerQuestion(id, i) {
    var run = findRun(id);
    if (!run || run.state !== "waiting") return;
    var a = run.question.answers[i];
    var trip = trips[id];
    run.state = "working";
    if (id === "h6") {
      if (a.key === "deny") {
        logMove(id, "you", "", "Denied git push");
        run.steps.push([now(), "You said no to git push. Writing up what's left"]);
        scheduleIn(8, function () {
          land(id, resultThreadStopped(), "Back: stopped before pushing");
        });
      } else {
        logMove(id, "you", "", a.key === "always" ? "Always allowed git push" : "Allowed git push once");
        run.steps.push([now(), "Pushed <code>fix/3ds-eu-cards</code>; opening a draft pull request"]);
      }
      showToast(a.key === "deny" ? "Denied git push" : "Allowed git push");
    } else if (id === "h3") {
      if (a.key === "deny") {
        logMove(id, "you", "", "Denied the Stripe change");
        scheduleIn(2, function () {
          var failed = resultH3();
          failed.attempt = 2;
          failed.failed = true;
          failed.landedAt = now();
          failed.ran = now() - run.startedAt;
          failed.sub = '<span class="fail-ink">stopped</span> · you denied the Stripe change';
          failed.result = { type: "failed", reason: "You said no to the change in Stripe, so I stopped. Attempt 1's draft is still in Gmail.", partial: null };
          failed.answers = resultH5().answers.map(function (x) {
            return x.key === "takeover" ? takeOver("Draft reply", "build-box-2") : x;
          });
          land(id, failed, "Back: stopped, the Stripe change denied");
        });
      } else {
        trip.allowedAt = now();
        logMove(id, "you", "", "Allowed once: void INV-2291, create INV-2291-R");
        run.steps.push([now(), "Voided INV-2291; creating INV-2291-R"]);
        scheduleIn(3, function () {
          step(id, "Writing the reply to Marta");
        });
        scheduleIn(6, function () {
          land(id, resultH3Second(run.startedAt), "Back: attempt 2, a reply with INV-2291-R.pdf, high confidence");
        });
      }
      showToast(a.key === "deny" ? "Denied the Stripe change" : "Allowed once");
    } else {
      showToast(a.key === "deny" ? "Denied" : "Allowed once");
      runs = runs.filter(function (r) {
        return r.id !== id;
      });
    }
    render();
  }

  function sendCompose() {
    var rec = findRecord(compose.id);
    var input = document.querySelector("[data-compose-input]");
    var text = (input ? input.value : compose.text).trim();
    if (!text) {
      if (input) input.focus();
      return;
    }
    if (compose.kind === "sendback") {
      sendBackWith(rec, text);
      return;
    }
    var a = rec.answers[compose.answer];
    resolve(rec, a.did, a.end || a.did);
    showToast(a.did + (rec.type === "result" ? ". Signed off" : ""));
    render();
  }

  /* ------------------------------------------------------------------ input */

  document.addEventListener("click", function (e) {
    var t = e.target.closest("button, a");
    if (!t) return;
    if (t.tagName === "A" && t.getAttribute("href") === "#") e.preventDefault();
    var d = t.dataset;
    if (d.tabKey) {
      tab = d.tabKey;
      render({ still: true });
    } else if (d.mode) {
      view = d.mode;
      if (view === "done") selected = listDone()[0] && listDone()[0].id;
      else if (view === "todo") selected = (listTodo()[0] || {}).id;
      compose = null;
      render({ still: true });
    } else if (d.id) select(d.id);
    else if (d.run) select(d.run);
    else if (d.answer !== undefined) {
      var rec = findRecord(selected);
      if (rec) takeAnswer(rec, Number(d.answer));
    } else if (d.question) answerQuestion(d.question, Number(d.q));
    else if (t.hasAttribute("data-compose-send")) sendCompose();
    else if (t.hasAttribute("data-compose-cancel")) {
      compose = null;
      render();
    } else if (d.chip !== undefined) insertChip(Number(d.chip));
    else if (t.hasAttribute("data-toggle-diff")) {
      showDiff = !showDiff;
      render();
    } else if (t.hasAttribute("data-tray-toggle")) {
      trayOpen = !trayOpen;
      render();
    } else if (t.hasAttribute("data-pane-toggle")) {
      paneOpen = !paneOpen;
      render({ still: true });
    } else if (t.hasAttribute("data-open-run")) showToast("Opens the run in Workflows, with its steps and transcript");
    else if (d.gotoDone) {
      view = "done";
      selected = d.gotoDone === "d-1287" ? "d-1287" : "trip-" + d.gotoDone;
      render({ still: true });
    } else if (t.hasAttribute("data-sim-play")) {
      sim.playing = !sim.playing;
      renderProto();
    } else if (t.hasAttribute("data-sim-next")) nextEvent();
    else if (t.hasAttribute("data-sim-reset")) location.reload();
    else if (t.hasAttribute("data-sim-theme")) {
      root.dataset.theme = root.dataset.theme === "orient-express" ? "whitehaven" : "orient-express";
      renderProto();
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target.matches("[data-compose-input]") && compose) compose.text = e.target.value;
  });

  document.addEventListener("change", function (e) {
    if (e.target.matches("[data-sim-state]")) {
      var params = new URLSearchParams(location.search);
      if (e.target.value) params.set("state", e.target.value);
      else params.delete("state");
      params.set("theme", root.dataset.theme);
      location.search = params.toString();
    }
  });

  function insertChip(i) {
    var rec = findRecord(compose.id);
    var chip = rec.chips[i];
    var input = document.querySelector("[data-compose-input]");
    var text = input.value;
    input.value = (text && !/\s$/.test(text) ? text + "\n" : text) + chip.insert;
    compose.text = input.value;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  document.addEventListener("keydown", function (e) {
    var inField = e.target.matches("textarea, input, select, [contenteditable]");
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && compose) {
      e.preventDefault();
      sendCompose();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (compose) compose = null;
      else if (editing) editing = null;
      else if (paneOpen && selected) paneOpen = false;
      else selected = null;
      render({ still: true });
      return;
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key.toLowerCase();
    var rec = findRecord(selected);
    var run = findRun(selected);
    if (key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      // The first press opens the item and puts focus on its suggested answer; the second presses it.
      if (document.activeElement && document.activeElement.closest("[data-rt-pane] .ans, [data-rt-pane] .ad-choice")) return;
      e.preventDefault();
      if (run && run.state === "waiting" && (!rec || !isOpen(rec))) {
        paneOpen = true;
        render();
        var allow = document.querySelector("[data-rt-pane] [data-question]");
        if (allow && !isFramed()) allow.focus();
      } else if (selected) {
        paneOpen = true;
        render();
        focusSuggested();
      }
    } else if (rec && isOpen(rec) && view === "todo") {
      var byKey = { s: "signoff", b: "sendback", t: "takeover", e: "done", r: "reply" }[key];
      if (!byKey) return;
      var i = rec.answers
        .map(function (a) {
          return a.key;
        })
        .indexOf(byKey);
      if (i >= 0) {
        e.preventDefault();
        takeAnswer(rec, i);
      }
    } else if (key === "o" && (rec || run)) showToast("Opens the run in Workflows, with its steps and transcript");
  });

  // Nothing moves under the pointer: landings wait while it is on the list, then play once it leaves.
  function watchPointer() {
    var list = document.querySelector(".rt-list");
    list.addEventListener("pointerenter", function () {
      pointerOnList = true;
    });
    list.addEventListener("pointerleave", function () {
      pointerOnList = false;
      var fns = held;
      held = [];
      fns.forEach(function (fn) {
        fn();
      });
    });
  }

  /* ------------------------------------------------------------------ the prototype bar */

  var STATES = [
    ["", "Live from 09:41"],
    ["pr", "Seen, no verdict"],
    ["landed", "Landed"],
    ["inflight", "In flight"],
    ["needs-you", "Needs you"],
    ["redo", "Send back"],
    ["attempt2-needs", "Attempt 2 needs you"],
    ["attempt2-landed", "Attempt 2 landed"],
    ["failed", "Failed"],
    ["again-landed", "Tried again, landed"],
    ["done", "Done: the trip"],
    ["empty", "Empty"],
    ["swarm", "At 10x"],
  ];

  function renderProto() {
    var el = document.querySelector("[data-proto]");
    if (!el) return;
    if (!el.dataset.built) {
      el.dataset.built = "1";
      el.innerHTML =
        '<span class="rt-proto-tag">Prototype</span>' +
        '<span class="rt-proto-clock" data-sim-clock></span>' +
        '<button class="rt-proto-btn rt-proto-icon" data-sim-play></button>' +
        '<button class="rt-proto-btn" data-sim-next title="Jump to the next landing">Next event</button>' +
        '<button class="rt-proto-btn rt-proto-icon" data-sim-reset aria-label="Reset" title="Reset">' + Crew.icon("undo", 14) + "</button>" +
        '<label class="rt-proto-pick"><select data-sim-state aria-label="State">' +
        STATES.map(function (s) {
          return '<option value="' + s[0] + '"' + (s[0] === (STATE === "review" ? "" : STATE) ? " selected" : "") + ">" + s[1] + "</option>";
        }).join("") +
        "</select></label>" +
        '<button class="rt-proto-btn" data-sim-theme aria-label="Light or dark"></button>';
    }
    el.querySelector("[data-sim-clock]").textContent = formatClockSeconds(now());
    el.querySelector("[data-sim-play]").innerHTML = Crew.icon(sim.playing ? "pause" : "play", 14);
    el.querySelector("[data-sim-play]").setAttribute("aria-label", sim.playing ? "Pause" : "Play");
    el.querySelector("[data-sim-next]").disabled = !sim.queue.length;
    el.querySelector("[data-sim-theme]").innerHTML = Crew.icon(root.dataset.theme === "orient-express" ? "sun" : "moon", 14);
  }

  /* ------------------------------------------------------------------ states by URL */

  /** Moves the clock forward to t, running every event on the way, with no motion. */
  function fastForward(t) {
    sim.fast = true;
    while (sim.queue.length && sim.queue[0].at <= t) {
      sim.t = sim.queue[0].at;
      runDue();
    }
    sim.t = t;
    sim.fast = false;
  }

  /** Does a move as Rogier would, with no motion: used to reach a state named in the URL. */
  function quietly(fn) {
    sim.fast = true;
    fn();
    sim.fast = false;
  }

  function applyState() {
    if (SWARM) {
      selected = "b-review";
      findRecord("b-review").seen = true;
      return;
    }
    if (EMPTY) {
      selected = "s1298";
      return;
    }
    selected = "h1";
    findRecord("h1").seen = true;
    switch (STATE) {
      case "pr":
        selected = "h2";
        break;
      case "failed":
        selected = "h5";
        findRecord("h5").seen = true;
        break;
      case "landed":
        fastForward(14);
        selected = "h4";
        findRecord("h4").seen = true;
        break;
      case "inflight":
        selected = "h4";
        break;
      case "needs-you":
        selected = "h6";
        break;
      case "redo":
        fastForward(60);
        selected = "h3";
        findRecord("h3").seen = true;
        compose = { id: "h3", kind: "sendback", answer: 2, text: NOTE_H3 };
        break;
      case "attempt2-needs":
        fastForward(60);
        findRecord("h3").seen = true;
        quietly(function () {
          sendBackWith(findRecord("h3"), NOTE_H3);
        });
        fastForward(66);
        selected = "h3";
        break;
      case "attempt2-landed":
      case "done":
        fastForward(60);
        findRecord("h3").seen = true;
        quietly(function () {
          sendBackWith(findRecord("h3"), NOTE_H3);
        });
        fastForward(72);
        quietly(function () {
          answerQuestion("h3", 0);
        });
        fastForward(82);
        selected = "h3";
        findRecord("h3").seen = true;
        if (STATE === "done") {
          quietly(function () {
            takeAnswer(findRecord("h3"), 0);
          });
          fastForward(95);
          view = "done";
          selected = "trip-h3";
        }
        break;
      case "again-landed":
        fastForward(30);
        findRecord("h5").seen = true;
        quietly(function () {
          sendBackWith(findRecord("h5"), NOTE_H5);
        });
        fastForward(44);
        selected = "h5";
        findRecord("h5").seen = true;
        break;
    }
    toast = null;
  }

  /* ------------------------------------------------------------------ start */

  function start() {
    if (SWARM) seedSwarm();
    else seedMorning();
    applyState();
    root.dataset.intakeCount = String(countTodo());
    render({ still: true });
    watchPointer();
    setInterval(tick, 250);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
