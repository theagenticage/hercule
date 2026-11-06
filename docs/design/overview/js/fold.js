// PROTOTYPE - folding. Anything folded is a wire with one bead per Task, on the same stage axis as
// the cards. A card shrinks into its bead when its lane or plan folds, and grows out of it again
// when it opens, so nothing ever just vanishes. The same thing never teleports.
window.Fold = (function () {
  "use strict";

  function flight() { return document.getElementById("flight"); }

  /** Returns the cards and piles under an element, each with the Task ids it stands for. */
  function collectItems(root) {
    var items = [];
    root.querySelectorAll(".cell > .card").forEach(function (el) {
      var ids = el.dataset.id ? [el.dataset.id] : [];
      if (el.dataset.pile) {
        var cell = el.parentElement;
        var pile = (cell._piles || []).find(function (p) { return p.key === el.dataset.pile; });
        if (pile) ids = pile.tasks.map(function (t) { return t.id; });
      }
      items.push({ el: el, ids: ids });
    });
    return items;
  }

  function beadOf(root, id) { return root.querySelector('.bead[data-id="' + id + '"]'); }

  /** Sends a copy of each item to its bead in `root`, and pops each bead in as the copy lands. */
  function flyIntoBeads(items, root) {
    var host = flight();
    var hostRect = host.getBoundingClientRect();
    items.forEach(function (it, i) {
      var bead = beadOf(root, it.ids[0]);
      if (!bead) {
        it.ghost.remove();
        return;
      }
      var r = bead.getBoundingClientRect();
      var g = it.rect;
      var dx = r.left + r.width / 2 - (g.left + g.width / 2);
      var dy = r.top + r.height / 2 - (g.top + g.height / 2);
      Motion.body(it.ghost).to({ x: dx, y: dy, s: 0.08, o: 0 }, "fold", {
        delay: Math.min(i * 14, 110),
        done: function () { it.ghost.remove(); },
      });
    });
    root.querySelectorAll(".bead").forEach(function (b, i) {
      Motion.body(b).set({ s: 0.2, o: 0 }).to({ s: 1, o: 1 }, "drop", { delay: 90 + Math.min(i * 6, 120) });
    });
  }

  /** Grows each card of `root` out of the bead it was, from where that bead was on screen. */
  function growOutOfBeads(root, beadRects) {
    collectItems(root).forEach(function (it, i) {
      var from = it.ids.map(function (id) { return beadRects[id]; }).filter(Boolean)[0];
      if (!from) return;
      var r = Motion.layoutRect(it.el);
      var dx = from.left + from.width / 2 - (r.left + r.width / 2);
      var dy = from.top + from.height / 2 - (r.top + r.height / 2);
      var b = Motion.body(it.el);
      if (Motion.isReduced()) {
        b.set({ x: 0, y: 0, s: 1, o: 0 }).to({ o: 1 }, "back");
        return;
      }
      b.set({ x: dx, y: dy, s: 0.1, o: 0 }).to({ x: 0, y: 0, s: 1, o: 1 }, "fan", { delay: Math.min(i * 18, 150) });
    });
  }

  function recordBeads(root) {
    var rects = {};
    root.querySelectorAll(".bead").forEach(function (b) { rects[b.dataset.id] = b.getBoundingClientRect(); });
    return rects;
  }

  function makeGhosts(root) {
    var host = flight();
    return collectItems(root).map(function (it) {
      var rect = it.el.getBoundingClientRect();
      return { ids: it.ids, rect: rect, ghost: Motion.ghost(it.el, host) };
    });
  }

  /** Folds or opens a project's lane. */
  function toggleLane(id) {
    var st = Store.state;
    var lane = Board.node("lane:" + id);
    if (!st.folded[id]) {
      var items = makeGhosts(lane);
      Board.change(function () { st.folded[id] = true; }, { spring: "fold" });
      flyIntoBeads(items, lane);
    } else {
      var beads = recordBeads(lane);
      Board.change(function () { st.folded[id] = false; }, { spring: "fold" });
      growOutOfBeads(lane, beads);
    }
  }

  /** Folds or opens a plan: the wire opens into a band of cards, or closes back into a wire. */
  function togglePlan(id) {
    var st = Store.state;
    var plan = Board.node("plan:" + id);
    if (st.openPlans[id]) {
      var items = makeGhosts(plan);
      Board.change(function () { delete st.openPlans[id]; }, { spring: "fold" });
      flyIntoBeads(items, plan);
    } else {
      var beads = recordBeads(plan);
      Board.change(function () { st.openPlans[id] = true; }, { spring: "fold" });
      var band = plan.querySelector(".plan-band");
      if (band) {
        var b = Motion.body(band);
        b.set({ o: 0 }).to({ o: 1 }, "fold");
      }
      growOutOfBeads(plan, beads);
    }
  }

  /** Folds every lane, or opens them all when all are folded. */
  function toggleAll() {
    var st = Store.state;
    var all = st.projects.every(function (p) { return st.folded[p.id]; });
    st.projects.forEach(function (p, i) {
      if (!!st.folded[p.id] === !all) return;
      toggleLane(p.id);
    });
  }

  return { toggleLane: toggleLane, togglePlan: togglePlan, toggleAll: toggleAll };
})();
