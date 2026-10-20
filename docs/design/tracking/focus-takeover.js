// DRAWING - Tracking, focus variant: takeover (?focus=takeover).
//
// Either Intake or Tracking, never both at once. In Intake, Tracking is folded to the foot of the
// list: a head that sums it up and says "Show all", over the two rows that changed last, so a
// handoff has a place to land and the eye has something to click. Opening it lets Tracking take
// over the whole list column, its view switcher included: every tracked row, grouped by state,
// with the open one in the pane. At its foot, one row sums up the signals and takes Rogier back.
// Opening Tracking says he is looking at handed-off work and nothing else, so J and K walk only
// its rows while it is open.
//
// Keys: T opens and closes Tracking. Esc steps back: the pane, then the selection, then Tracking.
//
// How Tracking opens and closes is still explored, switched with ?motion= or from the bar:
//   rise    the sheet springs up from the foot in 240ms, and its rows cascade in, 16ms apart
//   unfold  the sheet appears at once and its rows fan upward out of the foot, nearest first
//   depth   Intake recedes, scaling down as it fades, while Tracking comes forward, in 200ms
// Every step is transform or opacity, and none plays with Reduce motion.
(function () {
  "use strict";

  var PEEK_ROWS = 2;
  var MOTIONS = [
    ["rise", "Rise"],
    ["unfold", "Unfold"],
    ["depth", "Depth"],
  ];
  var query = new URLSearchParams(location.search);
  var motion = query.get("motion") || "rise";
  var open = query.get("takeover") === "open";
  var shellRef = null;
  var moving = false;

  // A spring that overshoots a little and settles: the book's --ease-spring overshoots too far
  // for a sheet the height of the window.
  var SPRING = "cubic-bezier(0.3, 1.2, 0.5, 1)";
  var EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  var EASE_IN = "cubic-bezier(0.5, 0, 0.75, 0)";

  function isOn() {
    return document.documentElement.dataset.focus === "takeover";
  }

  /* ------------------------------------------------------------------ drawing */

  function afterRender(shell) {
    shellRef = shell;
    addMotionPick();
    var tray = document.querySelector("[data-tray]");
    var list = document.querySelector("[data-list]");
    var onTodo = shell.state().view === "todo";
    if (!onTodo) open = false;
    tray.classList.toggle("is-takeover", open);
    if (!onTodo) return;
    var keep = tray.querySelector(".tk-scroll");
    var scrollTop = keep ? keep.scrollTop : 0;
    tray.innerHTML = open ? buildSheet(shell) : buildFolded(shell);
    window.Crew.drawPlaceholders(tray);
    var scroll = tray.querySelector(".tk-scroll");
    if (scroll) scroll.scrollTop = scrollTop;
    // The list keeps room under its last row for the folded Tracking, whatever its height.
    if (!open) list.style.paddingBottom = tray.offsetHeight + 12 + "px";
  }

  /** Returns the rows that changed last, newest first: a handoff, a run that finished. */
  function listRecent(shell) {
    return shell
      .sortedTasks()
      .slice()
      .sort(function (a, b) {
        return shell.T.parseClock(b.since) - shell.T.parseClock(a.since);
      })
      .slice(0, PEEK_ROWS);
  }

  // Folded: the head, which opens Tracking, over the two rows that changed last.
  function buildFolded(shell) {
    var T = shell.T;
    var tasks = shell.sortedTasks();
    var waiting = shell.countWaiting();
    var head =
      '<h2 class="rt-tray-h tk-bar"><button class="rt-drawer-bar" data-takeover-toggle title="Show all of Tracking (T)">' +
      '<span class="rt-tray-toggle"><span>Tracking</span>' + (tasks.length ? '<b class="count">' + tasks.length + "</b>" : "") + "</span>" +
      (waiting ? '<span class="tk-wait you-ink">' + window.Crew.mark("waiting", 12) + waiting + " wait" + (waiting === 1 ? "s" : "") + " on you</span>" : "") +
      (tasks.length ? '<span class="tk-all">Show all<span class="tk-chev tk-chev--up">' + T.icon("chev-d", 12) + "</span></span>" : "") +
      "</button></h2>";
    if (!tasks.length) return head + '<p class="rt-tray-empty">Hand a signal to an agent, and follow it here until you mark it done.</p>';
    return head + '<div class="rt-runs tk-peek">' + listRecent(shell).map(shell.trayRow).join("") + "</div>";
  }

  // Opened: Tracking over the whole column. Its head, its rows grouped by state, and the row that
  // sums up the signals and goes back to them.
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
      (waiting ? '<span class="tk-wait you-ink">' + window.Crew.mark("waiting", 12) + waiting + " wait" + (waiting === 1 ? "s" : "") + " on you</span>" : "") +
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
      '<span class="tk-all">Back to Intake<span class="tk-chev">' + T.icon("chev-d", 12) + "</span></span></button></h2>"
    );
  }

  // The bar's third control, for this variant only: how Tracking opens.
  function addMotionPick() {
    var bar = document.querySelector("[data-proto]");
    if (!bar || bar.querySelector("[data-motion-pick]")) return;
    var finished = bar.querySelector('[data-variant-pick="finished"]');
    if (!finished) return;
    finished.insertAdjacentHTML(
      "afterend",
      '<select class="tr-proto-pick" data-motion-pick aria-label="How Tracking opens" title="How Tracking opens">' +
        MOTIONS.map(function (m) {
          return '<option value="' + m[0] + '"' + (m[0] === motion ? " selected" : "") + ">Opens: " + m[1] + "</option>";
        }).join("") +
        "</select>",
    );
    bar.querySelector("[data-motion-pick]").addEventListener("change", function (e) {
      var q = new URLSearchParams(location.search);
      q.set("motion", e.target.value);
      location.search = q.toString();
    });
  }

  /* ------------------------------------------------------------------ opening and closing */

  function column() {
    return document.querySelector(".asks-list").getBoundingClientRect();
  }

  /** Returns the parts of the opened sheet that are on screen, top to bottom, for a cascade. */
  function listVisibleParts(tray) {
    var bottom = column().bottom;
    return Array.prototype.filter.call(tray.querySelectorAll(".tk-head, .tk-sec, .rt-run-item"), function (el) {
      return el.getBoundingClientRect().top < bottom;
    });
  }

  function intakeParts() {
    return [document.querySelector("[data-head]"), document.querySelector("[data-list]")];
  }

  /** Opens or closes Tracking, with the motion the bar names. */
  function toggle() {
    if (!shellRef || moving) return;
    var tray = document.querySelector("[data-tray]");
    var folded = tray.getBoundingClientRect();
    var still = !shellRef.motionAllowed();
    if (!open) {
      open = true;
      shellRef.render(true);
      if (!still) playOpen(tray, folded);
      return;
    }
    if (still) return finishClose();
    moving = true;
    playClose(tray, finishClose);
  }

  function finishClose() {
    open = false;
    moving = false;
    var s = shellRef.state();
    if (s.selected && shellRef.isTask(shellRef.findItem(s.selected))) shellRef.closePane();
    else shellRef.render(true);
    var tray = document.querySelector("[data-tray]");
    tray.getAnimations().forEach(function (a) {
      a.cancel();
    });
    intakeParts().forEach(function (el) {
      el.getAnimations().forEach(function (a) {
        a.cancel();
      });
    });
  }

  function playOpen(tray, folded) {
    var c = column();
    var drop = folded.top - c.top;
    if (motion === "rise") {
      tray.animate([{ transform: "translateY(" + drop + "px)" }, { transform: "none" }], { duration: 240, easing: SPRING });
      listVisibleParts(tray).forEach(function (el, i) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(12px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 200, easing: EASE_OUT, delay: 60 + Math.min(i, 12) * 16, fill: "backwards" },
        );
      });
    } else if (motion === "unfold") {
      // The sheet is there at once; its parts fan up out of the foot, the nearest first.
      var parts = listVisibleParts(tray);
      parts.forEach(function (el, i) {
        var from = c.bottom - el.getBoundingClientRect().top;
        var order = parts.length - 1 - i;
        el.animate(
          [
            { opacity: 0, transform: "translateY(" + Math.min(from, 64) + "px) scale(0.985)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 220, easing: EASE_OUT, delay: Math.min(order, 12) * 14, fill: "backwards" },
        );
      });
      tray.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 120, easing: "linear" });
    } else {
      // Depth: two cards. Intake steps back as Tracking steps forward, both at once.
      intakeParts().forEach(function (el) {
        el.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "scale(0.96)" },
          ],
          { duration: 200, easing: EASE_OUT, fill: "forwards" },
        );
      });
      tray.animate(
        [
          { opacity: 0, transform: "scale(1.03)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 200, easing: EASE_OUT },
      );
      setTimeout(function () {
        intakeParts().forEach(function (el) {
          el.getAnimations().forEach(function (a) {
            a.cancel();
          });
        });
      }, 220);
    }
  }

  function playClose(tray, done) {
    var c = column();
    if (motion === "depth") {
      intakeParts().forEach(function (el) {
        el.animate(
          [
            { opacity: 0, transform: "scale(0.96)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 180, easing: EASE_OUT },
        );
      });
      tray.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "scale(1.03)" },
        ],
        { duration: 180, easing: EASE_OUT, fill: "forwards" },
      ).onfinish = done;
      return;
    }
    // Rise and unfold close the same way: the sheet drops back to the foot, quicker than it came.
    tray.animate([{ transform: "none" }, { transform: "translateY(" + (c.height - 140) + "px)" }], { duration: 180, easing: EASE_IN, fill: "forwards" }).onfinish = done;
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
    // Folded, J and K stay in the list; opened, they walk only Tracking's rows.
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
