// PROTOTYPE - what Atlas reads that ../shared/world-plus.js does not hold.
//
// Load after ../../sidebar-directions/shared/world.js and ../shared/world-plus.js. Nothing here
// changes a fact of the shared world; it only adds what a transit map needs to be drawn:
//   - a short name for every station a branch already has (WORLD.branches[ws].stations), the way
//     a Text Generation would write one, so a station label fits on the map;
//   - the route still to go on each line: where its train stands now and the stations ahead of it,
//     taken from the thread's goal (WORLD.goals) and kept to the checks Hercule can observe;
//   - the two runs whose steps edit code (Cart total rounding, Webhook retry backoff), drawn as
//     lines of their own because they cross a branch;
//   - the answers each Request offers, so the selection card and the lists can answer it.
(function () {
  "use strict";

  var W = window.WORLD;
  if (!W || !W.branches) throw new Error("atlas-data.js: load world.js and world-plus.js first");

  /*
   * routes[workspace id or run id]:
   *   names     short names for the line's built stations, in the order WORLD.branches holds them
   *   train     where the lead stands now: { at, waiting } when it waits on Rogier at a station of
   *             its route, { note } for a word under the train, or null (it works toward the next one)
   *   ahead     the stations still to come before main, in order. A string, or { label, waiting }
   *             where waiting names the thread that waits on Rogier there.
   */
  var ROUTES = {
    // ---------------------------------------------------------------- the morning
    "ws-webshop-bb1": { names: ["212 rules gone", "#1281 open", "CI green"], train: { note: "Ready to land" }, ahead: [] },
    "ws-3ds": { names: ["Failing test", "requires_action", "24 passed", "Review: 1 finding"], train: { at: "Push", waiting: true }, ahead: ["Review clean", "PR open", "CI green"] },
    "ws-cart": { names: ["computeTotals", "1 property fails"], train: null, ahead: ["Properties pass", "Cart tests pass", "PR open", "CI green"] },
    "ws-payout": { names: ["By merchant"], train: null, ahead: [{ label: "Totals checked", waiting: "tPayoutCheck" }, "PR open"] },
    "ws-result": { names: ["Result types", "Contract tests", "#1287 draft", "CI passing", "Blocking finding"], train: null, ahead: ["Review clean"] },
    "ws-secrets": { names: [], train: null, ahead: ["Services check", "Old ones revoked", "PR open"] },
    "ws-dash": { names: ["Exported", "14 moved", "2 alerts broken"], train: { at: "Folder decision", waiting: true }, ahead: ["Re-point alerts", "Alerts fire", "PR open"] },

    // ---------------------------------------------------------------- the swarm
    "ws-x1": { names: ["AVIF fallback", "Edge resize"], train: null, ahead: ["LCP under 2.5s", "PR open", "CI green"] },
    "ws-x9": { names: ["New B2 bucket"], train: null, ahead: ["Job re-pointed", "Restore test", "PR open"] },
    "ws-x7": { names: ["Limit per merchant", "Rate limiter"], train: { note: "Waits for its load test" }, ahead: ["Load test passes", "PR open", "CI green"] },
    "ws-x3": { names: [], train: null, ahead: ["Cart tests pass", "PR open", "CI green"] },
    "ws-x2": { names: ["Domain", "Button", "Content type", "Payment sheet"], train: null, ahead: [{ label: "E2E tests pass", waiting: "sAppleE2e" }, "Review clean", "PR open"] },
    "ws-x5": { names: ["Two secrets", "Migration", "Review"], train: null, ahead: [{ label: "Review clean", waiting: "sSigReview" }, "PR open"] },
    "ws-x8": { names: ["Upgrade plan", "Replica on 18"], train: { note: "No progress in 34m" }, ahead: ["Extensions build", "Switch over", { label: "Rollback tested", waiting: "sPgRollback" }] },
    "ws-x4": { names: ["German strings", "Tone: 9 too formal"], train: null, ahead: ["Tone fixed", "PR open"] },

    // ---------------------------------------------------------------- runs that edit code
    runRounding: { names: ["Reproduce"], train: null, ahead: ["Test", "Open a PR"] },
    runWebhook: { names: ["Reproduce"], train: null, ahead: ["Test", "Open a PR"] },
  };

  // Which station kinds count as a failure on the map. A blocking finding stops a branch the way a
  // failing test does, so both are drawn in the failure ink.
  var FAILING = {
    "ws-cart": [1],
    "ws-result": [4],
    "ws-dash": [2],
    "ws-x2": [2],
  };

  // The runs drawn as lines: a run whose step edits code works in a worktree of its own, and its
  // steps are its stations. Their sessions are in WORLD.runSessions.
  var RUN_LINES = [
    { run: "runRounding", session: "rRoundingFix", project: "webshop" },
    { run: "runWebhook", session: "rWebhookFix", project: "payments-api" },
  ];

  /*
   * answers[id]: the buttons a waiting session's Request offers, as the book draws them. The first
   * button with `accent` is the one suggested answer; `danger` destroys; `quiet` declines.
   * `done` is the toast's sentence once it is answered.
   */
  var ANSWERS = {
    t3ds: [{ label: "Allow once", accent: true, done: "Allowed git push" }, { label: "Deny", quiet: true, done: "Denied git push" }],
    tPayoutCheck: [{ label: "Settlement date", done: "Answered: settlement date" }, { label: "Payout date", done: "Answered: payout date" }],
    tDash: [{ label: "Keep", accent: true, done: "Kept the old Grafana folder" }, { label: "Delete", danger: true, done: "Deleted the old Grafana folder" }],
    rShip: [{ label: "Allow once", accent: true, done: "Allowed the npm publish" }, { label: "Deny", quiet: true, done: "Denied the npm publish" }],
    sAppleE2e: [{ label: "Use the test card", done: "Answered: use the test card" }, { label: "Ask me later", quiet: true, done: "Asked to wait" }],
    sSigReview: [{ label: "Allow once", accent: true, done: "Allowed pnpm db:migrate" }, { label: "Deny", quiet: true, done: "Denied pnpm db:migrate" }],
    sPgRollback: [{ label: "Keep a replica", done: "Answered: keep a replica on 17" }, { label: "No replica", done: "Answered: no replica" }],
    sDisk: [{ label: "Allow once", accent: true, done: "Allowed du -sh" }, { label: "Deny", quiet: true, done: "Denied du -sh" }],
  };

  // The land state: "Land in this order" merges the one branch that is ready now, at 09:42.
  var LAND = { at: "09:42", workspace: "ws-webshop-bb1", pr: 1281 };

  window.ATLAS = { routes: ROUTES, failing: FAILING, runLines: RUN_LINES, answers: ANSWERS, land: LAND };
})();
