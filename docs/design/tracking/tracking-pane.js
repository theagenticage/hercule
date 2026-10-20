// DRAWING - Tracking: the pane of a selected row, drawn as Round Trip draws its pane, and the pane
// of a plain signal beside it.
//
// A Tracking row's pane is one trip, read top to bottom on one hairline:
//   - the head: the colleague's face and the row's state, the Task's title, and when and where it ran;
//   - You asked: Rogier's handoff, and the signal he handed off;
//   - the agent's message: why it failed, its last message, its runs when there is more than one,
//     the pull request it opened, and the question it asks when it waits on Rogier;
//   - when a signal on To do names the Task (checks failed on its PR), that signal, last;
//   - the verdict: the answers for the row's state (#797, decision 9). No answer does two things.
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

  /** Returns a sentence with its first letter in lower case, for a key's label or a small line. */
  function lowerFirst(text) {
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  /** Returns a sentence with its first letter in upper case. */
  function upperFirst(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /* ------------------------------------------------------------------ what the Task is */

  function findLastRun(task) {
    return task.runs[task.runs.length - 1];
  }

  /** Checks whether the row waits on Rogier because of a signal on To do, not a question in the run. */
  function waitsOnSignal(task) {
    return task.state === "needs" && task.waitsOn && task.waitsOn.type === "signal";
  }

  /** Returns the word the row's state reads as. A Working Task that only waits on checks reads "Waiting for checks". */
  function describeStateWord(task) {
    return task.state === "working" && task.checks ? "Waiting for checks" : T.STATES[task.state].word;
  }

  /**
   * Returns the pose of the colleague's face. A row that waits on a signal shows the agent as its
   * last run left it, because the agent itself asks nothing.
   */
  function choosePose(task) {
    if (waitsOnSignal(task)) return findLastRun(task).state === "failed" ? "failed" : "done";
    return T.STATES[task.state].pose;
  }

  /** Returns the clock time the agent's message is stamped with, in a small line beside its name. */
  function describeStamp(task) {
    var run = findLastRun(task);
    if (waitsOnSignal(task) || task.state === "finished") return "finished " + run.end;
    if (task.state === "failed") return "failed " + run.end;
    if (task.state === "stopped") return "stopped " + run.end;
    if (task.state === "needs") return "waiting on you since " + task.waitsOn.at;
    return task.checks ? "waiting for checks" : "working";
  }

  /** Returns the line under the title: when the work ended or started, how long it took, and who ran it. */
  function describeStanding(task) {
    var run = findLastRun(task);
    var line;
    if (task.state === "needs") line = "Waiting on you since " + task.waitsOn.at;
    else if (task.state === "finished") line = "Finished at " + run.end + " after " + T.formatSpan(run.start, run.end);
    else if (task.state === "failed") line = "Failed at " + run.end + " after " + T.formatSpan(run.start, run.end);
    else if (task.state === "stopped") line = "Stopped by you at " + run.end;
    else line = "Started at " + run.start + " · " + (T.formatAge(run.start) === "now" ? "just now" : T.formatAge(run.start) + " so far");
    return line + " · " + task.worker;
  }

  /* ------------------------------------------------------------------ the head */

  function buildHead(task) {
    var state = T.STATES[task.state];
    var tone = task.state === "failed" ? "fail-ink" : task.state === "finished" ? "ok-ink" : state.waits ? "you-ink" : "";
    return (
      '<header class="ad-head"><div class="ad-kind">' +
      '<span class="src">' + T.face(task.wf, choosePose(task), 18) + task.wf + "</span><span>·</span>" +
      '<span class="' + tone + '">' + describeStateWord(task) + "</span>" +
      '<span class="spacer"></span><button class="btn btn--quiet btn--sm" data-answer="open">Open the run' + T.icon("external", 13) + "</button></div>" +
      '<h2 class="ad-title">' + esc(task.title) + "</h2>" +
      '<p class="ad-asked">' + describeStanding(task) + "</p></header>"
    );
  }

  /* ------------------------------------------------------------------ the trip */

  // You asked: the signal Rogier handed off, two lines of it, under the moment he handed it.
  function buildAsked(task) {
    var a = task.asked;
    return (
      '<div class="msg rt-msg rt-msg--you">' +
      '<span class="rt-av">' + window.Crew.you(28) + "</span>" +
      '<div class="rt-msg-body">' +
      '<div class="msg-name rt-name">You asked <small>' + task.handedAt + " · handed to " + task.runs[0].wf + "</small></div>" +
      '<div class="rt-orig">' +
      '<div class="rt-orig-h"><span class="rt-orig-src">' + T.sourceMark(a.src, 13) + "</span><b>" + esc(a.who) + "</b><span>· " + lowerFirst(a.kind) + " · " + esc(a.where) + "</span></div>" +
      '<p class="rt-orig-q">' + formatInline(a.text) + "</p></div>" +
      "</div></div>"
    );
  }

  /**
   * Returns the runs as steps: when each started and how it ended, and for live work what the agent
   * does now. Drawn while the work is live, or when the Task ran more than once; one ended run
   * says all of that in the head already.
   */
  function buildSteps(task) {
    if (task.runs.length < 2 && task.state !== "working") return "";
    var items = [];
    task.runs.forEach(function (run, i) {
      items.push(step(run.start, i === 0 ? "Started on " + esc(task.asked.where) : "Tried again"));
      if (run.end) {
        var word = run.state === "failed" ? "failed" + (run.reason ? ": " + esc(run.reason) : "") : run.state;
        items.push(step(run.end, T.who(run.wf) + " " + word));
      }
    });
    if (task.state === "working") items.push(step(T.formatClock(T.NOW), upperFirst(task.narration || "Working"), true));
    return '<ol class="rt-steps">' + items.join("") + "</ol>";
  }

  function step(at, text, live) {
    return '<li class="' + (live ? "is-live" : "") + '"><time>' + at + "</time>" + (live ? window.Crew.mark("working", 14) : '<span class="rt-step-dot"></span>') + "<span>" + text + "</span></li>";
  }

  // The pull request the agent opened, as Round Trip draws one: its number and title, then its size.
  function buildLinked(task) {
    if (!task.linked) return "";
    return task.linked
      .map(function (pr) {
        return (
          '<div class="rt-verdict">' + T.sourceMark("github", 14) + "<b>#" + pr.number + " " + esc(pr.title) + '</b><span class="chip">' + pr.state + "</span></div>" +
          '<div class="b-change rt-change">' +
          '<span class="b-change-files">' + T.icon("diff", 14) + esc(pr.where) + "</span>" +
          '<span class="plus">+' + pr.plus + '</span><span class="minus">−' + pr.minus + "</span>" +
          '<span class="b-change-checks fail-ink">' + window.Crew.mark("failed", 14) + pr.checks + "</span></div>"
        );
      })
      .join("");
  }

  // The question a run asks, in the waiting tint, with its answers, as the Requests dock draws one.
  function buildQuestion(task) {
    if (task.state !== "needs" || !task.question) return "";
    return (
      '<div class="rt-ask">' +
      '<p class="rt-ask-q">' + window.Crew.mark("waiting", 14) + "<span>" + task.question.text + "</span></p>" +
      '<div class="ledger">' +
      task.question.answers
        .map(function (a, i) {
          var cls = "btn" + (a[2] ? " btn--accent" : i === 2 ? " btn--quiet" : "");
          return (
            '<div class="ans"><button class="' + cls + '" data-question="' + task.id + '" data-q="' + i + '">' + a[0] + "</button>" +
            '<span class="ans-desc">' + a[1] + "</span>" + (a[2] ? "<kbd>↩</kbd>" : "<span></span>") + "</div>"
          );
        })
        .join("") +
      "</div></div>"
    );
  }

  /**
   * Returns what the run's last agent step put out, drawn by its shape. There is no output
   * contract: a workflow is the user's own, so the pane draws what the step record holds.
   *   - A step with no outputSchema puts out `{ text }`, its final message: drawn as text.
   *   - A step with an outputSchema puts out a JSON value: drawn as its top-level fields, labelled
   *     with the schema's titles, each value cut to fit, then a link to the whole output.
   */
  function buildOutput(task) {
    var out = task.output || {};
    var from = out.step ? '<p class="rt-out-from">From the step <b>' + esc(out.step) + "</b></p>" : "";
    if (!out.value) {
      return (
        from +
        '<div class="rt-text rt-did">' + formatMessage(task.did) + "</div>" +
        '<a class="rt-more" href="#" data-toast="Opens the thread of ' + esc(task.wf) + '">Read the rest in the thread</a>'
      );
    }
    return (
      from +
      '<dl class="rt-out">' +
      Object.keys(out.value)
        .map(function (key) {
          return "<div><dt>" + esc((out.titles || {})[key] || key) + "</dt><dd>" + describeValue(out.value[key]) + "</dd></div>";
        })
        .join("") +
      "</dl>" +
      '<a class="rt-more" href="#" data-toast="Opens the run, with the whole output of ' + esc(out.step) + '">See the whole output in the run</a>'
    );
  }

  /**
   * Returns one value of a structured output as a line: a string, number or boolean as it is (a
   * long string cut to two lines), a list as how many items it holds, an object as how many fields.
   */
  function describeValue(value) {
    if (Array.isArray(value)) return '<span class="rt-out-count">' + value.length + (value.length === 1 ? " item" : " items") + "</span>";
    if (value && typeof value === "object") {
      var n = Object.keys(value).length;
      return '<span class="rt-out-count">' + n + (n === 1 ? " field" : " fields") + "</span>";
    }
    if (typeof value === "boolean") return value ? "yes" : "no";
    var text = String(value);
    return text.length > 60 ? '<span class="rt-out-long">' + esc(text) + "</span>" : esc(text);
  }

  // The action step the run ended on, after the agent: what the workflow itself did last.
  function buildEndedOn(task) {
    if (!task.endedOn) return "";
    return '<p class="rt-out-action">' + T.icon("bolt", 14) + "<span>" + esc(task.endedOn.step) + ' <span class="rt-out-sep">·</span> ' + esc(task.endedOn.result) + "</span></p>";
  }

  // What the agent did: why it failed, the output of its last step, its runs, the action the run
  // ended on, the PR it opened, and its question.
  function buildDid(task) {
    var showDid = task.state !== "working";
    return (
      '<div class="msg rt-msg rt-msg--did">' +
      '<span class="rt-av">' + T.face(task.wf, choosePose(task), 28) + "</span>" +
      '<div class="rt-msg-body">' +
      '<div class="msg-name rt-name" style="--hue:var(--hue-' + window.Crew.lookFor(task.wf).hue + ')">' + task.wf + " <small>" + describeStamp(task) + "</small></div>" +
      (task.state === "failed" && task.failure ? '<p class="rt-text rt-fail">' + formatInline(task.failure) + "</p>" : "") +
      (showDid ? buildOutput(task) : "") +
      buildSteps(task) +
      buildEndedOn(task) +
      buildLinked(task) +
      buildQuestion(task) +
      "</div></div>"
    );
  }

  // The signal on To do that makes the row wait on Rogier: checks failed on the PR the agent opened.
  // It closes the trip, in the waiting tint, with the way to it.
  function buildWaitingSignal(task) {
    if (!waitsOnSignal(task)) return "";
    var signal = T.SIGNALS.filter(function (s) {
      return s.id === task.waitsOn.signalId;
    })[0];
    var who = signal.sub.split(" · ")[0];
    return (
      '<div class="msg rt-msg rt-msg--src">' +
      '<span class="rt-av"><span class="rt-src-av">' + T.sourceMark(signal.src, 14) + "</span></span>" +
      '<div class="rt-msg-body">' +
      '<div class="msg-name rt-name">' + esc(who) + " <small>" + lowerFirst(task.waitsOn.text) + " · " + task.waitsOn.at + "</small></div>" +
      '<div class="rt-ask rt-ask--signal">' +
      '<p class="rt-ask-q">' + window.Crew.mark("waiting", 14) + "<span><code>test / refunds</code> expected 2 refunds, got 1. It is on your To do list.</span></p>" +
      '<a class="btn btn--sm" href="#" data-select="' + signal.id + '">Open the signal</a>' +
      "</div></div></div>"
    );
  }

  /* ------------------------------------------------------------------ the verdict */

  /** Returns the answers for the row's state, the suggested one marked `primary`. */
  function listAnswers(task) {
    var wf = "<b>" + esc(task.wf) + "</b>";
    var stop = { key: "stop", label: "Stop the run", describe: "Stops " + wf + ". The row stays in Tracking, as Stopped" };
    var again = { key: "again", label: "Try again", describe: "Re-runs " + wf + " on <b>" + esc(task.title) + "</b> from the start", fine: task.worker };
    var done = { key: "done", label: "Mark done", kbd: "E", describe: "Takes it off Tracking and marks the work done. Nothing is sent" };
    var cancel = { key: "cancel", label: "Cancel", quiet: true, describe: "Takes it off Tracking as cancelled. Nothing is sent" };
    if (waitsOnSignal(task)) return [again, done, cancel];
    if (task.state === "working" || task.state === "needs") return [stop];
    if (task.state === "finished") return [primary(done), again, cancel];
    if (task.state === "failed") return [primary(again), done, cancel];
    return [again, done, cancel];
  }

  function primary(answer) {
    var a = {};
    for (var k in answer) a[k] = answer[k];
    a.primary = true;
    a.kbd = "↩";
    return a;
  }

  function buildAnswer(a) {
    var cls = "btn" + (a.primary ? " btn--accent" : "") + (a.quiet ? " btn--quiet" : "");
    return (
      '<div class="ans"><button class="' + cls + '" data-answer="' + a.key + '">' + a.label + "</button>" +
      '<span class="ans-desc">' + a.describe + (a.fine ? '<span class="ad-fine">' + esc(a.fine) + "</span>" : "") + "</span>" +
      (a.kbd ? "<kbd>" + a.kbd + "</kbd>" : "<span></span>") +
      "</div>"
    );
  }

  function buildFoot(task) {
    var live = task.state === "working" || (task.state === "needs" && !waitsOnSignal(task));
    return (
      '<footer class="ad-foot"><p class="ad-leaves">' +
      (live
        ? T.icon("clock", 14) + "Tracking follows the run. You hear when it finishes or fails."
        : T.icon("check", 14) + "Leaves Tracking when you mark it done or cancel it. The agent's work stays where it is.") +
      "</p></footer>"
    );
  }

  /** Returns the pane of a Tracking row: the head, the trip, the answers for its state, and the foot. */
  function build(task) {
    return (
      '<article class="ad rt-pane" data-task="' + task.id + '">' +
      buildHead(task) +
      '<div class="rt-trip">' + buildAsked(task) + buildDid(task) + buildWaitingSignal(task) + "</div>" +
      '<div class="ad-answers"><div class="ledger">' + listAnswers(task).map(buildAnswer).join("") + "</div></div>" +
      buildFoot(task) +
      "</article>"
    );
  }

  /** Returns the keys of a Tracking row's pane: the suggested answer, Mark done where it applies, and the run. */
  function keys(task) {
    var answers = listAnswers(task);
    var suggested = answers.filter(function (a) {
      return a.primary;
    })[0];
    var html = "<span><kbd>J</kbd><kbd>K</kbd> move</span>";
    if (task.question && task.state === "needs") html += "<span><kbd>↩</kbd> allow once</span>";
    if (suggested) html += "<span><kbd>↩</kbd> " + lowerFirst(suggested.label) + "</span>";
    if (
      answers.some(function (a) {
        return a.key === "done" && !a.primary;
      })
    )
      html += "<span><kbd>E</kbd> mark done</span>";
    html += "<span><kbd>O</kbd> open the run</span>";
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

  function buildChecks(signal) {
    var checks = CHECKS[signal.id];
    if (!checks) return "";
    var rows = checks
      .map(function (c) {
        return (
          '<li class="b-check b-check--failed">' + window.Crew.mark("failed", 14) + '<span class="mono">' + c.name + "</span><time>" + c.at + "</time>" +
          (c.log ? '<pre class="b-log mono">' + esc(c.log) + "</pre>" : "") +
          "</li>"
        );
      })
      .join("");
    return '<ul class="b-checks">' + rows + '<li class="b-check tr-check-more">' + window.Crew.mark("done", 14) + "<span>9 checks passed</span><span></span></li></ul>";
  }

  // Your work, for a signal that names a Task in Tracking: the face of the agent on it, the Task,
  // and its row's state, with the way to the row.
  function buildYourWork(signal) {
    if (!signal.task) return "";
    var task = T.TASKS.filter(function (t) {
      return t.id === signal.task;
    })[0];
    var state = T.STATES[task.state];
    return (
      '<div class="b-work">' +
      T.face(task.wf, choosePose(task), 28) +
      '<span class="b-work-text"><span class="b-work-label">Your work</span><b>' + esc(task.title) + "</b>" +
      "<span>In Tracking · " + (state.waits ? "<b>" + lowerFirst(state.word) + "</b>" : lowerFirst(state.word)) + "</span></span>" +
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
      label: T.face("Fix bug", "idle", 18) + "Start “Fix bug”",
      describe: task ? "Starts <b>Fix bug</b> on <b>" + esc(s.where) + "</b>, tracked on <b>" + esc(task.title) + "</b>" : "Starts <b>Fix bug</b> on <b>" + esc(s.where) + "</b>, tracked as new work",
    };
    var done = { key: "done", label: "Done", quiet: true, kbd: "E", describe: "Takes it off your list. " + system + " is not told" };
    var snooze = { key: "snooze", label: T.icon("alarm", 14) + "Snooze…", quiet: true, kbd: "H", describe: "Hides it from To do until a time you pick. Only for you" };
    return (
      '<article class="ad rt-pane" data-signal="' + signal.id + '">' +
      '<header class="ad-head">' +
      '<div class="ad-kind"><span class="src">' + T.sourceMark(signal.src, 14) + system + " · " + upperFirst(s.kind) + "</span>" +
      '<span class="spacer"></span>' +
      '<a class="btn btn--quiet btn--sm" href="#" data-toast="Opens ' + esc(s.where) + " on " + system + '">Open on ' + system + T.icon("external", 13) + "</a>" +
      '<button class="icon-btn" aria-label="More">' + T.icon("more", 16) + "</button>" +
      "</div>" +
      '<h2 class="ad-title">' + esc(signal.title) + "</h2>" +
      '<p class="ad-asked">' + esc(asked) + "</p>" +
      "</header>" +
      '<div class="ad-blocks">' + buildChecks(signal) + buildYourWork(signal) + "</div>" +
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
