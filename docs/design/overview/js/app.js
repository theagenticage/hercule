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
    inboxCount: scene === "first" || scene === "empty" ? 0 : 6,
    waiting: scene === "first" || scene === "empty" ? [] : undefined,
    sum: scene === "first" ? "Nothing running yet" : undefined,
  });
  Store.loadWorld(Scenes.build(scene));
  work.dataset.scene = scene;
  if (scene === "offline") work.classList.add("is-offline");

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

  document.getElementById("find-icon").innerHTML = Crew.icon("search", 16);
  document.getElementById("display-btn").innerHTML = Crew.icon("sliders", 16);

  var scroll = document.getElementById("scroll");
  scroll.addEventListener("scroll", function () {
    document.querySelector(".rule-wrap").classList.toggle("is-stuck", scroll.scrollTop > 72);
  }, { passive: true });

  work.addEventListener("click", function (e) {
    var fold = e.target.closest("[data-fold-lane]");
    if (fold) return Fold.toggleLane(fold.dataset.foldLane);
    var plan = e.target.closest("[data-fold-plan]");
    if (plan) return Fold.togglePlan(plan.dataset.foldPlan);
    var pile = e.target.closest(".pile");
    if (pile) return Fan.show(pile);
    if (Fan.isOpen() && !e.target.closest(".card")) return Fan.hide();
    var lens = e.target.closest(".lens[data-lens]");
    if (lens) return Lens.toggle(lens.dataset.lens);
    var bead = e.target.closest(".bead[data-id]");
    if (bead) return Pane.show(bead.dataset.id);
    var card = e.target.closest(".card[data-id]");
    if (card) {
      if (MergePick.isActive()) return MergePick.finish(card.dataset.id);
      Keys.focusCard(card);
      Pane.show(card.dataset.id);
      return;
    }
    if (e.target.closest("[data-first-thread]")) return Welcome.startFirst();
    if (Pane.currentId() && !e.target.closest(".pn-sheet")) Pane.hide();
  });
  var lead = document.getElementById("lead");
  lead.addEventListener("pointerover", function (e) {
    var lens = e.target.closest(".lens[data-lens]");
    if (lens) Lens.preview(lens.dataset.lens);
  });
  lead.addEventListener("pointerleave", function () { Lens.preview(null); });

  var display = document.getElementById("display");
  document.getElementById("display-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    display.classList.toggle("is-on");
  });
  display.addEventListener("click", function (e) {
    e.stopPropagation();
    var act = e.target.closest("[data-display]");
    if (!act) return;
    if (act.dataset.display === "fold") Fold.toggleAll();
    if (act.dataset.display === "keys") Help.toggle();
    if (act.dataset.display !== "wear") display.classList.remove("is-on");
  });
  document.getElementById("wear-switch").addEventListener("change", Display.toggleWear);
  window.addEventListener("click", function () { display.classList.remove("is-on"); });

  if (q.get("wear")) {
    Store.state.wear = true;
    document.getElementById("wear-switch").checked = true;
    Board.draw();
  }

  if (scene === "loading") Welcome.playLoading();
  if (replay) setTimeout(Live.replayMorning, 900);
})();
