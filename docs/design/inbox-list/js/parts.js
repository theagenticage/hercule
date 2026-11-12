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
        (opts.action ? '<button type="button" class="undo-line-button" data-undo-act>' + D.esc(opts.action.label) + "<kbd>" + opts.action.key + "</kbd></button>" : "") +
        (opts.undo ? '<button type="button" class="undo-line-button" data-undo>' + D.icon("undo", 14) + "Undo<kbd>⌘Z</kbd></button>" : "");
      el.classList.add("is-on");
      el.removeAttribute("inert");
      clearTimeout(timer);
      timer = setTimeout(hide, opts.undo ? 8000 : 5000);
    }
    function hide() { var el = document.getElementById("undo"); el.classList.remove("is-on"); el.setAttribute("inert", ""); }
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-undo]")) Moves.undo();
      if (e.target.closest("[data-undo-act]")) Moves.goTo();
    });
    return { show: show, hide: hide };
  })();

  // ---- The "N new" bar: arrivals wait behind it, so the list holds still while you read ----
  window.Live = (function () {
    function showBar(nb, on) {
      if (on) {
        nb.hidden = false;
        if (!Motion.isReduced()) { var b = Motion.body(nb); b.set({ y: -14, o: 0 }); b.to({ y: 0, o: 1 }, "self"); }
      } else {
        if (Motion.isReduced()) { nb.hidden = true; return; }
        Motion.body(nb).to({ y: -10, o: 0 }, "hand", { done: function () { nb.hidden = true; Motion.body(nb).clear(); } });
      }
    }
    /** Brings things in the way the controller's live updates would: into the bar, never into the list. */
    function arrive(things) {
      var st = App.state;
      things.forEach(function (t) { t.history = t.history || []; t.blocks = t.blocks || []; t.account = t.account || World.ACCOUNTS[Model.sourceOf(t)][0]; st.pending.push(t); });
      App.render({});
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
      if (!n) { if (!el.hidden) { el.hidden = true; } return; }
      var wasHidden = el.hidden;
      el.innerHTML = '<span class="sb-n"><b>' + n + "</b> selected</span>" +
        '<button type="button" class="sb-act" data-move="link"' + (n < 2 ? ' aria-disabled="true" title="Select one more to link"' : ' title="Link them"') + ">Link<kbd>L</kbd></button>" +
        '<button type="button" class="sb-act" data-move="thread" title="Start a thread on all ' + n + '">Thread<kbd>N</kbd></button>' +
        '<button type="button" class="sb-act" data-move="take" title="Take them on: one Task">Take on<kbd>T</kbd></button>' +
        '<button type="button" class="sb-act" data-move="dismiss" title="Dismiss all ' + n + '">Dismiss<kbd>E</kbd></button>' +
        '<i class="sb-line"></i><button type="button" class="icon-btn sb-clear" data-clear title="Clear the selection (Esc)" aria-label="Clear the selection">' + D.icon("close", 14) + "</button>";
      el.hidden = false;
      if (wasHidden && !Motion.isReduced()) { var b = Motion.body(el); b.set({ y: 12, o: 0 }); b.to({ y: 0, o: 1 }, "hand"); }
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
        el.innerHTML = '<div class="em em--search"><p class="em-title">Nothing matches</p><p class="em-line">No thing here has ' + s.search.clauses.map(function (c) { return "<code>" + D.esc(c.key + ":" + c.value) + "</code>"; }).join(" and ") + (s.search.text ? " " + D.esc(s.search.text) : "") + '.</p><button type="button" class="btn btn--sm" data-clear-search>Clear the search<kbd>Esc</kbd></button></div>';
        return;
      }
      var all = Model.live().length;
      if (!all) {
        el.innerHTML = '<div class="em em--zero"><div class="em-sun">' + sunrise() + '</div><p class="em-title">All clear</p><p class="em-line">Nothing out there needs you. New things arrive here as your sources see them.</p></div>';
        return;
      }
      var title = App.scopeTitle();
      var line = s.scope.saved === "waits" ? "Nobody is waiting on you. " + Model.countSaved("updates") + " updates are in Updates (3)." : s.scope.triage ? "Hercule has nothing for you to decide." : "Nothing of yours here yet.";
      el.innerHTML = '<div class="em"><div class="em-sun em-sun--small">' + sunrise() + '</div><p class="em-title">' + (s.scope.saved === "waits" ? "Nobody waits on you" : "Nothing in " + D.esc(title)) + '</p><p class="em-line">' + D.esc(line) + "</p></div>";
    }
    document.addEventListener("click", function (e) { if (e.target.closest("[data-clear-search]")) Bar.clear(true); });
    return { draw: draw };
  })();

  // ---- Flights: the cause shows first, then the effect ----
  window.Flights = (function () {
    function workRow() { return document.querySelector('.side [data-motion-target="overview"]'); }
    /** Flies each thing's mark to Work in the sidebar: a Task now holds it. */
    function toWork(things) {
      var to = workRow();
      if (!to) return;
      things.slice(0, 3).forEach(function (t, i) {
        var row = App.el.list.querySelector('[data-id="' + t.id + '"] .mk');
        if (!row) return;
        setTimeout(function () {
          Motion.fly(D.mark(Model.sourceOf(t), 16), row.getBoundingClientRect(), to.querySelector("svg").getBoundingClientRect()).then(function () { receive(to); });
        }, i * 60);
      });
    }
    function receive(to) {
      Motion.knock(to.querySelector("svg"), 120);
      Motion.animate(to, [{ backgroundColor: "color-mix(in oklab, var(--accent) 16%, transparent)" }, { backgroundColor: "transparent" }], { duration: 640, easing: "ease-out" });
    }
    /**
     * Plays a hand-off on its row: the wait goes and the colleague rises into its place, takes the
     * weight, the sentence rolls to who has it, and the mark flies to Work. Then the row leaves.
     */
    function handChain(row, t, who, finish) {
      if (Motion.isReduced()) { finish(); return; }
      var slot = row.querySelector(".row-time");
      var why = row.querySelector(".row-why");
      var face = document.createElement("span");
      face.className = "row-time row-time--held row-time--arriving";
      face.innerHTML = D.face(who, "working", 18);
      slot.replaceWith(face);
      var fb = Motion.body(face.firstElementChild);
      fb.set({ y: 22, o: 0 });
      fb.to({ y: 0, o: 1 }, "hand");
      setTimeout(function () {
        Motion.knock(face.firstElementChild, 150);
        var old = why.innerHTML;
        why.innerHTML = '<span class="roll"><span class="roll-a">' + old + '</span><span class="roll-b">' + D.esc(who) + " has it</span></span>";
        why.classList.add("is-rolling");
        var m = row.querySelector(".mk");
        var to = workRow();
        if (m && to) Motion.fly(D.mark(Model.sourceOf(t), 16), m.getBoundingClientRect(), to.querySelector("svg").getBoundingClientRect()).then(function () { receive(to); });
      }, 170);
      setTimeout(finish, 900);
    }
    return { toWork: toWork, handChain: handChain };
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
      var ta = box.querySelector("textarea");
      ta.focus();
      var send = function () { if (!ta.value.trim()) { ta.focus(); return; } Moves.settle(f, a.label.replace("…", "") + " sent to " + f.s.by + " on " + Kinds.SOURCES[Model.sourceOf(f.t)].name, true); };
      box.addEventListener("click", function (e) {
        if (e.target.closest("[data-reply-cancel]")) box.remove();
        if (e.target.closest("[data-reply-send]")) send();
      });
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.stopPropagation(); box.remove(); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
      });
      if (!Motion.isReduced()) Motion.animate(box, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    return { open: open };
  })();
})();
