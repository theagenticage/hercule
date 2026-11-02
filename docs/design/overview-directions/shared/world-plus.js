// PROTOTYPE - what the five overview directions read on top of the sidebar book's world.
//
// Load it after ../../sidebar-directions/shared/world.js. It adds fields to window.WORLD and never
// changes a fact world.js or ../../shared/CONTENT.md already states. Where those two disagree with
// the brief's examples, the world wins; the notes below say where.
//
// Everything is keyed by session id. "Thread" below means any session in world.js's thread shape:
// the 16 threads of the morning (WORLD.threads), the two threads assistants started
// (WORLD.assistantThreads, added here), the spawn state's partner (WORLD.spawn.thread) and the 19
// threads of the swarm state (WORLD.swarm.threads). The run's sessions are in WORLD.runSessions.
//
// Times are "HH:MM" on Tuesday 29 September 2026; "yesterday HH:MM", "Mon HH:MM" and "Sun HH:MM"
// are older. Now is 09:41. A range in minutes counts from 09:41.
//
// Notes for builders:
//   - The everyday morning still has 16 live threads: 6 working, 3 waiting, 7 idle. The two
//     assistant threads are idle extras that allLive() includes; leave them out where a count must
//     match the book.
//   - The brief's example crossing "at cart.ts" is src/checkout/payment.ts here: the 3-D Secure fix
//     changed exactly three files (CONTENT.md), and that is the one the cart refactor also changes.
//   - The away state is a reading of the same morning, kept on purpose as Tracks kept it: Rogier
//     steps out at 09:01 for the Tuesday school run and is back at 09:41. Threads that the base
//     world says he started after 09:01 count as never seen in that reading.
(function () {
  "use strict";

  var W = window.WORLD;
  if (!W) throw new Error("world-plus.js: load ../../sidebar-directions/shared/world.js first");

  /* ------------------------------------------------------------------ time */

  var DAY = 24 * 60;
  var DAY_OFFSETS = { yesterday: -1, Mon: -1, Sun: -2 };

  // Returns the minutes since midnight of the morning for a time such as "09:41". A prefix
  // ("yesterday 17:40", "Mon 16:02", "Sun 21:10") counts whole days back, so the result is negative.
  // Returns null for null.
  function minutes(time) {
    if (time == null) return null;
    var parts = String(time).split(" ");
    var clock = parts[parts.length - 1].split(":");
    var days = parts.length > 1 ? DAY_OFFSETS[parts[0]] || 0 : 0;
    return days * DAY + Number(clock[0]) * 60 + Number(clock[1]);
  }

  var NOW_MIN = minutes(W.now);

  // Returns how long ago a time was, as the rows say it: "now", "12m", "2h", "1d".
  function ago(time) {
    var m = NOW_MIN - minutes(time);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    if (m < DAY) return Math.floor(m / 60) + "h";
    return Math.floor(m / DAY) + "d";
  }

  /* ------------------------------------------------------------------ 1. threads assistants started */

  // An assistant starts a thread the way a lead starts a partner: the thread copies the calling
  // session's provider and model (GLOSSARY.md, Thread). Both are idle, so the morning's counts hold.
  //   aRust    Ada started it last night from her reading topic ("summaries of the weekly Rust and
  //            Postgres newsletters"); her 07:00 and 08:00 heartbeats found nothing new.
  //   aTables  Milo started it at 09:31 after the Nightly backup check posted to Slack #ops, then
  //            started the Investigate run at 09:35 (Ada tells Rogier so at 09:38).
  W.workspaces["ws-ops-studio"] = { kind: "main", repo: "ops", branch: "main", machine: "studio-mac" };
  W.assistantThreads = [
    {
      id: "aRust", title: "Summarise this week's Rust newsletter", project: null,
      provider: "claude", model: "Sonnet 5", workspace: "none",
      pose: "idle", status: null, started: "yesterday 21:30", last: "yesterday 21:41", lead: null,
      result: "Five items; the async closures change is the one that touches your code.",
    },
    {
      id: "aTables", title: "List the largest tables on ops-db", project: "ops",
      provider: "codex", model: "gpt-5.4", workspace: "ws-ops-studio",
      pose: "idle", status: null, started: "09:31", last: "09:34", lead: null,
      result: "events is 41 GB and grows about 600 MB a night.",
    },
  ];

  /* ------------------------------------------------------------------ 2. who started whom */

  // startedBy is what sessions.created_by stores, which the contract does not expose yet:
  //   "user"               Rogier started it
  //   "session:<id>"       a lead started it as a partner (joined "spawned")
  //   "assistant:<name>"   an assistant started it
  //   "run:<runId>"        a run's step started it (the run sessions below)
  // A partner Rogier added with the header's + is "user", and addedTo names its lead.
  W.startedBy = {};
  W.addedTo = {};
  function stampLineage(t) {
    if (t.lead && t.joined === "added") {
      W.startedBy[t.id] = "user";
      W.addedTo[t.id] = t.lead;
    } else if (t.lead) {
      W.startedBy[t.id] = "session:" + t.lead;
    } else {
      W.startedBy[t.id] = "user";
    }
  }
  W.threads.forEach(stampLineage);
  W.swarm.threads.forEach(stampLineage);
  stampLineage(W.spawn.thread);
  W.startedBy.aRust = "assistant:Ada";
  W.startedBy.aTables = "assistant:Milo";
  // Milo watches Slack #ops, where the disk alert on build-box-1 landed, and opened the thread.
  W.startedBy.sDisk = "assistant:Milo";

  /* ------------------------------------------------------------------ 3. goals and routes */

  /*
   * A goal is what a thread is for, and its route is how far it has come (Expedition reads it; the
   * others may). Fields:
   *   summit       the definition of done, in a few words
   *   camps        the route, in order. Each camp: { label, state, at?, observed?, added?, of? }
   *                  state     "done" | "current" (where it stands now) | "waiting" (parked on you) | "todo"
   *                  at        when it was reached (done) or when it started waiting
   *                  observed  true when Hercule sees it itself (tests, review, PR, CI, merge),
   *                            false or missing when it comes from the agent's own plan
   *                  added     when a camp was added after the route began (the route grew)
   *                  of        [n, total] for a camp with countable progress
   *   stage        scoping | building | proving | reviewing | shipping | landed (the Board's columns)
   *   stageSince   when it entered that stage
   *   lastProgress when its last camp was reached. A route whose lastProgress is 30 minutes or more
   *                ago while its thread is not idle is stuck: tDash (09:07, 34m) and, in the swarm, sPg.
   *   grew         how many camps were added since the route began (tResult grew 2)
   */
  function camp(label, state, at, extra) {
    var c = { label: label, state: state };
    if (at) c.at = at;
    if (extra) for (var k in extra) c[k] = extra[k];
    return c;
  }
  var OBS = { observed: true };

  W.goals = {
    // ---------------------------------------------------------------- webshop
    t3ds: {
      summit: "PR merged with CI green",
      camps: [
        camp("Find the cause", "done", "09:04"),
        camp("Write a failing test", "done", "09:24"),
        camp("Fix handlePaymentResult", "done", "09:27"),
        camp("Checkout tests pass", "done", "09:28", OBS),
        camp("Push the branch", "waiting", "09:31"),
        camp("Review clean", "current", null, OBS),
        camp("PR open", "todo", null, OBS),
        camp("CI green", "todo", null, OBS),
        camp("Merged", "todo", null, OBS),
      ],
      stage: "reviewing", stageSince: "09:30", lastProgress: "09:28", grew: 0,
    },
    tStripe: {
      summit: "Changes that touch checkout reported",
      camps: [
        camp("Read the v14 changelog", "done", "09:11"),
        camp("List what touches checkout", "done", "09:11"),
        camp("Report to the lead", "done", "09:21", OBS),
      ],
      stage: "landed", stageSince: "09:21", lastProgress: "09:21", grew: 0,
    },
    t3dsReview: {
      summit: "Findings reported",
      camps: [
        camp("List the statuses v14 returns", "done", "09:34"),
        camp("Check each one is handled", "done", "09:38"),
        camp("Test the edge statuses", "current"),
        camp("Report to the lead", "todo", null, OBS),
      ],
      stage: "reviewing", stageSince: "09:30", lastProgress: "09:38", grew: 0,
    },
    tCart: {
      summit: "PR merged with CI green",
      camps: [
        camp("Map where totals are computed", "done", "09:23"),
        camp("Move discount maths into computeTotals", "current"),
        camp("Property tests pass", "todo", null, OBS),
        camp("Cart tests pass", "todo", null, OBS),
        camp("PR open", "todo", null, OBS),
        camp("CI green", "todo", null, OBS),
        camp("Merged", "todo", null, OBS),
      ],
      stage: "building", stageSince: "09:23", lastProgress: "09:23", grew: 0,
    },
    tCartTests: {
      summit: "Properties hold",
      camps: [
        camp("Write 4 properties", "done", "09:31"),
        camp("Run 1,000 cases each", "done", "09:39"),
        camp("Shrink the failing case", "current"),
        camp("All properties pass", "todo", null, OBS),
      ],
      stage: "proving", stageSince: "09:31", lastProgress: "09:39", grew: 0,
    },
    tCss: {
      summit: "PR merged with CI green",
      camps: [
        camp("Find unused rules", "done", "07:20"),
        camp("Remove them", "done", "07:34"),
        camp("Screenshots unchanged", "done", "07:38"),
        camp("PR open", "done", "07:40", { observed: true, note: "#1281" }),
        camp("CI green", "done", "07:52", OBS),
        camp("Merged", "todo", null, OBS),
      ],
      stage: "shipping", stageSince: "07:40", lastProgress: "07:52", grew: 0,
    },
    tA11y: {
      summit: "Report delivered",
      camps: [
        camp("Audit the checkout pages", "done", "08:46"),
        camp("Check the card form with VoiceOver", "done", "08:50"),
        camp("List the issues by severity", "done", "08:55"),
        camp("Report delivered", "done", "08:56", OBS),
      ],
      stage: "landed", stageSince: "08:56", lastProgress: "08:56", grew: 0,
    },

    // ---------------------------------------------------------------- payments-api
    tPayout: {
      summit: "Report delivered",
      camps: [
        camp("Query September payouts", "done", "09:34", { note: "1,284 payouts" }),
        camp("Group by merchant and currency", "done", "09:37"),
        camp("Write the CSV and summary", "current"),
        camp("Check totals against Stripe", "waiting", "09:39", { note: "the check partner waits on you" }),
        camp("Report delivered", "todo", null, OBS),
      ],
      stage: "reviewing", stageSince: "09:35", lastProgress: "09:37", grew: 0,
    },
    tPayoutCheck: {
      summit: "Totals match Stripe",
      camps: [
        camp("Pull Stripe balance transactions", "done", "09:38"),
        camp("Decide how to count refunds", "waiting", "09:39"),
        camp("Compare the totals", "todo"),
      ],
      stage: "reviewing", stageSince: "09:35", lastProgress: "09:38", grew: 0,
    },
    tResult: {
      summit: "PR merged with CI green",
      camps: [
        camp("Inventory payout endpoints", "done", "08:55"),
        camp("Migrate endpoints to Result types", "done", "09:08"),
        camp("Contract tests pass", "done", "09:12", OBS),
        camp("Draft PR open", "done", "09:14", { observed: true, note: "#1287" }),
        camp("CI green", "done", "09:22", OBS),
        camp("Adversarial review", "done", "09:31", { observed: true, note: "3 findings, 1 blocking" }),
        camp("Fix the blocking finding", "current", null, { added: "09:31" }),
        camp("Review clean", "todo", null, { observed: true, added: "09:31" }),
        camp("Merged", "todo", null, OBS),
      ],
      stage: "reviewing", stageSince: "09:10", lastProgress: "09:31", grew: 2,
    },
    tResultReview: {
      summit: "Review clean",
      camps: [
        camp("Review the migration", "done", "09:31"),
        camp("Report findings", "done", "09:31", OBS),
        camp("Re-review after the fix", "todo"),
      ],
      stage: "reviewing", stageSince: "09:10", lastProgress: "09:31", grew: 0,
    },
    tIdeal: {
      summit: "Question answered",
      camps: [
        camp("Read Stripe's iDEAL docs", "done", "08:34"),
        camp("Compare the 3 ways", "done", "08:39"),
        camp("Recommend one", "done", "08:41"),
        camp("Question answered", "done", "08:41", OBS),
      ],
      stage: "landed", stageSince: "08:41", lastProgress: "08:41", grew: 0,
    },

    // ---------------------------------------------------------------- ops
    // The stuck route: the dashboards moved by 09:07, then two alerts would not re-point, and since
    // 09:36 it waits on Rogier's folder question. No camp reached in 34 minutes.
    tDash: {
      summit: "PR merged with every alert firing",
      camps: [
        camp("Export the old dashboards", "done", "09:01"),
        camp("Move 14 dashboards to Grafana 11", "done", "09:07"),
        camp("Decide on the old Grafana folder", "waiting", "09:36"),
        camp("Re-point the 2 broken alerts", "todo"),
        camp("Every alert fires", "todo", null, OBS),
        camp("PR open", "todo", null, OBS),
        camp("Merged", "todo", null, OBS),
      ],
      stage: "proving", stageSince: "09:14", lastProgress: "09:07", grew: 0,
    },
    tDashAlerts: {
      summit: "Every alert checked",
      camps: [
        camp("List the alert rules", "done", "09:20", { note: "31 rules" }),
        camp("Check each one fires", "done", "09:29"),
        camp("Report to the lead", "done", "09:29", OBS),
      ],
      stage: "landed", stageSince: "09:29", lastProgress: "09:29", grew: 0,
    },
    tSecrets: {
      summit: "Staging runs on new secrets",
      camps: [
        camp("List the staging secrets", "done", "09:31"),
        camp("Rotate 14 secrets", "current", null, { of: [9, 14] }),
        camp("Verify every service picks them up", "todo"),
        camp("Revoke the old secrets", "todo"),
        camp("PR open", "todo", null, OBS),
        camp("Merged", "todo", null, OBS),
      ],
      stage: "building", stageSince: "09:31", lastProgress: "09:31", grew: 0,
    },
    tSecretsVerify: {
      summit: "Every service reads the new secrets",
      camps: [
        camp("Restart services one at a time", "current"),
        camp("Check each reads the new secrets", "todo"),
        camp("Report to the lead", "todo", null, OBS),
      ],
      stage: "proving", stageSince: "09:41", lastProgress: "09:41", grew: 0,
    },

    // ---------------------------------------------------------------- no project
    tBun: {
      summit: "Question answered",
      camps: [
        camp("Find the release notes", "done", "06:52"),
        camp("Read them", "done", "06:55"),
        camp("Note what affects your projects", "done", "06:57"),
        camp("Question answered", "done", "06:58", OBS),
      ],
      stage: "landed", stageSince: "06:58", lastProgress: "06:58", grew: 0,
    },
    aRust: {
      summit: "Summary delivered",
      camps: [
        camp("Read the newsletter", "done", "yesterday 21:35"),
        camp("Pick what matters to you", "done", "yesterday 21:39"),
        camp("Summary delivered", "done", "yesterday 21:41", OBS),
      ],
      stage: "landed", stageSince: "yesterday 21:41", lastProgress: "yesterday 21:41", grew: 0,
    },
    aTables: {
      summit: "Question answered",
      camps: [
        camp("List tables by size", "done", "09:33"),
        camp("Measure nightly growth", "done", "09:34"),
        camp("Question answered", "done", "09:34", OBS),
      ],
      stage: "landed", stageSince: "09:34", lastProgress: "09:34", grew: 0,
    },
  };

  // The swarm's routes, lighter: the camps' labels, how many are done, and where it stands. Camps
  // after the first `done` are todo, except the one it stands at: "current", or "waiting" for a
  // thread parked on Rogier. A route with every camp done has landed.
  function route(summit, labels, done, stage, stageSince, lastProgress, opts) {
    opts = opts || {};
    var camps = labels.map(function (label, i) {
      var observed = /^(PR open|CI green|Merged|Review clean|.* pass(es)?|.* fire(s)?)$/.test(label);
      var state = i < done ? "done" : i === done ? (opts.waiting ? "waiting" : "current") : "todo";
      var c = camp(label, state, i === done && opts.waiting ? opts.waiting : null);
      if (observed) c.observed = true;
      return c;
    });
    return { summit: summit, camps: camps, stage: done >= labels.length ? "landed" : stage, stageSince: stageSince, lastProgress: lastProgress, grew: opts.grew || 0 };
  }
  var SHIP = ["PR open", "CI green", "Merged"];
  var SWARM_GOALS = {
    sImg: route("PR merged with CI green", ["Measure the image payload", "Serve AVIF with a fallback", "Lazy-load below the fold", "LCP under 2.5s"].concat(SHIP), 2, "building", "09:20", "09:26"),
    sImgLcp: route("LCP measured before and after", ["Measure LCP on main", "Measure LCP on the branch"], 1, "proving", "09:12", "09:26"),
    sApple: route("PR merged with CI green", ["Register the Apple Pay domain", "Add the Apple Pay button", "Handle the payment sheet", "End-to-end tests pass", "Review clean"].concat(SHIP), 3, "proving", "09:02", "09:24"),
    sAppleReview: route("Domain setup reviewed", ["Check the domain file", "Report to the lead"], 2, "reviewing", "08:51", "09:15"),
    sAppleE2e: route("End-to-end tests pass", ["Write the payment sheet test", "Pick a test card", "Run the suite"], 1, "proving", "09:02", "09:20", { waiting: "09:37" }),
    sCoupon: route("PR merged with CI green", ["Reproduce the double discount", "Fix coupon stacking", "Cart tests pass"].concat(SHIP), 1, "building", "09:37", "09:37"),
    sDe: route("PR merged with CI green", ["Translate the checkout strings", "Tone check", "PR open", "Merged"], 1, "reviewing", "Mon 16:40", "Mon 16:38"),
    sDeTone: route("Copy checked for tone", ["Read the German copy", "Flag phrases that sound stiff"], 2, "reviewing", "Mon 16:40", "Mon 17:05"),
    sSig: route("PR merged with CI green", ["Add a second signing secret", "Accept both during the rollover", "Migration for the new secret", "Review clean", "PR open", "Merged"], 3, "reviewing", "09:05", "09:04"),
    sSigReview: route("Findings reported", ["Read the rotation", "Run the migration locally", "Report findings"], 1, "reviewing", "09:05", "09:22", { waiting: "09:38" }),
    sRefunds: route("Reconciliation delivered", ["Pull August refunds", "Match them against Stripe", "Report the gaps"], 3, "landed", "Mon 11:40", "Mon 11:40"),
    sRate: route("PR merged with CI green", ["Pick a limit per merchant", "Add the rate limiter", "Load test passes"].concat(SHIP), 2, "proving", "09:39", "09:36"),
    sRateLoad: route("Load test reported", ["Load-test at 50 requests a second", "Report p95"], 0, "proving", "09:39", "09:39"),
    // The swarm's stuck route: extensions would not build for 18 after 09:07.
    sPg: route("PR merged with CI green", ["Read the 18 release notes", "Plan the upgrade", "Upgrade the replica", "Build extensions for 18", "Switch over", "Rollback tested", "Merged"], 3, "building", "08:40", "09:07"),
    sPgRollback: route("Rollback plan agreed", ["Write the rollback plan", "Decide how long to keep 17"], 1, "reviewing", "08:31", "09:20", { waiting: "09:34" }),
    sPgExt: route("Every extension checked", ["List the extensions", "Check each on 18"], 2, "landed", "09:02", "09:02"),
    sBackups: route("Backups land in the new bucket", ["Create the new bucket", "Copy last week's backups", "Point the job at the new bucket", "Restore test passes"], 1, "building", "09:24", "09:24"),
    sDisk: route("Disk alert explained", ["Find what fills the disk", "Propose a cleanup"], 0, "scoping", "09:36", "09:36", { waiting: "09:40" }),
    sTalk: route("Outline written", ["Collect examples", "Draft the outline"], 2, "landed", "Sun 21:48", "Sun 21:48"),
  };
  for (var gid in SWARM_GOALS) W.goals[gid] = SWARM_GOALS[gid];

  /* ------------------------------------------------------------------ 4. when each thread will need Rogier */

  /*
   * eta[id], for every live thread. Hercule predicts it; the design shows it as a prediction.
   *   busySince  when the current turn started; null for an idle or queued thread
   *   next       what it will next bring Rogier: "request" (a question or approval), "turn-end" (a
   *              result to read), or null (it waits on him already, or is idle)
   *   range      [lo, hi] minutes from 09:41, or null
   *   basis      what the prediction rests on, in a few words
   * Three arrivals fall within 10:02-10:06 (tCart, tPayout, tResult): Control Tower's conflict alert.
   */
  function eta(busySince, next, range, basis) {
    return { busySince: busySince, next: next, range: range, basis: basis };
  }
  W.eta = {
    t3ds: eta("09:21", null, null, "waiting on you since 09:31"),
    tStripe: eta(null, null, null, "idle since 09:21"),
    t3dsReview: eta("09:30", "turn-end", [4, 9], "4 of 6 statuses checked, ~2m each"),
    tCart: eta("09:19", "turn-end", [21, 25], "camp 2 of 7, its turns run ~45m"),
    tCartTests: eta("09:24", "turn-end", [1, 4], "shrinking one failing case"),
    tCss: eta(null, null, null, "idle since 07:40"),
    tA11y: eta(null, null, null, "idle since 08:56"),
    tPayout: eta("09:32", "turn-end", [21, 24], "camp 3 of 5, ~8m a step"),
    tPayoutCheck: eta("09:35", null, null, "waiting on you since 09:39"),
    tResult: eta("09:31", "request", [22, 25], "fix nearly done; it asks before every git push"),
    tResultReview: eta(null, null, null, "idle since 09:34"),
    tIdeal: eta(null, null, null, "idle since 08:41"),
    tDash: eta("09:29", null, null, "waiting on you since 09:36"),
    tDashAlerts: eta(null, null, null, "idle since 09:29"),
    tSecrets: eta("09:30", "turn-end", [9, 14], "9 of 14 secrets rotated, ~2m each"),
    tBun: eta(null, null, null, "idle since 06:58"),
    tSecretsVerify: eta("09:41", "turn-end", [6, 12], "5 services, ~2m each"),
    aRust: eta(null, null, null, "idle since yesterday 21:41"),
    aTables: eta(null, null, null, "idle since 09:34"),
    // The swarm.
    sImg: eta("09:27", "turn-end", [8, 14], "camp 3 of 7, turns of ~18m"),
    sImgLcp: eta(null, null, null, "idle until the branch is ready"),
    sApple: eta("09:24", "request", [30, 45], "payment sheet nearly wired; asks before deploying"),
    sAppleReview: eta(null, null, null, "idle since 09:15"),
    sAppleE2e: eta("09:20", null, null, "waiting on you since 09:37"),
    sCoupon: eta("09:33", "turn-end", [12, 18], "camp 2 of 6"),
    sDe: eta(null, null, null, "idle since Monday"),
    sDeTone: eta(null, null, null, "asleep"),
    sSig: eta(null, null, null, "idle since 09:20"),
    sSigReview: eta("09:22", null, null, "waiting on you since 09:38"),
    sRefunds: eta(null, null, null, "idle since Monday"),
    sRate: eta("09:15", "turn-end", [35, 50], "waits on its load test"),
    sRateLoad: eta(null, "turn-end", [15, 25], "queued: build-box-1 is at cap"),
    sPg: eta("08:40", "request", [5, 40], "no progress in 34m; a wide guess"),
    sPgRollback: eta("09:20", null, null, "waiting on you since 09:34"),
    sPgExt: eta(null, null, null, "idle since 09:02"),
    sBackups: eta("09:20", "turn-end", [16, 22], "copying 7 backups, ~3m each"),
    sDisk: eta("09:36", null, null, "waiting on you since 09:40"),
    sTalk: eta(null, null, null, "asleep"),
  };

  /* ------------------------------------------------------------------ 5. the code: repositories and files */

  /*
   * repos[repo].folders: the file tree on main, by folder. A file is { name, lines }. A file that
   * exists only on a branch has `newIn: <workspace id>` and the lines it has there. Atlas draws a
   * folder as a district and a file as a building.
   */
  function files(list) {
    return list.map(function (f) {
      var o = { name: f[0], lines: f[1] };
      if (f[2]) o.newIn = f[2];
      return o;
    });
  }
  W.repos = {
    webshop: {
      folders: [
        { path: "src/checkout", files: files([["payment.ts", 412], ["payment.test.ts", 380], ["3ds-modal.tsx", 146], ["sepa.ts", 75], ["payment-errors.ts", 85], ["card-form.tsx", 220], ["card-form.module.css", 96], ["checkout-page.tsx", 310], ["address-form.tsx", 190], ["apple-pay.ts", 120, "ws-x2"]]) },
        { path: "src/cart", files: files([["totals.ts", 260], ["totals.test.ts", 210], ["totals.property.test.ts", 96, "ws-cart"], ["discounts.ts", 180], ["coupon.ts", 150], ["cart-store.ts", 240], ["cart-page.tsx", 280]]) },
        { path: "src/catalog", files: files([["product-page.tsx", 340], ["product-image.tsx", 120], ["image-loader.ts", 90], ["search.ts", 200], ["filters.ts", 160]]) },
        { path: "src/i18n", files: files([["de.json", 900], ["en.json", 880], ["nl.json", 870], ["format.ts", 70]]) },
        { path: "src/lib", files: files([["stripe.ts", 160], ["money.ts", 110], ["http.ts", 90], ["analytics.ts", 130], ["flags.ts", 60]]) },
        { path: "styles", files: files([["checkout.css", 640], ["cart.css", 310], ["buttons.css", 180], ["base.css", 420], ["catalog.css", 360]]) },
        { path: "e2e", files: files([["checkout.spec.ts", 260], ["cart.spec.ts", 190], ["apple-pay.spec.ts", 80, "ws-x2"], ["catalog.spec.ts", 140]]) },
      ],
    },
    "payments-api": {
      folders: [
        { path: "src/payouts", files: files([["payouts.controller.ts", 520], ["payouts.service.ts", 430], ["payout-error.ts", 60], ["payouts.routes.ts", 140], ["payout-list.ts", 180], ["payout-schedule.ts", 150], ["payout-filters.ts", 110], ["payout-export.ts", 130]]) },
        { path: "src/result", files: files([["result.ts", 120], ["errors.ts", 210], ["http-result.ts", 90]]) },
        { path: "src/webhooks", files: files([["webhook-handler.ts", 360], ["signing.ts", 110], ["retry.ts", 140], ["events.ts", 230]]) },
        { path: "src/refunds", files: files([["refunds.service.ts", 300], ["reversals.ts", 190], ["refund-error.ts", 70]]) },
        { path: "src/reports", files: files([["monthly.ts", 120], ["september-payouts.ts", 260, "ws-payout"], ["report-csv.ts", 60, "ws-payout"]]) },
        { path: "src/platform", files: files([["client.ts", 120], ["balance.ts", 150], ["auth.ts", 160], ["logging.ts", 80], ["rate-limit.ts", 140, "ws-x7"]]) },
        { path: "test", files: files([["payouts.contract.test.ts", 600], ["webhooks.test.ts", 340], ["result.test.ts", 200]]) },
        { path: "docs", files: files([["payment-methods.md", 140], ["api-errors.md", 220], ["payouts.openapi.yaml", 900], ["webhooks.openapi.yaml", 400]]) },
        { path: "db/migrations", files: files([["0041-payout-index.sql", 20], ["0042-webhook-secret.sql", 15, "ws-x5"]]) },
      ],
    },
    ops: {
      folders: [
        { path: "grafana/dashboards", files: files([["checkout.json", 1200], ["payments.json", 980], ["infra.json", 1500], ["backups.json", 640], ["certs.json", 300], ["queues.json", 700], ["postgres.json", 860], ["redis.json", 420], ["nginx.json", 560], ["runners.json", 480], ["webhooks.json", 610], ["payouts.json", 530], ["uptime.json", 260], ["costs.json", 340]]) },
        { path: "grafana/alerts", files: files([["checkout-alerts.yaml", 220], ["infra-alerts.yaml", 310], ["backup-alerts.yaml", 140]]) },
        { path: "grafana/legacy", files: files([["old-checkout.json", 1100], ["old-infra.json", 1400], ["old-payments.json", 980]]) },
        { path: "secrets/staging", files: files([["staging.sops.yaml", 140], ["rotate.sh", 90], ["services.txt", 30]]) },
        { path: "backups", files: files([["backup.sh", 160], ["pg_dump.conf", 40], ["b2-bucket.tf", 70], ["retention.yaml", 30]]) },
        { path: "postgres", files: files([["postgresql.conf", 200], ["extensions.sql", 40], ["replica.tf", 120], ["upgrade-18.md", 80, "ws-x8"]]) },
        { path: "hosts", files: files([["build-box-1.yaml", 90], ["build-box-2.yaml", 90], ["studio-mac.yaml", 40], ["compose.yaml", 200]]) },
        { path: "terraform", files: files([["main.tf", 300], ["variables.tf", 120], ["certs.tf", 60]]) },
      ],
    },
  };

  /*
   * files[id]: where each session works in its repository.
   *   area     the folder it touches most, or null
   *   now      the file it is in right now (busy sessions only), or null
   *   touched  [{ path, plus, minus, how: "edit" | "read" }]; paths are repository paths
   *   library  true when it only reads (research, review, questions): Atlas seats it in the library
   *   note     anything a design should know
   * The edits of a workspace's sessions add up to WORLD.output for its lead (the workspace's diff).
   */
  function t(path, plus, minus) {
    return { path: path, plus: plus, minus: minus, how: "edit" };
  }
  function r(path) {
    return { path: path, plus: 0, minus: 0, how: "read" };
  }
  var DASHBOARDS = ["checkout", "payments", "infra", "backups", "certs", "queues", "postgres", "redis", "nginx", "runners", "webhooks", "payouts", "uptime", "costs"];
  W.files = {
    // webshop, ws-3ds: 3 files, +48 -12
    t3ds: { area: "src/checkout", now: null, touched: [t("src/checkout/payment.ts", 21, 9), t("src/checkout/payment.test.ts", 19, 0), t("src/checkout/3ds-modal.tsx", 8, 3), r("src/lib/stripe.ts"), r("src/checkout/payment-errors.ts"), r("src/checkout/checkout-page.tsx")] },
    tStripe: { area: "src/lib", now: null, library: true, touched: [r("src/lib/stripe.ts"), r("src/checkout/payment.ts")], note: "Mostly read Stripe's changelog on the web (3 pages)." },
    t3dsReview: { area: "src/checkout", now: "src/checkout/payment.test.ts", library: true, touched: [r("src/checkout/payment.ts"), r("src/checkout/3ds-modal.tsx"), r("src/checkout/sepa.ts"), r("src/checkout/payment-errors.ts"), r("src/checkout/payment.test.ts"), r("src/lib/stripe.ts")] },
    // webshop, ws-cart: 9 files, +210 -164 (8 by the lead, 1 new test file by its tests partner)
    tCart: { area: "src/cart", now: "src/cart/totals.ts", touched: [t("src/cart/totals.ts", 62, 61), t("src/cart/discounts.ts", 14, 52), t("src/cart/coupon.ts", 6, 18), t("src/cart/cart-store.ts", 8, 9), t("src/cart/cart-page.tsx", 4, 6), t("src/cart/totals.test.ts", 6, 10), t("src/checkout/payment.ts", 6, 4), t("src/lib/money.ts", 8, 4)] },
    tCartTests: { area: "src/cart", now: "src/cart/totals.property.test.ts", touched: [t("src/cart/totals.property.test.ts", 96, 0), r("src/cart/totals.ts"), r("src/cart/discounts.ts")] },
    // webshop main workspace on build-box-1: tCss 4 files -212; tA11y edited nothing it kept.
    tCss: { area: "styles", now: null, touched: [t("styles/checkout.css", 0, 150), t("styles/cart.css", 0, 40), t("src/checkout/card-form.module.css", 0, 18), t("styles/buttons.css", 0, 4)] },
    tA11y: { area: "src/checkout", now: null, touched: [{ path: "src/checkout/card-form.module.css", plus: 0, minus: 0, how: "edit" }, r("src/checkout/card-form.tsx"), r("src/checkout/checkout-page.tsx"), r("src/checkout/address-form.tsx")], note: "Tried a focus-ring fix in card-form.module.css at 08:52 and reverted it, so its diff is 0 but the Edit Overlap with Tidy checkout CSS was recorded." },

    // payments-api, ws-payout: 2 new files, +320 -0
    tPayout: { area: "src/reports", now: "src/reports/report-csv.ts", touched: [t("src/reports/september-payouts.ts", 260, 0), t("src/reports/report-csv.ts", 60, 0), r("src/payouts/payouts.service.ts"), r("src/platform/balance.ts")] },
    tPayoutCheck: { area: null, now: null, library: true, touched: [], note: "Works in a scratch workspace on build-box-2 with no checkout; it reads Stripe's balance transactions through the API." },
    // payments-api, ws-result: 23 files, +412 -388
    tResult: {
      area: "src/payouts", now: "src/payouts/payouts.controller.ts",
      touched: [
        t("src/payouts/payouts.controller.ts", 64, 58), t("src/payouts/payouts.service.ts", 38, 41), t("src/payouts/payout-error.ts", 22, 6), t("src/payouts/payouts.routes.ts", 12, 10),
        t("src/payouts/payout-list.ts", 16, 18), t("src/payouts/payout-schedule.ts", 10, 12), t("src/payouts/payout-filters.ts", 8, 9), t("src/payouts/payout-export.ts", 12, 14),
        t("src/result/result.ts", 30, 4), t("src/result/errors.ts", 40, 12), t("src/result/http-result.ts", 26, 0),
        t("src/refunds/refunds.service.ts", 20, 24), t("src/refunds/reversals.ts", 12, 14), t("src/refunds/refund-error.ts", 10, 8),
        t("src/webhooks/events.ts", 8, 10), t("src/webhooks/webhook-handler.ts", 14, 16),
        t("test/payouts.contract.test.ts", 30, 60), t("test/result.test.ts", 12, 20),
        t("docs/api-errors.md", 6, 18), t("docs/payouts.openapi.yaml", 8, 18),
        t("src/platform/logging.ts", 4, 6), t("src/platform/client.ts", 6, 8), t("src/platform/balance.ts", 4, 2),
      ],
    },
    tResultReview: { area: "src/payouts", now: null, library: true, touched: [r("src/payouts/payouts.controller.ts"), r("src/payouts/payout-error.ts"), r("src/result/errors.ts"), r("src/refunds/reversals.ts")] },
    tIdeal: { area: "docs", now: null, library: true, touched: [r("docs/payment-methods.md"), r("src/platform/client.ts")] },

    // ops, ws-dash: 14 dashboards, +96 -140
    tDash: {
      area: "grafana/dashboards", now: null,
      touched: DASHBOARDS.map(function (name, i) {
        return i < 13 ? t("grafana/dashboards/" + name + ".json", 7, 10) : t("grafana/dashboards/" + name + ".json", 5, 10);
      }).concat([r("grafana/legacy/old-checkout.json"), r("grafana/alerts/infra-alerts.yaml")]),
    },
    tDashAlerts: { area: "grafana/alerts", now: null, library: true, touched: [r("grafana/alerts/checkout-alerts.yaml"), r("grafana/alerts/infra-alerts.yaml"), r("grafana/alerts/backup-alerts.yaml")] },
    // ops, ws-secrets: 1 file, +18 -18
    tSecrets: { area: "secrets/staging", now: "secrets/staging/staging.sops.yaml", touched: [t("secrets/staging/staging.sops.yaml", 18, 18), r("secrets/staging/rotate.sh")] },
    tSecretsVerify: { area: "secrets/staging", now: "secrets/staging/services.txt", library: true, touched: [r("secrets/staging/services.txt")] },
    tBun: { area: null, now: null, library: true, touched: [], note: "No project: it read Bun's release notes on the web." },
    aRust: { area: null, now: null, library: true, touched: [] },
    aTables: { area: "backups", now: null, library: true, touched: [r("backups/pg_dump.conf")], note: "Asked ops-db for table sizes." },

    // The swarm.
    sImg: { area: "src/catalog", now: "src/catalog/image-loader.ts", touched: [t("src/catalog/product-image.tsx", 44, 18), t("src/catalog/image-loader.ts", 62, 9), r("styles/catalog.css")] },
    sImgLcp: { area: "src/catalog", now: null, library: true, touched: [r("src/catalog/product-page.tsx")] },
    sApple: { area: "src/checkout", now: "src/checkout/apple-pay.ts", touched: [t("src/checkout/apple-pay.ts", 120, 0), t("src/checkout/checkout-page.tsx", 18, 6), t("src/lib/money.ts", 4, 1), r("src/checkout/payment.ts")] },
    sAppleReview: { area: "src/checkout", now: null, library: true, touched: [r("src/checkout/apple-pay.ts")] },
    sAppleE2e: { area: "e2e", now: null, touched: [t("e2e/apple-pay.spec.ts", 80, 0)] },
    sCoupon: { area: "src/cart", now: "src/cart/coupon.ts", touched: [t("src/cart/coupon.ts", 14, 6), r("src/cart/discounts.ts")] },
    sDe: { area: "src/i18n", now: null, touched: [t("src/i18n/de.json", 212, 40)] },
    sDeTone: { area: "src/i18n", now: null, library: true, touched: [r("src/i18n/de.json")] },
    sSig: { area: "src/webhooks", now: null, touched: [t("src/webhooks/signing.ts", 38, 12), t("db/migrations/0042-webhook-secret.sql", 15, 0)] },
    sSigReview: { area: "src/webhooks", now: null, library: true, touched: [r("src/webhooks/signing.ts"), r("db/migrations/0042-webhook-secret.sql")] },
    sRefunds: { area: "src/refunds", now: null, library: true, touched: [r("src/refunds/refunds.service.ts"), r("src/refunds/reversals.ts")] },
    sRate: { area: "src/platform", now: "src/platform/rate-limit.ts", touched: [t("src/platform/rate-limit.ts", 140, 0), t("src/payouts/payouts.routes.ts", 8, 2)] },
    sRateLoad: { area: "src/platform", now: null, library: true, touched: [] },
    sPg: { area: "postgres", now: "postgres/extensions.sql", touched: [t("postgres/postgresql.conf", 12, 8), t("postgres/extensions.sql", 6, 2), t("postgres/replica.tf", 20, 4), t("postgres/upgrade-18.md", 80, 0)] },
    sPgRollback: { area: "postgres", now: null, library: true, touched: [r("postgres/replica.tf")] },
    sPgExt: { area: "postgres", now: null, library: true, touched: [r("postgres/extensions.sql")] },
    sBackups: { area: "backups", now: "backups/backup.sh", touched: [t("backups/b2-bucket.tf", 34, 6), t("backups/backup.sh", 12, 8)] },
    sDisk: { area: "hosts", now: null, library: true, touched: [r("hosts/build-box-1.yaml"), r("hosts/compose.yaml")] },
    sTalk: { area: null, now: null, library: true, touched: [] },

    // Run sessions that edit (see WORLD.runSessions).
    rWebhookFix: { area: "src/webhooks", now: "src/webhooks/webhook-handler.ts", touched: [t("src/webhooks/retry.ts", 22, 8), t("src/webhooks/webhook-handler.ts", 10, 4)] },
    rRoundingFix: { area: "src/cart", now: "src/cart/totals.ts", touched: [t("src/cart/totals.ts", 9, 3), r("src/cart/discounts.ts")] },
    rBackupInvestigate: { area: "backups", now: "backups/backup.sh", library: true, touched: [r("backups/backup.sh"), r("backups/pg_dump.conf")] },
  };

  /*
   * crossings: two sessions that change the same file of one repository.
   *   kind "overlap"   an Edit Overlap: both unfinished sessions edited the file (GLOSSARY.md); advisory
   *   kind "conflict"  their branches both change it, and a dry-run merge of one into the other
   *                    conflicts (two sessions in different worktrees usually also form an Edit Overlap)
   *   swarm            true for crossings that exist only in the swarm state
   */
  W.crossings = [
    { a: "t3ds", b: "tCart", path: "src/checkout/payment.ts", kind: "conflict", note: "Both change the amount passed to confirmPayment; a dry-run merge of fix/3ds-eu-cards into refactor/cart-totals conflicts at lines 138-146." },
    { a: "tCss", b: "tA11y", path: "src/checkout/card-form.module.css", kind: "overlap", note: "Same main workspace on build-box-1. Audit checkout for screen readers tried a focus-ring fix there and reverted it." },
    { a: "tCart", b: "rRoundingFix", path: "src/cart/totals.ts", kind: "overlap", note: "The run Cart total rounding on discounts fixes the very rounding bug the cart refactor's tests partner found at 09:40." },
    { a: "tResult", b: "rWebhookFix", path: "src/webhooks/webhook-handler.ts", kind: "overlap", note: "The Result migration and the Webhook retry backoff run both edit the handler, from different worktrees." },
    { a: "sCoupon", b: "tCart", path: "src/cart/coupon.ts", kind: "conflict", swarm: true, note: "The coupon fix and the cart refactor rewrite the same stacking rule." },
    { a: "sRate", b: "tResult", path: "src/payouts/payouts.routes.ts", kind: "conflict", swarm: true, note: "The rate limiter wraps the routes the Result migration rewrote." },
    { a: "sApple", b: "tCart", path: "src/lib/money.ts", kind: "overlap", swarm: true, note: "Both change how amounts are formatted: the cart for totals, Apple Pay for its payment sheet." },
  ];

  /* ------------------------------------------------------------------ 6. branches heading for main */

  /*
   * branches[workspaceId], for every workspace with a branch of its own.
   *   branch, lead     the branch and the thread that leads it
   *   ahead, behind    commits ahead of and behind main
   *   stations         what has happened on it, oldest first: { kind, at, label }
   *                    kind: commit | tests | pr | review | ci | merged
   *   ready            true when it could land now
   *   landOrder        its place in the suggested landing order of the everyday morning (null in
   *                    the swarm only); landOrderSwarm is its place when the swarm is in view
   * Tidy checkout CSS works in webshop's main workspace and pushed tidy/checkout-css from there for
   * PR #1281, so that workspace has an entry too.
   */
  function st(kind, at, label) {
    return { kind: kind, at: at, label: label };
  }
  W.branches = {
    "ws-webshop-bb1": { branch: "tidy/checkout-css", lead: "tCss", fromMainWorkspace: true, ahead: 1, behind: 0, stations: [st("commit", "07:34", "Remove 212 unused CSS rules"), st("pr", "07:40", "#1281 open"), st("ci", "07:52", "CI green")], ready: true, landOrder: 1, landOrderSwarm: 1 },
    "ws-3ds": { branch: "fix/3ds-eu-cards", lead: "t3ds", ahead: 2, behind: 0, pushed: false, stations: [st("commit", "09:24", "Reproduce the 3-D Secure failure in a test"), st("commit", "09:27", "Open the 3-D Secure modal on requires_action"), st("tests", "09:28", "24 passed"), st("review", "09:30", "Review started; 1 finding at 09:38")], ready: false, landOrder: 2, landOrderSwarm: 2 },
    "ws-secrets": { branch: "ops/rotate-staging", lead: "tSecrets", ahead: 0, behind: 0, stations: [], ready: false, landOrder: 3, landOrderSwarm: 3 },
    "ws-payout": { branch: "report/payouts-september", lead: "tPayout", ahead: 1, behind: 0, stations: [st("commit", "09:37", "Group payouts by merchant and currency")], ready: false, landOrder: 4, landOrderSwarm: 4 },
    "ws-result": { branch: "rogier/result-types", lead: "tResult", ahead: 9, behind: 3, stations: [st("commit", "09:08", "Migrate payout endpoints to Result types"), st("tests", "09:12", "Contract tests pass"), st("pr", "09:14", "#1287 draft"), st("ci", "09:22", "CI passing"), st("review", "09:31", "3 findings, 1 blocking")], ready: false, landOrder: 5, landOrderSwarm: 7 },
    "ws-cart": { branch: "refactor/cart-totals", lead: "tCart", ahead: 1, behind: 0, stations: [st("commit", "09:29", "Move discount maths into computeTotals"), st("tests", "09:40", "1 property failing")], ready: false, landOrder: 6, landOrderSwarm: 9 },
    "ws-dash": { branch: "ops/grafana-v11", lead: "tDash", ahead: 2, behind: 0, stations: [st("commit", "09:01", "Export the old dashboards"), st("commit", "09:07", "Move 14 dashboards to Grafana 11"), st("review", "09:29", "Alerts: 2 point at removed panels")], ready: false, landOrder: 7, landOrderSwarm: 14 },
    // The swarm's branches.
    "ws-x1": { branch: "perf/product-images", lead: "sImg", ahead: 2, behind: 0, stations: [st("commit", "09:20", "Serve AVIF with a fallback"), st("commit", "09:26", "Resize product images at the edge")], ready: false, landOrder: null, landOrderSwarm: 5 },
    "ws-x9": { branch: "ops/backup-bucket", lead: "sBackups", ahead: 1, behind: 0, stations: [st("commit", "09:24", "Create the new B2 bucket")], ready: false, landOrder: null, landOrderSwarm: 6 },
    "ws-x7": { branch: "feat/payouts-rate-limit", lead: "sRate", ahead: 2, behind: 0, stations: [st("commit", "09:28", "Pick a limit per merchant"), st("commit", "09:36", "Add the rate limiter")], ready: false, landOrder: null, landOrderSwarm: 8 },
    "ws-x3": { branch: "fix/coupon-stacking", lead: "sCoupon", ahead: 0, behind: 0, stations: [], ready: false, landOrder: null, landOrderSwarm: 10 },
    "ws-x2": { branch: "feat/apple-pay", lead: "sApple", ahead: 6, behind: 2, stations: [st("commit", "08:44", "Register the Apple Pay domain"), st("commit", "09:02", "Add the Apple Pay button"), st("review", "09:15", "Domain file served with the wrong content type"), st("commit", "09:24", "Handle the payment sheet")], ready: false, landOrder: null, landOrderSwarm: 11 },
    "ws-x5": { branch: "sec/webhook-secret", lead: "sSig", ahead: 3, behind: 1, stations: [st("commit", "08:58", "Accept two signing secrets"), st("commit", "09:04", "Migration for the new secret"), st("review", "09:22", "Review running; asks to migrate")], ready: false, landOrder: null, landOrderSwarm: 12 },
    "ws-x8": { branch: "ops/postgres-18", lead: "sPg", ahead: 4, behind: 0, stations: [st("commit", "08:31", "Plan the upgrade"), st("commit", "09:07", "Upgrade the replica to 18")], ready: false, landOrder: null, landOrderSwarm: 13 },
    "ws-x4": { branch: "i18n/de-checkout", lead: "sDe", ahead: 1, behind: 14, stations: [st("commit", "Mon 16:38", "Translate the checkout strings"), st("review", "Mon 17:05", "Tone: 9 phrases too formal")], ready: false, landOrder: null, landOrderSwarm: 15 },
  };

  // The suggested landing order, with the one-line reason a design shows beside each branch.
  W.landingOrder = [
    { workspace: "ws-webshop-bb1", reason: "Ready: PR #1281 is open, CI is green, and it crosses no other branch." },
    { workspace: "ws-3ds", reason: "The hotfix EU customers wait on. It crosses refactor/cart-totals at src/checkout/payment.ts, so it lands first and the cart branch rebases. Needs your push and a clean review." },
    { workspace: "ws-secrets", reason: "One file, no crossings. Lands once every staging service reads the new secrets." },
    { workspace: "ws-payout", reason: "New files only. Waits on how refunds are counted." },
    { workspace: "ws-result", reason: "Draft PR #1287 has a blocking finding open, and it shares webhook-handler.ts with the Webhook retry backoff run." },
    { workspace: "ws-cart", reason: "Rebase after the 3-D Secure fix lands; one rounding property still fails." },
    { workspace: "ws-dash", reason: "Waits on the Grafana folder question; 2 alerts still point at removed panels." },
  ];
  W.landingOrderSwarm = [
    { workspace: "ws-webshop-bb1", reason: "Ready, no crossings." },
    { workspace: "ws-3ds", reason: "The hotfix; crosses the cart refactor at payment.ts, so it goes first." },
    { workspace: "ws-secrets", reason: "One file, no crossings." },
    { workspace: "ws-payout", reason: "New files only." },
    { workspace: "ws-x1", reason: "No crossings; waits on the LCP measurement." },
    { workspace: "ws-x9", reason: "No crossings; waits on a restore test." },
    { workspace: "ws-result", reason: "Blocking finding open; shares webhook-handler.ts with a run." },
    { workspace: "ws-x7", reason: "Crosses rogier/result-types at payouts.routes.ts; land after it." },
    { workspace: "ws-cart", reason: "Rebase after the 3-D Secure fix." },
    { workspace: "ws-x3", reason: "Crosses refactor/cart-totals at coupon.ts; land after it." },
    { workspace: "ws-x2", reason: "Shares src/lib/money.ts with the cart refactor; its tests wait on you." },
    { workspace: "ws-x5", reason: "Its review waits on you to run the migration." },
    { workspace: "ws-x8", reason: "Stuck at extensions; the rollback question is open." },
    { workspace: "ws-dash", reason: "Waits on the Grafana folder question." },
    { workspace: "ws-x4", reason: "14 commits behind main since Monday; the tone check is unread." },
  ];

  /* ------------------------------------------------------------------ 7. headlines, last seen, activity */

  /*
   * headlines[id]: one plain sentence per turn that ended this morning, oldest first, written by a
   * Text Generation at the turn's end the way a title is. { at, text, end } where end is "idle" or
   * "request". A turn still running has one more line, { at, text, running: true }, written from its
   * latest report or plan change, which a design may show as "so far".
   */
  function h(at, text, end) {
    return { at: at, text: text, end: end || "idle" };
  }
  function soFar(at, text) {
    return { at: at, text: text, running: true };
  }
  W.headlines = {
    t3ds: [
      h("09:04", "Found the cause: since Stripe SDK v14, 3-D Secure cards return requires_action, and checkout treats it as a decline."),
      h("09:31", "Fix and a failing-first test written; 24 checkout tests pass. Asks to push fix/3ds-eu-cards.", "request"),
    ],
    tStripe: [h("09:21", "Four Stripe v14 changes touch checkout; requires_action for 3-D Secure is the one breaking EU cards.")],
    t3dsReview: [soFar("09:38", "So far: a processing status still shows “Card declined”.")],
    tCart: [soFar("09:40", "So far: discount maths moved into computeTotals; its tests partner found a rounding failure.")],
    tCartTests: [soFar("09:40", "So far: 1 failing property: rounding differs at 3 decimals on stacked discounts.")],
    tCss: [h("07:40", "Removed 212 unused CSS rules from checkout and cart; PR #1281 is open.")],
    tA11y: [h("08:56", "The screen-reader audit found 6 issues, 2 of them on the card form.")],
    tPayout: [soFar("09:37", "So far: 1,284 September payouts grouped by merchant and currency.")],
    tPayoutCheck: [h("09:39", "Stripe's balance transactions are in. Asks whether refunds count by settlement or payout date.", "request")],
    tResult: [
      h("09:14", "Payout endpoints migrated to Result types; draft PR #1287 is open and contract tests pass."),
      soFar("09:41", "So far: fixing the blocking finding on GET /v1/payouts/:id."),
    ],
    tResultReview: [h("09:34", "Review of the Result migration found 3 issues; 1 blocks: PayoutError escapes GET /v1/payouts/:id.")],
    tIdeal: [h("08:41", "Compared 3 ways to offer iDEAL through Stripe; the Payment Element needs the least code.")],
    tDash: [
      h("09:15", "Moved 14 dashboards to Grafana 11 and started a check that every alert still fires."),
      h("09:36", "All alerts fire, but 2 point at removed panels. Asks whether to keep the old Grafana folder.", "request"),
    ],
    tDashAlerts: [h("09:29", "All 31 alert rules fire; 2 point at panels that no longer exist.")],
    tSecrets: [soFar("09:41", "So far: 9 of 14 staging secrets rotated.")],
    tSecretsVerify: [soFar("09:41", "Just started: restarting staging services one at a time.")],
    tBun: [h("06:58", "Summarised the Bun 1.4 release notes; 3 changes affect the webshop's build.")],
    aRust: [h("yesterday 21:41", "Five items in this week's Rust newsletter; the async closures change touches your code.")],
    aTables: [h("09:34", "events is 41 GB on ops-db and grows about 600 MB a night.")],
    // The swarm.
    sImg: [h("09:26", "AVIF images cut the product page's payload from 2.1 MB to 780 KB."), soFar("09:41", "So far: lazy-loading the images below the fold.")],
    sImgLcp: [h("09:26", "LCP on main is 3.4s on a mid-range phone.")],
    sApple: [h("09:02", "Apple Pay domain registered and the button added."), soFar("09:40", "So far: wiring the payment sheet.")],
    sAppleReview: [h("09:15", "The domain association file is served with the wrong content type.")],
    sAppleE2e: [h("09:37", "The payment sheet test is written. Asks whether to use Stripe's test card for Apple Pay.", "request")],
    sCoupon: [soFar("09:37", "So far: reproduced the double discount on sale items.")],
    sDe: [h("Mon 17:30", "Checkout translated into German; waiting on the tone check.")],
    sDeTone: [h("Mon 17:05", "Flagged 9 phrases in the German checkout as too formal for the shop's voice.")],
    sSig: [h("09:20", "Webhooks accept two signing secrets during a rollover; the migration is ready for review.")],
    sSigReview: [h("09:38", "The rotation reads well. Asks to run pnpm db:migrate to test it.", "request")],
    sRefunds: [h("Mon 11:40", "August refunds match Stripe except 3 reversals worth €212.")],
    sRate: [h("09:36", "Payouts API limited to 20 requests a second per merchant; started a load test."), soFar("09:41", "So far: waiting for its load test to get a slot.")],
    sRateLoad: [],
    sPg: [h("08:31", "Upgrade plan written: replica first, then switch over."), soFar("09:07", "So far: the replica runs 18; pg_partman will not build.")],
    sPgRollback: [h("09:34", "Rollback plan written. Asks whether to keep a replica on 17 for a week.", "request")],
    sPgExt: [h("09:02", "pg_partman needs 5.2 for Postgres 18; every other extension works.")],
    sBackups: [soFar("09:24", "So far: the new bucket exists; copying last week's backups.")],
    sDisk: [h("09:40", "Docker images fill /var/lib on build-box-1. Asks to run du -sh to measure them.", "request")],
    sTalk: [h("Sun 21:48", "A 12-slide outline: agents as a crew, not a queue.")],
  };

  // lastSeen[id]: when Rogier last had each thread open this morning (null: never). He has the 3-D
  // Secure lead open now. Partners a lead started are often never opened.
  W.lastSeen = {
    t3ds: "09:41", tStripe: "09:22", t3dsReview: "09:32", tCart: "09:20", tCartTests: null,
    tCss: "07:45", tA11y: "08:50", tPayout: "09:33", tPayoutCheck: null, tResult: "09:15",
    tResultReview: "09:20", tIdeal: "08:45", tDash: "09:10", tDashAlerts: null, tSecrets: "09:31",
    tBun: "07:00", tSecretsVerify: null, aRust: null, aTables: null,
    sImg: "09:10", sImgLcp: null, sApple: "09:05", sAppleReview: null, sAppleE2e: "09:03",
    sCoupon: "09:34", sDe: "Mon 17:31", sDeTone: null, sSig: "09:21", sSigReview: null,
    sRefunds: "Mon 11:45", sRate: "09:16", sRateLoad: null, sPg: "08:32", sPgRollback: "08:33",
    sPgExt: null, sBackups: "09:21", sDisk: null, sTalk: "Sun 21:50",
  };

  // The away reading: Rogier left at 09:01 for the school run and is back at 09:41. In it, nothing
  // was opened after 09:01, and threads started after 09:01 were never seen.
  var AWAY_LEFT = "09:01";
  var awaySeen = {};
  Object.keys(W.lastSeen).forEach(function (id) {
    var seen = W.lastSeen[id];
    awaySeen[id] = seen != null && minutes(seen) <= minutes(AWAY_LEFT) ? seen : null;
  });
  // Opened just before he left: the dashboards migration (started 08:58) and the Result migration.
  awaySeen.tDash = "09:00";
  awaySeen.tResult = "08:58";

  // activity[id]: what a busy session is doing right now, in 2-4 words, from its latest tool call.
  W.activity = {
    t3dsReview: "running checkout status tests",
    tCart: "editing totals.ts",
    tCartTests: "shrinking the failing case",
    tPayout: "writing the payout CSV",
    tResult: "editing payouts.controller.ts",
    tSecrets: "rotating secret 10 of 14",
    tSecretsVerify: "restarting staging services",
    sImg: "editing image-loader.ts",
    sApple: "wiring the payment sheet",
    sCoupon: "editing coupon.ts",
    sRate: "waiting for a load test",
    sPg: "building pg_partman for 18",
    sBackups: "copying last week's backups",
    rWebhookFix: "editing webhook-handler.ts",
    rRoundingFix: "editing totals.ts",
    rBackupInvestigate: "reading backup job logs",
    rJonasDraft: "drafting the reply",
  };

  /* ------------------------------------------------------------------ 8. the morning's turns */

  /*
   * turns[id]: when each session worked this morning, oldest first, for replays and timelines.
   *   from, to   when the agent started and stopped working; to is null while it still works
   *   end        "idle" (the turn ended), "request" (it stopped on a Request and waits on Rogier),
   *              "failed", or null while it still works
   * A queued session has no turns yet.
   */
  function span(from, to, end) {
    return { from: from, to: to, end: to == null ? null : end || "idle" };
  }
  W.turns = {
    t3ds: [span("09:02", "09:04"), span("09:21", "09:31", "request")],
    tStripe: [span("09:05", "09:21")],
    t3dsReview: [span("09:30", null)],
    tCart: [span("09:19", null)],
    tCartTests: [span("09:24", null)],
    tCss: [span("07:12", "07:40")],
    tA11y: [span("08:40", "08:56")],
    tPayout: [span("09:32", null)],
    tPayoutCheck: [span("09:35", "09:39", "request")],
    tResult: [span("08:48", "09:14"), span("09:31", null)],
    tResultReview: [span("09:10", "09:34")],
    tIdeal: [span("08:30", "08:41")],
    tDash: [span("08:58", "09:15"), span("09:29", "09:36", "request")],
    tDashAlerts: [span("09:14", "09:29")],
    tSecrets: [span("09:30", null)],
    tSecretsVerify: [span("09:41", null)],
    tBun: [span("06:50", "06:58")],
    aRust: [span("yesterday 21:30", "yesterday 21:41")],
    aTables: [span("09:31", "09:34")],
    sImg: [span("09:08", "09:26"), span("09:27", null)],
    sImgLcp: [span("09:12", "09:26")],
    sApple: [span("08:20", "09:02"), span("09:24", null)],
    sAppleReview: [span("08:51", "09:15")],
    sAppleE2e: [span("09:02", "09:18"), span("09:20", "09:37", "request")],
    sCoupon: [span("09:33", null)],
    sDe: [span("Mon 16:02", "Mon 16:38"), span("Mon 17:10", "Mon 17:30")],
    sDeTone: [span("Mon 16:40", "Mon 17:05")],
    sSig: [span("08:44", "09:20")],
    sSigReview: [span("09:05", "09:20"), span("09:22", "09:38", "request")],
    sRefunds: [span("Mon 10:12", "Mon 11:40")],
    sRate: [span("09:15", null)],
    sRateLoad: [],
    sPg: [span("08:05", "08:31"), span("08:40", null)],
    sPgRollback: [span("08:31", "09:05"), span("09:20", "09:34", "request")],
    sPgExt: [span("08:40", "09:02")],
    sBackups: [span("09:20", null)],
    sDisk: [span("09:36", "09:40", "request")],
    sTalk: [span("Sun 21:10", "Sun 21:48")],
    rShip: [span("09:12", "09:33", "request")],
    rWebhookFix: [span("09:38", null)],
    rRoundingFix: [span("09:27", null)],
    rBackupInvestigate: [span("09:35", null)],
    rJonasDraft: [span("09:40", null)],
  };

  // resultUnread[id]: true when a turn ended after Rogier last had the thread open, so it holds a
  // result he has not read. A turn that stopped on a Request is not a result; it waits on him.
  function unreadFrom(seenMap) {
    var out = {};
    Object.keys(W.turns).forEach(function (id) {
      if (!(id in seenMap)) return;
      var ended = W.turns[id].filter(function (s) {
        return s.end === "idle" || s.end === "failed";
      });
      var last = ended[ended.length - 1];
      var seen = seenMap[id];
      out[id] = !!last && (seen == null || minutes(last.to) > minutes(seen));
    });
    return out;
  }
  W.resultUnread = unreadFrom(W.lastSeen);
  W.away = { left: AWAY_LEFT, back: W.now, lastSeen: awaySeen, resultUnread: unreadFrom(awaySeen) };

  /* ------------------------------------------------------------------ 9. runs */

  /*
   * The runs of the morning, as CONTENT.md lists them. Run.status is pending | running | completed |
   * failed | cancelled; "paused" below is how the book draws a running run held by a Bound.
   *   origin   who started it: "user", "trigger: <what>", or "assistant:<name>"
   *   steps    { id, label, state, sessionId? }; state: completed | running | waiting | paused | pending
   * The sessions of its agent steps are in runSessions, keyed by session id. rShip is world.js's
   * WAITING_RUNS entry: the publish step's session.
   */
  W.runs = [
    {
      id: "runShip", workflow: "Ship release", title: "Ship release v2.15", project: "payments-api", machine: "build-box-2",
      status: "running", origin: "user", started: "09:05", waitingAsk: "Publish payments-api 2.15.0 to npm?",
      steps: [
        { id: "changelog", label: "Write the changelog", state: "completed" },
        { id: "build", label: "Build and test", state: "completed" },
        { id: "publish", label: "Publish to npm", state: "waiting", sessionId: "rShip" },
        { id: "announce", label: "Announce the release", state: "pending" },
      ],
    },
    {
      id: "runWebhook", workflow: "Fix bug", title: "Webhook retry backoff", project: "payments-api", machine: "build-box-1",
      status: "running", origin: "user", started: "09:20",
      steps: [
        { id: "reproduce", label: "Reproduce", state: "completed" },
        { id: "fix", label: "Write the fix", state: "running", sessionId: "rWebhookFix" },
        { id: "test", label: "Test", state: "pending" },
        { id: "pr", label: "Open a PR", state: "pending" },
      ],
    },
    {
      id: "runRounding", workflow: "Fix bug", title: "Cart total rounding on discounts", project: "webshop", machine: "build-box-1",
      status: "running", origin: "user", started: "09:25", task: "Cart total rounding on discounts",
      steps: [
        { id: "reproduce", label: "Reproduce", state: "completed" },
        { id: "fix", label: "Write the fix", state: "running", sessionId: "rRoundingFix" },
        { id: "test", label: "Test", state: "pending" },
        { id: "pr", label: "Open a PR", state: "pending" },
      ],
    },
    {
      id: "runBackup", workflow: "Investigate", title: "Investigate backup timeouts", project: "ops", machine: "build-box-1",
      status: "running", origin: "assistant:Milo", started: "09:35",
      steps: [
        { id: "investigate", label: "Investigate", state: "running", sessionId: "rBackupInvestigate" },
        { id: "report", label: "Report", state: "pending" },
      ],
    },
    {
      id: "runLabel", workflow: "Label new issues", title: "Label new issues", project: "webshop", machine: "build-box-1",
      status: "paused", origin: "trigger: GitHub issue opened", started: "08:00",
      pausedReason: "The Spawn Bound (20 per hour) tripped at 08:14 after a bot opened 34 issues; 34 events are held.",
      steps: [{ id: "label", label: "Label the issue", state: "paused" }],
    },
    {
      id: "runJonas", workflow: "Draft reply", title: "Draft reply to Jonas at Kiteworks", project: "payments-api", machine: "build-box-2",
      status: "running", origin: "trigger: Gmail", started: "09:40",
      steps: [
        { id: "draft", label: "Draft the reply", state: "running", sessionId: "rJonasDraft" },
        { id: "send", label: "Send it", state: "pending" },
      ],
    },
    {
      id: "runNightly", workflow: "Nightly backup check", title: "Nightly backup check", project: "ops", machine: "build-box-1",
      status: "completed", origin: "trigger: Cron", started: "04:30", ended: "04:33", next: "tomorrow 04:30",
      result: "The backup job hit its 2h limit at 04:00 for the third night in a row. Posted to Slack #ops.",
      steps: [
        { id: "check", label: "Check last night's backup", state: "completed" },
        { id: "post", label: "Post to Slack #ops", state: "completed" },
      ],
    },
  ];

  // The sessions of the runs' agent steps. A step session's title is "<run> · <step>".
  W.runSessions = {
    rShip: { title: "Ship release v2.15 · publish", run: "runShip", step: "publish", project: "payments-api", provider: "claude", model: "Sonnet 5", machine: "build-box-2", pose: "waiting", started: "09:12", last: "09:33", ask: "Publish payments-api 2.15.0 to npm?" },
    rWebhookFix: { title: "Webhook retry backoff · fix", run: "runWebhook", step: "fix", project: "payments-api", provider: "claude", model: "Opus 5.5", machine: "build-box-1", pose: "working", started: "09:38", last: "09:41" },
    rRoundingFix: { title: "Cart total rounding on discounts · fix", run: "runRounding", step: "fix", project: "webshop", provider: "claude", model: "Sonnet 5", machine: "build-box-1", pose: "working", started: "09:27", last: "09:41" },
    rBackupInvestigate: { title: "Investigate backup timeouts · investigate", run: "runBackup", step: "investigate", project: "ops", provider: "codex", model: "gpt-5.4", machine: "build-box-1", pose: "working", started: "09:35", last: "09:41" },
    rJonasDraft: { title: "Draft reply to Jonas at Kiteworks · draft", run: "runJonas", step: "draft", project: "payments-api", provider: "claude", model: "Haiku 4.5", machine: "build-box-2", pose: "working", started: "09:40", last: "09:41" },
  };
  Object.keys(W.runSessions).forEach(function (id) {
    W.startedBy[id] = "run:" + W.runSessions[id].run;
  });

  /* ------------------------------------------------------------------ 10. token usage */

  // usage[id]: { tokens } over the session's life (GLOSSARY.md: Token Usage; never call it cost).
  // Codex reports no usage, so its sessions are null: show "not reported", never a number.
  var TOKENS = {
    t3ds: 1420000, tStripe: 312000, tCart: 980000, tCss: 210000, tA11y: 640000, tPayoutCheck: 188000,
    tResult: 3100000, tDash: 760000, tDashAlerts: 154000, tSecrets: 402000, tBun: 96000, aRust: 124000,
    sImg: 690000, sApple: 2400000, sAppleE2e: 520000, sCoupon: 140000, sDe: 880000, sDeTone: 210000,
    sSigReview: 610000, sRate: 450000, sPg: 2900000, sPgExt: 230000, sBackups: 330000, sTalk: 560000,
    rShip: 340000, rWebhookFix: 160000, rRoundingFix: 520000, rJonasDraft: 18000,
  };
  W.usage = {};
  function stampUsage(id, provider) {
    W.usage[id] = provider === "codex" ? null : { tokens: TOKENS[id] || 0 };
  }
  W.threads.concat(W.assistantThreads, [W.spawn.thread], W.swarm.threads).forEach(function (th) {
    stampUsage(th.id, th.provider);
  });
  Object.keys(W.runSessions).forEach(function (id) {
    stampUsage(id, W.runSessions[id].provider);
  });

  /* ------------------------------------------------------------------ 11. helpers */

  // Returns every live thread: the morning's 16 and the assistants' 2, plus the spawn state's
  // partner with { spawn: true } and the swarm's 19 with { swarm: true }.
  function allLive(opts) {
    opts = opts || {};
    var list = W.threads.concat(W.assistantThreads);
    if (opts.spawn) list = list.concat([W.spawn.thread]);
    if (opts.swarm) list = list.concat(W.swarm.threads);
    return list;
  }

  // Returns the thread with this id from any list (morning, assistants, spawn, swarm, stress), or null.
  function thread(id) {
    var lists = [W.threads, W.assistantThreads, [W.spawn.thread], W.swarm.threads, W.stress.threads];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) if (lists[i][j].id === id) return lists[i][j];
    }
    return null;
  }

  // Returns the thread or the run session with this id, or null.
  function session(id) {
    var th = thread(id);
    if (th || !W.runSessions[id]) return th;
    var rs = { id: id, kind: "run" };
    for (var k in W.runSessions[id]) rs[k] = W.runSessions[id][k];
    return rs;
  }

  // Returns the id of the lead of a thread: its lead's id for a partner, its own id otherwise.
  function leadOf(id) {
    var th = thread(id);
    return th && th.lead ? th.lead : id;
  }

  // Returns the lead and its partners, lead first, among the threads allLive(opts) returns.
  function teamOf(leadId, opts) {
    var lead = thread(leadId);
    if (!lead) return [];
    return [lead].concat(
      allLive(opts).filter(function (th) {
        return th.lead === leadId;
      })
    );
  }

  W.helpers = { minutes: minutes, ago: ago, allLive: allLive, thread: thread, session: session, leadOf: leadOf, teamOf: teamOf };
})();
