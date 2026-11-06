// PROTOTYPE - a pile fanning open. The cards leave the pile like a hand being spread and settle
// into a grid beside it, on a dimmed board. Only one pile is open at a time. Closing plays the same
// thing in reverse, from wherever each card is at that moment.
window.Fan = (function () {
  "use strict";

  var open = null;
  var closing = null;

  function layer() { return document.getElementById("fan-layer"); }

  /** Opens the pile drawn by this element. */
  function show(pileEl) {
    var cell = pileEl.parentElement;
    var pile = (cell._piles || []).find(function (p) { return p.key === pileEl.dataset.pile; });
    if (!pile) return;
    if (open && open.pile.key === pile.key) return hide();
    if (closing && closing.pile.key === pile.key) return reopen();
    if (open) hide(true);

    var host = layer();
    var main = document.getElementById("work").getBoundingClientRect();
    var from = pileEl.getBoundingClientRect();
    // A fan lays its cards on the stage columns, so it reads as part of the board's own grid.
    var stages = Array.prototype.map.call(document.querySelectorAll("#rule .stage"), function (s) { return s.getBoundingClientRect(); });
    var left = stages[0].left;
    var right = stages[3].right;
    var cols = Math.min(4, pile.tasks.length);
    var gapY = 22, head = 40;
    var rows = Math.ceil(pile.tasks.length / cols);
    var hFull = rows * 88 + (rows - 1) * gapY + head + 8;
    var h = Math.min(hFull, main.height - 96);
    var top = Math.max(main.top + 64, Math.min(from.top - 44, main.bottom - 24 - h));

    var fan = document.createElement("div");
    fan.className = "fan";
    fan.style.left = left - main.left + "px";
    fan.style.top = top - main.top + "px";
    fan.style.width = (stages[cols - 1].right - left) + "px";
    fan.style.height = h + "px";
    fan.style.setProperty("--fan-cols", cols);
    fan.innerHTML = '<header class="fan-head"><b>' + Board.esc(pile.title) + "</b><span>" + pile.tasks.length + "</span><small>" + Board.esc(Store.describePile(pile)) + '</small><span class="fan-keys"><kbd>Esc</kbd> fold</span></header><div class="fan-cards"></div>';
    var grid = fan.querySelector(".fan-cards");
    var wants = function (t) { return t.move === "you" && !Store.isBlocked(t) ? 0 : 1; };
    var ordered = pile.tasks.slice().sort(function (a, b) { return wants(a) - wants(b) || a.rank - b.rank; });
    var cards = ordered.map(function (t) {
      var el = Board.drawCard(t);
      grid.appendChild(el);
      return el;
    });
    host.appendChild(fan);
    host.classList.add("is-open");
    pileEl.classList.add("is-fanned");

    var cx = from.left + from.width / 2;
    var cy = from.top + from.height / 2;
    var half = (cards.length - 1) / 2;
    var far = 1;
    var reach = cards.map(function (el) {
      var r = Motion.layoutRect(el);
      var d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
      far = Math.max(far, d);
      return d;
    });
    cards.forEach(function (el, i) {
      var r = Motion.layoutRect(el);
      if (r.top > main.bottom + 40) return;
      var spread = half ? (i - half) / half : 0;
      var b = Motion.body(el);
      if (Motion.isReduced()) {
        b.set({ o: 0 }).to({ o: 1 }, "travel");
        return;
      }
      // The nearest card leaves first and the farthest last, 140ms apart at most. While flying a
      // card is a bare sheet; its words fade in over the end of the trip, so the pile is never soup.
      var delay = (reach[i] / far) * 140;
      el.classList.add("is-flying");
      b.set({ x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2), s: 0.94, r: spread * 5, o: i === 0 ? 1 : 0.9 });
      b.to({ x: 0, y: 0, s: 1, r: 0, o: 1 }, "travel", { delay: delay });
      setTimeout(function () { el.classList.remove("is-flying"); }, delay + 200);
    });
    Motion.body(fan.querySelector(".fan-head")).set({ o: 0, y: 6 }).to({ o: 1, y: 0 }, "travel", { delay: 90 });
    open = { pile: pile, fan: fan, pileEl: pileEl, cards: cards };
  }

  /** Sends a closing fan back out, from where each card is right now. */
  function reopen() {
    var o = closing;
    closing = null;
    open = o;
    layer().classList.add("is-open");
    o.pileEl.classList.add("is-fanned");
    o.cards.forEach(function (el) {
      if (el.classList.contains("is-carried")) return;
      el.classList.remove("is-flying");
      Motion.body(el).to({ x: 0, y: 0, s: 1, r: 0, o: 1 }, "travel");
    });
    Motion.body(o.fan.querySelector(".fan-head")).to({ o: 1 }, "travel");
  }

  /** Folds the open fan back into its pile. Pass true to drop it at once for another fan. */
  function hide(now) {
    if (!open) return;
    var o = open;
    open = null;
    layer().classList.remove("is-open");
    o.pileEl.classList.remove("is-fanned");
    var grid = o.fan.querySelector(".fan-cards");
    var inFan = o.cards.filter(function (c) { return c.parentElement === grid; });
    function cleanUp() {
      inFan.forEach(function (c) { Motion.body(c).clear(); });
      o.fan.remove();
      if (closing === o) closing = null;
    }
    if (now || Motion.isReduced()) return cleanUp();
    closing = o;
    var from = o.pileEl.getBoundingClientRect();
    var cx = from.left + from.width / 2;
    var cy = from.top + from.height / 2;
    Motion.body(o.fan.querySelector(".fan-head")).to({ o: 0 }, "travel");
    var left = inFan.length;
    var half = (inFan.length - 1) / 2;
    inFan.forEach(function (el, i) {
      var r = Motion.layoutRect(el);
      var spread = half ? (i - half) / half : 0;
      el.classList.add("is-flying");
      Motion.body(el).to({ x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2), s: 0.94, r: spread * 5, o: 0 }, "travel", {
        delay: Math.min((inFan.length - 1 - i) * 8, 70),
        done: function () {
          el.classList.remove("is-flying");
          left--;
          if (left <= 0 && closing === o) cleanUp();
        },
      });
    });
    if (!inFan.length) cleanUp();
  }

  /** Takes a card that ended out of the open fan, and closes the gap. */
  function dropCard(id) {
    if (!open) return;
    var i = open.cards.findIndex(function (c) { return c.dataset.id === id; });
    if (i < 0) return;
    var gone = open.cards[i];
    open.cards.splice(i, 1);
    open.pile.tasks = open.pile.tasks.filter(function (t) { return t.id !== id; });
    Motion.flip(open.cards, function () { gone.remove(); }, { spring: "hand" });
    var count = open.fan.querySelector(".fan-head span");
    if (count) count.textContent = open.cards.length;
    if (!open.cards.length) hide();
  }

  return {
    dropCard: dropCard,
    pileEl: function () { return open ? open.pileEl : null; },
    show: show,
    hide: hide,
    isOpen: function () { return !!open; },
    openCards: function () { return open ? open.cards : []; },
  };
})();
