// DRAWING - Tracking, focus variant: blotter (?focus=blotter).
//
// The right half of Intake is empty whenever nothing is open. On a real desk, the blotter is where
// the work in progress lies, so here the pane's resting state is Tracking: a calm board of the work
// handed to agents, grouped by state. The list column is Intake alone, with no tray under it.
// Opening a signal or a tracked item shows it in the pane, as always; Esc, or "‹ Tracking" at the
// top of a tracked item, brings the board back.
(function () {
  "use strict";

  window.TrackingFocus = window.TrackingFocus || {};

  // Above this many Working Tasks, the board draws them as a grid of faces instead of rows, so ten
  // times the load stays as calm as a normal morning.
  var WORKING_ROWS = 4;

  // The order of the board's sections, and what each one's heading says.
  var SECTIONS = [
    ["needs", "Needs you"],
    ["failed", "Failed"],
    ["finished", "Finished"],
    ["working", "Working"],
    ["stopped", "Stopped"],
  ];

  // The state each card had at the last render, so a card that changed state fades in anew.
  var lastStates = {};

  /** Returns the board: the header, then one section per state that holds a Task. */
  function buildBoard(shell) {
    var T = shell.T;
    var tasks = shell.sortedTasks();
    var waiting = shell.countWaiting();
    var html = '<article class="ad bl-board" aria-label="Tracking">' + buildHead(shell, tasks, waiting);
    if (!tasks.length) return html + buildEmpty(T) + "</article>";
    SECTIONS.forEach(function (sec) {
      var list = tasks.filter(function (t) {
        return t.state === sec[0];
      });
      if (!list.length) return;
      html += '<section class="bl-sec bl-sec--' + sec[0] + '">';
      html += '<h3 class="bl-sec-h">' + window.Crew.mark(T.STATES[sec[0]].mark, 14) + "<span>" + sec[1] + '</span><span class="count">' + list.length + "</span></h3>";
      // Three or more Finished cards set in two columns: good news reads at a glance, and the
      // section stays short at load.
      var grid = sec[0] === "finished" && list.length >= 3;
      if (shell.waits(list[0])) html += '<div class="bl-cards' + (grid ? " bl-cards--grid" : "") + '">' + list.map(card.bind(null, shell)).join("") + "</div>";
      else if (sec[0] === "working" && list.length > WORKING_ROWS) html += faceGrid(T, list);
      else html += '<div class="bl-rows">' + list.map(row.bind(null, T)).join("") + "</div>";
      html += "</section>";
    });
    return html + "</article>";
  }

  // The header reads like the top of a page: the day, the name, then the two numbers that matter.
  // The rows that wait on Rogier still count toward To do, and the header says so.
  function buildHead(shell, tasks, waiting) {
    var finished = tasks.filter(function (t) {
      return t.state === "finished";
    }).length;
    var line = tasks.length ? tasks.length + " handed off today" + (finished ? " · " + finished + " finished since 09:00" : "") : "";
    return (
      '<header class="bl-head">' +
      '<p class="bl-kicker">Tuesday 29 September · 09:41</p>' +
      '<h2 class="bl-title">Tracking' + (tasks.length ? ' <span class="count">' + tasks.length + "</span>" : "") + "</h2>" +
      (line ? '<p class="bl-line"><span>' + line + "</span>" : '<p class="bl-line">') +
      (waiting ? '<span class="bl-waiting">' + waiting + " wait" + (waiting === 1 ? "s" : "") + " on you, and count toward To do</span>" : "") +
      "</p></header>"
    );
  }

  function buildEmpty(T) {
    return (
      '<div class="bl-empty">' +
      T.face("Hercule", "idle", 56) +
      '<p class="bl-empty-h">Nothing handed off yet</p>' +
      '<p class="bl-empty-line">Hand a signal to an agent, and follow it here until you mark it done.</p>' +
      "</div>"
    );
  }

  /** Returns the line a Task's card or row shows: what waits, what went wrong, or what the agent is doing. */
  function describeTask(T, t) {
    if (t.state === "needs") return t.question ? t.question.text : t.waitsOn.text;
    if (t.state === "failed") return T.who(t.wf) + " failed · " + t.line;
    if (t.state === "finished") return T.who(t.wf) + " finished";
    if (t.state === "stopped") return T.who(t.wf) + " · stopped by you";
    return T.who(t.wf) + " · " + (t.narration || "starting");
  }

  // A card for a Task that waits on Rogier: the agent's face, the title, what waits, and when it
  // was handed off. The card is not one button, because a Request card holds its own answers;
  // the open button covers the card's text, and the answers sit under it.
  function card(shell, t) {
    var T = shell.T;
    var on = shell.state().selected === t.id;
    var answers = t.state === "needs" && t.question
      ? '<div class="bl-ans">' +
        t.question.answers
          .map(function (a, i) {
            var cls = "btn btn--sm" + (a[2] ? " btn--accent" : "") + (i === 2 ? " btn--quiet" : "");
            return '<button class="' + cls + '" data-question="' + t.id + '" data-q="' + i + '" title="' + a[1].replace(/<[^>]+>/g, "") + '">' + a[0] + "</button>";
          })
          .join("") +
        "</div>"
      : "";
    return (
      '<div class="bl-card' + (t.state === "finished" ? " is-finished" : "") + (on ? " is-on" : "") + '" data-board-id="' + t.id + '" data-state="' + t.state + '">' +
      '<button class="bl-card-open" data-id="' + t.id + '">' +
      '<span class="bl-face">' + T.face(t.wf, T.STATES[t.state].pose, 32) + "</span>" +
      '<span class="bl-card-text"><span class="bl-card-title">' + t.title + "</span>" +
      '<span class="bl-card-line">' + describeTask(T, t) + "</span>" +
      '<span class="bl-card-meta">' + T.sourceMark(t.src, 12) + "Handed to " + t.wf + " at " + t.handedAt + (t.worker ? " · " + t.worker : "") + "</span></span>" +
      '<span class="bl-card-end" title="' + T.STATES[t.state].word + " since " + t.since + '">' + (t.state === "finished" ? '<span class="bl-check">' + T.icon("check", 12) + "</span>" : "") + T.formatAge(t.since) + "</span>" +
      "</button>" + answers + "</div>"
    );
  }

  // A compact row for work that does not wait on Rogier: Working and Stopped.
  function row(T, t) {
    return (
      '<button class="bl-row" data-id="' + t.id + '" data-board-id="' + t.id + '" data-state="' + t.state + '">' +
      T.face(t.wf, T.STATES[t.state].pose, 20) +
      '<span class="bl-row-title">' + t.title + "</span>" +
      '<span class="bl-row-line">' + describeTask(T, t) + "</span>" +
      '<span class="bl-row-end">' + T.formatAge(t.since) + "</span></button>"
    );
  }

  // At load, Working folds into a grid of faces, one per Task, with the count per workflow under it.
  // Each face opens its Task; its title is in the tooltip.
  function faceGrid(T, list) {
    var byWf = {};
    list.forEach(function (t) {
      byWf[t.wf] = (byWf[t.wf] || 0) + 1;
    });
    return (
      '<div class="bl-grid">' +
      list
        .map(function (t) {
          return '<button class="bl-grid-face" data-id="' + t.id + '" data-board-id="' + t.id + '" data-state="' + t.state + '" title="' + t.title + " · " + t.wf + " · " + (t.narration || "working") + '">' + T.face(t.wf, "working", 28) + "</button>";
        })
        .join("") +
      "</div>" +
      '<p class="bl-grid-line">' +
      Object.keys(byWf)
        .map(function (wf) {
          return T.who(wf) + " " + byWf[wf];
        })
        .join(" · ") +
      "</p>"
    );
  }

  /* ------------------------------------------------------------------ hooks */

  // The list column is Intake alone, so the tray is emptied as well as hidden: a handed-off signal
  // then fades out of the list instead of flying to a tray nobody sees.
  function afterRender(shell) {
    var tray = document.querySelector("[data-tray]");
    tray.innerHTML = "";
    tray.hidden = true;
    var state = shell.state();
    var open = state.paneOpen && state.selected ? shell.findItem(state.selected) : null;
    var article = document.querySelector("[data-detail] .ad");
    if (open && shell.isTask(open) && state.view === "todo" && article) {
      article.insertAdjacentHTML("afterbegin", '<a href="#" class="bl-back" data-bl-back>' + shell.T.icon("chev-l", 12) + "Tracking</a>");
    }
    fadeChangedCards(shell);
  }

  // A card whose state changed since the last render fades in anew; a card that is new fades in.
  function fadeChangedCards(shell) {
    var now = {};
    var board = document.querySelectorAll("[data-detail] .bl-board [data-board-id]");
    board.forEach(function (el) {
      var id = el.dataset.boardId;
      now[id] = el.dataset.state;
      var known = Object.keys(lastStates).length > 0;
      if (known && lastStates[id] !== el.dataset.state && shell.motionAllowed()) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "linear" });
      }
    });
    if (board.length) lastStates = now;
  }

  document.addEventListener("click", function (e) {
    if (document.documentElement.dataset.focus !== "blotter") return;
    var back = e.target.closest("[data-bl-back]");
    if (!back) return;
    e.preventDefault();
    window.TrackingFocus.blotter.shell.closePane();
  });

  window.TrackingFocus.blotter = {
    // Tracking is the board in the pane here, so J and K stay in the list.
    hidesTray: true,
    shell: null,
    afterRender: function (shell) {
      this.shell = shell;
      afterRender(shell);
    },
    paneWhenEmpty: function (shell) {
      this.shell = shell;
      return buildBoard(shell) + '<div class="ad-keys"><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>↩</kbd> open</span></div>';
    },
  };
})();
