// Quick sketches of the Work view's core composition. Static on purpose: three ways to compose the
// same 69 Tasks, compared at full size before anything real gets built.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var dir = q.get("d") || "a";
  document.documentElement.dataset.dir = dir;
  var T = NW.buildTasks();
  var I = Crew.icon;
  var esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); };
  var NEED = { quick: "Quick call", think: "Real thinking", look: "A look" };

  function foot(t) {
    var who = "";
    if (t.agent) who = '<span class="tk-word">' + "Working" + "</span>";
    else if (t.move === "you") who = '<i class="tk-dot tk-dot--' + t.need + '"></i><span class="tk-word">' + (NEED[t.need] || "") + "</span>";
    else if (t.person) who = '<span class="tk-word">' + esc(t.person) + "</span>";
    else who = '<span class="tk-word tk-word--quiet">Nobody yet</span>';
    return '<footer class="tk-foot">' + who + '<time>' + NW.formatAge(t.age) + "</time></footer>";
  }

  function card(t, opts) {
    opts = opts || {};
    var height = t.stage === "landed" ? "etched" : t.move === "you" ? "stand" : "rest";
    var head = t.agent ? '<span class="tk-face">' + Crew.face(t.agent, { pose: "working", size: 22 }) + "</span>" : "";
    var src = t.source ? '<span class="tk-src">' + Crew.brand(t.source, 12) + "</span>" : "";
    return '<article class="tk tk--' + height + (t.stalled ? " is-stalled" : "") + (opts.slip ? " tk--slip" : "") + '">' + head +
      '<h4 class="tk-title">' + esc(t.name) + src + "</h4>" +
      '<p class="tk-now">' + esc(t.now || "") + "</p>" + (opts.slip ? "" : foot(t)) + "</article>";
  }

  function pile(ts, title, line) {
    var sheets = ts.length >= 8 ? 3 : ts.length >= 4 ? 2 : 1;
    var s = "";
    for (var i = 0; i < sheets; i++) s += '<i class="pl-sheet pl-sheet--' + (i + 1) + '"></i>';
    return '<button class="pl" style="--sheets:' + sheets + '">' + s + '<span class="pl-top"><b>' + esc(title) + '</b><em>' + ts.length + "</em><small>" + esc(line) + "</small></span></button>";
  }

  // Splits one cell into piles and loose cards, the same way for every direction.
  function cell(ts, stage, max) {
    var out = "";
    var reviews = ts.filter(function (t) { return t.kind === "review" || t.kind === "mention"; });
    var prs = ts.filter(function (t) { return t.kind === "pr"; });
    var rest = ts.filter(function (t) { return reviews.indexOf(t) < 0 && prs.indexOf(t) < 0; });
    if (stage === "landed" && ts.length > 1) return pile(ts, "Landed", "This week");
    if (reviews.length >= 3) out += pile(reviews, "Reviews", "All asked this week");
    else rest = rest.concat(reviews);
    if (prs.length >= 3) out += pile(prs, "Pull requests", "2 wait on you");
    else rest = rest.concat(prs);
    var room = max - (out ? 1 : 0);
    if (rest.length > room + 1) {
      var over = rest.slice(room);
      rest = rest.slice(0, room);
      out = rest.map(function (t) { return card(t); }).join("") + out + pile(over, over.length + " more", "Oldest first");
      return out;
    }
    return rest.map(function (t) { return card(t); }).join("") + out;
  }

  function beads(ts) {
    return ts.map(function (t) {
      var c = t.stage === "landed" ? "done" : t.agent ? "agent" : t.move === "you" ? "you" : "other";
      return '<i class="bd bd--' + c + '"></i>';
    }).join("");
  }

  function ribbon(i) {
    var ps = T.filter(function (t) { return t.initiative === i.id; });
    var first = 9, last = -1;
    var cells = NW.STAGES.map(function (s, n) {
      var c = ps.filter(function (t) { return t.stage === s.id; });
      if (c.length) { first = Math.min(first, n); last = Math.max(last, n); }
      return '<span class="rb-cell">' + beads(c) + "</span>";
    }).join("");
    var pct = i.total ? i.done / i.total : 0;
    return '<section class="rb" style="--from:' + first + ";--to:" + last + '"><header class="rb-head"><b>' + esc(i.name) + "</b>" +
      (i.total ? '<span class="rb-bullet"><i style="width:' + Math.round(pct * 100) + '%"></i></span><small>' + i.done + " of " + i.total + "</small>" : "") + "</header>" +
      '<div class="rb-line"><i class="rb-wire"></i>' + cells + "</div></section>";
  }

  function stages() {
    return '<div class="stages">' + NW.STAGES.map(function (s) {
      var n = T.filter(function (t) { return t.stage === s.id; }).length;
      return '<div class="stage"><span>' + s.name + "</span><small>" + n + "</small></div>";
    }).join("") + "</div>";
  }

  var INITS = INITIATIVES;
  function looseOf(p) { return T.filter(function (t) { return t.project === p.id && !t.initiative; }); }
  function plansOf(p) { return INITS.filter(function (i) { return i.project === p.id; }); }
  function need(ts) { return ts.filter(function (t) { return t.move === "you" && t.stage !== "landed"; }).length; }

  function laneHead(p, ts) {
    var n = need(ts);
    return '<header class="ln-head"><i class="proj proj--' + p.tint + '"></i><h3>' + p.name + "</h3><small>" + ts.length + "</small>" + (n ? '<span class="ln-need">' + n + " need you</span>" : "") + "</header>";
  }

  function grid(ts, max) {
    return '<div class="grid">' + NW.STAGES.map(function (s) {
      return '<div class="col">' + cell(ts.filter(function (t) { return t.stage === s.id; }), s.id, max) + "</div>";
    }).join("") + "</div>";
  }

  function drawA() {
    return NW.PROJECTS.map(function (p) {
      var all = T.filter(function (t) { return t.project === p.id; });
      return '<section class="ln">' + laneHead(p, all) + plansOf(p).map(ribbon).join("") + grid(looseOf(p), 3) + "</section>";
    }).join("");
  }

  function drawB() {
    return NW.PROJECTS.map(function (p, n) {
      var all = T.filter(function (t) { return t.project === p.id; });
      var open = n === 0;
      var front = '<div class="dr-front">' + laneHead(p, all) + '<div class="dr-beads">' + NW.STAGES.map(function (s) {
        var c = all.filter(function (t) { return t.stage === s.id; });
        return '<span class="rb-cell">' + beads(c.slice(0, 16)) + (c.length > 16 ? "<small>+" + (c.length - 16) + "</small>" : "") + "</span>";
      }).join("") + "</div></div>";
      return '<section class="dr' + (open ? " is-open" : "") + '">' + front + (open ? '<div class="dr-floor">' + plansOf(p).map(ribbon).join("") + grid(looseOf(p), 2) + "</div>" : "") + "</section>";
    }).join("");
  }

  function drawC() {
    var horizon = '<section class="hz">' + INITS.map(ribbon).join("") + "</section>";
    var slipGrid = function (ts) {
      return '<div class="grid">' + NW.STAGES.map(function (s) {
        var c = ts.filter(function (t) { return t.stage === s.id; });
        var mine = c.filter(function (t) { return t.move === "you" && !t.stalled; }).slice(0, 2);
        var rest = c.filter(function (t) { return mine.indexOf(t) < 0; });
        var slips = rest.slice(0, 3).map(function (t) { return card(t, { slip: true }); }).join("");
        var more = rest.length > 3 ? '<button class="more">' + (rest.length - 3) + " more</button>" : "";
        return '<div class="col">' + mine.map(function (t) { return card(t); }).join("") + slips + more + "</div>";
      }).join("") + "</div>";
    };
    return horizon + NW.PROJECTS.map(function (p) {
      var all = T.filter(function (t) { return t.project === p.id; });
      return '<section class="ln">' + laneHead(p, all) + slipGrid(looseOf(p)) + "</section>";
    }).join("");
  }

  Shell.drawSidebar(document.querySelector("[data-side]"), { inboxCount: 6 });
  document.querySelector("[data-board]").innerHTML = stages() + ({ a: drawA, b: drawB, c: drawC }[dir])();
  document.querySelector("[data-switch]").innerHTML = '<h1 class="pill-title">Overview</h1><button class="ptab">' + I("office", 14) + 'Office</button><button class="ptab is-on">' + I("tasks", 14) + "Work</button>";
})();
