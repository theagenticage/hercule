// PROTOTYPE - direction 4, Tracks: time organizes the list.
//
// Each piece of work is a lane: one row, the height of today's. Line 1 is the lead's title and
// the status of whoever speaks for the lane. Line 2 is a track strip over the last hour,
// its right edge at now, with one track per thread:
//   - the track is drawn in the thread's own hue (color is who);
//   - a thick bead where a turn ran, a hairline where the thread sat idle;
//   - marigold from the moment it started waiting on Rogier, ending in the waiting mark;
//   - a partner's track branches off its lead's at the minute it was started;
//   - a tick joins two tracks where one thread messaged the other;
//   - a notch and a light wash mark what happened since Rogier last looked.
// The strips slide left as time moves, by one transform on one group per strip.
//
// The day sheet (the ruler, the header's Day sheet button, or ⌘⇧T) lays every lane out on one
// time axis from 07:00 to now, over the main pane.
(function () {
  "use strict";

  var D = window.TRACKS_DATA;
  var W = window.WORLD;
  var STATE = document.documentElement.dataset.state || new URLSearchParams(location.search).get("state") || "everyday";
  var params = new URLSearchParams(location.search);
  var SPEED = Math.max(0, Number(params.get("speed") || 1));

  var api = null;
  var lens = STATE === "lens" ? "status" : "project";
  var sortBy = "started";
  var shelfOpen = false;
  var shiftMin = 0; // how many minutes the clock has moved since the page opened
  var looked = {}; // lead id -> "HH:MM": when Rogier last looked at the lane
  var finished = {}; // lead id -> true while the lane's tracks end in checks
  var fresh = {}; // thread id -> true for a partner that just joined, so it draws in once
  var leaving = {}; // lead id -> true while the lane folds away
  var awayPending = STATE === "away"; // the away state: the open lane keeps its notch until Rogier is back
  var uid = 0;
  var spanCache = {};
  var BASE_NOW = toMin(W.now);
  var ORIGIN = BASE_NOW - D.stripMinutes; // the strip's left edge when the page opened
  var FAR = 6000; // how far an open-ended line runs past now; the clip cuts it at now
  var G = { w: 230, edge: 222, h: 20 };

  Object.keys(D.looked).forEach(function (k) {
    looked[k] = D.looked[k];
  });
  if (STATE === "away") {
    Object.keys(looked).forEach(function (k) {
      if (toMin(looked[k]) > toMin(D.awayFrom)) looked[k] = D.awayFrom;
    });
  }

  /* ------------------------------------------------------------------ the done state's morning */

  // The done state starts a little later in the morning: Rogier allowed the push, the lead opened
  // a pull request and the review found nothing more. Then he finishes the work.
  if (STATE === "done") {
    var t3ds = W.threads.filter(function (t) { return t.id === "t3ds"; })[0];
    var review = W.threads.filter(function (t) { return t.id === "t3dsReview"; })[0];
    t3ds.pose = "idle";
    t3ds.status = null;
    t3ds.last = "09:40";
    t3ds.result = "Pushed fix/3ds-eu-cards and opened PR #1290.";
    review.pose = "idle";
    review.status = null;
    review.last = "09:39";
    review.result = "2 findings, both fixed. Nothing more.";
    D.spans.t3ds = D.spans.t3ds.concat([["09:38", "09:40"]]);
    D.spans.t3dsReview = [["09:30", "09:34"], ["09:35", "09:39"]];
    W.transcripts.t3ds = W.transcripts.t3ds
      .filter(function (it) { return !it.waiting; })
      .concat([
        { worked: "Worked for 1m 48s", tools: ["ran git push", "opened a pull request"] },
        { agent: true, at: "09:40", html: "Pushed <code>fix/3ds-eu-cards</code> and opened PR #1290. The review found nothing more." },
      ]);
    looked.t3ds = "09:41";
  }

  /* ------------------------------------------------------------------ time */

  function toMin(time) {
    var parts = String(time).split(" ");
    var hm = parts[parts.length - 1].split(":");
    var day = parts.length > 1 ? { yesterday: -1, Mon: -1, Sun: -2, Sat: -3 }[parts[0]] || 0 : 0;
    return day * 1440 + Number(hm[0]) * 60 + Number(hm[1]);
  }

  function formatTime(m) {
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  function nowMin() {
    return BASE_NOW + shiftMin;
  }

  /* ------------------------------------------------------------------ spans */

  function hash(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Returns a generator of numbers in [0, 1), the same sequence for the same seed (mulberry32). */
  function seededRandom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var r = Math.imul(a ^ (a >>> 15), 1 | a);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Returns a thread's activity spans, [start, end] in minutes, with end null while its turn
   * still runs. Threads with no spans in tracks-data.js (the swarm's) get bursts of 2 to 8
   * minutes, mostly with short gaps and now and then a long one, seeded by the id so they are
   * the same on every load.
   */
  function readSpans(t) {
    if (spanCache[t.id]) return spanCache[t.id];
    var out;
    if (D.spans[t.id]) {
      out = D.spans[t.id].map(function (s) { return [toMin(s[0]), s[1] == null ? null : toMin(s[1])]; });
    } else {
      out = [];
      var rand = seededRandom(hash(t.id));
      var start = toMin(t.started);
      var last = toMin(t.last);
      var cursor = start;
      while (cursor < last) {
        var len = 2 + Math.floor(rand() * 7);
        // Mostly short pauses between turns, now and then a long one while nobody steered.
        var gap = rand() < 0.22 ? 8 + Math.floor(rand() * 14) : 1 + Math.floor(rand() * 4);
        out.push([cursor, Math.min(cursor + len, last)]);
        cursor += len + gap;
      }
      if (t.status === "working" && out.length) out[out.length - 1][1] = null;
      if (t.status === "working" && !out.length) out.push([start, null]);
    }
    spanCache[t.id] = out;
    return out;
  }

  /** Returns the minutes a thread worked inside the last `window` minutes. */
  function countBusy(t, windowMinutes) {
    var from = nowMin() - windowMinutes;
    var to = nowMin();
    return readSpans(t).reduce(function (sum, s) {
      var a = Math.max(from, s[0]);
      var b = Math.min(to, s[1] == null ? to : s[1]);
      return sum + Math.max(0, b - a);
    }, 0);
  }

  /** Returns the last minute anything happened in a lane: a span, an exchange, a Request. */
  function findLastEvent(crew) {
    var latest = -Infinity;
    crew.forEach(function (t) {
      readSpans(t).forEach(function (s) {
        latest = Math.max(latest, s[1] == null ? nowMin() : s[1], s[0]);
      });
      if (t.pose === "waiting") latest = Math.max(latest, toMin(t.last));
      latest = Math.max(latest, toMin(t.started));
    });
    return latest;
  }

  /* ------------------------------------------------------------------ the crew of a lane */

  function isLive(t) {
    return !!api.listThreads(function (x) { return x.id === t.id; }).length;
  }

  /** Returns a lane's threads, lead first: the live crew, or the shelf's for a lane marked done. */
  function listLaneCrew(leadId) {
    var lead = api.getThread(leadId);
    if (lead && isLive(lead)) return api.listCrew(leadId);
    return W.done.filter(function (d) { return d.id === leadId || d.lead === leadId; });
  }

  /*
   * A crew never shares a color. Faces are seeded from the thread, so two threads of one piece
   * of work can draw the same hue, and a track that carries its thread's hue would then be read
   * as the other thread's. Tracks asks for one change to how a face is chosen: a partner takes a
   * hue its crew does not wear yet, decided once when it starts. The lead keeps its own.
   * Here that is a look per title, handed to Crew.face for every face the page draws.
   */
  var HUES = ["iris", "teal", "orchid", "lime", "sky", "peach", "mint", "grape"];
  // The hue angles of tokens.css, so a partner's hue can be chosen far from its crew's.
  var ANGLE = { lime: 132, mint: 166, teal: 198, sky: 240, iris: 282, grape: 312, orchid: 345, peach: 52 };
  var looks = {};

  function hueDistance(a, b) {
    var d = Math.abs(ANGLE[a] - ANGLE[b]) % 360;
    return Math.min(d, 360 - d);
  }

  function buildLooks() {
    var all = api.listThreads().concat(W.done, [W.spawn.thread]);
    all.filter(function (t) { return !t.lead; }).forEach(function (lead) {
      var crew = [lead].concat(
        all.filter(function (t) { return t.lead === lead.id; }).sort(function (a, b) { return toMin(a.started) - toMin(b.started); })
      );
      var used = [];
      crew.forEach(function (t) {
        var base = Crew.lookFor(t.title);
        var look = { hue: base.hue, shape: base.shape, acc: base.acc };
        var nearest = used.reduce(function (m, h) { return Math.min(m, hueDistance(h, look.hue)); }, 360);
        if (nearest < 40) {
          // Too close to a crewmate's hue: take the free hue farthest from all of theirs.
          look.hue = HUES.filter(function (h) { return used.indexOf(h) === -1; }).sort(function (a, b) {
            var da = used.reduce(function (m, h) { return Math.min(m, hueDistance(h, a)); }, 360);
            var db = used.reduce(function (m, h) { return Math.min(m, hueDistance(h, b)); }, 360);
            return db - da || (hash(t.id + a) % 7) - (hash(t.id + b) % 7);
          })[0];
        }
        used.push(look.hue);
        looks[t.title] = look;
      });
    });
    var drawFaceAsSeeded = Crew.face;
    Crew.face = function (name, opts) {
      var o = {};
      for (var k in opts || {}) o[k] = opts[k];
      if (!o.look && looks[name]) o.look = looks[name];
      return drawFaceAsSeeded(name, o);
    };
  }

  function hueOf(t) {
    return (looks[t.title] || Crew.lookFor(t.title)).hue;
  }

  function roleOf(t) {
    return t.lead ? t.role || "partner" : "lead";
  }

  /* ------------------------------------------------------------------ geometry */

  function measure() {
    var listW = api.els.list.clientWidth || 272;
    G.w = listW - 24 - 18;
    G.edge = G.w - 8;
  }

  function ppm() {
    return G.edge / D.stripMinutes;
  }

  function xAt(m) {
    return (m - ORIGIN) * ppm();
  }

  /**
   * Returns the centre of each track in the 20px strip. Beads are 4px tall (3px for four tracks)
   * and sit on whole pixels, so their edges stay crisp; the 1px hairline runs through their middle.
   */
  function trackYs(n) {
    if (n <= 1) return [10];
    if (n === 2) return [6, 14];
    if (n === 3) return [4, 10, 16];
    return [2.5, 7.5, 12.5, 17.5];
  }

  function beadHeight(n) {
    return n >= 4 ? 3 : 4;
  }

  function snap(v) {
    return Math.round(v) + 0.5;
  }

  /* ------------------------------------------------------------------ one track strip */

  /**
   * Returns the markup of one track: its line where it existed, its beads where it worked, the
   * marigold line while it waits, and the elbow that branches it off its lead.
   */
  function drawTrack(t, y, leadY, laneFinished, n) {
    var start = toMin(t.started);
    var xs = xAt(start);
    var bh = beadHeight(n);
    var out = [];
    var hue = hueOf(t);
    out.push('<g class="tk-track' + (fresh[t.id] ? " is-fresh" : "") + '" data-tid="' + t.id + '" style="--hue:var(--hue-' + hue + ')">');
    if (leadY != null && start > ORIGIN - 6) {
      out.push('<path class="tk-elbow" d="M' + (xs - 8) + " " + leadY + "C" + (xs - 3.5) + " " + leadY + " " + (xs - 4.5) + " " + y + " " + xs + " " + y + '"/>');
    }
    var endX = laneFinished ? xAt(nowMin()) : FAR;
    var exitX = t.pose === "asleep" || t.pose === "away" ? xAt(toMin(t.last)) : null;
    var waitX = t.pose === "waiting" ? xAt(toMin(t.last)) : null;
    var baseEnd = exitX != null ? exitX : waitX != null ? waitX : endX;
    var x0 = Math.max(xs, -20);
    if (baseEnd > x0) out.push('<rect class="tk-base" x="' + x0 + '" y="' + (y - 0.5) + '" width="' + (baseEnd - x0) + '" height="1"/>');
    if (t.pose === "asleep") out.push('<path class="tk-sleep" d="M' + exitX + " " + y + "H" + FAR + '"/>');
    if (waitX != null) out.push('<rect class="tk-wait" x="' + waitX + '" y="' + (y - 1) + '" width="' + FAR + '" height="2"/>');
    readSpans(t).forEach(function (sp) {
      var a = xAt(sp[0]);
      var b = sp[1] == null ? (laneFinished ? xAt(nowMin()) : FAR) : xAt(sp[1]);
      if (b < -10) return;
      if (b - a < bh) b = a + bh;
      out.push('<rect class="tk-bead" x="' + a.toFixed(2) + '" y="' + (y - bh / 2) + '" width="' + (b - a).toFixed(2) + '" height="' + bh + '" rx="' + bh / 2 + '"/>');
    });
    out.push("</g>");
    return out.join("");
  }

  /** Returns what sits on the now edge for a thread: the waiting mark, a working nib, a check. */
  function drawTerminal(t, y, laneFinished) {
    var e = G.edge;
    var hue = hueOf(t);
    var g = '<g class="tk-term' + (fresh[t.id] ? " is-fresh" : "") + '" data-tid="' + t.id + '" style="--hue:var(--hue-' + hue + ')">';
    if (laneFinished) return g + '<path class="tk-check" d="M' + (e + 1.2) + " " + (y + 0.1) + "l2.1 2.1 4.1-4.5" + '"/></g>';
    if (t.pose === "waiting") return g + '<circle class="tk-ask-ring" cx="' + (e + 4) + '" cy="' + y + '" r="3"/><circle class="tk-ask-dot" cx="' + (e + 4) + '" cy="' + y + '" r="1.35"/></g>';
    if (t.status === "queued") return g + '<circle class="tk-queued" cx="' + (e + 2) + '" cy="' + y + '" r="2"/></g>';
    if (t.pose === "working") return g + '<circle class="tk-nib" cx="' + e + '" cy="' + y + '" r="2.75"/></g>';
    return g + "</g>";
  }

  /** Returns whether anything in a lane happened after Rogier last looked at it. */
  function hasNews(crew, lookedAt) {
    if (!lookedAt) return false;
    return findLastEvent(crew) > toMin(lookedAt) + 0.5;
  }

  /**
   * Returns the svg of a lane's strip. `openId` makes the open thread's track stand out in a lane
   * of several. Options: finished (the tracks end in checks at now).
   */
  function openLeadId() {
    var t = api.getThread(api.openId());
    return t ? t.lead || t.id : null;
  }

  function drawStrip(leadId, openId) {
    var crew = listLaneCrew(leadId).slice(0, 4);
    var ys = trackYs(crew.length);
    var laneFinished = !!finished[leadId];
    var clip = "tkc" + ++uid;
    var parts = [];
    // What Rogier has seen draws faint and what came after he looked draws bright, through one
    // mask in the strip's own coordinates, so it slides with the tracks as time moves.
    var lk = looked[leadId];
    var news = hasNews(crew, lk) && !laneFinished && (leadId !== openLeadId() || awayPending);
    var mask = "tkm" + uid;
    var xl = news ? Math.round(xAt(toMin(lk))) : null;
    if (news) {
      parts.push('<mask id="' + mask + '" maskUnits="userSpaceOnUse" x="-40" y="-4" width="' + (FAR + 80) + '" height="' + (G.h + 8) + '"><rect class="tk-seen" x="-40" y="-4" width="' + (FAR + 80) + '" height="' + (G.h + 8) + '"/><rect class="tk-new" x="' + xl + '" y="-4" width="' + FAR + '" height="' + (G.h + 8) + '"/></mask>');
      parts.push('<g mask="url(#' + mask + ')">');
    }
    crew.forEach(function (t, i) {
      parts.push(drawTrack(t, ys[i], i ? ys[0] : null, laneFinished, crew.length));
    });
    var ids = crew.map(function (t) { return t.id; });
    var msgs = [];
    api.listExchanges(leadId).forEach(function (e) {
      var fi = ids.indexOf(e.from);
      var ti = ids.indexOf(e.to);
      if (fi < 0 || ti < 0) return;
      var x = snap(xAt(toMin(e.at)));
      var sender = api.getThread(e.from);
      var y1 = ys[fi];
      var y2 = ys[ti];
      var dir = y2 > y1 ? 1 : -1;
      parts.push('<g class="tk-msg' + (fresh[e.to] || fresh[e.from] ? " is-fresh" : "") + '" style="--hue:var(--hue-' + hueOf(sender) + ')"><path d="M' + x + " " + y1 + "V" + y2 + '"/><circle cx="' + x + '" cy="' + y2 + '" r="1.75"/></g>');
    });
    if (news) {
      parts.push("</g>");
      parts.push('<path class="tk-notch" d="M' + (xl - 3) + " 0h6l-3 3.5z" + '"/>');
    }
    var terms = crew.map(function (t, i) { return drawTerminal(t, ys[i], laneFinished); }).join("");
    var band = crew.length > 1 ? ys[1] - ys[0] : G.h;
    var hits = crew.map(function (t, i) {
      var top = crew.length > 1 ? Math.max(0, ys[i] - band / 2) : 0;
      var h = crew.length > 1 ? band : G.h;
      return '<rect class="tk-hit" data-tid="' + t.id + '" x="0" y="' + top + '" width="' + G.w + '" height="' + h + '"/>';
    }).join("");
    var several = crew.length > 1 && ids.indexOf(openId) !== -1;
    return (
      '<svg class="tk-svg' + (several ? " has-open" : "") + '" width="' + G.w + '" height="' + G.h + '" viewBox="0 0 ' + G.w + " " + G.h + '" aria-hidden="true">' +
      '<defs><clipPath id="' + clip + '"><rect x="0" y="-2" width="' + G.edge + '" height="' + (G.h + 4) + '"/></clipPath></defs>' +
      '<g clip-path="url(#' + clip + ')"><g class="tk-shift">' + parts.join("") + "</g></g>" +
      '<rect class="tk-edge" x="' + G.edge + '" y="1" width="1" height="' + (G.h - 2) + '"/>' +
      terms +
      (several ? '<g class="tk-open-mark" data-open-track="' + openId + '"></g>' : "") +
      hits +
      "</svg>"
    );
  }

  /* ------------------------------------------------------------------ the list */

  /** Returns a project's diamond, the tint the book gives places, for a lane shown outside its project. */
  function drawDiamond(projectId) {
    var p = api.getProject(projectId);
    return '<span class="tk-diamond' + (p ? " proj--" + p.tint : " is-none") + '" title="' + (p ? p.name : "No project") + '"></span>';
  }

  function drawLane(lead, openId, opts) {
    opts = opts || {};
    var crew = listLaneCrew(lead.id);
    var spoke = finished[lead.id] ? lead : api.pickSpokesperson(crew);
    var slot = finished[lead.id] ? { kind: "done", text: "Done" } : api.decideSlot(spoke);
    var openHere = crew.some(function (t) { return t.id === openId; });
    var receded = spoke.pose === "working" && !openHere;
    var title = api.escapeHtml(lead.title);
    var label = crew.length > 1 ? lead.title + ", with " + crew.slice(1).map(roleOf).join(" and ") : lead.title;
    return (
      '<div class="tk-lane st-thread' + (receded ? " is-receded" : "") + (leaving[lead.id] ? " is-leaving" : "") + '" data-lane="' + lead.id + '">' +
      '<a class="side-row tk-row' + (openHere ? " is-on" : "") + '" href="#" data-open-row="' + lead.id + '" aria-label="' + api.escapeHtml(label) + '">' +
      '<span class="side-text tk-text">' +
      '<span class="st-line"><span class="side-name">' + (opts.diamond ? drawDiamond(lead.project) : "") + title + "</span>" +
      '<span class="side-end st-end--' + slot.kind + ' tk-slot" data-open-spoke="' + spoke.id + '" title="Open ' + api.escapeHtml(spoke.title) + '">' + slot.text + "</span></span>" +
      '<span class="tk-strip" data-strip="' + lead.id + '">' + drawStrip(lead.id, openId) + "</span>" +
      "</span></a></div>"
    );
  }

  function drawRuler() {
    var px = ppm();
    var marks = [
      { m: 60, text: "1h ago", align: "start" },
      { m: 45, text: "", align: "mid" },
      { m: 30, text: "30m", align: "mid" },
      { m: 15, text: "15m", align: "mid" },
      { m: 0, text: "now", align: "end" },
    ];
    return (
      '<button class="tk-ruler" type="button" title="Open the day sheet ⌘⇧T" data-sheet-toggle>' +
      '<span class="tk-ruler-in" style="width:' + G.w + 'px">' +
      marks.map(function (k) {
        var x = G.edge - k.m * px;
        // In the away state the "left" pill sits near 40 minutes ago; the label it would cover steps aside.
        if (STATE === "away" && k.m === 30) k = { m: k.m, text: "", align: k.align };
        var style = k.align === "start" ? "left:0" : k.align === "end" ? "right:0" : "left:" + x.toFixed(1) + "px";
        return '<span class="tk-tick" style="left:' + Math.round(x) + 'px"></span>' + (k.text ? '<span class="tk-mark tk-mark--' + k.align + '" style="' + style + '">' + k.text + "</span>" : "");
      }).join("") +
      (STATE === "away" ? '<span class="tk-left" style="left:' + Math.round(xAt(toMin(D.awayFrom)) - shiftMin * px) + 'px">left ' + D.awayFrom + "</span>" : "") +
      "</span></button>"
    );
  }

  function drawWaiting(openId) {
    var waiting = api.listThreads(function (t) { return t.pose === "waiting"; }).sort(function (a, b) { return api.compareTimes(b.last, a.last); });
    var runs = W.waitingRuns;
    if (!waiting.length && !runs.length) return "";
    var shown = waiting.slice(0, 3);
    return (
      '<section class="side-sec tk-waiting"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + (waiting.length + runs.length) + "</b></h3>" +
      shown.map(function (t) {
        var lead = api.findLead(t);
        var name = t.lead ? '<span class="tk-role">' + api.escapeHtml(t.role) + "</span> · " + api.escapeHtml(lead.title) : api.escapeHtml(t.title);
        return '<a class="side-row side-row--wait' + (t.id === openId ? " is-on" : "") + '" href="#" data-open-row="' + t.id + '">' + api.drawFace(t, 24, "waiting") + '<span class="side-text"><span class="side-name">' + name + '</span><span class="side-ask">' + api.escapeHtml(t.ask) + "</span></span></a>";
      }).join("") +
      (waiting.length > 3 ? '<a class="side-row st-more" href="#">' + (waiting.length - 3) + " more waiting on you</a>" : "") +
      '<h4 class="side-sub">From runs</h4>' +
      runs.map(function (r) {
        return '<a class="side-row side-row--wait" href="#"><span class="side-lead">' + Crew.mark("waiting") + '</span><span class="side-text"><span class="side-name">' + r.title + '</span><span class="side-ask">' + r.ask + "</span></span></a>";
      }).join("") +
      "</section>"
    );
  }

  /** Returns the lanes in the sort order picked in the lens menu. */
  function sortLanes(leads) {
    return leads.slice().sort(function (a, b) {
      if (sortBy === "name") return a.title.localeCompare(b.title);
      if (sortBy === "activity") return findLastEvent(listLaneCrew(b.id)) - findLastEvent(listLaneCrew(a.id));
      return api.compareTimes(b.started, a.started);
    });
  }

  /** Returns up to five lanes of a group: waiting first, then working, then the rest, in the group's order. The open lane always shows. */
  function pickShown(leads, openId) {
    var rank = { waiting: 0, working: 1 };
    var picked = leads
      .slice()
      .sort(function (a, b) {
        var pa = api.pickSpokesperson(listLaneCrew(a.id)).pose;
        var pb = api.pickSpokesperson(listLaneCrew(b.id)).pose;
        return (rank[pa] != null ? rank[pa] : 2) - (rank[pb] != null ? rank[pb] : 2);
      })
      .slice(0, 5);
    leads.forEach(function (l) {
      if (picked.indexOf(l) === -1 && listLaneCrew(l.id).some(function (t) { return t.id === openId; })) picked.push(l);
    });
    return leads.filter(function (l) { return picked.indexOf(l) !== -1; });
  }

  function allLeads() {
    return api.listThreads(function (t) { return !t.lead; });
  }

  function drawProjectGroup(projectId, openId) {
    var leads = sortLanes(allLeads().filter(function (t) { return t.project === projectId; }));
    if (!leads.length) return "";
    var p = api.getProject(projectId);
    var need = api.listThreads(function (t) { return t.project === projectId && t.pose === "waiting"; }).length;
    var shown = pickShown(leads, openId);
    var extra = STATE === "swarm" && p ? Math.round(W.swarm.more[p.id] / 2.4) : 0;
    var more = leads.length - shown.length + extra;
    return (
      '<section class="side-sec">' +
      '<h3 class="side-h side-h--proj">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj tk-noproj">No project</span>') +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '<button class="icon-btn icon-btn--sm" title="New thread in ' + (p ? p.name : "no project") + '">' + Crew.icon("plus", 14) + "</button></h3>" +
      shown.map(function (l) { return drawLane(l, openId); }).join("") +
      (more > 0 ? '<a class="side-row st-more" href="#">' + more + (more === 1 ? " more lane" : " more lanes") + "</a>" : "") +
      "</section>"
    );
  }

  function drawLensGroup(title, leads, openId, you) {
    if (!leads.length) return "";
    return (
      '<section class="side-sec tk-lens-sec">' +
      '<h3 class="side-h"><span>' + title + '</span><b class="count' + (you ? " count--you" : "") + '">' + leads.length + "</b></h3>" +
      leads.map(function (l) { return drawLane(l, openId, { diamond: true }); }).join("") +
      "</section>"
    );
  }

  function drawByLens(openId) {
    var leads = sortLanes(allLeads());
    if (lens === "status") {
      var groups = { waiting: [], working: [], quiet: [] };
      leads.forEach(function (l) {
        var spoke = api.pickSpokesperson(listLaneCrew(l.id));
        var key = spoke.pose === "waiting" ? "waiting" : spoke.pose === "working" ? "working" : "quiet";
        groups[key].push(l);
      });
      return drawLensGroup("Needs you", groups.waiting, openId, true) + drawLensGroup("Working", groups.working, openId) + drawLensGroup("Quiet", groups.quiet, openId);
    }
    if (lens === "machine") {
      return ["studio-mac", "build-box-1", "build-box-2"].map(function (m) {
        return drawLensGroup(m, leads.filter(function (l) { return api.findMachine(l) === m; }), openId);
      }).join("");
    }
    return '<section class="side-sec tk-lens-sec">' + leads.map(function (l) { return drawLane(l, openId, { diamond: true }); }).join("") + "</section>";
  }

  /** Returns the Done shelf: done lanes, a lane's threads together, newest first. */
  function drawShelf(openId) {
    var leads = [];
    W.done.forEach(function (d) {
      var leadId = d.lead || d.id;
      if (leads.indexOf(leadId) === -1) leads.push(leadId);
    });
    var count = W.doneCount + (W.done.length - 7);
    var openDone = W.done.some(function (d) { return d.id === openId; });
    var open = shelfOpen || openDone;
    var rows = "";
    if (open) {
      rows = leads.slice(0, shelfOpen ? 6 : 1).map(function (leadId) {
        var crew = W.done.filter(function (d) { return d.id === leadId || d.lead === leadId; });
        var lead = crew.filter(function (d) { return d.id === leadId; })[0] || crew[0];
        var on = crew.some(function (d) { return d.id === openId; });
        var others = crew.length > 1 ? " · with " + crew.slice(1).map(roleOf).join(", ") : "";
        return (
          '<div class="tk-lane tk-lane--done st-thread' + (W.done.indexOf(lead) < 3 && lead.doneAt === W.now ? " is-arriving" : "") + '" data-lane="' + leadId + '">' +
          '<a class="side-row tk-row' + (on ? " is-on" : "") + '" href="#" data-open-row="' + lead.id + '"><span class="side-text tk-text">' +
          '<span class="st-line"><span class="side-name">' + api.escapeHtml(lead.title) + '</span><span class="side-end tk-reopen">Reopen</span></span>' +
          '<span class="st-detail tk-done-detail">' + crew.map(function (d) { return Crew.face(d.title, { pose: "done", size: 14 }); }).join("") + '<span class="st-clip">Done ' + (lead.doneAt === W.now ? "now" : lead.doneAt) + others + "</span></span>" +
          "</span></a></div>"
        );
      }).join("");
    }
    return (
      '<section class="side-sec tk-shelf">' +
      '<h3 class="side-h side-h--done"><button type="button" data-shelf aria-expanded="' + open + '">' + Crew.icon("chev-r", 12) + 'Done <span class="count">' + count + "</span></button></h3>" +
      rows +
      "</section>"
    );
  }

  /** Returns the project ids in the sidebar's order: newest started lane first, as today's sidebar sorts them. */
  function orderProjects() {
    function newest(pid) {
      return allLeads().filter(function (t) { return t.project === pid; }).reduce(function (m, t) { return Math.max(m, toMin(t.started)); }, -1e9);
    }
    return W.projects.map(function (p) { return p.id; }).sort(function (a, b) { return newest(b) - newest(a); });
  }

  /** Draws the whole list. */
  function drawList() {
    var el = api.els.list;
    var scroll = el.scrollTop;
    measure();
    var openId = api.openId();
    var html = "";
    if (lens === "project") {
      var order = orderProjects();
      html += drawWaiting(openId) + drawRuler() + order.map(function (id) { return drawProjectGroup(id, openId); }).join("") + drawProjectGroup(null, openId);
    } else {
      var names = { status: "status", machine: "machine", none: "nothing" };
      var sorts = { started: "started", activity: "last activity", name: "name" };
      html +=
        '<div class="tk-lensbar">' + Crew.icon("filter", 13) + "<span>By <b>" + names[lens] + "</b> · " + sorts[sortBy] + '</span><button type="button" data-lens-reset>Projects</button></div>' +
        drawRuler() + drawByLens(openId);
    }
    html += drawShelf(openId);
    el.innerHTML = html;
    el.scrollTop = scroll;
    wireList(el);
    markOpenTrack();
  }

  /** Scrolls the open thread's lane into view when it is out of sight, as opening a thread does. */
  function revealOpenLane() {
    var el = api.els.list;
    var lane = el.querySelector('[data-lane="' + openLeadId() + '"]');
    if (!lane) return;
    var top = lane.offsetTop - el.offsetTop;
    var ruler = 30;
    if (top < el.scrollTop + ruler) el.scrollTop = top - ruler - 8;
    else if (top + lane.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + lane.offsetHeight - el.clientHeight + 8;
  }

  /** Redraws one lane's strip in place, leaving every other row alone. */
  function redrawStrip(leadId) {
    var host = api.els.list.querySelector('[data-strip="' + leadId + '"]');
    if (host) host.innerHTML = drawStrip(leadId, api.openId());
    markOpenTrack();
  }

  /** In a lane of several, the open thread's track stays bright and the others step back. */
  function markOpenTrack() {
    var openId = api.openId();
    api.els.list.querySelectorAll(".tk-svg.has-open").forEach(function (svg) {
      svg.querySelectorAll(".tk-track, .tk-term").forEach(function (g) {
        g.classList.toggle("is-dim", g.dataset.tid !== openId);
      });
    });
  }

  /* ------------------------------------------------------------------ hover: which track is which */

  var card = null;
  var hot = null;

  function ensureCard() {
    if (card) return card;
    card = document.createElement("div");
    card.className = "tk-card";
    card.hidden = true;
    document.body.appendChild(card);
    return card;
  }

  function describeStatus(t) {
    if (t.pose === "waiting") return '<span class="tk-c-status is-you">' + (t.status === "approval" ? "Approval" : "Question") + "</span>";
    if (t.status === "queued") return '<span class="tk-c-status">Queued</span>';
    if (t.pose === "working") return '<span class="tk-c-status is-working">Working</span>';
    if (t.pose === "asleep") return '<span class="tk-c-status">Asleep</span>';
    return '<span class="tk-c-status">' + api.formatAge(t.last) + "</span>";
  }

  function showCard(leadId, tid, rowRect) {
    var crew = listLaneCrew(leadId);
    var lead = crew[0];
    var p = api.getProject(lead.project);
    var lk = looked[leadId];
    var news = hasNews(crew, lk);
    var c = ensureCard();
    c.innerHTML =
      '<div class="tk-c-head">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj">No project</span>') +
      '<span class="tk-c-place">' + api.escapeHtml(api.findBranch(lead) || api.findMachine(lead)) + "</span></div>" +
      '<p class="tk-c-title">' + api.escapeHtml(lead.title) + "</p>" +
      crew.map(function (t) {
        var busy = countBusy(t, 60);
        var role = roleOf(t);
        return (
          '<div class="tk-c-row' + (t.id === tid ? " is-hot" : "") + '" style="--hue:var(--hue-' + hueOf(t) + ')">' +
          api.drawFace(t, 20) +
          '<span class="tk-c-text"><span class="tk-c-name"><b>' + api.escapeHtml(role) + "</b>" + api.drawBrand(t, 11) + '<span class="tk-c-agent">' + api.escapeHtml(api.describeAgent(t)) + "</span></span>" +
          '<span class="tk-c-sub">' + (t.lead ? api.escapeHtml(t.title) : "Busy " + busy + " of the last 60 min") + "</span></span>" +
          describeStatus(t) +
          "</div>"
        );
      }).join("") +
      '<div class="tk-c-foot">' + (news ? "<span>" + Crew.icon("eye", 12) + "You looked at " + lk + ". What came after is bright.</span>" : "<span>Click a track to open its thread</span>") + "</div>";
    c.hidden = false;
    var side = api.els.side.getBoundingClientRect();
    var top = Math.min(window.innerHeight - c.offsetHeight - 12, Math.max(12, rowRect.top - 8));
    c.style.left = side.right + 10 + "px";
    c.style.top = top + "px";
  }

  function hideCard() {
    if (card) card.hidden = true;
    if (hot) {
      hot.classList.remove("is-hovering");
      hot.querySelectorAll(".is-hot").forEach(function (g) { g.classList.remove("is-hot"); });
      hot = null;
    }
  }

  var hoverTimer = 0;

  function wireList(el) {
    el.querySelectorAll("[data-open-row]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var target = e.target.closest("[data-open-spoke]");
        var hit = e.target.closest(".tk-hit");
        hideCard();
        if (hit) return api.open(hit.dataset.tid);
        if (target) return api.open(target.dataset.openSpoke);
        api.open(a.dataset.openRow);
      });
    });
    el.querySelectorAll(".tk-svg").forEach(function (svg) {
      var lane = svg.closest("[data-lane]");
      if (!lane) return;
      svg.addEventListener("pointermove", function (e) {
        var hit = e.target.closest(".tk-hit");
        if (!hit) return;
        var tid = hit.dataset.tid;
        if (hot && hot !== svg) hideCard();
        hot = svg;
        svg.classList.add("is-hovering");
        svg.querySelectorAll(".tk-track, .tk-term").forEach(function (g) { g.classList.toggle("is-hot", g.dataset.tid === tid); });
        clearTimeout(hoverTimer);
        var rect = lane.getBoundingClientRect();
        if (card && !card.hidden) showCard(lane.dataset.lane, tid, rect);
        else hoverTimer = setTimeout(function () { showCard(lane.dataset.lane, tid, rect); }, 300);
      });
      svg.addEventListener("pointerleave", function () {
        clearTimeout(hoverTimer);
        hideCard();
      });
    });
    el.querySelectorAll("[data-shelf]").forEach(function (b) {
      b.addEventListener("click", function () {
        shelfOpen = !shelfOpen;
        drawList();
      });
    });
    el.querySelectorAll("[data-lens-reset]").forEach(function (b) {
      b.addEventListener("click", function () {
        lens = "project";
        closeLens();
        drawList();
      });
    });
    if (!el._scrollWired) {
      el._scrollWired = true;
      el.addEventListener("scroll", hideCard, { passive: true });
    }
  }

  /* ------------------------------------------------------------------ the lens menu */

  var lensPop = null;

  function drawLensButton() {
    var actions = api.els.side.querySelector(".side-actions");
    var btn = document.createElement("button");
    btn.className = "icon-btn tk-lens-btn";
    btn.title = "Group and sort";
    btn.innerHTML = Crew.icon("filter");
    actions.insertBefore(btn, actions.querySelector(".icon-btn"));
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (lensPop && !lensPop.hidden) closeLens();
      else openLens(btn);
    });
    document.addEventListener("click", function (e) {
      if (lensPop && !lensPop.hidden && !lensPop.contains(e.target)) closeLens();
    });
    return btn;
  }

  function openLens(btn) {
    if (!lensPop) {
      lensPop = document.createElement("div");
      lensPop.className = "tk-lens-pop";
      document.body.appendChild(lensPop);
    }
    var group = [["project", "Project"], ["status", "Status"], ["machine", "Machine"], ["none", "Nothing"]];
    var sort = [["started", "Started"], ["activity", "Last activity"], ["name", "Name"]];
    function rows(list, current, kind) {
      return list.map(function (o) {
        return '<button type="button" class="tk-lens-opt' + (o[0] === current ? " is-on" : "") + '" data-' + kind + '="' + o[0] + '"><span>' + o[1] + "</span>" + (o[0] === current ? Crew.icon("check", 14) : "") + "</button>";
      }).join("");
    }
    lensPop.innerHTML =
      '<div class="tk-lens-h">Group lanes by</div>' + rows(group, lens, "group") +
      '<div class="tk-lens-sep"></div><div class="tk-lens-h">Sort by</div>' + rows(sort, sortBy, "sort") +
      '<p class="tk-lens-note">A lane moves as one: its tracks never split.</p>';
    lensPop.hidden = false;
    var r = btn.getBoundingClientRect();
    lensPop.style.left = Math.round(r.left) + "px";
    lensPop.style.top = Math.round(r.bottom + 6) + "px";
    btn.classList.add("is-pressed");
    lensPop.querySelectorAll("[data-group]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        lens = b.dataset.group;
        drawList();
        openLens(btn);
      });
    });
    lensPop.querySelectorAll("[data-sort]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        sortBy = b.dataset.sort;
        drawList();
        openLens(btn);
      });
    });
  }

  function closeLens() {
    if (lensPop) lensPop.hidden = true;
    var btn = api.els.side.querySelector(".tk-lens-btn");
    if (btn) btn.classList.toggle("is-pressed", lens !== "project");
  }

  /* ------------------------------------------------------------------ the header: the lane's crew as tabs */

  function drawHeader(t) {
    var leadId = t.lead || t.id;
    var crew = listLaneCrew(leadId);
    var p = api.getProject(t.project);
    return (
      '<header class="top">' +
      '<nav class="pill tk-crewbar" aria-label="Threads of this piece of work">' +
      '<span class="pill-crumb">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj">No project</span>') + "</span>" +
      crew.map(function (x) {
        var label = x.lead ? '<span class="tk-tab-role">' + api.escapeHtml(x.role) + "</span>" + api.drawBrand(x, 12) : '<span class="tk-tab-title">' + api.escapeHtml(x.title) + "</span>";
        var end = x.pose === "waiting" ? Crew.mark("waiting", 13) : x.pose === "working" ? Crew.mark("working", 13) : x.doneAt ? Crew.mark("done", 13) : "<small>" + api.formatAge(x.last) + "</small>";
        return '<a class="ptab tk-tab' + (x.id === t.id ? " is-on" : "") + '" href="#" data-open="' + x.id + '" title="' + api.escapeHtml(x.title) + '">' + api.drawFace(x, 18, x.doneAt ? "done" : x.pose) + label + end + "</a>";
      }).join("") +
      '<button class="icon-btn" title="New thread in this piece of work">' + Crew.icon("plus") + "</button>" +
      "</nav>" +
      '<span class="spacer"></span>' +
      '<span class="pill"><button class="pill-btn tk-sheet-btn" data-sheet-toggle title="The day sheet ⌘⇧T">' + SHEET_ICON + "Day sheet<kbd>⌘⇧T</kbd></button></span>" +
      '<span class="pill"><button class="icon-btn" title="Side pane">' + Crew.icon("sidebar") + "</button></span>" +
      '<span class="pill"><button class="icon-btn" title="More">' + Crew.icon("more") + "</button></span>" +
      "</header>"
    );
  }

  var SHEET_ICON = '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h5.5M5.5 8h8M3.5 11.5h6.5"/></svg>';

  /* ------------------------------------------------------------------ the day sheet */

  var sheet = null;
  var sheetOpen = false;
  var LABEL_W = 268;
  // How much of the day the sheet spans: the last hour, the last two, or the whole morning.
  var SPANS_SHOWN = { "1h": 60, "2h": 120, morning: null };
  var sheetSpan = "2h";

  function toggleSheet(force) {
    var next = force != null ? force : !sheetOpen;
    if (next === sheetOpen) return;
    sheetOpen = next;
    if (!sheet) {
      sheet = document.createElement("section");
      sheet.className = "tk-sheet";
      sheet.setAttribute("aria-label", "Day sheet");
      api.els.app.appendChild(sheet);
    }
    if (sheetOpen) {
      drawSheet();
      sheet.classList.add("is-open");
    } else {
      sheet.classList.remove("is-open");
    }
    api.els.app.classList.toggle("tk-sheet-open", sheetOpen);
    document.querySelectorAll("[data-sheet-toggle]").forEach(function (b) { b.classList.toggle("is-pressed", sheetOpen); });
  }

  function drawSheet() {
    var to = nowMin();
    var from = SPANS_SHOWN[sheetSpan] ? to - SPANS_SHOWN[sheetSpan] : toMin(D.sheetFrom);
    var width = sheet.clientWidth || api.els.main.clientWidth;
    var chartW = width - LABEL_W - 40 - 28;
    var px = chartW / (to - from);
    function xs(m) { return (m - from) * px; }
    var ROW = 26;
    var HEAD = 30;

    var step = sheetSpan === "1h" ? 15 : 30;
    var hours = [];
    for (var m = Math.ceil(from / step) * step; m <= to - 6; m += step) hours.push(m);

    var axis =
      '<div class="tk-s-axis"><div class="tk-s-axis-label">' + W.today.replace(" 2026", "") + '</div><div class="tk-s-axis-chart" style="width:' + chartW + 'px">' +
      hours.map(function (hm) {
        var on = hm % 60 === 0;
        return '<span class="tk-s-hour' + (on ? " is-hour" : "") + '" style="left:' + xs(hm).toFixed(1) + 'px">' + formatTime(hm) + "</span>";
      }).join("") +
      '<span class="tk-s-now" style="left:' + xs(to).toFixed(1) + 'px">now ' + formatTime(to) + "</span>" +
      "</div></div>";

    var leads = allLeads();
    var order = orderProjects().concat([null]);
    var blocks = order.map(function (pid) {
      var ls = sortLanes(leads.filter(function (l) { return l.project === pid; }));
      if (!ls.length) return "";
      var p = api.getProject(pid);
      var nThreads = ls.reduce(function (s, l) { return s + listLaneCrew(l.id).length; }, 0);
      return (
        '<div class="tk-s-proj"><div class="tk-s-proj-h">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj tk-noproj">No project</span>') +
        '<span class="tk-s-count">' + ls.length + (ls.length === 1 ? " lane" : " lanes") + " · " + nThreads + (nThreads === 1 ? " thread" : " threads") + "</span></div>" +
        ls.map(function (l) { return drawSheetLane(l, xs, chartW, ROW, HEAD, from, to); }).join("") +
        "</div>"
      );
    }).join("");

    var grid = hours.map(function (hm) {
      return '<span class="tk-s-grid' + (hm % 60 === 0 ? " is-hour" : "") + '" style="left:' + (LABEL_W + xs(hm)).toFixed(1) + 'px"></span>';
    }).join("") + '<span class="tk-s-grid is-now" style="left:' + (LABEL_W + xs(to)).toFixed(1) + 'px"></span>';

    sheet.innerHTML =
      '<div class="tk-s-top">' +
      '<div class="tk-s-title"><h2>Day sheet</h2><span>Every lane on one clock. Click a track to open it.</span></div>' +
      '<div class="seg tk-s-span" role="tablist" aria-label="How much of the day">' +
      [["1h", "1 hour"], ["2h", "2 hours"], ["morning", "Since 07:00"]].map(function (o) {
        return '<button type="button" role="tab" aria-selected="' + (o[0] === sheetSpan) + '" data-span="' + o[0] + '">' + o[1] + "</button>";
      }).join("") +
      "</div>" +
      '<div class="tk-s-legend">' +
      '<span><i class="tk-lg tk-lg--bead"></i>Worked</span>' +
      '<span><i class="tk-lg tk-lg--idle"></i>Idle</span>' +
      '<span><i class="tk-lg tk-lg--wait"></i>Waiting on you</span>' +
      '<span><i class="tk-lg tk-lg--msg"></i>Message</span>' +
      '<span><i class="tk-lg tk-lg--seen"></i>Seen<i class="tk-lg tk-lg--bead"></i>New</span>' +
      "</div>" +
      '<button class="btn btn--sm tk-s-close" data-sheet-close>Close<kbd>esc</kbd></button>' +
      "</div>" +
      axis +
      '<div class="tk-s-body"><div class="tk-s-rows">' + grid + blocks + "</div></div>" +
      '<div class="tk-s-tip" hidden></div>';

    sheet.querySelector("[data-sheet-close]").addEventListener("click", function () { toggleSheet(false); });
    sheet.querySelectorAll("[data-span]").forEach(function (b) {
      b.addEventListener("click", function () {
        sheetSpan = b.dataset.span;
        drawSheet();
      });
    });
    sheet.querySelectorAll("[data-open-thread]").forEach(function (r) {
      r.addEventListener("click", function () {
        toggleSheet(false);
        api.open(r.dataset.openThread);
      });
    });
    var tip = sheet.querySelector(".tk-s-tip");
    sheet.querySelectorAll("[data-tip]").forEach(function (b) {
      b.addEventListener("pointerenter", function () {
        tip.innerHTML = b.dataset.tip;
        tip.hidden = false;
        var r = b.getBoundingClientRect();
        var host = sheet.getBoundingClientRect();
        tip.style.left = Math.round(r.left - host.left + r.width / 2) + "px";
        tip.style.top = Math.round(r.top - host.top - 8) + "px";
      });
      b.addEventListener("pointerleave", function () { tip.hidden = true; });
    });
  }

  function drawSheetLane(lead, xs, chartW, ROW, HEAD, from, to) {
    var crew = listLaneCrew(lead.id);
    var spoke = api.pickSpokesperson(crew);
    var slot = api.decideSlot(spoke);
    var height = HEAD + crew.length * ROW + 6;
    var ys = crew.map(function (t, i) { return HEAD + i * ROW + ROW / 2 + 0.5; });
    var lk = looked[lead.id];
    var news = hasNews(crew, lk) && (lead.id !== openLeadId() || awayPending);
    var svg = [];
    var maskId = "tks" + ++uid;
    var xl = news ? Math.round(xs(toMin(lk))) + 0.5 : null;
    if (news) {
      svg.push('<mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="-20" y="0" width="' + (chartW + 60) + '" height="' + height + '"><rect class="tk-seen" x="-20" y="0" width="' + (chartW + 60) + '" height="' + height + '"/><rect class="tk-new" x="' + xl + '" y="0" width="' + (chartW + 60) + '" height="' + height + '"/></mask>');
      svg.push('<g mask="url(#' + maskId + ')">');
    }
    crew.forEach(function (t, i) {
      var y = ys[i];
      var hue = hueOf(t);
      var s = toMin(t.started);
      var x0 = Math.max(0, xs(s));
      var g = ['<g class="tk-s-track" style="--hue:var(--hue-' + hue + ')">'];
      if (i > 0 && s >= from) {
        var xsS = xs(s);
        g.push('<path class="tk-elbow" d="M' + (xsS - 12) + " " + ys[0] + "C" + (xsS - 4) + " " + ys[0] + " " + (xsS - 6) + " " + y + " " + xsS + " " + y + '"/>');
      }
      var waitX = t.pose === "waiting" ? xs(toMin(t.last)) : null;
      var exitX = t.pose === "asleep" || t.pose === "away" ? xs(toMin(t.last)) : null;
      var baseEnd = exitX != null ? exitX : waitX != null ? waitX : xs(to);
      if (baseEnd > x0) g.push('<path class="tk-base" d="M' + x0 + " " + y + "H" + baseEnd + '"/>');
      if (t.pose === "asleep") g.push('<path class="tk-sleep" d="M' + exitX + " " + y + "H" + xs(to) + '"/>');
      if (waitX != null) {
        g.push('<rect class="tk-s-wait" x="' + waitX + '" y="' + (y - 4) + '" width="' + Math.max(2, xs(to) - waitX) + '" height="8" rx="2.5" data-tip="<b>Waiting on you</b> since ' + t.last + " · " + api.escapeHtml(t.askShort || "") + '"/>');
        g.push('<circle class="tk-ask-ring" cx="' + (xs(to) + 9) + '" cy="' + y + '" r="4"/><circle class="tk-ask-dot" cx="' + (xs(to) + 9) + '" cy="' + y + '" r="1.8"/>');
      }
      readSpans(t).forEach(function (sp) {
        var a = Math.max(xs(sp[0]), 0);
        var bEnd = sp[1] == null ? to : sp[1];
        var b = xs(bEnd);
        if (b <= 0) return;
        var mins = Math.round(bEnd - sp[0]);
        g.push('<rect class="tk-s-bead" x="' + a + '" y="' + (y - 4) + '" width="' + Math.max(2, b - a) + '" height="8" rx="2.5" data-tip="<b>' + formatTime(sp[0]) + " to " + (sp[1] == null ? "now" : formatTime(sp[1])) + "</b> · worked " + mins + 'm"/>');
      });
      if (t.pose === "working") g.push('<circle class="tk-nib" cx="' + xs(to) + '" cy="' + y + '" r="3.2"/>');
      g.push("</g>");
      svg.push(g.join(""));
    });
    var ids = crew.map(function (t) { return t.id; });
    api.listExchanges(lead.id).forEach(function (e) {
      var fi = ids.indexOf(e.from);
      var ti = ids.indexOf(e.to);
      if (fi < 0 || ti < 0) return;
      var x = Math.round(xs(toMin(e.at))) + 0.5;
      var y1 = ys[fi];
      var y2 = ys[ti];
      var dir = y2 > y1 ? 1 : -1;
      var sender = api.getThread(e.from);
      svg.push('<g class="tk-msg tk-s-msg" style="--hue:var(--hue-' + hueOf(sender) + ')" data-tip="<b>' + e.at + " · " + api.escapeHtml(roleOf(sender)) + " to " + api.escapeHtml(roleOf(api.getThread(e.to))) + "</b><br>" + api.escapeHtml(e.text) + '"><path d="M' + x + " " + (y1 + dir * 4) + "V" + (y2 - dir * 5.5) + '"/><path class="tk-s-arrow" d="M' + (x - 2.5) + " " + (y2 - dir * 6.5) + "L" + x + " " + (y2 - dir * 4) + "L" + (x + 2.5) + " " + (y2 - dir * 6.5) + '"/><rect x="' + (x - 4) + '" y="' + Math.min(y1, y2) + '" width="8" height="' + Math.abs(y2 - y1) + '" fill="transparent"/></g>');
    });
    if (news) {
      svg.push("</g>");
      svg.push('<path class="tk-notch" d="M' + (xl - 4) + " " + (HEAD - 9) + "h8l-4 5z" + '"/>');
      // The label reads away from the right edge when the notch is close to now.
      var nearEnd = xl > xs(to) - 120;
      svg.push('<text class="tk-s-looked" x="' + (nearEnd ? xl - 8 : xl + 8) + '" y="' + (HEAD - 4.5) + '" text-anchor="' + (nearEnd ? "end" : "start") + '">you looked at ' + lk + "</text>");
    }
    var labels = crew.map(function (t, i) {
      var name = t.lead ? "<b>" + api.escapeHtml(t.role) + "</b>" : "<b>lead</b>";
      return (
        '<button type="button" class="tk-s-label" data-open-thread="' + t.id + '" style="top:' + (HEAD + i * ROW) + 'px;height:' + ROW + 'px">' +
        api.drawFace(t, 18) + '<span class="tk-s-name">' + name + api.drawBrand(t, 11) + '<span class="tk-s-agent">' + api.escapeHtml(api.describeAgent(t)) + "</span></span>" +
        "</button>"
      );
    }).join("");
    return (
      '<div class="tk-s-lane" style="height:' + height + 'px">' +
      '<button type="button" class="tk-s-lane-h" data-open-thread="' + lead.id + '"><span class="tk-s-lane-title">' + api.escapeHtml(lead.title) + '</span><span class="st-end--' + slot.kind + ' tk-s-slot">' + slot.text + "</span></button>" +
      labels +
      '<svg class="tk-s-svg" style="left:' + LABEL_W + 'px" width="' + (chartW + 24) + '" height="' + height + '" viewBox="0 0 ' + (chartW + 24) + " " + height + '">' + svg.join("") + "</svg>" +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ time moves */

  /** Moves the clock one minute: every strip slides left by one minute, as one transform each. */
  function tick() {
    shiftMin += 1;
    W.now = formatTime(nowMin());
    api.els.list.style.setProperty("--tk-shift", (shiftMin * ppm()).toFixed(2) + "px");
    if (sheetOpen) drawSheet();
  }

  /* ------------------------------------------------------------------ the states that move */

  function playSpawn() {
    var lead = "tSecrets";
    var before = api.els.list.querySelector('[data-strip="' + lead + '"] .tk-track');
    var oldY = before ? Number(before.querySelector(".tk-base").getAttribute("y")) + 0.5 : trackYs(1)[0];
    var partner = api.spawnPartner();
    fresh[partner.id] = true;
    W.transcripts.tSecrets = [
      { me: "Rotate every staging secret in ops/secrets. One service at a time, and keep the old values until each one is checked.", at: "09:30" },
      { worked: "Worked for 6m 10s", tools: ["read 8 files", "ran 9 commands"] },
      { agent: true, at: "09:36", html: "Rotated 9 of 14 secrets in <code>ops/secrets</code>. I am asking Codex to check each service picks up the new values while I rotate the rest." },
      { sent: partner.id, at: "09:41", text: W.spawn.exchange.text },
      { worked: "Working", tools: [], live: true },
    ];
    redrawStrip(lead);
    var svg = api.els.list.querySelector('[data-strip="' + lead + '"] svg');
    var leadTrack = svg.querySelector('.tk-track[data-tid="' + lead + '"]');
    var leadTerm = svg.querySelector('.tk-term[data-tid="' + lead + '"]');
    var newY = trackYs(2)[0];
    [leadTrack, leadTerm].forEach(function (g) {
      if (!g) return;
      g.style.transform = "translateY(" + (oldY - newY) + "px)";
      g.getBoundingClientRect();
      g.style.transition = "transform 360ms var(--ease-out)";
      g.style.transform = "translateY(0)";
    });
    // A label names the partner for a moment, where its track starts.
    var host = api.els.list.querySelector('[data-strip="' + lead + '"]');
    var note = document.createElement("span");
    note.className = "tk-joined";
    note.style.setProperty("--hue", "var(--hue-" + hueOf(partner) + ")");
    note.innerHTML = api.drawFace(partner, 14) + "<b>" + partner.role + "</b> joined";
    // It sits in the empty time before the lane's first track, so it never covers the branch.
    var firstStart = Math.max(0, xAt(toMin(api.getThread(lead).started)));
    note.style.right = Math.max(0, G.w - firstStart + 8) + "px";
    host.appendChild(note);
    setTimeout(function () { note.classList.add("is-gone"); }, 2600);
    if (api.openId() === lead) api.drawMain();
    api.drawSum();
    // Then the clock runs four minutes fast, so the branch slides out from under now and the
    // new track grows. One transform per strip each minute; nothing is drawn again.
    [900, 1500, 2100, 2700].forEach(function (ms) { setTimeout(tick, ms); });
    // Once the moment is over the new partner is a track like the others.
    setTimeout(function () {
      delete fresh[partner.id];
      api.els.list.querySelectorAll(".is-fresh").forEach(function (g) { g.classList.remove("is-fresh"); });
    }, 4200);
  }

  function playDone() {
    var lead = "t3ds";
    finished[lead] = true;
    redrawStrip(lead);
    var lane = api.els.list.querySelector('[data-lane="' + lead + '"]');
    if (lane) {
      lane.querySelector(".tk-slot").textContent = "Done";
      lane.querySelector(".tk-slot").className = "side-end st-end--done tk-slot";
    }
    setTimeout(function () {
      if (lane) {
        lane.style.height = lane.offsetHeight + "px";
        lane.getBoundingClientRect();
        lane.classList.add("is-leaving");
      }
      setTimeout(function () {
        var ids = api.listCrew(lead).map(function (t) { return t.id; });
        var moved = api.markDone(ids);
        moved.slice().reverse().forEach(function (t) { W.done.unshift(t); });
        delete finished[lead];
        drawList();
        revealOpenLane();
        api.drawMain();
        api.showToast("Marked done · " + moved.length + " threads", "Undo", function () {
          moved.forEach(function (t) {
            var i = W.done.indexOf(t);
            if (i !== -1) W.done.splice(i, 1);
          });
          api.restoreThreads(moved);
          drawList();
          revealOpenLane();
          api.drawMain();
        });
        placeToast();
      }, 380);
    }, 1100);
  }

  /** Seats the toast on the list's bottom edge, just above the pinned assistants. */
  function placeToast() {
    var toast = api.els.side.querySelector(".stage-toast");
    if (!toast) return;
    var side = api.els.side.getBoundingClientRect();
    var list = api.els.list.getBoundingClientRect();
    toast.style.bottom = Math.round(side.bottom - list.bottom + 8) + "px";
  }

  /**
   * The away state's return: Rogier is back and looking at the open lane, so its notch slides to
   * now and everything new in it turns to seen.
   */
  function playAwayReturn() {
    var lead = openLeadId();
    var svg = api.els.list.querySelector('[data-strip="' + lead + '"] svg');
    awayPending = false;
    looked[lead] = W.now;
    if (!svg) return;
    var fresh = svg.querySelector(".tk-new");
    var notch = svg.querySelector(".tk-notch");
    if (!fresh || !notch) return;
    var dx = G.edge + 6 - Number(fresh.getAttribute("x"));
    [fresh, notch].forEach(function (el) {
      el.style.transition = "transform 1100ms var(--ease-out), opacity 1100ms var(--ease-out)";
      el.getBoundingClientRect();
      el.style.transform = "translateX(" + dx + "px)";
    });
    notch.style.opacity = "0";
  }

  /* ------------------------------------------------------------------ the direction */

  Stage.direction({
    rootClass: "d-tracks",
    initial: function (state) {
      if (state === "partner") return "t3dsReview";
      if (state === "spawn") return "tSecrets";
      return "t3ds";
    },
    drawList: function (el, a) {
      api = a;
      buildLooks();
      drawList();
    },
    drawHeader: function (t) {
      return drawHeader(t);
    },
    onOpen: function (id) {
      if (!api) return;
      var t = api.getThread(id);
      looked[t.lead || t.id] = W.now;
      drawList();
      revealOpenLane();
    },
    boot: function () {
      var btn = drawLensButton();
      btn.classList.toggle("is-pressed", lens !== "project");
      document.addEventListener("click", function (e) {
        if (e.target.closest("[data-sheet-toggle]")) toggleSheet();
      });
      document.addEventListener("keydown", function (e) {
        if (e.metaKey && e.shiftKey && (e.key === "t" || e.key === "T")) {
          e.preventDefault();
          toggleSheet();
        } else if (e.key === "Escape") {
          if (sheetOpen) toggleSheet(false);
          closeLens();
        }
      });
      window.addEventListener("resize", function () {
        drawList();
        if (sheetOpen) drawSheet();
      });
      if (STATE === "away") {
        // The open lane counts as looked at only once Rogier is back; the others keep their notch.
        looked[openLeadId()] = D.awayFrom;
        drawList();
        setTimeout(playAwayReturn, 2600);
      }
      if (STATE === "daysheet") toggleSheet(true);
      if (STATE === "spawn") setTimeout(playSpawn, 1000);
      if (STATE === "done") setTimeout(playDone, 900);
      if (STATE === "lens" && params.has("menu")) setTimeout(function () { openLens(btn); }, 50);
      if (SPEED > 0) setInterval(tick, 60000 / SPEED);
    },
  });
})();
