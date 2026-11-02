// PROTOTYPE - Expedition, the live window: "Every piece of work has a summit".
//
// The work is organized by how far it is from done. Every lead thread has a goal with a summit
// (its definition of done) and a route: the agent's own plan, ending in checks Hercule sees
// itself. The route line (expedition-route.js) is the atom every part of the window draws:
//   - the sidebar: today's 52px row, with the route line as line 2 (Routes, folded)
//   - the overview (⌘⇧O, the sidebar's Office button), in three modes:
//       Office   the Range, the office builder's 3D module (expedition-office.js), mounted here
//       Threads  Routes: the expedition ledger, one row per goal with its camps labelled
//       Board    a kanban that moves itself: Scoping, Building, Proving, Reviewing, Shipping, Landed
//   - the selection card, bottom left of the overview, shared by the three modes
//
// While the overview is open, a click on a sidebar row selects that thread in the overview (the
// Office flies to it); a double click, ↩ or the card's "Open thread" opens it.
//
// Keys: ⌘⇧O opens and closes the overview. In it: O, T and B pick the mode; ↑ and ↓ (or J and
// K) walk the selection; ↩ opens the selected thread; esc closes a popover, then the overview.
//
// URL: ?mode=office|threads|board, ?state=everyday|open|swarm|away|stuck|grew|move,
// ?theme=whitehaven|orient-express, ?select=<thread id or run id>.
(function () {
  "use strict";

  var W = window.WORLD;
  var X = W.expedition;
  var R = window.ExpeditionRoute;
  var params = new URLSearchParams(location.search);
  var STATE = document.documentElement.dataset.state || params.get("state") || "everyday";
  var MODES = ["office", "threads", "board"];
  var MODE_NAMES = { office: "Office", threads: "Threads", board: "Board" };
  var MODE_KEYS = { o: "office", t: "threads", b: "board" };
  var STATE_MODE = { away: "threads", stuck: "threads", grew: "threads", move: "board" };
  var STATE_SELECT = { stuck: "tDash", grew: "tResult", move: "tCart" };
  var AWAY_LEFT = W.away.left;
  var api;

  var ui = {
    overview: STATE !== "open",
    mode: MODES.indexOf(params.get("mode")) !== -1 ? params.get("mode") : STATE_MODE[STATE] || "office",
    selected: params.get("select") || STATE_SELECT[STATE] || "t3ds",
    // The first in your queue is shown on the card at load, but the Office opens on the whole
    // range unless a selection was asked for (?select=, a state's subject) or made since.
    chosen: !!(params.get("select") || STATE_SELECT[STATE]),
    group: "project", // the lens the sidebar and the ledger share: "project" or "stage"
    sort: "newest", // the ledger's order inside a group: "newest", "progress", "summit"
    unfolded: {}, // lead id -> its rope team is unfolded in the sidebar
    roped: {}, // lead id -> its partners' rows are shown in the ledger
    shelfOpen: false,
    seen: copy(STATE === "away" ? W.away.lastSeen : W.lastSeen),
    pop: null, // the open popover's name
    office: null, // the Office module's handle once mounted
    officeLoad: null, // "loading", "ready" or "missing"
    pointerOnBoard: false,
  };

  /* ------------------------------------------------------------------ small helpers */

  function copy(o) {
    var out = {};
    for (var k in o) out[k] = o[k];
    return out;
  }

  function esc(s) {
    return api.escapeHtml(s == null ? "" : s);
  }

  function minutes(time) {
    return W.helpers.minutes(time);
  }

  /** Returns a span of minutes as the window writes it: "11m", "1h 20m", "2h". */
  function formatSpan(m) {
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    var r = m % 60;
    return h + "h" + (r ? " " + r + "m" : "");
  }

  /** Returns a clock time "HH:MM" a number of minutes after 09:41. */
  function clockAfter(m) {
    var t = minutes(W.now) + m;
    var h = Math.floor(t / 60);
    var mm = t % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  /** Returns an icon from crew.js, or the direction's own glyph for the few it lacks. */
  function icon(name, size) {
    size = size || 16;
    if (name === "board")
      return '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.5" width="3.4" height="11" rx="1"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1"/><rect x="10.8" y="2.5" width="3.4" height="9" rx="1"/></svg>';
    if (name === "route")
      return '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12.5h3.5l3-5h2.5"/><circle cx="2" cy="12.5" r="1"/><path d="M11 7.5 12.8 3.2 14.6 7.5z"/></svg>';
    if (name === "range")
      return '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.2 13.2 5.6 5.4l2.6 4.3 1.9-2.9 4.7 6.4z"/><path d="M5.6 5.4V2.3l2 .8-2 .8"/></svg>';
    return Crew.icon(name, size);
  }

  /* ------------------------------------------------------------------ the world, read */

  function getThread(id) {
    return api.getThread(id);
  }

  function isRun(id) {
    return !!X.runRoutes[id];
  }

  function getRun(id) {
    return W.runs.filter(function (r) { return r.id === id; })[0];
  }

  /** Returns the live lead threads, in the world's order. */
  function listLeads() {
    return api.listThreads(function (t) { return !t.lead; });
  }

  /** Returns the threads of a lead's team that wait on Rogier, oldest ask first. */
  function listAskers(lead) {
    return api.listCrew(lead.id).filter(function (t) { return t.pose === "waiting"; }).sort(function (a, b) { return api.compareTimes(a.last, b.last); });
  }

  /** Returns every thread that waits on Rogier, newest ask first, as Waiting on you lists them. */
  function listWaiting() {
    return api.listThreads(function (t) { return t.pose === "waiting"; }).sort(function (a, b) { return api.compareTimes(b.last, a.last); });
  }

  /** Returns the runs whose step waits on Rogier. */
  function listWaitingRuns() {
    return W.runs.filter(function (r) { return r.steps.some(function (s) { return s.state === "waiting"; }); });
  }

  /** Returns the time the route last grew, or null. */
  function findGrewAt(goal) {
    var at = null;
    (goal.camps || []).forEach(function (c) {
      if (c.added && (!at || minutes(c.added) > minutes(at))) at = c.added;
    });
    return at;
  }

  /** Checks whether a route's growth is still news: Rogier has not had the thread open since it grew. */
  function isGrowthNews(t, goal) {
    if (!goal || !goal.grew) return false;
    var at = findGrewAt(goal);
    var seen = ui.seen[t.id];
    return !at || !seen || minutes(seen) < minutes(at);
  }

  /**
   * Returns the route model of a thread: its goal read into where it stands. A queued thread has
   * not run yet, so its agent has written no plan: it is setting out, with no camps to draw.
   */
  function buildRoute(t) {
    var goal = t.status === "queued" ? { summit: W.goals[t.id] ? W.goals[t.id].summit : "", camps: [] } : W.goals[t.id];
    return R.buildModel(goal, {
      thread: t,
      partners: t.lead ? [] : api.listPartners(t.id),
      since: STATE === "away" ? AWAY_LEFT : null,
      showGrew: isGrowthNews(t, goal),
    });
  }

  /** Returns the route model of a run: its workflow's steps as camps. */
  function buildRunRoute(run) {
    var waiting = run.steps.some(function (s) { return s.state === "waiting"; });
    return R.buildModel(X.runRoutes[run.id], { thread: { title: run.workflow, pose: waiting ? "waiting" : run.status === "running" ? "working" : "idle" } });
  }

  /** Returns how long a lead's goal has been in its stage, in minutes. */
  function minutesInStage(goal) {
    return minutes(W.now) - minutes(goal.stageSince);
  }

  /** Returns the stage record of an id. */
  function findStage(id) {
    return X.stages.filter(function (s) { return s.id === id; })[0];
  }

  /** Returns the summit ETA words of a lead: "~10:06-10:26", with what the clock waits on. */
  function describeEta(t) {
    var goal = W.goals[t.id];
    if (!goal) return null;
    var m = buildRoute(t);
    if (m.landed) return { main: "Landed " + goal.lastProgress, sub: "", landed: true };
    var e = X.summitEta[t.id];
    if (!e) return { main: "-", sub: "" };
    if (!e.range) return { main: e.after ? "After " + e.after : "Can't tell", sub: e.short || e.basis, basis: e.basis, unknown: true };
    return { main: "~" + clockAfter(e.range[0]) + "-" + clockAfter(e.range[1]), sub: e.after ? "once you answer" : "in " + e.range[0] + "-" + e.range[1] + "m", basis: e.basis, after: e.after };
  }

  /* ------------------------------------------------------------------ pieces of markup */

  function drawFace(t, size, pose) {
    return api.drawFace(t, size, pose);
  }

  /** Returns the row's right column on line 2: where the route stands, in words. */
  function drawProgress(m) {
    if (m.stuckMin) return '<span class="ex-prog is-stuck" title="No camp reached in ' + m.stuckMin + 'm">' + R.icons.cloud + m.stuckMin + "m</span>";
    if (m.grew) return '<span class="ex-prog is-grew" title="The plan grew by ' + m.grew + ' camps">+' + m.grew + " camps</span>";
    return '<span class="ex-prog' + (m.landed ? " is-landed" : "") + '">' + R.describeProgress(m) + "</span>";
  }

  /** Returns a project's rug and name. */
  function drawProject(projectId) {
    var p = api.getProject(projectId);
    return p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj ex-noproj">No project</span>';
  }

  /** Returns the answer buttons of a Request that waits on Rogier. */
  function drawAnswers(id, size) {
    var list = X.answers[id] || [];
    return list.map(function (a, i) {
      var cls = "btn" + (size === "sm" ? " btn--sm" : "") + (a.kind === "accent" ? " btn--accent" : a.kind === "quiet" ? " btn--quiet" : a.kind === "danger" ? " btn--danger" : "");
      return '<button class="' + cls + '" data-answer="' + id + '" data-answer-i="' + i + '">' + esc(a.label) + "</button>";
    }).join("");
  }

  /** Returns the ask of a waiting thread as a lead's row says it: "check asks · ..." for a partner. */
  function drawAsk(t, long) {
    var text = long ? t.ask : t.askShort || t.ask;
    return t.lead ? '<b class="ex-asker">' + esc(t.role || "partner") + "</b> asks · " + esc(text) : esc(text);
  }

  /* ------------------------------------------------------------------ the sidebar: Routes, folded */

  /** Returns a lead's row: today's 52px row with the route line as line 2. */
  function drawRouteRow(t, opts) {
    opts = opts || {};
    var m = buildRoute(t);
    var slot = api.decideSlot(t);
    var crew = api.listCrew(t.id);
    var spokes = api.pickSpokesperson(crew);
    // The row speaks with its most urgent member's voice: a partner's question shows on the lead.
    if (spokes.pose === "waiting" && t.pose !== "waiting") slot = api.decideSlot(spokes);
    var selected = isRowSelected(t.id);
    var receded = t.pose === "working" && spokes.pose !== "waiting" && !selected;
    var partners = api.listPartners(t.id);
    var glyph = ui.group === "stage" ? '<span class="ex-rug proj' + (api.getProject(t.project) ? " proj--" + api.getProject(t.project).tint : " ex-rug--none") + '"></span>' : api.drawBrand(t, 12);
    var html =
      '<div class="st-thread ex-row' + (receded ? " is-receded" : "") + (ui.unfolded[t.id] ? " is-unfolded" : "") + '" data-thread="' + t.id + '">' +
      '<a class="side-row' + (selected ? " is-on" : "") + '" href="#" data-open-row="' + t.id + '">' +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name">' + esc(t.title) + '</span><span class="side-end st-end--' + slot.kind + '">' + slot.text + "</span></span>" +
      '<span class="st-detail ex-detail"><span class="st-glyph">' + glyph + "</span>" + R.drawRoute(m, { variant: "row", id: t.id }) + drawProgress(m) + "</span>" +
      "</span></a>";
    if (partners.length) {
      var roles = partners.map(function (p) { return p.role || "partner"; }).join(", ");
      html += '<button class="ex-rope-btn" data-unfold="' + t.id + '" aria-expanded="' + !!ui.unfolded[t.id] + '" title="' + (ui.unfolded[t.id] ? "Fold the rope team" : "Roped to it: " + esc(roles) + ". Show their routes") + '"></button>';
    }
    if (ui.unfolded[t.id]) html += '<div class="ex-plines">' + partners.map(drawPartnerLine).join("") + "</div>";
    return html + "</div>";
  }

  /** Returns a partner's 30px line under its unfolded lead: face, role, its own mini route, status. */
  function drawPartnerLine(p) {
    var m = buildRoute(p);
    var slot = api.decideSlot(p);
    var end = slot.kind === "age" ? (m.landed ? "landed" : slot.text) : slot.text;
    return (
      '<a class="ex-pline' + (isRowSelected(p.id) ? " is-on" : "") + '" href="#" data-open-row="' + p.id + '" title="' + esc(p.title) + '">' +
      drawFace(p, 18) +
      '<span class="ex-pline-role">' + esc(p.role || "partner") + "</span>" +
      R.drawRoute(m, { variant: "mini" }) +
      '<span class="ex-pline-end st-end--' + slot.kind + '">' + end + "</span></a>"
    );
  }

  function isRowSelected(id) {
    return ui.overview ? ui.selected === id : api.openId() === id;
  }

  /** Returns Waiting on you: faces and asks, as today; the run's step under "From runs". */
  function drawWaitingSection() {
    var waiting = listWaiting();
    var runs = listWaitingRuns();
    if (!waiting.length && !runs.length) return "";
    var shown = waiting.slice(0, 3);
    return (
      '<section class="side-sec ex-waiting"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + (waiting.length + runs.length) + "</b></h3>" +
      shown.map(function (t) {
        var lead = api.findLead(t);
        return '<a class="side-row side-row--wait' + (isRowSelected(t.id) ? " is-on" : "") + '" href="#" data-open-row="' + t.id + '">' + drawFace(t, 24, "waiting") + '<span class="side-text"><span class="side-name">' + esc(lead.title) + '</span><span class="side-ask">' + drawAsk(t) + "</span></span></a>";
      }).join("") +
      (waiting.length > 3 ? '<a class="side-row st-more" href="#">' + (waiting.length - 3) + " more waiting on you</a>" : "") +
      (runs.length ? '<h4 class="side-sub">From runs</h4>' : "") +
      runs.map(function (r) {
        var ask = W.waitingRuns.filter(function (w) { return w.id === r.steps.filter(function (s) { return s.state === "waiting"; })[0].sessionId; })[0];
        return '<a class="side-row side-row--wait' + (isRowSelected(r.id) ? " is-on" : "") + '" href="#" data-open-row="' + r.id + '"><span class="side-lead">' + Crew.mark("waiting") + '</span><span class="side-text"><span class="side-name">' + esc(ask ? ask.title : r.title) + '</span><span class="side-ask">' + esc(ask ? ask.ask : r.waitingAsk) + "</span></span></a>";
      }).join("") +
      "</section>"
    );
  }

  /** Returns the leads a project's sidebar section shows: the ones that need Rogier or work first, five at most, in the project's order. */
  function pickShown(leads) {
    var rank = function (l) {
      var s = api.pickSpokesperson(api.listCrew(l.id));
      return s.pose === "waiting" ? 0 : s.pose === "working" ? 1 : 2;
    };
    var picked = leads.slice().sort(function (a, b) { return rank(a) - rank(b) || api.compareTimes(b.started, a.started); }).slice(0, 5);
    var sel = ui.overview ? ui.selected : api.openId();
    var selThread = getThread(sel);
    var selLead = selThread ? api.findLead(selThread) : null;
    if (selLead && leads.indexOf(selLead) !== -1 && picked.indexOf(selLead) === -1) picked.push(selLead);
    return leads.filter(function (l) { return picked.indexOf(l) !== -1; });
  }

  /** Returns the projects in the sidebar's order: the one whose newest lead started last comes first. */
  function orderProjects() {
    var newest = function (id) {
      var l = api.listLeads(id)[0];
      return l ? l.started : "Sun 00:00";
    };
    return W.projects.map(function (p) { return p.id; }).sort(function (a, b) {
      return api.compareTimes(newest(b), newest(a));
    });
  }

  function drawProjectSection(projectId) {
    var leads = api.listLeads(projectId);
    if (!leads.length) return "";
    var p = api.getProject(projectId);
    var need = api.listThreads(function (t) { return t.project === projectId && t.pose === "waiting"; }).length;
    var shown = pickShown(leads);
    var hidden = leads.length - shown.length + (STATE === "swarm" && p ? Math.round(W.swarm.more[p.id] / 1.6) : 0);
    return (
      '<section class="side-sec">' +
      '<h3 class="side-h side-h--proj">' + drawProject(projectId) +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '<button class="icon-btn icon-btn--sm" title="New thread in ' + (p ? p.name : "no project") + '">' + Crew.icon("plus", 14) + "</button></h3>" +
      shown.map(function (l) { return drawRouteRow(l); }).join("") +
      (hidden > 0 ? '<a class="side-row st-more" href="#">' + hidden + " more</a>" : "") +
      "</section>"
    );
  }

  /** Returns the sidebar grouped by stage: the Board, folded. Waiting on you stays on top. */
  function drawStageSections() {
    var leads = listLeads();
    return X.stages.map(function (s) {
      var list = leads.filter(function (l) { return W.goals[l.id] && W.goals[l.id].stage === s.id; }).sort(function (a, b) { return api.compareTimes(b.started, a.started); });
      if (!list.length) return "";
      var shown = s.id === "landed" ? list.slice(0, 3) : list;
      return (
        '<section class="side-sec"><h3 class="side-h ex-stage-h"><span>' + s.name + '</span><b class="count">' + list.length + "</b></h3>" +
        shown.map(function (l) { return drawRouteRow(l); }).join("") +
        (list.length > shown.length ? '<a class="side-row st-more" href="#">' + (list.length - shown.length) + " more</a>" : "") +
        "</section>"
      );
    }).join("");
  }

  function drawShelf() {
    return '<section class="side-sec ex-shelf"><h3 class="side-h"><button class="ex-shelf-btn" aria-expanded="false">' + Crew.icon("chev-r", 12) + '<span>Done</span><b class="count">' + W.doneCount + "</b></button></h3></section>";
  }

  /** Returns the lens row above the list: what the list is grouped by. The ledger shares it. */
  function drawLens() {
    return (
      '<div class="ex-lens">' +
      '<span class="ex-lens-name">' + icon("route", 14) + "Routes</span>" +
      '<button class="ex-lens-btn" data-pop="lens-side" aria-haspopup="menu" title="Group the routes">by <b>' + (ui.group === "stage" ? "stage" : "project") + "</b>" + Crew.icon("chev-d", 12) + "</button>" +
      "</div>"
    );
  }

  function drawList() {
    var el = api.els.list;
    var keep = el.scrollTop;
    var body = ui.group === "stage" ? drawStageSections() : orderProjects().map(drawProjectSection).join("") + drawProjectSection(null);
    el.innerHTML = drawWaitingSection() + body + drawShelf();
    el.scrollTop = keep;
    markListEdges();
    var lens = api.els.side.querySelector(".ex-lens");
    if (!lens) {
      el.insertAdjacentHTML("beforebegin", drawLens());
    } else {
      lens.outerHTML = drawLens();
    }
    // The foot counts the run's step that waits on Rogier too, so every count of "waiting" agrees.
    var c = api.countByPose();
    var waiting = c.waiting + listWaitingRuns().length;
    api.els.sum.innerHTML = "<b>" + c.working + "</b> working · <b" + (waiting ? ' class="you-ink"' : "") + ">" + waiting + "</b> waiting · <b>" + c.idle + "</b> idle";
    var officeBtn = api.els.side.querySelector('.side-actions .icon-btn[title^="The office"]');
    if (officeBtn) {
      officeBtn.classList.add("ex-office-btn");
      officeBtn.setAttribute("aria-pressed", ui.overview ? "true" : "false");
      officeBtn.title = "The overview ⌘⇧O";
    }
  }

  /** Marks whether the sidebar's list has more rows above or below its visible part, for the edge fades. */
  function markListEdges() {
    var el = api.els.list;
    el.classList.toggle("is-more-above", el.scrollTop > 2);
    el.classList.toggle("is-more-below", el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  }

  /* ------------------------------------------------------------------ the open thread's header */

  /** Returns the open thread's route as a strip under its tabs: summit, route, where it stands, ETA. */
  function drawRouteStrip(t) {
    var goal = W.goals[t.id];
    if (!goal) return "";
    var m = buildRoute(t);
    var lead = api.findLead(t);
    var e = describeEta(lead);
    return (
      '<button class="ex-hstrip glass" data-strip="' + t.id + '" title="See every route in the overview (⌘⇧O)">' +
      '<span class="ex-hstrip-summit">' + R.icons.peak + "<span>" + esc(goal.summit) + "</span></span>" +
      R.drawRoute(m, { variant: "card" }) +
      drawProgress(m) +
      (e && !t.lead ? '<span class="ex-hstrip-eta">' + esc(e.main) + "</span>" : "") +
      "</button>"
    );
  }

  /* ------------------------------------------------------------------ the overview */

  var ov = {}; // the overview's elements

  function buildOverview() {
    var sec = document.createElement("section");
    sec.className = "ex-ov";
    sec.setAttribute("aria-label", "Overview");
    sec.innerHTML =
      '<header class="top ex-top">' +
      '<nav class="pill ex-switch" aria-label="Mode">' +
      MODES.map(function (mode) {
        var ic = mode === "office" ? icon("range", 15) : mode === "threads" ? icon("list", 15) : icon("board", 15);
        return '<button class="ptab" data-mode="' + mode + '" aria-pressed="false" title="' + MODE_NAMES[mode] + " (" + mode.charAt(0).toUpperCase() + ')">' + ic + MODE_NAMES[mode] + "</button>";
      }).join("") +
      "</nav>" +
      '<span class="ex-tools" data-tools></span>' +
      '<span class="spacer"></span>' +
      '<span class="pill ex-sum" data-sum aria-label="Who is doing what"></span>' +
      '<span class="pill"><button class="pill-btn ex-close" data-close title="Close the overview">Close<kbd>esc</kbd></button></span>' +
      "</header>" +
      '<div class="ex-panes">' +
      '<div class="ex-pane ex-pane--office" data-mode-pane="office"><div class="ex-office" data-office-host></div></div>' +
      '<div class="ex-pane ex-pane--threads" data-mode-pane="threads"><div class="ex-ledger" data-ledger></div></div>' +
      '<div class="ex-pane ex-pane--board" data-mode-pane="board"><div class="ex-board" data-board></div></div>' +
      "</div>" +
      '<div class="ex-card glass" data-card role="region" aria-label="Selected thread"></div>';
    api.els.app.appendChild(sec);
    // The popover and the tooltip belong to the whole window, so the sidebar's lens can open one too.
    api.els.app.insertAdjacentHTML("beforeend", '<div class="ex-pop pop" data-pop-el hidden></div><div class="ex-tip" data-tip-el role="tooltip" hidden></div>');
    ov.el = sec;
    ov.tools = sec.querySelector("[data-tools]");
    ov.sum = sec.querySelector("[data-sum]");
    ov.ledger = sec.querySelector("[data-ledger]");
    ov.board = sec.querySelector("[data-board]");
    ov.officeHost = sec.querySelector("[data-office-host]");
    ov.card = sec.querySelector("[data-card]");
    ov.pop = api.els.app.querySelector("[data-pop-el]");
    ov.tip = api.els.app.querySelector("[data-tip-el]");
  }

  /** Draws the overview's top bar: the pressed mode, the mode's own controls, and the counts. */
  function drawTop() {
    ov.el.querySelectorAll(".ex-switch [data-mode]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.mode === ui.mode ? "true" : "false");
      b.classList.toggle("is-on", b.dataset.mode === ui.mode);
    });
    var tools = "";
    if (ui.mode === "threads") {
      tools =
        '<span class="pill ex-lensbar">' +
        '<button class="pill-btn" data-pop="lens-group" aria-haspopup="menu">' + Crew.icon("filter", 14) + '<span class="faint">Group</span> ' + (ui.group === "stage" ? "Stage" : "Project") + Crew.icon("chev-d", 12) + "</button>" +
        '<span class="pill-sep"></span>' +
        '<button class="pill-btn" data-pop="lens-sort" aria-haspopup="menu"><span class="faint">Sort</span> ' + { newest: "Newest", progress: "Furthest along", summit: "Soonest summit" }[ui.sort] + Crew.icon("chev-d", 12) + "</button>" +
        "</span>";
    } else if (ui.mode === "board") {
      tools = '<span class="pill ex-boardnote" title="Hercule moves a card when it sees the signal: a first edit, a first test run, a partner starting, a PR, CI, the merge.">' + icon("bolt", 14) + "Cards move when the work does</span>";
    }
    ov.tools.innerHTML = tools;
    var c = api.countByPose();
    ov.sum.innerHTML =
      "<span>" + Crew.mark("working") + "<b>" + c.working + "</b> working</span>" +
      '<span class="ex-sum-you">' + Crew.mark("waiting") + "<b>" + (c.waiting + listWaitingRuns().length) + "</b> waiting on you</span>" +
      "<span>" + Crew.mark("idle") + "<b>" + c.idle + "</b> idle</span>";
  }

  function showOverview(open) {
    ui.overview = open;
    api.els.app.classList.toggle("ex-is-overview", open);
    closePop();
    if (open) drawOverview();
    else pauseOffice();
    drawList();
  }

  /** Draws everything the overview shows for the current mode. */
  function drawOverview() {
    if (!ui.overview) return;
    if (ov.el.dataset.ovMode && ov.el.dataset.ovMode !== ui.mode) {
      // The card moves between floating (Office) and docked (Threads, Board): fade it, never jump.
      ov.card.classList.remove("is-entering");
      void ov.card.offsetWidth;
      ov.card.classList.add("is-entering");
    }
    ov.el.dataset.ovMode = ui.mode;
    drawTop();
    ov.el.querySelectorAll("[data-mode-pane]").forEach(function (p) {
      p.classList.toggle("is-shown", p.dataset.modePane === ui.mode);
    });
    if (ui.mode === "threads") drawLedger();
    if (ui.mode === "board") drawBoard();
    if (ui.mode === "office") showOffice();
    else pauseOffice();
    drawCard();
  }

  function setMode(mode) {
    if (mode === ui.mode && ui.overview) return;
    ui.mode = mode;
    if (!ui.overview) showOverview(true);
    else drawOverview();
    revealSelection();
  }

  /**
   * Selects a thread or a run in every mode at once: the sidebar row, the ledger row, the card, the
   * bean. `fromOffice` is true when the Office asked, so the window does not echo it back.
   */
  function select(id, fromOffice) {
    ui.selected = id;
    ui.chosen = true;
    closePop();
    drawList();
    if (!ui.overview) return;
    ov.el.querySelectorAll("[data-select].is-selected").forEach(function (el) { el.classList.remove("is-selected"); });
    ov.el.querySelectorAll('[data-select="' + id + '"]').forEach(function (el) { el.classList.add("is-selected"); });
    var t = getThread(id);
    if (t && t.lead) ov.el.querySelectorAll('[data-select="' + t.lead + '"]').forEach(function (el) { el.classList.add("is-selected"); });
    drawCard();
    if (ui.office && ui.office.select && !fromOffice) ui.office.select(id && !isRun(id) ? id : null);
  }

  /** Scrolls the selected row or card into view inside its own pane, never the page. */
  function revealSelection() {
    var pane = ui.mode === "threads" ? ov.ledger : ui.mode === "board" ? ov.board.querySelector(".ex-cols") : null;
    if (!pane) return;
    var el = pane.querySelector('[data-select="' + ui.selected + '"]');
    if (!el) return;
    var pr = pane.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    if (r.top < pr.top + 40 || r.bottom > pr.bottom) pane.scrollTop += r.top - pr.top - 120;
  }

  /** Opens a thread in the main pane and closes the overview, as opening one in the app does. */
  function openThread(id) {
    if (isRun(id)) {
      api.showToast("The run page is not drawn in this prototype.");
      return;
    }
    if (!getThread(id)) return;
    ui.overview = false;
    api.els.app.classList.remove("ex-is-overview");
    pauseOffice();
    api.open(id);
  }

  /* ------------------------------------------------------------------ Threads mode: the ledger */

  /** Returns the leads of the ledger in the chosen order inside a group. */
  function sortLeads(list) {
    var key = {
      newest: function (t) { return -minutes(t.started); },
      progress: function (t) { var m = buildRoute(t); return -(m.landed ? 101 : m.headPct); },
      summit: function (t) {
        var e = X.summitEta[t.id];
        var m = buildRoute(t);
        return m.landed ? 9999 : e && e.range ? e.range[0] : 5000;
      },
    }[ui.sort];
    return list.slice().sort(function (a, b) { return key(a) - key(b); });
  }

  /** Returns the groups of the ledger: [{ key, head, leads }]. */
  function groupLeads() {
    var leads = listLeads().filter(function (l) { return W.goals[l.id]; });
    if (ui.group === "stage") {
      return X.stages.map(function (s) {
        return { key: s.id, stage: s, leads: sortLeads(leads.filter(function (l) { return W.goals[l.id].stage === s.id; })) };
      }).filter(function (g) { return g.leads.length; });
    }
    return orderProjects().concat([null]).map(function (pid) {
      return { key: pid || "none", project: pid, leads: sortLeads(leads.filter(function (l) { return l.project === pid; })) };
    }).filter(function (g) { return g.leads.length; });
  }

  function drawLedger() {
    var keep = ov.ledger.scrollTop;
    var groups = groupLeads();
    var html = drawLedgerIntro();
    html += drawLedgerWaiting();
    html += '<div class="ex-lhead"><span></span><span>Goal and its route</span><span>Stage</span><span>Summit, predicted</span><span>Rope team</span><span>Last camp</span></div>';
    groups.forEach(function (g) {
      var need = 0;
      g.leads.forEach(function (l) { need += listAskers(l).length; });
      var head = g.stage
        ? '<span class="ex-lgroup-name">' + g.stage.name + '</span><span class="faint">entered at ' + esc(g.stage.enters) + "</span>"
        : drawProject(g.project);
      html +=
        '<section class="ex-lgroup">' +
        '<h3 class="ex-lgroup-h">' + head + '<span class="ex-lgroup-count">' + g.leads.length + (g.leads.length === 1 ? " goal" : " goals") + "</span>" +
        (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
        "</h3>" +
        g.leads.map(drawGoalRow).join("") +
        "</section>";
    });
    html += drawLedgerRuns();
    html += '<p class="ex-lfoot">' + R.icons.peak + "A goal's last camps are checks Hercule sees itself: tests, review, PR, CI, the merge. Rings mark them; ticks are steps of the agent's own plan.</p>";
    ov.ledger.innerHTML = html;
    ov.ledger.scrollTop = keep;
    bindOverview(ov.ledger);
  }

  /** Returns the line above the ledger: what the morning amounts to; in the away state, what changed. */
  function drawLedgerIntro() {
    var leads = listLeads().filter(function (l) { return W.goals[l.id]; });
    var landed = 0, stuck = 0, grew = 0, under = 0;
    leads.forEach(function (l) {
      var m = buildRoute(l);
      if (m.landed) landed++;
      else under++;
      if (m.stuckMin) stuck++;
      if (m.grew) grew++;
    });
    if (STATE === "away") return drawCatchUp(leads);
    return (
      '<div class="ex-intro">' +
      '<h2 class="ex-intro-h">Routes</h2>' +
      '<p class="ex-intro-p"><b>' + leads.length + " goals</b> · " + under + " on the way · " + landed + " landed" +
      (stuck ? ' · <a href="#" data-select-link="' + firstWhere(leads, "stuck") + '">' + R.icons.cloud + stuck + " stuck</a>" : "") +
      (grew ? ' · <a href="#" data-select-link="' + firstWhere(leads, "grew") + '">' + grew + " grew</a>" : "") +
      "</p></div>"
    );
  }

  function firstWhere(leads, what) {
    for (var i = 0; i < leads.length; i++) {
      var m = buildRoute(leads[i]);
      if (what === "stuck" && m.stuckMin) return leads[i].id;
      if (what === "grew" && m.grew) return leads[i].id;
    }
    return "";
  }

  /** Returns the away state's catch-up: what moved while Rogier was out, in the order it matters. */
  function drawCatchUp(leads) {
    var climbed = 0, routes = 0, started = 0;
    var moved = [];
    leads.forEach(function (l) {
      var m = buildRoute(l);
      if (m.movedCamps > 0) {
        climbed += m.movedCamps;
        routes++;
        if (minutes(l.started) > minutes(AWAY_LEFT)) started++;
        moved.push({ t: l, m: m });
      }
    });
    moved.sort(function (a, b) { return b.m.movedCamps - a.m.movedCamps; });
    var waiting = listWaiting();
    var chips = [];
    // In the order it matters: what needs you, what is stuck, what changed shape, what climbed.
    chips.push('<a class="chip chip--you" href="#" data-select-link="' + waiting[waiting.length - 1].id + '">' + Crew.mark("waiting") + (waiting.length + listWaitingRuns().length) + " wait on you</a>");
    leads.forEach(function (l) {
      var m = buildRoute(l);
      if (m.stuckMin) chips.push('<a class="chip" href="#" data-select-link="' + l.id + '">' + R.icons.cloud + esc(l.title) + " · stuck " + m.stuckMin + "m</a>");
    });
    leads.forEach(function (l) {
      var m = buildRoute(l);
      if (m.grew) chips.push('<a class="chip" href="#" data-select-link="' + l.id + '" style="--hue:var(--hue-' + m.hue + ')"><i class="ex-chip-dot"></i>' + esc(l.title) + " · grew " + m.grew + " camps</a>");
    });
    var reported = api.listThreads(function (t) {
      var g = W.goals[t.id];
      return t.lead && g && g.stage === "landed" && minutes(g.lastProgress) > minutes(AWAY_LEFT);
    });
    if (reported.length) chips.push('<a class="chip" href="#" data-select-link="' + reported[0].id + '">' + Crew.mark("done") + reported.length + " partners reported back</a>");
    return (
      '<div class="ex-intro ex-catchup">' +
      '<h2 class="ex-intro-h">Back at ' + W.away.back + "</h2>" +
      '<p class="ex-intro-p">Away ' + (minutes(W.away.back) - minutes(AWAY_LEFT)) + " minutes. <b>" + routes + " routes climbed " + climbed + " camps</b>; you started " + started + " of them from your phone. Bright is new; faded is where a route stood when you left.</p>" +
      '<div class="ex-catchup-chips">' + chips.join("") + "</div>" +
      "</div>"
    );
  }

  /** Returns the ledger's Waiting on you: the asks with their answer buttons, one move each. */
  function drawLedgerWaiting() {
    var waiting = listWaiting().slice().reverse(); // oldest ask first: it has waited longest
    var runs = listWaitingRuns();
    if (!waiting.length && !runs.length) return "";
    var html = '<section class="ex-lwait"><h3 class="ex-lgroup-h ex-lwait-h"><span>Waiting on you</span><b class="count count--you">' + (waiting.length + runs.length) + "</b></h3>";
    waiting.forEach(function (t) {
      var lead = api.findLead(t);
      html +=
        '<div class="ex-wrow" data-select="' + t.id + '">' +
        drawFace(t, 28, "waiting") +
        '<div class="ex-wrow-text"><span class="ex-wrow-title">' + esc(lead.title) + '</span><span class="ex-wrow-ask">' + drawAsk(t, true) + "</span></div>" +
        '<span class="ex-wrow-route">' + R.drawRoute(buildRoute(t), { variant: "row", tips: true }) + "</span>" +
        '<span class="ex-wrow-age">' + api.formatAge(t.last) + "</span>" +
        '<span class="ex-wrow-act">' + drawAnswers(t.id, "sm") + "</span>" +
        "</div>";
    });
    runs.forEach(function (r) {
      html +=
        '<div class="ex-wrow" data-select="' + r.id + '">' +
        '<span class="ex-wrow-mark">' + Crew.mark("waiting", 16) + "</span>" +
        '<div class="ex-wrow-text"><span class="ex-wrow-title">' + esc(r.title) + ' <span class="faint">· run</span></span><span class="ex-wrow-ask">' + esc(r.waitingAsk) + "</span></div>" +
        '<span class="ex-wrow-route">' + R.drawRoute(buildRunRoute(r), { variant: "row", tips: true }) + "</span>" +
        '<span class="ex-wrow-age">' + api.formatAge(W.runSessions.rShip.last) + "</span>" +
        '<span class="ex-wrow-act">' + drawAnswers("rShip", "sm") + "</span>" +
        "</div>";
    });
    return html + "</section>";
  }

  /** Returns one goal's ledger row: face, title and summit, stage, ETA, rope team, last camp; then the wide route with every camp labelled. */
  function drawGoalRow(t) {
    var goal = W.goals[t.id];
    var m = buildRoute(t);
    var partners = api.listPartners(t.id);
    var askers = listAskers(t);
    var e = describeEta(t);
    var stage = findStage(goal.stage);
    var inStage = minutesInStage(goal);
    var spokes = api.pickSpokesperson(api.listCrew(t.id));
    var chip = askers.length ? '<span class="chip chip--you ex-chip">' + (askers[0].status === "approval" ? "Approval" : "Question") + (askers[0].lead ? " · " + esc(askers[0].role) : "") + "</span>" : spokes.pose === "working" ? '<span class="ex-working">' + Crew.mark("working") + "Working</span>" : "";
    var html =
      '<div class="ex-goal' + (ui.selected === t.id || partners.some(function (p) { return p.id === ui.selected; }) ? " is-selected" : "") + (m.landed ? " is-landed" : "") + '" data-select="' + t.id + '">' +
      '<span class="ex-goal-face">' + drawFace(t, 28) + "</span>" +
      '<div class="ex-goal-main"><div class="ex-goal-title"><b>' + esc(t.title) + "</b>" + chip + "</div>" +
      '<div class="ex-goal-summit">' + R.icons.peak + '<span>' + esc(goal.summit) + "</span>" + (m.grew ? '<span class="ex-grew-note">+' + m.grew + " camps at " + esc(findGrewAt(goal)) + "</span>" : "") + "</div></div>" +
      '<div class="ex-goal-stage"><b>' + stage.name + '</b><span class="faint">' + (goal.stage === "landed" ? "since " + esc(goal.stageSince) : "for " + formatSpan(inStage)) + "</span></div>" +
      '<div class="ex-goal-eta' + (e.unknown ? " is-unknown" : "") + '"' + (e.basis ? ' data-tip="' + esc(e.basis) + '"' : "") + "><b>" + esc(e.main) + '</b><span class="faint">' + esc(e.sub || "") + "</span></div>" +
      '<div class="ex-goal-rope">' + drawRope(t, partners) + "</div>" +
      '<div class="ex-goal-last">' + drawLastCamp(t, m) + "</div>" +
      '<div class="ex-goal-route">' + R.drawRoute(m, { variant: "wide", tips: true, id: t.id, ghostAt: AWAY_LEFT }) + "</div>" +
      "</div>";
    if (ui.roped[t.id] && partners.length) {
      html += '<div class="ex-partners">' + partners.map(drawPartnerRow).join("") + "</div>";
    }
    return html;
  }

  /** Returns a lead's rope team: the lead and its partners as a face pile, a button that shows their routes. */
  function drawRope(t, partners) {
    if (!partners.length) return '<span class="faint ex-alone">alone</span>';
    return (
      '<button class="ex-rope" data-rope="' + t.id + '" aria-expanded="' + !!ui.roped[t.id] + '" title="' + (ui.roped[t.id] ? "Hide" : "Show") + " the partners' routes\">" +
      '<span class="stack">' + [t].concat(partners).map(function (p) { return drawFace(p, 20, p.pose === "waiting" ? "waiting" : "idle"); }).join("") + "</span>" +
      Crew.icon("chev-d", 12) +
      "</button>"
    );
  }

  /** Returns a partner's row under its lead in the ledger: its role, its own route, its state. */
  function drawPartnerRow(p) {
    var m = buildRoute(p);
    var goal = W.goals[p.id];
    var slot = api.decideSlot(p);
    return (
      '<div class="ex-prow' + (ui.selected === p.id ? " is-selected" : "") + '" data-select="' + p.id + '">' +
      '<span class="ex-prow-face">' + drawFace(p, 20) + "</span>" +
      '<div class="ex-prow-main"><b>' + esc(p.role || "partner") + '</b><span class="faint">' + esc(p.title) + "</span></div>" +
      '<div class="ex-prow-route">' + R.drawRoute(m, { variant: "card", tips: true }) + "</div>" +
      '<div class="ex-prow-summit faint">' + R.icons.peak + esc(goal ? goal.summit : "") + "</div>" +
      '<div class="ex-prow-end st-end--' + slot.kind + '">' + (slot.kind === "age" ? (m.landed ? "landed " + esc(goal.lastProgress) : "idle " + slot.text) : slot.text) + "</div>" +
      "</div>"
    );
  }

  /** Returns a goal's last camp column: when it last reached a camp, or the cloud when it is stuck. */
  function drawLastCamp(t, m) {
    var goal = W.goals[t.id];
    if (m.stuckMin) return '<b class="ex-stuck" title="No camp reached in ' + m.stuckMin + 'm">' + R.icons.cloud + "stuck " + m.stuckMin + 'm</b><span class="faint">last camp ' + esc(goal.lastProgress) + "</span>";
    return "<b>" + esc(goal.lastProgress) + '</b><span class="faint">' + api.formatAge(goal.lastProgress) + " ago</span>";
  }

  /** Returns the ledger's runs: a run's route is its workflow's steps. */
  function drawLedgerRuns() {
    var runs = W.runs.filter(function (r) { return r.status !== "completed"; });
    return (
      '<section class="ex-lgroup ex-lruns"><h3 class="ex-lgroup-h"><span class="ex-lgroup-name">Runs</span><span class="ex-lgroup-count">' + runs.length + ' runs · each step is a camp</span></h3>' +
      runs.map(function (r) {
        var m = buildRunRoute(r);
        var waiting = r.steps.some(function (s) { return s.state === "waiting"; });
        var state = waiting ? "waiting" : r.status === "paused" ? "paused" : "working";
        var word = waiting ? '<span class="you-ink"><b>Approval</b></span>' : r.status === "paused" ? "Paused by a Bound" : '<span class="ex-working">' + Crew.mark("working") + "Working</span>";
        return (
          '<div class="ex-runrow" data-select="' + r.id + '">' +
          '<span class="ex-runrow-mark">' + Crew.mark(state) + "</span>" +
          '<div class="ex-runrow-main"><b>' + esc(r.title) + '</b><span class="faint">' + esc(r.workflow) + " · " + esc(r.machine) + "</span></div>" +
          '<div class="ex-runrow-route">' + R.drawRoute(m, { variant: "card", tips: true }) + "</div>" +
          '<div class="ex-runrow-end">' + word + "</div>" +
          "</div>"
        );
      }).join("") +
      "</section>"
    );
  }

  /* ------------------------------------------------------------------ Board mode: the kanban that moves itself */

  /** Returns the median of a list of numbers, or null for an empty list. */
  function median(list) {
    if (!list.length) return null;
    var s = list.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  /** Returns how long goals spent in a stage this morning: finished stays and stays still running. */
  function listStays(stageId) {
    var out = [];
    listLeads().forEach(function (l) {
      var h = X.stageHistory[l.id];
      if (!h) return;
      h.forEach(function (pair, i) {
        if (pair[0] !== stageId || stageId === "landed") return;
        var from = minutes(pair[1]);
        var to = i + 1 < h.length ? minutes(h[i + 1][1]) : minutes(W.now);
        if (from >= minutes("00:00")) out.push(to - from);
      });
    });
    return out;
  }

  function drawBoard() {
    var leads = listLeads().filter(function (l) { return W.goals[l.id]; });
    var cols = X.stages.map(function (s) {
      var list = leads.filter(function (l) { return W.goals[l.id].stage === s.id; }).sort(function (a, b) {
        return s.id === "landed" ? api.compareTimes(W.goals[b.id].stageSince, W.goals[a.id].stageSince) : api.compareTimes(W.goals[a.id].stageSince, W.goals[b.id].stageSince);
      });
      return { stage: s, leads: list };
    });
    // The bottleneck: the stage short of Landed that holds the most work.
    var neck = null;
    cols.forEach(function (c) {
      if (c.stage.id === "landed" || c.leads.length < 2) return;
      if (!neck || c.leads.length > neck.leads.length) neck = c;
    });
    var keep = ov.board.querySelector(".ex-cols");
    var keepTop = keep ? keep.scrollTop : 0;
    var html = '<div class="ex-cols">';
    cols.forEach(function (c) {
      var stays = listStays(c.stage.id);
      var med = median(stays);
      html +=
        '<section class="ex-col' + (c === neck ? " is-neck" : "") + '" data-col="' + c.stage.id + '">' +
        '<h3 class="ex-col-h"><span class="ex-col-top"><span class="ex-col-name">' + c.stage.name + '</span><b class="ex-col-count">' + c.leads.length + "</b></span>" +
        '<span class="ex-col-med" title="' + (c.stage.id === "landed" ? "Goals that reached their summit" : "Median time goals spent in " + c.stage.name + " this morning, over " + stays.length + (stays.length === 1 ? " stay" : " stays")) + '">' + (c.stage.id === "landed" ? "reached their summit" : med == null ? "nothing yet" : "median " + formatSpan(med) + " here") + "</span></h3>" +
        (c === neck ? drawNeck(c) : "") +
        '<div class="ex-col-cards">' + c.leads.map(drawBoardCard).join("") + (c.leads.length ? "" : '<p class="ex-col-empty">Nothing here now</p>') + "</div>" +
        "</section>";
    });
    html += "</div>";
    html += '<div class="ex-flow" data-flow>' + drawFlow() + "</div>";
    ov.board.innerHTML = html;
    ov.board.querySelector(".ex-cols").scrollTop = keepTop;
    bindOverview(ov.board);
    bindFlow();
  }

  /** Returns the bottleneck callout: how much the stage holds, and how much of it waits on Rogier. */
  function drawNeck(col) {
    var mine = col.leads.filter(function (l) { return listAskers(l).length; });
    return (
      '<div class="ex-neck' + (mine.length ? " is-yours" : "") + '">' +
      "<b>" + col.stage.name + " holds " + col.leads.length + ".</b> " +
      (mine.length ? '<span class="ex-neck-you">' + mine.length + (mine.length === 1 ? " of them waits on you." : " of them wait on you.") + "</span>" + '<a href="#" data-select-link="' + listAskers(mine[0])[0].id + '">Answer the first</a>' : "None of them waits on you.") +
      "</div>"
    );
  }

  /** Returns one Board card: title, rope team, mini route, time in stage, and the signal that moved it. */
  function drawBoardCard(t) {
    var goal = W.goals[t.id];
    var m = buildRoute(t);
    var partners = api.listPartners(t.id);
    var askers = listAskers(t);
    var mv = X.movedBy[t.id];
    var sel = ui.selected === t.id || partners.some(function (p) { return p.id === ui.selected; });
    // The away state: a card that changed column while Rogier was out says where it was.
    var was = STATE === "away" ? findStageAt(t.id, minutes(AWAY_LEFT)) : null;
    var wasLine = STATE === "away" && was !== goal.stage ? '<div class="ex-bcard-was">' + (was ? "was in " + findStage(was).name + " at " + AWAY_LEFT : "started after " + AWAY_LEFT) + "</div>" : "";
    return (
      '<article class="ex-bcard' + (sel ? " is-selected" : "") + (m.landed ? " is-landed" : "") + (askers.length ? " is-asking" : "") + '" data-select="' + t.id + '" data-card-id="' + t.id + '">' +
      '<div class="ex-bcard-head">' + drawFace(t, 22) + '<b class="ex-bcard-title">' + esc(t.title) + "</b></div>" +
      R.drawRoute(m, { variant: "mini", tips: true }) +
      '<div class="ex-bcard-meta">' +
      (askers.length ? '<span class="ex-bcard-ask">' + Crew.mark("waiting") + (askers[0].status === "approval" ? "Approval" : "Question") + "</span>" : m.stuckMin ? '<span class="ex-bcard-stuck">' + R.icons.cloud + m.stuckMin + "m</span>" : '<span class="faint">' + (goal.stage === "landed" ? "landed " + esc(goal.stageSince) : minutesInStage(goal) < 1 ? "just now" : formatSpan(minutesInStage(goal)) + " here") + "</span>") +
      '<span class="ex-bcard-prog">' + (m.settingOut ? "setting out" : m.done + " of " + m.total) + "</span>" +
      (partners.length ? '<span class="stack">' + partners.map(function (p) { return drawFace(p, 18, p.pose === "waiting" ? "waiting" : "idle"); }).join("") + "</span>" : "") +
      "</div>" +
      wasLine +
      (mv ? '<div class="ex-bcard-moved" title="Moved here by: ' + esc(mv.signal) + ", " + esc(mv.at) + '">' + icon("bolt", 12) + '<span class="ex-bcard-signal">' + esc(mv.signal) + '</span><span class="ex-bcard-at">' + esc(mv.at) + "</span></div>" : "") +
      "</article>"
    );
  }

  /* ------------------------------------------------------------------ the Board's cumulative flow */

  var FLOW_FROM = "07:00";
  var FLOW_ORDER = ["landed", "shipping", "reviewing", "proving", "building", "scoping"]; // bottom to top

  /** Returns the stage a lead's goal was in at a minute, or null before it started. */
  function findStageAt(id, minute) {
    var h = X.stageHistory[id];
    if (!h) return null;
    var stage = null;
    h.forEach(function (pair) {
      if (minutes(pair[1]) <= minute) stage = pair[0];
    });
    return stage;
  }

  /** Returns the morning's counts per stage, one entry per minute from 07:00 to now. */
  function buildFlow() {
    var from = minutes(FLOW_FROM);
    var to = minutes(W.now);
    var leads = listLeads().filter(function (l) { return X.stageHistory[l.id]; });
    var rows = [];
    for (var m = from; m <= to; m++) {
      var row = { m: m };
      FLOW_ORDER.forEach(function (s) { row[s] = 0; });
      leads.forEach(function (l) {
        var s = findStageAt(l.id, m);
        if (s) row[s]++;
      });
      rows.push(row);
    }
    return { rows: rows, from: from, to: to, max: leads.length };
  }

  function drawFlow() {
    var f = buildFlow();
    var Wd = 1100, H = 84, top = 4;
    var x = function (m) { return ((m - f.from) / (f.to - f.from)) * Wd; };
    var y = function (v) { return top + H - (v / Math.max(1, f.max)) * H; };
    var bands = "";
    var ends = [];
    // The bands are drawn from a sample every five minutes (and now), joined by straight lines, so
    // a one-minute stay does not leave a sliver; the hover reads the exact minute.
    var samples = f.rows.filter(function (r, i) { return (r.m - f.from) % 5 === 0 || i === f.rows.length - 1; });
    FLOW_ORDER.forEach(function (s, si) {
      var below = function (r) { var v = 0; for (var i = 0; i < si; i++) v += r[FLOW_ORDER[i]]; return v; };
      var upper = samples.map(function (r, i) { return (i ? "L" : "M") + x(r.m).toFixed(1) + " " + y(below(r) + r[s]).toFixed(1); }).join("");
      var lower = samples.slice().reverse().map(function (r) { return "L" + x(r.m).toFixed(1) + " " + y(below(r)).toFixed(1); }).join("");
      bands += '<path class="ex-flow-band ex-flow-band--' + s + '" d="' + upper + lower + 'Z"/>';
      var last = f.rows[f.rows.length - 1];
      if (last[s] > 0) ends.push({ y: y(below(last) + last[s] / 2), text: findStage(s).name + " " + last[s] });
    });
    // The end labels sit beside their bands, pushed apart where thin bands would make them collide.
    ends.sort(function (a, b) { return a.y - b.y; });
    for (var k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 12);
    var overflow = ends.length ? ends[ends.length - 1].y - (top + H) : 0;
    if (overflow > 0) ends.forEach(function (e) { e.y -= overflow; });
    var labels = ends.map(function (e) { return '<span class="ex-flow-end" style="top:' + e.y.toFixed(1) + 'px">' + e.text + "</span>"; }).join("");
    var ticks = "";
    for (var h = 7; h <= 9; h++) {
      var mm = h * 60;
      ticks += '<span class="ex-flow-tick" style="left:' + ((x(mm) / Wd) * 100).toFixed(2) + '%">0' + h + ":00</span>";
      ticks += '<span class="ex-flow-tick is-half" style="left:' + ((x(mm + 30) / Wd) * 100).toFixed(2) + '%">0' + h + ":30</span>";
    }
    var away = "";
    if (STATE === "away") {
      var ax = (x(minutes(AWAY_LEFT)) / Wd) * 100;
      away = '<span class="ex-flow-away" style="left:' + ax.toFixed(2) + "%;width:" + (100 - ax).toFixed(2) + '%"><span>while you were away</span></span>';
    }
    return (
      '<div class="ex-flow-h"><b>The morning</b><span class="faint">goals in each stage, ' + FLOW_FROM + " to " + W.now + "</span>" +
      '<span class="ex-flow-legend">' + FLOW_ORDER.slice().reverse().map(function (s) { return '<span><i class="ex-flow-key ex-flow-band--' + s + '"></i>' + findStage(s).name + "</span>"; }).join("") + "</span></div>" +
      '<div class="ex-flow-plot" data-flow-plot>' +
      '<svg class="ex-flow-svg" viewBox="0 0 ' + Wd + " " + (H + top) + '" preserveAspectRatio="none" aria-label="Goals in each stage over the morning">' + bands + "</svg>" +
      away +
      '<span class="ex-flow-now">now ' + W.now + "</span>" +
      '<div class="ex-flow-ends">' + labels + "</div>" +
      '<span class="ex-flow-cross" data-flow-cross hidden></span>' +
      "</div>" +
      '<div class="ex-flow-axis">' + ticks + "</div>"
    );
  }

  /** Wires the flow strip's hover: a crosshair and the counts at that minute. */
  function bindFlow() {
    var plot = ov.board.querySelector("[data-flow-plot]");
    if (!plot) return;
    var cross = plot.querySelector("[data-flow-cross]");
    var f = buildFlow();
    plot.addEventListener("mousemove", function (e) {
      var r = plot.getBoundingClientRect();
      var frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      var row = f.rows[Math.round(frac * (f.rows.length - 1))];
      cross.hidden = false;
      cross.style.left = frac * 100 + "%";
      var h = Math.floor(row.m / 60), mm = row.m % 60;
      var clock = (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
      showTip(e.clientX, r.top, "<b>" + clock + "</b><br>" + FLOW_ORDER.slice().reverse().filter(function (s) { return row[s]; }).map(function (s) { return findStage(s).name + " " + row[s]; }).join(" · ") || "nothing yet");
    });
    plot.addEventListener("mouseleave", function () {
      cross.hidden = true;
      hideTip();
    });
  }

  /* ------------------------------------------------------------------ Office mode: the Range */

  /** Loads the Office module's files the first time the Office is shown, then mounts it. */
  function loadOffice(done) {
    if (ui.officeLoad === "ready" || ui.officeLoad === "missing") return done();
    if (ui.officeLoad === "loading") return;
    ui.officeLoad = "loading";
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "expedition-office.css";
    document.head.appendChild(css);
    var kit = document.createElement("script");
    kit.src = "../vendor/office-kit.js";
    kit.onload = function () {
      var mod = document.createElement("script");
      mod.src = "expedition-office.js";
      mod.onload = function () {
        ui.officeLoad = window.OfficeModes && window.OfficeModes.expedition ? "ready" : "missing";
        done();
      };
      mod.onerror = function () {
        ui.officeLoad = "missing";
        done();
      };
      document.body.appendChild(mod);
    };
    kit.onerror = function () {
      ui.officeLoad = "missing";
      done();
    };
    document.body.appendChild(kit);
  }

  function showOffice() {
    if (ui.office) {
      if (ui.office.resume) ui.office.resume();
      if (ui.office.select && ui.chosen) ui.office.select(ui.selected && !isRun(ui.selected) ? ui.selected : null);
      return;
    }
    if (!ov.officeHost.firstChild) ov.officeHost.innerHTML = drawFlatRange(true);
    loadOffice(function () {
      if (ui.officeLoad !== "ready" || ui.office) {
        if (ui.officeLoad === "missing") {
          ov.officeHost.innerHTML = drawFlatRange(false);
          bindOverview(ov.officeHost);
        }
        return;
      }
      ov.officeHost.innerHTML = "";
      try {
        ui.office = mountOffice();
      } catch (err) {
        // A module that fails to mount leaves the flat Range, which tells the same truth.
        ui.officeLoad = "missing";
        ov.officeHost.innerHTML = drawFlatRange(false);
        bindOverview(ov.officeHost);
        throw err;
      }
      if (ui.mode !== "office" || !ui.overview) pauseOffice();
    });
  }

  /** Mounts the office builder's module into the Office pane, with the window's state and selection. */
  function mountOffice() {
    return window.OfficeModes.expedition.mount(ov.officeHost, {
      world: W,
      theme: document.documentElement.dataset.theme === "orient-express" || document.documentElement.dataset.theme === "dark" ? "orient-express" : "whitehaven",
      state: STATE,
      selected: ui.chosen && ui.selected && !isRun(ui.selected) ? ui.selected : null,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      onSelect: function (id) { select(id || null, true); },
      onOpen: function (id) { openThread(id); },
    });
  }

  function pauseOffice() {
    if (ui.office && ui.office.pause) ui.office.pause();
  }

  /*
   * Returns the flat Range: the Office's chart with the scenery stripped. One mountain per project;
   * each goal climbs its project's mountain, and its height is the share of its camps it has
   * reached, so the altitude lines are a true scale. It stands in while the 3D module loads, and
   * when the module is missing.
   */
  function drawFlatRange(loading) {
    var Wd = 1100, H = 540, base = 470, peak = 80;
    var alt = function (f) { return base - (base - peak) * f; };
    var svg = '<svg class="ex-range-svg" viewBox="0 0 ' + Wd + " " + H + '" aria-hidden="true">';
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      svg += '<path class="ex-range-alt' + (f === 1 ? " is-summit" : "") + '" d="M0 ' + alt(f) + "H" + Wd + '"/>';
      svg += '<text class="ex-range-altname" x="-6" y="' + (alt(f) + 4) + '">' + { 0.25: "¼", 0.5: "½", 0.75: "¾", 1: "summit" }[f] + "</text>";
    });
    var tags = "";
    var centers = [230, 560, 890];
    var hw = 175;
    W.projects.forEach(function (p, i) {
      var cx = centers[i];
      var tint = "var(--proj-" + p.tint + ")";
      svg +=
        '<path class="ex-range-face" style="fill:' + tint + '" d="M' + (cx - hw) + " " + base + "L" + cx + " " + peak + "L" + (cx + hw * 0.18) + " " + base + 'Z"/>' +
        '<path class="ex-range-face is-shade" style="fill:' + tint + '" d="M' + (cx + hw * 0.18) + " " + base + "L" + cx + " " + peak + "L" + (cx + hw) + " " + base + 'Z"/>' +
        '<path class="ex-range-peakflag" d="M' + cx + " " + peak + "V" + (peak - 22) + "l12 5-12 5" + '"/>' +
        '<text class="ex-range-name" x="' + cx + '" y="' + (base + 28) + '">' + p.name + "</text>";
      var leads = listLeads().filter(function (t) { return t.project === p.id && W.goals[t.id]; }).sort(function (a, b) { return api.compareTimes(a.started, b.started); });
      leads.forEach(function (t, j) {
        var m = buildRoute(t);
        var f = m.headPct / 100;
        // Each goal starts from its own point at the mountain's foot and climbs to the peak.
        var spread = leads.length > 1 ? j / (leads.length - 1) : 0;
        var x0 = cx - hw + 34 + spread * (2 * hw - 68);
        var x = x0 + (cx - x0) * f;
        var y = alt(f);
        svg += '<path class="ex-range-route" d="M' + x0 + " " + base + "L" + cx + " " + peak + '"/>';
        svg += '<path class="ex-range-climbed" style="stroke:var(--who);--hue:var(--hue-' + m.hue + ')" d="M' + x0 + " " + base + "L" + x + " " + y + '"/>';
        var asks = listAskers(t).length;
        tags +=
          '<button class="ex-range-climber' + (x0 < cx ? " is-left" : "") + (ui.selected === t.id ? " is-selected" : "") + '" data-select="' + t.id + '" style="left:' + ((x / Wd) * 100).toFixed(2) + "%;top:" + ((y / H) * 100).toFixed(2) + "%;--hue:var(--hue-" + m.hue + ')">' +
          '<span class="ex-range-head">' + R.icons.egg + (asks ? '<span class="ex-range-flag">' + R.icons.flag + "</span>" : "") + (m.stuckMin ? '<span class="ex-range-cloud">' + R.icons.cloud + "</span>" : "") + "</span>" +
          '<span class="ex-range-tag"><span>' + esc(t.title) + "</span><small>" + R.describeProgress(m) + "</small></span></button>";
      });
    });
    svg += '<g class="ex-range-camp"><rect x="' + (Wd / 2 - 52) + '" y="' + (base + 40) + '" width="104" height="22" rx="5"/><text x="' + Wd / 2 + '" y="' + (base + 55) + '">Base camp · you</text></g>';
    svg += "</svg>";
    return (
      '<div class="ex-range">' +
      // With many climbers, a name tag shows only for the selected one and under the pointer.
      '<div class="ex-range-art' + (listLeads().length > 12 ? " is-crowded" : "") + '">' + svg + '<div class="ex-range-tags">' + tags + "</div></div>" +
      '<p class="ex-range-note">' + (loading ? "Loading the Range…" : "The Range, drawn flat. Each goal sits as high up its project's mountain as it has climbed: strip the scenery and the altitude is still a true chart. The 3D Range mounts here.") + "</p>" +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ the selection card */

  function drawCard() {
    var id = ui.selected;
    var html = "";
    if (isRun(id)) html = drawRunCard(getRun(id));
    else if (getThread(id)) html = drawThreadCard(getThread(id));
    ov.card.innerHTML = html;
    ov.card.hidden = !html;
    // The ledger and the Board end above a docked card, so it never covers a row.
    ov.el.classList.toggle("has-card", !!html);
    bindOverview(ov.card);
  }

  function drawThreadCard(t) {
    var goal = W.goals[t.id];
    var m = buildRoute(t);
    var lead = api.findLead(t);
    var asker = t.pose === "waiting" ? t : t.lead ? null : listAskers(t)[0];
    var stage = goal && goal.stage ? findStage(goal.stage) : null;
    var sub = t.lead
      ? '<span class="ex-card-role">' + esc(t.role || "partner") + '</span><span class="faint">roped to ' + esc(lead.title) + "</span>"
      : drawProject(t.project) + (stage ? '<span class="faint">' + stage.name + " · " + (goal.stage === "landed" ? "since " + esc(goal.stageSince) : minutesInStage(goal) < 1 ? "just now" : formatSpan(minutesInStage(goal))) + "</span>" : "");
    var status = "";
    if (asker) {
      status =
        '<div class="ex-card-ask"><span class="ex-card-ask-q">' + (asker !== t ? '<b class="ex-asker">' + esc(asker.role) + "</b> asks · " : "") + esc(asker.ask) + '</span><span class="ex-card-ask-age">' + api.formatAge(asker.last) + "</span></div>" +
        '<div class="ex-card-act">' + drawAnswers(asker.id, "sm") + '<span class="spacer"></span>' + drawOpenBtn(t.id) + "</div>";
    } else {
      var line;
      if (m.stuckMin) line = '<span class="ex-stuck">' + R.icons.cloud + "No camp reached in " + m.stuckMin + "m.</span> Last: " + esc(goal.camps[m.done - 1].label) + " at " + esc(goal.lastProgress) + ".";
      else if (m.landed) line = '<span class="ok-ink">Landed ' + esc(goal.lastProgress) + ".</span> " + esc(t.result || "");
      else if (t.pose === "working") {
        var e = t.lead ? null : describeEta(t);
        line = '<span class="ex-working">' + Crew.mark("working") + "Working</span>" + (W.activity[t.id] ? '<span class="ex-card-doing">' + esc(W.activity[t.id]) + "</span>" : "") + (e && e.main !== "-" ? '<span class="ex-card-eta">summit ' + esc(e.main) + "</span>" : "");
      } else line = '<span class="faint">Idle since ' + esc(t.last) + ".</span> " + esc(X.summitEta[t.id] && X.summitEta[t.id].after === "a merge" ? "Ready: it waits for a merge." : t.result || "");
      status = '<p class="ex-card-line">' + line + "</p>" + '<div class="ex-card-act"><span class="spacer"></span>' + drawOpenBtn(t.id) + "</div>";
    }
    // Three groups: who, where it stands, what it asks. They stack in the floating card and sit
    // side by side when the card is docked under the ledger or the Board.
    return (
      '<div class="ex-card-a"><div class="ex-card-h">' + drawFace(t, 34) +
      '<div class="ex-card-who"><b class="ex-card-title">' + esc(t.title) + '</b><span class="ex-card-sub">' + sub + "</span></div>" +
      '<button class="icon-btn icon-btn--sm ex-card-x" data-deselect title="Clear the selection">' + Crew.icon("close", 14) + "</button></div></div>" +
      (goal
        ? '<div class="ex-card-b"><div class="ex-card-summit">' + R.icons.peak + "<span>" + esc(goal.summit) + "</span>" + drawProgress(m) + "</div>" + '<div class="ex-card-route">' + R.drawRoute(m, { variant: "card", tips: true }) + "</div></div>"
        : '<div class="ex-card-b"></div>') +
      '<div class="ex-card-c">' + status + "</div>"
    );
  }

  function drawRunCard(run) {
    var m = buildRunRoute(run);
    var waiting = run.steps.some(function (s) { return s.state === "waiting"; });
    return (
      '<div class="ex-card-a"><div class="ex-card-h"><span class="ex-card-mark">' + Crew.mark(waiting ? "waiting" : "working", 20) + "</span>" +
      '<div class="ex-card-who"><b class="ex-card-title">' + esc(run.title) + '</b><span class="ex-card-sub">' + drawProject(run.project) + '<span class="faint">Run · ' + esc(run.workflow) + "</span></span></div>" +
      '<button class="icon-btn icon-btn--sm ex-card-x" data-deselect title="Clear the selection">' + Crew.icon("close", 14) + "</button></div></div>" +
      '<div class="ex-card-b"><div class="ex-card-summit">' + R.icons.peak + "<span>" + esc(X.runRoutes[run.id].summit) + "</span>" + drawProgress(m) + "</div>" +
      '<div class="ex-card-route">' + R.drawRoute(m, { variant: "card", tips: true }) + "</div></div>" +
      '<div class="ex-card-c">' +
      (waiting
        ? '<div class="ex-card-ask"><span class="ex-card-ask-q">' + esc(run.waitingAsk) + '</span><span class="ex-card-ask-age">' + api.formatAge(W.runSessions.rShip.last) + "</span></div>" + '<div class="ex-card-act">' + drawAnswers("rShip", "sm") + '<span class="spacer"></span>' + drawOpenBtn(run.id, "Open run") + "</div>"
        : '<div class="ex-card-act"><span class="spacer"></span>' + drawOpenBtn(run.id, "Open run") + "</div>") +
      "</div>"
    );
  }

  function drawOpenBtn(id, label) {
    return '<button class="btn btn--sm ex-open" data-open-thread="' + id + '">' + (label || "Open thread") + Crew.icon("chev-r", 12) + "</button>";
  }

  /* ------------------------------------------------------------------ answering */

  /** Answers a Request: the thread goes back to work, its flag comes down, and a toast offers Undo. */
  function answer(id, index) {
    var a = (X.answers[id] || [])[index];
    if (!a) return;
    var snap = takeSnapshot(id);
    if (id === "rShip") {
      var run = getRun("runShip");
      run.steps[2].state = "completed";
      run.steps[3].state = "running";
      X.runRoutes.runShip.camps[2].state = "done";
      X.runRoutes.runShip.camps[3].state = "current";
    } else {
      var t = getThread(id);
      t.pose = "working";
      t.status = "working";
      t.last = W.now;
      reachWaitingCamp(W.goals[t.id]);
      if (t.lead) releaseLeadFlag(W.goals[t.lead]);
    }
    api.drawSum();
    redraw();
    var who = id === "rShip" ? "Ship release v2.15" : api.findLead(getThread(id)).title;
    api.showToast(esc(a.did) + " · " + esc(who) + " continues", "Undo", function () {
      restoreSnapshot(snap);
      api.drawSum();
      redraw();
    });
  }

  /** Marks the camp a goal waited on as reached now, and the next one as where it heads. */
  function reachWaitingCamp(goal) {
    if (!goal) return;
    var hasCurrent = goal.camps.some(function (c) { return c.state === "current"; });
    for (var i = 0; i < goal.camps.length; i++) {
      if (goal.camps[i].state === "waiting") {
        goal.camps[i].state = "done";
        goal.camps[i].at = W.now;
        if (!hasCurrent && goal.camps[i + 1] && goal.camps[i + 1].state === "todo") goal.camps[i + 1].state = "current";
        goal.lastProgress = W.now;
        return;
      }
    }
  }

  /** Takes the marigold flag off a lead's route once its partner's question is answered. */
  function releaseLeadFlag(goal) {
    if (!goal) return;
    goal.camps.forEach(function (c) {
      if (c.state === "waiting") {
        c.state = "todo";
        delete c.note;
      }
    });
  }

  /** Returns a copy of everything an answer changes, so Undo can put it back. */
  function takeSnapshot(id) {
    var t = getThread(id);
    var parts = {};
    if (t) {
      parts.thread = { ref: t, data: JSON.stringify(t) };
      parts.goal = { ref: W.goals[t.id], data: JSON.stringify(W.goals[t.id]) };
      if (t.lead) parts.leadGoal = { ref: W.goals[t.lead], data: JSON.stringify(W.goals[t.lead]) };
    } else {
      parts.run = { ref: getRun("runShip"), data: JSON.stringify(getRun("runShip")) };
      parts.route = { ref: X.runRoutes.runShip, data: JSON.stringify(X.runRoutes.runShip) };
    }
    return parts;
  }

  function restoreSnapshot(parts) {
    Object.keys(parts).forEach(function (k) {
      var p = parts[k];
      var data = JSON.parse(p.data);
      Object.keys(p.ref).forEach(function (key) { delete p.ref[key]; });
      Object.keys(data).forEach(function (key) { p.ref[key] = data[key]; });
    });
  }

  /** Redraws every view of the work after the world changed. */
  function redraw() {
    drawList();
    if (ui.overview) drawOverview();
    else api.drawMain();
  }

  /* ------------------------------------------------------------------ popovers and tooltips */

  function showTip(x, y, html) {
    ov.tip.innerHTML = html;
    ov.tip.hidden = false;
    var host = api.els.app.getBoundingClientRect();
    var r = ov.tip.getBoundingClientRect();
    var left = Math.min(host.right - r.width - 8, Math.max(host.left + 8, x - r.width / 2));
    ov.tip.style.left = left - host.left + "px";
    ov.tip.style.top = y - host.top - r.height - 8 + "px";
  }

  function hideTip() {
    ov.tip.hidden = true;
  }

  /**
   * Opens a popover by name under an anchor element. With `below`, it opens under that element
   * instead, still lined up with the anchor: the grown route stays in sight above it.
   */
  function openPop(name, anchor, below) {
    var html = "";
    if (name === "lens-side" || name === "lens-group") {
      html =
        '<div class="pop-h">Group the routes</div>' +
        [["project", "By project", "Each project's goals, newest first"], ["stage", "By stage", "Scoping to Landed: the Board, as a list"]].map(function (o) {
          return '<button class="ex-menu-item' + (ui.group === o[0] ? " is-on" : "") + '" data-group="' + o[0] + '"><span><b>' + o[1] + '</b><span class="faint">' + o[2] + "</span></span>" + (ui.group === o[0] ? Crew.icon("check", 14) : "") + "</button>";
        }).join("");
    } else if (name === "lens-sort") {
      html =
        '<div class="pop-h">Order inside a group</div>' +
        [["newest", "Newest", "The goal started last comes first"], ["progress", "Furthest along", "The highest on its route comes first"], ["summit", "Soonest summit", "By the predicted summit time"]].map(function (o) {
          return '<button class="ex-menu-item' + (ui.sort === o[0] ? " is-on" : "") + '" data-sort="' + o[0] + '"><span><b>' + o[1] + '</b><span class="faint">' + o[2] + "</span></span>" + (ui.sort === o[0] ? Crew.icon("check", 14) : "") + "</button>";
        }).join("");
    } else if (name === "stuck") {
      html = drawStuckStory();
    } else if (name === "grew") {
      html = drawGrewStory();
    }
    ui.pop = name;
    ov.pop.innerHTML = html;
    ov.pop.className = "ex-pop pop ex-pop--" + name;
    ov.pop.hidden = false;
    var host = api.els.app.getBoundingClientRect();
    var a = anchor.getBoundingClientRect();
    var p = ov.pop.getBoundingClientRect();
    var left = Math.max(host.left + 280, Math.min(a.left, host.right - p.width - 12)) - host.left;
    var top = (below ? below.getBoundingClientRect().bottom : a.bottom) + 8 - host.top;
    if (name === "lens-side") left = Math.max(8, a.right - p.width - host.left);
    if (name === "stuck" || name === "grew") left = Math.max(280, Math.min(a.left - 24 - host.left, host.width - p.width - 12));
    if (top + p.height > host.height - 12) top = a.top - p.height - 8 - host.top;
    ov.pop.style.left = left + "px";
    ov.pop.style.top = top + "px";
    bindOverview(ov.pop);
  }

  function closePop() {
    if (!ov.pop) return;
    ui.pop = null;
    ov.pop.hidden = true;
  }

  /** Returns the stuck route's story: what happened since its last camp, and how to unblock it. */
  function drawStuckStory() {
    var s = X.stories.stuck;
    var t = getThread(s.id);
    var m = buildRoute(t);
    return (
      '<div class="ex-story">' +
      '<div class="ex-story-h">' + R.icons.cloud + "<b>No camp reached in " + m.stuckMin + "m</b></div>" +
      '<p class="ex-story-p">Last camp: <b>' + esc(s.lastCamp.label) + "</b> at " + esc(s.lastCamp.at) + ". Since then:</p>" +
      '<ol class="ex-story-list">' + s.since.map(function (e) { return "<li><span>" + e.at + "</span>" + esc(e.text) + "</li>"; }).join("") + "</ol>" +
      (t.pose === "waiting" ? '<p class="ex-story-p ex-story-you">' + esc(s.unblock) + "</p>" : "") +
      "</div>"
    );
  }

  /** Returns the grown route's story: why the plan grew, and why progress went backwards. */
  function drawGrewStory() {
    var s = X.stories.grew;
    return (
      '<div class="ex-story">' +
      '<div class="ex-story-h"><b class="ex-story-plus">+' + s.added.length + " camps</b><b>at " + s.at + "</b></div>" +
      '<p class="ex-story-p">' + esc(s.cause) + "</p>" +
      '<p class="ex-story-p">The agent added <b>' + s.added.map(esc).join("</b> and <b>") + "</b> to its plan. The route went from " + s.before.done + " of " + s.before.total + " to " + s.after.done + " of " + s.after.total + ": the summit moved, and the bar says so.</p>" +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ events */

  /** Wires every interactive part of a freshly drawn overview fragment. Safe to call again. */
  function bindOverview(root) {
    root.querySelectorAll("[data-select]").forEach(function (el) {
      if (el.dataset.bound) return;
      el.dataset.bound = "1";
      el.addEventListener("click", function (e) {
        if (e.target.closest("button, a, [data-tip]") && !e.target.closest(".ex-range-climber")) {
          if (e.target.closest("[data-answer], [data-rope], [data-open-thread], a")) return;
        }
        select(el.dataset.select);
      });
      el.addEventListener("dblclick", function (e) {
        if (e.target.closest("button")) return;
        openThread(el.dataset.select);
      });
    });
  }

  function onClick(e) {
    var el;
    if ((el = e.target.closest("[data-answer]"))) {
      e.preventDefault();
      e.stopPropagation();
      answer(el.dataset.answer, Number(el.dataset.answerI));
      return;
    }
    if ((el = e.target.closest("[data-open-thread]"))) {
      e.preventDefault();
      openThread(el.dataset.openThread);
      return;
    }
    if ((el = e.target.closest("[data-deselect]"))) {
      ui.selected = null;
      select(null);
      return;
    }
    if ((el = e.target.closest("[data-mode]"))) {
      setMode(el.dataset.mode);
      return;
    }
    if ((el = e.target.closest("[data-close]"))) {
      showOverview(false);
      api.drawMain();
      return;
    }
    if ((el = e.target.closest("[data-pop]"))) {
      e.preventDefault();
      if (ui.pop === el.dataset.pop) closePop();
      else openPop(el.dataset.pop, el);
      return;
    }
    if ((el = e.target.closest("[data-group]"))) {
      ui.group = el.dataset.group;
      closePop();
      redraw();
      return;
    }
    if ((el = e.target.closest("[data-sort]"))) {
      ui.sort = el.dataset.sort;
      closePop();
      redraw();
      return;
    }
    if ((el = e.target.closest("[data-rope]"))) {
      e.stopPropagation();
      ui.roped[el.dataset.rope] = !ui.roped[el.dataset.rope];
      drawLedger();
      return;
    }
    if ((el = e.target.closest("[data-select-link]"))) {
      e.preventDefault();
      if (!el.dataset.selectLink) return;
      select(el.dataset.selectLink);
      revealSelection();
      return;
    }
    if ((el = e.target.closest("[data-unfold]"))) {
      e.preventDefault();
      ui.unfolded[el.dataset.unfold] = !ui.unfolded[el.dataset.unfold];
      drawList();
      return;
    }
    if ((el = e.target.closest("[data-strip]"))) {
      ui.selected = el.dataset.strip;
      ui.mode = "threads";
      showOverview(true);
      revealSelection();
      return;
    }
    if ((el = e.target.closest(".ex-is-overview .side-actions .ex-office-btn, .side-actions .ex-office-btn"))) {
      showOverview(!ui.overview);
      if (!ui.overview) api.drawMain();
      return;
    }
    if ((el = e.target.closest("[data-open-row]"))) {
      e.preventDefault();
      var id = el.dataset.openRow;
      if (ui.overview) {
        select(id);
        revealSelection();
      } else if (isRun(id)) {
        openThread(id);
      } else api.open(id);
      return;
    }
    if (ui.pop && !e.target.closest("[data-pop-el]")) closePop();
  }

  function onDblClick(e) {
    var el = e.target.closest("[data-open-row]");
    if (el && ui.overview) openThread(el.dataset.openRow);
  }

  /** Returns the order the arrow keys walk: the ledger's order, every lead and its shown partners. */
  function listWalkOrder() {
    var ids = [];
    listWaiting().slice().reverse().forEach(function (t) { ids.push(t.id); });
    groupLeads().forEach(function (g) {
      g.leads.forEach(function (l) {
        if (ids.indexOf(l.id) === -1) ids.push(l.id);
        if (ui.roped[l.id]) api.listPartners(l.id).forEach(function (p) { if (ids.indexOf(p.id) === -1) ids.push(p.id); });
      });
    });
    return ids;
  }

  function onKey(e) {
    var typing = e.target.closest && e.target.closest("input, textarea, [contenteditable]");
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "o" || e.key === "O")) {
      e.preventDefault();
      showOverview(!ui.overview);
      if (!ui.overview) api.drawMain();
      return;
    }
    if (!ui.overview || typing || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (MODE_KEYS[k]) {
      e.preventDefault();
      setMode(MODE_KEYS[k]);
      return;
    }
    if (k === "escape") {
      if (ui.pop) closePop();
      else {
        showOverview(false);
        api.drawMain();
      }
      return;
    }
    if (k === "enter" && ui.selected) {
      openThread(ui.selected);
      return;
    }
    if (k === "arrowdown" || k === "arrowup" || k === "j" || k === "k") {
      e.preventDefault();
      var order = listWalkOrder();
      var i = order.indexOf(ui.selected);
      var next = k === "arrowdown" || k === "j" ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
      select(order[next]);
      revealSelection();
    }
  }

  function onOver(e) {
    var el = e.target.closest && e.target.closest("[data-tip]");
    if (!el || !api.els.app.contains(el)) {
      if (ov.tip && !ov.tip.hidden && !(e.target.closest && e.target.closest("[data-flow-plot]"))) hideTip();
      return;
    }
    var r = el.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.top, esc(el.dataset.tip));
  }

  /* ------------------------------------------------------------------ the states' signature moments */

  /** The grew state: the Result types route grows two camps, and its progress goes backwards. */
  function playGrew() {
    var s = X.stories.grew;
    var row = ov.ledger.querySelector('[data-select="' + s.id + '"] .ex-route');
    if (!row) return;
    var goal = W.goals[s.id];
    var before = goal.camps.filter(function (c) { return !c.added; });
    var nb = before.length;
    var placeBefore = function (i) {
      var j = before.indexOf(goal.camps[i]);
      return j < 0 ? 100 : ((j + 1) / nb) * 100;
    };
    // Every part is drawn where it stands now; put it back where it stood before the plan grew,
    // then let the transition carry it forward. The added camps start hidden at the summit.
    var moves = [];
    row.querySelectorAll("[data-c]").forEach(function (el) {
      var i = Number(el.dataset.c);
      moves.push([el, "left", el.style.left]);
      el.style.left = placeBefore(i) + "%";
      if (goal.camps[i].added) el.classList.add("is-unborn");
    });
    var doneBefore = before.filter(function (c) { return c.state === "done"; }).length;
    var headBefore = (doneBefore / nb) * 100 + 0.45 * (100 / nb);
    [[".ex-r-fill", "width"], [".ex-r-head", "left"], [".ex-r-rope", "left"]].forEach(function (p) {
      var el = row.querySelector(p[0]);
      if (!el) return;
      moves.push([el, p[1], el.style[p[1]]]);
      el.style[p[1]] = headBefore + "%";
    });
    var goalRow = row.closest(".ex-goal");
    // Bring the row up, so the route and its story both sit above the docked card.
    ov.ledger.scrollTop = goalRow.offsetTop - 180;
    goalRow.classList.add("is-before-growth");
    void row.offsetWidth;
    row.classList.add("is-growing");
    setTimeout(function () {
      goalRow.classList.remove("is-before-growth");
      moves.forEach(function (mv) { mv[0].style[mv[1]] = mv[2]; });
      row.querySelectorAll(".is-unborn").forEach(function (el) { el.classList.remove("is-unborn"); });
      setTimeout(function () {
        openPop("grew", row.querySelector(".ex-r-label.is-added") || row, row);
      }, 1000);
    }, 1000);
  }

  /** The move state: "Refactor cart totals" runs its first test and its card moves to Proving by itself. */
  function playMove() {
    var mv = X.move;
    var goal = W.goals[mv.id];
    var snap = JSON.stringify({ goal: goal, moved: X.movedBy[mv.id], hist: X.stageHistory[mv.id] });
    ov.board.dataset.replay = snap;
    var go = function () {
      if (ui.pointerOnBoard) {
        showBoardPill(true);
        return setTimeout(go, 400);
      }
      showBoardPill(false);
      var card = ov.board.querySelector('[data-card-id="' + mv.id + '"]');
      if (!card) return;
      var from = card.getBoundingClientRect();
      goal.camps[mv.camp].state = "done";
      goal.camps[mv.camp].at = W.now;
      goal.camps[mv.camp + 1].state = "current";
      goal.lastProgress = W.now;
      goal.stage = mv.to;
      goal.stageSince = W.now;
      X.movedBy[mv.id] = { signal: mv.signal, at: "now" };
      X.stageHistory[mv.id] = X.stageHistory[mv.id].concat([[mv.to, W.now]]);
      drawBoard();
      drawList();
      var moved = ov.board.querySelector('[data-card-id="' + mv.id + '"]');
      var to = moved.getBoundingClientRect();
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        drawCard();
        showBoardToast(api.getThread(mv.id).title, findStage(mv.to).name, "its " + mv.signal);
        return;
      }
      moved.classList.add("is-moving");
      moved.style.transform = "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px)";
      void moved.offsetWidth;
      moved.style.transition = "transform 900ms cubic-bezier(.3,.1,.2,1), box-shadow 300ms";
      moved.style.transform = "";
      drawCard();
      setTimeout(function () {
        moved.classList.remove("is-moving");
        moved.classList.add("is-arrived");
        showBoardToast(api.getThread(mv.id).title, findStage(mv.to).name, "its " + mv.signal);
      }, 950);
    };
    setTimeout(go, 1100);
  }

  function replayMove() {
    var snap = JSON.parse(ov.board.dataset.replay || "null");
    if (!snap) return;
    var goal = W.goals[X.move.id];
    Object.keys(goal).forEach(function (k) { delete goal[k]; });
    Object.keys(snap.goal).forEach(function (k) { goal[k] = snap.goal[k]; });
    X.movedBy[X.move.id] = snap.moved;
    X.stageHistory[X.move.id] = snap.hist;
    drawTop();
    drawBoard();
    drawList();
    drawCard();
    playMove();
  }

  function showBoardPill(on) {
    var pill = ov.el.querySelector(".ex-bpill");
    if (on && !pill) ov.board.insertAdjacentHTML("afterbegin", '<div class="ex-bpill">1 card will move when the pointer leaves the board</div>');
    if (!on && pill) pill.remove();
  }

  /** Says in the Board's note what just moved a card and why; it returns to its quiet words after a while. */
  function showBoardToast(title, stage, signal) {
    var note = ov.tools.querySelector(".ex-boardnote");
    if (!note) return;
    note.classList.add("is-news");
    note.innerHTML =
      icon("bolt", 14) + '<span title="' + esc(title) + " moved to " + esc(stage) + ": " + esc(signal) + (STATE === "move" ? " (" + esc(X.move.cmd) + ")" : "") + ', just now"><b>' + esc(title) + "</b> moved to <b>" + esc(stage) + '</b><span class="ex-boardnote-by">: ' + esc(signal) + "</span></span>" +
      (STATE === "move" ? '<button class="ex-replay" data-replay title="Play the move again" aria-label="Replay the move">' + Crew.icon("undo", 13) + "</button>" : "");
    var btn = note.querySelector("[data-replay]");
    if (btn) btn.addEventListener("click", replayMove);
    clearTimeout(showBoardToast.timer);
    if (STATE !== "move") showBoardToast.timer = setTimeout(drawTop, 8000);
  }

  /* ------------------------------------------------------------------ registering with the stage */

  Stage.direction({
    rootClass: "ov-expedition",
    initial: "t3ds",
    drawList: function (listEl, stageApi) {
      api = stageApi;
      drawList();
    },
    drawHeader: function (t, stageApi) {
      var h = stageApi.drawHeader(t);
      return h.replace("</nav>", "</nav>" + drawRouteStrip(t));
    },
    onOpen: function (id) {
      ui.seen[id] = W.now;
      if (ui.overview) return;
      drawList();
    },
    boot: function () {
      buildOverview();
      document.addEventListener("click", onClick);
      document.addEventListener("dblclick", onDblClick);
      document.addEventListener("keydown", onKey);
      document.addEventListener("mouseover", onOver);
      api.els.list.addEventListener("scroll", markListEdges, { passive: true });
      window.addEventListener("resize", markListEdges);
      ov.board.addEventListener("mouseenter", function () { ui.pointerOnBoard = true; });
      ov.board.addEventListener("mouseleave", function () { ui.pointerOnBoard = false; });
      window.addEventListener("resize", function () {
        if (ui.office && ui.office.resize) ui.office.resize();
      });
      api.els.app.classList.add("ex-state-" + STATE);
      showOverview(ui.overview);
      if (ui.overview) {
        var chosen = ui.chosen;
        select(ui.selected);
        ui.chosen = chosen;
        revealSelection();
      }
      if (STATE === "stuck" && ui.mode === "threads") {
        // Bring the stuck goal's own row into view and explain its cloud.
        var row = ov.ledger.querySelector('.ex-lgroup .ex-goal[data-select="tDash"]');
        if (row) {
          ov.ledger.scrollTop = row.offsetTop - 150;
          openPop("stuck", row.querySelector(".ex-r-cloud"), row.querySelector(".ex-route"));
        }
      }
      if (STATE === "grew" && ui.mode === "threads") playGrew();
      if (STATE === "move" && ui.mode === "board") playMove();
    },
  });
})();
