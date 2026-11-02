// PROTOTYPE - Gazette, "the morning paper of your agents". The window: the sidebar (The Wire), the
// overview with its three modes (Office · Threads · Front Page), the selection card, Catch up and
// the states. Every rule in gazette.css is scoped under .ov-gazette; every class here is gz-.
//
// The idea in one line: every thread keeps a "since you looked" mark, every turn ends with a
// one-line headline, and the overview is a newspaper of the work, ranked by what matters.
//
// A story is one piece of work: a lead and the partners it works with, a lone thread, a thread an
// assistant started, or the run step that waits on Rogier. A story is
//   - in Needs you while one of its threads waits on Rogier,
//   - in News while it has something Rogier has not read (bold, with an ink dot), or while one of
//     its threads is still working (a developing story, in regular weight),
//   - in Quiet when it is idle and read.
// Only Needs you is counted. Quiet is not a debt.
//
// Keys: ⌘⇧O opens and closes the overview; ⌥1 Office, ⌥2 Threads, ⌥3 Front Page; J and K walk the
// stories; ↩ opens one; E marks it Done; S snoozes it until something new happens; C starts Catch
// up; esc stops Catch up, then closes the overview.
(function () {
  "use strict";

  var W = window.WORLD;
  var H = W.helpers;
  var G = window.GAZETTE;
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var STATE = root.dataset.state || "everyday";
  // The away reading: Rogier left at 09:01 and is back at 09:41. The replay rewinds that morning too.
  var AWAY = /^(away|edition|catchup|caughtup|replay)$/.test(STATE);
  var SWARM = STATE === "swarm";
  var NOW = W.now;
  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var MODES = ["office", "threads", "front-page"];
  var MODE_NAMES = { office: "Office", threads: "Threads", "front-page": "Front Page" };

  /* ================================================================== the threads */

  var runStep = G.runStep;

  /** Returns every thread this window knows by id, live or done, or undefined. */
  function getThread(id) {
    var lists = [W.threads, W.swarm.threads, W.assistantThreads, [runStep], W.done, [W.spawn.thread]];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) if (lists[i][j].id === id) return lists[i][j];
    }
    return undefined;
  }

  // What changed in this window: answers, arrivals, Done and snoozes.
  var RT = { extra: {}, ended: {}, done: {}, snoozed: {}, answered: {} };

  /** Returns the live threads in view: the morning's, the swarm's in the swarm state, the assistants' and the run step. */
  function listLive() {
    return W.threads
      .concat(SWARM ? W.swarm.threads : [], W.assistantThreads, [runStep])
      .filter(function (t) { return !RT.done[t.id]; });
  }

  // The "since you looked" marks of this reading: the morning's, or the away reading's (Rogier
  // left at 09:01 and is back at 09:41, WORLD.away).
  var seen = {};
  var seenSource = AWAY ? W.away.lastSeen : W.lastSeen;
  Object.keys(seenSource).forEach(function (id) { seen[id] = seenSource[id]; });

  function isAfter(at, mark) {
    return mark == null || H.minutes(at) > H.minutes(mark);
  }

  /** Returns a thread's headlines, oldest first: the world's, then this window's. A "so far" line is dropped once its turn has ended. */
  function listHeadlines(id) {
    var base = W.headlines[id] || G.runHeadlines[id] || [];
    if (RT.ended[id]) base = base.filter(function (h) { return !h.running; });
    return base.concat(RT.extra[id] || []);
  }

  function describeAgent(t) {
    return W.providers[t.provider].name + " · " + t.model;
  }

  function faceName(t) {
    return t.isRunStep ? "Ship release v2.15" : t.title;
  }

  function drawFace(t, size, pose) {
    return Crew.face(faceName(t), { pose: pose || t.pose, size: size });
  }

  function drawBrand(t, size) {
    return Crew.brand(W.providers[t.provider].brand, size || 12);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /** Returns a time as the paper prints it: "09:34", "Yesterday 21:41", "Mon 16:02". */
  function formatClock(at) {
    var p = String(at).split(" ");
    if (p.length === 1) return at;
    return (p[0] === "yesterday" ? "Yesterday" : p[0]) + " " + p[1];
  }

  /** Returns a time as a row's right edge shows it: "09:34", "Yesterday", "Mon". */
  function formatRowTime(at) {
    var p = String(at).split(" ");
    if (p.length === 1) return at;
    return p[0] === "yesterday" ? "Yesterday" : p[0];
  }

  function formatTokens(n) {
    if (n >= 1e6) return (Math.round(n / 1e5) / 10).toFixed(1) + "M";
    return Math.round(n / 1000) + "k";
  }

  function formatNumber(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function formatElapsed(s) {
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m ? m + "m " : "") + (m ? String(r).padStart(2, "0") : r) + "s";
  }

  /* ================================================================== stories */

  /** Returns a lead and its partners, lead first, among the live threads. */
  function listTeam(leadId) {
    var lead = getThread(leadId);
    return [lead].concat(
      listLive().filter(function (t) { return t.lead === leadId; })
    );
  }

  /**
   * Builds the story of one piece of work: what it says since Rogier looked, what it asks, where
   * it belongs in the Wire, and the line a row shows. Returns null for a lead that is done.
   */
  function buildStory(leadId) {
    var members = listTeam(leadId);
    var lead = members[0];
    if (!lead || RT.done[leadId]) return null;
    var ids = members.map(function (m) { return m.id; });
    var items = [];
    members.forEach(function (m) {
      listHeadlines(m.id).forEach(function (h) {
        var kind = h.you ? "you" : h.running ? "sofar" : h.end === "request" ? "request" : "headline";
        items.push({ at: h.at, text: h.text, by: m, kind: kind, unread: (kind === "headline" || kind === "request") && isAfter(h.at, seen[m.id]) });
      });
    });
    W.exchanges.forEach(function (e) {
      var fi = ids.indexOf(e.from);
      var ti = ids.indexOf(e.to);
      if (fi === -1 || ti === -1) return;
      // A partner's report and the headline that ends the same turn are one piece of news, not
      // two: the headline stays, and keeps the report's own words for the quote.
      var turn = (W.turns[e.from] || []).filter(function (sp) {
        return sp.to != null && H.minutes(sp.from) <= H.minutes(e.at) && H.minutes(e.at) <= H.minutes(sp.to);
      })[0];
      var same = turn && items.filter(function (i) { return i.by.id === e.from && i.at === turn.to && i.kind === "headline"; })[0];
      if (same && e.kind === "report") {
        same.reportedTo = members[ti];
        same.reportText = e.text;
        same.reportAt = e.at;
        return;
      }
      items.push({ at: e.at, text: e.text, by: members[fi], to: members[ti], kind: e.kind, unread: e.kind === "report" && isAfter(e.at, seen[e.to]) });
    });
    items.sort(function (a, b) { return H.minutes(a.at) - H.minutes(b.at); });

    var asks = members.filter(function (m) { return m.pose === "waiting" && m.ask; });
    var unreadItems = items.filter(function (i) { return i.unread; });
    var working = members.some(function (m) { return m.pose === "working"; });
    var section = asks.length ? "needs" : unreadItems.length || working ? "news" : "quiet";

    // The row's line: the newest unread news, else the newest "so far", else the newest headline.
    var pick =
      unreadItems.filter(function (i) { return i.kind !== "brief"; }).slice(-1)[0] ||
      items.filter(function (i) { return i.kind === "sofar"; }).slice(-1)[0] ||
      items.filter(function (i) { return i.kind === "headline" || i.kind === "you"; }).slice(-1)[0] ||
      null;
    var newest = items.filter(function (i) { return i.unread || i.kind === "sofar" || i.kind === "you"; }).slice(-1)[0] || items.slice(-1)[0];
    var askAt = asks.length ? asks[0].last : null;
    var meta = G.story[leadId] || {};
    var speaker = asks[0] || (pick && pick.by) || lead;
    var project = lead.project ? W.projects.filter(function (p) { return p.id === lead.project; })[0] : null;

    return {
      id: leadId,
      lead: lead,
      members: members,
      items: items,
      asks: asks,
      unread: unreadItems.length > 0,
      unreadCount: unreadItems.length,
      working: working,
      section: section,
      line: pick,
      speaker: speaker,
      time: newest ? newest.at : lead.last,
      askAt: askAt,
      head: meta.head || lead.title,
      kicker: meta.kicker || "",
      weight: meta.weight || 30,
      project: project,
      isRun: !!lead.isRunStep,
    };
  }

  /** Returns every story in view, keyed by lead id. */
  function buildStories() {
    var out = {};
    listLive().forEach(function (t) {
      var id = t.lead || t.id;
      if (out[id] !== undefined || RT.snoozed[id]) return;
      var s = buildStory(id);
      if (s) out[id] = s;
    });
    return out;
  }

  /** Returns the Wire's layout: story ids per section, in the order each section sorts. */
  function computeLayout(stories) {
    var list = Object.keys(stories).map(function (k) { return stories[k]; });
    function by(section) {
      return list.filter(function (s) { return s.section === section; });
    }
    var newestFirst = function (a, b) {
      return H.minutes(b.time) - H.minutes(a.time) || (b.unread ? 1 : 0) - (a.unread ? 1 : 0);
    };
    var needs = by("needs").sort(function (a, b) {
      if (a.isRun !== b.isRun) return a.isRun ? 1 : -1;
      return H.minutes(a.askAt) - H.minutes(b.askAt);
    });
    return {
      needs: needs.map(function (s) { return s.id; }),
      news: by("news").sort(newestFirst).map(function (s) { return s.id; }),
      quiet: by("quiet").sort(newestFirst).map(function (s) { return s.id; }),
    };
  }

  /**
   * Returns the stories Catch up walks, in order of importance: what waits on Rogier, oldest ask
   * first; then every story with unread news, by the edition's weight.
   */
  function listCatchup(stories) {
    var list = Object.keys(stories).map(function (k) { return stories[k]; });
    var needs = list.filter(function (s) { return s.section === "needs"; }).sort(function (a, b) {
      return H.minutes(a.askAt) - H.minutes(b.askAt);
    });
    var rest = list.filter(function (s) { return s.section !== "needs" && s.unread; }).sort(function (a, b) {
      return b.weight - a.weight;
    });
    return needs.concat(rest).map(function (s) { return s.id; });
  }

  /** Returns how many stories wait on Rogier. */
  function countNeeds(stories) {
    return Object.keys(stories).filter(function (k) { return stories[k].section === "needs"; }).length;
  }

  /* ================================================================== the window's state */

  var api; // the Stage's API
  var stories = {};
  var layout = null; // the layout the lists show; kept while the pointer is in a list
  var pointerIn = false;
  var pending = []; // arrivals held back while the pointer is in a list
  var sel = null; // the selected thread id
  var overviewOpen = false;
  var mode = "threads";
  var edition = "morning";
  var catchup = null; // { list, i, started, elapsedBase, tally }
  var cardOn = true; // on the Front Page the card waits for a pick, so it never covers the paper unasked
  var els = {};
  var office = { handle: null, loading: false, failed: false };

  function storyOfThread(id) {
    var t = getThread(id);
    if (!t) return null;
    var lead = t.lead || t.id;
    return stories[lead] || (RT.done[lead] || RT.snoozed[lead] ? null : buildStory(lead));
  }

  /** Returns the thread a story's row stands for: the one that asks Rogier, else the lead. */
  function primaryOf(s) {
    return (s.asks[0] || s.lead).id;
  }

  function selectedStory() {
    return sel ? storyOfThread(sel) : null;
  }

  /** Recomputes the stories; the layout follows unless the pointer is in a list. */
  function refresh() {
    stories = buildStories();
    var next = computeLayout(stories);
    if (!pointerIn || !layout) layout = next;
    else {
      // Keep every row where it is; drop only the ones that left the world (Done, snoozed).
      ["needs", "news", "quiet"].forEach(function (k) {
        layout[k] = layout[k].filter(function (id) { return !!stories[id]; });
      });
      // A story that is new to the layout (an undo) waits with the arrivals.
    }
    drawAll();
  }

  function drawAll() {
    drawSidebar();
    drawFoot();
    if (overviewOpen) {
      drawTop();
      if (mode === "threads") drawThreads();
      if (mode === "front-page") drawFront();
      drawCard();
    }
  }

  /* ================================================================== the Wire (sidebar) */

  /** Returns the right edge of a row: { kind, text }. */
  function decideSlot(s) {
    if (s.asks.length) {
      var a = s.asks[0];
      return a.isRunStep ? { kind: "you", text: "Approval" } : { kind: "you", text: a.status === "approval" ? "Approval" : "Question" };
    }
    if (s.unread) return { kind: "time", text: formatRowTime(s.items.filter(function (i) { return i.unread; }).slice(-1)[0].at) };
    if (s.working) return { kind: "working", text: "Working" };
    return { kind: "faint", text: formatRowTime(s.time) };
  }

  /** Returns the markup of a row's line 2: the ask, the headline that is news, or "so far". */
  function drawLine(s, wide) {
    if (s.asks.length) {
      var a = s.asks[0];
      var who = a.id !== s.lead.id && a.role ? '<b class="gz-asker">' + esc(a.role) + "</b> asks · " : "";
      return '<span class="gz-line gz-line--ask">' + who + esc(wide ? a.ask : a.askShort) + "</span>";
    }
    if (!s.line) return '<span class="gz-line"></span>';
    var by = s.line.by;
    var role = by.id !== s.lead.id && by.role ? '<b class="gz-role">' + esc(by.role) + "</b> · " : "";
    return '<span class="gz-line gz-line--' + s.line.kind + '">' + role + esc(s.line.text) + "</span>";
  }

  /** Returns the crew dots of a story with partners: one per thread, in the state colors. */
  function drawDots(s) {
    if (s.members.length < 2) return "";
    return (
      '<span class="gz-dots" aria-label="' + s.members.length + ' threads">' +
      s.members.map(function (m) {
        var k = m.pose === "waiting" ? "waiting" : m.status === "queued" ? "queued" : m.pose === "working" ? "working" : "quiet";
        return '<i class="gz-dot gz-dot--' + k + '"></i>';
      }).join("") +
      "</span>"
    );
  }

  /** Returns a sidebar row: today's 52px row, with the headline as line 2. A lone thread with nothing new looks as it does today. */
  function drawRow(s) {
    var slot = decideSlot(s);
    var on = sel && storyOfThread(sel) === s;
    var glyphFrom = s.asks[0] || (s.line && s.line.by) || s.lead;
    return (
      '<div class="st-thread gz-row' + (s.unread ? " is-unread" : "") + (s.section === "quiet" ? " is-quiet" : "") + (s.members.length > 1 ? " has-crew" : "") + (s.fresh ? " is-fresh" : "") + '" data-story="' + s.id + '">' +
      '<a class="side-row' + (on ? " is-on" : "") + '" href="#" data-row="' + s.id + '">' +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name">' + esc(s.lead.title) + '</span><span class="side-end gz-end--' + slot.kind + '">' + slot.text + "</span></span>" +
      '<span class="st-detail"><span class="st-glyph">' + drawBrand(glyphFrom, 12) + "</span>" + drawLine(s, false) + "</span>" +
      "</span></a>" +
      (s.unread ? '<i class="gz-ink" role="img" aria-label="new since you looked"></i>' : "") +
      drawDots(s) +
      "</div>"
    );
  }

  /**
   * Returns the pill of stories held back while the pointer is in a list. It sits in the header
   * of News, where they will land, so it covers no row and moves none; the header sticks while
   * the list scrolls inside News.
   */
  function drawPill() {
    if (!pending.length) return "";
    return '<button class="gz-pill" type="button" data-flush title="Show them now"><i class="gz-pill-dot"></i>' + pending.length + " new</button>";
  }

  /** Draws the sidebar's list: Needs you, News and Quiet. */
  function drawSidebar() {
    var el = els.list;
    if (!el) return;
    var keep = el.scrollTop;
    var needs = layout.needs.map(function (id) { return stories[id]; }).filter(Boolean);
    var threadsNeeds = needs.filter(function (s) { return !s.isRun; });
    var runNeeds = needs.filter(function (s) { return s.isRun; });
    var news = layout.news.map(function (id) { return stories[id]; }).filter(Boolean);
    var quiet = layout.quiet.map(function (id) { return stories[id]; }).filter(Boolean);
    var catchCount = listCatchup(stories).length;
    var since = AWAY ? '<span class="gz-h-note">since 09:01</span>' : "";
    var html = "";
    if (needs.length) {
      html +=
        '<section class="side-sec gz-sec gz-sec--needs"><h3 class="side-h"><span>Needs you</span><b class="count count--you">' + needs.length + "</b></h3>" +
        threadsNeeds.map(drawRow).join("") +
        (runNeeds.length ? '<div class="side-sub gz-sub">From runs</div>' + runNeeds.map(drawRow).join("") : "") +
        "</section>";
    }
    if (news.length || pending.length) {
      html +=
        '<section class="side-sec gz-sec"><h3 class="side-h' + (pending.length ? " has-pill" : "") + '"><span>News' + since + "</span>" +
        (pending.length ? drawPill() : catchCount ? '<button class="gz-catch-link" type="button" data-catchup title="Catch up (C)">Catch up</button>' : "") +
        "</h3>" + news.map(drawRow).join("") + "</section>";
    }
    var snoozed = Object.keys(RT.snoozed).length;
    var more = SWARM ? W.swarm.more.webshop + W.swarm.more["payments-api"] + W.swarm.more.ops : 0;
    html +=
      '<section class="side-sec gz-sec gz-sec--quiet"><h3 class="side-h"><span>Quiet</span></h3>' +
      quiet.map(drawRow).join("") +
      (more ? '<a class="side-row side-row--more gz-more" href="#">' + more + " more, nothing new</a>" : "") +
      (snoozed ? '<a class="side-row side-row--more gz-more" href="#">' + snoozed + " snoozed · back when something new happens</a>" : "") +
      '<a class="side-row side-row--more gz-more gz-done-row" href="#">' + Crew.icon("check", 13) + "<span>Done</span><b>" + (W.doneCount + Object.keys(RT.done).length) + "</b></a>" +
      "</section>" +
      '<div class="gz-keys" aria-hidden="true"><span><kbd>J</kbd><kbd>K</kbd> stories</span><span><kbd>E</kbd> Done</span><span><kbd>S</kbd> snooze</span></div>';
    el.innerHTML = html;
    el.scrollTop = keep;
  }

  /** Draws the foot's counts: threads working and idle, and everything that needs Rogier. */
  function drawFoot() {
    if (!api) return;
    var c = { working: 0, idle: 0 };
    W.threads.concat(SWARM ? W.swarm.threads : []).forEach(function (t) {
      if (RT.done[t.id]) return;
      if (t.pose === "working") c.working++;
      else if (t.pose === "idle") c.idle++;
    });
    var n = countNeeds(stories);
    api.els.sum.innerHTML = "<b>" + c.working + "</b> working · <b" + (n ? ' class="you-ink"' : "") + ">" + n + "</b> need you · <b>" + c.idle + "</b> idle";
  }

  /* ================================================================== acting on a story */

  var toastTimer = null;

  /** Shows a toast at the bottom of the window: a line and an optional action, for five seconds. */
  function toast(text, action, onAction) {
    var t = els.toast;
    t.innerHTML = '<span class="gz-toast-text">' + text + "</span>" + (action ? '<button type="button">' + action + "</button>" : "");
    t.hidden = false;
    t.classList.remove("is-new");
    void t.offsetWidth;
    t.classList.add("is-new");
    if (action) t.querySelector("button").onclick = function () { t.hidden = true; onAction(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 5000);
  }

  /** Marks every thread of a story read now. */
  function markRead(storyId) {
    var s = stories[storyId] || buildStory(storyId);
    if (!s) return;
    s.members.forEach(function (m) { seen[m.id] = NOW; });
  }

  /**
   * Answers the Request of a thread with one of its answers. The thread goes back to work, the
   * story is read, and a toast offers Undo. Returns nothing.
   */
  function answer(threadId, index, quietly) {
    var t = getThread(threadId);
    var opts = G.answers[threadId] || [{ label: "Answer", done: "Answered" }];
    var a = opts[index];
    var before = { pose: t.pose, status: t.status, ask: t.ask, askShort: t.askShort, seen: {} };
    var s = storyOfThread(threadId);
    if (s) s.members.forEach(function (m) { before.seen[m.id] = seen[m.id]; });
    var askText = t.ask;
    t.pose = a.label === "Deny" ? "idle" : "working";
    t.status = a.label === "Deny" ? null : "working";
    t.ask = null;
    RT.answered[threadId] = { label: a.done, at: NOW, ask: askText };
    RT.extra[threadId] = (RT.extra[threadId] || []).concat([{ at: NOW, text: a.done + ": " + askText, you: true }]);
    if (s) markRead(s.id);
    if (catchup) catchup.tally.answered++;
    refresh();
    if (quietly) return;
    toast(esc(a.done) + " · " + esc(t.isRunStep ? "Ship release v2.15" : t.title), "Undo", function () {
      t.pose = before.pose;
      t.status = before.status;
      t.ask = before.ask;
      t.askShort = before.askShort;
      delete RT.answered[threadId];
      RT.extra[threadId] = (RT.extra[threadId] || []).filter(function (h) { return !h.you || h.at !== NOW; });
      Object.keys(before.seen).forEach(function (id) { seen[id] = before.seen[id]; });
      if (catchup) catchup.tally.answered--;
      refresh();
    });
  }

  /** Marks a story Done: its threads leave the Wire for the Done shelf, with Undo. */
  function markDone(storyId) {
    var s = stories[storyId];
    if (!s || s.isRun) return;
    var ids = s.members.map(function (m) { return m.id; });
    var next = neighbour(storyId, 1);
    ids.forEach(function (id) { RT.done[id] = true; });
    var stageIds = ids.filter(function (id) { return !!api.getThread(id); });
    var moved = api.markDone(stageIds);
    if (catchup) catchup.tally.done++;
    if (sel && ids.indexOf(sel) !== -1) sel = next ? stories[next] && primaryOf(stories[next]) : null;
    refresh();
    toast("Marked Done · " + esc(s.lead.title), "Undo", function () {
      ids.forEach(function (id) { delete RT.done[id]; });
      api.restoreThreads(moved);
      if (catchup) catchup.tally.done--;
      refresh();
    });
  }

  /** Snoozes a story until something new happens in it, with Undo. */
  function snooze(storyId) {
    var s = stories[storyId];
    if (!s || s.section === "needs") {
      if (s) toast("A story that waits on you cannot be snoozed. Answer it, or mark it Done.");
      return;
    }
    var next = neighbour(storyId, 1);
    RT.snoozed[storyId] = true;
    if (catchup) catchup.tally.snoozed++;
    if (sel && storyOfThread(sel) === s) sel = next ? stories[next] && primaryOf(stories[next]) : null;
    refresh();
    toast("Snoozed until something new happens · " + esc(s.lead.title), "Undo", function () {
      delete RT.snoozed[storyId];
      if (catchup) catchup.tally.snoozed--;
      refresh();
    });
  }

  /** Returns the id of the story `step` rows away from a story in the Wire's order, or null. */
  function neighbour(storyId, step) {
    var order = layout.needs.concat(layout.news, layout.quiet).filter(function (id) { return !!stories[id]; });
    var i = order.indexOf(storyId);
    if (i === -1) return order[0] || null;
    return order[i + step] || null;
  }

  /* ================================================================== selection and opening */

  /** Selects a thread in every mode: its row, its story, its card, its bean. */
  function select(id, opts) {
    opts = opts || {};
    cardOn = true;
    if (!getThread(id)) return;
    sel = id;
    drawSidebar();
    if (overviewOpen) {
      if (mode === "threads") drawThreads();
      if (mode === "front-page") markFrontSelection(true);
      drawCard();
      if (office.handle && mode === "office" && !opts.fromOffice) office.handle.select(sel);
    }
    scrollRowIntoView();
  }

  /** Scrolls the selected story's row into view in both lists, by setting scrollTop (scrollIntoView would also scroll a page that frames this one). */
  function scrollRowIntoView() {
    var s = selectedStory();
    if (!s) return;
    [els.list, els.wire].forEach(function (list) {
      var row = list && list.querySelector('[data-story="' + s.id + '"]');
      if (!row) return;
      var r = row.getBoundingClientRect();
      var l = list.getBoundingClientRect();
      if (r.top < l.top + 30) list.scrollTop += r.top - l.top - 40;
      else if (r.bottom > l.bottom - 10) list.scrollTop += r.bottom - l.bottom + 40;
    });
  }

  /** Opens a thread in the main pane: the overview closes, and the thread's story is read. */
  function openThread(id) {
    var t = getThread(id);
    if (!t) return;
    var s = storyOfThread(id);
    if (s) markRead(s.id);
    sel = id;
    setOverview(false);
    api.open(id);
    refresh();
  }

  /* ================================================================== the overview */

  /** Opens or closes the overview. While it is open the sidebar's Office button is pressed. */
  function setOverview(open) {
    overviewOpen = open;
    els.ov.classList.toggle("is-open", open);
    els.ov.setAttribute("aria-hidden", String(!open));
    if (els.officeBtn) els.officeBtn.classList.toggle("is-on", open);
    if (open) {
      setMode(mode, true);
    } else if (office.handle) {
      office.handle.pause();
    }
  }

  /** Shows one mode of the overview. The selection stays; the change is a short cross-fade. */
  function setMode(next, force) {
    if (MODES.indexOf(next) === -1) next = "threads";
    var changed = next !== mode;
    mode = next;
    els.ov.dataset.mode = mode;
    if (!changed && !force) return;
    if (mode === "front-page" && force) cardOn = false;
    drawTop();
    if (mode === "threads") drawThreads();
    if (mode === "front-page") drawFront();
    if (mode === "office") showOffice();
    else if (office.handle) office.handle.pause();
    drawCard();
  }

  /** Builds the overview's frame once: the top bar, the three mode panes, the card and the toast. */
  function buildOverview() {
    var ov = document.createElement("section");
    ov.className = "gz-ov";
    ov.setAttribute("aria-label", "Overview");
    ov.innerHTML =
      '<header class="gz-top" data-top></header>' +
      '<div class="gz-pane gz-pane--office" data-pane-office><div class="gz-office-host" data-office-host></div></div>' +
      '<div class="gz-pane gz-pane--threads" data-pane-threads>' +
      '<div class="gz-wire" data-wire></div>' +
      '<div class="gz-read" data-read></div>' +
      "</div>" +
      '<div class="gz-pane gz-pane--front" data-pane-front><div class="gz-press" data-press></div></div>' +
      '<div class="gz-card" data-card hidden></div>';
    api.els.app.appendChild(ov);
    var t = document.createElement("div");
    t.className = "gz-toast";
    t.hidden = true;
    api.els.app.appendChild(t);
    els.toast = t;
    els.ov = ov;
    els.top = ov.querySelector("[data-top]");
    els.wire = ov.querySelector("[data-wire]");
    els.read = ov.querySelector("[data-read]");
    els.press = ov.querySelector("[data-press]");
    els.card = ov.querySelector("[data-card]");
    els.officeHost = ov.querySelector("[data-office-host]");
  }

  /** Returns the markup of an icon Crew does not draw: a folded newspaper, and the weather. */
  function drawIcon(name, size) {
    size = size || 16;
    var body = {
      paper: '<path d="M2.6 3.2h8.6v9.2a1 1 0 0 0 1 1H3.6a1 1 0 0 1-1-1z"/><path d="M11.2 5.6h2.2v6.8a1 1 0 0 1-1 1h-.2"/><path d="M4.6 5.4h4.6M4.6 7.8h4.6M4.6 10.2h2.8"/>',
      fair: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>',
      busy: '<circle cx="5.8" cy="5.6" r="2.2"/><path d="M5.8 1.6v.9M1.8 5.6h.9M3 2.8l.6.6M8.6 2.8l-.6.6"/><path d="M5.6 13.4h6.2a2.4 2.4 0 0 0 .3-4.8 3.2 3.2 0 0 0-6.1.7 2.1 2.1 0 0 0-.4 4.1z"/>',
      cap: '<path d="M4.4 10.4h7.4a2.6 2.6 0 0 0 .3-5.2 3.5 3.5 0 0 0-6.7.7 2.3 2.3 0 0 0-1 4.5z"/><path d="M8.6 10.4L7.2 12.6h2l-1.2 2"/>',
      print: '<path d="M4.4 6V2.6h7.2V6"/><rect x="2.2" y="6" width="11.6" height="5.4" rx="1.4"/><path d="M4.4 9.6h7.2v3.8H4.4z"/>',
    }[name];
    return '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }

  /** Draws the overview's top bar: the mode switch, the mode's own controls, the counts, Close. */
  function drawTop() {
    var needs = countNeeds(stories);
    var catchList = listCatchup(stories);
    var working = listLive().filter(function (t) { return t.pose === "working" && !t.isRunStep; }).length;
    var unread = Object.keys(stories).filter(function (k) { return stories[k].unread; }).length;
    var icon = { office: Crew.icon("office", 15), threads: Crew.icon("threads", 15), "front-page": drawIcon("paper", 15) };
    var sw =
      '<nav class="pill gz-switch" aria-label="Overview mode">' +
      MODES.map(function (m, i) {
        return '<button type="button" class="gz-sw" aria-pressed="' + (m === mode) + '" data-mode="' + m + '" title="' + MODE_NAMES[m] + " ⌥" + (i + 1) + '">' + icon[m] + "<span>" + MODE_NAMES[m] + "</span></button>";
      }).join("") +
      "</nav>";
    var own = "";
    if (mode === "threads") {
      own = catchup && catchup.i >= catchup.list.length
        ? '<span class="pill gz-own"><span class="gz-own-label">' + Crew.icon("check", 13) + " Caught up in " + formatElapsed(catchup.finished || 0) + '</span><button class="btn btn--sm btn--quiet" type="button" data-stop>Back to the Wire</button></span>'
        : catchup
        ? '<span class="pill gz-own"><span class="gz-own-label">Catching up</span><button class="btn btn--sm btn--quiet" type="button" data-stop>Stop <kbd>esc</kbd></button></span>'
        : catchList.length
          ? '<span class="pill gz-own"><button class="btn btn--sm btn--accent" type="button" data-catchup>' + Crew.icon("play", 13) + "Catch up<kbd>C</kbd></button><span class=\"gz-own-label\">" + catchList.length + " stories, most important first</span></span>"
          : '<span class="pill gz-own"><span class="gz-own-label">' + Crew.icon("check", 13) + " Nothing new to read</span></span>";
    } else if (mode === "front-page") {
      own =
        '<span class="pill gz-own"><span class="seg gz-editions" role="group" aria-label="Edition">' +
        '<button type="button" aria-pressed="' + (edition === "morning") + '" data-edition="morning">Morning 09:41</button>' +
        '<button type="button" aria-pressed="' + (edition === "evening") + '" data-edition="evening">Yesterday evening 18:20</button>' +
        "</span>" +
        '<button class="pill-btn" type="button" data-print title="Print a new edition now">' + drawIcon("print", 14) + "Print now</button></span>";
    }
    var counts =
      '<span class="pill gz-counts">' +
      '<span class="gz-c' + (needs ? " gz-c--you" : "") + '">' + Crew.mark(needs ? "waiting" : "done", 13) + "<b>" + needs + "</b> need you</span>" +
      '<span class="gz-c"><i class="gz-ink gz-ink--inline"></i><b>' + unread + "</b> with news</span>" +
      '<span class="gz-c">' + Crew.mark("working", 13) + "<b>" + working + "</b> working</span>" +
      "</span>";
    els.top.innerHTML = sw + own + '<span class="spacer"></span>' + counts + '<span class="pill"><button class="pill-btn" type="button" data-close title="Close the overview (esc)">Close<kbd>esc</kbd></button></span>';
  }

  /* ================================================================== Threads mode: the Wire, wide */

  function drawWideRow(s) {
    var slot = decideSlot(s);
    var on = sel && storyOfThread(sel) === s;
    var inCatch = catchup && catchup.list[catchup.i] === s.id;
    var faces = s.members.length > 1
      ? '<span class="stack gz-stack">' + s.members.slice(1, 4).map(function (m) { return drawFace(m, 16); }).join("") + "</span>"
      : "";
    var proj = s.project ? '<span class="proj proj--' + s.project.tint + ' gz-proj">' + esc(s.project.name) + "</span>" : s.isRun ? '<span class="gz-proj faint">Run · payments-api</span>' : '<span class="gz-proj faint">No project</span>';
    var count = s.unreadCount > 1 ? '<span class="gz-newcount">' + s.unreadCount + " new</span>" : "";
    return (
      '<div class="gz-wrow' + (s.unread ? " is-unread" : "") + (s.section === "quiet" ? " is-quiet" : "") + (on ? " is-on" : "") + (inCatch ? " is-reading" : "") + (s.fresh ? " is-fresh" : "") + '" data-story="' + s.id + '" data-row="' + s.id + '" tabindex="-1">' +
      (s.unread ? '<i class="gz-ink" role="img" aria-label="new since you looked"></i>' : "") +
      '<span class="gz-wrow-face">' + drawFace(s.speaker, 30) + "</span>" +
      '<span class="gz-wrow-text">' +
      '<span class="gz-wrow-1"><span class="gz-wrow-title">' + esc(s.lead.title) + '</span><span class="gz-wrow-slot gz-end--' + slot.kind + '">' + slot.text + "</span></span>" +
      '<span class="gz-wrow-2">' + drawLine(s, true) + "</span>" +
      '<span class="gz-wrow-3">' + proj + faces + count + "</span>" +
      "</span></div>"
    );
  }

  /** Draws the Threads mode: the Wire at full width on the left, the selected story on the right. */
  function drawThreads() {
    var keep = els.wire.scrollTop;
    var sec = function (key, title, extra) {
      var list = layout[key].map(function (id) { return stories[id]; }).filter(Boolean);
      if (!list.length) return "";
      var threadsPart = list.filter(function (s) { return !s.isRun; });
      var runPart = list.filter(function (s) { return s.isRun; });
      return (
        '<section class="gz-wsec gz-wsec--' + key + '"><h3 class="gz-wsec-h' + (key === "news" && pending.length ? " has-pill" : "") + '">' + title + (extra || "") + "</h3>" +
        threadsPart.map(drawWideRow).join("") +
        (runPart.length ? '<div class="gz-wsub">From runs</div>' + runPart.map(drawWideRow).join("") : "") +
        "</section>"
      );
    };
    var needsCount = layout.needs.filter(function (id) { return stories[id]; }).length;
    var unreadStories = Object.keys(stories).filter(function (k) { return stories[k].unread; }).length;
    var awayNote = AWAY ? '<div class="gz-back">' + Crew.you(20) + "<span><b>Welcome back.</b> You were away 09:01 to 09:41. " + (unreadStories ? unreadStories + " " + (unreadStories === 1 ? "story is" : "stories are") + " new to you." : "You have read everything since.") + "</span></div>" : "";
    els.wire.innerHTML =
      awayNote +
      sec("needs", "Needs you", ' <b class="count count--you">' + needsCount + "</b>") +
      sec("news", "News", (AWAY ? ' <span class="gz-h-note">since 09:01</span>' : "") + (pending.length ? '<span class="spacer"></span>' + drawPill() : "")) +
      sec("quiet", "Quiet", "") +
      '<div class="gz-wkeys"><span><kbd>J</kbd> <kbd>K</kbd> next, previous</span><span><kbd>↩</kbd> open</span><span><kbd>E</kbd> Done</span><span><kbd>S</kbd> snooze</span><span><kbd>C</kbd> catch up</span></div>';
    els.wire.scrollTop = keep;
    drawReading();
  }

  /* ---------------------------------------------------------------- the story pane */

  function drawAnswers(t, cls, compact) {
    var opts = (G.answers[t.id] || []).map(function (o, i) { o.index = i; return o; });
    // A compact place (the card) keeps the suggested answer and the decline, and drops the middle ones.
    if (compact && opts.length > 2) opts = opts.filter(function (o) { return o.accent || o.quiet || o.danger; });
    var done = RT.answered[t.id];
    if (done) return '<div class="gz-answered ' + (cls || "") + '">' + Crew.icon("check", 14) + "<span>" + esc(done.label) + " · " + done.at + "</span></div>";
    return (
      '<div class="gz-acts ' + (cls || "") + '">' +
      opts.map(function (o, i) {
        var c = o.accent ? "btn btn--sm btn--accent" : o.quiet ? "btn btn--sm btn--quiet" : o.danger ? "btn btn--sm btn--danger" : "btn btn--sm";
        return '<button type="button" class="' + c + '" data-answer="' + t.id + '" data-index="' + o.index + '">' + esc(o.label) + "</button>";
      }).join("") +
      "</div>"
    );
  }

  /** Returns a Request's text with a command set as code: "Run git push?" becomes "Run <code>git push</code>?". */
  function drawAskText(ask) {
    var m = /^Run (.+)\?$/.exec(ask || "");
    return m ? "Run <code>" + esc(m[1]) + "</code>?" : esc(ask);
  }

  function describeTeam(s) {
    var lead = s.lead;
    var others = s.members.slice(1).map(function (m) {
      return (m.role || "partner") + " (" + describeAgent(m) + ")";
    });
    return "By " + describeAgent(lead) + (others.length ? " · with " + others.join(", ") : "");
  }

  /** Returns where a story's work stands in code: its diff, branch and PR. Empty when it changed nothing. */
  function drawDiff(s) {
    var o = W.output[s.lead.id];
    if (!o || !o.files) return "";
    var touched = s.members.reduce(function (acc, m) {
      var f = W.files[m.id];
      return acc.concat(f ? f.touched.filter(function (x) { return x.how === "edit" && (x.plus || x.minus); }) : []);
    }, []);
    touched.sort(function (a, b) { return b.plus + b.minus - (a.plus + a.minus); });
    var ws = W.workspaces[s.lead.workspace] || {};
    var br = W.branches[s.lead.workspace];
    var pr = o.pr ? "PR #" + o.pr.number + " " + (o.pr.state === "draft" ? "draft" : "open") + (o.checks === "passing" ? ", CI passing" : "") : "No PR yet";
    var branchNote = br ? (br.ahead ? br.ahead + " commit" + (br.ahead === 1 ? "" : "s") + " ahead" : "no commits yet") + (br.pushed === false ? ", not pushed" : "") : "";
    return (
      '<section class="gz-block gz-diff"><h4 class="gz-block-h">' + Crew.icon("diff", 14) + "The diff</h4>" +
      '<div class="gz-diff-sum"><b>' + o.files + " file" + (o.files === 1 ? "" : "s") + '</b><span class="plus mono">+' + o.plus + '</span><span class="minus mono">-' + o.minus + "</span>" +
      (ws.branch ? '<span class="gz-diff-br">' + Crew.icon("branch", 13) + '<span class="mono">' + esc(ws.branch) + "</span>" + (branchNote ? '<span class="faint">' + branchNote + "</span>" : "") + "</span>" : "") +
      '<span class="gz-diff-pr">' + pr + "</span></div>" +
      '<div class="gz-files">' +
      touched.slice(0, 4).map(function (f) {
        return '<div class="gz-file"><span class="mono">' + esc(f.path) + '</span><span class="plus mono">+' + f.plus + '</span><span class="minus mono">-' + f.minus + "</span></div>";
      }).join("") +
      (touched.length > 4 ? '<div class="gz-file gz-file--more">and ' + (touched.length - 4) + " more files</div>" : "") +
      "</div></section>"
    );
  }

  /** Returns the message that matters in a story: the edition's pick, else the newest report, else the newest news. */
  function pickQuote(s) {
    var q = G.quote[s.id];
    if (q) return { by: getThread(q.by), at: q.at, text: q.text };
    var reports = s.items.filter(function (i) { return i.kind === "report" || i.reportText; });
    var pick = reports.slice(-1)[0] || s.items.filter(function (i) { return i.kind === "headline" || i.kind === "request"; }).slice(-1)[0];
    if (!pick) return null;
    return pick.reportText ? { by: pick.by, at: pick.reportAt, text: pick.reportText } : { by: pick.by, at: pick.at, text: pick.text };
  }

  function drawTimeline(s) {
    var since = seen[s.lead.id];
    var list = s.items;
    var news = list.filter(function (i) { return i.unread || i.kind === "you" || isAfter(i.at, since); });
    var nothing = !news.length;
    if (nothing) news = list.slice(-3);
    var older = list.length - news.length;
    var title = nothing ? "Nothing new since you looked at " + formatClock(since) + ". The latest:" : since ? "Since you looked at " + formatClock(since) : "New to you";
    return (
      '<section class="gz-block' + (nothing ? " is-old" : "") + '"><h4 class="gz-block-h">' + Crew.icon("clock", 14) + title + "</h4>" +
      '<ol class="gz-tl">' +
      news.map(function (i) {
        var who = i.kind === "you" ? Crew.you(18) : drawFace(i.by, 18, i.by.pose === "waiting" && i.kind !== "request" ? "idle" : undefined);
        var label = i.kind === "you" ? "You" : i.by.id === s.lead.id ? (s.members.length > 1 ? "lead" : "") : i.by.role || "";
        var kind = i.kind === "report" || i.reportedTo ? "reported to the lead" : i.kind === "brief" ? "briefed " + (i.to.role || "a partner") : i.kind === "request" ? "asks you" : i.kind === "sofar" ? "working" : "";
        return (
          '<li class="gz-tl-i gz-tl-i--' + i.kind + (i.unread ? " is-unread" : "") + '">' +
          '<span class="gz-tl-at">' + formatClock(i.at) + "</span>" +
          '<span class="gz-tl-who">' + who + "</span>" +
          '<span class="gz-tl-text">' + (label || kind ? '<span class="gz-tl-meta">' + esc(label) + (label && kind ? " · " : "") + kind + "</span>" : "") + esc(i.text) +
          (i.kind !== "you" ? ' <a href="#" class="gz-src" data-open="' + i.by.id + '">source</a>' : "") +
          "</span></li>"
        );
      }).join("") +
      "</ol>" +
      (older > 0 ? '<p class="gz-older">' + older + " earlier " + (older === 1 ? "line" : "lines") + (nothing ? "" : " you have read") + "</p>" : "") +
      "</section>"
    );
  }

  /** Draws the reading pane: the story of the selected piece of work since Rogier looked. */
  function drawReading() {
    if (catchup && catchup.i >= catchup.list.length) return drawCaughtUp();
    var s = catchup ? stories[catchup.list[catchup.i]] || buildStory(catchup.list[catchup.i]) : selectedStory();
    if (!s) {
      els.read.innerHTML = '<div class="gz-read-empty">' + drawIcon("paper", 28) + "<p>Pick a story on the left, or press <kbd>J</kbd>.</p></div>";
      return;
    }
    var strip = "";
    if (catchup) {
      var n = catchup.list.length;
      strip =
        '<div class="gz-progress"><div class="gz-progress-1"><b>Catch up</b><span>Story ' + (catchup.i + 1) + " of " + n + '</span><span class="gz-progress-time" data-elapsed>' + formatElapsed(elapsed()) + '</span><span class="spacer"></span><button type="button" class="btn btn--sm btn--quiet" data-stop>Stop <kbd>esc</kbd></button></div>' +
        '<div class="gz-progress-bar">' + catchup.list.map(function (id, i) {
          return '<i class="' + (i < catchup.i ? "is-done" : i === catchup.i ? "is-now" : "") + '"></i>';
        }).join("") + "</div></div>";
    }
    var lineNew = (s.unreadCount ? '<i class="gz-ink gz-ink--inline"></i>' + s.unreadCount + " new · " : "") + "updated " + formatClock(s.time);
    var kicker =
      '<div class="gz-kicker">' +
      (s.project ? '<span class="proj proj--' + s.project.tint + '">' + esc(s.project.name) + "</span>" : '<span class="proj gz-noproj">No project</span>') +
      (s.kicker ? '<span class="gz-kick">' + esc(s.kicker) + "</span>" : "") +
      '<span class="gz-kicker-note">' + lineNew + "</span></div>";
    var ask = s.asks.length
      ? s.asks.map(function (a) {
          return (
            '<div class="gz-ask">' + drawFace(a, 34, "waiting") +
            '<div class="gz-ask-body"><div class="gz-ask-who">' + esc(a.id === s.lead.id ? describeAgent(a) : (a.role || "partner") + " · " + describeAgent(a)) + " · asks you since " + a.last + '</div><div class="gz-ask-q">' + drawAskText(a.ask) + "</div>" + drawAnswers(a) + "</div></div>"
          );
        }).join("")
      : Object.keys(RT.answered).filter(function (id) { return s.members.some(function (m) { return m.id === id; }); }).map(function (id) {
          return '<div class="gz-ask gz-ask--done">' + Crew.icon("check", 16) + '<div class="gz-ask-body"><div class="gz-ask-q">' + esc(RT.answered[id].ask) + "</div>" + drawAnswers(getThread(id)) + "</div></div>";
        }).join("");
    var q = pickQuote(s);
    var quote = q
      ? '<figure class="gz-quote"><blockquote>' + esc(q.text) + "</blockquote><figcaption>" + drawFace(q.by, 18, "idle") + "<span>" + esc(q.by.id === s.lead.id ? describeAgent(q.by) : (q.by.role || "") + " · " + describeAgent(q.by)) + " · " + formatClock(q.at) + '</span><a href="#" class="gz-src" data-open="' + q.by.id + '">Read it in the thread</a></figcaption></figure>'
      : "";
    var next = catchup ? catchup.list[catchup.i + 1] : neighbour(s.id, 1);
    var nextStory = next ? stories[next] : null;
    els.read.innerHTML =
      strip +
      '<article class="gz-story">' +
      kicker +
      '<h2 class="gz-story-head">' + esc(s.head) + "</h2>" +
      '<p class="gz-byline">' + esc(describeTeam(s)) + "</p>" +
      ask +
      drawTimeline(s) +
      quote +
      drawDiff(s) +
      "</article>" +
      '<footer class="gz-read-foot">' +
      (catchup ? "" : '<button type="button" class="btn btn--sm" data-open="' + primaryOf(s) + '">Open thread <kbd>↩</kbd></button>') +
      (s.isRun ? "" : '<button type="button" class="btn btn--sm btn--quiet" data-done="' + s.id + '">Mark Done <kbd>E</kbd></button>') +
      (s.section === "needs" ? "" : '<button type="button" class="btn btn--sm btn--quiet" data-snooze="' + s.id + '">Snooze <kbd>S</kbd></button>') +
      '<span class="spacer"></span>' +
      (catchup
        ? '<button type="button" class="btn btn--sm' + (s.asks.length && !RT.answered[s.asks[0].id] ? "" : " btn--accent") + '" data-next>' + (catchup.i + 1 === catchup.list.length ? "Finish" : "Next story") + " <kbd>J</kbd>" + Crew.icon("chev-r", 13) + "</button>"
        : nextStory ? '<button type="button" class="btn btn--sm gz-next" data-next><span class="gz-next-label"><span class="faint">Next story</span>' + esc(nextStory.lead.title) + "</span><kbd>J</kbd>" + Crew.icon("chev-r", 13) + "</button>" : "") +
      "</footer>";
    els.read.scrollTop = 0;
  }

  /* ---------------------------------------------------------------- Catch up */

  function elapsed() {
    if (!catchup) return 0;
    return catchup.elapsedBase + Math.round((Date.now() - catchup.started) / 1000);
  }

  /** Starts Catch up: the Threads mode walks every story that matters, most important first. */
  function startCatchup(opts) {
    opts = opts || {};
    var list = opts.list || listCatchup(stories);
    if (!list.length) return;
    catchup = { list: list, i: opts.i || 0, started: Date.now(), elapsedBase: opts.elapsed || 0, tally: { answered: 0, done: 0, snoozed: 0, read: 0 } };
    if (!overviewOpen) setOverview(true);
    setMode("threads", true);
    focusCatchupStory();
    tickCatchup();
  }

  function focusCatchupStory() {
    var id = catchup.list[catchup.i];
    var s = stories[id];
    if (s) sel = primaryOf(s);
    drawAll();
  }

  /** Moves Catch up to the next story; the story just read is marked read. */
  function nextCatchup() {
    var id = catchup.list[catchup.i];
    if (stories[id] && stories[id].unread) {
      markRead(id);
      catchup.tally.read++;
    }
    catchup.i++;
    if (catchup.i >= catchup.list.length) {
      catchup.finished = elapsed();
      refresh();
      return;
    }
    stories = buildStories();
    focusCatchupStory();
  }

  function stopCatchup() {
    catchup = null;
    refresh();
  }

  function tickCatchup() {
    if (!catchup || catchup.finished != null) return;
    var el = els.read.querySelector("[data-elapsed]");
    if (el) el.textContent = formatElapsed(elapsed());
    setTimeout(tickCatchup, 1000);
  }

  /** Draws the end card of Catch up: what was read, how long it took, and what comes next. */
  function drawCaughtUp() {
    var t = catchup.endTally || catchup.tally;
    var secs = catchup.finished != null ? catchup.finished : elapsed();
    var e = W.eta.tResult;
    var parts = [];
    if (t.answered) parts.push(t.answered + " answered");
    if (t.done) parts.push(t.done + " marked Done");
    if (t.snoozed) parts.push(t.snoozed + " snoozed");
    if (t.read) parts.push(t.read + " read");
    els.read.innerHTML =
      '<div class="gz-end">' +
      '<div class="gz-end-art">' + drawEndArt() + "</div>" +
      '<h2 class="gz-end-h">You\'re caught up</h2>' +
      '<p class="gz-end-sub">' + catchup.list.length + " stories in <b>" + formatElapsed(secs) + "</b></p>" +
      '<p class="gz-end-tally">' + parts.join(" · ") + "</p>" +
      drawStillWaiting() +
      '<div class="gz-end-next"><span class="gz-end-next-h">Next to likely need you</span><span>' + drawFace(getThread("tResult"), 20, "working") + "<b>Migrate payout endpoints to Result types</b></span><span class=\"muted\">" + approx() + "10:03 to 10:06 · " + esc(e.basis) + "</span></div>" +
      '<div class="gz-end-acts"><button type="button" class="btn btn--sm" data-stop>Back to the Wire</button><button type="button" class="btn btn--sm btn--accent" data-goto="front-page">' + drawIcon("paper", 13) + "Read the paper</button></div>" +
      "</div>";
  }

  /** Returns what still waits on Rogier after Catch up, so "caught up" never hides a Request. */
  function drawStillWaiting() {
    var needs = layout.needs.map(function (id) { return stories[id]; }).filter(Boolean);
    if (!needs.length) return "";
    return (
      '<div class="gz-end-wait"><span class="gz-end-next-h">Still waiting on you <b class="count count--you">' + needs.length + "</b></span>" +
      needs.map(function (n) {
        var a = n.asks[0];
        return '<button type="button" class="gz-end-ask" data-pick="' + n.id + '">' + drawFace(a, 20, "waiting") + "<b>" + esc(n.lead.title) + '</b><span class="you-ink">' + esc(a.askShort) + "</span></button>";
      }).join("") +
      "</div>"
    );
  }

  function drawEndArt() {
    // A colleague at ease with the morning paper folded on the desk, and a cup of tisane.
    return (
      '<svg viewBox="0 0 240 140" class="gz-end-svg" aria-hidden="true">' +
      '<path d="M18 120h204" stroke="var(--line)" stroke-width="1.5"/>' +
      '<g transform="translate(42 70)"><rect x="0" y="0" width="92" height="50" rx="3" fill="var(--raised)" stroke="var(--ink)" stroke-width="1.3" transform="skewX(-12)"/>' +
      '<path d="M8 10h46M8 18h68M8 24h60M8 30h68M8 36h40" stroke="var(--faint)" stroke-width="2" transform="skewX(-12)"/>' +
      '<text x="10" y="-4" font-family="var(--font-deco)" font-size="11" fill="var(--ink)" transform="skewX(-12)">The Bureau Gazette</text></g>' +
      '<g transform="translate(150 92)"><path d="M0 0h22v14a8 8 0 0 1-8 8h-6a8 8 0 0 1-8-8z" fill="var(--raised)" stroke="var(--ink)" stroke-width="1.3"/><path d="M22 4h3a4 4 0 0 1 0 8h-3" fill="none" stroke="var(--ink)" stroke-width="1.3"/><path d="M6 -6c0-4 4-4 4-8M13 -6c0-4 4-4 4-8" fill="none" stroke="var(--faint)" stroke-width="1.3" stroke-linecap="round"/></g>' +
      '<g transform="translate(178 44)">' + Crew.face("Hercule", { pose: "done", size: 56 }) + "</g>" +
      "</svg>"
    );
  }

  /* ================================================================== the Front Page */

  function storyLink(id, inner, cls) {
    return '<a href="#" class="gz-st ' + (cls || "") + '" data-story="' + id + '" data-pick="' + id + '">' + inner + "</a>";
  }

  function inkDot(s) {
    return s && s.unread ? '<i class="gz-ink gz-ink--inline" role="img" aria-label="new to you"></i>' : "";
  }

  /** Returns the paper's body text of a story: its turn headlines and reports in order, as the edition writes them. */
  function buildBody(s, max) {
    var lines = s.items.filter(function (i) {
      if (i.kind === "brief" || i.kind === "you") return false;
      if (i.by.id === s.lead.id || i.kind === "request" || i.kind === "headline") return true;
      // A partner speaks through its turn headlines; its report only when it has none yet, and never its "so far".
      if (i.kind === "sofar") return false;
      var ended = s.items.some(function (x) { return x.by === i.by && x.kind === "headline"; });
      return !ended && s.items.filter(function (x) { return x.by === i.by && x.kind === "report"; }).slice(-1)[0] === i;
    });
    lines = lines.slice(-(max || 4));
    return lines.map(function (i) {
      return '<span class="gz-body-at">' + formatClock(i.at) + "</span> " + esc(i.text);
    }).join(" ");
  }

  /** Returns the lead story's figure: the 3-D Secure fix, drawn. */
  function drawLeadFigure() {
    var stars = "";
    for (var k = 0; k < 12; k++) {
      var a = (k / 12) * Math.PI * 2;
      stars += '<circle cx="' + (60 + Math.cos(a) * 8.5).toFixed(1) + '" cy="' + (20 + Math.sin(a) * 8.5).toFixed(1) + '" r="1.2" fill="var(--brass)"/>';
    }
    return (
      '<svg viewBox="0 0 320 200" class="gz-fig-svg" role="img" aria-label="A card that needs 3-D Secure used to end at Card declined; now it opens the 3-D Secure check, and the thread asks to push the fix.">' +
      '<defs><marker id="gz-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="var(--ink)"/></marker>' +
      '<marker id="gz-arr-f" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="var(--faint)"/></marker></defs>' +
      '<path d="M12 182H308" stroke="var(--line)" stroke-width="1"/>' +
      // the card, with the EU's ring of stars
      '<g transform="translate(12 44) rotate(-7 42 27)"><rect width="84" height="54" rx="7" fill="var(--proj-webshop)" stroke="var(--ink)" stroke-width="1.3"/>' +
      '<rect x="9" y="12" width="15" height="12" rx="2.5" fill="var(--brass)" stroke="var(--ink)" stroke-width=".8"/>' + stars +
      '<path d="M9 38h11M24 38h11M39 38h11M54 38h11" stroke="var(--ink)" stroke-width="2" stroke-linecap="round" opacity=".55"/>' +
      '<path d="M9 45h26" stroke="var(--ink)" stroke-width="1.6" stroke-linecap="round" opacity=".35"/></g>' +
      // after the fix: on to the 3-D Secure check
      '<path d="M104 70C126 64 156 64 180 68" fill="none" stroke="var(--ink)" stroke-width="1.5" marker-end="url(#gz-arr)"/>' +
      '<text x="141" y="54" text-anchor="middle" class="gz-fig-code">requires_action</text>' +
      '<g transform="translate(186 22)"><rect width="66" height="104" rx="11" fill="var(--raised)" stroke="var(--ink)" stroke-width="1.3"/>' +
      '<rect x="7" y="7" width="52" height="7" rx="3" fill="var(--sunken)"/>' +
      '<g transform="translate(19 22) scale(1.75)" fill="none" stroke="var(--accent-ink)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2l4.8 1.8v3.8c0 3-2.2 5.2-4.8 6-2.6-.8-4.8-3-4.8-6V4z"/><path d="M5.8 8.2l1.6 1.5 2.8-3"/></g>' +
      '<text x="33" y="70" text-anchor="middle" class="gz-fig-t">3-D Secure</text>' +
      '<rect x="11" y="80" width="44" height="15" rx="4" fill="var(--accent)"/><text x="33" y="91" text-anchor="middle" class="gz-fig-btn">Verify</text></g>' +
      '<text x="219" y="146" text-anchor="middle" class="gz-fig-cap">after the fix</text>' +
      // before the fix: a decline, struck out
      '<path d="M46 108C46 128 52 140 66 148" fill="none" stroke="var(--faint)" stroke-width="1.3" stroke-dasharray="3 3" marker-end="url(#gz-arr-f)"/>' +
      '<text x="74" y="133" class="gz-fig-cap">before</text>' +
      '<g transform="translate(70 140) rotate(-3)"><rect width="88" height="22" rx="4" fill="var(--fail-tint)" stroke="var(--fail-ink)" stroke-width="1.1"/><text x="44" y="15" text-anchor="middle" class="gz-fig-fail">Card declined</text><path d="M5 11.5H83" stroke="var(--ink)" stroke-width="1.4"/></g>' +
      // the colleague who wrote the fix, hand up: it waits on you
      '<g transform="translate(254 116)">' + Crew.face(getThread("t3ds").title, { pose: "waiting", size: 62 }) + "</g>" +
      '<g transform="translate(250 84)"><rect width="64" height="22" rx="7" fill="var(--you-tint)" stroke="var(--you)" stroke-width="1.2"/><text x="32" y="15" text-anchor="middle" class="gz-fig-ask">git push?</text><path d="M36 22l4 6 4-6" fill="var(--you-tint)" stroke="var(--you)" stroke-width="1.2" stroke-linejoin="round"/><path d="M37 21.4h6" stroke="var(--you-tint)" stroke-width="2"/></g>' +
      "</svg>"
    );
  }

  /** Returns the figures of the morning, counted from the world. */
  function countFigures() {
    var sessions = W.threads.concat(SWARM ? W.swarm.threads : []).concat([W.assistantThreads[1]]);
    var runIds = Object.keys(W.runSessions);
    var tokens = 0;
    var notReported = 0;
    sessions.map(function (t) { return t.id; }).concat(runIds).forEach(function (id) {
      var u = W.usage[id];
      if (u === null) notReported++;
      else if (u) tokens += u.tokens;
    });
    var turns = 0;
    Object.keys(W.turns).forEach(function (id) {
      if (!SWARM && /^s/.test(id) && W.swarm.threads.some(function (t) { return t.id === id; })) return;
      if (id === "aRust") return;
      W.turns[id].forEach(function (sp) {
        if (sp.to != null && String(sp.from).indexOf(" ") === -1) turns++;
      });
    });
    var plus = 0;
    var minus = 0;
    var branches = 0;
    Object.keys(W.output).forEach(function (id) {
      var o = W.output[id];
      if (!o || (!o.plus && !o.minus)) return;
      plus += o.plus;
      minus += o.minus;
      branches++;
    });
    return { tokens: tokens, notReported: notReported, turns: turns, plus: plus, minus: minus, branches: branches };
  }

  function drawSection(project) {
    var list = Object.keys(stories).map(function (k) { return stories[k]; }).filter(function (s) {
      return s.lead.project === project.id && s.id !== "t3ds";
    });
    var threadStories = list.filter(function (s) { return !s.isRun; }).sort(function (a, b) { return b.weight - a.weight; });
    var top = threadStories[0];
    var rest = threadStories.slice(1).concat(list.filter(function (s) { return s.isRun; }));
    var more = SWARM ? W.swarm.more[project.id] : 0;
    var count = list.length + (project.id === "webshop" ? 1 : 0);
    return (
      '<section class="gz-sect">' +
      '<h3 class="gz-sect-h"><span class="proj proj--' + project.tint + '">' + esc(project.name) + '</span><span class="gz-sect-n">' + count + " stories</span></h3>" +
      (top
        ? storyLink(top.id,
            '<span class="gz-kick">' + inkDot(top) + esc(top.kicker) + "</span>" +
            '<h4 class="gz-h2">' + esc(top.head) + "</h4>" +
            '<p class="gz-body">' + buildBody(top, 3) + "</p>" +
            '<span class="gz-by">' + esc(describeAgent(top.lead)) + (top.members.length > 1 ? " · with " + (top.members.length - 1) + " partner" + (top.members.length > 2 ? "s" : "") : "") + "</span>",
            "gz-st--top")
        : "") +
      '<ul class="gz-items">' +
      rest.map(function (s) {
        return "<li>" + storyLink(s.id, '<span class="gz-items-face">' + drawFace(s.speaker, 18) + '</span><span class="gz-items-text">' + inkDot(s) + "<b>" + esc(s.head) + "</b>" + (s.asks.length ? ' <span class="you-ink">Waits on you.</span>' : "") + '</span><span class="gz-items-at">' + formatClock(s.time) + "</span>") + "</li>";
      }).join("") +
      "</ul>" +
      (more ? '<p class="gz-sect-more">and ' + more + " quiet threads, nothing new</p>" : "") +
      "</section>"
    );
  }

  // The box keeps its order for the edition: a signed Request stays where it was, struck through.
  var signOrder = [];

  function drawSignature() {
    var needs = layout.needs.map(function (id) { return stories[id]; }).filter(Boolean);
    needs.forEach(function (n) {
      if (signOrder.indexOf(n.id) === -1) signOrder.push(n.id);
    });
    var shown = signOrder.map(function (id) { return stories[id]; }).filter(function (s) {
      return s && (needs.indexOf(s) !== -1 || s.members.some(function (m) { return RT.answered[m.id]; }));
    });
    var item = function (s, t) {
      var done = RT.answered[t.id];
      return (
        '<div class="gz-sign-i' + (done ? " is-signed" : "") + '" data-story="' + s.id + '">' +
        '<a href="#" class="gz-sign-face" data-pick="' + s.id + '">' + drawFace(t, 28, done ? "working" : "waiting") + "</a>" +
        '<div class="gz-sign-b"><a href="#" class="gz-sign-t" data-pick="' + s.id + '">' + esc(s.lead.title) + "</a>" +
        '<div class="gz-sign-q">' + (t.id !== s.lead.id && t.role ? "<b>" + esc(t.role) + "</b> asks · " : "") + drawAskText(done ? done.ask : t.ask) + "</div>" +
        drawAnswers(t, "gz-sign-acts") + "</div></div>"
      );
    };
    var rows = shown.filter(function (s) { return !s.isRun; });
    var runs = shown.filter(function (s) { return s.isRun; });
    var asker = function (s) {
      return s.asks[0] || s.members.filter(function (m) { return RT.answered[m.id]; })[0] || s.lead;
    };
    return (
      '<aside class="gz-sign">' +
      '<h3 class="gz-sign-h"><span>Needs your signature</span><b class="count count--you">' + needs.length + "</b></h3>" +
      (shown.length
        ? rows.map(function (s) { return item(s, asker(s)); }).join("") +
          (runs.length ? '<div class="gz-sign-sub">From runs</div>' + runs.map(function (s) { return item(s, asker(s)); }).join("") : "")
        : '<p class="gz-sign-empty">Nothing waits on you.</p>') +
      "</aside>"
    );
  }

  /** Draws the morning edition. */
  function drawMorning() {
    var lead = stories.t3ds || buildStory("t3ds");
    var f = countFigures();
    var away = AWAY;
    var codexNote = "Codex: not reported, " + f.notReported + " sessions";
    var brief = [
      { at: "09:40", text: "A Gmail trigger started Draft reply to Jonas at Kiteworks." },
      { at: "09:35", text: "Milo started Investigate backup timeouts, after the nightly check." },
      { at: "09:25", text: "Cart total rounding on discounts: a Fix bug run writes the fix." },
      { at: "09:20", text: "Webhook retry backoff: a Fix bug run writes the fix." },
      { at: "08:55", text: "Renew the status page TLS certificate was marked Done.", id: "dCert" },
    ];
    var noProject = Object.keys(stories).map(function (k) { return stories[k]; }).filter(function (s) { return !s.lead.project && !s.isRun; }).sort(function (a, b) { return b.weight - a.weight; });
    var corrections = [
      { at: "09:38", by: "t3dsReview", text: "At 09:31 the 3-D Secure fix was reported ready. Its review since found that a processing status still shows “Card declined”." },
      { at: "09:29", by: "tDashAlerts", text: "At 09:15 Migrate ops dashboards reported 14 dashboards moved. Its alerts partner found 2 alerts that point at removed panels." },
      { at: "08:52", by: "tA11y", text: "Audit checkout for screen readers tried a focus-ring fix in card-form.module.css, and reverted it." },
      { at: "08:14", run: "Label new issues", text: "Label new issues is paused: its Spawn Bound tripped after a bot opened 34 issues. 34 events are held." },
      { at: "04:00", run: "Nightly backup check", text: "The nightly backup hit its 2-hour limit for the third night in a row." },
      { at: "Yesterday", text: "Our evening edition reported Stripe SDK v14 as live. It is what broke 3-D Secure for EU cards: see the lead story." },
    ];
    var tr = W.eta.tResult.range;
    var tc = W.eta.tCart.range;
    var tp = W.eta.tPayout.range;
    var plusMin = function (r) { return addMinutes(NOW, r[0]) + " to " + addMinutes(NOW, r[1]); };
    return (
      (away ? '<div class="gz-back gz-back--paper">' + Crew.you(20) + "<span><b>Welcome back, Rogier.</b> You were away 09:01 to 09:41. Stories new to you carry a dot " + '<i class="gz-ink gz-ink--inline"></i>' + "</span></div>" : "") +
      '<article class="gz-paper' + (STATE === "edition" && !REDUCED ? " is-printing" : "") + '" data-paper>' +
      (away ? '<div class="gz-stamp" aria-label="Printed at 09:41 for your return"><b>Printed 09:41</b><span>for your return</span></div>' : "") +
      '<header class="gz-mast">' +
      '<div class="gz-ear"><b>Morning edition</b><span>Since yesterday 18:20</span><span>212 events came in</span></div>' +
      '<h1 class="gz-title"><span class="gz-orn" aria-hidden="true"></span>The Bureau Gazette<span class="gz-orn" aria-hidden="true"></span></h1>' +
      '<div class="gz-ear gz-ear--r"><b>The fleet</b><span>' + drawIcon("cap", 14) + "build-box-1 at cap</span><span>2 machines fair</span></div>" +
      "</header>" +
      '<div class="gz-dateline"><span>Hercule</span><span>Tuesday 29 September 2026 · Morning edition · 09:41 · Printed for Rogier</span><span><b class="you-ink">' + countNeeds(stories) + " need you</b></span></div>" +
      '<div class="gz-row1">' +
      '<section class="gz-lead">' +
      storyLink("t3ds",
        '<span class="gz-kick gz-kick--lead">' + (lead.unread ? '<span class="gz-newmark"><i class="gz-ink gz-ink--inline"></i>New to you</span>' : "") + '<span class="proj proj--webshop">webshop</span> · The hotfix</span>' +
        '<h2 class="gz-h1">3-D Secure fix is ready, and waits on your push</h2>' +
        '<p class="gz-deck">Since Stripe SDK v14, EU cards that need 3-D Secure were told “Card declined”. Claude Code found why, wrote a test that fails first, then the fix. 24 checkout tests pass.</p>' +
        '<p class="gz-byline gz-byline--lead">By Claude Code · Opus 5.5 · with research by Claude Code · Sonnet 5 and review by Codex · gpt-5.4</p>',
        "gz-st--lead") +
      '<div class="gz-lead-cols">' +
      '<figure class="gz-fig">' + drawLeadFigure() + '<figcaption><b>Fig. 1</b> Stripe v14 answers <code>requires_action</code> when a card needs 3-D Secure. Checkout read it as a decline; the fix opens the check.</figcaption></figure>' +
      '<div class="gz-lead-body"><p class="gz-drop">Checkout began to fail for EU cards after deploy #1289 yesterday at 14:02, which upgraded the Stripe SDK to v14. Sentry counted 412 errors for 188 customers, three wrote in, and EU checkout conversion fell 18%.</p>' +
      "<p>You started the fix at 09:02. By 09:04 Claude Code had the cause: <code>handlePaymentResult</code> handled only <code>succeeded</code>. It wrote a failing test, then the fix: 3 files, <span class=\"plus\">+48</span> <span class=\"minus\">-12</span>.</p>" +
      "<p>A review by Codex, still running, found one more case at 09:38: a processing status still shows “Card declined”. The branch <code>fix/3ds-eu-cards</code> is 2 commits ahead and not pushed.</p>" +
      '<p class="gz-cont"><a href="#" class="gz-more-link" data-open="t3ds">Read the thread' + Crew.icon("chev-r", 12) + "</a></p></div>" +
      "</div>" +
      "</section>" +
      drawSignature() +
      "</div>" +
      '<div class="gz-fold" aria-hidden="true"><span>the fold</span></div>' +
      '<div class="gz-row3">' + W.projects.map(drawSection).join("") + "</div>" +
      '<div class="gz-row4">' +
      '<section class="gz-box gz-brief"><h3 class="gz-box-h">In brief</h3><ul class="gz-brief-l">' +
      noProject.map(function (s) {
        var by = W.startedBy[s.lead.id] || "";
        var who = by.indexOf("assistant:") === 0 ? "<b>" + by.slice(10) + "</b> · " : "";
        return { at: s.time, html: "<li>" + storyLink(s.id, '<span class="gz-brief-at">' + formatRowTime(s.time) + "</span><span>" + inkDot(s) + who + esc(s.head) + ".</span>") + "</li>" };
      }).concat(brief.map(function (b) {
        // A Done thread opens from the paper too; a run's line is plain, because a run is not a thread.
        var inner = '<span class="gz-brief-at">' + b.at + "</span><span>" + esc(b.text) + "</span>";
        return { at: b.at, html: "<li>" + (b.id ? '<a href="#" class="gz-st" data-open="' + b.id + '">' + inner + "</a>" : '<span class="gz-st gz-st--plain">' + inner + "</span>") + "</li>" };
      })).sort(function (x, y) { return H.minutes(y.at) - H.minutes(x.at); }).map(function (x) { return x.html; }).join("") +
      "</ul></section>" +
      '<section class="gz-box gz-figs"><h3 class="gz-box-h">Figures of the morning</h3><div class="gz-figs-g">' +
      '<div class="gz-fg"><b class="deco-num">' + formatTokens(f.tokens) + '</b><span>tokens, Claude Code and pi</span><small>' + codexNote + "</small></div>" +
      '<div class="gz-fg"><b class="deco-num">' + f.turns + "</b><span>turns ended since 06:50</span></div>" +
      '<div class="gz-fg"><b class="deco-num">24</b><span>checkout tests pass</span></div>' +
      '<div class="gz-fg"><b class="deco-num">4,000</b><span>property cases run, 1 fails</span></div>' +
      '<div class="gz-fg"><b class="deco-num">2</b><span>PRs open: #1281, CI green; #1287, draft</span></div>' +
      '<div class="gz-fg"><b class="deco-num gz-fg-lines"><span class="plus">+' + formatNumber(f.plus) + '</span> <span class="minus">-' + formatNumber(f.minus) + "</span></b><span>lines on " + f.branches + " branches and workspaces</span></div>" +
      "</div></section>" +
      '<section class="gz-box gz-corr"><h3 class="gz-box-h">Corrections</h3><ul class="gz-corr-l">' +
      corrections.map(function (c) {
        var face = c.by ? drawFace(getThread(c.by), 16, "idle") : c.run ? Crew.face(c.run, { pose: c.run === "Label new issues" ? "paused" : "failed", size: 16 }) : drawIcon("paper", 14);
        var inner = '<span class="gz-corr-at">' + c.at + "</span>" + face + "<span>" + esc(c.text) + "</span>";
        return "<li>" + (c.by ? storyLink(getThread(c.by).lead || c.by, inner) : '<span class="gz-st gz-st--plain">' + inner + "</span>") + "</li>";
      }).join("") +
      "</ul></section>" +
      "</div>" +
      '<div class="gz-row5">' +
      '<section class="gz-box gz-weather"><h3 class="gz-box-h">Weather · the fleet</h3>' +
      drawWeather("studio-mac", 5, 6, "busy", "Busy, a little room") +
      drawWeather("build-box-1", 8, 8, "cap", SWARM ? "At cap. A load test waits for a slot." : "At cap") +
      drawWeather("build-box-2", 3, 8, "fair", "Fair") +
      '<p class="gz-forecast">' + Crew.icon("clock", 13) + "<span><b>Forecast</b> build-box-1 should ease " + approx() + plusMin([W.eta.tSecrets.range[0], tp[1]]) + ", as 4 of its turns are expected to end.</span></p>" +
      "</section>" +
      '<section class="gz-box gz-tomorrow"><h3 class="gz-box-h">Later today, and tomorrow</h3><div class="gz-tom-g">' +
      '<div class="gz-tom-c"><h4 class="gz-tom-h">Expected this morning</h4><ul class="gz-tom-l">' +
      '<li data-pick="tResult"><span class="gz-tom-at">' + approx() + plusMin(tr) + "</span><span><b>Migrate payout endpoints to Result types</b> will likely ask you before its git push.</span></li>" +
      '<li data-pick="tCart"><span class="gz-tom-at">' + approx() + plusMin(tc) + "</span><span><b>Refactor cart totals</b> should finish its turn.</span></li>" +
      '<li data-pick="tPayout"><span class="gz-tom-at">' + approx() + plusMin(tp) + "</span><span><b>Payout report for September</b> should finish its turn, if you settle the refunds rule.</span></li>" +
      "</ul></div>" +
      '<div class="gz-tom-c"><h4 class="gz-tom-h">Scheduled</h4><ul class="gz-tom-l">' +
      '<li><span class="gz-tom-at">11:00</span><span><b>Triage</b> reads what came in since 09:00.</span></li>' +
      '<li><span class="gz-tom-at">Tomorrow 04:30</span><span><b>Nightly backup check</b>. It has hit its limit three nights running.</span></li>' +
      '<li><span class="gz-tom-at">Thursday</span><span>A Stripe payout of €18,240 arrives.</span></li>' +
      "</ul></div></div></section>" +
      "</div>" +
      '<footer class="gz-colophon"><span>The Bureau Gazette is printed when you come back after 30 minutes away, or when you ask. Headlines are written at the end of each turn; every story links to its thread, and every line to its source. A ' + approx() + ' marks a prediction.</span></footer>' +
      "</article>"
    );
  }

  function drawWeather(name, used, cap, kind, word) {
    return (
      '<div class="gz-wx"><span class="gz-wx-ic gz-wx-ic--' + kind + '">' + drawIcon(kind, 18) + '</span><span class="gz-wx-name">' + name + '</span><span class="gz-wx-meter"><i style="width:' + Math.round((used / cap) * 100) + '%"></i></span><span class="gz-wx-n">' + used + " of " + cap + '</span><span class="gz-wx-word">' + word + "</span></div>"
    );
  }

  /** Returns the mark of a prediction: a tilde, set so it never reads as a dash. */
  function approx() {
    return '<span class="gz-tilde" aria-label="about">~</span>';
  }

  function addMinutes(at, m) {
    var t = H.minutes(at) + m;
    return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  }

  /** Draws yesterday evening's edition: shorter, as the evening was. */
  function drawEvening() {
    var e = G.evening;
    var done = function (id) { return W.done.filter(function (d) { return d.id === id; })[0]; };
    return (
      '<article class="gz-paper gz-paper--evening" data-paper>' +
      '<header class="gz-mast">' +
      '<div class="gz-ear"><b>Evening edition</b><span>Monday</span><span>' + e.doneCount + " threads finished</span></div>" +
      '<h1 class="gz-title"><span class="gz-orn" aria-hidden="true"></span>The Bureau Gazette<span class="gz-orn" aria-hidden="true"></span></h1>' +
      '<div class="gz-ear gz-ear--r"><b>Kept</b><span>Old editions stay</span><span>readable</span></div>' +
      "</header>" +
      '<div class="gz-dateline"><span>Hercule</span><span>' + e.date + " · Evening edition · " + e.time + " · Printed for Rogier</span><span>Nothing needs you</span></div>" +
      '<div class="gz-row1">' +
      '<section class="gz-lead">' +
      '<span class="gz-st gz-st--lead gz-st--plain"><span class="gz-kick gz-kick--lead"><span class="proj proj--webshop">webshop</span> · ' + esc(e.lead.kicker.split(" · ")[1]) + "</span>" +
      '<h2 class="gz-h1">' + esc(e.lead.head) + "</h2>" +
      '<p class="gz-deck">' + esc(e.lead.deck) + "</p>" +
      '<p class="gz-byline gz-byline--lead">By ' + esc(e.lead.by) + " · with " + esc(e.lead.with) + "</p></span>" +
      '<p class="gz-archive">' + drawIcon("paper", 13) + "<span>Kept as printed at 18:20 on Monday, when you last checked. " + esc(done("dStripe14Review").title) + " finished with it. The morning edition carries a correction to this story.</span></p>" +
      "</section>" +
      '<aside class="gz-sign"><h3 class="gz-sign-h"><span>Needs your signature</span><b class="count">0</b></h3><p class="gz-sign-empty">Nothing waits on you tonight.</p></aside>' +
      "</div>" +
      '<div class="gz-row4 gz-row4--evening">' +
      '<section class="gz-box gz-brief"><h3 class="gz-box-h">In brief</h3><ul class="gz-brief-l">' +
      e.brief.map(function (b) {
        return '<li><span class="gz-st gz-st--plain"><span class="gz-brief-at">' + formatClock(b.at) + "</span><span>" + esc(b.text) + "</span></span></li>";
      }).join("") +
      "</ul></section>" +
      '<section class="gz-box gz-figs"><h3 class="gz-box-h">Figures of the day</h3><div class="gz-figs-g gz-figs-g--two">' +
      '<div class="gz-fg"><b class="deco-num">' + e.doneCount + '</b><span>threads marked Done</span></div>' +
      '<div class="gz-fg"><b class="deco-num">None</b><span>waiting on you at 18:20</span></div>' +
      "</div></section>" +
      '<section class="gz-box gz-tomorrow"><h3 class="gz-box-h">Tomorrow</h3><ul class="gz-tom-l">' +
      e.tomorrow.map(function (x) {
        return '<li><span class="gz-tom-at">' + x.at + "</span><span>" + esc(x.text) + "</span></li>";
      }).join("") +
      "</ul></section>" +
      "</div>" +
      '<footer class="gz-colophon"><span>An older edition, kept as printed. Its stories link to threads that are Done.</span></footer>' +
      "</article>"
    );
  }

  /** Draws the Front Page in the edition the switcher shows. */
  function drawFront() {
    var keep = els.press.scrollTop;
    els.press.innerHTML = edition === "evening" ? drawEvening() : drawMorning();
    els.press.scrollTop = keep;
    markFrontSelection(false);
  }

  function markFrontSelection(scroll) {
    var s = selectedStory();
    els.press.querySelectorAll(".is-sel").forEach(function (x) { x.classList.remove("is-sel"); });
    if (!s || !cardOn) return;
    var hits = els.press.querySelectorAll('[data-story="' + s.id + '"]');
    hits.forEach(function (x) { x.classList.add("is-sel"); });
    if (scroll && hits[0]) {
      var r = hits[0].getBoundingClientRect();
      var p = els.press.getBoundingClientRect();
      if (r.top < p.top + 60 || r.bottom > p.bottom - 40) els.press.scrollTop += r.top - p.top - 120;
    }
  }

  /* ================================================================== the selection card */

  /**
   * Returns who asks, when that is not the thread the card is about: "<b>lead</b> asks · " or
   * "<b>check</b> asks · ". Empty when the selected thread asks itself.
   */
  function drawAsker(ask, selected, s) {
    if (ask.id === selected.id) return "";
    var who = ask.id === s.lead.id ? "lead" : ask.role || "partner";
    return "<b>" + esc(who) + "</b> asks · ";
  }

  /** Draws the selection card, bottom left, shared by the Office and the Front Page. */
  function drawCard() {
    var s = selectedStory();
    var show = overviewOpen && mode !== "threads" && s && cardOn && !(mode === "front-page" && edition === "evening");
    els.card.hidden = !show;
    if (!show) return;
    var t = getThread(sel) || s.speaker;
    var ask = s.asks.filter(function (a) { return a.id === t.id; })[0] || s.asks[0];
    var answered = Object.keys(RT.answered).filter(function (id) { return s.members.some(function (m) { return m.id === id; }); })[0];
    var line = s.line;
    els.card.innerHTML =
      '<div class="gz-card-1">' + drawFace(t, 36) +
      '<div class="gz-card-t"><b>' + esc(t.title) + "</b><span>" +
      (s.project ? '<span class="proj proj--' + s.project.tint + '">' + esc(s.project.name) + "</span>" : '<span class="faint">' + (s.isRun ? "Run" : "No project") + "</span>") +
      (s.unreadCount ? '<span class="gz-card-new"><i class="gz-ink gz-ink--inline"></i>' + s.unreadCount + " new</span>" : "") +
      "</span></div>" +
      '<button type="button" class="icon-btn icon-btn--sm" data-unselect title="Clear the selection">' + Crew.icon("close", 13) + "</button></div>" +
      (ask
        ? '<div class="gz-card-ask">' + drawAsker(ask, t, s) + drawAskText(ask.ask) + "</div>"
        : line ? '<p class="gz-card-line">' + esc(line.text) + "</p>" : "") +
      '<div class="gz-card-acts">' +
      (ask ? drawAnswers(ask, "gz-card-ans", true) : answered ? drawAnswers(getThread(answered), "gz-card-ans") : '<span class="faint gz-card-at">' + (line ? formatClock(line.at) : "") + "</span>") +
      '<span class="spacer"></span><button type="button" class="btn btn--sm" data-open="' + t.id + '">Open thread' + Crew.icon("chev-r", 13) + "</button></div>";
  }

  /* ================================================================== the Office */

  /** Maps this window's states to the readings the Office module knows. */
  function officeState() {
    if (STATE === "open" || STATE === "swarm" || STATE === "everyday" || STATE === "away" || STATE === "replay" || STATE === "edition") return STATE;
    // Catch up reads the away morning; the Bureau stands at now, with what changed marked.
    if (STATE === "catchup" || STATE === "caughtup") return "edition";
    return "everyday";
  }

  function loadScript(src, done) {
    var s = document.createElement("script");
    s.src = src;
    s.onload = function () { done(true); };
    s.onerror = function () { done(false); };
    document.body.appendChild(s);
  }

  /** Shows the Office: the office builder's module when it is on disk, else a placeholder. Loads it the first time. */
  function showOffice() {
    if (office.handle) {
      office.handle.resume();
      office.handle.resize();
      if (sel) office.handle.select(sel);
      return;
    }
    if (!office.loading && !office.failed) {
      drawOfficePlaceholder("Loading the Bureau…");
      office.loading = true;
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "gazette-office.css";
      document.head.appendChild(css);
      var kitReady = window.OfficeKit ? function (cb) { cb(true); } : function (cb) { loadScript("../vendor/office-kit.js", cb); };
      kitReady(function (ok) {
        if (!ok) return officeFailed();
        loadScript("gazette-office.js", function (ok2) {
          office.loading = false;
          if (!ok2 || !window.OfficeModes || !window.OfficeModes.gazette) return officeFailed();
          mountOffice();
        });
      });
    }
  }

  function officeFailed() {
    office.loading = false;
    office.failed = true;
    drawOfficePlaceholder(null);
  }

  function mountOffice() {
    els.officeHost.innerHTML = "";
    try {
      office.handle = window.OfficeModes.gazette.mount(els.officeHost, {
        world: W,
        theme: root.dataset.theme === "orient-express" || root.dataset.theme === "dark" ? "orient-express" : "whitehaven",
        state: officeState(),
        selected: sel,
        reducedMotion: REDUCED,
        onSelect: function (id) { select(id, { fromOffice: true }); },
        onOpen: function (id) { openThread(id); },
      });
      if (mode !== "office") office.handle.pause();
    } catch (err) {
      console.error(err);
      office.handle = null;
      officeFailed();
    }
  }

  function drawOfficePlaceholder(loading) {
    els.officeHost.innerHTML =
      '<div class="gz-oph"><div class="gz-oph-in">' +
      '<svg viewBox="0 0 220 120" class="gz-oph-svg" aria-hidden="true">' +
      '<path d="M20 86L110 40l90 46-90 46z" fill="var(--room-floor)" stroke="var(--line)"/>' +
      '<path d="M20 86V54L110 8v32zM110 8l90 46v32l-90-46z" fill="var(--room-wall)" stroke="var(--line)"/>' +
      '<g transform="translate(64 54)">' + Crew.face("Refactor cart totals", { pose: "working", size: 26 }) + "</g>" +
      '<g transform="translate(100 66)">' + Crew.face("Fix 3-D Secure checkout for EU cards", { pose: "waiting", size: 26 }) + "</g>" +
      '<g transform="translate(138 56)">' + Crew.face("Rotate staging secrets", { pose: "working", size: 26 }) + "</g>" +
      '<g transform="translate(46 30)"><rect width="56" height="16" rx="8" fill="var(--raised)" stroke="var(--line)"/><text x="28" y="11" text-anchor="middle" font-size="8" fill="var(--muted)" font-family="var(--font-ui)">editing totals.ts</text></g>' +
      "</svg>" +
      '<h3 class="gz-oph-h">The Bureau, rewindable</h3>' +
      '<p class="gz-oph-p">Thought bubbles over working beans, desks that remember the day, and a time dial from 07:00 to now that replays the morning.</p>' +
      '<p class="gz-oph-note">' + (loading ? esc(loading) : "The Office module (gazette-office.js) is not on disk yet. The Wire and the Front Page work without it.") + "</p>" +
      "</div></div>";
  }

  /* ================================================================== arrivals: the "3 new" pill */

  /** Applies an arrival: the turn ends, its headline is news, the thread goes idle. */
  function applyArrival(a) {
    var t = getThread(a.id);
    RT.ended[a.id] = true;
    RT.extra[a.id] = (RT.extra[a.id] || []).concat([{ at: a.at, text: a.text, end: "idle" }]);
    t.pose = "idle";
    t.status = null;
    t.last = a.at;
  }

  /** Lets the held-back stories in, and lets the rows settle. Rows that moved flash once. */
  function flush() {
    var arrived = pending.slice();
    pending = [];
    arrived.forEach(applyArrival);
    var before = layout;
    pointerIn = false;
    layout = null;
    stories = buildStories();
    layout = computeLayout(stories);
    arrived.forEach(function (a) {
      var s = stories[getThread(a.id).lead || a.id];
      if (s) s.fresh = true;
    });
    if (before) {
      ["needs", "news", "quiet"].forEach(function (k) {
        layout[k].forEach(function (id, i) {
          if (before[k][i] !== id && stories[id]) stories[id].fresh = true;
        });
      });
    }
    drawAll();
    setTimeout(function () {
      Object.keys(stories).forEach(function (k) { delete stories[k].fresh; });
    }, 1400);
  }

  /** Brings one demo arrival: straight in when the pointer is outside the lists, else into the pill. */
  function arrive(a) {
    if (pointerIn) {
      pending.push(a);
      drawSidebar();
      if (overviewOpen && mode === "threads") drawThreads();
      return;
    }
    pending.push(a);
    flush();
  }

  function watchPointer(list) {
    list.addEventListener("pointerenter", function () { pointerIn = true; });
    list.addEventListener("pointerleave", function () {
      pointerIn = false;
      if (pending.length) flush();
      else refresh();
    });
  }

  /* ================================================================== events */

  function onClick(e) {
    var t = e.target.closest("button, a, [data-row], [data-pick], li[data-pick]");
    if (!t) return;
    var d = t.dataset;
    if (d.flush !== undefined) { e.preventDefault(); return flush(); }
    if (d.answer) { e.preventDefault(); e.stopPropagation(); return answer(d.answer, Number(d.index)); }
    if (d.mode) return setMode(d.mode);
    if (d.edition) { edition = d.edition; drawTop(); drawFront(); drawCard(); return; }
    if (d.print !== undefined) return reprint();
    if (d.close !== undefined) return setOverview(false);
    if (d.catchup !== undefined) { e.preventDefault(); return startCatchup(); }
    if (d.stop !== undefined) return stopCatchup();
    if (d.goto) { stopCatchup(); return setMode(d.goto); }
    if (d.next !== undefined) return goNext();
    if (d.done) return markDone(d.done);
    if (d.snooze) return snooze(d.snooze);
    if (d.unselect !== undefined) { cardOn = false; sel = null; drawSidebar(); drawCard(); markFrontSelection(false); return; }
    if (d.open) { e.preventDefault(); return openThread(d.open); }
    if (d.row) {
      e.preventDefault();
      var s = stories[d.row];
      if (!s) return;
      if (overviewOpen) {
        if (catchup) stopCatchup();
        return select(primaryOf(s));
      }
      return openThread(primaryOf(s));
    }
    if (d.pick) {
      e.preventDefault();
      if (catchup && catchup.i >= catchup.list.length) catchup = null;
      var ps = stories[d.pick] || storyOfThread(d.pick);
      if (ps) select(primaryOf(ps));
    }
  }

  function onDoubleClick(e) {
    var t = e.target.closest("[data-pick], [data-row]");
    if (!t) return;
    var id = t.dataset.pick || t.dataset.row;
    var s = stories[id] || storyOfThread(id);
    if (s) openThread(primaryOf(s));
  }

  function goNext() {
    if (catchup) return nextCatchup();
    var s = selectedStory();
    var next = neighbour(s ? s.id : null, 1);
    if (next) select(primaryOf(stories[next]));
  }

  function goPrev() {
    var s = selectedStory();
    var prev = neighbour(s ? s.id : null, -1);
    if (prev) select(primaryOf(stories[prev]));
  }

  function reprint() {
    edition = "morning";
    drawTop();
    drawFront();
    var p = els.press.querySelector("[data-paper]");
    if (!p || REDUCED) return toast("Printed a new edition at 09:41");
    p.classList.remove("is-printing");
    void p.offsetWidth;
    p.classList.add("is-printing");
    els.press.scrollTop = 0;
  }

  function onKey(e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    var k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === "o") {
      e.preventDefault();
      return setOverview(!overviewOpen);
    }
    if (e.altKey && /^Digit[123]$/.test(e.code)) {
      e.preventDefault();
      if (!overviewOpen) setOverview(true);
      return setMode(MODES[Number(e.code.slice(5)) - 1]);
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (k === "escape") {
      if (catchup) return stopCatchup();
      if (overviewOpen) return setOverview(false);
      return;
    }
    if (k === "j") { e.preventDefault(); return goNext(); }
    if (k === "k") { e.preventDefault(); return goPrev(); }
    if (k === "c") { e.preventDefault(); return startCatchup(); }
    var s = selectedStory();
    if (!s) return;
    if (k === "enter" && overviewOpen) { e.preventDefault(); return openThread(primaryOf(s)); }
    if (k === "e") { e.preventDefault(); return markDone(s.id); }
    if (k === "s") { e.preventDefault(); return snooze(s.id); }
  }

  /* ================================================================== the open thread */

  /** Draws the run step's own page when it is opened: the run's steps and the Request. */
  function drawRunMain(mainEl, t) {
    if (!t || !t.isRunStep) return false;
    var run = W.runs.filter(function (r) { return r.id === t.run; })[0];
    mainEl.innerHTML =
      '<header class="top"><nav class="pill"><span class="pill-crumb"><span class="proj proj--payments">payments-api</span></span><span class="pill-title">' + esc(run.title) + '</span></nav><span class="spacer"></span></header>' +
      '<div class="gz-runpage"><div class="gz-runpage-in">' +
      '<div class="gz-runpage-h">' + Crew.face("Ship release v2.15", { pose: "waiting", size: 40 }) + "<div><b>" + esc(run.title) + '</b><span class="muted">Ship release · started ' + run.started + " by you · build-box-2</span></div></div>" +
      '<ol class="gz-steps">' + run.steps.map(function (st) {
        var m = st.state === "completed" ? Crew.mark("done", 14) : st.state === "waiting" ? Crew.mark("waiting", 14) : '<span class="gz-step-todo"></span>';
        return '<li class="gz-step gz-step--' + st.state + '">' + m + "<span>" + esc(st.label) + "</span>" + (st.state === "waiting" ? '<span class="you-ink">waits on you since 09:33</span>' : "") + "</li>";
      }).join("") + "</ol>" +
      '<div class="gz-ask">' + Crew.face("Ship release v2.15", { pose: "waiting", size: 34 }) + '<div class="gz-ask-body"><div class="gz-ask-who">publish · Claude Code · Sonnet 5</div><div class="gz-ask-q">' + esc(t.ask || RT.answered.rShip && RT.answered.rShip.ask) + "</div>" + drawAnswers(t) + "</div></div>" +
      "</div></div>";
    return true;
  }

  /**
   * Marks where each headline came from in the open thread: after the agent's message at a
   * headline's time, a small rule carries the headline, so the Wire's line has a visible source.
   */
  function markHeadlines(id) {
    var t = getThread(id);
    if (!t) return;
    var main = api.els.main;
    var list = listHeadlines(id).filter(function (h) { return !h.running && !h.you; });
    var msgs = main.querySelectorAll(".msg");
    list.forEach(function (h) {
      for (var i = 0; i < msgs.length; i++) {
        var meta = msgs[i].querySelector(".msg-meta");
        if (meta && meta.textContent.slice(-5) === h.at.slice(-5)) {
          var rule = document.createElement("div");
          rule.className = "gz-hrule";
          rule.innerHTML = drawIcon("paper", 13) + "<span><b>Headline " + h.at + "</b> " + esc(h.text) + "</span>";
          msgs[i].after(rule);
          return;
        }
      }
    });
  }

  /* ================================================================== boot */

  function applyStatePresets() {
    if (STATE === "catchup" || STATE === "caughtup") {
      var list = listCatchup(buildStories());
      G.catchup.answered.forEach(function (a) { answer(a.thread, a.answer, true); });
      if (STATE === "caughtup") {
        answer("tPayoutCheck", 0, true);
        catchup = { list: list, i: list.length, started: Date.now(), elapsedBase: 0, finished: G.catchup.end.elapsed, tally: G.catchup.end, endTally: G.catchup.end };
        ["tResult", "tCart", "tA11y", "aTables", "aRust"].forEach(markRead);
        RT.snoozed.aTables = true;
        RT.done.aRust = true;
        RT.done.tA11y = true;
        sel = "tResult";
      } else {
        catchup = { list: list, i: G.catchup.step, started: Date.now(), elapsedBase: G.catchup.elapsed, tally: { answered: 3, done: 0, snoozed: 0, read: 0 } };
        sel = "tPayoutCheck";
      }
    }
  }

  Stage.direction({
    rootClass: "ov-gazette",
    initial: function () { return "t3ds"; },
    drawList: function (listEl, stageApi) {
      api = stageApi;
      els.list = listEl;
    },
    drawMain: function (mainEl, t) {
      return drawRunMain(mainEl, t);
    },
    onOpen: function (id) {
      if (!els.ov) return;
      sel = id;
      markHeadlines(id);
      drawSidebar();
    },
    boot: function (stageApi) {
      api = stageApi;
      // The Stage knows the morning's threads; Gazette also opens the assistants' two and the run step.
      W.assistantThreads.forEach(function (t) {
        t.fromTask = G.provenance[t.id];
        W.transcripts[t.id] = G.transcripts[t.id];
      });
      api.restoreThreads(W.assistantThreads.concat([runStep]));
      buildOverview();
      els.officeBtn = api.els.side.querySelector('.side-actions .icon-btn[title^="The office"]');
      if (els.officeBtn) {
        els.officeBtn.title = "Overview ⌘⇧O";
        els.officeBtn.addEventListener("click", function () { setOverview(!overviewOpen); });
      }
      applyStatePresets();
      stories = buildStories();
      layout = computeLayout(stories);
      if (STATE === "arrivals") {
        pointerIn = true;
        pending = G.arrivals.slice();
      }
      if (params.get("edition") === "evening") edition = "evening";
      var selParam = params.get("select");
      if (selParam && getThread(selParam)) sel = selParam;
      if (!sel) {
        var first = layout.needs[0] || layout.news[0];
        sel = first ? primaryOf(stories[first]) : "t3ds";
      }
      var m = params.get("mode");
      var defaults = { edition: "front-page", replay: "office", open: null };
      mode = MODES.indexOf(m) !== -1 ? m : defaults[STATE] !== undefined ? defaults[STATE] || "threads" : "threads";
      if (STATE === "open") {
        sel = "t3ds";
        drawAll();
        markHeadlines("t3ds");
        if (MODES.indexOf(m) !== -1) setOverview(true);
      } else {
        drawAll();
        setOverview(true);
      }
      watchPointer(els.list);
      watchPointer(els.wire);
      document.addEventListener("click", onClick);
      document.addEventListener("dblclick", onDoubleClick);
      document.addEventListener("keydown", onKey);
      if (catchup && catchup.finished == null) tickCatchup();
      if (STATE === "everyday" && params.get("demo") !== "off") {
        G.arrivals.forEach(function (a, i) {
          setTimeout(function () { arrive(a); }, 7000 + i * 3500);
        });
      }
      window.addEventListener("resize", function () {
        if (office.handle) office.handle.resize();
      });
    },
  });
})();
