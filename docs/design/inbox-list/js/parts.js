// PROTOTYPE - the smaller parts of the page: the undo line, the "N new" bar, the selection bar,
// the empty states, the flights a move makes, and the reply box of an answer with a field.
(function () {
  "use strict";
  var D = Draw;

  // ---- The undo line, the app's own: what just happened, and Undo ----
  window.Undo = (function () {
    var timer = 0;
    /**
     * Shows the undo line: what happened, a note, the move's action and Undo. `opts.entry` is the move on
     * the undo stack the line speaks for, so the line can say when that move's answer is sent. When the
     * words do not fit, the buttons drop their key hints and the action keeps only its key; a line with
     * no buttons wraps instead.
     */
    function show(text, opts) {
      var el = document.getElementById("undo");
      el.innerHTML = '<span class="undo-text">' + D.esc(text) + "</span>" + (opts.note ? '<span class="undo-note">' + D.esc(opts.note) + "</span>" : "") +
        (opts.action ? '<button type="button" class="undo-line-button" data-undo-act aria-keyshortcuts="G" aria-label="' + D.esc(opts.action.label) + '" title="' + D.esc(opts.action.label) + '"><span class="undo-act-label">' + D.esc(opts.action.label) + '</span><kbd aria-hidden="true">' + opts.action.key + "</kbd></button>" : "") +
        (opts.undo ? '<button type="button" class="undo-line-button" data-undo aria-keyshortcuts="Meta+Z">' + D.icon("undo", 14) + 'Undo<kbd aria-hidden="true">⌘Z</kbd></button>' : "");
      el._entry = opts.entry || null;
      // A line kept where it rose (the list widened under it) is placed afresh; while hidden, with no
      // transition, so it rises straight where it now belongs.
      if (!el.classList.contains("is-on") && el.style.getPropertyValue("--undo-line-x")) {
        el.style.transition = "none";
        el.style.removeProperty("--undo-line-x");
        void el.offsetWidth;
        el.style.transition = "";
      } else el.style.removeProperty("--undo-line-x");
      el.classList.remove("is-tight");
      el.classList.toggle("is-wrap", !opts.undo && !opts.action);
      el.classList.add("is-on");
      el.removeAttribute("inert");
      // A line that does not fit shortens the thing's title first, at a word, to 12 letters at least;
      // then it leaves the title out ("Handed to Review PR"); only then do the buttons drop their labels.
      var words = el.querySelector(".undo-text");
      var fits = function () { return words.scrollWidth <= words.clientWidth + 1; };
      var quoted = /“([^”]*)”/.exec(text);
      var atWord = function (s, n) { var t = s.slice(0, n), sp = t.lastIndexOf(" "); return (sp >= 8 ? t.slice(0, sp) : t).replace(/[\s,.:;–-]+$/, ""); };
      for (var keep = quoted ? quoted[1].replace(/…$/, "").length : 0; !fits() && keep > 12; ) {
        keep = Math.max(12, keep - 3);
        words.textContent = text.replace(quoted[0], "“" + atWord(quoted[1], keep) + "…”");
      }
      if (!fits() && quoted) words.textContent = text.replace(/[:,]?\s*“[^”]*”/, "");
      if (!fits()) el.classList.add("is-tight");
      var spoken = [text, opts.note, opts.undo ? "Command Z undoes it" : ""].filter(Boolean).map(function (x) { return x.replace(/[.\s]+$/, ""); }).join(". ") + ".";
      Announce.say(spoken);
      clearTimeout(timer);
      timer = setTimeout(hide, opts.undo ? 8000 : 5000);
      if (el.matches(":hover")) clearTimeout(timer);
      // The line stays while the pointer or the focus is on it, and goes 3s after both leave.
      if (!el._watch) {
        el._watch = true;
        var hold = function () { clearTimeout(timer); };
        var release = function () { if (!el.matches(":hover") && !el.contains(document.activeElement)) { clearTimeout(timer); timer = setTimeout(hide, 3000); } };
        el.addEventListener("pointerenter", hold);
        el.addEventListener("focusin", hold);
        el.addEventListener("pointerleave", release);
        el.addEventListener("focusout", function () { setTimeout(release, 0); });
      }
    }
    /** Hides the undo line. The focus, when it was on the line, goes back to the current row. */
    function hide() {
      var el = document.getElementById("undo");
      var had = el.contains(document.activeElement);
      el.classList.remove("is-on");
      el.setAttribute("inert", "");
      if (had) App.focusCurrent();
    }
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-undo]")) Moves.undo();
      if (e.target.closest("[data-undo-act]")) { var l = Moves.last(); Moves.goTo(l && l.action ? l.action.task : undefined); }
    });
    /** Checks whether the line is showing this move and is held by the pointer or the focus. */
    function holds(entry) {
      var el = document.getElementById("undo");
      return el._entry === entry && el.classList.contains("is-on") && (el.matches(":hover") || el.contains(document.activeElement));
    }
    /** Says on the line that this move's answer went, and takes Undo away, if the line still shows it. */
    function markSent(entry, words) {
      var el = document.getElementById("undo");
      if (el._entry !== entry || !el.classList.contains("is-on")) return;
      var had = el.contains(document.activeElement);
      el.querySelectorAll("[data-undo], .undo-note").forEach(function (n) { n.remove(); });
      el.insertAdjacentHTML("beforeend", '<span class="undo-note">' + D.esc(words) + "</span>");
      Announce.say(words);
      if (had) App.focusCurrent();
      if (!el.matches(":hover")) { clearTimeout(timer); timer = setTimeout(hide, 3000); }
    }
    /** Changes the note on the line, if the line still shows this move. */
    function setNote(entry, words) {
      var el = document.getElementById("undo");
      var note = el._entry === entry && el.querySelector(".undo-note");
      if (note && note.textContent !== words) note.textContent = words;
    }
    return { show: show, hide: hide, holds: holds, markSent: markSent, setNote: setNote };
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
      var line = s.scope.saved === "waits" ? D.esc(Model.countSaved("updates") + " things changed without asking anything. They are in ") + '<button type="button" class="link em-link" data-go-updates>Updates</button>.' : s.scope.triage ? "Hercule has nothing for you to decide." : "Nothing of yours here yet.";
      // The small sunrise waits, as the full one does, for the last row and the pane to go first.
      el.innerHTML = '<div class="em" style="--sun-wait:240ms"><div class="em-sun em-sun--small">' + sunrise() + '</div><p class="em-title">' + (s.scope.saved === "waits" ? "Nobody waits on you" : "Nothing in " + D.esc(title)) + '</p><p class="em-line">' + line + "</p></div>";
    }
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-clear-search]")) Bar.clear(true);
      if (e.target.closest("[data-widen-search]")) Bar.widen();
      if (e.target.closest("[data-go-updates]")) Moves.setScope({ saved: "updates" });
    });
    // The buttons' keys work while the focus is on them, as their hints say.
    document.addEventListener("keydown", function (e) {
      if (!e.target.closest || !e.target.closest("#empty")) return;
      if (e.key === "Backspace" && document.querySelector("[data-widen-search]")) Bar.widen();
      else if (e.key === "Escape" && document.querySelector("[data-clear-search]")) Bar.clear(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
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
    // Unsent words per ask and answer: closing the box, moving away, or ⌘Z on a sent reply keeps them.
    var drafts = {};
    /** Opens the reply box of an answer under its signal's section, with any words kept from before. */
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
      var key = f.s.id + "|" + a.id;
      ta.value = drafts[key] || "";
      ta.addEventListener("input", function () { drafts[key] = ta.value; });
      ta.focus();
      // ⌘Z on a sent reply opens the box again, with the words and the focus in it.
      var again = function () {
        var b = document.querySelector('#pane [data-answer="' + a.id + '"][data-sig="' + f.s.id + '"]');
        if (!b) return;
        // Under 1032px the pane may have slid away since; it comes back, so the box is never typed into unseen.
        if (App.isStacked() && !App.isPaneOpen()) App.setPaneOpen(true, true);
        open(b, f, a);
      };
      var send = function () { if (!ta.value.trim()) { ta.focus(); return; } Moves.settle(f, a.label.replace("…", "") + " sent to " + f.s.by + " on " + Kinds.SOURCES[Model.sourceOf(f.t)].name, true, again); };
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
