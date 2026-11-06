// PROTOTYPE - outside things and how they relate, as plugins would report them. Every name is made
// up. Nothing outside this file knows what any source is called: a kind declares its own words.
//
// Two relations, and both are claims with someone behind them:
//   part-of  child to parent. A thing can have many parents, so this is a graph, not a ladder.
//   linked   peers across sources. A confirmed link comes from the source or a person. A reference
//            found in text is only a hint: it is shown as one, and it never groups anything.
window.Graph = (function () {
  "use strict";

  var SOURCES = { linear: "Linear", github: "GitHub", sentry: "Sentry" };

  // What a plugin declares about a kind. `group` names it in Group by and Filter. `leads` says a
  // thing of this kind sits on top when confirmed links group Tasks. `listBy` makes it a heading in
  // Add to Work. `stages` is where a new Task starts, by the state the source reports.
  var KINDS = {
    "linear/issue": { source: "linear", word: "Issue", leads: true, stages: { Backlog: "exploring", Todo: "planned", "In progress": "building", "In review": "reviewing" } },
    "linear/project": { source: "linear", word: "Project", group: "Linear project", listBy: true },
    "linear/initiative": { source: "linear", word: "Initiative", group: "Linear initiative" },
    "linear/team": { source: "linear", word: "Team", group: "Linear team" },
    "linear/milestone": { source: "linear", word: "Milestone", caption: "Linear milestone" },
    "github/pull": { source: "github", word: "Pull request", stages: { Open: "reviewing", Draft: "building" } },
    "github/repo": { source: "github", word: "Repository", plural: "repositories", group: "GitHub repository", listBy: true },
    "sentry/issue": { source: "sentry", word: "Issue", stages: { Unresolved: "exploring" } },
    "sentry/project": { source: "sentry", word: "Project", group: "Sentry project", listBy: true },
  };

  var entities = {};
  var claims = [];

  function define(ref, kind, title, more) {
    entities[ref] = Object.assign(entities[ref] || {}, { ref: ref, kind: kind, title: title }, more || {});
    return entities[ref];
  }

  function claim(from, relation, to, claimant, evidence) {
    claims.push({ from: from, relation: relation, to: to, claimant: claimant, evidence: evidence || "source" });
  }

  function partOf(child, parents, claimant) {
    parents.forEach(function (p) { claim(child, "part-of", p, claimant); });
  }

  /* ---------- What the sources know around the work ---------- */

  [["web", "Web"], ["plt", "Platform"], ["dep", "Depots"]].forEach(function (t) { define("team/" + t[0], "linear/team", t[1]); });
  define("init/baskets", "linear/initiative", "Bigger baskets", { state: "Active" });
  define("init/depots", "linear/initiative", "Depots run themselves", { state: "Active" });
  define("init/reliable", "linear/initiative", "Nothing breaks at peak", { state: "Active" });
  // Progress is here only where the source reports it. Nothing is ever worked out from what you can see.
  define("proj/checkout", "linear/project", "Checkout that converts", { state: "In progress", progress: [14, 31] });
  define("proj/basket", "linear/project", "Basket rebuild", { state: "In progress", progress: [9, 22] });
  define("proj/pricing", "linear/project", "Pricing rules", { state: "In progress" });
  define("proj/speed", "linear/project", "Pages under a second", { state: "In progress", progress: [6, 14] });
  define("proj/returns", "linear/project", "Returns at the depots", { state: "Planned", progress: [3, 19] });
  define("proj/field", "linear/project", "Field app offline", {});
  define("proj/scheduler", "linear/project", "Job scheduler retirement", { state: "In progress", progress: [7, 12] });
  define("proj/reliability", "linear/project", "Build reliability", { state: "In progress" });
  define("ms/returns-beta", "linear/milestone", "Beta at two depots", { state: "Next" });
  partOf("proj/checkout", ["init/baskets", "team/web"], "Linear");
  partOf("proj/basket", ["init/baskets", "team/web"], "Linear");
  partOf("proj/pricing", ["init/baskets", "team/web"], "Linear");
  partOf("proj/speed", ["init/reliable", "team/web"], "Linear");
  partOf("proj/returns", ["init/depots", "team/dep"], "Linear");
  partOf("proj/field", ["init/depots", "team/dep"], "Linear");
  partOf("proj/scheduler", ["init/reliable", "team/plt"], "Linear");
  partOf("proj/reliability", ["init/reliable", "team/plt"], "Linear");
  partOf("ms/returns-beta", ["proj/returns"], "Linear");
  [["storefront-web", "storefront"], ["platform-core", "platform"], ["insights-jobs", "Insights"], ["depot-apps", "ops"]].forEach(function (r) {
    define("repo/" + r[0], "github/repo", r[0], { project: r[1] });
  });
  define("sentry/storefront", "sentry/project", "storefront", { state: "Live" });
  define("sentry/search-feed", "sentry/project", "search-feed", { state: "Live" });

  var REPO_OF = { storefront: "repo/storefront-web", platform: "repo/platform-core", Insights: "repo/insights-jobs", ops: "repo/depot-apps", "field-app": "repo/depot-apps" };

  // Which Tasks carry an issue, and what the issue says it is part of. Some sit in two projects.
  var ISSUES = {
    substitutions: ["WEB-214", "team/web", "proj/basket"], "coupons-stack": ["WEB-198", "team/web", "proj/pricing", "proj/checkout"], "guest-checkout": ["WEB-220", "team/web", "proj/checkout"],
    "t-cancelled": ["WEB-236", "team/web", "proj/checkout", "proj/returns"], "image-sizes": ["WEB-205", "team/web", "proj/speed"], "price-rounding": ["WEB-171", "team/web", "proj/pricing"],
    "price-rules-tests": ["WEB-172", "team/web", "proj/pricing"], "basket-restore": ["WEB-188", "team/web", "proj/basket"], "t-focus-trap": ["WEB-240", "team/web", "proj/checkout"],
    "cart-focus": ["WEB-239", "team/web", "proj/checkout"], "search-latency": ["WEB-251", "team/web", "proj/speed"], "t-typos": ["WEB-255", "team/web"], "search-synonyms": ["WEB-256", "team/web"],
    "t-faster-checkout": ["WEB-262", "team/web", "proj/speed", "proj/checkout"],
    "sched-inventory": ["PLT-301", "team/plt", "proj/scheduler"], "sched-retries": ["PLT-302", "team/plt", "proj/scheduler"], "sched-dashboards": ["PLT-304", "team/plt", "proj/scheduler"],
    "sched-cutover": ["PLT-305", "team/plt", "proj/scheduler"], "load-test": ["PLT-311", "team/plt"], "cost-logs": ["PLT-322", "team/plt"], "t-quiet-gateway": ["PLT-325", "team/plt", "proj/reliability"],
    "secrets-rotation": ["PLT-330", "team/plt"], "staging-data": ["PLT-333", "team/plt"], "oncall-runbook": ["PLT-340", "team/plt", "proj/reliability"],
    "flake-seeds": ["PLT-352", "team/plt", "proj/reliability"], "flake-parallel": ["PLT-353", "team/plt", "proj/reliability"], "flake-quarantine": ["PLT-354", "team/plt", "proj/reliability"], "t-browser-retry": ["PLT-361", "team/plt", "proj/reliability"],
    "t-crate-scan": ["DEP-41", "team/dep", "proj/returns", "ms/returns-beta"], "t-label-queue": ["DEP-42", "team/dep", "proj/returns", "ms/returns-beta"], "t-depot-refund": ["DEP-43", "team/dep", "proj/returns"],
    "t-return-reason": ["DEP-44", "team/dep", "proj/returns"], "depot-labels": ["DEP-39", "team/dep", "proj/returns"], "offline-proof": ["DEP-52", "team/dep", "proj/field"],
  };
  var ISSUE_STATE = { exploring: "Backlog", planned: "Todo", building: "In progress", reviewing: "In review", landed: "Done" };

  /** Works out the outside things a Task is explicitly linked to, and records them. */
  function attach(t) {
    var refs = [];
    if ((t.kind === "pr" || t.kind === "review" || t.kind === "mention") && t.ref) {
      var repo = REPO_OF[t.project] || "repo/storefront-web";
      var pull = "pull/" + repo.slice(5) + t.ref;
      define(pull, "github/pull", t.name, { label: t.ref, state: t.stage === "landed" ? "Merged" : "Open" });
      if (!claims.some(function (c) { return c.from === pull; })) partOf(pull, [repo], "GitHub");
      refs.push(pull);
    }
    var issue = ISSUES[t.id];
    if (issue) {
      var key = "issue/" + issue[0];
      define(key, "linear/issue", t.name, { label: issue[0], state: ISSUE_STATE[t.stage] });
      if (!claims.some(function (c) { return c.from === key; })) partOf(key, issue.slice(1), "Linear");
      refs.push(key);
    }
    if (t.kind === "errors") {
      define("sentry/SEARCH-71", "sentry/issue", t.name, { label: "SEARCH-71", state: "Unresolved" });
      if (!claims.some(function (c) { return c.from === "sentry/SEARCH-71"; })) partOf("sentry/SEARCH-71", ["sentry/search-feed"], "Sentry");
      refs.push("sentry/SEARCH-71");
    }
    t.entities = refs;
    t.source = refs.length ? KINDS[entities[refs[refs.length - 1]].kind].source : "";
    return t;
  }

  /** Records the links between things, once the Tasks that carry them exist. */
  function linkPeers() {
    if (claims.some(function (c) { return c.relation === "linked"; })) return;
    claim("issue/WEB-262", "linked", "pull/storefront-web#6162", "Linear");
    claim("issue/WEB-262", "linked", "pull/storefront-web#6135", "Linear");
    claim("issue/PLT-325", "linked", "pull/platform-core#3299", "Noa", "person");
    claim("issue/WEB-256", "linked", "sentry/SEARCH-71", "Sentry");
    // A reference found in text: a hint, never a reason to group.
    claim("pull/storefront-web#6118", "linked", "issue/PLT-301", "GitHub", "text");
    claim("issue/WEB-205", "linked", "pull/storefront-web#6135", "GitHub", "text");
    // Something you cannot open. Its title was never read, so it is never shown.
    define("hidden/1", "sentry/issue", "", { access: "restricted" });
    claim("issue/WEB-205", "linked", "hidden/1", "Linear");
    define("hidden/2", "linear/issue", "", { access: "restricted" });
    claim("issue/DEP-39", "linked", "hidden/2", "Linear");
  }

  /* ---------- Things with no Task yet: what Add to Work offers ---------- */

  [
    ["WEB-268", "Basket badge does not update after undo", "Todo", "storefront", ["team/web", "proj/basket"]],
    ["WEB-274", "Show the delivery cut-off time in the basket", "Todo", "storefront", ["team/web", "proj/basket"]],
    ["WEB-271", "Promo code field loses focus on an error", "Backlog", "storefront", ["team/web", "proj/checkout"]],
    ["WEB-283", "Remember the last delivery address", "In progress", "storefront", ["team/web", "proj/checkout"]],
    ["WEB-277", "Compress hero images on the sale pages", "In progress", "storefront", ["team/web", "proj/speed"]],
    ["WEB-279", "Multi-buy label wraps on small phones", "Todo", "storefront", ["team/web", "proj/pricing", "proj/basket"]],
    ["DEP-58", "Label printer queue stalls on Mondays", "In progress", "ops", ["team/dep", "proj/returns", "ms/returns-beta"]],
    ["DEP-61", "Refund note for damaged returns", "Todo", "ops", ["team/dep", "proj/returns"]],
    ["DEP-63", "Scan crates while offline", "Backlog", "ops", ["team/dep", "proj/returns", "proj/field"]],
    ["PLT-371", "Pause jobs during a deploy", "Todo", "platform", ["team/plt", "proj/scheduler"]],
    ["PLT-374", "Quarantined tests expire after two weeks", "Todo", "platform", ["team/plt", "proj/reliability"]],
  ].forEach(function (i) {
    var ref = "issue/" + i[0];
    define(ref, "linear/issue", i[1], { label: i[0], state: i[2], project: i[3], offered: true });
    partOf(ref, i[4], "Linear");
  });
  [
    ["storefront-web", "#6271", "Bump the image proxy", "Open", "storefront"],
    ["storefront-web", "#6274", "Fix the delivery slot time zone", "Draft", "storefront"],
    ["platform-core", "#3342", "Retry the nightly export once", "Open", "platform"],
    ["depot-apps", "#812", "Crate scanner beeps twice", "Open", "ops"],
  ].forEach(function (p) {
    var ref = "pull/" + p[0] + p[1];
    define(ref, "github/pull", p[2], { label: p[1], state: p[3], project: p[4], offered: true });
    partOf(ref, ["repo/" + p[0]], "GitHub");
  });
  [
    ["SF-1182", "TypeError in the address finder", "sentry/storefront", "storefront"],
    ["SF-1190", "Timeout on the payment callback", "sentry/storefront", "storefront"],
    ["SEARCH-77", "Feed record has no brand", "sentry/search-feed", "storefront"],
  ].forEach(function (s) {
    var ref = "sentry/" + s[0];
    define(ref, "sentry/issue", s[1], { label: s[0], state: "Unresolved", project: s[3], offered: true });
    partOf(ref, [s[2]], "Sentry");
  });

  /* ---------- What only the source knows ---------- */

  // Things Hercule has never seen. A real plugin finds these by asking the source. They become
  // records here only when someone adds one.
  define("proj/gifts", "linear/project", "Gift cards", { state: "In progress", progress: [2, 9] });
  partOf("proj/gifts", ["init/baskets", "team/web"], "Linear");
  var UNSEEN = [
    ["issue/WEB-301", "linear/issue", "WEB-301", "Gift message is cut off at 140 characters", "Backlog", "storefront", ["team/web", "proj/gifts"]],
    ["issue/WEB-302", "linear/issue", "WEB-302", "Gift wrap option on the basket page", "Todo", "storefront", ["team/web", "proj/gifts", "proj/basket"]],
    ["issue/WEB-305", "linear/issue", "WEB-305", "Basket total flickers on a slow connection", "In progress", "storefront", ["team/web", "proj/basket"]],
    ["issue/WEB-309", "linear/issue", "WEB-309", "Delivery slot picker skips Sundays", "Todo", "storefront", ["team/web", "proj/checkout"]],
    ["issue/DEP-70", "linear/issue", "DEP-70", "Refund note prints twice", "Todo", "ops", ["team/dep", "proj/returns"]],
    ["issue/PLT-380", "linear/issue", "PLT-380", "Scheduler drops jobs at the clock change", "Backlog", "platform", ["team/plt", "proj/scheduler"]],
    ["pull/storefront-web#6290", "github/pull", "#6290", "Remove the old gift card banner", "Open", "storefront", ["repo/storefront-web"]],
    ["pull/platform-core#3351", "github/pull", "#3351", "Retry webhook delivery twice", "Open", "platform", ["repo/platform-core"]],
    ["sentry/SF-1204", "sentry/issue", "SF-1204", "Basket total is NaN after undo", "Unresolved", "storefront", ["sentry/storefront"]],
    ["sentry/SF-1211", "sentry/issue", "SF-1211", "Gift card page times out", "Unresolved", "storefront", ["sentry/storefront"]],
  ].map(function (u) { return { ref: u[0], kind: u[1], label: u[2], title: u[3], state: u[4], project: u[5], parents: u[6] }; });

  // Things that exist but that this Connection may not read. Their titles are never known here.
  var LOCKED = { "issue/FIN-12": "linear/issue", "pull/finance-core#77": "github/pull" };

  // The links each plugin recognises. Recognising fetches nothing. Only a link works from anywhere:
  // a bare identifier means nothing until you say which source it is from.
  var LINKS = [
    { form: /linear\.example\/northwind\/issue\/([A-Z]+-\d+)/i, source: "linear", ref: function (m) { return "issue/" + m[1].toUpperCase(); } },
    { form: /github\.example\/northwind\/([\w-]+)\/pull\/(\d+)/i, source: "github", ref: function (m) { return "pull/" + m[1] + "#" + m[2]; } },
    { form: /sentry\.example\/northwind\/issues\/([A-Z]+-\d+)/i, source: "sentry", ref: function (m) { return "sentry/" + m[1].toUpperCase(); } },
  ];

  /** Works out which source a pasted link belongs to. Returns its source and ref, or null. */
  function recognizeLink(text) {
    for (var i = 0; i < LINKS.length; i++) {
      var m = LINKS[i].form.exec(text);
      if (m) return { source: LINKS[i].source, ref: LINKS[i].ref(m) };
    }
    return null;
  }

  function readKnownItem(ref) {
    var e = entities[ref];
    return { ref: ref, kind: e.kind, label: e.label, title: e.title, state: e.state, project: e.project, parents: readParents(ref), known: true };
  }

  /** Asks a source what it says about one thing. Returns the thing, `{ locked: kind }`, or null. */
  function readFromSource(ref) {
    if (LOCKED[ref]) return { locked: LOCKED[ref] };
    if (entities[ref] && KINDS[entities[ref].kind].stages && entities[ref].access !== "restricted") return readKnownItem(ref);
    return UNSEEN.filter(function (u) { return u.ref === ref; })[0] || null;
  }

  /** Asks a source for what matches these words, by title or identifier, whether or not Hercule has seen it. */
  function searchSource(source, words) {
    var needle = words.toLowerCase();
    var known = Object.keys(entities).filter(function (r) {
      return KINDS[entities[r].kind].source === source && KINDS[entities[r].kind].stages && entities[r].access !== "restricted";
    }).map(readKnownItem);
    var unseen = UNSEEN.filter(function (u) { return KINDS[u.kind].source === source && !entities[u.ref]; });
    return known.concat(unseen).filter(function (i) { return (i.label + " " + i.title).toLowerCase().indexOf(needle) >= 0; });
  }

  /** Records a thing Hercule had not seen. You did not get it through a concern, so it is one you follow. */
  function follow(item) {
    if (entities[item.ref]) return;
    define(item.ref, item.kind, item.title, { label: item.label, state: item.state, project: item.project, concern: "following" });
    partOf(item.ref, item.parents, SOURCES[KINDS[item.kind].source]);
  }

  /** Checks whether a thing from a source sits anywhere under one of its contexts. */
  function isUnder(item, ref) {
    return item.parents.indexOf(ref) >= 0 || readAncestors(item.parents).indexOf(ref) >= 0;
  }

  /** Lists the contexts of a source that can narrow a search, by kind and then by title. */
  function listContexts(source) {
    return Object.keys(entities).filter(function (r) {
      return KINDS[entities[r].kind].source === source && KINDS[entities[r].kind].group;
    }).sort(function (a, b) {
      return entities[a].kind.localeCompare(entities[b].kind) || entities[a].title.localeCompare(entities[b].title);
    });
  }

  /* ---------- Reading the graph ---------- */

  function entity(ref) { return entities[ref]; }

  function kindOf(ref) { return KINDS[entities[ref].kind]; }

  function sourceOf(ref) { return kindOf(ref).source; }

  /** Lists the direct parents of a thing, from every claim that names one. */
  function readParents(ref) {
    return claims.filter(function (c) { return c.relation === "part-of" && c.from === ref; }).map(function (c) { return c.to; });
  }

  /**
   * Lists every ancestor of a set of things, each once, nearest first. It follows part-of upward
   * only: a peer's ancestors are not yours.
   */
  function readAncestors(refs) {
    var seen = {};
    var out = [];
    var queue = refs.slice();
    while (queue.length) {
      readParents(queue.shift()).forEach(function (p) {
        if (seen[p]) return;
        seen[p] = true;
        out.push(p);
        queue.push(p);
      });
    }
    return out;
  }

  /** Lists a Task's ancestors of one kind. A Task can have several, and every one of them counts. */
  function readAncestorsOfKind(t, kind) {
    return readAncestors(t.entities || []).filter(function (r) { return entities[r].kind === kind; });
  }

  /** Lists the kinds that can group or filter these Tasks, in a stable order. */
  function listGroupKinds(tasks) {
    var present = {};
    tasks.forEach(function (t) {
      readAncestors(t.entities || []).forEach(function (r) { present[entities[r].kind] = true; });
    });
    return Object.keys(KINDS).filter(function (k) { return KINDS[k].group && present[k]; }).map(function (k) {
      return { id: k, name: KINDS[k].group, word: KINDS[k].word, source: KINDS[k].source };
    });
  }

  /** Lists a Task's direct links, each with the far side and who claims it. */
  function readLinks(t) {
    var mine = t.entities || [];
    var rows = [];
    claims.forEach(function (c) {
      if (c.relation !== "linked") return;
      var from = mine.indexOf(c.from) >= 0;
      var to = mine.indexOf(c.to) >= 0;
      if (from === to) return;
      rows.push({ ref: from ? c.to : c.from, claimant: c.claimant, evidence: c.evidence });
    });
    return rows;
  }

  /** Checks whether two Tasks are joined by a direct, confirmed link. Text and shared ancestors do not count. */
  function isConfirmedPeer(a, b) {
    return claims.some(function (c) {
      if (c.relation !== "linked" || c.evidence === "text") return false;
      var ab = (a.entities || []).indexOf(c.from) >= 0 && (b.entities || []).indexOf(c.to) >= 0;
      var ba = (b.entities || []).indexOf(c.from) >= 0 && (a.entities || []).indexOf(c.to) >= 0;
      return ab || ba;
    });
  }

  /** Checks whether a Task carries a thing whose kind leads a group. */
  function isLead(t) {
    return (t.entities || []).some(function (r) { return kindOf(r).leads; });
  }

  /** Returns everything a person might type to find a Task through what it carries. */
  function readSearchWords(t) {
    var refs = (t.entities || []).concat(readAncestors(t.entities || []));
    return refs.map(function (r) { return (entities[r].label || "") + " " + entities[r].title; }).join(" ");
  }

  /** Lists what can still become a Task: offered things no Task carries, plus any `keep` asks for. */
  function listOffered(tasks, keep) {
    var taken = {};
    tasks.forEach(function (t) { (t.entities || []).forEach(function (r) { taken[r] = true; }); });
    return Object.keys(entities).filter(function (r) { return entities[r].offered && (!taken[r] || keep[r]); }).map(function (r) { return entities[r]; });
  }

  return {
    SOURCES: SOURCES, KINDS: KINDS, attach: attach, linkPeers: linkPeers, entity: entity, kindOf: kindOf, sourceOf: sourceOf, readParents: readParents, readAncestors: readAncestors,
    readAncestorsOfKind: readAncestorsOfKind, listGroupKinds: listGroupKinds, readLinks: readLinks, isConfirmedPeer: isConfirmedPeer, isLead: isLead, readSearchWords: readSearchWords, listOffered: listOffered, recognizeLink: recognizeLink, readFromSource: readFromSource, searchSource: searchSource, follow: follow, isUnder: isUnder, listContexts: listContexts,
  };
})();
