// PROTOTYPE - the stage every sidebar direction draws on: the desktop window, the parts of the
// sidebar every direction keeps (top strip, face switch, New thread, foot, assistants), and the
// open thread in the main pane. A direction draws its own thread list, and may replace the main
// pane's header or the whole main pane.
//
// Load order in a screen page (desktop.html):
//   ../../shared/page.js, ../shared/world.js, ../shared/stage.js, the direction's own script,
//   then ../../crew-bureau-2/brands.js and ../../crew-bureau-2/crew.js last.
// crew.js boots on DOMContentLoaded; the stage builds the window from its own DOMContentLoaded
// listener, which runs first because it was registered first.
//
// A direction registers itself with Stage.direction({...}) (see the bottom of this file).
(function () {
  "use strict";

  var W = window.WORLD;
  var params = new URLSearchParams(location.search);
  var STATE = document.documentElement.dataset.state || params.get("state") || "everyday";

  /* ------------------------------------------------------------------ the world, read */

  var threads = W.threads.slice();
  if (STATE === "swarm") threads = threads.concat(W.swarm.threads);

  var exchanges = W.exchanges.slice();

  /** Returns the thread with this id, or undefined. */
  function getThread(id) {
    for (var i = 0; i < threads.length; i++) if (threads[i].id === id) return threads[i];
    for (var j = 0; j < W.done.length; j++) if (W.done[j].id === id) return W.done[j];
    if (W.spawn.thread.id === id) return W.spawn.thread;
    return undefined;
  }

  /** Returns the threads that match a predicate, in the world's order. */
  function listThreads(predicate) {
    return threads.filter(predicate || function () { return true; });
  }

  /** Returns the lead of a thread: the thread itself when it is a lead or alone. */
  function findLead(t) {
    return t.lead ? getThread(t.lead) : t;
  }

  /** Returns a lead's partners, oldest first. Empty for a thread alone. */
  function listPartners(leadId) {
    return threads
      .filter(function (t) { return t.lead === leadId; })
      .sort(function (a, b) { return compareTimes(a.started, b.started); });
  }

  /** Returns a lead and its partners: the lead first, then the partners oldest first. */
  function listCrew(leadId) {
    return [getThread(leadId)].concat(listPartners(leadId));
  }

  /** Returns the leads of a project (null for "No project"), newest started first. */
  function listLeads(projectId) {
    return threads
      .filter(function (t) { return !t.lead && t.project === projectId; })
      .sort(function (a, b) { return compareTimes(b.started, a.started); });
  }

  // How urgent each pose is when one thread speaks for several: the first pose wins.
  var URGENCY = ["waiting", "failed", "working", "idle", "paused", "asleep", "away", "done"];

  /**
   * Returns the thread that speaks for a group: the most urgent by pose, and among equals the
   * one with the newest activity. Used for a piece of work's status and for where a click on
   * that status goes.
   */
  function pickSpokesperson(list) {
    return list.slice().sort(function (a, b) {
      var d = URGENCY.indexOf(a.pose) - URGENCY.indexOf(b.pose);
      if (d) return d;
      if (a.status === "queued" && b.status !== "queued") return 1;
      if (b.status === "queued" && a.status !== "queued") return -1;
      return compareTimes(b.last, a.last);
    })[0];
  }

  /* ------------------------------------------------------------------ time */

  var DAY_OFFSET = { yesterday: -1, Mon: -1, Sun: -2, Sat: -3 };

  /** Converts "HH:MM", "yesterday HH:MM" or "Mon HH:MM" to minutes since midnight today. */
  function toMinutes(time) {
    var parts = String(time).split(" ");
    var hm = parts[parts.length - 1].split(":");
    var day = parts.length > 1 ? DAY_OFFSET[parts[0]] || 0 : 0;
    return day * 1440 + Number(hm[0]) * 60 + Number(hm[1]);
  }

  function compareTimes(a, b) {
    return toMinutes(a) - toMinutes(b);
  }

  /** Returns minutes from a time to now (09:41). */
  function minutesAgo(time) {
    return toMinutes(W.now) - toMinutes(time);
  }

  /** Returns the age label of a time: "now", "4m", "2h", "3d". */
  function formatAge(time) {
    var m = minutesAgo(time);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    if (m < 1440) return Math.floor(m / 60) + "h";
    return Math.floor(m / 1440) + "d";
  }

  /* ------------------------------------------------------------------ what a row shows */

  /**
   * Returns a thread's status slot, as spec 17 draws it: { kind, text }. Kind is "working",
   * "approval", "question", "queued" or "age".
   */
  function decideSlot(t) {
    if (t.status === "approval") return { kind: "approval", text: "Approval" };
    if (t.status === "question") return { kind: "question", text: "Question" };
    if (t.status === "working") return { kind: "working", text: "Working" };
    if (t.status === "queued") return { kind: "queued", text: "Queued" };
    return { kind: "age", text: formatAge(t.last) };
  }

  /**
   * Returns where a thread works, in the row's two parts (spec 17): the branch a person named,
   * else "<repo> · <machine>" for a main workspace, else the machine.
   */
  function describePlace(t) {
    var ws = W.workspaces[t.workspace] || { kind: t.branch ? "worktree" : "none", branch: t.branch, machine: t.machine };
    var machine = ws.machine || t.machine;
    if (ws.kind === "worktree" && ws.branch) return { clip: ws.branch, keep: "" };
    if (ws.kind === "main") return { clip: ws.repo, keep: " · " + machine };
    if (ws.kind === "scratch") return { clip: "scratch", keep: " · " + machine };
    return { clip: "", keep: machine };
  }

  /** Returns the machine a thread runs on. */
  function findMachine(t) {
    var ws = W.workspaces[t.workspace];
    return (ws && ws.machine) || t.machine || "studio-mac";
  }

  /** Returns the thread's branch, or null when it works in no checkout. */
  function findBranch(t) {
    var ws = W.workspaces[t.workspace];
    return (ws && ws.branch) || t.branch || null;
  }

  /** Returns the provider's name and model, "Codex · gpt-5.4". */
  function describeAgent(t) {
    return W.providers[t.provider].name + " · " + t.model;
  }

  /** Returns the markup of a thread's face. The title seeds it, as in the book. */
  function drawFace(t, size, pose) {
    return Crew.face(t.title, { pose: pose || t.pose, size: size || 24 });
  }

  /** Returns the markup of a thread's provider mark. */
  function drawBrand(t, size) {
    return Crew.brand(W.providers[t.provider].brand, size || 12);
  }

  /**
   * Returns today's thread row (spec 17, #626): 52px, the title and its status word, then the
   * provider's mark and where the thread works. A direction draws a thread that is alone with
   * it, so a lone thread looks exactly as it does today. Options:
   *   selected   draws the row as the open thread's
   *   title      replaces the title text (markup)
   *   detail     replaces the second line after the mark (markup)
   *   cls        extra classes on the row's wrapper
   */
  function drawThreadRow(t, opts) {
    opts = opts || {};
    var slot = decideSlot(t);
    var place = describePlace(t);
    var receded = t.pose === "working" && !opts.selected;
    var detail = opts.detail != null ? opts.detail : '<span class="st-clip">' + escapeHtml(place.clip) + '</span><span class="st-keep">' + escapeHtml(place.keep) + "</span>";
    return (
      '<div class="st-thread' + (receded ? " is-receded" : "") + (opts.cls ? " " + opts.cls : "") + '" data-thread="' + t.id + '">' +
      '<a class="side-row' + (opts.selected ? " is-on" : "") + '" href="#" data-open-row="' + t.id + '">' +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name">' + (opts.title != null ? opts.title : escapeHtml(t.title)) + '</span><span class="side-end st-end--' + slot.kind + '">' + slot.text + "</span></span>" +
      '<span class="st-detail"><span class="st-glyph">' + drawBrand(t, 12) + "</span>" + detail + "</span>" +
      "</span></a></div>"
    );
  }

  /** Returns the exchanges between the threads of one lead's crew, oldest first. */
  function listExchanges(leadId) {
    var ids = listCrew(leadId).map(function (t) { return t.id; });
    return exchanges.filter(function (e) { return ids.indexOf(e.from) !== -1 && ids.indexOf(e.to) !== -1; });
  }

  /** Returns the project record of an id. */
  function getProject(id) {
    for (var i = 0; i < W.projects.length; i++) if (W.projects[i].id === id) return W.projects[i];
    return null;
  }

  /** Returns the foot's counts over the live threads: working, waiting and idle (asleep and away are not counted). */
  function countByPose() {
    var c = { working: 0, waiting: 0, idle: 0 };
    threads.forEach(function (t) {
      if (c[t.pose] !== undefined) c[t.pose]++;
    });
    return c;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  /* ------------------------------------------------------------------ the window */

  var dir = null; // the registered direction
  var openId = null;
  var listeners = [];
  var els = {};

  /**
   * Builds the window into <body>: the sidebar's fixed parts with an empty list for the direction,
   * and the main pane. The sidebar's list is `els.list`; the direction draws it.
   */
  function buildWindow() {
    var body = document.body;
    var app = document.createElement("div");
    app.className = "app stage" + (dir && dir.rootClass ? " " + dir.rootClass : "");
    app.innerHTML =
      '<aside class="side stage-side">' +
      '<div class="side-top"><span class="tl"><i></i><i></i><i></i></span><button class="icon-btn" title="Hide the sidebar ⌘B">' + Crew.icon("sidebar") + "</button></div>" +
      '<div class="seg seg--side" role="tablist"><button role="tab" aria-selected="true">Threads</button><button role="tab" aria-selected="false">Hercule <b class="count count--you stage-intake">9</b></button></div>' +
      '<div class="side-actions"><a class="nav-row" href="#">' + Crew.icon("compose") + "<span>New thread</span><kbd>⌘N</kbd></a>" +
      '<button class="icon-btn" title="Search ⌘K">' + Crew.icon("search") + '</button><button class="icon-btn" title="The office ⌘⇧O">' + Crew.icon("office") + "</button></div>" +
      '<div class="side-scroll stage-list" data-list></div>' +
      '<div class="stage-assistants" data-assistants></div>' +
      '<div class="side-foot"><div class="side-sum" data-sum></div><div class="side-me">' + Crew.you(24) + '<span class="side-name">Rogier</span><button class="icon-btn icon-btn--sm" title="Settings">' + Crew.icon("sliders", 14) + "</button></div></div>" +
      "</aside>" +
      '<main class="main stage-main" data-main></main>';
    body.insertBefore(app, body.firstChild);
    els.app = app;
    els.side = app.querySelector(".stage-side");
    els.list = app.querySelector("[data-list]");
    els.assistants = app.querySelector("[data-assistants]");
    els.sum = app.querySelector("[data-sum]");
    els.main = app.querySelector("[data-main]");
    drawAssistants();
    drawSum();
  }

  function drawAssistants() {
    els.assistants.innerHTML =
      '<h3 class="side-h"><span>Assistants</span></h3>' +
      W.assistants.map(function (a) {
        return '<a class="side-row side-row--who" href="#">' + Crew.face(a.name, { pose: a.pose, size: 22 }) + '<span class="side-name">' + a.name + '</span><span class="side-end side-presence">' + Crew.poseWord(a.pose) + "</span></a>";
      }).join("");
  }

  /** Draws the foot's counts. */
  function drawSum() {
    var c = countByPose();
    els.sum.innerHTML = "<b>" + c.working + "</b> working · <b" + (c.waiting ? ' class="you-ink"' : "") + ">" + c.waiting + "</b> waiting · <b>" + c.idle + "</b> idle";
  }

  /* ------------------------------------------------------------------ the main pane */

  /** Returns the tabs of the header for a thread: the threads of its workspace, as today's app draws them. */
  function listWorkspaceThreads(t) {
    if (!t.workspace || t.workspace === "none" || (W.workspaces[t.workspace] && W.workspaces[t.workspace].kind === "main")) return [t];
    return threads.filter(function (x) { return x.workspace === t.workspace; }).sort(function (a, b) { return compareTimes(a.started, b.started); });
  }

  /** Returns the default header: the crumb, one tab per thread of the workspace, a +, and the right-hand pills. */
  function drawHeader(t) {
    var p = getProject(t.project);
    var tabs = listWorkspaceThreads(t);
    return (
      '<header class="top">' +
      '<nav class="pill" aria-label="Threads in this workspace">' +
      '<span class="pill-crumb">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj">No project</span>') + "</span>" +
      tabs.map(function (x) {
        var mark = x.pose === "waiting" ? Crew.mark("waiting") : x.pose === "working" ? Crew.mark("working") : Crew.mark("idle");
        var age = x.pose === "idle" ? "<small>" + formatAge(x.last) + "</small>" : "";
        return '<a class="ptab' + (x.id === t.id ? " is-on" : "") + '" href="#" data-open="' + x.id + '">' + mark + escapeHtml(x.title) + age + "</a>";
      }).join("") +
      '<button class="icon-btn" title="New thread in this workspace">' + Crew.icon("plus") + "</button>" +
      "</nav>" +
      '<span class="spacer"></span>' +
      '<span class="pill"><button class="icon-btn" title="Side pane">' + Crew.icon("sidebar") + "</button></span>" +
      '<span class="pill"><button class="icon-btn" title="Open in editor">' + Crew.icon("editor") + "</button></span>" +
      '<span class="pill"><button class="icon-btn" title="More">' + Crew.icon("more") + "</button></span>" +
      "</header>"
    );
  }

  /** Returns the markup of one exchange card in a transcript: a message another thread sent, or one this thread sent. */
  function drawExchangeCard(item, t) {
    var other = getThread(item.from || item.sent);
    if (!other) return "";
    var incoming = !!item.from;
    var who = other.lead === t.id ? other.role : other.id === t.lead ? "lead" : other.role || "";
    return (
      '<div class="stage-x stage-x--' + (incoming ? "in" : "out") + '">' +
      '<div class="stage-x-head">' +
      (incoming ? "" : '<span class="stage-x-dir">Sent to</span>') +
      drawFace(other, 18, other.pose === "waiting" ? "idle" : other.pose) +
      '<a href="#" class="stage-x-name" data-open="' + other.id + '">' + escapeHtml(other.title) + "</a>" +
      (who ? '<span class="stage-x-role">' + escapeHtml(who) + "</span>" : "") +
      '<span class="stage-x-at">' + item.at + "</span>" +
      "</div>" +
      '<p class="stage-x-text">' + escapeHtml(item.text) + "</p>" +
      "</div>"
    );
  }

  /** Returns a transcript for any thread: its own when the world has one, else its opening and where it stands. */
  function buildTranscript(t) {
    var own = W.transcripts[t.id];
    if (own) return own;
    var items = [];
    var brief = exchanges.filter(function (e) { return e.to === t.id && e.kind === "brief"; })[0];
    if (brief) items.push({ from: brief.from, at: brief.at, text: brief.text, opening: true });
    else items.push({ me: t.title + ".", at: t.started });
    items.push({ worked: "Worked for " + Math.max(1, Math.min(9, Math.round(minutesAgo(t.started) / 6))) + "m", tools: ["read 5 files", "ran 2 commands"] });
    if (t.result) items.push({ agent: true, at: t.last, html: escapeHtml(t.result) });
    if (t.pose === "waiting") items.push({ waiting: "Waiting on you since " + t.last + " · " + formatAge(t.last) });
    if (t.pose === "working") items.push({ worked: "Working", tools: [], live: true });
    return items;
  }

  /** Returns the transcript's markup. */
  function drawTranscript(t) {
    var items = buildTranscript(t);
    var faceName = t.title;
    return (
      '<div class="transcript" data-transcript><div class="column stage-tx">' +
      (t.fromTask ? '<div class="provenance"><span>Started ' + t.started + " from</span><a href=\"#\">" + Crew.icon("intake", 13) + escapeHtml(t.fromTask) + Crew.icon("external", 12) + "</a></div>" : "") +
      items.map(function (it) {
        if (it.me) return '<div class="msg--me"><div><div class="bubble">' + escapeHtml(it.me) + '</div><div class="bubble-meta">' + it.at + "</div></div></div>";
        if (it.from || it.sent) return drawExchangeCard(it, t);
        if (it.worked) return '<div class="worked' + (it.live ? " stage-live" : "") + '"><b>' + it.worked + (it.live ? "" : " ›") + '</b><span class="tools">' + it.tools.map(function (x) { return "<span>" + x + "</span>"; }).join("") + "</span></div>";
        if (it.agent) return '<div class="msg">' + Crew.face(faceName, { pose: "idle", size: 34 }) + '<div class="msg-body"><div class="msg-meta">' + describeAgent(t) + " · " + it.at + "</div><p>" + it.html + "</p></div></div>";
        if (it.files) {
          var o = W.output[it.files];
          return '<div class="msg stage-files">' + Crew.face(faceName, { pose: "idle", size: 34 }) + '<div class="msg-body"><div class="card files"><div class="files-head">' + Crew.icon("diff") + "<span>" + o.files + ' changed files</span><span class="plus mono">+' + o.plus + '</span><span class="minus mono">-' + o.minus + '</span><span class="spacer"></span><button class="btn btn--quiet btn--sm">Show files</button><button class="btn btn--sm">Open diff</button></div>' +
            '<div class="files-row"><span>src/checkout/payment.ts</span><span class="spacer"></span><span class="plus">+21</span><span class="minus">-9</span></div>' +
            '<div class="files-row"><span>src/checkout/payment.test.ts</span><span class="spacer"></span><span class="plus">+19</span><span class="minus">-0</span></div>' +
            '<div class="files-row"><span>src/checkout/3ds-modal.tsx</span><span class="spacer"></span><span class="plus">+8</span><span class="minus">-3</span></div></div></div></div>';
        }
        if (it.result) return '<div class="result stage-result"><b>✓ ' + it.result + "</b><code>" + it.cmd + "</code></div>";
        if (it.waiting) return '<div class="stage-waiting-note">' + Crew.mark("waiting") + it.waiting + "</div>";
        return "";
      }).join("") +
      "</div></div>"
    );
  }

  /** Returns the composer, with the Request docked on it while the thread waits on Rogier. */
  function drawComposer(t) {
    var dock = "";
    if (t.status === "approval") {
      var cmd = t.ask.replace(/^Run /, "").replace(/\?$/, "");
      dock =
        '<div class="dock"><div class="dock-q">' + Crew.face(t.title, { pose: "waiting", size: 30 }) + "<span>Run <code>" + escapeHtml(cmd) + "</code>?</span></div>" +
        '<div class="ledger">' +
        '<button class="ans"><span class="btn btn--accent btn--sm">Allow once</span><span class="ans-desc">Runs the command this once; the agent asks again next time.</span><kbd>↩</kbd></button>' +
        '<button class="ans"><span class="btn btn--sm">Allow always</span><span class="ans-desc">Runs the command and stops asking for it while this thread keeps running.</span><kbd>⌥↩</kbd></button>' +
        '<button class="ans"><span class="btn btn--quiet btn--sm">Deny</span><span class="ans-desc">Denies the command; the agent is told and continues.</span><kbd>esc</kbd></button>' +
        "</div></div>";
    } else if (t.status === "question") {
      dock =
        '<div class="dock"><div class="dock-q">' + Crew.face(t.title, { pose: "waiting", size: 30 }) + "<span>" + escapeHtml(t.ask) + "</span></div>" +
        '<div class="ledger stage-options"><button class="ans"><span class="btn btn--sm">Answer in the composer</span><span class="ans-desc">Type the answer below; the agent continues with it.</span><kbd>↩</kbd></button></div></div>';
    }
    var place = describePlace(t);
    var ws = W.workspaces[t.workspace] || {};
    var lipLeft = ws.kind === "worktree" ? "<span>" + Crew.icon("worktree", 13) + "Own worktree</span><span>" + Crew.icon("branch", 13) + '<span class="mono">' + ws.branch + '</span> <span class="faint">from main</span></span>' : ws.kind === "main" ? "<span>" + Crew.icon("worktree", 13) + "Main workspace · " + ws.repo + "</span>" : ws.kind === "scratch" ? "<span>" + Crew.icon("worktree", 13) + "Scratch workspace</span>" : "<span>" + Crew.icon("worktree", 13) + "No workspace</span>";
    return (
      '<div class="composer-wrap"><div class="composer" data-composer>' +
      dock +
      '<div class="composer-card"><textarea class="composer-input" rows="1" placeholder="' + (t.pose === "working" ? "Queued until the turn finishes…" : "Reply or steer…") + '"></textarea>' +
      '<div class="composer-row"><button class="icon-btn" title="Attach">' + Crew.icon("plus") + '</button><button class="pick">' + Crew.icon("shield", 14) + 'Auto-accept edits</button><button class="pick">' + Crew.icon("sliders", 14) + 'High</button><span class="spacer"></span>' +
      '<button class="pick pick--pill">' + drawBrand(t, 13) + t.model + '</button><button class="icon-btn" title="Dictate">' + Crew.icon("mic") + "</button>" +
      (t.pose === "working" ? '<button class="send stage-stop" title="Stop">' + Crew.icon("stop") + "</button>" : '<button class="send send--off" title="Send">' + Crew.icon("send") + "</button>") +
      "</div></div>" +
      '<div class="lip">' + lipLeft + '<span class="spacer"></span><span>' + Crew.icon("laptop", 13) + findMachine(t) + "</span></div>" +
      "</div></div>"
    );
    // `place` is kept for directions that want the row's wording in the lip.
  }

  /** Draws the main pane for the open thread: the direction's own, or the default header, transcript and composer. */
  function drawMain() {
    var t = getThread(openId);
    if (dir && dir.drawMain && dir.drawMain(els.main, t, api) !== false) return finishMain();
    var header = dir && dir.drawHeader ? dir.drawHeader(t, api) : null;
    els.main.innerHTML = (header || drawHeader(t)) + drawTranscript(t) + drawComposer(t);
    finishMain();
  }

  function finishMain() {
    els.main.querySelectorAll("[data-open]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        open(a.dataset.open);
      });
    });
    var tx = els.main.querySelector("[data-transcript]");
    if (tx) tx.scrollTop = tx.scrollHeight;
  }

  /* ------------------------------------------------------------------ opening and events */

  /** Opens a thread: the main pane draws it and the direction is told, so it can mark the row. */
  function open(id) {
    if (!getThread(id)) return;
    openId = id;
    drawMain();
    listeners.forEach(function (fn) { fn(id); });
    if (dir && dir.onOpen) dir.onOpen(id, api);
  }

  /**
   * Adds the spawn state's partner to the world, as if the lead started it now. Returns the new
   * thread. The direction draws the moment; call it again after Stage.resetSpawn() to replay.
   */
  function spawnPartner() {
    if (!getThreadLive(W.spawn.thread.id)) {
      threads.push(W.spawn.thread);
      exchanges.push(W.spawn.exchange);
    }
    drawSum();
    return W.spawn.thread;
  }

  /** Takes the spawn state's partner out of the world again, so the moment can replay. */
  function resetSpawn() {
    threads = threads.filter(function (t) { return t.id !== W.spawn.thread.id; });
    exchanges = exchanges.filter(function (e) { return e !== W.spawn.exchange; });
    drawSum();
  }

  function getThreadLive(id) {
    for (var i = 0; i < threads.length; i++) if (threads[i].id === id) return threads[i];
    return undefined;
  }

  /**
   * Marks threads done, as session.markDone would: they leave the live list for the shelf.
   * Returns the threads it moved, so an Undo can put them back with restoreThreads.
   */
  function markDone(ids) {
    var moved = threads.filter(function (t) { return ids.indexOf(t.id) !== -1; });
    threads = threads.filter(function (t) { return ids.indexOf(t.id) === -1; });
    moved.forEach(function (t) { t.doneAt = W.now; });
    drawSum();
    return moved;
  }

  /** Puts threads taken off by markDone back. */
  function restoreThreads(list) {
    list.forEach(function (t) { delete t.doneAt; });
    threads = threads.concat(list);
    drawSum();
  }

  /**
   * Shows a toast at the bottom of the sidebar's list, as the app's Done toast: a line and an
   * optional action. It stays five seconds, or until replaced.
   */
  function showToast(text, actionLabel, onAction) {
    var old = els.side.querySelector(".stage-toast");
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.className = "side-toast stage-toast is-new";
    toast.innerHTML = '<span class="side-toast-text">' + text + "</span>" + (actionLabel ? "<button>" + actionLabel + "</button>" : "");
    els.side.insertBefore(toast, els.assistants);
    if (actionLabel) toast.querySelector("button").addEventListener("click", function () { toast.remove(); onAction(); });
    setTimeout(function () { toast.remove(); }, 5000);
  }

  /* ------------------------------------------------------------------ the API */

  var api = {
    world: W,
    state: STATE,
    els: els,
    escapeHtml: escapeHtml,
    getThread: getThread,
    listThreads: listThreads,
    findLead: findLead,
    listPartners: listPartners,
    listCrew: listCrew,
    listLeads: listLeads,
    pickSpokesperson: pickSpokesperson,
    toMinutes: toMinutes,
    compareTimes: compareTimes,
    minutesAgo: minutesAgo,
    formatAge: formatAge,
    decideSlot: decideSlot,
    describePlace: describePlace,
    describeAgent: describeAgent,
    findMachine: findMachine,
    findBranch: findBranch,
    drawFace: drawFace,
    drawBrand: drawBrand,
    drawThreadRow: drawThreadRow,
    listExchanges: listExchanges,
    getProject: getProject,
    countByPose: countByPose,
    drawSum: drawSum,
    drawHeader: drawHeader,
    drawTranscript: drawTranscript,
    drawComposer: drawComposer,
    drawMain: drawMain,
    listWorkspaceThreads: listWorkspaceThreads,
    open: open,
    openId: function () { return openId; },
    onOpen: function (fn) { listeners.push(fn); },
    spawnPartner: spawnPartner,
    resetSpawn: resetSpawn,
    markDone: markDone,
    restoreThreads: restoreThreads,
    showToast: showToast,
  };

  /**
   * Registers the direction. Fields:
   *   rootClass   a class on the window's root, under which the direction scopes every rule
   *   initial     the thread open at load, by state; default "t3ds" (the partner state opens "t3dsReview")
   *   drawList(listEl, api)              draws the sidebar's thread list (required)
   *   drawHeader(thread, api)            returns header markup to replace the default, or null
   *   drawMain(mainEl, thread, api)      draws the whole main pane; return false to fall back
   *   onOpen(id, api)                    called after a thread opens
   *   boot(api)                          called once the window is built and the first thread is open
   */
  function direction(d) {
    dir = d;
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!dir) throw new Error("No direction registered: call Stage.direction({...}) before the page loads.");
    if (STATE === "spawn") threads = threads.filter(function (t) { return t.id !== W.spawn.thread.id; });
    buildWindow();
    var first = typeof dir.initial === "function" ? dir.initial(STATE) : dir.initial;
    openId = first || (STATE === "partner" ? "t3dsReview" : "t3ds");
    dir.drawList(els.list, api);
    drawMain();
    if (dir.onOpen) dir.onOpen(openId, api);
    if (dir.boot) dir.boot(api);
  });

  window.Stage = { direction: direction, api: api };
})();
