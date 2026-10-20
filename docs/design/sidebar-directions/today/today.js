// PROTOTYPE - the baseline: today's desktop sidebar (spec 17 §The sidebar, as amended by #473 and
// #626), drawn from this exploration's world. Every thread is its own row, grouped by project
// only, newest started first, five per project. A partner is a row like any other, so a piece of
// work with three threads takes three rows that nothing ties together.
(function () {
  "use strict";

  var CAP = 5;
  var api;

  /** Returns the threads a project shows: waiting, then working, then the rest, five at most, in the project's order. */
  function pickShown(list, openId) {
    var rank = { waiting: 0, working: 1 };
    var picked = list
      .slice()
      .sort(function (a, b) {
        var ra = rank[a.pose] != null ? rank[a.pose] : 2;
        var rb = rank[b.pose] != null ? rank[b.pose] : 2;
        return ra - rb || api.compareTimes(b.last, a.last);
      })
      .slice(0, CAP);
    var open = list.filter(function (t) { return t.id === openId; })[0];
    if (open && picked.indexOf(open) === -1) picked.push(open);
    return list.filter(function (t) { return picked.indexOf(t) !== -1; });
  }

  function drawWaiting(openId) {
    var waiting = api.listThreads(function (t) { return t.pose === "waiting"; }).sort(function (a, b) { return api.compareTimes(b.last, a.last); });
    var runs = api.world.waitingRuns;
    if (!waiting.length) return "";
    var shown = waiting.slice(0, 3);
    return (
      '<section class="side-sec"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + (waiting.length + runs.length) + "</b></h3>" +
      shown.map(function (t) {
        return '<a class="side-row side-row--wait' + (t.id === openId ? " is-on" : "") + '" href="#" data-open-row="' + t.id + '">' + api.drawFace(t, 24, "waiting") + '<span class="side-text"><span class="side-name">' + api.escapeHtml(t.title) + '</span><span class="side-ask">' + api.escapeHtml(t.ask) + "</span></span></a>";
      }).join("") +
      (waiting.length > 3 ? '<a class="side-row st-more" href="#">' + (waiting.length - 3) + " more waiting on you</a>" : "") +
      '<h4 class="side-sub">From runs</h4>' +
      runs.map(function (r) {
        return '<a class="side-row side-row--wait" href="#"><span class="side-lead">' + Crew.mark("waiting") + '</span><span class="side-text"><span class="side-name">' + r.title + '</span><span class="side-ask">' + r.ask + "</span></span></a>";
      }).join("") +
      "</section>"
    );
  }

  function drawProject(projectId, openId) {
    var list = api
      .listThreads(function (t) { return t.project === projectId; })
      .sort(function (a, b) { return api.compareTimes(b.started, a.started); });
    if (!list.length) return "";
    var p = api.getProject(projectId);
    var need = list.filter(function (t) { return t.pose === "waiting"; }).length;
    var shown = pickShown(list, openId);
    var more = list.length - shown.length + (api.state === "swarm" && p ? api.world.swarm.more[p.id] : 0);
    return (
      '<section class="side-sec">' +
      '<h3 class="side-h side-h--proj">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj st-noproj">No project</span>') +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '<button class="icon-btn icon-btn--sm" title="New thread">' + Crew.icon("plus", 14) + "</button></h3>" +
      shown.map(function (t) { return api.drawThreadRow(t, { selected: t.id === openId }); }).join("") +
      (more > 0 ? '<a class="side-row st-more" href="#">' + more + " more threads</a>" : "") +
      "</section>"
    );
  }

  function draw(el) {
    var openId = api.openId();
    var order = api.world.projects
      .map(function (p) { return p.id; })
      .sort(function (a, b) {
        var na = api.listLeads(a).concat(api.listThreads(function (t) { return t.project === a; }));
        var nb = api.listLeads(b).concat(api.listThreads(function (t) { return t.project === b; }));
        var la = na.reduce(function (m, t) { return api.compareTimes(t.started, m) > 0 ? t.started : m; }, "00:00");
        var lb = nb.reduce(function (m, t) { return api.compareTimes(t.started, m) > 0 ? t.started : m; }, "00:00");
        return api.compareTimes(lb, la);
      });
    el.innerHTML = drawWaiting(openId) + order.map(function (id) { return drawProject(id, openId); }).join("") + drawProject(null, openId);
    el.querySelectorAll("[data-open-row]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        api.open(a.dataset.openRow);
      });
    });
  }

  Stage.direction({
    rootClass: "d-today",
    drawList: function (el, a) {
      api = a;
      draw(el);
    },
    onOpen: function () {
      if (api) draw(api.els.list);
    },
  });
})();
