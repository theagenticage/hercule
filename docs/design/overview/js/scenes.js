// PROTOTYPE - the worlds the desk can be drawn with: every state a person meets. Each one is
// invented. ?scene= picks one; the Prototype tray switches between them.
window.Scenes = (function () {
  "use strict";

  /* ---------- 300 cards: five times today's volume ---------- */

  var MORE_PROJECTS = [
    { id: "loyalty", name: "Loyalty", tint: "payments" },
    { id: "warehouse", name: "Warehouse", tint: "ops" },
    { id: "payments", name: "Payments", tint: "payments" },
    { id: "marketing", name: "Marketing site", tint: "webshop" },
    { id: "data", name: "Data", tint: "ops" },
  ];
  var VERBS = ["Move", "Retire", "Tidy", "Speed up", "Rewrite", "Check", "Split", "Trim", "Fix", "Document", "Simplify", "Add tests for", "Measure", "Replace", "Audit"];
  var THINGS = ["the stock sync", "points expiry", "picking routes", "the refund queue", "voucher codes", "the nightly export", "order emails", "shelf labels", "the returns form", "the tax rules", "delivery windows", "the banner tool", "price alerts", "the supplier feed", "crate tracking", "the wishlist", "card tokens", "the sales report", "slot capacity", "the search index"];
  var NOWS = ["Draft ready for a look.", "Half done.", "Waiting on staging.", "One question left.", "Plan agreed.", "Checks green.", "Two options on the table.", "Blocked a while, moving again.", "First pass merged.", "Numbers look fine so far."];
  var MORE_PLANS = [
    ["points", "loyalty", "Points that never expire by surprise", 5, 14], ["wms", "warehouse", "One picking system", 9, 20], ["tokens", "payments", "Card tokens everywhere", 12, 15],
    ["consent", "marketing", "Consent that holds up", 3, 8], ["lake", "data", "Reports from one source", 7, 19], ["stock", "warehouse", "Live stock on the shelf page", 2, 11], ["fraud", "payments", "Fewer false fraud flags", 6, 9], ["launch", "marketing", "Spring sale pages", 4, 12],
  ];

  function pick(list, seed) { return list[seed % list.length]; }

  /** Returns a world of about 300 Tasks across ten projects and fourteen plans. */
  function buildMany() {
    var w = NW.buildToday();
    w.projects = w.projects.concat(MORE_PROJECTS);
    MORE_PLANS.forEach(function (p) { w.plans.push({ id: p[0], name: p[2], project: p[1], intent: "", done: p[3], total: p[4] }); });
    var stages = ["exploring", "exploring", "planned", "planned", "planned", "building", "reviewing", "reviewing", "reviewing", "landed", "landed"];
    var projects = ["storefront", "platform", "ops", "field-app", "Insights"].concat(MORE_PROJECTS.map(function (p) { return p.id; }));
    for (var i = 0; w.tasks.length < 300; i++) {
      var h = Crew.hash("t" + i);
      var project = projects[(h >>> 3) % projects.length];
      var plans = w.plans.filter(function (p) { return p.project === project; });
      var inPlan = plans.length && h % 3 === 0;
      var stage = pick(stages, h >>> 7);
      var mine = (h >>> 11) % 5 < 2;
      var agent = !mine && (h >>> 13) % 3 === 0;
      var kinds = ["thread", "thread", "pr", "pr", "ticket", "review"];
      var kind = pick(kinds, h >>> 15);
      w.tasks.push({
        id: "m" + i, name: pick(VERBS, h >>> 17) + " " + pick(THINGS, h >>> 21), project: project, initiative: inPlan ? pick(plans, h >>> 5).id : "",
        stage: stage, move: stage === "landed" ? "nobody" : mine ? "you" : agent ? "agent" : "others", need: mine ? ((h >>> 23) % 3 === 0 ? "think" : "quick") : "look",
        now: pick(NOWS, h >>> 9), where: pick(NOWS, h >>> 9), left: "", ask: mine ? "Good to go?" : "", kind: kind, source: kind === "ticket" ? "linear" : kind === "thread" ? "" : "github",
        ref: "", age: (h >>> 25) % 30, stalled: mine && (h >>> 25) % 30 > 16, agent: agent ? "Agent " + i : "", person: !mine && !agent ? pick(["Juno Park", "Felix Marsh", "Omar Haddad", "Tessa Lindqvist"], h >>> 19) : "",
        threads: [], links: [], options: [], context: [], blockedBy: [],
      });
    }
    w.folded = {};
    return w;
  }

  /* ---------- A few Tasks, or none ---------- */

  function buildEmptyWorld() {
    return { projects: [{ id: "storefront", name: "Storefront", tint: "webshop" }], plans: [], tasks: [] };
  }

  function buildOne() {
    var w = buildEmptyWorld();
    var t = NW.buildToday().tasks.filter(function (x) { return x.id === "search-latency"; })[0];
    t.initiative = "";
    t.project = "storefront";
    w.tasks = [t];
    return w;
  }

  /* ---------- Awkward data ---------- */

  function buildAwkward() {
    var w = NW.buildToday();
    w.plans = [];
    w.tasks.forEach(function (t) { t.initiative = ""; });
    w.projects.push({ id: "", name: "No project", tint: "none" });
    w.tasks[6].name = "Make the old invoice export run on the new job runner without losing the month-end totals that finance reads by hand every first Monday";
    w.tasks[6].project = "";
    w.tasks[6].stage = "exploring";
    w.tasks[6].now = "";
    w.tasks[6].summaryPending = true;
    w.tasks[7].project = "";
    w.tasks[7].stage = "building";
    w.tasks[8].project = "";
    w.tasks[8].stage = "planned";
    w.tasks[8].age = 412;
    var pile = w.tasks.filter(function (t) { return t.project === "storefront" && t.kind === "review"; });
    for (var i = 0; i < 1190; i++) {
      w.tasks.push(Object.assign({}, pile[i % pile.length], { id: "bulk" + i, age: i % 20 }));
    }
    return w;
  }

  /* ---------- The morning ---------- */

  // What happened since the person last looked. The replay starts from `was` and plays forward.
  var OVERNIGHT = [
    { kind: "move", id: "slot-rush", from: "reviewing", to: "landed", note: "PR #6221 merged", apply: function (t) { t.move = "nobody"; t.person = ""; t.now = "Merged last night."; t.where = "The cache merged last night as #6221. Slot lookups dropped at the noon peak."; t.ask = ""; t.links = t.links.map(function (l) { return /^PR /.test(l.label) ? { label: "PR #6221", url: l.url, state: "merged" } : l; }); } },
    { kind: "arrive", task: { id: "refund-currency", name: "Refund emails show the wrong currency", project: "storefront", initiative: "", stage: "exploring", move: "agent", need: "look", agent: "Find why refund emails use the wrong currency", now: "From a support ticket.", where: "A thread started last night from a support ticket. It is tracing where the currency is set.", left: "Find the cause", ask: "", kind: "thread", source: "", ref: "", age: 0, stalled: false, person: "", options: [], context: [], links: [], threads: [{ title: "Find why refund emails use the wrong currency", id: "a1" }] } },
    { kind: "move", id: "pr-fake-clock", from: "reviewing", to: "landed", note: "PR #3331 merged", apply: function (t) { t.move = "nobody"; t.person = ""; t.now = "Merged last night."; } },
  ];

  return {
    build: function (name) {
      if (name === "many") return buildMany();
      if (name === "first" || name === "empty") return buildEmptyWorld();
      if (name === "one") return buildOne();
      if (name === "awkward") return buildAwkward();
      return NW.buildToday();
    },
    OVERNIGHT: OVERNIGHT,
  };
})();
