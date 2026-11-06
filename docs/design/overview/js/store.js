// PROTOTYPE - the board's state and every operation on it. Nothing here touches the page. Each
// operation changes the Tasks and returns; the board redraws, and the redraw animates. Undo
// restores a snapshot, so undoing plays the same motion backwards for free.
window.Store = (function () {
  "use strict";

  var STAGES = NW.STAGES;
  var STAGE_IDS = STAGES.map(function (s) { return s.id; });
  // A cell shows this many rows of real cards. The rest open in place, under them. It is a limit on
  // how far one busy column can push the next lane down, not a way to hide work.
  var MOST_ROWS = 4;

  var state = {
    tasks: [],
    plans: [],
    projects: [],
    folded: {},
    openPlans: {},
    openCells: {},
    openStacks: {},
    wear: false,
    selected: {},
    query: "",
    filters: {},
    groupBy: "project",
    planPlace: "top",
    laneStyle: "gutter",
  };
  var undoStack = [];

  /** Prepares a world of Tasks: fills in links and ranks. */
  function loadWorld(world) {
    state.projects = world.projects;
    state.plans = world.plans;
    state.tasks = world.tasks.map(function (t, i) {
      t.rank = t.rank === undefined ? i : t.rank;
      t.blockedBy = t.blockedBy || [];
      t.threads = t.threads || [];
      t.links = t.links || [];
      t.entities = t.entities || [];
      return t;
    });
    state.folded = world.folded || {};
    state.openPlans = world.openPlans || {};
    undoStack = [];
  }

  function task(id) {
    return state.tasks.find(function (t) { return t.id === id; });
  }

  /** Lists the Tasks that pass a test, in their stable order. */
  function tasksIn(filter) {
    return state.tasks.filter(filter).sort(function (a, b) { return a.rank - b.rank; });
  }

  /** Checks whether a Task waits on another Task that has not landed. */
  function isBlocked(t) {
    return t.blockedBy.some(function (id) {
      var b = task(id);
      return b && b.stage !== "landed";
    });
  }

  /**
   * Decides what a card has to say beyond its stage. Most cards have nothing to say:
   * - failed: a run on it failed, whatever else is true of it
   * - question: a Thread on it has an open question
   * - landed: it is finished
   * - blocked: another Task holds it back
   */
  function decideState(t) {
    if (t.failed) return "failed";
    if (t.question) return "question";
    if (t.stage === "landed") return "landed";
    if (isBlocked(t)) return "blocked";
    return "";
  }

  /** Returns the words for what holds a Task back. */
  function describeBlocker(t) {
    var b = task(t.blockedBy.filter(function (id) { var x = task(id); return x && x.stage !== "landed"; })[0]);
    return "Waits on " + b.name;
  }

  /** Returns what a failed run says, in the same words on the card and in the details. */
  function describeFailure(t) {
    return t.failed.action + " failed" + (t.failed.cause ? ": " + t.failed.cause : "") + ".";
  }

  /** Checks whether a Task must never wait out of sight: a Thread has a question, or a run failed. */
  function isLoud(t) { return !!(t.question || t.failed); }

  /* ---------- Lanes ---------- */

  function tint(project) {
    return (state.projects.filter(function (p) { return p.id === project; })[0] || {}).tint;
  }

  /** Lists the lanes of a grouping by a kind of outside thing. A Task sits under every one it is part of. */
  function readContextLanes(kind) {
    var byRef = {};
    var none = [];
    state.tasks.forEach(function (t) {
      var refs = Graph.readAncestorsOfKind(t, kind);
      if (!refs.length) none.push(t);
      refs.forEach(function (r) { (byRef[r] = byRef[r] || []).push(t); });
    });
    var word = Graph.KINDS[kind].group;
    var lanes = Object.keys(byRef).sort(function (a, b) { return Graph.entity(a).title.localeCompare(Graph.entity(b).title); }).map(function (r) {
      return { id: "ctx:" + r, name: Graph.entity(r).title, type: "context", entity: Graph.entity(r), source: Graph.sourceOf(r), tasks: byRef[r], loose: byRef[r], plans: [] };
    });
    lanes.push({ id: "none:" + kind, name: "No " + word, type: "none", tasks: none, loose: none, plans: [] });
    return lanes;
  }

  /** Lists the lanes of the current grouping. Each holds all its Tasks, its loose ones, and its plans. */
  function readLanes() {
    var lanes;
    if (state.groupBy === "project") {
      var top = state.planPlace === "top";
      lanes = state.projects.filter(function (p) {
        return p.id !== "" || state.tasks.some(function (t) { return t.project === ""; });
      }).map(function (p) {
        var all = state.tasks.filter(function (t) { return t.project === p.id; });
        var loose = all.filter(function (t) { return !t.initiative; });
        return { id: p.id, name: p.name, type: "project", tint: p.tint, tasks: top ? loose : all, loose: loose, plans: top ? [] : state.plans.filter(function (i) { return i.project === p.id; }) };
      });
    } else if (state.groupBy === "initiative") {
      lanes = state.plans.map(function (i) {
        var all = state.tasks.filter(function (t) { return t.initiative === i.id; });
        return { id: i.id, name: i.name, type: "initiative", hue: i.hue, tasks: all, loose: all, plans: [] };
      });
      var free = state.tasks.filter(function (t) { return !t.initiative; });
      lanes.push({ id: "none:initiative", name: "Not in an initiative", type: "none", tasks: free, loose: free, plans: [] });
    } else {
      lanes = readContextLanes(state.groupBy);
    }
    lanes.forEach(function (l) {
      l.tasks = sortByRank(l.tasks.filter(matches));
      l.loose = sortByRank(l.loose.filter(matches));
    });
    // A lane with nothing to show goes, unless its initiatives are drawn inside it.
    return lanes.filter(function (l) { return l.tasks.length || (l.plans.length && !isFiltering()); });
  }

  /** Lists the initiatives drawn on their own at the top of the board, or none. */
  function readTopPlans() {
    if (state.groupBy !== "project" || state.planPlace !== "top") return [];
    return state.plans.filter(function (i) { return !isFiltering() || state.tasks.some(function (t) { return t.initiative === i.id && matches(t); }); });
  }

  function sortByRank(tasks) {
    return tasks.slice().sort(function (a, b) { return a.rank - b.rank; });
  }

  /** Finds where a drop in a lane or band puts a Task: which project and plan it joins, if any. */
  function resolveOwner(owner) {
    var id = owner.slice(5);
    if (owner.indexOf("plan-") === 0) return { project: state.plans.filter(function (p) { return p.id === id; })[0].project, plan: id };
    if (state.groupBy === "project") return { project: id, plan: "" };
    if (state.groupBy === "initiative") return id === "none:initiative" ? { plan: "" } : { plan: id, project: state.plans.filter(function (p) { return p.id === id; })[0].project };
    // A context belongs to the source. Dropping a card can change its stage here, never its membership.
    return {};
  }

  /* ---------- Cells ---------- */

  /**
   * Groups a cell's Tasks. Only a direct, confirmed link groups: a ticket and the pull requests its
   * source says are its own. Tasks that merely share a repository or a project stay apart.
   */
  function groupLinked(tasks) {
    var used = {};
    var groups = [];
    tasks.forEach(function (t) {
      if (used[t.id] || !Graph.isLead(t)) return;
      var members = tasks.filter(function (o) { return o !== t && !used[o.id] && !Graph.isLead(o) && Graph.isConfirmedPeer(t, o); });
      if (!members.length) return;
      used[t.id] = true;
      members.forEach(function (m) { used[m.id] = true; });
      groups.push({ lead: t, members: members });
    });
    return tasks.filter(function (t) { return !used[t.id]; }).map(function (t) { return { lead: t, members: [] }; }).concat(groups).sort(function (a, b) { return a.lead.rank - b.lead.rank; });
  }

  function countCards(items) {
    return items.reduce(function (n, i) { return n + 1 + i.members.length; }, 0);
  }

  function isItemLoud(item) { return isLoud(item.lead) || item.members.some(isLoud); }

  /** Checks whether a stack shows what it holds. One with a question or a failure inside opens by itself. */
  function isStackOpen(item) {
    var chosen = state.openStacks[item.lead.id];
    return chosen === undefined ? item.members.some(isLoud) : chosen;
  }

  /**
   * Arranges a cell: what shows now, and how many more open in place under it. A failed Task comes
   * first. Nothing that has a question or a failure ever waits out of sight.
   */
  function arrangeCell(tasks, stage, key) {
    var items = groupLinked(tasks);
    items = items.filter(function (i) { return i.lead.failed; }).concat(items.filter(function (i) { return !i.lead.failed; }));
    var open = !!state.openCells[key + "/" + stage] || isFiltering();
    if (stage === "landed") {
      var loud = items.filter(isItemLoud);
      var quiet = items.length > loud.length;
      return open ? { items: items, hidden: 0, openable: quiet && !isFiltering() } : { items: loud, hidden: countCards(items) - countCards(loud), openable: quiet };
    }
    if (items.length <= MOST_ROWS + 1) return { items: items, hidden: 0, openable: false };
    if (open) return { items: items, hidden: 0, openable: !isFiltering() };
    var rest = items.slice(MOST_ROWS);
    var raised = rest.filter(isItemLoud);
    return { items: items.slice(0, MOST_ROWS).concat(raised), hidden: countCards(rest) - countCards(raised), openable: true };
  }

  /* ---------- Filters ---------- */

  var STATES = [
    { id: "question", name: "Has a question", test: function (t) { return !!t.question; } },
    { id: "failed", name: "Failed", test: function (t) { return !!t.failed; } },
    { id: "agent", name: "With an agent", test: function (t) { return !!t.agent && !t.failed; } },
    { id: "blocked", name: "Blocked", test: isBlocked },
  ];

  /** Returns everything about a Task that a person might type to find it. */
  function readSearchText(t) {
    var project = state.projects.filter(function (p) { return p.id === t.project; })[0];
    var links = (t.links || []).map(function (l) { return l.label; }).join(" ");
    return [t.name, t.now, t.where, t.ref, t.agent, t.person, project && project.name, links, t.failed ? describeFailure(t) : "", t.question ? t.question.text : ""].join(" ").toLowerCase();
  }

  /** Checks whether a Task has one facet's value. */
  function hasValue(t, facet, value) {
    if (facet === "state") return STATES.filter(function (s) { return s.id === value; })[0].test(t);
    if (facet === "project") return t.project === value;
    if (facet === "initiative") return (t.initiative || "") === value;
    if (facet === "source") return value === "" ? !t.entities.length : t.entities.some(function (r) { return Graph.sourceOf(r) === value; });
    return Graph.readAncestorsOfKind(t, facet).indexOf(value) >= 0;
  }

  /** Checks a Task against the filters and the find words. Values of one facet add up; facets narrow. */
  function matches(t, skipFacet) {
    var ok = Object.keys(state.filters).every(function (facet) {
      if (facet === skipFacet) return true;
      var values = Object.keys(state.filters[facet]);
      return !values.length || values.some(function (v) { return hasValue(t, facet, v); });
    });
    return ok && (!state.query || readSearchText(t).indexOf(state.query.toLowerCase()) >= 0);
  }

  function isFiltering() { return !!state.query || readActiveFilters().length > 0; }

  /** Lists what can be filtered on: the states, Hercule's own groupings, then what the sources report. */
  function listFacets() {
    function count(facet, value) {
      return state.tasks.filter(function (t) { return matches(t, facet) && hasValue(t, facet, value); }).length;
    }
    function values(facet, list) {
      return list.map(function (v) { return Object.assign({}, v, { count: count(facet, v.id) }); }).filter(function (v) { return v.count; });
    }
    var sources = Object.keys(Graph.SOURCES).map(function (id) { return { id: id, name: Graph.SOURCES[id], source: id }; }).concat([{ id: "", name: "No source" }]);
    var facets = [
      { id: "state", name: "State", icon: "filter", values: values("state", STATES) },
      { id: "project", name: "Project", icon: "office", values: values("project", state.projects.map(function (p) { return { id: p.id, name: p.name, tint: p.tint }; })) },
      { id: "initiative", name: "Initiative", icon: "flag", values: values("initiative", state.plans.map(function (i) { return { id: i.id, name: i.name, hue: i.hue }; })) },
      { id: "source", name: "Source", icon: "connections", values: values("source", sources) },
    ];
    Graph.listGroupKinds(state.tasks).forEach(function (k) {
      var seen = {};
      state.tasks.forEach(function (t) { Graph.readAncestorsOfKind(t, k.id).forEach(function (r) { seen[r] = true; }); });
      facets.push({ id: k.id, name: k.name, source: k.source, values: values(k.id, Object.keys(seen).sort().map(function (r) { return { id: r, name: Graph.entity(r).title, source: k.source }; })) });
    });
    return facets;
  }

  /** Lists every value that is on, each with its words, for the chips in the toolbar. */
  function readActiveFilters() {
    var out = [];
    Object.keys(state.filters).forEach(function (facet) {
      Object.keys(state.filters[facet]).forEach(function (value) {
        var name = value;
        if (facet === "state") name = STATES.filter(function (s) { return s.id === value; })[0].name;
        else if (facet === "project") name = (state.projects.filter(function (p) { return p.id === value; })[0] || {}).name;
        else if (facet === "initiative") name = (state.plans.filter(function (p) { return p.id === value; })[0] || {}).name;
        else if (facet === "source") name = Graph.SOURCES[value] || "No source";
        else name = Graph.entity(value).title;
        var caption = facet === "state" ? "" : facet === "project" ? "Project" : facet === "initiative" ? "Initiative" : facet === "source" ? "Source" : Graph.KINDS[facet].group;
        out.push({ facet: facet, value: value, name: name, caption: caption });
      });
    });
    return out;
  }

  /** Turns one filter value on or off. */
  function toggleFilter(facet, value) {
    var f = state.filters[facet] = state.filters[facet] || {};
    if (f[value]) delete f[value];
    else f[value] = true;
    if (!Object.keys(f).length) delete state.filters[facet];
  }

  /** Counts Tasks by state, each Task once, for the filter menu and the sidebar's dot. */
  function countStates() {
    return { failed: state.tasks.filter(function (t) { return t.failed; }).length, question: state.tasks.filter(function (t) { return t.question; }).length };
  }

  /** Lists the choices of Group by: Hercule's own, then what the sources report. */
  function listGroupings() {
    return [{ id: "project", name: "Project", icon: "office" }, { id: "initiative", name: "Initiative", icon: "flag" }].concat(Graph.listGroupKinds(state.tasks));
  }

  /* ---------- Undo ---------- */

  var batch = null;

  /** Keeps one way back. Inside a batch, all the ways back become one undo. */
  function remember(label, restore, hint) {
    if (batch) {
      batch.steps.unshift(restore);
      return;
    }
    undoStack.push({ label: label, restore: restore, hint: hint });
    if (undoStack.length > 50) undoStack.shift();
  }

  /** Runs several changes as one gesture: one Undo puts them all back. */
  function group(label, fn) {
    batch = { steps: [] };
    fn();
    var steps = batch.steps;
    batch = null;
    if (steps.length) undoStack.push({ label: label, restore: function () { steps.forEach(function (r) { r(); }); } });
  }

  /** Returns the last change's way back, without taking it. */
  function peekUndo() { return undoStack[undoStack.length - 1] || null; }

  /** Puts the last change back, and only that change. Returns it, or null when there is none. */
  function undo() {
    var last = undoStack.pop();
    if (!last) return null;
    last.restore();
    return last;
  }

  /* ---------- Operations ---------- */

  function snapshot(t) {
    return { stage: t.stage, project: t.project, rank: t.rank, initiative: t.initiative, movedBy: t.movedBy, age: t.age, pendingSync: t.pendingSync };
  }

  /** Moves a Task to a stage and a place in a lane, and remembers that a person did it. */
  function moveTask(id, to) {
    var t = task(id);
    var was = snapshot(t);
    remember(t.name, function () { Object.assign(t, was); });
    var changedStage = t.stage !== to.stage;
    t.stage = to.stage;
    if (to.project !== undefined) t.project = to.project;
    if (to.before !== undefined) t.rank = to.before;
    if (to.plan !== undefined) t.initiative = to.plan;
    t.movedBy = "you";
    // A new stage is real activity. Tidying a column is not, so a reorder leaves the age alone.
    if (changedStage) t.age = 0;
    if (state.offline) t.pendingSync = true;
  }

  /** Merges one Task into another: its threads and links join, and it leaves the board. */
  function mergeTasks(fromId, intoId) {
    var a = task(fromId);
    var b = task(intoId);
    var was = { threads: b.threads, links: b.links, entities: b.entities, merged: b.mergedCount, failed: b.failed, question: b.question, agent: b.agent };
    var blocks = state.tasks.map(function (t) { return { t: t, by: t.blockedBy }; });
    remember(a.name, function () {
      state.tasks.push(a);
      b.threads = was.threads;
      b.links = was.links;
      b.entities = was.entities;
      b.mergedCount = was.merged;
      b.failed = was.failed;
      b.question = was.question;
      b.agent = was.agent;
      blocks.forEach(function (x) { x.t.blockedBy = x.by; });
    }, { id: fromId, from: intoId });
    b.threads = b.threads.concat(a.threads);
    b.links = b.links.concat(a.links);
    b.entities = b.entities.concat(a.entities);
    b.mergedCount = (b.mergedCount || 0) + 1 + (a.mergedCount || 0);
    // A failure or a question goes with its thread. Merging must not make one disappear.
    b.failed = b.failed || a.failed;
    b.question = b.question || a.question;
    b.agent = b.agent || a.agent;
    state.tasks = state.tasks.filter(function (t) { return t !== a; });
    state.tasks.forEach(function (t) {
      t.blockedBy = t.blockedBy.map(function (x) { return x === fromId ? intoId : x; }).filter(function (x) { return x !== t.id; });
    });
    return b;
  }

  /** Ends a Task as Done or Dropped: it leaves the board. */
  function endTask(id, how) {
    var t = task(id);
    remember(t.name, function () {
      t.ended = "";
      state.tasks.push(t);
    }, { id: id, ended: how });
    t.ended = how;
    state.tasks = state.tasks.filter(function (x) { return x !== t; });
  }

  /** Records your answer to a Thread's question: the Thread carries on with it. */
  function answerTask(id, answer) {
    var t = task(id);
    var was = { question: t.question, now: t.now, age: t.age, pendingSync: t.pendingSync };
    remember(t.name, function () { Object.assign(t, was); }, { id: id, reopen: true });
    t.question = null;
    t.now = "You said: " + answer + ".";
    t.age = 0;
    if (state.offline) t.pendingSync = true;
  }

  /** Records a run that stopped with an error. A failure is a fact, not your gesture, so it has no Undo. */
  function failRun(id, failure) {
    var t = task(id);
    t.failed = failure;
    t.age = 0;
    t.where = failure.where || "The run stopped before it finished.";
  }

  /** Starts a failed run again: its colleague takes the card back. */
  function retryRun(id) {
    var t = task(id);
    var was = { failed: t.failed, agent: t.agent, now: t.now, where: t.where };
    remember(t.name, function () { Object.assign(t, was); }, { id: id, reopen: true });
    t.agent = t.agent || t.failed.action;
    t.failed = null;
    t.now = "Trying again.";
    t.where = "Trying again, from the start.";
  }

  /** Starts a thread on a Task. A failure ends here too, because someone is on it again. */
  function startThread(id, prompt) {
    var t = task(id);
    var was = { agent: t.agent, now: t.now, threads: t.threads, failed: t.failed };
    remember(t.name, function () { Object.assign(t, was); });
    var title = prompt || "Thread on " + t.name;
    t.threads = t.threads.concat([{ title: title, id: "n" + Date.now() }]);
    t.agent = title;
    t.failed = null;
    t.now = "A thread just started.";
    if (state.offline) t.pendingSync = true;
  }

  /** Moves a Task because a fact arrived. A person's drag holds until then; a fact overrides it. */
  function moveByFact(id, stage, apply) {
    var t = task(id);
    t.stage = stage;
    t.movedBy = "fact";
    // It lands at the end of its new cell, so nothing already there has to move.
    t.rank = state.tasks.reduce(function (m, x) { return Math.max(m, x.rank); }, 0) + 1;
    if (apply) apply(t);
  }

  /** Adds a Task at the end of its cell. */
  function addTask(t) {
    t.rank = state.tasks.reduce(function (m, x) { return Math.max(m, x.rank); }, 0) + 1;
    t.blockedBy = t.blockedBy || [];
    t.threads = t.threads || [];
    t.links = t.links || [];
    t.entities = t.entities || [];
    state.tasks.push(t);
  }

  /** Creates a Task for an outside thing, or a plain one, and keeps the way back. Returns the Task. */
  function createTask(t) {
    addTask(t);
    remember(t.name, function () { state.tasks = state.tasks.filter(function (x) { return x !== t; }); });
    return t;
  }

  return {
    state: state,
    STAGES: STAGES,
    STAGE_IDS: STAGE_IDS,
    loadWorld: loadWorld,
    task: task,
    tasksIn: tasksIn,
    isBlocked: isBlocked,
    isLoud: isLoud,
    decideState: decideState,
    describeBlocker: describeBlocker,
    describeFailure: describeFailure,
    readLanes: readLanes,
    readTopPlans: readTopPlans,
    resolveOwner: resolveOwner,
    arrangeCell: arrangeCell,
    isStackOpen: isStackOpen,
    matches: matches,
    isFiltering: isFiltering,
    listFacets: listFacets,
    readActiveFilters: readActiveFilters,
    toggleFilter: toggleFilter,
    countStates: countStates,
    listGroupings: listGroupings,
    moveTask: moveTask,
    mergeTasks: mergeTasks,
    endTask: endTask,
    addTask: addTask,
    createTask: createTask,
    moveByFact: moveByFact,
    answerTask: answerTask,
    failRun: failRun,
    retryRun: retryRun,
    startThread: startThread,
    group: group,
    undo: undo,
    peekUndo: peekUndo,
    canUndo: function () { return undoStack.length > 0; },
  };
})();
