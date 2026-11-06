// PROTOTYPE - the invented Northwind Market world, on top of ../work-views/data.js.
// Every name, company and number here is made up.
//
// A card needs words the lo-fi never had: a summary short enough to read at a glance. A real
// build gets them from the summary writer (a cheap model call after a turn ends). Here they are
// written by hand, one per Task, along with who holds the Task right now.
//
//   now    what the summary writer would say: where it stands, in a few plain words.
//   agent  the thread working on it now. The Task shows that colleague's face.
//   person the person the next move sits with, when it is not you.
window.NW = (function () {
  "use strict";

  var ENRICH = {
    "flake-report": { now: "Posted three weeks running." },
    "dep-bumps": { now: "Merged twice, no trouble." },
    "contrast-audit": { now: "All nine colours pass." },
    "gift-receipt": { now: "Support contacts have stopped." },
    "route-order": { now: "On 6% of routes in week one." },
    "sched-inventory": { now: "41 jobs, 11 with no owner." },
    "sched-retries": { now: "Two drafts to choose from." },
    "sched-cutover": { now: "Clean on staging five nights." },
    "sched-dashboards": { now: "Rough board, no alert yet." },
    "flake-quarantine": { now: "Six small PRs, one per test." },
    "flake-clock": { now: "Order tests half done.", agent: "Fake the clock in order tests" },
    "flake-seeds": { now: "Drafted, not wired in." },
    "flake-parallel": { now: "Eleven minutes, fixtures collide." },
    "flake-browser": { now: "Four of twelve sleeps replaced.", agent: "Replace sleeps in browser tests", move: "agent", need: "look" },
    "cost-logs": { now: "Debug logs are 60% of the bill." },
    "secrets-rotation": { now: "14 tokens over a year old." },
    "oncall-runbook": { now: "Seven of ten written." },
    "staging-data": { now: "Orders done, support notes not." },
    "price-rounding": { now: "A penny apart on 2% of baskets." },
    "price-rules-tests": { now: "Eleven baskets differ." },
    "cart-focus": { now: "Works with two screen readers." },
    "search-synonyms": { now: "200 pairs, no way to edit." },
    "search-latency": { now: "The first image is the slow part." },
    "coupons-stack": { now: "Marketing yes, finance maybe." },
    "substitutions": { now: "Three designs, depots worried." },
    "slot-rush": { now: "Cache in review." },
    "image-sizes": { now: "Half resized, then paused." },
    "guest-checkout": { now: "Returns have no plan yet." },
    "basket-restore": { now: "One question left on the PR." },
    "depot-labels": { now: "Printers in two of five depots." },
    "offline-proof": { now: "One proof in forty is lost." },
    "rv-6204": { now: "Asked by Juno Park", person: "Juno Park" },
    "rv-6209": { now: "Asked by Felix Marsh", person: "Felix Marsh" },
    "rv-6213": { now: "Asked again by Felix Marsh", person: "Felix Marsh" },
    "rv-6238": { now: "Asked by Ines Carvalho", person: "Ines Carvalho" },
    "rv-6241": { now: "Asked by Theo Brandt", person: "Theo Brandt" },
    "rv-6252": { now: "Asked by Wren Adeyemi", person: "Wren Adeyemi" },
    "rv-6255": { now: "Asked by Juno Park", person: "Juno Park" },
    "rv-6257": { now: "Asked by Kofi Mensah", person: "Kofi Mensah" },
    "rv-6258": { now: "Asked by Tessa Lindqvist", person: "Tessa Lindqvist" },
    "rv-6260": { now: "Asked by Ines Carvalho", person: "Ines Carvalho" },
    "rv-6263": { now: "Asked by Kofi Mensah", person: "Kofi Mensah" },
    "rv-6266": { now: "Asked by Wren Adeyemi", person: "Wren Adeyemi" },
    "pr-multibuy": { now: "Checks failing on #6118.", agent: "Fix the checks on the multi-buy PR", move: "agent", need: "look" },
    "pr-weighed": { now: "Waiting for a review.", person: "Omar Haddad" },
    "pr-breakdown": { now: "Waiting for a review.", person: "Tessa Lindqvist" },
    "pr-qty-labels": { now: "Approved. Ready to merge." },
    "pr-lazy-photos": { now: "Waiting for a review.", person: "Felix Marsh" },
    "pr-font": { now: "Waiting for a review.", person: "Juno Park" },
    "pr-address-form": { now: "Two changes requested." },
    "pr-report-runner": { now: "Checks failing on #3318.", agent: "Fix the checks on the export PR", move: "agent", need: "look" },
    "pr-fake-clock": { now: "Waiting for a review.", person: "Kofi Mensah" },
    "pr-gateway-debug": { now: "Checks failing on #3299." },
    "pr-rollup": { now: "Waiting for a review.", person: "Ines Carvalho" },
    "mn-6088": { now: "You were tagged in a comment." },
    "mn-6126": { now: "You were tagged in a comment." },
    "mn-6079": { now: "Merged since you were tagged." },
    "t-crate-scan": { now: "Written, not started." },
    "t-label-queue": { now: "Not started." },
    "t-depot-refund": { now: "Not started." },
    "t-return-reason": { now: "Not started." },
    "t-browser-retry": { now: "Written, not started." },
    "t-focus-trap": { now: "Written, not started." },
    "t-typos": { now: "Written, not started." },
    "t-cancelled": { now: "Not started." },
    "renew-cert": { now: "With the vendor.", person: "the vendor" },
    "load-test": { now: "Two dates are free." },
    "old-exports": { now: "Breaks monthly." },
    "search-feed-errors": { now: "Tracing the bad records.", agent: "Trace the search feed errors", move: "agent", need: "look" },
  };

  // The project names as a person says them, with the tint each one takes from the book.
  var PROJECTS = [
    { id: "storefront", name: "Storefront", tint: "webshop" },
    { id: "platform", name: "Platform", tint: "payments" },
    { id: "ops", name: "Depot ops", tint: "ops" },
    { id: "field-app", name: "Field app", tint: "ops" },
    { id: "Insights", name: "Insights", tint: "payments" },
  ];

  var STAGES = [
    { id: "exploring", name: "Exploring" },
    { id: "planned", name: "Planned" },
    { id: "building", name: "Building" },
    { id: "reviewing", name: "In review" },
    { id: "landed", name: "Landed" },
  ];

  var TODAY = Date.parse("2026-11-05");

  /** Returns the number of whole days between a date string and the world's today. */
  function daysSince(date) {
    return Math.max(0, Math.round((TODAY - Date.parse(date)) / 864e5));
  }

  /** Returns a Task's age in the shortest honest words: 4h, 3d, 2w. */
  function formatAge(days) {
    if (days < 1) return "today";
    if (days < 14) return days + "d";
    return Math.round(days / 7) + "w";
  }

  // Answers written for the cards a reader is most likely to open. Others show no answers.
  var ANSWERS = {
    substitutions: ["Riverside depot", "Northgate depot", "Not yet"],
    "basket-restore": ["Highest quantity", "Add them together"],
    "price-rounding": ["Round per line", "Round per basket"],
    "sched-cutover": ["Approve for Monday", "Wait a week"],
    "slot-rush": ["Five minutes is fine", "Keep it shorter"],
    "image-sizes": ["Keep the originals", "Drop after a month"],
    "search-latency": ["Drop images first", "Shrink them"],
    "guest-checkout": ["An email link is enough", "Ask for an account"],
    "flake-quarantine": ["Merge together", "One at a time"],
    "coupons-stack": ["Bring both sides together", "Decide it myself"],
    "cost-logs": ["30 days", "90 days", "Ask legal"],
  };

  /** Returns a fresh copy of every Task, with its summary and holder merged in. */
  function buildTasks() {
    return WORK.map(function (w) {
      var e = ENRICH[w.id] || {};
      var t = Object.assign({}, w, e);
      t.options = ANSWERS[w.id] || [];
      t.age = daysSince(w.lastActivityAt);
      t.ref = (/#\d+/.exec(w.where) || [""])[0];
      if (w.kind === "review" || w.kind === "mention") t.ref = "#" + w.id.split("-")[1];
      t.source = w.kind === "ticket" ? "linear" : w.kind === "errors" ? "sentry" : w.kind === "pr" || w.kind === "review" || w.kind === "mention" ? "github" : "";
      return t;
    });
  }

  // The reviews handed to the review workflow: a stream of the same work, each with its own thread.
  var REVIEWER = "Review workflow";
  var HANDED = ["rv-6238", "rv-6241", "rv-6252", "rv-6255", "rv-6257", "rv-6258", "rv-6260", "rv-6263", "rv-6266"];

  /** Returns today's world: every Task of the lo-fi, with its links and holders. */
  function buildToday() {
    var tasks = buildTasks();
    var byId = {};
    tasks.forEach(function (t) { byId[t.id] = t; });
    HANDED.forEach(function (id) {
      byId[id].agent = REVIEWER + " " + id;
      byId[id].move = "agent";
      byId[id].need = "look";
    });
    RELATIONS.forEach(function (r) {
      if (r.kind !== "blockedBy" || !byId[r.from] || !byId[r.to]) return;
      byId[r.from].blockedBy = (byId[r.from].blockedBy || []).concat([r.to]);
    });
    return {
      projects: PROJECTS.slice(),
      plans: INITIATIVES.map(function (i) { return Object.assign({}, i); }),
      tasks: tasks,
      folded: { "field-app": true, Insights: true },
      openPlans: {},
    };
  }

  return { PROJECTS: PROJECTS, STAGES: STAGES, buildTasks: buildTasks, buildToday: buildToday, formatAge: formatAge };
})();
