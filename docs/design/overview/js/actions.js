// PROTOTYPE - what a Task's verbs do on screen. Each one changes the Store and lets the board move.
window.Actions = (function () {
  "use strict";

  /**
   * Sends a card off the desk. Done shrinks into its stage's count, and the count rolls down. Drop
   * sinks and fades.
   */
  function animateLeaving(id, how) {
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (!el) return;
    var ghost = Motion.ghost(el, document.getElementById("carry"));
    ghost.classList.remove("is-away");
    ghost.classList.add(how === "Done" ? "is-done" : "is-dropped");
    var t = Store.task(id);
    var number = how === "Done" && t ? document.querySelector('.stage[data-stage="' + t.stage + '"] .stage-count') : null;
    if (number) {
      var a = ghost.getBoundingClientRect();
      var n = number.getBoundingClientRect();
      Motion.body(ghost).to({ x: n.left + n.width / 2 - (a.left + a.width / 2), y: n.top + n.height / 2 - (a.top + a.height / 2), s: 0.08 }, "travel", {
        done: function () { ghost.remove(); },
      });
      ghost.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: 380, fill: "forwards" });
      return;
    }
    Motion.body(ghost).to({ x: 0, y: 12, s: 0.97, r: -1.6, o: 0 }, "travel", {
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
      Filters.settle();
      if (!quiet) Toast.show(how + (Store.state.offline ? ". It will sync when you are back." : ". " + t.name + " has left the board."), true);
      if (next && next.isConnected && next.classList.contains("card") && !Pane.currentId()) Keys.focusCard(next);
    };
    if (Pane.currentId() === id) Pane.hide(finish);
    else finish();
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

  /** Answers a Thread's question. The sheet closes, and the head goes back to work. */
  function answer(id, words) {
    Board.change(function () { Store.answerTask(id, words); });
    Toast.show((Store.state.offline ? "Sends when you are back: " : "Sent: ") + words, true);
    Pane.hide();
  }

  /**
   * Plays a hand-off as one chain: the colleague's head rises behind the card, and its paws reach
   * the edge.
   */
  function handOff(id) {
    var card = document.querySelector('.card[data-id="' + id + '"]');
    if (!card) return;
    var head = card.querySelector(".card-head");
    var paws = card.querySelector(".card-paws");
    if (!head || Motion.isReduced()) return;
    Motion.body(head).set({ y: 18 }).to({ y: 0 }, "travel");
    if (paws) Motion.body(paws).set({ o: 0 }).to({ o: 1 }, "travel", { delay: 90 });
  }

  /** Starts a failed run again. The sheet closes, and the colleague's head comes back up. */
  function retry(id) {
    Board.change(function () { Store.retryRun(id); });
    Toast.show(Store.state.offline ? "This run starts again when you are back." : "Trying again.", true);
    Pane.hide(function () { handOff(id); });
    Filters.settle();
  }

  function run(act, id) {
    if (act === "retry") return retry(id);
    if (act === "run") return Toast.show("Opens the run in Workflows, at the step that failed.", false);
    if (act === "done") return end(id, "Done");
    if (act === "drop") return end(id, "Dropped");
    if (act === "merge") return Pane.hide(function () { MergePick.start(id); });
    if (act === "thread") return Pane.askThread(id);
  }

  return { run: run, moveToStage: moveToStage, end: end, endMany: endMany, startThread: startThread, answer: answer, reportMove: reportMove };
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
