// PROTOTYPE - Atlas: your agents, on the map of your code.
//
// The work is organized by where in the code it happens. A thread lives in the area (folder) of
// its repository that it edits most, read from the edits Hercule already watches for Edit Overlap.
// The window draws that idea three ways:
//   - the sidebar (Territories, folded): a minimap of the code on top, then Waiting on you, then
//     project › area › threads, with each row's line 2 saying the file it is in and its diff;
//   - the overview's three modes: Office (the City, the office builder's module), Threads
//     (Territories at full width, with the crossings beside them) and Lines (a transit map of
//     every branch heading for main, with the suggested landing order);
//   - the selection card, shared by the three modes.
//
// States (?state=): everyday, open, swarm, away, crossing (the 3-D Secure and cart refactor
// crossing at payment.ts, lit in every mode), land (the landing order applied: Tidy checkout CSS
// reaches main first). ?mode=office|threads|lines, ?select=<id>|none, ?theme=.
//
// Keys while the overview is open: O, T, L pick a mode; up and down walk the selection; return
// opens it; esc closes a card, then the overview. Cmd+Shift+O opens and closes the overview.
(function () {
  "use strict";

  var W = window.WORLD;
  var A = window.ATLAS;
  var H = W.helpers;
  var params = new URLSearchParams(location.search);
  var root = document.documentElement;
  var STATE = root.dataset.state || "everyday";
  var SWARM = STATE === "swarm";
  var AWAY = STATE === "away";
  var MODES = ["office", "threads", "lines"];
  var MODE_NAMES = { office: "Office", threads: "Threads", lines: "Lines" };
  var MODE_KEYS = { office: "O", threads: "T", lines: "L" };
  var AWAY_LEFT = W.away.left;

  var mode = MODES.indexOf(params.get("mode")) !== -1 ? params.get("mode") : STATE === "crossing" || STATE === "land" ? "lines" : "threads";
  var overviewOpen = STATE !== "open";
  var selected = params.get("select");
  if (selected === "none") selected = null;
  else if (!selected) selected = "t3ds";
  // The Office opens on its establishing shot, and flies to a thread only once the user chose one:
  // in another mode, or by the address. The default selection drives the card alone.
  var userSelected = !!params.get("select") && selected !== null;
  var landed = STATE === "land";
  var focusKey = STATE === "crossing" ? keyOfCrossing(W.crossings[0]) : null;
  var filter = null; // { project, path } while a minimap tile filters the lists
  var sinceLeft = AWAY; // Lines draws what is new since 09:01
  var answered = {}; // session id -> the fields it had before it was answered, for Undo
  var waitOpen = false; // Waiting on you shows three, then "n more", until it is opened
  var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  var api = null; // the Stage's API, once the window is built
  var ov = null; // the overview's root element, kept while a thread is open
  var office = null; // the Office module's handle once mounted
  var officeTried = false;

  /* ------------------------------------------------------------------ small helpers */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }
  function keyOfCrossing(c) {
    return c.a + "|" + c.b + "|" + c.path;
  }
  function minutes(t) {
    return H.minutes(t);
  }
  function sum(list, fn) {
    var s = 0;
    list.forEach(function (x) { s += fn(x); });
    return s;
  }
  function baseName(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  function folderOf(path) {
    var i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }
  /** Returns a count with its noun: "1 area", "3 areas". */
  function plural(n, noun) {
    return n + " " + noun + (n === 1 ? "" : "s");
  }
  function fmt(n) {
    return n.toLocaleString("en-US");
  }
  /** Returns the diff as markup: "+48 −12" in the mono face, the minus omitted when it is 0 and both are shown when both are 0. */
  function drawDiff(d, opts) {
    opts = opts || {};
    if (!d) return "";
    var out = [];
    if (d.plus || !d.minus) out.push('<span class="plus">+' + fmt(d.plus) + "</span>");
    if (d.minus || opts.both) out.push('<span class="minus">−' + fmt(d.minus) + "</span>");
    return '<span class="at-diff mono">' + out.join(" ") + "</span>";
  }

  /* ------------------------------------------------------------------ sessions */

  /** Returns the session with this id: a thread in view, or a run's session, or null. */
  function getSession(id) {
    if (!id) return null;
    var t = api ? api.getThread(id) : null;
    if (t) return t;
    var rs = W.runSessions[id];
    if (!rs) return null;
    var run = findRun(rs.run);
    return {
      id: id, kind: "run", title: run.title, stepTitle: rs.title, run: run, project: rs.project, provider: rs.provider, model: rs.model,
      machine: rs.machine, pose: rs.pose, status: rs.pose === "waiting" ? "approval" : rs.pose === "working" ? "working" : null,
      ask: rs.ask, askShort: rs.ask, started: rs.started, last: rs.last,
    };
  }
  function findRun(id) {
    return W.runs.filter(function (r) { return r.id === id; })[0];
  }
  function isRun(id) {
    return !!W.runSessions[id];
  }
  /** Returns the look's hue of a session, from its title as the book seeds faces. */
  function hueOf(id) {
    var s = getSession(id);
    return Crew.lookFor(s ? s.title : id).hue;
  }
  function hueStyle(id) {
    return 'style="--hue:var(--hue-' + hueOf(id) + ')"';
  }
  function drawFace(id, size, pose) {
    var s = getSession(id);
    return Crew.face(s.title, { pose: pose || s.pose, size: size });
  }

  /** Returns the threads in view: the morning's sixteen, and the swarm's in the swarm state. */
  function listLive() {
    return api.listThreads();
  }
  /** Returns the run sessions whose step edits or reads code, which the territory counts. */
  function listRunSessions() {
    return ["rRoundingFix", "rWebhookFix", "rBackupInvestigate"];
  }
  /** Returns every session that works in code: the threads in view and the runs' sessions. */
  function listWorkers() {
    return listLive().map(function (t) { return t.id; }).concat(listRunSessions());
  }

  function filesOf(id) {
    return W.files[id] || { area: null, now: null, touched: [] };
  }
  function editsOf(id) {
    return filesOf(id).touched.filter(function (f) { return f.how === "edit"; });
  }
  function readsOf(id) {
    return filesOf(id).touched.filter(function (f) { return f.how === "read"; });
  }
  /** Returns a session's own diff: the sum of its edits. */
  function diffOf(id) {
    var e = editsOf(id);
    return { plus: sum(e, function (f) { return f.plus; }), minus: sum(e, function (f) { return f.minus; }), files: e.length };
  }
  /** Returns the file a row names: the one it is in now, else its largest edit, else its first read. */
  function pickFile(id) {
    var f = filesOf(id);
    if (f.now) return f.now;
    var e = editsOf(id).slice().sort(function (a, b) { return b.plus + b.minus - (a.plus + a.minus); })[0];
    if (e) return e.path;
    var r = readsOf(id)[0];
    return r ? r.path : null;
  }
  function onlyReads(id) {
    return !!filesOf(id).library;
  }
  /** Returns the area a session lives in on the map: its own, or its lead's for a partner with no checkout. */
  function homeArea(id) {
    var f = filesOf(id);
    if (f.area) return f.area;
    var t = getSession(id);
    if (t && t.lead && filesOf(t.lead).area) return filesOf(t.lead).area;
    return null;
  }
  function projectOf(id) {
    var s = getSession(id);
    return s ? s.project : null;
  }

  /* ------------------------------------------------------------------ waiting, crossings */

  /** Returns what waits on Rogier, oldest first: threads, then the runs' steps. */
  function listWaiting() {
    var threads = listLive().filter(function (t) { return t.pose === "waiting"; })
      .sort(function (a, b) { return minutes(a.last) - minutes(b.last); })
      .map(function (t) { return t.id; });
    var runs = W.waitingRuns.filter(function (r) { return !answered[r.id]; }).map(function (r) { return r.id; });
    return { threads: threads, runs: runs, all: threads.concat(runs) };
  }
  function isWaiting(id) {
    if (id === "rShip") return !answered.rShip;
    var s = getSession(id);
    return !!s && s.pose === "waiting";
  }

  /** Returns the crossings in view: both sessions present, the swarm's only in the swarm. */
  function listCrossings() {
    var live = {};
    listWorkers().forEach(function (id) { live[id] = true; });
    return W.crossings.filter(function (c) { return (!c.swarm || SWARM) && live[c.a] && live[c.b]; });
  }
  function crossingsOf(id) {
    return listCrossings().filter(function (c) { return c.a === id || c.b === id; });
  }
  function otherOf(c, id) {
    return c.a === id ? c.b : c.a;
  }
  function startOf(id) {
    var s = getSession(id);
    return s ? s.started : "00:00";
  }
  /** Checks that a crossing began while Rogier was away (09:01-09:41): the later of the two started after he left. */
  function isNewSinceLeft(c) {
    return Math.max(minutes(startOf(c.a)), minutes(startOf(c.b))) > minutes(AWAY_LEFT);
  }
  /** Returns the glyph of a crossing: two strokes crossing, one in each session's hue. */
  function drawCrossGlyph(c, size) {
    size = size || 14;
    return (
      '<svg class="at-xglyph" viewBox="0 0 14 14" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      "<g " + hueStyle(c.a) + '><path d="M2.2 3.4 11.8 10.6"/></g>' +
      "<g " + hueStyle(c.b) + '><path d="M2.2 10.6 11.8 3.4"/></g></svg>'
    );
  }
  function describeKind(c) {
    return c.kind === "conflict" ? "would conflict" : "both edit";
  }

  /* ------------------------------------------------------------------ territories */

  /** Returns the edits today per folder of a project: { path: { plus, minus } }. */
  function measureHeat(project) {
    var out = {};
    listWorkers().forEach(function (id) {
      if (projectOf(id) !== project) return;
      editsOf(id).forEach(function (f) {
        var k = folderOf(f.path);
        out[k] = out[k] || { plus: 0, minus: 0 };
        out[k].plus += f.plus;
        out[k].minus += f.minus;
      });
    });
    return out;
  }
  var HEAT_MAX = null;
  /** Returns 0..1 for a folder's edits today, on a square-root scale against the busiest folder. */
  function scaleHeat(h) {
    if (HEAT_MAX == null) {
      HEAT_MAX = 1;
      W.projects.forEach(function (p) {
        var m = measureHeat(p.id);
        Object.keys(m).forEach(function (k) { HEAT_MAX = Math.max(HEAT_MAX, m[k].plus + m[k].minus); });
      });
    }
    if (!h) return 0;
    return Math.sqrt((h.plus + h.minus) / HEAT_MAX);
  }

  /**
   * Returns the territories: per project, its areas, busiest first, and its Library last. An area
   * is { path, library, threads, heat, visitors, crossings }. Visitors are sessions that edit in
   * the area while they live elsewhere; they are what a crossing in an area is usually made of.
   */
  function buildTerritories() {
    var live = listLive();
    var crossings = listCrossings();
    return W.projects.map(function (p) {
      var heat = measureHeat(p.id);
      var byPath = {};
      var order = [];
      live.filter(function (t) { return t.project === p.id; }).forEach(function (t) {
        var lib = onlyReads(t.id) || !filesOf(t.id).area;
        var key = lib ? "~library" : filesOf(t.id).area;
        if (!byPath[key]) {
          byPath[key] = { path: lib ? "Library" : key, library: lib, threads: [], heat: lib ? null : heat[key] || { plus: 0, minus: 0 }, visitors: [], crossings: [] };
          order.push(key);
        }
        byPath[key].threads.push(t);
      });
      order.forEach(function (key) {
        var area = byPath[key];
        if (area.library) return;
        listWorkers().forEach(function (id) {
          if (projectOf(id) !== p.id || filesOf(id).area === key) return;
          if (editsOf(id).some(function (f) { return folderOf(f.path) === key; })) area.visitors.push(id);
        });
        area.crossings = crossings.filter(function (c) { return projectOf(c.a) === p.id && folderOf(c.path) === key; });
      });
      var areas = order.map(function (k) { return byPath[k]; }).sort(function (a, b) {
        if (a.library !== b.library) return a.library ? 1 : -1;
        if (a.library) return 0;
        return b.heat.plus + b.heat.minus - (a.heat.plus + a.heat.minus);
      });
      areas.forEach(function (a) {
        a.threads.sort(function (x, y) { return minutes(y.started) - minutes(x.started); });
      });
      return { project: p, areas: areas };
    });
  }
  function matchesFilter(project, path) {
    return !filter || (filter.project === project && filter.path === path);
  }

  /* ------------------------------------------------------------------ the minimap */

  /** Returns the rectangles of a squarified treemap of items ({ value }) inside a rectangle. */
  function squarify(items, x, y, w, h) {
    var out = [];
    var rest = items.slice().sort(function (a, b) { return b.value - a.value; });
    var total = sum(rest, function (i) { return i.value; });
    var scale = (w * h) / total;
    var r = { x: x, y: y, w: w, h: h };
    var row = [];
    function worst(list, side) {
      var s = sum(list, function (i) { return i.value * scale; });
      var max = 0;
      var min = Infinity;
      list.forEach(function (i) {
        max = Math.max(max, i.value * scale);
        min = Math.min(min, i.value * scale);
      });
      return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
    }
    function place(list) {
      var s = sum(list, function (i) { return i.value * scale; });
      if (r.w >= r.h) {
        var cw = s / r.h;
        var cy = r.y;
        list.forEach(function (i) {
          var ih = (i.value * scale) / cw;
          out.push({ item: i, x: r.x, y: cy, w: cw, h: ih });
          cy += ih;
        });
        r.x += cw;
        r.w -= cw;
      } else {
        var rh = s / r.w;
        var cx = r.x;
        list.forEach(function (i) {
          var iw = (i.value * scale) / rh;
          out.push({ item: i, x: cx, y: r.y, w: iw, h: rh });
          cx += iw;
        });
        r.y += rh;
        r.h -= rh;
      }
    }
    while (rest.length) {
      var side = Math.min(r.w, r.h);
      if (!row.length || worst(row.concat([rest[0]]), side) <= worst(row, side)) row.push(rest.shift());
      else {
        place(row);
        row = [];
      }
    }
    if (row.length) place(row);
    return out;
  }

  /** Returns the dots of the minimap: who sits in which folder of which project. */
  function placeDots() {
    var out = {};
    listWorkers().forEach(function (id) {
      var p = projectOf(id);
      var area = homeArea(id);
      if (!p || !area) return;
      var k = p + "|" + area;
      (out[k] = out[k] || []).push(id);
    });
    // A partner with no checkout sits with its lead (tPayoutCheck in src/reports).
    listLive().forEach(function (t) {
      if (filesOf(t.id).area || !t.lead || !t.project) return;
      var area = homeArea(t.id);
      if (!area) return;
      var k = t.project + "|" + area;
      out[k] = out[k] || [];
      if (out[k].indexOf(t.id) === -1) out[k].push(t.id);
    });
    Object.keys(out).forEach(function (k) {
      out[k].sort(function (a, b) { return rankDot(a) - rankDot(b); });
    });
    return out;
  }
  function rankDot(id) {
    return isWaiting(id) ? 0 : onlyReads(id) ? 3 : getSession(id) && getSession(id).pose === "working" ? 1 : 2;
  }

  /** Draws the minimap into its element: three projects, folders as tiles sized by lines and shaded by today's edits, a dot per agent. */
  function renderMinimap() {
    var el = api.els.side.querySelector(".at-mm");
    var mapW = 248;
    var mapH = 74;
    var gap = 5;
    var blocks = W.projects.map(function (p) {
      var repo = W.repos[p.id];
      var folders = repo.folders.map(function (f) {
        return { path: f.path, value: sum(f.files.filter(function (x) { return !x.newIn; }), function (x) { return x.lines; }) || 20, files: f.files.length };
      });
      return { p: p, folders: folders, total: sum(folders, function (f) { return f.value; }) };
    });
    // Blocks are sized by the square root of their lines, so a repository of JSON dashboards does not crowd out the others, and never narrower than their name.
    var weights = blocks.map(function (b) { return Math.max(Math.sqrt(b.total), 104); });
    var wsum = sum(weights, function (x) { return x; });
    var dots = placeDots();
    var x = 0;
    var html = "";
    blocks.forEach(function (b, bi) {
      var bw = Math.round(((mapW - gap * (blocks.length - 1)) * weights[bi]) / wsum);
      if (bi === blocks.length - 1) bw = mapW - x;
      var heat = measureHeat(b.p.id);
      var rects = squarify(b.folders, 0, 0, bw, mapH);
      html += '<div class="at-mm-block proj--' + b.p.tint + '" style="left:' + x + "px;width:" + bw + 'px">';
      html += '<span class="at-mm-name">' + esc(b.p.name) + "</span>";
      html += '<div class="at-mm-tiles" style="height:' + mapH + 'px">';
      rects.forEach(function (r) {
        var f = r.item;
        var h = heat[f.path];
        var level = scaleHeat(h);
        var who = dots[b.p.id + "|" + f.path] || [];
        var on = filter && filter.project === b.p.id && filter.path === f.path;
        var dim = filter && !on;
        var tip = b.p.name + " › " + f.path + " · " + fmt(f.value) + " lines" + (h ? " · today +" + fmt(h.plus) + " −" + fmt(h.minus) : " · no edits today") + (who.length ? " · " + who.length + (who.length === 1 ? " agent" : " agents") : "");
        html +=
          '<button class="at-mm-tile' + (on ? " is-on" : "") + (dim ? " is-dim" : "") + (level ? " is-warm" : "") + '" data-tile="' + b.p.id + "|" + esc(f.path) + '" title="' + esc(tip) + '" style="left:' + (r.x + 1).toFixed(1) + "px;top:" + (r.y + 1).toFixed(1) + "px;width:" + Math.max(1, r.w - 2).toFixed(1) + "px;height:" + Math.max(1, r.h - 2).toFixed(1) + "px;--h:" + level.toFixed(3) + '">' +
          drawTileDots(who, r.w - 2, r.h - 2) +
          "</button>";
      });
      html += "</div></div>";
      x += bw + gap;
    });
    var foot = filter
      ? '<span class="at-mm-chip"><span class="mono">' + esc(filter.path) + '</span><span class="faint">in ' + esc(filter.project) + '</span><button class="icon-btn icon-btn--sm" data-act="clear-filter" title="Show every area">' + Crew.icon("close", 12) + "</button></span>"
      : '<span class="at-mm-legend"><i class="at-mm-lg-tile proj--webshop"></i>Folders by size, shaded by edits today</span>';
    el.innerHTML = '<div class="at-mm-map" style="height:' + (mapH + 16) + 'px">' + html + '</div><div class="at-mm-foot">' + foot + "</div>";
  }

  /** Returns the dots inside one tile, as many as fit: waiting first, then working, idle, and readers as rings. */
  function drawTileDots(ids, w, h) {
    if (!ids.length || w < 9 || h < 9) return "";
    var cols = Math.max(1, Math.floor((w - 3) / 8));
    var rows = Math.max(1, Math.floor((h - 3) / 8));
    var shown = ids.slice(0, cols * rows);
    return (
      '<span class="at-mm-dots" style="grid-template-columns:repeat(' + Math.min(cols, shown.length) + ',6px)">' +
      shown.map(function (id) {
        var cls = isWaiting(id) ? " is-you" : onlyReads(id) ? " is-reader" : "";
        return '<i class="at-mm-dot' + cls + (id === selected ? " is-sel" : "") + '" ' + hueStyle(id) + "></i>";
      }).join("") +
      "</span>"
    );
  }

  /* ------------------------------------------------------------------ the sidebar: Territories, folded */

  /** Returns a row's line 2: the file it is in (its name, the full path on hover) and its diff, or what it reads. */
  function drawFileLine(t) {
    var path = pickFile(t.id);
    if (!path) return null;
    var reader = onlyReads(t.id);
    var d = diffOf(t.id);
    var tail = reader
      ? '<span class="at-reads">reads ' + readsOf(t.id).length + "</span>"
      : drawDiff(d);
    var xing = crossingsOf(t.id).filter(function (c) { return c.path === path && c.kind === "conflict"; })[0];
    return (
      '<span class="st-clip at-file mono' + (xing ? " is-x" : "") + '" title="' + esc(path) + '">' + esc(baseName(path)) + "</span>" +
      '<span class="st-keep at-tail">' + tail + "</span>"
    );
  }

  /** Returns the header of an area in the sidebar: its path, a heat bar, and a crossing chip when two sessions share a file there. */
  function drawSideArea(area, project) {
    if (area.library) {
      return '<div class="at-s-ah at-s-ah--lib"><span class="at-s-lib">' + Crew.icon("eye", 12) + "Library</span><span class=\"at-s-sub\">reads only</span></div>";
    }
    var level = scaleHeat(area.heat);
    var x = area.crossings.slice().sort(function (a, b) { return a.kind === "conflict" ? -1 : b.kind === "conflict" ? 1 : 0; })[0];
    var chip = x
      ? '<button class="at-xchip at-xchip--' + x.kind + (focusKey === keyOfCrossing(x) ? " is-on" : "") + '" data-act="focus-crossing" data-key="' + esc(keyOfCrossing(x)) + '" title="' + esc("2 sessions in " + x.path + ": " + getSession(x.a).title + " and " + getSession(x.b).title + (x.kind === "conflict" ? ". Their branches would conflict." : ". Both edit it.")) + '">' + drawCrossGlyph(x, 12) + '<span class="mono">' + esc(baseName(x.path)) + "</span></button>"
      : "";
    return (
      '<div class="at-s-ah" data-area="' + esc(project + "|" + area.path) + '">' +
      '<span class="at-s-path mono" title="' + esc(project + " › " + area.path + " · today +" + area.heat.plus + " −" + area.heat.minus) + '">' + esc(area.path) + "</span>" +
      '<i class="at-heat" title="Edits today: +' + area.heat.plus + " −" + area.heat.minus + '"><b style="width:' + Math.round(level * 100) + '%"></b></i>' +
      '<span class="spacer"></span>' + chip +
      "</div>"
    );
  }

  /** Draws the sidebar's list: an away briefing, Waiting on you, then every project's areas and threads. */
  function renderSidebar() {
    var list = api.els.list;
    var keep = list.scrollTop;
    var w = listWaiting();
    var html = "";
    if (AWAY) html += drawAwayStrip();
    if (w.all.length) {
      html += '<section class="side-sec at-s-wait"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + w.all.length + "</b></h3>";
      var cap = waitOpen ? w.threads.length : Math.min(3, w.threads.length);
      w.threads.slice(0, cap).forEach(function (id) {
        var t = getSession(id);
        html += '<a class="side-row side-row--wait at-s-wrow' + (isSel(id) ? " is-on" : "") + '" href="#" data-row="' + id + '">' + drawFace(id, 24, "waiting") + '<span class="side-text"><span class="side-name">' + esc(t.title) + '</span><span class="side-ask">' + esc(t.askShort) + "</span></span></a>";
      });
      if (w.threads.length > cap) html += '<a class="side-row side-row--more st-more at-s-more" href="#" data-act="wait-more">' + (w.threads.length - cap) + " more</a>";
      if (w.runs.length) {
        html += '<h4 class="side-sub">From runs</h4>';
        w.runs.forEach(function (id) {
          var r = W.waitingRuns.filter(function (x) { return x.id === id; })[0];
          html += '<a class="side-row side-row--wait at-s-wrow' + (isSel(id) ? " is-on" : "") + '" href="#" data-row="' + id + '">' + Crew.face("Ship release", { pose: "waiting", size: 24 }) + '<span class="side-text"><span class="side-name">' + esc(r.title) + '</span><span class="side-ask">' + esc(r.ask) + "</span></span></a>";
        });
      }
      html += "</section>";
    }
    buildTerritories().forEach(function (terr) {
      var p = terr.project;
      var areas = terr.areas.filter(function (a) { return matchesFilter(p.id, a.path); });
      if (!areas.length) return;
      var need = sum(areas, function (a) { return a.threads.filter(function (t) { return t.pose === "waiting"; }).length; });
      html += '<section class="side-sec at-s-proj"><h3 class="side-h side-h--proj"><span class="proj proj--' + p.tint + '">' + esc(p.name) + "</span>" + (need ? '<span class="st-need">' + need + " need" + (need === 1 ? "s" : "") + " you</span>" : "") + '<button class="icon-btn icon-btn--sm" title="New thread in ' + esc(p.name) + '">' + Crew.icon("plus", 14) + "</button></h3>";
      areas.forEach(function (area) {
        html += '<div class="at-s-area proj--' + p.tint + '">' + drawSideArea(area, p.id);
        area.threads.forEach(function (t) {
          html += drawSideRow(t);
        });
        html += "</div>";
      });
      if (SWARM && W.swarm.more[p.id] && !filter) html += '<a class="side-row side-row--more st-more" href="#">' + W.swarm.more[p.id] + " more</a>";
      html += "</section>";
    });
    if (!filter) {
      var loose = listLive().filter(function (t) { return !t.project; });
      if (loose.length) {
        html += '<section class="side-sec at-s-proj"><h3 class="side-h side-h--proj"><span class="proj at-noproj">No project</span></h3>';
        loose.forEach(function (t) { html += drawSideRow(t); });
        html += "</section>";
      }
      html += '<section class="side-sec at-s-done"><a class="side-row side-row--more" href="#">' + Crew.icon("check", 14) + "<span>Done</span><span class=\"spacer\"></span><span class=\"side-end\">" + W.doneCount + "</span></a></section>";
    }
    list.innerHTML = html;
    list.scrollTop = keep;
    markCrossingRows();
  }

  function drawSideRow(t) {
    var detail = drawFileLine(t);
    var opts = { selected: isSel(t.id), cls: "at-s-row" };
    if (detail) opts.detail = detail;
    return api.drawThreadRow(t, opts).replace('data-open-row="', 'data-row="');
  }

  /** Returns the briefing at the top of the sidebar after Rogier was away. */
  function drawAwayStrip() {
    var b = measureAway();
    return (
      '<div class="at-s-away">' +
      '<div class="at-s-away-h"><b>Back after 40m</b><span class="faint">since ' + AWAY_LEFT + "</span></div>" +
      '<div class="at-s-away-t">' + b.crossings + " new crossings, " + b.conflicts + " would conflict · " + b.stations + " new stations on " + b.branches + " branches</div>" +
      '<button class="btn btn--sm at-s-away-btn" data-act="show-since">' + Crew.icon("branch", 13) + "See it on the map</button>" +
      "</div>"
    );
  }
  /** Returns what changed while Rogier was away, counted from the world. */
  function measureAway() {
    var cut = minutes(AWAY_LEFT);
    var stations = 0;
    var branches = 0;
    Object.keys(W.branches).forEach(function (ws) {
      var b = W.branches[ws];
      if (b.landOrder == null || !api.getThread(b.lead)) return;
      var n = b.stations.filter(function (s) { return minutes(s.at) > cut; }).length;
      stations += n;
      if (n) branches++;
    });
    var xs = listCrossings().filter(isNewSinceLeft);
    return { stations: stations, branches: branches, crossings: xs.length, conflicts: xs.filter(function (c) { return c.kind === "conflict"; }).length };
  }

  /** Marks the rows of the focused crossing's two threads, in the sidebar and in Threads. */
  function markCrossingRows() {
    var c = focusedCrossing();
    document.querySelectorAll(".ov-atlas .is-xing").forEach(function (el) { el.classList.remove("is-xing"); });
    if (!c) return;
    [c.a, c.b].forEach(function (id) {
      document.querySelectorAll('.ov-atlas [data-row="' + id + '"], .ov-atlas [data-trow="' + id + '"]').forEach(function (el) {
        (el.closest(".st-thread") || el).classList.add("is-xing");
      });
    });
  }
  function focusedCrossing() {
    if (!focusKey) return null;
    return listCrossings().filter(function (c) { return keyOfCrossing(c) === focusKey; })[0] || null;
  }
  function isSel(id) {
    return overviewOpen ? id === selected : api && id === api.openId();
  }

  /* ------------------------------------------------------------------ the overview: frame and top bar */

  function buildOverview() {
    ov = document.createElement("div");
    ov.className = "at-ov";
    ov.innerHTML =
      '<header class="top at-top" data-top></header>' +
      '<div class="at-panes">' +
      '<section class="at-pane at-pane--office" data-pane-mode="office"><div class="at-office" data-office-host></div></section>' +
      '<section class="at-pane at-pane--threads" data-pane-mode="threads"><div class="at-tl" data-tl></div><aside class="at-side" data-xside><div class="at-side-body" data-xlist></div></aside></section>' +
      '<section class="at-pane at-pane--lines" data-pane-mode="lines"><div class="at-map" data-map></div><aside class="at-side at-side--board" data-board></aside></section>' +
      "</div>" +
      '<div class="at-card glass" data-card hidden></div>' +
      '<div class="at-pop glass" data-pop hidden></div>';
    ov.addEventListener("click", onOverviewClick);
    ov.addEventListener("mouseover", onOverviewHover);
    ov.addEventListener("mouseout", onOverviewHover);
  }

  /**
   * Returns the counts every mode shares: working, waiting, idle, and the crossings. Waiting counts
   * everything in Waiting on you, the runs' steps included, so the sidebar, the top bar and the
   * foot always agree (4 on the morning: 3 threads and the Ship release step).
   */
  function countAll() {
    var c = { working: 0, waiting: 0, idle: 0 };
    listLive().forEach(function (t) {
      if (c[t.pose] !== undefined && t.pose !== "waiting") c[t.pose]++;
    });
    c.waiting = listWaiting().all.length;
    var xs = listCrossings();
    c.crossings = xs.length;
    c.conflicts = xs.filter(function (x) { return x.kind === "conflict"; }).length;
    return c;
  }

  function renderTop() {
    var top = ov.querySelector("[data-top]");
    var c = countAll();
    var icons = { office: "office", threads: "list", lines: "branch" };
    top.innerHTML =
      '<nav class="pill at-switch" aria-label="Overview mode">' +
      MODES.map(function (m) {
        return '<button class="ptab" data-act="mode" data-mode="' + m + '" aria-pressed="' + (m === mode) + '" title="' + MODE_NAMES[m] + "  " + MODE_KEYS[m] + '">' + Crew.icon(icons[m], 14) + MODE_NAMES[m] + "</button>";
      }).join("") +
      "</nav>" +
      (filter ? '<span class="pill at-filter"><span class="at-filter-l">' + Crew.icon("filter", 13) + '<span class="mono">' + esc(filter.path) + '</span></span><button class="icon-btn icon-btn--sm" data-act="clear-filter" title="Show every area">' + Crew.icon("close", 12) + "</button></span>" : "") +
      (mode === "lines" && AWAY ? '<span class="pill"><button class="pill-btn at-since" role="switch" aria-checked="' + sinceLeft + '" data-act="toggle-since">New since ' + AWAY_LEFT + '<span class="toggle" aria-hidden="true"></span></button></span>' : "") +
      '<span class="spacer"></span>' +
      '<span class="pill at-sum" aria-label="Who is doing what">' +
      "<span>" + Crew.mark("working") + "<b>" + c.working + "</b> working</span>" +
      '<span class="at-sum-you">' + Crew.mark("waiting") + "<b>" + c.waiting + "</b> waiting on you</span>" +
      "<span>" + Crew.mark("idle") + "<b>" + c.idle + "</b> idle</span>" +
      '<button class="at-sum-x" data-act="next-crossing" title="' + c.crossings + " crossings: two sessions edit one file, and " + c.conflicts + " would conflict at merge. " + (mode === "office" ? "Fly to the next one." : "Show the conflict.") + '">' + Crew.icon("overlap", 14) + "<b>" + c.crossings + "</b> crossings</button>" +
      "</span>" +
      '<span class="pill"><button class="pill-btn" data-act="close" title="Close the overview  esc">Close<kbd>esc</kbd></button></span>';
  }

  /* ------------------------------------------------------------------ Threads mode: Territories at full width */

  function renderThreads() {
    var el = ov.querySelector("[data-tl]");
    var keep = el.scrollTop;
    var w = listWaiting();
    var html = "";
    if (AWAY) html += drawAwayBanner();
    if (w.all.length) {
      html += '<section class="at-tl-sec at-tl-wait"><h2 class="at-tl-h">Waiting on you <b class="count count--you">' + w.all.length + '</b><span class="faint">oldest ' + H.ago(getSession(w.all[0]) ? getSession(w.all[0]).last : "09:33") + "</span></h2>";
      w.all.forEach(function (id) {
        html += drawWaitRow(id);
      });
      html += "</section>";
    }
    buildTerritories().forEach(function (terr) {
      var p = terr.project;
      var areas = terr.areas.filter(function (a) { return matchesFilter(p.id, a.path); });
      if (!areas.length) return;
      var all = sum(areas, function (a) { return a.threads.length; });
      var hp = sum(areas, function (a) { return a.heat ? a.heat.plus : 0; });
      var hm = sum(areas, function (a) { return a.heat ? a.heat.minus : 0; });
      html += '<section class="at-tl-sec"><h2 class="at-tl-h"><span class="proj proj--' + p.tint + '">' + esc(p.name) + '</span><span class="faint">' + plural(areas.filter(function (a) { return !a.library; }).length, "area") + " · " + plural(all, "thread") + "</span>" + '<span class="spacer"></span><span class="at-tl-today">today ' + drawDiff({ plus: hp, minus: hm }, { both: true }) + "</span></h2>";
      areas.forEach(function (area) {
        html += drawArea(area, p);
      });
      if (SWARM && W.swarm.more[p.id] && !filter) html += '<div class="at-tl-more">' + W.swarm.more[p.id] + " more threads in " + esc(p.name) + ", quiet today</div>";
      html += "</section>";
    });
    if (!filter) {
      var loose = listLive().filter(function (t) { return !t.project; });
      if (loose.length) {
        html += '<section class="at-tl-sec"><h2 class="at-tl-h"><span class="proj at-noproj">No project</span><span class="faint">no repository</span></h2>';
        loose.forEach(function (t) { html += drawTRow(t, null); });
        html += "</section>";
      }
    }
    el.innerHTML = html;
    el.scrollTop = keep;
    renderCrossingsPanel();
    markCrossingRows();
  }

  function drawAwayBanner() {
    var b = measureAway();
    return (
      '<section class="at-away">' +
      '<div class="at-away-h"><span class="at-away-k">Welcome back</span><b>You were away 40 minutes, ' + AWAY_LEFT + "-" + W.now + ".</b></div>" +
      '<div class="at-away-facts">' +
      '<span><b class="deco-num">' + b.crossings + "</b>new crossings<small>" + b.conflicts + " would conflict at merge</small></span>" +
      '<span><b class="deco-num">' + b.stations + "</b>new stations<small>on " + b.branches + " branches</small></span>" +
      '<span><b class="deco-num">' + listWaiting().all.length + "</b>wait on you<small>oldest since 09:31</small></span>" +
      "</div>" +
      '<button class="btn btn--sm" data-act="show-since">' + Crew.icon("branch", 13) + "Show what moved on the map</button>" +
      "</section>"
    );
  }

  /** Returns a row of Waiting on you at full width: face, title, ask, where it works, age and the answers. */
  function drawWaitRow(id) {
    var s;
    var ask;
    var where;
    if (id === "rShip") {
      var r = W.waitingRuns[0];
      s = { title: "Ship release v2.15", last: r.last };
      ask = esc(W.runSessions.rShip.ask);
      where = '<span class="proj proj--payments">payments-api</span><span class="faint">Run · Ship release · publish</span>';
    } else {
      s = getSession(id);
      ask = drawAsk(s);
      var area = homeArea(id);
      where = '<span class="proj proj--' + W.projects.filter(function (p) { return p.id === s.project; })[0].tint + '">' + esc(s.project) + "</span>" + (area ? '<span class="mono at-tl-wpath">' + esc(area) + "</span>" : '<span class="faint">scratch · no checkout</span>');
    }
    return (
      '<div class="at-tl-wrow' + (id === selected ? " is-on" : "") + '" data-trow="' + id + '">' +
      (id === "rShip" ? Crew.face("Ship release", { pose: "waiting", size: 32 }) : drawFace(id, 32, "waiting")) +
      '<div class="at-tl-wmain"><b>' + esc(s.title) + '</b><span class="at-tl-ask">' + ask + "</span></div>" +
      '<div class="at-tl-where">' + where + "</div>" +
      '<span class="at-tl-age">' + H.ago(s.last) + "</span>" +
      '<div class="at-tl-ans">' + drawAnswers(id) + "</div>" +
      "</div>"
    );
  }

  /** Returns a Request as markup: a command in the mono face, a question as text. */
  function drawAsk(s) {
    if (!s || !s.ask) return "";
    var m = /^Run (.+)\?$/.exec(s.ask);
    if (m) return "Run <code>" + esc(m[1]) + "</code>?";
    return esc(s.ask);
  }
  function drawAnswers(id, small) {
    var list = A.answers[id] || [];
    return list.map(function (a, i) {
      var cls = a.accent ? "btn--accent" : a.danger ? "btn--danger" : a.quiet ? "btn--quiet" : "";
      return '<button class="btn btn--sm ' + cls + '" data-act="answer" data-id="' + id + '" data-idx="' + i + '">' + esc(a.label) + "</button>";
    }).join("");
  }

  /** Returns an area at full width: its header (path, heat, who edits here, crossings), then its threads. */
  function drawArea(area, p) {
    var html = '<div class="at-tl-area">';
    if (area.library) {
      html += '<div class="at-tl-ah at-tl-ah--lib"><span class="at-tl-lib">' + Crew.icon("eye", 14) + 'Library</span><span class="faint">threads that only read: research, reviews, questions</span></div>';
    } else {
      var level = scaleHeat(area.heat);
      var editors = area.threads.filter(function (t) { return !onlyReads(t.id); }).map(function (t) { return t.id; }).concat(area.visitors);
      html +=
        '<div class="at-tl-ah">' +
        '<span class="at-tl-path mono">' + drawPath(area.path) + "</span>" +
        '<i class="at-heat at-heat--lg proj--' + p.tint + '" title="Edits today"><b style="width:' + Math.round(level * 100) + '%"></b></i>' +
        drawDiff(area.heat, { both: true }) +
        (editors.length ? '<span class="at-tl-editors" title="Editing here today">' + editors.map(function (id) {
          return '<span class="at-tl-ed' + (area.visitors.indexOf(id) !== -1 ? " is-visitor" : "") + '" title="' + esc(getSession(id).title + (area.visitors.indexOf(id) !== -1 ? ", visiting from " + homeArea(id) : "")) + '">' + drawFace(id, 18) + "</span>";
        }).join("") + "</span>" : "") +
        '<span class="spacer"></span>' +
        area.crossings.map(function (c) {
          return '<button class="at-xchip at-xchip--' + c.kind + (focusKey === keyOfCrossing(c) ? " is-on" : "") + '" data-act="focus-crossing" data-key="' + esc(keyOfCrossing(c)) + '">' + drawCrossGlyph(c, 13) + "<span>2 sessions · </span><span class=\"mono\">" + esc(baseName(c.path)) + "</span></button>";
        }).join("") +
        "</div>";
    }
    area.threads.forEach(function (t) {
      html += drawTRow(t, area);
    });
    return html + "</div>";
  }
  function drawPath(path) {
    var i = path.lastIndexOf("/");
    return i < 0 ? "<b>" + esc(path) + "</b>" : '<span class="faint">' + esc(path.slice(0, i + 1)) + "</span><b>" + esc(path.slice(i + 1)) + "</b>";
  }

  /** Returns a thread at full width: face, title and status, the file it is in, and every file it touched as chips. */
  function drawTRow(t, area) {
    var slot = api.decideSlot(t);
    var path = pickFile(t.id);
    var f = filesOf(t.id);
    var reader = onlyReads(t.id);
    var line2;
    if (path) {
      var busy = t.pose === "working" && f.now;
      line2 = (busy ? '<span class="at-now" title="The file it is in now">now</span>' : "") + '<span class="mono at-tl-file" title="' + esc(path) + '">' + esc(baseName(path)) + "</span>" + (reader ? '<span class="faint">reads ' + readsOf(t.id).length + " files</span>" : drawDiff(diffOf(t.id)) + '<span class="faint">' + diffOf(t.id).files + (diffOf(t.id).files === 1 ? " file" : " files") + "</span>");
    } else {
      line2 = '<span class="faint">' + esc(f.note || "No files touched") + "</span>";
    }
    var who = t.lead ? '<span class="at-tl-role">' + esc(t.role || "partner") + " of " + esc(getSession(t.lead).title) + "</span>" : "";
    return (
      '<div class="at-tl-row' + (t.id === selected ? " is-on" : "") + (t.pose === "working" ? " is-working" : "") + '" data-trow="' + t.id + '">' +
      drawFace(t.id, 30) +
      '<div class="at-tl-main">' +
      '<div class="at-tl-l1"><b>' + esc(t.title) + "</b>" + '<span class="at-tl-slot st-end--' + slot.kind + '">' + slot.text + "</span></div>" +
      '<div class="at-tl-l2">' + api.drawBrand(t, 12) + line2 + "</div>" +
      (who ? '<div class="at-tl-l3">' + who + "</div>" : "") +
      "</div>" +
      '<div class="at-tl-files">' + drawChips(t) + "</div>" +
      "</div>"
    );
  }

  /** Returns the files a thread touched, as chips: edits first (largest first), then reads, at most six. */
  function drawChips(t) {
    var edits = editsOf(t.id).slice().sort(function (a, b) { return b.plus + b.minus - (a.plus + a.minus); });
    var reads = readsOf(t.id);
    var all = edits.concat(reads);
    if (!all.length) return "";
    var max = 6;
    var shown = all.slice(0, all.length > max ? max - 1 : max);
    var xs = crossingsOf(t.id);
    return (
      shown.map(function (f) {
        var x = xs.filter(function (c) { return c.path === f.path; })[0];
        var tip = f.path + (f.how === "read" ? " · read" : " · +" + f.plus + " −" + f.minus) + (x ? " · also edited by " + getSession(otherOf(x, t.id)).title + (x.kind === "conflict" ? ", would conflict" : "") : "");
        return (
          '<span class="at-chip at-chip--' + f.how + (x ? " at-chip--x at-chip--" + x.kind : "") + (f.path === filesOf(t.id).now ? " is-now" : "") + '" ' + hueStyle(t.id) + ' title="' + esc(tip) + '"' + (x ? ' data-act="focus-crossing" data-key="' + esc(keyOfCrossing(x)) + '"' : "") + ">" +
          (x ? drawCrossGlyph(x, 11) : f.how === "read" ? Crew.icon("eye", 11) : "") +
          '<span class="mono">' + esc(baseName(f.path)) + "</span>" +
          (f.how === "edit" && (f.plus || f.minus) ? drawDiff(f) : "") +
          "</span>"
        );
      }).join("") +
      (all.length > shown.length ? '<span class="at-chip at-chip--more">' + (all.length - shown.length) + " more</span>" : "")
    );
  }

  /** Draws the crossings panel beside Threads: every Edit Overlap and predicted conflict, conflicts first. */
  function renderCrossingsPanel() {
    var el = ov.querySelector("[data-xlist]");
    var xs = listCrossings().filter(function (c) { return matchesFilter(projectOf(c.a), folderOf(c.path)); }).sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === "conflict" ? -1 : 1;
      return 0;
    });
    var c = countAll();
    el.innerHTML =
      '<h2 class="at-side-h">Crossings <b class="count">' + xs.length + '</b><span class="faint">' + xs.filter(function (x) { return x.kind === "conflict"; }).length + " would conflict" + (filter ? " · in " + esc(filter.path) : "") + "</span></h2>" +
      '<p class="at-side-lede">Two sessions that edit one file. A dry-run merge on the runner says whether their branches would conflict.</p>' +
      xs.map(drawCrossingCard).join("");
  }

  /**
   * Returns a crossing's card. A predicted conflict, and the crossing in focus, show everything; an
   * overlap is advisory, so it folds to one line until it is clicked. That keeps the panel short
   * enough to end above the docked selection card on a 900px window.
   */
  function drawCrossingCard(c) {
    var on = focusKey === keyOfCrossing(c);
    if (c.kind === "overlap" && !on) {
      return (
        '<button class="at-xc at-xc--overlap at-xc--fold" data-act="focus-crossing" data-key="' + esc(keyOfCrossing(c)) + '" title="Show what the two threads share">' +
        '<span class="at-xc-h">' + drawCrossGlyph(c, 14) + '<b class="at-xc-kind">Both edit</b>' + (AWAY && isNewSinceLeft(c) ? '<span class="at-new">new</span>' : "") + '<span class="spacer"></span><span class="mono at-xc-path">' + esc(c.path) + "</span></span>" +
        '<span class="at-xc-line"><span class="at-xc-faces">' + drawFace(c.a, 18) + drawFace(c.b, 18) + '</span><span class="at-xc-names">' + esc(getSession(c.a).title) + " and " + esc(getSession(c.b).title) + "</span></span>" +
        "</button>"
      );
    }
    function side(id) {
      var s = getSession(id);
      var ws = s.workspace && W.workspaces[s.workspace];
      var sub = isRun(id) ? "run · " + s.run.workflow : ws && ws.kind === "worktree" ? ws.branch : ws && ws.kind === "main" ? ws.repo + " main workspace" : "";
      return '<button class="at-xc-who" data-act="select" data-id="' + id + '">' + drawFace(id, 22) + '<span><b>' + esc(s.title) + "</b><small class=\"" + (ws && ws.kind === "worktree" ? "mono" : "") + '">' + esc(sub) + "</small></span></button>";
    }
    return (
      '<article class="at-xc at-xc--' + c.kind + (on ? " is-on" : "") + '" data-xkey="' + esc(keyOfCrossing(c)) + '">' +
      '<header class="at-xc-h">' + drawCrossGlyph(c, 14) + '<b class="at-xc-kind">' + (c.kind === "conflict" ? "Would conflict" : "Both edit") + "</b>" + (AWAY && isNewSinceLeft(c) ? '<span class="at-new">new</span>' : "") + '<span class="spacer"></span><span class="mono at-xc-path" title="' + esc(c.path) + '">' + esc(c.path) + "</span></header>" +
      '<div class="at-xc-pair">' + side(c.a) + side(c.b) + "</div>" +
      '<p class="at-xc-note">' + esc(c.note) + "</p>" +
      '<footer class="at-xc-f"><button class="btn btn--sm" data-act="discuss" data-key="' + esc(keyOfCrossing(c)) + '">' + Crew.icon("discussions", 13) + 'Open a Discussion</button><button class="btn btn--quiet btn--sm" data-act="tell" data-key="' + esc(keyOfCrossing(c)) + '">Tell both</button>' +
      (lineOf(c.a) && lineOf(c.b) ? '<span class="spacer"></span><button class="btn btn--quiet btn--sm" data-act="see-lines" data-key="' + esc(keyOfCrossing(c)) + '">In Lines' + Crew.icon("chev-r", 12) + "</button>" : "") +
      "</footer>" +
      "</article>"
    );
  }

  /* ------------------------------------------------------------------ Lines: the transit map */

  var LINES = null; // the last built systems, for hit tests and the board

  /** Returns the line a session rides on: its lead's branch, or its run's line. */
  function lineOf(id) {
    if (!LINES) LINES = buildLines();
    var key = null;
    LINES.forEach(function (sys) {
      sys.lines.forEach(function (l) {
        if (l.lead === id || l.partners.indexOf(id) !== -1) key = l;
      });
    });
    return key;
  }

  /**
   * Returns the systems of the map: one per repository, each with its lines in landing order and a
   * run line beside the branch it crosses. A line is { key, kind, lead, project, badge, built,
   * train, ahead, order, partners, landed, behind }.
   */
  function buildLines() {
    var order = SWARM ? W.landingOrderSwarm : W.landingOrder;
    var lines = [];
    order.forEach(function (o, i) {
      var b = W.branches[o.workspace];
      var lead = api.getThread(b.lead);
      if (!lead) return;
      var route = A.routes[o.workspace];
      var fail = A.failing[o.workspace] || [];
      var built = b.stations.map(function (s, j) {
        return { label: route.names[j] || s.label, full: s.label, at: s.at, kind: s.kind, fail: fail.indexOf(j) !== -1 };
      });
      var train = route.train ? JSON.parse(JSON.stringify(route.train)) : {};
      var ahead = route.ahead.map(function (a) { return typeof a === "string" ? { label: a } : { label: a.label, waiting: a.waiting }; });
      // An answered Request moves the train on: the station it waited at is reached.
      if (train.waiting && answered[b.lead] && answered[b.lead].allowed) {
        built.push({ label: train.at === "Push" ? "Pushed" : train.at, full: train.at, at: W.now, kind: "commit" });
        train = {};
      }
      ahead.forEach(function (a) {
        if (a.waiting && !isWaiting(a.waiting)) a.waiting = null;
      });
      var isLanded = landed && o.workspace === A.land.workspace;
      lines.push({
        key: o.workspace, kind: "branch", lead: b.lead, project: lead.project, badge: b.branch, built: built, train: train, ahead: ahead,
        order: i + 1, reason: o.reason, ready: b.ready, landed: isLanded, behind: b.behind + (landed && !isLanded && lead.project === "webshop" ? 1 : 0), aheadBy: b.ahead,
        partners: listLive().filter(function (t) { return t.lead === b.lead; }).sort(function (x, y) { return minutes(x.started) - minutes(y.started); }).map(function (t) { return t.id; }),
      });
    });
    A.runLines.forEach(function (rl) {
      var run = findRun(rl.run);
      var route = A.routes[rl.run];
      var done = run.steps.filter(function (s) { return s.state === "completed"; });
      lines.push({
        key: rl.run, kind: "run", lead: rl.session, project: rl.project, badge: run.title, run: run,
        built: done.map(function (s, j) { return { label: route.names[j] || s.label, full: s.label, kind: "step" }; }),
        train: {}, ahead: route.ahead.map(function (a) { return { label: a }; }), order: null, partners: [], landed: false, behind: 0,
      });
    });
    var crossings = listCrossings();
    return W.projects.map(function (p) {
      var mine = lines.filter(function (l) { return l.project === p.id; });
      var branches = mine.filter(function (l) { return l.kind === "branch"; }).sort(function (a, b) { return a.order - b.order; });
      mine.filter(function (l) { return l.kind === "run"; }).forEach(function (run) {
        // A run line rides beside the branch it crosses, so its interchange is short.
        var partner = null;
        crossings.forEach(function (c) {
          if (c.a === run.lead || c.b === run.lead) partner = otherOf(c, run.lead);
        });
        var at = branches.length;
        branches.forEach(function (l, i) {
          if (l.lead === partner) at = i + 1;
        });
        branches.splice(at, 0, run);
      });
      return { project: p, lines: branches };
    }).filter(function (s) { return s.lines.length; });
  }

  /** Returns the crossings the map draws: both sessions ride a line. */
  function listMapCrossings() {
    return listCrossings().filter(function (c) { return lineOf(c.a) && lineOf(c.b) && lineOf(c.a) !== lineOf(c.b); });
  }

  // Text widths, estimated: the map is drawn before the fonts settle, and an estimate keeps it stable.
  function textW(s, size, mono) {
    return String(s).length * size * (mono ? 0.6 : 0.54);
  }

  /** Works out every coordinate of the map for a container of this size. */
  function layoutLines(systems, cw, ch) {
    var lanes = sum(systems, function (s) { return s.lines.length; });
    var compact = lanes > 11;
    var top = 64;
    var bottom = 44;
    var headH = compact ? 24 : 30;
    var gapY = compact ? 12 : 18;
    var pitch = Math.max(34, Math.min(80, (ch - top - bottom - systems.length * headH - (systems.length - 1) * gapY) / lanes));
    // A tall terminal keeps the fan into it short, which leaves the width to the stations.
    var track = compact ? 10 : Math.round(pitch * 0.5);
    var MX = cw - 40;
    var dyMax = 0;
    systems.forEach(function (s) {
      dyMax = Math.max(dyMax, ((s.lines.length - 1) / 2) * (pitch - track));
    });
    var bend = 40;
    var G = MX - (bend + dyMax + 14);
    var S = 86;
    systems.forEach(function (s) {
      s.lines.forEach(function (l) {
        var cols = l.built.length + l.ahead.length + 0.55;
        l.badgeW = textW(l.badge, 11, l.kind === "branch") + (l.kind === "run" ? 34 : 16);
        S = Math.min(S, (G - 22 - l.badgeW - 10) / cols);
      });
    });
    S = Math.max(44, S);
    var y = top;
    systems.forEach(function (s) {
      s.top = y;
      y += headH;
      var mid = y + (pitch * s.lines.length) / 2;
      s.mid = mid;
      s.lines.forEach(function (l, i) {
        l.y = y + pitch * (i + 0.5);
        l.trackY = mid + (i - (s.lines.length - 1) / 2) * track;
      });
      y += pitch * s.lines.length;
      s.bottom = y;
      y += gapY;
    });
    systems.forEach(function (s) {
      s.lines.forEach(function (l) {
        var a = l.ahead.length;
        var b = l.built.length;
        l.trainX = l.landed ? G : G - a * S;
        l.x0 = G - (a + b + 0.55) * S;
        l.built.forEach(function (st, j) { st.x = G - (a + b - j) * S; });
        l.ahead.forEach(function (st, k) { st.x = G - (a - 1 - k) * S; });
      });
    });
    return { compact: compact, pitch: pitch, track: track, MX: MX, G: G, S: S, bend: bend, cw: cw, ch: ch };
  }

  /** Places every crossing: just ahead of the later of its two trains, where the collision lies, one column apart when two would meet. */
  function placeCrossings(xs, systems, L) {
    var used = {};
    xs.forEach(function (c) {
      var la = lineOf(c.a);
      var lb = lineOf(c.b);
      var x = Math.max(la.trainX, lb.trainX) + L.S * 0.5;
      x = Math.min(x, L.G - L.S * 0.5);
      var floor = Math.max(la.x0, lb.x0) + L.S * 0.45;
      var step = -L.S;
      while (used[la.key + Math.round(x)] || used[lb.key + Math.round(x)]) {
        x += step;
        // Out of track on the left: look to the right of the trains instead.
        if (x < floor) {
          step = L.S;
          x = Math.max(la.trainX, lb.trainX) + L.S * 0.5;
        }
        if (x > L.G) break;
      }
      used[la.key + Math.round(x)] = used[lb.key + Math.round(x)] = true;
      var upper = la.y < lb.y ? la : lb;
      var lower = upper === la ? lb : la;
      c._x = x;
      c._upper = upper;
      c._lower = lower;
      c._y = upper.y + L.pitch / 2 + (L.compact ? 0 : 2);
      var iv = [x - 10, x + 10];
      upper.blocks.below.push(iv);
      lower.blocks.above.push(iv);
      systems.forEach(function (s) {
        s.lines.forEach(function (l) {
          if (l.project === upper.project && l.y > upper.y && l.y < lower.y) {
            l.blocks.above.push(iv);
            l.blocks.below.push(iv);
          }
        });
      });
    });
  }

  /**
   * Places station labels: above the line where they fit, else below, else shortened where there
   * is room, else left to the station's card. The train's word, its carriages, the line's badge and
   * every interchange connector are kept clear.
   */
  function placeLabels(l, L) {
    var word = trainWord(l);
    // Calm by default: the map always says what needs you and what is ready (in a dense map, only
    // what needs you); what a working train is doing shows for the selected line only.
    var mine = l.lead === selected || l.partners.indexOf(selected) !== -1;
    if (word && !mine && word.cls !== "you" && (word.cls !== "ok" || L.compact)) word = null;
    var rr = L.compact ? 11 : 13.5;
    l.blocks.above.push([l.trainX - rr + 2, l.trainX + rr - 2]);
    l.blocks.below.push([l.x0 - 10 - l.badgeW, l.x0 - 6]);
    function hits(list, a, b) {
      return list.filter(function (iv) { return a < iv[1] + 6 && b > iv[0] - 6; });
    }
    if (word) {
      // The word sits under its train, slid aside when an interchange connector passes there.
      // It hangs from the train toward main, where the track still to come has room; near main it ends at the train.
      var ww = textW(word.text, 11) + (word.cls === "you" ? 10 : 0);
      var wx = l.trainX - rr + 1;
      if (wx + ww > L.G + 18) wx = Math.min(l.trainX + rr, L.G + 20) - ww;
      var hit = hits(l.blocks.below, wx, wx + ww)[0];
      if (hit) wx = hit[0] > l.trainX ? hit[0] - 8 - ww : hit[1] + 8;
      word.x = wx + ww / 2 - (word.cls === "you" ? 5 : 0);
      word.left = wx;
      l.word = word;
      l.blocks.below.push([wx, wx + ww]);
    }
    var placed = { above: l.blocks.above.slice(), below: l.blocks.below.slice() };
    function room(band, x) {
      var left = -Infinity;
      var right = Infinity;
      placed[band].forEach(function (iv) {
        if (iv[1] <= x) left = Math.max(left, iv[1] + 6);
        else if (iv[0] >= x) right = Math.min(right, iv[0] - 6);
        else {
          left = x;
          right = x;
        }
      });
      return Math.max(0, Math.min(x - left, right - x, L.S - 4));
    }
    l.built.concat(l.ahead).forEach(function (st) {
      var w = textW(st.label, 11);
      st.text = st.label;
      // Centred first, then slid left or right so it still reaches its station; above before below.
      var reach = Math.max(0, w / 2 - 7);
      var shifts = [0, -reach / 2, reach / 2, -reach, reach];
      var done = false;
      ["above", "below"].forEach(function (band) {
        shifts.forEach(function (dx) {
          if (done) return;
          var a = st.x - w / 2 + dx;
          var b = st.x + w / 2 + dx;
          if (!hits(placed[band], a, b).length) {
            st.pos = band;
            st.lx = st.x + dx;
            placed[band].push([a, b]);
            done = true;
          }
        });
      });
      if (done) return;
      var ra = room("above", st.x);
      var rb = room("below", st.x);
      var band = ra >= rb ? "above" : "below";
      var half = Math.max(ra, rb);
      var chars = Math.floor((half * 2) / 5.94) - 1;
      if (chars < 4) {
        st.pos = null;
        return;
      }
      st.pos = band;
      st.lx = st.x;
      st.text = st.label.slice(0, chars) + "…";
      var tw = textW(st.text, 11);
      placed[band].push([st.x - tw / 2, st.x + tw / 2]);
    });
  }

  /** Returns a line's path from its origin to main: straight, then a 45° bend with rounded corners into its track at the terminus. */
  function pathOfLine(l, L, fromX, toX) {
    var r = 10;
    var bendX = L.G + L.bend;
    var dy = l.trackY - l.y;
    var adx = Math.abs(dy);
    var d = "M" + fromX.toFixed(1) + " " + l.y.toFixed(1);
    if (toX <= bendX || Math.abs(dy) < 0.5) {
      return d + " H" + Math.min(toX, Math.abs(dy) < 0.5 ? toX : bendX).toFixed(1);
    }
    var sg = dy > 0 ? 1 : -1;
    var k = r * 0.4142; // tan(22.5°): how far a 45° corner of radius r reaches along each leg
    d += " H" + (bendX - k).toFixed(1);
    d += " Q" + bendX.toFixed(1) + " " + l.y.toFixed(1) + " " + (bendX + k * 0.7071).toFixed(1) + " " + (l.y + sg * k * 0.7071).toFixed(1);
    d += " L" + (bendX + adx - k * 0.7071).toFixed(1) + " " + (l.trackY - sg * k * 0.7071).toFixed(1);
    d += " Q" + (bendX + adx).toFixed(1) + " " + l.trackY.toFixed(1) + " " + (bendX + adx + k).toFixed(1) + " " + l.trackY.toFixed(1);
    d += " H" + toX.toFixed(1);
    return d;
  }

  /** Returns the word under a line's train: its ask in marigold, what it does now, or a note. */
  function trainWord(l) {
    if (l.landed) return { text: "Landed " + A.land.at + " · #" + A.land.pr + " merged", cls: "ok" };
    var s = getSession(l.lead);
    if (!s) return null;
    if (s.pose === "waiting") return { text: s.askShort || s.ask, cls: "you" };
    var partnerAsk = l.partners.filter(isWaiting)[0];
    if (partnerAsk) {
      var p = getSession(partnerAsk);
      return { text: p.askShort || p.ask, cls: "you" };
    }
    if (l.train && l.train.note) return { text: l.train.note, cls: l.ready ? "ok" : "" };
    if (W.activity[l.lead]) return { text: W.activity[l.lead], cls: "" };
    return { text: H.ago(s.last) === "now" ? "idle" : "idle " + H.ago(s.last), cls: "faint" };
  }

  function renderLines() {
    var host = ov.querySelector("[data-map]");
    var cw = host.clientWidth || 800;
    var chh = host.clientHeight || 840;
    var systems = buildLines();
    LINES = systems;
    var L = layoutLines(systems, cw, chh);
    systems.forEach(function (s) {
      s.lines.forEach(function (l) { l.blocks = { above: [], below: [] }; });
    });
    var xs = listMapCrossings();
    placeCrossings(xs, systems, L);
    var focus = focusedCrossing();
    var cut = minutes(AWAY_LEFT);
    var svg = "";

    // The systems: a quiet band in each project's tint, its name, and its terminus.
    systems.forEach(function (s) {
      svg += '<g class="at-sys proj--' + s.project.tint + '">';
      svg += '<rect class="at-sys-band" x="10" y="' + (s.top + 2) + '" width="' + (L.cw - 14) + '" height="' + (s.bottom - s.top - 4) + '" rx="14"/>';
      var nb = s.lines.filter(function (l) { return l.kind === "branch"; }).length;
      var nr = s.lines.filter(function (l) { return l.kind === "run"; }).length;
      svg += '<text class="at-sys-name" x="26" y="' + (s.top + (L.compact ? 17 : 21)) + '">' + esc(s.project.name) + '<tspan class="at-sys-sub" dx="8">' + nb + (nb === 1 ? " branch" : " branches") + (nr ? " · " + nr + (nr === 1 ? " run" : " runs") : "") + "</tspan></text>";
      svg += "</g>";
    });

    // The lines, back to front.
    systems.forEach(function (s) {
      s.lines.forEach(function (l) {
        placeLabels(l, L);
        l.focus = !!focus && (lineOf(focus.a) === l || lineOf(focus.b) === l);
        var cls = "at-ln at-ln--" + l.kind + (l.lead === selected || l.partners.indexOf(selected) !== -1 ? " is-sel" : "") + (l.focus ? " is-focus" : "") + (l.landed ? " is-landed" : "") + (filter && !touchesFilter(l) ? " is-out" : "");
        svg += '<g class="' + cls + '" data-line="' + l.key + '" data-id="' + l.lead + '" ' + hueStyle(l.lead) + ">";
        var full = pathOfLine(l, L, l.x0, L.MX);
        svg += '<path class="at-ln-hit" d="' + full + '"/>';
        svg += '<path class="at-ln-halo" d="' + full + '"/>';
        // The track still to build, then the track built so far on top of it.
        svg += '<path class="at-ln-ahead" d="' + (l.landed ? "M0 0" : pathOfLine(l, L, l.trainX, L.MX)) + '"/>';
        var builtTo = l.landed ? L.MX : l.trainX;
        if (sinceLeft && !(l.kind === "run" && minutes(l.run.started) > cut)) {
          var firstNew = l.built.filter(function (st) { return st.at && minutes(st.at) > cut; })[0];
          var splitX = firstNew ? firstNew.x - L.S * 0.5 : builtTo;
          svg += '<path class="at-ln-built is-old" d="' + pathOfLine(l, L, l.x0, Math.min(splitX, builtTo)) + '"/>';
          if (splitX < builtTo) svg += '<path class="at-ln-built" d="' + pathOfLine(l, L, splitX, builtTo) + '"/>';
        } else {
          svg += '<path class="at-ln-built" d="' + pathOfLine(l, L, l.x0, builtTo) + '"/>';
        }
        if (l.kind === "run") svg += '<path class="at-ln-core" d="' + pathOfLine(l, L, l.x0, builtTo) + '"/>';
        // The origin: a terminus bar, and the line's badge.
        var bw = l.badgeW;
        svg += '<rect class="at-ln-cap" x="' + (l.x0 - 2.5) + '" y="' + (l.y - 9) + '" width="5" height="18" rx="2.5"/>';
        svg += '<g class="at-badge at-badge--' + l.kind + '" data-act="select" data-id="' + l.lead + '"><rect x="' + (l.x0 - 10 - bw) + '" y="' + (l.y - 10.5) + '" width="' + bw + '" height="21" rx="' + (l.kind === "run" ? 10.5 : 6) + '"/>';
        if (l.kind === "run") svg += '<text class="at-badge-k" x="' + (l.x0 - 10 - bw + 9) + '" y="' + (l.y + 3.8) + '">run</text>';
        svg += '<text class="' + (l.kind === "branch" ? "at-badge-t mono" : "at-badge-t") + '" x="' + (l.x0 - 10 - bw + (l.kind === "run" ? 29 : 8)) + '" y="' + (l.y + 3.8) + '">' + esc(l.kind === "run" ? l.badge : l.badge) + "</text></g>";
        if (l.behind && !L.compact) svg += '<text class="at-ln-behind" x="' + (l.x0 - 10 - bw) + '" y="' + (l.y + 24) + '">' + l.behind + " behind main</text>";
        // The stations.
        l.built.forEach(function (st, j) {
          var isNew = sinceLeft && (st.at ? minutes(st.at) > cut : l.kind === "run" && minutes(l.run.started) > cut);
          svg += drawStation(l, st, "built", j, L, isNew);
        });
        l.ahead.forEach(function (st, k) {
          svg += drawStation(l, st, "ahead", k, L, false);
        });
        // The landing order, as a roundel on the last straight before main.
        if (l.order) svg += '<g class="at-ord' + (L.compact ? " is-small" : "") + (l.landed ? " is-done" : "") + '"><circle cx="' + (L.G + 26) + '" cy="' + l.y + '" r="' + (L.compact ? 8 : 9) + '"/><text x="' + (L.G + 26) + '" y="' + (l.y + 3.8) + '">' + l.order + "</text></g>";
        svg += "</g>";
      });
    });

    // The crossings: an interchange ring on each line and a connector between them, with its file.
    var chips = [];
    var links = "";
    var labels = "";
    xs.forEach(function (c) {
      var x = c._x;
      var y1 = c._upper.y;
      var y2 = c._lower.y;
      var on = focus && keyOfCrossing(focus) === keyOfCrossing(c);
      var label = baseName(c.path) + (L.compact ? "" : " · " + describeKind(c));
      var isNewX = sinceLeft && isNewSinceLeft(c);
      var lw = textW(label, 11) + 30 + (isNewX ? 34 : 0);
      var my = c._y;
      var lx = Math.min(x - lw / 2, L.G + 24 - lw);
      // A chip never sits on a line's badge: it moves to the right of its connector instead.
      systems.forEach(function (s) {
        s.lines.forEach(function (l) {
          var bl = l.x0 - 10 - l.badgeW;
          if (Math.abs(l.y - my) < 22 && lx < l.x0 + 4 && lx + lw > bl) lx = Math.max(lx, l.x0 + 8, x + 12);
        });
      });
      // Nor on another chip in the same gap: it moves along until it is clear, right first, then left.
      function clash(at) {
        return chips.filter(function (r) { return Math.abs(r.y - my) < 20 && at < r.x + r.w + 4 && at + lw > r.x - 4; })[0];
      }
      if (clash(lx)) {
        var ideal = lx;
        var spots = [];
        chips.forEach(function (r) {
          spots.push(r.x + r.w + 6, r.x - 6 - lw);
        });
        spots = spots.filter(function (at) { return at + lw <= L.G + 30 && at >= 16 && !clash(at); });
        spots.sort(function (a, b) { return Math.abs(a - ideal) - Math.abs(b - ideal); });
        if (spots.length) lx = spots[0];
      }
      chips.push({ x: lx, y: my, w: lw });
      var gcls = 'class="at-xg at-xg--' + c.kind + (on ? " is-on" : "") + (AWAY && sinceLeft && isNewSinceLeft(c) ? " is-new" : "") + '" data-act="focus-crossing" data-key="' + esc(keyOfCrossing(c)) + '"';
      links +=
        "<g " + gcls + ">" +
        '<rect class="at-xg-link" x="' + (x - 7) + '" y="' + (y1 - 7) + '" width="14" height="' + (y2 - y1 + 14) + '" rx="7"/>' +
        '<circle class="at-xg-ring" cx="' + x + '" cy="' + y1 + '" r="7"/><circle class="at-xg-ring" cx="' + x + '" cy="' + y2 + '" r="7"/>' +
        "</g>";
      // Chips are drawn after every connector, so no connector ever crosses a file's name.
      labels +=
        "<g " + gcls + '><g class="at-xg-chip"><rect x="' + lx + '" y="' + (my - 10.5) + '" width="' + lw + '" height="21" rx="10.5"/>' +
        '<g transform="translate(' + (lx + 7) + " " + (my - 7) + ')">' + drawCrossGlyph(c, 14).replace("<svg", "<svg x=\"0\" y=\"0\"") + "</g>" +
        '<text x="' + (lx + 25) + '" y="' + (my + 3.8) + '"><tspan class="mono">' + esc(baseName(c.path)) + "</tspan>" + (L.compact ? "" : " · " + describeKind(c)) + "</text>" +
        (isNewX ? '<rect class="at-xg-new" x="' + (lx + lw - 36) + '" y="' + (my - 7.5) + '" width="30" height="15" rx="7.5"/><text class="at-xg-newt" x="' + (lx + lw - 21) + '" y="' + (my + 3.6) + '">new</text>' : "") +
        "</g></g>";
    });
    svg += links + labels;

    // The trains: each lead's face where it stands, its partners behind it, and its word under it.
    systems.forEach(function (s) {
      s.lines.forEach(function (l) {
        svg += drawTrain(l, L);
      });
    });

    // The termini.
    systems.forEach(function (s) {
      var t1 = s.lines[0].trackY - 10;
      var t2 = s.lines[s.lines.length - 1].trackY + 10;
      svg += '<g class="at-term"><rect x="' + (L.MX - 9) + '" y="' + t1 + '" width="18" height="' + (t2 - t1) + '" rx="9"/>' +
        '<text class="at-term-name" x="' + L.MX + '" y="' + (t1 - 8) + '">main</text></g>';
    });

    var legend =
      '<div class="at-legend">' +
      '<span><i class="at-lg-built"></i>built</span>' +
      '<span><i class="at-lg-ahead"></i>to come</span>' +
      '<span><i class="at-lg-station"></i>station</span>' +
      '<span><i class="at-lg-x"></i>crossing</span>' +
      '<span><i class="at-lg-run"></i>run</span>' +
      '<span class="at-lg-off">Off the map: ' + describeOffMap() + "</span>" +
      "</div>";
    host.innerHTML = '<svg class="at-svg' + (L.compact ? " is-compact" : "") + (focus ? " has-focus" : "") + (sinceLeft ? " is-since" : "") + '" width="' + cw + '" height="' + chh + '" viewBox="0 0 ' + cw + " " + chh + '">' + svg + "</svg>" + legend + (focus ? drawCrossingCallout(focus, L) : "");
    renderBoard(systems);
  }

  function touchesFilter(l) {
    if (!filter) return true;
    var ids = [l.lead].concat(l.partners);
    return ids.some(function (id) {
      return projectOf(id) === filter.project && editsOf(id).concat(readsOf(id)).some(function (f) { return folderOf(f.path) === filter.path; });
    });
  }

  /** Returns the threads that ride no line: no branch of their own and no lead with one. */
  function describeOffMap() {
    var on = {};
    (LINES || []).forEach(function (s) {
      s.lines.forEach(function (l) {
        on[l.lead] = true;
        l.partners.forEach(function (p) { on[p] = true; });
      });
    });
    var off = listLive().filter(function (t) { return !on[t.id]; });
    if (!off.length) return "nothing";
    return off.length === 1 ? "1 thread with no branch of its own" : off.length + " threads with no branch of their own";
  }

  function drawStation(l, st, part, i, L, isNew) {
    var r = part === "ahead" ? 4.5 : st.kind === "commit" || st.kind === "step" ? 4.5 : 6;
    var cls = "at-st at-st--" + part + (st.fail ? " is-fail" : "") + (st.waiting ? " is-you" : "") + (isNew ? " is-new" : "");
    var labelY = st.pos === "below" ? l.y + (L.compact ? 19 : 24) : l.y - (L.compact ? 10 : 12);
    return (
      '<g class="' + cls + '" data-act="station" data-line="' + l.key + '" data-part="' + part + '" data-idx="' + i + '">' +
      '<circle class="at-st-hit" cx="' + st.x + '" cy="' + l.y + '" r="12"/>' +
      (isNew ? '<circle class="at-st-new" cx="' + st.x + '" cy="' + l.y + '" r="' + (r + 4.5) + '"/>' : "") +
      '<circle class="at-st-dot" cx="' + st.x + '" cy="' + l.y + '" r="' + r + '"/>' +
      (st.pos ? '<text class="at-st-label' + (st.pos === "below" ? " is-below" : "") + '" x="' + st.lx + '" y="' + labelY + '">' + esc(st.text) + "</text>" : "<title>" + esc(st.label) + "</title>") +
      "</g>"
    );
  }

  function drawTrain(l, L) {
    var s = getSession(l.lead);
    var x = l.trainX;
    var y = l.y;
    var size = L.compact ? 18 : 22;
    var rr = L.compact ? 11 : 13.5;
    var word = l.word;
    var pose = l.landed ? "done" : s.pose;
    if (l.landed) {
      x = L.MX + 22;
      y = l.trackY;
    }
    var html = '<g class="at-train' + (l.lead === selected ? " is-sel" : "") + (l.focus ? " is-focus-train" : "") + (l.landed ? " is-landed" : "") + (filter && !touchesFilter(l) ? " is-out" : "") + '" data-act="select" data-id="' + l.lead + '" data-line="' + l.key + '" ' + hueStyle(l.lead) + ">";
    // Partners ride behind the lead, as carriages.
    l.partners.slice().reverse().forEach(function (pid, i) {
      var px = x - rr - 8 - (l.partners.length - 1 - i) * 13;
      var p = getSession(pid);
      html += '<g class="at-car' + (pid === selected ? " is-sel" : "") + '" data-act="select" data-id="' + pid + '" ' + hueStyle(pid) + '><title>' + esc(p.title + (p.role ? " · " + p.role : "")) + '</title><circle cx="' + px + '" cy="' + y + '" r="' + (L.compact ? 8 : 9.5) + '"/>' + placeFace(p.title, p.pose, px - (L.compact ? 7 : 8), y - (L.compact ? 7.5 : 8.5), L.compact ? 14 : 16) + "</g>";
    });
    html += '<circle class="at-train-ring" cx="' + x + '" cy="' + y + '" r="' + rr + '"/>';
    html += "<title>" + esc(s.title) + "</title>" + placeFace(s.title, pose, x - size / 2, y - size / 2 - 0.5, size);
    if (word) {
      var wy = l.y + (L.compact ? 20 : 24);
      var tw = textW(word.text, 11);
      if (word.cls === "you") html += '<circle class="at-train-you" cx="' + (word.left + 3.5) + '" cy="' + (wy - 3.8) + '" r="3.5"/>';
      html += '<text class="at-train-word' + (word.cls ? " is-" + word.cls : "") + '" x="' + (word.left + (word.cls === "you" ? 11 : 0)) + '" y="' + wy + '">' + esc(word.text) + "</text>";
    }
    return html + "</g>";
  }
  /** Returns a face's SVG placed at x, y inside the map's own SVG. */
  function placeFace(title, pose, x, y, size) {
    return Crew.face(title, { pose: pose, size: size }).replace("<svg ", '<svg x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" ');
  }

  /** Returns the callout of the focused crossing: what the dry run found, and what to do. */
  function drawCrossingCallout(c, L) {
    var la = lineOf(c.a);
    var lb = lineOf(c.b);
    var first = la.order && lb.order ? (la.order < lb.order ? la : lb) : la;
    var then = first === la ? lb : la;
    // Below the lower of the two lines, so neither focused line is covered.
    var x = Math.max(16, Math.min(c._x - 150, L.cw - 334));
    var y = c._lower.y + 30;
    if (y > L.ch - 230) y = c._upper.y - 236;
    return (
      '<div class="at-callout glass" style="left:' + x + "px;top:" + y + 'px">' +
      '<div class="at-callout-h">' + drawCrossGlyph(c, 16) + "<b>" + (c.kind === "conflict" ? "Would conflict at merge" : "Both edit this file") + '</b><button class="icon-btn icon-btn--sm" data-act="unfocus" title="Close  esc">' + Crew.icon("close", 12) + "</button></div>" +
      '<div class="mono at-callout-path">' + esc(c.path) + "</div>" +
      '<p class="at-callout-note">' + esc(c.note) + "</p>" +
      (c.kind === "conflict" && first.order ? '<p class="at-callout-plan"><b>Suggested:</b> land <span class="mono">' + esc(first.badge) + "</span> first (" + first.order + " in the order), then rebase <span class=\"mono\">" + esc(then.badge) + "</span>.</p>" : "") +
      '<div class="at-callout-a"><button class="btn btn--sm" data-act="discuss" data-key="' + esc(keyOfCrossing(c)) + '">' + Crew.icon("discussions", 13) + 'Open a Discussion</button><button class="btn btn--quiet btn--sm" data-act="tell" data-key="' + esc(keyOfCrossing(c)) + '">Tell both</button></div>' +
      "</div>"
    );
  }

  /** Draws the landing order beside the map, as a station's board, with the one action that applies it. */
  function renderBoard(systems) {
    var el = ov.querySelector("[data-board]");
    var all = [];
    systems.forEach(function (s) {
      s.lines.forEach(function (l) {
        if (l.order) all.push(l);
      });
    });
    all.sort(function (a, b) { return a.order - b.order; });
    var focus = focusedCrossing();
    var focusLines = focus ? [lineOf(focus.a), lineOf(focus.b)] : [];
    var rows = all.map(function (l) {
      var s = getSession(l.lead);
      var st = describeBoardState(l);
      return (
        '<li class="at-bd-row' + (l.lead === selected ? " is-on" : "") + (focusLines.indexOf(l) !== -1 ? " is-focus" : "") + (l.landed ? " is-landed" : "") + '" data-act="select" data-id="' + l.lead + '" data-line="' + l.key + '" ' + hueStyle(l.lead) + ">" +
        '<span class="deco-num at-bd-n">' + l.order + "</span>" +
        '<div class="at-bd-main">' +
        '<div class="at-bd-l1"><span class="at-bd-badge mono">' + esc(l.badge) + '</span><span class="at-bd-state at-bd-state--' + st.kind + '">' + st.text + "</span></div>" +
        '<div class="at-bd-title">' + esc(s.title) + "</div>" +
        (l.lead !== selected && l.partners.indexOf(selected) === -1 ? "" : '<div class="at-bd-why">' + esc(l.landed ? "Merged " + A.land.at + ". " + l.reason : l.reason) + "</div>") +
        "</div></li>"
      );
    }).join("");
    var action = landed
      ? '<div class="at-bd-act is-on"><span class="at-bd-live">' + Crew.mark("working") + "Landing in this order</span><span class=\"spacer\"></span><button class=\"btn btn--quiet btn--sm\" data-act=\"unland\">Stop</button></div>" +
        '<p class="at-bd-note">Next: <span class="mono">fix/3ds-eu-cards</span> lands once you allow its push and its review is clean. Each branch behind it rebases first; the queue stops at the first conflict.</p>'
      : '<div class="at-bd-act"><button class="btn btn--accent" data-act="land">' + Crew.icon("check", 14) + 'Land in this order</button><button class="btn btn--quiet btn--sm" data-act="why">Why this order?</button></div>' +
        '<p class="at-bd-note">Merges each branch when it is ready and first in line, rebases the ones behind it, and stops at the first conflict. It asks before every push.</p>';
    el.innerHTML =
      '<div class="at-bd" data-board-body>' +
      '<div class="at-bd-h"><h2 class="at-bd-title-h">Landing order</h2><span class="at-bd-sub">A forecast from a dry-run merge of every branch · ' + W.now + "</span></div>" +
      '<ol class="at-bd-list' + (SWARM ? " is-compact" : "") + '">' + rows + "</ol>" +
      '<div class="at-bd-foot">' + action + "</div>" +
      "</div>";
  }

  function describeBoardState(l) {
    if (l.landed) return { kind: "ok", text: "Landed" };
    var s = getSession(l.lead);
    if (s.pose === "waiting") return { kind: "you", text: "Waits on you" };
    if (l.partners.some(isWaiting)) return { kind: "you", text: "Partner asks you" };
    if (l.ready) return { kind: "ok", text: landed ? "Next" : "Ready" };
    var xs = crossingsOf(l.lead).filter(function (c) { return c.kind === "conflict"; });
    if (xs.length && xs.some(function (c) { var o = lineOf(otherOf(c, l.lead)); return o && o.order && o.order < l.order; })) return { kind: "x", text: "Rebase first" };
    if (s.pose === "working") return { kind: "work", text: "Working" };
    return { kind: "idle", text: "Idle " + H.ago(s.last) };
  }

  /** Shows the small card of a station: what happened there, when, and on which line. */
  function showStation(lineKey, part, i, anchor) {
    var l = null;
    LINES.forEach(function (s) {
      s.lines.forEach(function (x) {
        if (x.key === lineKey) l = x;
      });
    });
    if (!l) return;
    var st = part === "built" ? l.built[i] : l.ahead[i];
    var kinds = { commit: "Commit", tests: "Tests", pr: "Pull request", review: "Review", ci: "CI", step: "Step", merged: "Merged" };
    var pop = ov.querySelector("[data-pop]");
    var who = getSession(l.lead);
    pop.innerHTML =
      '<div class="at-pop-h" ' + hueStyle(l.lead) + '><i class="at-pop-sw"></i><b>' + (part === "ahead" ? "To come" : kinds[st.kind] || "Station") + "</b>" + (st.at ? '<span class="faint">' + st.at + "</span>" : "") + "</div>" +
      '<div class="at-pop-t' + (st.fail ? " fail-ink" : "") + '">' + esc(st.full || st.label) + "</div>" +
      '<div class="at-pop-s"><span class="' + (l.kind === "branch" ? "mono" : "") + '">' + esc(l.badge) + "</span><span class=\"faint\">·</span>" + esc(who.title) + "</div>" +
      (st.waiting ? '<div class="at-pop-you">' + Crew.mark("waiting", 12) + esc(getSession(st.waiting).title) + " waits on you here</div>" : "");
    var r = anchor.getBoundingClientRect();
    var o = ov.getBoundingClientRect();
    pop.hidden = false;
    var left = Math.min(r.left - o.left - 20, o.width - 300);
    pop.style.left = Math.max(12, left) + "px";
    pop.style.top = r.bottom - o.top + 10 + "px";
  }
  function hidePop() {
    if (ov) ov.querySelector("[data-pop]").hidden = true;
  }

  /* ------------------------------------------------------------------ Office mode */

  function renderOffice() {
    var host = ov.querySelector("[data-office-host]");
    var mod = window.OfficeModes && window.OfficeModes.atlas;
    if (mod && !office && !officeTried) {
      officeTried = true;
      host.innerHTML = "";
      try {
        office = mod.mount(host, {
          world: W,
          theme: root.dataset.theme || "whitehaven",
          state: STATE,
          selected: userSelected ? selected : null,
          reducedMotion: reduced,
          onSelect: function (id) { setSelected(id, "office"); },
          onOpen: function (id) { openThread(id); },
        });
      } catch (e) {
        console.error(e);
        office = null;
      }
    }
    if (office) {
      if (office.resume) office.resume();
      if (office.resize) office.resize();
      return;
    }
    if (!host.querySelector(".at-city")) host.innerHTML = drawCityPlaceholder();
  }

  /** Returns the placeholder of the City until the Office module loads: the webshop repository as an isometric block of buildings. */
  function drawCityPlaceholder() {
    var repo = W.repos.webshop;
    var heat = {};
    listWorkers().forEach(function (id) {
      if (projectOf(id) !== "webshop") return;
      editsOf(id).forEach(function (f) { heat[f.path] = (heat[f.path] || 0) + f.plus + f.minus; });
    });
    var cos = Math.cos(Math.PI / 6);
    var sin = Math.sin(Math.PI / 6);
    var k = 4.2;
    var ox = 520;
    var oy = 150;
    function P(x, y, z) {
      return [ox + (x - y) * cos * k, oy + (x + y) * sin * k - z * k];
    }
    function poly(pts, cls, extra) {
      return '<polygon class="' + cls + '" points="' + pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ") + '"' + (extra || "") + "/>";
    }
    var boxes = [];
    var grounds = "";
    repo.folders.forEach(function (f, fi) {
      var dx = (fi % 3) * 46;
      var dy = Math.floor(fi / 3) * 46;
      grounds += poly([P(dx - 2, dy - 2, 0), P(dx + 40, dy - 2, 0), P(dx + 40, dy + 40, 0), P(dx - 2, dy + 40, 0)], "at-city-plot");
      f.files.filter(function (x) { return !x.newIn; }).forEach(function (file, i) {
        var gx = dx + (i % 4) * 10;
        var gy = dy + Math.floor(i / 4) * 13;
        boxes.push({ x: gx, y: gy, w: 7, d: 9, h: 3 + Math.sqrt(file.lines) * 0.9, lit: heat[f.path + "/" + file.name] || 0, path: f.path + "/" + file.name });
      });
    });
    boxes.sort(function (a, b) { return a.x + a.y - (b.x + b.y); });
    var g = "";
    boxes.forEach(function (b) {
      var top = [P(b.x, b.y, b.h), P(b.x + b.w, b.y, b.h), P(b.x + b.w, b.y + b.d, b.h), P(b.x, b.y + b.d, b.h)];
      var left = [P(b.x, b.y + b.d, 0), P(b.x + b.w, b.y + b.d, 0), P(b.x + b.w, b.y + b.d, b.h), P(b.x, b.y + b.d, b.h)];
      var right = [P(b.x + b.w, b.y, 0), P(b.x + b.w, b.y + b.d, 0), P(b.x + b.w, b.y + b.d, b.h), P(b.x + b.w, b.y, b.h)];
      var xing = b.path === "src/checkout/payment.ts";
      g += '<g class="at-city-b' + (b.lit ? " is-lit" : "") + (xing ? " is-x" : "") + '"><title>' + esc(b.path) + "</title>" + poly(left, "at-city-l") + poly(right, "at-city-r") + poly(top, "at-city-t") + "</g>";
    });
    var cx = P(5, 5, 26);
    return (
      '<div class="at-city">' +
      '<svg class="at-city-svg" viewBox="0 0 1040 640" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + grounds + g + "</svg>" +
      '<div class="at-city-card glass"><span class="at-city-k">The Office</span><h2 class="wordmark">The City</h2>' +
      "<p>Each repository is a city. Folders are districts, files are buildings, today's edits light the windows, and every bean walks to the file it is editing. A ring marks a building two beans share.</p>" +
      '<p class="faint">The 3D City loads here. Until it does, this is the webshop repository from above: ' + boxes.length + " buildings, " + Object.keys(heat).length + " lit today.</p></div>" +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ the selection card */

  function renderCard() {
    var card = ov.querySelector("[data-card]");
    if (!selected) {
      card.hidden = true;
      ov.style.setProperty("--card-h", "0px");
      return;
    }
    var html;
    if (selected === "rShip") {
      html = drawRunCard();
    } else {
      var s = getSession(selected);
      if (!s) {
        card.hidden = true;
        return;
      }
      html = drawSessionCard(s);
    }
    card.innerHTML = html;
    card.hidden = false;
    placeCard();
    ov.style.setProperty("--card-h", card.offsetHeight + "px");
  }

  function drawSessionCard(s) {
    var id = s.id;
    var run = s.kind === "run";
    var p = W.projects.filter(function (x) { return x.id === s.project; })[0];
    var area = homeArea(id);
    var waiting = isWaiting(id);
    var w = listWaiting().all;
    var path = pickFile(id);
    var d = diffOf(id);
    var xs = crossingsOf(id);
    var line = lineOf(id);
    var status = waiting ? '<span class="at-card-st you-ink">' + Crew.mark("waiting", 12) + "Waiting " + H.ago(s.last) + "</span>" : s.pose === "working" ? '<span class="at-card-st at-card-work">' + Crew.mark("working", 12) + (W.activity[id] ? esc(W.activity[id][0].toUpperCase() + W.activity[id].slice(1)) : "Working") + "</span>" : '<span class="at-card-st faint">' + Crew.mark("idle", 12) + "Idle " + H.ago(s.last) + "</span>";
    var html =
      '<div class="at-card-h">' + drawFace(id, 36, waiting ? "waiting" : s.pose) +
      '<div class="at-card-ht"><b class="at-card-title">' + esc(s.title) + "</b>" +
      '<span class="at-card-where">' + (p ? '<span class="proj proj--' + p.tint + '">' + esc(p.name) + "</span>" : '<span class="faint">No project</span>') + (area ? '<span class="faint">›</span><span class="mono at-card-area">' + esc(onlyReads(id) ? "Library" : area) + "</span>" : "") + "</span></div>" +
      '<button class="icon-btn icon-btn--sm at-card-x" data-act="deselect" title="Clear the selection">' + Crew.icon("close", 12) + "</button>" +
      "</div>";
    var facts = [];
    facts.push(status);
    if (run) facts.push('<span class="faint">Run · ' + esc(s.run.workflow) + " · step " + (s.run.steps.map(function (x) { return x.sessionId; }).indexOf(id) + 1) + " of " + s.run.steps.length + "</span>");
    if (path) facts.push('<span class="mono at-card-file" title="' + esc(path) + '">' + esc(onlyReads(id) ? "reads " + baseName(path) : baseName(path)) + "</span>" + (onlyReads(id) ? "" : drawDiff(d) + '<span class="faint">' + d.files + (d.files === 1 ? " file" : " files") + "</span>"));
    if (line && line.kind === "branch") facts.push('<span class="at-card-line" ' + hueStyle(line.lead) + '><i></i><span class="mono">' + esc(line.badge) + "</span>" + (line.order ? '<span class="faint">lands ' + ordinal(line.order) + "</span>" : "") + "</span>");
    html += '<div class="at-card-facts">' + facts.join("") + "</div>";
    xs.slice(0, 2).forEach(function (c) {
      html += '<button class="at-card-xing at-card-xing--' + c.kind + '" data-act="focus-crossing" data-key="' + esc(keyOfCrossing(c)) + '">' + drawCrossGlyph(c, 13) + "<span>Crosses <b>" + esc(getSession(otherOf(c, id)).title) + '</b> at <span class="mono">' + esc(baseName(c.path)) + "</span>" + (c.kind === "conflict" ? " · would conflict" : "") + "</span></button>";
    });
    if (waiting) html += '<div class="at-card-ask">' + drawAsk(s) + "</div>";
    html += '<div class="at-card-a">' + (waiting ? drawAnswers(id) : "") + '<span class="spacer"></span><button class="btn btn--sm" data-act="open" data-id="' + id + '">' + (run ? "Open run" : "Open thread") + Crew.icon("chev-r", 13) + "</button></div>";
    return html;
  }
  function drawRunCard() {
    var r = W.waitingRuns[0];
    var w = listWaiting().all;
    return (
      '<div class="at-card-h">' + Crew.face("Ship release", { pose: "waiting", size: 36 }) +
      '<div class="at-card-ht"><b class="at-card-title">Ship release v2.15</b><span class="at-card-where"><span class="proj proj--payments">payments-api</span><span class="faint">Run · publish</span><span class="you-ink">waiting ' + H.ago(r.last) + "</span></span></div>" +
      '<button class="icon-btn icon-btn--sm at-card-x" data-act="deselect" title="Clear the selection">' + Crew.icon("close", 12) + "</button></div>" +
      '<div class="at-card-facts"><span class="faint">Releases from main; it rides no branch, so it is off the map.</span></div>' +
      '<div class="at-card-ask">' + esc(W.runSessions.rShip.ask) + "</div>" +
      '<div class="at-card-a">' + drawAnswers("rShip") + '<span class="spacer"></span><button class="btn btn--sm" data-act="open" data-id="rShip">Open run' + Crew.icon("chev-r", 13) + "</button></div>"
    );
  }
  function ordinal(n) {
    return n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");
  }

  /**
   * Puts the card where the mode wants it: floating bottom-left over the Office, docked at the foot
   * of the right-hand column in Threads and Lines. A move between the two glides (a FLIP), so the
   * card is never lost between modes.
   */
  function placeCard(animate) {
    var card = ov.querySelector("[data-card]");
    if (card.hidden) return;
    var before = animate ? card.getBoundingClientRect() : null;
    card.dataset.dock = mode === "office" ? "float" : "side";
    if (before && !reduced) {
      var after = card.getBoundingClientRect();
      var dx = before.left - after.left;
      var dy = before.top - after.top;
      if (dx || dy) {
        card.style.transition = "none";
        card.style.transform = "translate(" + dx + "px," + dy + "px)";
        card.getBoundingClientRect();
        card.style.transition = "transform var(--dur-3) var(--ease-out)";
        card.style.transform = "";
      }
    }
  }

  /* ------------------------------------------------------------------ acting */

  function setMode(m) {
    if (MODES.indexOf(m) === -1 || m === mode) return;
    var prev = mode;
    mode = m;
    hidePop();
    if (prev === "office" && office && office.pause) office.pause();
    var url = new URL(location.href);
    url.searchParams.set("mode", m);
    history.replaceState(null, "", url);
    renderTop();
    ov.dataset.mode = m;
    renderPane();
    placeCard(true);
  }

  function renderPane() {
    if (mode === "threads") renderThreads();
    if (mode === "lines") renderLines();
    if (mode === "office") renderOffice();
  }

  /** Selects a thread in every mode at once: the sidebar's row, the overview's row or line, the card, and the Office's camera. */
  function setSelected(id, from) {
    selected = id;
    userSelected = id !== null;
    hidePop();
    renderSidebar();
    if (!overviewOpen || !ov) return;
    if (mode === "threads") {
      ov.querySelectorAll("[data-trow]").forEach(function (el) { el.classList.toggle("is-on", el.dataset.trow === id); });
    } else if (mode === "lines") {
      renderLines();
    }
    renderCard();
    if (office && from !== "office" && office.select) office.select(id);
    var mm = api.els.side.querySelector(".at-mm");
    if (mm) renderMinimap();
  }

  function openOverview(m) {
    overviewOpen = true;
    if (m) mode = m;
    api.drawMain();
    renderSidebar();
    markOfficeButton();
  }
  function closeOverview() {
    if (office && office.pause) office.pause();
    overviewOpen = false;
    api.open(selected && api.getThread(selected) ? selected : api.openId());
    renderSidebar();
    markOfficeButton();
  }
  function openThread(id) {
    if (!api.getThread(id)) {
      api.showToast("Runs open in Runs; this drawing shows threads only.");
      return;
    }
    if (office && office.pause) office.pause();
    overviewOpen = false;
    selected = id;
    api.open(id);
    renderSidebar();
    markOfficeButton();
  }
  function markOfficeButton() {
    var b = api.els.side.querySelector("[data-office-btn]");
    if (b) b.classList.toggle("is-on", overviewOpen);
  }

  /** Answers a Request: the session leaves Waiting on you, a toast offers Undo. */
  function answer(id, i) {
    var a = (A.answers[id] || [])[i];
    if (!a) return;
    if (id === "rShip") {
      answered.rShip = { allowed: !a.quiet };
    } else {
      var t = getSession(id);
      answered[id] = { pose: t.pose, status: t.status, ask: t.ask, askShort: t.askShort, last: t.last, allowed: !a.quiet && !a.danger };
      t.pose = a.quiet ? "idle" : "working";
      t.status = a.quiet ? null : "working";
      t.last = W.now;
    }
    var name = id === "rShip" ? "Ship release v2.15" : getSession(id).title;
    refreshAll();
    api.showToast(esc(a.done) + " · " + esc(name), "Undo", function () { unanswer(id); });
  }
  function unanswer(id) {
    var was = answered[id];
    if (!was) return;
    if (id !== "rShip") {
      var t = getSession(id);
      t.pose = was.pose;
      t.status = was.status;
      t.last = was.last;
    }
    delete answered[id];
    refreshAll();
  }

  /** Draws the sidebar's foot with the shared counts; the stage's own foot counts threads only. */
  function drawFoot() {
    var c = countAll();
    api.els.sum.innerHTML = "<b>" + c.working + "</b> working · <b" + (c.waiting ? ' class="you-ink"' : "") + ">" + c.waiting + "</b> waiting · <b>" + c.idle + "</b> idle";
  }

  function refreshAll() {
    LINES = null;
    drawFoot();
    renderSidebar();
    renderMinimap();
    if (overviewOpen && ov) {
      renderTop();
      renderPane();
      renderCard();
    }
  }

  function focusCrossing(key) {
    focusKey = focusKey === key ? null : key;
    var c = focusedCrossing();
    if (c && !overviewOpen) openOverview("lines");
    renderSidebar();
    if (overviewOpen) {
      renderPane();
      renderCard();
    }
  }

  function land(on) {
    landed = on;
    LINES = null;
    renderLines();
    renderCard();
    if (on) api.showToast("Tidy checkout CSS landed on main · 6 branches in line", "Undo", function () { land(false); });
  }

  function onOverviewClick(e) {
    var el = e.target.closest("[data-act]");
    if (!el || !ov.contains(el)) {
      hidePop();
      // A row of Threads selects its thread; a second click on the selected row opens it.
      var row = e.target.closest("[data-trow]");
      if (row && ov.contains(row)) {
        if (row.dataset.trow === selected) openThread(row.dataset.trow);
        else setSelected(row.dataset.trow);
      }
      return;
    }
    var act = el.dataset.act;
    e.preventDefault();
    if (act !== "station") hidePop();
    if (act === "mode") setMode(el.dataset.mode);
    else if (act === "close") closeOverview();
    else if (act === "select") {
      if (el.dataset.id === selected && e.detail > 1) openThread(el.dataset.id);
      else setSelected(el.dataset.id);
    } else if (act === "open") openThread(el.dataset.id);
    else if (act === "deselect") setSelected(null);
    else if (act === "answer") answer(el.dataset.id, Number(el.dataset.idx));
    else if (act === "focus-crossing") focusCrossing(el.dataset.key);
    else if (act === "unfocus") focusCrossing(focusKey);
    else if (act === "next-crossing") showNextCrossing();
    else if (act === "see-lines") {
      focusKey = el.dataset.key;
      setMode("lines");
      renderSidebar();
    } else if (act === "discuss") api.showToast("Discussion opened with both threads about " + esc(baseName(crossingByKey(el.dataset.key).path)));
    else if (act === "tell") api.showToast("Told both threads they share " + esc(baseName(crossingByKey(el.dataset.key).path)), "Undo", function () {});
    else if (act === "station") showStation(el.dataset.line, el.dataset.part, Number(el.dataset.idx), el.querySelector(".at-st-dot"));
    else if (act === "land") land(true);
    else if (act === "unland") land(false);
    else if (act === "why") api.showToast("Ready branches first, then the ones others must rebase onto, then the ones that wait on you.");
    else if (act === "toggle-since") {
      sinceLeft = !sinceLeft;
      renderTop();
      renderLines();
    } else if (act === "show-since") {
      sinceLeft = true;
      setMode("lines");
      renderTop();
      renderLines();
    } else if (act === "clear-filter") {
      filter = null;
      refreshAll();
    }
  }
  /**
   * Shows the crossings from the top bar's count, which stands in for the City's own crossings chip:
   * in the Office it flies to the next one, elsewhere it lights the predicted conflict in every mode.
   */
  function showNextCrossing() {
    if (mode === "office" && office && office.show) {
      office.show("crossing");
      return;
    }
    var c = listCrossings().filter(function (x) { return x.kind === "conflict"; })[0] || listCrossings()[0];
    if (c) focusCrossing(keyOfCrossing(c));
  }

  function crossingByKey(key) {
    return listCrossings().filter(function (c) { return keyOfCrossing(c) === key; })[0];
  }

  /** Lights a line while the pointer is on it or on its row in the board, and dims the rest. */
  function onOverviewHover(e) {
    if (mode !== "lines") return;
    var svg = ov.querySelector(".at-svg");
    if (!svg) return;
    var el = e.target.closest("[data-line]");
    var key = e.type === "mouseover" && el ? el.dataset.line : null;
    svg.classList.toggle("has-hot", !!key);
    svg.querySelectorAll(".at-ln, .at-train").forEach(function (g) {
      g.classList.toggle("is-hot", !!key && g.dataset.line === key);
    });
  }

  function onSideClick(e) {
    var tile = e.target.closest("[data-tile]");
    if (tile) {
      e.preventDefault();
      var parts = tile.dataset.tile.split("|");
      filter = filter && filter.project === parts[0] && filter.path === parts[1] ? null : { project: parts[0], path: parts[1] };
      refreshAll();
      return;
    }
    var act = e.target.closest("[data-act]");
    if (act && api.els.side.contains(act)) {
      e.preventDefault();
      if (act.dataset.act === "clear-filter") {
        filter = null;
        refreshAll();
      } else if (act.dataset.act === "wait-more") {
        waitOpen = true;
        renderSidebar();
      } else if (act.dataset.act === "focus-crossing") focusCrossing(act.dataset.key);
      else if (act.dataset.act === "show-since") {
        sinceLeft = true;
        if (!overviewOpen) openOverview("lines");
        else setMode("lines");
      }
      return;
    }
    var row = e.target.closest("[data-row]");
    if (row) {
      e.preventDefault();
      var id = row.dataset.row;
      // While the overview is open the sidebar is its index: a click selects, a second click opens.
      if (overviewOpen) {
        if (id === selected) openThread(id);
        else setSelected(id);
      } else if (api.getThread(id)) openThread(id);
      else {
        selected = id;
        openOverview();
      }
    }
  }

  function onKey(e) {
    var typing = /input|textarea|select/i.test((e.target && e.target.tagName) || "") || (e.target && e.target.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "o" || e.key === "O")) {
      e.preventDefault();
      if (overviewOpen) closeOverview();
      else openOverview();
      return;
    }
    if (!overviewOpen || typing || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toUpperCase();
    if (k === "O") setMode("office");
    else if (k === "T") setMode("threads");
    else if (k === "L") setMode("lines");
    else if (e.key === "Escape") {
      if (ov.querySelector("[data-pop]").hidden === false) hidePop();
      else if (focusKey) focusCrossing(focusKey);
      else closeOverview();
    } else if (e.key === "Enter" && selected) openThread(selected);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      var order = listOrder();
      var i = order.indexOf(selected);
      i = e.key === "ArrowDown" ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
      setSelected(order[i]);
    }
  }
  /** Returns the ids in the order the sidebar lists them, waiting first. */
  function listOrder() {
    var ids = listWaiting().all.slice();
    buildTerritories().forEach(function (terr) {
      terr.areas.forEach(function (a) {
        a.threads.forEach(function (t) {
          if (ids.indexOf(t.id) === -1) ids.push(t.id);
        });
      });
    });
    return ids;
  }

  /* ------------------------------------------------------------------ the open thread's header */

  /** Adds the thread's territory to today's header: the file it is in and, when it crosses another thread, a warning pill. */
  function drawHeader(t, stageApi) {
    var base = stageApi.drawHeader(t);
    var path = pickFile(t.id);
    var x = crossingsOf(t.id).sort(function (a, b) { return a.kind === "conflict" ? -1 : 1; })[0];
    var pill = "";
    if (path) {
      pill += '<span class="pill at-hd-terr" title="' + esc(path) + '">' + Crew.icon("file", 14) + '<span class="mono"><span class="faint">' + esc(folderOf(path)) + "/</span>" + esc(baseName(path)) + "</span>" + drawDiff(diffOf(t.id)) + "</span>";
    }
    if (x) {
      pill += '<span class="pill at-hd-x at-hd-x--' + x.kind + '"><button class="pill-btn" data-hd-crossing="' + esc(keyOfCrossing(x)) + '" title="See the crossing in Lines">' + drawCrossGlyph(x, 14) + "Crosses " + esc(getSession(otherOf(x, t.id)).title) + (x.kind === "conflict" ? " · would conflict" : "") + Crew.icon("chev-r", 12) + "</button></span>";
    }
    // The thread's territory floats under the header, on the right, where the tabs leave room.
    return base + (pill ? '<div class="at-hd-terr-wrap">' + pill + "</div>" : "");
  }

  /* ------------------------------------------------------------------ registration */

  Stage.direction({
    rootClass: "ov-atlas",
    initial: "t3ds",
    drawList: function (listEl, stageApi) {
      api = stageApi;
      var mm = document.createElement("div");
      mm.className = "at-mm";
      api.els.list.parentNode.insertBefore(mm, api.els.list);
      var officeBtn = api.els.side.querySelector('.side-actions .icon-btn[title^="The office"]');
      if (officeBtn) {
        officeBtn.setAttribute("data-office-btn", "");
        officeBtn.title = "Overview ⌘⇧O";
        officeBtn.addEventListener("click", function () {
          if (overviewOpen) closeOverview();
          else openOverview();
        });
      }
      api.els.side.addEventListener("click", onSideClick);
      renderMinimap();
      renderSidebar();
      drawFoot();
    },
    drawHeader: drawHeader,
    drawMain: function (mainEl, t, stageApi) {
      if (!overviewOpen) return false;
      if (!ov) buildOverview();
      mainEl.innerHTML = "";
      mainEl.appendChild(ov);
      ov.dataset.mode = mode;
      renderTop();
      renderPane();
      renderCard();
      return true;
    },
    onOpen: function (id) {
      if (api) renderSidebar();
      var m = api && api.els.main.querySelector("[data-hd-crossing]");
      if (m)
        m.addEventListener("click", function () {
          focusKey = m.dataset.hdCrossing;
          openOverview("lines");
        });
    },
    boot: function () {
      markOfficeButton();
      document.addEventListener("keydown", onKey);
      var t = null;
      window.addEventListener("resize", function () {
        clearTimeout(t);
        t = setTimeout(function () {
          if (overviewOpen && mode === "lines") renderLines();
          if (office && office.resize) office.resize();
        }, 120);
      });
      // The map is drawn with estimated text widths; once the fonts are in, it is drawn again so nothing shifts later.
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () {
        if (overviewOpen && mode === "lines") renderLines();
      });
    },
  });
})();
