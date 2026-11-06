// PROTOTYPE - the board moving by itself. Facts arrive all day. The rule that keeps it calm: nothing
// moves under your hand. A change waits until the pointer has left the area, or at most eight
// seconds, and when it plays it says what caused it. A card that leaves keeps its place open for a
// moment, so what you were looking at does not jump.
window.Live = (function () {
  "use strict";

  var lastMove = 0;
  var lastX = -1e4;
  var lastY = -1e4;

  function cardEl(id) { return document.querySelector('#lanes .card[data-id="' + id + '"]'); }

  /** Checks whether the person is busy near this spot right now. */
  function isHandNear(rect) {
    if (Drag.isActive() || Fan.isOpen()) return true;
    if (performance.now() - lastMove > 1400) return false;
    if (!rect) return false;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    return Math.hypot(cx - lastX, cy - lastY) < 280;
  }

  /** Calls fn once the hand has left, or after eight seconds. */
  function whenStill(getRect, fn, since) {
    since = since || performance.now();
    if (performance.now() - since > 8000 || !isHandNear(getRect())) return fn();
    setTimeout(function () { whenStill(getRect, fn, since); }, 240);
  }

  /** A Task starting by itself: it rises out of the desk at the end of its cell, then its colleague looks up. */
  function arrive(t, opts) {
    opts = opts || {};
    whenStill(function () { return null; }, function () {
      Board.change(function () { Store.addTask(t); }, { spring: "drift" });
      var el = cardEl(t.id);
      if (!el) return;
      var b = Motion.body(el);
      if (Motion.isReduced()) {
        b.set({ o: 0 }).to({ o: 1 }, "back");
      } else {
        b.set({ y: 12, s: 0.97, o: 0 }).to({ y: 0, s: 1, o: 1 }, "drop");
        var head = el.querySelector(".card-head");
        if (head) Motion.body(head).set({ y: 18 }).to({ y: 0 }, "drop", { delay: 420 });
      }
      el.classList.add("is-new");
      if (!opts.quiet) note("New: " + t.name);
    });
  }

  /** A card moving by itself because a fact arrived, such as a pull request merging. */
  function fact(id, toStage, words, apply) {
    var el = cardEl(id);
    var t = Store.task(id);
    if (!t) return;
    function run() {
      var card = cardEl(id);
      if (!card) {
        // It sits in a pile or a folded lane: only the count and the bead change.
        Board.change(function () { Store.moveByFact(id, toStage, apply); }, { spring: "drift" });
        note(words);
        return;
      }
      // First the cause lands on the card, so the move has a reason you can see.
      card.classList.add("has-signal");
      var sig = document.createElement("span");
      sig.className = "card-signal";
      sig.textContent = words;
      card.appendChild(sig);
      Motion.body(sig).set({ y: 6, o: 0 }).to({ y: 0, o: 1 }, "drop");
      setTimeout(function () {
        var dent = document.createElement("div");
        dent.className = "slot dent";
        card.parentElement.insertBefore(dent, card);
        var cell = dent.parentElement;
        var index = Array.prototype.indexOf.call(cell.children, dent);
        Board.holdOpen(cell, index, dent);
        Motion.flip([card], function () {
          Store.moveByFact(id, toStage, apply);
          Board.draw();
        }, { spring: "drift" });
        card.classList.add("is-landing");
        setTimeout(function () {
          card.classList.remove("has-signal", "is-landing");
          sig.remove();
        }, 1400);
        // The dent closes last, and only when the hand is elsewhere.
        whenStill(function () { return dent.getBoundingClientRect(); }, function () {
          setTimeout(function () {
            Board.releaseHold(cell);
            Board.change(null, { spring: "drift" });
            dent.remove();
          }, 1500);
        });
        note(words);
      }, Motion.isReduced() ? 80 : 760);
    }
    whenStill(function () { return el ? el.getBoundingClientRect() : null; }, run);
  }

  function note(words) {
    var el = document.getElementById("since-line");
    if (!el) return;
    var line = document.createElement("span");
    line.className = "since-item";
    line.textContent = words;
    el.prepend(line);
    while (el.children.length > 1) el.lastElementChild.remove();
    Motion.body(line).set({ y: 5, o: 0 }).to({ y: 0, o: 1 }, "back");
  }

  /** Plays the night forward: everything that changed since the last look, one thing after another. */
  function replayMorning() {
    var steps = Scenes.OVERNIGHT.filter(function (s) { return s.kind === "arrive" || s.from !== s.to; });
    steps.forEach(function (s, i) {
      setTimeout(function () {
        if (s.kind === "arrive") arrive(JSON.parse(JSON.stringify(s.task)), { quiet: true });
        else fact(s.id, s.to, s.note, s.apply);
      }, 300 + i * 1500);
    });
  }

  /** Sets the board to how it looked last night, for the replay to start from. */
  function rewindToLastNight() {
    Scenes.OVERNIGHT.forEach(function (s) {
      if (s.kind !== "move") return;
      var t = Store.task(s.id);
      if (t) t.stage = s.from;
    });
  }

  function mount() {
    window.addEventListener("pointermove", function (e) {
      lastMove = performance.now();
      lastX = e.clientX;
      lastY = e.clientY;
    }, { passive: true });
  }

  return { mount: mount, arrive: arrive, fact: fact, replayMorning: replayMorning, rewindToLastNight: rewindToLastNight, note: note };
})();
