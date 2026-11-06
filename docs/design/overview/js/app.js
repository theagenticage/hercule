// PROTOTYPE - starts the window: the world, the board, and the states a person can meet.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var scene = q.get("scene") || "today";
  var root = document.documentElement;
  if (q.get("later")) root.dataset.later = "1";
  if (q.get("motion")) root.dataset.motion = q.get("motion");

  var work = document.getElementById("work");
  Shell.drawSidebar(document.querySelector("[data-side]"), {
    inboxCount: scene === "first" || scene === "empty" ? 0 : 22,
    waiting: scene === "first" || scene === "empty" ? [] : undefined,
    sum: scene === "first" || scene === "empty" ? "Nothing running" : undefined,
  });
  Store.loadWorld(Scenes.build(scene));
  work.dataset.scene = scene;
  if (scene === "offline") {
    work.classList.add("is-offline");
    Store.state.offline = true;
  }

  var replay = scene === "today" && q.get("replay") !== "off";
  if (scene === "today") {
    // Scenes hold the morning's end state; arrivals have not happened until the replay plays them.
    Live.rewindToLastNight();
    if (!replay) {
      Scenes.OVERNIGHT.forEach(function (s) {
        if (s.kind === "arrive") Store.addTask(JSON.parse(JSON.stringify(s.task)));
        else if (s.from !== s.to) Store.moveByFact(s.id, s.to, s.apply);
      });
    }
  }

  Board.mount();
  Drag.mount();
  Pane.mount();
  Keys.mount();
  Find.mount();
  Live.mount();
  Overview.mount();
  Tray.mount();
  Select.mount();

  document.getElementById("find-icon").innerHTML = Crew.icon("search", 16);
  document.getElementById("display-btn").innerHTML = Crew.icon("sliders", 16);

  var scroll = document.getElementById("scroll");
  scroll.addEventListener("scroll", function () {
    document.querySelector(".rule-wrap").classList.toggle("is-stuck", scroll.scrollTop > 72);
    // The sentence fades before it reaches the pill, so the pill never cuts it in half.
    document.querySelector(".lead-row").style.opacity = Math.max(0, 1 - scroll.scrollTop / 40).toFixed(2);
  }, { passive: true });

  work.addEventListener("click", function (e) {
    var more = e.target.closest(".card-more");
    if (more) {
      var host = more.closest(".card");
      var stack = Board.readStack(host);
      if (stack) Fan.show(host, stack);
      return;
    }
    var fold = e.target.closest("[data-fold-lane]");
    if (fold) return Fold.toggleRows(fold.dataset.foldLane);
    var plan = e.target.closest("[data-fold-plan]");
    if (plan) return Fold.togglePlan(plan.dataset.foldPlan);
    var pile = e.target.closest(".pile");
    if (pile) return Fan.show(pile);
    if (Fan.isOpen() && !e.target.closest(".card")) return Fan.hide();
    if (e.target.closest("[data-walk]")) return Walk.step(1);
    var lens = e.target.closest(".lens[data-lens]");
    if (lens) return Lens.toggle(lens.dataset.lens);
    var bead = e.target.closest(".bead[data-id]");
    if (bead) return Pane.show(bead.dataset.id);
    var wire = e.target.closest(".wire");
    if (wire && wire.dataset.key.indexOf("wire:plan-") === 0) return Fold.togglePlan(wire.dataset.key.slice(10));
    var card = e.target.closest(".card[data-id]");
    if (card) {
      if (MergePick.isActive()) return MergePick.finish(card.dataset.id);
      if (e.metaKey || e.ctrlKey || e.shiftKey) return Select.toggle(card.dataset.id);
      Keys.focusCard(card, true);
      Pane.show(card.dataset.id);
      return;
    }
    if (e.target.closest("[data-first-thread]")) return Welcome.startFirst();
    if (Pane.currentId()) Pane.hide();
  });
  // The current card follows the pointer as well as the keys, as it does in the Inbox.
  work.addEventListener("pointerover", function (e) {
    Keys.setHover(e.target.closest(".card[data-id]"));
  });
  work.addEventListener("pointerleave", function () { Keys.setHover(null); });

  var lead = document.getElementById("lead");
  lead.addEventListener("pointerover", function (e) {
    var lens = e.target.closest(".lens[data-lens]");
    if (lens) Lens.preview(lens.dataset.lens);
  });
  lead.addEventListener("pointerleave", function () { Lens.preview(null); });

  // A bead shows what it is on approach, and a waiting row in the sidebar points at its card.
  var peek = document.getElementById("peek");
  var peekTimer = 0;
  document.getElementById("lanes").addEventListener("pointerover", function (e) {
    var bead = e.target.closest(".bead[data-id]");
    clearTimeout(peekTimer);
    if (!bead) {
      peek.classList.remove("is-on");
      return;
    }
    peekTimer = setTimeout(function () {
      var t = Store.task(bead.dataset.id);
      if (!t) return;
      peek.innerHTML = "<b>" + Board.esc(t.name) + "</b><span>" + Board.esc(t.now || "") + "</span><small>" + Board.esc(Store.describeNeed(t)) + "</small>";
      peek.setAttribute("aria-hidden", "true");
      var r = bead.getBoundingClientRect();
      peek.style.left = Math.min(innerWidth - 262, Math.max(280, r.left - 20)) + "px";
      peek.style.top = r.top - peek.offsetHeight - 10 + "px";
      peek.classList.add("is-on");
    }, 140);
  });
  document.querySelector("[data-side]").addEventListener("pointerover", function (e) {
    document.querySelectorAll(".is-called").forEach(function (c) { c.classList.remove("is-called"); });
    var row = e.target.closest("[data-task]");
    if (!row || !row.dataset.task) return;
    var el = Board.locate(row.dataset.task);
    if (el) el.classList.add("is-called");
  });
  document.querySelector("[data-side]").addEventListener("pointerleave", function () {
    document.querySelectorAll(".is-called").forEach(function (c) { c.classList.remove("is-called"); });
  });
  function openFromRow(e) {
    var row = e.target.closest("[data-task]");
    if (!row || !row.dataset.task) return;
    if (Overview.current() !== "work") Overview.show("work");
    Pane.show(row.dataset.task);
  }
  document.querySelector("[data-side]").addEventListener("click", openFromRow);
  document.querySelector("[data-side]").addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") openFromRow(e);
  });

  // A blocked card points at what holds it, while the pointer rests on it. The line is a passing
  // explanation, not structure: One surface is where chains of blockers live.
  var blockerTimer = 0;
  document.getElementById("lanes").addEventListener("pointerover", function (e) {
    var card = e.target.closest('.card[data-height="press"][data-id]');
    clearTimeout(blockerTimer);
    if (!card) {
      Blocker.hide();
      return;
    }
    blockerTimer = setTimeout(function () { Blocker.show(card); }, 240);
  });

  window.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && scene === "first" && !Store.state.tasks.length) {
      e.preventDefault();
      Welcome.startFirst();
    }
  });

  var display = document.getElementById("display");
  document.getElementById("display-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    display.classList.toggle("is-on");
    e.currentTarget.setAttribute("aria-expanded", display.classList.contains("is-on"));
  });
  document.getElementById("keys-switch").addEventListener("change", function (e) { Keys.setSingleKeys(e.target.checked); });
  display.addEventListener("click", function (e) {
    e.stopPropagation();
    var act = e.target.closest("[data-display]");
    if (!act) return;
    if (act.dataset.display === "fold") Fold.toggleAll();
    if (act.dataset.display === "keys") Help.toggle();
    if (act.dataset.display === "fold" || act.dataset.display === "keys") display.classList.remove("is-on");
  });
  document.getElementById("wear-switch").addEventListener("change", Display.toggleWear);
  document.getElementById("still-switch").addEventListener("change", function (e) {
    root.dataset.still = e.target.checked ? "1" : "";
  });
  window.addEventListener("click", function (e) {
    display.classList.remove("is-on");
    if (Store.state.query && !e.target.closest("#find, #find-list")) Find.clearQuery();
    if (!e.target.closest("#help")) document.getElementById("help").classList.remove("is-on");
  });

  if (q.get("wear")) {
    Store.state.wear = true;
    document.getElementById("wear-switch").checked = true;
    Board.draw();
  }

  // One tab stop leads onto the board; from there the arrows walk it.
  var firstCard = document.querySelector("#lanes .card");
  if (firstCard) firstCard.tabIndex = 0;

  if (scene === "empty") Welcome.drawSunrise();
  if (scene === "loading") Welcome.playLoading();
  if (replay) {
    if (Motion.isReduced()) Live.skipToMorning();
    else setTimeout(Live.replayMorning, 900);
  }
})();
