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
    "flake-report": { now: "Posted three weeks running. The team reads it." },
    "dep-bumps": { now: "Merged twice without trouble." },
    "contrast-audit": { now: "All nine badge colours pass." },
    "gift-receipt": { now: "Support contacts have stopped." },
    "route-order": { now: "Used on 6% of routes in week one." },
    "sched-inventory": { now: "41 jobs found. 11 have no owner." },
    "sched-retries": { now: "Two drafts. Back off, or give up and page." },
    "sched-cutover": { now: "Clean on staging five nights running." },
    "sched-dashboards": { now: "Rough board on staging, no alert yet." },
    "flake-quarantine": { now: "Six small PRs, one per test." },
    "flake-clock": { now: "Order tests half done.", agent: "Fake the clock in order tests" },
    "flake-seeds": { now: "Drafted, not wired in. Two suites left." },
    "flake-parallel": { now: "Eleven minutes, but fixtures collide." },
    "flake-browser": { now: "Four of twelve sleeps replaced.", agent: "Replace sleeps in browser tests", move: "agent", need: "look" },
    "cost-logs": { now: "Gateway debug logs are 60% of the bill." },
    "secrets-rotation": { now: "14 tokens over a year old." },
    "oncall-runbook": { now: "Seven of ten written." },
    "staging-data": { now: "Covers orders, not support notes." },
    "price-rounding": { now: "Shop and finance differ by a penny." },
    "price-rules-tests": { now: "Eleven baskets differ from the old engine." },
    "cart-focus": { now: "Works with two screen readers." },
    "search-synonyms": { now: "200 pairs ready, no way to edit them." },
    "search-latency": { now: "The first image is the slow part." },
    "coupons-stack": { now: "Marketing says yes, finance says only above a minimum." },
    "substitutions": { now: "Three designs. Depots worry about time." },
    "slot-rush": { now: "Cache in review. Lookups were 70% of load." },
    "image-sizes": { now: "Half the range resized, then paused." },
    "guest-checkout": { now: "Wanted for spring. Returns have no plan." },
    "basket-restore": { now: "One question left on the PR." },
    "depot-labels": { now: "Printers in two of five depots." },
    "offline-proof": { now: "One proof in forty lost on rural routes." },
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
    "pr-weighed": { now: "With Omar Haddad for review.", person: "Omar Haddad" },
    "pr-breakdown": { now: "With Tessa Lindqvist for review.", person: "Tessa Lindqvist" },
    "pr-qty-labels": { now: "Approved. Ready to merge." },
    "pr-lazy-photos": { now: "With Felix Marsh for review.", person: "Felix Marsh" },
    "pr-font": { now: "With Juno Park for review.", person: "Juno Park" },
    "pr-address-form": { now: "Two changes requested." },
    "pr-report-runner": { now: "Checks failing on #3318.", agent: "Fix the checks on the export PR", move: "agent", need: "look" },
    "pr-fake-clock": { now: "With Kofi Mensah for review.", person: "Kofi Mensah" },
    "pr-gateway-debug": { now: "Checks failing on #3299." },
    "pr-rollup": { now: "With Ines Carvalho for review.", person: "Ines Carvalho" },
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
    "renew-cert": { now: "With the vendor. Nothing to do until the file arrives.", person: "the vendor" },
    "load-test": { now: "Two dates are free." },
    "old-exports": { now: "Breaks monthly. Replacing takes a week." },
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

  /** Returns a fresh copy of every Task, with its summary and holder merged in. */
  function buildTasks() {
    return WORK.map(function (w) {
      var e = ENRICH[w.id] || {};
      var t = Object.assign({}, w, e);
      t.age = daysSince(w.lastActivityAt);
      t.ref = (/#\d+/.exec(w.where) || [""])[0];
      if (w.kind === "review" || w.kind === "mention") t.ref = "#" + w.id.split("-")[1];
      t.source = w.kind === "ticket" ? "linear" : w.kind === "errors" ? "sentry" : w.kind === "pr" || w.kind === "review" || w.kind === "mention" ? "github" : "";
      return t;
    });
  }

  return { PROJECTS: PROJECTS, STAGES: STAGES, buildTasks: buildTasks, formatAge: formatAge };
})();
