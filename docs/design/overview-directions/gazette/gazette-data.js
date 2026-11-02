// PROTOTYPE - what Gazette reads on top of the shared morning (world.js + world-plus.js).
//
// Load it after ../shared/world-plus.js. It never changes a fact the world states; it adds what
// only this direction needs:
//   - the edition's words: a story headline and a kicker per piece of work, written by the
//     edition's Text Generation over the per-turn headlines (WORLD.headlines), and its ranking;
//   - the answers a Request offers, for the one-move answer buttons;
//   - the run step that waits on Rogier, as a story;
//   - the three stories that arrive during the live demo (their times sit inside WORLD.eta);
//   - yesterday evening's edition (18:20), drawn only from WORLD.done and CONTENT.md;
//   - the catch-up states' progress.
// Every number below agrees with the world; where a sentence cites one, the comment says where.
(function () {
  "use strict";

  var W = window.WORLD;
  if (!W || !W.headlines) throw new Error("gazette-data.js: load world.js and world-plus.js first");

  /* ------------------------------------------------------------------ the edition's words */

  // story[leadId]: the edition's headline for a piece of work (a lead and its partners), its
  // kicker, and its weight. The weight ranks stories that do not wait on Rogier for Catch up and
  // the Front Page: a finding that blocks work outranks an outcome, which outranks news for later.
  var STORY = {
    t3ds: { kicker: "The hotfix", head: "3-D Secure fix is ready, and waits on your push", weight: 100 },
    tCart: { kicker: "Cart", head: "Cart refactor turns up a rounding bug", weight: 70 },
    tCss: { kicker: "Housekeeping", head: "Unused checkout CSS removed; PR #1281 is green", weight: 30 },
    tA11y: { kicker: "Accessibility", head: "Screen-reader audit finds 6 issues, 2 on the card form", weight: 50 },
    tPayout: { kicker: "Reports", head: "September payout report waits on a refunds rule", weight: 60 },
    tResult: { kicker: "Result types", head: "Result migration held up by one blocking finding", weight: 80 },
    tIdeal: { kicker: "Research", head: "iDEAL: the Payment Element needs the least code", weight: 25 },
    tDash: { kicker: "Grafana 11", head: "Dashboards moved; two alerts point at nothing", weight: 65 },
    tSecrets: { kicker: "Staging", head: "9 of 14 staging secrets rotated", weight: 35 },
    tBun: { kicker: "Toolchain", head: "Bun 1.4 changes 3 things in the webshop build", weight: 15 },
    aRust: { kicker: "From Ada", head: "Rust's async closures change touches your code", weight: 20 },
    aTables: { kicker: "From Milo", head: "ops-db's events table is 41 GB, and growing", weight: 40 },
    rShip: { kicker: "Releases", head: "Release v2.15 is built, and waits to publish", weight: 90 },
    // The swarm.
    sImg: { kicker: "Performance", head: "AVIF cuts the product page from 2.1 MB to 780 KB", weight: 45 },
    sApple: { kicker: "Apple Pay", head: "Apple Pay tests wait on a test card", weight: 55 },
    sCoupon: { kicker: "Coupons", head: "Double discount on sale items reproduced", weight: 40 },
    sDe: { kicker: "German", head: "German checkout waits on its tone check", weight: 20 },
    sSig: { kicker: "Webhooks", head: "Signing secret rotation waits on a migration", weight: 55 },
    sRefunds: { kicker: "Refunds", head: "August refunds: 3 reversals worth €212 do not match", weight: 30 },
    sRate: { kicker: "Rate limits", head: "Payouts rate limiter waits for a load-test slot", weight: 35 },
    sPg: { kicker: "Postgres 18", head: "Postgres 18 upgrade stuck on pg_partman", weight: 75 },
    sBackups: { kicker: "Backups", head: "Backups move to the new bucket", weight: 30 },
    sDisk: { kicker: "build-box-1", head: "Docker images fill build-box-1's disk", weight: 60 },
    sTalk: { kicker: "Talks", head: "A talk outline: agents as a crew, not a queue", weight: 10 },
  };

  // The message that matters, quoted in a story, where it is not simply the newest report or
  // headline: the 3-D Secure lead's own finding (world.js's transcript, 09:04).
  var QUOTE = {
    t3ds: {
      by: "t3ds", at: "09:04",
      text: "Found it. Since Stripe SDK v14, confirmPayment returns status: 'requires_action' for cards that need 3-D Secure. handlePaymentResult only handles succeeded and treats everything else as a failure, so we show “Card declined” instead of opening the 3-D Secure modal.",
    },
  };

  /* ------------------------------------------------------------------ answers */

  // answers[threadId]: the answers a Request offers, in order. `accent` marks the one suggested
  // answer (the only filled button); `danger` an answer that destroys. `done` is the toast's verb.
  // Approvals take the app's three; a question takes the options its agent offered with it.
  var APPROVE = [
    { label: "Allow once", accent: true, done: "Allowed once" },
    { label: "Allow always", done: "Allowed always" },
    { label: "Deny", quiet: true, done: "Denied" },
  ];
  var ANSWERS = {
    t3ds: APPROVE,
    rShip: [
      { label: "Allow once", accent: true, done: "Allowed the publish" },
      { label: "Deny", quiet: true, done: "Denied the publish" },
    ],
    tDash: [
      { label: "Keep it", accent: true, done: "Answered “Keep it”" },
      { label: "Delete it", danger: true, done: "Answered “Delete it”" },
    ],
    tPayoutCheck: [
      { label: "Settlement date", done: "Answered “Settlement date”" },
      { label: "Payout date", done: "Answered “Payout date”" },
    ],
    sAppleE2e: [
      { label: "Use the test card", accent: true, done: "Answered “Use the test card”" },
      { label: "No", quiet: true, done: "Answered “No”" },
    ],
    sSigReview: APPROVE,
    sPgRollback: [
      { label: "Keep it a week", accent: true, done: "Answered “Keep it a week”" },
      { label: "No", quiet: true, done: "Answered “No”" },
    ],
    sDisk: [
      { label: "Allow once", accent: true, done: "Allowed once" },
      { label: "Deny", quiet: true, done: "Denied" },
    ],
  };

  /* ------------------------------------------------------------------ the run step that waits */

  // world.js lists it in WAITING_RUNS; world-plus.js has its session (rShip) and its run (runShip).
  // Gazette shows it as a story of its own, under "From runs" in Needs you, as the app does.
  var RUN_STEP = {
    id: "rShip", title: "Ship release v2.15 · publish", run: "runShip", project: "payments-api",
    provider: "claude", model: "Sonnet 5", workspace: "none", machine: "build-box-2",
    pose: "waiting", status: "approval", ask: "Publish payments-api 2.15.0 to npm?", askShort: "Publish to npm?",
    started: "09:12", last: "09:33", lead: null, isRunStep: true,
    result: "The changelog is written and the build passes. Waiting to publish to npm.",
  };
  var RUN_HEADLINES = {
    rShip: [{ at: "09:33", text: "Changelog written; build and tests pass. Asks to publish payments-api 2.15.0 to npm.", end: "request" }],
  };

  // Transcripts for the two threads assistants started, so opening one shows the assistant's
  // brief, not a message Rogier never wrote. The Stage draws `fromTask` as the provenance line.
  var TRANSCRIPTS = {
    aRust: [
      { worked: "Worked for 11m 02s", tools: ["fetched 2 pages", "read 4 files"] },
      { agent: true, at: "yesterday 21:41", html: "Five items in this week's Rust newsletter. The <code>async</code> closures change is the one that touches your code." },
    ],
    aTables: [
      { worked: "Worked for 3m 10s", tools: ["ran 2 queries on ops-db"] },
      { agent: true, at: "09:34", html: "<code>events</code> is 41 GB on ops-db and grows about 600 MB a night. It is the table the nightly backup spends most of its time on." },
    ],
  };
  var PROVENANCE = { aRust: "Ada · Rust and Postgres newsletters", aTables: "Milo · Slack #ops, the nightly backup check" };

  /* ------------------------------------------------------------------ the demo's arrivals */

  // Three turns end while the live window is open (everyday state), each inside its ETA range
  // (WORLD.eta): tCartTests [1, 4] -> 09:42, t3dsReview [4, 9] -> 09:46, tSecrets [9, 14] -> 09:51.
  // They arrive as the "3 new" pill when the pointer is in the list.
  var ARRIVALS = [
    { id: "tCartTests", at: "09:42", text: "Shrank the failing case to one: two stacked 15% discounts on €9.99 round differently at the third decimal." },
    { id: "t3dsReview", at: "09:46", text: "Review done: 1 finding. A processing status still shows “Card declined”; the other 5 statuses are handled." },
    { id: "tSecrets", at: "09:51", text: "All 14 staging secrets rotated. Next: check that every service reads them." },
  ];

  /* ------------------------------------------------------------------ yesterday evening's edition */

  // Printed at 18:20 on Monday 28 September, when Rogier last checked (CONTENT.md: "since
  // yesterday 18:20"). It reads only the threads WORLD.done marks Done yesterday, and the schedule.
  // Deploy #1289 shipped the SDK bump at 14:02 (CONTENT.md, the lead Proposal).
  var EVENING = {
    date: "Monday 28 September 2026",
    time: "18:20",
    lead: {
      id: "dStripe14", kicker: "Webshop · Payments",
      head: "Stripe SDK v14 is live in checkout",
      deck: "Bump Stripe SDK to v14 was marked Done at 17:40, after a review by Codex. Deploy #1289 took it to production at 14:02.",
      by: "Claude Code · Opus 5.5", with: "review by Codex · gpt-5.4",
    },
    brief: [
      { id: "dFlaky", at: "16:10", text: "Fix flaky cart e2e test: done, with a partner that found why it flakes on CI." },
      { id: "dLedger", at: "11:02", text: "The August ledger is exported." },
      { id: "dGrafana", at: "Sun 20:15", text: "The Grafana 11 move is planned (Sunday)." },
    ],
    doneCount: 5, // dStripe14, dStripe14Review, dFlaky, dFlakyWhy, dLedger
    tomorrow: [
      { at: "04:30", text: "Nightly backup check" },
      { at: "09:00", text: "Triage reads what came in overnight" },
      { at: "11:00", text: "Triage again" },
    ],
  };

  /* ------------------------------------------------------------------ catch-up states */

  // ?state=catchup stops at story 4 of 9, after Rogier answered the first three; ?state=caughtup
  // shows the end card. Times are what a reader takes, not a fact of the world.
  var CATCHUP = {
    step: 3, // zero-based: the fourth story
    elapsed: 72, // seconds
    answered: [
      { thread: "t3ds", answer: 0 },
      { thread: "rShip", answer: 0 },
      { thread: "tDash", answer: 0 },
    ],
    end: { elapsed: 185, answered: 4, done: 2, snoozed: 1, read: 2 },
  };

  window.GAZETTE = {
    story: STORY,
    quote: QUOTE,
    answers: ANSWERS,
    runStep: RUN_STEP,
    runHeadlines: RUN_HEADLINES,
    transcripts: TRANSCRIPTS,
    provenance: PROVENANCE,
    arrivals: ARRIVALS,
    evening: EVENING,
    catchup: CATCHUP,
  };
})();
