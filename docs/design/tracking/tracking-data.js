// DRAWING - Tracking: the world the drawing shows, and the small helpers every part of it uses.
//
// The clock stands at 09:41 on Tuesday 29 September 2026. Rogier handed seven signals to agents
// this morning; each is a Task in Tracking now, one row per Task. The three scenarios of the map
// (#797) are among them:
//   1. PAY-212, assigned in Linear, handed to Implement. Its PR #1302 fails its checks, which
//      raises an ordinary GitHub signal on To do that names the Task: the row is Needs you.
//   2. A review request on #1296, handed to Review PR. The agent posted its review: Finished.
//   3. A mention about the nightly backup, handed to Investigate. The run failed: Failed.
// The Done view shows a Task with two handoffs (PAY-205), each signal with its own leg.
(function () {
  "use strict";

  /* ------------------------------------------------------------------ time */

  // Seconds since midnight. The drawing never moves its clock, so every age is the same on each load.
  var NOW = 9 * 3600 + 41 * 60;

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** Parses "09:12" into seconds since midnight. */
  function parseClock(text) {
    var p = text.split(":");
    return Number(p[0]) * 3600 + Number(p[1]) * 60;
  }

  /** Returns a time of day, given in seconds since midnight, as "09:41". */
  function formatClock(sec) {
    return pad(Math.floor(sec / 3600)) + ":" + pad(Math.floor((sec % 3600) / 60));
  }

  /** Returns how long ago a clock time was, as the list's rows show it: "now", "8m", "2h". */
  function formatAge(clock) {
    var m = Math.floor((NOW - parseClock(clock)) / 60);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h";
  }

  /** Returns how long something took between two clock times: "8m" or "1h 4m". */
  function formatSpan(from, to) {
    var m = Math.round((parseClock(to) - parseClock(from)) / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
  }

  /* ------------------------------------------------------------------ drawing helpers */

  var SOURCES = {
    github: "GitHub",
    linear: "Linear",
    slack: "Slack",
    sentry: "Sentry",
  };

  /** Returns a source system's mark, monochrome. */
  function sourceMark(src, size) {
    return window.Crew.brand(src, size || 16);
  }

  /** Returns a workflow's colleague face, still, as lists draw faces. */
  function face(name, pose, size) {
    return window.Crew.face(name, { pose: pose, size: size || 20 });
  }

  function icon(name, size) {
    return window.Crew.icon(name, size || 16);
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ------------------------------------------------------------------ the five states */

  // A Tracking row's state, worked out on read. The list sorts the rows that wait on Rogier first,
  // in this order, then the rest; `order` is that sort. `waits` is what counts toward To do.
  // `pose` is the colleague's face and `mark` the small state mark, both from the book.
  var STATES = {
    needs: { word: "Needs you", waits: true, order: 0, pose: "waiting", mark: "waiting" },
    failed: { word: "Failed", waits: true, order: 1, pose: "failed", mark: "failed" },
    finished: { word: "Finished", waits: true, order: 2, pose: "done", mark: "done" },
    working: { word: "Working", waits: false, order: 3, pose: "working", mark: "working" },
    stopped: { word: "Stopped", waits: false, order: 4, pose: "idle", mark: "paused" },
  };

  /* ------------------------------------------------------------------ To do's signals */

  // The signals on To do at 09:41, as the app's own Intake specimen has them, with one change:
  // the checks that failed on #1302 are the follow-up of PAY-212's handoff.
  var SIGNALS = [
    { id: "s-3ds", now: true, src: "sentry", title: "Checkout fails for EU cards with 3-D Secure", sub: "Sentry · alert for you · webshop-prod", at: "07:38" },
    { id: "s-1298", src: "github", title: "Move the promo banner to the CMS", sub: "Sanne · changes requested · webshop #1298", at: "06:41", back: true },
    { id: "s-1294", src: "github", title: "Retry Stripe webhooks with backoff", sub: "Marta · review requested · payments-api #1294", at: "07:18" },
    { id: "s-1300", src: "github", title: "Show VAT per line on invoices", sub: "GitHub Actions · checks failed · webshop #1300", at: "08:44" },
    { id: "s-1302", src: "github", title: "Refund partial captures", sub: "GitHub Actions · checks failed · payments-api #1302", at: "09:33", task: "t-212" },
    { id: "s-214", src: "linear", title: "Settle the refund API shape", sub: "Jonas · question for you · PAY-214", at: "09:01" },
    { id: "s-trail", src: "slack", title: "Codes with a trailing space are rejected", sub: "Pieter · tagged in a thread · #acceptance", at: "09:29" },
  ];

  /* ------------------------------------------------------------------ Tracking's Tasks */

  // One Task per row. The row's second line is the state's word, the workflow, then `line` when
  // there is more to say. A Working Task with `checks` reads "Waiting for checks" instead.
  // `asked` is the signal of the Task's first handoff, which the pane shows
  // under You asked. `runs` are in order; a run with `again` is a re-run of the one before it.
  // `since` is when the row entered its state: the row's time and the pane's meta read it.
  var TASKS = [
    {
      id: "t-212",
      src: "linear",
      title: "Refunds for partial captures",
      state: "needs",
      since: "09:33",
      wf: "Implement",
      line: "checks failed on #1302",
      waitsOn: { type: "signal", signalId: "s-1302", text: "Checks failed on #1302", where: "GitHub · payments-api", at: "09:33" },
      asked: { src: "linear", who: "Jonas", kind: "Assigned", where: "PAY-212", at: "08:24", text: "Stripe lets us refund part of a captured payment. Support needs it for damaged items: refund one line, keep the order. The API shape is in PAY-214; build against it." },
      handedAt: "08:31",
      runs: [{ wf: "Implement", state: "finished", start: "08:31", end: "08:52" }],
      did: [
        "Added `createRefund(orderId, lines)` with a partial amount per line, and a migration for `refund_lines`. Stripe gets one refund per call, with an idempotency key per order and line.",
        "Opened draft PR #1302. The unit tests pass here; I did not run the Stripe test-mode suite, which needs the team's key.",
      ],
      linked: [{ number: 1302, title: "Refund partial captures", where: "payments-api", state: "Draft", plus: 214, minus: 18, checks: "2 checks failed" }],
    },
    {
      id: "t-sdk",
      src: "github",
      title: "Upgrade the Stripe SDK to v14",
      state: "needs",
      since: "09:38",
      wf: "Implement",
      line: "asks to run <code>git push</code>",
      waitsOn: { type: "request", text: "Run git push -u origin chore/stripe-sdk-14?", code: "git push -u origin chore/stripe-sdk-14", at: "09:38" },
      asked: { src: "github", who: "Dependabot", kind: "Assigned", where: "payments-api #1287", at: "09:15", text: "stripe 13.11.0 → 14.2.0. Breaking: `PaymentIntent.charges` is removed; read `latest_charge` instead." },
      handedAt: "09:22",
      runs: [{ wf: "Implement", state: "working", start: "09:22" }],
      did: ["Replaced the 9 reads of `charges` with `latest_charge` and updated the fixtures. All 212 tests pass. Pushing the branch to open the PR."],
    },
    {
      id: "t-backup",
      src: "github",
      title: "Nightly backup job timing out on ops-db",
      state: "failed",
      since: "09:26",
      wf: "Investigate",
      line: "permission denied on ops-db",
      failure: "The run stopped at step 2 of 3, Read the slow query log: permission denied for the role `hercule_ro` on `pg_stat_statements`.",
      asked: { src: "github", who: "Noor", kind: "Mentioned", where: "ops #88", at: "09:04", text: "@rogier the backup has timed out three nights running, always on `events`. Can someone look before tonight's run?" },
      handedAt: "09:20",
      runs: [{ wf: "Investigate", state: "failed", start: "09:20", end: "09:26", reason: "Permission denied on ops-db" }],
      did: ["`pg_dump` of `events` (41 GB) took 1h 52m last night, past the job's 90-minute limit. I could not read the slow query log to see what held it up: the role `hercule_ro` may not read `pg_stat_statements`."],
    },
    {
      id: "t-1296",
      src: "github",
      title: "Rate-limit the public API",
      state: "finished",
      since: "09:20",
      wf: "Review PR",
      line: "",
      asked: { src: "github", who: "Marta", kind: "Review requested", where: "payments-api #1296", at: "09:05", text: "A token bucket per API key, 600 requests a minute, in Redis. Over the limit answers 429 with `Retry-After`." },
      handedAt: "09:12",
      runs: [{ wf: "Review PR", state: "finished", start: "09:12", end: "09:20" }],
      did: [
        "Approved #1296, with 2 comments:",
        "- `src/limits/bucket.ts:42`: the refill reads the clock twice, so a burst at the edge of a second can take 601 tokens. Read it once.",
        "- `src/limits/bucket.test.ts`: no test covers `Retry-After`. Read all 6 files and ran the tests: 31 passed.",
      ],
    },
    {
      id: "t-checkout",
      src: "github",
      title: "Split checkout into steps",
      state: "working",
      checks: true,
      since: "09:30",
      wf: "Implement",
      line: "#1311",
      asked: { src: "github", who: "Sanne", kind: "Assigned", where: "webshop #1305", at: "08:50", text: "Address, delivery and payment as three steps, each with its own URL, so the back button works." },
      handedAt: "08:58",
      runs: [{ wf: "Implement", state: "working", start: "08:58" }],
      did: ["Opened #1311 with the three steps and their routes. Waiting for its checks before I mark it ready."],
    },
    {
      id: "t-sku",
      src: "linear",
      title: "Lowercase SKUs in search",
      state: "working",
      since: "09:35",
      wf: "Fix bug",
      line: "",
      asked: { src: "linear", who: "Pieter", kind: "Assigned", where: "PAY-209", at: "09:30", text: "Searching `ab-120` finds nothing; `AB-120` finds the product." },
      handedAt: "09:35",
      runs: [{ wf: "Fix bug", state: "working", start: "09:35" }],
      did: ["Wrote a failing test for a lowercase SKU. Looking at the search index's analyzer."],
    },
    {
      id: "t-pdf",
      src: "linear",
      title: "Move invoices to the new PDF renderer",
      state: "stopped",
      since: "08:47",
      wf: "Implement",
      line: "",
      asked: { src: "linear", who: "Marta", kind: "Assigned", where: "PAY-198", at: "08:36", text: "Render invoices with the new renderer and drop wkhtmltopdf." },
      handedAt: "08:40",
      runs: [{ wf: "Implement", state: "stopped", start: "08:40", end: "08:47" }],
      did: ["Swapped the renderer in `invoices/pdf.ts`. Two invoice snapshots differ in the footer's line height."],
    },
  ];

  /* ------------------------------------------------------------------ the Done view */

  // Signals resolved today, newest first. A handed-off signal's `trip` is its own leg, as the
  // Done row and its pane show it. PAY-205 had two handoffs, so two signals show two legs.
  var DONE = [
    { id: "d-sku", src: "linear", title: "Lowercase SKUs in search", at: "09:35", trip: ["Handed to Fix bug", "working"], task: "t-sku" },
    { id: "d-sdk", src: "github", title: "Upgrade the Stripe SDK to v14", at: "09:22", trip: ["Handed to Implement", "needs you"], task: "t-sdk" },
    { id: "d-backup", src: "github", title: "Nightly backup job timing out on ops-db", at: "09:20", trip: ["Handed to Investigate", "failed"], task: "t-backup" },
    { id: "d-1296", src: "github", title: "Rate-limit the public API", at: "09:12", trip: ["Handed to Review PR", "finished"], task: "t-1296" },
    { id: "d-checkout", src: "github", title: "Split checkout into steps", at: "08:58", trip: ["Handed to Implement", "waiting for checks"], task: "t-checkout" },
    {
      id: "d-205b",
      src: "github",
      title: "Discount codes ignore letter case",
      sub: "GitHub Actions · checks failed · webshop #1291",
      at: "08:44",
      trip: ["Handed to Fix bug", "tried again once", "done"],
      leg: [
        { at: "08:44", who: "you", text: "Handed to <b>Fix bug</b>" },
        { at: "08:51", who: "Fix bug", pose: "failed", text: "Failed: may not edit <code>.github/workflows/test.yml</code>" },
        { at: "08:53", who: "you", text: "Tried again" },
        { at: "09:02", who: "Fix bug", pose: "done", text: "Finished: pushed a fix to #1291, checks pass" },
        { at: "09:10", who: "you", text: "Marked it done" },
      ],
    },
    { id: "d-pdf", src: "linear", title: "Move invoices to the new PDF renderer", at: "08:40", trip: ["Handed to Implement", "stopped"], task: "t-pdf" },
    { id: "d-212", src: "linear", title: "Refunds for partial captures", at: "08:31", trip: ["Handed to Implement", "finished", "needs you"], task: "t-212" },
    {
      id: "d-205a",
      src: "linear",
      title: "Discount codes ignore letter case",
      sub: "Pieter · assigned · PAY-205",
      at: "07:58",
      trip: ["Handed to Implement", "finished", "continued: Fix bug"],
      leg: [
        { at: "07:58", who: "you", text: "Handed to <b>Implement</b>" },
        { at: "08:20", who: "Implement", pose: "done", text: "Finished: opened #1291" },
        { at: "08:44", who: "you", text: "Handed the failed checks on #1291 to <b>Fix bug</b>" },
      ],
    },
    { id: "d-deps", src: "github", title: "Merge 4 dependency bumps", at: "07:41", outcome: "Done, nothing sent" },
  ];

  window.Tracking = {
    NOW: NOW,
    STATES: STATES,
    SOURCES: SOURCES,
    SIGNALS: SIGNALS,
    TASKS: TASKS,
    DONE: DONE,
    parseClock: parseClock,
    formatClock: formatClock,
    formatAge: formatAge,
    formatSpan: formatSpan,
    sourceMark: sourceMark,
    face: face,
    icon: icon,
    escapeHtml: escapeHtml,
  };
})();
