// PROTOTYPE - what Expedition reads on top of the shared morning (world.js and world-plus.js).
//
// world-plus.js already holds each thread's goal: its summit, its camps, its stage and when it
// entered it. This file adds the few facts only Expedition draws:
//   summitEta     when each goal should reach its summit, as a range (a prediction, never a time)
//   movedBy       the signal that moved each goal into the stage it is in now (the Board's cards)
//   stageHistory  when each goal entered each stage this morning (the Board's cumulative flow)
//   answers       the answer buttons of every Request that waits on Rogier
//   stories       the plain-language explanations of the stuck route and the route that grew
//   runRoutes     a run's steps read as camps: a run's route is its workflow
//
// Load it after world-plus.js. It reads WORLD and adds WORLD.expedition; it changes nothing else.
(function () {
  "use strict";

  var W = window.WORLD;
  if (!W || !W.goals) throw new Error("expedition-data.js: load world.js and world-plus.js first");

  /*
   * summitEta[id]: when a lead's goal should reach its summit, in minutes from 09:41, as a range.
   *   range   [lo, hi], or null when no honest guess exists
   *   after   what the clock waits on before it starts: "your answer", "a merge", or null
   *   basis   what the guess rests on, in a few words (shown on hover)
   * Landed goals have no entry: they show when they landed.
   */
  function eta(range, after, basis, short) {
    return { range: range, after: after || null, basis: basis, short: short || null };
  }
  var summitEta = {
    t3ds: eta([25, 45], "your answer", "after the push: the review ends in ~4-9m, a PR, CI takes ~8m, then a merge"),
    tCart: eta([70, 120], null, "6 camps left; its camps take ~15-25m each"),
    tCss: eta(null, "a merge", "PR #1281 is ready: CI went green at 07:52 and nobody has merged it", "ready since 07:52"),
    tPayout: eta([20, 35], "your answer", "the check partner waits on how refunds count; then ~8m a camp"),
    tResult: eta([35, 60], null, "the fix ~20m, a re-review ~10m, then a merge"),
    tDash: eta([45, 80], "your answer", "2 alerts to re-point, a check that every alert fires, a PR"),
    tSecrets: eta([35, 55], null, "5 secrets left at ~2m each, then verify, revoke and a PR"),
    // The swarm.
    sImg: eta([40, 70], null, "lazy-loading, then an LCP check and a PR"),
    sApple: eta([90, 150], null, "4 camps left; end-to-end tests wait on you"),
    sCoupon: eta([50, 90], null, "camp 2 of 6"),
    sDe: eta(null, "a nudge", "idle since Monday 17:30; the tone check is unread", "idle since Monday"),
    sSig: eta([30, 60], "your answer", "its review waits on you to run the migration"),
    sRate: eta([60, 100], null, "the load test waits for a slot on build-box-1"),
    sPg: eta(null, null, "no camp reached in 34m: no honest guess", "no camp in 34m"),
    sBackups: eta([45, 75], null, "7 backups to copy at ~3m each, then a restore test"),
    sDisk: eta([10, 25], "your answer", "one measurement, then a cleanup proposal"),
  };

  /*
   * movedBy[id]: the signal that moved a lead's goal into its current stage, in a few words a Board
   * card has room for. Hercule sees each of these itself (a tool call, a partner starting, a PR
   * event); nobody drags a card. "review started" means a review partner started.
   */
  function moved(signal, at) {
    return { signal: signal, at: at };
  }
  var movedBy = {
    t3ds: moved("review started", "09:30"),
    tCart: moved("first edit", "09:23"),
    tCss: moved("PR #1281 opened", "07:40"),
    tA11y: moved("report delivered", "08:56"),
    tPayout: moved("check started", "09:35"),
    tResult: moved("review started", "09:10"),
    tIdeal: moved("question answered", "08:41"),
    tDash: moved("alert check started", "09:14"),
    tSecrets: moved("first edit", "09:31"),
    tBun: moved("question answered", "06:58"),
    // The swarm.
    sImg: moved("first edit", "09:20"),
    sApple: moved("first end-to-end test", "09:02"),
    sCoupon: moved("first edit", "09:37"),
    sDe: moved("tone check started", "Mon 16:40"),
    sSig: moved("review started", "09:05"),
    sRefunds: moved("report delivered", "Mon 11:40"),
    sRate: moved("load test queued", "09:39"),
    sPg: moved("first edit", "08:40"),
    sBackups: moved("first edit", "09:24"),
    sDisk: moved("Milo started it", "09:36"),
    sTalk: moved("outline written", "Sun 21:48"),
  };

  /*
   * stageHistory[id]: [stage, at] pairs, oldest first, for every lead goal. The last pair agrees
   * with the goal's stage and stageSince in world-plus.js. A question or a report goes from
   * Scoping straight to Landed: it never builds, proves or ships.
   */
  var stageHistory = {
    tBun: [["scoping", "06:50"], ["landed", "06:58"]],
    tCss: [["scoping", "07:12"], ["building", "07:20"], ["proving", "07:34"], ["shipping", "07:40"]],
    tIdeal: [["scoping", "08:30"], ["landed", "08:41"]],
    tA11y: [["scoping", "08:40"], ["landed", "08:56"]],
    tResult: [["scoping", "08:48"], ["building", "08:55"], ["proving", "09:08"], ["reviewing", "09:10"]],
    tDash: [["scoping", "08:58"], ["building", "09:01"], ["proving", "09:14"]],
    t3ds: [["scoping", "09:02"], ["building", "09:22"], ["proving", "09:24"], ["reviewing", "09:30"]],
    tCart: [["scoping", "09:19"], ["building", "09:23"]],
    tSecrets: [["scoping", "09:30"], ["building", "09:31"]],
    tPayout: [["scoping", "09:32"], ["building", "09:34"], ["reviewing", "09:35"]],
    // The swarm.
    sTalk: [["landed", "Sun 21:48"]],
    sRefunds: [["landed", "Mon 11:40"]],
    sDe: [["reviewing", "Mon 16:40"]],
    sPg: [["scoping", "08:05"], ["building", "08:40"]],
    sApple: [["scoping", "08:20"], ["building", "08:44"], ["proving", "09:02"]],
    sSig: [["scoping", "08:44"], ["building", "08:58"], ["reviewing", "09:05"]],
    sImg: [["scoping", "09:08"], ["building", "09:20"]],
    sRate: [["scoping", "09:15"], ["building", "09:28"], ["proving", "09:39"]],
    sBackups: [["scoping", "09:20"], ["building", "09:24"]],
    sCoupon: [["scoping", "09:33"], ["building", "09:37"]],
    sDisk: [["scoping", "09:36"]],
  };

  /*
   * answers[id]: the buttons of a Request that waits on Rogier, in order. kind is "accent" (the one
   * suggested answer), "plain", "danger" or "quiet". `did` is the toast's words once it is
   * answered. A question with no suggestion has no accent button.
   */
  function a(label, kind, did) {
    return { label: label, kind: kind, did: did };
  }
  var answers = {
    t3ds: [a("Allow once", "accent", "Allowed git push"), a("Allow always", "plain", "Allowed git push for this thread"), a("Deny", "quiet", "Denied git push")],
    tPayoutCheck: [a("Settlement date", "plain", "Answered: by settlement date"), a("Payout date", "plain", "Answered: by payout date")],
    tDash: [a("Keep", "accent", "Answered: keep the old folder"), a("Delete", "danger", "Answered: delete the old folder")],
    rShip: [a("Allow once", "accent", "Allowed the npm publish"), a("Deny", "quiet", "Denied the npm publish")],
    sAppleE2e: [a("Use it", "accent", "Answered: use Stripe's test card"), a("No", "plain", "Answered: no")],
    sSigReview: [a("Allow once", "accent", "Allowed pnpm db:migrate"), a("Deny", "quiet", "Denied pnpm db:migrate")],
    sPgRollback: [a("Keep a replica", "plain", "Answered: keep a replica on 17"), a("Don't keep one", "plain", "Answered: no replica on 17")],
    sDisk: [a("Allow once", "accent", "Allowed du -sh"), a("Deny", "quiet", "Denied du -sh")],
  };

  /*
   * stories: the two routes a design explains in words.
   *   stuck   why "Migrate ops dashboards" has reached no camp in 34 minutes, oldest first
   *   grew    why "Migrate payout endpoints to Result types" grew 2 camps at 09:31
   */
  var stories = {
    stuck: {
      id: "tDash",
      lastCamp: { label: "Move 14 dashboards to Grafana 11", at: "09:07" },
      since: [
        { at: "09:14", text: "Started a partner to check that every alert still fires." },
        { at: "09:29", text: "The partner reported: all 31 fire, 2 point at removed panels." },
        { at: "09:36", text: "Asked you whether to keep the old Grafana folder." },
      ],
      unblock: "Answer the folder question: the next camp, re-pointing the 2 alerts, depends on it.",
    },
    grew: {
      id: "tResult",
      at: "09:31",
      cause: "The adversarial review found 3 issues, 1 blocking: PayoutError escapes GET /v1/payouts/:id.",
      added: ["Fix the blocking finding", "Review clean"],
      before: { done: 6, total: 7 },
      after: { done: 6, total: 9 },
    },
  };

  /*
   * The move state: "Refactor cart totals" runs its first test, and the Board moves its card from
   * Building to Proving by itself. What changes, applied by expedition.js when the state plays.
   */
  var move = {
    id: "tCart",
    to: "proving",
    camp: 1, // "Move discount maths into computeTotals" is reached
    signal: "first test run",
    cmd: "pnpm test cart",
  };

  /*
   * runRoutes: a run's route is its workflow. Each step is a camp; a step a person must allow
   * waits on Rogier. Built from WORLD.runs, so the run's own data stays the one source.
   */
  // A paused step is held by a Bound, not by a question to Rogier, so it is not a flag.
  var STEP_STATE = { completed: "done", running: "current", waiting: "waiting", paused: "current", pending: "todo" };
  var runRoutes = {};
  W.runs.forEach(function (run) {
    runRoutes[run.id] = {
      summit: run.status === "completed" ? "Finished" : run.steps[run.steps.length - 1].label,
      camps: run.steps.map(function (s) {
        return { label: s.label, state: STEP_STATE[s.state], observed: true };
      }),
      stage: null,
      // A run's steps are watched by the engine, not by a plan: a run is never called stuck here.
      lastProgress: null,
      grew: 0,
    };
  });

  W.expedition = {
    stages: [
      { id: "scoping", name: "Scoping", enters: "a thread starts" },
      { id: "building", name: "Building", enters: "its first edit" },
      { id: "proving", name: "Proving", enters: "its first test run or check" },
      { id: "reviewing", name: "Reviewing", enters: "a review or check partner starts" },
      { id: "shipping", name: "Shipping", enters: "a PR opens" },
      { id: "landed", name: "Landed", enters: "it reaches its summit" },
    ],
    summitEta: summitEta,
    movedBy: movedBy,
    stageHistory: stageHistory,
    answers: answers,
    stories: stories,
    move: move,
    runRoutes: runRoutes,
    // A route that has reached no camp for this long, while its thread is not idle, is stuck.
    stuckAfter: 30,
  };
})();
