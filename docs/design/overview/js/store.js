// PROTOTYPE - the board's state and every operation on it. Nothing here touches the page. Each
// operation changes the Tasks and returns; the board redraws, and the redraw animates. Undo
// restores a snapshot, so undoing plays the same motion backwards for free.
window.Store = (function () {
  "use strict";

  var STAGES = NW.STAGES;
  var STAGE_IDS = STAGES.map(function (s) { return s.id; });
  // A cell never holds more than this many rows at rest, so a lane has the same height at 60
  // Tasks as at 300. Past it, the rest wait in a pile on the last row.
  var MOST_ROWS = 3;

  var state = {
    tasks: [],
    plans: [],
    projects: [],
    folded: {},
    openPlans: {},
    wear: false,
    selected: {},
    lens: null,
    query: "",
  };
  var undoStack = [];
  var listeners = [];

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /** Prepares a world of Tasks: fills in links, ranks and the need words the board reads. */
  function loadWorld(world) {
    state.projects = world.projects;
    state.plans = world.plans;
    state.tasks = world.tasks.map(function (t, i) {
      t.rank = t.rank === undefined ? i : t.rank;
      t.blockedBy = t.blockedBy || [];
      t.threads = t.threads || [];
      t.links = t.links || [];
      if (t.move === "you" && t.need !== "think") t.need = "quick";
      return t;
    });
    state.folded = world.folded || {};
    state.openPlans = world.openPlans || {};
    undoStack = [];
  }

  function task(id) {
    return state.tasks.find(function (t) { return t.id === id; });
  }

  /** Lists the Tasks of a project with no plan, or of a plan, in their stable order. */
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
   * Decides a card's height above the desk:
   * - etch: it has landed
   * - press: another Task holds it back
   * - stand: it wants you
   * - flat: someone else holds it
   */
  function decideHeight(t) {
    if (t.stage === "landed") return "etch";
    if (isBlocked(t)) return "press";
    if (t.move === "you") return "stand";
    return "flat";
  }

  /** Decides what stands behind a card's top edge: who has the next move. */
  function decideHolder(t) {
    if (t.stage === "landed" || isBlocked(t)) return { kind: "none" };
    if (t.agent) return { kind: "agent", name: t.agent, pose: t.move === "you" ? "waiting" : "working" };
    if (t.move === "you") return { kind: "you", need: t.need };
    if (t.person) return { kind: "person", name: t.person };
    return { kind: "none" };
  }

  /** Returns the few words at the foot of a card: what it needs and from whom. */
  function describeNeed(t) {
    if (t.stage === "landed") return "Landed";
    if (isBlocked(t)) {
      var b = task(t.blockedBy[0]);
      return "Waits on " + b.name;
    }
    if (t.agent) return t.move === "you" ? "Asks you" : "Working";
    if (t.move === "you") return t.need === "think" ? "Real thinking" : "Quick call";
    if (t.person) return "With " + (/^the /.test(t.person) ? t.person : t.person.split(" ")[0]);
    return "";
  }

  /** Splits one cell into what lies on the desk and what waits in piles. */
  function arrangeCell(tasks, stage, owner) {
    var piles = [];
    var used = {};
    function fold(kind, title, list) {
      list.forEach(function (t) { used[t.id] = true; });
      piles.push({ key: owner + "/" + stage + "/" + kind, kind: kind, title: title, tasks: list });
    }
    if (stage === "landed" && tasks.length > 1) {
      fold("landed", "Landed", tasks);
    } else {
      var reviews = tasks.filter(function (t) { return t.kind === "review" || t.kind === "mention"; });
      if (reviews.length >= 3) fold("reviews", "Reviews", reviews);
      var prs = tasks.filter(function (t) { return t.kind === "pr"; });
      if (prs.length >= 3) fold("prs", "Pull requests", prs);
      var tickets = tasks.filter(function (t) { return t.kind === "ticket"; });
      if (tickets.length >= 3) fold("tickets", "Tickets", tickets);
    }
    // A card you just put down stays a card, wherever it was: it never vanishes into a pile
    // under your hand. It joins the rest on the next visit.
    var held = tasks.filter(function (t) { return t.held; });
    held.forEach(function (t) {
      piles.forEach(function (p) {
        p.tasks = p.tasks.filter(function (x) { return x !== t; });
      });
      used[t.id] = false;
    });
    piles = piles.filter(function (p) { return p.tasks.length > 1 || p.kind === "landed"; });
    var cards = tasks.filter(function (t) { return !used[t.id]; });
    var loose = cards.filter(function (t) { return !t.held; });
    var room = Math.max(0, MOST_ROWS - piles.length - held.length);
    if (loose.length > room) {
      var over = loose.slice(Math.max(0, room - 1));
      over.forEach(function (t) { used[t.id] = true; });
      cards = cards.filter(function (t) { return !used[t.id]; });
      piles.push({ key: owner + "/" + stage + "/more", kind: "more", title: over.length + " more", tasks: over });
    }
    return { cards: cards, piles: piles };
  }

  /** Returns the line under a pile's title: what it holds that needs you, or how it stands. */
  function describePile(p) {
    var mine = p.tasks.filter(function (t) { return t.move === "you" && !t.agent && !isBlocked(t); }).length;
    var agents = p.tasks.filter(function (t) { return t.agent && t.move !== "you"; }).length;
    if (p.kind === "landed") return "This week";
    if (mine && agents) return mine + (mine === 1 ? " wants" : " want") + " you, " + agents + " with agents";
    if (mine) return mine + (mine === 1 ? " wants" : " want") + " you";
    if (agents) return agents === 1 ? "With an agent" : agents + " with agents";
    return "With others";
  }

  /** Counts what the lead sentence and the lens words say. */
  function countAttention() {
    var open = state.tasks.filter(function (t) { return t.stage !== "landed"; });
    function count(fn) { return open.filter(fn).length; }
    return {
      quick: count(function (t) { return t.move === "you" && t.need === "quick" && !isBlocked(t); }),
      think: count(function (t) { return t.move === "you" && t.need === "think" && !isBlocked(t); }),
      stalled: count(function (t) { return t.stalled; }),
      agents: count(function (t) { return t.agent && t.move !== "you"; }),
      blocked: count(isBlocked),
      all: open.length,
    };
  }

  /** Checks whether a Task passes the lens and the find words. */
  function matches(t) {
    var lens = state.lens;
    var ok = true;
    if (lens === "quick") ok = t.move === "you" && t.need === "quick" && !isBlocked(t) && t.stage !== "landed";
    else if (lens === "think") ok = t.move === "you" && t.need === "think" && !isBlocked(t) && t.stage !== "landed";
    else if (lens === "stalled") ok = t.stalled && t.stage !== "landed";
    else if (lens === "agents") ok = !!t.agent && t.move !== "you";
    if (ok && state.query) ok = (t.name + " " + (t.now || "") + " " + (t.ref || "")).toLowerCase().indexOf(state.query.toLowerCase()) >= 0;
    return ok;
  }

  function isFiltering() { return !!(state.lens || state.query); }

  function remember(label) {
    undoStack.push({ label: label, tasks: clone(state.tasks) });
    if (undoStack.length > 50) undoStack.shift();
  }

  /** Puts the last change back. Returns its label, or null when there is nothing to undo. */
  function undo() {
    var last = undoStack.pop();
    if (!last) return null;
    state.tasks = last.tasks;
    return last.label;
  }

  /** Moves a Task to a stage and a row of a project, and remembers that a person did it. */
  function moveTask(id, to) {
    var t = task(id);
    remember("Moved " + t.name);
    t.stage = to.stage;
    if (to.project) t.project = to.project;
    if (to.before !== undefined) t.rank = to.before;
    if (to.plan !== undefined) t.initiative = to.plan;
    t.movedBy = "you";
    t.held = true;
    t.age = 0;
    if (t.stage === "landed") {
      t.agent = "";
      t.move = "nobody";
    }
  }

  /** Merges one Task into another: its threads and links join, and it leaves the board. */
  function mergeTasks(fromId, intoId) {
    var a = task(fromId);
    var b = task(intoId);
    remember("Merged " + a.name);
    b.threads = b.threads.concat(a.threads);
    b.links = b.links.concat(a.links);
    b.mergedCount = (b.mergedCount || 0) + 1 + (a.mergedCount || 0);
    state.tasks = state.tasks.filter(function (t) { return t !== a; });
    state.tasks.forEach(function (t) {
      t.blockedBy = t.blockedBy.map(function (x) { return x === fromId ? intoId : x; }).filter(function (x) { return x !== t.id; });
    });
    return b;
  }

  /** Ends a Task as Done or Dropped: it leaves the board. */
  function endTask(id, how) {
    var t = task(id);
    remember(how + " " + t.name);
    t.ended = how;
    state.tasks = state.tasks.filter(function (x) { return x !== t; });
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

  /** Adds a Task that started by itself, at the end of its cell. */
  function addTask(t) {
    t.rank = state.tasks.reduce(function (m, x) { return Math.max(m, x.rank); }, 0) + 1;
    t.blockedBy = t.blockedBy || [];
    t.threads = t.threads || [];
    t.links = t.links || [];
    state.tasks.push(t);
  }

  return {
    state: state,
    STAGES: STAGES,
    STAGE_IDS: STAGE_IDS,
    loadWorld: loadWorld,
    task: task,
    tasksIn: tasksIn,
    isBlocked: isBlocked,
    decideHeight: decideHeight,
    decideHolder: decideHolder,
    describeNeed: describeNeed,
    arrangeCell: arrangeCell,
    describePile: describePile,
    countAttention: countAttention,
    matches: matches,
    isFiltering: isFiltering,
    moveTask: moveTask,
    mergeTasks: mergeTasks,
    endTask: endTask,
    addTask: addTask,
    moveByFact: moveByFact,
    undo: undo,
    canUndo: function () { return undoStack.length > 0; },
  };
})();
