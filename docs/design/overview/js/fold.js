// PROTOTYPE - folding. Anything folded is a wire with one bead per Task, on the same stage axis as
// the cards. A card shrinks into its bead when its lane or plan folds, and grows out of it again
// when it opens, so nothing ever just vanishes. Reversing halfway picks up from what is on screen.
window.Fold = (function () {
  "use strict";

  // Copies fly in the fixed layer, so a scroll caused by the fold itself cannot carry them off.
  function flight() { return document.getElementById("carry"); }

  /** Returns the cards and piles under an element, each with the Task ids it stands for. */
  function collectItems(root) {
    var items = [];
    root.querySelectorAll(".cell > .card").forEach(function (el) {
      var ids = el.dataset.id ? [el.dataset.id] : [];
      if (el.dataset.pile) {
        var pile = (el.parentElement._piles || []).find(function (p) { return p.key === el.dataset.pile; });
        if (pile) ids = pile.tasks.map(function (t) { return t.id; });
      }
      items.push({ el: el, ids: ids });
    });
    return items;
  }

  function findBead(root, id) { return root.querySelector('.bead[data-id="' + id + '"]'); }

  /** Makes a flying copy of everything under each root. Stored on the root, for a reversal. */
  function launch(roots) {
    var all = [];
    roots.forEach(function (root) {
      root._flights = collectItems(root).map(function (it) {
        var layout = Motion.layoutRect(it.el);
        return { ids: it.ids, rect: layout, ghost: Motion.ghost(it.el, flight()) };
      });
      all.push({ root: root, flights: root._flights });
    });
    return all;
  }

  /** Sends each copy to its bead. Each bead appears as its copy arrives, never before. */
  function flyHome(group) {
    var seen = 0;
    group.flights.forEach(function (f, i) {
      var bead = findBead(group.root, f.ids[0]);
      if (!bead) {
        f.ghost.remove();
        return;
      }
      var r = bead.getBoundingClientRect();
      var dx = r.left + r.width / 2 - (f.rect.left + f.rect.width / 2);
      var dy = r.top + r.height / 2 - (f.rect.top + f.rect.height / 2);
      var delay = Math.min(i * 12, 100);
      if (Motion.isReduced()) {
        f.ghost.remove();
        return;
      }
      Motion.body(f.ghost).to({ x: dx, y: dy, s: 0.1 }, "travel", {
        delay: delay,
        done: function () { f.ghost.remove(); },
      });
      f.ghost.animate([{ opacity: 1 }, { opacity: 0 }], { delay: delay + 210, duration: 90, fill: "forwards" });
      f.ids.forEach(function (id) {
        var b = findBead(group.root, id);
        if (b) Motion.body(b).set({ s: 0.2, o: 0 }).to({ s: 1, o: 1 }, "hand", { delay: delay + 230 });
      });
    });
    group.root._flights = group.flights;
  }

  /** Grows each card out of where it was: its bead, or a copy still flying from a moment ago. */
  function growFrom(root, from) {
    collectItems(root).forEach(function (it, i) {
      var start = it.ids.map(function (id) { return from[id]; }).filter(Boolean)[0];
      if (!start) return;
      var r = Motion.layoutRect(it.el);
      var b = Motion.body(it.el);
      if (Motion.isReduced()) {
        b.set({ x: 0, y: 0, s: 1, o: 0 }).to({ o: 1 }, "travel");
        return;
      }
      b.set({ x: start.left + start.width / 2 - (r.left + r.width / 2), y: start.top + start.height / 2 - (r.top + r.height / 2), s: start.s, o: start.o });
      b.to({ x: 0, y: 0, s: 1, o: 1 }, "travel", { delay: start.live ? 0 : Math.min(i * 16, 130) });
    });
  }

  /** Records where each Task shows now. A copy in flight wins over the bead it was heading for. */
  function recordOrigins(root) {
    var from = {};
    root.querySelectorAll(".bead").forEach(function (b) {
      var r = b.getBoundingClientRect();
      from[b.dataset.id] = { left: r.left, top: r.top, width: r.width, height: r.height, s: 0.1, o: 0 };
    });
    (root._flights || []).forEach(function (f) {
      if (!f.ghost.isConnected) return;
      var r = f.ghost.getBoundingClientRect();
      var body = Motion.body(f.ghost);
      f.ids.forEach(function (id) {
        from[id] = { left: r.left, top: r.top, width: r.width, height: r.height, s: body.value.s, o: 1, live: true };
      });
      f.ghost.getAnimations().forEach(function (a) { a.cancel(); });
      body.clear();
      f.ghost.remove();
    });
    root._flights = [];
    return from;
  }

  /** Folds these roots with one change of the board. */
  function fold(roots, mutate) {
    if (Fan.isOpen()) Fan.hide(true);
    var groups = launch(roots);
    Board.change(mutate, { spring: "travel", quietExits: true, stagger: function () { return 70; } });
    // A wire is new on the page. It starts where its lane's name starts, and travels with it.
    roots.forEach(function (root) {
      var head = root.querySelector(".lane-head");
      var wire = root.querySelector(":scope > .wire");
      if (!head || !wire) return;
      var y = Motion.body(head).value.y;
      if (y) Motion.body(wire).set({ y: y }).to({ y: 0 }, "travel", { delay: 70 });
    });
    groups.forEach(flyHome);
  }

  /** Opens these roots with one change of the board. */
  function open(roots, mutate, after) {
    if (Fan.isOpen()) Fan.hide(true);
    var origins = roots.map(recordOrigins);
    Board.change(mutate, { spring: "travel", quietExits: true });
    roots.forEach(function (root, i) { growFrom(root, origins[i]); });
    if (after) after();
  }

  /** Folds or opens a project's lane. */
  function toggleLane(id) {
    var st = Store.state;
    var lane = Board.node("lane:" + id);
    if (!st.folded[id]) fold([lane], function () { st.folded[id] = true; });
    else open([lane], function () { st.folded[id] = false; });
  }

  /** Folds or opens a plan: the wire opens into a band of cards, or closes back into a wire. */
  function togglePlan(id) {
    var st = Store.state;
    var plan = Board.node("plan:" + id);
    if (st.openPlans[id]) {
      fold([plan], function () { delete st.openPlans[id]; });
    } else {
      open([plan], function () { st.openPlans[id] = true; }, function () {
        var band = plan.querySelector(".plan-band");
        if (band) Motion.body(band).set({ o: 0 }).to({ o: 1 }, "travel");
      });
    }
  }

  /** Folds every lane, or opens them all when all are folded. One change, however many lanes. */
  function toggleAll() {
    var st = Store.state;
    var all = st.projects.every(function (p) { return st.folded[p.id]; });
    var list = st.projects.filter(function (p) { return !!st.folded[p.id] === all; });
    var roots = list.map(function (p) { return Board.node("lane:" + p.id); });
    if (all) open(roots, function () { list.forEach(function (p) { st.folded[p.id] = false; }); });
    else fold(roots, function () { list.forEach(function (p) { st.folded[p.id] = true; }); });
  }

  return { toggleLane: toggleLane, togglePlan: togglePlan, toggleAll: toggleAll };
})();
