// PROTOTYPE - what a Task's verbs do on screen. Each one changes the Store and lets the board move.
window.Actions = (function () {
  "use strict";

  /** Sends a card off the desk: Done rises and fades toward Landed, Drop sinks and fades. */
  function animateLeaving(id, how) {
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (!el) return;
    var ghost = Motion.ghost(el, document.getElementById("carry"));
    ghost.classList.remove("is-away");
    ghost.classList.add(how === "Done" ? "is-done" : "is-dropped");
    var goal = how === "Done" ? { x: 26, y: -14, s: 1.02, r: 0, o: 0 } : { x: 0, y: 12, s: 0.97, r: -1.6, o: 0 };
    Motion.body(ghost).to(goal, how === "Done" ? "travel" : "travel", {
      delay: how === "Done" ? 240 : 0,
      done: function () { ghost.remove(); },
    });
  }

  /** Finds the card that should take focus when this one leaves: the next in its cell, or the last. */
  function pickNeighbour(id) {
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (!el) return null;
    return el.nextElementSibling || el.previousElementSibling;
  }

  function end(id, how, quiet) {
    var t = Store.task(id);
    if (!t) return;
    var next = pickNeighbour(id);
    var finish = function () {
      animateLeaving(id, how);
      Board.change(function () { Store.endTask(id, how); }, { spring: "hand" });
      Fan.dropCard(id);
      if (!quiet) Toast.show(how + (Store.state.offline ? ". It will sync when you are back." : ". " + t.name + " has left the board."), true);
      if (next && next.isConnected && next.classList.contains("card") && !Pane.currentId()) Keys.focusCard(next);
    };
    // In the middle of a walk the details stay open and move on: Done is an answer too.
    if (Pane.currentId() === id && Pane.isWalking()) {
      Walk.notePlace(id);
      finish();
      Walk.afterAnswer();
    } else if (Pane.currentId() === id) {
      Pane.hide(finish);
    } else {
      finish();
    }
  }

  /** Ends several Tasks as one gesture: one Undo brings them all back. */
  function endMany(ids, how) {
    Store.group(ids.length + " Tasks", function () {
      ids.forEach(function (id) { end(id, how, true); });
    });
    Toast.show(how + ". " + ids.length + " Tasks have left the board.", true);
  }

  /** Tells the person what a move really did, and takes it back if the move fails. */
  function reportMove(to) {
    var stage = NW.STAGES.filter(function (s) { return s.id === to.stage; })[0].name;
    var offline = document.getElementById("work").classList.contains("is-offline");
    Toast.show(offline ? "Moved to " + stage + ". It will sync when you are back." : "Moved to " + stage + ".", true);
    if (Store.failNext) {
      Store.failNext = false;
      setTimeout(function () {
        Board.change(function () { Store.undo(); }, { spring: "travel" });
        Pane.refresh();
        Toast.show("That move did not save, so the card went back. Check the connection and try again.", false);
      }, 900);
    }
  }

  function moveToStage(id, stage) {
    var t = Store.task(id);
    if (!t || t.stage === stage) return;
    Board.change(function () { Store.moveTask(id, { stage: stage }); }, { spring: "hand" });
    Pane.refresh();
    reportMove({ stage: stage });
  }

  function startThread(id, prompt) {
    Board.change(function () { Store.startThread(id, prompt); });
    handOff(id);
    Toast.show(Store.state.offline ? "This thread starts when you are back." : "A thread started on this Task.", true);
  }

  /** Answers a Task's question. The card lies down, and the walk moves on to the next thing. */
  function answer(id, words) {
    Walk.notePlace(id);
    Board.change(function () { Store.answerTask(id, words); });
    Toast.show((Store.state.offline ? "Sends when you are back: " : "Sent: ") + words, true);
    handOff(id);
    Walk.afterAnswer(id);
  }

  /**
   * Plays a hand-off as one chain: the colleague's head rises while the card still stands, its paws
   * reach the edge, and only then does the card give up its height.
   */
  function handOff(id) {
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (!card) return;
    var head = card.querySelector(".card-head");
    var paws = card.querySelector(".card-paws");
    if (!head || Motion.isReduced()) return;
    var settled = card.dataset.height;
    card.dataset.height = "stand";
    Motion.body(head).set({ y: 18 }).to({ y: 0 }, "travel");
    if (paws) Motion.body(paws).set({ o: 0 }).to({ o: 1 }, "travel", { delay: 90 });
    setTimeout(function () { card.dataset.height = settled; }, 130);
  }

  function run(act, id) {
    if (act === "done") return end(id, "Done");
    if (act === "drop") return end(id, "Dropped");
    if (act === "merge") return Pane.hide(function () { MergePick.start(id); });
    if (act === "thread") return Pane.askThread(id);
  }

  return { run: run, moveToStage: moveToStage, end: end, endMany: endMany, startThread: startThread, answer: answer, reportMove: reportMove };
})();

