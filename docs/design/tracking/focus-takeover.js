// DRAWING - Tracking, focus variant: takeover (?focus=takeover).
//
// Either Intake or Tracking, never both at once. In Intake, Tracking is one row at the foot of
// the list that sums it up: the count, the faces of the agents whose work waits on Rogier, and
// how many wait. Opening it lets Tracking take over the whole list column, its view switcher
// included: every tracked row, grouped by state, with the open one in the pane. At its foot, one
// row sums up the signals and takes Rogier back. Opening Tracking says he is looking at handed-off
// work and nothing else, so J and K walk only its rows while it is open.
//
// Keys: T opens and closes Tracking. Esc steps back: the pane, then the selection, then Tracking.
// The sheet rises and sinks with a transform, over --dur-3.
(function () {
  "use strict";

  var DUR_3 = 320;
  var EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  var open = new URLSearchParams(location.search).get("takeover") === "open";
  var shellRef = null;
  var moving = false;

  function isOn() {
    return document.documentElement.dataset.focus === "takeover";
  }

  /* ------------------------------------------------------------------ drawing */

  function afterRender(shell) {
    shellRef = shell;
    var tray = document.querySelector("[data-tray]");
    var onTodo = shell.state().view === "todo";
    if (!onTodo) open = false;
    tray.classList.toggle("is-takeover", open);
    document.querySelector(".asks-list").classList.toggle("is-taken-over", open);
    if (!onTodo) return;
    var keep = tray.querySelector(".tk-scroll");
    var scrollTop = keep ? keep.scrollTop : 0;
    tray.innerHTML = open ? buildSheet(shell) : buildBar(shell);
    window.Crew.drawPlaceholders(tray);
    var scroll = tray.querySelector(".tk-scroll");
    if (scroll) scroll.scrollTop = scrollTop;
  }

  // The row Tracking is folded to: the same head the drawer has when it is minimized.
  function buildBar(shell) {
    var T = shell.T;
    var tasks = shell.sortedTasks();
    var waiting = shell.countWaiting();
    var faces = tasks
      .filter(shell.waits)
      .slice(0, 4)
      .map(function (t) {
        return T.face(t.wf, T.STATES[t.state].pose, 20);
      })
      .join("");
    return (
      '<h2 class="rt-tray-h tk-bar"><button class="rt-drawer-bar" data-takeover-toggle title="Open Tracking (T)">' +
      '<span class="rt-tray-toggle"><span>Tracking</span>' + (tasks.length ? '<b class="count">' + tasks.length + "</b>" : "") + "</span>" +
      (faces ? '<span class="stack rt-drawer-faces">' + faces + "</span>" : "") +
      (waiting ? '<span class="rt-tray-sum you-ink">' + window.Crew.mark("waiting", 12) + waiting + " wait" + (waiting === 1 ? "s" : "") + " on you</span>" : '<span class="rt-tray-sum">' + (tasks.length ? "" : "Nothing handed off") + "</span>") +
      '<span class="tk-chev tk-chev--up">' + T.icon("chev-d", 12) + "</span></button></h2>"
    );
  }

  // Tracking over the whole column: its head, its rows grouped by state, and the row that sums up
  // the signals and goes back to them.
  function buildSheet(shell) {
    var T = shell.T;
    var tasks = shell.sortedTasks();
    var waiting = shell.countWaiting();
    var groups = ["needs", "failed", "finished", "working", "stopped"]
      .map(function (state) {
        var rows = tasks.filter(function (t) {
          return t.state === state;
        });
        if (!rows.length) return "";
        return (
          '<h3 class="section-h asks-sec tk-sec">' + window.Crew.mark(T.STATES[state].mark, 14) + T.STATES[state].word + ' <span class="count">' + rows.length + "</span></h3>" +
          '<div class="rt-runs">' + rows.map(shell.trayRow).join("") + "</div>"
        );
      })
      .join("");
    var signals = shell.signalsOnTab();
    var marks = [];
    signals.forEach(function (s) {
      if (marks.indexOf(s.src) < 0) marks.push(s.src);
    });
    return (
      '<header class="tk-head"><h2 class="tk-title">Tracking <span class="count">' + tasks.length + "</span></h2>" +
      (waiting ? '<span class="rt-tray-sum you-ink">' + window.Crew.mark("waiting", 12) + waiting + " wait" + (waiting === 1 ? "s" : "") + " on you</span>" : "") +
      "</header>" +
      '<div class="tk-scroll">' + (groups || '<p class="rt-tray-empty">Hand a signal to an agent, and follow it here until you mark it done.</p>') + "</div>" +
      '<h2 class="rt-tray-h tk-bar tk-bar--back"><button class="rt-drawer-bar" data-takeover-toggle title="Back to the signals (T)">' +
      '<span class="rt-tray-toggle"><span>Signals</span><b class="count">' + signals.length + "</b></span>" +
      '<span class="tk-marks">' +
      marks
        .map(function (src) {
          return T.sourceMark(src, 14);
        })
        .join("") +
      "</span>" +
      '<span class="rt-tray-sum">Back to Intake</span>' +
      '<span class="tk-chev">' + T.icon("chev-d", 12) + "</span></button></h2>"
    );
  }

  /* ------------------------------------------------------------------ opening and closing */

  /** Opens or closes Tracking. The sheet rises from the row at the foot, or sinks back into it. */
  function toggle() {
    if (!shellRef || moving) return;
    var tray = document.querySelector("[data-tray]");
    var column = document.querySelector(".asks-list").getBoundingClientRect();
    var bar = tray.getBoundingClientRect();
    if (!open) {
      open = true;
      shellRef.render(true);
      if (!shellRef.motionAllowed()) return;
      var drop = column.bottom - bar.height - column.top;
      tray.animate([{ transform: "translateY(" + drop + "px)" }, { transform: "none" }], { duration: DUR_3, easing: EASE });
      return;
    }
    var finish = function () {
      open = false;
      moving = false;
      var s = shellRef.state();
      if (s.selected && shellRef.isTask(shellRef.findItem(s.selected))) shellRef.closePane();
      else shellRef.render(true);
    };
    if (!shellRef.motionAllowed()) return finish();
    moving = true;
    var sink = column.height - 44;
    tray.animate([{ transform: "none" }, { transform: "translateY(" + sink + "px)" }], { duration: DUR_3, easing: EASE, fill: "forwards" }).onfinish = function () {
      finish();
      tray.getAnimations().forEach(function (a) {
        a.cancel();
      });
    };
  }

  document.addEventListener("click", function (e) {
    if (!isOn() || !e.target.closest("[data-takeover-toggle]")) return;
    toggle();
  });

  // Registered before the shell's own listener, so it sees Esc first: once the pane is closed and
  // nothing is selected, Esc closes Tracking.
  document.addEventListener("keydown", function (e) {
    if (!isOn() || !shellRef || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
    var s = shellRef.state();
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      toggle();
    } else if (e.key === "Escape" && open && !s.paneOpen && !s.selected) {
      e.preventDefault();
      toggle();
    }
  });

  window.TrackingFocus = window.TrackingFocus || {};
  window.TrackingFocus.takeover = {
    // In Intake, Tracking is one row, so J and K stay in the list; opened, they walk only its rows.
    hidesTray: true,
    foldsTray: false,
    listOrder: function (shell) {
      if (!open) return null;
      return shell.sortedTasks().map(function (t) {
        return t.id;
      });
    },
    afterRender: afterRender,
  };
})();
