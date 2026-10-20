// PROTOTYPE - direction 1, Case Files: one piece of work, one row.
//
// A case is a lead thread and the partners working with it (BRIEF.md §4). The sidebar lists
// cases, not threads. A case's row is as tall as today's thread row:
//   line 1  the case's name (its lead's title) and the status of whoever speaks for the case
//   line 2  the crew strip (every member's face, in its pose) and the exchange line (the last
//           thing one member said to another)
// A case of one is today's row, unchanged. Opening a case unfolds its case file under the row:
// one short row per member, then the case's foot (branch, changes, Add a partner, Close case).
//
// States (?state=): everyday, partner, spawn, swarm, done, lens, plus
//   expanded  every case with a crew unfolded
//   notes     the case notes card of the 3-D Secure case shown open
(function () {
  "use strict";

  var api, W, STATE;
  var CAP = 5;
  var HOVER_DELAY = 350;

  var toggled = {}; // leadId -> true (unfolded by the user) or false (folded by the user)
  var closed = []; // cases closed in this page, newest first: { lead, threads, at }
  var shelfOpen = false;
  var extraExchanges = []; // exchanges this page adds: the spawn's brief, the done state's last report
  var typingFor = null; // the lead whose exchange line is being typed
  var pop = null; // the one glass card beside the sidebar
  var popTimer = null;
  var pinnedNotes = null; // the lead whose notes card stays open (the notes state)

  /* ------------------------------------------------------------------ the case model */

  /** Returns a thread's role in its case: "lead" for the lead, else its role. */
  function readRole(t) {
    return t.lead ? t.role : "lead";
  }

  /** Returns the case's crew: the lead first, then its partners oldest first. */
  function listCaseCrew(leadId) {
    return api.listCrew(leadId).filter(Boolean);
  }

  /** Returns the exchanges between the members of a case, oldest first. */
  function listCaseExchanges(leadId) {
    var ids = listCaseCrew(leadId).map(function (t) { return t.id; });
    return W.exchanges
      .concat(extraExchanges)
      .filter(function (e) { return ids.indexOf(e.from) !== -1 && ids.indexOf(e.to) !== -1; })
      .sort(function (a, b) { return api.compareTimes(a.at, b.at); });
  }

  /** Returns the cases of a project (null for "No project"), newest started first, as their leads. */
  function listCases(projectId) {
    return api.listLeads(projectId);
  }

  /** Returns which cases a project shows: waiting, then working, then the rest, five at most, kept in the project's order. The open case always shows. */
  function pickShownCases(leads, openLead) {
    var rank = { waiting: 0, working: 1 };
    var picked = leads
      .slice()
      .sort(function (a, b) {
        var sa = api.pickSpokesperson(listCaseCrew(a.id));
        var sb = api.pickSpokesperson(listCaseCrew(b.id));
        var ra = rank[sa.pose] != null ? rank[sa.pose] : 2;
        var rb = rank[sb.pose] != null ? rank[sb.pose] : 2;
        return ra - rb || api.compareTimes(sb.last, sa.last);
      })
      .slice(0, CAP);
    if (openLead && leads.indexOf(openLead) !== -1 && picked.indexOf(openLead) === -1) picked.push(openLead);
    return leads.filter(function (l) { return picked.indexOf(l) !== -1; });
  }

  /** Returns the lead of the open thread, or null when the open thread is closed or unknown. */
  function findOpenLead() {
    var t = api.getThread(api.openId());
    if (!t || isClosed(t.id)) return null;
    return api.findLead(t);
  }

  function isClosed(id) {
    return closed.some(function (c) { return c.threads.some(function (t) { return t.id === id; }); });
  }

  /** Checks whether a case's file is unfolded: by the user's toggle, else when it holds the open thread or the page unfolds all. */
  function isUnfolded(leadId) {
    if (toggled[leadId] !== undefined) return toggled[leadId];
    if (STATE === "expanded") return true;
    var open = findOpenLead();
    return !!open && open.id === leadId;
  }

  /* ------------------------------------------------------------------ drawing a case */

  var esc;

  /** Returns the crew strip: one face per member, the lead first. A waiting member sits on top, so its raised hand is never covered. */
  function drawCrewStrip(crew, opts) {
    opts = opts || {};
    return (
      '<span class="cf-crew" role="group" aria-label="Crew">' +
      crew.map(function (t, i) {
        var pose = opts.pose || t.pose;
        return (
          '<button class="cf-face' + (t.pose === "waiting" && !opts.pose ? " is-up" : "") + (opts.enteringId === t.id ? " is-entering" : "") + '" style="z-index:' + (t.pose === "waiting" ? 9 : crew.length - i) + '" data-face-open="' + t.id + '" aria-label="Open ' + esc(readRole(t)) + ": " + esc(t.title) + '">' +
          api.drawFace(t, 18, pose) +
          "</button>"
        );
      }).join("") +
      "</span>"
    );
  }

  /** Returns the exchange line's markup for the case's last exchange: "review  First finding…" for a report, "→ tests  Write…" for the lead's brief. */
  function drawExchangeLine(leadId, typed) {
    var crew = listCaseCrew(leadId);
    var asker = crew.filter(function (t) { return t.lead && t.pose === "waiting"; })[0];
    if (asker && typed == null) {
      return '<span class="cf-x cf-x--ask" data-notes="' + leadId + '"><span class="cf-x-who">' + esc(readRole(asker)) + ' asks</span><span class="cf-x-text">' + esc(asker.askShort || asker.ask) + "</span></span>";
    }
    var list = listCaseExchanges(leadId);
    var last = list[list.length - 1];
    if (!last) {
      var roles = crew.slice(1).map(readRole).join(", ");
      return '<span class="cf-x"><span class="cf-x-text">with ' + esc(roles) + "</span></span>";
    }
    var from = api.getThread(last.from);
    var to = api.getThread(last.to);
    var arrow = '<span class="cf-x-arrow">→</span>';
    var who = from.lead ? esc(readRole(from)) + (to.lead ? arrow + esc(readRole(to)) : "") : arrow + esc(readRole(to));
    var text = typed != null ? typed : last.text;
    return '<span class="cf-x" data-notes="' + leadId + '"><span class="cf-x-who">' + who + '</span><span class="cf-x-text">' + esc(text) + "</span></span>";
  }

  /**
   * Returns the status slot of a case: the status of whoever speaks for it. Under the pointer,
   * Close takes its place, so the way to the member that speaks is its face, the one with the
   * raised hand when it waits.
   */
  function drawCaseSlot(speaker) {
    var slot = api.decideSlot(speaker);
    return '<span class="side-end st-end--' + slot.kind + ' cf-slot">' + slot.text + "</span>";
  }

  /** Returns a member's row in an unfolded case file. */
  function drawMember(t, openId) {
    var slot = api.decideSlot(t);
    var ask = t.pose === "waiting" ? '<span class="cf-m-ask">' + esc(t.askShort || t.ask) + "</span>" : "";
    return (
      '<a class="side-row cf-member' + (t.id === openId ? " is-on" : "") + (ask ? " has-ask" : "") + (t.pose === "working" && t.id !== openId ? " is-receded" : "") + '" href="#" data-member="' + t.id + '" data-pop-member="' + t.id + '">' +
      api.drawFace(t, 18) +
      '<span class="cf-m-text"><span class="cf-m-line"><span class="cf-m-role">' + esc(readRole(t)) + '</span><span class="cf-m-agent">' + api.drawBrand(t, 11) + '<span class="cf-m-model">' + esc(t.model) + "</span></span></span>" + ask + "</span>" +
      '<span class="side-end st-end--' + slot.kind + '">' + slot.text + "</span>" +
      "</a>"
    );
  }

  /** Returns the case's foot: its branch and changes, Add a partner, and Close case. */
  function drawCaseFoot(lead, crew) {
    var out = W.output[lead.id];
    var branch = api.findBranch(lead);
    var place = branch ? Crew.icon("branch", 12) + '<span class="cf-f-branch">' + esc(branch) + "</span>" : Crew.icon("laptop", 12) + '<span class="cf-f-branch">' + esc(api.findMachine(lead)) + "</span>";
    var changes = out && (out.plus || out.minus) ? '<span class="cf-f-diff"><span class="plus">+' + out.plus + '</span> <span class="minus">−' + out.minus + "</span></span>" : "";
    return (
      '<div class="cf-foot">' +
      '<span class="cf-f-place">' + place + changes + "</span>" +
      '<button class="cf-f-close" data-close-case="' + lead.id + '" title="Close the case: marks all ' + crew.length + ' threads done, with one Undo">Close</button>' +
      "</div>"
    );
  }

  /**
   * Returns one case: today's row for a case of one, else the case row and, when unfolded, its
   * case file. Options: lens (show the project's tint on line 2), enteringId (the face that
   * just joined), typed (the exchange line's text so far).
   */
  function drawCase(lead, opts) {
    opts = opts || {};
    var openId = api.openId();
    var crew = listCaseCrew(lead.id);
    if (crew.length === 1) {
      var lone = api.drawThreadRow(lead, {
        selected: lead.id === openId,
        cls: "cf-lone",
        detail: opts.lens ? drawLensPlace(lead) : null,
      });
      return '<div class="cf-case cf-case--lone" data-case="' + lead.id + '">' + lone + "</div>";
    }
    var speaker = api.pickSpokesperson(crew);
    var unfolded = isUnfolded(lead.id);
    var holdsOpen = crew.some(function (t) { return t.id === openId; });
    var receded = speaker.pose === "working" && !holdsOpen;
    var proj = opts.lens ? drawLensTint(lead) : "";
    return (
      '<div class="cf-case' + (unfolded ? " is-open" : "") + (holdsOpen ? " is-current" : "") + (receded ? " is-receded" : "") + '" data-case="' + lead.id + '">' +
      '<div class="side-row cf-row" role="link" tabindex="0" data-case-open="' + lead.id + '" aria-expanded="' + unfolded + '" aria-label="' + esc(lead.title) + ", case of " + crew.length + " threads, " + esc(Crew.poseWord(speaker.pose)) + '">' +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name">' + esc(lead.title) + "</span>" + drawCaseSlot(speaker) + '<button class="cf-close-hover" data-close-case="' + lead.id + '" title="Close the case: marks its ' + crew.length + ' threads done">Close</button></span>' +
      '<span class="cf-line2">' + proj + drawCrewStrip(crew, { enteringId: opts.enteringId }) + drawExchangeLine(lead.id, opts.typed) +
      '<button class="cf-chev" data-toggle="' + lead.id + '" aria-label="' + (unfolded ? "Fold" : "Unfold") + ' the case file">' + Crew.icon("chev-d", 14) + "</button></span>" +
      "</span></div>" +
      (unfolded
        ? '<div class="cf-file">' + crew.map(function (t) { return drawMember(t, openId); }).join("") + drawCaseFoot(lead, crew) + "</div>"
        : "") +
      "</div>"
    );
  }

  /** Returns the project's tint and name for a lone row's second line under another lens. */
  function drawLensPlace(t) {
    var p = api.getProject(t.project);
    var place = api.describePlace(t);
    return (p ? '<span class="proj proj--' + p.tint + ' cf-lens-proj">' + p.name + "</span>" : '<span class="proj cf-noproj cf-lens-proj">No project</span>') + '<span class="st-clip">&nbsp;· ' + esc(place.clip || place.keep.replace(/^ · /, "")) + "</span>";
  }

  /** Returns the project's tint before a case's crew strip, under another lens. */
  function drawLensTint(t) {
    var p = api.getProject(t.project);
    return '<span class="proj ' + (p ? "proj--" + p.tint : "cf-noproj") + ' cf-lens-tint" title="' + (p ? p.name : "No project") + '"></span>';
  }

  /* ------------------------------------------------------------------ the list */

  /** Returns Waiting on you: each waiting thread with its case's name, and the asker's role when it is a partner. */
  function drawWaiting() {
    var waiting = api.listThreads(function (t) { return t.pose === "waiting" && !isClosed(t.id); }).sort(function (a, b) { return api.compareTimes(b.last, a.last); });
    var runs = W.waitingRuns;
    if (!waiting.length && !runs.length) return "";
    var openId = api.openId();
    var shown = waiting.slice(0, 3);
    return (
      '<section class="side-sec cf-waiting"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + (waiting.length + runs.length) + "</b></h3>" +
      shown.map(function (t) {
        var lead = api.findLead(t);
        var who = t.lead ? '<span class="cf-w-role">' + esc(readRole(t)) + "</span>" : "";
        return (
          '<a class="side-row side-row--wait' + (t.id === openId ? " is-on" : "") + '" href="#" data-member="' + t.id + '">' + api.drawFace(t, 24, "waiting") +
          '<span class="side-text"><span class="side-name">' + esc(lead.title) + '</span><span class="side-ask">' + who + esc(t.askShort || t.ask) + "</span></span></a>"
        );
      }).join("") +
      (waiting.length > 3 ? '<a class="side-row st-more" href="#">' + (waiting.length - 3) + " more waiting on you</a>" : "") +
      (runs.length
        ? '<h4 class="side-sub">From runs</h4>' +
          runs.map(function (r) {
            return '<a class="side-row side-row--wait" href="#"><span class="side-lead">' + Crew.mark("waiting") + '</span><span class="side-text"><span class="side-name">' + esc(r.title) + '</span><span class="side-ask">' + esc(r.ask) + "</span></span></a>";
          }).join("")
        : "") +
      "</section>"
    );
  }

  /** Returns the rows of the runs' sessions that wait on Rogier, with the run's mark in the face's place. */
  function drawRunRows() {
    return W.waitingRuns.map(function (r) {
      return '<a class="side-row side-row--wait cf-run" href="#"><span class="side-lead">' + Crew.mark("waiting") + '</span><span class="side-text"><span class="side-name">' + esc(r.title) + '</span><span class="side-ask">From a run · ' + esc(r.ask) + "</span></span></a>";
    }).join("");
  }

  /** Returns the newest time a project's cases started, which orders the projects: a partner joining never moves its project. */
  function findNewestStart(projectId) {
    return listCases(projectId).reduce(function (m, t) { return api.compareTimes(t.started, m) > 0 ? t.started : m; }, "Sat 00:00");
  }

  function countWaiting(leads) {
    var n = 0;
    leads.forEach(function (l) {
      listCaseCrew(l.id).forEach(function (t) { if (t.pose === "waiting") n++; });
    });
    return n;
  }

  /** Returns a project's section: its header, its cases, and a "more" row. */
  function drawProject(projectId) {
    var leads = listCases(projectId);
    if (!leads.length) return "";
    var p = api.getProject(projectId);
    var need = countWaiting(leads);
    var shown = pickShownCases(leads, findOpenLead());
    var hidden = leads.length - shown.length;
    if (STATE === "swarm" && p) hidden += Math.round(W.swarm.more[p.id] * 0.58);
    return (
      '<section class="side-sec cf-proj">' +
      '<h3 class="side-h side-h--proj">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj cf-noproj">No project</span>') +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '<button class="icon-btn icon-btn--sm" title="New case in ' + (p ? p.name : "no project") + '">' + Crew.icon("plus", 14) + "</button></h3>" +
      shown.map(function (l) { return drawCase(l); }).join("") +
      (hidden > 0 ? '<a class="side-row st-more" href="#">' + hidden + (hidden === 1 ? " more case" : " more cases") + "</a>" : "") +
      "</section>"
    );
  }

  /** Returns the list grouped by status, the lens state: a case sits under the status of whoever speaks for it. */
  function drawByStatus() {
    var leads = api.listThreads(function (t) { return !t.lead && !isClosed(t.id); });
    var groups = [
      { key: "waiting", label: "Needs you", leads: [] },
      { key: "working", label: "Working", leads: [] },
      { key: "quiet", label: "Quiet", leads: [] },
    ];
    leads.forEach(function (l) {
      var s = api.pickSpokesperson(listCaseCrew(l.id));
      var g = s.pose === "waiting" ? groups[0] : s.pose === "working" ? groups[1] : groups[2];
      g.leads.push(l);
    });
    return (
      '<div class="cf-lensbar"><button class="cf-lens-pick">' + Crew.icon("list", 13) + "Group by <b>Status</b>" + Crew.icon("chev-d", 12) + '</button><button class="cf-lens-pick">Newest first' + Crew.icon("chev-d", 12) + "</button></div>" +
      groups.map(function (g) {
        g.leads.sort(function (a, b) { return api.compareTimes(b.started, a.started); });
        var waiting = g.key === "waiting" ? countWaiting(g.leads) : 0;
        return (
          '<section class="side-sec cf-proj cf-group--' + g.key + '">' +
          '<h3 class="side-h side-h--proj cf-status-h"><span>' + (g.key === "waiting" ? Crew.mark("waiting", 13) : g.key === "working" ? Crew.mark("working", 13) : Crew.mark("idle", 13)) + g.label + '</span><span class="cf-gcount">' + g.leads.length + (g.leads.length === 1 ? " case" : " cases") + (waiting ? " · " + waiting + " asks" : "") + "</span></h3>" +
          g.leads.map(function (l) { return drawCase(l, { lens: true }); }).join("") +
          (g.key === "waiting" ? drawRunRows() : "") +
          "</section>"
        );
      }).join("")
    );
  }

  /** Returns the Done shelf: closed cases as one row each, then lone done threads. */
  function drawShelf() {
    var count = W.doneCount + closed.reduce(function (n, c) { return n + c.threads.length; }, 0);
    var rows = "";
    if (shelfOpen) {
      var openId = api.openId();
      rows += closed.map(function (c) {
        return drawDoneCase(c.lead.title, c.threads, "now", c.threads.some(function (t) { return t.id === openId; }), c.lead.id, c.fresh);
      }).join("");
      var seen = {};
      W.done.forEach(function (d) {
        if (seen[d.id]) return;
        var lead = d.lead ? W.done.filter(function (x) { return x.id === d.lead; })[0] : d;
        var crew = W.done.filter(function (x) { return x.id === lead.id || x.lead === lead.id; });
        crew.forEach(function (x) { seen[x.id] = true; });
        rows += drawDoneCase(lead.title, crew, lead.doneAt, false, null, false);
      });
      rows += '<a class="side-row st-more" href="#">Show 25 more</a>';
    }
    return (
      '<section class="side-sec cf-shelf">' +
      '<h3 class="side-h cf-shelf-h"><button data-shelf aria-expanded="' + shelfOpen + '">' + Crew.icon("chev-r", 12) + '<span>Done</span><b class="cf-shelf-n">' + count + "</b></button></h3>" +
      rows +
      "</section>"
    );
  }

  /** Returns one row on the Done shelf: a closed case with its crew's faces, or a lone done thread. */
  function drawDoneCase(title, crew, at, selected, leadId, fresh) {
    var when = /^\d/.test(at) ? (at === "now" ? "now" : api.formatAge(at)) : at.replace(/ \d\d:\d\d$/, "");
    var line2 = crew.length > 1
      ? drawCrewStrip(crew, { pose: "done" }) + '<span class="cf-x"><span class="cf-x-text">Closed ' + (when === "now" ? "just now" : when) + " · " + crew.length + " threads</span></span>"
      : '<span class="st-glyph">' + api.drawBrand(crew[0], 12) + '</span><span class="cf-x-text">Done ' + (when === "now" ? "just now" : when) + "</span>";
    return (
      '<div class="cf-case cf-done' + (fresh ? " is-fresh" : "") + '"><div class="side-row cf-row' + (selected ? " is-on" : "") + '">' +
      '<span class="side-text"><span class="st-line"><span class="side-name">' + esc(title) + '</span><span class="side-end">' + (when === "now" ? "now" : when) + "</span>" +
      (leadId ? '<button class="cf-close-hover cf-reopen" data-reopen="' + leadId + '">Reopen</button>' : '<button class="cf-close-hover cf-reopen">Reopen</button>') + "</span>" +
      '<span class="cf-line2">' + line2 + "</span></span></div></div>"
    );
  }

  /** Draws the whole list, keeping its scroll position. */
  function drawList() {
    var el = api.els.list;
    var top = el.scrollTop;
    var order = W.projects
      .map(function (p) { return p.id; })
      .sort(function (a, b) { return api.compareTimes(findNewestStart(b), findNewestStart(a)); });
    el.innerHTML =
      (STATE === "lens" ? "" : drawWaiting()) +
      (STATE === "lens" ? drawByStatus() : order.map(drawProject).join("") + drawProject(null)) +
      drawShelf();
    el.scrollTop = top;
  }

  /** Redraws one case in place, so nothing around it moves. */
  function redrawCase(leadId, opts) {
    var node = api.els.list.querySelector('[data-case="' + leadId + '"]');
    if (!node) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = drawCase(api.getThread(leadId), opts);
    node.replaceWith(tmp.firstChild);
  }

  /* ------------------------------------------------------------------ the header: the case's crew as tabs */

  function drawHeader(t) {
    var lead = api.findLead(t);
    var crew = listCaseCrew(lead.id);
    if (crew.length === 1 || isClosed(t.id)) return null;
    var p = api.getProject(lead.project);
    return (
      '<header class="top cf-top">' +
      '<nav class="pill cf-crewbar" aria-label="The case\u2019s crew">' +
      '<span class="pill-crumb">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj">No project</span>') + "</span>" +
      '<span class="cf-h-case" title="' + esc(lead.title) + '">' + esc(lead.title) + "</span>" +
      '<span class="cf-h-sep" aria-hidden="true"></span>' +
      crew.map(function (x) {
        var end = x.pose === "working" ? Crew.mark("working", 13) : x.pose === "waiting" ? "" : "<small>" + api.formatAge(x.last) + "</small>";
        return (
          '<a class="ptab cf-tab' + (x.id === t.id ? " is-on" : "") + (x.pose === "waiting" ? " is-waiting" : "") + (x.id === W.spawn.thread.id ? " is-new" : "") + '" href="#" data-open="' + x.id + '" title="' + esc(x.title) + " · " + esc(api.describeAgent(x)) + '">' +
          api.drawFace(x, 20) + '<span class="cf-tab-role">' + esc(readRole(x)) + "</span>" + end +
          "</a>"
        );
      }).join("") +
      '<button class="icon-btn" title="Add a partner to this case">' + Crew.icon("plus") + "</button>" +
      "</nav>" +
      '<span class="spacer"></span>' +
      '<span class="pill"><button class="icon-btn" title="Side pane">' + Crew.icon("sidebar") + "</button></span>" +
      '<span class="pill"><button class="icon-btn" title="Open in editor">' + Crew.icon("editor") + "</button></span>" +
      '<span class="pill"><button class="icon-btn" title="More">' + Crew.icon("more") + "</button></span>" +
      "</header>"
    );
  }

  /* ------------------------------------------------------------------ the glass card: a member, or the case notes */

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.className = "cf-pop";
    pop.setAttribute("role", "tooltip");
    api.els.app.appendChild(pop);
    return pop;
  }

  /** Returns the case notes: every exchange of the case, oldest first, like telegrams. */
  function drawNotes(leadId) {
    var lead = api.getThread(leadId);
    var crew = listCaseCrew(leadId);
    var list = listCaseExchanges(leadId);
    var branch = api.findBranch(lead);
    return (
      '<div class="cf-notes-h"><span class="cf-notes-eyebrow">Case notes</span><b>' + esc(lead.title) + "</b></div>" +
      '<ol class="cf-notes">' +
      list.map(function (e) {
        var from = api.getThread(e.from);
        var to = api.getThread(e.to);
        return (
          '<li class="cf-note cf-note--' + e.kind + '">' +
          '<span class="cf-note-at">' + e.at + "</span>" +
          '<div class="cf-note-body"><div class="cf-note-who">' + api.drawFace(from, 16, from.pose === "waiting" ? "idle" : from.pose) + "<b>" + esc(readRole(from)) + '</b><span class="cf-note-arrow">→</span>' + api.drawFace(to, 16, to.pose === "waiting" ? "idle" : to.pose) + "<b>" + esc(readRole(to)) + "</b></div>" +
          "<p>" + esc(e.text) + "</p></div></li>"
        );
      }).join("") +
      "</ol>" +
      '<div class="cf-notes-foot">' + crew.length + " threads · " + (branch ? esc(branch) + " · " : "") + esc(api.findMachine(lead)) + "</div>"
    );
  }

  /** Returns a member's card: its full title, role and agent, how it joined, and its Request. */
  function drawMemberCard(t) {
    var lead = api.findLead(t);
    var joined = !t.lead
      ? "Lead · started by you at " + t.started
      : t.joined === "added"
      ? "Added by you at " + t.started
      : "Started by the lead at " + t.started;
    var slot = api.decideSlot(t);
    return (
      '<div class="cf-mc-head">' + api.drawFace(t, 30) + '<div><b class="cf-mc-title">' + esc(t.title) + '</b><span class="cf-mc-role">' + esc(readRole(t)) + (t.lead ? " in " + esc(lead.title) : "") + "</span></div></div>" +
      '<div class="cf-mc-row">' + api.drawBrand(t, 12) + "<span>" + esc(api.describeAgent(t)) + " · " + esc(api.findMachine(t)) + "</span></div>" +
      '<div class="cf-mc-row">' + Crew.icon("user", 12) + "<span>" + joined + "</span></div>" +
      (t.pose === "waiting"
        ? '<div class="cf-mc-ask">' + Crew.mark("waiting", 13) + "<span>" + esc(t.ask) + "</span></div>"
        : '<div class="cf-mc-row cf-mc-state st-end--' + slot.kind + '">' + (t.pose === "working" ? Crew.mark("working", 12) : Crew.mark("idle", 12)) + "<span>" + (t.pose === "working" ? "Working" : "Idle for " + api.formatAge(t.last)) + (t.result ? " · " + esc(t.result) : "") + "</span></div>")
    );
  }

  /** Shows the card beside the sidebar, level with an element of the list. */
  function showPop(kind, id, anchor) {
    var p = ensurePop();
    p.className = "cf-pop cf-pop--" + kind;
    p.innerHTML = kind === "notes" ? drawNotes(id) : drawMemberCard(api.getThread(id));
    var r = anchor.getBoundingClientRect();
    var side = api.els.side.getBoundingClientRect();
    p.style.left = side.right + 8 + "px";
    p.style.top = "0px";
    p.classList.add("is-shown");
    var h = p.offsetHeight;
    var top = Math.max(12, Math.min(window.innerHeight - h - 12, r.top - 8));
    p.style.top = top + "px";
  }

  function hidePop() {
    clearTimeout(popTimer);
    if (pinnedNotes) return;
    if (pop) pop.classList.remove("is-shown");
  }

  function wireHover(list) {
    list.addEventListener("pointerover", function (e) {
      var face = e.target.closest(".cf-face, [data-pop-member]");
      var notes = e.target.closest("[data-notes]");
      var target = face || notes;
      if (!target) return;
      if (target === list._hovered) return;
      list._hovered = target;
      clearTimeout(popTimer);
      var wasShown = pop && pop.classList.contains("is-shown");
      var run = function () {
        if (pinnedNotes) { pinnedNotes = null; }
        if (face) showPop("member", face.dataset.faceOpen || face.dataset.popMember, face.closest(".side-row") || face);
        else showPop("notes", notes.dataset.notes, notes.closest(".side-row"));
      };
      if (wasShown) run();
      else popTimer = setTimeout(run, HOVER_DELAY);
    });
    list.addEventListener("pointerout", function (e) {
      var to = e.relatedTarget;
      var still = to && to.closest && to.closest(".cf-face, [data-pop-member], [data-notes]");
      if (still) return;
      list._hovered = null;
      hidePop();
    });
    // The card goes when the user scrolls the list; a scroll the page makes itself (the open case
    // scrolled into view) keeps a pinned card.
    list.addEventListener("wheel", function () {
      pinnedNotes = null;
      hidePop();
    }, { passive: true });
  }

  /**
   * Scrolls the list, and only the list, so an element of it is in view. scrollIntoView would
   * also scroll the book page that frames this one.
   */
  function revealInList(el, where, smooth) {
    var list = api.els.list;
    var lr = list.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var top = list.scrollTop;
    var next = top;
    if (where === "center") next = top + (r.top - lr.top) - (lr.height - r.height) / 2;
    else if (r.bottom > lr.bottom) next = top + (r.bottom - lr.bottom) + 8;
    else if (r.top < lr.top) next = top - (lr.top - r.top) - 8;
    if (next !== top) list.scrollTo({ top: Math.max(0, next), behavior: smooth ? "smooth" : "auto" });
  }

  /* ------------------------------------------------------------------ actions */

  /** Closes a case: its whole crew leaves together, the toast offers one Undo, and the shelf gains one row. */
  function closeCase(leadId, done) {
    var lead = api.getThread(leadId);
    var ids = listCaseCrew(leadId).map(function (t) { return t.id; });
    var node = api.els.list.querySelector('[data-case="' + leadId + '"]');
    hidePop();
    var finish = function () {
      var moved = api.markDone(ids);
      closed.unshift({ lead: lead, threads: moved, at: W.now, fresh: true });
      shelfOpen = true;
      drawList();
      var shelf = api.els.list.querySelector(".cf-done.is-fresh");
      if (shelf) revealInList(shelf, "center", true);
      api.showToast("Case closed · " + moved.length + " threads done", "Undo", function () {
        closed = closed.filter(function (c) { return c.lead.id !== leadId; });
        api.restoreThreads(moved);
        drawList();
      });
      setTimeout(function () { closed.forEach(function (c) { c.fresh = false; }); }, 1600);
      if (done) done();
    };
    if (!node || matchMedia("(prefers-reduced-motion: reduce)").matches) return finish();
    node.style.height = node.offsetHeight + "px";
    node.offsetHeight; // the starting height has to be laid out before the move to 0
    node.classList.add("is-leaving");
    node.style.height = "0px";
    setTimeout(finish, 340);
  }

  function reopenCase(leadId) {
    var c = closed.filter(function (x) { return x.lead.id === leadId; })[0];
    if (!c) return;
    closed = closed.filter(function (x) { return x !== c; });
    api.restoreThreads(c.threads);
    drawList();
  }

  function wireList(list) {
    list.addEventListener("click", function (e) {
      var t = e.target;
      var el;
      if ((el = t.closest("[data-close-case]"))) {
        e.preventDefault();
        e.stopPropagation();
        return closeCase(el.dataset.closeCase);
      }
      if ((el = t.closest("[data-reopen]"))) {
        e.preventDefault();
        return reopenCase(el.dataset.reopen);
      }
      if ((el = t.closest("[data-toggle]"))) {
        e.preventDefault();
        var id = el.dataset.toggle;
        toggled[id] = !isUnfolded(id);
        return redrawCase(id);
      }
      if ((el = t.closest("[data-face-open]"))) {
        e.preventDefault();
        return api.open(el.dataset.faceOpen);
      }
      if ((el = t.closest("[data-member]"))) {
        e.preventDefault();
        return api.open(el.dataset.member);
      }
      if ((el = t.closest("[data-open-row]"))) {
        e.preventDefault();
        return api.open(el.dataset.openRow);
      }
      if ((el = t.closest("[data-case-open]"))) {
        e.preventDefault();
        return api.open(el.dataset.caseOpen);
      }
      if ((el = t.closest("[data-shelf]"))) {
        shelfOpen = !shelfOpen;
        return drawList();
      }
      if ((el = t.closest("[data-add]"))) {
        api.showToast("Add a partner opens a draft that joins this case\u2019s workspace");
      }
    });
    list.addEventListener("keydown", function (e) {
      var row = e.target.closest("[data-case-open]");
      if (!row) return;
      var id = row.dataset.caseOpen;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        toggled[id] = e.key === "ArrowRight";
        redrawCase(id);
        var again = api.els.list.querySelector('[data-case-open="' + id + '"]');
        if (again) again.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        api.open(id);
      }
    });
    wireHover(list);
  }

  /* ------------------------------------------------------------------ the states that play */

  /** The spawn state: about a second after load, "Rotate staging secrets" starts its first partner. Its face slides into the crew strip and the exchange line types the brief. The row keeps its height, so the list does not move. */
  function prepareSpawn() {
    W.transcripts.tSecrets = [
      { me: "Rotate every staging secret in ops/secrets.yaml. Restart nothing yet, and tell me when they are all rotated.", at: "09:30" },
      { worked: "Worked for 8m 20s", tools: ["read 14 files", "ran 9 commands"] },
      { agent: true, at: "09:39", html: "Rotated 9 of 14 secrets in Vault. The other 5 belong to services that read them only at boot, so each needs a restart before it uses the new one." },
      { worked: "Working for 2m", tools: ["rotating 5 more secrets"], live: true },
    ];
  }

  function playSpawn() {
    setTimeout(function () {
      var partner = api.spawnPartner();
      extraExchanges.push(W.spawn.exchange);
      var tx = W.transcripts.tSecrets;
      tx.splice(tx.length - 1, 0,
        { agent: true, at: "09:41", html: "While I finish the last 5, I asked a partner to check that every staging service picks up its new secret." },
        { sent: partner.id, at: "09:41", text: W.spawn.exchange.text });
      var text = W.spawn.exchange.text;
      var n = 0;
      typingFor = W.spawn.lead;
      // A lone row that grows into a case stays folded, even when it holds the open thread: a
      // partner joining must never add rows under the pointer.
      toggled[W.spawn.lead] = false;
      redrawCase(W.spawn.lead, { enteringId: partner.id, typed: "" });
      api.drawMain();
      var tick = setInterval(function () {
        n += 1;
        var line = api.els.list.querySelector('[data-case="' + W.spawn.lead + '"] .cf-x-text');
        if (line) line.textContent = text.slice(0, n);
        if (n >= text.length) {
          clearInterval(tick);
          typingFor = null;
        }
      }, 28);
    }, 1000);
  }

  /** The done state: the 3-D Secure work has landed; about a second after load, Close case runs on it. */
  function prepareDone() {
    var lead = api.getThread("t3ds");
    lead.pose = "idle";
    lead.status = null;
    lead.last = "09:40";
    lead.result = "Pushed fix/3ds-eu-cards and opened PR #1290.";
    var review = api.getThread("t3dsReview");
    review.pose = "idle";
    review.status = null;
    review.last = "09:39";
    review.result = "Re-checked the fix: no more findings.";
    extraExchanges.push({ at: "09:39", from: "t3dsReview", to: "t3ds", kind: "report", text: "Re-checked after your fix: processing now waits for the webhook. No more findings." });
    W.transcripts.t3ds = W.transcripts.t3ds.filter(function (it) { return !it.waiting; }).concat([
      { from: "t3dsReview", at: "09:39", text: "Re-checked after your fix: processing now waits for the webhook. No more findings." },
      { worked: "Worked for 1m 12s", tools: ["ran git push", "opened a pull request"] },
      { agent: true, at: "09:40", html: "Pushed <code>fix/3ds-eu-cards</code> and opened PR #1290. The review found nothing more, so this case is ready to close." },
    ]);
  }

  function playDone() {
    setTimeout(function () {
      var btn = api.els.list.querySelector('[data-case="t3ds"] .cf-f-close');
      if (btn) btn.classList.add("is-pressed");
      setTimeout(function () {
        if (btn) btn.classList.remove("is-pressed");
        closeCase("t3ds");
      }, 420);
    }, 1000);
  }

  // The swarm's leads briefed their partners too. These exchanges are this page's, added only in
  // the swarm state, so the shared world stays as it is.
  var SWARM_EXCHANGES = [
    { at: "09:12", from: "sImg", to: "sImgLcp", kind: "brief", text: "Measure LCP on the product page before and after the image change." },
    { at: "09:26", from: "sImgLcp", to: "sImg", kind: "report", text: "LCP went from 3.1s to 1.4s on a slow 4G profile." },
    { at: "08:51", from: "sApple", to: "sAppleReview", kind: "brief", text: "Check that the Apple Pay domain file is served on every domain." },
    { at: "09:02", from: "sApple", to: "sAppleE2e", kind: "brief", text: "Write end-to-end tests for Apple Pay in checkout." },
    { at: "09:15", from: "sAppleReview", to: "sApple", kind: "report", text: "Served on 2 of 3 domains. staging.webshop is missing it." },
    { at: "Mon 16:40", from: "sDe", to: "sDeTone", kind: "brief", text: "Read the German checkout copy and flag anything too formal." },
    { at: "09:05", from: "sSig", to: "sSigReview", kind: "brief", text: "Try to break the rotation: old and new secrets must both verify for an hour." },
    { at: "09:39", from: "sRate", to: "sRateLoad", kind: "brief", text: "Load-test the payouts API at 3 times today\u2019s peak once the limiter is in." },
    { at: "08:31", from: "sPg", to: "sPgRollback", kind: "brief", text: "Write the rollback plan for Postgres 18, step by step." },
    { at: "08:40", from: "sPg", to: "sPgExt", kind: "brief", text: "Check that every extension we use loads on Postgres 18." },
    { at: "09:02", from: "sPgExt", to: "sPg", kind: "report", text: "All 7 extensions load. pg_partman needs 5.2." },
  ];

  /* ------------------------------------------------------------------ registration */

  Stage.direction({
    rootClass: "d-case",
    initial: function (state) {
      if (state === "partner") return "t3dsReview";
      if (state === "spawn") return "tSecrets";
      return "t3ds";
    },
    drawList: function (el, a) {
      api = a;
      W = a.world;
      STATE = a.state;
      esc = a.escapeHtml;
      if (STATE === "done") prepareDone();
      if (STATE === "spawn") prepareSpawn();
      if (STATE === "swarm") extraExchanges = extraExchanges.concat(SWARM_EXCHANGES);
      drawList();
      wireList(el);
    },
    drawHeader: function (t) {
      return drawHeader(t);
    },
    onOpen: function () {
      if (!api) return;
      drawList();
    },
    boot: function () {
      // As the app does when a thread opens, the list scrolls its case into view.
      var current = api.els.list.querySelector('.cf-case.is-current, [data-case="' + api.openId() + '"]');
      if (current) revealInList(current, "nearest", false);
      if (STATE === "spawn") playSpawn();
      if (STATE === "done") playDone();
      if (STATE === "notes") {
        var row = api.els.list.querySelector('[data-case="t3ds"] [data-notes]');
        if (row) {
          pinnedNotes = "t3ds";
          showPop("notes", "t3ds", row.closest(".side-row"));
        }
      }
    },
  });
})();