// PROTOTYPE - the morning's walk: from one thing that wants you to the next, with the details open.
// It goes through piles and folded lanes too, so nothing that wants you is out of reach. A lens narrows it.
window.Walk = (function () {
  "use strict";

  var list = [];
  var index = -1;

  /** Finds a Task's place on the board, and lights the pile or bead that holds it. */
  function point(id) {
    document.querySelectorAll(".is-called").forEach(function (c) { c.classList.remove("is-called"); });
    var el = Board.locate(id);
    if (!el) return;
    if (el.dataset.id !== id || el.classList.contains("bead")) el.classList.add("is-called");
    var s = document.getElementById("scroll");
    var r = el.getBoundingClientRect();
    var view = s.getBoundingClientRect();
    if (r.top < view.top + 110) s.scrollTop -= view.top + 110 - r.top;
    if (r.bottom > view.bottom - 30) s.scrollTop += r.bottom - view.bottom + 30;
  }

  /** Lists what wants you: cards on the desk first, then what sits in piles and folded lanes. */
  function readList() {
    var all = Store.listWanting();
    function isOnDesk(t) { return !!document.querySelector('#lanes .card[data-id="' + t.id + '"]'); }
    return all.filter(isOnDesk).concat(all.filter(function (t) { return !isOnDesk(t); }));
  }

  function go(i) {
    if (!list.length) return Toast.show("Nothing wants you right now.", false);
    index = (i + list.length) % list.length;
    var id = list[index].id;
    point(id);
    Pane.show(id);
    Pane.setWalk(index + 1, list.length);
  }

  /** Steps through what wants you, by = 1 or -1. Starts from the open card, or the first. */
  function step(by) {
    var open = Pane.currentId();
    list = readList();
    if (open) {
      var at = list.findIndex(function (t) { return t.id === open; });
      if (at >= 0) return go(at + by);
    }
    // Closed in the middle of a walk, the walk picks up where it stopped.
    go(index >= 0 ? index + by : by > 0 ? 0 : -1);
  }

  /** Reopens a Task in the walk: what Undo does after an answer. */
  function resume(id) {
    list = readList();
    var at = list.findIndex(function (t) { return t.id === id; });
    if (at >= 0) go(at);
  }

  /** Remembers where a Task stands in the walk, just before it leaves the list. */
  function notePlace(id) {
    index = Math.max(0, readList().findIndex(function (t) { return t.id === id; }));
  }

  function afterAnswer() {
    list = readList();
    if (!list.length) {
      Pane.hide();
      Toast.show("That was the last one.", true);
      return;
    }
    go(Math.min(index, list.length - 1));
  }

  return { step: step, resume: resume, notePlace: notePlace, afterAnswer: afterAnswer };
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
    Board.change(function () { into = Store.mergeTasks(from, intoId); }, { spring: "hand" });
    if (ghost && target) {
      var a = ghost.getBoundingClientRect();
      var b = target.getBoundingClientRect();
      Motion.body(ghost).to({ x: b.left - a.left, y: b.top - a.top, s: 0.92, o: 0 }, "hand", { done: function () { ghost.remove(); } });
      Motion.body(target).set({ s: 1.035 }).to({ s: 1 }, "hand");
      target.classList.add("has-merged");
      setTimeout(function () { target.classList.remove("has-merged"); }, 520);
    }
    Toast.show("Merged into " + into.name + ".", true);
    if (target) Keys.focusCard(target);
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
