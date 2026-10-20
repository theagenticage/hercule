// DRAWING - Tracking: the Done view. Each signal Rogier handed to an agent shows its own leg of
// the Task's trip: the handoff, its run and that run's re-runs, then how the leg ended. An earlier
// leg ends with the handoff that came next ("continued: Fix bug"); the latest ends with the Task's
// state, which while the Task is open is its Tracking state ("needs you"). Legs are never folded,
// so a Task with two handoffs shows two rows (#797, decision 12).
(function () {
  "use strict";

  var T = window.Tracking;

  // What the two PAY-205 signals held. They are not in Tracking any more (the Task is done), so
  // tracking-data.js has no Task to read them from.
  var ASKED = {
    "d-205b": {
      kind: "Checks failed",
      who: "GitHub Actions",
      where: "webshop #1291",
      at: "08:41",
      checks: [
        { state: "failed", name: "test / codes", time: "1m 12s", log: "✕ applies SUMMER10 when typed as summer10\n  expected: 10% off\n  received: Code not found" },
        { state: "done", name: "lint", time: "38s" },
      ],
    },
    "d-205a": {
      kind: "Assigned",
      who: "Pieter",
      where: "PAY-205",
      at: "07:52",
      text: "Codes typed in lowercase are rejected at checkout: <code>summer10</code> fails where <code>SUMMER10</code> works.",
    },
    "d-deps": {
      kind: "Review requested",
      who: "Dependabot",
      where: "webshop #1288",
      at: "07:30",
      text: "Bumps 4 dependencies, all patch releases. All checks pass.",
    },
  };

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

  /** Returns what the signal of a Done row held: its kind, who asked, where, when and its text. */
  function readAsked(item) {
    if (ASKED[item.id]) return ASKED[item.id];
    var t = findTask(item.task);
    return t ? t.asked : { kind: "", who: "", where: "", at: item.at };
  }

  /** Returns the workflow a leg was handed to, read from its first step: "Handed to Fix bug" gives "Fix bug". */
  function readWorkflow(item) {
    return item.trip ? item.trip[0].replace(/^Handed to /, "") : "";
  }

  /** Checks whether the row's Task is still in Tracking, so its trip line ends with a Tracking state. */
  function isTaskOpen(item) {
    return Boolean(item.task && findTask(item.task));
  }

  /* ------------------------------------------------------------------ the list */

  /**
   * Returns the Done view's list: a day heading, then one quiet row per resolved signal, newest
   * first. `selectedId` marks the open row. A handed-off signal's second line is its trip line.
   */
  function buildList(selectedId) {
    return (
      '<h2 class="section-h asks-sec">Today</h2>' +
      '<div class="asks-rows asks-rows--quiet">' +
      T.DONE.map(function (item) {
        return buildRow(item, item.id === selectedId);
      }).join("") +
      "</div>"
    );
  }

  function buildRow(item, on) {
    return (
      '<div class="ask-item' + (on ? " is-on" : "") + '" data-key="' + item.id + '">' +
      '<button class="ask-row" data-id="' + item.id + '">' +
      '<span class="ask-mark">' + T.sourceMark(item.src, 16) + "</span>" +
      '<span class="ask-text"><span class="ask-title">' + item.title + "</span>" +
      '<span class="ask-sub">' + (item.trip ? buildTripLine(item) : item.outcome) + "</span></span>" +
      '<span class="ask-end"><time class="ask-age">' + item.at + "</time></span>" +
      "</button></div>"
    );
  }

  /**
   * Returns a leg's trip line, "Handed to Fix bug → tried again once → done". While the Task is
   * open, its last step is the Tracking state, drawn in marigold when that row waits on Rogier.
   */
  function buildTripLine(item) {
    var steps = item.trip.slice();
    var tail = "";
    if (isTaskOpen(item)) {
      var waits = T.STATES[findTask(item.task).state].waits;
      var last = steps.pop();
      tail = " → " + (waits ? '<span class="tr-done-you">' + last + "</span>" : last);
    }
    return steps.join(" → ") + tail;
  }

  /* ------------------------------------------------------------------ the pane */

  /** Returns the pane of a Done row: the signal as it came in, then what Rogier did and the leg it started. */
  function buildPane(item) {
    var asked = readAsked(item);
    return (
      '<article class="ad tr-done-pane" tabindex="-1">' +
      "<header>" +
      '<div class="ad-kind"><span class="src">' + T.sourceMark(item.src, 14) + T.SOURCES[item.src] + (asked.kind ? " · " + asked.kind : "") + "</span>" +
      '<span class="spacer"></span>' +
      '<a class="btn btn--quiet btn--sm" href="#" data-toast="Opens it on ' + T.SOURCES[item.src] + '">Open on ' + T.SOURCES[item.src] + T.icon("external", 13) + "</a></div>" +
      '<h2 class="ad-title">' + item.title + "</h2>" +
      '<p class="ad-asked">' + asked.who + " asks in " + asked.where + " · " + asked.at + "</p>" +
      "</header>" +
      buildBlocks(asked) +
      '<div class="ad-answers">' + buildOutcome(item) + (item.trip ? buildLeg(item) : "") + "</div>" +
      "</article>"
    );
  }

  function buildBlocks(asked) {
    if (asked.checks) {
      return (
        '<div class="ad-blocks"><ul class="b-checks">' +
        asked.checks
          .map(function (c) {
            return (
              '<li class="b-check b-check--' + c.state + '">' + window.Crew.mark(c.state, 14) + '<span class="mono">' + c.name + "</span><time>" + c.time + "</time>" +
              (c.log ? '<pre class="b-log mono">' + c.log + "</pre>" : "") +
              "</li>"
            );
          })
          .join("") +
        "</ul></div>"
      );
    }
    if (!asked.text) return "";
    var text = asked.text.replace(/`([^`]+)`/g, "<code>$1</code>");
    return (
      '<div class="ad-blocks"><div class="b-msg">' +
      '<div class="b-msg-head"><span class="b-avatar" aria-hidden="true">' + asked.who.charAt(0) + "</span><b>" + asked.who + "</b><time>" + asked.at + "</time></div>" +
      "<p>" + text + "</p></div></div>"
    );
  }

  /**
   * Returns what Rogier did, in place of the answers, as the app draws a resolved signal. A handed-off
   * signal leads with the colleague's face in the pose its leg ended in; the button goes to the
   * Tracking row while the Task is open, and to the run once it is closed.
   */
  function buildOutcome(item) {
    var lead, text, button;
    if (!item.trip) {
      lead = '<span class="b-work-mark">' + window.Crew.mark("done", 16) + "</span>";
      text = item.outcome;
      button = "";
    } else {
      lead = T.face(readWorkflow(item), readLegPose(item), 28);
      text = item.trip[0];
      button = isTaskOpen(item)
        ? '<button class="btn btn--sm" data-select="' + item.task + '">Go to Tracking</button>'
        : '<button class="btn btn--sm" data-toast="Opens the run in Workflows">Open the run</button>';
    }
    return (
      '<section class="ad-outcome" role="status"><div class="ad-outcome-top">' +
      lead +
      '<span class="b-work-text"><span class="b-work-label">What you did</span><b>' + text + "</b><span>Here · today " + item.at + " · by you</span></span>" +
      button +
      "</div></section>"
    );
  }

  /** Returns the face's pose for how a leg ended: the Tracking state's while the Task is open, else done. */
  function readLegPose(item) {
    return isTaskOpen(item) ? T.STATES[findTask(item.task).state].pose : "done";
  }

  /** Returns the leg as a short timeline: who did what, and when, from the handoff to how it ended. */
  function buildLeg(item) {
    var steps = item.leg || deriveLeg(findTask(item.task));
    var last = item.trip[item.trip.length - 1];
    return (
      '<section class="tr-leg-sec" aria-label="This handoff">' +
      '<h3 class="tr-leg-h">This handoff</h3>' +
      '<ol class="tr-leg">' +
      steps
        .map(function (s) {
          return "<li><time>" + s.at + "</time>" + buildLegLead(s) + "<span>" + s.text + "</span></li>";
        })
        .join("") +
      "</ol>" +
      (last.indexOf("continued") === 0 ? '<p class="ad-outcome-desc">Each handoff shows its own leg. The work continued from this one is on the signal you handed next.</p>' : "") +
      "</section>"
    );
  }

  function buildLegLead(step) {
    if (step.who === "you") return window.Crew.you(20);
    if (step.src) return '<span class="tr-leg-src">' + T.sourceMark(step.src, 12) + "</span>";
    return T.face(step.who, step.pose, 20);
  }

  /**
   * Returns the steps of a Task's only leg, read from its runs: the handoff, each try again, how
   * each run ended, and what the Task waits on now. Used for the rows whose Task is still in
   * Tracking, which tracking-data.js describes by its runs rather than by steps.
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
    var open = !item.trip ? "<span><kbd>O</kbd> open</span>" : isTaskOpen(item) ? "<span><kbd>↩</kbd> go to Tracking</span>" : "<span><kbd>O</kbd> open the run</span>";
    return '<div class="ad-keys"><span><kbd>J</kbd><kbd>K</kbd> move</span>' + open + "<span><kbd>Esc</kbd> close</span></div>";
  }

  window.TrackingDone = { buildList: buildList, buildPane: buildPane, keys: keys };
})();
