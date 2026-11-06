// PROTOTYPE - the desktop window's sidebar, as the goldens draw the Hercule face, with Overview
// and Inbox in the Work section. Work's sidebar is the app's; only those two rows are new.
window.Shell = (function () {
  "use strict";
  var I = function (n, s) { return Crew.icon(n, s); };

  var THREADS = [
    ["Storefront", "webshop", "1 needs you", [
      ["Restore a basket after sign-in", "Question", "Highest quantity, or add them?", true],
      ["Replace sleeps in browser tests", "Working", "depot-mac"],
      ["Fix the checks on the multi-buy PR", "Working", "depot-mac"],
    ]],
    ["Platform", "payments", "1 needs you", [
      ["Cut over the invoice export", "Approval", "Approve the cutover for Monday?", true],
      ["Fake the clock in order tests", "Working", "depot-mac"],
    ]],
    ["Insights", "ops", "", [
      ["Fix the checks on the export PR", "Working", "depot-mac"],
    ]],
  ];

  function navRow(key, label, icon, selected, end) {
    return '<a class="nav-row' + (selected === key ? " is-on" : "") + '" data-nav="' + key + '" href="#">' + I(icon) + "<span>" + label + "</span>" + (end || "") + "</a>";
  }

  function waitingRow(name, ask, id) {
    return '<div class="side-row" role="button" tabindex="0" data-task="' + (id || "") + '">' + Crew.face(name, { pose: "waiting", size: 24 }) + '<span class="side-text"><span class="side-name">' + name + '</span><span class="side-ask">' + ask + "</span></span></div>";
  }

  /** Draws a row of the Threads face: a title with its state, and the second line beside its mark. */
  function threadRow(t) {
    return '<div class="thread-row"><span class="thread-line"><span class="side-name">' + t[0] + '</span><small class="thread-state' + (t[3] ? " is-you" : "") + '">' + t[1] + '</small></span><span class="thread-line thread-sub' + (t[3] ? " is-you" : "") + '">' + I("fleet", 12) + "<span>" + t[2] + "</span></span></div>";
  }

  /** Draws the Threads face, as the app draws it: the threads under their projects. */
  function drawThreadsFace() {
    return THREADS.map(function (g) {
      return '<section class="side-sec"><h3 class="thread-h"><i class="proj proj--' + g[1] + '"></i><span>' + g[0] + "</span>" + (g[2] ? "<em>" + g[2] + "</em>" : "") + "</h3>" + g[3].map(threadRow).join("") + "</section>";
    }).join("");
  }

  /** Draws the sidebar into el, on its Hercule face. opts: selected row key, and the waiting rows. */
  function drawSidebar(el, opts) {
    opts = opts || {};
    var selected = opts.selected || "overview";
    var waiting = opts.waiting || [
      ["Cut over the invoice export", "Approve the cutover for Monday?", "sched-cutover"],
      ["Restore a basket after sign-in", "Highest quantity, or add them?", "basket-restore"],
    ];
    el.classList.add("side");
    el.innerHTML =
      '<div class="side-top"><button class="icon-btn" title="Hide the sidebar">' + I("sidebar") + "</button></div>" +
      '<div class="seg seg--side" role="tablist"><button role="tab" aria-selected="false" data-face="threads">Threads</button><button role="tab" aria-selected="true" data-face="hercule">Hercule</button><button class="seg-dot" data-failed-door hidden></button></div>' +
      '<div class="side-actions"><a class="nav-row" href="#">' + I("compose") + "<span>New thread</span><kbd>⌘N</kbd></a>" +
      '<button class="icon-btn" title="Search">' + I("search") + '</button><button class="icon-btn" title="Home">' + I("office") + "</button></div>" +
      '<div class="side-scroll">' +
      (waiting.length ? '<section class="side-sec"><h3 class="side-h"><span>Waiting on you</span><span class="count count--you">' + waiting.length + "</span></h3>" +
        waiting.map(function (w) { return waitingRow(w[0], w[1], w[2]); }).join("") + "</section>" : "") +
      '<div data-side-face="hercule"><section class="side-sec"><h3 class="side-h"><span>Work</span></h3>' +
      navRow("overview", "Overview", "office", selected, '<i class="nav-dot" hidden></i>') +
      navRow("inbox", "Inbox", "intake", selected, opts.inboxCount ? '<b class="count">' + opts.inboxCount + "</b>" : "") +
      navRow("workflows", "Workflows", "workflows", selected) +
      navRow("discussions", "Discussions", "discussions", selected) +
      navRow("wiki", "Wiki", "wiki", selected) +
      "</section>" +
      '<section class="side-sec"><h3 class="side-h"><span>System</span></h3>' +
      navRow("fleet", "Fleet", "fleet", selected) +
      navRow("connections", "Connections", "connections", selected) +
      '</section></div><div data-side-face="threads" hidden>' + drawThreadsFace() + "</div></div>" +
      '<div class="side-foot"><div class="side-sum">' + (opts.sum || '<b>16</b> working · <b class="you-ink">2</b> waiting · <b>2</b> idle') + "</div>" +
      '<div class="side-me">' + Crew.you(24) + '<span class="side-name">Noa</span><a class="icon-btn" style="width:24px;height:24px" href="#" title="Settings">' + I("sliders", 14) + "</a></div></div>";
  }

  var elsewhere = null;

  /** Shows the sidebar's Threads or Hercule face. */
  function showFace(name) {
    document.querySelectorAll("[data-side] [data-side-face]").forEach(function (el) { el.hidden = el.dataset.sideFace !== name; });
    document.querySelectorAll("[data-side] [data-face]").forEach(function (b) { b.setAttribute("aria-selected", b.dataset.face === name); });
    syncFailedDots();
  }

  /**
   * Shows the marigold dot while any run has failed: on the Overview row, and on the Hercule
   * segment when the Threads face hides that row. It has no number: the lane says how many.
   */
  function syncFailedDots() {
    var failed = Store.countStates().failed;
    var words = failed + " failed. Open Work on what failed";
    var row = document.querySelector("[data-side] .nav-dot");
    var door = document.querySelector("[data-side] .seg-dot");
    if (!row || !door) return;
    row.hidden = !failed;
    row.title = words;
    door.hidden = !failed || document.querySelector('[data-side] [data-side-face="threads"]').hidden;
    door.title = words;
    door.setAttribute("aria-label", words);
  }

  /**
   * Keeps the sidebar true to the board: a waiting row goes when its Task no longer waits, and the
   * foot counts what is on the board.
   */
  function syncWithBoard() {
    syncFailedDots();
    var waiting = 0;
    document.querySelectorAll("[data-side] .side-row[data-task]").forEach(function (row) {
      var t = Store.task(row.dataset.task);
      var waits = t && !!t.question && !t.ended;
      row.hidden = !waits;
      if (waits) waiting++;
    });
    var count = document.querySelector("[data-side] .side-h .count--you");
    if (count) {
      count.textContent = waiting;
      count.closest(".side-sec").hidden = waiting === 0;
    }
    var onBoard = Store.state.tasks.filter(function (t) { return t.agent && !t.question && !t.failed && t.stage !== "landed"; }).length;
    // The window opens on the fixture both drawings share. Some sessions work on no Task on this
    // board, such as workflow steps, and from then on the count follows what happens here.
    var scene = document.getElementById("work").dataset.scene;
    if (elsewhere === null) elsewhere = scene === "today" || scene === "quiet" ? Math.max(0, 16 - onBoard) : scene === "failed" ? Math.max(0, 15 - onBoard) : 0;
    var working = onBoard + elsewhere;
    var sum = document.querySelector("[data-side] .side-sum");
    if (!sum) return;
    if (!Store.state.tasks.length || (!working && !waiting)) sum.textContent = "Nothing running";
    else sum.innerHTML = "<b>" + working + '</b> working · <b class="you-ink">' + waiting + "</b> waiting · <b>2</b> idle";
  }

  /** Counts a thread that was already running as now being on the board: the total does not change. */
  function adoptArrival() {
    if (elsewhere > 0) elsewhere--;
  }

  return { drawSidebar: drawSidebar, showFace: showFace, syncWithBoard: syncWithBoard, adoptArrival: adoptArrival };
})();
