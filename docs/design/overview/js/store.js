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
  var BUSY_LANE = 10;

  var state = {
    tasks: [],
    plans: [],
    projects: [],
    folded: {},
    full: {},
    openPlans: {},
    wear: false,
    selected: {},
    lifted: null,
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
    state.full = {};
    state.rows = {};
    cellMemo = {};
    // A lane whose Tasks all sit in one plan shows that plan's band, not a name and a hole.
    state.projects.forEach(function (p) {
      var inLane = state.tasks.filter(function (t) { return t.project === p.id; });
      var plans = {};
      inLane.forEach(function (t) { plans[t.initiative || ""] = true; });
      var keys = Object.keys(plans);
      if (keys.length === 1 && keys[0]) state.openPlans[keys[0]] = true;
      // A lane with a lot that wants you shows two rows. Decided once a visit, so a lane never
      // changes height because something was answered.
      state.rows[p.id] = inLane.filter(wantsYou).length >= BUSY_LANE ? 2 : 1;
    });
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
   * - stand: a run on it failed, whatever else is true of it
   * - etch: it has landed
   * - press: another Task holds it back
   * - stand: it wants you
   * - flat: someone else holds it
   */
  function decideHeight(t) {
    if (t.failed) return "stand";
    if (t.stage === "landed") return "etch";
    if (isBlocked(t)) return "press";
    if (t.move === "you") return "stand";
    return "flat";
  }

  /** Decides what stands behind a card's top edge: who has the next move. */
  function decideHolder(t) {
    if (t.failed) return t.agent ? { kind: "agent", name: t.agent, pose: "failed", need: "quick" } : { kind: "you", need: "quick" };
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

  /** Returns what a failed run says, in the same words on the card and in the details. */
  function describeFailure(t) {
    return t.failed.action + " failed" + (t.failed.cause ? ": " + t.failed.cause : "") + ".";
  }

  // What each cell showed first this visit. A pile keeps its identity and its place until the next
  // visit: a card leaving can only take something away, never rebuild the column.
  var cellMemo = {};

  function wantsYou(t) { return !!t.failed || (t.move === "you" && !isBlocked(t) && t.stage !== "landed"); }

  /**
   * Picks the card that lies on top of a stack: the oldest that wants you, then an agent's, then a
   * person's, then the oldest. A blocked card comes last, because nobody can do anything with it.
   */
  function sortForDesk(tasks) {
    function rankOf(t) {
      if (wantsYou(t)) return 0;
      if (isBlocked(t)) return 4;
      if (t.agent) return 1;
      if (t.person) return 2;
      return 3;
    }
    return tasks.slice().sort(function (a, b) { return rankOf(a) - rankOf(b) || a.rank - b.rank; });
  }

  function pickTop(tasks) {
    return sortForDesk(tasks)[0];
  }

  /**
   * Arranges a cell at rest: a set number of rows. Real cards lie on top, and the rest wait behind
   * the last one. Who is on top stays the same for the visit. Under a lens the cards that match come
   * to the top, so a lens never lights an empty row.
   */
  function arrangeRows(tasks, stage, owner, held, lifting, rows) {
    var memoKey = owner + "/" + stage + "/rows";
    if (stage === "landed" && tasks.length + held.length) {
      return { cards: [], piles: [{ key: owner + "/" + stage + "/landed", kind: "landed", title: "Landed", tasks: tasks.concat(held) }], behind: [], held: [] };
    }
    if (!tasks.length) return { cards: [], piles: [], behind: [], held: held };
    var byId = {};
    tasks.forEach(function (t) { byId[t.id] = t; });
    var shown = (cellMemo[memoKey] || []).map(function (id) { return byId[id]; }).filter(Boolean);
    var waiting = sortForDesk(tasks).filter(function (t) { return shown.indexOf(t) < 0; });
    while (shown.length < rows && waiting.length) shown.push(waiting.shift());
    // Whatever arrives, a blocked card never holds the top while something else could.
    shown = shown.filter(function (t) { return !isBlocked(t); }).concat(shown.filter(isBlocked));
    // While a card is in the hand the one under it shows, but it has not taken its place for good.
    if (!lifting) cellMemo[memoKey] = shown.map(function (t) { return t.id; });
    // A card you just put down takes a row, so a lane at rest never changes height.
    var room = Math.max(0, rows - held.length);
    var cards = shown;
    if (isFiltering()) {
      var hits = tasks.filter(matches);
      cards = hits.concat(shown.filter(function (t) { return hits.indexOf(t) < 0; }));
    }
    cards = cards.slice(0, room);
    return { cards: cards, piles: [], behind: tasks.filter(function (t) { return cards.indexOf(t) < 0; }), held: held };
  }

  /** Works out a full cell for the first time this visit. */
  function arrangeFirst(tasks, stage, owner) {
    var piles = [];
    var used = {};
    function fold(kind, title, list) {
      list.forEach(function (t) { used[t.id] = true; });
      piles.push({ key: owner + "/" + stage + "/" + kind, kind: kind, title: title, tasks: list });
    }
    if (stage === "landed" && tasks.length) {
      fold("landed", "Landed", tasks);
    } else {
      var reviews = tasks.filter(function (t) { return t.kind === "review" || t.kind === "mention"; });
      if (reviews.length >= 3) fold("reviews", "Reviews", reviews);
      var prs = tasks.filter(function (t) { return t.kind === "pr"; });
      if (prs.length >= 3) fold("prs", "Pull requests", prs);
      var tickets = tasks.filter(function (t) { return t.kind === "ticket"; });
      if (tickets.length >= 3) fold("tickets", "Tickets", tickets);
      // Two streams beside two or more cards would need a fourth row, so they share one pile.
      var loose = tasks.filter(function (t) { return !used[t.id]; }).length;
      if (piles.length >= 2 && loose + piles.length > MOST_ROWS) {
        var shared = piles.reduce(function (all, p) { return all.concat(p.tasks); }, []);
        piles = [{ key: owner + "/" + stage + "/streams", kind: "streams", title: "Reviews and PRs", tasks: shared }];
      }
    }
    // One order on every view, so showing a lane's rows leaves its top card on top.
    var cards = sortForDesk(tasks.filter(function (t) { return !used[t.id]; }));
    var room = Math.max(0, MOST_ROWS - piles.length);
    if (cards.length > room + 1) {
      var over = cards.slice(room);
      cards = cards.slice(0, room);
      piles.push({ key: owner + "/" + stage + "/more", kind: "more", title: "more", tasks: over });
    }
    return { cards: cards, piles: piles };
  }

  /** Arranges a cell shown in full: up to three rows. Keeps what it first showed this visit. */
  function arrangeFullCell(tasks, stage, owner, held) {
    var memoKey = owner + "/" + stage + "/full";
    var memo = cellMemo[memoKey];
    if (!memo) {
      var first = arrangeFirst(tasks, stage, owner);
      cellMemo[memoKey] = {
        cards: first.cards.map(function (t) { return t.id; }),
        piles: first.piles.map(function (p) { return { key: p.key, kind: p.kind, title: p.title, ids: p.tasks.map(function (t) { return t.id; }) }; }),
      };
      return { cards: first.cards, piles: first.piles, behind: [], held: held };
    }
    var byId = {};
    tasks.forEach(function (t) { byId[t.id] = t; });
    var seen = {};
    function keep(ids) {
      return ids.filter(function (id) { return byId[id]; }).map(function (id) {
        seen[id] = true;
        return byId[id];
      });
    }
    var cards = keep(memo.cards);
    var piles = memo.piles.map(function (m) { return { key: m.key, kind: m.kind, title: m.title, tasks: keep(m.ids) }; }).filter(function (p) { return p.tasks.length; });
    // A newcomer joins the last pile if there is one, so it pushes nothing down.
    tasks.filter(function (t) { return !seen[t.id]; }).forEach(function (t) {
      if (piles.length) {
        var last = piles[piles.length - 1];
        last.tasks.push(t);
        memo.piles.filter(function (m) { return m.key === last.key; })[0].ids.push(t.id);
      } else {
        cards.push(t);
        memo.cards.push(t.id);
      }
    });
    return { cards: cards, piles: piles, behind: [], held: held };
  }

  /**
   * Puts failed Tasks on top of an arranged cell, so a failure never waits in a stack or a pile. A
   * cell at rest keeps its number of rows: failures past that lie first in the stack. Under another
   * lens they give way, because a lens must not light an empty row.
   */
  function leadWithFailed(arranged, failed, rows) {
    if (!failed.length) return arranged;
    var first = isFiltering() ? failed.filter(matches) : failed;
    var cards = first.concat(arranged.cards, failed.filter(function (t) { return first.indexOf(t) < 0; }));
    if (!rows) return Object.assign({}, arranged, { cards: cards });
    var room = Math.max(1, rows - arranged.held.length);
    return Object.assign({}, arranged, { cards: cards.slice(0, room), behind: cards.slice(room).concat(arranged.behind) });
  }

  /** Splits one cell into what lies on the desk and what waits behind it or in piles. */
  function arrangeCell(tasks, stage, owner, rows) {
    // A card you just put down stays a card, on the row you chose, until the next visit. It takes no
    // room from the others.
    var lifted = state.lifted;
    var lifting = !!lifted && tasks.some(function (t) { return t.id === lifted; });
    tasks = tasks.filter(function (t) { return t.id !== lifted; });
    var held = tasks.filter(function (t) { return t.held; }).sort(function (a, b) { return (a.heldRow || 0) - (b.heldRow || 0); });
    var rest = tasks.filter(function (t) { return !t.held && !t.failed; });
    var failed = tasks.filter(function (t) { return !t.held && t.failed; });
    return leadWithFailed(rows ? arrangeRows(rest, stage, owner, held, lifting, rows) : arrangeFullCell(rest, stage, owner, held), failed, rows);
  }

  /** Returns the line under a pile's title: what it holds that needs you, or how it stands. */
  function describePile(p) {
    var mine = p.tasks.filter(function (t) { return t.move === "you" && !t.agent && !isBlocked(t); }).length;
    var agents = p.tasks.filter(function (t) { return t.agent && t.move !== "you"; }).length;
    if (p.kind === "landed") return "This week";
    if (mine && agents) return mine + (mine === 1 ? " wants" : " want") + " you, " + agents + " with agents";
    if (agents) return agents === 1 ? "1 with an agent" : agents + " with agents";
    if (mine) return mine + (mine === 1 ? " wants" : " want") + " you";
    return "With others";
  }

  /** Counts what the lead sentence and the lens words say. */
  function countAttention() {
    var open = state.tasks.filter(function (t) { return t.stage !== "landed"; });
    function count(fn) { return open.filter(fn).length; }
    return {
      // A failed Task can sit in Landed too, and the sentence names it once, as failed.
      failed: state.tasks.filter(function (t) { return t.failed; }).length,
      quick: count(function (t) { return t.move === "you" && t.need === "quick" && !isBlocked(t) && !t.failed; }),
      think: count(function (t) { return t.move === "you" && t.need === "think" && !isBlocked(t); }),
      stalled: count(function (t) { return t.stalled; }),
      agents: count(function (t) { return t.agent && t.move !== "you"; }),
      blocked: count(isBlocked),
      all: open.length,
    };
  }

  /** Returns everything about a Task that a person might type to find it. */
  function readSearchText(t) {
    var project = state.projects.filter(function (p) { return p.id === t.project; })[0];
    var links = (t.links || []).map(function (l) { return l.label; }).join(" ");
    return [t.name, t.now, t.where, t.ask, t.ref, t.agent, t.person, project && project.name, links, t.failed ? describeFailure(t) : ""].join(" ").toLowerCase();
  }

  /**
   * Lists the Tasks that want you: what failed first, as the sentence says it, then the rest in
   * reading order, lane by lane, its loose work, then its plans.
   */
  function listWanting() {
    var out = [];
    function take(project, plan) {
      STAGE_IDS.forEach(function (stage) {
        tasksIn(function (t) { return t.project === project && (t.initiative || "") === plan && t.stage === stage && wantsYou(t); }).forEach(function (t) {
          if (matches(t)) out.push(t);
        });
      });
    }
    state.projects.forEach(function (p) {
      take(p.id, "");
      state.plans.filter(function (i) { return i.project === p.id; }).forEach(function (i) { take(p.id, i.id); });
    });
    return out.filter(function (t) { return t.failed; }).concat(out.filter(function (t) { return !t.failed; }));
  }

  /** Checks whether a Task passes the lens and the find words. */
  function matches(t) {
    var lens = state.lens;
    var ok = true;
    if (lens === "failed") ok = !!t.failed;
    else if (lens === "quick") ok = t.move === "you" && t.need === "quick" && !isBlocked(t) && t.stage !== "landed" && !t.failed;
    else if (lens === "think") ok = t.move === "you" && t.need === "think" && !isBlocked(t) && t.stage !== "landed";
    else if (lens === "stalled") ok = t.stalled && t.stage !== "landed";
    else if (lens === "agents") ok = !!t.agent && t.move !== "you";
    if (ok && state.query) ok = readSearchText(t).indexOf(state.query.toLowerCase()) >= 0;
    return ok;
  }

  function isFiltering() { return !!(state.lens || state.query); }

  var batch = null;

  /** Keeps one way back. Inside a batch, all the ways back become one undo. */
  function remember(label, restore, hint) {
    if (batch) {
      batch.steps.unshift(restore);
      return;
    }
    // The cards a stack showed are part of what comes back.
    undoStack.push({ label: label, restore: restore, hint: hint, memo: JSON.stringify(cellMemo) });
    if (undoStack.length > 50) undoStack.shift();
  }

  /** Runs several changes as one gesture: one Undo puts them all back. */
  function group(label, fn) {
    var memo = JSON.stringify(cellMemo);
    batch = { steps: [] };
    fn();
    var steps = batch.steps;
    batch = null;
    if (steps.length) undoStack.push({ label: label, restore: function () { steps.forEach(function (r) { r(); }); }, memo: memo });
  }

  /** Returns the last change's way back, without taking it. */
  function peekUndo() { return undoStack[undoStack.length - 1] || null; }

  /** Puts the last change back, and only that change. Returns it, or null when there is none. */
  function undo() {
    var last = undoStack.pop();
    if (!last) return null;
    last.restore();
    if (last.memo) cellMemo = JSON.parse(last.memo);
    return last;
  }

  function snapshot(t) {
    return { stage: t.stage, project: t.project, rank: t.rank, initiative: t.initiative, movedBy: t.movedBy, held: t.held, heldRow: t.heldRow, age: t.age, stalled: t.stalled, pendingSync: t.pendingSync };
  }

  /** Moves a Task to a stage and a row of a project, and remembers that a person did it. */
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
    t.held = true;
    t.heldRow = to.row === undefined ? 0 : to.row;
    // Cards put down earlier in this cell keep their places below the new one.
    state.tasks.forEach(function (o) {
      if (o !== t && o.held && o.stage === t.stage && o.project === t.project && o.initiative === t.initiative && o.heldRow >= t.heldRow) o.heldRow++;
    });
    // A new stage is real activity. Tidying a column is not, so a reorder leaves the age alone.
    if (changedStage) {
      t.age = 0;
      t.stalled = false;
    }
    if (state.offline) t.pendingSync = true;
  }

  /** Merges one Task into another: its threads and links join, and it leaves the board. */
  function mergeTasks(fromId, intoId) {
    var a = task(fromId);
    var b = task(intoId);
    var was = { threads: b.threads, links: b.links, merged: b.mergedCount, failed: b.failed, move: b.move, need: b.need };
    var blocks = state.tasks.map(function (t) { return { t: t, by: t.blockedBy }; });
    remember(a.name, function () {
      state.tasks.push(a);
      b.threads = was.threads;
      b.links = was.links;
      b.mergedCount = was.merged;
      b.failed = was.failed;
      b.move = was.move;
      b.need = was.need;
      blocks.forEach(function (x) { x.t.blockedBy = x.by; });
    }, { id: fromId, from: intoId });
    b.threads = b.threads.concat(a.threads);
    b.links = b.links.concat(a.links);
    b.mergedCount = (b.mergedCount || 0) + 1 + (a.mergedCount || 0);
    // A failure goes with its thread. Merging must not make one disappear.
    if (a.failed && !b.failed) {
      b.failed = a.failed;
      b.move = "you";
      b.need = "quick";
    }
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

  /** Records your answer: the agent carries on with it, and the card lies down. */
  function answerTask(id, answer) {
    var t = task(id);
    var was = { move: t.move, agent: t.agent, now: t.now, ask: t.ask, need: t.need, age: t.age, pendingSync: t.pendingSync };
    remember(t.name, function () { Object.assign(t, was); }, { id: id, reopen: true });
    t.move = "agent";
    t.agent = t.agent || "Carry on with " + t.name;
    t.now = "You said: " + answer + ".";
    t.ask = "";
    t.need = "look";
    t.age = 0;
    if (state.offline) t.pendingSync = true;
  }

  /**
   * Records a run that stopped with an error. The next move becomes yours and the card stands. A
   * failure is a fact, not your gesture, so it has no Undo.
   */
  function failRun(id, failure) {
    var t = task(id);
    t.failed = failure;
    t.move = "you";
    t.need = "quick";
    t.age = 0;
    t.held = false;
    t.where = failure.where || "The run stopped before it finished.";
  }

  /** Starts a failed run again: its colleague takes the card, which lies down on the row it holds. */
  function retryRun(id) {
    var t = task(id);
    var was = { failed: t.failed, move: t.move, need: t.need, agent: t.agent, now: t.now, where: t.where, held: t.held, heldRow: t.heldRow };
    remember(t.name, function () { Object.assign(t, was); }, { id: id, reopen: true });
    t.agent = t.agent || t.failed.action;
    t.failed = null;
    t.move = "agent";
    t.need = "look";
    t.now = "Trying again.";
    t.where = "Trying again, from the start.";
    t.held = true;
    t.heldRow = 0;
  }

  /** Starts a thread on a Task: its colleague takes the card. A failure ends here too, because the Task has a new next move. */
  function startThread(id, prompt) {
    var t = task(id);
    var was = { move: t.move, agent: t.agent, now: t.now, threads: t.threads, need: t.need, failed: t.failed };
    remember(t.name, function () { Object.assign(t, was); });
    var title = prompt || "Thread on " + t.name;
    t.threads = t.threads.concat([{ title: title, id: "n" + Date.now() }]);
    t.agent = title;
    t.failed = null;
    t.move = "agent";
    t.need = "look";
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
    describeFailure: describeFailure,
    arrangeCell: arrangeCell,
    describePile: describePile,
    countAttention: countAttention,
    matches: matches,
    isFiltering: isFiltering,
    listWanting: listWanting,
    wantsYou: wantsYou,
    pickTop: pickTop,
    moveTask: moveTask,
    mergeTasks: mergeTasks,
    endTask: endTask,
    addTask: addTask,
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
