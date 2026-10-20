// DRAWING - Tracking: the list, the tabs, the keys and the motion of the drawing.
//
// To do lists Now and Signals as the app draws them today, then Tracking: one row per Task Rogier
// handed off, in one of five states. Finished, Failed and Needs you wait on him, so they are drawn
// in marigold and count toward To do; Working and Stopped do not. Tracking shows on the All tab
// only. The pane (tracking-pane.js) and the Done view (tracking-done.js) are drawn apart.
//
// The bar at the bottom right picks a state and plays the motion: a run that finishes, a handoff
// that arrives, a row marked done.
(function () {
  "use strict";

  var T = window.Tracking;
  var root = document.documentElement;
  var STATE = root.dataset.state || "finished";
  if (new URLSearchParams(location.search).get("bar") === "off") root.dataset.barOff = "";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ------------------------------------------------------------------ the scene */

  // What each ?state= shows: the view, the open item, and which records are on screen.
  var SCENES = {
    finished: { view: "todo", open: "t-1296" },
    "needs-you": { view: "todo", open: "t-sdk" },
    "needs-you-signal": { view: "todo", open: "t-212" },
    failed: { view: "todo", open: "t-backup" },
    working: { view: "todo", open: "t-sku" },
    stopped: { view: "todo", open: "t-pdf" },
    done: { view: "done", open: "d-205b" },
    empty: { view: "todo", open: null, tasks: [] },
    zero: { view: "todo", open: null, signals: [], tasks: ["t-checkout", "t-sku"] },
    load: { view: "todo", open: "t-backup", load: true },
  };
  var scene = SCENES[STATE] || SCENES.finished;

  var signals = (scene.signals || T.SIGNALS.map(byId)).map(findSignal);
  var tasks = (scene.tasks || T.TASKS.map(byId)).map(findTask);
  if (scene.load) addLoad();

  var view = scene.view;
  var tab = "all";
  var selected = scene.open;
  var paneOpen = !!selected;
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

  // Ten times the load: 60 signals on To do, and 18 Tasks in Tracking, 6 of them waiting on Rogier.
  function addLoad() {
    var titles = ["Bump the Node image to 24", "Flaky test in cart totals", "Translate the refund mail", "Cache the product feed", "Lint the email templates", "Drop the old coupon table", "Log slow Stripe calls", "Index orders by customer", "Retry the invoice export", "Pin the Playwright version", "Trim the session cookie"];
    var who = ["Sanne", "Marta", "Pieter", "Jonas", "Noor", "GitHub Actions"];
    var kinds = ["review requested", "mentioned", "checks failed", "assigned", "question for you"];
    for (var i = 0; signals.length < 60; i++) {
      var src = ["github", "linear", "slack", "github"][i % 4];
      signals.push({ id: "s-load-" + i, src: src, title: titles[i % titles.length] + (i >= titles.length ? " (" + (Math.floor(i / titles.length) + 1) + ")" : ""), sub: who[i % who.length] + " · " + kinds[i % kinds.length] + " · " + (src === "linear" ? "PAY-" + (150 + i) : src === "slack" ? "#payments" : "webshop #" + (1240 + i)), at: T.formatClock(T.NOW - (i * 7 + 3) * 60) });
    }
    var extra = [
      ["Ship the VAT report for Q3", "finished", "Implement", "", "09:02"],
      ["Rename the payouts table", "finished", "Implement", "", "08:51"],
      ["Spike: Klarna in checkout", "working", "Investigate", "", "09:31"],
      ["Mobile menu covers the cart", "working", "Fix bug", "", "09:24"],
      ["Retry failed payouts", "working", "Implement", "", "09:11", true],
      ["Update the README for payments", "working", "Implement", "", "09:37"],
      ["Explain the October refund spike", "working", "Investigate", "", "09:28"],
      ["Upgrade Redis to 7.4", "working", "Implement", "", "09:16", true],
      ["Clean up the feature flags", "stopped", "Implement", "", "08:12"],
      ["Wrong currency on Swiss invoices", "stopped", "Fix bug", "", "08:30"],
      ["Review: guest checkout", "finished", "Review PR", "", "09:39"],
    ];
    extra.forEach(function (e, i) {
      tasks.push({ id: "t-load-" + i, src: i % 3 ? "github" : "linear", title: e[0], state: e[1], wf: e[2], line: e[3], since: e[4], checks: !!e[5], handedAt: e[4], asked: tasks[0].asked, runs: [{ wf: e[2], state: e[1], start: e[4] }], did: ["…"] });
    });
  }

  /* ------------------------------------------------------------------ what the list holds */

  function isOpenSignal(s) {
    return !s.gone;
  }

  function signalsOnTab() {
    return signals.filter(function (s) {
      return isOpenSignal(s) && (tab === "all" || s.src === tab);
    });
  }

  // Tracking's sort: the rows that wait on Rogier first (Needs you, Failed, Finished), then
  // Working, then Stopped; inside each state, the oldest handoff first.
  function sortTasks(list) {
    return list.slice().sort(function (a, b) {
      return T.STATES[a.state].order - T.STATES[b.state].order || T.parseClock(a.handedAt) - T.parseClock(b.handedAt);
    });
  }

  function tasksOnTab() {
    return tab === "all" ? sortTasks(tasks) : [];
  }

  function countWaiting() {
    return tasks.filter(function (t) {
      return T.STATES[t.state].waits;
    }).length;
  }

  // The To do count: every open signal, and every Tracking row that waits on Rogier. A plugin's
  // tab counts its own signals only, because Tracking shows on All alone.
  function countTodo(src) {
    var n = signals.filter(function (s) {
      return isOpenSignal(s) && (!src || s.src === src);
    }).length;
    return src ? n : n + countWaiting();
  }

  /** Returns the ids in the list's order, which J and K walk: Now, Signals, then Tracking. */
  function listOrder() {
    if (view === "done") return T.DONE.map(byId);
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
      .concat(tasksOnTab())
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
    var tracked = tasksOnTab();
    var html = "";
    if (!on.length && !countWaiting()) html += buildZero();
    if (now.length) html += '<h2 class="section-h asks-sec"><span class="dot dot--fail"></span>Now</h2><div class="asks-rows">' + now.map(signalRow).join("") + "</div>";
    if (rest.length) html += '<h2 class="section-h asks-sec">Signals <span class="count">' + rest.length + '</span></h2><div class="asks-rows">' + rest.map(signalRow).join("") + "</div>";
    if (tracked.length) html += buildTracking(tracked);
    if (on.length || countWaiting()) html += '<p class="asks-cleared">' + cleared + ' cleared today. <a href="#" data-view-link="done">See Done</a>.</p>';
    return html;
  }

  // The section's head: its name, how many rows it holds, and how many of them wait on Rogier,
  // which is what it adds to the To do count.
  function buildTracking(tracked) {
    var waiting = tracked.filter(function (t) {
      return T.STATES[t.state].waits;
    }).length;
    return (
      '<h2 class="section-h asks-sec tr-head" data-tracking>Tracking <span class="count">' + tracked.length + "</span>" +
      (waiting ? '<span class="asks-sec-right tr-head-waiting">' + waiting + " wait" + (waiting === 1 ? "s" : "") + " on you</span>" : "") +
      "</h2>" +
      '<div class="asks-rows tr-rows">' + tracked.map(taskRow).join("") + "</div>"
    );
  }

  function signalRow(s) {
    var sub = (s.back ? '<span class="ask-back">' + T.icon("alarm", 12) + "Back</span> · " : "") + s.sub;
    return (
      '<div class="ask-item' + (s.id === selected ? " is-on" : "") + '" data-key="' + s.id + '">' +
      '<button class="ask-row" data-id="' + s.id + '">' +
      '<span class="ask-mark">' + T.sourceMark(s.src, 16) + "</span>" +
      '<span class="ask-text"><span class="ask-title">' + s.title + '</span><span class="ask-sub">' + sub + "</span></span>" +
      '<span class="ask-end"><time class="ask-age">' + T.formatAge(s.at) + "</time></span>" +
      "</button>" +
      '<span class="ask-acts"><button class="ask-act" title="Snooze" data-toast="Snooze is as To do has it today">' + T.icon("alarm", 16) + "</button>" +
      '<button class="ask-act" title="Done · Takes it off your list. ' + T.SOURCES[s.src] + ' is not told" data-signal-done="' + s.id + '">' + T.icon("check", 16) + "</button></span>" +
      "</div>"
    );
  }

  /** Returns the second line of a Tracking row: the state's word, the workflow, and what there is to add. */
  function describeTaskRow(t) {
    var word = t.state === "working" && t.checks ? "Waiting for checks" : T.STATES[t.state].word;
    return '<span class="tr-row-state">' + word + "</span> · " + t.wf + (t.line ? " · " + t.line : "");
  }

  // A Tracking row reads as a signal row does: the mark of the source the work came from, the
  // Task's title, then its state. The time is how long it has been in that state. Mark done sits
  // on the row only where the work has stopped: on Working and Needs you it would cut a run short.
  function taskRow(t) {
    var waits = T.STATES[t.state].waits;
    return (
      '<div class="ask-item tr-item' + (waits ? " is-waiting" : "") + (t.id === selected ? " is-on" : "") + '" data-key="' + t.id + '" data-state="' + t.state + '">' +
      '<button class="ask-row" data-id="' + t.id + '">' +
      '<span class="ask-mark">' + T.sourceMark(t.src, 16) + "</span>" +
      '<span class="ask-text"><span class="ask-title">' + t.title + '</span><span class="ask-sub">' + describeTaskRow(t) + "</span></span>" +
      '<span class="ask-end"><time class="ask-age" title="' + T.STATES[t.state].word + " since " + t.since + '">' + T.formatAge(t.since) + "</time></span>" +
      "</button>" +
      (canMarkDone(t) ? '<span class="ask-acts"><button class="ask-act" title="Mark done · Takes it off Tracking. Nothing is sent" data-task-done="' + t.id + '">' + T.icon("check", 16) + "</button></span>" : "") +
      "</div>"
    );
  }

  // Inbox zero, as the app draws it, with 24 brass rays. Tracking's working rows sit under it:
  // they do not wait on Rogier, so the list is still at zero.
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

  function render() {
    syncSidebar();
    renderTabs();
    renderHead();
    var list = document.querySelector("[data-list]");
    list.innerHTML = buildList() + toastHtml();
    window.Crew.drawPlaceholders(list);
    renderPane();
  }

  function motionAllowed() {
    return !reducedMotion.matches;
  }

  /** Returns where each row and section head sits now, keyed by its data-key, for a FLIP. */
  function measureList() {
    var out = {};
    document.querySelectorAll("[data-list] [data-key], [data-list] [data-tracking]").forEach(function (el) {
      out[el.dataset.key || "tracking-head"] = el.getBoundingClientRect().top;
    });
    return out;
  }

  // Rows that stayed slide from where they were to where they are, with a transform only.
  // Rows that are new fade in and drop 6px, as a new signal does.
  function slideFrom(before, arrived) {
    if (!motionAllowed()) return;
    document.querySelectorAll("[data-list] [data-key], [data-list] [data-tracking]").forEach(function (el) {
      var key = el.dataset.key || "tracking-head";
      var top = el.getBoundingClientRect().top;
      if (key === arrived || !(key in before)) {
        el.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
        return;
      }
      var dy = before[key] - top;
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    });
  }

  /** Fades a row out over --dur-1, then calls done. With Reduce motion it calls done at once. */
  function fadeOut(key, done) {
    var el = document.querySelector('[data-list] [data-key="' + key + '"]');
    if (!el || !motionAllowed()) return done();
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "linear", fill: "forwards" }).onfinish = done;
  }

  // The new state's line fades in where the old one was, over --dur-2.
  function crossfadeState(key) {
    if (!motionAllowed()) return;
    var sub = document.querySelector('[data-list] [data-key="' + key + '"] .ask-sub');
    if (sub) sub.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "linear" });
  }

  /* ------------------------------------------------------------------ what changes */

  // Changes Rogier did not make wait while the pointer is over the list, so nothing moves under it.
  var pointerOnList = false;
  var held = [];

  function whenListIsFree(fn) {
    if (pointerOnList) held.push(fn);
    else fn();
  }

  /** Marks a Task done (or cancelled): its row fades, then the rows below close the gap. */
  function tickOff(id, how) {
    var t = findItem(id);
    var order = listOrder();
    var next = order[order.indexOf(id) + 1] || order[order.indexOf(id) - 1];
    fadeOut(id, function () {
      var before = measureList();
      tasks = tasks.filter(function (x) {
        return x.id !== id;
      });
      cleared++;
      if (selected === id) selected = view === "todo" && next && next !== id ? next : null;
      showToast((how === "cancelled" ? "Cancelled " : "Marked done: ") + t.title);
      render();
      slideFrom(before);
    });
  }

  function markSignalDone(id) {
    var s = findItem(id);
    var order = listOrder();
    var next = order[order.indexOf(id) + 1] || order[order.indexOf(id) - 1];
    fadeOut(id, function () {
      var before = measureList();
      s.gone = true;
      cleared++;
      if (selected === id) selected = next;
      showToast("Done: " + s.title);
      render();
      slideFrom(before);
    });
  }

  /** Moves a Task to another state in place: its line crossfades, and it slides when its place changes. */
  function changeState(id, state, patch) {
    var before = measureList();
    var t = findItem(id);
    t.state = state;
    t.since = T.formatClock(T.NOW);
    Object.keys(patch || {}).forEach(function (k) {
      t[k] = patch[k];
    });
    render();
    slideFrom(before);
    crossfadeState(id);
  }

  // Hand to Fix bug on the trailing-space signal: the signal leaves Signals and its Task arrives
  // in Tracking, Working.
  function handOff(signalId) {
    var s = findItem(signalId);
    if (!s || s.gone) return;
    fadeOut(signalId, function () {
      var before = measureList();
      s.gone = true;
      var id = "t-" + signalId;
      tasks.push({ id: id, src: s.src, title: s.title, state: "working", since: T.formatClock(T.NOW), handedAt: T.formatClock(T.NOW), wf: "Fix bug", line: "", asked: { src: s.src, who: "Pieter", kind: "Tagged in a thread", where: "#acceptance", at: s.at, text: "Codes with a trailing space are rejected at checkout. Trim them before the lookup?" }, runs: [{ wf: "Fix bug", state: "working", start: T.formatClock(T.NOW) }], did: ["Starting."] });
      if (selected === signalId) selected = id;
      showToast("Handed to Fix bug: " + s.title);
      render();
      slideFrom(before, id);
    });
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

  function select(id, focusAnswer) {
    selected = id;
    paneOpen = !!id;
    render();
    var row = id && document.querySelector('[data-list] [data-key="' + id + '"]');
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      if (!focusAnswer) row.querySelector(".ask-row").focus({ preventScroll: true });
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
    } else if (k === "Enter") {
      if (e.target.closest && e.target.closest("[data-detail] button, [data-detail] a")) return;
      if (!selected) return;
      e.preventDefault();
      select(selected, true);
    } else if (k === "e" || k === "E") {
      var item = findItem(selected);
      if (view !== "todo" || !item) return;
      if (isTask(item) && canMarkDone(item)) tickOff(item.id, "done");
      else if (!isTask(item)) markSignalDone(item.id);
    } else if (k === "Escape") {
      if (paneOpen) {
        paneOpen = false;
        render();
        var row = document.querySelector('[data-list] [data-key="' + selected + '"] .ask-row');
        if (row) row.focus({ preventScroll: true });
      } else if (selected) {
        selected = null;
        render();
      }
    }
  });

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-id], [data-tab], [data-view], [data-view-link], [data-task-done], [data-signal-done], [data-answer], [data-select], [data-toast], [data-pane-toggle], [data-play], [data-state-pick]");
    if (!el) return;
    var d = el.dataset;
    if (d.toast !== undefined && !d.answer) {
      e.preventDefault();
      flashToast(d.toast);
    } else if (d.taskDone) tickOff(d.taskDone, "done");
    else if (d.signalDone) markSignalDone(d.signalDone);
    else if (d.id) select(d.id);
    else if (d.tab) {
      tab = d.tab;
      if (selected && !listOrder().includes(selected)) selected = null;
      render();
    } else if (d.view || d.viewLink) {
      e.preventDefault();
      var v = d.view || d.viewLink;
      if (v === "later" || v === "everything") return flashToast("Later and Everything are as Intake has them today");
      view = v;
      selected = v === "done" ? "d-205b" : null;
      paneOpen = !!selected;
      render();
    } else if (d.select) {
      e.preventDefault();
      view = "todo";
      tab = "all";
      select(d.select);
    } else if (d.answer) answer(d.answer, el);
    else if (d.paneToggle !== undefined) {
      paneOpen = !paneOpen && !!selected;
      render();
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
      changeState(t.id, "working", { line: "tried again", checks: false });
      showToast("Tried again: " + t.wf + " runs " + t.title + " from the start");
      render();
    } else if (kind === "stop") {
      t.runs[t.runs.length - 1].state = "stopped";
      t.runs[t.runs.length - 1].end = T.formatClock(T.NOW);
      changeState(t.id, "stopped", { line: "", checks: false });
    } else if (kind === "open") flashToast("Opens the run of " + t.wf + " in Workflows");
  }

  /* ------------------------------------------------------------------ the drawing's bar */

  var STATE_NAMES = [
    ["finished", "Finished, open"],
    ["needs-you", "Needs you: a Request"],
    ["needs-you-signal", "Needs you: a signal"],
    ["failed", "Failed"],
    ["working", "Working"],
    ["stopped", "Stopped"],
    ["done", "Done: each handoff's leg"],
    ["empty", "Empty: nothing handed off"],
    ["zero", "Inbox zero, work still out"],
    ["load", "Ten times the load"],
  ];

  function renderProto() {
    var theme = new URLSearchParams(location.search).get("theme");
    document.querySelector("[data-proto]").innerHTML =
      '<span class="tr-proto-tag">Drawing</span>' +
      '<select class="tr-proto-pick" data-state-pick aria-label="State">' +
      STATE_NAMES.map(function (s) {
        return '<option value="' + s[0] + '"' + (s[0] === STATE ? " selected" : "") + ">" + s[1] + "</option>";
      }).join("") +
      "</select>" +
      '<span class="tr-proto-sep"></span>' +
      '<button class="tr-proto-btn" data-play="finish" title="Fix bug finishes Lowercase SKUs. It waits while the pointer is on the list">A run finishes</button>' +
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
    if (view !== "todo" || tab !== "all") {
      view = "todo";
      tab = "all";
      render();
    }
    if (what === "finish") {
      var sku = findItem("t-sku");
      if (!sku || sku.state !== "working") return flashToast("Reset the drawing to play this again");
      whenListIsFree(function () {
        sku.runs[sku.runs.length - 1].state = "finished";
        sku.runs[sku.runs.length - 1].end = T.formatClock(T.NOW);
        changeState("t-sku", "finished");
      });
    } else if (what === "handoff") handOff("s-trail");
    else if (what === "tickoff") {
      if (!findItem("t-1296")) return flashToast("Reset the drawing to play this again");
      tickOff("t-1296", "done");
    }
  }

  /* ------------------------------------------------------------------ start */

  function start() {
    var list = document.querySelector("[data-list]");
    list.addEventListener("pointerenter", function () {
      pointerOnList = true;
    });
    list.addEventListener("pointerleave", function () {
      pointerOnList = false;
      var due = held;
      held = [];
      due.forEach(function (fn) {
        fn();
      });
    });
    renderProto();
    render();
    if (scene.load) {
      var head = document.querySelector("[data-tracking]");
      if (head) list.scrollTop = head.offsetTop - 8;
    }
  }

  root.dataset.intakeCount = countTodo();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
