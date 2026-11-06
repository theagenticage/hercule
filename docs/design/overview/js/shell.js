// PROTOTYPE - the desktop window's sidebar, as the goldens draw the Hercule face, with Overview
// and Inbox in the Work section. Work's sidebar is the app's; only those two rows are new.
window.Shell = (function () {
  "use strict";
  var I = function (n, s) { return Crew.icon(n, s); };

  function navRow(key, label, icon, selected, end) {
    return '<a class="nav-row' + (selected === key ? " is-on" : "") + '" data-nav="' + key + '" href="#">' + I(icon) + "<span>" + label + "</span>" + (end || "") + "</a>";
  }

  function waitingRow(name, ask, id) {
    return '<div class="side-row" role="button" tabindex="0" data-task="' + (id || "") + '">' + Crew.face(name, { pose: "waiting", size: 24 }) + '<span class="side-text"><span class="side-name">' + name + '</span><span class="side-ask">' + ask + "</span></span></div>";
  }

  /** Draws the Hercule face of the sidebar into el. opts: selected row key, and the waiting rows. */
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
      '<div class="seg seg--side" role="tablist"><button role="tab" aria-selected="false">Threads</button><button role="tab" aria-selected="true">Hercule</button></div>' +
      '<div class="side-actions"><a class="nav-row" href="#">' + I("compose") + "<span>New thread</span><kbd>⌘N</kbd></a>" +
      '<button class="icon-btn" title="Search">' + I("search") + '</button><button class="icon-btn" title="Home">' + I("office") + "</button></div>" +
      '<div class="side-scroll">' +
      (waiting.length ? '<section class="side-sec"><h3 class="side-h"><span>Waiting on you</span><span class="count count--you">' + waiting.length + "</span></h3>" +
        waiting.map(function (w) { return waitingRow(w[0], w[1], w[2]); }).join("") + "</section>" : "") +
      '<section class="side-sec"><h3 class="side-h"><span>Work</span></h3>' +
      navRow("overview", "Overview", "office", selected) +
      navRow("inbox", "Inbox", "intake", selected, opts.inboxCount ? '<b class="count">' + opts.inboxCount + "</b>" : "") +
      navRow("workflows", "Workflows", "workflows", selected) +
      navRow("discussions", "Discussions", "discussions", selected) +
      navRow("wiki", "Wiki", "wiki", selected) +
      "</section>" +
      '<section class="side-sec"><h3 class="side-h"><span>System</span></h3>' +
      navRow("fleet", "Fleet", "fleet", selected) +
      navRow("connections", "Connections", "connections", selected) +
      "</section></div>" +
      '<div class="side-foot"><div class="side-sum">' + (opts.sum || '<b>16</b> working · <b class="you-ink">2</b> waiting · <b>2</b> idle') + "</div>" +
      '<div class="side-me">' + Crew.you(24) + '<span class="side-name">Noa</span><a class="icon-btn" style="width:24px;height:24px" href="#" title="Settings">' + I("sliders", 14) + "</a></div></div>";
  }

  var elsewhere = null;

  /**
   * Keeps the sidebar true to the board: a waiting row goes when its Task no longer waits, and the
   * foot counts what is on the board.
   */
  function syncWithBoard() {
    var waiting = 0;
    document.querySelectorAll("[data-side] .side-row[data-task]").forEach(function (row) {
      var t = Store.task(row.dataset.task);
      var waits = t && t.move === "you" && !t.ended;
      row.hidden = !waits;
      if (waits) waiting++;
    });
    var count = document.querySelector("[data-side] .side-h .count--you");
    if (count) {
      count.textContent = waiting;
      count.closest(".side-sec").hidden = waiting === 0;
    }
    var onBoard = Store.state.tasks.filter(function (t) { return t.agent && t.move !== "you" && t.stage !== "landed"; }).length;
    // The window opens on the fixture both drawings share. Some sessions work on no Task on this
    // board, such as workflow steps, and from then on the count follows what happens here.
    if (elsewhere === null) elsewhere = document.getElementById("work").dataset.scene === "today" ? Math.max(0, 16 - onBoard) : 0;
    var working = onBoard + elsewhere;
    var sum = document.querySelector("[data-side] .side-sum");
    if (!sum) return;
    if (!Store.state.tasks.length || (!working && !waiting)) sum.textContent = "Nothing running";
    else sum.innerHTML = "<b>" + working + '</b> working · <b class="you-ink">' + waiting + "</b> waiting · <b>2</b> idle";
  }

  return { drawSidebar: drawSidebar, syncWithBoard: syncWithBoard };
})();
