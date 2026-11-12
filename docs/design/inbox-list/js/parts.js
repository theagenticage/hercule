// PROTOTYPE - the smaller parts of the page: the undo line, the "N new" bar, the selection bar,
// the empty states, the flights a move makes, and the reply box of an answer with a field.
(function () {
  "use strict";
  var D = Draw;

  // ---- The undo line, the app's own: what just happened, and Undo ----
  window.Undo = (function () {
    var timer = 0;
    function show(text, opts) {
      var el = document.getElementById("undo");
      el.innerHTML = '<span class="undo-text">' + D.esc(text) + "</span>" + (opts.note ? '<span class="undo-note">' + D.esc(opts.note) + "</span>" : "") +
        (opts.action ? '<button type="button" class="undo-line-button" data-undo-act aria-keyshortcuts="G">' + D.esc(opts.action.label) + '<kbd aria-hidden="true">' + opts.action.key + "</kbd></button>" : "") +
        (opts.undo ? '<button type="button" class="undo-line-button" data-undo aria-keyshortcuts="Meta+Z">' + D.icon("undo", 14) + 'Undo<kbd aria-hidden="true">⌘Z</kbd></button>' : "");
      el.classList.add("is-on");
      el.removeAttribute("inert");
      var spoken = [text, opts.note, opts.undo ? "Command Z undoes it" : ""].filter(Boolean).map(function (x) { return x.replace(/[.\s]+$/, ""); }).join(". ") + ".";
      Announce.say(spoken);
      clearTimeout(timer);
      timer = setTimeout(hide, opts.undo ? 8000 : 5000);
    }
    function hide() { var el = document.getElementById("undo"); el.classList.remove("is-on"); el.setAttribute("inert", ""); }
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-undo]")) Moves.undo();
      if (e.target.closest("[data-undo-act]")) { var l = Moves.last(); Moves.goTo(l && l.action ? l.action.task : undefined); }
    });
    return { show: show, hide: hide };
  })();

  // ---- One polite live region, always in the tree, for what a screen reader user would otherwise miss ----
  window.Announce = (function () {
    var t = 0;
    function say(text) {
      var el = document.getElementById("announcer");
      if (!el) return;
      el.textContent = "";
      clearTimeout(t);
      // Written a moment after it is emptied, so the same words twice are still spoken twice.
      t = setTimeout(function () { el.textContent = text; }, 60);
    }
    return { say: say };
  })();

  // ---- The "N new" bar: arrivals wait behind it, so the list holds still while you read ----
  window.Live = (function () {
    /** Plays the "N new" pill's arrival in the list head: it grows from its centre, solid from the first frame. */
    function showBar(nb) {
      if (Motion.isReduced() || !nb) return;
      nb.animate([{ transform: "scale(.9)", clipPath: "inset(0 30% round 999px)" }, { transform: "none", clipPath: "inset(0 round 999px)" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
      Array.prototype.forEach.call(nb.children, function (c) { c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, delay: 60, fill: "backwards" }); });
    }
    /** Brings things in the way the controller's live updates would: into the bar, never into the list. */
    function arrive(things) {
      var st = App.state;
      things.forEach(function (t) { t.history = t.history || []; t.blocks = t.blocks || []; t.account = t.account || World.ACCOUNTS[Model.sourceOf(t)][0]; st.pending.push(t); });
      App.render({});
      Announce.say(st.pending.length + " new " + (st.pending.length === 1 ? "thing" : "things") + ". Period shows them.");
      var c = document.querySelector("[data-inbox-count]");
      if (c) { c.textContent = Model.countSaved("waits") + st.pending.filter(Model.asks).length; Motion.animate(c, [{ transform: "translateY(4px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" }); }
    }
    return { showBar: showBar, arrive: arrive };
  })();

  // ---- The selection bar: what a selection can do, with its keys ----
  window.Selection = (function () {
    function draw(s) {
      var el = document.getElementById("selbar");
      var n = s.selection.size;
      if (!n) {
        if (!el.hidden && !el.dataset.leaving) {
          if (Motion.isReduced()) { el.hidden = true; return; }
          el.dataset.leaving = "1";
          el.animate([{ transform: "none", clipPath: "inset(0 round 12px)" }, { transform: "translateY(4px) scale(.97)", clipPath: "inset(40% 30% round 12px)" }], { duration: 140, easing: "ease-in" }).finished.then(function () { el.hidden = true; delete el.dataset.leaving; }).catch(function () {});
        }
        return;
      }
      if (el.dataset.leaving) { delete el.dataset.leaving; el.getAnimations().forEach(function (a) { a.cancel(); }); }
      var wasHidden = el.hidden;
      // The moves of a selection are in the pane's footer, so the bar only counts and clears.
      el.innerHTML = '<span class="sb-n"><b>' + n + "</b> selected</span>" +
        '<i class="sb-line"></i><button type="button" class="icon-btn sb-clear" data-clear title="Clear the selection (Esc)" aria-label="Clear the selection">' + D.icon("close", 14) + "</button>";
      el.hidden = false;
      if (wasHidden && !Motion.isReduced()) {
        el.animate([{ transform: "translateY(6px) scale(.96)", clipPath: "inset(40% 30% round 12px)" }, { transform: "none", clipPath: "inset(0 round 12px)" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
        Array.prototype.forEach.call(el.children, function (c) { c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, delay: 60, fill: "backwards" }); });
      }
    }
    document.addEventListener("click", function (e) {
      var bar = e.target.closest("#selbar");
      if (!bar) return;
      if (e.target.closest("[data-clear]")) { App.state.selection.clear(); App.render({}); return; }
      var m = e.target.closest("[data-move]");
      if (m && m.getAttribute("aria-disabled") !== "true") Moves.run(m.dataset.move, m);
    });
    return { draw: draw };
  })();

  // ---- Empty states: a saved query with nothing, a search with nothing, and the whole Inbox clear ----
  window.Empty = (function () {
    function sunrise() {
      var rays = "";
      for (var i = 0; i < 9; i++) { var a = -80 + i * 20; rays += '<line x1="60" y1="58" x2="' + (60 + Math.sin(a * Math.PI / 180) * 54).toFixed(1) + '" y2="' + (58 - Math.cos(a * Math.PI / 180) * 54).toFixed(1) + '" style="--i:' + Math.abs(i - 4) + '"/>'; }
      return '<svg class="sun" viewBox="0 0 120 64" width="168" height="90" aria-hidden="true"><g class="sun-rays">' + rays + '</g><line class="sun-line" x1="6" y1="58" x2="114" y2="58"/></svg><span class="sun-head">' + D.face("Hercule", "idle", 40) + "</span>";
    }
    function draw(el, s) {
      var searching = s.search.text || s.search.clauses.length;
      if (s.loading) { el.innerHTML = ""; return; }
      if (searching) {
        var wider = s.scope.saved === "all" ? 0 : Model.find({ saved: "all" }, s.search).length;
        var what = s.search.clauses.map(function (c) { return "<code>" + D.esc(Kinds.FIELDS[c.key].token + ":" + c.value) + "</code>"; }).concat(s.search.text ? ["“" + D.esc(s.search.text) + "”"] : []).join(" and ");
        el.innerHTML = '<div class="em em--search"><p class="em-title">Nothing in ' + D.esc(App.scopeTitle()) + ' matches</p><p class="em-line">No thing here has ' + what + ".</p>" + (wider ? '<button type="button" class="btn btn--sm" data-widen-search>Search Everything · ' + wider + "<kbd>⌫</kbd></button>" : "") + '<button type="button" class="btn btn--sm btn--quiet" data-clear-search>Clear the search<kbd>Esc</kbd></button></div>';
        return;
      }
      var all = Model.live().length;
      if (!all) {
        el.innerHTML = '<div class="em em--zero" style="--sun-wait:240ms"><div class="em-sun">' + sunrise() + '</div><p class="em-title">All clear</p><p class="em-line">Nothing out there needs you. New things arrive here as your sources see them.</p></div>';
        return;
      }
      var title = App.scopeTitle();
      var line = s.scope.saved === "waits" ? D.esc(Model.countSaved("updates") + " things changed without asking anything. They are in ") + '<button type="button" class="link em-link" data-go-updates title="Updates (3)">Updates</button>.' : s.scope.triage ? "Hercule has nothing for you to decide." : "Nothing of yours here yet.";
      el.innerHTML = '<div class="em"><div class="em-sun em-sun--small">' + sunrise() + '</div><p class="em-title">' + (s.scope.saved === "waits" ? "Nobody waits on you" : "Nothing in " + D.esc(title)) + '</p><p class="em-line">' + line + "</p></div>";
    }
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-clear-search]")) Bar.clear(true);
      if (e.target.closest("[data-widen-search]")) Bar.widen();
      if (e.target.closest("[data-go-updates]")) Moves.setScope({ saved: "updates" });
    });
    return { draw: draw };
  })();

  // ---- Flights: the cause shows first, then the effect ----
  window.Flights = (function () {
    function workRow() { return document.querySelector('.side [data-motion-target="overview"]'); }
    /** Flies each thing's mark to Work in the sidebar: a Task now holds it. Measures before the list redraws. */
    function toWork(things) {
      var to = workRow();
      if (!to || Motion.isReduced()) return;
      var target = to.querySelector("svg").getBoundingClientRect();
      var shown = things.map(function (t) { return App.el.list.querySelector('[data-id="' + t.id + '"] .mk'); }).filter(Boolean);
      // A folded group has no member rows: its own marks fly instead.
      if (!shown.length) { var cur = App.el.list.querySelector('[data-key="' + App.state.focus + '"]'); if (cur) shown = Array.prototype.slice.call(cur.querySelectorAll(".row-marks .mk")); }
      shown.slice(0, 3).forEach(function (m, i) {
        var t = things[i] || things[0];
        var from = m.getBoundingClientRect();
        var html = m.outerHTML;
        setTimeout(function () {
          var p = Motion.fly(html, from, target);
          var mine = document.querySelector("body > .flight:last-of-type");
          p.then(function () { if (!mine || !mine.dataset.cancelled) receive(to); });
        }, i * 60);
      });
    }
    /** Stops every mark in flight where it is: it fades in 120ms and Work receives nothing. */
    function cancel() {
      document.querySelectorAll("body > .flight").forEach(function (f) {
        f.dataset.cancelled = "1";
        f.getAnimations().forEach(function (a) { a.pause(); });
        f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }).finished.then(function () { f.remove(); });
      });
    }
    function receive(to) {
      Motion.knock(to.querySelector("svg"), 120);
      Motion.animate(to, [{ backgroundColor: "color-mix(in oklab, var(--accent) 16%, transparent)" }, { backgroundColor: "transparent" }], { duration: 640, easing: "ease-out" });
    }
    /**
     * Plays a hand-off on its row. The wait rolls up out of its slot as the colleague rolls in, then the
     * colleague takes the weight, the sentence rolls to who has it, and the mark flies to Work. The row
     * leaves when the mark lands. Both rolls are clipped to their line.
     */
    function handChain(row, t, who, finish) {
      var stopped = false;
      var handle = { cancel: function () { stopped = true; cancel(); } };
      if (Motion.isReduced()) { finish(); return handle; }
      var slot = row.querySelector(".row-time");
      var why = row.querySelector(".row-why");
      var face = document.createElement("span");
      face.className = "row-time row-time--arriving";
      face.innerHTML = '<span class="roll roll--slot"><span class="roll-a">' + slot.innerHTML + '</span><span class="roll-b">' + D.face(who, "working", 18) + "</span></span>";
      slot.replaceWith(face);
      var head = face.querySelector(".roll-b");
      var m = row.querySelector(".mk");
      var from = m ? m.getBoundingClientRect() : null;
      setTimeout(function () {
        if (stopped) return;
        Motion.knock(head, 150);
        why.innerHTML = '<span class="roll"><span class="roll-a">' + why.innerHTML + '</span><span class="roll-b">' + D.esc(who) + " has it</span></span>";
        why.classList.add("is-rolling");
        var to = workRow();
        if (from && to) Motion.fly(D.mark(Model.sourceOf(t), 16), from, to.querySelector("svg").getBoundingClientRect()).then(function () { if (stopped) return; receive(to); finish(); });
        else finish();
      }, 170);
      return handle;
    }
    return { toWork: toWork, handChain: handChain, cancel: cancel };
  })();

  // ---- The reply box of an answer with a field, inside its signal's section ----
  window.Reply = (function () {
    function open(button, f, a) {
      var sec = button.closest(".sig");
      var box = sec.querySelector(".reply");
      if (box) { box.querySelector("textarea").focus(); return; }
      box = document.createElement("div");
      box.className = "reply";
      box.innerHTML = '<textarea rows="3" aria-label="' + D.esc(a.label.replace("…", "")) + '" placeholder="' + (a.id === "reply" ? "Reply to " + D.esc(f.s.by) + "…" : "Your note…") + '"></textarea><div class="reply-row"><span class="reply-as">as you on ' + D.esc(Kinds.SOURCES[Model.sourceOf(f.t)].name) + '</span><button type="button" class="btn btn--sm btn--quiet" data-reply-cancel>Cancel<kbd>Esc</kbd></button><button type="button" class="btn btn--sm btn--answer" data-reply-send>' + D.esc(a.label.replace("…", "")) + "<kbd>⌘↩</kbd></button></div>";
      sec.querySelector(".sig-answers").after(box);
      button.classList.add("is-pressed");
      var ta = box.querySelector("textarea");
      ta.focus();
      var send = function () { if (!ta.value.trim()) { ta.focus(); return; } Moves.settle(f, a.label.replace("…", "") + " sent to " + f.s.by + " on " + Kinds.SOURCES[Model.sourceOf(f.t)].name, true); };
      box.addEventListener("click", function (e) {
        if (e.target.closest("[data-reply-cancel]")) { box.remove(); button.classList.remove("is-pressed"); button.focus(); }
        if (e.target.closest("[data-reply-send]")) send();
      });
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.stopPropagation(); box.remove(); button.classList.remove("is-pressed"); button.focus(); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
      });
      if (!Motion.isReduced()) Motion.animate(box, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    return { open: open };
  })();
})();
