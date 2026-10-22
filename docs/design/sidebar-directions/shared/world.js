// PROTOTYPE - the one world every sidebar direction draws, so Rogier compares designs, not content.
//
// It extends the book's world (../../shared/CONTENT.md: Tuesday 29 September 2026, 09:41,
// projects webshop, payments-api and ops, machines studio-mac, build-box-1 and build-box-2) with
// the pattern this exploration is about: a lead thread that starts partner threads to work with
// it, usually in its own workspace.
//
// Vocabulary used below (see ../BRIEF.md):
//   lead      a thread the user started on its own. Every thread with no `lead` is one.
//   partner   a thread that works with a lead: started by the lead (`joined: "spawned"`), or
//             started by the user with the header's + in the lead's workspace (`joined: "added"`).
//   role      a one- or two-word name for what a partner does for its lead ("review"), written
//             by a Text Generation from the brief the lead gave it, the way a title is.
//   exchange  a message one thread sent another (an input whose actor is `session:<id>`).
//
// Times are "HH:MM" on the morning of 29 September; "yesterday HH:MM" and "Sun HH:MM" are older.
(function () {
  "use strict";

  var NOW = "09:41";

  var PROJECTS = [
    { id: "webshop", name: "webshop", tint: "webshop" },
    { id: "payments-api", name: "payments-api", tint: "payments" },
    { id: "ops", name: "ops", tint: "ops" },
  ];

  var PROVIDERS = {
    claude: { name: "Claude Code", brand: "claude" },
    codex: { name: "Codex", brand: "openai" },
    pi: { name: "pi", brand: "pi" },
  };

  // Workspaces. A worktree's branch is one a person named, so rows may show it. A main workspace
  // is shown as "<repo> · <machine>". A scratch workspace has no checkout.
  var WORKSPACES = {
    "ws-3ds": { kind: "worktree", repo: "webshop", branch: "fix/3ds-eu-cards", from: "main", machine: "studio-mac" },
    "ws-cart": { kind: "worktree", repo: "webshop", branch: "refactor/cart-totals", from: "main", machine: "build-box-1" },
    "ws-webshop-bb1": { kind: "main", repo: "webshop", branch: "main", machine: "build-box-1" },
    "ws-payout": { kind: "worktree", repo: "payments-api", branch: "report/payouts-september", from: "main", machine: "build-box-1" },
    "ws-scratch-bb2": { kind: "scratch", repo: null, branch: null, machine: "build-box-2" },
    "ws-result": { kind: "worktree", repo: "payments-api", branch: "rogier/result-types", from: "main", machine: "studio-mac" },
    "ws-payments-bb2": { kind: "main", repo: "payments-api", branch: "main", machine: "build-box-2" },
    "ws-dash": { kind: "worktree", repo: "ops", branch: "ops/grafana-v11", from: "main", machine: "studio-mac" },
    "ws-secrets": { kind: "worktree", repo: "ops", branch: "ops/rotate-staging", from: "main", machine: "build-box-1" },
    none: { kind: "none", repo: null, branch: null, machine: "studio-mac" },
  };

  /*
   * The threads, in no particular order. Fields:
   *   pose      working | waiting | idle | asleep | away (spec 17's poses)
   *   status    the row's status slot: "working", "approval", "question", "queued", or null (age)
   *   ask       a waiting thread's Request as one question; `askShort` is the Waiting row's line
   *   started   when the thread was started; `last` its last activity
   *   lead      the lead's id for a partner, null for a lead or a lone thread
   *   joined    how a partner joined: "spawned" by its lead, or "added" by Rogier with the +
   *   role      a partner's role
   *   result    a one-line summary of where the thread stands, for cards and tooltips
   */
  var THREADS = [
    // ---------------------------------------------------------------- webshop
    {
      id: "t3ds", title: "Fix 3-D Secure checkout for EU cards", project: "webshop",
      provider: "claude", model: "Opus 5.5", workspace: "ws-3ds",
      pose: "waiting", status: "approval", ask: "Run git push -u origin fix/3ds-eu-cards?", askShort: "Run git push?",
      started: "09:02", last: "09:31", lead: null,
      fromTask: "Checkout fails for EU cards with 3-D Secure",
      result: "Fix and test written, 24 tests pass. Wants to push the branch.",
    },
    {
      id: "tStripe", title: "Read the Stripe v14 changelog", project: "webshop",
      provider: "claude", model: "Sonnet 5", workspace: "ws-3ds",
      pose: "idle", status: null, started: "09:05", last: "09:21",
      lead: "t3ds", joined: "added", role: "research",
      result: "Listed the 4 changes in v14 that touch checkout.",
    },
    {
      id: "t3dsReview", title: "Adversarial review of the 3-D Secure fix", project: "webshop",
      provider: "codex", model: "gpt-5.4", workspace: "ws-3ds",
      pose: "working", status: "working", started: "09:30", last: "09:41",
      lead: "t3ds", joined: "spawned", role: "review",
      result: "1 finding so far: a processing status still shows “Card declined”.",
    },
    {
      id: "tCart", title: "Refactor cart totals", project: "webshop",
      provider: "claude", model: "Sonnet 5", workspace: "ws-cart",
      pose: "working", status: "working", started: "09:19", last: "09:41", lead: null,
      result: "Moving discount maths into computeTotals.",
    },
    {
      id: "tCartTests", title: "Write property tests for cart totals", project: "webshop",
      provider: "codex", model: "gpt-5.4-mini", workspace: "ws-cart",
      pose: "working", status: "working", started: "09:24", last: "09:40",
      lead: "tCart", joined: "spawned", role: "tests",
      result: "1 failing property: rounding differs at 3 decimals on stacked discounts.",
    },
    {
      id: "tCss", title: "Tidy checkout CSS", project: "webshop",
      provider: "claude", model: "Haiku 4.5", workspace: "ws-webshop-bb1",
      pose: "idle", status: null, started: "07:12", last: "07:40", lead: null,
      result: "Removed 212 unused rules.",
    },
    {
      // Shares the webshop main workspace on build-box-1 with "Tidy checkout CSS", and has nothing to
      // do with it: a shared workspace is not a shared piece of work.
      id: "tA11y", title: "Audit checkout for screen readers", project: "webshop",
      provider: "claude", model: "Sonnet 5", workspace: "ws-webshop-bb1",
      pose: "idle", status: null, started: "08:40", last: "08:56", lead: null,
      result: "6 issues, 2 of them on the card form.",
    },

    // ---------------------------------------------------------------- payments-api
    {
      id: "tPayout", title: "Payout report for September", project: "payments-api",
      provider: "codex", model: "gpt-5.4", workspace: "ws-payout",
      pose: "working", status: "working", started: "09:32", last: "09:41", lead: null,
      result: "Building the report from 1,284 payouts.",
    },
    {
      // A partner on another machine, in a scratch workspace: the lead's lineage holds it, not the workspace.
      id: "tPayoutCheck", title: "Check payout totals against Stripe", project: "payments-api",
      provider: "claude", model: "Sonnet 5", workspace: "ws-scratch-bb2",
      pose: "waiting", status: "question", ask: "Count refunds by settlement date or by payout date?", askShort: "Settlement or payout date?",
      started: "09:35", last: "09:39", lead: "tPayout", joined: "spawned", role: "check",
      result: "Waiting on how to count refunds.",
    },
    {
      id: "tResult", title: "Migrate payout endpoints to Result types", project: "payments-api",
      provider: "claude", model: "Opus 5.5", workspace: "ws-result",
      pose: "working", status: "working", started: "08:48", last: "09:41", lead: null,
      result: "Fixing the blocking finding on GET /v1/payouts/:id.",
    },
    {
      id: "tResultReview", title: "Adversarial review of the Result type migration", project: "payments-api",
      provider: "codex", model: "gpt-5.4", workspace: "ws-result",
      pose: "idle", status: null, started: "09:10", last: "09:34",
      lead: "tResult", joined: "spawned", role: "review",
      result: "3 findings, 1 blocking.",
    },
    {
      id: "tIdeal", title: "Add iDEAL research", project: "payments-api",
      provider: "codex", model: "gpt-5.4", workspace: "ws-payments-bb2",
      pose: "idle", status: null, started: "08:30", last: "08:41", lead: null,
      result: "Compared 3 ways to offer iDEAL through Stripe.",
    },

    // ---------------------------------------------------------------- ops
    {
      id: "tDash", title: "Migrate ops dashboards", project: "ops",
      provider: "pi", model: "qwen3-coder 30b", workspace: "ws-dash",
      pose: "waiting", status: "question", ask: "Keep the old Grafana folder?", askShort: "Keep the old Grafana folder?",
      started: "08:58", last: "09:36", lead: null,
      result: "14 dashboards moved to Grafana 11.",
    },
    {
      id: "tDashAlerts", title: "Check every alert still fires after the move", project: "ops",
      provider: "claude", model: "Haiku 4.5", workspace: "ws-dash",
      pose: "idle", status: null, started: "09:14", last: "09:29",
      lead: "tDash", joined: "spawned", role: "alerts",
      result: "All 31 alert rules fire. 2 point at removed panels.",
    },
    {
      id: "tSecrets", title: "Rotate staging secrets", project: "ops",
      provider: "claude", model: "Sonnet 5", workspace: "ws-secrets",
      pose: "working", status: "working", started: "09:30", last: "09:41", lead: null,
      result: "Rotated 9 of 14 secrets.",
    },

    // ---------------------------------------------------------------- no project
    {
      id: "tBun", title: "What changed in Bun 1.4?", project: null,
      provider: "claude", model: "Haiku 4.5", workspace: "none",
      pose: "idle", status: null, started: "06:50", last: "06:58", lead: null,
      result: "Summarised the release notes.",
    },
  ];

  // What a lead's piece of work has produced, read from its workspace. Changes are what the
  // workspace's checkout differs from its base by; a PR exists once someone opened one.
  var OUTPUT = {
    t3ds: { plus: 48, minus: 12, files: 3, pr: null, checks: null },
    tCart: { plus: 210, minus: 164, files: 9, pr: null, checks: null },
    tPayout: { plus: 320, minus: 0, files: 2, pr: null, checks: null },
    tResult: { plus: 412, minus: 388, files: 23, pr: { number: 1287, state: "draft" }, checks: "passing" },
    tDash: { plus: 96, minus: 140, files: 14, pr: null, checks: null },
    tSecrets: { plus: 18, minus: 18, files: 1, pr: null, checks: null },
    tCss: { plus: 0, minus: 212, files: 4, pr: { number: 1281, state: "open" }, checks: "passing" },
    tA11y: { plus: 0, minus: 0, files: 0, pr: null, checks: null },
    tIdeal: { plus: 0, minus: 0, files: 0, pr: null, checks: null },
    tBun: null,
  };

  // Messages between threads, oldest first. `kind` is "brief" (a lead starting or steering a
  // partner) or "report" (a partner answering its lead).
  var EXCHANGES = [
    { at: "09:21", from: "tStripe", to: "t3ds", kind: "report", text: "v14 returns requires_action for cards that need 3-D Secure. handlePaymentResult has to open the modal for it." },
    { at: "09:24", from: "tCart", to: "tCartTests", kind: "brief", text: "Write property tests for computeTotals: totals never go negative, and discounts never exceed the subtotal." },
    { at: "09:30", from: "t3ds", to: "t3dsReview", kind: "brief", text: "Try to break the 3-D Secure fix on fix/3ds-eu-cards. Start with handlePaymentResult and every status Stripe v14 can return." },
    { at: "09:10", from: "tResult", to: "tResultReview", kind: "brief", text: "Review the Result type migration adversarially. Look for errors that escape a Result." },
    { at: "09:31", from: "tResultReview", to: "tResult", kind: "report", text: "3 findings, 1 blocking: PayoutError escapes through GET /v1/payouts/:id." },
    { at: "09:14", from: "tDash", to: "tDashAlerts", kind: "brief", text: "List every alert rule on the old dashboards and check that each one still fires after the move." },
    { at: "09:29", from: "tDashAlerts", to: "tDash", kind: "report", text: "All 31 alert rules fire. 2 of them point at panels that no longer exist." },
    { at: "09:35", from: "tPayout", to: "tPayoutCheck", kind: "brief", text: "Check the September payout totals against Stripe’s balance transactions." },
    { at: "09:38", from: "t3dsReview", to: "t3ds", kind: "report", text: "First finding: a processing status still shows “Card declined”. Still looking." },
    { at: "09:40", from: "tCartTests", to: "tCart", kind: "report", text: "1 failing property: rounding differs at 3 decimals on stacked discounts." },
  ].sort(function (a, b) {
    return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
  });

  // Threads marked Done, newest first. 23 in all; these are the ones the shelf shows first.
  var DONE = [
    { id: "dCert", title: "Renew the status page TLS certificate", project: "ops", provider: "claude", model: "Sonnet 5", doneAt: "08:55", lead: null },
    { id: "dStripe14", title: "Bump Stripe SDK to v14", project: "webshop", provider: "claude", model: "Opus 5.5", doneAt: "yesterday 17:40", lead: null },
    { id: "dStripe14Review", title: "Review the Stripe v14 bump", project: "webshop", provider: "codex", model: "gpt-5.4", doneAt: "yesterday 17:40", lead: "dStripe14", role: "review" },
    { id: "dFlaky", title: "Fix flaky cart e2e test", project: "webshop", provider: "claude", model: "Sonnet 5", doneAt: "yesterday 16:10", lead: null },
    { id: "dFlakyWhy", title: "Find why the cart e2e test flakes on CI", project: "webshop", provider: "codex", model: "gpt-5.4", doneAt: "yesterday 16:10", lead: "dFlaky", role: "diagnosis" },
    { id: "dLedger", title: "Export the August ledger", project: "payments-api", provider: "codex", model: "gpt-5.4", doneAt: "yesterday 11:02", lead: null },
    { id: "dGrafana", title: "Plan the Grafana 11 move", project: "ops", provider: "pi", model: "qwen3-coder 30b", doneAt: "Sun 20:15", lead: null },
  ];
  var DONE_COUNT = 23;

  // The run's step waiting on Rogier, listed under "From runs" in Waiting on you.
  var WAITING_RUNS = [{ id: "rShip", title: "Ship release v2.15 · publish", ask: "Publish to npm?", project: "payments-api", started: "09:12", last: "09:33" }];

  var ASSISTANTS = [
    { name: "Ada", pose: "working" },
    { name: "Milo", pose: "idle" },
    { name: "Juno", pose: "asleep" },
  ];

  // The spawn state: "Rotate staging secrets" is a lone thread until 09:41, when it starts a
  // partner. Each direction draws the moment this partner joins.
  var SPAWN = {
    lead: "tSecrets",
    thread: {
      id: "tSecretsVerify", title: "Verify every staging service picks up the new secrets", project: "ops",
      provider: "codex", model: "gpt-5.4-mini", workspace: "ws-secrets",
      pose: "working", status: "working", started: "09:41", last: "09:41",
      lead: "tSecrets", joined: "spawned", role: "verify",
      result: "Just started.",
    },
    exchange: { at: "09:41", from: "tSecrets", to: "tSecretsVerify", kind: "brief", text: "Restart each staging service one at a time and check it reads the new secrets. Stop at the first failure." },
  };

  // The swarm state adds these to the world: a heavy week, 16 pieces of work in view and more
  // behind each project's "more" row. `more` is how many threads each project hides on top.
  var SWARM = {
    more: { webshop: 31, "payments-api": 22, ops: 14 },
    threads: [
      { id: "sImg", title: "Speed up product image loading", project: "webshop", provider: "claude", model: "Sonnet 5", workspace: "ws-x1", branch: "perf/product-images", machine: "build-box-2", pose: "working", status: "working", started: "09:08", last: "09:41", lead: null },
      { id: "sImgLcp", title: "Measure LCP before and after the image change", project: "webshop", provider: "codex", model: "gpt-5.4-mini", workspace: "ws-x1", machine: "build-box-2", pose: "idle", status: null, started: "09:12", last: "09:26", lead: "sImg", joined: "spawned", role: "measure" },
      { id: "sApple", title: "Add Apple Pay to checkout", project: "webshop", provider: "claude", model: "Opus 5.5", workspace: "ws-x2", branch: "feat/apple-pay", machine: "studio-mac", pose: "working", status: "working", started: "08:20", last: "09:40", lead: null },
      { id: "sAppleReview", title: "Review the Apple Pay domain setup", project: "webshop", provider: "codex", model: "gpt-5.4", workspace: "ws-x2", machine: "studio-mac", pose: "idle", status: null, started: "08:51", last: "09:15", lead: "sApple", joined: "spawned", role: "review" },
      { id: "sAppleE2e", title: "Write Apple Pay end-to-end tests", project: "webshop", provider: "claude", model: "Sonnet 5", workspace: "ws-x2", machine: "studio-mac", pose: "waiting", status: "question", ask: "Use Stripe’s test card for Apple Pay?", askShort: "Use Stripe’s test card?", started: "09:02", last: "09:37", lead: "sApple", joined: "spawned", role: "tests" },
      { id: "sCoupon", title: "Fix coupon stacking on sale items", project: "webshop", provider: "claude", model: "Sonnet 5", workspace: "ws-x3", branch: "fix/coupon-stacking", machine: "build-box-1", pose: "working", status: "working", started: "09:33", last: "09:41", lead: null },
      { id: "sDe", title: "Translate checkout into German", project: "webshop", provider: "claude", model: "Sonnet 5", workspace: "ws-x4", branch: "i18n/de-checkout", machine: "build-box-2", pose: "idle", status: null, started: "Mon 16:02", last: "Mon 17:30", lead: null },
      { id: "sDeTone", title: "Check the German copy for tone", project: "webshop", provider: "pi", model: "qwen3-coder 30b", workspace: "ws-x4", machine: "build-box-2", pose: "asleep", status: null, started: "Mon 16:40", last: "Mon 17:05", lead: "sDe", joined: "spawned", role: "tone" },
      { id: "sSig", title: "Rotate the webhook signing secret", project: "payments-api", provider: "codex", model: "gpt-5.4", workspace: "ws-x5", branch: "sec/webhook-secret", machine: "build-box-2", pose: "idle", status: null, started: "08:44", last: "09:20", lead: null },
      { id: "sSigReview", title: "Adversarial review of the signing secret rotation", project: "payments-api", provider: "claude", model: "Opus 5.5", workspace: "ws-x5", machine: "build-box-2", pose: "waiting", status: "approval", ask: "Run pnpm db:migrate?", askShort: "Run pnpm db:migrate?", started: "09:05", last: "09:38", lead: "sSig", joined: "spawned", role: "review" },
      { id: "sRefunds", title: "Reconcile August refunds", project: "payments-api", provider: "codex", model: "gpt-5.4", workspace: "ws-x6", branch: "main", machine: "build-box-2", pose: "idle", status: null, started: "Mon 10:12", last: "Mon 11:40", lead: null },
      { id: "sRate", title: "Rate-limit the payouts API", project: "payments-api", provider: "claude", model: "Sonnet 5", workspace: "ws-x7", branch: "feat/payouts-rate-limit", machine: "build-box-1", pose: "working", status: "working", started: "09:15", last: "09:41", lead: null },
      { id: "sRateLoad", title: "Load-test the payouts rate limiter", project: "payments-api", provider: "codex", model: "gpt-5.4-mini", workspace: "ws-x7", machine: "build-box-1", pose: "working", status: "queued", started: "09:39", last: "09:39", lead: "sRate", joined: "spawned", role: "load test" },
      { id: "sPg", title: "Upgrade Postgres to 18", project: "ops", provider: "claude", model: "Opus 5.5", workspace: "ws-x8", branch: "ops/postgres-18", machine: "studio-mac", pose: "working", status: "working", started: "08:05", last: "09:41", lead: null },
      { id: "sPgRollback", title: "Plan the Postgres 18 rollback", project: "ops", provider: "codex", model: "gpt-5.4", workspace: "ws-x8", machine: "studio-mac", pose: "waiting", status: "question", ask: "Keep a replica on 17 for a week?", askShort: "Keep a replica on 17?", started: "08:31", last: "09:34", lead: "sPg", joined: "spawned", role: "rollback" },
      { id: "sPgExt", title: "Check every extension works on Postgres 18", project: "ops", provider: "claude", model: "Haiku 4.5", workspace: "ws-x8", machine: "studio-mac", pose: "idle", status: null, started: "08:40", last: "09:02", lead: "sPg", joined: "spawned", role: "extensions" },
      { id: "sBackups", title: "Move backups to the new bucket", project: "ops", provider: "claude", model: "Sonnet 5", workspace: "ws-x9", branch: "ops/backup-bucket", machine: "build-box-1", pose: "working", status: "working", started: "09:20", last: "09:41", lead: null },
      { id: "sDisk", title: "Investigate disk alerts on build-box-1", project: "ops", provider: "codex", model: "gpt-5.4", workspace: "ws-x10", branch: "main", machine: "build-box-1", pose: "waiting", status: "approval", ask: "Run du -sh /var/lib/docker?", askShort: "Run du -sh?", started: "09:36", last: "09:40", lead: null },
      { id: "sTalk", title: "Outline a talk on agent swarms", project: null, provider: "claude", model: "Opus 5.5", workspace: "none", machine: "studio-mac", pose: "asleep", status: null, started: "Sun 21:10", last: "Sun 21:48", lead: null },
    ],
  };

  // The swarm's workspaces: each lead's branch and machine, shared by its partners.
  SWARM.threads.forEach(function (t) {
    if (WORKSPACES[t.workspace] || t.workspace === "none") return;
    WORKSPACES[t.workspace] = t.branch === "main"
      ? { kind: "main", repo: t.project, branch: "main", machine: t.machine }
      : { kind: "worktree", repo: t.project, branch: t.branch, from: "main", machine: t.machine };
  });

  /*
   * The stress state adds one piece of work the way it looks in real use: ten threads with titles
   * as long as real titles get, mirroring Rogier's "Migrate unmigrated endpoints to MwsResult".
   * `roleBy` says where a role came from: "lead" when the lead named it as it started the partner
   * (`hercule session spawn --role review`), "generated" when a Text Generation wrote it. Two
   * partners Rogier added with the header's + have no role yet, so a design must fall back to
   * their titles.
   */
  WORKSPACES["ws-shape"] = { kind: "worktree", repo: "payments-api", branch: "rogier/result-error-shape", from: "main", machine: "studio-mac" };
  var STRESS = {
    open: "xLead",
    threads: [
      { id: "xLead", title: "Migrate the unmigrated payout endpoints to the Result error shape", project: "payments-api", provider: "claude", model: "Opus 5.5", workspace: "ws-shape", pose: "working", status: "working", started: "08:12", last: "09:41", lead: null, result: "14 of 22 endpoints migrated. Fixing the review's finding on GET /v1/payouts/:id." },
      { id: "xReview", title: "Adversarial review of the Result error shape on the payout endpoints", project: "payments-api", provider: "codex", model: "gpt-5.4", workspace: "ws-shape", pose: "waiting", status: "question", ask: "Should a 409 from Stripe become a Result error or a retry?", askShort: "409 from Stripe: error or retry?", started: "08:40", last: "09:37", lead: "xLead", joined: "spawned", role: "review", roleBy: "lead", result: "2 findings so far, 1 blocking." },
      { id: "xTests", title: "Write contract tests for every migrated payout endpoint", project: "payments-api", provider: "codex", model: "gpt-5.4-mini", workspace: "ws-shape", pose: "working", status: "working", started: "08:44", last: "09:40", lead: "xLead", joined: "spawned", role: "tests", roleBy: "lead", result: "31 contract tests, 2 failing on purpose until the lead's fix lands." },
      { id: "xDocs", title: "Update the OpenAPI document for the new Result error responses", project: "payments-api", provider: "claude", model: "Sonnet 5", workspace: "ws-shape", pose: "working", status: "working", started: "09:20", last: "09:41", lead: "xLead", joined: "spawned", role: "API docs", roleBy: "lead", result: "Rewriting the error schemas of 14 operations." },
      { id: "xInventory", title: "Find every payout endpoint that still returns a raw IActionResult", project: "payments-api", provider: "claude", model: "Haiku 4.5", workspace: "ws-shape", pose: "idle", status: null, started: "08:15", last: "08:31", lead: "xLead", joined: "spawned", role: "inventory", roleBy: "lead", result: "22 endpoints, 8 still unmigrated." },
      { id: "xMobile", title: "Check that the mobile app still parses payout errors after the change", project: "payments-api", provider: "codex", model: "gpt-5.4", workspace: "ws-shape", pose: "idle", status: null, started: "09:02", last: "09:24", lead: "xLead", joined: "spawned", role: "mobile check", roleBy: "lead", result: "The app parses the new shape; one toast shows the raw code." },
      { id: "xBench", title: "Benchmark payout list latency before and after the migration", project: "payments-api", provider: "codex", model: "gpt-5.4-mini", workspace: "ws-shape", pose: "idle", status: null, started: "08:58", last: "09:11", lead: "xLead", joined: "spawned", role: "benchmark", roleBy: "lead", result: "p95 unchanged at 84ms." },
      { id: "xRefunds", title: "Second adversarial pass on refunds and reversals under the new error shape", project: "payments-api", provider: "claude", model: "Opus 5.5", workspace: "ws-shape", pose: "idle", status: null, started: "09:05", last: "09:33", lead: "xLead", joined: "spawned", role: "refunds review", roleBy: "lead", result: "No findings on refunds; one on reversals, not blocking." },
      { id: "xChangelog", title: "Draft the changelog entry and the migration note for API consumers", project: "payments-api", provider: "claude", model: "Haiku 4.5", workspace: "ws-shape", pose: "idle", status: null, started: "09:26", last: "09:30", lead: "xLead", joined: "added", role: null, result: "Draft ready for the lead to check." },
      { id: "xStripe", title: "Ask whether Stripe can send payout.failed twice for the same payout", project: "payments-api", provider: "claude", model: "Sonnet 5", workspace: "ws-shape", pose: "idle", status: null, started: "09:14", last: "09:19", lead: "xLead", joined: "added", role: null, result: "Yes, on retries; the webhook handler must be idempotent." },
    ],
    exchanges: [
      { at: "08:15", from: "xLead", to: "xInventory", kind: "brief", text: "List every payout endpoint and say which ones still return a raw IActionResult." },
      { at: "08:31", from: "xInventory", to: "xLead", kind: "report", text: "22 endpoints. 8 still return a raw IActionResult; the list is in inventory.md." },
      { at: "08:40", from: "xLead", to: "xReview", kind: "brief", text: "Try to break the Result error shape on the migrated payout endpoints. Look for errors that escape a Result." },
      { at: "08:44", from: "xLead", to: "xTests", kind: "brief", text: "Write a contract test for every migrated endpoint, one per error case in the Result shape." },
      { at: "09:28", from: "xReview", to: "xLead", kind: "report", text: "Blocking: PayoutError escapes through GET /v1/payouts/:id when the payout is archived." },
      { at: "09:40", from: "xTests", to: "xLead", kind: "report", text: "31 contract tests written. 2 fail until GET /v1/payouts/:id is fixed." },
    ],
  };

  /*
   * Transcripts for the threads a direction opens. Items:
   *   { me, at }                   Rogier's message
   *   { from, at, text }           a message another thread sent this one (an exchange)
   *   { sent, at, text }           a message this thread sent another (an exchange)
   *   { worked, tools }            the "Worked for" divider
   *   { agent, at, html }          the agent's message, as HTML (code in <code>)
   *   { files }                    the changed-files card, from OUTPUT
   *   { result, cmd }              a test result line
   *   { waiting }                  the "Waiting on you since" note
   *   { working }                  the "Working" note at the end of a running turn
   */
  var TRANSCRIPTS = {
    t3ds: [
      { me: "Checkout fails for EU cards that need 3-D Secure since deploy #1289. Find the cause and fix it. Add a test that reproduces it first.", at: "09:02" },
      { worked: "Worked for 2m 14s", tools: ["read 6 files", "ran 1 command"] },
      { agent: true, at: "09:04", html: "Found it. Since Stripe SDK v14, <code>confirmPayment</code> returns <code>status: 'requires_action'</code> for cards that need 3-D Secure. <code>handlePaymentResult</code> in <code>src/checkout/payment.ts</code> only handles <code>succeeded</code> and treats everything else as a failure, so we show “Card declined” instead of opening the 3-D Secure modal." },
      { from: "tStripe", at: "09:21", text: "v14 returns requires_action for cards that need 3-D Secure. handlePaymentResult has to open the modal for it." },
      { worked: "Worked for 4m 51s", tools: ["edited 3 files", "ran pnpm test checkout"] },
      { files: "t3ds" },
      { result: "24 passed", cmd: "pnpm test checkout" },
      { sent: "t3dsReview", at: "09:30", text: "Try to break the 3-D Secure fix on fix/3ds-eu-cards. Start with handlePaymentResult and every status Stripe v14 can return." },
      { agent: true, at: "09:31", html: "Tests pass. I asked Codex for an adversarial review in this worktree. Ready to push the branch and open a pull request." },
      { from: "t3dsReview", at: "09:38", text: "First finding: a processing status still shows “Card declined”. Still looking." },
      { waiting: "Waiting on you since 09:31 · 10m" },
    ],
    t3dsReview: [
      { from: "t3ds", at: "09:30", text: "Try to break the 3-D Secure fix on fix/3ds-eu-cards. Start with handlePaymentResult and every status Stripe v14 can return.", opening: true },
      { worked: "Worked for 3m 40s", tools: ["read 9 files", "ran 2 commands"] },
      { agent: true, at: "09:34", html: "Stripe v14 can return six PaymentIntent statuses here. The fix handles <code>succeeded</code> and <code>requires_action</code>. <code>processing</code> still falls through to the failure branch, so a slow SEPA-backed card shows “Card declined” although the payment may still succeed." },
      { sent: "t3ds", at: "09:38", text: "First finding: a processing status still shows “Card declined”. Still looking." },
      { worked: "Working for 3m", tools: ["read 4 files", "running pnpm test checkout --grep status"], live: true },
    ],
    tStripe: [
      { me: "Read the Stripe v14 changelog and tell the 3-D Secure thread which changes touch checkout.", at: "09:05" },
      { worked: "Worked for 6m 02s", tools: ["fetched 3 pages", "read 2 files"] },
      { agent: true, at: "09:11", html: "Four changes in v14 touch checkout: <code>requires_action</code> for 3-D Secure, the new <code>processing</code> status for SEPA-backed cards, the renamed <code>payment_method_options</code>, and stricter idempotency keys." },
      { sent: "t3ds", at: "09:21", text: "v14 returns requires_action for cards that need 3-D Secure. handlePaymentResult has to open the modal for it." },
    ],
  };

  window.WORLD = {
    now: NOW,
    today: "Tuesday 29 September 2026",
    projects: PROJECTS,
    providers: PROVIDERS,
    workspaces: WORKSPACES,
    threads: THREADS,
    output: OUTPUT,
    exchanges: EXCHANGES,
    done: DONE,
    doneCount: DONE_COUNT,
    waitingRuns: WAITING_RUNS,
    assistants: ASSISTANTS,
    spawn: SPAWN,
    swarm: SWARM,
    stress: STRESS,
    transcripts: TRANSCRIPTS,
  };
})();
