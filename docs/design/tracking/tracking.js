// DRAWING - Tracking: the list, Tracking, the keys and the motion of the drawing.
//
// Built on Round Trip (prototype/stay-in-the-loop) and worked out in the design session #800.
// To do lists Now and Signals as the app draws them today. Tracking holds one row per Task Rogier
// handed off, led by the face of the agent that has it, and the list column shows either Intake or
// Tracking, never both:
//   - folded, Tracking sits at the foot of the list: a head that sums it up and says "Show all",
//     over the two rows that changed last, where a handoff lands;
//   - opened, it rises over the whole column: every row, grouped by state, and at its foot a row
//     that sums up the signals and goes back.
// The model is the plan's (#797), not Round Trip's: finished and failed work stays in Tracking
// until Rogier marks it done; it never comes back to To do as a new signal. Needs you and Failed
// are marigold, Finished is green; all three wait on him and count toward To do.
//
// The pane (tracking-pane.js) and the Done view (tracking-done.js) are drawn apart. The bar at
// the bottom left picks a state and plays the motion.
(function () {
  "use strict";

  var T = window.Tracking;
  var root = document.documentElement;
  var STATE = root.dataset.state || "intake";
  var query = new URLSearchParams(location.search);
  if (query.get("bar") === "off") root.dataset.barOff = "";

  // Folded, Tracking shows this many rows: the ones that changed last.
  var PEEK_ROWS = 2;

  var DUR_1 = 120;
  var DUR_2 = 200;
  var DUR_3 = 320;
  var EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  var EASE_IN = "cubic-bezier(0.5, 0, 0.75, 0)";
  // A spring that overshoots a little and settles: the book's --ease-spring overshoots too far
  // for a sheet the height of the window.
  var SPRING = "cubic-bezier(0.3, 1.2, 0.5, 1)";

  /* ------------------------------------------------------------------ the scene */

  // What each ?state= shows: the view, whether Tracking is open, the open item, and the records.
  var SCENES = {
    intake: { view: "todo", open: "s-1302" },
    finished: { view: "todo", tracking: true, open: "t-1296" },
    "needs-you": { view: "todo", tracking: true, open: "t-sdk" },
    "needs-you-signal": { view: "todo", tracking: true, open: "t-212" },
    failed: { view: "todo", tracking: true, open: "t-backup" },
    working: { view: "todo", tracking: true, open: "t-sku" },
    stopped: { view: "todo", tracking: true, open: "t-pdf" },
    done: { view: "done", open: "d-205b" },
    empty: { view: "todo", open: null, tasks: [] },
    zero: { view: "todo", open: null, signals: [], tasks: ["t-checkout", "t-sku"] },
    load: { view: "todo", open: "s-1302", load: true },
    "load-tracking": { view: "todo", tracking: true, open: "t-backup", load: true },
  };
  var scene = SCENES[STATE] || SCENES.intake;

  var signals = (scene.signals || T.SIGNALS.map(byId)).map(findSignal);
  var tasks = (scene.tasks || T.TASKS.map(byId)).map(findTask);
  if (scene.load) addLoad();

  var view = scene.view;
  var tab = "all";
  var selected = scene.open;
  var paneOpen = !!selected;
  var trackingOpen = !!scene.tracking;
  var cleared = 7;

  function byId(r) {
    return r.id;
  }

  function findSignal(id) {
    return copy(
      T.SIGNALS.filter(function (s) {
        return s.id === id;
      })[0],
    );
  }

  function findTask(id) {
    return copy(
      T.TASKS.filter(function (t) {
        return t.id === id;
      })[0],
    );
  }

  function copy(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // Ten times the load: 60 signals on To do, and 18 Tasks in Tracking, 7 of them waiting on Rogier.
  function addLoad() {
    var titles = ["Bump the Node image to 24", "Flaky test in cart totals", "Translate the refund mail", "Cache the product feed", "Lint the email templates", "Drop the old coupon table", "Log slow Stripe calls", "Index orders by customer", "Retry the invoice export", "Pin the Playwright version", "Trim the session cookie"];
    var people = ["Sanne", "Marta", "Pieter", "Jonas", "Noor", "GitHub Actions"];
    var kinds = ["review requested", "mentioned", "checks failed", "assigned", "question for you"];
    for (var i = 0; signals.length < 60; i++) {
      var src = ["github", "linear", "slack", "github"][i % 4];
      signals.push({ id: "s-load-" + i, src: src, title: titles[i % titles.length] + (i >= titles.length ? " (" + (Math.floor(i / titles.length) + 1) + ")" : ""), sub: people[i % people.length] + " · " + kinds[i % kinds.length] + " · " + (src === "linear" ? "PAY-" + (150 + i) : src === "slack" ? "#payments" : "webshop #" + (1240 + i)), at: T.formatClock(T.NOW - (i * 7 + 3) * 60) });
    }
    var extra = [
      ["Ship the VAT report for Q3", "finished", "Implement", "09:02"],
      ["Rename the payouts table", "finished", "Implement", "08:51"],
      ["Spike: Klarna in checkout", "working", "Investigate", "09:31", "Reading Klarna's checkout docs"],
      ["Mobile menu covers the cart", "working", "Fix bug", "09:24", "Reproducing it at 375px"],
      ["Retry failed payouts", "working", "Implement", "09:11", "waiting for checks on #1314", true],
      ["Update the README for payments", "working", "Implement", "09:37", "Writing the setup section"],
      ["Explain the October refund spike", "working", "Investigate", "09:28", "Querying refunds by day"],
      ["Upgrade Redis to 7.4", "working", "Implement", "09:16", "waiting for checks on #1309", true],
      ["Clean up the feature flags", "stopped", "Implement", "08:12"],
      ["Wrong currency on Swiss invoices", "stopped", "Fix bug", "08:30"],
      ["Review: guest checkout", "finished", "Review PR", "09:39"],
    ];
    extra.forEach(function (e, i) {
      tasks.push({ id: "t-load-" + i, src: i % 3 ? "github" : "linear", title: e[0], state: e[1], wf: e[2], since: e[3], handedAt: e[3], narration: e[4] || "", checks: !!e[5], line: "", worker: tasks[0].worker, asked: tasks[0].asked, runs: [{ wf: e[2], state: e[1], start: e[3] }], did: ["…"] });
    });
  }

  /* ------------------------------------------------------------------ what the screen holds */

  function signalsOnTab() {
    return signals.filter(function (s) {
      return !s.gone && (tab === "all" || s.src === tab);
    });
  }

  // Tracking's order: the rows that wait on Rogier first (Needs you, Failed, Finished), then
  // Working, then Stopped; inside each state, the oldest handoff first. Tracking is To do's, not
  // a tab's: it shows the same rows on every tab.
  function sortedTasks() {
    return tasks.slice().sort(function (a, b) {
      return T.STATES[a.state].order - T.STATES[b.state].order || T.parseClock(a.handedAt) - T.parseClock(b.handedAt);
    });
  }

  /** Returns the rows folded Tracking shows: the ones that changed last, newest first. */
  function listRecent() {
    return tasks
      .slice()
      .sort(function (a, b) {
        return T.parseClock(b.since) - T.parseClock(a.since);
      })
      .slice(0, PEEK_ROWS);
  }

  function waits(t) {
    return T.STATES[t.state].waits;
  }

  function countWaiting() {
    return tasks.filter(waits).length;
  }

  // The To do count: every open signal, and every Tracking row that waits on Rogier. A plugin's
  // tab counts its own signals only.
  function countTodo(src) {
    var n = signals.filter(function (s) {
      return !s.gone && (!src || s.src === src);
    }).length;
    return src ? n : n + countWaiting();
  }

  function isTrackingOpen() {
    return view === "todo" && trackingOpen;
  }

  /** Returns the ids in the order J and K walk them: Tracking's rows while it is open, else the signals. */
  function listOrder() {
    if (view === "done") return T.DONE.map(byId);
    if (isTrackingOpen()) return sortedTasks().map(byId);
    var on = signalsOnTab();
    return on
      .filter(function (s) {
        return s.now;
      })
      .concat(
        on.filter(function (s) {
          return !s.now;
        }),
      )
      .map(byId);
  }

  function findItem(id) {
    return (
      tasks.filter(function (t) {
        return t.id === id;
      })[0] ||
      signals.filter(function (s) {
        return s.id === id;
      })[0] ||
      T.DONE.filter(function (d) {
        return d.id === id;
      })[0]
    );
  }

  function isTask(item) {
    return item && /^t-/.test(item.id);
  }

  function canMarkDone(t) {
    return t.state === "finished" || t.state === "failed" || t.state === "stopped";
  }

  /* ------------------------------------------------------------------ the bar and the head */

  function renderTabs() {
    var html = tabButton("all", "All", countTodo());
    ["sentry", "github", "linear", "slack"].forEach(function (src) {
      html += tabButton(src, T.sourceMark(src, 14) + T.SOURCES[src], countTodo(src));
    });
    document.querySelector("[data-tabs]").innerHTML = html;
  }

  function tabButton(key, label, count) {
    return '<button class="tab' + (tab === key ? " is-on" : "") + '" data-tab="' + key + '">' + label + (count ? " <small>" + count + "</small>" : "") + "</button>";
  }

  function renderHead() {
    var views = [
      ["todo", "To do", countTodo(tab === "all" ? null : tab)],
      ["later", "Later", 2],
      ["done", "Done", 0],
      ["everything", "Everything", 0],
    ];
    document.querySelector("[data-head]").innerHTML =
      '<div class="seg asks-modes" role="tablist">' +
      views
        .map(function (v) {
          return '<button role="tab" aria-selected="' + (view === v[0]) + '" data-view="' + v[0] + '">' + v[1] + (v[2] ? " <small>" + v[2] + "</small>" : "") + "</button>";
        })
        .join("") +
      "</div>";
  }

  function syncSidebar() {
    root.dataset.intakeCount = countTodo();
    var count = document.querySelector('aside .nav-row[href="intake.html"] .count');
    if (!count) return;
    count.textContent = countTodo();
    count.style.display = countTodo() ? "" : "none";
  }

  /* ------------------------------------------------------------------ the list */

  function buildList() {
    if (view === "done") return window.TrackingDone.buildList(selected);
    var on = signalsOnTab();
    var now = on.filter(function (s) {
      return s.now;
    });
    var rest = on.filter(function (s) {
      return !s.now;
    });
    var html = "";
    if (!on.length && !countWaiting()) return buildZero();
    if (now.length) html += '<h2 class="section-h asks-sec"><span class="dot dot--fail"></span>Now</h2><div class="asks-rows">' + now.map(signalRow).join("") + "</div>";
    if (rest.length) html += '<h2 class="section-h asks-sec">Signals <span class="count">' + rest.length + '</span></h2><div class="asks-rows">' + rest.map(signalRow).join("") + "</div>";
    if (!on.length) html += '<p class="asks-empty">No signals. What waits on you is in Tracking.</p>';
    html += '<p class="asks-cleared">' + cleared + ' cleared today. <a href="#" data-view-link="done">See Done</a>.</p>';
    return html;
  }

  // A signal row, as the app draws it. A signal about a Task in Tracking, such as the checks that
  // failed on the agent's PR, is led by that agent's face instead of the source's mark, and the
  // mark moves to the start of the second line, as Round Trip drew what came back.
  function signalRow(s) {
    var task = s.task && findItem(s.task);
    var lead = task ? T.face(task.wf, "done", 24) : T.sourceMark(s.src, 16);
    var sub = (task ? '<span class="rt-src">' + T.sourceMark(s.src, 12) + "</span>" : "") + (s.back ? '<span class="ask-back">' + T.icon("alarm", 12) + "Back</span> · " : "") + s.sub;
    return (
      '<div class="ask-item' + (s.id === selected ? " is-on" : "") + '" data-key="' + s.id + '">' +
      '<button class="ask-row" data-id="' + s.id + '">' +
      '<span class="ask-mark' + (task ? " rt-lead" : "") + '">' + lead + "</span>" +
      '<span class="ask-text"><span class="ask-title">' + s.title + '</span><span class="ask-sub">' + sub + "</span></span>" +
      '<span class="ask-end"><time class="ask-age">' + T.formatAge(s.at) + "</time></span>" +
      "</button>" +
      '<span class="ask-acts"><button class="ask-act" title="Snooze" data-toast="Snooze is as To do has it today">' + T.icon("alarm", 16) + "</button>" +
      '<button class="ask-act" title="Done · Takes it off your list. ' + T.SOURCES[s.src] + ' is not told" data-signal-done="' + s.id + '">' + T.icon("check", 16) + "</button></span>" +
      "</div>"
    );
  }

  // Inbox zero, as the app draws it, with 24 brass rays. Tracking stays at its foot while work is
  // still out: its rows do not wait on Rogier, so the list is at zero.
  function buildZero() {
    var rays = "";
    for (var i = 0; i < 24; i++) {
      var a = (i / 24) * Math.PI * 2 - Math.PI / 2;
      var outer = i % 2 === 0 ? 100 : 84;
      rays += '<path d="M' + (Math.cos(a) * 64).toFixed(1) + " " + (Math.sin(a) * 64).toFixed(1) + "L" + (Math.cos(a) * outer).toFixed(1) + " " + (Math.sin(a) * outer).toFixed(1) + '"/>';
    }
    return (
      '<div class="asks-zero">' +
      '<div class="asks-zero-art"><svg class="asks-zero-sun" viewBox="-108 -108 216 216" aria-hidden="true">' + rays + "</svg>" +
      '<span class="asks-zero-face"><i data-face="Hercule" data-pose="done" data-size="88"></i></span></div>' +
      '<h2 class="asks-zero-h">Inbox zero</h2>' +
      '<p class="asks-zero-line">The rest of the morning is yours.</p>' +
      '<p class="asks-zero-n"><span class="asks-zero-num">' + cleared + "</span>cleared today</p>" +
      '<div class="asks-zero-tally"><button>' + T.sourceMark("github", 14) + "4</button><button>" + T.sourceMark("linear", 14) + "2</button><button>" + T.sourceMark("slack", 14) + "1</button></div>" +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ Tracking */

  function renderTracking() {
    var el = document.querySelector("[data-tray]");
    var list = document.querySelector("[data-list]");
    el.hidden = view !== "todo";
    el.classList.toggle("is-open", isTrackingOpen());
    if (view !== "todo") return;
    var keep = el.querySelector(".tr-scroll");
    var scrollTop = keep ? keep.scrollTop : 0;
    el.innerHTML = isTrackingOpen() ? buildOpened() : buildFolded();
    window.Crew.drawPlaceholders(el);
    var scroll = el.querySelector(".tr-scroll");
    if (scroll) scroll.scrollTop = scrollTop;
    // The list keeps room under its last row for folded Tracking, whatever its height.
    if (!isTrackingOpen()) list.style.paddingBottom = el.offsetHeight + 12 + "px";
  }

  function waitingHtml() {
    var waiting = countWaiting();
    return waiting ? '<span class="tr-wait you-ink">' + window.Crew.mark("waiting", 12) + waiting + " wait" + (waiting === 1 ? "s" : "") + " on you</span>" : "";
  }

  // Folded: the head, which opens Tracking, over the two rows that changed last.
  function buildFolded() {
    var head =
      '<h2 class="tr-bar"><button class="tr-bar-btn" data-tracking-toggle title="Show all of Tracking (T)">' +
      '<span class="tr-label"><span>Tracking</span>' + (tasks.length ? '<b class="count">' + tasks.length + "</b>" : "") + "</span>" +
      waitingHtml() +
      (tasks.length ? '<span class="tr-all">Show all<span class="tr-chev tr-chev--up">' + T.icon("chev-d", 12) + "</span></span>" : "") +
      "</button></h2>";
    if (!tasks.length) return head + '<p class="tr-empty">Hand a signal to an agent, and follow it here until you mark it done.</p>';
    return head + '<div class="rt-runs">' + listRecent().map(trackedRow).join("") + "</div>";
  }

  // Opened: Tracking over the whole column. Its head, with the way back; its rows grouped by
  // state, each under the state's mark; and at its foot the row that sums up the signals.
  function buildOpened() {
    var all = sortedTasks();
    var groups = ["needs", "failed", "finished", "working", "stopped"]
      .map(function (state) {
        var rows = all.filter(function (t) {
          return t.state === state;
        });
        if (!rows.length) return "";
        return (
          '<h3 class="section-h asks-sec tr-sec">' + window.Crew.mark(T.STATES[state].mark, 14) + T.STATES[state].word + ' <span class="count">' + rows.length + "</span></h3>" +
          '<div class="rt-runs">' + rows.map(trackedRow).join("") + "</div>"
        );
      })
      .join("");
    var marks = [];
    signalsOnTab().forEach(function (s) {
      if (marks.indexOf(s.src) < 0) marks.push(s.src);
    });
    return (
      '<header class="tr-head"><button class="btn btn--quiet btn--sm tr-back" data-tracking-toggle title="Back to Intake (T)">' + T.icon("chev-l", 14) + "Intake</button>" +
      '<h2 class="tr-title">Tracking <span class="count">' + tasks.length + "</span></h2>" +
      waitingHtml() +
      "</header>" +
      '<div class="tr-scroll">' + (groups || '<p class="tr-empty">Hand a signal to an agent, and follow it here until you mark it done.</p>') + "</div>" +
      '<h2 class="tr-bar tr-bar--back"><button class="tr-bar-btn" data-tracking-toggle title="Back to the signals (T)">' +
      '<span class="tr-label"><span>Signals</span><b class="count">' + signalsOnTab().length + "</b></span>" +
      '<span class="tr-marks">' +
      marks
        .map(function (src) {
          return T.sourceMark(src, 14);
        })
        .join("") +
      "</span>" +
      '<span class="tr-all">Back to Intake<span class="tr-chev">' + T.icon("chev-d", 12) + "</span></span></button></h2>"
    );
  }

  /** Returns the second line of a Tracking row: what waits, what went wrong, or what the agent is doing. */
  function describeTaskRow(t) {
    if (t.state === "needs") return t.question ? t.question.text : t.waitsOn.text;
    if (t.state === "failed") return T.who(t.wf) + " failed · " + t.line;
    if (t.state === "finished") return T.who(t.wf) + ' <span class="rt-finished">finished</span>';
    if (t.state === "stopped") return T.who(t.wf) + " · stopped by you";
    return T.who(t.wf) + " · " + (t.narration || "starting");
  }

  // A Tracking row: the agent's face in its pose, the Task's title, and one line. Needs you and
  // Failed are marigold and Finished is green: all three wait on Rogier. A Request is answered
  // where it stands, in three fixed slots. Mark done shows on hover only where the work has
  // stopped, since on Working and Needs you it would leave a run going. The row keeps the key of
  // the signal it was handed off from, so a handoff can fly from one to the other.
  function trackedRow(t) {
    var key = t.key || t.id;
    return (
      '<div class="rt-run-item' + (waits(t) && t.state !== "finished" ? " is-you" : "") + (t.state === "finished" ? " is-finished" : "") + (t.id === selected ? " is-on" : "") + '" data-key="' + key + '" data-state="' + t.state + '">' +
      '<button class="rt-run" data-id="' + t.id + '">' +
      T.face(t.wf, T.STATES[t.state].pose, 22) +
      '<span class="rt-run-text"><span class="rt-run-title">' + t.title + "</span>" +
      '<span class="rt-run-sub" data-narration>' + describeTaskRow(t) + "</span></span>" +
      '<span class="rt-run-end" title="' + T.STATES[t.state].word + " since " + t.since + '">' + T.formatAge(t.since) + "</span></button>" +
      (t.state === "needs" && t.question
        ? '<div class="rt-run-ans">' +
          t.question.answers
            .map(function (a, i) {
              return questionButton(t, a, i);
            })
            .join("") +
          "</div>"
        : "") +
      (canMarkDone(t) ? '<span class="ask-acts rt-acts"><button class="ask-act" title="Mark done · Takes it off Tracking. Nothing is sent" data-task-done="' + t.id + '">' + T.icon("check", 16) + "</button></span>" : "") +
      "</div>"
    );
  }

  function questionButton(t, a, i) {
    var cls = "btn btn--sm" + (a[2] ? " btn--accent" : "") + (i === 2 ? " btn--quiet" : "");
    return '<button class="' + cls + '" style="grid-column:' + (i + 1) + '" data-question="' + t.id + '" data-q="' + i + '" title="' + a[1].replace(/<[^>]+>/g, "") + '">' + a[0] + "</button>";
  }

  /* ------------------------------------------------------------------ the pane */

  function renderPane() {
    var split = document.querySelector("[data-split]");
    var pane = document.querySelector("[data-detail]");
    var item = selected && paneOpen ? findItem(selected) : null;
    split.classList.toggle("is-wide", !item);
    document.querySelector("[data-pane-toggle]").setAttribute("aria-pressed", String(!!item));
    if (!item) {
      pane.innerHTML = "";
      return;
    }
    if (view === "done") pane.innerHTML = window.TrackingDone.buildPane(item) + window.TrackingDone.keys(item);
    else if (isTask(item)) pane.innerHTML = window.TrackingPane.build(item) + window.TrackingPane.keys(item);
    else pane.innerHTML = window.TrackingPane.buildSignal(item) + window.TrackingPane.signalKeys(item);
    window.Crew.drawPlaceholders(pane);
  }

  /* ------------------------------------------------------------------ render, with motion */

  function motionAllowed() {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Records where every row of the list and of Tracking is now, so the next render can move them from there. */
  function snapshot() {
    var map = {};
    document.querySelectorAll("[data-list] [data-key], [data-tray] [data-key]").forEach(function (el) {
      map[el.dataset.key] = {
        rect: el.getBoundingClientRect(),
        tray: !!el.closest("[data-tray]"),
        clone: el.cloneNode(true),
        narration: (el.querySelector("[data-narration]") || {}).innerHTML,
      };
    });
    return map;
  }

  /**
   * Moves each row from where it was to where it is now, on transform and opacity only:
   *   - a row that left fades out where it was, over --dur-1, and the rows below close up after it;
   *   - a signal handed off flies from the list into Tracking as a lifted copy, over --dur-3;
   *   - a row that is new fades in and drops 6px into place, over --dur-2;
   *   - a row whose line changed fades the new line in, over --dur-2.
   */
  function animateFrom(before) {
    if (!before || !motionAllowed()) return;
    var fly = document.querySelector("[data-fly]");
    var box = fly.getBoundingClientRect();
    var after = {};
    document.querySelectorAll("[data-list] [data-key], [data-tray] [data-key]").forEach(function (el) {
      after[el.dataset.key] = el;
    });
    var leaving = Object.keys(before).filter(function (k) {
      return !after[k];
    });
    leaving.forEach(function (k) {
      var b = before[k];
      var ghost = placeGhost(fly, box, b.clone, b.rect);
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR_1, easing: "linear", fill: "forwards" }).onfinish = function () {
        ghost.remove();
      };
    });
    var delay = leaving.length ? DUR_1 : 0;
    Object.keys(after).forEach(function (k) {
      var el = after[k];
      var b = before[k];
      var a = el.getBoundingClientRect();
      var inTray = !!el.closest("[data-tray]");
      if (!b) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: DUR_2, easing: EASE, delay: delay, fill: "backwards" },
        );
        return;
      }
      if (b.tray !== inTray) {
        var ghost = placeGhost(fly, box, el.cloneNode(true), b.rect, a.width);
        ghost.classList.add("rt-ghost--lift");
        el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: DUR_3 });
        ghost.animate([{ transform: "none" }, { transform: "translate(" + (a.left - b.rect.left) + "px," + (a.top - b.rect.top) + "px)" }], {
          duration: DUR_3,
          easing: EASE,
          fill: "both",
        }).onfinish = function () {
          ghost.remove();
        };
        return;
      }
      var dy = b.rect.top - a.top;
      if (Math.abs(dy) > 0.5) el.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: DUR_3, easing: EASE, delay: delay, fill: "backwards" });
      var nar = el.querySelector("[data-narration]");
      if (nar && b.narration !== undefined && b.narration !== nar.innerHTML) nar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR_2, easing: "linear" });
    });
  }

  function placeGhost(fly, box, node, rect, width) {
    node.classList.add("rt-ghost");
    node.removeAttribute("data-key");
    node.style.left = rect.left - box.left + "px";
    node.style.top = rect.top - box.top + "px";
    node.style.width = (width || rect.width) + "px";
    fly.appendChild(node);
    return node;
  }

  /** Draws the whole screen again; unless told to stay still, every row moves from where it was. */
  function render(still) {
    var before = still ? null : snapshot();
    syncSidebar();
    renderTabs();
    renderHead();
    var list = document.querySelector("[data-list]");
    list.innerHTML = buildList() + toastHtml();
    window.Crew.drawPlaceholders(list);
    renderTracking();
    renderPane();
    animateFrom(before);
  }

  /* ------------------------------------------------------------------ opening and closing Tracking */

  // Opening: the sheet springs up from where folded Tracking stood, in 240ms, and its rows
  // cascade in, 16ms apart. Closing: it drops back, in 180ms. With Reduce motion it only swaps.
  var moving = false;

  function toggleTracking() {
    if (moving || view !== "todo") return;
    var el = document.querySelector("[data-tray]");
    var column = document.querySelector(".asks-list").getBoundingClientRect();
    var folded = el.getBoundingClientRect();
    if (!trackingOpen) {
      trackingOpen = true;
      if (selected && !isTask(findItem(selected))) selected = null;
      render(true);
      if (!motionAllowed()) return;
      el.animate([{ transform: "translateY(" + (folded.top - column.top) + "px)" }, { transform: "none" }], { duration: 240, easing: SPRING });
      Array.prototype.filter
        .call(el.querySelectorAll(".tr-head, .tr-sec, .rt-run-item"), function (part) {
          return part.getBoundingClientRect().top < column.bottom;
        })
        .forEach(function (part, i) {
          part.animate(
            [
              { opacity: 0, transform: "translateY(12px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: DUR_2, easing: EASE, delay: 60 + Math.min(i, 12) * 16, fill: "backwards" },
          );
        });
      return;
    }
    if (!motionAllowed()) return closeTracking();
    moving = true;
    el.animate([{ transform: "none" }, { transform: "translateY(" + (column.height - 140) + "px)" }], { duration: 180, easing: EASE_IN, fill: "forwards" }).onfinish = function () {
      closeTracking();
      el.getAnimations().forEach(function (a) {
        a.cancel();
      });
    };
  }

  // Back in Intake, a tracked row stays open in the pane only if it is one folded Tracking shows.
  function closeTracking() {
    moving = false;
    trackingOpen = false;
    var shown = listRecent().map(byId);
    if (isTask(findItem(selected)) && shown.indexOf(selected) < 0) {
      selected = null;
      paneOpen = false;
    }
    render(true);
  }

  /* ------------------------------------------------------------------ what changes */

  // Changes Rogier did not make wait while the pointer is over the list column, so nothing moves
  // under it.
  var pointerOnList = false;
  var held = [];

  function whenListIsFree(fn) {
    if (pointerOnList) held.push(fn);
    else fn();
  }

  function nextAfter(id) {
    var order = listOrder();
    var i = order.indexOf(id);
    return order[i + 1] || order[i - 1] || null;
  }

  /** Marks a Task done (or cancelled): its row fades, then the rows below close the gap. */
  function tickOff(id, how) {
    var t = findItem(id);
    var next = nextAfter(id);
    tasks = tasks.filter(function (x) {
      return x.id !== id;
    });
    cleared++;
    if (selected === id) selected = isTrackingOpen() ? next : null;
    if (!selected) paneOpen = false;
    showToast((how === "cancelled" ? "Cancelled: " : "Marked done: ") + t.title);
    render();
  }

  function markSignalDone(id) {
    var s = findItem(id);
    var next = nextAfter(id);
    s.gone = true;
    cleared++;
    if (selected === id) selected = next;
    showToast("Done: " + s.title);
    render();
  }

  /** Moves a Task to another state in place: its line fades in anew, and it slides when its place changes. */
  function changeState(id, state, patch) {
    var t = findItem(id);
    t.state = state;
    t.since = T.formatClock(T.NOW);
    Object.keys(patch || {}).forEach(function (k) {
      t[k] = patch[k];
    });
    render();
  }

  // Hand to Fix bug on the trailing-space signal: the signal lifts out of Signals and flies into
  // folded Tracking, where it lands as the newest row, Working.
  function handOff(signalId) {
    var s = findItem(signalId);
    if (!s || s.gone) return flashToast("Reset the drawing to play this again");
    s.gone = true;
    var at = T.formatClock(T.NOW);
    tasks.push({
      id: "t-" + signalId,
      key: signalId,
      src: s.src,
      title: s.title,
      state: "working",
      since: at,
      handedAt: at,
      wf: "Fix bug",
      line: "",
      narration: "Reading Pieter's thread",
      worker: "Claude Code · Opus 5.5 · studio-mac",
      asked: { src: s.src, who: "Pieter", kind: "Tagged in a thread", where: "#acceptance", at: s.at, text: "Codes with a trailing space are rejected at checkout. Trim them before the lookup?" },
      runs: [{ wf: "Fix bug", state: "working", start: at }],
      did: ["Reading Pieter's thread."],
    });
    if (selected === signalId) selected = "t-" + signalId;
    showToast("Handed to Fix bug: " + s.title);
    render();
  }

  /* ------------------------------------------------------------------ the toast */

  var toast = null;
  var toastTimer = 0;

  function showToast(text) {
    toast = { text: text, fresh: true };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast = null;
      var el = document.querySelector("[data-list] .asks-toast");
      if (el) el.remove();
    }, 5000);
  }

  function toastHtml() {
    if (!toast) return "";
    var html = '<div class="asks-toast' + (toast.fresh ? " is-new" : "") + '" role="status">' + window.Crew.mark("done", 14) + '<span class="asks-toast-text">' + toast.text + "</span></div>";
    toast.fresh = false;
    return html;
  }

  /** Shows a toast without moving anything, for a link that would leave the drawing. */
  function flashToast(text) {
    showToast(text);
    var list = document.querySelector("[data-list]");
    var old = list.querySelector(".asks-toast");
    if (old) old.remove();
    list.insertAdjacentHTML("beforeend", toastHtml());
  }

  /* ------------------------------------------------------------------ selection and keys */

  function rowOf(id) {
    return document.querySelector('[data-list] [data-id="' + id + '"], [data-tray] [data-id="' + id + '"]');
  }

  function select(id, focusAnswer) {
    selected = id;
    paneOpen = !!id;
    render(true);
    var row = id && rowOf(id);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      if (!focusAnswer) row.focus({ preventScroll: true });
    }
    if (focusAnswer) focusSuggested();
  }

  function focusSuggested() {
    var btn = document.querySelector("[data-detail] .btn--accent");
    if (btn) {
      btn.focus();
      btn.scrollIntoView({ block: "nearest" });
    }
  }

  function move(by) {
    var order = listOrder();
    var i = order.indexOf(selected);
    var next = order[i < 0 ? (by > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + by))];
    if (next) select(next);
  }

  function inField(e) {
    var t = e.target;
    return t.closest && t.closest("input, textarea, select, [contenteditable]");
  }

  document.addEventListener("keydown", function (e) {
    if (inField(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === "j" || k === "J" || k === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (k === "k" || k === "K" || k === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (k === "t" || k === "T") {
      e.preventDefault();
      toggleTracking();
    } else if (k === "Enter") {
      if (e.target.closest && e.target.closest("[data-detail] button, [data-detail] a, [data-tray] .rt-run-ans button")) return;
      if (!selected) return;
      e.preventDefault();
      select(selected, true);
    } else if (k === "e" || k === "E") {
      var item = findItem(selected);
      if (view !== "todo" || !item) return;
      if (isTask(item) && canMarkDone(item)) tickOff(item.id, "done");
      else if (!isTask(item)) markSignalDone(item.id);
    } else if (k === "o" || k === "O") {
      var it = findItem(selected);
      if (isTask(it)) flashToast("Opens the run of " + it.wf + " in Workflows");
    } else if (k === "Escape") {
      // Esc steps back: the pane, then the selection, then Tracking.
      if (paneOpen) {
        paneOpen = false;
        render(true);
        var row = rowOf(selected);
        if (row) row.focus({ preventScroll: true });
      } else if (selected) {
        selected = null;
        render(true);
      } else if (isTrackingOpen()) toggleTracking();
    }
  });

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-id], [data-tab], [data-view], [data-view-link], [data-task-done], [data-signal-done], [data-answer], [data-question], [data-select], [data-toast], [data-tracking-toggle], [data-pane-toggle], [data-play]");
    if (!el) return;
    var d = el.dataset;
    if (d.toast !== undefined && !d.answer) {
      e.preventDefault();
      flashToast(d.toast);
    } else if (d.trackingToggle !== undefined) toggleTracking();
    else if (d.taskDone) tickOff(d.taskDone, "done");
    else if (d.signalDone) markSignalDone(d.signalDone);
    else if (d.question) answerQuestion(d.question, Number(d.q));
    else if (d.id) select(d.id);
    else if (d.tab) {
      tab = d.tab;
      if (selected && listOrder().indexOf(selected) < 0) selected = null;
      render(true);
    } else if (d.view || d.viewLink) {
      e.preventDefault();
      var v = d.view || d.viewLink;
      if (v === "later" || v === "everything") return flashToast("Later and Everything are as Intake has them today");
      view = v;
      trackingOpen = false;
      selected = v === "done" ? "d-205b" : null;
      paneOpen = !!selected;
      render(true);
    } else if (d.select) {
      e.preventDefault();
      view = "todo";
      tab = "all";
      trackingOpen = isTask(findItem(d.select));
      select(d.select);
    } else if (d.answer) answer(d.answer, el);
    else if (d.paneToggle !== undefined) {
      paneOpen = !paneOpen && !!selected;
      render(true);
    } else if (d.play) play(d.play);
  });

  /** Does what a pane answer does, on the open Task. */
  function answer(kind, el) {
    var t = findItem(selected);
    if (!isTask(t)) return flashToast(el.textContent.trim() + " is as Intake has it today");
    if (kind === "done") tickOff(t.id, "done");
    else if (kind === "cancel") tickOff(t.id, "cancelled");
    else if (kind === "again") {
      t.runs.push({ wf: t.wf, state: "working", start: T.formatClock(T.NOW), again: true });
      showToast("Tried again: " + t.wf + " runs " + t.title + " from the start");
      changeState(t.id, "working", { narration: "Starting again from the top", checks: false });
    } else if (kind === "stop") {
      t.runs[t.runs.length - 1].state = "stopped";
      t.runs[t.runs.length - 1].end = T.formatClock(T.NOW);
      changeState(t.id, "stopped");
    } else if (kind === "open") flashToast("Opens the run of " + t.wf + " in Workflows");
  }

  // Answering a Request where it stands: Allow once and Always allow let the run go on, so the
  // row turns Working; Deny tells the agent no, and it goes on without the push.
  function answerQuestion(id, i) {
    var t = findItem(id);
    var a = t.question.answers[i];
    showToast(a[0] + ": " + t.question.text.replace(/<[^>]+>/g, ""));
    changeState(id, "working", { narration: i === 2 ? "Going on without the push" : "Pushing chore/stripe-sdk-14", question: null });
  }

  /* ------------------------------------------------------------------ the drawing's bar */

  var STATE_NAMES = [
    ["intake", "Intake, Tracking folded"],
    ["finished", "Tracking: Finished"],
    ["needs-you", "Tracking: Needs you, a Request"],
    ["needs-you-signal", "Tracking: Needs you, a signal"],
    ["failed", "Tracking: Failed"],
    ["working", "Tracking: Working"],
    ["stopped", "Tracking: Stopped"],
    ["done", "Done: each handoff's leg"],
    ["empty", "Empty: nothing handed off"],
    ["zero", "Inbox zero, work still out"],
    ["load", "Ten times the load"],
    ["load-tracking", "Ten times the load, Tracking"],
  ];

  function renderProto() {
    var theme = query.get("theme");
    document.querySelector("[data-proto]").innerHTML =
      '<span class="tr-proto-tag">Drawing</span>' +
      '<select class="tr-proto-pick" data-state-pick aria-label="State">' +
      STATE_NAMES.map(function (s) {
        return '<option value="' + s[0] + '"' + (s[0] === STATE ? " selected" : "") + ">" + s[1] + "</option>";
      }).join("") +
      "</select>" +
      '<span class="tr-proto-sep"></span>' +
      '<button class="tr-proto-btn" data-play="finish" title="Fix bug finishes Lowercase SKUs. It waits while the pointer is on the list">Finish</button>' +
      '<button class="tr-proto-btn" data-play="handoff" title="Hand the trailing-space signal to Fix bug">Hand off</button>' +
      '<button class="tr-proto-btn" data-play="tickoff" title="Mark Rate-limit the public API done">Mark done</button>' +
      '<button class="tr-proto-btn" data-play="theme" title="Light or dark">' + (theme === "orient-express" ? "Light" : "Dark") + "</button>";
    document.querySelector("[data-state-pick]").addEventListener("change", function (e) {
      var q = new URLSearchParams(location.search);
      q.set("state", e.target.value);
      location.search = q.toString();
    });
  }

  function play(what) {
    if (what === "theme") {
      var q = new URLSearchParams(location.search);
      if (q.get("theme") === "orient-express") q.delete("theme");
      else q.set("theme", "orient-express");
      location.search = q.toString();
      return;
    }
    if (view !== "todo") {
      view = "todo";
      render(true);
    }
    if (what === "finish") {
      var sku = findItem("t-sku");
      if (!sku || sku.state !== "working") return flashToast("Reset the drawing to play this again");
      whenListIsFree(function () {
        sku.runs[sku.runs.length - 1].state = "finished";
        sku.runs[sku.runs.length - 1].end = T.formatClock(T.NOW);
        changeState("t-sku", "finished");
      });
    } else if (what === "handoff") {
      if (isTrackingOpen()) closeTracking();
      handOff("s-trail");
    } else if (what === "tickoff") {
      if (!findItem("t-1296")) return flashToast("Reset the drawing to play this again");
      tickOff("t-1296", "done");
    }
  }

  /* ------------------------------------------------------------------ start */

  function start() {
    var column = document.querySelector(".asks-list");
    column.addEventListener("pointerenter", function () {
      pointerOnList = true;
    });
    column.addEventListener("pointerleave", function () {
      pointerOnList = false;
      var due = held;
      held = [];
      due.forEach(function (fn) {
        fn();
      });
    });
    renderProto();
    render(true);
    var row = selected && rowOf(selected);
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  root.dataset.intakeCount = countTodo();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
