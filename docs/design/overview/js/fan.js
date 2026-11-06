// PROTOTYPE - a pile fanning open. The cards leave the pile like a hand being spread and settle
// into a grid beside it, on a dimmed board. Only one pile is open at a time. Closing plays the same
// thing in reverse, from wherever each card is at that moment.
window.Fan = (function () {
  "use strict";

  var open = null;

  function layer() { return document.getElementById("fan-layer"); }

  /** Picks how many columns a fan of n cards gets, by the room the window has. */
  function pickColumns(n, room, cardWidth) {
    var fit = Math.max(1, Math.floor((room + 12) / (cardWidth + 12)));
    return Math.min(fit, n, Math.max(2, Math.ceil(Math.sqrt(n * 1.6))));
  }

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
    var cardWidth = Math.max(200, cell.getBoundingClientRect().width);
    var cols = pickColumns(pile.tasks.length, main.width - 80, cardWidth);
    var rows = Math.ceil(pile.tasks.length / cols);
    var gapX = 12, gapY = 16, head = 34;
    var w = cols * cardWidth + (cols - 1) * gapX;
    var hFull = rows * 96 + (rows - 1) * gapY + head + 8;
    var maxH = main.height - 96;
    var h = Math.min(hFull, maxH);
    // The fan opens around the pile, then moves only as far as it must to stay in the window.
    var left = Math.max(main.left + 24, Math.min(from.left + from.width / 2 - w / 2, main.right - 24 - w));
    var top = Math.max(main.top + 60, Math.min(from.top - 28, main.bottom - 24 - h));

    var fan = document.createElement("div");
    fan.className = "fan";
    fan.style.left = left - main.left + "px";
    fan.style.top = top - main.top + "px";
    fan.style.width = w + "px";
    fan.style.height = h + "px";
    fan.style.setProperty("--fan-cols", cols);
    fan.innerHTML = '<header class="fan-head"><b>' + Board.esc(pile.title) + "</b><span>" + pile.tasks.length + "</span><small>" + Board.esc(Store.describePile(pile)) + '</small><span class="fan-keys"><kbd>Esc</kbd> fold</span></header><div class="fan-cards"></div>';
    var grid = fan.querySelector(".fan-cards");
    var cards = pile.tasks.map(function (t) {
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
