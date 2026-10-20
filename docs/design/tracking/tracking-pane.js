// DRAWING - Tracking: the pane of a selected row, and the pane of a plain signal beside it.
//
// A Tracking row's pane reads, top to bottom (#797, decisions 9 and 11):
//   - the head: the row's state, the Task's title, and one sentence about where the work stands;
//   - what waits, when the row waits on Rogier for a reason he must act on elsewhere: a Request
//     in the run's thread, or a signal on To do that names the Task. A failed row leads with why;
//   - You asked: Rogier's handoff, and the signal he handed off;
//   - Runs: every run on the Task, in order;
//   - What it did: the last message of the latest run's agent;
//   - Linked work: the pull requests on the Task, once they land on it;
//   - the answers for the row's state. No answer does two things at once.
// tracking.js inserts what these functions return and draws the placeholders in it.
(function () {
  "use strict";

  var T = window.Tracking;
  var esc = T.escapeHtml;

  /* ------------------------------------------------------------------ text */

  /** Returns text as HTML, with `backticks` as code. The text is escaped first. */
  function formatInline(text) {
    return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  /**
   * Returns an agent's message as HTML: one paragraph per entry, and a run of entries that start
   * with "- " as one bulleted list.
   */
  function formatMessage(entries) {
    var html = "";
    var list = "";
    entries.forEach(function (entry) {
      if (entry.indexOf("- ") === 0) {
        list += "<li>" + formatInline(entry.slice(2)) + "</li>";
        return;
      }
      if (list) html += "<ul>" + list + "</ul>";
      list = "";
      html += "<p>" + formatInline(entry) + "</p>";
    });
    if (list) html += "<ul>" + list + "</ul>";
    return html;
  }

  /** Returns a word with its first letter in lower case, for a key's label in the foot. */
  function lowerFirst(text) {
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  /* ------------------------------------------------------------------ a Tracking row's pane */

  /** Returns the latest run of a Task. */
  function findLastRun(task) {
    return task.runs[task.runs.length - 1];
  }

  /** Returns the word a row's state reads as: a Working Task that only waits on its checks reads "Waiting for checks". */
  function describeStateWord(task) {
    return task.checks ? "Waiting for checks" : T.STATES[task.state].word;
  }

  /**
   * Returns the sentence under the title: where the work stands, and since when. It names the
   * workflow, because the title names the work and not who does it.
   */
  function describeStanding(task) {
    var run = findLastRun(task);
    switch (task.state) {
      case "needs":
        if (task.waitsOn.type === "request") return task.wf + " has waited for your answer since " + task.waitsOn.at;
        return task.wf + " finished at " + run.end + ", after " + T.formatSpan(run.start, run.end) + ". " + task.waitsOn.text + " at " + task.waitsOn.at;
      case "failed":
        return task.wf + " failed at " + run.end + ", after " + T.formatSpan(run.start, run.end);
      case "finished":
        return task.wf + " finished at " + run.end + ", after " + T.formatSpan(run.start, run.end);
      case "working":
        if (task.checks) return task.wf + " is waiting for checks on " + task.line;
        return task.wf + " has worked for " + T.formatSpan(run.start, T.formatClock(T.NOW));
      case "stopped":
        return "You stopped " + task.wf + " at " + run.end;
    }
  }

  function buildHead(task) {
    var state = T.STATES[task.state];
    return (
      '<header class="ad-head">' +
      '<div class="ad-kind">' +
      '<span class="tr-state' + (state.waits ? " tr-state--you" : "") + '"><i data-mark="' + state.mark + '" data-size="14"></i>' + describeStateWord(task) + "</span>" +
      "<span>·</span><span>Tracking</span>" +
      "</div>" +
      '<h2 class="ad-title">' + esc(task.title) + "</h2>" +
      '<p class="ad-asked">' + esc(describeStanding(task)) + "</p>" +
      "</header>"
    );
  }

  /**
   * Returns the block that leads the pane when the row needs Rogier somewhere else, or failed.
   * A Request is answered in its thread and a follow-up signal on To do, so this block points
   * there rather than offering a second way to answer.
   */
  function buildLead(task) {
    if (task.state === "needs" && task.waitsOn.type === "request") {
      return (
        '<div class="tr-lead tr-lead--you">' +
        '<p class="tr-lead-h"><i data-face="' + task.wf + '" data-pose="waiting" data-size="18"></i><b>' + task.wf + "</b> asks you<time>" + task.waitsOn.at + "</time></p>" +
        '<p class="tr-lead-text">Run <code>' + esc(task.waitsOn.code) + "</code>?</p>" +
        '<a class="tr-link" href="#" data-toast="Opens the thread of ' + task.wf + ', where the question waits">Answer it in the thread</a>' +
        "</div>"
      );
    }
    if (task.state === "needs") {
      var signal = T.SIGNALS.filter(function (s) {
        return s.id === task.waitsOn.signalId;
      })[0];
      return (
        '<div class="tr-lead tr-lead--you">' +
        '<p class="tr-lead-h"><i data-brand="' + signal.src + '" data-size="14"></i><b>' + esc(task.waitsOn.text) + "</b><time>" + task.waitsOn.at + "</time></p>" +
        '<p class="tr-lead-meta">' + esc(task.waitsOn.where) + " · on your To do list</p>" +
        '<a class="tr-link" href="#" data-select="' + signal.id + '">Open the signal</a>' +
        "</div>"
      );
    }
    if (task.state === "failed") {
      return (
        '<div class="tr-lead tr-lead--fail">' +
        '<p class="tr-lead-h"><i data-face="' + task.wf + '" data-pose="failed" data-size="18"></i><b>' + task.wf + " failed</b><time>" + findLastRun(task).end + "</time></p>" +
        '<p class="tr-lead-text">' + formatInline(task.failure) + "</p>" +
        "</div>"
      );
    }
    return "";
  }

  /** Returns You asked: Rogier's handoff, then the signal he handed off, as it came in. */
  function buildAsked(task) {
    var a = task.asked;
    return (
      '<section class="tr-sec">' +
      '<h3 class="tr-h">You asked</h3>' +
      '<p class="tr-handed"><i data-you data-size="18"></i><span>You handed it to <b>' + task.wf + "</b></span><time>" + task.handedAt + "</time></p>" +
      '<div class="b-msg tr-asked">' +
      '<div class="b-msg-head"><i data-brand="' + a.src + '" data-size="14"></i><b>' + esc(a.who) + "</b><span>" + esc(lowerFirst(a.kind)) + " · " + esc(a.where) + "</span><time>" + a.at + "</time></div>" +
      "<p>" + formatInline(a.text) + "</p>" +
      "</div>" +
      "</section>"
    );
  }

  /** Returns what a run's state reads as in Runs, with the time it took or has taken so far. */
  function describeRun(task, run) {
    var end = run.end || T.formatClock(T.NOW);
    var span = T.formatSpan(run.start, end);
    if (run.state === "working") {
      var word = task.state === "needs" && task.waitsOn.type === "request" ? "waiting on you" : task.checks ? "waiting for checks" : "working";
      return { word: word, time: "since " + run.start + " · " + span };
    }
    var words = { finished: "finished", failed: "failed", stopped: "stopped" };
    return { word: words[run.state] + (run.reason ? ": " + lowerFirst(run.reason) : ""), time: run.start + " to " + run.end + " · " + span };
  }

  /** Returns Runs: one row per run on the Task, each with its run page and its thread. */
  function buildRuns(task) {
    var rows = task.runs
      .map(function (run) {
        var pose = run.state === "working" ? (task.state === "needs" ? "waiting" : "working") : T.STATES[run.state].pose;
        var d = describeRun(task, run);
        return (
          '<li class="tr-run">' +
          '<i data-face="' + run.wf + '" data-pose="' + pose + '" data-size="18"></i>' +
          '<span class="tr-run-name"><b>' + (run.again ? "Tried again" : run.wf) + '</b><span class="tr-run-state' + (run.state === "failed" ? " tr-run-state--fail" : "") + '">' + esc(d.word) + "</span></span>" +
          '<span class="tr-run-time">' + d.time + "</span>" +
          '<span class="tr-run-links">' +
          '<a class="btn btn--quiet btn--sm" href="#" data-toast="Opens the run of ' + run.wf + ' in Workflows">Run</a>' +
          '<a class="btn btn--quiet btn--sm" href="#" data-toast="Opens the thread of ' + run.wf + '">Thread</a>' +
          "</span>" +
          "</li>"
        );
      })
      .join("");
    return '<section class="tr-sec"><h3 class="tr-h">Runs</h3><ol class="tr-runs">' + rows + "</ol></section>";
  }

  /** Returns What it did: the last message of the latest run's agent, cut short. */
  function buildDid(task) {
    var run = findLastRun(task);
    var pose = run.state === "working" ? (task.state === "needs" ? "waiting" : "working") : T.STATES[run.state].pose;
    return (
      '<section class="tr-sec">' +
      '<h3 class="tr-h">What it did</h3>' +
      '<div class="b-msg tr-did">' +
      '<div class="b-msg-head"><i data-face="' + run.wf + '" data-pose="' + pose + '" data-size="18"></i><span>Last message from <b>' + run.wf + "</b></span>" + (run.end ? "<time>" + run.end + "</time>" : "") + "</div>" +
      '<div class="tr-did-body">' + formatMessage(task.did) + "</div>" +
      '<a class="tr-link" href="#" data-toast="Opens the thread of ' + run.wf + ' at its last message">Read the rest</a>' +
      "</div>" +
      "</section>"
    );
  }

  /** Returns Linked work: the pull requests on the Task. It is left out while there are none. */
  function buildLinked(task) {
    if (!task.linked) return "";
    var rows = task.linked
      .map(function (pr) {
        return (
          '<a class="tr-pr" href="#" data-toast="Opens #' + pr.number + ' on GitHub">' +
          '<i data-brand="github" data-size="14"></i>' +
          '<span class="tr-pr-title"><b>#' + pr.number + "</b>" + esc(pr.title) + "</span>" +
          '<span class="tr-pr-where">' + esc(pr.where) + "</span>" +
          '<span class="tr-tag">' + pr.state + "</span>" +
          '<span class="tr-pr-size"><span class="plus">+' + pr.plus + '</span><span class="minus">−' + pr.minus + "</span></span>" +
          '<span class="tr-pr-checks"><i data-mark="failed" data-size="14"></i>' + pr.checks + "</span>" +
          "</a>"
        );
      })
      .join("");
    return '<section class="tr-sec"><h3 class="tr-h">Linked work</h3>' + rows + "</section>";
  }

  /**
   * Returns the answers for a row's state, in the order #797's decision 9 gives them. The first
   * answer of Finished and of Failed is the suggested one; Working, Needs you and Stopped have none.
   */
  function listAnswers(task) {
    var wf = "<b>" + task.wf + "</b>";
    var on = "<b>" + esc(task.title) + "</b>";
    var done = { key: "done", label: "Mark done", describe: "Marks it done and takes it off Tracking. Nothing is sent", kbd: "E" };
    var again = { key: "again", label: "Try again", describe: "Re-runs " + wf + " on " + on + " from the start" };
    var cancel = { key: "cancel", label: "Cancel", quiet: true, describe: "Takes it off Tracking as cancelled. Nothing is sent" };
    var stop = { key: "stop", label: "Stop the run", describe: "Stops " + wf + ". The row stays, as Stopped" };
    var open = { key: "open", label: "Open the run", describe: "Opens the run in Workflows: its steps, its thread and its log" };
    switch (task.state) {
      case "needs":
        // A row that needs you through a signal on To do has no live run to stop. E marks only
        // Finished, Failed and Stopped rows done, so Mark done carries no key here.
        if (task.waitsOn.type === "signal") return [again, { key: "done", label: done.label, describe: done.describe }, cancel, open];
        return [stop, open];
      case "working":
        return [stop, open];
      case "finished":
        return [primary(done), again, cancel, open];
      case "failed":
        return [primary(again), done, cancel, open];
      case "stopped":
        return [again, done, cancel];
    }
  }

  function primary(answer) {
    var copy = {};
    for (var k in answer) copy[k] = answer[k];
    copy.primary = true;
    return copy;
  }

  /** Returns one answer as the ledger draws it: the button, what the click does, and its key. */
  function buildAnswer(a) {
    var cls = "btn" + (a.primary ? " btn--accent" : "") + (a.quiet ? " btn--quiet" : "");
    var kbd = a.primary ? "↩" : a.kbd || "";
    return (
      '<div class="ans">' +
      '<button class="' + cls + '" data-answer="' + a.key + '">' + (a.face ? '<i data-face="' + a.face + '" data-size="18"></i>' : "") + (a.icon ? '<i data-i="' + a.icon + '" data-size="14"></i>' : "") + a.label + "</button>" +
      '<span class="ans-desc">' + a.describe + "</span>" +
      (kbd ? "<kbd>" + kbd + "</kbd>" : "<span></span>") +
      "</div>"
    );
  }

  function buildLedger(answers) {
    return '<section class="ad-answers"><div class="ledger">' + answers.map(buildAnswer).join("") + "</div></section>";
  }

  /** Returns the pane of a Tracking row. */
  function build(task) {
    return (
      '<article class="ad tr-pane" data-task="' + task.id + '">' +
      buildHead(task) +
      '<div class="ad-blocks">' +
      buildLead(task) +
      buildAsked(task) +
      buildRuns(task) +
      buildDid(task) +
      buildLinked(task) +
      "</div>" +
      buildLedger(listAnswers(task)) +
      "</article>"
    );
  }

  /** Returns the keys of a Tracking row's pane, kept in view at its foot. */
  function keys(task) {
    var answers = listAnswers(task);
    var html = "<span><kbd>J</kbd><kbd>K</kbd> move</span>";
    var suggested = answers.filter(function (a) {
      return a.primary;
    })[0];
    if (suggested) html += "<span><kbd>↩</kbd> " + lowerFirst(suggested.label) + "</span>";
    var canMarkDone = answers.some(function (a) {
      return a.key === "done";
    });
    if (canMarkDone && !(suggested && suggested.key === "done")) html += "<span><kbd>E</kbd> mark done</span>";
    html += "<span><kbd>Esc</kbd> close</span>";
    return '<div class="ad-keys">' + html + "</div>";
  }

  /* ------------------------------------------------------------------ a signal's pane */

  // What the drawing knows of a signal beyond its row: the failed checks on #1302, the follow-up
  // that names PAY-212's Task. Other signals draw their head, Your work and answers only.
  var CHECKS = {
    "s-1302": [
      { name: "test / refunds", at: "09:31", log: "refunds.test.ts:88  expected 2 refunds, got 1\n  createRefund groups lines by payment, not by line" },
      { name: "test / migrations", at: "09:32" },
    ],
  };

  /** Returns a signal's row line split into who asks, the kind, and where: "Marta · review requested · payments-api #1294". */
  function parseSub(sub) {
    var p = sub.split(" · ");
    return { who: p[0], kind: p[1], where: p[2] };
  }

  /** Returns a signal's kind as its pane names it: "Checks failed". */
  function formatKind(kind) {
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }

  function buildChecks(signal) {
    var checks = CHECKS[signal.id];
    if (!checks) return "";
    var rows = checks
      .map(function (c) {
        return (
          '<li class="b-check b-check--failed"><i data-mark="failed" data-size="14"></i><span class="mono">' + c.name + "</span><time>" + c.at + "</time>" +
          (c.log ? '<pre class="b-log mono">' + esc(c.log) + "</pre>" : "") +
          "</li>"
        );
      })
      .join("");
    return '<ul class="b-checks">' + rows + '<li class="b-check tr-check-more"><i data-mark="done" data-size="14"></i><span>9 checks passed</span><span></span></li></ul>';
  }

  /** Returns Your work for a signal that names a Task in Tracking: the Task, and its row's state. */
  function buildYourWork(signal) {
    if (!signal.task) return "";
    var task = T.TASKS.filter(function (t) {
      return t.id === signal.task;
    })[0];
    var state = T.STATES[task.state];
    return (
      '<div class="b-work">' +
      '<span class="b-work-mark' + (state.waits ? " ad-mark--you" : " ad-mark--quiet") + '"><i data-mark="' + state.mark + '" data-size="16"></i></span>' +
      '<span class="b-work-text"><span class="b-work-label">Your work</span><b>' + esc(task.title) + "</b><span>In Tracking · <b>" + state.word + "</b></span></span>" +
      '<a class="btn btn--sm" href="#" data-select="' + task.id + '">Show in Tracking</a>' +
      "</div>"
    );
  }

  /** Returns the pane of a signal on To do: a compact copy of the app's signal pane. */
  function buildSignal(signal) {
    var s = parseSub(signal.sub);
    var system = T.SOURCES[signal.src];
    var task = signal.task
      ? T.TASKS.filter(function (t) {
          return t.id === signal.task;
        })[0]
      : null;
    var asked = (s.kind === "checks failed" ? s.who + " in " : s.who + " asks in ") + s.where + " · " + signal.at;
    var start = {
      key: "hand",
      label: "Start “Fix bug”",
      face: "Fix bug",
      describe: task ? "Starts <b>Fix bug</b> on <b>" + esc(s.where) + "</b>, tracked on <b>" + esc(task.title) + "</b>" : "Starts <b>Fix bug</b> on <b>" + esc(s.where) + "</b>, tracked as new work",
    };
    var done = { key: "done", label: "Done", quiet: true, kbd: "E", describe: "Takes it off your list. " + system + " is not told" };
    var snooze = { key: "snooze", label: "Snooze…", quiet: true, icon: "alarm", kbd: "H", describe: "Hides it from To do until a time you pick. Only for you" };
    return (
      '<article class="ad tr-pane" data-signal="' + signal.id + '">' +
      '<header class="ad-head">' +
      '<div class="ad-kind"><span class="src"><i data-brand="' + signal.src + '" data-size="14"></i>' + system + " · " + formatKind(s.kind) + "</span>" +
      '<span class="spacer"></span>' +
      '<a class="btn btn--quiet btn--sm" href="#" data-toast="Opens ' + esc(s.where) + " on " + system + '">Open on ' + system + '<i data-i="external" data-size="13"></i></a>' +
      '<button class="icon-btn" aria-label="More"><i data-i="more" data-size="16"></i></button>' +
      "</div>" +
      '<h2 class="ad-title">' + esc(signal.title) + "</h2>" +
      '<p class="ad-asked">' + esc(asked) + "</p>" +
      "</header>" +
      '<div class="ad-blocks">' +
      buildChecks(signal) +
      buildYourWork(signal) +
      "</div>" +
      '<section class="ad-answers"><div class="ledger">' + [start, done, snooze].map(buildAnswer).join("") + "</div></section>" +
      "</article>"
    );
  }

  /** Returns the keys of a signal's pane, as the app's foot lists them. */
  function signalKeys() {
    return '<div class="ad-keys"><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>E</kbd> done</span><span><kbd>H</kbd> snooze</span><span><kbd>O</kbd> open</span><span><kbd>Esc</kbd> close</span></div>';
  }

  window.TrackingPane = { build: build, keys: keys, buildSignal: buildSignal, signalKeys: signalKeys };
})();
