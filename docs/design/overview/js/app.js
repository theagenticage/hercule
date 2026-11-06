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
    waiting: scene === "first" || scene === "empty" || scene === "quiet" ? [] : undefined,
    sum: scene === "first" || scene === "empty" ? "Nothing running" : undefined,
  });
  Store.loadWorld(Scenes.build(scene));
  work.dataset.scene = scene;
  if (scene === "offline") {
    work.classList.add("is-offline");
    Store.state.offline = true;
  }

  var replay = scene === "today" && q.get("replay") !== "off";
  if (scene === "today" || scene === "failed" || scene === "quiet") {
    // Scenes hold the morning's end state; arrivals have not happened until the replay plays them.
    Live.rewindToLastNight();
    if (!replay) {
      Scenes.OVERNIGHT.forEach(function (s) {
        if (s.kind === "arrive") Store.addTask(JSON.parse(JSON.stringify(s.task)));
        else if (s.from !== s.to) Store.moveByFact(s.id, s.to, s.apply);
      });
    }
  }

  if (scene === "failed") Store.failRun(Scenes.FAILED_RUN.id, Scenes.FAILED_RUN.failure);

  if (q.get("plans")) Store.state.planPlace = q.get("plans");
  if (q.get("lanes")) Store.state.laneStyle = q.get("lanes");
  if (q.get("group")) Store.state.groupBy = q.get("group");

  Board.mount();
  Drag.mount();
  Pane.mount();
  Keys.mount();
  Find.mount();
  Live.mount();
  Overview.mount();
  Tray.mount();
  Select.mount();
  Toolbar.mount();
  Adder.mount();
  Board.draw();

  document.getElementById("find-icon").innerHTML = Crew.icon("search", 16);
  document.getElementById("display-btn").innerHTML = Crew.icon("sliders", 16);

  var scroll = document.getElementById("scroll");
  scroll.addEventListener("scroll", function () {
    document.querySelector(".rule-wrap").classList.toggle("is-stuck", scroll.scrollTop > 72);
  }, { passive: true });

  work.addEventListener("click", function (e) {
    var addLane = e.target.closest("[data-add-lane]");
    if (addLane) {
      e.stopPropagation();
      return Adder.show(addLane.dataset.addLane);
    }
    var more = e.target.closest("[data-more]");
    if (more) return Fold.toggleCell(more.dataset.more);
    var bar = e.target.closest("[data-stack]");
    if (bar) return Fold.toggleStack(bar.dataset.stack, bar.getAttribute("aria-expanded") !== "true");
    var fold = e.target.closest("[data-fold-lane]");
    if (fold) return Fold.toggleLane(fold.dataset.foldLane);
    var plan = e.target.closest("[data-fold-plan]");
    if (plan) return Fold.togglePlan(plan.dataset.foldPlan);
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
  // It needs a real move: a card sliding under a still pointer must not take over from the keys.
  var pointerX = 0;
  var pointerY = 0;
  work.addEventListener("pointermove", function (e) {
    if (Math.hypot(e.clientX - pointerX, e.clientY - pointerY) < 4) return;
    pointerX = e.clientX;
    pointerY = e.clientY;
    Keys.setHover(e.target.closest(".card[data-id]"));
  });
  work.addEventListener("pointerleave", function () { Keys.setHover(null); });

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
      peek.innerHTML = "<b>" + Board.esc(t.name) + "</b><span>" + Board.esc(t.failed ? Store.describeFailure(t) : t.question ? t.question.text : t.now || "") + "</span>";
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
    var face = e.target.closest("[data-face]");
    if (face) return Shell.showFace(face.dataset.face);
    // The dot on the Hercule segment is its own small button, so the word still only changes the face.
    var door = e.target.closest("[data-failed-door]");
    if (door || (e.target.closest('[data-nav="overview"]') && Store.countStates().failed)) {
      e.preventDefault();
      Shell.showFace("hercule");
      return Filters.showFailed();
    }
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
    var card = e.target.closest('.card[data-state="blocked"][data-id]');
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
    var seg = e.target.closest("[data-place], [data-lanes]");
    if (seg) {
      Board.change(function () {
        if (seg.dataset.place) Store.state.planPlace = seg.dataset.place;
        if (seg.dataset.lanes) Store.state.laneStyle = seg.dataset.lanes;
      }, { spring: "travel", quietExits: true, noAnchor: true });
      return Toolbar.drawDisplay();
    }
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
