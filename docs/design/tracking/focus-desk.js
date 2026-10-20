// DRAWING - Tracking, focus variant: desk (?focus=desk).
//
// Tracking keeps one summary row at the foot of the list: the count, the faces of the work that
// waits on Rogier, and how many rows wait. A click on it, or T, opens Tracking as a large dialog
// over the list and the pane, with a list and a pane of its own, so Tracking never shares the
// column with the signals. Esc or T closes it.
//
// The shell (tracking.js) still owns the selection and every answer: a row or an answer in the
// dialog is the same data-id, data-answer or data-task-done the shell already handles, and the
// dialog only draws what the shell holds after each render.
(function () {
  "use strict";

  var root = document.documentElement;
  var open = false;
  var shellRef = null;
  var shownTask = null;
  var shownIndex = 0;
  var reselecting = false;

  function isDesk() {
    return root.dataset.focus === "desk";
  }

  /* ------------------------------------------------------------------ the summary row */

  // The faces of the rows that wait on Rogier, up to four; with none waiting, of the rows at work.
  function buildFaces(shell) {
    var tasks = shell.sortedTasks();
    var waiting = tasks.filter(shell.waits);
    var list = (waiting.length ? waiting : tasks).slice(0, 4);
    return (
      '<span class="stack">' +
      list
        .map(function (t) {
          return shell.T.face(t.wf, shell.T.STATES[t.state].pose, 22);
        })
        .join("") +
      "</span>"
    );
  }

  function buildWaiting(shell) {
    var n = shell.countWaiting();
    return n ? '<span class="desk-wait you-ink">' + window.Crew.mark("waiting", 12) + n + " wait" + (n === 1 ? "s" : "") + " on you</span>" : "";
  }

  // The tray, minimized to one row. With nothing handed off the shell's own empty line stays.
  function renderSummary(shell) {
    var tray = document.querySelector("[data-tray]");
    var tasks = shell.sortedTasks();
    if (tray.hidden || !tasks.length) return;
    tray.innerHTML =
      '<button class="desk-sum" data-desk-open aria-haspopup="dialog" aria-expanded="' + open + '" title="Open Tracking (T)">' +
      '<span class="desk-sum-h">Tracking<b class="count">' + tasks.length + "</b></span>" +
      buildFaces(shell) +
      buildWaiting(shell) +
      '<span class="desk-sum-open">' + shell.T.icon("popout", 14) + "</span>" +
      "</button>";
  }

  /* ------------------------------------------------------------------ the dialog */

  function findDialog() {
    var split = document.querySelector("[data-split]");
    var el = split.querySelector(".desk");
    if (el) return el;
    split.insertAdjacentHTML("beforeend", '<div class="desk-scrim" data-desk-close hidden></div><section class="desk" role="dialog" aria-modal="true" aria-label="Tracking" hidden></section>');
    return split.querySelector(".desk");
  }

  // The list inside the dialog: every tracked row, with no folding, the rows that wait on Rogier
  // first and a 6px space before the rest, as in the tray.
  function buildRows(shell) {
    var tasks = shell.sortedTasks();
    return tasks
      .map(function (t, i) {
        var gap = i > 0 && shell.waits(tasks[i - 1]) && !shell.waits(t);
        return (gap ? '<div class="rt-runs-gap" aria-hidden="true"></div>' : "") + shell.trayRow(t);
      })
      .join("");
  }

  function buildDialog(shell, task) {
    var tasks = shell.sortedTasks();
    return (
      '<header class="desk-h">' +
      '<h2 class="desk-title">Tracking<b class="count">' + tasks.length + "</b></h2>" +
      buildWaiting(shell) +
      '<span class="spacer"></span>' +
      '<button class="icon-btn" data-desk-close aria-label="Close Tracking" title="Close (Esc)">' + shell.T.icon("close", 16) + "</button>" +
      "</header>" +
      '<div class="desk-body">' +
      '<div class="desk-list">' +
      '<div class="desk-rows rt-runs">' + buildRows(shell) + "</div>" +
      '<p class="desk-foot"><kbd>T</kbd> opens and closes Tracking · <kbd>Esc</kbd> closes</p>' +
      "</div>" +
      '<div class="desk-detail">' +
      (task ? window.TrackingPane.build(task) + window.TrackingPane.keys(task) : '<p class="desk-none">Nothing in Tracking.</p>') +
      "</div>" +
      "</div>"
    );
  }

  /** Returns the Task the dialog shows: the shell's selection when it is a Task, else the one at the same place. */
  function pickTask(shell) {
    var st = shell.state();
    var tasks = shell.sortedTasks();
    var sel = st.selected && shell.findItem(st.selected);
    if (sel && shell.isTask(sel) && tasks.indexOf(sel) >= 0) return sel;
    if (!tasks.length) return null;
    return tasks[Math.min(shownIndex, tasks.length - 1)];
  }

  function renderDialog(shell) {
    var dialog = findDialog();
    var scrim = dialog.previousElementSibling;
    if (!open) {
      dialog.hidden = true;
      scrim.hidden = true;
      return;
    }
    var task = pickTask(shell);
    var st = shell.state();
    // When the shell's selection moved off Tracking (a row marked done hands it to the next signal),
    // the dialog shows the Task in that place and moves the shell's selection there, once.
    if (task && st.selected !== task.id && !reselecting) {
      reselecting = true;
      Promise.resolve().then(function () {
        shell.select(task.id);
        reselecting = false;
      });
    }
    var list = dialog.querySelector(".desk-list");
    var detail = dialog.querySelector(".desk-detail");
    var listTop = list ? list.scrollTop : 0;
    var detailTop = detail && task && task.id === shownTask ? detail.scrollTop : 0;
    dialog.innerHTML = buildDialog(shell, task);
    window.Crew.drawPlaceholders(dialog);
    dialog.querySelector(".desk-list").scrollTop = listTop;
    dialog.querySelector(".desk-detail").scrollTop = detailTop;
    // The shell marks its own selection; inside the dialog the shown Task is the selected row.
    dialog.querySelectorAll(".rt-run-item").forEach(function (row) {
      var on = task && row.querySelector('[data-id="' + task.id + '"]');
      row.classList.toggle("is-on", !!on);
    });
    shownTask = task ? task.id : null;
    shownIndex = task ? Math.max(0, shell.sortedTasks().indexOf(task)) : 0;
    dialog.hidden = false;
    scrim.hidden = false;
  }

  /* ------------------------------------------------------------------ opening and closing */

  // Opens with opacity and a small rise and scale over --dur-3, closes with opacity over --dur-2;
  // nothing moves with Reduce motion.
  function setOpen(value) {
    if (!shellRef || open === value) return;
    var dialog = findDialog();
    var scrim = dialog.previousElementSibling;
    if (!value && shellRef.motionAllowed()) {
      open = false;
      var out = { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" };
      scrim.animate([{ opacity: 1 }, { opacity: 0 }], out);
      dialog.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(6px) scale(0.99)" }], out).onfinish = function () {
        renderAll();
        dialog.getAnimations().forEach(function (a) {
          a.cancel();
        });
        scrim.getAnimations().forEach(function (a) {
          a.cancel();
        });
      };
      return;
    }
    open = value;
    renderAll();
    if (value) {
      if (shellRef.motionAllowed()) {
        var ease = { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
        scrim.animate([{ opacity: 0 }, { opacity: 1 }], ease);
        dialog.animate(
          [
            { opacity: 0, transform: "translateY(12px) scale(0.98)" },
            { opacity: 1, transform: "none" },
          ],
          ease,
        );
      }
      var row = dialog.querySelector(".rt-run-item.is-on .rt-run");
      if (row) row.focus({ preventScroll: true });
    }
  }

  function renderAll() {
    renderSummary(shellRef);
    renderDialog(shellRef);
  }

  function moveInDialog(by) {
    var tasks = shellRef.sortedTasks();
    var i = -1;
    tasks.forEach(function (t, n) {
      if (t.id === shownTask) i = n;
    });
    var next = tasks[Math.max(0, Math.min(tasks.length - 1, i + by))];
    if (!next) return;
    shellRef.select(next.id);
    var row = findDialog().querySelector('[data-id="' + next.id + '"]');
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      row.focus({ preventScroll: true });
    }
  }

  function inField(e) {
    return e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
  }

  // The dialog's keys run first, on the window in the capture phase, so the shell's own J, K, Enter
  // and Esc, which walk the column, never see them while the dialog is open. E and O go on to the
  // shell, which acts on the selection the dialog keeps in step.
  window.addEventListener(
    "keydown",
    function (e) {
      if (!isDesk() || !shellRef || inField(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key;
      if (k === "t" || k === "T") {
        if (shellRef.state().view !== "todo" || !shellRef.sortedTasks().length) return;
        e.preventDefault();
        e.stopPropagation();
        setOpen(!open);
        return;
      }
      if (!open) return;
      var handled = true;
      if (k === "Escape") setOpen(false);
      else if (k === "j" || k === "J" || k === "ArrowDown") moveInDialog(1);
      else if (k === "k" || k === "K" || k === "ArrowUp") moveInDialog(-1);
      else if (k === "Enter" && !(e.target.closest && e.target.closest(".desk-detail button, .desk-detail a, .rt-run-ans button"))) {
        var btn = findDialog().querySelector(".desk-detail .btn--accent");
        if (btn) btn.focus();
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );

  document.addEventListener("click", function (e) {
    if (!isDesk()) return;
    if (e.target.closest("[data-desk-open]")) setOpen(true);
    else if (e.target.closest("[data-desk-close]")) setOpen(false);
  });

  window.TrackingFocus = window.TrackingFocus || {};
  window.TrackingFocus.desk = {
    // The tray is one summary row here, so J and K stay in the list; the dialog has its own keys.
    hidesTray: true,
    afterRender: function (shell) {
      shellRef = shell;
      if (shell.state().view !== "todo" || !shell.sortedTasks().length) open = false;
      renderAll();
    },
  };
})();
