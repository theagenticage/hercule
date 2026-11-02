// PROTOTYPE - the overview window of round 2: the mode switch (Office · List · Kanban), the find
// field and the lenses, the List's three variants (Rows, Table, Outline), the peek panel and the
// design-review bar. It draws HEAVY's 70 sessions. Every row's line, progress, focus, roll-up,
// query and lens comes from window.Digest, so the List and the Kanban can never disagree.
//
// Load after heavy-world.js, digest.js, crew.js, office.js and board.js. Every rule in list.css is
// scoped under .lb-list and every class is prefixed lbl-.
(function () {
  "use strict";

  var H = window.HEAVY;
  var G = window.Digest;
  var Crew = window.Crew;

  /* ------------------------------------------------------------------ state, from the URL */

  var params = new URLSearchParams(location.search);

  function pick(name, allowed, fallback) {
    var v = params.get(name);
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  // The lenses. The URL spells Needs you as "waiting"; Digest.lens spells it "needs-you".
  var LENSES = [
    { id: "all", url: "all", label: "All" },
    { id: "following", url: "following", label: "Following" },
    { id: "mine", url: "mine", label: "Mine" },
    { id: "needs-you", url: "waiting", label: "Needs you" },
  ];

  function lensFromUrl(v) {
    for (var i = 0; i < LENSES.length; i++) if (LENSES[i].url === v || LENSES[i].id === v) return LENSES[i].id;
    return "all";
  }

  var state = {
    mode: pick("mode", ["office", "list", "kanban"], "list"),
    list: pick("list", ["rows", "table", "outline"], "rows"),
    board: pick("board", ["state", "phase"], "state"),
    lanes: params.get("lanes") === "project" ? "project" : false,
    lens: lensFromUrl(params.get("lens")),
    q: params.get("q") || "",
    group: pick("group", ["project", "none"], "project"),
    density: pick("density", ["comfortable", "compact"], "comfortable"),
    selected: null, // the selected session's id
    cursor: null, // the key of the line the keyboard is on; a thread can show twice in Rows
    peek: false,
    sort: null, // the Table's sort: { key, dir: 1 | -1 }
    open: {}, // folds the user opened: "more" (Waiting on you), "rest:<group>", "lead:<id>"
    shut: {}, // groups the user folded, by group key
    zoom: null, // Outline: the group that is zoomed in
    zoomThread: null, // Outline: the thread whose digest shows inline
  };

  /* ------------------------------------------------------------------ the items */

  // The Ship release run's waiting step, drawn as a row of Waiting on you, as the book's sidebar
  // draws it. It is not a thread, so it belongs to no project's list; its digest says only what a
  // run step has: it waits.
  var RUN_ITEMS = H.runs
    .filter(function (r) {
      return r.waiting;
    })
    .map(function (r) {
      return {
        id: r.id,
        run: r,
        title: r.title,
        project: r.project,
        provider: null,
        model: null,
        machine: r.machine,
        branch: null,
        pose: "waiting",
        ask: r.waiting.ask,
        askShort: r.waiting.askShort,
        askKind: "approval",
        started: r.started,
        last: r.waiting.since,
        lead: null,
        role: null,
        startedBy: "workflow",
        following: false,
        digest: { phase: "waiting", phaseBasis: "its " + r.waiting.step + " step asked at " + r.waiting.since, activity: null, plan: null, milestones: {}, focus: null, lastCheck: null, turnStartedAt: null, turnCount: 0 },
      };
    });
  var ALL = H.sessions.concat(RUN_ITEMS);
  var BY_ID = {};
  ALL.forEach(function (s) {
    BY_ID[s.id] = s;
  });

  var GROUPS = H.projects
    .map(function (p) {
      return { key: p.id, name: p.name, tint: p.tint };
    })
    .concat([{ key: "none", name: "No project", tint: null }]);

  function groupKeyOf(s) {
    return s.project || "none";
  }

  function groupByKey(key) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].key === key) return GROUPS[i];
    return null;
  }

  var URGENCY = { waiting: 0, working: 1, idle: 2, asleep: 3 };

  // The provider marks crew.js draws: Codex has no mark of its own and uses OpenAI's.
  var BRANDS = { claude: "claude", codex: "openai", pi: "pi" };

  /* ------------------------------------------------------------------ small helpers */

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function byStarted(a, b) {
    return G.minutes(a.started) - G.minutes(b.started);
  }

  // Returns a title with the find field's words marked, from the [start, end) spans Digest.matches gave.
  function titleHtml(s, hits) {
    var ranges = (hits && hits[s.id]) || [];
    var t = s.title;
    if (!ranges.length) return esc(t);
    var out = "";
    var at = 0;
    ranges.forEach(function (r) {
      if (r[0] < at) return;
      out += esc(t.slice(at, r[0])) + '<mark class="lbl-hit">' + esc(t.slice(r[0], r[1])) + "</mark>";
      at = r[1];
    });
    return out + esc(t.slice(at));
  }

  function face(s, size) {
    return Crew.face(s.title, { pose: s.pose === "waiting" || s.pose === "working" || s.pose === "asleep" ? s.pose : "idle", size: size });
  }

  // Returns how long a thread has been as it is now: working for (its turn's time), waiting for,
  // or resting since. One meaning for every row's right edge and the Table's Time column.
  function timeInState(s) {
    if (s.digest.phase === "queued") return "queued";
    if (s.pose === "working") return G.elapsed(s.digest.turnStartedAt) || G.ago(s.last);
    return G.ago(s.last);
  }

  function minutesInState(s) {
    var now = G.minutes(H.now);
    if (s.pose === "working" && s.digest.turnStartedAt) return now - G.minutes(s.digest.turnStartedAt);
    return now - G.minutes(s.last);
  }

  function projHtml(key, name) {
    var g = groupByKey(key);
    return '<span class="proj lbl-proj ' + (g && g.tint ? "proj--" + g.tint : "lbl-proj--none") + '">' + esc(name || (g ? g.name : key)) + "</span>";
  }

  // Returns Digest.rollupText with its "need you" part in marigold: the one color of a header.
  function rollupHtml(r) {
    return G.rollupText(r)
      .split(" · ")
      .map(function (part) {
        return /need/.test(part) ? '<span class="lbl-you">' + esc(part) + "</span>" : esc(part);
      })
      .join(" · ");
  }

  function stackHtml(list, size, max) {
    return (
      '<span class="stack lbl-stack">' +
      list
        .slice(0, max || 4)
        .map(function (s) {
          return face(s, size);
        })
        .join("") +
      "</span>"
    );
  }

  /* ------------------------------------------------------------------ filtering */

  function isFiltered() {
    return state.lens !== "all" || state.q.trim() !== "";
  }

  // Returns what the find field and the lens keep: the items, a set of their ids, and the title
  // spans to highlight, by id.
  function applyFilter() {
    var q = G.parseQuery(state.q);
    var kept = [];
    var ids = {};
    var hits = {};
    ALL.forEach(function (s) {
      var m = G.matches(s, q);
      if (m.ok && G.lens(s, state.lens)) {
        kept.push(s);
        ids[s.id] = true;
        hits[s.id] = m.ranges;
      }
    });
    var hiddenWaiting = ALL.filter(function (s) {
      return s.pose === "waiting" && !ids[s.id];
    });
    return { kept: kept, ids: ids, hits: hits, hiddenWaiting: hiddenWaiting };
  }

  // Returns each lens's count under the current query. All, Following and Mine count threads;
  // Needs you counts everything that waits on you, the run step too, as every waiting count does.
  function lensCounts() {
    var q = G.parseQuery(state.q);
    var counts = {};
    LENSES.forEach(function (l) {
      counts[l.id] = ALL.filter(function (s) {
        return (l.id === "needs-you" || !s.run) && G.lens(s, l.id) && G.matches(s, q).ok;
      }).length;
    });
    return counts;
  }

  function waitingFirst(list) {
    return list
      .filter(function (s) {
        return s.pose === "waiting";
      })
      .sort(function (a, b) {
        return G.minutes(a.last) - G.minutes(b.last);
      });
  }

  /*
   * Returns a group's pieces of work: each lead with its partners, as { lead, partners, context,
   * rank }. A partner whose lead is not in `threads` keeps that lead as a faint context row
   * (context: true), so a found partner is never shown without the work it belongs to.
   * `rank` is the most urgent pose in the piece: a piece rests only when all of its threads rest,
   * so a resting lead with a waiting partner stays out of the resting fold. Pieces sort by the
   * lead's own pose (waiting, working, resting), then by start time, so a row keeps its place.
   */
  function buildWork(threads) {
    var inList = {};
    threads.forEach(function (s) {
      inList[s.id] = true;
    });
    var pieces = {};
    var order = [];
    function pieceFor(lead, context) {
      if (!pieces[lead.id]) {
        pieces[lead.id] = { lead: lead, partners: [], context: context };
        order.push(pieces[lead.id]);
      }
      return pieces[lead.id];
    }
    threads.forEach(function (s) {
      if (!s.lead || !BY_ID[s.lead]) pieceFor(s, false);
    });
    threads.forEach(function (s) {
      if (s.lead && BY_ID[s.lead]) pieceFor(BY_ID[s.lead], !inList[s.lead]).partners.push(s);
    });
    order.forEach(function (p) {
      p.partners.sort(byStarted);
      var members = (p.context ? [] : [p.lead]).concat(p.partners);
      p.rank = Math.min.apply(null, members.map(function (s) { return URGENCY[s.pose]; }));
    });
    function leadRank(p) {
      return p.context ? p.rank : Math.min(URGENCY[p.lead.pose], 2);
    }
    return order.sort(function (a, b) {
      return leadRank(a) - leadRank(b) || byStarted(a.lead, b.lead);
    });
  }

  /* ------------------------------------------------------------------ words for one thread */

  // Returns who started a thread, as the peek panel's second line says it.
  function startedText(s) {
    if (s.run) return "Run of " + s.run.workflow + ", started " + s.run.started;
    var by = s.startedBy || "user";
    if (by === "user") return "Started by you at " + s.started;
    if (by.indexOf("assistant:") === 0) return "Started by " + by.slice(10) + " at " + s.started;
    // The Crew section names the lead, so the header only says who.
    if (by.indexOf("session:") === 0) return "Started by its lead at " + s.started;
    return "Started at " + s.started;
  }

  // Returns the honest sentence for a thread with no plan: what it does, where, for how long.
  function noPlanSentence(s) {
    var d = s.digest;
    var focus = G.focusLabel(s);
    if (d.phase === "queued") return "No plan. Queued for a free slot on " + s.machine + ".";
    if (s.pose === "working") return "No plan. " + G.phaseLabel(d.phase) + (focus ? " " + focus : "") + " for " + G.elapsed(d.turnStartedAt) + ", turn " + d.turnCount + ".";
    if (s.pose === "waiting") return "No plan. Waiting on you for " + G.ago(s.last) + (d.turnCount ? ", turn " + d.turnCount : "") + ".";
    return "No plan. Resting since " + s.last + ", after " + plural(d.turnCount, "turn", "turns") + ".";
  }

  // Returns the milestone ladder as a few words: how far it got and what is not done yet
  // ("committed, not pushed"), or "" when Hercule saw nothing happen.
  function ladderWords(s) {
    var ladder = G.milestoneLadder(s);
    var reached = -1;
    ladder.forEach(function (m, i) {
      if (m.state !== "todo") reached = i;
    });
    if (reached < 0) return "";
    var words = [];
    var pass = ladder[2];
    if (pass.state === "failed") words.push("tests fail");
    else if (pass.state === "unknown") words.push("tests ran");
    else if (pass.state === "done") words.push("tests pass");
    var top = ladder[reached];
    if (reached >= 3) words.push(top.key === "prOpen" ? top.label : top.label.toLowerCase());
    else if (reached === 0) words.push("changed");
    var next = ladder.slice(Math.max(reached + 1, 3)).filter(function (m) {
      return m.state === "todo";
    })[0];
    if (next && reached >= 2) words.push("not " + next.label.toLowerCase().replace("pr open", "in a PR yet"));
    return words.join(", ");
  }

  // Returns the three faint lines Outline shows when it zooms into a thread: progress, where, last check.
  function digestLines(s) {
    var d = s.digest;
    var progress = d.plan ? d.plan.done + " of " + d.plan.total + " steps" + (d.plan.current && d.plan.done < d.plan.total ? " · " + d.plan.current : "") : noPlanSentence(s);
    var ladder = ladderWords(s);
    if (ladder) progress += " · " + ladder;
    var w = G.where(s);
    var where = [w.focus ? '<span class="mono">' + esc(w.focus) + "</span>" : "", w.file && w.focus ? esc(w.file) : "", w.branch && w.branch !== "main" ? '<span class="mono">' + esc(w.branch) + "</span>" : "", w.machine ? "on " + esc(w.machine) : ""]
      .filter(Boolean)
      .join(" · ");
    var c = d.lastCheck;
    var check = c ? esc(G.checkText(s, true)) + ' · <span class="mono">' + esc(c.command) + "</span> at " + c.at : "No check ran yet";
    return [esc(progress), where || "No files yet", check];
  }

  /* ------------------------------------------------------------------ the sidebar */

  var PROVIDER_NAMES = { claude: "Claude Code", codex: "Codex", pi: "pi" };
  var SIDE_WAITING = 3; // rows Waiting on you shows before "n more"
  var SIDE_ROWS = 5; // rows each project shows before "n more threads"

  // Returns a sidebar row's second line as the book writes it: the branch and machine of a
  // worktree, else the provider, model and machine.
  function sideMeta(s) {
    if (s.branch && s.branch !== "main") return s.branch + " · " + s.machine;
    return [PROVIDER_NAMES[s.provider], s.model, s.machine].filter(Boolean).join(" · ");
  }

  function sideRowHtml(s) {
    var end = s.digest.phase === "queued" ? '<span class="side-age">queued</span>' : s.pose === "working" || s.pose === "waiting" ? Crew.mark(s.pose) : '<span class="side-age">' + esc(G.ago(s.last)) + "</span>";
    return (
      '<a class="side-row" href="#" data-side-open="' + s.id + '"><span class="side-text"><span class="side-name">' + esc(s.title) + '</span><span class="side-meta">' + esc(sideMeta(s)) + "</span></span>" +
      '<span class="side-end">' + end + "</span></a>"
    );
  }

  /*
   * Fills the book's sidebar (drawn by crew.js) with the heavy morning, in crew.js's own markup:
   * Waiting on you with its three newest and "n more", each project's five most urgent threads
   * (Digest.rollup's order) and "n more threads", the assistants, and the foot's counts. Every
   * count then agrees with the main pane's.
   */
  function drawSidebar() {
    var side = document.querySelector(".lb-list .side");
    if (!side) return;
    var waiting = ALL.filter(function (s) {
      return s.pose === "waiting";
    }).sort(function (a, b) {
      return G.minutes(b.last) - G.minutes(a.last);
    });
    var you = side.querySelector(".side-sec--you");
    you.outerHTML =
      '<section class="side-sec side-sec--you"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + waiting.length + "</b></h3>" +
      waiting.slice(0, SIDE_WAITING).map(function (s) {
        return '<a class="side-row side-row--wait" href="#" data-side-open="' + s.id + '">' + face(s, 24) + '<span class="side-text"><span class="side-name">' + esc(s.title) + '</span><span class="side-ask">' + esc(s.askShort || s.ask) + "</span></span></a>";
      }).join("") +
      (waiting.length > SIDE_WAITING ? '<a class="side-row side-row--more" href="#" data-side-waiting>' + (waiting.length - SIDE_WAITING) + " more waiting on you</a>" : "") +
      "</section>";
    var pane = side.querySelector('[data-pane="threads"]');
    pane.innerHTML =
      GROUPS.map(function (g) {
        var threads = H.sessions.filter(function (s) {
          return groupKeyOf(s) === g.key;
        });
        if (!threads.length) return "";
        var top = G.rollup(threads).faces.map(function (id) {
          return BY_ID[id];
        });
        return (
          '<section class="side-sec"><h3 class="side-h side-h--proj">' + projHtml(g.key, g.name) +
          '<a class="icon-btn icon-btn--sm" href="#" title="New thread in ' + esc(g.name) + '">' + Crew.icon("plus", 14) + "</a></h3>" +
          top.slice(0, SIDE_ROWS).map(sideRowHtml).join("") +
          (threads.length > SIDE_ROWS ? '<a class="side-row side-row--more" href="#" data-side-group="' + g.key + '">' + (threads.length - SIDE_ROWS) + " more threads</a>" : "") +
          "</section>"
        );
      }).join("") +
      '<section class="side-sec"><h3 class="side-h"><span>Assistants</span></h3>' +
      H.assistants.map(function (a) {
        return '<a class="side-row side-row--who" href="#">' + Crew.face(a.name, { pose: a.pose, size: 22 }) + '<span class="side-name">' + a.name + '</span><span class="side-end side-presence">' + Crew.poseWord(a.pose) + "</span></a>";
      }).join("") +
      "</section>";
    var r = G.rollup(ALL);
    side.querySelector(".side-sum").innerHTML = "<b>" + r.working + "</b> working · <b class=\"you-ink\">" + r.waiting + "</b> need you · <b>" + r.resting + "</b> resting";
    // The Hercule tab's Office row is this page: selected, and counting the live threads.
    var office = side.querySelector('.nav-row[href="office.html"]');
    if (office) {
      office.classList.add("is-on");
      var count = office.querySelector(".count");
      if (count) count.textContent = String(H.sessions.length);
    }
  }

  /* ------------------------------------------------------------------ the shell */

  var els = {};

  function buildShell() {
    var pane = document.querySelector("[data-lbl-pane]");
    els.main = document.querySelector("[data-lbl-main]");
    els.pane = pane;
    els.office = pane.querySelector("[data-lbl-office]");
    pane.insertAdjacentHTML(
      "afterbegin",
      '<header class="top lbl-top">' +
        '<nav class="pill lbl-modes" aria-label="How to see the work">' +
        '<button class="ptab" data-mode="office" aria-pressed="false">Office</button>' +
        '<button class="ptab" data-mode="list" aria-pressed="false">List</button>' +
        '<button class="ptab" data-mode="kanban" aria-pressed="false">Kanban</button>' +
        "</nav>" +
        '<span class="spacer"></span>' +
        '<span class="pill lbl-sum" data-lbl-sum aria-label="Who is doing what"></span>' +
        "</header>" +
        '<div class="lbl-band" data-lbl-band>' +
        '<label class="find find--box lbl-find">' + Crew.icon("search", 14) +
        '<input type="search" placeholder="Find a thread" aria-label="Find a thread" spellcheck="false" autocomplete="off" data-lbl-q /><kbd>⌘F</kbd></label>' +
        '<nav class="tabs lbl-lenses" aria-label="Lenses" data-lbl-lenses></nav>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn--quiet btn--sm lbl-view-btn" data-lbl-view aria-haspopup="true" aria-expanded="false">View' + Crew.icon("chev-d", 13) + "</button>" +
        "</div>" +
        '<div class="lbl-scroll" data-lbl-scroll><div class="lbl-body" data-lbl-body role="listbox" aria-label="Threads"></div></div>' +
        '<div class="lbl-board-host" data-lbl-board></div>',
    );
    els.main.insertAdjacentHTML("beforeend", '<aside class="lbl-peek" data-lbl-peek aria-label="Peek"></aside>');
    // Fixed layers live inside the window's root, so their rules stay scoped under .lb-list.
    document.querySelector(".lb-list").insertAdjacentHTML(
      "beforeend",
      '<div class="lbl-review" data-lbl-review role="toolbar" aria-label="Design review controls"></div>' +
        '<div class="pop lbl-view-pop" data-lbl-pop hidden></div>' +
        '<div class="lbl-toast" data-lbl-toast hidden></div>',
    );
    els.sum = pane.querySelector("[data-lbl-sum]");
    els.band = pane.querySelector("[data-lbl-band]");
    els.q = pane.querySelector("[data-lbl-q]");
    els.lenses = pane.querySelector("[data-lbl-lenses]");
    els.viewBtn = pane.querySelector("[data-lbl-view]");
    els.scroll = pane.querySelector("[data-lbl-scroll]");
    els.body = pane.querySelector("[data-lbl-body]");
    els.board = pane.querySelector("[data-lbl-board]");
    els.peek = els.main.querySelector("[data-lbl-peek]");
    els.review = document.querySelector("[data-lbl-review]");
    els.pop = document.querySelector("[data-lbl-pop]");
    els.toast = document.querySelector("[data-lbl-toast]");
    els.q.value = state.q;
  }

  function renderSum() {
    var r = G.rollup(ALL);
    els.sum.innerHTML =
      "<span>" + Crew.mark("working") + "<b>" + r.working + "</b> working</span>" +
      '<span class="lbl-sum-you">' + Crew.mark("waiting") + "<b>" + r.waiting + "</b> need you</span>" +
      "<span>" + Crew.mark("idle") + "<b>" + r.resting + "</b> resting</span>";
  }

  function renderModes() {
    els.pane.querySelectorAll("[data-mode]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
    });
    // Named apart from the buttons' data-mode, so a click inside the pane never reads as a switch.
    els.main.dataset.lblMode = state.mode;
    els.main.dataset.lblList = state.list;
    els.main.dataset.lblDensity = state.density;
  }

  function renderLenses() {
    var counts = lensCounts();
    els.lenses.innerHTML = LENSES.map(function (l) {
      var on = l.id === state.lens;
      return '<button class="tab' + (on ? " is-on" : "") + '" data-lens="' + l.id + '" aria-pressed="' + on + '">' + l.label + " <small>" + counts[l.id] + "</small></button>";
    }).join("");
    els.viewBtn.hidden = state.mode === "list" && state.list === "outline";
  }

  /* ------------------------------------------------------------------ Rows */

  function rowHtml(s, o, f) {
    var line = G.line(s);
    var partners = o.partners || 0;
    var cls = "lbl-row" + (o.partner ? " is-partner" : "") + (o.context ? " is-context" : "");
    var end = state.group === "none" && !o.inWaiting ? projHtml(groupKeyOf(s)) + '<span class="lbl-age">' + esc(timeInState(s)) + "</span>" : '<span class="lbl-age">' + esc(timeInState(s)) + "</span>";
    return (
      '<div class="' + cls + '" data-key="' + o.key + '" data-id="' + s.id + '" role="option">' +
      '<span class="lbl-face">' + face(s, 22) + "</span>" +
      '<span class="lbl-text"><span class="lbl-title"><span class="lbl-name">' + titleHtml(s, f.hits) + "</span>" +
      (partners ? '<button class="lbl-plus" data-fold="lead:' + s.id + '" title="Show its partners">+' + partners + "</button>" : "") +
      "</span>" +
      '<span class="lbl-line' + (line.tone === "you" ? " lbl-line--you" : "") + '">' + esc(line.text) + "</span></span>" +
      '<span class="lbl-end">' + end + "</span></div>"
    );
  }

  function foldLineHtml(key, faces, text, open) {
    return (
      '<div class="lbl-fold" data-key="' + key + '" data-fold="' + key + '" role="option">' +
      '<span class="lbl-fold-faces">' + stackHtml(faces, 20, 4) + "</span>" +
      '<span class="lbl-fold-text">' + text + ' · <span class="lbl-fold-act">' + (open ? "hide" : "show") + "</span></span></div>"
    );
  }

  function groupHeadHtml(g, r, opts) {
    var shut = !!state.shut[g.key];
    return (
      '<div class="lbl-head' + (opts && opts.first ? " is-first" : "") + '" data-head="' + g.key + '">' +
      '<button class="lbl-chev' + (shut ? " is-shut" : "") + '" data-shut="' + g.key + '" aria-expanded="' + !shut + '" title="' + (shut ? "Unfold " : "Fold ") + esc(g.name) + '">' + Crew.icon("chev-d", 14) + "</button>" +
      (g.key === "all" ? '<span class="lbl-head-name">All threads</span>' : projHtml(g.key, g.name)) +
      '<span class="lbl-head-sum">' + rollupHtml(r) + "</span></div>"
    );
  }

  function waitingHeadHtml(list, first) {
    var oldest = list.length ? G.ago(list[0].last) : "";
    return (
      '<div class="lbl-head lbl-head--you' + (first ? " is-first" : "") + '"><span class="lbl-head-name">Waiting on you</span><b class="count count--you">' + list.length + "</b>" +
      (oldest ? '<span class="lbl-head-sum">oldest ' + oldest + "</span>" : "") + "</div>"
    );
  }

  function hiddenNoteHtml(f) {
    var hidden = f.hiddenWaiting;
    if (!hidden.length) return "";
    var runs = hidden.filter(function (s) { return s.run; }).length;
    var threads = hidden.length - runs;
    var what = threads ? plural(threads, "waiting thread", "waiting threads") : "";
    if (runs) what += (what ? " and " : "") + plural(runs, "run step", "run steps");
    return '<div class="lbl-note">' + what + (hidden.length === 1 ? " is" : " are") + ' hidden by the filter · <button class="lbl-note-act" data-clear>Show</button></div>';
  }

  function emptyHtml() {
    return '<div class="lbl-empty">No thread matches ' + (state.q.trim() ? "“" + esc(state.q.trim()) + "”" : "this lens") + ".</div>";
  }

  function renderRows(f) {
    var filtered = isFiltered();
    var html = [hiddenNoteHtml(f)];
    var first = !html[0];
    var waiting = waitingFirst(f.kept);
    if (waiting.length) {
      html.push(waitingHeadHtml(waiting, first));
      first = false;
      var cap = filtered || state.open.more ? waiting.length : 3;
      waiting.forEach(function (s, i) {
        if (i < cap) html.push(rowHtml(s, { key: "w:" + s.id, inWaiting: true }, f));
      });
      if (waiting.length > 3 && !filtered) {
        var rest = waiting.slice(3);
        html.push(foldLineHtml("more", rest, plural(rest.length, "more needs you", "more need you").replace("1 more needs you", "1 more needs you"), state.open.more));
      }
    }
    var groups = state.group === "project" ? GROUPS : [{ key: "all", name: "All threads" }];
    groups.forEach(function (g) {
      var threads = f.kept.filter(function (s) {
        if (s.run) return false;
        if (filtered && s.pose === "waiting") return false;
        return g.key === "all" || groupKeyOf(s) === g.key;
      });
      if (!threads.length) return;
      html.push(groupHeadHtml(g, G.rollup(threads), { first: first }));
      first = false;
      if (state.shut[g.key]) return;
      var work = buildWork(threads);
      function pushPiece(w) {
        var showPartners = filtered || state.open["lead:" + w.lead.id];
        html.push(rowHtml(w.lead, { key: "p:" + w.lead.id, context: w.context, partners: showPartners ? 0 : w.partners.length }, f));
        if (showPartners) {
          w.partners.forEach(function (s) {
            html.push(rowHtml(s, { key: "p:" + s.id, partner: true }, f));
          });
        }
      }
      work.filter(function (w) { return w.rank <= 1; }).forEach(pushPiece);
      var resting = work.filter(function (w) { return w.rank > 1; });
      if (!resting.length) return;
      if (filtered) return resting.forEach(pushPiece);
      var restThreads = [];
      resting.forEach(function (w) {
        restThreads.push(w.lead);
        restThreads.push.apply(restThreads, w.partners);
      });
      var key = "rest:" + g.key;
      html.push(foldLineHtml(key, restThreads.slice().sort(function (a, b) { return G.minutes(b.last) - G.minutes(a.last); }), restThreads.length + " resting", state.open[key]));
      if (state.open[key]) resting.forEach(pushPiece);
    });
    if (!f.kept.length) html.push(emptyHtml());
    els.body.innerHTML = html.join("");
  }

  /* ------------------------------------------------------------------ Table */

  var COLUMNS = [
    { key: "mark", label: "" },
    { key: "thread", label: "Thread" },
    { key: "progress", label: "Progress" },
    { key: "where", label: "Where" },
    { key: "machine", label: "Machine" },
    { key: "time", label: "Time", num: true },
  ];

  // Returns the Progress cell: the plan's "4 of 7", else the phase word while it works, else the
  // furthest milestone Hercule saw.
  function progressCell(s) {
    var p = G.progress(s);
    if (p.kind === "plan") return { text: p.label, plan: true };
    if (s.pose === "working") return { text: G.phaseLabel(s.digest.phase), plan: false };
    return { text: p.label, plan: false };
  }

  function sortValue(s, key) {
    if (key === "thread") return s.title.toLowerCase();
    if (key === "progress") {
      var p = G.progress(s);
      return p.kind === "none" ? -1 : p.done / p.total;
    }
    if (key === "where") return G.focusLabel(s) || "~";
    if (key === "machine") return s.machine || "~";
    if (key === "time") return minutesInState(s);
    return 0;
  }

  function sortThreads(list) {
    if (!state.sort) return list;
    var k = state.sort.key;
    var dir = state.sort.dir;
    return list.slice().sort(function (a, b) {
      var x = sortValue(a, k);
      var y = sortValue(b, k);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || byStarted(a, b);
    });
  }

  function markOf(s) {
    if (s.pose === "waiting") return Crew.mark("waiting", 14);
    if (s.pose === "working") return Crew.mark("working", 14);
    return Crew.mark("idle", 14);
  }

  function trowHtml(s, o, f) {
    var prog = progressCell(s);
    var focus = G.focusLabel(s);
    return (
      '<div class="lbl-trow' + (o.partner ? " is-partner" : "") + (o.context ? " is-context" : "") + '" data-key="' + o.key + '" data-id="' + s.id + '" role="option">' +
      '<span class="lbl-tmark">' + markOf(s) + "</span>" +
      '<span class="lbl-tthread"><span class="lbl-name">' + titleHtml(s, f.hits) + "</span>" +
      (s.pose === "waiting" ? '<span class="lbl-task">' + esc(s.askShort || s.ask) + "</span>" : "") + "</span>" +
      '<span class="lbl-tprog' + (prog.plan ? " is-plan" : "") + '">' + esc(prog.text) + "</span>" +
      '<span class="lbl-twhere">' + (focus ? '<span class="mono">' + esc(focus) + "</span>" : "") + "</span>" +
      '<span class="lbl-tmach">' + esc(s.machine || "") + "</span>" +
      '<span class="lbl-ttime">' + esc(timeInState(s)) + "</span></div>"
    );
  }

  function renderTable(f) {
    var filtered = isFiltered();
    var heads =
      '<div class="lbl-theads">' +
      COLUMNS.map(function (c) {
        if (!c.label) return "<span></span>";
        var on = state.sort && state.sort.key === c.key;
        return '<button class="lbl-th lbl-th--' + c.key + (c.num ? " is-num" : "") + (on ? " is-on" : "") + '" data-sort="' + c.key + '">' + c.label + (on ? '<span class="lbl-th-dir">' + (state.sort.dir > 0 ? "↑" : "↓") + "</span>" : "") + "</button>";
      }).join("") +
      "</div>";
    var html = [heads, hiddenNoteHtml(f)];
    var first = !html[1];
    var waiting = waitingFirst(f.kept);
    if (waiting.length) {
      html.push(waitingHeadHtml(waiting, first));
      first = false;
      sortThreads(waiting).forEach(function (s) {
        html.push(trowHtml(s, { key: "w:" + s.id }, f));
      });
    }
    var groups = state.group === "project" ? GROUPS : [{ key: "all", name: "All threads" }];
    groups.forEach(function (g) {
      var threads = f.kept.filter(function (s) {
        if (s.run) return false;
        if (filtered && s.pose === "waiting") return false;
        return g.key === "all" || groupKeyOf(s) === g.key;
      });
      if (!threads.length) return;
      html.push(groupHeadHtml(g, G.rollup(threads), { first: first }));
      first = false;
      if (state.shut[g.key]) return;
      var work = buildWork(threads);
      if (state.sort) {
        var leads = sortThreads(work.map(function (w) { return w.lead; }));
        work.sort(function (a, b) { return leads.indexOf(a.lead) - leads.indexOf(b.lead); });
      }
      work.forEach(function (w) {
        html.push(trowHtml(w.lead, { key: "p:" + w.lead.id, context: w.context }, f));
        sortThreads(w.partners).forEach(function (s) {
          html.push(trowHtml(s, { key: "p:" + s.id, partner: true }, f));
        });
      });
    });
    if (!f.kept.length) html.push(emptyHtml());
    els.body.innerHTML = html.join("");
  }

  /* ------------------------------------------------------------------ Outline */

  // Returns the Outline's groups with their threads: Waiting on you first, then the projects.
  function outlineGroups(f) {
    var filtered = isFiltered();
    var out = [];
    var waiting = waitingFirst(f.kept);
    if (waiting.length) out.push({ key: "waiting", name: "Waiting on you", threads: waiting, waiting: true });
    GROUPS.forEach(function (g) {
      var threads = f.kept.filter(function (s) {
        return !s.run && groupKeyOf(s) === g.key && !(filtered && s.pose === "waiting");
      });
      if (threads.length) out.push({ key: g.key, name: g.name, threads: threads });
    });
    return out;
  }

  function olineHtml(s, o, f) {
    var line = G.line(s);
    var open = state.zoomThread === s.id;
    var html =
      '<div class="lbl-oline' + (o.partner ? " is-partner" : "") + (o.context ? " is-context" : "") + (open ? " is-zoomed" : "") + '" data-key="' + o.key + '" data-id="' + s.id + '" role="option" aria-expanded="' + open + '">' +
      '<span class="lbl-face">' + face(s, 20) + "</span>" +
      '<span class="lbl-otext"><span class="lbl-title"><span class="lbl-name">' + titleHtml(s, f.hits) + "</span>" +
      (o.partners ? '<span class="lbl-plus-quiet">+' + o.partners + "</span>" : "") + "</span>" +
      '<span class="lbl-line' + (line.tone === "you" ? " lbl-line--you" : "") + '">' + esc(line.text) + "</span></span>" +
      '<span class="lbl-age">' + esc(timeInState(s)) + "</span></div>";
    if (open) {
      html += '<div class="lbl-digest' + (o.partner ? " is-partner" : "") + '">' + digestLines(s).map(function (l) {
        return "<div>" + l + "</div>";
      }).join("") + "</div>";
    }
    return html;
  }

  function renderOutline(f) {
    var filtered = isFiltered();
    var html = [hiddenNoteHtml(f)];
    var openLead = state.zoomThread && BY_ID[state.zoomThread] ? BY_ID[state.zoomThread].lead || state.zoomThread : null;
    outlineGroups(f).forEach(function (g) {
      var open = filtered || state.zoom === g.key;
      var r = G.rollup(g.threads);
      var sum = g.waiting ? "oldest " + G.ago(g.threads[0].last) : rollupHtml(r);
      var faces = g.waiting ? g.threads : r.faces.map(function (id) { return BY_ID[id]; });
      html.push(
        '<div class="lbl-ogroup' + (open ? " is-open" : "") + (g.waiting ? " lbl-ogroup--you" : "") + '" data-key="g:' + g.key + '" data-group="' + g.key + '" role="option" aria-expanded="' + open + '">' +
          '<span class="lbl-chev' + (open ? "" : " is-shut") + '">' + Crew.icon("chev-d", 14) + "</span>" +
          (g.waiting ? '<span class="lbl-ogroup-name">Waiting on you</span><b class="count count--you">' + g.threads.length + "</b>" : g.key === "none" ? '<span class="lbl-ogroup-name">' + projHtml("none", "No project") + "</span>" : '<span class="lbl-ogroup-name">' + projHtml(g.key, g.name) + "</span>") +
          '<span class="lbl-ogroup-sum">' + sum + "</span>" +
          '<span class="spacer"></span>' + stackHtml(faces, 20, 5) + "</div>",
      );
      if (!open) return;
      if (g.waiting) {
        g.threads.forEach(function (s) {
          html.push(olineHtml(s, { key: "o:w:" + s.id }, f));
        });
        return;
      }
      var work = buildWork(g.threads);
      function pushPiece(w) {
        var showPartners = filtered || openLead === w.lead.id;
        html.push(olineHtml(w.lead, { key: "o:" + w.lead.id, context: w.context, partners: showPartners ? 0 : w.partners.length }, f));
        if (showPartners) w.partners.forEach(function (s) {
          html.push(olineHtml(s, { key: "o:" + s.id, partner: true }, f));
        });
      }
      work.filter(function (w) { return w.rank <= 1; }).forEach(pushPiece);
      var resting = work.filter(function (w) { return w.rank > 1; });
      if (!resting.length) return;
      if (filtered) return resting.forEach(pushPiece);
      var restThreads = [];
      resting.forEach(function (w) {
        restThreads.push(w.lead);
        restThreads.push.apply(restThreads, w.partners);
      });
      var key = "rest:" + g.key;
      html.push('<div class="lbl-ofold" data-key="' + key + '" data-fold="' + key + '" role="option"><span class="lbl-ofold-text">' + restThreads.length + " resting · " + (state.open[key] ? "hide" : "show") + "</span></div>");
      if (state.open[key]) resting.forEach(pushPiece);
    });
    if (!f.kept.length) html.push(emptyHtml());
    else if (!filtered && !state.zoom) html.push('<div class="lbl-ohint"><kbd>→</kbd> zooms into a line, <kbd>←</kbd> zooms out</div>');
    els.body.innerHTML = html.join("");
  }

  /* ------------------------------------------------------------------ the peek panel */

  function stepIcon(status) {
    if (status === "done") return '<span class="lbl-tick">' + Crew.icon("check", 12) + "</span>";
    if (status === "doing") return '<span class="lbl-dot lbl-dot--now"></span>';
    if (status === "failed") return '<span class="lbl-tick lbl-tick--fail">' + Crew.icon("close", 12) + "</span>";
    if (status === "unknown") return '<span class="lbl-dot lbl-dot--unknown"></span>';
    return '<span class="lbl-dot"></span>';
  }

  function peekSection(label, inner, note) {
    return '<section class="lbl-psec"><h3 class="lbl-ph"><span>' + label + "</span>" + (note ? '<span class="lbl-ph-note">' + note + "</span>" : "") + "</h3>" + inner + "</section>";
  }

  function askHtml(s) {
    var buttons =
      s.askKind === "approval"
        ? '<div class="lbl-pask-a"><button class="btn btn--accent btn--sm">Allow once</button><button class="btn btn--sm">Always allow</button><button class="btn btn--quiet btn--sm">Deny</button></div>'
        : '<label class="field lbl-pask-field"><input placeholder="Answer…" aria-label="Answer" /></label>';
    return '<div class="lbl-pask"><div class="lbl-pask-q">' + esc(s.ask) + '</div><div class="lbl-pask-since">Waiting on you since ' + s.last + " · " + G.ago(s.last) + "</div>" + buttons + "</div>";
  }

  function progressHtml(s) {
    var d = s.digest;
    if (s.run) {
      return peekSection("Progress", '<ol class="lbl-steps">' + s.run.steps.map(function (st) {
        var status = st.state === "completed" ? "done" : st.state === "waiting" || st.state === "running" ? "doing" : "todo";
        return '<li class="is-' + status + '">' + stepIcon(status) + "<span>" + esc(st.label) + "</span></li>";
      }).join("") + "</ol>", "run steps");
    }
    if (!d.plan) return peekSection("Progress", '<p class="lbl-psentence">' + esc(noPlanSentence(s)) + "</p>");
    return peekSection(
      "Progress",
      '<ol class="lbl-steps">' + d.plan.steps.map(function (st) {
        return '<li class="is-' + st.status + '">' + stepIcon(st.status) + "<span>" + esc(st.status === "doing" && d.plan.current ? d.plan.current : st.text) + "</span></li>";
      }).join("") + "</ol>",
      d.plan.done + " of " + d.plan.total + (d.plan.updatedAt ? " · updated " + d.plan.updatedAt : ""),
    );
  }

  function ladderHtml(s) {
    var c = s.digest.lastCheck;
    return peekSection(
      "Milestones",
      '<ol class="lbl-ladder">' + G.milestoneLadder(s).map(function (m) {
        var label = m.label;
        var note = m.at || "";
        if (m.state === "unknown") {
          label = "Passing";
          note = "ran, outcome not recognised";
        }
        if (m.state === "failed" && c && c.counts) note = c.counts + (m.at ? " · " + m.at : "");
        if (m.key === "passing" && m.state === "done" && c && c.counts && c.class === "test") note = c.counts + " · " + m.at;
        return '<li class="is-' + m.state + '">' + stepIcon(m.state) + "<span>" + esc(label) + '</span><span class="lbl-ladder-at">' + esc(note) + "</span></li>";
      }).join("") + "</ol>",
    );
  }

  function whereHtml(s) {
    var w = G.where(s);
    var f = s.digest.focus;
    var rows = [];
    if (f) {
      rows.push('<div class="lbl-pfocus"><span class="mono">' + esc(f.path) + "</span>" + (w.file ? '<span class="lbl-pfocus-file">hot file <span class="mono">' + esc(w.file) + "</span></span>" : "") + "</div>");
      var files = f.files
        .filter(function (x) { return x.path.indexOf("/") >= 0; })
        .sort(function (a, b) { return (a.how === "edit" ? 0 : 1) - (b.how === "edit" ? 0 : 1); });
      var shown = files.slice(0, 5);
      rows.push('<ul class="lbl-files">' + shown.map(function (x) {
        return '<li class="is-' + x.how + '"><span class="mono">' + esc(x.path) + '</span><span class="lbl-files-how">' + (x.how === "edit" ? "edited" + (x.times ? " ×" + x.times : "") : "read") + "</span></li>";
      }).join("") + (files.length > shown.length ? '<li class="lbl-files-more">' + plural(files.length - shown.length, "more file", "more files") + "</li>" : "") + "</ul>");
    } else {
      rows.push('<p class="lbl-psentence">' + (s.run ? "A run step has no files." : "No files yet: it has not read or edited anything in a checkout.") + "</p>");
    }
    var place = [
      w.branch ? Crew.icon("branch", 13) + '<span class="mono">' + esc(w.branch) + "</span>" : "",
      w.machine ? Crew.icon(w.machine === "studio-mac" ? "laptop" : "server", 13) + "<span>" + esc(w.machine) + "</span>" : "",
      s.provider ? Crew.brand(BRANDS[s.provider], 13) + "<span>" + esc(s.model) + "</span>" : "",
    ].filter(Boolean);
    if (place.length) rows.push('<div class="lbl-pplace">' + place.map(function (p) { return "<span>" + p + "</span>"; }).join("") + "</div>");
    return peekSection("Where", rows.join(""));
  }

  function checkHtml(s) {
    var c = s.digest.lastCheck;
    if (!c) return peekSection("Last check", '<p class="lbl-psentence">No test, typecheck, lint or build ran yet.</p>');
    return peekSection("Last check", '<div class="lbl-pcheck is-' + c.outcome + '">' + esc(G.checkText(s, true)) + '</div><div class="lbl-pcmd"><span class="mono">' + esc(c.command) + "</span></div>", c.at);
  }

  function crewHtml(s) {
    var leadId = s.lead || s.id;
    var team = H.teamOf(leadId);
    if (team.length < 2) return "";
    return peekSection(
      "Crew",
      '<ul class="lbl-crew">' + team.map(function (t) {
        var role = t.id === leadId ? "lead" : t.role || "partner";
        return '<li class="' + (t.id === s.id ? "is-self" : "") + '" data-pick="' + t.id + '">' + face(t, 16) + '<span class="lbl-crew-name">' + esc(t.title) + '</span><span class="lbl-crew-role">' + esc(role) + "</span></li>";
      }).join("") + "</ul>",
    );
  }

  function renderPeek() {
    var s = state.selected && BY_ID[state.selected];
    var on = !!(state.peek && s && state.mode !== "office");
    els.main.classList.toggle("is-peeking", on);
    if (!s) {
      els.peek.innerHTML = "";
      return;
    }
    var d = s.digest;
    var why = G.phaseLabel(d.phase) + ": " + d.phaseBasis;
    els.peek.innerHTML =
      '<div class="lbl-pscroll">' +
      '<header class="lbl-phead">' + face(s, 36) +
      '<div class="lbl-phead-text"><h2 class="lbl-ptitle">' + esc(s.title) + "</h2>" +
      '<div class="lbl-pmeta">' + projHtml(groupKeyOf(s), s.project || "No project") + "<span>" + esc(startedText(s)) + "</span></div></div>" +
      '<button class="icon-btn icon-btn--sm lbl-pclose" data-peek-close title="Close the peek (esc)">' + Crew.icon("close", 14) + "</button></header>" +
      (s.pose === "waiting" ? askHtml(s) : "") +
      progressHtml(s) +
      (s.run ? "" : ladderHtml(s)) +
      whereHtml(s) +
      (s.run ? "" : checkHtml(s)) +
      (s.run ? "" : crewHtml(s)) +
      peekSection("Why it is in this phase", '<p class="lbl-pwhy">' + esc(why) + "</p>") +
      "</div>" +
      '<footer class="lbl-pfoot">' +
      (s.run ? '<span class="lbl-pfoot-note">Runs are followed from Workflows</span>' : '<button class="lbl-follow" role="switch" aria-checked="' + !!s.following + '" data-follow>Follow<span class="toggle" aria-checked="' + !!s.following + '"></span><kbd>⇧F</kbd></button>') +
      '<span class="spacer"></span><button class="btn btn--sm" data-open-thread>Open ' + (s.run ? "run" : "thread") + "<kbd>↩</kbd></button></footer>";
  }

  /* ------------------------------------------------------------------ the Kanban */

  var board = null;

  function boardSessions(f) {
    return f.kept.filter(function (s) {
      return !s.run;
    });
  }

  // Returns what the board draws beyond threads: the run steps the filter kept and, with no
  // filter on, the Done today shelf. Done entries carry no digest, so the find field cannot match
  // them; under a filter the board counts them as hidden instead.
  function boardExtras(f) {
    var extras = {
      runs: f.kept
        .filter(function (s) {
          return s.run;
        })
        .map(function (s) {
          return s.run;
        }),
    };
    if (!isFiltered()) extras.doneToday = H.doneToday;
    return extras;
  }

  function renderBoard(f) {
    var B = window.LBViews && window.LBViews.board;
    if (state.mode !== "kanban") {
      if (board) {
        board.dispose();
        board = null;
      }
      els.board.innerHTML = "";
      return;
    }
    if (!B) {
      els.board.innerHTML = '<div class="lbl-board-wait">The Kanban mounts here once board.js is in place.</div>';
      return;
    }
    if (!board) {
      els.board.innerHTML = "";
      var extras = boardExtras(f);
      board = B.mount(els.board, {
        sessions: boardSessions(f),
        runs: extras.runs,
        doneToday: extras.doneToday,
        now: H.now,
        variant: state.board,
        swimlanes: state.lanes,
        selected: state.selected,
        onSelect: function (id) {
          select(id, { peek: true, from: "board" });
        },
        onOpen: openThread,
      });
      return;
    }
    board.update(boardSessions(f), boardExtras(f));
  }

  /* ------------------------------------------------------------------ the design-review bar and the View menu */

  function renderReview() {
    var theme = document.documentElement.dataset.theme === "orient-express" || document.documentElement.dataset.theme === "dark" ? "orient-express" : "whitehaven";
    function seg(name, value, label, on) {
      return '<button data-review="' + name + ":" + value + '" aria-pressed="' + on + '">' + label + "</button>";
    }
    els.review.innerHTML =
      '<span class="lbl-review-label">Design review</span>' +
      '<span class="lbl-review-group"><span class="lbl-review-k">List</span>' + seg("list", "rows", "Rows", state.list === "rows") + seg("list", "table", "Table", state.list === "table") + seg("list", "outline", "Outline", state.list === "outline") + "</span>" +
      '<span class="lbl-review-group"><span class="lbl-review-k">Kanban</span>' + seg("board", "state", "By state", state.board === "state") + seg("board", "phase", "By phase", state.board === "phase") + "</span>" +
      '<span class="lbl-review-group"><span class="lbl-review-k">Theme</span>' + seg("theme", "whitehaven", "Light", theme === "whitehaven") + seg("theme", "orient-express", "Dark", theme === "orient-express") + "</span>";
  }

  function renderPop() {
    function option(name, value, label) {
      var on = String(state[name]) === String(value);
      return '<button class="line" data-set="' + name + ":" + value + '"><span class="grow"><b>' + label + '</b></span><span class="lbl-pop-check">' + (on ? Crew.icon("check", 14) : "") + "</span></button>";
    }
    els.pop.innerHTML =
      state.mode === "kanban"
        ? '<div class="pop-sec"><div class="q-h">Swimlanes</div>' + option("lanes", "false", "None") + option("lanes", "project", "By project") + "</div>"
        : '<div class="pop-sec"><div class="q-h">Group by</div>' + option("group", "project", "Project") + option("group", "none", "None") + "</div>" +
          '<div class="pop-sec"><div class="q-h">Density</div>' + option("density", "comfortable", "Comfortable") + option("density", "compact", "Compact") + "</div>";
  }

  function togglePop(show) {
    var open = show === undefined ? els.pop.hidden : show;
    els.pop.hidden = !open;
    els.viewBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    renderPop();
    var r = els.viewBtn.getBoundingClientRect();
    els.pop.style.top = r.bottom + 6 + "px";
    els.pop.style.left = r.right - 200 + "px";
  }

  /* ------------------------------------------------------------------ drawing it all */

  var current = null; // the last filter result, for the keyboard

  function renderList() {
    current = applyFilter();
    renderLenses();
    if (state.mode === "list") {
      if (state.list === "rows") renderRows(current);
      else if (state.list === "table") renderTable(current);
      else renderOutline(current);
      markSelection();
    } else {
      els.body.innerHTML = "";
    }
    renderBoard(current);
    syncUrl();
  }

  function render() {
    renderModes();
    renderList();
    renderPeek();
    renderReview();
    syncUrl();
  }

  // Marks the selected thread's rows and the keyboard's line, without drawing the list again.
  function markSelection() {
    var lines = els.body.querySelectorAll("[data-key]");
    var cursorFound = false;
    lines.forEach(function (el) {
      if (el.dataset.key === state.cursor) cursorFound = true;
    });
    if (!cursorFound) {
      state.cursor = null;
      if (state.selected) {
        var first = els.body.querySelector('[data-id="' + state.selected + '"]');
        if (first) state.cursor = first.dataset.key;
      }
    }
    lines.forEach(function (el) {
      el.classList.toggle("is-on", !!state.selected && el.dataset.id === state.selected);
      el.classList.toggle("is-cursor", el.dataset.key === state.cursor && !el.dataset.id);
      el.setAttribute("aria-selected", String(!!state.selected && el.dataset.id === state.selected));
    });
  }

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.mode !== "list") p.set("mode", state.mode);
    if (state.list !== "rows") p.set("list", state.list);
    if (state.board !== "state") p.set("board", state.board);
    if (state.lanes) p.set("lanes", state.lanes);
    if (state.lens !== "all") p.set("lens", lensUrl(state.lens));
    if (state.q) p.set("q", state.q);
    if (state.group !== "project") p.set("group", state.group);
    if (state.density !== "comfortable") p.set("density", state.density);
    if (state.selected) p.set("select", state.selected);
    if (state.selected && !state.peek) p.set("peek", "0");
    if (state.zoom && state.list === "outline") p.set("zoom", state.zoom);
    var theme = document.documentElement.dataset.theme;
    if (theme && theme !== "whitehaven") p.set("theme", theme);
    var qs = p.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
  }

  function lensUrl(id) {
    for (var i = 0; i < LENSES.length; i++) if (LENSES[i].id === id) return LENSES[i].url;
    return "all";
  }

  /* ------------------------------------------------------------------ acting */

  // Opens folds so the selected thread has a row in the current List variant.
  function revealSelection() {
    var s = state.selected && BY_ID[state.selected];
    if (!s) return;
    var g = s.run ? null : groupKeyOf(s);
    if (state.list === "outline") {
      state.zoom = s.pose === "waiting" && (s.run || !g) ? "waiting" : g;
      state.zoomThread = s.id;
      return;
    }
    if (g) delete state.shut[g];
    if (state.list === "rows" && !s.run) {
      if (s.lead) state.open["lead:" + s.lead] = true;
      var lead = s.lead ? BY_ID[s.lead] : s;
      var team = H.teamOf(lead.id);
      var rank = Math.min.apply(null, team.map(function (t) { return URGENCY[t.pose]; }));
      if (rank > 1 && g) state.open["rest:" + g] = true;
    }
  }

  // Scrolls the list so a line is in view, by its own scrollTop: scrollIntoView would also
  // scroll a book that frames this page.
  function scrollToLine(el) {
    if (!el) return;
    var top = el.offsetTop;
    var heads = els.body.querySelector(".lbl-theads");
    var pad = heads ? heads.offsetHeight + 4 : 8;
    var view = els.scroll.clientHeight;
    if (top - pad < els.scroll.scrollTop) els.scroll.scrollTop = top - pad;
    else if (top + el.offsetHeight + 72 > els.scroll.scrollTop + view) els.scroll.scrollTop = top + el.offsetHeight + 72 - view;
  }

  function select(id, opts) {
    opts = opts || {};
    state.selected = id;
    if (opts.peek !== undefined) state.peek = opts.peek;
    if (opts.key) state.cursor = opts.key;
    else if (id) {
      var el = els.body.querySelector('[data-id="' + id + '"]');
      state.cursor = el ? el.dataset.key : null;
    }
    if (opts.from === "board" || opts.reveal) {
      revealSelection();
      if (state.mode === "list") renderList();
    }
    markSelection();
    if (board && opts.from !== "board") board.select(id);
    renderPeek();
    syncUrl();
  }

  function openThread(id) {
    var s = BY_ID[id || state.selected];
    if (!s) return;
    toast("Opens “" + s.title + "”" + (s.run ? " in Workflows" : ""));
  }

  var toastTimer = null;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    els.toast.classList.remove("is-out");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.add("is-out");
      toastTimer = setTimeout(function () {
        els.toast.hidden = true;
      }, 220);
    }, 1600);
  }

  // Data that changes under the list (following a thread) waits while the pointer is over the
  // list, so no row moves under it; the list is drawn again when the pointer leaves.
  var pointerInList = false;
  var pendingList = false;
  function renderListSoon() {
    if (pointerInList) pendingList = true;
    else renderList();
  }

  function toggleFollow() {
    var s = state.selected && BY_ID[state.selected];
    if (!s || s.run) return;
    s.following = !s.following;
    renderPeek();
    renderLenses();
    renderListSoon();
    toast(s.following ? "Following “" + s.title + "”" : "No longer following “" + s.title + "”");
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    togglePop(false);
    render();
  }

  function setVariant(list) {
    state.list = list;
    state.mode = "list";
    revealSelection();
    els.scroll.scrollTop = 0;
    render();
    scrollToLine(els.body.querySelector(".is-on"));
  }

  /* ------------------------------------------------------------------ the keyboard */

  function walkLines() {
    return Array.prototype.slice.call(els.body.querySelectorAll("[data-key]"));
  }

  function move(delta) {
    if (state.mode !== "list") return;
    var lines = walkLines();
    if (!lines.length) return;
    var at = -1;
    lines.forEach(function (el, i) {
      if (el.dataset.key === state.cursor) at = i;
    });
    var next = at < 0 ? (delta > 0 ? 0 : lines.length - 1) : Math.max(0, Math.min(lines.length - 1, at + delta));
    var el = lines[next];
    state.cursor = el.dataset.key;
    if (el.dataset.id) {
      state.selected = el.dataset.id;
      if (state.list === "outline" && state.zoomThread && state.zoomThread !== el.dataset.id) {
        // At the digest level, the digest follows the keyboard from thread to thread.
        state.zoomThread = el.dataset.id;
        renderList();
        el = els.body.querySelector('[data-key="' + state.cursor + '"]');
      }
    }
    markSelection();
    renderPeek();
    scrollToLine(el);
    syncUrl();
  }

  function cursorLine() {
    return state.cursor ? els.body.querySelector('[data-key="' + state.cursor + '"]') : null;
  }

  // → zooms in: a group opens, a thread shows its digest (Outline) or its partners (Rows).
  function zoomIn() {
    var el = cursorLine();
    if (!el || state.mode !== "list") return;
    if (state.list === "outline") {
      if (el.dataset.group) {
        state.zoom = el.dataset.group;
        state.zoomThread = null;
        renderList();
        var firstThread = els.body.querySelector('[data-group="' + state.zoom + '"] ~ [data-id]');
        if (firstThread) select(firstThread.dataset.id, { key: firstThread.dataset.key });
        return;
      }
      if (el.dataset.fold) return toggleFold(el.dataset.fold);
      if (el.dataset.id) {
        state.zoomThread = el.dataset.id;
        renderList();
        scrollToLine(cursorLine());
      }
      return;
    }
    if (el.dataset.fold) {
      if (!state.open[el.dataset.fold]) toggleFold(el.dataset.fold);
      return;
    }
    if (state.list === "rows" && el.dataset.id && el.querySelector(".lbl-plus")) toggleFold("lead:" + el.dataset.id);
  }

  // ← zooms out: a digest closes, then the group folds and the keyboard goes back to its line.
  function zoomOut() {
    var el = cursorLine();
    if (state.mode !== "list") return;
    if (state.list === "outline") {
      if (state.zoomThread) {
        state.zoomThread = null;
        renderList();
        return;
      }
      if (state.zoom) {
        var g = state.zoom;
        state.zoom = null;
        state.cursor = "g:" + g;
        renderList();
        return;
      }
      return;
    }
    if (state.list === "rows" && el && el.dataset.id) {
      var s = BY_ID[el.dataset.id];
      if (s.lead && state.open["lead:" + s.lead]) {
        delete state.open["lead:" + s.lead];
        state.selected = s.lead;
        state.cursor = "p:" + s.lead;
        renderList();
        renderPeek();
      } else if (state.open["lead:" + s.id]) toggleFold("lead:" + s.id);
    }
  }

  function toggleFold(key) {
    if (state.open[key]) delete state.open[key];
    else state.open[key] = true;
    renderList();
  }

  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  }

  function onKey(e) {
    var inFind = e.target === els.q;
    if (e.key === "Escape") {
      if (!els.pop.hidden) return togglePop(false);
      if (inFind) els.q.blur();
      if (state.q) return clearFilter(false);
      if (inFind) return;
      if (state.peek) {
        state.peek = false;
        renderPeek();
        syncUrl();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      els.q.focus();
      els.q.select();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘1-⌘9 and the rest stay the app's
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      return move(e.key === "ArrowDown" ? 1 : -1);
    }
    if (e.key === "Enter") {
      if (inFind && !state.selected) return move(1);
      var el = cursorLine();
      if (el && el.dataset.fold) return toggleFold(el.dataset.fold);
      if (el && el.dataset.group) return state.zoom === el.dataset.group ? zoomOut() : zoomIn();
      if (state.selected) openThread();
      return;
    }
    if (isTyping(e)) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      return zoomIn();
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      return zoomOut();
    }
    if (e.key === " ") {
      e.preventDefault();
      if (!state.selected) return;
      state.peek = !state.peek;
      renderPeek();
      syncUrl();
      return;
    }
    if (e.key === "F" && e.shiftKey) {
      e.preventDefault();
      return toggleFollow();
    }
    // Any other printable key starts a query: typing anywhere goes to the find field.
    if (e.key.length === 1 && state.mode !== "office") {
      e.preventDefault();
      els.q.focus();
      els.q.value += e.key;
      onQuery();
    }
  }

  // Clears the query (and the lens too, when asked), then opens folds so the selected thread is
  // still in view: clearing a filter should never lose the user's place.
  function clearFilter(lensToo) {
    state.q = "";
    els.q.value = "";
    if (lensToo) state.lens = "all";
    revealSelection();
    renderList();
    syncUrl();
    scrollToLine(els.body.querySelector(".is-on"));
  }

  function onQuery() {
    state.q = els.q.value;
    state.cursor = null;
    renderList();
    syncUrl();
  }

  /* ------------------------------------------------------------------ the pointer */

  function onClick(e) {
    var t = e.target;
    var hit;
    if ((hit = t.closest("[data-side-open]"))) {
      e.preventDefault();
      return openThread(hit.dataset.sideOpen);
    }
    if ((hit = t.closest("[data-side-waiting]"))) {
      // "n more waiting on you" opens the overview on the Needs you lens.
      e.preventDefault();
      state.mode = "list";
      state.lens = "needs-you";
      state.q = "";
      els.q.value = "";
      render();
      return;
    }
    if ((hit = t.closest("[data-side-group]"))) {
      e.preventDefault();
      state.mode = "list";
      state.lens = "all";
      state.q = "project:" + hit.dataset.sideGroup;
      els.q.value = state.q;
      render();
      return;
    }
    if ((hit = t.closest("[data-mode]"))) return setMode(hit.dataset.mode);
    if ((hit = t.closest("[data-lens]"))) {
      state.lens = hit.dataset.lens;
      state.cursor = null;
      renderList();
      syncUrl();
      return;
    }
    if ((hit = t.closest("[data-lbl-view]"))) return togglePop();
    if ((hit = t.closest("[data-set]"))) {
      var kv = hit.dataset.set.split(":");
      state[kv[0]] = kv[1] === "false" ? false : kv[1];
      if (kv[0] === "lanes" && board) board.setSwimlanes(state.lanes);
      togglePop(false);
      render();
      return;
    }
    if (!els.pop.hidden && !t.closest("[data-lbl-pop]")) togglePop(false);
    if ((hit = t.closest("[data-review]"))) {
      var rv = hit.dataset.review.split(":");
      if (rv[0] === "list") return setVariant(rv[1]);
      if (rv[0] === "board") {
        state.board = rv[1];
        state.mode = "kanban";
        if (board) board.setVariant(state.board);
        render();
        return;
      }
      if (rv[0] === "theme") {
        document.documentElement.dataset.theme = rv[1];
        renderReview();
        syncUrl();
      }
      return;
    }
    if ((hit = t.closest("[data-clear]"))) return clearFilter(true);
    if ((hit = t.closest("[data-sort]"))) {
      var key = hit.dataset.sort;
      if (state.sort && state.sort.key === key) state.sort = state.sort.dir > 0 ? { key: key, dir: -1 } : null;
      else state.sort = { key: key, dir: key === "time" || key === "progress" ? -1 : 1 };
      renderList();
      return;
    }
    if ((hit = t.closest("[data-shut]"))) {
      var g = hit.dataset.shut;
      if (state.shut[g]) delete state.shut[g];
      else state.shut[g] = true;
      renderList();
      return;
    }
    if ((hit = t.closest("[data-peek-close]"))) {
      state.peek = false;
      renderPeek();
      syncUrl();
      return;
    }
    if ((hit = t.closest("[data-follow]"))) return toggleFollow();
    if ((hit = t.closest("[data-open-thread]"))) return openThread();
    if ((hit = t.closest("[data-pick]"))) return select(hit.dataset.pick, { peek: true, reveal: true });
    if ((hit = t.closest(".lbl-plus"))) {
      e.stopPropagation();
      return toggleFold(hit.dataset.fold);
    }
    if ((hit = t.closest("[data-group]"))) {
      state.cursor = hit.dataset.key;
      state.zoom = state.zoom === hit.dataset.group ? null : hit.dataset.group;
      state.zoomThread = null;
      renderList();
      syncUrl();
      return;
    }
    if ((hit = t.closest("[data-fold]"))) {
      state.cursor = hit.dataset.key;
      return toggleFold(hit.dataset.fold);
    }
    if ((hit = t.closest("[data-lbl-body] [data-id]"))) {
      var id = hit.dataset.id;
      if (state.list === "outline") {
        // In the Outline a click zooms in place; the peek opens only with space.
        state.zoomThread = state.zoomThread === id ? null : id;
        state.selected = id;
        state.cursor = hit.dataset.key;
        renderList();
        renderPeek();
        syncUrl();
        return;
      }
      return select(id, { key: hit.dataset.key, peek: true });
    }
  }

  function onDoubleClick(e) {
    var hit = e.target.closest("[data-lbl-body] [data-id]");
    if (hit) openThread(hit.dataset.id);
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    drawSidebar();
    buildShell();
    // ?review=0 hides the design-review bar, for clean captures.
    els.review.hidden = params.get("review") === "0";
    renderSum();
    var sel = params.get("select");
    if (sel && BY_ID[sel]) {
      state.selected = sel;
      state.peek = params.get("peek") !== "0" && !(state.list === "outline" && params.get("peek") !== "1");
    }
    var zoom = params.get("zoom");
    if (zoom && (zoom === "waiting" || groupByKey(zoom))) {
      state.zoom = zoom;
      if (sel && BY_ID[sel] && (zoom === "waiting" ? BY_ID[sel].pose === "waiting" : groupKeyOf(BY_ID[sel]) === zoom)) state.zoomThread = sel;
    } else if (state.selected) revealSelection();
    render();
    if (state.selected) scrollToLine(els.body.querySelector(".is-on"));

    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    document.addEventListener("dblclick", onDoubleClick);
    els.q.addEventListener("input", onQuery);
    // A hairline under the find band once rows scroll beneath it; the Table's heads draw their own.
    els.scroll.addEventListener(
      "scroll",
      function () {
        els.band.classList.toggle("is-scrolled", els.scroll.scrollTop > 0 && state.list !== "table");
      },
      { passive: true },
    );
    els.scroll.addEventListener("mouseenter", function () {
      pointerInList = true;
    });
    els.scroll.addEventListener("mouseleave", function () {
      pointerInList = false;
      if (pendingList) {
        pendingList = false;
        renderList();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
