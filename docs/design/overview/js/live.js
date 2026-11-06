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
      if (!el) return tuckIn(t);
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

  /**
   * Shows an arrival landing on a stack: it rises on top for a moment, so it is seen, then slides in
   * underneath. Nothing moves, and only the count beside the age changes.
   */
  function tuckIn(t) {
    var top = Board.locate(t.id);
    if (!top) return;
    var r = top.getBoundingClientRect();
    var host = document.getElementById("carry");
    var copy = Board.drawCard(t).cloneNode(true);
    copy.classList.add("is-ghost", "is-new");
    copy.style.cssText = "position:absolute;margin:0;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px";
    host.appendChild(copy);
    var b = Motion.body(copy);
    if (Motion.isReduced()) {
      setTimeout(function () { copy.remove(); }, 1600);
      return;
    }
    b.set({ y: 10, s: 0.98, o: 0 }).to({ y: 0, s: 1, o: 1 }, "self");
    setTimeout(function () {
      b.to({ y: 8, s: 0.97, o: 0 }, "self", { done: function () { copy.remove(); } });
    }, 2600);
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
        var stacked = inCell && card.parentElement._behind && card.parentElement._behind.length;
        // On a stack there is no hole to hold: the next card is already there, under this one.
        if (!inCell || stacked) {
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
        if (s.kind === "arrive") {
          // This thread started in the night. It was already working: the replay only shows it landing.
          Shell.adoptArrival();
          arrive(JSON.parse(JSON.stringify(s.task)), { quiet: true });
        }
        else fact(s.id, s.to, s.note, s.apply);
      }, 300 + i * 1500);
    });
    setTimeout(summarizeNight, 300 + steps.length * 1500 + 1800);
  }

  /** Leaves one quiet line behind once the replay ends, with a way to see it again. */
  function summarizeNight() {
    var el = document.getElementById("since-line");
    if (!el) return;
    el.innerHTML = '<span class="since-item">Since last night: two landed, one new</span><button class="since-replay" title="Replay the night">' + Crew.icon("undo", 12) + "</button>";
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
      if (s.kind === "arrive") {
        Shell.adoptArrival();
        Store.addTask(JSON.parse(JSON.stringify(s.task)));
      } else if (s.from !== s.to) Store.moveByFact(s.id, s.to, s.apply);
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

  /** Returns an SVG path through these corners, each rounded by r. */
  function drawRoundedPath(points, r) {
    var d = "M" + points[0][0] + " " + points[0][1];
    for (var i = 1; i < points.length - 1; i++) {
      var p = points[i];
      var a = points[i - 1];
      var b = points[i + 1];
      var inLen = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
      var outLen = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
      var rin = Math.min(r, inLen / 2);
      var rout = Math.min(r, outLen / 2);
      var sx = p[0] + ((a[0] - p[0]) / inLen) * rin;
      var sy = p[1] + ((a[1] - p[1]) / inLen) * rin;
      var ex = p[0] + ((b[0] - p[0]) / outLen) * rout;
      var ey = p[1] + ((b[1] - p[1]) / outLen) * rout;
      d += "L" + sx + " " + sy + "Q" + p[0] + " " + p[1] + " " + ex + " " + ey;
    }
    var last = points[points.length - 1];
    return d + "L" + last[0] + " " + last[1];
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
    // The line keeps to the gaps between cards, so it never runs through anyone's words: down into
    // the row gap, along it, up the gutter beside the blocker, and in at its side.
    var goRight = b.left >= a.right - 1;
    var goLeft = b.right <= a.left + 1;
    var below = b.top > a.bottom;
    var ax = a.left + a.width / 2 - h.left;
    var ay = (below ? a.bottom : a.top) - h.top;
    var rowY = ay + (below ? 11 : -11);
    var gutterX = (goLeft ? b.right + 7 : b.left - 7) - h.left;
    var endX = (goLeft ? b.right : b.left) - h.left;
    var endY = b.top + b.height / 2 - h.top;
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "blocker-line");
    svg.innerHTML = '<path d="' + drawRoundedPath([[ax, ay], [ax, rowY], [gutterX, rowY], [gutterX, endY], [endX, endY]], 6) + '"/><circle cx="' + endX + '" cy="' + endY + '" r="2.5"/>';
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
