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
    if (!rect) return false;
    // A pointer parked on a card means someone is reading it, however long it has been still.
    var nearX = Math.max(rect.left - lastX, 0, lastX - rect.right);
    var nearY = Math.max(rect.top - lastY, 0, lastY - rect.bottom);
    if (Math.hypot(nearX, nearY) < 120) return true;
    // A pointer on the move near it means someone is about to.
    return performance.now() - lastMove < 900 && Math.hypot(nearX, nearY) < 280;
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
      Board.change(function () { Store.addTask(t); }, { spring: "self" });
      var el = cardEl(t.id);
      if (!el) return;
      var b = Motion.body(el);
      if (Motion.isReduced()) {
        b.set({ o: 0 }).to({ o: 1 }, "travel");
      } else {
        b.set({ y: 12, s: 0.97, o: 0 }).to({ y: 0, s: 1, o: 1 }, "self");
        var head = el.querySelector(".card-head");
        var paws = el.querySelector(".card-paws");
        if (head) Motion.body(head).set({ y: 18 }).to({ y: 0 }, "travel", { delay: 620 });
        if (paws) Motion.body(paws).set({ o: 0 }).to({ o: 1 }, "travel", { delay: 760 });
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
        Board.change(function () { Store.moveByFact(id, toStage, apply); }, { spring: "self" });
        note(words);
        return;
      }
      // First the cause lands on the card, so the move has a reason you can see.
      card.classList.add("has-signal");
      var sig = document.createElement("span");
      sig.className = "card-signal";
      sig.textContent = words;
      card.appendChild(sig);
      Motion.body(sig).set({ y: 6, o: 0 }).to({ y: 0, o: 1 }, "hand");
      function move() {
        // The hand may have arrived during the hold. A card in the hand is not moved by anything.
        if (Drag.isActive()) return setTimeout(move, 300);
        var inCell = card.parentElement && card.parentElement.classList.contains("cell");
        if (!inCell) {
          sig.remove();
          card.classList.remove("has-signal");
          Board.change(function () { Store.moveByFact(id, toStage, apply); }, { spring: "self" });
          Pane.refresh();
          note(words);
          return;
        }
        var dent = document.createElement("div");
        dent.className = "slot dent";
        card.parentElement.insertBefore(dent, card);
        var cell = dent.parentElement;
        var lane = cell.closest(".lane");
        Board.holdOpen(cell, Array.prototype.indexOf.call(cell.children, dent), dent);
        Board.change(function () { Store.moveByFact(id, toStage, apply); }, { spring: "self" });
        Pane.refresh();
        // Cards moved by a fact fly on the slow spring, and stay above what they pass.
        card.classList.add("is-landing");
        setTimeout(function () {
          card.classList.remove("has-signal", "is-landing");
          sig.remove();
        }, 1400);
        // The dent closes last, and only when the hand is out of this lane.
        whenStill(function () { return lane.getBoundingClientRect(); }, function () {
          setTimeout(function () {
            Board.releaseHold(cell);
            Board.change(null, { spring: "self" });
            dent.remove();
          }, 1500);
        });
        note(words);
      }
      setTimeout(move, Motion.isReduced() ? 80 : 760);
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
    Motion.body(line).set({ y: 5, o: 0 }).to({ y: 0, o: 1 }, "travel");
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
    setTimeout(summarizeNight, 300 + steps.length * 1500 + 1800);
  }

  /** Leaves one quiet line behind once the replay ends, with a way to see it again. */
  function summarizeNight() {
    var el = document.getElementById("since-line");
    if (!el) return;
    el.innerHTML = '<span class="since-item">Since last night: one landed, one picked up, one new</span><button class="since-replay" title="Replay the night">' + Crew.icon("undo", 12) + "</button>";
    Motion.body(el.firstChild).set({ o: 0 }).to({ o: 1 }, "travel");
    el.querySelector(".since-replay").addEventListener("click", function () {
      var q = new URLSearchParams(location.search);
      q.delete("replay");
      location.search = q.toString();
    });
  }

  /** Shows the morning at once, for a person who asked for no movement. The line still tells it. */
  function skipToMorning() {
    Scenes.OVERNIGHT.forEach(function (s) {
      if (s.kind === "arrive") Store.addTask(JSON.parse(JSON.stringify(s.task)));
      else if (s.from !== s.to) Store.moveByFact(s.id, s.to, s.apply);
    });
    Board.draw();
    summarizeNight();
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

  return { mount: mount, arrive: arrive, fact: fact, replayMorning: replayMorning, skipToMorning: skipToMorning, rewindToLastNight: rewindToLastNight, note: note };
})();

// PROTOTYPE - the line from a blocked card to what holds it, drawn on while the pointer rests there.
window.Blocker = (function () {
  "use strict";
  var svg = null;
  var lit = null;

  function hide() {
    if (svg) svg.remove();
    svg = null;
    if (lit) lit.classList.remove("is-blocker");
    lit = null;
  }

  function show(card) {
    hide();
    var t = Store.task(card.dataset.id);
    if (!t || !t.blockedBy.length) return;
    var target = Board.locate(t.blockedBy[0]);
    if (!target) return;
    var host = document.getElementById("flight");
    var h = host.getBoundingClientRect();
    var a = card.getBoundingClientRect();
    var b = target.getBoundingClientRect();
    var ax = a.left + a.width / 2 - h.left;
    var ay = a.top - h.top;
    var bx = b.left + b.width / 2 - h.left;
    var by = (b.bottom < a.top ? b.bottom : b.top) - h.top;
    if (Math.abs(a.left - b.left) > 40) {
      ax = (b.left > a.left ? a.right : a.left) - h.left;
      ay = a.top + a.height / 2 - h.top;
      bx = (b.left > a.left ? b.left : b.right) - h.left;
      by = b.top + b.height / 2 - h.top;
    }
    var mid = (ax + bx) / 2;
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "blocker-line");
    svg.innerHTML = '<path d="M' + ax + " " + ay + "C" + mid + " " + ay + " " + mid + " " + by + " " + bx + " " + by + '"/><circle cx="' + bx + '" cy="' + by + '" r="2.5"/>';
    host.appendChild(svg);
    var path = svg.querySelector("path");
    var len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    path.getBoundingClientRect();
    path.style.strokeDashoffset = 0;
    lit = target;
    lit.classList.add("is-blocker");
  }

  return { show: show, hide: hide };
})();
