// PROTOTYPE - what a Task's verbs do on screen. Each one changes the Store and lets the board move.
window.Actions = (function () {
  "use strict";

  /** Sends a card off the desk: Done rises and fades toward Landed, Drop sinks and fades. */
  function animateLeaving(id, how) {
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (!el) return;
    var ghost = Motion.ghost(el, document.getElementById("flight"));
    ghost.classList.remove("is-away");
    ghost.classList.add(how === "Done" ? "is-done" : "is-dropped");
    var goal = how === "Done" ? { x: 26, y: -14, s: 1.02, r: 0, o: 0 } : { x: 0, y: 12, s: 0.97, r: -1.6, o: 0 };
    Motion.body(ghost).to(goal, how === "Done" ? "fold" : "back", {
      delay: how === "Done" ? 240 : 0,
      done: function () { ghost.remove(); },
    });
  }

  function end(id, how) {
    var t = Store.task(id);
    if (!t) return;
    var finish = function () {
      animateLeaving(id, how);
      Board.change(function () { Store.endTask(id, how); }, { spring: "glide" });
      Toast.show(how + ". " + t.name + " has left the board.", true);
    };
    if (Pane.currentId() === id) Pane.hide(finish);
    else finish();
  }

  function moveToStage(id, stage) {
    var t = Store.task(id);
    if (!t || t.stage === stage) return;
    Board.change(function () { Store.moveTask(id, { stage: stage }); }, { spring: "drop" });
    Toast.show("Moved to " + NW.STAGES.filter(function (s) { return s.id === stage; })[0].name + ".", true);
  }

  function startThread(id) {
    var t = Store.task(id);
    var title = "Thread on " + t.name;
    Board.change(function () {
      t.threads = t.threads.concat([{ title: title, id: "n" + Date.now() }]);
      t.agent = title;
      t.move = "agent";
      t.now = "A thread just started.";
    });
    var el = document.querySelector('.card[data-id="' + id + '"] .card-head');
    if (el) Motion.body(el).set({ y: 16 }).to({ y: 0 }, "drop", { delay: 60 });
    Toast.show("A thread started on this Task.", false);
  }

  function run(act, id) {
    if (act === "done") return end(id, "Done");
    if (act === "drop") return end(id, "Dropped");
    if (act === "merge") return Pane.hide(function () { MergePick.start(id); });
    if (act === "thread") {
      Pane.hide(function () { startThread(id); });
    }
  }

  return { run: run, moveToStage: moveToStage, end: end, startThread: startThread };
})();

// PROTOTYPE - merging without a pointer: pick the card to merge into with the arrows and Return.
window.MergePick = (function () {
  "use strict";
  var fromId = null;

  function start(id) {
    fromId = id;
    var w = document.getElementById("work");
    w.classList.add("is-merge-picking");
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (el) el.classList.add("is-merge-source");
    var bar = document.getElementById("toast");
    Toast.show("Pick the card to merge this into.", false);
    if (el) Keys.focusCard(el);
  }

  function finish(intoId) {
    if (!fromId) return;
    var from = fromId;
    cancel();
    if (!intoId || intoId === from) return;
    var el = document.querySelector('.card[data-id="' + from + '"]');
    var target = document.querySelector('.card[data-id="' + intoId + '"]');
    var into;
    var ghost = el ? Motion.ghost(el, document.getElementById("flight")) : null;
    Board.change(function () { into = Store.mergeTasks(from, intoId); }, { spring: "glide" });
    if (ghost && target) {
      var a = ghost.getBoundingClientRect();
      var b = target.getBoundingClientRect();
      Motion.body(ghost).to({ x: b.left - a.left, y: b.top - a.top, s: 0.92, o: 0 }, "drop", { done: function () { ghost.remove(); } });
      Motion.body(target).set({ s: 1.035 }).to({ s: 1 }, "bump");
      target.classList.add("has-merged");
      setTimeout(function () { target.classList.remove("has-merged"); }, 520);
    }
    Toast.show("Merged into " + into.name + ".", true);
  }

  function cancel() {
    var w = document.getElementById("work");
    w.classList.remove("is-merge-picking");
    document.querySelectorAll(".is-merge-source").forEach(function (c) { c.classList.remove("is-merge-source"); });
    fromId = null;
    Toast.hide();
  }

  return { start: start, finish: finish, cancel: cancel, isActive: function () { return !!fromId; } };
})();
