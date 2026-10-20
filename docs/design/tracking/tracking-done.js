// DRAWING - Tracking: the Done view, drawn as Round Trip's. Each signal Rogier handed to an agent
// shows its own leg of the Task's trip: the handoff, its run and that run's re-runs, then how the
// leg ended. An earlier leg ends with the handoff that came next ("continued: Fix bug"); the
// latest ends with the Task's state, which while the Task is open is its Tracking state ("needs
// you"). Legs are never folded, so a Task with two handoffs shows two rows (#797, decision 12).
//
// A handed-off row leads with the face of the colleague it went to, in the pose its leg ended in,
// so "something was done with it" reads before any word does. Its source mark moves to the start
// of the second line, as on Round Trip's result rows.
(function () {
  "use strict";

  var T = window.Tracking;

  /* ------------------------------------------------------------------ lookups */

  function findTask(id) {
    return T.TASKS.filter(function (t) {
      return t.id === id;
    })[0];
  }

  function findSignal(id) {
    return T.SIGNALS.filter(function (s) {
      return s.id === id;
    })[0];
  }

  /** Checks whether the row's Task is still in Tracking, so its trip line ends with a Tracking state. */
  function isTaskOpen(item) {
    return Boolean(item.task && findTask(item.task));
  }

  /** Returns the workflow a leg was handed to, read from its first step: "Handed to Fix bug" gives "Fix bug". */
  function readWorkflow(item) {
    return item.trip[0].replace(/^Handed to /, "");
  }

  /**
   * Returns the pose the colleague's face takes for how a leg ended: the Tracking state's pose while
   * the Task is open, and "done" once the leg is over, because it then ended with Rogier's tick-off
   * or with the handoff that continued it.
   */
  function readLegPose(item) {
    return isTaskOpen(item) ? T.STATES[findTask(item.task).state].pose : "done";
  }

  /** Returns where the signal came from, "webshop #1291", from its row line or its Task; "" when neither says. */
  function readPlace(item) {
    if (item.sub) return item.sub.split(" · ").pop();
    var t = item.task && findTask(item.task);
    return t ? t.asked.where : "";
  }

  /* ------------------------------------------------------------------ the list */

  /**
   * Returns the Done view's list: a day heading, then one quiet row per resolved signal, newest
   * first. `selectedId` marks the open row. A handed-off signal's second line is its leg's trip.
   */
  function buildList(selectedId) {
    return (
      '<h2 class="section-h asks-sec">Today</h2>' +
      '<div class="asks-rows asks-rows--quiet rt-done-rows">' +
      T.DONE.map(function (item) {
        return item.trip ? buildTripRow(item, item.id === selectedId) : buildPlainRow(item, item.id === selectedId);
      }).join("") +
      "</div>"
    );
  }

  // A handed-off signal: the colleague's face leads, the source's mark starts the second line.
  function buildTripRow(item, on) {
    return (
      '<div class="ask-item rt-item' + (on ? " is-on" : "") + '" data-key="' + item.id + '">' +
      '<button class="ask-row rt-row" data-id="' + item.id + '">' +
      '<span class="ask-mark rt-lead">' + T.face(readWorkflow(item), readLegPose(item), 22) + "</span>" +
      '<span class="ask-text"><span class="ask-title">' + item.title + "</span>" +
      '<span class="ask-sub rt-sub"><span class="rt-src">' + T.sourceMark(item.src, 12) + "</span>" + buildTripLine(item) + "</span></span>" +
      '<span class="ask-end"><time class="ask-age">' + item.at + "</time></span>" +
      "</button></div>"
    );
  }

  // A signal that was not handed off keeps its source's mark, as Done draws it today.
  function buildPlainRow(item, on) {
    return (
      '<div class="ask-item' + (on ? " is-on" : "") + '" data-key="' + item.id + '">' +
      '<button class="ask-row" data-id="' + item.id + '">' +
      '<span class="ask-mark">' + T.sourceMark(item.src, 16) + "</span>" +
      '<span class="ask-text"><span class="ask-title">' + item.title + '</span><span class="ask-sub">' + item.outcome + "</span></span>" +
      '<span class="ask-end"><time class="ask-age">' + item.at + "</time></span>" +
      "</button></div>"
    );
  }

  /**
   * Returns a leg's trip line, "Handed to Fix bug → tried again once → done". While the Task is
   * open its last step is the Tracking state, in marigold when that row waits on Rogier.
   */
  function buildTripLine(item) {
    var steps = item.trip.slice();
    if (!isTaskOpen(item)) return steps.join(" → ");
    var last = steps.pop();
    var state = findTask(item.task).state;
    var tone = state === "finished" ? "ok-ink" : T.STATES[state].waits ? "you-ink" : "";
    return steps.join(" → ") + " → " + (tone ? '<span class="' + tone + '">' + last + "</span>" : last);
  }

  /* ------------------------------------------------------------------ the pane */

  /**
   * Returns the pane of a Done row. A handed-off signal shows its leg as a short trip, one line
   * per step, then the way to the work: its Tracking row while the Task is open, else its run.
   */
  function buildPane(item) {
    var place = readPlace(item);
    var head =
      '<header class="ad-head"><div class="ad-kind"><span class="src">' + T.sourceMark(item.src, 14) + T.SOURCES[item.src] + "</span>" +
      (place ? "<span>·</span><span>" + place + "</span>" : "") +
      "</div>" +
      '<h2 class="ad-title">' + item.title + "</h2>" +
      '<p class="ad-asked">' + (item.trip ? buildTripLine(item) : item.outcome + " at " + item.at) + "</p></header>";
    if (!item.trip) return '<div class="ad rt-done-pane">' + head + "</div>";
    var open = isTaskOpen(item);
    return (
      '<div class="ad rt-done-pane">' +
      head +
      '<h3 class="rt-label rt-chain-h">This handoff</h3>' +
      '<ol class="rt-chain">' +
      (item.leg || deriveLeg(findTask(item.task)))
        .map(function (s) {
          return "<li><time>" + s.at + "</time>" + buildStepLead(s) + "<span>" + s.text + "</span></li>";
        })
        .join("") +
      "</ol>" +
      '<div class="rt-done-act">' +
      (open
        ? '<button class="btn btn--sm" data-select="' + item.task + '">Go to Tracking</button>'
        : '<button class="btn btn--sm" data-toast="Opens the run of ' + readWorkflow(item) + ' in Workflows">Open the run</button>') +
      "</div>" +
      '<footer class="ad-foot"><p class="ad-leaves">' + T.icon("check", 14) + "Each signal you hand off shows its own leg. The rest of the work is on the signals that continued it.</p></footer>" +
      "</div>"
    );
  }

  /** Returns who made a step: Rogier, the colleague's face in its pose, or the source's mark in a disc. */
  function buildStepLead(step) {
    if (step.who === "you") return window.Crew.you(20);
    if (step.src) return '<span class="rt-step-src">' + T.sourceMark(step.src, 11) + "</span>";
    return T.face(step.who, step.pose, 20);
  }

  /**
   * Returns the steps of a Task's only leg, read from its runs: the handoff, each try again, how
   * each run ended, and what the Task waits on now. tracking-data.js describes the Tasks still in
   * Tracking by their runs, not by steps, so their legs are worked out here.
   */
  function deriveLeg(task) {
    var steps = [{ at: task.handedAt, who: "you", text: "Handed to <b>" + task.wf + "</b>" }];
    task.runs.forEach(function (run) {
      if (run.again) steps.push({ at: run.start, who: "you", text: "Tried again" });
      if (run.state === "finished") steps.push({ at: run.end, who: run.wf, pose: "done", text: "Finished" });
      if (run.state === "failed") steps.push({ at: run.end, who: run.wf, pose: "failed", text: "Failed: " + run.reason.charAt(0).toLowerCase() + run.reason.slice(1) });
      if (run.state === "stopped") steps.push({ at: run.end, who: "you", text: "Stopped it" });
      if (run.state === "working" && !task.waitsOn) {
        steps.push({ at: task.since, who: run.wf, pose: "working", text: task.checks ? "Waiting for checks on " + task.line : "Working" });
      }
    });
    var w = task.waitsOn;
    if (w && w.type === "request") steps.push({ at: w.at, who: task.wf, pose: "waiting", text: "Asks to run <code>" + w.code + "</code>" });
    if (w && w.type === "signal") steps.push({ at: w.at, src: findSignal(w.signalId).src, text: w.text + ", on your To do list" });
    return steps;
  }

  /* ------------------------------------------------------------------ keys */

  /** Returns the pane's foot of keys for a Done row. */
  function keys(item) {
    var more = !item.trip ? "" : isTaskOpen(item) ? "<span><kbd>↩</kbd> go to Tracking</span>" : "<span><kbd>O</kbd> open the run</span>";
    return '<div class="ad-keys"><span><kbd>J</kbd><kbd>K</kbd> move</span>' + more + "</div>";
  }

  window.TrackingDone = { buildList: buildList, buildPane: buildPane, keys: keys };
})();
