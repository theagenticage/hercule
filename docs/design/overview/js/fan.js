// PROTOTYPE - a pile fanning open. The cards leave the pile like a hand being spread and settle
// into a grid beside it, on a dimmed board. Only one pile is open at a time. Closing plays the same
// thing in reverse, from wherever each card is at that moment.
window.Fan = (function () {
  "use strict";

  var open = null;

  function layer() { return document.getElementById("fan-layer"); }

  /** Opens the pile drawn by this element. */
  function show(pileEl) {
    var cell = pileEl.parentElement;
    var pile = (cell._piles || []).find(function (p) { return p.key === pileEl.dataset.pile; });
    if (!pile) return;
    if (open && open.pile.key === pile.key) return hide();
    if (open) hide(true);

    var host = layer();
    var main = document.getElementById("work").getBoundingClientRect();
    var from = pileEl.getBoundingClientRect();
    // A fan lays its cards on the stage columns, so it reads as part of the board's own grid.
    var stages = Array.prototype.map.call(document.querySelectorAll("#rule .stage"), function (s) { return s.getBoundingClientRect(); });
    var left = stages[0].left;
    var right = stages[3].right;
    var cols = Math.min(4, pile.tasks.length);
    var gapY = 16, head = 40;
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
    cards.forEach(function (el, i) {
      var r = Motion.layoutRect(el);
      if (r.top > main.bottom + 40) return;
      var spread = half ? (i - half) / half : 0;
      var b = Motion.body(el);
      if (Motion.isReduced()) {
        b.set({ o: 0 }).to({ o: 1 }, "back");
        return;
      }
      b.set({ x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2), s: 0.94, r: spread * 7, o: 0 });
      b.to({ x: 0, y: 0, s: 1, r: 0, o: 1 }, "fan", { delay: Math.min(i * 22, 220) });
    });
    Motion.body(fan.querySelector(".fan-head")).set({ o: 0, y: 6 }).to({ o: 1, y: 0 }, "back", { delay: 90 });
    open = { pile: pile, fan: fan, pileEl: pileEl, cards: cards };
  }

  /** Folds the open fan back into its pile. Pass true to drop it at once for another fan. */
  function hide(now) {
    if (!open) return;
    var o = open;
    open = null;
    var host = layer();
    host.classList.remove("is-open");
    o.pileEl.classList.remove("is-fanned");
    var from = o.pileEl.getBoundingClientRect();
    var cx = from.left + from.width / 2;
    var cy = from.top + from.height / 2;
    var n = o.cards.length;
    var finished = 0;
    function finish() {
      finished++;
      if (finished >= n) {
        o.cards.forEach(function (c) { Motion.body(c).clear(); });
        o.fan.remove();
      }
    }
    if (now || Motion.isReduced()) {
      o.cards.forEach(function (c) { Motion.body(c).clear(); });
      o.fan.remove();
      return;
    }
    Motion.body(o.fan.querySelector(".fan-head")).to({ o: 0 }, "back");
    var half = (n - 1) / 2;
    o.cards.forEach(function (el, i) {
      if (el.parentElement !== o.fan.querySelector(".fan-cards")) return finish();
      var r = Motion.layoutRect(el);
      var spread = half ? (i - half) / half : 0;
      Motion.body(el).to({ x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2), s: 0.94, r: spread * 7, o: 0 }, "fold", {
        delay: Math.min((n - 1 - i) * 10, 90),
        done: finish,
      });
    });
  }

  return {
    show: show,
    hide: hide,
    isOpen: function () { return !!open; },
    openCards: function () { return open ? open.cards : []; },
  };
})();
